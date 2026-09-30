/**
 * Maintenance policy — decides which non-admin updates are blocked while
 * maintenance is ON. Pure (no I/O) so it is trivially testable.
 *
 * Callbacks are DEFAULT-DENY: only an explicit read-only allow-list passes.
 * That way any future money-moving button is protected automatically, and
 * stale inline keyboards (opened before maintenance began) are blocked too.
 */

/** Read-only callback actions that stay available during maintenance. */
const READ_ONLY_CALLBACKS: RegExp[] = [
  /^main$/,
  /^wallet$/,
  /^wallet:refresh$/,
  /^wallet:copy:(BNB|USDT)$/,
  /^wallet:check:(BNB|USDT)$/,
  /^wallet:history$/,
  /^history$/,
  /^account$/,
  /^help$/,
  /^giveaway$/, // menu only — every creation step behind it is blocked
  /^giveaway:mine$/,
  /^giveaway:stats:.+$/,
  /^giveaway:copy:.+$/,
  /^payout:cancel:.+$/, // only clears the user's own pending session
];

export type MaintenanceCheckInput =
  | { type: 'callback'; data: string }
  | { type: 'text'; text: string; sessionState?: string | null }
  | { type: 'other' };

export function isBlockedDuringMaintenance(input: MaintenanceCheckInput): boolean {
  switch (input.type) {
    case 'callback':
      return !READ_ONLY_CALLBACKS.some((re) => re.test(input.data));

    case 'text': {
      const text = input.text.trim();

      // /start — plain start is harmless; a giveaway deep link is a claim.
      if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
        return /^\/start(?:@\w+)?\s+giveaway_/i.test(text);
      }
      // /claim CODE is a claim.
      if (/^\/claim(?:@\w+)?(?:\s|$)/i.test(text)) return true;

      // Anything else is free text. It only does something if the user is
      // mid-flow (giveaway wizard, redeem code, payout address...) — and every
      // such flow is state-changing, so block it whenever a session exists.
      // (Unknown /commands fall through to the text handler too, so they are
      // treated the same way.)
      return !!input.sessionState;
    }

    default:
      return false;
  }
}

/**
 * When a text step is blocked: wizards that have not touched money yet are
 * safe to close; a reserved giveaway claim waiting for an address is kept
 * (paused) so the user isn't forced to lose their spot because of maintenance.
 */
export function shouldClearSessionOnBlock(state: string | null | undefined): boolean {
  if (!state) return false;
  return state.startsWith('giveaway_') || state === 'redeem_code';
}
