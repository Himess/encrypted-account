/**
 * Standard account (open mode): real PIN vs duress PIN, run on every `npm test`. The account only learns "a PIN matched";
 * the duress flag goes to the guardian alone, so nothing on-chain may differ. Each step runs on two accounts with the same
 * setup and history and is traced as in PrivateIndistinguishability.test.ts (own file: the traces are memory-heavy, and
 * each test file runs in its own process).
 */
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers as E } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { A, DAY, ETH, RECORD, Stack, alignDecay, coder, createAccount, deployStack, ethers, finalizeGuess, fingerprint, guess, time } from "./helpers";
import { DURESS, PIN, Roles, TxRec, cleartextLayer, diffRecs, j, opIdOf, recordTx } from "./privateHelpers";

describe("Standard account: real PIN vs duress PIN (indistinguishability)", function () {
  let s: Stack;
  let owner: HardhatEthersSigner, escape: HardhatEthersSigner, guardian: HardhatEthersSigner, R1: HardhatEthersSigner;

  before(async () => {
    [, owner, escape, guardian, R1] = await ethers.getSigners();
    s = await deployStack();
  });

  it("an ETH transfer, an admin op and a PIN change: the same traces", async () => {
    const CLEAR = await cleartextLayer(await s.impl.executorAddress());
    const mk = async (salt: string) =>
      (await createAccount(s, owner, escape.address, guardian.address, { duressPin: DURESS, knownRecipients: [R1.address] }, E.id(salt))).connect(owner);
    const real = await mk("std-real");
    const dur = await mk("std-duress");
    for (const a of [real, dur]) await (await owner.sendTransaction({ to: a.target as string, value: E.parseEther("1") })).wait();
    const roles = (acct: string) => {
      const r = new Roles().set(acct, "ACCOUNT").set(owner.address, "K").set(guardian.address, "G").set(escape.address, "E").set(R1.address, "R").set(s.impl.target as string, "IMPL");
      for (const [k, v] of Object.entries(s.libs)) r.set(v, k);
      return r;
    };
    const ra = roles(real.target as string);
    const rb = roles(dur.target as string);
    const recsA: TxRec[] = [];
    const recsB: TxRec[] = [];
    const both = async (label: string, f: (acct: any, w: 0 | 1) => Promise<any>) => {
      const r1 = await f(real, 0);
      const r2 = await f(dur, 1);
      recsA.push(await recordTx(label, r1, ra, CLEAR));
      recsB.push(await recordTx(label, r2, rb, CLEAR));
      return [r1, r2] as const;
    };
    const d = await real.delays();
    const pinOp = async (label: string, open: (acct: any) => Promise<any>, wait: bigint) => {
      const [o1, o2] = await both(`${label} · open`, async (acct) => (await open(acct)).wait());
      const ids = [opIdOf(real, o1), opIdOf(dur, o2)];
      await both(`${label} · guess`, async (acct, w) => guess(acct, owner, s.chainId, ids[w], w === 0 ? PIN : DURESS));
      await both(`${label} · finalize`, async (acct, w) => finalizeGuess(acct, ids[w]));
      await time.increase(Number(wait) + 1);
      await both(`${label} · execute`, async (acct, w) => (await acct.executeOp(ids[w])).wait());
    };
    await alignDecay();
    await pinOp("ETH transfer", (acct) => acct.requestTransfer(ETH, R1.address, E.parseEther("0.05"), true), d.pinTransfer);
    await alignDecay();
    await pinOp("set pulse", (acct) => acct.openAdmin(A.SET_PULSE, coder.encode(["uint32"], [30 * DAY])), d.loosen);
    await alignDecay();
    await pinOp(
      "PIN change",
      async (acct) => {
        const inp = hre.fhevm.createEncryptedInput(acct.target as string, owner.address);
        inp.add64(await fingerprint("246813", s.chainId, acct.target as string));
        const enc = await inp.encrypt();
        return acct.openPinChange(enc.handles[0], enc.inputProof);
      },
      d.settings,
    );

    const diffs = recsA.flatMap((x, k) => diffRecs(x, recsB[k]).map((m) => ({ step: x.label, metric: m, a: (x as any)[m], b: (recsB[k] as any)[m] })));
    const rawMock = recsA.filter((x, k) => x.exec !== recsB[k].exec || x.steps !== recsB[k].steps).length;
    const allInLayer = recsA.every((x, k) => x.exec - recsB[k].exec === x.cleartextGas - recsB[k].cleartextGas);
    console.log(`      standardRealVsDuress: ${recsA.length} pairs · strict differences ${diffs.length} · raw mock differences ${rawMock} (inside the cleartext layer: ${allInLayer})`);
    if (RECORD) {
      const out = { generatedAt: new Date().toISOString(), evidence: "[Mock] traces without the cleartext layer", standardRealVsDuress: { txPairs: recsA.length, strictDifferences: diffs.length, mockRawDifferences: rawMock, allRawDifferencesInsideCleartextLayer: allInLayer } };
      fs.writeFileSync(path.join(__dirname, "..", "results", "private-mode", "indistinguishability-standard-mock.json"), j(out) + "\n");
    }
    expect(allInLayer, "a raw difference outside the cleartext layer").to.eq(true);
    expect(diffs, j(diffs.slice(0, 3))).to.have.length(0);
  });
});
