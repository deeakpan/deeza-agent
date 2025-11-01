// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ZAZZ Token
 * @notice Mock ERC20 token for Deeza testnet - used as default token for all ERC20 gift requests
 */
contract ZAZZ is ERC20, Ownable {
    uint256 public constant INITIAL_SUPPLY = 100_000_000 * 10**18; // 100 million tokens

    constructor(address initialOwner) ERC20("ZAZZ Token", "ZAZZ") Ownable(initialOwner) {
        _mint(msg.sender, INITIAL_SUPPLY);
    }

    /**
     * @notice Mint tokens to an address (only owner, for bot to distribute test tokens)
     * @param to Address to mint to
     * @param amount Amount to mint (in wei, 18 decimals)
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /**
     * @notice Mint tokens to multiple addresses at once
     * @param recipients Array of addresses to mint to
     * @param amount Amount per recipient (in wei, 18 decimals)
     */
    function mintBatch(address[] calldata recipients, uint256 amount) external onlyOwner {
        for (uint256 i = 0; i < recipients.length; i++) {
            _mint(recipients[i], amount);
        }
    }

    /**
     * @notice Burn tokens from an address
     * @param from Address to burn from
     * @param amount Amount to burn (in wei)
     */
    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}
