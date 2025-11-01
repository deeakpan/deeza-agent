// Lighthouse IPFS Integration
import { upload } from '@lighthouse-web3/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LIGHTHOUSE_API_KEY = process.env.LIGHTHOUSE_API_KEY;

/**
 * Upload JSON data to Lighthouse IPFS
 * @param {Object} data - JSON data to upload (Q&A for gifts)
 * @returns {Promise<string>} IPFS hash/link
 */
export async function uploadToIPFS(data) {
  try {
    if (!LIGHTHOUSE_API_KEY) {
      throw new Error('LIGHTHOUSE_API_KEY not set in .env');
    }

    // Create temp file
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFile = path.join(tempDir, `gift-${Date.now()}.json`);
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));

    // Upload to Lighthouse
    const response = await upload(tempFile, LIGHTHOUSE_API_KEY);
    
    // Clean up temp file
    fs.unlinkSync(tempFile);
    
    if (response && response.data && response.data.Hash) {
      return `https://gateway.lighthouse.storage/ipfs/${response.data.Hash}`;
    }

    throw new Error('Invalid response from Lighthouse');
  } catch (error) {
    console.error('Lighthouse upload error:', error);
    throw error;
  }
}

/**
 * Fetch JSON data from IPFS
 * @param {string} ipfsLink - IPFS link/hash
 * @returns {Promise<Object>} Parsed JSON data
 */
export async function fetchFromIPFS(ipfsLink) {
  try {
    // Handle both full URLs and hashes
    let url = ipfsLink;
    if (ipfsLink.startsWith('Qm') || ipfsLink.startsWith('baf')) {
      url = `https://gateway.lighthouse.storage/ipfs/${ipfsLink}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch from IPFS: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('IPFS fetch error:', error);
    throw error;
  }
}
