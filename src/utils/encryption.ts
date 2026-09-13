import crypto from 'crypto';
import { config } from '../config';

/**
 * AES-256-GCM encryption for sensitive wallet data (private keys, mnemonics).
 *
 * Wire format: v1:<iv>:<authTag>:<ciphertext>   (all base64)
 * NOTE: values written between 2026-09-11 and this fix have a double colon
 * ("v1::<iv>...") due to a join() bug — decrypt() accepts BOTH formats, so
 * existing data needs no migration.
 *
 * Legacy compatibility: ciphertext produced by the old CryptoJS
 * AES.encrypt(text, key) (CBC, "Salted__..." wire format) is still decryptable
 * via the fallback path.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM
const PREFIX = 'v1';

// Derive a stable 32-byte key from the configured secret. scrypt is used for
// key derivation; the salt is not secret (only the passphrase is).
const derivedKey: Buffer = crypto.scryptSync(
  config.WALLET_ENCRYPTION_KEY,
  'velyo-wallet-encryption',
  32
);

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // iv and tag are safe to store alongside the ciphertext (GCM design).
  return [PREFIX, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  if (payload.startsWith(`${PREFIX}:`)) {
    // Accept BOTH "v1:iv:tag:ct" and the buggy "v1::iv:tag:ct" (empty segment
    // from the old double-colon join). Base64 segments are never empty, so
    // filtering empties is safe.
    const parts = payload.split(':').filter((p) => p.length > 0);
    if (parts.length !== 4) {
      throw new Error('Malformed ciphertext payload');
    }
    const [, ivB64, tagB64, dataB64] = parts;

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      derivedKey,
      Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  // Legacy fallback: CryptoJS AES (CBC/Pkcs7, "Salted__" format). Kept so that
  // any data encrypted before the GCM migration remains recoverable.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const CryptoJS = require('crypto-js') as typeof import('crypto-js');
  const bytes = CryptoJS.AES.decrypt(payload, config.WALLET_ENCRYPTION_KEY);
  const plaintext = bytes.toString(CryptoJS.enc.Utf8);
  if (!plaintext) {
    throw new Error('Failed to decrypt payload (bad key or corrupted data)');
  }
  return plaintext;
}

/**
 * Deterministic idempotency key. The output is identical to the previous
 * CryptoJS-based implementation (SHA-256, hex encoded), so existing
 * Transaction.idempotencyKey values stay stable.
 */
export function hashIdempotencyKey(...parts: string[]): string {
  return crypto
    .createHash('sha256')
    .update(parts.join('|') + config.WALLET_ENCRYPTION_KEY)
    .digest('hex');
}
