/**
 * F0.11 shared pieces: the A hot-path sample (F0.9 method: request → `ok` decryption → the watchtower's finalizeEvaluation)
 * and B's single-transaction K-only sample (open list, open limit, no FHE).
 */
import { ethers } from "ethers";
import { LiveCtx, clearValueBool, publicDecryptWhenReady } from "../lib/live";
import { AMOUNT, ETH, TxRec, attachHcu, executorLogCount, iso, now, parseEvent, send } from "./f09-lib";

export type Item = { tx: TxRec; receipt: ethers.TransactionReceipt };
const r = (x: number) => Math.round(x);

/** A: user click → request included → `ok` decryption ready → finalizeEvaluation (watchtower) included = transfer executed. */
export async function hotSampleA(ctx: LiveCtx, acct: any, acctW: any, known: string, i: number) {
  const { provider, user, watchtower } = ctx;
  const out: any = { i, variant: "A", startedAtUtc: iso() };
  const items: Item[] = [];
  const names: string[] = [];
  const t0 = now();
  const req = await send(user, `A#${i} requestTransfer (K-only)`, () => acct.requestTransfer.populateTransaction(ETH, known, AMOUNT, false));
  const tReq = now();
  items.push(req);
  names.push("request");
  const ev = parseEvent(acct, req.receipt, "Evaluating");
  if (!ev) {
    out.ok = false;
    out.error = "no Evaluating event: the K-only path did not open";
    await attachHcu(provider, items);
    out.tx = { request: req.tx };
    return out;
  }
  const opId: bigint = ev.args.opId;
  out.opId = opId.toString();
  const dec = await publicDecryptWhenReady(ctx, [ev.args.okHandle]);
  const tDec = now();
  const fin = await send(watchtower!, `A#${i} finalizeEvaluation (watchtower)`, () => acctW.finalizeEvaluation.populateTransaction(opId, dec.abiEncodedClearValues, dec.decryptionProof));
  const tFin = now();
  items.push(fin);
  names.push("finalizeEvaluation");
  out.ok = Boolean(parseEvent(acct, fin.receipt, "EvaluationFinalized")?.args.ok);
  out.executed = Boolean(parseEvent(acct, fin.receipt, "OpExecuted"));
  out.clear = dec.clearValues.map(clearValueBool);
  out.phases = { requestMs: r(tReq - t0), decryptMs: r(tDec - tReq), finalizeMs: r(tFin - tDec) };
  out.totalMs = r(tFin - t0);
  out.decrypt = { attempts: dec.attempts, waitedMs: dec.waitedMs, httpCalls: dec.httpCalls, readyBlock: dec.readyBlock };
  out.blocks = {
    request: req.tx.blockNumber,
    finalize: fin.tx.blockNumber,
    decryptBlocksAfterRequest: dec.readyBlock - req.tx.blockNumber,
    finalizeBlocksAfterRequest: fin.tx.blockNumber - req.tx.blockNumber,
  };
  await attachHcu(provider, items);
  out.tx = Object.fromEntries(items.map((it, k) => [names[k], it.tx]));
  out.gasTotal = items.reduce((s, it) => s + Number(it.tx.gasUsed), 0);
  return out;
}

/** B: user click → single transaction included = transfer executed (OpenOutflow; no op, no FHE). */
export async function syncSampleB(ctx: LiveCtx, acct: any, known: string, i: number) {
  const { provider, user } = ctx;
  const out: any = { i, variant: "B", startedAtUtc: iso() };
  const t0 = now();
  const req = await send(user, `B#${i} requestTransfer (open path)`, () => acct.requestTransfer.populateTransaction(ETH, known, AMOUNT, false));
  out.totalMs = r(now() - t0);
  const ev = parseEvent(acct, req.receipt, "OpenOutflow");
  out.ok = Boolean(ev) && !parseEvent(acct, req.receipt, "OpOpened");
  out.executed = out.ok;
  if (ev) out.spentAfter = ev.args.spent.toString();
  out.fheEvents = executorLogCount(req.receipt); // 0 expected: no FHE operations
  await attachHcu(provider, [req]);
  out.tx = { request: req.tx };
  out.hcu = req.tx.hcu?.total ?? 0; // hcuOf returns null for a transaction without FHE events → 0
  out.blocks = { request: req.tx.blockNumber, blocksToInclusion: req.tx.blocksToInclusion };
  out.gasTotal = Number(req.tx.gasUsed);
  return out;
}
