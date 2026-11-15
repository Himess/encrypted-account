// SPIKE T3 on Sepolia — real-PIN vs duress-PIN transactions, compared after the warm-up.
//   node scripts/spike/sepolia-t3-compare.mjs   (after sepolia-private.ts; adds "T3steady" to private-mode-sepolia.json)
// The first PIN-gated op of the account (T2 #1, real PIN) also opens the per-track guess record and other one-time slots,
// so it is the warm-up: a pair is compared only when both sides find the same storage already in use. The duress view #1
// that is stored ran after T2 #1, so it is compared with T2 #2 as well (both warm).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "results", "spike", "sepolia");
const st = JSON.parse(fs.readFileSync(path.join(DIR, "state.json"), "utf8"));
const METRICS = ["exec", "hcu", "hcuDepth", "calldataLen", "logs", "aclAllowed"];
const TXS = ["open", "guess", "finalize"];

const diffs = [];
const pairs = [];
const cmp = (name, a, b) => {
  pairs.push(name);
  for (const tx of TXS) for (const m of METRICS) if (JSON.stringify(a[tx].shape[m]) !== JSON.stringify(b[tx].shape[m])) diffs.push({ pair: name, tx, metric: m, real: a[tx].shape[m], duress: b[tx].shape[m] });
};
const t2 = st.t2 ?? [];
const d = st.t3views ?? [];
for (let i = 1; i < Math.min(t2.length, d.length); i++) cmp(`view: real #${i + 1} vs duress #${i + 1}`, t2[i], d[i]);
if (t2[1] && d[0]) cmp("view: real #2 vs duress #1", t2[1], d[0]);
const tr = st.t3transfers ?? [];
for (let k = 0; k + 1 < tr.length; k += 2) cmp(`transfer ${k / 2 + 1}: real vs duress`, tr[k], tr[k + 1]);

// total gas differences that remain: calldata zero bytes (−12 gas each) explain them?
const totals = [];
const pairList = [];
for (let i = 1; i < Math.min(t2.length, d.length); i++) pairList.push([t2[i], d[i]]);
for (const [a, b] of pairList) for (const tx of TXS) totals.push({ tx, gasDiff: a[tx].shape.gasUsed - b[tx].shape.gasUsed, zeroDiff: a[tx].shape.zeroBytes - b[tx].shape.zeroBytes });
const warm = t2[0] && d[0] ? TXS.map((tx) => ({ tx, firstRealGas: t2[0][tx].shape.gasUsed, warmRealGas: t2[1]?.[tx].shape.gasUsed })) : [];

const out = {
  comparedPairs: pairs,
  txCompared: pairs.length * 3,
  metrics: METRICS,
  differences: diffs.length,
  list: diffs.slice(0, 20),
  totalGas: { pairs: totals.length, allExplainedByCalldataZeroBytes: totals.every((t) => t.gasDiff === -12 * t.zeroDiff), maxAbsDiff: Math.max(0, ...totals.map((t) => Math.abs(t.gasDiff))) },
  warmUp: { note: "T2 #1 is the account's first PIN-gated op: it opens one-time slots (see slots.json), so it is not paired", gas: warm },
  viewsCorrect: d.every((r) => r.correct),
  t2Correct: t2.every((r) => r.correct),
};
const file = path.join(DIR, "private-mode-sepolia.json");
if (fs.existsSync(file)) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  j.T3steady = out;
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
}
console.log(JSON.stringify(out, null, 2));
