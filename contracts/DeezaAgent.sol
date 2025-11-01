// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract DeezaAgent is Ownable {
    address public bot;
    uint256 public defaultLockTime = 30 minutes;

    struct Gift {
        address gifter;
        address token;          // 0x0 = SOMI (native), else ERC-20
        uint256 amount;
        string code;
        string ipfsLink;        // Q&A stored on Lighthouse
        address claimer;
        uint256 claimDeadline;
        uint8 attempts;
        bool deposited;
        bool claimed;
    }

    mapping(bytes32 => Gift) public gifts;
    mapping(address => bytes32[]) public pendingGifts;
    mapping(address => bytes32[]) public activeGifts;
    mapping(address => bytes32[]) public claimedGifts;

    event GiftCreated(bytes32 indexed id, address gifter, string code);
    event GiftDeposited(bytes32 indexed id);
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

    // Create gift (called by bot after AI processing)
    function createGift(
        bytes32 id,
        string calldata code,
        string calldata ipfsLink
    ) external onlyBot {
        require(gifts[id].gifter == address(0), "Gift exists");
        
        gifts[id] = Gift({
            gifter: address(0),
            token: address(0),
            amount: 0,
            code: code,
            ipfsLink: ipfsLink,
            claimer: address(0),
            claimDeadline: 0,
            attempts: 0,
            deposited: false,
            claimed: false
        });

        emit GiftCreated(id, address(0), code);
    }

    // Called by gifter after wallet connect
    function depositGift(
        bytes32 id,
        address token,
        uint256 amount
    ) external payable {
        Gift storage g = gifts[id];
        require(g.gifter == address(0) || !g.deposited, "Already deposited");
        require(bytes(g.code).length > 0, "Gift not created");

        if (token == address(0)) {
            require(msg.value == amount, "Wrong SOMI amount");
        } else {
            IERC20(token).transferFrom(msg.sender, address(this), amount);
        }

        // If first deposit, set gifter
        if (g.gifter == address(0)) {
            g.gifter = msg.sender;
            pendingGifts[msg.sender].push(id);
        }

        g.token = token;
        g.amount = amount;
        g.deposited = true;
        g.claimDeadline = block.timestamp + defaultLockTime;

        _removeFromArray(pendingGifts[msg.sender], id);
        if (!_existsInArray(activeGifts[msg.sender], id)) {
            activeGifts[msg.sender].push(id);
        }

        emit GiftDeposited(id);
    }

    // Bot pays after AI approves
    function release(bytes32 id, address to) external onlyBot {
        Gift storage g = gifts[id];
        require(g.deposited && !g.claimed, "Invalid state");
        require(block.timestamp <= g.claimDeadline, "Expired");

        g.claimed = true;
        g.claimer = to;

        if (!_existsInArray(claimedGifts[to], id)) {
            claimedGifts[to].push(id);
        }

        if (g.token == address(0)) {
            payable(to).transfer(g.amount);
        } else {
            IERC20(g.token).transfer(to, g.amount);
        }

        emit GiftClaimed(id, to, g.amount, g.token);
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

    // Get user's gifts
    function getPendingGifts(address user) external view returns (bytes32[] memory) {
        return pendingGifts[user];
    }

    function getActiveGifts(address user) external view returns (bytes32[] memory) {
        return activeGifts[user];
    }

    function getClaimedGifts(address user) external view returns (bytes32[] memory) {
        return claimedGifts[user];
    }

    function _removeFromArray(bytes32[] storage arr, bytes32 id) internal {
        for (uint i = 0; i < arr.length; i++) {
            if (arr[i] == id) {
                arr[i] = arr[arr.length - 1];
                arr.pop();
                break;
            }
        }
    }

    function _existsInArray(bytes32[] storage arr, bytes32 id) internal view returns (bool) {
        for (uint i = 0; i < arr.length; i++) {
            if (arr[i] == id) {
                return true;
            }
        }
        return false;
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
