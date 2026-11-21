// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {AccountStorage as S, Errors} from "./AccountStorage.sol";

/// @title Disclose — the only door through which a ciphertext of the account leaves its own ACL identity
/// @notice Every public decryption and every permission for an address other than the account goes through one of these
///         helpers (test/DisclosureScan.test.ts fails on a direct FHE.makePubliclyDecryptable / FHE.allow /
///         FHE.allowTransient anywhere else in contracts/account or contracts/private). Each helper takes one value type for
///         one purpose and checks the handle's type byte; the euint64 helpers also refuse the PIN fingerprints, so pinH and
///         duressH can never become decryptable or usable by anyone (I3).
library Disclose {
    uint8 private constant T_BOOL = 0; // FheType.Bool
    uint8 private constant T_U64 = 5; // FheType.Uint64

    /// @notice A yes/no result anyone may decrypt: okAny of a PIN guess, its delay class, a K-only evaluation.
    function publicBool(ebool b) internal {
        _type(ebool.unwrap(b), T_BOOL);
        FHE.makePubliclyDecryptable(b);
    }

    /// @notice A flag only the guardian may decrypt (the duress flag of a guess, a public asset's tripwire). No guardian: no
    ///         permission at all.
    function guardianBool(S.Layout storage l, ebool b) internal {
        _type(ebool.unwrap(b), T_BOOL);
        if (l.guardian != address(0)) FHE.allow(b, l.guardian);
    }

    /// @notice A private token's K-only counter for the guardian (what moved, and the tripwire).
    function guardianU64(S.Layout storage l, euint64 v) internal {
        _u64(l, v);
        if (l.guardian != address(0)) FHE.allow(v, l.guardian);
    }

    /// @notice A PIN-gated balance snapshot for the owner key.
    function ownerU64(S.Layout storage l, euint64 v) internal {
        _u64(l, v);
        FHE.allow(v, l.owner);
    }

    /// @notice An amount an ERC-7984 token may use within this transaction (the account's own transfer).
    function tokenTransient(S.Layout storage l, euint64 v, address token) internal {
        _u64(l, v);
        FHE.allowTransient(v, token);
    }

    function _u64(S.Layout storage l, euint64 v) private view {
        bytes32 h = euint64.unwrap(v);
        _type(h, T_U64);
        if (h == euint64.unwrap(l.pinH) || h == euint64.unwrap(l.duressH)) revert Errors.NotDisclosable();
    }

    /// @dev Byte 30 of a handle is its FHE type (FHEVMExecutor._typeOf); an uninitialised handle is never disclosed.
    function _type(bytes32 h, uint8 t) private pure {
        if (h == bytes32(0) || uint8(uint256(h) >> 8) != t) revert Errors.NotDisclosable();
    }
}
