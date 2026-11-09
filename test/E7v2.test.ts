import { expect } from "chai";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { debugU64, ethers } from "./helpers";

/**
 * E7-v2 (F0.10, K47) — the v1 and v2 formulas of the tripwire threshold τ.
 *   v1: τ = L_min + ((L − L_min) >> 16) · r
 *   v2: D = min(L − L_min, 2^48 − 1),  τ = L_min + ((D · r) >> 16)          (r ∈ [0, 2^16), L normalized to ≥ L_min)
 * 1) Exact distribution [I]: all 65 536 values of r for each D (no randomness): range, coverage, uniformity over 16 buckets.
 * 2) Mock [Mock]: 1 024 v2 draws for each of two D values on TauBench, chi-square (16 buckets, df = 15); v1's narrow-range bug.
 * 3) HCU [Mock]: a single draw, v1 / v2 (the same HCU table holds on the live chain: in F0.9 blockMeter = computed from events).
 * Criterion (§7.2 / K47): coverage ≥ 99% for 2^16 ≤ D < 2^48; for D ≥ 2^48 coverage is [L_min, L_min + 2^48) by design.
 * Output: results/e7-v2.json
 */
const TWO16 = 1n << 16n;
const CAP = (1n << 48n) - 1n;
const D_LIST: [string, bigint][] = [
  ["0", 0n],
  ["1", 1n],
  ["1 000", 1000n],
  ["65 535", 65535n],
  ["65 536", 65536n],
  ["131 071", 131071n],
  ["2^20", 1n << 20n],
  ["2^40", 1n << 40n],
  ["2^50", 1n << 50n],
];
const CHI2_DF15_P001 = 37.697; // chi-square critical value, df = 15, p = 0.001

const off = (v: 1 | 2, D: bigint, r: bigint) => (v === 1 ? (D >> 16n) * r : ((D < CAP ? D : CAP) * r) >> 16n);

/** 16 buckets: the value range [0, Deff) is split by integer width; expected share = bucket width / Deff. */
function bucketsOf(Deff: bigint) {
  const k = Deff >= 16n ? 16 : Number(Deff);
  const edges: bigint[] = [];
  for (let i = 0; i <= k; i++) edges.push((Deff * BigInt(i)) / BigInt(k));
  return edges; // bucket i: [edges[i], edges[i+1])
}
function bucketIndex(edges: bigint[], x: bigint) {
  let lo = 0;
  let hi = edges.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (x >= edges[mid]) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
function chi2(counts: number[], edges: bigint[], Deff: bigint, n: number) {
  let s = 0;
  for (let i = 0; i < counts.length; i++) {
    const e = (n * Number(edges[i + 1] - edges[i])) / Number(Deff);
    s += ((counts[i] - e) * (counts[i] - e)) / e;
  }
  return s;
}

function exactRow(v: 1 | 2, label: string, D: bigint) {
  const Deff = v === 2 && D > CAP ? CAP : D; // design range (v2 cuts off at 2^48)
  if (D === 0n) return { version: `v${v}`, D: label, Dvalue: "0", tauAlwaysLmin: true, inRange: true, note: "empty range: τ = L_min (an input with L < L_min is normalized to this case by max)" };
  let min = -1n;
  let max = 0n;
  const distinct = new Set<string>();
  const edges = bucketsOf(Deff);
  const counts = new Array(edges.length - 1).fill(0);
  let inRange = true;
  for (let r = 0n; r < TWO16; r++) {
    const o = off(v, D, r);
    if (min < 0n || o < min) min = o;
    if (o > max) max = o;
    distinct.add(o.toString());
    if (o >= D && D > 0n) inRange = false; // v2: τ < L; v1: τ ≤ L (o = D would need D/2^16·(2^16−1) = D, which cannot happen)
    if (o < Deff) counts[bucketIndex(edges, o)]++;
    else if (v === 1) counts[counts.length - 1]++; // o = D cannot happen in v1; defensive
  }
  const coverageDesign = Number(max + 1n) / Number(Deff); // farthest point reached in [L_min, L_min + Deff)
  const coverageFull = Number(max + 1n) / Number(D);
  const exp = 65536 / counts.length;
  const maxDev = Math.max(...counts.map((c, i) => Math.abs(c - (65536 * Number(edges[i + 1] - edges[i])) / Number(Deff)) / exp));
  return {
    version: `v${v}`,
    D: label,
    Dvalue: D.toString(),
    inRange,
    minOffset: min.toString(),
    maxOffset: max.toString(),
    distinct: distinct.size,
    coverageDesignPct: Math.round(coverageDesign * 1e5) / 1e3,
    coverageFullRangePct: Math.round(coverageFull * 1e5) / 1e3,
    buckets: counts.length,
    exactChi2: Math.round(chi2(counts, edges, Deff, 65536) * 1e4) / 1e4,
    maxBucketDeviationPct: Math.round(maxDev * 1e5) / 1e3,
  };
}

describe("E7-v2 — τ formula (K47): exact distribution, mock draws, HCU", function () {
  const out: any = {
    evidence: { exact: "[I] exact computation over all 65 536 values of r", mock: "[Mock] TauBench, @fhevm/hardhat-plugin 0.13.0-1", hcu: "[Mock] host HCU table (F0.9: same on the live chain)" },
    generatedAtUtc: new Date().toISOString(),
    criterion: "coverage ≥ 99% for 2^16 ≤ D < 2^48 (v2); for D ≥ 2^48 coverage is [L_min, L_min + 2^48) by design",
  };

  after(() => {
    fs.writeFileSync(path.join(__dirname, "..", "results", "e7-v2.json"), JSON.stringify(out, null, 2));
  });

  it("exact distribution: v2 stays in range; coverage ≥ 99% for 2^16 ≤ D < 2^48; uniform on narrow ranges too; v1's gaps are visible", () => {
    out.exact = [];
    for (const [label, D] of D_LIST) for (const v of [1, 2] as const) out.exact.push(exactRow(v, label, D));
    const v2 = out.exact.filter((x: any) => x.version === "v2" && x.Dvalue !== "0");
    for (const row of v2) {
      expect(row.inRange, `v2 D=${row.D}`).to.eq(true);
      const D = BigInt(row.Dvalue);
      if (D >= TWO16 && D <= CAP) expect(row.coverageDesignPct, `v2 coverage D=${row.D}`).to.be.gte(99);
      if (D >= 16n) expect(row.maxBucketDeviationPct, `v2 uniformity D=${row.D}`).to.be.lt(1);
      if (D < TWO16) expect(row.distinct, `v2 D=${row.D}: every value reachable`).to.eq(Number(D));
    }
    const v1 = (lbl: string) => out.exact.find((x: any) => x.version === "v1" && x.D === lbl);
    expect(v1("1 000").maxOffset).to.eq("0"); // v1: D < 2^16 → τ always L_min (Y2)
    expect(v1("131 071").coverageDesignPct).to.be.lt(51); // v1: 2^16 ≤ D < 2^17 → half coverage
    const v2at = (lbl: string) => out.exact.find((x: any) => x.version === "v2" && x.D === lbl);
    expect(v2at("2^50").coverageFullRangePct).to.be.lt(26); // by design: [L_min, L_min + 2^48)
    console.table(out.exact.map((x: any) => ({ v: x.version, D: x.D, inRange: x.inRange, coverageDesign: x.coverageDesignPct, coverageFull: x.coverageFullRangePct, distinct: x.distinct, bucketDevPct: x.maxBucketDeviationPct })));
  });

  it("mock: 1 024 v2 draws for each of two D values are in range and uniform (χ², 16 buckets); v1 sticks to L_min on a narrow range; HCU v1/v2", async () => {
    const b: any = await (await ethers.getContractFactory("TauBench")).deploy();
    await b.waitForDeployment();
    const LMIN = 100_000n;
    const draw = async (v: 1 | 2, n: number, batch = 16) => {
      const handles: string[] = [];
      for (let done = 0; done < n; done += batch) {
        const k = Math.min(batch, n - done);
        const rc = await (await (v === 1 ? b.drawV1(k) : b.drawV2(k))).wait();
        for (const log of rc.logs) {
          try {
            const ev = b.interface.parseLog(log);
            if (ev?.name === "Drawn") handles.push(ev.args.handle);
          } catch {
            /* coprocessor event */
          }
        }
      }
      // sequential: the alpha plugin's debug decryptor answers hundreds of concurrent requests with a native crash
      const vals: bigint[] = [];
      for (const h of handles) vals.push(await debugU64(h));
      return vals;
    };
    out.mock = [];
    for (const D of [1000n, 131071n]) {
      await (await b.setBounds(LMIN, LMIN + D)).wait();
      const taus = await draw(2, 1024);
      const edges = bucketsOf(D);
      const counts = new Array(edges.length - 1).fill(0);
      for (const t of taus) {
        expect(t >= LMIN && t < LMIN + D, `τ=${t}`).to.eq(true);
        counts[bucketIndex(edges, t - LMIN)]++;
      }
      const x2 = chi2(counts, edges, D, taus.length);
      const v1taus = await draw(1, 16);
      out.mock.push({
        D: D.toString(),
        draws: taus.length,
        buckets: counts,
        chi2: Math.round(x2 * 100) / 100,
        chi2CriticalDf15P001: CHI2_DF15_P001,
        min: (taus.reduce((a, c) => (c < a ? c : a)) - LMIN).toString(),
        max: (taus.reduce((a, c) => (c > a ? c : a)) - LMIN).toString(),
        v1Sample: { draws: v1taus.length, distinctOffsets: new Set(v1taus.map((t) => (t - LMIN).toString())).size, maxOffset: (v1taus.reduce((a, c) => (c > a ? c : a)) - LMIN).toString() },
      });
      expect(x2, `χ² D=${D}`).to.be.lt(CHI2_DF15_P001);
      if (D < TWO16) expect(v1taus.every((t) => t === LMIN)).to.eq(true);
    }
    // L < L_min input: max normalization → D = 0 → τ = L_min
    await (await b.setBounds(LMIN, LMIN - 5n)).wait();
    const inv = await draw(2, 8);
    expect(inv.every((t) => t === LMIN)).to.eq(true);
    out.mock.push({ D: "L < L_min (normalize → 0)", draws: inv.length, allEqualLmin: true });

    // HCU: a single draw
    await (await b.setBounds(LMIN, LMIN + 200_000n)).wait();
    const h1 = hre.fhevm.computeTransactionHCU(await (await b.drawV1(1)).wait());
    const h2 = hre.fhevm.computeTransactionHCU(await (await b.drawV2(1)).wait());
    out.hcu = {
      v1PerDraw: { total: Number(h1.globalHCU), depth: Number(h1.maxHCUDepth) },
      v2PerDraw: { total: Number(h2.globalHCU), depth: Number(h2.maxHCUDepth) },
      deltaTotal: Number(h2.globalHCU) - Number(h1.globalHCU),
      note: "v2 = v1 + one scalar min (euint64); mul is euint64 × euint64 in both versions",
    };
    console.log("      E7-v2 mock:", JSON.stringify(out.mock.map((m: any) => ({ D: m.D, chi2: m.chi2, v1: m.v1Sample?.distinctOffsets }))), "HCU", JSON.stringify(out.hcu));
    expect(out.hcu.deltaTotal).to.be.gt(0);
  });
});
