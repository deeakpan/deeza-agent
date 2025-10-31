// support/swap.js
import { ethers } from 'ethers';

const ROUTER_ADDRESS = '0xCdE9aFDca1AdAb5b5C6E4F9e16c9802C88Dc7e1A';
const WETH_ADDRESS = '0x046EDe9564A72571df6F5e44d0405360c0f4dCab';
const SOMNIA_EXPLORER = 'https://explorer.somnia.network/';
const ROUTER_ABI = [
  'function WETH() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)'
];

const TIER_LIMIT = parseFloat(process.env.TIER_LIMIT) || 1;

const SOMI_POOL_ADDRESS = '0x70d069acda32ce9a2e13cfbcbf33ba39bc151517f5133fa9cd0ecee8849a6129';
const GECKOTERMINAL_API = `https://api.geckoterminal.com/api/v2/networks/eth/pools/${SOMI_POOL_ADDRESS}`;

async function getSTTPrice() {
  try {
    const res = await fetch(GECKOTERMINAL_API);
    const data = await res.json();
    return parseFloat(data?.data?.attributes?.base_token_price_usd) || 0;
  } catch {
    return 0;
  }
}

async function getNativeBalance(provider, address) {
  const bal = await provider.getBalance(address);
  return parseFloat(ethers.formatEther(bal));
}

export async function quoteEthToToken(params, userData, provider) {
  const tokenOut = params.token_out || params.token || params.token_address;
  if (!tokenOut) return { success: false, message: 'Token address is required for quote.' };

  let somiAmountStr = String(params.amount_eth || params.eth || params.value || '0');
  let amountFromUsd = false;
  if (params.amount_usd && !params.amount_eth) {
    const somiPrice = await getSTTPrice();
    if (!somiPrice) return { success: false, message: 'Could not fetch SOMI price for USD->SOMI conversion.' };
    somiAmountStr = (parseFloat(params.amount_usd) / somiPrice).toFixed(6);
    amountFromUsd = true;
  }
  const somiAmount = parseFloat(somiAmountStr);
  if (somiAmount <= 0) return { success: false, message: 'Amount must be greater than 0.' };

  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);
  const valueInWei = ethers.parseEther(somiAmountStr);
  const path = [WETH_ADDRESS, tokenOut];
  const amounts = await router.getAmountsOut(valueInWei, path);
  const expectedOut = amounts[amounts.length - 1];
  const slippageBps = params.slippage_bps ? BigInt(params.slippage_bps) : 100n;
  const amountOutMin = (expectedOut * (10000n - slippageBps)) / 10000n;

  return {
    success: true,
    data: { somiAmountStr, amountFromUsd, expectedOut, amountOutMin, path },
    message: `Quote\n\nIn: ${somiAmountStr} SOMI${amountFromUsd ? ' (~$' + params.amount_usd + ' USD)' : ''}\nEst Out: ${ethers.formatUnits(expectedOut, 18)} tokens\nMin Out (@${Number(slippageBps)/100}% slippage): ${ethers.formatUnits(amountOutMin, 18)}\n\nReply "yes" to confirm, or "no" to cancel.`
  };
}

export async function swapEthToToken(params, userData, provider) {
  if (!userData.privateKey) return { success: false, message: 'Wallet not available.' };
  const wallet = new ethers.Wallet(userData.privateKey, provider);

  let somiAmountStr = String(params.amount_eth || params.eth || params.value || '0');
  let amountFromUsd = false;
  if (params.amount_usd && !params.amount_eth) {
    const somiPrice = await getSTTPrice();
    if (!somiPrice) return { success: false, message: 'Could not fetch SOMI price for USD->SOMI conversion.' };
    somiAmountStr = (parseFloat(params.amount_usd) / somiPrice).toFixed(6);
    amountFromUsd = true;
  }
  const somiAmount = parseFloat(somiAmountStr);

  const userTier = userData.tier || 'regular';
  if (userTier === 'regular' && somiAmount > TIER_LIMIT) {
    return { success: false, message: `Bro, you need to upgrade for bigger swaps! Regulars max = ${TIER_LIMIT} SOMI per swap 😉` };
  }

  const nativeBal = await getNativeBalance(provider, userData.wallet_address);
  if (nativeBal < somiAmount + 0.1) {
    return { success: false, message: `You only have ${nativeBal.toFixed(6)} SOMI. Not enough to swap (need swap amount + 0.1 for gas). Top up, bro!` };
  }

  const tokenOut = params.token_out || params.token || params.token_address;
  if (!tokenOut) {
    return { success: false, message: 'Token address is required for swap.' };
  }
  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const recipient = params.recipient && params.recipient.startsWith('0x') ? params.recipient : await wallet.getAddress();
  const valueInWei = ethers.parseEther(somiAmountStr);
  const path = [WETH_ADDRESS, tokenOut];
  const amounts = await router.getAmountsOut(valueInWei, path);
  const expectedOut = amounts[amounts.length - 1];
  const slippageBps = params.slippage_bps ? BigInt(params.slippage_bps) : 100n; // default 1%
  const amountOutMin = (expectedOut * (10000n - slippageBps)) / 10000n;
  const ttlSec = Number(params.ttl_seconds || 600);
  const deadline = Math.floor(Date.now() / 1000) + ttlSec;
  const tx = await router.swapExactETHForTokens(
    amountOutMin,
    path,
    recipient,
    deadline,
    { value: valueInWei }
  );
  await tx.wait();
  return {
    success: true,
    message: `Swap executed!\n\nIn: ${somiAmountStr} SOMI${amountFromUsd ? ' (~$' + params.amount_usd + ' USD)' : ''}\nMin Out: ${ethers.formatUnits(amountOutMin, 18)} tokens\n\nView: ${SOMNIA_EXPLORER}tx/${tx.hash}`
  };
}
