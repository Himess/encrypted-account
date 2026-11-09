// F0.10 — mock cost difference (Round 1 → F0.10) and contract sizes.
//   node scripts/f010-cost-diff.mjs   → results/f010-cost-diff.json
// Input: results/cost-model-mock-round1.json (Round 1, saved copy) and results/cost-model-mock.json (F0.10, CostModel.test.ts).
import fs from "node:fs";
import path from "node:path";

const R = path.join(process.cwd(), "results");
const round1 = JSON.parse(fs.readFileSync(path.join(R, "cost-model-mock-round1.json"), "utf8")).rows;
const f010 = JSON.parse(fs.readFileSync(path.join(R, "cost-model-mock.json"), "utf8")).rows;
const rename = { "factory.createAccount (clone + initialize + E_addr EIP-712 consent)": "factory.createAccount (clone + initialize)" };
const key = (f) => rename[f] ?? f;
const old = new Map(round1.map((r) => [r.flow, r]));
const rows = [];
for (const r of f010) {
  if (r.gas === 0 && r.hcuTotal === 0) continue; // info rows
  const o = old.get(key(r.flow));
  if (!o) continue;
  if (o.gas === r.gas && o.hcuTotal === r.hcuTotal) continue; // unchanged micro-measurements
  rows.push({ flow: r.flow, gasRound1: o.gas, gasF010: r.gas, gasDelta: r.gas - o.gas, hcuRound1: o.hcuTotal, hcuF010: r.hcuTotal, hcuDelta: r.hcuTotal - o.hcuTotal });
}
const unchanged = f010.filter((r) => {
  const o = old.get(key(r.flow));
  return o && o.gas === r.gas && o.hcuTotal === r.hcuTotal;
}).length;
const sizesFile = path.join(R, "contract-sizes-f010.json");
const out = {
  evidence: "[Mock] Hardhat EDR (prague) gas; HCU host table (F0.9: same on the live chain)",
  generatedAtUtc: new Date().toISOString(),
  note: "On Sepolia (post-fork) a new storage slot costs ≈ 111k gas; F0.10 adds no new slots (the new fields fit into existing slots), the shared budget slot was removed; the escape snapshot takes 1 new slot at escape time.",
  changed: rows,
  unchangedRows: unchanged,
  sizes: fs.existsSync(sizesFile) ? JSON.parse(fs.readFileSync(sizesFile, "utf8")) : null,
};
fs.writeFileSync(path.join(R, "f010-cost-diff.json"), JSON.stringify(out, null, 2));
console.table(rows);
console.log(`unchanged rows: ${unchanged}`);
