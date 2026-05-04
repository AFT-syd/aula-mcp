/**
 * `aula status` — print whether tokens exist, who they're for, and when
 * they expire. Doesn't hit the network.
 *
 * `--json` switches to a machine-readable shape for scripts.
 */

import { fmt, info, ok, printJson, warn } from '../io.ts';
import { defaultStore } from '../store.ts';

export interface StatusCommandArgs {
  json?: boolean;
}

export async function runStatus(args: StatusCommandArgs = {}): Promise<void> {
  const store = defaultStore();
  const record = await store.load();
  if (!record) {
    if (args.json) {
      printJson({ ok: false, error: 'no_tokens' });
      process.exit(1);
    }
    warn(`No tokens saved. Run ${fmt.bold('aula login')} to authenticate.`);
    process.exit(1);
  }
  const now = Math.floor(Date.now() / 1000);
  const remainingSec = record.tokens.expires_at - now;
  const expired = remainingSec <= 0;

  if (args.json) {
    printJson({
      ok: true,
      username: record.username,
      identityIndex: record.identityIndex ?? null,
      identityName: record.identityName ?? null,
      file: store.path,
      saved_at: record.saved_at,
      access_token: {
        expires_at: record.tokens.expires_at,
        seconds_remaining: remainingSec,
        expired,
      },
    });
    return;
  }

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
