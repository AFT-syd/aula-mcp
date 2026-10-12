/**
 * Streamable HTTP session routing: one MCP transport per client session.
 *
 * Why this exists: `server.ts` used to connect a single stateful transport at
 * boot. A stateful transport accepts exactly one `initialize` in its lifetime,
 * so the first client to connect owned the server until the process restarted.
 * Every later client — a second device, a new browser tab, or claude.ai simply
 * reconnecting — got `400 Server already initialized`, never received a
 * session id, and had every subsequent call refused with `400 Mcp-Session-Id
 * header is required`. From the user's side that looked like a connector that
 * authenticates fine and then shows no tools.
 *
 * The router keeps a map of live sessions keyed by `mcp-session-id`:
 *
 *   - A request without a session id gets a fresh server + transport. If that
 *     request turns out to be an `initialize`, the session is kept; otherwise
 *     the pair is closed again and the transport's own error goes back.
 *   - A request with a known session id is routed to that session's transport.
 *   - An unknown session id gets 404, which the MCP spec defines as "your
 *     session is gone, send a new initialize" — so an evicted or restarted
 *     session recovers without user action.
 *
 * Sessions are bounded two ways. Idle ones are swept after `idleMs`. When the
 * map is full, the least recently active session is evicted rather than the
 * new one refused: only authenticated callers reach this code, an evicted
 * client re-initialises on its own, and refusing would turn a busy moment into
 * a lockout for the one person the server exists for.
 *
 * A session with a request in flight is never evicted or swept. The SDK's
 * `close()` drops pending JSON responses without resolving them, so closing a
 * busy session would hang that request forever instead of failing it. If every
 * session is busy, the cap is exceeded briefly rather than breaking a call.
 */

import { type Logger, silentLogger } from '@aula-mcp/aula-auth';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export interface McpSessionRouterOptions {
  /** Build a fresh McpServer with the tool surface registered. */
  createServer: () => McpServer;
  maxSessions?: number;
  idleMs?: number;
  logger?: Logger;
  /** Injectable clock (ms since epoch) for tests. */
  now?: () => number;
}

export interface McpSessionRouter {
  handle(request: Request): Promise<Response>;
  /** Close sessions idle for longer than `idleMs` that have nothing in flight. */
  sweepIdle(): Promise<void>;
  closeAll(): Promise<void>;
  readonly size: number;
}

interface Session {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastActivityAt: number;
  /** Requests currently inside `handleRequest`. Busy sessions are never closed. */
  inFlight: number;
  /**
   * Set when the session must end while other requests on it are still
   * running. It stops taking new requests and is closed once the last one
   * finishes — closing it immediately would hang those requests.
   */
  closing?: string | undefined;
}

const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_IDLE_MS = 30 * 60 * 1_000;

export function createMcpSessionRouter(opts: McpSessionRouterOptions): McpSessionRouter {
  const logger = opts.logger ?? silentLogger;
  const now = opts.now ?? (() => Date.now());
  const maxSessions = Math.max(1, opts.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const idleMs = Math.max(1_000, opts.idleMs ?? DEFAULT_IDLE_MS);
  const sessions = new Map<string, Session>();

  /** Session ids travel next to a bearer token; log only a prefix. */
  const short = (id: string): string => id.slice(0, 8);

  const closeSession = async (id: string, reason: string): Promise<void> => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try {
      // Closing the server closes its transport too.
      await session.server.close();
    } catch (e) {
      logger.warn('aula-mcp.session.close_error', {
        session: short(id),
        reason,
        error: (e as Error).message,
      });
    }
    logger.info('aula-mcp.session.closed', { session: short(id), reason, active: sessions.size });
  };

  const sweepIdle = async (): Promise<void> => {
    const cutoff = now() - idleMs;
    const stale = [...sessions]
      .filter(([, s]) => s.inFlight === 0 && s.lastActivityAt < cutoff)
      .map(([id]) => id);
    await Promise.all(stale.map((id) => closeSession(id, 'idle')));
  };

  /**
   * Bring the map back under the cap once a new session has landed.
   *
   * Enforced after the fact rather than reserved up front. A reservation checked
   * before `initialize` could only evict sessions that already existed, so a
   * burst of concurrent initializes against a near-empty map found nothing to
   * evict and all of them got in. Here every contender has landed, and each one
   * that finishes re-checks the cap against the real map.
   */
  const enforceCap = async (keepId: string): Promise<void> => {
    while (sessions.size > maxSessions) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, s] of sessions) {
        if (id !== keepId && s.inFlight === 0 && s.lastActivityAt < oldestAt) {
          oldestAt = s.lastActivityAt;
          oldestId = id;
        }
      }
      if (!oldestId) {
        logger.warn('aula-mcp.session.cap_exceeded_all_busy', { active: sessions.size });
        return;
      }
      await closeSession(oldestId, 'evicted_for_new_session');
    }
  };

  const handleKnownSession = async (
    sessionId: string,
    session: Session,
    request: Request,
  ): Promise<Response> => {
    if (session.closing) {
      return jsonRpcError(
        404,
        -32001,
        'Session not found. Send a new initialize request to start a session.',
      );
    }
    // The SDK closes its transport unconditionally on DELETE, which would drop
    // any other in-flight response on this session. While something is still
    // running, acknowledge the DELETE here and let the drain close it instead.
    if (request.method === 'DELETE' && session.inFlight > 0) {
      session.closing = 'client_delete';
      return new Response(null, { status: 200 });
    }
    session.lastActivityAt = now();
    session.inFlight += 1;
    try {
      const response = await session.transport.handleRequest(request);
      if (request.method === 'DELETE' && response.ok) session.closing = 'client_delete';
      return response;
    } catch (e) {
      // A transport that threw is not trusted with further requests, and must
      // not hold a slot until the idle sweep finds it.
      session.closing = 'handler_error';
      throw e;
    } finally {
      session.inFlight -= 1;
      session.lastActivityAt = now();
      // Only the last request to leave closes the session, so a close requested
      // by one request never hangs another that is still running.
      if (session.closing && session.inFlight === 0) {
        await closeSession(sessionId, session.closing);
      }
    }
  };

  const openSession = async (request: Request): Promise<Response> => {
    await sweepIdle();

    const server = opts.createServer();
    let opened: { id: string; session: Session } | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        // Busy from the moment it lands: its own initialize response is still
        // being produced, and closing it now would hang that response.
        const session: Session = { server, transport, lastActivityAt: now(), inFlight: 1 };
        opened = { id, session };
        sessions.set(id, session);
        logger.info('aula-mcp.session.opened', { session: short(id), active: sessions.size });
      },
    });

    try {
      await server.connect(transport);
    } catch (e) {
      await server.close().catch(() => {});
      throw e;
    }
    let response: Response;
    try {
      response = await transport.handleRequest(request);
    } catch (e) {
      if (opened) {
        opened.session.inFlight -= 1;
        await closeSession(opened.id, 'handler_error');
      } else {
        await server.close().catch(() => {});
      }
      throw e;
    }
    if (!opened) {
      // Not an initialize: the transport has already produced the right error,
      // and there is no session to keep.
      await server.close().catch(() => {});
      return response;
    }
    opened.session.inFlight -= 1;
    opened.session.lastActivityAt = now();
    await enforceCap(opened.id);
    return response;
  };

  const handle = async (request: Request): Promise<Response> => {
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return jsonRpcError(
          404,
          -32001,
          'Session not found. Send a new initialize request to start a session.',
        );
      }
      return handleKnownSession(sessionId, session, request);
    }
    // Only an initialize can open a session, and initialize is always a POST.
    if (request.method !== 'POST') {
      return jsonRpcError(400, -32000, 'Bad Request: Mcp-Session-Id header is required');
    }
    return openSession(request);
  };

  return {
    handle,
    sweepIdle,
    async closeAll() {
      await Promise.all([...sessions.keys()].map((id) => closeSession(id, 'shutdown')));
    },
    get size() {
      return sessions.size;
    },
  };
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
