/**
 * `aula auth set-password` — mint the argon2id hash that guards remote MCP
 * access.
 *
 * The hash is printed, never stored: where it belongs (systemd
 * EnvironmentFile, a secrets manager, `.env`) is the operator's call, and
 * guessing wrong would scatter a credential across the filesystem. Only the
 * hash ever leaves this command — the password itself is never echoed, logged
 * or written down.
 *
 * `aula auth revoke` — invalidate every token the server has issued, so a
 * connector that is already signed in has to authenticate again. Works against
 * a running server: it rewrites the state file, and the server re-reads that
 * file per request rather than trusting what it loaded at boot.
 */

import { Buffer } from 'node:buffer';
import { FileAuthStore, revokeAuthState } from '@aula-mcp/mcp-server';
import { fail, fmt, info, ok, promptSecret, warn } from '../io.ts';

/** Short enough to type on a phone, long enough not to be brute-forced. */
const MIN_PASSWORD_LENGTH = 12;

export interface SetPasswordOptions {
  /** Read the password from stdin instead of prompting (for scripting). */
  stdin?: boolean;
}

export async function runAuthSetPassword(opts: SetPasswordOptions = {}): Promise<void> {
  const password = opts.stdin ? await readStdin() : await promptTwice();
  if (password === null) return;

  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length}).`);
    process.exit(2);
  }

  const hash = await Bun.password.hash(password, { algorithm: 'argon2id' });

  ok('Password hash generated.');
  info('Add these to the environment the MCP server runs with:\n');
  process.stdout.write(`AULA_MCP_AUTH_PASSWORD_HASH='${hash}'\n`);
  process.stdout.write(`AULA_MCP_PUBLIC_URL='https://your-host.example/aula'\n\n`);
  info(
    `${fmt.bold('AULA_MCP_PUBLIC_URL')} is the URL clients actually connect to — the public\n` +
      '  address of your reverse proxy or tunnel, including any path prefix. It\n' +
      '  becomes the OAuth issuer, so a wrong value breaks the connector.',
  );
  info('Then restart the server. Remote clients will ask for this password once.');
  info(
    'Restarting with a changed hash also drops every token issued under the old\n' +
      '  password, so previously connected clients have to sign in again.',
  );
  warn('Anyone with this password can read messages and write presence. Treat it as a key.');
}

export interface RevokeOptions {
  /** Also drop client registrations, not just issued tokens. */
  clients?: boolean;
  /** Override the state file location (matches AULA_MCP_DIR layouts). */
  file?: string | undefined;
}

/**
 * `aula auth revoke` — cut off every client that is currently signed in.
 *
 * Reach for this when access needs to end now: a shared password that spread
 * further than intended, a device that is gone, a connector that should no
 * longer be connected. Changing the password alone does not do it — tokens
 * already issued keep working until something invalidates them, which is
 * either a restart (the server notices the new password hash) or this.
 */
export async function runAuthRevoke(opts: RevokeOptions = {}): Promise<void> {
  const store = opts.file ? new FileAuthStore(opts.file) : new FileAuthStore();
  const summary = await revokeAuthState(store, { includeClients: opts.clients === true });

  if (summary.tokens_revoked === 0 && summary.clients_removed === 0) {
    ok('Nothing to revoke — no tokens were outstanding.');
  } else if (opts.clients) {
    ok(
      `Revoked ${summary.tokens_revoked} token(s) and removed ` +
        `${summary.clients_removed} client registration(s).`,
    );
  } else {
    ok(`Revoked ${summary.tokens_revoked} token(s).`);
  }

  info(`State file: ${fmt.bold(store.filePath)}`);
  info('A running server picks this up on its next request — no restart needed.');
  if (opts.clients) {
    info('Connectors must be removed and re-added in claude.ai before they can sign in.');
  } else {
    info('Connectors stay registered and can sign in again with the current password.');
    info(`Use ${fmt.bold('--clients')} to drop the registrations too.`);
  }
  warn('If the password itself leaked, run `aula auth set-password` and restart as well.');
}

async function promptTwice(): Promise<string | null> {
  const first = await promptSecret('New MCP password:');
  if (!first) {
    fail('Aborted — empty password.');
    process.exit(2);
  }
  const second = await promptSecret('Repeat password:');
  if (first !== second) {
    fail('The two entries did not match. Nothing was changed.');
    process.exit(2);
  }
  return first;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  // Strip only the trailing newline a shell adds — a password may legitimately
  // contain spaces, so nothing else is trimmed.
  return raw.replace(/\r?\n$/, '');
}
