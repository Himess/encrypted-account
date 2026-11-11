import { expect } from "chai";
import { ethers as E } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { Alert, WillWatcher } from "../sdk/src/watchtower";
import {
  DAY,
  FhevmType,
  HOUR,
  RECORD,
  createAccount,
  debugAddr,
  debugBool,
  debugU64,
  deployStack,
  encGuess,
  ethers,
  finalizeGuess,
  guessAndFinalize,
  opIdFromReceipt,
  time,
} from "./helpers";

const P = { inactivity: 30 * DAY, grace: 7 * DAY, window: 365 * DAY }; // demo factory: any period from 5 minutes
const SLOTS = 4;
const ZERO = E.ZeroAddress;
const PIN = "482915";
const HCU_TX_LIMIT = 20_000_000;
const HCU_DEPTH_LIMIT = 5_000_000;

type Slot = { addr?: string; code?: bigint; share?: number };

const random128 = (): bigint => {
  let v = 0n;
  while (v === 0n) v = BigInt(E.hexlify(E.randomBytes(16)));
  return v;
};

describe("EncryptedWill: hidden inheritance in ERC-7984 tokens (W1)", function () {
  this.timeout(1_200_000);

  let demo: any;
  let alice: any, bob: any, carol: any, dave: any, erin: any;
  const hcuRows: { op: string; hcu: number; depth: number; gas: number }[] = [];

  before(async () => {
    [, alice, bob, carol, dave, erin] = await ethers.getSigners();
    demo = await (await ethers.getContractFactory("EncryptedWillDemoFactory")).deploy();
    await demo.waitForDeployment();
  });

  after(() => {
    if (!hcuRows.length) return;
    console.table(hcuRows);
    if (RECORD) {
      fs.mkdirSync(path.join(process.cwd(), "results"), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), "results", "will-hcu-mock.json"), JSON.stringify({ limits: { tx: HCU_TX_LIMIT, depth: HCU_DEPTH_LIMIT }, rows: hcuRows }, null, 2));
    }
  });

  const hcuOf = (rc: any) => {
    const h = hre.fhevm.computeTransactionHCU(rc);
    return { hcu: Number(h.globalHCU), depth: Number(h.maxHCUDepth) };
  };
  const note = (op: string, rc: any) => {
    if (hcuRows.some((r) => r.op === op)) return;
    hcuRows.push({ op, ...hcuOf(rc), gas: Number(rc.gasUsed) });
  };

  async function newToken(): Promise<any> {
    const t = await (await ethers.getContractFactory("TestConfidentialToken")).deploy();
    await t.waitForDeployment();
    return t;
  }

  async function newMock(escape = dave.address): Promise<any> {
    const m = await (await ethers.getContractFactory("MockWillAccount")).deploy(escape);
    await m.waitForDeployment();
    await (await m.pinNow()).wait();
    return m;
  }

  async function willFor(account: string, p = P, factory = demo): Promise<any> {
    const predicted = await factory.predictWill(account, p.inactivity, p.grace, p.window);
    await (await factory.createWill(account, p.inactivity, p.grace, p.window)).wait();
    return ethers.getContractAt("EncryptedWill", predicted);
  }

  /** setHeirs calldata: 4 addresses, 4 codes, 4 shares, one proof bound to (will, account). */
  async function heirsCall(will: any, account: string, slots: Slot[], proof?: string): Promise<string> {
    const inp = hre.fhevm.createEncryptedInput(await will.getAddress(), account);
    for (let i = 0; i < SLOTS; i++) inp.addAddress(slots[i]?.addr ?? ZERO);
    for (let i = 0; i < SLOTS; i++) inp.add128(slots[i]?.code ?? 0n);
    for (let i = 0; i < SLOTS; i++) inp.add16(slots[i]?.share ?? 0);
    const enc = await inp.encrypt();
    const h = enc.handles;
    return will.interface.encodeFunctionData("setHeirs", [h.slice(0, 4), h.slice(4, 8), h.slice(8, 12), proof ?? enc.inputProof]);
  }

  async function setHeirs(will: any, mock: any, slots: Slot[]) {
    const rc = await (await mock.exec(await will.getAddress(), await heirsCall(will, await mock.getAddress(), slots))).wait();
    note("setHeirs (4 slots)", rc);
  }

  /** The claim input: code ⊕ codeMask(recipient), encrypted for (will, sender). */
  async function codeInput(will: any, sender: string, recipient: string, code: bigint) {
    const mask = BigInt(await will.codeMask(recipient));
    const inp = hre.fhevm.createEncryptedInput(await will.getAddress(), sender);
    inp.add128(code ^ mask);
    const enc = await inp.encrypt();
    return { handle: enc.handles[0], proof: enc.inputProof };
  }

  async function claim(will: any, token: any, signer: any, opts: { recipient?: string; code?: bigint; maskFor?: string } = {}) {
    const recipient = opts.recipient ?? signer.address;
    const ci = await codeInput(will, signer.address, opts.maskFor ?? recipient, opts.code ?? random128());
    return await (await will.connect(signer).claim(await token.getAddress(), recipient, ci.handle, ci.proof)).wait();
  }

  async function round(will: any, token: any, groups: [number, number][] = [[0, 4]], who: any = carol) {
    const rp = await (await will.connect(who).prepare(await token.getAddress())).wait();
    note("prepare", rp);
    for (const [a, b] of groups) {
      const rs = await (await will.connect(who).snapshot(await token.getAddress(), a, b)).wait();
      note(`snapshot (${b - a} slot${b - a === 1 ? "" : "s"})`, rs);
    }
  }

  async function settleAfterAbsence(will: any) {
    const p = { inactivity: Number(await will.inactivity()), grace: Number(await will.grace()) };
    await time.increase(p.inactivity);
    await (await will.start()).wait();
    await time.increase(p.grace);
    await (await will.settle()).wait();
  }

  async function balanceOf(token: any, who: string): Promise<bigint> {
    const h = await token.confidentialBalanceOf(who);
    return h === E.ZeroHash ? 0n : await debugU64(h);
  }

  async function shares(will: any): Promise<bigint[]> {
    const [, , , s] = await will.heirHandles();
    const out: bigint[] = [];
    for (const h of s) out.push(await debugU64(h));
    return out;
  }

  // ───────────────────────────── W1.6: factories ─────────────────────────────

  describe("factories (W1.6)", () => {
    it("demo factory: one clone per parameter set, from 5 minutes; its implementation accepts only it; testnets only", async () => {
      const mock = await newMock();
      const a = await mock.getAddress();
      const will = await willFor(a);
      expect(await will.account()).to.eq(a);
      expect(await will.claimWindow()).to.eq(P.window);
      await (await demo.createWill(a, P.inactivity, P.grace, P.window)).wait(); // idempotent
      expect(await demo.predictWill(a, P.inactivity, P.grace, P.window + 1)).to.not.eq(await will.getAddress());
      await expect(will.initialize.staticCall(a, P.inactivity, P.grace, P.window)).to.be.revertedWithCustomError(will, "NotFactory");
      const impl = await ethers.getContractAt("EncryptedWill", await demo.implementation());
      await expect(impl.initialize.staticCall(a, P.inactivity, P.grace, P.window)).to.be.revertedWithCustomError(impl, "NotFactory");
      await expect(demo.createWill.staticCall(a, 299, P.grace, P.window)).to.be.revertedWithCustomError(demo, "PeriodOutOfBounds");
      await expect(demo.createWill.staticCall(a, P.inactivity, 299, P.window)).to.be.revertedWithCustomError(demo, "PeriodOutOfBounds");
      await expect(demo.createWill.staticCall(a, P.inactivity, P.grace, 299)).to.be.revertedWithCustomError(demo, "PeriodOutOfBounds");
      await expect(demo.createWill.staticCall(dave.address, P.inactivity, P.grace, P.window)).to.be.reverted; // not an account
      expect(await demo.isTestnet(1)).to.eq(false);
      expect(await demo.isTestnet(11155111)).to.eq(true);
      expect(await demo.isTestnet(31337)).to.eq(true);
    });

    it("production factory: inactivity 90 days–5 years and never below the PIN pulse; grace 30 days–1 year; window ≥ 1 year", async () => {
      const prod: any = await (await ethers.getContractFactory("EncryptedWillFactory")).deploy();
      const mock = await newMock();
      const a = await mock.getAddress();
      const d = { i: Number(await prod.DEFAULT_INACTIVITY()), g: Number(await prod.DEFAULT_GRACE()), w: Number(await prod.DEFAULT_CLAIM_WINDOW()) };
      expect(d).to.deep.eq({ i: 180 * DAY, g: 30 * DAY, w: 730 * DAY });
      await (await prod.createWill(a, d.i, d.g, d.w)).wait();
      const bad: [number, number, number][] = [
        [89 * DAY, d.g, d.w],
        [5 * 365 * DAY + 1, d.g, d.w],
        [d.i, 29 * DAY, d.w],
        [d.i, 366 * DAY, d.w],
        [d.i, d.g, 364 * DAY],
      ];
      for (const [i, g, w] of bad) await expect(prod.createWill.staticCall(a, i, g, w)).to.be.revertedWithCustomError(prod, "PeriodOutOfBounds");
      await (await mock.setPulse(200 * DAY)).wait();
      await expect(prod.createWill.staticCall(a, 180 * DAY, d.g, d.w)).to.be.revertedWithCustomError(prod, "InactivityBelowPulse");
      await (await prod.createWill(a, 200 * DAY, d.g, d.w)).wait();
    });
  });

  // ───────────────────────────── W1.1: heirs and shares ─────────────────────────────

  describe("heirs (W1.1)", () => {
    it("only the account sets them, never with an empty proof; 6000/3000/0/0 → the rest goes to slot 0 (7000)", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const data = await heirsCall(will, await mock.getAddress(), [
        { addr: alice.address, share: 6000 },
        { addr: bob.address, share: 3000 },
      ]);
      await expect(alice.call({ to: await will.getAddress(), data })).to.be.revertedWithCustomError(will, "NotAccount");
      const empty = await heirsCall(will, await mock.getAddress(), [{ addr: alice.address, share: 10000 }], "0x");
      await expect(mock.exec.staticCall(await will.getAddress(), empty)).to.be.revertedWithCustomError(will, "EmptyProof");
      await (await mock.exec(await will.getAddress(), data)).wait();
      expect(await shares(will)).to.deep.eq([7000n, 3000n, 0n, 0n]);
      const [heirs, , active] = await will.heirHandles();
      const addrs: string[] = [];
      for (const h of heirs) addrs.push((await debugAddr(h)).toLowerCase());
      expect(addrs).to.deep.eq([alice.address, bob.address, ZERO, ZERO].map((x) => x.toLowerCase()));
      for (const h of active) expect(await debugBool(h)).to.eq(false);
    });

    it("slot 0 empty and slot 1 filled → the rest goes to slot 1; a code-only slot is filled; a single 12,000 is capped to 10,000", async () => {
      const mock = await newMock();
      const w1 = await willFor(await mock.getAddress(), { ...P, window: P.window + 1 });
      await setHeirs(w1, mock, [{}, { addr: bob.address, share: 6000 }]);
      expect(await shares(w1)).to.deep.eq([0n, 10000n, 0n, 0n]);
      const w2 = await willFor(await mock.getAddress(), { ...P, window: P.window + 2 });
      await setHeirs(w2, mock, [{ code: random128(), share: 5000 }]);
      expect(await shares(w2)).to.deep.eq([10000n, 0n, 0n, 0n]);
      const [, , active] = await w2.heirHandles();
      expect(await debugBool(active[0])).to.eq(true);
      const w3 = await willFor(await mock.getAddress(), { ...P, window: P.window + 3 });
      await setHeirs(w3, mock, [{ addr: alice.address, share: 12000 }]);
      expect(await shares(w3)).to.deep.eq([10000n, 0n, 0n, 0n]);
    });
  });

  // ───────────────────────────── trigger ─────────────────────────────

  describe("trigger", () => {
    it("starts after `inactivity` without a correct PIN; a PIN during `grace` voids the start; then it settles for good", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      await expect(will.start.staticCall()).to.be.revertedWithCustomError(will, "NoHeirs");
      await setHeirs(will, mock, [{ addr: alice.address, share: 10000 }]);
      expect((await will.state()).phase).to.eq(1n);
      await expect(will.start.staticCall()).to.be.revertedWithCustomError(will, "TooEarly");
      await time.increase(P.inactivity);
      expect((await will.state()).phase).to.eq(2n);
      await expect(will.start()).to.emit(will, "WillStarted");
      await expect(will.start.staticCall()).to.be.revertedWithCustomError(will, "AlreadyStarted");
      await expect(will.settle.staticCall()).to.be.revertedWithCustomError(will, "TooEarly");
      await time.increase(P.grace / 2);
      await (await mock.pinNow()).wait();
      expect((await will.state()).phase).to.eq(1n);
      await time.increase(P.grace);
      await expect(will.settle.staticCall()).to.be.revertedWithCustomError(will, "NotStarted");
      await expect(will.start.staticCall()).to.be.revertedWithCustomError(will, "TooEarly");
      await settleAfterAbsence(will);
      const st = await will.state();
      expect(st.phase).to.eq(5n);
      expect(st.sweepableAt).to.eq((await will.settledAt()) + BigInt(P.window));
      await expect(will.start.staticCall()).to.be.revertedWithCustomError(will, "AlreadySettled");
      const data = await heirsCall(will, await mock.getAddress(), [{ addr: dave.address, share: 10000 }]);
      await expect(mock.exec.staticCall(await will.getAddress(), data)).to.be.revertedWithCustomError(will, "AlreadySettled");
    });
  });

  // ───────────────────────────── W1.2: rounds ─────────────────────────────

  describe("rounds (W1.2)", () => {
    it("claims wait for a complete round; anyone runs it, one slot or several at a time; someone else finishes a half round", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const token = await newToken();
      const t = await token.getAddress();
      await setHeirs(will, mock, [
        { addr: alice.address, share: 6000 },
        { addr: bob.address, share: 4000 },
      ]);
      const funded = 1_000_000_007n;
      await (await token.mint(await will.getAddress(), funded)).wait();
      await expect(will.prepare.staticCall(t)).to.be.revertedWithCustomError(will, "NotSettled");
      await settleAfterAbsence(will);
      const ci = await codeInput(will, alice.address, alice.address, 1n);
      await expect(will.connect(alice).claim.staticCall(t, alice.address, ci.handle, ci.proof)).to.be.revertedWithCustomError(will, "NoRound");
      await expect(will.snapshot.staticCall(t, 0, 4)).to.be.revertedWithCustomError(will, "NoOpenRound");

      await (await will.connect(carol).prepare(t)).wait();
      await expect(will.prepare.staticCall(t)).to.be.revertedWithCustomError(will, "RoundOpen");
      await expect(will.snapshot.staticCall(t, 2, 2)).to.be.revertedWithCustomError(will, "BadRange");
      await expect(will.snapshot.staticCall(t, 0, 5)).to.be.revertedWithCustomError(will, "BadRange");
      await (await will.connect(carol).snapshot(t, 0, 1)).wait();
      expect((await will.tokenState(t)).toArray()).to.deep.eq([1n, 1n, true, false]);
      const ci2 = await codeInput(will, alice.address, alice.address, 1n);
      await expect(will.connect(alice).claim.staticCall(t, alice.address, ci2.handle, ci2.proof)).to.be.revertedWithCustomError(will, "RoundIncomplete");
      await expect(will.connect(dave).snapshot(t, 0, 4)).to.emit(will, "RoundComplete"); // someone else finishes; slot 0 is skipped
      expect((await will.tokenState(t)).toArray()).to.deep.eq([1n, 15n, false, false]);

      await claim(will, token, alice);
      await claim(will, token, bob);
      expect(await balanceOf(token, alice.address)).to.eq((funded * 6000n) / 10000n);
      expect(await balanceOf(token, bob.address)).to.eq((funded * 4000n) / 10000n);
    });

    it("money that arrives later is paid by a new round with the same shares; an earlier claimer gets only the new part", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const token = await newToken();
      await setHeirs(will, mock, [
        { addr: alice.address, share: 6000 },
        { addr: bob.address, share: 4000 },
      ]);
      const f1 = 2_000_000n;
      const f2 = 3_000_000n;
      await (await token.mint(await will.getAddress(), f1)).wait();
      await settleAfterAbsence(will);
      await round(will, token);
      await claim(will, token, alice); // bob waits
      expect(await balanceOf(token, alice.address)).to.eq(1_200_000n);
      await (await token.mint(await will.getAddress(), f2)).wait();
      await round(will, token, [
        [0, 2],
        [2, 4],
      ]);
      await claim(will, token, alice);
      expect(await balanceOf(token, alice.address)).to.eq(1_200_000n + 1_800_000n); // only the new part
      await claim(will, token, bob);
      expect(await balanceOf(token, bob.address)).to.eq(800_000n + 1_200_000n); // both rounds in one claim
      expect(await balanceOf(token, await will.getAddress())).to.eq(0n);
      await claim(will, token, bob); // nothing more
      expect(await balanceOf(token, bob.address)).to.eq(2_000_000n);
    });
  });

  // ───────────────────────────── W1.3: claim codes ─────────────────────────────

  describe("claim codes (W1.3)", () => {
    it("a relayer claims with the heir's code to a fresh address; a swapped recipient or a wrong code pays zero; code 0 never matches; address mode pays only to the heir's own address", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const token = await newToken();
      const code = random128();
      await setHeirs(will, mock, [
        { code, share: 6000 },
        { addr: bob.address, share: 4000 },
      ]);
      await (await token.mint(await will.getAddress(), 10_000_000n)).wait();
      await settleAfterAbsence(will);
      await round(will, token);
      const fresh = E.Wallet.createRandom().address;
      const thief = E.Wallet.createRandom().address;
      // the relayer swaps the recipient: the mask was computed for `fresh`, the payment goes to `thief` → zero
      await claim(will, token, carol, { recipient: thief, code, maskFor: fresh });
      expect(await balanceOf(token, thief)).to.eq(0n);
      await claim(will, token, carol, { recipient: fresh, code: code ^ 1n }); // wrong code
      await claim(will, token, carol, { recipient: fresh, code: 0n }); // code 0: slots without a code never match
      expect(await balanceOf(token, fresh)).to.eq(0n);
      await claim(will, token, carol, { recipient: fresh, code }); // the right code, through a relayer
      expect(await balanceOf(token, fresh)).to.eq(6_000_000n);
      await claim(will, token, carol, { recipient: fresh, code }); // once only
      expect(await balanceOf(token, fresh)).to.eq(6_000_000n);
      const bobsNew = E.Wallet.createRandom().address;
      await claim(will, token, bob, { recipient: bobsNew }); // address mode to another recipient: no match
      expect(await balanceOf(token, bobsNew)).to.eq(0n);
      await claim(will, token, bob); // to itself
      expect(await balanceOf(token, bob.address)).to.eq(4_000_000n);
    });

    it("an address heir that relays someone else's code claim pays only the code slot to that recipient; its own share waits for its own claim", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const token = await newToken();
      const code = random128();
      await setHeirs(will, mock, [
        { code, share: 6000 },
        { addr: bob.address, share: 4000 },
      ]);
      await (await token.mint(await will.getAddress(), 10_000_000n)).wait();
      await settleAfterAbsence(will);
      await round(will, token);
      const fresh = E.Wallet.createRandom().address;
      await claim(will, token, bob, { recipient: fresh, code }); // bob, an address heir, relays the code heir's claim
      expect(await balanceOf(token, fresh)).to.eq(6_000_000n); // the code slot only
      await claim(will, token, bob); // bob's own slot was left unclaimed
      expect(await balanceOf(token, bob.address)).to.eq(4_000_000n);
      expect(await balanceOf(token, await will.getAddress())).to.eq(0n);
    });

    it("every claim runs the same FHE sequence: heir or stranger, code or address mode, to itself or elsewhere — same HCU, same events", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const token = await newToken();
      const code = random128();
      await setHeirs(will, mock, [
        { code, share: 5000 },
        { addr: bob.address, share: 5000 },
      ]);
      await (await token.mint(await will.getAddress(), 1_000_000n)).wait();
      await settleAfterAbsence(will);
      await round(will, token);
      const receipts = {
        stranger: await claim(will, token, erin),
        code: await claim(will, token, carol, { recipient: E.Wallet.createRandom().address, code }),
        // an address heir claiming to another address matches nothing, through the same operations
        addressToOther: await claim(will, token, bob, { recipient: E.Wallet.createRandom().address }),
        address: await claim(will, token, bob),
        // A repeat claim, to a fresh recipient too: the token encrypts a first-time recipient's zero balance (+32 HCU),
        // so every receipt here goes to an address that never held the token. That depends on the recipient's own
        // history, which is public anyway, not on who claims.
        again: await claim(will, token, bob, { recipient: E.Wallet.createRandom().address }),
      };
      note("claim", receipts.code);
      const kinds = (rc: any) => rc.logs.map((l: any) => `${l.address.toLowerCase()}:${l.topics[0]}`).sort();
      const base = receipts.stranger;
      for (const [k, rc] of Object.entries(receipts)) {
        expect(hcuOf(rc), k).to.deep.eq(hcuOf(base));
        expect(kinds(rc), k).to.deep.eq(kinds(base));
      }
      // (Gas is compared on Sepolia: the mock stores every cleartext, so a zero costs less there.)
    });
  });

  // ───────────────────────────── W1.4 / W1.5: exits ─────────────────────────────

  describe("exits (W1.4, W1.5)", () => {
    it("an escape started while the owner was alive empties the will into the escape snapshot; a late, cancelled or post-settlement escape cannot", async () => {
      const token = await newToken();
      const t = await token.getAddress();
      // alive: the escape starts before lastPinAt + inactivity
      const m1 = await newMock(erin.address);
      const w1 = await willFor(await m1.getAddress());
      await (await token.mint(await w1.getAddress(), 900n)).wait();
      await expect(w1.escapeWithdraw.staticCall(t)).to.be.revertedWithCustomError(w1, "NoEscape");
      await (await m1.startEscape()).wait();
      await (await m1.setEscapeAddress(dave.address)).wait(); // later changes do not matter: the snapshot does
      const rc = await (await w1.connect(carol).escapeWithdraw(t)).wait();
      note("escapeWithdraw", rc);
      expect(await balanceOf(token, erin.address)).to.eq(900n);
      expect(await balanceOf(token, await w1.getAddress())).to.eq(0n);
      // late: the owner has been silent past the inactivity period, then someone with the key starts an escape
      const m2 = await newMock(erin.address);
      const w2 = await willFor(await m2.getAddress());
      await (await token.mint(await w2.getAddress(), 500n)).wait();
      await time.increase(P.inactivity);
      await (await m2.startEscape()).wait();
      await expect(w2.escapeWithdraw.staticCall(t)).to.be.revertedWithCustomError(w2, "EscapeAfterInactivity");
      // cancelled
      const m3 = await newMock(erin.address);
      const w3 = await willFor(await m3.getAddress());
      await (await m3.startEscape()).wait();
      await (await m3.cancelEscape()).wait();
      await expect(w3.escapeWithdraw.staticCall(t)).to.be.revertedWithCustomError(w3, "NoEscape");
      // after settlement
      const m4 = await newMock(erin.address);
      const w4 = await willFor(await m4.getAddress());
      await setHeirs(w4, m4, [{ addr: alice.address, share: 10000 }]);
      await settleAfterAbsence(w4);
      await (await m4.startEscape()).wait();
      await expect(w4.escapeWithdraw.staticCall(t)).to.be.revertedWithCustomError(w4, "AlreadySettled");
    });

    it("the claim window: no sweep before it; after it the rest goes to the escape address (the snapshot if an escape runs) and claims close", async () => {
      const token = await newToken();
      const t = await token.getAddress();
      const mock = await newMock(erin.address);
      const will = await willFor(await mock.getAddress());
      await setHeirs(will, mock, [
        { addr: alice.address, share: 6000 },
        { addr: bob.address, share: 4000 },
      ]);
      await (await token.mint(await will.getAddress(), 1_000_007n)).wait();
      await expect(will.sweepResidual.staticCall(t)).to.be.revertedWithCustomError(will, "NotSettled");
      await settleAfterAbsence(will);
      await round(will, token);
      await claim(will, token, alice); // bob never claims
      await time.increase(P.window - 60);
      await expect(will.sweepResidual.staticCall(t)).to.be.revertedWithCustomError(will, "TooEarly");
      await time.increase(60);
      const rc = await (await will.connect(carol).sweepResidual(t)).wait();
      note("sweepResidual", rc);
      expect(await balanceOf(token, erin.address)).to.eq(1_000_007n - 600_004n); // bob's 40 % and the floor's remainder
      expect(await balanceOf(token, await will.getAddress())).to.eq(0n);
      expect((await will.tokenState(t)).swept).to.eq(true);
      const ci = await codeInput(will, bob.address, bob.address, 1n);
      await expect(will.connect(bob).claim.staticCall(t, bob.address, ci.handle, ci.proof)).to.be.revertedWithCustomError(will, "Swept");
      await expect(will.prepare.staticCall(t)).to.be.revertedWithCustomError(will, "Swept");
      // a later deposit can be swept again; with an escape running it goes to the escape's snapshot
      await (await mock.startEscape()).wait();
      await (await mock.setEscapeAddress(dave.address)).wait();
      await (await token.mint(await will.getAddress(), 77n)).wait();
      await (await will.sweepResidual(t)).wait();
      expect(await balanceOf(token, erin.address)).to.eq(1_000_007n - 600_004n + 77n);
    });

    it("before settlement the account takes everything back; nobody else can", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const token = await newToken();
      await (await token.mint(await will.getAddress(), 777n)).wait();
      await expect(will.connect(alice).withdrawAll.staticCall(await token.getAddress(), alice.address)).to.be.revertedWithCustomError(will, "NotAccount");
      const wd = will.interface.encodeFunctionData("withdrawAll", [await token.getAddress(), dave.address]);
      await (await mock.exec(await will.getAddress(), wd)).wait();
      expect(await balanceOf(token, dave.address)).to.be.gte(777n);
      expect(await balanceOf(token, await will.getAddress())).to.eq(0n);
    });
  });

  // ───────────────────────────── W1.7: the watchtower ─────────────────────────────

  describe("watchtower (W1.7)", () => {
    it("reminds 30 and 7 days before the inactivity period ends, starts over after a PIN, and alerts on start and settlement", async () => {
      const mock = await newMock();
      const p = { inactivity: 90 * DAY, grace: 30 * DAY, window: 365 * DAY };
      const will = await willFor(await mock.getAddress(), p);
      await setHeirs(will, mock, [{ addr: alice.address, share: 10000 }]);
      const alerts: Alert[] = [];
      const wt = new WillWatcher({ will, notify: (a) => alerts.push(a) });
      const kinds = () => alerts.map((a) => (a.kind === "will-reminder" ? `reminder:${a.daysLeft}` : a.kind));
      await wt.tick();
      expect(kinds()).to.deep.eq([]);
      let end = Number((await will.state()).startableAt);
      await time.increaseTo(end - 30 * DAY);
      await wt.tick();
      await wt.tick();
      expect(kinds()).to.deep.eq(["reminder:30"]);
      await time.increaseTo(end - 7 * DAY);
      await wt.tick();
      expect(kinds()).to.deep.eq(["reminder:30", "reminder:7"]);
      await (await mock.pinNow()).wait(); // a correct PIN: a new period, new reminders
      end = Number((await will.state()).startableAt);
      await wt.tick();
      expect(kinds()).to.have.length(2);
      await time.increaseTo(end - 30 * DAY);
      await wt.tick();
      expect(kinds()).to.deep.eq(["reminder:30", "reminder:7", "reminder:30"]);
      await time.increaseTo(end);
      await (await will.start()).wait();
      await wt.tick();
      expect(alerts.at(-1)).to.deep.include({ kind: "will-started" });
      await time.increase(p.grace);
      await (await will.settle()).wait();
      await wt.tick();
      expect(kinds().slice(-2)).to.deep.eq(["will-started", "will-settled"]);
    });
  });

  // ───────────────────────────── HCU budget ─────────────────────────────

  describe("HCU budget", () => {
    it("single-slot calls stay within half of Zama's per-transaction HCU and depth limits", async () => {
      const mock = await newMock();
      const will = await willFor(await mock.getAddress());
      const token = await newToken();
      await setHeirs(will, mock, [
        { code: random128(), share: 3000 },
        { addr: bob.address, share: 3000 },
        { code: random128(), share: 2000 },
        { addr: alice.address, share: 2000 },
      ]);
      await (await token.mint(await will.getAddress(), 5_000_000n)).wait();
      await settleAfterAbsence(will);
      await round(will, token, [[0, 1]]);
      await (await will.snapshot(await token.getAddress(), 1, 4)).wait();
      note("claim", await claim(will, token, bob));
      for (const r of hcuRows) {
        if (/4 slots|3 slots|2 slots/.test(r.op)) continue;
        expect(r.hcu, r.op).to.be.lte(HCU_TX_LIMIT / 2);
        expect(r.depth, r.op).to.be.lte(HCU_DEPTH_LIMIT / 2);
      }
    });
  });

  // ───────────────────────────── with the real account ─────────────────────────────

  describe("with a real Encrypted Account", () => {
    it("heirs (one code, one address) go through the PIN path; a PIN voids a start; after an absence a relayer claims by code and the other heir by address", async () => {
      const stack = await deployStack();
      const signers = await ethers.getSigners();
      const [owner, escape, guardian, relayer] = [signers[6], signers[7], signers[8], signers[9]];
      const acct = await createAccount(stack, owner, escape.address, guardian.address, { pin: PIN });
      const acctAddr = await acct.getAddress();
      const will = await willFor(acctAddr);
      const token = await newToken();
      const code = random128();

      const data = await heirsCall(will, acctAddr, [
        { code, share: 7000 },
        { addr: bob.address, share: 3000 },
      ]);
      await expect(owner.call({ to: await will.getAddress(), data })).to.be.revertedWithCustomError(will, "NotAccount");
      const opId = await opIdFromReceipt(acct, await (await acct.connect(owner).openCall(await will.getAddress(), 0, data)).wait());
      await guessAndFinalize(acct, owner, stack.chainId, opId, PIN);
      await time.increase(48 * HOUR);
      await (await acct.executeOp(opId)).wait();
      expect(await will.heirsSet()).to.eq(true);
      expect(await will.lastPinAt()).to.eq((await acct.status()).lastPinAt);
      await (await token.mint(await will.getAddress(), 10_000_000n)).wait();

      await time.increase(P.inactivity);
      await (await will.start()).wait();
      const target: any = await (await ethers.getContractFactory("CallTarget")).deploy();
      const op2 = await opIdFromReceipt(acct, await (await acct.connect(owner).openCall(await target.getAddress(), 0, "0x")).wait());
      await guessAndFinalize(acct, owner, stack.chainId, op2, PIN);
      await time.increase(P.grace);
      await expect(will.settle.staticCall()).to.be.revertedWithCustomError(will, "NotStarted");

      await settleAfterAbsence(will);
      await round(will, token);
      const fresh = E.Wallet.createRandom().address;
      await claim(will, token, relayer, { recipient: fresh, code });
      await claim(will, token, bob);
      expect(await balanceOf(token, fresh)).to.eq(7_000_000n);
      expect(await balanceOf(token, bob.address)).to.be.gte(3_000_000n);
    });

    it("the real escape: started by the key while the owner is alive, it lets anyone move the will to the escape address", async () => {
      const stack = await deployStack();
      const signers = await ethers.getSigners();
      const [owner, escape, guardian] = [signers[10], signers[11], signers[12]];
      const acct = await createAccount(stack, owner, escape.address, guardian.address, { pin: PIN });
      const will = await willFor(await acct.getAddress());
      const token = await newToken();
      await (await token.mint(await will.getAddress(), 4_321n)).wait();
      await (await acct.connect(owner).startEscape()).wait();
      await (await will.connect(alice).escapeWithdraw(await token.getAddress())).wait();
      expect(await balanceOf(token, escape.address)).to.eq(4_321n);
    });

    it("W1.7 — the cheapest PIN-verified operation (proof of life): openCall to a no-op target, guess, finalize", async () => {
      const stack = await deployStack();
      const signers = await ethers.getSigners();
      const [owner, escape, guardian] = [signers[13], signers[14], signers[15]];
      const acct = await createAccount(stack, owner, escape.address, guardian.address, { pin: PIN });
      const before = (await acct.status()).lastPinAt;
      await time.increase(HOUR);
      const rcOpen = await (await acct.connect(owner).openCall(alice.address, 0, "0x")).wait(); // a no-op target
      const opId = await opIdFromReceipt(acct, rcOpen);
      const enc = await encGuess(acct, owner.address, stack.chainId, opId, PIN);
      const rcGuess = await (await acct.connect(owner).submitGuess(opId, enc.c, enc.handles[0], enc.inputProof)).wait();
      const rcFin = await finalizeGuess(acct, opId);
      const after = (await acct.status()).lastPinAt;
      expect(after).to.be.gt(before);
      const total = Number(rcOpen.gasUsed) + Number(rcGuess.gasUsed) + Number(rcFin.gasUsed);
      console.log(`      proof of life (mock gas): openCall ${rcOpen.gasUsed} + submitGuess ${rcGuess.gasUsed} + finalizeGuess ${rcFin.gasUsed} = ${total}`);
      expect((await acct.getOp(opId)).status).to.not.eq(0n);
    });
  });
});
