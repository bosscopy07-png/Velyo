import { prisma } from '../database';
import { webConfig } from './config';
import { hashCode, isWellFormedCode } from './lib/codes';
import { claimProgress, isTxHash, type Progress } from './lib/progress';
import { ngnPerUnit, trimDecimal } from './public';

export type CodeStatusView =
  | { state: 'INVALID' }
  | { state: 'EXPIRED' }
  | { state: 'ACTIVE'; expiresAt: string }
  | {
      state: 'REDEEMED';
      progress: Progress;
      asset: string;
      amount: string;
      amountNgn: number | null;
      wallet: string | null;
      txHash: string | null;
    };

/**
 * What happened to a website claim code. Looked up by the code itself (a bearer
 * secret the visitor already holds), always fresh from the database. Returns the
 * payout receipt (amount, wallet, tx hash) only to the holder of that code, and
 * never exposes Telegram ids or internal ids.
 */
export async function codeStatus(rawCode: string): Promise<CodeStatusView> {
  if (!isWellFormedCode(rawCode)) return { state: 'INVALID' };
  const code = await prisma.giveawayWebCode.findUnique({ where: { codeHash: hashCode(webConfig().hashSecret, rawCode) } });
  if (!code) return { state: 'INVALID' };

  if (code.status === 'ACTIVE') {
    return code.expiresAt > new Date() ? { state: 'ACTIVE', expiresAt: code.expiresAt.toISOString() } : { state: 'EXPIRED' };
  }
  if (code.status !== 'REDEEMED') return { state: 'EXPIRED' };

  const giveaway = await prisma.giveaway.findUnique({ where: { id: code.giveawayId }, select: { asset: true, amountPerUser: true } });
  const claim = code.claimId
    ? await prisma.giveawayClaim.findUnique({ where: { id: code.claimId }, select: { status: true, walletAddress: true, payoutTransactionHash: true } })
    : null;
  const progress = claimProgress(claim?.status);
  const amount = giveaway ? trimDecimal(giveaway.amountPerUser) : '0';
  const rate = giveaway && progress === 'PAID' ? await ngnPerUnit(giveaway.asset) : null;
  return {
    state: 'REDEEMED',
    progress,
    asset: giveaway?.asset ?? '',
    amount,
    amountNgn: rate ? Math.round(Number(amount) * rate) : null,
    wallet: progress === 'PAID' || progress === 'PROCESSING' ? claim?.walletAddress ?? null : null,
    txHash: progress === 'PAID' && isTxHash(claim?.payoutTransactionHash) ? claim!.payoutTransactionHash! : null,
  };
}
