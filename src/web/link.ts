import { prisma } from '../database';
import { webConfig } from './config';
import { slugFor } from './public';

/**
 * Public website URL for a giveaway, or null if the website URL isn't
 * configured (PUBLIC_WEBSITE_URL) or the giveaway wouldn't be listed there.
 * Never throws into the caller's flow beyond what the caller catches.
 */
export async function webGiveawayUrl(giveawayId: string): Promise<string | null> {
  const cfg = webConfig();
  if (!cfg.siteUrl) return null;
  if (cfg.listingScope === 'admins') {
    const g = await prisma.giveaway.findUnique({ where: { id: giveawayId }, select: { creator: { select: { telegramId: true } } } });
    if (!g || !cfg.adminTelegramIds.includes(g.creator.telegramId)) return null;
  }
  return `${cfg.siteUrl}/g/${await slugFor(giveawayId)}`;
}
