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
 *  - Private mode (optional): after every K-only private transfer (PrivateTransfer) it privately decrypts the token's
 *    K-only counter, the one handle the account shares with it, and tells the owner what happened. The counter's change
 *    is what really moved: zero means a silent zero (unknown recipient, the hidden limit, a fired tripwire, or too low a
 *    balance); 2^64 − 1 means the tripwire fired, and the account is restricted as on the public path. K itself never
 *    learns the outcome, so a key thief cannot probe the hidden limit.
 * The watchtower can only restrict; it cannot move funds or widen permissions (I9).
 *
 * Service options (watchtower/): `finalize: false` makes it a pure notifier that sends no transaction except a tripwire
 * restriction; `wrongPinAtSubmit` reports a wrong PIN from the public result when the guess is submitted (off-chain), so
 * a guess nobody finalizes is still reported; `fromBlock` / `maxLogRange` bound the log queries on a public RPC; every
 * alert comes with the transaction that caused it (`AlertRef`); `exportState` / `importState` let a service restart
 * where it stopped.
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
  | { kind: "duress"; opId: bigint; earliestRun?: bigint }
  | { kind: "op-paused"; opId: bigint; at: bigint }
  | { kind: "pause-lifted"; opId: bigint }
  | { kind: "device-change"; opId: bigint; helper: boolean }
  | { kind: "lane-only"; on: boolean }
  | { kind: "recovery-opened"; opId: bigint }
  | { kind: "escape-started"; readyAt: bigint; to: string }
  | { kind: "escape-unverified"; days: number }
  | { kind: "open-approval"; token: string; spender: string; allowance: bigint; advice: string }
  | { kind: "open-outflow"; sub: number; asset: string; to: string; amount: bigint; spent: bigint }
  | { kind: "known-changed"; spenders: boolean; who: string; added: boolean }
  | { kind: "will-reminder"; will: string; daysLeft: number; startableAt: bigint }
  | { kind: "will-started"; will: string; settleableAt: bigint }
  | { kind: "will-settled"; will: string }
  | { kind: "private-delivered"; token: string; to: string; moved: bigint }
  | { kind: "private-silent-zero"; token: string; to: string; tripped: boolean }
  | { kind: "private-tripwire"; token: string }
  | { kind: "error"; message: string };

const ZERO_HANDLE = "0x" + "0".repeat(64);
const KIND_ADMIN = 3; // AccountStorage.Kind.Admin
const clearBool = (v: unknown) => v === true || v === 1 || v === 1n || v === "true" || v === "1";
/** The clear value of `handle` in a public decryption result (keys compared without case); missing is an error, never "false". */
function clearOf(r: PublicDecryptResult, handle: string): unknown {
  const k = Object.keys(r.clearValues ?? {}).find((x) => x.toLowerCase() === handle.toLowerCase());
  if (k === undefined) throw new Error(`no public result for ${handle}`);
  return r.clearValues[k];
}

/** Private mode: the value a K-only counter saturates to when the tripwire fires (PrivateStorage.TRIPPED). */
export const PRIVATE_TRIPPED = (1n << 64n) - 1n;

/**
 * Private mode: what a K-only private transfer did, from the counter before (`prev`: the last value this watcher saw
 * and its day) and after. A new day restarts the counter at zero, except after a fired tripwire. Pure.
 */
export function privateOutcome(prev: { epoch: bigint; value: bigint } | undefined, epoch: bigint, now: bigint): { moved: bigint; tripped: boolean; newlyTripped: boolean } {
  const base = prev && prev.epoch === epoch ? prev.value : prev?.value === PRIVATE_TRIPPED ? PRIVATE_TRIPPED : 0n;
  if (now === PRIVATE_TRIPPED) return { moved: 0n, tripped: true, newlyTripped: base !== PRIVATE_TRIPPED };
  return { moved: now - base, tripped: false, newlyTripped: false };
}

/** K55: if control of the escape address has not been proven for longer than this, the owner is reminded (it blocks nothing). */
export const ESCAPE_REMIND_AFTER_S = 90 * 24 * 3600;

/** The transaction behind an alert (for logs and latency measurements; never part of a message). */
export interface AlertRef {
  txHash: string;
  blockNumber: number;
}

/** What a watcher remembers between runs. */
export interface WatchtowerState {
  lastBlock: number;
  seenTrip: string[];
  remindedFor: string;
  privateSpent: [string, { epoch: string; value: string }][];
  approvals: [string, { token: string; spender: string }][];
  wrongAtSubmit?: string[];
}

/**
 * The shortest delay an op of this kind can get after a correct PIN (OpsLib.delayFor): the trusted contact's deadline for
 * a pause. An outflow may still land in the longer class once its delay class is decrypted. Private ops ask the account.
 */
export function minDelayOf(kind: number, sub: number, amount: bigint, d: Record<string, any>): bigint {
  const n = (x: any) => BigInt(x);
  if (kind === 1) return n(d.pinTransfer);
  if (kind === 2) return amount > 0n && n(d.bigTransfer) > n(d.genericCall) ? n(d.bigTransfer) : n(d.genericCall);
  if (kind === 4) return n(d.recovery) < n(d.recoveryNoDevice) ? n(d.recovery) : n(d.recoveryNoDevice);
  if (kind === 5) return n(d.pinReset);
  // cancel, unrestrict, freeze, reset trip, cancel escape, private view, private reset, unpause
  if ([1, 2, 3, 7, 19, 23, 24, 26].includes(sub)) return 0n;
  if ([4, 5, 10, 11, 12, 21, 25].includes(sub)) return n(d.settings); // 25: the private duress setting
  if (sub === 8 || sub === 9) return n(d.knownAdd);
  if (sub === 13) return n(d.escapeChange);
  if (sub === 17) return n(d.genericCall);
  const H72 = 72n * 3600n;
  if (sub === 22) return n(d.bigTransfer) > H72 ? n(d.bigTransfer) : H72; // a private send: max(bigTransfer, 72 h)
  if (sub === 27) return n(d.loosen) > H72 ? n(d.loosen) : H72; // the two-device setting off
  return n(d.loosen);
}

export interface WatchtowerDeps {
  account: Contract; // EncryptedAccount, connected to the guardian signer
  publicDecrypt: (handles: string[]) => Promise<PublicDecryptResult>;
  userDecryptBool: (handle: string, contract: string) => Promise<boolean>; // with the watchtower key
  /** Private mode: decrypts a K-only counter (euint64) with the watchtower key; without it private transfers are skipped. */
  userDecryptU64?: (handle: string, contract: string) => Promise<bigint>;
  notify: (a: Alert, ref?: AlertRef) => void;
  assets: string[]; // assets whose tripwire flag is watched
  restrictOnTrip?: boolean; // default true
  /** Push pending public decryption results on-chain (finalizeEvaluation / finalizeGuess). Default true. */
  finalize?: boolean;
  /** First block to scan (default 0). */
  fromBlock?: number;
  /** The widest block range of one log query (default: no limit); public RPCs cap eth_getLogs ranges. */
  maxLogRange?: number;
  /** Report a wrong PIN when the guess is submitted (public yes / no result, decrypted off-chain), not at finalize. */
  wrongPinAtSubmit?: boolean;
}

export class Watchtower {
  private lastBlock = -1;
  private readonly seenTrip = new Set<string>();
  private remindedFor = -1n;
  /** Private mode: the last K-only counter seen per token, with its day. */
  private readonly privateSpent = new Map<string, { epoch: bigint; value: bigint }>();
  /** (token, spender) pairs: from the account's approval ops and the Approval events of the watched tokens. */
  private readonly approvals = new Map<string, { token: string; spender: string }>();
  /** Ops whose wrong guess was already reported at submit (not again at finalize). */
  private readonly wrongAtSubmit = new Set<string>();

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
  constructor(private readonly d: WatchtowerDeps) {
    this.lastBlock = (d.fromBlock ?? 0) - 1;
  }

  /** The earliest time an op approved in `blockNumber` can run: that block's time plus the shortest delay of its class. */
  private async earliestRun(acct: Contract, opId: bigint, blockNumber: number): Promise<bigint> {
    const provider = acct.runner?.provider;
    if (!provider) throw new Error("no provider");
    const [op, d, b] = await Promise.all([acct.getOp(opId), acct.delays(), provider.getBlock(blockNumber)]);
    const kind = Number(op.kind);
    const sub = Number(op.sub);
    const delay = kind === KIND_ADMIN && sub >= 22 && sub <= 25 ? BigInt(await acct.privateDelay(sub)) : minDelayOf(kind, sub, BigInt(op.amount), d);
    return BigInt(b!.timestamp) + delay;
  }

  exportState(): WatchtowerState {
    return {
      lastBlock: this.lastBlock,
      seenTrip: [...this.seenTrip],
      remindedFor: this.remindedFor.toString(),
      privateSpent: [...this.privateSpent].map(([k, v]) => [k, { epoch: v.epoch.toString(), value: v.value.toString() }]),
      approvals: [...this.approvals],
      wrongAtSubmit: [...this.wrongAtSubmit],
    };
  }

  importState(s: WatchtowerState): void {
    this.lastBlock = s.lastBlock;
    this.seenTrip.clear();
    for (const h of s.seenTrip) this.seenTrip.add(h);
    this.remindedFor = BigInt(s.remindedFor);
    this.privateSpent.clear();
    for (const [k, v] of s.privateSpent) this.privateSpent.set(k, { epoch: BigInt(v.epoch), value: BigInt(v.value) });
    this.approvals.clear();
    for (const [k, v] of s.approvals) this.approvals.set(k, v);
    this.wrongAtSubmit.clear();
    for (const k of s.wrongAtSubmit ?? []) this.wrongAtSubmit.add(k);
  }

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
    const head = await provider.getBlockNumber();
    const from = this.lastBlock + 1;
    if (from > head) return;
    const latest = this.d.maxLogRange ? Math.min(head, from + this.d.maxLogRange - 1) : head;
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
      const ref: AlertRef = { txHash: log.transactionHash, blockNumber: log.blockNumber };
      const notify = (a: Alert) => this.d.notify(a, ref);
      try {
        if (name === "Evaluating") {
          if (this.d.finalize === false) continue;
          if (Number((await acct.getOp(args.opId)).status) !== 1) continue; // cancelled in the meantime (e.g. escape, K54)
          const r = await this.d.publicDecrypt([args.okHandle]);
          await (await acct.finalizeEvaluation(args.opId, r.abiEncodedClearValues, r.decryptionProof)).wait();
        } else if (name === "EvaluationFinalized" && args.ok === false) {
          notify({ kind: "policy-said-no", opId: args.opId });
        } else if (name === "GuessSubmitted") {
          const hs = args.bigHandle === "0x" + "0".repeat(64) ? [args.okHandle] : [args.okHandle, args.bigHandle];
          // the record as it was in the guess's block: the per-track record is reused by the next guess on that track
          const g = await acct.getGuess(args.opId, { blockTag: log.blockNumber }).catch(() => acct.getGuess(args.opId));
          let flag: string = g.duressFlagH;
          if (BigInt(g.opId) !== BigInt(args.opId) || flag === ZERO_HANDLE) {
            // overwritten already: a private-mode op keeps the flag of its correct PIN in op.h2 (sub 22–25)
            const op = await acct.getOp(args.opId);
            flag = Number(op.kind) === KIND_ADMIN && Number(op.sub) >= 22 && Number(op.sub) <= 25 ? op.h2 : ZERO_HANDLE;
          }
          if (!flag || flag === ZERO_HANDLE) throw new Error(`no duress flag readable for op ${args.opId}`);
          // both checked for every guess, so the decryptions look the same whatever the PIN was: the duress flag (allowed
          // to the watchtower only) and, with wrongPinAtSubmit, the public yes / no result, off-chain (a wrong guess is
          // then reported even if nobody ever finalizes it)
          const atSubmit = this.d.wrongPinAtSubmit === true || this.d.finalize !== false;
          const [duress, pub] = await Promise.all([this.d.userDecryptBool(flag, addr), atSubmit ? this.d.publicDecrypt(hs) : Promise.resolve(null)]);
          if (duress) notify({ kind: "duress", opId: args.opId, earliestRun: await this.earliestRun(acct, args.opId, log.blockNumber).catch(() => undefined) });
          if (pub && this.d.wrongPinAtSubmit && !clearBool(clearOf(pub, args.okHandle))) {
            this.wrongAtSubmit.add(String(args.opId));
            notify({ kind: "wrong-pin", opId: args.opId, track: Number(args.track) });
          }
          if (this.d.finalize === false || !pub) continue;
          await (await acct.finalizeGuess(args.opId, pub.abiEncodedClearValues, pub.decryptionProof)).wait();
        } else if (name === "GuessFinalized") {
          if (args.ok) notify({ kind: "pin-ok", opId: args.opId, readyAt: args.readyAt });
          else if (!this.wrongAtSubmit.delete(String(args.opId))) notify({ kind: "wrong-pin", opId: args.opId, track: Number(args.track) });
        } else if (name === "GuardianPaused") {
          notify({ kind: "op-paused", opId: args.opId, at: BigInt(args.pausedAt) });
        } else if (name === "PauseLifted") {
          notify({ kind: "pause-lifted", opId: args.opId });
        } else if (name === "RestrictionChanged") {
          notify({ kind: "restriction", reasons: Number(args.reasons) });
        } else if (name === "OpOpened" && Number(args.kind) === KIND_ADMIN && (Number(args.sub) === 11 || Number(args.sub) === 12)) {
          // a change of the second device or the recovery helper: without the device it waits the long no-device delay
          notify({ kind: "device-change", opId: args.opId, helper: Number(args.sub) === 12 });
        } else if (name === "LaneOnlySet") {
          notify({ kind: "lane-only", on: Boolean(args.on) });
        } else if (name === "OpOpened" && Number(args.kind) === 4) {
          notify({ kind: "recovery-opened", opId: args.opId });
        } else if (name === "OpOpened" && Number(args.kind) === 1 && Number(args.sub) === 2) {
          this.noteApproval(args.target, args.counterparty); // approval op (whether it executed is read via allowance at escape)
        } else if (name === "OpenOutflow") {
          // B: a K-only outflow executed in this transaction (nothing for the watchtower to do; it only notifies)
          if (Number(args.sub) === 2) this.noteApproval(args.asset, args.counterparty);
          notify({ kind: "open-outflow", sub: Number(args.sub), asset: args.asset, to: args.counterparty, amount: args.amount, spent: args.spent });
        } else if (name === "OpenKnownChanged") {
          notify({ kind: "known-changed", spenders: Boolean(args.spenders), who: args.who, added: BigInt(args.activeAt) !== 0n });
        } else if (name === "EscapeStarted") {
          notify({ kind: "escape-started", readyAt: args.readyAt, to: args.to });
          await this.reportOpenApprovals(addr);
        } else if (name === "PrivateTransfer" && this.d.userDecryptU64) {
          const key = String(args.token).toLowerCase();
          const epoch = BigInt(args.epoch);
          const now = await this.d.userDecryptU64(args.spent, addr);
          const r = privateOutcome(this.privateSpent.get(key), epoch, now);
          this.privateSpent.set(key, { epoch, value: now });
          if (r.moved > 0n) notify({ kind: "private-delivered", token: args.token, to: args.to, moved: r.moved });
          else notify({ kind: "private-silent-zero", token: args.token, to: args.to, tripped: r.tripped });
          if (r.newlyTripped) {
            notify({ kind: "private-tripwire", token: args.token });
            const st = await acct.status();
            if ((this.d.restrictOnTrip ?? true) && (Number(st.restrictedReasons) & 2) === 0) await (await acct.guardianRestrict()).wait();
          }
        }
      } catch (e: any) {
        this.d.notify({ kind: "error", message: `${name}: ${e?.shortMessage ?? e?.message ?? String(e)}` }, ref);
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
