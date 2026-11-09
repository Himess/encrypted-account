/**
 * F0.15 preparation — deploys the slot-saving build (results/sepolia/f015/build.json) to Sepolia and sets up the same two
 * measurement accounts as F0.10, with the same method, test delays, limits and amount, so that f09-run.ts measures both
 * builds the same way:
 *   e1  — PIN flow (each sample to a new address)       hot — K-only hot path (to a known recipient, below L_min)
 * Role separation (F0.10 addendum): guardian = watchtower; E_addr is a separate, temporary wallet per account (its key stays
 * in memory only and signs the EIP-712 consent at setup; escape is not executed on these accounts). No warm-up, as in F0.10.
 *
 *   SEP_RUN=f015 npx hardhat run scripts/sepolia/f015-prepare.ts
 *   SEP_RUN=f015 F09_N=5 npx hardhat run scripts/sepolia/f09-run.ts
 * SEP_RUN=f015b does the same for step 2 (epoch counters restart at 1), from results/sepolia/f015b/build.json.
 *
 * Resumable (state-<run>.json). Output: results/sepolia/setup-<run>.json
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
  if (SEP_RUN !== "f015" && SEP_RUN !== "f015b") throw new Error("run with SEP_RUN=f015 or f015b (so the state of earlier runs is not touched)");
  const ctx = await makeLiveCtx();
  const { provider, user, watchtower, build } = ctx;
  if (!watchtower) throw new Error("no watchtower key");
  if (!build.contracts.EncryptedAccount || build.contracts.EncryptedAccount.abi.some((f: any) => f.name === "opHash")) {
    throw new Error(`build snapshot missing/stale: run SEP_RUN=${SEP_RUN} scripts/sepolia/snapshot-f015.ts first`);
  }
  const st = loadF09();
  const log = (s: string) => console.log(s);
  const fee = await provider.getFeeData();
  log(`user ${user.address} · ${eth(await provider.getBalance(user.address))} ETH · watchtower ${watchtower.address} · ${eth(await provider.getBalance(watchtower.address))} ETH`);
  log(`RPC ${provider.currentUrl} · gas price ≈ ${gwei(fee.gasPrice!).toFixed(4)} gwei · SDK client ${ctx.clientReadyMs} ms`);
  await requireBalance(provider, user, 150_000_000n, `${SEP_RUN} preparation (deployment + setup of 2 accounts)`);

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
  log(`deployment (${SEP_RUN} build):`);
  await deploy("PinLib", () => [], () => ({}));
  await deploy("PolicyLib", () => [], () => ({}));
  await deploy("OpenLib", () => [], () => ({}));
  await deploy("OpsLib", () => [], () => ({ PolicyLib: c().PolicyLib }));
  await deploy("EncryptedAccount", () => [ENTRYPOINT_V08], () => ({ PinLib: c().PinLib, PolicyLib: c().PolicyLib, OpsLib: c().OpsLib, OpenLib: c().OpenLib }));
  await deploy("EncryptedAccountFactory", () => [c().EncryptedAccount], () => ({}));
  const impl = contractAt(build, "EncryptedAccount", c().EncryptedAccount, provider);
  const [aclAddr, execAddr, ep] = await Promise.all([impl.aclAddress(), impl.executorAddress(), impl.entryPoint()]);
  st.implConfig = { aclAddress: aclAddr, executorAddress: execAddr, entryPoint: ep };
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
  // E_addr: a temporary wallet per account. If the account does not exist yet (interrupted run), it is predicted afresh with a new wallet.
  const escapeFor = async (key: string) => {
    const w = new ethers.Wallet(ethers.Wallet.createRandom().privateKey); // key stays in memory
    const prev = st.accounts?.[key];
    if (prev && (await provider.getCode(prev.address)).length <= 2) {
      delete st.accounts![key];
      saveF09(st);
    }
    return w;
  };
  log("account setup (guardian = watchtower, E_addr = temporary wallet, with EIP-712 consent):");
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
