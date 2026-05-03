import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { MitidError, parseAuxResponse } from './mitid-client.ts';

describe('parseAuxResponse', () => {
  function buildAuxBody(inner: unknown): string {
    const auxB64 = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');
    return JSON.stringify({ Aux: auxB64 });
  }

  test('decodes a well-formed Aux blob', () => {
    const body = buildAuxBody({
      coreClient: { checksum: Buffer.from('cafebabe', 'hex').toString('base64') },
      parameters: { authenticationSessionId: '11111111-2222-3333-4444-555555555555' },
    });
    const out = parseAuxResponse(body);
    expect(out.clientHash).toBe('cafebabe');
    expect(out.authenticationSessionId).toBe('11111111-2222-3333-4444-555555555555');
  });

  test('accepts already-parsed object form', () => {
    const auxB64 = Buffer.from(
      JSON.stringify({
        coreClient: { checksum: Buffer.from('00ff', 'hex').toString('base64') },
        parameters: { authenticationSessionId: 'abc' },
      }),
      'utf8',
    ).toString('base64');
    const out = parseAuxResponse({ Aux: auxB64 });
    expect(out.clientHash).toBe('00ff');
    expect(out.authenticationSessionId).toBe('abc');
  });

  test('throws when Aux missing', () => {
    expect(() => parseAuxResponse('{}')).toThrow(MitidError);
  });

  test('throws when Aux is not valid base64-JSON', () => {
    expect(() => parseAuxResponse(JSON.stringify({ Aux: 'not-base64-of-json' }))).toThrow(
      MitidError,
    );
  });

  test('throws when checksum or sessionId missing', () => {
    const body = buildAuxBody({ coreClient: {}, parameters: {} });
    expect(() => parseAuxResponse(body)).toThrow(MitidError);
  });
});
