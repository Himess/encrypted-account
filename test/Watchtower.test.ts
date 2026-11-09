import { expect } from "chai";
import { ethers as E } from "ethers";
import * as hre from "hardhat";
import { Alert, Watchtower } from "../sdk/src/watchtower";
import { ETH, ETH_UNIT, R, Stack, Status, createAccount, debugU64, deployStack, encGuess, ethers, requestTransfer, time } from "./helpers";

describe("F1.3 — Watchtower v0: auto-finalize, notifications, silent alarm on a tripwire → restricted mode", function () {
  let stack: Stack;
  let owner: any, escape: any, guardian: any, alice: any, bob: any;

  before(async () => {
    [owner, escape, guardian, alice, bob] = await ethers.getSigners();
    stack = await deployStack();
  });

  it("the user clicks once; the watchtower finalizes, reports the wrong PIN and the tripwire, and restricts the account", async () => {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address] });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("5") });
    const alerts: Alert[] = [];
    const wt = new Watchtower({
      account: acct.connect(guardian) as any,
      publicDecrypt: (hs) => hre.fhevm.publicDecrypt(hs) as any,
      userDecryptBool: (h, c) => hre.fhevm.userDecryptEbool(h, c, guardian),
      notify: (a) => alerts.push(a),
      assets: [ETH],
    });
    await wt.tick(); // consume the setup events

    // 1) K-only to a known recipient → the watchtower finalizes → the funds move
    const before = await ethers.provider.getBalance(alice.address);
    const op1 = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01"));
    await wt.tick();
    expect((await acct.getOp(op1)).status).to.eq(Status.Executed);
    expect((await ethers.provider.getBalance(alice.address)) - before).to.eq(E.parseEther("0.01"));

    // 2) wrong PIN → the watchtower finalizes and reports it
    const op2 = await requestTransfer(acct, owner, ETH, bob.address, E.parseEther("0.5"), true);
    const enc = await encGuess(acct, owner.address, stack.chainId, op2, "111999");
    await (await acct.connect(owner).submitGuess(op2, enc.c, enc.handles[0], enc.inputProof)).wait();
    await wt.tick();
    expect(alerts.some((a) => a.kind === "wrong-pin" && a.opId === op2)).to.eq(true);

    // 3) K-only attempt above τ → ok=0 alert + tripwire (silent alarm) → the watchtower puts the account in restricted mode
    const tau = await debugU64((await acct.encryptedHandles(ETH)).tau);
    await requestTransfer(acct, owner, ETH, alice.address, (tau + 1n) * ETH_UNIT);
    await wt.tick();
    expect(alerts.some((a) => a.kind === "policy-said-no")).to.eq(true);
    expect(alerts.some((a) => a.kind === "tripwire")).to.eq(true);
    expect((await acct.status()).restrictedReasons & BigInt(R.GUARDIAN)).to.eq(BigInt(R.GUARDIAN));
    await wt.tick();
    expect(alerts.some((a) => a.kind === "restriction")).to.eq(true);
    expect(alerts.filter((a) => a.kind === "error")).to.deep.eq([]);
  });

  it("F0.10: alerts when an escape starts, does not try to finalize a cancelled evaluation; reminds once when E_addr has gone unverified for over 90 days (K55)", async () => {
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address] });
    await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("1") });
    const alerts: Alert[] = [];
    const wt = new Watchtower({
      account: acct.connect(guardian) as any,
      publicDecrypt: (hs) => hre.fhevm.publicDecrypt(hs) as any,
      userDecryptBool: (h, c) => hre.fhevm.userDecryptEbool(h, c, guardian),
      notify: (a) => alerts.push(a),
      assets: [ETH],
    });
    await wt.tick();
    const op = await requestTransfer(acct, owner, ETH, alice.address, E.parseEther("0.01")); // Evaluating
    await (await acct.connect(owner).startEscape()).wait(); // cancelled before the watchtower sees it
    await wt.tick();
    expect((await acct.getOp(op)).status).to.eq(Status.Cancelled);
    expect(alerts.some((a) => a.kind === "escape-started" && a.to === escape.address)).to.eq(true);
    expect(alerts.filter((a) => a.kind === "error")).to.deep.eq([]);
    expect(alerts.some((a) => a.kind === "escape-unverified")).to.eq(false);
    await time.increase(91 * 24 * 3600);
    await (await owner.sendTransaction({ to: owner.address, value: 0n })).wait(); // new block
    await wt.tick();
    await wt.tick();
    expect(alerts.filter((a) => a.kind === "escape-unverified").length).to.eq(1);
  });

  it("F0.10 addendum (§8.3): when an escape starts, reports open ERC-20 approvals and suggests approve(0); approve(0) still works during an escape", async () => {
    const [, , , , , dex] = await ethers.getSigners();
    const acct = await createAccount(stack, owner, escape.address, guardian.address, { knownRecipients: [alice.address], knownSpenders: [dex.address] });
    const addr = await acct.getAddress();
    const usdc = await stack.usdc.getAddress();
    await stack.usdc.mint(addr, 1_000n * 10n ** 6n);
    const alerts: Alert[] = [];
    const wt = new Watchtower({
      account: acct.connect(guardian) as any,
      publicDecrypt: (hs) => hre.fhevm.publicDecrypt(hs) as any,
      userDecryptBool: (h, c) => hre.fhevm.userDecryptEbool(h, c, guardian),
      notify: (a) => alerts.push(a),
      assets: [ETH, usdc],
    });
    await wt.tick();
    await (await acct.connect(owner).requestApprove(usdc, dex.address, 200n * 10n ** 6n, false)).wait(); // known spender, below the limit
    await wt.tick(); // the watchtower finalizes the evaluation → the approval executes
    expect(await stack.usdc.allowance(addr, dex.address)).to.eq(200n * 10n ** 6n);
    await (await acct.connect(owner).startEscape()).wait();
    await wt.tick();
    const open = alerts.filter((a) => a.kind === "open-approval") as any[];
    expect(open.length).to.eq(1);
    expect(open[0].token).to.eq(usdc);
    expect(open[0].spender).to.eq(dex.address);
    expect(open[0].allowance).to.eq(200n * 10n ** 6n);
    await (await acct.connect(owner).requestApprove(usdc, dex.address, 0n, false)).wait(); // restrictive: allowed during an escape
    expect(await stack.usdc.allowance(addr, dex.address)).to.eq(0n);
    expect(alerts.filter((a) => a.kind === "error")).to.deep.eq([]);
  });
});
