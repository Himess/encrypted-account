/**
 * Resilient infrastructure for the Sepolia network (Round 2, F0.8.2):
 *  - A provider that rotates between several public RPCs and retries transient errors with exponential back-off
 *    (429/5xx/timeout/dropped connection). Deterministic JSON-RPC errors (revert, nonce) are not retried.
 *  - Retrying `eth_sendRawTransaction` is safe: the same signed transaction is sent; "already known" counts as success.
 *  - Local nonce counter and adjustable priority fee; a stuck transaction is replaced with the same nonce and a higher fee.
 *  - Balance threshold: if insufficient, an `InsufficientFunds` error stating the shortfall (scripts resume where they left off).
 * The private key is never printed under any circumstances.
 */
import { ethers } from "ethers";
import { readEnvSepolia, sepoliaPrivateKey, sepoliaRpcUrls } from "./env";

export const SEPOLIA_CHAIN_ID = 11155111;
export const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const gwei = (x: bigint) => Number(x) / 1e9;
export const eth = (x: bigint) => ethers.formatEther(x);

const TRANSIENT =
  /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network error|fetch failed|bad gateway|service unavailable|gateway time|too many requests|rate.?limit|limit exceeded|request limit|429|502|503|504|header not found|missing trie node|try again|temporar|overload|busy|capacity|internal error|upstream|no response|could not detect network|failed to respond/i;

export function isTransient(e: any): boolean {
  if (!e) return false;
  if (e.code === "TIMEOUT" || e.code === "SERVER_ERROR" || e.code === "NETWORK_ERROR") return true;
  const msg = String(e.shortMessage ?? e.message ?? e);
  if (/execution reverted|revert|insufficient funds|nonce too low|invalid argument/i.test(msg)) return false;
  return TRANSIENT.test(msg);
}

export type RpcStats = {
  calls: number;
  retries: number;
  rotations: number;
  perUrl: Record<string, { ok: number; fail: number }>;
};

export class ResilientProvider extends ethers.JsonRpcProvider {
  readonly urls: string[];
  readonly stats: RpcStats;
  tipFloor: bigint;
  tipCap: bigint;
  private idx = 0;
  private readonly maxAttempts: number;

  constructor(urls: string[], opts: { maxAttempts?: number; pollingInterval?: number; tipFloorGwei?: string; tipCapGwei?: string } = {}) {
    if (urls.length === 0) throw new Error("no RPC URL");
    const network = ethers.Network.from(SEPOLIA_CHAIN_ID);
    super(urls[0], network, { staticNetwork: network, batchMaxCount: 1, pollingInterval: opts.pollingInterval ?? 1000 });
    this.urls = urls;
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.tipFloor = ethers.parseUnits(opts.tipFloorGwei ?? "0.05", "gwei");
    this.tipCap = ethers.parseUnits(opts.tipCapGwei ?? "5", "gwei");
    this.stats = { calls: 0, retries: 0, rotations: 0, perUrl: Object.fromEntries(urls.map((u) => [u, { ok: 0, fail: 0 }])) };
  }

  get currentUrl() {
    return this.urls[this.idx];
  }

  /** Prefer a specific RPC (the preflight picks the fastest working one). */
  prefer(url: string) {
    const i = this.urls.indexOf(url);
    if (i >= 0) this.idx = i;
  }

  override _getConnection(): ethers.FetchRequest {
    const req = new ethers.FetchRequest(this.urls[this.idx]);
    req.timeout = 30_000;
    req.setThrottleParams({ maxAttempts: 4, slotInterval: 500 });
    return req;
  }

  // @ts-expect-error ethers' declared return type of _send is narrower than what JSON-RPC backends can return
  override async _send(payload: ethers.JsonRpcPayload | Array<ethers.JsonRpcPayload>): Promise<Array<ethers.JsonRpcResult | ethers.JsonRpcError>> {
    const single: any = Array.isArray(payload) ? payload[0] : payload;
    const method: string = single?.method ?? "";
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const url = this.urls[this.idx];
      this.stats.calls++;
      try {
        const res = await super._send(payload);
        const errItem: any = res.find((r: any) => r && r.error);
        if (errItem) {
          const m = String(errItem.error?.message ?? "");
          if (method === "eth_sendRawTransaction") {
            // Resending the same signed transaction: if the node already knows it, count it as success.
            const already = /already known|known transaction|already imported|ALREADY_EXISTS/i.test(m);
            const minedBefore = attempt > 0 && /nonce too low/i.test(m);
            if (already || minedBefore) {
              this.mark(url, true);
              return [{ id: errItem.id, result: ethers.keccak256(single.params[0]) } as any];
            }
          } else if (TRANSIENT.test(m) && !/revert/i.test(m)) {
            throw Object.assign(new Error(m), { code: "SERVER_ERROR" });
          }
        }
        this.mark(url, true);
        return res;
      } catch (e) {
        lastErr = e;
        this.mark(url, false);
        if (!isTransient(e)) throw e;
        this.stats.retries++;
        if (this.urls.length > 1) {
          this.idx = (this.idx + 1) % this.urls.length;
          this.stats.rotations++;
        }
        await sleep(Math.min(15_000, 400 * 2 ** attempt) * (0.5 + Math.random()));
      }
    }
    throw lastErr;
  }

  private mark(url: string, ok: boolean) {
    const s = (this.stats.perUrl[url] ??= { ok: 0, fail: 0 });
    if (ok) s.ok++;
    else s.fail++;
  }

  /** Base fee + priority fee (the node's suggestion, clamped to [floor, cap]). */
  override async getFeeData(): Promise<ethers.FeeData> {
    const [block, tipHex] = await Promise.all([this.getBlock("latest"), this.send("eth_maxPriorityFeePerGas", []).catch(() => null)]);
    const base = block?.baseFeePerGas ?? 0n;
    let tip = tipHex ? BigInt(tipHex) : this.tipFloor;
    if (tip < this.tipFloor) tip = this.tipFloor;
    if (tip > this.tipCap) tip = this.tipCap;
    return new ethers.FeeData(base + tip, base * 2n + tip, tip);
  }
}

/** A wallet that keeps a local nonce counter and queues its sends. */
export class ManagedWallet extends ethers.Wallet {
  private nextNonce: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  override async getNonce(_blockTag?: ethers.BlockTag): Promise<number> {
    if (this.nextNonce === null) this.nextNonce = await this.provider!.getTransactionCount(this.address, "pending");
    return this.nextNonce;
  }

  resyncNonce() {
    this.nextNonce = null;
  }

  override async sendTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionResponse> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await super.sendTransaction(tx);
          this.nextNonce = res.nonce + 1;
          return res;
        } catch (e: any) {
          const m = String(e?.shortMessage ?? e?.message ?? e);
          if (attempt < 3 && tx.nonce == null && /nonce too low|nonce has already been used|NONCE_EXPIRED|replacement transaction underpriced|nonce too high/i.test(m)) {
            this.nextNonce = null;
            await sleep(1500);
            continue;
          }
          throw e;
        }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}

export class InsufficientFunds extends Error {
  constructor(
    readonly address: string,
    readonly balance: bigint,
    readonly needed: bigint,
    readonly context: string,
  ) {
    super(
      `Insufficient balance (${context}): balance ${eth(balance)} ETH, at least ${eth(needed)} ETH needed, short by ${eth(needed - balance)} ETH. ` +
        `After funding address ${address}, run the same command again; the script resumes where it left off.`,
    );
  }
}

export async function ensureBalance(provider: ethers.Provider, address: string, gasNeeded: bigint, context: string, extraWei = 0n) {
  const fee = await provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const needed = gasNeeded * price + extraWei;
  const bal = await provider.getBalance(address);
  if (bal < needed) throw new InsufficientFunds(address, bal, needed, context);
  return { balance: bal, needed, price };
}

export type TxRecord = {
  label: string;
  hash: string;
  nonce: number;
  blockNumber: number;
  blockTimestamp: number;
  sentAtUtc: string;
  minedSeenAtUtc: string;
  inclusionMs: number;
  gasUsed: string;
  effectiveGasPriceWei: string;
  costWei: string;
  replacements: number;
};

/**
 * Sends the transaction and waits for inclusion. If it is not included within `timeoutMs`, it is replaced with the same
 * nonce at double the fees (at most `maxBumps` times).
 */
export async function sendTx(
  signer: ManagedWallet,
  label: string,
  build: () => Promise<ethers.TransactionRequest>,
  opts: { timeoutMs?: number; maxBumps?: number; gasLimit?: bigint; pollMs?: number } = {},
): Promise<TxRecord & { receipt: ethers.TransactionReceipt }> {
  const provider = signer.provider as ResilientProvider;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBumps = opts.maxBumps ?? 3;
  const pollMs = opts.pollMs ?? 1000;
  const req = await build();
  if (opts.gasLimit) req.gasLimit = opts.gasLimit;
  const sentAt = Date.now();
  const t0 = performance.now();
  let res = await signer.sendTransaction(req);
  const hashes = [res.hash];
  let bumps = 0;
  let receipt: ethers.TransactionReceipt | null = null;
  for (;;) {
    try {
      receipt = await waitAny(provider, hashes, timeoutMs, pollMs);
      break;
    } catch (e: any) {
      if (!/timeout/i.test(String(e?.message)) || bumps >= maxBumps) throw e;
      bumps++;
      const fee = await provider.getFeeData();
      const prevMax = res.maxFeePerGas ?? fee.maxFeePerGas!;
      const prevTip = res.maxPriorityFeePerGas ?? fee.maxPriorityFeePerGas!;
      const tip = bigMax(prevTip * 2n, fee.maxPriorityFeePerGas!);
      const maxFee = bigMax(prevMax * 2n, fee.maxFeePerGas! + tip);
      res = await signer.sendTransaction({
        to: res.to ?? undefined,
        data: res.data,
        value: res.value,
        gasLimit: res.gasLimit,
        nonce: res.nonce,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
        chainId: SEPOLIA_CHAIN_ID,
        type: 2,
      });
      hashes.push(res.hash);
      console.log(`  ↻ ${label}: not included within ${timeoutMs / 1000} s, fee bumped (#${bumps})`);
    }
  }
  const t1 = performance.now();
  if (!receipt || receipt.status !== 1) {
    const err: any = new Error(`${label}: transaction reverted (${receipt?.hash})`);
    err.receipt = receipt;
    throw err;
  }
  const block = await provider.getBlock(receipt.blockNumber);
  return {
    label,
    hash: receipt.hash,
    nonce: res.nonce,
    blockNumber: receipt.blockNumber,
    blockTimestamp: block?.timestamp ?? 0,
    sentAtUtc: new Date(sentAt).toISOString(),
    minedSeenAtUtc: new Date().toISOString(),
    inclusionMs: Math.round(t1 - t0),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPriceWei: receipt.gasPrice.toString(),
    costWei: (receipt.gasUsed * receipt.gasPrice).toString(),
    replacements: bumps,
    receipt,
  };
}

async function waitAny(provider: ethers.Provider, hashes: string[], timeoutMs: number, pollMs = 1000): Promise<ethers.TransactionReceipt> {
  const t0 = Date.now();
  for (;;) {
    for (const h of hashes) {
      const rc = await provider.getTransactionReceipt(h);
      if (rc) return rc;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for receipt");
    await sleep(pollMs);
  }
}

const bigMax = (a: bigint, b: bigint) => (a > b ? a : b);

export function makeProvider(opts?: ConstructorParameters<typeof ResilientProvider>[1]) {
  return new ResilientProvider(sepoliaRpcUrls(readEnvSepolia()), opts);
}

export function makeSigner(provider: ResilientProvider): ManagedWallet {
  return new ManagedWallet(sepoliaPrivateKey(readEnvSepolia()), provider);
}

/** Tries every RPC; reports chain id and latency, and prefers the fastest working one. */
export async function probeRpcs(provider: ResilientProvider) {
  const rows: { url: string; ok: boolean; chainId?: number; block?: number; ms?: number; error?: string }[] = [];
  for (const url of provider.urls) {
    const p = new ethers.JsonRpcProvider(url, SEPOLIA_CHAIN_ID, { staticNetwork: ethers.Network.from(SEPOLIA_CHAIN_ID), batchMaxCount: 1 });
    const t0 = performance.now();
    try {
      const [cid, bn] = await Promise.all([p.send("eth_chainId", []), p.getBlockNumber()]);
      rows.push({ url, ok: Number(cid) === SEPOLIA_CHAIN_ID, chainId: Number(cid), block: bn, ms: Math.round(performance.now() - t0) });
    } catch (e: any) {
      rows.push({ url, ok: false, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 120) });
    } finally {
      p.destroy();
    }
  }
  const best = rows.filter((r) => r.ok).sort((a, b) => (a.ms ?? 1e9) - (b.ms ?? 1e9))[0];
  if (best) provider.prefer(best.url);
  return { rows, best: best?.url };
}

/** Generic retry for relayer/SDK calls. */
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5, baseMs = 1000): Promise<{ value: T; retries: number }> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return { value: await fn(), retries: i };
    } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(baseMs * 2 ** i * (0.5 + Math.random()));
    }
  }
  throw new Error(`${label}: failed after ${attempts} attempts: ${String((last as any)?.message ?? last).slice(0, 300)}`);
}
