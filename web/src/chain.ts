/** Sepolia deployment the demo talks to (the F0.15 build: libraries, implementation and factory). */
export const CHAIN_ID = 11155111n;
export const CHAIN_ID_HEX = "0xaa36a7";
export const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
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

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;
