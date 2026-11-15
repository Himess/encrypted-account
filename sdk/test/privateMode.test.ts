import { expect } from "chai";
import { credibilityAdvice, decoyCredibility, poissonCdfBelow, publicHistory, routePrivateSend, sentToday, utcDay } from "../src";
import { PRIVATE_TRIPPED, privateOutcome } from "../src/watchtower";

describe("private mode — client rules", () => {
  describe("routing: the owner's own sends never hit a silent zero", () => {
    const lmin = 300_000_000n; // 300 units of a 6-decimal token
    it("known recipient within L_min minus today's K-only sends → K alone", () => {
      expect(routePrivateSend({ amount: 100_000_000n, recipientKnown: true, lmin, sentToday: 0n }).path).to.eq("k-only");
      expect(routePrivateSend({ amount: 200_000_000n, recipientKnown: true, lmin, sentToday: 100_000_000n }).path).to.eq("k-only");
    });
    it("above what is sure to pass today → the PIN path", () => {
      expect(routePrivateSend({ amount: 200_000_001n, recipientKnown: true, lmin, sentToday: 100_000_000n }).path).to.eq("pin");
      expect(routePrivateSend({ amount: 1n, recipientKnown: true, lmin, sentToday: lmin }).path).to.eq("pin");
    });
    it("a new recipient, or no local record (another device) → the PIN path", () => {
      expect(routePrivateSend({ amount: 1n, recipientKnown: false, lmin, sentToday: 0n }).path).to.eq("pin");
      expect(routePrivateSend({ amount: 1n, recipientKnown: true, lmin: null, sentToday: 0n }).path).to.eq("pin");
      expect(routePrivateSend({ amount: 1n, recipientKnown: true, lmin, sentToday: null }).path).to.eq("pin");
    });
    it("a restricted account (after a tripwire, say) → the PIN path, whatever the amount", () => {
      expect(routePrivateSend({ amount: 1n, recipientKnown: true, lmin, sentToday: 0n, restricted: true }).path).to.eq("pin");
      expect(routePrivateSend({ amount: 1n, recipientKnown: true, lmin, sentToday: 0n, restricted: false }).path).to.eq("k-only");
    });
    it("today's sends count per UTC day, like the contract's counter", () => {
      const now = Date.UTC(2026, 10, 16, 10, 0, 0);
      const recs = [
        { day: utcDay(now), amount: "5" },
        { day: utcDay(now), amount: "7" },
        { day: utcDay(now) - 1, amount: "100" },
      ];
      expect(sentToday(recs, now)).to.eq(12n);
    });
  });

  describe("decoy credibility (spike T5)", () => {
    it("matches the T5 table: P(Poisson(r) ≤ k − 1)", () => {
      expect(poissonCdfBelow(0, 5)).to.eq(0);
      expect(Math.round(100 * poissonCdfBelow(5, 5))).to.eq(44);
      expect(Math.round(100 * poissonCdfBelow(10, 10))).to.eq(46);
      expect(Math.round(100 * poissonCdfBelow(20, 20))).to.eq(47);
      expect(Math.round(100 * poissonCdfBelow(40, 40))).to.eq(48);
      expect(poissonCdfBelow(60, 20)).to.be.greaterThan(0.99);
    });
    it("10,000 shielded at once, decoy 2,000: not credible right away, credible after about (N − D)/mu payments", () => {
      expect(decoyCredibility({ shieldedNet: 10_000, decoy: 2_000, hiddenPayments: 2, typicalPayment: 400 })).to.be.lessThan(0.01);
      expect(decoyCredibility({ shieldedNet: 10_000, decoy: 2_000, hiddenPayments: 21, typicalPayment: 400 })).to.be.greaterThan(0.45);
      expect(decoyCredibility({ shieldedNet: 10_000, decoy: 10_000, hiddenPayments: 0 })).to.eq(1);
    });
    it("advice levels", () => {
      expect(credibilityAdvice(0.05).level).to.eq("weak");
      expect(credibilityAdvice(0.3).level).to.eq("fair");
      expect(credibilityAdvice(0.8).level).to.eq("good");
      expect(credibilityAdvice(0.05).text).to.not.match(/unhackable|guarantee/i);
    });
    it("public history: N = shielded − unshielded; k counts private payments since the last shield", () => {
      const h = publicHistory([
        { kind: "shield", amount: 6_000n, block: 1 },
        { kind: "out", block: 2 },
        { kind: "out", block: 3 },
        { kind: "shield", amount: 4_000n, block: 4 },
        { kind: "out", block: 5 },
        { kind: "unshield", amount: 1_000n, block: 6 },
        { kind: "in", block: 7 },
        { kind: "out", block: 8 },
      ]);
      expect(h.shieldedNet).to.eq(9_000n);
      expect(h.hiddenPaymentsSinceLastShield).to.eq(2);
    });
  });

  describe("watchtower outcome of a K-only private transfer", () => {
    it("delivered, silent zero, tripwire, and the day restart", () => {
      expect(privateOutcome(undefined, 5n, 100n)).to.deep.eq({ moved: 100n, tripped: false, newlyTripped: false });
      expect(privateOutcome({ epoch: 5n, value: 100n }, 5n, 100n)).to.deep.eq({ moved: 0n, tripped: false, newlyTripped: false });
      expect(privateOutcome({ epoch: 5n, value: 100n }, 5n, PRIVATE_TRIPPED)).to.deep.eq({ moved: 0n, tripped: true, newlyTripped: true });
      expect(privateOutcome({ epoch: 5n, value: PRIVATE_TRIPPED }, 6n, PRIVATE_TRIPPED)).to.deep.eq({ moved: 0n, tripped: true, newlyTripped: false });
      expect(privateOutcome({ epoch: 5n, value: 250n }, 6n, 40n)).to.deep.eq({ moved: 40n, tripped: false, newlyTripped: false });
    });
  });
});
