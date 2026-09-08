import { ethers } from 'ethers';
import { config, ASSETS, type AssetSymbol } from '../config';
import { redis, isPrimaryRPCFailed, markPrimaryRPCFailed } from './redis';
import { logger } from '../utils/logger';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
];

class BlockchainService {
  private primaryProvider: ethers.JsonRpcProvider;
  private fallbackProviders: ethers.JsonRpcProvider[];
  private currentProvider: ethers.JsonRpcProvider;
  private providerIndex: number = 0;
  private lastPrimaryCheck: number = 0;

  constructor() {
    this.primaryProvider = new ethers.JsonRpcProvider(config.BSC_PRIMARY_RPC, {
      name: 'bnb',
      chainId: config.BSC_CHAIN_ID,
    });
    
    this.fallbackProviders = config.BSC_PUBLIC_RPCS.map(url => 
      new ethers.JsonRpcProvider(url, {
        name: 'bnb',
        chainId: config.BSC_CHAIN_ID,
      })
    );
    
    this.currentProvider = this.primaryProvider;
    this.startHealthCheck();
  }

  private startHealthCheck(): void {
    setInterval(async () => {
      try {
        await this.primaryProvider.getBlockNumber();
        const failed = await isPrimaryRPCFailed();
        if (failed) {
          logger.info('Primary RPC recovered, switching back');
          this.currentProvider = this.primaryProvider;
          await redis.del('rpc:primary:failed');
        }
      } catch {
        // Primary still down
      }
    }, 30000);
  }

  private async getProvider(): Promise<ethers.JsonRpcProvider> {
    const primaryFailed = await isPrimaryRPCFailed();
    
    if (!primaryFailed) {
      try {
        await this.primaryProvider.getBlockNumber();
        return this.primaryProvider;
      } catch (err) {
        logger.warn('Primary RPC failed, switching to fallback');
        await markPrimaryRPCFailed();
      }
    }
    
    // Try fallbacks
    for (let i = 0; i < this.fallbackProviders.length; i++) {
      const idx = (this.providerIndex + i) % this.fallbackProviders.length;
      try {
        await this.fallbackProviders[idx].getBlockNumber();
        this.providerIndex = idx;
        return this.fallbackProviders[idx];
      } catch {
        continue;
      }
    }
    
    throw new Error('All RPC providers unavailable');
  }

  async getBalance(address: string, asset: AssetSymbol): Promise<bigint> {
    const provider = await this.getProvider();
    
    if (asset === 'BNB') {
      return await provider.getBalance(address);
    }
    
    const assetConfig = ASSETS[asset];
    if (!assetConfig.contractAddress) throw new Error(`No contract for ${asset}`);
    
    const contract = new ethers.Contract(assetConfig.contractAddress, ERC20_ABI, provider);
    return await contract.balanceOf(address);
  }

  async sendTransaction(
    encryptedPrivateKey: string,
    to: string,
    amount: bigint,
    asset: AssetSymbol,
    idempotencyKey: string
  ): Promise<{ hash: string; nonce: number }> {
    const provider = await this.getProvider();
    const privateKey = await import('../utils/encryption').then(m => m.decrypt(encryptedPrivateKey));
    const wallet = new ethers.Wallet(privateKey, provider);
    
    let tx: ethers.TransactionResponse;
    
    if (asset === 'BNB') {
      tx = await wallet.sendTransaction({
        to,
        value: amount,
        nonce: await this.getNonce(wallet.address),
      });
    } else {
      const assetConfig = ASSETS[asset];
      if (!assetConfig.contractAddress) throw new Error(`No contract for ${asset}`);
      
      const contract = new ethers.Contract(assetConfig.contractAddress, ERC20_ABI, wallet);
      tx = await contract.transfer(to, amount, {
        nonce: await this.getNonce(wallet.address),
      });
    }
    
    return { hash: tx.hash, nonce: tx.nonce };
  }

  private nonceCache = new Map<string, number>();
  
  private async getNonce(address: string): Promise<number> {
    const cached = this.nonceCache.get(address);
    const provider = await this.getProvider();
    const networkNonce = await provider.getTransactionCount(address, 'pending');
    
    if (cached !== undefined && cached >= networkNonce) {
      this.nonceCache.set(address, cached + 1);
      return cached + 1;
    }
    
    this.nonceCache.set(address, networkNonce);
    return networkNonce;
  }

  async getTransactionReceipt(hash: string): Promise<ethers.TransactionReceipt | null> {
    const provider = await this.getProvider();
    return await provider.getTransactionReceipt(hash);
  }

  async waitForConfirmations(
    hash: string,
    requiredConfirmations: number = 15,
    timeoutMs: number = 300000
  ): Promise<ethers.TransactionReceipt> {
    const provider = await this.getProvider();
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt && receipt.confirmations >= requiredConfirmations) {
        return receipt;
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    
    throw new Error('Transaction confirmation timeout');
  }

  async validateAddress(address: string): Promise<boolean> {
    return ethers.isAddress(address);
  }

  async getGasPrice(): Promise<bigint> {
    const provider = await this.getProvider();
    const feeData = await provider.getFeeData();
    return feeData.gasPrice || BigInt(5000000000);
  }

  async estimateGas(asset: AssetSymbol, from: string, to: string, amount: bigint): Promise<bigint> {
    const provider = await this.getProvider();
    
    if (asset === 'BNB') {
      return await provider.estimateGas({
        from,
        to,
        value: amount,
      });
    }
    
    const assetConfig = ASSETS[asset];
    const contract = new ethers.Contract(assetConfig.contractAddress!, ERC20_ABI, provider);
    return await contract.transfer.estimateGas(to, amount, { from });
  }

  generateWallet(): { address: string; privateKey: string; mnemonic: string } {
    const wallet = ethers.Wallet.createRandom();
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic: wallet.mnemonic?.phrase || '',
    };
  }

  async getTokenTransferEvents(
    asset: AssetSymbol,
    toAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<Array<{ from: string; to: string; amount: bigint; txHash: string; blockNumber: number }>> {
    if (asset === 'BNB') return []; // Native transfers need different approach
    
    const provider = await this.getProvider();
    const assetConfig = ASSETS[asset];
    const contract = new ethers.Contract(assetConfig.contractAddress!, ERC20_ABI, provider);
    
    const filter = contract.filters.Transfer(null, toAddress);
    const events = await contract.queryFilter(filter, fromBlock, toBlock);
    
    return events.map(event => ({
      from: (event as ethers.EventLog).args?.from || '',
      to: (event as ethers.EventLog).args?.to || '',
      amount: (event as ethers.EventLog).args?.amount || BigInt(0),
      txHash: event.transactionHash,
      blockNumber: event.blockNumber,
    }));
  }
}

export const blockchain = new BlockchainService();
      
