/**
 * Watchtower service, unit tests (no chain): routing, message texts, config checks, channels, delivery queue.
 *   npm run test:watchtower
 * The end-to-end tests against real contracts (mock FHEVM) are in test/WatchtowerService.test.ts.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Alert } from "../../sdk/src/watchtower";
import { EmailChannel, FakeChannel, TelegramChannel } from "../src/channels";
import { AccountConfig, DURESS_NOTE_MAX, ServiceConfig, normalizeDest, validateConfig } from "../src/config";
import { duressMessage, ownerMessage } from "../src/messages";
import { route } from "../src/router";

const ACCT: AccountConfig = {
  label: "Main account",
  address: "0x957D4b94eec400bFcC2E02820D9Ac36F7b8b2AE7",
  owner: [
    { channel: "telegram", to: "111111" },
    { channel: "email", to: "owner@example.org" },
  ],
  trusted: [{ channel: "email", to: "lawyer@example.org" }],
  duressNote: "Call me on the landline.",
};
const AT = new Date("2026-11-16T14:03:12.345Z");
const REF = { txHash: "0x" + "ab".repeat(32), blockNumber: 7 };

// Distinctive amounts: none of these digit strings may appear in any message.
const AMOUNTS = [987654321n, 123456789012n, 55555555n, 4242424242n];
const T = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const X = "0x00000000000000000000000000000000000000aa";
const ALL: Alert[] = [
  { kind: "wrong-pin", opId: 3n, track: 0 },
  { kind: "wrong-pin", opId: 3n, track: 1 },
  { kind: "pin-ok", opId: 3n, readyAt: 1_900_000_000n },
  { kind: "pin-ok", opId: 3n, readyAt: 1_000n },
  { kind: "policy-said-no", opId: 3n },
  { kind: "restriction", reasons: 3 },
  { kind: "restriction", reasons: 0 },
  { kind: "tripwire", asset: T },
  { kind: "duress", opId: 3n },
  { kind: "duress", opId: 3n, earliestRun: 1_900_000_000n },
  { kind: "op-paused", opId: 3n, at: 1_900_000_000n },
  { kind: "pause-lifted", opId: 3n },
  { kind: "device-change", opId: 3n, helper: false },
  { kind: "device-change", opId: 3n, helper: true },
  { kind: "lane-only", on: true },
  { kind: "lane-only", on: false },
  { kind: "recovery-opened", opId: 3n },
  { kind: "escape-started", readyAt: 1_900_000_000n, to: X },
  { kind: "escape-unverified", days: 91 },
  { kind: "open-approval", token: T, spender: X, allowance: AMOUNTS[0], advice: "approve 0" },
  { kind: "open-outflow", sub: 0, asset: T, to: X, amount: AMOUNTS[1], spent: AMOUNTS[2] },
  { kind: "known-changed", spenders: false, who: X, added: true },
  { kind: "will-reminder", will: X, daysLeft: 7, startableAt: 1_900_000_000n },
  { kind: "will-started", will: X, settleableAt: 1_900_000_000n },
  { kind: "will-settled", will: X },
  { kind: "private-delivered", token: T, to: X, moved: AMOUNTS[3] },
  { kind: "private-silent-zero", token: T, to: X, tripped: false },
  { kind: "private-silent-zero", token: T, to: X, tripped: true },
  { kind: "private-tripwire", token: T },
  { kind: "error", message: "boom" },
];

describe("watchtower service: routing", () => {
  it("the duress alarm goes to the trusted contacts only, never to an owner channel", () => {
    const d = route({ kind: "duress", opId: 9n }, ACCT, AT, REF);
    expect(d.map((x) => [x.role, x.dest.channel, x.dest.to])).to.deep.eq([["trusted", "email", "lawyer@example.org"]]);
    for (const a of ALL.filter((a) => a.kind !== "duress")) {
      for (const x of route(a, ACCT, AT, REF)) expect(x.role, a.kind).to.eq("owner");
    }
  });

  it("a trusted contact that is also an owner channel (written another way) is dropped at runtime, and rejected by the config check", () => {
    const sneaky: AccountConfig = { ...ACCT, owner: [{ channel: "email", to: "Owner.Name+alerts@GoogleMail.com" }], trusted: [{ channel: "email", to: "ownername@gmail.com" }, { channel: "telegram", to: "222" }] };
    expect(normalizeDest(sneaky.owner[0])).to.eq(normalizeDest(sneaky.trusted![0]));
    const d = route({ kind: "duress", opId: 1n }, sneaky, AT);
    expect(d.map((x) => x.dest.to)).to.deep.eq(["222"]);
    const cfg = baseConfig([sneaky]);
    expect(validateConfig(cfg).errors.some((e) => /never reach the owner/.test(e))).to.eq(true);
  });

  it("wrong PIN and silent zero go to the owner; errors go to nobody", () => {
    expect(route({ kind: "wrong-pin", opId: 1n, track: 0 }, ACCT, AT).map((x) => x.role)).to.deep.eq(["owner", "owner"]);
    expect(route({ kind: "private-silent-zero", token: T, to: X, tripped: false }, ACCT, AT).map((x) => x.role)).to.deep.eq(["owner", "owner"]);
    expect(route({ kind: "error", message: "x" }, ACCT, AT)).to.deep.eq([]);
    expect(route({ kind: "pin-ok", opId: 1n, readyAt: 0n }, { ...ACCT, notifyPinOk: false }, AT)).to.deep.eq([]);
  });

  it("every delivery carries the transaction that caused it (for logs and latency), never inside the text", () => {
    const d = route({ kind: "duress", opId: 9n }, ACCT, AT, REF)[0];
    expect(d.ref).to.deep.eq(REF);
    expect(d.text).to.not.include(REF.txHash);
  });
});

describe("watchtower service: message texts", () => {
  it("no message carries an amount (balances, transfer amounts, allowances, counters, hidden amounts)", () => {
    for (const a of ALL) {
      const texts = route(a, ACCT, AT, REF).map((x) => x.text);
      for (const t of texts) for (const n of AMOUNTS) expect(t, a.kind).to.not.include(n.toString());
    }
  });

  it("the silent alarm has the account, the time, 'duress PIN used', the pause step and deadline, the owner's note — nothing else", () => {
    const t = duressMessage({ label: ACCT.label, address: ACCT.address, at: AT }, ACCT.duressNote);
    expect(t).to.eq(
      ["Silent alarm (watchtower)", `Account: Main account (${ACCT.address})`, "Time: 2026-11-16T14:03:12Z", "The duress PIN was used on this account.", "Note from the owner: Call me on the landline."].join("\n"),
    );
    expect(duressMessage({ label: "A", address: ACCT.address, at: AT })).to.not.include("Note");
    const cmd = "npm run watchtower -- --config watchtower/config.json --pause " + ACCT.address;
    const run = Math.floor(AT.getTime() / 1000) + 3600; // an hour after the alarm
    const runIso = new Date(run * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const later = duressMessage({ label: ACCT.label, address: ACCT.address, at: AT }, ACCT.duressNote, { opId: 12n, earliestRun: BigInt(run), command: cmd });
    expect(later.split("\n")).to.deep.eq([
      "Silent alarm (watchtower)",
      `Account: Main account (${ACCT.address})`,
      "Time: 2026-11-16T14:03:12Z",
      "The duress PIN was used on this account.",
      `Operation #12 was approved with it and can run from ${runIso}: pause before then.`,
      `To pause the account's pending operations (each once, for up to 72 hours), run on the watchtower's computer: ${cmd}`,
      "Note from the owner: Call me on the landline.",
    ]);
    const now = duressMessage({ label: "A", address: ACCT.address, at: AT }, undefined, { opId: 5n, earliestRun: BigInt(Math.floor(AT.getTime() / 1000)), command: cmd });
    expect(now).to.include("Operation #5 was approved with it and can run at once: a pause cannot hold it.");
    // the router builds the step from the alert and the config file's path
    const d = route({ kind: "duress", opId: 9n, earliestRun: 2_000_000_000n }, ACCT, AT, REF, "my/config.json")[0];
    expect(d.text).to.include("--config my/config.json --pause " + ACCT.address);
    expect(d.text).to.include("Operation #9");
  });

  it("the owner hears of a pause and of its lifting, with no amount and nothing about which PIN was used", () => {
    const c = { label: "A", address: ACCT.address, at: AT };
    expect(ownerMessage({ kind: "op-paused", opId: 4n, at: 1_900_000_000n }, c)).to.include("Operation #4 was paused");
    expect(ownerMessage({ kind: "pause-lifted", opId: 4n }, c)).to.include("pause of operation #4 was lifted");
    for (const k of ["op-paused", "pause-lifted"] as const) {
      expect(route(k === "op-paused" ? { kind: k, opId: 4n, at: 1_900_000_000n } : { kind: k, opId: 4n }, ACCT, AT).every((x) => x.role === "owner")).to.eq(true);
    }
  });

  it("the owner's silent-zero text is the same whatever the reason (a fired tripwire is not singled out)", () => {
    const c = { label: "A", address: ACCT.address, at: AT };
    expect(ownerMessage({ kind: "private-silent-zero", token: T, to: X, tripped: true }, c)).to.eq(ownerMessage({ kind: "private-silent-zero", token: T, to: X, tripped: false }, c));
  });

  it("the owner is never told about the duress PIN", () => {
    expect(ownerMessage({ kind: "duress", opId: 1n }, { label: "A", address: ACCT.address, at: AT })).to.eq(null);
  });
});

describe("watchtower service: config check", () => {
  it("accepts the example config", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.example.json"), "utf8")) as ServiceConfig;
    expect(validateConfig(cfg).errors).to.deep.eq([]);
  });

  it("rejects a long duress note, a bad address, an unknown channel and a key in place of an env reference", () => {
    const bad = baseConfig([{ ...ACCT, duressNote: "x".repeat(DURESS_NOTE_MAX + 1) }, { ...ACCT, address: "0x1234", owner: [{ channel: "sms" as any, to: "+1" }] }]);
    (bad as any).guardianKey = { envFile: "", var: "" };
    const { errors } = validateConfig(bad);
    expect(errors.some((e) => /duressNote/.test(e))).to.eq(true);
    expect(errors.some((e) => /not an address/.test(e))).to.eq(true);
    expect(errors.some((e) => /unknown channel "sms"/.test(e))).to.eq(true);
    expect(errors.some((e) => /guardianKey/.test(e))).to.eq(true);
  });
});

describe("watchtower service: channels", () => {
  it("fake channel: one JSON line per message, with the role and the transaction reference", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wt-")), "n.jsonl");
    const f = new FakeChannel({ file });
    await f.standIn("email").send("lawyer@example.org", "hello", { account: ACCT.address, role: "trusted", kind: "duress", ref: REF });
    const rec = JSON.parse(fs.readFileSync(file, "utf8").trim());
    expect(rec).to.include({ via: "email", to: "trusted", dest: "lawyer@example.org", text: "hello" });
    expect(rec.ref).to.deep.eq({ kind: "duress", txHash: REF.txHash, blockNumber: 7 });
    expect(f.sent.length).to.eq(1);
  });

  it("telegram: posts sendMessage to the chat; an error never shows the bot token", async () => {
    const token = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const calls: any[] = [];
    const ok: typeof fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;
    await new TelegramChannel(token, ok, "https://tg.test").send("4242", "hi", { account: ACCT.address, role: "owner", kind: "wrong-pin" });
    expect(calls[0].url).to.eq(`https://tg.test/bot${token}/sendMessage`);
    expect(calls[0].body).to.deep.eq({ chat_id: "4242", text: "hi", disable_web_page_preview: true });
    const failing: typeof fetch = (async () => {
      throw new Error(`connect failed for https://tg.test/bot${token}/sendMessage`);
    }) as any;
    let msg = "";
    try {
      await new TelegramChannel(token, failing, "https://tg.test").send("1", "x", { account: ACCT.address, role: "owner", kind: "x" });
    } catch (e: any) {
      msg = e.message;
    }
    expect(msg).to.include("<token>");
    expect(msg).to.not.include(token);
    expect(() => new TelegramChannel("not-a-token")).to.throw(/bot token/);
  });

  it("e-mail: composes from / to / subject / text through the SMTP transport (nodemailer's JSON transport here)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require("nodemailer");
    const sent: any[] = [];
    const json = nodemailer.createTransport({ jsonTransport: true });
    const transport = { sendMail: async (m: any) => sent.push(JSON.parse((await json.sendMail(m)).message)) };
    const ch = new EmailChannel(transport, "watchtower@example.org");
    await ch.send("lawyer@example.org", "Silent alarm text", { account: ACCT.address, role: "trusted", kind: "duress" });
    await ch.send("owner@example.org", "Owner text", { account: ACCT.address, role: "owner", kind: "wrong-pin" });
    expect(sent[0].to[0].address).to.eq("lawyer@example.org");
    expect(sent[0].from.address).to.eq("watchtower@example.org");
    expect(sent[0].subject).to.eq("Silent alarm (watchtower)");
    expect(sent[0].text).to.eq("Silent alarm text");
    expect(sent[1].subject).to.eq("Account notice (watchtower)");
  });
});

function baseConfig(accounts: AccountConfig[]): ServiceConfig {
  return {
    network: { chainId: 31337, rpcUrls: ["http://127.0.0.1:8545"], fhevm: "sepolia" },
    guardianKey: { envFile: "watchtower/.env", var: "WATCHTOWER_KEY" },
    accounts,
  };
}
