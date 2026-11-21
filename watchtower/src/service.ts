/**
 * The watchtower service: one SDK Watchtower per account (sdk/src/watchtower.ts), run as a pure notifier.
 *
 *  - It never finalizes anything for the user (`finalize: false`), so around a PIN entry it sends no transaction at all;
 *    the only transaction it can send is the restriction when a key-only tripwire fires (configurable).
 *  - The duress flag of every guess is decrypted, real PIN or not, so its requests look the same either way; the alarm
 *    goes to the trusted contacts only, and nothing is done on-chain.
 *  - Deliveries are queued and sent in the background: the scan never waits for a channel, so a duress alarm does not
 *    delay (or reorder) the owner's notices.
 */
import * as fs from "fs";
import * as path from "path";
import { Contract, ethers } from "ethers";
import { Alert, AlertRef, PublicDecryptResult, Watchtower, WatchtowerState } from "../../sdk/src/watchtower";
import { ACCOUNT_P_ABI } from "../../web/src/abi";
import type { Channel } from "./channels";
import { FakeChannel } from "./channels";
import type { AccountConfig, ChannelKind, ServiceConfig } from "./config";
import { Delivery, route } from "./router";

export interface ServiceDeps {
  config: ServiceConfig;
  /** The config file's path, as the trusted contact passes it to the pause command (default watchtower/config.json). */
  configFile?: string;
  /** The guardian signer, connected to the chain's provider. */
  guardian: ethers.Signer;
  userDecryptBool: (handle: string, contract: string) => Promise<boolean>;
  userDecryptU64: (handle: string, contract: string) => Promise<bigint>;
  /** Public decryption (off-chain): with it, a wrong PIN is reported when the guess is submitted, even if never finalized. */
  publicDecrypt?: (handles: string[]) => Promise<PublicDecryptResult>;
  /** Available channels; a destination whose channel is missing goes to `fallback` (a fake channel). */
  channels: Partial<Record<ChannelKind, Channel>>;
  fallback: FakeChannel;
  now?: () => Date;
  log?: (line: string) => void;
  /** Retry waits of a failed delivery (ms). */
  retryMs?: number[];
}

export interface DeliveryRecord {
  at: number;
  account: string;
  kind: string;
  role: string;
  channel: string;
  ok: boolean;
  attempts: number;
  error?: string;
}

/**
 * The trusted contact's brake: pauses an account's pending ops with the guardian key (guardianPause, each op once, for up
 * to 72 hours). Never called by the service itself; only by the --pause command, on a person's decision. Without `ids` it
 * pauses every pending op among the account's latest `scan` ops that is not paused yet. Returns what it did per op.
 */
export async function pausePending(account: Contract, ids?: bigint[], scan = 50): Promise<{ opId: bigint; hash?: string; error?: string }[]> {
  let list = ids ?? [];
  if (!ids) {
    const n = Number(await account.opCount());
    for (let id = n; id >= 1 && id > n - scan; id--) {
      const st = Number((await account.getOp(id)).status);
      if (st >= 1 && st <= 4) list.push(BigInt(id)); // Evaluating, NeedsPin, Guessing, Delayed
    }
    list = list.reverse();
  }
  const out: { opId: bigint; hash?: string; error?: string }[] = [];
  for (const opId of list) {
    try {
      const tx = await account.guardianPause(opId);
      await tx.wait();
      out.push({ opId, hash: tx.hash });
    } catch (e: any) {
      out.push({ opId, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160) });
    }
  }
  return out;
}

export class WatchtowerService {
  readonly watchers: { cfg: AccountConfig; wt: Watchtower }[] = [];
  readonly deliveries: DeliveryRecord[] = [];
  private readonly queues = new Map<string, Promise<void>>();
  private pending = 0;
  private readonly idle: (() => void)[] = [];
  private readonly log: (line: string) => void;
  private stopped = false;

  constructor(private readonly d: ServiceDeps) {
    this.log = d.log ?? ((l) => console.log(l));
    for (const cfg of d.config.accounts) {
      const account = new Contract(ethers.getAddress(cfg.address), ACCOUNT_P_ABI as any, d.guardian);
      const wt = new Watchtower({
        account,
        publicDecrypt:
          d.publicDecrypt ??
          (async () => {
            throw new Error("no public decryption configured");
          }),
        wrongPinAtSubmit: !!d.publicDecrypt,
        userDecryptBool: d.userDecryptBool,
        userDecryptU64: d.userDecryptU64,
        notify: (a, ref) => this.onAlert(cfg, a, ref),
        assets: cfg.assets ?? [ethers.ZeroAddress],
        restrictOnTrip: d.config.restrictOnTripwire ?? true,
        finalize: false,
        fromBlock: cfg.fromBlock,
        maxLogRange: d.config.maxLogRange ?? 2000,
      });
      this.watchers.push({ cfg, wt });
    }
    this.loadState();
  }

  private onAlert(cfg: AccountConfig, a: Alert, ref?: AlertRef) {
    if (a.kind === "error") {
      // to the operator's log only: never to the owner (an error text could differ between a real and a duress PIN)
      this.log(`[error] ${cfg.label}: ${a.message}`);
      return;
    }
    for (const dl of route(a, cfg, (this.d.now ?? (() => new Date()))(), ref, this.d.configFile)) this.enqueue(dl);
  }

  private enqueue(dl: Delivery) {
    const key = `${dl.dest.channel}:${dl.dest.to}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    this.pending++;
    const next = prev
      .then(() => this.deliver(dl))
      .catch(() => undefined)
      .finally(() => {
        if (--this.pending === 0) for (const f of this.idle.splice(0)) f();
      });
    this.queues.set(key, next);
  }

  private async deliver(dl: Delivery) {
    const ch = this.d.channels[dl.dest.channel] ?? this.d.fallback.standIn(`${dl.dest.channel} (not configured)`);
    const waits = this.d.retryMs ?? [1000, 4000, 15000];
    let attempts = 0;
    let error: string | undefined;
    for (;;) {
      attempts++;
      try {
        await ch.send(dl.dest.to, dl.text, { account: dl.account, role: dl.role, kind: dl.kind, ref: dl.ref });
        error = undefined;
        break;
      } catch (e: any) {
        error = String(e?.message ?? e).slice(0, 200);
        if (attempts > waits.length) break;
        await new Promise((r) => setTimeout(r, waits[attempts - 1]));
      }
    }
    const rec: DeliveryRecord = { at: Date.now(), account: dl.account, kind: dl.kind, role: dl.role, channel: ch.kind, ok: !error, attempts, ...(error ? { error } : {}) };
    this.deliveries.push(rec);
    const file = this.d.config.deliveryLog;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(rec) + "\n");
    }
    if (error) this.log(`[delivery failed] ${dl.kind} → ${dl.role} via ${ch.kind}: ${error}`);
  }

  /** Waits until every queued delivery has been tried. */
  drain(): Promise<void> {
    return this.pending === 0 ? Promise.resolve() : new Promise((r) => this.idle.push(r));
  }

  /** One pass over every account; a failing account does not stop the others. Returns how many failed. */
  async tickAll(): Promise<number> {
    let failed = 0;
    for (const { cfg, wt } of this.watchers) {
      try {
        await wt.tick();
      } catch (e: any) {
        failed++;
        const method = e?.info?.payload?.method ?? e?.payload?.method;
        const rpc = e?.info?.error?.message ?? e?.error?.message;
        this.log(`[error] ${cfg.label}: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 200)}${method ? ` (${method})` : ""}${rpc ? `: ${String(rpc).slice(0, 120)}` : ""}`);
      }
    }
    this.saveState();
    return failed;
  }

  async run(): Promise<void> {
    const ms = Math.max(1, this.d.config.pollSeconds ?? 4) * 1000;
    while (!this.stopped) {
      const t0 = Date.now();
      await this.tickAll();
      const wait = ms - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    await this.drain();
  }

  stop() {
    this.stopped = true;
  }

  private loadState() {
    const file = this.d.config.stateFile;
    if (!file || !fs.existsSync(file)) return;
    const all = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, WatchtowerState>;
    for (const { cfg, wt } of this.watchers) {
      const s = all[ethers.getAddress(cfg.address)];
      if (s) wt.importState(s);
    }
  }

  private saveState() {
    const file = this.d.config.stateFile;
    if (!file) return;
    const all: Record<string, WatchtowerState> = {};
    for (const { cfg, wt } of this.watchers) all[ethers.getAddress(cfg.address)] = wt.exportState();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 1));
  }
}
