import { Context, Markup } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { listOpenEvidence, reviewEvidence } from '../web/antiabuse';

/**
 * /webflags — admin-only review of giveaway-scoped duplicate evidence
 * (website claim codes + wallet registry). Separate from, and does not
 * change, the existing Security (claim flag) screen.
 */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
const isAdmin = (ctx: Context) => config.ADMIN_TELEGRAM_IDS.includes(ctx.from?.id.toString() ?? '');

const LEVEL_LABEL: Record<string, string> = {
  CONFIRMED_DUPLICATE: '🔴 Confirmed duplicate (auto-rejected)',
  STRONG_SUSPICIOUS: '🟠 Strong suspicious match (not blocked)',
  WEAK_SIGNAL: '🟡 Weak signal',
};

function render(ev: Awaited<ReturnType<typeof listOpenEvidence>>[number]): string {
  const signals = (Array.isArray(ev.signals) ? ev.signals : []) as { type: string; detail?: unknown }[];
  const related = (Array.isArray(ev.relatedTelegramIds) ? ev.relatedTelegramIds : []) as string[];
  const refs = (ev.signalRefs ?? {}) as { ip?: string | null; device?: string | null };
  return [
    `<b>${LEVEL_LABEL[ev.level] ?? ev.level}</b>`,
    `Decision: <b>${esc(ev.decision)}</b>  ·  ${ev.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `Giveaway: <code>${esc(ev.giveawayId)}</code>`,
    ev.maskedWallet ? `Wallet: <code>${esc(ev.maskedWallet)}</code>` : '',
    `Current claim: <code>${esc(ev.currentClaimId ?? '—')}</code>`,
    `Previous claim: <code>${esc(ev.previousClaimId ?? '—')}</code>${ev.previousClaimAt ? ` (${ev.previousClaimAt.toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''}`,
    related.length ? `Telegram IDs: ${related.map((r) => `<code>${esc(r)}</code>`).join(', ')}` : '',
    `Signals: ${signals.map((s) => esc(s.type)).join(', ') || '—'}`,
    refs.ip || refs.device ? `Refs: ip <code>${esc(refs.ip ?? '—')}</code> · device <code>${esc(refs.device ?? '—')}</code>` : '',
    '',
    `<i>Shared IP/device are supporting evidence only. Dismiss = false alarm; Confirm = abuse confirmed (no automatic ban is applied).</i>`,
  ].filter(Boolean).join('\n');
}

export function registerWebFlagsAdmin(bot: any): void {
  bot.command('webflags', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    try {
      const items = await listOpenEvidence(8);
      if (items.length === 0) {
        await ctx.reply('No open website duplicate flags. ✅');
        return;
      }
      for (const ev of items) {
        await ctx.reply(render(ev), {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[
            Markup.button.callback('✅ Dismiss', `webflag:dismiss:${ev.id}`),
            Markup.button.callback('🚫 Confirm abuse', `webflag:confirm:${ev.id}`),
          ]]),
        });
      }
    } catch (err) {
      logger.error(`/webflags error: ${(err as Error).message}`);
      await ctx.reply('Could not load flags.');
    }
  });

  bot.action(/^webflag:(dismiss|confirm):(.+)$/, async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    try {
      const [, action, id] = (ctx as any).match as string[];
      const done = await reviewEvidence(id, ctx.from!.id.toString(), action === 'dismiss' ? 'DISMISSED' : 'CONFIRMED');
      await ctx.answerCbQuery(done ? (action === 'dismiss' ? 'Dismissed' : 'Confirmed') : 'Already reviewed');
      try { await ctx.editMessageReplyMarkup(undefined); } catch { /* ignore */ }
    } catch (err) {
      logger.error(`webflag review error: ${(err as Error).message}`);
      try { await ctx.answerCbQuery('Something went wrong', { show_alert: true }); } catch { /* ignore */ }
    }
  });
}
