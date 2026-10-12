/**
 * Tests for TabulexClient — the one integration in this package whose auth
 * is a multi-hop WS-Federation handshake rather than a per-call Bearer
 * token. Drives the fake HTTP client through the same shape of chain
 * captured from the real account: an initial form POST, one intermediate
 * "200 with an auto-post form" hop, and a landing response that sets the
 * FedAuth cookie.
 *
 * No real CPR, cookie value, or session id appears anywhere in this file —
 * every value below is a test fixture invented for this suite.
 */

import { describe, expect, test } from 'bun:test';
import { FakeHttp } from '../test-helpers.ts';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { TabulexClient } from './tabulex.ts';
import type { IntegrationContext } from './types.ts';
import { isoWeekString } from './types.ts';

// Generic placeholder identifiers, matching integrations.test.ts's own ctx()
// convention (sessionId 'cj', numeric guardianId '5000', childIds
// [1234567], institutionCodes ['G12345']) — never a real account's values.
function ctx(overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  return {
    isoWeek: isoWeekString(new Date('2026-09-01T08:00:00Z')),
    sessionId: 'cj',
    guardianId: '5000',
    childIds: [1234567],
    childUserIds: ['u1234567'],
    institutionCodes: ['G12345'],
    ...overrides,
  };
}

function fakeWidgets(token: string = 'WIDGET-TKN'): WidgetTokenManager & { refreshCalls: number } {
  const manager = {
    refreshCalls: 0,
    async get() {
      return token;
    },
    async refresh() {
      manager.refreshCalls++;
      return token;
    },
    invalidate() {},
    invalidateAll() {},
    async withRetry<T>(_widgetId: string, fn: (t: string) => Promise<T>) {
      return fn(token);
    },
  };
  return manager as unknown as WidgetTokenManager & { refreshCalls: number };
}

/** The intermediate hop: a 200 HTML page with an auto-post form carrying the
 *  WS-Federation result onward — the `postResponse.js` pattern. Not on
 *  foraeldre.tabulex.net yet, so TabulexClient must detect and resubmit it. */
const AUTO_POST_FORM_HOP = {
  status: 200,
  body:
    '<html><body onload="document.forms[0].submit()">' +
    '<form method="post" action="https://foraeldre.tabulex.net/wsfed-acs">' +
    '<input type="hidden" name="wresult" value="FAKE-WRESULT">' +
    '</form></body></html>',
};

/** Final landing hop on foraeldre.tabulex.net — sets the FedAuth cookie. */
const LANDING_HOP_WITH_FEDAUTH = {
  status: 200,
  body: '<html><body>ok</body></html>',
  headers: { 'set-cookie': 'FedAuth=fake-fedauth-value' },
};

/** A plain 302 straight to foraeldre.tabulex.net (no intermediate form —
 *  the simpler of the two real shapes the chain can take). */
const REDIRECT_TO_TABULEX = {
  status: 302,
  body: '',
  headers: { location: 'https://foraeldre.tabulex.net/' },
};

/** Landed on foraeldre.tabulex.net, but the handshake failed upstream and no
 *  FedAuth cookie was actually issued (used for the failure-path test). */
const LANDING_HOP_WITHOUT_FEDAUTH = {
  status: 200,
  body: '<html><body>landed, but something went wrong upstream</body></html>',
};

describe('TabulexClient — SSO handshake', () => {
  test('getPersonsAdgangTilBoern runs the handshake once then GETs the API', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-1');
    http.setCookie('XSRF-TOKEN', 'XSRF-1');
    http
      .enqueue(AUTO_POST_FORM_HOP)
      .enqueue(LANDING_HOP_WITH_FEDAUTH)
      .enqueue({
        status: 200,
        body: JSON.stringify([
          {
            Fornavn: 'Barn',
            Efternavn: 'Testesen',
            Cpr: '0101209999',
            Klasse: '3A',
            SkoleNavn: 'Testskolen',
            SkoleKode: 'T1',
            SkoleFravaerAdgang: true,
            SkoleBestyrelsesValgAdgang: false,
            Pige: false,
          },
        ]),
      });

    const client = new TabulexClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const result = await client.getPersonsAdgangTilBoern(ctx());

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fornavn: 'Barn',
      efternavn: 'Testesen',
      cpr: '0101209999',
      klasse: '3A',
      skoleFravaerAdgang: true,
    });

    // Hop 1: the widget SSO form POST to the SimpleSAML module.
    expect(http.requested[0]?.url).toContain('saml.borger.tabulex.dk');
    expect(http.requested[0]?.method).toBe('POST');
    const hop1Body = http.requested[0]?.body as URLSearchParams;
    expect(hop1Body.get('aulaToken')).toBe('WIDGET-TKN');
    expect(hop1Body.get('sessionUUID')).toBe('5000');
    expect(hop1Body.get('childFilter')).toBe('u1234567');
    expect(hop1Body.get('institutionFilter')).toBe('G12345');
    expect(hop1Body.get('Csrfp-Token')).toBe('CSRF-1');

    // Hop 2: the auto-post form resubmitted verbatim to its own action.
    expect(http.requested[1]?.url).toBe('https://foraeldre.tabulex.net/wsfed-acs');
    const hop2Body = http.requested[1]?.body as URLSearchParams;
    expect(hop2Body.get('wresult')).toBe('FAKE-WRESULT');

    // Hop 3: the actual API GET, with the mirrored XSRF header.
    expect(http.requested[2]?.url).toBe('https://foraeldre.tabulex.net/api/PersonsAdgangTilBoern');
    expect(http.requested[2]?.headers?.['x-xsrf-token']).toBe('XSRF-1');
  });

  test('a second call reuses the established session (no repeat handshake)', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-1');
    http.setCookie('XSRF-TOKEN', 'XSRF-1');
    http
      .enqueue(AUTO_POST_FORM_HOP)
      .enqueue(LANDING_HOP_WITH_FEDAUTH)
      .enqueue({ status: 200, body: '[]' })
      .enqueue({ status: 200, body: '{"ok":true}' });

    const client = new TabulexClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await client.getPersonsAdgangTilBoern(ctx());
    expect(http.requested).toHaveLength(3);

    await client.getFravaerIdag(ctx(), '0101209999');
    // Only one more request — no repeat of the 2-hop handshake.
    expect(http.requested).toHaveLength(4);
    expect(http.requested[3]?.url).toBe(
      'https://foraeldre.tabulex.net/api/Fravaer/Idag/0101209999',
    );
  });

  test('a FedAuth cookie already in the shared jar skips the handshake for a brand-new client instance', async () => {
    // Mirrors what the live test measured 2026-10-02: AulaContext.getTabulex()
    // hands out a fresh TabulexClient per call (sessionEstablished starts
    // false on each one), while the cookie jar — shared via the same
    // AulaHttpClient instance across every TabulexClient built against it —
    // already carries FedAuth from an earlier call. 4 tool calls measured as
    // 27 HTTP requests because the old ensureSession() only ever checked its
    // own in-memory flag, never the jar.
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-1');
    http.setCookie('XSRF-TOKEN', 'XSRF-1');
    http.setCookie('FedAuth', 'already-established-value');
    // Only the actual API call is queued — no SSO hops at all. If
    // ensureSession() still runs the handshake, FakeHttp throws "no response
    // queued" for the first (SSO-start) request.
    http.enqueue({ status: 200, body: '[]' });

    const freshClient = new TabulexClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await freshClient.getPersonsAdgangTilBoern(ctx());

    expect(http.requested).toHaveLength(1);
    expect(http.requested[0]?.url).toBe('https://foraeldre.tabulex.net/api/PersonsAdgangTilBoern');
  });

  test('a session adopted from the jar but dead server-side is re-established and the call retried', async () => {
    // The other half of reusing the session. Checking the jar stops the needless
    // handshakes, but a FedAuth cookie has no client-visible expiry, so the
    // jar keeps handing out a cookie Tabulex may already have forgotten.
    // Without the retry, ensureSession()'s early return meant the handshake
    // never ran again for the lifetime of the process — and this server runs
    // for days — so a dead session wedged until restart.
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-1');
    http.setCookie('XSRF-TOKEN', 'XSRF-1');
    http.setCookie('FedAuth', 'stale-value-tabulex-has-forgotten');
    http
      // The adopted session is refused...
      .enqueue({ status: 401, body: '<html><body>sign in</body></html>' })
      // ...so the client must clear it and run the handshake for real.
      .enqueue(AUTO_POST_FORM_HOP)
      .enqueue(LANDING_HOP_WITH_FEDAUTH)
      .enqueue({ status: 200, body: '[]' });

    const client = new TabulexClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    const result = await client.getPersonsAdgangTilBoern(ctx());

    expect(result).toEqual([]);
    expect(http.requested).toHaveLength(4);
    expect(http.requested[0]?.url).toBe('https://foraeldre.tabulex.net/api/PersonsAdgangTilBoern');
    expect(http.requested[1]?.url).toContain('saml.borger.tabulex.dk');
    expect(http.requested[3]?.url).toBe('https://foraeldre.tabulex.net/api/PersonsAdgangTilBoern');
    // The stale cookie was actually removed, not merely overwritten — that
    // removal is what makes the re-handshake possible.
    expect(await http.jar.getCookieValue('https://foraeldre.tabulex.net', 'FedAuth')).toBe(
      'fake-fedauth-value',
    );
  });

  test('a freshly established session is NOT retried — a real failure must not double the IdP load', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-1');
    http.setCookie('XSRF-TOKEN', 'XSRF-1');
    http.enqueue(AUTO_POST_FORM_HOP).enqueue(LANDING_HOP_WITH_FEDAUTH).enqueue({
      status: 500,
      body: 'upstream exploded',
    });

    const client = new TabulexClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await expect(client.getPersonsAdgangTilBoern(ctx())).rejects.toThrow(/status 500/);
    // 3 requests: two handshake hops + the one failed API call. No second
    // handshake, no second API call.
    expect(http.requested).toHaveLength(3);
  });

  test('reportSick is never retried — re-sending a write Tabulex cannot undo is worse than the error', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-1');
    http.setCookie('XSRF-TOKEN', 'XSRF-1');
    http.setCookie('FedAuth', 'stale-value-tabulex-has-forgotten');
    http.enqueue({ status: 401, body: '<html><body>sign in</body></html>' });

    const client = new TabulexClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await expect(client.reportSick(ctx(), '0101209999', 'today')).rejects.toThrow(/status 401/);
    // Exactly one request: the PUT. A retry here could land the same
    // irreversible sick report twice.
    expect(http.requested).toHaveLength(1);
    expect(http.requested[0]?.method).toBe('PUT');
  });

  test('reportSick PUTs the CPR-only body to the right MeldSyg endpoint', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-1');
    http.setCookie('XSRF-TOKEN', 'XSRF-1');
    http
      .enqueue(AUTO_POST_FORM_HOP)
      .enqueue(LANDING_HOP_WITH_FEDAUTH)
      .enqueue({ status: 200, body: '{"ok":true}' });

    const client = new TabulexClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    await client.reportSick(ctx(), '0101209999', 'today');

    const putReq = http.requested[2];
    expect(putReq?.url).toBe('https://foraeldre.tabulex.net/api/Fravaer/MeldSygIdag/');
    expect(putReq?.method).toBe('PUT');
    expect(putReq?.body).toBe(JSON.stringify({ Cpr: '0101209999' }));
    expect(putReq?.headers?.['content-type']).toBe('application/json;charset=UTF-8');
    expect(putReq?.headers?.origin).toBe('https://foraeldre.tabulex.net');

    const putTomorrow = new FakeHttp();
    putTomorrow.setCookie('Csrfp-Token', 'CSRF-1');
    putTomorrow.setCookie('XSRF-TOKEN', 'XSRF-1');
    putTomorrow
      .enqueue(AUTO_POST_FORM_HOP)
      .enqueue(LANDING_HOP_WITH_FEDAUTH)
      .enqueue({ status: 200, body: '{"ok":true}' });
    const clientTomorrow = new TabulexClient({
      http: putTomorrow.asHttpClient(),
      widgets: fakeWidgets(),
    });
    await clientTomorrow.reportSick(ctx(), '0101209999', 'tomorrow');
    expect(putTomorrow.requested[2]?.url).toBe(
      'https://foraeldre.tabulex.net/api/Fravaer/MeldSygImorgen/',
    );
  });

  test('throws TabulexSessionError when no FedAuth cookie appears, after one refresh+retry', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-1');
    // Two full handshake attempts (redirect + landing, 2 requests each),
    // neither ever lands with a FedAuth cookie.
    http
      .enqueue(REDIRECT_TO_TABULEX)
      .enqueue(LANDING_HOP_WITHOUT_FEDAUTH)
      .enqueue(REDIRECT_TO_TABULEX)
      .enqueue(LANDING_HOP_WITHOUT_FEDAUTH);

    const widgets = fakeWidgets();
    const client = new TabulexClient({ http: http.asHttpClient(), widgets });

    await expect(client.getPersonsAdgangTilBoern(ctx())).rejects.toThrow(/FedAuth session cookie/);
    expect(widgets.refreshCalls).toBe(1);
    expect(http.requested).toHaveLength(4);
  });

  test('throws TabulexSessionError immediately when a hop has no form to continue (no retry)', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-1');
    // The SSO-start POST itself comes back with a plain error page — not on
    // foraeldre.tabulex.net, and no hidden-input form to resubmit. Distinct
    // from the "no FedAuth cookie" failure above: this throws mid-handshake,
    // so it propagates immediately without the refresh+retry fallback.
    http.enqueue({ status: 200, body: '<html><body>Access denied</body></html>' });

    const widgets = fakeWidgets();
    const client = new TabulexClient({ http: http.asHttpClient(), widgets });

    await expect(client.getPersonsAdgangTilBoern(ctx())).rejects.toThrow(/no form to continue/);
    expect(widgets.refreshCalls).toBe(0);
    expect(http.requested).toHaveLength(1);
  });
});

describe('TabulexClient — CPR in failures', () => {
  test('a failed Fravær call does not put the CPR in the error message', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-1');
    http.setCookie('XSRF-TOKEN', 'XSRF-1');
    http
      .enqueue(AUTO_POST_FORM_HOP)
      .enqueue(LANDING_HOP_WITH_FEDAUTH)
      .enqueue({ status: 500, body: 'boom' });
    const client = new TabulexClient({ http: http.asHttpClient(), widgets: fakeWidgets() });
    let message = '';
    try {
      await client.getFravaerIdag(ctx(), '0101209999');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('status 500');
    expect(message).not.toContain('0101209999');
  });
});
