import { Context } from 'telegraf';
import { prisma } from '../../database';
import { decrypt } from '../../utils/encryption';
import { config } from '../../config';
import { logger } from '../../utils/logger';

/**
 * TEMPORARY recovery command — admin only.
 * Usage: /recoverkey 0xFundedAddress
 * DELETE THIS FILE after recovering your funds.
 */
export async function handleRecoverKey(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  // Only you (admin) can use this
  if (!config.ADMIN_TELEGRAM_IDS.includes(from.id.toString())) {
    return; // silently ignore everyone else
  }

  const msg = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const address = msg.split(' ').slice(1).join(' ').trim();
  if (!address) {
    await ctx.reply('Usage: /recoverkey 0xYourAddress');
    return;
  }

  const wallet = await prisma.wallet.findFirst({
    where: { address: { equals: address.toLowerCase(), mode: 'insensitive' } },
  });

  if (!wallet) {
    const all = await prisma.wallet.findMany({ select: { address: true } });
    await ctx.reply(`Not found. Wallets in DB: ${all.map((w) => w.address).join(', ')}`);
    return;
  }

  const privateKey = decrypt(wallet.encryptedPrivateKey);
  logger.warn(`Key recovered for ${wallet.address} by admin ${from.id}`);

  await ctx.reply(
    `Address: ${wallet.address}\n\nPrivate key:\n<code>${privateKey}</code>`,
    { parse_mode: 'HTML' }
  );
  }
