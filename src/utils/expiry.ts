/**
 * Expiry hours arrive as TEXT inside Telegram callback data ("0" = no expiry).
 * "0" is a truthy string in JS, so `hours ? new Date(...) : undefined` created
 * giveaways that expired the instant they were made. Only a positive whole
 * number of hours produces an expiry date; everything else means "no expiry".
 */
export function expiresAtFromHours(raw: string | number | null | undefined, now: number = Date.now()): Date | undefined {
  const hours = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw ?? '').trim()) ? parseInt(String(raw).trim(), 10) : 0;
  return hours > 0 && hours <= 24 * 365 ? new Date(now + hours * 3600000) : undefined;
}
