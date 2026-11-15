/**
 * PIN choice (Design §13.8, K11): the user picks the PIN. The app rejects only a short list of common PINs,
 * warns about dates and personal patterns, and can optionally suggest a random PIN.
 *
 * F0.16: guidance, never a new rule. The same short note sits next to every PIN field (setup, PIN change, duress
 * PIN); predictable PINs (dates, repeats, sequences, keypad patterns) get a warning but can still be saved; the short
 * reject list below is unchanged. Background: Markert et al. (IEEE S&P 2020) measured human-chosen 6-digit PINs — a
 * throttled attacker reaches about 6.5% success in 10 guesses; for a random PIN the risk is negligible.
 *
 * Note (R10): the list is a pattern-based starter list (a few hundred entries). Tuning it against leaked PIN
 * datasets (e.g. Markert et al., IEEE S&P 2020) and sizing it with the E13 usability study are open work.
 */

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function buildCommonSixDigit(): Set<string> {
  const s = new Set<string>();
  const d = "0123456789";
  // repeats: 000000 … 999999
  for (const a of d) s.add(a.repeat(6));
  // ascending/descending runs (with wrap-around): 012345 … 901234, 543210 …
  for (let i = 0; i < 10; i++) {
    let up = "";
    let down = "";
    for (let k = 0; k < 6; k++) {
      up += d[(i + k) % 10];
      down += d[(i - k + 100) % 10];
    }
    s.add(up);
    s.add(down);
  }
  // ABABAB
  for (const a of d) for (const b of d) s.add((a + b).repeat(3));
  // ABCABC and ABCCBA (from consecutive triples)
  for (let i = 0; i < 10; i++) {
    const abc = d[i] + d[(i + 1) % 10] + d[(i + 2) % 10];
    const cba = abc.split("").reverse().join("");
    s.add(abc + abc);
    s.add(cba + cba);
    s.add(abc + cba);
    s.add(cba + abc);
  }
  // AAABBB and AABBCC (consecutive)
  for (const a of d) for (const b of d) s.add(a.repeat(3) + b.repeat(3));
  for (let i = 0; i < 10; i++) s.add(d[i].repeat(2) + d[(i + 1) % 10].repeat(2) + d[(i + 2) % 10].repeat(2));
  // keypad and other frequent patterns
  [
    "147258", "258369", "369258", "159753", "357159", "147852", "963852", "789456", "456123", "741852",
    "852963", "159357", "753951", "135790", "246802", "112358", "314159", "271828", "102030", "100200",
    "123654", "321456", "654123", "696969", "420420", "520520", "131313", "007007", "786786", "246810",
    "121314", "998877", "778899", "445566", "665544", "010203", "090807", "135246", "142536", "102938",
  ].forEach((x) => s.add(x));
  return s;
}

export const COMMON_SIX_DIGIT: ReadonlySet<string> = buildCommonSixDigit();

/** F0.16: the short note shown next to every PIN field (setup, PIN change, duress PIN). */
export const PIN_NOTE =
  "The harder your PIN is to guess, the safer your account. Avoid birthdays, phone numbers, licence plates and patterns like 123456. The safest is a random PIN.";

/** F0.16: warning texts (stable strings, so the app and the tests can match them). */
export const PIN_WARNINGS = Object.freeze({
  date: "Looks like a date (e.g. a birthday)",
  year: "Contains a year",
  fewDigits: "Too few distinct digits",
  repeat: "Repeats a digit or a block of digits",
  mirror: "Reads the same backwards",
  sequence: "Contains a sequence (like 1234 or 9876)",
  keypad: "Follows a keypad pattern",
  shortPassphrase: "8+ characters recommended for an alphanumeric passphrase",
  nearMain: "Differs from your PIN in one place only: a typo of your PIN could turn into the duress PIN",
});

export interface PinCheck {
  ok: boolean;
  reason?: string;
  warnings: string[];
}

const DATE_RE: RegExp[] = [
  /^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])\d{2}$/, // DDMMYY
  /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{2}$/, // MMDDYY
  /^\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/, // YYMMDD
  /^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])(19|20)\d{2}$/, // DDMMYYYY
  /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(19|20)\d{2}$/, // MMDDYYYY
  /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/, // YYYYMMDD
];

// phone keypad: 1 2 3 / 4 5 6 / 7 8 9 / · 0 ·
const KEY_POS: Record<string, [number, number]> = {
  "1": [0, 0], "2": [0, 1], "3": [0, 2],
  "4": [1, 0], "5": [1, 1], "6": [1, 2],
  "7": [2, 0], "8": [2, 1], "9": [2, 2],
  "0": [3, 1],
};

/** Every step goes to a neighbouring key (row, column or diagonal), e.g. 214789. */
function keypadWalk(p: string): boolean {
  for (let i = 1; i < p.length; i++) {
    const [r0, c0] = KEY_POS[p[i - 1]];
    const [r1, c1] = KEY_POS[p[i]];
    const dr = Math.abs(r0 - r1);
    const dc = Math.abs(c0 - c1);
    if (dr > 1 || dc > 1 || dr + dc === 0) return false;
  }
  return true;
}

const KEYPAD_LINES: ReadonlySet<string> = new Set(
  ["123", "456", "789", "147", "258", "369", "580", "159", "357"].flatMap((x) => [x, x.split("").reverse().join("")]),
);

/** Two straight keypad lines of three, e.g. 147369 or 789123. */
function keypadLines(p: string): boolean {
  return p.length === 6 && KEYPAD_LINES.has(p.slice(0, 3)) && KEYPAD_LINES.has(p.slice(3));
}

/** An ascending or descending run of at least `len` digits (0 follows 9), e.g. 1234, 8901, 6543. */
function hasRun(p: string, len: number): boolean {
  for (const step of [1, 9]) {
    let run = 1;
    for (let i = 1; i < p.length; i++) {
      run = (Number(p[i]) - Number(p[i - 1]) + 10) % 10 === step ? run + 1 : 1;
      if (run >= len) return true;
    }
  }
  return false;
}

/** Numeric patterns: each one a warning, never a block. */
function numericWarnings(p: string): string[] {
  const w: string[] = [];
  if (DATE_RE.some((r) => r.test(p))) w.push(PIN_WARNINGS.date);
  if (/(19|20)\d{2}/.test(p)) w.push(PIN_WARNINGS.year);
  if (new Set(p.split("")).size <= 2) w.push(PIN_WARNINGS.fewDigits);
  if (/(\d)\1\1/.test(p) || /(\d\d)\1/.test(p) || /^(\d{3})\1$/.test(p)) w.push(PIN_WARNINGS.repeat);
  if (p.length >= 4 && p === p.split("").reverse().join("")) w.push(PIN_WARNINGS.mirror);
  if (hasRun(p, 4)) w.push(PIN_WARNINGS.sequence);
  if (keypadWalk(p) || keypadLines(p)) w.push(PIN_WARNINGS.keypad);
  return w;
}

/**
 * @returns ok=false only for listed PINs and inputs that are too short (unchanged); everything else is a warning
 *          (dates, years, repeats, mirrors, sequences, keypad patterns), never a block.
 */
export function checkPin(pin: string): PinCheck {
  const p = pin.normalize("NFKC");
  if (p.length < 6) return { ok: false, reason: "PIN must be at least 6 characters", warnings: [] };
  if (/^\d+$/.test(p)) {
    if (p.length === 6 && COMMON_SIX_DIGIT.has(p)) return { ok: false, reason: "Very common PIN", warnings: [] };
    return { ok: true, warnings: numericWarnings(p) };
  }
  return { ok: true, warnings: p.length < 8 ? [PIN_WARNINGS.shortPassphrase] : [] };
}

/** One substitution or one swap of neighbouring characters turns `a` into `b` (a likely typo). */
function oneTypoApart(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  if (diff.length === 1) return true;
  return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
}

/**
 * F0.16: the duress PIN gets the same checks and warnings as the PIN, and it must differ from it — if the two were
 * equal the account could not tell them apart. A duress PIN one typo away from the PIN gets a warning (not a block).
 * Compared after NFKC normalization, as the fingerprint is.
 */
export function checkDuressPin(duress: string, pin: string): PinCheck {
  const r = checkPin(duress);
  if (!r.ok) return r;
  const d = duress.normalize("NFKC");
  const p = pin.normalize("NFKC");
  if (d === p) return { ok: false, reason: "The duress PIN must differ from your PIN (otherwise the account cannot tell them apart)", warnings: r.warnings };
  if (oneTypoApart(d, p)) r.warnings.push(PIN_WARNINGS.nearMain);
  return r;
}

/**
 * A cryptographically random PIN (rejection sampling; no modulo bias) that is not on the list and, from F0.16 on,
 * raises no warning either — a suggested PIN should not look like a date or a pattern. For 6 digits this keeps
 * about 80% of the 10^6 PINs (about 0.3 bits less than 20 bits; see isRandomPinCandidate); the draw stays uniform
 * over them.
 */
export function randomPin(length = 6): string {
  if (length < 6 || length > 32) throw new Error("length must be 6..32");
  for (;;) {
    let out = "";
    while (out.length < length) {
      const b = new Uint8Array(32);
      globalThis.crypto.getRandomValues(b);
      for (const x of b) {
        if (x < 250 && out.length < length) out += String(x % 10); // 250 = 25*10 → unbiased
      }
    }
    const c = checkPin(out);
    if (c.ok && c.warnings.length === 0) return out;
  }
}

/** True if randomPin(6) can return this PIN (not on the list, no warning). */
export function isRandomPinCandidate(pin: string): boolean {
  if (!/^\d{6}$/.test(pin)) return false;
  const c = checkPin(pin);
  return c.ok && c.warnings.length === 0;
}

export const _internal = { range };
