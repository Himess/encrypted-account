// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64, ebool, eaddress, externalEuint64, externalEaddress, externalEbool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {CoprocessorConfig} from "@fhevm/solidity/lib/Impl.sol";
import {IAccount} from "@account-abstraction/contracts/interfaces/IAccount.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {AccountStorage as S, Errors, IAccountEvents} from "./AccountStorage.sol";
import {PolicyMath} from "./PolicyMath.sol";
import {PinLib} from "./PinLib.sol";
import {PolicyLib} from "./PolicyLib.sol";
import {OpsLib} from "./OpsLib.sol";
import {OpenLib} from "./OpenLib.sol";

/// @title EncryptedAccount — "Encrypted Account" v0.3, FHE back-end, open mode (Phase 0/1 prototype)
/// @notice ERC-4337 account whose PIN (Argon2id fingerprint), limits, random tripwire and known sets are
///         encrypted with Zama FHEVM and enforced on-chain — also against the holder of the owner key K.
/// @dev Design choices vs. the v0.3 document (see RESULTS.md):
///  - One account contract owns all encrypted state (one ACL identity); heavy logic sits in external
///    libraries (DELEGATECALL) to stay under 24 KiB. ERC-7579 packaging is deferred: a 7579 hook cannot hold
///    the queue and cannot close root paths of foreign accounts anyway.
///  - There is NO generic K-only `execute`. Funds leave only through: evaluated K-only outflows, PIN-verified
///    delayed ops, the optional public instant bucket, and the escape (fixed destination). (I11)
///  - The account's own ETH never pays gas for UserOps (paymaster required); K can always act directly from its
///    EOA, paying its own gas. (S19)
///  - Every user ciphertext needs a non-empty input proof (see PolicyMath.requireProof).
contract EncryptedAccount is IAccount, IERC1271, ReentrancyGuardTransient, IAccountEvents {
    uint256 internal constant SIG_VALIDATION_SUCCESS = 0;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    uint256 public constant BASE_BOND = PolicyMath.BASE_BOND;
    uint8 public constant PIN_KDF_VERSION = 1; // see sdk/src/fingerprint.ts (Argon2id parameters, public)

    IEntryPoint public immutable entryPoint;
    address public immutable aclAddress;
    address public immutable executorAddress;

    // ─────────────────────────────── modifiers ───────────────────────────────

    /// @dev K = owner EOA directly, or the EntryPoint after `validateUserOp` checked K's signature.
    modifier onlyK() {
        if (msg.sender != S.layout().owner && msg.sender != address(entryPoint)) revert Errors.NotAuthorized();
        _;
    }

    modifier onlySetup() {
        S.Layout storage l = S.layout();
        if (l.armed) revert Errors.AlreadyArmed();
        if (msg.sender != l.owner && msg.sender != address(entryPoint)) revert Errors.NotAuthorized();
        _;
    }

    modifier whenArmed() {
        if (!S.layout().armed) revert Errors.NotArmed();
        _;
    }

    /// @dev Zama's AA guidance: transient ACL / InputVerifier storage outlives a UserOp inside a bundle.
    modifier aaHygiene() {
        _;
        if (msg.sender == address(entryPoint)) FHE.cleanTransientStorage();
    }

    // ─────────────────────────────── construction ───────────────────────────────

    constructor(IEntryPoint ep) {
        entryPoint = ep;
        CoprocessorConfig memory cfg = ZamaConfig.getEthereumCoprocessorConfig();
        aclAddress = cfg.ACLAddress;
        executorAddress = cfg.CoprocessorAddress;
        S.layout().initialized = true; // the implementation itself can never be initialised
    }

    /// @notice Called by the factory in the same transaction that creates the clone.
    /// @param escapeSig EIP-712 consent of the escape address (ERC-1271 for a contract wallet), K55 / I24.
    function initialize(address owner_, address escape_, address guardian_, S.Delays calldata d, bytes calldata escapeSig) external {
        S.Layout storage l = S.layout();
        if (l.initialized) revert Errors.AlreadyInitialized();
        // Role separation: E_addr is neither K nor the guardian (a service must never receive the escaped funds)
        if (owner_ == address(0) || escape_ == address(0) || escape_ == owner_ || escape_ == guardian_) revert Errors.InvalidParams();
        l.initialized = true;
        FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig());
        l.owner = owner_;
        OpenLib.initEscape(escape_, escapeSig); // mandatory (K28), consented (K55)
        l.guardian = guardian_;
        l.delays = d;
        l.recoveryEnabled = true;
        l.autoKnown = true;
        l.pulsePeriod = 90 days; // K26 default
        if (_openMode()) l.openMode = true; // B variant (F0.11): set by EncryptedAccountB only
        emit Initialized(owner_, escape_, guardian_);
    }

    /// @dev Policy mode of this implementation: false = A (encrypted policy). EncryptedAccountB returns true.
    function _openMode() internal pure virtual returns (bool) {
        return false;
    }

    receive() external payable {}

    // ─────────────────────────────── setup (before arming) ───────────────────────────────

    function setupPin(
        externalEuint64 fingerprint,
        externalEuint64 duressCandidate,
        externalEbool useDuress,
        bytes calldata proof
    ) external onlySetup aaHygiene {
        PinLib.setupPin(fingerprint, duressCandidate, useDuress, proof);
    }

    function setupAsset(
        address asset,
        uint256 unit,
        externalEuint64 lmin,
        externalEuint64 lmax,
        externalEuint64 big,
        bytes calldata proof
    ) external virtual onlySetup aaHygiene {
        PolicyLib.setupLimits(asset, unit, lmin, lmax, big, proof);
    }

    function setupKnown(bool spenders, uint256 start, externalEaddress[] calldata vals, bytes calldata proof) external virtual onlySetup aaHygiene {
        PolicyLib.setupKnown(spenders, start, vals, proof);
    }

    function setupRoles(address device, address helper, uint32 pulse, bool autoKnown_) external onlySetup {
        S.Layout storage l = S.layout();
        l.deviceSigner = device;
        l.recoveryHelper = helper;
        l.pulsePeriod = pulse;
        l.autoKnown = autoKnown_;
    }

    function arm() external virtual onlySetup {
        S.Layout storage l = S.layout();
        if (!l.pinSet) revert Errors.SetupIncomplete();
        for (uint256 i = 0; i < S.N_RECIPIENTS; i++) if (l.knownRActiveAt[i] == 0) revert Errors.SetupIncomplete();
        for (uint256 i = 0; i < S.N_SPENDERS; i++) if (l.knownSActiveAt[i] == 0) revert Errors.SetupIncomplete();
        l.armed = true;
        emit Armed();
    }

    // ─────────────────────────────── outflows ───────────────────────────────

    /// @notice ETH (asset = 0) or ERC-20 transfer. K-only path if the policy says `ok`, otherwise PIN path.
    /// @param viaPin the owner's app routes amounts above L_min straight to the PIN path (never trips).
    function requestTransfer(address asset, address to, uint256 amount, bool viaPin) external virtual onlyK whenArmed nonReentrant aaHygiene returns (uint256) {
        return _openOutflow(asset == address(0) ? S.OUT_ETH : S.OUT_ERC20, asset, to, amount, viaPin);
    }

    /// @notice ERC-20 approve. amount = 0 (revocation) is restrictive → K alone, immediate.
    ///         Finite approval to a known spender within the hidden limit → K alone (counted, I16).
    ///         Unlimited approval → always K+P.
    function requestApprove(address token, address spender, uint256 amount, bool viaPin) external virtual onlyK whenArmed nonReentrant aaHygiene returns (uint256) {
        if (token == address(0)) revert Errors.InvalidParams();
        if (amount == 0) {
            OpsLib.performOutflow(S.OUT_APPROVE, token, spender, 0);
            return 0;
        }
        return _openOutflow(S.OUT_APPROVE, token, spender, amount, viaPin);
    }

    function _openOutflow(uint8 sub, address asset, address cp, uint256 amount, bool viaPin) internal returns (uint256 opId) {
        bool kOnly;
        (opId, kOnly) = OpenLib.openOutflow(sub, asset, cp, amount, viaPin);
        if (kOnly) PolicyLib.evaluate(opId); // returns false (stays NeedsPin) if the sum leaves the 64-bit range
    }

    /// @notice Phase 2 of a K-only outflow: verifies the KMS proof of `ok`. Permissionless (watchtower / relayer).
    function finalizeEvaluation(uint256 opId, bytes calldata cleartexts, bytes calldata decryptionProof) external nonReentrant {
        OpsLib.finalizeEvaluation(opId, cleartexts, decryptionProof);
    }

    // ─────────────────────────────── opening PIN-gated ops ───────────────────────────────

    /// @notice Any other call (default deny): always K+P and a delay. Token transfers / approvals must use the
    ///         parsed outflow path so that they are counted; FHE infrastructure and self-calls are forbidden.
    function openCall(address target, uint256 value, bytes calldata data) external onlyK whenArmed returns (uint256) {
        return OpenLib.openCall(target, value, data, aclAddress, executorAddress);
    }

    /// @notice Admin actions without encrypted payload.
    function openAdmin(uint8 action, bytes calldata params) external onlyK whenArmed returns (uint256) {
        return OpenLib.openAdmin(action, params);
    }

    function openCancel(uint256 targetId) external onlyK whenArmed returns (uint256) {
        return OpenLib.openCancel(targetId);
    }

    /// @notice PIN change: K + old P, then a delay during which the old PIN stays valid (Section 13.5).
    function openPinChange(externalEuint64 newFingerprint, bytes calldata proof) external onlyK whenArmed aaHygiene returns (uint256) {
        bytes32 h = PinLib.storeFingerprint(newFingerprint, proof);
        return OpenLib.openWithHandles(S.A_PIN_CHANGE, address(0), "", h, 0, 0);
    }

    function openSetLimits(
        address asset,
        uint256 unit,
        externalEuint64 lmin,
        externalEuint64 lmax,
        externalEuint64 big,
        bytes calldata proof
    ) external onlyK whenArmed aaHygiene returns (uint256) {
        if (unit == 0) revert Errors.InvalidParams();
        (bytes32 h0, bytes32 h1, bytes32 h2) = PolicyLib.storeLimits(lmin, lmax, big, proof);
        return OpenLib.openWithHandles(S.A_SET_LIMITS, asset, abi.encode(asset, unit), h0, h1, h2);
    }

    function openAddKnown(bool spenders, uint256 slot, externalEaddress addr, bytes calldata proof) external virtual onlyK whenArmed aaHygiene returns (uint256) {
        if (slot >= (spenders ? S.N_SPENDERS : S.N_RECIPIENTS)) revert Errors.InvalidParams();
        bytes32 h = PolicyLib.storeKnown(addr, proof);
        return OpenLib.openWithHandles(spenders ? S.A_ADD_KNOWN_S : S.A_ADD_KNOWN_R, address(0), abi.encode(slot), h, 0, 0);
    }

    /// @notice "P alone may restrict" (Section 11.3): anyone may open; only a correct PIN on the bonded
    ///         recovery track executes it (no delay).
    function openFreeze() external whenArmed returns (uint256) {
        return OpenLib.openFreeze();
    }

    /// @notice Seedless recovery (Section 16.2): new key K' signs; optional D co-signature shortens the delay.
    function openRecovery(address newOwner, bytes calldata newOwnerSig, bytes calldata deviceSig) external whenArmed returns (uint256) {
        return OpenLib.openRecovery(newOwner, newOwnerSig, deviceSig);
    }

    /// @notice Forgotten PIN (Section 16.3): K + co-signature of D or the recovery helper, long delay, no PIN.
    ///         K alone can never reset the PIN (I15).
    function openPinReset(externalEuint64 newFingerprint, bytes calldata proof, bytes calldata cosig) external onlyK whenArmed aaHygiene returns (uint256) {
        bytes32 h = PinLib.storeFingerprint(newFingerprint, proof);
        return OpenLib.openPinReset(h, cosig);
    }

    // ─────────────────────────────── PIN guesses ───────────────────────────────

    /// @notice Challenge c of an op; the client encrypts (h + c) mod 2^64 (Section 13.2). Clients should take c from
    ///         the `OpOpened` event of the opening receipt instead (K53): a lagging RPC read is then impossible.
    function challengeOf(uint256 opId) public view returns (uint64) {
        return OpenLib.challengeOfOp(opId);
    }

    /// @notice K-track guess (K signed via EntryPoint, or K's EOA directly).
    /// @dev The FHE input must be created for (this account, msg.sender) — i.e. user = EntryPoint for UserOps.
    /// @param c the challenge the guess was computed with; a different one reverts without counting (K53).
    function submitGuess(uint256 opId, uint64 c, externalEuint64 guess, bytes calldata proof) external onlyK whenArmed nonReentrant aaHygiene {
        PinLib.submitGuess(opId, c, guess, proof, S.TRACK_OWNER, address(0), 0);
    }

    /// @notice Authenticated lane: K + co-signature of D or the recovery helper. Own slot and score, outside
    ///         the shared anonymous budget, so a thief holding only K cannot lock the owner out (S9). The only
    ///         track on which CANCEL_ESCAPE can be verified (I22).
    function submitGuessWithCosign(uint256 opId, uint64 c, externalEuint64 guess, bytes calldata proof, bytes calldata cosig) external onlyK whenArmed nonReentrant aaHygiene {
        OpenLib.checkLane(opId, externalEuint64.unwrap(guess), cosig);
        PinLib.submitGuess(opId, c, guess, proof, S.TRACK_LANE, address(0), 0);
    }

    /// @notice Anonymous recovery track (new device via a relayer): only Recovery / Freeze ops, bonded.
    ///         The bond doubles with every point of the recovery-track score and is kept by the account on failure.
    function submitRecoveryGuess(uint256 opId, uint64 c, externalEuint64 guess, bytes calldata proof) external payable whenArmed nonReentrant {
        uint256 req = recoveryBond();
        if (msg.value < req) revert Errors.BondTooLow(req);
        PinLib.submitGuess(opId, c, guess, proof, S.TRACK_RECOVERY, msg.sender, msg.value);
    }

    function bondFor(uint32 score_) public pure returns (uint256) {
        return PolicyMath.bondFor(score_);
    }

    /// @notice Bond required for the next recovery-track guess.
    function recoveryBond() public view returns (uint256) {
        return PolicyMath.bondFor(PolicyMath.score(S.layout().tracks[S.TRACK_RECOVERY]));
    }

    /// @notice Permissionless phase 2 of a guess (the watchtower auto-finalizes; the user never clicks twice).
    function finalizeGuess(uint256 opId, bytes calldata cleartexts, bytes calldata decryptionProof) external nonReentrant {
        (bool ok, bool big, uint8 track) = PinLib.finalizeGuess(opId, cleartexts, decryptionProof);
        OpsLib.afterGuess(opId, ok, big, track);
    }

    // ─────────────────────────────── execution ───────────────────────────────

    /// @notice Executes a verified op after its delay. Permissionless: the content is fixed and verified.
    function executeOp(uint256 opId) external nonReentrant aaHygiene {
        OpsLib.executeOp(opId);
    }

    /// @dev Self-call target so that auto-"known" can be wrapped in try/catch (best effort).
    function autoKnownHook(bool spenders, address who) external {
        if (msg.sender != address(this)) revert Errors.NotAuthorized();
        PolicyLib.autoAddKnown(spenders, who);
    }

    // ─────────────────────────────── restrictive actions (one factor, immediate) ───────────────────────────────

    function restrict() external onlyK {
        _addRestriction(S.layout(), S.R_OWNER);
    }

    function guardianRestrict() external {
        S.Layout storage l = S.layout();
        if (msg.sender != l.guardian || msg.sender == address(0)) revert Errors.NotAuthorized();
        _addRestriction(l, S.R_GUARDIAN);
    }

    /// @notice K + D veto (oracle-independent, Section 16.7): D is verified directly on-chain.
    function cancelWithDevice(uint256 opId, bytes calldata deviceSig) external onlyK nonReentrant {
        OpenLib.checkDeviceCancel(opId, deviceSig);
        OpsLib.cancel(opId);
    }

    function tightenLimits(address asset, externalEuint64 cap, externalEuint64 bigCap, bytes calldata proof) external onlyK whenArmed aaHygiene {
        PolicyLib.tighten(asset, cap, bigCap, proof);
    }

    function removeKnown(bool spenders, uint256 slot, externalEbool doRemove, bytes calldata proof) external virtual onlyK whenArmed aaHygiene {
        PolicyLib.removeKnown(spenders, slot, doRemove, proof);
    }

    function disableRecovery() external onlyK {
        S.layout().recoveryEnabled = false;
    }

    function disableAutoKnown() external onlyK {
        S.layout().autoKnown = false;
    }

    function shortenPulse(uint32 period) external onlyK {
        S.Layout storage l = S.layout();
        if (period == 0 || (l.pulsePeriod != 0 && period >= l.pulsePeriod)) revert Errors.NotTighter();
        l.pulsePeriod = period;
    }

    function lowerInstantBudget(address asset, uint256 budget) external onlyK {
        S.AssetCfg storage cfg = S.layout().assets[asset];
        if (budget > cfg.instantBudget) revert Errors.NotTighter();
        cfg.instantBudget = budget;
    }

    // ─────────────────────────────── instant bucket (optional, public, default off) ───────────────────────────────

    function instantTransfer(address asset, address to, uint256 amount) external onlyK whenArmed nonReentrant {
        S.Layout storage l = S.layout();
        if (l.escapeReadyAt != 0) revert Errors.EscapeActive(); // I21: no K-only movement during an escape
        if (l.restrictedReasons != 0 || !PolicyMath.pulseOk(l)) revert Errors.NotAuthorized();
        if (to == address(0) || to == address(this)) revert Errors.InvalidParams();
        S.AssetCfg storage cfg = l.assets[asset];
        PolicyMath.rollEpoch(cfg);
        if (PolicyMath.counterOf(cfg.instantSpent) + amount > cfg.instantBudget) revert Errors.InvalidParams();
        cfg.instantSpent = PolicyMath.counterAdd(cfg.instantSpent, amount);
        OpsLib.performOutflow(asset == address(0) ? S.OUT_ETH : S.OUT_ERC20, asset, to, amount);
    }

    // ─────────────────────────────── escape (works without FHE) ───────────────────────────────

    /// @notice K alone; after the escape delay funds can ONLY go to the escape address as it was at this moment (I7).
    ///         Not blocked by restricted mode, PIN lock-outs, a KMS outage, an ACL pause or an ACL deny-list.
    ///         K44 / K54: every pending op is cancelled (O(1): ops opened before carry an older escEpoch), the
    ///         anonymous PIN tracks and every K-only path close, and only the lane can cancel the escape (I21, I22).
    ///         Cancelled ops do not come back if the escape is cancelled.
    function startEscape() external onlyK {
        S.Layout storage l = S.layout();
        if (l.escapeReadyAt != 0) revert Errors.EscapeActive();
        l.escapeReadyAt = uint64(block.timestamp) + l.delays.escape;
        l.escapeTo = l.escapeAddress; // snapshot (K44)
        l.escEpoch += 1;
        l.rotationsPending = 0; // the pending rotations are cancelled too
        emit EscapeStarted(l.escapeReadyAt, l.escapeTo, l.escEpoch);
    }

    /// @dev Deliberately contains no FHE / ACL call. Permissionless (destination is fixed).
    function executeEscape(address[] calldata tokens) external nonReentrant {
        S.Layout storage l = S.layout();
        if (l.escapeReadyAt == 0) revert Errors.NoEscape();
        if (block.timestamp < l.escapeReadyAt) revert Errors.NotReady();
        OpsLib.sweep(tokens, l.escapeTo);
        emit EscapeExecuted(l.escapeTo);
    }

    /// @notice Signed proof that E_addr is still controlled (K55); anyone may relay it. Staleness blocks nothing.
    function escapePing(uint64 issuedAt, bytes calldata sig) external {
        OpenLib.escapePing(issuedAt, sig);
    }

    // ─────────────────────────────── ERC-4337 ───────────────────────────────

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds) external view returns (uint256) {
        if (msg.sender != address(entryPoint)) revert Errors.NotAuthorized();
        // Gas-drain guard (S19): a thief with K could otherwise bundle his own UserOp with huge gas fields and
        // collect the account's ETH as "fees" before any policy runs. No FHE here (ERC-7562).
        if (userOp.paymasterAndData.length < 20 || missingAccountFunds != 0) return SIG_VALIDATION_FAILED;
        (address rec, ECDSA.RecoverError err, ) = ECDSA.tryRecover(userOpHash, userOp.signature);
        if (err != ECDSA.RecoverError.NoError || rec != S.layout().owner) return SIG_VALIDATION_FAILED;
        return SIG_VALIDATION_SUCCESS;
    }

    // ─────────────────────────────── ERC-1271 ───────────────────────────────

    /// @notice K alone never makes a signature valid (Permit / Permit2 / orders): only digests approved by a
    ///         K+P op are accepted (Section 11.5).
    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        return S.layout().approvedHashes[hash] ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    // ─────────────────────────────── refunds ───────────────────────────────

    function claimRefund() external nonReentrant {
        S.Layout storage l = S.layout();
        uint256 amt = l.refunds[msg.sender];
        l.refunds[msg.sender] = 0;
        (bool s, ) = payable(msg.sender).call{value: amt}("");
        if (!s) revert Errors.TransferFailed();
    }

    // ─────────────────────────────── views ───────────────────────────────

    function confidentialProtocolId() external view returns (uint256) {
        return ZamaConfig.getConfidentialProtocolId();
    }

    function owner() external view returns (address) {
        return S.layout().owner;
    }

    function roles() external view returns (address owner_, address guardian_, address device_, address helper_, address escape_) {
        S.Layout storage l = S.layout();
        return (l.owner, l.guardian, l.deviceSigner, l.recoveryHelper, l.escapeAddress);
    }

    function status()
        external
        view
        returns (bool armed, uint8 restrictedReasons, uint32 ownerEpoch, uint64 lastPinAt, uint32 pulsePeriod, uint64 escapeReadyAt, bool recoveryEnabled, bool autoKnown)
    {
        S.Layout storage l = S.layout();
        return (l.armed, l.restrictedReasons, l.ownerEpoch, l.lastPinAt, l.pulsePeriod, l.escapeReadyAt, l.recoveryEnabled, l.autoKnown);
    }

    /// @return score effective wrong-guess score of the track (after decay)
    /// @return nextAllowedAt earliest next attempt (anonymous tracks: the shared budget, K56)
    /// @return pendingOp in-flight guess
    /// @return lastAt last attempt on this track
    function trackState(uint8 track) external view returns (uint32 score, uint64 nextAllowedAt, uint256 pendingOp, uint64 lastAt) {
        S.Layout storage l = S.layout();
        S.Track storage t = l.tracks[track];
        return (PolicyMath.score(t), PolicyMath.nextAllowed(l, track), t.pendingOp, t.lastAt);
    }

    /// @notice Shared anonymous budget, derived (not stored): K-track score + recovery-track score (K56).
    function sharedBudget() external view returns (uint32 score, uint64 nextAllowedAt) {
        S.Layout storage l = S.layout();
        return (PolicyMath.score(l.tracks[S.TRACK_OWNER]) + PolicyMath.score(l.tracks[S.TRACK_RECOVERY]), PolicyMath.nextAllowed(l, S.TRACK_OWNER));
    }

    /// @notice Escape state: E_addr, the snapshot of a running escape, readiness, last verification, nonce,
    ///         escape generation and the number of pending PIN-verified rotations (K45 lock).
    function escapeState()
        external
        view
        returns (address escape_, address escapeTo, uint64 readyAt, uint64 verifiedAt, uint32 nonce, uint32 escEpoch, uint32 rotationsPending)
    {
        S.Layout storage l = S.layout();
        return (l.escapeAddress, l.escapeTo, l.escapeReadyAt, l.escapeVerifiedAt, l.escapeNonce, l.escEpoch, l.rotationsPending);
    }

    /// @notice Op with its effective status (an escape cancels every op opened before it, K54).
    function getOp(uint256 opId) external view returns (S.Op memory o) {
        S.Layout storage l = S.layout();
        o = l.ops[opId];
        o.status = PolicyMath.status(l, l.ops[opId]);
    }

    function getGuess(uint256 opId) external view returns (S.Guess memory) {
        return PinLib.guessOf(opId);
    }

    function opCount() external view returns (uint256) {
        return S.layout().opCount;
    }

    /// @notice Asset counters; `reserved` / `pinCommitted` of orphaned ops (owner change, escape) read as 0.
    function assetState(address asset) external view returns (S.AssetCfg memory c) {
        S.Layout storage l = S.layout();
        c = l.assets[asset];
        if (c.gen != PolicyMath.gen(l)) {
            c.reserved = 0;
            c.pinCommitted = 0;
        }
        c.spent = PolicyMath.counterOf(c.spent);
        c.pinSpent = PolicyMath.counterOf(c.pinSpent);
        c.instantSpent = PolicyMath.counterOf(c.instantSpent);
    }

    function delays() external view returns (S.Delays memory) {
        return S.layout().delays;
    }

    /// @notice Handles are not secrets (anyone can read storage); exposed for tooling, tests and the watchtower.
    function encryptedHandles(address asset)
        external
        view
        returns (bytes32 pinH, bytes32 duressH, bytes32 lmin, bytes32 lmax, bytes32 tau, bytes32 big, bytes32 tripped)
    {
        S.Layout storage l = S.layout();
        S.AssetEnc storage e = l.assetEnc[asset];
        return (
            euint64.unwrap(l.pinH),
            euint64.unwrap(l.duressH),
            euint64.unwrap(e.lmin),
            euint64.unwrap(e.l),
            euint64.unwrap(e.tau),
            euint64.unwrap(e.big),
            ebool.unwrap(e.tripped)
        );
    }

    function knownSlot(bool spenders, uint256 slot) external view returns (bytes32 handle, uint64 activeAt) {
        S.Layout storage l = S.layout();
        if (spenders) return (eaddress.unwrap(l.knownS[slot]), l.knownSActiveAt[slot]);
        return (eaddress.unwrap(l.knownR[slot]), l.knownRActiveAt[slot]);
    }

    function approvedHash(bytes32 h) external view returns (bool) {
        return S.layout().approvedHashes[h];
    }

    function refundOf(address a) external view returns (uint256) {
        return S.layout().refunds[a];
    }

    // ─────────────────────────────── internals ───────────────────────────────

    function _addRestriction(S.Layout storage l, uint8 reason) internal {
        l.restrictedReasons |= reason;
        emit RestrictionChanged(l.restrictedReasons);
    }
}
