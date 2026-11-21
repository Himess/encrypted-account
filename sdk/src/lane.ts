/**
 * Two-device PIN flow (the authenticated lane, TRACK_LANE): the key K stays on one device (a computer or a hardware
 * wallet), the PIN is typed on another (a phone, registered as the account's second device D). Neither device alone has
 * both.
 *
 *   computer (K)                                   phone (D)
 *   open the op ─────────── link / QR (account, opId) ──▶ read the op from the chain, recompute its challenge c,
 *                                                         show what it does; PIN → Argon2id → Enc((h + c) mod 2^64)
 *                                                         for (account, K's address); sign (opId, guessHandle) with D
 *   submitGuessWithCosign ◀──── approval code ────────── code = { opId, c, guess handle, input proof, D's signature }
 *
 * The PIN and its fingerprint never reach the computer, and the code is useless for any other op (the challenge binds the
 * op's content, the signature binds the op and the encrypted guess, and the same input is refused twice in a row). The
 * FHE input is bound to (account, K's address), because K sends the transaction: the phone builds it for that address
 * without holding K.
 */
import { AbiCoder, getBytes, hashMessage, keccak256, toUtf8Bytes } from "ethers";

const coder = AbiCoder.defaultAbiCoder();

/** keccak256("encrypted-account/challenge/v1"), AccountStorage.CHALLENGE_TAG. */
export const CHALLENGE_TAG = "0x0d1c148eec8692966a336c305b85d4a8336f91bf6ae5b3ba097a041e3b5ae264";
export const LANE_TAG = keccak256(toUtf8Bytes("encrypted-account/lane/v1"));

/** Op kinds (AccountStorage.Kind). */
export const KIND = { None: 0, Outflow: 1, Call: 2, Admin: 3, Recovery: 4, PinReset: 5 } as const;

/** The fields of an op that its content hash covers (getOp returns them). */
export interface OpContent {
  kind: number | bigint;
  sub: number | bigint;
  target: string;
  counterparty: string;
  amount: bigint;
  data: string;
  h0: string;
  h1: string;
  h2: string;
  fee: bigint;
  callFee: bigint;
}

const ZERO32 = "0x" + "00".repeat(32);

/** PolicyMath.opHashOf: the content hash the challenge binds. */
export function opContentHash(opId: bigint, op: OpContent): string {
  const kind = Number(op.kind);
  let oh = keccak256(
    coder.encode(["uint256", "uint8", "uint8", "address", "address", "uint256", "bytes32"], [opId, kind, Number(op.sub), op.target, op.counterparty, op.amount, keccak256(op.data)]),
  );
  if (kind !== KIND.Outflow && (op.h0 !== ZERO32 || op.h1 !== ZERO32 || op.h2 !== ZERO32)) {
    oh = keccak256(coder.encode(["bytes32", "bytes32", "bytes32", "bytes32"], [oh, op.h0, op.h1, op.h2]));
  }
  const fee = BigInt(op.fee) + BigInt(op.callFee);
  if (fee !== 0n) oh = keccak256(coder.encode(["bytes32", "uint256"], [oh, fee]));
  return oh;
}

/** PolicyMath.challengeOf: the challenge c a guess for this op must be computed with. */
export function challengeOf(chainId: bigint, account: string, opId: bigint, contentHash: string): bigint {
  const h = keccak256(coder.encode(["bytes32", "uint256", "address", "uint256", "bytes32"], [CHALLENGE_TAG, chainId, account, opId, contentHash]));
  return BigInt(h) & ((1n << 64n) - 1n);
}

/** The 32-byte message the second device signs with personal_sign for a lane guess (OpenLib.checkLane). */
export function laneMessage(chainId: bigint, account: string, opId: bigint, guessHandle: string): string {
  const payload = keccak256(coder.encode(["uint256", "bytes32"], [opId, guessHandle]));
  return keccak256(coder.encode(["bytes32", "uint256", "address", "bytes32"], [LANE_TAG, chainId, account, payload]));
}

/** The EIP-191 digest the contract checks the signature against (what an ERC-1271 second device must accept). */
export function laneDigest(chainId: bigint, account: string, opId: bigint, guessHandle: string): string {
  return hashMessage(getBytes(laneMessage(chainId, account, opId, guessHandle)));
}

/** What the phone hands back to the computer. */
export interface LaneApproval {
  account: string;
  opId: bigint;
  c: bigint;
  guess: string; // the encrypted guess handle (bytes32)
  proof: string; // its input proof
  cosig: string; // the second device's signature over laneMessage(...)
}

const b64u = {
  enc: (b: Uint8Array) => {
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec: (s: string) => {
    const t = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(t + "===".slice((t.length + 3) % 4));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  },
};

/** A compact text code (base64url of the ABI encoding, prefixed "EA1."): short enough for a QR code or a chat message. */
export function encodeApproval(a: LaneApproval): string {
  const raw = coder.encode(["address", "uint256", "uint64", "bytes32", "bytes", "bytes"], [a.account, a.opId, a.c, a.guess, a.proof, a.cosig]);
  return "EA1." + b64u.enc(getBytes(raw));
}

export function decodeApproval(code: string): LaneApproval {
  const t = code.trim();
  if (!t.startsWith("EA1.")) throw new Error("Not an approval code from the phone.");
  const [account, opId, c, guess, proof, cosig] = coder.decode(["address", "uint256", "uint64", "bytes32", "bytes", "bytes"], b64u.dec(t.slice(4)));
  return { account, opId: BigInt(opId), c: BigInt(c), guess, proof, cosig };
}
