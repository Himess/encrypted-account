/**
 * Disclosure inventory (I3 by construction). Every public decryption and every permission the account gives an address
 * other than itself goes through contracts/account/Disclose.sol, whose helpers check the handle's type byte and refuse
 * the PIN fingerprints. This file (1) scans the account's sources and fails on any direct FHE.makePubliclyDecryptable /
 * FHE.allow / FHE.allowTransient outside Disclose.sol, (2) pins the list of call sites, so a new one has to be added here
 * on purpose, and (3) drives the helpers on the account's storage layout: pinH / duressH and wrongly typed handles are
 * refused. With WRITE_RESULTS=1 the inventory goes to results/disclosure-inventory.json.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { RECORD, errs, ethers } from "./helpers";

const ROOT = path.join(__dirname, "..");
const DIRS = ["contracts/account", "contracts/private"];
const DIRECT = /FHE\.(makePubliclyDecryptable|allow|allowTransient|allowForDecryption|delegateUserDecryption\w*)\s*\(/g;
const HELPER = /Disclose\.(publicBool|guardianBool|guardianU64|ownerU64|tokenTransient)\s*\(/g;

/** Comments removed, line numbers kept. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function sites(re: RegExp) {
  const out: { file: string; line: number; call: string }[] = [];
  for (const d of DIRS) {
    for (const f of fs.readdirSync(path.join(ROOT, d)).filter((x) => x.endsWith(".sol"))) {
      const rel = `${d}/${f}`;
      const src = code(fs.readFileSync(path.join(ROOT, rel), "utf8"));
      for (const m of src.matchAll(re)) out.push({ file: rel, line: src.slice(0, m.index).split("\n").length, call: m[1] });
    }
  }
  return out;
}

describe("Disclosure inventory: every value that leaves the account goes through Disclose", function () {
  it("no direct FHE.makePubliclyDecryptable / allow / allowTransient outside Disclose.sol", () => {
    const direct = sites(DIRECT).filter((s) => s.file !== "contracts/account/Disclose.sol");
    expect(direct, JSON.stringify(direct)).to.deep.eq([]);
  });

  it("the call sites are exactly the known ones (a new disclosure is added here on purpose)", () => {
    const got = sites(HELPER).map((s) => `${s.file}:${s.call}`).sort();
    const expected = [
      "contracts/account/PinLib.sol:publicBool", // okAny of a guess (real OR duress)
      "contracts/account/PinLib.sol:publicBool", // a guess's delay class, masked with okAny
      "contracts/account/PinLib.sol:guardianBool", // the duress flag, for the silent alarm
      "contracts/account/PolicyLib.sol:publicBool", // a K-only evaluation's ok bit
      "contracts/account/PolicyLib.sol:guardianBool", // a public asset's tripwire flag
      "contracts/private/PrivateModule.sol:tokenTransient", // a K-only private send's amount, to the token, this tx only
      "contracts/private/PrivateModule.sol:guardianU64", // the private K-only counter
      "contracts/private/PrivateModule.sol:ownerU64", // a PIN-gated balance snapshot
      "contracts/private/PrivateModule.sol:tokenTransient", // a PIN private send's amount, to the token, this tx only
    ].sort();
    expect(got).to.deep.eq(expected);
    if (RECORD) {
      fs.writeFileSync(path.join(ROOT, "results", "disclosure-inventory.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sites: sites(HELPER) }, null, 1) + "\n");
    }
  });

  it("the helpers refuse pinH, duressH and handles of the wrong type, and let intended values through", async () => {
    const h: any = await (await ethers.getContractFactory("DiscloseHarness")).deploy();
    await h.waitForDeployment();
    await (await h.setPins(123n, 456n)).wait();
    const ERR = await errs();
    for (const f of ["ownerPin", "guardianDuress", "publicPinAsBool", "guardianPinAsBool"]) {
      await expect(h[f].staticCall()).to.be.revertedWithCustomError(ERR, "NotDisclosable");
    }
    await expect(h.tokenPin.staticCall(ethers.ZeroAddress)).to.be.revertedWithCustomError(ERR, "NotDisclosable");
    await (await h.ownerFresh(7n)).wait();
    await (await h.publicFresh(true)).wait();
  });
});
