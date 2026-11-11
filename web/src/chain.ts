/** Sepolia deployment the demo talks to (the F0.15 build: libraries, implementation and factory). */
export const CHAIN_ID = 11155111n;
export const CHAIN_ID_HEX = "0xaa36a7";
export const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
/**
 * eth_getLogs goes to these first: publicnode serves only about the last 10,000 blocks of logs ("pruned history
 * unavailable"), which no longer reach the factory's deployment. Both allow browser requests (CORS); publicnode stays
 * the last resort.
 */
export const LOG_RPC_URLS = ["https://sepolia.gateway.tenderly.co", "https://rpc.sepolia.ethpandaops.io"];
export const EXPLORER = "https://sepolia.etherscan.io";
export const REPO_URL = "https://github.com/Himess/encrypted-account";

export const FACTORY = "0xd03C6a944ccC168Fceb1253Efc741403FC67e541";
export const FACTORY_DEPLOY_BLOCK = 12_100_695;

export const ETH = "0x0000000000000000000000000000000000000000";
/** Amounts in the encrypted policy are counted in units of 10^12 wei (0.000001 ETH). */
export const ETH_UNIT = 10n ** 12n;
export const N_RECIPIENTS = 30;
export const N_SPENDERS = 10;
export const TRACK_OWNER = 0;
export const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Demo timings (seconds). The production examples are hours to days (EncryptedAccountFactory.defaultDelays); the
 * demo uses the short delays of the Sepolia measurements so a visitor sees every step in a few minutes.
 * The field order is the struct's: pinTransfer, bigTransfer, genericCall, settings, loosen, knownAdd, recovery,
 * recoveryNoDevice, pinReset, escape, escapeChange.
 */
export const DEMO_DELAYS = {
  pinTransfer: 0,
  bigTransfer: 60,
  genericCall: 60,
  settings: 60,
  loosen: 60,
  knownAdd: 60,
  recovery: 120,
  recoveryNoDevice: 300,
  pinReset: 300,
  escape: 300,
  escapeChange: 300,
};

/**
 * Hidden inheritance (contracts/inheritance), deployed by scripts/sepolia/will-run.ts. The token is the worthless
 * test ERC-7984 token (tcUSD, 6 decimals) that anyone may mint. Demo wills use the shortest periods the contract
 * allows (5 minutes each); real wills use months.
 */
export const WILL_FACTORY = "0x8CcC48C0FE7271123A556452822F41e5712B28E3";
export const WILL_TOKEN = "0xE552Beed2265a8666d25307079fad9eDA2D70172";
export const WILL_TOKEN_DECIMALS = 6;
export const DEMO_WILL = { inactivity: 300, grace: 300 } as const;
export const WILL_SLOTS = 4;

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;
