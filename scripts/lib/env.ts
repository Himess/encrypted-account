/**
 * `.env.sepolia` reader (no dependencies). The burner key lives ONLY in this file (Round 2 §4.0):
 * it never goes into the command line, logs, outputs or commits. This module never prints the key;
 * error messages do not include line contents either.
 */
import * as fs from "fs";
import * as path from "path";

export const ROOT = path.resolve(__dirname, "..", "..");
export const ENV_SEPOLIA = path.join(ROOT, ".env.sepolia");

/** Public Sepolia RPCs (keyless). If SEPOLIA_RPC_URL is set in `.env.sepolia`, it is tried first. */
// (sepolia.drpc.org returned 400 to a keyless request in the 2026-11-08 preflight; removed from the list.)
export const DEFAULT_SEPOLIA_RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.gateway.tenderly.co",
  "https://1rpc.io/sepolia",
];

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // silently skip an invalid line (never print its contents)
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readEnvSepolia(): Record<string, string> {
  if (!fs.existsSync(ENV_SEPOLIA)) return {};
  return parseDotEnv(fs.readFileSync(ENV_SEPOLIA, "utf8"));
}

/** Is there a key? (Does not return the value itself.) */
export function hasSepoliaKey(env = readEnvSepolia()): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(env.SEPOLIA_PRIVATE_KEY ?? "");
}

/**
 * Returns the key; called only to build a signer. The caller must not log the value.
 */
export function sepoliaPrivateKey(env = readEnvSepolia()): string {
  const k = env.SEPOLIA_PRIVATE_KEY ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error("no valid SEPOLIA_PRIVATE_KEY in .env.sepolia. First run: npx hardhat run scripts/burner.ts");
  }
  return k;
}

/** Watchtower (guardian) wallet: a separate, randomly generated second burner. Same rules: .env.sepolia only. */
export function hasWatchtowerKey(env = readEnvSepolia()): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(env.SEPOLIA_WATCHTOWER_KEY ?? "");
}

export function sepoliaWatchtowerKey(env = readEnvSepolia()): string {
  const k = env.SEPOLIA_WATCHTOWER_KEY ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error("no SEPOLIA_WATCHTOWER_KEY in .env.sepolia. First run: npx hardhat run scripts/burner.ts");
  }
  return k;
}

export function sepoliaRpcUrls(env = readEnvSepolia()): string[] {
  const own = (env.SEPOLIA_RPC_URL ?? env.SEPOLIA_RPC_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//.test(s));
  return [...new Set([...own, ...DEFAULT_SEPOLIA_RPCS])];
}

/** Is the given pattern present as a line in .gitignore? */
export function gitignoreHas(pattern: string): boolean {
  const gi = path.join(ROOT, ".gitignore");
  if (!fs.existsSync(gi)) return false;
  return fs
    .readFileSync(gi, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .includes(pattern);
}

export function ensureGitignore(patterns: string[]): string[] {
  const gi = path.join(ROOT, ".gitignore");
  const added: string[] = [];
  for (const p of patterns) {
    if (!gitignoreHas(p)) {
      const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
      fs.writeFileSync(gi, cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + p + "\n");
      added.push(p);
    }
  }
  return added;
}
