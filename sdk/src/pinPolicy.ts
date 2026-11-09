/**
 * PIN choice (Design §13.8, K11): the user picks the PIN. The app rejects only a short list of common PINs,
 * warns about dates and personal patterns, and can optionally suggest a random PIN.
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

export interface PinCheck {
  ok: boolean;
  reason?: string;
  warnings: string[];
}

const DATE_RE: RegExp[] = [
  /^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])\d{2}$/, // DDMMYY
  /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{2}$/, // MMDDYY
  /^\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/, // YYMMDD
];

/**
 * @returns ok=false only for listed PINs and inputs that are too short; everything else is a warning (not a block).
 */
export function checkPin(pin: string): PinCheck {
  const warnings: string[] = [];
  const p = pin.normalize("NFKC");
  if (p.length < 6) return { ok: false, reason: "PIN must be at least 6 characters", warnings };
  if (/^\d+$/.test(p)) {
    if (p.length === 6 && COMMON_SIX_DIGIT.has(p)) return { ok: false, reason: "Very common PIN", warnings };
    if (p.length === 6 && DATE_RE.some((r) => r.test(p))) warnings.push("Looks like a date (e.g. a birthday)");
    if (/(19|20)\d{2}/.test(p)) warnings.push("Contains a year");
    if (new Set(p.split("")).size <= 2) warnings.push("Too few distinct digits");
  } else if (p.length < 8) {
    warnings.push("8+ characters recommended for an alphanumeric passphrase");
  }
  return { ok: true, warnings };
}

/** A cryptographically random PIN that is not on the list (rejection sampling; no modulo bias). */
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
    if (!(length === 6 && COMMON_SIX_DIGIT.has(out))) return out;
  }
}

export const _internal = { range };
