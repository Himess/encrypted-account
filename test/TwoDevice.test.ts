/**
 * Two-device PIN flow (stage 4): the key K on one device, the PIN on another (a phone registered as the second device D).
 * The phone builds the encrypted guess for K's address, signs (opId, guess) with D, and hands an approval code to the
 * computer, which submits it with K (submitGuessWithCosign). Plus the optional two-device setting (lane only for big
 * transfers, calls and loosening) and no lock-out when the phone is lost.
 */
import { expect } from "chai";
import { ethers as E } from "ethers";
import * as hre from "hardhat";
import { decodeApproval, encodeApproval, laneMessage, opContentHash, challengeOf } from "../sdk/src/lane";
import { guessValue } from "../sdk/src";
import { A, DAY, ETH, Stack, Status, alignDecay, coder, createAccount, deployStack, errs, ethers, finalizeGuess, fingerprint, guess, laneGuess, opIdFromReceipt, time } from "./helpers";

const PIN = "482915";
const LANE_ONLY = 27;

describe("Two-device PIN flow: K on the computer, the PIN on the phone", function () {
  let s: Stack;
  let owner: any, escape: any, guardian: any, alice: any, bob: any;
  let ERR: any;
  let phone: E.HDNodeWallet;

  before(async () => {
    [owner, escape, guardian, alice, bob] = await ethers.getSigners();
    s = await deployStack();
    ERR = await errs();
    phone = E.Wallet.createRandom(); // the phone's device key: it never signs a transaction
  });

  const fresh = async (opts: any = {}) => {
    const acct = (await createAccount(s, owner, escape.address, guardian.address, { knownRecipients: [alice.address], device: phone.address, ...opts })).connect(owner);
    await (await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("5") })).wait();
    return acct;
  };

  /** What the phone does: read the op, recompute its challenge, Argon2id + Enc((h + c) mod 2^64) for K's address, sign. */
  async function phoneApproves(acct: any, opId: bigint, pin: string): Promise<string> {
    const addr = await acct.getAddress();
    const op = await acct.getOp(opId);
    const c = challengeOf(s.chainId, addr, opId, opContentHash(opId, op));
    expect(c).to.eq(BigInt(await acct.challengeOf(opId))); // the phone does not take c from the computer
    const kAddr = (await acct.roles())[0];
    const inp = hre.fhevm.createEncryptedInput(addr, kAddr); // bound to K's address, made without K
    inp.add64(guessValue(await fingerprint(pin, s.chainId, addr), c));
    const enc = await inp.encrypt();
    const handle = E.hexlify(enc.handles[0]);
    const cosig = await phone.signMessage(E.getBytes(laneMessage(s.chainId, addr, opId, handle)));
    return encodeApproval({ account: addr, opId, c, guess: handle, proof: E.hexlify(enc.inputProof), cosig });
  }

  /** What the computer does with the code: submit with K. It never sees the PIN or the fingerprint. */
  async function computerSubmits(acct: any, code: string) {
    const a = decodeApproval(code);
    expect(a.account).to.eq(await acct.getAddress());
    return await (await acct.submitGuessWithCosign(a.opId, a.c, a.guess, a.proof, a.cosig)).wait();
  }

  it("the phone's approval code: the computer submits it with K, the op runs; the phone recomputes the challenge itself", async () => {
    await alignDecay();
    const acct = await fresh();
    const id = await opIdFromReceipt(acct, await (await acct.requestTransfer(ETH, alice.address, E.parseEther("1"), true)).wait());
    const code = await phoneApproves(acct, id, PIN);
    expect(code.length).to.be.lessThan(1500);
    await computerSubmits(acct, code);
    await finalizeGuess(acct, id);
    expect((await acct.getOp(id)).status).to.eq(Status.Delayed);
    await time.increase(Number((await acct.delays()).pinTransfer) + 1);
    const a0 = await ethers.provider.getBalance(alice.address);
    await (await acct.executeOp(id)).wait();
    expect((await ethers.provider.getBalance(alice.address)) - a0).to.eq(E.parseEther("1"));
    // challenges recomputed for other op shapes too: admin with encrypted payload, a call with ETH
    const nf = hre.fhevm.createEncryptedInput(await acct.getAddress(), owner.address);
    nf.add64(await fingerprint("246813", s.chainId, await acct.getAddress()));
    const e = await nf.encrypt();
    const pc = await opIdFromReceipt(acct, await (await acct.openPinChange(e.handles[0], e.inputProof)).wait());
    expect(challengeOf(s.chainId, await acct.getAddress(), pc, opContentHash(pc, await acct.getOp(pc)))).to.eq(BigInt(await acct.challengeOf(pc)));
    const call = await opIdFromReceipt(acct, await (await acct.openCall(bob.address, E.parseEther("0.1"), "0x")).wait());
    expect(challengeOf(s.chainId, await acct.getAddress(), call, opContentHash(call, await acct.getOp(call)))).to.eq(BigInt(await acct.challengeOf(call)));
  });

  it("the input is bound to K's address: one made for the phone's address is refused; a code for one op is useless for another", async () => {
    await alignDecay();
    const acct = await fresh();
    const addr = await acct.getAddress();
    const id = await opIdFromReceipt(acct, await (await acct.requestTransfer(ETH, alice.address, E.parseEther("1"), true)).wait());
    const c = BigInt(await acct.challengeOf(id));
    const wrongUser = hre.fhevm.createEncryptedInput(addr, phone.address);
    wrongUser.add64(guessValue(await fingerprint(PIN, s.chainId, addr), c));
    const enc = await wrongUser.encrypt();
    const handle = E.hexlify(enc.handles[0]);
    const cosig = await phone.signMessage(E.getBytes(laneMessage(s.chainId, addr, id, handle)));
    await expect(acct.submitGuessWithCosign.staticCall(id, c, handle, enc.inputProof, cosig)).to.be.reverted;
    // a valid code for op `id` replayed on another op: the challenge and the signature both bind it to `id`
    const code = decodeApproval(await phoneApproves(acct, id, PIN));
    const other = await opIdFromReceipt(acct, await (await acct.requestTransfer(ETH, bob.address, E.parseEther("1"), true)).wait());
    await expect(acct.submitGuessWithCosign.staticCall(other, code.c, code.guess, code.proof, code.cosig)).to.be.reverted;
  });

  it("two-device setting: on with K alone (needs a second device); big transfers, calls and loosening take the lane; small ones stay on the K-track; off needs the lane and 72 h", async () => {
    await alignDecay();
    const noDevice = (await createAccount(s, owner, escape.address, guardian.address, { knownRecipients: [alice.address] })).connect(owner);
    await expect(noDevice.openAdmin.staticCall(LANE_ONLY, coder.encode(["bool"], [true]))).to.be.revertedWithCustomError(ERR, "InvalidParams");
    const acct = await fresh();
    await expect(acct.openAdmin(LANE_ONLY, coder.encode(["bool"], [true]))).to.emit(acct, "LaneOnlySet").withArgs(true);
    // a call and a loosening op: the K-track is refused at submit, counting nothing
    const call = await opIdFromReceipt(acct, await (await acct.openCall(bob.address, 0, "0x")).wait());
    await expect(guess(acct, owner, s.chainId, call, PIN)).to.be.revertedWithCustomError(ERR, "BadTrack");
    const pulse = await opIdFromReceipt(acct, await (await acct.openAdmin(A.SET_PULSE, coder.encode(["uint32"], [180 * DAY]))).wait());
    await expect(guess(acct, owner, s.chainId, pulse, PIN)).to.be.revertedWithCustomError(ERR, "BadTrack");
    await laneGuess(acct, owner, phone as any, s.chainId, call, PIN);
    await finalizeGuess(acct, call);
    expect((await acct.getOp(call)).status).to.eq(Status.Delayed);
    // a small transfer (below L_big) keeps the K-track
    const small = await opIdFromReceipt(acct, await (await acct.requestTransfer(ETH, alice.address, E.parseEther("0.01"), true)).wait());
    await guess(acct, owner, s.chainId, small, PIN);
    await finalizeGuess(acct, small);
    expect((await acct.getOp(small)).status).to.eq(Status.Delayed);
    // a big one (above L_big = 3 ETH): a correct K-track PIN leaves it open and asks for the lane
    const big = await opIdFromReceipt(acct, await (await acct.requestTransfer(ETH, alice.address, E.parseEther("4"), true)).wait());
    await guess(acct, owner, s.chainId, big, PIN);
    const rcBig = await finalizeGuess(acct, big);
    expect(rcBig.logs.map((l: any) => { try { return acct.interface.parseLog(l)?.name; } catch { return null; } })).to.include("LaneRequired");
    expect((await acct.getOp(big)).status).to.eq(Status.NeedsPin);
    await laneGuess(acct, owner, phone as any, s.chainId, big, PIN);
    await finalizeGuess(acct, big);
    expect((await acct.getOp(big)).status).to.eq(Status.Delayed);
    // off: an op on the lane only, waiting at least 72 h
    const off = await opIdFromReceipt(acct, await (await acct.openAdmin(LANE_ONLY, coder.encode(["bool"], [false]))).wait());
    await expect(guess(acct, owner, s.chainId, off, PIN)).to.be.revertedWithCustomError(ERR, "BadTrack");
    await laneGuess(acct, owner, phone as any, s.chainId, off, PIN);
    await finalizeGuess(acct, off);
    const op = await acct.getOp(off);
    expect(op.readyAt - BigInt(await time.latest())).to.be.gte(72n * 3600n - 5n);
    await time.increase(72 * 3600 + 1);
    await expect(acct.executeOp(off)).to.emit(acct, "LaneOnlySet").withArgs(false);
  });

  it("phone lost with the setting on: no lock-out — the device is replaced on the K-track with the long no-device delay, then the new phone works", async () => {
    await alignDecay();
    const acct = await fresh();
    await (await acct.openAdmin(LANE_ONLY, coder.encode(["bool"], [true]))).wait();
    const newPhone = E.Wallet.createRandom();
    const set = await opIdFromReceipt(acct, await (await acct.openAdmin(A.SET_DEVICE, coder.encode(["address"], [newPhone.address]))).wait());
    await guess(acct, owner, s.chainId, set, PIN); // the K-track, without the lost phone
    await finalizeGuess(acct, set);
    const d = await acct.delays();
    const wait = (await acct.getOp(set)).readyAt - BigInt(await time.latest());
    expect(wait).to.be.gte(BigInt(d.recoveryNoDevice) - 5n); // 30 days, not the 24 h settings delay: time to notice and cancel
    await time.increase(Number(d.recoveryNoDevice) + 1);
    await (await acct.executeOp(set)).wait();
    expect((await acct.roles())[2]).to.eq(newPhone.address);
    const call = await opIdFromReceipt(acct, await (await acct.openCall(bob.address, 0, "0x")).wait());
    await laneGuess(acct, owner, newPhone as any, s.chainId, call, PIN);
    await finalizeGuess(acct, call);
    expect((await acct.getOp(call)).status).to.eq(Status.Delayed);
  });
});
