/**
 * Private mode: indistinguishability, run on every `npm test`. Each step is done on two accounts with the same setup and
 * history; only the secret differs (real vs duress PIN, duress PIN set or not, a K-only transfer that passes or fails).
 * Every pair of transactions is traced (debug_traceTransaction) and must be identical in execution gas and EVM steps
 * outside the mock's cleartext layer, HCU, calldata length, events, ACL grants, decryption requests, storage writes,
 * transient writes and external calls. The mock's cleartext layer stores every plaintext result and so costs less for a
 * zero than for a non-zero value: it is measured apart and never compared (the production executor has no such layer).
 */
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers as E } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { randomUint64 } from "../sdk/src";
import { DAY, FhevmType, N_RECIPIENTS, N_SPENDERS, RECORD, alignDecay, escapeConsent, ethers, finalizeGuess, fingerprint, guess, setupKnownList, time } from "./helpers";
import {
  DECOY,
  DURESS,
  FUND,
  MIN_BIG_DELAY,
  PIN,
  PRIVATE_LIMITS,
  Roles,
  StackP,
  TxRec,
  abiP,
  balanceOf,
  cleartextLayer,
  createAccountP,
  delaysP,
  deployStackP,
  diffRecs,
  encAmount,
  eventArgs,
  j,
  opIdOf,
  recordTx,
  tc,
} from "./privateHelpers";

describe("Private mode: indistinguishability (real vs duress PIN, duress set or not, pass vs fail)", function () {
  let s: StackP;
  let owner: HardhatEthersSigner, escape: HardhatEthersSigner, guardian: HardhatEthersSigner, R1: HardhatEthersSigner;
  let token: string;
  let CLEAR = "";
  const report: Record<string, any> = { generatedAt: new Date().toISOString(), evidence: "[Mock] traces without the cleartext layer" };

  before(async () => {
    [, owner, escape, guardian, R1] = await ethers.getSigners();
    s = await deployStackP();
    token = await s.token.getAddress();
    CLEAR = await cleartextLayer(await s.implP.executorAddress());
    await (await s.token.mint(R1.address, tc(1))).wait();
  });

  after(() => {
    if (!RECORD) return;
    const dir = path.join(__dirname, "..", "results", "private-mode");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "indistinguishability-mock.json"), j(report) + "\n");
  });

  const rolesFor = (acct: string) =>
    new Roles()
      .set(acct, "ACCOUNT")
      .set(token, "TOKEN")
      .set(owner.address, "K")
      .set(guardian.address, "G")
      .set(escape.address, "E")
      .set(R1.address, "R");

  /** Runs `f` on both accounts back to back and records both transactions. */
  function pairRunner(a: any, b: any, recsA: TxRec[], recsB: TxRec[]) {
    const ra = rolesFor(a.target as string);
    const rb = rolesFor(b.target as string);
    for (const [addr, n] of [[s.implP.target, "IMPL_P"], [s.module.target, "MODULE"], ...Object.entries(s.libs).map(([k, v]) => [v, k])] as [string, string][]) {
      ra.set(addr, n);
      rb.set(addr, n);
    }
    return async (label: string, f: (acct: any, which: 0 | 1) => Promise<any>) => {
      const r1 = await f(a, 0);
      const r2 = await f(b, 1);
      recsA.push(await recordTx(label, r1, ra, CLEAR));
      recsB.push(await recordTx(label, r2, rb, CLEAR));
      return [r1, r2] as const;
    };
  }

  function compare(name: string, recsA: TxRec[], recsB: TxRec[]) {
    const diffs = recsA.flatMap((x, k) => diffRecs(x, recsB[k]).map((m) => ({ step: x.label, metric: m, a: (x as any)[m], b: (recsB[k] as any)[m] })));
    const rawMock = recsA.filter((x, k) => x.exec !== recsB[k].exec || x.steps !== recsB[k].steps).length;
    const allInLayer = recsA.every((x, k) => x.exec - recsB[k].exec === x.cleartextGas - recsB[k].cleartextGas);
    const gasNoise = recsA.map((x, k) => x.gasUsed - x.cleartextGas - (recsB[k].gasUsed - recsB[k].cleartextGas));
    const zeroDiff = recsA.map((x, k) => x.zeroBytes - recsB[k].zeroBytes);
    report[name] = {
      txPairs: recsA.length,
      strictDifferences: diffs.length,
      differences: diffs.slice(0, 10),
      mockRawDifferences: rawMock,
      allRawDifferencesInsideCleartextLayer: allInLayer,
      totalGasDifferencesExplainedByCalldataZeroBytes: gasNoise.every((g, k) => g === -12 * zeroDiff[k]),
      maxTotalGasDifference: Math.max(0, ...gasNoise.map(Math.abs)),
    };
    console.log(`      ${name}: ${recsA.length} pairs · strict differences ${diffs.length} · raw mock differences ${rawMock} (inside the cleartext layer: ${allInLayer})`);
    expect(allInLayer, "a raw difference outside the cleartext layer").to.eq(true);
    expect(diffs, j(diffs.slice(0, 3))).to.have.length(0);
  }

  it("real PIN vs duress PIN: views, transfers (within and above the decoy), reset, duress setting, PIN change", async () => {
    const real = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address], duressPin: DURESS, salt: E.id("ind-real") });
    const dur = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address], duressPin: DURESS, salt: E.id("ind-duress") });
    await (await s.token.mint(await real.getAddress(), FUND)).wait();
    await (await s.token.mint(await dur.getAddress(), FUND)).wait();
    const recsA: TxRec[] = [];
    const recsB: TxRec[] = [];
    const both = pairRunner(real, dur, recsA, recsB);
    const pinFor = (w: 0 | 1, realPin = PIN, duressPin = DURESS) => (w === 0 ? realPin : duressPin);

    /** open → guess → finalize on both accounts, each step recorded as a pair. */
    const pinOp = async (label: string, open: (acct: any) => Promise<any>, pins: [string, string] = [PIN, DURESS]) => {
      const [o1, o2] = await both(`${label} · open`, async (acct) => (await open(acct)).wait());
      const ids = [opIdOf(real, o1), opIdOf(dur, o2)];
      await both(`${label} · guess`, async (acct, w) => guess(acct, owner, s.chainId, ids[w], pins[w]));
      const fins = await both(`${label} · finalize`, async (acct, w) => finalizeGuess(acct, ids[w]));
      return { ids, fins };
    };

    const seen: Record<string, bigint[]> = {};
    for (let round = 0; round < 2; round++) {
      await alignDecay(); // a round spans < 7 days: no decay boundary between the two sides of a pair
      const v = await pinOp(`round ${round + 1} · view`, (acct) => acct.openPrivateView(token));
      seen[`view${round}`] = [
        await hre.fhevm.userDecryptEuint(FhevmType.euint64, eventArgs(real, v.fins[0], "PrivateOpExecuted").result, real.target as string, owner),
        await hre.fhevm.userDecryptEuint(FhevmType.euint64, eventArgs(dur, v.fins[1], "PrivateOpExecuted").result, dur.target as string, owner),
      ];
      const amount = round === 0 ? tc(1500) : tc(800); // the second is above the 500 the decoy has left
      const t = await pinOp(`round ${round + 1} · transfer`, async (acct) => {
        const enc = await encAmount(acct, owner, amount);
        return acct.openPrivateTransfer(token, R1.address, enc.handles[0], enc.inputProof);
      });
      await time.increase(MIN_BIG_DELAY + 1);
      await both(`round ${round + 1} · transfer · execute`, async (acct, w) => (await acct.executeOp(t.ids[w])).wait());
    }
    await alignDecay();
    await pinOp("reset", (acct) => acct.openPrivateReset(token));
    const sd = await pinOp("set duress", async (acct) => {
      const inp = hre.fhevm.createEncryptedInput(acct.target as string, owner.address);
      inp.add64(await fingerprint(DURESS, s.chainId, acct.target as string));
      inp.addBool(true);
      inp.add64(DECOY);
      const enc = await inp.encrypt();
      return acct.openSetDuress(token, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof);
    });
    await time.increase(Number((await real.delays()).settings) + 1);
    await both("set duress · execute", async (acct, w) => (await acct.executeOp(sd.ids[w])).wait());
    await alignDecay();
    const pc = await pinOp("PIN change", async (acct) => {
      const inp = hre.fhevm.createEncryptedInput(acct.target as string, owner.address);
      inp.add64(await fingerprint("246813", s.chainId, acct.target as string));
      const enc = await inp.encrypt();
      return acct.openPinChange(enc.handles[0], enc.inputProof);
    });
    await time.increase(Number((await real.delays()).settings) + 1);
    await both("PIN change · execute", async (acct, w) => (await acct.executeOp(pc.ids[w])).wait());

    // what each side saw and moved
    expect(seen.view0).to.deep.eq([FUND, DECOY]);
    expect(seen.view1).to.deep.eq([FUND - tc(1500), tc(500)]);
    expect(await balanceOf(s, real.target as string)).to.eq(FUND - tc(2300));
    expect(await balanceOf(s, dur.target as string)).to.eq(FUND - tc(1500));
    compare("realVsDuress", recsA, recsB);
  });

  it("a duress PIN set or not: setup and a real-PIN view look the same", async () => {
    // both accounts are built step by step so that every setup transaction is recorded
    const build = async (salt: string, duress: boolean, recs: TxRec[]) => {
      const d = await delaysP(s);
      const addr = await s.factoryP.predictAddress(owner.address, escape.address, guardian.address, d, E.id(salt));
      await (await s.factoryP.createAccountWithDelays(owner.address, escape.address, guardian.address, d, E.id(salt), await escapeConsent(escape, s.chainId, addr, 0))).wait();
      const acct: any = new ethers.Contract(addr, await abiP(), owner);
      const roles = rolesFor(addr).set(s.implP.target as string, "IMPL_P").set(s.module.target as string, "MODULE");
      for (const [k, v] of Object.entries(s.libs)) roles.set(v, k);
      const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
      inp.add64(await fingerprint(PIN, s.chainId, addr));
      inp.add64(duress ? await fingerprint(DURESS, s.chainId, addr) : randomUint64());
      inp.addBool(duress);
      const e = await inp.encrypt();
      recs.push(await recordTx("setupPin", await (await acct.setupPin(e.handles[0], e.handles[1], e.handles[2], e.inputProof)).wait(), roles, CLEAR));
      const inp2 = hre.fhevm.createEncryptedInput(addr, owner.address);
      inp2.add64(PRIVATE_LIMITS.lmin);
      inp2.add64(PRIVATE_LIMITS.lmax);
      inp2.add64(duress ? DECOY : randomUint64() & ((1n << 62n) - 1n));
      const e2 = await inp2.encrypt();
      recs.push(await recordTx("privateSetupAsset", await (await acct.privateSetupAsset(token, e2.handles[0], e2.handles[1], e2.handles[2], e2.inputProof)).wait(), roles, CLEAR));
      await setupKnownList(acct, owner, false, [R1.address], N_RECIPIENTS);
      await setupKnownList(acct, owner, true, [], N_SPENDERS);
      await (await acct.setupRoles(E.ZeroAddress, E.ZeroAddress, 90 * DAY, true)).wait();
      await (await acct.arm()).wait();
      await (await s.token.mint(addr, FUND)).wait();
      return { acct, roles };
    };
    const recsA: TxRec[] = [];
    const recsB: TxRec[] = [];
    const a = await build("ind-no-duress", false, recsA);
    const b = await build("ind-with-duress", true, recsB);
    await alignDecay();
    for (const [x, recs] of [[a, recsA], [b, recsB]] as const) {
      const rc = await (await x.acct.openPrivateView(token)).wait();
      const id = opIdOf(x.acct, rc);
      recs.push(await recordTx("view · open", rc, x.roles, CLEAR));
      recs.push(await recordTx("view · guess", await guess(x.acct, owner, s.chainId, id, PIN), x.roles, CLEAR));
      recs.push(await recordTx("view · finalize", await finalizeGuess(x.acct, id), x.roles, CLEAR));
    }
    compare("duressSetOrNot", recsA, recsB);
  });

  it("a K-only private transfer that passes vs one that fails (unknown limit, tripwire): the same trace", async () => {
    const p = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address], salt: E.id("ind-pass") });
    const f = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address], salt: E.id("ind-fail") });
    await (await s.token.mint(p.target as string, FUND)).wait();
    await (await s.token.mint(f.target as string, FUND)).wait();
    const recsA: TxRec[] = [];
    const recsB: TxRec[] = [];
    const both = pairRunner(p, f, recsA, recsB);
    await time.increaseTo((Math.floor((await time.latest()) / DAY) + 1) * DAY + 600); // inside one UTC day
    const amounts: [bigint, bigint][] = [
      [tc(100), tc(5000)], // passes vs over the limit (trips)
      [tc(50), tc(10)], // passes vs blocked by the fired tripwire
    ];
    for (const [k, [x, y]] of amounts.entries()) {
      await both(`K-only ${k + 1}`, async (acct, w) => {
        const enc = await encAmount(acct, owner, w === 0 ? x : y);
        return (await acct.privateTransfer(token, R1.address, enc.handles[0], enc.inputProof)).wait();
      });
    }
    compare("kOnlyPassVsFail", recsA, recsB);
  });
});
