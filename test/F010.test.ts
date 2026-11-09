import { expect } from "chai";
import { ethers as E } from "ethers";
import * as hre from "hardhat";
import {
  A,
  DAY,
  ETH,
  HOUR,
  R,
  Stack,
  Status,
  TRACK,
  alignDecay,
  challengeFromReceipt,
  coder,
  createAccount,
  debugU64,
  defaultDelays,
  deployStack,
  eip712Domain,
  encGuess,
  errs,
  escapeConsent,
  escapePingSig,
  ethers,
  finalizeGuess,
  fingerprint,
  guess,
  guessAndFinalize,
  laneGuess,
  opIdFromReceipt,
  personalSign,
  requestTransfer,
  time,
} from "./helpers";

/**
 * F0.10 (Round 2 work package §7.3) — Y1/Y2 fixes, K53 and K55:
 *   K43 + K56 score semantics · K44 + K54 escape lock · K45 rotation lock · K46 T2 · K53 challenge · K55 E_addr
 * Invariants: I20 (Y1.test.ts and here), I21 (v0.4), I22, I23, I24. Scenarios: 1, 3, 4, 5 and 10 of v0.3 §11.4
 * under the new semantics (11: Pin.test.ts) and the extra scenarios from the brief.
 * Note: K is shared, so "thief" and "owner" are the same signer on the K-track in these tests (owner); the only difference is knowing the PIN.
 */
describe("F0.10 — score, escape and rotation locks, challenge consistency, escape address consent", function () {
  let stack: Stack;
  let owner: any, escape: any, guardian: any, alice: any, bob: any, newKey: any, device: any, helper: any, relayer: any, thief: any;
  let escape2: any, walletOwner: any, stranger: any;
  let ERR: any;
  const PIN = "482915";
  const ESC_TYPES = { EscapeAddress: [{ name: "escape", type: "address" }, { name: "nonce", type: "uint32" }] };

  before(async () => {
    [owner, escape, guardian, alice, bob, newKey, device, helper, relayer, thief, escape2, walletOwner, stranger] = await ethers.getSigners();
    stack = await deployStack();
    ERR = await errs();
  });

  async function fresh(opts: any = {}) {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address], ...opts });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("10") });
    return acct;
  }

  const openAdminOp = async (acct: any, signer: any, a: number, p: string) => opIdFromReceipt(acct, await (await acct.connect(signer).openAdmin(a, p)).wait());

  async function openRecovery(acct: any, by: any, newOwner: any) {
    const addr = await acct.getAddress();
    const epoch = (await acct.status()).ownerEpoch;
    const payload = E.keccak256(coder.encode(["address", "uint32"], [newOwner.address, epoch]));
    const sig = await personalSign(newOwner, "encrypted-account/recovery/v1", stack.chainId, addr, payload);
    return await opIdFromReceipt(acct, await (await acct.connect(by).openRecovery(newOwner.address, sig, "0x")).wait());
  }

  async function recoveryGuess(acct: any, by: any, opId: bigint, pin: string) {
    const enc = await encGuess(acct, by.address, stack.chainId, opId, pin);
    const bond = await acct.recoveryBond();
    await (await acct.connect(by).submitRecoveryGuess(opId, enc.c, enc.handles[0], enc.inputProof, { value: bond })).wait();
  }

  const restricted = async (acct: any) => Number((await acct.status()).restrictedReasons);
  const score = async (acct: any, track: number) => (await acct.trackState(track)).score as bigint;
  const pendingRotations = async (acct: any) => (await acct.escapeState()).rotationsPending as bigint;

  // ───────────────────────────── K43 + K56: score semantics ─────────────────────────────

  describe("K43 + K56 — score semantics", function () {
    it("I20: a correct PIN does not lower the score; the provisional +1 is refunded; the owner's PIN also updates the last-attempt time", async () => {
      const acct = await fresh();
      await alignDecay();
      const op = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("1"), true);
      await guess(acct, owner, stack.chainId, op, "111111");
      await finalizeGuess(acct, op);
      expect(await score(acct, TRACK.OWNER)).to.eq(1n);
      await guess(acct, owner, stack.chainId, op, PIN);
      expect(await score(acct, TRACK.OWNER)).to.eq(2n); // +1 before the result is known (I10)
      const t0 = BigInt(await time.latest());
      await finalizeGuess(acct, op);
      const st = await acct.trackState(TRACK.OWNER);
      expect(st.score).to.eq(1n); // only the provisional +1 was refunded
      expect(st.lastAt).to.be.within(t0 - 1n, t0);
    });

    it("owner enters the correct PIN after 2 typos → provisional restriction on submission, lifted automatically on the result", async () => {
      const acct = await fresh();
      await alignDecay();
      const op = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("1"), true);
      for (const w of ["111111", "222222"]) {
        await guess(acct, owner, stack.chainId, op, w);
        await finalizeGuess(acct, op);
      }
      expect(await restricted(acct)).to.eq(0);
      await guess(acct, owner, stack.chainId, op, PIN); // score reaches 3 → restricted before the result (I18)
      expect((await restricted(acct)) & R.STRIKES).to.eq(R.STRIKES);
      expect((await acct.getGuess(op)).setStrikes).to.eq(true);
      await finalizeGuess(acct, op); // refund → score 2 < 3 → lifted
      expect(await restricted(acct)).to.eq(0);
      expect(await score(acct, TRACK.OWNER)).to.eq(2n);
      expect((await acct.getOp(op)).status).to.eq(Status.Delayed);
    });

    it("decay: the score drops by 1 at every 7-day calendar boundary; decay does not lift the restriction; with score < 3 the next correct PIN lifts it", async () => {
      const acct = await fresh();
      await alignDecay();
      const op = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("1"), true);
      for (const w of ["111111", "222222", "333333"]) {
        await guess(acct, owner, stack.chainId, op, w);
        await finalizeGuess(acct, op);
      }
      expect(await score(acct, TRACK.OWNER)).to.eq(3n);
      await alignDecay(); // one boundary passed
      expect(await score(acct, TRACK.OWNER)).to.eq(2n);
      expect((await restricted(acct)) & R.STRIKES).to.eq(R.STRIKES); // decay does not lift it
      await guessAndFinalize(acct, owner, stack.chainId, op, PIN);
      expect(await restricted(acct)).to.eq(0);
      expect(await score(acct, TRACK.OWNER)).to.eq(2n);
    });

    it("attacker makes 3 wrong guesses, owner enters the correct PIN → the restriction stays; the owner approves UNRESTRICT after 15 min", async () => {
      const acct = await fresh();
      await alignDecay();
      const op = await requestTransfer(acct, owner, ETH, thief.address, E.parseEther("1"), true);
      for (const w of ["111111", "222222", "333333"]) {
        await guess(acct, owner, stack.chainId, op, w);
        await finalizeGuess(acct, op);
      }
      await time.increase(15 * 60);
      const t = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.1"), true);
      await guessAndFinalize(acct, owner, stack.chainId, t, PIN);
      expect((await restricted(acct)) & R.STRIKES).to.eq(R.STRIKES);
      const un = await openAdminOp(acct, owner, A.UNRESTRICT, "0x");
      await expect(guess(acct, owner, stack.chainId, un, PIN)).to.be.revertedWithCustomError(ERR, "Backoff");
      await time.increase(15 * 60);
      await guessAndFinalize(acct, owner, stack.chainId, un, PIN);
      expect(await restricted(acct)).to.eq(0);
      // after UNRESTRICT the owner's correct PIN does not re-restrict the account (it withdraws its own provisional mark)
      await time.increase(15 * 60);
      const t2 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.1"), true);
      await guess(acct, owner, stack.chainId, t2, PIN);
      expect((await restricted(acct)) & R.STRIKES).to.eq(R.STRIKES); // provisional on submission
      await finalizeGuess(acct, t2);
      expect(await restricted(acct)).to.eq(0);
    });

    it("K56: when a rotation executes the K-track score resets and the recovery-track score is kept; the shared budget is the sum of both scores", async () => {
      const acct = await fresh();
      await alignDecay();
      const t = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("1"), true);
      for (const w of ["111111", "222222"]) {
        await guess(acct, owner, stack.chainId, t, w);
        await finalizeGuess(acct, t);
      }
      const rec = await openRecovery(acct, thief, thief);
      await recoveryGuess(acct, thief, rec, "333333");
      await finalizeGuess(acct, rec);
      expect((await acct.sharedBudget()).score).to.eq(3n); // 2 + 1
      // shared back-off: 15 min from the last anonymous attempt (recovery track); the K-track is blocked too
      await expect(guess(acct, owner, stack.chainId, t, PIN)).to.be.revertedWithCustomError(ERR, "Backoff");
      await time.increase(15 * 60);
      const rot = await openAdminOp(acct, owner, A.ROTATE_OWNER, coder.encode(["address"], [newKey.address]));
      await guessAndFinalize(acct, owner, stack.chainId, rot, PIN);
      expect(await score(acct, TRACK.OWNER)).to.eq(2n);
      await time.increase(DAY);
      await (await acct.executeOp(rot)).wait();
      expect(await acct.owner()).to.eq(newKey.address);
      expect(await score(acct, TRACK.OWNER)).to.eq(0n);
      expect(await score(acct, TRACK.RECOVERY)).to.eq(1n);
      expect((await acct.sharedBudget()).score).to.eq(1n);
    });
  });

  it("side finding: after a key rotation the old key's pending PIN outflows drop out of pinCommitted (in Round 1 they stayed)", async () => {
    const acct = await fresh();
    const x = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("2"), true);
    await guessAndFinalize(acct, owner, stack.chainId, x, PIN); // Delayed (1 h), pinCommitted = 2 ETH
    expect((await acct.assetState(ETH)).pinCommitted).to.eq(E.parseEther("2"));
    const rot = await openAdminOp(acct, owner, A.ROTATE_OWNER, coder.encode(["address"], [newKey.address]));
    await guessAndFinalize(acct, owner, stack.chainId, rot, PIN);
    await time.increase(DAY);
    await (await acct.executeOp(rot)).wait();
    expect((await acct.assetState(ETH)).pinCommitted).to.eq(0n); // the stale op's share dropped out
    await expect(acct.executeOp.staticCall(x)).to.be.revertedWithCustomError(ERR, "StaleOp");
    // the new owner's 2 ETH PIN outflow: with the leak, 2 + 2 > L_big (3 ETH) → would be 48 h; now the short class (1 h)
    const y = await requestTransfer(acct, newKey, ETH, bob.address, E.parseEther("2"), true);
    await guessAndFinalize(acct, newKey, stack.chainId, y, PIN);
    expect((await acct.getOp(y)).readyAt - BigInt(await time.latest())).to.be.lte(BigInt(HOUR));
  });

  // ───────────────────────────── K44 + K54: escape lock ─────────────────────────────

  describe("K44 + K54 — escape lock", function () {
    it("I21: an escape cancels every pending op; anonymous guesses and K-only ops close; freezing stays available", async () => {
      const acct = await fresh();
      const delayed = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("1"), true);
      await guessAndFinalize(acct, owner, stack.chainId, delayed, PIN); // Delayed (1 h)
      const evaluating = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01")); // Evaluating
      const needsPin = await openAdminOp(acct, owner, A.SET_PULSE, coder.encode(["uint32"], [30 * DAY]));
      const guessing = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("2"), true);
      await guess(acct, owner, stack.chainId, guessing, PIN); // Guessing (result pending)
      const rec = await openRecovery(acct, relayer, newKey); // "foreign" op
      expect((await acct.getOp(evaluating)).status).to.eq(Status.Evaluating);
      expect((await acct.assetState(ETH)).reserved).to.eq(E.parseEther("0.01"));
      expect((await acct.assetState(ETH)).pinCommitted).to.eq(E.parseEther("1"));

      const rc = await (await acct.connect(owner).startEscape()).wait();
      const ev = rc.logs.map((l: any) => { try { return acct.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "EscapeStarted");
      expect(ev.args.to).to.eq(escape.address);
      for (const id of [delayed, evaluating, needsPin, guessing, rec]) expect((await acct.getOp(id)).status, `op ${id}`).to.eq(Status.Cancelled);
      expect((await acct.assetState(ETH)).reserved).to.eq(0n);
      expect((await acct.assetState(ETH)).pinCommitted).to.eq(0n);

      // the pending transfer does not execute; the evaluation does not transfer even with ok = 1
      await time.increase(HOUR);
      await expect(acct.executeOp.staticCall(delayed)).to.be.revertedWithCustomError(ERR, "BadStatus");
      const dec = await hre.fhevm.publicDecrypt([(await acct.getOp(evaluating)).h0]);
      expect(Object.values(dec.clearValues)[0]).to.eq(true);
      await expect(acct.finalizeEvaluation.staticCall(evaluating, dec.abiEncodedClearValues, dec.decryptionProof)).to.be.revertedWithCustomError(ERR, "BadStatus");
      // in-flight guess: finalize frees the slot, the op stays cancelled
      await finalizeGuess(acct, guessing);
      expect((await acct.getOp(guessing)).status).to.eq(Status.Cancelled);
      expect((await acct.trackState(TRACK.OWNER)).pendingOp).to.eq(0n);

      // no guesses on cancelled ops (K-track and recovery track)
      const enc = await encGuess(acct, owner.address, stack.chainId, needsPin, PIN);
      await expect(acct.connect(owner).submitGuess.staticCall(needsPin, enc.c, enc.handles[0], enc.inputProof)).to.be.revertedWithCustomError(ERR, "BadStatus");
      const encR = await encGuess(acct, relayer.address, stack.chainId, rec, PIN);
      await expect(
        acct.connect(relayer).submitRecoveryGuess.staticCall(rec, encR.c, encR.handles[0], encR.inputProof, { value: E.parseEther("1") }),
      ).to.be.revertedWithCustomError(ERR, "BadStatus");
      // no new op can be opened: K-only, PIN path, admin, freeze (recovery track), recovery; instant bucket closed
      await expect(acct.connect(owner).requestTransfer.staticCall(ETH, alice.address, 1n, false)).to.be.revertedWithCustomError(ERR, "EscapeActive");
      await expect(acct.connect(owner).requestTransfer.staticCall(ETH, bob.address, 1n, true)).to.be.revertedWithCustomError(ERR, "EscapeActive");
      await expect(acct.connect(owner).openAdmin.staticCall(A.UNRESTRICT, "0x")).to.be.revertedWithCustomError(ERR, "EscapeActive");
      await expect(acct.connect(relayer).openFreeze.staticCall()).to.be.revertedWithCustomError(ERR, "EscapeActive");
      await expect(acct.connect(owner).instantTransfer.staticCall(ETH, bob.address, 1n)).to.be.revertedWithCustomError(ERR, "EscapeActive");
      // restrictive single-factor actions ("freeze") stay available
      await (await acct.connect(owner).restrict()).wait();
      await (await acct.connect(guardian).guardianRestrict()).wait();
      expect((await restricted(acct)) & (R.OWNER | R.GUARDIAN)).to.eq(R.OWNER | R.GUARDIAN);

      // once the escape delay is over, funds go to the E_addr in the snapshot
      await time.increase(30 * DAY);
      const e0 = await ethers.provider.getBalance(escape.address);
      await (await acct.connect(stranger).executeEscape([])).wait();
      expect((await ethers.provider.getBalance(escape.address)) - e0).to.eq(E.parseEther("10"));
    });

    it("I22: an escape can be cancelled only via the lane (D or recovery helper); with neither it cannot be cancelled and executes after 30 days", async () => {
      const plain = await fresh();
      await expect(plain.connect(owner).openAdmin.staticCall(A.CANCEL_ESCAPE, "0x")).to.be.revertedWithCustomError(ERR, "NoEscape");
      await (await plain.connect(owner).startEscape()).wait();
      await expect(plain.connect(owner).openAdmin.staticCall(A.CANCEL_ESCAPE, "0x")).to.be.revertedWithCustomError(ERR, "NotAuthorized");
      await time.increase(30 * DAY);
      const e0 = await ethers.provider.getBalance(escape.address);
      await (await plain.executeEscape([])).wait();
      expect((await ethers.provider.getBalance(escape.address)) - e0).to.eq(E.parseEther("10"));

      // recovery helper only (no D): the lane works with the helper's co-signature
      const withHelper = await fresh({ helper: helper.address });
      await (await withHelper.connect(owner).startEscape()).wait();
      const ce = await openAdminOp(withHelper, owner, A.CANCEL_ESCAPE, "0x");
      await expect(guess(withHelper, owner, stack.chainId, ce, PIN)).to.be.revertedWithCustomError(ERR, "BadTrack");
      // wrong PIN on the lane: the escape continues
      await laneGuess(withHelper, owner, helper, stack.chainId, ce, "000000");
      await finalizeGuess(withHelper, ce);
      expect((await withHelper.status()).escapeReadyAt).to.not.eq(0n);
      await laneGuess(withHelper, owner, helper, stack.chainId, ce, PIN);
      await finalizeGuess(withHelper, ce);
      expect((await withHelper.status()).escapeReadyAt).to.eq(0n);
      expect((await withHelper.escapeState()).escapeTo).to.eq(E.ZeroAddress);
    });

    it("account with D: the owner cancels the escape via the lane → cancelled ops do not revive; new ops can be opened", async () => {
      const acct = await fresh({ device: device.address });
      const x = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("1"), true);
      await guessAndFinalize(acct, owner, stack.chainId, x, PIN);
      const y = await openAdminOp(acct, owner, A.SET_PULSE, coder.encode(["uint32"], [30 * DAY]));
      await (await acct.connect(owner).startEscape()).wait();
      const ce = await openAdminOp(acct, owner, A.CANCEL_ESCAPE, "0x");
      await laneGuess(acct, owner, device, stack.chainId, ce, PIN);
      await finalizeGuess(acct, ce);
      expect((await acct.status()).escapeReadyAt).to.eq(0n);
      expect((await acct.getOp(x)).status).to.eq(Status.Cancelled);
      expect((await acct.getOp(y)).status).to.eq(Status.Cancelled);
      await time.increase(HOUR);
      await expect(acct.executeOp.staticCall(x)).to.be.revertedWithCustomError(ERR, "BadStatus");
      // new ops work normally
      const k = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01"));
      expect((await acct.getOp(k)).status).to.eq(Status.Evaluating);
      const z = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.5"), true);
      await guessAndFinalize(acct, owner, stack.chainId, z, PIN);
      expect((await acct.getOp(z)).status).to.eq(Status.Delayed);
    });
  });

  // ───────────────────────────── K45: rotation lock ─────────────────────────────

  describe("K45 — rotation lock", function () {
    it("on an account with D every PIN-verified rotation is counted and closes the K-track; the lane and the recovery track stay open; the last cancellation releases the lock", async () => {
      const acct = await fresh({ device: device.address });
      const addr = await acct.getAddress();
      const rot = await openAdminOp(acct, owner, A.ROTATE_OWNER, coder.encode(["address"], [newKey.address]));
      await guessAndFinalize(acct, owner, stack.chainId, rot, PIN);
      expect(await pendingRotations(acct)).to.eq(1n);
      // a second rotation can now be verified only via the lane
      const rot2 = await openAdminOp(acct, owner, A.ROTATE_OWNER, coder.encode(["address"], [helper.address]));
      await expect(guess(acct, owner, stack.chainId, rot2, PIN)).to.be.revertedWithCustomError(ERR, "RotationLock");
      await laneGuess(acct, owner, device, stack.chainId, rot2, PIN);
      await finalizeGuess(acct, rot2);
      expect(await pendingRotations(acct)).to.eq(2n);
      // the thief's K-track guess (transfer to a new address): rejected, not added to the score
      const t = await requestTransfer(acct, owner, ETH, thief.address, E.parseEther("1"), true);
      await expect(guess(acct, owner, stack.chainId, t, "123456")).to.be.revertedWithCustomError(ERR, "RotationLock");
      expect(await score(acct, TRACK.OWNER)).to.eq(0n);
      // the recovery track is open (freeze with P)
      const f = await opIdFromReceipt(acct, await (await acct.connect(relayer).openFreeze()).wait());
      await recoveryGuess(acct, relayer, f, PIN);
      await finalizeGuess(acct, f);
      expect((await restricted(acct)) & R.PIN).to.eq(R.PIN);
      // one rotation cancelled via the lane → counter 1, the lock stays
      const c1 = await opIdFromReceipt(acct, await (await acct.connect(owner).openCancel(rot)).wait());
      await laneGuess(acct, owner, device, stack.chainId, c1, PIN);
      await finalizeGuess(acct, c1);
      expect(await pendingRotations(acct)).to.eq(1n);
      await expect(guess(acct, owner, stack.chainId, t, PIN)).to.be.revertedWithCustomError(ERR, "RotationLock");
      // the last rotation cancelled by the K + D veto → the lock is released
      const sig = await personalSign(device, "encrypted-account/device-cancel/v1", stack.chainId, addr, E.keccak256(coder.encode(["uint256"], [rot2])));
      await (await acct.connect(owner).cancelWithDevice(rot2, sig)).wait();
      expect(await pendingRotations(acct)).to.eq(0n);
      await guessAndFinalize(acct, owner, stack.chainId, t, PIN);
      expect((await acct.getOp(t)).status).to.eq(Status.Delayed);
    });

    it("no lock on an account without D or recovery helper (otherwise the owner would have no way to cancel once K+P are stolen together); the counter resets when the rotation executes", async () => {
      const acct = await fresh();
      const rot = await openAdminOp(acct, owner, A.ROTATE_OWNER, coder.encode(["address"], [newKey.address]));
      await guessAndFinalize(acct, owner, stack.chainId, rot, PIN);
      expect(await pendingRotations(acct)).to.eq(1n);
      const t = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("1"), true);
      await guessAndFinalize(acct, owner, stack.chainId, t, PIN); // K-track open
      expect((await acct.getOp(t)).status).to.eq(Status.Delayed);
      await time.increase(DAY);
      await (await acct.executeOp(rot)).wait();
      expect(await pendingRotations(acct)).to.eq(0n);
      expect(await acct.owner()).to.eq(newKey.address);
    });
  });

  // ───────────────────────────── K53: challenge consistency ─────────────────────────────

  it("K53 / I23: a guess with a stale challenge reverts, the score and last-attempt time stay unchanged; the client takes c from the opening receipt", async () => {
    const acct = await fresh();
    const next = (await acct.opCount()) + 1n;
    const stale = BigInt(await acct.challengeOf(next)); // lagging back end: the op is not visible yet (opHash = 0)
    const rc = await (await acct.connect(owner).requestTransfer(ETH, bob.address, E.parseEther("0.05"), true)).wait();
    const { opId, c } = challengeFromReceipt(acct, rc);
    expect(opId).to.eq(next);
    expect(c).to.eq(BigInt(await acct.challengeOf(opId)));
    expect(stale).to.not.eq(c);

    const before = await acct.trackState(TRACK.OWNER);
    const bad = await encGuess(acct, owner.address, stack.chainId, opId, PIN, stale); // correct PIN, stale c
    await expect(acct.connect(owner).submitGuess.staticCall(opId, stale, bad.handles[0], bad.inputProof)).to.be.revertedWithCustomError(ERR, "StaleChallenge");
    await expect(acct.connect(owner).submitGuess(opId, stale, bad.handles[0], bad.inputProof)).to.be.revertedWithCustomError(ERR, "StaleChallenge");
    // even if the client declares c correctly but encrypts with another value (c ≠ encrypted c'), the contract cannot see the encrypted value:
    // K53 only verifies the c the client declares — enough to catch the stale-read bug.
    const after = await acct.trackState(TRACK.OWNER);
    expect(after.score).to.eq(before.score);
    expect(after.lastAt).to.eq(before.lastAt);
    expect((await acct.getOp(opId)).status).to.eq(Status.NeedsPin);

    const good = await encGuess(acct, owner.address, stack.chainId, opId, PIN, c);
    await (await acct.connect(owner).submitGuess(opId, c, good.handles[0], good.inputProof)).wait();
    await finalizeGuess(acct, opId);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed);
    expect(await score(acct, TRACK.OWNER)).to.eq(0n);
  });

  // ───────────────────────────── K55: escape address consent ─────────────────────────────

  describe("K55 — escape address", function () {
    it("I24: setup requires E_addr's EIP-712 consent (a signature by another key or for another account is rejected)", async () => {
      const d = await defaultDelays(stack);
      const salt = E.id("k55-" + Math.random());
      const predicted = await stack.factory.predictAddress(owner.address, escape.address, guardian.address, d, salt);
      const forged = await stranger.signTypedData(eip712Domain(stack.chainId, predicted), ESC_TYPES, { escape: escape.address, nonce: 0 });
      await expect(stack.factory.createAccountWithDelays.staticCall(owner.address, escape.address, guardian.address, d, salt, forged)).to.be.revertedWithCustomError(
        ERR,
        "BadSignature",
      );
      const otherAccount = await escapeConsent(escape, stack.chainId, stranger.address, 0);
      await expect(
        stack.factory.createAccountWithDelays.staticCall(owner.address, escape.address, guardian.address, d, salt, otherAccount),
      ).to.be.revertedWithCustomError(ERR, "BadSignature");
      const ok = await escapeConsent(escape, stack.chainId, predicted, 0);
      await (await stack.factory.createAccountWithDelays(owner.address, escape.address, guardian.address, d, salt, ok)).wait();
      const acct: any = await ethers.getContractAt("EncryptedAccount", predicted);
      const es = await acct.escapeState();
      expect(es.escape_).to.eq(escape.address);
      expect(es.nonce).to.eq(1n);
      expect(es.verifiedAt).to.be.closeTo(BigInt(await time.latest()), 2n);
    });

    it("I24: a change requires the new E_addr's consent; an old consent cannot be replayed (nonce); an ERC-1271 wallet can consent", async () => {
      const acct = await fresh();
      const addr = await acct.getAddress();
      const setupSig = await escapeConsent(escape, stack.chainId, addr, 0); // identical to the setup consent
      // consent signed by another key
      const forged = await stranger.signTypedData(eip712Domain(stack.chainId, addr), ESC_TYPES, { escape: escape2.address, nonce: 1 });
      await expect(acct.connect(owner).openAdmin.staticCall(A.SET_ESCAPE, coder.encode(["address", "bytes"], [escape2.address, forged]))).to.be.revertedWithCustomError(
        ERR,
        "BadSignature",
      );
      // old (nonce 0) consents
      const old2 = await escapeConsent(escape2, stack.chainId, addr, 0);
      await expect(acct.connect(owner).openAdmin.staticCall(A.SET_ESCAPE, coder.encode(["address", "bytes"], [escape2.address, old2]))).to.be.revertedWithCustomError(
        ERR,
        "BadSignature",
      );
      // valid change: K+P + 30 days
      const sig2 = await escapeConsent(escape2, stack.chainId, addr, 1);
      const openedAt = BigInt(await time.latest()) + 1n;
      const ch = await openAdminOp(acct, owner, A.SET_ESCAPE, coder.encode(["address", "bytes"], [escape2.address, sig2]));
      await guessAndFinalize(acct, owner, stack.chainId, ch, PIN);
      await time.increase(30 * DAY);
      await (await acct.executeOp(ch)).wait();
      let es = await acct.escapeState();
      expect(es.escape_).to.eq(escape2.address);
      expect(es.nonce).to.eq(2n);
      expect(es.verifiedAt).to.be.within(openedAt - 1n, openedAt + 1n); // the moment the consent was signed (the op was opened)
      // an attempt to switch back with the old E_addr's setup consent (lost-address attack) is rejected
      await expect(acct.connect(owner).openAdmin.staticCall(A.SET_ESCAPE, coder.encode(["address", "bytes"], [escape.address, setupSig]))).to.be.revertedWithCustomError(
        ERR,
        "BadSignature",
      );
      // ERC-1271 contract wallet
      const wallet: any = await (await ethers.getContractFactory("MockERC1271Wallet")).deploy(walletOwner.address);
      const wAddr = await wallet.getAddress();
      const wSig = await walletOwner.signTypedData(eip712Domain(stack.chainId, addr), ESC_TYPES, { escape: wAddr, nonce: 2 });
      const ch2 = await openAdminOp(acct, owner, A.SET_ESCAPE, coder.encode(["address", "bytes"], [wAddr, wSig]));
      await guessAndFinalize(acct, owner, stack.chainId, ch2, PIN);
      await time.increase(30 * DAY);
      await (await acct.executeOp(ch2)).wait();
      es = await acct.escapeState();
      expect(es.escape_).to.eq(wAddr);
      // escape to the contract wallet
      await (await acct.connect(owner).startEscape()).wait();
      await time.increase(30 * DAY);
      await (await acct.executeEscape([])).wait();
      expect(await ethers.provider.getBalance(wAddr)).to.eq(E.parseEther("10"));
    });

    it("signed escapePing: anyone can relay it; escapeVerifiedAt is updated; a replay, a future timestamp and a foreign signature are rejected; staleness blocks no operation", async () => {
      const acct = await fresh();
      const addr = await acct.getAddress();
      await time.increase(100 * DAY); // past 90 days: the watchtower sends a reminder, but nothing is blocked
      const k = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.1"), true);
      await guessAndFinalize(acct, owner, stack.chainId, k, PIN);
      expect((await acct.getOp(k)).status).to.eq(Status.Delayed);
      const issuedAt = BigInt(await time.latest());
      const sig = await escapePingSig(escape, stack.chainId, addr, issuedAt);
      await (await acct.connect(stranger).escapePing(issuedAt, sig)).wait();
      expect((await acct.escapeState()).verifiedAt).to.eq(issuedAt);
      await expect(acct.connect(stranger).escapePing.staticCall(issuedAt, sig)).to.be.revertedWithCustomError(ERR, "InvalidParams");
      const future = BigInt(await time.latest()) + 3600n;
      await expect(acct.connect(stranger).escapePing.staticCall(future, await escapePingSig(escape, stack.chainId, addr, future))).to.be.revertedWithCustomError(
        ERR,
        "InvalidParams",
      );
      await time.increase(10);
      const t2 = BigInt(await time.latest());
      await expect(acct.connect(stranger).escapePing.staticCall(t2, await escapePingSig(stranger, stack.chainId, addr, t2))).to.be.revertedWithCustomError(ERR, "BadSignature");
    });
  });

  // ───────────────────────────── F0.10 addendum (work package §8.3) ─────────────────────────────

  describe("F0.10 addendum (§8.3) — role separation and reinstating the restriction", function () {
    it("E_addr ≠ watchtower and E_addr ≠ K: rejected at opening in setup, SET_ESCAPE, watchtower change, rotation and recovery", async () => {
      // setup: E_addr = watchtower
      const d = await defaultDelays(stack);
      const salt = E.id("role-" + Math.random());
      const predicted = await stack.factory.predictAddress(owner.address, guardian.address, guardian.address, d, salt);
      const sig = await escapeConsent(guardian, stack.chainId, predicted, 0);
      await expect(stack.factory.createAccountWithDelays.staticCall(owner.address, guardian.address, guardian.address, d, salt, sig)).to.be.revertedWithCustomError(
        ERR,
        "InvalidParams",
      );
      const acct = await fresh();
      const addr = await acct.getAddress();
      // SET_ESCAPE → the watchtower's address (even with the watchtower's own consent)
      const gSig = await escapeConsent(guardian, stack.chainId, addr, 1);
      await expect(acct.connect(owner).openAdmin.staticCall(A.SET_ESCAPE, coder.encode(["address", "bytes"], [guardian.address, gSig]))).to.be.revertedWithCustomError(
        ERR,
        "InvalidParams",
      );
      // SET_GUARDIAN → E_addr
      await expect(acct.connect(owner).openAdmin.staticCall(A.SET_GUARDIAN, coder.encode(["address"], [escape.address]))).to.be.revertedWithCustomError(ERR, "InvalidParams");
      // removing the watchtower (0) is allowed
      await acct.connect(owner).openAdmin.staticCall(A.SET_GUARDIAN, coder.encode(["address"], [E.ZeroAddress]));
      // rotation and recovery: the new key cannot be E_addr
      await expect(acct.connect(owner).openAdmin.staticCall(A.ROTATE_OWNER, coder.encode(["address"], [escape.address]))).to.be.revertedWithCustomError(ERR, "InvalidParams");
      const payload = E.keccak256(coder.encode(["address", "uint32"], [escape.address, 0]));
      const rsig = await personalSign(escape, "encrypted-account/recovery/v1", stack.chainId, addr, payload);
      await expect(acct.connect(relayer).openRecovery.staticCall(escape.address, rsig, "0x")).to.be.revertedWithCustomError(ERR, "InvalidParams");
    });

    it("two conflicting pending ops: after SET_GUARDIAN(X) executes, SET_ESCAPE(X) does not execute and is cancelled (role separation at execution time too)", async () => {
      const acct = await fresh();
      const addr = await acct.getAddress();
      const X = escape2;
      const se = await openAdminOp(acct, owner, A.SET_ESCAPE, coder.encode(["address", "bytes"], [X.address, await escapeConsent(X, stack.chainId, addr, 1)]));
      await guessAndFinalize(acct, owner, stack.chainId, se, PIN); // 30 days
      const sg = await openAdminOp(acct, owner, A.SET_GUARDIAN, coder.encode(["address"], [X.address]));
      await guessAndFinalize(acct, owner, stack.chainId, sg, PIN); // 24 h
      await time.increase(DAY);
      await (await acct.executeOp(sg)).wait();
      expect((await acct.roles()).guardian_).to.eq(X.address);
      await time.increase(30 * DAY);
      await (await acct.executeOp(se)).wait(); // does not revert: it is cancelled instead, since it can also run inside finalize
      expect((await acct.getOp(se)).status).to.eq(Status.Cancelled);
      const es = await acct.escapeState();
      expect(es.escape_).to.eq(escape.address);
      expect(es.nonce).to.eq(1n);
    });

    it("conflicting recovery: if E_addr was meanwhile changed to the new key, the recovery does not execute and is cancelled", async () => {
      const delays = { ...(await defaultDelays(stack)), escapeChange: 3600n }; // let the E_addr change execute before the recovery
      const acct = await fresh({ delays });
      const addr = await acct.getAddress();
      const X = escape2;
      const rec = await openRecovery(acct, relayer, X);
      await recoveryGuess(acct, relayer, rec, PIN); // 7 days
      await finalizeGuess(acct, rec);
      const se = await openAdminOp(acct, owner, A.SET_ESCAPE, coder.encode(["address", "bytes"], [X.address, await escapeConsent(X, stack.chainId, addr, 1)]));
      await guessAndFinalize(acct, owner, stack.chainId, se, PIN);
      await time.increase(3600);
      await (await acct.executeOp(se)).wait();
      expect((await acct.escapeState()).escape_).to.eq(X.address);
      await time.increase(7 * DAY);
      await (await acct.executeOp(rec)).wait();
      expect((await acct.getOp(rec)).status).to.eq(Status.Cancelled);
      expect(await acct.owner()).to.eq(owner.address); // K ≠ E_addr is preserved
    });

    it("a wrong K-track result reinstates the restriction while score ≥ 3: UNRESTRICT on the lane cannot wipe the restriction of an in-flight wrong guess (one pending guess per track)", async () => {
      const acct = await fresh({ device: device.address });
      await alignDecay();
      const x = await requestTransfer(acct, owner, ETH, thief.address, E.parseEther("1"), true);
      for (const w of ["111111", "222222", "333333"]) {
        await guess(acct, owner, stack.chainId, x, w);
        await finalizeGuess(acct, x);
      }
      expect((await restricted(acct)) & R.STRIKES).to.eq(R.STRIKES);
      await time.increase(15 * 60);
      // the thief's 4th wrong guess is in flight on the K-track; meanwhile the owner approves UNRESTRICT on the lane (two tracks, two separate slots)
      await guess(acct, owner, stack.chainId, x, "444444");
      const un = await openAdminOp(acct, owner, A.UNRESTRICT, "0x");
      await laneGuess(acct, owner, device, stack.chainId, un, PIN);
      expect((await acct.trackState(TRACK.OWNER)).pendingOp).to.eq(x);
      expect((await acct.trackState(TRACK.LANE)).pendingOp).to.eq(un);
      await finalizeGuess(acct, un); // UNRESTRICT executes → the restriction lifts
      expect(await restricted(acct)).to.eq(0);
      await finalizeGuess(acct, x); // wrong result, score 4 ≥ 3 → restricted again
      expect((await restricted(acct)) & R.STRIKES).to.eq(R.STRIKES);
      expect(await score(acct, TRACK.OWNER)).to.eq(4n);
    });
  });

  // ───────────────────────────── v0.3 §11.4 scenarios (new semantics) ─────────────────────────────

  describe("scenarios — v0.3 §11.4 (new semantics) and F0.10 additions", function () {
    it("scenario 1: only K stolen → restricted mode on the 3rd wrong guess; the owner rotates with K+P; on an account with D the thief cannot guess for 24 h (K45); then the thief's K is worthless", async () => {
      const acct = await fresh({ device: device.address });
      await alignDecay();
      const k = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01")); // known recipient, below the limit: K-only
      expect((await acct.getOp(k)).status).to.eq(Status.Evaluating);
      const x = await requestTransfer(acct, owner, ETH, thief.address, E.parseEther("5"), true);
      for (const w of ["111111", "222222", "333333"]) {
        await guess(acct, owner, stack.chainId, x, w);
        await finalizeGuess(acct, x);
      }
      expect((await restricted(acct)) & R.STRIKES).to.eq(R.STRIKES);
      await time.increase(15 * 60); // T2(3)
      const rot = await openAdminOp(acct, owner, A.ROTATE_OWNER, coder.encode(["address"], [newKey.address]));
      await guessAndFinalize(acct, owner, stack.chainId, rot, PIN);
      await time.increase(4 * HOUR);
      await expect(guess(acct, owner, stack.chainId, x, "444444")).to.be.revertedWithCustomError(ERR, "RotationLock");
      await time.increase(DAY);
      await (await acct.executeOp(rot)).wait();
      expect(await acct.owner()).to.eq(newKey.address);
      await expect(acct.connect(owner).requestTransfer.staticCall(ETH, thief.address, 1n, true)).to.be.revertedWithCustomError(ERR, "NotAuthorized");
      expect(await score(acct, TRACK.OWNER)).to.eq(0n);
    });

    it("scenario 3: K stolen and phone lost → freeze with P + recovery; the thief cannot cancel with K alone; if the thief starts an escape the recovery is cancelled and the funds go to E_addr", async () => {
      const acct = await fresh();
      const f = await opIdFromReceipt(acct, await (await acct.connect(relayer).openFreeze()).wait());
      await recoveryGuess(acct, relayer, f, PIN);
      await finalizeGuess(acct, f);
      expect((await restricted(acct)) & R.PIN).to.eq(R.PIN);
      const rec = await openRecovery(acct, relayer, newKey);
      await recoveryGuess(acct, relayer, rec, PIN);
      await finalizeGuess(acct, rec);
      expect((await acct.getOp(rec)).status).to.eq(Status.Delayed);
      const k = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01"));
      expect((await acct.getOp(k)).status).to.eq(Status.NeedsPin); // the freeze stopped K-only
      const c = await opIdFromReceipt(acct, await (await acct.connect(owner).openCancel(rec)).wait());
      await guess(acct, owner, stack.chainId, c, "999999");
      expect((await acct.getOp(rec)).paused).to.eq(true);
      await finalizeGuess(acct, c);
      expect((await acct.getOp(rec)).status).to.eq(Status.Delayed);
      expect((await acct.getOp(rec)).paused).to.eq(false);
      await (await acct.connect(owner).startEscape()).wait(); // thief
      expect((await acct.getOp(rec)).status).to.eq(Status.Cancelled);
      await time.increase(30 * DAY);
      const e0 = await ethers.provider.getBalance(escape.address);
      await (await acct.executeEscape([])).wait();
      expect((await ethers.provider.getBalance(escape.address)) - e0).to.be.gte(E.parseEther("10"));
    });

    it("scenario 4: PIN phished → the attacker freezes with P and opens a recovery; the owner cancels with K+P, lifts the freeze, changes the PIN", async () => {
      const acct = await fresh();
      const addr = await acct.getAddress();
      const f = await opIdFromReceipt(acct, await (await acct.connect(thief).openFreeze()).wait());
      await recoveryGuess(acct, thief, f, PIN);
      await finalizeGuess(acct, f);
      const rec = await openRecovery(acct, thief, thief);
      await recoveryGuess(acct, thief, rec, PIN);
      await finalizeGuess(acct, rec);
      const c = await opIdFromReceipt(acct, await (await acct.connect(owner).openCancel(rec)).wait());
      await guessAndFinalize(acct, owner, stack.chainId, c, PIN);
      expect((await acct.getOp(rec)).status).to.eq(Status.Cancelled);
      const un = await openAdminOp(acct, owner, A.UNRESTRICT, "0x");
      await guessAndFinalize(acct, owner, stack.chainId, un, PIN);
      expect(await restricted(acct)).to.eq(0);
      const NEW = "640271";
      const fpNew = await fingerprint(NEW, stack.chainId, addr);
      const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
      inp.add64(fpNew);
      const enc = await inp.encrypt();
      await (await acct.connect(owner).openPinChange(enc.handles[0], enc.inputProof)).wait();
      const ch = (await acct.opCount()) as bigint;
      await guessAndFinalize(acct, owner, stack.chainId, ch, PIN);
      await time.increase(DAY);
      await (await acct.executeOp(ch)).wait();
      expect(await debugU64((await acct.encryptedHandles(ETH)).pinH)).to.eq(fpNew);
      // the phished PIN is now useless
      const f2 = await opIdFromReceipt(acct, await (await acct.connect(thief).openFreeze()).wait());
      await recoveryGuess(acct, thief, f2, PIN);
      await finalizeGuess(acct, f2);
      expect((await acct.getOp(f2)).status).to.eq(Status.NeedsPin);
      expect(await restricted(acct)).to.eq(0);
    });

    it("scenario 5: K and P stolen together, D exists → the owner cancels the thief's transfer with the K+D veto; without D the thief cannot cancel the escape", async () => {
      const acct = await fresh({ device: device.address });
      const addr = await acct.getAddress();
      const x = await requestTransfer(acct, owner, ETH, thief.address, E.parseEther("5"), true);
      await guessAndFinalize(acct, owner, stack.chainId, x, PIN); // 5 ETH > L_big → 48 h
      const sig = await personalSign(device, "encrypted-account/device-cancel/v1", stack.chainId, addr, E.keccak256(coder.encode(["uint256"], [x])));
      await (await acct.connect(owner).cancelWithDevice(x, sig)).wait();
      expect((await acct.getOp(x)).status).to.eq(Status.Cancelled);
      await (await acct.connect(owner).startEscape()).wait(); // owner
      const ce = await openAdminOp(acct, owner, A.CANCEL_ESCAPE, "0x"); // thief (K)
      await expect(guess(acct, owner, stack.chainId, ce, PIN)).to.be.revertedWithCustomError(ERR, "BadTrack");
      const enc = await encGuess(acct, owner.address, stack.chainId, ce, PIN);
      const fakeCos = await personalSign(thief, "encrypted-account/lane/v1", stack.chainId, addr, E.keccak256(coder.encode(["uint256", "bytes32"], [ce, enc.handles[0]])));
      await expect(acct.connect(owner).submitGuessWithCosign.staticCall(ce, enc.c, enc.handles[0], enc.inputProof, fakeCos)).to.be.revertedWithCustomError(
        ERR,
        "BadSignature",
      );
      expect((await acct.status()).escapeReadyAt).to.not.eq(0n);
    });

    it("scenario 10: PIN forgotten, no D and no recovery helper → K alone cannot reset the PIN; the escape moves the funds to E_addr after 30 days", async () => {
      const acct = await fresh();
      const addr = await acct.getAddress();
      await stack.usdc.mint(addr, 1_000n * 10n ** 6n);
      const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
      inp.add64(await fingerprint("111222", stack.chainId, addr));
      const enc = await inp.encrypt();
      await expect(acct.connect(owner).openPinReset.staticCall(enc.handles[0], enc.inputProof, "0x")).to.be.reverted;
      await (await acct.connect(owner).startEscape()).wait();
      await time.increase(30 * DAY);
      const u0 = await stack.usdc.balanceOf(escape.address);
      await (await acct.executeEscape([await stack.usdc.getAddress()])).wait();
      expect((await stack.usdc.balanceOf(escape.address)) - u0).to.eq(1_000n * 10n ** 6n);
    });

    it("extra: K+P stolen, no D → the thief queues a transfer to a new address; the owner starts an escape → transfer cancelled, the thief cannot cancel the escape, funds go to E_addr", async () => {
      const acct = await fresh();
      const x = await requestTransfer(acct, owner, ETH, thief.address, E.parseEther("1"), true);
      await guessAndFinalize(acct, owner, stack.chainId, x, PIN); // the thief's K+P: 1 h delay pending
      await (await acct.connect(owner).startEscape()).wait(); // owner, before the delay ends
      await time.increase(HOUR);
      const t0 = await ethers.provider.getBalance(thief.address);
      await expect(acct.connect(thief).executeOp.staticCall(x)).to.be.revertedWithCustomError(ERR, "BadStatus");
      await expect(acct.connect(owner).openAdmin.staticCall(A.CANCEL_ESCAPE, "0x")).to.be.revertedWithCustomError(ERR, "NotAuthorized");
      await time.increase(30 * DAY);
      const e0 = await ethers.provider.getBalance(escape.address);
      await (await acct.connect(stranger).executeEscape([])).wait();
      expect((await ethers.provider.getBalance(escape.address)) - e0).to.eq(E.parseEther("10"));
      expect(await ethers.provider.getBalance(thief.address)).to.eq(t0);
    });

    it("extra: only K stolen → the owner starts an escape → every later guess by the thief is rejected", async () => {
      const acct = await fresh();
      const x = await requestTransfer(acct, owner, ETH, thief.address, E.parseEther("1"), true);
      await guess(acct, owner, stack.chainId, x, "111111");
      await finalizeGuess(acct, x);
      const before = await score(acct, TRACK.OWNER);
      await (await acct.connect(owner).startEscape()).wait();
      await expect(guess(acct, owner, stack.chainId, x, "222222")).to.be.revertedWithCustomError(ERR, "BadStatus");
      await expect(acct.connect(owner).requestTransfer.staticCall(ETH, thief.address, 1n, true)).to.be.revertedWithCustomError(ERR, "EscapeActive");
      await expect(acct.connect(thief).openFreeze.staticCall()).to.be.revertedWithCustomError(ERR, "EscapeActive");
      expect(await score(acct, TRACK.OWNER)).to.eq(before); // the PIN oracle is closed
    });
  });
});
