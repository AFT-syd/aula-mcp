/**
 * Crypto primitives used by MitID/SRP/AES-GCM. Wraps `node:crypto`
 * (which Bun also provides) so callers don't sprinkle imports everywhere
 * and we can swap implementations if we ever need WebCrypto-only.
 */

import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  pbkdf2Sync,
} from 'node:crypto';
import { base64url } from './encoding.ts';

/** N cryptographically-random bytes. */
export function randomBytes(n: number): Buffer {
  return nodeRandomBytes(n);
}

/** N random bytes encoded as URL-safe base64 with no padding. */
export function randomBase64Url(n: number): string {
  return base64url.encode(nodeRandomBytes(n));
}

export function sha256(input: Buffer | string): Buffer {
  return createHash('sha256').update(input).digest();
}

export function hmacSha256(key: Buffer | string, data: Buffer | string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function pbkdf2Sha256(
  password: Buffer | string,
  salt: Buffer | string,
  iterations: number,
  keyLengthBytes: number,
): Buffer {
  return pbkdf2Sync(password, salt, iterations, keyLengthBytes, 'sha256');
}

export interface AesGcmCiphertext {
  ciphertext: Buffer;
  tag: Buffer;
}

/**
 * AES-GCM encrypt with 16-byte tag (matches the Python BrowserClient defaults).
 * IV length is whatever the caller passes (Python uses 12 or 16 in different spots).
 */
export function aesGcmEncrypt(
  key: Buffer,
  iv: Buffer,
  plaintext: Buffer,
  aad?: Buffer,
): AesGcmCiphertext {
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

export function aesGcmDecrypt(
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad?: Buffer,
): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
