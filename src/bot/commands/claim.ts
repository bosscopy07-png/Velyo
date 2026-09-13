import { Context } from 'telegraf';
import { prisma } from '../../database';
import { handleGiveawayDeepLink } from './start';
import { e } from '../../utils/emoji';

/**
 * /claim CODE — manual giveaway claim, works even when the t.me deep link
 * doesn't deliver its start parameter.
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

  // Identical flow to the deep link
  await handleGiveawayDeepLink(ctx, user.id, code);
}
