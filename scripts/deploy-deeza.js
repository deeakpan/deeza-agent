// Deploy Deeza Token to Somnia
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

async function main() {
  console.log('Deploying Deeza token to Somnia testnet...');
  
  // Load compiled contract
  const contractData = JSON.parse(fs.readFileSync('./artifacts/contracts/Deeza.sol/Deeza.json', 'utf8'));
  
  // Connect to Somnia testnet
  const provider = new ethers.JsonRpcProvider('https://dream-rpc.somnia.network/');
  
  if (!process.env.PRIVATE_KEY) {
    console.error('ERROR: PRIVATE_KEY not set in .env file');
    return;
  }

  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  
  console.log('Deploying with account:', wallet.address);
  
  const balance = await provider.getBalance(wallet.address);
  console.log('Account balance:', ethers.formatEther(balance), 'STT');
  
  if (balance === 0n) {
    console.log('No STT tokens! Get some from: testnet.somnia.network/faucet');
    return;
  }

  console.log('Deploying contract...');
  
  const factory = new ethers.ContractFactory(contractData.abi, contractData.bytecode, wallet);
  const contract = await factory.deploy();
  
  console.log('Waiting for deployment...');
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  
  console.log('');
  console.log('Deeza Token deployed successfully!');
  console.log('');
  console.log('Contract Details:');
  console.log(`  Name: Deeza`);
  console.log(`  Symbol: DEEZA`);
  console.log(`  Decimals: 18`);
  console.log(`  Address: ${contractAddress}`);
  console.log(`  Owner: ${wallet.address}`);
  console.log('');
  console.log('Features:');
  console.log(`  mint(address to, uint256 amount) - owner only`);
  console.log(`  burn(uint256 amount) - burn your tokens`);
  console.log('');
  console.log('Add to your .env file:');
  console.log(`DEEZA_TOKEN_ADDRESS=${contractAddress}`);
  console.log('');
  console.log('Explorer:');
  console.log(`https://shannon-explorer.somnia.network/address/${contractAddress}`);
}

main().catch(console.error);
