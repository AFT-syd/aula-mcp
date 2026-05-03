import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import {
  base64url,
  bigIntToBytesBE,
  bigIntToHex,
  bytesToBigIntBE,
  bytesToHex,
  hexToBigInt,
  hexToBytes,
} from './encoding.ts';

describe('base64url', () => {
  test('encodes "Man" → "TWFu" (RFC 4648 §10)', () => {
    expect(base64url.encode('Man')).toBe('TWFu');
  });

  test('uses - and _ instead of + and /', () => {
    // bytes 0x03 0xec 0xff 0xe0 0xc1 → standard base64 "A+z/4ME=" → url-safe "A-z_4ME"
    const buf = Buffer.from([0x03, 0xec, 0xff, 0xe0, 0xc1]);
    expect(base64url.encode(buf)).toBe('A-z_4ME');
  });

  test('strips padding on encode and tolerates it on decode', () => {
    expect(base64url.encode('any carnal pleasure.')).toBe('YW55IGNhcm5hbCBwbGVhc3VyZS4');
    expect(base64url.decode('YW55IGNhcm5hbCBwbGVhc3VyZS4').toString('utf8')).toBe(
      'any carnal pleasure.',
    );
    expect(base64url.decode('YW55IGNhcm5hbCBwbGVhc3VyZS4=').toString('utf8')).toBe(
      'any carnal pleasure.',
    );
  });

  test('roundtrips arbitrary binary', () => {
    const original = Buffer.from([0, 1, 2, 254, 255, 128, 64, 32]);
    expect(base64url.decode(base64url.encode(original)).equals(original)).toBe(true);
  });
});

describe('hex helpers', () => {
  test('roundtrips bytes ↔ hex', () => {
    const original = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    expect(bytesToHex(original)).toBe('deadbeef');
    expect(hexToBytes('deadbeef').equals(original)).toBe(true);
  });

  test('hexToBytes throws on odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow();
  });
});

describe('bigInt helpers', () => {
  test('bigIntToBytesBE pads to fixed length', () => {
    expect(bigIntToBytesBE(0x1234n, 4)).toEqual(Buffer.from([0x00, 0x00, 0x12, 0x34]));
  });

  test('bigIntToBytesBE throws when value overflows', () => {
    expect(() => bigIntToBytesBE(0x100n, 1)).toThrow();
  });

  test('bytesToBigIntBE inverts bigIntToBytesBE', () => {
    const original = (1n << 200n) + 12345n;
    const bytes = bigIntToBytesBE(original, 32);
    expect(bytesToBigIntBE(bytes)).toBe(original);
  });

  test('bigIntToHex pads to even length', () => {
    expect(bigIntToHex(0xabcn)).toBe('0abc');
    expect(bigIntToHex(0xabcdn)).toBe('abcd');
    expect(bigIntToHex(0n)).toBe('00');
  });

  test('hexToBigInt inverts bigIntToHex for non-zero values', () => {
    const n = 0xdeadbeefcafebabe1234567890n;
    expect(hexToBigInt(bigIntToHex(n))).toBe(n);
  });
});
