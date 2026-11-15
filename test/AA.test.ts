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

  function userOpSucceeded(rc: any): boolean {
    const ev = rc!.logs
      .map((l: any) => {
        try {
          return stack.entryPoint.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((x: any) => x && x.name === "UserOperationEvent");
    return ev[0].args.success;
  }

  async function encFor(acct: any, user: string, opId: bigint) {
    const addr = await acct.getAddress();
    const fp = await fingerprint("482915", stack.chainId, addr);
    const c = BigInt(await acct.challengeOf(opId));
    const inp = hre.fhevm.createEncryptedInput(addr, user);
    inp.add64(guessValue(fp, c));
    return { enc: await inp.encrypt(), c };
  }

  it("F0.16: a K-track guess inside a UserOp fails (a bond can never come from the account) and is not counted", async () => {
    const acct = await freshAA();
    const open = acct.interface.encodeFunctionData("requestTransfer", [ETH, bob.address, E.parseEther("0.2"), true]);
    await handle([await userOp(acct, open)]);
    const opId = await acct.opCount();
    const { enc, c } = await encFor(acct, await stack.entryPoint.getAddress(), opId);
    const g = acct.interface.encodeFunctionData("submitGuess", [opId, c, enc.handles[0], enc.inputProof]);
    expect(userOpSucceeded(await handle([await userOp(acct, g)]))).to.eq(false); // DirectBondRequired
    expect((await acct.getOp(opId)).status).to.eq(Status.NeedsPin);
    expect((await acct.trackState(0)).score).to.eq(0n);

    // the same op continues with a direct, bonded guess from K's EOA (input context: the owner EOA)
    const direct = await encFor(acct, ownerW.address, opId);
    const [required] = await acct.ownerBond();
    await (await acct.connect(ownerW).submitGuess(opId, direct.c, direct.enc.handles[0], direct.enc.inputProof, { value: required })).wait();
    await finalizeGuess(acct, opId);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed);
    expect(await acct.refundOf(ownerW.address)).to.eq(required);
  });

  it("E3/M1 on the lane: a PIN guess inside a UserOp uses the (account, EntryPoint) input context; the lane stays unbonded", async () => {
    const helperW = E.Wallet.createRandom();
    const acct = await createAccount(stack, ownerW as any, escape.address, guardian.address, {
      knownRecipients: [alice.address],
      helper: helperW.address,
    });
    await bundler.sendTransaction({ to: await acct.getAddress(), value: E.parseEther("3") });
    const addr = await acct.getAddress();
    const laneSig = async (opId: bigint, handle: string) =>
      helperW.signMessage(
        E.getBytes(
          E.keccak256(
            E.AbiCoder.defaultAbiCoder().encode(
              ["bytes32", "uint256", "address", "bytes32"],
              [E.id("encrypted-account/lane/v1"), stack.chainId, addr, E.keccak256(E.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32"], [opId, handle]))],
            ),
          ),
        ),
      );
    const open = acct.interface.encodeFunctionData("requestTransfer", [ETH, bob.address, E.parseEther("0.2"), true]);
    await handle([await userOp(acct, open)]);
    const opId = await acct.opCount();
    const { enc, c } = await encFor(acct, await stack.entryPoint.getAddress(), opId); // user = msg.sender = EntryPoint
    const g = acct.interface.encodeFunctionData("submitGuessWithCosign", [opId, c, enc.handles[0], enc.inputProof, await laneSig(opId, enc.handles[0])]);
    expect(userOpSucceeded(await handle([await userOp(acct, g)]))).to.eq(true);
    await finalizeGuess(acct, opId);
    expect((await acct.getOp(opId)).status).to.eq(Status.Delayed);

    // an input generated for the wrong context (user = owner EOA) is rejected inside a UserOp
    await handle([await userOp(acct, open)]);
    const op2 = await acct.opCount();
    const w = await encFor(acct, ownerW.address, op2);
    const g2 = acct.interface.encodeFunctionData("submitGuessWithCosign", [op2, w.c, w.enc.handles[0], w.enc.inputProof, await laneSig(op2, w.enc.handles[0])]);
    expect(userOpSucceeded(await handle([await userOp(acct, g2)]))).to.eq(false); // execution reverted (context mismatch)
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
