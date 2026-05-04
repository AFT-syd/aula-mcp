/**
 * Minimal example: load tokens, build an AulaClient, list profiles + children.
 *
 * Uses the libraries directly — no CLI, no MCP server. Run after `aula login`:
 *
 *   bun examples/script/fetch-profiles.ts
 */

import { AulaHttpClient, EncryptedFileTokenStore, withFreshTokens } from '@aula-mcp/aula-auth';
import { AulaClient } from '@aula-mcp/aula-client';

const store = new EncryptedFileTokenStore();
const http = new AulaHttpClient();

const record = await withFreshTokens({ store, http });
const client = new AulaClient({ tokens: record.tokens, http });

const data = await client.getProfilesByLogin();

console.log(`Logged in as ${record.username} (Aula API v${client.currentApiVersion})`);
for (const profile of data.profiles ?? []) {
  console.log(`- ${profile.name}`);
  for (const child of profile.children ?? []) {
    const inst = child.institutionProfile?.institutionName ?? '?';
    console.log(`  · ${child.name} at ${inst}`);
  }
}
