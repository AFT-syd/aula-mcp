/**
 * Cookie jar wrapper around `tough-cookie`. We need cross-domain persistence
 * and proper Set-Cookie parsing across the Aula → broker.unilogin → MitID
 * domain hop chain, so a real jar (not a single-host Map) is required.
 */

import { Cookie, CookieJar } from 'tough-cookie';

export class AulaCookieJar {
  private readonly jar: CookieJar;

  constructor(jar?: CookieJar) {
    this.jar = jar ?? new CookieJar();
  }

  /** Parse and store every Set-Cookie header from a response. */
  async storeFromResponse(headers: Headers, requestUrl: string): Promise<void> {
    const setCookies = headers.getSetCookie();
    for (const sc of setCookies) {
      const parsed = Cookie.parse(sc);
      if (!parsed) continue;
      await this.jar.setCookie(parsed, requestUrl, { ignoreError: true });
    }
  }

  /** Cookie header value to send with a request, or empty string if none apply. */
  async cookieHeader(url: string): Promise<string> {
    return this.jar.getCookieString(url);
  }

  /** Look up a single cookie by name for a URL — handy for CSRF tokens. */
  async getCookieValue(url: string, name: string): Promise<string | undefined> {
    const cookies = await this.jar.getCookies(url);
    return cookies.find((c) => c.key === name)?.value;
  }

  /** Serialize the entire jar — for persistence across CLI invocations. */
  async serialize(): Promise<string> {
    return JSON.stringify(await this.jar.serialize());
  }

  /** Restore a previously-serialized jar. */
  static async deserialize(serialized: string): Promise<AulaCookieJar> {
    const parsed = JSON.parse(serialized);
    const jar = await CookieJar.deserialize(parsed);
    return new AulaCookieJar(jar);
  }
}
