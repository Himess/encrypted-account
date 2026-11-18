/**
 * Who hears about what. The duress alarm goes to the trusted contacts only, and never to a destination that is also one
 * of the owner's (checked again here, after the config check); every other notice goes to the owner only.
 */
import type { Alert, AlertRef } from "../../sdk/src/watchtower";
import { AccountConfig, Destination, normalizeDest } from "./config";
import { duressMessage, ownerMessage } from "./messages";

export type Role = "owner" | "trusted";

export interface Delivery {
  account: string;
  role: Role;
  dest: Destination;
  kind: Alert["kind"];
  text: string;
  ref?: AlertRef;
}

export function route(a: Alert, acct: AccountConfig, at: Date, ref?: AlertRef): Delivery[] {
  const ctx = { label: acct.label, address: acct.address, at };
  if (a.kind === "error") return [];
  if (a.kind === "duress") {
    const owner = new Set((acct.owner ?? []).map(normalizeDest));
    const text = duressMessage(ctx, acct.duressNote);
    return (acct.trusted ?? []).filter((d) => !owner.has(normalizeDest(d))).map((dest) => ({ account: acct.address, role: "trusted" as const, dest, kind: a.kind, text, ref }));
  }
  if (a.kind === "pin-ok" && acct.notifyPinOk === false) return [];
  const text = ownerMessage(a, ctx);
  if (!text) return [];
  return (acct.owner ?? []).map((dest) => ({ account: acct.address, role: "owner" as const, dest, kind: a.kind, text, ref }));
}
