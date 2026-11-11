/**
 * Hidden inheritance in the demo: a will (contracts/inheritance/EncryptedWill.sol) next to the Encrypted Account.
 * - The owner creates it and sets up to four heirs through the account's PIN path. A heir is named by a claim code
 *   (default: a random 128-bit secret shown once, for a printed heir card) or by an address.
 * - Proof of life is the account's last correct PIN ("I'm here" is the cheapest PIN operation). After an absence
 *   anyone may start and then settle the will; then anyone runs the payout round.
 * - Anyone may claim to any address: heirs receive their encrypted share, everyone else an encrypted zero. A code
 *   claim is bound to its recipient, so whoever relays it cannot redirect it.
 */
import { ethers } from "ethers";
import { CTOKEN_ABI, WILL_ABI, WILL_FACTORY_ABI } from "./abi";
import { callWithPin, type Ctx, type StepCb } from "./account";
import { CHAIN_ID, DEMO_WILL, WILL_FACTORY, WILL_SLOTS, WILL_TOKEN } from "./chain";
import { encrypt } from "./fhe";
import { Status, sendTx } from "./tx";

const WIFACE = new ethers.Interface(WILL_ABI as any);
const FIFACE = new ethers.Interface(WILL_FACTORY_ABI as any);
const TIFACE = new ethers.Interface(CTOKEN_ABI as any);
const ACCOUNT_VIEW = [
  "function escapeState() view returns (address escape_, address escapeTo, uint64 readyAt, uint64 verifiedAt, uint32 nonce, uint32 escEpoch, uint32 rotationsPending)",
  "function delays() view returns (tuple(uint32 pinTransfer, uint32 bigTransfer, uint32 genericCall, uint32 settings, uint32 loosen, uint32 knownAdd, uint32 recovery, uint32 recoveryNoDevice, uint32 pinReset, uint32 escape, uint32 escapeChange))",
];
const will = (addr: string, runner: ethers.ContractRunner) => new ethers.Contract(addr, WILL_ABI as any, runner);

/** How many slots one snapshot call computes: about 2.1M HCU each, within half of the 20M per-transaction limit. */
export const SNAPSHOT_GROUP = 4;

export type HeirRow = { mode: "code" | "address"; address: string; percent: number };
export type NewHeir = { slot: number; mode: "code" | "address"; address?: string; code?: bigint; percent: number };

/** phase: 0 no heirs · 1 owner active · 2 startable · 3 started, grace running · 4 settleable · 5 settled */
export type WillView = {
  address: string;
  exists: boolean;
  account: string;
  phase: number;
  heirsSet: boolean;
  settled: boolean;
  pinAt: number;
  startableAt: number;
  settleableAt: number;
  sweepableAt: number;
  inactivity: number;
  grace: number;
  claimWindow: number;
  balanceKnown: boolean;
  round: number;
  preparing: boolean;
  swept: boolean;
  escapeRunning: boolean;
  /** an escape started while the owner was provably alive: anyone may move the will to the escape snapshot */
  escapeAlive: boolean;
};

export const PHASE_TEXT = [
  "No heirs yet",
  "Waiting: the owner is active",
  "The owner has been away: anyone can start it",
  "Started: the owner can still cancel it with a PIN",
  "Ready to settle",
  "Settled: heirs can claim",
] as const;

// ───────────────────────────── claim codes ─────────────────────────────

export function newCode(): bigint {
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    const v = BigInt(ethers.hexlify(b));
    if (v !== 0n) return v;
  }
}

/** 32 hex digits in 8 groups: "3f9a-01c2-…". */
export function formatCode(c: bigint): string {
  return c.toString(16).padStart(32, "0").match(/.{4}/g)!.join("-");
}

export function parseCode(s: string): bigint | null {
  const hex = s.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 32) return null;
  const v = BigInt("0x" + hex);
  return v === 0n ? null : v;
}

/** h = the first 128 bits of keccak256(abi.encode(will, chainId, recipient)), as EncryptedWill.codeMask. */
export function codeMask(willAddr: string, recipient: string): bigint {
  const enc = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "address"], [willAddr, CHAIN_ID, recipient]);
  return BigInt(ethers.dataSlice(ethers.keccak256(enc), 0, 16));
}

// ───────────────────────────── reading ─────────────────────────────

export async function predictWill(read: ethers.Provider, account: string): Promise<string> {
  const f = new ethers.Contract(WILL_FACTORY, WILL_FACTORY_ABI as any, read);
  return String(await f.predictWill(account, DEMO_WILL.inactivity, DEMO_WILL.grace, DEMO_WILL.claimWindow));
}

export async function readWill(read: ethers.Provider, address: string): Promise<WillView> {
  const base: WillView = {
    address,
    exists: false,
    account: ethers.ZeroAddress,
    phase: 0,
    heirsSet: false,
    settled: false,
    pinAt: 0,
    startableAt: 0,
    settleableAt: 0,
    sweepableAt: 0,
    inactivity: DEMO_WILL.inactivity,
    grace: DEMO_WILL.grace,
    claimWindow: DEMO_WILL.claimWindow,
    balanceKnown: false,
    round: 0,
    preparing: false,
    swept: false,
    escapeRunning: false,
    escapeAlive: false,
  };
  if ((await read.getCode(address)) === "0x") return base;
  const w = will(address, read);
  const [account, st, heirsSet, settled, inactivity, grace, claimWindow, ts, bal] = await Promise.all([
    w.account(),
    w.state(),
    w.heirsSet(),
    w.settled(),
    w.inactivity(),
    w.grace(),
    w.claimWindow(),
    w.tokenState(WILL_TOKEN),
    new ethers.Contract(WILL_TOKEN, CTOKEN_ABI as any, read).confidentialBalanceOf(address),
  ]);
  const acct = new ethers.Contract(String(account), ACCOUNT_VIEW, read);
  const [es, delays] = await Promise.all([acct.escapeState(), acct.delays()]);
  const readyAt = Number(es.readyAt);
  const v: WillView = {
    ...base,
    exists: true,
    account: String(account),
    phase: Number(st[0]),
    pinAt: Number(st[1]),
    startableAt: Number(st[2]),
    settleableAt: Number(st[3]),
    sweepableAt: Number(st[4]),
    heirsSet: Boolean(heirsSet),
    settled: Boolean(settled),
    inactivity: Number(inactivity),
    grace: Number(grace),
    claimWindow: Number(claimWindow),
    round: Number(ts[0]),
    preparing: Boolean(ts[2]),
    swept: Boolean(ts[3]),
    balanceKnown: String(bal) !== ethers.ZeroHash,
    escapeRunning: readyAt !== 0,
  };
  v.escapeAlive = v.escapeRunning && !v.settled && readyAt - Number(delays.escape) < v.pinAt + v.inactivity;
  return v;
}

// ───────────────────────────── the owner ─────────────────────────────

export async function createWill(ctx: Ctx, account: string, st: Status): Promise<string> {
  const addr = await predictWill(ctx.read, account);
  if ((await ctx.read.getCode(addr)) !== "0x") return addr;
  const data = FIFACE.encodeFunctionData("createWill", [account, DEMO_WILL.inactivity, DEMO_WILL.grace, DEMO_WILL.claimWindow]);
  await sendTx(ctx.w, ctx.read, { to: WILL_FACTORY, data }, st);
  return addr;
}

/**
 * Generates a claim code for each code-mode heir, encrypts the four slots (addresses, codes, basis points) for
 * (will, account) and runs setHeirs through the PIN path. The codes are returned to be shown once; they never leave
 * this page in clear.
 */
export async function setHeirsWithPin(
  ctx: Ctx,
  account: string,
  willAddr: string,
  rows: HeirRow[],
  pin: string,
  cb: StepCb,
): Promise<{ hash: string; heirs: NewHeir[] }> {
  const used = rows.filter((r) => r.percent > 0 && (r.mode === "code" || ethers.isAddress(r.address))).slice(0, WILL_SLOTS);
  const heirs: NewHeir[] = used.map((r, slot) =>
    r.mode === "code" ? { slot, mode: "code", code: newCode(), percent: r.percent } : { slot, mode: "address", address: ethers.getAddress(r.address), percent: r.percent },
  );
  const addrs = Array.from({ length: WILL_SLOTS }, (_, i) => heirs[i]?.address ?? ethers.ZeroAddress);
  const codes = Array.from({ length: WILL_SLOTS }, (_, i) => heirs[i]?.code ?? 0n);
  const bps = Array.from({ length: WILL_SLOTS }, (_, i) => (heirs[i] ? Math.round(heirs[i].percent * 100) : 0));
  cb(0, "run", "Encrypting the heirs, their codes and their shares…");
  const enc = await encrypt(
    ctx.read,
    [
      ...addrs.map((a) => ({ type: "eaddress" as const, value: a })),
      ...codes.map((c) => ({ type: "euint128" as const, value: c })),
      ...bps.map((v) => ({ type: "euint16" as const, value: v })),
    ],
    willAddr,
    account, // the account calls the will, so the input proof is bound to it
  );
  const h = enc.handles;
  const data = WIFACE.encodeFunctionData("setHeirs", [h.slice(0, 4), h.slice(4, 8), h.slice(8, 12), enc.inputProof]);
  const hash = await callWithPin(ctx, account, willAddr, data, pin, cb);
  return { hash, heirs };
}

/** Mints worthless test tokens straight into the will (anyone may mint the test token). */
export async function fundWill(ctx: Ctx, willAddr: string, amount: bigint, st: Status): Promise<string> {
  return (await sendTx(ctx.w, ctx.read, { to: WILL_TOKEN, data: TIFACE.encodeFunctionData("mint", [willAddr, amount]) }, st)).hash;
}

// ───────────────────────────── anyone ─────────────────────────────

export async function startWill(ctx: Ctx, willAddr: string, st: Status): Promise<string> {
  return (await sendTx(ctx.w, ctx.read, { to: willAddr, data: WIFACE.encodeFunctionData("start", []) }, st)).hash;
}

export async function settleWill(ctx: Ctx, willAddr: string, st: Status): Promise<string> {
  return (await sendTx(ctx.w, ctx.read, { to: willAddr, data: WIFACE.encodeFunctionData("settle", []) }, st)).hash;
}

/** Runs the test token's payout round: prepare (unless one is open), then the slots not yet computed. */
export async function runPayoutRound(ctx: Ctx, willAddr: string, st: Status): Promise<void> {
  const w = will(willAddr, ctx.read);
  const ts = await w.tokenState(WILL_TOKEN);
  let computed = Number(ts[1]);
  if (!ts[2]) {
    st("Opening the payout round…");
    await sendTx(ctx.w, ctx.read, { to: willAddr, data: WIFACE.encodeFunctionData("prepare", [WILL_TOKEN]) }, st);
    // A new round has no slot computed. Not read back: a lagging RPC backend may still return the previous round,
    // whose slots are all computed, and the snapshot would be skipped.
    computed = 0;
  }
  for (let from = 0; from < WILL_SLOTS; from += SNAPSHOT_GROUP) {
    const to = Math.min(WILL_SLOTS, from + SNAPSHOT_GROUP);
    let need = false;
    for (let i = from; i < to; i++) if ((computed & (1 << i)) === 0) need = true;
    if (!need) continue;
    st(`Computing every heir's amount (slots ${from + 1}–${to})…`);
    await sendTx(ctx.w, ctx.read, { to: willAddr, data: WIFACE.encodeFunctionData("snapshot", [WILL_TOKEN, from, to]) }, st);
  }
}

/**
 * Claims the test token to `recipient`. With a code, the input is code ⊕ codeMask(recipient); without one (an
 * address-mode heir, or a stranger) a random value: the transaction looks the same either way.
 */
export async function claimWill(ctx: Ctx, willAddr: string, recipient: string, code: bigint | null, st: Status): Promise<string> {
  st("Encrypting the claim…");
  const value = (code ?? newCode()) ^ codeMask(willAddr, recipient);
  const enc = await encrypt(ctx.read, [{ type: "euint128", value }], willAddr, ctx.w.address);
  const data = WIFACE.encodeFunctionData("claim", [WILL_TOKEN, recipient, enc.handles[0], enc.inputProof]);
  return (await sendTx(ctx.w, ctx.read, { to: willAddr, data }, st)).hash;
}

export async function escapeWithdrawWill(ctx: Ctx, willAddr: string, st: Status): Promise<string> {
  return (await sendTx(ctx.w, ctx.read, { to: willAddr, data: WIFACE.encodeFunctionData("escapeWithdraw", [WILL_TOKEN]) }, st)).hash;
}

export async function sweepWill(ctx: Ctx, willAddr: string, st: Status): Promise<string> {
  return (await sendTx(ctx.w, ctx.read, { to: willAddr, data: WIFACE.encodeFunctionData("sweepResidual", [WILL_TOKEN]) }, st)).hash;
}

// ───────────────────────────── balances ─────────────────────────────

/** The address's encrypted test-token balance handle (zero hash if it never held any). */
export async function tokenBalanceHandle(read: ethers.Provider, who: string): Promise<string> {
  return String(await new ethers.Contract(WILL_TOKEN, CTOKEN_ABI as any, read).confidentialBalanceOf(who));
}

/**
 * Decrypts the connected wallet's own balance: the decryption code (Zama's KMS client, about 1 MB) is a separate file
 * loaded only here. The wallet signs an EIP-712 permit; the relayer returns the value encrypted to a key that exists
 * only in this page.
 */
export async function decryptMyBalance(ctx: Ctx, onStatus: (t: string) => void, stale?: string): Promise<bigint> {
  // Right after a claim, a load-balanced RPC backend may not have its block yet and answer with the empty handle, or
  // with the handle from before the claim (`stale`; every transfer makes a new one): read again a few times first.
  let h = ethers.ZeroHash;
  for (let i = 0; i < 8 && (h === ethers.ZeroHash || h === stale); i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000));
    h = await tokenBalanceHandle(ctx.read, ctx.w.address);
  }
  if (h === ethers.ZeroHash) return 0n;
  onStatus("Loading the decryption code…");
  const url = (window as any).__EA_DECRYPT_URL as string | undefined;
  if (!url) throw new Error("The decryption module is not available in this build.");
  const mod: any = await import(/* @vite-ignore */ url);
  onStatus("Sign the decryption permit in your wallet…");
  return BigInt(await mod.userDecrypt(ctx.read, ctx.w.signer, ctx.w.address, h, WILL_TOKEN, onStatus));
}

export const willUrl = (willAddr: string) => `${location.origin}/app?will=${willAddr}`;
/** The heir card's link: the code travels in the fragment, which browsers never send to the server. */
export const heirCardUrl = (willAddr: string, code: bigint) => `${location.origin}/app?will=${willAddr}#code=${formatCode(code)}`;
