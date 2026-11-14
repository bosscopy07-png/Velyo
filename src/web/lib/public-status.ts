/** Pure mapping from raw giveaway rows to the public website status. */

export type PublicStatus = 'ACTIVE' | 'ALMOST_FULL' | 'FULL' | 'EXPIRED' | 'CANCELLED';

export interface StatusInput {
  status: string; // GiveawayStatus
  expiresAt: Date | null;
  maxClaimers: number;
  claimedCount: number;
  activeReservations: number;
  now?: Date;
}

export interface StatusResult {
  status: PublicStatus;
  availableSlots: number;
  claimable: boolean;
}

/** Slots free for NEW website claim codes (claimed + temporarily held are both unavailable). */
export function computeAvailable(maxClaimers: number, claimedCount: number, activeReservations: number): number {
  return Math.max(0, maxClaimers - claimedCount - activeReservations);
}

export function derivePublicStatus(i: StatusInput): StatusResult {
  const now = i.now ?? new Date();
  const available = computeAvailable(i.maxClaimers, i.claimedCount, i.activeReservations);

  if (i.status === 'CANCELLED') return { status: 'CANCELLED', availableSlots: 0, claimable: false };
  if (i.status === 'EXPIRED' || (i.expiresAt && i.expiresAt.getTime() <= now.getTime()))
    return { status: 'EXPIRED', availableSlots: 0, claimable: false };
  // Ended / paying-out / finished giveaways never accept new claims.
  if (['FULL', 'PROCESSING', 'COMPLETED'].includes(i.status))
    return { status: 'FULL', availableSlots: 0, claimable: false };
  if (i.status !== 'ACTIVE') return { status: 'CANCELLED', availableSlots: 0, claimable: false };

  if (available <= 0) return { status: 'FULL', availableSlots: 0, claimable: false };
  const almost = available <= 2 || available / Math.max(1, i.maxClaimers) <= 0.2;
  return { status: almost ? 'ALMOST_FULL' : 'ACTIVE', availableSlots: available, claimable: true };
}

/** Statuses that never appear in listings (drafts, failed). */
export const LISTABLE_DB_STATUSES = ['ACTIVE', 'FULL', 'EXPIRED', 'CANCELLED', 'COMPLETED', 'PROCESSING'] as const;
