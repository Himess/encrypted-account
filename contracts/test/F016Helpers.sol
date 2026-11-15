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

/// @notice F0.16 test: an ERC-20 whose transferFrom needs no allowance when `from == msg.sender` (as DAI and WETH9 do).
///         Through a generic call it would move the account's tokens around the parsed outflow path (no limit, no fee).
contract SelfPullToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return transferFrom(msg.sender, to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        if (from != msg.sender) allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
