// F0.16 — Sepolia summary: F0.15 step 2 (run f015b) vs F0.16 (run f016), same scripts, accounts, delays and amount.
//   node scripts/f016-sepolia-summary.mjs   → results/sepolia/f016-summary.json
// Inputs: results/sepolia/{setup,e1,hot-path}-{f015b,f016}.json. p50 values (the first sample of a run can include
// day-first effects); gas is Sepolia's (a new storage slot ≈ 111k gas, F0.15 measurement).
import fs from "node:fs";
import path from "node:path";

const S = path.join(process.cwd(), "results", "sepolia");
const load = (f) => JSON.parse(fs.readFileSync(path.join(S, f), "utf8"));
const runs = ["f015b", "f016"];
const data = Object.fromEntries(runs.map((r) => [r, { setup: load(`setup-${r}.json`), e1: load(`e1-${r}.json`), hot: load(`hot-path-${r}.json`) }]));

const p50 = (x) => (x && typeof x.p50 === "number" ? x.p50 : null);
const row = (label, get) => {
  const a = get(data.f015b);
  const b = get(data.f016);
  return { step: label, f015b: a, f016: b, delta: a != null && b != null ? b - a : null };
};
const setupRow = (step) =>
  row(`setup ${step}`, (d) => {
    const r = d.setup.accounts.e1.rows.find((x) => x.step === step);
    return r ? r.gas : null;
  });

const gasRows = [
  ...["createAccount", "setupPin", "setupAsset", "setupKnownR0", "setupKnownR12", "setupKnownR24", "setupKnownS0", "setupRoles", "arm"].map(setupRow),
  row("setup total (e1 account, without funding)", (d) => d.setup.accounts.e1.totalGas),
  row("PIN path: requestTransfer", (d) => p50(d.e1.summary.gas.open)),
  row("PIN path: submitGuess", (d) => p50(d.e1.summary.gas.submitGuess)),
  row("PIN path: finalizeGuess", (d) => p50(d.e1.summary.gas.finalizeGuess)),
  row("PIN path: executeOp", (d) => p50(d.e1.summary.gas.executeOp)),
  row("K-only: requestTransfer", (d) => p50(d.hot.summary.gas.request)),
  row("K-only: finalizeEvaluation", (d) => p50(d.hot.summary.gas.finalizeEvaluation)),
];
const latency = {
  e1TotalMs: Object.fromEntries(runs.map((r) => [r, data[r].e1.summary.totalMs])),
  hotTotalMs: Object.fromEntries(runs.map((r) => [r, data[r].hot.summary.totalMs])),
};
const f016 = data.f016;
const bonds = f016.e1.samples.map((s) => s.bondWei ?? null);
const out = {
  evidence: "[M] Sepolia (gas: receipts; latency: wall clock from the user's click/PIN to the result) — F0.15 step 2 (f015b) vs F0.16 (f016)",
  generatedAtUtc: new Date().toISOString(),
  samples: Object.fromEntries(runs.map((r) => [r, { e1: data[r].e1.summary.nOk, hot: data[r].hot.summary.nOk }])),
  f016: {
    contracts: f016.setup.contracts,
    implConfig: f016.setup.implConfig,
    bondWeiPerGuess: [...new Set(bonds)],
    claimRefund: f016.e1.claimRefund ?? null,
    failures: { e1: f016.e1.failures?.length ?? 0, hot: f016.hot.failures?.length ?? 0 },
  },
  gas: gasRows,
  latency,
};
fs.writeFileSync(path.join(S, "f016-summary.json"), JSON.stringify(out, null, 2));
console.table(gasRows);
console.log("E1 total ms p50/p95:", runs.map((r) => `${r} ${latency.e1TotalMs[r].p50}/${latency.e1TotalMs[r].p95}`).join(" · "));
console.log("K-only total ms p50/p95:", runs.map((r) => `${r} ${latency.hotTotalMs[r].p50}/${latency.hotTotalMs[r].p95}`).join(" · "));
console.log("samples:", JSON.stringify(out.samples), "bond per guess:", out.f016.bondWeiPerGuess, "claimRefund:", JSON.stringify(out.f016.claimRefund));
