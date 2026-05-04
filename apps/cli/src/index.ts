#!/usr/bin/env bun
/**
 * `aula` — CLI entry point. Tiny dispatcher; each subcommand lives in its
 * own file under ./commands/.
 *
 * Usage:
 *   aula login [--username <user>] [--method APP|CODE_TOKEN] [--debug] [--transcript <file>]
 *   aula status [--json]
 *   aula whoami [--json]
 *   aula doctor [--json] [--verbose]
 *   aula transcript view <file> [--json]
 *   aula transcript list [--json]
 *   aula transcript prune [--keep N] [--dry-run]
 *   aula logout
 *   aula --help
 */

import { runDoctor } from './commands/doctor.ts';
import { runLog } from './commands/log.ts';
import { runLogin } from './commands/login.ts';
import { runLogout } from './commands/logout.ts';
import { runStatus } from './commands/status.ts';
import { runTranscriptList, runTranscriptPrune, runTranscriptView } from './commands/transcript.ts';
import { runWhoami } from './commands/whoami.ts';
import { fmt } from './io.ts';
import { parseArgs } from './parse-args.ts';

const HELP = `${fmt.bold('aula')} — MCP-friendly Aula client

${fmt.bold('Usage')}:
  aula login [--username <user>] [--method APP|CODE_TOKEN] [--debug]
             [--transcript <file>] [--legacy-app-flow]
  aula status [--json]
  aula whoami [--json]
  aula doctor [--json] [--verbose]
  aula log [--last N] [--json]
  aula transcript list [--json]
  aula transcript view <file> [--json]
  aula transcript prune [--keep N] [--dry-run]
  aula logout
  aula --help

${fmt.bold('Notes')}:
  • On macOS, tokens are stored in the system Keychain by default
    (set AULA_MCP_NO_KEYCHAIN=1 to fall back to the encrypted file at
    ~/.config/aula-mcp/tokens.json). On other platforms only the file
    backend is available.
  • Set AULA_MCP_KEY (hex or passphrase) for stronger file-backend key
    handling than the auto-generated .key file.
  • --debug captures a sanitised wire transcript to JSONL — safe to share
    when reporting issues.
  • --legacy-app-flow opts into MitID's older /prove + /verify dance.
    Insurance only; the default /complete path works in production.
  • aula doctor walks every read endpoint and reports per-call status.
  • aula log shows recent login attempts (success/failure + timestamps).
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
      const legacyAppFlow = args.flags['legacy-app-flow'] === true;
      await runLogin({
        ...(username ? { username } : {}),
        ...(method ? { method } : {}),
        ...(debug ? { debug: true } : {}),
        ...(transcript ? { transcript } : {}),
        ...(legacyAppFlow ? { legacyAppFlow: true } : {}),
      });
      break;
    }
    case 'status':
      await runStatus({ json: args.flags.json === true });
      break;
    case 'whoami':
      await runWhoami({ json: args.flags.json === true });
      break;
    case 'doctor':
      await runDoctor({
        json: args.flags.json === true,
        verbose: args.flags.verbose === true,
      });
      break;
    case 'log': {
      const lastRaw = args.flags.last;
      const last = typeof lastRaw === 'string' ? Number.parseInt(lastRaw, 10) : undefined;
      await runLog({
        ...(typeof last === 'number' && Number.isFinite(last) ? { last } : {}),
        json: args.flags.json === true,
      });
      break;
    }
    case 'transcript': {
      const sub = args.positional[0];
      switch (sub) {
        case 'view': {
          const file = args.positional[1];
          if (!file) {
            process.stderr.write('Usage: aula transcript view <file>\n');
            process.exit(2);
          }
          await runTranscriptView({ file, json: args.flags.json === true });
          break;
        }
        case 'list':
          await runTranscriptList({ json: args.flags.json === true });
          break;
        case 'prune': {
          const keepRaw = args.flags.keep;
          const keep = typeof keepRaw === 'string' ? Number.parseInt(keepRaw, 10) : undefined;
          await runTranscriptPrune({
            ...(typeof keep === 'number' && Number.isFinite(keep) ? { keep } : {}),
            ...(args.flags['dry-run'] === true ? { dryRun: true } : {}),
          });
          break;
        }
        default:
          process.stderr.write(`Unknown transcript subcommand: ${sub ?? '<missing>'}\n`);
          process.stderr.write('Try: aula transcript {list|view <file>|prune}\n');
          process.exit(2);
      }
      break;
    }
    case 'logout':
      await runLogout();
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
