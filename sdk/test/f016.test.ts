import { expect } from "chai";
import {
  BASE_BOND,
  COMMON_SIX_DIGIT,
  MAX_OWNER_BOND,
  PIN_NOTE,
  PIN_WARNINGS,
  checkDuressPin,
  checkPin,
  humanPinSuccess,
  isRandomPinCandidate,
  isValidOwnerBaseBond,
  ownerBondFor,
  ownerBondTotal,
  protocolFee,
  randomPin,
  randomPinSuccess,
  recoveryBondFor,
  suggestOwnerBaseBond,
} from "../src";

const ETH = 10n ** 18n;
const eth = (x: string) => BigInt(Math.round(Number(x) * 1e6)) * 10n ** 12n;

describe("SDK — F0.16 PIN guidance (warnings, never new blocks)", () => {
  it("a random PIN is never on the short list and raises no warning", () => {
    for (let i = 0; i < 5000; i++) {
      const p = randomPin();
      expect(COMMON_SIX_DIGIT.has(p), p).to.eq(false);
      const c = checkPin(p);
      expect(c.ok, p).to.eq(true);
      expect(c.warnings, p).to.deep.eq([]);
      expect(isRandomPinCandidate(p)).to.eq(true);
    }
  });

  it("predictable PINs get a warning but can still be saved", () => {
    const cases: [string, string][] = [
      ["150390", PIN_WARNINGS.date], // 15.03.90
      ["900315", PIN_WARNINGS.date], // YYMMDD
      ["15031990", PIN_WARNINGS.date], // DDMMYYYY
      ["819874", PIN_WARNINGS.year], // 1987
      ["588812", PIN_WARNINGS.repeat], // 888
      ["404041", PIN_WARNINGS.repeat], // 4040
      ["472274", PIN_WARNINGS.mirror],
      ["912345", PIN_WARNINGS.sequence], // 2345
      ["398765", PIN_WARNINGS.sequence], // 9876
      ["890152", PIN_WARNINGS.sequence], // 8901 (0 follows 9)
      ["214789", PIN_WARNINGS.keypad], // neighbouring keys
      ["789123", PIN_WARNINGS.keypad], // two keypad rows
      ["147369", PIN_WARNINGS.keypad], // two keypad columns
    ];
    for (const [pin, w] of cases) {
      expect(COMMON_SIX_DIGIT.has(pin), pin).to.eq(false);
      const c = checkPin(pin);
      expect(c.ok, pin).to.eq(true); // saved anyway
      expect(c.warnings, pin).to.include(w);
      expect(isRandomPinCandidate(pin), pin).to.eq(false);
    }
    expect(checkPin("Tr0ub4dor").warnings).to.deep.eq([]);
    expect(checkPin("abc1234").warnings).to.deep.eq([PIN_WARNINGS.shortPassphrase]);
  });

  it("the existing short list is unchanged: those PINs are still rejected, nothing else is", () => {
    expect(COMMON_SIX_DIGIT.size).to.eq(296);
    for (const p of ["123456", "111111", "654321", "121212", "147258", "159753"]) expect(checkPin(p).ok, p).to.eq(false);
    let rejected = 0;
    for (let i = 0; i < 1_000_000; i++) if (!checkPin(String(i).padStart(6, "0")).ok) rejected++;
    expect(rejected).to.eq(COMMON_SIX_DIGIT.size); // every other 6-digit PIN can be saved
    expect(checkPin("12345").ok).to.eq(false); // too short, as before
  });

  it("the duress PIN must differ from the PIN; one typo away is a warning; it gets the same checks", () => {
    expect(checkDuressPin("482915", "482915").ok).to.eq(false);
    expect(checkDuressPin("４８２９１５", "482915").ok).to.eq(false); // NFKC: full-width digits are the same PIN
    const near = checkDuressPin("482916", "482915");
    expect(near.ok).to.eq(true);
    expect(near.warnings).to.include(PIN_WARNINGS.nearMain);
    expect(checkDuressPin("489215", "482915").warnings).to.include(PIN_WARNINGS.nearMain); // swapped neighbours
    expect(checkDuressPin("730164", "482915")).to.deep.eq({ ok: true, warnings: [] });
    expect(checkDuressPin("123456", "482915").ok).to.eq(false); // the short list applies to the duress PIN too
    expect(checkDuressPin("150390", "482915").warnings).to.include(PIN_WARNINGS.date);
  });

  it("the note says what the task asks for", () => {
    expect(PIN_NOTE).to.match(/harder your PIN is to guess/);
    expect(PIN_NOTE).to.match(/birthdays, phone numbers, licence plates and patterns like 123456/);
    expect(PIN_NOTE).to.match(/random PIN/);
  });
});

describe("SDK — F0.16 bond and fee (mirrors PolicyMath and FeeConfig)", () => {
  it("default base: the K-track bond equals the recovery doubling; a higher base prices every guess, the first included", () => {
    for (let s = 0; s <= 25; s++) expect(ownerBondFor(s), `score ${s}`).to.eq(recoveryBondFor(s));
    expect(recoveryBondFor(25)).to.eq(BASE_BOND << 20n);
    // the recovery track follows the owner's base bond too (no cheaper door to the same PIN)
    for (let s = 0; s <= 25; s++) expect(recoveryBondFor(s, 5n * BASE_BOND), `score ${s}`).to.eq(ownerBondFor(s, 5n * BASE_BOND));
    const base = eth("0.1");
    expect(ownerBondFor(0, base)).to.eq(base);
    expect(ownerBondFor(1, base)).to.eq(2n * base);
    expect(ownerBondFor(2, base)).to.eq(4n * base);
    expect(ownerBondFor(30, base)).to.eq(base << 20n);
    expect(ownerBondTotal(3, base)).to.eq(7n * base);
    expect(ownerBondTotal(5)).to.eq(31n * BASE_BOND);
  });

  it("base bounds and the size-based suggestion", () => {
    expect(isValidOwnerBaseBond(BASE_BOND)).to.eq(true);
    expect(isValidOwnerBaseBond(MAX_OWNER_BOND)).to.eq(true);
    expect(isValidOwnerBaseBond(BASE_BOND - 1n)).to.eq(false);
    expect(isValidOwnerBaseBond(MAX_OWNER_BOND + BASE_BOND)).to.eq(false);
    expect(isValidOwnerBaseBond(eth("0.0015"))).to.eq(false);
    expect(suggestOwnerBaseBond(eth("1"))).to.eq(eth("0.01"));
    expect(suggestOwnerBaseBond(100n * ETH)).to.eq(ETH);
    expect(suggestOwnerBaseBond(eth("0.05"))).to.eq(BASE_BOND);
    expect(suggestOwnerBaseBond(100_000n * ETH)).to.eq(MAX_OWNER_BOND);
    expect(suggestOwnerBaseBond(100n * ETH, { randomPin: true })).to.eq(BASE_BOND);
    expect(suggestOwnerBaseBond(5_000n * ETH, { randomPin: true })).to.eq(eth("0.005"));
    for (const v of [1n, ETH, 7n * ETH + 123n, 10n ** 30n]) expect(isValidOwnerBaseBond(suggestOwnerBaseBond(v))).to.eq(true);
  });

  it("fee: clamp to min/max, never above 1% of the amount; no rule or an unset row → 0", () => {
    const r = { bps: 10, minFee: eth("0.00001"), maxFee: eth("0.001") };
    expect(protocolFee(eth("0.2"), r)).to.eq(eth("0.0002"));
    expect(protocolFee(eth("0.005"), r)).to.eq(r.minFee);
    expect(protocolFee(eth("2"), r)).to.eq(r.maxFee);
    expect(protocolFee(eth("0.0005"), r)).to.eq(eth("0.000005")); // the 1% cap cuts the minimum
    expect(protocolFee(eth("1"), null)).to.eq(0n);
    expect(protocolFee(eth("1"), { bps: 0, minFee: 0n, maxFee: 0n })).to.eq(0n);
    expect(protocolFee(eth("1"), { bps: 0, minFee: eth("0.0001"), maxFee: eth("0.0001") })).to.eq(eth("0.0001")); // flat
  });

  it("guessing odds: the human curve hits the Markert points; random PINs are linear in the space", () => {
    expect(humanPinSuccess(10)).to.be.closeTo(0.065, 1e-12);
    expect(humanPinSuccess(30)).to.be.closeTo(0.089, 1e-12);
    expect(humanPinSuccess(100)).to.be.closeTo(0.133, 1e-12);
    expect(humanPinSuccess(5)).to.be.closeTo(0.0325, 1e-12);
    expect(humanPinSuccess(300)).to.be.greaterThan(0.133);
    expect(randomPinSuccess(10, 1_000_000)).to.eq(1e-5);
  });
});
