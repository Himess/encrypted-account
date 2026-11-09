/**
 * F0.9 steps 1–2 — deploys the Round 1 build (baseline, results/sepolia/baseline/build.json) to Sepolia, funds the
 * watchtower wallet and sets up three measurement accounts:
 *   e1   — E1 PIN flow (each sample to a new address, PIN path)
 *   hot  — K-only hot path (to a known recipient, below L_min)
 *   live — live checks (AA, empty proof, escape, admin path)
 * Uses short test delays (pinTransfer = 0) and limits at which 30 K-only samples cannot trigger the tripwire (L_min = 0.1 ETH,
 * 1e-6 ETH per sample); production delays are read from the factory and recorded separately.
 *
 *   npx hardhat run scripts/sepolia/f09-prepare.ts
 *
 * Resumable: deployed contracts and completed setup steps are not sent again.
 * Output: results/sepolia/state-baseline.json (addresses + transactions), results/sepolia/setup.json (setup gas breakdown).
 */
import { createHash } from "crypto";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { contractAt, deployFromBuild } from "../lib/deploy";
import { ROOT } from "../lib/env";
import { makeLiveCtx, writeJson } from "../lib/live";
import { ENTRYPOINT_V08, InsufficientFunds, eth, gwei, sendTx } from "../lib/net";
import { LIVE_DELAYS, TEST_DELAYS, hcuOf, iso, loadF09, requireBalance, saveF09, send, setupAccount } from "./f09-lib";

const WATCHTOWER_TARGET = ethers.parseEther("0.012");
const WATCHTOWER_MIN = ethers.parseEther("0.006");
const ACCOUNT_FUND = ethers.parseEther("0.0002");

async function main() {
  const ctx = await makeLiveCtx();
  const { provider, user, watchtower, build } = ctx;
  if (!watchtower) throw new Error("no watchtower key (npx hardhat run scripts/burner.ts)");
  const st = loadF09();
  const log = (s: string) => console.log(s);
  const fee = await provider.getFeeData();
  log(`user       ${user.address} · balance ${eth(await provider.getBalance(user.address))} ETH`);
  log(`watchtower ${watchtower.address} · balance ${eth(await provider.getBalance(watchtower.address))} ETH`);
  log(`RPC ${provider.currentUrl} · gas price ≈ ${gwei(fee.gasPrice!).toFixed(4)} gwei · SDK client ${ctx.clientReadyMs} ms`);
  await requireBalance(provider, user, 60_000_000n, "F0.9 preparation (deployment + setup of 3 accounts)");

  // ── 1) deployment (Round 1 build)
  st.contracts ??= {};
  st.deploys ??= {};
  st.runtimeBytes ??= {};
  const has = async (name: string) => Boolean(st.contracts![name]) && (await provider.getCode(st.contracts![name])).length > 2;
  const deploy = async (name: string, args: () => unknown[], libs: () => Record<string, string>) => {
    if (await has(name)) return;
    const d = await deployFromBuild(user, build, name, args(), libs());
    st.contracts![name] = d.address;
    st.deploys![name] = d.tx;
    st.runtimeBytes![name] = d.runtimeBytes;
    saveF09(st);
    log(`  ${name} @ ${d.address} · ${d.runtimeBytes} B · gas ${d.tx.gasUsed} · ${d.tx.inclusionMs} ms · ${d.tx.hash}`);
  };
  const c = () => st.contracts!;
  log("deployment:");
  await deploy("PinLib", () => [], () => ({}));
  await deploy("PolicyLib", () => [], () => ({}));
  await deploy("OpenLib", () => [], () => ({}));
  await deploy("OpsLib", () => [], () => ({ PolicyLib: c().PolicyLib }));
  await deploy("EncryptedAccount", () => [ENTRYPOINT_V08], () => ({ PinLib: c().PinLib, PolicyLib: c().PolicyLib, OpsLib: c().OpsLib, OpenLib: c().OpenLib }));
  await deploy("EncryptedAccountFactory", () => [c().EncryptedAccount], () => ({}));
  await deploy("TestPaymaster", () => [ENTRYPOINT_V08], () => ({}));
  await deploy("Bench", () => [], () => ({}));

  // Naive verifier for the live confirmation of I1 (Round 1's exploit contract; it was not in the baseline copy). The source
  // is checked against the hash taken at baseline time; the build output is read from artifacts/.
  if (!(await has("NaivePinVerifier"))) {
    const src = path.join(ROOT, "contracts", "test", "NaivePinVerifier.sol");
    const hash = createHash("sha256").update(fs.readFileSync(src)).digest("hex");
    const baseHash = JSON.parse(fs.readFileSync(path.join(ROOT, "results", "sepolia", "baseline", "build.json"), "utf8")).sources[
      "contracts/test/NaivePinVerifier.sol"
    ];
    if (hash !== baseHash) throw new Error("NaivePinVerifier.sol has changed since the baseline; not deployed");
    const art = JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts", "contracts", "test", "NaivePinVerifier.sol", "NaivePinVerifier.json"), "utf8"));
    const f = new ethers.ContractFactory(art.abi, art.bytecode, user);
    const dtx = await f.getDeployTransaction();
    const rec = await sendTx(user, "deploy NaivePinVerifier", async () => dtx, { timeoutMs: 180_000 });
    const { receipt, ...tx } = rec;
    st.contracts.NaivePinVerifier = receipt.contractAddress!;
    st.deploys.NaivePinVerifier = { ...tx, sourceSha256: hash };
    st.runtimeBytes.NaivePinVerifier = (art.deployedBytecode.length - 2) / 2;
    saveF09(st);
    log(`  NaivePinVerifier @ ${receipt.contractAddress} · gas ${tx.gasUsed} · ${tx.hash}`);
  }

  // Did the implementation contract see the correct Zama configuration?
  const impl = contractAt(build, "EncryptedAccount", c().EncryptedAccount, provider);
  const [aclAddr, execAddr, ep] = await Promise.all([impl.aclAddress(), impl.executorAddress(), impl.entryPoint()]);
  st.implConfig = { aclAddress: aclAddr, executorAddress: execAddr, entryPoint: ep };

  // ── 2) watchtower funding (it sends the finalize, executeOp and AA bundler transactions)
  const wtBal = await provider.getBalance(watchtower.address);
  if (wtBal < WATCHTOWER_MIN) {
    const amt = WATCHTOWER_TARGET - wtBal;
    const r = await send(user, `fund watchtower ${eth(amt)} ETH`, async () => ({ to: watchtower.address, value: amt }));
    st.funding = { ...(st.funding ?? {}), watchtower: { ...r.tx, valueEth: eth(amt) } };
    saveF09(st);
    log(`watchtower funded: ${eth(amt)} ETH · ${r.tx.hash}`);
  }

  // ── 3) measurement accounts
  st.knownHot ??= ethers.Wallet.createRandom().address; // known recipient (its key is not kept; 1e-6 ETH per sample)
  st.escapeTest ??= ethers.Wallet.createRandom().address; // e1/hot escape address (escape is not executed on these accounts)
  saveF09(st);
  log("account setup:");
  await setupAccount(ctx, st, "e1", { delays: TEST_DELAYS, escape: st.escapeTest, guardian: watchtower.address, known: [st.knownHot], fundWei: ACCOUNT_FUND }, log);
  await setupAccount(ctx, st, "hot", { delays: TEST_DELAYS, escape: st.escapeTest, guardian: watchtower.address, known: [st.knownHot], fundWei: ACCOUNT_FUND }, log);
  // live: the escape address is the watchtower wallet (the escape sweep brings the funds back to us)
  await setupAccount(ctx, st, "live", { delays: LIVE_DELAYS, escape: watchtower.address, guardian: watchtower.address, known: [st.knownHot], fundWei: ACCOUNT_FUND }, log);

  // ── setup gas breakdown
  const factory = contractAt(build, "EncryptedAccountFactory", c().EncryptedAccountFactory, provider);
  const prod = (await factory.defaultDelays()).toObject();
  const accounts: any = {};
  for (const [k, a] of Object.entries(st.accounts ?? {})) {
    const rows = Object.entries(a.setup).map(([label, t]) => ({
      step: label,
      gas: Number(t.gasUsed),
      hcu: t.hcu?.total ?? null,
      hcuDepth: t.hcu?.depth ?? null,
      blockMeter: t.hcu?.blockMeter ?? null,
      meterCheck: t.hcu?.meterCheck ?? null,
      encryptMs: t.encrypt?.totalMs ?? null,
      inclusionMs: t.inclusionMs,
      blocksToInclusion: t.blocksToInclusion,
      tx: t.hash,
      block: t.blockNumber,
    }));
    const fheRows = rows.filter((r) => !r.step.startsWith("fund"));
    accounts[k] = {
      address: a.address,
      delays: a.delays,
      argonSetupMs: a.argonSetupMs ?? null,
      rows,
      totalGas: fheRows.reduce((s, r) => s + r.gas, 0),
      totalHcu: fheRows.reduce((s, r) => s + (r.hcu ?? 0), 0),
      txCount: fheRows.length,
    };
  }
  writeJson("setup.json", {
    evidence: "[M] Sepolia",
    generatedAtUtc: iso(),
    note: "Setup: createAccount + setupPin + setupAsset(ETH) + setupKnown (recipients 12/12/6, spenders 10) + setupRoles + arm (excluding funding). The Round 1 mock setup also had a second asset (USDC).",
    productionDelays: prod,
    testDelays: { e1: TEST_DELAYS, hot: TEST_DELAYS, live: LIVE_DELAYS },
    limits: { unitWei: "1e12", lmin: "100000", lmax: "300000", big: "3000000" },
    contracts: st.contracts,
    runtimeBytes: st.runtimeBytes,
    deploys: st.deploys,
    accounts,
  });
  for (const [k, v] of Object.entries<any>(accounts)) log(`${k}: ${v.address} · setup ${v.txCount} transactions, ${v.totalGas} gas, ${v.totalHcu} HCU`);
  log(`\nPREPARATION DONE → results/sepolia/setup.json · user balance ${eth(await provider.getBalance(user.address))} ETH`);
  provider.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    if (e instanceof InsufficientFunds) {
      console.error(e.message);
      process.exit(3);
    }
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
