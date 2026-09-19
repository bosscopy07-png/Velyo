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

const MAX_LOG_WINDOW = 500;

/**
 * 0.000002 BNB = 2 × 10^12 wei.
 * Enough to fund one BEP20 forwarding transaction.
 */
const FORWARD_GAS_SEED = 2000000000000n;

const MIN_DEPOSIT: Record<string, number> = {
  BNB: 0.0001,
  USDT: config.MINIMUM_AMOUNT_USD,
};

/**
 * Spread wallet RPC requests across time instead of hammering
 * the RPC provider in one burst.
 */
const WALLET_SCAN_DELAY_MS = 1500;

type WalletWithUser = {
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
     * Run every minute.
     *
     * The internal lock prevents overlapping scans if one scan
     * takes longer than a minute.
     */
    cron.schedule('0 * * * * *', () => {
      void this.scanDeposits();
    });

    logger.info(
      'Deposit monitor started (chunked RPC scanning, rate-limit aware)'
    );
  }

  private async scanDeposits(): Promise<void> {
    if (this.isRunning) {
      logger.debug('Deposit monitor already running; skipping cycle');
      return;
    }

    this.isRunning = true;

    try {
      const wallets = await prisma.wallet.findMany({
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

      if (wallets.length === 0) {
        return;
      }

      const provider = await blockchain.getProvider();
      const currentBlock = await provider.getBlockNumber();

      const cursorKey = 'monitor:lastBlock';
      const cached = await redis.get(cursorKey);

      /**
       * First run:
       * only scan a small recent window.
       *
       * Subsequent runs:
       * continue from the last successful block.
       */
      const lastScanned = cached
        ? parseInt(cached, 10)
        : currentBlock - 20;

      /**
       * Never scan more than MAX_LOG_WINDOW blocks in one cycle.
       *
       * blockchain.getTokenTransferEvents() internally splits this
       * into RPC-safe chunks.
       */
      const fromBlock = Math.max(
        lastScanned + 1,
        currentBlock - MAX_LOG_WINDOW
      );

      logger.info(
        `Deposit scan started: ${fromBlock} → ${currentBlock} (${wallets.length} wallets)`
      );

      let scanFailed = false;

      for (const wallet of wallets) {
        try {
          if (fromBlock <= currentBlock) {
            const events =
              await blockchain.getTokenTransferEvents(
                'USDT',
                wallet.address,
                fromBlock,
                currentBlock
              );

            for (const event of events) {
              await this.processDeposit(wallet, 'USDT', {
                from: event.from,
                amount: event.amount,
                txHash: event.txHash,
              });
            }
          }
        } catch (err) {
          scanFailed = true;

          const msg = this.errorMessage(err);

          if (this.isRetryableRpcError(msg)) {
            logger.warn(
              `USDT scan temporarily failed for ${wallet.address}; ` +
                `cursor will NOT advance: ${msg}`
            );

            /**
             * Stop immediately.
             *
             * The same block window will be retried on the next cycle.
             */
            break;
          }

          logger.error(
            `Error scanning USDT for ${wallet.address}:`,
            err
          );
        }

        /**
         * BNB balance monitoring is independent of USDT event scanning.
         */
        try {
          await this.checkNativeBalance(wallet, currentBlock);
        } catch (err) {
          scanFailed = true;

          logger.error(
            `Error checking BNB balance for ${wallet.address}:`,
            err
          );
        }

        await sleep(WALLET_SCAN_DELAY_MS);
      }

      /**
       * IMPORTANT:
       *
       * Only advance the cursor after a complete successful pass.
       *
       * If RPC errors occurred, keeping the cursor unchanged means
       * deposits are not silently skipped.
       */
      if (!scanFailed) {
        await redis.set(
          cursorKey,
          currentBlock.toString()
        );

        logger.info(
          `Deposit scan completed successfully through block ${currentBlock}`
        );
      } else {
        logger.warn(
          `Deposit scan incomplete; cursor remains at ${lastScanned}`
        );
      }
    } catch (err) {
      logger.error('Deposit scan error:', err);
    } finally {
      this.isRunning = false;
    }
  }

  private async checkNativeBalance(
    wallet: WalletWithUser,
    currentBlock: number
  ): Promise<void> {
    const key = `monitor:bal:${wallet.address}:BNB`;

    const raw = await blockchain.getBalance(
      wallet.address,
      'BNB'
    );

    const current = Number(raw) / 1e18;

    const previous = await redis.get(key);

    /**
     * Always store the newest observed balance.
     */
    await redis.set(
      key,
      current.toFixed(12)
    );

    /**
     * First observation is only a baseline.
     * Do not credit it as a deposit.
     */
    if (!previous) {
      return;
    }

    const previousValue = parseFloat(previous);
    const diff = current - previousValue;

    if (diff <= 0) {
      return;
    }

    const amount = BigInt(
      Math.floor(diff * 1e18)
    );

    await this.processDeposit(
      wallet,
      'BNB',
      {
        from: '',
        amount,
        txHash: `bnb-diff:${wallet.address}:${currentBlock}`,
      }
    );
  }

  private async processDeposit(
    wallet: WalletWithUser,
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
        `Ignoring dust ${asset} deposit of ${amount} ` +
          `(< min ${minAmount})`
      );

      return;
    }

    /**
     * First idempotency check.
     */
    const existing =
      await prisma.transaction.findFirst({
        where: {
          transactionHash: event.txHash,
        },
      });

    if (existing) {
      return;
    }

    /**
     * Second idempotency layer.
     */
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

    /**
     * Confirm transaction exists and succeeded.
     */
    const receipt =
      await blockchain.getTransactionReceipt(
        event.txHash
      );

    if (!receipt || receipt.status !== 1) {
      return;
    }

    /**
     * Calculate fees.
     */
    const feePercent =
      config.ENABLE_FEES
        ? config.PLATFORM_FEE_PERCENT
        : 0;

    const platformFee =
      amount * (feePercent / 100);

    const gasFee =
      platformFee > 0
        ? await estimateGasUSDT(1)
        : 0;

    const totalFee =
      platformFee + gasFee;

    const netAmount =
      amount - totalFee;

    /**
     * Never credit a negative amount.
     */
    if (netAmount <= 0) {
      logger.warn(
        `Deposit ${event.txHash} rejected because fees ` +
          `(${totalFee}) exceed deposit amount (${amount})`
      );

      return;
    }

    /**
     * Mark the monitor record before processing.
     * The transaction itself is still protected by DB idempotency.
     */
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

    /**
     * Atomic database credit.
     */
    await prisma.$transaction(async (tx) => {
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
              hashIdempotencyKey(
                'deposit',
                event.txHash
              ),
          },
        });

      if (platformFee > 0) {
        const feeRow =
          await tx.platformFee.create({
            data: {
              transactionId: depositTx.id,
              asset,
              amount: platformFee,
              feeWallet:
                config.PLATFORM_FEE_WALLET,
            },
          });

        feeRowId = feeRow.id;
      }
    });

    /**
     * Mark processed only after the DB transaction succeeds.
     */
    await prisma.depositMonitor.updateMany({
      where: {
        txHash: event.txHash,
      },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
      },
    });

    logger.info(
      `Deposit credited: ${netAmount} ${asset} ` +
        `(${event.txHash.slice(0, 16)}...)`
    );

    /**
     * Immediate platform-fee forwarding.
     */
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

        if (baseline < FORWARD_GAS_SEED) {
          if (!config.OPERATOR_WALLET_KEY) {
            throw new Error(
              'OPERATOR_WALLET_KEY not configured'
            );
          }

          const seedAmount =
            FORWARD_GAS_SEED - baseline;

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
            Math.floor(platformFee * 1e18)
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
          `Fee forwarded: ${platformFee} USDT → ` +
            `platform wallet (tx ${hash})`
        );
      } catch (err) {
        logger.error(
          `Fee forward failed for ${event.txHash} ` +
            `(fee stays pending for admin sweep): ` +
            `${this.errorMessage(err)}`
        );
      }
    }

    /**
     * Telegram notification.
     */
    if (wallet.user.chatId) {
      await this.notify(
        wallet.user.chatId,
        `${'🟢'} <b>DEPOSIT RECEIVED</b>\n\n` +
          `<b>Amount:</b> ${amount} ${asset}\n` +
          (platformFee > 0
            ? `<b>Platform Fee (1%):</b> ` +
              `${platformFee.toFixed(6)} ${asset}\n`
            : '') +
          (gasFee > 0
            ? `<b>Network Gas:</b> ≈$${gasFee.toFixed(4)}\n`
            : '') +
          `<b>Credited:</b> ${netAmount.toFixed(6)} ${asset}\n` +
          `<b>Ref:</b> <code>${event.txHash.slice(
            0,
            24
          )}...</code>`,
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
      const response =
        await fetch(
          `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`,
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: html,
              parse_mode: 'HTML',
            }),
          }
        );

      const data =
        (await response.json()) as {
          ok: boolean;
          result?: {
            message_id: number;
          };
        };

      const messageId =
        data?.result?.message_id;

      if (!messageId) {
        return;
      }

      const timer = setTimeout(() => {
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
              message_id: messageId,
            }),
          }
        ).catch(() => {});
      }, ttlMs);

      timer.unref?.();
    } catch (err) {
      logger.error(
        'Deposit notify failed:',
        err
      );
    }
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }

    return String(err);
  }

  private isRetryableRpcError(
    message: string
  ): boolean {
    const msg = message.toLowerCase();

    return (
      msg.includes('rate limit') ||
      msg.includes('rate-limit') ||
      msg.includes('limit exceeded') ||
      msg.includes('-32005') ||
      msg.includes('-32615') ||
      msg.includes('request entity too large') ||
      msg.includes('eth_getlogs') ||
      msg.includes('range') ||
      msg.includes('too many requests') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('server response 5')
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
