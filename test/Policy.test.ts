import { expect } from "chai";
import { ethers as E } from "ethers";
import * as hre from "hardhat";
import {
  A,
  DAY,
  ETH,
  ETH_UNIT,
  HOUR,
  N_RECIPIENTS,
  R,
  Stack,
  Status,
  coder,
  createAccount,
  debugAddr,
  debugBool,
  debugU64,
  deployStack,
  errs,
  ethers,
  finalizeEvaluation,
  guessAndFinalize,
  okBitOf,
  opIdFromReceipt,
  requestTransfer,
  time,
  userDecryptBool,
} from "./helpers";

// Default ETH limits (scaled, 1 unit = 1e12 wei): L_min = 0.1 ETH, L = 0.3 ETH, L_big = 3 ETH.
const PIN = "482915";

describe("F0.4 — Anomaly policy: hidden limit, random tripwire, encrypted known lists", function () {
  let stack: Stack;
  let owner: any, escape: any, guardian: any, alice: any, bob: any, carol: any, dex: any, stranger: any;
  let ERR: any;

  before(async () => {
    [owner, escape, guardian, alice, bob, carol, dex, stranger] = await ethers.getSigners();
    stack = await deployStack();
    ERR = await errs();
  });

  async function fresh(opts: any = {}) {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, {
      knownRecipients: [alice.address, carol.address],
      knownSpenders: [dex.address],
      ...opts,
    });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("20") });
    await stack.usdc.mint(await acct.getAddress(), 100_000n * 10n ** 6n);
    return acct;
  }

  it("A2: K-only to a known recipient below L_min → ok=1 → executes (two-phase)", async () => {
    const acct = await fresh();
    const opId = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.05"));
    expect((await acct.getOp(opId)).status).to.eq(Status.Evaluating);
    expect(await okBitOf(acct, opId)).to.eq(true);
    const before = await ethers.provider.getBalance(alice.address);
    await finalizeEvaluation(acct, opId, stranger);
    expect((await ethers.provider.getBalance(alice.address)) - before).to.eq(E.parseEther("0.05"));
    expect((await acct.getOp(opId)).status).to.eq(Status.Executed);
    expect((await acct.assetState(ETH)).spent).to.eq(E.parseEther("0.05"));
  });

  it("unknown recipient (below the limit) → ok=0 → 'PIN required'; the tripwire does NOT fire (14.1)", async () => {
    const acct = await fresh();
    const opId = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.05"));
    expect(await okBitOf(acct, opId)).to.eq(false);
    await finalizeEvaluation(acct, opId);
    expect((await acct.getOp(opId)).status).to.eq(Status.NeedsPin);
    const h = await acct.encryptedHandles(ETH);
    expect(await debugBool(h.tripped)).to.eq(false);
    // the watchtower can privately decrypt the flag with its own key (silent alarm channel)
    expect(await userDecryptBool(h.tripped, await acct.getAddress(), guardian)).to.eq(false);
    // the owner can continue via the PIN path
    await guessAndFinalize(acct, owner, stack.chainId, opId, PIN);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed);
  });

  it("a K-only attempt above τ → tripwire (sticky); later small ops fail too; only K+P clears it (I2, I12)", async () => {
    const acct = await fresh();
    const h0 = await acct.encryptedHandles(ETH);
    const tau = await debugU64(h0.tau); // visible only on the mock; nobody knows it on-chain
    const over = (tau + 1n) * ETH_UNIT; // just above τ
    const op1 = await requestTransfer(acct, owner, ETH, alice.address, over);
    expect(await okBitOf(acct, op1)).to.eq(false);
    await finalizeEvaluation(acct, op1);
    const h1 = await acct.encryptedHandles(ETH);
    expect(await debugBool(h1.tripped)).to.eq(true);
    expect(await userDecryptBool(h1.tripped, await acct.getAddress(), guardian)).to.eq(true);

    // sticky: even a tiny amount to a known recipient fails
    const op2 = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.001"));
    expect(await okBitOf(acct, op2)).to.eq(false);
    await finalizeEvaluation(acct, op2);
    // still sticky after an epoch change
    await time.increase(2 * DAY);
    const op3 = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.001"));
    expect(await okBitOf(acct, op3)).to.eq(false);

    // the watchtower puts the account in restricted mode (G's restrictive power)
    await (await acct.connect(guardian).guardianRestrict()).wait();
    expect((await acct.status()).restrictedReasons & BigInt(R.GUARDIAN)).to.eq(BigInt(R.GUARDIAN));

    // K+P: reset the tripwire (τ is redrawn) and lift the restriction
    const rt = await opIdFromReceipt(acct, await (await acct.connect(owner).openAdmin(A.RESET_TRIP, coder.encode(["address"], [ETH]))).wait());
    await guessAndFinalize(acct, owner, stack.chainId, rt, PIN); // delay 0 → executes inside finalize
    expect((await acct.getOp(rt)).status).to.eq(Status.Executed);
    const un = await opIdFromReceipt(acct, await (await acct.connect(owner).openAdmin(A.UNRESTRICT, "0x")).wait());
    await guessAndFinalize(acct, owner, stack.chainId, un, PIN);
    expect((await acct.status()).restrictedReasons).to.eq(0n);
    const h2 = await acct.encryptedHandles(ETH);
    expect(await debugBool(h2.tripped)).to.eq(false);
    const op4 = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.001"));
    expect(await okBitOf(acct, op4)).to.eq(true);
  });

  it("E7: τ is within [L_min, L] on every draw (5 draws from inside the account)", async () => {
    const acct = await fresh();
    const lo = 100_000n;
    const hi = 300_000n;
    const seen: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      const h = await acct.encryptedHandles(ETH);
      const tau = await debugU64(h.tau);
      expect(tau >= lo && tau <= hi, `tau=${tau}`).to.eq(true);
      seen.push(tau);
      const rt = await opIdFromReceipt(acct, await (await acct.connect(owner).openAdmin(A.RESET_TRIP, coder.encode(["address"], [ETH]))).wait());
      await guessAndFinalize(acct, owner, stack.chainId, rt, PIN);
    }
    expect(new Set(seen.map(String)).size).to.be.greaterThan(1);
  });

  it("reserve (S20, E15): concurrent K-only ops cannot use the threshold twice", async () => {
    const acct = await fresh();
    const h = await acct.encryptedHandles(ETH);
    const tau = await debugU64(h.tau);
    const part = (tau * ETH_UNIT * 6n) / 10n; // each is 60% of τ
    const op1 = await requestTransfer(acct, owner, ETH, alice.address, part);
    const op2 = await requestTransfer(acct, owner, ETH, carol.address, part); // at the same time, without waiting for finalize
    expect((await acct.assetState(ETH)).reserved).to.eq(part * 2n);
    expect(await okBitOf(acct, op1)).to.eq(true);
    expect(await okBitOf(acct, op2)).to.eq(false); // 0 + reserve(0.6τ) + 0.6τ > τ → fails and trips the tripwire
    await finalizeEvaluation(acct, op1);
    await finalizeEvaluation(acct, op2);
    const st = await acct.assetState(ETH);
    expect(st.reserved).to.eq(0n);
    expect(st.spent).to.eq(part);
    expect(BigInt(Math.ceil(Number(st.spent / ETH_UNIT)))).to.be.lte(tau); // I12: spent ≤ τ
    expect(await debugBool((await acct.encryptedHandles(ETH)).tripped)).to.eq(true);
  });

  it("64-bit limit: if the scaled total exceeds 2^64 there is no evaluation → straight to the PIN path", async () => {
    const acct = await fresh();
    const usdc = await stack.usdc.getAddress(); // unit 1 → 2^64 base units ≈ 1.8e13 USDC
    const huge = (1n << 64n) + 5n;
    await stack.usdc.mint(await acct.getAddress(), huge);
    const rc = await (await acct.connect(owner).requestTransfer(usdc, alice.address, huge, false)).wait();
    const opId = await opIdFromReceipt(acct, rc);
    expect((await acct.getOp(opId)).status).to.eq(Status.NeedsPin);
    expect((await acct.getOp(opId)).h0).to.eq(E.ZeroHash);
  });

  it("approvals (14.7, I16, E21): a bounded approval to a known spender is K-only and counts as spending; unlimited/unknown → PIN; approve(0) immediately", async () => {
    const acct = await fresh();
    const usdc = await stack.usdc.getAddress();
    const addr = await acct.getAddress();
    // known spender, 200 USDC (< L_min 300)
    let rc = await (await acct.connect(owner).requestApprove(usdc, dex.address, 200n * 10n ** 6n, false)).wait();
    let opId = await opIdFromReceipt(acct, rc);
    expect(await okBitOf(acct, opId)).to.eq(true);
    await finalizeEvaluation(acct, opId);
    expect(await stack.usdc.allowance(addr, dex.address)).to.eq(200n * 10n ** 6n);
    expect((await acct.assetState(usdc)).spent).to.eq(200n * 10n ** 6n); // the approval counted as spending

    // unlimited approval → always PIN
    rc = await (await acct.connect(owner).requestApprove(usdc, dex.address, E.MaxUint256, false)).wait();
    opId = await opIdFromReceipt(acct, rc);
    expect((await acct.getOp(opId)).status).to.eq(Status.NeedsPin);
    // unknown spender (on the recipient list, but not a spender) → ok=0
    rc = await (await acct.connect(owner).requestApprove(usdc, alice.address, 10n * 10n ** 6n, false)).wait();
    opId = await opIdFromReceipt(acct, rc);
    expect(await okBitOf(acct, opId)).to.eq(false);
    // approve(0): restrictive → K-only, immediate
    await (await acct.connect(owner).requestApprove(usdc, dex.address, 0n, false)).wait();
    expect(await stack.usdc.allowance(addr, dex.address)).to.eq(0n);
  });

  it("default deny (11.5, I11): token transfer/approve selectors and the FHE infrastructure are forbidden in a generic call; a generic call takes K+P + a delay", async () => {
    const acct = await fresh();
    const usdc = await stack.usdc.getAddress();
    const xfer = stack.usdc.interface.encodeFunctionData("transfer", [bob.address, 1n]);
    await expect(acct.connect(owner).openCall(usdc, 0, xfer)).to.be.revertedWithCustomError(ERR, "ForbiddenTarget");
    await expect(acct.connect(owner).openCall(await acct.aclAddress(), 0, "0x12345678")).to.be.revertedWithCustomError(ERR, "ForbiddenTarget");
    await expect(acct.connect(owner).openCall(await acct.getAddress(), 0, "0x")).to.be.revertedWithCustomError(ERR, "ForbiddenTarget");

    const target: any = await (await ethers.getContractFactory("CallTarget")).deploy();
    const data = target.interface.encodeFunctionData("setValue", [42n]);
    const opId = await opIdFromReceipt(acct, await (await acct.connect(owner).openCall(await target.getAddress(), 0, data)).wait());
    expect((await acct.getOp(opId)).status).to.eq(Status.NeedsPin);
    await guessAndFinalize(acct, owner, stack.chainId, opId, PIN);
    const op = await acct.getOp(opId);
    expect(op.readyAt - BigInt(await time.latest())).to.be.within(BigInt(48 * HOUR) - 3n, BigInt(48 * HOUR)); // genericCall
    await time.increase(48 * HOUR);
    await (await acct.executeOp(opId)).wait();
    expect(await target.value()).to.eq(42n);
    expect(await target.lastCaller()).to.eq(await acct.getAddress());
    // ERC-1271: no signature is valid with K alone
    expect(await acct.isValidSignature(E.id("permit"), "0x")).to.eq("0xffffffff");
  });

  it("delay class (big): above L_big the PIN path gets the long delay; splitting into parts does not dodge it (pinSpent+committed)", async () => {
    const acct = await fresh();
    // L_big = 3 ETH. 2 ETH → short; then another 2 ETH → total 4 > 3 → long
    const op1 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("2"), true);
    await guessAndFinalize(acct, owner, stack.chainId, op1, PIN);
    const r1 = (await acct.getOp(op1)).readyAt - BigInt(await time.latest());
    expect(r1).to.be.lte(BigInt(HOUR));
    const op2 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("2"), true);
    await guessAndFinalize(acct, owner, stack.chainId, op2, PIN);
    const r2 = (await acct.getOp(op2)).readyAt - BigInt(await time.latest());
    expect(r2).to.be.within(BigInt(48 * HOUR) - 3n, BigInt(48 * HOUR));
    // on a wrong PIN the big bit is masked: nothing leaks about L_big
    const op3 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("9"), true);
    const { guess } = await import("./helpers");
    await guess(acct, owner, stack.chainId, op3, "000999");
    const g = await acct.getGuess(op3);
    expect(await hre.fhevm.publicDecryptEbool(g.okH)).to.eq(false);
    expect(await hre.fhevm.publicDecryptEbool(g.bigH)).to.eq(false); // 9 ETH > 3 ETH but masked
  });

  it("removal from the known list is K-only and only 'zero or unchanged' (I17); K alone cannot add", async () => {
    const acct = await fresh();
    const addr = await acct.getAddress();
    // layout: zeros first, real entries last → alice = slot N-2
    const SLOT = N_RECIPIENTS - 2;
    let inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.addBool(false);
    let enc = await inp.encrypt();
    await (await acct.connect(owner).removeKnown(false, SLOT, enc.handles[0], enc.inputProof)).wait();
    expect((await debugAddr((await acct.knownSlot(false, SLOT)).handle)).toLowerCase()).to.eq(alice.address.toLowerCase());
    // doRemove=true → zero address
    inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.addBool(true);
    enc = await inp.encrypt();
    await (await acct.connect(owner).removeKnown(false, SLOT, enc.handles[0], enc.inputProof)).wait();
    expect(await debugAddr((await acct.knownSlot(false, SLOT)).handle)).to.eq(E.ZeroAddress);
    const opId = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01"));
    expect(await okBitOf(acct, opId)).to.eq(false);
    // Adding needs K+P: openAddKnown → does not execute without the PIN
    inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.addAddress(bob.address);
    enc = await inp.encrypt();
    const add = await opIdFromReceipt(acct, await (await acct.connect(owner).openAddKnown(false, 5, enc.handles[0], enc.inputProof)).wait());
    await expect(acct.executeOp(add)).to.be.revertedWithCustomError(ERR, "BadStatus");
    await guessAndFinalize(acct, owner, stack.chainId, add, PIN);
    await time.increase(DAY); // knownAdd delay
    await (await acct.executeOp(add)).wait();
    const op2 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.01"));
    expect(await okBitOf(acct, op2)).to.eq(true);
  });

  it("automatic 'becoming known' (14.6): after the first PIN-verified send the recipient is known; no duplicate if already known", async () => {
    const acct = await fresh();
    const op1 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.02"), true);
    await guessAndFinalize(acct, owner, stack.chainId, op1, PIN);
    await time.increase(HOUR);
    await (await acct.executeOp(op1)).wait();
    const op2 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.02"));
    expect(await okBitOf(acct, op2)).to.eq(true);
    await finalizeEvaluation(acct, op2);

    // alice is already known: a PIN-verified send does not change the LRU slot's value
    const lruBefore: string[] = [];
    for (let i = 0; i < N_RECIPIENTS; i++) lruBefore.push((await debugAddr((await acct.knownSlot(false, i)).handle)).toLowerCase());
    const op3 = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("1"), true);
    await guessAndFinalize(acct, owner, stack.chainId, op3, PIN);
    await time.increase(HOUR);
    await (await acct.executeOp(op3)).wait();
    const after: string[] = [];
    for (let i = 0; i < N_RECIPIENTS; i++) after.push((await debugAddr((await acct.knownSlot(false, i)).handle)).toLowerCase());
    expect(after.filter((a) => a === alice.address.toLowerCase()).length).to.eq(1);
    expect(after.sort()).to.deep.eq(lruBefore.sort());
  });

  it("tightening is K-only and immediate (encrypted min); loosening takes K+P + a long delay", async () => {
    const acct = await fresh();
    const addr = await acct.getAddress();
    const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.add64(20_000n); // 0.02 ETH cap
    inp.add64(1_000_000n);
    const enc = await inp.encrypt();
    await (await acct.connect(owner).tightenLimits(ETH, enc.handles[0], enc.handles[1], enc.inputProof)).wait();
    const h = await acct.encryptedHandles(ETH);
    expect(await debugU64(h.tau)).to.be.lte(20_000n);
    expect(await debugU64(h.lmax)).to.eq(20_000n);
    const opId = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.05"));
    expect(await okBitOf(acct, opId)).to.eq(false); // now above the threshold

    // loosening: openSetLimits → K+P + loosen (72 h)
    const inp2 = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp2.add64(500_000n);
    inp2.add64(900_000n);
    inp2.add64(5_000_000n);
    const e2 = await inp2.encrypt();
    const sl = await opIdFromReceipt(
      acct,
      await (await acct.connect(owner).openSetLimits(ETH, ETH_UNIT, e2.handles[0], e2.handles[1], e2.handles[2], e2.inputProof)).wait(),
    );
    await guessAndFinalize(acct, owner, stack.chainId, sl, PIN);
    expect((await acct.getOp(sl)).readyAt - BigInt(await time.latest())).to.be.within(BigInt(72 * HOUR) - 3n, BigInt(72 * HOUR));
    await time.increase(72 * HOUR);
    await (await acct.executeOp(sl)).wait();
    const t = await debugU64((await acct.encryptedHandles(ETH)).tau);
    expect(t >= 500_000n && t <= 900_000n).to.eq(true);
  });

  it("PIN pulse (K26): with no PIN entry for 90 days K-only spending stops; one PIN entry reopens it", async () => {
    const acct = await fresh();
    await time.increase(91 * DAY);
    const opId = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01"));
    expect((await acct.getOp(opId)).status).to.eq(Status.NeedsPin);
    await guessAndFinalize(acct, owner, stack.chainId, opId, PIN);
    const op2 = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01"));
    expect((await acct.getOp(op2)).status).to.eq(Status.Evaluating);
  });

  it("if restricted mode kicks in afterwards: even with ok=1 the K-only op does not execute → falls back to the PIN path (13.10)", async () => {
    const acct = await fresh();
    const opId = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01"));
    await (await acct.connect(owner).restrict()).wait(); // or the watchtower
    expect(await okBitOf(acct, opId)).to.eq(true);
    await finalizeEvaluation(acct, opId);
    expect((await acct.getOp(opId)).status).to.eq(Status.NeedsPin);
  });

  it("instant bucket (optional, public): off by default; enabled with K+P; stops in restricted mode", async () => {
    const acct = await fresh();
    await expect(acct.connect(owner).instantTransfer(ETH, bob.address, 1n)).to.be.revertedWithCustomError(ERR, "InvalidParams");
    const op = await opIdFromReceipt(
      acct,
      await (await acct.connect(owner).openAdmin(A.SET_INSTANT, coder.encode(["address", "uint256"], [ETH, E.parseEther("0.01")]))).wait(),
    );
    await guessAndFinalize(acct, owner, stack.chainId, op, PIN);
    await time.increase(72 * HOUR);
    await (await acct.executeOp(op)).wait();
    const before = await ethers.provider.getBalance(bob.address);
    await (await acct.connect(owner).instantTransfer(ETH, bob.address, E.parseEther("0.006"))).wait();
    expect((await ethers.provider.getBalance(bob.address)) - before).to.eq(E.parseEther("0.006"));
    await expect(acct.connect(owner).instantTransfer(ETH, bob.address, E.parseEther("0.006"))).to.be.revertedWithCustomError(
      ERR,
      "InvalidParams",
    );
    await (await acct.connect(owner).restrict()).wait();
    // (staticCall: alpha plugin 0.13.0-1 crashes on reverts it cannot decode through the clone proxy)
    await expect(acct.connect(owner).instantTransfer.staticCall(ETH, bob.address, 1n)).to.be.revertedWithCustomError(ERR, "NotAuthorized");
  });

  it("unauthorized parties: a stranger and the watchtower cannot move funds / open ops (I9)", async () => {
    const acct = await fresh();
    // staticCall: see note above (plugin error-decoding bug); semantics are identical for pure auth checks
    await expect(acct.connect(stranger).requestTransfer.staticCall(ETH, stranger.address, 1n, false)).to.be.revertedWithCustomError(ERR, "NotAuthorized");
    await expect(acct.connect(guardian).requestTransfer.staticCall(ETH, guardian.address, 1n, false)).to.be.revertedWithCustomError(ERR, "NotAuthorized");
    await expect(acct.connect(guardian).openCall.staticCall(guardian.address, 1n, "0x")).to.be.revertedWithCustomError(ERR, "NotAuthorized");
    await expect(acct.connect(guardian).restrict.staticCall()).to.be.revertedWithCustomError(ERR, "NotAuthorized");
    await expect(acct.connect(stranger).guardianRestrict.staticCall()).to.be.revertedWithCustomError(ERR, "NotAuthorized");
    await expect(acct.connect(stranger).autoKnownHook.staticCall(false, stranger.address)).to.be.revertedWithCustomError(ERR, "NotAuthorized");
  });
});
