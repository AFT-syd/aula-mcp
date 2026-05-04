/**
 * Cookie jar wrapper around `tough-cookie`. We need cross-domain persistence
 * and proper Set-Cookie parsing across the Aula → broker.unilogin → MitID
 * domain hop chain, so a real jar (not a single-host Map) is required.
 *
 * Parse failures are logged (not silently swallowed) — Aula's session
 * continuity depends on cookies, and a dropped cookie hours later turns into
 * an opaque 403 elsewhere. The logger lets that surface.
 */

import { Cookie, CookieJar } from 'tough-cookie';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';

export interface AulaCookieJarOptions {
  jar?: CookieJar;
  logger?: Logger;
}

export class AulaCookieJar {
  private readonly jar: CookieJar;
  private readonly logger: Logger;

  constructor(opts: AulaCookieJarOptions | CookieJar = {}) {
    // Back-compat: callers may have passed a bare CookieJar.
    if (opts instanceof CookieJar) {
      this.jar = opts;
      this.logger = silentLogger;
    } else {
      this.jar = opts.jar ?? new CookieJar();
      this.logger = opts.logger ?? silentLogger;
    }
  }

  /** Parse and store every Set-Cookie header from a response. */
  async storeFromResponse(headers: Headers, requestUrl: string): Promise<void> {
    const setCookies = headers.getSetCookie();
    for (const sc of setCookies) {
      const parsed = Cookie.parse(sc);
      if (!parsed) {
        this.logger.warn('cookies.parse_failed', { snippet: sc.slice(0, 80), requestUrl });
        continue;
      }
      try {
        await this.jar.setCookie(parsed, requestUrl);
      } catch (e) {
        // tough-cookie throws on domain/path mismatch, expired, etc. We
        // don't want a single bad cookie to abort a request, but we do want
        // to know it happened.
        this.logger.warn('cookies.set_failed', {
          name: parsed.key,
          domain: parsed.domain ?? '<implicit>',
          requestUrl,
          error: (e as Error).message,
        });
      }
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
