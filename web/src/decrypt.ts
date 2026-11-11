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
  const vals = await c.decryptValues({ encryptedValues: [handle], contractAddress, transportKeyPair, signedPermit });
  const v: any = vals[0];
  return String(v && typeof v === "object" && "value" in v ? v.value : v);
}
