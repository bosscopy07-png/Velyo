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

/** Hard cap on any single RPC call — hung public nodes must fail, not freeze */
const RPC_TIMEOUT_MS = 15000;

class BlockchainService {
  private primaryProvider: ethers.JsonRpcProvider;
  private fallbackProviders: ethers.JsonRpcProvider[];
  private currentProvider: ethers.JsonRpcProvider;
  private providerIndex: number = 0;

  /**
   * Per-address send queue. ALL outgoing transactions from one wallet are
   * serialized through this queue — that prevents "gapped nonce" rejections
   * when a gas-seed tx and a payout tx fire in quick succession.
   */
  private sendQueues = new Map<string, Promise<{ hash: string; nonce: number }>>();

  constructor() {
    const network = new ethers.Network('bnb', config.BSC_CHAIN_ID);

    // Every provider gets a hard timeout. Public nodes under rate-limit
    // pressure HANG instead of erroring — without this, awaits block forever
    // and Telegraf kills handlers at 90s.
    const makeProvider = (url: string): ethers.JsonRpcProvider => {
      const request = new ethers.FetchRequest(url);
      request.timeout = RPC_TIMEOUT_MS;
      return new ethers.JsonRpcProvider(request, network, { staticNetwork: network });
    };

    this.primaryProvider = makeProvider(config.BSC_PRIMARY_RPC);
    this.fallbackProviders = config.BSC_PUBLIC_RPCS.map(makeProvider);

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

  async getProvider(): Promise<ethers.JsonRpcProvider> {
    return this.resolveProvider();
  }

  private async resolveProvider(): Promise<ethers.JsonRpcProvider> {
    const primaryFailed = await isPrimaryRPCFailed();

    if (!primaryFailed) {
      try {
        await this.primaryProvider.getBlockNumber();
        this.currentProvider = this.primaryProvider;
        return this.primaryProvider;
      } catch (err) {
        logger.warn('Primary RPC failed, switching to fallback');
        await markPrimaryRPCFailed();
      }
    }

    for (let i = 0; i < this.fallbackProviders.length; i++) {
      const idx = (this.providerIndex + i) % this.fallbackProviders.length;
      try {
        await this.fallbackProviders[idx].getBlockNumber();
        this.providerIndex = idx;
        this.currentProvider = this.fallbackProviders[idx];
        return this.fallbackProviders[idx];
      } catch {
        continue;
      }
    }

    throw new Error('All RPC providers unavailable');
  }

  async getBalance(address: string, asset: AssetSymbol): Promise<bigint> {
    const provider = await this.resolveProvider();

    if (asset === 'BNB') {
      return await provider.getBalance(address);
    }

    const assetConfig = ASSETS[asset];
    if (!assetConfig.contractAddress) throw new Error(`No contract for ${asset}`);

    const contract = new ethers.Contract(assetConfig.contractAddress, ERC20_ABI, provider);
    return (await contract.balanceOf(address)) as bigint;
  }

  /**
   * Serialized send: every tx from the same wallet waits for the previous one
   * to at least broadcast. Returns once the tx is accepted by the node.
   */
  async sendTransaction(
    encryptedPrivateKey: string,
    to: string,
    amount: bigint,
    asset: AssetSymbol,
    idempotencyKey: string
  ): Promise<{ hash: string; nonce: number }> {
    const { decrypt } = await import('../utils/encryption');
    const privateKey = decrypt(encryptedPrivateKey);
    const wallet = new ethers.Wallet(privateKey);

    const prev = this.sendQueues.get(wallet.address) ?? Promise.resolve({ hash: '', nonce: 0 });
    const run = prev
      .catch(() => {})
      .then(() => this.doSend(wallet, to, amount, asset));
    this.sendQueues.set(wallet.address, run);
    return run;
  }

  private async doSend(
    wallet: ethers.Wallet,
    to: string,
    amount: bigint,
    asset: AssetSymbol
  ): Promise<{ hash: string; nonce: number }> {
    const provider = await this.resolveProvider();
    const signer = wallet.connect(provider);
    const nonce = await this.getNextNonce(wallet.address, provider);

    try {
      const tx = await this.broadcast(signer, to, amount, asset, nonce);
      return { hash: tx.hash, nonce: tx.nonce };
    } catch (err) {
      const msg = ((err as Error).message ?? '').toLowerCase();
      const isNonceError =
        msg.includes('gapped') ||
        msg.includes('nonce') ||
        msg.includes('already known') ||
        msg.includes('replacement transaction');

      if (isNonceError) {
        logger.warn(`Nonce rejection from ${wallet.address} — refetching and retrying once.`);
        await new Promise((r) => setTimeout(r, 4000));
        const fresh = await this.getNextNonce(wallet.address, provider);
        const tx = await this.broadcast(signer, to, amount, asset, fresh);
        return { hash: tx.hash, nonce: tx.nonce };
      }
      throw err;
    }
  }

  private async broadcast(
    signer: ethers.Wallet,
    to: string,
    amount: bigint,
    asset: AssetSymbol,
    nonce: number
  ): Promise<ethers.TransactionResponse> {
    if (asset === 'BNB') {
      return await signer.sendTransaction({ to, value: amount, nonce });
    }

    const assetConfig = ASSETS[asset];
    if (!assetConfig.contractAddress) throw new Error(`No contract for ${asset}`);

    const contract = new ethers.Contract(assetConfig.contractAddress, ERC20_ABI, signer);
    return (await contract.transfer(to, amount, { nonce })) as ethers.TransactionResponse;
  }

  /**
   * Live pending nonce — no in-memory cache. Combined with the send queue
   * this is race-free: our previous tx is visible in the mempool before the
   * next one asks for a nonce.
   */
  private async getNextNonce(address: string, provider: ethers.JsonRpcProvider): Promise<number> {
    return await provider.getTransactionCount(address, 'pending');
  }

  async getTransactionReceipt(hash: string): Promise<ethers.TransactionReceipt | null> {
    const provider = await this.resolveProvider();
    return await provider.getTransactionReceipt(hash);
  }

  async waitForConfirmations(
    hash: string,
    requiredConfirmations: number = 15,
    timeoutMs: number = 300000
  ): Promise<ethers.TransactionReceipt> {
    const provider = await this.resolveProvider();
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt && (await receipt.confirmations()) >= requiredConfirmations) {
        return receipt;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    throw new Error('Transaction confirmation timeout');
  }

  async validateAddress(address: string): Promise<boolean> {
    return ethers.isAddress(address);
  }

  async getGasPrice(): Promise<bigint> {
    const provider = await this.resolveProvider();
    const feeData = await provider.getFeeData();
    return feeData.gasPrice ?? BigInt(5000000000);
  }

  async estimateGas(asset: AssetSymbol, from: string, to: string, amount: bigint): Promise<bigint> {
    const provider = await this.resolveProvider();

    if (asset === 'BNB') {
      return await provider.estimateGas({ from, to, value: amount });
    }

    const assetConfig = ASSETS[asset];
    const contract = new ethers.Contract(assetConfig.contractAddress!, ERC20_ABI, provider);
    return (await contract.transfer.estimateGas(to, amount, { from })) as bigint;
  }

  generateWallet(): { address: string; privateKey: string; mnemonic: string } {
    const wallet = ethers.Wallet.createRandom();
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic: wallet.mnemonic?.phrase ?? '',
    };
  }

  async getTokenTransferEvents(
    asset: AssetSymbol,
    toAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<Array<{ from: string; to: string; amount: bigint; txHash: string; blockNumber: number }>> {
    if (asset === 'BNB') return [];

    const provider = await this.resolveProvider();
    const assetConfig = ASSETS[asset];
    const contract = new ethers.Contract(assetConfig.contractAddress!, ERC20_ABI, provider);

    const filter = contract.filters.Transfer!(null, toAddress);
    const events = await contract.queryFilter(filter, fromBlock, toBlock);

    return events
      .filter((event): event is ethers.EventLog => 'args' in event && event.args !== undefined)
      .map((event) => ({
        from: String(event.args!.from ?? ''),
        to: String(event.args!.to ?? ''),
        amount: (event.args!.amount as bigint) ?? BigInt(0),
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
      }));
  }
}

export const blockchain = new BlockchainService();
      
