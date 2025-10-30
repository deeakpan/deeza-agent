// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title DeezaBridge
 * @notice Test bridge that accepts USDC and STT, forwards to owner
 */
contract DeezaBridge {
    address public owner;
    address public constant USDC_ADDRESS = 0x3EEbd3c3F5Bf02923E14c6288C7d241C77D83ef7;
    
    event STTReceived(address indexed sender, uint256 amount);
    event USDCReceived(address indexed sender, uint256 amount);
    event FundsForwarded(address indexed to, uint256 sttAmount, uint256 usdcAmount);
    
    constructor() {
        owner = msg.sender;
    }
    
    /**
     * @notice Bridge USDC tokens (forwards to owner)
     * @param amount Amount of USDC to bridge
     */
    function bridgeUSDC(uint256 amount) public {
        require(amount > 0, "Amount must be greater than 0");
        
        IERC20 usdc = IERC20(USDC_ADDRESS);
        
        // Transfer USDC from user to this contract
        require(usdc.transferFrom(msg.sender, address(this), amount), "USDC transfer failed");
        
        emit USDCReceived(msg.sender, amount);
        
        // Forward USDC to owner
        require(usdc.transfer(owner, amount), "USDC forward failed");
    }
    
    /**
     * @notice Bridge STT (native token) - forwards to owner
     */
    function bridgeSTT() public payable {
        require(msg.value > 0, "Must send some STT");
        
        emit STTReceived(msg.sender, msg.value);
        
        // Forward STT to owner
        (bool success, ) = payable(owner).call{value: address(this).balance}("");
        require(success, "STT forward failed");
    }
    
    /**
     * @notice Receive STT directly (fallback)
     */
    receive() external payable {
        require(msg.value > 0, "Must send some STT");
        emit STTReceived(msg.sender, msg.value);
    }
    
    /**
     * @notice Withdraw any STT that might be stuck
     */
    function withdrawSTT() public {
        require(msg.sender == owner, "Only owner");
        (bool success, ) = payable(owner).call{value: address(this).balance}("");
        require(success, "Withdraw failed");
    }
    
    /**
     * @notice Withdraw any USDC that might be stuck
     */
    function withdrawUSDC() public {
        require(msg.sender == owner, "Only owner");
        IERC20 usdc = IERC20(USDC_ADDRESS);
        uint256 balance = usdc.balanceOf(address(this));
        if (balance > 0) {
            require(usdc.transfer(owner, balance), "Withdraw USDC failed");
        }
    }
    
    /**
     * @notice Get contract balances
     */
    function getBalances() public view returns (uint256 sttBalance, uint256 usdcBalance) {
        sttBalance = address(this).balance;
        IERC20 usdc = IERC20(USDC_ADDRESS);
        usdcBalance = usdc.balanceOf(address(this));
    }
}

