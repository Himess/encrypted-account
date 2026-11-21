import { expect } from "chai";
import { Wallet, getBytes, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { CHALLENGE_TAG, KIND, LANE_TAG, challengeOf, decodeApproval, encodeApproval, laneDigest, laneMessage, opContentHash } from "../src/lane";

const ACCOUNT = "0x957D4b94eec400bFcC2E02820D9Ac36F7b8b2AE7";
const ZERO = "0x0000000000000000000000000000000000000000";
const Z32 = "0x" + "00".repeat(32);

describe("two-device lane helpers", () => {
  it("the tags are the contract's", () => {
    expect(CHALLENGE_TAG).to.eq(keccak256(toUtf8Bytes("encrypted-account/challenge/v1")));
    expect(LANE_TAG).to.eq(keccak256(toUtf8Bytes("encrypted-account/lane/v1")));
  });

  it("content hash: handles count for admin ops but not for outflows; a fee always counts", () => {
    const base = { kind: KIND.Outflow, sub: 0, target: ZERO, counterparty: ACCOUNT, amount: 5n, data: "0x", h0: Z32, h1: Z32, h2: Z32, fee: 0n, callFee: 0n };
    const a = opContentHash(7n, base);
    expect(opContentHash(7n, { ...base, h0: "0x" + "11".repeat(32) })).to.eq(a); // an outflow's h0 is its evaluation result
    expect(opContentHash(7n, { ...base, fee: 3n })).to.not.eq(a);
    const admin = { ...base, kind: KIND.Admin, sub: 5 };
    expect(opContentHash(7n, { ...admin, h0: "0x" + "11".repeat(32) })).to.not.eq(opContentHash(7n, admin));
    expect(opContentHash(8n, base)).to.not.eq(a);
  });

  it("the challenge is 64 bits and depends on chain, account and op", () => {
    const h = opContentHash(1n, { kind: KIND.Call, sub: 0, target: ACCOUNT, counterparty: ZERO, amount: 0n, data: "0x1234", h0: Z32, h1: Z32, h2: Z32, fee: 0n, callFee: 0n });
    const c = challengeOf(11155111n, ACCOUNT, 1n, h);
    expect(c < 1n << 64n).to.eq(true);
    expect(challengeOf(1n, ACCOUNT, 1n, h)).to.not.eq(c);
    expect(challengeOf(11155111n, ACCOUNT, 2n, h)).to.not.eq(c);
  });

  it("the device signs laneMessage with personal_sign; laneDigest is what the contract recovers against", async () => {
    const d = Wallet.createRandom();
    const guess = "0x" + "ab".repeat(32);
    const msg = laneMessage(11155111n, ACCOUNT, 9n, guess);
    const sig = await d.signMessage(getBytes(msg));
    expect(verifyMessage(getBytes(msg), sig)).to.eq(d.address);
    expect(laneDigest(11155111n, ACCOUNT, 9n, guess)).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("an approval code round-trips and stays short", async () => {
    const d = Wallet.createRandom();
    const a = { account: ACCOUNT, opId: 42n, c: (1n << 64n) - 5n, guess: "0x" + "cd".repeat(32), proof: "0x" + "ef".repeat(200), cosig: await d.signMessage("x") };
    const code = encodeApproval(a);
    expect(code.startsWith("EA1.")).to.eq(true);
    expect(code.length).to.be.lessThan(1000);
    const b = decodeApproval(code);
    expect(b.account).to.eq(a.account);
    expect(b.opId).to.eq(a.opId);
    expect(b.c).to.eq(a.c);
    expect(b.guess).to.eq(a.guess);
    expect(b.proof).to.eq(a.proof);
    expect(b.cosig).to.eq(a.cosig);
    expect(() => decodeApproval("hello")).to.throw();
  });
});
