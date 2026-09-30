import cron from 'node-cron';
import type { Telegram } from 'telegraf';
import { prisma } from '../database';
import { redis } from './redis';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Broadcast engine.
 *
 * DELETE RULES
 *  1. "Opened" rule: Telegram never tells a bot when a message is READ, so the
 *     signal is the user's first interaction with the bot (any tap, /start or
 *     message) after the broadcast arrived. That starts a 5-minute countdown.
 *  2. Hard cap: if the user never interacts, the message is deleted anyway when
 *     the admin-chosen cap (1h / 6h / 24h / 47h) runs out. Capped below 48h
 *     because Telegram stops letting bots delete messages older than 48 hours.
 *
 * Every delivery stores its own `deleteAt`: the hard cap at send time, pulled
 * earlier to (opened + 5 min) on first interaction. One sweeper deletes what is due.
 */

export const DELETE_AFTER_OPEN_MIN = 5;

export const EXPIRY_OPTIONS = [
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '24h', minutes: 1440 },
  { label: '47h', minutes: 2820 },
] as const;
export const DEFAULT_EXPIRY_MIN = 1440;

const SEND_DELAY_MS = 40; // ~25 msg/s, under Telegram's ~30 msg/s broadcast limit
const BATCH_SIZE = 200;
const PROGRESS_EVERY = 100;
const SWEEP_BATCH = 300;
const MAX_DELETE_ATTEMPTS = 5;

const pendingKey = (telegramId: string) => `bc:pending:${telegramId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BroadcastDraft {
  text: string;
  entities?: unknown[];
  expireMin: number;
}

export interface BroadcastProgress {
  broadcastId: string;
  target: number;
  sent: number;
  failed: number;
  done: boolean;
}

function errDescription(err: unknown): string {
  const d = (err as any)?.response?.description ?? (err as Error)?.message ?? '';
  return typeof d === 'string' ? d : String(d);
}

/** Errors where retrying the delete can never succeed. */
const PERMANENT_DELETE_ERROR =
  /message to delete not found|message can't be deleted|chat not found|bot was blocked|user is deactivated|forbidden|have no rights/i;

class BroadcastService {
  private telegram: Telegram | null = null;
  private sweeping = false;

  start(telegram: Telegram): void {
    this.telegram = telegram;

    // A restart mid-send leaves a SENDING row nobody is working on.
    prisma.broadcast
      .updateMany({ where: { status: 'SENDING' }, data: { status: 'INTERRUPTED', finishedAt: new Date() } })
      .catch((err) => logger.warn(`Broadcast startup cleanup failed: ${(err as Error).message}`));

    cron.schedule('*/20 * * * * *', () => void this.sweepDue());
    logger.info('Broadcast service started (auto-delete sweeper every 20s)');
  }

  audienceWhere() {
    return { chatId: { not: null }, status: { not: 'BANNED' as const } };
  }

  audienceCount(): Promise<number> {
    return prisma.user.count({ where: this.audienceWhere() });
  }

  /** Creates the broadcast row and sends in the background. Returns immediately. */
  async startBroadcast(
    draft: BroadcastDraft,
    adminId: string,
    onProgress?: (p: BroadcastProgress) => Promise<void>
  ): Promise<string> {
    if (!this.telegram) throw new Error('Broadcast service not started');

    const target = await this.audienceCount();
    const row = await prisma.broadcast.create({
      data: {
        createdBy: adminId,
        text: draft.text,
        entities: (draft.entities ?? undefined) as any,
        expireMinutes: draft.expireMin,
        targetCount: target,
      },
    });

    void this.run(row.id, draft, target, onProgress).catch((err) =>
      logger.error(`Broadcast ${row.id} crashed: ${(err as Error).message}`)
    );
    return row.id;
  }

  private async run(
    id: string,
    draft: BroadcastDraft,
    target: number,
    onProgress?: (p: BroadcastProgress) => Promise<void>
  ): Promise<void> {
    let sent = 0;
    let failed = 0;
    let cursor: string | undefined;
    const report = async (done: boolean) => {
      if (!onProgress) return;
      try { await onProgress({ broadcastId: id, target, sent, failed, done }); } catch { /* cosmetic */ }
    };

    for (;;) {
      const current = await prisma.broadcast.findUnique({ where: { id }, select: { status: true } });
      if (current?.status === 'RECALLED') break;

      const users = await prisma.user.findMany({
        where: this.audienceWhere(),
        select: { id: true, telegramId: true, chatId: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (users.length === 0) break;
      cursor = users[users.length - 1].id;

      for (const u of users) {
        const ok = await this.deliver(id, u.telegramId, u.chatId!, draft);
        if (ok) sent++; else failed++;
        if ((sent + failed) % PROGRESS_EVERY === 0) await report(false);
        await sleep(SEND_DELAY_MS);
      }
      if (users.length < BATCH_SIZE) break;
    }

    const after = await prisma.broadcast.findUnique({ where: { id }, select: { status: true } });
    const recalled = after?.status === 'RECALLED';
    await prisma.broadcast.update({
      where: { id },
      data: {
        sentCount: sent,
        failedCount: failed,
        finishedAt: new Date(),
        ...(recalled ? {} : { status: 'COMPLETED' as const }),
      },
    });
    // Messages that landed after a recall still have to go.
    if (recalled) await this.scheduleAllNow(id);

    logger.info(`Broadcast ${id} finished: sent=${sent} failed=${failed} target=${target}`);
    await report(true);
  }

  private async deliver(broadcastId: string, telegramId: string, chatId: string, draft: BroadcastDraft): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // The admin's text is the whole message — no headline, no signature.
        // Only control we add: the channel button.
        const msg = await this.telegram!.sendMessage(chatId, draft.text, {
          ...(draft.entities && (draft.entities as unknown[]).length ? { entities: draft.entities } : {}),
          link_preview_options: { is_disabled: true },
          reply_markup: {
            inline_keyboard: [[{ text: '📢 Join our channel', url: config.COMMUNITY_CHANNEL_URL }]],
          },
        } as any);

        try {
          await prisma.broadcastDelivery.create({
            data: {
              broadcastId,
              telegramId,
              chatId,
              messageId: msg.message_id,
              deleteAt: new Date(Date.now() + draft.expireMin * 60_000),
            },
          });
          await redis.set(pendingKey(telegramId), broadcastId, 'EX', draft.expireMin * 60 + 120);
        } catch (dbErr) {
          // Untracked messages can never be auto-deleted — remove it now instead.
          logger.error(`Broadcast ${broadcastId}: tracking failed for ${telegramId}: ${(dbErr as Error).message}`);
          try { await this.telegram!.deleteMessage(chatId, msg.message_id); } catch { /* ignore */ }
          return false;
        }
        return true;
      } catch (err) {
        const retryAfter = (err as any)?.response?.parameters?.retry_after as number | undefined;
        if (retryAfter && attempt === 0) {
          await sleep((retryAfter + 1) * 1000);
          continue;
        }
        logger.debug(`Broadcast ${broadcastId}: send to ${telegramId} failed: ${errDescription(err)}`);
        return false;
      }
    }
    return false;
  }

  /**
   * Called from the security middleware on EVERY update. Cheap path: one Redis
   * DEL. Only users holding an unopened broadcast reach the database.
   */
  async onUserActivity(telegramId: string): Promise<void> {
    try {
      if ((await redis.del(pendingKey(telegramId))) === 0) return;

      const rows = await prisma.broadcastDelivery.findMany({
        where: { telegramId, openedAt: null, deletedAt: null },
        select: { id: true, deleteAt: true },
      });
      if (rows.length === 0) return;

      const openedAt = new Date();
      const countdownEnd = new Date(openedAt.getTime() + DELETE_AFTER_OPEN_MIN * 60_000);
      await prisma.$transaction(
        rows.map((r) =>
          prisma.broadcastDelivery.update({
            where: { id: r.id },
            data: { openedAt, deleteAt: r.deleteAt < countdownEnd ? r.deleteAt : countdownEnd },
          })
        )
      );
    } catch (err) {
      logger.warn(`Broadcast open-tracking failed for ${telegramId}: ${(err as Error).message}`);
    }
  }

  /** Deletes every message whose time has come. */
  async sweepDue(): Promise<void> {
    if (this.sweeping || !this.telegram) return;
    this.sweeping = true;
    try {
      const due = await prisma.broadcastDelivery.findMany({
        where: { deletedAt: null, deleteAt: { lte: new Date() } },
        orderBy: { deleteAt: 'asc' },
        take: SWEEP_BATCH,
      });

      for (const d of due) {
        try {
          await this.telegram.deleteMessage(d.chatId, d.messageId);
          await prisma.broadcastDelivery.update({ where: { id: d.id }, data: { deletedAt: new Date() } });
        } catch (err) {
          const permanent = PERMANENT_DELETE_ERROR.test(errDescription(err));
          const giveUp = permanent || d.attempts + 1 >= MAX_DELETE_ATTEMPTS;
          await prisma.broadcastDelivery.update({
            where: { id: d.id },
            data: giveUp ? { deletedAt: new Date(), attempts: { increment: 1 } } : { attempts: { increment: 1 } },
          });
        }
        await sleep(35);
      }
    } catch (err) {
      logger.error(`Broadcast sweeper error: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** Admin "delete for everyone now". */
  async recall(broadcastId: string): Promise<void> {
    await prisma.broadcast.update({ where: { id: broadcastId }, data: { status: 'RECALLED' } });
    await this.scheduleAllNow(broadcastId);
    void this.sweepDue();
  }

  private async scheduleAllNow(broadcastId: string): Promise<void> {
    await prisma.broadcastDelivery.updateMany({
      where: { broadcastId, deletedAt: null },
      data: { deleteAt: new Date() },
    });
  }

  async stats(broadcastId: string) {
    const [total, opened, deleted] = await Promise.all([
      prisma.broadcastDelivery.count({ where: { broadcastId } }),
      prisma.broadcastDelivery.count({ where: { broadcastId, openedAt: { not: null } } }),
      prisma.broadcastDelivery.count({ where: { broadcastId, deletedAt: { not: null } } }),
    ]);
    return { total, opened, deleted, waiting: total - deleted };
  }
}

export const broadcastService = new BroadcastService();
  
