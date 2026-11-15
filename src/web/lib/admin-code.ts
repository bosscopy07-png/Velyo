/** Pure parser for the admin "Create Code" input: CODE|ASSET|AMOUNT|MAX_REDEMPTIONS|EXPIRY_DAYS */
export type ParsedAdminCode =
  | { ok: true; code: string; asset: 'BNB' | 'USDT'; amount: number; maxRedemptions: number; expiryDays: number }
  | { ok: false; error: string };

export function parseAdminCodeInput(text: string): ParsedAdminCode {
  const parts = text.trim().split('|').map((p) => p.trim());
  if (parts.length < 3 || parts.length > 5) return { ok: false, error: 'Use: CODE|ASSET|AMOUNT|MAX_REDEMPTIONS|EXPIRY_DAYS' };
  const [rawCode, rawAsset, rawAmount, rawMax = '1', rawDays = '30'] = parts;
  const code = rawCode.toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return { ok: false, error: 'Code must be 3–32 letters/numbers.' };
  const asset = rawAsset.toUpperCase();
  if (asset !== 'BNB' && asset !== 'USDT') return { ok: false, error: 'Asset must be BNB or USDT.' };
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Amount must be greater than 0.' };
  if (!/^\d+$/.test(rawMax) || +rawMax < 1 || +rawMax > 1_000_000) return { ok: false, error: 'Max redemptions must be a whole number ≥ 1.' };
  if (!/^\d+$/.test(rawDays) || +rawDays < 1 || +rawDays > 3650) return { ok: false, error: 'Expiry days must be a whole number ≥ 1.' };
  return { ok: true, code, asset, amount, maxRedemptions: +rawMax, expiryDays: +rawDays };
}
