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
    storeFromResponse: async (_h: Headers, _url: string): Promise<void> => {},
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
    return {
      status: r.status,
      body: r.body ?? '',
      url,
      headers: new Headers(r.headers ?? {}),
    };
  }

  /** Returned to tests as if it were a real AulaHttpClient. */
  asHttpClient(): AulaHttpClient {
    return this as unknown as AulaHttpClient;
  }
}
