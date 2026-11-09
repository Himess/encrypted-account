import { expect } from "chai";
import { ethers as E } from "ethers";
import * as hre from "hardhat";
import {
  ETH,
  Stack,
  Status,
  createAccount,
  deployStack,
  ethers,
  finalizeEvaluation,
  finalizeGuess,
  fingerprint,
  okBitOf,
} from "./helpers";
import { guessValue } from "../sdk/src";

function packUints(hi: bigint, lo: bigint): string {
  return E.zeroPadValue(E.toBeHex((hi << 128n) | lo), 32);
}

/**
 * F0.2 / E3 / E14: UserOp through a real EntryPoint v0.8 → pending op → PIN flow → execution.
 * No FHE call in the validation phase; encrypted-input context (account, EntryPoint); gas-drain protection.
 */
describe("F0.2 — end to end with ERC-4337 (EntryPoint v0.8)", function () {
  let stack: Stack;
  let ownerW: E.Wallet;
  let bundlerW: any; // raw-signed bundler: the alpha FHEVM plugin's eth_sendTransaction hook segfaults on handleOps
  let bundler: any, escape: any, guardian: any, alice: any, bob: any;

  before(async () => {
    [bundler, escape, guardian, alice, bob] = await ethers.getSigners();
    stack = await deployStack();
    ownerW = E.Wallet.createRandom().connect(ethers.provider) as unknown as E.Wallet;
    await (await bundler.sendTransaction({ to: ownerW.address, value: E.parseEther("5") })).wait();
    bundlerW = E.Wallet.createRandom().connect(ethers.provider);
    await (await bundler.sendTransaction({ to: bundlerW.address, value: E.parseEther("5") })).wait();
  });

  async function userOp(acct: any, callData: string, opts: { paymaster?: boolean; signer?: E.Wallet } = {}) {
    const ep = stack.entryPoint;
    const sender = await acct.getAddress();
    const nonce = await ep.getNonce(sender, 0);
    const fee = (await ethers.provider.getFeeData()).maxFeePerGas ?? 2_000_000_000n;
    const usePm = opts.paymaster ?? true;
    const paymasterAndData = usePm
      ? E.concat([await stack.paymaster.getAddress(), E.zeroPadValue(E.toBeHex(200_000), 16), E.zeroPadValue(E.toBeHex(50_000), 16)])
      : "0x";
    const op: any = {
      sender,
      nonce,
      initCode: "0x",
      callData,
      accountGasLimits: packUints(600_000n, 6_000_000n),
      preVerificationGas: 100_000n,
      gasFees: packUints(fee, fee * 2n),
      paymasterAndData,
      signature: "0x",
    };
    const hash = await ep.getUserOpHash(op);
    op.signature = (opts.signer ?? ownerW).signingKey.sign(hash).serialized;
    return op;
  }

  async function handle(ops: any[]) {
    return await (await stack.entryPoint.connect(bundlerW).handleOps(ops, bundlerW.address, { gasLimit: 15_000_000 })).wait();
  }

  async function freshAA() {
    const acct = await createAccount(stack, ownerW as any, escape.address, guardian.address, { knownRecipients: [alice.address] });
    await bundler.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("3") });
    return acct;
  }

  it("UserOp → K-only transfer (evaluation) → finalize → executes; the account's ETH does not pay for gas", async () => {
    const acct = await freshAA();
    const addr = await acct.getAddress();
    const bal0 = await ethers.provider.getBalance(addr);
    const cd = acct.interface.encodeFunctionData("requestTransfer", [ETH, alice.address, E.parseEther("0.05"), false]);
    const rc = await handle([await userOp(acct, cd)]);
    expect(rc!.status).to.eq(1);
    const opId = await acct.opCount();
    expect((await acct.getOp(opId)).status).to.eq(Status.Evaluating);
    expect(await okBitOf(acct, opId)).to.eq(true);
    await finalizeEvaluation(acct, opId);
    expect(bal0 - (await ethers.provider.getBalance(addr))).to.eq(E.parseEther("0.05")); // transfer only; no gas
  });

  it("E3/M1: PIN guess from inside a UserOp — the encrypted input is generated for the (account, EntryPoint) context", async () => {
    const acct = await freshAA();
    const addr = await acct.getAddress();
    const open = acct.interface.encodeFunctionData("requestTransfer", [ETH, bob.address, E.parseEther("0.2"), true]);
    await handle([await userOp(acct, open)]);
    const opId = await acct.opCount();
    const fp = await fingerprint("482915", stack.chainId, addr);
    const c = BigInt(await acct.challengeOf(opId));
    const inp = hre.fhevm.createEncryptedInput(addr, await stack.entryPoint.getAddress()); // user = msg.sender = EntryPoint
    inp.add64(guessValue(fp, c));
    const enc = await inp.encrypt();
    const g = acct.interface.encodeFunctionData("submitGuess", [opId, c, enc.handles[0], enc.inputProof]);
    await handle([await userOp(acct, g)]);
    await finalizeGuess(acct, opId);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed);

    // an input generated for the wrong context (user = owner EOA) is rejected inside a UserOp
    const op2Data = acct.interface.encodeFunctionData("requestTransfer", [ETH, bob.address, E.parseEther("0.2"), true]);
    await handle([await userOp(acct, op2Data)]);
    const op2 = await acct.opCount();
    const wrong = hre.fhevm.createEncryptedInput(addr, ownerW.address);
    const c2 = BigInt(await acct.challengeOf(op2));
    wrong.add64(guessValue(fp, c2));
    const encW = await wrong.encrypt();
    const g2 = acct.interface.encodeFunctionData("submitGuess", [op2, c2, encW.handles[0], encW.inputProof]);
    const rc = await handle([await userOp(acct, g2)]);
    const failed = rc!.logs
      .map((l: any) => {
        try {
          return stack.entryPoint.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((x: any) => x && x.name === "UserOperationEvent");
    expect(failed[0].args.success).to.eq(false); // execution reverted (context mismatch)
    expect((await acct.getOp(op2)).status).to.eq(Status.NeedsPin);
  });

  it("S19 gas drain: a UserOp without a paymaster fails validation (the account never pays gas with its own ETH)", async () => {
    const acct = await freshAA();
    const cd = acct.interface.encodeFunctionData("requestTransfer", [ETH, alice.address, 1n, false]);
    const op = await userOp(acct, cd, { paymaster: false });
    await expect(stack.entryPoint.connect(bundlerW).handleOps.staticCall([op], bundlerW.address, { gasLimit: 15_000_000 })).to.be.reverted;
  });

  it("a UserOp with a forged signature is rejected", async () => {
    const acct = await freshAA();
    const cd = acct.interface.encodeFunctionData("restrict", []);
    const op = await userOp(acct, cd, { signer: E.Wallet.createRandom() as unknown as E.Wallet });
    await expect(stack.entryPoint.connect(bundlerW).handleOps.staticCall([op], bundlerW.address, { gasLimit: 15_000_000 })).to.be.reverted;
  });

  it("several UserOps with FHE operations in one bundle: transient storage cleanup (cleanTransientStorage) does not break the flow", async () => {
    const a1 = await freshAA();
    const a2 = await freshAA();
    const cd1 = a1.interface.encodeFunctionData("requestTransfer", [ETH, alice.address, E.parseEther("0.01"), false]);
    const cd2 = a2.interface.encodeFunctionData("requestTransfer", [ETH, alice.address, E.parseEther("0.01"), false]);
    const rc = await handle([await userOp(a1, cd1), await userOp(a2, cd2)]);
    expect(rc!.status).to.eq(1);
    expect(await okBitOf(a1, await a1.opCount())).to.eq(true);
    expect(await okBitOf(a2, await a2.opCount())).to.eq(true);
  });
});
