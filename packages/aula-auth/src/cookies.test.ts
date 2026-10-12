/**
 * Tests for AulaCookieJar's removal API.
 *
 * Why this file exists: the jar had no way to delete a cookie at all — only
 * store, read and serialize. That gap is what let a dead Tabulex session
 * wedge the server: a WS-Federation `FedAuth` cookie
 * carries no `Expires`, so the jar keeps handing it out forever, and code
 * that treats "the cookie is present" as "the session is alive" had no way
 * back. These tests pin the behaviour the fix depends on.
 *
 * Every value here is a test fixture. No real cookie value appears.
 */

import { describe, expect, test } from 'bun:test';
import { AulaCookieJar } from './cookies.ts';

const URL_TABULEX = 'https://foraeldre.tabulex.net/';
const URL_AULA = 'https://www.aula.dk/';

function setCookieHeaders(...values: string[]): Headers {
  const h = new Headers();
  for (const v of values) h.append('set-cookie', v);
  return h;
}

async function jarWith(url: string, ...cookies: string[]): Promise<AulaCookieJar> {
  const jar = new AulaCookieJar();
  await jar.storeFromResponse(setCookieHeaders(...cookies), url);
  return jar;
}

describe('AulaCookieJar.removeCookies', () => {
  test('removes the named cookies and reports how many went', async () => {
    const jar = await jarWith(URL_TABULEX, 'FedAuth=a', 'FedAuth1=b', 'XSRF-TOKEN=c');

    const removed = await jar.removeCookies(URL_TABULEX, ['FedAuth', 'FedAuth1']);

    expect(removed).toBe(2);
    expect(await jar.getCookieValue(URL_TABULEX, 'FedAuth')).toBeUndefined();
    expect(await jar.getCookieValue(URL_TABULEX, 'FedAuth1')).toBeUndefined();
    // Untouched: removal is by name, not a blanket clear for the host.
    expect(await jar.getCookieValue(URL_TABULEX, 'XSRF-TOKEN')).toBe('c');
  });

  test('a name that is not present is not counted', async () => {
    const jar = await jarWith(URL_TABULEX, 'FedAuth=a');

    // FedAuth2/FedAuth3 are in the chunk list but only appear for large
    // tokens, so asking for them must be free and silent.
    expect(await jar.removeCookies(URL_TABULEX, ['FedAuth', 'FedAuth2', 'FedAuth3'])).toBe(1);
  });

  test('removing nothing is a no-op on an empty jar', async () => {
    const jar = new AulaCookieJar();
    expect(await jar.removeCookies(URL_TABULEX, ['FedAuth'])).toBe(0);
  });

  test('a cookie for another host is left alone', async () => {
    const jar = new AulaCookieJar();
    await jar.storeFromResponse(setCookieHeaders('FedAuth=tabulex-session'), URL_TABULEX);
    await jar.storeFromResponse(setCookieHeaders('FedAuth=aula-session'), URL_AULA);

    const removed = await jar.removeCookies(URL_TABULEX, ['FedAuth']);

    // Only the cookie that would actually have been sent to the Tabulex URL
    // is gone — clearing a Tabulex session must never log the user out of
    // Aula itself, since both live in this one shared jar.
    expect(removed).toBe(1);
    expect(await jar.getCookieValue(URL_TABULEX, 'FedAuth')).toBeUndefined();
    expect(await jar.getCookieValue(URL_AULA, 'FedAuth')).toBe('aula-session');
  });
});
