import { Context, Markup } from 'telegraf';
import { prisma } from '../database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { e, eb } from '../utils/emoji';
import { redis, setUserSession, clearUserSession } from '../services/redis';
import { editMainMessage } from '../bot/utils/editMainMessage';
import { backKeyboard } from '../bot/keyboards/main';
import {
  broadcastService,
  BroadcastDraft,
  BroadcastProgress,
  DEFAULT_EXPIRY_MIN,
  DELETE_AFTER_OPEN_MIN,
  EXPIRY_OPTIONS,
} from '../services/broadcast';

const DIVIDER = `${e('sparkle')}━━━━━━━━━━━━━━━━━${e('sparkle')}`;
const MAX_TEXT = 4096; // Telegram message limit
const DRAFT_TTL_SEC = 3600;
const HISTORY_PAGE = 8;

const draftKey = (adminId: string) => `bc:draft:${adminId}`;

const isAdminCtx = (ctx: Context): boolean =>
  !!ctx.from && config.ADMIN_TELEGRAM_IDS.includes(ctx.from.id.toString());

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function expiryLabel(min: number): string {
  return EXPIRY_OPTIONS.find((o) => o.minutes === min)?.label ?? `${min}m`;
}

function excerpt(text: string, max = 300): string {
  const t = text.length > max ? `${text.slice(0, max)}…` : text;
  return esc(t);
}

function fmtUtc(d: Date | null | undefined): string {
  return d ? `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC` : '—';
}

// ─────────────────────────── SCREENS ───────────────────────────

async function renderHub(ctx: Context): Promise<void> {
  const audience = await broadcastService.audienceCount();
  await editMainMessage(
    ctx,
    `${e('message')} <b>BROADCAST</b>\n${DIVIDER}\n\n` +
    `${e('people')} Reachable users: <b>${audience}</b>\n\n` +
    `Your text is sent exactly as you write it — no headline — with a button to the channel.\n\n` +
    `${e('clock')} <i>Auto-delete: ${DELETE_AFTER_OPEN_MIN} min after the user opens the bot, ` +
    `or at the time limit you pick if they never do.</i>`,
    Markup.inlineKeyboard([
      [Markup.button.callback(`${eb('edit')} New Broadcast`, 'admin:broadcast:new')],
      [Markup.button.callback(`${eb('document')} History`, 'admin:bc:list')],
      [Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')],
    ])
  );
}

async function renderPreview(ctx: Context, draft: BroadcastDraft): Promise<void> {
  const audience = await broadcastService.audienceCount();

  const expiryRow = EXPIRY_OPTIONS.map((o) =>
    Markup.button.callback(`${o.minutes === draft.expireMin ? '✅ ' : ''}${o.label}`, `admin:bc:exp:${o.minutes}`)
  );

  await editMainMessage(
    ctx,
    `${e('message')} <b>BROADCAST PREVIEW</b>\n${DIVIDER}\n\n` +
    `<blockquote>${excerpt(draft.text)}</blockquote>\n\n` +
    `${e('people')} Recipients: <b>${audience}</b>\n` +
    `${e('clock')} Deleted <b>${DELETE_AFTER_OPEN_MIN} min</b> after they open the bot\n` +
    `${e('warning')} If never opened, deleted after: <b>${expiryLabel(draft.expireMin)}</b> ↓`,
    Markup.inlineKeyboard([
      expiryRow,
      [Markup.button.callback(`🚀 Send to ${audience} users`, 'admin:bc:send')],
      [
        Markup.button.callback(`${eb('edit')} Rewrite`, 'admin:broadcast:new'),
        Markup.button.callback(`${eb('cancel')} Cancel`, 'admin:bc:cancel'),
      ],
    ])
  );
}

function progressText(p: BroadcastProgress): string {
  const handled = p.sent + p.failed;
  if (!p.done) {
    return (
      `${e('message')} <b>SENDING…</b>\n${DIVIDER}\n\n` +
      `${e('people')} Progress: <b>${handled}/${p.target}</b>\n` +
      `${e('check')} Delivered: <b>${p.sent}</b>\n` +
      `${e('cancel')} Failed/blocked: <b>${p.failed}</b>`
    );
  }
  return (
    `${e('check')} <b>BROADCAST SENT</b>\n${DIVIDER}\n\n` +
    `${e('check')} Delivered: <b>${p.sent}</b>\n` +
    `${e('cancel')} Failed/blocked: <b>${p.failed}</b>\n\n` +
    `<i>Messages clean themselves up — track it under History.</i>`
  );
}

async function renderHistory(ctx: Context): Promise<void> {
  const rows = await prisma.broadcast.findMany({
    orderBy: { createdAt: 'desc' },
    take: HISTORY_PAGE,
    select: { id: true, createdAt: true, sentCount: true, targetCount: true, status: true, text: true },
  });

  let text = `${e('document')} <b>BROADCAST HISTORY</b>\n${DIVIDER}\n\n`;
  if (rows.length === 0) text += 'No broadcasts sent yet.';

  const buttons = rows.map((b) => {
    const label = `${b.createdAt.toISOString().slice(5, 10)} · ${b.sentCount}/${b.targetCount} · ${b.status}`;
    return [Markup.button.callback(label, `admin:bc:view:${b.id}`)];
  });
  buttons.push([Markup.button.callback(`${eb('back')} Back`, 'admin:broadcast')]);

  await editMainMessage(ctx, text, Markup.inlineKeyboard(buttons));
}

async function renderView(ctx: Context, id: string): Promise<void> {
  const b = await prisma.broadcast.findUnique({ where: { id } });
  if (!b) {
    await editMainMessage(ctx, `${e('warning')} Broadcast not found.`, backKeyboard('admin:bc:list'));
    return;
  }
  const s = await broadcastService.stats(id);
  const openPct = s.total > 0 ? Math.round((s.opened / s.total) * 100) : 0;

  const rows = [];
  if (s.waiting > 0 && b.status !== 'RECALLED') {
    rows.push([Markup.button.callback(`🗑 Delete for everyone now (${s.waiting})`, `admin:bc:recall:${id}`)]);
  }
  rows.push([Markup.button.callback(`${eb('refresh')} Refresh`, `admin:bc:view:${id}`)]);
  rows.push([Markup.button.callback(`${eb('back')} History`, 'admin:bc:list')]);

  await editMainMessage(
    ctx,
    `${e('message')} <b>BROADCAST</b> · ${b.status}\n${DIVIDER}\n\n` +
    `<blockquote>${excerpt(b.text, 180)}</blockquote>\n\n` +
    `${e('clock')} Sent: ${fmtUtc(b.createdAt)}\n` +
    `${e('check')} Delivered: <b>${b.sentCount}</b> / ${b.targetCount} · failed ${b.failedCount}\n` +
    `${e('person')} Opened: <b>${s.opened}</b> (${openPct}%)\n` +
    `🗑 Deleted: <b>${s.deleted}</b> · waiting: <b>${s.waiting}</b>\n` +
    `${e('warning')} Time limit: ${expiryLabel(b.expireMinutes)}`,
    Markup.inlineKeyboard(rows)
  );
}

// ─────────────────────────── TEXT STEP (called from text handler) ───────────────────────────

export async function handleBroadcastDraft(ctx: Context): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const msg = ctx.message as { text?: string; entities?: unknown[] } | undefined;
  const text = msg?.text;
  const adminId = ctx.from!.id.toString();

  if (!text || !text.trim()) return;

  if (text.length > MAX_TEXT) {
    await editMainMessage(
      ctx,
      `${e('warning')} <b>TOO LONG</b>\n\nTelegram allows ${MAX_TEXT} characters; yours is ${text.length}. Shorten it and send again.`,
      backKeyboard('admin:broadcast')
    );
    return; // session stays so the admin can just resend
  }

  const draft: BroadcastDraft = { text, entities: msg?.entities ?? [], expireMin: DEFAULT_EXPIRY_MIN };
  await redis.setex(draftKey(adminId), DRAFT_TTL_SEC, JSON.stringify(draft));
  await clearUserSession(adminId);
  await renderPreview(ctx, draft);
}

// ─────────────────────────── REGISTRATION ───────────────────────────

export function registerBroadcastAdmin(bot: any): void {
  const adminOnly =
    (fn: (ctx: Context) => Promise<void>) =>
    async (ctx: Context) => {
      if (!isAdminCtx(ctx)) {
        await ctx.answerCbQuery('Not authorized.', { show_alert: true }).catch(() => undefined);
        return;
      }
      try {
        await fn(ctx);
      } catch (err) {
        logger.error(`Broadcast admin error: ${(err as Error).message}`);
        await ctx.answerCbQuery('Something went wrong. Check logs.', { show_alert: true }).catch(() => undefined);
      }
    };

  bot.action('admin:broadcast', adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    await clearUserSession(ctx.from!.id.toString());
    await renderHub(ctx);
  }));

  bot.action('admin:broadcast:new', adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    await setUserSession(ctx.from!.id.toString(), { state: 'admin_broadcast' }, 900);
    await editMainMessage(
      ctx,
      `${e('edit')} <b>WRITE YOUR BROADCAST</b>\n${DIVIDER}\n\n` +
      `Send the message now. It goes out <b>exactly as typed</b> (bold, links and other formatting are kept).\n\n` +
      `You'll see a preview before anything is sent.`,
      backKeyboard('admin:broadcast')
    );
  }));

  bot.action(/^admin:bc:exp:(\d+)$/, adminOnly(async (ctx) => {
    const minutes = parseInt((ctx as any).match[1], 10);
    if (!EXPIRY_OPTIONS.some((o) => o.minutes === minutes)) {
      await ctx.answerCbQuery();
      return;
    }
    const key = draftKey(ctx.from!.id.toString());
    const raw = await redis.get(key);
    if (!raw) {
      await ctx.answerCbQuery('Draft expired — write it again.', { show_alert: true });
      return;
    }
    const draft = JSON.parse(raw) as BroadcastDraft;
    draft.expireMin = minutes;
    await redis.setex(key, DRAFT_TTL_SEC, JSON.stringify(draft));
    await ctx.answerCbQuery(`Time limit: ${expiryLabel(minutes)}`);
    await renderPreview(ctx, draft);
  }));

  bot.action('admin:bc:cancel', adminOnly(async (ctx) => {
    await redis.del(draftKey(ctx.from!.id.toString()));
    await ctx.answerCbQuery('Cancelled');
    await renderHub(ctx);
  }));

  bot.action('admin:bc:send', adminOnly(async (ctx) => {
    const adminId = ctx.from!.id.toString();
    const key = draftKey(adminId);
    const raw = await redis.get(key);
    if (!raw) {
      await ctx.answerCbQuery('Draft expired — write it again.', { show_alert: true });
      return;
    }
    // DEL returns 1 only for the first tap, so a double-tap can never send twice.
    if ((await redis.del(key)) === 0) {
      await ctx.answerCbQuery('Already sending.');
      return;
    }
    await ctx.answerCbQuery('Broadcast started…');

    const draft = JSON.parse(raw) as BroadcastDraft;

    // Show the starting screen BEFORE the background send can post progress,
    // so a late initial edit can never overwrite a newer one.
    const audience = await broadcastService.audienceCount();
    await editMainMessage(ctx, progressText({ broadcastId: '', target: audience, sent: 0, failed: 0, done: false }));

    const id = await broadcastService.startBroadcast(draft, adminId, async (p) => {
      await editMainMessage(
        ctx,
        progressText(p),
        p.done
          ? Markup.inlineKeyboard([
              [Markup.button.callback(`${eb('chart')} Track it`, `admin:bc:view:${p.broadcastId}`)],
              [Markup.button.callback(`${eb('back')} Admin Panel`, 'admin')],
            ])
          : undefined
      );
    });

    logger.warn(`Admin ${adminId} started broadcast ${id}`);
    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'BROADCAST_SENT',
        entityType: 'broadcast',
        entityId: id,
        newValue: { expireMin: draft.expireMin, length: draft.text.length },
      },
    });
  }));

  bot.action('admin:bc:list', adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    await renderHistory(ctx);
  }));

  bot.action(/^admin:bc:view:(.+)$/, adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    await renderView(ctx, (ctx as any).match[1]);
  }));

  bot.action(/^admin:bc:recall:(.+)$/, adminOnly(async (ctx) => {
    const id = (ctx as any).match[1];
    await ctx.answerCbQuery();
    await editMainMessage(
      ctx,
      `${e('warning')} <b>DELETE FOR EVERYONE?</b>\n${DIVIDER}\n\n` +
      `This removes the broadcast from every user's chat right away, opened or not. It cannot be undone.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Yes, delete now', `admin:bc:recallok:${id}`)],
        [Markup.button.callback(`${eb('back')} Cancel`, `admin:bc:view:${id}`)],
      ])
    );
  }));

  bot.action(/^admin:bc:recallok:(.+)$/, adminOnly(async (ctx) => {
    const id = (ctx as any).match[1];
    await broadcastService.recall(id);
    await prisma.auditLog.create({
      data: { adminId: ctx.from!.id.toString(), action: 'BROADCAST_RECALLED', entityType: 'broadcast', entityId: id },
    });
    logger.warn(`Admin ${ctx.from!.id} recalled broadcast ${id}`);
    await ctx.answerCbQuery('Deleting from all chats…', { show_alert: true });
    await renderView(ctx, id);
  }));
}
