/**
 * Hono + MCP Streamable HTTP server. Runs on Bun.
 *
 * Routes:
 *   POST /mcp             — MCP JSON-RPC requests (Streamable HTTP transport)
 *   GET  /mcp             — Streamable HTTP SSE channel
 *   DELETE /mcp           — session close
 *   GET  /healthz         — liveness probe
 *
 * Env:
 *   AULA_MCP_PORT             — port to bind (default 7878)
 *   AULA_MCP_HOST             — interface to bind (default 127.0.0.1)
 *   AULA_MCP_DIR              — config dir (default ~/.config/aula-mcp)
 *   AULA_MCP_KEY              — encryption key for the token store
 *   AULA_MCP_RAW=1            — enable the aula.raw_request escape hatch
 *   AULA_MCP_LOG=1            — verbose console logs from auth/client layers
 *   AULA_MCP_ALLOW_REMOTE=1   — allow binding to non-loopback addresses (refuses
 *                               by default; the server is single-user and any
 *                               peer with /mcp access can drive your tokens)
 */

import { consoleLogger, silentLogger } from '@aula-mcp/aula-auth';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { AulaContext } from './aula-context.ts';
import { registerTools } from './tools.ts';

const PORT = Number(process.env.AULA_MCP_PORT ?? 7878);
const HOST = process.env.AULA_MCP_HOST ?? '127.0.0.1';

const logger = process.env.AULA_MCP_LOG === '1' ? consoleLogger('aula-mcp') : silentLogger;

assertSafeBindAddress(HOST);

const context = new AulaContext({ logger });

const mcp = new McpServer(
  {
    name: 'aula-mcp',
    version: '0.0.0',
  },
  {
    capabilities: { tools: {} },
    instructions:
      'This server exposes a Danish school platform (Aula) to AI agents. ' +
      "Always call `aula.discover` first — it returns the user's children, " +
      'institution context, current API version, and which other aula.* tools ' +
      'are callable. Then pick subordinate tools dynamically based on the manifest.',
  },
);

registerTools(mcp, context);

// Streamable HTTP transport. Stateful mode — the SDK explicitly forbids
// reusing a *stateless* transport across requests
// ("Stateless transport cannot be reused across requests"), so we provide a
// session-id generator and let the transport track per-session state. For
// single-user use this is a single session that gets created on the first
// request and reused thereafter.
const transport = new WebStandardStreamableHTTPServerTransport({
  enableJsonResponse: true,
  sessionIdGenerator: () => crypto.randomUUID(),
});

await mcp.connect(transport);

const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true, name: 'aula-mcp' }));

const handleMcp = async (request: Request): Promise<Response> => transport.handleRequest(request);
app.post('/mcp', (c) => handleMcp(c.req.raw));
app.get('/mcp', (c) => handleMcp(c.req.raw));
app.delete('/mcp', (c) => handleMcp(c.req.raw));

logger.info('aula-mcp.listening', { host: HOST, port: PORT });
process.stdout.write(`aula-mcp listening on http://${HOST}:${PORT}/mcp (healthz at /healthz)\n`);

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
});

// Graceful shutdown — finish in-flight requests before exiting.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${signal} received — shutting down gracefully…\n`);
  try {
    await server.stop();
    await mcp.close();
  } catch (err) {
    logger.error('aula-mcp.shutdown_error', { error: (err as Error).message });
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Refuse to bind to a non-loopback address unless the operator opts in
 * explicitly. The MCP server is single-user; anyone who can hit `/mcp`
 * effectively *is* the logged-in user. Set AULA_MCP_ALLOW_REMOTE=1 if you
 * understand the implications (e.g. fronted by an authenticated reverse
 * proxy).
 */
function assertSafeBindAddress(host: string): void {
  if (process.env.AULA_MCP_ALLOW_REMOTE === '1') return;
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (loopback) return;
  process.stderr.write(
    `Refusing to bind to non-loopback address (${host}). The MCP server is\n` +
      'single-user and exposes your Aula tokens to anyone who can reach /mcp.\n' +
      'If you front it with an authenticated reverse proxy and accept the risk,\n' +
      'set AULA_MCP_ALLOW_REMOTE=1.\n',
  );
  process.exit(2);
}
