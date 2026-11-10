import { ethers } from "ethers";
import { CHAIN_ID, FACTORY, REPO_URL, RPC_URL, addrUrl, txUrl } from "./chain";
import { Ctx, SEND_STEPS, SETUP_STEPS, StepCb, WrongPin, createAndSetup, deposit, findAccounts, loadPlan, readAccount, sendWithPin } from "./account";
import { fheClient } from "./fhe";
import { checkPin, randomPin } from "./pin";
import { explainError } from "./tx";
import { connectWallet, hasWallet, watchWallet } from "./wallet";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const read = new ethers.JsonRpcProvider(RPC_URL, Number(CHAIN_ID), { staticNetwork: ethers.Network.from(Number(CHAIN_ID)) });
let ctx: Ctx | null = null;
let account: string | null = null;
let busy = false;
const escapeWallet = ethers.Wallet.createRandom();
const accountKey = (owner: string) => `ea:account:${owner.toLowerCase()}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtEth = (wei: bigint) => {
  const s = ethers.formatEther(wei);
  const [i, d = ""] = s.split(".");
  return `${i}.${(d + "000000").slice(0, 6)}`;
};

function msg(id: string, text: string, kind: "" | "ok" | "err" | "info" = "") {
  const el = $(id);
  el.textContent = text;
  el.className = `msg ${kind}`;
}

function link(href: string, text: string) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = text;
  return a;
}

// ───────────────────────────── step lists ─────────────────────────────

function renderSteps(id: string, names: readonly string[]): StepCb {
  const ol = $(id);
  ol.innerHTML = "";
  const items = names.map((n) => {
    const li = document.createElement("li");
    li.className = "pending";
    li.innerHTML = `<span class="dot"></span><span class="name"></span><span class="detail"></span>`;
    (li.querySelector(".name") as HTMLElement).textContent = n;
    ol.appendChild(li);
    return li;
  });
  return (i, state, text, hash) => {
    const li = items[i];
    if (!li) return;
    li.className = state === "run" ? "running" : state === "done" ? "done" : state === "skip" ? "skipped" : "failed";
    const d = li.querySelector(".detail") as HTMLElement;
    d.textContent = "";
    if (text) d.append(text);
    else if (state === "skip") d.append("already done");
    if (hash) {
      if (text) d.append(" · ");
      d.append(link(txUrl(hash), "tx ↗"));
    }
  };
}

// ───────────────────────────── account view ─────────────────────────────

async function refresh() {
  if (!account) return;
  try {
    const v = await readAccount(read, account);
    const addrEl = $("acct-addr");
    addrEl.textContent = "";
    addrEl.append(link(addrUrl(account), short(account) + " ↗"));
    $("acct-bal").textContent = `${fmtEth(v.balance)} ETH`;
    $("acct-state").textContent = !v.armed ? "Setup not finished" : v.escapeReadyAt ? "Escape running" : v.restricted ? "Restricted (PIN still works)" : "Active";
    $("acct-score").textContent = String(v.score);
    const now = Math.floor(Date.now() / 1000);
    $("acct-next").textContent = v.nextAllowedAt > now ? `in ${fmtWait(v.nextAllowedAt - now)}` : "now";
    ($("send-btn") as HTMLButtonElement).disabled = busy || !v.armed;
  } catch (e) {
    msg("send-msg", explainError(e), "err");
  }
}

function fmtWait(s: number) {
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

function showAccount(addr: string) {
  account = addr;
  try {
    localStorage.setItem(accountKey(ctx!.w.address), addr);
  } catch {
    /* none */
  }
  $("create-card").hidden = true;
  $("account-card").hidden = false;
  void refresh();
}

// ───────────────────────────── connect ─────────────────────────────

async function onConnect() {
  if (!hasWallet()) {
    msg("connect-msg", "No browser wallet found. Install MetaMask (or another wallet extension) and reload this page.", "err");
    return;
  }
  ($("connect") as HTMLButtonElement).disabled = true;
  msg("connect-msg", "Connecting…", "info");
  try {
    const w = await connectWallet();
    ctx = { w, read };
    watchWallet();
    const bal = await read.getBalance(w.address);
    $("connect").hidden = true;
    msg("connect-msg", `Connected: ${short(w.address)} · ${fmtEth(bal)} Sepolia ETH`, "ok");
    if (bal === 0n) msg("connect-msg", `Connected: ${short(w.address)} · 0 Sepolia ETH — get some from a Sepolia faucet first.`, "err");

    let known: string | null = null;
    try {
      known = localStorage.getItem(accountKey(w.address));
    } catch {
      known = null;
    }
    const found = known ? [known] : await findAccounts(read, w.address);
    for (const a of found.reverse()) {
      const v = await readAccount(read, a);
      if (v.exists && v.armed) return showAccount(a);
    }
    $("create-card").hidden = false;
    const plan = loadPlan(w.address);
    if (plan && (await read.getCode(plan.account)) !== "0x") {
      msg("create-msg", "An unfinished setup was found: enter the same PIN and press Create to continue.", "info");
      ($("limit") as HTMLInputElement).value = ethers.formatEther(BigInt(plan.limitUnits) * 10n ** 12n);
    }
  } catch (e) {
    ($("connect") as HTMLButtonElement).disabled = false;
    msg("connect-msg", explainError(e), "err");
  }
}

// ───────────────────────────── create ─────────────────────────────

function pinFeedback() {
  const p1 = ($("pin1") as HTMLInputElement).value;
  const p2 = ($("pin2") as HTMLInputElement).value;
  if (!p1) return msg("pin-msg", "");
  const c = checkPin(p1);
  if (!c.ok) return msg("pin-msg", c.reason ?? "Choose another PIN", "err");
  if (p2 && p1 !== p2) return msg("pin-msg", "The two PINs differ", "err");
  msg("pin-msg", c.warnings.length ? c.warnings.join(" · ") : p2 ? "OK" : "", c.warnings.length ? "info" : "ok");
}

async function onCreate() {
  if (!ctx || busy) return;
  const p1 = ($("pin1") as HTMLInputElement).value;
  const p2 = ($("pin2") as HTMLInputElement).value;
  const c = checkPin(p1);
  if (!c.ok) return msg("create-msg", c.reason ?? "Choose another PIN", "err");
  if (p1 !== p2) return msg("create-msg", "The two PINs differ.", "err");
  const limit = ($("limit") as HTMLInputElement).value.trim();
  try {
    if (ethers.parseEther(limit) <= 0n) throw new Error();
  } catch {
    return msg("create-msg", "Enter a limit in ETH, e.g. 0.01", "err");
  }
  busy = true;
  ($("create") as HTMLButtonElement).disabled = true;
  msg("create-msg", "8 transactions: confirm each one in your wallet. Encrypting can take a few seconds per step.", "info");
  const cb = renderSteps("setup-steps", SETUP_STEPS);
  try {
    const a = await createAndSetup(ctx, { pin: p1, limitEth: limit, known: null, escapeWallet }, cb);
    ($("pin1") as HTMLInputElement).value = "";
    ($("pin2") as HTMLInputElement).value = "";
    msg("create-msg", "Your account is ready.", "ok");
    busy = false;
    showAccount(a);
  } catch (e: any) {
    busy = false;
    ($("create") as HTMLButtonElement).disabled = false;
    msg("create-msg", `${explainError(e)} — press Create again to continue from this step.`, "err");
  }
}

function downloadEscapeKey() {
  const body = JSON.stringify(
    {
      note: "Escape address of an Encrypted Account demo (Sepolia testnet only). If an escape is started, the account's funds can only go to this address.",
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

// ───────────────────────────── deposit / send ─────────────────────────────

async function onDeposit(ev: Event) {
  ev.preventDefault();
  if (!ctx || !account || busy) return;
  let wei: bigint;
  try {
    wei = ethers.parseEther(($("dep-amt") as HTMLInputElement).value.trim());
    if (wei <= 0n) throw new Error();
  } catch {
    return msg("dep-msg", "Enter an amount in ETH", "err");
  }
  busy = true;
  try {
    const h = await deposit(ctx, account, wei, (t) => msg("dep-msg", t, "info"));
    const el = $("dep-msg");
    el.className = "msg ok";
    el.textContent = "Deposited · ";
    el.append(link(txUrl(h), "tx ↗"));
  } catch (e) {
    msg("dep-msg", explainError(e), "err");
  } finally {
    busy = false;
    void refresh();
  }
}

async function onSend(ev: Event) {
  ev.preventDefault();
  if (!ctx || !account || busy) return;
  const to = ($("to") as HTMLInputElement).value.trim();
  const pinEl = $("pin") as HTMLInputElement;
  const pin = pinEl.value;
  if (!ethers.isAddress(to) || to.toLowerCase() === account.toLowerCase()) return msg("send-msg", "Enter a recipient address (0x…)", "err");
  let wei: bigint;
  try {
    wei = ethers.parseEther(($("amt") as HTMLInputElement).value.trim());
    if (wei <= 0n) throw new Error();
  } catch {
    return msg("send-msg", "Enter an amount in ETH", "err");
  }
  if (!pin) return msg("send-msg", "Enter your PIN", "err");
  const bal = await read.getBalance(account);
  if (bal < wei) return msg("send-msg", "The account holds less than that: deposit first.", "err");

  busy = true;
  ($("send-btn") as HTMLButtonElement).disabled = true;
  msg("send-msg", "Up to 4 wallet confirmations. The decryption step takes about half a minute.", "info");
  const cb = renderSteps("send-steps", SEND_STEPS);
  try {
    const h = await sendWithPin(ctx, account, ethers.getAddress(to), wei, pin, cb);
    const el = $("send-msg");
    el.className = "msg ok";
    el.textContent = `Sent ${ethers.formatEther(wei)} ETH to ${short(to)} · `;
    el.append(link(txUrl(h), "tx ↗"));
  } catch (e: any) {
    if (e instanceof WrongPin) {
      const now = Math.floor(Date.now() / 1000);
      const wait = e.nextAllowedAt > now ? ` Next attempt in ${fmtWait(e.nextAllowedAt - now)}.` : "";
      msg("send-msg", `Wrong PIN: nothing was sent, and the attempt was counted on-chain (score ${e.score}).${wait}`, "err");
    } else msg("send-msg", explainError(e), "err");
  } finally {
    pinEl.value = "";
    busy = false;
    void refresh();
  }
}

// ───────────────────────────── start ─────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  $("connect").addEventListener("click", onConnect);
  $("create").addEventListener("click", onCreate);
  $("suggest").addEventListener("click", () => {
    const p = randomPin(6);
    ($("pin1") as HTMLInputElement).value = p;
    ($("pin2") as HTMLInputElement).value = p;
    ($("pin1") as HTMLInputElement).type = "text";
    msg("pin-msg", `Suggested PIN: ${p} — write it down now.`, "info");
  });
  $("pin1").addEventListener("input", pinFeedback);
  $("pin2").addEventListener("input", pinFeedback);
  $("escape-addr").textContent = escapeWallet.address;
  $("escape-dl").addEventListener("click", downloadEscapeKey);
  $("deposit-form").addEventListener("submit", onDeposit);
  $("send-form").addEventListener("submit", onSend);
  $("refresh").addEventListener("click", () => void refresh());
  ($("repo-link") as HTMLAnchorElement).href = REPO_URL;
  ($("factory-link") as HTMLAnchorElement).href = addrUrl(FACTORY);
  setInterval(() => void refresh(), 15000);

  const chip = $("fhe");
  fheClient(read)
    .then(() => {
      chip.textContent = "FHE ready";
      chip.className = "chip ok";
    })
    .catch((e) => {
      chip.textContent = "FHE failed to load";
      chip.className = "chip err";
      chip.title = String(e?.message ?? e);
    });
});
