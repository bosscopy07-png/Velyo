/** Pure mapping from the bot's claim status to what the website shows after redemption. */
export type Progress = 'AWAITING_ADDRESS' | 'PROCESSING' | 'PAID' | 'FAILED';

export function claimProgress(status: string | null | undefined): Progress {
  switch (status) {
    case 'PAID': return 'PAID';
    case 'ADDRESS_CONFIRMED': case 'QUEUED': case 'PROCESSING': return 'PROCESSING';
    case 'FAILED': case 'REJECTED': return 'FAILED';
    default: return 'AWAITING_ADDRESS'; // no claim yet, OPENED, ATTEMPTED, RESERVED, ADDRESS_PENDING
  }
}

export const isTxHash = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
