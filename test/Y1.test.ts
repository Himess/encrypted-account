import { expect } from "chai";
import { ethers as E } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { A, ETH, R, Stack, TRACK, alignDecay, coder, createAccount, deployStack, encGuess, errs, ethers, finalizeGuess, guess, requestTransfer, time } from "./helpers";

/**
 * F0.10 step 1 — Y1 (Round 2 report §2): the counter-reset loop. This test requires the FIXED behavior (I20); it
 * FAILED on the Round 1 code (observation: results/y1-baseline.json, kept as is). The observation on the F0.10 code
 * is written to results/y1-f010.json.
 *
 * Scenario (only K stolen, the owner still holds the PIN; K is shared, so "attacker" and "owner" are the same signer here):
 *   1) the attacker opens a PIN path transfer to their own address and makes 3 wrong guesses → restricted mode + 15 min back-off
 *   2) the owner waits out the back-off and opens a key rotation (ROTATE_OWNER, 24 h) with K+P → correct PIN
 *   3) the attacker guesses again right away: under I20 this must hit the back-off (Backoff); on the Round 1 code it did not
 */
describe("F0.10.1 — Y1: does a correct PIN reset the attacker's wrong-guess counter (I20, current behavior)", function () {
  let stack: Stack;
  let owner: any, escape: any, guardian: any, alice: any, thief: any, newKey: any;
  let ERR: any;
  const PIN = "482915";
  const WRONG = ["111111", "123123", "999999", "246810"];

  before(async () => {
    [owner, escape, guardian, alice, thief, newKey] = await ethers.getSigners();
    stack = await deployStack();
    ERR = await errs();
  });

  it("attacker 3 wrong → owner correct PIN → the attacker's next guess must hit the back-off (I20)", async () => {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address] });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("5") });
    await alignDecay(); // keep the score arithmetic from straddling a decay boundary

    // 1) the attacker's op and 3 wrong guesses
    const opA = await requestTransfer(acct, owner, ETH, thief.address, E.parseEther("1"), true);
    for (let k = 0; k < 3; k++) {
      await guess(acct, owner, stack.chainId, opA, WRONG[k]);
      await finalizeGuess(acct, opA);
    }
    const afterStrikes = {
      track: (await acct.trackState(TRACK.OWNER)).toObject(),
      shared: (await acct.sharedBudget()).toObject(),
      restricted: Number((await acct.status()).restrictedReasons),
    };
    expect(afterStrikes.restricted & R.STRIKES).to.eq(R.STRIKES);
    expect(afterStrikes.track.nextAllowedAt).to.be.greaterThan(BigInt(await time.latest()));

    // 2) owner: waits (shared K-track — the attacker's back-off makes the owner wait too), opens the key rotation, correct PIN
    await time.increaseTo(Number(afterStrikes.track.nextAllowedAt));
    const rc = await (await acct.connect(owner).openAdmin(A.ROTATE_OWNER, coder.encode(["address"], [newKey.address]))).wait();
    const opRot = (await acct.opCount()) as bigint;
    void rc;
    await guess(acct, owner, stack.chainId, opRot, PIN);
    await finalizeGuess(acct, opRot);
    const afterOwner = {
      track: (await acct.trackState(TRACK.OWNER)).toObject(),
      shared: (await acct.sharedBudget()).toObject(),
      restricted: Number((await acct.status()).restrictedReasons),
      rotationReadyAt: (await acct.getOp(opRot)).readyAt,
    };

    // 3) the attacker retries immediately (staticCall: the alpha plugin cannot decode reverts through the clone)
    const enc = await encGuess(acct, owner.address, stack.chainId, opA, WRONG[3]);
    let thiefCanGuessNow = true;
    let thiefRevert = "";
    let thiefRevertName = "";
    try {
      await acct.connect(owner).submitGuess.staticCall(opA, enc.c, enc.handles[0], enc.inputProof);
    } catch (e: any) {
      thiefCanGuessNow = false;
      thiefRevert = String(e?.shortMessage ?? e?.message ?? e).slice(0, 160);
      try {
        thiefRevertName = ERR.interface.parseError(e?.data ?? e?.error?.data ?? "0x")?.name ?? "";
      } catch {
        /* could not decode */
      }
    }

    const ser = (o: any) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const now = BigInt(await time.latest());
    const observed = {
      evidence: "[Mock] F0.10 code (K43 + K56 + T2)",
      generatedAtUtc: new Date().toISOString(),
      afterThreeWrong: ser(afterStrikes),
      afterOwnerCorrectPin: ser(afterOwner),
      scoreKeptOnSuccess: afterOwner.track.score === afterStrikes.track.score,
      restrictionLiftedByOwnerPin: (afterOwner.restricted & R.STRIKES) === 0,
      thiefCanGuessImmediatelyAfterOwnerPin: thiefCanGuessNow,
      thiefWaitS: Number(afterOwner.track.nextAllowedAt - now),
      thiefRevert,
      thiefRevertName,
      baseline: "results/y1-baseline.json (Round 1: the score/shared budget was reset, the attacker guessed without back-off)",
    };
    fs.writeFileSync(path.join(__dirname, "..", "results", "y1-f010.json"), JSON.stringify(observed, null, 2));
    console.log("      Y1 observation:", JSON.stringify({ scoreKept: observed.scoreKeptOnSuccess, unrestricted: observed.restrictionLiftedByOwnerPin, thiefCanGuessNow, thiefWaitS: observed.thiefWaitS }));

    // I20: a correct PIN does not reset the wrong-guess score → the attacker's guess must hit the back-off
    expect(thiefCanGuessNow, "Y1: the owner's correct PIN reset the attacker's wrong-guess counter; the attacker can guess again without back-off").to.eq(false);
    expect(thiefRevert).to.match(/Backoff|0x[0-9a-f]{8}/i);
    expect(observed.scoreKeptOnSuccess).to.eq(true);
    expect(observed.restrictionLiftedByOwnerPin).to.eq(false); // K43: score 3 → only UNRESTRICT lifts it
    expect(observed.thiefWaitS).to.be.within(15 * 60 - 3, 15 * 60); // T2(3) = 15 min from the owner's PIN
  });
});
