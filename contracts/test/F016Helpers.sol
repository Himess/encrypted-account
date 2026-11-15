// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {externalEuint64} from "@fhevm/solidity/lib/FHE.sol";

interface IBondedAccount {
    function submitRecoveryGuess(uint256 opId, uint64 c, externalEuint64 guess, bytes calldata proof) external payable;

    function claimRefund() external;
}

/// @notice F0.16 test: a bond payer (recovery-track relayer) that tries to re-enter claimRefund when paid.
contract ReentrantRelayer {
    IBondedAccount public acct;
    bool public reentered;
    bool public reentryBlocked;
    uint256 public received;

    constructor(IBondedAccount a) {
        acct = a;
    }

    function guess(uint256 opId, uint64 c, externalEuint64 h, bytes calldata proof) external payable {
        acct.submitRecoveryGuess{value: msg.value}(opId, c, h, proof);
    }

    function claim() external {
        acct.claimRefund();
    }

    receive() external payable {
        received += msg.value;
        if (!reentered) {
            reentered = true;
            try acct.claimRefund() {} catch {
                reentryBlocked = true;
            }
        }
    }
}

/// @notice F0.16 test: a fee configuration that always reverts (the account must keep working).
contract RevertingFeeConfig {
    function quote(address, uint256) external pure returns (uint256, uint64) {
        revert("down");
    }

    function feeRecipient() external pure returns (address) {
        revert("down");
    }
}

/// @notice F0.16 test: a fee recipient that rejects ETH (a verified transfer must still complete).
contract RejectingReceiver {
    receive() external payable {
        revert("no");
    }
}
