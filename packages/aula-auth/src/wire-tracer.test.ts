import { describe, expect, test } from 'bun:test';
import {
  formatTraceText,
  InMemoryTracer,
  sanitizeHeaders,
  sanitizeRequestBody,
  sanitizeResponseBody,
  type WireEntry,
} from './wire-tracer.ts';

describe('sanitizeHeaders', () => {
  test('redacts Cookie / Authorization / Set-Cookie / CSRF headers', () => {
    const out = sanitizeHeaders({
      cookie: 'a=b; sessionId=xyz',
      authorization: 'Bearer XYZ',
      'aula-authorization': 'Bearer XYZ',
      'csrfp-token': 'TOKEN',
      'user-agent': 'Mozilla',
    });
    expect(out.cookie).toMatch(/^<redacted/);
    expect(out.authorization).toMatch(/^<redacted/);
    expect(out['aula-authorization']).toMatch(/^<redacted/);
    expect(out['csrfp-token']).toMatch(/^<redacted/);
    expect(out['user-agent']).toBe('Mozilla');
  });

  test('accepts a Headers object', () => {
    const h = new Headers();
    h.set('Cookie', 'val');
    h.set('X-Custom', 'ok');
    const out = sanitizeHeaders(h);
    expect(out.cookie).toMatch(/^<redacted/);
    expect(out['x-custom']).toBe('ok');
  });
});

describe('sanitizeRequestBody', () => {
  test('redacts secret fields in form-urlencoded body', () => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'AUTHCODE',
      code_verifier: 'V',
      password: 'hunter2',
    });
    const out = sanitizeRequestBody(body);
    expect(out).toContain('grant_type=authorization_code');
    expect(out).toContain('code=%3Credacted');
    expect(out).toContain('password=%3Credacted');
    expect(out).toContain('code_verifier=V');
  });

  test('redacts secret fields in JSON body', () => {
    const json = JSON.stringify({
      randomA: { value: 'A_HEX' },
      m1: { value: 'M1_HEX' },
      flowValueProof: { value: 'PROOF' },
      keep_me: 'fine',
    });
    const out = sanitizeRequestBody(json);
    if (out == null) throw new Error('expected non-null');
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.randomA).toContain('redacted');
    expect(parsed.m1).toContain('redacted');
    expect(parsed.flowValueProof).toContain('redacted');
    expect(parsed.keep_me).toBe('fine');
  });

  test('binary body is summarised as length only', () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    expect(sanitizeRequestBody(buf)).toBe('<binary 4 bytes>');
  });

  test('returns null when body is undefined', () => {
    expect(sanitizeRequestBody(undefined)).toBeNull();
  });
});

describe('sanitizeResponseBody', () => {
  test('truncates long bodies and reports original size', () => {
    const big = 'x'.repeat(10_000);
    const out = sanitizeResponseBody(big, 100);
    expect(out.bytes).toBe(10_000);
    expect(out.text.length).toBeLessThanOrEqual(140);
    expect(out.text.endsWith('chars>')).toBe(true);
  });

  test('redacts SAMLResponse-shaped JSON keys', () => {
    const body = JSON.stringify({ access_token: 'AAA', refresh_token: 'RRR', expires_in: 60 });
    const out = sanitizeResponseBody(body);
    const parsed = JSON.parse(out.text) as Record<string, unknown>;
    expect(parsed.access_token).toContain('redacted');
    expect(parsed.refresh_token).toContain('redacted');
    expect(parsed.expires_in).toBe(60);
  });
});

describe('InMemoryTracer + formatTraceText', () => {
  test('captures entries and formats them as text', () => {
    const tracer = new InMemoryTracer();
    const entry: WireEntry = {
      ts: '2026-05-04T01:00:00Z',
      seq: 1,
      method: 'GET',
      url: 'https://example.com/x',
      requestHeaders: { accept: '*/*' },
      requestBody: null,
      status: 200,
      responseHeaders: { 'content-type': 'text/html' },
      responseBody: '<html>hi</html>',
      responseBodyBytes: 15,
      durationMs: 42,
    };
    tracer.record(entry);
    expect(tracer.entries).toHaveLength(1);
    const text = formatTraceText(tracer.entries);
    expect(text).toContain('GET https://example.com/x');
    expect(text).toContain('200 (42 ms, 15 bytes)');
    expect(text).toContain('<html>hi</html>');
  });
});
