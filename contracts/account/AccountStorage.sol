// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint64, ebool, eaddress} from "@fhevm/solidity/lib/FHE.sol";

/// @title AccountStorage
/// @notice Namespaced (ERC-7201) storage layout shared by EncryptedAccount and its external libraries.
/// @dev The libraries (PinLib, PolicyLib) are linked as *external* libraries and therefore run via
///      DELEGATECALL in the account's context. They see the same storage, the same `msg.sender` and —
///      crucially for FHEVM — the same ACL identity (`address(this)`), so no handle ever has to be
///      shared with another contract.
library AccountStorage {
    // ─────────────────────────────── op model ───────────────────────────────

    enum Kind {
        None,
        Outflow, // ETH transfer, ERC-20 transfer, ERC-20 approve (parsed, counted against the policy)
        Call, // any other call: always K+P and a delay (default deny)
        Admin, // self-administration (typed actions below)
        Recovery, // seedless recovery: P (recovery track, bonded) + new key K'
        PinReset // forgotten PIN: K + (D or recovery helper) + long delay; no PIN check
    }

    enum Status {
        None,
        Evaluating, // K-only outflow waiting for the public `ok` bit
        NeedsPin, // waiting for a PIN guess
        Guessing, // a guess is in flight (public decryption pending)
        Delayed, // PIN verified (or no PIN needed) — waiting for `readyAt`
        Executed,
        Cancelled
    }

    uint8 internal constant OUT_ETH = 0;
    uint8 internal constant OUT_ERC20 = 1;
    uint8 internal constant OUT_APPROVE = 2;

    uint8 internal constant A_CANCEL = 1;
    uint8 internal constant A_UNRESTRICT = 2;
    uint8 internal constant A_FREEZE = 3; // "P alone may restrict" (recovery track)
    uint8 internal constant A_ROTATE_OWNER = 4;
    uint8 internal constant A_PIN_CHANGE = 5;
    uint8 internal constant A_SET_LIMITS = 6;
    uint8 internal constant A_RESET_TRIP = 7;
    uint8 internal constant A_ADD_KNOWN_R = 8;
    uint8 internal constant A_ADD_KNOWN_S = 9;
    uint8 internal constant A_SET_GUARDIAN = 10;
    uint8 internal constant A_SET_DEVICE = 11;
    uint8 internal constant A_SET_HELPER = 12;
    uint8 internal constant A_SET_ESCAPE = 13;
    uint8 internal constant A_SET_PULSE = 14;
    uint8 internal constant A_SET_RECOVERY = 15;
    uint8 internal constant A_SET_AUTOKNOWN = 16;
    uint8 internal constant A_APPROVE_HASH = 17;
    uint8 internal constant A_SET_INSTANT = 18;
    uint8 internal constant A_CANCEL_ESCAPE = 19;
    uint8 internal constant A_SET_OPEN_LIMIT = 20; // B variant (F0.11): raising the public K-only limit (K+P, loosen delay)

    uint8 internal constant TRACK_OWNER = 0; // K-track: guesses from K (EOA or EntryPoint) — anonymous (anyone with K)
    uint8 internal constant TRACK_RECOVERY = 1; // anonymous track (relayer), bonded; only Recovery / Freeze ops
    uint8 internal constant TRACK_LANE = 2; // authenticated lane: K + co-signature of D or recovery helper

    uint8 internal constant R_STRIKES = 1; // K-track wrong-guess score reached 3 (K43; score-caused, lifts itself)
    uint8 internal constant R_GUARDIAN = 2; // watchtower
    uint8 internal constant R_OWNER = 4; // K
    uint8 internal constant R_PIN = 8; // P alone (Freeze op via recovery track)

    /// @dev `FHE.isIn` HCU is bucketed (n<=10, n<=30, n>30); 30/10 sit exactly at bucket edges.
    uint256 internal constant N_RECIPIENTS = 30;
    uint256 internal constant N_SPENDERS = 10;

    bytes32 internal constant CHALLENGE_TAG = 0x0d1c148eec8692966a336c305b85d4a8336f91bf6ae5b3ba097a041e3b5ae264; // keccak256("encrypted-account/challenge/v1")

    struct Delays {
        uint32 pinTransfer; // PIN-path outflow below L_big
        uint32 bigTransfer; // outflow above L_big (and ETH-carrying generic calls)
        uint32 genericCall; // any non-parsed call (default deny)
        uint32 settings; // owner rotation, PIN change, guardian/device/helper change
        uint32 loosen; // loosening limits/pulse/instant budget, (re)enabling seedless recovery
        uint32 knownAdd; // known-list additions (K+P and auto-known activation)
        uint32 recovery; // seedless recovery (with D co-signature, or no D registered)
        uint32 recoveryNoDevice; // seedless recovery when D is registered but did not co-sign
        uint32 pinReset; // forgotten PIN (K + D/helper)
        uint32 escape; // escape (K alone, funds only to the escape address)
        uint32 escapeChange; // changing the escape address
    }

    /// @dev K43 wrong-guess score. Every guess adds +1 when it is submitted (before the result exists, I10); a
    ///      correct result refunds exactly that +1, so a correct PIN never lowers the score (I20). The score decays
    ///      by 1 at every DECAY_PERIOD boundary of a fixed calendar (PolicyMath.score), so the owner's own correct
    ///      PINs do not hold the decay back. Back-off is derived from (lastAt, score) and never stored.
    struct Track {
        uint32 score; // stored score, valid as of `decayEpoch`
        uint32 decayEpoch; // calendar index (timestamp / DECAY_PERIOD) at which `score` was last normalised
        uint64 lastAt; // last attempt; the anonymous tracks share max(lastAt) (K56)
        uint256 pendingOp; // single in-flight guess per track
    }

    struct Guess {
        bytes32 okH; // ebool, publicly decryptable: okReal OR okDuress
        bytes32 bigH; // ebool, publicly decryptable: okAny AND (pinSpent + amount > L_big)  (outflows only)
        bytes32 duressFlagH; // ebool, never public: okDuress AND NOT okReal (silent alarm → guardian)
        address bondPayer;
        uint96 bond;
        uint8 track;
        bool pending;
        bool setStrikes; // this guess raised R_STRIKES provisionally (undone if it turns out correct)
    }

    struct AssetCfg {
        bool configured;
        uint64 epoch; // day index of the counters below
        uint64 gen; // (ownerEpoch, escEpoch) of `reserved` / `pinCommitted`: an owner change or an escape orphans them
        uint256 unit; // token base units per encrypted unit (64-bit range, see PolicyLib.scaleUp)
        uint256 spent; // K-only outflows (incl. approvals) in this epoch — invariant: scaled(spent) <= tau
        uint256 reserved; // K-only outflows waiting for their `ok` bit
        uint256 pinSpent; // PIN-path outflows executed in this epoch
        uint256 pinCommitted; // PIN-path outflows verified but not yet executed
        uint256 instantBudget; // optional public "instant bucket" per epoch (default 0 = off)
        uint256 instantSpent;
        uint256 openLimit; // B variant (F0.11): public K-only limit per epoch, counted in `spent` (0 = K-only path off)
    }

    struct AssetEnc {
        euint64 lmin; // L_min (owner knows)
        euint64 l; // L (owner knows) — upper bound of the tripwire range
        euint64 tau; // tripwire threshold, drawn with FHE randomness in [L_min, L] — nobody knows it
        euint64 big; // L_big — delay class of PIN-path outflows
        ebool tripped; // sticky; only K+P clears it
    }

    struct Op {
        Kind kind;
        Status status;
        uint8 sub; // outflow type or admin action
        bool paused; // a cancel guess is in flight
        bool viaDevice; // recovery co-signed by D
        uint32 ownerEpoch;
        uint32 escEpoch; // escape generation at opening: an escape cancels every op opened before it (K54)
        uint64 epochDay; // epoch of the K-only reservation
        uint64 readyAt;
        address target; // asset / token / call target
        address counterparty; // recipient or spender
        uint256 amount; // outflow amount or ETH value of a call
        bytes32 opHash; // binds the PIN challenge to the op content
        bytes32 h0; // evaluation `ok` handle, or stored encrypted payload
        bytes32 h1;
        bytes32 h2;
        bytes data; // call data / abi-encoded admin parameters
    }

    struct Layout {
        // roles
        address owner; // K
        address guardian; // G — watchtower (restrict-only + silent alarm decryption)
        address deviceSigner; // D — second device / passkey wrapper (EOA or ERC-1271)
        address recoveryHelper; // recovery helper: co-signer for a forgotten-PIN reset / the authenticated lane
        address escapeAddress; // E_addr — mandatory; set only with its own EIP-712 / ERC-1271 consent (K55, I24)
        uint64 escapeVerifiedAt; // last proof that E_addr is controlled (consent or signed ping); staleness blocks nothing
        uint32 escapeNonce; // consent nonce: an old consent of a former E_addr cannot be replayed
        // flags
        bool initialized;
        bool armed;
        bool pinSet;
        bool recoveryEnabled;
        bool autoKnown;
        uint8 restrictedReasons;
        uint32 ownerEpoch;
        uint32 pulsePeriod; // 0 = off
        uint64 lastPinAt;
        uint64 escapeReadyAt; // 0 = no escape in progress
        // escape lock (K44 / K54) and rotation lock (K45)
        address escapeTo; // E_addr snapshot taken when the escape started
        uint32 escEpoch; // bumped by startEscape: every op opened before it counts as cancelled (O(1), lazily)
        uint32 rotationsPending; // PIN-verified ROTATE_OWNER ops of the current key waiting for their delay
        uint256 opCount;
        Delays delays;
        // secret factor
        euint64 pinH; // Enc(first64(Argon2id(PIN, salt)))
        euint64 duressH; // Enc(duress fingerprint) or Enc(oblivious random)
        Track[3] tracks;
        mapping(bytes32 => bool) usedInput;
        mapping(uint256 => Guess) guesses;
        mapping(uint256 => Op) ops;
        // known sets (fixed size, encrypted)
        eaddress[30] knownR;
        eaddress[10] knownS;
        uint64[30] knownRActiveAt; // 0 = uninitialised, otherwise activation timestamp
        uint64[10] knownSActiveAt;
        // policy
        mapping(address => AssetCfg) assets;
        mapping(address => AssetEnc) assetEnc;
        // misc
        mapping(bytes32 => bool) approvedHashes; // ERC-1271, only via K+P
        mapping(address => uint256) refunds; // recovery-track bonds of successful guesses
        // B variant (F0.11, EncryptedAccountB only; appended so that A's layout is untouched): the known lists are
        // public. Every entry, also one added by hand and never used, is visible on-chain (OpenKnownChanged).
        bool openMode;
        mapping(address => uint64) openKnownR; // activation time; 0 = not on the list
        mapping(address => uint64) openKnownS;
    }

    // keccak256(abi.encode(uint256(keccak256("encrypted-account.account.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0x69b0cc5be722a1fbc0f4af700b954df411486df55095995ce386a11f614d6600;

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/// @notice Custom errors shared by the account and its libraries.
library Errors {
    error NotAuthorized();
    error NotArmed();
    error AlreadyInitialized();
    error AlreadyArmed();
    error SetupIncomplete();
    error BadStatus();
    error BadTrack();
    error SlotBusy();
    error Backoff(uint64 until);
    error EmptyInputProof();
    error InputReplayed();
    error StaleOp();
    error NotReady();
    error OpPaused();
    error InvalidParams();
    error BondTooLow(uint256 required);
    error EscapeActive();
    error NoEscape();
    error RecoveryDisabled();
    error BadSignature();
    error ForbiddenTarget();
    error TransferFailed();
    error NotTighter();
    error StaleChallenge(); // K53 / I23: the guess was made against another challenge — not evaluated, not counted
    error RotationLock(); // K45: K-track closed while a PIN-verified key rotation is pending (account has D / helper)
}

/// @notice Events shared by the account and its libraries (libraries emit them in the account's context).
interface IAccountEvents {
    event Initialized(address indexed owner, address indexed escapeAddress, address indexed guardian);
    event Armed();
    /// @param challenge PIN challenge c of the op (K53): the client takes it from the opening receipt, so a lagging
    ///        RPC read can never turn a correct PIN into a counted wrong guess.
    event OpOpened(uint256 indexed opId, uint8 kind, uint8 sub, address target, address counterparty, uint256 amount, uint64 challenge);
    event Evaluating(uint256 indexed opId, bytes32 okHandle);
    event EvaluationFinalized(uint256 indexed opId, bool ok);
    event GuessSubmitted(uint256 indexed opId, uint8 indexed track, bytes32 okHandle, bytes32 bigHandle);
    event GuessFinalized(uint256 indexed opId, uint8 indexed track, bool ok, uint64 readyAt);
    event OpExecuted(uint256 indexed opId);
    event OpCancelled(uint256 indexed opId);
    event RestrictionChanged(uint8 reasons);
    /// @notice Every op opened before this event (escEpoch < `escEpoch`) is cancelled (K54).
    event EscapeStarted(uint64 readyAt, address indexed to, uint32 escEpoch);
    event EscapeCancelled();
    event EscapeExecuted(address indexed to);
    event EscapeAddressChanged(address indexed escapeAddress, uint32 nonce);
    event EscapeVerified(uint64 at);
    event KnownSlotWritten(bool spenders, uint256 slot, uint64 activeAt);
    event LimitsSet(address indexed asset);
    event OwnerChanged(address indexed newOwner, uint32 epoch);
    event FingerprintChanged();
    /// @notice B variant (F0.11): a K-only outflow ran synchronously (open list, open limit); the watchtower reports it.
    event OpenOutflow(uint8 sub, address indexed asset, address indexed counterparty, uint256 amount, uint256 spent);
    /// @notice B variant: open-list change; activeAt = 0 means removed.
    event OpenKnownChanged(bool spenders, address indexed who, uint64 activeAt);
    event OpenLimitSet(address indexed asset, uint256 limit);
}
