import { describe, expect, test } from 'bun:test';
import { buildQrPayloads, interpretPollResponse } from './mitid-poll-machine.ts';

describe('interpretPollResponse', () => {
  test('timeout → waiting', () => {
    expect(interpretPollResponse({ status: 'timeout' })).toEqual({ kind: 'waiting' });
  });

  test('channel_validation_otp → otp with extracted code', () => {
    expect(
      interpretPollResponse({ status: 'channel_validation_otp', channelBindingValue: '742193' }),
    ).toEqual({ kind: 'otp', otpCode: '742193' });
  });

  test('channel_validation_otp without value → error', () => {
    const r = interpretPollResponse({ status: 'channel_validation_otp' });
    expect(r.kind).toBe('error');
  });

  test('channel_validation_tqr builds two QR JSON payloads', () => {
    const r = interpretPollResponse({
      status: 'channel_validation_tqr',
      channelBindingValue: 'abcdefghij',
      updateCount: 3,
    });
    expect(r).toEqual({
      kind: 'qr',
      qr1Json: '{"v":1,"p":1,"t":2,"h":"abcde","uc":3}',
      qr2Json: '{"v":1,"p":2,"t":2,"h":"fghij","uc":3}',
      updateCount: 3,
    });
  });

  test('channel_validation_tqr with odd-length binding splits at floor(len/2)', () => {
    const r = interpretPollResponse({
      status: 'channel_validation_tqr',
      channelBindingValue: 'abcde',
      updateCount: 0,
    });
    if (r.kind !== 'qr') throw new Error('expected qr');
    expect(r.qr1Json).toBe('{"v":1,"p":1,"t":2,"h":"ab","uc":0}');
    expect(r.qr2Json).toBe('{"v":1,"p":2,"t":2,"h":"cde","uc":0}');
  });

  test('channel_verified → verified', () => {
    expect(interpretPollResponse({ status: 'channel_verified' })).toEqual({ kind: 'verified' });
  });

  test('OK + confirmation + payload → completed', () => {
    expect(
      interpretPollResponse({
        status: 'OK',
        confirmation: true,
        payload: { response: 'b64-resp', responseSignature: 'b64-sig' },
      }),
    ).toEqual({ kind: 'completed', response: 'b64-resp', responseSignature: 'b64-sig' });
  });

  test('OK without confirmation → error', () => {
    const r = interpretPollResponse({ status: 'OK', confirmation: false });
    expect(r.kind).toBe('error');
  });

  test('unknown status → error mentions the status', () => {
    const r = interpretPollResponse({ status: 'wat' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('wat');
  });
});

describe('buildQrPayloads', () => {
  test('payloads are valid JSON with documented shape', () => {
    const { qr1Json, qr2Json } = buildQrPayloads('aabbccdd', 7);
    const qr1 = JSON.parse(qr1Json);
    const qr2 = JSON.parse(qr2Json);
    expect(qr1).toEqual({ v: 1, p: 1, t: 2, h: 'aabb', uc: 7 });
    expect(qr2).toEqual({ v: 1, p: 2, t: 2, h: 'ccdd', uc: 7 });
  });
});
