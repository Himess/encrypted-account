// F0.11 — produces the A/B summary (results/f011-summary.json) and prints markdown for RESULTS.md.
//   node scripts/f011-results.mjs            → summary JSON + markdown (stdout)
// Input: results/f011-mock.json [Mock], results/sepolia/{setup-f011,f011-ab}.json [M]; F0.9 baseline (hot-path.json).
import fs from "node:fs";
import path from "node:path";

const R = path.join(process.cwd(), "results");
const S = path.join(R, "sepolia");
const rd = (dir, f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) : null);
const mock = rd(R, "f011-mock.json");
const setup = rd(S, "setup-f011.json");
const ab = rd(S, "f011-ab.json");
const hotF09 = rd(S, "hot-path.json");
const s = (ms) => (ms == null ? "—" : (ms / 1000).toFixed(1));
const n = (x) => (x == null ? "—" : Math.round(Number(x)).toLocaleString("en-US"));
const x = (a, b) => (a && b ? (a / b).toFixed(1) + "×" : "—");

const A = ab?.summary?.A;
const B = ab?.summary?.B;
const deployGas = setup ? Object.values(setup.deploys).reduce((t, d) => t + Number(d.gasUsed ?? 0), 0) : null;
const spentWei = (ab?.samples ?? []).flatMap((q) => Object.values(q.tx ?? {})).reduce((t, d) => t + BigInt(d.costWei ?? "0"), 0n);
const stepGas = (acct, step) => acct?.rows?.find((r) => r.step === step)?.gas ?? null;

const out = {
  evidence: { mock: "[Mock]", sepolia: "[M] Sepolia" },
  generatedAtUtc: new Date().toISOString(),
  mock: mock && { setup: mock.setup, hotPath: mock.hotPath },
  sepolia: setup && {
    deploy: { contracts: setup.contracts, runtimeBytes: setup.runtimeBytes, totalGas: deployGas },
    setup: { A: setup.accounts.a.totalGas, B: setup.accounts.b.totalGas, diff: setup.setupDiff, knownOpenOneEntry: stepGas(setup.accounts.b, "setupKnownOpen") },
    hot: ab && { A, B, failures: ab.failures, n: ab.config?.n },
    warmup: setup.warmup && { A: setup.warmup.a?.gasTotal, B: setup.warmup.b?.gasTotal },
  },
  baselineF09Hot: hotF09?.summary && { totalMs: hotF09.summary.totalMs, gas: hotF09.summary.gas },
  spentEthSamples: Number(spentWei) / 1e18,
};
fs.writeFileSync(path.join(R, "f011-summary.json"), JSON.stringify(out, null, 2));

const L = [];
L.push("| | A (encrypted policy) | B (open list, open limit) | Difference |");
L.push("|---|---|---|---|");
if (A && B) {
  L.push(`| K-only end-to-end time, Sepolia p50 / p95 [M] (n = ${A.nOk} / ${B.nOk}) | ${s(A.totalMs.p50)} / ${s(A.totalMs.p95)} s | ${s(B.totalMs.p50)} / ${s(B.totalMs.p95)} s | p50 ${x(A.totalMs.p50, B.totalMs.p50)} shorter |`);
  L.push(`| Transactions | 2 (request + the watchtower's finalize) and one KMS decryption | 1 | — |`);
  L.push(`| Gas, Sepolia p50 [M] | ${n(A.gas.request.p50)} + ${n(A.gas.finalizeEvaluation.p50)} = ${n(A.gasTotal.p50)} | ${n(B.gasTotal.p50)} | ${x(A.gasTotal.p50, B.gasTotal.p50)} |`);
  L.push(`| HCU (request) [M] | ${n(A.hcu.request.p50)} | ${n(B.hcu.request.p50)} (FHE events ${n(B.hcu.fheEvents.p50)}) | — |`);
}
if (mock) {
  L.push(`| Gas, mock (warm) [Mock] | ${n(mock.hotPath.A_requestPlusFinalize_warm)} | ${n(mock.hotPath.B_sync_warm)} | ${x(mock.hotPath.A_requestPlusFinalize_warm, mock.hotPath.B_sync_warm)} |`);
  L.push(`| Setup gas, mock [Mock] (B: ${mock.setup.listR} recipients + ${mock.setup.listS} spenders) | ${n(mock.setup.A.total)} | ${n(mock.setup.B.total)} | ${x(mock.setup.A.total, mock.setup.B.total)} |`);
}
if (setup) {
  L.push(`| Setup gas, Sepolia [M] (B: 1 recipient) | ${n(setup.accounts.a.totalGas)} | ${n(setup.accounts.b.totalGas)} | ${x(setup.accounts.a.totalGas, setup.accounts.b.totalGas)} |`);
  L.push(`| Per list entry in B | — (30 + 10 slots fixed, count hidden) | mock ${n(mock?.setup?.perEntryB)} · Sepolia single-entry setupKnownOpen ${n(stepGas(setup.accounts.b, "setupKnownOpen"))} | — |`);
}
console.log(L.join("\n"));
console.log(`\nSummary → results/f011-summary.json · deployment ${n(deployGas)} gas · cost of the samples ${out.spentEthSamples.toFixed(6)} ETH`);
if (ab?.failures?.length) console.log(`Errors: ${ab.failures.length} → ${JSON.stringify(ab.failures.slice(0, 3))}`);
