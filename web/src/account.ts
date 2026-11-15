/**
 * Account flows of the demo: create + set up an Encrypted Account (8 transactions, 9 with a raised PIN-try bond), and
 * send ETH with the PIN (open → encrypted guess → public decryption of the result bit → finalize → execute).
 * Same sequence as the Sepolia measurement scripts (scripts/sepolia/f09-lib.ts, f09-run.ts).
 *
 * F0.16: a PIN try on the key track carries a bond from the owner's wallet (msg.value of a direct call; refunded with
 * claimRefund when the PIN is right, kept by the account when it is wrong), and a PIN-verified transfer pays a small
 * fee on top of the amount, bound when the transfer opens. Accounts deployed before F0.16 have neither: every read
 * here falls back to "no bond, no fee" for them.
 */
import { ethers } from "ethers";
import { ACCOUNT_ABI, FACTORY_ABI } from "./abi";
import { CHAIN_ID, DEMO_DELAYS, ETH, ETH_UNIT, FACTORY, FEE_CONFIG, LEGACY_FACTORIES, LOGS_FROM_BLOCK, LOG_RPC_URLS, N_RECIPIENTS, N_SPENDERS, TRACK_OWNER, ZERO32 } from "./chain";
import { asBool, encrypt, publicDecrypt } from "./fhe";
import { guessValue, pinFingerprint, randomUint64 } from "./pin";
import { BASE_BOND } from "../../sdk/src/bondFee";
import { Status, sendTx } from "./tx";
import type { Wallet } from "./wallet";

export type Ctx = { w: Wallet; read: ethers.JsonRpcProvider };

const IFACE = new ethers.Interface(ACCOUNT_ABI as any);
const FIFACE = new ethers.Interface(FACTORY_ABI as any);
const acct = (addr: string, runner: ethers.ContractRunner) => new ethers.Contract(addr, ACCOUNT_ABI as any, runner);
const factory = (runner: ethers.ContractRunner) => new ethers.Contract(FACTORY, FACTORY_ABI as any, runner);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FEE_ABI = ["function quote(address asset, uint256 amount) view returns (uint256 fee, uint64 version)"];
const UINT96_MAX = (1n << 96n) - 1n;

/** A call the contract does not have (an account deployed before F0.16) reverts without data. */
const missingFunction = (e: any) => e?.code === "CALL_EXCEPTION" || e?.code === "BAD_DATA";

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
export async function getLogsChunked(read: ethers.JsonRpcProvider, filter: { address: string | string[]; topics?: (string | null)[] }, fromBlock: number, toBlock: number, step = 45_000): Promise<ethers.Log[]> {
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
  // the current factory and the pre-F0.16 one (same event): older demo accounts stay reachable
  const logs = await getLogsChunked(read, { address: [FACTORY, ...LEGACY_FACTORIES], topics }, LOGS_FROM_BLOCK, await read.getBlockNumber());
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
  const logs = await getLogsChunked(read, { address }, LOGS_FROM_BLOCK, latest);
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

export type OwnerBond = { required: bigint; base: bigint };

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
  /** F0.16: the bond the next key-track PIN try needs (null: an account from before F0.16, no bond). */
  bond: OwnerBond | null;
  /** F0.16: bonds of correct PIN tries waiting for claimRefund (paid to the wallet that posted them). */
  refund: bigint;
};

/** F0.16: the bond the next key-track PIN try needs and the account's base bond; null on an account without bonds. */
export async function readOwnerBond(read: ethers.JsonRpcProvider, address: string): Promise<OwnerBond | null> {
  try {
    const r = await acct(address, read).ownerBond();
    return { required: BigInt(r[0]), base: BigInt(r[1]) };
  } catch (e) {
    if (missingFunction(e)) return null;
    throw e;
  }
}

/** F0.16: bonds waiting for claimRefund for `payer` (0 on an account from before F0.16). */
export async function readRefund(read: ethers.JsonRpcProvider, address: string, payer: string): Promise<bigint> {
  try {
    return BigInt(await acct(address, read).refundOf(payer));
  } catch (e) {
    if (missingFunction(e)) return 0n;
    throw e;
  }
}

/**
 * F0.16: the fee a PIN-verified transfer of `amount` would pay now (the account binds it when the transfer opens).
 * 0 without a fee module; null if it cannot be read (the account then binds 0 as well when the module is down).
 */
export async function quoteFee(read: ethers.JsonRpcProvider, address: string, asset: string, amount: bigint): Promise<bigint | null> {
  try {
    const fc = String(await acct(address, read).feeConfig());
    if (fc === ethers.ZeroAddress) return 0n;
    const r = await new ethers.Contract(fc, FEE_ABI, read).quote(asset, amount);
    const fee = BigInt(r[0]);
    return fee > UINT96_MAX ? 0n : fee;
  } catch (e) {
    return missingFunction(e) ? 0n : null;
  }
}

/** F0.16: the current ETH fee row of the shared FeeConfig (for the setup review); null if it cannot be read. */
export async function readEthFee(read: ethers.JsonRpcProvider): Promise<{ bps: number; minFee: bigint; maxFee: bigint } | null> {
  try {
    const r = await new ethers.Contract(FEE_CONFIG, ["function feeOf(address) view returns (uint16 bps, uint96 minFee, uint96 maxFee, bool set)"], read).feeOf(ETH);
    return r[3] ? { bps: Number(r[0]), minFee: BigInt(r[1]), maxFee: BigInt(r[2]) } : { bps: 0, minFee: 0n, maxFee: 0n };
  } catch {
    return null;
  }
}

export async function readAccount(read: ethers.JsonRpcProvider, address: string, owner?: string): Promise<AccountView> {
  const [code, balance] = await Promise.all([read.getCode(address), read.getBalance(address)]);
  if (code === "0x") return { address, exists: false, armed: false, balance, restricted: 0, score: 0, nextAllowedAt: 0, pendingOp: 0n, escapeReadyAt: 0, bond: null, refund: 0n };
  const a = acct(address, read);
  const [st, ts, bond, refund] = await Promise.all([a.status(), a.trackState(TRACK_OWNER), readOwnerBond(read, address), owner ? readRefund(read, address, owner) : Promise.resolve(0n)]);
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
    bond,
    refund,
  };
}

// ───────────────────────────── creation and setup ─────────────────────────────

export type Plan = { account: string; escape: string; salt: string; limitUnits: string; known: string | null; bondBase?: string };
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
  "Set the PIN-try bond",
  "Turn the account on",
] as const;

export type StepCb = (i: number, state: "run" | "done" | "skip" | "fail", text?: string, hash?: string) => void;

/**
 * Creates and sets up the account. Resumable: every step is checked on-chain first, so a reload continues where it
 * stopped (the PIN is asked again; it is never stored).
 */
export async function createAndSetup(
  ctx: Ctx,
  opts: { pin: string; limitEth: string; known: string | null; escapeWallet: ethers.HDNodeWallet | ethers.Wallet; bondBase?: bigint },
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
  }
  plan.bondBase = (opts.bondBase ?? BASE_BOND).toString(); // the latest choice wins until the account is armed
  savePlan(owner, plan);
  const A = plan.account;
  const a = acct(A, ctx.read);
  // Right after a transaction, a load-balanced RPC backend can lag a block behind and answer a call to the just-created
  // account with empty data ("could not decode result data"): read again before treating it as an error.
  const check = async (done: () => Promise<boolean>): Promise<boolean> => {
    for (let n = 1; ; n++) {
      try {
        return await done();
      } catch (e: any) {
        if (n >= 6 || !(e?.code === "BAD_DATA" || /could not decode result data/i.test(String(e?.message ?? "")))) throw e;
        await sleep(2000);
      }
    }
  };
  const run = async (i: number, done: () => Promise<boolean>, go: (st: Status) => Promise<ethers.TransactionReceipt>) => {
    if (await check(done)) return cb(i, "skip");
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

  // 8. F0.16: the base bond of key-track PIN tries (skipped at the default, which needs no transaction)
  const bondBase = BigInt(plan.bondBase ?? BASE_BOND.toString());
  await run(
    7,
    async () => {
      if (Boolean((await a.status())[0])) return true; // armed: fixed from now on (a PIN-verified admin op changes it)
      const b = await readOwnerBond(ctx.read, A);
      return b === null || b.base === bondBase;
    },
    async (st) => sendTx(ctx.w, ctx.read, { to: A, data: IFACE.encodeFunctionData("setupOwnerBond", [bondBase]) }, st),
  );

  // 9. arm
  await run(
    8,
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
  "Submit the encrypted guess with its bond",
  "Zama decrypts only the yes/no result",
  "Record the result on-chain",
  "Send the ETH",
] as const;

export class WrongPin extends Error {
  constructor(public nextAllowedAt: number, public score: number) {
    super("Wrong PIN");
  }
}

/** F0.16: the bond went up after it was shown (another try was counted meanwhile); nothing was submitted. */
export class BondRaised extends Error {
  constructor(public required: bigint) {
    super(`The bond for this PIN try went up to ${ethers.formatEther(required)} ETH (another try was counted meanwhile). Nothing was submitted; check the amount and try again.`);
  }
}

/**
 * F0.16: the key-track guess, sent directly from the owner's wallet with the bond as msg.value (the account never pays
 * it, and a UserOp cannot carry it). The bond is read again right before sending: if it is above what the user was
 * shown (`bondShown`), stop instead of sending more.
 */
async function submitGuessTx(ctx: Ctx, account: string, opId: bigint, c: bigint, enc: { handles: string[]; inputProof: string }, bondShown: bigint | undefined, st: Status) {
  const b = await readOwnerBond(ctx.read, account);
  const value = b ? b.required : 0n;
  if (bondShown !== undefined && value > bondShown) throw new BondRaised(value);
  return sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("submitGuess", [opId, c, enc.handles[0], enc.inputProof]), value }, st);
}

/** F0.16: the fee bound to an open transfer (0 on an account from before F0.16). */
export async function boundFee(read: ethers.JsonRpcProvider, account: string, opId: bigint): Promise<bigint> {
  try {
    return BigInt((await acct(account, read).getOp(opId)).fee ?? 0n);
  } catch {
    return 0n;
  }
}

/**
 * F0.16: pulls the bonds of correct PIN tries back to the wallet that posted them. Right after a correct PIN the gas
 * estimate can come from a backend that does not see the refund yet (the cheap "nothing to pay" path), so the gas limit
 * has a floor that covers the ETH transfer (47,594 gas on Sepolia in the F0.16 run).
 */
export async function claimRefund(ctx: Ctx, account: string, st: Status): Promise<string> {
  const r = await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("claimRefund", []), gasLimit: 120_000n }, st);
  return r.hash;
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

export async function sendWithPin(ctx: Ctx, account: string, to: string, amountWei: bigint, pin: string, cb: StepCb, bondShown?: bigint): Promise<string> {
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
    const opId = BigInt(ev.args.opId);
    const fee = await boundFee(ctx.read, account, opId);
    cb(0, "done", fee > 0n ? `Fee bound to this transfer: ${ethers.formatEther(fee)} ETH` : undefined, r.hash);
    return { opId, c: BigInt(ev.args.challenge) };
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
    const r = await submitGuessTx(ctx, account, opened.opId, opened.c, enc, bondShown, st);
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

/** "I'm here": the first five steps only; the no-op call is never run. */
export const ALIVE_STEPS = CALL_STEPS.slice(0, 5);

type Step = <T>(i: number, go: (st: Status) => Promise<T>) => Promise<T>;

function stepper(cb: StepCb): Step {
  return async (i, go) => {
    cb(i, "run");
    try {
      return await go((t, h) => cb(i, "run", t, h));
    } catch (e: any) {
      cb(i, "fail", e?.message ?? String(e));
      throw e;
    }
  };
}

/** Opens a generic call and verifies the PIN for it (steps 0–4). A correct PIN updates the account's lastPinAt. */
async function openCallWithPin(ctx: Ctx, account: string, target: string, data: string, pin: string, cb: StepCb, step: Step, bondShown?: bigint) {
  return verifyWithPin(ctx, account, (st) => sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("openCall", [target, 0, data]) }, st), pin, cb, step, bondShown);
}

/** Opens an op with `open` and verifies the PIN for it (steps 0–4): encrypted guess with the bond, decryption, finalize. */
async function verifyWithPin(ctx: Ctx, account: string, open: (st: Status) => Promise<ethers.TransactionReceipt>, pin: string, cb: StepCb, step: Step, bondShown?: bigint) {
  const owner = ctx.w.address;
  const fpP = pinFingerprint(pin, CHAIN_ID, account);
  const opened = await step(0, async (st) => {
    await finalizePending(ctx, account, st);
    const r = await open(st);
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
    const r = await submitGuessTx(ctx, account, opened.opId, opened.c, enc, bondShown, st);
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
    return { ok: Boolean(ev.args.ok), readyAt: Number(ev.args.readyAt), hash: r.hash };
  });
  if (!fin.ok) {
    const ts = await acct(account, ctx.read).trackState(TRACK_OWNER);
    throw new WrongPin(Number(ts[1]), Number(ts[0]));
  }
  return { opId: opened.opId, readyAt: fin.readyAt, hash: fin.hash };
}

/**
 * A call from the account to another contract (`openCall`): the PIN, then the generic-call delay, then `executeOp`.
 * The will's owner functions are reached this way only, so the key alone never touches a will.
 */
export async function callWithPin(ctx: Ctx, account: string, target: string, data: string, pin: string, cb: StepCb, bondShown?: bigint): Promise<string> {
  const step = stepper(cb);
  let op: { opId: bigint; readyAt: number };
  try {
    op = await openCallWithPin(ctx, account, target, data, pin, cb, step, bondShown);
  } catch (e) {
    if (e instanceof WrongPin) cb(5, "skip", "Not run: wrong PIN");
    throw e;
  }
  return await step(5, async (st) => {
    for (;;) {
      const now = (await ctx.read.getBlock("latest"))?.timestamp ?? 0;
      if (now >= op.readyAt) break;
      st(`Waiting period: ${op.readyAt - now} s`);
      await sleep(4000);
    }
    const r = await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("executeOp", [op.opId]) }, st);
    eventOf(r, account, "OpExecuted");
    cb(5, "done", undefined, r.hash);
    return r.hash;
  });
}

/**
 * "I'm here": the cheapest PIN operation on the account, with no account change. It opens a call with no data to
 * the owner's own wallet and verifies the PIN; the correct PIN updates lastPinAt, which is what a will reads as
 * proof of life. The call itself is never run.
 */
export async function proveAliveWithPin(ctx: Ctx, account: string, pin: string, cb: StepCb, bondShown?: bigint): Promise<string> {
  const op = await openCallWithPin(ctx, account, ctx.w.address, "0x", pin, cb, stepper(cb), bondShown);
  return op.hash;
}

// ───────────────────────────── changing the PIN ─────────────────────────────

export const PIN_CHANGE_STEPS = [
  "Open the PIN change (the new PIN goes encrypted)",
  "Encrypt your current PIN guess",
  "Submit the encrypted guess with its bond",
  "Zama decrypts only the yes/no result",
  "Record the result on-chain",
  "Wait the delay, then switch to the new PIN",
] as const;

/**
 * PIN change (K + the current PIN): the new fingerprint is encrypted and stored with the op, the current PIN verifies
 * it, and after the settings delay executeOp switches to the new PIN. The old PIN stays valid until then (I15); the
 * wrong-guess score is kept (K43).
 */
export async function changePinWithPin(ctx: Ctx, account: string, currentPin: string, newPin: string, cb: StepCb, bondShown?: bigint): Promise<string> {
  const step = stepper(cb);
  const open = async (st: Status) => {
    st("Deriving the new fingerprint (Argon2id)…");
    const fp = await pinFingerprint(newPin, CHAIN_ID, account);
    st("Encrypting…");
    const enc = await encrypt(ctx.read, [{ type: "euint64", value: fp }], account, ctx.w.address);
    return sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("openPinChange", [enc.handles[0], enc.inputProof]) }, st);
  };
  let op: { opId: bigint; readyAt: number };
  try {
    op = await verifyWithPin(ctx, account, open, currentPin, cb, step, bondShown);
  } catch (e) {
    if (e instanceof WrongPin) cb(5, "skip", "Not changed: wrong PIN");
    throw e;
  }
  return await step(5, async (st) => {
    for (;;) {
      const now = (await ctx.read.getBlock("latest"))?.timestamp ?? 0;
      if (now >= op.readyAt) break;
      st(`Waiting period: ${op.readyAt - now} s`);
      await sleep(4000);
    }
    const r = await sendTx(ctx.w, ctx.read, { to: account, data: IFACE.encodeFunctionData("executeOp", [op.opId]) }, st);
    eventOf(r, account, "OpExecuted");
    cb(5, "done", undefined, r.hash);
    return r.hash;
  });
}

export async function deposit(ctx: Ctx, account: string, wei: bigint, st: Status): Promise<string> {
  const r = await sendTx(ctx.w, ctx.read, { to: account, value: wei }, st);
  return r.hash;
}
