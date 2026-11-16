import { webConfig } from './config';
import { slugFor } from './public';

/**
 * Public website URL for a giveaway, or null if PUBLIC_WEBSITE_URL isn't set.
 * Every giveaway gets an unguessable link its creator can share; whether it
 * also appears in the public LISTS is controlled by WEB_LISTING_SCOPE.
 */
export async function webGiveawayUrl(giveawayId: string): Promise<string | null> {
  const cfg = webConfig();
  if (!cfg.siteUrl) return null;
  return `${cfg.siteUrl}/g/${await slugFor(giveawayId)}`;
}
