/**
 * Watchtower service (watchtower/) against the real contracts on the mock FHEVM: wrong-PIN notice, silent-zero notice,
 * and the silent duress alarm — to the trusted contact only, with no transaction sent and no amount in any message.
 */
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import * as hre from "hardhat";
import { Channel, FakeChannel } from "../watchtower/src/channels";
import type { ServiceConfig } from "../watchtower/src/config";
import { WatchtowerService, pausePending } from "../watchtower/src/service";
import { ethers, finalizeGuess, guess, time } from "./helpers";
import { DURESS, FUND, HIDDEN, MIN_BIG_DELAY, PIN, SHOWN, StackP, WRONG, createAccountP, deployStackP, encAmount, opIdOf, tc } from "./privateHelpers";

type Got = { via: string; dest: string; role: string; kind: string; text: string };

describe("Watchtower service: wrong PIN, silent zero, silent duress alarm (mock FHEVM)", function () {
  let s: StackP;
  let owner: HardhatEthersSigner, escape: HardhatEthersSigner, guardian: HardhatEthersSigner, R1: HardhatEthersSigner, stranger: HardhatEthersSigner;
  let token: string;

  before(async () => {
    [, owner, escape, guardian, R1, , stranger] = await ethers.getSigners();
    s = await deployStackP();
    token = await s.token.getAddress();
  });

  /** A private-mode account with a duress PIN, watched by the service; the owner reads Telegram, the trusted contact e-mail. */
  async function watched() {
    const acct = await createAccountP(s, owner, escape.address, guardian.address, { known: [R1.address], duressPin: DURESS });
    const addr = await acct.getAddress();
    await (await s.token.mint(addr, FUND)).wait();
    const got: Got[] = [];
    const capture = (kind: "telegram" | "email"): Channel => ({
      kind,
      send: async (to, text, meta) => {
        got.push({ via: kind, dest: to, role: meta.role, kind: meta.kind, text });
      },
    });
    const config: ServiceConfig = {
      network: { chainId: 31337, rpcUrls: ["(hardhat)"], fhevm: "none" },
      guardianKey: { envFile: "(test)", var: "(test)" },
      accounts: [
        {
          label: "Test account",
          address: addr,
          owner: [{ channel: "telegram", to: "owner-chat" }],
          trusted: [{ channel: "email", to: "trusted@example.org" }],
          duressNote: "Call me on the landline.",
        },
      ],
    };
    const svc = new WatchtowerService({
      config,
      guardian,
      userDecryptBool: (h, c) => hre.fhevm.userDecryptEbool(h, c, guardian),
      userDecryptU64: async (h, c) => BigInt(await hre.fhevm.userDecryptEuint(FhevmType.euint64, h, c, guardian)),
      publicDecrypt: (hs) => hre.fhevm.publicDecrypt(hs) as any,
      channels: { telegram: capture("telegram"), email: capture("email") },
      fallback: new FakeChannel(),
      log: () => undefined,
      retryMs: [],
    });
    await svc.tickAll(); // the setup events
    await svc.drain();
    got.length = 0;
    return { acct, addr, svc, got };
  }

  const pass = async (svc: WatchtowerService) => {
    await svc.tickAll();
    await svc.drain();
  };
  const noTime = (t: string) => t.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<t>");

  it("wrong PIN on the key track: one notice to the owner as soon as the guess is in (from the public result), none again at finalize; nothing to the trusted contact", async () => {
    const { acct, svc, got } = await watched();
    const id = opIdOf(acct, await (await acct.openPrivateView(token)).wait());
    await guess(acct, owner, s.chainId, id, WRONG);
    const block = await ethers.provider.getBlockNumber();
    await pass(svc); // nobody has finalized yet
    expect(await ethers.provider.getBlockNumber()).to.eq(block);
    expect(got.map((g) => [g.kind, g.role, g.via])).to.deep.eq([["wrong-pin", "owner", "telegram"]]);
    expect(got[0].text).to.match(/wrong PIN was entered/);
    await finalizeGuess(acct, id);
    await pass(svc);
    expect(got.map((g) => g.kind)).to.deep.eq(["wrong-pin"]);
  });

  it("a wrong guess that nobody finalizes is still reported", async () => {
    const { acct, svc, got } = await watched();
    const id = opIdOf(acct, await (await acct.openPrivateView(token)).wait());
    await guess(acct, owner, s.chainId, id, WRONG);
    await pass(svc);
    expect(got.filter((g) => g.kind === "wrong-pin").length).to.eq(1);
    expect(Number((await acct.getOp(id)).status)).to.eq(3); // Guessing: still not finalized
  });

  it("a key-only private send that moves zero: a silent-zero notice to the owner, with no amount; a delivered one says so", async () => {
    const { acct, svc, got } = await watched();
    const amount = tc(123.456789); // 123456789 units: these digits must not appear
    let enc = await encAmount(acct, owner, amount);
    await (await acct.privateTransfer(token, stranger.address, enc.handles[0], enc.inputProof)).wait(); // unknown recipient
    await pass(svc);
    expect(got.map((g) => [g.kind, g.role])).to.deep.eq([["private-silent-zero", "owner"]]);
    enc = await encAmount(acct, owner, amount);
    await (await acct.privateTransfer(token, R1.address, enc.handles[0], enc.inputProof)).wait(); // known, within the limit
    await pass(svc);
    expect(got.map((g) => g.kind)).to.deep.eq(["private-silent-zero", "private-delivered"]);
    for (const g of got) expect(g.text).to.not.match(/123456789|123\.45/);
  });

  it("duress PIN: the alarm reaches the trusted contact only, before the owner finalizes; the service sends no transaction; the owner's notices match a real-PIN run", async () => {
    const { acct, addr, svc, got } = await watched();
    const run = async (pin: string) => {
      const id = opIdOf(acct, await (await acct.openPrivateView(token)).wait());
      await guess(acct, owner, s.chainId, id, pin);
      // the watchtower looks right after the guess: before any finalize, and nothing it does may reach the chain
      const nonce = await ethers.provider.getTransactionCount(guardian.address);
      const block = await ethers.provider.getBlockNumber();
      const before = got.length;
      await pass(svc);
      const atGuess = got.slice(before);
      expect(await ethers.provider.getTransactionCount(guardian.address)).to.eq(nonce);
      expect(await ethers.provider.getBlockNumber()).to.eq(block); // automine: any transaction would have made a block
      expect((await acct.status()).restrictedReasons).to.eq(0n);
      await finalizeGuess(acct, id); // the owner's app finalizes, as it always does
      const mid = got.length;
      await pass(svc);
      return { atGuess, afterFinalize: got.slice(mid) };
    };

    const real = await run(PIN);
    expect(real.atGuess).to.deep.eq([]);
    const duress = await run(DURESS);
    expect(duress.atGuess.map((g) => [g.kind, g.role, g.via, g.dest])).to.deep.eq([["duress", "trusted", "email", "trusted@example.org"]]);
    const alarm = duress.atGuess[0].text;
    expect(alarm).to.include(addr);
    expect(alarm).to.include("The duress PIN was used on this account.");
    expect(alarm).to.include("Note from the owner: Call me on the landline.");
    for (const n of [FUND, HIDDEN, SHOWN]) expect(alarm).to.not.include(n.toString());
    // header, account, time, the fact, the approved op and its earliest run, the pause command, the note: nothing else
    expect(alarm.split("\n").length).to.eq(7);
    // the owner's channel never hears of it, and sees the same thing as for the real PIN
    expect(got.filter((g) => g.role === "owner" && g.kind === "duress")).to.deep.eq([]);
    expect(duress.afterFinalize.map((g) => [g.kind, g.role, noTime(g.text)])).to.deep.eq(real.afterFinalize.map((g) => [g.kind, g.role, noTime(g.text)]));
    expect(real.afterFinalize.map((g) => g.kind)).to.deep.eq(["pin-ok"]);
  });

  it("the trusted contact's pause: the alarm names the op, its earliest run and the command; the command, with the watchtower key, holds the op back", async () => {
    const { acct, addr, svc, got } = await watched();
    const enc = await encAmount(acct, owner, tc(100));
    const id = opIdOf(acct, await (await acct.openPrivateTransfer(token, stranger.address, enc.handles[0], enc.inputProof)).wait());
    await guess(acct, owner, s.chainId, id, DURESS);
    const nonce = await ethers.provider.getTransactionCount(guardian.address);
    await pass(svc);
    expect(await ethers.provider.getTransactionCount(guardian.address)).to.eq(nonce); // the alarm alone sends nothing
    const alarm = got.find((g) => g.kind === "duress")!;
    expect(alarm.role).to.eq("trusted");
    expect(alarm.text).to.match(new RegExp(`Operation #${id} was approved with it and can run from \\S+: pause before then\\.`));
    expect(alarm.text).to.include(`--pause ${addr}`);
    for (const n of [FUND, HIDDEN, SHOWN, tc(100)]) expect(alarm.text).to.not.include(n.toString());
    await finalizeGuess(acct, id);
    // a person decides to pause: the --pause command's helper, with the watchtower key
    const res = await pausePending(acct.connect(guardian));
    expect(res.map((r) => [r.opId, !!r.hash])).to.deep.eq([[id, true]]);
    await time.increaseTo(Number((await acct.getOp(id)).readyAt) + 1);
    await expect(acct.executeOp(id)).to.be.reverted; // OpPaused: 72 h beyond its own waiting time
    await time.increase(MIN_BIG_DELAY);
    await (await acct.executeOp(id)).wait();
    await pass(svc);
    expect(got.filter((g) => g.kind === "op-paused").map((g) => g.role)).to.deep.eq(["owner"]);
  });

  it("a PIN-gated private transfer under the duress PIN: one alarm, and still no transaction from the watchtower", async () => {
    const { acct, svc, got } = await watched();
    const enc = await encAmount(acct, owner, tc(50));
    const id = opIdOf(acct, await (await acct.openPrivateTransfer(token, R1.address, enc.handles[0], enc.inputProof)).wait());
    const nonce = await ethers.provider.getTransactionCount(guardian.address);
    await guess(acct, owner, s.chainId, id, DURESS);
    await pass(svc);
    await finalizeGuess(acct, id);
    await pass(svc);
    expect(got.filter((g) => g.kind === "duress").map((g) => g.role)).to.deep.eq(["trusted"]);
    expect(got.filter((g) => g.role === "owner").map((g) => g.kind)).to.deep.eq(["pin-ok"]);
    expect(await ethers.provider.getTransactionCount(guardian.address)).to.eq(nonce);
  });
});
