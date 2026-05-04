/**
 * Lazy AulaClient + WidgetTokenManager that the MCP tools share. Tokens are
 * loaded on first use and refreshed transparently.
 *
 * The MCP server is deliberately stateless across restarts: it always reads
 * the same EncryptedFileTokenStore that the CLI writes to. This means
 * `aula login` from the terminal "just works" with any running server.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AulaHttpClient,
  EncryptedFileTokenStore,
  isTokenExpired,
  type Logger,
  type StoredTokenRecord,
  silentLogger,
  type TokenStore,
  withFreshTokens,
} from '@aula-mcp/aula-auth';
import {
  AulaClient,
  EasyIqClient,
  MeebookClient,
  MinUddannelseClient,
  SystematicClient,
  WidgetTokenManager,
} from '@aula-mcp/aula-client';

export interface AulaContextOptions {
  store?: TokenStore;
  logger?: Logger;
}

export class AulaContext {
  private readonly store: TokenStore;
  private readonly logger: Logger;
  private readonly http: AulaHttpClient;
  // Fields below are declared as `T | undefined` (not just `T?`) so we can
  // explicitly assign `undefined` to invalidate the cache (the strict
  // `exactOptionalPropertyTypes` flag forbids `field = undefined` on `T?`).
  private clientPromise: Promise<AulaClient> | undefined;
  private widgetManagerPromise: Promise<WidgetTokenManager> | undefined;
  private cachedRecord: StoredTokenRecord | undefined;
  /** Numeric guardian user-id from getProfileContext. Used as the
   *  sessionId/sessionUUID/sessionuuid parameter by the third-party
   *  integrations. */
  private cachedGuardianUserId: number | undefined;

  constructor(options: AulaContextOptions = {}) {
    this.store = options.store ?? defaultStore();
    this.logger = options.logger ?? silentLogger;
    this.http = new AulaHttpClient({ logger: this.logger });
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
   *  401/403 indicates the server's view of our tokens is wrong. */
  invalidate(): void {
    this.clientPromise = undefined;
    this.widgetManagerPromise = undefined;
    this.cachedRecord = undefined;
    this.cachedGuardianUserId = undefined;
  }

  /**
   * Numeric guardian user-id (from `profiles.getProfileContext.data.userId`).
   * Required as the `sessionId` / `sessionUUID` / `sessionuuid` parameter for
   * EasyIQ, Min Uddannelse, and Meebook. Cached after the first call.
   *
   * Per Python `client.py:670/757` — the integration calls fail without it.
   */
  async getGuardianUserId(): Promise<number> {
    if (this.cachedGuardianUserId !== undefined) return this.cachedGuardianUserId;
    const client = await this.getClient();
    const ctx = await client.getProfileContext('guardian');
    if (typeof ctx.userId !== 'number') {
      throw new Error('profiles.getProfileContext returned no numeric userId');
    }
    this.cachedGuardianUserId = ctx.userId;
    return ctx.userId;
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

  async getMeebook(): Promise<MeebookClient> {
    return new MeebookClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  async getMinUddannelse(): Promise<MinUddannelseClient> {
    return new MinUddannelseClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  async getSystematic(): Promise<SystematicClient> {
    return new SystematicClient({ http: this.http, widgets: await this.getWidgetManager() });
  }

  /** The currently-loaded record (after first getClient()). */
  get record(): StoredTokenRecord | undefined {
    return this.cachedRecord;
  }

  private async buildClient(): Promise<AulaClient> {
    const record = await withFreshTokens({
      store: this.store,
      http: this.http,
      logger: this.logger,
    });
    this.cachedRecord = record;
    return new AulaClient({ tokens: record.tokens, http: this.http, logger: this.logger });
  }
}

function defaultStore(): TokenStore {
  const dir = process.env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
  return new EncryptedFileTokenStore({
    filePath: join(dir, 'tokens.json'),
    keyFilePath: join(dir, '.key'),
  });
}
