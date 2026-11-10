/**
 * The browser fingerprint (web/src/pin.ts, WebCrypto) must equal the SDK's (sdk/src/fingerprint.ts, Node crypto):
 * checked against the shared test vectors.   node web/test/run.mjs
 */
import vectors from "../../sdk/test-vectors/argon2id-v1.json";
import { pinFingerprint, pinSalt } from "../src/pin";

const hex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function main() {
  let fail = 0;
  for (const v of (vectors as any).vectors) {
    const salt = hex(await pinSalt(BigInt(v.chainId), v.account));
    const fp = "0x" + (await pinFingerprint(v.pin, BigInt(v.chainId), v.account)).toString(16).padStart(16, "0");
    const ok = salt === v.salt.toLowerCase() && fp === v.fingerprint.toLowerCase();
    if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"} pin=${JSON.stringify(v.pin)} chain=${v.chainId} fp=${fp}`);
  }
  if (fail) {
    console.error(`${fail} vector(s) failed`);
    process.exit(1);
  }
  console.log("all vectors match");
}
main();
