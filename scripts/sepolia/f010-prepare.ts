/**
 * F0.10 smoke test preparation — deploys the fixed build (results/sepolia/f010/build.json) to Sepolia and sets up two
 * measurement accounts (same method, test delays and limits as F0.9):
 *   e1  — PIN flow (each sample to a new address)       hot — K-only hot path (to a known recipient, below L_min)
 * E_addr: the watchtower wallet (its key stays in memory only; it signs the EIP-712 consent at setup, K55). Escape is not
 * executed on these accounts. TauBench is also deployed for the live E7-v2 draws.
 *
 *   SEP_RUN=f010 npx hardhat run scripts/sepolia/f010-prepare.ts
 *
 * Resumable (state-f010.json). Output: results/sepolia/setup-f010.json
 */
import { ethers } from "ethers";
import { contractAt, deployFromBuild } from "../lib/deploy";
import { SEP_RUN, makeLiveCtx, writeJson } from "../lib/live";
import { ENTRYPOINT_V08, InsufficientFunds, eth, gwei } from "../lib/net";
import { TEST_DELAYS, iso, loadF09, requireBalance, saveF09, send, setupAccount } from "./f09-lib";

const WATCHTOWER_MIN = ethers.parseEther("0.004");
const WATCHTOWER_TARGET = ethers.parseEther("0.008");
const ACCOUNT_FUND = ethers.parseEther("0.0002");

async function main() {
  if (SEP_RUN !== "f010") throw new Error("run with SEP_RUN=f010 (so the F0.9 state is not touched)");
  const ctx = await makeLiveCtx();
  const { provider, user, watchtower, build } = ctx;
  if (!watchtower) throw new Error("no watchtower key");
  if (!build.contracts.TauBench) throw new Error("build snapshot is stale: run scripts/sepolia/snapshot-f010.ts first");
  const st = loadF09();
  const log = (s: string) => console.log(s);
  const fee = await provider.getFeeData();
  log(`user ${user.address} · ${eth(await provider.getBalance(user.address))} ETH · watchtower ${watchtower.address} · ${eth(await provider.getBalance(watchtower.address))} ETH`);
  log(`RPC ${provider.currentUrl} · gas price ≈ ${gwei(fee.gasPrice!).toFixed(4)} gwei · SDK client ${ctx.clientReadyMs} ms`);
  await requireBalance(provider, user, 150_000_000n, "F0.10 preparation (deployment + setup of 2 accounts)");

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
  log("deployment (F0.10 build):");
  await deploy("PinLib", () => [], () => ({}));
  await deploy("PolicyLib", () => [], () => ({}));
  await deploy("OpenLib", () => [], () => ({}));
  await deploy("OpsLib", () => [], () => ({ PolicyLib: c().PolicyLib }));
  await deploy("EncryptedAccount", () => [ENTRYPOINT_V08], () => ({ PinLib: c().PinLib, PolicyLib: c().PolicyLib, OpsLib: c().OpsLib, OpenLib: c().OpenLib }));
  await deploy("EncryptedAccountFactory", () => [c().EncryptedAccount], () => ({}));
  await deploy("TauBench", () => [], () => ({}));
  const impl = contractAt(build, "EncryptedAccount", c().EncryptedAccount, provider);
  const [aclAddr, execAddr, ep] = await Promise.all([impl.aclAddress(), impl.executorAddress(), impl.entryPoint()]);
  st.implConfig = { aclAddress: aclAddr, executorAddress: execAddr, entryPoint: ep };

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
  log("account setup (E_addr = watchtower, with EIP-712 consent):");
  const cfg = { delays: TEST_DELAYS, escape: watchtower.address, guardian: watchtower.address, known: [st.knownHot], fundWei: ACCOUNT_FUND, escapeSigner: watchtower };
  await setupAccount(ctx, st, "e1", cfg, log);
  await setupAccount(ctx, st, "hot", cfg, log);

  const accounts: any = {};
  for (const [k, a] of Object.entries(st.accounts ?? {})) {
    const acct = contractAt(build, "EncryptedAccount", a.address, provider);
    const es = await acct.escapeState();
    const rows = Object.entries(a.setup).map(([label, t]) => ({ step: label, gas: Number(t.gasUsed), hcu: t.hcu?.total ?? null, meterCheck: t.hcu?.meterCheck ?? null, tx: t.hash, block: t.blockNumber }));
    const fheRows = rows.filter((r) => !r.step.startsWith("fund"));
    accounts[k] = {
      address: a.address,
      escape: { address: es.escape_, verifiedAt: Number(es.verifiedAt), nonce: Number(es.nonce) },
      rows,
      totalGas: fheRows.reduce((s, r) => s + r.gas, 0),
      totalHcu: fheRows.reduce((s, r) => s + (r.hcu ?? 0), 0),
    };
  }
  writeJson("setup-f010.json", {
    evidence: "[M] Sepolia",
    generatedAtUtc: iso(),
    run: SEP_RUN,
    contracts: st.contracts,
    runtimeBytes: st.runtimeBytes,
    deploys: st.deploys,
    implConfig: st.implConfig,
    testDelays: TEST_DELAYS,
    accounts,
  });
  for (const [k, v] of Object.entries<any>(accounts)) log(`${k}: ${v.address} · setup ${v.totalGas} gas, ${v.totalHcu} HCU · E_addr nonce ${v.escape.nonce}`);
  log(`\nPREPARATION DONE → results/sepolia/setup-f010.json · user ${eth(await provider.getBalance(user.address))} ETH`);
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
