/**
 * F0.9 side experiment — client-side encryption + input proof time: multi-threaded (default, navigator.hardwareConcurrency)
 * vs single-threaded TFHE WASM. On a phone, if the page is not served with COOP/COEP headers, the SDK falls back to one thread;
 * this experiment measures the size of that difference on a desktop. No transactions are sent (only input-proof requests to the relayer).
 *
 *   ENC_SINGLE_THREAD=1 npx hardhat run scripts/sepolia/enc-threads.ts   (single thread)
 *   npx hardhat run scripts/sepolia/enc-threads.ts                       (multi-thread)
 * Environment: ENC_N (8). Output: results/sepolia/enc-threads.json (the two runs are merged into the same file)
 */
import * as os from "os";
import * as path from "path";
import { ROOT } from "../lib/env";
import { encryptTimed, makeLiveCtx, writeJson } from "../lib/live";
import { loadF09, readJson, summarize } from "./f09-lib";

async function main() {
  const single = process.env.ENC_SINGLE_THREAD === "1";
  const n = Number(process.env.ENC_N ?? 8);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk: any = require("@fhevm/sdk/ethers");
  if (!sdk.hasFhevmRuntimeConfig()) sdk.setFhevmRuntimeConfig(single ? { singleThread: true } : {});
  const ctx = await makeLiveCtx();
  const st = loadF09();
  const acct = st.accounts?.e1?.address;
  if (!acct) throw new Error("no e1 account");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const m = require(path.join(ROOT, "node_modules", "@fhevm", "sdk", "_cjs", "core", "modules", "encrypt", "module", "init-p.js"));
  const runs: any[] = [];
  for (let i = 0; i < n + 1; i++) {
    const e = await encryptTimed(ctx, [{ type: "euint64", value: BigInt(1000 + i) }], acct, ctx.user.address);
    if (i > 0) runs.push(e.timing); // the first run is a warm-up
    console.log(`${single ? "single" : "multi"}-thread #${i}: total ${e.timing.totalMs} ms (local ${e.timing.localMs}, relayer ${e.timing.relayerHttpMs})${i === 0 ? " [warm-up]" : ""}`);
  }
  const info = await m.getTfheModuleInfo({ tfheVersion: "1.6.2" }).catch(() => null);
  const key = single ? "singleThread" : "multiThread";
  const prev = readJson("enc-threads.json") ?? { evidence: "[M] desktop (relayer.testnet.zama.org input proof)", note: "1 × euint64 (PIN guess format); first run is a warm-up, excluded", runs: {} };
  prev.client = { node: process.version, cpu: os.cpus()[0]?.model ?? "?", cores: os.cpus().length };
  prev.runs[key] = {
    atUtc: new Date().toISOString(),
    tfhe: info ? { numberOfThreads: info.numberOfThreads, threadsAvailable: info.threadsAvailable ?? null } : null,
    totalMs: summarize(runs.map((r) => r.totalMs)),
    localMs: summarize(runs.map((r) => r.localMs)),
    relayerMs: summarize(runs.map((r) => r.relayerHttpMs)),
    samples: runs,
  };
  writeJson("enc-threads.json", prev);
  console.log(`${key}: local p50 ${prev.runs[key].localMs.p50} ms, p95 ${prev.runs[key].localMs.p95} ms · threads ${info?.numberOfThreads}`);
  ctx.provider.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
