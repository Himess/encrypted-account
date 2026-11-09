/**
 * F0.8.5 — On-chain smoke test (on our own test contract ToolchainSpike):
 *   1) one encrypted input (setSecret), 2) comparison with an encrypted input (guessWithChallenge → ebool, publicly
 *   decryptable), 3) public decryption through the relayer, 4) on-chain verification of the KMS signatures (verify).
 * With a low priority fee (0.05 gwei), the number of blocks until each transaction is included is also recorded.
 *
 *   npx hardhat run scripts/sepolia/smoke.ts   → results/sepolia/smoke.json
 */
import { randomBytes } from "crypto";
import { ethers } from "ethers";
import * as path from "path";
import { contractAt, deployFromBuild } from "../lib/deploy";
import { OUT_DIR, clearValueBool, encryptTimed, loadState, makeLiveCtx, publicDecryptWhenReady, saveState, writeJson } from "../lib/live";
import { ENTRYPOINT_V08, InsufficientFunds, ensureBalance, eth, gwei, sendTx } from "../lib/net";

const STATE = path.join(OUT_DIR, "state-baseline.json");

async function main() {
  const ctx = await makeLiveCtx();
  const { provider, user } = ctx;
  const st = loadState(STATE);
  const fee = await provider.getFeeData();
  console.log(`user ${user.address} · balance ${eth(await provider.getBalance(user.address))} ETH · priority ${gwei(fee.maxPriorityFeePerGas!)} gwei · client ready ${ctx.clientReadyMs} ms`);
  await ensureBalance(provider, user.address, 4_000_000n, "smoke test");

  const epCode = await provider.getCode(ENTRYPOINT_V08);
  const out: any = {
    evidence: "[M] Sepolia",
    startedAtUtc: new Date().toISOString(),
    rpc: provider.currentUrl,
    tipGwei: gwei(fee.maxPriorityFeePerGas!),
    clientReadyMs: ctx.clientReadyMs,
    entryPointV08: { address: ENTRYPOINT_V08, hasCode: epCode.length > 2, codeBytes: (epCode.length - 2) / 2 },
    steps: {},
  };

  // 0) ToolchainSpike deployment (once)
  if (!st.spike) {
    const d = await deployFromBuild(user, ctx.build, "ToolchainSpike");
    st.spike = d.address;
    st.deploys = { ...(st.deploys ?? {}), ToolchainSpike: d.tx };
    saveState(STATE, st);
    console.log(`ToolchainSpike @ ${d.address} (gas ${d.tx.gasUsed}, ${d.tx.inclusionMs} ms)`);
  }
  out.spike = st.spike;
  const spike = contractAt(ctx.build, "ToolchainSpike", st.spike, user);

  const send = async (label: string, populate: () => Promise<ethers.TransactionRequest>) => {
    const sentBlock = await provider.getBlockNumber();
    const rec = await sendTx(user, label, async () => {
      const req = await populate();
      const est = await provider.estimateGas({ ...req, from: user.address });
      return { ...req, gasLimit: (est * 125n) / 100n };
    });
    const { receipt, ...r } = rec;
    void receipt;
    return { ...r, sentBlock, blocksToInclusion: r.blockNumber - sentBlock };
  };

  // 1) encrypted input
  const secret = BigInt("0x" + randomBytes(4).toString("hex"));
  const enc1 = await encryptTimed(ctx, [{ type: "euint64", value: secret }], st.spike, user.address);
  const tx1 = await send("setSecret", () => spike.setSecret.populateTransaction(enc1.handles[0], enc1.inputProof));
  out.steps.setSecret = { encrypt: enc1.timing, tx: tx1 };
  console.log(`setSecret: encryption ${enc1.timing.totalMs} ms (relayer ${enc1.timing.relayerHttpMs}), inclusion ${tx1.inclusionMs} ms / ${tx1.blocksToInclusion} blocks, gas ${tx1.gasUsed}`);

  // 2) comparison (correct value: secret + c)
  const c = BigInt("0x" + randomBytes(4).toString("hex"));
  const enc2 = await encryptTimed(ctx, [{ type: "euint64", value: secret + c }], st.spike, user.address);
  const tx2 = await send("guessWithChallenge", () => spike.guessWithChallenge.populateTransaction(enc2.handles[0], enc2.inputProof, c));
  out.steps.guess = { encrypt: enc2.timing, tx: tx2 };
  console.log(`guessWithChallenge: encryption ${enc2.timing.totalMs} ms, inclusion ${tx2.inclusionMs} ms / ${tx2.blocksToInclusion} blocks, gas ${tx2.gasUsed}`);

  // 3) public decryption
  const handle: string = await spike.lastBit();
  const dec = await publicDecryptWhenReady(ctx, [handle]);
  const okBit = clearValueBool(dec.clearValues[0]);
  out.steps.publicDecrypt = { handle, ok: okBit, waitedMs: dec.waitedMs, attempts: dec.attempts, readyBlock: dec.readyBlock, blocksAfterInclusion: dec.readyBlock - tx2.blockNumber, progress: dec.progress, lastError: dec.lastError };
  console.log(`publicDecrypt: value ${okBit}, ${dec.waitedMs} ms, ${dec.attempts} attempts, ready ${dec.readyBlock - tx2.blockNumber} blocks after inclusion`);

  // 4) on-chain verification of the KMS signatures
  const tx3 = await send("verify", () => spike.verify.populateTransaction(dec.abiEncodedClearValues, dec.decryptionProof));
  const verified: boolean = await spike.verifiedValue();
  out.steps.verify = { tx: tx3, verifiedValue: verified };
  console.log(`verify (checkSignatures): ${verified ? "passed" : "FAILED"}, gas ${tx3.gasUsed}`);

  out.pass = okBit === true && verified === true && out.entryPointV08.hasCode;
  out.finishedAtUtc = new Date().toISOString();
  out.balanceAfterEth = eth(await provider.getBalance(user.address));
  out.rpcStats = provider.stats;
  writeJson("smoke.json", out);
  console.log(`\nSMOKE TEST ${out.pass ? "PASSED" : "FAILED"} → results/sepolia/smoke.json`);
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
