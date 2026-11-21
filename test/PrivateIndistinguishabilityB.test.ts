/**
 * Private mode: indistinguishability, part B (part A: test/PrivateIndistinguishability.test.ts, real vs duress PIN). Each
 * step is done on two accounts with the same setup and history; only the secret differs: a duress PIN set or not, and a
 * K-only transfer that passes or fails.
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
  DURESS,
  FUND,
  HIDDEN,
  MIN_BIG_DELAY,
  PIN,
  PRIVATE_LIMITS,
  SHOWN,
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

describe("Private mode: indistinguishability, duress set or not and K-only pass vs fail (part B)", function () {
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
    // Warm-up, not recorded: the first account set up in a fresh chain writes shared slots for the first time (the FHE
    // executor's random counter, zero to non-zero: 17,100 gas more), and the side built first would pay it. In part A
    // the first pairs warm them; on Sepolia they were written long ago.
    await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address], salt: E.id("ind-b-warmup") });
  });

  after(() => {
    if (!RECORD) return;
    // two files fill this report (each runs in its own process: the traces are memory-heavy)
    const dir = path.join(__dirname, "..", "results", "private-mode");
    const file = path.join(dir, "indistinguishability-mock.json");
    fs.mkdirSync(dir, { recursive: true });
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    fs.writeFileSync(file, j({ ...prev, ...report }) + "\n");
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
      inp2.add64(duress ? HIDDEN : 0n); // the hidden amount, encrypted either way
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
