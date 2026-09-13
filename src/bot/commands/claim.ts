import { Context } from 'telegraf';
import { prisma } from '../../database';
import { handleGiveawayDeepLink } from './start';
import { e } from '../../utils/emoji';

export async function handleClaim(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const msg = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const code = msg.split(' ')[1]?.trim();

  if (!code) {
    await ctx.reply(`${e('warning')} Usage: /claim CODE\n\nExample: /claim aB3xY9kL2mN7pQ4rT8wZ`);
    return;
  }

  const user = await prisma.user.findUnique({ where: { telegramId: from.id.toString() } });
  if (!user) {
    await ctx.reply(`${e('warning')} Please send /start first.`);
    return;
  }

  // Reuse the exact same claim flow as the deep link
  await handleGiveawayDeepLink(ctx, user.id, code);
}
