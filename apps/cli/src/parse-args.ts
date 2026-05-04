/**
 * Tiny zero-dep argv parser for the `aula` CLI.
 *
 * Conventions:
 *   - First non-flag token becomes `command`; subsequent ones go into `positional`.
 *   - `--flag` with a non-flag-looking value attached → `{ flag: value }`.
 *   - `--flag=value` → same as above.
 *   - `--flag` alone (or followed by another `--…`) → `{ flag: true }`.
 *   - `--` and empty strings are dropped.
 *
 * Extracted for testability — the dispatcher in index.ts is a thin shell
 * around it.
 */

export interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
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
