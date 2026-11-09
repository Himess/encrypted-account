// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {externalEuint64, externalEaddress, externalEbool} from "@fhevm/solidity/lib/FHE.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccountStorage as S, Errors} from "./AccountStorage.sol";
import {PolicyMath} from "./PolicyMath.sol";
import {PolicyLib} from "./PolicyLib.sol";
import {OpsLib} from "./OpsLib.sol";
import {OpenLib} from "./OpenLib.sol";
import {EncryptedAccount} from "./EncryptedAccount.sol";

/// @title EncryptedAccountB — B variant of the open mode (F0.11; v0.3 §9.6 "code both, decide with data")
/// @notice The same account as A — PIN, escape, recovery, lane and the PIN path stay FHE and unchanged — except the
///         K-only path:
///   - the known recipient / spender lists and the per-epoch K-only limit are PUBLIC;
///   - a K-only outflow to a listed counterparty within the limit runs synchronously, in one transaction, without FHE,
///     and emits OpenOutflow, which the watchtower reports;
///   - anything else (unknown counterparty, over the limit, unlimited approval, restricted mode, expired pulse) opens
///     the unchanged FHE PIN path.
///   A list entry is added with K+P (ADD_KNOWN op, `knownAdd` delay) or after the first PIN-verified send (autoKnown);
///   K alone can only remove (I17). The policy mode is fixed by the implementation the account is cloned from, so it
///   is chosen at setup. Private mode and agent accounts stay on A.
/// @dev What B gives up against A (F0.11 table): the lists — also entries added by hand and never used — and the limit
///      are public, and there is no hidden random tripwire: a K thief knows exactly how much he can move per epoch, and
///      to whom (only to the owner's listed counterparties).
contract EncryptedAccountB is EncryptedAccount {
    using SafeERC20 for IERC20;

    constructor(IEntryPoint ep) EncryptedAccount(ep) {}

    function _openMode() internal pure override returns (bool) {
        return true;
    }

    // ─────────────────────────────── setup (before arming) ───────────────────────────────

    /// @notice Public K-only limit per epoch (`openLimit`, token base units) and the encrypted L_big that sets the PIN
    ///         path's delay class (the PIN path is unchanged). No L_min, L or tripwire.
    function setupAssetOpen(address asset, uint256 unit, uint256 openLimit, externalEuint64 big, bytes calldata proof) external onlySetup aaHygiene {
        PolicyLib.setupBig(asset, unit, openLimit, big, proof);
    }

    /// @notice Public list entries, active at once. The lists may also stay empty: PIN-verified sends fill them.
    function setupKnownOpen(bool spenders, address[] calldata who) external onlySetup {
        S.Layout storage l = S.layout();
        for (uint256 i = 0; i < who.length; i++) {
            if (who[i] == address(0) || who[i] == address(this)) revert Errors.InvalidParams();
            OpsLib.openKnownAdd(l, spenders, who[i]);
        }
    }

    function arm() external override onlySetup {
        S.Layout storage l = S.layout();
        if (!l.pinSet) revert Errors.SetupIncomplete();
        l.armed = true;
        emit Armed();
    }

    // A's encrypted list / limit entry points have no meaning in B.
    function setupAsset(address, uint256, externalEuint64, externalEuint64, externalEuint64, bytes calldata) external pure override {
        revert Errors.InvalidParams();
    }

    function setupKnown(bool, uint256, externalEaddress[] calldata, bytes calldata) external pure override {
        revert Errors.InvalidParams();
    }

    function openAddKnown(bool, uint256, externalEaddress, bytes calldata) external pure override returns (uint256) {
        revert Errors.InvalidParams(); // B: openAdmin(ADD_KNOWN_R / ADD_KNOWN_S, abi.encode(address))
    }

    function removeKnown(bool, uint256, externalEbool, bytes calldata) external pure override {
        revert Errors.InvalidParams(); // B: removeKnownOpen
    }

    // ─────────────────────────────── outflows ───────────────────────────────

    /// @return opId 0 if the transfer ran in this transaction (K-only, open path); otherwise the PIN op's id
    function requestTransfer(address asset, address to, uint256 amount, bool viaPin) external override onlyK whenArmed nonReentrant returns (uint256) {
        return _outflow(asset == address(0) ? S.OUT_ETH : S.OUT_ERC20, asset, to, amount, viaPin);
    }

    /// @notice amount = 0 (revocation) is restrictive: K alone, immediate, also during an escape. A finite approval to
    ///         a listed spender within the limit runs synchronously (counted, I16); an unlimited one always needs K+P.
    function requestApprove(address token, address spender, uint256 amount, bool viaPin) external override onlyK whenArmed nonReentrant returns (uint256) {
        if (token == address(0)) revert Errors.InvalidParams();
        if (amount == 0) {
            IERC20(token).forceApprove(spender, 0);
            return 0;
        }
        return _outflow(S.OUT_APPROVE, token, spender, amount, viaPin);
    }

    function _outflow(uint8 sub, address asset, address cp, uint256 amount, bool viaPin) private returns (uint256 opId) {
        S.Layout storage l = S.layout();
        if (l.escapeReadyAt != 0) revert Errors.EscapeActive(); // I21: no K-only movement during an escape
        if (cp == address(0) || cp == address(this) || amount == 0) revert Errors.InvalidParams();
        S.AssetCfg storage cfg = l.assets[asset];
        if (!viaPin && _openOk(l, cfg, sub, cp, amount)) {
            cfg.spent = PolicyMath.counterAdd(cfg.spent, amount); // I12: nothing but the epoch roll lowers it
            emit OpenOutflow(sub, asset, cp, amount, PolicyMath.counterOf(cfg.spent));
            if (sub == S.OUT_ETH) {
                (bool s, ) = payable(cp).call{value: amount}("");
                if (!s) revert Errors.TransferFailed();
            } else if (sub == S.OUT_ERC20) {
                IERC20(asset).safeTransfer(cp, amount);
            } else {
                IERC20(asset).forceApprove(cp, amount);
            }
            return 0;
        }
        (opId, ) = OpenLib.openOutflow(sub, asset, cp, amount, true); // the PIN path, unchanged (FHE)
    }

    /// @dev Every condition is public: listed counterparty, within the epoch limit, not restricted, pulse valid, not an
    ///      unlimited approval (I1, I2, I11, I16, I18).
    function _openOk(S.Layout storage l, S.AssetCfg storage cfg, uint8 sub, address cp, uint256 amount) private returns (bool) {
        if (l.restrictedReasons != 0 || !PolicyMath.pulseOk(l) || !cfg.configured) return false;
        if (sub == S.OUT_APPROVE && amount == type(uint256).max) return false;
        uint64 at = sub == S.OUT_APPROVE ? l.openKnownS[cp] : l.openKnownR[cp];
        if (at == 0 || at > block.timestamp) return false;
        PolicyMath.rollEpoch(cfg);
        uint256 s = PolicyMath.counterOf(cfg.spent);
        return s <= cfg.openLimit && amount <= cfg.openLimit - s; // no overflow for huge amounts
    }

    // ─────────────────────────────── restrictive actions (K alone, immediate) ───────────────────────────────

    /// @notice K alone may only remove (I17). Raising the limit or adding an entry is a K+P op.
    function removeKnownOpen(bool spenders, address who) external onlyK {
        S.Layout storage l = S.layout();
        mapping(address => uint64) storage m = spenders ? l.openKnownS : l.openKnownR;
        if (m[who] == 0) revert Errors.InvalidParams();
        delete m[who];
        emit OpenKnownChanged(spenders, who, 0);
    }

    /// @notice K alone, immediate: the public limit can only go down (raising it: openAdmin(SET_OPEN_LIMIT), K+P).
    function lowerOpenLimit(address asset, uint256 limit) external onlyK {
        S.AssetCfg storage cfg = S.layout().assets[asset];
        if (limit >= cfg.openLimit) revert Errors.NotTighter();
        cfg.openLimit = limit;
        emit OpenLimitSet(asset, limit);
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @return activeAt activation time of the open-list entry (0 = not on the list)
    function openKnown(bool spenders, address who) external view returns (uint64) {
        S.Layout storage l = S.layout();
        return spenders ? l.openKnownS[who] : l.openKnownR[who];
    }
}
