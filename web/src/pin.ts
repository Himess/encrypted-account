/**
 * PIN fingerprint in the browser — the same derivation as sdk/src/fingerprint.ts (checked against
 * sdk/test-vectors/argon2id-v1.json by web/test/pin-vectors.ts):
 *
 *   salt = SHA-256( "encrypted-account/pin/v1" ‖ chainId (32 bytes, big-endian) ‖ account (20 bytes) )
 *   h    = first 64 bits of Argon2id( NFKC(PIN), salt, m = 64 MiB, t = 3, p = 1 ), big-endian
 *
 * The PIN never leaves the page: only Enc(h) (setup) or Enc(h + c mod 2^64) (a guess) is sent to the chain.
 */
import { argon2id } from "hash-wasm";
export { checkPin, randomPin } from "../../sdk/src/pinPolicy";

const SALT_DOMAIN = "encrypted-account/pin/v1";
const UINT64_MOD = 1n << 64n;
export const KDF_V1 = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1, hashLength: 32 };

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export async function pinSalt(chainId: bigint, account: string): Promise<Uint8Array> {
  const tag = new TextEncoder().encode(SALT_DOMAIN);
  const cid = new Uint8Array(32);
  let x = chainId;
  for (let i = 31; i >= 0; i--) {
    cid[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  const addr = hexToBytes(account);
  if (addr.length !== 20) throw new Error("account must be a 20-byte address");
  const buf = new Uint8Array(tag.length + 32 + 20);
  buf.set(tag, 0);
  buf.set(cid, tag.length);
  buf.set(addr, tag.length + 32);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

export async function pinFingerprint(pin: string, chainId: bigint, account: string): Promise<bigint> {
  const raw = await argon2id({
    password: new TextEncoder().encode(pin.normalize("NFKC")),
    salt: await pinSalt(chainId, account),
    parallelism: KDF_V1.parallelism,
    iterations: KDF_V1.iterations,
    memorySize: KDF_V1.memoryKiB,
    hashLength: KDF_V1.hashLength,
    outputType: "binary",
  });
  let h = 0n;
  for (let i = 0; i < 8; i++) h = (h << 8n) | BigInt(raw[i]);
  return h;
}

/** Challenge-bound guess: (h + c) mod 2^64 (design §13.2). */
export function guessValue(fingerprint: bigint, challenge: bigint): bigint {
  return (fingerprint + challenge) % UINT64_MOD;
}

export function randomUint64(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return b.reduce((x, v) => (x << 8n) | BigInt(v), 0n);
}
