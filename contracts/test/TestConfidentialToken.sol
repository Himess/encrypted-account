// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "../vendor/openzeppelin-confidential/token/ERC7984/ERC7984.sol";

/// @title TestConfidentialToken — TEST TOKEN, worthless: OpenZeppelin's ERC-7984 with a public mint
/// @notice For the tests and the Sepolia demo of the will. Anyone may mint; the minted amount is public, transfers and
///         balances are encrypted as in any ERC-7984 token.
contract TestConfidentialToken is ERC7984 {
    uint64 public constant MAX_MINT = 1_000_000 * 1e6;

    error MintTooLarge();

    constructor() ERC7984("Test Confidential USD", "tcUSD", "") {
        FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig());
    }

    function mint(address to, uint64 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge();
        _mint(to, FHE.asEuint64(amount));
    }
}
