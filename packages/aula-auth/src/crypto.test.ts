import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hmacSha256,
  pbkdf2Sha256,
  randomBase64Url,
  randomBytes,
  sha256,
} from './crypto.ts';
import { bytesToHex } from './encoding.ts';

describe('sha256', () => {
  // FIPS 180-2 test vector
  test('SHA-256("abc")', () => {
    expect(bytesToHex(sha256('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('SHA-256(empty)', () => {
    expect(bytesToHex(sha256(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('hmacSha256', () => {
  // RFC 4231 test case 1
  test('Key=0x0b×20, Data="Hi There"', () => {
    const key = Buffer.alloc(20, 0x0b);
    expect(bytesToHex(hmacSha256(key, 'Hi There'))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });
});

describe('pbkdf2Sha256', () => {
  // Self-consistency / regression vector — locks our wrapper to a known output
  // so refactors don't silently change the param order or hash.
  test('PBKDF2-SHA256("password", "salt", 1, 32)', () => {
    expect(bytesToHex(pbkdf2Sha256('password', 'salt', 1, 32))).toBe(
      '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
    );
  });

  test('matches Aula MitID PASSWORD flow defaults (20000 iters, 32-byte key)', () => {
    // Regression-locks the parameters used by mitid_browserclient's password path:
    //   pbkdf2_hmac("sha256", password, salt, 20000, 32).hex()
    // Recompute via:
    //   node -e "console.log(require('crypto').pbkdf2Sync('hunter2', Buffer.from('cafebabe','hex'), 20000, 32, 'sha256').toString('hex'))"
    const out = pbkdf2Sha256('hunter2', Buffer.from('cafebabe', 'hex'), 20000, 32);
    expect(out.length).toBe(32);
    expect(bytesToHex(out)).toBe(
      '74b62387fcbe6647776e85fc15b3df1042aa30101ae147defcc8b64fe43cfd4d',
    );
  });
});

describe('aes-256-gcm', () => {
  test('encrypt → decrypt roundtrip', () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const plaintext = Buffer.from('hello mitid', 'utf8');
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, plaintext);
    expect(aesGcmDecrypt(key, iv, ciphertext, tag).equals(plaintext)).toBe(true);
  });

  test('decrypt fails when tag is tampered', () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, Buffer.from('secret'));
    const firstByte = tag[0] ?? 0;
    tag[0] = (firstByte ^ 0x01) & 0xff;
    expect(() => aesGcmDecrypt(key, iv, ciphertext, tag)).toThrow();
  });

  test('respects optional AAD', () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const aad = Buffer.from('aula');
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, Buffer.from('payload'), aad);
    expect(aesGcmDecrypt(key, iv, ciphertext, tag, aad).toString('utf8')).toBe('payload');
    expect(() => aesGcmDecrypt(key, iv, ciphertext, tag, Buffer.from('wrong'))).toThrow();
  });
});

describe('random helpers', () => {
  test('randomBytes returns the requested length', () => {
    expect(randomBytes(16).length).toBe(16);
    expect(randomBytes(64).length).toBe(64);
  });

  test('randomBase64Url is URL-safe and has no padding', () => {
    const s = randomBase64Url(32);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBe(43);
  });
});
