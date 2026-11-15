/**
 * F0.16 preparation — PREPARED, NOT RUN (ask before deploying to Sepolia). Deploys the F0.16 build
 * (results/sepolia/f016/build.json: the K-track bond, the adjustable base bond and the protocol fee) and sets up the same
 * two measurement accounts as F0.10 / F0.15 with the same method, test delays, limits and amount, so that f09-run.ts
 * measures the builds the same way:
 *   e1  — PIN flow (each sample to a new address; each guess now carries the bond, refunded at the end with claimRefund)
 *   hot — K-only hot path (to a known recipient, below L_min; the fee is quoted at opening and never charged)
 * The shared FeeConfig is deployed first with the testnet default table (ETH: 10 bps, min 0.00001 ETH, max 0.001 ETH;
 * the 1% cap bounds the final fee, so the e1 samples of 1e12 wei pay 1e10 wei). Its admin is the burner wallet; the fee
 * recipient is a parameter (F016_FEE_RECIPIENT, default: the burner wallet itself).
 *
 *   SEP_RUN=f016 npx hardhat run scripts/sepolia/snapshot-f015.ts
 *   SEP_RUN=f016 F016_FEE_RECIPIENT=0x… npx hardhat run scripts/sepolia/f016-prepare.ts
 *   SEP_RUN=f016 F09_N=5 npx hardhat run scripts/sepolia/f09-run.ts
 *
 * Resumable (state-f016.json). Output: results/sepolia/setup-f016.json. The key is read only from .env.sepolia (never
 * printed): addresses, hashes and gas only.
 */
import { ethers } from "ethers";
import { contractAt, deployFromBuild } from "../lib/deploy";
import { SEP_RUN, makeLiveCtx, writeJson } from "../lib/live";
import { ENTRYPOINT_V08, InsufficientFunds, eth, gwei } from "../lib/net";
import { TEST_DELAYS, iso, loadF09, requireBalance, saveF09, send, setupAccount } from "./f09-lib";

const WATCHTOWER_MIN = ethers.parseEther("0.004");
const WATCHTOWER_TARGET = ethers.parseEther("0.008");
const ACCOUNT_FUND = ethers.parseEther("0.0002");
const FEE_TABLE = { assets: [ethers.ZeroAddress], bps: [10], minFees: [ethers.parseEther("0.00001")], maxFees: [ethers.parseEther("0.001")] };

async function main() {
  if (SEP_RUN !== "f016") throw new Error("run with SEP_RUN=f016 (so the state of earlier runs is not touched)");
  const ctx = await makeLiveCtx();
  const { provider, user, watchtower, build } = ctx;
  if (!watchtower) throw new Error("no watchtower key");
  if (!build.contracts.FeeConfig || !build.contracts.EncryptedAccount?.abi.some((f: any) => f.name === "ownerBond")) {
    throw new Error("build snapshot missing/stale: run SEP_RUN=f016 scripts/sepolia/snapshot-f015.ts first");
  }
  const recipient = process.env.F016_FEE_RECIPIENT ?? user.address;
  if (!ethers.isAddress(recipient) || recipient === ethers.ZeroAddress) throw new Error("F016_FEE_RECIPIENT must be a non-zero address");
  const st = loadF09();
  const log = (s: string) => console.log(s);
  const fee = await provider.getFeeData();
  log(`user ${user.address} · ${eth(await provider.getBalance(user.address))} ETH · watchtower ${watchtower.address} · ${eth(await provider.getBalance(watchtower.address))} ETH`);
  log(`RPC ${provider.currentUrl} · gas price ≈ ${gwei(fee.gasPrice!).toFixed(4)} gwei · SDK client ${ctx.clientReadyMs} ms · fee recipient ${recipient}`);
  await requireBalance(provider, user, 160_000_000n, "f016 preparation (FeeConfig + deployment + setup of 2 accounts)");

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
  log("deployment (f016 build):");
  await deploy("FeeConfig", () => [user.address, recipient, FEE_TABLE.assets, FEE_TABLE.bps, FEE_TABLE.minFees, FEE_TABLE.maxFees], () => ({}));
  await deploy("PinLib", () => [], () => ({}));
  await deploy("PolicyLib", () => [], () => ({}));
  await deploy("OpenLib", () => [], () => ({}));
  await deploy("OpsLib", () => [], () => ({ PolicyLib: c().PolicyLib }));
  await deploy("EncryptedAccount", () => [ENTRYPOINT_V08, c().FeeConfig], () => ({ PinLib: c().PinLib, PolicyLib: c().PolicyLib, OpsLib: c().OpsLib, OpenLib: c().OpenLib }));
  await deploy("EncryptedAccountFactory", () => [c().EncryptedAccount], () => ({}));
  const impl = contractAt(build, "EncryptedAccount", c().EncryptedAccount, provider);
  const fc = contractAt(build, "FeeConfig", c().FeeConfig, provider);
  const [aclAddr, execAddr, ep, feeConfig, feeRecipient, ethFee] = await Promise.all([
    impl.aclAddress(),
    impl.executorAddress(),
    impl.entryPoint(),
    impl.feeConfig(),
    fc.feeRecipient(),
    fc.feeOf(ethers.ZeroAddress),
  ]);
  if (String(feeConfig).toLowerCase() !== c().FeeConfig.toLowerCase()) throw new Error("implementation points at another FeeConfig");
  st.implConfig = { aclAddress: aclAddr, executorAddress: execAddr, entryPoint: ep, feeConfig, feeRecipient, ethFee: { bps: Number(ethFee[0]), minFee: ethFee[1].toString(), maxFee: ethFee[2].toString() } };
  saveF09(st);

  const wtBal = await provider.getBalance(watchtower.address);
  if (wtBal < WATCHTOWER_MIN) {
    const amt = WATCHTOWER_TARGET - wtBal;
    const r = await send(user, `fund watchtower ${eth(amt)} ETH`, async () => ({ to: watchtower.address, value: amt }));
    st.funding = { ...(st.funding ?? {}), watchtower: { ...r.tx, valueEth: eth(amt) } };
    saveF09(st);
    log(`watchtower funded: ${eth(amt)} ETH · ${r.tx.hash}`);
  }

  st.knownHot ??= ethers.Wallet.createRandom().address; // known recipient (its key is not kept)
  saveF09(st);
  const escapeFor = async (key: string) => {
    const w = new ethers.Wallet(ethers.Wallet.createRandom().privateKey); // key stays in memory
    const prev = st.accounts?.[key];
    if (prev && (await provider.getCode(prev.address)).length <= 2) {
      delete st.accounts![key];
      saveF09(st);
    }
    return w;
  };
  log("account setup (guardian = watchtower, E_addr = temporary wallet, with EIP-712 consent; default base bond):");
  for (const key of ["e1", "hot"]) {
    const w = await escapeFor(key);
    const escape = st.accounts?.[key]?.escape ?? w.address;
    await setupAccount(ctx, st, key, { delays: TEST_DELAYS, escape, guardian: watchtower.address, known: [st.knownHot], fundWei: ACCOUNT_FUND, escapeSigner: w }, log);
  }

  const accounts: any = {};
  for (const [k, a] of Object.entries(st.accounts ?? {})) {
    const rows = Object.entries(a.setup).map(([label, t]) => ({ step: label, gas: Number(t.gasUsed), hcu: t.hcu?.total ?? null, meterCheck: t.hcu?.meterCheck ?? null, tx: t.hash, block: t.blockNumber }));
    const fheRows = rows.filter((r) => !r.step.startsWith("fund"));
    accounts[k] = {
      address: a.address,
      escape: a.escape,
      guardian: a.guardian,
      rows,
      totalGas: fheRows.reduce((s, r) => s + r.gas, 0),
      totalHcu: fheRows.reduce((s, r) => s + (r.hcu ?? 0), 0),
    };
  }
  writeJson(`setup-${SEP_RUN}.json`, {
    evidence: "[M] Sepolia",
    generatedAtUtc: iso(),
    run: SEP_RUN,
    contracts: st.contracts,
    runtimeBytes: st.runtimeBytes,
    deploys: st.deploys,
    implConfig: st.implConfig,
    testDelays: TEST_DELAYS,
    knownRecipient: st.knownHot,
    accounts,
  });
  for (const [k, v] of Object.entries<any>(accounts)) log(`${k}: ${v.address} · setup ${v.totalGas} gas, ${v.totalHcu} HCU`);
  log(`\nPREPARATION DONE → results/sepolia/setup-${SEP_RUN}.json · user ${eth(await provider.getBalance(user.address))} ETH`);
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
