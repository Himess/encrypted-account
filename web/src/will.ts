/**
 * Hidden inheritance in the demo: a will (contracts/inheritance/EncryptedWill.sol) next to the Encrypted Account.
 * - The owner creates it (one wallet transaction) and sets the heirs through the account's PIN path.
 * - Proof of life is the account's last correct PIN. After an absence anyone may start and then settle it.
 * - After settlement anyone may claim: heirs receive their encrypted share of the test token, everyone else an
 *   encrypted zero, so a claim does not show who inherited.
 */
import { ethers } from "ethers";
import { CTOKEN_ABI, WILL_ABI, WILL_FACTORY_ABI } from "./abi";
import { callWithPin, type Ctx, type StepCb } from "./account";
import { DEMO_WILL, WILL_FACTORY, WILL_SLOTS, WILL_TOKEN } from "./chain";
import { encrypt } from "./fhe";
import { Status, sendTx } from "./tx";

const WIFACE = new ethers.Interface(WILL_ABI as any);
const FIFACE = new ethers.Interface(WILL_FACTORY_ABI as any);
const TIFACE = new ethers.Interface(CTOKEN_ABI as any);
const will = (addr: string, runner: ethers.ContractRunner) => new ethers.Contract(addr, WILL_ABI as any, runner);

export type Heir = { address: string; percent: number };

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
  inactivity: number;
  grace: number;
  balanceKnown: boolean;
};

export const PHASE_TEXT = [
  "No heirs yet",
  "Waiting: the owner is active",
  "The owner has been away: anyone can start it",
  "Started: the owner can still cancel it with a PIN",
  "Ready to settle",
  "Settled: heirs can claim",
] as const;

export async function predictWill(read: ethers.Provider, account: string): Promise<string> {
  return String(await new ethers.Contract(WILL_FACTORY, WILL_FACTORY_ABI as any, read).predictWill(account, DEMO_WILL.inactivity, DEMO_WILL.grace));
}

export async function readWill(read: ethers.Provider, address: string): Promise<WillView> {
  const code = await read.getCode(address);
  const empty: WillView = {
    address,
    exists: false,
    account: ethers.ZeroAddress,
    phase: 0,
    heirsSet: false,
    settled: false,
    pinAt: 0,
    startableAt: 0,
    settleableAt: 0,
    inactivity: DEMO_WILL.inactivity,
    grace: DEMO_WILL.grace,
    balanceKnown: false,
  };
  if (code === "0x") return empty;
  const w = will(address, read);
  const [account, st, heirsSet, settled, inactivity, grace, bal] = await Promise.all([
    w.account(),
    w.state(),
    w.heirsSet(),
    w.settled(),
    w.inactivity(),
    w.grace(),
    new ethers.Contract(WILL_TOKEN, CTOKEN_ABI as any, read).confidentialBalanceOf(address),
  ]);
  return {
    address,
    exists: true,
    account: String(account),
    phase: Number(st[0]),
    pinAt: Number(st[1]),
    startableAt: Number(st[2]),
    settleableAt: Number(st[3]),
    heirsSet: Boolean(heirsSet),
    settled: Boolean(settled),
    inactivity: Number(inactivity),
    grace: Number(grace),
    balanceKnown: String(bal) !== ethers.ZeroHash,
  };
}

export async function createWill(ctx: Ctx, account: string, st: Status): Promise<string> {
  const addr = await predictWill(ctx.read, account);
  if ((await ctx.read.getCode(addr)) !== "0x") return addr;
  await sendTx(ctx.w, ctx.read, { to: WILL_FACTORY, data: FIFACE.encodeFunctionData("createWill", [account, DEMO_WILL.inactivity, DEMO_WILL.grace]) }, st);
  return addr;
}

/** Encrypts the four slots (addresses and basis points) for (will, account) and runs setHeirs through the PIN path. */
export async function setHeirsWithPin(ctx: Ctx, account: string, willAddr: string, heirs: Heir[], pin: string, cb: StepCb): Promise<string> {
  const rows = heirs.filter((h) => h.address && h.percent > 0).slice(0, WILL_SLOTS);
  const addrs = Array.from({ length: WILL_SLOTS }, (_, i) => (rows[i] ? ethers.getAddress(rows[i].address) : ethers.ZeroAddress));
  const bps = Array.from({ length: WILL_SLOTS }, (_, i) => (rows[i] ? Math.round(rows[i].percent * 100) : 0));
  cb(0, "run", "Encrypting the heirs and their shares…");
  const enc = await encrypt(
    ctx.read,
    [...addrs.map((a) => ({ type: "eaddress" as const, value: a })), ...bps.map((v) => ({ type: "euint16" as const, value: v }))],
    willAddr,
    account, // the account calls the will, so the input proof is bound to it
  );
  const data = WIFACE.encodeFunctionData("setHeirs", [enc.handles.slice(0, WILL_SLOTS), enc.handles.slice(WILL_SLOTS), enc.inputProof]);
  return await callWithPin(ctx, account, willAddr, data, pin, cb);
}

/** Mints worthless test tokens straight into the will (anyone may mint the test token). */
export async function fundWill(ctx: Ctx, willAddr: string, amount: bigint, st: Status): Promise<string> {
  const r = await sendTx(ctx.w, ctx.read, { to: WILL_TOKEN, data: TIFACE.encodeFunctionData("mint", [willAddr, amount]) }, st);
  return r.hash;
}

export async function startWill(ctx: Ctx, willAddr: string, st: Status): Promise<string> {
  return (await sendTx(ctx.w, ctx.read, { to: willAddr, data: WIFACE.encodeFunctionData("start", []) }, st)).hash;
}

export async function settleWill(ctx: Ctx, willAddr: string, st: Status): Promise<string> {
  return (await sendTx(ctx.w, ctx.read, { to: willAddr, data: WIFACE.encodeFunctionData("settle", []) }, st)).hash;
}

export async function claimWill(ctx: Ctx, willAddr: string, st: Status): Promise<string> {
  return (await sendTx(ctx.w, ctx.read, { to: willAddr, data: WIFACE.encodeFunctionData("claim", [WILL_TOKEN]) }, st)).hash;
}

/** The caller's encrypted test-token balance handle (zero hash if it never held any). */
export async function tokenBalanceHandle(read: ethers.Provider, who: string): Promise<string> {
  return String(await new ethers.Contract(WILL_TOKEN, CTOKEN_ABI as any, read).confidentialBalanceOf(who));
}

/**
 * Decrypts the caller's own balance: the decryption code (Zama's KMS client, a few MB) is a separate file that is
 * loaded only here. The wallet signs an EIP-712 permit; the relayer returns the value encrypted to a key that exists
 * only in this page.
 */
export async function decryptMyBalance(ctx: Ctx, onStatus: (t: string) => void): Promise<bigint> {
  // Right after a claim, a load-balanced RPC backend may not have its block yet and answer with the empty handle:
  // read again a few times before concluding that there is no balance.
  let h = ethers.ZeroHash;
  for (let i = 0; i < 6 && h === ethers.ZeroHash; i++) {
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
