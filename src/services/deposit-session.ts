import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import cron from 'node-cron';
import { prisma } from '../database';
import { redis } from './redis';
import { blockchain } from './blockchain';
import { feeConfig } from './fee-config';
import { decrypt, hashIdempotencyKey } from '../utils/encryption';
import { logger } from '../utils/logger';
import { config, ASSETS, type AssetSymbol } from '../config';
import { pickUniqueSuffix, computeExpectedAmount } from './fee-math';

// Re-exported so existing/future importers keep a single import site.
export { pickUniqueSuffix, computeExpectedAmount };

/**
 * Deposit-session architecture (spec §11–21).
 *
 * A deposit is a TIME-BOXED session, not a permanent per-user monitor:
 *   DEPOSIT tap → session created (30-min window, company pool address
 *   assigned, expected amount = requested + fee + unique suffix)
 *   → user sends funds → "I HAVE DEPOSITED" performs an immediate active
 *   verification → confirmed → credit (guarded, idempotent) → funds
 *   forwarded to treasury.
 *
 * Identification (spec §14): PRIMARY = session + assigned address + txHash
 * uniqueness + amount match. The unique suffix is a SECONDARY aid only.
 *
 * RPC profile (spec §17/§19): the only background polling is a light sweep
 * (2×/min) over DETECTED sessions awaiting confirmation depth and session
 * expiry — bounded by ACTIVE SESSION COUNT, never by total user count.
 * No permanent per-user loop is created by this module. (The legacy
 * deposit-monitor.ts per-user scanning remains in place until deliberately
 * decommissioned — historical DepositMonitor rows stay for audit.)
 */

const SESSION_TTL_MS = config.DEPOSIT_SESSION_TTL_MINUTES * 60_000;
const REQUIRED_CONFIRMATIONS = 15;
/** Amount match tolerance (asset units) — suffix is advisory, not exact. */
const AMOUNT_TOLERANCE = 0.001;

export type VerifyResult =
  | { status: 'credited'; amount: number }
  | { status: 'already_credited' }
  | { status: 'pending_confirmations'; txHash: string }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'error'; reason: string };

class DepositSessionService {
  /**
   * Creates a deposit session and assigns a company pool address
   * (least-recently-assigned ACTIVE wallet — deterministic, recorded against
   * the session for audit; spec §13).
   */
  async createSession(userId: string, asset: AssetSymbol, requestedAmount: number) {
    if (!config.ENABLE_DEPOSITS) throw new Error('Deposits are temporarily disabled');
    if (!(requestedAmount > 0)) throw new Error('Invalid amount');

    const fees = await feeConfig.getFees();

    // Assign pool address: round-robin by lastAssignedAt (never-assigned first).
    const wallet = await prisma.companyDepositWallet.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: [{ lastAssignedAt: { sort: 'asc', nulls: 'first' } }],
    });
    if (!wallet) throw new Error('Deposit system is temporarily unavailable — no deposit addresses free');

    // Fee in asset units (deposit fees are configured in USD).
    let feeAsset = 0;
    if (fees.enableFees) {
      try {
        const { pricing } = await import('./pricing');
        const usdPerUnit = await pricing.convertToUSD(asset, 1);
        const usdValue = usdPerUnit > 0 ? requestedAmount * usdPerUnit : requestedAmount;
        const feeUSD = feeConfig.depositFlatFeeUSD(usdValue, fees);
        feeAsset = usdPerUnit > 0 ? Number((feeUSD / usdPerUnit).toFixed(8)) : feeUSD;
      } catch {
        // Pricing unreachable → proceed with zero fee rather than block the deposit.
        logger.warn('Pricing unavailable for deposit fee calc — fee set to 0');
      }
    }

    // Unique amount suffix — collision-checked against ALL live sessions so
    // two simultaneous deposits can never share an identifier (spec §14).
    const takenSuffixes = (
      await prisma.depositSession.findMany({
        where: { status: { in: ['AWAITING', 'DETECTED'] } },
        select: { uniqueSuffix: true },
      })
    ).map((s) => Number(s.uniqueSuffix));
    const suffix = pickUniqueSuffix(takenSuffixes);
    const expectedAmount = computeExpectedAmount(requestedAmount, feeAsset, suffix);

    const session = await prisma.depositSession.create({
      data: {
        userId,
        asset,
        requestedAmount,
        platformFee: feeAsset,
        expectedAmount,
        uniqueSuffix: suffix,
        assignedWalletId: wallet.id,
        paymentRef: `ds_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        status: 'AWAITING',
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });

    await prisma.companyDepositWallet.update({
      where: { id: wallet.id },
      data: { lastAssignedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        action: 'DEPOSIT_SESSION_CREATED',
        entityType: 'deposit_session',
        entityId: session.id,
        userId,
        newValue: { asset, requestedAmount, expectedAmount, address: wallet.address },
      },
    });

    return { session, address: wallet.address };
  }

  /**
   * "I HAVE DEPOSITED" — immediate active verification (spec §18).
   * Idempotent and race-safe: the guarded status transition guarantees a
   * single crediting path even if two taps arrive together (spec §20).
   */
  async verifySession(sessionId: string, requesterUserId: string): Promise<VerifyResult> {
    const session = await prisma.depositSession.findUnique({
      where: { id: sessionId },
      include: { assignedWallet: true },
    });
    if (!session || session.userId !== requesterUserId) return { status: 'error', reason: 'Session not found' };

    if (session.status === 'CREDITED') return { status: 'already_credited' };

    if (session.expiresAt < new Date() || session.status === 'EXPIRED') {
      await this.expireSession(session.id);
      return { status: 'expired' };
    }

    try {
      const detected = await this.findInboundTransfer(session);
      if (!detected) return { status: 'not_found' };

      // Receipt check: only successful txs are ever credited (spec §18.8).
      const receipt = await blockchain.getTransactionReceipt(detected.txHash);
      if (!receipt || receipt.status !== 1) return { status: 'not_found' };

      const provider = await blockchain.getProvider();
      const currentBlock = await provider.getBlockNumber();
      const confirmations = detected.blockNumber ? currentBlock - detected.blockNumber + 1 : 0;

      if (confirmations < REQUIRED_CONFIRMATIONS) {
        // Seen but immature — record DETECTED once; the sweep matures it.
        await prisma.depositSession.updateMany({
          where: { id: session.id, status: 'AWAITING' },
          data: { status: 'DETECTED', detectedTxHash: detected.txHash, detectedAmount: detected.amount },
        });
        return { status: 'pending_confirmations', txHash: detected.txHash };
      }

      return await this.creditSession(session, detected.txHash, detected.amount);
    } catch (err) {
      // RPC failure ≠ deposit failure (spec §35) — report inconclusive, mutate nothing.
      logger.error(`verifySession(${sessionId}) error: ${(err as Error).message}`);
      return { status: 'error', reason: 'Verification unavailable right now — please try again in a minute' };
    }
  }

  /**
   * Find an inbound transfer to the session's assigned address within the
   * session window. USDT: real Transfer events (real txHash). BNB: balance
   * delta between two observations (company deposit wallets only receive
   * user deposits — forwards go OUT), so a positive delta in the window is
   * a deposit; the synthetic ref embeds the session id and is unique per
   * session (txHash @unique).
   */
  private async findInboundTransfer(session: {
    id: string;
    asset: string;
    expectedAmount: number;
    assignedWallet: { address: string };
  }): Promise<{ txHash: string; amount: number; blockNumber?: number } | null> {
    const address = session.assignedWallet.address.toLowerCase();
    const provider = await blockchain.getProvider();
    const currentBlock = await provider.getBlockNumber();
    // Cover at least the session age + margin (max 2000 blocks ≈ ~66 min).
    const fromBlock = Math.max(1, currentBlock - 2000);

    if (session.asset === 'USDT') {
      const eventsByAddress = await blockchain.getTokenTransferEventsForAddresses(
        'USDT',
        [address],
        fromBlock,
        currentBlock
      );
      const events = eventsByAddress.get(address) ?? [];
      // Closest-amount match above the requested minimum; below-minimum
      // transfers are ignored (they can't be this session's payment).
      let best: { txHash: string; amount: number; blockNumber?: number } | null = null;
      let bestDiff = Infinity;
      for (const ev of events) {
        const amt = Number(ev.amount) / 1e18;
        if (amt < Number(session.expectedAmount) - AMOUNT_TOLERANCE * 10) continue;
        const diff = Math.abs(amt - Number(session.expectedAmount));
        if (diff < bestDiff) {
          bestDiff = diff;
          best = { txHash: ev.txHash, amount: amt, blockNumber: ev.blockNumber };
        }
      }
      return best;
    }

    // BNB: balance delta. First tap records the baseline; a later tap (or
    // the sweep's maturation path) compares. Honest trade-off: BNB has no
    // transfer-event log, and this keeps RPC usage to two balance reads.
    const key = `ds:bal:${session.id}`;
    const prevRaw = await redis.get(key);
    const current = Number((await blockchain.getBalance(session.assignedWallet.address, 'BNB')) / 1e18n);
    await redis.set(key, current.toFixed(12), 'EX', 3600);
    if (!prevRaw) return null; // need a second observation point

    const prev = parseFloat(prevRaw);
    const delta = current - prev;
    if (delta <= 0) return null;
    if (delta < Number(session.expectedAmount) - AMOUNT_TOLERANCE * 10) return null;
    return {
      txHash: `ds-bnb:${session.id}:${currentBlock}`,
      amount: delta,
      blockNumber: currentBlock,
    };
  }

  /**
   * The single crediting path. Guarded AWAITING/DETECTED → CREDITED
   * transition means exactly one winner per session, ever (spec §20). The
   * txHash is stored on the session (unique) and the ledger transaction
   * carries a derived unique idempotency key — a second worker/tap sees
   * "already credited" and does nothing.
   */
  private async creditSession(
    session: { id: string; userId: string; asset: string; requestedAmount: number; platformFee: number },
    txHash: string,
    onChainAmount: number
  ): Promise<VerifyResult> {
    const claimed = await prisma.depositSession.updateMany({
      where: { id: session.id, status: { in: ['AWAITING', 'DETECTED'] } },
      data: { status: 'CREDITED', txHash, creditedAmount: session.requestedAmount, creditedAt: new Date() },
    });
    if (claimed.count === 0) return { status: 'already_credited' };

    try {
      await prisma.$transaction(async (tx) => {
        // Only the INTENDED deposit amount becomes user balance (spec §15);
        // the fee and unique-suffix components stay platform-side.
        await tx.balance.upsert({
          where: { userId_asset: { userId: session.userId, asset: session.asset } },
          create: { userId: session.userId, asset: session.asset, availableBalance: session.requestedAmount },
          update: { availableBalance: { increment: session.requestedAmount } },
        });

        const depositTx = await tx.transaction.create({
          data: {
            userId: session.userId,
            type: 'DEPOSIT',
            asset: session.asset,
            amount: session.requestedAmount,
            fee: session.platformFee,
            netAmount: session.requestedAmount,
            status: 'CONFIRMED',
            transactionHash: txHash,
            idempotencyKey: hashIdempotencyKey('deposit-session', session.id),
            metadata: { depositSessionId: session.id, onChainAmount },
          },
        });

        if (session.platformFee > 0) {
          await tx.platformFee.create({
            data: {
              transactionId: depositTx.id,
              asset: session.asset,
              amount: session.platformFee,
              feeWallet: config.PLATFORM_FEE_WALLET,
              sweptAt: new Date(), // session fees are forwarded immediately (see forwardToTreasury)
            },
          });
        }
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Ledger row already exists (concurrent credit) — the session row is
        // already CREDITED; nothing further to do. No double credit.
        return { status: 'already_credited' };
      }
      throw err;
    }

    await prisma.auditLog.create({
      data: {
        action: 'DEPOSIT_CREDIT',
        entityType: 'deposit_session',
        entityId: session.id,
        userId: session.userId,
        newValue: { txHash, amount: session.requestedAmount, asset: session.asset },
      },
    });

    logger.info(`Deposit session ${session.id} credited: ${session.requestedAmount} ${session.asset} (tx ${txHash})`);

    // Forward to treasury fire-and-forget (spec §21).
    void this.forwardToTreasury(session.id).catch((err) =>
      logger.error(`Treasury forward failed for session ${session.id}: ${(err as Error).message}`)
    );

    return { status: 'credited', amount: session.requestedAmount };
  }

  /**
   * Forwards the received funds (minus a gas reserve for future forwards)
   * from the company deposit address to the platform treasury. Never sends
   * the full balance — the reserve stays behind as gas (spec §21).
   */
  async forwardToTreasury(sessionId: string): Promise<void> {
    const session = await prisma.depositSession.findUnique({
      where: { id: sessionId },
      include: { assignedWallet: true },
    });
    if (!session || session.forwardedAt || session.status !== 'CREDITED' || !session.txHash) return;

    const asset = session.asset as AssetSymbol;
    const assetConfig = ASSETS[asset];
    const rawBalance = await blockchain.getBalance(session.assignedWallet.address, asset);
    const decimals = assetConfig.decimals;

    // Reserve: two native-BNB-transfer worths stay behind for future forwards.
    const { estimateBnbTransferCost } = await import('./gas');
    const gasReserve = BigInt(Math.ceil((await estimateBnbTransferCost()) * 1e18)) * 2n;
    const forwardable = asset === 'BNB' ? rawBalance - gasReserve : rawBalance;
    if (forwardable <= 0n) {
      await prisma.depositSession.update({ where: { id: session.id }, data: { forwardedAt: new Date() } });
      return;
    }

    const { hash } = await blockchain.sendTransaction(
      decrypt(session.assignedWallet.encryptedPrivateKey),
      config.PLATFORM_FEE_WALLET,
      forwardable,
      asset,
      `ds-fwd-${session.id}`
    );

    await prisma.depositSession.update({
      where: { id: session.id },
      data: { forwardedAt: new Date() },
    });
    logger.info(`Session ${session.id} forwarded ${Number(forwardable) / 10 ** decimals} ${asset} to treasury (tx ${hash})`);
  }

  /** Guarded expiry flip — safe to call concurrently and repeatedly. */
  private async expireSession(sessionId: string): Promise<void> {
    await prisma.depositSession.updateMany({
      where: { id: sessionId, status: { in: ['AWAITING', 'DETECTED'] } },
      data: { status: 'EXPIRED' },
    });
  }

  /**
   * Background sweeps (spec §17/§19) — the ONLY recurring RPC work this
   * module performs: session expiry (DB-only) + maturation of DETECTED
   * sessions (real txHash path, bounded by live-session count).
   * Starts from bot/index.ts.
   */
  start(): void {
    cron.schedule('20 * * * * *', () => void this.sweep());
    cron.schedule('50 * * * * *', () => void this.sweep());
    logger.info('Deposit session sweeps started (expiry + DETECTED maturation, 2×/min)');
  }

  private async sweep(): Promise<void> {
    try {
      const now = new Date();

      const expired = await prisma.depositSession.updateMany({
        where: { status: { in: ['AWAITING', 'DETECTED'] }, expiresAt: { lt: now } },
        data: { status: 'EXPIRED' },
      });
      if (expired.count > 0) logger.info(`Expired ${expired.count} deposit session(s)`);

      const maturing = await prisma.depositSession.findMany({
        where: { status: 'DETECTED', expiresAt: { gte: now }, detectedTxHash: { not: null } },
        take: 20,
      });
      for (const s of maturing) {
        try {
          const receipt = await blockchain.getTransactionReceipt(s.detectedTxHash!);
          if (!receipt || receipt.status !== 1) continue; // not final — check again next sweep
          const provider = await blockchain.getProvider();
          const currentBlock = await provider.getBlockNumber();
          const confs = receipt.blockNumber ? currentBlock - receipt.blockNumber + 1 : 0;
          if (confs < REQUIRED_CONFIRMATIONS) continue;
          await this.creditSession(
            { id: s.id, userId: s.userId, asset: s.asset, requestedAmount: Number(s.requestedAmount), platformFee: Number(s.platformFee) },
            s.detectedTxHash!,
            Number(s.detectedAmount ?? s.expectedAmount)
          );
        } catch (err) {
          logger.warn(`Maturation check failed for session ${s.id}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      logger.error(`Deposit session sweep error: ${(err as Error).message}`);
    }
  }

  /** User-facing recent sessions (dashboard). */
  async listRecent(userId: string, take = 5) {
    return prisma.depositSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true, asset: true, requestedAmount: true, expectedAmount: true,
        status: true, txHash: true, expiresAt: true, createdAt: true,
        assignedWallet: { select: { address: true } },
      },
    });
  }
}

export const depositSessionService = new DepositSessionService();
    
