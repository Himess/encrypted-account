/**
 * Message texts. Rules: no amount ever (no balance, no transfer amount, no limit, no hidden amount); the silent alarm says only
 * which account, when, that the duress PIN was used, and the owner's optional note. The owner's texts are the same for a
 * real and a duress PIN: nothing the owner's channel shows depends on which PIN was used.
 */
import type { Alert } from "../../sdk/src/watchtower";

export interface MessageCtx {
  label: string;
  address: string;
  at: Date;
}

/** What the trusted contact can do about a duress-approved op: its number, the earliest time it can run, and the command. */
export interface PauseStep {
  opId: bigint;
  /** Unix seconds; absent when it could not be read. */
  earliestRun?: bigint;
  /** The command that pauses the account's pending ops, as the trusted contact runs it on the watchtower's computer. */
  command: string;
}

/** 2026-11-16T14:03:12Z (UTC, seconds). */
export const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const isoS = (s: bigint) => iso(new Date(Number(s) * 1000));
const short = (a: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

const RESTRICTION_REASONS: [number, string][] = [
  [1, "wrong PIN tries"],
  [2, "the watchtower"],
  [4, "the owner key"],
  [8, "a PIN freeze"],
];

/** The owner's text for an alert, or null when the owner is not told (the duress alarm, errors). */
export function ownerMessage(a: Alert, c: MessageCtx): string | null {
  const head = `${c.label} (${c.address})`;
  const t = iso(c.at);
  switch (a.kind) {
    case "wrong-pin":
      return a.track === 1
        ? `${head}\nA wrong PIN was entered on the recovery track at ${t}.`
        : `${head}\nA wrong PIN was entered at ${t}. Whoever tried it used your account key. If it was not you, your key is in someone else's hands: start the escape from your escape wallet.`;
    case "pin-ok":
      return `${head}\nA correct PIN approved an operation at ${t}. It can run from ${isoS(a.readyAt)}. If it was not you, cancel it before then.`;
    case "policy-said-no":
      return `${head}\nA key-only operation was refused by your hidden policy at ${t}. Nothing moved.`;
    case "restriction": {
      if (a.reasons === 0) return `${head}\nYour account is no longer restricted (${t}).`;
      const why = RESTRICTION_REASONS.filter(([b]) => (a.reasons & b) !== 0).map(([, s]) => s);
      return `${head}\nYour account is restricted now (${t}): ${why.join(", ") || "another reason"}.`;
    }
    case "tripwire":
      return `${head}\nThe hidden tripwire of a key-only path fired at ${t}. Key-only transfers stop; the account is being restricted.`;
    case "recovery-opened":
      return `${head}\nA recovery was opened at ${t}. If it was not you, cancel it with your PIN before its delay ends.`;
    case "escape-started":
      return `${head}\nAn escape started at ${t}. After its delay everything goes to your escape address (${short(a.to)}); pending operations were cancelled.`;
    case "escape-unverified":
      return `${head}\nYour escape address has not been verified for ${a.days} days. Sign the check from your escape wallet.`;
    case "open-approval":
      return `${head}\nA token approval for ${short(a.spender)} on ${short(a.token)} is still open; an escape does not undo it. Set it to zero.`;
    case "open-outflow":
      return `${head}\nA key-only transfer left your account at ${t}, to ${short(a.to)}.`;
    case "known-changed":
      return `${head}\nYour known ${a.spenders ? "spender" : "recipient"} list changed at ${t}: ${short(a.who)} ${a.added ? "added" : "removed"}.`;
    case "will-reminder":
      return `${head}\nYour hidden will can start in ${a.daysLeft} days unless you enter your PIN before then.`;
    case "will-started":
      return `${head}\nYour hidden will started at ${t}. A correct PIN within its grace period stops it.`;
    case "will-settled":
      return `${head}\nYour hidden will was settled at ${t}.`;
    case "private-delivered":
      return `${head}\nA private send made with your key alone was delivered at ${t}.`;
    case "private-silent-zero":
      // the same text whatever the reason (unknown recipient, the hidden limit, a fired tripwire)
      return `${head}\nA private send made with your key alone moved zero at ${t}: an unknown recipient, more than the key alone may send, or a fired tripwire.`;
    case "private-tripwire":
      return `${head}\nA key-only private send went above the hidden limit at ${t}. Key-only private sends now move zero until a reset with your PIN.`;
    case "op-paused":
      return `${head}\nOperation #${a.opId} was paused by your watchtower at ${isoS(a.at)}: it can run no earlier than 72 hours after its own waiting time ends. With your second device and PIN you can lift the pause sooner.`;
    case "device-change":
      return `${head}
A change of your ${a.helper ? "recovery helper" : "second device"} was opened at ${t} (operation #${a.opId}). It needs your PIN and then waits; made without your second device, it waits the long no-device delay. If it was not you, cancel it before it runs.`;
    case "lane-only":
      return a.on
        ? `${head}
The two-device setting was turned on at ${t}: big sends, calls and loosening changes now need a PIN approved on your second device.`
        : `${head}
The two-device setting was turned off at ${t}.`;
    case "pause-lifted":
      return `${head}\nThe pause of operation #${a.opId} was lifted at ${t} (second device and PIN).`;
    case "duress":
    case "error":
      return null;
  }
}

/**
 * The silent alarm: account, time, that the duress PIN was used, what the trusted contact can do (pause the pending ops
 * before the earliest time the approved one can run), and the owner's optional note. No amount, ever.
 */
export function duressMessage(c: MessageCtx, note?: string, pause?: PauseStep): string {
  const lines = ["Silent alarm (watchtower)", `Account: ${c.label} (${c.address})`, `Time: ${iso(c.at)}`, "The duress PIN was used on this account."];
  if (pause) {
    lines.push(
      pause.earliestRun === undefined
        ? `Operation #${pause.opId} was approved with it.`
        : pause.earliestRun * 1000n <= BigInt(c.at.getTime())
          ? `Operation #${pause.opId} was approved with it and can run at once: a pause cannot hold it.`
          : `Operation #${pause.opId} was approved with it and can run from ${isoS(pause.earliestRun)}: pause before then.`,
    );
    lines.push(`To pause the account's pending operations (each once, for up to 72 hours), run on the watchtower's computer: ${pause.command}`);
  }
  const n = (note ?? "").trim();
  if (n) lines.push(`Note from the owner: ${n}`);
  return lines.join("\n");
}

export const EMAIL_SUBJECT = { owner: "Account notice (watchtower)", trusted: "Silent alarm (watchtower)" } as const;
