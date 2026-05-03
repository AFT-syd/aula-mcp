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
  type Logger,
  type StoredTokenRecord,
  silentLogger,
  type TokenStore,
  withFreshTokens,
} from '@aula-mcp/aula-auth';
import { AulaClient, WidgetTokenManager } from '@aula-mcp/aula-client';

export interface AulaContextOptions {
  store?: TokenStore;
  logger?: Logger;
}

export class AulaContext {
  private readonly store: TokenStore;
  private readonly logger: Logger;
  private readonly http: AulaHttpClient;
  private clientPromise?: Promise<AulaClient>;
  private widgetManagerPromise?: Promise<WidgetTokenManager>;
  private cachedRecord?: StoredTokenRecord;

  constructor(options: AulaContextOptions = {}) {
    this.store = options.store ?? defaultStore();
    this.logger = options.logger ?? silentLogger;
    this.http = new AulaHttpClient({ logger: this.logger });
  }

  /** Get the AulaClient, refreshing tokens if expired. */
  async getClient(): Promise<AulaClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.buildClient();
    }
    return this.clientPromise;
  }

  async getWidgetManager(): Promise<WidgetTokenManager> {
    if (!this.widgetManagerPromise) {
      this.widgetManagerPromise = (async () =>
        new WidgetTokenManager({ client: await this.getClient() }))();
    }
    return this.widgetManagerPromise;
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
  const dir = process.env['AULA_MCP_DIR'] ?? join(homedir(), '.config', 'aula-mcp');
  return new EncryptedFileTokenStore({
    filePath: join(dir, 'tokens.json'),
    keyFilePath: join(dir, '.key'),
  });
}
