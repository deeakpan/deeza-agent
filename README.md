# DeezaBot v2 - Universal Smart Contract AI Agent

## 🚀 New Features

### 1. **USD-Based Token Sends**
```
User: "send $5 of STT to @alice"
Bot: [Calculates: $5 / $0.023 = ~217 STT]
     [Checks balance: 500 STT ✓]
     [Checks @alice exists ✓]
     Sending $5 worth of STT (~217 STT) to @alice...
```

### 2. **Conversation Context (Follow-Ups)**
```
User: "send @david STT"
Bot: "How much STT would you like to send to @david?"
     [Saves context for 5 minutes]

User: "6"
Bot: [Remembers previous conversation]
     "Sending 6 STT to @david..."
```

### 3. **Dynamic Contract Registry**
Add ANY contract to Supabase and users can interact with it!

```sql
-- Add NFT Marketplace
INSERT INTO contracts VALUES ('0x123...', 'NFTMarket', 'NFT Marketplace');
INSERT INTO contract_functions VALUES (
  'buy',
  'buy(uint256,uint256)',
  'tokenId', 'uint256', 'NFT ID to buy',
  'quantity', 'uint256', 'How many to buy'
);
```

```
User: "buy from NFTMarket"
Bot: "To buy from NFTMarket, I need: tokenId (NFT ID) and quantity. 
     Example: buy 1, 2"

User: "buy 1, 2"
Bot: "Buying NFT #1 (quantity: 2) from NFTMarket..."
     [Executes: NFTMarket.buy(1, 2)]
```

### 4. **Token Existence Validation**
```
User: "check balance of 0xFakeToken..."
Bot: [Tries to load contract]
     "That token doesn't exist on Shannon Testnet! 
     Want to check a different address?"
```

## 📊 Architecture

### Database Schema

```
deeza_users
├── telegram_id
├── wallet_address
├── encrypted_private_key
└── tier

contracts
├── contract_address
├── contract_name (e.g., "NFTMarket")
├── description
└── is_active

contract_functions
├── contract_id (FK)
├── function_name (e.g., "buy")
├── function_signature (e.g., "buy(uint256,uint256)")
├── param1_name, param1_type, param1_description
├── param2_name, param2_type, param2_description
├── param3_name, param3_type, param3_description
├── param4_name, param4_type, param4_description
├── is_payable
└── requires_approval

conversation_context
├── telegram_id
├── context_type ("pending_action", "send_token", etc.)
├── context_data (JSON)
└── expires_at (5 minutes)
```

## 🎯 How It Works

### USD Conversion Flow
```
1. User: "send $10 of STT to @alice"
2. Bot fetches STT price: $0.023
3. Bot calculates: $10 / $0.023 = 434.78 STT
4. Bot checks user balance: 500 STT ✓
5. Bot checks @alice exists: ✓
6. Bot executes: wallet.sendTransaction(434.78 STT)
7. Bot confirms: "Sent! $10 worth of STT (~434.78 STT) → @alice"
```

### Follow-Up Flow
```
1. User: "send @david STT"
2. Bot: Missing amount!
3. Bot saves context:
   {
     "action": "send_token",
     "token_symbol": "STT",
     "recipient": "david"
   }
4. Bot asks: "How much STT?"
5. User: "6"
6. Bot loads context
7. Bot completes: send 6 STT to @david
8. Bot clears context
```

### Contract Registry Flow
```
1. User: "buy from NFTMarket"
2. Bot queries Supabase:
   SELECT * FROM contracts WHERE contract_name = 'NFTMarket'
3. Bot finds contract + functions
4. Bot sees buy() needs: tokenId, quantity
5. Bot responds: "To buy, I need tokenId and quantity"
6. User: "buy 1, 2"
7. Bot parses params: [1, 2]
8. Bot executes: NFTMarket.buy(1, 2)
```

## 🔧 Setup

### 1. Run SQL Setup
```bash
# Run in Supabase SQL Editor
cat supabase-contracts-setup.sql
```

### 2. Configure Environment
```env
TELEGRAM_TOKEN=your_bot_token
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key
OPENAI_API_KEY=your_openai_key
USDC_CONTRACT_ADDRESS=0x...
ENCRYPTION_KEY=your_32_char_key
```

### 3. Run Bot
```bash
node deezabot-v2.js
```

## 📝 Adding New Contracts

### Example: DEX Swap

```sql
-- Add DEX contract
INSERT INTO contracts (contract_address, contract_name, description) 
VALUES ('0xDEX123...', 'DEXSwap', 'Decentralized exchange for token swaps');

-- Add swap function
INSERT INTO contract_functions (
  contract_id,
  function_name,
  function_signature,
  description,
  param1_name, param1_type, param1_description,
  param2_name, param2_type, param2_description,
  param3_name, param3_type, param3_description,
  is_payable
) 
SELECT 
  id,
  'swap',
  'swap(address,address,uint256)',
  'Swap tokens on DEX',
  'tokenIn', 'address', 'Token to swap from',
  'tokenOut', 'address', 'Token to swap to',
  'amount', 'uint256', 'Amount to swap',
  false
FROM contracts WHERE contract_name = 'DEXSwap';
```

Now users can:
```
User: "swap on DEXSwap"
Bot: "To swap on DEXSwap, I need:
     • tokenIn (Token to swap from)
     • tokenOut (Token to swap to)  
     • amount (Amount to swap)
     
     Example: swap 0xSTT..., 0xUSDC..., 100"

User: "swap 0xSTT..., 0xUSDC..., 100"
Bot: "Swapping on DEXSwap..."
     [Executes: DEXSwap.swap(0xSTT..., 0xUSDC..., 100)]
```

## 💡 Example Conversations

### USD Send
```
User: send $20 of USDC to @bob
Bot: Sending $20 worth of USDC (20 USDC) to @bob...
     Sent! 20 USDC → @bob
```

### Follow-Up
```
User: transfer STT to @alice
Bot: How much STT would you like to send to @alice?

User: 50
Bot: Sending 50 STT to @alice...
     Sent! 50 STT → @alice
```

### Multi-Step Contract
```
User: I want to buy an NFT
Bot: Which marketplace? Available: NFTMarket, OpenSeaClone

User: NFTMarket
Bot: To buy from NFTMarket, I need tokenId and quantity

User: buy 5, 1
Bot: Buying NFT #5 (quantity: 1) from NFTMarket...
     buy executed on NFTMarket!
```

### Token Validation
```
User: check balance of 0xFakeToken123
Bot: That token doesn't exist on Shannon Testnet!
     Want to check a different address?

User: yes, check 0xUSDC...
Bot: USD Coin (USDC)
     Balance: 200.00 USDC
```

## 🔒 Security Features

✅ Private keys encrypted with AES-256
✅ Context expires after 5 minutes
✅ User validation before sends
✅ Balance checks before transactions
✅ Token existence validation
✅ Gas balance verification
✅ Contract registry prevents arbitrary calls

## 🚀 Advanced Features

### Coming Soon
- Multi-token swaps
- NFT minting/burning
- DAO voting
- Staking/unstaking
- Liquidity provision
- Cross-chain bridging

### Extensibility
The contract registry makes it easy to add ANY smart contract interaction without changing bot code!

## 📚 API Reference

### Context Management
```javascript
await saveContext(tgId, 'pending_action', {
  action: 'send_token',
  token_symbol: 'STT',
  recipient: 'alice'
});

const context = await getContext(tgId);
await clearContext(tgId);
```

### USD Conversion
```javascript
const tokenAmount = await convertUSDToToken(10, 'STT');
// Returns: 434.78 (for STT at $0.023)
```

### Contract Calls
```javascript
const contract = await getContractByName('NFTMarket');
// Returns: { contract_address, functions: [...] }
```

## 🎯 Next Steps

1. Add more contracts to registry
2. Implement token approvals
3. Add multi-sig support
4. Create admin panel for contract management
5. Add transaction history tracking

---

**Now you have a universal AI agent that can interact with ANY smart contract!** 🚀