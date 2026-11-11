// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockWillAccount — MOCK, local chain only
/// @notice Stands in for an Encrypted Account in the will's unit tests: a settable `lastPinAt` (what a correct PIN
///         writes on a real account) and a pass-through call, so the will sees this contract as its account. The real
///         account path (openCall → PIN → delay → executeOp) is tested separately against EncryptedAccount.
contract MockWillAccount {
    uint64 public lastPin;

    constructor() {
        require(block.chainid == 31337, "MOCK: local chain only");
    }

    function setLastPinAt(uint64 t) external {
        lastPin = t;
    }

    /// @notice What a correct PIN does to the real account's `lastPinAt`.
    function pinNow() external {
        lastPin = uint64(block.timestamp);
    }

    function status() external view returns (bool, uint8, uint32, uint64, uint32, uint64, bool, bool) {
        return (true, 0, 0, lastPin, 0, 0, false, false);
    }

    function exec(address target, bytes calldata data) external returns (bytes memory r) {
        bool ok;
        (ok, r) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
    }
}
