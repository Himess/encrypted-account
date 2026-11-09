/**
 * PIN fingerprint (Design §13.1, K16).
 *
 *   salt = SHA-256( "encrypted-account/pin/v1" ‖ chainId (32 bytes, big-endian) ‖ accountAddress (20 bytes) )
 *   h    = first 64 bits ( Argon2id( NFKC(PIN) UTF-8, salt, m, t, p ) )   — as a big-endian uint64
 *
 * The parameters and the version are public on-chain (EncryptedAccount.PIN_KDF_VERSION); they are not secret.
 * The PIN itself is never stored anywhere; only Enc(h) is kept on-chain.
 */
import { argon2id } from "hash-wasm";
import { createHash } from "crypto";

export interface KdfParams {
  version: number;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

/** v1: m = 64 MiB, t = 3, p = 1 (the design doc's §13.1 example; to be frozen once measured on devices in E17). */
export const KDF_V1: KdfParams = Object.freeze({
  version: 1,
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
});

export const SALT_DOMAIN = "encrypted-account/pin/v1"; // domain tag: changing it changes every fingerprint
export const UINT64_MOD = 1n << 64n;

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function u256be(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Per-account salt. The account address is known counterfactually, before deployment. */
export function pinSalt(chainId: bigint, account: string): Uint8Array {
  const addr = hexToBytes(account);
  if (addr.length !== 20) throw new Error("account must be a 20-byte address");
  const h = createHash("sha256");
  h.update(Buffer.from(SALT_DOMAIN, "utf8"));
  h.update(u256be(chainId));
  h.update(addr);
  return new Uint8Array(h.digest());
}

/** PIN normalization: Unicode NFKC; leading/trailing whitespace is kept (the string exactly as the user typed it). */
export function normalizePin(pin: string): string {
  return pin.normalize("NFKC");
}

/** Raw Argon2id output (for test vectors). */
export async function argon2idRaw(pin: string, salt: Uint8Array, params: KdfParams = KDF_V1): Promise<Uint8Array> {
  return argon2id({
    password: new TextEncoder().encode(normalizePin(pin)),
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: params.hashLength,
    outputType: "binary",
  });
}

/** 64-bit fingerprint h (uint64). */
export async function pinFingerprint(
  pin: string,
  chainId: bigint,
  account: string,
  params: KdfParams = KDF_V1,
): Promise<bigint> {
  const raw = await argon2idRaw(pin, pinSalt(chainId, account), params);
  let h = 0n;
  for (let i = 0; i < 8; i++) h = (h << 8n) | BigInt(raw[i]);
  return h;
}

/** Challenge-bound guess value: (h + c) mod 2^64 (Design §13.2). It is encrypted and passed to submitGuess. */
export function guessValue(fingerprint: bigint, challenge: bigint): bigint {
  return (fingerprint + challenge) % UINT64_MOD;
}

/** Candidate the client sends for the duress slot when no duress PIN is chosen (never selected: on-chain the slot takes FHE randomness instead). */
export function randomUint64(): bigint {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return x;
}
