// Token Info Module - GeckoTerminal Integration
import { ethers } from 'ethers';
import puppeteer from 'puppeteer';

const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';
const SOMNIA_NETWORK = 'somnia';

/**
 * Fetch with timeout and retry logic
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} retries - Number of retry attempts
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, retries = 3, timeout = 30000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return response;
    } catch (error) {
      if (attempt === retries - 1) {
        throw error; // Last attempt, throw the error
      }
      console.warn(`Fetch attempt ${attempt + 1} failed for ${url}:`, error.message);
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

/**
 * Search for a token by symbol or address
 * @param {string} query - Token symbol or address
 * @returns {Promise<Object>} Token and pool information
 */
export async function searchToken(query) {
  try {
    // If it's an address, use it directly
    if (query.startsWith('0x')) {
      const tokenResp = await fetchWithRetry(`${GECKOTERMINAL_BASE}/networks/${SOMNIA_NETWORK}/tokens/${query}`).then(r => r.json());
      let tokenSymbol, tokenName, decimals;
      if (tokenResp?.data?.attributes) {
        tokenSymbol = tokenResp.data.attributes.symbol || 'UNKNOWN';
        tokenName = tokenResp.data.attributes.name || 'Unknown Token';
        decimals = tokenResp.data.attributes.decimals || 18;
      }

      // Fetch pools for this token and pick the most liquid one
      let poolAddress = undefined;
      let liquidity = 0;
      let fdv_usd = 0; // Fully Diluted Valuation (market cap)
      try {
        const poolsResp = await fetchWithRetry(`${GECKOTERMINAL_BASE}/networks/${SOMNIA_NETWORK}/tokens/${query}/pools`).then(r => r.json());
        console.log('Pools for token:', query, poolsResp?.data?.length || 0, 'pools found');
        if (poolsResp?.data?.length) {
          const best = poolsResp.data
            .map(p => ({ id: p.id, liq: parseFloat(p.attributes?.reserve_in_usd || '0') }))
            .sort((a, b) => b.liq - a.liq)[0];
          if (best && best.id) {
            // Store both: stripped for API calls, full for URLs
            poolAddress = best.id.includes('_') ? best.id.split('_')[1] : best.id;
            liquidity = best.liq;
            console.log('Selected pool:', poolAddress, '(original:', best.id, ')');
          }
        }
      } catch (err) {
        console.error('Error fetching pools:', err.message);
      }
      
      // Check token endpoint for FDV or market cap (GeckoTerminal provides both)
      if (tokenResp?.data?.attributes?.fdv_usd) {
        fdv_usd = parseFloat(tokenResp.data.attributes.fdv_usd);
        console.log('Found FDV from token endpoint:', fdv_usd);
      } else if (tokenResp?.data?.attributes?.market_cap_usd) {
        fdv_usd = parseFloat(tokenResp.data.attributes.market_cap_usd);
        console.log('Found market_cap_usd from token endpoint:', fdv_usd);
      }
      
      // Debug: Log all available attributes to see what we have
      if (!fdv_usd && tokenResp?.data?.attributes) {
        console.log('Available token attributes:', Object.keys(tokenResp.data.attributes).filter(k => k.toLowerCase().includes('cap') || k.toLowerCase().includes('fdv')));
      }

      if (tokenSymbol) {
        return {
          tokenAddress: query,
          tokenSymbol,
          tokenName,
          decimals: decimals || 18,
          poolAddress,
          liquidity,
          fdv_usd
        };
      }
    }
    
    // Search by symbol
    const response = await fetchWithRetry(`${GECKOTERMINAL_BASE}/search/pools?query=${encodeURIComponent(query)}&network=${SOMNIA_NETWORK}`);
    const data = await response.json();
    
    if (!data.data || data.data.length === 0) {
      return null;
    }
    
    // Get the most liquid pool
    const bestPool = data.data[0];
    
    // Safe extraction of token info
    const baseToken = bestPool.attributes?.base_token || {};
    const tokenAddress = bestPool.relationships?.base_token?.data?.id?.split('_')[1] || query;
    
    // Pool ID comes as "somnia_0x..." but API needs just "0x..."
    const poolId = bestPool.id.includes('_') ? bestPool.id.split('_')[1] : bestPool.id;
    
    // Try to get FDV from token endpoint if we have the address
    let fdv_usd = 0;
    if (tokenAddress && tokenAddress.startsWith('0x')) {
      try {
        const tokenResp = await fetchWithRetry(`${GECKOTERMINAL_BASE}/networks/${SOMNIA_NETWORK}/tokens/${tokenAddress}`).then(r => r.json());
        if (tokenResp?.data?.attributes?.fdv_usd) {
          fdv_usd = parseFloat(tokenResp.data.attributes.fdv_usd);
          console.log('Found FDV from token endpoint (symbol search):', fdv_usd);
        } else if (tokenResp?.data?.attributes?.market_cap_usd) {
          fdv_usd = parseFloat(tokenResp.data.attributes.market_cap_usd);
          console.log('Found market_cap_usd from token endpoint (symbol search):', fdv_usd);
        }
      } catch (e) {
        console.error('Error fetching token data for FDV:', e.message);
      }
    }
    
    return {
      tokenAddress,
      tokenSymbol: baseToken.symbol || query,
      tokenName: baseToken.name || 'Unknown Token',
      poolAddress: poolId,
      liquidity: parseFloat(bestPool.attributes?.reserve_in_usd) || 0,
      fdv_usd
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
    if (!poolAddress) {
      console.error('No pool address provided to getMarketData');
      return null;
    }
    console.log('Fetching market data for pool:', poolAddress);
    const response = await fetchWithRetry(`${GECKOTERMINAL_BASE}/networks/${SOMNIA_NETWORK}/pools/${poolAddress}`);
    const data = await response.json();
    console.log('Market data response:', data?.data ? 'has data' : 'no data', data?.errors ? 'errors:' + JSON.stringify(data.errors) : '');
    
    if (!data.data || !data.data.attributes) {
      console.error('Invalid market data response for pool:', poolAddress);
      return null;
    }
    
    const attrs = data.data.attributes;
    
    // Debug: Log available attribute keys
    if (!attrs.base_token_price_usd && !attrs.base_token?.price_usd) {
      console.log('Available price fields:', Object.keys(attrs).filter(k => k.toLowerCase().includes('price')));
      console.log('Base token object keys:', attrs.base_token ? Object.keys(attrs.base_token) : 'no base_token');
    }
    
    // Try multiple price field names - GeckoTerminal may use different formats
    // Check nested base_token object first
    const price = parseFloat(
      attrs.base_token?.price_usd || 
      attrs.base_token_price_usd || 
      attrs.price_usd || 
      attrs.token_price_usd || 
      '0'
    );
    
    console.log('Price extraction - base_token_price_usd:', attrs.base_token_price_usd, 'base_token.price_usd:', attrs.base_token?.price_usd, 'final price:', price);
    
    return {
      price: price || 0,
      reserveUSD: parseFloat(attrs.reserve_in_usd || attrs.reserve_usd || '0'), // Liquidity
      volume24h: parseFloat(attrs.volume_usd?.h24 || attrs.volume_usd?.h24 || '0'),
      volume7d: parseFloat(attrs.volume_usd?.d7 || '0'),
      volume1h: parseFloat(attrs.volume_usd?.h1 || '0'),
      change24h: parseFloat(attrs.price_change_percentage?.h24 || attrs.price_change_percentage?.h24 || '0'),
      change7d: parseFloat(attrs.price_change_percentage?.d7 || '0'),
      change1h: parseFloat(attrs.price_change_percentage?.h1 || '0'),
      transactions24h: attrs.transactions?.h24 || {},
      // Additional fields for market cap calculation
      baseToken: attrs.base_token,
      quoteToken: attrs.quote_token
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
export async function getTokenOnChainData(tokenAddress, provider, geckoData = null) {
  try {
    const ERC20_ABI = [
      'function decimals() view returns (uint8)',
      'function symbol() view returns (string)',
      'function name() view returns (string)',
      'function totalSupply() view returns (uint256)'
    ];
    
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    
    // Fetch basic info first - use GeckoTerminal data as fallback if available
    let decimals, symbol, name;
    try {
      [decimals, symbol, name] = await Promise.all([
        contract.decimals(),
        contract.symbol(),
        contract.name()
      ]);
    } catch (error) {
      // If any call fails, use GeckoTerminal fallback
      decimals = geckoData?.decimals || 18;
      symbol = geckoData?.tokenSymbol || 'UNKNOWN';
      name = geckoData?.tokenName || 'Unknown Token';
    }
    
    // Use GeckoTerminal data if on-chain values are empty or default
    const finalDecimals = decimals || geckoData?.decimals || 18;
    const finalSymbol = (!symbol || symbol === 'UNKNOWN' || symbol.trim() === '') && geckoData?.tokenSymbol 
      ? geckoData.tokenSymbol 
      : symbol;
    const finalName = (!name || name === 'Unknown Token' || name.trim() === '') && geckoData?.tokenName 
      ? geckoData.tokenName 
      : name;
    
    // Fetch totalSupply with retry logic to handle network errors
    let totalSupply = BigInt(0);
    let supplyError = null;
    
    // Try up to 3 times with delays
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        }
        totalSupply = await contract.totalSupply();
        supplyError = null;
        break;
      } catch (e) {
        supplyError = e;
        console.error(`TotalSupply fetch attempt ${attempt + 1} failed for ${tokenAddress}:`, e.message);
      }
    }
    
    if (supplyError) {
      console.warn('Could not fetch totalSupply after retries, using 0');
    }
    
    const usedGeckoFallback = (symbol === 'UNKNOWN' || name === 'Unknown Token') && geckoData;
    
    console.log('On-chain data fetched:', { 
      tokenAddress, 
      decimals: finalDecimals, 
      symbol: finalSymbol, 
      name: finalName, 
      totalSupply: totalSupply.toString(), 
      hasSupply: totalSupply > 0,
      usedGeckoFallback: usedGeckoFallback ? true : false
    });
    
    return {
      decimals: finalDecimals,
      symbol: finalSymbol,
      name: finalName,
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
      responses.push({
        message: `Hmm, I couldn't find ${token} on Somnia! 😕 Make sure you spelled it right or try a different token. Maybe it's listed somewhere else?`,
        poolAddress: null
      });
      continue;
    }
    
    // 2. Get market data if we have pool
    let marketData = null;
    if (searchResult.poolAddress) {
      marketData = await getMarketData(searchResult.poolAddress);
    }
    
    // 3. Get on-chain data (pass GeckoTerminal data as fallback)
    const onChainData = await getTokenOnChainData(searchResult.tokenAddress, provider, {
      tokenSymbol: searchResult.tokenSymbol,
      tokenName: searchResult.tokenName,
      decimals: searchResult.decimals
    });
    
    // 4. Extract metric and format response
    let response = formatMetricResponse(
      token,
      searchResult,
      marketData,
      onChainData,
      metric,
      timeframe
    );
    
    responses.push({
      message: response,
      poolAddress: searchResult.poolAddress
    });
  }
  
  return responses;
}

/**
 * Format metric response based on user query
 */
function formatMetricResponse(token, searchResult, marketData, onChainData, metric, timeframe = '24h') {
  // Helper to add pool link if available
  const addPoolLink = (msg) => {
    if (searchResult.poolAddress) {
      const poolUrl = getChartUrl(searchResult.poolAddress);
      return msg + `\n\n🔗 Pool & Chart: ${poolUrl}`;
    }
    return msg;
  };
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
      return addPoolLink(`💰 Hey! ${token} is sitting at $${marketData.price.toFixed(6)} right now! 📈`);
      
    case 'volume':
      const volume = marketData[`volume${timeframe}`] || marketData.volume24h || 0;
      const volFormatted = formatNumber(volume);
      return addPoolLink(`📊 ${token} did $${volFormatted} in ${timeframeLabel} volume - ${volume > 100000 ? 'that\'s solid! 🚀' : 'not bad! 👍'}`);
      
    case 'mcap':
    case 'marketcap':
      console.log('Market cap calculation - searchResult.fdv_usd:', searchResult.fdv_usd, 'price:', marketData.price, 'onChainData:', onChainData ? 'exists' : 'null', 'totalSupply:', onChainData?.totalSupply);
      // Priority: 1) FDV from GeckoTerminal, 2) On-chain calculation, 3) Fallback
      let mcap = 0;
      
      if (searchResult.fdv_usd && searchResult.fdv_usd > 0) {
        // Use FDV from GeckoTerminal (most accurate)
        mcap = searchResult.fdv_usd;
        console.log('Using FDV from GeckoTerminal:', mcap);
      } else if (marketData.price > 0 && onChainData && onChainData.totalSupply && onChainData.totalSupply !== '0') {
        // Calculate from price * supply
        const decimals = onChainData.decimals || 18;
        const supply = parseFloat(ethers.formatUnits(onChainData.totalSupply, decimals));
        mcap = marketData.price * supply;
        console.log('Calculated market cap from on-chain:', mcap, 'supply:', supply);
      } else {
        // Fallback to liquidity estimate
        mcap = marketData.reserveUSD * 2;
        console.log('Using fallback market cap (liquidity * 2):', mcap);
      }
      return addPoolLink(`💎 ${token}'s market cap is around $${formatNumber(mcap)} - that's ${mcap > 1000000 ? 'pretty healthy! 💪' : 'growing! 🌱'}`);
      
    case 'liquidity':
      const liqFormatted = formatNumber(marketData.reserveUSD);
      return addPoolLink(`💧 ${token} has $${liqFormatted} in liquidity - ${marketData.reserveUSD > 100000 ? 'solid depth! ✅' : 'getting there! 📊'}`);
      
    case 'change':
    case 'price_change':
      const change = marketData[`change${timeframe}`] || marketData.change24h || 0;
      const emoji = change >= 0 ? '📈' : '📉';
      return addPoolLink(`${emoji} ${token} is ${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(2)}% in the last ${timeframeLabel} - ${Math.abs(change) > 10 ? 'nice move! 💰' : 'steady as she goes! 😎'}`);
      
    case 'holders':
      // GeckoTerminal doesn't provide holders, would need to query from blockchain
      return `👥 Holders count for ${token} isn't available from pool data - but you're part of the fam! 🎉`;
      
    default:
      // Return general info if no specific metric
      return formatGeneralInfo(token, searchResult, marketData, onChainData);
  }
}

/**
 * Format general token info
 */
function formatGeneralInfo(token, searchResult, marketData, onChainData) {
  console.log('formatGeneralInfo - searchResult.fdv_usd:', searchResult.fdv_usd, 'onChainData:', onChainData ? 'exists' : 'null', 'totalSupply:', onChainData?.totalSupply);
  
  // Calculate market cap - Priority: FDV > On-chain > Fallback
  let mcap = 0;
  if (searchResult.fdv_usd && searchResult.fdv_usd > 0) {
    mcap = searchResult.fdv_usd;
    console.log('General info - using FDV from GeckoTerminal:', mcap);
  } else if (marketData.price > 0 && onChainData && onChainData.totalSupply && onChainData.totalSupply !== '0') {
    const decimals = onChainData.decimals || 18;
    const supply = parseFloat(ethers.formatUnits(onChainData.totalSupply, decimals));
    mcap = marketData.price * supply;
    console.log('General info - calculated market cap:', mcap);
  } else {
    // Fallback to liquidity estimate if we don't have on-chain data
    mcap = marketData.reserveUSD * 2;
    console.log('General info - using fallback market cap:', mcap);
  }
  
  // Format price with appropriate decimals
  const priceFormatted = marketData.price > 0.01 
    ? marketData.price.toFixed(4) 
    : marketData.price.toFixed(6);
  
  let info = `📊 ${token} Info - Let's see what's going on! 📈

💵 Price: $${priceFormatted}
💎 Market Cap: $${formatNumber(mcap)}`;
  
  info += `
💧 Liquidity: $${formatNumber(marketData.reserveUSD)}
📊 24h Volume: $${formatNumber(marketData.volume24h)}
📈 24h Change: ${marketData.change24h >= 0 ? '+' : ''}${marketData.change24h.toFixed(2)}%

📍 Contract: ${searchResult.tokenAddress}`;
  
  // Add pool link and chart if available
  if (searchResult.poolAddress) {
    const poolUrl = getChartUrl(searchResult.poolAddress);
    info += `\n\n🔗 Pool: ${poolUrl}`;
  }
  
  info += `\n\n${marketData.change24h > 5 ? '🚀 Looking good! Trending up!' : marketData.change24h < -5 ? '📉 Taking a breather!' : '😎 Steady flow!'}`;
  
  return info;
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
 * @param {string} poolAddress - Pool contract address (with or without network prefix)
 * @returns {string} Chart URL
 */
export function getChartUrl(poolAddress) {
  // Handle both formats: "0x..." or "somnia_0x..."
  const poolId = poolAddress.includes('_') ? poolAddress : `${SOMNIA_NETWORK}_${poolAddress}`;
  return `https://www.geckoterminal.com/${SOMNIA_NETWORK}/pools/${poolAddress}`;
}

/**
 * Take a screenshot of GeckoTerminal chart
 * @param {string} poolAddress - Pool contract address
 * @returns {Promise<Buffer|null>} Screenshot buffer or null if failed
 */
export async function getChartScreenshot(poolAddress) {
  let browser = null;
  try {
    const chartUrl = getChartUrl(poolAddress);
    
    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();
    
    // Set viewport for chart (larger to capture more of the page)
    await page.setViewport({ width: 1280, height: 720 });
    
    // Navigate to chart page with longer timeout and less strict wait
    await page.goto(chartUrl, {
      waitUntil: 'domcontentloaded', // Less strict - just wait for DOM, not all network
      timeout: 60000 // 60 seconds timeout
    }).catch(async (error) => {
      // If navigation times out, try to continue anyway
      console.warn('Navigation timeout, continuing with screenshot attempt:', error.message);
    });
    
    // Wait for chart to load - give it more time
    await new Promise(resolve => setTimeout(resolve, 8000));
    
    // Try to wait for chart canvas or any chart-related element (with shorter timeout)
    try {
      await page.waitForSelector('canvas, [class*="chart"], [id*="chart"]', { timeout: 5000 }).catch(() => {});
    } catch (e) {
      // Ignore if selector not found - we'll screenshot anyway
      console.log('Chart element not found, will screenshot viewport');
    }
    
    // Take screenshot - wait for actual chart content to be visible
    let screenshot;
    try {
      // Wait a bit more for chart to fully render
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Scroll down a bit to ensure chart is in view
      await page.evaluate(() => {
        window.scrollBy(0, 125); // Scroll down 125px
      });
      await new Promise(resolve => setTimeout(resolve, 500)); // Wait for scroll to settle
      
      // Check if page has loaded content (not blank)
      const pageContent = await page.content();
      if (!pageContent || pageContent.length < 1000) {
        throw new Error('Page content too small, likely blank');
      }
      
      // Try to find and screenshot the chart canvas specifically
      const canvas = await page.$('canvas');
      if (canvas) {
        const boundingBox = await canvas.boundingBox();
        if (boundingBox && boundingBox.width > 100 && boundingBox.height > 100) {
          screenshot = await canvas.screenshot({ type: 'png' });
        }
      }
      
      // If canvas screenshot didn't work, try full viewport
      if (!screenshot) {
        screenshot = await page.screenshot({
          type: 'png',
          clip: { x: 0, y: 100, width: 1280, height: 600 } // Skip header, get chart area
        });
      }
      
      // Verify screenshot isn't blank
      if (!screenshot || screenshot.length < 1000) {
        throw new Error('Screenshot appears blank');
      }
    } catch (e) {
      console.error('Screenshot attempt failed:', e.message);
      // Final fallback - just screenshot the viewport
      screenshot = await page.screenshot({ type: 'png', fullPage: false });
    }
    
    await browser.close();
    return screenshot;
    
  } catch (error) {
    console.error('Chart screenshot error:', error.message);
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    // Return null on error - bot will continue without screenshot
    return null;
  }
}


