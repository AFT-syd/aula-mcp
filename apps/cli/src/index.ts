#!/usr/bin/env bun
/**
 * `aula` — CLI entry point. Tiny dispatcher; each subcommand lives in its
 * own file under ./commands/.
 *
 * Usage:
 *   aula login [--username <user>] [--method APP|CODE_TOKEN] [--debug] [--transcript <file>]
 *   aula status
 *   aula logout
 *   aula whoami
 *   aula --help
 */

import { runLogin } from './commands/login.ts';
import { runLogout } from './commands/logout.ts';
import { runStatus } from './commands/status.ts';
import { runWhoami } from './commands/whoami.ts';
import { fmt } from './io.ts';

interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a == null) continue;
    if (a === '--' || a === '') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next != null && !next.startsWith('-')) {
          args.flags[a.slice(2)] = next;
          i++;
        } else {
          args.flags[a.slice(2)] = true;
        }
      }
    } else if (!args.command) {
      args.command = a;
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

const HELP = `${fmt.bold('aula')} — MCP-friendly Aula client

${fmt.bold('Usage')}:
  aula login [--username <user>] [--method APP|CODE_TOKEN] [--debug] [--transcript <file>]
  aula status
  aula whoami
  aula logout
  aula --help

${fmt.bold('Notes')}:
  • Tokens are stored AES-256-GCM-encrypted at ~/.config/aula-mcp/tokens.json.
  • Set AULA_MCP_KEY (hex or passphrase) for stronger key handling than the
    auto-generated key file.
  • --debug captures a sanitised wire transcript to JSONL — safe to share
    when reporting issues.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args.command ?? (args.flags.help || args.flags.h ? 'help' : 'help');

  switch (cmd) {
    case 'login': {
      const username = typeof args.flags.username === 'string' ? args.flags.username : undefined;
      const methodRaw = args.flags.method;
      const method = methodRaw === 'CODE_TOKEN' || methodRaw === 'APP' ? methodRaw : undefined;
      const debug = args.flags.debug === true;
      const transcript =
        typeof args.flags.transcript === 'string' ? args.flags.transcript : undefined;
      await runLogin({
        ...(username ? { username } : {}),
        ...(method ? { method } : {}),
        ...(debug ? { debug: true } : {}),
        ...(transcript ? { transcript } : {}),
      });
      break;
    }
    case 'status':
      await runStatus();
      break;
    case 'logout':
      await runLogout();
      break;
    case 'whoami':
      await runWhoami();
      break;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

await main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
