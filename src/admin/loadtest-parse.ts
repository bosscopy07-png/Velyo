/** Pure parser for the traffic-test input: a giveaway link plus an optional visitor count. */
const DEFAULT_USERS = 50;
const MAX_USERS = 2000;

export function parseTestInput(text: string): { slug: string; users: number } | null {
  const m = text.match(/\/g\/([a-z0-9]{6,32})/i);
  if (!m) return null;
  const n = text.match(/\s(\d{1,7})\s*$/);
  const users = Math.min(MAX_USERS, Math.max(10, n ? Number(n[1]) : DEFAULT_USERS));
  return { slug: m[1].toLowerCase(), users };
}
