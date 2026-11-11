// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, ebool, euint16, euint64, euint128, eaddress, externalEaddress, externalEuint16, externalEuint128} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "../vendor/openzeppelin-confidential/interfaces/IERC7984.sol";

/// @notice The parts of an Encrypted Account that a will reads. All of them exist on the account already.
interface IEncryptedAccountView {
    struct Delays {
        uint32 pinTransfer;
        uint32 bigTransfer;
        uint32 genericCall;
        uint32 settings;
        uint32 loosen;
        uint32 knownAdd;
        uint32 recovery;
        uint32 recoveryNoDevice;
        uint32 pinReset;
        uint32 escape;
        uint32 escapeChange;
    }

    function status()
        external
        view
        returns (
            bool armed,
            uint8 restrictedReasons,
            uint32 ownerEpoch,
            uint64 lastPinAt,
            uint32 pulsePeriod,
            uint64 escapeReadyAt,
            bool recoveryEnabled,
            bool autoKnown
        );

    function escapeState()
        external
        view
        returns (address escape_, address escapeTo, uint64 readyAt, uint64 verifiedAt, uint32 nonce, uint32 escEpoch, uint32 rotationsPending);

    function delays() external view returns (Delays memory);
}

/// @title EncryptedWill — hidden inheritance for an Encrypted Account, paid in ERC-7984 tokens
/// @notice
/// - **Heirs.** Four slots. Each holds an encrypted address, an encrypted 128-bit claim code and an encrypted share in
///   basis points. A slot is filled when it has an address or a code; empty slots are encrypted zeros, so the number
///   of heirs stays hidden. Shares are capped at 100 % in slot order, and whatever is left goes to the first filled
///   slot, so the shares of a will with at least one heir add up to exactly 10,000. Only the account sets them,
///   through its PIN path (`openCall` → PIN → delay → `executeOp`).
/// - **Proof of life** is the account's `lastPinAt`: every correct PIN on the account counts, nothing else does.
/// - **Trigger.** With no correct PIN for `inactivity` seconds anyone may `start`; a correct PIN during the next
///   `grace` seconds voids that start; after `grace` anyone may `settle`.
/// - **Rounds.** After settlement each token is paid out in rounds that anyone may run: `prepare` fixes the new money
///   since the last round, `snapshot` turns it into each slot's amount (one or more slots per call, so every call
///   stays far below Zama's HCU limits). Tokens that arrive later are paid out by the next round, with the same
///   shares.
/// - **Claims.** Anyone may claim to any recipient. A slot pays when the caller is its address and claims to itself
///   (address mode) or when the caller proves its code, bound to the recipient (code mode); otherwise the claim pays
///   an encrypted zero. The operation sequence and events do not depend on which case applies; gas depends only on
///   public facts (a claim's position in its round, whether the recipient already holds the token).
/// - **Exits.** Money leaves only (1) through claims, (2) through the account's `withdrawAll` before settlement,
///   (3) to the account's escape snapshot, if the account started its escape while its owner was provably alive, and
///   (4) to the account's escape address once the claim window after settlement has passed.
/// @dev One will per (account, inactivity, grace, claimWindow), as an ERC-1167 clone made by its factory, which also
///      enforces the allowed periods. The implementation stores its factory as an immutable and refuses any other
///      initializer.
contract EncryptedWill {
    uint256 public constant SLOTS = 4;
    uint64 internal constant BPS = 10_000;
    uint8 internal constant ALL_SLOTS = 0x0F;

    address public immutable FACTORY;

    struct TokenState {
        uint32 round; // rounds started so far (0: none)
        uint8 computed; // slots computed in the current round, one bit each
        bool preparing; // a round is open: claims wait until every slot is computed
        bool swept; // the residual went to the escape address; no more rounds or claims
        euint64 q; // new money of the open round ÷ 10,000
        euint64 r; // and its remainder
        euint64[SLOTS] amount; // what each slot may still claim
        ebool[SLOTS] claimed; // whether each slot claimed its amount
    }

    address public account;
    uint32 public inactivity;
    uint32 public grace;
    uint32 public claimWindow;
    bool public heirsSet;
    bool public settled;
    uint64 public startedAt;
    uint64 public settledAt;

    eaddress[SLOTS] internal _heirs;
    euint128[SLOTS] internal _codes;
    ebool[SLOTS] internal _codeActive;
    euint64[SLOTS] internal _shares; // basis points
    mapping(address token => TokenState) internal _tokens;
    uint256 private _entered;

    event Initialized(address indexed account, uint32 inactivity, uint32 grace, uint32 claimWindow);
    event HeirsSet();
    event Withdrawn(address indexed token, address indexed to);
    event WillStarted(uint64 at, uint64 settleableAt);
    event WillSettled(uint64 at);
    event RoundPrepared(address indexed token, uint32 round);
    event SlotsComputed(address indexed token, uint32 round, uint8 computed);
    event RoundComplete(address indexed token, uint32 round);
    event Claimed(address indexed token, address indexed caller, address indexed recipient, euint64 paid);
    event EscapeWithdrawn(address indexed token, address indexed to);
    event ResidualSwept(address indexed token, address indexed to);

    error AlreadyInitialized();
    error NotFactory();
    error InvalidParams();
    error NotAccount();
    error EmptyProof();
    error NoHeirs();
    error AlreadySettled();
    error NotSettled();
    error AlreadyStarted();
    error NotStarted();
    error TooEarly();
    error Reentrancy();
    error RoundOpen();
    error NoOpenRound();
    error RoundIncomplete();
    error NoRound();
    error Swept();
    error BadRange();
    error NoEscape();
    error EscapeAfterInactivity();

    modifier onlyAccount() {
        if (msg.sender != account) revert NotAccount();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 0) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address factory_) {
        FACTORY = factory_;
    }

    function initialize(address account_, uint32 inactivity_, uint32 grace_, uint32 claimWindow_) external {
        if (msg.sender != FACTORY) revert NotFactory();
        if (account != address(0)) revert AlreadyInitialized();
        if (account_ == address(0) || inactivity_ == 0 || grace_ == 0 || claimWindow_ == 0) revert InvalidParams();
        IEncryptedAccountView(account_).status(); // reverts unless account_ answers like an Encrypted Account
        FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig());
        account = account_;
        inactivity = inactivity_;
        grace = grace_;
        claimWindow = claimWindow_;
        emit Initialized(account_, inactivity_, grace_, claimWindow_);
    }

    // ───────────────────────────── the account (PIN path) ─────────────────────────────

    /// @notice Sets or replaces all four slots. An unused slot: the zero address, code 0 and share 0. A code-mode heir
    ///         has the zero address and a random nonzero code; an address-mode heir an address and code 0.
    /// @param sharesBps basis points; slot i receives at most what slots 0..i-1 left of 10,000, and the first filled
    ///        slot also receives whatever is left at the end.
    function setHeirs(
        externalEaddress[SLOTS] calldata heirs,
        externalEuint128[SLOTS] calldata codes,
        externalEuint16[SLOTS] calldata sharesBps,
        bytes calldata proof
    ) external onlyAccount {
        if (settled) revert AlreadySettled();
        // An empty proof would accept any handle the account is already allowed to use (Round 2's lesson).
        if (proof.length == 0) revert EmptyProof();
        euint16 left = FHE.asEuint16(uint16(BPS));
        euint16[SLOTS] memory s;
        ebool[SLOTS] memory filled;
        for (uint256 i; i < SLOTS; ++i) {
            eaddress h = FHE.fromExternal(heirs[i], proof);
            euint128 c = FHE.fromExternal(codes[i], proof);
            ebool active = FHE.ne(c, uint128(0));
            euint16 si = FHE.min(FHE.fromExternal(sharesBps[i], proof), left);
            left = FHE.sub(left, si);
            s[i] = si;
            filled[i] = FHE.or(FHE.ne(h, address(0)), active);
            FHE.allowThis(h);
            FHE.allowThis(c);
            FHE.allowThis(active);
            _heirs[i] = h;
            _codes[i] = c;
            _codeActive[i] = active;
        }
        // W1.1: the rest goes to the first filled slot.
        ebool found = FHE.asEbool(false);
        euint16 zero16 = FHE.asEuint16(0);
        for (uint256 i; i < SLOTS; ++i) {
            ebool first = FHE.and(filled[i], FHE.not(found));
            euint64 share = FHE.asEuint64(FHE.add(s[i], FHE.select(first, left, zero16)));
            found = FHE.or(found, filled[i]);
            FHE.allowThis(share);
            _shares[i] = share;
        }
        heirsSet = true;
        emit HeirsSet();
    }

    /// @notice Sends the will's whole balance of `token` to `to`, before settlement.
    function withdrawAll(IERC7984 token, address to) external onlyAccount nonReentrant {
        if (settled) revert AlreadySettled();
        if (to == address(0)) revert InvalidParams();
        _sendAll(token, to);
        emit Withdrawn(address(token), to);
    }

    // ───────────────────────────── the trigger (anyone) ─────────────────────────────

    /// @notice Starts the inheritance once the account has gone `inactivity` seconds without a correct PIN.
    function start() external {
        if (settled) revert AlreadySettled();
        if (!heirsSet) revert NoHeirs();
        uint64 pinAt = lastPinAt();
        if (startedAt != 0 && pinAt < startedAt) revert AlreadyStarted();
        if (block.timestamp < uint256(pinAt) + inactivity) revert TooEarly();
        startedAt = uint64(block.timestamp);
        emit WillStarted(uint64(block.timestamp), uint64(block.timestamp) + grace);
    }

    /// @notice Settles `grace` seconds after a start that no correct PIN has followed.
    function settle() external {
        if (settled) revert AlreadySettled();
        uint64 s = startedAt;
        if (s == 0 || lastPinAt() >= s) revert NotStarted();
        if (block.timestamp < uint256(s) + grace) revert TooEarly();
        settled = true;
        settledAt = uint64(block.timestamp);
        emit WillSettled(uint64(block.timestamp));
    }

    // ───────────────────────────── rounds (anyone) ─────────────────────────────

    /// @notice Opens a round for `token`: the new money is the balance minus what earlier rounds left unclaimed.
    function prepare(IERC7984 token) external {
        if (!settled) revert NotSettled();
        TokenState storage t = _tokens[address(token)];
        if (t.swept) revert Swept();
        if (t.preparing) revert RoundOpen();
        euint64 zero = FHE.asEuint64(0);
        euint64 bal = token.confidentialBalanceOf(address(this));
        if (!FHE.isInitialized(bal)) bal = zero;
        euint64 unpaid = zero;
        if (t.round != 0) {
            for (uint256 i; i < SLOTS; ++i) unpaid = FHE.add(unpaid, FHE.select(t.claimed[i], zero, t.amount[i]));
        }
        euint64 delta = FHE.select(FHE.ge(bal, unpaid), FHE.sub(bal, unpaid), zero);
        euint64 q = FHE.div(delta, BPS);
        euint64 r = FHE.rem(delta, BPS);
        FHE.allowThis(q);
        FHE.allowThis(r);
        t.q = q;
        t.r = r;
        t.round += 1;
        t.computed = 0;
        t.preparing = true;
        emit RoundPrepared(address(token), t.round);
    }

    /// @notice Computes slots [from, to) of the open round: amount_i = ⌊new money · share_i / 10,000⌋, computed as
    ///         q·s + ⌊r·s / 10,000⌋ (never overflows 64 bits for s ≤ 10,000), added to what the slot has not claimed.
    function snapshot(IERC7984 token, uint256 from, uint256 to) external {
        TokenState storage t = _tokens[address(token)];
        if (!t.preparing) revert NoOpenRound();
        if (from >= to || to > SLOTS) revert BadRange();
        bool firstRound = t.round == 1;
        ebool no = FHE.asEbool(false);
        FHE.allowThis(no);
        uint8 computed = t.computed;
        for (uint256 i = from; i < to; ++i) {
            if (computed & uint8(1 << i) != 0) continue;
            euint64 s = _shares[i];
            euint64 fresh = FHE.add(FHE.mul(t.q, s), FHE.div(FHE.mul(t.r, s), BPS));
            euint64 a = firstRound ? fresh : FHE.select(t.claimed[i], fresh, FHE.add(t.amount[i], fresh));
            FHE.allowThis(a);
            t.amount[i] = a;
            t.claimed[i] = no;
            computed |= uint8(1 << i);
        }
        t.computed = computed;
        emit SlotsComputed(address(token), t.round, computed);
        if (computed == ALL_SLOTS) {
            t.preparing = false;
            emit RoundComplete(address(token), t.round);
        }
    }

    // ───────────────────────────── claims (anyone) ─────────────────────────────

    /// @notice Pays `recipient` every unclaimed amount of `token` whose slot the caller matches: by address (the slot's
    ///         heir is msg.sender, and only in a claim to msg.sender itself) or by code (the slot is in code mode and
    ///         `codeInput` decrypts to code ⊕ h, with h the first 128 bits of keccak256(abi.encode(will, chainid,
    ///         recipient))). A relayer that swaps the recipient changes h and the match fails; an address heir that
    ///         relays someone else's code claim does not pay its own share to that recipient. Everyone else is paid
    ///         an encrypted zero.
    /// @dev The public condition `recipient == msg.sender` enters as an encrypted boolean, so every claim runs the
    ///      same FHE operations.
    /// @param codeInput encrypted for (this will, msg.sender); an address-mode heir may send any value.
    /// @return paid what the token actually transferred (decryptable by the recipient)
    function claim(IERC7984 token, address recipient, externalEuint128 codeInput, bytes calldata proof)
        external
        nonReentrant
        returns (euint64 paid)
    {
        if (!settled) revert NotSettled();
        TokenState storage t = _tokens[address(token)];
        if (t.swept) revert Swept();
        if (t.round == 0) revert NoRound();
        if (t.preparing) revert RoundIncomplete();
        if (recipient == address(0)) revert InvalidParams();
        if (proof.length == 0) revert EmptyProof();
        euint128 x = FHE.xor(FHE.fromExternal(codeInput, proof), _codeMask(recipient));
        ebool toSelf = FHE.asEbool(recipient == msg.sender);
        euint64 zero = FHE.asEuint64(0);
        euint64 total = zero;
        for (uint256 i; i < SLOTS; ++i) {
            ebool byAddress = FHE.and(FHE.eq(_heirs[i], msg.sender), toSelf);
            ebool byCode = FHE.and(_codeActive[i], FHE.eq(x, _codes[i]));
            ebool hit = FHE.and(FHE.or(byAddress, byCode), FHE.not(t.claimed[i]));
            total = FHE.add(total, FHE.select(hit, t.amount[i], zero));
            ebool c = FHE.or(t.claimed[i], hit);
            FHE.allowThis(c);
            t.claimed[i] = c;
        }
        FHE.allowTransient(total, address(token));
        paid = token.confidentialTransfer(recipient, total);
        emit Claimed(address(token), msg.sender, recipient, paid);
    }

    // ───────────────────────────── exits (anyone) ─────────────────────────────

    /// @notice W1.4: if the account started its escape while its owner was provably alive (before lastPinAt +
    ///         inactivity), the whole balance of `token` follows the escape to its snapshot address. An escape started
    ///         later cannot divert the inheritance.
    function escapeWithdraw(IERC7984 token) external nonReentrant {
        if (settled) revert AlreadySettled();
        (, address escapeTo, uint64 readyAt, , , , ) = IEncryptedAccountView(account).escapeState();
        if (readyAt == 0) revert NoEscape();
        uint256 escapeStart = uint256(readyAt) - IEncryptedAccountView(account).delays().escape;
        if (escapeStart >= uint256(lastPinAt()) + inactivity) revert EscapeAfterInactivity();
        _sendAll(token, escapeTo);
        emit EscapeWithdrawn(address(token), escapeTo);
    }

    /// @notice W1.5: `claimWindow` seconds after settlement, whatever is left of `token` goes to the account's escape
    ///         address (its snapshot if an escape is running) and claims of that token close.
    function sweepResidual(IERC7984 token) external nonReentrant {
        if (!settled) revert NotSettled();
        if (block.timestamp < uint256(settledAt) + claimWindow) revert TooEarly();
        (address escape_, address escapeTo, uint64 readyAt, , , , ) = IEncryptedAccountView(account).escapeState();
        address dest = readyAt != 0 ? escapeTo : escape_;
        _tokens[address(token)].swept = true;
        _sendAll(token, dest);
        emit ResidualSwept(address(token), dest);
    }

    function _sendAll(IERC7984 token, address to) internal {
        euint64 bal = token.confidentialBalanceOf(address(this));
        if (FHE.isInitialized(bal)) {
            FHE.allowTransient(bal, address(token));
            token.confidentialTransfer(to, bal);
        }
    }

    function _codeMask(address recipient) internal view returns (uint128) {
        return uint128(bytes16(keccak256(abi.encode(address(this), block.chainid, recipient))));
    }

    // ───────────────────────────── views ─────────────────────────────

    function lastPinAt() public view returns (uint64 t) {
        (, , , t, , , , ) = IEncryptedAccountView(account).status();
    }

    /// @notice The value a code-mode claimant must encrypt: code ⊕ codeMask(recipient).
    function codeMask(address recipient) external view returns (uint128) {
        return _codeMask(recipient);
    }

    /// @return phase 0 no heirs · 1 owner active · 2 startable · 3 started, grace running · 4 settleable · 5 settled
    /// @return pinAt the account's last correct PIN
    /// @return startableAt when `start` becomes possible (if no PIN comes first)
    /// @return settleableAt when `settle` becomes possible (0 without a live start)
    /// @return sweepableAt when `sweepResidual` becomes possible (0 before settlement)
    function state() external view returns (uint8 phase, uint64 pinAt, uint64 startableAt, uint64 settleableAt, uint64 sweepableAt) {
        pinAt = lastPinAt();
        startableAt = pinAt + inactivity;
        bool live = startedAt != 0 && pinAt < startedAt;
        if (live) settleableAt = startedAt + grace;
        if (settled) sweepableAt = settledAt + claimWindow;
        if (settled) phase = 5;
        else if (!heirsSet) phase = 0;
        else if (live) phase = block.timestamp >= settleableAt ? 4 : 3;
        else phase = block.timestamp >= startableAt ? 2 : 1;
    }

    function tokenState(address token) external view returns (uint32 round, uint8 computed, bool preparing, bool swept) {
        TokenState storage t = _tokens[token];
        return (t.round, t.computed, t.preparing, t.swept);
    }

    /// @notice Handles are opaque references, not data; tests and watchers use them.
    function heirHandles()
        external
        view
        returns (eaddress[SLOTS] memory heirs, euint128[SLOTS] memory codes, ebool[SLOTS] memory codeActive, euint64[SLOTS] memory shares)
    {
        return (_heirs, _codes, _codeActive, _shares);
    }

    function payout(address token) external view returns (euint64[SLOTS] memory amount, ebool[SLOTS] memory claimed, euint64 q, euint64 r) {
        TokenState storage t = _tokens[token];
        return (t.amount, t.claimed, t.q, t.r);
    }
}
