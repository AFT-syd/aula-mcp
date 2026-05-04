import { describe, expect, test } from 'bun:test';
import type { AulaTokens } from '@aula-mcp/aula-auth';
import { AulaClient } from './aula-client.ts';
import { AulaApiVersionError, AulaStepUpRequiredError } from './errors.ts';
import { FakeHttp } from './test-helpers.ts';

const TOKENS: AulaTokens = {
  access_token: 'TEST_AT',
  refresh_token: 'TEST_RT',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  obtained_at: Math.floor(Date.now() / 1000),
};

function envelope<T>(data: T, code = 0): string {
  return JSON.stringify({ status: { code, message: 'OK' }, data });
}

function makeClient(
  http: FakeHttp,
  opts: Partial<{ initialApiVersion: number; maxApiVersion: number }> = {},
) {
  return new AulaClient({
    tokens: TOKENS,
    http: http.asHttpClient(),
    ...(opts.initialApiVersion !== undefined ? { initialApiVersion: opts.initialApiVersion } : {}),
    ...(opts.maxApiVersion !== undefined ? { maxApiVersion: opts.maxApiVersion } : {}),
  });
}

describe('AulaClient.ensureApiVersion', () => {
  test('returns the initial version when v22 already works', async () => {
    const http = new FakeHttp();
    http.enqueue({ status: 200, body: envelope({ profiles: [] }) });
    const c = makeClient(http);
    await expect(c.ensureApiVersion()).resolves.toBe(22);
  });

  test('bumps past 410 responses until it finds a working version', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 410, body: '' },
      { status: 410, body: '' },
      { status: 200, body: envelope({ profiles: [] }) },
    );
    const c = makeClient(http, { initialApiVersion: 22 });
    const v = await c.ensureApiVersion();
    expect(v).toBe(24);
    expect(c.currentApiVersion).toBe(24);
  });

  test('fires onApiVersionChanged callback on bump', async () => {
    const http = new FakeHttp();
    http.enqueue({ status: 410, body: '' }, { status: 200, body: envelope({ profiles: [] }) });
    const calls: Array<[number, number]> = [];
    const c = new AulaClient({
      tokens: TOKENS,
      http: http.asHttpClient(),
      onApiVersionChanged: (from, to) => calls.push([from, to]),
    });
    await c.ensureApiVersion();
    expect(calls).toEqual([[22, 23]]);
  });

  test('throws AulaApiVersionError when nothing in range works', async () => {
    const http = new FakeHttp();
    for (let i = 0; i <= 3; i++) http.enqueue({ status: 410, body: '' });
    const c = makeClient(http, { initialApiVersion: 22, maxApiVersion: 25 });
    await expect(c.ensureApiVersion()).rejects.toBeInstanceOf(AulaApiVersionError);
  });

  test('caches the verified version (no re-probe on next call)', async () => {
    const http = new FakeHttp();
    http.enqueue({ status: 200, body: envelope({ profiles: [] }) });
    const c = makeClient(http);
    await c.ensureApiVersion();
    await c.ensureApiVersion();
    // Only one probe request — no extra queued, so a second probe would throw.
    expect(http.requested.length).toBe(1);
  });
});

describe('AulaClient API method wrappers', () => {
  test('getProfilesByLogin sends access_token + method as query params', async () => {
    const http = new FakeHttp();
    // ensureApiVersion probes via profiles.getProfilesByLogin, then the
    // wrapper makes its own call — two requests in total.
    http.enqueue(
      { status: 200, body: envelope({ profiles: [] }) }, // probe
      { status: 200, body: envelope({ profiles: [{ id: 1, name: 'Casper' }] }) }, // actual call
    );
    const c = makeClient(http);
    const data = await c.getProfilesByLogin();
    expect(data.profiles?.[0]?.name).toBe('Casper');
    expect(http.requested[1]?.url).toMatch(/method=profiles\.getProfilesByLogin/);
    expect(http.requested[1]?.url).toMatch(/access_token=TEST_AT/);
  });

  test('getDailyOverview repeats childIds[] for each id', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope([]) }, // probe
      { status: 200, body: envelope([{ status: 1 }]) }, // actual call
    );
    const c = makeClient(http);
    await c.getDailyOverview([10, 20]);
    const url = http.requested[1]?.url ?? '';
    expect(url).toContain('childIds%5B%5D=10');
    expect(url).toContain('childIds%5B%5D=20');
  });

  test('getDailyOverview returns [] when given no ids without hitting the network', async () => {
    const http = new FakeHttp();
    const c = makeClient(http);
    await expect(c.getDailyOverview([])).resolves.toEqual([]);
    expect(http.requested.length).toBe(0);
  });

  test('postJson includes csrfp-token header from cookie jar', async () => {
    const http = new FakeHttp();
    http.setCookie('Csrfp-Token', 'CSRF-XYZ');
    http.enqueue(
      { status: 200, body: envelope([]) }, // probe
      { status: 200, body: envelope([]) }, // post
    );
    const c = makeClient(http);
    await c.getCalendarEvents({ profileIds: [1], start: 'a', end: 'b' });
    const post = http.requested[1];
    expect(post?.method).toBe('POST');
    expect(post?.headers?.['csrfp-token']).toBe('CSRF-XYZ');
  });
});

describe('AulaClient envelope handling', () => {
  test('mid-session 410 retries the call after re-probing', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope([]) }, // probe v22 ok
      { status: 410, body: '' }, // first real call → bumped
      { status: 200, body: envelope([{ status: 1 }]) }, // re-probe v23 ok
      { status: 200, body: envelope([{ status: 1 }]) }, // retried call
    );
    const c = makeClient(http);
    await c.ensureApiVersion(); // probe runs once
    const out = await c.getDailyOverview([10]);
    expect(out).toEqual([{ status: 1 } as never]);
    expect(c.currentApiVersion).toBe(23);
  });

  test('non-zero status.code throws AulaApiError', async () => {
    const http = new FakeHttp();
    http.enqueue(
      { status: 200, body: envelope([]) }, // probe
      { status: 200, body: JSON.stringify({ status: { code: 99, message: 'broke' } }) },
    );
    const c = makeClient(http);
    await expect(c.getDailyOverview([1])).rejects.toThrow(/broke/);
  });
});

describe('AulaClient.getMessagesForThread step-up', () => {
  // getMessagesForThread doesn't call ensureApiVersion (it uses
  // this.apiVersion directly), so these tests queue exactly one response.

  test('throws AulaStepUpRequiredError on status.code 403', async () => {
    const http = new FakeHttp();
    http.enqueue({
      status: 200,
      body: JSON.stringify({
        status: { code: 403, message: 'sensitive thread requires step-up' },
      }),
    });
    const c = makeClient(http);
    await expect(c.getMessagesForThread(123)).rejects.toBeInstanceOf(AulaStepUpRequiredError);
  });

  test('returns subject + messages when status is OK', async () => {
    const http = new FakeHttp();
    http.enqueue({
      status: 200,
      body: envelope({
        subject: 'Skoleudflugt',
        messages: [{ text: { plain: 'hej' }, sender: { fullName: 'Anders' } }],
      }),
    });
    const c = makeClient(http);
    const out = await c.getMessagesForThread(123);
    expect(out.subject).toBe('Skoleudflugt');
    expect(out.messages[0]?.sender?.fullName).toBe('Anders');
  });
});
