import lighthouse from '@lighthouse-web3/sdk';

/**
 * Upload data to IPFS using Lighthouse
 * @param {Object} data - Data to upload
 * @returns {Promise<string>} - IPFS link
 */
export async function uploadToIPFS(data) {
  try {
    const apiKey = process.env.LIGHTHOUSE_API_KEY;
    
    if (!apiKey) {
      throw new Error('LIGHTHOUSE_API_KEY not found in environment variables');
    }

    // Convert data to string
    const dataString = JSON.stringify(data);
    
    // Upload text to Lighthouse
    const response = await lighthouse.uploadText(dataString, apiKey);
    
    if (!response || !response.data || !response.data.Hash) {
      throw new Error('Invalid response from Lighthouse');
    }

    const ipfsHash = response.data.Hash;
    const ipfsLink = `https://gateway.lighthouse.storage/ipfs/${ipfsHash}`;
    
    console.log(`✅ IPFS Upload Success: ${ipfsLink}`);
    return ipfsLink;
  } catch (error) {
    console.error('Lighthouse upload error:', error);
    throw error;
  }
}

/**
 * Fetch data from IPFS using Lighthouse
 * @param {string} ipfsLink - IPFS link or hash
 * @returns {Promise<Object>} - Parsed data
 */
export async function fetchFromIPFS(ipfsLink) {
  try {
    // Extract hash from link if needed
    let hash = ipfsLink;
    if (ipfsLink.includes('ipfs/')) {
      hash = ipfsLink.split('ipfs/')[1];
    }

    // Fetch from Lighthouse gateway
    const url = `https://gateway.lighthouse.storage/ipfs/${hash}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch from IPFS: ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`✅ IPFS Fetch Success: ${hash}`);
    return data;
  } catch (error) {
    console.error('Lighthouse fetch error:', error);
    throw error;
  }
}