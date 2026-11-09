/**
 * F0.12b — Encrypted input proof time on a phone (mobile gate, K58).
 *
 * The same page is served in two forms: /coi/ (COOP/COEP headers → crossOriginIsolated, multi-threaded TFHE) and
 * /plain/ (no headers → the SDK falls back to a single thread). Measured:
 *   - first load: TFHE WASM init, client ready (public key + CRS download), first encryption (warm-up)
 *   - PIN guess input (a single euint64): n = 10, 5 s apart; local proof / relayer / total; p50, p95, max
 *   - reference: one setupKnown input (12 eaddress)
 * No transaction is sent to the chain; only an input proof request goes to Zama's Sepolia relayer (no key needed).
 * There are no secret values: the addresses are the public Sepolia measurement account and the burner address, and
 * the values are random.
 */
import { ethers } from "ethers";
import { createFhevmEncryptClient, initFhevmEncryptRuntime, setFhevmRuntimeConfig } from "@fhevm/sdk/ethers";
import { sepolia } from "@fhevm/sdk/chains";
// SDK-internal module (the bundler uses the same module instance as the SDK): TFHE thread info
// @ts-ignore — types for this subpath are not published
import { getTfheModuleInfo } from "../../../node_modules/@fhevm/sdk/_esm/core/modules/encrypt/module/init-p.js";

const SCHEMA = "encrypted-account/proof-bench/v1";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const CONTRACT = "0x57508b3c82fEcfBF5e448058F36cC877Af097F7b"; // F0.9 e1 measurement account (Sepolia, public)
const USER = "0xcBdaED7D91644c771Aa84C5AbE5afFBB42a4d502"; // burner address (address only)
const N_RUNS = 10;
const GAP_MS = 5000;
const N_REF = 2;
/** Interim report §2.6: E1(phone) p95 ≈ E1(desktop) p95 − local proof(desktop) p95 + local proof(phone) p95 + Argon2id difference. */
const DESKTOP = { e1P95Ms: 47724, localP95Ms: 4454, argonP95Ms: 207, phoneArgonP95Ms: 321.6 };
const GATE_LOCAL_P95_MS = 16000; // K58

type FetchRec = { label: string; host: string; path: string; method: string; status: number; ms: number; bytes: number | null; error?: string };
const fetchLog: FetchRec[] = [];
let fetchLabel = "";
const origFetch = window.fetch.bind(window);
window.fetch = (async (input: any, init?: any) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href, location.href);
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  const t0 = performance.now();
  try {
    const res = await origFetch(input, init);
    const len = res.headers.get("content-length");
    fetchLog.push({ label: fetchLabel, host: url.host, path: url.pathname.slice(0, 80), method, status: res.status, ms: Math.round(performance.now() - t0), bytes: len ? Number(len) : null });
    return res;
  } catch (e: any) {
    fetchLog.push({ label: fetchLabel, host: url.host, path: url.pathname.slice(0, 80), method, status: -1, ms: Math.round(performance.now() - t0), bytes: null, error: String(e?.message ?? e).slice(0, 160) });
    throw e;
  }
}) as typeof fetch;

const $ = (id: string) => document.getElementById(id)!;
/** coi: server with COOP/COEP headers · plain: server without headers · plain-file: single file opened as a file on the phone. */
const variantOf = () => (location.pathname.includes("/coi/") ? "coi" : /^(file|content):$/.test(location.protocol) ? "plain-file" : "plain");
const log = (s: string) => {
  const el = $("log");
  el.textContent += `${new Date().toISOString().slice(11, 19)}  ${s}\n`;
  el.scrollTop = el.scrollHeight;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r1 = (x: number) => Math.round(x * 10) / 10;

function stats(a: number[]) {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  return { n: s.length, min: r1(s[0]), p50: r1(pct(50)), p95: r1(pct(95)), max: r1(s[s.length - 1]), mean: r1(s.reduce((x, y) => x + y, 0) / s.length) };
}

/** If the page drops to the background even for a moment during a run, that run is left out of the statistics. */
let runHidden = false;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") runHidden = true;
});

async function deviceInfo() {
  const nav: any = navigator;
  let ua: any = null;
  try {
    ua = nav.userAgentData ? await nav.userAgentData.getHighEntropyValues(["model", "platformVersion", "architecture"]) : null;
  } catch {
    ua = null;
  }
  return {
    label: ($("label") as HTMLInputElement).value.trim() || null,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: nav.deviceMemory ?? null,
    crossOriginIsolated: (self as any).crossOriginIsolated === true,
    isSecureContext: window.isSecureContext,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    uaData: ua ? { mobile: ua.mobile, platform: ua.platform, model: ua.model, platformVersion: ua.platformVersion, brands: ua.brands } : null,
  };
}

function resourceSizes(sinceMs: number) {
  return (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((r) => r.startTime >= sinceMs && !r.name.startsWith(location.origin))
    .map((r) => ({ url: r.name.replace(/\?.*$/, "").slice(0, 120), ms: Math.round(r.duration), transferSize: r.transferSize, encodedBodySize: r.encodedBodySize }));
}

async function run() {
  const btn = $("start") as HTMLButtonElement;
  btn.disabled = true;
  $("result").hidden = true;
  const out: any = { schema: SCHEMA, page: "bench/proof", variant: variantOf(), startedAtUtc: new Date().toISOString(), errors: [] };
  let wake: any = null;
  try {
    wake = await (navigator as any).wakeLock?.request("screen");
  } catch {
    wake = null;
  }
  out.wakeLock = Boolean(wake);
  try {
    out.device = await deviceInfo();
    log(`device: ${out.device.label || out.device.uaData?.model || out.device.platform} · cores ${out.device.hardwareConcurrency} · crossOriginIsolated = ${out.device.crossOriginIsolated}`);

    // ── first load
    const tRes = performance.now();
    fetchLabel = "init";
    let t0 = performance.now();
    setFhevmRuntimeConfig({ wasmAssetLoadMode: "embedded-base64" });
    await initFhevmEncryptRuntime();
    const initRuntimeMs = Math.round(performance.now() - t0);
    log(`TFHE runtime ready: ${initRuntimeMs} ms`);
    const provider = new ethers.JsonRpcProvider(RPC, 11155111, { staticNetwork: ethers.Network.from(11155111) });
    t0 = performance.now();
    const client: any = createFhevmEncryptClient({ provider, chain: sepolia });
    await client.ready;
    const clientReadyMs = Math.round(performance.now() - t0);
    log(`client ready (public key + CRS): ${clientReadyMs} ms`);
    let tfhe: any = null;
    try {
      const info = await getTfheModuleInfo({ tfheVersion: "1.6.2" });
      tfhe = info ? { tfheVersion: "1.6.2", numberOfThreads: info.numberOfThreads, threadsAvailable: info.threadsAvailable ?? null, wasmMemoryBytes: info.memory?.byteLength ?? null } : null;
    } catch {
      tfhe = null;
    }
    out.tfhe = tfhe;
    $("threads").textContent = tfhe ? `${tfhe.numberOfThreads} (${tfhe.numberOfThreads === 0 ? "single thread" : "multi-threaded"})` : "?";
    log(`TFHE threads: ${tfhe ? tfhe.numberOfThreads : "?"}`);

    const enc = async (values: { type: string; value: any }[], label: string) => {
      const start = fetchLog.length;
      fetchLabel = label;
      runHidden = document.visibilityState === "hidden";
      const t = performance.now();
      const r = await client.encryptValues({ values, contractAddress: CONTRACT, userAddress: USER });
      const totalMs = performance.now() - t;
      fetchLabel = "";
      const calls = fetchLog.slice(start);
      const relayerMs = calls.reduce((s, c) => s + c.ms, 0);
      const hidden = runHidden;
      return { totalMs: r1(totalMs), relayerMs: r1(relayerMs), localMs: r1(Math.max(0, totalMs - relayerMs)), httpCalls: calls.length, proofBytes: (String(r.inputProof).length - 2) / 2, hidden };
    };
    const rnd64 = () => {
      const b = crypto.getRandomValues(new Uint8Array(8));
      return b.reduce((x, v) => (x << 8n) | BigInt(v), 0n);
    };

    t0 = performance.now();
    const warm = await enc([{ type: "euint64", value: rnd64() }], "warmup");
    const resources = resourceSizes(tRes);
    const dl = (part: string) => resources.find((r) => r.url.includes(part))?.ms ?? null;
    const initFetches = fetchLog.filter((f) => f.label === "init");
    const bytesOf = (part: string) => initFetches.find((f) => f.path.includes(part))?.bytes ?? null;
    out.firstLoad = {
      initRuntimeMs,
      clientReadyMs,
      crsDownloadMs: dl("/CRS/"),
      crsBytes: bytesOf("/CRS/"),
      publicKeyDownloadMs: dl("/PublicKey/"),
      publicKeyBytes: bytesOf("/PublicKey/"),
      firstEncrypt: warm,
      totalMs: Math.round(performance.now() - tRes),
      note: "fetch 'ms' = time until the response headers; download time is in resources[].ms (PerformanceResourceTiming)",
      fetches: initFetches,
      resources,
    };
    log(`CRS ${out.firstLoad.crsBytes ?? "?"} bytes · download ${out.firstLoad.crsDownloadMs ?? "?"} ms`);
    log(`first encryption (warm-up): total ${warm.totalMs} ms (local ${warm.localMs}, relayer ${warm.relayerMs})`);

    // ── PIN guess input: n = 10, 5 s apart
    out.runs = [];
    for (let i = 0; i < N_RUNS; i++) {
      $("progress").textContent = `PIN input ${i + 1}/${N_RUNS}`;
      await sleep(i === 0 ? 500 : GAP_MS);
      const r = await enc([{ type: "euint64", value: rnd64() }], "pin");
      out.runs.push({ i, ...r });
      log(`PIN #${i + 1}: local ${r.localMs} ms · relayer ${r.relayerMs} ms · total ${r.totalMs} ms${r.hidden ? " (background — excluded)" : ""}`);
    }
    // ── reference: setupKnown input (12 eaddress)
    out.reference12 = [];
    for (let i = 0; i < N_REF; i++) {
      $("progress").textContent = `reference 12 eaddress ${i + 1}/${N_REF}`;
      await sleep(GAP_MS);
      const addrs = Array.from({ length: 12 }, () => ({ type: "eaddress", value: ethers.Wallet.createRandom().address }));
      const r = await enc(addrs, "ref12");
      out.reference12.push({ i, ...r });
      log(`12 eaddress #${i + 1}: local ${r.localMs} ms · relayer ${r.relayerMs} ms · total ${r.totalMs} ms`);
    }

    const ok = out.runs.filter((r: any) => !r.hidden);
    out.stats = { localMs: stats(ok.map((r: any) => r.localMs)), relayerMs: stats(ok.map((r: any) => r.relayerMs)), totalMs: stats(ok.map((r: any) => r.totalMs)), excludedHidden: out.runs.length - ok.length };
    const lp95 = out.stats.localMs.p95 as number;
    const e1p95 = DESKTOP.e1P95Ms - DESKTOP.localP95Ms + lp95 + (DESKTOP.phoneArgonP95Ms - DESKTOP.argonP95Ms);
    out.estimate = {
      formula: "E1(phone) p95 ≈ 47,724 − 4,454 + local proof p95 + (321.6 − 207) ms (interim report §2.6)",
      e1P95PhoneMs: Math.round(e1p95),
      gate: { rule: "K58: local proof p95 on a phone ≤ 16 s", localP95Ms: lp95, thresholdMs: GATE_LOCAL_P95_MS, pass: lp95 <= GATE_LOCAL_P95_MS },
    };
    $("r-local").textContent = `${out.stats.localMs.p50} / ${out.stats.localMs.p95} / ${out.stats.localMs.max} ms`;
    $("r-relayer").textContent = `${out.stats.relayerMs.p50} / ${out.stats.relayerMs.p95} / ${out.stats.relayerMs.max} ms`;
    $("r-total").textContent = `${out.stats.totalMs.p50} / ${out.stats.totalMs.p95} / ${out.stats.totalMs.max} ms`;
    $("r-ref").textContent = out.reference12.map((r: any) => `${r.localMs} ms`).join(" · ");
    $("r-first").textContent = `client ${(clientReadyMs / 1000).toFixed(1)} s (CRS download ${out.firstLoad.crsDownloadMs !== null ? (out.firstLoad.crsDownloadMs / 1000).toFixed(1) + " s" : "?"}) · first encryption ${(warm.totalMs / 1000).toFixed(1)} s`;
    $("r-e1").textContent = `≈ ${(e1p95 / 1000).toFixed(1)} s`;
    $("r-gate").textContent = out.estimate.gate.pass ? `PASS (local p95 ${(lp95 / 1000).toFixed(1)} s ≤ 16 s)` : `FAIL (local p95 ${(lp95 / 1000).toFixed(1)} s > 16 s)`;
    $("r-gate").className = out.estimate.gate.pass ? "pass" : "fail";
    log(`done: local p95 ${lp95} ms → mobile E1 p95 ≈ ${(e1p95 / 1000).toFixed(1)} s`);
  } catch (e: any) {
    out.errors.push(String(e?.stack ?? e?.message ?? e).slice(0, 1200));
    log(`ERROR: ${String(e?.message ?? e)}`);
  } finally {
    out.finishedAtUtc = new Date().toISOString();
    out.allFetches = fetchLog.map((f) => ({ ...f }));
    try {
      await wake?.release?.();
    } catch {
      /* none */
    }
    const json = JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
    ($("json") as HTMLTextAreaElement).value = json;
    // On the local measurement server (bench/proof/serve.mjs) the result is saved automatically; the hosted page has no such endpoint.
    if (/^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname)) {
      origFetch("/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: json })
        .then((r) => r.ok && log("result saved to the local server"))
        .catch(() => undefined);
    }
    $("result").hidden = false;
    $("progress").textContent = out.errors.length ? "error — send the JSON anyway" : "done";
    btn.disabled = false;
  }
}

async function copyJson() {
  const ta = $("json") as HTMLTextAreaElement;
  try {
    await navigator.clipboard.writeText(ta.value);
    $("copied").textContent = "copied ✓";
  } catch {
    ta.select();
    document.execCommand("copy");
    $("copied").textContent = "selected — copy it";
  }
}

function downloadJson() {
  const blob = new Blob([($("json") as HTMLTextAreaElement).value], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `proof-bench-${variantOf()}.json`;
  a.click();
}

window.addEventListener("DOMContentLoaded", () => {
  const coi = (self as any).crossOriginIsolated === true;
  const v = variantOf();
  $("variant").textContent = v === "coi" ? "with COOP/COEP headers (/coi/)" : v === "plain-file" ? "no headers · single file" : "no headers (/plain/)";
  $("coi").textContent = coi ? "yes" : "no";
  $("coi").className = coi ? "pass" : "warn";
  $("cores").textContent = String(navigator.hardwareConcurrency ?? "?");
  $("start").addEventListener("click", run);
  $("copy").addEventListener("click", copyJson);
  $("download").addEventListener("click", downloadJson);
});
