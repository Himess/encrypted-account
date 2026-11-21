/**
 * Cost of the private-mode paths on the mock (not part of `npm test`): a K-only private transfer in steady state, a PIN
 * view (its finalize, which runs it) and a PIN private transfer (its execution), each under the real and the duress PIN.
 * Protocol gas leaves out the mock's cleartext layer (see test/privateHelpers.ts), HCU is the tx's homomorphic cost.
 *
 *   COST_OUT=results/private-mode/cost-r8-after.json npx hardhat test scripts/measure/private-cost.ts
 *
 * It uses only calls whose signature is the same in both private-mode builds, so the same file measures the first build
 * (decoy cap) and the current one (hidden amount).
 */
import { expect } from "chai";
import * as fs from "fs";
import { ethers as E } from "ethers";
import { alignDecay, ethers, finalizeGuess, guess, time } from "../../test/helpers";
import {
  DURESS,
  FUND,
  HIDDEN,
  MIN_BIG_DELAY,
  PIN,
  Roles,
  cleartextLayer,
  createAccountP,
  deployStackP,
  encAmount,
  opIdOf,
  recordTx,
  tc,
} from "../../test/privateHelpers";

describe("private-mode cost (mock)", function () {
  it("K-only transfer, PIN view, PIN transfer: protocol gas and HCU", async () => {
    const [, owner, escape, guardian, R1, other] = await ethers.getSigners();
    const s = await deployStackP();
    const token = await s.token.getAddress();
    const clear = await cleartextLayer(await s.implP.executorAddress());
    const out: Record<string, any> = { generatedAt: new Date().toISOString() };
    const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address], duressPin: DURESS, hidden: HIDDEN, salt: E.id("cost") });
    const addr = await acct.getAddress();
    await (await s.token.mint(addr, FUND)).wait();
    const roles = new Roles().set(addr, "ACCOUNT").set(token, "TOKEN");
    const rec = async (label: string, rc: any) => {
      const r = await recordTx(label, rc, roles, clear);
      return { gasUsed: r.gasUsed, protocolGas: r.gasUsed - r.cleartextGas, hcu: r.hcu, hcuDepth: r.hcuDepth };
    };
    // K-only: the first transfer opens the account's one-time slots; the second is the steady state
    for (const k of [0, 1]) {
      const enc = await encAmount(acct, owner, tc(10));
      const rc = await (await acct.privateTransfer(token, R1.address, enc.handles[0], enc.inputProof)).wait();
      if (k === 1) out.kOnlyTransfer = await rec("kOnly", rc);
    }
    for (const [mode, pin] of [["real", PIN], ["duress", DURESS]] as const) {
      await alignDecay();
      const v = await (await acct.openPrivateView(token)).wait();
      const vid = opIdOf(acct, v);
      await guess(acct, owner, s.chainId, vid, pin);
      out[`viewFinalize_${mode}`] = await rec("view", await finalizeGuess(acct, vid));
      const enc = await encAmount(acct, owner, tc(100));
      const t = await (await acct.openPrivateTransfer(token, other.address, enc.handles[0], enc.inputProof)).wait();
      const tid = opIdOf(acct, t);
      await guess(acct, owner, s.chainId, tid, pin);
      await finalizeGuess(acct, tid);
      await time.increase(MIN_BIG_DELAY + 1);
      out[`transferExecute_${mode}`] = await rec("exec", await (await acct.executeOp(tid)).wait());
    }
    console.log(JSON.stringify(out, null, 1));
    expect(out.kOnlyTransfer.hcu).to.be.greaterThan(0);
    if (process.env.COST_OUT) fs.writeFileSync(process.env.COST_OUT, JSON.stringify(out, null, 1) + "\n");
  });
});
