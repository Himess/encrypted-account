// E17 (desktop/Node leg): Argon2id v1 (m=64MiB, t=3, p=1) timing. A phone/WASM-browser measurement is needed separately.
import { argon2id } from "hash-wasm";
import { cpus } from "node:os";
const N = Number(process.env.N ?? 20);
const salt = new Uint8Array(32).fill(7);
const times = [];
for (let i = 0; i < N + 2; i++) {
  const t0 = performance.now();
  await argon2id({ password: `48291${i % 10}`, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: "binary" });
  const dt = performance.now() - t0;
  if (i >= 2) times.push(dt); // the first 2 runs are warm-up
}
times.sort((a, b) => a - b);
const p = (q) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)];
const out = { evidence: "[M] desktop", node: process.version, cpu: cpus()[0]?.model, runs: N, p50ms: Math.round(p(0.5)), p95ms: Math.round(p(0.95)), minms: Math.round(times[0]), maxms: Math.round(times[times.length - 1]) };
console.log(JSON.stringify(out, null, 2));
import("node:fs").then((fs) => fs.writeFileSync("results/argon2id-desktop.json", JSON.stringify(out, null, 2)));
