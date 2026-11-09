// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64, ebool, eaddress, externalEuint64, externalEaddress} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice DELIBERATELY VULNERABLE — demonstrates why every PIN guess must carry a non-empty input proof.
/// @dev Follows the v0.3 document literally: one-time handle + per-op challenge (13.3), plus two very common
///      smart-account patterns: (a) a generic self-call `execute`, (b) precomputing Enc(pinH + c) at op opening.
///      Since fhevm-solidity 0.11, `FHE.fromExternal(h, "")` returns `h` if the *caller* is allowed to use it.
///      In a self-call the caller is the contract itself, which is allowed on everything it computed.
contract NaivePinVerifier is ZamaEthereumConfig {
    euint64 public pinH;
    mapping(uint256 => euint64) public expected; // Enc(pinH + c_op)
    mapping(bytes32 => bool) public usedInput;
    ebool public lastOk;

    function setPin(externalEuint64 fp, bytes calldata proof) external {
        pinH = FHE.fromExternal(fp, proof);
        FHE.allowThis(pinH);
    }

    function openOp(uint256 opId, uint64 challenge) external {
        euint64 e = FHE.add(pinH, challenge);
        FHE.allowThis(e);
        expected[opId] = e;
    }

    /// Variant A: compares against the precomputed Enc(pinH + c).
    function submitGuess(uint256 opId, externalEuint64 guess, bytes calldata proof) external {
        bytes32 h = externalEuint64.unwrap(guess);
        require(!usedInput[h], "replay");
        usedInput[h] = true;
        euint64 g = FHE.fromExternal(guess, proof); // <-- no proof.length check
        ebool ok = FHE.eq(expected[opId], g);
        FHE.makePubliclyDecryptable(ok);
        lastOk = ok;
    }

    /// Variant B: no challenge at all, eq(pinH, guess).
    function submitGuessNoChallenge(externalEuint64 guess, bytes calldata proof) external {
        euint64 g = FHE.fromExternal(guess, proof);
        ebool ok = FHE.eq(pinH, g);
        FHE.makePubliclyDecryptable(ok);
        lastOk = ok;
    }

    /// Generic "execute" as found in most smart accounts (here unauthenticated for brevity; in a real account
    /// it would be gated by the owner key K — which is exactly what the thief has).
    function execute(address target, bytes calldata data) external {
        (bool s, bytes memory r) = target.call(data);
        if (!s) {
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
    }

    // ── known-list padding: the naive way ──
    eaddress[] public list;

    function padNaive(uint256 n) external {
        for (uint256 i = 0; i < n; i++) {
            eaddress z = FHE.asEaddress(address(0)); // emits TrivialEncrypt(pt = 0) → observers count padding
            FHE.allowThis(z);
            list.push(z);
        }
    }

    function pushClient(externalEaddress a, bytes calldata proof) external {
        eaddress v = FHE.fromExternal(a, proof);
        FHE.allowThis(v);
        list.push(v);
    }
}
