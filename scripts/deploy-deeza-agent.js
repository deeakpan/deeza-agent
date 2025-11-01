// Deploy DeezaAgent Contract
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const IS_TESTNET = process.env.IS_TESTNET === 'true';
const RPC_URL = process.env.SOMNIA_RPC || (IS_TESTNET ? 'https://dream-rpc.somnia.network' : 'https://somnia.publicnode.com');
const CHAIN_ID = parseInt(process.env.SOMNIA_CHAIN_ID || (IS_TESTNET ? '50312' : '50311'));

async function deployDeezaAgent() {
  console.log('Deploying DeezaAgent Contract...');
  console.log(`Network: ${IS_TESTNET ? 'TESTNET' : 'MAINNET'}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Chain ID: ${CHAIN_ID}`);

  if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY not set in .env');
  }

  // Load contract
  const contractPath = './artifacts/contracts/DeezaAgent.sol/DeezaAgent.json';
  if (!fs.existsSync(contractPath)) {
    throw new Error('DeezaAgent contract not compiled. Run: npx hardhat compile');
  }

  const contractArtifact = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: 'somnia' });
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  // Bot wallet is also the deployer/owner
  const botAddress = wallet.address;

  console.log(`Deploying from: ${wallet.address}`);
  console.log(`Bot address (same as deployer): ${botAddress}`);
  console.log(`Bot wallet will be contract owner AND bot role`);

  // Check balance using direct RPC call
  let balance = 0n;
  try {
    const balanceHex = await provider.send('eth_getBalance', [wallet.address, 'latest']);
    balance = BigInt(balanceHex);
    console.log(`Balance: ${ethers.formatEther(balance)} STT`);
  } catch (e) {
    console.warn('Could not check balance:', e.message);
  }

  if (balance === 0n) {
    console.warn('⚠️  Wallet has 0 balance. Fund it before deploying!');
  }

  // Deploy
  const factory = new ethers.ContractFactory(contractArtifact.abi, contractArtifact.bytecode, wallet);
  console.log('Deploying contract...');
  
  // Constructor takes bot address (same as deployer)
  const contract = await factory.deploy(botAddress);
  await contract.waitForDeployment();
  
  const address = await contract.getAddress();
  
  // Verify bot address is set correctly
  const botAddressOnContract = await contract.bot();
  console.log(`\n✅ DeezaAgent deployed at: ${address}`);
  console.log(`Bot address on contract: ${botAddressOnContract}`);
  
  if (botAddressOnContract.toLowerCase() !== botAddress.toLowerCase()) {
    console.warn('⚠️  Bot address mismatch!');
  }
  
  console.log(`\nAdd to .env:`);
  console.log(`DEEZA_AGENT_CONTRACT=${address}`);
  console.log(`\nNote: Bot wallet is owner and bot role`);
  
  return address;
}

deployDeezaAgent()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });