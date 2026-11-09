import { expect } from "chai";
import { ethers as E } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import {
  A,
  DAY,
  ETH,
  HOUR,
  RECORD,
  Stack,
  coder,
  createAccount,
  debugU64,
  deployStack,
  escapeConsent,
  ethers,
  fingerprint,
  finalizeEvaluation,
  finalizeGuess,
  guess,
  opIdFromReceipt,
  requestTransfer,
  time,
} from "./helpers";

/**
 * E9 / E19 / E7 — [Mock] cost model. HCU values come verbatim from the HCU table of the host contracts (v0.13.x cleartext);
 * gas is measured on Hardhat EDR (prague). Gas on Sepolia may differ; latency (E1) cannot be measured here.
 */
interface Row {
  flow: string;
  gas: number;
  hcuTotal: number;
  hcuDepth: number;
  note?: string;
}

const rows: Row[] = [];
function rec(flow: string, rc: any, note?: string) {
  const h = hre.fhevm.computeTransactionHCU(rc);
  rows.push({ flow, gas: Number(rc.gasUsed), hcuTotal: Number(h.globalHCU), hcuDepth: Number(h.maxHCUDepth), note });
}

describe("E9/E19/E7 — cost model [Mock]", function () {
  let stack: Stack;
  let owner: any, escape: any, guardian: any, alice: any, bob: any, stranger: any;
  const PIN = "482915";

  before(async () => {
    [owner, escape, guardian, alice, bob, stranger] = await ethers.getSigners();
    stack = await deployStack();
  });

  after(() => {
    console.table(rows);
    if (!RECORD) return; // results/ is evidence: written only by `npm run test:record`
    const dir = path.join(__dirname, "..", "results");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cost-model-mock.json"), JSON.stringify({ evidence: "[Mock]", generatedAt: new Date().toISOString(), rows }, null, 2));
    const csv = ["flow,gas,hcu_total,hcu_depth,note", ...rows.map((r) => `"${r.flow}",${r.gas},${r.hcuTotal},${r.hcuDepth},"${r.note ?? ""}"`)].join("\n");
    fs.writeFileSync(path.join(dir, "cost-model-mock.csv"), csv + "\n");
  });

  it("gas and HCU per flow (setup, K-only transfer, PIN, execution, settings)", async () => {
    // start 10 min into a UTC epoch: the measured flows then never straddle an epoch roll, whatever the wall clock says
    await time.increaseTo((Math.floor((await time.latest()) / DAY) + 1) * DAY + 600);
    const d = { ...(await stack.factory.defaultDelays()).toObject() };
    const salt = E.id("cost");
    const addr = await stack.factory.predictAddress(owner.address, escape.address, guardian.address, d, salt);
    const escSig = await escapeConsent(escape, stack.chainId, addr, 0);
    rec(
      "factory.createAccount (clone + initialize + E_addr EIP-712 consent)",
      await (await stack.factory.createAccountWithDelays(owner.address, escape.address, guardian.address, d, salt, escSig)).wait(),
    );
    const acct: any = await ethers.getContractAt("EncryptedAccount", addr);

    const fp = await fingerprint(PIN, stack.chainId, addr);
    let inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.add64(fp);
    inp.add64(42n);
    inp.addBool(false);
    let enc = await inp.encrypt();
    rec("setupPin (fingerprint + duress slot select/rand)", await (await acct.connect(owner).setupPin(enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait());

    inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.add64(100_000n);
    inp.add64(300_000n);
    inp.add64(3_000_000n);
    enc = await inp.encrypt();
    rec("setupAsset (L_min, L, L_big + τ draw)", await (await acct.connect(owner).setupAsset(ETH, 10n ** 12n, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait());
    inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.add64(300_000_000n);
    inp.add64(1_000_000_000n);
    inp.add64(10_000_000_000n);
    enc = await inp.encrypt();
    await (await acct.connect(owner).setupAsset(await stack.usdc.getAddress(), 1n, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait();

    const all = [...Array(28).fill(E.ZeroAddress), alice.address, stranger.address];
    for (let s = 0; s < 30; s += 12) {
      const chunk = all.slice(s, s + 12);
      inp = hre.fhevm.createEncryptedInput(addr, owner.address);
      chunk.forEach((a) => inp.addAddress(a));
      enc = await inp.encrypt();
      const rc = await (await acct.connect(owner).setupKnown(false, s, enc.handles, enc.inputProof)).wait();
      if (s === 0) rec("setupKnown (12 eaddress / proof)", rc, "2048-bit CRS limit: at most 12 eaddress");
    }
    inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    for (let i = 0; i < 10; i++) inp.addAddress(i === 9 ? alice.address : E.ZeroAddress);
    enc = await inp.encrypt();
    await (await acct.connect(owner).setupKnown(true, 0, enc.handles, enc.inputProof)).wait();
    await (await acct.connect(owner).setupRoles(E.ZeroAddress, E.ZeroAddress, 90 * DAY, true)).wait();
    rec("arm", await (await acct.connect(owner).arm()).wait());
    await owner.sendTransaction({ to: addr, value: E.parseEther("10") });

    // K-only transfer
    let rc = await (await acct.connect(owner).requestTransfer(ETH, alice.address, E.parseEther("0.05"), false)).wait();
    rec("requestTransfer K-only (isIn N=30 + threshold + sticky tripwire)", rc);
    let opId = await opIdFromReceipt(acct, rc);
    rec("finalizeEvaluation (KMS proof + transfer)", await finalizeEvaluation(acct, opId));

    // PIN path transfer
    rc = await (await acct.connect(owner).requestTransfer(ETH, bob.address, E.parseEther("0.5"), true)).wait();
    rec("requestTransfer PIN path (opens op)", rc);
    opId = await opIdFromReceipt(acct, rc);
    rec("submitGuess (transfer; okAny + isDuress + big)", await guess(acct, owner, stack.chainId, opId, PIN));
    rec("finalizeGuess (2-handle KMS proof)", await finalizeGuess(acct, opId));
    await time.increase(HOUR);
    rec("executeOp transfer (+ auto-add to known list: isIn + select)", await (await acct.executeOp(opId)).wait());

    // admin op guess (no big)
    rc = await (await acct.connect(owner).openAdmin(A.RESET_TRIP, coder.encode(["address"], [ETH]))).wait();
    opId = await opIdFromReceipt(acct, rc);
    rec("submitGuess (admin; okAny + isDuress)", await guess(acct, owner, stack.chainId, opId, PIN));
    rec("finalizeGuess + resetTrip (τ redrawn)", await finalizeGuess(acct, opId));

    // tighten & remove
    inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.add64(200_000n);
    inp.add64(2_000_000n);
    enc = await inp.encrypt();
    rec("tightenLimits (K-only; 4× min)", await (await acct.connect(owner).tightenLimits(ETH, enc.handles[0], enc.handles[1], enc.inputProof)).wait());
    inp = hre.fhevm.createEncryptedInput(addr, owner.address);
    inp.addBool(false);
    enc = await inp.encrypt();
    rec("removeKnown (K-only; select)", await (await acct.connect(owner).removeKnown(false, 0, enc.handles[0], enc.inputProof)).wait());
    rec("startEscape (no FHE)", await (await acct.connect(owner).startEscape()).wait());
    await time.increase(30 * DAY);
    rec("executeEscape (no FHE; ETH + 1 token)", await (await acct.executeEscape([await stack.usdc.getAddress()])).wait());
    void requestTransfer;
  });

  it("E19: known list — FHE.isIn compared with N eq + (N−1) or", async () => {
    const b: any = await (await ethers.getContractFactory("Bench")).deploy();
    await (await b.fillList(64)).wait();
    for (const n of [8, 10, 16, 30, 32, 60]) {
      rec(`isIn N=${n}`, await (await b.isInBench(alice.address, n)).wait());
      if (n <= 32) {
        rec(`eq+or linear N=${n}`, await (await b.eqOrBench(alice.address, n)).wait());
        rec(`eq+or tree N=${n}`, await (await b.eqOrTreeBench(alice.address, n)).wait());
      }
    }
    // isIn: at most 60 elements for 64-bit and wider types (executor limit)
    await expect(b.isInBench(alice.address, 61)).to.be.reverted;
    const isIn30 = rows.find((r) => r.flow === "isIn N=30")!;
    const eq30 = rows.find((r) => r.flow === "eq+or linear N=30")!;
    expect(eq30.hcuTotal / isIn30.hcuTotal).to.be.greaterThan(5);
  });

  it("E7: τ draws fall within [L_min, L] and are roughly uniform (256 draws, 8 buckets, chi-square)", async () => {
    const b: any = await (await ethers.getContractFactory("Bench")).deploy();
    const lo = 100_000n;
    const hi = 300_000n;
    await (await b.setBounds(lo, hi)).wait();
    // 16 draws in one tx ≈ 15.6M HCU (close to the 20M cap): once for the measurement; batches of 4 for the distribution.
    rec("τ draw ×16 (one tx)", await (await b.drawTau(16)).wait(), "per draw ≈ HCU/16");
    for (let i = 0; i < 60; i++) await (await b.drawTau(4)).wait();
    const n = Number(await b.tausLength());
    const buckets = new Array(8).fill(0);
    for (let i = 0; i < n; i++) {
      const t = await debugU64(await b.tauAt(i));
      expect(t >= lo && t <= hi).to.eq(true);
      buckets[Math.min(7, Number(((t - lo) * 8n) / (hi - lo)))]++;
    }
    const exp = n / 8;
    const chi2 = buckets.reduce((s, o) => s + ((o - exp) * (o - exp)) / exp, 0);
    rows.push({ flow: `τ distribution: buckets ${buckets.join("/")}`, gas: 0, hcuTotal: 0, hcuDepth: 0, note: `χ²=${chi2.toFixed(2)} (df=7, p=0.001 threshold 24.32)` });
    expect(chi2).to.be.lessThan(24.32);
  });
});
