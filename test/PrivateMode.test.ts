/**
 * Private mode (optional): EncryptedAccountP + PrivateModule, ERC-7984 tokens. Setup rules, the K-only private path
 * (silent zero, sticky tripwire, reset, tighten), the PIN paths (view, transfer with the long delay, duress-aware PIN
 * change, duress set later), guards, both escapes (and the ETH / ERC-20 escape with the FHE executor down), and the
 * watchtower's notice of a silent zero.
 */
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers as E } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { Alert, Watchtower } from "../sdk/src/watchtower";
import { DAY, FhevmType, R, RECORD, Status, alignDecay, debugU64, defaultDelays, escapeConsent, ethers, finalizeGuess, fingerprint, guess, setupPinOf, time } from "./helpers";
import {
  DECOY,
  DURESS,
  FUND,
  MIN_BIG_DELAY,
  PIN,
  StackP,
  TRIPPED,
  WRONG,
  ALLOWED_TOPIC,
  DECRYPTABLE_TOPIC,
  Roles,
  abiP,
  balanceOf,
  cleartextLayer,
  createAccountP,
  delaysP,
  deployStackP,
  encAmount,
  eventArgs,
  j,
  opIdOf,
  recordTx,
  rejects,
  tc,
} from "./privateHelpers";

const OUT: Record<string, any> = { generatedAt: new Date().toISOString(), evidence: "[Mock] hardhat + @fhevm/hardhat-plugin (cleartext)" };

describe("Private mode (optional): EncryptedAccountP + PrivateModule", function () {
  let s: StackP;
  let owner: HardhatEthersSigner, escape: HardhatEthersSigner, guardian: HardhatEthersSigner, R1: HardhatEthersSigner, other: HardhatEthersSigner, stranger: HardhatEthersSigner;
  let token: string;

  before(async () => {
    [, owner, escape, guardian, R1, other, stranger] = await ethers.getSigners();
    s = await deployStackP();
    token = await s.token.getAddress();
    await (await s.token.mint(R1.address, tc(1))).wait();
  });

  after(() => {
    if (!RECORD) return;
    const dir = path.join(__dirname, "..", "results", "private-mode");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "private-mode-mock.json"), j(OUT) + "\n");
  });

  /** One PIN-gated private op end to end on the owner track: open, guess, finalize. */
  async function pinOp(acct: any, open: () => Promise<any>, pin: string) {
    const rc = await (await open()).wait();
    const id = opIdOf(acct, rc);
    await guess(acct, owner, s.chainId, id, pin);
    const fin = await finalizeGuess(acct, id);
    return { id, fin };
  }

  describe("setup", () => {
    it("the private token needs bigTransfer ≥ 72 h and stays out of the public asset tables", async () => {
      const d = await defaultDelays(s); // bigTransfer 48 h
      const salt = E.id("too-short");
      const addr = await s.factoryP.predictAddress(owner.address, escape.address, guardian.address, d, salt);
      await (await s.factoryP.createAccountWithDelays(owner.address, escape.address, guardian.address, d, salt, await escapeConsent(escape, s.chainId, addr, 0))).wait();
      const acct: any = new ethers.Contract(addr, await abiP(), owner);
      await setupPinOf(s, acct, owner, { pin: PIN });
      const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
      inp.add64(1n);
      inp.add64(2n);
      inp.add64(3n);
      const enc = await inp.encrypt();
      expect(await rejects(acct.privateSetupAsset(token, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof))).to.eq(true);

      const ok = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address] });
      expect((await ok.privateState(token)).configured).to.eq(true);
      expect((await ok.assetState(token)).configured).to.eq(false); // never a public asset: no public tau to probe
      expect(await ok.privateDelay(22)).to.eq(BigInt(MIN_BIG_DELAY));
    });

    it("duress is off by default: only the real PIN is correct", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address] });
      const { fin } = await pinOp(acct, () => acct.openPrivateView(token), DURESS);
      expect(eventArgs(acct, fin, "GuessFinalized").ok).to.eq(false);
      expect(eventArgs(acct, fin, "PrivateOpExecuted")).to.eq(null);
    });
  });

  describe("K-only private transfer", () => {
    it("within the hidden limit: one transaction, delivered; the guardian reads the outcome, K does not", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address] });
      const addr = await acct.getAddress();
      await (await s.token.mint(addr, FUND)).wait();
      const send = async (amount: bigint, to = R1.address) => {
        const enc = await encAmount(acct, owner, amount);
        return await (await acct.privateTransfer(token, to, enc.handles[0], enc.inputProof)).wait();
      };
      await send(tc(10)); // first transfer opens the account's one-time slots
      const r0 = await balanceOf(s, R1.address);
      const rc = await send(tc(100));
      expect((await balanceOf(s, R1.address)) - r0).to.eq(tc(100));
      const ev = eventArgs(acct, rc, "PrivateTransfer");
      expect(await hre.fhevm.userDecryptEuint(FhevmType.euint64, ev.spent, addr, guardian)).to.eq(tc(110));
      expect(await rejects(hre.fhevm.userDecryptEuint(FhevmType.euint64, ev.spent, addr, owner))).to.eq(true);
      expect(rc.logs.filter((l: any) => l.topics[0] === DECRYPTABLE_TOPIC).length).to.eq(0);
      // cost record (steady state): gas without the mock's cleartext layer, HCU, persistent ACL grants
      const roles = new Roles().set(addr, "ACCOUNT").set(token, "TOKEN").set(owner.address, "K").set(guardian.address, "G").set(R1.address, "R");
      const rec = await recordTx("privateTransfer", rc, roles, await cleartextLayer(await acct.executorAddress()));
      const grants = rc.logs.filter((l: any) => l.topics[0] === ALLOWED_TOPIC);
      OUT.kOnlyTransfer = {
        gasUsedMock: rec.gasUsed,
        protocolGas: rec.gasUsed - rec.cleartextGas,
        hcu: rec.hcu,
        hcuDepth: rec.hcuDepth,
        persistentAclGrants: grants.length,
        accountGrants: grants.filter((l: any) => new Roles().set(addr, "A").topic(l.topics[1]) === "A").length,
        tokenGrants: grants.filter((l: any) => new Roles().set(token, "T").topic(l.topics[1]) === "T").length,
      };
      console.log("      K-only cost", j(OUT.kOnlyTransfer));
      expect(OUT.kOnlyTransfer.accountGrants).to.eq(2);
    });

    it("over the limit: a silent zero; the counter saturates (tripwire), stays across days, until a PIN reset", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address] });
      const addr = await acct.getAddress();
      await (await s.token.mint(addr, FUND)).wait();
      const send = async (amount: bigint) => {
        const enc = await encAmount(acct, owner, amount);
        return await (await acct.privateTransfer(token, R1.address, enc.handles[0], enc.inputProof)).wait();
      };
      const r0 = await balanceOf(s, R1.address);
      const rc = await send(tc(5000));
      expect(rc.status).to.eq(1); // no revert
      expect(await balanceOf(s, R1.address)).to.eq(r0);
      expect(await debugU64((await acct.privateState(token)).spent)).to.eq(TRIPPED);
      await send(tc(10));
      expect(await balanceOf(s, R1.address)).to.eq(r0); // sticky
      await time.increase(DAY + 60);
      await send(tc(10));
      expect(await balanceOf(s, R1.address)).to.eq(r0); // a new day keeps the wire fired
      expect(await debugU64((await acct.privateState(token)).spent)).to.eq(TRIPPED);
      const tauBefore = (await acct.privateState(token)).tau;
      await alignDecay();
      await pinOp(acct, () => acct.openPrivateReset(token), PIN);
      const st = await acct.privateState(token);
      expect(await debugU64(st.spent)).to.eq(0n);
      expect(st.tau).to.not.eq(tauBefore);
      await send(tc(100));
      expect((await balanceOf(s, R1.address)) - r0).to.eq(tc(100));
    });

    it("an unknown recipient moves zero without tripping; tighten (K alone) only lowers the limits", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address] });
      const addr = await acct.getAddress();
      await (await s.token.mint(addr, FUND)).wait();
      const o0 = await balanceOf(s, other.address);
      const enc = await encAmount(acct, owner, tc(100));
      await (await acct.privateTransfer(token, other.address, enc.handles[0], enc.inputProof)).wait();
      expect(await balanceOf(s, other.address)).to.eq(o0);
      expect(await debugU64((await acct.privateState(token)).spent)).to.eq(0n);
      const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
      inp.add64(tc(50));
      const c = await inp.encrypt();
      await (await acct.privateTighten(token, c.handles[0], c.inputProof)).wait();
      expect(await debugU64((await acct.privateState(token)).lmax)).to.eq(tc(50));
      expect(await debugU64((await acct.privateState(token)).tau)).to.be.lte(tc(50));
      const enc2 = await encAmount(acct, owner, tc(100));
      await (await acct.privateTransfer(token, R1.address, enc2.handles[0], enc2.inputProof)).wait();
      expect(await debugU64((await acct.privateState(token)).spent)).to.eq(TRIPPED); // above the tightened limit
    });
  });

  describe("PIN paths", () => {
    it("view: K alone cannot read the balance; a correct PIN gives K a fresh snapshot; a wrong PIN gives nothing", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address] });
      const addr = await acct.getAddress();
      await (await s.token.mint(addr, FUND)).wait();
      const balH = await s.token.confidentialBalanceOf(addr);
      expect(await rejects(hre.fhevm.userDecryptEuint(FhevmType.euint64, balH, token, owner))).to.eq(true);
      expect(await rejects(hre.fhevm.userDecryptEuint(FhevmType.euint64, balH, addr, owner))).to.eq(true);
      const bad = await pinOp(acct, () => acct.openPrivateView(token), WRONG);
      expect(eventArgs(acct, bad.fin, "PrivateOpExecuted")).to.eq(null);
      await alignDecay();
      const good = await pinOp(acct, () => acct.openPrivateView(token), PIN);
      const snap = eventArgs(acct, good.fin, "PrivateOpExecuted").result;
      expect(snap).to.not.eq(balH);
      expect(await hre.fhevm.userDecryptEuint(FhevmType.euint64, snap, addr, owner)).to.eq(FUND);
    });

    it("a PIN transfer waits at least 72 h (§17.1), then moves the encrypted amount", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [] });
      const addr = await acct.getAddress();
      await (await s.token.mint(addr, FUND)).wait();
      const enc = await encAmount(acct, owner, tc(500));
      const { id, fin } = await pinOp(acct, () => acct.openPrivateTransfer(token, other.address, enc.handles[0], enc.inputProof), PIN);
      const now = BigInt((await ethers.provider.getBlock(fin.blockNumber))!.timestamp);
      const op = await acct.getOp(id);
      expect(op.status).to.eq(BigInt(Status.Delayed));
      expect(op.readyAt - now).to.be.gte(BigInt(MIN_BIG_DELAY));
      expect(await rejects(acct.executeOp(id))).to.eq(true);
      const o0 = await balanceOf(s, other.address);
      await time.increase(MIN_BIG_DELAY + 1);
      await (await acct.connect(stranger).executeOp(id)).wait(); // permissionless once verified
      expect((await balanceOf(s, other.address)) - o0).to.eq(tc(500));
    });

    it("duress: the view shows the decoy; a duress transfer moves up to the decoy left, all or nothing", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [], duressPin: DURESS });
      const addr = await acct.getAddress();
      await (await s.token.mint(addr, FUND)).wait();
      const v = await pinOp(acct, () => acct.openPrivateView(token), DURESS);
      expect(await hre.fhevm.userDecryptEuint(FhevmType.euint64, eventArgs(acct, v.fin, "PrivateOpExecuted").result, addr, owner)).to.eq(DECOY);
      const xfer = async (amount: bigint) => {
        const enc = await encAmount(acct, owner, amount);
        const { id } = await pinOp(acct, () => acct.openPrivateTransfer(token, other.address, enc.handles[0], enc.inputProof), DURESS);
        await time.increase(MIN_BIG_DELAY + 1);
        const rc = await (await acct.executeOp(id)).wait();
        return await debugU64(eventArgs(acct, rc, "PrivateOpExecuted").result);
      };
      expect(await xfer(tc(1500))).to.eq(tc(1500));
      expect(await xfer(tc(800))).to.eq(0n); // 500 left: more than that moves zero, as a real balance would
      expect(await balanceOf(s, addr)).to.eq(FUND - tc(1500)); // the real balance never went below FUND − decoy
      const v2 = await pinOp(acct, () => acct.openPrivateView(token), DURESS);
      expect(await hre.fhevm.userDecryptEuint(FhevmType.euint64, eventArgs(acct, v2.fin, "PrivateOpExecuted").result, addr, owner)).to.eq(tc(500));
    });

    it("a PIN change under the duress PIN changes only the duress fingerprint; the real PIN keeps working", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [], duressPin: DURESS });
      const addr = await acct.getAddress();
      await (await s.token.mint(addr, FUND)).wait();
      const NEW = "246813";
      const fpNew = await fingerprint(NEW, s.chainId, addr);
      const change = async (pin: string) => {
        const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
        inp.add64(fpNew);
        const enc = await inp.encrypt();
        const { id } = await pinOp(acct, () => acct.openPinChange(enc.handles[0], enc.inputProof), pin);
        await time.increase(Number((await acct.delays()).settings) + 1);
        await (await acct.executeOp(id)).wait();
      };
      await change(DURESS);
      const real = await pinOp(acct, () => acct.openPrivateView(token), PIN);
      expect(await hre.fhevm.userDecryptEuint(FhevmType.euint64, eventArgs(acct, real.fin, "PrivateOpExecuted").result, addr, owner)).to.eq(FUND);
      const asDuress = await pinOp(acct, () => acct.openPrivateView(token), NEW);
      expect(await hre.fhevm.userDecryptEuint(FhevmType.euint64, eventArgs(acct, asDuress.fin, "PrivateOpExecuted").result, addr, owner)).to.eq(DECOY);
      // with the real PIN the change lands on the real PIN
      await change(PIN);
      const now = await pinOp(acct, () => acct.openPrivateView(token), NEW);
      expect(await hre.fhevm.userDecryptEuint(FhevmType.euint64, eventArgs(acct, now.fin, "PrivateOpExecuted").result, addr, owner)).to.eq(FUND);
    });

    it("the duress PIN can be set later, and cleared, with the PIN and the settings delay", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [] });
      const addr = await acct.getAddress();
      await (await s.token.mint(addr, FUND)).wait();
      const set = async (use: boolean) => {
        const inp = hre.fhevm.createEncryptedInput(addr, owner.address);
        inp.add64(await fingerprint(DURESS, s.chainId, addr));
        inp.addBool(use);
        inp.add64(DECOY);
        const enc = await inp.encrypt();
        const { id } = await pinOp(acct, () => acct.openSetDuress(token, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof), PIN);
        await time.increase(Number((await acct.delays()).settings) + 1);
        await (await acct.executeOp(id)).wait();
      };
      await set(true);
      const d1 = await pinOp(acct, () => acct.openPrivateView(token), DURESS);
      expect(await hre.fhevm.userDecryptEuint(FhevmType.euint64, eventArgs(acct, d1.fin, "PrivateOpExecuted").result, addr, owner)).to.eq(DECOY);
      await set(false);
      await alignDecay();
      const d2 = await pinOp(acct, () => acct.openPrivateView(token), DURESS);
      expect(eventArgs(acct, d2.fin, "GuessFinalized").ok).to.eq(false);
    });
  });

  describe("guards", () => {
    it("generic calls cannot reach a private token; the hooks cannot be reached from outside; the module refuses direct calls", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address] });
      const unwrap = s.token.interface.encodeFunctionData("setOperator", [owner.address, 2n ** 47n]);
      expect(await rejects(acct.openCall(token, 0, unwrap))).to.eq(true);
      expect(await rejects(acct.privateExecuteOp(1n))).to.eq(true);
      expect(await rejects(acct.privateAfterGuess(1n, true, 0))).to.eq(true);
      expect(await rejects(s.module.connect(owner).openPrivateView(token))).to.eq(true);
    });

    it("a private token gets no public K-only evaluation (no public tau to probe)", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address] });
      const rc = await (await acct.requestTransfer(token, R1.address, 1n, false)).wait();
      expect(eventArgs(acct, rc, "Evaluating")).to.eq(null);
      expect((await acct.getOp(opIdOf(acct, rc))).status).to.eq(BigInt(Status.NeedsPin));
    });
  });

  describe("escape", () => {
    it("ETH and ERC-20 leave with executeEscape (no FHE contract touched); ERC-7984 with executeEscapeConfidential; no PIN, nothing K can stop", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address] });
      const addr = await acct.getAddress();
      await (await s.token.mint(addr, FUND)).wait();
      await owner.sendTransaction({ to: addr, value: E.parseEther("1") });
      await (await s.usdc.mint(addr, 5_000_000n)).wait();
      await (await acct.startEscape()).wait(); // K alone
      const enc = await encAmount(acct, owner, tc(10));
      expect(await rejects(acct.privateTransfer(token, R1.address, enc.handles[0], enc.inputProof))).to.eq(true); // I21
      expect(await rejects(acct.openPrivateView(token))).to.eq(true); // no op opens during an escape
      await time.increase(30 * DAY + 1);
      const e0 = await ethers.provider.getBalance(escape.address);
      const rc = await (await acct.connect(stranger).executeEscape([await s.usdc.getAddress()])).wait();
      expect((await ethers.provider.getBalance(escape.address)) - e0).to.eq(E.parseEther("1"));
      expect(await s.usdc.balanceOf(escape.address)).to.be.gte(5_000_000n);
      const exec = (await acct.executorAddress()).toLowerCase();
      const acl = (await acct.aclAddress()).toLowerCase();
      const rec = await recordTx("executeEscape", rc, new Roles().set(exec, "EXECUTOR").set(acl, "ACL"), await cleartextLayer(exec));
      expect(rec.calls.some((c) => c.endsWith("EXECUTOR") || c.endsWith("ACL"))).to.eq(false);
      const before = await balanceOf(s, escape.address);
      await (await acct.connect(stranger).executeEscapeConfidential([token])).wait();
      expect((await balanceOf(s, escape.address)) - before).to.eq(FUND);
      expect(await balanceOf(s, addr)).to.eq(0n);
      OUT.escape = { executeEscapeTouchesFhe: false, confidentialMoved: FUND };
    });

    it("with the FHE executor down, the ETH / ERC-20 escape still runs; the confidential sweep does not", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address] });
      const addr = await acct.getAddress();
      await (await s.token.mint(addr, FUND)).wait();
      await owner.sendTransaction({ to: addr, value: E.parseEther("0.5") });
      await (await acct.startEscape()).wait();
      await time.increase(30 * DAY + 1);
      const snap = await hre.network.provider.send("evm_snapshot", []);
      const exec = await acct.executorAddress();
      await hre.network.provider.send("hardhat_setCode", [exec, "0x60006000fd"]); // every call reverts: "Zama down"
      const e0 = await ethers.provider.getBalance(escape.address);
      await (await acct.connect(stranger).executeEscape([])).wait();
      expect((await ethers.provider.getBalance(escape.address)) - e0).to.eq(E.parseEther("0.5"));
      expect(await rejects(acct.connect(stranger).executeEscapeConfidential([token]))).to.eq(true);
      await hre.network.provider.send("evm_revert", [snap]);
      OUT.escapeWithExecutorDown = { ethErc20Escape: "ran", confidentialEscape: "reverted" };
    });
  });

  describe("watchtower (SDK)", () => {
    it("tells the owner about a delivery, a silent zero and the tripwire, and restricts the account on the tripwire", async () => {
      const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address] });
      const addr = await acct.getAddress();
      await (await s.token.mint(addr, FUND)).wait();
      const alerts: Alert[] = [];
      const wt = new Watchtower({
        account: acct.connect(guardian) as any,
        publicDecrypt: (hs) => hre.fhevm.publicDecrypt(hs) as any,
        userDecryptBool: (h, c) => hre.fhevm.userDecryptEbool(h, c, guardian),
        userDecryptU64: (h, c) => hre.fhevm.userDecryptEuint(FhevmType.euint64, h, c, guardian),
        notify: (a) => alerts.push(a),
        assets: [],
      });
      await wt.tick();
      const send = async (amount: bigint, to: string) => {
        const enc = await encAmount(acct, owner, amount);
        await (await acct.privateTransfer(token, to, enc.handles[0], enc.inputProof)).wait();
        await wt.tick();
      };
      await send(tc(100), R1.address);
      await send(tc(100), other.address); // unknown recipient
      await send(tc(5000), R1.address); // above the hidden limit
      const kinds = alerts.map((a) => a.kind);
      expect(alerts.find((a) => a.kind === "private-delivered") as any).to.deep.include({ moved: tc(100) });
      expect(alerts.filter((a) => a.kind === "private-silent-zero").length).to.eq(2);
      expect(kinds).to.include("private-tripwire");
      expect((await acct.status()).restrictedReasons & BigInt(R.GUARDIAN)).to.eq(BigInt(R.GUARDIAN));
      expect(alerts.filter((a) => a.kind === "error")).to.deep.eq([]);
      OUT.watchtower = { alerts: alerts.map((a) => a.kind) };
    });
  });
});
