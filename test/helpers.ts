import { FhevmType } from "@fhevm/hardhat-plugin";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers as E } from "ethers";
import * as hre from "hardhat";
import { guessValue, pinFingerprint, randomUint64 } from "../sdk/src";

export const ethers = hre.ethers;
/** Tests write their evidence files under results/ only when recording (`npm run test:record`). */
export const RECORD = process.env.WRITE_RESULTS === "1";
export { FhevmType, time };

export const ETH = E.ZeroAddress;
export const DAY = 24 * 3600;
export const HOUR = 3600;
/** K43: the wrong-guess score decays by 1 at every multiple of 7 days (fixed calendar since the Unix epoch). */
export const DECAY = 7 * DAY;

/** Moves chain time just past the next decay boundary, so a test's score arithmetic cannot straddle one. */
export async function alignDecay(offsetS = 1): Promise<number> {
  const now = await time.latest();
  const target = (Math.floor(now / DECAY) + 1) * DECAY + offsetS;
  await time.increaseTo(target);
  return target;
}

/** T2 back-off (K46), mirror of PolicyMath.backoff. */
export function backoffT2(n: number): number {
  if (n <= 2) return 0;
  return Math.min(7 * DAY, 15 * 60 * 4 ** (n - 3));
}

// AccountStorage enums / constants (mirrors of Solidity)
export const Kind = { None: 0, Outflow: 1, Call: 2, Admin: 3, Recovery: 4, PinReset: 5 } as const;
export const Status = { None: 0, Evaluating: 1, NeedsPin: 2, Guessing: 3, Delayed: 4, Executed: 5, Cancelled: 6 } as const;
export const A = {
  CANCEL: 1, UNRESTRICT: 2, FREEZE: 3, ROTATE_OWNER: 4, PIN_CHANGE: 5, SET_LIMITS: 6, RESET_TRIP: 7,
  ADD_KNOWN_R: 8, ADD_KNOWN_S: 9, SET_GUARDIAN: 10, SET_DEVICE: 11, SET_HELPER: 12, SET_ESCAPE: 13,
  SET_PULSE: 14, SET_RECOVERY: 15, SET_AUTOKNOWN: 16, APPROVE_HASH: 17, SET_INSTANT: 18, CANCEL_ESCAPE: 19,
  SET_OPEN_LIMIT: 20,
} as const;
export const TRACK = { OWNER: 0, RECOVERY: 1, LANE: 2 } as const;
export const R = { STRIKES: 1, GUARDIAN: 2, OWNER: 4, PIN: 8 } as const;
export const N_RECIPIENTS = 30;
export const N_SPENDERS = 10;

export const coder = E.AbiCoder.defaultAbiCoder();

export interface Stack {
  entryPoint: any;
  paymaster: any;
  factory: any;
  impl: any;
  usdc: any;
  libs: Record<string, string>;
  chainId: bigint;
}

let cachedLibs: Record<string, string> | undefined;

export async function deployStack(): Promise<Stack> {
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const entryPoint: any = await (await ethers.getContractFactory("EntryPoint")).deploy();
  await entryPoint.waitForDeployment();

  const pin = await (await ethers.getContractFactory("PinLib")).deploy();
  const pol = await (await ethers.getContractFactory("PolicyLib")).deploy();
  const open = await (await ethers.getContractFactory("OpenLib")).deploy();
  const ops = await (
    await ethers.getContractFactory("OpsLib", { libraries: { PolicyLib: await pol.getAddress() } })
  ).deploy();
  const libs = {
    PinLib: await pin.getAddress(),
    PolicyLib: await pol.getAddress(),
    OpenLib: await open.getAddress(),
    OpsLib: await ops.getAddress(),
  };
  cachedLibs = libs;
  const Impl = await ethers.getContractFactory("EncryptedAccount", { libraries: libs });
  const impl: any = await Impl.deploy(await entryPoint.getAddress());
  await impl.waitForDeployment();
  const factory: any = await (await ethers.getContractFactory("EncryptedAccountFactory")).deploy(await impl.getAddress());
  await factory.waitForDeployment();

  const paymaster: any = await (await ethers.getContractFactory("TestPaymaster")).deploy(await entryPoint.getAddress());
  await paymaster.waitForDeployment();
  await (await paymaster.deposit({ value: E.parseEther("10") })).wait();

  const usdc: any = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  void deployer;
  return { entryPoint, paymaster, factory, impl, usdc, libs, chainId };
}

export function accountAt(addr: string): Promise<any> {
  if (!cachedLibs) throw new Error("deployStack first");
  return ethers.getContractAt("EncryptedAccount", addr);
}

/** ethers v6 Results are frozen; contract args need plain objects. */
export async function defaultDelays(stack: Stack): Promise<Record<string, bigint>> {
  const r = await stack.factory.defaultDelays();
  return { ...r.toObject() } as Record<string, bigint>;
}

// ───────────────────────────── fingerprints (real Argon2id v1, cached) ─────────────────────────────

const fpCache = new Map<string, bigint>();
export async function fingerprint(pin: string, chainId: bigint, account: string): Promise<bigint> {
  const k = `${pin}|${chainId}|${account.toLowerCase()}`;
  let v = fpCache.get(k);
  if (v === undefined) {
    v = await pinFingerprint(pin, chainId, account);
    fpCache.set(k, v);
  }
  return v;
}

// ───────────────────────────── account setup ─────────────────────────────

export interface SetupOpts {
  pin?: string;
  duressPin?: string; // Phase 2: default none → slot filled with oblivious randomness
  knownRecipients?: string[];
  knownSpenders?: string[];
  ethLimits?: { lmin: bigint; lmax: bigint; big: bigint }; // scaled units
  usdcLimits?: { lmin: bigint; lmax: bigint; big: bigint };
  device?: string;
  helper?: string;
  pulse?: number;
  autoKnown?: boolean;
  delays?: any;
}

/** ETH: 1 unit = 1e12 wei (micro-ETH). USDC (6 dec): 1 unit = 1 base unit (1e-6 USDC). */
export const ETH_UNIT = 10n ** 12n;
export const USDC_UNIT = 1n;

export const DEFAULT_ETH_LIMITS = { lmin: 100_000n, lmax: 300_000n, big: 3_000_000n }; // 0.1 / 0.3 / 3 ETH
export const DEFAULT_USDC_LIMITS = { lmin: 300_000_000n, lmax: 1_000_000_000n, big: 10_000_000_000n }; // 300 / 1000 / 10000 USDC

// ───────────────────────────── escape address consent (K55, EIP-712) ─────────────────────────────

export function eip712Domain(chainId: bigint, account: string) {
  return { name: "EncryptedAccount", version: "1", chainId, verifyingContract: account };
}

/** E_addr's consent to be the escape address of `account` (nonce 0 at setup, then the account's escapeNonce). */
export async function escapeConsent(escapeSigner: any, chainId: bigint, account: string, nonce: number | bigint = 0): Promise<string> {
  return await escapeSigner.signTypedData(
    eip712Domain(chainId, account),
    { EscapeAddress: [{ name: "escape", type: "address" }, { name: "nonce", type: "uint32" }] },
    { escape: await escapeSigner.getAddress(), nonce },
  );
}

export async function escapePingSig(escapeSigner: any, chainId: bigint, account: string, issuedAt: number | bigint): Promise<string> {
  return await escapeSigner.signTypedData(
    eip712Domain(chainId, account),
    { EscapePing: [{ name: "escape", type: "address" }, { name: "issuedAt", type: "uint64" }] },
    { escape: await escapeSigner.getAddress(), issuedAt },
  );
}

/** Creates the clone through the factory with the escape address's consent; returns its address. */
export async function factoryCreate(stack: Stack, owner: string, escape: string, guardian: string, d: any, salt: string): Promise<string> {
  const predicted = await stack.factory.predictAddress(owner, escape, guardian, d, salt);
  const sig = await escapeConsent(await ethers.getSigner(escape), stack.chainId, predicted, 0);
  await (await stack.factory.createAccountWithDelays(owner, escape, guardian, d, salt, sig)).wait();
  return predicted;
}

export async function createAccount(
  stack: Stack,
  owner: HardhatEthersSigner,
  escape: string,
  guardian: string,
  opts: SetupOpts = {},
  salt = E.id("salt-" + Math.random()),
): Promise<any> {
  const d = opts.delays ?? (await defaultDelays(stack));
  const predicted = await factoryCreate(stack, owner.address, escape, guardian, d, salt);
  const acct = await accountAt(predicted);
  expect(await acct.getAddress()).to.eq(predicted);
  await setupAccount(stack, acct, owner, opts);
  return acct;
}

export async function setupAccount(stack: Stack, acct: any, owner: HardhatEthersSigner, opts: SetupOpts = {}) {
  await setupPinOf(stack, acct, owner, opts);
  for (const [asset, lim, unit] of [
    [ETH, opts.ethLimits ?? DEFAULT_ETH_LIMITS, ETH_UNIT],
    [await stack.usdc.getAddress(), opts.usdcLimits ?? DEFAULT_USDC_LIMITS, USDC_UNIT],
  ] as const) {
    const inp = hre.fhevm.createEncryptedInput(await acct.getAddress(), owner.address);
    inp.add64(lim.lmin);
    inp.add64(lim.lmax);
    inp.add64(lim.big);
    const enc = await inp.encrypt();
    await (await acct.connect(owner).setupAsset(asset, unit, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait();
  }
  await setupKnownList(acct, owner, false, opts.knownRecipients ?? [], N_RECIPIENTS);
  await setupKnownList(acct, owner, true, opts.knownSpenders ?? [], N_SPENDERS);
  await setupRolesAndArm(acct, owner, opts);
}

async function setupRolesAndArm(acct: any, owner: HardhatEthersSigner, opts: SetupOpts) {
  await (
    await acct
      .connect(owner)
      .setupRoles(opts.device ?? E.ZeroAddress, opts.helper ?? E.ZeroAddress, opts.pulse ?? 90 * DAY, opts.autoKnown ?? true)
  ).wait();
  await (await acct.connect(owner).arm()).wait();
}

/** PIN setup (A and B alike): Enc(fingerprint), Enc(duress candidate), Enc(useDuress). */
export async function setupPinOf(stack: Stack, acct: any, owner: HardhatEthersSigner, opts: SetupOpts = {}) {
  const addr = await acct.getAddress();
  const pin = opts.pin ?? "482915";
  const fp = await fingerprint(pin, stack.chainId, addr);
  const useDuress = opts.duressPin !== undefined;
  const dc = useDuress ? await fingerprint(opts.duressPin!, stack.chainId, addr) : randomUint64();
  {
    const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.add64(fp);
    inp.add64(dc);
    inp.addBool(useDuress);
    const enc = await inp.encrypt();
    await (await acct.connect(owner).setupPin(enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait();
  }
}

// ───────────────────────────── B variant (F0.11): open lists, open limit ─────────────────────────────

export interface StackB extends Stack {
  implB: any;
  factoryB: any;
}

/** A stack plus the B implementation and a factory cloning it (the policy mode is chosen by the factory used). */
export async function deployStackB(): Promise<StackB> {
  const stack = await deployStack();
  const ImplB = await ethers.getContractFactory("EncryptedAccountB", { libraries: stack.libs });
  const implB: any = await ImplB.deploy(await stack.entryPoint.getAddress());
  await implB.waitForDeployment();
  const factoryB: any = await (await ethers.getContractFactory("EncryptedAccountFactory")).deploy(await implB.getAddress());
  await factoryB.waitForDeployment();
  return { ...stack, implB, factoryB };
}

export interface SetupOptsB extends SetupOpts {
  ethOpenLimit?: bigint; // wei per epoch
  usdcOpenLimit?: bigint; // base units per epoch
}
export const DEFAULT_ETH_OPEN_LIMIT = E.parseEther("0.2");
export const DEFAULT_USDC_OPEN_LIMIT = 500_000_000n; // 500 USDC

export async function createAccountB(
  stack: StackB,
  owner: HardhatEthersSigner,
  escape: string,
  guardian: string,
  opts: SetupOptsB = {},
  salt = E.id("saltB-" + Math.random()),
): Promise<any> {
  const d = opts.delays ?? (await defaultDelays(stack));
  const predicted = await stack.factoryB.predictAddress(owner.address, escape, guardian, d, salt);
  const sig = await escapeConsent(await ethers.getSigner(escape), stack.chainId, predicted, 0);
  await (await stack.factoryB.createAccountWithDelays(owner.address, escape, guardian, d, salt, sig)).wait();
  const acct = await ethers.getContractAt("EncryptedAccountB", predicted);
  await setupAccountB(stack, acct, owner, opts);
  return acct;
}

/** B setup: PIN (unchanged), per asset the public limit + Enc(L_big), the public lists, roles, arm. */
export async function setupAccountB(stack: Stack, acct: any, owner: HardhatEthersSigner, opts: SetupOptsB = {}) {
  await setupPinOf(stack, acct, owner, opts);
  for (const [asset, open, big, unit] of [
    [ETH, opts.ethOpenLimit ?? DEFAULT_ETH_OPEN_LIMIT, (opts.ethLimits ?? DEFAULT_ETH_LIMITS).big, ETH_UNIT],
    [await stack.usdc.getAddress(), opts.usdcOpenLimit ?? DEFAULT_USDC_OPEN_LIMIT, (opts.usdcLimits ?? DEFAULT_USDC_LIMITS).big, USDC_UNIT],
  ] as const) {
    const inp = hre.fhevm.createEncryptedInput(await acct.getAddress(), owner.address);
    inp.add64(big);
    const enc = await inp.encrypt();
    await (await acct.connect(owner).setupAssetOpen(asset, unit, open, enc.handles[0], enc.inputProof)).wait();
  }
  if ((opts.knownRecipients ?? []).length) await (await acct.connect(owner).setupKnownOpen(false, opts.knownRecipients!)).wait();
  if ((opts.knownSpenders ?? []).length) await (await acct.connect(owner).setupKnownOpen(true, opts.knownSpenders!)).wait();
  await setupRolesAndArm(acct, owner, opts);
}

/**
 * All slots are client-encrypted (real entries + encrypted zeros), max 12 eaddress per proof (2048-bit CRS).
 * Layout convention: encrypted zeros FIRST, real entries LAST. The contract cannot see which slots are empty,
 * and auto-"known" evicts the least recently written slot (lowest index on ties) — with this layout it fills
 * empty slots before it ever evicts a real entry, without revealing how many entries are real.
 */
export async function setupKnownList(acct: any, owner: HardhatEthersSigner, spenders: boolean, entries: string[], n: number) {
  const addr = await acct.getAddress();
  const all = [...Array(n - entries.length).fill(E.ZeroAddress), ...entries];
  for (let start = 0; start < n; start += 12) {
    const chunk = all.slice(start, start + 12);
    const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    for (const a of chunk) inp.addAddress(a);
    const enc = await inp.encrypt();
    await (await acct.connect(owner).setupKnown(spenders, start, enc.handles, enc.inputProof)).wait();
  }
}

// ───────────────────────────── op helpers ─────────────────────────────

export async function lastOpId(acct: any): Promise<bigint> {
  return await acct.opCount();
}

export async function opOf(acct: any, id: bigint) {
  return await acct.getOp(id);
}

/** Encrypted guess (h + c) and the challenge c it was computed with (submitGuess takes c, K53). */
export async function encGuess(acct: any, user: string, chainId: bigint, opId: bigint, pin: string, cOverride?: bigint) {
  const addr = await acct.getAddress();
  const fp = await fingerprint(pin, chainId, addr);
  const c = cOverride ?? BigInt(await acct.challengeOf(opId));
  const inp = hre.fhevm.createEncryptedInput(addr, user);
  inp.add64(guessValue(fp, c));
  const enc = await inp.encrypt();
  return { handles: enc.handles, inputProof: enc.inputProof, c };
}

/** K-track guess from the owner EOA (user context = owner). */
export async function guess(acct: any, signer: HardhatEthersSigner, chainId: bigint, opId: bigint, pin: string) {
  const enc = await encGuess(acct, signer.address, chainId, opId, pin);
  return await (await acct.connect(signer).submitGuess(opId, enc.c, enc.handles[0], enc.inputProof)).wait();
}

/** Authenticated lane: K (signer) + co-signature of D or the helper (cosigner). */
export async function laneGuess(acct: any, signer: HardhatEthersSigner, cosigner: any, chainId: bigint, opId: bigint, pin: string) {
  const enc = await encGuess(acct, signer.address, chainId, opId, pin);
  const cos = await personalSign(
    cosigner,
    "encrypted-account/lane/v1",
    chainId,
    await acct.getAddress(),
    E.keccak256(coder.encode(["uint256", "bytes32"], [opId, enc.handles[0]])),
  );
  return await (await acct.connect(signer).submitGuessWithCosign(opId, enc.c, enc.handles[0], enc.inputProof, cos)).wait();
}

/** Challenge from the opening receipt (OpOpened.challenge) — what a client uses instead of an RPC read (K53). */
export function challengeFromReceipt(acct: any, rcpt: any): { opId: bigint; c: bigint } {
  for (const log of rcpt.logs) {
    try {
      const ev = acct.interface.parseLog(log);
      if (ev?.name === "OpOpened") return { opId: ev.args.opId as bigint, c: BigInt(ev.args.challenge) };
    } catch {
      /* not ours */
    }
  }
  throw new Error("no OpOpened in receipt");
}

export async function decryptForGuess(acct: any, opId: bigint) {
  const g = await acct.getGuess(opId);
  const hs = g.bigH === E.ZeroHash ? [g.okH] : [g.okH, g.bigH];
  return await hre.fhevm.publicDecrypt(hs);
}

export async function finalizeGuess(acct: any, opId: bigint, caller?: HardhatEthersSigner) {
  const res = await decryptForGuess(acct, opId);
  const c = caller ? acct.connect(caller) : acct;
  return await (await c.finalizeGuess(opId, res.abiEncodedClearValues, res.decryptionProof)).wait();
}

export async function guessAndFinalize(acct: any, signer: HardhatEthersSigner, chainId: bigint, opId: bigint, pin: string) {
  await guess(acct, signer, chainId, opId, pin);
  return await finalizeGuess(acct, opId);
}

export async function finalizeEvaluation(acct: any, opId: bigint, caller?: HardhatEthersSigner) {
  const op = await acct.getOp(opId);
  const res = await hre.fhevm.publicDecrypt([op.h0]);
  const c = caller ? acct.connect(caller) : acct;
  return await (await c.finalizeEvaluation(opId, res.abiEncodedClearValues, res.decryptionProof)).wait();
}

export async function okBitOf(acct: any, opId: bigint): Promise<boolean> {
  const op = await acct.getOp(opId);
  return await hre.fhevm.publicDecryptEbool(op.h0);
}

/** Debug-only cleartext read (mock stack). Never possible on a real network. */
export async function debugU64(handle: string): Promise<bigint> {
  return await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
}
export async function debugBool(handle: string): Promise<boolean> {
  return await hre.fhevm.debugger.decryptEbool(handle);
}
export async function debugAddr(handle: string): Promise<string> {
  return await hre.fhevm.debugger.decryptEaddress(handle);
}

export async function userDecryptBool(handle: string, contract: string, user: HardhatEthersSigner): Promise<boolean> {
  // The SDK validates the decryption permit against the wall clock (not chain time).
  return await hre.fhevm.userDecryptEbool(handle, contract, user);
}

/**
 * Custom errors are thrown inside the external libraries, so they are not part of the account ABI.
 * `errs` merges every error fragment so chai's revertedWithCustomError(errs, "Name") can decode them.
 */
let _errs: any;
export async function errs(): Promise<{ interface: E.Interface }> {
  if (_errs) return _errs;
  const frags: any[] = [];
  const seen = new Set<string>();
  for (const n of ["EncryptedAccount", "PinLib", "PolicyLib", "OpsLib", "OpenLib"]) {
    const art = await hre.artifacts.readArtifact(n);
    for (const f of art.abi) {
      if (f.type === "error") {
        const sig = f.name + "(" + (f.inputs ?? []).map((i: any) => i.type).join(",") + ")";
        if (!seen.has(sig)) {
          seen.add(sig);
          frags.push(f);
        }
      }
    }
  }
  _errs = { interface: new E.Interface(frags) };
  return _errs;
}

export async function opIdFromReceipt(acct: any, rcpt: any): Promise<bigint> {
  for (const log of rcpt.logs) {
    try {
      const ev = acct.interface.parseLog(log);
      if (ev?.name === "OpOpened") return ev.args.opId as bigint;
    } catch {
      /* not ours */
    }
  }
  throw new Error("no OpOpened in receipt");
}

export async function requestTransfer(acct: any, owner: HardhatEthersSigner, asset: string, to: string, amount: bigint, viaPin = false) {
  const rcpt = await (await acct.connect(owner).requestTransfer(asset, to, amount, viaPin)).wait();
  return await opIdFromReceipt(acct, rcpt);
}

export async function personalSign(signer: HardhatEthersSigner, tag: string, chainId: bigint, account: string, payload: string) {
  const inner = E.keccak256(coder.encode(["bytes32", "uint256", "address", "bytes32"], [E.id(tag), chainId, account, payload]));
  return await signer.signMessage(E.getBytes(inner));
}
