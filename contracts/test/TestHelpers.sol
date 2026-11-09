// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
// Pull the canonical v0.8 EntryPoint into the compilation so tests can deploy it.
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Sponsors every UserOp (test only) — stands in for the product's own paymaster.
contract TestPaymaster is IPaymaster {
    IEntryPoint public immutable entryPoint;

    constructor(IEntryPoint ep) {
        entryPoint = ep;
    }

    function validatePaymasterUserOp(
        PackedUserOperation calldata,
        bytes32,
        uint256
    ) external view returns (bytes memory context, uint256 validationData) {
        require(msg.sender == address(entryPoint), "only EP");
        return ("", 0);
    }

    function postOp(PostOpMode, bytes calldata, uint256, uint256) external view {
        require(msg.sender == address(entryPoint), "only EP");
    }

    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }
}

/// @notice Minimal ERC-1271 contract wallet (test only): a signature is valid if its EOA owner signed the hash.
///         Used as a contract-wallet escape address (K55: E_addr consents via ERC-1271).
contract MockERC1271Wallet {
    address public immutable owner;

    constructor(address o) {
        owner = o;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (address rec, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, sig);
        return err == ECDSA.RecoverError.NoError && rec == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    receive() external payable {}
}

/// @notice A target that records calls (generic-call path tests).
contract CallTarget {
    uint256 public value;
    address public lastCaller;

    function setValue(uint256 v) external payable {
        value = v;
        lastCaller = msg.sender;
    }
}
