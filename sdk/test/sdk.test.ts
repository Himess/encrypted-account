import { expect } from "chai";
import vectors from "../test-vectors/argon2id-v1.json";
import {
  COMMON_SIX_DIGIT,
  KDF_V1,
  UINT64_MOD,
  argon2idRaw,
  bytesToHex,
  checkPin,
  guessValue,
  pinFingerprint,
  pinSalt,
  randomPin,
} from "../src";

describe("SDK — PIN fingerprint (13.1) and PIN policy (13.8)", function () {
  this.timeout(300_000);

  it("shared test vectors: salt and fingerprint match exactly (E17 vectors)", async () => {
    for (const v of vectors.vectors) {
      const salt = pinSalt(BigInt(v.chainId), v.account);
      expect(bytesToHex(salt)).to.eq(v.salt);
      const raw = await argon2idRaw(v.pin, salt);
      expect(bytesToHex(raw)).to.eq(v.argon2id);
      const fp = await pinFingerprint(v.pin, BigInt(v.chainId), v.account);
      expect("0x" + fp.toString(16).padStart(16, "0")).to.eq(v.fingerprint);
    }
  });

  it("reference KAT (phc-winner-argon2): argon2id m=64MiB t=2 p=1 password/somesalt", async () => {
    const raw = await argon2idRaw("password", new TextEncoder().encode("somesalt"), { ...KDF_V1, iterations: 2 });
    expect(bytesToHex(raw)).to.eq(vectors.referenceKAT.hash);
  });

  it("the same PIN gives a different fingerprint on another account and on another chain (per-account brute force)", async () => {
    const a = vectors.vectors[0];
    const b = vectors.vectors[1];
    const c = vectors.vectors[2];
    expect(a.pin).to.eq(b.pin);
    expect(new Set([a.fingerprint, b.fingerprint, c.fingerprint]).size).to.eq(3);
  });

  it("NFKC normalization: compatible Unicode forms give the same fingerprint", async () => {
    const acct = "0x3333333333333333333333333333333333333333";
    const composed = "\u015E1453ab"; // U+015E (S with cedilla, precomposed)
    const decomposed = "S\u03271453ab"; // S + U+0327 combining cedilla
    const fp1 = await pinFingerprint(composed, 1n, acct);
    const fp2 = await pinFingerprint(decomposed, 1n, acct);
    expect(fp1).to.eq(fp2);
  });

  it("challenge arithmetic wraps at 2^64 identically on both sides", () => {
    const h = UINT64_MOD - 5n;
    const c = 17n;
    const g = guessValue(h, c);
    expect(g).to.eq(12n);
    // contract: eq((pinH + c) mod 2^64, g)
    expect((h + c) % UINT64_MOD).to.eq(g);
  });

  it("the short common-PIN list has a few hundred entries and contains the known patterns", () => {
    expect(COMMON_SIX_DIGIT.size).to.be.within(200, 1000);
    for (const p of ["123456", "654321", "000000", "111111", "121212", "112233", "123123", "123321", "147258", "159753"]) {
      expect(COMMON_SIX_DIGIT.has(p), p).to.eq(true);
      expect(checkPin(p).ok, p).to.eq(false);
    }
  });

  it("a warning, not a block: a date-like PIN can be chosen, with a warning", () => {
    const r = checkPin("150390"); // 15.03.90
    expect(r.ok).to.eq(true);
    expect(r.warnings.join(" ")).to.match(/date/);
    expect(checkPin("12345").ok).to.eq(false);
    expect(checkPin("correct horse battery").ok).to.eq(true);
  });

  it("random PIN: 6 digits, not on the list, roughly uniform digit distribution", () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 2000; i++) {
      const p = randomPin();
      expect(p).to.match(/^\d{6}$/);
      expect(COMMON_SIX_DIGIT.has(p)).to.eq(false);
      for (const ch of p) counts[Number(ch)]++;
    }
    const expected = (2000 * 6) / 10;
    for (const c of counts) expect(Math.abs(c - expected) / expected).to.be.lessThan(0.1);
  });
});

describe("SDK — will reminders (W1.7)", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { dueWillReminders, WILL_REMIND_DAYS } = require("../src/watchtower");
  const DAY = 86400n;
  const end = 1_000_000_000n;

  it("reminds 30 and then 7 days before the inactivity period ends, once each", () => {
    expect(WILL_REMIND_DAYS).to.deep.eq([30, 7]);
    expect(dueWillReminders(end - 31n * DAY, end, new Set())).to.deep.eq([]);
    expect(dueWillReminders(end - 30n * DAY, end, new Set())).to.deep.eq([30]);
    expect(dueWillReminders(end - 20n * DAY, end, new Set([30]))).to.deep.eq([]);
    expect(dueWillReminders(end - 7n * DAY, end, new Set([30]))).to.deep.eq([7]);
    expect(dueWillReminders(end - DAY, end, new Set([30, 7]))).to.deep.eq([]);
  });

  it("a late first check returns every missed threshold (the watcher sends one reminder for them)", () => {
    expect(dueWillReminders(end - 5n * DAY, end, new Set())).to.deep.eq([30, 7]);
    expect(dueWillReminders(end + DAY, end, new Set(), [14, 3])).to.deep.eq([14, 3]);
  });
});
