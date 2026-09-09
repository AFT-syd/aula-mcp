/**
 * Test-only helpers. Not exported from the package's public surface.
 *
 * `FakeHttp` lets unit tests drive AulaClient + integration plugins without
 * touching the network. Enqueue responses in order; the fake throws if a
 * call has no queued response (so missing setup is loud).
 */

import type { AulaHttpClient, AulaResponse } from '@aula-mcp/aula-auth';

export interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface FakeRequest {
  url: string;
  method: string;
  body?: string | URLSearchParams | Uint8Array;
  headers?: Record<string, string>;
}

export class FakeHttp {
  readonly requested: FakeRequest[] = [];
  private readonly responses: FakeResponse[] = [];
  /** Cookie values returned by jar.getCookieValue, keyed by `${url}#${name}`. */
  readonly cookieValues = new Map<string, string>();

  readonly jar = {
    getCookieValue: async (_url: string, name: string): Promise<string | undefined> => {
      // Match any URL by name first, then exact match.
      for (const [k, v] of this.cookieValues) {
        if (k.endsWith(`#${name}`)) return v;
      }
      return undefined;
    },
    cookieHeader: async (_url: string): Promise<string> => '',
    // Simplified vs. the real tough-cookie-backed jar: no domain/path
    // scoping, just name→value (matching getCookieValue's own "any URL"
    // simplification above). Good enough to test flows like TabulexClient's
    // SSO handshake, where a test just needs "the FedAuth cookie now exists
    // after this response".
    storeFromResponse: async (headers: Headers, _url: string): Promise<void> => {
      for (const sc of headers.getSetCookie()) {
        const nameValue = sc.split(';', 1)[0] ?? '';
        const eq = nameValue.indexOf('=');
        if (eq <= 0) continue;
        this.cookieValues.set(`*#${nameValue.slice(0, eq)}`, nameValue.slice(eq + 1));
      }
    },
  };

  enqueue(...rs: FakeResponse[]): this {
    this.responses.push(...rs);
    return this;
  }

  setCookie(name: string, value: string): void {
    this.cookieValues.set(`*#${name}`, value);
  }

  async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: FakeRequest['body'] } = {},
  ): Promise<AulaResponse> {
    this.requested.push({
      url,
      method: init.method ?? 'GET',
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
    });
    const r = this.responses.shift();
    if (!r) {
      throw new Error(
        `FakeHttp: no response queued for ${init.method ?? 'GET'} ${url} (already had ${this.requested.length - 1} call(s))`,
      );
    }
    const headers = new Headers(r.headers ?? {});
    await this.jar.storeFromResponse(headers, url);
    return {
      status: r.status,
      body: r.body ?? '',
      url,
      headers,
    };
  }

  /** Mirrors AulaHttpClient.followRedirects's manual redirect loop, built on
   *  this fake's own `request`. Used by tests that drive a multi-hop chain
   *  (e.g. TabulexClient's SSO handshake). */
  async followRedirects(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: FakeRequest['body'];
      maxHops?: number;
    } = {},
  ): Promise<{ history: { url: string; status: number }[]; final: AulaResponse }> {
    const maxHops = options.maxHops ?? 10;
    const history: { url: string; status: number }[] = [];
    let currentUrl = url;
    let currentOptions: {
      method?: string;
      headers?: Record<string, string>;
      body?: FakeRequest['body'];
    } = options;

    for (let hop = 0; hop < maxHops; hop++) {
      const response = await this.request(currentUrl, currentOptions);
      history.push({ url: currentUrl, status: response.status });

      if (response.status < 300 || response.status >= 400) {
        return { history, final: response };
      }

      const location = response.headers.get('location');
      if (!location) {
        return { history, final: response };
      }

      currentUrl = new URL(location, currentUrl).toString();
      const preserveMethod = response.status === 307 || response.status === 308;
      currentOptions = preserveMethod
        ? { ...options, headers: options.headers ?? {} }
        : { headers: options.headers ?? {} };
    }

    throw new Error(`FakeHttp: redirect loop exceeded ${maxHops} hops at ${currentUrl}`);
  }

  /** Returned to tests as if it were a real AulaHttpClient. */
  asHttpClient(): AulaHttpClient {
    return this as unknown as AulaHttpClient;
  }
}
