/**
 * Private mode (optional): client-side rules of the owner's app.
 *
 *  1. Routing (no silent zero for the owner). The K-only private path moves an encrypted zero when a send breaks a
 *     hidden rule, and only the watchtower learns it. The app therefore sends with K alone only what is sure to pass:
 *     a known recipient and an amount within L_min (≤ tau, which nobody knows) minus what this device already sent with K
 *     today. Everything else takes the PIN path, which never trips the wire. Without a local record (a new device) the
 *     app cannot know what was sent today and routes every send to the PIN path.
 *
 *  2. Decoy credibility (design doc §17.5, spike T5). Shield (wrap) and unshield amounts are public; the private
 *     transfers themselves are public as events, only their amounts are hidden. A coercer anchors on N = shielded −
 *     unshielded and asks whether the k hidden payments made since the last shield could have brought the balance down
 *     to the decoy D. With payments of mean mu (exponential), his probability that the balance is at most D is
 *     P(Poisson((N − D) / mu) ≤ k − 1). The app shows it next to the duress setting and warns when it is low. It ignores
 *     everything off-chain (exchange leaks, social media, the victim's lifestyle): a guide, not a guarantee.
 */

/** `reason` is a short sentence for the owner, without the path itself (the app names the path). */
export type PrivateRoute = { path: "k-only" | "pin"; reason: string };

/**
 * Which path a private send takes. `lmin` and `sentToday` are null when this device has no record of them; `restricted`:
 * the account is restricted (a watchtower after a tripwire, for example), so the key alone cannot send at all.
 */
export function routePrivateSend(p: { amount: bigint; recipientKnown: boolean; lmin: bigint | null; sentToday: bigint | null; restricted?: boolean }): PrivateRoute {
  if (p.amount <= 0n) return { path: "pin", reason: "Nothing to send" };
  if (p.restricted) return { path: "pin", reason: "The account is restricted, so the key alone cannot send" };
  if (!p.recipientKnown) return { path: "pin", reason: "A new recipient: a key-only send would move zero" };
  if (p.lmin === null || p.sentToday === null) return { path: "pin", reason: "This device has no record of today's key-only sends" };
  const room = p.lmin > p.sentToday ? p.lmin - p.sentToday : 0n;
  if (p.amount > room) return { path: "pin", reason: "Above what is sure to pass today with the key alone" };
  return { path: "k-only", reason: "A known recipient, within today's safe amount" };
}

/** A local record of this device's K-only private sends: { day: UTC day index, amount } entries. */
export type SendRecord = { day: number; amount: string };

export const utcDay = (ms: number) => Math.floor(ms / 86_400_000);

/** What this device sent with K today (the contract restarts its counter at each UTC day). */
export function sentToday(records: readonly SendRecord[], nowMs: number): bigint {
  const d = utcDay(nowMs);
  return records.filter((r) => r.day === d).reduce((s, r) => s + BigInt(r.amount), 0n);
}

/** P(Poisson(r) ≤ k − 1) = P(Gamma(k, 1) ≥ r): the coercer's credibility of the decoy. */
export function poissonCdfBelow(k: number, r: number): number {
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

/**
 * The coercer's probability that the balance is at most the decoy, from public history only.
 * @param shieldedNet N, in token units: shielded − unshielded (public amounts)
 * @param decoy D, the decoy cap the owner set
 * @param hiddenPayments k, private transfers out of the account since its last shield (their count is public)
 * @param typicalPayment mu, the coercer's idea of one payment (default: 4 % of N, at least 1)
 */
export function decoyCredibility(p: { shieldedNet: number; decoy: number; hiddenPayments: number; typicalPayment?: number }): number {
  const gap = p.shieldedNet - p.decoy;
  if (gap <= 0) return 1;
  const mu = p.typicalPayment ?? Math.max(1, p.shieldedNet * 0.04);
  return poissonCdfBelow(p.hiddenPayments, gap / mu);
}

export type CredibilityLevel = "weak" | "fair" | "good";

/** Plain advice for the owner, in the "limit the loss" language of the duress setting. */
export function credibilityAdvice(c: number): { level: CredibilityLevel; text: string } {
  if (c < 0.2) {
    return {
      level: "weak",
      text: "Someone who reads this account's public history would not believe the decoy yet: more was shielded than could have been spent since. Shield in smaller steps over time, or raise the decoy; the time lock stays your first protection.",
    };
  }
  if (c < 0.5) return { level: "fair", text: "The decoy is plausible but not convincing. It becomes more believable with more private payments after your last shield." };
  return { level: "good", text: "The decoy fits this account's public history." };
}

/** Public history of a private account, from the token's events: shields and unshields with their public amounts, and
 *  the private transfers out (amounts hidden), in chain order. */
export type PrivateHistoryEvent = { kind: "shield" | "unshield" | "out" | "in"; amount?: bigint; block: number };

/** N (shielded − unshielded) and k (private payments since the last shield) from that history. */
export function publicHistory(events: readonly PrivateHistoryEvent[]): { shieldedNet: bigint; hiddenPaymentsSinceLastShield: number } {
  let net = 0n;
  let k = 0;
  for (const e of [...events].sort((a, b) => a.block - b.block)) {
    if (e.kind === "shield") {
      net += e.amount ?? 0n;
      k = 0;
    } else if (e.kind === "unshield") {
      net -= e.amount ?? 0n;
    } else if (e.kind === "out") {
      k++;
    }
  }
  return { shieldedNet: net < 0n ? 0n : net, hiddenPaymentsSinceLastShield: k };
}
