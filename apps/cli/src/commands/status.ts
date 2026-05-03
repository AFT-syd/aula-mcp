/**
 * `aula status` — print whether tokens exist, who they're for, and when
 * they expire. Doesn't hit the network.
 */

import { fmt, info, ok, warn } from '../io.ts';
import { defaultStore } from '../store.ts';

export async function runStatus(): Promise<void> {
  const store = defaultStore();
  const record = await store.load();
  if (!record) {
    warn(`No tokens saved. Run ${fmt.bold('aula login')} to authenticate.`);
    process.exit(1);
  }
  const now = Math.floor(Date.now() / 1000);
  const remainingSec = record.tokens.expires_at - now;
  const expired = remainingSec <= 0;
  const remainingMin = Math.floor(Math.abs(remainingSec) / 60);
  const remainingDesc = expired
    ? `expired ${remainingMin} min ago — refresh on next API call`
    : `expires in ${remainingMin} min`;

  ok(
    `Tokens for ${fmt.bold(record.username)}${record.identityName ? ` (${record.identityName})` : ''}`,
  );
  info(`File: ${fmt.dim(store.path)}`);
  info(`Saved: ${new Date(record.saved_at * 1_000).toISOString()}`);
  info(`Access token: ${expired ? fmt.yellow(remainingDesc) : fmt.green(remainingDesc)}`);
  if (record.identityIndex) info(`Identity index: ${record.identityIndex}`);
}
