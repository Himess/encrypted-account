import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import type { HardhatUserConfig } from "hardhat/config";
import { hasSepoliaKey, readEnvSepolia, sepoliaPrivateKey, sepoliaRpcUrls } from "./scripts/lib/env";

// Round 2 §4.0: the Sepolia burner key and RPC URL are read ONLY from the gitignored `.env.sepolia` file
// (the `SEPOLIA_PRIVATE_KEY=0x... npx ...` form is not used; it ends up in shell history). To generate the file:
//   npx hardhat run scripts/burner.ts
// The Sepolia scripts (scripts/sepolia/*) build their own retrying provider; the network definition here
// is for Hardhat/plugin tasks run with `--network sepolia`.
const ENV_SEPOLIA = readEnvSepolia();
const SEPOLIA_RPC_URL = sepoliaRpcUrls(ENV_SEPOLIA)[0];
const SEPOLIA_ACCOUNTS = hasSepoliaKey(ENV_SEPOLIA) ? [sepoliaPrivateKey(ENV_SEPOLIA)] : [];

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          // FHEVM uses transient storage (EIP-1153): requires at least "cancun".
          evmVersion: "cancun",
          viaIR: true,
          optimizer: { enabled: true, runs: 1 },
        },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: process.env.HH_HARDFORK ?? "prague",
      // In the prototype, sizes are measured by a separate script (scripts/contract-sizes.ts);
      // that script checks that the contracts deployed to Sepolia fit the 24 KiB limit.
      allowUnlimitedContractSize: false,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts: SEPOLIA_ACCOUNTS,
      timeout: 60_000,
    },
  },
  mocha: {
    timeout: 600_000,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
  },
};

export default config;
