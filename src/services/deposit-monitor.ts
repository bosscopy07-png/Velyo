import { prisma } from '../database';
import { blockchain } from './blockchain';
import { redis } from './redis';
import { walletService } from './wallet';
import { estimateGasUSDT } from './giveaway';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashIdempotencyKey } from '../utils/encryption';
import cron from 'node-cron';

const ASSET_DECIMALS: Record<string, number> = { BNB: 18, USDT: 18 };
const MAX_LOG_WINDOW = 500;

/** 0.000002 BNB = 2×10^12 wei — enough for one BEP20 forward */
const FORWARD_GAS_SEED = 2000000000000n;

const MIN_DEPOSIT: Record<string, number> = {
  BNB: 0.0001,
  USDT: config.MINIMUM_AMOUNT_USD,
};

class DepositMonitorService {
  private isRunning = false;

  start(): void {
    cron.schedule('0 * * * * *', () => void this.scanDeposits());
    logger.info('Deposit monitor started (immediate fee forwarding mode)');
  }

  private async scanDeposits(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const wallets = await prisma.wallet.findMany({
        where: {
          status: 'ACTIVE',
          address: { not: config.PLATFORM_FEE_WALLET },
        },
        include: { user: true },
      });
      if (wallets.length === 0) return;

      const provider = await blockchain.getProvider();
      const currentBlock = await provider.getBlockNumber();

      const cursorKey = 'monitor:lastBlock';
      const cached = await redis.get(cursorKey);
      const lastScanned = cached ? parseInt(cached) : currentBlock - 20;
      const fromBlock = Math.max(lastScanned + 1, currentBlock - MAX_LOG_WINDOW);

      for (const wallet of wallets) {
        try {
          if (fromBlock <= currentBlock) {
            const events = await blockchain.getTokenTransferEvents('USDT', wallet.address, fromBlock, currentBlock);
            for (const event of events) {
              await this.processDeposit(wallet, 'USDT', { from: event.from, amount: event.amount, txHash: event.txHash });
            }
          }
        } catch (err) {
          logger.error(`Error scanning USDT for ${wallet.address}:`, err);
        }

        try {
          await this.checkNativeBalance(wallet, currentBlock);
        } catch (err) {
          logger.error(`Error checking BNB balance for ${wallet.address}:`, err);
        }
      }

      await redis.set(cursorKey, currentBlock.toString());
    } catch (err) {
      logger.error('Deposit scan error:', err);
    } finally {
      this.isRunning = false;
    }
  }

  private async checkNativeBalance(
    wallet: { address: string; userId: string; user: { chatId: string | null; telegramId: string } },
    currentBlock: number
  ): Promise<void> {
    const key = `monitor:bal:${wallet.address}:BNB`;
    const raw = await blockchain.getBalance(wallet.address, 'BNB');
    const current = Number(raw) / 1e18;

    const prevStr = await redis.get(key);
    await redis.set(key, current.toFixed(12));

    if (!prevStr) return;
    const diff = current - parseFloat(prevStr);
    if (diff <= 0) return;

    await this.processDeposit(wallet, 'BNB', {
      from: '',
      amount: BigInt(Math.floor(diff * 1e18)),
      txHash: `bnb-diff:${wallet.address}:${currentBlock}`,
    });
  }

  private async processDeposit(
    wallet: {
      address: string;
      userId: string;
      encryptedPrivateKey: string;
      user: { chatId: string | null; telegramId: string };
    },
    asset: string,
    event: { from: string; amount: bigint; txHash: string }
  ): Promise<void> {
    const decimals = ASSET_DECIMALS[asset] ?? 18;
    const amount = Number(event.amount) / 10 ** decimals;

    const minAmount = MIN_DEPOSIT[asset] ?? 0.1;
    if (amount < minAmount) {
      logger.info(`Ignoring dust ${asset} deposit of ${amount} (< min ${minAmount})`);
      return;
    }

    const existing = await prisma.transaction.findFirst({ where: { transactionHash: event.txHash } });
    if (existing) return;

    const seen = await prisma.depositMonitor.findUnique({
      where: { txHash_address: { txHash: event.txHash, address: wallet.address } },
    });
    if (seen?.status === 'PROCESSED') return;

    const receipt = await blockchain.getTransactionReceipt(event.txHash);
    if (!receipt || receipt.status !== 1) return;

    // Fees: 1% platform fee + the BNB gas (priced in the asset) to forward it
    const feePercent = config.ENABLE_FEES ? config.PLATFORM_FEE_PERCENT : 0;
    const platformFee = amount * (feePercent / 100);
    const gasFee = platformFee > 0 ? await estimateGasUSDT(1) : 0;
    const totalFee = platformFee + gasFee;
    const netAmount = amount - totalFee;

    await prisma.depositMonitor.upsert({
      where: { txHash_address: { txHash: event.txHash, address: wallet.address } },
      create: { address: wallet.address, asset, txHash: event.txHash, amount, status: 'CONFIRMING' },
      update: {},
    });

    let depositTxId = '';
    let feeRowId = '';
    await prisma.$transaction(async (tx) => {
      await tx.balance.upsert({
        where: { userId_asset: { userId: wallet.userId, asset } },
        create: { userId: wallet.userId, asset, availableBalance: netAmount, lockedBalance: 0, pendingBalance: 0 },
        update: { availableBalance: { increment: netAmount } },
      });

      const depositTx = await tx.transaction.create({
        data: {
          userId: wallet.userId,
          type: 'DEPOSIT',
          asset,
          amount,
          fee: totalFee,
          netAmount,
          status: 'CONFIRMED',
          transactionHash: event.txHash,
          fromAddress: event.from || null,
          toAddress: wallet.address,
          idempotencyKey: hashIdempotencyKey('deposit', event.txHash),
        },
      });
      depositTxId = depositTx.id;

      if (platformFee > 0) {
        const feeRow = await tx.platformFee.create({
          data: {
            transactionId: depositTx.id,
            asset,
            amount: platformFee,
            feeWallet: config.PLATFORM_FEE_WALLET,
            // sweptAt stays null until the on-chain forward below succeeds
          },
        });
        feeRowId = feeRow.id;
      }
    });

    await prisma.depositMonitor.updateMany({
      where: { txHash: event.txHash },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });

    logger.info(`Deposit credited: ${netAmount} ${asset} (${event.txHash.slice(0, 16)}...)`);

    // ── Immediate on-chain fee forwarding ──
    if (platformFee > 0 && asset === 'USDT') {
      try {
        // Seed just enough BNB for the forward (deficit only)
        const baseline = await blockchain.getBalance(wallet.address, 'BNB');
        if (baseline < FORWARD_GAS_SEED) {
          if (!config.OPERATOR_WALLET_KEY) throw new Error('OPERATOR_WALLET_KEY not configured');
          const seedAmt = FORWARD_GAS_SEED - baseline;
          await blockchain.sendTransaction(
            config.OPERATOR_WALLET_KEY,
            wallet.address,
            seedAmt,
            'BNB',
            hashIdempotencyKey('fwd-seed', event.txHash)
          );
          await walletService.adjustOperatorBalance('BNB', -Number(seedAmt) / 1e18);
        }

        const rawFee = BigInt(Math.floor(platformFee * 1e18));
        const { hash } = await blockchain.sendTransaction(
          wallet.encryptedPrivateKey,
          config.PLATFORM_FEE_WALLET,
          rawFee,
          'USDT',
          hashIdempotencyKey('fee-forward', event.txHash)
        );

        await prisma.platformFee.update({
          where: { id: feeRowId },
          data: { sweptAt: new Date() },
        });
        await walletService.adjustOperatorBalance('USDT', platformFee);
        logger.info(`Fee forwarded: ${platformFee} USDT → platform wallet (tx ${hash})`);
      } catch (err) {
        logger.error(`Fee forward failed for ${event.txHash} (fee stays pending for admin sweep): ${(err as Error).message}`);
      }
    }

    if (wallet.user.chatId) {
      await this.notify(
        wallet.user.chatId,
        `${'🟢'} <b>DEPOSIT RECEIVED</b>\n\n` +
        `<b>Amount:</b> ${amount} ${asset}\n` +
        (platformFee > 0 ? `<b>Platform Fee (1%):</b> ${platformFee.toFixed(6)} ${asset}\n` : '') +
        (gasFee > 0 ? `<b>Network Gas:</b> ≈$${gasFee.toFixed(4)}\n` : '') +
        `<b>Credited:</b> ${netAmount.toFixed(6)} ${asset}\n` +
        `<b>Ref:</b> <code>${event.txHash.slice(0, 24)}...</code>`,
        30000
      );
    }
  }

  private async notify(chatId: string, html: string, ttlMs = 30000): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML' }),
      });
      const data = (await res.json()) as { ok: boolean; result?: { message_id: number } };
      const messageId = data?.result?.message_id;
      if (messageId) {
        const timer = setTimeout(() => {
          fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
          }).catch(() => {});
        }, ttlMs);
        timer.unref?.();
      }
    } catch (err) {
      logger.error('Deposit notify failed:', err);
    }
  }
}

export const depositMonitor = new DepositMonitorService();
      
