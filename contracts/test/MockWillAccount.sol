// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockWillAccount — MOCK, local chain only
/// @notice Stands in for an Encrypted Account in the will's unit tests: a settable `lastPinAt` (what a correct PIN
///         writes on a real account), a settable PIN pulse and escape state, and a pass-through call, so the will sees
///         this contract as its account. The real account path (openCall → PIN → delay → executeOp, startEscape) is
///         tested separately against EncryptedAccount.
contract MockWillAccount {
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

    uint64 public lastPin;
    uint32 public pulse;
    address public escapeAddress;
    address public escapeTo;
    uint64 public escapeReadyAt;
    uint32 public escapeDelay = 30 days;

    constructor(address escape_) {
        require(block.chainid == 31337, "MOCK: local chain only");
        escapeAddress = escape_;
    }

    function setLastPinAt(uint64 t) external {
        lastPin = t;
    }

    /// @notice What a correct PIN does to the real account's `lastPinAt`.
    function pinNow() external {
        lastPin = uint64(block.timestamp);
    }

    function setPulse(uint32 p) external {
        pulse = p;
    }

    function setEscapeAddress(address a) external {
        escapeAddress = a;
    }

    /// @notice What `startEscape` does: snapshot the escape address and set the ready time.
    function startEscape() external {
        escapeTo = escapeAddress;
        escapeReadyAt = uint64(block.timestamp) + escapeDelay;
    }

    /// @notice What a lane cancellation does.
    function cancelEscape() external {
        escapeTo = address(0);
        escapeReadyAt = 0;
    }

    function status() external view returns (bool, uint8, uint32, uint64, uint32, uint64, bool, bool) {
        return (true, 0, 0, lastPin, pulse, escapeReadyAt, false, false);
    }

    function escapeState() external view returns (address, address, uint64, uint64, uint32, uint32, uint32) {
        return (escapeAddress, escapeTo, escapeReadyAt, 0, 0, 0, 0);
    }

    function delays() external view returns (Delays memory d) {
        d.escape = escapeDelay;
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
