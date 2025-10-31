// Deeza v2 - Universal Smart Contract AI Agent
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import CryptoJS from 'crypto-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { handleTokenQuery } from './support/tokenInfo.js';
import { swapEthToToken, quoteEthToToken } from './support/swap.js';
dotenv.config();

// Initialize
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Network Config - MAINNET ONLY
const SOMNIA_RPC = process.env.SOMNIA_RPC || 'https://somnia.publicnode.com';
const SOMNIA_EXPLORER = 'https://explorer.somnia.network/';
// Create provider - suppress network detection warnings by using explicit network
const provider = new ethers.JsonRpcProvider(SOMNIA_RPC, {
  chainId: parseInt(process.env.SOMNIA_CHAIN_ID || '5031'),
  name: 'somnia'
});
// Override _detectNetwork to prevent retries (hack but works)
provider._detectNetwork = async () => ({ chainId: parseInt(process.env.SOMNIA_CHAIN_ID || '5031'), name: 'somnia' });

// Router and WETH (WSOMI) for swaps
const ROUTER_ADDRESS = '0xCdE9aFDca1AdAb5b5C6E4F9e16c9802C88Dc7e1A'; // SomniExchangerRouter02
const WETH_ADDRESS = '0x046EDe9564A72571df6F5e44d0405360c0f4dCab';   // WSOMI

// Minimal UniswapV2 Router ABI
const ROUTER_ABI = [
  'function WETH() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)'
];

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

    const systemPrompt = `You are Deeza — a chill, conversational, helpful "crypto bro." You help users with swaps, prices, limit orders, and sticking together in the crypto trenches. Your signature emoji is 😉. Use 😉 intentionally for confirmations or when you're being supportive. Sometimes, when users make cool moves (like a token send), react with 😁 in Telegram. Your vibe: "we trenches bro, stick together." Help with token sends, limit orders, comparisons, and wallet info. Keep it real, minimal emojis, and always conversational.

ALWAYS return a single JSON response with keys: action, params, message. DO NOT output just plain text or any extra description. ONLY produce a single JSON object, nothing else.

RESPONSE FORMAT (JSON):
{
  "action": "chat",
  "params": {},
  "message": "I had trouble understanding that. Can you try rephrasing?"
}
`;

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
    console.log('AI RAW RESPONSE:', response);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('AI responded without parseable JSON:', response); // extra debug log
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
      let confirmationMessage = `Sent ${params.amount} ${params.token_symbol} to ${recipientDisplay}! We stick together in these trenches 😉\n\nView: ${SOMNIA_EXPLORER}tx/${tx.hash}`;

      // Telegram Reaction + Quoting
      if (params._telegram_chat_id && params._telegram_message_id) {
        try {
          await bot.setMessageReaction(params._telegram_chat_id, params._telegram_message_id, {
            reaction: [{ type: 'emoji', emoji: '😁' }]
          });
        } catch(err) {
          console.error('Reaction error:', err.response?.body || err);
        }
        return {
          success: true,
          message: confirmationMessage,
          quote_to_message_id: params._telegram_message_id
        };
      }
      return {
        success: true,
        message: confirmationMessage
      };
    }

    // Handle ETH -> Token swap (SOMI -> Token)
    if (action === 'swap_eth_to_token') {
      const privateKey = decrypt(userData.encrypted_private_key);
      return await swapEthToToken(params, { ...userData, privateKey }, provider);
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
      await bot.sendMessage(msg.chat.id, `Hey there! I'm Deeza — your very own crypto bro on Somnia. 😎\n\nYour wallet is ready:\n${user.wallet_address}\n\nI can help you:\n• Send tokens\n• Place limit orders\n• Perform swaps & bridges\n• Launch tokens seamlessly with Deeza\n• Check token info/prices & compare coins\n\nDo it all without leaving your DMs — and get it on somnia.meme 😉`, { disable_web_page_preview: true });

      setTimeout(() => {
        bot.sendMessage(msg.chat.id, `🔐 Your Private Key\n\n${user.privateKey}\n\n⚠️ Save this securely — it's your master key!`, { disable_web_page_preview: true });
      }, 1000);

      return;
    }

    bot.sendMessage(msg.chat.id, `Hey there! I'm Deeza — your crypto bro. 😎\n\nI can help you with:\n💰 Send tokens naturally — "send $5 of STT to @alice"\n🌀 Perform swaps & bridges\n🚀 Launch tokens seamlessly with Deeza\n📊 Check token prices — "What's SOMI price?"\n💧 Ask about liquidity — "Show me STT's liquidity"\n📈 Compare tokens — "Compare SOMI vs PEPE"\n\nAll without leaving your DMs — get it on somnia.meme 😉`);

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
    // Show typing while we process
    await bot.sendChatAction(msg.chat.id, 'typing');

    const user = await getOrCreateUser(tgId, username);

    // Removed: new-user welcome here. Only /start shows welcome & keys.

    // Check for existing context
    const existingContext = await getContext(tgId);

    // Quick confirm handler: if we have a pending swap and user says yes/sure/confirm
    if (existingContext && existingContext.context_type === 'pending_action' && existingContext.context_data?.action === 'swap_eth_to_token') {
      const text = (msg.text || '').toLowerCase().trim();
      if (/^(y|yes|sure|confirm|do it|go|ok)$/i.test(text)) {
        await bot.sendMessage(msg.chat.id, '...deezaing this', { reply_to_message_id: msg.message_id });
        await bot.sendChatAction(msg.chat.id, 'typing');
        const result = await executeAction('swap_eth_to_token', existingContext.context_data.params, user, tgId);
        await clearContext(tgId);
        if (result.message) {
          await bot.sendMessage(msg.chat.id, result.message, { disable_web_page_preview: true, reply_to_message_id: msg.message_id });
        }
        return;
      } else if (/^(n|no|cancel|stop)$/i.test(text)) {
        await clearContext(tgId);
        await bot.sendMessage(msg.chat.id, 'Cancelled. No swap executed.');
        return;
      }
    }

    // Process with AI
    const aiResponse = await processWithAI(msg.text, user, firstName, existingContext);

    try { await bot.setMessageReaction(msg.chat.id, msg.message_id, { reaction: [{ type: 'emoji', emoji: '😁' }] }); } catch {}

    if (aiResponse.action === 'save_context') {
      await saveContext(tgId, 'pending_action', aiResponse.params.context_data);
    }

    // Normalize actions (handle both snake_case and camelCase)
    const actionAliases = { 'get_wallet_address':'wallet_info','getWalletAddress':'wallet_info','get_balance':'wallet_info','getBalance':'wallet_info','get_wallet_balance':'wallet_info','getWalletBalance':'wallet_info','show_wallet':'wallet_info','showWallet':'wallet_info','check_my_wallet':'wallet_info','checkMyWallet':'wallet_info','check_my_balance':'wallet_info','checkMyBalance':'wallet_info','swap':'swap_eth_to_token','swap_somi':'swap_eth_to_token','swap_eth_to_token':'swap_eth_to_token' };
    const metricMap = { 'fetch_marketcap':'mcap','fetch_market_cap':'mcap','fetchMarketcap':'mcap','fetchMarketCap':'mcap','fetch_price':'price','fetchPrice':'price','fetch_liquidity':'liquidity','fetchLiquidity':'liquidity','fetch_volume':'volume','fetchVolume':'volume','fetch_change':'change','fetchChange':'change','token_info':null,'tokenInfo':null };
    
    if (aiResponse.action && actionAliases[aiResponse.action]) {
      aiResponse.action = actionAliases[aiResponse.action];
    } else if (aiResponse.action && metricMap.hasOwnProperty(aiResponse.action)) {
      aiResponse.params = aiResponse.params || {};
      const tokenSymbol = aiResponse.params.token || aiResponse.params.symbol || aiResponse.params.query;
      // Get metric BEFORE changing action
      const mm = metricMap[aiResponse.action];
      aiResponse.action = 'token_query';
      aiResponse.params.tokens = tokenSymbol ? [tokenSymbol] : (aiResponse.params.tokens || []);
      if (mm) aiResponse.params.metric = mm;
      if ((aiResponse.params.metric === 'volume' || aiResponse.params.metric === 'change') && !aiResponse.params.timeframe) aiResponse.params.timeframe = '24h';
    }

    if (['send_token'].includes(aiResponse.action)) {
      aiResponse.params = aiResponse.params || {};
      aiResponse.params._telegram_chat_id = msg.chat.id;
      aiResponse.params._telegram_message_id = msg.message_id;
    }

    if (aiResponse.message) {
      await bot.sendMessage(msg.chat.id, aiResponse.message, { disable_web_page_preview: true, reply_to_message_id: msg.message_id });
    }

    // Execution actions
    const executionActions = ['send_token','send_usd','mint_usdc','token_query','wallet_info','balance_check','swap_eth_to_token'];

    // For swaps, do quote + save context first, require confirmation
    if (aiResponse.action === 'swap_eth_to_token') {
      const privateKey = decrypt(user.encrypted_private_key);
      const quote = await quoteEthToToken(aiResponse.params, { ...user, privateKey }, provider);
      if (!quote.success) {
        await bot.sendMessage(msg.chat.id, quote.message, { reply_to_message_id: msg.message_id });
        return;
      }
      await bot.sendMessage(msg.chat.id, quote.message, { reply_to_message_id: msg.message_id });
      await saveContext(tgId, 'pending_action', { action: 'swap_eth_to_token', params: aiResponse.params });
      return;
    }

    if (executionActions.includes(aiResponse.action)) {
      await bot.sendMessage(msg.chat.id, '...deezaing this', { reply_to_message_id: msg.message_id });
      await bot.sendChatAction(msg.chat.id, 'typing');
      const result = await executeAction(aiResponse.action, aiResponse.params, user, tgId);
      if (result.message) {
        await bot.sendMessage(msg.chat.id, result.message, { disable_web_page_preview: true, reply_to_message_id: msg.message_id });
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