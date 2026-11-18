/**
 * Watchtower service configuration: which accounts it watches, and who hears about what.
 *
 * The owner's channels get the notices about the account (wrong PIN, key-only private sends, restrictions, the escape).
 * The trusted contacts get one thing only: the silent alarm when the duress PIN is used. These settings live in this
 * file, never on-chain. Secrets (the watchtower key, the bot token, SMTP login) live in an env file, never here.
 */
import * as fs from "fs";
import { ethers } from "ethers";

export type ChannelKind = "telegram" | "email" | "fake";

export interface Destination {
  channel: ChannelKind;
  /** Telegram chat id, e-mail address, or a label for the fake channel. */
  to: string;
  /** Optional name, for logs only. */
  name?: string;
}

export interface AccountConfig {
  label: string;
  address: string;
  /** First block to scan (the account's creation block is a good start). */
  fromBlock?: number;
  /** Public-path assets whose tripwire flag is watched (default: ETH). */
  assets?: string[];
  /** The owner's channels. Never put a channel here that a trusted contact reads, or the other way round. */
  owner: Destination[];
  /** Who gets the silent alarm when the duress PIN is used. Must not include any of the owner's channels. */
  trusted?: Destination[];
  /** An optional short note the owner wrote in advance, sent with the silent alarm. */
  duressNote?: string;
  /** Tell the owner about every correct PIN (default true): a PIN-approved operation they did not make is a warning. */
  notifyPinOk?: boolean;
}

export interface EnvRef {
  /** Path of a dotenv file, relative to the working directory. */
  envFile: string;
  var: string;
}

export interface ServiceConfig {
  network: {
    chainId: number;
    rpcUrls: string[];
    /** "sepolia": decrypt through Zama's relayer and KMS with the watchtower key. */
    fhevm: "sepolia" | "none";
  };
  /** The watchtower (guardian) key: it may decrypt what accounts allow it, and restrict an account; nothing else. */
  guardianKey: EnvRef;
  pollSeconds?: number;
  /** The widest block range of one log query (default 2000). */
  maxLogRange?: number;
  /** Where the service remembers how far it got (default watchtower/data/state.json). */
  stateFile?: string;
  /** One line per delivery attempt, without the message text (default watchtower/data/deliveries.jsonl). */
  deliveryLog?: string;
  /** Restrict an account when its key-only tripwire fires (default true). Never done for the duress PIN. */
  restrictOnTripwire?: boolean;
  channels?: {
    telegram?: { envFile?: string; botTokenVar?: string };
    email?: { envFile?: string; hostVar?: string; portVar?: string; userVar?: string; passVar?: string; from?: string; secure?: boolean };
    fake?: { file?: string; console?: boolean };
  };
  accounts: AccountConfig[];
}

export const DURESS_NOTE_MAX = 280;

/** A comparable form of a destination: the same mailbox or chat written another way is still the same destination. */
export function normalizeDest(d: Destination): string {
  const to = String(d.to ?? "").trim().toLowerCase();
  if (d.channel === "email") {
    const at = to.lastIndexOf("@");
    let local = at > 0 ? to.slice(0, at) : to;
    let domain = at > 0 ? to.slice(at + 1) : "";
    local = local.split("+")[0];
    if (domain === "googlemail.com") domain = "gmail.com";
    if (domain === "gmail.com") local = local.replace(/\./g, "");
    return `email:${local}@${domain}`;
  }
  return `${d.channel}:${to.replace(/^@/, "")}`;
}

export function validateConfig(cfg: ServiceConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!cfg || typeof cfg !== "object") return { errors: ["the config is not an object"], warnings };
  if (!cfg.network || !Array.isArray(cfg.network.rpcUrls) || cfg.network.rpcUrls.length === 0) errors.push("network.rpcUrls: at least one RPC URL");
  if (!cfg.guardianKey?.envFile || !cfg.guardianKey?.var) errors.push("guardianKey: envFile and var (the key itself never goes in this file)");
  if (!Array.isArray(cfg.accounts) || cfg.accounts.length === 0) errors.push("accounts: at least one account");
  const seen = new Set<string>();
  const kinds: ChannelKind[] = ["telegram", "email", "fake"];
  for (const [i, a] of (cfg.accounts ?? []).entries()) {
    const at = `accounts[${i}]`;
    if (!a.label || typeof a.label !== "string") errors.push(`${at}.label: a short name`);
    if (!ethers.isAddress(a.address)) errors.push(`${at}.address: not an address`);
    else {
      const k = ethers.getAddress(a.address);
      if (seen.has(k)) errors.push(`${at}: the account is listed twice`);
      seen.add(k);
    }
    const owner = Array.isArray(a.owner) ? a.owner : [];
    const trusted = Array.isArray(a.trusted) ? a.trusted : [];
    for (const [j, d] of [...owner.map((d) => ["owner", d] as const), ...trusted.map((d) => ["trusted", d] as const)].entries()) {
      if (!kinds.includes(d[1].channel)) errors.push(`${at}.${d[0]}[${j}]: unknown channel "${d[1].channel}"`);
      if (!d[1].to || typeof d[1].to !== "string") errors.push(`${at}.${d[0]}[${j}]: "to" is empty`);
      if (d[1].channel === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d[1].to ?? "")) errors.push(`${at}.${d[0]}[${j}]: not an e-mail address`);
    }
    if (owner.length === 0) warnings.push(`${at}: no owner channel; wrong-PIN and private-send notices go nowhere`);
    const ownerKeys = new Set(owner.map(normalizeDest));
    for (const d of trusted) {
      if (ownerKeys.has(normalizeDest(d))) errors.push(`${at}.trusted: ${d.channel} "${d.to}" is also an owner channel; the silent alarm must never reach the owner's own device or channel`);
    }
    if (a.duressNote !== undefined) {
      if (typeof a.duressNote !== "string") errors.push(`${at}.duressNote: text`);
      else if (a.duressNote.length > DURESS_NOTE_MAX) errors.push(`${at}.duressNote: at most ${DURESS_NOTE_MAX} characters`);
    }
    if (trusted.length > 0 && cfg.network?.fhevm === "none") warnings.push(`${at}: trusted contacts are set but fhevm is "none"; the duress flag cannot be read`);
    if (a.duressNote && trusted.length === 0) warnings.push(`${at}: a duress note without a trusted contact is never sent`);
  }
  return { errors, warnings };
}

export function loadConfig(file: string): ServiceConfig {
  return JSON.parse(fs.readFileSync(file, "utf8")) as ServiceConfig;
}

/** dotenv reader without dependencies; never prints values (same rules as scripts/lib/env.ts). */
export function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}
