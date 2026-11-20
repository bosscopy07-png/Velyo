import { Context } from 'telegraf';
import { config } from '../config';
import { prisma } from '../database';
import { redis, getUserSession, setUserSession, clearUserSession } from '../services/redis';
import { editMainMessage } from '../bot/utils/editMainMessage';
import { backKeyboard } from '../bot/keyboards/main';
import { e } from '../utils/emoji';
import { logger } from '../utils/logger';
import { webConfig } from '../web/config';
import { resolveSlug } from '../web/public';
import { formatLoadTest, runLoadTest } from '../web/loadtest-engine';
import { parseTestInput } from './loadtest-parse';

/**
 * Admin "Traffic Test": simulates many visitors opening a giveaway link and
 * asking for a claim code at the same instant, then reports PASS/FAIL with the
 * errors it saw. Safe by design:
 *  - admin only, one test at a time
 *  - only giveaways created by an ADMIN account can be targeted
 *  - needs LOADTEST_SECRET to be set (otherwise the tool refuses)
 *  - test traffic is excluded from the giveaway's real click/attempt statistics
 *  - codes created by the test just expire (default 10 min) and the slots return
 */
const STATE = 'admin_loadtest';
const DEFAULT_USERS = 50;
const MAX_USERS = 2000;
const isAdmin = (ctx: Context) => config.ADMIN_TELEGRAM_IDS.includes(ctx.from?.id.toString() ?? '');

const PROMPT =
  `${e('chart')} <b>TRAFFIC TEST</b>\n\n` +
  `Send the giveaway link, and optionally how many visitors.\n\n` +
  `Example: <code>https://yourdomain.com/g/abc123xyz 50</code>\n\n` +
  `• Default ${DEFAULT_USERS} visitors, maximum ${MAX_USERS}.\n` +
  `• Use a <b>test giveaway created by an admin account</b> (for example $1 with 20 slots).\n` +
  `• The test takes up the slots for about 10 minutes, then they return by themselves.\n` +
  `• Real visitors would be slowed down while it runs, so don't test during a live launch.`;

async function start(ctx: Context, text: string): Promise<void> {
  const tg = ctx.from!.id.toString();
  const cfg = webConfig();
  if (!cfg.loadTestSecret) {
    await clearUserSession(tg);
    await editMainMessage(ctx, `${e('warning')} The traffic test is switched off.\n\nAdd the setting <code>LOADTEST_SECRET</code> (any random text, at least 24 characters) on Render and redeploy to enable it.`, backKeyboard('admin'));
    return;
  }
  const parsed = parseTestInput(text);
  if (!parsed) {
    await editMainMessage(ctx, `${e('warning')} I couldn't find a giveaway link. It should look like <code>https://yourdomain.com/g/abc123xyz</code>.`, backKeyboard('admin'));
    return; // keep the step open so the admin can resend
  }
  await clearUserSession(tg);

  const id = await resolveSlug(parsed.slug);
  const giveaway = id ? await prisma.giveaway.findUnique({ where: { id }, include: { creator: { select: { telegramId: true } } } }) : null;
  if (!giveaway) return void (await ctx.reply(`${e('warning')} That giveaway link isn't known to this site.`, { parse_mode: 'HTML' }));
  if (!config.ADMIN_TELEGRAM_IDS.includes(giveaway.creator.telegramId)) {
    return void (await ctx.reply(`${e('warning')} For safety, only giveaways created by an admin account can be tested.`, { parse_mode: 'HTML' }));
  }
  if (giveaway.status !== 'ACTIVE') return void (await ctx.reply(`${e('warning')} That giveaway is not active (${giveaway.status}).`, { parse_mode: 'HTML' }));

  if ((await redis.set('loadtest:lock', '1', 'EX', 600, 'NX')) !== 'OK') {
    return void (await ctx.reply(`${e('clock')} A traffic test is already running. Wait for its report first.`, { parse_mode: 'HTML' }));
  }
  const baseUrl = cfg.siteUrl ?? `http://127.0.0.1:${cfg.port}`;
  await ctx.reply(`⏳ Running the test: <b>${parsed.users}</b> visitors against <code>${baseUrl}</code>… the report comes in about a minute.`, { parse_mode: 'HTML' });

  // Run in the background so the Telegram update handler is not held open.
  void (async () => {
    try {
      const report = await runLoadTest({ baseUrl, slug: parsed.slug, users: parsed.users, secret: cfg.loadTestSecret! });
      logger.info(`[loadtest] ${report.verdict}: ${report.users} users, ${report.claim.issued} codes, ${report.durationMs}ms`);
      await ctx.reply(formatLoadTest(report), { parse_mode: 'HTML' });
    } catch (err) {
      logger.error(`[loadtest] failed: ${(err as Error).message}`);
      await ctx.reply(`${e('warning')} The test itself crashed: <code>${(err as Error).message.slice(0, 200)}</code>`, { parse_mode: 'HTML' }).catch(() => {});
    } finally {
      await redis.del('loadtest:lock');
    }
  })();
}

export function registerLoadTest(bot: any): void {
  bot.action('admin:loadtest', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await setUserSession(ctx.from!.id.toString(), { state: STATE });
    await editMainMessage(ctx, PROMPT, backKeyboard('admin'));
  });

  bot.command('loadtest', async (ctx: Context) => {
    if (!isAdmin(ctx)) return;
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    const arg = text.replace(/^\/loadtest(@\w+)?/i, '').trim();
    if (arg) return start(ctx, arg);
    await setUserSession(ctx.from!.id.toString(), { state: STATE });
    await ctx.reply(PROMPT, { parse_mode: 'HTML' });
  });

  bot.on('text', async (ctx: Context, next: () => Promise<void>) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    if (!ctx.from || text.startsWith('/') || !isAdmin(ctx)) return next();
    const session = await getUserSession(ctx.from.id.toString());
    if (session?.state !== STATE) return next();
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    await start(ctx, text);
  });
}
  
