// F0.16 — mock cost difference (F0.15 → F0.16): owner-track bond, adjustable base bond, protocol fee.
//   node scripts/f016-cost-diff.mjs   → results/f016-cost-diff.json
// Input: results/cost-model-mock-f015.json (test/CostModel.test.ts on the F0.15 account contracts, commit 6fda10b, run in a
// worktree) and results/cost-model-mock.json (F0.16, the same test with the testnet default fee table). Both were run
// back to back, so the same UTC day and decay slice apply.
import fs from "node:fs";
import path from "node:path";

const R = path.join(process.cwd(), "results");
const load = (f) => JSON.parse(fs.readFileSync(path.join(R, f), "utf8"));
const before = load("cost-model-mock-f015.json");
const after = load("cost-model-mock.json");
const old = new Map(before.rows.map((r) => [r.flow, r]));
const rows = [];
for (const r of after.rows) {
  const o = old.get(r.flow);
  rows.push({
    flow: r.flow,
    gasF015: o ? o.gas : null,
    gasF016: r.gas,
    gasDelta: o ? r.gas - o.gas : null,
    hcuF015: o ? o.hcuTotal : null,
    hcuF016: r.hcuTotal,
    hcuDelta: o ? r.hcuTotal - o.hcuTotal : null,
    isNew: !o,
  });
}
const changed = rows.filter((r) => r.isNew || r.gasDelta !== 0 || r.hcuDelta !== 0);
const out = {
  evidence: "[Mock] Hardhat EDR (prague) gas; HCU host table (F0.9: the same on the live chain)",
  generatedAtUtc: new Date().toISOString(),
  runs: { f015: before.generatedAt, f016: after.generatedAt },
  setup: "F0.16 run: FeeConfig with ETH 10 bps, min 0.00001 ETH, max 0.001 ETH (the testnet default); the account's base bond set to 0.01 ETH at setup. Each PIN guess carries the required bond (0.001 ETH at score 0).",
  notes: [
    "HCU: no FHE operation was added or removed (the bond, the fee and the base bond are plaintext).",
    "New storage slots (≈111k gas each on Sepolia, F0.15 measurement): none on any transfer. op.fee is packed with op.counterparty (never zero for a transfer; op.target is zero for ETH, and an early layout that packed the fee there opened a new slot on every ETH transfer: +20.8k on the mock, caught in this measurement). The K-track refund is packed with the owner address (never zero); the guess record keeps the bond in the slot every guess writes anyway; ownerBondUnits shares an existing account slot.",
    "requestTransfer (both paths, +9.4k): one external view call (FeeConfig.quote, cold account + two cold reads, ≤ 50k gas cap) and the fee written into a slot this transaction has already written.",
    "finalizeGuess (+3.5k): a correct K-track guess credits the bond next to the owner address. executeOp (+15.5k): the balance check, the FeeConfig.feeRecipient read and the fee transfer. submitGuess (−1.0k/−1.3k): the K-track no longer writes a payer field.",
    "startEscape (−17.1k) is an artefact of this run's setup: setupOwnerBond wrote the account slot that the escape snapshot shares, so the snapshot overwrites instead of opening it. With the default bond (no setupOwnerBond) startEscape costs what it did in F0.15.",
    "Recovery-track bonds keep the per-payer refunds map as before F0.16 (a payer's first credit opens its entry once; it is stored as value + 1 afterwards, so it never returns to zero).",
  ],
  changed,
  unchangedRows: rows.length - changed.length,
  all: rows,
};
fs.writeFileSync(path.join(R, "f016-cost-diff.json"), JSON.stringify(out, null, 2));
console.table(changed.map(({ flow, gasF015, gasF016, gasDelta, hcuDelta }) => ({ flow: flow.slice(0, 70), gasF015, gasF016, gasDelta, hcuDelta })));
console.log(`unchanged rows: ${out.unchangedRows}`);
