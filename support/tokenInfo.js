// Token Info Module - GeckoTerminal Integration
import { ethers } from 'ethers';

const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';
const SOMNIA_NETWORK = 'somnia';

/**
 * Search for a token by symbol or address
 * @param {string} query - Token symbol or address
 * @returns {Promise<Object>} Token and pool information
 */
export async function searchToken(query) {
  try {
    // If it's an address, use it directly
    if (query.startsWith('0x')) {
      const pools = await fetch(`${GECKOTERMINAL_BASE}/networks/${SOMNIA_NETWORK}/tokens/${query}`).then(r => r.json());
      
      if (pools.data && pools.data.attributes) {
        return {
          tokenAddress: query,
          tokenSymbol: pools.data.attributes.symbol || 'UNKNOWN',
          tokenName: pools.data.attributes.name || 'Unknown Token',
          decimals: pools.data.attributes.decimals || 18
        };
      }
    }
    
    // Search by symbol
    const response = await fetch(`${GECKOTERMINAL_BASE}/search/pools?query=${query}&network=${SOMNIA_NETWORK}`);
    const data = await response.json();
    
    if (!data.data || data.data.length === 0) {
      return null;
    }
    
    // Get the most liquid pool
    const bestPool = data.data[0];
    
    // Safe extraction of token info
    const baseToken = bestPool.attributes?.base_token || {};
    const tokenAddress = bestPool.relationships?.base_token?.data?.id?.split('_')[1] || query;
    
    return {
      tokenAddress,
      tokenSymbol: baseToken.symbol || query,
      tokenName: baseToken.name || 'Unknown Token',
      poolAddress: bestPool.id,
      liquidity: parseFloat(bestPool.attributes?.reserve_in_usd) || 0
    };
  } catch (error) {
    console.error('Search token error:', error);
    return null;
  }
}

/**
 * Get market data for a pool
 * @param {string} poolAddress - Pool contract address
 * @returns {Promise<Object>} Market data
 */
export async function getMarketData(poolAddress) {
  try {
    const response = await fetch(`${GECKOTERMINAL_BASE}/networks/${SOMNIA_NETWORK}/pools/${poolAddress}`);
    const data = await response.json();
    
    if (!data.data || !data.data.attributes) {
      return null;
    }
    
    const attrs = data.data.attributes;
    
    return {
      price: parseFloat(attrs.base_token_price_usd) || 0,
      reserveUSD: parseFloat(attrs.reserve_in_usd) || 0, // Liquidity
      volume24h: parseFloat(attrs.volume_usd?.h24) || 0,
      volume7d: parseFloat(attrs.volume_usd?.d7) || 0,
      volume1h: parseFloat(attrs.volume_usd?.h1) || 0,
      change24h: parseFloat(attrs.price_change_percentage?.h24) || 0,
      change7d: parseFloat(attrs.price_change_percentage?.d7) || 0,
      change1h: parseFloat(attrs.price_change_percentage?.h1) || 0,
      transactions24h: attrs.transactions?.h24 || {}
    };
  } catch (error) {
    console.error('Get market data error:', error);
    return null;
  }
}

/**
 * Get token info from blockchain (decimals, symbol, name)
 * @param {string} tokenAddress - Token contract address
 * @param {Object} provider - Ethers provider
 * @returns {Promise<Object>} On-chain token data
 */
export async function getTokenOnChainData(tokenAddress, provider) {
  try {
    const ERC20_ABI = [
      'function decimals() view returns (uint8)',
      'function symbol() view returns (string)',
      'function name() view returns (string)',
      'function totalSupply() view returns (uint256)'
    ];
    
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    
    const [decimals, symbol, name, totalSupply] = await Promise.all([
      contract.decimals().catch(() => 18),
      contract.symbol().catch(() => 'UNKNOWN'),
      contract.name().catch(() => 'Unknown Token'),
      contract.totalSupply().catch(() => 0)
    ]);
    
    return {
      decimals,
      symbol,
      name,
      totalSupply: totalSupply.toString()
    };
  } catch (error) {
    console.error('Get token on-chain error:', error);
    return null;
  }
}

/**
 * Handle token query from AI
 * @param {Object} params - Query parameters
 * @param {Object} provider - Ethers provider
 * @returns {Promise<string>} Formatted response message
 */
export async function handleTokenQuery(params, provider) {
  const { tokens, metric, timeframe } = params;
  
  if (!tokens || tokens.length === 0) {
    return "Hey! I need a token name or address to check! 🎯 Just tell me like 'What's SOMI price?' or 'Check PEPE'";
  }
  
  const responses = [];
  
  for (const token of tokens) {
    // 1. Search for token
    const searchResult = await searchToken(token);
    
    if (!searchResult) {
      responses.push(`Hmm, I couldn't find ${token} on Somnia! 😕 Make sure you spelled it right or try a different token. Maybe it's listed somewhere else?`);
      continue;
    }
    
    // 2. Get market data if we have pool
    let marketData = null;
    if (searchResult.poolAddress) {
      marketData = await getMarketData(searchResult.poolAddress);
    }
    
    // 3. Get on-chain data
    const onChainData = await getTokenOnChainData(searchResult.tokenAddress, provider);
    
    // 4. Extract metric and format response
    let response = formatMetricResponse(
      token,
      searchResult,
      marketData,
      metric,
      timeframe
    );
    
    responses.push(response);
  }
  
  return responses.join('\n\n');
}

/**
 * Format metric response based on user query
 */
function formatMetricResponse(token, searchResult, marketData, metric, timeframe = '24h') {
  const timeframeMap = {
    '1h': '1 hour',
    '6h': '6 hours',
    '24h': '24 hours',
    '7d': '7 days',
    '30d': '30 days'
  };
  
  const timeframeLabel = timeframeMap[timeframe] || timeframe;
  
  if (!marketData) {
    return `Hmm, I found ${token} at ${searchResult.tokenAddress} but can't grab the market data right now! 🤔 Try again in a sec?`;
  }
  
  switch (metric) {
    case 'price':
      return `💰 Hey! ${token} is sitting at $${marketData.price.toFixed(4)} right now! 📈`;
      
    case 'volume':
      const volume = marketData[`volume${timeframe}`] || marketData.volume24h || 0;
      const volFormatted = formatNumber(volume);
      return `📊 ${token} did $${volFormatted} in ${timeframeLabel} volume - ${volume > 100000 ? 'that\'s solid! 🚀' : 'not bad! 👍'}`;
      
    case 'mcap':
    case 'marketcap':
      // Estimate market cap = price * total supply
      const mcap = marketData.reserveUSD * 2;
      return `💎 ${token}'s market cap is around $${formatNumber(mcap)} - that's ${mcap > 1000000 ? 'pretty healthy! 💪' : 'growing! 🌱'}`;
      
    case 'liquidity':
      const liqFormatted = formatNumber(marketData.reserveUSD);
      return `💧 ${token} has $${liqFormatted} in liquidity - ${marketData.reserveUSD > 100000 ? 'solid depth! ✅' : 'getting there! 📊'}`;
      
    case 'change':
    case 'price_change':
      const change = marketData[`change${timeframe}`] || marketData.change24h || 0;
      const emoji = change >= 0 ? '📈' : '📉';
      return `${emoji} ${token} is ${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(2)}% in the last ${timeframeLabel} - ${Math.abs(change) > 10 ? 'nice move! 💰' : 'steady as she goes! 😎'}`;
      
    case 'holders':
      // GeckoTerminal doesn't provide holders, would need to query from blockchain
      return `👥 Holders count for ${token} isn't available from pool data - but you're part of the fam! 🎉`;
      
    default:
      // Return general info if no specific metric
      return formatGeneralInfo(token, searchResult, marketData);
  }
}

/**
 * Format general token info
 */
function formatGeneralInfo(token, searchResult, marketData) {
  return `📊 ${token} Info - Let's see what's going on! 📈

💵 Price: $${marketData.price.toFixed(4)}
💧 Liquidity: $${formatNumber(marketData.reserveUSD)}
📊 24h Volume: $${formatNumber(marketData.volume24h)}
📈 24h Change: ${marketData.change24h >= 0 ? '+' : ''}${marketData.change24h.toFixed(2)}%

📍 Contract: ${searchResult.tokenAddress}

${marketData.change24h > 5 ? '🚀 Looking good! Trending up!' : marketData.change24h < -5 ? '📉 Taking a breather!' : '😎 Steady flow!'}`;
}

/**
 * Format large numbers
 */
function formatNumber(num) {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(2);
}

/**
 * Get chart URL for a pool
 * @param {string} poolAddress - Pool contract address
 * @returns {string} Chart URL
 */
export function getChartUrl(poolAddress) {
  return `https://www.geckoterminal.com/${SOMNIA_NETWORK}/pools/${poolAddress}`;
}

