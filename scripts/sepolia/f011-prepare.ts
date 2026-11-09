/**
 * F0.11 preparation — deploys the build with the B variant (results/sepolia/f011/build.json) to Sepolia and sets up two
 * measurement accounts with the same libraries (F0.9 method, same test delays, same amount and same known recipient):
 *   a — variant A (encrypted 30 + 10 slots, hidden limit + τ)      b — variant B (open list, open limit, Enc(L_big))
 * Role separation (F0.10 addendum): guardian = watchtower; E_addr is a separate, temporary wallet per account (its key stays
 * in memory only and signs the EIP-712 consent at setup; escape is not executed on these accounts).
 * Warm-up (not measured): the known recipient's account is created; one K-only transfer per variant (opens the counter slots).
 *
 *   SEP_RUN=f011 npx hardhat run scripts/sepolia/f011-prepare.ts
 *
 * Resumable (state-f011.json). Output: results/sepolia/setup-f011.json
 */
import { ethers } from "ethers";
import { pinFingerprint, randomUint64 } from "../../sdk/src";
import { contractAt, deployFromBuild } from "../lib/deploy";
import { LiveCtx, SEP_RUN, encryptTimed, makeLiveCtx, writeJson } from "../lib/live";
import { ENTRYPOINT_V08, InsufficientFunds, eth, gwei } from "../lib/net";
import {
  AMOUNT,
  AccountCfg,
  CHAIN_ID,
  ETH,
  ETH_UNIT,
  F09State,
  LIMITS,
  TEST_DELAYS,
  TEST_PIN,
  TxRec,
  ZERO32,
  escapeConsentSig,
  hcuOf,
  iso,
  loadF09,
  now,
  readAt,
  requireBalance,
  saveF09,
  send,
  setupAccount,
} from "./f09-lib";
import { hotSampleA, syncSampleB } from "./f011-lib";

const WATCHTOWER_MIN = ethers.parseEther("0.004");
const WATCHTOWER_TARGET = ethers.parseEther("0.008");
const ACCOUNT_FUND = ethers.parseEther("0.0002");
/** B's open K-only limit (per epoch): far above 30 samples × 1e12 wei; same level as L_min = 0.1 ETH in F0.9. */
const OPEN_LIMIT_WEI = ethers.parseEther("0.1");

type CfgB = AccountCfg & { openLimitWei: bigint };

/** B setup: createAccount (B factory) → setupPin → setupAssetOpen(ETH) → setupKnownOpen → setupRoles → arm → fund. */
async function setupAccountB(ctx: LiveCtx, st: F09State, key: string, cfg: CfgB, log: (s: string) => void) {
  const { provider, user, build } = ctx;
  const factory = contractAt(build, "EncryptedAccountFactory", st.contracts!.EncryptedAccountFactoryB, user);
  st.accounts ??= {};
  let a = st.accounts[key];
  if (!a) {
    const salt = ethers.id(`f011-${key}-${Date.now()}`);
    const address: string = await factory.predictAddress(user.address, cfg.escape, cfg.guardian, cfg.delays, salt);
    a = st.accounts[key] = { address, salt, delays: cfg.delays, escape: cfg.escape, guardian: cfg.guardian, known: cfg.known, setup: {} };
    saveF09(st);
  }
  const acct = contractAt(build, "EncryptedAccountB", a.address, user);
  let lastBlock = await provider.getBlockNumber();
  const step = async (label: string, done: (o: { blockTag: number }) => Promise<boolean>, run: () => Promise<{ tx: TxRec; receipt: ethers.TransactionReceipt; encrypt?: any }>) => {
    if (a.setup[label]) {
      lastBlock = Math.max(lastBlock, a.setup[label].blockNumber);
      return;
    }
    if (await readAt(done, lastBlock)) {
      log(`  ${key}.${label}: already done on-chain (no record)`);
      return;
    }
    const r = await run();
    lastBlock = r.receipt.blockNumber;
    r.tx.hcu = await hcuOf(provider, r.receipt);
    a.setup[label] = { ...r.tx, ...(r.encrypt ? { encrypt: r.encrypt } : {}) };
    saveF09(st);
    log(`  ${key}.${label}: gas ${r.tx.gasUsed}, HCU ${r.tx.hcu?.total ?? 0}, ${r.tx.wallMs} ms, ${r.tx.hash}`);
  };

  await step(
    "createAccount",
    async (o) => (await provider.getCode(a.address, o.blockTag)).length > 2,
    () =>
      send(user, `${key} createAccount (B)`, async () => {
        if (!cfg.escapeSigner || cfg.escapeSigner.address.toLowerCase() !== a.escape.toLowerCase()) throw new Error("E_addr signer does not match");
        const sig = await escapeConsentSig(cfg.escapeSigner, a.address, 0);
        return factory.createAccountWithDelays.populateTransaction(user.address, a.escape, a.guardian, a.delays, a.salt, sig);
      }),
  );
  await step(
    "setupPin",
    async (o) => (await acct.encryptedHandles(ETH, o))[0] !== ZERO32,
    async () => {
      const t0 = now();
      const fp = await pinFingerprint(TEST_PIN, CHAIN_ID, a.address);
      a.argonSetupMs = Math.round(now() - t0);
      const enc = await encryptTimed(
        ctx,
        [
          { type: "euint64", value: fp },
          { type: "euint64", value: randomUint64() },
          { type: "ebool", value: false },
        ],
        a.address,
        user.address,
      );
      const r = await send(user, `${key} setupPin`, () => acct.setupPin.populateTransaction(enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof));
      return { ...r, encrypt: enc.timing };
    },
  );
  await step(
    "setupAssetOpen",
    async (o) => Boolean((await acct.assetState(ETH, o)).configured),
    async () => {
      const enc = await encryptTimed(ctx, [{ type: "euint64", value: LIMITS.big }], a.address, user.address);
      const r = await send(user, `${key} setupAssetOpen`, () => acct.setupAssetOpen.populateTransaction(ETH, ETH_UNIT, cfg.openLimitWei, enc.handles[0], enc.inputProof));
      return { ...r, encrypt: enc.timing };
    },
  );
  await step(
    "setupKnownOpen",
    async (o) => (await acct.openKnown(false, a.known[0], o)) !== 0n,
    () => send(user, `${key} setupKnownOpen (${a.known.length})`, () => acct.setupKnownOpen.populateTransaction(false, a.known)),
  );
  await step(
    "setupRoles",
    async (o) => Boolean((await acct.status(o))[0]),
    () => send(user, `${key} setupRoles`, () => acct.setupRoles.populateTransaction(ethers.ZeroAddress, ethers.ZeroAddress, 90 * 86400, true)),
  );
  await step(
    "arm",
    async (o) => Boolean((await acct.status(o))[0]),
    () => send(user, `${key} arm`, () => acct.arm.populateTransaction()),
  );
  await step(
    "fund",
    async (o) => (await provider.getBalance(a.address, o.blockTag)) >= cfg.fundWei,
    () => send(user, `${key} fund ${eth(cfg.fundWei)} ETH`, async () => ({ to: a.address, value: cfg.fundWei })),
  );
  return a.address;
}

async function main() {
  if (SEP_RUN !== "f011") throw new Error("run with SEP_RUN=f011 (so the state of earlier runs is not touched)");
  const ctx = await makeLiveCtx();
  const { provider, user, watchtower, build } = ctx;
  if (!watchtower) throw new Error("no watchtower key");
  if (!build.contracts.EncryptedAccountB) throw new Error("build snapshot missing/stale: run scripts/sepolia/snapshot-f011.ts first");
  const st = loadF09();
  const log = (s: string) => console.log(s);
  const fee = await provider.getFeeData();
  log(`user ${user.address} · ${eth(await provider.getBalance(user.address))} ETH · watchtower ${watchtower.address} · ${eth(await provider.getBalance(watchtower.address))} ETH`);
  log(`RPC ${provider.currentUrl} · gas price ≈ ${gwei(fee.gasPrice!).toFixed(4)} gwei · SDK client ${ctx.clientReadyMs} ms`);
  await requireBalance(provider, user, 160_000_000n, "F0.11 preparation (deployment + setup of 2 accounts + warm-up)");

  st.contracts ??= {};
  st.deploys ??= {};
  st.runtimeBytes ??= {};
  const has = async (key: string) => Boolean(st.contracts![key]) && (await provider.getCode(st.contracts![key])).length > 2;
  const deploy = async (key: string, artifact: string, args: () => unknown[], libs: () => Record<string, string>) => {
    if (await has(key)) return;
    const d = await deployFromBuild(user, build, artifact, args(), libs());
    st.contracts![key] = d.address;
    st.deploys![key] = d.tx;
    st.runtimeBytes![key] = d.runtimeBytes;
    saveF09(st);
    log(`  ${key} @ ${d.address} · ${d.runtimeBytes} B · gas ${d.tx.gasUsed} · ${d.tx.inclusionMs} ms · ${d.tx.hash}`);
  };
  const c = () => st.contracts!;
  const accountLibs = () => ({ PinLib: c().PinLib, PolicyLib: c().PolicyLib, OpsLib: c().OpsLib, OpenLib: c().OpenLib });
  log("deployment (F0.11 build):");
  await deploy("PinLib", "PinLib", () => [], () => ({}));
  await deploy("PolicyLib", "PolicyLib", () => [], () => ({}));
  await deploy("OpenLib", "OpenLib", () => [], () => ({}));
  await deploy("OpsLib", "OpsLib", () => [], () => ({ PolicyLib: c().PolicyLib }));
  await deploy("EncryptedAccount", "EncryptedAccount", () => [ENTRYPOINT_V08], accountLibs);
  await deploy("EncryptedAccountB", "EncryptedAccountB", () => [ENTRYPOINT_V08], accountLibs);
  await deploy("EncryptedAccountFactory", "EncryptedAccountFactory", () => [c().EncryptedAccount], () => ({}));
  await deploy("EncryptedAccountFactoryB", "EncryptedAccountFactory", () => [c().EncryptedAccountB], () => ({}));

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
  const escA = await escapeFor("a");
  await setupAccount(ctx, st, "a", { delays: TEST_DELAYS, escape: st.accounts?.a?.escape ?? escA.address, guardian: watchtower.address, known: [st.knownHot], fundWei: ACCOUNT_FUND, escapeSigner: escA }, log);
  const escB = await escapeFor("b");
  await setupAccountB(
    ctx,
    st,
    "b",
    { delays: TEST_DELAYS, escape: st.accounts?.b?.escape ?? escB.address, guardian: watchtower.address, known: [st.knownHot], fundWei: ACCOUNT_FUND, escapeSigner: escB, openLimitWei: OPEN_LIMIT_WEI },
    log,
  );

  // ── warm-up (not measured)
  st.warmup ??= {};
  const acctA = contractAt(build, "EncryptedAccount", st.accounts!.a.address, user);
  const acctAW = contractAt(build, "EncryptedAccount", st.accounts!.a.address, watchtower);
  const acctB = contractAt(build, "EncryptedAccountB", st.accounts!.b.address, user);
  if ((await provider.getBalance(st.knownHot)) === 0n) {
    const r = await send(user, "create the known recipient (1 wei)", async () => ({ to: st.knownHot, value: 1n }));
    st.warmup.recipient = r.tx;
    saveF09(st);
  }
  if (!st.warmup.b) {
    st.warmup.b = await syncSampleB(ctx, acctB, st.knownHot, -1);
    saveF09(st);
    log(`warm-up B: ${st.warmup.b.ok ? "executed" : "NOT EXECUTED"} · gas ${st.warmup.b.gasTotal} · ${st.warmup.b.totalMs} ms`);
  }
  if (!st.warmup.a) {
    st.warmup.a = await hotSampleA(ctx, acctA, acctAW, st.knownHot, -1);
    saveF09(st);
    log(`warm-up A: ${st.warmup.a.ok && st.warmup.a.executed ? "executed" : "NOT EXECUTED"} · gas ${st.warmup.a.gasTotal} · ${st.warmup.a.totalMs} ms`);
  }

  const accounts: any = {};
  for (const k of ["a", "b"]) {
    const a = st.accounts![k];
    const rows = Object.entries(a.setup).map(([label, t]: [string, any]) => ({ step: label, gas: Number(t.gasUsed), hcu: t.hcu?.total ?? 0, meterCheck: t.hcu?.meterCheck ?? null, tx: t.hash, block: t.blockNumber }));
    const setupRows = rows.filter((r) => !r.step.startsWith("fund"));
    accounts[k] = {
      variant: k === "a" ? "A" : "B",
      address: a.address,
      escape: a.escape,
      guardian: a.guardian,
      rows,
      totalGas: setupRows.reduce((s, r) => s + r.gas, 0),
      totalHcu: setupRows.reduce((s, r) => s + r.hcu, 0),
    };
  }
  writeJson("setup-f011.json", {
    evidence: "[M] Sepolia",
    generatedAtUtc: iso(),
    run: SEP_RUN,
    contracts: st.contracts,
    runtimeBytes: st.runtimeBytes,
    deploys: st.deploys,
    testDelays: TEST_DELAYS,
    knownRecipient: st.knownHot,
    amountWei: AMOUNT.toString(),
    openLimitWei: OPEN_LIMIT_WEI.toString(),
    accounts,
    setupDiff: { gasA: accounts.a.totalGas, gasB: accounts.b.totalGas, saved: accounts.a.totalGas - accounts.b.totalGas, ratio: Number((accounts.a.totalGas / accounts.b.totalGas).toFixed(2)) },
    warmup: st.warmup,
  });
  for (const k of ["a", "b"]) log(`${k}: ${accounts[k].address} · setup ${accounts[k].totalGas} gas, ${accounts[k].totalHcu} HCU`);
  log(`\nPREPARATION DONE → results/sepolia/setup-f011.json · user ${eth(await provider.getBalance(user.address))} ETH`);
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
