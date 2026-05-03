/**
 * CLI-side wrapper that gives every command the same TokenStore + transcript
 * directory layout. `~/.config/aula-mcp/` for tokens + key + JSONL transcripts.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { EncryptedFileTokenStore } from '@aula-mcp/aula-auth';

export const AULA_MCP_DIR = process.env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
export const TOKEN_FILE = join(AULA_MCP_DIR, 'tokens.json');
export const KEY_FILE = join(AULA_MCP_DIR, '.key');
export const TRANSCRIPT_DIR = join(AULA_MCP_DIR, 'transcripts');

export function defaultStore(): EncryptedFileTokenStore {
  return new EncryptedFileTokenStore({
    filePath: TOKEN_FILE,
    keyFilePath: KEY_FILE,
  });
}

export function transcriptPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return join(TRANSCRIPT_DIR, `login-${stamp}.jsonl`);
}
