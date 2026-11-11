// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, ebool, euint16, euint64, eaddress, externalEaddress, externalEuint16} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "../vendor/openzeppelin-confidential/interfaces/IERC7984.sol";

/// @notice The part of an Encrypted Account that a will reads: the time of the account's last correct PIN.
interface IEncryptedAccountStatus {
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
}

/// @title EncryptedWill — hidden inheritance for an Encrypted Account, paid in ERC-7984 tokens
/// @notice
/// - **Heirs.** Up to four, each an encrypted address with an encrypted share in basis points. Empty slots hold the
///   zero address and a zero share, so even the number of heirs stays hidden. Only the account sets them, through its
///   PIN path (`openCall` → PIN → delay → `executeOp`). Shares are capped on input so that they never add up to more
///   than 100 %, in slot order.
/// - **Proof of life** is the account's own `lastPinAt`: every correct PIN on the account counts, and nothing else
///   does. The account key alone neither proves life nor reaches the will.
/// - **Trigger.** With no correct PIN for `inactivity` seconds, anyone may `start`. A correct PIN during the next
///   `grace` seconds voids that start; no transaction is needed, `settle` compares the times. After `grace`, anyone may
///   `settle`.
/// - **Claims.** After settlement anyone may `claim` a token. The will pays the caller an encrypted amount: the
///   caller's share of the will's balance of that token at its first claim if the caller is an heir who has not
///   claimed it yet, and zero otherwise. A claim reveals neither whether its caller was an heir nor the amount.
/// - **Before settlement** the account may change the heirs or withdraw a token (both through the PIN path).
/// @dev One will per (account, inactivity, grace), deployed as an ERC-1167 clone by {EncryptedWillFactory}.
///      Tokens received after a token's first claim are not distributed.
contract EncryptedWill {
    uint256 public constant SLOTS = 4;
    uint64 internal constant BPS = 10_000;
    /// @notice Lower bound on both periods. Real wills use months; the Sepolia demo uses minutes.
    uint32 public constant MIN_PERIOD = 5 minutes;

    struct Payout {
        bool taken;
        euint64[SLOTS] amount;
        ebool[SLOTS] claimed;
    }

    address public account;
    uint32 public inactivity;
    uint32 public grace;
    bool public heirsSet;
    bool public settled;
    uint64 public startedAt;
    uint64 public settledAt;

    eaddress[SLOTS] internal _heirs;
    euint64[SLOTS] internal _shares; // basis points
    mapping(address token => Payout) internal _payouts;
    uint256 private _entered;

    event Initialized(address indexed account, uint32 inactivity, uint32 grace);
    event HeirsSet();
    event Withdrawn(address indexed token, address indexed to);
    event Started(uint64 at);
    event Settled(uint64 at);
    event Snapshot(address indexed token);
    event Claimed(address indexed token, address indexed caller, euint64 paid);

    error AlreadyInitialized();
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

    function initialize(address account_, uint32 inactivity_, uint32 grace_) external {
        if (account != address(0)) revert AlreadyInitialized();
        if (account_ == address(0) || inactivity_ < MIN_PERIOD || grace_ < MIN_PERIOD) revert InvalidParams();
        IEncryptedAccountStatus(account_).status(); // reverts unless account_ answers like an Encrypted Account
        FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig());
        account = account_;
        inactivity = inactivity_;
        grace = grace_;
        emit Initialized(account_, inactivity_, grace_);
    }

    // ───────────────────────────── the account (PIN path) ─────────────────────────────

    /// @notice Sets or replaces all four slots. Unused slots: the zero address and a zero share.
    /// @param sharesBps basis points; slot i receives at most what slots 0..i-1 left of 10 000.
    function setHeirs(
        externalEaddress[SLOTS] calldata heirs,
        externalEuint16[SLOTS] calldata sharesBps,
        bytes calldata proof
    ) external onlyAccount {
        if (settled) revert AlreadySettled();
        // An empty proof would accept any handle the account is already allowed to use (see the README).
        if (proof.length == 0) revert EmptyProof();
        euint16 left = FHE.asEuint16(uint16(BPS));
        for (uint256 i; i < SLOTS; ++i) {
            eaddress h = FHE.fromExternal(heirs[i], proof);
            euint16 s = FHE.min(FHE.fromExternal(sharesBps[i], proof), left);
            left = FHE.sub(left, s);
            euint64 s64 = FHE.asEuint64(s);
            FHE.allowThis(h);
            FHE.allowThis(s64);
            _heirs[i] = h;
            _shares[i] = s64;
        }
        heirsSet = true;
        emit HeirsSet();
    }

    /// @notice Sends the will's whole balance of `token` to `to`, before settlement.
    function withdrawAll(IERC7984 token, address to) external onlyAccount nonReentrant {
        if (settled) revert AlreadySettled();
        if (to == address(0)) revert InvalidParams();
        euint64 bal = token.confidentialBalanceOf(address(this));
        if (FHE.isInitialized(bal)) {
            FHE.allowTransient(bal, address(token));
            token.confidentialTransfer(to, bal);
        }
        emit Withdrawn(address(token), to);
    }

    // ───────────────────────────── anyone ─────────────────────────────

    /// @notice Starts the inheritance once the account has gone `inactivity` seconds without a correct PIN.
    function start() external {
        if (settled) revert AlreadySettled();
        if (!heirsSet) revert NoHeirs();
        uint64 pinAt = lastPinAt();
        if (startedAt != 0 && pinAt < startedAt) revert AlreadyStarted();
        if (block.timestamp < uint256(pinAt) + inactivity) revert TooEarly();
        startedAt = uint64(block.timestamp);
        emit Started(uint64(block.timestamp));
    }

    /// @notice Opens the claims `grace` seconds after a start that no correct PIN has voided.
    function settle() external {
        if (settled) revert AlreadySettled();
        uint64 s = startedAt;
        if (s == 0 || lastPinAt() >= s) revert NotStarted();
        if (block.timestamp < uint256(s) + grace) revert TooEarly();
        settled = true;
        settledAt = uint64(block.timestamp);
        emit Settled(uint64(block.timestamp));
    }

    /// @notice Pays the caller its encrypted share of `token`, or an encrypted zero. The first claim of a token fixes
    ///         every heir's amount from the will's balance at that moment.
    /// @return paid the amount the token actually transferred (decryptable by the caller)
    function claim(IERC7984 token) external nonReentrant returns (euint64 paid) {
        if (!settled) revert NotSettled();
        Payout storage p = _payouts[address(token)];
        if (!p.taken) _snapshot(token, p);
        euint64 zero = FHE.asEuint64(0);
        euint64 total = zero;
        for (uint256 i; i < SLOTS; ++i) {
            ebool hit = FHE.and(FHE.eq(_heirs[i], msg.sender), FHE.not(p.claimed[i]));
            total = FHE.add(total, FHE.select(hit, p.amount[i], zero));
            ebool c = FHE.or(p.claimed[i], hit);
            FHE.allowThis(c);
            p.claimed[i] = c;
        }
        FHE.allowTransient(total, address(token));
        paid = token.confidentialTransfer(msg.sender, total);
        emit Claimed(address(token), msg.sender, paid);
    }

    /// @dev amount_i = ⌊balance · share_i / 10 000⌋, computed as q·s + ⌊r·s / 10 000⌋ with q, r = balance ÷ 10 000,
    ///      which never overflows 64 bits for s ≤ 10 000. Shares sum to at most 10 000, so the amounts never exceed
    ///      the balance.
    function _snapshot(IERC7984 token, Payout storage p) internal {
        euint64 bal = token.confidentialBalanceOf(address(this));
        if (!FHE.isInitialized(bal)) bal = FHE.asEuint64(0);
        euint64 q = FHE.div(bal, BPS);
        euint64 r = FHE.rem(bal, BPS);
        ebool no = FHE.asEbool(false);
        FHE.allowThis(no);
        for (uint256 i; i < SLOTS; ++i) {
            euint64 s = _shares[i];
            euint64 a = FHE.add(FHE.mul(q, s), FHE.div(FHE.mul(r, s), BPS));
            FHE.allowThis(a);
            p.amount[i] = a;
            p.claimed[i] = no;
        }
        p.taken = true;
        emit Snapshot(address(token));
    }

    // ───────────────────────────── views ─────────────────────────────

    function lastPinAt() public view returns (uint64 t) {
        (, , , t, , , , ) = IEncryptedAccountStatus(account).status();
    }

    /// @return phase 0 no heirs · 1 owner active · 2 startable · 3 started, grace running · 4 settleable · 5 settled
    /// @return pinAt the account's last correct PIN
    /// @return startableAt when `start` becomes possible (if no PIN comes first)
    /// @return settleableAt when `settle` becomes possible (0 without a live start)
    function state() external view returns (uint8 phase, uint64 pinAt, uint64 startableAt, uint64 settleableAt) {
        pinAt = lastPinAt();
        startableAt = pinAt + inactivity;
        bool live = startedAt != 0 && pinAt < startedAt;
        if (live) settleableAt = startedAt + grace;
        if (settled) phase = 5;
        else if (!heirsSet) phase = 0;
        else if (live) phase = block.timestamp >= settleableAt ? 4 : 3;
        else phase = block.timestamp >= startableAt ? 2 : 1;
    }

    /// @notice Handles are opaque references, not data; tests and watchers use them.
    function heirHandles() external view returns (eaddress[SLOTS] memory heirs, euint64[SLOTS] memory shares) {
        return (_heirs, _shares);
    }

    function payout(address token) external view returns (bool taken, euint64[SLOTS] memory amount, ebool[SLOTS] memory claimed) {
        Payout storage p = _payouts[token];
        return (p.taken, p.amount, p.claimed);
    }
}
