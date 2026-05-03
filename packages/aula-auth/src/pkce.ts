/**
 * RFC 7636 PKCE — Aula's OAuth client requires S256.
 * Verifier length: 32 random bytes → 43-char base64url string (within 43–128 spec).
 */

import { randomBytes, sha256 } from './crypto.ts';
import { base64url } from './encoding.ts';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export function generatePkce(verifierBytes: number = 32): PkcePair {
  const verifier = base64url.encode(randomBytes(verifierBytes));
  const challenge = base64url.encode(sha256(verifier));
  return { verifier, challenge, method: 'S256' };
}

/** Recompute the challenge for a known verifier. Useful for testing + recovery. */
export function challengeFromVerifier(verifier: string): string {
  return base64url.encode(sha256(verifier));
}
