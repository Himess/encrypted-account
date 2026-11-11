import * as hre from "hardhat";

// Runtime bytecode sizes vs. the EIP-170 limit (24 576 bytes). Libraries are deployed separately.
async function main() {
  const names = ["EncryptedAccount", "EncryptedAccountB", "PinLib", "PolicyLib", "OpsLib", "OpenLib", "EncryptedAccountFactory", "EncryptedWill", "EncryptedWillFactory", "EncryptedWillDemoFactory"];
  const rows: { contract: string; bytes: number; limit: number; ok: boolean }[] = [];
  for (const n of names) {
    const art = await hre.artifacts.readArtifact(n);
    const bytes = (art.deployedBytecode.length - 2) / 2;
    rows.push({ contract: n, bytes, limit: 24576, ok: bytes <= 24576 });
  }
  console.table(rows);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
