import { describe, expect, test } from 'bun:test';
import { challengeFromVerifier, generatePkce } from './pkce.ts';

describe('PKCE', () => {
  test('matches the RFC 7636 example verifier → challenge mapping', () => {
    // Appendix B example
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(challengeFromVerifier(verifier)).toBe(expected);
  });

  test('generatePkce produces a 43-char URL-safe verifier and S256 method', () => {
    const pair = generatePkce();
    expect(pair.method).toBe('S256');
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challengeFromVerifier(pair.verifier)).toBe(pair.challenge);
  });
});
