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

### 3. **Token Intelligence (Conversational)**
Ask natural questions about tokens and get direct answers:
```
User: "What's SOMI 24h volume?"
Bot: "SOMI has traded $145K in the last 24 hours."

User: "Compare SOMI and PEPE market cap"
Bot: "SOMI: $2.4M | PEPE: $1.8M — SOMI is ~33% larger."
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

### Token Query Flow
```
1. User: "SOMI price?"
2. Bot searches GeckoTerminal for SOMI on Somnia
3. Bot fetches pool market data (price, volume, liquidity)
4. Bot replies conversationally with the requested metric
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

## 🧠 Token Intelligence Setup
No contract registry. The bot uses GeckoTerminal + on-chain reads to answer token questions.

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



### Token Validation
```
User: check balance of 0xFakeToken123
Bot: That token doesn't exist on Somnia!
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


## 🚀 Advanced Features

### Coming Soon
- Multi-token swaps
- NFT minting/burning
- DAO voting
- Staking/unstaking
- Liquidity provision
- Cross-chain bridging



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



## 🎯 Next Steps

1. Improve token symbol resolution
2. Add chart screenshots for token queries
3. Add watchlists and alerts
4. Add recent transactions view
5. Support more timeframes and comparisons

---

**Now you have a universal AI agent that can interact with ANY smart contract!** 