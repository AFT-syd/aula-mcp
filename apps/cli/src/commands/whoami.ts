/**
 * `aula whoami` — smoke test that loads stored tokens, refreshes if needed,
 * and calls `profiles.getProfilesByLogin`. Prints the user + their kids.
 *
 * This is the fastest "did the login actually work?" verification.
 */

import { AulaHttpClient, withFreshTokens } from '@aula-mcp/aula-auth';
import { AulaClient } from '@aula-mcp/aula-client';
import { fail, fmt, info, ok } from '../io.ts';
import { defaultStore } from '../store.ts';

export async function runWhoami(): Promise<void> {
  const store = defaultStore();
  const http = new AulaHttpClient();
  let record: Awaited<ReturnType<typeof withFreshTokens>>;
  try {
    record = await withFreshTokens({ store, http });
  } catch (e) {
    fail(`Could not load tokens: ${(e as Error).message}`);
    process.exit(1);
  }

  const client = new AulaClient({ tokens: record.tokens, http });
  try {
    const data = await client.getProfilesByLogin();
    ok(`Logged in as ${fmt.bold(record.username)} — Aula API v${client.currentApiVersion}`);
    for (const profile of data.profiles ?? []) {
      info(`Profile: ${fmt.bold(profile.name)} (id ${profile.id})`);
      for (const child of profile.children ?? []) {
        const inst = child.institutionProfile?.institutionName ?? '?';
        info(`  Child: ${child.name} (id ${child.id}) at ${inst}`);
      }
    }
  } catch (e) {
    fail(`API call failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
