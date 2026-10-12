/**
 * Unit tests for AulaContext's own caching/wiring logic — as opposed to
 * tools.test.ts / server.test.ts / discover.test.ts, which fake out the
 * whole AulaContext and never exercise this class's real code.
 *
 * Every AulaContext here is built with `store: new MemoryTokenStore()`.
 * That is NOT incidental: AulaContext's constructor calls watchTokenFile(),
 * which duck-types on `store.filePath` to decide whether to fs.watch a real
 * file. The *default* store (when no `store` option is given) resolves to
 * `~/.config/aula-mcp/tokens.json` — the real production config path this
 * task was explicitly told never to touch. MemoryTokenStore has no
 * `filePath`, so watchTokenFile() bails out immediately and no real
 * filesystem path is ever touched by these tests.
 */

import { describe, expect, test } from 'bun:test';
import { MemoryTokenStore, noopTracer, silentLogger, type WireTracer } from '@aula-mcp/aula-auth';
import type { AulaClient, ProfilesByLoginData, WidgetTokenManager } from '@aula-mcp/aula-client';
import { AulaContext } from './aula-context.ts';

/** Tabulex's own base URL — the jar is domain-scoped, so a cookie assertion
 *  has to use the host the session actually belongs to. */
const TABULEX_URL = 'https://foraeldre.tabulex.net/';

function fakeProfiles(tag: string): ProfilesByLoginData {
  return { profiles: [{ profileId: 1, displayName: tag, children: [] }] };
}

/** A real AulaContext with getClient() swapped for a counting fake, so the
 *  caching logic under test is AulaContext's own, not a stand-in's. */
function contextWithCountingClient(): { context: AulaContext; calls: () => number } {
  const context = new AulaContext({ store: new MemoryTokenStore(), logger: silentLogger });
  let callCount = 0;
  const fakeClient = {
    async getProfilesByLogin() {
      callCount++;
      return fakeProfiles(`call-${callCount}`);
    },
  } as unknown as AulaClient;
  // getClient is a plain (non-readonly) instance method — reassigning it on
  // the instance shadows the prototype implementation for this object only.
  context.getClient = async () => fakeClient;
  return { context, calls: () => callCount };
}

describe('AulaContext — a stale Tabulex session is dropped on invalidate', () => {
  /** A real AulaContext with only getWidgetManager() faked, so getTabulex()
   *  runs its own code against the real shared cookie jar. */
  function contextForTabulex(): AulaContext {
    const context = new AulaContext({ store: new MemoryTokenStore(), logger: silentLogger });
    context.getWidgetManager = async () => ({}) as unknown as WidgetTokenManager;
    return context;
  }

  async function seedFedAuth(context: AulaContext): Promise<void> {
    const headers = new Headers();
    headers.append('set-cookie', 'FedAuth=previous-login-session');
    await context.http.jar.storeFromResponse(headers, TABULEX_URL);
  }

  test('getTabulex() leaves the session alone when nothing was invalidated', async () => {
    const context = contextForTabulex();
    await seedFedAuth(context);
    await context.getTabulex();
    // The whole point of reusing the session is that it survives across
    // getTabulex() calls — clearing it here would reinstate the 27-call
    // handshake storm.
    expect(await context.http.jar.getCookieValue(TABULEX_URL, 'FedAuth')).toBe(
      'previous-login-session',
    );
  });

  test('invalidate() makes the next getTabulex() drop the previous session', async () => {
    const context = contextForTabulex();
    await seedFedAuth(context);

    context.invalidate();
    await context.getTabulex();

    // Without this, a token switch left the previous login's FedAuth in the
    // shared jar, and the new guardian's first Fravær call would adopt it
    // and read the previous guardian's children.
    expect(await context.http.jar.getCookieValue(TABULEX_URL, 'FedAuth')).toBeUndefined();
  });

  test('the clear happens once, not on every later getTabulex()', async () => {
    const context = contextForTabulex();
    context.invalidate();
    await context.getTabulex();
    await seedFedAuth(context);
    await context.getTabulex();
    expect(await context.http.jar.getCookieValue(TABULEX_URL, 'FedAuth')).toBe(
      'previous-login-session',
    );
  });
});

describe('AulaContext.getProfilesByLogin — caching', () => {
  test('a second call reuses the first result instead of refetching', async () => {
    const { context, calls } = contextWithCountingClient();
    const first = await context.getProfilesByLogin();
    const second = await context.getProfilesByLogin();
    expect(calls()).toBe(1);
    expect(second.profiles?.[0]?.displayName).toBe(first.profiles?.[0]?.displayName);
  });

  test('forceRefresh bypasses the cache — aula.discover must always see current data', async () => {
    const { context, calls } = contextWithCountingClient();
    await context.getProfilesByLogin();
    await context.getProfilesByLogin({ forceRefresh: true });
    expect(calls()).toBe(2);
  });

  test('invalidate() drops the cached profiles — a token switch must not serve stale children', async () => {
    const { context, calls } = contextWithCountingClient();
    await context.getProfilesByLogin();
    context.invalidate();
    await context.getProfilesByLogin();
    expect(calls()).toBe(2);
  });

  test('concurrent callers before the first resolves share one fetch', async () => {
    const { context, calls } = contextWithCountingClient();
    const [a, b] = await Promise.all([context.getProfilesByLogin(), context.getProfilesByLogin()]);
    expect(calls()).toBe(1);
    expect(a).toBe(b);
  });
});

describe('AulaContext.getGuardianUserId — primes once per client, not once per context', () => {
  /** getClient() returns whichever fake `current` points at — a token
   *  refresh is a new client, exactly as getClient() does on expiry. */
  function contextWithSwappableClient() {
    const context = new AulaContext({ store: new MemoryTokenStore(), logger: silentLogger });
    const primed: string[] = [];
    const makeClient = (tag: string) =>
      ({
        async getProfileContext() {
          primed.push(tag);
          return { userId: 4242 };
        },
      }) as unknown as AulaClient;
    let current = makeClient('first');
    context.getClient = async () => current;
    return {
      context,
      primed,
      refresh: (tag: string) => {
        current = makeClient(tag);
      },
    };
  }

  test('the same client is primed once', async () => {
    const { context, primed } = contextWithSwappableClient();
    expect(await context.getGuardianUserId()).toBe('4242');
    expect(await context.getGuardianUserId()).toBe('4242');
    expect(primed).toEqual(['first']);
  });

  test('a new client after a token refresh is primed again', async () => {
    // The live 403 of 2026-10-11: the cached id outlived the client it was
    // fetched with, so messaging ran on a token whose profile was never
    // activated.
    const { context, primed, refresh } = contextWithSwappableClient();
    await context.getGuardianUserId();
    refresh('after-refresh');
    await context.getGuardianUserId();
    expect(primed).toEqual(['first', 'after-refresh']);
  });

  test('invalidate() drops the cache too', async () => {
    const { context, primed } = contextWithSwappableClient();
    await context.getGuardianUserId();
    context.invalidate();
    await context.getGuardianUserId();
    expect(primed).toEqual(['first', 'first']);
  });
});

describe('AulaContext — tracer pass-through to the shared AulaHttpClient', () => {
  test('a tracer passed at construction reaches every integration via context.http', () => {
    const tracer: WireTracer = { record() {} };
    const context = new AulaContext({ store: new MemoryTokenStore(), tracer });
    expect(context.http.tracer).toBe(tracer);
  });

  test('without a tracer option, the shared client keeps its own noop default', () => {
    const context = new AulaContext({ store: new MemoryTokenStore() });
    expect(context.http.tracer).toBe(noopTracer);
  });
});
