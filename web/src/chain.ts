/** Sepolia deployment the demo talks to (the F0.16 build: libraries, implementation, factory and the shared FeeConfig). */
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

export const FACTORY = "0x2264E6A8362BbF4d4EDC6F34B97E7FBb1EAD6A3A";
export const FACTORY_DEPLOY_BLOCK = 12_140_517;
/** F0.16: the fee table the implementation reads (ETH: 10 bps, min 0.00001, max 0.001 ETH). Each account reads its own. */
export const FEE_CONFIG = "0xe555608B8768580DC28D4445cfE343b5eb1769c0";
/**
 * Accounts created before F0.16 on the F0.15 factory (no bond, no fee) keep working: the app still finds them and shows
 * them without the bond and fee lines. New accounts are created on FACTORY only.
 */
export const LEGACY_FACTORIES = ["0xd03C6a944ccC168Fceb1253Efc741403FC67e541"];
/** Factory and account logs are read from the oldest factory's deployment, so older accounts keep their history. */
export const LOGS_FROM_BLOCK = 12_100_695;

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
 * Private mode (optional): accounts created on FACTORY_P (EncryptedAccountP + PrivateModule) hold an ERC-7984 token with
 * hidden balances, a PIN-gated view, a one-transaction K-only private send and an optional duress PIN. The app creates
 * private accounts only when this factory's module is the build it is written for (account.ts, PRIVATE_MODE_VERSION);
 * otherwise the setup option stays visible but off and disabled. This is the first Sepolia build (version 1): replace both
 * values with the next deployment's (scripts/sepolia/r8-deploy.ts writes them).
 */
export const FACTORY_P = "0xE93F23487c9aa1ab5acE4401d7FF957aF85FC92E";
export const FACTORY_P_DEPLOY_BLOCK = 12_143_705;
/** Zama's Wrappers Registry and its official cUSDC (Mock) wrapper on Sepolia (docs.zama.org, addresses/testnet/sepolia). */
export const WRAPPER_REGISTRY = "0x2f0750Bbb0A246059d80e94c454586a7F27a128e";
export const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
/** The wrapper's underlying test USDC: anyone may mint it (at most 1,000,000 per call). 6 decimals, wrapper rate 1. */
export const USDC_MOCK = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";
export const CUSDC_UNIT = 10n ** 6n;
/**
 * Optional watchtower for private-mode accounts: its address becomes the account's guardian (it may read the K-only
 * counter and the duress flag, and restrict; never move funds), and the app reads its notices (silent zero, delivery,
 * tripwire) from the URL. The watchtower of the private-mode Sepolia run: its service (watchtower/) must be running for
 * the alarms to go out. No notices URL: a K-only private send is confirmed only by a PIN-gated view.
 */
export const WATCHTOWER = { address: "0x8e98d5e45822b81Ac7dB853480c405E8Ea769B7A", noticesUrl: "" };
/** Private mode: every PIN-verified private send waits at least this long (design doc §17.1; PrivateStorage.MIN_BIG_DELAY). */
export const PRIVATE_MIN_BIG_DELAY = 72 * 3600;
/** Demo delays of a private-mode account: as DEMO_DELAYS, with the long class at the 72-hour minimum. */
export const DEMO_DELAYS_P = { ...DEMO_DELAYS, bigTransfer: PRIVATE_MIN_BIG_DELAY };

/**
 * Hidden inheritance (contracts/inheritance), deployed by scripts/sepolia/will-run.ts. The token is the worthless
 * test ERC-7984 token (tcUSD, 6 decimals) that anyone may mint. WILL_FACTORY is the DEMO factory (testnets only):
 * 5-minute absence and grace, a 1-day claim window. The production factory allows 90 days–5 years, 30 days–1 year and
 * at least 1 year.
 */
export const WILL_FACTORY = "0x6941031bd1bec8C86Afea996DF3E6F8D052979D1";
export const WILL_TOKEN = "0xE552Beed2265a8666d25307079fad9eDA2D70172";
export const WILL_TOKEN_DECIMALS = 6;
export const DEMO_WILL = { inactivity: 300, grace: 300, claimWindow: 86_400 } as const;
export const WILL_SLOTS = 4;

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;
