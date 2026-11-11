/**
 * The Sepolia app: connect → create an Encrypted Account (PIN, hidden limit, 8 transactions) → deposit → send with the
 * PIN. Chain logic lives in account.ts / fhe.ts / tx.ts; this file is only the interface.
 */
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ethers } from "ethers";
import { CHAIN_ID, CHAIN_ID_HEX, ETH_UNIT, RPC_URL, addrUrl, txUrl } from "./chain";
import {
  Activity,
  AccountView,
  CALL_STEPS,
  Ctx,
  SEND_STEPS,
  SETUP_STEPS,
  StepCb,
  WrongPin,
  createAndSetup,
  deposit,
  findAccounts,
  loadActivity,
  loadPlan,
  readAccount,
  readEscape,
  sendWithPin,
} from "./account";
import { fheClient } from "./fhe";
import { checkPin, randomPin } from "./pin";
import { explainError } from "./tx";
import { connectWallet, hasWallet, watchWallet } from "./wallet";
import {
  Heir,
  PHASE_TEXT,
  WillView,
  claimWill,
  createWill,
  decryptMyBalance,
  fundWill,
  predictWill,
  readWill,
  setHeirsWithPin,
  settleWill,
  startWill,
  willUrl,
} from "./will";

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

function CreateFlow({ ctx, fhe, walletBal, onDone, onCancel }: { ctx: Ctx; fhe: Fhe; walletBal: bigint | null; onDone: (account: string) => void; onCancel?: () => void }) {
  const plan = useMemo(() => loadPlan(ctx.w.address), [ctx.w.address]);
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
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(SETUP_STEPS.length));
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

  // PIN feedback
  const check = checkPin(pin);
  let pinMsg = { t: "", k: "" };
  if (step === 0 && pin) {
    if (pin.length < 6) pinMsg = { t: `${6 - pin.length} more digit${6 - pin.length === 1 ? "" : "s"}`, k: "" };
    else if (!check.ok) pinMsg = { t: check.reason ?? "Choose another PIN", k: "bad" };
    else if (check.warnings.length) pinMsg = { t: check.warnings.join(" · "), k: "warn" };
    else pinMsg = { t: "Looks good", k: "ok" };
  }

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
      const a = await createAndSetup(ctx, { pin, limitEth: limit, known: null, escapeWallet }, cb);
      setCreated(a);
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
            <div class="flow-body">
              <PinPad value={pin} onChange={(v) => setPin(v)} onEnter={(v) => checkPin(v).ok && setStep(1)} reveal={reveal} onToggleReveal={() => setReveal(!reveal)} />
              <p class={`pin-msg ${pinMsg.k}`}>{pinMsg.t || "Type on your keyboard or tap the keys"}</p>
              {suggested && suggested === pin && (
                <div class="suggested">
                  Suggested PIN <span class="mono">{suggested}</span> · write it down now
                </div>
              )}
            </div>
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
                Suggest one
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
            </div>
            <div class="flow-actions">
              <button type="button" class="btn btn-ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <button type="button" class="btn btn-primary" disabled={!limitOk} onClick={() => setStep(3)}>
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
              </div>
              <div class="notice" style={{ marginTop: "14px" }}>
                <IconInfo />
                <span>
                  Your wallet will ask you to confirm <b>8 transactions</b>. Keep this tab open; if anything stops, you can continue where it left off.
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
              <Ring done={done} total={SETUP_STEPS.length} />
              <div>
                <div class="progress-title">{runErr ? "Setup paused" : "Creating your account"}</div>
                <div class="progress-sub">{runErr ? "Nothing is lost: continue from this step." : current >= 0 ? SETUP_LABELS[current] : "Preparing…"}</div>
                <div class="timer">{mmss(now - t0)}</div>
              </div>
            </div>
            <ul class="tasks">
              {tasks.map((t, i) => (
                <Task label={SETUP_LABELS[i]} t={t} extra={t.s === "run" && /Encrypt/.test(t.text ?? "") ? <Cipher n={10} /> : undefined} />
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
            <p>Protection is on: PIN, hidden limit, encrypted address book and escape address. Deposit some Sepolia ETH and try sending with your PIN.</p>
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

function SendSheet({ ctx, account, view, onClose, onSettled }: { ctx: Ctx; account: string; view: AccountView; onClose: () => void; onSettled: () => void }) {
  const [stage, setStage] = useState<"details" | "pin" | "run" | "result">("details");
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("0.0001");
  const [pin, setPin] = useState("");
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(SEND_STEPS.length));
  const [result, setResult] = useState<SendResult | null>(null);
  const [t0, setT0] = useState(0);
  const running = stage === "run";
  const now = useNow(1000);

  useEffect(() => {
    if (!running) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [running]);

  const toTrim = to.trim();
  const toOk = ethers.isAddress(toTrim) && toTrim.toLowerCase() !== account.toLowerCase();
  const wei = parseEth(amt);
  const enough = wei !== null && view.balance >= wei;
  const nowS = Math.floor(now / 1000);
  const waitUntil = result?.kind === "wrong" ? result.next : view.nextAllowedAt;
  const locked = waitUntil > nowS;

  async function go(p = pin) {
    if (p.length < 6 || !wei || !toOk) return;
    setStage("run");
    setT0(Date.now());
    setResult(null);
    setTasks(freshTasks(SEND_STEPS.length));
    const cb: StepCb = (i, s, text, hash) =>
      setTasks((prev) =>
        prev.map((t, j) => {
          if (j !== i) return t;
          const wrong = /wrong/i.test(text ?? "");
          const state: TaskState["s"] = s === "run" ? "run" : s === "fail" ? "fail" : wrong || (s === "skip" && i === 5) ? "bad" : "done";
          return { s: state, text: s === "done" && !text ? undefined : text, hash: hash ?? t.hash };
        }),
      );
    try {
      const h = await sendWithPin(ctx, account, ethers.getAddress(toTrim), wei, p, cb);
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
            <span class="field-hint">Available: {fmtEth(view.balance)} ETH</span>
            {wei !== null && !enough && <span class="field-err">The account holds less than that. Deposit first.</span>}
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
          <button type="button" class="btn btn-primary btn-lg btn-block" disabled={!toOk || !wei || !enough || locked} onClick={() => setStage("pin")}>
            Continue
          </button>
        </div>
      )}

      {stage === "pin" && wei && (
        <div>
          <div class="sum">
            <b>{fmtEth(wei)} ETH</b>
            <span class="faint">→</span>
            <span class="mono">{short(toTrim)}</span>
          </div>
          <p class="center muted" style={{ margin: "18px 0 6px", fontSize: "15px" }}>
            Enter your PIN
          </p>
          <PinPad value={pin} onChange={setPin} onEnter={(v) => void go(v)} />
          <p class="keys-hint center">Wrong PINs are counted on-chain and move nothing. Trying one is safe.</p>
          <div class="flow-actions">
            <button type="button" class="btn btn-ghost" onClick={() => setStage("details")}>
              Back
            </button>
            <button type="button" class="btn btn-primary" disabled={pin.length < 6} onClick={() => void go()}>
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
              <div class="progress-title">Checking your PIN</div>
              <div class="progress-sub">{current >= 0 ? SEND_LABELS[current] : "Preparing…"}</div>
              <div class="timer">{mmss(now - t0)}</div>
            </div>
          </div>
          <ul class="tasks">
            {tasks.map((t, i) => (
              <Task label={SEND_LABELS[i]} t={t} extra={t.s === "run" && (i === 1 || i === 3) ? <Cipher n={12} /> : undefined} />
            ))}
          </ul>
          <div class="notice" style={{ marginTop: "14px" }}>
            <IconInfo />
            <span>Up to 4 wallet confirmations. The yes / no decryption takes about half a minute.</span>
          </div>
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
                  <p>The attempt was counted on-chain before its result was decrypted. Wrong guesses so far: {result.score}.</p>
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

function ActivityList({ items }: { items: Activity[] | null }) {
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
  };
  return (
    <ul class="activity">
      {items.map((a) => {
        const m = meta[a.kind];
        const Ico = m.ico;
        return (
          <li class="act">
            <span class={`act-ico ${m.cls}`}>
              <Ico />
            </span>
            <div class="act-main">
              <div class="act-title">{m.title(a)}</div>
              <div class="act-sub">{m.sub(a)}</div>
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

function Dashboard({ ctx, account, walletBal, notify, onNewAccount, onWalletBal }: { ctx: Ctx; account: string; walletBal: bigint | null; notify: Notify; onNewAccount: () => void; onWalletBal: (b: bigint) => void }) {
  const [view, setView] = useState<AccountView | null>(null);
  const [escape, setEscape] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [sheet, setSheet] = useState<null | "send" | "deposit">(null);
  const now = useNow(1000);

  const refresh = useCallback(
    async (withActivity: boolean) => {
      try {
        setView(await readAccount(read, account));
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
    const id = setInterval(() => void refresh(false), 15000);
    return () => clearInterval(id);
  }, [account]);

  const nowS = Math.floor(now / 1000);
  const score = view?.score ?? 0;
  const next = view && view.nextAllowedAt > nowS ? `Next try in ${fmtWait(view.nextAllowedAt - nowS)}` : "Next try: now";
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
              <span class="acct-name">Encrypted Account</span>
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
          </section>

          <section class="card card-pad">
            <h3 class="card-title">
              Activity
              <button type="button" class="link-btn" onClick={() => void refresh(true)}>
                Refresh
              </button>
            </h3>
            <ActivityList items={activity} />
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
                <span class="v">On</span>
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
            </ul>
          </section>

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
            <button type="button" class="link-btn" onClick={onNewAccount}>
              Create another account
            </button>
            <a class="ext" href={addrUrl(account)} target="_blank" rel="noopener">
              Etherscan
              <IconExt />
            </a>
          </div>
        </div>
      </div>

      {sheet === "send" && view && <SendSheet ctx={ctx} account={account} view={view} onClose={() => setSheet(null)} onSettled={() => void refresh(true)} />}
      {sheet === "deposit" && <DepositSheet ctx={ctx} account={account} walletBal={walletBal} onClose={() => setSheet(null)} onSettled={() => void refresh(true)} />}
    </>
  );
}

// ───────────────────────────── hidden will ─────────────────────────────

const WILL_LABELS = ["Open the call on-chain", "Encrypt your PIN guess", "Submit the encrypted guess", "Decrypt only the yes / no result", "Record the result on-chain", "Wait the delay, then set the heirs"];
const FUND_UNITS = 1_000_000_000n; // 1,000 tcUSD (6 decimals)
const fmtTc = (units: bigint) => `${(Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} tcUSD`;

function phaseLine(v: WillView, nowS: number): string {
  switch (v.phase) {
    case 0:
      return "No heirs yet.";
    case 1:
      return `The owner is active. It can start in ${fmtWait(Math.max(0, v.startableAt - nowS))} if no correct PIN comes first.`;
    case 2:
      return `No correct PIN for ${fmtWait(nowS - v.pinAt)}. Anyone can start it.`;
    case 3:
      return `Started. A correct PIN within ${fmtWait(Math.max(0, v.settleableAt - nowS))} cancels it.`;
    case 4:
      return "The grace period is over. Anyone can settle it.";
    default:
      return "Settled. Anyone can claim: heirs get their share, everyone else an encrypted zero.";
  }
}

function useWill(addr: string | null, every = 15000) {
  const [v, setV] = useState<WillView | null>(null);
  const refresh = useCallback(async () => {
    if (!addr) return;
    try {
      setV(await readWill(read, addr));
    } catch {
      /* transient RPC error: keep the last view */
    }
  }, [addr]);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), every);
    return () => clearInterval(id);
  }, [refresh]);
  return [v, refresh] as const;
}

function WillCard({ ctx, account, notify }: { ctx: Ctx; account: string; notify: Notify }) {
  const [addr, setAddr] = useState<string | null>(null);
  const [v, refresh] = useWill(addr);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
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

  return (
    <section class="card card-pad will-card">
      <h3 class="card-title">
        Hidden will
        <span class="badge">New</span>
      </h3>
      {!v ? (
        <p class="small faint">Loading…</p>
      ) : !v.exists ? (
        <>
          <p class="small muted">
            Leave test tokens to up to four heirs. Their addresses and shares are encrypted, even from you. If the account sees no correct PIN for 5 minutes (months, in real use), anyone can start the will; a PIN in the next 5 minutes cancels it.
          </p>
          <button type="button" class="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void act("Creating…", (st) => createWill(ctx, account, st), "Your will is created.")}>
            {busy ?? "Create a will"}
          </button>
        </>
      ) : (
        <>
          <ul class="prot">
            <li>
              <span class={`check ${v.heirsSet ? "" : "off"}`}>{v.heirsSet ? <IconCheck /> : <IconClock />}</span>
              <span class="k">
                Heirs<small>{v.heirsSet ? "Set, encrypted: nobody can read them" : "Not set yet"}</small>
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
                Last correct PIN<small>{v.pinAt ? timeAgo(v.pinAt) : "never"}</small>
              </span>
              <span class="v">{PHASE_TEXT[v.phase].split(":")[0]}</span>
            </li>
          </ul>
          <p class="small muted will-phase">{phaseLine(v, nowS)}</p>
          <div class="row wrap will-actions">
            {!v.settled && (
              <button type="button" class="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => setSheet(true)}>
                {v.heirsSet ? "Change heirs" : "Set heirs"}
              </button>
            )}
            {!v.settled && (
              <button type="button" class="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void act("Minting…", (st) => fundWill(ctx, v.address, FUND_UNITS, st), "1,000 test tokens added to the will.")}>
                Add 1,000 tcUSD
              </button>
            )}
            {v.phase === 2 && (
              <button type="button" class="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void act("Starting…", (st) => startWill(ctx, v.address, st), "Started.")}>
                Start
              </button>
            )}
            {v.phase === 4 && (
              <button type="button" class="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void act("Settling…", (st) => settleWill(ctx, v.address, st), "Settled. Heirs can claim now.")}>
                Settle
              </button>
            )}
            <button type="button" class="link-btn" onClick={() => copy(willUrl(v.address), notify, "Claim link")}>
              Copy the claim link
            </button>
          </div>
          {busy && <p class="small faint">{busy}</p>}
        </>
      )}
      {sheet && v && <WillSheet ctx={ctx} account={account} willAddr={v.address} onClose={() => setSheet(false)} onSettled={() => void refresh()} />}
    </section>
  );
}

type WillResult = { kind: "ok"; hash: string } | { kind: "wrong"; score: number; next: number } | { kind: "err"; text: string };

function WillSheet({ ctx, account, willAddr, onClose, onSettled }: { ctx: Ctx; account: string; willAddr: string; onClose: () => void; onSettled: () => void }) {
  const [stage, setStage] = useState<"heirs" | "pin" | "run" | "result">("heirs");
  const [rows, setRows] = useState<{ address: string; percent: string }[]>([
    { address: "", percent: "60" },
    { address: "", percent: "40" },
  ]);
  const [pin, setPin] = useState("");
  const [tasks, setTasks] = useState<TaskState[]>(() => freshTasks(CALL_STEPS.length));
  const [result, setResult] = useState<WillResult | null>(null);
  const [t0, setT0] = useState(0);
  const running = stage === "run";
  const now = useNow(1000);

  const filled = rows.filter((r) => r.address.trim() || r.percent.trim());
  const rowErr = (r: { address: string; percent: string }) => {
    const a = r.address.trim();
    const p = Number(r.percent);
    if (!a && !r.percent.trim()) return null;
    if (!ethers.isAddress(a)) return "Enter a valid address.";
    if (a.toLowerCase() === account.toLowerCase() || a.toLowerCase() === willAddr.toLowerCase()) return "Not the account or the will itself.";
    if (!(p > 0 && p <= 100)) return "Share between 0 and 100 %.";
    return null;
  };
  const total = filled.reduce((s, r) => s + (Number(r.percent) || 0), 0);
  const valid = filled.length > 0 && filled.every((r) => !rowErr(r)) && total <= 100 + 1e-9;
  const heirs: Heir[] = filled.map((r) => ({ address: r.address.trim(), percent: Number(r.percent) }));

  async function go(p = pin) {
    if (p.length < 6 || !valid) return;
    setStage("run");
    setT0(Date.now());
    setResult(null);
    setTasks(freshTasks(CALL_STEPS.length));
    const cb: StepCb = (i, s, text, hash) =>
      setTasks((prev) =>
        prev.map((t, j) => {
          if (j !== i) return t;
          const wrong = /wrong/i.test(text ?? "");
          const state: TaskState["s"] = s === "run" ? "run" : s === "fail" ? "fail" : wrong || (s === "skip" && i === 5) ? "bad" : "done";
          return { s: state, text: s === "done" && !text ? undefined : text, hash: hash ?? t.hash };
        }),
      );
    try {
      setResult({ kind: "ok", hash: await setHeirsWithPin(ctx, account, willAddr, heirs, p, cb) });
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
    <Sheet title={stage === "result" ? "Result" : "Heirs of your will"} onClose={onClose} locked={running}>
      {stage === "heirs" && (
        <div class="stack">
          <p class="small muted">Up to four heirs. Addresses and shares are encrypted in your browser before they leave it; nobody can read them afterwards, including you.</p>
          {rows.map((r, i) => (
            <div class="heir-row">
              <input
                class="input mono"
                placeholder="0x… heir address"
                value={r.address}
                spellcheck={false}
                autoComplete="off"
                onInput={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, address: (e.target as HTMLInputElement).value } : x)))}
              />
              <div class="input-wrap heir-pct">
                <input class="input" inputMode="decimal" value={r.percent} onInput={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, percent: (e.target as HTMLInputElement).value } : x)))} />
                <div class="suffix">
                  <span class="small faint">%</span>
                </div>
              </div>
              {rowErr(r) && <span class="field-err heir-err">{rowErr(r)}</span>}
            </div>
          ))}
          <div class="chips">
            {rows.length < 4 && (
              <button type="button" class="chip-btn" onClick={() => setRows([...rows, { address: "", percent: "" }])}>
                + Add an heir
              </button>
            )}
            <button type="button" class="chip-btn" onClick={() => setRows(rows.map((x, j) => (j === 0 ? { ...x, address: ctx.w.address } : x)))}>
              My wallet as heir 1 · {short(ctx.w.address)}
            </button>
          </div>
          <span class={`field-hint ${total > 100 ? "field-err" : ""}`}>
            Total: {Math.round(total * 100) / 100} %{total < 100 ? " (the rest stays in the will)" : ""}
          </span>
          <div class="notice info">
            <IconLock />
            <span>
              Changing the heirs <b>needs your PIN</b> and the account's waiting period. The key alone can't touch the will.
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
              {heirs.length} heir{heirs.length === 1 ? "" : "s"}
            </b>
            <span class="faint">·</span>
            <span>encrypted</span>
          </div>
          <p class="center muted" style={{ margin: "18px 0 6px", fontSize: "15px" }}>
            Enter your PIN
          </p>
          <PinPad value={pin} onChange={setPin} onEnter={(v) => void go(v)} />
          <div class="flow-actions">
            <button type="button" class="btn btn-ghost" onClick={() => setStage("heirs")}>
              Back
            </button>
            <button type="button" class="btn btn-primary" disabled={pin.length < 6} onClick={() => void go()}>
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
              <h3>Heirs set</h3>
              <p>They are stored encrypted. From now on, every correct PIN on your account shows you are still here.</p>
              <div class="facts-row">
                <TxLink hash={result.hash} label="View transaction" />
              </div>
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

function ClaimView({ ctx, willAddr, notify }: { ctx: Ctx; willAddr: string; notify: Notify }) {
  const [v, refresh] = useWill(willAddr, 10000);
  const [busy, setBusy] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<bigint | null>(null);
  const now = useNow(1000);
  const nowS = Math.floor(now / 1000);

  async function act(label: string, fn: (st: (t: string) => void) => Promise<string | void>, okText: string, isClaim = false) {
    setBusy(label);
    try {
      const h = await fn((t) => setBusy(t));
      if (isClaim && h) setClaimed(h);
      notify(okText, "ok");
      await refresh();
    } catch (e) {
      notify(explainError(e), "err");
    } finally {
      setBusy(null);
    }
  }

  async function reveal() {
    setBusy("Preparing…");
    try {
      setRevealed(await decryptMyBalance(ctx, (t) => setBusy(t)));
    } catch (e) {
      notify(explainError(e), "err");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="claim">
      <section class="card card-pad">
        <div class="acct-row">
          <span class="acct-name">Hidden will</span>
          <AddrChip a={willAddr} notify={notify} />
        </div>
        {!v ? (
          <p class="small faint">Loading…</p>
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
            </ul>
            <div class="row wrap will-actions">
              {v.phase === 2 && (
                <button type="button" class="btn btn-primary" disabled={!!busy} onClick={() => void act("Starting…", (st) => startWill(ctx, willAddr, st), "Started.")}>
                  Start
                </button>
              )}
              {v.phase === 4 && (
                <button type="button" class="btn btn-primary" disabled={!!busy} onClick={() => void act("Settling…", (st) => settleWill(ctx, willAddr, st), "Settled.")}>
                  Settle
                </button>
              )}
              {v.phase === 5 && (
                <button type="button" class="btn btn-primary" disabled={!!busy} onClick={() => void act("Claiming…", (st) => claimWill(ctx, willAddr, st), "Claimed.", true)}>
                  Claim
                </button>
              )}
              {v.phase === 5 && (
                <button type="button" class="btn btn-secondary" disabled={!!busy} onClick={() => void reveal()}>
                  Reveal my tcUSD balance
                </button>
              )}
            </div>
            {busy && <p class="small faint">{busy}</p>}
            {claimed && (
              <div class="notice ok">
                <IconCheck />
                <span>
                  Claimed. If you are an heir, your share just arrived, encrypted; otherwise you received an encrypted zero. Nobody watching the chain can tell which. <TxLink hash={claimed} label="Transaction" />
                </span>
              </div>
            )}
            {revealed !== null && (
              <div class="reveal">
                <span class="small faint">Your tcUSD balance, decrypted only for you</span>
                <b>{fmtTc(revealed)}</b>
                <span class="small muted">{revealed > 0n ? "That's what you hold of the test token." : "Zero: you are not an heir of this will, or you haven't claimed yet."}</span>
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

function App() {
  const [fhe, setFhe] = useState<Fhe>("loading");
  const [phase, setPhase] = useState<"boot" | "connect" | "create" | "account" | "claim">("boot");
  const willParam = useMemo(() => {
    const w = new URLSearchParams(location.search).get("will");
    return w && ethers.isAddress(w) ? ethers.getAddress(w) : null;
  }, []);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [walletBal, setWalletBal] = useState<bigint | null>(null);
  const [account, setAccount] = useState<string | null>(null);
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
            <span>You opened a hidden will. Connect a wallet to see it and claim.</span>
          </div>
        )}
        {phase === "connect" && <ConnectView connecting={connecting} onConnect={() => void connect()} notify={notify} />}
        {phase === "claim" && ctx && willParam && <ClaimView ctx={ctx} willAddr={willParam} notify={notify} />}
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
          />
        )}
        {phase === "account" && ctx && account && <Dashboard ctx={ctx} account={account} walletBal={walletBal} notify={notify} onNewAccount={() => setPhase("create")} onWalletBal={onWalletBal} />}
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
