/**
 * Pure interpreter for MitID APP poll responses. Easier to test in isolation
 * than the polling loop itself. The HTTP client wraps this with the actual
 * `POST {pollUrl}` calls.
 *
 * Status values come from `BrowserClient.poll_app_authentication_status`:
 *   - "timeout"                  → still waiting, poll again
 *   - "channel_validation_otp"   → user enters this OTP in the app
 *   - "channel_validation_tqr"   → user scans these QR codes in the app
 *   - "channel_verified"         → user verified the channel; awaiting approval
 *   - "OK" + confirmation:true   → success, payload has response + signature
 */

import type { AppPollResponse } from './mitid-types.ts';

export type MitidPollResult =
  | { kind: 'waiting' }
  | { kind: 'otp'; otpCode: string }
  | {
      kind: 'qr';
      /** JSON string the user scans (first half of channel binding). */
      qr1Json: string;
      /** JSON string the user scans (second half — alternate display). */
      qr2Json: string;
      updateCount: number;
    }
  | { kind: 'verified' }
  | { kind: 'completed'; response: string; responseSignature: string }
  | { kind: 'error'; message: string };

/** Build the QR JSON payloads from a channel binding hex string. */
export function buildQrPayloads(
  channelBindingValue: string,
  updateCount: number,
): { qr1Json: string; qr2Json: string } {
  const half = Math.floor(channelBindingValue.length / 2);
  const make = (part: 1 | 2, slice: string) =>
    JSON.stringify({ v: 1, p: part, t: 2, h: slice, uc: updateCount });
  return {
    qr1Json: make(1, channelBindingValue.slice(0, half)),
    qr2Json: make(2, channelBindingValue.slice(half)),
  };
}

/** Map a single poll response JSON → typed state. */
export function interpretPollResponse(response: AppPollResponse): MitidPollResult {
  switch (response.status) {
    case 'timeout':
      return { kind: 'waiting' };

    case 'channel_validation_otp': {
      const otpCode = response.channelBindingValue;
      if (!otpCode) return { kind: 'error', message: 'OTP poll missing channelBindingValue' };
      return { kind: 'otp', otpCode };
    }

    case 'channel_validation_tqr': {
      const cbv = response.channelBindingValue;
      const updateCount = response.updateCount;
      if (!cbv || updateCount == null) {
        return { kind: 'error', message: 'QR poll missing channelBindingValue/updateCount' };
      }
      const { qr1Json, qr2Json } = buildQrPayloads(cbv, updateCount);
      return { kind: 'qr', qr1Json, qr2Json, updateCount };
    }

    case 'channel_verified':
      return { kind: 'verified' };

    case 'OK': {
      if (response.confirmation === true && response.payload) {
        return {
          kind: 'completed',
          response: response.payload.response,
          responseSignature: response.payload.responseSignature,
        };
      }
      return { kind: 'error', message: 'OK status received without confirmation/payload' };
    }

    default:
      return {
        kind: 'error',
        message: `Unexpected poll status: ${response.status ?? '<missing>'}`,
      };
  }
}
