/**
 * F0.9 steps 3–5, 8 — E1 PIN flow and K-only hot path, N samples (default 30). The two flows are interleaved and the order
 * within each pair is random (so network/relayer conditions affect both flows over the same time window); random wait between samples.
 *
 * E1 PIN flow (e1 account; each sample goes to a fresh address that has never received anything):
 *   op open: requestTransfer(viaPin = true)                                   — the "click"; not part of the E1 total, recorded separately
 *   [E1 starts: the user enters the PIN]
 *   Argon2id (client, v1: 64 MiB, t = 3) → challenge (challengeOf) → encryption + input proof (relayer)
 *   → submitGuess inclusion → public decryption ready → finalizeGuess (watchtower) inclusion
 *   [E1 ends]  → executeOp (watchtower; test delay 0; not part of E1, its gas is recorded)
 * K-only hot path (hot account; to a known recipient, below L_min):
 *   [click] requestTransfer(viaPin = false) inclusion → `ok` decryption ready → finalizeEvaluation (watchtower) inclusion
 *   = transfer executed [ends]
 * Watchtower v0 behaviour: decrypt + finalize as soon as the event is seen (in this process; in production, block polling adds ≤ ~1 s [I]).
 *
 *   npx hardhat run scripts/sepolia/f09-run.ts
 * Environment: F09_N (30) · F09_GAP_MIN_S (3) · F09_GAP_MAX_S (20)
 * Output: results/sepolia/e1.json, results/sepolia/hot-path.json — written after every sample; resumes where it left off;
 * if the balance drops below the threshold it prints the shortfall and stops (exit code 3).
 */
import { ethers } from "ethers";
import * as os from "os";
import * as path from "path";
import { KDF_V1, guessValue, pinFingerprint } from "../../sdk/src";
import { contractAt, decodeRevert, errorInterface } from "../lib/deploy";
import { ROOT } from "../lib/env";
import { LiveCtx, SEP_RUN, clearValueBool, encryptTimed, makeLiveCtx, publicDecryptWhenReady, runFile, writeJson } from "../lib/live";
import { InsufficientFunds, eth, gwei, sleep } from "../lib/net";
import {
  AMOUNT,
  CHAIN_ID,
  ETH,
  LIMITS,
  TEST_PIN,
  TRACK_OWNER,
  TxRec,
  ZERO32,
  attachHcu,
  histogram,
  iso,
  loadF09,
  now,
  parseEvent,
  randInt,
  readAt,
  readJson,
  requireBalance,
  send,
  summarize,
} from "./f09-lib";

const N = Number(process.env.F09_N ?? 30);
const GAP_MIN = Number(process.env.F09_GAP_MIN_S ?? 3);
const GAP_MAX = Number(process.env.F09_GAP_MAX_S ?? 20);
const r = (x: number) => Math.round(x);

type Item = { tx: TxRec; receipt: ethers.TransactionReceipt };

async function tfheInfo() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require(path.join(ROOT, "node_modules", "@fhevm", "sdk", "_cjs", "core", "modules", "encrypt", "module", "init-p.js"));
    for (const v of ["1.6.2", "1.5.3"]) {
      try {
        const info = await m.getTfheModuleInfo({ tfheVersion: v });
        if (info) return { tfheVersion: v, numberOfThreads: info.numberOfThreads, threadsAvailable: info.threadsAvailable ?? null, wasmMemoryBytes: info.memory?.byteLength ?? null };
      } catch {
        /* next version */
      }
    }
  } catch {
    /* unreadable */
  }
  return null;
}

let ERR: ethers.Interface;
const why = (e: any) => (ERR ? decodeRevert(ERR, e) : String(e?.shortMessage ?? e?.message ?? e)).slice(0, 400);

async function ensureSlotFree(ctx: LiveCtx, acct: any, acctW: any) {
  const ts = await acct.trackState(TRACK_OWNER);
  const pendingOp: bigint = ts[2];
  if (pendingOp === 0n) return null;
  const g = await acct.getGuess(pendingOp);
  const hs = g.bigH === ZERO32 ? [g.okH] : [g.okH, g.bigH];
  const dec = await publicDecryptWhenReady(ctx, hs);
  const fin = await send(ctx.watchtower!, `recovery finalizeGuess op ${pendingOp}`, () =>
    acctW.finalizeGuess.populateTransaction(pendingOp, dec.abiEncodedClearValues, dec.decryptionProof),
  );
  return fin.tx.hash;
}

async function pinSample(ctx: LiveCtx, acct: any, acctW: any, acctAddr: string, i: number) {
  const { provider, user, watchtower } = ctx;
  const out: any = { i, kind: "pin", startedAtUtc: iso() };
  const items: Item[] = [];
  const names: string[] = [];
  const recovered = await ensureSlotFree(ctx, acct, acctW);
  if (recovered) out.recoveredPendingGuess = recovered;
  const to = ethers.Wallet.createRandom().address; // never-used address → PIN path
  out.to = to;

  const tClick = now();
  const open = await send(user, `e1#${i} requestTransfer (PIN path)`, () => acct.requestTransfer.populateTransaction(ETH, to, AMOUNT, true));
  items.push(open);
  names.push("open");
  const opened = parseEvent(acct, open.receipt, "OpOpened")!;
  const opId: bigint = opened.args.opId;
  out.opId = opId.toString();
  // F0.10 build (K53): the challenge is taken from the open receipt and declared to submitGuess (no RPC read)
  const k53 = acct.interface.getFunction("submitGuess")!.inputs.length === 4;
  out.challengeSource = k53 ? "open receipt (OpOpened.challenge, K53)" : "RPC challengeOf (pinned to the block)";

  // ── E1: the user enters the PIN
  const t0 = now();
  out.pinEnteredAtUtc = iso();
  const fp = await pinFingerprint(TEST_PIN, CHAIN_ID, acctAddr);
  const tArgon = now();
  const c = k53 ? BigInt(opened.args.challenge) : BigInt(await readAt((o) => acct.challengeOf(opId, o), open.tx.blockNumber));
  const tChal = now();
  const enc = await encryptTimed(ctx, [{ type: "euint64", value: guessValue(fp, c) }], acctAddr, user.address);
  const tEnc = now();
  const sub = await send(user, `e1#${i} submitGuess`, () =>
    k53 ? acct.submitGuess.populateTransaction(opId, c, enc.handles[0], enc.inputProof) : acct.submitGuess.populateTransaction(opId, enc.handles[0], enc.inputProof),
  );
  const tSub = now();
  items.push(sub);
  names.push("submitGuess");
  const g = parseEvent(acct, sub.receipt, "GuessSubmitted")!;
  const okH: string = g.args.okHandle;
  const bigH: string = g.args.bigHandle;
  const hs = bigH === ZERO32 ? [okH] : [okH, bigH];

  // ── watchtower: decrypt + finalize
  const dec = await publicDecryptWhenReady(ctx, hs);
  const tDec = now();
  const fin = await send(watchtower!, `e1#${i} finalizeGuess (watchtower)`, () => acctW.finalizeGuess.populateTransaction(opId, dec.abiEncodedClearValues, dec.decryptionProof));
  const tFin = now();
  items.push(fin);
  names.push("finalizeGuess");
  const gf = parseEvent(acct, fin.receipt, "GuessFinalized");
  out.ok = Boolean(gf?.args.ok);
  out.clear = dec.clearValues.map(clearValueBool); // [okAny, big]

  out.phases = {
    argonMs: r(tArgon - t0),
    challengeMs: r(tChal - tArgon),
    encryptMs: r(tEnc - tChal),
    encrypt: enc.timing,
    submitMs: r(tSub - tEnc),
    decryptMs: r(tDec - tSub),
    finalizeMs: r(tFin - tDec),
  };
  out.totalMs = r(tFin - t0);
  out.openMs = r(t0 - tClick);
  out.clickToFinalizeMs = r(tFin - tClick);
  out.decrypt = { attempts: dec.attempts, waitedMs: dec.waitedMs, httpCalls: dec.httpCalls, readyBlock: dec.readyBlock, lastError: dec.lastError, progress: dec.progress };
  out.blocks = {
    open: open.tx.blockNumber,
    submit: sub.tx.blockNumber,
    decryptReadySeenAt: dec.readyBlock,
    finalize: fin.tx.blockNumber,
    decryptBlocksAfterSubmit: dec.readyBlock - sub.tx.blockNumber,
    finalizeBlocksAfterSubmit: fin.tx.blockNumber - sub.tx.blockNumber,
  };

  // ── execution (not part of E1)
  if (out.ok) {
    const ex = await send(watchtower!, `e1#${i} executeOp (watchtower)`, () => acctW.executeOp.populateTransaction(opId));
    items.push(ex);
    names.push("executeOp");
    out.executed = Boolean(parseEvent(acct, ex.receipt, "OpExecuted"));
  }
  await attachHcu(provider, items); // after the measured flow
  out.tx = Object.fromEntries(items.map((it, k) => [names[k], it.tx]));
  return out;
}

async function hotSample(ctx: LiveCtx, acct: any, acctW: any, known: string, i: number) {
  const { provider, user, watchtower } = ctx;
  const out: any = { i, kind: "hot", startedAtUtc: iso() };
  const items: Item[] = [];
  const names: string[] = [];
  const t0 = now();
  const req = await send(user, `hot#${i} requestTransfer (K-only)`, () => acct.requestTransfer.populateTransaction(ETH, known, AMOUNT, false));
  const tReq = now();
  items.push(req);
  names.push("request");
  const ev = parseEvent(acct, req.receipt, "Evaluating");
  if (!ev) {
    out.ok = false;
    out.error = "no Evaluating event: the K-only path did not open (restricted mode / heartbeat / 2^64?)";
    await attachHcu(provider, items);
    out.tx = { request: req.tx };
    return out;
  }
  const opId: bigint = ev.args.opId;
  out.opId = opId.toString();
  const dec = await publicDecryptWhenReady(ctx, [ev.args.okHandle]);
  const tDec = now();
  const fin = await send(watchtower!, `hot#${i} finalizeEvaluation (watchtower)`, () => acctW.finalizeEvaluation.populateTransaction(opId, dec.abiEncodedClearValues, dec.decryptionProof));
  const tFin = now();
  items.push(fin);
  names.push("finalizeEvaluation");
  const ef = parseEvent(acct, fin.receipt, "EvaluationFinalized");
  out.ok = Boolean(ef?.args.ok);
  out.executed = Boolean(parseEvent(acct, fin.receipt, "OpExecuted"));
  out.clear = dec.clearValues.map(clearValueBool);
  out.phases = { requestMs: r(tReq - t0), decryptMs: r(tDec - tReq), finalizeMs: r(tFin - tDec) };
  out.totalMs = r(tFin - t0);
  out.decrypt = { attempts: dec.attempts, waitedMs: dec.waitedMs, httpCalls: dec.httpCalls, readyBlock: dec.readyBlock, lastError: dec.lastError, progress: dec.progress };
  out.blocks = {
    request: req.tx.blockNumber,
    decryptReadySeenAt: dec.readyBlock,
    finalize: fin.tx.blockNumber,
    decryptBlocksAfterRequest: dec.readyBlock - req.tx.blockNumber,
    finalizeBlocksAfterRequest: fin.tx.blockNumber - req.tx.blockNumber,
  };
  await attachHcu(provider, items);
  out.tx = Object.fromEntries(items.map((it, k) => [names[k], it.tx]));
  return out;
}

const pick = (samples: any[], f: (s: any) => number | undefined) => samples.map(f).filter((x): x is number => typeof x === "number" && Number.isFinite(x));

function summarizeE1(samples: any[]) {
  const ok = samples.filter((s) => s.ok);
  const total = pick(ok, (s) => s.totalMs);
  return {
    nOk: ok.length,
    nFailedOk: samples.length - ok.length,
    totalMs: summarize(total),
    clickToFinalizeMs: summarize(pick(ok, (s) => s.clickToFinalizeMs)),
    phases: {
      argonMs: summarize(pick(ok, (s) => s.phases.argonMs)),
      challengeMs: summarize(pick(ok, (s) => s.phases.challengeMs)),
      encryptMs: summarize(pick(ok, (s) => s.phases.encryptMs)),
      encryptLocalMs: summarize(pick(ok, (s) => s.phases.encrypt.localMs)),
      encryptRelayerMs: summarize(pick(ok, (s) => s.phases.encrypt.relayerHttpMs)),
      submitMs: summarize(pick(ok, (s) => s.phases.submitMs)),
      decryptMs: summarize(pick(ok, (s) => s.phases.decryptMs)),
      finalizeMs: summarize(pick(ok, (s) => s.phases.finalizeMs)),
      openMs: summarize(pick(ok, (s) => s.openMs)),
    },
    blocks: {
      submitBlocksToInclusion: summarize(pick(ok, (s) => s.tx.submitGuess.blocksToInclusion)),
      decryptBlocksAfterSubmit: summarize(pick(ok, (s) => s.blocks.decryptBlocksAfterSubmit)),
      finalizeBlocksAfterSubmit: summarize(pick(ok, (s) => s.blocks.finalizeBlocksAfterSubmit)),
    },
    gas: Object.fromEntries(["open", "submitGuess", "finalizeGuess", "executeOp"].map((k) => [k, summarize(pick(ok, (s) => (s.tx[k] ? Number(s.tx[k].gasUsed) : undefined)))])),
    hcu: Object.fromEntries(["submitGuess", "executeOp"].map((k) => [k, { total: summarize(pick(ok, (s) => s.tx[k]?.hcu?.total)), depth: summarize(pick(ok, (s) => s.tx[k]?.hcu?.depth)) }])),
    meterChecks: countMeter(ok),
    histogramTotal: histogram(total),
    goNoGo: total.length ? (summarize(total) as any).p95 < 60_000 ? "GO (p95 < 60 s)" : "NO-GO (p95 ≥ 60 s)" : "no data",
  };
}

function summarizeHot(samples: any[]) {
  const ok = samples.filter((s) => s.ok && s.executed);
  const total = pick(ok, (s) => s.totalMs);
  return {
    nOk: ok.length,
    nNotOk: samples.length - ok.length,
    totalMs: summarize(total),
    phases: {
      requestMs: summarize(pick(ok, (s) => s.phases.requestMs)),
      decryptMs: summarize(pick(ok, (s) => s.phases.decryptMs)),
      finalizeMs: summarize(pick(ok, (s) => s.phases.finalizeMs)),
    },
    blocks: {
      requestBlocksToInclusion: summarize(pick(ok, (s) => s.tx.request.blocksToInclusion)),
      decryptBlocksAfterRequest: summarize(pick(ok, (s) => s.blocks.decryptBlocksAfterRequest)),
      finalizeBlocksAfterRequest: summarize(pick(ok, (s) => s.blocks.finalizeBlocksAfterRequest)),
    },
    gas: Object.fromEntries(["request", "finalizeEvaluation"].map((k) => [k, summarize(pick(ok, (s) => (s.tx[k] ? Number(s.tx[k].gasUsed) : undefined)))])),
    hcu: { request: { total: summarize(pick(ok, (s) => s.tx.request?.hcu?.total)), depth: summarize(pick(ok, (s) => s.tx.request?.hcu?.depth)) } },
    meterChecks: countMeter(ok),
    histogramTotal: histogram(total),
    threshold60s: total.length ? ((summarize(total) as any).p95 < 60_000 ? "p95 < 60 s" : "p95 ≥ 60 s") : "no data",
  };
}

function countMeter(samples: any[]) {
  const c: Record<string, number> = {};
  for (const s of samples) for (const t of Object.values<any>(s.tx ?? {})) if (t?.hcu) c[t.hcu.meterCheck] = (c[t.hcu.meterCheck] ?? 0) + 1;
  return c;
}

async function main() {
  const ctx = await makeLiveCtx();
  const { provider, user, watchtower, build } = ctx;
  if (!watchtower) throw new Error("no watchtower key");
  ERR = errorInterface(build, ["EncryptedAccount", "PinLib", "PolicyLib", "OpsLib", "OpenLib"]);
  const st = loadF09();
  const e1Acct = st.accounts?.e1;
  const hotAcct = st.accounts?.hot;
  if (!e1Acct || !hotAcct || !st.knownHot) throw new Error("accounts not set up (run f09-prepare first)");
  const acctE1 = contractAt(build, "EncryptedAccount", e1Acct.address, user);
  const acctE1W = contractAt(build, "EncryptedAccount", e1Acct.address, watchtower);
  const acctHot = contractAt(build, "EncryptedAccount", hotAcct.address, user);
  const acctHotW = contractAt(build, "EncryptedAccount", hotAcct.address, watchtower);
  for (const [k, a] of [
    ["e1", acctE1],
    ["hot", acctHot],
  ] as const) {
    const s = await a.status();
    if (!s[0]) throw new Error(`${k} account not armed (arm)`);
    if (Number(s[1]) !== 0) console.log(`WARNING: ${k} account is in restricted mode (reasons=${s[1]})`);
  }

  const fee = await provider.getFeeData();
  const config = {
    n: N,
    gapS: [GAP_MIN, GAP_MAX],
    rpc: provider.currentUrl,
    tipGwei: gwei(fee.maxPriorityFeePerGas!),
    relayer: "https://relayer.testnet.zama.org",
    sdk: "@fhevm/sdk 0.13.7",
    tfhe: await tfheInfo(),
    clientReadyMs: ctx.clientReadyMs,
    client: { node: process.version, cpu: os.cpus()[0]?.model ?? "?", cores: os.cpus().length, platform: `${os.platform()} ${os.release()}` },
    argon2id: { ...KDF_V1, impl: "hash-wasm 4.13.0 (WASM, Node)" },
    amountWei: AMOUNT.toString(),
    limits: { unitWei: "1e12", lmin: LIMITS.lmin.toString(), lmax: LIMITS.lmax.toString(), big: LIMITS.big.toString() },
    watchtower: watchtower.address,
    pollMs: 500,
  };

  const load = (name: string, kind: string, account: string) => {
    const prev = readJson(name);
    if (prev && prev.account === account) return prev;
    return { evidence: "[M] Sepolia", flow: kind, account, startedAtUtc: iso(), config, samples: [] as any[], failures: [] as any[] };
  };
  const e1 = load(runFile("e1.json"), "E1 PIN flow (two-phase, including Argon2id)", e1Acct.address);
  const hot = load(runFile("hot-path.json"), "K-only hot path (request → ok decryption → finalizeEvaluation → transfer)", hotAcct.address);
  e1.run = hot.run = SEP_RUN;
  e1.config = config;
  hot.config = config;
  e1.delays = e1Acct.delays;
  hot.delays = hotAcct.delays;
  hot.knownRecipient = st.knownHot;

  const flush = () => {
    e1.updatedAtUtc = hot.updatedAtUtc = iso();
    e1.summary = summarizeE1(e1.samples);
    hot.summary = summarizeHot(hot.samples);
    writeJson(runFile("e1.json"), e1);
    writeJson(runFile("hot-path.json"), hot);
  };
  const done = (o: any, i: number) => o.samples.some((s: any) => s.i === i);
  const fails = (o: any, i: number) => o.failures.filter((f: any) => f.i === i).length;

  console.log(`${SEP_RUN === "baseline" ? "F0.9" : SEP_RUN} run: N=${N}, gap ${GAP_MIN}–${GAP_MAX} s · e1 ${e1Acct.address} · hot ${hotAcct.address}`);
  console.log(`progress: e1 ${e1.samples.length}/${N}, hot ${hot.samples.length}/${N} · user ${eth(await provider.getBalance(user.address))} ETH · watchtower ${eth(await provider.getBalance(watchtower.address))} ETH`);

  for (let i = 0; i < N; i++) {
    const order = Math.random() < 0.5 ? (["pin", "hot"] as const) : (["hot", "pin"] as const);
    for (const kind of order) {
      const o = kind === "pin" ? e1 : hot;
      while (!done(o, i) && fails(o, i) < 2) {
        await requireBalance(provider, user, 3_000_000n, `F0.9 ${kind}#${i} (user)`);
        await requireBalance(provider, watchtower, 2_500_000n, `F0.9 ${kind}#${i} (watchtower)`);
        try {
          const s = kind === "pin" ? await pinSample(ctx, acctE1, acctE1W, e1Acct.address, i) : await hotSample(ctx, acctHot, acctHotW, st.knownHot!, i);
          o.samples.push(s);
          flush();
          if (kind === "pin") {
            console.log(
              `PIN #${i}: ${s.ok ? "ok" : "WRONG"} total ${(s.totalMs / 1000).toFixed(1)} s (argon ${s.phases.argonMs}, encrypt ${s.phases.encryptMs}, inclusion ${s.phases.submitMs}, decrypt ${s.phases.decryptMs}, finalize ${s.phases.finalizeMs}) · click→finalize ${(s.clickToFinalizeMs / 1000).toFixed(1)} s`,
            );
          } else {
            console.log(
              `HOT #${i}: ${s.ok && s.executed ? "executed" : "NOT EXECUTED"} total ${((s.totalMs ?? 0) / 1000).toFixed(1)} s (request ${s.phases?.requestMs}, decrypt ${s.phases?.decryptMs}, finalize ${s.phases?.finalizeMs})`,
            );
          }
        } catch (e: any) {
          if (e instanceof InsufficientFunds) throw e;
          o.failures.push({ i, kind, atUtc: iso(), error: why(e) });
          flush();
          console.log(`${kind} #${i} ERROR: ${why(e)} — retrying in 10 s`);
          await sleep(10_000);
        }
      }
      await sleep(randInt(GAP_MIN, GAP_MAX) * 1000);
    }
  }
  flush();
  const s1 = e1.summary;
  const s2 = hot.summary;
  console.log(`\nE1 PIN flow: n=${s1.nOk} p50 ${s1.totalMs.p50} ms · p95 ${s1.totalMs.p95} ms · max ${s1.totalMs.max} ms → ${s1.goNoGo}`);
  console.log(`K-only hot path: n=${s2.nOk} p50 ${s2.totalMs.p50} ms · p95 ${s2.totalMs.p95} ms · max ${s2.totalMs.max} ms (${s2.threshold60s})`);
  console.log(`user ${eth(await provider.getBalance(user.address))} ETH · watchtower ${eth(await provider.getBalance(watchtower.address))} ETH`);
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
