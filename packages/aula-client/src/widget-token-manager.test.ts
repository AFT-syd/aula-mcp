import { describe, expect, test } from 'bun:test';
import type { AulaTokens } from '@aula-mcp/aula-auth';
import { AulaClient } from './aula-client.ts';
import { FakeHttp } from './test-helpers.ts';
import {
  isWidgetTokenExpiredResponse,
  type WidgetExpiredSignal,
  WidgetTokenManager,
} from './widget-token-manager.ts';

const TOKENS: AulaTokens = {
  access_token: 'AT',
  refresh_token: 'RT',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  obtained_at: Math.floor(Date.now() / 1000),
};

function makeManager(opts: { ttlMs?: number } = {}) {
  const http = new FakeHttp();
  http.enqueue({ status: 200, body: JSON.stringify({ status: { code: 0 }, data: [] }) }); // probe
  const client = new AulaClient({ tokens: TOKENS, http: http.asHttpClient() });
  const manager = new WidgetTokenManager({
    client,
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
  return { http, manager, client };
}

describe('isWidgetTokenExpiredResponse', () => {
  test('detects "JWT-Token expired" body shape', () => {
    expect(
      isWidgetTokenExpiredResponse('{"message": "JWT-Token expired, please renew."}', 200),
    ).toBe(true);
  });

  test('detects "JWT Token expired" with space', () => {
    expect(isWidgetTokenExpiredResponse('JWT Token expired', 200)).toBe(true);
  });

  test('detects 401 / 403 regardless of body', () => {
    expect(isWidgetTokenExpiredResponse('', 401)).toBe(true);
    expect(isWidgetTokenExpiredResponse('whatever', 403)).toBe(true);
  });

  test('detects "unauthorized" in body', () => {
    expect(isWidgetTokenExpiredResponse('Unauthorized', 200)).toBe(true);
  });

  test('returns false for healthy responses', () => {
    expect(isWidgetTokenExpiredResponse('{"weekplan": []}', 200)).toBe(false);
    expect(isWidgetTokenExpiredResponse('', 200)).toBe(false);
  });
});

describe('WidgetTokenManager.get caching', () => {
  test('first call hits the network, second returns from cache', async () => {
    const { http, manager } = makeManager();
    http.enqueue({ status: 200, body: JSON.stringify({ status: { code: 0 }, data: 'TKN-1' }) });
    expect(await manager.get('0001')).toBe('TKN-1');
    expect(await manager.get('0001')).toBe('TKN-1');
    // 1 probe + 1 token call = 2; if cache failed we'd see a 3rd call (not queued → throw).
    expect(http.requested.length).toBe(2);
  });

  test('different widget ids are cached independently', async () => {
    const { http, manager } = makeManager();
    http.enqueue(
      { status: 200, body: JSON.stringify({ status: { code: 0 }, data: 'TKN-A' }) },
      { status: 200, body: JSON.stringify({ status: { code: 0 }, data: 'TKN-B' }) },
    );
    expect(await manager.get('0001')).toBe('TKN-A');
    expect(await manager.get('0004')).toBe('TKN-B');
    expect(await manager.get('0001')).toBe('TKN-A'); // cached
  });

  test('invalidate forces a refresh on next get', async () => {
    const { http, manager } = makeManager();
    http.enqueue(
      { status: 200, body: JSON.stringify({ status: { code: 0 }, data: 'TKN-1' }) },
      { status: 200, body: JSON.stringify({ status: { code: 0 }, data: 'TKN-2' }) },
    );
    expect(await manager.get('0001')).toBe('TKN-1');
    manager.invalidate('0001');
    expect(await manager.get('0001')).toBe('TKN-2');
  });

  test('concurrent get() calls coalesce — only one network round-trip', async () => {
    const { http, manager } = makeManager();
    http.enqueue({ status: 200, body: JSON.stringify({ status: { code: 0 }, data: 'TKN-X' }) });
    const [a, b, c] = await Promise.all([
      manager.get('0001'),
      manager.get('0001'),
      manager.get('0001'),
    ]);
    expect([a, b, c]).toEqual(['TKN-X', 'TKN-X', 'TKN-X']);
    // 1 probe + 1 token call only.
    expect(http.requested.length).toBe(2);
  });
});

describe('WidgetTokenManager.withRetry', () => {
  test('returns the result on first success without refreshing', async () => {
    const { http, manager } = makeManager();
    http.enqueue({ status: 200, body: JSON.stringify({ status: { code: 0 }, data: 'TKN-1' }) });
    const calls: string[] = [];
    const result = await manager.withRetry('0001', async (token) => {
      calls.push(token);
      return { fine: true };
    });
    expect(result).toEqual({ fine: true });
    expect(calls).toEqual(['TKN-1']);
  });

  test('refreshes and retries once when fn returns _expired signal', async () => {
    const { http, manager } = makeManager();
    http.enqueue(
      { status: 200, body: JSON.stringify({ status: { code: 0 }, data: 'OLD' }) },
      { status: 200, body: JSON.stringify({ status: { code: 0 }, data: 'NEW' }) },
    );
    const calls: string[] = [];
    const result = await manager.withRetry('0001', async (token) => {
      calls.push(token);
      if (token === 'OLD') {
        const signal: WidgetExpiredSignal = {
          _expired: true,
          status: 200,
          bodySnippet: 'JWT-Token expired',
        };
        return signal;
      }
      return { ok: true };
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['OLD', 'NEW']);
  });

  test('throws if refreshed token is still rejected', async () => {
    const { http, manager } = makeManager();
    http.enqueue(
      { status: 200, body: JSON.stringify({ status: { code: 0 }, data: 'OLD' }) },
      { status: 200, body: JSON.stringify({ status: { code: 0 }, data: 'NEW' }) },
    );
    await expect(
      manager.withRetry('0001', async () => {
        const signal: WidgetExpiredSignal = {
          _expired: true,
          status: 401,
          bodySnippet: 'Unauthorized',
        };
        return signal;
      }),
    ).rejects.toThrow(/still rejected/);
  });
});
