/**
 * Tests for Streamable HTTP session routing.
 *
 * The regression these guard against was found on a live deployment, not in
 * CI: the server connected ONE stateful transport at boot, so only the first
 * client could ever initialise. claude.ai authenticated, then saw no tools,
 * because every reconnect got "Server already initialized". The server here is
 * a one-tool stub — the point is the routing, not the Aula tool surface.
 */

import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpSessionRouter, type McpSessionRouter } from './mcp-sessions.ts';

function stubServer(): McpServer {
  const server = new McpServer({ name: 'stub', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return server;
}

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

function post(body: unknown, sessionId?: string): Request {
  return new Request('http://test/mcp', {
    method: 'POST',
    headers: sessionId ? { ...HEADERS, 'mcp-session-id': sessionId } : HEADERS,
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

/** initialize + initialized notification; returns the session id. */
async function connect(router: McpSessionRouter): Promise<string> {
  const res = await router.handle(post(INITIALIZE));
  expect(res.status).toBe(200);
  const id = res.headers.get('mcp-session-id');
  expect(id).toBeTruthy();
  await router.handle(post({ jsonrpc: '2.0', method: 'notifications/initialized' }, id ?? ''));
  return id ?? '';
}

async function listTools(router: McpSessionRouter, sessionId: string): Promise<Response> {
  return router.handle(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId));
}

describe('MCP session routing', () => {
  test('a second client can initialise while the first session is alive', async () => {
    // The production failure, exactly: the second initialize used to get 400.
    const router = createMcpSessionRouter({ createServer: stubServer });
    const first = await connect(router);
    const second = await connect(router);

    expect(second).not.toBe(first);
    expect((await listTools(router, first)).status).toBe(200);
    const res = await listTools(router, second);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ping');
    expect(router.size).toBe(2);
    await router.closeAll();
  });

  test('an unknown session id gets 404, the spec signal to re-initialise', async () => {
    const router = createMcpSessionRouter({ createServer: stubServer });
    const res = await listTools(router, 'no-such-session');
    expect(res.status).toBe(404);
  });

  test('a non-initialize request without a session is refused and leaves nothing behind', async () => {
    const router = createMcpSessionRouter({ createServer: stubServer });
    const res = await router.handle(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(router.size).toBe(0);
  });

  test('a GET without a session id is a 400, not a new session', async () => {
    const router = createMcpSessionRouter({ createServer: stubServer });
    const res = await router.handle(
      new Request('http://test/mcp', { method: 'GET', headers: HEADERS }),
    );
    expect(res.status).toBe(400);
    expect(router.size).toBe(0);
  });

  test('DELETE ends the session', async () => {
    const router = createMcpSessionRouter({ createServer: stubServer });
    const id = await connect(router);
    const res = await router.handle(
      new Request('http://test/mcp', {
        method: 'DELETE',
        headers: { ...HEADERS, 'mcp-session-id': id },
      }),
    );
    expect(res.ok).toBe(true);
    expect(router.size).toBe(0);
    expect((await listTools(router, id)).status).toBe(404);
  });

  test('idle sessions are swept, active ones survive', async () => {
    const clock = { value: 1_000_000 };
    const router = createMcpSessionRouter({
      createServer: stubServer,
      idleMs: 60_000,
      now: () => clock.value,
    });
    const idle = await connect(router);
    clock.value += 50_000;
    const active = await connect(router);
    clock.value += 20_000; // idle is now 70 s old, active 20 s

    await router.sweepIdle();
    expect((await listTools(router, idle)).status).toBe(404);
    expect((await listTools(router, active)).status).toBe(200);
    await router.closeAll();
  });

  test('a full router evicts the least recently active session instead of refusing', async () => {
    const clock = { value: 1_000_000 };
    const router = createMcpSessionRouter({
      createServer: stubServer,
      maxSessions: 2,
      now: () => clock.value,
    });
    const oldest = await connect(router);
    clock.value += 1_000;
    const recent = await connect(router);
    clock.value += 1_000;
    await listTools(router, oldest); // oldest is now the MORE recently active one
    clock.value += 1_000;

    const newcomer = await connect(router);
    expect(router.size).toBe(2);
    expect((await listTools(router, recent)).status).toBe(404);
    expect((await listTools(router, oldest)).status).toBe(200);
    expect((await listTools(router, newcomer)).status).toBe(200);
    await router.closeAll();
  });

  test('closeAll ends every session', async () => {
    const router = createMcpSessionRouter({ createServer: stubServer });
    await connect(router);
    await connect(router);
    await router.closeAll();
    expect(router.size).toBe(0);
  });
});

describe('MCP session routing under load (review findings)', () => {
  /** A stub whose one tool blocks until the test releases it. */
  function slowServer(gate: Promise<void>): () => McpServer {
    return () => {
      const server = new McpServer(
        { name: 'slow', version: '0.0.0' },
        { capabilities: { tools: {} } },
      );
      server.registerTool('slow', { description: 'slow', inputSchema: {} }, async () => {
        await gate;
        return { content: [{ type: 'text', text: 'done' }] };
      });
      return server;
    };
  }

  test('a session with a call in flight is not evicted to make room', async () => {
    // The SDK drops a pending JSON response on close without resolving it, so
    // evicting a busy session used to hang its request forever.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const router = createMcpSessionRouter({ createServer: slowServer(gate), maxSessions: 1 });
    const busy = await connect(router);

    const call = router.handle(
      post(
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'slow', arguments: {} } },
        busy,
      ),
    );
    const newcomer = await connect(router); // full router — must not close `busy`
    release();

    const res = await Promise.race([
      call,
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('call hung')), 3_000)),
    ]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('done');
    expect((await listTools(router, newcomer)).status).toBe(200);
    await router.closeAll();
  });

  test('concurrent initialize requests cannot push the router past its cap', async () => {
    const router = createMcpSessionRouter({ createServer: stubServer, maxSessions: 2 });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => router.handle(post(INITIALIZE))),
    );
    for (const res of results) expect(res.status).toBe(200);
    expect(router.size).toBeLessThanOrEqual(2);
    await router.closeAll();
  });
});

describe('MCP session routing: ending a session that is still busy (review C)', () => {
  test('a DELETE while a call is in flight lets the call finish, then ends the session', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const router = createMcpSessionRouter({
      createServer: () => {
        const server = new McpServer(
          { name: 'slow', version: '0.0.0' },
          { capabilities: { tools: {} } },
        );
        server.registerTool('slow', { description: 'slow', inputSchema: {} }, async () => {
          await gate;
          return { content: [{ type: 'text', text: 'done' }] };
        });
        server.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({
          content: [{ type: 'text', text: 'pong' }],
        }));
        return server;
      },
    });
    const id = await connect(router);

    const call = router.handle(
      post(
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'slow', arguments: {} } },
        id,
      ),
    );
    const del = await router.handle(
      new Request('http://test/mcp', {
        method: 'DELETE',
        headers: { ...HEADERS, 'mcp-session-id': id },
      }),
    );
    expect(del.status).toBe(200);
    // A closing session takes no new work.
    expect((await listTools(router, id)).status).toBe(404);

    release();
    const res = await Promise.race([
      call,
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('call hung')), 3_000)),
    ]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('done');
    expect(router.size).toBe(0);
  });
});
