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
 *   AULA_MCP_PORT         — port to bind (default 7878)
 *   AULA_MCP_HOST         — interface to bind (default 127.0.0.1)
 *   AULA_MCP_DIR          — config dir (default ~/.config/aula-mcp)
 *   AULA_MCP_KEY          — encryption key for the token store
 *   AULA_MCP_RAW=1        — enable the raw_request escape hatch (TODO)
 *   AULA_MCP_LOG=1        — verbose console logs from the auth/client layers
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

// Streamable HTTP transport. Stateless mode (no session persistence across
// requests) — fine for single-user use; we can layer a session store later.
const transport = new WebStandardStreamableHTTPServerTransport({
  enableJsonResponse: true,
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

Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
});
