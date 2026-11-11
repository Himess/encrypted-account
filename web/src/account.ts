/**
 * Account flows of the demo: create + set up an Encrypted Account (8 transactions), and send ETH with the PIN
 * (open → encrypted guess → public decryption of the result bit → finalize → execute).
 * Same sequence as the Sepolia measurement scripts (scripts/sepolia/f09-lib.ts, f09-run.ts).
 */
import { ethers } from "ethers";
import { ACCOUNT_ABI, FACTORY_ABI } from "./abi";
import { CHAIN_ID, DEMO_DELAYS, ETH, ETH_UNIT, FACTORY, FACTORY_DEPLOY_BLOCK, LOG_RPC_URLS, N_RECIPIENTS, N_SPENDERS, TRACK_OWNER, ZERO32 } from "./chain";
import { asBool, encrypt, publicDecrypt } from "./fhe";
import { guessValue, pinFingerprint, randomUint64 } from "./pin";
import { Status, sendTx } from "./tx";
import type { Wallet } from "./wallet";

export type Ctx = { w: Wallet; read: ethers.JsonRpcProvider };

const IFACE = new ethers.Interface(ACCOUNT_ABI as any);
const FIFACE = new ethers.Interface(FACTORY_ABI as any);
const acct = (addr: string, runner: ethers.ContractRunner) => new ethers.Contract(addr, ACCOUNT_ABI as any, runner);
const factory = (runner: ethers.ContractRunner) => new ethers.Contract(FACTORY, FACTORY_ABI as any, runner);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function eventOf(receipt: ethers.TransactionReceipt, account: string, name: string): ethers.LogDescription {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== account.toLowerCase()) continue;
    try {
      const ev = IFACE.parseLog(log);
      if (ev?.name === name) return ev;
    } catch {
      /* another event */
    }
  }
  throw new Error(`${name} event not found in the receipt`);
}

// ───────────────────────────── reading ─────────────────────────────

/**
 * eth_getLogs in windows: the public RPC refuses ranges of 50,000 blocks or more. The last window ends at "latest",
 * not at a block number: the RPC is load-balanced, and a backend one block behind refuses a range that ends past its
 * own head ("block range extends beyond current head block").
 */
export async function getLogsChunked(read: ethers.JsonRpcProvider, filter: { address: string; topics?: (string | null)[] }, fromBlock: number, toBlock: number, step = 45_000): Promise<ethers.Log[]> {
  const ranges: [number, number | "latest"][] = [];
  for (let a = fromBlock; a <= toBlock; a += step) ranges.push([a, a + step - 1 >= toBlock ? "latest" : a + step - 1]);
  const out: ethers.Log[] = [];
  for (let i = 0; i < ranges.length; i += 4) {
    const res = await Promise.all(ranges.slice(i, i + 4).map(([a, b]) => getLogsAny(read, { ...filter, fromBlock: a, toBlock: b })));
    for (const r of res) out.push(...r);
  }
  return out;
}

const logProviders = LOG_RPC_URLS.map((u) => new ethers.JsonRpcProvider(u, Number(CHAIN_ID), { staticNetwork: ethers.Network.from(Number(CHAIN_ID)) }));

/** One getLogs call: the log RPCs in order, then the main one; each tried twice. */
async function getLogsAny(read: ethers.JsonRpcProvider, filter: ethers.Filter): Promise<ethers.Log[]> {
  let last: unknown = null;
  for (const p of [...logProviders, read]) {
    for (let k = 0; k < 2; k++) {
      try {
        return await p.getLogs(filter);
      } catch (e) {
        last = e;
        await sleep(600);
      }
    }
  }
  throw last;
}

export async function findAccounts(read: ethers.JsonRpcProvider, owner: string): Promise<string[]> {
  const topics = (await factory(read).filters.AccountCreated(null, owner).getTopicFilter()) as (string | null)[];
  const logs = await getLogsChunked(read, { address: FACTORY, topics }, FACTORY_DEPLOY_BLOCK, await read.getBlockNumber());
  return logs.map((l) => String(FIFACE.parseLog(l)!.args.account));
}

export async function readEscape(read: ethers.JsonRpcProvider, address: string): Promise<string> {
  return String((await acct(address, read).escapeState())[0]);
}

export type Activity = {
  kind: "sent" | "wrong" | "pending" | "approved" | "cancelled" | "armed";
  amount?: bigint;
  to?: string;
  block: number;
  hash: string;
  time?: number;
};

/** The account's history from its own events: PIN transfers (sent, wrong PIN, pending) and activation. */
export async function loadActivity(read: ethers.JsonRpcProvider, address: string, limit = 12): Promise<Activity[]> {
  const latest = await read.getBlockNumber();
  const logs = await getLogsChunked(read, { address }, FACTORY_DEPLOY_BLOCK, latest);
  type OpRec = { amount: bigint; to: string; block: number; hash: string; ok?: boolean; fin?: [number, string]; exec?: [number, string]; cancel?: [number, string] };
  const ops = new Map<string, OpRec>();
  const items: Activity[] = [];
  for (const log of logs) {
    let ev: ethers.LogDescription | null = null;
    try {
      ev = IFACE.parseLog(log);
    } catch {
      continue;
    }
    if (!ev) continue;
    const id = ev.args.opId !== undefined ? String(ev.args.opId) : "";
    const at: [number, string] = [log.blockNumber, log.transactionHash];
    if (ev.name === "OpOpened") ops.set(id, { amount: BigInt(ev.args.amount), to: String(ev.args.counterparty), block: at[0], hash: at[1] });
    else if (ev.name === "GuessFinalized" && ops.has(id)) Object.assign(ops.get(id)!, { ok: Boolean(ev.args.ok), fin: at });
    else if (ev.name === "OpExecuted" && ops.has(id)) ops.get(id)!.exec = at;
    else if (ev.name === "OpCancelled" && ops.has(id)) ops.get(id)!.cancel = at;
    else if (ev.name === "Armed") items.push({ kind: "armed", block: at[0], hash: at[1] });
  }
  for (const o of ops.values()) {
    const [kind, [block, hash]]: [Activity["kind"], [number, string]] = o.exec
      ? ["sent", o.exec]
      : o.cancel
        ? ["cancelled", o.cancel]
        : o.ok === false
          ? ["wrong", o.fin!]
          : o.ok === true
            ? ["approved", o.fin!]
            : ["pending", [o.block, o.hash]];
    items.push({ kind, amount: o.amount, to: o.to, block, hash });
  }
  items.sort((a, b) => b.block - a.block);
  const top = items.slice(0, limit);
  const blocks = [...new Set(top.map((i) => i.block))];
  const times = new Map<number, number>();
  await Promise.all(blocks.map(async (n) => times.set(n, (await read.getBlock(n))?.timestamp ?? 0)));
  for (const i of top) i.time = times.get(i.block);
  return top;
}

export type AccountView = {
  address: string;
  exists: boolean;
  armed: boolean;
  balance: bigint;
  restricted: number;
  score: number;
  nextAllowedAt: number;
  pendingOp: bigint;
  escapeReadyAt: number;
};

export async function readAccount(read: ethers.JsonRpcProvider, address: string): Promise<AccountView> {
  const [code, balance] = await Promise.all([read.getCode(address), read.getBalance(address)]);
  if (code === "0x") return { address, exists: false, armed: false, balance, restricted: 0, score: 0, nextAllowedAt: 0, pendingOp: 0n, escapeReadyAt: 0 };
  const a = acct(address, read);
  const [st, ts] = await Promise.all([a.status(), a.trackState(TRACK_OWNER)]);
  return {
    address,
    exists: true,
    armed: Boolean(st[0]),
    balance,
    restricted: Number(st[1]),
    escapeReadyAt: Number(st[5]),
    score: Number(ts[0]),
    nextAllowedAt: Number(ts[1]),
    pendingOp: BigInt(ts[2]),
  };
}

// ───────────────────────────── creation and setup ─────────────────────────────

export type Plan = { account: string; escape: string; salt: string; limitUnits: string; known: string | null };
const planKey = (owner: string) => `ea:plan:${owner.toLowerCase()}`;
export const loadPlan = (owner: string): Plan | null => {
  try {
    return JSON.parse(localStorage.getItem(planKey(owner)) ?? "null");
  } catch {
    return null;
  }
};
const savePlan = (owner: string, p: Plan) => {
  try {
    localStorage.setItem(planKey(owner), JSON.stringify(p));
  } catch {
    /* private window: no resume */
  }
};
export const clearPlan = (owner: string) => {
  try {
    localStorage.removeItem(planKey(owner));
  } catch {
    /* none */
  }
};

export const SETUP_STEPS = [
  "Create the account",
  "Store your encrypted PIN fingerprint",
  "Store your hidden spending limit",
  "Encrypted address list 1/3",
  "Encrypted address list 2/3",
  "Encrypted address list 3/3",
  "Encrypted spender list",
  "Turn the account on",
] as const;

export type StepCb = (i: number, state: "run" | "done" | "skip" | "fail", text?: string, hash?: string) => void;

/**
 * Creates and sets up the account. Resumable: every step is checked on-chain first, so a reload continues where it
 * stopped (the PIN is asked again; it is never stored).
 */
export async function createAndSetup(
  ctx: Ctx,
  opts: { pin: string; limitEth: string; known: string | null; escapeWallet: ethers.HDNodeWallet | ethers.Wallet },
  cb: StepCb,
): Promise<string> {
  const owner = ctx.w.address;
  const limitUnits = ethers.parseEther(opts.limitEth) / ETH_UNIT;
  if (limitUnits < 2n) throw new Error("The limit must be at least 0.000002 ETH.");

  let plan = loadPlan(owner);
  if (plan) {
    const created = (await ctx.read.getCode(plan.account)) !== "0x";
    // Not created yet and the escape key of that attempt is gone: start a fresh plan (nothing is on-chain).
    if (!created && plan.escape.toLowerCase() !== opts.escapeWallet.address.toLowerCase()) plan = null;
  }
  if (!plan) {
    const salt = ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
    const account: string = await factory(ctx.read).predictAddress(owner, opts.escapeWallet.address, ethers.ZeroAddress, DEMO_DELAYS, salt);
    plan = { account, escape: opts.escapeWallet.address, salt, limitUnits: limitUnits.toString(), known: opts.known };
    savePlan(owner, plan);
  }
  const A = plan.account;
  const a = acct(A, ctx.read);
  const run = async (i: number, done: () => Promise<boolean>, go: (st: Status) => Promise<ethers.TransactionReceipt>) => {
    if (await done()) return cb(i, "skip");
    cb(i, "run");
    try {
      const r = await go((t, h) => cb(i, "run", t, h));
      cb(i, "done", undefined, r.hash);
    } catch (e: any) {
      cb(i, "fail", e?.message ?? String(e));
      throw e;
    }
  };

  // 1. clone + initialize (the escape address consents with an EIP-712 signature, K55)
  await run(
    0,
    async () => (await ctx.read.getCode(A)) !== "0x",
    async (st) => {
      if (opts.escapeWallet.address.toLowerCase() !== plan!.escape.toLowerCase()) throw new Error("escape key mismatch; reload the page");
      const sig = await opts.escapeWallet.signTypedData(
        { name: "EncryptedAccount", version: "1", chainId: CHAIN_ID, verifyingContract: A },
        { EscapeAddress: [{ name: "escape", type: "address" }, { name: "nonce", type: "uint32" }] },
        { escape: plan!.escape, nonce: 0 },
      );
      const data = FIFACE.encodeFunctionData("createAccountWithDelays", [owner, plan!.escape, ethers.ZeroAddress, DEMO_DELAYS, plan!.salt, sig]);
      return sendTx(ctx.w, ctx.read, { to: FACTORY, data }, st);
    },
  );

  // 2. PIN: Enc(h), a random duress candidate (never selected) and useDuress = false
  await run(
    1,
    async () => (await a.encryptedHandles(ETH))[0] !== ZERO32,
    async (st) => {
      st("Deriving the fingerprint (Argon2id)…");
      const fp = await pinFingerprint(opts.pin, CHAIN_ID, A);
      st("Encrypting…");
      const enc = await encrypt(ctx.read, [{ type: "euint64", value: fp }, { type: "euint64", value: randomUint64() }, { type: "ebool", value: false }], A, owner);
      const data = IFACE.encodeFunctionData("setupPin", [enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof]);
      return sendTx(ctx.w, ctx.read, { to: A, data }, st);
    },
  );

  // 3. hidden limit: L_min = L/2, L, L_big = 10·L (units of 10^12 wei); the tripwire is drawn on-chain in [L_min, L)
  await run(
    2,
    async () => Boolean((await a.assetState(ETH)).configured),
    async (st) => {
      const l = BigInt(plan!.limitUnits);
      st("Encrypting…");
      const enc = await encrypt(ctx.read, [{ type: "euint64", value: l / 2n }, { type: "euint64", value: l }, { type: "euint64", value: l * 10n }], A, owner);
      const data = IFACE.encodeFunctionData("setupAsset", [ETH, ETH_UNIT, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof]);
      return sendTx(ctx.w, ctx.read, { to: A, data }, st);
    },
  );

  // 4–6. known recipients: 30 encrypted slots (empty slots first, the optional known address last)
  const known = plan.known ? [plan.known] : [];
  const listR = [...Array(N_RECIPIENTS - known.length).fill(ethers.ZeroAddress), ...known];
  for (let s = 0, i = 3; s < N_RECIPIENTS; s += 12, i++) {
    const chunk = listR.slice(s, s + 12);
    await run(
      i,
      async () => BigInt((await a.knownSlot(false, s))[1]) !== 0n,
      async (st) => {
        st(`Encrypting ${chunk.length} addresses…`);
        const enc = await encrypt(ctx.read, chunk.map((v) => ({ type: "eaddress" as const, value: v })), A, owner);
        const data = IFACE.encodeFunctionData("setupKnown", [false, s, enc.handles, enc.inputProof]);
        return sendTx(ctx.w, ctx.read, { to: A, data }, st);
      },
    );
  }

  // 7. known spenders: 10 empty encrypted slots
  await run(
    6,
    async () => BigInt((await a.knownSlot(true, 0))[1]) !== 0n,
    async (st) => {
      st("Encrypting…");
      const enc = await encrypt(ctx.read, Array.from({ length: N_SPENDERS }, () => ({ type: "eaddress" as const, value: ethers.ZeroAddress })), A, owner);
      const data = IFACE.encodeFunctionData("setupKnown", [true, 0, enc.handles, enc.inputProof]);
      return sendTx(ctx.w, ctx.read, { to: A, data }, st);
    },
  );

  // 8. arm
  await run(
    7,
    async () => Boolean((await a.status())[0]),
    async (st) => sendTx(ctx.w, ctx.read, { to: A, data: IFACE.encodeFunctionData("arm", []) }, st),
  );

  clearPlan(owner);
  return A;
}

// ───────────────────────────── sending with the PIN ─────────────────────────────

export const SEND_STEPS = [
  "Open the transfer",
  "Encrypt your PIN guess",
  "Submit the encrypted guess",
  "Zama decrypts only the yes/no result",
  "Record the result on-chain",
  "Send the ETH",
] as const;

export class WrongPin extends Error {
  constructor(public nextAllowedAt: number, public score: number) {
    super("Wrong PIN");
  }
}

/** A guess that was submitted but never finalized (page closed) blocks the slot: finalize it first. */
async function finalizePending(ctx: Ctx, account: string, st: Status): Promise<void> {
  const a = acct(account, ctx.read);
  const ts = await a.trackState(TRACK_OWNER);
  const pending = BigInt(ts[2]);
  if (pending === 0n) return;
  const g = await a.getGuess(pending);
  const hs = g.bigH === ZERO32 ? [g.okH] : [g.okH, g.bigH];
  const dec = await publicDecrypt(ctx.read, hs, (s) => st(`Finalizing an earlier PIN check… ${s} s`));
  await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("finalizeGuess", [pending, dec.cleartexts, dec.proof]) }, st);
}

export async function sendWithPin(ctx: Ctx, account: string, to: string, amountWei: bigint, pin: string, cb: StepCb): Promise<string> {
  const owner = ctx.w.address;
  const step = async <T>(i: number, go: (st: Status) => Promise<T>): Promise<T> => {
    cb(i, "run");
    try {
      const r = await go((t, h) => cb(i, "run", t, h));
      return r;
    } catch (e: any) {
      cb(i, "fail", e?.message ?? String(e));
      throw e;
    }
  };

  // Argon2id runs while the open transaction confirms
  const fpP = pinFingerprint(pin, CHAIN_ID, account);

  const opened = await step(0, async (st) => {
    await finalizePending(ctx, account, st);
    const r = await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("requestTransfer", [ETH, to, amountWei, true]) }, st);
    const ev = eventOf(r, account, "OpOpened");
    cb(0, "done", undefined, r.hash);
    return { opId: BigInt(ev.args.opId), c: BigInt(ev.args.challenge) };
  });

  const enc = await step(1, async (st) => {
    st("Deriving the fingerprint (Argon2id)…");
    const fp = await fpP;
    st("Encrypting…");
    const e = await encrypt(ctx.read, [{ type: "euint64", value: guessValue(fp, opened.c) }], account, owner);
    cb(1, "done");
    return e;
  });

  const handles = await step(2, async (st) => {
    const r = await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("submitGuess", [opened.opId, opened.c, enc.handles[0], enc.inputProof]) }, st);
    const ev = eventOf(r, account, "GuessSubmitted");
    cb(2, "done", undefined, r.hash);
    return ev.args.bigHandle === ZERO32 ? [String(ev.args.okHandle)] : [String(ev.args.okHandle), String(ev.args.bigHandle)];
  });

  const dec = await step(3, async (st) => {
    const d = await publicDecrypt(ctx.read, handles, (s) => st(`Waiting for the threshold network… ${s} s`));
    cb(3, "done", asBool(d.clear[0]) ? "Result: correct PIN" : "Result: wrong PIN");
    return d;
  });

  const fin = await step(4, async (st) => {
    const r = await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("finalizeGuess", [opened.opId, dec.cleartexts, dec.proof]) }, st);
    const ev = eventOf(r, account, "GuessFinalized");
    cb(4, "done", undefined, r.hash);
    return { ok: Boolean(ev.args.ok), readyAt: Number(ev.args.readyAt) };
  });

  if (!fin.ok) {
    const ts = await acct(account, ctx.read).trackState(TRACK_OWNER);
    cb(5, "skip", "Not sent: wrong PIN");
    throw new WrongPin(Number(ts[1]), Number(ts[0]));
  }

  return await step(5, async (st) => {
    for (;;) {
      const now = (await ctx.read.getBlock("latest"))?.timestamp ?? 0;
      if (now >= fin.readyAt) break;
      st(`Waiting period: ${fin.readyAt - now} s`);
      await sleep(4000);
    }
    const r = await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("executeOp", [opened.opId]) }, st);
    eventOf(r, account, "OpExecuted");
    cb(5, "done", undefined, r.hash);
    return r.hash;
  });
}

// ───────────────────────────── a generic call with the PIN ─────────────────────────────

export const CALL_STEPS = [
  "Open the operation",
  "Encrypt your PIN guess",
  "Submit the encrypted guess",
  "Zama decrypts only the yes/no result",
  "Record the result on-chain",
  "Wait out the delay and run it",
] as const;

/**
 * A call from the account to another contract (`openCall`): the PIN, then the generic-call delay, then `executeOp`.
 * The will's owner functions are reached this way only, so the key alone never touches a will.
 */
export async function callWithPin(ctx: Ctx, account: string, target: string, data: string, pin: string, cb: StepCb): Promise<string> {
  const owner = ctx.w.address;
  const step = async <T>(i: number, go: (st: Status) => Promise<T>): Promise<T> => {
    cb(i, "run");
    try {
      return await go((t, h) => cb(i, "run", t, h));
    } catch (e: any) {
      cb(i, "fail", e?.message ?? String(e));
      throw e;
    }
  };
  const fpP = pinFingerprint(pin, CHAIN_ID, account);

  const opened = await step(0, async (st) => {
    await finalizePending(ctx, account, st);
    const r = await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("openCall", [target, 0, data]) }, st);
    const ev = eventOf(r, account, "OpOpened");
    cb(0, "done", undefined, r.hash);
    return { opId: BigInt(ev.args.opId), c: BigInt(ev.args.challenge) };
  });
  const enc = await step(1, async (st) => {
    st("Deriving the fingerprint (Argon2id)…");
    const fp = await fpP;
    st("Encrypting…");
    const e = await encrypt(ctx.read, [{ type: "euint64", value: guessValue(fp, opened.c) }], account, owner);
    cb(1, "done");
    return e;
  });
  const handles = await step(2, async (st) => {
    const r = await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("submitGuess", [opened.opId, opened.c, enc.handles[0], enc.inputProof]) }, st);
    const ev = eventOf(r, account, "GuessSubmitted");
    cb(2, "done", undefined, r.hash);
    return ev.args.bigHandle === ZERO32 ? [String(ev.args.okHandle)] : [String(ev.args.okHandle), String(ev.args.bigHandle)];
  });
  const dec = await step(3, async (st) => {
    const d = await publicDecrypt(ctx.read, handles, (s) => st(`Waiting for the threshold network… ${s} s`));
    cb(3, "done", asBool(d.clear[0]) ? "Result: correct PIN" : "Result: wrong PIN");
    return d;
  });
  const fin = await step(4, async (st) => {
    const r = await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("finalizeGuess", [opened.opId, dec.cleartexts, dec.proof]) }, st);
    const ev = eventOf(r, account, "GuessFinalized");
    cb(4, "done", undefined, r.hash);
    return { ok: Boolean(ev.args.ok), readyAt: Number(ev.args.readyAt) };
  });
  if (!fin.ok) {
    const ts = await acct(account, ctx.read).trackState(TRACK_OWNER);
    cb(5, "skip", "Not run: wrong PIN");
    throw new WrongPin(Number(ts[1]), Number(ts[0]));
  }
  return await step(5, async (st) => {
    for (;;) {
      const now = (await ctx.read.getBlock("latest"))?.timestamp ?? 0;
      if (now >= fin.readyAt) break;
      st(`Waiting period: ${fin.readyAt - now} s`);
      await sleep(4000);
    }
    const r = await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("executeOp", [opened.opId]) }, st);
    eventOf(r, account, "OpExecuted");
    cb(5, "done", undefined, r.hash);
    return r.hash;
  });
}

export async function deposit(ctx: Ctx, account: string, wei: bigint, st: Status): Promise<string> {
  const r = await sendTx(ctx.w, ctx.read, { to: account, value: wei }, st);
  return r.hash;
}
