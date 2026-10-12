/**
 * Wires AULA_MCP_TRACE_FILE into a JsonlFileTracer for the long-running HTTP
 * server.
 *
 * The wire tracer (packages/aula-auth/src/wire-tracer.ts) already exists for
 * the CLI's `aula login --debug`; the server never plugged it in, so
 * `AULA_MCP_LOG=1` shows only `http.request` lines (method + URL) — no status,
 * no response body, no way to tell a call that succeeded from one that
 * silently failed.
 *
 * Off by default: unset means no tracer, no file, no behaviour change. When
 * set, every HTTP exchange the server makes is appended as one JSONL line,
 * with the same secret redaction as the CLI transcripts. Redaction covers
 * credentials, not content: response bodies (messages, child names) are
 * written as received, so the file is created 0600 and is meant to be
 * enabled for a debugging session and removed afterwards. It is append-only;
 * nothing rotates or truncates it.
 */

import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { JsonlFileTracer, type WireTracer } from '@aula-mcp/aula-auth';

/** Read the trace-file path from the environment; empty counts as unset. */
export function resolveTraceFilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.AULA_MCP_TRACE_FILE;
  return path && path.length > 0 ? path : undefined;
}

/**
 * Create (or touch) the trace file with owner-only permissions, creating its
 * parent directory if needed. Throws synchronously: called at boot, so an
 * unusable path fails startup instead of the server running and silently
 * dropping every trace entry.
 */
export function ensureTraceFileWritable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // 'a' keeps an existing trace from an earlier run. The mode only applies
  // when the file is created, so chmod covers one that already existed.
  const fd = openSync(path, 'a', 0o600);
  closeSync(fd);
  chmodSync(path, 0o600);
}

/** The tracer to hand to AulaContext, or undefined when tracing is off. */
export function createHttpTracer(path: string | undefined): WireTracer | undefined {
  if (!path) return undefined;
  ensureTraceFileWritable(path);
  return new JsonlFileTracer(path);
}
