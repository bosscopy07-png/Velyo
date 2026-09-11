import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { prisma } from '../../database';
import { giveawayService } from '../../services/giveaway';
import { getUserSession, setUserSession, clearUserSession } from '../../services/redis';
import { pricing } from '../../services/pricing';
import { queuePayout } from '../../queues';
import { config, GIVEAWAY_EXPIRY_OPTIONS } from '../../config';
import { e } from '../../utils/emoji';
import { logger } from '../../utils/logger';
import { isValidEVMAddress, normalizeAddress, isValidAmount, hashIdempotencyKey } from '../../utils/validation';
import { backKeyboard, confirmCancelKeyboard } from '../keyboards/main';
import { editMainMessage } from '../utils/editMainMessage';

export function registerTextHandlers(bot: any): void {
  bot.on('text', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const telegramId = from.id.toString();
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const session = await getUserSession(telegramId);

    // Always delete the user's message — the bot edits its own main message instead
    try {
      await ctx.deleteMessage();
    } catch {
      // message already gone or not deletable — non-fatal
    }

    if (!session?.state) {
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
            await editMainMessage(
              ctx,
              `${e('warning')} Invalid amount. Please enter a valid number.\n\nExample: <code>10 USDT</code>`,
              backKeyboard('giveaway')
            );
            return;
          }

          const amount = parseFloat(amountStr);
          if (amount <= 0) {
            await editMainMessage(
              ctx,
              `${e('warning')} Amount must be greater than 0.`,
              backKeyboard('giveaway')
            );
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

          await editMainMessage(
            ctx,
            `${e('gift')} <b>GIVEAWAY SUMMARY</b>\n\n` +
            `<b>Total Reward:</b> ${amount} ${asset}\n` +
            `<b>Claimers:</b> 1 User\n` +
            `<b>Reward Per User:</b> ${amount} ${asset}\n` +
            `<b>Estimated Value:</b> ${pricing.formatUSD(usdValue)}\n` +
            `<b>Estimated Naira:</b> ${pricing.formatNGN(ngnValue)}\n\n` +
            `<b>Status:</b> Ready`,
            confirmCancelKeyboard(
              `giveaway:confirm:single|${asset}|${amount}|1|0`,
              'giveaway'
            )
          );
          break;
        }

        // === GIVEAWAY MULTI: AMOUNT ===
        case 'giveaway_multi_amount': {
          const parts = text.trim().split(' ');
          const amountStr = parts[0];
          const asset = (parts[1] || 'USDT').toUpperCase();

          if (!isValidAmount(amountStr)) {
            await editMainMessage(
              ctx,
              `${e('warning')} Invalid amount. Please enter a valid number.\n\nExample: <code>10 USDT</code>`,
              backKeyboard('giveaway')
            );
            return;
          }

          const amount = parseFloat(amountStr);
          if (amount <= 0) {
            await editMainMessage(
              ctx,
              `${e('warning')} Amount must be greater than 0.`,
              backKeyboard('giveaway')
            );
            return;
          }

          await setUserSession(telegramId, {
            state: 'giveaway_multi_claimers',
            amount,
            asset,
          });

          await editMainMessage(
            ctx,
            `${e('people')} <b>MULTIPLE CLAIM GIVEAWAY</b>\n\n` +
            `Amount: <b>${amount} ${asset}</b>\n\n` +
            `How many people should claim this giveaway?\n\nEnter a number (e.g., 5)`,
            backKeyboard('giveaway:multiple')
          );
          break;
        }

        // === GIVEAWAY MULTI: CLAIMERS ===
        case 'giveaway_multi_claimers': {
          const claimers = parseInt(text.trim());
          if (isNaN(claimers) || claimers < 1) {
            await editMainMessage(
              ctx,
              `${e('warning')} Please enter a valid number of claimers.`,
              backKeyboard('giveaway:multiple')
            );
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

          const buttons = GIVEAWAY_EXPIRY_OPTIONS.map((opt) =>
            Markup.button.callback(opt.label, `giveaway:expiry:${opt.hours || 0}`)
          );

          await editMainMessage(
            ctx,
            `${e('clock')} <b>SELECT EXPIRY</b>\n\nTotal: ${amount} ${asset} | ${claimers} claimers | ${amountPerUser.toFixed(6)} ${asset} each`,
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

        // === REDEEM CODE (flow kept for compatibility; no UI button anymore) ===
        case 'redeem_code': {
          const code = text.trim().toUpperCase();
          const user = await prisma.user.findUnique({ where: { telegramId } });
          if (!user) return;

          const redeemCode = await prisma.redeemCode.findUnique({
            where: { code },
            include: { redemptions: true },
          });

          if (!redeemCode) {
            await editMainMessage(ctx, `${e('warning')} Invalid code. Please check and try again.`, backKeyboard('main'));
            return;
          }

          if (redeemCode.status !== 'ACTIVE') {
            await editMainMessage(ctx, `${e('warning')} This code is no longer active.`, backKeyboard('main'));
            return;
          }

          if (redeemCode.expiresAt && redeemCode.expiresAt < new Date()) {
            await editMainMessage(ctx, `${e('warning')} This code has expired.`, backKeyboard('main'));
            return;
          }

          if (redeemCode.redemptions.length >= redeemCode.maxRedemptions) {
            await editMainMessage(ctx, `${e('warning')} This code has reached its maximum redemptions.`, backKeyboard('main'));
            return;
          }

          const alreadyRedeemed = redeemCode.redemptions.some((r) => r.userId === user.id);
          if (alreadyRedeemed) {
            await editMainMessage(ctx, `${e('warning')} You already redeemed this code.`, backKeyboard('main'));
            return;
          }

          await prisma.$transaction(async (tx) => {
            await tx.codeRedemption.create({
              data: { codeId: redeemCode.id, userId: user.id, amount: Number(redeemCode.rewardAmount) },
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
              update: { availableBalance: { increment: Number(redeemCode.rewardAmount) } },
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
          await editMainMessage(
            ctx,
            `${e('party')} <b>CODE REDEEMED!</b>\n\nYou received <b>${redeemCode.rewardAmount} ${redeemCode.asset}</b>!`,
            backKeyboard('main')
          );
          break;
        }

        // === PAYOUT ADDRESS ===
        case 'awaiting_payout_address': {
          const address = text.trim();
          const { claimId, asset } = session as any;

          if (!isValidEVMAddress(address)) {
            await editMainMessage(
              ctx,
              `${e('warning')} Invalid address. Please send a valid BEP20 address.\n\nExample: <code>0x1234...abcd</code>`,
              backKeyboard('main')
            );
            return;
          }

          const normalized = normalizeAddress(address);

          await editMainMessage(
            ctx,
            `${e('shield')} <b>Confirm Your Wallet Address</b>\n\n` +
            `<b>Network:</b> BNB Smart Chain\n` +
            `<b>Asset:</b> ${asset} BEP20\n` +
            `<b>Address:</b> <code>${normalized}</code>`,
            Markup.inlineKeyboard([
              [Markup.button.callback(`${e('check')} Confirm Address`, `payout:confirm:${claimId}:${normalized}`)],
              [Markup.button.callback(`${e('edit')} Change Address`, `payout:change:${claimId}`)],
              [Markup.button.callback(`${e('cancel')} Cancel`, `payout:cancel:${claimId}`)],
            ])
          );

          await setUserSession(telegramId, {
            state: 'awaiting_payout_confirm',
            claimId,
            asset,
            address: normalized,
          });
          break;
        }

        // === ADMIN BROADCAST ===
        case 'admin_broadcast': {
          if (!config.ADMIN_TELEGRAM_IDS.includes(telegramId)) {
            await clearUserSession(telegramId);
            return;
          }

          const users = await prisma.user.findMany({
            where: { chatId: { not: null } },
            select: { chatId: true },
          });

          let sent = 0;
          let failed = 0;
          for (const u of users) {
            try {
              await ctx.telegram.sendMessage(u.chatId!, text);
              sent++;
            } catch {
              failed++;
            }
            // gentle rate limit — Telegram allows ~30 msg/s; stay well under
            await new Promise((r) => setTimeout(r, 50));
          }

          await clearUserSession(telegramId);
          await editMainMessage(
            ctx,
            `${e('check')} <b>BROADCAST COMPLETE</b>\n\nDelivered: ${sent}\nFailed/blocked: ${failed}`,
            backKeyboard('admin')
          );
          break;
        }

        default:
          await clearUserSession(telegramId);
      }
    } catch (err) {
      logger.error('Text handler error:', err);
      await editMainMessage(
        ctx,
        `${e('warning')} An error occurred. Please try again.`,
        backKeyboard('main')
      );
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

    await editMainMessage(
      ctx,
      `${e('gift')} <b>GIVEAWAY SUMMARY</b>\n\n` +
      `<b>Total Amount:</b> ${amount} ${asset}\n` +
      `<b>Total Claimers:</b> ${maxClaimers}\n` +
      `<b>Reward Per User:</b> ${amountPerUser.toFixed(6)} ${asset}\n` +
      `<b>Estimated Reward:</b> ≈ ${pricing.formatUSD(usdPerUser)} per user\n` +
      `<b>Total Value:</b> ≈ ${pricing.formatUSD(usdValue)}\n` +
      `<b>Estimated Naira:</b> ${pricing.formatNGN(ngnValue)}\n` +
      `<b>Expiry:</b> ${hours === 0 ? 'No Expiry' : `${hours} Hours`}\n\n` +
      `Ready to create?`,
      confirmCancelKeyboard(
        `giveaway:confirm:multi|${asset}|${amount}|${maxClaimers}|${expiryHours || 0}`,
        'giveaway'
      )
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
      await editMainMessage(ctx, `${e('warning')} Invalid or expired claim.`, backKeyboard('main'));
      return;
    }

    await giveawayService.submitAddress(claimId, address);

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

    await editMainMessage(
      ctx,
      `${e('check')} <b>REWARD QUEUED</b>\n\n` +
      `Your <b>${claim.giveaway.amountPerUser} ${claim.giveaway.asset}</b> reward has been queued for payout.\n\n` +
      `You will receive a notification once it's sent.`,
      backKeyboard('main')
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

    await editMainMessage(
      ctx,
      `📥 Send your ${claim.giveaway.asset} BEP20 wallet address.\n\n⚠️ Must support BNB Smart Chain (BEP20)`,
      backKeyboard('main')
    );
    await ctx.answerCbQuery();
  });

  bot.action(/payout:cancel:(.+)/, async (ctx: Context) => {
    const from = ctx.from!;
    await clearUserSession(from.id.toString());
    await editMainMessage(ctx, `${e('cancel')} Payout cancelled.`, backKeyboard('main'));
    await ctx.answerCbQuery();
  });
            }
            
