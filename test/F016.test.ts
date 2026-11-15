import { expect } from "chai";
import { ethers as E } from "ethers";
import * as hre from "hardhat";
import {
  A,
  BASE_BOND,
  DAY,
  ETH,
  HOUR,
  Stack,
  Status,
  alignDecay,
  backoffT2,
  coder,
  createAccount,
  createAccountB,
  deployStack,
  deployStackB,
  encGuess,
  errs,
  ethers,
  factoryCreate,
  finalizeEvaluation,
  finalizeGuess,
  guess,
  laneGuess,
  ownerBondFor,
  requestTransfer,
  time,
  accountAt,
  defaultDelays,
} from "./helpers";

const PIN = "482915";
const WRONG = "000001";

/** Wrong K-track guess with exactly the required bond; returns the bond. Waits out the back-off first. */
async function wrongGuess(acct: any, owner: any, chainId: bigint, opId: bigint): Promise<bigint> {
  const [score] = await acct.trackState(0);
  await time.increase(backoffT2(Number(score)) + 1);
  const [required] = await acct.ownerBond();
  await guess(acct, owner, chainId, opId, WRONG);
  await finalizeGuess(acct, opId);
  return BigInt(required);
}

describe("F0.16 — owner-track bond", function () {
  let stack: Stack;
  let owner: any, escape: any, guardian: any, alice: any, bob: any, stranger: any, helper: any;
  let ERR: any;

  before(async () => {
    [owner, escape, guardian, alice, bob, stranger, helper] = await ethers.getSigners();
    stack = await deployStack();
    ERR = await errs();
  });

  async function fresh(opts: any = {}) {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address], ...opts });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("2") });
    return acct;
  }

  it("the first K-track guess costs BASE_BOND; less reverts with BondTooLow and counts nothing", async () => {
    const acct = await fresh();
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"), true);
    const [required, base] = await acct.ownerBond();
    expect(required).to.eq(BASE_BOND);
    expect(base).to.eq(BASE_BOND);
    const enc = await encGuess(acct, owner.address, stack.chainId, opId, PIN);
    await expect(acct.connect(owner).submitGuess.staticCall(opId, enc.c, enc.handles[0], enc.inputProof, { value: BASE_BOND - 1n }))
      .to.be.revertedWithCustomError(ERR, "BondTooLow")
      .withArgs(BASE_BOND);
    await expect(acct.connect(owner).submitGuess.staticCall(opId, enc.c, enc.handles[0], enc.inputProof)).to.be.revertedWithCustomError(ERR, "BondTooLow");
    expect((await acct.trackState(0)).score).to.eq(0n);
    await (await acct.connect(owner).submitGuess(opId, enc.c, enc.handles[0], enc.inputProof, { value: BASE_BOND })).wait();
    await finalizeGuess(acct, opId);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed);
    expect(await acct.refundOf(owner.address)).to.eq(BASE_BOND);
  });

  it("doubling: each wrong guess doubles the next bond (the default equals the recovery track's); wrong bonds stay, a correct one is refunded once", async () => {
    await alignDecay();
    const acct = await fresh();
    const addr = await acct.getAddress();
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"), true);
    for (let s = 0; s < 5; s++) {
      const [required] = await acct.ownerBond();
      expect(required).to.eq(ownerBondFor(s));
      expect(required).to.eq(await acct.bondFor(s)); // default base: the recovery track's doubling
      const bal0 = await ethers.provider.getBalance(addr);
      const bond = await wrongGuess(acct, owner, stack.chainId, opId);
      expect(bond).to.eq(ownerBondFor(s));
      expect((await ethers.provider.getBalance(addr)) - bal0).to.eq(bond); // the bond stays with the account
      expect(await acct.refundOf(owner.address)).to.eq(0n);
    }
    await time.increase(backoffT2(5) + 1);
    const [last] = await acct.ownerBond();
    expect(last).to.eq(ownerBondFor(5));
    await guess(acct, owner, stack.chainId, opId, PIN);
    await finalizeGuess(acct, opId);
    expect(await acct.refundOf(owner.address)).to.eq(last);

    const before = await ethers.provider.getBalance(owner.address);
    const rc = await (await acct.connect(owner).claimRefund()).wait();
    const gas = BigInt(rc!.gasUsed) * BigInt(rc!.gasPrice);
    expect((await ethers.provider.getBalance(owner.address)) - before + gas).to.eq(last);
    expect(await acct.refundOf(owner.address)).to.eq(0n);
    const rc2 = await (await acct.connect(owner).claimRefund()).wait(); // nothing left: a no-op
    expect((await ethers.provider.getBalance(owner.address)) - before + gas + BigInt(rc2!.gasUsed) * BigInt(rc2!.gasPrice)).to.eq(last);
  });

  it("only K, directly: a stranger cannot submit even with a bond; the account cannot call itself (no generic execute, openCall forbids self)", async () => {
    const acct = await fresh();
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"), true);
    const enc = await encGuess(acct, stranger.address, stack.chainId, opId, PIN);
    await expect(
      acct.connect(stranger).submitGuess.staticCall(opId, enc.c, enc.handles[0], enc.inputProof, { value: E.parseEther("1") }),
    ).to.be.revertedWithCustomError(ERR, "NotAuthorized");
    expect(acct.interface.getFunction("execute")).to.eq(null);
    expect(acct.interface.getFunction("multicall")).to.eq(null);
    await expect(acct.connect(owner).openCall.staticCall(await acct.getAddress(), E.parseEther("1"), "0x")).to.be.revertedWithCustomError(
      ERR,
      "ForbiddenTarget",
    );
  });

  it("one guess in flight per track: a parallel K-track guess gets SlotBusy, the next one is priced at the score the wrong guess left", async () => {
    await alignDecay();
    const acct = await fresh();
    const opA = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"), true);
    const opB = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.02"), true);
    await guess(acct, owner, stack.chainId, opA, WRONG); // in flight
    const enc = await encGuess(acct, owner.address, stack.chainId, opB, WRONG);
    await expect(
      acct.connect(owner).submitGuess.staticCall(opB, enc.c, enc.handles[0], enc.inputProof, { value: BASE_BOND }),
    ).to.be.revertedWithCustomError(ERR, "SlotBusy");
    await finalizeGuess(acct, opA);
    const [required] = await acct.ownerBond();
    expect(required).to.eq(ownerBondFor(1));
    await expect(
      acct.connect(owner).submitGuess.staticCall(opB, enc.c, enc.handles[0], enc.inputProof, { value: BASE_BOND }),
    ).to.be.revertedWithCustomError(ERR, "BondTooLow");
  });

  it("the lane stays unbonded, and its score does not change the K-track bond", async () => {
    const acct = await fresh({ helper: helper.address });
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"), true);
    await laneGuess(acct, owner, helper, stack.chainId, opId, WRONG); // no value at all
    await finalizeGuess(acct, opId);
    expect((await acct.trackState(2)).score).to.eq(1n);
    const [required] = await acct.ownerBond();
    expect(required).to.eq(BASE_BOND);
    expect(acct.interface.getFunction("submitGuessWithCosign")!.payable).to.eq(false);
  });

  it("escape while a bonded guess is in flight: a correct one is still refunded when finalized, a wrong one stays, an unfinalized one stays", async () => {
    const acct = await fresh();
    const addr = await acct.getAddress();
    const op1 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"), true);
    await guess(acct, owner, stack.chainId, op1, PIN); // in flight
    await (await acct.connect(owner).startEscape()).wait(); // cancels op1 (K54)
    await finalizeGuess(acct, op1);
    expect((await acct.getOp(op1)).status).to.eq(Status.Cancelled);
    expect(await acct.refundOf(owner.address)).to.eq(BASE_BOND); // the owner's correct guess costs nothing

    const acct2 = await fresh();
    const op2 = await requestTransfer(acct2, owner, ETH, bob.address, E.parseEther("0.01"), true);
    const bal0 = await ethers.provider.getBalance(await acct2.getAddress());
    await guess(acct2, owner, stack.chainId, op2, WRONG);
    await (await acct2.connect(owner).startEscape()).wait();
    await finalizeGuess(acct2, op2);
    expect(await acct2.refundOf(owner.address)).to.eq(0n);
    expect((await ethers.provider.getBalance(await acct2.getAddress())) - bal0).to.eq(BASE_BOND);

    const acct3 = await fresh();
    const op3 = await requestTransfer(acct3, owner, ETH, bob.address, E.parseEther("0.01"), true);
    const bal3 = await ethers.provider.getBalance(await acct3.getAddress());
    await guess(acct3, owner, stack.chainId, op3, PIN);
    await (await acct3.connect(owner).startEscape()).wait(); // never finalized
    expect(await acct3.refundOf(owner.address)).to.eq(0n);
    expect((await ethers.provider.getBalance(await acct3.getAddress())) - bal3).to.eq(BASE_BOND);
    void addr;
  });

  it("claimRefund cannot be re-entered: a payer contract that re-enters is paid exactly once", async () => {
    const acct = await fresh();
    const addr = await acct.getAddress();
    const relayer: any = await (await ethers.getContractFactory("ReentrantRelayer")).deploy(addr);
    await relayer.waitForDeployment();
    const rAddr = await relayer.getAddress();
    const rc = await (await acct.connect(stranger).openFreeze()).wait();
    const opId = await acct.opCount();
    void rc;
    const bond = await acct.recoveryBond();
    const enc = await encGuess(acct, rAddr, stack.chainId, opId, PIN);
    await (await relayer.guess(opId, enc.c, enc.handles[0], enc.inputProof, { value: bond })).wait();
    await finalizeGuess(acct, opId);
    expect(await acct.refundOf(rAddr)).to.eq(bond);
    await (await relayer.claim()).wait();
    expect(await relayer.received()).to.eq(bond);
    expect(await relayer.reentered()).to.eq(true);
    expect(await relayer.reentryBlocked()).to.eq(true); // nonReentrant
    expect(await acct.refundOf(rAddr)).to.eq(0n);
  });
});

describe("F0.16 — adjustable base bond", function () {
  let stack: Stack;
  let owner: any, escape: any, guardian: any, alice: any, bob: any, helper: any;
  let ERR: any;

  before(async () => {
    [owner, escape, guardian, alice, bob, , helper] = await ethers.getSigners();
    stack = await deployStack();
    ERR = await errs();
  });

  it("set at setup: every guess is priced from the base, the first one included, and doubles; a correct PIN refunds it", async () => {
    await alignDecay();
    const base = E.parseEther("0.1");
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address], ownerBaseBond: base });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("1") });
    const [r0, b0] = await acct.ownerBond();
    expect(r0).to.eq(base); // the first guess costs the base too
    expect(b0).to.eq(base);
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"), true);
    const enc = await encGuess(acct, owner.address, stack.chainId, opId, WRONG);
    await expect(
      acct.connect(owner).submitGuess.staticCall(opId, enc.c, enc.handles[0], enc.inputProof, { value: BASE_BOND }),
    ).to.be.revertedWithCustomError(ERR, "BondTooLow").withArgs(base);
    expect(await wrongGuess(acct, owner, stack.chainId, opId)).to.eq(base);
    expect((await acct.ownerBond())[0]).to.eq(2n * base);
    expect(await wrongGuess(acct, owner, stack.chainId, opId)).to.eq(2n * base);
    expect((await acct.ownerBond())[0]).to.eq(4n * base);
    expect(ownerBondFor(2, base)).to.eq(4n * base);
    await time.increase(backoffT2(2) + 1);
    await guess(acct, owner, stack.chainId, opId, PIN); // the owner: 0.4 ETH, back on the correct PIN
    await finalizeGuess(acct, opId);
    expect(await acct.refundOf(owner.address)).to.eq(4n * base);
  });

  it("only a PIN-verified admin op changes it after arming; K alone cannot", async () => {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address] });
    await expect(acct.connect(owner).setupOwnerBond.staticCall(E.parseEther("1"))).to.be.revertedWithCustomError(ERR, "AlreadyArmed");
    const rc = await (await acct.connect(owner).openAdmin(A.SET_OWNER_BOND, coder.encode(["uint256"], [E.parseEther("1")]))).wait();
    const opId = await acct.opCount();
    void rc;
    await guess(acct, owner, stack.chainId, opId, PIN);
    await finalizeGuess(acct, opId);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed); // settings delay (24 h)
    await expect(acct.executeOp.staticCall(opId)).to.be.revertedWithCustomError(ERR, "NotReady");
    await time.increase(DAY + 1);
    await expect(acct.executeOp(opId)).to.emit(acct, "OwnerBondSet").withArgs(E.parseEther("1"));
    expect((await acct.ownerBond())[1]).to.eq(E.parseEther("1"));
  });

  it("bounds: at least BASE_BOND, at most 100 ETH, a multiple of BASE_BOND — at setup and in the admin op", async () => {
    const d = await defaultDelays(stack);
    const addr = await factoryCreate(stack, owner.address, escape.address, guardian.address, d, E.id("bounds-" + Math.random()));
    const acct = await accountAt(addr);
    for (const bad of [BASE_BOND - 1n, E.parseEther("0.0015"), E.parseEther("100") + BASE_BOND, 0n]) {
      await expect(acct.connect(owner).setupOwnerBond.staticCall(bad)).to.be.revertedWithCustomError(ERR, "InvalidParams");
    }
    await (await acct.connect(owner).setupOwnerBond(E.parseEther("100"))).wait();
    expect((await acct.ownerBond())[1]).to.eq(E.parseEther("100"));
    await (await acct.connect(owner).setupOwnerBond(BASE_BOND)).wait();
    expect((await acct.ownerBond())[1]).to.eq(BASE_BOND);

    const armed = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address] });
    await expect(
      armed.connect(owner).openAdmin.staticCall(A.SET_OWNER_BOND, coder.encode(["uint256"], [E.parseEther("101")])),
    ).to.be.revertedWithCustomError(ERR, "InvalidParams");
  });

  it("no lock-out at a high score: the owner continues on the unbonded lane, and the escape needs no PIN", async () => {
    await alignDecay();
    const base = E.parseEther("10");
    const acct = await createAccount(stack, owner, escape.address, guardian.address, {
      knownRecipients: [alice.address],
      helper: helper.address,
      ownerBaseBond: base,
    });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("1") });
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"), true);
    for (let i = 0; i < 3; i++) await wrongGuess(acct, owner, stack.chainId, opId); // 10 + 20 + 40 ETH, kept
    expect((await acct.ownerBond())[0]).to.eq(8n * base); // 80 ETH
    await laneGuess(acct, owner, helper, stack.chainId, opId, PIN); // free
    await finalizeGuess(acct, opId);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed);

    const bal = await ethers.provider.getBalance(await acct.getAddress());
    const escBal = await ethers.provider.getBalance(escape.address);
    await (await acct.connect(owner).startEscape()).wait();
    await time.increase(30 * DAY + 1);
    await (await acct.connect(owner).executeEscape([])).wait();
    expect((await ethers.provider.getBalance(escape.address)) - escBal).to.eq(bal); // everything, bonds included
  });
});

describe("F0.16 — protocol fee on PIN-verified transfers", function () {
  let stack: Stack;
  let owner: any, escape: any, guardian: any, alice: any, bob: any, recipient: any;
  let ERR: any;
  const ETH_FEE = { bps: 10, minFee: E.parseEther("0.00001"), maxFee: E.parseEther("0.001") };
  const USDC_FEE = { bps: 10, minFee: 500_000n, maxFee: 5_000_000n }; // 0.5 .. 5 USDC

  before(async () => {
    [owner, escape, guardian, alice, bob, , , recipient] = await ethers.getSigners();
    stack = await deployStack([{ asset: ETH, ...ETH_FEE }, { asset: "USDC", ...USDC_FEE }], recipient.address);
    ERR = await errs();
  });

  async function fresh() {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address] });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("5") });
    await stack.usdc.mint(await acct.getAddress(), 10_000n * 10n ** 6n);
    return acct;
  }

  async function verify(acct: any, opId: bigint, delay = HOUR) {
    await guess(acct, owner, stack.chainId, opId, PIN);
    await finalizeGuess(acct, opId);
    await time.increase(delay + 1);
  }

  it("ETH: the fee is bound at opening, paid on top; the payee gets exactly the amount", async () => {
    const acct = await fresh();
    const addr = await acct.getAddress();
    const amount = E.parseEther("0.2");
    const fee = (amount * 10n) / 10_000n; // 0.0002 ETH
    const opId = await requestTransfer(acct, owner, ETH, bob.address, amount, true);
    expect((await acct.getOp(opId)).fee).to.eq(fee);
    await verify(acct, opId);
    const [b0, r0, a0] = await Promise.all([bob.address, recipient.address, addr].map((x) => ethers.provider.getBalance(x)));
    await expect(acct.connect(alice).executeOp(opId)).to.emit(acct, "FeePaid").withArgs(opId, recipient.address, fee);
    expect((await ethers.provider.getBalance(bob.address)) - b0).to.eq(amount);
    expect((await ethers.provider.getBalance(recipient.address)) - r0).to.eq(fee);
    expect(a0 - (await ethers.provider.getBalance(addr))).to.eq(amount + fee);
  });

  it("ERC-20: fee in the token, clamped up to minFee; the payee gets exactly the amount", async () => {
    const acct = await fresh();
    const usdc = stack.usdc;
    const amount = 100_000_000n; // 100 USDC → 0.1 USDC < min
    const opId = await requestTransfer(acct, owner, await usdc.getAddress(), bob.address, amount, true);
    expect((await acct.getOp(opId)).fee).to.eq(USDC_FEE.minFee);
    await verify(acct, opId);
    const [b0, r0] = await Promise.all([usdc.balanceOf(bob.address), usdc.balanceOf(recipient.address)]);
    await (await acct.executeOp(opId)).wait();
    expect((await usdc.balanceOf(bob.address)) - b0).to.eq(amount);
    expect((await usdc.balanceOf(recipient.address)) - r0).to.eq(USDC_FEE.minFee);
  });

  it("clamped down to maxFee; an asset without a fee row pays nothing", async () => {
    const acct = await fresh();
    const big = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("2"), true); // 0.002 > max
    expect((await acct.getOp(big)).fee).to.eq(ETH_FEE.maxFee);

    const other: any = await (await ethers.getContractFactory("MockERC20")).deploy("Other", "OTH", 18);
    await other.waitForDeployment();
    await other.mint(await acct.getAddress(), E.parseEther("10"));
    const opId = await requestTransfer(acct, owner, await other.getAddress(), bob.address, E.parseEther("1"), true);
    expect((await acct.getOp(opId)).fee).to.eq(0n);
    await verify(acct, opId, 48 * HOUR); // unconfigured asset: always the long delay class
    const rc = await (await acct.executeOp(opId)).wait();
    const names = rc!.logs.map((l: any) => { try { return acct.interface.parseLog(l)?.name; } catch { return null; } });
    expect(names).to.not.include("FeePaid");
    expect(names).to.not.include("FeeSkipped");
    expect(await other.balanceOf(bob.address)).to.eq(E.parseEther("1"));
  });

  it("a config change after opening does not touch the open op; a later op gets the new fee", async () => {
    const acct = await fresh();
    const amount = E.parseEther("0.2");
    const opId = await requestTransfer(acct, owner, ETH, bob.address, amount, true);
    const bound = (await acct.getOp(opId)).fee;
    await (await stack.feeConfig.setFee(ETH, 5, ETH_FEE.minFee, ETH_FEE.maxFee)).wait(); // decrease: at once
    const later = await requestTransfer(acct, owner, ETH, bob.address, amount, true);
    expect((await acct.getOp(later)).fee).to.eq((amount * 5n) / 10_000n);
    await verify(acct, opId);
    await expect(acct.executeOp(opId)).to.emit(acct, "FeePaid").withArgs(opId, recipient.address, bound);
    await (await stack.feeConfig.setFee(ETH, ETH_FEE.bps, ETH_FEE.minFee, ETH_FEE.maxFee)).wait(); // increase: queued
    await time.increase(7 * DAY + 1);
    await (await stack.feeConfig.applyFee(ETH)).wait();
  });

  it("FeeConfig: increases wait 7 days, decreases apply at once, feeBps is capped at 1%", async () => {
    const fc = stack.feeConfig;
    const v0 = await fc.version();
    await expect(fc.setFee(ETH, 20, ETH_FEE.minFee, ETH_FEE.maxFee)).to.emit(fc, "FeeQueued");
    expect((await fc.quote(ETH, E.parseEther("0.2")))[0]).to.eq(E.parseEther("0.0002")); // unchanged
    await expect(fc.applyFee.staticCall(ETH)).to.be.revertedWithCustomError(fc, "NotReady");
    await time.increase(7 * DAY + 1);
    await (await fc.applyFee(ETH)).wait();
    expect((await fc.quote(ETH, E.parseEther("0.2")))[0]).to.eq(E.parseEther("0.0004"));
    expect(await fc.version()).to.eq(v0 + 1n);
    await expect(fc.setFee(ETH, 10, ETH_FEE.minFee, ETH_FEE.maxFee)).to.emit(fc, "FeeSet"); // decrease: at once
    // the 1% cap bounds the final fee: a minimum above 1% of a small amount is cut to 1%
    expect((await fc.quote(ETH, E.parseEther("0.0005")))[0]).to.eq(E.parseEther("0.000005"));
    expect((await fc.quote(ETH, E.parseEther("0.001")))[0]).to.eq(ETH_FEE.minFee);
    expect((await fc.quote(ETH, 2n ** 255n))[0]).to.eq(ETH_FEE.maxFee); // no overflow on a huge amount
    await expect(fc.setFee.staticCall(ETH, 101, 0, ETH_FEE.maxFee)).to.be.revertedWithCustomError(fc, "InvalidFee");
    await expect(fc.connect(alice).setFee.staticCall(ETH, 1, 0, 1)).to.be.revertedWithCustomError(fc, "NotAdmin");
    const F = await ethers.getContractFactory("FeeConfig");
    const bad = await F.getDeployTransaction(owner.address, recipient.address, [ETH], [101], [0], [1]);
    await expect(owner.call(bad)).to.be.revertedWithCustomError(fc, "InvalidFee"); // eth_call: the alpha plugin crashes on reverting sends
  });

  it("K-only transfers pay no fee (the bound fee is charged only on the PIN path)", async () => {
    const acct = await fresh();
    const r0 = await ethers.provider.getBalance(recipient.address);
    const a0 = await ethers.provider.getBalance(alice.address);
    const opId = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01"), false);
    expect((await acct.getOp(opId)).fee).to.eq(ETH_FEE.minFee); // bound anyway (closes the evaluation detour)
    await finalizeEvaluation(acct, opId, bob);
    expect((await acct.getOp(opId)).status).to.eq(Status.Executed);
    expect((await ethers.provider.getBalance(alice.address)) - a0).to.eq(E.parseEther("0.01"));
    expect(await ethers.provider.getBalance(recipient.address)).to.eq(r0);
  });

  it("amount + fee not covered: executeOp reverts and the op stays delayed until the balance is there", async () => {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address] });
    const addr = await acct.getAddress();
    const amount = E.parseEther("0.2");
    await owner.sendTransaction({ to: addr, value: amount });
    const opId = await requestTransfer(acct, owner, ETH, bob.address, amount, true);
    await verify(acct, opId);
    await (await acct.connect(owner).claimRefund()).wait(); // take the guess bond out: exactly `amount` is left
    const fee = (await acct.getOp(opId)).fee;
    await expect(acct.executeOp.staticCall(opId)).to.be.revertedWithCustomError(ERR, "InsufficientBalance").withArgs(amount + fee);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed);
    await owner.sendTransaction({ to: addr, value: fee });
    await (await acct.executeOp(opId)).wait();
    expect((await acct.getOp(opId)).status).to.eq(Status.Executed);
  });

  it("a fee recipient that rejects the fee cannot block a verified transfer (FeeSkipped)", async () => {
    const rej: any = await (await ethers.getContractFactory("RejectingReceiver")).deploy();
    await rej.waitForDeployment();
    await (await stack.feeConfig.setRecipient(await rej.getAddress())).wait();
    const acct = await fresh();
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.2"), true);
    await verify(acct, opId);
    const b0 = await ethers.provider.getBalance(bob.address);
    await expect(acct.executeOp(opId)).to.emit(acct, "FeeSkipped");
    expect((await ethers.provider.getBalance(bob.address)) - b0).to.eq(E.parseEther("0.2"));
    await (await stack.feeConfig.setRecipient(recipient.address)).wait();
  });

  it("a reverting FeeConfig: transfers open with fee 0 and run; K-only and the escape keep working", async () => {
    const bad: any = await (await ethers.getContractFactory("RevertingFeeConfig")).deploy();
    await bad.waitForDeployment();
    const Impl = await ethers.getContractFactory("EncryptedAccount", { libraries: stack.libs });
    const impl: any = await Impl.deploy(await stack.entryPoint.getAddress(), await bad.getAddress());
    await impl.waitForDeployment();
    const factory: any = await (await ethers.getContractFactory("EncryptedAccountFactory")).deploy(await impl.getAddress());
    await factory.waitForDeployment();
    const s2 = { ...stack, factory, impl };
    const acct = await createAccount(s2 as any, owner, escape.address, guardian.address, { knownRecipients: [alice.address] });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("1") });
    const k = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01"), false);
    await finalizeEvaluation(acct, k);
    expect((await acct.getOp(k)).status).to.eq(Status.Executed);
    const p = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.2"), true);
    expect((await acct.getOp(p)).fee).to.eq(0n);
    await verify(acct, p);
    await (await acct.executeOp(p)).wait();
    expect((await acct.getOp(p)).status).to.eq(Status.Executed);
    await (await acct.connect(owner).startEscape()).wait();
    await time.increase(30 * DAY + 1);
    await (await acct.executeEscape([])).wait();
    expect(await ethers.provider.getBalance(await acct.getAddress())).to.eq(0n);
  });
});

describe("F0.16 — generic calls: the ETH fee, and no token route around the outflow path", function () {
  let stack: Stack;
  let owner: any, escape: any, guardian: any, alice: any, bob: any, stranger: any, recipient: any;
  let ERR: any;

  before(async () => {
    [owner, escape, guardian, alice, bob, stranger, , recipient] = await ethers.getSigners();
    stack = await deployStack([{ asset: ETH, bps: 10, minFee: E.parseEther("0.00001"), maxFee: E.parseEther("0.001") }], recipient.address);
    ERR = await errs();
  });

  async function fresh() {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address] });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("2") });
    return acct;
  }

  async function openCallOp(acct: any, target: string, value: bigint, data: string): Promise<bigint> {
    await (await acct.connect(owner).openCall(target, value, data)).wait();
    return await acct.opCount();
  }

  it("an ETH-carrying openCall pays the fee of an ETH transfer of its value; the target gets exactly the value", async () => {
    const acct = await fresh();
    const addr = await acct.getAddress();
    const value = E.parseEther("0.2");
    const fee = (value * 10n) / 10_000n;
    const opId = await openCallOp(acct, bob.address, value, "0x");
    const op = await acct.getOp(opId);
    expect(op.callFee).to.eq(fee);
    expect(op.fee).to.eq(0n);
    await guess(acct, owner, stack.chainId, opId, "482915");
    await finalizeGuess(acct, opId);
    await time.increase(48 * HOUR + 1); // generic-call delay
    const [b0, r0, a0] = await Promise.all([bob.address, recipient.address, addr].map((x) => ethers.provider.getBalance(x)));
    await expect(acct.connect(stranger).executeOp(opId)).to.emit(acct, "FeePaid").withArgs(opId, recipient.address, fee);
    expect((await ethers.provider.getBalance(bob.address)) - b0).to.eq(value);
    expect((await ethers.provider.getBalance(recipient.address)) - r0).to.eq(fee);
    expect(a0 - (await ethers.provider.getBalance(addr))).to.eq(value + fee);
  });

  it("a call without value pays nothing; the fee is bound at opening and part of the PIN challenge", async () => {
    const acct = await fresh();
    const noValue = await openCallOp(acct, bob.address, 0n, "0x");
    expect((await acct.getOp(noValue)).callFee).to.eq(0n);
    // the same call with value has another challenge: the fee is in the op's content hash
    const withValue = await openCallOp(acct, bob.address, E.parseEther("0.2"), "0x");
    expect(await acct.challengeOf(withValue)).to.not.eq(await acct.challengeOf(noValue));
    await (await stack.feeConfig.setFee(ETH, 5, E.parseEther("0.00001"), E.parseEther("0.001"))).wait(); // decrease: at once
    expect((await acct.getOp(withValue)).callFee).to.eq(E.parseEther("0.0002")); // unchanged
    await (await stack.feeConfig.setFee(ETH, 10, E.parseEther("0.00001"), E.parseEther("0.001"))).wait();
    await time.increase(7 * DAY + 1);
    await (await stack.feeConfig.applyFee(ETH)).wait();
  });

  it("value + fee not covered: the call reverts and stays delayed", async () => {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address] });
    const value = E.parseEther("0.2");
    await owner.sendTransaction({ to: await acct.getAddress(), value });
    const opId = await openCallOp(acct, bob.address, value, "0x");
    await guess(acct, owner, stack.chainId, opId, "482915");
    await finalizeGuess(acct, opId);
    await (await acct.connect(owner).claimRefund()).wait(); // exactly `value` left
    await time.increase(48 * HOUR + 1);
    const fee = (await acct.getOp(opId)).callFee;
    await expect(acct.executeOp.staticCall(opId)).to.be.revertedWithCustomError(ERR, "InsufficientBalance").withArgs(value + fee);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed);
  });

  it("token transfers and approvals cannot go through openCall (ERC-20, ERC-1363, ERC-777, DAI); pulls into the account can", async () => {
    const acct = await fresh();
    const addr = await acct.getAddress();
    const token = await stack.usdc.getAddress();
    const I = new E.Interface([
      "function transfer(address,uint256)",
      "function approve(address,uint256)",
      "function increaseAllowance(address,uint256)",
      "function transferFrom(address,address,uint256)",
      "function transferAndCall(address,uint256)",
      "function transferAndCall(address,uint256,bytes)",
      "function approveAndCall(address,uint256)",
      "function approveAndCall(address,uint256,bytes)",
      "function transferFromAndCall(address,address,uint256)",
      "function transferFromAndCall(address,address,uint256,bytes)",
      "function send(address,uint256,bytes)",
      "function operatorSend(address,address,uint256,bytes,bytes)",
      "function authorizeOperator(address)",
      "function push(address,uint256)",
      "function move(address,address,uint256)",
    ]);
    const blocked = [
      I.encodeFunctionData("transfer", [bob.address, 1]),
      I.encodeFunctionData("approve", [bob.address, 1]),
      I.encodeFunctionData("increaseAllowance", [bob.address, 1]),
      I.encodeFunctionData("transferFrom", [addr, bob.address, 1]),
      I.encodeFunctionData("transferAndCall(address,uint256)", [bob.address, 1]),
      I.encodeFunctionData("transferAndCall(address,uint256,bytes)", [bob.address, 1, "0x"]),
      I.encodeFunctionData("approveAndCall(address,uint256)", [bob.address, 1]),
      I.encodeFunctionData("approveAndCall(address,uint256,bytes)", [bob.address, 1, "0x"]),
      I.encodeFunctionData("transferFromAndCall(address,address,uint256)", [addr, bob.address, 1]),
      I.encodeFunctionData("transferFromAndCall(address,address,uint256,bytes)", [addr, bob.address, 1, "0x"]),
      I.encodeFunctionData("send", [bob.address, 1, "0x"]),
      I.encodeFunctionData("operatorSend", [addr, bob.address, 1, "0x", "0x"]),
      I.encodeFunctionData("authorizeOperator", [bob.address]),
      I.encodeFunctionData("push", [bob.address, 1]),
      I.encodeFunctionData("move", [addr, bob.address, 1]),
      I.getFunction("transferFrom")!.selector, // too short to read `from`: rejected
    ];
    for (const data of blocked) {
      await expect(acct.connect(owner).openCall.staticCall(token, 0, data), data.slice(0, 10)).to.be.revertedWithCustomError(ERR, "ForbiddenTarget");
    }
    // pulling into the account from someone who approved it is not an outflow
    expect(await acct.connect(owner).openCall.staticCall(token, 0, I.encodeFunctionData("transferFrom", [bob.address, addr, 1]))).to.be.gt(0n);
    expect(await acct.connect(owner).openCall.staticCall(token, 0, I.encodeFunctionData("move", [bob.address, addr, 1]))).to.be.gt(0n);
  });
});

describe("F0.16 — fee in variant B", function () {
  it("B: the synchronous K-only transfer is free; the PIN path charges the bound fee", async () => {
    const [owner, escape, guardian, alice, bob, , , recipient] = await ethers.getSigners();
    const stack = await deployStackB(
      [{ asset: ETH, bps: 10, minFee: E.parseEther("0.00001"), maxFee: E.parseEther("0.001") }],
      recipient.address,
    );
    const acct = await createAccountB(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address] });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("2") });
    const r0 = await ethers.provider.getBalance(recipient.address);
    await (await acct.connect(owner).requestTransfer(ETH, alice.address, E.parseEther("0.01"), false)).wait(); // open list, open limit
    expect(await ethers.provider.getBalance(recipient.address)).to.eq(r0);
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.2"), true);
    expect((await acct.getOp(opId)).fee).to.eq(E.parseEther("0.0002"));
    await guess(acct, owner, stack.chainId, opId, PIN);
    await finalizeGuess(acct, opId);
    await time.increase(HOUR + 1);
    await (await acct.executeOp(opId)).wait();
    expect((await ethers.provider.getBalance(recipient.address)) - r0).to.eq(E.parseEther("0.0002"));
    void hre;
  });
});
