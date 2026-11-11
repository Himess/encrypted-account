/**
 * Watchtower v0 (Design §12.3, F1.3).
 *  - Pushes pending public decryption results on-chain by itself (finalizeEvaluation / finalizeGuess):
 *    the user never has to click twice.
 *  - Notifies the owner on every wrong PIN, every `ok = false` result and every restricted-mode change.
 *  - Privately decrypts the tripwire flag (a handle shared only with the watchtower); if it has fired, puts the
 *    account into restricted mode.
 *  - Privately decrypts the duress flag (isDuress) and raises a silent alarm.
 *  - F0.10: notifies when an escape starts (every pending op has been cancelled, K54); never tries to finalize a
 *    cancelled evaluation; reminds the owner when the escape address has not been verified for over 90 days (K55).
 *  - F0.10 addendum (§8.3): tracks the ERC-20 approvals the account has granted (approval ops and Approval events of
 *    the watched tokens); when an escape starts, reports the ones still open and suggests approve(0) — an executed
 *    approval is not undone by the escape.
 *  - F0.11 (variant B): notifies the owner of every K-only outflow (OpenOutflow) that executes in a single transaction
 *    to a recipient on the open list within the limit, and of every change to the open list (OpenKnownChanged);
 *    in B there is no evaluation to finalize.
 *  - W1.7 (hidden inheritance): `WillWatcher` reminds the owner 30 and 7 days before the will's inactivity period
 *    ends (a correct PIN resets it), and alerts on WillStarted on every channel: unless a correct PIN comes within the
 *    grace period, the inheritance goes ahead.
 * The watchtower can only restrict; it cannot move funds or widen permissions (I9).
 */
import { Contract as EthersContract } from "ethers";
import type { Contract } from "ethers";

const ERC20_ABI = [
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

export interface PublicDecryptResult {
  abiEncodedClearValues: string;
  decryptionProof: string;
  clearValues: Record<string, unknown>;
}

export type Alert =
  | { kind: "wrong-pin"; opId: bigint; track: number }
  | { kind: "pin-ok"; opId: bigint; readyAt: bigint }
  | { kind: "policy-said-no"; opId: bigint }
  | { kind: "restriction"; reasons: number }
  | { kind: "tripwire"; asset: string }
  | { kind: "duress"; opId: bigint }
  | { kind: "recovery-opened"; opId: bigint }
  | { kind: "escape-started"; readyAt: bigint; to: string }
  | { kind: "escape-unverified"; days: number }
  | { kind: "open-approval"; token: string; spender: string; allowance: bigint; advice: string }
  | { kind: "open-outflow"; sub: number; asset: string; to: string; amount: bigint; spent: bigint }
  | { kind: "known-changed"; spenders: boolean; who: string; added: boolean }
  | { kind: "will-reminder"; will: string; daysLeft: number; startableAt: bigint }
  | { kind: "will-started"; will: string; settleableAt: bigint }
  | { kind: "will-settled"; will: string }
  | { kind: "error"; message: string };

/** K55: if control of the escape address has not been proven for longer than this, the owner is reminded (it blocks nothing). */
export const ESCAPE_REMIND_AFTER_S = 90 * 24 * 3600;

export interface WatchtowerDeps {
  account: Contract; // EncryptedAccount, connected to the guardian signer
  publicDecrypt: (handles: string[]) => Promise<PublicDecryptResult>;
  userDecryptBool: (handle: string, contract: string) => Promise<boolean>; // with the watchtower key
  notify: (a: Alert) => void;
  assets: string[]; // assets whose tripwire flag is watched
  restrictOnTrip?: boolean; // default true
}

export class Watchtower {
  private lastBlock = -1;
  private readonly seenTrip = new Set<string>();
  private remindedFor = -1n;
  /** (token, spender) pairs: from the account's approval ops and the Approval events of the watched tokens. */
  private readonly approvals = new Map<string, { token: string; spender: string }>();

  private noteApproval(token: string, spender: string) {
    this.approvals.set(`${token.toLowerCase()}|${spender.toLowerCase()}`, { token, spender });
  }

  /** When an escape starts: ERC-20 approvals still open (an executed approval is not undone by the escape) → suggest approve(0). */
  private async reportOpenApprovals(addr: string) {
    const provider = this.d.account.runner?.provider;
    for (const { token, spender } of this.approvals.values()) {
      const left: bigint = await new EthersContract(token, ERC20_ABI, provider).allowance(addr, spender);
      if (left > 0n) {
        this.d.notify({
          kind: "open-approval",
          token,
          spender,
          allowance: left,
          advice: "requestApprove(token, spender, 0) — K-only, instant; also available during the escape",
        });
      }
    }
  }
  constructor(private readonly d: WatchtowerDeps) {}

  /** Scans until it has caught up with the chain (including events produced by the watchtower's own finalize transactions). */
  async tick(maxRounds = 5): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const before = this.lastBlock;
      await this.scanOnce();
      const provider = this.d.account.runner?.provider;
      if (!provider || this.lastBlock === before || (await provider.getBlockNumber()) === this.lastBlock) break;
    }
  }

  /** One scan round: processes the events in [lastBlock+1, latest]. */
  private async scanOnce(): Promise<void> {
    const acct = this.d.account;
    const provider = acct.runner?.provider;
    if (!provider) throw new Error("account must be connected to a provider");
    const latest = await provider.getBlockNumber();
    const from = this.lastBlock + 1;
    if (from > latest) return;
    const logs = await acct.queryFilter("*" as any, from, latest);
    this.lastBlock = latest;
    const addr = await acct.getAddress();
    // approvals the account granted on the watched ERC-20s (including paths outside ops, such as permit signatures)
    for (const asset of this.d.assets) {
      if (/^0x0{40}$/i.test(asset)) continue;
      try {
        const t = new EthersContract(asset, ERC20_ABI, provider);
        for (const ev of (await t.queryFilter(t.filters.Approval(addr), from, latest)) as any[]) this.noteApproval(asset, ev.args.spender);
      } catch {
        /* not an ERC-20, or unreadable */
      }
    }

    for (const log of logs as any[]) {
      const name: string | undefined = log.fragment?.name ?? log.eventName;
      const args = log.args;
      try {
        if (name === "Evaluating") {
          if (Number((await acct.getOp(args.opId)).status) !== 1) continue; // cancelled in the meantime (e.g. escape, K54)
          const r = await this.d.publicDecrypt([args.okHandle]);
          await (await acct.finalizeEvaluation(args.opId, r.abiEncodedClearValues, r.decryptionProof)).wait();
        } else if (name === "EvaluationFinalized" && args.ok === false) {
          this.d.notify({ kind: "policy-said-no", opId: args.opId });
        } else if (name === "GuessSubmitted") {
          const hs = args.bigHandle === "0x" + "0".repeat(64) ? [args.okHandle] : [args.okHandle, args.bigHandle];
          const g = await acct.getGuess(args.opId);
          if (await this.d.userDecryptBool(g.duressFlagH, addr)) this.d.notify({ kind: "duress", opId: args.opId });
          const r = await this.d.publicDecrypt(hs);
          await (await acct.finalizeGuess(args.opId, r.abiEncodedClearValues, r.decryptionProof)).wait();
        } else if (name === "GuessFinalized") {
          if (args.ok) this.d.notify({ kind: "pin-ok", opId: args.opId, readyAt: args.readyAt });
          else this.d.notify({ kind: "wrong-pin", opId: args.opId, track: Number(args.track) });
        } else if (name === "RestrictionChanged") {
          this.d.notify({ kind: "restriction", reasons: Number(args.reasons) });
        } else if (name === "OpOpened" && Number(args.kind) === 4) {
          this.d.notify({ kind: "recovery-opened", opId: args.opId });
        } else if (name === "OpOpened" && Number(args.kind) === 1 && Number(args.sub) === 2) {
          this.noteApproval(args.target, args.counterparty); // approval op (whether it executed is read via allowance at escape)
        } else if (name === "OpenOutflow") {
          // B: a K-only outflow executed in this transaction (nothing for the watchtower to do; it only notifies)
          if (Number(args.sub) === 2) this.noteApproval(args.asset, args.counterparty);
          this.d.notify({ kind: "open-outflow", sub: Number(args.sub), asset: args.asset, to: args.counterparty, amount: args.amount, spent: args.spent });
        } else if (name === "OpenKnownChanged") {
          this.d.notify({ kind: "known-changed", spenders: Boolean(args.spenders), who: args.who, added: BigInt(args.activeAt) !== 0n });
        } else if (name === "EscapeStarted") {
          this.d.notify({ kind: "escape-started", readyAt: args.readyAt, to: args.to });
          await this.reportOpenApprovals(addr);
        }
      } catch (e: any) {
        this.d.notify({ kind: "error", message: `${name}: ${e?.shortMessage ?? e?.message ?? String(e)}` });
      }
    }

    // K55: remind once if the last verification of the escape address (setup, change or signed ping) is older than 90 days
    try {
      const es = await acct.escapeState();
      const blk = await provider.getBlock(latest);
      const age = BigInt(blk?.timestamp ?? 0) - BigInt(es.verifiedAt);
      if (age > BigInt(ESCAPE_REMIND_AFTER_S) && this.remindedFor !== BigInt(es.verifiedAt)) {
        this.remindedFor = BigInt(es.verifiedAt);
        this.d.notify({ kind: "escape-unverified", days: Math.floor(Number(age) / 86400) });
      }
    } catch {
      /* older account version: no escapeState */
    }

    // Silent alarm: tripwire flag (a handle allowed only for the watchtower)
    for (const asset of this.d.assets) {
      const h = await acct.encryptedHandles(asset);
      if (h.tripped === "0x" + "0".repeat(64) || this.seenTrip.has(h.tripped)) continue;
      this.seenTrip.add(h.tripped);
      if (await this.d.userDecryptBool(h.tripped, addr)) {
        this.d.notify({ kind: "tripwire", asset });
        const st = await acct.status();
        if ((this.d.restrictOnTrip ?? true) && (Number(st.restrictedReasons) & 2) === 0) {
          await (await acct.guardianRestrict()).wait();
        }
      }
    }
  }
}

// ───────────────────────────── hidden inheritance (W1.7) ─────────────────────────────

/** Days before a will's inactivity period ends at which the owner is reminded to enter a PIN. */
export const WILL_REMIND_DAYS: readonly number[] = [30, 7];

/**
 * Reminders due for one inactivity period: every threshold d not yet sent, once now ≥ startableAt − d days. Pure: the
 * caller remembers what it sent and forgets it when `startableAt` moves (a correct PIN moves it).
 */
export function dueWillReminders(nowS: bigint, startableAt: bigint, sent: ReadonlySet<number>, days: readonly number[] = WILL_REMIND_DAYS): number[] {
  return days.filter((d) => !sent.has(d) && nowS >= startableAt - BigInt(d) * 86400n).sort((a, b) => b - a);
}

export interface WillWatcherDeps {
  will: Contract; // EncryptedWill, connected to a provider
  notify: (a: Alert) => void; // the integration sends "will-started" on every channel it has
  remindDays?: readonly number[];
}

/** Watches one will: reminders before the inactivity period ends, alerts when it starts and settles. Read-only. */
export class WillWatcher {
  private lastBlock = -1;
  private sentFor = -1n;
  private readonly sent = new Set<number>();

  constructor(private readonly d: WillWatcherDeps) {}

  async tick(): Promise<void> {
    const will = this.d.will;
    const provider = will.runner?.provider;
    if (!provider) throw new Error("will must be connected to a provider");
    const latest = await provider.getBlockNumber();
    const addr = await will.getAddress();
    if (latest > this.lastBlock) {
      const logs = await will.queryFilter("*" as any, this.lastBlock + 1, latest);
      this.lastBlock = latest;
      for (const log of logs as any[]) {
        const name: string | undefined = log.fragment?.name ?? log.eventName;
        if (name === "WillStarted") this.d.notify({ kind: "will-started", will: addr, settleableAt: BigInt(log.args.settleableAt) });
        else if (name === "WillSettled") this.d.notify({ kind: "will-settled", will: addr });
      }
    }
    const st = await will.state();
    const phase = Number(st.phase);
    if (phase !== 1 && phase !== 2) return; // no heirs yet, started or settled: no reminders
    const startableAt = BigInt(st.startableAt);
    if (startableAt !== this.sentFor) {
      this.sentFor = startableAt;
      this.sent.clear();
    }
    const now = BigInt((await provider.getBlock(latest))?.timestamp ?? 0);
    const due = dueWillReminders(now, startableAt, this.sent, this.d.remindDays ?? WILL_REMIND_DAYS);
    if (!due.length) return;
    for (const x of due) this.sent.add(x);
    const daysLeft = startableAt > now ? Number((startableAt - now) / 86400n) : 0;
    this.d.notify({ kind: "will-reminder", will: addr, daysLeft, startableAt });
  }
}
