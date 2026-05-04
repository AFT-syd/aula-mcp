/**
 * `aula log [--last N] [--json]` — print recent login attempts.
 */

import { fmt, info, printJson } from '../io.ts';
import { type LoginLogEntry, readLoginLog } from '../login-log.ts';

export interface LogCommandArgs {
  last?: number;
  json?: boolean;
}

export async function runLog(args: LogCommandArgs = {}): Promise<void> {
  const all = await readLoginLog();
  const last = args.last ?? 20;
  const slice = last > 0 ? all.slice(-last) : all;

  if (args.json) {
    printJson(slice);
    return;
  }

  if (slice.length === 0) {
    info('No login attempts recorded yet.');
    return;
  }

  for (const e of slice) {
    process.stdout.write(`${formatRow(e)}\n`);
  }
}

function formatRow(e: LoginLogEntry): string {
  const tag = e.success ? fmt.green('OK ') : fmt.red('FAIL');
  const id = e.identityName ? ` ${fmt.dim(`[${e.identityName}]`)}` : '';
  const err = e.errorMessage ? `  ${fmt.dim(e.errorMessage)}` : '';
  return `  ${fmt.dim(e.ts)}  ${tag}  ${e.username} (${e.method})${id}${err}`;
}
