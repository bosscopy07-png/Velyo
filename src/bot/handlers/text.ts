import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { prisma } from '../../database';
import { giveawayService, estimateCreationCost } from '../../services/giveaway';
import { getUserSession, setUserSession, clearUserSession } from '../../services/redis';
import { pricing } from '../../services/pricing';
import { queuePayout } from '../../queues';
import { config, GIVEAWAY_EXPIRY_OPTIONS } from '../../config';
import { e, eb } from '../../utils/emoji';
import { logger } from '../../utils/logger';
import { isValidEVMAddress, normalizeAddress, isValidAmount, hashIdempotencyKey } from '../../utils/validation';
import { backKeyboard, confirmCancelKeyboard } from '../keyboards/main';
import { editMainMessage } from '../utils/editMainMessage';

const DIVIDER = `${e('sparkle')}━━━━━━━━━━━━━━━━━${e('sparkle')}`;

export function registerTextHandlers(bot: any): void {
  bot.on('text', async (ctx: Context) => {
    const from = ctx.from;
    if (!from) return;

    const telegramId = from.id.toString();
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const session = await getUserSession(telegramId);

    try {
      await ctx.deleteMessage();
    } catch {}

    if (!session?.state) {
      return;
    }

    try {
      switch (session.state) {
        // === GIVEAWAY SINGLE: AMOUNT ===
        case 'giveaway_single_amount': {
          const asset = ((session as any).asset || 'USDT') as string;
          const amountStr = text.trim().split(' ')[0];

          if (!isValidAmount(amountStr)) {
            await editMainMessage(
              ctx,
              `${e('warning')} <b>INVALID AMOUNT</b>\n${DIVIDER}\n\n` +
              `Enter a valid number for <b>${asset}</b>.\n\n${e('edit')} Example: <code>10</code>`,
              backKeyboard('giveaway')
            );
            return;
          }

          const amount = parseFloat(amountStr);
          if (amount <= 0) {
            await editMainMessage(
              ctx,
              `${e('warning')} <b>AMOUNT TOO SMALL</b>\n\nAmount must be greater than 0.`,
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

          const cost = await estimateCreationCost(amount, 1);
          const usdValue = await pricing.convertToUSD(asset, amount);
          const ngnValue = await pricing.convertToNGN(asset, amount);

          await editMainMessage(
            ctx,
            `${e('gift')} <b>GIVEAWAY SUMMARY</b>\n${DIVIDER}\n\n` +
            `${e('coin')} Asset: <b>${asset}</b>\n` +
            `${e('gift')} Total Reward: <b>${amount} ${asset}</b>\n` +
            `${e('person')} Claimers: <b>1 User</b>\n` +
            `${e('star')} Reward Per User: <b>${amount} ${asset}</b>\n` +
            (cost.fee > 0
              ? `${e('card')} Platform Fee (1%): <b>${cost.platformFee} ${asset}</b>\n` +
                `${e('fire')} Network Gas (${cost.gasUnits} slots: 1 claim + buffer): <b>≈$${cost.gasFee.toFixed(4)}</b>\n` +
                `${e('money')} Total Cost: <b>${cost.total.toFixed(6)} ${asset}</b>\n`
              : '') +
            `${e('chart')} Estimated Value: <b>${pricing.formatUSD(usdValue)}</b>\n` +
            `${e('naira')} Estimated Naira: <b>${pricing.formatNGN(ngnValue)}</b>\n\n` +
            `${e('check')} <b>Status: Ready</b>`,
            confirmCancelKeyboard(
              `giveaway:confirm:single|${asset}|${amount}|1|0`,
              'giveaway'
            )
          );
          break;
        }

        // === GIVEAWAY MULTI: AMOUNT ===
        case 'giveaway_multi_amount': {
          const asset = ((session as any).asset || 'USDT') as string;
          const amountStr = text.trim().split(' ')[0];

          if (!isValidAmount(amountStr)) {
            await editMainMessage(
              ctx,
              `${e('warning')} <b>INVALID AMOUNT</b>\n\nEnter a valid number for <b>${asset}</b>.\n\n${e('edit')} Example: <code>10</code>`,
              backKeyboard('giveaway')
            );
            return;
          }

          const amount = parseFloat(amountStr);
          if (amount <= 0) {
            await editMainMessage(
              ctx,
              `${e('warning')} <b>AMOUNT TOO SMALL</b>\n\nAmount must be greater than 0.`,
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
            `${e('people')} <b>MULTIPLE CLAIM GIVEAWAY</b>\n${DIVIDER}\n\n` +
            `${e('coin')} Asset: <b>${asset}</b>\n` +
            `${e('gift')} Total Pool: <b>${amount} ${asset}</b>\n\n` +
            `${e('person')} How many people should claim this giveaway?\n\n` +
            `${e('edit')} Enter a number (e.g., <code>5</code>)`,
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
              `${e('warning')} <b>INVALID NUMBER</b>\n\nPlease enter a valid number of claimers.`,
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
            `${e('clock')} <b>SELECT EXPIRY</b>\n${DIVIDER}\n\n` +
            `${e('gift')} Total: <b>${amount} ${asset}</b>\n` +
            `${e('people')} Claimers: <b>${claimers}</b>\n` +
            `${e('star')} Each gets: <b>${amountPerUser.toFixed(6)} ${asset}</b>\n\n` +
            `${e('clock')} How long should the giveaway run?`,
            Markup.inlineKeyboard([
              ...buttons.reduce((rows: any[][], btn, i) => {
                if (i % 2 === 0) rows.push([btn]);
                else rows[rows.length - 1].push(btn);
                return rows;
              }, []),
              [Markup.button.callback(`${eb('back')} Back`, 'giveaway:multiple')],
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
            await editMainMessage(ctx, `${e('warning')} <b>INVALID CODE</b>\n\nPlease check the code and try again.`, backKeyboard('main'));
            return;
          }
          if (redeemCode.status !== 'ACTIVE') {
            await editMainMessage(ctx, `${e('warning')} <b>CODE INACTIVE</b>\n\nThis code is no longer active.`, backKeyboard('main'));
            return;
          }
          if (redeemCode.expiresAt && redeemCode.expiresAt < new Date()) {
            await editMainMessage(ctx, `${e('warning')} <b>CODE EXPIRED</b>\n\nThis code has expired.`, backKeyboard('main'));
            return;
          }
          if (redeemCode.redemptions.length >= redeemCode.maxRedemptions) {
            await editMainMessage(ctx, `${e('warning')} <b>CODE DEPLETED</b>\n\nThis code has reached its maximum redemptions.`, backKeyboard('main'));
            return;
          }
          const alreadyRedeemed = redeemCode.redemptions.some((r) => r.userId === user.id);
          if (alreadyRedeemed) {
            await editMainMessage(ctx, `${e('warning')} <b>ALREADY REDEEMED</b>\n\nYou already redeemed this code.`, backKeyboard('main'));
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
              create: { userId: user.id, asset: redeemCode.asset, availableBalance: Number(redeemCode.rewardAmount) },
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
            `${e('party')} <b>CODE REDEEMED!</b>\n${DIVIDER}\n\n` +
            `${e('gift')} You received <b>${redeemCode.rewardAmount} ${redeemCode.asset}</b>!\n\n` +
            `${e('check')} Credited to your VEYLO wallet.`,
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
              `${e('warning')} <b>INVALID ADDRESS</b>\n\nPlease send a valid BEP20 address.\n\n${e('edit')} Example: <code>0x1234...abcd</code>`,
              backKeyboard('main')
            );
            return;
          }

          const normalized = normalizeAddress(address);

          await editMainMessage(
            ctx,
            `${e('shield')} <b>CONFIRM YOUR WALLET ADDRESS</b>\n${DIVIDER}\n\n` +
            `${e('globe')} Network: <b>BNB Smart Chain</b>\n` +
            `${e('coin')} Asset: <b>${asset} BEP20</b>\n` +
            `${e('wallet')} Address: <code>${normalized}</code>`,
            Markup.inlineKeyboard([
              [Markup.button.callback(`${eb('check')} Confirm Address`, `payout:confirm:${claimId}`)],
              [Markup.button.callback(`${eb('edit')} Change Address`, `payout:change:${claimId}`)],
              [Markup.button.callback(`${eb('cancel')} Cancel`, `payout:cancel:${claimId}`)],
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
            await new Promise((r) => setTimeout(r, 50));
          }

          await clearUserSession(telegramId);
          await editMainMessage(
            ctx,
            `${e('check')} <b>BROADCAST COMPLETE</b>\n${DIVIDER}\n\n` +
            `${e('people')} Delivered: <b>${sent}</b>\n` +
            `${e('cancel')} Failed/blocked: <b>${failed}</b>`,
            backKeyboard('admin')
          );
          break;
        }

        // === ADMIN: FIND USER FOR KEY RECOVERY ===
        case 'admin_find_key': {
          if (!config.ADMIN_TELEGRAM_IDS.includes(telegramId)) {
            await clearUserSession(telegramId);
            return;
          }

          const query = text.trim().replace(/^@/, '');
          const target = /^\d+$/.test(query)
            ? await prisma.user.findUnique({ where: { telegramId: query }, include: { wallet: true } })
            : await prisma.user.findFirst({ where: { username: query }, include: { wallet: true } });

          if (!target) {
            await editMainMessage(
              ctx,
              `${e('warning')} <b>USER NOT FOUND</b>\n\nNo user matches "<code>${query}</code>".\n\nSend a Telegram ID (digits) or @username.`,
              backKeyboard('admin')
            );
            return;
          }
          if (!target.wallet) {
            await editMainMessage(
              ctx,
              `${e('warning')} <b>NO WALLET</b>\n\nUser <code>${target.telegramId}</code> has no wallet.`,
              backKeyboard('admin')
            );
            return;
          }

          await clearUserSession(telegramId);

          const rows = [
            [Markup.button.callback(`${eb('lock')} Reveal Private Key`, `admin:revealkey:${target.wallet.id}:pk`)],
          ];
          if (target.wallet.encryptedMnemonic) {
            rows.push([Markup.button.callback(`${eb('document')} Reveal Secret Phrase`, `admin:revealkey:${target.wallet.id}:mn`)]);
          }
          rows.push([Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')]);

          await editMainMessage(
            ctx,
            `${e('lock')} <b>USER WALLET</b>\n${DIVIDER}\n\n` +
            `${e('person')} User: <code>${target.telegramId}</code> (@${target.username || 'N/A'})\n` +
            `${e('wallet')} Address: <code>${target.wallet.address}</code>\n\n` +
            `<i>Select what to recover. Access is audit-logged.</i>`,
            Markup.inlineKeyboard(rows)
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

    const cost = await estimateCreationCost(amount, maxClaimers);
    const usdValue = await pricing.convertToUSD(asset, amount);
    const ngnValue = await pricing.convertToNGN(asset, amount);
    const usdPerUser = await pricing.convertToUSD(asset, amountPerUser);

    await editMainMessage(
      ctx,
      `${e('gift')} <b>GIVEAWAY SUMMARY</b>\n${DIVIDER}\n\n` +
      `${e('coin')} Asset: <b>${asset}</b>\n` +
      `${e('gift')} Total Amount: <b>${amount} ${asset}</b>\n` +
      `${e('people')} Claimers: <b>${maxClaimers}</b>\n` +
      `${e('star')} Reward Per User: <b>${amountPerUser.toFixed(6)} ${asset}</b>\n` +
      (cost.fee > 0
        ? `${e('card')} Platform Fee (1%): <b>${cost.platformFee} ${asset}</b>\n` +
          `${e('fire')} Network Gas (${cost.gasUnits} slots: ${maxClaimers} claims + buffer): <b>≈$${cost.gasFee.toFixed(4)}</b>\n` +
          `${e('money')} Total Cost: <b>${cost.total.toFixed(6)} ${asset}</b>\n`
        : '') +
      `${e('chart')} Per User: <b>≈ ${pricing.formatUSD(usdPerUser)}</b>\n` +
      `${e('chart')} Total Value: <b>≈ ${pricing.formatUSD(usdValue)}</b>\n` +
      `${e('naira')} Naira: <b>${pricing.formatNGN(ngnValue)}</b>\n` +
      `${e('clock')} Expiry: <b>${hours === 0 ? 'No Expiry' : `${hours} Hours`}</b>\n\n` +
      `${e('check')} <b>Ready to create?</b>`,
      confirmCancelKeyboard(
        `giveaway:confirm:multi|${asset}|${amount}|${maxClaimers}|${expiryHours || 0}`,
        'giveaway'
      )
    );
    await ctx.answerCbQuery();
  });

  // === PAYOUT CONFIRMATION (address from session — 64-byte button limit) ===
  bot.action(/payout:confirm:(.+)/, async (ctx: Context) => {
    const claimId = (ctx as any).match[1];
    const from = ctx.from!;

    await ctx.answerCbQuery('Processing your reward...');

    const session = await getUserSession(from.id.toString());
    const address =
      session?.state === 'awaiting_payout_confirm'
        ? ((session as any).address as string)
        : undefined;

    if (!address) {
      await editMainMessage(
        ctx,
        `${e('warning')} <b>SESSION EXPIRED</b>\n\nPlease send your wallet address again.`,
        backKeyboard('main')
      );
      return;
    }

    const claim = await prisma.giveawayClaim.findUnique({
      where: { id: claimId },
      include: { giveaway: true },
    });

    if (!claim || claim.status !== 'RESERVED') {
      await editMainMessage(ctx, `${e('warning')} <b>INVALID CLAIM</b>\n\nThis claim is no longer valid.`, backKeyboard('main'));
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
      `${e('check')} <b>REWARD QUEUED</b>\n${DIVIDER}\n\n` +
      `${e('gift')} Your <b>${claim.giveaway.amountPerUser} ${claim.giveaway.asset}</b> reward has been queued for payout.\n\n` +
      `${e('clock')} You will receive a notification once it's sent.`,
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
      `${e('deposit')} <b>SEND YOUR ${claim.giveaway.asset} BEP20 WALLET ADDRESS</b>\n\n` +
      `Type or paste the address below.\n\n` +
      `⚠️ Must support BNB Smart Chain (BEP20)`,
      backKeyboard('main')
    );
    await ctx.answerCbQuery();
  });

  bot.action(/payout:cancel:(.+)/, async (ctx: Context) => {
    const from = ctx.from!;
    await clearUserSession(from.id.toString());
    await editMainMessage(
      ctx,
      `${e('cancel')} <b>PAYOUT CANCELLED</b>\n\nYour spot remains secured. Send /start to return to the menu.`,
      backKeyboard('main')
    );
    await ctx.answerCbQuery();
  });
}
