import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from './crypto.ts';
import {
  EncryptedFileTokenStore,
  MemoryTokenStore,
  type StoredTokenRecord,
  TokenStoreError,
} from './token-store.ts';

const SAMPLE: StoredTokenRecord = {
  version: 1,
  username: 'cj',
  tokens: {
    access_token: 'ACCESS',
    refresh_token: 'REFRESH',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: 1_700_000_000,
    obtained_at: 1_699_996_400,
  },
  identityIndex: 1,
  identityName: 'Test Identity',
  saved_at: 1_699_996_400,
};

describe('MemoryTokenStore', () => {
  test('roundtrip: save → load → clear', async () => {
    const store = new MemoryTokenStore();
    expect(await store.load()).toBeNull();
    await store.save(SAMPLE);
    expect(await store.load()).toEqual(SAMPLE);
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

describe('EncryptedFileTokenStore', () => {
  let dir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aula-mcp-'));
    originalEnv = process.env.AULA_MCP_KEY;
    delete process.env.AULA_MCP_KEY;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (originalEnv !== undefined) process.env.AULA_MCP_KEY = originalEnv;
    else delete process.env.AULA_MCP_KEY;
  });

  test('roundtrip with explicit key', async () => {
    const key = randomBytes(32);
    const store = new EncryptedFileTokenStore({
      filePath: join(dir, 'tokens.json'),
      key,
    });
    await store.save(SAMPLE);
    const loaded = await store.load();
    expect(loaded).toEqual(SAMPLE);
  });

  test('roundtrip with env-var key (hex)', async () => {
    const key = randomBytes(32).toString('hex');
    process.env.AULA_MCP_KEY = key;
    const store = new EncryptedFileTokenStore({
      filePath: join(dir, 'tokens.json'),
    });
    await store.save(SAMPLE);
    const loaded = await store.load();
    expect(loaded?.tokens.access_token).toBe('ACCESS');
  });

  test('falls back to generating a key file on first use', async () => {
    const keyPath = join(dir, '.key');
    const store = new EncryptedFileTokenStore({
      filePath: join(dir, 'tokens.json'),
      keyFilePath: keyPath,
    });
    await store.save(SAMPLE);
    const loaded = await store.load();
    expect(loaded).toEqual(SAMPLE);
    // Reading the same store again should reuse the key file.
    const store2 = new EncryptedFileTokenStore({
      filePath: join(dir, 'tokens.json'),
      keyFilePath: keyPath,
    });
    expect(await store2.load()).toEqual(SAMPLE);
  });

  test('load returns null when file does not exist', async () => {
    const store = new EncryptedFileTokenStore({
      filePath: join(dir, 'missing.json'),
      key: randomBytes(32),
    });
    expect(await store.load()).toBeNull();
  });

  test('throws on wrong key', async () => {
    const path = join(dir, 'tokens.json');
    const store1 = new EncryptedFileTokenStore({ filePath: path, key: randomBytes(32) });
    await store1.save(SAMPLE);
    const store2 = new EncryptedFileTokenStore({ filePath: path, key: randomBytes(32) });
    expect(store2.load()).rejects.toThrow(TokenStoreError);
  });

  test('throws when explicit key has the wrong length', async () => {
    const store = new EncryptedFileTokenStore({
      filePath: join(dir, 'tokens.json'),
      key: Buffer.alloc(16),
    });
    expect(store.save(SAMPLE)).rejects.toThrow(TokenStoreError);
  });
});
