/**
 * Wires AULA_MCP_TRACE_FILE into a JsonlFileTracer for the long-running HTTP
 * server.
 *
 * The wire-tracer itself (packages/aula-auth/src/wire-tracer.ts) has existed
 * since the CLI's `aula login --debug` / `aula doctor --verbose` — it
 * captures every HTTP exchange (method, URL, headers, bodies, status,
 * duration), sanitised with the same redaction lists that make a CLI
 * transcript safe to attach to a GitHub issue. `server.ts` never plugged it
 * in: AulaContext always built its AulaHttpClient without a `tracer`, so it
 * fell back to AulaHttpClient's own noop. The result, confirmed live
 * 2026-10-02: `AULA_MCP_LOG=1` on the running server shows only
 * `http.request` lines (method + sanitised URL) — no status, no response
 * body, no way to tell a call that succeeded from one that silently failed.
 *
 * Off by default: AULA_MCP_TRACE_FILE unset → createHttpTracer returns
 * undefined → AulaContext falls back to its prior default exactly as
 * before this module existed. No new file, no new write, no behavior
 * change for anyone who doesn't set the variable.
 *
 * When set, the file is created (or reused) with owner-only permissions
 * (0600) — it carries sanitised HTTP traffic, not secrets, but "sanitised"
 * still means operator-readable transcripts, not world-readable ones — and
 * every HTTP exchange any integration this server drives (Aula, Tabulex,
 * EasyIQ, Meebook, Min Uddannelse, Systematic) is appended as one JSONL line
 * per exchange. The file is append-only and grows for as long as the
 * variable stays set; nothing here rotates or truncates it — an operator
 * who enables it for a debugging session is expected to unset it and
 * remove/rotate the file afterwards. See README.md's "Server-miljøvariabler"
 * table and docs/architecture.md's "Wire-trace + sanitisation" section.
 */

import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { JsonlFileTracer, type WireTracer } from '@aula-mcp/aula-auth';

/** Read the trace-file path from the environment. A thin wrapper so tests
 *  can inject a fake env without mutating the real `process.env`. */
export function resolveTraceFilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.AULA_MCP_TRACE_FILE;
  return path && path.length > 0 ? path : undefined;
}

/**
 * Create (or touch) the trace file at `path` with owner-only permissions
 * (0600), creating its parent directory if needed. Throws synchronously —
 * meant to be called at server boot, so a path the process can't write to
 * (bad parent, read-only filesystem, permissions) fails the startup loudly
 * instead of the server starting "successfully" and then dropping every
 * trace entry for a debugging session that looked like it was working.
 */
export function ensureTraceFileWritable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // 'a' (append, create-if-missing) so a pre-existing trace file from an
  // earlier run is kept, not truncated. The mode only applies when this
  // call actually creates the file; chmod below makes it unconditional,
  // covering a file that already existed with looser permissions.
  const fd = openSync(path, 'a', 0o600);
  closeSync(fd);
  chmodSync(path, 0o600);
}

/**
 * Build the WireTracer the HTTP server should use, from
 * AULA_MCP_TRACE_FILE. Returns `undefined` when `path` is unset, so the
 * caller can omit the `tracer` option entirely and AulaContext/AulaHttpClient
 * fall back to their own noop default — no behaviour change when the
 * variable isn't set.
 */
export function createHttpTracer(path: string | undefined): WireTracer | undefined {
  if (!path) return undefined;
  ensureTraceFileWritable(path);
  return new JsonlFileTracer(path);
}
