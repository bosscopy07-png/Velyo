/**
 * Giveaway-scoped duplicate classification. Pure and exhaustively testable.
 *
 * Policy (documented so admins can reason about every flag):
 *  - CONFIRMED_DUPLICATE: the same normalized payout address is already used
 *    by a live claim in THIS giveaway. Auto-reject. Never platform-wide.
 *  - STRONG_SUSPICIOUS: several INDEPENDENT signals agree. Flag for review;
 *    the claim is NOT blocked.
 *  - WEAK_SIGNAL: a lone signal, or only network-level signals (shared IP
 *    alone, IP + velocity). Recorded only; never rejects, never accuses.
 *  - none: nothing recorded.
 */

export type SignalType =
  | 'SAME_WALLET_SAME_GIVEAWAY'
  | 'SAME_IP'
  | 'SAME_DEVICE'
  | 'RESERVATION_VELOCITY'
  | 'CROSS_ACCOUNT_WALLET_OTHER_GIVEAWAY';

export interface Signal {
  type: SignalType;
  detail?: Record<string, unknown>;
}

export type Level = 'CONFIRMED_DUPLICATE' | 'STRONG_SUSPICIOUS' | 'WEAK_SIGNAL' | 'NONE';
export type Decision = 'REJECTED' | 'FLAGGED' | 'RECORDED' | 'ALLOWED';

export interface Classification {
  level: Level;
  decision: Decision;
  reviewRequired: boolean;
}

export function classifySignals(signals: Signal[]): Classification {
  const kinds = new Set(signals.map((s) => s.type));

  if (kinds.has('SAME_WALLET_SAME_GIVEAWAY'))
    return { level: 'CONFIRMED_DUPLICATE', decision: 'REJECTED', reviewRequired: true };

  const device = kinds.has('SAME_DEVICE');
  const ip = kinds.has('SAME_IP');
  const velocity = kinds.has('RESERVATION_VELOCITY');
  const cross = kinds.has('CROSS_ACCOUNT_WALLET_OTHER_GIVEAWAY');

  const strong =
    (device && ip) ||
    (device && velocity) ||
    (cross && (device || ip)) ||
    kinds.size >= 3;

  if (strong) return { level: 'STRONG_SUSPICIOUS', decision: 'FLAGGED', reviewRequired: true };
  if (kinds.size > 0) return { level: 'WEAK_SIGNAL', decision: 'RECORDED', reviewRequired: false };
  return { level: 'NONE', decision: 'ALLOWED', reviewRequired: false };
}

export const VELOCITY_THRESHOLD = 3;
  
