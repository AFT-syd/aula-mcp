import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileTracer, sanitizeHeaders, sanitizeUrl, type WireEntry } from '@aula-mcp/aula-auth';
import { createHttpTracer, ensureTraceFileWritable, resolveTraceFilePath } from './trace-config.ts';

/** Unique path under the OS temp dir, far from any real config directory. */
function tmpPath(name: string): string {
  return join(tmpdir(), `aula-mcp-trace-test-${randomUUID()}-${name}`);
}

describe('resolveTraceFilePath', () => {
  test('unset env -> undefined (off by default)', () => {
    expect(resolveTraceFilePath({})).toBeUndefined();
  });

  test('empty string env -> undefined, same as unset', () => {
    expect(resolveTraceFilePath({ AULA_MCP_TRACE_FILE: '' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  test('a set path is returned as-is', () => {
    expect(resolveTraceFilePath({ AULA_MCP_TRACE_FILE: '/x/y.jsonl' } as NodeJS.ProcessEnv)).toBe(
      '/x/y.jsonl',
    );
  });
});

describe('createHttpTracer', () => {
  test('undefined path -> no tracer, nothing created', () => {
    expect(createHttpTracer(undefined)).toBeUndefined();
  });

  test('a valid path -> a JsonlFileTracer, file created with mode 0600', () => {
    const path = tmpPath('ok.jsonl');
    try {
      expect(createHttpTracer(path)).toBeInstanceOf(JsonlFileTracer);
      expect(existsSync(path)).toBe(true);
      // POSIX permission bits don't restrict access on Windows.
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('an existing file is kept, not truncated', () => {
    const path = tmpPath('existing.jsonl');
    writeFileSync(path, 'earlier run\n');
    try {
      ensureTraceFileWritable(path);
      expect(readFileSync(path, 'utf8')).toBe('earlier run\n');
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('an unwritable path throws synchronously instead of starting up silently', () => {
    // A regular file where a directory needs to go makes mkdir fail.
    const blocker = tmpPath('blocker-file');
    writeFileSync(blocker, 'not a directory');
    const path = join(blocker, 'subdir', 'trace.jsonl');
    try {
      expect(() => createHttpTracer(path)).toThrow();
    } finally {
      rmSync(blocker, { force: true });
    }
  });
});

describe('a real trace file', () => {
  test('keeps the access token and cookies out of the written line', async () => {
    const path = tmpPath('redact.jsonl');
    try {
      const tracer = createHttpTracer(path);
      if (!tracer) throw new Error('expected a tracer for a valid path');
      // Built from the same sanitize* helpers AulaHttpClient.request() uses
      // before calling tracer.record().
      const entry: WireEntry = {
        ts: new Date().toISOString(),
        seq: 1,
        method: 'GET',
        url: sanitizeUrl('https://www.aula.dk/api/v24/?method=x&access_token=SECRET-AT'),
        requestHeaders: sanitizeHeaders({ cookie: 'session=SECRET-COOKIE' }),
        requestBody: null,
        status: 200,
        responseHeaders: {},
        responseBody: '{}',
        responseBodyBytes: 2,
        durationMs: 12,
      };
      tracer.record(entry);
      // JsonlFileTracer.record() does not await its write.
      let contents = '';
      for (let i = 0; i < 50 && contents.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        contents = readFileSync(path, 'utf8');
      }
      expect(contents).toContain('method=x');
      expect(contents).not.toContain('SECRET-AT');
      expect(contents).not.toContain('SECRET-COOKIE');
    } finally {
      rmSync(path, { force: true });
    }
  });
});
