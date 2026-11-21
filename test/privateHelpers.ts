/**
 * Shared helpers of the private-mode tests (not a test file itself): the EncryptedAccountP stack, account setup with the
 * private paths, and transaction traces that leave out the mock's plaintext bookkeeping.
 */
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers as E } from "ethers";
import * as hre from "hardhat";
import { DAY, N_RECIPIENTS, N_SPENDERS, Stack, debugU64, defaultDelays, deployStack, escapeConsent, ethers, setupKnownList, setupPinOf } from "./helpers";

export const tc = (x: number) => BigInt(Math.round(x * 1e6)); // 6-decimal confidential units
export const PRIVATE_LIMITS = { lmin: tc(300), lmax: tc(1000) };
export const FUND = tc(10_000);
/** The amount the duress PIN keeps hidden in the tests: of FUND, the duress PIN shows SHOWN. */
export const HIDDEN = tc(8000);
export const SHOWN = FUND - HIDDEN;
export const PIN = "482915";
export const DURESS = "771203";
export const WRONG = "000111";
export const TRIPPED = (1n << 64n) - 1n;
export const MIN_BIG_DELAY = 72 * 3600;
export const HCU_TX = 20_000_000;
export const HCU_DEPTH = 5_000_000;

export interface StackP extends Stack {
  module: any;
  implP: any;
  factoryP: any;
  token: any;
}

/** The A stack (unchanged libraries) plus PrivateModule, EncryptedAccountP, its factory and a test ERC-7984 token. */
export async function deployStackP(): Promise<StackP> {
  const stack = await deployStack();
  const ep = await stack.entryPoint.getAddress();
  const module: any = await (await ethers.getContractFactory("PrivateModule", { libraries: { OpenLib: stack.libs.OpenLib } })).deploy(ep);
  await module.waitForDeployment();
  const implP: any = await (await ethers.getContractFactory("EncryptedAccountP", { libraries: stack.libs })).deploy(ep, await stack.feeConfig.getAddress(), await module.getAddress());
  await implP.waitForDeployment();
  const factoryP: any = await (await ethers.getContractFactory("EncryptedAccountFactory")).deploy(await implP.getAddress());
  await factoryP.waitForDeployment();
  const token: any = await (await ethers.getContractFactory("TestConfidentialToken")).deploy();
  await token.waitForDeployment();
  return { ...stack, module, implP, factoryP, token };
}

/** The account as callers see it: its own ABI, the module's functions and every library's events and errors. */
let ABI_P: any[] | undefined;
export async function abiP(): Promise<any[]> {
  if (ABI_P) return ABI_P;
  const seen = new Set<string>();
  const out: any[] = [];
  for (const n of ["EncryptedAccountP", "PrivateModule", "PinLib", "PolicyLib", "OpsLib", "OpenLib", "TestConfidentialToken"]) {
    for (const f of (await hre.artifacts.readArtifact(n)).abi as any[]) {
      if (f.type === "constructor" || f.type === "fallback" || f.type === "receive") continue;
      if ((n.endsWith("Lib") || n === "TestConfidentialToken") && f.type === "function") continue;
      const key = `${f.type}:${f.name}(${(f.inputs ?? []).map((i: any) => i.type).join(",")})`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  ABI_P = out;
  return out;
}

/** Delays of a private-mode account: the factory defaults with bigTransfer raised to 72 h (§17.1). */
export async function delaysP(s: Stack): Promise<Record<string, bigint>> {
  const d = await defaultDelays(s);
  return { ...d, bigTransfer: BigInt(MIN_BIG_DELAY) };
}

export interface AcctOptsP {
  duressPin?: string; // optional, off by default
  hidden?: bigint; // default: HIDDEN with a duress PIN, 0 without (K alone never moves the hidden amount either)
  known: string[];
  salt?: string;
  delays?: Record<string, bigint>;
  guardian?: string;
}

/** Creates an EncryptedAccountP account and runs the setup: PIN, private token, known lists, roles, arm. */
export async function createAccountP(s: StackP, owner: HardhatEthersSigner, escape: string, guardian: string, o: AcctOptsP): Promise<any> {
  const d = o.delays ?? (await delaysP(s));
  const salt = o.salt ?? E.id("saltP-" + Math.random());
  const predicted = await s.factoryP.predictAddress(owner.address, escape, guardian, d, salt);
  const sig = await escapeConsent(await ethers.getSigner(escape), s.chainId, predicted, 0);
  await (await s.factoryP.createAccountWithDelays(owner.address, escape, guardian, d, salt, sig)).wait();
  const acct: any = new ethers.Contract(predicted, await abiP(), owner);
  await setupPinOf(s, acct, owner, { pin: PIN, duressPin: o.duressPin });
  const inp = hre.fhevm.createEncryptedInput(predicted, owner.address);
  inp.add64(PRIVATE_LIMITS.lmin);
  inp.add64(PRIVATE_LIMITS.lmax);
  // the client always encrypts a hidden amount (the dataflow is the same either way); without a duress PIN it is 0
  inp.add64(o.hidden ?? (o.duressPin ? HIDDEN : 0n));
  const enc = await inp.encrypt();
  await (await acct.privateSetupAsset(await s.token.getAddress(), enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait();
  await setupKnownList(acct, owner, false, o.known, N_RECIPIENTS);
  await setupKnownList(acct, owner, true, [], N_SPENDERS);
  await (await acct.setupRoles(E.ZeroAddress, E.ZeroAddress, 90 * DAY, true)).wait();
  await (await acct.arm()).wait();
  return acct;
}

export async function encAmount(acct: any, owner: HardhatEthersSigner, amount: bigint) {
  const inp = hre.fhevm.createEncryptedInput(await acct.getAddress(), owner.address);
  inp.add64(amount);
  return await inp.encrypt();
}

export function eventArgs(acct: any, rc: any, name: string): any | null {
  for (const log of rc.logs) {
    try {
      const ev = acct.interface.parseLog(log);
      if (ev?.name === name) return ev.args;
    } catch {
      /* another contract */
    }
  }
  return null;
}

export function opIdOf(acct: any, rc: any): bigint {
  const a = eventArgs(acct, rc, "OpOpened");
  if (!a) throw new Error("no OpOpened");
  return a.opId as bigint;
}

export async function balanceOf(s: StackP, who: string): Promise<bigint> {
  const h = await s.token.confidentialBalanceOf(who);
  return h === E.ZeroHash ? 0n : await debugU64(h);
}

export async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

export const j = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

// ───────────────────────────── traces without the mock's plaintext bookkeeping ─────────────────────────────

/**
 * The mock's CleartextFHEVMExecutor runs the real symbolic op and then hands the PLAINTEXT result to a cleartext layer
 * (CleartextArithmetic → CleartextDB) that stores it for the debugger. Storing 0 costs ≈19,900 gas less than storing a
 * non-zero value, so on the mock the gas of an FHE op depends on its secret result. The production executor has no such
 * layer. `protocolExec` / `protocolSteps` are the execution gas and EVM steps outside it; the cleartext layer is found
 * through the executor's getCleartextArithmeticAddress().
 */
let CLEARTEXT_ARITH = "";
export async function cleartextLayer(executor: string): Promise<string> {
  if (!CLEARTEXT_ARITH) {
    const ex = await ethers.getContractAt(["function getCleartextArithmeticAddress() view returns (address)"], executor);
    CLEARTEXT_ARITH = (await ex.getCleartextArithmeticAddress()).toLowerCase();
  }
  return CLEARTEXT_ARITH;
}

export const ALLOWED_TOPIC = E.id("Allowed(address,address,bytes32)");
export const DECRYPTABLE_TOPIC = E.id("AllowedForDecryption(address,bytes32[])");

export interface TxRec {
  label: string;
  gasUsed: number;
  intrinsic: number;
  exec: number;
  cleartextGas: number;
  protocolExec: number;
  calldataLen: number;
  zeroBytes: number;
  hcu: number;
  hcuDepth: number;
  steps: number;
  protocolSteps: number;
  logs: string[];
  aclAllowed: string[];
  decryptRequests: number;
  sstore: Record<string, number>;
  tstore: Record<string, number>;
  calls: string[];
}

/** Metrics that must be identical between two modes of the same step. */
export const STRICT: (keyof TxRec)[] = ["protocolExec", "hcu", "hcuDepth", "protocolSteps", "calldataLen", "logs", "aclAllowed", "decryptRequests", "sstore", "tstore", "calls"];

export class Roles {
  private m = new Map<string, string>();
  set(addr: string, role: string) {
    this.m.set(addr.toLowerCase(), role);
    return this;
  }
  of(addr: string): string {
    const a = addr.toLowerCase();
    return this.m.get(a) ?? (BigInt(a) < 0x100n ? `precompile:${BigInt(a)}` : `other:${a}`);
  }
  /** A 32-byte topic: an address with a role, or an opaque value (a handle, a number) shown as "x". */
  topic(t: string): string {
    const v = BigInt(t);
    if (v < 1n << 160n) {
      const a = "0x" + v.toString(16).padStart(40, "0");
      if (this.m.has(a)) return this.m.get(a)!;
    }
    return "x";
  }
}

const hex2big = (x: string) => BigInt(x.startsWith("0x") ? x : "0x" + x);

export async function recordTx(label: string, rc: any, roles: Roles, cleartextArith: string): Promise<TxRec> {
  // A trace of an FHE-heavy transaction is hundreds of MB of JSON: collect the previous one first (run-tests.mjs starts
  // node with --expose-gc), so a file with many traced pairs fits in a machine's memory.
  (globalThis as any).gc?.();
  const tx = await ethers.provider.getTransaction(rc.hash);
  const data = E.getBytes(tx!.data);
  const zeros = data.filter((b) => b === 0).length;
  const intrinsic = 21000 + 4 * zeros + 16 * (data.length - zeros); // Prague, no access list; above the EIP-7623 floor
  const h = hre.fhevm.computeTransactionHCU(rc);
  const tr: any = await hre.network.provider.send("debug_traceTransaction", [rc.hash, { disableMemory: true, disableStorage: true }]);
  const logsS: any[] = tr.structLogs;
  type Frame = { storage: string; cleartext: boolean; firstGas: number };
  const ctx: Frame[] = [{ storage: tx!.to!.toLowerCase(), cleartext: false, firstGas: logsS[0]?.gas ?? 0 }];
  const sstore: Record<string, number> = {};
  const tstore: Record<string, number> = {};
  const calls: string[] = [];
  let cleartextGas = 0;
  let cleartextSteps = 0;
  for (let i = 0; i < logsS.length; i++) {
    const s = logsS[i];
    const cur = ctx[ctx.length - 1];
    const next = logsS[i + 1];
    if (cur.cleartext) {
      cleartextSteps++;
    } else if (s.op === "SSTORE") {
      sstore[roles.of(cur.storage)] = (sstore[roles.of(cur.storage)] ?? 0) + 1;
    } else if (s.op === "TSTORE") {
      tstore[roles.of(cur.storage)] = (tstore[roles.of(cur.storage)] ?? 0) + 1;
    }
    if (s.op === "CALL" || s.op === "STATICCALL" || s.op === "DELEGATECALL" || s.op === "CALLCODE") {
      const st: string[] = s.stack;
      const target = "0x" + (hex2big(st[st.length - 2]) & ((1n << 160n) - 1n)).toString(16).padStart(40, "0");
      const clear = cur.cleartext || target === cleartextArith;
      if (!clear) calls.push(`${s.op}:${roles.of(target)}`);
      if (next && next.depth === s.depth + 1) {
        ctx.push({ storage: s.op === "DELEGATECALL" || s.op === "CALLCODE" ? cur.storage : target, cleartext: clear, firstGas: next.gas });
      }
    } else if (next && next.depth < s.depth) {
      for (let k = 0; k < s.depth - next.depth; k++) {
        const f = ctx.pop()!;
        const parent = ctx[ctx.length - 1];
        if (f.cleartext && parent && !parent.cleartext) cleartextGas += f.firstGas - (s.gas - s.gasCost);
      }
    }
  }
  const logs: string[] = [];
  const aclAllowed: string[] = [];
  let decryptRequests = 0;
  for (const l of rc.logs) {
    logs.push([roles.of(l.address), l.topics[0], l.topics.length, (l.data.length - 2) / 2, ...l.topics.slice(1).map((t: string) => roles.topic(t))].join("|"));
    if (l.topics[0] === ALLOWED_TOPIC) aclAllowed.push(roles.topic(l.topics[2]));
    if (l.topics[0] === DECRYPTABLE_TOPIC) decryptRequests++;
  }
  const exec = Number(rc.gasUsed) - intrinsic;
  return {
    label,
    gasUsed: Number(rc.gasUsed),
    intrinsic,
    exec,
    cleartextGas,
    protocolExec: exec - cleartextGas,
    calldataLen: data.length,
    zeroBytes: zeros,
    hcu: Number(h.globalHCU),
    hcuDepth: Number(h.maxHCUDepth),
    steps: logsS.length,
    protocolSteps: logsS.length - cleartextSteps,
    logs,
    aclAllowed,
    decryptRequests,
    sstore,
    tstore,
    calls,
  };
}

/** Differences between two records of the same step, over the strict metrics. */
export function diffRecs(a: TxRec, b: TxRec): string[] {
  return STRICT.filter((m) => JSON.stringify(a[m]) !== JSON.stringify(b[m]));
}
