import { expect } from "chai";
import { ethers as E } from "ethers";
import * as hre from "hardhat";
import {
  DAY,
  ETH,
  HOUR,
  R,
  Stack,
  Status,
  TRACK,
  A,
  alignDecay,
  coder,
  createAccount,
  defaultDelays,
  debugU64,
  decryptForGuess,
  deployStack,
  errs,
  encGuess,
  ethers,
  factoryCreate,
  finalizeGuess,
  fingerprint,
  opIdFromReceipt,
  guess,
  guessAndFinalize,
  requestTransfer,
  time,
  userDecryptBool,
} from "./helpers";

const ACL_ABI = [
  "function isAllowed(bytes32,address) view returns (bool)",
  "function isAllowedForDecryption(bytes32) view returns (bool)",
  "function persistAllowed(bytes32,address) view returns (bool)",
];

describe("F0.1 / F0.6 — PIN: two-phase verification, counters, restricted mode, PIN change", function () {
  let stack: Stack;
  let owner: any, escape: any, guardian: any, alice: any, bob: any, stranger: any;
  const PIN = "482915";

  let ERR: any;
  before(async () => {
    [owner, escape, guardian, alice, bob, stranger] = await ethers.getSigners();
    stack = await deployStack();
    ERR = await errs();
  });

  async function fresh(opts: any = {}) {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address], ...opts });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("10") });
    return acct;
  }

  it("correct PIN → delay class; the score goes +1 BEFORE the result (I10), a correct result refunds only that +1 (K43)", async () => {
    const acct = await fresh();
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.05"), true);
    expect((await acct.getOp(opId)).status).to.eq(Status.NeedsPin);

    await guess(acct, owner, stack.chainId, opId, PIN);
    // The result is not decrypted yet, but the attempt is already counted:
    expect((await acct.trackState(TRACK.OWNER)).score).to.eq(1n);
    expect((await acct.sharedBudget()).score).to.eq(1n);
    expect((await acct.getOp(opId)).status).to.eq(Status.Guessing);

    await finalizeGuess(acct, opId, stranger); // anyone can finalize
    const op = await acct.getOp(opId);
    expect(op.status).to.eq(Status.Delayed);
    expect((await acct.trackState(TRACK.OWNER)).score).to.eq(0n); // refund
    const now = BigInt(await time.latest());
    expect(op.readyAt - now).to.be.within(BigInt(HOUR) - 2n, BigInt(HOUR)); // pinTransfer (below L_big)

    await expect(acct.executeOp(opId)).to.be.revertedWithCustomError(ERR, "NotReady");
    await time.increase(HOUR);
    const before = await ethers.provider.getBalance(bob.address);
    await (await acct.connect(stranger).executeOp(opId)).wait();
    expect((await ethers.provider.getBalance(bob.address)) - before).to.eq(E.parseEther("0.05"));
  });

  it("wrong PIN → back to NeedsPin; it was counted before the result was decrypted", async () => {
    const acct = await fresh();
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.05"), true);
    await guess(acct, owner, stack.chainId, opId, "000001");
    expect((await acct.trackState(TRACK.OWNER)).score).to.eq(1n);
    const res = await decryptForGuess(acct, opId);
    expect(Object.values(res.clearValues)[0]).to.eq(false);
    await finalizeGuess(acct, opId);
    expect((await acct.getOp(opId)).status).to.eq(Status.NeedsPin);
    expect((await acct.trackState(TRACK.OWNER)).score).to.eq(1n);
  });

  it("scenario 11 (v0.4): 3 wrong → restricted mode IMMEDIATELY on the 3rd attempt (I18); a correct PIN does NOT lift the restriction (score 3); UNRESTRICT after 15 min", async () => {
    const acct = await fresh();
    await alignDecay();
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.05"), true);
    for (let i = 1; i <= 2; i++) {
      await guess(acct, owner, stack.chainId, opId, "11111" + i);
      await finalizeGuess(acct, opId);
      expect((await acct.status()).restrictedReasons).to.eq(0n);
    }
    await guess(acct, owner, stack.chainId, opId, "111113");
    // restricted mode as soon as the 3rd attempt is submitted (before the result is known):
    expect((await acct.status()).restrictedReasons & BigInt(R.STRIKES)).to.eq(BigInt(R.STRIKES));
    const t = await acct.trackState(TRACK.OWNER);
    expect(t.nextAllowedAt - BigInt(await time.latest())).to.be.within(15n * 60n - 2n, 15n * 60n);

    // in restricted mode a K-only transfer is not evaluated → it falls back to the PIN path
    const kOnly = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01"), false);
    expect((await acct.getOp(kOnly)).status).to.eq(Status.NeedsPin);

    await finalizeGuess(acct, opId);
    await expect(guess(acct, owner, stack.chainId, opId, PIN)).to.be.revertedWithCustomError(ERR, "Backoff");
    await time.increase(15 * 60);
    await guessAndFinalize(acct, owner, stack.chainId, opId, PIN);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed);
    // K43: a correct PIN does not lower the score (3) → the restriction stays; the owner's PIN also updates the last-attempt time
    expect((await acct.trackState(TRACK.OWNER)).score).to.eq(3n);
    expect((await acct.status()).restrictedReasons & BigInt(R.STRIKES)).to.eq(BigInt(R.STRIKES));
    const un = await opIdFromReceipt(acct, await (await acct.connect(owner).openAdmin(A.UNRESTRICT, "0x")).wait());
    await expect(guess(acct, owner, stack.chainId, un, PIN)).to.be.revertedWithCustomError(ERR, "Backoff");
    await time.increase(15 * 60);
    await guessAndFinalize(acct, owner, stack.chainId, un, PIN); // delay 0 → executes inside finalize
    expect((await acct.status()).restrictedReasons).to.eq(0n);
    expect((await acct.trackState(TRACK.OWNER)).score).to.eq(3n); // UNRESTRICT does not reset the score either
  });

  it("T2 back-off table (K46): 1–2 → 0; n ≥ 3 → 15 min·4^(n−3), capped at 7 days; the anonymous budget is shared (K56)", async () => {
    const acct = await fresh();
    await alignDecay();
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.05"), true);
    const expected = [0, 0, 15 * 60, HOUR, 4 * HOUR, 16 * HOUR, 64 * HOUR, 7 * DAY, 7 * DAY, 7 * DAY, 7 * DAY];
    for (let n = 1; n <= 11; n++) {
      await guess(acct, owner, stack.chainId, opId, "20000" + (n % 10));
      const t = await acct.trackState(TRACK.OWNER);
      const s = await acct.sharedBudget();
      const wait = Number(t.nextAllowedAt) - (await time.latest());
      expect(wait, `attempt ${n}`).to.be.within(expected[n - 1] - 2, expected[n - 1]);
      expect(s.nextAllowedAt).to.eq(t.nextAllowedAt);
      // after the 8th attempt every 7-day back-off crosses a decay boundary: the score settles at 8 (−1, +1)
      expect(Number(t.score), `score ${n}`).to.eq(Math.min(n, 8));
      await finalizeGuess(acct, opId);
      if (expected[n - 1] > 0) await time.increase(expected[n - 1]);
    }
    // time until the 10th guess: 0.25 + 1 + 4 + 16 + 64 h + 2 × 7 days = 421.25 h ≈ 17.6 days
    const total = expected.slice(0, 9).reduce((a, b) => a + b, 0);
    expect(total / HOUR).to.be.closeTo(421.25, 0.01);
  });

  it("single pending guess: a second guess gets SlotBusy", async () => {
    const acct = await fresh();
    const op1 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.05"), true);
    const op2 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.06"), true);
    await guess(acct, owner, stack.chainId, op1, PIN);
    await expect(guess(acct, owner, stack.chainId, op2, PIN)).to.be.revertedWithCustomError(ERR, "SlotBusy");
  });

  it("replay (13.3, E2): same handle → InputReplayed (I5); an old guess value on another op → ok=false", async () => {
    const acct = await fresh();
    const op1 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.05"), true);
    const enc1 = await encGuess(acct, owner.address, stack.chainId, op1, PIN);
    await (await acct.connect(owner).submitGuess(op1, enc1.c, enc1.handles[0], enc1.inputProof)).wait();
    await finalizeGuess(acct, op1);
    expect((await acct.getOp(op1)).status).to.eq(Status.Delayed);

    const op2 = await requestTransfer(acct, owner, ETH, stranger.address, E.parseEther("1"), true);
    const c2 = BigInt(await acct.challengeOf(op2));
    // (a) exact copy: same ciphertext + same proof
    await expect(acct.connect(owner).submitGuess(op2, c2, enc1.handles[0], enc1.inputProof)).to.be.revertedWithCustomError(ERR, "InputReplayed");
    // (b) the VALUE of the old guess in a fresh encrypted input (strongest assumption: even if the attacker knows h + c1)
    const fp = await fingerprint(PIN, stack.chainId, await acct.getAddress());
    const c1 = BigInt(await acct.challengeOf(op1));
    const inp = hre.fhevm.createEncryptedInput(await acct.getAddress(), owner.address);
    inp.add64((fp + c1) % (1n << 64n));
    const old = await inp.encrypt();
    await (await acct.connect(owner).submitGuess(op2, c2, old.handles[0], old.inputProof)).wait();
    await finalizeGuess(acct, op2);
    expect((await acct.getOp(op2)).status).to.eq(Status.NeedsPin);
  });

  it("an empty input proof is rejected everywhere (no handle injection)", async () => {
    const acct = await fresh();
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.05"), true);
    const enc = await encGuess(acct, owner.address, stack.chainId, opId, PIN);
    await expect(acct.connect(owner).submitGuess(opId, enc.c, enc.handles[0], "0x")).to.be.revertedWithCustomError(ERR, "EmptyInputProof");
    const [pinH] = await acct.encryptedHandles(ETH);
    await expect(acct.connect(owner).submitGuess(opId, enc.c, pinH, "0x")).to.be.revertedWithCustomError(ERR, "EmptyInputProof");
  });

  it("a forged decryption cleartext is rejected (checkSignatures)", async () => {
    const acct = await fresh();
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.05"), true);
    await guess(acct, owner, stack.chainId, opId, "999998");
    const res = await decryptForGuess(acct, opId);
    const forged = E.AbiCoder.defaultAbiCoder().encode(["bool", "bool"], [true, false]);
    await expect(acct.finalizeGuess(opId, forged, res.decryptionProof)).to.be.reverted;
  });

  it("I3: the fingerprint is allowed to no address and cannot be publicly decrypted; only okAny is made public; isDuress only to the watchtower", async () => {
    const acct = await fresh();
    const addr = await acct.getAddress();
    const acl = new ethers.Contract(await acct.aclAddress(), ACL_ABI, ethers.provider);
    const [pinH, duressH] = await acct.encryptedHandles(ETH);
    for (const who of [owner.address, guardian.address, escape.address, await stack.entryPoint.getAddress()]) {
      expect(await acl.persistAllowed(pinH, who)).to.eq(false);
      expect(await acl.persistAllowed(duressH, who)).to.eq(false);
    }
    expect(await acl.persistAllowed(pinH, addr)).to.eq(true);
    expect(await acl.isAllowedForDecryption(pinH)).to.eq(false);
    expect(await acl.isAllowedForDecryption(duressH)).to.eq(false);

    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.05"), true);
    await guess(acct, owner, stack.chainId, opId, PIN);
    const g = await acct.getGuess(opId);
    expect(await acl.isAllowedForDecryption(g.okH)).to.eq(true);
    expect(await acl.isAllowedForDecryption(g.duressFlagH)).to.eq(false);
    expect(await acl.persistAllowed(g.duressFlagH, guardian.address)).to.eq(true);
    expect(await userDecryptBool(g.duressFlagH, addr, guardian)).to.eq(false);
    // the owner can decrypt neither the fingerprint nor the duress flag
    let ownerCouldDecrypt = true;
    try {
      await userDecryptBool(g.duressFlagH, addr, owner);
    } catch {
      ownerCouldDecrypt = false;
    }
    expect(ownerCouldDecrypt).to.eq(false);
  });

  it("duress (Phase 2 groundwork): the duress PIN looks 'correct', isDuress only to the watchtower; the real PIN takes precedence", async () => {
    const acct = await fresh({ duressPin: "731905" });
    const addr = await acct.getAddress();
    const op1 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.05"), true);
    await guess(acct, owner, stack.chainId, op1, "731905");
    const g1 = await acct.getGuess(op1);
    expect(await hre.fhevm.publicDecryptEbool(g1.okH)).to.eq(true); // indistinguishable from the normal PIN from outside
    expect(await userDecryptBool(g1.duressFlagH, addr, guardian)).to.eq(true); // silent alarm
    await finalizeGuess(acct, op1);

    const same = await fresh({ duressPin: PIN }); // duress == real → real wins
    const op2 = await requestTransfer(same, owner, ETH, bob.address, E.parseEther("0.05"), true);
    await guess(same, owner, stack.chainId, op2, PIN);
    expect(await userDecryptBool((await same.getGuess(op2)).duressFlagH, await same.getAddress(), guardian)).to.eq(false);
  });

  it("the duress slot's data flow is constant: setup with and without duress produces the same FHE event sequence (17.4 fix)", async () => {
    const seq = async (opts: any) => {
      const d = await defaultDelays(stack);
      const salt = E.id("seq" + Math.random());
      const predicted = await factoryCreate(stack, owner.address, escape.address, guardian.address, d, salt);
      const acct: any = await ethers.getContractAt("EncryptedAccount", predicted);
      const fp = await fingerprint(PIN, stack.chainId, predicted);
      const dc = opts.duress ? await fingerprint("731905", stack.chainId, predicted) : 123456789n;
      const inp = hre.fhevm.createEncryptedInput(predicted, owner.address);
      inp.add64(fp);
      inp.add64(dc);
      inp.addBool(!!opts.duress);
      const enc = await inp.encrypt();
      const rc = await (await acct.connect(owner).setupPin(enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait();
      return hre.fhevm.parseCoprocessorEvents(rc!.logs).map((e: any) => e.name ?? e.eventName ?? e.type);
    };
    const a = await seq({ duress: true });
    const b = await seq({ duress: false });
    expect(a.length).to.be.greaterThan(0);
    expect(a).to.deep.eq(b);
  });

  it("PIN change (13.5, E22): K + old P; the old PIN stays valid during the delay; afterwards only the new PIN (I15); the score is kept (K43)", async () => {
    const acct = await fresh();
    await alignDecay();
    const addr = await acct.getAddress();
    const NEW = "905517";
    const fpNew = await fingerprint(NEW, stack.chainId, addr);
    const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.add64(fpNew);
    const enc = await inp.encrypt();
    const rc = await (await acct.connect(owner).openPinChange(enc.handles[0], enc.inputProof)).wait();
    const changeId = (await acct.opCount()) as bigint;
    void rc;
    // K alone: the op opens but never executes without the PIN
    await expect(acct.executeOp(changeId)).to.be.revertedWithCustomError(ERR, "BadStatus");

    // a wrong old PIN counts toward the same K-track score
    await guess(acct, owner, stack.chainId, changeId, "123987");
    expect((await acct.trackState(TRACK.OWNER)).score).to.eq(1n);
    await finalizeGuess(acct, changeId);
    // correct old PIN
    await guessAndFinalize(acct, owner, stack.chainId, changeId, PIN);
    const ch = await acct.getOp(changeId);
    expect(ch.status).to.eq(Status.Delayed);
    expect(ch.readyAt - BigInt(await time.latest())).to.be.within(BigInt(DAY) - 3n, BigInt(DAY));

    // the old PIN is still valid during the delay
    const t1 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"), true);
    await guessAndFinalize(acct, owner, stack.chainId, t1, PIN);
    expect((await acct.getOp(t1)).status).to.eq(Status.Delayed);

    await time.increase(DAY);
    const scoreBefore = (await acct.trackState(TRACK.OWNER)).score;
    expect(scoreBefore).to.eq(1n);
    await (await acct.executeOp(changeId)).wait();
    const [pinH] = await acct.encryptedHandles(ETH);
    expect(await debugU64(pinH)).to.eq(fpNew);
    expect((await acct.trackState(TRACK.OWNER)).score).to.eq(scoreBefore); // a PIN change does not reset the score

    const t2 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"), true);
    await guessAndFinalize(acct, owner, stack.chainId, t2, PIN); // the old PIN is now wrong
    expect((await acct.getOp(t2)).status).to.eq(Status.NeedsPin);
    await guessAndFinalize(acct, owner, stack.chainId, t2, NEW);
    expect((await acct.getOp(t2)).status).to.eq(Status.Delayed);
  });
});
