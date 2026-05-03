/**
 * Widget token manager. Aula issues per-widget bearer tokens that the
 * third-party integrations (Min Uddannelse, EasyIQ, Meebook, Systematic) use
 * to authenticate. Tokens are short-lived; their plain TTL alone isn't
 * trustworthy because the upstream APIs sometimes pre-emptively reject them
 * with a JSON body like `{"message": "JWT-Token expired, please renew."}`.
 *
 * Bake-in for upstream issue #311:
 *   The Python integration cached widget tokens by 1-minute TTL but didn't
 *   detect server-side "expired" messages, so the sensor sat in a stuck state
 *   until a process restart. This manager always retries once on detected
 *   expiry, refreshing the underlying token first.
 */

import type { AulaClient } from './aula-client.ts';

/** Default cache TTL — server-side tokens are typically valid ~hour but we
 *  refresh much more eagerly so a hop-related delay doesn't trip them. */
const DEFAULT_TTL_MS = 60 * 1_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface WidgetTokenManagerOptions {
  client: AulaClient;
  ttlMs?: number;
}

/** Patterns that indicate the widget token is no longer accepted upstream. */
const EXPIRED_BODY_PATTERNS: readonly RegExp[] = [
  /JWT[- ]Token expired/i,
  /token has expired/i,
  /unauthorized/i,
];

/** True when a third-party API response body looks like "your token expired". */
export function isWidgetTokenExpiredResponse(body: string, status: number): boolean {
  if (status === 401 || status === 403) return true;
  if (!body) return false;
  for (const re of EXPIRED_BODY_PATTERNS) if (re.test(body)) return true;
  return false;
}

export class WidgetTokenManager {
  private readonly client: AulaClient;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CachedToken>();
  /** In-flight requests so we don't ask Aula concurrently for the same widget. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(options: WidgetTokenManagerOptions) {
    this.client = options.client;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Get a token, refreshing if cache is empty/stale. */
  async get(widgetId: string): Promise<string> {
    const cached = this.cache.get(widgetId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    return this.refresh(widgetId);
  }

  /** Force a fresh token from Aula. Coalesces concurrent callers. */
  async refresh(widgetId: string): Promise<string> {
    const existing = this.inFlight.get(widgetId);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const token = await this.client.getWidgetToken(widgetId);
        this.cache.set(widgetId, { token, expiresAt: Date.now() + this.ttlMs });
        return token;
      } finally {
        this.inFlight.delete(widgetId);
      }
    })();
    this.inFlight.set(widgetId, promise);
    return promise;
  }

  /** Drop the cached token for a widget (next get() will refresh). */
  invalidate(widgetId: string): void {
    this.cache.delete(widgetId);
  }

  /** Drop all cached tokens. */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Wrap an integration call so it auto-retries on detected expiry. Pass a
   * function that takes the current token and returns either:
   *   - parsed result on success
   *   - { _expired: true, raw: { status, body } } if the response signals
   *     "token expired"
   * The manager refreshes the token and retries once.
   */
  async withRetry<T>(
    widgetId: string,
    fn: (token: string) => Promise<T | WidgetExpiredSignal>,
  ): Promise<T> {
    const token = await this.get(widgetId);
    const first = await fn(token);
    if (!isExpiredSignal(first)) return first;
    this.invalidate(widgetId);
    const fresh = await this.refresh(widgetId);
    const second = await fn(fresh);
    if (isExpiredSignal(second)) {
      throw new Error(
        `Widget ${widgetId}: token still rejected after refresh (status ${second.status})`,
      );
    }
    return second;
  }
}

export interface WidgetExpiredSignal {
  _expired: true;
  status: number;
  bodySnippet: string;
}

function isExpiredSignal<T>(v: T | WidgetExpiredSignal): v is WidgetExpiredSignal {
  return typeof v === 'object' && v !== null && (v as { _expired?: boolean })._expired === true;
}
