// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract USDC is ERC20, Ownable {
    uint8 private _decimals = 18;
    uint256 public constant MINT_AMOUNT = 200 * 10**18; // 200 USDC
    uint256 public constant MINT_COOLDOWN = 24 hours;
    
    mapping(address => uint256) public lastMintTime;

    constructor() ERC20("USD Coin", "USDC") Ownable(msg.sender) {
        // Mint 20% (200,000 USDC) to deployer
        uint256 deployerAmount = 200000 * 10**18;
        _mint(msg.sender, deployerAmount);
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    function mint() public {
        require(
            block.timestamp >= lastMintTime[msg.sender] + MINT_COOLDOWN,
            "USDC: Cooldown not expired"
        );
        
        lastMintTime[msg.sender] = block.timestamp;
        _mint(msg.sender, MINT_AMOUNT);
    }

    function ownerMint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function burn(uint256 amount) public {
        _burn(msg.sender, amount);
    }

    // Check when user can mint again
    function timeUntilNextMint(address user) public view returns (uint256) {
        uint256 lastMint = lastMintTime[user];
        if (lastMint == 0) return 0;
        
        uint256 nextMintTime = lastMint + MINT_COOLDOWN;
        if (block.timestamp >= nextMintTime) return 0;
        
        return nextMintTime - block.timestamp;
    }
}