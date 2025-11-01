// Deploy ZAZZ Token for Testnet
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const IS_TESTNET = process.env.IS_TESTNET === 'true';
const RPC_URL = process.env.SOMNIA_RPC || (IS_TESTNET ? 'https://dream-rpc.somnia.network' : 'https://somnia.publicnode.com');
const CHAIN_ID = parseInt(process.env.SOMNIA_CHAIN_ID || (IS_TESTNET ? '50312' : '50311'));

async function deployZazz() {
  console.log('Deploying ZAZZ Token...');
  console.log(`Network: ${IS_TESTNET ? 'TESTNET' : 'MAINNET'}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Chain ID: ${CHAIN_ID}`);

  if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY not set in .env');
  }

  // Load contract
  const contractPath = './artifacts/contracts/ZAZZ.sol/ZAZZ.json';
  if (!fs.existsSync(contractPath)) {
    throw new Error('ZAZZ contract not compiled. Run: npx hardhat compile');
  }

  const contractArtifact = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: 'somnia' });
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log(`Deploying from: ${wallet.address}`);
  console.log(`Bot wallet will be owner (can mint tokens)`);

  // Check balance using direct RPC call to avoid network detection issues
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
  
  // Bot wallet deploys and becomes owner (can mint tokens)
  const contract = await factory.deploy(wallet.address);
  await contract.waitForDeployment();
  
  const address = await contract.getAddress();
  console.log(`✅ ZAZZ Token deployed at: ${address}`);
  console.log(`\nAdd to .env:`);
  console.log(`ZAZZ_TOKEN_ADDRESS=${address}`);
  
  return address;
}

deployZazz()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
