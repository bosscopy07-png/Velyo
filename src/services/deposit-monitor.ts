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

/**
 * BIG scan — every 60s at second 0 — primary/fallback read pool,
 * 150-block window, ADVANCES the cursor, owns the BNB balance sweep.
 * ACTIVE WALLETS ONLY (14d) — the expensive pass scales with engaged
 * users, not total signups. Dormant wallets are covered by SMALL.
 */
const BIG_SCAN_BLOCK_WINDOW = 150;
const BIG_SCAN_ACTIVITY_DAYS = 14;

/**
 * SMALL scan — every 60s at second 30 — getblock.io, last 5 blocks,
 * ALL wallets, does NOT advance the cursor, no BNB sweep. Fresh-deposit
 * safety net on its own isolated RPC.
 */
const SMALL_SCAN_BLOCK_WINDOW = 5;

const SCAN_LOCK_KEY = 'monitor:scan:lock';
const SCAN_LOCK_TTL_SEC = 240;

/** 0.000002 BNB = 2×10^12 wei — enough for one BEP20 forward */
const FORWARD_GAS_SEED = 2000000000000n;

const MIN_DEPOSIT: Record<string, number> = {
  BNB: 0.0001,
  USDT: config.MINIMUM_AMOUNT_USD,
};

const BNB_CHECK_CONCURRENCY = 4;
const BNB_CHECK_BATCH_DELAY_MS = 300;
const BNB_RATE_LIMIT_BACKOFF_MS = 2000;
const SEED_LEDGER_TTL_SEC = 600;

function flatFeeFor(amountUSD: number): number {
  if (!config.ENABLE_FEES) return 0;
  return amountUSD < config.DEPOSIT_FLAT_FEE_TIER_USD
    ? config.DEPOSIT_FLAT_FEE_SMALL_USD
    : config.DEPOSIT_FLAT_FEE_USD;
}

type MonitoredWallet = {
  address: string;
  userId: string;
  encryptedPrivateKey: string;
  user: { chatId: string | null; telegramId: string };
};

class DepositMonitorService {
  private isRunning = false;

  start(): void {
    // t=0s of every minute  → BIG scan (active wallets, read pool, cursor)
    cron.schedule('0 * * * * *', () => void this.runBigScan());
    // t=30s of every minute  → SMALL scan (all wallets, getblock, no cursor)
    cron.schedule('30 * * * * *', () => void this.runSmallScan());

    logger.info('Deposit monitor: BIG @0s (active wallets, 150 blk) · SMALL @30s (getblock, 5 blk, all wallets) · TX via Chainstack');
  }

  private async acquireScanLock(): Promise<boolean> {
    if (this.isRunning) return false;
    try {
      const res = await redis.set(SCAN_LOCK_KEY, '1', 'EX', SCAN_LOCK_TTL_SEC, 'NX');
      if (res !== 'OK') return false;
    } catch { /* Redis down — in-memory flag only */ }
    this.isRunning = true;
    return true;
  }

  private async releaseScanLock(): Promise<void> {
    this.isRunning = false;
    try { await redis.del(SCAN_LOCK_KEY); } catch { /* ignore */ }
  }

  /**
   * @param activityDays When set (BIG scan), only wallets whose owner
   * touched the bot within this window. Omit (SMALL scan) for ALL wallets —
   * a dormant wallet receiving an external deposit is still caught.
   */
  private async getActiveWallets(activityDays?: number): Promise<MonitoredWallet[]> {
    const cutoff = activityDays ? new Date(Date.now() - activityDays * 86400000) : undefined;

    const wallets = await prisma.wallet.findMany({
      where: {
        status: 'ACTIVE',
        address: { not: config.PLATFORM_FEE_WALLET },
        ...(cutoff ? { user: { lastActive: { gte: cutoff } } } : {}),
      },
      include: { user: true },
    });

    return wallets as MonitoredWallet[];
  }

  // ── BIG scan: every minute, ACTIVE wallets only, advances cursor ──

  private async runBigScan(): Promise<void> {
    if (!(await this.acquireScanLock())) {
      logger.warn('[BIG] Scan skipped — another scan is still running.');
      return;
    }

    try {
      const wallets = await this.getActiveWallets(BIG_SCAN_ACTIVITY_DAYS);
      if (wallets.length === 0) return;

      const walletMap = new Map(wallets.map((w) => [w.address.toLowerCase(), w] as const));

      const provider = await blockchain.getProvider();
      const currentBlock = await provider.getBlockNumber();

      const cursorKey = 'monitor:lastBlock';
      const cached = await redis.get(cursorKey);
      const lastScanned = cached ? parseInt(cached, 10) : currentBlock - BIG_SCAN_BLOCK_WINDOW;
      const fromBlock = Math.max(lastScanned + 1, currentBlock - BIG_SCAN_BLOCK_WINDOW);

      logger.info(`[BIG] USDT scan: blocks ${fromBlock}-${currentBlock} (${wallets.length} active wallets)`);

      let rateLimited = false;

      if (fromBlock <= currentBlock) {
        try {
          const eventsByAddress = await blockchain.getTokenTransferEventsForAddresses(
            'USDT', [...walletMap.keys()], fromBlock, currentBlock
          );

          let found = 0, matched = 0;
          for (const [address, events] of eventsByAddress) {
            const wallet = walletMap.get(address);
            if (!wallet) continue;
            found += events.length;
            for (const event of events) {
              await this.processDeposit(wallet, 'USDT', { from: event.from, amount: event.amount, txHash: event.txHash });
              matched++;
            }
          }
          logger.info(`[BIG] USDT events found: ${found}, deposits matched: ${matched}`);
        } catch (err) {
          const msg = this.getErrorMessage(err);
          if (this.isTemporaryRPCError(msg)) {
            rateLimited = true;
            logger.warn('[BIG] Temporary RPC failure — cursor NOT advanced, retrying next cycle.');
          } else {
            logger.error('[BIG] Error scanning USDT deposits:', err);
          }
        }
      }

      if (!rateLimited) {
        const queue = [...wallets];
        while (queue.length > 0) {
          const batch = queue.splice(0, BNB_CHECK_CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map((w) => this.checkNativeBalance(w, currentBlock))
          );
          let hitLimit = false;
          for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'rejected') {
              logger.error(`Error checking BNB balance for ${batch[i].address}:`, results[i].reason);
              if (this.isTemporaryRPCError(this.getErrorMessage(results[i].reason))) hitLimit = true;
            }
          }
          await sleep(hitLimit ? BNB_RATE_LIMIT_BACKOFF_MS : BNB_CHECK_BATCH_DELAY_MS);
        }
      }

      if (!rateLimited) {
        await redis.set(cursorKey, currentBlock.toString());
      }
    } catch (err) {
      logger.error('[BIG] Deposit scan error:', err);
    } finally {
      await this.releaseScanLock();
    }
  }

  // ── SMALL scan: every minute at :30, getblock, 5 blocks, ALL wallets ──

  private async runSmallScan(): Promise<void> {
    if (!(await this.acquireScanLock())) {
      logger.warn('[SMALL] getblock scan skipped — another scan is still running.');
      return;
    }

    try {
      const provider = await blockchain.getSmallScanProvider();
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(1, currentBlock - SMALL_SCAN_BLOCK_WINDOW + 1);

      logger.info(`[SMALL] getblock scan: blocks ${fromBlock}-${currentBlock}`);

      const wallets = await this.getActiveWallets(); // ALL wallets
      if (wallets.length === 0) return;

      const walletMap = new Map(wallets.map((w) => [w.address.toLowerCase(), w] as const));

      const eventsByAddress = await blockchain.getTokenTransferEventsForAddresses(
        'USDT', [...walletMap.keys()], fromBlock, currentBlock, provider
      );

      let matched = 0;
      for (const [address, events] of eventsByAddress) {
        const wallet = walletMap.get(address);
        if (!wallet) continue;
        for (const event of events) {
          await this.processDeposit(wallet, 'USDT', { from: event.from, amount: event.amount, txHash: event.txHash });
          matched++;
        }
      }

      logger.info(`[SMALL] getblock scan complete: ${matched} deposit(s) matched`);
    } catch (err) {
      logger.error('[SMALL] getblock scan error:', err);
    } finally {
      await this.releaseScanLock();
    }
  }
    // ── Gas-seed ledger: seeds are never misread as user deposits ──

  private pendingSeedKey(address: string): string {
    return `monitor:seed:pending:${address.toLowerCase()}`;
  }

  private async recordPendingGasSeed(address: string, seedAmount: bigint): Promise<void> {
    await redis.incrbyfloat(this.pendingSeedKey(address), Number(seedAmount) / 1e18);
    await redis.expire(this.pendingSeedKey(address), SEED_LEDGER_TTL_SEC);
  }

  private async clearPendingGasSeed(address: string, seedAmount: bigint): Promise<void> {
    await redis.incrbyfloat(this.pendingSeedKey(address), -Number(seedAmount) / 1e18);
  }

  private async checkNativeBalance(wallet: MonitoredWallet, currentBlock: number): Promise<void> {
    const key = `monitor:bal:${wallet.address}:BNB`;
    const raw = await blockchain.getBalance(wallet.address, 'BNB');
    const current = Number(raw) / 1e18;

    const prevStr = await redis.get(key);
    await redis.set(key, current.toFixed(12));
    if (!prevStr) return;

    const diff = current - parseFloat(prevStr);
    if (diff <= 0) return;

    const seedKey = this.pendingSeedKey(wallet.address);
    const pendingSeedsStr = await redis.get(seedKey);
    const pendingSeeds = pendingSeedsStr ? parseFloat(pendingSeedsStr) : 0;
    if (pendingSeeds > 0) {
      await redis.incrbyfloat(seedKey, -pendingSeeds);
      await redis.expire(seedKey, SEED_LEDGER_TTL_SEC);
    }

    const adjustedDiff = diff - pendingSeeds;
    if (adjustedDiff <= 0) {
      logger.info(`BNB delta for ${wallet.address} fully explained by operator gas seed — not a deposit.`);
      return;
    }

    await this.processDeposit(wallet, 'BNB', {
      from: '',
      amount: BigInt(Math.floor(adjustedDiff * 1e18)),
      txHash: `bnb-diff:${wallet.address}:${currentBlock}`,
    });
  }

  // ── Deposit processing ──

  private async processDeposit(
    wallet: MonitoredWallet,
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

    const seen = await prisma.depositMonitor.findUnique({
      where: { txHash_address: { txHash: event.txHash, address: wallet.address } },
    });
    if (seen?.status === 'PROCESSED') return;

    const receipt = await blockchain.getTransactionReceipt(event.txHash);
    if (!receipt || receipt.status !== 1) return;

    const flatFee = flatFeeFor(asset === 'USDT' ? amount : 0);
    const pctFee = config.ENABLE_FEES ? amount * (config.PLATFORM_FEE_PERCENT / 100) : 0;
    const platformFee = flatFee + pctFee;
    const gasFee = platformFee > 0 ? await estimateGasUSDT(1) : 0;
    const totalFee = platformFee + gasFee;
    const netAmount = amount - totalFee;

    if (netAmount <= 0) {
      logger.warn(`Deposit ${amount} ${asset} below fee floor (${totalFee}) — ignored, not credited`);
      return;
    }

    await prisma.depositMonitor.upsert({
      where: { txHash_address: { txHash: event.txHash, address: wallet.address } },
      create: { address: wallet.address, asset, txHash: event.txHash, amount, status: 'CONFIRMING' },
      update: {},
    });

    let feeRowId = '';
    const depositIdempotencyKey = hashIdempotencyKey('deposit', `${event.txHash}:${wallet.address.toLowerCase()}`);

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
          idempotencyKey: depositIdempotencyKey,
        },
      });

      if (platformFee > 0) {
        const feeRow = await tx.platformFee.create({
          data: {
            transactionId: depositTx.id,
            asset,
            amount: platformFee,
            feeWallet: config.PLATFORM_FEE_WALLET,
          },
        });
        feeRowId = feeRow.id;
      }
    });

    await prisma.depositMonitor.updateMany({
      where: { txHash: event.txHash, address: wallet.address },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });

    logger.info(`Deposit credited: ${netAmount} ${asset} (${event.txHash.slice(0, 16)}...)`);

    // Fee forwarding — seed ledgered BEFORE broadcast; sends go via Chainstack
    if (platformFee > 0 && asset === 'USDT') {
      try {
        const baseline = await blockchain.getBalance(wallet.address, 'BNB');

        if (baseline < FORWARD_GAS_SEED) {
          if (!config.OPERATOR_WALLET_KEY) throw new Error('OPERATOR_WALLET_KEY not configured');
          const seedAmount = FORWARD_GAS_SEED - baseline;

          await this.recordPendingGasSeed(wallet.address, seedAmount);
          try {
            await blockchain.sendTransaction(
              config.OPERATOR_WALLET_KEY, wallet.address, seedAmount, 'BNB',
              hashIdempotencyKey('fwd-seed', event.txHash)
            );
          } catch (seedErr) {
            await this.clearPendingGasSeed(wallet.address, seedAmount);
            throw seedErr;
          }
          await walletService.adjustOperatorBalance('BNB', -Number(seedAmount) / 1e18);
        }

        const rawFee = BigInt(Math.floor(platformFee * 1e18));
        const { hash } = await blockchain.sendTransaction(
          wallet.encryptedPrivateKey, config.PLATFORM_FEE_WALLET, rawFee, 'USDT',
          hashIdempotencyKey('fee-forward', event.txHash)
        );

        if (feeRowId) {
          await prisma.platformFee.update({ where: { id: feeRowId }, data: { sweptAt: new Date() } });
        }
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
        (flatFee > 0 ? `<b>Flat Fee:</b> $${flatFee.toFixed(2)}\n` : '') +
        (pctFee > 0 ? `<b>Platform Fee (1%):</b> ${pctFee.toFixed(6)} ${asset}\n` : '') +
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

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message.toLowerCase();
    return String(err ?? '').toLowerCase();
  }

  private isTemporaryRPCError(message: string): boolean {
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('rate limit') ||
      message.includes('request limit') ||
      message.includes('-32007') ||
      message.includes('too many requests') ||
      message.includes('429') ||
      message.includes('503') ||
      message.includes('502') ||
      message.includes('500') ||
      message.includes('network error') ||
      message.includes('socket') ||
      message.includes('temporarily unavailable')
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const depositMonitor = new DepositMonitorService();
