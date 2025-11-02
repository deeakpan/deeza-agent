// Simple script to check if a gift code exists
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const IS_TESTNET = process.env.IS_TESTNET === 'true';
const RPC_URL = process.env.SOMNIA_RPC || (IS_TESTNET ? 'https://dream-rpc.somnia.network' : 'https://somnia.publicnode.com');
const CHAIN_ID = parseInt(process.env.SOMNIA_CHAIN_ID || (IS_TESTNET ? '50312' : '50311'));
const CONTRACT_ADDRESS = process.env.DEEZA_AGENT_CONTRACT || '0xC68AA8EE564a70F2Be313CEA039F062D8f818744';

// Contract ABI (just getGift function)
const CONTRACT_ABI = [
  'function getGift(bytes32 id) external view returns (tuple(address gifter, address token, uint256 amount, string code, string ipfsLink, address claimer, uint256 claimDeadline, uint8 attempts, bool deposited, bool claimed))'
];

async function checkGift(code) {
  try {
    console.log(`Checking gift code: "${code}"`);
    console.log(`Contract: ${CONTRACT_ADDRESS}`);
    console.log(`Network: ${IS_TESTNET ? 'TESTNET' : 'MAINNET'}`);
    console.log(`RPC: ${RPC_URL}`);
    console.log('---\n');

    // Connect to provider
    const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: 'somnia' });
    
    // Override network detection to avoid errors
    provider._detectNetwork = async () => {
      return { chainId: BigInt(CHAIN_ID), name: 'somnia' };
    };
    
    // Connect to contract
    const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

    // Convert code to bytes32
    const giftId = ethers.id(code);
    console.log(`Gift ID (bytes32): ${giftId}`);
    console.log(`Gift ID (hex): ${ethers.hexlify(giftId)}\n`);

    // Get gift data using direct RPC call to avoid network detection issues
    console.log('Fetching gift data from contract...');
    let gift;
    
    try {
      const result = await provider.call({
        to: CONTRACT_ADDRESS,
        data: contract.interface.encodeFunctionData('getGift', [giftId])
      });
      
      const decoded = contract.interface.decodeFunctionResult('getGift', result);
      gift = {
        gifter: decoded[0],
        token: decoded[1],
        amount: decoded[2],
        code: decoded[3],
        ipfsLink: decoded[4],
        claimer: decoded[5],
        claimDeadline: decoded[6],
        attempts: decoded[7],
        deposited: decoded[8],
        claimed: decoded[9]
      };
    } catch (error) {
      if (error.message?.includes('out of result range') || error.message?.includes('invalid codepoint')) {
        console.log('❌ Gift NOT FOUND');
        console.log('The gift code does not exist on the contract.');
        return;
      }
      throw error;
    }

    // Check if gift exists (if code is empty, gift doesn't exist)
    if (!gift.code || gift.code === '' || gift.code === null) {
      console.log('❌ Gift NOT FOUND');
      console.log('The gift code does not exist on the contract.');
      return;
    }

    console.log('✅ Gift FOUND!\n');
    console.log('Gift Details:');
    console.log(`  Code: ${gift.code}`);
    console.log(`  Gifter: ${gift.gifter}`);
    console.log(`  Token: ${gift.token === ethers.ZeroAddress ? 'Native (STT/SOMI)' : gift.token}`);
    console.log(`  Amount: ${ethers.formatEther(gift.amount)} tokens`);
    console.log(`  IPFS Link: ${gift.ipfsLink}`);
    console.log(`  Claimer: ${gift.claimer === ethers.ZeroAddress ? 'None' : gift.claimer}`);
    console.log(`  Deposited: ${gift.deposited ? 'Yes ✅' : 'No ❌'}`);
    console.log(`  Claimed: ${gift.claimed ? 'Yes ✅' : 'No ❌'}`);
    console.log(`  Attempts: ${gift.attempts}`);
    
    if (gift.claimDeadline > 0) {
      const deadline = new Date(Number(gift.claimDeadline) * 1000);
      console.log(`  Claim Deadline: ${deadline.toISOString()}`);
      const now = new Date();
      const isExpired = deadline < now;
      console.log(`  Status: ${isExpired ? '⏰ EXPIRED' : '⏳ Active'}`);
    }

  } catch (error) {
    if (error.reason || error.message) {
      console.error('❌ Error:', error.reason || error.message);
    } else {
      console.error('❌ Error:', error);
    }
    
    if (error.message?.includes('network')) {
      console.error('\n💡 Tip: Check your RPC URL and network connection.');
    }
  }
}

// Get gift code from command line argument or use default
const giftCode = process.argv[2] || 'd2eakpan';

checkGift(giftCode)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

