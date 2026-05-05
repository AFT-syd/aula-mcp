/**
 * Round-trip test for `aula tokens export` / `import`. We run the export
 * against a file-backed source store, then import it elsewhere and check
 * the round-tripped record matches byte-for-byte.
 *
 * The CLI helpers use `defaultStore()` under the hood, which selects
 * Keychain on macOS. To keep the test hermetic + cross-platform we set
 * `AULA_MCP_NO_KEYCHAIN=1` before importing the helpers — that forces
 * the file backend on every platform.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedFileTokenStore, type StoredTokenRecord } from '@aula-mcp/aula-auth';

let runTokensExport: typeof import('./tokens.ts')['runTokensExport'];
let runTokensImport: typeof import('./tokens.ts')['runTokensImport'];

beforeAll(async () => {
  process.env.AULA_MCP_NO_KEYCHAIN = '1';
  const mod = await import('./tokens.ts');
  runTokensExport = mod.runTokensExport;
  runTokensImport = mod.runTokensImport;
});

const FAKE_RECORD: StoredTokenRecord = {
  version: 1,
  username: 'demo',
  identityName: 'Demo User',
  saved_at: 1_700_000_000,
  tokens: {
    access_token: 'AT-1',
    refresh_token: 'RT-1',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: 1_700_003_600,
    obtained_at: 1_700_000_000,
  },
};

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'aula-tokens-test-'));
  // Point the local store at a per-test dir so we don't touch ~/.config.
  process.env.AULA_MCP_DIR = join(workDir, 'local');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('tokens export → import round-trip', () => {
  test('produces a self-contained bundle that imports cleanly', async () => {
    // 1. Seed the local store with a record.
    const localStore = new EncryptedFileTokenStore({
      filePath: join(workDir, 'local', 'tokens.json'),
      keyFilePath: join(workDir, 'local', '.key'),
    });
    await localStore.save(FAKE_RECORD);

    // 2. Export to a bundle dir.
    const bundleDir = join(workDir, 'bundle');
    await runTokensExport({ outDir: bundleDir });

    // Both bundle files exist + key is 32 bytes (256-bit AES key, hex-encoded).
    const bundleKey = await readFile(join(bundleDir, '.key'), 'utf8');
    expect(bundleKey.length).toBe(64); // 32 bytes hex-encoded
    const bundleTokens = await readFile(join(bundleDir, 'tokens.json'), 'utf8');
    expect(bundleTokens.length).toBeGreaterThan(0);

    // 3. Move to a "remote" dir (swap AULA_MCP_DIR) and import.
    process.env.AULA_MCP_DIR = join(workDir, 'remote');
    await runTokensImport({ inDir: bundleDir });

    // 4. The remote store now has the same record.
    const remoteStore = new EncryptedFileTokenStore({
      filePath: join(workDir, 'remote', 'tokens.json'),
      keyFilePath: join(workDir, 'remote', '.key'),
    });
    const remoteRecord = await remoteStore.load();
    expect(remoteRecord).toEqual(FAKE_RECORD);
  });

  test('export uses a fresh key, not the local store key', async () => {
    const localStore = new EncryptedFileTokenStore({
      filePath: join(workDir, 'local', 'tokens.json'),
      keyFilePath: join(workDir, 'local', '.key'),
    });
    await localStore.save(FAKE_RECORD);
    const localKey = await readFile(join(workDir, 'local', '.key'), 'utf8');

    await runTokensExport({ outDir: join(workDir, 'bundle') });
    const bundleKey = await readFile(join(workDir, 'bundle', '.key'), 'utf8');

    // Different keys — important so deleting the bundle never affects the
    // original install, and so a leaked bundle can't be used to decrypt
    // anything else encrypted with the local key.
    expect(bundleKey).not.toBe(localKey);
  });
});
