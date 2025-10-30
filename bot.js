// Deeza v2 - Universal Smart Contract AI Agent
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import CryptoJS from 'crypto-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { handleTokenQuery } from './support/tokenInfo.js';
dotenv.config();

// Initialize
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Network Config - MAINNET ONLY
const SOMNIA_RPC = 'https://somnia.publicnode.com';
const SOMNIA_EXPLORER = 'https://explorer.somnia.network/';
const provider = new ethers.JsonRpcProvider(SOMNIA_RPC);

// Contracts
const USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS;
const SOMI_POOL_ADDRESS = '0x70d069acda32ce9a2e13cfbcbf33ba39bc151517f5133fa9cd0ecee8849a6129';
const GECKOTERMINAL_API = `https://api.geckoterminal.com/api/v2/networks/eth/pools/${SOMI_POOL_ADDRESS}`;

// ERC20 ABI
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function mint() public',
  'function timeUntilNextMint(address user) public view returns (uint256)'
];

// Encryption
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
function encrypt(text) {
  return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
}
function decrypt(encryptedText) {
  const bytes = CryptoJS.AES.decrypt(encryptedText, ENCRYPTION_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// Generate wallet
function generateWallet() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    encryptedKey: encrypt(wallet.privateKey)
  };
}

// Get or create user
async function getOrCreateUser(tgId, username) {
  const { data: existingUser } = await supabase
    .from('deeza_users')
    .select('*')
    .eq('telegram_id', tgId)
    .single();

  if (existingUser) return existingUser;

  const wallet = generateWallet();
  const { data: newUser } = await supabase.from('deeza_users').insert({
    telegram_id: tgId,
    telegram_username: username,
    wallet_address: wallet.address,
    encrypted_private_key: wallet.encryptedKey,
    tier: 'regular'
  }).select().single();

  return { ...newUser, isNew: true, privateKey: wallet.privateKey };
}

// Conversation context management
async function saveContext(tgId, contextType, contextData) {
  await supabase.from('conversation_context').delete().eq('telegram_id', tgId); // Clear old context
  
  await supabase.from('conversation_context').insert({
    telegram_id: tgId,
    context_type: contextType,
    context_data: contextData,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() // 5 min expiry
  });
}

async function getContext(tgId) {
  const { data } = await supabase
    .from('conversation_context')
    .select('*')
    .eq('telegram_id', tgId)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  
  return data;
}

async function clearContext(tgId) {
  await supabase.from('conversation_context').delete().eq('telegram_id', tgId);
}

// Get STT price
async function getSTTPrice() {
  try {
    const response = await fetch(GECKOTERMINAL_API);
    const data = await response.json();
    return parseFloat(data.data.attributes.base_token_price_usd) || 0;
  } catch {
    return 0;
  }
}

// Get token price (for USD conversion)
async function getTokenPrice(tokenSymbol) {
  if (tokenSymbol === 'USDC') return 1; // USDC = $1
  if (tokenSymbol === 'STT') return await getSTTPrice();
  return 0;
}

// Convert USD to token amount
async function convertUSDToToken(usdAmount, tokenSymbol) {
  const price = await getTokenPrice(tokenSymbol);
  if (price === 0) return null;
  return usdAmount / price;
}

// Get balance for any token
async function getBalance(address, tokenAddress = null) {
  try {
    if (!tokenAddress) {
      const balance = await provider.getBalance(address);
      return {
        balance: ethers.formatEther(balance),
        decimals: 18,
        symbol: 'STT',
        isNative: true
      };
    } else {
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      const [balance, decimals, symbol, name] = await Promise.all([
        contract.balanceOf(address),
        contract.decimals(),
        contract.symbol().catch(() => 'UNKNOWN'),
        contract.name().catch(() => 'Unknown Token')
      ]);
      return {
        balance: ethers.formatUnits(balance, decimals),
        decimals,
        symbol,
        name,
        isNative: false
      };
    }
  } catch (error) {
    return null; // Token doesn't exist
  }
}

// Check if username exists
async function checkUserExists(username) {
  const { data } = await supabase
    .from('deeza_users')
    .select('wallet_address, telegram_username')
    .eq('telegram_username', username.toLowerCase())
    .single();
  return data;
}

// Get USDC mint cooldown
async function getUSDCMintCooldown(address) {
  try {
    const contract = new ethers.Contract(USDC_CONTRACT_ADDRESS, ERC20_ABI, provider);
    const timeRemaining = await contract.timeUntilNextMint(address);
    return Number(timeRemaining);
  } catch {
    return null;
  }
}

// Main GPT-4 Brain with context awareness
async function processWithAI(userMessage, userData, userName, existingContext) {
  try {
    const sttBalance = await getBalance(userData.wallet_address) || { balance: '0', symbol: 'STT' };
    const usdcBalance = await getBalance(userData.wallet_address, USDC_CONTRACT_ADDRESS) || { balance: '0', symbol: 'USDC' };
    const sttPrice = await getSTTPrice();
    const usdcCooldown = await getUSDCMintCooldown(userData.wallet_address);
    
    const sttUSD = parseFloat(sttBalance.balance || 0) * sttPrice;
    const hasGas = parseFloat(sttBalance.balance || 0) > 0;

    const contextInfo = existingContext ? `
CONVERSATION CONTEXT (User is continuing from previous message):
Type: ${existingContext.context_type}
Data: ${JSON.stringify(existingContext.context_data)}

If user provides a number/amount or clarification, complete the pending action!
` : '';

    const systemPrompt = `You are Deeza - an AI Crypto Bro! 🔥 You're super friendly, chatty, and know everything about crypto. Think of yourself as that cool friend who's always up on the latest crypto moves. Be conversational, use emojis liberally, and make users feel like they're talking to their crypto homie. You're not a robot - you're Deeza! 😎

CURRENT USER CONTEXT:
- Wallet: ${userData.wallet_address}
- STT Balance: ${sttBalance.balance || '0'} STT (~$${sttUSD.toFixed(2)})
- USDC Balance: ${usdcBalance.balance || '0'} USDC
- Has Gas: ${hasGas ? 'YES' : 'NO'}
- STT Price: $${sttPrice.toFixed(4)}
- USDC Cooldown: ${usdcCooldown === 0 ? 'AVAILABLE' : usdcCooldown > 0 ? `${Math.floor(usdcCooldown/3600)}h ${Math.floor((usdcCooldown%3600)/60)}m` : 'N/A'}

${contextInfo}

CAPABILITIES:
1. Send tokens by AMOUNT or USD value (e.g., "send $5 worth of STT")
2. Balance checks for any token
3. TOKEN QUERIES - Answer questions about any token on Somnia (price, volume, market cap, liquidity, holders, change)
4. Follow-up conversation (remembers context for 5 minutes)

RESPONSE FORMAT (JSON):
{
  "action": "send_token" | "send_usd" | "balance_check" | "lookup_user" | "token_query" | "wallet_info" | "chat" | "save_context",
  "params": {
    "token_symbol": "STT" | "USDC" | null,
    "token_address": "0x..." or null,
    "amount": number or null,
    "usd_amount": number or null,
    "recipient": "@username" or "0x..." or null,
    "tokens": ["TOKEN_NAME"] or null,
    "metric": "price" | "volume" | "mcap" | "liquidity" | "holders" | "change",
    "timeframe": "1h" | "6h" | "24h" | "7d" | "30d",
    "context_data": {} // Data to save for follow-up
  },
  "message": "Plain text response - NO markdown"
}

KEY BEHAVIORS:

1. USD CONVERSION:
"send $5 of STT to @alice" → Calculate: $5 / $${sttPrice.toFixed(4)} = ~${(5/sttPrice).toFixed(2)} STT
Check balance: ${sttBalance.balance} STT available
Check user exists: @alice registered?
Action: {"action":"send_usd","params":{"usd_amount":5,"token_symbol":"STT","recipient":"alice"},"message":"Sending $5 worth of STT (~${(5/sttPrice).toFixed(2)} STT) to @alice..."}

2. FOLLOW-UP CONTEXT:
User says: "send @david STT"
You respond: {"action":"save_context","params":{"context_data":{"action":"send_token","token_symbol":"STT","recipient":"david"}},"message":"How much STT would you like to send to @david?"}
[Context saved for 5 minutes]

User says: "6"
You see context and respond: {"action":"send_token","params":{"amount":6,"token_symbol":"STT","recipient":"david"},"message":"Sending 6 STT to @david..."}

3. TOKEN EXISTENCE CHECK:
User: "check balance of 0xNonExistentToken"
After checking: Token returns null
Response: {"action":"chat","params":{},"message":"That token doesn't exist on Shannon Testnet! Want to check a different address?"}

4. TOKEN QUERIES:
User: "What's SOMI price?"
→ {"action":"token_query","params":{"tokens":["SOMI"],"metric":"price"},"message":"Checking SOMI price..."}

User: "PEPE volume?"
→ {"action":"token_query","params":{"tokens":["PEPE"],"metric":"volume","timeframe":"24h"},"message":"Fetching PEPE trading volume..."}

User: "Show me STT liquidity"
→ {"action":"token_query","params":{"tokens":["STT"],"metric":"liquidity"},"message":"Checking STT liquidity..."}

User: "Compare SOMI and PEPE market cap"
→ {"action":"token_query","params":{"tokens":["SOMI","PEPE"],"metric":"mcap"},"message":"Comparing market caps..."}

5. WALLET QUERIES:
User: "What's my wallet address?"
→ {"action":"wallet_info","params":{},"message":"Showing your wallet info..."}

User: "Show me my wallet"
→ {"action":"wallet_info","params":{},"message":"Pulling up your wallet..."}

User: "My address"
→ {"action":"wallet_info","params":{},"message":"Here's your wallet..."}

6. SOMI CLARIFICATION:
"send SOMI" → "Did you mean STT? (SOMI is mainnet, STT is testnet)"

CRITICAL RULES:
- NO markdown symbols (*, _, \`)
- Be SUPER chatty, friendly, and use emojis! 😎
- Make every response feel personal and conversational
- Check if token exists before reporting balance
- For USD sends: calculate amount, check balance, check user exists
- Save context for incomplete requests
- Use context to complete follow-ups
- Think like a friendly banker who LOVES crypto

TONE EXAMPLES:
✅ "Hey! SOMI is sitting pretty at $0.0234 right now! 📈"
✅ "Yo! PEPE just did $145K in 24h volume - that's solid! 🚀"  
❌ "Price: $0.0234"
❌ "Volume: $145K"

Return ONLY JSON.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.4,
      max_tokens: 500
    });

    const response = completion.choices[0].message.content.trim();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        action: 'chat',
        params: {},
        message: "I had trouble understanding that. Can you try rephrasing?"
      };
    }
    
    return JSON.parse(jsonMatch[0]);

  } catch (error) {
    console.error('AI processing error:', error);
    return {
      action: 'chat',
      params: {},
      message: "Sorry, I encountered an error. Please try again!"
    };
  }
}

// Execute blockchain action
async function executeAction(action, params, userData, tgId) {
  try {
    const privateKey = decrypt(userData.encrypted_private_key);
    const wallet = new ethers.Wallet(privateKey, provider);

    // Handle USD-based sends
    if (action === 'send_usd') {
      const tokenAmount = await convertUSDToToken(params.usd_amount, params.token_symbol);
      if (!tokenAmount) {
        return { success: false, message: `Couldn't get price for ${params.token_symbol}` };
      }

      // Check user exists
      if (!params.recipient.startsWith('0x')) {
        const cleanUsername = params.recipient.replace('@', '').toLowerCase();
        const target = await checkUserExists(cleanUsername);
        if (!target) {
          return {
            success: false,
            message: `@${cleanUsername} hasn't set up their wallet yet! Invite them to message me.`
          };
        }
      }

      // Check balance
      const balance = await getBalance(userData.wallet_address, params.token_address);
      if (parseFloat(balance.balance) < tokenAmount) {
        return {
          success: false,
          message: `You need ${tokenAmount.toFixed(4)} ${params.token_symbol} but only have ${balance.balance}!`
        };
      }

      // Convert to regular send
      params.amount = tokenAmount;
      action = 'send_token';
    }

    // Handle token sends
    if (action === 'send_token') {
      let targetAddress;
      if (params.recipient.startsWith('0x')) {
        targetAddress = params.recipient;
      } else {
        const cleanUsername = params.recipient.replace('@', '').toLowerCase();
        const target = await checkUserExists(cleanUsername);
        if (!target) {
          return {
            success: false,
            message: `@${cleanUsername} hasn't set up their wallet yet! Invite them to message me.`
          };
        }
        targetAddress = target.wallet_address;
      }

      let tx;
      if (params.token_symbol === 'STT' && !params.token_address) {
        tx = await wallet.sendTransaction({
          to: targetAddress,
          value: ethers.parseEther(params.amount.toString())
        });
      } else {
        const tokenAddr = params.token_address || USDC_CONTRACT_ADDRESS;
        const contract = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
        const decimals = await contract.decimals();
        tx = await contract.transfer(targetAddress, ethers.parseUnits(params.amount.toString(), decimals));
      }

      await tx.wait();
      await clearContext(tgId); // Clear context after successful send

      const recipientDisplay = params.recipient.startsWith('0x')
        ? `${params.recipient.slice(0, 6)}...${params.recipient.slice(-4)}`
        : `@${params.recipient.replace('@', '')}`;

      return {
        success: true,
        message: `Sent!\n\n${params.amount} ${params.token_symbol} → ${recipientDisplay}\n\nView: ${SOMNIA_EXPLORER}tx/${tx.hash}`
      };
    }

    // Handle balance checks
    if (action === 'balance_check') {
      if (params.token_address) {
        const tokenInfo = await getBalance(userData.wallet_address, params.token_address);
        if (!tokenInfo) {
          return {
            success: false,
            message: `That token doesn't exist on Somnia! Want to check a different address?`
          };
        }
        return {
          success: true,
          message: `${tokenInfo.name} (${tokenInfo.symbol})\n\nBalance: ${parseFloat(tokenInfo.balance).toFixed(4)} ${tokenInfo.symbol}\n\nContract: ${params.token_address}`
        };
      } else {
        const sttBalance = await getBalance(userData.wallet_address) || { balance: '0', symbol: 'STT' };
        const usdcBalance = await getBalance(userData.wallet_address, USDC_CONTRACT_ADDRESS) || { balance: '0', symbol: 'USDC' };
        const sttPrice = await getSTTPrice();
        const sttUSD = parseFloat(sttBalance.balance || 0) * sttPrice;

        return {
          success: true,
          message: `💰 Your Wallet! 🔥\n\n📍 ${userData.wallet_address}\n\n💵 Balances:\n• STT: ${parseFloat(sttBalance.balance || 0).toFixed(4)} (~$${sttUSD.toFixed(2)})\n• USDC: ${parseFloat(usdcBalance.balance || 0).toFixed(2)}\n\n💲 STT Price: $${sttPrice.toFixed(4)}\n📊 Total: ~$${(sttUSD + parseFloat(usdcBalance.balance || 0)).toFixed(2)}\n\n🔍 ${SOMNIA_EXPLORER}address/${userData.wallet_address}`
        };
      }
    }

    // Handle user lookup
    if (action === 'lookup_user') {
      const cleanUsername = params.username_to_check.replace('@', '').toLowerCase();
      const user = await checkUserExists(cleanUsername);
      if (user) {
        return {
          success: true,
          message: `Yes, @${cleanUsername} is registered!\n\nWallet: ${user.wallet_address}`
        };
      } else {
        return {
          success: false,
          message: `@${cleanUsername} hasn't set up their wallet yet. They can message me to get started!`
        };
      }
    }

    // Handle mint USDC
    if (action === 'mint_usdc') {
      const contract = new ethers.Contract(USDC_CONTRACT_ADDRESS, ERC20_ABI, wallet);
      const tx = await contract.mint();
      await tx.wait();

      const newBalance = await getBalance(userData.wallet_address, USDC_CONTRACT_ADDRESS);

      return {
        success: true,
        message: `USDC Minted!\n\nYou received 200 USDC\nNew Balance: ${newBalance.balance} USDC\n\nNext mint in 24h\n\nView: ${SOMNIA_EXPLORER}tx/${tx.hash}`
      };
    }

    // Handle token queries
    if (action === 'token_query') {
      const response = await handleTokenQuery(params, provider);
      return {
        success: true,
        message: response
      };
    }

    // Handle wallet info
    if (action === 'wallet_info') {
      const sttBalance = await getBalance(userData.wallet_address) || { balance: '0', symbol: 'STT' };
      const usdcBalance = await getBalance(userData.wallet_address, USDC_CONTRACT_ADDRESS) || { balance: '0', symbol: 'USDC' };
      const sttPrice = await getSTTPrice();
      const sttUSD = parseFloat(sttBalance.balance || 0) * sttPrice;

      return {
        success: true,
        message: `💰 Your Wallet on Somnia! 🔥\n\n📍 Address:\n${userData.wallet_address}\n\n💵 Balances:\n• STT: ${parseFloat(sttBalance.balance || 0).toFixed(4)} (~$${sttUSD.toFixed(2)})\n• USDC: ${parseFloat(usdcBalance.balance || 0).toFixed(2)}\n\n💲 STT Price: $${sttPrice.toFixed(4)}\n📊 Total Value: ~$${(sttUSD + parseFloat(usdcBalance.balance || 0)).toFixed(2)}\n\n🔍 View: ${SOMNIA_EXPLORER}address/${userData.wallet_address}`
      };
    }

    return { success: true, message: null };

  } catch (error) {
    console.error('Execute action error:', error);
    let errorMsg = 'Transaction Failed\n\n';

    if (error.message.includes('insufficient funds')) {
      errorMsg += 'You don\'t have enough tokens or gas.\n\nYou need STT (native token) for gas fees! 💸';
    } else if (error.message.includes('account does not exist')) {
      errorMsg += 'Your wallet needs STT for gas!\n\nGet some STT to get started! 💰';
    } else {
      errorMsg += error.message;
    }

    return { success: false, message: errorMsg };
  }
}

// Handle /help and /start
bot.onText(/\/(help|start)/, async (msg) => {
  const tgId = msg.from.id;
  const username = msg.from.username?.toLowerCase() || msg.from.first_name;

  try {
    const user = await getOrCreateUser(tgId, username);

    if (user.isNew) {
      await bot.sendMessage(msg.chat.id, `Yo! 👋 I'm Deeza - your AI Crypto Bro on Somnia! 🔥\n\nGot your wallet set up:\n${user.wallet_address}\n\nI can help you:\n• Send tokens (just tell me how much and to who!)\n• Check any token price, volume, market cap - anything\n• Answer questions about what's going on in the market\n\nJust talk to me naturally - I got you! 😎`, { disable_web_page_preview: true });

      setTimeout(() => {
        bot.sendMessage(msg.chat.id, `🔐 Your Private Key\n\n${user.privateKey}\n\n⚠️ Save this securely - it's your master key!`, { disable_web_page_preview: true });
      }, 1000);

      return;
    }

    bot.sendMessage(msg.chat.id, `Yo! 👋 I'm Deeza - your AI Crypto Bro! 🔥\n\nI can help you with:\n💰 Send tokens naturally - "send $5 of STT to @alice"\n📊 Check token prices - "What's SOMI price?"\n💧 Ask about liquidity - "Show me STT's liquidity"\n📈 Compare tokens - "Compare SOMI vs PEPE"\n💵 Check balances\n\nJust chat with me naturally - I got you covered! 😎`);

  } catch (error) {
    console.error('Help error:', error);
    bot.sendMessage(msg.chat.id, 'Something went wrong!');
  }
});

// Main message handler
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;
  if (!msg.text) return;

  const tgId = msg.from.id;
  const username = msg.from.username?.toLowerCase() || msg.from.first_name;
  const firstName = msg.from.first_name || 'there';

  try {
    const user = await getOrCreateUser(tgId, username);

    if (user.isNew) {
      await bot.sendMessage(msg.chat.id, `Yo! 👋 I'm Deeza - your AI Crypto Bro on Somnia! 🔥\n\nGot your wallet set up:\n${user.wallet_address}\n\nI can help you:\n• Send tokens (just tell me how much and to who!)\n• Check any token price, volume, market cap - anything\n• Answer questions about what's going on in the market\n\nJust talk to me naturally - I got you! 😎`, { disable_web_page_preview: true });
      setTimeout(() => bot.sendMessage(msg.chat.id, `🔐 Your Private Key\n\n${user.privateKey}\n\n⚠️ Save this securely - it's your master key!`, { disable_web_page_preview: true }), 1000);
      return;
    }

    // Check for existing context
    const existingContext = await getContext(tgId);

    // Process with AI
    const aiResponse = await processWithAI(msg.text, user, firstName, existingContext);

    // Save context if needed
    if (aiResponse.action === 'save_context') {
      await saveContext(tgId, 'pending_action', aiResponse.params.context_data);
    }

    // Send AI message
    if (aiResponse.message) {
      await bot.sendMessage(msg.chat.id, aiResponse.message, { disable_web_page_preview: true });
    }

    // Execute action
    if (['send_token', 'send_usd', 'mint_usdc', 'lookup_user', 'balance_check', 'token_query', 'wallet_info'].includes(aiResponse.action)) {
      const result = await executeAction(aiResponse.action, aiResponse.params, user, tgId);
      if (result.message) {
        await bot.sendMessage(msg.chat.id, result.message, { disable_web_page_preview: true });
      }
    }

  } catch (error) {
    console.error('Message error:', error);
    bot.sendMessage(msg.chat.id, 'Something went wrong!');
  }
});

// Error handling
bot.on('polling_error', (error) => console.error('Polling:', error));
bot.on('error', (error) => console.error('Bot:', error));

// Launch
console.log('Deeza - AI Crypto Bro 🔥');
console.log('Features: Token queries, Wallet management, USD sends, Follow-ups');
console.log('Ready!');

process.once('SIGINT', () => bot.stopPolling().then(() => process.exit(0)));
process.once('SIGTERM', () => bot.stopPolling().then(() => process.exit(0)));