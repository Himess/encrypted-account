/**
 * Delivery channels: Telegram (bot API), e-mail (SMTP through nodemailer) and a fake channel that writes each message to
 * a JSONL file and/or the console (tests, and any run without a bot token or SMTP login). No paid SMS.
 */
import * as fs from "fs";
import * as path from "path";
import type { AlertRef } from "../../sdk/src/watchtower";
import type { ChannelKind } from "./config";
import { EMAIL_SUBJECT } from "./messages";
import type { Role } from "./router";

export interface SendMeta {
  account: string;
  role: Role;
  kind: string;
  ref?: AlertRef;
}

export interface Channel {
  readonly kind: ChannelKind;
  send(to: string, text: string, meta: SendMeta): Promise<void>;
}

/** Writes every message, with the time it was handed over, to a JSONL file (and the console if asked). */
export class FakeChannel implements Channel {
  readonly kind = "fake" as const;
  readonly sent: { at: number; via: string; to: Role; dest: string; account: string; text: string; ref: { kind: string; txHash?: string; blockNumber?: number } }[] = [];
  constructor(
    private readonly opts: { file?: string; console?: boolean } = {},
    /** The channel this one stands in for ("telegram" when no bot token is set, …). */
    private readonly via = "fake",
  ) {}

  /** The same sink, labelled as a stand-in for another channel. */
  standIn(via: string): FakeChannel {
    const f = new FakeChannel(this.opts, via);
    (f as any).sent = this.sent;
    return f;
  }

  async send(to: string, text: string, meta: SendMeta): Promise<void> {
    const rec = { at: Date.now(), via: this.via, to: meta.role, dest: to, account: meta.account, text, ref: { kind: meta.kind, txHash: meta.ref?.txHash, blockNumber: meta.ref?.blockNumber } };
    this.sent.push(rec);
    if (this.opts.file) {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
      fs.appendFileSync(this.opts.file, JSON.stringify(rec) + "\n");
    }
    if (this.opts.console) console.log(`[fake ${this.via} → ${meta.role} ${to}] ${text.replace(/\n/g, " | ")}`);
  }
}

/** Telegram bot API, sendMessage. The recipient must have started a chat with the bot once (bots cannot write first). */
export class TelegramChannel implements Channel {
  readonly kind = "telegram" as const;
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.telegram.org",
  ) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("telegram: the bot token does not look like a bot token");
  }

  async send(to: string, text: string, _meta?: SendMeta): Promise<void> {
    const url = `${this.apiBase}/bot${this.token}/sendMessage`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: to, text, disable_web_page_preview: true }),
      });
    } catch (e: any) {
      throw new Error(`telegram: ${this.scrub(String(e?.message ?? e))}`);
    }
    if (!res.ok) {
      let desc = "";
      try {
        desc = String(((await res.json()) as any)?.description ?? "");
      } catch {
        /* no body */
      }
      throw new Error(`telegram: HTTP ${res.status}${desc ? ` ${this.scrub(desc)}` : ""}`);
    }
  }

  /** Error texts never carry the token. */
  private scrub(s: string): string {
    return s.split(this.token).join("<token>");
  }
}

export interface MailTransport {
  sendMail(m: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** E-mail through an SMTP server (nodemailer). The transport can be injected (tests use nodemailer's JSON transport). */
export class EmailChannel implements Channel {
  readonly kind = "email" as const;
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
  ) {}

  static smtp(o: { host: string; port: number; user?: string; pass?: string; secure?: boolean; from: string }): EmailChannel {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require("nodemailer");
    const transport = nodemailer.createTransport({
      host: o.host,
      port: o.port,
      secure: o.secure ?? o.port === 465,
      auth: o.user ? { user: o.user, pass: o.pass } : undefined,
    });
    return new EmailChannel(transport, o.from);
  }

  async send(to: string, text: string, meta: SendMeta): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject: EMAIL_SUBJECT[meta.role], text });
  }
}
