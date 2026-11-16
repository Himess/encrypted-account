/**
 * User decryption with the watchtower key through Zama's relayer and KMS (Sepolia). Off-chain: nothing it does shows up
 * on-chain. The KMS answers only for handles the account has allowed to the watchtower (the duress flag of each guess,
 * and the K-only counter of each private token).
 */
import type { ethers } from "ethers";

const RETRYABLE = /not authorized|unauthorized|not allowed|acl|not ready|not found|timeout|fetch failed|ECONNRESET|503|502|429/i;

export interface Decryptor {
  userDecryptBool: (handle: string, contract: string) => Promise<boolean>;
  userDecryptU64: (handle: string, contract: string) => Promise<bigint>;
  /** Public decryption of handles anyone may decrypt (a guess's yes / no result); nothing is sent on-chain. */
  publicDecrypt: (handles: string[]) => Promise<{ clearValues: Record<string, unknown>; abiEncodedClearValues: string; decryptionProof: string }>;
}

/**
 * @param maxWaitMs how long to keep retrying a handle the relayer does not know yet (the coprocessor computes a new
 *        ciphertext a few blocks after the transaction that asked for it)
 */
export async function sepoliaDecryptor(provider: ethers.Provider, signer: ethers.Wallet, maxWaitMs = 180_000): Promise<Decryptor> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk: any = require("@fhevm/sdk/ethers");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sepolia } = require("@fhevm/sdk/chains");
  if (!sdk.hasFhevmRuntimeConfig()) sdk.setFhevmRuntimeConfig({});
  await sdk.initFhevmRuntime();
  const client: any = sdk.createFhevmClient({ provider, chain: sepolia });
  await client.ready;

  // one decryption permit per contract, renewed well before its day runs out
  const permits = new Map<string, { transportKeyPair: any; signedPermit: any; until: number }>();
  const permitFor = async (contract: string) => {
    const key = contract.toLowerCase();
    const p = permits.get(key);
    if (p && p.until > Date.now()) return p;
    const transportKeyPair = await client.generateTransportKeyPair();
    const signedPermit = await client.signDecryptionPermit({
      contractAddresses: [contract],
      startTimestamp: Math.floor(Date.now() / 1000) - 60,
      durationSeconds: 86400,
      signerAddress: signer.address,
      signer,
      transportKeyPair,
    });
    const np = { transportKeyPair, signedPermit, until: Date.now() + 20 * 3600 * 1000 };
    permits.set(key, np);
    return np;
  };

  const decrypt = async (handle: string, contract: string): Promise<bigint> => {
    const t0 = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const { transportKeyPair, signedPermit } = await permitFor(contract);
        const out = await client.decryptValues({ encryptedValues: [handle], contractAddress: contract, transportKeyPair, signedPermit });
        const v: any = (out as any[])[0];
        const raw = String(v && typeof v === "object" && "value" in v ? v.value : v);
        return raw === "true" ? 1n : raw === "false" ? 0n : BigInt(raw);
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 300);
        if (RETRYABLE.test(msg) && Date.now() - t0 < maxWaitMs) {
          await new Promise((r) => setTimeout(r, Math.min(2000 + attempt * 500, 5000)));
          continue;
        }
        throw new Error(`user decryption failed after ${attempt} tries: ${msg}`);
      }
    }
  };
  const publicDecrypt = async (handles: string[]) => {
    const t0 = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await client.decryptPublicValuesWithSignatures({ encryptedValues: handles });
        const clear = (out.clearValues as any[]).map((v) => (v && typeof v === "object" && "value" in v ? v.value : v));
        return {
          clearValues: Object.fromEntries(handles.map((h, i) => [h, clear[i]])),
          abiEncodedClearValues: out.checkSignaturesArgs.abiEncodedCleartexts,
          decryptionProof: out.checkSignaturesArgs.decryptionProof,
        };
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 300);
        if (Date.now() - t0 < maxWaitMs) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        throw new Error(`public decryption failed after ${attempt} tries: ${msg}`);
      }
    }
  };
  return { userDecryptBool: async (h, c) => (await decrypt(h, c)) !== 0n, userDecryptU64: decrypt, publicDecrypt };
}
