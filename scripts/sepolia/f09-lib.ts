/**
 * F0.9 shared helpers (Round 2): state file, timed transaction sending (block, gas), live HCU reads
 * (HCULimit.getBlockMeter) cross-checked against the HCU computed from events, measurement account setup, statistics.
 *
 * Rules (Round 2 §4.0): Sepolia only; the burner and watchtower keys live only in .env.sepolia and are never
 * written to any output; the account contracts are deployed from the Round 1 build in results/sepolia/baseline/build.json
 * (F0.9 runs "without code changes, with the existing version").
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { pinFingerprint, randomUint64 } from "../../sdk/src";
import { contractAt } from "../lib/deploy";
import { SEPOLIA_EXECUTOR, txHCU } from "../lib/hcu";
import { LiveCtx, OUT_DIR, SEP_RUN, encryptTimed, loadState, saveState } from "../lib/live";
import { InsufficientFunds, ManagedWallet, ResilientProvider, TxRecord, eth, sendTx } from "../lib/net";

export const CHAIN_ID = 11155111n;
/** F0.9: state-baseline.json; F0.10 (SEP_RUN=f010): state-f010.json — the runs keep separate state. */
export const STATE_FILE = path.join(OUT_DIR, SEP_RUN === "baseline" ? "state-baseline.json" : `state-${SEP_RUN}.json`);
export const HCU_LIMIT = "0xa10998783c8CF88D886Bc30307e631D6686F0A22";
export const ETH = ethers.ZeroAddress;
export const ZERO32 = ethers.ZeroHash;
/** Test PIN (same as the Round 1 tests); not a real user's PIN. */
export const TEST_PIN = "482915";
/** ETH: 1 encrypted unit = 1e12 wei (micro-ETH), same as Round 1. */
export const ETH_UNIT = 10n ** 12n;
/** L_min / L / L_big = 0.1 / 0.3 / 3 ETH (Round 1 default). */
export const LIMITS = { lmin: 100_000n, lmax: 300_000n, big: 3_000_000n };
/** Transfer per sample: 1 unit = 1e12 wei. 30 K-only samples total 30 units ≪ τ (τ ≥ L_min = 100 000 units). */
export const AMOUNT = ETH_UNIT;
export const TRACK_OWNER = 0;
export const N_RECIPIENTS = 30;
export const N_SPENDERS = 10;

export type Delays = {
  pinTransfer: number;
  bigTransfer: number;
  genericCall: number;
  settings: number;
  loosen: number;
  knownAdd: number;
  recovery: number;
  recoveryNoDevice: number;
  pinReset: number;
  escape: number;
  escapeChange: number;
};

/** Measurement accounts: short test delays (the policy delay is not part of E1; production values are recorded separately). */
export const TEST_DELAYS: Delays = {
  pinTransfer: 0,
  bigTransfer: 60,
  genericCall: 60,
  settings: 60,
  loosen: 60,
  knownAdd: 60,
  recovery: 120,
  recoveryNoDevice: 300,
  pinReset: 300,
  escape: 300,
  escapeChange: 300,
};
/** Live verification account: escape 120 s (the escape start → execute flow finishes within the run). */
export const LIVE_DELAYS: Delays = { ...TEST_DELAYS, escape: 120 };

export const now = () => performance.now();
export const iso = () => new Date().toISOString();
export const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

// ───────────────────────────── state ─────────────────────────────

export type HcuRec = {
  /** computed from events (Zama price table, the plugin's code) */
  total: number;
  depth: number;
  fheOps: number;
  /** live read: HCULimit.getBlockMeter() at the transaction's block (sum over all metered FHE transactions in the block) */
  blockMeter: number | null;
  /** number of FHE transactions in the block and their total computed from events (for comparison with blockMeter) */
  blockFheTxs: number | null;
  blockComputed: number | null;
  meterCheck: "equal" | "different" | "unreadable";
};

export type TxRec = TxRecord & {
  sentBlock: number;
  blocksToInclusion: number;
  /** wall-clock time including gas estimation + signing + sending + seeing the receipt */
  wallMs: number;
  status: number;
  /** number of gas-estimation retries (load-balanced RPC backends may not have seen the previous block yet) */
  estimateRetries?: number;
  hcu?: HcuRec | null;
};

export type AccountState = {
  address: string;
  salt: string;
  delays: Delays;
  escape: string;
  guardian: string;
  known: string[];
  setup: Record<string, TxRec & { encrypt?: any }>;
  argonSetupMs?: number;
};

export type F09State = {
  spike?: string;
  deploys?: Record<string, any>;
  contracts?: Record<string, string>;
  runtimeBytes?: Record<string, number>;
  knownHot?: string;
  escapeTest?: string;
  accounts?: Record<string, AccountState>;
  funding?: Record<string, any>;
  [k: string]: any;
};

export function loadF09(): F09State {
  return loadState(STATE_FILE) as F09State;
}
export function saveF09(st: F09State) {
  saveState(STATE_FILE, st);
}

export function readJson(name: string): any {
  const f = path.join(OUT_DIR, name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

// ───────────────────────────── transaction sending ─────────────────────────────

/**
 * Timed send. `wallMs` includes gas estimation + signing + sending + receipt (500 ms polling); `inclusionMs`
 * runs from send to receipt. HCU is not computed here (so it does not skew the measured flow's timing); `attachHcu` adds it later.
 */
export async function send(
  w: ManagedWallet,
  label: string,
  populate: () => Promise<ethers.TransactionRequest>,
  opts: { gasLimit?: bigint; gasMult?: bigint; timeoutMs?: number } = {},
): Promise<{ tx: TxRec; receipt: ethers.TransactionReceipt }> {
  const provider = w.provider as ResilientProvider;
  const t0 = now();
  let sentBlock = 0;
  let estimateRetries = 0;
  const rec = await sendTx(
    w,
    label,
    async () => {
      const [req, bn] = await Promise.all([populate(), provider.getBlockNumber()]);
      sentBlock = bn;
      if (opts.gasLimit) return { ...req, gasLimit: opts.gasLimit };
      // On load-balanced public RPCs a request can land on a backend that has not yet seen the previous transaction's block:
      // if the estimate reverts, retry at a short interval (a genuine revert reverts on all 5 attempts and is thrown).
      for (let k = 0; ; k++) {
        try {
          const est = await provider.estimateGas({ ...req, from: w.address });
          estimateRetries = k;
          return { ...req, gasLimit: (est * (opts.gasMult ?? 130n)) / 100n };
        } catch (e) {
          if (k >= 4) throw e;
          await new Promise((res) => setTimeout(res, 1500));
        }
      }
    },
    { timeoutMs: opts.timeoutMs ?? 150_000, pollMs: 500 },
  );
  const { receipt, ...r } = rec;
  return {
    tx: { ...r, sentBlock, blocksToInclusion: r.blockNumber - sentBlock, wallMs: Math.round(now() - t0), status: receipt.status ?? 1, estimateRetries },
    receipt,
  };
}

/**
 * Reads after a transaction: a call pinned to the given block. If the backend has not seen that block yet, an error
 * ("header not found" etc.) or an empty result comes back → retried at a short interval.
 */
export async function readAt<T>(fn: (overrides: { blockTag: number }) => Promise<T>, blockTag: number, attempts = 8): Promise<T> {
  let last: unknown;
  for (let k = 0; k < attempts; k++) {
    try {
      return await fn({ blockTag });
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  throw last;
}

/** Sends a transaction that is expected to revert, with a fixed gas limit; records the revert's tx hash as evidence. */
export async function sendExpectRevert(
  w: ManagedWallet,
  label: string,
  populate: () => Promise<ethers.TransactionRequest>,
  gasLimit: bigint,
): Promise<{ tx: TxRec; receipt: ethers.TransactionReceipt; reverted: boolean }> {
  const provider = w.provider as ResilientProvider;
  const t0 = now();
  let sentBlock = 0;
  const sentAtUtc = iso();
  try {
    const rec = await sendTx(
      w,
      label,
      async () => {
        const [req, bn] = await Promise.all([populate(), provider.getBlockNumber()]);
        sentBlock = bn;
        return { ...req, gasLimit };
      },
      { timeoutMs: 150_000, pollMs: 500, maxBumps: 2 },
    );
    const { receipt, ...r } = rec;
    return { tx: { ...r, sentBlock, blocksToInclusion: r.blockNumber - sentBlock, wallMs: Math.round(now() - t0), status: 1 }, receipt, reverted: false };
  } catch (e: any) {
    const rc: ethers.TransactionReceipt | undefined = e?.receipt;
    if (!rc) throw e;
    const [block, txo] = await Promise.all([provider.getBlock(rc.blockNumber), provider.getTransaction(rc.hash)]);
    return {
      tx: {
        label,
        hash: rc.hash,
        nonce: txo?.nonce ?? -1,
        blockNumber: rc.blockNumber,
        blockTimestamp: block?.timestamp ?? 0,
        sentAtUtc,
        minedSeenAtUtc: iso(),
        inclusionMs: Math.round(now() - t0),
        gasUsed: rc.gasUsed.toString(),
        effectiveGasPriceWei: rc.gasPrice.toString(),
        costWei: (rc.gasUsed * rc.gasPrice).toString(),
        replacements: 0,
        sentBlock,
        blocksToInclusion: rc.blockNumber - sentBlock,
        wallMs: Math.round(now() - t0),
        status: 0,
      },
      receipt: rc,
      reverted: true,
    };
  }
}

// ───────────────────────────── HCU ─────────────────────────────

const meterItf = new ethers.Interface(["function getBlockMeter() view returns (uint48 blockNumber, uint48 usedHCU)"]);

/**
 * A transaction's HCU: (1) total/depth computed from its own events; (2) live read — HCULimit's block meter
 * (`getBlockMeter`, eth_call at the transaction's block); (3) the total computed from events over all FHE transactions in the block.
 * If (2) = (3), the live price table matches the plugin's and (1) is the live HCU.
 */
export async function hcuOf(provider: ResilientProvider, receipt: ethers.TransactionReceipt): Promise<HcuRec | null> {
  const own = txHCU(receipt);
  if (!own) return null;
  let blockMeter: number | null = null;
  try {
    const raw = await provider.call({ to: HCU_LIMIT, data: meterItf.encodeFunctionData("getBlockMeter"), blockTag: receipt.blockNumber });
    const [bn, used] = meterItf.decodeFunctionResult("getBlockMeter", raw);
    blockMeter = Number(bn) === receipt.blockNumber ? Number(used) : 0;
  } catch {
    blockMeter = null;
  }
  let blockFheTxs: number | null = null;
  let blockComputed: number | null = null;
  try {
    const logs = await provider.getLogs({ address: SEPOLIA_EXECUTOR, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
    const byTx = new Map<string, ethers.Log[]>();
    for (const l of logs) {
      const arr = byTx.get(l.transactionHash) ?? [];
      arr.push(l);
      byTx.set(l.transactionHash, arr);
    }
    blockFheTxs = byTx.size;
    let sum = 0;
    for (const [hash, ls] of byTx) {
      ls.sort((a, b) => a.index - b.index);
      sum += txHCU({ status: 1, hash, logs: ls } as any)?.total ?? 0;
    }
    blockComputed = sum;
  } catch {
    /* unreadable */
  }
  const meterCheck = blockMeter === null || blockComputed === null ? "unreadable" : blockMeter === blockComputed ? "equal" : "different";
  return { total: own.total, depth: own.depth, fheOps: own.ops, blockMeter, blockFheTxs, blockComputed, meterCheck };
}

/** Attaches HCU afterwards from the recorded receipts (after the measured flow). */
export async function attachHcu(provider: ResilientProvider, items: { tx: TxRec; receipt: ethers.TransactionReceipt }[]) {
  for (const it of items) {
    try {
      it.tx.hcu = await hcuOf(provider, it.receipt);
    } catch {
      it.tx.hcu = null;
    }
  }
}

// ───────────────────────────── events ─────────────────────────────

export function parseEvent(c: ethers.Contract, receipt: ethers.TransactionReceipt, name: string): ethers.LogDescription | null {
  const addr = String(c.target).toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== addr) continue;
    try {
      const ev = c.interface.parseLog(log);
      if (ev?.name === name) return ev;
    } catch {
      /* another event */
    }
  }
  return null;
}

export function executorLogCount(receipt: ethers.TransactionReceipt): number {
  return receipt.logs.filter((l) => l.address.toLowerCase() === SEPOLIA_EXECUTOR.toLowerCase()).length;
}

// ───────────────────────────── balance threshold ─────────────────────────────

/** Balance threshold: if insufficient, throws InsufficientFunds stating the shortfall (scripts resume where they left off). */
export async function requireBalance(provider: ResilientProvider, w: ManagedWallet, gas: bigint, context: string, extraWei = 0n) {
  const fee = await provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const need = gas * price + extraWei;
  const bal = await provider.getBalance(w.address);
  if (bal < need) throw new InsufficientFunds(w.address, bal, need, context);
  return bal;
}

// ───────────────────────────── measurement account setup ─────────────────────────────

/** escapeSigner: in the F0.10 build E_addr gives an EIP-712 consent at setup (K55); the key stays in memory only. */
export type AccountCfg = { delays: Delays; escape: string; guardian: string; known: string[]; fundWei: bigint; escapeSigner?: ethers.Wallet };

/** K55: E_addr's consent for the account (nonce 0 = setup). Domain: the account itself (clone address) and the chain. */
export async function escapeConsentSig(signer: ethers.Wallet, account: string, nonce = 0): Promise<string> {
  return await signer.signTypedData(
    { name: "EncryptedAccount", version: "1", chainId: CHAIN_ID, verifyingContract: account },
    { EscapeAddress: [{ name: "escape", type: "address" }, { name: "nonce", type: "uint32" }] },
    { escape: signer.address, nonce },
  );
}

/**
 * Creates the account (counterfactual clone) and runs the Round 1 setup flow: setupPin, setupAsset(ETH),
 * setupKnown (recipients 12+12+6, spenders 10; encrypted zeros first, real entries last), setupRoles, arm, funding.
 * Each step is checked on-chain (not resent on a re-run); gas/HCU is recorded per transaction.
 */
export async function setupAccount(ctx: LiveCtx, st: F09State, key: string, cfg: AccountCfg, log: (s: string) => void): Promise<string> {
  const { provider, user, build } = ctx;
  if (!st.contracts?.EncryptedAccountFactory) throw new Error("factory not deployed (run f09-prepare first)");
  st.accounts ??= {};
  const factory = contractAt(build, "EncryptedAccountFactory", st.contracts.EncryptedAccountFactory, user);
  let a = st.accounts[key];
  if (!a) {
    const salt = ethers.id(`f09-${key}-${Date.now()}`);
    const address: string = await factory.predictAddress(user.address, cfg.escape, cfg.guardian, cfg.delays, salt);
    a = st.accounts[key] = { address, salt, delays: cfg.delays, escape: cfg.escape, guardian: cfg.guardian, known: cfg.known, setup: {} };
    saveF09(st);
  }
  const acct = contractAt(build, "EncryptedAccount", a.address, user);

  // Block of the last transaction: later check reads are pinned to it (so a lagging RPC backend does not wrongly report "not done").
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
    log(`  ${key}.${label}: gas ${r.tx.gasUsed}, HCU ${r.tx.hcu?.total ?? "-"}, ${r.tx.wallMs} ms, ${r.tx.hash}`);
  };

  await step(
    "createAccount",
    async (o) => (await provider.getCode(a.address, o.blockTag)).length > 2,
    () =>
      send(user, `${key} createAccount`, async () => {
        // F0.10 build (K55): the factory also requires E_addr's consent signature
        if (factory.interface.getFunction("createAccountWithDelays")!.inputs.length === 6) {
          if (!cfg.escapeSigner || cfg.escapeSigner.address.toLowerCase() !== a.escape.toLowerCase()) {
            throw new Error("this build requires E_addr consent (K55): no signer was given for the escape address");
          }
          const sig = await escapeConsentSig(cfg.escapeSigner, a.address, 0);
          return factory.createAccountWithDelays.populateTransaction(user.address, a.escape, a.guardian, a.delays, a.salt, sig);
        }
        return factory.createAccountWithDelays.populateTransaction(user.address, a.escape, a.guardian, a.delays, a.salt);
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
    "setupAsset",
    async (o) => Boolean((await acct.assetState(ETH, o)).configured),
    async () => {
      const enc = await encryptTimed(
        ctx,
        [
          { type: "euint64", value: LIMITS.lmin },
          { type: "euint64", value: LIMITS.lmax },
          { type: "euint64", value: LIMITS.big },
        ],
        a.address,
        user.address,
      );
      const r = await send(user, `${key} setupAsset`, () =>
        acct.setupAsset.populateTransaction(ETH, ETH_UNIT, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof),
      );
      return { ...r, encrypt: enc.timing };
    },
  );

  const knownR = [...Array(N_RECIPIENTS - a.known.length).fill(ethers.ZeroAddress), ...a.known];
  for (let s = 0; s < N_RECIPIENTS; s += 12) {
    const chunk = knownR.slice(s, s + 12);
    await step(
      `setupKnownR${s}`,
      async (o) => (await acct.knownSlot(false, s, o))[1] !== 0n,
      async () => {
        const enc = await encryptTimed(ctx, chunk.map((v) => ({ type: "eaddress", value: v })), a.address, user.address);
        const r = await send(user, `${key} setupKnown R${s} (${chunk.length})`, () => acct.setupKnown.populateTransaction(false, s, enc.handles, enc.inputProof));
        return { ...r, encrypt: enc.timing };
      },
    );
  }
  await step(
    "setupKnownS0",
    async (o) => (await acct.knownSlot(true, 0, o))[1] !== 0n,
    async () => {
      const enc = await encryptTimed(ctx, Array(N_SPENDERS).fill(ethers.ZeroAddress).map((v) => ({ type: "eaddress", value: v })), a.address, user.address);
      const r = await send(user, `${key} setupKnown S0 (10)`, () => acct.setupKnown.populateTransaction(true, 0, enc.handles, enc.inputProof));
      return { ...r, encrypt: enc.timing };
    },
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

// ───────────────────────────── statistics ─────────────────────────────

/** Percentile by the nearest-rank method (for n = 30, p95 = the 29th smallest). */
export function pct(a: number[], p: number): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export function summarize(a: number[]) {
  if (a.length === 0) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  return { n: s.length, min: s[0], p50: pct(s, 50), p95: pct(s, 95), max: s[s.length - 1], mean: Math.round(mean) };
}

export function histogram(a: number[], binMs = 5000) {
  if (a.length === 0) return [];
  const lo = Math.floor(Math.min(...a) / binMs) * binMs;
  const hi = Math.ceil((Math.max(...a) + 1) / binMs) * binMs;
  const out: { fromS: number; toS: number; count: number }[] = [];
  for (let x = lo; x < hi; x += binMs) out.push({ fromS: x / 1000, toS: (x + binMs) / 1000, count: a.filter((v) => v >= x && v < x + binMs).length });
  return out;
}
