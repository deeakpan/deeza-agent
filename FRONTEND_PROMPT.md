# Frontend Generation Prompt for Deeza Agent

## Design Requirements

Create a React/Next.js frontend using **Tailwind CSS** with the following specifications:

### Visual Style
- **Cartoonish/Meme Vibe**: The entire UI should have a playful, cartoonish aesthetic similar to emoji characters or LEGO minifigures
- **Thick Black Borders**: All elements (buttons, cards, inputs) must have **thick black borders** (border-width: 3-4px)
- **Bold, Graphic Look**: Simple, blocky shapes with strong outlines

### Color Palette (from logo)
- **Primary Background**: Vibrant blue (`#1E90FF` or similar - use `bg-blue-500` from Tailwind)
- **Accent Color 1**: Bright yellow for highlights (`#FFD700` or `bg-yellow-400`)
- **Accent Color 2**: Pure white for text (`#FFFFFF` or `text-white`)
- **Outline/Details**: Solid black for all borders (`#000000` or `border-black`)

### Typography
- **Font**: Bold, sans-serif (use `font-bold` in Tailwind)
- **Text**: All text should have thick black outlines (text-stroke or shadow for effect)
- **Size**: Large, readable text

---

## Pages Required

### 1. Home Page ("Coming Soon")
- **Route**: `/`
- **Display**: "COMING SOON" text prominently centered
- **Style**: 
  - Vibrant blue background
  - Large white text with black outline
  - Cartoonish/meme aesthetic
  - Thick black border around the page container

### 2. Deposit Page
- **Route**: `/deposit`
- **Features**:
  1. **Wallet Connection Button**
     - Connect wallet functionality (use ethers.js v6 + MetaMask/WalletConnect)
     - Display connected wallet address when connected
     - Style: Yellow button with thick black border, white text
  
  2. **Gift Code Input**
     - Text input field for gift code
     - Placeholder: "Enter gift code (e.g., john42)"
     - Style: White background, thick black border, black text
  
  3. **Deposit Information Display**
     - After entering code and connecting wallet, fetch gift details
     - Show: Token symbol, Amount, Token address
     - Style: Card with yellow/white background, thick black border
  
  4. **Deposit Button**
     - Call `depositGift(bytes32 id, address token, uint256 amount)` function
     - Handle native token (SOMI/STT) with `msg.value`
     - Handle ERC-20 tokens with `approve` + `depositGift`
     - Show transaction status (pending, success, error)
     - Style: Yellow button with thick black border

---

## Blockchain Integration

### Network Configuration

**Somnia Testnet:**
```javascript
const CHAIN_ID = 50312;
const RPC_URL = 'https://dream-rpc.somnia.network';
const NATIVE_TOKEN = 'STT';
const EXPLORER = 'https://shannon-explorer.somnia.network';
```

**Somnia Mainnet:**
```javascript
const CHAIN_ID = 50311;
const RPC_URL = 'https://somnia.publicnode.com';
const NATIVE_TOKEN = 'SOMI';
const EXPLORER = 'https://explorer.somnia.network';
```

### Contract Details

**Contract Address**: `0xC68AA8EE564a70F2Be313CEA039F062D8f818744`

**Contract ABI** (DeezaAgent.sol):
```json
[
  "function depositGift(bytes32 id, address token, uint256 amount) external payable",
  "function getGift(bytes32 id) external view returns (tuple(address gifter, address token, uint256 amount, string code, string ipfsLink, address claimer, uint256 claimDeadline, uint8 attempts, bool deposited, bool claimed))",
  "event GiftDeposited(bytes32 indexed id)",
  "event GiftCreated(bytes32 indexed id, address gifter, string code)"
]
```

**Full ABI** (for complete integration):
```json
[
  {
    "inputs": [
      {"internalType": "bytes32", "name": "id", "type": "bytes32"},
      {"internalType": "address", "name": "token", "type": "address"},
      {"internalType": "uint256", "name": "amount", "type": "uint256"}
    ],
    "name": "depositGift",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "bytes32", "name": "id", "type": "bytes32"}],
    "name": "getGift",
    "outputs": [
      {
        "components": [
          {"internalType": "address", "name": "gifter", "type": "address"},
          {"internalType": "address", "name": "token", "type": "address"},
          {"internalType": "uint256", "name": "amount", "type": "uint256"},
          {"internalType": "string", "name": "code", "type": "string"},
          {"internalType": "string", "name": "ipfsLink", "type": "string"},
          {"internalType": "address", "name": "claimer", "type": "address"},
          {"internalType": "uint256", "name": "claimDeadline", "type": "uint256"},
          {"internalType": "uint8", "name": "attempts", "type": "uint8"},
          {"internalType": "bool", "name": "deposited", "type": "bool"},
          {"internalType": "bool", "name": "claimed", "type": "bool"}
        ],
        "internalType": "struct DeezaAgent.Gift",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [{"indexed": true, "internalType": "bytes32", "name": "id", "type": "bytes32"}],
    "name": "GiftDeposited",
    "type": "event"
  }
]
```

### Key Functions

#### 1. Connect Wallet
- Use `ethers.BrowserProvider` for MetaMask/wallet connection
- Request network switch to Somnia (Chain ID: 50312 for testnet, 50311 for mainnet)
- Store connected address in state

#### 2. Get Gift ID from Code
```javascript
import { ethers } from 'ethers';
const giftId = ethers.id(giftCode); // Converts string code to bytes32
```

#### 3. Fetch Gift Details
```javascript
const gift = await contract.getGift(giftId);
// Returns: { gifter, token, amount, code, ipfsLink, claimer, claimDeadline, attempts, deposited, claimed }
```

#### 4. Deposit Gift
```javascript
// For Native Token (SOMI/STT) - token address is 0x0000000000000000000000000000000000000000
const tx = await contract.depositGift(giftId, ethers.ZeroAddress, amount, {
  value: amount // Send native token with transaction
});

// For ERC-20 Token - First approve, then deposit
const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
await tokenContract.approve(contractAddress, amount);
const tx = await contract.depositGift(giftId, tokenAddress, amount);
```

#### 5. ERC20 ABI (for approvals)
```json
[
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
]
```

---

## Implementation Details

### Wallet Connection Flow
1. User clicks "Connect Wallet"
2. Request access to MetaMask/Web3 wallet
3. Check if connected to Somnia network (Chain ID: 50312 or 50311)
4. If wrong network, prompt to switch
5. Store connected address and signer

### Deposit Flow
1. User enters gift code (e.g., "john42")
2. User connects wallet
3. Calculate `giftId = ethers.id(code)`
4. Call `contract.getGift(giftId)` to fetch details
5. Display: Token, Amount, Token Address
6. If ERC-20: Check allowance, show "Approve" button if needed
7. User clicks "Deposit"
8. Execute transaction:
   - Native: `depositGift(id, ZeroAddress, amount, { value: amount })`
   - ERC-20: `depositGift(id, tokenAddress, amount)`
9. Show transaction hash with link to explorer
10. Wait for confirmation

### Error Handling
- Invalid gift code → Show error message
- Not connected → Show connect wallet button
- Wrong network → Prompt to switch
- Insufficient balance → Show error
- Transaction failed → Show error with details

### URL Parameters Support
Support URL params like: `/deposit?gift=john42&token=STT&amount=100&tokenAddress=0x...`
- Auto-fill gift code if provided
- Pre-populate token info if available

---

## Styling Examples

### Button (Cartoonish Style)
```jsx
<button className="bg-yellow-400 text-black font-bold py-3 px-6 rounded-lg border-4 border-black hover:bg-yellow-300 transition-colors">
  Connect Wallet
</button>
```

### Input Field
```jsx
<input 
  className="bg-white text-black font-bold py-3 px-4 rounded-lg border-4 border-black focus:outline-none focus:ring-4 focus:ring-yellow-400"
  placeholder="Enter gift code"
/>
```

### Card Container
```jsx
<div className="bg-yellow-400 border-4 border-black rounded-lg p-6">
  <h2 className="text-black font-bold text-2xl mb-4">Gift Details</h2>
  {/* Content */}
</div>
```

### Page Container
```jsx
<div className="min-h-screen bg-blue-500 border-4 border-black p-8">
  {/* Content */}
</div>
```

---

## Required Dependencies

```json
{
  "dependencies": {
    "ethers": "^6.0.0",
    "react": "^18.0.0",
    "next": "^14.0.0",
    "tailwindcss": "^3.0.0"
  }
}
```

---

## Important Notes

1. **Thick Black Borders**: Every UI element (buttons, inputs, cards, containers) should have `border-4 border-black` or similar thick black borders
2. **Color Scheme**: Strictly use the blue background, yellow accents, white text, and black borders
3. **Cartoonish Vibe**: Rounded corners (`rounded-lg`), bold fonts, simple shapes - think emoji/meme aesthetic
4. **Chain Switching**: Automatically prompt users to switch to Somnia network if on wrong chain
5. **Transaction Feedback**: Show clear loading states, success messages, and error messages
6. **Responsive**: Should work on mobile and desktop

---

## Example Component Structure

```jsx
// pages/index.js - Coming Soon
export default function Home() {
  return (
    <div className="min-h-screen bg-blue-500 border-4 border-black flex items-center justify-center">
      <h1 className="text-white text-6xl font-bold border-4 border-black px-8 py-4 bg-yellow-400 rounded-lg">
        COMING SOON
      </h1>
    </div>
  );
}

// pages/deposit.js - Deposit Page
export default function Deposit() {
  // Wallet connection state
  // Gift code input state
  // Gift details state
  // Transaction state
  
  return (
    <div className="min-h-screen bg-blue-500 border-4 border-black p-8">
      {/* Wallet Connection */}
      {/* Gift Code Input */}
      {/* Gift Details Display */}
      {/* Deposit Button */}
    </div>
  );
}
```

---

Generate a complete, working frontend following all these specifications!
