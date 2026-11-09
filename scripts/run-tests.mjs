// Runs each test file in a separate process.
// Why: @fhevm/hardhat-plugin 0.13.0-1 (alpha) + Hardhat 2.29 EDR occasionally segfaults natively on Windows when
// many files run in one process (non-deterministic; the same files pass when run again).
// Rule: a test FAILURE is never retried; only a process CRASH (segfault) is retried, at most 2 times,
// and it is logged.
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const cli = join(root, "node_modules", "hardhat", "internal", "cli", "cli.js");
// --record: also write the evidence files under results/ (the tests check WRITE_RESULTS) and the run summary.
const record = process.argv.includes("--record");
if (record) process.env.WRITE_RESULTS = "1";
const only = process.argv.slice(2).filter((a) => a !== "--record");
const files = (only.length ? only : readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.ts")).sort()).map((f) =>
  f.startsWith("test/") ? f : `test/${f}`,
);

const isCrash = (r) => r.status === null || r.status === 139 || r.status === 3221225477 || (r.status ?? 0) >= 3221225472;
const summary = [];
let failed = false;
let log = "";

for (const f of files) {
  let attempt = 0;
  for (;;) {
    attempt++;
    const r = spawnSync(process.execPath, [cli, "test", f], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    process.stdout.write(out);
    log += `\n===== ${f} (attempt ${attempt}) status=${r.status} signal=${r.signal}\n` + out;
    const passing = /(\d+) passing/.exec(out)?.[1] ?? "0";
    const failing = /(\d+) failing/.exec(out)?.[1] ?? "0";
    if (r.status === 0) {
      summary.push({ file: f, passing: Number(passing), failing: 0, attempts: attempt, crashRetries: attempt - 1 });
      break;
    }
    if (isCrash(r) && failing === "0" && attempt < 3) {
      console.log(`\n[run-tests] ${f}: process crashed (status=${r.status}), retrying…\n`);
      continue;
    }
    failed = true;
    summary.push({ file: f, passing: Number(passing), failing: Number(failing), attempts: attempt, crashRetries: attempt - 1, crashed: isCrash(r) });
    break;
  }
}

console.table(summary);
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "test-run.log"), log);
if (record) writeFileSync(join(root, "results", "test-summary.json"), JSON.stringify({ evidence: "[Mock]", date: new Date().toISOString(), summary }, null, 2));
process.exit(failed ? 1 : 0);
