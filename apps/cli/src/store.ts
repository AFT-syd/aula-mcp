/**
 * CLI-side wrapper that gives every command the same TokenStore + transcript
 * directory layout. `~/.config/aula-mcp/` for the file backend's tokens +
 * key + JSONL transcripts; macOS Keychain when available.
 *
 * Backend selection (in order):
 *   1. AULA_MCP_NO_KEYCHAIN=1 → file backend regardless of platform.
 *   2. macOS + `security` available → KeychainTokenStore.
 *   3. Everything else → EncryptedFileTokenStore at AULA_MCP_DIR.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { EncryptedFileTokenStore, KeychainTokenStore, type TokenStore } from '@aula-mcp/aula-auth';

export const AULA_MCP_DIR = process.env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
export const TOKEN_FILE = join(AULA_MCP_DIR, 'tokens.json');
export const KEY_FILE = join(AULA_MCP_DIR, '.key');
export const TRANSCRIPT_DIR = join(AULA_MCP_DIR, 'transcripts');
export const LOGIN_LOG_PATH = join(AULA_MCP_DIR, 'login-log.jsonl');

/** Display path that survives both backends — KeychainTokenStore.path
 *  returns "keychain://aula-mcp/tokens" so commands that print location
 *  can do so uniformly. */
export interface CliTokenStore extends TokenStore {
  readonly path: string;
}

export function defaultStore(): CliTokenStore {
  if (KeychainTokenStore.isSupported() && process.env.AULA_MCP_NO_KEYCHAIN !== '1') {
    return new KeychainTokenStore();
  }
  return new EncryptedFileTokenStore({
    filePath: TOKEN_FILE,
    keyFilePath: KEY_FILE,
  });
}

export function transcriptPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return join(TRANSCRIPT_DIR, `login-${stamp}.jsonl`);
}
