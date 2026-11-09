/**
 * F0.10 — PIN attack simulation (Y1), an exact model of the contract semantics. Only K was stolen; the owner keeps the PIN.
 * The attacker makes a wrong guess at every allowed moment (worst case). Measured: the number of guesses and the success
 * probability within 24 h, 7 days and 30 days. Evidence class: [I] (model); the success curve is interpolated from the
 * v0.3 §13.8 data on human-chosen 6-digit PINs without a blacklist: P(10) = 6.5%, P(30) = 8.9%, P(100) = 13.3% (log-linear; linear from 0 below 10).
 *
 * Semantics:
 *   v03 — Round 1 code: the consecutive counter is incremented before the result and stores the next permission; a correct PIN resets
 *         the counter and the restriction; a PIN change resets them too. Escape does not stop guessing (if the PIN is found, the escape is cancelled with K+P).
 *   K43 — F0.10 code (PolicyMath / PinLib): a score; a provisional +1 on every submission, only that +1 is refunded on a correct result; the next
 *         permission = last attempt + back-off(score), derived; the owner's correct PIN also updates the last-attempt time; decay
 *         follows a fixed calendar (7-day boundaries), −1 at each boundary. Restriction: once the K-track score is ≥ 3; UNRESTRICT does not
 *         reset the score. When a rotation executes, the K-track score is reset (the attacker's K is invalid as well).
 * Tables: T0 (v0.3), T1 (strict), T2 (exponential, K46). Locks: K44 escape lock; K45 rotation lock (only if D or a recovery
 * helper exists). With D the owner enters the PIN on its own lane (separate score): it is not held up by the attacker's back-off.
 * Decay phase: the first calendar boundary comes φ ∈ (0, 7 days] after the start of the attack; φ is scanned on an hourly grid and
 * the worst case (most guesses) is reported.
 *
 *   npx ts-node scripts/pin-attack-sim.ts   → results/pin-attack-sim.json
 */
import * as fs from "fs";
import * as path from "path";

const MIN = 60;
const H = 3600;
const D = 86400;
const DECAY = 7 * D;

type Table = { name: string; desc: string; backoff: (n: number) => number };
const T0: Table = {
  name: "T0",
  desc: "v0.3 table: 1–2 → 0; 3 → 15 min; 4–5 → 1 h; 6–9 → 6 h; 10+ → 24 h",
  backoff: (n) => (n <= 2 ? 0 : n === 3 ? 15 * MIN : n <= 5 ? H : n <= 9 ? 6 * H : D),
};
const T1: Table = {
  name: "T1",
  desc: "strict: 1–2 → 0; 3 → 1 h; 4 → 6 h; 5+ → 24 h",
  backoff: (n) => (n <= 2 ? 0 : n === 3 ? H : n === 4 ? 6 * H : D),
};
const T2: Table = {
  name: "T2",
  desc: "exponential (K46): 1–2 → 0; n ≥ 3 → 15 min · 4^(n−3), cap 7 days",
  backoff: (n) => (n <= 2 ? 0 : Math.min(7 * D, 15 * MIN * 4 ** (n - 3))),
};

/** v0.3 §13.8: human-chosen 6-digit PINs without a blacklist. */
function pSuccess(n: number): number {
  if (n <= 0) return 0;
  const pts: [number, number][] = [
    [10, 0.065],
    [30, 0.089],
    [100, 0.133],
  ];
  if (n <= 10) return (0.065 * n) / 10;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (n <= x1) return y0 + ((y1 - y0) * (Math.log(n) - Math.log(x0))) / (Math.log(x1) - Math.log(x0));
  }
  const [x0, y0] = pts[1];
  const [x1, y1] = pts[2];
  const slope = (y1 - y0) / (Math.log(x1) - Math.log(x0));
  return Math.min(1, y1 + slope * (Math.log(n) - Math.log(x1)));
}

type Scenario = "none" | "rotate" | "escape" | "unrestrict";
type Variant = { sem: "v03" | "K43"; table: Table; k44: boolean; k45: boolean; hasD: boolean };
type Cfg = Variant & { scenario: Scenario; reactS: number; phaseS: number };

/** K-track state (the attacker uses only the K-track: the recovery track requires a bond and shares the common budget, K56). */
class KTrack {
  k = 0; // v03: consecutive counter; K43: stored score
  kEpoch = 0; // K43: the calendar slice the score is normalized to
  lastAt = -Infinity;
  nextV03 = 0;
  constructor(private readonly c: Cfg) {
    this.kEpoch = this.epoch(0); // the slice at t = 0 (−1 when φ > 0); starting from 0 added a phantom +1 point
  }
  epoch(t: number) {
    return Math.floor((t - this.c.phaseS) / DECAY);
  }
  eff(t: number) {
    return this.c.sem === "v03" ? this.k : Math.max(0, this.k - Math.max(0, this.epoch(t) - this.kEpoch));
  }
  /** Earliest t ≥ now such that t ≥ last attempt + back-off(score(t)) (the score decays over time → re-checked at calendar boundaries). */
  nextAllowed(now: number): number {
    if (this.c.sem === "v03") return Math.max(now, this.nextV03);
    if (this.lastAt === -Infinity) return now;
    let t = Math.max(now, this.lastAt);
    for (let i = 0; i < 10_000; i++) {
      const need = this.lastAt + this.c.table.backoff(this.eff(t));
      if (t >= need) return t;
      const nb = this.c.phaseS + DECAY * (this.epoch(t) + 1);
      if (need <= nb) return need;
      t = nb;
    }
    throw new Error("nextAllowed did not converge");
  }
  /** Submission (counted before the result). */
  submit(t: number) {
    if (this.c.sem === "v03") {
      this.k += 1;
      this.nextV03 = t + this.c.table.backoff(this.k);
    } else {
      this.k = this.eff(t) + 1;
      this.kEpoch = this.epoch(t);
    }
    this.lastAt = t;
  }
  /** Correct result (owner): v03 resets; K43 refunds only the provisional +1. */
  success(t: number) {
    if (this.c.sem === "v03") {
      this.k = 0;
      this.nextV03 = 0;
    } else {
      this.k = Math.max(0, this.eff(t) - 1);
      this.kEpoch = this.epoch(t);
    }
  }
}

export function simulate(c: Cfg, T: number) {
  const s = new KTrack(c);
  let t = 0;
  let guesses = 0;
  let horizon = T;
  let stopReason = "";
  let ownerPins = 0;
  let restricted = false;
  const reactAt = c.reactS; // first wrong guess at t = 0; the owner reacts r after the first notification
  // pending owner action: time (earliest), on the K-track (no D) or on the lane
  let ownerAt = c.scenario === "rotate" ? reactAt : Infinity;
  const ownerOnLane = c.hasD && c.sem === "K43";

  for (let iter = 0; iter < 1_000_000; iter++) {
    const ta = s.nextAllowed(t);
    let to = Infinity;
    if (ownerAt !== Infinity) to = ownerOnLane ? Math.max(ownerAt, t) : s.nextAllowed(Math.max(ownerAt, t));
    // escape: immediately with K, no PIN
    if (c.scenario === "escape" && reactAt <= Math.min(ta, horizon) && !stopReason) {
      if (c.k44) {
        horizon = Math.min(horizon, reactAt);
        stopReason = "K44: anonymous guessing closed when the escape started";
      } else {
        horizon = Math.min(horizon, reactAt + 30 * D); // the escape executes after 30 days; if the PIN is found before then, it is cancelled
        stopReason = "no K44: guessing continues until the escape executes (30 days)";
      }
    }
    if (Math.min(ta, to) > horizon) break;
    if (to <= ta) {
      // the owner's correct PIN
      t = to;
      ownerPins++;
      if (!ownerOnLane) {
        s.submit(t);
        s.success(t);
      }
      if (c.scenario === "rotate") {
        horizon = Math.min(horizon, t + D); // settings delay 24 h; afterwards the attacker's K is invalid
        if (c.k45 && c.hasD) {
          horizon = Math.min(horizon, t);
          stopReason = "K45: verified rotation closed the K-track";
        } else {
          stopReason = stopReason || "rotation executed after 24 h";
        }
      } else {
        restricted = false; // unrestrict (in v03 a correct PIN already lifts it)
      }
      ownerAt = Infinity;
      continue;
    }
    // the attacker's wrong guess
    t = ta;
    guesses++;
    s.submit(t);
    if (s.eff(t) >= 3 && !restricted) {
      restricted = true;
      if (c.scenario === "unrestrict") ownerAt = t + c.reactS;
    }
  }
  return { guesses, p: pSuccess(guesses), stopReason, ownerPins };
}

const fmt = (x: number) => (x >= D ? `${(x / D).toFixed(1)} d` : x >= H ? `${(x / H).toFixed(1)} h` : x >= MIN ? `${Math.round(x / MIN)} min` : `${x} s`);
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** The owner's typos (K43 + T2): k wrong entries in a row, then the correct PIN; UNRESTRICT if restricted. */
function typoCost(table: Table, sem: "v03" | "K43", typos: number) {
  const waitBeforeCorrect = table.backoff(typos); // the wrong entries come back to back without back-off (n ≤ 2) or with back-off
  const restrictedAfterCorrect = sem === "K43" && typos >= 3;
  const waitBeforeUnrestrict = restrictedAfterCorrect ? table.backoff(typos) : 0; // the owner's PIN updates the last-attempt time
  return {
    table: table.name,
    semantics: sem,
    typos,
    waitBeforeCorrect: fmt(waitBeforeCorrect),
    restrictedAfterCorrect,
    waitBeforeUnrestrict: restrictedAfterCorrect ? fmt(waitBeforeUnrestrict) : "-",
    totalUntilUnrestricted: fmt(waitBeforeCorrect + waitBeforeUnrestrict),
    scoreAfter: sem === "v03" ? 0 : typos,
    maxDaysUntilScoreBelow3: sem === "K43" && typos >= 3 ? (typos - 2) * 7 : 0,
  };
}

function main() {
  const windows = [
    { k: "24h", s: D },
    { k: "7d", s: 7 * D },
    { k: "30d", s: 30 * D },
  ];
  const reacts = [15 * MIN, H, 8 * H];
  const phases = Array.from({ length: 168 }, (_, i) => (i + 1) * H); // φ ∈ (0, 7 days], hourly
  const variants: Variant[] = [
    { sem: "v03", table: T0, k44: false, k45: false, hasD: false },
    { sem: "K43", table: T0, k44: false, k45: false, hasD: false },
    { sem: "K43", table: T0, k44: true, k45: false, hasD: false },
    { sem: "K43", table: T1, k44: true, k45: false, hasD: false },
    { sem: "K43", table: T2, k44: true, k45: false, hasD: false },
    { sem: "K43", table: T2, k44: true, k45: true, hasD: true },
  ];
  const label = (v: Variant) => `${v.sem}/${v.table.name}${v.k44 ? "+K44" : ""}${v.k45 ? "+K45" : ""}${v.hasD ? " (with D)" : v.sem === "K43" && v.table === T2 ? " (no D)" : ""}`;
  const rows: any[] = [];
  for (const v of variants) {
    for (const scenario of ["none", "rotate", "escape", "unrestrict"] as const) {
      for (const reactS of scenario === "none" ? [0] : reacts) {
        const r: any = { variant: label(v), final: v.sem === "K43" && v.table === T2 && v.k44, scenario, react: scenario === "none" ? "-" : fmt(reactS) };
        for (const w of windows) {
          const runs = (v.sem === "v03" ? [DECAY] : phases).map((phaseS) => simulate({ ...v, scenario, reactS, phaseS }, w.s));
          const g = runs.map((x) => x.guesses);
          const worst = runs[g.indexOf(Math.max(...g))];
          r[w.k] = {
            guesses: worst.guesses,
            pSuccessPct: Math.round(worst.p * 1000) / 10,
            guessesMinMedianMax: [Math.min(...g), median(g), Math.max(...g)],
            ownerPinEntries: worst.ownerPins,
            stopReason: worst.stopReason || null,
          };
        }
        rows.push(r);
      }
    }
  }
  const typos = [T0, T2].flatMap((tb) => (["v03", "K43"] as const).flatMap((sem) => [1, 2, 3, 4].map((k) => typoCost(tb, sem, k))));
  const ownerLockout = [3, 4, 5, 6, 7, 8].map((s) => ({
    scoreAfterAttack: s,
    ownerWaitBetweenKTrackPins: fmt(T2.backoff(s)),
    note: s >= 3 ? "on the K-track every PIN entry updates the last-attempt time; remedies: lane (D), rotation (score is reset), escape or decay" : "",
  }));
  const out = {
    evidence: "[I] model (event-driven simulation; an exact model of the F0.10 contract semantics); success curve interpolated from v0.3 §13.8",
    generatedAtUtc: new Date().toISOString(),
    tables: [T0, T1, T2].map((t) => ({ name: t.name, desc: t.desc })),
    assumptions: [
      "The attacker guesses at every allowed moment; all guesses are wrong (the success probability comes separately from the curve). It uses only the K-track: the recovery track requires a bond and shares the common budget (K56), so it gives no advantage.",
      "First wrong guess at t = 0; the owner reacts r after the first notification.",
      "rotate: the owner verifies the rotation with K+P (without D on the K-track, waiting out the attacker's back-off; with D on the lane, without waiting); the rotation executes after 24 h. K45 (only with D/recovery helper) closes the K-track as soon as it is verified.",
      "escape: the owner starts an escape with K (no PIN). K44: anonymous guessing closes immediately. Without K44 the attacker keeps guessing for 30 days (if the PIN is found, the escape is cancelled with K+P).",
      "unrestrict: r after each restriction the owner lifts it with the PIN (in v03 the counter is reset every time; in K43 the score is kept and the owner's PIN updates the last-attempt time).",
      "Decay (K43): fixed calendar, −1 every 7 days; the phase φ of the first boundary is scanned on an hourly grid and the worst phase is reported (guessesMinMedianMax: over the phases).",
      "Below 10 guesses the success probability is linear from 0 (the real curve is concave; higher for the first guesses).",
    ],
    rows,
    ownerTypos: typos,
    ownerLockout,
  };
  fs.writeFileSync(path.join(__dirname, "..", "results", "pin-attack-sim.json"), JSON.stringify(out, null, 2));
  for (const r of rows) {
    if (r.react !== "-" && r.react !== "1.0 h") continue;
    console.log(
      `${r.variant.padEnd(26)} ${r.scenario.padEnd(10)} r=${String(r.react).padEnd(6)} 24h: ${String(r["24h"].guesses).padStart(4)} (${r["24h"].pSuccessPct}%)  7d: ${String(r["7d"].guesses).padStart(4)} (${r["7d"].pSuccessPct}%)  30d: ${String(r["30d"].guesses).padStart(4)} (${r["30d"].pSuccessPct}%) [${r["30d"].guessesMinMedianMax.join("/")}] ${r["30d"].stopReason ?? ""}`,
    );
  }
}

if (require.main === module) main();
export { T0, T1, T2 };
