// SPIKE T5 — "deniability budget": when does a decoy balance stop being believable, given what the chain shows?
//   node scripts/spike/deniability-model.mjs            → prints the tables, writes results/spike/deniability-model.json
//
// What the chain shows about a private-mode account (ERC-7984):
//   - every shield (wrap) and unshield (unwrap) with its amount: public
//   - every confidential transfer in or out: public as an event (from, to), amount hidden
// A coercer who reads this anchors on N = shielded − unshielded and asks: could the hidden transfers since then have
// brought the balance down to the decoy D the victim shows? If not, the decoy is not believable.
//
// Model 1 (closed form): k hidden outflows since the last public shield, amounts i.i.d. exponential with mean mu (the
// coercer's idea of a typical payment). Spent total T ~ Gamma(k, mu). The coercer's probability that the balance is
// at most D:  c = P(T >= N − D) = P(Poisson(r) <= k − 1),  r = (N − D) / mu.  With k = 0, c = 0 for any D < N.
// Model 2 (Monte Carlo): heavier-tailed payments (log-normal, same mean) and hidden inflows of unknown size.
//
// It ignores everything off-chain (exchange data leaks, social media, the victim's lifestyle) and timing patterns. It
// is a guide for the app's warnings, not a guarantee.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** P(Poisson(r) <= k-1) = P(Gamma(k, 1) >= r): the coercer's credibility of the decoy under model 1. */
function credExp(k, r) {
  if (r <= 0) return 1;
  if (k <= 0) return 0;
  let term = Math.exp(-r);
  let sum = term;
  for (let i = 1; i < k; i++) {
    term *= r / i;
    sum += term;
  }
  return Math.min(1, sum);
}

// deterministic PRNG (mulberry32) so the Monte Carlo tables are reproducible
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(20261115);
const expo = (mean) => -mean * Math.log(1 - R());
function normal() {
  const u = 1 - R();
  const v = R();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** log-normal with the given mean and sigma = 1 (a few large payments, many small ones) */
const lognormal = (mean, sigma = 1) => Math.exp(Math.log(mean) - (sigma * sigma) / 2 + sigma * normal());

/**
 * Model 2: the coercer's credibility P(balance <= D) given N public, kOut hidden outflows (payments drawn from `pay`)
 * and kIn hidden inflows (drawn from `inc`). Outflows cannot take the balance below zero.
 */
function credMC({ N, D, kOut, kIn = 0, pay, inc = () => 0, n = 100_000 }) {
  let hit = 0;
  for (let s = 0; s < n; s++) {
    let b = N;
    for (let i = 0; i < kIn; i++) b += inc();
    for (let j = 0; j < kOut; j++) b = Math.max(0, b - pay());
    if (b <= D) hit++;
  }
  return hit / n;
}

const pct = (x) => (x >= 0.995 ? ">99%" : x < 0.005 ? (x === 0 ? "0%" : "<1%") : `${Math.round(100 * x)}%`);

// ── Table 1: model 1, credibility by number of hidden payments k and gap r = (N − D) / mu
const ks = [0, 5, 10, 15, 20, 30, 40, 60];
const rs = [5, 10, 20, 40];
const table1 = ks.map((k) => ({ k, ...Object.fromEntries(rs.map((r) => [`r=${r}`, credExp(k, r)])) }));

// ── Table 2: a concrete account. 10,000 shielded at once, decoy 2,000 (so N − D = 8,000), three payment sizes
const N2 = 10_000;
const D2 = 2_000;
const mus = [200, 500, 1_000];
const table2 = [0, 5, 10, 20, 40].map((k) => ({
  k,
  ...Object.fromEntries(mus.flatMap((mu) => [[`exp mu=${mu}`, credExp(k, (N2 - D2) / mu)], [`lognormal mu=${mu}`, credMC({ N: N2, D: D2, kOut: k, pay: () => lognormal(mu) })]])),
}));

// ── Table 3: how the decoy should scale with what was shielded (model 1, k = 10 payments of mean 500)
const table3 = [1_000, 5_000, 10_000, 50_000].map((N) => ({
  N,
  ...Object.fromEntries([0.05, 0.2, 0.5, 0.8].map((f) => [`D=${f * 100}% of N`, credExp(10, (N - f * N) / 500)])),
  "smallest D for 50%": Math.round(Math.max(0, N - medianGamma(10) * 500)),
}));
function medianGamma(k) {
  // smallest r with P(Gamma(k,1) >= r) <= 0.5 (the median of the spent total in units of mu)
  let lo = 0;
  let hi = 10 * k + 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (credExp(k, mid) > 0.5) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Table 4: scenarios (model 2). The coercer knows counts, not amounts; inflow sizes he guesses at mean 500.
const scen = [
  { name: "A · 10,000 shielded in one go yesterday, 2 payments since", N: 10_000, D: 2_000, kOut: 2, kIn: 0, truth: "≈ 9,000" },
  { name: "B · 10,000 shielded 3 months ago, 40 payments since", N: 10_000, D: 2_000, kOut: 40, kIn: 0, truth: "≈ 4,000" },
  { name: "C · 2,000 shielded, the rest (8,000) came in 4 hidden transfers", N: 2_000, D: 2_000, kOut: 5, kIn: 4, truth: "≈ 8,500" },
  { name: "D · 500 shielded per week for 20 weeks, 30 payments since", N: 10_000, D: 2_000, kOut: 30, kIn: 0, truth: "≈ 6,000" },
  { name: "E · same as A, decoy raised to 8,000", N: 10_000, D: 8_000, kOut: 2, kIn: 0, truth: "≈ 9,000" },
].map((x) => ({ ...x, credibility: credMC({ N: x.N, D: x.D, kOut: x.kOut, kIn: x.kIn, pay: () => lognormal(400), inc: () => expo(500) }) }));

// ── rule of thumb: hidden payments needed for 50% credibility ≈ (N − D) / mu (the Gamma median ≈ k − 1/3)
const rule = [
  { N: 10_000, D: 2_000, mu: 400, paymentsFor50: Math.ceil((10_000 - 2_000) / 400 + 1 / 3) },
  { N: 10_000, D: 5_000, mu: 400, paymentsFor50: Math.ceil((10_000 - 5_000) / 400 + 1 / 3) },
  { N: 100_000, D: 10_000, mu: 2_000, paymentsFor50: Math.ceil((100_000 - 10_000) / 2_000 + 1 / 3) },
];

const out = {
  generatedAt: new Date().toISOString(),
  model: "SPIKE T5: coercer anchors on N = shielded − unshielded; hidden payments (exponential or log-normal, mean mu) and hidden inflows widen his estimate",
  table1_exponential_k_by_r: table1,
  table2_N10000_D2000: table2,
  table3_decoy_vs_shielded_k10_mu500: table3,
  table4_scenarios_mc: scen,
  ruleOfThumb: rule,
};
fs.mkdirSync(path.join(ROOT, "results", "spike"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "results", "spike", "deniability-model.json"), JSON.stringify(out, null, 2) + "\n");

const PLAIN = new Set(["k", "N", "D", "mu", "paymentsFor50", "smallest D for 50%", "true balance", "scenario"]);
const md = (rows) => {
  const cols = Object.keys(rows[0]);
  const fmt = (c, v) => (typeof v === "number" && !PLAIN.has(c) ? pct(v) : typeof v === "number" ? v.toLocaleString("en-US") : String(v));
  return [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${cols.map((c) => fmt(c, r[c])).join(" | ")} |`)].join("\n");
};
console.log("Table 1 — credibility P(balance <= D), exponential payments; k hidden payments, r = (N − D)/mu\n" + md(table1));
console.log("\nTable 2 — N = 10,000 shielded, D = 2,000\n" + md(table2));
console.log("\nTable 3 — k = 10 payments of mean 500\n" + md(table3));
console.log("\nTable 4 — scenarios (log-normal payments mean 400, hidden inflows guessed at mean 500)\n" + md(scen.map(({ name, credibility, truth }) => ({ scenario: name, "true balance": truth, credibility }))));
console.log("\nRule of thumb\n" + md(rule));
