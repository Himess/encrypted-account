/**
 * The Sepolia app: connect → create an Encrypted Account (PIN, hidden limit, 8 transactions) → deposit → send with the
 * PIN. Chain logic lives in account.ts / fhe.ts / tx.ts; this file is only the interface.
 */
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ethers } from "ethers";
import { CHAIN_ID, CHAIN_ID_HEX, ETH_UNIT, FACTORY_P, RPC_URL, WATCHTOWER, addrUrl, txUrl } from "./chain";
import {
  ALIVE_STEPS,
  Activity,
  AccountView,
  CALL_STEPS,
  Ctx,
  DURESS_STEPS,
  OwnerBond,
  PIN_CHANGE_STEPS,
  PRIVATE_SETUP_STEP,
  PRIVATE_MODE_VERSION,
  PRIVATE_SUB,
  privateModeVersionOf,
  LANE_OFF_STEPS,
  PAIR_STEPS,
  PHONE_SEND_STEPS,
  PhoneLink,
  PhoneOp,
  approveLink,
  buildApproval,
  createDeviceKey,
  disableLaneOnlyWithPhone,
  enableLaneOnly,
  loadDeviceKey,
  pairDeviceWithPin,
  pairLink,
  parsePhoneLink,
  readCosigners,
  readLaneOnly,
  laneOnlySupported,
  readOpForPhone,
  sendWithPhone,
  PRIVATE_VIEW_STEPS,
  PendingPrivate,
  PrivateInfo,
  PrivateNotice,
  RESET_STEPS,
  SEND_STEPS,
  SETUP_STEPS,
  SUB_PIN_CHANGE,
  StepCb,
  WrongPin,
  changePinWithPin,
  claimRefund,
  createAndSetup,
  deposit,
  executePrivate,
  findAccounts,
  getTestCusdc,
  isPrivateAccount,
  isPrivateSub,
  loadActivity,
  loadPlan,
  loadPrivLocal,
  loadWatchtowerNotices,
  privateHistory,
  privateResetWithPin,
  privateSendKOnly,
  privateSendWithPin,
  privateViewWithPin,
  proveAliveWithPin,
  quoteFee,
  readAccount,
  readEthFee,
  readEscape,
  readGuardian,
  readPrivate,
  readRefund,
  refreshPending,
  sendWithPin,
  setDuressWithPin,
  setupStepCount,
  sweepPrivateToEscape,
} from "./account";
import { fheClient } from "./fhe";
import { PIN_NOTE, checkPin, randomPin } from "./pin";
import { BASE_BOND, isValidOwnerBaseBond, ownerBondFor, suggestOwnerBaseBond } from "../../sdk/src/bondFee";
import { credibilityAdvice, decoyCredibility, publicHistory, routePrivateSend, sentToday } from "../../sdk/src/privateMode";
import { explainError } from "./tx";
import { connectWallet, hasWallet, watchWallet } from "./wallet";
import {
  HeirRow,
  NewHeir,
  PHASE_TEXT,
  WillView,
  claimWill,
  createWill,
  decryptMyBalance,
  escapeWithdrawWill,
  formatCode,
  fundWill,
  heirCardUrl,
  parseCode,
  predictWill,
  readWill,
  runPayoutRound,
  setHeirsWithPin,
  settleWill,
  startWill,
  sweepWill,
  tokenBalanceHandle,
  willUrl,
} from "./will";
import qrcode from "qrcode-generator";
import { decodeApproval } from "../../sdk/src/lane";

// ───────────────────────────── shared state and helpers ─────────────────────────────

const read = new ethers.JsonRpcProvider(RPC_URL, Number(CHAIN_ID), { staticNetwork: ethers.Network.from(Number(CHAIN_ID)) });
/** Escape (backup) address for a new account; its key exists only in this page unless downloaded. */
const escapeWallet = ethers.Wallet.createRandom();
const accountKey = (owner: string) => `ea:account:${owner.toLowerCase()}`;
const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private window */
    }
  },
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
function fmtEth(wei: bigint, max = 6): string {
  const [i, d = ""] = ethers.formatEther(wei).split(".");
  let dec = d.slice(0, max).replace(/0+$/, "");
  if (dec.length < 2) dec = dec.padEnd(2, "0");
  return `${i}.${dec}`;
}
function fmtWait(s: number) {
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}
function timeAgo(ts?: number) {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const parseEth = (v: string): bigint | null => {
  try {
    const w = ethers.parseEther(v.trim() || "0");
    return w > 0n ? w : null;
  } catch {
    return null;
  }
};

/** Public RPCs drop requests now and then: retry reads a few times before giving up. */
async function retry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
}

function useNow(ms: number) {
  const [n, setN] = useState(Date.now());
  useEffect(() => {
    if (!ms) return;
    const id = setInterval(() => setN(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

type Notify = (text: string, kind?: "ok" | "err" | "info") => void;
type TaskState = { s: "pending" | "run" | "done" | "skip" | "fail" | "bad"; text?: string; hash?: string };
const freshTasks = (n: number): TaskState[] => Array.from({ length: n }, () => ({ s: "pending" }));

function copy(text: string, notify: Notify, what = "Address") {
  navigator.clipboard?.writeText(text).then(
    () => notify(`${what} copied`, "ok"),
    () => notify("Copy failed", "err"),
  );
}

// ───────────────────────────── icons ─────────────────────────────

const icon = (children: ComponentChildren) => () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const IconUp = icon(<path d="M7 17 17 7M8 7h9v9" />);
const IconDown = icon(<path d="M17 7 7 17M16 17H7V8" />);
const IconCopy = icon(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" />
  </>,
);
const IconExt = icon(<path d="M8 16 16 8M9.5 8H16v6.5" />);
const IconCheck = icon(<path d="m5 12.5 4.5 4.5L19 7.5" />);
const IconX = icon(<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />);
const IconBack = icon(
  <>
    <path d="M21 6H9.5L4 12l5.5 6H21z" />
    <path d="m13 9.8 4.4 4.4M17.4 9.8 13 14.2" />
  </>,
);
const IconLock = icon(
  <>
    <rect x="5" y="11" width="14" height="10" rx="2.5" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </>,
);
const IconShield = icon(<path d="M12 3.5 19 6v5.6c0 4.3-2.9 7.3-7 8.9-4.1-1.6-7-4.6-7-8.9V6z" />);
const IconClock = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </>,
);
const IconEye = icon(
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </>,
);
const IconInfo = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </>,
);
const IconFile = icon(<path d="M12 4v11M7 10l5 5 5-5M5 20h14" />);
const IconShuffle = icon(<path d="M16 4h4v4M4 20 20 4M20 16v4h-4M14 14l6 6M4 4l5 5" />);

function Mark({ s = 28 }: { s?: number }) {
  return (
    <span class="mark" style={{ "--s": `${s}px` }} aria-hidden="true">
      {[1, 0, 0, 0, 1, 0, 1, 0, 1].map((on) => (
        <i class={on ? "on" : ""} />
      ))}
    </span>
  );
}

function Avatar({ a }: { a: string }) {
  const h = parseInt(a.slice(2, 8), 16) % 360;
  return <span class="avatar" style={{ background: `conic-gradient(from 90deg, hsl(${h} 80% 62%), hsl(${(h + 110) % 360} 75% 55%), hsl(${(h + 220) % 360} 80% 60%), hsl(${h} 80% 62%))` }} />;
}

function AddrChip({ a, notify }: { a: string; notify: Notify }) {
  return (
    <span class="addr-chip">
      {short(a)}
      <button type="button" onClick={() => copy(a, notify)} aria-label="Copy address" title="Copy">
        <IconCopy />
      </button>
      <a href={addrUrl(a)} target="_blank" rel="noopener" aria-label="View on Etherscan" title="Etherscan">
        <IconExt />
      </a>
    </span>
  );
}

function TxLink({ hash, label = "tx" }: { hash: string; label?: string }) {
  return (
    <a class="ext" href={txUrl(hash)} target="_blank" rel="noopener">
      {label}
      <IconExt />
    </a>
  );
}

function Ring({ done, total }: { done: number; total: number }) {
  const r = 32;
  const c = 2 * Math.PI * r;
  return (
    <div class="ring">
      <svg viewBox="0 0 76 76">
        <circle class="track" cx="38" cy="38" r={r} fill="none" stroke-width="6" />
        <circle class="bar" cx="38" cy="38" r={r} fill="none" stroke-width="6" stroke-linecap="round" stroke-dasharray={c} stroke-dashoffset={c * (1 - done / total)} />
      </svg>
      <span class="lbl">
        {done}/{total}
      </span>
    </div>
  );
}

function Cipher({ n = 16 }: { n?: number }) {
  const [s, setS] = useState(hex(n));
  useEffect(() => {
    const id = setInterval(() => setS(hex(n)), 90);
    return () => clearInterval(id);
  }, [n]);
  return <span class="cipher">0x{s}</span>;
}

function Task({ label, t, extra }: { label: string; t: TaskState; extra?: ComponentChildren }) {
  return (
    <li class={`task ${t.s}`}>
      <span class="st">{t.s === "done" || t.s === "skip" ? <IconCheck /> : t.s === "fail" || t.s === "bad" ? <IconX /> : null}</span>
      <div>
        <div class="nm">{label}</div>
        {(t.text || extra) && (
          <div class="dt">
            {t.text}
            {extra && <> {extra}</>}
          </div>
        )}
      </div>
      <span class="tx">{t.hash && <TxLink hash={t.hash} />}</span>
    </li>
  );
}

function Sheet({ title, onClose, locked, children }: { title: string; onClose: () => void; locked?: boolean; children: ComponentChildren }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !locked) onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [locked, onClose]);
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);
  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && !locked && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div class="sheet-head">
          <h3>{title}</h3>
          <button type="button" class="close" onClick={onClose} disabled={locked} aria-label="Close">
            <IconX />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ───────────────────────────── PIN pad ─────────────────────────────

function PinPad(props: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: (v: string) => void;
  state?: "" | "bad" | "ok";
  tick?: number;
  reveal?: boolean;
  onToggleReveal?: () => void;
  active?: boolean;
  min?: number;
  max?: number;
}) {
  const { value, state = "", tick = 0, reveal = false, active = true, min = 6, max = 12 } = props;
  const latest = useRef(props);
  latest.current = props;
  // The value as of the last key press: fast typing fires several keydown events before the next render, so each press
  // builds on this ref, not on the (possibly stale) prop.
  const cur = useRef(value);
  cur.current = value;
  const set = (v: string) => {
    cur.current = v;
    latest.current.onChange(v);
  };
  const press = (d: string) => cur.current.length < (latest.current.max ?? 12) && set(cur.current + d);
  const del = () => set(cur.current.slice(0, -1));
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        del();
      } else if (e.key === "Enter" && latest.current.onEnter) {
        e.preventDefault();
        latest.current.onEnter(cur.current);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [active]);
  const n = Math.max(min, value.length);
  return (
    <div class="pinpad">
      <div key={tick} class={`pin-dots ${reveal ? "reveal" : ""} ${state} ${state === "bad" ? "shake" : ""}`} aria-live="polite" aria-label={`${value.length} digits entered`}>
        {Array.from({ length: n }, (_, i) => (
          <i class={i < value.length ? "on" : ""}>{reveal && i < value.length ? value[i] : ""}</i>
        ))}
      </div>
      <div class="keys">
        {"123456789".split("").map((d) => (
          <button type="button" class="key" onClick={() => press(d)} disabled={!active}>
            {d}
          </button>
        ))}
        {props.onToggleReveal ? (
          <button type="button" class="key flat" onClick={props.onToggleReveal} aria-label={reveal ? "Hide digits" : "Show digits"}>
            {reveal ? "Hide" : <IconEye />}
          </button>
        ) : (
          <span />
        )}
        <button type="button" class="key" onClick={() => press("0")} disabled={!active}>
          0
        </button>
        <button type="button" class="key flat" onClick={del} disabled={!active || !value.length} aria-label="Delete">
          <IconBack />
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────── F0.16: choosing a PIN, and what a PIN try costs ─────────────────────────────

/** PIN entry for a new PIN (setup, PIN change): the short note, warnings that never block, a large random suggestion. */
function PinChooser(p: { pin: string; setPin: (v: string) => void; reveal: boolean; setReveal: (v: boolean) => void; suggested: string | null; onEnter: () => void }) {
  const check = checkPin(p.pin);
  let msg = { t: "", k: "" };
  if (p.pin) {
    if (p.pin.length < 6) msg = { t: `${6 - p.pin.length} more digit${6 - p.pin.length === 1 ? "" : "s"}`, k: "" };
    else if (!check.ok) msg = { t: check.reason ?? "Choose another PIN", k: "bad" };
    else if (check.warnings.length) msg = { t: `${check.warnings.join(" · ")}. You can still use it.`, k: "warn" };
    else msg = { t: "Looks good", k: "ok" };
  }
  return (
    <div class="flow-body">
      {p.suggested && p.suggested === p.pin && (
        <div class="suggested-big" aria-live="polite">
          <span>Your random PIN · write it down now</span>
          <b class="mono">{p.suggested}</b>
          <span>Next you type it once more to confirm.</span>
        </div>
      )}
      <PinPad value={p.pin} onChange={p.setPin} onEnter={(v) => checkPin(v).ok && p.onEnter()} reveal={p.reveal} onToggleReveal={() => p.setReveal(!p.reveal)} />
      <p class={`pin-msg ${msg.k}`}>{msg.t || "Type on your keyboard or tap the keys"}</p>
      <p class="pin-note">
        <IconInfo />
        <span>{PIN_NOTE}</span>
      </p>
    </div>
  );
}

type TryInfo = { bond: OwnerBond | null; score: number };

/** The bond the next key-track PIN try needs, read when a PIN screen opens (bond null: an account without bonds). */
function useTryInfo(account: string): TryInfo | null {
  const [info, setInfo] = useState<TryInfo | null>(null);
  useEffect(() => {
    let live = true;
    retry(() => readAccount(read, account)).then(
      (v) => live && setInfo({ bond: v.bond, score: v.score }),
      () => live && setInfo({ bond: null, score: 0 }),
    );
    return () => {
      live = false;
    };
  }, [account]);
  return info;
}

/** Shown before the PIN pad: the refundable bond (from the wallet) and, for a transfer, the fee on top of the amount. */
function TryCost(p: { info: TryInfo | null; fee?: bigint | null; amount?: bigint; walletBal?: bigint | null }) {
  if (!p.info) return <div class="try-cost small faint">Reading the bond for this PIN try…</div>;
  const b = p.info.bond;
  const fee = p.fee ?? null;
  if (!b && !(fee !== null && fee > 0n)) return null;
  return (
    <div class="try-cost">
      {b && (
        <div class="try-row">
          <span>
            PIN-try bond<small>From your wallet. It comes back when the PIN is right; a wrong PIN leaves it in your account.</small>
          </span>
          <b>{fmtEth(b.required)} ETH</b>
        </div>
      )}
      {fee !== null && fee > 0n && (
        <div class="try-row">
          <span>
            Fee<small>From the account, on top: the recipient gets exactly {p.amount !== undefined ? fmtEth(p.amount) : "the amount"} ETH.</small>
          </span>
          <b>{fmtEth(fee)} ETH</b>
        </div>
      )}
      {b && b.base > BASE_BOND && (
        <p class="small faint" style={{ margin: "8px 0 0" }}>
          You raised your PIN-try bond to {fmtEth(b.base)} ETH: every PIN entry sends at least that much from your wallet, and it comes back when the PIN is right (claim it on the account page). PIN tries from a new device (recovery, freeze) need the same. A PIN approved on your phone (Second device) needs no bond.
        </p>
      )}
      {b && b.base <= BASE_BOND && p.info.score >= 1 && (
        <p class="small faint" style={{ margin: "8px 0 0" }}>
          The bond doubles with each wrong PIN still counted. A PIN approved on your phone (Second device) needs no bond.
        </p>
      )}
      {b && p.walletBal != null && p.walletBal < b.required && (
        <p class="field-err" style={{ margin: "8px 0 0" }}>
          Your wallet needs {fmtEth(b.required)} ETH for the bond, plus gas.
        </p>
      )}
    </div>
  );
}

const lowWallet = (info: TryInfo | null, walletBal: bigint | null | undefined) => !!info?.bond && walletBal != null && walletBal < info.bond.required;

// ───────────────────────────── top bar ─────────────────────────────

type Fhe = "loading" | "ready" | "error";

function TopBar(p: { fhe: Fhe; address: string | null; walletBal: bigint | null; showConnect: boolean; connecting: boolean; onConnect: () => void }) {
  return (
    <header class="app-top">
      <div class="app-top-inner">
        <a class="brand" href="/" aria-label="Encrypted Account, home">
          <Mark s={28} />
          <span class="brand-txt">Encrypted Account</span>
        </a>
        <span class="grow" />
        <span class="chip-fhe" title={p.fhe === "error" ? "The FHE engine failed to load; reload the page." : "Zama FHE engine in this page"}>
          {p.fhe === "loading" ? <span class="spin" /> : <span class={`dot ${p.fhe === "ready" ? "live" : "bad"}`} />}
          <span class="txt">{p.fhe === "loading" ? "Loading FHE" : p.fhe === "ready" ? "FHE ready" : "FHE failed"}</span>
        </span>
        <span class="pill net">Sepolia</span>
        {p.address ? (
          <span class="wallet-chip" title={p.address}>
            {p.walletBal !== null && <span class="bal">{fmtEth(p.walletBal, 4)} ETH</span>}
            <span class="addr row" style={{ gap: "7px" }}>
              <Avatar a={p.address} />
              {short(p.address)}
            </span>
          </span>
        ) : p.showConnect ? (
          <button type="button" class="btn btn-primary btn-sm" onClick={p.onConnect} disabled={p.connecting}>
            {p.connecting ? "Connecting…" : "Connect"}
          </button>
        ) : null}
      </div>
    </header>
  );
}

// ───────────────────────────── connect ─────────────────────────────

function ConnectView({ connecting, onConnect, notify }: { connecting: boolean; onConnect: () => void; notify: Notify }) {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const deep = `https://metamask.app.link/dapp/${location.host}${location.pathname}`;
  return (
    <section class="connect">
      <div class="connect-card">
        <div class="hero-mark">
          <Mark s={60} />
        </div>
        <h1>Your Encrypted Account</h1>
        <p class="lede">Connect a wallet on Sepolia. It becomes the account's key, and your PIN becomes a second factor that the contract itself enforces.</p>
        <div class="actions">
          {hasWallet() ? (
            <button type="button" class="btn btn-primary btn-lg" onClick={onConnect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          ) : mobile ? (
            <>
              <a class="btn btn-primary btn-lg" href={deep}>
                Open in MetaMask
              </a>
              <button type="button" class="btn btn-secondary" onClick={() => copy(location.href, notify, "Link")}>
                Copy link for another wallet
              </button>
              <p class="small faint">On a phone, open this page inside your wallet app's browser.</p>
            </>
          ) : (
            <>
              <a class="btn btn-primary btn-lg" href="https://metamask.io/download/" target="_blank" rel="noopener">
                Install a browser wallet
              </a>
              <p class="small faint">MetaMask, Rabby or any browser wallet works. Reload this page after installing.</p>
            </>
          )}
        </div>
        <ul class="facts">
          <li>
            <b>~2 minutes</b>to create your account
          </li>
          <li>
            <b>8 transactions</b>tiny Sepolia fees
          </li>
          <li>
            <b>Testnet only</b>no real funds involved
          </li>
        </ul>
        <details class="help">
          <summary>Need Sepolia ETH?</summary>
          <div class="help-body">
            Get free test ETH from a faucet, for example the{" "}
            <a href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia" target="_blank" rel="noopener">
              Google Cloud faucet
            </a>{" "}
            or the{" "}
            <a href="https://www.alchemy.com/faucets/ethereum-sepolia" target="_blank" rel="noopener">
              Alchemy faucet
            </a>
            . 0.01 ETH is plenty.
          </div>
        </details>
        <details class="help">
          <summary>What happens to my PIN?</summary>
          <div class="help-body">
            It never leaves this page. Your browser turns it into a fingerprint with Argon2id and encrypts it with Zama's SDK; only the ciphertext goes on-chain. When you send, the contract compares encrypted values and counts the attempt; only
            the yes-or-no result is ever decrypted.
          </div>
        </details>
      </div>
    </section>
  );
}

// ───────────────────────────── create ─────────────────────────────

const SETUP_LABELS = [
  "Deploy your account contract",
  "Store your encrypted PIN fingerprint",
  "Store your hidden limit",
  "Encrypt your address book (1/3)",
  "Encrypt your address book (2/3)",
  "Encrypt your address book (3/3)",
  "Encrypt your spender list",
  "Set your PIN-try bond",
  "Turn protection on",
];
const LIMIT_PRESETS = ["0.005", "0.01", "0.05", "0.1"];

function downloadEscapeKey() {
  const body = JSON.stringify(
    {
      note: "Escape (backup) address of an Encrypted Account demo on the Sepolia testnet. If an escape is started, the account's funds can only go to this address.",
      address: escapeWallet.address,
      privateKey: escapeWallet.privateKey,
    },
    null,
    2,
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  a.download = `escape-key-sepolia-${escapeWallet.address.slice(2, 8)}.json`;
  a.click();
}

function CreateFlow({
  ctx,
  fhe,
  walletBal,
  onDone,
  onCancel,
  privateDefault,
  notify,
}: {
  ctx: Ctx;
  fhe: Fhe;
  walletBal: bigint | null;
  onDone: (account: string) => void;
  onCancel?: () => void;
  privateDefault?: boolean;
  notify: Notify;
}) {
  const plan = useMemo(() => loadPlan(ctx.w.address), [ctx.w.address]);
  // private mode: off unless an unfinished private setup is resumed, or "Create a private-mode account" opened this flow
  const [pf, setPf] = useState<PrivForm>(() => ({
    on: !!FACTORY_P && (!!plan?.private || (!!privateDefault && !plan)),
    limit: plan?.private ? ethers.formatUnits(BigInt(plan.private.limitUnits), 6) : "100",
    known: plan?.private && plan.known ? plan.known : "",
    duress: false,
    dpin: "",
    dpin2: "",
    hidden: "1000",
  }));
  const setPfp = (q: Partial<PrivForm>) => setPf((f) => ({ ...f, ...q }));
  // two devices (recommended, not required): the PIN on the phone, the key here
  const [dev, setDev] = useState<{ two: boolean; addr: string }>(() => ({ two: true, addr: plan?.device ?? "" }));
  const [resume, setResume] = useState(false);
  useEffect(() => {
    if (plan) read.getCode(plan.account).then((c) => setResume(c !== "0x"), () => undefined);
  }, [plan]);

  const [step, setStep] = useState(0); // 0 PIN · 1 confirm · 2 limit · 3 review · 4 progress · 5 done
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [reveal, setReveal] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [padState, setPadState] = useState<"" | "bad" | "ok">("");
  const [tick, setTick] = useState(0);
  const [limit, setLimit] = useState(plan ? ethers.formatEther(BigInt(plan.limitUnits) * ETH_UNIT) : "0.01");
  const [bond, setBond] = useState(plan?.bondBase ? ethers.formatEther(BigInt(plan.bondBase)) : "0.001");
  const [size, setSize] = useState("1");
  const [feeRow, setFeeRow] = useState<{ bps: number; minFee: bigint; maxFee: bigint } | null>(null);
  useEffect(() => {
    readEthFee(read).then(setFeeRow, () => undefined);
  }, []);
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(setupStepCount(pf.on)));
  useEffect(() => {
    if (step < 4) setTasks(freshTasks(setupStepCount(pf.on)));
  }, [pf.on]);
  const labels = setupLabels(pf.on);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [t0, setT0] = useState(0);
  const [created, setCreated] = useState<string | null>(null);
  const now = useNow(running ? 1000 : 0);

  useEffect(() => {
    if (!running) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [running]);

  const check = checkPin(pin);

  // confirm: compare as soon as the length matches
  const [confirmMsg, setConfirmMsg] = useState({ t: "", k: "" });
  useEffect(() => {
    if (step !== 1 || pin2.length !== pin.length) return;
    if (pin2 === pin) {
      setPadState("ok");
      setConfirmMsg({ t: "PINs match", k: "ok" });
      const id = setTimeout(() => {
        setStep(2);
        setPadState("");
      }, 420);
      return () => clearTimeout(id);
    }
    setPadState("bad");
    setTick((t) => t + 1);
    setConfirmMsg({ t: "That doesn't match. Try again.", k: "bad" });
    const id = setTimeout(() => {
      setPin2("");
      setPadState("");
    }, 650);
    return () => clearTimeout(id);
  }, [pin2, step]);

  const limitWei = parseEth(limit);
  const limitOk = limitWei !== null && limitWei / ETH_UNIT >= 2n;
  // F0.16: the base bond of key-track PIN tries, with a suggestion from the expected account size
  const sizeWei = parseEth(size);
  const usingRandom = suggested !== null && suggested === pin;
  const bondSuggestion = sizeWei ? suggestOwnerBaseBond(sizeWei, { randomPin: usingRandom }) : BASE_BOND;
  const bondWei = parseEth(bond);
  const bondOk = bondWei !== null && isValidOwnerBaseBond(bondWei);
  const privErr = privFormError(pf, pin, ctx.w.address, escapeWallet.address);
  const devAddr = dev.addr.trim();
  const devErr = !dev.two
    ? null
    : !devAddr
      ? "Paste your phone's device address, or choose this device only."
      : !ethers.isAddress(devAddr)
        ? "That is not a device address."
        : [ctx.w.address, escapeWallet.address].some((x) => x.toLowerCase() === devAddr.toLowerCase())
          ? "Use the phone's own device address (not your wallet or the escape address)."
          : null;
  const txCount = (bondOk && bondWei! > BASE_BOND ? 9 : 8) + (pf.on ? 1 : 0) + (dev.two ? 1 : 0);

  async function run() {
    setStep(4);
    setRunErr(null);
    setRunning(true);
    if (!t0) setT0(Date.now());
    const cb: StepCb = (i, s, text, hash) =>
      setTasks((prev) =>
        prev.map((t, j) =>
          j !== i
            ? t
            : {
                s: s === "run" ? "run" : s === "done" ? "done" : s === "skip" ? "skip" : "fail",
                text: s === "skip" ? "Already done" : s === "done" ? undefined : text,
                hash: hash ?? t.hash,
              },
        ),
      );
    try {
      const priv = pf.on ? { limitUnits: parseUsd(pf.limit)!, duressPin: pf.duress ? pf.dpin : null, hiddenUnits: pf.duress ? parseUsd(pf.hidden) : null } : undefined;
      const known = pf.on && pf.known.trim() ? ethers.getAddress(pf.known.trim()) : null;
      const a = await createAndSetup(ctx, { pin, limitEth: limit, known, escapeWallet, bondBase: bondOk ? bondWei! : BASE_BOND, priv, device: dev.two ? ethers.getAddress(devAddr) : null }, cb);
      setCreated(a);
      setPfp({ dpin: "", dpin2: "" });
      setStep(5);
    } catch (e) {
      setRunErr(explainError(e));
    } finally {
      setRunning(false);
    }
  }

  const done = tasks.filter((t) => t.s === "done" || t.s === "skip").length;
  const current = tasks.findIndex((t) => t.s === "run");
  const bar = Math.min(step, 3);

  return (
    <section class="flow">
      <div class="flow-card">
        {step <= 3 && (
          <div class="stepper" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <i class={i <= bar ? "on" : ""} />
            ))}
          </div>
        )}

        {step === 0 && (
          <>
            <p class="flow-kicker">Step 1 of 4</p>
            <h2>Choose a PIN</h2>
            <p class="sub">6 digits or more. It never leaves this device: only an encrypted fingerprint goes on-chain.</p>
            {resume && (
              <div class="notice info" style={{ marginTop: "16px" }}>
                <IconInfo />
                <span>
                  <b>An unfinished setup was found.</b> Enter the same PIN to continue where it stopped.
                </span>
              </div>
            )}
            <PinChooser pin={pin} setPin={setPin} reveal={reveal} setReveal={setReveal} suggested={suggested} onEnter={() => setStep(1)} />
            <div class="flow-actions">
              <button
                type="button"
                class="btn btn-secondary"
                onClick={() => {
                  const p = randomPin(6);
                  setPin(p);
                  setSuggested(p);
                  setReveal(true);
                }}
              >
                <IconShuffle />
                Random PIN
              </button>
              <button type="button" class="btn btn-primary" disabled={!check.ok} onClick={() => setStep(1)}>
                Continue
              </button>
            </div>
            {onCancel && (
              <p class="center" style={{ marginTop: "16px" }}>
                <button type="button" class="link-btn" onClick={onCancel}>
                  Back to my account
                </button>
              </p>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <p class="flow-kicker">Step 2 of 4</p>
            <h2>Enter it again</h2>
            <p class="sub">Just to be sure. There is no way to recover a forgotten PIN in this demo.</p>
            <div class="flow-body">
              <PinPad value={pin2} onChange={setPin2} state={padState} tick={tick} max={pin.length} min={pin.length} />
              <p class={`pin-msg ${confirmMsg.k}`}>{confirmMsg.t || `${pin.length} digits`}</p>
            </div>
            <div class="flow-actions">
              <button
                type="button"
                class="btn btn-ghost"
                onClick={() => {
                  setPin2("");
                  setConfirmMsg({ t: "", k: "" });
                  setStep(0);
                }}
              >
                Back
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p class="flow-kicker">Step 3 of 4</p>
            <h2>Set a hidden daily limit</h2>
            <p class="sub">Stored encrypted. Nobody can read it from the chain, not even someone holding your key.</p>
            <div class="flow-body">
              <div class="amount-box">
                <div class="amount-line">
                  <input value={limit} inputMode="decimal" aria-label="Daily limit in ETH" onInput={(e) => setLimit((e.target as HTMLInputElement).value)} />
                  <span class="unit">ETH / day</span>
                </div>
                <div class="chips">
                  {LIMIT_PRESETS.map((v) => (
                    <button type="button" class={`chip-btn ${limit === v ? "on" : ""}`} onClick={() => setLimit(v)}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              {!limitOk && <p class="field-err" style={{ marginTop: "8px" }}>Enter an amount in ETH, at least 0.000002.</p>}
              <ul class="feature-list">
                <li>
                  <span class="ico">
                    <IconLock />
                  </span>
                  <span>
                    <b>A random tripwire</b> is drawn on-chain somewhere inside this limit. Nobody knows where, not even you.
                  </span>
                </li>
                <li>
                  <span class="ico">
                    <IconShield />
                  </span>
                  <span>
                    <b>New addresses always need your PIN</b>, whatever the amount. Above 10× the limit, a longer waiting period applies.
                  </span>
                </li>
              </ul>
              <div class="escape-box">
                <div class="row between" style={{ alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "14px" }}>Escape address</div>
                    <div class="small faint" style={{ marginTop: "2px" }}>
                      If your key leaks, an escape sends everything here. Generated for this demo.
                    </div>
                  </div>
                  <button type="button" class="btn btn-secondary btn-sm" onClick={downloadEscapeKey} title="Download its key (testnet only)">
                    <IconFile />
                    Key
                  </button>
                </div>
                <div class="mono" style={{ marginTop: "10px" }}>
                  {escapeWallet.address}
                </div>
              </div>
              <div class="bond-box">
                <div style={{ fontWeight: 600, fontSize: "14px" }}>PIN-try bond</div>
                <div class="small faint" style={{ marginTop: "2px" }}>
                  A thief holding your key locks this much for every PIN try and loses it on a wrong one; PIN tries from a new device (recovery, freeze) cost the same. Your own PIN entries send it too, and get it back when the PIN is right.
                </div>
                <div class="row wrap" style={{ gap: "10px", marginTop: "12px", alignItems: "flex-end" }}>
                  <label class="field" style={{ flex: "1 1 150px" }}>
                    <span>The account will hold about</span>
                    <div class="input-wrap">
                      <input class="input" inputMode="decimal" value={size} aria-label="Expected account size in ETH" onInput={(e) => setSize((e.target as HTMLInputElement).value)} style={{ paddingRight: "52px" }} />
                      <div class="suffix">
                        <span class="small faint">ETH</span>
                      </div>
                    </div>
                  </label>
                  <label class="field" style={{ flex: "1 1 150px" }}>
                    <span>Bond per PIN try</span>
                    <div class="input-wrap">
                      <input class="input" inputMode="decimal" value={bond} aria-label="PIN-try bond in ETH" onInput={(e) => setBond((e.target as HTMLInputElement).value)} style={{ paddingRight: "52px" }} />
                      <div class="suffix">
                        <span class="small faint">ETH</span>
                      </div>
                    </div>
                  </label>
                </div>
                <div class="row between small" style={{ marginTop: "8px", gap: "10px" }}>
                  <span class="faint">
                    Suggested{usingRandom ? " for a random PIN" : ""}: <b>{fmtEth(bondSuggestion)} ETH</b>
                  </span>
                  <button type="button" class="link-btn" onClick={() => setBond(ethers.formatEther(bondSuggestion))}>
                    Use it
                  </button>
                </div>
                {!bondOk && (
                  <p class="field-err" style={{ marginTop: "6px" }}>
                    Between 0.001 and 100 ETH, in steps of 0.001.
                  </p>
                )}
              </div>
              <PrivateSetupBox f={pf} set={setPfp} err={privErr} resume={resume} />
              <DeviceSetupBox dev={dev} set={setDev} err={devErr} notify={notify} />
            </div>
            <div class="flow-actions">
              <button type="button" class="btn btn-ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <button type="button" class="btn btn-primary" disabled={!limitOk || !bondOk || privErr !== null || devErr !== null} onClick={() => setStep(3)}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <p class="flow-kicker">Step 4 of 4</p>
            <h2>Review and create</h2>
            <p class="sub">Everything below is enforced by the contract once the account is on.</p>
            <div class="flow-body">
              <div class="review">
                <div class="review-row">
                  <span class="check">
                    <IconCheck />
                  </span>
                  <span class="k">PIN</span>
                  <span class="v">
                    {pin.length} digits<small>never leaves this device</small>
                  </span>
                </div>
                <div class="review-row">
                  <span class="check">
                    <IconCheck />
                  </span>
                  <span class="k">Hidden daily limit</span>
                  <span class="v">
                    {limit} ETH<small>encrypted on-chain</small>
                  </span>
                </div>
                <div class="review-row">
                  <span class="check">
                    <IconCheck />
                  </span>
                  <span class="k">Tripwire</span>
                  <span class="v">
                    random<small>unknown to everyone</small>
                  </span>
                </div>
                <div class="review-row">
                  <span class="check">
                    <IconCheck />
                  </span>
                  <span class="k">Escape address</span>
                  <span class="v mono">{short(escapeWallet.address)}</span>
                </div>
                <div class="review-row">
                  <span class="check">
                    <IconCheck />
                  </span>
                  <span class="k">PIN-try bond</span>
                  <span class="v">
                    {bondOk ? fmtEth(bondWei!) : "0.001"} ETH<small>sent with each PIN try, doubling after wrong ones; back to you when the PIN is right</small>
                  </span>
                </div>
                {pf.on && <PrivateReviewRows f={pf} />}
                <div class="review-row">
                  <span class="check">
                    <IconCheck />
                  </span>
                  <span class="k">Second device</span>
                  <span class="v">
                    {dev.two ? `Phone ${short(devAddr)}` : "This device only"}
                    <small>{dev.two ? "your PIN is typed on the phone; this computer never sees it" : "you can pair a phone later on the account page"}</small>
                  </span>
                </div>
                {feeRow && feeRow.bps > 0 && (
                  <div class="review-row">
                    <span class="check">
                      <IconCheck />
                    </span>
                    <span class="k">Protocol fee</span>
                    <span class="v">
                      {feeRow.bps / 100}% of PIN-verified sends
                      <small>
                        min {fmtEth(feeRow.minFee)}, max {fmtEth(feeRow.maxFee)} ETH, on top of the amount; key-only sends are free
                      </small>
                    </span>
                  </div>
                )}
              </div>
              <div class="notice" style={{ marginTop: "14px" }}>
                <IconInfo />
                <span>
                  Your wallet will ask you to confirm <b>{txCount} transactions</b>. Keep this tab open; if anything stops, you can continue where it left off.
                </span>
              </div>
              {walletBal === 0n && (
                <div class="notice warn" style={{ marginTop: "10px" }}>
                  <IconInfo />
                  <span>
                    Your wallet has no Sepolia ETH for gas yet. Get some free from the{" "}
                    <a href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia" target="_blank" rel="noopener" style={{ color: "var(--accent)" }}>
                      Google Cloud faucet
                    </a>
                    .
                  </span>
                </div>
              )}
              {fhe === "error" && (
                <div class="notice err" style={{ marginTop: "10px" }}>
                  <IconInfo />
                  <span>The FHE engine failed to load. Reload the page and try again.</span>
                </div>
              )}
            </div>
            <div class="flow-actions">
              <button type="button" class="btn btn-ghost" onClick={() => setStep(2)}>
                Back
              </button>
              <button type="button" class="btn btn-primary btn-lg" disabled={fhe === "error"} onClick={run}>
                Create account
              </button>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div class="progress-head">
              <Ring done={done} total={tasks.length} />
              <div>
                <div class="progress-title">{runErr ? "Setup paused" : "Creating your account"}</div>
                <div class="progress-sub">{runErr ? "Nothing is lost: continue from this step." : current >= 0 ? labels[current] : "Preparing…"}</div>
                <div class="timer">{mmss(now - t0)}</div>
              </div>
            </div>
            <ul class="tasks">
              {tasks.map((t, i) => (
                <Task label={labels[i]} t={t} extra={t.s === "run" && /Encrypt/.test(t.text ?? "") ? <Cipher n={10} /> : undefined} />
              ))}
            </ul>
            {runErr && (
              <>
                <div class="notice err" style={{ marginTop: "14px" }}>
                  <IconInfo />
                  <span>{runErr}</span>
                </div>
                <div class="flow-actions">
                  <button type="button" class="btn btn-primary" onClick={run}>
                    Continue setup
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {step === 5 && created && (
          <div class="result">
            <div class="result-icon ok">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="m5 12.5 4.5 4.5L19 7.5" />
              </svg>
            </div>
            <h3>Your account is ready</h3>
            <p>
              {pf.on
                ? "Protection and private mode are on. Get test cUSDC on the account page, then view it with your PIN or send it privately."
                : "Protection is on: PIN, hidden limit, encrypted address book and escape address. Deposit some Sepolia ETH and try sending with your PIN."}
            </p>
            <div class="facts-row">
              <span class="badge ok">
                <IconShield />
                Protected
              </span>
              <span class="badge mono">{short(created)}</span>
              <span class="badge">{mmss(Date.now() - t0)} total</span>
            </div>
            <div class="flow-actions">
              <button
                type="button"
                class="btn btn-primary btn-lg"
                onClick={() => {
                  setPin("");
                  setPin2("");
                  onDone(created);
                }}
              >
                Open my account
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ───────────────────────────── send ─────────────────────────────

const SEND_LABELS = ["Open the transfer on-chain", "Encrypt your PIN guess", "Submit the encrypted guess", "Decrypt only the yes / no result", "Record the result on-chain", "Send the ETH"];
type SendResult = { kind: "ok"; hash: string } | { kind: "wrong"; score: number; next: number } | { kind: "err"; text: string };

function SendSheet({ ctx, account, view, walletBal, onClose, onSettled }: { ctx: Ctx; account: string; view: AccountView; walletBal: bigint | null; onClose: () => void; onSettled: () => void }) {
  const [stage, setStage] = useState<"details" | "pin" | "run" | "result">("details");
  const [fee, setFee] = useState<bigint | null>(null);
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("0.0001");
  const [pin, setPin] = useState("");
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(SEND_STEPS.length));
  const [result, setResult] = useState<SendResult | null>(null);
  const [t0, setT0] = useState(0);
  const [verified, setVerified] = useState(false);
  const offer = useRefundOffer(ctx, account, verified, view.bond !== null, onSettled);
  const running = stage === "run";
  const now = useNow(1000);
  // two devices: with a phone registered, the PIN can be typed there instead (the lane: no bond)
  const [device, setDevice] = useState<string | null>(null);
  const [viaPhone, setViaPhone] = useState(false);
  const [laneOp, setLaneOp] = useState<bigint | null>(null);
  const laneResolver = useRef<((c: string) => void) | null>(null);
  useEffect(() => {
    readCosigners(read, account).then((c) => setDevice(c.device), () => undefined);
  }, [account]);
  const hasPhone = !!device && device !== ethers.ZeroAddress;

  useEffect(() => {
    if (!running) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [running]);

  // F0.16: the fee a PIN-verified transfer of this amount would pay (bound to the transfer when it opens)
  useEffect(() => {
    let live = true;
    setFee(null);
    const w = parseEth(amt);
    if (!w) return;
    const id = setTimeout(() => quoteFee(read, account, ethers.ZeroAddress, w).then((f) => live && setFee(f), () => undefined), 300);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [amt, account]);

  const toTrim = to.trim();
  const toOk = ethers.isAddress(toTrim) && toTrim.toLowerCase() !== account.toLowerCase();
  const wei = parseEth(amt);
  const enough = wei !== null && view.balance >= wei + (fee ?? 0n);
  const tryInfo: TryInfo = { bond: view.bond, score: view.score };
  const nowS = Math.floor(now / 1000);
  const waitUntil = result?.kind === "wrong" ? result.next : view.nextAllowedAt;
  const locked = waitUntil > nowS;

  async function goPhone() {
    if (!wei || !toOk) return;
    setViaPhone(true);
    setStage("run");
    setT0(Date.now());
    setResult(null);
    setTasks(freshTasks(PHONE_SEND_STEPS.length));
    const cb = taskCb(setTasks, 5);
    try {
      const getCode = (opId: bigint) =>
        new Promise<string>((res) => {
          laneResolver.current = res;
          setLaneOp(opId);
        });
      const h = await sendWithPhone(ctx, account, ethers.getAddress(toTrim), wei, getCode, cb);
      setResult({ kind: "ok", hash: h });
    } catch (e) {
      if (e instanceof WrongPin) setResult({ kind: "wrong", score: e.score, next: e.nextAllowedAt });
      else setResult({ kind: "err", text: explainError(e) });
    } finally {
      setLaneOp(null);
      laneResolver.current = null;
      setStage("result");
      onSettled();
    }
  }

  async function go(p = pin) {
    if (p.length < 6 || !wei || !toOk) return;
    setViaPhone(false);
    setStage("run");
    setT0(Date.now());
    setResult(null);
    setVerified(false);
    setTasks(freshTasks(SEND_STEPS.length));
    const cb = taskCb(setTasks, 5, () => setVerified(true));
    try {
      const h = await sendWithPin(ctx, account, ethers.getAddress(toTrim), wei, p, cb, view.bond?.required);
      setResult({ kind: "ok", hash: h });
    } catch (e) {
      if (e instanceof WrongPin) setResult({ kind: "wrong", score: e.score, next: e.nextAllowedAt });
      else setResult({ kind: "err", text: explainError(e) });
    } finally {
      setPin("");
      setStage("result");
      onSettled();
    }
  }

  const done = tasks.filter((t) => t.s === "done" || t.s === "bad").length;
  const current = tasks.findIndex((t) => t.s === "run");

  return (
    <Sheet title={stage === "result" ? "Result" : "Send with your PIN"} onClose={onClose} locked={running}>
      {stage === "details" && (
        <div class="stack">
          <label class="field">
            <span>Recipient</span>
            <input class="input mono" placeholder="0x…" value={to} spellcheck={false} autoComplete="off" onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
            {toTrim && !toOk && <span class="field-err">Enter a valid address (not the account itself).</span>}
          </label>
          <div class="chips">
            <button type="button" class="chip-btn" onClick={() => setTo(ctx.w.address)}>
              My wallet · {short(ctx.w.address)}
            </button>
          </div>
          <label class="field">
            <span>Amount</span>
            <div class="input-wrap">
              <input class="input" inputMode="decimal" value={amt} onInput={(e) => setAmt((e.target as HTMLInputElement).value)} style={{ paddingRight: "112px" }} />
              <div class="suffix">
                <span class="small faint">ETH</span>
                <button type="button" class="chip-btn" onClick={() => setAmt(ethers.formatEther(view.balance))}>
                  Max
                </button>
              </div>
            </div>
            <span class="field-hint">
              Available: {fmtEth(view.balance)} ETH{fee !== null && fee > 0n ? ` · fee on top: ${fmtEth(fee)} ETH` : ""}
            </span>
            {wei !== null && !enough && <span class="field-err">The account holds less than the amount{fee ? " plus the fee" : ""}. Deposit first.</span>}
          </label>
          <div class="notice info">
            <IconLock />
            <span>
              Sending to an address the account doesn't know <b>always needs your PIN</b>, checked on-chain under FHE.
            </span>
          </div>
          {locked && (
            <div class="notice warn">
              <IconClock />
              <span>After several wrong PINs, the next attempt is possible in {fmtWait(waitUntil - nowS)}.</span>
            </div>
          )}
          {hasPhone ? (
            <div class="stack">
              <button type="button" class="btn btn-primary btn-lg btn-block" disabled={!toOk || !wei || !enough} onClick={() => void goPhone()}>
                Approve on my phone
              </button>
              <button type="button" class="btn btn-secondary btn-block" disabled={!toOk || !wei || !enough || locked} onClick={() => setStage("pin")}>
                Enter the PIN here instead
              </button>
              <p class="small faint" style={{ margin: 0 }}>
                On the phone your PIN never reaches this computer, and the phone's approval needs no bond (its own wrong-PIN count, outside the key&apos;s).
              </p>
            </div>
          ) : (
            <button type="button" class="btn btn-primary btn-lg btn-block" disabled={!toOk || !wei || !enough || locked} onClick={() => setStage("pin")}>
              Continue
            </button>
          )}
        </div>
      )}

      {stage === "pin" && wei && (
        <div>
          <div class="sum">
            <b>{fmtEth(wei)} ETH</b>
            <span class="faint">→</span>
            <span class="mono">{short(toTrim)}</span>
          </div>
          <TryCost info={tryInfo} fee={fee} amount={wei} walletBal={walletBal} />
          <p class="center muted" style={{ margin: "18px 0 6px", fontSize: "15px" }}>
            Enter your PIN
          </p>
          <PinPad value={pin} onChange={setPin} onEnter={(v) => !lowWallet(tryInfo, walletBal) && void go(v)} />
          <p class="keys-hint center">Wrong PINs are counted on-chain and send nothing out; the bond stays in your account.</p>
          <div class="flow-actions">
            <button type="button" class="btn btn-ghost" onClick={() => setStage("details")}>
              Back
            </button>
            <button type="button" class="btn btn-primary" disabled={pin.length < 6 || lowWallet(tryInfo, walletBal)} onClick={() => void go()}>
              Send with PIN
            </button>
          </div>
        </div>
      )}

      {stage === "run" && (
        <div>
          <div class="progress-head">
            <Ring done={done} total={SEND_STEPS.length} />
            <div>
              <div class="progress-title">{viaPhone ? "Approving on your phone" : "Checking your PIN"}</div>
              <div class="progress-sub">{current >= 0 ? (viaPhone ? PHONE_SEND_STEPS : SEND_LABELS)[current] : "Preparing…"}</div>
              <div class="timer">{mmss(now - t0)}</div>
            </div>
          </div>
          <ul class="tasks">
            {tasks.map((t, i) => (
              <Task label={(viaPhone ? PHONE_SEND_STEPS : SEND_LABELS)[i]} t={t} extra={t.s === "run" && (i === 1 || i === 3) && !viaPhone ? <Cipher n={12} /> : undefined} />
            ))}
          </ul>
          {viaPhone && laneOp !== null && (
            <LanePanel
              account={account}
              opId={laneOp}
              notify={() => undefined}
              onCode={(c) => {
                laneResolver.current?.(c);
                laneResolver.current = null;
                setLaneOp(null);
              }}
            />
          )}
          <div class="notice" style={{ marginTop: "14px" }}>
            <IconInfo />
            <span>Up to 4 wallet confirmations. The yes / no decryption takes about half a minute.</span>
          </div>
          <RefundNotice offer={offer} />
        </div>
      )}

      {stage === "result" && result && (
        <div class="result">
          {result.kind === "ok" ? (
            <>
              <div class="result-icon ok">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              </div>
              <h3>Sent</h3>
              <p>
                {wei ? fmtEth(wei) : ""} ETH went to {short(toTrim)}. Your PIN was checked under FHE; only "yes" was ever decrypted.
              </p>
              <div class="facts-row">
                <TxLink hash={result.hash} label="View transaction" />
                <span class="badge">{mmss(now - t0)}</span>
              </div>
              <RefundNotice offer={offer} />
              <div class="flow-actions">
                <button type="button" class="btn btn-primary btn-lg" onClick={onClose}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <div class="result-icon bad">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
                </svg>
              </div>
              {result.kind === "wrong" ? (
                <>
                  <h3>Wrong PIN. Nothing moved.</h3>
                  <p>
                    The attempt was counted on-chain before its result was decrypted. Wrong guesses so far: {result.score}.
                    {view.bond ? ` The bond stayed in your account; the next try needs ${fmtEth(ownerBondFor(result.score, view.bond.base))} ETH.` : ""}
                  </p>
                  <div class="facts-row">
                    <span class={`badge ${locked ? "warn" : ""}`}>
                      <IconClock />
                      {locked ? `Next try in ${fmtWait(result.next - nowS)}` : "Next try: now"}
                    </span>
                    <span class="badge ok">
                      <IconShield />
                      Funds untouched
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <h3>That didn't go through</h3>
                  <p>{result.text}</p>
                </>
              )}
              <div class="flow-actions">
                <button type="button" class="btn btn-secondary" onClick={onClose}>
                  Close
                </button>
                <button type="button" class="btn btn-primary" disabled={locked} onClick={() => setStage("pin")}>
                  Try again
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ───────────────────────────── change the PIN ─────────────────────────────

const PIN_CHANGE_LABELS = ["Open the PIN change on-chain", "Encrypt your current PIN guess", "Submit the guess with its bond", "Decrypt only the yes / no result", "Record the result on-chain", "Wait the delay, then switch PINs"];

/** PIN change: the new PIN (note, warnings, random suggestion), typed twice, then verified with the current PIN. */
function ChangePinSheet({ ctx, account, walletBal, onClose, onSettled }: { ctx: Ctx; account: string; walletBal: bigint | null; onClose: () => void; onSettled: () => void }) {
  const [stage, setStage] = useState<"new" | "confirm" | "current" | "run" | "result">("new");
  const [pinNew, setPinNew] = useState("");
  const [pinNew2, setPinNew2] = useState("");
  const [pinCur, setPinCur] = useState("");
  const [reveal, setReveal] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [padState, setPadState] = useState<"" | "bad" | "ok">("");
  const [tick, setTick] = useState(0);
  const [confirmMsg, setConfirmMsg] = useState({ t: "", k: "" });
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(PIN_CHANGE_STEPS.length));
  const [result, setResult] = useState<SendResult | null>(null);
  const [t0, setT0] = useState(0);
  const info = useTryInfo(account);
  const [verified, setVerified] = useState(false);
  const offer = useRefundOffer(ctx, account, verified, !!info?.bond, onSettled);
  const now = useNow(1000);
  const running = stage === "run";

  useEffect(() => {
    if (!running) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [running]);

  useEffect(() => {
    if (stage !== "confirm" || pinNew2.length !== pinNew.length) return;
    if (pinNew2 === pinNew) {
      setPadState("ok");
      setConfirmMsg({ t: "PINs match", k: "ok" });
      const id = setTimeout(() => {
        setStage("current");
        setPadState("");
      }, 420);
      return () => clearTimeout(id);
    }
    setPadState("bad");
    setTick((t) => t + 1);
    setConfirmMsg({ t: "That doesn't match. Try again.", k: "bad" });
    const id = setTimeout(() => {
      setPinNew2("");
      setPadState("");
    }, 650);
    return () => clearTimeout(id);
  }, [pinNew2, stage]);

  const same = pinCur.length >= 6 && pinCur === pinNew;
  const blocked = pinCur.length < 6 || same || lowWallet(info, walletBal) || !info;

  async function go(p = pinCur) {
    if (p.length < 6 || p === pinNew || lowWallet(info, walletBal)) return;
    setStage("run");
    setT0(Date.now());
    setResult(null);
    setVerified(false);
    setTasks(freshTasks(PIN_CHANGE_STEPS.length));
    try {
      setResult({ kind: "ok", hash: await changePinWithPin(ctx, account, p, pinNew, taskCb(setTasks, 5, () => setVerified(true)), info?.bond?.required) });
    } catch (e) {
      if (e instanceof WrongPin) setResult({ kind: "wrong", score: e.score, next: e.nextAllowedAt });
      else setResult({ kind: "err", text: explainError(e) });
    } finally {
      setPinCur("");
      setStage("result");
      onSettled();
    }
  }

  const done = tasks.filter((t) => t.s === "done" || t.s === "bad").length;
  const current = tasks.findIndex((t) => t.s === "run");
  return (
    <Sheet title={stage === "result" ? "Result" : "Change your PIN"} onClose={onClose} locked={running}>
      {stage === "new" && (
        <div>
          <p class="flow-kicker">Step 1 of 3</p>
          <p class="center muted" style={{ margin: "0 0 10px", fontSize: "15px" }}>
            Choose a new PIN
          </p>
          <PinChooser pin={pinNew} setPin={setPinNew} reveal={reveal} setReveal={setReveal} suggested={suggested} onEnter={() => setStage("confirm")} />
          <div class="flow-actions">
            <button
              type="button"
              class="btn btn-secondary"
              onClick={() => {
                const p = randomPin(6);
                setPinNew(p);
                setSuggested(p);
                setReveal(true);
              }}
            >
              <IconShuffle />
              Random PIN
            </button>
            <button type="button" class="btn btn-primary" disabled={!checkPin(pinNew).ok} onClick={() => setStage("confirm")}>
              Continue
            </button>
          </div>
        </div>
      )}

      {stage === "confirm" && (
        <div>
          <p class="flow-kicker">Step 2 of 3</p>
          <p class="center muted" style={{ margin: "0 0 10px", fontSize: "15px" }}>
            Enter the new PIN again
          </p>
          <PinPad value={pinNew2} onChange={setPinNew2} state={padState} tick={tick} max={pinNew.length} min={pinNew.length} />
          <p class={`pin-msg ${confirmMsg.k}`}>{confirmMsg.t || `${pinNew.length} digits`}</p>
          <div class="flow-actions">
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => {
                setPinNew2("");
                setConfirmMsg({ t: "", k: "" });
                setStage("new");
              }}
            >
              Back
            </button>
          </div>
        </div>
      )}

      {stage === "current" && (
        <div>
          <p class="flow-kicker">Step 3 of 3</p>
          <TryCost info={info} walletBal={walletBal} />
          <p class="center muted" style={{ margin: "18px 0 6px", fontSize: "15px" }}>
            Now your current PIN
          </p>
          <PinPad value={pinCur} onChange={setPinCur} onEnter={(v) => !blocked && void go(v)} />
          <p class={`pin-msg ${same ? "bad" : ""}`}>{same ? "That is the new PIN; enter the current one." : "The current PIN keeps working until the change runs."}</p>
          <div class="flow-actions">
            <button
              type="button"
              class="btn btn-ghost"
              onClick={() => {
                setPinCur("");
                setPinNew2("");
                setConfirmMsg({ t: "", k: "" });
                setStage("new");
              }}
            >
              Back
            </button>
            <button type="button" class="btn btn-primary" disabled={blocked} onClick={() => void go()}>
              Change PIN
            </button>
          </div>
        </div>
      )}

      {stage === "run" && (
        <div>
          <div class="progress-head">
            <Ring done={done} total={PIN_CHANGE_STEPS.length} />
            <div>
              <div class="progress-title">Changing your PIN</div>
              <div class="progress-sub">{current >= 0 ? PIN_CHANGE_LABELS[current] : "Preparing…"}</div>
              <div class="timer">{mmss(now - t0)}</div>
            </div>
          </div>
          <ul class="tasks">
            {tasks.map((t, i) => (
              <Task label={PIN_CHANGE_LABELS[i]} t={t} extra={t.s === "run" && (i === 0 || i === 1 || i === 3) ? <Cipher n={12} /> : undefined} />
            ))}
          </ul>
          <RefundNotice offer={offer} />
        </div>
      )}

      {stage === "result" && result && (
        <div class="result">
          {result.kind === "ok" ? <OkIcon /> : <BadIcon />}
          <h3>{result.kind === "ok" ? "PIN changed" : result.kind === "wrong" ? "Wrong PIN. Nothing changed." : "That didn't go through"}</h3>
          <p>
            {result.kind === "ok"
              ? "From now on only the new PIN works. The wrong-guess count stays as it was."
              : result.kind === "wrong"
                ? `Your PIN is unchanged. Wrong guesses so far: ${result.score}.`
                : result.text}
          </p>
          {result.kind === "ok" && (
            <div class="facts-row">
              <TxLink hash={result.hash} label="View transaction" />
            </div>
          )}
          {result.kind === "ok" && <RefundNotice offer={offer} />}
          <div class="flow-actions">
            <button type="button" class="btn btn-primary btn-lg" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ───────────────────────────── deposit ─────────────────────────────

function DepositSheet({ ctx, account, walletBal, onClose, onSettled }: { ctx: Ctx; account: string; walletBal: bigint | null; onClose: () => void; onSettled: () => void }) {
  const [amt, setAmt] = useState("0.001");
  const [state, setState] = useState<"idle" | "run" | "done" | "err">("idle");
  const [status, setStatus] = useState("");
  const [hash, setHash] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const wei = parseEth(amt);
  const enough = wei !== null && (walletBal === null || walletBal > wei);

  async function go() {
    if (!wei) return;
    setState("run");
    setErr("");
    try {
      const h = await deposit(ctx, account, wei, (t, hh) => {
        setStatus(t);
        if (hh) setHash(hh);
      });
      setHash(h);
      setState("done");
    } catch (e) {
      setErr(explainError(e));
      setState("err");
    } finally {
      onSettled();
    }
  }

  return (
    <Sheet title="Deposit" onClose={onClose} locked={state === "run"}>
      {state === "done" && hash ? (
        <div class="result">
          <div class="result-icon ok">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
          </div>
          <h3>Deposited</h3>
          <p>{wei ? fmtEth(wei) : ""} ETH is in your Encrypted Account. Now send some with your PIN, or try a wrong one.</p>
          <div class="facts-row">
            <TxLink hash={hash} label="View transaction" />
          </div>
          <div class="flow-actions">
            <button type="button" class="btn btn-primary btn-lg" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div class="stack">
          <div class="amount-box">
            <div class="amount-line">
              <input value={amt} inputMode="decimal" aria-label="Amount in ETH" onInput={(e) => setAmt((e.target as HTMLInputElement).value)} disabled={state === "run"} />
              <span class="unit">ETH</span>
            </div>
            <div class="chips">
              {["0.001", "0.005", "0.01"].map((v) => (
                <button type="button" class={`chip-btn ${amt === v ? "on" : ""}`} onClick={() => setAmt(v)} disabled={state === "run"}>
                  {v}
                </button>
              ))}
            </div>
          </div>
          <p class="field-hint">From your wallet{walletBal !== null ? ` · ${fmtEth(walletBal, 4)} ETH available` : ""}. Deposits need no PIN.</p>
          {wei !== null && !enough && <p class="field-err">Your wallet doesn't hold that much (gas included).</p>}
          {state === "run" && (
            <div class="notice">
              <span class="spinner" style={{ width: "16px", height: "16px", borderWidth: "2px", flex: "none" }} />
              <span>
                {status || "Preparing…"} {hash && <TxLink hash={hash} />}
              </span>
            </div>
          )}
          {state === "err" && (
            <div class="notice err">
              <IconInfo />
              <span>{err}</span>
            </div>
          )}
          <button type="button" class="btn btn-primary btn-lg btn-block" disabled={!wei || !enough || state === "run"} onClick={go}>
            {state === "run" ? "Depositing…" : "Deposit"}
          </button>
        </div>
      )}
    </Sheet>
  );
}

// ───────────────────────────── dashboard ─────────────────────────────

function ActivityList({ items, priv }: { items: Activity[] | null; priv?: boolean }) {
  if (items === null)
    return (
      <div class="empty">
        <span class="spinner" style={{ margin: "0 auto" }} />
      </div>
    );
  if (!items.length)
    return (
      <div class="empty">
        <b>No activity yet</b>Deposit some Sepolia ETH, then send it with your PIN.
      </div>
    );
  const meta: Record<Activity["kind"], { ico: () => any; cls: string; title: (a: Activity) => string; sub: (a: Activity) => string }> = {
    sent: { ico: IconUp, cls: "ok", title: (a) => `Sent ${fmtEth(a.amount!)} ETH`, sub: (a) => `to ${short(a.to!)} · PIN correct` },
    wrong: { ico: IconX, cls: "bad", title: () => "Wrong PIN · nothing sent", sub: (a) => `${fmtEth(a.amount!)} ETH to ${short(a.to!)} was blocked` },
    pending: { ico: IconClock, cls: "warn", title: () => "PIN check not finished", sub: (a) => `${fmtEth(a.amount!)} ETH to ${short(a.to!)}` },
    approved: { ico: IconCheck, cls: "ok", title: () => "PIN correct · waiting to send", sub: (a) => `${fmtEth(a.amount!)} ETH to ${short(a.to!)}` },
    cancelled: { ico: IconX, cls: "", title: () => "Transfer cancelled", sub: (a) => `${fmtEth(a.amount!)} ETH to ${short(a.to!)}` },
    armed: { ico: IconShield, cls: "ok", title: () => "Protection turned on", sub: () => "PIN, hidden limit and address book are active" },
    "private-k": { ico: IconUp, cls: "", title: () => "Private send with your key", sub: (a) => `to ${short(a.to!)} · amount and outcome hidden` },
  };
  return (
    <ul class="activity">
      {items.map((a) => {
        const m = (priv && privateActivityMeta(a)) || meta[a.kind];
        const Ico = m.ico;
        return (
          <li class="act">
            <span class={`act-ico ${m.cls}`}>
              <Ico />
            </span>
            <div class="act-main">
              <div class="act-title">{m.title(a)}</div>
              <div class="act-sub">
                {m.sub(a)}
                {a.paused ? " · paused by the watchtower" : ""}
              </div>
            </div>
            <div class="act-side">
              <div>{timeAgo(a.time)}</div>
              <TxLink hash={a.hash} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Dashboard({
  ctx,
  account,
  walletBal,
  notify,
  onNewAccount,
  onOpenAccount,
  onWalletBal,
}: {
  ctx: Ctx;
  account: string;
  walletBal: bigint | null;
  notify: Notify;
  onNewAccount: (privateMode?: boolean) => void;
  onOpenAccount: (account: string) => void;
  onWalletBal: (b: bigint) => void;
}) {
  const [view, setView] = useState<AccountView | null>(null);
  const [escape, setEscape] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [sheet, setSheet] = useState<null | "send" | "deposit" | "pin" | "accounts" | "alerts" | "device" | PrivSheet>(null);
  const [guardian, setGuardian] = useState<string | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  // private mode: whether this account has it (its own implementation), the last PIN view of this page session, and
  // what the key alone sent since (memory only: nothing about balances is ever stored)
  const [priv, setPriv] = useState<boolean | null>(null);
  const [pv, setPv] = useState<PrivView | null>(null);
  const kSince = useRef(0n);
  const [privBump, setPrivBump] = useState(0);
  useEffect(() => {
    retry(() => isPrivateAccount(read, account)).then(setPriv, () => setPriv(false));
  }, [account]);
  const onViewed = (v: bigint): PrivView => {
    const ks = kSince.current;
    const expected = pv ? (pv.value > ks ? pv.value - ks : 0n) : null;
    const next: PrivView = { value: v, at: Date.now(), sent: ks, check: pv && ks > 0n && expected !== null ? (v > expected ? "less" : "all") : null };
    kSince.current = 0n;
    setPv(next);
    return next;
  };
  const [claiming, setClaiming] = useState(false);
  const now = useNow(1000);

  const refresh = useCallback(
    async (withActivity: boolean) => {
      try {
        setView(await readAccount(read, account, ctx.w.address));
      } catch {
        /* transient RPC error: keep the last view */
      }
      read.getBalance(ctx.w.address).then(onWalletBal, () => undefined);
      if (withActivity) retry(() => loadActivity(read, account), 3).then(setActivity, () => setActivity((a) => a ?? []));
    },
    [account, ctx.w.address, onWalletBal],
  );

  useEffect(() => {
    void refresh(true);
    retry(() => readEscape(read, account)).then(setEscape, () => undefined);
    retry(() => readGuardian(read, account)).then(setGuardian, () => undefined);
    retry(() => readCosigners(read, account)).then((c) => setDevice(c.device), () => undefined);
    const id = setInterval(() => void refresh(false), 15000);
    return () => clearInterval(id);
  }, [account]);

  const nowS = Math.floor(now / 1000);
  const score = view?.score ?? 0;
  const next = view && view.nextAllowedAt > nowS ? `Next try in ${fmtWait(view.nextAllowedAt - nowS)}` : "Next try: now";

  /** F0.16: the bonds of correct PIN tries go back to this wallet. */
  async function claim() {
    setClaiming(true);
    try {
      await claimRefund(ctx, account, () => undefined);
      notify("Bond refund sent to your wallet", "ok");
    } catch (e) {
      notify(explainError(e), "err");
    } finally {
      setClaiming(false);
      void refresh(false);
    }
  }
  const badge = !view ? (
    <span class="badge">Loading…</span>
  ) : !view.armed ? (
    <span class="badge warn">Setup not finished</span>
  ) : view.escapeReadyAt ? (
    <span class="badge bad">Escape running</span>
  ) : view.restricted ? (
    <span class="badge warn">Restricted · PIN still works</span>
  ) : (
    <span class="badge ok">
      <IconShield />
      Protected
    </span>
  );

  return (
    <>
      <div class="dash">
        <div class="dash-col">
          <section class="balance-card">
            <div class="acct-row">
              <span class="acct-name">Encrypted Account{priv ? " · private mode" : ""}</span>
              <AddrChip a={account} notify={notify} />
            </div>
            <div class="big-bal">
              {view ? fmtEth(view.balance) : "—"}
              <small>ETH</small>
            </div>
            <div class="status-line">
              {badge}
              <span class="faint">Sepolia testnet</span>
            </div>
            <div class="bal-actions">
              <button type="button" class="btn btn-primary btn-lg" onClick={() => setSheet("send")} disabled={!view?.armed || !!view?.escapeReadyAt}>
                <IconUp />
                Send
              </button>
              <button type="button" class="btn btn-secondary btn-lg" onClick={() => setSheet("deposit")}>
                <IconDown />
                Deposit
              </button>
            </div>
            {view && view.refund > 0n && (
              <div class="notice info" style={{ marginTop: "14px", alignItems: "center" }}>
                <IconInfo />
                <span style={{ flex: 1 }}>
                  Bonds of your correct PIN tries: <b>{fmtEth(view.refund)} ETH</b>, ready to go back to your wallet.
                </span>
                <button type="button" class="btn btn-secondary btn-sm" disabled={claiming} onClick={() => void claim()}>
                  {claiming ? "Claiming…" : "Claim"}
                </button>
              </div>
            )}
          </section>

          {priv && view && <PrivateCard ctx={ctx} account={account} view={view} pv={pv} notify={notify} onSheet={setSheet} bump={privBump} guardian={guardian} />}

          <section class="card card-pad">
            <h3 class="card-title">
              Activity
              <button type="button" class="link-btn" onClick={() => void refresh(true)}>
                Refresh
              </button>
            </h3>
            <ActivityList items={activity} priv={!!priv} />
          </section>
        </div>

        <div class="dash-col">
          <section class="card card-pad">
            <h3 class="card-title">Protection</h3>
            <ul class="prot">
              <li>
                <span class="check">
                  <IconCheck />
                </span>
                <span class="k">
                  PIN<small>Encrypted fingerprint, checked under FHE</small>
                </span>
                <button type="button" class="link-btn v" onClick={() => setSheet("pin")} disabled={!view?.armed || !!view?.escapeReadyAt}>
                  Change
                </button>
              </li>
              <li>
                <span class="check">
                  <IconCheck />
                </span>
                <span class="k">
                  Hidden daily limit<small>Encrypted, with a random tripwire inside</small>
                </span>
                <span class="v">On</span>
              </li>
              <li>
                <span class="check">
                  <IconCheck />
                </span>
                <span class="k">
                  Address book<small>30 recipients and 10 spenders, encrypted</small>
                </span>
                <span class="v">On</span>
              </li>
              <li>
                <span class="check">
                  <IconCheck />
                </span>
                <span class="k">
                  Escape address<small class="mono">{escape ? short(escape) : "…"}</small>
                </span>
                <span class="v">Set</span>
              </li>
              <li>
                <span class="check">{device && device !== ethers.ZeroAddress ? <IconCheck /> : <IconInfo />}</span>
                <span class="k">
                  Second device
                  <small>{device === null ? "…" : device !== ethers.ZeroAddress ? `Phone ${short(device)}: approve your PIN there` : "Recommended: your PIN on your phone, the key here"}</small>
                </span>
                <button type="button" class="link-btn v" onClick={() => setSheet("device")} disabled={!view?.armed || !!view?.escapeReadyAt}>
                  {device && device !== ethers.ZeroAddress ? "Manage" : "Pair a phone"}
                </button>
              </li>
              <li>
                <span class="check">{guardian && guardian !== ethers.ZeroAddress ? <IconCheck /> : <IconInfo />}</span>
                <span class="k">
                  Alerts
                  <small>{guardian === null ? "…" : guardian !== ethers.ZeroAddress ? `Watchtower ${short(guardian)}: wrong PINs${priv ? ", private sends, the duress alarm" : ""}` : "No watchtower for this account"}</small>
                </span>
                <button type="button" class="link-btn v" onClick={() => setSheet("alerts")}>
                  How it works
                </button>
              </li>
              {priv && (
                <>
                  <li>
                    <span class="check">
                      <IconCheck />
                    </span>
                    <span class="k">
                      Private mode<small>cUSDC hidden on-chain; PIN-verified private sends wait at least 72 hours</small>
                    </span>
                    <span class="v">On</span>
                  </li>
                  <li>
                    <span class="check">
                      <IconLock />
                    </span>
                    <span class="k">
                      Duress PIN<small>Optional; limits the loss under coercion. Whether it is set is never shown.</small>
                    </span>
                    <button type="button" class="link-btn v" onClick={() => setSheet("duress")} disabled={!view?.armed || !!view?.escapeReadyAt}>
                      Set or remove
                    </button>
                  </li>
                </>
              )}
            </ul>
          </section>

          {priv === false && <PrivateModeOffer onCreate={() => onNewAccount(true)} onSwitch={() => setSheet("accounts")} />}

          <WillCard ctx={ctx} account={account} notify={notify} />

          <section class="card card-pad">
            <h3 class="card-title">
              Wrong PIN guesses
              <span class="small faint" style={{ fontWeight: 400 }}>
                {next}
              </span>
            </h3>
            <div class="row between">
              <span class="big-num">{score}</span>
              <span class="small faint">counted on-chain</span>
            </div>
            <div class="guesses" aria-hidden="true">
              {Array.from({ length: 6 }, (_, i) => (
                <i class={`${i < score ? "bad" : ""} ${i === 2 ? "thr" : ""}`} />
              ))}
            </div>
            <div class="guess-legend">
              <span>Waits start at the 3rd</span>
              <span>15 min → 7 days</span>
            </div>
            {view?.bond && (
              <div class="row between small" style={{ marginTop: "12px" }}>
                <span class="faint">Bond for the next PIN try</span>
                <span>{fmtEth(view.bond.required)} ETH · refundable</span>
              </div>
            )}
          </section>

          <div class="tip">
            <b>Try a wrong PIN.</b> Send a tiny amount with the wrong PIN: nothing moves, and the attempt shows up here, counted on-chain.
            <div>
              <button type="button" class="btn btn-secondary btn-sm" onClick={() => setSheet("send")} disabled={!view?.armed || !view.balance}>
                Try it
              </button>
            </div>
          </div>

          <div class="row wrap small" style={{ gap: "16px", padding: "0 4px" }}>
            <button type="button" class="link-btn" onClick={() => onNewAccount()}>
              Create another account
            </button>
            <button type="button" class="link-btn" onClick={() => setSheet("accounts")}>
              Switch account
            </button>
            <a class="ext" href={addrUrl(account)} target="_blank" rel="noopener">
              Etherscan
              <IconExt />
            </a>
          </div>
        </div>
      </div>

      {sheet === "send" && view && <SendSheet ctx={ctx} account={account} view={view} walletBal={walletBal} onClose={() => setSheet(null)} onSettled={() => void refresh(true)} />}
      {sheet === "pin" && <ChangePinSheet ctx={ctx} account={account} walletBal={walletBal} onClose={() => setSheet(null)} onSettled={() => void refresh(true)} />}
      {sheet === "deposit" && <DepositSheet ctx={ctx} account={account} walletBal={walletBal} onClose={() => setSheet(null)} onSettled={() => void refresh(true)} />}
      {sheet === "accounts" && (
        <AccountsSheet
          ctx={ctx}
          current={account}
          onClose={() => setSheet(null)}
          onPick={(a) => {
            setSheet(null);
            onOpenAccount(a);
          }}
          onNew={(p) => {
            setSheet(null);
            onNewAccount(p);
          }}
        />
      )}
      {sheet === "alerts" && <AlertsSheet guardian={guardian} priv={!!priv} onClose={() => setSheet(null)} />}
      {sheet === "device" && (
        <SecondDeviceSheet
          ctx={ctx}
          account={account}
          walletBal={walletBal}
          notify={notify}
          onClose={() => setSheet(null)}
          onSettled={() => {
            void refresh(true);
            readCosigners(read, account).then((c) => setDevice(c.device), () => undefined);
          }}
        />
      )}
      {sheet === "pview" && <PrivateViewSheet ctx={ctx} account={account} walletBal={walletBal} onClose={() => setSheet(null)} onViewed={onViewed} />}
      {sheet === "psend" && view && (
        <PrivateSendSheet
          ctx={ctx}
          account={account}
          view={view}
          walletBal={walletBal}
          onClose={() => setSheet(null)}
          onSettled={() => {
            setPrivBump((b) => b + 1);
            void refresh(true);
          }}
          onKSent={(u) => (kSince.current += u)}
        />
      )}
      {sheet === "duress" && <DuressSheet ctx={ctx} account={account} walletBal={walletBal} onClose={() => setSheet(null)} onSettled={() => void refresh(true)} />}
      {sheet === "preset" && <PrivateResetSheet ctx={ctx} account={account} walletBal={walletBal} onClose={() => setSheet(null)} onSettled={() => void refresh(true)} />}
      {sheet === "faucet" && <FaucetSheet ctx={ctx} account={account} onClose={() => setSheet(null)} onSettled={() => setPrivBump((b) => b + 1)} />}
    </>
  );
}

// ───────────────────────────── private mode (optional) ─────────────────────────────

const fmtUsd = (units: bigint) => `${(Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} cUSDC`;
const parseUsd = (v: string): bigint | null => {
  try {
    const u = ethers.parseUnits(v.trim() || "0", 6);
    return u > 0n ? u : null;
  } catch {
    return null;
  }
};
const PRIVATE_SETUP_LABEL = "Encrypt your private limits (cUSDC)";
const setupLabels = (priv: boolean): readonly string[] => (priv ? [...SETUP_LABELS.slice(0, PRIVATE_SETUP_STEP), PRIVATE_SETUP_LABEL, ...SETUP_LABELS.slice(PRIVATE_SETUP_STEP)] : SETUP_LABELS);
/** A viewed private balance stays on screen this long, then hides again (someone may be looking over your shoulder). */
const PRIVATE_SHOW_MS = 60_000;
const K_LABELS = ["Encrypt the amount and send it (one transaction)"];
const PSEND_LABELS = ["Open the private transfer (amount encrypted)", "Encrypt your PIN guess", "Submit the guess with its bond", "Decrypt only the yes / no result", "Record the result on-chain", "Scheduled: at least 72 hours"];
const PVIEW_LABELS = ["Open the balance view on-chain", "Encrypt your PIN guess", "Submit the guess with its bond", "Decrypt only the yes / no result", "Record the result: a snapshot for you", "Decrypt the snapshot in this page"];
const DURESS_LABELS = ["Open the change (encrypted)", "Encrypt your PIN guess", "Submit the guess with its bond", "Decrypt only the yes / no result", "Record the result on-chain", "Wait the delay, then apply it"];
const RESET_LABELS = ["Open the tripwire reset", "Encrypt your PIN guess", "Submit the guess with its bond", "Decrypt only the yes / no result", "Record the result: the counter restarts"];

/** Alerts: what the watchtower tells whom, and when. Its settings live in its own config file, never on-chain. */
function AlertsSheet({ guardian, priv, onClose }: { guardian: string | null; priv: boolean; onClose: () => void }) {
  const has = !!guardian && guardian !== ethers.ZeroAddress;
  return (
    <Sheet title="Alerts" onClose={onClose}>
      <p class="small muted" style={{ marginTop: 0 }}>
        A watchtower is a small service that watches the account on-chain and sends quiet messages. Who gets them is set in the watchtower&apos;s own settings, not
        on-chain, so this page can neither see nor change them.
      </p>
      <div class="notice" style={{ marginBottom: "14px" }}>
        <span>
          {has ? (
            <>
              This account&apos;s watchtower: <span class="mono">{short(guardian!)}</span>. It may restrict the account (when a key-only tripwire fires) and read
              what the account shares with it; it can never move funds.
            </>
          ) : (
            <>No watchtower was chosen when this account was created, so no alerts are sent for it.</>
          )}
        </span>
      </div>
      <ul class="prot">
        <li>
          <span class="check">
            <IconInfo />
          </span>
          <span class="k">
            Wrong PIN → you
            <small>Every wrong PIN tried with your key: a message to your own channel (Telegram or e-mail) seconds after the try is recorded on-chain.</small>
          </span>
        </li>
        {priv && (
          <li>
            <span class="check">
              <IconInfo />
            </span>
            <span class="k">
              Private send moved zero → you
              <small>
                A private send made with your key alone that moved nothing (an unknown recipient, more than the key alone may send, or a fired tripwire). Your key
                never learns this itself; the watchtower reads the one encrypted counter your account shares with it.
              </small>
            </span>
          </li>
        )}
        {priv && (
          <li>
            <span class="check">
              <IconLock />
            </span>
            <span class="k">
              Duress PIN → the person you chose
              <small>
                To limit the loss if someone forces you to open the account: the account looks normal and shows only what is above the amount you keep hidden, and the watchtower sends a silent alarm
                to the person you chose in advance (family, a lawyer or a security company). Never to your own phone or channel, which may be in the attacker&apos;s
                hands. Nothing happens on-chain: no restriction, no freeze, no event. The alarm says which account, when, and that the duress PIN was used, plus your
                optional short note; never a balance or any amount.
              </small>
            </span>
          </li>
        )}
        <li>
          <span class="check">
            <IconInfo />
          </span>
          <span class="k">
            Also to you
            <small>A PIN-approved operation (the same message for either PIN), a restriction, an escape that started, a recovery that was opened.</small>
          </span>
        </li>
      </ul>
      <p class="small faint" style={{ marginBottom: 0 }}>
        The watchtower only sends messages: it does not call the police or anyone else by itself; what happens next is up to the person who gets the alarm. It works
        only while the service runs and its channels are set up.
      </p>
    </Sheet>
  );
}

type PrivSheet = "pview" | "psend" | "duress" | "faucet" | "preset";
/** The last PIN view in this page session (memory only; never stored) and whether the key-only sends since the one
 *  before it all moved. */
type PrivView = { value: bigint; at: number; sent: bigint; check: "all" | "less" | null };

function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} class={`switch ${on ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

function useBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [active]);
}

// ── setup ──

type PrivForm = { on: boolean; limit: string; known: string; duress: boolean; dpin: string; dpin2: string; hidden: string };

function privFormError(f: PrivForm, pin: string, owner: string, escape: string): string | null {
  if (!f.on) return null;
  const l = parseUsd(f.limit);
  if (!l || l < 2n) return "Enter the private daily limit in cUSDC.";
  const k = f.known.trim();
  if (k) {
    if (!ethers.isAddress(k)) return "The known recipient is not a valid address.";
    if (k.toLowerCase() === owner.toLowerCase()) return "Use another address than this wallet: whoever holds your key could send to it.";
    if (k.toLowerCase() === escape.toLowerCase()) return "The escape address can't be a recipient.";
  }
  if (f.duress) {
    const c = checkPin(f.dpin);
    if (!f.dpin) return "Choose a duress PIN, or turn the duress PIN off.";
    if (!c.ok) return c.reason ?? "Choose another duress PIN.";
    if (f.dpin !== f.dpin2) return "The two duress PINs don't match.";
    if (f.dpin === pin) return "The duress PIN must differ from your PIN.";
    if (!parseUsd(f.hidden)) return "Enter the amount to keep hidden, in cUSDC.";
  }
  return null;
}

/**
 * Whether private accounts can be created here: FACTORY_P is set and runs the private-mode build this app is written for
 * (PRIVATE_MODE_VERSION). "old": deployed, but an older build. Checked once per page.
 */
let privateReadyOnce: Promise<"yes" | "no" | "old"> | null = null;
function usePrivateReady(): "yes" | "no" | "old" | null {
  const [r, setR] = useState<"yes" | "no" | "old" | null>(FACTORY_P ? null : "no");
  useEffect(() => {
    if (!FACTORY_P) return;
    privateReadyOnce ??= privateModeVersionOf(read, { factory: FACTORY_P }).then((v) => (v === PRIVATE_MODE_VERSION ? "yes" : "old"));
    let live = true;
    privateReadyOnce.then((x) => live && setR(x), () => live && setR("no"));
    return () => {
      live = false;
    };
  }, []);
  return r;
}

const PRIVATE_NOT_READY = {
  no: "Not deployed on Sepolia yet: this option opens once it is.",
  old: "The private-mode contracts on Sepolia are an older build than this app: this option opens once the current one is deployed.",
} as const;

/** Setup: two devices (recommended) — the PIN on the phone, the key here — or this device only. Never required. */
function DeviceSetupBox({ dev, set, err, notify }: { dev: { two: boolean; addr: string }; set: (d: { two: boolean; addr: string }) => void; err: string | null; notify: Notify }) {
  const link = pairLink(location.origin);
  return (
    <div class="private-box">
      <div style={{ fontWeight: 600, fontSize: "14px" }}>Where you type your PIN</div>
      <div class="seg" style={{ marginTop: "10px" }}>
        <button type="button" class={`chip-btn ${dev.two ? "on" : ""}`} onClick={() => set({ ...dev, two: true })}>
          On my phone (recommended)
        </button>
        <button type="button" class={`chip-btn ${!dev.two ? "on" : ""}`} onClick={() => set({ ...dev, two: false })}>
          On this device only
        </button>
      </div>
      {dev.two ? (
        <div class="stack" style={{ marginTop: "12px" }}>
          <div class="small faint">
            Your key stays here and your PIN is typed on your phone, which signs each PIN entry with its own device key. Malware on one device then gets the key
            or the PIN, not both. The phone can move nothing by itself.
          </div>
          <div class="row wrap" style={{ gap: "16px", alignItems: "center" }}>
            <div style={{ width: "140px", background: "#fff", padding: "6px", borderRadius: "10px" }} dangerouslySetInnerHTML={{ __html: qrSvg(link) }} />
            <div class="small muted" style={{ flex: "1 1 200px" }}>
              Scan with your phone (or open the link there), make its device key, and paste its device address here.
              <div style={{ marginTop: "6px" }}>
                <button type="button" class="link-btn" onClick={() => copy(link, notify, "Link")}>
                  Copy the link
                </button>
              </div>
            </div>
          </div>
          <label class="field">
            <span>Your phone's device address</span>
            <input class="input mono" placeholder="0x…" value={dev.addr} spellcheck={false} autoComplete="off" onInput={(e) => set({ ...dev, addr: (e.target as HTMLInputElement).value })} />
          </label>
          {err && <p class="field-err">{err}</p>}
        </div>
      ) : (
        <p class="small faint" style={{ margin: "10px 0 0" }}>
          Simpler, and everything works the same; malware that takes over this device could get both the key and the PIN. You can pair a phone later on the
          account page.
        </p>
      )}
    </div>
  );
}

/** Setup: the optional private mode, off by default; its duress PIN is a second option, also off by default. */
function PrivateSetupBox({ f, set, err, resume }: { f: PrivForm; set: (p: Partial<PrivForm>) => void; err: string | null; resume?: boolean }) {
  const ready = usePrivateReady();
  const deployed = ready === "yes";
  const half = parseUsd(f.limit);
  return (
    <div class="private-box">
      <div class="row between" style={{ alignItems: "flex-start", gap: "14px" }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: "14px" }}>Private mode (optional)</div>
          <div class="small faint" style={{ marginTop: "2px" }}>
            Adds a cUSDC balance nobody can read on-chain, not even someone holding your key. You see it with your PIN. Off: the account is exactly the standard one.
          </div>
        </div>
        <Toggle on={f.on} onChange={(on) => set({ on })} disabled={!deployed} label="Private mode" />
      </div>
      {(ready === "no" || ready === "old") && (
        <p class="small faint" style={{ margin: "8px 0 0" }}>
          {PRIVATE_NOT_READY[ready]}
        </p>
      )}
      {f.on && (
        <div class="stack" style={{ marginTop: "14px" }}>
          <label class="field">
            <span>Private daily limit</span>
            <div class="input-wrap">
              <input class="input" inputMode="decimal" value={f.limit} aria-label="Private daily limit in cUSDC" onInput={(e) => set({ limit: (e.target as HTMLInputElement).value })} style={{ paddingRight: "72px" }} />
              <div class="suffix">
                <span class="small faint">cUSDC</span>
              </div>
            </div>
            <span class="field-hint">
              Encrypted, with its own random tripwire. Your key alone sends up to {half ? fmtUsd(half / 2n) : "half of it"} a day in one transaction; anything more goes the PIN way.
            </span>
          </label>
          <label class="field">
            <span>Known recipient for one-transaction sends (optional)</span>
            <input class="input mono" placeholder="0x…" value={f.known} spellcheck={false} autoComplete="off" onInput={(e) => set({ known: (e.target as HTMLInputElement).value })} />
            <span class="field-hint">Your key alone can send only here. Not this wallet: whoever holds your key could use it. Leave it empty and every private send takes the PIN way.</span>
          </label>
          <div class="notice">
            <IconClock />
            <span>
              In private mode, <b>a PIN-verified private send waits at least 72 hours</b>, and so do big ETH sends. Someone who forces your PIN still has to wait, and an escape can stop it.
            </span>
          </div>
          <div class="duress-box">
            <div class="row between" style={{ alignItems: "flex-start", gap: "14px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "14px" }}>Duress PIN (optional)</div>
                <div class="small faint" style={{ marginTop: "2px" }}>
                  Limits the loss if someone forces you to open the account: typed instead of your PIN, it shows and sends only what is above the amount you keep hidden, as if that were your whole balance. Deposits and payments show in it as they would in a real balance. The chain can't tell which PIN was used, or whether one is set, and this page never stores it.
                </div>
              </div>
              <Toggle on={f.duress} onChange={(duress) => set({ duress })} label="Duress PIN" />
            </div>
            {f.duress && (
              <div class="row wrap" style={{ gap: "10px", marginTop: "12px" }}>
                <label class="field" style={{ flex: "1 1 120px" }}>
                  <span>Duress PIN</span>
                  <input class="input mono" type="password" inputMode="numeric" autoComplete="off" value={f.dpin} onInput={(e) => set({ dpin: (e.target as HTMLInputElement).value.replace(/\D/g, "") })} />
                </label>
                <label class="field" style={{ flex: "1 1 120px" }}>
                  <span>Repeat it</span>
                  <input class="input mono" type="password" inputMode="numeric" autoComplete="off" value={f.dpin2} onInput={(e) => set({ dpin2: (e.target as HTMLInputElement).value.replace(/\D/g, "") })} />
                </label>
                <label class="field" style={{ flex: "1 1 140px" }}>
                  <span>Keep hidden</span>
                  <div class="input-wrap">
                    <input class="input" inputMode="decimal" value={f.hidden} onInput={(e) => set({ hidden: (e.target as HTMLInputElement).value })} style={{ paddingRight: "72px" }} />
                    <div class="suffix">
                      <span class="small faint">cUSDC</span>
                    </div>
                  </div>
                </label>
                <p class="small faint" style={{ margin: 0, flexBasis: "100%" }}>
                  The duress PIN never shows or moves this part of the balance. Your key alone can&apos;t move it either: only your real PIN can.
                </p>
              </div>
            )}
          </div>
          {resume && (
            <p class="small faint" style={{ margin: 0 }}>
              Continuing an unfinished setup: your PIN is stored again, with the duress choice made here, before the private token is set up. You can set or remove the duress PIN later on the account page.
            </p>
          )}
          {err && <p class="field-err">{err}</p>}
        </div>
      )}
    </div>
  );
}

function PrivateReviewRows({ f }: { f: PrivForm }) {
  const l = parseUsd(f.limit);
  const k = f.known.trim();
  const row = (k1: string, v: ComponentChildren) => (
    <div class="review-row">
      <span class="check">
        <IconCheck />
      </span>
      <span class="k">{k1}</span>
      <span class="v">{v}</span>
    </div>
  );
  return (
    <>
      {row(
        "Private mode",
        <>
          cUSDC, balance hidden<small>you see it with your PIN</small>
        </>,
      )}
      {row(
        "Private daily limit",
        <>
          {l ? fmtUsd(l) : "—"}
          <small>your key alone: up to {l ? fmtUsd(l / 2n) : "half"} a day</small>
        </>,
      )}
      {row(
        "Known recipient",
        <>
          <span class="mono">{k ? short(k) : "none"}</span>
          <small>{k ? "one-transaction sends go only here" : "every private send takes the PIN way"}</small>
        </>,
      )}
      {row(
        "Long wait",
        <>
          72 hours<small>PIN-verified private sends and big ETH sends</small>
        </>,
      )}
      {row(
        "Duress PIN",
        <>
          {f.duress ? `On · ${f.hidden} cUSDC kept hidden` : "Off"}
          <small>never stored on this device</small>
        </>,
      )}
    </>
  );
}

// ── shared pieces of the private sheets ──

function PinStage(p: { summary?: ComponentChildren; info: TryInfo | null; walletBal: bigint | null; pin: string; setPin: (v: string) => void; onGo: (v: string) => void; onBack?: () => void; label: string; prompt?: string; note?: string }) {
  const low = lowWallet(p.info, p.walletBal);
  return (
    <div>
      {p.summary}
      <TryCost info={p.info} walletBal={p.walletBal} />
      <p class="center muted" style={{ margin: "18px 0 6px", fontSize: "15px" }}>
        {p.prompt ?? "Enter your PIN"}
      </p>
      <PinPad value={p.pin} onChange={p.setPin} onEnter={(v) => !low && v.length >= 6 && p.onGo(v)} />
      <p class="keys-hint center">{p.note ?? "Wrong PINs are counted on-chain and do nothing; the bond stays in your account."}</p>
      <div class="flow-actions">
        {p.onBack && (
          <button type="button" class="btn btn-ghost" onClick={p.onBack}>
            Back
          </button>
        )}
        <button type="button" class="btn btn-primary" disabled={p.pin.length < 6 || low} onClick={() => p.onGo(p.pin)}>
          {p.label}
        </button>
      </div>
    </div>
  );
}

function RunStage(p: { title: string; labels: readonly string[]; tasks: TaskState[]; t0: number; offer?: RefundOffer; note?: string }) {
  const now = useNow(1000);
  const done = p.tasks.filter((t) => t.s === "done" || t.s === "bad" || t.s === "skip").length;
  const current = p.tasks.findIndex((t) => t.s === "run");
  return (
    <div>
      <div class="progress-head">
        <Ring done={done} total={p.labels.length} />
        <div>
          <div class="progress-title">{p.title}</div>
          <div class="progress-sub">{current >= 0 ? p.labels[current] : "Preparing…"}</div>
          <div class="timer">{mmss(now - p.t0)}</div>
        </div>
      </div>
      <ul class="tasks">
        {p.tasks.map((t, i) => (
          <Task label={p.labels[i]} t={t} extra={t.s === "run" && /Encrypt|Waiting for the threshold/.test(t.text ?? p.labels[i]) ? <Cipher n={12} /> : undefined} />
        ))}
      </ul>
      {p.note && (
        <div class="notice" style={{ marginTop: "14px" }}>
          <IconInfo />
          <span>{p.note}</span>
        </div>
      )}
      {p.offer && <RefundNotice offer={p.offer} />}
    </div>
  );
}

type PinResult<T> = { kind: "ok"; value: T } | { kind: "wrong"; score: number; next: number } | { kind: "err"; text: string };

function FailResult({ r, bond, onClose, onRetry }: { r: { kind: "wrong"; score: number; next: number } | { kind: "err"; text: string }; bond: OwnerBond | null; onClose: () => void; onRetry: () => void }) {
  const nowS = Math.floor(useNow(1000) / 1000);
  const locked = r.kind === "wrong" && r.next > nowS;
  return (
    <div class="result">
      <div class="result-icon bad">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
        </svg>
      </div>
      {r.kind === "wrong" ? (
        <>
          <h3>Wrong PIN. Nothing happened.</h3>
          <p>
            The attempt was counted on-chain before its result was decrypted. Wrong guesses so far: {r.score}.
            {bond ? ` The bond stayed in your account; the next try needs ${fmtEth(ownerBondFor(r.score, bond.base))} ETH.` : ""}
          </p>
          <div class="facts-row">
            <span class={`badge ${locked ? "warn" : ""}`}>
              <IconClock />
              {locked ? `Next try in ${fmtWait(r.next - nowS)}` : "Next try: now"}
            </span>
          </div>
        </>
      ) : (
        <>
          <h3>That didn't go through</h3>
          <p>{r.text}</p>
        </>
      )}
      <div class="flow-actions">
        <button type="button" class="btn btn-secondary" onClick={onClose}>
          Close
        </button>
        <button type="button" class="btn btn-primary" disabled={locked} onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

const OkMark = () => (
  <div class="result-icon ok">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  </div>
);

function asPinFailure(e: unknown): { kind: "wrong"; score: number; next: number } | { kind: "err"; text: string } {
  return e instanceof WrongPin ? { kind: "wrong", score: e.score, next: e.nextAllowedAt } : { kind: "err", text: explainError(e) };
}

// ── the private card (private-mode accounts) ──

function PrivateCard(p: { ctx: Ctx; account: string; view: AccountView; pv: PrivView | null; notify: Notify; onSheet: (s: PrivSheet) => void; bump: number; guardian: string | null }) {
  const { ctx, account, view, pv, notify } = p;
  const [info, setInfo] = useState<PrivateInfo | null>(null);
  const [pending, setPending] = useState<PendingPrivate[]>(() => loadPrivLocal(account).pending);
  const [notices, setNotices] = useState<PrivateNotice[] | null | "err">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow(1000);
  const nowS = Math.floor(now / 1000);

  useEffect(() => {
    let live = true;
    const load = () => {
      retry(() => readPrivate(read, account)).then(
        (i) => live && setInfo(i),
        () => undefined,
      );
      refreshPending(read, account).then(
        (x) => live && setPending(x),
        () => undefined,
      );
      loadWatchtowerNotices(account).then(
        (n) => live && setNotices(n),
        () => live && setNotices("err"),
      );
    };
    load();
    const id = setInterval(load, 20000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [account, p.bump]);

  async function sendNow(x: PendingPrivate) {
    setBusy(x.opId);
    try {
      await executePrivate(ctx, account, BigInt(x.opId), () => undefined);
      notify("Private transfer sent", "ok");
      setPending((l) => l.filter((y) => y.opId !== x.opId));
    } catch (e) {
      notify(explainError(e), "err");
    } finally {
      setBusy(null);
    }
  }

  async function sweep() {
    setBusy("sweep");
    try {
      await sweepPrivateToEscape(ctx, account, () => undefined);
      notify("The private balance went to the escape address", "ok");
    } catch (e) {
      notify(explainError(e), "err");
    } finally {
      setBusy(null);
    }
  }

  const shown = pv && now - pv.at < PRIVATE_SHOW_MS ? pv : null;
  const empty = info !== null && info.balanceHandle === ethers.ZeroHash;
  const escapeOn = view.escapeReadyAt > 0;
  const tripped = Array.isArray(notices) && notices.some((n) => n.kind === "private-tripwire");
  return (
    <section class="card card-pad priv-card">
      <h3 class="card-title">
        <span class="row" style={{ gap: "8px" }}>
          <IconLock />
          Private balance
        </span>
        <span class="badge">cUSDC · ERC-7984</span>
      </h3>
      <div class="priv-bal">
        {shown ? (
          <>
            {fmtUsd(shown.value)}
            <small>seen with your PIN · hides again in {Math.max(1, Math.ceil((PRIVATE_SHOW_MS - (now - shown.at)) / 1000))} s</small>
          </>
        ) : empty ? (
          <>
            0 cUSDC<small>nothing here yet: get test cUSDC below</small>
          </>
        ) : (
          <>
            <span class="priv-mask">••••••</span>
            <small>hidden on-chain, even from your key: view it with your PIN</small>
          </>
        )}
      </div>
      {shown && shown.check === "less" && (
        <div class="notice warn" style={{ marginBottom: "12px" }}>
          <IconInfo />
          <span>
            Since your previous view you sent <b>{fmtUsd(shown.sent)}</b> with your key, but the balance went down by less. <b>At least one key-only send moved zero</b> (a hidden rule stopped it), unless cUSDC came in meanwhile. Send it again the PIN way.
          </span>
        </div>
      )}
      {shown && shown.check === "all" && (
        <div class="notice ok" style={{ marginBottom: "12px" }}>
          <IconCheck />
          <span>Your key-only sends since the previous view went through ({fmtUsd(shown.sent)}).</span>
        </div>
      )}
      <div class="bal-actions">
        <button type="button" class="btn btn-primary" onClick={() => p.onSheet("pview")} disabled={!view.armed || escapeOn}>
          <IconEye />
          Show with PIN
        </button>
        <button type="button" class="btn btn-secondary" onClick={() => p.onSheet("psend")} disabled={!view.armed || escapeOn}>
          <IconUp />
          Send privately
        </button>
      </div>
      <div class="row wrap small" style={{ gap: "14px", marginTop: "12px" }}>
        <button type="button" class="link-btn" onClick={() => p.onSheet("faucet")} disabled={escapeOn}>
          Get test cUSDC
        </button>
        {info && <span class="faint">PIN-verified private sends wait {fmtWait(info.transferDelay)}</span>}
      </div>

      {pending.length > 0 && (
        <div class="priv-section">
          <div class="priv-sub">Scheduled private sends</div>
          <ul class="pending-list">
            {pending.map((x) => {
              const ready = nowS >= x.readyAt;
              return (
                <li>
                  <span class={`act-ico ${ready ? "ok" : "warn"}`}>
                    <IconClock />
                  </span>
                  <div class="act-main">
                    <div class="act-title">To {short(x.to)} · amount hidden</div>
                    <div class="act-sub">{ready ? "Ready: anyone may send it now" : `Can be sent in ${fmtWait(x.readyAt - nowS)} · an escape cancels it`}</div>
                  </div>
                  <button type="button" class="btn btn-secondary btn-sm" disabled={!ready || busy !== null} onClick={() => void sendNow(x)}>
                    {busy === x.opId ? "Sending…" : "Send now"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div class="priv-section">
        <div class="priv-sub">Key-only sends: did they move?</div>
        {notices === null ? (
          <p class="small faint" style={{ margin: 0 }}>
            {p.guardian && p.guardian !== ethers.ZeroAddress
              ? "Your key never learns whether a key-only send moved: if a hidden rule stops one, it moves zero (a silent zero). This account's watchtower sees it and tells you on your own channel; this page cannot see its messages. It sends with the key alone only what is sure to pass and routes the rest the PIN way. To check here, view the balance with your PIN: the comparison shows up here."
              : "No watchtower for this account. Your key never learns whether a key-only send moved: if a hidden rule stops one, it moves zero (a silent zero) and only a watchtower sees it. This page sends with the key alone only what is sure to pass and routes the rest the PIN way. To check, view the balance with your PIN: the comparison shows up here."}
          </p>
        ) : notices === "err" ? (
          <p class="small faint" style={{ margin: 0 }}>
            The watchtower can't be reached right now. View the balance with your PIN to check your key-only sends.
          </p>
        ) : notices.length === 0 ? (
          <p class="small faint" style={{ margin: 0 }}>
            The watchtower reports nothing unusual.
          </p>
        ) : (
          <ul class="pending-list">
            {notices.slice(0, 5).map((n) => (
              <li>
                <span class={`act-ico ${n.kind === "private-delivered" ? "ok" : n.kind === "private-tripwire" ? "bad" : "warn"}`}>{n.kind === "private-delivered" ? <IconCheck /> : <IconInfo />}</span>
                <div class="act-main">
                  <div class="act-title">
                    {n.kind === "private-delivered"
                      ? `Delivered: ${n.moved ? fmtUsd(BigInt(n.moved)) : "the amount"} to ${n.to ? short(n.to) : "the recipient"}`
                      : n.kind === "private-silent-zero"
                        ? `Silent zero: a key-only send to ${n.to ? short(n.to) : "a recipient"} moved nothing`
                        : "The tripwire fired"}
                  </div>
                  <div class="act-sub">
                    {n.kind === "private-delivered"
                      ? "Reported by your watchtower"
                      : n.kind === "private-silent-zero"
                        ? "A hidden rule stopped it (the limit, the tripwire or an unknown recipient). Send it again the PIN way."
                        : "Key-only sends move nothing until you reset it with your PIN."}
                  </div>
                </div>
                {n.txHash && <TxLink hash={n.txHash} />}
              </li>
            ))}
          </ul>
        )}
        {tripped && (
          <button type="button" class="btn btn-secondary btn-sm" style={{ marginTop: "10px" }} onClick={() => p.onSheet("preset")} disabled={escapeOn}>
            Reset the tripwire with your PIN
          </button>
        )}
      </div>

      {escapeOn && (
        <div class="notice warn" style={{ marginTop: "14px", alignItems: "center" }}>
          <IconShield />
          <span style={{ flex: 1 }}>
            {nowS >= view.escapeReadyAt ? (
              <>Escape: the private balance can go to the escape address now. No PIN; anyone may send it.</>
            ) : (
              <>Escape running: in {fmtWait(view.escapeReadyAt - nowS)} the private balance can go to the escape address, no PIN needed.</>
            )}
          </span>
          {nowS >= view.escapeReadyAt && (
            <button type="button" class="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void sweep()}>
              {busy === "sweep" ? "Moving…" : "Move it"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ── PIN-gated view ──

function PrivateViewSheet({ ctx, account, walletBal, onClose, onViewed }: { ctx: Ctx; account: string; walletBal: bigint | null; onClose: () => void; onViewed: (v: bigint) => PrivView }) {
  const [stage, setStage] = useState<"pin" | "run" | "result">("pin");
  const [pin, setPin] = useState("");
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(PRIVATE_VIEW_STEPS.length));
  const [t0, setT0] = useState(0);
  const [verified, setVerified] = useState(false);
  const [result, setResult] = useState<PinResult<PrivView> | null>(null);
  const info = useTryInfo(account);
  const offer = useRefundOffer(ctx, account, verified, !!info?.bond);
  useBeforeUnload(stage === "run");

  async function go(v: string) {
    setStage("run");
    setT0(Date.now());
    setVerified(false);
    setTasks(freshTasks(PRIVATE_VIEW_STEPS.length));
    try {
      const bal = await privateViewWithPin(ctx, account, v, taskCb(setTasks, 5, () => setVerified(true)), info?.bond?.required);
      setResult({ kind: "ok", value: onViewed(bal) });
    } catch (e) {
      setResult(asPinFailure(e));
    } finally {
      setPin("");
      setStage("result");
    }
  }

  return (
    <Sheet title={stage === "result" ? "Private balance" : "View with your PIN"} onClose={onClose} locked={stage === "run"}>
      {stage === "pin" && (
        <PinStage
          summary={
            <div class="notice info">
              <IconEye />
              <span>Your PIN makes a fresh encrypted snapshot of the balance that only this wallet may decrypt. Nothing about it is public.</span>
            </div>
          }
          info={info}
          walletBal={walletBal}
          pin={pin}
          setPin={setPin}
          onGo={(v) => void go(v)}
          label="View with PIN"
        />
      )}
      {stage === "run" && <RunStage title="Checking your PIN" labels={PVIEW_LABELS} tasks={tasks} t0={t0} offer={offer} note="Up to 4 wallet confirmations and one decryption permit to sign." />}
      {stage === "result" && result?.kind === "ok" && (
        <div class="result">
          <OkMark />
          <h3>{fmtUsd(result.value.value)}</h3>
          <p>Decrypted in this page only. It stays on the account page for a minute, then hides again; it is never saved.</p>
          {result.value.check === "less" && (
            <div class="notice warn" style={{ textAlign: "left" }}>
              <IconInfo />
              <span>
                Since your previous view you sent {fmtUsd(result.value.sent)} with your key, but the balance went down by less: at least one key-only send moved zero, unless cUSDC came in meanwhile.
              </span>
            </div>
          )}
          <RefundNotice offer={offer} />
          <div class="flow-actions">
            <button type="button" class="btn btn-primary btn-lg" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
      {stage === "result" && result && result.kind !== "ok" && <FailResult r={result} bond={info?.bond ?? null} onClose={onClose} onRetry={() => setStage("pin")} />}
    </Sheet>
  );
}

// ── private send ──

type PSendResult = { kind: "k"; hash: string } | { kind: "scheduled"; readyAt: number; hash: string } | { kind: "wrong"; score: number; next: number } | { kind: "err"; text: string };

function PrivateSendSheet(p: { ctx: Ctx; account: string; view: AccountView; walletBal: bigint | null; onClose: () => void; onSettled: () => void; onKSent: (units: bigint) => void }) {
  const { ctx, account, view, walletBal } = p;
  const local = useMemo(() => loadPrivLocal(account), [account]);
  const [stage, setStage] = useState<"details" | "pin" | "run" | "result">("details");
  const [to, setTo] = useState(local.known[0] ?? "");
  const [amt, setAmt] = useState("1");
  const [pin, setPin] = useState("");
  const [labels, setLabels] = useState<readonly string[]>(PSEND_LABELS);
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(PSEND_LABELS.length));
  const [t0, setT0] = useState(0);
  const [verified, setVerified] = useState(false);
  const [result, setResult] = useState<PSendResult | null>(null);
  const info = useTryInfo(account);
  const offer = useRefundOffer(ctx, account, verified, !!info?.bond, p.onSettled);
  useBeforeUnload(stage === "run");

  const toTrim = to.trim();
  const toOk = ethers.isAddress(toTrim) && toTrim.toLowerCase() !== account.toLowerCase();
  const units = parseUsd(amt);
  const known = toOk && local.known.some((k) => k.toLowerCase() === toTrim.toLowerCase());
  const route =
    units && toOk
      ? routePrivateSend({
          amount: units,
          recipientKnown: known,
          lmin: local.lmin ? BigInt(local.lmin) : null,
          sentToday: local.lmin ? sentToday(local.sends, Date.now()) : null,
          restricted: view.restricted !== 0,
        })
      : null;

  async function sendK() {
    if (!units || !toOk) return;
    setLabels(K_LABELS);
    setTasks(freshTasks(1));
    setStage("run");
    setT0(Date.now());
    const cb = taskCb(setTasks, 0);
    try {
      cb(0, "run");
      const h = await privateSendKOnly(ctx, account, ethers.getAddress(toTrim), units, (t, hh) => cb(0, "run", t, hh));
      cb(0, "done", undefined, h);
      p.onKSent(units);
      setResult({ kind: "k", hash: h });
    } catch (e) {
      cb(0, "fail", explainError(e));
      setResult({ kind: "err", text: explainError(e) });
    } finally {
      setStage("result");
      p.onSettled();
    }
  }

  async function sendPin(v: string) {
    if (!units || !toOk) return;
    setLabels(PSEND_LABELS);
    setTasks(freshTasks(PSEND_LABELS.length));
    setStage("run");
    setT0(Date.now());
    setVerified(false);
    try {
      const r = await privateSendWithPin(ctx, account, ethers.getAddress(toTrim), units, v, taskCb(setTasks, 5, () => setVerified(true)), info?.bond?.required);
      setResult({ kind: "scheduled", readyAt: r.readyAt, hash: r.hash });
    } catch (e) {
      setResult(asPinFailure(e));
    } finally {
      setPin("");
      setStage("result");
      p.onSettled();
    }
  }

  return (
    <Sheet title={stage === "result" ? "Result" : "Send privately"} onClose={p.onClose} locked={stage === "run"}>
      {stage === "details" && (
        <div class="stack">
          <label class="field">
            <span>Recipient</span>
            <input class="input mono" placeholder="0x…" value={to} spellcheck={false} autoComplete="off" onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
            {toTrim && !toOk && <span class="field-err">Enter a valid address (not the account itself).</span>}
          </label>
          {local.known.length > 0 && (
            <div class="chips">
              {local.known.map((k) => (
                <button type="button" class="chip-btn" onClick={() => setTo(k)}>
                  Known · {short(k)}
                </button>
              ))}
            </div>
          )}
          <label class="field">
            <span>Amount</span>
            <div class="input-wrap">
              <input class="input" inputMode="decimal" value={amt} onInput={(e) => setAmt((e.target as HTMLInputElement).value)} style={{ paddingRight: "72px" }} />
              <div class="suffix">
                <span class="small faint">cUSDC</span>
              </div>
            </div>
            <span class="field-hint">The amount is encrypted in this page; the chain never shows it. A send above the balance moves zero.</span>
          </label>
          {route && (
            <div class={`route ${route.path === "k-only" ? "k" : "pin"}`}>
              {route.path === "k-only" ? (
                <>
                  <b>Your key alone, one transaction.</b> {route.reason}. Nothing is decrypted, and your key won't learn whether it moved: this page only sends this way what is sure to pass.
                </>
              ) : (
                <>
                  <b>The PIN way.</b> {route.reason}. After your PIN it waits at least 72 hours, then anyone may send it (this page shows a button).
                </>
              )}
            </div>
          )}
          {route && (
            <button type="button" class="btn btn-primary btn-lg btn-block" disabled={!toOk || !units} onClick={() => (route.path === "k-only" ? void sendK() : setStage("pin"))}>
              {route.path === "k-only" ? "Send with your key" : "Continue"}
            </button>
          )}
          {!route && (
            <button type="button" class="btn btn-primary btn-lg btn-block" disabled>
              Continue
            </button>
          )}
        </div>
      )}
      {stage === "pin" && units && (
        <PinStage
          summary={
            <>
              <div class="sum">
                <b>{fmtUsd(units)}</b>
                <span class="faint">→</span>
                <span class="mono">{short(toTrim)}</span>
              </div>
              <div class="notice" style={{ marginTop: "12px" }}>
                <IconClock />
                <span>It waits at least 72 hours after your PIN. Someone who forces your PIN has to wait too, and an escape cancels it.</span>
              </div>
            </>
          }
          info={info}
          walletBal={walletBal}
          pin={pin}
          setPin={setPin}
          onGo={(v) => void sendPin(v)}
          onBack={() => setStage("details")}
          label="Schedule with PIN"
        />
      )}
      {stage === "run" && <RunStage title={labels === K_LABELS ? "Sending with your key" : "Checking your PIN"} labels={labels} tasks={tasks} t0={t0} offer={labels === K_LABELS ? undefined : offer} />}
      {stage === "result" && result?.kind === "k" && (
        <div class="result">
          <OkMark />
          <h3>Sent with your key</h3>
          <p>
            One transaction, nothing decrypted. Your key can't tell whether it moved; {WATCHTOWER.noticesUrl ? "your watchtower reports it if it moved zero." : "view the balance with your PIN to check."}
          </p>
          <div class="facts-row">
            <TxLink hash={result.hash} label="View transaction" />
          </div>
          <div class="flow-actions">
            <button type="button" class="btn btn-primary btn-lg" onClick={p.onClose}>
              Done
            </button>
          </div>
        </div>
      )}
      {stage === "result" && result?.kind === "scheduled" && (
        <div class="result">
          <OkMark />
          <h3>Scheduled</h3>
          <p>
            Your PIN was checked under FHE. The transfer can be sent from <b>{new Date(result.readyAt * 1000).toLocaleString()}</b>; the account page shows a button then. Until that time an escape cancels it.
          </p>
          <div class="facts-row">
            <TxLink hash={result.hash} label="View transaction" />
          </div>
          <RefundNotice offer={offer} />
          <div class="flow-actions">
            <button type="button" class="btn btn-primary btn-lg" onClick={p.onClose}>
              Done
            </button>
          </div>
        </div>
      )}
      {stage === "result" && result && (result.kind === "wrong" || result.kind === "err") && <FailResult r={result} bond={info?.bond ?? null} onClose={p.onClose} onRetry={() => setStage("details")} />}
    </Sheet>
  );
}

// ── duress PIN (set or remove; its state is never shown) ──

/** How believable the duress view is from public data. `hidden` is the amount the duress PIN keeps out of view; the view a
 *  coercer sees is taken as the shielded net minus it (nothing else left the account), so the real figure is at most this. */
function CredibilityMeter({ account, hidden }: { account: string; hidden: bigint | null }) {
  const [hist, setHist] = useState<{ n: bigint; k: number } | null | "err">(null);
  useEffect(() => {
    let live = true;
    retry(() => privateHistory(read, account), 2).then(
      (h) => {
        const ph = publicHistory(h);
        if (live) setHist({ n: ph.shieldedNet, k: ph.hiddenPaymentsSinceLastShield });
      },
      () => live && setHist("err"),
    );
    return () => {
      live = false;
    };
  }, [account]);
  if (hist === null) return <div class="cred small faint">Reading this account's public history…</div>;
  if (hist === "err") return <div class="cred small faint">The public history could not be read now; the credibility check is skipped.</div>;
  if (hidden === null) return null;
  if (hist.n === 0n)
    return (
      <div class="cred good">
        <div class="row between">
          <span style={{ fontWeight: 600 }}>Credibility of the duress view</span>
          <b>no history yet</b>
        </div>
        <p class="small" style={{ margin: "8px 0 0" }}>
          Nothing has been shielded into this account yet, so any hidden amount fits for now. Each shield is public and raises what a coercer expects to find.
        </p>
      </div>
    );
  const shown = hist.n > hidden ? hist.n - hidden : 0n;
  const c = decoyCredibility({ shieldedNet: Number(hist.n) / 1e6, decoy: Number(shown) / 1e6, hiddenPayments: hist.k });
  const adv = credibilityAdvice(c);
  return (
    <div class={`cred ${adv.level}`}>
      <div class="row between">
        <span style={{ fontWeight: 600 }}>Credibility of the duress view</span>
        <b>
          at most {Math.round(c * 100)}% · {adv.level}
        </b>
      </div>
      <div class="cred-bar">
        <i style={{ width: `${Math.max(3, Math.round(c * 100))}%` }} />
      </div>
      <p class="small" style={{ margin: "8px 0 0" }}>
        {adv.text}
      </p>
      <p class="small faint" style={{ margin: "6px 0 0" }}>
        From public data only: {fmtUsd(hist.n)} shielded into this account, {hist.k} private payment{hist.k === 1 ? "" : "s"} out since the last shield. Payments made since then make the duress view smaller and this figure lower. Off-chain clues are not counted.
      </p>
    </div>
  );
}

function DuressSheet({ ctx, account, walletBal, onClose, onSettled }: { ctx: Ctx; account: string; walletBal: bigint | null; onClose: () => void; onSettled: () => void }) {
  const [stage, setStage] = useState<"choose" | "pin" | "run" | "result">("choose");
  const [mode, setMode] = useState<"set" | "remove">("set");
  const [dpin, setDpin] = useState("");
  const [dpin2, setDpin2] = useState("");
  const [hidden, setHidden] = useState("1000");
  const [ver, setVer] = useState<number | null>(null);
  const [pin, setPin] = useState("");
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(DURESS_STEPS.length));
  const [t0, setT0] = useState(0);
  const [verified, setVerified] = useState(false);
  const [result, setResult] = useState<PinResult<string> | null>(null);
  const [delay, setDelay] = useState<number | null>(null);
  const info = useTryInfo(account);
  const offer = useRefundOffer(ctx, account, verified, !!info?.bond);
  useBeforeUnload(stage === "run");
  useEffect(() => {
    readPrivate(read, account).then(
      (i) => {
        setDelay(i.settingsDelay);
        setVer(i.version);
      },
      () => undefined,
    );
  }, [account]);

  const hiddenUnits = parseUsd(hidden);
  const oldBuild = ver !== null && ver < PRIVATE_MODE_VERSION;
  const c = checkPin(dpin);
  const err = mode === "remove" ? null : !dpin ? "" : !c.ok ? c.reason ?? "Choose another duress PIN." : dpin !== dpin2 ? (dpin2 ? "The two duress PINs don't match." : "") : !hiddenUnits ? "Enter the amount to keep hidden." : null;

  async function go(v: string) {
    if (mode === "set" && v === dpin) {
      setResult({ kind: "err", text: "The duress PIN must differ from your PIN." });
      setStage("result");
      setPin("");
      return;
    }
    setStage("run");
    setT0(Date.now());
    setVerified(false);
    setTasks(freshTasks(DURESS_STEPS.length));
    try {
      const h = await setDuressWithPin(ctx, account, v, mode === "set" ? { pin: dpin, hiddenUnits: hiddenUnits! } : null, taskCb(setTasks, 5, () => setVerified(true)), info?.bond?.required);
      setResult({ kind: "ok", value: h });
    } catch (e) {
      setResult(asPinFailure(e));
    } finally {
      setPin("");
      setDpin("");
      setDpin2("");
      setStage("result");
      onSettled();
    }
  }

  return (
    <Sheet title="Duress PIN" onClose={onClose} locked={stage === "run"}>
      {stage === "choose" && (
        <div class="stack">
          <p class="small muted" style={{ margin: 0 }}>
            A duress PIN <b>limits the loss</b> if someone forces you to open your account. Typed instead of your PIN, it works the same way, but on the balance minus the amount you keep hidden, as if that were the whole balance: the view shows it, a private send moves at most that, and deposits and payments show in it as they would in a real balance. On-chain both PINs look the same: nobody can tell which one was used, or whether a duress PIN is set. This page never stores it, so it can't show it either.
          </p>
          <div class="seg">
            <button type="button" class={`chip-btn ${mode === "set" ? "on" : ""}`} onClick={() => setMode("set")}>
              Set or replace
            </button>
            <button type="button" class={`chip-btn ${mode === "remove" ? "on" : ""}`} onClick={() => setMode("remove")}>
              Remove
            </button>
          </div>
          {mode === "set" ? (
            <>
              <div class="row wrap" style={{ gap: "10px" }}>
                <label class="field" style={{ flex: "1 1 120px" }}>
                  <span>Duress PIN</span>
                  <input class="input mono" type="password" inputMode="numeric" autoComplete="off" value={dpin} onInput={(e) => setDpin((e.target as HTMLInputElement).value.replace(/\D/g, ""))} />
                </label>
                <label class="field" style={{ flex: "1 1 120px" }}>
                  <span>Repeat it</span>
                  <input class="input mono" type="password" inputMode="numeric" autoComplete="off" value={dpin2} onInput={(e) => setDpin2((e.target as HTMLInputElement).value.replace(/\D/g, ""))} />
                </label>
              </div>
              <label class="field">
                <span>Keep hidden</span>
                <div class="input-wrap">
                  <input class="input" inputMode="decimal" value={hidden} onInput={(e) => setHidden((e.target as HTMLInputElement).value)} style={{ paddingRight: "72px" }} />
                  <div class="suffix">
                    <span class="small faint">cUSDC</span>
                  </div>
                </div>
                <span class="field-hint">A coercer sees and could take only what is above it. Your key alone can&apos;t move it either: only your real PIN can.</span>
              </label>
              <CredibilityMeter account={account} hidden={hiddenUnits} />
              {err && <p class="field-err">{err}</p>}
            </>
          ) : (
            <div class="notice">
              <IconInfo />
              <span>The duress slot gets random bits on-chain, exactly as when no duress PIN was ever set; the transaction looks like any other change.</span>
            </div>
          )}
          <div class="notice">
            <IconClock />
            <span>It takes effect after the settings delay{delay !== null ? ` (${fmtWait(delay)})` : ""}, once your PIN is checked.</span>
          </div>
          {oldBuild && (
            <div class="notice">
              <IconInfo />
              <span>This account runs the first private-mode build, where the duress PIN showed a fixed decoy amount. This app changes the duress PIN only on the current build.</span>
            </div>
          )}
          <button type="button" class="btn btn-primary btn-lg btn-block" disabled={oldBuild || (mode === "set" && err !== null)} onClick={() => setStage("pin")}>
            Continue
          </button>
        </div>
      )}
      {stage === "pin" && (
        <PinStage info={info} walletBal={walletBal} pin={pin} setPin={setPin} onGo={(v) => void go(v)} onBack={() => setStage("choose")} label="Confirm with PIN" prompt="Enter your PIN (not the duress PIN)" />
      )}
      {stage === "run" && <RunStage title="Checking your PIN" labels={DURESS_LABELS} tasks={tasks} t0={t0} offer={offer} />}
      {stage === "result" && result?.kind === "ok" && (
        <div class="result">
          <OkMark />
          <h3>Done</h3>
          <p>The change is on-chain. As always, the page does not keep whether a duress PIN is set.</p>
          <div class="facts-row">
            <TxLink hash={result.value} label="View transaction" />
          </div>
          <RefundNotice offer={offer} />
          <div class="flow-actions">
            <button type="button" class="btn btn-primary btn-lg" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
      {stage === "result" && result && result.kind !== "ok" && <FailResult r={result} bond={info?.bond ?? null} onClose={onClose} onRetry={() => setStage("choose")} />}
    </Sheet>
  );
}

// ── tripwire reset and test cUSDC ──

function PrivateResetSheet({ ctx, account, walletBal, onClose, onSettled }: { ctx: Ctx; account: string; walletBal: bigint | null; onClose: () => void; onSettled: () => void }) {
  const [stage, setStage] = useState<"pin" | "run" | "result">("pin");
  const [pin, setPin] = useState("");
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(RESET_STEPS.length));
  const [t0, setT0] = useState(0);
  const [verified, setVerified] = useState(false);
  const [result, setResult] = useState<PinResult<string> | null>(null);
  const info = useTryInfo(account);
  const offer = useRefundOffer(ctx, account, verified, !!info?.bond);
  useBeforeUnload(stage === "run");
  async function go(v: string) {
    setStage("run");
    setT0(Date.now());
    setVerified(false);
    setTasks(freshTasks(RESET_STEPS.length));
    try {
      setResult({ kind: "ok", value: await privateResetWithPin(ctx, account, v, taskCb(setTasks, 4, () => setVerified(true)), info?.bond?.required) });
    } catch (e) {
      setResult(asPinFailure(e));
    } finally {
      setPin("");
      setStage("result");
      onSettled();
    }
  }
  return (
    <Sheet title="Reset the tripwire" onClose={onClose} locked={stage === "run"}>
      {stage === "pin" && (
        <PinStage
          summary={
            <div class="notice info">
              <IconInfo />
              <span>The key-only counter restarts and a new random tripwire is drawn. If the watchtower restricted the account, lift that separately.</span>
            </div>
          }
          info={info}
          walletBal={walletBal}
          pin={pin}
          setPin={setPin}
          onGo={(v) => void go(v)}
          label="Reset with PIN"
        />
      )}
      {stage === "run" && <RunStage title="Checking your PIN" labels={RESET_LABELS} tasks={tasks} t0={t0} offer={offer} />}
      {stage === "result" && result?.kind === "ok" && (
        <div class="result">
          <OkMark />
          <h3>Tripwire reset</h3>
          <p>Key-only private sends work again, within the hidden limit.</p>
          <div class="facts-row">
            <TxLink hash={result.value} label="View transaction" />
          </div>
          <RefundNotice offer={offer} />
          <div class="flow-actions">
            <button type="button" class="btn btn-primary btn-lg" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
      {stage === "result" && result && result.kind !== "ok" && <FailResult r={result} bond={info?.bond ?? null} onClose={onClose} onRetry={() => setStage("pin")} />}
    </Sheet>
  );
}

function FaucetSheet({ ctx, account, onClose, onSettled }: { ctx: Ctx; account: string; onClose: () => void; onSettled: () => void }) {
  const [amt, setAmt] = useState("1000");
  const [state, setState] = useState<"idle" | "run" | "done" | "err">("idle");
  const [text, setText] = useState("");
  const [hash, setHash] = useState<string | null>(null);
  const units = parseUsd(amt);
  useBeforeUnload(state === "run");
  async function go() {
    if (!units) return;
    setState("run");
    try {
      setHash(await getTestCusdc(ctx, account, units, (t) => setText(t)));
      setState("done");
      onSettled();
    } catch (e) {
      setText(explainError(e));
      setState("err");
    }
  }
  return (
    <Sheet title="Get test cUSDC" onClose={onClose} locked={state === "run"}>
      <div class="stack">
        <p class="small muted" style={{ margin: 0 }}>
          Mints worthless test USDC to your wallet and wraps it into the account as cUSDC, Zama's confidential test token (3 transactions).
        </p>
        <label class="field">
          <span>Amount</span>
          <div class="input-wrap">
            <input class="input" inputMode="decimal" value={amt} disabled={state === "run"} onInput={(e) => setAmt((e.target as HTMLInputElement).value)} style={{ paddingRight: "72px" }} />
            <div class="suffix">
              <span class="small faint">cUSDC</span>
            </div>
          </div>
        </label>
        <div class="notice warn">
          <IconInfo />
          <span>
            <b>Wrapping is public:</b> the amount that goes in shows on-chain, and a coercer can read it. If you use a duress PIN, several smaller deposits over time make its view more believable than one big one.
          </span>
        </div>
        {state === "run" && <p class="small faint">{text}</p>}
        {state === "err" && <p class="field-err">{text}</p>}
        {state === "done" && hash ? (
          <div class="notice ok">
            <IconCheck />
            <span style={{ flex: 1 }}>{units ? fmtUsd(units) : "It"} went into the account, hidden from now on.</span>
            <TxLink hash={hash} />
          </div>
        ) : (
          <button type="button" class="btn btn-primary btn-lg btn-block" disabled={!units || state === "run"} onClick={() => void go()}>
            {state === "run" ? "Working…" : state === "err" ? "Try again" : "Get test cUSDC"}
          </button>
        )}
      </div>
    </Sheet>
  );
}

// ── standard accounts: private mode needs a new account ──

function PrivateModeOffer({ onCreate, onSwitch }: { onCreate: () => void; onSwitch: () => void }) {
  const ready = usePrivateReady();
  const deployed = ready === "yes";
  return (
    <section class="card card-pad">
      <h3 class="card-title">
        Private mode
        <span class="badge">optional</span>
      </h3>
      <p class="small muted" style={{ margin: 0 }}>
        A cUSDC balance nobody can read on-chain, viewed with your PIN; private sends; and an optional duress PIN that limits the loss under coercion.
      </p>
      <p class="small faint" style={{ margin: "10px 0 0" }}>
        This account was created without it, and an account can't be switched over in place: each one is a fixed copy of its contract, so nobody can change its code later. To use private mode, create a private-mode account, then come back here (Switch account) and send your ETH to it with your PIN.
      </p>
      <div class="row wrap" style={{ gap: "12px", marginTop: "14px", alignItems: "center" }}>
        <button type="button" class="btn btn-secondary btn-sm" disabled={!deployed} onClick={onCreate}>
          Create a private-mode account
        </button>
        <button type="button" class="link-btn" onClick={onSwitch}>
          Switch account
        </button>
      </div>
      {(ready === "no" || ready === "old") && (
        <p class="small faint" style={{ margin: "8px 0 0" }}>
          {PRIVATE_NOT_READY[ready]}
        </p>
      )}
    </section>
  );
}

function AccountsSheet({ ctx, current, onPick, onNew, onClose }: { ctx: Ctx; current: string; onPick: (a: string) => void; onNew: (priv: boolean) => void; onClose: () => void }) {
  const privateReady = usePrivateReady();
  const [rows, setRows] = useState<{ a: string; priv: boolean; armed: boolean; bal: bigint }[] | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const found = await retry(() => findAccounts(read, ctx.w.address));
      const out: { a: string; priv: boolean; armed: boolean; bal: bigint }[] = [];
      for (const a of [...found].reverse()) {
        try {
          const [v, pr] = await Promise.all([readAccount(read, a), isPrivateAccount(read, a)]);
          if (v.exists) out.push({ a, priv: pr, armed: v.armed, bal: v.balance });
        } catch {
          /* skip an unreadable one */
        }
      }
      if (live) setRows(out);
    })().catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [ctx.w.address]);
  return (
    <Sheet title="Your accounts" onClose={onClose}>
      {rows === null ? (
        <div class="empty">
          <span class="spinner" style={{ margin: "0 auto" }} />
        </div>
      ) : (
        <ul class="acct-list">
          {rows.map((r) => (
            <li>
              <div class="act-main">
                <div class="act-title mono">{short(r.a)}</div>
                <div class="act-sub">
                  {r.priv ? "Private mode" : "Standard"} · {fmtEth(r.bal)} ETH{r.armed ? "" : " · setup not finished"}
                </div>
              </div>
              {r.a.toLowerCase() === current.toLowerCase() ? (
                <span class="badge ok">Open now</span>
              ) : (
                <button type="button" class="btn btn-secondary btn-sm" disabled={!r.armed} onClick={() => onPick(r.a)}>
                  Open
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div class="flow-actions">
        <button type="button" class="btn btn-ghost" onClick={() => onNew(false)}>
          New standard account
        </button>
        {privateReady === "yes" && (
          <button type="button" class="btn btn-secondary" onClick={() => onNew(true)}>
            New private-mode account
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** Activity rows of a private-mode account: private ops carry no public amount, and PIN changes are named as such. */
function privateActivityMeta(a: Activity): { ico: () => any; cls: string; title: (a: Activity) => string; sub: (a: Activity) => string } | null {
  if (a.opKind !== 3 || (!isPrivateSub(a.sub) && a.sub !== SUB_PIN_CHANGE)) return null;
  const names: Record<number, [string, string]> = {
    [PRIVATE_SUB.transfer]: ["Private send", "amount hidden"],
    [PRIVATE_SUB.view]: ["Private balance viewed", "a snapshot only you can decrypt"],
    [PRIVATE_SUB.reset]: ["Tripwire reset", "key-only sends restart"],
    [PRIVATE_SUB.setDuress]: ["Duress setting changed", "set or removed: the chain can't tell which"],
    [SUB_PIN_CHANGE]: ["PIN changed", "the new fingerprint is encrypted"],
  };
  const [name, detail] = names[a.sub!];
  switch (a.kind) {
    case "sent":
      return { ico: a.sub === PRIVATE_SUB.view ? IconEye : IconCheck, cls: "ok", title: () => name, sub: () => `${detail} · PIN correct` };
    case "approved":
      return { ico: IconClock, cls: "warn", title: () => `${name} · waiting`, sub: () => (a.sub === PRIVATE_SUB.transfer ? "PIN correct · at least 72 hours" : "PIN correct · settings delay") };
    case "wrong":
      return { ico: IconX, cls: "bad", title: () => "Wrong PIN · nothing happened", sub: () => name.toLowerCase() };
    case "pending":
      return { ico: IconClock, cls: "warn", title: () => "PIN check not finished", sub: () => name.toLowerCase() };
    case "cancelled":
      return { ico: IconX, cls: "", title: () => `${name} cancelled`, sub: () => detail };
    default:
      return null;
  }
}


// ───────────────────────────── hidden will ─────────────────────────────

const WILL_LABELS = ["Open the call on-chain", "Encrypt your PIN guess", "Submit the encrypted guess", "Decrypt only the yes / no result", "Record the result on-chain", "Wait the delay, then set the heirs"];
const ALIVE_LABELS = ["Open a no-op call on-chain", "Encrypt your PIN guess", "Submit the encrypted guess", "Decrypt only the yes / no result", "Record the result on-chain"];
const FUND_UNITS = 1_000_000_000n; // 1,000 tcUSD (6 decimals)
const fmtTc = (units: bigint) => `${(Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} tcUSD`;
/** The in-app reminder starts 30 days before the will can start (as the watchtower's), or earlier in a short demo. */
const remindFrom = (v: WillView) => Math.min(30 * 86400, Math.round(v.inactivity * 0.4));

function phaseLine(v: WillView, nowS: number): string {
  switch (v.phase) {
    case 0:
      return "No heirs yet.";
    case 1:
      return `The owner is active. The will can start in ${fmtWait(Math.max(0, v.startableAt - nowS))} if no correct PIN comes first.`;
    case 2:
      return `No correct PIN for ${fmtWait(nowS - v.pinAt)}. Anyone can start the will.`;
    case 3:
      return `Started. A correct PIN within ${fmtWait(Math.max(0, v.settleableAt - nowS))} cancels it.`;
    case 4:
      return "The grace period is over. Anyone can settle the will.";
    default:
      return v.swept
        ? "Settled, and the claim window has closed."
        : "Settled. Heirs claim with their code or from their address; everyone else receives an encrypted zero.";
  }
}

/** Claims are open: settled, a payout round complete, the window not yet swept. */
const payoutReady = (v: WillView) => v.settled && v.round > 0 && !v.preparing && !v.swept;

function useWill(addr: string | null, every = 15000) {
  const [v, setV] = useState<WillView | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async () => {
    if (!addr) return;
    try {
      setV(await readWill(read, addr));
      setFailed(false);
    } catch {
      setFailed(true); // a transient RPC error keeps the last view; with none yet, say so instead of loading forever
    }
  }, [addr]);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), every);
    return () => clearInterval(id);
  }, [refresh]);
  return [v, refresh, failed] as const;
}

const WillUnreadable = () => (
  <p class="small muted">This will can't be read right now. If it was made with the first version of the demo, it uses an older contract that this page no longer reads.</p>
);

/**
 * The PIN path's step callbacks on a task list: a wrong PIN shows as a red cross, not as a failure. The last step
 * only starts after a correct PIN was recorded, so its start calls `onVerified` (the bond is claimable from then on).
 */
function taskCb(setTasks: (f: (prev: TaskState[]) => TaskState[]) => void, lastStep: number, onVerified?: () => void): StepCb {
  return (i, s, text, hash) => {
    if (onVerified && i === lastStep && s === "run") onVerified();
    setTasks((prev) =>
      prev.map((t, j) => {
        if (j !== i) return t;
        const wrong = /wrong/i.test(text ?? "");
        const state: TaskState["s"] = s === "run" ? "run" : s === "fail" ? "fail" : wrong || (s === "skip" && i === lastStep) ? "bad" : "done";
        return { s: state, text: s === "done" && !text ? undefined : text, hash: hash ?? t.hash };
      }),
    );
  };
}

type RefundOffer = { amount: bigint | null; state: "idle" | "run" | "done" | "err"; text: string; hash: string | null; claim: () => Promise<void> };

/**
 * After a correct key-track PIN (`verified`): the bond of that try is credited when the guess is finalized and can
 * go back to the wallet at once. The app offers it on its own; one click sends claimRefund (one wallet signature).
 * `enabled` is false on accounts from before F0.16 (no bonds).
 */
function useRefundOffer(ctx: Ctx, account: string, verified: boolean, enabled: boolean, onClaimed?: () => void): RefundOffer {
  const [amount, setAmount] = useState<bigint | null>(null);
  const [state, setState] = useState<RefundOffer["state"]>("idle");
  const [text, setText] = useState("");
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    if (!verified || !enabled) return;
    let live = true;
    // a load-balanced public RPC can still show the balance from before the finalize for a moment
    retry(async () => {
      const r = await readRefund(ctx.read, account, ctx.w.address);
      if (r === 0n) throw new Error("not credited yet");
      return r;
    }, 4).then(
      (r) => live && setAmount(r),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [verified, enabled, account, ctx.w.address]);
  async function claim() {
    setState("run");
    setText("");
    try {
      setHash(await claimRefund(ctx, account, (t) => setText(t)));
      setState("done");
      onClaimed?.();
    } catch (e) {
      setText(explainError(e));
      setState("err");
    }
  }
  return { amount, state, text, hash, claim };
}

function RefundNotice({ offer }: { offer: RefundOffer }) {
  if (!offer.amount) return null;
  if (offer.state === "done")
    return (
      <div class="notice ok refund-offer">
        <IconCheck />
        <span style={{ flex: 1 }}>
          Your bond of <b>{fmtEth(offer.amount)} ETH</b> is back in your wallet.
        </span>
        {offer.hash && <TxLink hash={offer.hash} />}
      </div>
    );
  return (
    <div class="notice info refund-offer">
      <IconInfo />
      <span style={{ flex: 1 }}>
        Correct PIN: your bond of <b>{fmtEth(offer.amount)} ETH</b> can go back to your wallet now.
        {offer.state === "err" && <span class="refund-err">{offer.text}</span>}
      </span>
      <button type="button" class="btn btn-secondary btn-sm" disabled={offer.state === "run"} onClick={() => void offer.claim()}>
        {offer.state === "run" ? offer.text || "Confirm in your wallet…" : offer.state === "err" ? "Try again" : "Get it back"}
      </button>
    </div>
  );
}

const OkIcon = () => (
  <div class="result-icon ok">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  </div>
);
const BadIcon = () => (
  <div class="result-icon bad">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  </div>
);

function WillCard({ ctx, account, notify }: { ctx: Ctx; account: string; notify: Notify }) {
  const [addr, setAddr] = useState<string | null>(null);
  const [v, refresh, failed] = useWill(addr);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | "heirs" | "alive">(null);
  const now = useNow(1000);
  const nowS = Math.floor(now / 1000);

  useEffect(() => {
    retry(() => predictWill(read, account)).then(setAddr, () => undefined);
  }, [account]);

  async function act(label: string, fn: (st: (t: string) => void) => Promise<unknown>, okText: string) {
    setBusy(label);
    try {
      await fn((t) => setBusy(t));
      notify(okText, "ok");
      await refresh();
    } catch (e) {
      notify(explainError(e), "err");
    } finally {
      setBusy(null);
    }
  }

  const left = v ? v.startableAt - nowS : 0;
  const soon = !!v && v.phase === 1 && left <= remindFrom(v);
  // the earliest moment heirs could be paid: a start as soon as allowed, then the whole grace period
  const earliest = !v ? 0 : v.phase === 3 || v.phase === 4 ? v.settleableAt : Math.max(v.startableAt, nowS) + v.grace;

  return (
    <section class="card card-pad will-card">
      <h3 class="card-title">
        Hidden will
        <span class="badge">Demo · 5 min</span>
      </h3>
      {!v ? (
        failed ? <WillUnreadable /> : <p class="small faint">Loading…</p>
      ) : !v.exists ? (
        <>
          <p class="small muted">
            Leave test tokens to up to four heirs, each named by a secret claim code or by an address. Heirs, codes and shares are encrypted, even from you. If the account sees no correct PIN for 5 minutes (months, in real use), anyone can start
            the will; a correct PIN in the next 5 minutes cancels it.
          </p>
          <button type="button" class="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void act("Creating…", (st) => createWill(ctx, account, st), "Your will is created.")}>
            {busy ?? "Create a will"}
          </button>
        </>
      ) : (
        <>
          {v.phase === 3 && (
            <div class="notice err will-alert">
              <IconClock />
              <span>
                <b>Your will has started.</b> Enter your PIN within {fmtWait(Math.max(0, v.settleableAt - nowS))} to cancel it.
              </span>
            </div>
          )}
          {v.phase === 2 && (
            <div class="notice warn will-alert">
              <IconClock />
              <span>
                <b>You have been away long enough</b> for anyone to start your will. A correct PIN resets the clock.
              </span>
            </div>
          )}
          {soon && (
            <div class="notice info will-alert">
              <IconInfo />
              <span>Your will can start in {fmtWait(Math.max(0, left))}. A correct PIN pushes that back.</span>
            </div>
          )}
          {v.escapeAlive && (
            <div class="notice warn will-alert">
              <IconShield />
              <span>
                <b>Your account's escape is running.</b> The will can follow it to your escape address.
              </span>
            </div>
          )}
          <ul class="prot">
            <li>
              <span class={`check ${v.heirsSet ? "" : "off"}`}>{v.heirsSet ? <IconCheck /> : <IconClock />}</span>
              <span class="k">
                Heirs<small>{v.heirsSet ? "Set and encrypted: nobody can read them" : "Not set yet"}</small>
              </span>
              <span class="v">{v.heirsSet ? "Set" : "—"}</span>
            </li>
            <li>
              <span class={`check ${v.balanceKnown ? "" : "off"}`}>{v.balanceKnown ? <IconCheck /> : <IconClock />}</span>
              <span class="k">
                Test tokens<small>{v.balanceKnown ? "The will holds an encrypted tcUSD balance" : "Empty"}</small>
              </span>
              <span class="v">{v.balanceKnown ? "Funded" : "—"}</span>
            </li>
            <li>
              <span class="check">
                <IconClock />
              </span>
              <span class="k">
                Last correct PIN
                <small>
                  {v.pinAt ? timeAgo(v.pinAt) : "never"}
                  {v.heirsSet && !v.settled ? ` · inheritance at the earliest ${earliest <= nowS ? "now" : `in ${fmtWait(earliest - nowS)}`}` : ""}
                </small>
              </span>
              <span class="v">{PHASE_TEXT[v.phase].split(":")[0]}</span>
            </li>
          </ul>
          <p class="small muted will-phase">{phaseLine(v, nowS)}</p>
          <div class="row wrap will-actions">
            {!v.settled && v.heirsSet && (
              <button type="button" class={`btn btn-sm ${v.phase >= 2 ? "btn-primary" : "btn-secondary"}`} disabled={!!busy} onClick={() => setSheet("alive")}>
                I'm here
              </button>
            )}
            {!v.settled && (
              <button type="button" class="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => setSheet("heirs")}>
                {v.heirsSet ? "Change heirs" : "Set heirs"}
              </button>
            )}
            {!v.swept && (
              <button type="button" class="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void act("Minting…", (st) => fundWill(ctx, v.address, FUND_UNITS, st), "1,000 test tokens added to the will.")}>
                Add 1,000 tcUSD
              </button>
            )}
            {v.phase === 2 && (
              <button type="button" class="btn btn-secondary btn-sm" disabled={!!busy} title="Anyone can start it; in the demo you can too." onClick={() => void act("Starting…", (st) => startWill(ctx, v.address, st), "Started.")}>
                Start the will
              </button>
            )}
            {v.phase === 4 && (
              <button
                type="button"
                class="btn btn-primary btn-sm"
                disabled={!!busy}
                onClick={() =>
                  void act(
                    "Settling…",
                    async (st) => {
                      await settleWill(ctx, v.address, st);
                      await runPayoutRound(ctx, v.address, st);
                    },
                    "Settled, and the payout is ready.",
                  )
                }
              >
                Settle and prepare the payout
              </button>
            )}
            {v.settled && (
              <a class="btn btn-primary btn-sm" href={willUrl(v.address)}>
                Open the claim page
              </a>
            )}
            {v.escapeAlive && (
              <button type="button" class="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void act("Moving…", (st) => escapeWithdrawWill(ctx, v.address, st), "The will followed your escape.")}>
                Move to the escape address
              </button>
            )}
            <button type="button" class="link-btn" onClick={() => copy(willUrl(v.address), notify, "Will link")}>
              Copy the will link
            </button>
          </div>
          {busy && <p class="small faint">{busy}</p>}
        </>
      )}
      {sheet === "heirs" && v && <WillSheet ctx={ctx} account={account} willAddr={v.address} replacing={v.heirsSet} onClose={() => setSheet(null)} onSettled={() => void refresh()} />}
      {sheet === "alive" && <AliveSheet ctx={ctx} account={account} onClose={() => setSheet(null)} onSettled={() => void refresh()} />}
    </section>
  );
}

type RowState = { mode: "code" | "address"; address: string; percent: string };
type WillResult = { kind: "ok"; hash: string; heirs: NewHeir[] } | { kind: "wrong"; score: number; next: number } | { kind: "err"; text: string };

function WillSheet({ ctx, account, willAddr, replacing, onClose, onSettled }: { ctx: Ctx; account: string; willAddr: string; replacing: boolean; onClose: () => void; onSettled: () => void }) {
  const [stage, setStage] = useState<"heirs" | "pin" | "run" | "result">("heirs");
  const [rows, setRows] = useState<RowState[]>([
    { mode: "code", address: "", percent: "60" },
    { mode: "code", address: "", percent: "40" },
  ]);
  const [pin, setPin] = useState("");
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(CALL_STEPS.length));
  const [result, setResult] = useState<WillResult | null>(null);
  const [cards, setCards] = useState(false);
  const info = useTryInfo(account);
  const [verified, setVerified] = useState(false);
  const offer = useRefundOffer(ctx, account, verified, !!info?.bond, onSettled);
  const [t0, setT0] = useState(0);
  const now = useNow(1000);

  const used = (r: RowState) => r.percent.trim() !== "" || (r.mode === "address" && r.address.trim() !== "");
  const filled = rows.filter(used);
  const rowErr = (r: RowState) => {
    if (!used(r)) return null;
    if (r.mode === "address") {
      const a = r.address.trim();
      if (!ethers.isAddress(a)) return "Enter a valid address.";
      if (a.toLowerCase() === account.toLowerCase() || a.toLowerCase() === willAddr.toLowerCase()) return "Not the account or the will itself.";
    }
    const p = Number(r.percent);
    if (!(p > 0 && p <= 100)) return "Share between 0 and 100 %.";
    return null;
  };
  const total = filled.reduce((s, r) => s + (Number(r.percent) || 0), 0);
  const valid = filled.length > 0 && filled.every((r) => !rowErr(r)) && total <= 100 + 1e-9;
  const heirRows: HeirRow[] = filled.map((r) => ({ mode: r.mode, address: r.address.trim(), percent: Number(r.percent) }));
  const setRow = (i: number, patch: Partial<RowState>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function go(p = pin) {
    if (p.length < 6 || !valid) return;
    setStage("run");
    setT0(Date.now());
    setResult(null);
    setVerified(false);
    setTasks(freshTasks(CALL_STEPS.length));
    try {
      const r = await setHeirsWithPin(ctx, account, willAddr, heirRows, p, taskCb(setTasks, 5, () => setVerified(true)), info?.bond?.required);
      setResult({ kind: "ok", hash: r.hash, heirs: r.heirs });
    } catch (e) {
      if (e instanceof WrongPin) setResult({ kind: "wrong", score: e.score, next: e.nextAllowedAt });
      else setResult({ kind: "err", text: explainError(e) });
    } finally {
      setPin("");
      setStage("result");
      onSettled();
    }
  }

  const done = tasks.filter((t) => t.s === "done" || t.s === "bad").length;
  const current = tasks.findIndex((t) => t.s === "run");
  const codeHeirs = result?.kind === "ok" ? result.heirs.filter((h) => h.mode === "code" && h.code !== undefined) : [];

  return (
    <Sheet title={stage === "result" ? "Result" : "Heirs of your will"} onClose={onClose} locked={stage === "run" || codeHeirs.length > 0}>
      {stage === "heirs" && (
        <div class="stack">
          <p class="small muted">
            Up to four heirs. <b>By code</b> (recommended): the heir claims with a secret code, to any address, even a new one, so nobody can tell heirs apart from anyone else who claims. <b>By address</b>: the heir claims from that address and is paid there.
          </p>
          {rows.map((r, i) => (
            <div class="heir-row">
              <div class="mode-toggle" role="group" aria-label={`How heir ${i + 1} claims`}>
                <button type="button" class={r.mode === "code" ? "on" : ""} aria-pressed={r.mode === "code"} onClick={() => setRow(i, { mode: "code" })}>
                  Code
                </button>
                <button type="button" class={r.mode === "address" ? "on" : ""} aria-pressed={r.mode === "address"} onClick={() => setRow(i, { mode: "address" })}>
                  Address
                </button>
              </div>
              {r.mode === "address" ? (
                <input class="input mono" placeholder="0x… heir address" value={r.address} spellcheck={false} autoComplete="off" onInput={(e) => setRow(i, { address: (e.target as HTMLInputElement).value })} />
              ) : (
                <span class="small faint heir-codehint">A secret code, made in your browser</span>
              )}
              <div class="input-wrap heir-pct">
                <input class="input" inputMode="decimal" aria-label={`Share of heir ${i + 1}`} value={r.percent} onInput={(e) => setRow(i, { percent: (e.target as HTMLInputElement).value })} />
                <div class="suffix">
                  <span class="small faint">%</span>
                </div>
              </div>
              {rowErr(r) && <span class="field-err heir-err">{rowErr(r)}</span>}
            </div>
          ))}
          <div class="chips">
            {rows.length < 4 && (
              <button type="button" class="chip-btn" onClick={() => setRows([...rows, { mode: "code", address: "", percent: "" }])}>
                + Add an heir
              </button>
            )}
            <button type="button" class="chip-btn" onClick={() => setRow(rows.length - 1, { mode: "address", address: ctx.w.address })}>
              My wallet as heir {rows.length} · {short(ctx.w.address)}
            </button>
          </div>
          <span class={`field-hint ${total > 100 ? "field-err" : ""}`}>
            Total: {Math.round(total * 100) / 100} %{total < 100 && filled.length ? " · the rest goes to the first heir" : ""}
          </span>
          <div class="notice info">
            <IconLock />
            <span>
              Changing the heirs <b>needs your PIN</b> and the account's waiting period: the key alone can't touch the will. Everything is encrypted in your browser; nobody can read it afterwards, including you.
              {replacing ? " New heirs get new codes: old heir cards stop working." : ""}
            </span>
          </div>
          <button type="button" class="btn btn-primary btn-lg btn-block" disabled={!valid} onClick={() => setStage("pin")}>
            Continue
          </button>
        </div>
      )}

      {stage === "pin" && (
        <div>
          <div class="sum">
            <b>
              {heirRows.length} heir{heirRows.length === 1 ? "" : "s"}
            </b>
            <span class="faint">·</span>
            <span>
              {heirRows.filter((h) => h.mode === "code").length} by code, {heirRows.filter((h) => h.mode === "address").length} by address
            </span>
          </div>
          <TryCost info={info} />
          <p class="center muted" style={{ margin: "18px 0 6px", fontSize: "15px" }}>
            Enter your PIN
          </p>
          <PinPad value={pin} onChange={setPin} onEnter={(x) => !!info && void go(x)} />
          <div class="flow-actions">
            <button type="button" class="btn btn-ghost" onClick={() => setStage("heirs")}>
              Back
            </button>
            <button type="button" class="btn btn-primary" disabled={pin.length < 6 || !info} onClick={() => void go()}>
              Set heirs
            </button>
          </div>
        </div>
      )}

      {stage === "run" && (
        <div>
          <div class="progress-head">
            <Ring done={done} total={CALL_STEPS.length} />
            <div>
              <div class="progress-title">Setting your heirs</div>
              <div class="progress-sub">{current >= 0 ? WILL_LABELS[current] : "Preparing…"}</div>
              <div class="timer">{mmss(now - t0)}</div>
            </div>
          </div>
          <ul class="tasks">
            {tasks.map((t, i) => (
              <Task label={WILL_LABELS[i]} t={t} extra={t.s === "run" && (i === 1 || i === 3) ? <Cipher n={12} /> : undefined} />
            ))}
          </ul>
          <div class="notice" style={{ marginTop: "14px" }}>
            <IconInfo />
            <span>Up to 4 wallet confirmations, then the account's 1-minute waiting period.</span>
          </div>
          <RefundNotice offer={offer} />
        </div>
      )}

      {stage === "result" && result && (
        <div class="result">
          {result.kind === "ok" ? (
            <>
              <OkIcon />
              <h3>Heirs set</h3>
              {codeHeirs.length ? (
                <>
                  <div class="notice warn codes-warn">
                    <IconLock />
                    <span>
                      <b>These codes are shown only now.</b> Each one is like a seed phrase: whoever holds it can claim. Print the heir cards and keep them with your will papers.
                    </span>
                  </div>
                  <ul class="codes-list">
                    {codeHeirs.map((h) => (
                      <li>
                        <span class="small faint">
                          Heir {h.slot + 1} · {h.percent} %
                        </span>
                        <code>{formatCode(h.code!)}</code>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>They are stored encrypted. From now on, every correct PIN on your account shows you are still here.</p>
              )}
              <div class="facts-row">
                <TxLink hash={result.hash} label="View transaction" />
              </div>
              <RefundNotice offer={offer} />
              <div class="flow-actions">
                {codeHeirs.length > 0 && (
                  <button type="button" class="btn btn-secondary btn-lg" onClick={() => setCards(true)}>
                    Heir cards
                  </button>
                )}
                <button type="button" class="btn btn-primary btn-lg" onClick={onClose}>
                  {codeHeirs.length ? "I saved them" : "Done"}
                </button>
              </div>
              {cards && <HeirCards willAddr={willAddr} heirs={codeHeirs} onClose={() => setCards(false)} />}
            </>
          ) : (
            <>
              <BadIcon />
              <h3>{result.kind === "wrong" ? "Wrong PIN. Nothing changed." : "That didn't go through"}</h3>
              <p>{result.kind === "wrong" ? `The attempt was counted on-chain. Wrong guesses so far: ${result.score}.` : result.text}</p>
              <div class="flow-actions">
                <button type="button" class="btn btn-secondary" onClick={onClose}>
                  Close
                </button>
                <button type="button" class="btn btn-primary" onClick={() => setStage("pin")}>
                  Try again
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

/**
 * Renders its children into a layer at the end of <body>, outside the app's tree, so printing can hide the app and keep
 * only this layer.
 */
function PrintLayer({ children }: { children: ComponentChildren }) {
  const host = useMemo(() => {
    const d = document.createElement("div");
    d.className = "print-layer";
    return d;
  }, []);
  useEffect(() => {
    document.body.appendChild(host);
    document.body.classList.add("printing-layer");
    return () => {
      render(null, host);
      host.remove();
      document.body.classList.remove("printing-layer");
    };
  }, []);
  useEffect(() => {
    render(<>{children}</>, host);
  });
  return null;
}

/** Printable heir cards: the will, the network, the code, a QR code of the claim link (the code in its fragment), the steps. */
function HeirCards({ willAddr, heirs, onClose }: { willAddr: string; heirs: NewHeir[]; onClose: () => void }) {
  const qr = (text: string) => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <PrintLayer>
      <div class="heir-cards" role="dialog" aria-modal="true" aria-label="Heir cards">
        <div class="heir-cards-bar">
          <span>
            {heirs.length} heir card{heirs.length === 1 ? "" : "s"}: print them, or write the codes down
          </span>
          <div class="row">
            <button type="button" class="btn btn-primary btn-sm" onClick={() => window.print()}>
              Print
            </button>
            <button type="button" class="btn btn-secondary btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        {heirs.map((h) => (
          <article class="heir-card">
            <header>
              <b>Inheritance claim card</b>
              <span>Encrypted Account · hidden will</span>
            </header>
            <div class="heir-card-body">
              <div class="heir-card-qr" dangerouslySetInnerHTML={{ __html: qr(heirCardUrl(willAddr, h.code!)) }} />
              <dl>
                <dt>Heir</dt>
                <dd>
                  {h.slot + 1} of this will · {h.percent} %
                </dd>
                <dt>Will</dt>
                <dd class="mono">{willAddr}</dd>
                <dt>Network</dt>
                <dd>Ethereum Sepolia (a testnet demo)</dd>
                <dt>Claim code</dt>
                <dd class="mono heir-card-code">{formatCode(h.code!)}</dd>
              </dl>
            </div>
            <ol>
              <li>Scan the QR code, or open {location.host}/app?will= followed by the will address above.</li>
              <li>Connect any wallet. Enter the claim code and an address to receive the tokens; a fresh one keeps the claim private.</li>
              <li>Once the will is settled, claim. Then open the page with the receiving wallet to see the amount.</li>
            </ol>
            <p class="heir-card-warn">This code is like a seed phrase: whoever holds it can claim.</p>
          </article>
        ))}
      </div>
    </PrintLayer>
  );
}

function AliveSheet({ ctx, account, onClose, onSettled }: { ctx: Ctx; account: string; onClose: () => void; onSettled: () => void }) {
  const [stage, setStage] = useState<"pin" | "run" | "result">("pin");
  const info = useTryInfo(account);
  const [pin, setPin] = useState("");
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(ALIVE_STEPS.length));
  const [result, setResult] = useState<WillResult | null>(null);
  const [t0, setT0] = useState(0);
  const offer = useRefundOffer(ctx, account, result?.kind === "ok", !!info?.bond, onSettled);
  const now = useNow(1000);

  async function go(p = pin) {
    if (p.length < 6) return;
    setStage("run");
    setT0(Date.now());
    setResult(null);
    setTasks(freshTasks(ALIVE_STEPS.length));
    try {
      setResult({ kind: "ok", hash: await proveAliveWithPin(ctx, account, p, taskCb(setTasks, -1), info?.bond?.required), heirs: [] });
    } catch (e) {
      if (e instanceof WrongPin) setResult({ kind: "wrong", score: e.score, next: e.nextAllowedAt });
      else setResult({ kind: "err", text: explainError(e) });
    } finally {
      setPin("");
      setStage("result");
      onSettled();
    }
  }

  const done = tasks.filter((t) => t.s === "done" || t.s === "bad").length;
  const current = tasks.findIndex((t) => t.s === "run");
  return (
    <Sheet title="I'm here" onClose={onClose} locked={stage === "run"}>
      {stage === "pin" && (
        <div>
          <p class="center muted" style={{ margin: "4px 0 6px", fontSize: "15px" }}>
            A correct PIN resets your will's clock. Nothing moves.
          </p>
          <TryCost info={info} />
          <PinPad value={pin} onChange={setPin} onEnter={(x) => !!info && void go(x)} />
          <div class="flow-actions">
            <button type="button" class="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" class="btn btn-primary" disabled={pin.length < 6 || !info} onClick={() => void go()}>
              Confirm
            </button>
          </div>
        </div>
      )}
      {stage === "run" && (
        <div>
          <div class="progress-head">
            <Ring done={done} total={ALIVE_STEPS.length} />
            <div>
              <div class="progress-title">Checking your PIN</div>
              <div class="progress-sub">{current >= 0 ? ALIVE_LABELS[current] : "Preparing…"}</div>
              <div class="timer">{mmss(now - t0)}</div>
            </div>
          </div>
          <ul class="tasks">
            {tasks.map((t, i) => (
              <Task label={ALIVE_LABELS[i]} t={t} extra={t.s === "run" && (i === 1 || i === 3) ? <Cipher n={12} /> : undefined} />
            ))}
          </ul>
        </div>
      )}
      {stage === "result" && result && (
        <div class="result">
          {result.kind === "ok" ? <OkIcon /> : <BadIcon />}
          <h3>{result.kind === "ok" ? "Clock reset" : result.kind === "wrong" ? "Wrong PIN" : "That didn't go through"}</h3>
          <p>
            {result.kind === "ok"
              ? "The will's inactivity period starts again from now, and a will that had started is cancelled."
              : result.kind === "wrong"
                ? `Nothing changed. Wrong guesses so far: ${result.score}.`
                : result.text}
          </p>
          {result.kind === "ok" && (
            <div class="facts-row">
              <TxLink hash={result.hash} label="View transaction" />
            </div>
          )}
          {result.kind === "ok" && <RefundNotice offer={offer} />}
          <div class="flow-actions">
            <button type="button" class="btn btn-primary btn-lg" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function ClaimView({ ctx, willAddr, initialCode, notify }: { ctx: Ctx; willAddr: string; initialCode: string; notify: Notify }) {
  const [v, refresh, failed] = useWill(willAddr, 10000);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<"code" | "address">("code");
  const [codeText, setCodeText] = useState(initialCode);
  const [recipient, setRecipient] = useState("");
  const [claimed, setClaimed] = useState<{ hash: string; to: string } | null>(null);
  const [revealed, setRevealed] = useState<bigint | null>(null);
  const [staleHandle, setStaleHandle] = useState<string | undefined>(undefined);
  const now = useNow(1000);
  const nowS = Math.floor(now / 1000);
  const code = parseCode(codeText);
  // An heir named by address is paid only in a claim to its own address: there the recipient is the wallet itself.
  const to = mode === "address" ? ctx.w.address : recipient.trim() || ctx.w.address;
  const toOk = ethers.isAddress(to);

  async function act(label: string, fn: (st: (t: string) => void) => Promise<unknown>, okText: string) {
    setBusy(label);
    try {
      await fn((t) => setBusy(t));
      notify(okText, "ok");
      await refresh();
    } catch (e) {
      notify(explainError(e), "err");
    } finally {
      setBusy(null);
    }
  }

  async function doClaim() {
    setBusy("Claiming…");
    try {
      const recipientAddr = ethers.getAddress(to);
      const toSelf = recipientAddr.toLowerCase() === ctx.w.address.toLowerCase();
      const before = toSelf ? await tokenBalanceHandle(ctx.read, recipientAddr).catch(() => undefined) : undefined;
      const h = await claimWill(ctx, willAddr, recipientAddr, mode === "code" ? code : null, (t) => setBusy(t));
      setClaimed({ hash: h, to: recipientAddr });
      if (toSelf) setStaleHandle(before);
      setRevealed(null);
      notify("Claimed.", "ok");
    } catch (e) {
      notify(explainError(e), "err");
    } finally {
      setBusy(null);
    }
  }

  async function reveal() {
    setBusy("Preparing…");
    try {
      setRevealed(await decryptMyBalance(ctx, (t) => setBusy(t), staleHandle));
    } catch (e) {
      notify(explainError(e), "err");
    } finally {
      setBusy(null);
    }
  }

  const settleAndPrepare = async (st: (t: string) => void) => {
    await settleWill(ctx, willAddr, st);
    await runPayoutRound(ctx, willAddr, st);
  };

  return (
    <div class="claim">
      <section class="card card-pad">
        <div class="acct-row">
          <span class="acct-name">Hidden will</span>
          <AddrChip a={willAddr} notify={notify} />
        </div>
        {!v ? (
          failed ? <WillUnreadable /> : <p class="small faint">Loading…</p>
        ) : !v.exists ? (
          <p class="muted">There is no will at this address on Sepolia.</p>
        ) : (
          <>
            <h2 class="claim-phase">{PHASE_TEXT[v.phase]}</h2>
            <p class="muted">{phaseLine(v, nowS)}</p>
            <ul class="prot">
              <li>
                <span class="check">
                  <IconShield />
                </span>
                <span class="k">
                  Belongs to<small class="mono">{short(v.account)}</small>
                </span>
                <span class="v">Encrypted Account</span>
              </li>
              <li>
                <span class="check">
                  <IconClock />
                </span>
                <span class="k">
                  Last correct PIN<small>{v.pinAt ? timeAgo(v.pinAt) : "never"}</small>
                </span>
                <span class="v">{fmtWait(v.inactivity)} rule</span>
              </li>
              {v.settled && (
                <li>
                  <span class="check">
                    <IconClock />
                  </span>
                  <span class="k">
                    Claim window
                    <small>{v.swept ? "Closed: the rest went to the owner's escape address" : `Open until ${new Date(v.sweepableAt * 1000).toLocaleString()}`}</small>
                  </span>
                  <span class="v">{v.round ? `Round ${v.round}${v.preparing ? " · open" : ""}` : "No round yet"}</span>
                </li>
              )}
            </ul>

            <div class="row wrap will-actions">
              {v.phase === 2 && (
                <button type="button" class="btn btn-primary" disabled={!!busy} onClick={() => void act("Starting…", (st) => startWill(ctx, willAddr, st), "Started.")}>
                  Start the will
                </button>
              )}
              {v.phase === 4 && (
                <button type="button" class="btn btn-primary" disabled={!!busy} onClick={() => void act("Settling…", settleAndPrepare, "Settled, and the payout is ready.")}>
                  Settle and prepare the payout
                </button>
              )}
              {v.settled && !v.swept && (v.round === 0 || v.preparing) && (
                <button type="button" class="btn btn-primary" disabled={!!busy} onClick={() => void act("Preparing…", (st) => runPayoutRound(ctx, willAddr, st), "The payout is ready.")}>
                  Prepare the payout
                </button>
              )}
              {v.escapeAlive && (
                <button type="button" class="btn btn-secondary" disabled={!!busy} onClick={() => void act("Moving…", (st) => escapeWithdrawWill(ctx, willAddr, st), "The will followed the owner's escape.")}>
                  Move to the owner's escape address
                </button>
              )}
              {v.settled && !v.swept && v.sweepableAt > 0 && nowS >= v.sweepableAt && (
                <button type="button" class="btn btn-secondary" disabled={!!busy} onClick={() => void act("Closing…", (st) => sweepWill(ctx, willAddr, st), "The rest went to the owner's escape address.")}>
                  Close the claim window
                </button>
              )}
            </div>

            {payoutReady(v) && (
              <div class="claim-form">
                <div class="mode-toggle wide" role="group" aria-label="How you claim">
                  <button type="button" class={mode === "code" ? "on" : ""} aria-pressed={mode === "code"} onClick={() => setMode("code")}>
                    I have a claim code
                  </button>
                  <button type="button" class={mode === "address" ? "on" : ""} aria-pressed={mode === "address"} onClick={() => setMode("address")}>
                    I'm named by my address
                  </button>
                </div>
                {mode === "code" && (
                  <label class="field">
                    <span>Claim code</span>
                    <input class="input mono" placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx" value={codeText} spellcheck={false} autoComplete="off" onInput={(e) => setCodeText((e.target as HTMLInputElement).value)} />
                    {codeText.trim() !== "" && !code && <span class="field-err">A claim code has 32 hexadecimal digits.</span>}
                  </label>
                )}
                {mode === "code" ? (
                  <label class="field">
                    <span>Send to</span>
                    <input class="input mono" placeholder={`${short(ctx.w.address)} (this wallet) or any address`} value={recipient} spellcheck={false} autoComplete="off" onInput={(e) => setRecipient((e.target as HTMLInputElement).value)} />
                    {toOk ? (
                      <span class="field-hint">Any address you control; a fresh one keeps the claim unlinkable to you. The claim is bound to it: nobody can redirect it.</span>
                    ) : (
                      <span class="field-err">Enter a valid address.</span>
                    )}
                  </label>
                ) : (
                  <div class="field">
                    <span>Paid to</span>
                    <div class="input mono input-static">{ctx.w.address}</div>
                    <span class="field-hint">An heir named by address claims from that address, and its share is paid to that same address: connect the wallet the owner named.</span>
                  </div>
                )}
                <button type="button" class="btn btn-primary btn-lg btn-block" disabled={!!busy || !toOk || (mode === "code" && !code)} onClick={() => void doClaim()}>
                  Claim
                </button>
                <p class="small faint">You send the claim from the wallet connected here, and it pays the gas. Heirs receive their encrypted share, everyone else an encrypted zero.</p>
                <button type="button" class="link-btn" disabled={!!busy} onClick={() => void act("Preparing…", (st) => runPayoutRound(ctx, willAddr, st), "A new round is ready.")}>
                  Tokens arrived after the payout? Prepare a new round
                </button>
              </div>
            )}
            {busy && <p class="small faint">{busy}</p>}
            {claimed && (
              <div class="notice ok">
                <IconCheck />
                <span>
                  Claimed to {short(claimed.to)}. If the code or the address belongs to an heir, the share arrived there, encrypted; otherwise an encrypted zero did. Nobody watching the chain can tell which.{" "}
                  <TxLink hash={claimed.hash} label="Transaction" />
                </span>
              </div>
            )}
            {v.settled && (
              <div class="row wrap will-actions">
                <button type="button" class="btn btn-secondary" disabled={!!busy} onClick={() => void reveal()}>
                  Reveal this wallet's tcUSD balance
                </button>
              </div>
            )}
            {revealed !== null && (
              <div class="claim-reveal">
                <span class="small faint">The tcUSD balance of {short(ctx.w.address)}, decrypted only for you</span>
                <b>{fmtTc(revealed)}</b>
                <span class="small muted">
                  {revealed > 0n
                    ? "That's what this wallet holds of the test token."
                    : claimed && claimed.to.toLowerCase() !== ctx.w.address.toLowerCase()
                      ? "You sent the claim to another address: open this page with that wallet to see it."
                      : "Zero: nothing for this wallet, or no claim yet."}
                </span>
              </div>
            )}
          </>
        )}
      </section>
      <p class="small faint center">
        Anyone can claim: heirs receive their encrypted share, everyone else an encrypted zero. <a href="/app">Open my account instead</a>
      </p>
    </div>
  );
}

// ───────────────────────────── app ─────────────────────────────

async function pickAccount(owner: string): Promise<string | null> {
  const cached = store.get(accountKey(owner));
  if (cached) {
    try {
      const v = await readAccount(read, cached);
      if (v.exists && v.armed) return cached;
    } catch {
      /* fall back to the factory logs */
    }
  }
  const found = await findAccounts(read, owner);
  for (const a of [...found].reverse()) {
    const v = await readAccount(read, a);
    if (v.exists && v.armed) {
      store.set(accountKey(owner), a);
      return a;
    }
  }
  return null;
}

// ───────────────────────────── two devices: the key here, the PIN on the phone ─────────────────────────────

const qrSvg = (text: string) => {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
};

const ADMIN_NAMES: Record<number, string> = {
  1: "Cancel an operation",
  2: "Lift a restriction",
  4: "Replace the account key",
  5: "Change the PIN",
  6: "Change the hidden limits",
  10: "Change the watchtower",
  11: "Change the second device",
  12: "Change the recovery helper",
  13: "Change the escape address",
  14: "Change the PIN pulse",
  15: "Turn seedless recovery on or off",
  16: "Turn auto-known on or off",
  17: "Approve a signature",
  18: "Change the instant budget",
  19: "Cancel the escape",
  21: "Change the PIN-try bond",
  22: "Private send (amount hidden)",
  23: "View the private balance",
  24: "Reset the private tripwire",
  25: "Change the duress setting",
  26: "Lift the watchtower's pause",
  27: "Turn the two-device setting off",
};

/** One line that says what an op does, as the phone shows it before the PIN (from the chain, not from the computer). */
function describeOp(op: PhoneOp): string {
  if (op.kind === 1) {
    if (op.sub === 0) return `Send ${fmtEth(op.amount)} ETH to ${op.to}`;
    if (op.sub === 1) return `Send ${op.amount.toString()} base units of token ${op.target} to ${op.to}`;
    return `Let ${op.to} spend ${op.amount.toString()} base units of token ${op.target}`;
  }
  if (op.kind === 2) return `Call ${op.target}${op.amount > 0n ? ` with ${fmtEth(op.amount)} ETH` : ""}`;
  if (op.kind === 3) {
    const name = ADMIN_NAMES[op.sub] ?? `Account setting #${op.sub}`;
    if (op.sub === 22) {
      try {
        return `${name} to ${ethers.AbiCoder.defaultAbiCoder().decode(["address"], op.data)[0]}`;
      } catch {
        return name;
      }
    }
    if (op.sub === 11 || op.sub === 4) {
      try {
        return `${name} to ${ethers.AbiCoder.defaultAbiCoder().decode(["address"], op.data)[0]}`;
      } catch {
        return name;
      }
    }
    return name;
  }
  if (op.kind === 4) return `Recover the account to a new key ${op.to}`;
  return "An account operation";
}

/** The phone's page (#pair= or #approve=): no wallet; the device key and the PIN stay in this browser. */
function PhoneView({ link, fhe, notify }: { link: PhoneLink; fhe: Fhe; notify: Notify }) {
  return link.kind === "pair" ? <PhonePair account={link.account} notify={notify} /> : <PhoneApprove account={link.account} opId={link.opId} fhe={fhe} notify={notify} />;
}

function PhonePair({ account, notify }: { account: string | null; notify: Notify }) {
  const [key, setKey] = useState<ethers.Wallet | null>(() => loadDeviceKey());
  const [device, setDevice] = useState<string | null>(null);
  useEffect(() => {
    if (!account) return;
    readCosigners(read, account).then(
      (c) => setDevice(c.device),
      () => undefined,
    );
  }, [account]);
  const paired = !!key && !!device && device.toLowerCase() === key.address.toLowerCase();
  return (
    <section class="card card-pad stack" style={{ maxWidth: "560px", margin: "0 auto" }}>
      <h2 class="card-title">This phone as your second device</h2>
      <p class="small muted" style={{ margin: 0 }}>
        {account ? (
          <>
            Account <span class="mono">{short(account)}</span>.{" "}
          </>
        ) : null}
        With two devices, your key stays on the computer and your PIN is typed only here: someone who
        takes over one device gets either the key or the PIN, not both. This phone keeps a device key that signs your PIN entries; it can move nothing by
        itself.
      </p>
      {!key ? (
        <button type="button" class="btn btn-primary btn-lg btn-block" onClick={() => setKey(createDeviceKey())}>
          Make this phone's device key
        </button>
      ) : (
        <>
          <div class="field">
            <span>This phone's device address</span>
            <div class="mono" style={{ wordBreak: "break-all", fontSize: "15px" }}>
              {key.address}
            </div>
          </div>
          <button type="button" class="btn btn-secondary" onClick={() => copy(key.address, notify, "Device address")}>
            Copy the device address
          </button>
          <div class={`notice ${paired ? "ok" : "info"}`}>
            <IconInfo />
            <span>
              {paired
                ? "Paired: the account names this phone as its second device."
                : "On your computer, paste this address where it asks for your phone's device address (at setup, or under Second device for an existing account)."}
            </span>
          </div>
          <p class="small faint" style={{ margin: 0 }}>
            The device key lives only in this browser. If you clear it or lose the phone, register a new one: with the two-device setting on, a change without
            this phone waits the long no-device delay, and your watchtower tells you.
          </p>
        </>
      )}
    </section>
  );
}

function PhoneApprove({ account, opId, fhe, notify }: { account: string; opId: bigint; fhe: Fhe; notify: Notify }) {
  const key = useMemo(() => loadDeviceKey(), []);
  const [op, setOp] = useState<PhoneOp | null>(null);
  const [err, setErr] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState("");
  const [code, setCode] = useState("");
  useEffect(() => {
    readOpForPhone(read, account, opId).then(setOp, (e) => setErr(explainError(e)));
  }, [account, opId]);
  const mine = !!key && !!op && [op.device, op.helper].some((a) => a.toLowerCase() === key.address.toLowerCase());
  async function approve(v: string) {
    if (!key || !op || v.length < 6) return;
    setErr("");
    try {
      setCode(await buildApproval(read, account, opId, v, key, setBusy));
    } catch (e) {
      setErr(explainError(e));
    } finally {
      setBusy("");
      setPin("");
    }
  }
  return (
    <section class="card card-pad stack" style={{ maxWidth: "560px", margin: "0 auto" }}>
      <h2 class="card-title">Approve on this phone</h2>
      {err && <p class="field-err">{err}</p>}
      {!op && !err && (
        <div class="empty">
          <span class="spinner" style={{ margin: "0 auto" }} />
        </div>
      )}
      {op && (
        <>
          <div class="sum" style={{ flexDirection: "column", alignItems: "flex-start", gap: "6px" }}>
            <b style={{ wordBreak: "break-all" }}>{describeOp(op)}</b>
            <span class="small faint">
              Account {short(account)} · operation #{opId.toString()}
              {op.fee > 0n ? ` · fee ${fmtEth(op.fee)} ETH` : ""} · {op.delay > 0 ? `then waits at least ${fmtWait(op.delay)}` : "runs once approved"}
            </span>
          </div>
          <p class="small faint" style={{ margin: 0 }}>
            Read from the chain by this phone, and the PIN challenge was recomputed here: the computer cannot change what you approve.
          </p>
          {!key && <div class="notice warn">This phone has no device key yet. Open the pairing link from your computer first.</div>}
          {key && !mine && <div class="notice warn">This phone's device key is not this account's second device (yet): an approval from it will be refused.</div>}
          {!code ? (
            <>
              <p class="center muted" style={{ margin: "10px 0 4px" }}>
                Enter your PIN
              </p>
              <PinPad value={pin} onChange={setPin} onEnter={(v) => void approve(v)} active={!busy && fhe === "ready"} />
              {busy && <p class="center small muted">{busy}</p>}
              <button type="button" class="btn btn-primary btn-lg btn-block" disabled={!key || pin.length < 6 || !!busy || fhe !== "ready"} onClick={() => void approve(pin)}>
                Make the approval code
              </button>
            </>
          ) : (
            <>
              <label class="field">
                <span>Approval code: give it to your computer</span>
                <textarea class="input mono" rows={5} readOnly value={code} style={{ wordBreak: "break-all" }} />
              </label>
              <div class="row wrap" style={{ gap: "10px" }}>
                <button type="button" class="btn btn-primary" onClick={() => copy(code, notify, "Approval code")}>
                  Copy
                </button>
                {typeof navigator !== "undefined" && (navigator as any).share && (
                  <button type="button" class="btn btn-secondary" onClick={() => void (navigator as any).share({ text: code }).catch(() => undefined)}>
                    Share
                  </button>
                )}
              </div>
              <p class="small faint" style={{ margin: 0 }}>
                It holds your encrypted PIN entry and this phone's signature for operation #{opId.toString()} only. It is useless for anything else.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** On the computer, while an op waits for the phone: the link as a QR code for the phone's camera, and a box for its code. */
function LanePanel({ account, opId, onCode, notify }: { account: string; opId: bigint; onCode: (code: string) => void; notify: Notify }) {
  const [code, setCode] = useState("");
  const link = approveLink(location.origin, account, opId);
  let ok = false;
  try {
    const a = decodeApproval(code);
    ok = a.opId === opId && a.account.toLowerCase() === account.toLowerCase();
  } catch {
    ok = false;
  }
  return (
    <div class="stack" style={{ marginTop: "12px" }}>
      <div class="row wrap" style={{ gap: "16px", alignItems: "center" }}>
        <div style={{ width: "160px", background: "#fff", padding: "6px", borderRadius: "10px" }} dangerouslySetInnerHTML={{ __html: qrSvg(link) }} />
        <div class="small muted" style={{ flex: "1 1 200px" }}>
          Scan with your phone's camera (or open the link there), check what it shows, enter your PIN on the phone, then paste its approval code here.
          <div style={{ marginTop: "8px" }}>
            <button type="button" class="link-btn" onClick={() => copy(link, notify, "Link")}>
              Copy the link
            </button>
          </div>
        </div>
      </div>
      <textarea class="input mono" rows={3} placeholder="EA1.…" value={code} onInput={(e) => setCode((e.target as HTMLTextAreaElement).value.trim())} />
      {code && !ok && <span class="field-err">That is not the approval code of operation #{opId.toString()}.</span>}
      <button type="button" class="btn btn-primary btn-block" disabled={!ok} onClick={() => onCode(code)}>
        Use the phone's approval
      </button>
    </div>
  );
}

/** The second device: pairing, and the optional two-device setting. */
function SecondDeviceSheet({ ctx, account, walletBal, notify, onClose, onSettled }: { ctx: Ctx; account: string; walletBal: bigint | null; notify: Notify; onClose: () => void; onSettled: () => void }) {
  const [stage, setStage] = useState<"view" | "pin" | "run" | "result" | "off">("view");
  const [cos, setCos] = useState<{ device: string; helper: string } | null>(null);
  const [laneOnly, setLaneOnly] = useState<boolean | null>(null);
  const [laneSupported, setLaneSupported] = useState(false);
  const [addr, setAddr] = useState("");
  const [pin, setPin] = useState("");
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(PAIR_STEPS.length));
  const [t0, setT0] = useState(0);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [laneOp, setLaneOp] = useState<bigint | null>(null);
  const resolver = useRef<((c: string) => void) | null>(null);
  const info = useTryInfo(account);
  useBeforeUnload(stage === "run" || stage === "off");
  const load = () => {
    readCosigners(read, account).then((c) => setCos({ device: c.device, helper: c.helper }), () => undefined);
    readLaneOnly(read, account).then(setLaneOnly, () => setLaneOnly(null));
    laneOnlySupported(read, account, ctx.w.address).then(setLaneSupported, () => setLaneSupported(false));
  };
  useEffect(load, [account]);
  const hasDevice = !!cos && cos.device !== ethers.ZeroAddress;
  const addrOk = ethers.isAddress(addr.trim()) && addr.trim().toLowerCase() !== ctx.w.address.toLowerCase() && addr.trim().toLowerCase() !== account.toLowerCase();

  async function pair(v: string) {
    setStage("run");
    setT0(Date.now());
    setTasks(freshTasks(PAIR_STEPS.length));
    try {
      await pairDeviceWithPin(ctx, account, ethers.getAddress(addr.trim()), v, taskCb(setTasks, 5), info?.bond?.required);
      setMsg({ ok: true, text: "Your phone is the second device now. From here on you can approve on the phone." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof WrongPin ? "Wrong PIN: nothing changed." : explainError(e) });
    } finally {
      setPin("");
      setStage("result");
      load();
      onSettled();
    }
  }
  async function turnOn() {
    try {
      await enableLaneOnly(ctx, account, () => undefined);
      notify("Two-device setting on", "ok");
      load();
    } catch (e) {
      notify(explainError(e), "err");
    }
  }
  async function turnOff() {
    setStage("off");
    setT0(Date.now());
    setTasks(freshTasks(LANE_OFF_STEPS.length));
    try {
      const r = await disableLaneOnlyWithPhone(
        ctx,
        account,
        (opId) =>
          new Promise<string>((res) => {
            setLaneOp(opId);
            resolver.current = res;
          }),
        taskCb(setTasks, 4),
      );
      setMsg({ ok: true, text: `Approved. The setting switches off ${fmtWait(Math.max(0, r.readyAt - Math.floor(Date.now() / 1000)))} from now (operation #${r.opId}); anyone can run it then.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof WrongPin ? "Wrong PIN on the phone: nothing changed." : explainError(e) });
    } finally {
      setLaneOp(null);
      setStage("result");
      load();
    }
  }

  return (
    <Sheet title="Second device" onClose={onClose} locked={stage === "run" || stage === "off"}>
      {stage === "view" && (
        <div class="stack">
          <p class="small muted" style={{ margin: 0 }}>
            <b>Recommended:</b> keep your key here and type your PIN on your phone. Someone who takes over one device then has the key or the PIN, not both. The
            phone signs each PIN entry with its own device key; it can move nothing by itself.
          </p>
          <div class="kv">
            <span>Second device</span>
            <b class="mono">{cos ? (hasDevice ? short(cos.device) : "none") : "…"}</b>
          </div>
          <div class="row wrap" style={{ gap: "16px", alignItems: "center" }}>
            <div style={{ width: "150px", background: "#fff", padding: "6px", borderRadius: "10px" }} dangerouslySetInnerHTML={{ __html: qrSvg(pairLink(location.origin, account)) }} />
            <div class="small muted" style={{ flex: "1 1 200px" }}>
              1. Scan this with your phone (or open the link there) and make its device key. 2. Paste the phone's device address below. 3. Confirm with your PIN.
              <div style={{ marginTop: "6px" }}>
                <button type="button" class="link-btn" onClick={() => copy(pairLink(location.origin, account), notify, "Link")}>
                  Copy the link
                </button>
              </div>
            </div>
          </div>
          <label class="field">
            <span>{hasDevice ? "Replace with the device address from the phone" : "Device address from the phone"}</span>
            <input class="input mono" placeholder="0x…" value={addr} spellcheck={false} onInput={(e) => setAddr((e.target as HTMLInputElement).value)} />
            {addr.trim() && !addrOk && <span class="field-err">Enter the phone's device address (not your wallet, not the account).</span>}
          </label>
          <button type="button" class="btn btn-primary btn-block" disabled={!addrOk} onClick={() => setStage("pin")}>
            {hasDevice ? "Replace the second device" : "Register the phone"}
          </button>
          {hasDevice && (laneSupported || laneOnly) && (
            <div class="duress-box">
              <div class="row between" style={{ alignItems: "flex-start", gap: "14px" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "14px" }}>Two-device setting (optional)</div>
                  <div class="small faint" style={{ marginTop: "2px" }}>
                    Big sends, calls to other contracts and loosening changes then accept only a PIN approved on the phone. Turning it on is immediate; turning
                    it off needs the phone and waits 72 hours. Losing the phone does not lock you out: the device can be replaced with the key and the PIN after
                    the long no-device delay, and your watchtower tells you.
                  </div>
                </div>
                <b>{laneOnly === null ? "…" : laneOnly ? "On" : "Off"}</b>
              </div>
              <div style={{ marginTop: "10px" }}>
                {laneOnly ? (
                  <button type="button" class="btn btn-secondary btn-sm" onClick={() => void turnOff()}>
                    Turn off with the phone
                  </button>
                ) : (
                  <button type="button" class="btn btn-secondary btn-sm" onClick={() => void turnOn()}>
                    Turn on
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {stage === "pin" && (
        <PinStage
          summary={
            <div class="sum">
              <b>Second device</b>
              <span class="faint">→</span>
              <span class="mono">{short(addr.trim())}</span>
            </div>
          }
          info={info}
          walletBal={walletBal}
          pin={pin}
          setPin={setPin}
          onGo={(v) => void pair(v)}
          onBack={() => setStage("view")}
          label="Register with PIN"
        />
      )}
      {stage === "run" && <RunStage title="Registering the phone" labels={PAIR_STEPS} tasks={tasks} t0={t0} />}
      {stage === "off" && (
        <div>
          <RunStage title="Turning the two-device setting off" labels={LANE_OFF_STEPS} tasks={tasks} t0={t0} />
          {laneOp !== null && resolver.current && (
            <LanePanel
              account={account}
              opId={laneOp}
              notify={notify}
              onCode={(c) => {
                resolver.current?.(c);
                resolver.current = null;
                setLaneOp(null);
              }}
            />
          )}
        </div>
      )}
      {stage === "result" && msg && (
        <div class="result">
          <div class={`result-icon ${msg.ok ? "ok" : "bad"}`}>{msg.ok ? <OkIcon /> : <BadIcon />}</div>
          <p>{msg.text}</p>
          <div class="flow-actions">
            <button type="button" class="btn btn-primary btn-lg" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function App() {
  const [fhe, setFhe] = useState<Fhe>("loading");
  const [phase, setPhase] = useState<"boot" | "connect" | "create" | "account" | "claim">("boot");
  const willParam = useMemo(() => {
    const w = new URLSearchParams(location.search).get("will");
    return w && ethers.isAddress(w) ? ethers.getAddress(w) : null;
  }, []);
  // An heir card's link carries the claim code in the fragment, which browsers never send to a server: read it once,
  // then drop it from the address bar and the history.
  const codeParam = useMemo(() => {
    const m = /(?:^#|&)code=([0-9a-fA-F-]{32,40})(?:&|$)/.exec(location.hash);
    if (m) history.replaceState(history.state, "", location.pathname + location.search);
    return m ? m[1] : "";
  }, []);
  // the phone's page of the two-device flow (#pair= / #approve=): no wallet; the device key and the PIN stay on the phone
  const phoneLink = useMemo(() => parsePhoneLink(location.hash), []);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [walletBal, setWalletBal] = useState<bigint | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [privDefault, setPrivDefault] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "err" | "info" } | null>(null);
  const toastTimer = useRef<number>(0);

  const notify: Notify = useCallback((text, kind = "info") => {
    setToast({ text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), kind === "err" ? 7000 : 3500);
  }, []);

  async function connect(silent = false) {
    setConnecting(true);
    try {
      const w = await connectWallet();
      watchWallet();
      setCtx({ w, read });
      read.getBalance(w.address).then(setWalletBal, () => undefined);
      if (willParam) return void setPhase("claim");
      const acc = await retry(() => pickAccount(w.address));
      setAccount(acc);
      setPhase(acc ? "account" : "create");
    } catch (e) {
      console.error("connect failed", e);
      if (!silent) notify(explainError(e), "err");
      setPhase("connect");
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    fheClient(read).then(
      () => setFhe("ready"),
      () => setFhe("error"),
    );
    if (phoneLink) return;
    void (async () => {
      const eth = (window as any).ethereum;
      if (eth) {
        try {
          const [accs, chain] = await Promise.all([eth.request({ method: "eth_accounts" }), eth.request({ method: "eth_chainId" })]);
          if (Array.isArray(accs) && accs.length && String(chain).toLowerCase() === CHAIN_ID_HEX) return void (await connect(true));
        } catch {
          /* ask instead */
        }
      }
      setPhase("connect");
    })();
  }, []);

  const onWalletBal = useCallback((b: bigint) => setWalletBal(b), []);

  const toastEl = toast && (
    <div class={`toast ${toast.kind}`} role="status">
      <span class={`dot ${toast.kind === "err" ? "bad" : toast.kind === "ok" ? "live" : ""}`} />
      {toast.text}
    </div>
  );
  if (phoneLink)
    return (
      <>
        <TopBar fhe={fhe} address={null} walletBal={null} showConnect={false} connecting={false} onConnect={() => undefined} />
        <main class="app-main">
          <PhoneView link={phoneLink} fhe={fhe} notify={notify} />
        </main>
        {toastEl}
      </>
    );

  return (
    <>
      <TopBar fhe={fhe} address={ctx?.w.address ?? null} walletBal={walletBal} showConnect={phase === "connect"} connecting={connecting} onConnect={() => void connect()} />
      <main class="app-main">
        {phase === "boot" && (
          <div class="boot">
            <span class="spinner" />
          </div>
        )}
        {phase === "connect" && willParam && (
          <div class="notice info will-link-note">
            <IconLock />
            <span>You opened a hidden will{codeParam ? " with a claim code" : ""}. Connect a wallet to see it and claim.</span>
          </div>
        )}
        {phase === "connect" && <ConnectView connecting={connecting} onConnect={() => void connect()} notify={notify} />}
        {phase === "claim" && ctx && willParam && <ClaimView ctx={ctx} willAddr={willParam} initialCode={codeParam} notify={notify} />}
        {phase === "create" && ctx && (
          <CreateFlow
            ctx={ctx}
            fhe={fhe}
            walletBal={walletBal}
            onDone={(a) => {
              store.set(accountKey(ctx.w.address), a);
              setAccount(a);
              setPhase("account");
            }}
            onCancel={account ? () => setPhase("account") : undefined}
            privateDefault={privDefault}
            notify={notify}
          />
        )}
        {phase === "account" && ctx && account && (
          <Dashboard
            key={account}
            ctx={ctx}
            account={account}
            walletBal={walletBal}
            notify={notify}
            onNewAccount={(p) => {
              setPrivDefault(!!p);
              setPhase("create");
            }}
            onOpenAccount={(a) => {
              store.set(accountKey(ctx.w.address), a);
              setAccount(a);
            }}
            onWalletBal={onWalletBal}
          />
        )}
      </main>
      {toast && (
        <div class={`toast ${toast.kind}`} role="status">
          <span class={`dot ${toast.kind === "err" ? "bad" : toast.kind === "ok" ? "live" : ""}`} />
          {toast.text}
        </div>
      )}
    </>
  );
}

render(<App />, document.getElementById("root")!);
