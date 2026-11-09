/** Deployment with library linking from a saved build (build.json). */
import { ethers } from "ethers";
import * as fs from "fs";
import { ManagedWallet, TxRecord, sendTx } from "./net";

export type Build = { contracts: Record<string, { abi: any[]; bytecode: string; linkReferences: any; deployedBytecodeBytes: number }> };

export function loadBuild(file: string): Build {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Replaces the placeholders with addresses according to linkReferences. */
export function linkBytecode(bytecode: string, linkReferences: any, libs: Record<string, string>): string {
  let code = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  for (const file of Object.keys(linkReferences ?? {})) {
    for (const lib of Object.keys(linkReferences[file])) {
      const addr = libs[lib];
      if (!addr) throw new Error(`no library address: ${lib}`);
      const a = addr.toLowerCase().replace(/^0x/, "");
      for (const { start, length } of linkReferences[file][lib]) {
        code = code.slice(0, start * 2) + a + code.slice((start + length) * 2);
      }
    }
  }
  if (/__\$[0-9a-fA-F]{34}\$__/.test(code)) throw new Error("unlinked library left in bytecode");
  return "0x" + code;
}

export async function deployFromBuild(
  signer: ManagedWallet,
  build: Build,
  name: string,
  args: unknown[] = [],
  libs: Record<string, string> = {},
): Promise<{ address: string; tx: TxRecord; runtimeBytes: number }> {
  const c = build.contracts[name];
  if (!c) throw new Error(`not in build: ${name}`);
  const factory = new ethers.ContractFactory(c.abi, linkBytecode(c.bytecode, c.linkReferences, libs), signer);
  const deployTx = await factory.getDeployTransaction(...args);
  const rec = await sendTx(signer, `deploy ${name}`, async () => deployTx, { timeoutMs: 180_000 });
  const address = rec.receipt.contractAddress!;
  const { receipt, ...tx } = rec;
  void receipt;
  return { address, tx, runtimeBytes: c.deployedBytecodeBytes };
}

export function contractAt(build: Build, name: string, address: string, runner: ethers.ContractRunner): any {
  return new ethers.Contract(address, build.contracts[name].abi, runner);
}

/** Combined error ABI including the custom errors in the libraries (for decoding reverts). */
export function errorInterface(build: Build, names: string[]): ethers.Interface {
  const seen = new Set<string>();
  const frags: any[] = [];
  for (const n of names) {
    for (const f of build.contracts[n]?.abi ?? []) {
      if (f.type !== "error") continue;
      const sig = f.name + "(" + (f.inputs ?? []).map((i: any) => i.type).join(",") + ")";
      if (!seen.has(sig)) {
        seen.add(sig);
        frags.push(f);
      }
    }
  }
  return new ethers.Interface(frags);
}

export function decodeRevert(itf: ethers.Interface, e: any): string {
  const data: string | undefined = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try {
      const d = itf.parseError(data);
      if (d) return d.name;
    } catch {
      /* unknown */
    }
    return `0x${data.slice(2, 10)}`;
  }
  return String(e?.shortMessage ?? e?.message ?? e).slice(0, 200);
}
