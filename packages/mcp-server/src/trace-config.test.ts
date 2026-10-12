/**
 * Seen in a live test 2026-10-02: the wire-tracer existed but was never
 * wired into the long-running server — AULA_MCP_LOG=1 showed only
 * `http.request` lines, no status, no response. These tests cover
 * trace-config.ts's three responsibilities: stay off by default, create the
 * trace file safely (0600) when asked, and fail loudly at boot on a bad
 * path rather than silently dropping every trace entry.
 *
 * The last describe block proves the thing this exists for: CPR and
 * other secrets still get redacted once a real trace file is in the loop —
 * not just in the pure sanitize* helpers (already covered in
 * wire-tracer.test.ts), but through an actual JsonlFileTracer write/read
 * round-trip, built the same way AulaHttpClient.request() builds a
 * WireEntry.
 */

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonlFileTracer,
  sanitizeHeaders,
  sanitizeRequestBody,
  sanitizeResponseBody,
  sanitizeUrl,
  type WireEntry,
} from '@aula-mcp/aula-auth';
import { createHttpTracer, ensureTraceFileWritable, resolveTraceFilePath } from './trace-config.ts';

/** A path under the OS temp dir, unique per test so parallel test files
 *  never collide. Never under ~/.config/aula-mcp — this must stay far away
 *  from any real token/config directory. */
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
  test('undefined path -> no tracer, nothing created (no behaviour change when unset)', () => {
    expect(createHttpTracer(undefined)).toBeUndefined();
  });

  test('a valid path -> a JsonlFileTracer, file created with mode 0600', () => {
    const path = tmpPath('ok.jsonl');
    try {
      const tracer = createHttpTracer(path);
      expect(tracer).toBeInstanceOf(JsonlFileTracer);
      expect(existsSync(path)).toBe(true);
      // POSIX permission bits don't mean the same thing on Windows — only
      // assert the mode where chmod actually restricts access.
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('an unwritable path throws synchronously instead of starting up silently', () => {
    // Force mkdir to fail: a regular file where a directory needs to go.
    const blocker = tmpPath('blocker-file');
    writeFileSync(blocker, 'not a directory');
    const path = join(blocker, 'subdir', 'trace.jsonl');
    try {
      expect(() => createHttpTracer(path)).toThrow();
      expect(() => ensureTraceFileWritable(path)).toThrow();
    } finally {
      rmSync(blocker, { force: true });
    }
  });
});

describe('a real trace file keeps CPR and other secrets out, end to end', () => {
  test('a CPR-shaped path segment, a Cpr request-body field, and a Cpr response field are all redacted', async () => {
    const path = tmpPath('cpr.jsonl');
    const cpr = '010120-1234';
    const cprDigitsOnly = cpr.replace('-', '');
    try {
      const tracer = createHttpTracer(path);
      if (!tracer) throw new Error('expected a tracer for a valid path');

      // Builds a WireEntry the same way AulaHttpClient.request() does
      // before calling tracer.record() — see http.ts — not a shortcut
      // around the real sanitisation call sites.
      const url = sanitizeUrl(`https://foraeldre.tabulex.net/api/Fravaer/Idag/${cpr}`);
      const requestBody = sanitizeRequestBody(JSON.stringify({ Cpr: cpr }));
      const sanitisedResponse = sanitizeResponseBody(
        JSON.stringify({ Cpr: cpr, Fornavn: 'Barn', Dag: true }),
      );
      const entry: WireEntry = {
        ts: new Date().toISOString(),
        seq: 1,
        method: 'PUT',
        url,
        // A secret that isn't CPR, to prove "secrets" plural, not just CPR.
        requestHeaders: sanitizeHeaders({ cookie: 'FedAuth=super-secret-session-value' }),
        requestBody,
        status: 200,
        responseHeaders: {},
        responseBody: sanitisedResponse.text,
        responseBodyBytes: sanitisedResponse.bytes,
        durationMs: 12,
      };
      tracer.record(entry);
      // JsonlFileTracer.record() fires the write without awaiting it
      // (fire-and-forget by design — see its docstring). Give the async
      // mkdir+appendFile a turn before reading the file back.
      for (let i = 0; i < 20 && !existsSync(path); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      let fileContents = '';
      for (let i = 0; i < 20; i++) {
        fileContents = readFileSync(path, 'utf8');
        if (fileContents.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(fileContents.length).toBeGreaterThan(0);
      expect(fileContents).not.toContain(cpr);
      expect(fileContents).not.toContain(cprDigitsOnly);
      expect(fileContents).not.toContain('super-secret-session-value');
      expect(fileContents).toContain('redacted-cpr');
      // Belt-and-braces: no bare CPR shape survives anywhere in the file,
      // outside the literal redaction placeholder itself.
      expect(/\d{6}-?\d{4}/.test(fileContents.replace(/redacted-cpr/g, ''))).toBe(false);
    } finally {
      rmSync(path, { force: true });
    }
  });
});
