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
const CONTRACT_ADDRESS = process.env.DEEZA_AGENT_CONTRACT; // Set in .env
const WALLET_CONNECT_URL = 'https://deeza.vercel.app';

// Testnet: ZAZZ token (mock token for all ERC20 requests)
const ZAZZ_TOKEN_ADDRESS = process.env.ZAZZ_TOKEN_ADDRESS || ethers.ZeroAddress; // Set after deployment
const ZAZZ_MINT_AMOUNT = ethers.parseUnits('100000', 18); // 100k ZAZZ tokens for registration bonus

// Native token symbols
const NATIVE_TOKEN = IS_TESTNET ? 'STT' : 'SOMI';

const provider = new ethers.JsonRpcProvider(SOMNIA_RPC, {
  chainId: SOMNIA_CHAIN_ID,
  name: 'somnia'
});

// Contract ABI (minimal)
const CONTRACT_ABI = [
  'function createGift(bytes32 id, string calldata code, string calldata ipfsLink) external',
  'function depositGift(bytes32 id, address token, uint256 amount) external payable',
  'function release(bytes32 id, address to) external',
  'function extendClaimTime(bytes32 id, uint256 minutes) external',
  'function getGift(bytes32 id) external view returns (tuple(address gifter, address token, uint256 amount, string code, string ipfsLink, address claimer, uint256 claimDeadline, uint8 attempts, bool deposited, bool claimed))',
  'event GiftCreated(bytes32 indexed id, address gifter, string code)',
  'event GiftDeposited(bytes32 indexed id)',
  'event GiftClaimed(bytes32 indexed id, address claimer, uint256 amount, address token)'
];

// ZAZZ Token ABI (for minting test tokens)
const ZAZZ_ABI = [
  'function mint(address to, uint256 amount) external',
  'function balanceOf(address account) external view returns (uint256)'
];

const contract = CONTRACT_ADDRESS ? new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider) : null;
const zazzContract = ZAZZ_TOKEN_ADDRESS && ZAZZ_TOKEN_ADDRESS !== ethers.ZeroAddress 
  ? new ethers.Contract(ZAZZ_TOKEN_ADDRESS, ZAZZ_ABI, provider) 
  : null;

// Context types
const CONTEXT_TYPES = {
  REGISTER_WALLET: 'register_wallet',
  REGISTER_WALLET_CONFIRM: 'register_wallet_confirm', // Confirmation for changing existing wallet
  SEND_GIFT_PROOF: 'send_gift_proof',
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
  await supabase.from('deeza_contexts').upsert({
    telegram_id: tgId,
    context_type: type,
    context_data: data,
    updated_at: new Date().toISOString()
  });
}

// Get context
async function getContext(tgId) {
  const { data } = await supabase
    .from('deeza_contexts')
    .select('*')
    .eq('telegram_id', tgId)
    .single();
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
    const systemPrompt = `You are Deeza — a chill, conversational, helpful "crypto bro" on Somnia. You help users send peer-to-peer gifts (USDC, ${NATIVE_TOKEN}, or any ERC-20 token) to friends using natural language. Your signature emoji is 😉.

SPECIAL RESPONSES:
- If user asks about a "Deeza token": "Our developers haven't launched an official token yet, but if we did, we'd be sure it'd do a moon shot! 🚀😉"
- If user asks about founder/developer/owner/creator/builder: "I was built by Dee, a 16 year old Nigerian developer — an amazing guy! Even named this crypto bro after himself 😉"

ALWAYS return a single JSON response with keys: action, params, message. ONLY produce a single JSON object.

ACTIONS:
1. REGISTER_WALLET: When user wants to register their wallet or says "register me", "connect wallet", etc.
   - params: { "intent": "register" }

2. SEND_GIFT: When user wants to send a gift (e.g., "send @john 10 USDC", "send 5 ${NATIVE_TOKEN} to @mike", "send 100$ worth of NIA to @alice")
   - Extract: recipient (username or @username), amount (number), token (USDC, ${NATIVE_TOKEN}, or token symbol)
   - If amount is in USD (has $ or "usd"), set "amount_usd": number, else set "amount": number
   - params: { "recipient": "john", "amount": 10, "token": "USDC" } OR { "recipient": "mike", "amount": 5, "token": "${NATIVE_TOKEN}" } OR { "recipient": "alice", "amount_usd": 100, "token": "NIA" }

3. SET_PROOF: When user answers what the receiver should prove (after send gift)
   - params: { "proof": "answer text" }

4. CLAIM_GIFT: When user wants to claim a gift (e.g., "claim john42", "claim code123")
   - params: { "code": "john42" }

5. SHOW_GIFTS: When user wants to see their gifts ("show my gifts", "show pending", "show sent")
   - params: { "type": "pending|active|all" }

6. CHAT: For general conversation

EXAMPLES:
User: "should I register you?" → {"action":"register_wallet","params":{"intent":"register"},"message":"Sure! What's your wallet address? 😉"}
User: "send @john 10 USDC" → {"action":"send_gift","params":{"recipient":"john","amount":10,"token":"USDC"},"message":"What should @john prove?"}
User: "his dog's name is Luna" → {"action":"set_proof","params":{"proof":"his dog's name is Luna"},"message":"Got it! Code: john42 — OK?"}
User: "claim john42" → {"action":"claim_gift","params":{"code":"john42"},"message":"What's your dog's name?"}

RESPONSE FORMAT (JSON):
{
  "action": "chat",
  "params": {},
  "message": "I had trouble understanding that. Can you try rephrasing?"
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
    const prompt = `You are an AI judge. Check if the user's answer matches the expected answer.

Expected answer: "${expectedAnswer}"
User's answer: "${userAnswer}"

Respond with ONLY a JSON object:
{
  "correct": true/false,
  "reason": "brief explanation"
}

Be flexible - if the user's answer clearly means the same thing as expected, mark it correct.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are an AI judge. Respond with JSON only." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 200
    });

    const response = completion.choices[0].message.content.trim();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { correct: false, reason: "Failed to parse response" };
  } catch (error) {
    console.error('AI judge error:', error);
    return { correct: false, reason: "Error judging answer" };
  }
}

// Resolve token address (testnet uses ZAZZ mock token, mainnet uses real addresses)
async function getTokenAddress(tokenSymbol) {
  const tokenUpper = tokenSymbol?.toUpperCase() || '';
  
  // Native token check
  if (!tokenSymbol || tokenUpper === 'SOMI' || tokenUpper === 'STT') {
    return ethers.ZeroAddress; // Native token (STT on testnet, SOMI on mainnet)
  }

  // Testnet: All ERC20 tokens use ZAZZ mock token
  if (IS_TESTNET) {
    if (!ZAZZ_TOKEN_ADDRESS || ZAZZ_TOKEN_ADDRESS === ethers.ZeroAddress) {
      console.warn('ZAZZ_TOKEN_ADDRESS not set - cannot resolve testnet token');
      return null;
    }
    return ZAZZ_TOKEN_ADDRESS;
  }

  // Mainnet: Fetch real token address from GeckoTerminal
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
    // Get native token price
    const tokenInfo = await searchToken(nativeTokenSymbol);
    if (!tokenInfo?.poolAddress) return null;
    const poolRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/somnia/pools/${tokenInfo.poolAddress}`);
    const poolData = await poolRes.json();
    const price = parseFloat(poolData?.data?.attributes?.base_token_price_usd || 0);
    if (price === 0) return null;
    return usdAmount / price;
  } else {
    // Get token price (real token on mainnet, ZAZZ on testnet for calculation)
    const searchSymbol = IS_TESTNET ? 'ZAZZ' : tokenSymbol;
    const tokenInfo = await searchToken(searchSymbol);
    if (!tokenInfo?.poolAddress) return null;
    const poolRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/somnia/pools/${tokenInfo.poolAddress}`);
    const poolData = await poolRes.json();
    const price = parseFloat(poolData?.data?.attributes?.base_token_price_usd || 0);
    if (price === 0) return null;
    return usdAmount / price;
  }
}

// Send registration bonus (100k ZAZZ tokens on testnet only)
async function sendRegistrationBonus(walletAddress) {
  if (!IS_TESTNET) return; // Only on testnet
  
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
    
    // Mint 100k ZAZZ tokens to the new user
    const tx = await zazzWithSigner.mint(walletAddress, ZAZZ_MINT_AMOUNT);
    await tx.wait();
    
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
      ? `🧪 TESTNET MODE\n• Native: STT\n• All tokens use ZAZZ (mock token)\n• Register wallet = 100k ZAZZ bonus! 🎁`
      : `🌐 MAINNET\n• Native: SOMI\n• Real token addresses`;
    
    const helpText = `Hey there! I'm Deeza — your crypto bro for peer-to-peer gifts on Somnia. 😎\n\n${networkInfo}\n\n📝 How it works:\n1. Send gifts: "send @john 10 USDC" or "send $20 worth of NIA to @mike"\n2. Set proof: Tell me what they should prove (e.g., "his dog's name is Luna")\n3. They claim: Receiver says "claim [code]" and answers your question\n4. AI judges: I check if their answer matches!\n\n💡 Examples:\n• "send @friend 5 ${NATIVE_TOKEN}"\n• "send 3000 NIA to @alice"\n• "send $100 JELLU to @bob"\n\nThey claim by proving what you ask! 😉`;
    
    await bot.sendMessage(msg.chat.id, helpText);
  } catch (error) {
    console.error('Start error:', error);
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

    // Handle wallet registration follow-ups
    if (existingContext && existingContext.context_type === CONTEXT_TYPES.REGISTER_WALLET) {
      const text = msg.text.trim();
      // Check if it's a wallet address
      if (text.startsWith('0x') && text.length === 42) {
        // Check if user already has a wallet
        const { data: existingUser } = await supabase
          .from('deeza_users')
          .select('wallet_address')
          .eq('telegram_id', tgId)
          .single();
        
        const isNewRegistration = !existingUser?.wallet_address;
        
        // If user already has a wallet, ask for confirmation
        if (!isNewRegistration && existingUser.wallet_address) {
          const oldAddress = existingUser.wallet_address;
          await saveContext(tgId, CONTEXT_TYPES.REGISTER_WALLET_CONFIRM, {
            newAddress: text,
            oldAddress: oldAddress
          });
          await bot.sendMessage(msg.chat.id, `⚠️ You already have a wallet registered:\n${oldAddress.substring(0, 10)}...${oldAddress.substring(38)}\n\nNew address: ${text.substring(0, 10)}...${text.substring(38)}\n\nDo you want to change it? (yes/no)`, { reply_to_message_id: msg.message_id });
          return;
        }
        
        // New registration - proceed directly
        await supabase.from('deeza_users').update({
          wallet_address: text
        }).eq('telegram_id', tgId);
        
        await clearContext(tgId);
        
        // Send registration bonus on testnet (only for new registrations)
        if (isNewRegistration && IS_TESTNET) {
          const bonusSent = await sendRegistrationBonus(text);
          if (bonusSent) {
            await bot.sendMessage(msg.chat.id, `✅ Wallet registered! ${text.substring(0, 10)}...${text.substring(38)}\n\n🎁 You received 100,000 ZAZZ tokens to play with! (Testnet only)`, { reply_to_message_id: msg.message_id });
          } else {
            await bot.sendMessage(msg.chat.id, `✅ Wallet registered! ${text.substring(0, 10)}...${text.substring(38)}\n\n⚠️ Bonus failed to send (check bot config)`, { reply_to_message_id: msg.message_id });
          }
        } else {
          await bot.sendMessage(msg.chat.id, `✅ Wallet registered! ${text.substring(0, 10)}...${text.substring(38)}`, { reply_to_message_id: msg.message_id });
        }
        return;
      } else {
        // Continue asking
        await bot.sendMessage(msg.chat.id, "Please provide a valid wallet address (starts with 0x, 42 characters). 😉", { reply_to_message_id: msg.message_id });
        return;
      }
    }

    // Handle wallet change confirmation
    if (existingContext && existingContext.context_type === CONTEXT_TYPES.REGISTER_WALLET_CONFIRM) {
      const text = msg.text.toLowerCase().trim();
      const confirmWords = ['yes', 'yep', 'ok', 'okay', 'sure', 'confirm', 'go', 'change'];
      const cancelWords = ['no', 'cancel', 'abort', 'stop'];
      
      if (confirmWords.some(word => text.includes(word))) {
        const { newAddress, oldAddress } = existingContext.context_data;
        
        // Update wallet address
        await supabase.from('deeza_users').update({
          wallet_address: newAddress
        }).eq('telegram_id', tgId);
        
        await clearContext(tgId);
        await bot.sendMessage(msg.chat.id, `✅ Wallet address updated!\n\nOld: ${oldAddress.substring(0, 10)}...${oldAddress.substring(38)}\nNew: ${newAddress.substring(0, 10)}...${newAddress.substring(38)}`, { reply_to_message_id: msg.message_id });
        return;
      } else if (cancelWords.some(word => text.includes(word))) {
        await clearContext(tgId);
        await bot.sendMessage(msg.chat.id, "Cancelled. Wallet address not changed.", { reply_to_message_id: msg.message_id });
        return;
      } else {
        // Not clear - ask again
        await bot.sendMessage(msg.chat.id, "Please confirm: say 'yes' to change or 'no' to cancel.", { reply_to_message_id: msg.message_id });
        return;
      }
    }

    // Handle proof setting follow-up
    if (existingContext && existingContext.context_type === CONTEXT_TYPES.SEND_GIFT_PROOF) {
      const aiResponse = await processWithAI(msg.text, existingContext);
      if (aiResponse.action === 'set_proof' && aiResponse.params?.proof) {
        const proof = aiResponse.params.proof;
        const giftData = existingContext.context_data;
        
        // Generate code
        const code = `${giftData.recipient}${Math.floor(Math.random() * 100)}`;
        const giftId = ethers.id(code);
        
        // Upload Q&A to IPFS
        const ipfsData = {
          question: `What should ${giftData.recipient} prove?`,
          answer: proof,
          gifter: user.telegram_username,
          recipient: giftData.recipient
        };
        
        let ipfsLink = '';
        try {
          ipfsLink = await uploadToIPFS(ipfsData);
        } catch (error) {
          console.error('IPFS upload error:', error);
          await bot.sendMessage(msg.chat.id, "Error uploading proof. Try again.", { reply_to_message_id: msg.message_id });
          return;
        }

        // Store gift in Supabase and context
        const giftIdHex = ethers.hexlify(giftId);
        
        await supabase.from('deeza_gifts').insert({
          gift_id: giftIdHex,
          code,
          gifter_telegram_id: tgId,
          recipient_username: giftData.recipient,
          token: giftData.token,
          token_address: giftData.tokenAddress || ethers.ZeroAddress,
          amount: giftData.amount.toString(),
          ipfs_link: ipfsLink
        });

        // Create gift on contract (if deployed)
        if (contract && process.env.BOT_PRIVATE_KEY) {
          try {
            const botWallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
            const contractWithSigner = contract.connect(botWallet);
            await contractWithSigner.createGift(giftId, code, ipfsLink);
          } catch (error) {
            console.error('Contract create error:', error);
          }
        }

        await saveContext(tgId, CONTEXT_TYPES.SEND_GIFT_CONFIRM, {
          ...giftData,
          code,
          giftId: giftIdHex,
          ipfsLink,
          proof
        });

        const displayTokenName = giftData.token.toUpperCase() === 'SOMI' || giftData.token.toUpperCase() === 'STT' ? NATIVE_TOKEN : giftData.token.toUpperCase();
        const depositLink = `${WALLET_CONNECT_URL}?gift=${code}&token=${displayTokenName}&amount=${giftData.amount}&tokenAddress=${giftData.tokenAddress || '0x0000000000000000000000000000000000000000'}`;
        
        const testnetNote = IS_TESTNET ? '\n\n🧪 Testnet: All ERC20 tokens use ZAZZ mock token' : '';
        await bot.sendMessage(msg.chat.id, `Code: ${code} — OK?${testnetNote}\n\nDeposit link: ${depositLink}`, { reply_to_message_id: msg.message_id });
        return;
      }
    }

    // Handle gift confirmation
    if (existingContext && existingContext.context_type === CONTEXT_TYPES.SEND_GIFT_CONFIRM) {
      const text = msg.text.toLowerCase().trim();
      const confirmWords = ['yes', 'yep', 'ok', 'okay', 'sure', 'confirm', 'go'];
      
      if (confirmWords.some(word => text.includes(word))) {
        const giftData = existingContext.context_data;
        await clearContext(tgId);
        
        // Notify recipient if they're registered
        const recipient = await getUserByUsername(giftData.recipient);
        if (recipient && recipient.wallet_address) {
          try {
            await bot.sendMessage(recipient.telegram_id, `🎁 You received a gift from @${user.telegram_username}!\n\nSay "claim ${giftData.code}" to unlock it. 😉`);
          } catch (e) {
            console.error('DM error:', e);
          }
        }
        
        await bot.sendMessage(msg.chat.id, `✅ Gift created! Code: ${giftData.code}\n\nRecipient can claim with: "claim ${giftData.code}"`, { reply_to_message_id: msg.message_id });
        return;
      } else if (text.includes('no') || text.includes('cancel')) {
        await clearContext(tgId);
        await bot.sendMessage(msg.chat.id, "Cancelled. No gift created.", { reply_to_message_id: msg.message_id });
        return;
      }
    }

    // Process with AI
    const aiResponse = await processWithAI(msg.text, existingContext);

    // Emoji reaction
    try { await bot.setMessageReaction(msg.chat.id, msg.message_id, { reaction: [{ type: 'emoji', emoji: '😁' }] }); } catch {}

    // Send AI message
    if (aiResponse.message) {
      await bot.sendMessage(msg.chat.id, aiResponse.message, { disable_web_page_preview: true, reply_to_message_id: msg.message_id });
    }

    // Handle actions
    if (aiResponse.action === 'register_wallet' || (aiResponse.action === 'chat' && msg.text.toLowerCase().includes('register'))) {
      await saveContext(tgId, CONTEXT_TYPES.REGISTER_WALLET, {});
      await bot.sendMessage(msg.chat.id, "Okay cool, what's your wallet address? 😉", { reply_to_message_id: msg.message_id });
      return;
    }

    if (aiResponse.action === 'send_gift') {
      const params = aiResponse.params;
      const recipient = params.recipient?.replace('@', '');
      let amount = params.amount || 0;
      let token = params.token || 'USDC';
      let tokenAddress = null;

      // Handle USD amounts
      if (params.amount_usd) {
        const tokenAmount = await convertUSDToTokens(token, params.amount_usd);
        if (!tokenAmount) {
          await bot.sendMessage(msg.chat.id, `Couldn't get price for ${token}. Try again.`, { reply_to_message_id: msg.message_id });
          return;
        }
        amount = tokenAmount;
      }

      // Get token address
      if (token.toUpperCase() !== 'SOMI') {
        tokenAddress = await getTokenAddress(token);
        if (!tokenAddress) {
          await bot.sendMessage(msg.chat.id, `Couldn't find token ${token}. Make sure the symbol is correct.`, { reply_to_message_id: msg.message_id });
          return;
        }
      }

      if (!recipient || !amount || amount <= 0) {
        await bot.sendMessage(msg.chat.id, "I need a recipient and amount! Try: \"send @john 10 USDC\" 😉", { reply_to_message_id: msg.message_id });
        return;
      }

      // Check if gifter has wallet
      if (!user.wallet_address) {
        await bot.sendMessage(msg.chat.id, `You need to register your wallet first! Say "register me" or "should I register you?" 😉`, { reply_to_message_id: msg.message_id });
        return;
      }

      // Normalize token symbol for display (show requested token name, but use correct address)
      const displayToken = token.toUpperCase();
      const resolvedToken = displayToken === 'SOMI' || displayToken === 'STT' ? NATIVE_TOKEN : displayToken;

      await saveContext(tgId, CONTEXT_TYPES.SEND_GIFT_PROOF, {
        recipient,
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

      // Check if user has wallet
      if (!user.wallet_address) {
        await bot.sendMessage(msg.chat.id, "You need to register your wallet first! Say \"register me\" 😉", { reply_to_message_id: msg.message_id });
        return;
      }

      // Get gift from Supabase
      const { data: giftRecord } = await supabase
        .from('deeza_gifts')
        .select('*')
        .eq('code', code)
        .single();

      if (!giftRecord) {
        await bot.sendMessage(msg.chat.id, "Gift not found. Make sure the code is correct.", { reply_to_message_id: msg.message_id });
        return;
      }

      if (giftRecord.claimed) {
        await bot.sendMessage(msg.chat.id, "This gift has already been claimed.", { reply_to_message_id: msg.message_id });
        return;
      }

      if (!giftRecord.deposited) {
        await bot.sendMessage(msg.chat.id, "Gift not deposited yet. Wait for the gifter to deposit.", { reply_to_message_id: msg.message_id });
        return;
      }

      // Get from contract if available, otherwise use Supabase data
      let giftData = null;
      if (contract) {
        try {
          const giftId = ethers.id(code);
          const gift = await contract.getGift(giftId);
          if (gift.deposited && !gift.claimed) {
            giftData = gift;
          }
        } catch (error) {
          console.error('Contract fetch error:', error);
        }
      }

      // Fetch Q&A from IPFS
      try {
        const ipfsData = await fetchFromIPFS(giftRecord.ipfs_link);
        
        await saveContext(tgId, CONTEXT_TYPES.CLAIM_GIFT, {
          giftId: giftRecord.gift_id,
          code,
          expectedAnswer: ipfsData.answer,
          question: ipfsData.question,
          attempts: 0,
          tokenAddress: giftRecord.token_address,
          amount: giftRecord.amount
        });

        await bot.sendMessage(msg.chat.id, ipfsData.question || "What's the proof?", { reply_to_message_id: msg.message_id });
      } catch (error) {
        console.error('IPFS fetch error:', error);
        await bot.sendMessage(msg.chat.id, "Error fetching gift details. Try again.", { reply_to_message_id: msg.message_id });
      }
      return;
    }

    // Handle claim answer
    if (existingContext && existingContext.context_type === CONTEXT_TYPES.CLAIM_GIFT) {
      const userAnswer = msg.text;
      const claimData = existingContext.context_data;
      
      // Judge answer
      const judgment = await judgeAnswer(userAnswer, claimData.expectedAnswer);
      
      if (judgment.correct) {
        // Release gift
        if (contract) {
          try {
            // Bot wallet would sign this - needs bot private key
            // For MVP, assume bot wallet is set up
            const botWallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
            const contractWithSigner = contract.connect(botWallet);
            await contractWithSigner.release(claimData.giftId, user.wallet_address || ethers.ZeroAddress);
            
            await clearContext(tgId);
            await bot.sendMessage(msg.chat.id, `✅ Correct! Gift claimed and sent! 🎉`, { reply_to_message_id: msg.message_id });
          } catch (error) {
            console.error('Release error:', error);
            await bot.sendMessage(msg.chat.id, "Error releasing gift. Contact support.", { reply_to_message_id: msg.message_id });
          }
        } else {
          await clearContext(tgId);
          await bot.sendMessage(msg.chat.id, `✅ Correct! (Contract not deployed yet)`, { reply_to_message_id: msg.message_id });
        }
      } else {
        let attempts = (claimData.attempts || 0) + 1;
        
        if (attempts >= 3) {
          // Extend claim time
          if (contract) {
            try {
              const botWallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY, provider);
              const contractWithSigner = contract.connect(botWallet);
              await contractWithSigner.extendClaimTime(claimData.giftId, 30);
            } catch (e) {
              console.error('Extend error:', e);
            }
          }
          
          await clearContext(tgId);
          await bot.sendMessage(msg.chat.id, `❌ Wrong. Locked for 30 minutes. Try again later.`, { reply_to_message_id: msg.message_id });
        } else {
          await saveContext(tgId, CONTEXT_TYPES.CLAIM_GIFT, {
            ...claimData,
            attempts
          });
          
          await bot.sendMessage(msg.chat.id, `❌ Wrong. Try again. (${3 - attempts} attempts left)`, { reply_to_message_id: msg.message_id });
        }
      }
      return;
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