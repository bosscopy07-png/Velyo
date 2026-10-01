import { Context } from 'telegraf';
import { prisma } from '../../database';
import { handleGiveawayDeepLink } from './start';
import { e } from '../../utils/emoji';
import { logger } from '../../utils/logger';

/**
 * /claim CODE — manual giveaway claim, works even when the t.me deep link
 * doesn't deliver its start parameter.
 *
 * Same flow as the deep link; attribution source is recorded as MANUAL_CODE
 * (the deep-link path records GIVEAWAY_LINK) so referral analytics can
 * distinguish the two entry points.
 */
export async function handleClaim(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const msg = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const code = msg.split(' ')[1]?.trim();

  if (!code) {
    await ctx.reply(
      `${e('warning')} <b>Usage:</b> /claim CODE\n\nExample: <code>/claim aB3xY9kL2mN7pQ4rT8wZ</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const user = await prisma.user.findUnique({ where: { telegramId: from.id.toString() } });
  if (!user) {
    await ctx.reply(`${e('warning')} Please send /start first.`, { parse_mode: 'HTML' });
    return;
  }

  // Identical flow to the deep link — the attribution call inside
  // handleGiveawayDeepLink records source GIVEAWAY_LINK; for the manual
  // path we record MANUAL_CODE. Both are idempotent per giveaway+claimant.
  try {
    const giveaway = await prisma.giveaway.findUnique({ where: { secureCode: code }, select: { id: true } });
    if (giveaway) {
      const { attributionService } = await import('../../services/attribution');
      await attributionService
        .recordAttribution({ giveawayId: giveaway.id, claimantId: user.id, source: 'MANUAL_CODE' })
        .catch((err) => logger.error(`MANUAL_CODE attribution failed (non-fatal): ${(err as Error).message}`));
    }
  } catch (err) {
    logger.error(`Pre-claim attribution lookup failed (non-fatal): ${(err as Error).message}`);
  }

  await handleGiveawayDeepLink(ctx, user.id, code);
}
