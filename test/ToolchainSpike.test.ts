import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import * as hre from "hardhat";

describe("ToolchainSpike (mock toolchain verification)", function () {
  it("isIn, eq/or, challenge, rand, publicDecrypt+checkSignatures work", async function () {
    const [alice, bob] = await hre.ethers.getSigners();
    const f = await hre.ethers.getContractFactory("ToolchainSpike");
    const c: any = await f.deploy();
    await c.waitForDeployment();
    const addr = await c.getAddress();
    await hre.fhevm.assertCoprocessorInitialized(c, "ToolchainSpike");

    // secret value
    const inp = hre.fhevm.createEncryptedInput(addr, alice.address);
    inp.add64(1234n);
    const enc = await inp.encrypt();
    await (await c.setSecret(enc.handles[0], enc.inputProof)).wait();

    // list: bob + 9 zeros
    const li = hre.fhevm.createEncryptedInput(addr, alice.address);
    li.addAddress(bob.address);
    const le = await li.encrypt();
    await (await c.addToList(le.handles[0], le.inputProof)).wait();
    await (await c.padList(9)).wait();

    const r1 = await (await c.checkIsIn(bob.address)).wait();
    const h1 = hre.fhevm.computeTransactionHCU(r1);
    const bit1 = await hre.fhevm.publicDecryptEbool(await c.lastBit());
    const r2 = await (await c.checkEqOr(bob.address)).wait();
    const h2 = hre.fhevm.computeTransactionHCU(r2);
    const bit2 = await hre.fhevm.publicDecryptEbool(await c.lastBit());
    console.log("isIn HCU:", JSON.stringify(h1, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    console.log("eq/or HCU:", JSON.stringify(h2, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(bit1).to.eq(true);
    expect(bit2).to.eq(true);

    // guess with a challenge
    const cval = 987654321n;
    const g = hre.fhevm.createEncryptedInput(addr, alice.address);
    g.add64((1234n + cval) % (1n << 64n));
    const ge = await g.encrypt();
    await (await c.guessWithChallenge(ge.handles[0], ge.inputProof, cval)).wait();
    const res = await hre.fhevm.publicDecrypt([await c.lastBit()]);
    await (await c.verify(res.abiEncodedClearValues, res.decryptionProof)).wait();
    expect(await c.verifiedValue()).to.eq(true);

    // a forged cleartext must be rejected
    const fake = hre.ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [false]);
    await expect(c.verify(fake, res.decryptionProof)).to.be.reverted;

    // rand (via the debugger)
    await (await c.drawRand()).wait();
    const rv = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await c.lastRand());
    expect(rv < 1n << 16n).to.eq(true);

    // empty proof: someone else's input must be rejected, while a transient permission within the same tx is accepted
    await expect(c.emptyProofProbe(ge.handles[0])).to.be.reverted;
  });
});
