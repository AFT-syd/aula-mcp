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
  pkcs7Pad,
  pkcs7Unpad,
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

describe('pkcs7Pad / pkcs7Unpad', () => {
  test('appends one full block when data is already block-aligned', () => {
    const data = Buffer.alloc(16, 0xaa); // exactly one block
    const padded = pkcs7Pad(data, 16);
    expect(padded.length).toBe(32);
    expect(padded.subarray(16).every((b) => b === 16)).toBe(true);
  });

  test('pads to next multiple of block size', () => {
    const data = Buffer.from('hello'); // 5 bytes → pad 11 of 0x0b
    const padded = pkcs7Pad(data, 16);
    expect(padded.length).toBe(16);
    expect(padded[5]).toBe(11);
    expect(padded[15]).toBe(11);
  });

  test('roundtrip: pad → unpad returns the original', () => {
    for (const len of [0, 1, 5, 15, 16, 17, 31, 32, 100]) {
      const data = Buffer.alloc(len, 0x42);
      const padded = pkcs7Pad(data, 16);
      const unpadded = pkcs7Unpad(padded, 16);
      expect(unpadded.equals(data)).toBe(true);
    }
  });

  test('respects custom block sizes', () => {
    expect(pkcs7Pad(Buffer.from('ab'), 8).length).toBe(8);
    expect(pkcs7Pad(Buffer.from('abcdefgh'), 8).length).toBe(16); // already aligned → +1 block
  });

  test('rejects bogus block sizes', () => {
    expect(() => pkcs7Pad(Buffer.from('x'), 0)).toThrow();
    expect(() => pkcs7Pad(Buffer.from('x'), 256)).toThrow();
  });

  test('pkcs7Unpad rejects mis-padded data', () => {
    const bad = Buffer.from([1, 2, 3, 4, 5]); // not a multiple of 16
    expect(() => pkcs7Unpad(bad, 16)).toThrow();
    const wrong = Buffer.alloc(16, 0xff); // pad-byte 0xff but earlier bytes don't match
    expect(() => pkcs7Unpad(wrong, 16)).toThrow();
  });
});
