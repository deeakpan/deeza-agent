// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Shop
 * @notice A simple shop contract where users can buy different items
 */
contract Shop {
    enum ItemType { Apple, Banana, Orange }
    
    struct Item {
        string name;
        uint256 price;
        uint256 amount;
    }
    
    mapping(ItemType => Item) public items;
    
    mapping(address => mapping(ItemType => uint256)) public userPurchases;
    
    event ItemPurchased(address indexed buyer, ItemType itemType, uint256 quantity, uint256 totalCost);

    constructor() {
        items[ItemType.Apple] = Item("Apple", 0.05 ether, 100);
        items[ItemType.Banana] = Item("Banana", 0.03 ether, 200);
        items[ItemType.Orange] = Item("Orange", 0.08 ether, 50);
    }

    /**
     * @notice Buy items from the shop
     * @param itemType The type of item to buy (0=Apple, 1=Banana, 2=Orange)
     * @param quantity The number of items to buy
     */
    function buy(ItemType itemType, uint256 quantity) public payable {
        require(quantity > 0, "Quantity must be greater than 0");
        require(items[itemType].amount >= quantity, "Not enough items in stock");
        require(msg.value >= items[itemType].price * quantity, "Insufficient payment");
        
        items[itemType].amount -= quantity;
        userPurchases[msg.sender][itemType] += quantity;
        
        emit ItemPurchased(msg.sender, itemType, quantity, msg.value);
    }

    /**
     * @notice Get item details
     */
    function getItem(ItemType itemType) public view returns (string memory name, uint256 price, uint256 amount) {
        Item memory item = items[itemType];
        return (item.name, item.price, item.amount);
    }

    /**
     * @notice Restock items (increases available amount)
     */
    function restock(ItemType itemType, uint256 amount) public {
        items[itemType].amount += amount;
    }

    /**
     * @notice Withdraw funds from the shop
     */
    function withdraw() public {
        payable(msg.sender).transfer(address(this).balance);
    }

    /**
     * @notice Get your purchase count for a specific item
     */
    function getMyPurchases(ItemType itemType) public view returns (uint256) {
        return userPurchases[msg.sender][itemType];
    }
}
