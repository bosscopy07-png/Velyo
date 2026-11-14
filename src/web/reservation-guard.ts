import { prisma } from '../database';

/**
 * Number of slots currently HELD by live website reservations for a giveaway.
 * Used by giveawayService.claimGiveaway so a direct Telegram claim can never
 * take a slot that a website visitor is holding. A reservation is "live"
 * while ACTIVE and not past expiresAt (so correctness never depends on the
 * cleanup cron having run).
 */
export async function countActiveReservations(giveawayId: string, excludeReservationId?: string): Promise<number> {
  return prisma.giveawayReservation.count({
    where: {
      giveawayId,
      status: 'ACTIVE',
      expiresAt: { gt: new Date() },
      ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
    },
  });
    }
