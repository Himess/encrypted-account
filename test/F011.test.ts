import { expect } from "chai";
import { ethers as E } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { Alert, Watchtower } from "../sdk/src/watchtower";
import {
  A,
  DAY,
  DEFAULT_ETH_LIMITS,
  DEFAULT_USDC_LIMITS,
  DEFAULT_USDC_OPEN_LIMIT,
  ETH,
  ETH_UNIT,
  HOUR,
  N_RECIPIENTS,
  N_SPENDERS,
  SetupOptsB,
  StackB,
  Status,
  USDC_UNIT,
  coder,
  createAccount,
  createAccountB,
  defaultDelays,
  deployStackB,
  errs,
  escapeConsent,
  ethers,
  finalizeEvaluation,
  fingerprint,
  guessAndFinalize,
  opIdFromReceipt,
  time,
} from "./helpers";
import { randomUint64 } from "../sdk/src";

/**
 * F0.11 · B variant (work package §4 F0.11, §8.4): in open mode the known lists and the epoch limit are public; a K-only
 * outflow to a listed counterparty within the limit executes in one transaction without FHE and emits OpenOutflow;
 * everything else goes to the unchanged FHE PIN path. The A variant stays in place (same stack, separate implementation and factory).
 * Invariants under B semantics: I1, I2, I11, I12, I16, I17 (+ I18, I21 and the pulse).
 */
describe("F0.11 · B variant: open list, open limit, synchronous K-only", function () {
  this.timeout(900_000);
  const PIN = "482915";
  let stack: StackB;
  let usdc: string;
  let owner: any, escape: any, guardian: any, alice: any, bob: any, carol: any, dave: any, spender: any, other: any;

  before(async () => {
    [owner, escape, guardian, alice, bob, carol, dave, spender, other] = await ethers.getSigners();
    stack = await deployStackB();
    usdc = await stack.usdc.getAddress();
  });

  async function freshB(opts: SetupOptsB = {}): Promise<any> {
    const acct = await createAccountB(stack, owner, escape.address, guardian.address, {
      knownRecipients: [alice.address],
      knownSpenders: [spender.address],
      ...opts,
    });
    const addr = await acct.getAddress();
    await (await owner.sendTransaction({ to: addr, value: E.parseEther("5") })).wait();
    await (await stack.usdc.mint(addr, 20_000_000_000n)).wait(); // 20 000 USDC
    return acct;
  }

  /** opId of the PIN op, or 0n if the outflow ran in this transaction (B open path). */
  async function sent(rc: any, acct: any): Promise<bigint> {
    try {
      return await opIdFromReceipt(acct, rc);
    } catch {
      return 0n;
    }
  }

  function openOutflows(acct: any, rc: any) {
    return rc.logs
      .map((lg: any) => {
        try {
          return acct.interface.parseLog(lg);
        } catch {
          return null;
        }
      })
      .filter((ev: any) => ev?.name === "OpenOutflow");
  }

  /** Moves chain time just past the next epoch (UTC day) boundary, so a test's waits cannot roll the epoch. */
  async function alignEpoch(offsetS = 60) {
    const now = await time.latest();
    await time.increaseTo((Math.floor(now / DAY) + 1) * DAY + offsetS);
  }

  async function pinAndRun(acct: any, opId: bigint, wait: number) {
    await guessAndFinalize(acct, owner, stack.chainId, opId, PIN);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed);
    await time.increase(wait + 1);
    await (await acct.executeOp(opId)).wait();
    expect((await acct.getOp(opId)).status).to.eq(Status.Executed);
  }

  it("setup: A's encrypted list/limit entry points are closed; the open list and limit are visible on-chain (including entries added by hand and never used)", async () => {
    const acct = await freshB({ knownRecipients: [alice.address, carol.address, dave.address] }); // carol, dave: never used
    const e = await errs();
    const z = E.ZeroHash;
    await expect(acct.connect(owner).setupAsset(usdc, 1, z, z, z, "0x00")).to.be.revertedWithCustomError(e, "InvalidParams");
    await expect(acct.connect(owner).setupKnown(false, 0, [z], "0x00")).to.be.revertedWithCustomError(e, "InvalidParams");
    expect((await acct.status()).armed).to.eq(true);
    expect((await acct.assetState(usdc)).openLimit).to.eq(DEFAULT_USDC_OPEN_LIMIT);

    // Anyone reads the list from events: unused, hand-added addresses are visible too.
    const evs = await acct.queryFilter(acct.filters.OpenKnownChanged());
    const recipients = evs.filter((x: any) => !x.args.spenders).map((x: any) => x.args.who);
    const spenders = evs.filter((x: any) => x.args.spenders).map((x: any) => x.args.who);
    expect(recipients).to.have.members([alice.address, carol.address, dave.address]);
    expect(spenders).to.deep.eq([spender.address]);
    expect(await acct.openKnown(false, dave.address)).to.be.gt(0n);
    const limits = await acct.queryFilter(acct.filters.OpenLimitSet());
    expect(limits.map((x: any) => x.args.limit)).to.include(DEFAULT_USDC_OPEN_LIMIT);
  });

  it("I11/B: a K-only transfer to a listed recipient within the limit executes in one transaction (ERC-20, ETH); no op is opened, HCU 0, an event is emitted", async () => {
    const acct = await freshB();
    const n0 = await acct.opCount();
    const r0 = await stack.usdc.balanceOf(alice.address);
    expect(await acct.connect(owner).requestTransfer.staticCall(usdc, alice.address, 100_000_000n, false)).to.eq(0n);
    const rc = await (await acct.connect(owner).requestTransfer(usdc, alice.address, 100_000_000n, false)).wait();
    expect((await stack.usdc.balanceOf(alice.address)) - r0).to.eq(100_000_000n);
    expect(await acct.opCount()).to.eq(n0);
    const [ev] = openOutflows(acct, rc);
    expect(ev.args.sub).to.eq(1n);
    expect(ev.args.counterparty).to.eq(alice.address);
    expect(ev.args.amount).to.eq(100_000_000n);
    expect(ev.args.spent).to.eq(100_000_000n);
    expect(Number(hre.fhevm.computeTransactionHCU(rc).globalHCU)).to.eq(0);

    const b0 = await ethers.provider.getBalance(alice.address);
    await (await acct.connect(owner).requestTransfer(ETH, alice.address, E.parseEther("0.05"), false)).wait();
    expect((await ethers.provider.getBalance(alice.address)) - b0).to.eq(E.parseEther("0.05"));
    expect((await acct.assetState(ETH)).spent).to.eq(E.parseEther("0.05"));
    // nothing opens for a caller other than K
    // (the alpha plugin trips over its own internal validation on a reverting eth_sendTransaction, so the auth check uses eth_call)
    await expect(acct.connect(bob).requestTransfer.staticCall(usdc, alice.address, 1n, false)).to.be.revertedWithCustomError(await errs(), "NotAuthorized");
  });

  it("I1/B: a K-only transfer to an unlisted recipient does not execute; the unchanged PIN path opens and the first PIN-verified send adds the recipient to the list", async () => {
    const acct = await freshB();
    const b0 = await stack.usdc.balanceOf(bob.address);
    const opId = await sent(await (await acct.connect(owner).requestTransfer(usdc, bob.address, 50_000_000n, false)).wait(), acct);
    expect(opId).to.be.gt(0n);
    expect((await acct.getOp(opId)).status).to.eq(Status.NeedsPin);
    expect(await stack.usdc.balanceOf(bob.address)).to.eq(b0);
    expect(await acct.openKnown(false, bob.address)).to.eq(0n);

    const d = await defaultDelays(stack);
    await pinAndRun(acct, opId, Number(d.pinTransfer));
    expect((await stack.usdc.balanceOf(bob.address)) - b0).to.eq(50_000_000n);
    expect(await acct.openKnown(false, bob.address)).to.be.gt(0n); // autoKnown (on by default)
    expect((await acct.assetState(usdc)).spent).to.eq(0n); // the PIN path does not count toward the open limit
    expect(await acct.connect(owner).requestTransfer.staticCall(usdc, bob.address, 1_000_000n, false)).to.eq(0n);
  });

  it("I2/I12/B: K-only above the limit goes to the PIN path; epoch spending never exceeds the open limit; the counter resets when the epoch rolls over", async () => {
    const acct = await freshB();
    await alignEpoch(); // the 1 h PIN delay below must not cross midnight (that would roll the epoch and reset `spent`)
    const L = DEFAULT_USDC_OPEN_LIMIT;
    await (await acct.connect(owner).requestTransfer(usdc, alice.address, 300_000_000n, false)).wait();
    await (await acct.connect(owner).requestTransfer(usdc, alice.address, L - 300_000_000n, false)).wait(); // exactly the limit
    expect((await acct.assetState(usdc)).spent).to.eq(L);
    const over = await sent(await (await acct.connect(owner).requestTransfer(usdc, alice.address, 1n, false)).wait(), acct);
    expect((await acct.getOp(over)).status).to.eq(Status.NeedsPin);
    expect((await acct.assetState(usdc)).spent).to.eq(L);

    const d = await defaultDelays(stack);
    await pinAndRun(acct, over, Number(d.pinTransfer));
    const st = await acct.assetState(usdc);
    expect(st.spent).to.eq(L); // a PIN outflow neither raises nor lowers the counter
    expect(st.pinSpent).to.eq(1n);

    await time.increase(DAY);
    expect(await acct.connect(owner).requestTransfer.staticCall(usdc, alice.address, 100_000_000n, false)).to.eq(0n);
    const big = await sent(await (await acct.connect(owner).requestTransfer(usdc, alice.address, L + 1n, false)).wait(), acct);
    expect((await acct.getOp(big)).status).to.eq(Status.NeedsPin);
  });

  it("I2/B: a PIN outflow above L_big gets the long delay (PIN path unchanged)", async () => {
    const acct = await freshB();
    const amount = DEFAULT_USDC_LIMITS.big * USDC_UNIT + 1n; // 10 000 USDC + 1 base unit
    const opId = await sent(await (await acct.connect(owner).requestTransfer(usdc, alice.address, amount, false)).wait(), acct);
    await guessAndFinalize(acct, owner, stack.chainId, opId, PIN);
    const op = await acct.getOp(opId);
    const now = BigInt(await time.latest());
    const d = await defaultDelays(stack);
    expect(op.status).to.eq(Status.Delayed);
    expect(op.readyAt - now).to.eq(BigInt(d.bigTransfer));
  });

  it("I16/B: approvals and transfers count toward the same open limit; an unlimited approval and an unlisted spender need the PIN; approve(0) immediately", async () => {
    const acct = await freshB();
    const addr = await acct.getAddress();
    const L = DEFAULT_USDC_OPEN_LIMIT;
    expect(await sent(await (await acct.connect(owner).requestApprove(usdc, spender.address, 200_000_000n, false)).wait(), acct)).to.eq(0n);
    expect(await stack.usdc.allowance(addr, spender.address)).to.eq(200_000_000n);
    await (await acct.connect(owner).requestTransfer(usdc, alice.address, L - 200_000_000n, false)).wait();
    expect((await acct.assetState(usdc)).spent).to.eq(L);
    expect(await sent(await (await acct.connect(owner).requestTransfer(usdc, alice.address, 1n, false)).wait(), acct)).to.be.gt(0n);
    expect(await sent(await (await acct.connect(owner).requestApprove(usdc, spender.address, 1n, false)).wait(), acct)).to.be.gt(0n);

    await time.increase(DAY);
    expect(await sent(await (await acct.connect(owner).requestApprove(usdc, spender.address, E.MaxUint256, false)).wait(), acct)).to.be.gt(0n);
    expect(await sent(await (await acct.connect(owner).requestApprove(usdc, alice.address, 1n, false)).wait(), acct)).to.be.gt(0n); // recipient ≠ spender
    expect(await sent(await (await acct.connect(owner).requestTransfer(usdc, spender.address, 1n, false)).wait(), acct)).to.be.gt(0n); // spender ≠ recipient
    await (await acct.connect(owner).requestApprove(usdc, spender.address, 0n, false)).wait();
    expect(await stack.usdc.allowance(addr, spender.address)).to.eq(0n);
  });

  it("I17/B: adding to the list only with K+P (ADD_KNOWN op, knownAdd delay) or via a PIN-verified send; K can only remove", async () => {
    const acct = await freshB({ autoKnown: false });
    const e = await errs();
    const d = await defaultDelays(stack);

    const add = await opIdFromReceipt(acct, await (await acct.connect(owner).openAdmin(A.ADD_KNOWN_R, coder.encode(["address"], [bob.address]))).wait());
    expect((await acct.getOp(add)).status).to.eq(Status.NeedsPin);
    expect(await acct.openKnown(false, bob.address)).to.eq(0n);
    await guessAndFinalize(acct, owner, stack.chainId, add, PIN);
    await expect(acct.executeOp(add)).to.be.revertedWithCustomError(e, "NotReady");
    await time.increase(Number(d.knownAdd) + 1);
    await (await acct.executeOp(add)).wait();
    expect(await acct.openKnown(false, bob.address)).to.be.gt(0n);
    expect(await acct.connect(owner).requestTransfer.staticCall(usdc, bob.address, 1_000_000n, false)).to.eq(0n);

    await expect(acct.connect(bob).removeKnownOpen.staticCall(false, alice.address)).to.be.revertedWithCustomError(e, "NotAuthorized");
    await (await acct.connect(owner).removeKnownOpen(false, alice.address)).wait();
    expect(await acct.openKnown(false, alice.address)).to.eq(0n);
    const op = await sent(await (await acct.connect(owner).requestTransfer(usdc, alice.address, 1_000_000n, false)).wait(), acct);
    expect(op).to.be.gt(0n);
    await pinAndRun(acct, op, Number(d.pinTransfer));
    expect(await acct.openKnown(false, alice.address)).to.eq(0n); // autoKnown off: a PIN-verified send does not add

    await expect(acct.connect(owner).openAdmin(A.ADD_KNOWN_R, coder.encode(["address"], [E.ZeroAddress]))).to.be.revertedWithCustomError(e, "InvalidParams");
    await expect(acct.connect(owner).openAddKnown(false, 0, E.ZeroHash, "0x00")).to.be.revertedWithCustomError(e, "InvalidParams");
    await expect(acct.connect(owner).removeKnown(false, 0, E.ZeroHash, "0x00")).to.be.revertedWithCustomError(e, "InvalidParams");
    // A is unchanged: the open-list add path does not exist on an A account
    const a = await createAccount(stack, owner, escape.address, guardian.address, {});
    await expect(a.connect(owner).openAdmin(A.ADD_KNOWN_R, coder.encode(["address"], [bob.address]))).to.be.revertedWithCustomError(e, "InvalidParams");
    await expect(a.connect(owner).openAdmin(A.SET_OPEN_LIMIT, coder.encode(["address", "uint256"], [usdc, 1n]))).to.be.revertedWithCustomError(e, "InvalidParams");
  });

  it("I18/I21/B: the K-only path is closed in restricted mode, once the pulse lapses and during an escape; approve(0) stays available during an escape", async () => {
    const acct = await freshB({ pulse: 30 * DAY });
    const e = await errs();
    await (await acct.connect(owner).restrict()).wait();
    expect(await sent(await (await acct.connect(owner).requestTransfer(usdc, alice.address, 1_000_000n, false)).wait(), acct)).to.be.gt(0n);
    const un = await opIdFromReceipt(acct, await (await acct.connect(owner).openAdmin(A.UNRESTRICT, "0x")).wait());
    await guessAndFinalize(acct, owner, stack.chainId, un, PIN); // no delay, executes inside finalize
    expect((await acct.status()).restrictedReasons).to.eq(0n);
    expect(await acct.connect(owner).requestTransfer.staticCall(usdc, alice.address, 1_000_000n, false)).to.eq(0n);

    await time.increase(31 * DAY);
    expect(await sent(await (await acct.connect(owner).requestTransfer(usdc, alice.address, 1_000_000n, false)).wait(), acct)).to.be.gt(0n);

    await (await acct.connect(owner).requestApprove(usdc, spender.address, 5_000_000n, true)).wait(); // pending approval op (PIN path)
    await (await acct.connect(owner).startEscape()).wait();
    await expect(acct.connect(owner).requestTransfer(usdc, alice.address, 1_000_000n, false)).to.be.revertedWithCustomError(e, "EscapeActive");
    await expect(acct.connect(owner).requestApprove(usdc, spender.address, 1n, false)).to.be.revertedWithCustomError(e, "EscapeActive");
    await (await acct.connect(owner).requestApprove(usdc, spender.address, 0n, false)).wait();
  });

  it("B: K alone lowers the open limit immediately; raising it needs K+P (loosen delay)", async () => {
    const acct = await freshB();
    const e = await errs();
    const d = await defaultDelays(stack);
    await expect(acct.connect(owner).lowerOpenLimit(usdc, DEFAULT_USDC_OPEN_LIMIT)).to.be.revertedWithCustomError(e, "NotTighter");
    await expect(acct.connect(bob).lowerOpenLimit.staticCall(usdc, 1n)).to.be.revertedWithCustomError(e, "NotAuthorized");
    await (await acct.connect(owner).lowerOpenLimit(usdc, 100_000_000n)).wait();
    expect((await acct.assetState(usdc)).openLimit).to.eq(100_000_000n);
    expect(await sent(await (await acct.connect(owner).requestTransfer(usdc, alice.address, 150_000_000n, false)).wait(), acct)).to.be.gt(0n);

    const raise = await opIdFromReceipt(
      acct,
      await (await acct.connect(owner).openAdmin(A.SET_OPEN_LIMIT, coder.encode(["address", "uint256"], [usdc, 1_000_000_000n]))).wait(),
    );
    expect((await acct.assetState(usdc)).openLimit).to.eq(100_000_000n);
    await pinAndRun(acct, raise, Number(d.loosen));
    expect((await acct.assetState(usdc)).openLimit).to.eq(1_000_000_000n);
    await expect(
      acct.connect(owner).openAdmin(A.SET_OPEN_LIMIT, coder.encode(["address", "uint256"], [other.address, 1n])),
    ).to.be.revertedWithCustomError(e, "InvalidParams");
  });

  it("watchtower: reports every K-only outflow and open-list change; during an escape lists the open approval granted via the K-only path", async () => {
    const acct = await freshB();
    const alerts: Alert[] = [];
    const wt = new Watchtower({
      account: acct.connect(guardian) as any,
      publicDecrypt: (hs) => hre.fhevm.publicDecrypt(hs) as any,
      userDecryptBool: (h, c) => hre.fhevm.userDecryptEbool(h, c, guardian),
      notify: (a) => alerts.push(a),
      assets: [ETH, usdc],
    });
    await wt.tick();
    expect(alerts.filter((a) => a.kind === "known-changed" && a.added)).to.have.length(2); // the two setup entries
    alerts.length = 0;
    await (await acct.connect(owner).requestTransfer(usdc, alice.address, 10_000_000n, false)).wait();
    await (await acct.connect(owner).requestApprove(usdc, spender.address, 5_000_000n, false)).wait();
    await (await acct.connect(owner).removeKnownOpen(false, alice.address)).wait();
    await wt.tick();
    const outs = alerts.filter((a) => a.kind === "open-outflow") as any[];
    expect(outs.map((a) => [a.sub, a.to, a.amount])).to.deep.eq([
      [1, alice.address, 10_000_000n],
      [2, spender.address, 5_000_000n],
    ]);
    expect(alerts.some((a) => a.kind === "known-changed" && !a.added && a.who === alice.address)).to.eq(true);
    await (await acct.connect(owner).startEscape()).wait();
    await wt.tick();
    expect(alerts.some((a) => a.kind === "open-approval" && a.spender === spender.address && a.allowance === 5_000_000n)).to.eq(true);
    expect(alerts.filter((a) => a.kind === "error")).to.deep.eq([]);
  });

  it("cost [Mock]: B synchronous K-only vs the A hot path (request + finalize), setup difference → results/f011-mock.json", async () => {
    type Row = { flow: string; variant: "A" | "B"; gas: number; hcu: number; note?: string };
    const rows: Row[] = [];
    const rec = (variant: "A" | "B", flow: string, rc: any, note?: string) =>
      rows.push({ variant, flow, gas: Number(rc.gasUsed), hcu: Number(hre.fhevm.computeTransactionHCU(rc).globalHCU), note });
    const d = await defaultDelays(stack);

    // ── Setup: A (30 + 10 encrypted slots, hidden limit + τ) and B (open list, open limit, Enc(L_big))
    async function created(factory: any): Promise<{ addr: string; rc: any }> {
      const salt = E.id("cost-" + Math.random());
      const addr = await factory.predictAddress(owner.address, escape.address, guardian.address, d, salt);
      const sig = await escapeConsent(escape, stack.chainId, addr, 0);
      const rc = await (await factory.createAccountWithDelays(owner.address, escape.address, guardian.address, d, salt, sig)).wait();
      return { addr, rc };
    }
    async function pinSetup(acct: any, addr: string) {
      const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
      inp.add64(await fingerprint(PIN, stack.chainId, addr));
      inp.add64(randomUint64());
      inp.addBool(false);
      const enc = await inp.encrypt();
      return await (await acct.connect(owner).setupPin(enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait();
    }
    const nR = 3;
    const nS = 1;
    const listR = [alice.address, carol.address, dave.address].slice(0, nR);
    const listS = [spender.address].slice(0, nS);

    const ca = await created(stack.factory);
    const a: any = await ethers.getContractAt("EncryptedAccount", ca.addr);
    const setupA: Record<string, number> = { create: Number(ca.rc.gasUsed) };
    setupA.pin = Number((await pinSetup(a, ca.addr)).gasUsed);
    let assetsA = 0;
    for (const [asset, lim, unit] of [[ETH, DEFAULT_ETH_LIMITS, ETH_UNIT], [usdc, DEFAULT_USDC_LIMITS, USDC_UNIT]] as const) {
      const inp = hre.fhevm.createEncryptedInput(ca.addr, owner.address);
      inp.add64(lim.lmin);
      inp.add64(lim.lmax);
      inp.add64(lim.big);
      const enc = await inp.encrypt();
      assetsA += Number((await (await a.connect(owner).setupAsset(asset, unit, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait()).gasUsed);
    }
    setupA.assets = assetsA;
    let knownA = 0;
    for (const [spenders, entries, n] of [[false, listR, N_RECIPIENTS], [true, listS, N_SPENDERS]] as const) {
      const all = [...Array(n - entries.length).fill(E.ZeroAddress), ...entries];
      for (let start = 0; start < n; start += 12) {
        const inp = hre.fhevm.createEncryptedInput(ca.addr, owner.address);
        for (const x of all.slice(start, start + 12)) inp.addAddress(x);
        const enc = await inp.encrypt();
        knownA += Number((await (await a.connect(owner).setupKnown(spenders, start, enc.handles, enc.inputProof)).wait()).gasUsed);
      }
    }
    setupA.known = knownA;
    setupA.roles = Number((await (await a.connect(owner).setupRoles(E.ZeroAddress, E.ZeroAddress, 90 * DAY, true)).wait()).gasUsed);
    setupA.arm = Number((await (await a.connect(owner).arm()).wait()).gasUsed);

    const cb = await created(stack.factoryB);
    const b: any = await ethers.getContractAt("EncryptedAccountB", cb.addr);
    const setupB: Record<string, number> = { create: Number(cb.rc.gasUsed) };
    setupB.pin = Number((await pinSetup(b, cb.addr)).gasUsed);
    let assetsB = 0;
    for (const [asset, open, big, unit] of [[ETH, E.parseEther("0.2"), DEFAULT_ETH_LIMITS.big, ETH_UNIT], [usdc, DEFAULT_USDC_OPEN_LIMIT, DEFAULT_USDC_LIMITS.big, USDC_UNIT]] as const) {
      const inp = hre.fhevm.createEncryptedInput(cb.addr, owner.address);
      inp.add64(big);
      const enc = await inp.encrypt();
      assetsB += Number((await (await b.connect(owner).setupAssetOpen(asset, unit, open, enc.handles[0], enc.inputProof)).wait()).gasUsed);
    }
    setupB.assets = assetsB;
    const kR = await (await b.connect(owner).setupKnownOpen(false, listR)).wait();
    const kS = await (await b.connect(owner).setupKnownOpen(true, listS)).wait();
    setupB.known = Number(kR.gasUsed) + Number(kS.gasUsed);
    setupB.roles = Number((await (await b.connect(owner).setupRoles(E.ZeroAddress, E.ZeroAddress, 90 * DAY, true)).wait()).gasUsed);
    setupB.arm = Number((await (await b.connect(owner).arm()).wait()).gasUsed);
    // marginal cost of one extra list entry (new storage slot)
    const one: any = await ethers.getContractAt("EncryptedAccountB", (await created(stack.factoryB)).addr);
    const kOne = await (await one.connect(owner).setupKnownOpen(false, [alice.address])).wait();
    const kTwo = await (await one.connect(owner).setupKnownOpen(false, [carol.address, dave.address])).wait();
    const perEntryB = Number(kTwo.gasUsed) - Number(kOne.gasUsed);

    const sum = (o: Record<string, number>) => Object.values(o).reduce((x, y) => x + y, 0);

    // ── Hot path: same recipient, same amount
    for (const acct of [a, b]) {
      const addr = await acct.getAddress();
      await (await owner.sendTransaction({ to: addr, value: E.parseEther("2") })).wait();
      await (await stack.usdc.mint(addr, 5_000_000_000n)).wait();
    }
    const amt = 10_000_000n; // 10 USDC (below τ ≥ L_min = 300 USDC on A)
    // A: request (FHE evaluation) + finalize (KMS proof → transfer)
    for (let i = 0; i < 3; i++) {
      const rq = await (await a.connect(owner).requestTransfer(usdc, alice.address, amt, false)).wait();
      const opId = await opIdFromReceipt(a, rq);
      const fz = await finalizeEvaluation(a, opId);
      const note = i === 0 ? "first (cold)" : "warm";
      rec("A", `K-only ERC-20 request #${i + 1}`, rq, note);
      rec("A", `K-only ERC-20 finalize #${i + 1}`, fz, note);
      expect((await a.getOp(opId)).status).to.eq(Status.Executed);
    }
    // B: one transaction
    for (let i = 0; i < 3; i++) {
      rec("B", `K-only ERC-20 sync #${i + 1}`, await (await b.connect(owner).requestTransfer(usdc, alice.address, amt, false)).wait(), i === 0 ? "first (cold)" : "warm");
    }
    rec("B", "K-only ETH sync", await (await b.connect(owner).requestTransfer(ETH, alice.address, E.parseEther("0.01"), false)).wait());
    rec("B", "K-only approval sync", await (await b.connect(owner).requestApprove(usdc, spender.address, amt, false)).wait());
    rec("B", "above limit → PIN op opening", await (await b.connect(owner).requestTransfer(usdc, alice.address, DEFAULT_USDC_OPEN_LIMIT, false)).wait());
    rec("A", "PIN op opening (viaPin)", await (await a.connect(owner).requestTransfer(usdc, alice.address, DEFAULT_USDC_OPEN_LIMIT, true)).wait());
    // plain ERC-20 transfer (reference)
    rec("B", "reference: plain ERC-20 transfer (EOA)", await (await stack.usdc.connect(alice).transfer(carol.address, 1_000_000n)).wait());

    const aHot = rows.filter((r) => r.variant === "A" && /#3/.test(r.flow)).reduce((x, r) => x + r.gas, 0);
    const bHot = rows.find((r) => r.flow === "K-only ERC-20 sync #3")!.gas;
    const out = {
      evidence: "[Mock]",
      generatedAt: new Date().toISOString(),
      note: "hardhat (cancun gas schedule, new slot 20k); on Sepolia's newer schedule a new slot ≈ 111k (F0.10 live lesson)",
      setup: { A: { ...setupA, total: sum(setupA) }, B: { ...setupB, total: sum(setupB) }, listR: nR, listS: nS, perEntryB },
      hotPath: { A_requestPlusFinalize_warm: aHot, B_sync_warm: bHot, ratio: Number((aHot / bHot).toFixed(1)) },
      rows,
    };
    const dir = path.join(__dirname, "..", "results");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "f011-mock.json"), JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ setup: out.setup, hotPath: out.hotPath }, null, 2));

    expect(rows.filter((r) => r.variant === "B" && /sync/.test(r.flow)).every((r) => r.hcu === 0)).to.eq(true);
    expect(bHot).to.be.lessThan(120_000);
    expect(sum(setupB)).to.be.lessThan(sum(setupA));
  });
});
