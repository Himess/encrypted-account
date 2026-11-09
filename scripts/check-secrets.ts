/**
 * F0.8 acceptance check: is the burner key absent from every file, output and (if any) git history other than `.env.sepolia`?
 * The key is never printed; only matching file paths are reported.
 *
 *   npx hardhat run scripts/check-secrets.ts            (repo + results + Claude session logs)
 *   EXTRA_SCAN_DIRS="C:\path1;C:\path2" npx hardhat run scripts/check-secrets.ts
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ENV_SEPOLIA, ROOT, gitignoreHas, hasSepoliaKey, hasWatchtowerKey, readEnvSepolia, sepoliaPrivateKey, sepoliaWatchtowerKey } from "./lib/env";

const SKIP_DIRS = new Set(["node_modules", "artifacts", "cache", "fhevmTemp", ".git"]);

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(p);
    } else if (e.isFile()) yield p;
  }
}

function main() {
  const env = readEnvSepolia();
  if (!hasSepoliaKey(env)) throw new Error("no key in .env.sepolia.");
  // Case-insensitive search: the content is lower-cased. Burner + (if present) watchtower key.
  const needles = [sepoliaPrivateKey(env)];
  if (hasWatchtowerKey(env)) needles.push(sepoliaWatchtowerKey(env));
  const hexes = needles.map((k) => k.toLowerCase().slice(2));

  const roots = [ROOT];
  const claudeProj = path.join(os.homedir(), ".claude", "projects", "C--Users-USER-Desktop-zamapin");
  if (fs.existsSync(claudeProj)) roots.push(claudeProj);
  for (const d of (process.env.EXTRA_SCAN_DIRS ?? "").split(";").filter(Boolean)) roots.push(d);

  let scanned = 0;
  const hits: string[] = [];
  for (const r of roots) {
    for (const f of walk(r)) {
      if (path.resolve(f) === path.resolve(ENV_SEPOLIA)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      if (st.size > 200 * 1024 * 1024) continue;
      scanned++;
      const content = fs.readFileSync(f, "latin1").toLowerCase();
      if (hexes.some((h) => content.includes(h))) hits.push(f);
    }
  }

  let gitStatus = "not a git repository (no commit history)";
  if (fs.existsSync(path.join(ROOT, ".git"))) {
    try {
      const log = execFileSync("git", ["-C", ROOT, "log", "--all", "-p", "--no-color"], { maxBuffer: 1 << 30 }).toString("latin1").toLowerCase();
      gitStatus = hexes.some((h) => log.includes(h)) ? "WARNING: found in git history" : "not in git history";
    } catch (e: any) {
      gitStatus = `could not read git log: ${String(e?.message).slice(0, 80)}`;
    }
  }

  // Verify in a temporary git repository that the .gitignore pattern really works
  let ignoreCheck = "skipped";
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gi-check-"));
    fs.copyFileSync(path.join(ROOT, ".gitignore"), path.join(tmp, ".gitignore"));
    fs.writeFileSync(path.join(tmp, ".env.sepolia"), "x");
    fs.mkdirSync(path.join(tmp, "results", "private"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "results", "private", "a.md"), "x");
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    const out = execFileSync("git", ["check-ignore", ".env.sepolia", "results/private/a.md"], { cwd: tmp }).toString().trim().split(/\r?\n/);
    ignoreCheck = out.length === 2 ? "✓ .env.sepolia and results/private/ are ignored by git" : `✗ unexpected: ${out.join(",")}`;
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e: any) {
    ignoreCheck = `✗ git check-ignore failed: ${String(e?.message).slice(0, 120)}`;
  }

  const report = {
    checkedAtUtc: new Date().toISOString(),
    keysChecked: hexes.length,
    scannedFiles: scanned,
    roots,
    hits,
    gitignoreHasEnvSepolia: gitignoreHas(".env.sepolia"),
    gitignoreHasResultsPrivate: gitignoreHas("results/private/"),
    gitIgnoreCheck: ignoreCheck,
    gitHistory: gitStatus,
  };
  fs.mkdirSync(path.join(ROOT, "results", "sepolia"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "results", "sepolia", "secret-check.json"), JSON.stringify(report, null, 2));
  console.log(`Files scanned: ${scanned} (${roots.length} roots)`);
  console.log(hits.length === 0 ? "✓ The key is in no file other than .env.sepolia." : `✗ The key was found in these files:\n  ${hits.join("\n  ")}`);
  console.log(`  ${ignoreCheck}`);
  console.log(`  Git: ${gitStatus}`);
  if (hits.length) process.exit(2);
}

main();
