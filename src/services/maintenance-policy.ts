/**
 * Maintenance policy — decides which non-admin updates are blocked while
 * maintenance is ON. Pure (no I/O) so it is trivially testable.
 *
 * Callbacks are DEFAULT-DENY: only the Back button passes. Any button —
 * including future ones and stale keyboards opened before maintenance began —
 * is blocked automatically.
 */

/**
 * Callback actions that stay available during maintenance.
 * ONLY the Back button (`main`) — it returns the user to the main menu.
 * Every other button (wallet, history, account, help, giveaway, ...) is
 * replaced by the maintenance screen until maintenance is switched OFF.
 */
const ALLOWED_CALLBACKS: RegExp[] = [/^main$/];

export type MaintenanceCheckInput =
  | { type: 'callback'; data: string }
  | { type: 'text'; text: string; sessionState?: string | null }
  | { type: 'other' };

export function isBlockedDuringMaintenance(input: MaintenanceCheckInput): boolean {
  switch (input.type) {
    case 'callback':
      return !ALLOWED_CALLBACKS.some((re) => re.test(input.data));

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
