/**
 * F0.11 — A/B K-only hot path, N samples (default 30). Same build, same known recipient, same amount (1e12 wei).
 * The two variants are interleaved and the order within each pair is random (so network conditions affect both over the
 * same time window); random wait between samples.
 *   A: [click] requestTransfer included → `ok` decryption ready → finalizeEvaluation (watchtower) included = transfer executed
 *   B: [click] requestTransfer included = transfer executed (OpenOutflow; no op, no FHE)
 * Each sample records tx hash, block, UTC timestamp, gas, HCU (from events + live block meter), errors and retries.
 *
 *   SEP_RUN=f011 npx hardhat run scripts/sepolia/f011-run.ts
 * Environment: F011_N (30) · F011_GAP_MIN_S (3) · F011_GAP_MAX_S (20)
 * Output: results/sepolia/f011-ab.json — written after every sample; resumes where it left off; if the balance drops
 * below the threshold it prints the shortfall and stops (exit code 3).
 */
import * as os from "os";
import { contractAt, decodeRevert, errorInterface } from "../lib/deploy";
import { SEP_RUN, makeLiveCtx, writeJson } from "../lib/live";
import { InsufficientFunds, eth, gwei, sleep } from "../lib/net";
import { AMOUNT, histogram, iso, loadF09, randInt, readJson, requireBalance, summarize } from "./f09-lib";
import { hotSampleA, syncSampleB } from "./f011-lib";

const N = Number(process.env.F011_N ?? 30);
const GAP_MIN = Number(process.env.F011_GAP_MIN_S ?? 3);
const GAP_MAX = Number(process.env.F011_GAP_MAX_S ?? 20);

const pick = (samples: any[], f: (s: any) => number | undefined) => samples.map(f).filter((x): x is number => typeof x === "number" && Number.isFinite(x));

function summarizeVariant(samples: any[], v: "A" | "B") {
  const ok = samples.filter((s) => s.variant === v && s.ok && s.executed);
  const total = pick(ok, (s) => s.totalMs);
  const base: any = {
    nOk: ok.length,
    nNotOk: samples.filter((s) => s.variant === v).length - ok.length,
    totalMs: summarize(total),
    gasTotal: summarize(pick(ok, (s) => s.gasTotal)),
    histogramTotal: histogram(total),
    threshold60s: total.length ? ((summarize(total) as any).p95 < 60_000 ? "p95 < 60 s" : "p95 ≥ 60 s") : "no data",
  };
  if (v === "A") {
    base.phases = {
      requestMs: summarize(pick(ok, (s) => s.phases.requestMs)),
      decryptMs: summarize(pick(ok, (s) => s.phases.decryptMs)),
      finalizeMs: summarize(pick(ok, (s) => s.phases.finalizeMs)),
    };
    base.gas = { request: summarize(pick(ok, (s) => Number(s.tx.request.gasUsed))), finalizeEvaluation: summarize(pick(ok, (s) => Number(s.tx.finalizeEvaluation.gasUsed))) };
    base.hcu = { request: summarize(pick(ok, (s) => s.tx.request?.hcu?.total)) };
    base.blocks = {
      requestBlocksToInclusion: summarize(pick(ok, (s) => s.tx.request.blocksToInclusion)),
      finalizeBlocksAfterRequest: summarize(pick(ok, (s) => s.blocks.finalizeBlocksAfterRequest)),
    };
  } else {
    base.gas = { request: summarize(pick(ok, (s) => Number(s.tx.request.gasUsed))) };
    base.hcu = { request: summarize(pick(ok, (s) => s.hcu)), fheEvents: summarize(pick(ok, (s) => s.fheEvents)) };
    base.blocks = { requestBlocksToInclusion: summarize(pick(ok, (s) => s.tx.request.blocksToInclusion)) };
  }
  const meter: Record<string, number> = {};
  for (const s of ok) for (const t of Object.values<any>(s.tx ?? {})) if (t?.hcu) meter[t.hcu.meterCheck] = (meter[t.hcu.meterCheck] ?? 0) + 1;
  base.meterChecks = meter;
  return base;
}

async function main() {
  if (SEP_RUN !== "f011") throw new Error("run with SEP_RUN=f011");
  const ctx = await makeLiveCtx();
  const { provider, user, watchtower, build } = ctx;
  if (!watchtower) throw new Error("no watchtower key");
  const ERR = errorInterface(build, ["EncryptedAccount", "EncryptedAccountB", "PinLib", "PolicyLib", "OpsLib", "OpenLib"]);
  const why = (e: any) => decodeRevert(ERR, e);
  const st = loadF09();
  if (!st.accounts?.a || !st.accounts?.b || !st.knownHot || !st.warmup?.a || !st.warmup?.b) throw new Error("preparation incomplete (run f011-prepare first)");
  const acctA = contractAt(build, "EncryptedAccount", st.accounts.a.address, user);
  const acctAW = contractAt(build, "EncryptedAccount", st.accounts.a.address, watchtower);
  const acctB = contractAt(build, "EncryptedAccountB", st.accounts.b.address, user);
  for (const [k, a] of [
    ["a", acctA],
    ["b", acctB],
  ] as const) {
    const s = await a.status();
    if (!s[0]) throw new Error(`${k} account not armed (arm)`);
    if (Number(s[1]) !== 0) throw new Error(`${k} account is in restricted mode (reasons=${s[1]}): the run cannot measure the K-only path`);
  }

  const fee = await provider.getFeeData();
  const config = {
    n: N,
    gapS: [GAP_MIN, GAP_MAX],
    rpc: provider.currentUrl,
    tipGwei: gwei(fee.maxPriorityFeePerGas!),
    sdk: "@fhevm/sdk 0.13.7",
    clientReadyMs: ctx.clientReadyMs,
    client: { node: process.version, cpu: os.cpus()[0]?.model ?? "?", cores: os.cpus().length, platform: `${os.platform()} ${os.release()}` },
    amountWei: AMOUNT.toString(),
    knownRecipient: st.knownHot,
    accounts: { A: st.accounts.a.address, B: st.accounts.b.address },
    watchtower: watchtower.address,
    pollMs: 500,
  };
  const prev = readJson("f011-ab.json");
  const out =
    prev && prev.accounts?.A === st.accounts.a.address && prev.accounts?.B === st.accounts.b.address
      ? prev
      : { evidence: "[M] Sepolia", flow: "A/B K-only hot path (same recipient, same amount)", startedAtUtc: iso(), accounts: config.accounts, samples: [] as any[], failures: [] as any[] };
  out.run = SEP_RUN;
  out.config = config;
  const flush = () => {
    out.updatedAtUtc = iso();
    out.summary = { A: summarizeVariant(out.samples, "A"), B: summarizeVariant(out.samples, "B") };
    writeJson("f011-ab.json", out);
  };
  const done = (v: string, i: number) => out.samples.some((s: any) => s.variant === v && s.i === i);
  const fails = (v: string, i: number) => out.failures.filter((f: any) => f.variant === v && f.i === i).length;

  console.log(`F0.11 A/B run: N=${N}, gap ${GAP_MIN}–${GAP_MAX} s · A ${st.accounts.a.address} · B ${st.accounts.b.address}`);
  console.log(`progress: ${out.samples.length}/${2 * N} samples · user ${eth(await provider.getBalance(user.address))} ETH · watchtower ${eth(await provider.getBalance(watchtower.address))} ETH`);
  for (let i = 0; i < N; i++) {
    const order = Math.random() < 0.5 ? (["A", "B"] as const) : (["B", "A"] as const);
    for (const v of order) {
      while (!done(v, i) && fails(v, i) < 2) {
        await requireBalance(provider, user, 2_500_000n, `F0.11 ${v}#${i} (user)`);
        if (v === "A") await requireBalance(provider, watchtower, 1_000_000n, `F0.11 A#${i} (watchtower)`);
        try {
          const s = v === "A" ? await hotSampleA(ctx, acctA, acctAW, st.knownHot, i) : await syncSampleB(ctx, acctB, st.knownHot, i);
          out.samples.push(s);
          flush();
          console.log(
            v === "A"
              ? `A #${i}: ${s.ok && s.executed ? "executed" : "NOT EXECUTED"} ${((s.totalMs ?? 0) / 1000).toFixed(1)} s (request ${s.phases?.requestMs}, decrypt ${s.phases?.decryptMs}, finalize ${s.phases?.finalizeMs}) · gas ${s.gasTotal}`
              : `B #${i}: ${s.ok ? "executed" : "NOT EXECUTED"} ${(s.totalMs / 1000).toFixed(1)} s · gas ${s.gasTotal} · FHE events ${s.fheEvents}`,
          );
        } catch (e: any) {
          if (e instanceof InsufficientFunds) throw e;
          out.failures.push({ i, variant: v, atUtc: iso(), error: why(e) });
          flush();
          console.log(`${v} #${i} ERROR: ${why(e)} — retrying in 10 s`);
          await sleep(10_000);
        }
      }
      await sleep(randInt(GAP_MIN, GAP_MAX) * 1000);
    }
  }
  flush();
  const a = out.summary.A;
  const b = out.summary.B;
  console.log(`\nA: n=${a.nOk} p50 ${a.totalMs.p50} ms · p95 ${a.totalMs.p95} ms · gas p50 ${a.gasTotal.p50}`);
  console.log(`B: n=${b.nOk} p50 ${b.totalMs.p50} ms · p95 ${b.totalMs.p95} ms · gas p50 ${b.gasTotal.p50}`);
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
