// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract DeezaAgent is Ownable {
    address public bot;
    uint256 public defaultLockTime = 30 minutes;

    struct Gift {
        address gifter;         // Set when user deposits
        address recipient;      // Set by bot when creating
        address token;          // Set by bot when creating
        uint256 amount;         // Set by bot when creating
        string code;
        string ipfsLink;
        address claimer;
        uint256 claimDeadline;
        uint8 attempts;
        bool deposited;
        bool claimed;
    }

    mapping(bytes32 => Gift) public gifts;

    event GiftCreated(bytes32 indexed id, address recipient, address token, uint256 amount, string code);
    event GiftDeposited(bytes32 indexed id, address gifter);
    event GiftClaimed(bytes32 indexed id, address claimer, uint256 amount, address token);
    event ClaimTimeExtended(bytes32 indexed id, uint256 newDeadline);

    modifier onlyBot() {
        require(msg.sender == bot, "Only bot");
        _;
    }

    constructor(address _bot) Ownable(msg.sender) {
        bot = _bot;
    }

    function setBot(address _bot) external onlyOwner {
        bot = _bot;
    }

    // Bot creates gift WITH recipient, token and amount
    function createGift(
        bytes32 id,
        string calldata code,
        string calldata ipfsLink,
        address recipient,
        address token,
        uint256 amount
    ) external onlyBot {
        require(gifts[id].amount == 0, "Gift exists");
        require(amount > 0, "Amount must be > 0");
        require(recipient != address(0), "Invalid recipient");
        
        gifts[id] = Gift({
            gifter: address(0),     // Will be set when user deposits
            recipient: recipient,   // Set now by bot
            token: token,           // Set now by bot
            amount: amount,         // Set now by bot
            code: code,
            ipfsLink: ipfsLink,
            claimer: address(0),
            claimDeadline: 0,
            attempts: 0,
            deposited: false,
            claimed: false
        });

        emit GiftCreated(id, recipient, token, amount, code);
    }

    // User deposits the exact amount specified in the gift
    function depositGift(bytes32 id) external payable {
        Gift storage g = gifts[id];
        require(g.amount > 0, "Gift not created");
        require(!g.deposited, "Already deposited");

        if (g.token == address(0)) {
            // Native token (STT/SOMI)
            require(msg.value == g.amount, "Wrong amount");
        } else {
            // ERC20 token
            require(msg.value == 0, "No ETH for ERC20");
            IERC20(g.token).transferFrom(msg.sender, address(this), g.amount);
        }

        g.gifter = msg.sender;
        g.deposited = true;
        g.claimDeadline = block.timestamp + defaultLockTime;

        emit GiftDeposited(id, msg.sender);
    }

    // Bot releases to the recipient stored in the gift
    function release(bytes32 id) external onlyBot {
        Gift storage g = gifts[id];
        require(g.deposited && !g.claimed, "Invalid state");
        require(block.timestamp <= g.claimDeadline, "Expired");
        require(g.recipient != address(0), "No recipient");

        g.claimed = true;
        g.claimer = g.recipient;

        if (g.token == address(0)) {
            payable(g.recipient).transfer(g.amount);
        } else {
            IERC20(g.token).transfer(g.recipient, g.amount);
        }

        emit GiftClaimed(id, g.recipient, g.amount, g.token);
    }

    // Bot extends on 3 wrong answers
    function extendClaimTime(bytes32 id, uint256 minutesToAdd) external onlyBot {
        Gift storage g = gifts[id];
        require(g.deposited && !g.claimed, "Invalid state");
        g.claimDeadline = block.timestamp + (minutesToAdd * 1 minutes);
        g.attempts = 0;
        emit ClaimTimeExtended(id, g.claimDeadline);
    }

    // Get gift info
    function getGift(bytes32 id) external view returns (Gift memory) {
        return gifts[id];
    }

    // Emergency withdraw (owner only)
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            payable(owner()).transfer(amount);
        } else {
            IERC20(token).transfer(owner(), amount);
        }
    }
}
