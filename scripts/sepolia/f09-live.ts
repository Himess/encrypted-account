/**
 * F0.9 step 6 — live checks (Sepolia, Round 1 code):
 *   A. isIn: does it work with 60 elements and revert at 61 (Bench)
 *   B. fromExternal with an empty proof: the mock behaviour on our own test contract (someone else's handle is rejected; a zero handle
 *      is an encrypted 0 without a proof) + live confirmation of I1 (naive verifier: self-call + empty proof → ok = 1 without knowing
 *      the PIN; rejected without a self-call) + EncryptedAccount rejecting the empty proof with EmptyInputProof
 *   C. AA (E3, live): the real EntryPoint v0.8 + our own bundler wallet (watchtower) + a test paymaster:
 *      UserOp → pending op → PIN guess via UserOp (input context: account, EntryPoint) → finalize → execution;
 *      an input with the wrong context is rejected inside the UserOp; UserOps without a paymaster or with a forged signature fail validation (eth_call)
 *   D. admin path + K-only settings (cost rows): RESET_TRIP (K+P, τ redrawn), tightenLimits, removeKnown
 *   E. escape: start → execute with a short test delay; is it FHE-free (no executor events), funds go only to E_addr
 *   F. HCU: per transaction, the HCU computed from events + a live HCULimit.getBlockMeter read
 * No transactions are sent to third-party contracts; EntryPoint v0.8 is the infrastructure the work package (F0.8.5, F0.9.6) requires.
 *
 *   npx hardhat run scripts/sepolia/f09-live.ts      → results/sepolia/live-checks.json (written after every step)
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { guessValue, pinFingerprint } from "../../sdk/src";
import { contractAt, decodeRevert, errorInterface } from "../lib/deploy";
import { ROOT } from "../lib/env";
import { LiveCtx, clearValueBool, encryptTimed, makeLiveCtx, publicDecryptWhenReady, writeJson } from "../lib/live";
import { ENTRYPOINT_V08, InsufficientFunds, eth, sleep } from "../lib/net";
import {
  AMOUNT,
  CHAIN_ID,
  ETH,
  TEST_PIN,
  TxRec,
  ZERO32,
  executorLogCount,
  hcuOf,
  iso,
  loadF09,
  now,
  parseEvent,
  readAt,
  readJson,
  requireBalance,
  send,
  sendExpectRevert,
} from "./f09-lib";

type Item = { tx: TxRec; receipt: ethers.TransactionReceipt };
let ERR: ethers.Interface;
const why = (e: any) => (ERR ? decodeRevert(ERR, e) : String(e?.shortMessage ?? e?.message ?? e)).slice(0, 300);

const packUints = (hi: bigint, lo: bigint) => ethers.zeroPadValue(ethers.toBeHex((hi << 128n) | lo), 32);

async function withHcu(ctx: LiveCtx, it: Item): Promise<TxRec> {
  it.tx.hcu = await hcuOf(ctx.provider, it.receipt);
  return it.tx;
}

async function staticRevert(fn: () => Promise<unknown>): Promise<{ reverted: boolean; reason: string }> {
  try {
    await fn();
    return { reverted: false, reason: "" };
  } catch (e: any) {
    return { reverted: true, reason: why(e) };
  }
}

/**
 * Revert check with an eth_call pinned to a given block. Only errors that carry revert data
 * count as "reverted"; if the backend has not seen the block yet (header not found etc.) it is retried.
 */
async function staticRevertAt(fn: (o: { blockTag: number }) => Promise<unknown>, blockTag: number): Promise<{ reverted: boolean; reason: string; blockTag: number }> {
  let last = "";
  for (let k = 0; k < 8; k++) {
    try {
      await fn({ blockTag });
      return { reverted: false, reason: "", blockTag };
    } catch (e: any) {
      const data: string | undefined = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
      if (typeof data === "string" && data.length >= 10) return { reverted: true, reason: why(e), blockTag };
      if (/revert/i.test(String(e?.shortMessage ?? e?.message)) && !/header|not found|missing|timeout/i.test(String(e?.message))) return { reverted: true, reason: why(e), blockTag };
      last = String(e?.shortMessage ?? e?.message ?? e).slice(0, 120);
      await sleep(1000);
    }
  }
  return { reverted: true, reason: `inconclusive: ${last}`, blockTag };
}

async function main() {
  const ctx = await makeLiveCtx();
  const { provider, user, watchtower, build } = ctx;
  if (!watchtower) throw new Error("no watchtower key");
  ERR = errorInterface(build, ["EncryptedAccount", "PinLib", "PolicyLib", "OpsLib", "OpenLib", "ToolchainSpike"]);
  // SenderNotAllowedToUseHandle(bytes32,address) is defined in FHE.sol; add it so it can be decoded
  ERR = new ethers.Interface([...ERR.fragments, "error SenderNotAllowedToUseHandle(bytes32 handle, address sender)", "error FailedOp(uint256 opIndex, string reason)", "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)"]);
  const st = loadF09();
  const C = st.contracts ?? {};
  const live = st.accounts?.live;
  if (!live || !C.Bench || !C.NaivePinVerifier || !C.TestPaymaster || !st.spike) throw new Error("preparation incomplete (run f09-prepare first)");
  await requireBalance(provider, user, 30_000_000n, "F0.9 live checks (user)");
  await requireBalance(provider, watchtower, 20_000_000n, "F0.9 live checks (watchtower)");

  const out: any = readJson("live-checks.json") ?? { evidence: "[M] Sepolia", startedAtUtc: iso(), checks: {} };
  const save = () => {
    out.updatedAtUtc = iso();
    writeJson("live-checks.json", out);
  };
  const has = (k: string) => out.checks[k]?.done === true;
  const log = (s: string) => console.log(s);

  // ───────────── A. isIn 60/61
  if (!has("isIn")) {
    const bench = contractAt(build, "Bench", C.Bench, user);
    const r: any = { done: false };
    const fill = await send(user, "Bench.fillList(64)", () => bench.fillList.populateTransaction(64));
    r.fillList = await withHcu(ctx, fill);
    const who = st.knownHot!;
    const ok60 = await send(user, "Bench.isInBench(60)", () => bench.isInBench.populateTransaction(who, 60));
    r.isIn60 = await withHcu(ctx, ok60);
    r.isIn30 = await withHcu(ctx, await send(user, "Bench.isInBench(30)", () => bench.isInBench.populateTransaction(who, 30)));
    r.isIn61Static = await staticRevert(() => bench.isInBench.staticCall(who, 61));
    const bad = await sendExpectRevert(user, "Bench.isInBench(61) (expected to revert)", () => bench.isInBench.populateTransaction(who, 61), 3_000_000n);
    r.isIn61Tx = bad.tx;
    r.pass = ok60.receipt.status === 1 && bad.reverted && r.isIn61Static.reverted;
    r.done = true;
    out.checks.isIn = r;
    save();
    log(`A isIn: 60 → ${ok60.receipt.status === 1 ? "worked" : "ERROR"} (gas ${ok60.tx.gasUsed}, HCU ${r.isIn60.hcu?.total}); 61 → ${bad.reverted ? "reverted" : "DID NOT REVERT"} (${r.isIn61Static.reason})`);
  }

  // ───────────── B. empty proof
  if (!has("emptyProof")) {
    const r: any = { done: false };
    const spike = contractAt(build, "ToolchainSpike", st.spike, user);
    const secretH: string = await spike.secret();
    // B1: someone else's handle (the contract's own), EOA caller → must be rejected (the behaviour in the mock test)
    r.spikeForeignHandleStatic = await staticRevert(() => spike.emptyProofProbe.staticCall(secretH));
    const b1 = await sendExpectRevert(user, "Spike.emptyProofProbe(someone else's handle)", () => spike.emptyProofProbe.populateTransaction(secretH), 300_000n);
    r.spikeForeignHandleTx = b1.tx;
    // B2: zero handle → encrypted 0 without a proof (TrivialEncrypt)
    let zeroRet = "";
    try {
      zeroRet = await spike.emptyProofProbe.staticCall(ZERO32);
    } catch (e) {
      zeroRet = "reverted: " + why(e);
    }
    r.spikeZeroHandleStaticReturn = zeroRet;
    const b2 = await send(user, "Spike.emptyProofProbe(0)", () => spike.emptyProofProbe.populateTransaction(ZERO32), { gasLimit: 400_000n });
    r.spikeZeroHandleTx = await withHcu(ctx, b2);
    r.spikeZeroHandleTrivialEncrypts = executorLogCount(b2.receipt);

    // B3: I1 live — naive verifier (our own deliberately vulnerable test contract)
    const naiveArt = JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts", "contracts", "test", "NaivePinVerifier.sol", "NaivePinVerifier.json"), "utf8"));
    const naive = new ethers.Contract(C.NaivePinVerifier, naiveArt.abi, user);
    const naiveW = naive.connect(watchtower) as any; // "attacker" role: a separate wallet that does not know the PIN
    if ((await naive.pinH()) === ZERO32) {
      const fp = await pinFingerprint(TEST_PIN, CHAIN_ID, C.NaivePinVerifier);
      const enc = await encryptTimed(ctx, [{ type: "euint64", value: fp }], C.NaivePinVerifier, user.address);
      r.naiveSetPin = await withHcu(ctx, await send(user, "Naive.setPin", () => naive.setPin.populateTransaction(enc.handles[0], enc.inputProof)));
    }
    const opA = BigInt(Date.now()); // unique op id
    const cA = 987654321n;
    r.naiveOpenOp = await withHcu(ctx, await send(user, "Naive.openOp (Enc(pinH + c) stored)", () => naive.openOp.populateTransaction(opA, cA)));
    const expectedH: string = await readAt((o) => naive.expected(opA, o), r.naiveOpenOp.blockNumber);
    // attacker: execute(naive, submitGuess(op, expectedHandle, "0x")) — self-call, empty proof
    const data = naive.interface.encodeFunctionData("submitGuess", [opA, expectedH, "0x"]);
    const exploit = await send(watchtower, "I1: Naive.execute(self, submitGuess(handle, empty proof))", () => naiveW.execute.populateTransaction(C.NaivePinVerifier, data));
    r.naiveExploitTx = await withHcu(ctx, exploit);
    const lastOk: string = await readAt((o) => naive.lastOk(o), exploit.receipt.blockNumber);
    const dec = await publicDecryptWhenReady(ctx, [lastOk]);
    r.naiveExploitOk = clearValueBool(dec.clearValues[0]);
    // 1C: without a self-call (EOA directly) → must be rejected
    const opC = opA + 1n;
    r.naiveOpenOp2 = await withHcu(ctx, await send(user, "Naive.openOp #2", () => naive.openOp.populateTransaction(opC, 5n)));
    const hC: string = await readAt((o) => naive.expected(opC, o), r.naiveOpenOp2.blockNumber);
    r.naiveDirectStatic = await staticRevertAt((o) => naiveW.submitGuess.staticCall(opC, hC, "0x", o), r.naiveOpenOp2.blockNumber);
    const direct = await sendExpectRevert(watchtower, "Naive.submitGuess direct (empty proof, no self-call)", () => naiveW.submitGuess.populateTransaction(opC, hC, "0x"), 400_000n);
    r.naiveDirectTx = direct.tx;

    // B4: EncryptedAccount — an empty proof is rejected with EmptyInputProof
    const acct = contractAt(build, "EncryptedAccount", live.address, user);
    const open = await send(user, "live requestTransfer (PIN path, for the empty-proof attempt)", () =>
      acct.requestTransfer.populateTransaction(ETH, ethers.Wallet.createRandom().address, AMOUNT, true),
    );
    r.accountOpenTx = await withHcu(ctx, open);
    const opId: bigint = parseEvent(acct, open.receipt, "OpOpened")!.args.opId;
    const pinH: string = (await acct.encryptedHandles(ETH))[0];
    r.accountEmptyProofStatic = await staticRevertAt((o) => acct.submitGuess.staticCall(opId, pinH, "0x", o), open.receipt.blockNumber);
    const e4 = await sendExpectRevert(user, "live submitGuess(pinH, empty proof)", () => acct.submitGuess.populateTransaction(opId, pinH, "0x"), 500_000n);
    r.accountEmptyProofTx = e4.tx;
    r.accountOpAfter = Number((await readAt<any>((o) => acct.getOp(opId, o), e4.receipt.blockNumber)).status); // 2 = NeedsPin (unchanged; the op stays open, harmless)

    r.pass =
      r.spikeForeignHandleStatic.reverted &&
      b1.reverted &&
      !String(r.spikeZeroHandleStaticReturn).startsWith("reverted") &&
      r.naiveExploitOk === true &&
      r.naiveDirectStatic.reverted &&
      direct.reverted &&
      r.accountEmptyProofStatic.reverted &&
      /EmptyInputProof/.test(r.accountEmptyProofStatic.reason) &&
      e4.reverted;
    r.done = true;
    out.checks.emptyProof = r;
    save();
    log(
      `B empty proof: spike someone else's handle → ${r.spikeForeignHandleStatic.reason}; zero handle → ${String(zeroRet).slice(0, 18)}…; ` +
        `I1 naive self-call → ok=${r.naiveExploitOk}; direct → ${r.naiveDirectStatic.reason}; account → ${r.accountEmptyProofStatic.reason}`,
    );
  }

  // ───────────── C. AA (E3 live)
  if (!has("aa")) {
    const r: any = { done: false, bundler: watchtower.address, entryPoint: ENTRYPOINT_V08, paymaster: C.TestPaymaster };
    const epArt = JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts", "@account-abstraction", "contracts", "core", "EntryPoint.sol", "EntryPoint.json"), "utf8"));
    const ep = new ethers.Contract(ENTRYPOINT_V08, epArt.abi, provider);
    const epW = ep.connect(watchtower) as any;
    ERR = new ethers.Interface([...ERR.fragments, ...epArt.abi.filter((f: any) => f.type === "error" && !["FailedOp", "FailedOpWithRevert"].includes(f.name))]);
    const acct = contractAt(build, "EncryptedAccount", live.address, user);
    const acctW = contractAt(build, "EncryptedAccount", live.address, watchtower);
    const pm = contractAt(build, "TestPaymaster", C.TestPaymaster, user);
    const fee = await provider.getFeeData();
    const maxFee = (fee.maxFeePerGas ?? 1_000_000_000n) * 2n;
    const prio = fee.maxPriorityFeePerGas ?? 50_000_000n;
    const VGL = 400_000n;
    const CGL = 4_000_000n;
    const PVG = 120_000n;
    const PM_V = 120_000n;
    const PM_P = 60_000n;
    const maxCost = (VGL + CGL + PVG + PM_V + PM_P) * maxFee;
    const dep: bigint = await ep.balanceOf(C.TestPaymaster);
    const want = ethers.parseEther("0.0006") > (maxCost * 3n) / 2n ? ethers.parseEther("0.0006") : (maxCost * 3n) / 2n;
    let depBlock = await provider.getBlockNumber();
    if (dep < want) {
      r.paymasterDeposit = await withHcu(ctx, await send(user, `paymaster deposit ${eth(want - dep)} ETH`, () => pm.deposit.populateTransaction({ value: want - dep })));
      depBlock = r.paymasterDeposit.blockNumber;
    }
    r.paymasterDepositWei = (await readAt<bigint>((o) => ep.balanceOf(C.TestPaymaster, o), depBlock)).toString();
    r.maxCostWei = maxCost.toString();

    let lastBlock = await provider.getBlockNumber();
    const mkOp = async (callData: string, o: { paymaster?: boolean; badSig?: boolean } = {}) => {
      const nonce: bigint = await readAt((ov) => ep.getNonce(live.address, 0, ov), lastBlock);
      const op: any = {
        sender: live.address,
        nonce,
        initCode: "0x",
        callData,
        accountGasLimits: packUints(VGL, CGL),
        preVerificationGas: PVG,
        gasFees: packUints(prio, maxFee),
        paymasterAndData: o.paymaster === false ? "0x" : ethers.concat([C.TestPaymaster, ethers.zeroPadValue(ethers.toBeHex(PM_V), 16), ethers.zeroPadValue(ethers.toBeHex(PM_P), 16)]),
        signature: "0x",
      };
      const hash: string = await ep.getUserOpHash(op);
      op.signature = (o.badSig ? ethers.Wallet.createRandom().signingKey : user.signingKey).sign(hash).serialized; // K signs (the key is never printed)
      return { op, hash };
    };
    const handle = async (label: string, op: any) => {
      const res = await send(watchtower, label, () => epW.handleOps.populateTransaction([op], watchtower.address), { gasMult: 150n });
      lastBlock = res.receipt.blockNumber;
      const evs = res.receipt.logs
        .filter((l) => l.address.toLowerCase() === ENTRYPOINT_V08.toLowerCase())
        .map((l) => {
          try {
            return ep.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean) as ethers.LogDescription[];
      const uo = evs.find((e) => e.name === "UserOperationEvent");
      const rr = evs.find((e) => e.name === "UserOperationRevertReason");
      let revertReason: string | null = null;
      if (rr) {
        try {
          revertReason = ERR.parseError(rr.args.revertReason)?.name ?? String(rr.args.revertReason).slice(0, 10);
        } catch {
          revertReason = String(rr.args.revertReason).slice(0, 10);
        }
      }
      return { res, success: uo ? Boolean(uo.args.success) : null, actualGasUsed: uo ? uo.args.actualGasUsed.toString() : null, actualGasCost: uo ? uo.args.actualGasCost.toString() : null, revertReason };
    };

    // C1: UserOp → open a PIN-path op
    const to = ethers.Wallet.createRandom().address;
    const tA0 = now();
    const u1 = await mkOp(acct.interface.encodeFunctionData("requestTransfer", [ETH, to, AMOUNT, true]));
    const h1 = await handle("AA UserOp: requestTransfer (PIN path)", u1.op);
    const opId: bigint = parseEvent(acct, h1.res.receipt, "OpOpened")!.args.opId;
    r.openViaUserOp = { tx: await withHcu(ctx, h1.res), success: h1.success, actualGasUsed: h1.actualGasUsed, actualGasCost: h1.actualGasCost, userOpHash: u1.hash, opId: opId.toString() };

    // C2: PIN guess from inside a UserOp; input context (account, EntryPoint)
    const tP0 = now();
    const fp = await pinFingerprint(TEST_PIN, CHAIN_ID, live.address);
    const c = BigInt(await readAt((o) => acct.challengeOf(opId, o), h1.res.receipt.blockNumber));
    const enc = await encryptTimed(ctx, [{ type: "euint64", value: guessValue(fp, c) }], live.address, ENTRYPOINT_V08);
    const u2 = await mkOp(acct.interface.encodeFunctionData("submitGuess", [opId, enc.handles[0], enc.inputProof]));
    const h2 = await handle("AA UserOp: submitGuess (context: account, EntryPoint)", u2.op);
    const tSub = now();
    const g = parseEvent(acct, h2.res.receipt, "GuessSubmitted");
    r.guessViaUserOp = { tx: await withHcu(ctx, h2.res), success: h2.success, actualGasUsed: h2.actualGasUsed, actualGasCost: h2.actualGasCost, revertReason: h2.revertReason, userOpHash: u2.hash, encrypt: enc.timing };
    if (!g) throw new Error(`AA guess did not execute: ${h2.revertReason}`);
    const hs = g.args.bigHandle === ZERO32 ? [g.args.okHandle] : [g.args.okHandle, g.args.bigHandle];
    const dec = await publicDecryptWhenReady(ctx, hs);
    const tDec = now();
    const fin = await send(watchtower, "AA: finalizeGuess (watchtower)", () => acctW.finalizeGuess.populateTransaction(opId, dec.abiEncodedClearValues, dec.decryptionProof));
    const tFin = now();
    r.finalize = await withHcu(ctx, fin);
    r.pinOk = Boolean(parseEvent(acct, fin.receipt, "GuessFinalized")?.args.ok);
    const balTo0 = await provider.getBalance(to, fin.receipt.blockNumber);
    const ex = await send(watchtower, "AA: executeOp (watchtower)", () => acctW.executeOp.populateTransaction(opId));
    r.execute = await withHcu(ctx, ex);
    r.executed = Boolean(parseEvent(acct, ex.receipt, "OpExecuted")) && (await readAt((o) => provider.getBalance(to, o.blockTag), ex.receipt.blockNumber)) - balTo0 === AMOUNT;
    r.timing = { pinEntryToFinalizeMs: Math.round(tFin - tP0), submitViaBundlerMs: Math.round(tSub - tP0), decryptMs: Math.round(tDec - tSub), finalizeMs: Math.round(tFin - tDec), totalFromFirstUserOpMs: Math.round(tFin - tA0) };

    // C3: an input produced with the wrong context (user = owner EOA) is rejected inside the UserOp
    const u3open = await mkOp(acct.interface.encodeFunctionData("requestTransfer", [ETH, to, AMOUNT, true]));
    const h3open = await handle("AA UserOp: requestTransfer #2", u3open.op);
    const op2: bigint = parseEvent(acct, h3open.res.receipt, "OpOpened")!.args.opId;
    const encWrong = await encryptTimed(ctx, [{ type: "euint64", value: guessValue(fp, BigInt(await readAt((o) => acct.challengeOf(op2, o), h3open.res.receipt.blockNumber))) }], live.address, user.address);
    const u3 = await mkOp(acct.interface.encodeFunctionData("submitGuess", [op2, encWrong.handles[0], encWrong.inputProof]));
    const h3 = await handle("AA UserOp: submitGuess wrong context (account, EOA)", u3.op);
    r.wrongContext = {
      open: await withHcu(ctx, h3open.res),
      tx: await withHcu(ctx, h3.res),
      userOpSuccess: h3.success,
      revertReason: h3.revertReason,
      opStatusAfter: Number((await readAt<any>((o) => acct.getOp(op2, o), h3.res.receipt.blockNumber)).status),
    };

    // C4: UserOp without a paymaster (S19 gas draining) and with a forged signature → rejected in validation (eth_call)
    const u4 = await mkOp(acct.interface.encodeFunctionData("requestTransfer", [ETH, st.knownHot, 1n, false]), { paymaster: false });
    r.noPaymasterStatic = await staticRevert(() => epW.handleOps.staticCall([u4.op], watchtower.address, { gasLimit: 8_000_000n }));
    const u5 = await mkOp(acct.interface.encodeFunctionData("restrict", []), { badSig: true });
    r.badSigStatic = await staticRevert(() => epW.handleOps.staticCall([u5.op], watchtower.address, { gasLimit: 8_000_000n }));

    r.pass =
      h1.success === true &&
      h2.success === true &&
      r.pinOk &&
      r.executed &&
      h3.success === false &&
      r.wrongContext.opStatusAfter === 2 &&
      r.noPaymasterStatic.reverted &&
      r.badSigStatic.reverted;
    r.done = true;
    out.checks.aa = r;
    save();
    log(
      `C AA: open ${h1.success}, guess ${h2.success}, PIN ok ${r.pinOk}, executed ${r.executed}; wrong context → success=${h3.success} (${h3.revertReason}); ` +
        `no paymaster → ${r.noPaymasterStatic.reason}; forged signature → ${r.badSigStatic.reason}`,
    );
  }

  // ───────────── D. admin path and K-only settings (cost rows)
  if (!has("admin")) {
    const r: any = { done: false };
    const acct = contractAt(build, "EncryptedAccount", live.address, user);
    const acctW = contractAt(build, "EncryptedAccount", live.address, watchtower);
    const open = await send(user, "live openAdmin(RESET_TRIP)", () => acct.openAdmin.populateTransaction(7, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [ETH])));
    r.openAdmin = await withHcu(ctx, open);
    const opId: bigint = parseEvent(acct, open.receipt, "OpOpened")!.args.opId;
    const fp = await pinFingerprint(TEST_PIN, CHAIN_ID, live.address);
    const enc = await encryptTimed(ctx, [{ type: "euint64", value: guessValue(fp, BigInt(await readAt((o) => acct.challengeOf(opId, o), open.receipt.blockNumber))) }], live.address, user.address);
    const sub = await send(user, "live submitGuess (admin; okAny + isDuress)", () => acct.submitGuess.populateTransaction(opId, enc.handles[0], enc.inputProof));
    r.submitGuessAdmin = await withHcu(ctx, sub);
    const g = parseEvent(acct, sub.receipt, "GuessSubmitted")!;
    const dec = await publicDecryptWhenReady(ctx, [g.args.okHandle]);
    const fin = await send(watchtower, "live finalizeGuess + resetTrip (τ redrawn)", () => acctW.finalizeGuess.populateTransaction(opId, dec.abiEncodedClearValues, dec.decryptionProof));
    r.finalizeResetTrip = await withHcu(ctx, fin);
    r.resetExecuted = Boolean(parseEvent(acct, fin.receipt, "OpExecuted"));
    const encT = await encryptTimed(
      ctx,
      [
        { type: "euint64", value: 300_000n },
        { type: "euint64", value: 3_000_000n },
      ],
      live.address,
      user.address,
    );
    r.tightenLimits = await withHcu(ctx, await send(user, "live tightenLimits (K-only; 4× encrypted min)", () => acct.tightenLimits.populateTransaction(ETH, encT.handles[0], encT.handles[1], encT.inputProof)));
    const encR = await encryptTimed(ctx, [{ type: "ebool", value: false }], live.address, user.address);
    r.removeKnown = await withHcu(ctx, await send(user, "live removeKnown (K-only; select, slot 0)", () => acct.removeKnown.populateTransaction(false, 0, encR.handles[0], encR.inputProof)));
    r.pass = r.resetExecuted;
    r.done = true;
    out.checks.admin = r;
    save();
    log(`D admin: RESET_TRIP executed ${r.resetExecuted}; finalize+resetTrip HCU ${r.finalizeResetTrip.hcu?.total}; tighten gas ${r.tightenLimits.gasUsed}; removeKnown gas ${r.removeKnown.gasUsed}`);
  }

  // ───────────── E. escape (FHE-free)
  if (!has("escape")) {
    const r: any = { done: false };
    const acct = contractAt(build, "EncryptedAccount", live.address, user);
    const acctW = contractAt(build, "EncryptedAccount", live.address, watchtower);
    const escapeAddr = live.escape;
    let s = await acct.status();
    if (Number(s[5]) === 0) {
      const st1 = await send(user, "live startEscape (K-only)", () => acct.startEscape.populateTransaction());
      r.startEscape = await withHcu(ctx, st1);
      r.startEscapeExecutorLogs = executorLogCount(st1.receipt);
      s = await readAt((o) => acct.status(o), st1.receipt.blockNumber);
    }
    const readyAt = Number(s[5]);
    r.escapeReadyAt = readyAt;
    r.escapeDelayS = live.delays.escape;
    for (;;) {
      const b = await provider.getBlock("latest");
      if ((b?.timestamp ?? 0) >= readyAt) break;
      await sleep(5_000);
    }
    const ex = await send(watchtower, "live executeEscape (permissionless; fixed target)", () => acctW.executeEscape.populateTransaction([]), { gasMult: 200n });
    r.executeEscape = await withHcu(ctx, ex);
    r.executeEscapeExecutorLogs = executorLogCount(ex.receipt);
    const bx = ex.receipt.blockNumber; // balances are pinned to the transaction's block and the one before
    const balAcct = await readAt((o) => provider.getBalance(live.address, o.blockTag), bx - 1);
    const balEsc0 = await readAt((o) => provider.getBalance(escapeAddr, o.blockTag), bx - 1);
    const balEsc1 = await readAt((o) => provider.getBalance(escapeAddr, o.blockTag), bx);
    const gasPaidByEsc = escapeAddr.toLowerCase() === watchtower.address.toLowerCase() ? BigInt(ex.tx.costWei) : 0n;
    r.sweptWei = balAcct.toString();
    r.escapeReceivedWei = (balEsc1 - balEsc0 + gasPaidByEsc).toString();
    r.accountBalanceAfter = (await readAt((o) => provider.getBalance(live.address, o.blockTag), bx)).toString();
    r.pass = (r.startEscapeExecutorLogs ?? 0) === 0 && r.executeEscapeExecutorLogs === 0 && r.escapeReceivedWei === r.sweptWei && r.accountBalanceAfter === "0";
    r.done = true;
    out.checks.escape = r;
    save();
    log(`E escape: executor events ${r.startEscapeExecutorLogs ?? 0}/${r.executeEscapeExecutorLogs}; swept ${eth(balAcct)} ETH → E_addr ${r.escapeReceivedWei === r.sweptWei ? "complete" : "SHORT"}`);
  }

  out.finishedAtUtc = iso();
  out.pass = Object.values<any>(out.checks).every((c) => c.pass);
  save();
  log(`\nLIVE CHECKS ${out.pass ? "PASSED" : "AT LEAST ONE FAILED"} → results/sepolia/live-checks.json · user ${eth(await provider.getBalance(user.address))} ETH · watchtower ${eth(await provider.getBalance(watchtower.address))} ETH`);
  provider.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    if (e instanceof InsufficientFunds) {
      console.error(e.message);
      process.exit(3);
    }
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
