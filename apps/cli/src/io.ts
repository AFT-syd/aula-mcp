/**
 * Tiny stdin/stdout helpers for the CLI. Kept dependency-free so the binary
 * stays small and Bun's `bun build --compile` can ship a single file.
 */

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const useColor = process.stdout.isTTY && process.env.NO_COLOR == null;
const c = (code: string, s: string) => (useColor ? `${code}${s}${ANSI.reset}` : s);

export const fmt = {
  bold: (s: string) => c(ANSI.bold, s),
  dim: (s: string) => c(ANSI.dim, s),
  red: (s: string) => c(ANSI.red, s),
  green: (s: string) => c(ANSI.green, s),
  yellow: (s: string) => c(ANSI.yellow, s),
  blue: (s: string) => c(ANSI.blue, s),
  cyan: (s: string) => c(ANSI.cyan, s),
};

export function info(message: string): void {
  output.write(`${fmt.cyan('•')} ${message}\n`);
}

export function ok(message: string): void {
  output.write(`${fmt.green('✓')} ${message}\n`);
}

export function warn(message: string): void {
  output.write(`${fmt.yellow('!')} ${message}\n`);
}

export function fail(message: string): void {
  output.write(`${fmt.red('✗')} ${message}\n`);
}

export function rule(label = ''): void {
  const cols = process.stdout.columns ?? 60;
  const line = '─'.repeat(Math.max(8, cols - label.length - 2));
  output.write(`\n${fmt.dim(line)} ${fmt.dim(label)}\n`);
}

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${fmt.bold('?')} ${question} `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function promptSecret(question: string): Promise<string> {
  // Toggle echo off via TTY raw mode when possible; fall back to plain prompt.
  if (!input.isTTY) return prompt(question);
  output.write(`${fmt.bold('?')} ${question} `);
  const muted = process.stdout;
  return new Promise<string>((resolve) => {
    let value = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = (data: string): void => {
      for (const ch of data) {
        if (ch === '') {
          // ctrl-c
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') {
          muted.write('\n');
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          resolve(value);
          return;
        }
        if (ch === '') {
          // backspace
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    input.on('data', onData);
  });
}

export async function selectFromList(
  prompt_label: string,
  options: ReadonlyArray<{ label: string }>,
): Promise<number> {
  output.write(`\n${fmt.bold(prompt_label)}\n`);
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (opt) output.write(`  ${fmt.cyan(String(i + 1))}. ${opt.label}\n`);
  }
  while (true) {
    const raw = await prompt(`Pick a number (1-${options.length}):`);
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n;
    warn('Please enter a number from the list.');
  }
}
