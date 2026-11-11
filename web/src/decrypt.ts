/**
 * User decryption, loaded on demand (only when an heir reveals its balance): Zama's decrypt client with the KMS
 * library. Kept out of app.js so the main bundle stays small.
 */
import type { ethers } from "ethers";
import { createFhevmDecryptClient, initFhevmDecryptRuntime, setFhevmRuntimeConfig } from "@fhevm/sdk/ethers";
import { sepolia } from "@fhevm/sdk/chains";

let clientP: Promise<any> | null = null;

function client(provider: ethers.Provider): Promise<any> {
  if (!clientP) {
    clientP = (async () => {
      setFhevmRuntimeConfig({ wasmAssetLoadMode: "embedded-base64" });
      await initFhevmDecryptRuntime();
      const c: any = createFhevmDecryptClient({ provider, chain: sepolia });
      await c.ready;
      return c;
    })();
    clientP.catch(() => (clientP = null));
  }
  return clientP;
}

export async function userDecrypt(
  provider: ethers.Provider,
  signer: ethers.Signer,
  signerAddress: string,
  handle: string,
  contractAddress: string,
  onStatus?: (t: string) => void,
): Promise<string> {
  const c = await client(provider);
  const transportKeyPair = await c.generateTransportKeyPair();
  const signedPermit = await c.signDecryptionPermit({
    contractAddresses: [contractAddress],
    startTimestamp: Math.floor(Date.now() / 1000) - 60,
    durationSeconds: 86400, // the SDK accepts whole days only
    signerAddress,
    signer,
    transportKeyPair,
  });
  onStatus?.("Asking the threshold network…");
  // Right after a transfer the relayer may not have seen the block that granted access to the new balance yet ("not
  // authorized"): ask again with the same permit, so the wallet signs only once. A request that hangs is given up.
  for (let attempt = 1; ; attempt++) {
    try {
      const vals: any[] = await withTimeout(c.decryptValues({ encryptedValues: [handle], contractAddress, transportKeyPair, signedPermit }), 120_000);
      const v: any = vals[0];
      return String(v && typeof v === "object" && "value" in v ? v.value : v);
    } catch (e: any) {
      if (attempt >= 6 || !/not authorized/i.test(String(e?.message ?? e))) throw e;
      onStatus?.("The relayer hasn't seen the latest block yet; asking again…");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("The threshold network did not answer within 2 minutes. Try again.")), ms);
    p.then(
      (v) => (clearTimeout(id), resolve(v)),
      (e) => (clearTimeout(id), reject(e)),
    );
  });
}
