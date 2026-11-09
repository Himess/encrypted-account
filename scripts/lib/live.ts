/**
 * Shared context for the Sepolia measurement scripts: provider + wallets + `@fhevm/sdk` client + saved build +
 * resumable state file + timing of relayer calls.
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { Build, loadBuild } from "./deploy";
import { ROOT, hasWatchtowerKey, readEnvSepolia, sepoliaWatchtowerKey } from "./env";
import { FhevmLiveClient, makeFhevmClient } from "./fhevm";
import { ManagedWallet, ResilientProvider, makeProvider, makeSigner, probeRpcs, sleep } from "./net";

export const OUT_DIR = path.join(ROOT, "results", "sepolia");
export const BASELINE_BUILD = path.join(OUT_DIR, "baseline", "build.json");
/** Sepolia run: "baseline" (F0.9, Round 1 build; default) or "f010" (F0.10 build, results/sepolia/f010/). */
export const SEP_RUN = process.env.SEP_RUN ?? "baseline";
export const RUN_BUILD = SEP_RUN === "baseline" ? BASELINE_BUILD : path.join(OUT_DIR, SEP_RUN, "build.json");
/** Output name per run: unchanged for the baseline (the F0.9 files are kept), a "-<run>" suffix for the others. */
export const runFile = (name: string) => (SEP_RUN === "baseline" ? name : name.replace(/\.json$/, `-${SEP_RUN}.json`));

// ── relayer/fetch measurement: duration, status and size of every HTTP call
export type FetchRec = { label: string; host: string; path: string; method: string; status: number; ms: number; bytes: number | null };
const fetchLog: FetchRec[] = [];
let fetchLabel = "";
let fetchPatched = false;

export function patchFetch() {
  if (fetchPatched) return;
  fetchPatched = true;
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const t0 = performance.now();
    const res = await orig(input, init);
    const len = res.headers.get("content-length");
    const method = typeof init?.method === "string" ? init.method : typeof input === "object" && typeof input.method === "string" ? input.method : "GET";
    fetchLog.push({
      label: fetchLabel,
      host: url.host,
      path: url.pathname.slice(0, 80),
      method: method.toUpperCase(),
      status: res.status,
      ms: Math.round(performance.now() - t0),
      bytes: len ? Number(len) : null,
    });
    return res;
  }) as typeof fetch;
}

export function withFetchLabel<T>(label: string, fn: () => Promise<T>): Promise<{ value: T; calls: FetchRec[] }> {
  const start = fetchLog.length;
  fetchLabel = label;
  return fn().then(
    (value) => {
      fetchLabel = "";
      return { value, calls: fetchLog.slice(start) };
    },
    (e) => {
      fetchLabel = "";
      throw e;
    },
  );
}

export function allFetches() {
  return fetchLog;
}

// ── state file (resumability)
export type State = Record<string, any>;
export function loadState(file: string): State {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}
export function saveState(file: string, s: State) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}
export function writeJson(name: string, obj: unknown) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

export type LiveCtx = {
  provider: ResilientProvider;
  user: ManagedWallet;
  watchtower: ManagedWallet | null;
  client: FhevmLiveClient;
  build: Build;
  clientReadyMs: number;
};

export async function makeLiveCtx(): Promise<LiveCtx> {
  patchFetch();
  const provider = makeProvider();
  await probeRpcs(provider);
  const user = makeSigner(provider);
  const env = readEnvSepolia();
  const watchtower = hasWatchtowerKey(env) ? new ManagedWallet(sepoliaWatchtowerKey(env), provider) : null;
  const t0 = performance.now();
  const client = await makeFhevmClient(provider);
  const clientReadyMs = Math.round(performance.now() - t0);
  return { provider, user, watchtower, client, build: loadBuild(RUN_BUILD), clientReadyMs };
}

/** Encryption + input proof; splits the total time into relayer network time and the local part. */
export async function encryptTimed(
  ctx: LiveCtx,
  values: { type: string; value: boolean | bigint | number | string }[],
  contractAddress: string,
  userAddress: string,
) {
  const t0 = performance.now();
  const { value, calls } = await withFetchLabel("encrypt", () => ctx.client.encryptValues({ values, contractAddress, userAddress }));
  const totalMs = Math.round(performance.now() - t0);
  const relayerMs = calls.reduce((s, c) => s + c.ms, 0);
  return {
    handles: [...value.encryptedValues] as string[],
    inputProof: value.inputProof,
    timing: { totalMs, relayerHttpMs: relayerMs, localMs: Math.max(0, totalMs - relayerMs), httpCalls: calls.length },
  };
}

/**
 * Public decryption: retries until ready. Returns the result, the number of attempts, the waiting time and the block at which it was ready.
 */
export async function publicDecryptWhenReady(ctx: LiveCtx, handles: string[], timeoutMs = 600_000) {
  const t0 = performance.now();
  let attempts = 0;
  let lastErr = "";
  const progress: { type: string; step?: number; totalSteps?: number; retryCount?: number; t: number }[] = [];
  for (;;) {
    attempts++;
    try {
      const { value, calls } = await withFetchLabel("publicDecrypt", () =>
        ctx.client.decryptPublicValuesWithSignatures({
          encryptedValues: handles,
          options: {
            onProgress: (a: any) =>
              progress.push({ type: a.type, step: a.step, totalSteps: a.totalSteps, retryCount: a.retryCount, t: Math.round(performance.now() - t0) }),
          },
        }),
      );
      const readyBlock = await ctx.provider.getBlockNumber();
      return {
        clearValues: value.clearValues.map((v: any) => (v && typeof v === "object" && "value" in v ? v.value : v)),
        abiEncodedClearValues: value.checkSignaturesArgs.abiEncodedCleartexts,
        decryptionProof: value.checkSignaturesArgs.decryptionProof,
        waitedMs: Math.round(performance.now() - t0),
        attempts,
        readyBlock,
        httpCalls: calls.length,
        progress: progress.slice(-12),
        lastError: lastErr || null,
      };
    } catch (e: any) {
      lastErr = String(e?.message ?? e).slice(0, 240);
      if (performance.now() - t0 > timeoutMs) throw new Error(`publicDecrypt timeout (${attempts} attempts): ${lastErr}`);
      await sleep(1500);
    }
  }
}

export function clearValueBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "true" || v === "1";
  return Boolean(v);
}

export const ETH_ADDR = ethers.ZeroAddress;
