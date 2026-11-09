// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {AccountStorage as S, Errors, IAccountEvents} from "./AccountStorage.sol";
import {PolicyMath} from "./PolicyMath.sol";

/// @title OpenLib — opening pending ops, admin-parameter validation, co-signature and escape-address checks.
/// @notice External library executed via DELEGATECALL in the account's context.
library OpenLib {
    bytes32 internal constant RECOVERY_TAG = keccak256("encrypted-account/recovery/v1");
    bytes32 internal constant LANE_TAG = keccak256("encrypted-account/lane/v1");
    bytes32 internal constant PIN_RESET_TAG = keccak256("encrypted-account/pin-reset/v1");
    bytes32 internal constant CANCEL_TAG = keccak256("encrypted-account/device-cancel/v1");

    // EIP-712 (K55): E_addr signs typed data, so wallets show what it consents to; ERC-1271 for contract wallets.
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("EncryptedAccount");
    bytes32 internal constant VERSION_HASH = keccak256("1");
    bytes32 internal constant ESCAPE_TYPEHASH = keccak256("EscapeAddress(address escape,uint32 nonce)");
    bytes32 internal constant PING_TYPEHASH = keccak256("EscapePing(address escape,uint64 issuedAt)");

    // ─────────────────────────────── outflows ───────────────────────────────

    /// @return opId new op id
    /// @return kOnly whether the K-only (encrypted evaluation) path applies
    function openOutflow(uint8 sub, address asset, address cp, uint256 amount, bool viaPin) external returns (uint256 opId, bool kOnly) {
        if (cp == address(0) || cp == address(this) || amount == 0) revert Errors.InvalidParams();
        S.Layout storage l = S.layout();
        opId = _newOp(l, S.Kind.Outflow, sub, asset, cp, amount, "", 0, 0, 0);
        kOnly =
            !viaPin &&
            l.restrictedReasons == 0 &&
            PolicyMath.pulseOk(l) &&
            l.assets[asset].configured &&
            amount <= S.MAX_AMOUNT; // above it — the unlimited approval (type(uint256).max) included — always K+P
    }

    // ─────────────────────────────── generic call (default deny) ───────────────────────────────

    function openCall(address target, uint256 value, bytes calldata data, address acl, address executor) external returns (uint256) {
        if (target == address(0) || target == address(this) || target == acl || target == executor) revert Errors.ForbiddenTarget();
        if (data.length >= 4) {
            bytes4 sel = bytes4(data[:4]);
            // token transfers / approvals must go through the parsed (counted) outflow path
            if (sel == IERC20.transfer.selector || sel == IERC20.approve.selector) revert Errors.ForbiddenTarget();
        }
        return _newOp(S.layout(), S.Kind.Call, 0, target, address(0), value, data, 0, 0, 0);
    }

    // ─────────────────────────────── admin ───────────────────────────────

    function openAdmin(uint8 a, bytes calldata p) external returns (uint256) {
        S.Layout storage l = S.layout();
        bytes memory data = p;
        if (a == S.A_UNRESTRICT) {
            if (p.length != 0) revert Errors.InvalidParams();
        } else if (a == S.A_CANCEL_ESCAPE) {
            if (p.length != 0) revert Errors.InvalidParams();
            if (l.escapeReadyAt == 0) revert Errors.NoEscape();
            // I22: verifiable only on the lane; without D and helper an escape cannot be cancelled at all
            if (!PolicyMath.hasCosigner(l)) revert Errors.NotAuthorized();
        } else if (a == S.A_ROTATE_OWNER) {
            address k = abi.decode(p, (address));
            if (k == address(0) || k == l.escapeAddress) revert Errors.InvalidParams(); // role separation (E_addr ≠ K)
        } else if (a == S.A_SET_ESCAPE) {
            // K55 / I24: the new E_addr must consent with its own signature (bound to this account and nonce)
            (address e, bytes memory sig) = abi.decode(p, (address, bytes));
            if (e == address(0) || e == l.owner || e == l.guardian) revert Errors.InvalidParams(); // E_addr ≠ K, ≠ guardian
            _checkEscapeConsent(e, l.escapeNonce, sig);
            data = abi.encode(e, uint64(block.timestamp));
        } else if (a == S.A_SET_GUARDIAN) {
            if (abi.decode(p, (address)) == l.escapeAddress) revert Errors.InvalidParams(); // guardian ≠ E_addr (0 = none)
        } else if (a == S.A_SET_DEVICE || a == S.A_SET_HELPER) {
            abi.decode(p, (address));
        } else if (a == S.A_SET_PULSE) {
            abi.decode(p, (uint32));
        } else if (a == S.A_SET_RECOVERY || a == S.A_SET_AUTOKNOWN) {
            abi.decode(p, (bool));
        } else if (a == S.A_APPROVE_HASH) {
            abi.decode(p, (bytes32));
        } else if (a == S.A_SET_INSTANT) {
            abi.decode(p, (address, uint256));
        } else if (a == S.A_RESET_TRIP) {
            if (!l.assets[abi.decode(p, (address))].configured) revert Errors.InvalidParams();
        } else if ((a == S.A_ADD_KNOWN_R || a == S.A_ADD_KNOWN_S) && l.openMode) {
            // B (F0.11, I17): adding to the open list needs K+P; the address is public from this moment on
            address w = abi.decode(p, (address));
            if (w == address(0) || w == address(this)) revert Errors.InvalidParams();
        } else if (a == S.A_SET_OPEN_LIMIT && l.openMode) {
            (address asset, ) = abi.decode(p, (address, uint256));
            if (!l.assets[asset].configured) revert Errors.InvalidParams();
        } else {
            revert Errors.InvalidParams(); // CANCEL, FREEZE, PIN_CHANGE, SET_LIMITS, ADD_KNOWN have dedicated openers
        }
        return _newOp(l, S.Kind.Admin, a, address(0), address(0), 0, data, 0, 0, 0);
    }

    function openCancel(uint256 targetId) external returns (uint256) {
        S.Layout storage l = S.layout();
        if (!PolicyMath.cancellable(PolicyMath.status(l, l.ops[targetId]))) revert Errors.BadStatus();
        return _newOp(l, S.Kind.Admin, S.A_CANCEL, address(0), address(0), 0, abi.encode(targetId), 0, 0, 0);
    }

    /// @notice Admin op carrying encrypted payload handles (PIN change, set limits, add known).
    function openWithHandles(uint8 a, address target, bytes calldata data, bytes32 h0, bytes32 h1, bytes32 h2) external returns (uint256) {
        return _newOp(S.layout(), S.Kind.Admin, a, target, address(0), 0, data, h0, h1, h2);
    }

    /// @notice "P alone may restrict": anyone may open; only a correct PIN on the bonded recovery track executes it.
    function openFreeze() external returns (uint256) {
        return _newOp(S.layout(), S.Kind.Admin, S.A_FREEZE, address(0), address(0), 0, "", 0, 0, 0);
    }

    // ─────────────────────────────── recovery / reset ───────────────────────────────

    /// @notice Seedless recovery (Section 16.2): the new key K' signs; optional D co-signature shortens the delay.
    function openRecovery(address newOwner, bytes calldata newOwnerSig, bytes calldata deviceSig) external returns (uint256 opId) {
        S.Layout storage l = S.layout();
        if (!l.recoveryEnabled) revert Errors.RecoveryDisabled();
        if (l.escapeReadyAt != 0) revert Errors.EscapeActive();
        if (newOwner == address(0) || newOwner == l.escapeAddress) revert Errors.InvalidParams(); // E_addr ≠ K
        bytes32 digest = _digest(RECOVERY_TAG, keccak256(abi.encode(newOwner, l.ownerEpoch)));
        if (!SignatureChecker.isValidSignatureNow(newOwner, digest, newOwnerSig)) revert Errors.BadSignature();
        bool viaDevice = deviceSig.length != 0;
        if (viaDevice && (l.deviceSigner == address(0) || !SignatureChecker.isValidSignatureNow(l.deviceSigner, digest, deviceSig))) {
            revert Errors.BadSignature();
        }
        opId = _newOp(l, S.Kind.Recovery, 0, address(0), newOwner, 0, "", 0, 0, 0);
        l.ops[opId].viaDevice = viaDevice;
    }

    /// @notice Forgotten PIN (Section 16.3): K + co-signature of D or the recovery helper, long delay, no PIN.
    function openPinReset(bytes32 newFingerprintHandle, bytes calldata cosig) external returns (uint256 opId) {
        S.Layout storage l = S.layout();
        bytes32 digest = _digest(PIN_RESET_TAG, keccak256(abi.encode(newFingerprintHandle, l.ownerEpoch)));
        if (l.usedInput[digest]) revert Errors.InputReplayed();
        if (!_isCosigner(l, digest, cosig)) revert Errors.BadSignature();
        l.usedInput[digest] = true;
        opId = _newOp(l, S.Kind.PinReset, 0, address(0), address(0), 0, "", newFingerprintHandle, 0, 0);
        S.Op storage op = l.ops[opId];
        op.status = S.Status.Delayed;
        op.readyAt = uint64(block.timestamp) + l.delays.pinReset;
    }

    // ─────────────────────────────── escape address (K55) ───────────────────────────────

    /// @notice Setup: E_addr is mandatory and is set only with its consent (I24).
    function initEscape(address e, bytes calldata sig) external {
        S.Layout storage l = S.layout();
        _checkEscapeConsent(e, 0, sig);
        l.escapeAddress = e;
        l.escapeVerifiedAt = uint64(block.timestamp);
        l.escapeNonce = 1;
    }

    /// @notice Optional proof that E_addr is still controlled; anyone may submit it. Staleness blocks nothing —
    ///         the watchtower reminds the owner after 90 days.
    function escapePing(uint64 issuedAt, bytes calldata sig) external {
        S.Layout storage l = S.layout();
        if (issuedAt <= l.escapeVerifiedAt || issuedAt > block.timestamp) revert Errors.InvalidParams(); // fresh, never replayed
        bytes32 d = _typed(keccak256(abi.encode(PING_TYPEHASH, l.escapeAddress, issuedAt)));
        if (!SignatureChecker.isValidSignatureNow(l.escapeAddress, d, sig)) revert Errors.BadSignature();
        l.escapeVerifiedAt = issuedAt;
        emit IAccountEvents.EscapeVerified(issuedAt);
    }

    // ─────────────────────────────── co-signature checks ───────────────────────────────

    /// @notice Challenge c of an op, recomputed from its content (F0.15).
    function challengeOfOp(uint256 opId) external view returns (uint64) {
        return PolicyMath.challengeOf(opId, PolicyMath.opHashOf(opId, S.layout().ops[opId]));
    }

    function checkLane(uint256 opId, bytes32 guessHandle, bytes calldata cosig) external view {
        bytes32 digest = _digest(LANE_TAG, keccak256(abi.encode(opId, guessHandle)));
        if (!_isCosigner(S.layout(), digest, cosig)) revert Errors.BadSignature();
    }

    function checkDeviceCancel(uint256 opId, bytes calldata deviceSig) external view {
        S.Layout storage l = S.layout();
        bytes32 digest = _digest(CANCEL_TAG, keccak256(abi.encode(opId)));
        if (l.deviceSigner == address(0) || !SignatureChecker.isValidSignatureNow(l.deviceSigner, digest, deviceSig)) {
            revert Errors.BadSignature();
        }
    }

    // ─────────────────────────────── internals ───────────────────────────────

    /// @dev Every op opening goes through here. While an escape runs only CANCEL_ESCAPE can be opened (I21).
    ///      Encrypted payload handles are part of the op content: changing them changes the PIN challenge.
    function _newOp(
        S.Layout storage l,
        S.Kind kind,
        uint8 sub,
        address target,
        address cp,
        uint256 amount,
        bytes memory data,
        bytes32 h0,
        bytes32 h1,
        bytes32 h2
    ) private returns (uint256 opId) {
        if (l.escapeReadyAt != 0 && !(kind == S.Kind.Admin && sub == S.A_CANCEL_ESCAPE)) revert Errors.EscapeActive();
        opId = ++l.opCount;
        S.Op storage op = l.ops[opId];
        op.kind = kind;
        op.sub = sub;
        op.target = target;
        op.counterparty = cp;
        op.amount = amount;
        op.data = data;
        op.ownerEpoch = l.ownerEpoch;
        op.escEpoch = l.escEpoch;
        op.status = S.Status.NeedsPin;
        if (h0 != 0 || h1 != 0 || h2 != 0) {
            op.h0 = h0;
            op.h1 = h1;
            op.h2 = h2;
        }
        // F0.15: the content hash is not stored; PolicyMath.opHashOf recomputes it from the same fields
        bytes32 oh = PolicyMath.opHash(opId, kind, sub, target, cp, amount, keccak256(data), [h0, h1, h2]);
        emit IAccountEvents.OpOpened(opId, uint8(kind), sub, target, cp, amount, PolicyMath.challengeOf(opId, oh));
    }

    function _isCosigner(S.Layout storage l, bytes32 digest, bytes calldata sig) private view returns (bool) {
        return
            (l.deviceSigner != address(0) && SignatureChecker.isValidSignatureNow(l.deviceSigner, digest, sig)) ||
            (l.recoveryHelper != address(0) && SignatureChecker.isValidSignatureNow(l.recoveryHelper, digest, sig));
    }

    function _checkEscapeConsent(address e, uint32 nonce, bytes memory sig) private view {
        bytes32 d = _typed(keccak256(abi.encode(ESCAPE_TYPEHASH, e, nonce)));
        if (!SignatureChecker.isValidSignatureNow(e, d, sig)) revert Errors.BadSignature();
    }

    /// @dev EIP-712 digest; the domain is this account (clone address) on this chain.
    function _typed(bytes32 structHash) private view returns (bytes32) {
        bytes32 ds = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        return MessageHashUtils.toTypedDataHash(ds, structHash);
    }

    /// @dev EIP-191 personal-sign digest bound to chain, account and purpose.
    function _digest(bytes32 tag, bytes32 payload) private view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(tag, block.chainid, address(this), payload)));
    }
}
