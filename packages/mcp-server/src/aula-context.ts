/**
 * Lazy AulaClient + WidgetTokenManager that the MCP tools share. Tokens are
 * loaded on first use and refreshed transparently.
 *
 * The MCP server is deliberately stateless across restarts: it always reads
 * the same EncryptedFileTokenStore that the CLI writes to. This means
 * `aula login` from the terminal "just works" with any running server.
 */

import { type FSWatcher, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AulaHttpClient,
  EncryptedFileTokenStore,
  isTokenExpired,
  KeychainTokenStore,
  type Logger,
  type StoredTokenRecord,
  silentLogger,
  type TokenStore,
  type WireTracer,
  withFreshTokens,
} from '@aula-mcp/aula-auth';
import {
  AulaClient,
  EasyIqClient,
  EasyIqLektierClient,
  EasyIqSkoleportalClient,
  MeebookClient,
  MinUddannelseClient,
  type ProfilesByLoginData,
  SystematicClient,
  TabulexClient,
  WidgetTokenManager,
} from '@aula-mcp/aula-client';

export interface AulaContextOptions {
  store?: TokenStore;
  logger?: Logger;
  /** Wire tracer for every HTTP exchange this context's integrations make.
   *  Defaults to AulaHttpClient's own noop. Wired from AULA_MCP_TRACE_FILE
   *  in server.ts — see trace-config.ts. */
  tracer?: WireTracer;
}

/** How long a cached profiles.getProfilesByLogin() response is served
 *  before the next caller triggers a fresh fetch. Short enough that a
 *  session doesn't drift far from Aula's own state, long enough to collapse
 *  the burst of calls one aula.discover plus a couple of tool calls makes —
 *  measured live 2026-10-02: 4 calls to getProfilesByLogin, all redundant,
 *  within a single discover. `aula.discover` itself bypasses this cache via
 *  `forceRefresh` (see getProfilesByLogin below), so calling it again after
 *  a "children or widgets unknown" error always gets current data — this
 *  cache only collapses the *other* tools' incidental lookups. */
const PROFILES_CACHE_TTL_MS = 60_000;

export class AulaContext {
  private readonly store: TokenStore;
  private readonly logger: Logger;
  // Public (not `private`) so callers — notably tests — can confirm which
  // WireTracer is wired in without a dedicated accessor. Every integration
  // plugin (getEasyIq(), getTabulex(), ...) shares this exact instance.
  readonly http: AulaHttpClient;
  // Fields below are declared as `T | undefined` (not just `T?`) so we can
  // explicitly assign `undefined` to invalidate the cache (the strict
  // `exactOptionalPropertyTypes` flag forbids `field = undefined` on `T?`).
  private clientPromise: Promise<AulaClient> | undefined;
  private widgetManagerPromise: Promise<WidgetTokenManager> | undefined;
  private cachedRecord: StoredTokenRecord | undefined;
  /** Guardian user-id from getProfileContext. Used as the
   *  sessionId/sessionUUID/sessionuuid parameter by the third-party
   *  integrations. Stored as string — Aula returns either a numeric id
   *  or an opaque alphanumeric token; we treat it as opaque to match
   *  upstream Python's `str(child["userId"])` handling.
   *
   *  Bound to the client it was fetched with: getProfileContext also
   *  activates the guardian profile server-side, which messaging needs, and
   *  that activation belongs to the access token. See getGuardianUserId. */
  private cachedGuardian: { client: AulaClient; userId: string } | undefined;
  /** profiles.getProfilesByLogin(), cached for PROFILES_CACHE_TTL_MS — see
   *  that constant's comment. */
  private profilesPromise: Promise<ProfilesByLoginData> | undefined;
  private profilesFetchedAt = 0;
  /**
   * Set by invalidate(), consumed by getTabulex(). The Tabulex session lives
   * as a FedAuth cookie in the SHARED cookie jar, which invalidate() cannot
   * clear synchronously (removal is async) and must not clear eagerly on a
   * path that may run while a request is in flight. Deferring it to the next
   * getTabulex() puts the clearing exactly where the new token's first
   * Tabulex call would otherwise have adopted the previous login's session.
   */
  private tabulexSessionStale = false;
  private tokenFileWatcher: FSWatcher | undefined;
  private tokenFileChangeDebounce: NodeJS.Timeout | undefined;

  constructor(options: AulaContextOptions = {}) {
    this.store = options.store ?? defaultStore();
    this.logger = options.logger ?? silentLogger;
    this.http = new AulaHttpClient({
      logger: this.logger,
      ...(options.tracer ? { tracer: options.tracer } : {}),
    });
    this.watchTokenFile();
  }

  /**
   * If the underlying store is file-backed, watch its path and invalidate the
   * cached client whenever the file changes (e.g. an out-of-band `aula login`
   * or `aula refresh-stepup` rotates tokens). Without this, the cached client
   * keeps serving 401/403 against the rotated session until its access token
   * naturally expires (~60min).
   *
   * Best-effort: errors here are non-fatal. The original token-expiry
   * invalidation in `getClient()` is still the backstop.
   *
   * Duck-typed (`'filePath' in store && typeof string`) rather than
   * `instanceof EncryptedFileTokenStore`: Bun's `--compile` bundler can
   * produce two copies of the same class when the package is imported via
   * different specifiers across the bundled graph, breaking `instanceof`
   * silently — the watcher then never gets attached and stale tokens linger.
   */
  private watchTokenFile(): void {
    const filePath = (this.store as { filePath?: unknown }).filePath;
    if (typeof filePath !== 'string' || filePath.length === 0) return;
    const path = filePath;
    try {
      this.tokenFileWatcher = watch(path, { persistent: false }, (eventType) => {
        // fs.watch tends to fire multiple events per write (the writer does
        // write + close + chmod). Debounce so we only invalidate once.
        if (this.tokenFileChangeDebounce) clearTimeout(this.tokenFileChangeDebounce);
        this.tokenFileChangeDebounce = setTimeout(() => {
          this.tokenFileChangeDebounce = undefined;
          this.logger.info('aula-context.token_file_changed_invalidating', {
            path,
            eventType,
          });
          this.invalidate();
        }, 250);
      });
      this.tokenFileWatcher.on('error', (err) => {
        this.logger.warn('aula-context.token_file_watch_error', {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      this.logger.warn('aula-context.token_file_watch_setup_failed', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Close the token-file watcher. Tests should call this; long-lived servers
   *  can leave it until process exit. */
  dispose(): void {
    if (this.tokenFileChangeDebounce) {
      clearTimeout(this.tokenFileChangeDebounce);
      this.tokenFileChangeDebounce = undefined;
    }
    this.tokenFileWatcher?.close();
    this.tokenFileWatcher = undefined;
  }

  /**
   * Get the AulaClient, refreshing tokens if expired.
   *
   * Concurrency-safe (J5 fix): the in-flight `clientPromise` is shared across
   * concurrent callers, so a refresh fires once and everyone waits on it.
   *
   * Auto-recovery (Q8): if the cached tokens have expired since the client
   * was built, we drop the cached promise and rebuild — which re-reads the
   * token store from disk. This means a fresh `aula login` from the CLI
   * recovers a server with bad tokens without restarting the server process.
   */
  async getClient(): Promise<AulaClient> {
    if (this.cachedRecord && isTokenExpired(this.cachedRecord.tokens, 60)) {
      this.logger.info('aula-context.token_expired_invalidating');
      this.clientPromise = undefined;
    }
    if (!this.clientPromise) {
      this.clientPromise = this.buildClient().catch((err: unknown) => {
        // On failure, clear the cached promise so the next call retries
        // rather than re-throwing the same stale rejection forever.
        this.clientPromise = undefined;
        throw err;
      });
    }
    return this.clientPromise;
  }

  /** Drop all cached state. Useful for tests; also called when an upstream
   *  401/403 indicates the server's view of our tokens is wrong. Also drops
   *  the profiles cache — a token switch (e.g. `aula login` as a different
   *  user) must never serve the previous login's cached child list. */
  invalidate(): void {
    this.clientPromise = undefined;
    this.widgetManagerPromise = undefined;
    this.cachedRecord = undefined;
    this.cachedGuardian = undefined;
    this.profilesPromise = undefined;
    this.profilesFetchedAt = 0;
    // The Tabulex session is a cookie in the shared jar, not a field here —
    // see tabulexSessionStale. Dropping the profiles cache without also
    // dropping that session would leave the exact hole this guards: the
    // next guardian's first Fravær call reusing the previous one's session.
    this.tabulexSessionStale = true;
  }

  /**
   * `profiles.getProfilesByLogin` — every child + institution for the
   * logged-in guardian. Cached for PROFILES_CACHE_TTL_MS; pass
   * `forceRefresh: true` to bypass the cache (aula.discover always does —
   * it is the tool the agent is told to re-call when "children or widgets
   * unknown", and that instruction must keep meaning "fetch current data",
   * not "read a minute-old cache"). `invalidate()` also drops it, so a
   * rotated token can never serve a previous login's children.
   */
  async getProfilesByLogin(opts: { forceRefresh?: boolean } = {}): Promise<ProfilesByLoginData> {
    const now = Date.now();
    const stale = now - this.profilesFetchedAt > PROFILES_CACHE_TTL_MS;
    if (opts.forceRefresh || !this.profilesPromise || stale) {
      // No `await` before this assignment — same concurrency-safety reason
      // as getClient() above. Awaiting this.getClient() first would leave a
      // window where two callers racing in the same tick both see
      // `!this.profilesPromise` and both trigger their own fetch; chaining
      // with .then() instead assigns the promise synchronously, so the
      // second concurrent caller sees it already set and shares it.
      this.profilesFetchedAt = now;
      this.profilesPromise = this.getClient()
        .then((client) => client.getProfilesByLogin())
        .catch((err: unknown) => {
          // Same pattern as getClient(): don't let a failed fetch poison the
          // cache for the next caller.
          this.profilesPromise = undefined;
          this.profilesFetchedAt = 0;
          throw err;
        });
    }
    return this.profilesPromise;
  }

  /**
   * Guardian user-id (from `profiles.getProfileContext.data.userId`).
   * Required as the `sessionId` / `sessionUUID` / `sessionuuid` parameter for
   * EasyIQ, Min Uddannelse, and Meebook. Cached after the first call.
   *
   * Per Python `client.py:670/757` — the integration calls fail without it.
   * Aula returns this as either a number or an opaque alphanumeric token;
   * we coerce to string and pass through verbatim.
   *
   * Cached per client, not once per context. The call is also what primes
   * the guardian profile for messaging (see the tools' comments on 403s),
   * and getClient() builds a NEW client when the access token expires. A
   * cache that outlived the client skipped the priming for the new token:
   * observed live 2026-10-11, the first messaging call after a refresh got
   * HTTP 403 and the next one worked — because the refresh rewrote
   * tokens.json and the file watcher's invalidate() cleared the cache.
   */
  async getGuardianUserId(): Promise<string> {
    const client = await this.getClient();
    if (this.cachedGuardian?.client === client) return this.cachedGuardian.userId;
    const ctx = await client.getProfileContext('guardian');
    if (ctx.userId == null || ctx.userId === '') {
      throw new Error('profiles.getProfileContext returned no userId');
    }
    const userId = String(ctx.userId);
    this.cachedGuardian = { client, userId };
    return userId;
  }

  async getWidgetManager(): Promise<WidgetTokenManager> {
    if (!this.widgetManagerPromise) {
      this.widgetManagerPromise = (async () =>
        new WidgetTokenManager({ client: await this.getClient() }))();
    }
    return this.widgetManagerPromise;
  }

  async getEasyIq(): Promise<EasyIqClient> {
    return new EasyIqClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  async getEasyIqSkoleportal(): Promise<EasyIqSkoleportalClient> {
    return new EasyIqSkoleportalClient({
      http: this.http,
      widgets: await this.getWidgetManager(),
    });
  }

  async getEasyIqLektier(): Promise<EasyIqLektierClient> {
    return new EasyIqLektierClient({
      http: this.http,
      widgets: await this.getWidgetManager(),
    });
  }

  async getMeebook(): Promise<MeebookClient> {
    return new MeebookClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  async getMinUddannelse(): Promise<MinUddannelseClient> {
    return new MinUddannelseClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  async getSystematic(): Promise<SystematicClient> {
    return new SystematicClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  /**
   * Deliberately NOT memoized, unlike getWidgetManager() above. A fresh
   * TabulexClient per call used to mean a fresh WS-Federation SSO handshake
   * per call too (sessionEstablished starts false on every instance) — see
   * the 2026-10-02 live test, 27 HTTP calls for 4 tool calls in one MCP
   * session. The actual fix is in TabulexClient.ensureSession(), which now
   * checks the shared cookie jar (this.http's, same instance across every
   * client built here) for a live FedAuth cookie before redoing the
   * handshake. That's more robust than memoizing the client here: it also
   * covers a client built some other way, and it sidesteps having to
   * invalidate a cached TabulexClient on the same triggers getClient()
   * already tracks (token rotation, expiry) — the cookie jar is simply
   * asked fresh each time instead of mirrored into a second cache.
   */
  async getTabulex(): Promise<TabulexClient> {
    const widgets = await this.getWidgetManager();
    if (this.tabulexSessionStale) {
      // Clear before the client is handed out, not after: the very next call
      // on it would otherwise adopt the stale FedAuth cookie from the jar.
      this.tabulexSessionStale = false;
      await TabulexClient.clearSession(this.http);
    }
    return new TabulexClient({ http: this.http, widgets });
  }

  /** The currently-loaded record (after first getClient()). */
  get record(): StoredTokenRecord | undefined {
    return this.cachedRecord;
  }

  private async buildClient(): Promise<AulaClient> {
    // Plain refresh_token grant. The scaarup/aula HA integration has
    // proven empirically that Aula's OAuth server preserves the
    // `aula-sensitive` scope through refresh_token grants — HA reads
    // sensitive endpoints (messaging.getMessagesForThread) for months
    // from a single MitID login using nothing but
    // `grant_type=refresh_token` against simplesaml/.../token.php.
    // Earlier suspicion that step-up assurance was bound to the
    // broker session at unilogin.dk was a misdiagnosis — the 403s we
    // were seeing were the v22→v23 apiVersion deprecation (fixed in
    // 60c4246), not step-up loss. Silent SSO was "working" via side
    // effect (each reauth rebuilt AulaContext via fs.watch
    // invalidation, which re-probed apiVersion to v23). The `aula
    // refresh-stepup` CLI command is kept as a manual recovery tool
    // when the refresh_token chain breaks (e.g. after a long
    // downtime), but the MCP child no longer invokes it.
    const record = await withFreshTokens({
      store: this.store,
      http: this.http,
      logger: this.logger,
    });
    this.cachedRecord = record;
    return new AulaClient({ tokens: record.tokens, http: this.http, logger: this.logger });
  }
}

/**
 * Mirror the CLI's backend selection (apps/cli/src/store.ts) so the server
 * reads from the same place `aula login` writes to:
 *   1. AULA_MCP_NO_KEYCHAIN=1 → file backend regardless of platform.
 *   2. macOS + `security` available → KeychainTokenStore.
 *   3. Everything else → EncryptedFileTokenStore at AULA_MCP_DIR.
 */
function defaultStore(): TokenStore {
  if (KeychainTokenStore.isSupported() && process.env.AULA_MCP_NO_KEYCHAIN !== '1') {
    return new KeychainTokenStore();
  }
  const dir = process.env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
  return new EncryptedFileTokenStore({
    filePath: join(dir, 'tokens.json'),
    keyFilePath: join(dir, '.key'),
  });
}
