/**
 * F0.10 live confirmations (Sepolia, our own contracts):
 *   1) E7-v2: v2 draws on TauBench in two narrow ranges (D = 1 000 and 131 071), public decryption + KMS signature,
 *      range check, live HCU (blockMeter); v1's narrow-range bug (τ = L_min) on the live chain.
 *   2) K53 / I23: submitGuess with a stale challenge reverts with StaleChallenge in eth_call (free).
 *   3) K55 / I24: the accounts' E_addr state (set up with EIP-712 consent); with a forged consent the factory reverts in eth_call.
 *
 *   SEP_RUN=f010 npx hardhat run scripts/sepolia/f010-live.ts      → results/sepolia/f010-live.json
 */
import { ethers } from "ethers";
import { contractAt, decodeRevert, errorInterface } from "../lib/deploy";
import { SEP_RUN, makeLiveCtx, publicDecryptWhenReady, writeJson } from "../lib/live";
import { InsufficientFunds, eth } from "../lib/net";
import { CHAIN_ID, ETH, TEST_DELAYS, TxRec, hcuOf, iso, loadF09, parseEvent, requireBalance, send } from "./f09-lib";

const LMIN = 100_000n;

async function main() {
  if (SEP_RUN !== "f010") throw new Error("run with SEP_RUN=f010");
  const ctx = await makeLiveCtx();
  const { provider, user, build } = ctx;
  const st = loadF09();
  if (!st.contracts?.TauBench || !st.accounts?.e1) throw new Error("run f010-prepare first");
  const ERR = errorInterface(build, ["EncryptedAccount", "PinLib", "PolicyLib", "OpsLib", "OpenLib"]);
  const why = (e: any) => decodeRevert(ERR, e);
  const bench = contractAt(build, "TauBench", st.contracts.TauBench, user);
  const out: any = { evidence: "[M] Sepolia", startedAtUtc: iso(), run: SEP_RUN, tauBench: st.contracts.TauBench, tau: [] };
  await requireBalance(provider, user, 25_000_000n, "F0.10 live confirmations");

  const drawLive = async (v: 1 | 2, k: number, label: string) => {
    const r = await send(user, label, () => (v === 1 ? bench.drawV1.populateTransaction(k) : bench.drawV2.populateTransaction(k)));
    const handles: string[] = [];
    for (const log of r.receipt.logs) {
      try {
        const ev = bench.interface.parseLog(log);
        if (ev?.name === "Drawn") handles.push(ev.args.handle);
      } catch {
        /* coprocessor event */
      }
    }
    const dec = await publicDecryptWhenReady(ctx, handles);
    const vals = dec.clearValues.map((x: any) => BigInt(x));
    const hcu = await hcuOf(provider, r.receipt);
    return { tx: r.tx as TxRec, vals, hcu, decryptWaitedMs: dec.waitedMs };
  };

  // ── 1) E7-v2 live draws
  for (const D of [1000n, 131071n]) {
    const sb = await send(user, `TauBench setBounds D=${D}`, () => bench.setBounds.populateTransaction(LMIN, LMIN + D));
    const v2 = await drawLive(2, 4, `TauBench drawV2(4) D=${D}`);
    const inRange = v2.vals.every((t: bigint) => t >= LMIN && t < LMIN + D);
    const row: any = {
      D: D.toString(),
      setBoundsTx: sb.tx.hash,
      v2: { tx: v2.tx.hash, gas: v2.tx.gasUsed, hcu: v2.hcu, offsets: v2.vals.map((t: bigint) => (t - LMIN).toString()), inRange, decryptWaitedMs: v2.decryptWaitedMs },
    };
    if (D === 1000n) {
      const v1 = await drawLive(1, 2, `TauBench drawV1(2) D=${D}`);
      row.v1 = { tx: v1.tx.hash, offsets: v1.vals.map((t: bigint) => (t - LMIN).toString()), allLmin: v1.vals.every((t: bigint) => t === LMIN), hcu: v1.hcu };
    }
    out.tau.push(row);
    console.log(`τ D=${D}: v2 offsets ${row.v2.offsets.join(", ")} · in range ${inRange} · HCU ${v2.hcu?.total} (meter ${v2.hcu?.meterCheck})${row.v1 ? ` · v1 offsets ${row.v1.offsets.join(", ")}` : ""}`);
  }

  // ── 2) K53: stale challenge (eth_call, free) — needs an open op: a PIN-path op is opened on the e1 account
  const e1 = contractAt(build, "EncryptedAccount", st.accounts.e1.address, user);
  const open = await send(user, "PIN-path op for K53", () => e1.requestTransfer.populateTransaction(ETH, ethers.Wallet.createRandom().address, 10n ** 12n, true));
  const ev = parseEvent(e1, open.receipt, "OpOpened")!;
  const opId: bigint = ev.args.opId;
  const cReceipt = BigInt(ev.args.challenge);
  const cRpcAtBlock = BigInt(await e1.challengeOf(opId, { blockTag: open.tx.blockNumber }));
  const cStale = BigInt(await e1.challengeOf(opId, { blockTag: open.tx.blockNumber - 1 })); // block before the op appears: opHash = 0
  let staleRevert = "";
  try {
    await e1.submitGuess.staticCall(opId, cStale, ethers.ZeroHash, "0x01", { blockTag: "latest" });
    staleRevert = "DID NOT REVERT";
  } catch (e) {
    staleRevert = why(e);
  }
  out.k53 = { opId: opId.toString(), openTx: open.tx.hash, cReceipt: cReceipt.toString(), cRpcAtBlock: cRpcAtBlock.toString(), receiptMatchesChain: cReceipt === cRpcAtBlock, cStaleFromPreviousBlock: cStale.toString(), staleGuessRevert: staleRevert };
  console.log(`K53: receipt c = chain c: ${cReceipt === cRpcAtBlock} · eth_call with stale c → ${staleRevert}`);

  // ── 3) K55: E_addr state and forged consent
  out.k55 = { accounts: {} as any };
  for (const [k, a] of Object.entries<any>(st.accounts)) {
    const es = await contractAt(build, "EncryptedAccount", a.address, provider).escapeState();
    out.k55.accounts[k] = { address: a.address, escape: es.escape_, verifiedAt: Number(es.verifiedAt), nonce: Number(es.nonce), createTx: a.setup?.createAccount?.hash ?? null };
  }
  const factory = contractAt(build, "EncryptedAccountFactory", st.contracts.EncryptedAccountFactory, user);
  const salt = ethers.id(`f010-forged-${Date.now()}`);
  const escapeAddr = ctx.watchtower!.address;
  const predicted: string = await factory.predictAddress(user.address, escapeAddr, escapeAddr, TEST_DELAYS, salt);
  const forged = await user.signTypedData(
    { name: "EncryptedAccount", version: "1", chainId: CHAIN_ID, verifyingContract: predicted },
    { EscapeAddress: [{ name: "escape", type: "address" }, { name: "nonce", type: "uint32" }] },
    { escape: escapeAddr, nonce: 0 },
  ); // signed by the user, not E_addr
  let forgedRevert = "";
  try {
    await factory.createAccountWithDelays.staticCall(user.address, escapeAddr, escapeAddr, TEST_DELAYS, salt, forged);
    forgedRevert = "DID NOT REVERT";
  } catch (e) {
    forgedRevert = why(e);
  }
  out.k55.forgedConsentRevert = forgedRevert;
  console.log(`K55: factory eth_call with a forged E_addr consent → ${forgedRevert}`);

  out.finishedAtUtc = iso();
  out.balances = { user: eth(await provider.getBalance(user.address)), watchtower: eth(await provider.getBalance(ctx.watchtower!.address)) };
  writeJson("f010-live.json", out);
  console.log("→ results/sepolia/f010-live.json");
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
