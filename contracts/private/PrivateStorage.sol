// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";

/// @title PrivateStorage — SPIKE: namespaced (ERC-7201) storage of the private-mode module
/// @notice Lives next to AccountStorage in the account (the module runs through DELEGATECALL). The encrypted limits of a
///         confidential token (L_min, L, tau, L_big, tripped) stay in AccountStorage.assetEnc[token], written by the
///         account's own setupAsset(token, 1, ...); only what the private paths add is kept here.
library PrivateStorage {
    struct Asset {
        bool configured;
        uint64 epoch; // day index of `spent`
        euint64 spent; // K-only private outflows in this epoch (encrypted; invariant spent <= tau, guarded with max)
        euint64 decoyCap; // duress view and spend cap, client-encrypted (any value when no duress PIN is set)
        euint64 decoySpent; // what left the account under duress (encrypted)
        euint64 lastView; // latest PIN-gated balance snapshot, allowed to K
        ebool lastPass; // pass bit of the latest K-only private transfer (allowed to the guardian only)
        euint64 lastMoved; // amount the token really moved in that transfer (allowed to the guardian only)
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
