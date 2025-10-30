// Deploy DeezaBridge Contract to Somnia
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

async function main() {
  console.log('Deploying DeezaBridge contract to Somnia testnet...');
  
  // Load compiled contract
  const contractData = JSON.parse(fs.readFileSync('./artifacts/contracts/DeezaBridge.sol/DeezaBridge.json', 'utf8'));
  
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
  console.log('DeezaBridge Contract deployed successfully!');
  console.log('');
  console.log('Contract Details:');
  console.log(`  Address: ${contractAddress}`);
  console.log(`  Owner: ${wallet.address}`);
  console.log(`  USDC Address: 0x3EEbd3c3F5Bf02923E14c6288C7d241C77D83ef7`);
  console.log('');
  console.log('Functions:');
  console.log(`  bridgeUSDC(uint256 amount) - Send USDC to bridge (auto-forwards to owner)`);
  console.log(`  bridgeSTT() payable - Send STT to bridge (auto-forwards to owner)`);
  console.log(`  receive() - Accept STT directly`);
  console.log(`  withdrawSTT() - Withdraw any stuck STT (owner only)`);
  console.log(`  withdrawUSDC() - Withdraw any stuck USDC (owner only)`);
  console.log(`  getBalances() - Get contract balances`);
  console.log('');
  console.log('Add to your .env file:');
  console.log(`BRIDGE_CONTRACT_ADDRESS=${contractAddress}`);
  console.log('');
  console.log('Explorer:');
  console.log(`https://shannon-explorer.somnia.network/address/${contractAddress}`);
}

main().catch(console.error);

