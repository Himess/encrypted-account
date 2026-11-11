import { expect } from "chai";
import { ethers as E } from "ethers";
import * as hre from "hardhat";
import {
  DAY,
  FhevmType,
  HOUR,
  createAccount,
  debugAddr,
  debugU64,
  deployStack,
  ethers,
  guessAndFinalize,
  opIdFromReceipt,
  time,
} from "./helpers";

const INACTIVITY = 30 * DAY;
const GRACE = 7 * DAY;
const SLOTS = 4;
const ZERO = E.ZeroAddress;
const PIN = "482915";

describe("EncryptedWill: hidden inheritance in ERC-7984 tokens", function () {
  this.timeout(900_000);

  let factory: any;
  let impl: any;
  let alice: any, bob: any, carol: any, dave: any;
  const gas: Record<string, bigint> = {};

  before(async () => {
    [, alice, bob, carol, dave] = await ethers.getSigners();
    impl = await (await ethers.getContractFactory("EncryptedWill")).deploy();
    await impl.waitForDeployment();
    factory = await (await ethers.getContractFactory("EncryptedWillFactory")).deploy(await impl.getAddress());
    await factory.waitForDeployment();
  });

  after(() => {
    if (Object.keys(gas).length) console.log("      gas:", Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, Number(v)])));
  });

  async function newToken(): Promise<any> {
    const t = await (await ethers.getContractFactory("TestConfidentialToken")).deploy();
    await t.waitForDeployment();
    return t;
  }

  async function newMock(): Promise<any> {
    const m = await (await ethers.getContractFactory("MockWillAccount")).deploy();
    await m.waitForDeployment();
    await (await m.pinNow()).wait();
    return m;
  }

  async function willFor(account: string, inactivity = INACTIVITY, grace = GRACE): Promise<any> {
    const predicted = await factory.predictWill(account, inactivity, grace);
    const rcpt = await (await factory.createWill(account, inactivity, grace)).wait();
    if (gas.createWill === undefined) gas.createWill = rcpt.gasUsed;
    return ethers.getContractAt("EncryptedWill", predicted);
  }

  /** setHeirs calldata with an input proof bound to (will, account): the account is msg.sender at the will. */
  async function heirsCall(will: any, account: string, heirs: string[], shares: number[], proof?: string): Promise<string> {
    const inp = hre.fhevm.createEncryptedInput(await will.getAddress(), account);
    for (let i = 0; i < SLOTS; i++) inp.addAddress(heirs[i] ?? ZERO);
    for (let i = 0; i < SLOTS; i++) inp.add16(shares[i] ?? 0);
    const enc = await inp.encrypt();
    return will.interface.encodeFunctionData("setHeirs", [enc.handles.slice(0, SLOTS), enc.handles.slice(SLOTS), proof ?? enc.inputProof]);
  }

  async function setHeirs(will: any, mock: any, heirs: string[], shares: number[]) {
    const rcpt = await (await mock.exec(await will.getAddress(), await heirsCall(will, await mock.getAddress(), heirs, shares))).wait();
    if (gas.setHeirs === undefined) gas.setHeirs = rcpt.gasUsed;
  }

  async function balanceOf(token: any, who: string): Promise<bigint> {
    const h = await token.confidentialBalanceOf(who);
    return h === E.ZeroHash ? 0n : await debugU64(h);
  }

  async function settleAfterAbsence(will: any) {
    await time.increase(INACTIVITY);
    const rs = await (await will.start()).wait();
    if (gas.start === undefined) gas.start = rs.gasUsed;
    await time.increase(GRACE);
    const rt = await (await will.settle()).wait();
    if (gas.settle === undefined) gas.settle = rt.gasUsed;
  }

  async function claim(will: any, token: any, who: any) {
    const rcpt = await (await will.connect(who).claim(await token.getAddress())).wait();
    return rcpt;
  }

  describe("factory", () => {
    it("deploys one clone per (account, inactivity, grace), at a predictable address, and only for an account", async () => {
      const mock = await newMock();
      const a = await mock.getAddress();
      const will = await willFor(a);
      expect(await will.account()).to.eq(a);
      expect(await will.inactivity()).to.eq(INACTIVITY);
      expect(await will.grace()).to.eq(GRACE);
      // idempotent; other parameters give another address
      await (await factory.createWill(a, INACTIVITY, GRACE)).wait();
      expect(await factory.predictWill(a, INACTIVITY, GRACE + 1)).to.not.eq(await will.getAddress());
      // the clone is initialized once
      await expect(will.initialize.staticCall(a, INACTIVITY, GRACE)).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
      // periods below five minutes, the zero address, an EOA and a contract that is not an account are refused
      await expect(factory.createWill.staticCall(a, 299, GRACE)).to.be.revertedWithCustomError(impl, "InvalidParams");
      await expect(factory.createWill.staticCall(a, INACTIVITY, 299)).to.be.revertedWithCustomError(impl, "InvalidParams");
      await expect(factory.createWill.staticCall(ZERO, INACTIVITY, GRACE)).to.be.revertedWithCustomError(impl, "InvalidParams");
      await expect(factory.createWill.staticCall(dave.address, INACTIVITY, GRACE)).to.be.reverted;
      await expect(factory.createWill.staticCall(await (await newToken()).getAddress(), INACTIVITY, GRACE)).to.be.reverted;
    });
  });

  describe("heirs", () => {
    it("only the account sets them, never with an empty proof, and the shares are capped at 100 % in slot order", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const data = await heirsCall(will, await mock.getAddress(), [alice.address, bob.address, carol.address], [6000, 3000, 2000]);
      await expect(alice.call({ to: await will.getAddress(), data })).to.be.revertedWithCustomError(will, "NotAccount");
      const empty = await heirsCall(will, await mock.getAddress(), [alice.address], [10000], "0x");
      await expect(mock.exec.staticCall(await will.getAddress(), empty)).to.be.revertedWithCustomError(will, "EmptyProof");

      await (await mock.exec(await will.getAddress(), data)).wait();
      expect(await will.heirsSet()).to.eq(true);
      const [heirs, shares] = await will.heirHandles();
      const got = await Promise.all(heirs.map((h: string) => debugAddr(h)));
      expect(got.map((x: string) => x.toLowerCase())).to.deep.eq(
        [alice.address, bob.address, carol.address, ZERO].map((x) => x.toLowerCase()),
      );
      // 6000 + 3000 leave 1000 for the third slot, which asked for 2000
      expect(await Promise.all(shares.map((h: string) => debugU64(h)))).to.deep.eq([6000n, 3000n, 1000n, 0n]);
    });

    it("a share above 10 000 is capped too", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      await setHeirs(will, mock, [alice.address, bob.address], [65535, 5000]);
      const [, shares] = await will.heirHandles();
      expect(await Promise.all(shares.map((h: string) => debugU64(h)))).to.deep.eq([10000n, 0n, 0n, 0n]);
    });
  });

  describe("trigger", () => {
    it("starts after `inactivity` without a correct PIN; a PIN during `grace` voids the start; then it settles", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      await expect(will.start.staticCall()).to.be.revertedWithCustomError(will, "NoHeirs");
      await setHeirs(will, mock, [alice.address], [10000]);
      expect((await will.state()).phase).to.eq(1n);

      await expect(will.start.staticCall()).to.be.revertedWithCustomError(will, "TooEarly");
      await time.increase(INACTIVITY);
      expect((await will.state()).phase).to.eq(2n);
      await (await will.start()).wait();
      await expect(will.start.staticCall()).to.be.revertedWithCustomError(will, "AlreadyStarted");
      expect((await will.state()).phase).to.eq(3n);
      await expect(will.settle.staticCall()).to.be.revertedWithCustomError(will, "TooEarly");

      // the owner enters a correct PIN during grace: the start is void, and a new one needs a new absence
      await time.increase(GRACE / 2);
      await (await mock.pinNow()).wait();
      expect((await will.state()).phase).to.eq(1n);
      await time.increase(GRACE);
      await expect(will.settle.staticCall()).to.be.revertedWithCustomError(will, "NotStarted");
      await expect(will.start.staticCall()).to.be.revertedWithCustomError(will, "TooEarly");

      await settleAfterAbsence(will);
      expect(await will.settled()).to.eq(true);
      expect((await will.state()).phase).to.eq(5n);
      await expect(will.start.staticCall()).to.be.revertedWithCustomError(will, "AlreadySettled");
      await expect(will.settle.staticCall()).to.be.revertedWithCustomError(will, "AlreadySettled");
      // after settlement the account can neither change the heirs nor withdraw
      const data = await heirsCall(will, await mock.getAddress(), [dave.address], [10000]);
      await expect(mock.exec.staticCall(await will.getAddress(), data)).to.be.revertedWithCustomError(will, "AlreadySettled");
      const token = await newToken();
      const wd = will.interface.encodeFunctionData("withdrawAll", [await token.getAddress(), dave.address]);
      await expect(mock.exec.staticCall(await will.getAddress(), wd)).to.be.revertedWithCustomError(will, "AlreadySettled");
    });

    it("claims wait for settlement", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      await setHeirs(will, mock, [alice.address], [10000]);
      const token = await newToken();
      await expect(will.connect(alice).claim.staticCall(await token.getAddress())).to.be.revertedWithCustomError(will, "NotSettled");
    });
  });

  describe("claims", () => {
    it("each heir receives its share; anyone else an encrypted zero; a second claim pays nothing; the heir can decrypt", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const token = await newToken();
      await setHeirs(will, mock, [alice.address, bob.address], [6000, 4000]);
      const funded = 1_000_000_007n; // odd, so the floors show
      await (await token.mint(await will.getAddress(), funded)).wait();
      await settleAfterAbsence(will);

      // a stranger claims first: this fixes the amounts and pays an encrypted zero
      const r0 = await claim(will, token, carol);
      gas.firstClaim = r0.gasUsed;
      expect(await balanceOf(token, carol.address)).to.eq(0n);
      const r1 = await claim(will, token, alice);
      gas.claim = r1.gasUsed;
      await claim(will, token, bob);
      await claim(will, token, alice); // again: nothing more

      const a = (funded * 6000n) / 10000n;
      const b = (funded * 4000n) / 10000n;
      expect(await balanceOf(token, alice.address)).to.eq(a);
      expect(await balanceOf(token, bob.address)).to.eq(b);
      expect(await balanceOf(token, await will.getAddress())).to.eq(funded - a - b); // the floors' remainder stays

      // the heir reads its own balance with a user decryption (the path a wallet uses)
      const h = await token.confidentialBalanceOf(alice.address);
      expect(await hre.fhevm.userDecryptEuint(FhevmType.euint64, h, await token.getAddress(), alice)).to.eq(a);

      // after the first claim, a stranger's claim and an heir's claim emit the same events (same kinds, same count):
      // nothing on chain tells them apart
      const r2 = await claim(will, token, dave);
      expect(await balanceOf(token, dave.address)).to.eq(0n);
      const kinds = (rc: any) => rc.logs.map((l: any) => `${l.address.toLowerCase()}:${l.topics[0]}`).sort();
      expect(kinds(r2)).to.deep.eq(kinds(r1));
      // (Gas is not compared here: the mock stores every cleartext, so a zero costs less than a nonzero value. On a
      // real chain FHE execution is symbolic and gas does not depend on encrypted values; the Sepolia run measures it.)
    });

    it("one address in two slots receives both; tokens that arrive after the first claim stay in the will", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const token = await newToken();
      await setHeirs(will, mock, [alice.address, alice.address, bob.address], [5000, 2500, 2500]);
      await (await token.mint(await will.getAddress(), 4_000_000n)).wait();
      await settleAfterAbsence(will);
      await claim(will, token, alice);
      expect(await balanceOf(token, alice.address)).to.eq(3_000_000n);
      await (await token.mint(await will.getAddress(), 1_000_000n)).wait();
      await claim(will, token, bob);
      expect(await balanceOf(token, bob.address)).to.eq(1_000_000n);
      expect(await balanceOf(token, await will.getAddress())).to.eq(1_000_000n);
    });

    it("a token the will never held pays zero without reverting; tokens are settled independently", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const held = await newToken();
      const never = await newToken();
      await setHeirs(will, mock, [alice.address], [10000]);
      await (await held.mint(await will.getAddress(), 500n)).wait();
      await settleAfterAbsence(will);
      await claim(will, never, alice);
      expect(await balanceOf(never, alice.address)).to.eq(0n);
      expect((await will.payout(await held.getAddress())).taken).to.eq(false);
      await claim(will, held, alice);
      expect(await balanceOf(held, alice.address)).to.eq(500n);
    });
  });

  describe("withdrawal", () => {
    it("before settlement the account takes everything back; nobody else can", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const token = await newToken();
      await (await token.mint(await will.getAddress(), 777n)).wait();
      await expect(will.connect(alice).withdrawAll.staticCall(await token.getAddress(), alice.address)).to.be.revertedWithCustomError(will, "NotAccount");
      const wd = will.interface.encodeFunctionData("withdrawAll", [await token.getAddress(), dave.address]);
      const rcpt = await (await mock.exec(await will.getAddress(), wd)).wait();
      gas.withdrawAll = rcpt.gasUsed;
      expect(await balanceOf(token, dave.address)).to.eq(777n);
      expect(await balanceOf(token, await will.getAddress())).to.eq(0n);
    });
  });

  describe("with a real Encrypted Account", () => {
    it("heirs go through the PIN path, any correct PIN voids a start, and after a real absence the heirs claim", async () => {
      const stack = await deployStack();
      const signers = await ethers.getSigners();
      const [owner, escape, guardian] = [signers[6], signers[7], signers[8]];
      const acct = await createAccount(stack, owner, escape.address, guardian.address, { pin: PIN });
      const acctAddr = await acct.getAddress();
      const will = await willFor(acctAddr);
      const token = await newToken();

      // the key alone cannot reach the will
      const data = await heirsCall(will, acctAddr, [alice.address, bob.address], [7000, 3000]);
      await expect(owner.call({ to: await will.getAddress(), data })).to.be.revertedWithCustomError(will, "NotAccount");

      // through the account's PIN path: openCall → PIN → generic-call delay → executeOp
      const opId = await opIdFromReceipt(acct, await (await acct.connect(owner).openCall(await will.getAddress(), 0, data)).wait());
      await guessAndFinalize(acct, owner, stack.chainId, opId, PIN);
      await time.increase(48 * HOUR);
      await (await acct.executeOp(opId)).wait();
      expect(await will.heirsSet()).to.eq(true);
      expect(await will.lastPinAt()).to.eq((await acct.status()).lastPinAt);

      await (await token.mint(await will.getAddress(), 10_000_000n)).wait();

      // an absence starts it; a correct PIN on the account (here for an unrelated call) voids it
      await time.increase(INACTIVITY);
      await (await will.start()).wait();
      const target: any = await (await ethers.getContractFactory("CallTarget")).deploy();
      const op2 = await opIdFromReceipt(
        acct,
        await (await acct.connect(owner).openCall(await target.getAddress(), 0, target.interface.encodeFunctionData("setValue", [1n]))).wait(),
      );
      await guessAndFinalize(acct, owner, stack.chainId, op2, PIN);
      await time.increase(GRACE);
      await expect(will.settle.staticCall()).to.be.revertedWithCustomError(will, "NotStarted");

      // a real absence: no PIN for inactivity + grace
      await settleAfterAbsence(will);
      await claim(will, token, alice);
      await claim(will, token, bob);
      expect(await balanceOf(token, alice.address)).to.eq(7_000_000n);
      expect(await balanceOf(token, bob.address)).to.eq(3_000_000n);
    });
  });
});
