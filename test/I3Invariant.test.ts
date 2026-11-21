/**
 * I3 as an invariant: the PIN fingerprints never leave the account. pinH, duressH and every fingerprint the account ever
 * held or was handed (a PIN change's or a reset's new fingerprint, the old one after it, the private mode's duress-aware
 * copies) are allowed to no address but the account itself and are never publicly decryptable. Checked after each flow,
 * on standard and private-mode accounts, two ways: the ACL's own answer for every address that took part, and every ACL
 * event since the stack was deployed (a grant to ANY address would show there). The account itself keeps its permission:
 * FHE permissions cannot be revoked, and it needs them to compare guesses.
 */
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers as E } from "ethers";
import * as hre from "hardhat";
import { A, DAY, ETH, alignDecay, coder, createAccount, encGuess, ethers, finalizeGuess, fingerprint, guess, laneGuess, opIdFromReceipt, personalSign, time } from "./helpers";
import { DURESS, FUND, HIDDEN, MIN_BIG_DELAY, PIN, StackP, WRONG, createAccountP, deployStackP, encAmount, opIdOf, tc } from "./privateHelpers";

const ALLOWED = E.id("Allowed(address,address,bytes32)");
const DECRYPTABLE = E.id("AllowedForDecryption(address,bytes32[])");

describe("I3 invariant: the PIN fingerprints never leave the account", function () {
  let s: StackP;
  let owner: HardhatEthersSigner, escape: HardhatEthersSigner, guardian: HardhatEthersSigner, device: HardhatEthersSigner;
  let helper: HardhatEthersSigner, newKey: HardhatEthersSigner, relayer: HardhatEthersSigner, R1: HardhatEthersSigner, stranger: HardhatEthersSigner;
  let acl: any;
  let fromBlock = 0;
  /** fingerprint handle → the account it belongs to */
  const fps = new Map<string, string>();
  const checked: string[] = [];

  before(async () => {
    [, owner, escape, guardian, device, helper, newKey, relayer, R1, stranger] = await ethers.getSigners();
    fromBlock = (await ethers.provider.getBlockNumber()) + 1;
    s = await deployStackP();
    acl = new ethers.Contract(
      await s.impl.aclAddress(),
      ["function isAllowed(bytes32,address) view returns (bool)", "function isAllowedForDecryption(bytes32) view returns (bool)"],
      ethers.provider,
    );
  });

  after(() => console.log(`      ${checked.length} checks, ${fps.size} fingerprint handles followed`));

  /** Adds the account's current fingerprints (and `extra` handles) to the followed set, then checks the whole set. */
  async function check(acct: any, label: string, extra: string[] = []) {
    const addr = (await acct.getAddress()).toLowerCase();
    const [pinH, duressH] = await acct.encryptedHandles(ETH);
    for (const h of [pinH, duressH, ...extra]) if (h !== E.ZeroHash) fps.set(h.toLowerCase(), addr);
    const parties = [
      ...[owner, escape, guardian, device, helper, newKey, relayer, R1, stranger].map((x) => x.address),
      await s.token.getAddress(),
      await s.impl.executorAddress(),
      await s.impl.aclAddress(),
      await s.entryPoint.getAddress(),
      await s.impl.getAddress(),
      await s.implP.getAddress(),
      await s.module.getAddress(),
      ...Object.values(s.libs),
    ];
    for (const h of fps.keys()) {
      for (const p of parties) expect(await acl.isAllowed(h, p), `${label}: ${h} is allowed to ${p}`).to.eq(false);
      expect(await acl.isAllowedForDecryption(h), `${label}: ${h} is publicly decryptable`).to.eq(false);
    }
    for (const l of await ethers.provider.getLogs({ address: await s.impl.aclAddress(), fromBlock, toBlock: "latest" })) {
      if (l.topics[0] === ALLOWED) {
        const grantee = ("0x" + l.topics[2].slice(26)).toLowerCase();
        const holder = fps.get((coder.decode(["bytes32"], l.data)[0] as string).toLowerCase());
        if (holder) expect(grantee, `${label}: a fingerprint was allowed to ${grantee}`).to.eq(holder);
      } else if (l.topics[0] === DECRYPTABLE) {
        for (const h of coder.decode(["bytes32[]"], l.data)[0] as string[]) {
          expect(fps.has(h.toLowerCase()), `${label}: a fingerprint was made publicly decryptable`).to.eq(false);
        }
      }
    }
    checked.push(label);
  }

  const encFp = async (acct: any, pin: string) => {
    const addr = await acct.getAddress();
    const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.add64(await fingerprint(pin, s.chainId, addr));
    return await inp.encrypt();
  };

  it("standard account: setup, correct, wrong and duress guesses, PIN change, forgotten-PIN reset", async () => {
    const acct = (await createAccount(s, owner, escape.address, guardian.address, { duressPin: DURESS, knownRecipients: [R1.address], device: device.address, helper: helper.address })).connect(owner);
    const addr = await acct.getAddress();
    await (await owner.sendTransaction({ to: addr, value: E.parseEther("1") })).wait();
    await check(acct, "setup");
    const d = await acct.delays();
    const transfer = async (pin: string) => {
      const id = await opIdFromReceipt(acct, await (await acct.requestTransfer(ETH, R1.address, E.parseEther("0.01"), true)).wait());
      await guess(acct, owner, s.chainId, id, pin);
      await finalizeGuess(acct, id);
      return id;
    };
    await alignDecay();
    const ok = await transfer(PIN);
    await time.increase(Number(d.pinTransfer) + 1);
    await (await acct.executeOp(ok)).wait();
    await check(acct, "correct PIN, executed");
    await transfer(WRONG);
    await check(acct, "wrong PIN");
    await transfer(DURESS);
    await check(acct, "duress PIN");
    await alignDecay();
    const nf = await encFp(acct, "246813");
    const pc = await opIdFromReceipt(acct, await (await acct.openPinChange(nf.handles[0], nf.inputProof)).wait());
    await check(acct, "PIN change opened", [(await acct.getOp(pc)).h0]);
    await guess(acct, owner, s.chainId, pc, PIN);
    await finalizeGuess(acct, pc);
    await time.increase(Number(d.settings) + 1);
    await (await acct.executeOp(pc)).wait();
    await check(acct, "PIN change executed"); // the old pinH is still followed
    const rf = await encFp(acct, "135791");
    const payload = E.keccak256(coder.encode(["bytes32", "uint32"], [rf.handles[0], (await acct.status()).ownerEpoch]));
    const cos = await personalSign(device, "encrypted-account/pin-reset/v1", s.chainId, addr, payload);
    const pr = await opIdFromReceipt(acct, await (await acct.openPinReset(rf.handles[0], rf.inputProof, cos)).wait());
    await check(acct, "PIN reset opened", [(await acct.getOp(pr)).h0]);
    await time.increase(Number(d.pinReset) + 1);
    await (await acct.executeOp(pr)).wait();
    await check(acct, "PIN reset executed");
  });

  it("recovery: opened, cancelled with K + PIN, completed to a new key", async () => {
    const open = async (acct: any) => {
      const addr = await acct.getAddress();
      const payload = E.keccak256(coder.encode(["address", "uint32"], [newKey.address, (await acct.status()).ownerEpoch]));
      const sig = await personalSign(newKey, "encrypted-account/recovery/v1", s.chainId, addr, payload);
      const id = await opIdFromReceipt(acct, await (await acct.connect(relayer).openRecovery(newKey.address, sig, "0x")).wait());
      const enc = await encGuess(acct, relayer.address, s.chainId, id, PIN);
      await (await acct.connect(relayer).submitRecoveryGuess(id, enc.c, enc.handles[0], enc.inputProof, { value: await acct.recoveryBond() })).wait();
      await finalizeGuess(acct, id);
      return id;
    };
    const a1 = (await createAccount(s, owner, escape.address, guardian.address, { duressPin: DURESS, knownRecipients: [R1.address] })).connect(owner);
    await alignDecay();
    const r1 = await open(a1);
    await check(a1, "recovery opened");
    const cancel = await opIdFromReceipt(a1, await (await a1.openCancel(r1)).wait());
    await guess(a1, owner, s.chainId, cancel, PIN);
    await finalizeGuess(a1, cancel);
    await check(a1, "recovery cancelled");
    const a2 = (await createAccount(s, owner, escape.address, guardian.address, { duressPin: DURESS, knownRecipients: [R1.address] })).connect(owner);
    const r2 = await open(a2);
    await time.increase(Number((await a2.delays()).recovery) + 1);
    await (await a2.executeOp(r2)).wait();
    expect(await a2.owner()).to.eq(newKey.address);
    await check(a2, "recovery completed");
  });

  it("escape: started, cancelled on the lane, started again and executed", async () => {
    const acct = (await createAccount(s, owner, escape.address, guardian.address, { duressPin: DURESS, knownRecipients: [R1.address], device: device.address })).connect(owner);
    await (await owner.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("1") })).wait();
    await (await acct.startEscape()).wait();
    await check(acct, "escape started");
    await alignDecay();
    const ce = await opIdFromReceipt(acct, await (await acct.openAdmin(A.CANCEL_ESCAPE, "0x")).wait());
    await laneGuess(acct, owner, device, s.chainId, ce, PIN);
    await finalizeGuess(acct, ce);
    expect((await acct.status()).escapeReadyAt).to.eq(0n);
    await check(acct, "escape cancelled");
    await (await acct.startEscape()).wait();
    await time.increase(Number((await acct.delays()).escape) + 1);
    await (await acct.executeEscape([])).wait();
    await check(acct, "escape executed");
  });

  it("private mode: K-only send, real and duress views, a duress transfer, reset, duress setting, PIN change under both PINs", async () => {
    const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address], duressPin: DURESS });
    const addr = await acct.getAddress();
    const token = await s.token.getAddress();
    await (await s.token.mint(addr, FUND)).wait();
    await check(acct, "private setup");
    const enc = await encAmount(acct, owner, tc(10));
    await (await acct.privateTransfer(token, R1.address, enc.handles[0], enc.inputProof)).wait();
    await check(acct, "K-only private send");
    const pinOp = async (open: () => Promise<any>, pin: string) => {
      const id = opIdOf(acct, await (await open()).wait());
      await guess(acct, owner, s.chainId, id, pin);
      await finalizeGuess(acct, id);
      return id;
    };
    await alignDecay();
    await pinOp(() => acct.openPrivateView(token), PIN);
    await pinOp(() => acct.openPrivateView(token), DURESS);
    await check(acct, "private views");
    const amt = await encAmount(acct, owner, tc(100));
    const t = await pinOp(() => acct.openPrivateTransfer(token, R1.address, amt.handles[0], amt.inputProof), DURESS);
    await time.increase(MIN_BIG_DELAY + 1);
    await (await acct.executeOp(t)).wait();
    await check(acct, "duress private transfer");
    await pinOp(() => acct.openPrivateReset(token), PIN);
    await check(acct, "private reset");
    const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.add64(await fingerprint(DURESS, s.chainId, addr));
    inp.addBool(true);
    inp.add64(HIDDEN);
    const sd = await inp.encrypt();
    const sdId = await pinOp(() => acct.openSetDuress(token, sd.handles[0], sd.handles[1], sd.handles[2], sd.inputProof), PIN);
    const settings = Number((await acct.delays()).settings);
    await time.increase(settings + 1);
    await (await acct.executeOp(sdId)).wait();
    await check(acct, "duress set again", [(await acct.getOp(sdId)).h0]);
    for (const pin of [DURESS, PIN]) {
      await alignDecay();
      const nf = await encFp(acct, pin === PIN ? "246813" : "975310");
      const pc = await pinOp(() => acct.openPinChange(nf.handles[0], nf.inputProof), pin);
      await time.increase(settings + 1);
      await (await acct.executeOp(pc)).wait();
      await check(acct, `PIN change under the ${pin === PIN ? "real" : "duress"} PIN`, [(await acct.getOp(pc)).h0]);
    }
  });
});
