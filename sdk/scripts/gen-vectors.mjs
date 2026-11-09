// Shared test vectors (32.1: the SDK, the mobile app and the contract tests use the same vectors).
// Computed with two independent Argon2id implementations (hash-wasm/WASM and @noble/hashes/pure JS) and cross-checked.
// Run: node sdk/scripts/gen-vectors.mjs
import { argon2id as wasmArgon2id } from "hash-wasm";
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";

const KDF_V1 = { memoryKiB: 65536, iterations: 3, parallelism: 1, hashLength: 32 };

function u256be(v) {
  const out = Buffer.alloc(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}
function salt(chainId, account) {
  return createHash("sha256")
    .update(Buffer.from("encrypted-account/pin/v1", "utf8"))
    .update(u256be(chainId))
    .update(Buffer.from(account.slice(2), "hex"))
    .digest();
}
const hex = (b) => "0x" + Buffer.from(b).toString("hex");

const cases = [
  { pin: "482915", chainId: 31337n, account: "0x5FbDB2315678afecb367f032d93F642f64180aa3" },
  { pin: "482915", chainId: 11155111n, account: "0x5FbDB2315678afecb367f032d93F642f64180aa3" },
  { pin: "482915", chainId: 1n, account: "0x5FbDB2315678afecb367f032d93F642f64180aa3" },
  { pin: "007731", chainId: 11155111n, account: "0x000000000000000000000000000000000000dEaD" },
  { pin: "correct horse battery", chainId: 11155111n, account: "0x1111111111111111111111111111111111111111" },
  { pin: "Café-ÅŁŽ-1453", chainId: 11155111n, account: "0x2222222222222222222222222222222222222222" },
];

const vectors = [];
for (const c of cases) {
  const s = salt(c.chainId, c.account);
  const pw = new TextEncoder().encode(c.pin.normalize("NFKC"));
  const a = await wasmArgon2id({
    password: pw,
    salt: s,
    parallelism: KDF_V1.parallelism,
    iterations: KDF_V1.iterations,
    memorySize: KDF_V1.memoryKiB,
    hashLength: KDF_V1.hashLength,
    outputType: "binary",
  });
  const b = nobleArgon2id(pw, s, { t: KDF_V1.iterations, m: KDF_V1.memoryKiB, p: KDF_V1.parallelism, dkLen: KDF_V1.hashLength });
  if (hex(a) !== hex(b)) throw new Error(`implementation mismatch for ${JSON.stringify(c)}`);
  const fp = BigInt(hex(a.slice(0, 8)));
  vectors.push({
    pin: c.pin,
    chainId: c.chainId.toString(),
    account: c.account,
    salt: hex(s),
    argon2id: hex(a),
    fingerprint: "0x" + fp.toString(16).padStart(16, "0"),
  });
}

// Known answer (phc-winner-argon2 reference): argon2id, v=19, m=65536, t=2, p=1, "password"/"somesalt"
const kat = await wasmArgon2id({
  password: "password",
  salt: "somesalt",
  parallelism: 1,
  iterations: 2,
  memorySize: 65536,
  hashLength: 32,
  outputType: "hex",
});

mkdirSync("sdk/test-vectors", { recursive: true });
const doc = {
  description: "Encrypted Account PIN fingerprint test vectors, KDF v1 (Argon2id m=64MiB t=3 p=1, dkLen=32; fp = first 8 bytes BE)",
  kdf: { version: 1, ...KDF_V1, saltFormat: 'SHA-256("encrypted-account/pin/v1" || chainId u256be || account 20B)', normalization: "NFKC, UTF-8" },
  crossCheckedWith: ["hash-wasm@4.13.0 (WASM)", "@noble/hashes@2.0.1 (pure JS)"],
  referenceKAT: { params: "argon2id v=19 m=65536 t=2 p=1 password/somesalt", hash: "0x" + kat },
  vectors,
};
writeFileSync("sdk/test-vectors/argon2id-v1.json", JSON.stringify(doc, null, 2) + "\n");
console.log(JSON.stringify(doc, null, 2));
