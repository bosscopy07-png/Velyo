/** Cheap shape check for an EVM (BEP20) address. Checksum validation happens server-side with ethers. */
export const looksLikeEvmAddress = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s.trim());
