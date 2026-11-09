/**
 * F0.8.1 — Generates a Sepolia burner wallet used only for this work.
 *
 *   npx hardhat run scripts/burner.ts
 *
 * - The private key is written only to `.env.sepolia`; never to the screen, logs or results/.
 * - If `.env.sepolia` already holds a valid key it is NOT TOUCHED (so a funded wallet is not lost);
 *   only the address is printed again.
 * - Before writing, it makes sure the `.env.sepolia` pattern is in .gitignore.
 *
 * Key rotation (if the key leaked): BURNER_ROTATE=1 npx hardhat run scripts/burner.ts
 *   Stops if the old address has a non-zero Sepolia balance (override with BURNER_ROTATE_FORCE=1). The old file is
 *   kept as `.env.sepolia.old-<time>` (covered by the `.env.*` pattern in .gitignore; kept to recover funds sent
 *   there by mistake), then a new key is generated.
 */
import { randomBytes } from "crypto";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  ENV_SEPOLIA,
  ROOT,
  ensureGitignore,
  gitignoreHas,
  hasSepoliaKey,
  hasWatchtowerKey,
  readEnvSepolia,
  sepoliaPrivateKey,
  sepoliaRpcUrls,
  sepoliaWatchtowerKey,
} from "./lib/env";

async function rotate(): Promise<void> {
  const env = readEnvSepolia();
  if (!hasSepoliaKey(env)) return;
  const oldAddr = new ethers.Wallet(sepoliaPrivateKey(env)).address;
  const provider = new ethers.JsonRpcProvider(sepoliaRpcUrls(env)[0], 11155111, { staticNetwork: ethers.Network.from(11155111) });
  const bal = await provider.getBalance(oldAddr);
  provider.destroy();
  if (bal > 0n && process.env.BURNER_ROTATE_FORCE !== "1") {
    throw new Error(`Old burner ${oldAddr} has a balance of ${ethers.formatEther(bal)} ETH; move the funds first or set BURNER_ROTATE_FORCE=1.`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const oldFile = `${ENV_SEPOLIA}.old-${stamp}`;
  if (!gitignoreHas(".env.*")) throw new Error(".gitignore has no `.env.*` entry; the old key file was not moved.");
  fs.renameSync(ENV_SEPOLIA, oldFile);
  console.log(`Old burner ${oldAddr} (balance ${ethers.formatEther(bal)} ETH) retired → ${path.basename(oldFile)} (gitignored). This address is NO LONGER USED.`);
  const f = path.join(ROOT, "results", "sepolia", "burner.json");
  const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  const retired = Array.isArray(prev.retired) ? prev.retired : [];
  retired.push({ address: oldAddr, retiredAtUtc: new Date().toISOString(), balanceWei: bal.toString(), reason: process.env.BURNER_ROTATE_REASON ?? "key rotation" });
  fs.writeFileSync(f, JSON.stringify({ ...prev, retired }, null, 2));
}

async function main() {
  const added = ensureGitignore([".env.sepolia", ".env.*", "results/private/"]);
  if (added.length) console.log(`added to .gitignore: ${added.join(", ")}`);
  if (!gitignoreHas(".env.sepolia")) throw new Error(".gitignore could not be verified; key not written.");

  if (process.env.BURNER_ROTATE === "1") await rotate();

  const env = readEnvSepolia();
  if (hasSepoliaKey(env)) {
    const addr = new ethers.Wallet(sepoliaPrivateKey(env)).address;
    console.log(`Keeping the existing burner (no new key generated).`);
    console.log(`Burner address: ${addr}`);
    ensureWatchtower();
    record(addr, false);
    return;
  }

  let wallet: ethers.Wallet | undefined;
  let pk = "";
  while (!wallet) {
    pk = ethers.hexlify(randomBytes(32));
    try {
      wallet = new ethers.Wallet(pk); // retry if outside the secp256k1 range (probability ~2^-128)
    } catch {
      wallet = undefined;
    }
  }

  const block = [
    "# Encrypted Account — Round 2 Sepolia burner wallet (SEPOLIA TESTNET ONLY).",
    "# This file is in .gitignore. Do not share or commit it, and never put a main-wallet key here.",
    `# Created: ${new Date().toISOString()}  Address: ${wallet.address}`,
    `SEPOLIA_PRIVATE_KEY=${pk}`,
    "# Optional: your own RPC URL (several, comma-separated). If empty, public RPCs are used.",
    "# SEPOLIA_RPC_URL=",
    "",
  ].join("\n");

  if (fs.existsSync(ENV_SEPOLIA)) {
    // The file exists but has no key (e.g. only an RPC was written): append, keep the existing lines.
    const cur = fs.readFileSync(ENV_SEPOLIA, "utf8");
    fs.writeFileSync(ENV_SEPOLIA, cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + block, { mode: 0o600 });
  } else {
    fs.writeFileSync(ENV_SEPOLIA, block, { mode: 0o600, flag: "wx" });
  }
  pk = "";

  // Read back what was written and verify the address (the key is still not printed).
  const check = new ethers.Wallet(sepoliaPrivateKey(readEnvSepolia())).address;
  if (check !== wallet.address) throw new Error("Verification failed: .env.sepolia does not contain the expected key.");

  console.log(`New burner generated; the private key is only in .env.sepolia (not printed).`);
  console.log(`Burner address: ${wallet.address}`);
  ensureWatchtower();
  record(wallet.address, true);
}

/** Watchtower wallet (the account's guardian; sends the finalize transactions). If missing, generates one at random and appends it to .env.sepolia. */
function ensureWatchtower() {
  const env = readEnvSepolia();
  if (hasWatchtowerKey(env)) {
    console.log(`Watchtower address: ${new ethers.Wallet(sepoliaWatchtowerKey(env)).address} (existing)`);
    return;
  }
  let w: ethers.Wallet | undefined;
  let k = "";
  while (!w) {
    k = ethers.hexlify(randomBytes(32));
    try {
      w = new ethers.Wallet(k);
    } catch {
      w = undefined;
    }
  }
  const cur = fs.readFileSync(ENV_SEPOLIA, "utf8");
  const block = [`# Watchtower (guardian) wallet — Sepolia only. Address: ${w.address}`, `SEPOLIA_WATCHTOWER_KEY=${k}`, ""].join("\n");
  fs.writeFileSync(ENV_SEPOLIA, cur + (cur.endsWith("\n") ? "" : "\n") + block, { mode: 0o600 });
  k = "";
  const check = new ethers.Wallet(sepoliaWatchtowerKey(readEnvSepolia())).address;
  if (check !== w.address) throw new Error("Watchtower key could not be verified.");
  console.log(`Watchtower address: ${w.address} (new; key only in .env.sepolia)`);
}

function record(address: string, created: boolean) {
  const dir = path.join(ROOT, "results", "sepolia");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "burner.json");
  const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  fs.writeFileSync(
    f,
    JSON.stringify(
      {
        evidence: "[M]",
        address,
        createdAt: created ? new Date().toISOString() : prev.createdAt ?? null,
        lastCheckedAt: new Date().toISOString(),
        note: "Only the address is recorded; the private key is kept nowhere except .env.sepolia.",
        retired: prev.retired ?? [],
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
