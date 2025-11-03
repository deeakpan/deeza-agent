// Deeza - Peer-to-Peer Gift Bot on Somnia
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { searchToken } from './support/tokenInfo.js';
import { uploadToIPFS, fetchFromIPFS } from './support/lighthouse.js';
dotenv.config();

// Initialize
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { 
  polling: {
    interval: 1000,
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Network Config
const IS_TESTNET = process.env.IS_TESTNET === 'true' || process.env.NODE_ENV === 'test';
const SOMNIA_RPC = process.env.SOMNIA_RPC || (IS_TESTNET ? 'https://dream-rpc.somnia.network' : 'https://somnia.publicnode.com');
const SOMNIA_CHAIN_ID = parseInt(process.env.SOMNIA_CHAIN_ID || (IS_TESTNET ? '50312' : '50311'));
const CONTRACT_ADDRESS = process.env.DEEZA_AGENT_CONTRACT;
const WALLET_CONNECT_URL = 'https://deeza-website.vercel.app';

// Testnet: ZAZZ token (mock token for all ERC20 requests)
const ZAZZ_TOKEN_ADDRESS = process.env.ZAZZ_TOKEN_ADDRESS || ethers.ZeroAddress;

// Validate ZAZZ address on testnet
if (IS_TESTNET && ZAZZ_TOKEN_ADDRESS && ZAZZ_TOKEN_ADDRESS !== ethers.ZeroAddress && !ethers.isAddress(ZAZZ_TOKEN_ADDRESS)) {
  console.error(`❌ Invalid ZAZZ_TOKEN_ADDRESS: ${ZAZZ_TOKEN_ADDRESS}`);
  console.error('Must be a valid Ethereum address (0x...)');
  process.exit(1);
}
const ZAZZ_MINT_AMOUNT = ethers.parseUnits('100000', 18);

// Native token symbols
const NATIVE_TOKEN = IS_TESTNET ? 'STT' : 'SOMI';

const provider = new ethers.JsonRpcProvider(SOMNIA_RPC, {
  chainId: SOMNIA_CHAIN_ID,
  name: 'somnia',
  ensAddress: null,  // Disable ENS resolution
  staticNetwork: true  // Skip network detection
}, {
  timeout: 60000  // 60 second timeout
});

// Contract ABI (minimal)
const CONTRACT_ABI = [
  'function createGift(bytes32 id, string calldata code, string calldata ipfsLink, address recipient, address token, uint256 amount) external',
  'function depositGift(bytes32 id) external payable',
  'function release(bytes32 id) external',
  'function extendClaimTime(bytes32 id, uint256 minutes) external',
  'function getGift(bytes32 id) external view returns (tuple(address gifter, address recipient, address token, uint256 amount, string code, string ipfsLink, address claimer, uint256 claimDeadline, uint8 attempts, bool deposited, bool claimed))',
  'function getGiftsByGifter(address gifter) external view returns (tuple(address gifter, address recipient, address token, uint256 amount, string code, string ipfsLink, address claimer, uint256 claimDeadline, uint8 attempts, bool deposited, bool claimed)[])',
  'function getGiftsByRecipient(address recipient) external view returns (tuple(address gifter, address recipient, address token, uint256 amount, string code, string ipfsLink, address claimer, uint256 claimDeadline, uint8 attempts, bool deposited, bool claimed)[])',
  'function getGiftCountByGifter(address gifter) external view returns (uint256)',
  'function getGiftCountByRecipient(address recipient) external view returns (uint256)',
  'event GiftCreated(bytes32 indexed id, address recipient, address token, uint256 amount, string code)',
  'event GiftDeposited(bytes32 indexed id, address gifter)',
  'event GiftClaimed(bytes32 indexed id, address claimer, uint256 amount, address token)'
];

// ZAZZ Token ABI
const ZAZZ_ABI = [
  'function mint(address to, uint256 amount) external',
  'function balanceOf(address account) external view returns (uint256)'
];

// Validate contract address
if (CONTRACT_ADDRESS && !ethers.isAddress(CONTRACT_ADDRESS)) {
  console.error(`❌ Invalid CONTRACT_ADDRESS: ${CONTRACT_ADDRESS}`);
  console.error('Must be a valid Ethereum address (0x...)');
  process.exit(1);
}

const contract = CONTRACT_ADDRESS ? new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider) : null;
const zazzContract = ZAZZ_TOKEN_ADDRESS && ZAZZ_TOKEN_ADDRESS !== ethers.ZeroAddress 
  ? new ethers.Contract(ZAZZ_TOKEN_ADDRESS, ZAZZ_ABI, provider) 
  : null;

// Context types
const CONTEXT_TYPES = {
  REGISTER_WALLET: 'register_wallet',
  REGISTER_WALLET_CONFIRM: 'register_wallet_confirm',
  SEND_GIFT_PROOF: 'send_gift_proof',
  SEND_GIFT_PROOF_CONFIRM: 'send_gift_proof_confirm', // NEW: Ask if they want to add more proofs
  SEND_GIFT_MESSAGE: 'send_gift_message', // NEW: Collect optional message
  SEND_GIFT_CODE: 'send_gift_code',
  SEND_GIFT_CONFIRM: 'send_gift_confirm',
  CLAIM_GIFT: 'claim_gift'
};

// Get or create user
async function getOrCreateUser(tgId, username) {
  const { data: existingUser } = await supabase
    .from('deeza_users')
    .select('*')
    .eq('telegram_id', tgId)
    .single();

  if (existingUser) return existingUser;

  const { data: newUser } = await supabase.from('deeza_users').insert({
    telegram_id: tgId,
    telegram_username: username,
    wallet_address: null
  }).select().single();

  return newUser;
}

// Save context
async function saveContext(tgId, type, data) {
  // Delete existing context first to ensure clean state
  await supabase.from('deeza_contexts').delete().eq('telegram_id', tgId);
  
  // Insert new context
  const { error } = await supabase.from('deeza_contexts').insert({
    telegram_id: tgId,
    context_type: type,
    context_data: data,
    updated_at: new Date().toISOString()
  });
  
  if (error) {
    console.error('[saveContext] Error:', error);
    throw error;
  }
  
  console.log(`[saveContext] ✅ Saved context for ${tgId}: ${type}`);
}

// Retry helper for blockchain calls
async function retryBlockchainCall(fn, maxAttempts = 3, delayMs = 3000) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.log(`[RETRY] Attempt ${attempt}/${maxAttempts} failed:`, error.message);
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

// Get context
async function getContext(tgId) {
  const { data, error } = await supabase
    .from('deeza_contexts')
    .select('*')
    .eq('telegram_id', tgId)
    .single();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
    console.error('[getContext] Error:', error);
  }
  
  console.log(`[getContext] User ${tgId}: ${data ? data.context_type : 'NO CONTEXT'}`);
  return data;
}

// Clear context
async function clearContext(tgId) {
  await supabase.from('deeza_contexts').delete().eq('telegram_id', tgId);
}

// Get user by username
async function getUserByUsername(username) {
  const { data } = await supabase
    .from('deeza_users')
    .select('*')
    .eq('telegram_username', username.toLowerCase())
    .single();
  return data;
}

// AI Intent Parser
async function processWithAI(userMessage, existingContext = null) {
  try {
    const systemPrompt = `You are Deeza — a chill, conversational, helpful "crypto bro" on Somnia. You help users gift crypto (USDC, ${NATIVE_TOKEN}, or any ERC-20 token) to friends using natural language. Your signature emoji is 😉.

PERSONALITY:
- You're friendly, approachable, and always happy to chat
- You respond to greetings warmly: "Hey! 😉", "What's up!", "Yo! How can I help?"
- You're knowledgeable about crypto but keep it casual
- You use emojis naturally but not excessively
- You're helpful and guide users through the gifting process

SPECIAL RESPONSES:
- Greetings (hi/hey/hello/sup/yo): Respond warmly and ask how you can help. Example: "Hey there! 😉 Ready to send some crypto gifts?"
- If user asks about a "Deeza token": "Our developers haven't launched an official token yet, but if we did, we'd be sure it'd do a moon shot! 🚀😉"
- If user asks about founder/developer/owner/creator/builder: "I was built by Dee, a 16 year old Nigerian developer — an amazing guy! Even named this crypto bro after himself 😉"
- About yourself: "I'm Deeza, your crypto gifting assistant! I help you send crypto gifts to friends with AI-gated claims. Pretty cool, right? 😉"

ALWAYS return a single JSON response with keys: action, params, message. ONLY produce a single JSON object.

ACTIONS:
1. REGISTER_WALLET: When user wants to register their wallet or says "register me", "register wallet", etc.
   - params: { "intent": "register" }
   - message: "" (empty - bot will handle the message)

2. SEND_GIFT: When user wants to gift/send crypto (e.g., "gift @john 10 USDC", "send 5 ${NATIVE_TOKEN} to @mike", "give @alice 100$ worth of NIA")
   - TRIGGER WORDS: gift, send, give, transfer, pay
   - Extract: recipient (username or @username), amount (number), token (USDC, ${NATIVE_TOKEN}, or token symbol)
   - If amount is in USD (has $ or "usd"), set "amount_usd": number, else set "amount": number
   - params: { "recipient": "john", "amount": 10, "token": "USDC" } OR { "recipient": "mike", "amount": 5, "token": "${NATIVE_TOKEN}" } OR { "recipient": "alice", "amount_usd": 100, "token": "NIA" }
   - message: "" (empty - bot will handle validation and messaging)

3. SET_PROOF: When user answers what the receiver should prove (after send gift)
   - params: { "proof": "answer text" }

4. CLAIM_GIFT: When user wants to claim a gift (e.g., "claim john42", "claim code123")
   - params: { "code": "john42" }
   - message: "" (empty - bot will handle the claim flow)

5. SHOW_GIFTS: When user wants to see their gifts ("show my gifts", "show pending", "show sent")
   - params: { "type": "pending|active|all" }

6. CHAT: For general conversation, greetings, questions about crypto, help requests, etc.
   - Respond naturally and conversationally
   - Be helpful and friendly
   - Guide users if they seem lost

EXAMPLES:
User: "hi" → {"action":"chat","params":{},"message":"Hey there! 😉 Ready to send some crypto gifts?"}
User: "hello" → {"action":"chat","params":{},"message":"Hey! What's up? Need help with anything? 😉"}
User: "what can you do?" → {"action":"chat","params":{},"message":"I help you gift crypto to friends! You can gift USDC, ${NATIVE_TOKEN}, or any token. Try: 'gift @friend 10 USDC' 😉"}
User: "gift @john 10 USDC" → {"action":"send_gift","params":{"recipient":"john","amount":10,"token":"USDC"},"message":""}
User: "send 5 ${NATIVE_TOKEN} to @mike" → {"action":"send_gift","params":{"recipient":"mike","amount":5,"token":"${NATIVE_TOKEN}"},"message":""}

IMPORTANT: Always respond with natural, conversational messages for CHAT action. Never leave users hanging!

RESPONSE FORMAT (JSON):
{
  "action": "chat",
  "params": {},
  "message": "Hey! 😉 How can I help you today?"
}
`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ];

    if (existingContext) {
      messages.splice(1, 0, {
        role: "assistant",
        content: `Context: User is in ${existingContext.context_type} flow.`
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages,
      temperature: 0.4,
      max_tokens: 500
    });

    const response = completion.choices[0].message.content.trim();
    console.log('AI RAW RESPONSE:', response);
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

// AI Judge - Check if answer matches expected
async function judgeAnswer(userAnswer, expectedAnswer) {
  try {
    // First, do a simple case-insensitive exact match
    const userLower = userAnswer.trim().toLowerCase();
    const expectedLower = expectedAnswer.trim().toLowerCase();
    
    if (userLower === expectedLower) {
      console.log(`[JUDGE] Expected: "${expectedAnswer}", Got: "${userAnswer}" → ✅ Exact match (simple)`);
      return { correct: true, reason: "Exact match" };
    }
    
    // Also check if user's answer contains the expected answer or vice versa (for flexibility)
    if (userLower.includes(expectedLower) || expectedLower.includes(userLower)) {
      console.log(`[JUDGE] Expected: "${expectedAnswer}", Got: "${userAnswer}" → ✅ Partial match (simple)`);
      return { correct: true, reason: "Partial match" };
    }
    
    // If simple match fails, use AI for semantic matching
    const prompt = `You are an AI judge. Check if the user's answer matches the expected answer.

Expected answer: "${expectedAnswer}"
User's answer: "${userAnswer}"

CRITICAL: You MUST be VERY FLEXIBLE:
- Ignore capitalization (charles = Charles = CHARLES)
- Ignore extra spaces or punctuation
- If the user's answer clearly refers to the same thing, mark it correct
- Partial matches are acceptable (e.g., "charles" matches "his name is charles")
- Common variations should be accepted (nicknames, abbreviations)

Respond with ONLY a JSON object:
{
  "correct": true/false,
  "reason": "brief explanation"
}

Examples:
- Expected: "charles", User: "Charles" → CORRECT
- Expected: "charles", User: "CHARLES" → CORRECT
- Expected: "his name is charles", User: "charles" → CORRECT
- Expected: "charles", User: "it's charles" → CORRECT`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are a VERY FLEXIBLE AI judge. Be lenient with matching. Respond with JSON only." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 200
    });

    const response = completion.choices[0].message.content.trim();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      console.log(`[JUDGE] Expected: "${expectedAnswer}", Got: "${userAnswer}" → ${result.correct ? '✅' : '❌'} (${result.reason})`);
      return result;
    }
    return { correct: false, reason: "Failed to parse response" };
  } catch (error) {
    console.error('AI judge error:', error);
    return { correct: false, reason: "Error judging answer" };
  }
}

// Resolve token address
async function getTokenAddress(tokenSymbol) {
  const tokenUpper = tokenSymbol?.toUpperCase() || '';
  
  if (!tokenSymbol || tokenUpper === 'SOMI' || tokenUpper === 'STT') {
    return ethers.ZeroAddress;
  }

  if (IS_TESTNET) {
    if (!ZAZZ_TOKEN_ADDRESS || ZAZZ_TOKEN_ADDRESS === ethers.ZeroAddress) {
      console.warn('ZAZZ_TOKEN_ADDRESS not set - cannot resolve testnet token');
      return null;
    }
    return ZAZZ_TOKEN_ADDRESS;
  }

  try {
    const tokenInfo = await searchToken(tokenSymbol);
    return tokenInfo?.tokenAddress || null;
  } catch (error) {
    console.error('Token search error:', error);
    return null;
  }
}

// Convert USD amount to token amount
async function convertUSDToTokens(tokenSymbol, usdAmount) {
  const tokenUpper = tokenSymbol?.toUpperCase() || '';
  const nativeTokenSymbol = IS_TESTNET ? 'STT' : 'SOMI';
  
  if (tokenUpper === 'SOMI' || tokenUpper === 'STT' || tokenUpper === nativeTokenSymbol) {
    const tokenInfo = await searchToken(nativeTokenSymbol);
    if (!tokenInfo?.poolAddress) return null;
    const poolRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/somnia/pools/${tokenInfo.poolAddress}`);
    const poolData = await poolRes.json();
    const price = parseFloat(poolData?.data?.attributes?.base_token_price_usd || 0);
    if (price === 0) return null;
    return usdAmount / price;
  } else {
    const tokenInfo = await searchToken(tokenSymbol);
    if (!tokenInfo?.poolAddress) return null;
    const poolRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/somnia/pools/${tokenInfo.poolAddress}`);
    const poolData = await poolRes.json();
    const price = parseFloat(poolData?.data?.attributes?.base_token_price_usd || 0);
    if (price === 0) return null;
    return usdAmount / price;
  }
}

// Get wallet balance
async function getWalletBalance(walletAddress) {
  try {
    const balanceHex = await retryBlockchainCall(async () => {
      return await provider.send('eth_getBalance', [walletAddress, 'latest']);
    });
    const nativeBalance = BigInt(balanceHex);
    const sttBalance = ethers.formatEther(nativeBalance);

    let zazzBalance = '0';
    if (IS_TESTNET && ZAZZ_TOKEN_ADDRESS && ZAZZ_TOKEN_ADDRESS !== ethers.ZeroAddress) {
      const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
      const zazzContract = new ethers.Contract(ZAZZ_TOKEN_ADDRESS, ERC20_ABI, provider);
      const zazzBal = await retryBlockchainCall(async () => {
        return await zazzContract.balanceOf(walletAddress);
      });
      zazzBalance = ethers.formatEther(zazzBal);
    }

    return { stt: sttBalance, zazz: zazzBalance };
  } catch (error) {
    console.error('Balance fetch error:', error);
    return null;
  }
}

// Send registration bonus
async function sendRegistrationBonus(walletAddress) {
  if (!IS_TESTNET) return;
  
  if (!ZAZZ_TOKEN_ADDRESS || ZAZZ_TOKEN_ADDRESS === ethers.ZeroAddress) {
    console.warn('ZAZZ_TOKEN_ADDRESS not set - cannot send registration bonus');
    return;
  }

  if (!process.env.BOT_PRIVATE_KEY) {
    console.warn('BOT_PRIVATE_KEY not set - cannot send registration bonus');
    return;
  }

  try {
    const botWallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
    const zazzWithSigner = zazzContract.connect(botWallet);
    
    const tx = await retryBlockchainCall(async () => {
      const tx = await zazzWithSigner.mint(walletAddress, ZAZZ_MINT_AMOUNT);
      await tx.wait();
      return tx;
    });
    
    console.log(`✅ Registration bonus sent: 100k ZAZZ to ${walletAddress}`);
    return true;
  } catch (error) {
    console.error('Registration bonus error:', error);
    return false;
  }
}

// Handle /start
bot.onText(/\/(help|start)/, async (msg) => {
  const tgId = msg.from.id;
  const username = msg.from.username?.toLowerCase() || msg.from.first_name;

  try {
    await getOrCreateUser(tgId, username);
    
    const networkInfo = IS_TESTNET 
      ? `🧪 TESTNET MODE\n• Native: STT\n• All tokens use ZAZZ (mock token)\n• Register wallet = 100k ZAZZ bonus! 🎁\n• ZAZZ Token: ${ZAZZ_TOKEN_ADDRESS || 'NOT SET'}`
      : `🌐 MAINNET\n• Native: SOMI\n• Real token addresses`;
    
    const helpText = `Hey there! I'm Deeza — your crypto bro for peer-to-peer gifts on Somnia. 😎\n\n${networkInfo}\n\n📝 How it works:\n1. Gift crypto: "gift @john 10 USDC" or "gift $20 worth of NIA to @mike"\n2. Set proof: Tell me what they should prove (e.g., "his dog's name is Luna")\n3. They claim: Receiver says "claim [code]" and answers your question\n4. AI judges: I check if their answer matches!\n\n💡 Examples:\n• "gift @friend 5 ${NATIVE_TOKEN}"\n• "gift 3000 NIA to @alice"\n• "gift $100 JELLU to @bob"\n• Or use: "send", "give", "transfer" - I understand them all!\n\n⚙️ Commands:\n• /help or /start - Show this message\n• /cancel - Reset any active process\n• Or just say "cancel" anytime!\n\nThey claim by proving what you ask! 😉`;
    
    await bot.sendMessage(msg.chat.id, helpText);
  } catch (error) {
    console.error('Start error:', error);
  }
});

// Handle /cancel - Reset all state
bot.onText(/\/cancel/, async (msg) => {
  const tgId = msg.from.id;
  const username = msg.from.username?.toLowerCase() || msg.from.first_name;

  try {
    await getOrCreateUser(tgId, username);
    
    // Check if user has any active context
    const existingContext = await getContext(tgId);
    
    if (existingContext) {
      // Clear the context
      await clearContext(tgId);
      
      // Get context type for friendly message
      const contextMessages = {
        [CONTEXT_TYPES.REGISTER_WALLET]: 'wallet registration',
        [CONTEXT_TYPES.REGISTER_WALLET_CONFIRM]: 'wallet update confirmation',
        [CONTEXT_TYPES.SEND_GIFT_PROOF]: 'gift creation (proof setup)',
        [CONTEXT_TYPES.SEND_GIFT_PROOF_CONFIRM]: 'gift creation (proof confirmation)',
        [CONTEXT_TYPES.SEND_GIFT_MESSAGE]: 'gift creation (message)',
        [CONTEXT_TYPES.SEND_GIFT_CODE]: 'gift creation (custom code)',
        [CONTEXT_TYPES.SEND_GIFT_CONFIRM]: 'gift creation (final confirmation)',
        [CONTEXT_TYPES.CLAIM_GIFT]: 'gift claim'
      };
      
      const contextName = contextMessages[existingContext.context_type] || 'current process';
      
      await bot.sendMessage(msg.chat.id, `✅ Cancelled ${contextName}. All state reset! 😉\n\nWhat would you like to do now?`, { reply_to_message_id: msg.message_id });
    } else {
      await bot.sendMessage(msg.chat.id, `Nothing to cancel - you're all clear! 😉\n\nNeed help? Try /start`, { reply_to_message_id: msg.message_id });
    }
  } catch (error) {
    console.error('Cancel error:', error);
    await bot.sendMessage(msg.chat.id, 'Error cancelling. Please try again.');
  }
});

// Main message handler
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;
  if (!msg.text) return;

  const tgId = msg.from.id;
  const username = msg.from.username?.toLowerCase() || msg.from.first_name;

  try {
    await bot.sendChatAction(msg.chat.id, 'typing');
    const user = await getOrCreateUser(tgId, username);
    const existingContext = await getContext(tgId);
    
    console.log(`[MAIN] Message: "${msg.text}" | Context: ${existingContext ? existingContext.context_type : 'NONE'}`);

    // Handle "cancel" command in natural language (works in any context)
    const text = msg.text.toLowerCase().trim();
    if (text === 'cancel' || text === 'cancel this' || text === 'stop' || text === 'reset') {
      if (existingContext) {
        await clearContext(tgId);
        
        const contextMessages = {
          [CONTEXT_TYPES.REGISTER_WALLET]: 'wallet registration',
          [CONTEXT_TYPES.REGISTER_WALLET_CONFIRM]: 'wallet update confirmation',
          [CONTEXT_TYPES.SEND_GIFT_PROOF]: 'gift creation (proof setup)',
          [CONTEXT_TYPES.SEND_GIFT_PROOF_CONFIRM]: 'gift creation (proof confirmation)',
          [CONTEXT_TYPES.SEND_GIFT_MESSAGE]: 'gift creation (message)',
          [CONTEXT_TYPES.SEND_GIFT_CODE]: 'gift creation (custom code)',
          [CONTEXT_TYPES.SEND_GIFT_CONFIRM]: 'gift creation (final confirmation)',
          [CONTEXT_TYPES.CLAIM_GIFT]: 'gift claim'
        };
        
        const contextName = contextMessages[existingContext.context_type] || 'current process';
        
        await bot.sendMessage(msg.chat.id, `✅ Cancelled ${contextName}. All state reset! 😉\n\nWhat would you like to do now?`, { reply_to_message_id: msg.message_id });
        return;
      } else {
        await bot.sendMessage(msg.chat.id, `Nothing to cancel - you're all clear! 😉`, { reply_to_message_id: msg.message_id });
        return;
      }
    }

    // Handle wallet registration follow-ups
    if (existingContext && existingContext.context_type === CONTEXT_TYPES.REGISTER_WALLET) {
      const text = msg.text.trim();
      
      const isSendCommand = /^(send|transfer|give|gift)\s/i.test(text);
      const isClaimCommand = /^claim\s/i.test(text);
      const isOtherCommand = /^(show|balance|help|register)/i.test(text);
      
      if (isSendCommand || isClaimCommand || (isOtherCommand && !text.toLowerCase().includes('register'))) {
        await clearContext(tgId);
      } else {
        const addressMatch = text.match(/0x[a-fA-F0-9]{40}/);
        if (addressMatch) {
          const walletAddress = addressMatch[0];
          const { data: existingUser } = await supabase
            .from('deeza_users')
            .select('wallet_address')
            .eq('telegram_id', tgId)
            .single();
          
          const isNewRegistration = !existingUser?.wallet_address;
          
          if (!isNewRegistration && existingUser.wallet_address) {
            const oldAddress = existingUser.wallet_address;
            await saveContext(tgId, CONTEXT_TYPES.REGISTER_WALLET_CONFIRM, {
              newAddress: walletAddress,
              oldAddress: oldAddress
            });
            await bot.sendMessage(msg.chat.id, `⚠️ You already have a wallet registered:\n${oldAddress.substring(0, 10)}...${oldAddress.substring(38)}\n\nNew address: ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n\nDo you want to change it? (yes/no)`, { reply_to_message_id: msg.message_id });
            return;
          }
          
          const { error: upsertError } = await supabase.from('deeza_users').upsert({
            telegram_id: tgId,
            telegram_username: user.telegram_username || null,
            wallet_address: walletAddress
          }, { onConflict: 'telegram_id' });
          
          if (upsertError) {
            console.error('Registration upsert error:', upsertError);
            await bot.sendMessage(msg.chat.id, `⚠️ Error saving wallet address. Please try again.`, { reply_to_message_id: msg.message_id });
            return;
          }
          
          await clearContext(tgId);
          
          if (isNewRegistration && IS_TESTNET) {
            const bonusSent = await sendRegistrationBonus(walletAddress);
            if (bonusSent) {
              await bot.sendMessage(msg.chat.id, `✅ Wallet registered! ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n\n🎁 You received 100,000 ZAZZ tokens to play with! (Testnet only)`, { reply_to_message_id: msg.message_id });
            } else {
              await bot.sendMessage(msg.chat.id, `✅ Wallet registered! ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n\n⚠️ Bonus failed to send (check bot config)`, { reply_to_message_id: msg.message_id });
            }
          } else {
            await bot.sendMessage(msg.chat.id, `✅ Wallet registered! ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}`, { reply_to_message_id: msg.message_id });
          }
          return;
        } else {
          await bot.sendMessage(msg.chat.id, "Please provide a valid wallet address (starts with 0x followed by 40 characters), or say 'cancel' to stop. 😉", { reply_to_message_id: msg.message_id });
          return;
        }
      }
    }

    // Handle wallet change confirmation
    if (existingContext && existingContext.context_type === CONTEXT_TYPES.REGISTER_WALLET_CONFIRM) {
      const text = msg.text.toLowerCase().trim();
      const confirmWords = ['yes', 'yep', 'ok', 'okay', 'sure', 'confirm', 'go', 'change'];
      const cancelWords = ['no', 'cancel', 'abort', 'stop'];
      
      if (confirmWords.some(word => text.includes(word))) {
        const { newAddress, oldAddress } = existingContext.context_data;
        
        const { error: upsertError } = await supabase.from('deeza_users').upsert({
          telegram_id: tgId,
          telegram_username: user.telegram_username || null,
          wallet_address: newAddress
        }, { onConflict: 'telegram_id' });
        
        if (upsertError) {
          console.error('Wallet update error:', upsertError);
          await bot.sendMessage(msg.chat.id, `⚠️ Error updating wallet address. Please try again.`, { reply_to_message_id: msg.message_id });
          return;
        }
        
        await clearContext(tgId);
        await bot.sendMessage(msg.chat.id, `✅ Wallet address updated!\n\nOld: ${oldAddress.substring(0, 10)}...${oldAddress.substring(38)}\nNew: ${newAddress.substring(0, 10)}...${newAddress.substring(38)}`, { reply_to_message_id: msg.message_id });
        return;
      } else if (cancelWords.some(word => text.includes(word))) {
        await clearContext(tgId);
        await bot.sendMessage(msg.chat.id, "Cancelled. Wallet address not changed.", { reply_to_message_id: msg.message_id });
        return;
      } else {
        await bot.sendMessage(msg.chat.id, "Please confirm: say 'yes' to change or 'no' to cancel.", { reply_to_message_id: msg.message_id });
        return;
      }
    }

    // Handle proof setting follow-up
    if (existingContext && existingContext.context_type === CONTEXT_TYPES.SEND_GIFT_PROOF) {
      const proofText = msg.text.trim();
      if (proofText.length === 0) {
        await bot.sendMessage(msg.chat.id, "Please provide the proof they need to answer. 😉", { reply_to_message_id: msg.message_id });
        return;
      }
      
      const giftData = existingContext.context_data;
      
      // Single proof only
      const proofs = [proofText];
      
      // Generate code based on recipient username
      const baseCode = giftData.recipient.toLowerCase();
      const code = `${baseCode}${Math.floor(Math.random() * 100)}`;
      
      // Use AI to convert proof statement to a proper question with "you/your"
      console.log(`[GIFT_PROOF] Generating question from: "${proofText}"`);
      let question = proofText;
      let expectedAnswer = proofText;
      
      try {
        const aiPrompt = `Convert this proof statement into a direct question for the recipient (use "you/your"):

Proof: "${proofText}"

Examples:
"That his mother's name is patience" → Question: "What is your mother's name?" Answer: "patience"
"Their favorite color is red" → Question: "What is your favorite color?" Answer: "red"
"He was born in 1990" → Question: "What year were you born?" Answer: "1990"
"She lives in Lagos" → Question: "Where do you live?" Answer: "lagos"

Return ONLY JSON:
{"question": "...", "answer": "..."}`;

        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            { role: "system", content: "Convert proof statements to direct questions using 'you/your'. Return JSON only." },
            { role: "user", content: aiPrompt }
          ],
          temperature: 0.2,
          max_tokens: 100
        });

        const response = aiResponse.choices[0].message.content.trim();
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          question = parsed.question || proofText;
          expectedAnswer = parsed.answer?.toLowerCase() || proofText;
          console.log(`[GIFT_PROOF] Q: "${question}", A: "${expectedAnswer}"`);
        }
      } catch (error) {
        console.error('[GIFT_PROOF] AI error:', error);
      }
      
      // Store proof data temporarily (will add message later before uploading to IPFS)
      const giftId = ethers.id(code);
      const giftIdHex = ethers.hexlify(giftId);

      // Move to message collection (optional)
      console.log(`[GIFT_PROOF] Saving context as SEND_GIFT_MESSAGE...`);
      await saveContext(tgId, CONTEXT_TYPES.SEND_GIFT_MESSAGE, {
        ...giftData,
        code,
        giftId: giftIdHex,
        question,
        expectedAnswer,
        proofs: proofs
      });
      console.log(`[GIFT_PROOF] Context saved successfully as SEND_GIFT_MESSAGE`);

      // Ask if they want to add a message
      await bot.sendMessage(msg.chat.id, `Great! 😉 Would you like to add a personal message to this gift? (optional)\n\nYou can say:\n• A message like "Happy birthday!" or "Thanks for everything"\n• Or just say "skip" or "no" to continue without a message`, { reply_to_message_id: msg.message_id });
      return;
    }

    // Handle message collection (optional)
    if (existingContext && existingContext.context_type === CONTEXT_TYPES.SEND_GIFT_MESSAGE) {
      const messageText = msg.text.trim().toLowerCase();
      const isSkip = messageText === 'skip' || messageText === 'no' || messageText === 'n' || messageText === 'none' || messageText === '';
      
      const giftData = existingContext.context_data;
      const message = isSkip ? null : msg.text.trim();
      
      // Now upload everything to IPFS
      const ipfsData = {
        question: giftData.question,
        answer: giftData.expectedAnswer,
        proofs: giftData.proofs,
        gifter: user.telegram_username,
        recipient: giftData.recipient,
        message: message || null
      };
      
      console.log(`[GIFT_MESSAGE] Uploading to IPFS with message: ${message ? 'yes' : 'no'}...`);
      let ipfsLink = '';
      try {
        ipfsLink = await uploadToIPFS(ipfsData);
        console.log(`[GIFT_MESSAGE] IPFS upload success: ${ipfsLink}`);
      } catch (error) {
        console.error('[GIFT_MESSAGE] IPFS upload error:', error);
        await bot.sendMessage(msg.chat.id, `⚠️ Error uploading gift data: ${error.message}`, { reply_to_message_id: msg.message_id });
        await clearContext(tgId);
        return;
      }

      // Move to confirmation
      await saveContext(tgId, CONTEXT_TYPES.SEND_GIFT_CONFIRM, {
        ...giftData,
        ipfsLink,
        message: message
      });

      // Build comprehensive confirmation message
      const displayTokenName = giftData.token.toUpperCase() === 'SOMI' || giftData.token.toUpperCase() === 'STT' ? NATIVE_TOKEN : giftData.token.toUpperCase();
      
      // Format recipient info (show address if provided, or username)
      let recipientInfo = `@${giftData.recipient}`;
      if (giftData.recipientWallet) {
        // Check if it's just a pasted address (not from username lookup)
        const recipientUser = await getUserByUsername(giftData.recipient);
        if (!recipientUser || !recipientUser.wallet_address) {
          // Address was pasted directly
          recipientInfo = `${giftData.recipientWallet.substring(0, 10)}...${giftData.recipientWallet.substring(38)}`;
        } else {
          // Address from registered user
          recipientInfo = `@${giftData.recipient}\n📍 ${giftData.recipientWallet.substring(0, 10)}...${giftData.recipientWallet.substring(38)}`;
        }
      }
      
      const testnetNote = IS_TESTNET ? '\n\n🧪 Testnet: All ERC20 tokens use ZAZZ mock token' : '';
      // Escape HTML special characters in the message
      const escapedMessage = message ? message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;') : '';
      const messageNote = message ? `\n💬 <b>Message:</b> ${escapedMessage}` : '';
      
      // Escape HTML special characters in the question
      const escapedQuestion = giftData.question
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      
      const confirmationMsg = `🎁 <b>Gift Summary</b>

<b>Recipient:</b> ${recipientInfo.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
<b>Amount:</b> ${giftData.amount} ${displayTokenName}
<b>Proof Required:</b> ${escapedQuestion}
<b>Gift Code:</b> <code>${giftData.code}</code>${messageNote}${testnetNote}

Shall I create this gift? (yes/no)`;
      
      await bot.sendMessage(msg.chat.id, confirmationMsg, { reply_to_message_id: msg.message_id, parse_mode: 'HTML' });
      return;
    }


    // Handle gift confirmation
    if (existingContext && existingContext.context_type === CONTEXT_TYPES.SEND_GIFT_CONFIRM) {
      const text = msg.text.toLowerCase().trim();
      let shouldCreateGift = false;
      
      // Use AI to judge if it's a confirmation or cancellation
      const confirmPrompt = `Is this a confirmation or cancellation?
      
User said: "${msg.text}"

Respond with ONLY JSON:
{
  "isConfirm": true/false,
  "isCancel": true/false
}

A confirmation means: yes, sure, okay, ok, go ahead, create it, proceed, do it, let's go, yep, yeah, confirm, etc.
A cancellation means: no, cancel, abort, stop, don't, nah, nope, nevermind, etc.
Be flexible - understand natural language variations.`;

      try {
        const confirmCompletion = await openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            { role: "system", content: "You judge if user messages are confirmations or cancellations. Respond with JSON only." },
            { role: "user", content: confirmPrompt }
          ],
          temperature: 0.2,
          max_tokens: 100
        });

        const confirmResponse = confirmCompletion.choices[0].message.content.trim();
        const confirmJsonMatch = confirmResponse.match(/\{[\s\S]*\}/);
        
        if (confirmJsonMatch) {
          const confirmResult = JSON.parse(confirmJsonMatch[0]);
          
          if (confirmResult.isCancel) {
            await clearContext(tgId);
            await bot.sendMessage(msg.chat.id, "❌ Gift creation cancelled. No worries! 😉", { reply_to_message_id: msg.message_id });
            return;
          }
          
          if (confirmResult.isConfirm) {
            shouldCreateGift = true;
          }
        }
      } catch (confirmError) {
        console.error('Confirmation AI error:', confirmError);
      }
      
      // Fallback to simple check if AI fails or wasn't used
      if (!shouldCreateGift) {
        const confirmWords = ['yes', 'yep', 'ok', 'okay', 'sure', 'confirm', 'go', 'create', 'proceed', 'do it', 'yeah', 'alright', 'fine', 'sounds good'];
        const cancelWords = ['no', 'nah', 'cancel', 'abort', 'stop', 'dont', 'nope', 'nevermind'];
        
        if (cancelWords.some(word => text === word || text.startsWith(word))) {
          await clearContext(tgId);
          await bot.sendMessage(msg.chat.id, "❌ Gift creation cancelled. No worries! 😉", { reply_to_message_id: msg.message_id });
          return;
        }
        
        if (confirmWords.some(word => text === word || text.includes(word))) {
          shouldCreateGift = true;
        }
      }
      
      if (shouldCreateGift) {
        const giftData = existingContext.context_data;
        
        // Create gift on contract ONLY (no Supabase!)
        if (contract && process.env.BOT_PRIVATE_KEY) {
          try {
            const giftId = ethers.id(giftData.code);
            const botWallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
            const contractWithSigner = contract.connect(botWallet);
            
            // Parse amount to wei (18 decimals)
            const amountInWei = ethers.parseUnits(giftData.amount.toString(), 18);
            const tokenAddress = giftData.tokenAddress || ethers.ZeroAddress;
            const recipientAddress = giftData.recipientWallet;
            
            if (!recipientAddress) {
              await bot.sendMessage(msg.chat.id, `⚠️ Recipient @${giftData.recipient} doesn't have a registered wallet!\n\nThey need to register first with: "register me"`, { reply_to_message_id: msg.message_id });
              await clearContext(tgId);
              return;
            }
            
            console.log(`[GIFT_CREATE] Creating gift on contract: ${giftData.code}`);
            console.log(`[GIFT_CREATE] Recipient: ${recipientAddress}`);
            console.log(`[GIFT_CREATE] Token: ${tokenAddress}, Amount: ${amountInWei.toString()}`);
            
            // Use retry helper for blockchain calls
            const tx = await retryBlockchainCall(async () => {
              const tx = await contractWithSigner.createGift(
                giftId, 
                giftData.code, 
                giftData.ipfsLink,
                recipientAddress,
                tokenAddress,
                amountInWei
              );
              await tx.wait();
              return tx;
            });
            
            console.log(`[GIFT_CREATE] ✅ Gift created on contract! Tx: ${tx.hash}`);
          } catch (error) {
            console.error('Contract create error:', error);
            await bot.sendMessage(msg.chat.id, `⚠️ RPC timeout - Somnia network is slow right now.\n\nYour gift data is saved! Try again in a moment with: "yes"`, { reply_to_message_id: msg.message_id });
            // DON'T clear context - let them retry!
            return;
          }
        } else {
          await bot.sendMessage(msg.chat.id, `⚠️ Contract not deployed or bot key missing!`, { reply_to_message_id: msg.message_id });
          await clearContext(tgId);
          return;
        }
        
        await clearContext(tgId);
        
        // Send notification to recipient
        const recipient = await getUserByUsername(giftData.recipient);
        if (recipient && recipient.telegram_id) {
          try {
            const displayTokenName = giftData.token.toUpperCase() === 'SOMI' || giftData.token.toUpperCase() === 'STT' ? NATIVE_TOKEN : giftData.token.toUpperCase();
            await bot.sendMessage(
              recipient.telegram_id, 
              `🎁 <b>You received a gift from @${user.telegram_username}!</b>\n\n💰 Amount: ${giftData.amount} ${displayTokenName}\n🔐 Code: <code>${giftData.code}</code>\n\nTo claim it, say: "claim ${giftData.code}" 😉`,
              { parse_mode: 'HTML' }
            );
            console.log(`[GIFT_CREATE] ✅ Recipient @${giftData.recipient} notified`);
          } catch (e) {
            console.error('Recipient notification error:', e);
          }
        }
        
        const displayTokenName = giftData.token.toUpperCase() === 'SOMI' || giftData.token.toUpperCase() === 'STT' ? NATIVE_TOKEN : giftData.token.toUpperCase();
        
        const tokenDisplay = giftData.tokenAddress === ethers.ZeroAddress ? 'NATIVE token (STT/SOMI)' : giftData.tokenAddress;
        const depositUrl = `${WALLET_CONNECT_URL}/deposit`;
        
        await bot.sendMessage(msg.chat.id, `✅ <b>Gift Created Successfully!</b>

📦 <b>Deposit your ${displayTokenName} here:</b>
${depositUrl}

🎁 <b>Gift Code:</b> <code>${giftData.code}</code>
💰 <b>Amount:</b> ${giftData.amount} ${displayTokenName}
👤 <b>Recipient:</b> @${giftData.recipient}
📍 <b>Token:</b> ${tokenDisplay}

${recipient && recipient.telegram_id ? '✉️ Recipient has been notified!' : '⚠️ Recipient is not registered - share the code with them!'}

<b>Next Step:</b> Paste your code on the deposit page to send the funds!`, { reply_to_message_id: msg.message_id, parse_mode: 'HTML' });
        return;
      } else {
        await bot.sendMessage(msg.chat.id, "I didn't catch that. Say **'yes'** to create the gift or **'no'** to cancel. 😉", { reply_to_message_id: msg.message_id, parse_mode: 'Markdown' });
        return;
      }
    }

    // Handle balance check
    if ((msg.text.toLowerCase().includes('balance') || msg.text.toLowerCase().includes('wallet balance')) && !existingContext) {
      if (!user.wallet_address) {
        await bot.sendMessage(msg.chat.id, "You need to register your wallet first! Say \"register me\" 😉", { reply_to_message_id: msg.message_id });
        return;
      }

      const balances = await getWalletBalance(user.wallet_address);
      if (balances) {
        const balanceText = IS_TESTNET 
          ? `💰 Your Wallet Balance\n\n💎 STT: ${parseFloat(balances.stt).toFixed(6)} STT\n🎁 ZAZZ: ${parseFloat(balances.zazz).toFixed(2)} ZAZZ\n\n📍 Address: ${user.wallet_address.substring(0, 10)}...${user.wallet_address.substring(38)}`
          : `💰 Your Wallet Balance\n\n💎 ${NATIVE_TOKEN}: ${parseFloat(balances.stt).toFixed(6)} ${NATIVE_TOKEN}\n\n📍 Address: ${user.wallet_address.substring(0, 10)}...${user.wallet_address.substring(38)}`;
        await bot.sendMessage(msg.chat.id, balanceText, { reply_to_message_id: msg.message_id });
        return;
      }
    }

    // Handle ZAZZ address request
    if ((msg.text.toLowerCase().includes('zazz') && (msg.text.toLowerCase().includes('address') || msg.text.toLowerCase().includes('token'))) && !existingContext) {
      if (IS_TESTNET && ZAZZ_TOKEN_ADDRESS && ZAZZ_TOKEN_ADDRESS !== ethers.ZeroAddress) {
        await bot.sendMessage(msg.chat.id, `🎁 ZAZZ Token Address:\n${ZAZZ_TOKEN_ADDRESS}`, { reply_to_message_id: msg.message_id });
        return;
      }
    }

    // Handle claim answer FIRST (before AI processing)
    // Re-check context for claim answers
    const currentContext = await getContext(tgId);
    if (currentContext && currentContext.context_type === CONTEXT_TYPES.CLAIM_GIFT) {
      const userAnswer = msg.text;
      const claimData = currentContext.context_data;
      
      // Check for cancel/exit commands
      const textLower = userAnswer.toLowerCase().trim();
      if (textLower === 'cancel' || textLower === 'cancel this' || textLower === 'stop' || textLower === 'reset') {
        await clearContext(tgId);
        await bot.sendMessage(msg.chat.id, `✅ Cancelled gift claim. All state reset! 😉\n\nWhat would you like to do now?`, { reply_to_message_id: msg.message_id });
        return;
      }
      
      console.log(`[CLAIM_ANSWER] Processing answer: "${userAnswer}" for code: ${claimData?.code || 'unknown'}`);
      console.log(`[CLAIM_ANSWER] Expected answers:`, claimData?.expectedAnswers || [claimData?.expectedAnswer]);
      
      const expectedAnswers = claimData?.expectedAnswers || (claimData?.expectedAnswer ? [claimData.expectedAnswer] : []).filter(Boolean);
      
      if (!expectedAnswers || expectedAnswers.length === 0) {
        await clearContext(tgId);
        await bot.sendMessage(msg.chat.id, `⚠️ Error: No expected answers found. Please try claiming again.`, { reply_to_message_id: msg.message_id });
        return;
      }
      
      let judgment = { correct: false, reason: "No match" };
      
      console.log(`[CLAIM_ANSWER] Checking against ${expectedAnswers.length} expected answer(s)...`);
      for (const expected of expectedAnswers) {
        const testJudgment = await judgeAnswer(userAnswer, expected);
        console.log(`[CLAIM_ANSWER] Judgment result:`, testJudgment);
        if (testJudgment.correct) {
          judgment = testJudgment;
          break;
        }
      }
      
      console.log(`[CLAIM_ANSWER] Final judgment:`, judgment);
      
      if (judgment.correct) {
        let recipientWallet = claimData.recipientWallet;
        if (!recipientWallet) {
          const { data: giftRecord } = await supabase
            .from('deeza_gifts')
            .select('recipient_wallet')
            .eq('code', claimData.code)
            .single();
          recipientWallet = giftRecord?.recipient_wallet || user.wallet_address;
        }

        if (!recipientWallet) {
          await clearContext(tgId);
          await bot.sendMessage(msg.chat.id, `⚠️ Error: Recipient wallet not found. Contact support.`, { reply_to_message_id: msg.message_id });
          return;
        }

        if (user.wallet_address && recipientWallet.toLowerCase() !== user.wallet_address.toLowerCase()) {
          await bot.sendMessage(msg.chat.id, `⚠️ This gift is for a different wallet address. You're claiming from ${user.wallet_address.substring(0, 10)}... but gift is for ${recipientWallet.substring(0, 10)}...`, { reply_to_message_id: msg.message_id });
          await clearContext(tgId);
          return;
        }

        if (contract) {
          try {
            const botWallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
            const contractWithSigner = contract.connect(botWallet);
            
            console.log(`[CLAIM] Releasing gift ${claimData.code}`);
            
            // Check if gift is already claimed before attempting release
            const giftCheck = await retryBlockchainCall(async () => {
              return await contract.getGift(claimData.giftId);
            });
            
            if (giftCheck.claimed) {
              await clearContext(tgId);
              await bot.sendMessage(msg.chat.id, `⚠️ This gift has already been claimed! Someone beat you to it. 😅`, { reply_to_message_id: msg.message_id });
              return;
            }
            
            // Use 4 attempts for release (more critical operation)
            const tx = await retryBlockchainCall(async () => {
              const tx = await contractWithSigner.release(claimData.giftId);
              await tx.wait();
              return tx;
            }, 4, 3000);
            
            console.log(`[CLAIM] ✅ Gift released! Tx: ${tx.hash}`);
            
            // Get gift details for display
            const giftDetails = await retryBlockchainCall(async () => {
              return await contract.getGift(claimData.giftId);
            });
            
            // Format amount and token name
            const amount = ethers.formatEther(giftDetails.amount);
            const isNative = giftDetails.token === ethers.ZeroAddress;
            const tokenName = isNative ? NATIVE_TOKEN : (IS_TESTNET ? 'ZAZZ' : 'TOKEN');
            
            // Build explorer link
            const explorerUrl = IS_TESTNET 
              ? `https://shannon-explorer.somnia.network/tx/${tx.hash}`
              : `https://explorer.somnia.network/tx/${tx.hash}`;
            
            // Fetch message from IPFS and enhance with AI
            let enhancedMessage = null;
            try {
              const ipfsData = await fetchFromIPFS(giftDetails.ipfsLink);
              if (ipfsData.message && ipfsData.message.trim()) {
                // Use AI to enhance the message
                try {
                  const enhancePrompt = `Enhance this gift message to make it more warm, personal, and heartfelt. Keep the original meaning but make it sound more special and memorable. Don't add quotes unless the original has quotes.

Original message: "${ipfsData.message}"

Return ONLY the enhanced message, nothing else. Keep it natural and authentic.`;
                  
                  const enhanceResponse = await openai.chat.completions.create({
                    model: "gpt-4",
                    messages: [
                      { role: "system", content: "You enhance gift messages to be warmer and more heartfelt while keeping the original meaning. Return only the enhanced message." },
                      { role: "user", content: enhancePrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 150
                  });
                  
                  enhancedMessage = enhanceResponse.choices[0].message.content.trim();
                  // Remove quotes if AI wrapped it
                  if (enhancedMessage.startsWith('"') && enhancedMessage.endsWith('"')) {
                    enhancedMessage = enhancedMessage.slice(1, -1);
                  }
                } catch (aiError) {
                  console.error('[MESSAGE_ENHANCE] AI error:', aiError);
                  enhancedMessage = ipfsData.message; // Fallback to original
                }
              }
            } catch (ipfsError) {
              console.error('[MESSAGE_FETCH] Error fetching message:', ipfsError);
            }
            
            // Build success message
            let successMsg = `🎉 **BOOM! Correct answer!** Gift claimed successfully! 🚀\n\n💰 **You received:** ${amount} ${tokenName}\n\n🔗 [View Transaction](${explorerUrl})`;
            
            if (enhancedMessage) {
              successMsg += `\n\n💬 **Message from the gifter:**\n"${enhancedMessage}"`;
            }
            
            await clearContext(tgId);
            await bot.sendMessage(msg.chat.id, successMsg, { reply_to_message_id: msg.message_id, parse_mode: 'Markdown' });
          } catch (error) {
            console.error('Release error:', error);
            
            // Check if gift is locked out
            if (error.reason === 'Locked' || error.message?.includes('Locked')) {
              await clearContext(tgId);
              await bot.sendMessage(msg.chat.id, `🔒 Oops! You're still locked out from wrong answers. Wait a bit and try again later! 😉`, { reply_to_message_id: msg.message_id });
            } else if (error.reason === 'Only bot' || error.message?.includes('Only bot')) {
              await clearContext(tgId);
              await bot.sendMessage(msg.chat.id, `⚠️ Bot configuration error. Contact support.`, { reply_to_message_id: msg.message_id });
            } else {
              await bot.sendMessage(msg.chat.id, `😕 Error releasing gift: ${error.message || error.reason || 'Unknown error'}. Try again in a moment!`, { reply_to_message_id: msg.message_id });
            }
          }
        } else {
          await clearContext(tgId);
          await bot.sendMessage(msg.chat.id, `✅ Correct! (Contract not deployed yet)`, { reply_to_message_id: msg.message_id });
        }
      } else {
        let attempts = (claimData.attempts || 0) + 1;
        
        if (attempts >= 3) {
          if (contract) {
            try {
              const botWallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
              const contractWithSigner = contract.connect(botWallet);
              
              await retryBlockchainCall(async () => {
                const tx = await contractWithSigner.extendClaimTime(claimData.giftId, 30);
                await tx.wait();
                return tx;
              });
            } catch (e) {
              console.error('Extend error:', e);
            }
          }
          
          await clearContext(tgId);
          await bot.sendMessage(msg.chat.id, `😅 Oops! Wrong answer 3 times. Locked for 30 minutes - give it another shot later! 😉`, { reply_to_message_id: msg.message_id });
        } else {
          await saveContext(tgId, CONTEXT_TYPES.CLAIM_GIFT, {
            ...claimData,
            attempts
          });
          
          const attemptsLeft = 3 - attempts;
          const friendlyMessages = [
            `😏 Nice try! But nope, that's not quite right. ${attemptsLeft} more attempt${attemptsLeft > 1 ? 's' : ''} left - you got this! 💪`,
            `🤔 Hmm, not quite right! ${attemptsLeft} more attempt${attemptsLeft > 1 ? 's' : ''} remaining. Think harder! 🧠`,
            `😄 Almost there but not quite! ${attemptsLeft} more attempt${attemptsLeft > 1 ? 's' : ''} left. Keep going! 🚀`
          ];
          const randomMsg = friendlyMessages[Math.floor(Math.random() * friendlyMessages.length)];
          await bot.sendMessage(msg.chat.id, randomMsg, { reply_to_message_id: msg.message_id });
        }
      }
      return;
    }

    // If we have other context, we've already handled it above
    if (currentContext && currentContext.context_type !== CONTEXT_TYPES.CLAIM_GIFT) {
      return;
    }

    // Process with AI only if not in CLAIM_GIFT context
    var aiResponse = await processWithAI(msg.text, currentContext);

      // Emoji reaction
      try { await bot.setMessageReaction(msg.chat.id, msg.message_id, { reaction: [{ type: 'emoji', emoji: '😁' }] }); } catch {}

      // Handle actions
      const actionLower = (aiResponse.action || '').toLowerCase();
    
    if (actionLower === 'register_wallet' || (aiResponse.action === 'chat' && msg.text.toLowerCase().includes('register'))) {
      const addressMatch = msg.text.match(/0x[a-fA-F0-9]{40}/);
      if (addressMatch) {
        const walletAddress = addressMatch[0];
        const { data: existingUser } = await supabase
          .from('deeza_users')
          .select('wallet_address')
          .eq('telegram_id', tgId)
          .single();
        
        const isNewRegistration = !existingUser?.wallet_address;
        
        if (!isNewRegistration && existingUser.wallet_address) {
          const oldAddress = existingUser.wallet_address;
          await saveContext(tgId, CONTEXT_TYPES.REGISTER_WALLET_CONFIRM, {
            newAddress: walletAddress,
            oldAddress: oldAddress
          });
          await bot.sendMessage(msg.chat.id, `⚠️ You already have a wallet registered:\n${oldAddress.substring(0, 10)}...${oldAddress.substring(38)}\n\nNew address: ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n\nDo you want to change it? (yes/no)`, { reply_to_message_id: msg.message_id });
          return;
        }
        
        const { error: upsertError } = await supabase.from('deeza_users').upsert({
          telegram_id: tgId,
          telegram_username: user.telegram_username || null,
          wallet_address: walletAddress
        }, { onConflict: 'telegram_id' });
        
        if (upsertError) {
          console.error('Registration upsert error:', upsertError);
          await bot.sendMessage(msg.chat.id, `⚠️ Error saving wallet address. Please try again.`, { reply_to_message_id: msg.message_id });
          return;
        }
        
        if (isNewRegistration && IS_TESTNET) {
          const bonusSent = await sendRegistrationBonus(walletAddress);
          if (bonusSent) {
            await bot.sendMessage(msg.chat.id, `✅ Wallet registered! ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n\n🎁 You received 100,000 ZAZZ tokens to play with! (Testnet only)`, { reply_to_message_id: msg.message_id });
          } else {
            await bot.sendMessage(msg.chat.id, `✅ Wallet registered! ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}\n\n⚠️ Bonus failed to send (check bot config)`, { reply_to_message_id: msg.message_id });
          }
        } else {
          await bot.sendMessage(msg.chat.id, `✅ Wallet registered! ${walletAddress.substring(0, 10)}...${walletAddress.substring(38)}`, { reply_to_message_id: msg.message_id });
        }
        return;
      }
      
      await saveContext(tgId, CONTEXT_TYPES.REGISTER_WALLET, {});
      await bot.sendMessage(msg.chat.id, "Okay cool, what's your wallet address? 😉", { reply_to_message_id: msg.message_id });
      return;
    }

    if (aiResponse.action === 'send_gift') {
      const params = aiResponse.params;
      const recipient = params.recipient?.replace('@', '');
      
      // STEP 1: Check sender is registered FIRST
      if (!user.wallet_address) {
        await bot.sendMessage(msg.chat.id, `⚠️ You need to register your wallet first!\n\nSay "register me" and provide your wallet address. 😉`, { reply_to_message_id: msg.message_id });
        return;
      }

      // STEP 2: Validate recipient
      if (!recipient) {
        await bot.sendMessage(msg.chat.id, "I need a recipient! Try: \"gift @john 10 USDC\" 😉", { reply_to_message_id: msg.message_id });
        return;
      }

      // STEP 3: Check if recipient is registered
      let recipientWallet = null;
      const recipientUser = await getUserByUsername(recipient);
      if (recipientUser && recipientUser.wallet_address) {
        recipientWallet = recipientUser.wallet_address;
      } else {
        const addressMatch = msg.text.match(/0x[a-fA-F0-9]{40}/);
        if (addressMatch) {
          recipientWallet = addressMatch[0];
        } else {
          await bot.sendMessage(msg.chat.id, `⚠️ @${recipient} is not registered yet!\n\nThey need to register by saying "register me", OR you can provide their wallet address: "gift @${recipient} 5 USDC 0x..."`, { reply_to_message_id: msg.message_id });
          return;
        }
      }

      // STEP 4: Handle amounts and tokens
      let amount = params.amount || 0;
      let token = params.token || 'USDC';
      let tokenAddress = null;

      if (params.amount_usd) {
        if (token.toUpperCase() === 'ZAZZ') {
          amount = params.amount_usd;
        } else {
          const tokenAmount = await convertUSDToTokens(token, params.amount_usd);
          if (!tokenAmount) {
            await bot.sendMessage(msg.chat.id, `Couldn't get price for ${token}. Try again.`, { reply_to_message_id: msg.message_id });
            return;
          }
          amount = tokenAmount;
        }
      }

      if (amount <= 0) {
        await bot.sendMessage(msg.chat.id, "I need an amount! Try: \"gift @john 10 USDC\" 😉", { reply_to_message_id: msg.message_id });
        return;
      }

      if (token.toUpperCase() !== 'SOMI' && token.toUpperCase() !== 'STT') {
        tokenAddress = await getTokenAddress(token);
        if (!tokenAddress) {
          await bot.sendMessage(msg.chat.id, `Couldn't find token ${token}. Make sure the symbol is correct.`, { reply_to_message_id: msg.message_id });
          return;
        }
      }

      // STEP 5: Save context and ask for proof
      await saveContext(tgId, CONTEXT_TYPES.SEND_GIFT_PROOF, {
        recipient,
        recipientWallet,
        recipientTelegramId: recipientUser?.telegram_id || null,
        amount,
        token,
        tokenAddress
      });

      await bot.sendMessage(msg.chat.id, `What should @${recipient} prove?`, { reply_to_message_id: msg.message_id });
      return;
    }

    if (aiResponse.action === 'claim_gift') {
      const code = aiResponse.params?.code;
      if (!code) {
        await bot.sendMessage(msg.chat.id, "I need a gift code! Try: \"claim john42\" 😉", { reply_to_message_id: msg.message_id });
        return;
      }

      if (!user.wallet_address) {
        await bot.sendMessage(msg.chat.id, `⚠️ You need to register your wallet first!\n\nSay "register me" and provide your wallet address. 😉`, { reply_to_message_id: msg.message_id });
        return;
      }

      // Get gift from CONTRACT ONLY
      if (!contract) {
        await bot.sendMessage(msg.chat.id, "⚠️ Contract not deployed yet!", { reply_to_message_id: msg.message_id });
        return;
      }

      try {
        const giftId = ethers.id(code);
        
        // Check if gift exists and is claimable with retry
        const gift = await retryBlockchainCall(async () => {
          return await contract.getGift(giftId);
        });
        
        // Check if gift exists
        if (gift.gifter === ethers.ZeroAddress && !gift.deposited) {
          await bot.sendMessage(msg.chat.id, "🤔 Gift not found. Double-check that code - maybe a typo? 😉", { reply_to_message_id: msg.message_id });
          return;
        }

        // Check if already claimed FIRST
        if (gift.claimed) {
          await bot.sendMessage(msg.chat.id, "🎁 This gift has already been claimed! Someone beat you to it. 😅", { reply_to_message_id: msg.message_id });
          return;
        }

        if (!gift.deposited) {
          await bot.sendMessage(msg.chat.id, "⏳ Gift not deposited yet. Wait for the gifter to deposit the funds first! 😉", { reply_to_message_id: msg.message_id });
          return;
        }

        // Check if locked out (claimDeadline > 0 and current block time < claimDeadline)
        if (gift.claimDeadline > 0n) {
          const currentBlockTime = await retryBlockchainCall(async () => {
            const block = await provider.getBlock('latest');
            return BigInt(block.timestamp);
          });
          
          if (currentBlockTime < gift.claimDeadline) {
            const lockoutSeconds = Number(gift.claimDeadline - currentBlockTime);
            const lockoutMinutes = Math.ceil(lockoutSeconds / 60);
            await bot.sendMessage(msg.chat.id, `🔒 You're locked out from wrong answers! Wait ${lockoutMinutes} more minute${lockoutMinutes !== 1 ? 's' : ''} before trying again. 😉`, { reply_to_message_id: msg.message_id });
            return;
          }
        }

        // Fetch Q&A from IPFS
        const ipfsData = await fetchFromIPFS(gift.ipfsLink);
        
        const expectedAnswers = Array.isArray(ipfsData.proofs) 
          ? ipfsData.proofs 
          : (Array.isArray(ipfsData.answer) ? ipfsData.answer : [ipfsData.answer || ''].filter(Boolean));
        const question = ipfsData.question || "What's the proof?";
        
        await saveContext(tgId, CONTEXT_TYPES.CLAIM_GIFT, {
          giftId: giftId,
          code,
          expectedAnswers: expectedAnswers,
          expectedAnswer: expectedAnswers[0],
          question: question,
          attempts: Number(gift.attempts),
          tokenAddress: gift.token,
          amount: gift.amount.toString(),
          recipientWallet: user.wallet_address
        });

        // Friendly claim prompt
        await bot.sendMessage(msg.chat.id, `Alright mate! 😉 To claim this gift, you'll need to answer a question. Here we go:\n\n**${question}**`, { reply_to_message_id: msg.message_id, parse_mode: 'Markdown' });
      } catch (error) {
        console.error('Contract fetch error:', error);
        await bot.sendMessage(msg.chat.id, "😕 Error fetching gift details. The network might be slow - try again in a moment! 😉", { reply_to_message_id: msg.message_id });
      }
      return;
    }

    if (aiResponse.action === 'show_gifts') {
      if (!user.wallet_address) {
        await bot.sendMessage(msg.chat.id, "⚠️ You need to register your wallet first!\n\nSay \"register me\" and provide your wallet address. 😉", { reply_to_message_id: msg.message_id });
        return;
      }

      if (!contract) {
        await bot.sendMessage(msg.chat.id, "⚠️ Contract not deployed yet!", { reply_to_message_id: msg.message_id });
        return;
      }

      const giftType = aiResponse.params?.type || 'all';
      const userAddress = user.wallet_address;

      try {
        // Use new contract functions to query gifts by address (no event queries needed!)
        const [sentGiftsData, receivedGiftsData] = await Promise.all([
          retryBlockchainCall(async () => {
            return await contract.getGiftsByGifter(userAddress);
          }),
          retryBlockchainCall(async () => {
            return await contract.getGiftsByRecipient(userAddress);
          })
        ]);

        // Process gifts sent (where user is gifter)
        const sentGifts = sentGiftsData.map(gift => ({
          code: gift.code,
          recipient: gift.recipient,
          token: gift.token,
          amount: gift.amount,
          deposited: gift.deposited,
          claimed: gift.claimed
        }));

        // Process gifts received (where user is recipient)
        const receivedGifts = receivedGiftsData.map(gift => ({
          code: gift.code,
          gifter: gift.gifter,
          token: gift.token,
          amount: gift.amount,
          deposited: gift.deposited,
          claimed: gift.claimed
        }));

        // Format response based on type
        let response = '';
        const explorerBase = IS_TESTNET ? 'https://shannon-explorer.somnia.network' : 'https://explorer.somnia.network';

        if (giftType === 'sent' || giftType === 'all') {
          if (sentGifts.length === 0) {
            response += `📤 **Gifts Sent:** None yet 😔\n\n`;
          } else {
            response += `📤 **Gifts Sent:** ${sentGifts.length}\n`;
            sentGifts.forEach((g, i) => {
              const amount = ethers.formatEther(g.amount);
              const tokenName = g.token === ethers.ZeroAddress ? NATIVE_TOKEN : (IS_TESTNET ? 'ZAZZ' : 'TOKEN');
              const status = g.claimed ? '✅ Claimed' : (g.deposited ? '⏳ Pending' : '❌ Not Deposited');
              response += `${i + 1}. Code: \`${g.code}\` - ${amount} ${tokenName} - ${status}\n`;
            });
            response += '\n';
          }
        }

        if (giftType === 'pending' || giftType === 'active') {
          const pendingGifts = receivedGifts.filter(g => g.deposited && !g.claimed);
          if (pendingGifts.length === 0) {
            response += `⏳ **Pending Gifts:** None 😔\n\n`;
          } else {
            response += `⏳ **Pending Gifts:** ${pendingGifts.length}\n`;
            pendingGifts.forEach((g, i) => {
              const amount = ethers.formatEther(g.amount);
              const tokenName = g.token === ethers.ZeroAddress ? NATIVE_TOKEN : (IS_TESTNET ? 'ZAZZ' : 'TOKEN');
              response += `${i + 1}. Code: \`${g.code}\` - ${amount} ${tokenName}\n`;
              response += `   Say "claim ${g.code}" to claim it! 😉\n`;
            });
            response += '\n';
          }
        }

        if (giftType === 'received' || giftType === 'all') {
          if (receivedGifts.length === 0) {
            response += `📥 **Gifts Received:** None yet 😔\n\n`;
          } else {
            const claimedCount = receivedGifts.filter(g => g.claimed).length;
            response += `📥 **Gifts Received:** ${receivedGifts.length} (${claimedCount} claimed)\n`;
            receivedGifts.slice(0, 10).forEach((g, i) => {
              const amount = ethers.formatEther(g.amount);
              const tokenName = g.token === ethers.ZeroAddress ? NATIVE_TOKEN : (IS_TESTNET ? 'ZAZZ' : 'TOKEN');
              const status = g.claimed ? '✅ Claimed' : (g.deposited ? '⏳ Pending' : '❌ Not Deposited');
              response += `${i + 1}. Code: \`${g.code}\` - ${amount} ${tokenName} - ${status}\n`;
            });
            if (receivedGifts.length > 10) {
              response += `... and ${receivedGifts.length - 10} more\n`;
            }
          }
        }

        if (!response) {
          response = 'No gifts found matching your query. Try sending or receiving some gifts! 😉';
        }

        await bot.sendMessage(msg.chat.id, response, { reply_to_message_id: msg.message_id, parse_mode: 'Markdown' });
      } catch (error) {
        console.error('Show gifts error:', error);
        await bot.sendMessage(msg.chat.id, `😕 Error fetching gifts. The network might be slow - try again in a moment! 😉`, { reply_to_message_id: msg.message_id });
      }
      return;
    }

    // Send AI message only for chat action
    if (aiResponse && aiResponse.action === 'chat' && aiResponse.message) {
      await bot.sendMessage(msg.chat.id, aiResponse.message, { disable_web_page_preview: true, reply_to_message_id: msg.message_id });
    }

  } catch (error) {
    console.error('Message error:', error);
    bot.sendMessage(msg.chat.id, 'Something went wrong!');
  }
});

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message || error);
});
bot.on('error', (error) => console.error('Bot:', error));

// Launch
console.log('Deeza - Gift Drop Bot 🔥');
console.log(`Network: ${IS_TESTNET ? 'TESTNET' : 'MAINNET'}`);
console.log(`Native Token: ${NATIVE_TOKEN}`);
if (IS_TESTNET) {
  console.log(`ZAZZ Token: ${ZAZZ_TOKEN_ADDRESS || 'NOT SET'}`);
  console.log('Registration bonus: 100k ZAZZ tokens 🎁');
}
console.log('Features: Peer-to-peer gifts, AI-gated claims');
console.log('Ready!');

process.once('SIGINT', () => bot.stopPolling().then(() => process.exit(0)));
process.once('SIGTERM', () => bot.stopPolling().then(() => process.exit(0)));