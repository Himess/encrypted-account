/**
 * SPIKE — private mode (ERC-7984) as a module on EncryptedAccountP (contracts/private/). Measures the open questions
 * before a full design:
 *   T1  one-transaction K-only private transfer: one tx? decryption or watchtower needed? gas, HCU vs the limits
 *   T2  balance view only with the PIN: K alone cannot decrypt the balance, the owner can after a correct PIN
 *   T3  real PIN vs duress PIN: are the on-chain traces identical? (10 runs each, different amounts)
 *   T4  silent zero: what an over-limit transfer does, and how the owner learns about it
 * [Mock] evidence: results/spike/private-mode-mock.json (written with WRITE_RESULTS=1).
 */
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers as E } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { randomUint64 } from "../sdk/src";
import {
  ETH,
  FhevmType,
  N_RECIPIENTS,
  N_SPENDERS,
  RECORD,
  Stack,
  alignDecay,
  createAccount,
  createAccountB,
  debugBool,
  debugU64,
  defaultDelays,
  deployStack,
  deployStackB,
  escapeConsent,
  ethers,
  finalizeEvaluation,
  finalizeGuess,
  guess,
  setupKnownList,
  setupPinOf,
  time,
} from "./helpers";

const tc = (x: number) => BigInt(Math.round(x * 1e6)); // tcUSD, 6 decimals; limits are in base units (unit = 1)
const LIMITS = { lmin: tc(300), lmax: tc(1000), big: tc(10_000) };
const DECOY = tc(2000);
const FUND = tc(10_000);
const PIN = "482915";
const DURESS = "771203";
const WRONG = "000111";
const HCU_TX = 20_000_000;
const HCU_DEPTH = 5_000_000;

const OUT: Record<string, any> = { generatedAt: new Date().toISOString(), evidence: "[Mock] hardhat + @fhevm/hardhat-plugin (cleartext)" };

interface StackP extends Stack {
  module: any;
  implP: any;
  factoryP: any;
  token: any;
}

async function deployStackP(): Promise<StackP> {
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

/** The account's ABI plus the module's functions and every library event and error (they all run at the account). */
let ABI_P: any[] | undefined;
async function abiP(): Promise<any[]> {
  if (ABI_P) return ABI_P;
  const seen = new Set<string>();
  const out: any[] = [];
  for (const n of ["EncryptedAccountP", "PrivateModule", "PinLib", "PolicyLib", "OpsLib", "OpenLib", "TestConfidentialToken"]) {
    const art = await hre.artifacts.readArtifact(n);
    for (const f of art.abi) {
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

interface AcctOpts {
  duressPin?: string;
  known: string[];
  decoy?: bigint;
  salt?: string;
}

async function createAccountP(s: StackP, owner: HardhatEthersSigner, escape: string, guardian: string, o: AcctOpts): Promise<any> {
  const d = await defaultDelays(s);
  const salt = o.salt ?? E.id("saltP-" + Math.random());
  const predicted = await s.factoryP.predictAddress(owner.address, escape, guardian, d, salt);
  const sig = await escapeConsent(await ethers.getSigner(escape), s.chainId, predicted, 0);
  await (await s.factoryP.createAccountWithDelays(owner.address, escape, guardian, d, salt, sig)).wait();
  const acct: any = new ethers.Contract(predicted, await abiP(), owner);
  await setupPinOf(s, acct, owner, { pin: PIN, duressPin: o.duressPin });
  const tokenAddr = await s.token.getAddress();
  {
    const inp = hre.fhevm.createEncryptedInput(predicted, owner.address);
    inp.add64(LIMITS.lmin);
    inp.add64(LIMITS.lmax);
    inp.add64(LIMITS.big);
    const enc = await inp.encrypt();
    await (await acct.setupAsset(tokenAddr, 1, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait();
  }
  {
    // the client always encrypts a decoy cap; without a duress PIN it is a random value that never matters
    const inp = hre.fhevm.createEncryptedInput(predicted, owner.address);
    inp.add64(o.decoy ?? (o.duressPin ? DECOY : randomUint64()));
    const enc = await inp.encrypt();
    await (await acct.privateSetupAsset(tokenAddr, enc.handles[0], enc.inputProof)).wait();
  }
  await setupKnownList(acct, owner, false, o.known, N_RECIPIENTS);
  await setupKnownList(acct, owner, true, [], N_SPENDERS);
  await (await acct.setupRoles(E.ZeroAddress, E.ZeroAddress, 90 * 86400, true)).wait();
  await (await acct.arm()).wait();
  return acct;
}

async function encAmount(acct: any, owner: HardhatEthersSigner, amount: bigint) {
  const inp = hre.fhevm.createEncryptedInput(await acct.getAddress(), owner.address);
  inp.add64(amount);
  return await inp.encrypt();
}

function eventArgs(acct: any, rc: any, name: string): any | null {
  for (const log of rc.logs) {
    try {
      const ev = acct.interface.parseLog(log);
      if (ev?.name === name) return ev.args;
    } catch {
      /* other contract */
    }
  }
  return null;
}

function opIdOf(acct: any, rc: any): bigint {
  const a = eventArgs(acct, rc, "OpOpened");
  if (!a) throw new Error("no OpOpened");
  return a.opId as bigint;
}

async function balanceOf(s: StackP, who: string): Promise<bigint> {
  const h = await s.token.confidentialBalanceOf(who);
  return h === E.ZeroHash ? 0n : await debugU64(h);
}

async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

// ───────────────────────────── trace capture (T3) ─────────────────────────────

const ALLOWED_TOPIC = E.id("Allowed(address,address,bytes32)");
const DECRYPTABLE_TOPIC = E.id("AllowedForDecryption(address,bytes32[])");

/**
 * The mock's CleartextFHEVMExecutor runs the real symbolic op and then hands the PLAINTEXT result to a cleartext layer
 * (CleartextArithmetic → CleartextDB) that stores it for the debugger. Storing 0 costs less than storing a non-zero
 * value, so on the mock the gas of every FHE op depends on its secret result. The production executor has no such
 * layer. `protocolExec` / `protocolSteps` are the execution gas and EVM steps outside that layer.
 */
let CLEARTEXT_ARITH = "";
const j = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

interface TxRec {
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

class Roles {
  private m = new Map<string, string>();
  set(addr: string, role: string) {
    this.m.set(addr.toLowerCase(), role);
  }
  of(addr: string): string {
    const a = addr.toLowerCase();
    return this.m.get(a) ?? (BigInt(a) < 0x100n ? `precompile:${BigInt(a)}` : `other:${a}`);
  }
  /** A 32-byte topic: an address of a known role, or an opaque value (a handle, a number) shown as "x". */
  topic(t: string): string {
    const v = BigInt(t);
    if (v < 1n << 160n) {
      const a = "0x" + v.toString(16).padStart(40, "0");
      if (this.m.has(a)) return this.m.get(a)!;
    }
    return "x";
  }
}

function hex2big(x: string): bigint {
  return BigInt(x.startsWith("0x") ? x : "0x" + x);
}

async function recordTx(label: string, rc: any, roles: Roles): Promise<TxRec> {
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
      cleartextSteps++; // the mock's plaintext bookkeeping: counted apart, never compared as protocol behaviour
    } else {
      if (s.op === "SSTORE") sstore[roles.of(cur.storage)] = (sstore[roles.of(cur.storage)] ?? 0) + 1;
      else if (s.op === "TSTORE") tstore[roles.of(cur.storage)] = (tstore[roles.of(cur.storage)] ?? 0) + 1;
    }
    if (s.op === "CALL" || s.op === "STATICCALL" || s.op === "DELEGATECALL" || s.op === "CALLCODE") {
      const st: string[] = s.stack;
      const target = "0x" + (hex2big(st[st.length - 2]) & ((1n << 160n) - 1n)).toString(16).padStart(40, "0");
      const clear = cur.cleartext || target === CLEARTEXT_ARITH;
      if (!clear) calls.push(`${s.op}:${roles.of(target)}`);
      if (next && next.depth === s.depth + 1) {
        ctx.push({ storage: s.op === "DELEGATECALL" || s.op === "CALLCODE" ? cur.storage : target, cleartext: clear, firstGas: next.gas });
      }
    } else if (next && next.depth < s.depth) {
      for (let k = 0; k < s.depth - next.depth; k++) {
        const f = ctx.pop()!;
        const parent = ctx[ctx.length - 1];
        // gas the frame used: what it started with minus what it handed back after its last step
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

/** Metrics that must be identical between the two modes, one key per comparison row of the report. */
const STRICT: (keyof TxRec)[] = ["protocolExec", "hcu", "hcuDepth", "protocolSteps", "calldataLen", "logs", "aclAllowed", "decryptRequests", "sstore", "tstore", "calls"];
/** Shown for completeness: on the mock they include the plaintext bookkeeping (see CLEARTEXT_ARITH). */
const MOCK_ONLY: (keyof TxRec)[] = ["exec", "steps", "cleartextGas"];

// ─────────────────────────────────────────────────────────────────────────────

describe("SPIKE private mode (ERC-7984 module on EncryptedAccountP)", function () {
  let s: StackP;
  let owner: HardhatEthersSigner, escape: HardhatEthersSigner, guardian: HardhatEthersSigner, R: HardhatEthersSigner, other: HardhatEthersSigner;
  let tokenAddr: string;

  before(async () => {
    [, owner, escape, guardian, R, other] = await ethers.getSigners();
    s = await deployStackP();
    tokenAddr = await s.token.getAddress();
    const execAddr = await s.implP.executorAddress();
    const ex = await ethers.getContractAt(["function getCleartextArithmeticAddress() view returns (address)"], execAddr);
    CLEARTEXT_ARITH = (await ex.getCleartextArithmeticAddress()).toLowerCase();
    OUT.mockCleartextLayer = { executor: execAddr, cleartextArithmetic: CLEARTEXT_ARITH };
    await (await s.token.mint(R.address, tc(1))).wait(); // the recipient's balance slot is already in use
    OUT.sizes = {};
    for (const n of ["EncryptedAccount", "EncryptedAccountB", "EncryptedAccountP", "PrivateModule", "OpsLib"]) {
      const art = await hre.artifacts.readArtifact(n);
      OUT.sizes[n] = (art.deployedBytecode.length - 2) / 2;
    }
  });

  after(() => {
    if (!RECORD) return;
    const dir = path.join(__dirname, "..", "results", "spike");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "private-mode-mock.json"), JSON.stringify(OUT, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  });

  it("T1 · one-transaction K-only private transfer: no decryption, no watchtower, HCU vs the limits", async () => {
    const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R.address] });
    const addr = await acct.getAddress();
    await (await s.token.mint(addr, FUND)).wait();
    const before = { acct: await balanceOf(s, addr), R: await balanceOf(s, R.address) };

    const amount = tc(100); // below L_min, so below the hidden tau
    const enc = await encAmount(acct, owner, amount);
    const rc = await (await acct.privateTransfer(tokenAddr, R.address, enc.handles[0], enc.inputProof)).wait();
    const h = hre.fhevm.computeTransactionHCU(rc);
    const decryptRequests = rc.logs.filter((l: any) => l.topics[0] === DECRYPTABLE_TOPIC).length;
    const after = { acct: await balanceOf(s, addr), R: await balanceOf(s, R.address) };
    const st = await acct.privateState(tokenAddr);

    expect(after.R - before.R).to.eq(amount); // done in this one transaction
    expect(before.acct - after.acct).to.eq(amount);
    expect(decryptRequests).to.eq(0); // nothing waits for the KMS
    expect(await debugU64(st.spent)).to.eq(amount);

    // reference on the same mock chain: the A variant's K-only ETH path (two phases) and the B variant (one tx, public policy)
    const acctA = await createAccount(s, owner, escape.address, guardian.address, { knownRecipients: [R.address] });
    await owner.sendTransaction({ to: await acctA.getAddress(), value: E.parseEther("1") });
    const rcA1 = await (await acctA.connect(owner).requestTransfer(ETH, R.address, E.parseEther("0.05"), false)).wait();
    const idA = opIdOf(acctA, rcA1);
    const rcA2 = await finalizeEvaluation(acctA, idA);
    const hA1 = hre.fhevm.computeTransactionHCU(rcA1);
    const hA2 = hre.fhevm.computeTransactionHCU(rcA2);
    const sB = await deployStackB();
    const acctB = await createAccountB(sB, owner, escape.address, guardian.address, { knownRecipients: [R.address] });
    await owner.sendTransaction({ to: await acctB.getAddress(), value: E.parseEther("1") });
    const rcB = await (await acctB.connect(owner).requestTransfer(ETH, R.address, E.parseEther("0.05"), false)).wait();
    const hB = hre.fhevm.computeTransactionHCU(rcB);

    OUT.T1 = {
      transactions: 1,
      decryptRequests,
      watchtowerNeeded: false,
      gas: Number(rc.gasUsed),
      hcu: Number(h.globalHCU),
      hcuDepth: Number(h.maxHCUDepth),
      hcuPctOfTxLimit: +((100 * Number(h.globalHCU)) / HCU_TX).toFixed(2),
      hcuDepthPctOfLimit: +((100 * Number(h.maxHCUDepth)) / HCU_DEPTH).toFixed(2),
      moved: amount,
      reference: {
        A_kOnlyEth_twoTx: { gas: Number(rcA1.gasUsed) + Number(rcA2.gasUsed), gasTx1: Number(rcA1.gasUsed), gasTx2: Number(rcA2.gasUsed), hcu: Number(hA1.globalHCU) + Number(hA2.globalHCU), decryptRequests: 1 },
        B_kOnlyEth_oneTx: { gas: Number(rcB.gasUsed), hcu: Number(hB.globalHCU), decryptRequests: 0 },
      },
    };
    console.log("      T1", j(OUT.T1));
    expect(Number(h.globalHCU)).to.be.lessThan(HCU_TX / 2);
    expect(Number(h.maxHCUDepth)).to.be.lessThan(HCU_DEPTH / 2);
  });

  it("T2 · balance view: K alone cannot decrypt the balance; after a correct PIN the owner can", async () => {
    const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R.address] });
    const addr = await acct.getAddress();
    await (await s.token.mint(addr, FUND)).wait();
    const acl = await ethers.getContractAt(["function isAllowed(bytes32,address) view returns (bool)", "function isHandleDelegatedForUserDecryption(address,address,address,bytes32) view returns (bool)"], await acct.aclAddress());

    // (a) K alone
    const balH = await s.token.confidentialBalanceOf(addr);
    const kAllowed = await acl.isAllowed(balH, owner.address);
    const acctAllowed = await acl.isAllowed(balH, addr);
    const delegated = await acl.isHandleDelegatedForUserDecryption(addr, owner.address, tokenAddr, balH);
    const kDecryptViaToken = !(await rejects(hre.fhevm.userDecryptEuint(FhevmType.euint64, balH, tokenAddr, owner)));
    const kDecryptViaAccount = !(await rejects(hre.fhevm.userDecryptEuint(FhevmType.euint64, balH, addr, owner)));
    expect(kAllowed).to.eq(false);
    expect(acctAllowed).to.eq(true);
    expect(delegated).to.eq(false);
    expect(kDecryptViaToken).to.eq(false);
    expect(kDecryptViaAccount).to.eq(false);

    // (b) a wrong PIN shows nothing
    const rcW1 = await (await acct.openPrivateView(tokenAddr)).wait();
    const idW = opIdOf(acct, rcW1);
    await guess(acct, owner, s.chainId, idW, WRONG);
    const rcW3 = await finalizeGuess(acct, idW);
    expect(eventArgs(acct, rcW3, "PrivateOpExecuted")).to.eq(null);

    // (c) the correct PIN: a fresh snapshot, allowed to K
    await alignDecay(); // the wrong guess above adds no back-off (score 1), but keep the calendar clean
    const rc1 = await (await acct.openPrivateView(tokenAddr)).wait();
    const id = opIdOf(acct, rc1);
    const rc2 = await guess(acct, owner, s.chainId, id, PIN);
    const rc3 = await finalizeGuess(acct, id);
    const ex = eventArgs(acct, rc3, "PrivateOpExecuted");
    expect(ex).to.not.eq(null);
    const snap: string = ex.result;
    expect(snap).to.not.eq(balH); // a fresh handle, never the token's own
    const seen = await hre.fhevm.userDecryptEuint(FhevmType.euint64, snap, addr, owner);
    expect(seen).to.eq(FUND);

    // (d) the snapshot is a point in time: after a K-only transfer K sees neither the new balance nor anything new
    const enc = await encAmount(acct, owner, tc(100));
    await (await acct.privateTransfer(tokenAddr, R.address, enc.handles[0], enc.inputProof)).wait();
    const balH2 = await s.token.confidentialBalanceOf(addr);
    const kSeesNew = !(await rejects(hre.fhevm.userDecryptEuint(FhevmType.euint64, balH2, tokenAddr, owner)));
    const oldStill = await hre.fhevm.userDecryptEuint(FhevmType.euint64, snap, addr, owner);
    expect(kSeesNew).to.eq(false);
    expect(oldStill).to.eq(FUND);

    OUT.T2 = {
      kAlone: { aclAllowedK: kAllowed, aclAllowedAccount: acctAllowed, delegatedToK: delegated, kDecryptViaToken, kDecryptViaAccount },
      wrongPin: { snapshot: false },
      correctPin: { snapshotDecryptedByK: seen, equalsBalance: seen === FUND, freshHandle: snap !== balH },
      afterLaterTransfer: { kSeesNewBalance: kSeesNew, oldSnapshotStillReads: oldStill },
      gas: { openView: Number(rc1.gasUsed), submitGuess: Number(rc2.gasUsed), finalizeAndView: Number(rc3.gasUsed), total: Number(rc1.gasUsed) + Number(rc2.gasUsed) + Number(rc3.gasUsed) },
      hcu: { submitGuess: Number(hre.fhevm.computeTransactionHCU(rc2).globalHCU), finalizeAndView: Number(hre.fhevm.computeTransactionHCU(rc3).globalHCU) },
      note: "Time is measured on Sepolia (scripts/spike/sepolia-private.ts); mock wall time means nothing.",
    };
    console.log("      T2", j(OUT.T2));
  });

  it("T3 · real PIN vs duress PIN, 10 runs each with different amounts: identical traces", async () => {
    // Two accounts set up identically (same owner, escape, guardian, PIN, duress PIN, limits, decoy, list, funds): A_real
    // always gets the real PIN, A_duress always the duress PIN. Step i of one is compared with step i of the other.
    const salt = E.id("t3");
    const aReal = await createAccountP(s, owner, escape.address, guardian.address, { duressPin: DURESS, known: [R.address], salt: E.id("t3-real") });
    const aDur = await createAccountP(s, owner, escape.address, guardian.address, { duressPin: DURESS, known: [R.address], salt: E.id("t3-duress") });
    void salt;
    const addrReal = await aReal.getAddress();
    const addrDur = await aDur.getAddress();
    await (await s.token.mint(addrReal, FUND)).wait();
    await (await s.token.mint(addrDur, FUND)).wait();

    const roles = (acctAddr: string) => {
      const r = new Roles();
      r.set(acctAddr, "ACCOUNT");
      r.set(tokenAddr, "TOKEN");
      r.set(owner.address, "K");
      r.set(guardian.address, "G");
      r.set(escape.address, "E");
      r.set(R.address, "R");
      return r;
    };
    const rolesReal = roles(addrReal);
    const rolesDur = roles(addrDur);
    // shared contracts keep their own address on both sides; name the ones we know for a readable report
    const named: [string, string][] = [
      [await aReal.aclAddress(), "ACL"],
      [await aReal.executorAddress(), "EXECUTOR"],
      [await s.implP.getAddress(), "IMPL_P"],
      [await s.module.getAddress(), "MODULE"],
      ...Object.entries(s.libs).map(([k, v]) => [v as string, k] as [string, string]),
    ];
    for (const [a, n] of named) {
      rolesReal.set(a, n);
      rolesDur.set(a, n);
    }

    const amounts = [50, 120, 300, 800, 1500, 2000, 2400, 4000, 9000, 15000].map(tc);
    const recs: { real: TxRec[]; duress: TxRec[] } = { real: [], duress: [] };
    const fn: { i: number; amount: bigint; viewReal: bigint; viewDuress: bigint; balReal: bigint; balDuress: bigint; movedReal: bigint; movedDuress: bigint; flagReal: boolean; flagDuress: boolean }[] = [];
    await alignDecay(); // no decay boundary inside the 10 runs (about 10 h of chain time)

    const both = async (label: string, f: (a: any) => Promise<any>) => {
      const r1 = await f(aReal);
      const r2 = await f(aDur);
      recs.real.push(await recordTx(label, r1, rolesReal));
      recs.duress.push(await recordTx(label, r2, rolesDur));
      return [r1, r2];
    };

    for (let i = 0; i < amounts.length; i++) {
      // ── PIN-gated view
      const [o1, o2] = await both(`run ${i + 1} · openPrivateView`, async (a) => (await a.openPrivateView(tokenAddr)).wait());
      const vReal = opIdOf(aReal, o1);
      const vDur = opIdOf(aDur, o2);
      await both(`run ${i + 1} · submitGuess (view)`, async (a) => guess(a, owner, s.chainId, a === aReal ? vReal : vDur, a === aReal ? PIN : DURESS));
      const flagReal = await debugBool((await aReal.getGuess(vReal)).duressFlagH);
      const flagDur = await debugBool((await aDur.getGuess(vDur)).duressFlagH);
      // the silent alarm: only the guardian can read the flag
      const gReal = await hre.fhevm.userDecryptEbool((await aReal.getGuess(vReal)).duressFlagH, addrReal, guardian);
      const gDur = await hre.fhevm.userDecryptEbool((await aDur.getGuess(vDur)).duressFlagH, addrDur, guardian);
      const [f1, f2] = await both(`run ${i + 1} · finalizeGuess + view`, async (a) => finalizeGuess(a, a === aReal ? vReal : vDur));
      const viewReal = await hre.fhevm.userDecryptEuint(FhevmType.euint64, eventArgs(aReal, f1, "PrivateOpExecuted").result, addrReal, owner);
      const viewDur = await hre.fhevm.userDecryptEuint(FhevmType.euint64, eventArgs(aDur, f2, "PrivateOpExecuted").result, addrDur, owner);

      // ── PIN-gated transfer of an encrypted amount
      const [t1, t2] = await both(`run ${i + 1} · openPrivateTransfer`, async (a) => {
        const enc = await encAmount(a, owner, amounts[i]);
        return (await a.openPrivateTransfer(tokenAddr, R.address, enc.handles[0], enc.inputProof)).wait();
      });
      const xReal = opIdOf(aReal, t1);
      const xDur = opIdOf(aDur, t2);
      await both(`run ${i + 1} · submitGuess (transfer)`, async (a) => guess(a, owner, s.chainId, a === aReal ? xReal : xDur, a === aReal ? PIN : DURESS));
      await both(`run ${i + 1} · finalizeGuess (transfer)`, async (a) => finalizeGuess(a, a === aReal ? xReal : xDur));
      await time.increase(3600 + 1); // pinTransfer delay
      const balR0 = await balanceOf(s, addrReal);
      const balD0 = await balanceOf(s, addrDur);
      const [e1, e2] = await both(`run ${i + 1} · executeOp (transfer)`, async (a) => (await a.executeOp(a === aReal ? xReal : xDur)).wait());
      fn.push({
        i: i + 1,
        amount: amounts[i],
        viewReal,
        viewDuress: viewDur,
        balReal: balR0,
        balDuress: balD0,
        movedReal: await debugU64(eventArgs(aReal, e1, "PrivateOpExecuted").result),
        movedDuress: await debugU64(eventArgs(aDur, e2, "PrivateOpExecuted").result),
        flagReal: flagReal && gReal,
        flagDuress: flagDur && gDur,
      });
    }

    // ── compare step by step
    const diffs: { step: string; metric: string; real: any; duress: any }[] = [];
    for (let k = 0; k < recs.real.length; k++) {
      const a = recs.real[k];
      const b = recs.duress[k];
      for (const m of STRICT) {
        if (JSON.stringify(a[m]) !== JSON.stringify(b[m])) diffs.push({ step: a.label, metric: m, real: a[m], duress: b[m] });
      }
    }
    // total gas without the mock's plaintext bookkeeping (what a production chain would charge)
    const gasDiffs = recs.real.map((a, k) => a.gasUsed - a.cleartextGas - (recs.duress[k].gasUsed - recs.duress[k].cleartextGas));
    const zeroDiffs = recs.real.map((a, k) => a.zeroBytes - recs.duress[k].zeroBytes);
    // mock-only: the raw execution gas and steps include the plaintext bookkeeping; every difference there must sit
    // entirely inside the cleartext layer
    const mockOnly = recs.real.map((a, k) => {
      const b = recs.duress[k];
      return { step: a.label, execDiff: a.exec - b.exec, cleartextGasDiff: a.cleartextGas - b.cleartextGas, stepsDiff: a.steps - b.steps, protocolStepsDiff: a.protocolSteps - b.protocolSteps };
    });
    const mockOnlyDiffering = mockOnly.filter((m) => m.execDiff !== 0 || m.stepsDiff !== 0);
    const allInsideCleartext = mockOnly.every((m) => m.execDiff === m.cleartextGasDiff && m.protocolStepsDiff === 0);
    // the same noise inside one mode: total gas of the same step across runs (same kind of tx, other random bytes)
    const byStep = (r: TxRec[], stepName: string) => r.filter((x) => x.label.endsWith(stepName));
    const within = ["submitGuess (view)", "openPrivateTransfer", "submitGuess (transfer)"].map((st) => {
      const xs = byStep(recs.real, st);
      const g = xs.map((x) => x.gasUsed - x.cleartextGas);
      const ex = xs.map((x) => x.protocolExec);
      return { step: st, realModeGasMin: Math.min(...g), realModeGasMax: Math.max(...g), realModeProtocolExecDistinct: [...new Set(ex)].length };
    });

    OUT.T3 = {
      runsPerMode: amounts.length,
      txPerMode: recs.real.length,
      strictMetrics: STRICT,
      strictDifferences: diffs.length,
      differences: diffs.slice(0, 20),
      mockCleartextLayer: {
        stepsWithRawDifference: mockOnlyDiffering.length,
        allRawDifferencesInsideCleartextLayer: allInsideCleartext,
        examples: mockOnlyDiffering.slice(0, 8),
      },
      totalGas: {
        pairsEqual: gasDiffs.filter((d) => d === 0).length,
        pairsDifferent: gasDiffs.filter((d) => d !== 0).length,
        maxAbsDiff: Math.max(...gasDiffs.map(Math.abs)),
        explainedByCalldataZeroBytes: gasDiffs.every((d, k) => d === -12 * zeroDiffs[k]),
        withinRealMode: within,
      },
      functional: fn,
      perStep: recs.real.map((a, k) => ({
        step: a.label,
        protocolExecGas: a.protocolExec,
        mockCleartextGasReal: a.cleartextGas,
        mockCleartextGasDuress: recs.duress[k].cleartextGas,
        hcu: a.hcu,
        hcuDepth: a.hcuDepth,
        steps: a.steps,
        events: a.logs.length,
        aclAllowed: a.aclAllowed.join(","),
        sstore: Object.values(a.sstore).reduce((x, y) => x + y, 0),
        calls: a.calls.length,
        calldata: a.calldataLen,
        totalGasReal: a.gasUsed,
        totalGasDuress: recs.duress[k].gasUsed,
      })),
    };
    console.log(
      "      T3 protocol differences:",
      diffs.length,
      "· raw mock differences:",
      mockOnlyDiffering.length,
      "(all inside the cleartext layer:",
      allInsideCleartext + ") · total gas pairs equal:",
      OUT.T3.totalGas.pairsEqual,
      "/",
      gasDiffs.length,
    );

    // functional sanity: the real PIN sees and moves the real balance; the duress PIN sees and moves only the decoy
    for (const r of fn) {
      expect(r.flagReal).to.eq(false);
      expect(r.flagDuress).to.eq(true);
      expect(r.viewReal).to.eq(r.balReal);
    }
    expect(diffs, JSON.stringify(diffs.slice(0, 5), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).to.have.length(0);
  });

  it("T4 · silent zero: an over-limit K-only transfer moves an encrypted zero; who learns it, and how", async () => {
    const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R.address] });
    const addr = await acct.getAddress();
    await (await s.token.mint(addr, FUND)).wait();
    const tau = await debugU64((await acct.encryptedHandles(tokenAddr)).tau);

    // (a) over the hidden limit: no revert, nothing moves, the tripwire is set
    const rBefore = await balanceOf(s, R.address);
    const enc1 = await encAmount(acct, owner, tc(5000));
    const rc1 = await (await acct.privateTransfer(tokenAddr, R.address, enc1.handles[0], enc1.inputProof)).wait();
    const st1 = await acct.privateState(tokenAddr);
    const moved1 = await debugU64(st1.lastMoved);
    const tripped1 = await debugBool((await acct.encryptedHandles(tokenAddr)).tripped);
    const rAfter1 = await balanceOf(s, R.address);
    expect(rc1.status).to.eq(1);
    expect(moved1).to.eq(0n);
    expect(rAfter1).to.eq(rBefore);
    expect(tripped1).to.eq(true);

    // (b) the tripwire is sticky: a small transfer afterwards moves zero too
    const enc2 = await encAmount(acct, owner, tc(10));
    const rc2 = await (await acct.privateTransfer(tokenAddr, R.address, enc2.handles[0], enc2.inputProof)).wait();
    const moved2 = await debugU64((await acct.privateState(tokenAddr)).lastMoved);
    expect(moved2).to.eq(0n);

    // (c) who can read the outcome: not K (no probing), the guardian (watchtower) yes, the recipient sees what it got
    const passH = (await acct.privateState(tokenAddr)).lastPass;
    const movedH = (await acct.privateState(tokenAddr)).lastMoved;
    const kReadsPass = !(await rejects(hre.fhevm.userDecryptEbool(passH, addr, owner)));
    const kReadsMoved = !(await rejects(hre.fhevm.userDecryptEuint(FhevmType.euint64, movedH, addr, owner)));
    const gPass = await hre.fhevm.userDecryptEbool(passH, addr, guardian);
    const gMoved = await hre.fhevm.userDecryptEuint(FhevmType.euint64, movedH, addr, guardian);
    const rSees = await hre.fhevm.userDecryptEuint(FhevmType.euint64, eventArgs(acct, rc2, "PrivateTransfer").moved, tokenAddr, R);
    expect(kReadsPass).to.eq(false);
    expect(kReadsMoved).to.eq(false);
    expect(gPass).to.eq(false);
    expect(gMoved).to.eq(0n);
    expect(rSees).to.eq(0n);

    // (d) within the limit but above the balance: the token itself moves zero (ERC-7984 semantics)
    const poor = await createAccountP(s, owner, escape.address, guardian.address, { known: [R.address] });
    const poorAddr = await poor.getAddress();
    await (await s.token.mint(poorAddr, tc(50))).wait();
    const enc3 = await encAmount(poor, owner, tc(100));
    await (await poor.privateTransfer(tokenAddr, R.address, enc3.handles[0], enc3.inputProof)).wait();
    const st3 = await poor.privateState(tokenAddr);
    const pass3 = await debugBool(st3.lastPass);
    const moved3 = await debugU64(st3.lastMoved);
    const spent3 = await debugU64(st3.spent);
    expect(pass3).to.eq(true);
    expect(moved3).to.eq(0n);
    expect(spent3).to.eq(0n); // spent counts only what really moved

    // (e) does a failing transfer look different on-chain from a passing one? Two fresh identical accounts, same step.
    const p = await createAccountP(s, owner, escape.address, guardian.address, { known: [R.address], salt: E.id("t4-pass") });
    const f = await createAccountP(s, owner, escape.address, guardian.address, { known: [R.address], salt: E.id("t4-fail") });
    await (await s.token.mint(await p.getAddress(), FUND)).wait();
    await (await s.token.mint(await f.getAddress(), FUND)).wait();
    const rp = new Roles();
    const rf = new Roles();
    rp.set(await p.getAddress(), "ACCOUNT");
    rf.set(await f.getAddress(), "ACCOUNT");
    for (const r of [rp, rf]) {
      r.set(tokenAddr, "TOKEN");
      r.set(owner.address, "K");
      r.set(guardian.address, "G");
      r.set(R.address, "R");
    }
    const encP = await encAmount(p, owner, tc(100));
    const encF = await encAmount(f, owner, tc(5000));
    const recP = await recordTx("pass", await (await p.privateTransfer(tokenAddr, R.address, encP.handles[0], encP.inputProof)).wait(), rp);
    const recF = await recordTx("fail", await (await f.privateTransfer(tokenAddr, R.address, encF.handles[0], encF.inputProof)).wait(), rf);
    const passVsFail = STRICT.filter((m) => JSON.stringify(recP[m]) !== JSON.stringify(recF[m]));
    const passVsFailMock = MOCK_ONLY.filter((m) => JSON.stringify(recP[m]) !== JSON.stringify(recF[m]));

    OUT.T4 = {
      overLimit: { amount: tc(5000), hiddenTauForTheTestOnly: tau, reverted: false, moved: moved1, recipientDelta: rAfter1 - rBefore, trippedAfter: tripped1, gas: Number(rc1.gasUsed) },
      stickyAfterTrip: { amount: tc(10), moved: moved2 },
      aboveBalance: { balance: tc(50), amount: tc(100), pass: pass3, moved: moved3, spentAfter: spent3 },
      whoLearns: { kReadsPassBit: kReadsPass, kReadsMoved: kReadsMoved, guardianReadsPass: !gPass ? "yes (false)" : "yes (true)", guardianReadsMoved: gMoved, recipientSeesItsAmount: rSees },
      passVsFailTraceDifferences: passVsFail,
      passVsFailMockOnly: { metrics: passVsFailMock, execDiff: recP.exec - recF.exec, cleartextGasDiff: recP.cleartextGas - recF.cleartextGas, protocolExec: [recP.protocolExec, recF.protocolExec], totalGas: [recP.gasUsed, recF.gasUsed] },
    };
    console.log("      T4", j(OUT.T4));
    expect(passVsFail).to.have.length(0);
  });
});
