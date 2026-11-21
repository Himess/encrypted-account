/**
 * Tur 8, stage 3: the guardian's temporary pause. After a silent duress alarm, the trusted contact (through the watchtower's
 * key, by a decision of their own) can pause a pending op before its delay ends. Nothing changes on-chain at the duress
 * PIN itself. Limits on a malicious guardian: one pause per op, at most GUARDIAN_PAUSE (72 h); the owner lifts it on the
 * lane (K + second device or helper + PIN); the guardian moves no funds and changes no setting.
 */
import { expect } from "chai";
import { ethers as E } from "ethers";
import { A, DAY, ETH, HOUR, R, Stack, Status, alignDecay, coder, createAccount, deployStack, errs, ethers, finalizeGuess, guess, laneGuess, opIdFromReceipt, time } from "./helpers";

const PIN = "482915";
const DURESS = "771203";
const PAUSE = 72 * HOUR;

describe("Guardian pause (temporary, lifted on the lane)", function () {
  let s: Stack;
  let owner: any, escape: any, guardian: any, device: any, alice: any, stranger: any;
  let ERR: any;

  before(async () => {
    [owner, escape, guardian, device, alice, stranger] = await ethers.getSigners();
    s = await deployStack();
    ERR = await errs();
  });

  const fresh = async (opts: any = {}) => {
    const acct = (await createAccount(s, owner, escape.address, guardian.address, { duressPin: DURESS, knownRecipients: [alice.address], device: device.address, ...opts })).connect(owner);
    await (await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("2") })).wait();
    return acct;
  };
  const verified = async (acct: any, pin = DURESS) => {
    const id = await opIdFromReceipt(acct, await (await acct.requestTransfer(ETH, alice.address, E.parseEther("1"), true)).wait());
    await guess(acct, owner, s.chainId, id, pin);
    await finalizeGuess(acct, id);
    return id;
  };

  it("a duress-approved transfer: the guardian pauses it; it cannot run until the pause ends, then runs", async () => {
    await alignDecay();
    const acct = await fresh();
    const id = await verified(acct);
    await expect(acct.connect(guardian).guardianPause(id)).to.emit(acct, "GuardianPaused");
    const ready = (await acct.getOp(id)).readyAt;
    await time.increaseTo(Number(ready) + 1);
    await expect(acct.executeOp.staticCall(id)).to.be.revertedWithCustomError(ERR, "OpPaused");
    await time.increase(PAUSE);
    const a0 = await ethers.provider.getBalance(alice.address);
    await (await acct.connect(stranger).executeOp(id)).wait();
    expect((await ethers.provider.getBalance(alice.address)) - a0).to.eq(E.parseEther("1"));
  });

  it("one pause per op; only the guardian; only a pending op; the guardian can do nothing else", async () => {
    await alignDecay();
    const acct = await fresh();
    const id = await verified(acct);
    await expect(acct.connect(stranger).guardianPause.staticCall(id)).to.be.revertedWithCustomError(ERR, "NotAuthorized");
    await expect(acct.connect(owner).guardianPause.staticCall(id)).to.be.revertedWithCustomError(ERR, "NotAuthorized");
    await (await acct.connect(guardian).guardianPause(id)).wait();
    await expect(acct.connect(guardian).guardianPause.staticCall(id)).to.be.revertedWithCustomError(ERR, "OpPaused");
    await time.increase(PAUSE + DAY);
    await expect(acct.connect(guardian).guardianPause.staticCall(id)).to.be.revertedWithCustomError(ERR, "OpPaused"); // never again
    await (await acct.executeOp(id)).wait();
    await expect(acct.connect(guardian).guardianPause.staticCall(id)).to.be.revertedWithCustomError(ERR, "BadStatus"); // executed
    await expect(acct.connect(guardian).guardianPause.staticCall(999n)).to.be.revertedWithCustomError(ERR, "BadStatus");
    // no fund or setting path for the guardian
    await expect(acct.connect(guardian).requestTransfer.staticCall(ETH, guardian.address, 1n, true)).to.be.revertedWithCustomError(ERR, "NotAuthorized");
    await expect(acct.connect(guardian).openAdmin.staticCall(A.SET_ESCAPE, "0x")).to.be.revertedWithCustomError(ERR, "NotAuthorized");
    await expect(acct.connect(guardian).startEscape.staticCall()).to.be.revertedWithCustomError(ERR, "NotAuthorized");
  });

  it("the owner lifts the pause on the lane only (K + second device + PIN), with no delay", async () => {
    await alignDecay();
    const acct = await fresh();
    const id = await verified(acct, PIN);
    await (await acct.connect(guardian).guardianPause(id)).wait();
    const up = await opIdFromReceipt(acct, await (await acct.openAdmin(A.UNPAUSE, coder.encode(["uint256"], [id]))).wait());
    await expect(guess(acct, owner, s.chainId, up, PIN)).to.be.revertedWithCustomError(ERR, "BadTrack");
    await laneGuess(acct, owner, device, s.chainId, up, PIN);
    await expect(finalizeGuess(acct, up)).to.not.be.reverted;
    expect((await acct.getOp(up)).status).to.eq(Status.Executed);
    await time.increaseTo(Number((await acct.getOp(id)).readyAt) + 1);
    await (await acct.executeOp(id)).wait(); // the pause is gone
    await expect(acct.connect(guardian).guardianPause.staticCall(id)).to.be.revertedWithCustomError(ERR, "BadStatus");
  });

  it("a paused op that would run at once (an admin op with no delay) waits for the pause instead", async () => {
    await alignDecay();
    const acct = await fresh();
    await (await acct.restrict()).wait();
    const un = await opIdFromReceipt(acct, await (await acct.openAdmin(A.UNRESTRICT, "0x")).wait());
    await (await acct.connect(guardian).guardianPause(un)).wait();
    await guess(acct, owner, s.chainId, un, DURESS);
    await finalizeGuess(acct, un);
    expect((await acct.getOp(un)).status).to.eq(Status.Delayed);
    expect((await acct.status()).restrictedReasons & BigInt(R.OWNER)).to.eq(BigInt(R.OWNER)); // still restricted
    await time.increase(PAUSE + 1);
    await (await acct.executeOp(un)).wait();
    expect((await acct.status()).restrictedReasons).to.eq(0n);
  });
});
