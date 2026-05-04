import { describe, expect, test } from 'bun:test';
import { parseArgs } from './parse-args.ts';

describe('parseArgs', () => {
  test('command + positional args', () => {
    expect(parseArgs(['transcript', 'view', 'foo.jsonl'])).toEqual({
      command: 'transcript',
      positional: ['view', 'foo.jsonl'],
      flags: {},
    });
  });

  test('--flag value pair', () => {
    expect(parseArgs(['login', '--username', 'cj'])).toEqual({
      command: 'login',
      positional: [],
      flags: { username: 'cj' },
    });
  });

  test('--flag=value pair', () => {
    expect(parseArgs(['login', '--method=APP'])).toEqual({
      command: 'login',
      positional: [],
      flags: { method: 'APP' },
    });
  });

  test('boolean flag (no value attached)', () => {
    expect(parseArgs(['login', '--debug'])).toEqual({
      command: 'login',
      positional: [],
      flags: { debug: true },
    });
  });

  test('boolean flag followed by another flag stays boolean', () => {
    const out = parseArgs(['doctor', '--verbose', '--json']);
    expect(out.flags.verbose).toBe(true);
    expect(out.flags.json).toBe(true);
  });

  test('mix of flags and positionals', () => {
    expect(parseArgs(['transcript', 'prune', '--keep', '5', '--dry-run'])).toEqual({
      command: 'transcript',
      positional: ['prune'],
      flags: { keep: '5', 'dry-run': true },
    });
  });

  test('drops -- separator', () => {
    expect(parseArgs(['login', '--', '--debug'])).toEqual({
      command: 'login',
      positional: [],
      flags: { debug: true },
    });
  });

  test('empty argv', () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: {} });
  });

  test('only flags (no command)', () => {
    const out = parseArgs(['--help']);
    expect(out.command).toBeUndefined();
    expect(out.flags.help).toBe(true);
  });

  test('value containing spaces (already split into argv)', () => {
    expect(parseArgs(['login', '--transcript', '/tmp/some path/file.jsonl'])).toEqual({
      command: 'login',
      positional: [],
      flags: { transcript: '/tmp/some path/file.jsonl' },
    });
  });

  test('handles --flag value where value starts with non-dash', () => {
    expect(parseArgs(['login', '--method', 'CODE_TOKEN'])).toEqual({
      command: 'login',
      positional: [],
      flags: { method: 'CODE_TOKEN' },
    });
  });
});
