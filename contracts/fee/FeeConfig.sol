// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IFeeConfig} from "./IFeeConfig.sol";

/// @title FeeConfig — the protocol fee on PIN-verified transfers, shared by every account clone (F0.16)
/// @notice fee = clamp(amount * feeBps / 10_000, minFee, maxFee), per asset, in the asset's unit; a flat fee is feeBps = 0,
///         minFee = maxFee. The hard cap bounds the final fee: it never exceeds MAX_FEE_BPS (1%) of the amount, so neither
///         feeBps nor a high minFee can get around it (a minFee above 1% of a small amount is cut to 1%). An increase
///         waits INCREASE_DELAY (7 days), so users can leave before it applies; a decrease applies at once. An account
///         binds the quoted fee to the op when the op opens (it is part of the PIN challenge), so a change never touches
///         an op that is already open.
///         Unknown assets pay no fee.
contract FeeConfig is IFeeConfig {
    uint256 public constant MAX_FEE_BPS = 100;
    uint256 public constant INCREASE_DELAY = 7 days;

    struct Fee {
        uint16 bps;
        uint96 minFee;
        uint96 maxFee;
        bool set;
    }

    struct Pending {
        Fee fee;
        uint64 eta; // 0 = nothing pending
    }

    address public admin;
    address public pendingAdmin;
    address public feeRecipient;
    uint64 public version;
    mapping(address => Fee) internal _fees;
    mapping(address => Pending) internal _pending;

    event FeeSet(address indexed asset, uint16 bps, uint96 minFee, uint96 maxFee, uint64 version);
    event FeeQueued(address indexed asset, uint16 bps, uint96 minFee, uint96 maxFee, uint64 eta);
    event FeeCancelled(address indexed asset);
    event RecipientSet(address indexed recipient);
    event AdminTransferStarted(address indexed to);
    event AdminChanged(address indexed admin);

    error NotAdmin();
    error InvalidFee();
    error NotReady();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @notice The initial table is set here, before any account reads it, so it applies at once.
    constructor(address admin_, address recipient_, address[] memory assets, uint16[] memory bps, uint96[] memory minFees, uint96[] memory maxFees) {
        if (admin_ == address(0) || recipient_ == address(0)) revert InvalidFee();
        if (assets.length != bps.length || assets.length != minFees.length || assets.length != maxFees.length) revert InvalidFee();
        admin = admin_;
        feeRecipient = recipient_;
        emit AdminChanged(admin_);
        emit RecipientSet(recipient_);
        for (uint256 i = 0; i < assets.length; i++) _apply(assets[i], _checked(bps[i], minFees[i], maxFees[i]));
    }

    // ─────────────────────────────── reads ───────────────────────────────

    function quote(address asset, uint256 amount) external view returns (uint256 fee, uint64 version_) {
        version_ = version;
        Fee memory f = _fees[asset];
        if (!f.set) return (0, version_);
        fee = Math.mulDiv(amount, f.bps, 10_000);
        if (fee < f.minFee) fee = f.minFee;
        if (fee > f.maxFee) fee = f.maxFee;
        uint256 cap = Math.mulDiv(amount, MAX_FEE_BPS, 10_000);
        if (fee > cap) fee = cap;
    }

    function feeOf(address asset) external view returns (uint16 bps, uint96 minFee, uint96 maxFee, bool set) {
        Fee memory f = _fees[asset];
        return (f.bps, f.minFee, f.maxFee, f.set);
    }

    function pendingOf(address asset) external view returns (uint16 bps, uint96 minFee, uint96 maxFee, uint64 eta) {
        Pending memory p = _pending[asset];
        return (p.fee.bps, p.fee.minFee, p.fee.maxFee, p.eta);
    }

    // ─────────────────────────────── changes ───────────────────────────────

    /// @notice A change where no field goes up applies at once; anything else is queued for INCREASE_DELAY. A new
    ///         change replaces a pending one for the same asset. (0, 0, 0) removes the fee at once.
    function setFee(address asset, uint16 bps, uint96 minFee, uint96 maxFee) external onlyAdmin {
        Fee memory next = _checked(bps, minFee, maxFee);
        Fee memory cur = _fees[asset];
        bool decrease = bps <= cur.bps && minFee <= cur.minFee && maxFee <= cur.maxFee; // an unset asset reads as 0, 0, 0
        if (decrease) {
            delete _pending[asset];
            _apply(asset, next);
        } else {
            uint64 eta = uint64(block.timestamp + INCREASE_DELAY);
            _pending[asset] = Pending(next, eta);
            emit FeeQueued(asset, bps, minFee, maxFee, eta);
        }
    }

    /// @notice Applies a queued increase once its delay has passed. Permissionless: the change was announced.
    function applyFee(address asset) external {
        Pending memory p = _pending[asset];
        if (p.eta == 0 || block.timestamp < p.eta) revert NotReady();
        delete _pending[asset];
        _apply(asset, p.fee);
    }

    function cancelFee(address asset) external onlyAdmin {
        delete _pending[asset];
        emit FeeCancelled(asset);
    }

    /// @notice The recipient does not change what a user pays, so it changes at once.
    function setRecipient(address recipient_) external onlyAdmin {
        if (recipient_ == address(0)) revert InvalidFee();
        feeRecipient = recipient_;
        emit RecipientSet(recipient_);
    }

    function transferAdmin(address to) external onlyAdmin {
        pendingAdmin = to;
        emit AdminTransferStarted(to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminChanged(msg.sender);
    }

    // ─────────────────────────────── internals ───────────────────────────────

    function _checked(uint16 bps, uint96 minFee, uint96 maxFee) private pure returns (Fee memory) {
        if (bps > MAX_FEE_BPS || minFee > maxFee) revert InvalidFee();
        return Fee(bps, minFee, maxFee, bps != 0 || maxFee != 0);
    }

    function _apply(address asset, Fee memory f) private {
        _fees[asset] = f;
        version += 1;
        emit FeeSet(asset, f.bps, f.minFee, f.maxFee, version);
    }
}
