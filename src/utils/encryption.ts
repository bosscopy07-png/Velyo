import CryptoJS from 'crypto-js';
import { config } from '../config';

const ENCRYPTION_KEY = config.WALLET_ENCRYPTION_KEY;

export function encrypt(text: string): string {
  return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY, {
    mode: CryptoJS.mode.GCM,
    padding: CryptoJS.pad.Pkcs7,
  }).toString();
}

export function decrypt(encryptedText: string): string {
  const bytes = CryptoJS.AES.decrypt(encryptedText, ENCRYPTION_KEY, {
    mode: CryptoJS.mode.GCM,
    padding: CryptoJS.pad.Pkcs7,
  });
  return bytes.toString(CryptoJS.enc.Utf8);
}

export function hashIdempotencyKey(...parts: string[]): string {
  return CryptoJS.SHA256(parts.join('|') + ENCRYPTION_KEY).toString();
}
