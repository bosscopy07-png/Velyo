import { prisma } from '../database';
import { blockchain } from './blockchain';
import { redis } from './redis';
import { walletService } from './wallet';
import { estimateGasUSDT } from './giveaway';
import { config } from '../config';
import { logger } from '../utils/logger';
import { hashIdempotencyKey } from '../utils/encryption';
import cron from 'node-cron';

const ASSET_DECIMALS: Record<string, number> = {
  BNB: 18,
  USDT: 18,
};

/**
 * BIG scan (BSC primary) — runs every 60s at second 0,
 * covers the last 150 blocks and advances the cursor.
 */
const BIG_SCAN_BLOCK_WINDOW = 150;

/**
 * SMALL scan (QuickNode) — runs every 60s at second 30 (offset),
 * covers only the last 5 blocks and does NOT advance the cursor.
 */
const SMALL_SCAN_BLOCK_WINDOW = 5;

/**
 * One shared lock for BOTH scans. They must never run at the same
 * time — the second 30 offset is guaranteed by cron, and this lock
 * guarantees it even if one scan overruns its slot.
 */
const SCAN_LOCK_KEY = 'monitor:scan:lock';
const SCAN_LOCK_TTL_SEC = 240;

/** 0.000002 BNB = enough for one BEP20 forward */
const FORWARD_GAS_SEED = 2000000000000n;

const MIN_DEPOSIT: Record<string, number> = {
  BNB: 0.0001,
  USDT: config.MINIMUM_AMOUNT_USD,
};

/**
 * BNB balance checks run inside the BIG scan only, in bounded
 * parallel batches so 250 wallets finish in a few seconds and never
 * starve the QuickNode scan of its 30-second slot.
 */
const BNB_CHECK_CONCURRENCY = 10;
const BNB_CHECK_BATCH_DELAY_MS = 100;

type MonitoredWallet = {
  address: string;
  userId: string;
  encryptedPrivateKey: string;
  user: {
    chatId: string | null;
    telegramId: string;
  };
};

class DepositMonitorService {
  private isRunning = false;

  start(): void {
    /**
     * t=0s, 60s, 120s ...  → BIG scan via BSC primary (150 blocks)
     * t=30s, 90s, 150s ... → SMALL scan via QuickNode (5 blocks)
     */
    cron.schedule('0 * * * * *', () => {
      void this.runBigScan();
    });

    cron.schedule('30 * * * * *', () => {
      void this.runSmallScan();
    });

    logger.info(
      'Deposit monitor started: primary 150-block scan @0s, QuickNode 5-block scan @30s (mutually exclusive)'
    );
  }

  // ------------------------------------------------------------------
  // Shared lock — both scans compete for it; only one can hold it.
  // ------------------------------------------------------------------

  private async acquireScanLock(): Promise<boolean> {
    if (this.isRunning) return false;

    try {
      const res = await redis.set(
        SCAN_LOCK_KEY,
        '1',
        'EX',
        SCAN_LOCK_TTL_SEC,
        'NX'
      );

      if (res !== 'OK') return false;
    } catch {
      // Redis unavailable — fall back to the in-memory flag only.
    }

    this.isRunning = true;

    return true;
  }

  private async releaseScanLock(): Promise<void> {
    this.isRunning = false;

    try {
      await redis.del(SCAN_LOCK_KEY);
    } catch {
      // ignore
    }
  }

  private async getActiveWallets(): Promise<MonitoredWallet[]> {
    return prisma.wallet.findMany({
      where: {
        status: 'ACTIVE',
        address: {
          not: config.PLATFORM_FEE_WALLET,
        },
      },
      include: {
        user: true,
      },
    });
  }

  // ------------------------------------------------------------------
  // BIG scan — every 60s (second 0) — BSC primary, 150 blocks.
  // Authoritative pass: advances the cursor + checks BNB balances.
  // ------------------------------------------------------------------

  private async runBigScan(): Promise<void> {
    if (!(await this.acquireScanLock())) {
      logger.warn('[BIG] Scan skipped — another scan is still running.');
      return;
    }

    try {
      const wallets = await this.getActiveWallets();

      if (wallets.length === 0) return;

      const provider = await blockchain.getProvider();

      const currentBlock =
        await provider.getBlockNumber();

      const cursorKey = 'monitor:lastBlock';

      const cached = await redis.get(cursorKey);

      const lastScanned = cached
        ? parseInt(cached, 10)
        : currentBlock - BIG_SCAN_BLOCK_WINDOW;

      const fromBlock = Math.max(
        lastScanned + 1,
        currentBlock - BIG_SCAN_BLOCK_WINDOW
      );

      logger.info(
        `[BIG] Primary scan: ${wallets.length} wallets, blocks ${fromBlock}-${currentBlock}`
      );

      let rateLimited = false;

      if (fromBlock <= currentBlock) {
        try {
          const addresses = wallets.map(
            (wallet) => wallet.address
          );

          const eventsByAddress =
            await blockchain.getTokenTransferEventsForAddresses(
              'USDT',
              addresses,
              fromBlock,
              currentBlock
            );

          let depositCount = 0;

          for (const wallet of wallets) {
            const events =
              eventsByAddress.get(
                wallet.address.toLowerCase()
              ) ?? [];

            for (const event of events) {
              await this.processDeposit(
                wallet,
                'USDT',
                {
                  from: event.from,
                  amount: event.amount,
                  txHash: event.txHash,
                }
              );

              depositCount++;
            }
          }

          logger.info(
            `[BIG] USDT scan complete: ${depositCount} transfer event(s) found`
          );
        } catch (err) {
          const msg = this.getErrorMessage(err);

          if (this.isTemporaryRPCError(msg)) {
            rateLimited = true;

            logger.warn(
              '[BIG] Temporary RPC failure — cursor NOT advanced, retrying next cycle.'
            );
          } else {
            logger.error(
              '[BIG] Error scanning batched USDT deposits:',
              err
            );
          }
        }
      }

      /**
       * BNB balance scan — BIG pass only, bounded parallelism so it
       * finishes quickly and never blocks the QuickNode slot.
       */
      if (!rateLimited) {
        const queue = [...wallets];

        while (queue.length > 0) {
          const batchWallets = queue.splice(
            0,
            BNB_CHECK_CONCURRENCY
          );

          await Promise.allSettled(
            batchWallets.map((wallet) =>
              this.checkNativeBalance(
                wallet,
                currentBlock
              ).catch((err) => {
                logger.error(
                  `Error checking BNB balance for ${wallet.address}:`,
                  err
                );
              })
            )
          );

          await sleep(BNB_CHECK_BATCH_DELAY_MS);
        }
      }

      /**
       * Only advance the cursor after the USDT scan succeeded.
       */
      if (!rateLimited) {
        await redis.set(
          cursorKey,
          currentBlock.toString()
        );
      }
    } catch (err) {
      logger.error('[BIG] Deposit scan error:', err);
    } finally {
      await this.releaseScanLock();
    }
  }

  // ------------------------------------------------------------------
  // SMALL scan — every 60s at second 30 — QuickNode, last 5 blocks.
  // Fast pass for fresh deposits. Does NOT advance the cursor and
  // does NOT check BNB balances (the BIG pass owns both).
  // ------------------------------------------------------------------

  private async runSmallScan(): Promise<void> {
    if (!(await this.acquireScanLock())) {
      logger.warn('[SMALL] QuickNode scan skipped — another scan is still running.');
      return;
    }

    try {
      const provider =
        await blockchain.getQuickNodeProvider();

      const currentBlock =
        await provider.getBlockNumber();

      const fromBlock = Math.max(
        1,
        currentBlock - SMALL_SCAN_BLOCK_WINDOW + 1
      );

      logger.info(
        `[SMALL] QuickNode scan: blocks ${fromBlock}-${currentBlock}`
      );

      const wallets = await this.getActiveWallets();

      if (wallets.length === 0) return;

      const addresses = wallets.map(
        (wallet) => wallet.address
      );

      /**
       * Pinned to QuickNode — the adaptive chunk shrinker inside
       * blockchain.ts handles QuickNode's small eth_getLogs limit.
       */
      const eventsByAddress =
        await blockchain.getTokenTransferEventsForAddresses(
          'USDT',
          addresses,
          fromBlock,
          currentBlock,
          provider
        );

      let depositCount = 0;

      for (const wallet of wallets) {
        const events =
          eventsByAddress.get(
            wallet.address.toLowerCase()
          ) ?? [];

        for (const event of events) {
          await this.processDeposit(
            wallet,
            'USDT',
            {
              from: event.from,
              amount: event.amount,
              txHash: event.txHash,
            }
          );

          depositCount++;
        }
      }

      logger.info(
        `[SMALL] QuickNode scan complete: ${depositCount} transfer event(s) found`
      );
    } catch (err) {
      logger.error('[SMALL] QuickNode scan error:', err);
    } finally {
      await this.releaseScanLock();
    }
  }

  // ------------------------------------------------------------------
  // Deposit processing (unchanged logic — idempotent, safe for the
  // small scan to overlap the big scan's window).
  // ------------------------------------------------------------------

  private async checkNativeBalance(
    wallet: MonitoredWallet,
    currentBlock: number
  ): Promise<void> {
    const key =
      `monitor:bal:${wallet.address}:BNB`;

    const raw = await blockchain.getBalance(
      wallet.address,
      'BNB'
    );

    const current =
      Number(raw) / 1e18;

    const prevStr =
      await redis.get(key);

    await redis.set(
      key,
      current.toFixed(12)
    );

    if (!prevStr) return;

    const previous =
      parseFloat(prevStr);

    const diff =
      current - previous;

    if (diff <= 0) return;

    await this.processDeposit(
      wallet,
      'BNB',
      {
        from: '',
        amount: BigInt(
          Math.floor(diff * 1e18)
        ),
        txHash:
          `bnb-diff:${wallet.address}:${currentBlock}`,
      }
    );
  }

  private async processDeposit(
    wallet: MonitoredWallet,
    asset: string,
    event: {
      from: string;
      amount: bigint;
      txHash: string;
    }
  ): Promise<void> {
    const decimals =
      ASSET_DECIMALS[asset] ?? 18;

    const amount =
      Number(event.amount) /
      10 ** decimals;

    const minAmount =
      MIN_DEPOSIT[asset] ?? 0.1;

    if (amount < minAmount) {
      logger.info(
        `Ignoring dust ${asset} deposit of ${amount} (< min ${minAmount})`
      );

      return;
    }

    const existing =
      await prisma.transaction.findFirst({
        where: {
          userId: wallet.userId,
          transactionHash: event.txHash,
        },
      });

    if (existing) return;

    const seen =
      await prisma.depositMonitor.findUnique({
        where: {
          txHash_address: {
            txHash: event.txHash,
            address: wallet.address,
          },
        },
      });

    if (seen?.status === 'PROCESSED') {
      return;
    }

    const receipt =
      await blockchain.getTransactionReceipt(
        event.txHash
      );

    if (!receipt || receipt.status !== 1) {
      return;
    }

    const feePercent =
      config.ENABLE_FEES
        ? config.PLATFORM_FEE_PERCENT
        : 0;

    const platformFee =
      amount *
      (feePercent / 100);

    const gasFee =
      platformFee > 0
        ? await estimateGasUSDT(1)
        : 0;

    const totalFee =
      platformFee + gasFee;

    const netAmount =
      amount - totalFee;

    if (netAmount <= 0) {
      logger.warn(
        `Deposit ${event.txHash} produced non-positive net amount; ignoring`
      );

      return;
    }

    await prisma.depositMonitor.upsert({
      where: {
        txHash_address: {
          txHash: event.txHash,
          address: wallet.address,
        },
      },
      create: {
        address: wallet.address,
        asset,
        txHash: event.txHash,
        amount,
        status: 'CONFIRMING',
      },
      update: {},
    });

    let feeRowId = '';

    const depositIdempotencyKey =
      hashIdempotencyKey(
        'deposit',
        `${event.txHash}:${wallet.address.toLowerCase()}`
      );

    await prisma.$transaction(
      async (tx) => {
        await tx.balance.upsert({
          where: {
            userId_asset: {
              userId: wallet.userId,
              asset,
            },
          },
          create: {
            userId: wallet.userId,
            asset,
            availableBalance: netAmount,
            lockedBalance: 0,
            pendingBalance: 0,
          },
          update: {
            availableBalance: {
              increment: netAmount,
            },
          },
        });

        const depositTx =
          await tx.transaction.create({
            data: {
              userId: wallet.userId,
              type: 'DEPOSIT',
              asset,
              amount,
              fee: totalFee,
              netAmount,
              status: 'CONFIRMED',
              transactionHash: event.txHash,
              fromAddress:
                event.from || null,
              toAddress: wallet.address,
              idempotencyKey:
                depositIdempotencyKey,
            },
          });

        if (platformFee > 0) {
          const feeRow =
            await tx.platformFee.create({
              data: {
                transactionId:
                  depositTx.id,
                asset,
                amount: platformFee,
                feeWallet:
                  config.PLATFORM_FEE_WALLET,
              },
            });

          feeRowId = feeRow.id;
        }
      }
    );

    await prisma.depositMonitor.updateMany({
      where: {
        txHash: event.txHash,
        address: wallet.address,
      },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
      },
    });

    logger.info(
      `Deposit credited: ${netAmount} ${asset} (${event.txHash.slice(0, 16)}...)`
    );

    if (
      platformFee > 0 &&
      asset === 'USDT'
    ) {
      try {
        const baseline =
          await blockchain.getBalance(
            wallet.address,
            'BNB'
          );

        if (
          baseline <
          FORWARD_GAS_SEED
        ) {
          if (!config.OPERATOR_WALLET_KEY) {
            throw new Error(
              'OPERATOR_WALLET_KEY not configured'
            );
          }

          const seedAmount =
            FORWARD_GAS_SEED -
            baseline;

          await blockchain.sendTransaction(
            config.OPERATOR_WALLET_KEY,
            wallet.address,
            seedAmount,
            'BNB',
            hashIdempotencyKey(
              'fwd-seed',
              event.txHash
            )
          );

          await walletService.adjustOperatorBalance(
            'BNB',
            -Number(seedAmount) / 1e18
          );
        }

        const rawFee =
          BigInt(
            Math.floor(
              platformFee * 1e18
            )
          );

        const { hash } =
          await blockchain.sendTransaction(
            wallet.encryptedPrivateKey,
            config.PLATFORM_FEE_WALLET,
            rawFee,
            'USDT',
            hashIdempotencyKey(
              'fee-forward',
              event.txHash
            )
          );

        if (feeRowId) {
          await prisma.platformFee.update({
            where: {
              id: feeRowId,
            },
            data: {
              sweptAt: new Date(),
            },
          });
        }

        await walletService.adjustOperatorBalance(
          'USDT',
          platformFee
        );

        logger.info(
          `Fee forwarded: ${platformFee} USDT → platform wallet (tx ${hash})`
        );
      } catch (err) {
        logger.error(
          `Fee forward failed for ${event.txHash} (fee stays pending for admin sweep): ${(err as Error).message}`
        );
      }
    }

    if (wallet.user.chatId) {
      await this.notify(
        wallet.user.chatId,
        `${'🟢'} <b>DEPOSIT RECEIVED</b>\n\n` +
          `<b>Amount:</b> ${amount} ${asset}\n` +
          (platformFee > 0
            ? `<b>Platform Fee (1%):</b> ${platformFee.toFixed(6)} ${asset}\n`
            : '') +
          (gasFee > 0
            ? `<b>Network Gas:</b> ≈$${gasFee.toFixed(4)}\n`
            : '') +
          `<b>Credited:</b> ${netAmount.toFixed(6)} ${asset}\n` +
          `<b>Ref:</b> <code>${event.txHash.slice(0, 24)}...</code>`,
        30000
      );
    }
  }

  private async notify(
    chatId: string,
    html: string,
    ttlMs = 30000
  ): Promise<void> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: html,
            parse_mode: 'HTML',
          }),
        }
      );

      const data =
        (await res.json()) as {
          ok: boolean;
          result?: {
            message_id: number;
          };
        };

      const messageId =
        data?.result?.message_id;

      if (messageId) {
        const timer = setTimeout(
          () => {
            fetch(
              `https://api.telegram.org/bot${config.BOT_TOKEN}/deleteMessage`,
              {
                method: 'POST',
                headers: {
                  'Content-Type':
                    'application/json',
                },
                body: JSON.stringify({
                  chat_id: chatId,
                  message_id:
                    messageId,
                }),
              }
            ).catch(() => {});
          },
          ttlMs
        );

        timer.unref?.();
      }
    } catch (err) {
      logger.error(
        'Deposit notify failed:',
        err
      );
    }
  }

  private getErrorMessage(
    err: unknown
  ): string {
    if (err instanceof Error) {
      return err.message.toLowerCase();
    }

    return String(err ?? '').toLowerCase();
  }

  private isTemporaryRPCError(
    message: string
  ): boolean {
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('rate limit') ||
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

function sleep(
  ms: number
): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

export const depositMonitor =
  new DepositMonitorService();
            
