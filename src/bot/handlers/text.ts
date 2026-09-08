import { Context } from 'telegraf';
import { prisma } from '../../database';
import { walletService } from '../../services/wallet';
import { giveawayService } from '../../services/giveaway';
import { getUserSession, setUserSession, clearUserSession } from '../../services/redis';
import { pricing } from '../../services/pricing';
import { blockchain } from '../../services/blockchain';
import { queuePayout } from '../../queues';
import { config, GIVEAWAY_EXPIRY_OPTIONS } from '../../config';
import { e } from '../../utils/emoji';
import { logger } from '../../utils/logger';
import { isValidEVMAddress, normalizeAddress, isValidAmount, hashIdempotencyKey } from '../../utils/validation';
import { Markup } from 'telegraf';
import { backKeyboard, confirmCancelKeyboard, assetKeyboard } from '../keyboards/main';

export function registerTextHandlers(bot: any): void {
  bot.on('text', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const telegramId = from.id.toString();
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const session = await getUserSession(telegramId);
    
    if (!session?.state) {
      // Ignore random text if not in a flow
      return;
    }

    try {
      switch (session.state) {
        // === GIVEAWAY SINGLE: AMOUNT ===
        case 'giveaway_single_amount': {
          const parts = text.trim().split(' ');
          const amountStr = parts[0];
          const asset = (parts[1] || 'USDT').toUpperCase();

          if (!isValidAmount(amountStr)) {
            await ctx.reply(`${e('warning')} Invalid amount. Please enter a valid number.`);
            return;
          }

          const amount = parseFloat(amountStr);
          if (amount <= 0) {
            await ctx.reply(`${e('warning')} Amount must be greater than 0.`);
            return;
          }

          await setUserSession(telegramId, {
            state: 'giveaway_single_confirm',
            amount,
            asset,
            maxClaimers: 1,
          });

          const usdValue = await pricing.convertToUSD(asset, amount);
          const ngnValue = await pricing.convertToNGN(asset, amount);

          await ctx.reply(
            `${e('gift')} <b>GIVEAWAY SUMMARY</b>\n\n` +
            `<b>Total Reward:</b> ${amount} ${asset}\n` +
            `<b>Claimers:</b> 1 User\n` +
            `<b>Reward Per User:</b> ${amount} ${asset}\n` +
            `<b>Estimated Value:</b> ${pricing.formatUSD(usdValue)}\n` +
            `<b>Estimated Naira:</b> ${pricing.formatNGN(ngnValue)}\n\n` +
            `<b>Status:</b> Ready`,
            {
              parse_mode: 'HTML',
              reply_markup: confirmCancelKeyboard(
                `giveaway:confirm:single|${asset}|${amount}|1|0`,
                'giveaway'
              ).reply_markup,
            }
          );
          break;
        }

        // === GIVEAWAY MULTI: AMOUNT ===
        case 'giveaway_multi_amount': {
          const parts = text.trim().split(' ');
          const amountStr = parts[0];
          const asset = (parts[1] || 'USDT').toUpperCase();

          if (!isValidAmount(amountStr)) {
            await ctx.reply(`${e('warning')} Invalid amount. Please enter a valid number.`);
            return;
          }

          const amount = parseFloat(amountStr);
          if (amount <= 0) {
            await ctx.reply(`${e('warning')} Amount must be greater than 0.`);
            return;
          }

          await setUserSession(telegramId, {
            state: 'giveaway_multi_claimers',
            amount,
            asset,
          });

          await ctx.reply(
            `${e('people')} How many people should claim this giveaway?\n\n` +
            `Enter a number (e.g., 5)`,
            { reply_markup: backKeyboard('giveaway').reply_markup }
          );
          break;
        }

        // === GIVEAWAY MULTI: CLAIMERS ===
        case 'giveaway_multi_claimers': {
          const claimers = parseInt(text.trim());
          if (isNaN(claimers) || claimers < 1) {
            await ctx.reply(`${e('warning')} Please enter a valid number of claimers.`);
            return;
          }

          const { amount, asset } = session as any;
          const amountPerUser = amount / claimers;

          await setUserSession(telegramId, {
            state: 'giveaway_multi_expiry',
            amount,
            asset,
            maxClaimers: claimers,
            amountPerUser,
          });

          const buttons = GIVEAWAY_EXPIRY_OPTIONS.map(opt => 
            Markup.button.callback(opt.label, `giveaway:expiry:${opt.hours || 0}`)
          );
          
          await ctx.reply(
            `${e('clock')} Select giveaway expiry:`,
            Markup.inlineKeyboard([
              ...buttons.reduce((rows: any[][], btn, i) => {
                if (i % 2 === 0) rows.push([btn]);
                else rows[rows.length - 1].push(btn);
                return rows;
              }, []),
              [Markup.button.callback(`${e('back')} Back`, 'giveaway:multiple')],
            ])
          );
          break;
        }

        // === REDEEM CODE ===
        case 'redeem_code': {
          const code = text.trim().toUpperCase();
          const user = await prisma.user.findUnique({ where: { telegramId } });
          if (!user) return;

          const redeemCode = await prisma.redeemCode.findUnique({
            where: { code },
            include: { redemptions: true },
          });

          if (!redeemCode) {
            await ctx.reply(`${e('warning')} Invalid code. Please check and try again.`);
            return;
          }

          if (redeemCode.status !== 'ACTIVE') {
            await ctx.reply(`${e('warning')} This code is no longer active.`);
            return;
          }

          if (redeemCode.expiresAt && redeemCode.expiresAt < new Date()) {
            await ctx.reply(`${e('warning')} This code has expired.`);
            return;
          }

          if (redeemCode.redemptions.length >= redeemCode.maxRedemptions) {
            await ctx.reply(`${e('warning')} This code has reached its maximum redemptions.`);
            return;
          }

          const alreadyRedeemed = redeemCode.redemptions.some(r => r.userId === user.id);
          if (alreadyRedeemed) {
            await ctx.reply(`${e('warning')} You already redeemed this code.`);
            return;
          }

          // Process redemption
          await prisma.$transaction(async (tx) => {
            await tx.codeRedemption.create({
              data: {
                codeId: redeemCode.id,
                userId: user.id,
                amount: Number(redeemCode.rewardAmount),
              },
            });

            await tx.redeemCode.update({
              where: { id: redeemCode.id },
              data: { redemptionCount: { increment: 1 } },
            });

            await tx.balance.upsert({
              where: { userId_asset: { userId: user.id, asset: redeemCode.asset } },
              create: {
                userId: user.id,
                asset: redeemCode.asset,
                availableBalance: Number(redeemCode.rewardAmount),
              },
              update: {
                availableBalance: { increment: Number(redeemCode.rewardAmount) },
              },
            });

            await tx.transaction.create({
              data: {
                userId: user.id,
                type: 'CODE_REDEMPTION',
                asset: redeemCode.asset,
                amount: Number(redeemCode.rewardAmount),
                fee: 0,
                netAmount: Number(redeemCode.rewardAmount),
                status: 'CONFIRMED',
                idempotencyKey: hashIdempotencyKey('redeem', redeemCode.id, user.id),
              },
            });
          });

          await clearUserSession(telegramId);
          await ctx.reply(
            `${e('party')} <b>CODE REDEEMED!</b>\n\n` +
            `You received <b>${redeemCode.rewardAmount} ${redeemCode.asset}</b>!`,
            { parse_mode: 'HTML' }
          );
          break;
        }

        // === PAYOUT ADDRESS ===
        case 'awaiting_payout_address': {
          const address = text.trim();
          const { claimId, asset } = session as any;

          if (!isValidEVMAddress(address)) {
            await ctx.reply(
              `${e('warning')} Invalid address. Please send a valid BEP20 address.\n\n` +
              `Example: <code>0x1234...abcd</code>`,
              { parse_mode: 'HTML' }
            );
            return;
          }

          const normalized = normalizeAddress(address);

          await ctx.reply(
            `${e('shield')} <b>Confirm Your Wallet Address</b>\n\n` +
            `<b>Network:</b> BNB Smart Chain\n` +
            `<b>Asset:</b> ${asset} BEP20\n` +
            `<b>Address:</b> <code>${normalized}</code>`,
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback(`${e('check')} Confirm Address`, `payout:confirm:${claimId}:${normalized}`)],
                [Markup.button.callback(`${e('edit')} Change Address`, `payout:change:${claimId}`)],
                [Markup.button.callback(`${e('cancel')} Cancel`, `payout:cancel:${claimId}`)],
              ]).reply_markup,
            }
          );

          await setUserSession(telegramId, {
            state: 'awaiting_payout_confirm',
            claimId,
            asset,
            address: normalized,
          });
          break;
        }

        default:
          await clearUserSession(telegramId);
      }
    } catch (err) {
      logger.error('Text handler error:', err);
      await ctx.reply(`${e('warning')} An error occurred. Please try again.`);
      await clearUserSession(telegramId);
    }
  });

  // === EXPIRY SELECTION ===
  bot.action(/giveaway:expiry:(\d+)/, async (ctx: Context) => {
    const hours = parseInt((ctx as any).match[1]);
    const from = ctx.from!;
    const session = await getUserSession(from.id.toString());
    
    if (!session || session.state !== 'giveaway_multi_expiry') {
      await ctx.answerCbQuery('Session expired. Start over.');
      return;
    }

    const { amount, asset, maxClaimers, amountPerUser } = session as any;
    const expiryHours = hours === 0 ? null : hours;

    await setUserSession(from.id.toString(), {
      state: 'giveaway_multi_confirm',
      amount,
      asset,
      maxClaimers,
      expiryHours,
    });

    const usdValue = await pricing.convertToUSD(asset, amount);
    const ngnValue = await pricing.convertToNGN(asset, amount);
    const usdPerUser = await pricing.convertToUSD(asset, amountPerUser);

    await ctx.editMessageText(
      `${e('gift')} <b>GIVEAWAY SUMMARY</b>\n\n` +
      `<b>Total Amount:</b> ${amount} ${asset}\n` +
      `<b>Total Claimers:</b> ${maxClaimers}\n` +
      `<b>Reward Per User:</b> ${amountPerUser.toFixed(6)} ${asset}\n` +
      `<b>Estimated Reward:</b> ≈ ${pricing.formatUSD(usdPerUser)} per user\n` +
      `<b>Total Value:</b> ≈ ${pricing.formatUSD(usdValue)}\n` +
      `<b>Estimated Naira:</b> ${pricing.formatNGN(ngnValue)}\n` +
      `<b>Expiry:</b> ${hours === 0 ? 'No Expiry' : `${hours} Hours`}\n\n` +
      `Ready to create?`,
      {
        parse_mode: 'HTML',
        reply_markup: confirmCancelKeyboard(
          `giveaway:confirm:multi|${asset}|${amount}|${maxClaimers}|${expiryHours || 0}`,
          'giveaway'
        ).reply_markup,
      }
    );
    await ctx.answerCbQuery();
  });

  // === PAYOUT CONFIRMATION ===
  bot.action(/payout:confirm:(.+):(.+)/, async (ctx: Context) => {
    const claimId = (ctx as any).match[1];
    const address = (ctx as any).match[2];
    const from = ctx.from!;

    await ctx.answerCbQuery('Processing your reward...');

    const claim = await prisma.giveawayClaim.findUnique({
      where: { id: claimId },
      include: { giveaway: true },
    });

    if (!claim || claim.status !== 'RESERVED') {
      await ctx.reply(`${e('warning')} Invalid or expired claim.`);
      return;
    }

    // Update claim
    await giveawayService.submitAddress(claimId, address);

    // Queue payout
    const idempotencyKey = hashIdempotencyKey('payout', claimId, Date.now().toString());
    await queuePayout({
      claimId,
      giveawayId: claim.giveawayId,
      userId: claim.userId,
      address,
      amount: Number(claim.giveaway.amountPerUser),
      asset: claim.giveaway.asset,
      idempotencyKey,
    });

    await clearUserSession(from.id.toString());

    await ctx.editMessageText(
      `${e('check')} <b>REWARD QUEUED</b>\n\n` +
      `Your <b>${claim.giveaway.amountPerUser} ${claim.giveaway.asset}</b> reward has been queued for payout.\n\n` +
      `You will receive a notification once it's sent.`,
      { parse_mode: 'HTML' }
    );
  });

  bot.action(/payout:change:(.+)/, async (ctx: Context) => {
    const claimId = (ctx as any).match[1];
    const from = ctx.from!;
    
    const claim = await prisma.giveawayClaim.findUnique({
      where: { id: claimId },
      include: { giveaway: true },
    });
    
    if (!claim) return;

    await setUserSession(from.id.toString(), {
      state: 'awaiting_payout_address',
      claimId,
      asset: claim.giveaway.asset,
    });

    await ctx.editMessageText(
      `📥 Send your ${claim.giveaway.asset} BEP20 wallet address.\n\n` +
      `⚠️ Must support BNB Smart Chain (BEP20)`
    );
    await ctx.answerCbQuery();
  });

  bot.action(/payout:cancel:(.+)/, async (ctx: Context) => {
    const from = ctx.from!;
    await clearUserSession(from.id.toString());
    await ctx.editMessageText(`${e('cancel')} Payout cancelled.`);
    await ctx.answerCbQuery();
  });
}
