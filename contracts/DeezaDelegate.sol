// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title DeezaDelegate
 * @notice Premium upgrade contract - pay STT to become premium
 */
contract DeezaDelegate {
    address public owner;
    uint256 public upgradePrice;
    
    mapping(address => bool) public isPremium;
    
    event Upgraded(address indexed user, uint256 amount);
    
    constructor() {
        owner = msg.sender;
        upgradePrice = 5 ether; // 5 STT by default
    }
    
    /**
     * @notice Upgrade to premium by sending STT
     */
    function upgrade() public payable {
        require(msg.value >= upgradePrice, "Insufficient STT sent");
        
        // Mark user as premium
        isPremium[msg.sender] = true;
        
        // Forward funds to owner
        (bool success, ) = owner.call{value: address(this).balance}("");
        require(success, "Transfer failed");
        
        emit Upgraded(msg.sender, msg.value);
    }
    
    /**
     * @notice Set the upgrade price (only owner)
     * @param _price New upgrade price in wei
     */
    function setUpgradePrice(uint256 _price) public {
        require(msg.sender == owner, "Only owner");
        require(_price > 0, "Price must be greater than 0");
        upgradePrice = _price;
    }
    
    /**
     * @notice Add premium users (only owner)
     * @param _users Array of user addresses to add as premium
     */
    function addPremium(address[] memory _users) public {
        require(msg.sender == owner, "Only owner");
        for (uint i = 0; i < _users.length; i++) {
            isPremium[_users[i]] = true;
        }
    }
    
    /**
     * @notice Remove premium users (only owner)
     * @param _users Array of user addresses to remove from premium
     */
    function removePremium(address[] memory _users) public {
        require(msg.sender == owner, "Only owner");
        for (uint i = 0; i < _users.length; i++) {
            isPremium[_users[i]] = false;
        }
    }
    
    /**
     * @notice Check if an address is premium
     * @param _user Address to check
     * @return bool True if premium, false otherwise
     */
    function checkPremium(address _user) public view returns (bool) {
        return isPremium[_user];
    }
}

