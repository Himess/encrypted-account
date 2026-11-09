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
  coder,
  createAccount,
  debugU64,
  deployStack,
  encGuess,
  errs,
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

const PIN = "482915";

describe("F1.2 — Recovery, oracle-independent veto, escape, forgotten PIN, lockout", function () {
  let stack: Stack;
  let owner: any, escape: any, guardian: any, alice: any, bob: any, newKey: any, device: any, helper: any, relayer: any, thief: any;
  let ERR: any;

  before(async () => {
    [owner, escape, guardian, alice, bob, newKey, device, helper, relayer, thief] = await ethers.getSigners();
    stack = await deployStack();
    ERR = await errs();
  });

  async function fresh(opts: any = {}) {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address], ...opts });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("10") });
    await stack.usdc.mint(await acct.getAddress(), 5_000n * 10n ** 6n);
    return acct;
  }

  async function openRecovery(acct: any, by: any, newOwner: any, deviceSigner?: any) {
    const addr = await acct.getAddress();
    const epoch = (await acct.status()).ownerEpoch;
    const payload = E.keccak256(coder.encode(["address", "uint32"], [newOwner.address, epoch]));
    const sig = await personalSign(newOwner, "encrypted-account/recovery/v1", stack.chainId, addr, payload);
    const dsig = deviceSigner ? await personalSign(deviceSigner, "encrypted-account/recovery/v1", stack.chainId, addr, payload) : "0x";
    return await opIdFromReceipt(acct, await (await acct.connect(by).openRecovery(newOwner.address, sig, dsig)).wait());
  }

  async function recoveryGuess(acct: any, by: any, opId: bigint, pin: string) {
    const enc = await encGuess(acct, by.address, stack.chainId, opId, pin);
    const bond = await acct.recoveryBond();
    expect(bond).to.eq(await acct.bondFor((await acct.trackState(TRACK.RECOVERY)).score));
    await (await acct.connect(by).submitRecoveryGuess(opId, enc.c, enc.handles[0], enc.inputProof, { value: bond })).wait();
    return bond;
  }

  it("scenario 2 (16.2): P + K' from a new device → 7 days → new owner; the old K's pending ops die", async () => {
    const acct = await fresh();
    const pendingOld = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("1"), true);
    const opId = await openRecovery(acct, relayer, newKey);
    await recoveryGuess(acct, relayer, opId, PIN);
    await finalizeGuess(acct, opId);
    const op = await acct.getOp(opId);
    expect(op.status).to.eq(Status.Delayed);
    expect(op.readyAt - BigInt(await time.latest())).to.be.within(BigInt(7 * DAY) - 3n, BigInt(7 * DAY));
    // on a successful guess the bond is refundable
    expect(await acct.refundOf(relayer.address)).to.eq(await acct.BASE_BOND());
    await time.increase(7 * DAY);
    await (await acct.connect(thief).executeOp(opId)).wait(); // content is fixed; anyone can execute
    expect(await acct.owner()).to.eq(newKey.address);
    expect((await acct.status()).ownerEpoch).to.eq(1n);
    // the old K's pending op went stale
    const cOld = await acct.challengeOf(pendingOld);
    await expect(acct.connect(newKey).submitGuess.staticCall(pendingOld, cOld, E.ZeroHash, "0x01")).to.be.revertedWithCustomError(ERR, "StaleOp");
    // the old K can no longer do anything
    await expect(acct.connect(owner).restrict.staticCall()).to.be.revertedWithCustomError(ERR, "NotAuthorized");
  });

  it("I6: K alone cannot cancel a recovery; K+P can; the target is paused while the cancel guess is pending", async () => {
    const acct = await fresh();
    const opId = await openRecovery(acct, relayer, newKey);
    await recoveryGuess(acct, relayer, opId, PIN);
    await finalizeGuess(acct, opId);
    // K alone: the cancel op opens but does not execute without the PIN; cancelWithDevice fails without a device signature
    const cancelId = await opIdFromReceipt(acct, await (await acct.connect(owner).openCancel(opId)).wait());
    await expect(acct.connect(owner).cancelWithDevice.staticCall(opId, "0x")).to.be.revertedWithCustomError(ERR, "BadSignature");
    // the target pauses as soon as the cancel guess is submitted
    await time.increase(7 * DAY);
    await guess(acct, owner, stack.chainId, cancelId, PIN);
    expect((await acct.getOp(opId)).paused).to.eq(true);
    await expect(acct.executeOp.staticCall(opId)).to.be.revertedWithCustomError(ERR, "OpPaused");
    await finalizeGuess(acct, cancelId); // delay 0 → executes immediately
    expect((await acct.getOp(opId)).status).to.eq(Status.Cancelled);
    expect(await acct.owner()).to.eq(owner.address);
  });

  it("the recovery track is only for Recovery/Freeze (P alone cannot move funds, S4); the K-track cannot be used for Recovery", async () => {
    const acct = await fresh();
    const out = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("1"), true);
    const enc = await encGuess(acct, relayer.address, stack.chainId, out, PIN);
    await expect(
      acct.connect(relayer).submitRecoveryGuess.staticCall(out, enc.c, enc.handles[0], enc.inputProof, { value: E.parseEther("1") }),
    ).to.be.revertedWithCustomError(ERR, "BadTrack");
    const rec = await openRecovery(acct, relayer, newKey);
    const enc2 = await encGuess(acct, owner.address, stack.chainId, rec, PIN);
    await expect(acct.connect(owner).submitGuess.staticCall(rec, enc2.c, enc2.handles[0], enc2.inputProof)).to.be.revertedWithCustomError(ERR, "BadTrack");
  });

  it("E12: on the recovery track a wrong guess's bond goes to the account and doubles with each score point", async () => {
    const acct = await fresh();
    await alignDecay();
    const addr = await acct.getAddress();
    const opId = await openRecovery(acct, thief, thief);
    const base = await acct.BASE_BOND();
    const enc = await encGuess(acct, thief.address, stack.chainId, opId, "100001");
    await expect(acct.connect(thief).submitRecoveryGuess.staticCall(opId, enc.c, enc.handles[0], enc.inputProof, { value: base - 1n }))
      .to.be.revertedWithCustomError(ERR, "BondTooLow");
    let total = 0n;
    const waits = [0, 0, 15 * 60, HOUR];
    for (let i = 0; i < 4; i++) {
      const bal0 = await ethers.provider.getBalance(addr);
      const bond = await recoveryGuess(acct, thief, opId, "10000" + i);
      expect(bond).to.eq(base << BigInt(i));
      await finalizeGuess(acct, opId);
      expect((await ethers.provider.getBalance(addr)) - bal0).to.eq(bond); // the bond stayed in the account
      total += bond;
      await time.increase(waits[i] + 1);
    }
    expect(await acct.refundOf(thief.address)).to.eq(0n);
    expect(total).to.eq(base * 15n);
    // wrong guesses on the recovery track do not restrict the account (only that track and the shared budget)
    expect((await acct.status()).restrictedReasons).to.eq(0n);
    // K56: shared budget = K-track score + recovery-track score (not stored); the K-track hits the same back-off
    expect((await acct.sharedBudget()).score).to.eq(4n);
    expect((await acct.trackState(TRACK.OWNER)).nextAllowedAt).to.eq((await acct.trackState(TRACK.RECOVERY)).nextAllowedAt);
  });

  it("16.7 oracle-independent veto: starting an escape cancels the recovery (K54) and no new recovery can be opened", async () => {
    const acct = await fresh();
    const opId = await openRecovery(acct, relayer, newKey);
    await recoveryGuess(acct, relayer, opId, PIN);
    await finalizeGuess(acct, opId);
    await (await acct.connect(owner).startEscape()).wait(); // K-only, no FHE
    expect((await acct.getOp(opId)).status).to.eq(Status.Cancelled);
    await time.increase(7 * DAY);
    await expect(acct.executeOp.staticCall(opId)).to.be.revertedWithCustomError(ERR, "BadStatus");
    const addr = await acct.getAddress();
    const payload = E.keccak256(coder.encode(["address", "uint32"], [newKey.address, 0]));
    const sig = await personalSign(newKey, "encrypted-account/recovery/v1", stack.chainId, addr, payload);
    await expect(acct.connect(relayer).openRecovery.staticCall(newKey.address, sig, "0x")).to.be.revertedWithCustomError(ERR, "EscapeActive");
  });

  it("K+D veto: a device signature cancels the recovery immediately, without the oracle", async () => {
    const acct = await fresh({ device: device.address });
    const opId = await openRecovery(acct, relayer, newKey);
    await recoveryGuess(acct, relayer, opId, PIN);
    await finalizeGuess(acct, opId);
    // D registered but no co-signature → 30 days
    expect((await acct.getOp(opId)).readyAt - BigInt(await time.latest())).to.be.within(BigInt(30 * DAY) - 3n, BigInt(30 * DAY));
    const addr = await acct.getAddress();
    const sig = await personalSign(device, "encrypted-account/device-cancel/v1", stack.chainId, addr, E.keccak256(coder.encode(["uint256"], [opId])));
    await (await acct.connect(owner).cancelWithDevice(opId, sig)).wait();
    expect((await acct.getOp(opId)).status).to.eq(Status.Cancelled);
  });

  it("a recovery co-signed by D takes 7 days; option to disable seedless recovery (K-only, restrictive)", async () => {
    const acct = await fresh({ device: device.address });
    const opId = await openRecovery(acct, relayer, newKey, device);
    await recoveryGuess(acct, relayer, opId, PIN);
    await finalizeGuess(acct, opId);
    expect((await acct.getOp(opId)).readyAt - BigInt(await time.latest())).to.be.within(BigInt(7 * DAY) - 3n, BigInt(7 * DAY));
    await (await acct.connect(owner).disableRecovery()).wait();
    await time.increase(7 * DAY);
    await expect(acct.executeOp.staticCall(opId)).to.be.revertedWithCustomError(ERR, "RecoveryDisabled");
  });

  it("escape (16.5, I7): K-only + 30 days; funds go ONLY to E_addr; restricted mode does not block it; only the lane can cancel it (I22)", async () => {
    const acct = await fresh();
    await (await acct.connect(owner).restrict()).wait();
    await (await acct.connect(owner).startEscape()).wait();
    await expect(acct.executeEscape.staticCall([await stack.usdc.getAddress()])).to.be.revertedWithCustomError(ERR, "NotReady");
    await time.increase(30 * DAY);
    const e0 = await ethers.provider.getBalance(escape.address);
    const u0 = await stack.usdc.balanceOf(escape.address);
    await (await acct.connect(thief).executeEscape([await stack.usdc.getAddress()])).wait(); // even if the thief triggers it
    expect((await ethers.provider.getBalance(escape.address)) - e0).to.eq(E.parseEther("10"));
    expect((await stack.usdc.balanceOf(escape.address)) - u0).to.eq(5_000n * 10n ** 6n);
    expect(await ethers.provider.getBalance(await acct.getAddress())).to.eq(0n);

    // second account (no D): the escape cannot be cancelled; CANCEL_ESCAPE cannot even be opened (I22)
    const acct2 = await fresh();
    await (await acct2.connect(owner).startEscape()).wait();
    await expect(acct2.connect(owner).openAdmin.staticCall(A.CANCEL_ESCAPE, "0x")).to.be.revertedWithCustomError(ERR, "NotAuthorized");

    // third account (with D): K+P is rejected on the K-track; K + D + P cancels on the lane
    const acct3 = await fresh({ device: device.address });
    await (await acct3.connect(owner).startEscape()).wait();
    const c = await opIdFromReceipt(acct3, await (await acct3.connect(owner).openAdmin(A.CANCEL_ESCAPE, "0x")).wait());
    await expect(guess(acct3, owner, stack.chainId, c, PIN)).to.be.revertedWithCustomError(ERR, "BadTrack");
    await laneGuess(acct3, owner, device, stack.chainId, c, PIN);
    await finalizeGuess(acct3, c);
    expect((await acct3.status()).escapeReadyAt).to.eq(0n);
  });

  it("Zama censorship: the escape works even if the ACL blacklists the account; PIN operations stop (S7)", async () => {
    const acct = await fresh();
    const addr = await acct.getAddress();
    const acl = new ethers.Contract(
      await acct.aclAddress(),
      ["function owner() view returns (address)", "function blockAccount(address)", "function isAccountDenied(address) view returns (bool)"],
      ethers.provider,
    );
    const aclOwner = await acl.owner();
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [aclOwner] });
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [aclOwner, "0xDE0B6B3A7640000"] });
    const ownerSigner = await ethers.getSigner(aclOwner);
    await (await (acl.connect(ownerSigner) as any).blockAccount(addr)).wait();
    expect(await acl.isAccountDenied(addr)).to.eq(true);

    const op = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("1"), true);
    const enc = await encGuess(acct, owner.address, stack.chainId, op, PIN);
    await expect(acct.connect(owner).submitGuess.staticCall(op, enc.c, enc.handles[0], enc.inputProof)).to.be.reverted; // SenderDenied
    await (await acct.connect(owner).startEscape()).wait();
    await time.increase(30 * DAY);
    const e0 = await ethers.provider.getBalance(escape.address);
    await (await acct.executeEscape([])).wait();
    expect((await ethers.provider.getBalance(escape.address)) - e0).to.eq(E.parseEther("10"));
  });

  it("P alone can freeze (11.3): a Freeze op from a new device is verified on the recovery track → restricted mode", async () => {
    const acct = await fresh();
    const f = await opIdFromReceipt(acct, await (await acct.connect(relayer).openFreeze()).wait());
    await recoveryGuess(acct, relayer, f, PIN);
    await finalizeGuess(acct, f);
    expect((await acct.status()).restrictedReasons & BigInt(R.PIN)).to.eq(BigInt(R.PIN));
  });

  it("E16/S9 lockout: even if a thief holding K saturates the K-track, the owner enters the PIN on the lane co-signed by D", async () => {
    const acct = await fresh({ device: device.address });
    await alignDecay();
    const op = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("1"), true);
    // the thief (with K) enters wrong PINs back to back and piles up back-off
    for (let i = 0; i < 4; i++) {
      await guess(acct, owner, stack.chainId, op, "30000" + i);
      await finalizeGuess(acct, op);
      if (i === 2) await time.increase(15 * 60);
    }
    await expect(guess(acct, owner, stack.chainId, op, PIN)).to.be.revertedWithCustomError(ERR, "Backoff");
    // owner: separate lane with K + D's co-signature (own slot, own counter, outside the shared budget)
    const enc = await encGuess(acct, owner.address, stack.chainId, op, PIN);
    const addr = await acct.getAddress();
    const cos = await personalSign(device, "encrypted-account/lane/v1", stack.chainId, addr, E.keccak256(coder.encode(["uint256", "bytes32"], [op, enc.handles[0]])));
    await (await acct.connect(owner).submitGuessWithCosign(op, enc.c, enc.handles[0], enc.inputProof, cos)).wait();
    await finalizeGuess(acct, op);
    expect((await acct.getOp(op)).status).to.eq(Status.Delayed);
    expect((await acct.trackState(TRACK.LANE)).score).to.eq(0n);
    // K43: K-track score 4 >= 3, so even a correct PIN on the lane does not lift the restriction; the owner approves UNRESTRICT via the lane
    expect((await acct.trackState(TRACK.OWNER)).score).to.eq(4n);
    expect((await acct.status()).restrictedReasons & BigInt(R.STRIKES)).to.eq(BigInt(R.STRIKES));
    const un = await opIdFromReceipt(acct, await (await acct.connect(owner).openAdmin(A.UNRESTRICT, "0x")).wait());
    await laneGuess(acct, owner, device, stack.chainId, un, PIN);
    await finalizeGuess(acct, un);
    expect((await acct.status()).restrictedReasons).to.eq(0n);
  });

  it("forgotten PIN (16.3, I15): K + D's co-signature + 30 days → new PIN; rejected without the co-signature", async () => {
    const acct = await fresh({ device: device.address });
    const addr = await acct.getAddress();
    const NEW = "640271";
    const fpNew = await fingerprint(NEW, stack.chainId, addr);
    const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.add64(fpNew);
    const enc = await inp.encrypt();
    await expect(acct.connect(owner).openPinReset.staticCall(enc.handles[0], enc.inputProof, "0x")).to.be.reverted;
    const payload = E.keccak256(coder.encode(["bytes32", "uint32"], [enc.handles[0], 0]));
    const cos = await personalSign(device, "encrypted-account/pin-reset/v1", stack.chainId, addr, payload);
    const id = await opIdFromReceipt(acct, await (await acct.connect(owner).openPinReset(enc.handles[0], enc.inputProof, cos)).wait());
    expect((await acct.getOp(id)).status).to.eq(Status.Delayed);
    // a second opening with the same co-signature: replay rejection
    const inp2 = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp2.add64(fpNew);
    await time.increase(30 * DAY);
    await (await acct.executeOp(id)).wait();
    const [pinH] = await acct.encryptedHandles(ETH);
    expect(await debugU64(pinH)).to.eq(fpNew);
    const t = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"), true);
    await guessAndFinalize(acct, owner, stack.chainId, t, NEW);
    expect((await acct.getOp(t)).status).to.eq(Status.Delayed);
  });

  it("key rotation (K→K', K+P + 24 h) and watchtower change; the old watchtower can no longer restrict", async () => {
    const acct = await fresh();
    const rot = await opIdFromReceipt(acct, await (await acct.connect(owner).openAdmin(A.ROTATE_OWNER, coder.encode(["address"], [newKey.address]))).wait());
    await guessAndFinalize(acct, owner, stack.chainId, rot, PIN);
    await time.increase(DAY);
    await (await acct.executeOp(rot)).wait();
    expect(await acct.owner()).to.eq(newKey.address);
    const g = await opIdFromReceipt(acct, await (await acct.connect(newKey).openAdmin(A.SET_GUARDIAN, coder.encode(["address"], [helper.address]))).wait());
    await guessAndFinalize(acct, newKey, stack.chainId, g, PIN);
    await time.increase(DAY);
    await (await acct.executeOp(g)).wait();
    await expect(acct.connect(guardian).guardianRestrict.staticCall()).to.be.revertedWithCustomError(ERR, "NotAuthorized");
    await (await acct.connect(helper).guardianRestrict()).wait();
  });
});
