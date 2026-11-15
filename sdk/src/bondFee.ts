/**
 * F0.16 — the K-track (TRACK_OWNER) bond and the protocol fee, mirrored from the contracts so the app can show both
 * before the PIN keypad opens.
 *
 *  - Bond (PolicyMath.ownerBondFor): a K-track guess carries a bond, paid by K's EOA in a direct call (never by the
 *    account, never through the EntryPoint). A wrong guess leaves it in the account; a correct one credits it back to
 *    the payer (claimRefund). score == 0 → BASE_BOND; score ≥ 1 → max(BASE_BOND << min(score, 20),
 *    ownerBaseBond << min(score − 1, 20)). With the default ownerBaseBond (= BASE_BOND) this is the recovery track's
 *    doubling. The lane (TRACK_LANE) and the escape stay unbonded.
 *  - Fee (FeeConfig.quote): PIN-verified ETH / ERC-20 transfers pay clamp(amount · bps / 10 000, minFee, maxFee),
 *    never more than 1% of the amount, on top of the amount (the payee gets the exact amount). The fee is bound to the
 *    op when it opens (op.fee); read it from getOp(opId).fee rather than recomputing it.
 */

export const BASE_BOND = 10n ** 15n; // 0.001 ETH
export const MAX_OWNER_BOND = 100n * 10n ** 18n; // 100 ETH
export const MAX_BOND_SHIFT = 20;
export const MAX_FEE_BPS = 100n; // 1%

const shift = (s: number) => BigInt(Math.min(Math.max(0, Math.floor(s)), MAX_BOND_SHIFT));

/** The recovery track's bond at a score (PolicyMath.bondFor). */
export function recoveryBondFor(score: number): bigint {
  return BASE_BOND << shift(score);
}

/** The K-track bond at the score counted when the guess is submitted (PolicyMath.ownerBondFor). */
export function ownerBondFor(score: number, base: bigint = BASE_BOND): bigint {
  if (score <= 0) return BASE_BOND;
  const a = BASE_BOND << shift(score);
  const b = base << shift(score - 1);
  return a > b ? a : b;
}

/** Valid ownerBaseBond: BASE_BOND … MAX_OWNER_BOND, a multiple of BASE_BOND (PolicyMath.ownerBondUnits). */
export function isValidOwnerBaseBond(base: bigint): boolean {
  return base >= BASE_BOND && base <= MAX_OWNER_BOND && base % BASE_BOND === 0n;
}

/** The sum of the bonds of n wrong guesses in a row from `fromScore`, without decay (what a thief loses). */
export function ownerBondTotal(n: number, base: bigint = BASE_BOND, fromScore = 0): bigint {
  let t = 0n;
  for (let i = 0; i < n; i++) t += ownerBondFor(fromScore + i, base);
  return t;
}

// ─────────────────────────────── guessing odds ───────────────────────────────

/** Human-chosen 6-digit PINs without a blocklist (Markert et al., IEEE S&P 2020, as used in Design v0.3 §13.8). */
export const HUMAN_PIN_CURVE: ReadonlyArray<readonly [number, number]> = [
  [10, 0.065],
  [30, 0.089],
  [100, 0.133],
];

/**
 * P(a throttled attacker finds a human-chosen 6-digit PIN within n guesses): linear from 0 to 6.5% at 10 guesses,
 * log-linear through 8.9% (30) and 13.3% (100), extrapolated beyond. The same curve as scripts/pin-attack-sim.ts.
 */
export function humanPinSuccess(n: number): number {
  if (n <= 0) return 0;
  const pts = HUMAN_PIN_CURVE;
  if (n <= pts[0][0]) return (pts[0][1] * n) / pts[0][0];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (n <= x1) return y0 + ((y1 - y0) * (Math.log(n) - Math.log(x0))) / (Math.log(x1) - Math.log(x0));
  }
  const [x0, y0] = pts[pts.length - 2];
  const [x1, y1] = pts[pts.length - 1];
  return Math.min(1, y1 + ((y1 - y0) * (Math.log(n) - Math.log(x1))) / (Math.log(x1) - Math.log(x0)));
}

/** P(n guesses find a PIN drawn uniformly from `space` PINs), the attacker never repeating a guess. */
export function randomPinSuccess(n: number, space: number): number {
  return Math.min(1, Math.max(0, n) / space);
}

/**
 * A suggested ownerBaseBond for an account value (wei). A thief pays the base from the second guess on and loses it on
 * a wrong guess. Human-chosen PIN: each of the first guesses succeeds with about 0.65% (6.5% in 10), so a base of about
 * 1% of the value makes every guess after the first a losing bet. Random PIN: about 1 in 10^6 per guess, so the
 * minimum already makes guessing a losing bet below about 1,000 ETH; the suggestion is value / 10^6 (≥ BASE_BOND).
 * Rounded up to a multiple of BASE_BOND, capped at MAX_OWNER_BOND.
 */
export function suggestOwnerBaseBond(valueWei: bigint, opts: { randomPin?: boolean } = {}): bigint {
  const raw = opts.randomPin ? valueWei / 1_000_000n : valueWei / 100n;
  let b = ((raw + BASE_BOND - 1n) / BASE_BOND) * BASE_BOND;
  if (b < BASE_BOND) b = BASE_BOND;
  if (b > MAX_OWNER_BOND) b = MAX_OWNER_BOND;
  return b;
}

// ─────────────────────────────── protocol fee ───────────────────────────────

export interface FeeRule {
  bps: number | bigint;
  minFee: bigint;
  maxFee: bigint;
}

/** FeeConfig.quote for one asset: clamp(amount · bps / 10 000, minFee, maxFee), never above 1% of the amount; no rule → 0. */
export function protocolFee(amount: bigint, rule?: FeeRule | null): bigint {
  if (!rule) return 0n;
  const bps = BigInt(rule.bps);
  if (bps === 0n && rule.maxFee === 0n) return 0n; // an unset row
  let fee = (amount * bps) / 10_000n;
  if (fee < rule.minFee) fee = rule.minFee;
  if (fee > rule.maxFee) fee = rule.maxFee;
  const cap = (amount * MAX_FEE_BPS) / 10_000n;
  return fee > cap ? cap : fee;
}

/** What leaves the account on the PIN path: the amount to the payee plus the fee to the fee recipient. */
export function totalDebit(amount: bigint, fee: bigint): bigint {
  return amount + fee;
}
