/**
 * Encoding helpers used across the auth flow.
 *
 * All functions return Buffers for binary data. Callers convert to string
 * shape (hex, base64url) at the boundary where the wire protocol cares.
 */

import { Buffer } from 'node:buffer';

export const base64url = {
  /** Encode bytes (or utf-8 string) as URL-safe base64 with no padding. */
  encode(input: Buffer | string): string {
    const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  },

  /** Decode a URL-safe (or standard) base64 string back to bytes. */
  decode(input: string): Buffer {
    const padded = input.replaceAll('-', '+').replaceAll('_', '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    return Buffer.from(padded + '='.repeat(padLen), 'base64');
  },
};

/** Lowercase hex string from bytes. */
export function bytesToHex(buf: Buffer): string {
  return buf.toString('hex');
}

/** Bytes from a hex string (case-insensitive, no `0x` prefix). */
export function hexToBytes(hex: string): Buffer {
  if (hex.length % 2 !== 0) throw new Error(`Invalid hex string length: ${hex.length}`);
  return Buffer.from(hex, 'hex');
}

/**
 * Big-endian unsigned integer → fixed-length byte buffer.
 * Throws if `value` doesn't fit in `length` bytes.
 */
export function bigIntToBytesBE(value: bigint, length: number): Buffer {
  if (value < 0n) throw new Error('bigIntToBytesBE: value must be non-negative');
  const buf = Buffer.alloc(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`bigIntToBytesBE: value does not fit in ${length} bytes`);
  return buf;
}

/** Big-endian unsigned bytes → bigint. */
export function bytesToBigIntBE(buf: Buffer): bigint {
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}

/**
 * Big-endian unsigned integer → minimal-length hex string.
 * Pads to even length; matches Python's `hex()` after stripping the `0x`.
 */
export function bigIntToHex(value: bigint): string {
  if (value < 0n) throw new Error('bigIntToHex: value must be non-negative');
  const hex = value.toString(16);
  return hex.length % 2 === 0 ? hex : `0${hex}`;
}

/** Hex string → bigint. */
export function hexToBigInt(hex: string): bigint {
  if (hex.length === 0) return 0n;
  return BigInt(`0x${hex}`);
}
