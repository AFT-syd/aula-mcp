/**
 * Tests for the OAuth 2.1 authorization server that guards remote MCP access.
 *
 * The whole app is booted in-process and driven through `app.fetch()`, the
 * same way `server.test.ts` exercises the MCP transport. No network, no Aula,
 * no tokens on disk — the auth store is in-memory.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { challengeFromVerifier, generatePkce } from '@aula-mcp/aula-auth';
import { Hono } from 'hono';
import {
  type AuthStore,
  assertRemoteAuthConfigured,
  createAuthProvider,
  emptyAuthState,
  FileAuthStore,
  hashToken,
  isAcceptableRedirectUri,
  MemoryAuthStore,
  normalizeBaseUrl,
  redirectUriAllowed,
  resolveAuthConfig,
  revokeAuthState,
} from './mcp-auth.ts';

const PUBLIC_URL = 'https://example.test/aula';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const PASSWORD = 'correct-horse-battery-staple';

let passwordHash: string;

beforeAll(async () => {
  // bcrypt at the minimum cost keeps the suite fast; `Bun.password.verify`
  // detects the algorithm from the hash, so production argon2id still works.
  passwordHash = await Bun.password.hash(PASSWORD, { algorithm: 'bcrypt', cost: 4 });
});

interface Harness {
  app: Hono;
  clock: { value: number };
  /** Delays the throttle asked for, in call order. Never actually waited. */
  delays: number[];
}

async function harness(opts: { store?: AuthStore; hash?: string } = {}): Promise<Harness> {
  const clock = { value: Date.UTC(2026, 8, 9, 12, 0, 0) };
  const delays: number[] = [];
  const provider = await createAuthProvider({
    config: { publicUrl: PUBLIC_URL, passwordHash: opts.hash ?? passwordHash },
    store: opts.store ?? new MemoryAuthStore(),
    now: () => clock.value,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  const app = new Hono();
  // Same registration order as server.ts: middleware, then the auth routes,
  // then everything the middleware is meant to protect.
  app.use('*', provider.middleware);
  app.route('/', provider.routes);
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.post('/mcp', (c) => c.json({ protected: 'mcp' }));
  app.get('/sse', (c) => c.json({ protected: 'sse' }));
  app.post('/messages', (c) => c.json({ protected: 'messages' }));
  return { app, clock, delays };
}

async function callMcp(app: Hono, accessToken: string): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

async function refreshToken(app: Hono, token: string): Promise<Response> {
  return app.request('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token }).toString(),
  });
}

async function registerClient(app: Hono, redirectUris = [REDIRECT_URI]): Promise<string> {
  const res = await app.request('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'Test client' }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

function authorizeUrl(
  clientId: string,
  challenge: string,
  overrides: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...overrides,
  });
  return `/authorize?${params.toString()}`;
}

async function submitPassword(
  app: Hono,
  clientId: string,
  challenge: string,
  password: string,
): Promise<Response> {
  const body = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    password,
  });
  return app.request('/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

/** Register -> password -> code -> token. Returns the token response body. */
async function fullFlow(app: Hono): Promise<{
  clientId: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}> {
  const clientId = await registerClient(app);
  const pkce = generatePkce();
  const res = await submitPassword(app, clientId, pkce.challenge, PASSWORD);
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get('location') ?? '').searchParams.get('code');
  expect(code).toBeTruthy();

  const tokenRes = await app.request('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code ?? '',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.verifier,
    }).toString(),
  });
  expect(tokenRes.status).toBe(200);
  const body = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };
  return { clientId, ...body };
}

// ---------------------------------------------------------------------------

describe('redirect_uri matching', () => {
  const client = {
    client_id: 'c1',
    redirect_uris: [REDIRECT_URI],
    created_at: 0,
    last_used_at: 0,
  };

  test('accepts the exact registered URI', () => {
    expect(redirectUriAllowed(client, REDIRECT_URI)).toBe(true);
  });

  test('rejects the prefix trick that had to be patched out of v1/v2', () => {
    // `startsWith`-style matching would accept every one of these.
    expect(redirectUriAllowed(client, `${REDIRECT_URI}.attacker.example`)).toBe(false);
    expect(redirectUriAllowed(client, `${REDIRECT_URI}/../../evil`)).toBe(false);
    expect(redirectUriAllowed(client, `${REDIRECT_URI}@attacker.example`)).toBe(false);
    expect(
      redirectUriAllowed(client, 'https://claude.ai.attacker.example/api/mcp/auth_callback'),
    ).toBe(false);
  });

  test('rejects a different scheme or host', () => {
    expect(redirectUriAllowed(client, 'http://claude.ai/api/mcp/auth_callback')).toBe(false);
    expect(redirectUriAllowed(client, 'https://evil.example/api/mcp/auth_callback')).toBe(false);
  });
});

describe('registration input validation', () => {
  test('https is accepted, http only on loopback', () => {
    expect(isAcceptableRedirectUri('https://claude.ai/cb')).toBe(true);
    expect(isAcceptableRedirectUri('http://localhost:1234/cb')).toBe(true);
    expect(isAcceptableRedirectUri('http://127.0.0.1:1234/cb')).toBe(true);
    expect(isAcceptableRedirectUri('http://evil.example/cb')).toBe(false);
  });

  test('non-http schemes are rejected', () => {
    expect(isAcceptableRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isAcceptableRedirectUri('data:text/html,<script>')).toBe(false);
    expect(isAcceptableRedirectUri('not a url')).toBe(false);
  });

  test('the endpoint refuses a bad redirect_uri', async () => {
    const { app } = await harness();
    const res = await app.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }),
    });
    expect(res.status).toBe(400);
  });

  test('the endpoint refuses an empty redirect_uris list', async () => {
    const { app } = await harness();
    const res = await app.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [] }),
    });
    expect(res.status).toBe(400);
  });

  test('too many redirect_uris are refused', async () => {
    const { app } = await harness();
    const res = await app.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: Array.from({ length: 11 }, (_, i) => `https://claude.ai/cb${i}`),
      }),
    });
    expect(res.status).toBe(400);
  });

  test('an over-long redirect_uri is refused', async () => {
    const { app } = await harness();
    const res = await app.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [`https://claude.ai/${'x'.repeat(600)}`] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('registration flooding cannot displace a working connector', () => {
  test('a client kept alive by refresh grants survives a registration flood', async () => {
    const { app, clock } = await harness();
    const paired = await fullFlow(app);

    // Twenty days on, the connector is still in use — but claude.ai only ever
    // talks to /token after the initial pairing. That refresh traffic has to
    // count as "used", or the client looks idle to the eviction rule.
    clock.value += 20 * 24 * 60 * 60 * 1000;
    expect((await refreshToken(app, paired.refresh_token)).status).toBe(200);

    // Now an attacker floods the uncredentialed registration endpoint, one
    // registration per second the way real requests would arrive.
    for (let i = 0; i < 60; i += 1) {
      clock.value += 1000;
      await app.request('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [`https://spam.example/cb${i}`] }),
      });
    }

    // The paired client is still registered and can still authorize.
    const res = await app.request(authorizeUrl(paired.clientId, generatePkce().challenge));
    expect(res.status).toBe(200);
  });

  test('a client that has registered but not yet paired is not evicted mid-pairing', async () => {
    // Reproduces the reviewer's proof-of-concept: the real client registers,
    // then an attacker floods before it gets to /authorize. Nothing protects it
    // by way of a token yet, so the pairing grace period has to.
    const { app } = await harness();
    const realClientId = await registerClient(app);
    for (let i = 0; i < 60; i += 1) {
      await app.request('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [`https://attacker-${i}.example/cb`] }),
      });
    }
    const probe = await app.request(authorizeUrl(realClientId, generatePkce().challenge));
    expect(probe.status).toBe(200);
  });

  test('registration is refused rather than evicting an active client', async () => {
    const { app } = await harness();
    // Fill every slot with a client holding live tokens.
    for (let i = 0; i < 50; i += 1) await fullFlow(app);
    const res = await app.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://claude.ai/one-too-many'] }),
    });
    expect(res.status).toBe(503);
  });
});

describe('/authorize', () => {
  test('serves the password form for a valid request', async () => {
    const { app } = await harness();
    const clientId = await registerClient(app);
    const res = await app.request(authorizeUrl(clientId, generatePkce().challenge));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="password"');
    // The form must post back to the absolute public URL so it survives a
    // path-prefixed reverse proxy.
    expect(html).toContain(`action="${PUBLIC_URL}/authorize"`);
  });

  test('an unknown client gets an error page, never a redirect', async () => {
    const { app } = await harness();
    const res = await app.request(authorizeUrl('does-not-exist', generatePkce().challenge));
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  test('an unregistered redirect_uri gets an error page, never a redirect', async () => {
    const { app } = await harness();
    const clientId = await registerClient(app);
    const res = await app.request(
      authorizeUrl(clientId, generatePkce().challenge, {
        redirect_uri: 'https://evil.example/steal',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  test('a plain code_challenge (no S256) is refused', async () => {
    const { app } = await harness();
    const clientId = await registerClient(app);
    const res = await app.request(
      authorizeUrl(clientId, 'challenge', { code_challenge_method: 'plain' }),
    );
    // redirect_uri is valid by this point, so the error goes back to the client.
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('xyz');
  });

  test('a wrong password re-renders the form and grants nothing', async () => {
    const { app } = await harness();
    const clientId = await registerClient(app);
    const res = await submitPassword(app, clientId, generatePkce().challenge, 'wrong');
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('Forkert kodeord');
  });

  test('repeated wrong passwords slow further attempts down', async () => {
    const { app, delays } = await harness();
    const clientId = await registerClient(app);
    const challenge = generatePkce().challenge;
    for (let i = 0; i < 5; i += 1) {
      expect((await submitPassword(app, clientId, challenge, 'wrong')).status).toBe(401);
    }
    // The first five attempts are free; the throttle starts after them.
    expect(delays).toEqual([]);
    await submitPassword(app, clientId, challenge, 'wrong');
    expect(delays).toEqual([1000]);
    await submitPassword(app, clientId, challenge, 'wrong');
    expect(delays).toEqual([1000, 2000]);
  });

  test('throttling never locks the operator out — the right password still works', async () => {
    const { app } = await harness();
    const clientId = await registerClient(app);
    const challenge = generatePkce().challenge;
    // An attacker burns attempts against the open /authorize endpoint. With a
    // hard lockout this would deny the operator access for as long as the
    // attacker kept it up — the person who may need to mark a child sick.
    for (let i = 0; i < 20; i += 1) {
      await submitPassword(app, clientId, challenge, 'wrong');
    }
    const res = await submitPassword(app, clientId, challenge, PASSWORD);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy();
  });

  test('an old failure streak is forgotten', async () => {
    const { app, clock, delays } = await harness();
    const clientId = await registerClient(app);
    const challenge = generatePkce().challenge;
    for (let i = 0; i < 6; i += 1) {
      await submitPassword(app, clientId, challenge, 'wrong');
    }
    expect(delays).toEqual([1000]);
    clock.value += 31 * 60 * 1000;
    await submitPassword(app, clientId, challenge, 'wrong');
    expect(delays).toEqual([1000]);
  });
});

describe('/token', () => {
  test('the happy path issues a bearer token', async () => {
    const { app } = await harness();
    const tokens = await fullFlow(app);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.expires_in).toBe(3600);
  });

  test('a mismatched PKCE verifier is refused', async () => {
    const { app } = await harness();
    const clientId = await registerClient(app);
    const pkce = generatePkce();
    const res = await submitPassword(app, clientId, pkce.challenge, PASSWORD);
    const code = new URL(res.headers.get('location') ?? '').searchParams.get('code');

    const tokenRes = await app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: generatePkce().verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
    expect(((await tokenRes.json()) as { error: string }).error).toBe('invalid_grant');
  });

  test('an authorization code is single-use', async () => {
    const { app } = await harness();
    const clientId = await registerClient(app);
    const pkce = generatePkce();
    const res = await submitPassword(app, clientId, pkce.challenge, PASSWORD);
    const code = new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const exchange = async (): Promise<Response> =>
      app.request('/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          code_verifier: pkce.verifier,
        }).toString(),
      });
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status).toBe(400);
  });

  test('a redirect_uri that differs from the authorization request is refused', async () => {
    const { app } = await harness();
    const clientId = await registerClient(app, [REDIRECT_URI, 'https://claude.ai/other']);
    const pkce = generatePkce();
    const res = await submitPassword(app, clientId, pkce.challenge, PASSWORD);
    const code = new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const tokenRes = await app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        // Registered, but not the one the code was issued for.
        redirect_uri: 'https://claude.ai/other',
        code_verifier: pkce.verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
  });

  test('an expired code is refused', async () => {
    const { app, clock } = await harness();
    const clientId = await registerClient(app);
    const pkce = generatePkce();
    const res = await submitPassword(app, clientId, pkce.challenge, PASSWORD);
    const code = new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';
    clock.value += 61_000;
    const tokenRes = await app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
  });

  test('refresh rotates and invalidates the old token', async () => {
    const { app } = await harness();
    const first = await fullFlow(app);

    const rotated = await refreshToken(app, first.refresh_token);
    expect(rotated.status).toBe(200);
    const second = (await rotated.json()) as { refresh_token: string; access_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // Replaying the spent refresh token must fail.
    expect((await refreshToken(app, first.refresh_token)).status).toBe(400);
  });

  test('a refresh token expires after 30 days', async () => {
    const { app, clock } = await harness();
    const tokens = await fullFlow(app);
    clock.value += 31 * 24 * 60 * 60 * 1000;
    const res = await refreshToken(app, tokens.refresh_token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  test('an unsupported grant_type is refused', async () => {
    const { app } = await harness();
    const res = await app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        username: 'a',
        password: 'b',
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unsupported_grant_type');
  });
});

describe('bearer middleware', () => {
  test('/healthz stays open — Uptime Kuma has no token', async () => {
    const { app } = await harness();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('the discovery documents stay open', async () => {
    const { app } = await harness();
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ]) {
      expect((await app.request(path)).status).toBe(200);
    }
  });

  test('metadata advertises this deployment, not localhost', async () => {
    const { app } = await harness();
    const meta = (await (await app.request('/.well-known/oauth-authorization-server')).json()) as {
      issuer: string;
      authorization_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(meta.issuer).toBe(PUBLIC_URL);
    expect(meta.authorization_endpoint).toBe(`${PUBLIC_URL}/authorize`);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
  });

  test('an unauthenticated /mcp call gets 401 pointing at the metadata', async () => {
    const { app } = await harness();
    const res = await app.request('/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `${PUBLIC_URL}/.well-known/oauth-protected-resource`,
    );
  });

  test('a valid bearer token passes through', async () => {
    const { app } = await harness();
    const tokens = await fullFlow(app);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protected: 'mcp' });
  });

  test('/sse and /messages sit behind the same gate as /mcp', async () => {
    // server.ts registers the middleware before all three; this asserts the
    // legacy SSE transport is covered too, not just Streamable HTTP.
    const { app } = await harness();
    expect((await app.request('/sse')).status).toBe(401);
    expect((await app.request('/messages', { method: 'POST' })).status).toBe(401);

    const tokens = await fullFlow(app);
    const headers = { authorization: `Bearer ${tokens.access_token}` };
    expect((await app.request('/sse', { headers })).status).toBe(200);
    expect((await app.request('/messages', { method: 'POST', headers })).status).toBe(200);
  });

  test('a made-up token is refused', async () => {
    const { app } = await harness();
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status).toBe(401);
  });

  test('a refresh token cannot be used as an access token', async () => {
    const { app } = await harness();
    const tokens = await fullFlow(app);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.refresh_token}` },
    });
    expect(res.status).toBe(401);
  });

  test('an expired access token is refused', async () => {
    const { app, clock } = await harness();
    const tokens = await fullFlow(app);
    clock.value += 3601 * 1000;
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('configuration', () => {
  test('an explicit opt-out is reported as disabled', () => {
    const result = resolveAuthConfig({ AULA_MCP_AUTH_DISABLED: '1' } as NodeJS.ProcessEnv);
    expect(result.disabled).toBe(true);
    expect(result.config).toBeNull();
  });

  test('half a configuration is an error, not a silent no-auth', () => {
    const result = resolveAuthConfig({
      AULA_MCP_AUTH_PASSWORD_HASH: 'hash',
    } as NodeJS.ProcessEnv);
    expect(result.config).toBeNull();
    expect(result.problem).toContain('AULA_MCP_PUBLIC_URL');
  });

  test('the other half-configuration is an error too', () => {
    const result = resolveAuthConfig({
      AULA_MCP_PUBLIC_URL: 'https://example.test',
    } as NodeJS.ProcessEnv);
    expect(result.config).toBeNull();
    expect(result.problem).toContain('AULA_MCP_AUTH_PASSWORD_HASH');
  });

  test('a complete configuration resolves', () => {
    const result = resolveAuthConfig({
      AULA_MCP_AUTH_PASSWORD_HASH: 'hash',
      AULA_MCP_PUBLIC_URL: 'https://example.test/aula/',
    } as NodeJS.ProcessEnv);
    expect(result.config).toEqual({ publicUrl: 'https://example.test/aula', passwordHash: 'hash' });
  });

  test('a non-https public URL is refused unless it is loopback', () => {
    expect(normalizeBaseUrl('http://localhost:7878')).toBe('http://localhost:7878');
    expect(() => normalizeBaseUrl('http://example.test')).toThrow(/https/);
  });
});

describe('secure-by-default gate', () => {
  const configured = { config: { publicUrl: PUBLIC_URL, passwordHash: 'h' }, disabled: false };

  test('loopback runs without auth', () => {
    let fatal = '';
    assertRemoteAuthConfigured({
      allowRemote: false,
      auth: { config: null, disabled: false },
      onFatal: ((m: string) => {
        fatal = m;
        return undefined as never;
      }) as (m: string) => never,
    });
    expect(fatal).toBe('');
  });

  test('remote without auth refuses to start', () => {
    let fatal = '';
    assertRemoteAuthConfigured({
      allowRemote: true,
      auth: { config: null, disabled: false },
      onFatal: ((m: string) => {
        fatal = m;
        return undefined as never;
      }) as (m: string) => never,
    });
    expect(fatal).toContain('Refusing to start');
    expect(fatal).toContain('aula auth set-password');
  });

  test('remote with auth starts', () => {
    let fatal = '';
    assertRemoteAuthConfigured({
      allowRemote: true,
      auth: configured,
      onFatal: ((m: string) => {
        fatal = m;
        return undefined as never;
      }) as (m: string) => never,
    });
    expect(fatal).toBe('');
  });

  test('remote with an explicit opt-out starts but warns', () => {
    let fatal = '';
    const warnings: string[] = [];
    assertRemoteAuthConfigured({
      allowRemote: true,
      auth: { config: null, disabled: true },
      onFatal: ((m: string) => {
        fatal = m;
        return undefined as never;
      }) as (m: string) => never,
      logger: {
        debug() {},
        info() {},
        warn: (m: string) => warnings.push(m),
        error() {},
      },
    });
    expect(fatal).toBe('');
    expect(warnings).toContain('mcp-auth.disabled_with_remote');
  });
});

describe('FileAuthStore — the store production actually uses', () => {
  async function tempFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'aula-mcp-auth-'));
    return join(dir, 'mcp-auth.json');
  }

  test('a missing file loads as empty state rather than throwing', async () => {
    const store = new FileAuthStore(await tempFile());
    expect(await store.load()).toEqual(emptyAuthState());
  });

  test('save then load round-trips', async () => {
    const path = await tempFile();
    const store = new FileAuthStore(path);
    const state = emptyAuthState();
    state.clients.push({
      client_id: 'abc',
      redirect_uris: ['https://claude.ai/cb'],
      created_at: 1,
      last_used_at: 2,
    });
    state.tokens.push({
      token_hash: 'deadbeef',
      client_id: 'abc',
      kind: 'access',
      expires_at: 99,
    });
    await store.save(state);
    expect(await new FileAuthStore(path).load()).toEqual(state);
  });

  test('the persisted file contains no recoverable secret', async () => {
    const path = await tempFile();
    const store = new FileAuthStore(path);
    const state = emptyAuthState();
    state.tokens.push({
      token_hash: hashToken('super-secret-token'),
      client_id: 'abc',
      kind: 'access',
      expires_at: 99,
    });
    await store.save(state);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('super-secret-token');
    expect(raw).toContain(hashToken('super-secret-token'));
  });

  test('a corrupt file falls back to empty state instead of bricking the server', async () => {
    const path = await tempFile();
    await writeFile(path, '{ this is not json', 'utf8');
    const errors: string[] = [];
    const store = new FileAuthStore(path, {
      debug() {},
      info() {},
      warn() {},
      error: (m: string) => errors.push(m),
    });
    expect(await store.load()).toEqual(emptyAuthState());
    expect(errors).toContain('mcp-auth.state.parse_failed');
  });
});

describe('revocation', () => {
  async function tempFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'aula-mcp-revoke-'));
    return join(dir, 'mcp-auth.json');
  }

  test('revoking drops issued tokens but keeps client registrations', async () => {
    const store = new MemoryAuthStore();
    const { app } = await harness({ store });
    await fullFlow(app);

    const summary = await revokeAuthState(store);
    expect(summary.tokens_revoked).toBe(2); // one access, one refresh
    expect(summary.clients_removed).toBe(0);

    const state = await store.load();
    expect(state.tokens).toHaveLength(0);
    expect(state.clients).toHaveLength(1);
  });

  test('--clients also removes the registrations', async () => {
    const store = new MemoryAuthStore();
    const { app } = await harness({ store });
    await fullFlow(app);

    const summary = await revokeAuthState(store, { includeClients: true });
    expect(summary.clients_removed).toBe(1);
    expect((await store.load()).clients).toHaveLength(0);
  });

  test('revoking a store that was never written is a no-op, not a crash', async () => {
    const store = new FileAuthStore(await tempFile());
    expect(await revokeAuthState(store)).toEqual({ tokens_revoked: 0, clients_removed: 0 });
  });

  // The point of the whole mechanism: the CLI edits the file while the server
  // is up, and the server must honour that. Without the per-request revision
  // check, `aula auth revoke` would report success and change nothing — the
  // state is read once at boot and held in memory from then on.
  test('a revoke against a RUNNING server cuts off access without a restart', async () => {
    const path = await tempFile();
    const { app } = await harness({ store: new FileAuthStore(path) });
    const tokens = await fullFlow(app);
    expect((await callMcp(app, tokens.access_token)).status).toBe(200);

    // A separate process — exactly what the CLI is.
    await revokeAuthState(new FileAuthStore(path));

    expect((await callMcp(app, tokens.access_token)).status).toBe(401);
  });

  test('a revoke is not silently undone by the server persisting over it', async () => {
    const path = await tempFile();
    const { app } = await harness({ store: new FileAuthStore(path) });
    const tokens = await fullFlow(app);
    await revokeAuthState(new FileAuthStore(path));

    // Any later write-through — here a fresh registration — must build on the
    // revoked state, not on the copy the server had in memory beforehand.
    await registerClient(app, ['https://claude.ai/second']);

    const onDisk = await new FileAuthStore(path).load();
    expect(onDisk.tokens).toHaveLength(0);
    const refreshed = await refreshToken(app, tokens.refresh_token);
    expect(refreshed.status).toBe(400);
  });

  test('an authorization code minted before a revoke cannot still be redeemed', async () => {
    const path = await tempFile();
    const { app } = await harness({ store: new FileAuthStore(path) });
    const clientId = await registerClient(app);
    const pkce = generatePkce();
    const res = await submitPassword(app, clientId, pkce.challenge, PASSWORD);
    const code = new URL(res.headers.get('location') ?? '').searchParams.get('code') ?? '';

    await revokeAuthState(new FileAuthStore(path));

    const tokenRes = await app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(400);
  });

  // Changing the password has to mean something. Tokens issued under the old
  // one would otherwise outlive it, so `set-password` + restart would look
  // like a lockout while being none.
  test('restarting with a changed password hash revokes the old tokens', async () => {
    const path = await tempFile();
    const first = await harness({ store: new FileAuthStore(path) });
    const tokens = await fullFlow(first.app);
    expect((await callMcp(first.app, tokens.access_token)).status).toBe(200);

    const newHash = await Bun.password.hash('a-different-password', {
      algorithm: 'bcrypt',
      cost: 4,
    });
    const restarted = await harness({ store: new FileAuthStore(path), hash: newHash });

    expect((await callMcp(restarted.app, tokens.access_token)).status).toBe(401);
    expect((await refreshToken(restarted.app, tokens.refresh_token)).status).toBe(400);
    // The connector itself survives — it just has to sign in again.
    expect((await new FileAuthStore(path).load()).clients).toHaveLength(1);
  });

  test('restarting with the SAME password leaves working sessions alone', async () => {
    const path = await tempFile();
    const first = await harness({ store: new FileAuthStore(path) });
    const tokens = await fullFlow(first.app);

    const restarted = await harness({ store: new FileAuthStore(path) });
    expect((await callMcp(restarted.app, tokens.access_token)).status).toBe(200);
  });

  test('the fingerprint stored on disk is not the password hash itself', async () => {
    const path = await tempFile();
    const { app } = await harness({ store: new FileAuthStore(path) });
    await fullFlow(app);

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain(passwordHash);
    expect(raw).not.toContain(PASSWORD);
    expect(raw).toContain(hashToken(passwordHash));
  });
});

describe('PKCE helper reuse', () => {
  test('challengeFromVerifier matches the generated pair', () => {
    const pkce = generatePkce();
    expect(challengeFromVerifier(pkce.verifier)).toBe(pkce.challenge);
  });
});
