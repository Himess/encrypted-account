// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint64} from "@fhevm/solidity/lib/FHE.sol";

/// @title PrivateStorage — namespaced (ERC-7201) storage of the optional private mode
/// @notice Lives next to AccountStorage in an EncryptedAccountP account (PrivateModule runs through DELEGATECALL). A private
///         token's limits, tripwire and counters live here only: the public asset tables (AccountStorage.assets /
///         assetEnc) never hold a private token, so the public outflow paths cannot evaluate it, trip it or reveal anything
///         about its hidden threshold.
library PrivateStorage {
    /// @dev `spent` saturates to this value when a K-only transfer does not fit under tau: the tripwire. It stays set
    ///      across day boundaries until a PIN-verified reset; a tripped `spent` leaves no room for any amount above zero.
    uint64 internal constant TRIPPED = type(uint64).max;
    /// @dev Upper bound of L_min / L after setup and tightening, so that tau (≤ L_min + 2^48) never reaches TRIPPED, and of
    ///      the hidden amount, so that a K-only amount within tau plus the hidden amount never overflows 64 bits.
    uint64 internal constant MAX_LIMIT = uint64(1) << 62;
    /// @dev Design doc §17.1: in a private-mode account every PIN-verified outflow of a private token waits at least this
    ///      long, and so does every public outflow in the long class (the account's bigTransfer delay). The rule is public
    ///      and the same with or without a duress PIN, so it does not reveal whether one is set.
    uint32 internal constant MIN_BIG_DELAY = 72 hours;

    struct Asset {
        bool configured;
        uint64 epoch; // day index of `spent`
        euint64 spent; // K-only private outflows in this epoch; TRIPPED = the tripwire fired
        euint64 lmin; // L_min (the owner knows it)
        euint64 l; // L (the owner knows it), upper end of tau's range
        euint64 tau; // hidden K-only threshold in [L_min, L), drawn with FHE randomness: nobody knows it
        // The part of the balance the duress PIN never shows or moves (0 without a duress PIN), at most MAX_LIMIT. The
        // duress PIN works on the rest as if it were the whole balance, and K alone never reaches it either.
        euint64 hidden;
        euint64 lastView; // latest PIN-gated balance snapshot, allowed to K
    }

    struct Layout {
        mapping(address => Asset) assets;
    }

    // keccak256(abi.encode(uint256(keccak256("encrypted-account.private.v0")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0xc131986234d5c67ed3b7e04a6087231bd421f417c521a8d05b4b1d830a7f4800;

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/// @notice The module's hooks that only EncryptedAccountP itself may reach (its fallback refuses these selectors).
interface IPrivateHooks {
    function privateAfterGuess(uint256 opId, bool ok, uint8 track) external;

    function privateExecuteOp(uint256 opId) external;
}
