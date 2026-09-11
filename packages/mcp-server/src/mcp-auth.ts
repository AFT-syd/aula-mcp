/**
 * OAuth 2.1 authorization server for remote MCP clients.
 *
 * Why this exists: the MCP server is single-user and anyone who can reach
 * `/mcp` effectively *is* the logged-in Aula user. Binding to a non-loopback
 * address is therefore only safe behind something that authenticates callers.
 * A reverse proxy with Basic Auth covers browsers and Home Assistant, but it
 * does *not* cover claude.ai: its custom-connector UI has no field for a
 * password, an API key or a bearer header — it speaks OAuth or nothing, and it
 * connects server-side from Anthropic's cloud rather than from your device.
 *
 * So remote access needs an authorization server. This is a deliberately small
 * one:
 *
 *   - MitID is NOT re-run per connection. Trust in Aula is established once by
 *     `aula login`; the tokens stay encrypted on this machine as before. This
 *     layer only decides *who may talk to the MCP server*.
 *   - The gate is a single operator password, stored as an argon2id hash
 *     (`Bun.password`). No plaintext secret lives in env, config or git.
 *   - Clients register themselves via RFC 7591 dynamic client registration,
 *     which is how claude.ai and Claude Code onboard, and PKCE (S256) is
 *     mandatory — there are no client secrets to leak.
 *
 * Endpoints (all relative to `publicUrl`):
 *   GET  /.well-known/oauth-protected-resource   RFC 9728 — points at the AS
 *   GET  /.well-known/oauth-authorization-server RFC 8414 — AS metadata
 *   POST /register                               RFC 7591 — dynamic client reg
 *   GET  /authorize                              password form
 *   POST /authorize                              password check -> auth code
 *   POST /token                                  code/refresh -> access token
 *
 * Storage note: issued tokens are persisted as SHA-256 *hashes*, never in a
 * recoverable form. That is stronger than encrypting the raw tokens — an
 * attacker who reads the state file (and its key) still cannot mint a working
 * Authorization header. The file therefore holds no secrets at all, only
 * hashes and public client metadata, and is written 0600 regardless.
 *
 * Revocation. Changing the password hash must actually cut off access, and
 * two mechanisms make sure it does:
 *
 *   - The state records a fingerprint of the password hash that issued its
 *     tokens. On startup, a hash that no longer matches wipes every issued
 *     token, so `set-password` + restart genuinely locks everyone out instead
 *     of leaving live tokens behind that outlive the password they came from.
 *   - `aula auth revoke` edits the state file directly, and a *running* server
 *     notices: the file's revision is re-checked on each request, and a change
 *     made behind the server's back is reloaded rather than overwritten. That
 *     matters because the state is otherwise read once at boot and held in
 *     memory — without the re-check, a revoke would report success, change
 *     nothing, and then be silently undone by the next `persist()`.
 */

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  challengeFromVerifier,
  type Logger,
  randomBase64Url,
  sha256,
  silentLogger,
} from '@aula-mcp/aula-auth';
import { type Context, Hono, type MiddlewareHandler } from 'hono';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Access tokens are short-lived; clients refresh silently. */
const ACCESS_TOKEN_TTL_S = 60 * 60;
/** Refresh tokens survive restarts so a reboot doesn't drop the connector. */
const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
/** Authorization codes are single-use and must be redeemed immediately. */
const AUTH_CODE_TTL_S = 60;
/** Registration is unauthenticated by design (RFC 7591), so it is capped. */
const MAX_CLIENTS = 50;
/** Per-registration limits, for the same reason the client list is capped. */
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 512;
/**
 * A just-registered client has no token yet, so it needs its own protection
 * from eviction for as long as pairing plausibly takes — otherwise a flood
 * could knock a connector out of the list between its `/register` and its
 * `/authorize`.
 */
const PAIRING_GRACE_S = 15 * 60;
/** Failed password attempts before each further attempt is slowed down. */
const THROTTLE_AFTER_FAILURES = 5;
const THROTTLE_BASE_MS = 1_000;
const THROTTLE_MAX_MS = 10_000;
/** A failure streak older than this is forgotten. */
const FAILURE_WINDOW_MS = 30 * 60 * 1_000;

/** Paths that must stay reachable without a bearer token. */
const OPEN_PATHS = new Set(['/healthz', '/authorize', '/token', '/register']);

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

export interface RegisteredClient {
  client_id: string;
  client_name?: string | undefined;
  /** Exact-match allowlist. Never prefix-matched — see `redirectUriAllowed`. */
  redirect_uris: string[];
  created_at: number;
  last_used_at: number;
}

export interface IssuedToken {
  /** `sha256(token)` as hex. The raw token is never written down. */
  token_hash: string;
  client_id: string;
  kind: 'access' | 'refresh';
  expires_at: number;
  resource?: string | undefined;
}

export interface AuthState {
  version: 1;
  clients: RegisteredClient[];
  tokens: IssuedToken[];
  /**
   * `sha256(AULA_MCP_AUTH_PASSWORD_HASH)` of the password the tokens below
   * were issued under. Not a secret: deriving it requires the argon2id hash
   * itself (salt included), so anyone able to compute it already holds
   * everything it could protect. It exists so a changed password can be
   * *detected* — see the revocation note in the module docstring.
   */
  password_fingerprint?: string | undefined;
}

export function emptyAuthState(): AuthState {
  return { version: 1, clients: [], tokens: [] };
}

export interface AuthStore {
  load(): Promise<AuthState>;
  save(state: AuthState): Promise<void>;
  /**
   * Cheap fingerprint of the stored state, for spotting edits made outside
   * this process (`aula auth revoke`). Optional: a store that cannot be
   * written behind the server's back simply omits it, and the reload check
   * turns into a no-op.
   */
  revision?(): Promise<string>;
}

/** For tests and ephemeral runs. */
export class MemoryAuthStore implements AuthStore {
  private state: AuthState = emptyAuthState();
  private generation = 0;
  async load(): Promise<AuthState> {
    return this.state;
  }
  async save(state: AuthState): Promise<void> {
    this.state = state;
    this.generation += 1;
  }
  async revision(): Promise<string> {
    return String(this.generation);
  }
}

const DEFAULT_AUTH_FILE = join(homedir(), '.config', 'aula-mcp', 'mcp-auth.json');

/**
 * Plain JSON on disk, 0600. Unencrypted on purpose: the file contains only
 * token *hashes* and public client metadata, so encrypting it would add a key
 * to manage without protecting anything that isn't already one-way hashed.
 */
export class FileAuthStore implements AuthStore {
  readonly filePath: string;
  private readonly logger: Logger;

  constructor(filePath: string = DEFAULT_AUTH_FILE, logger: Logger = silentLogger) {
    this.filePath = filePath;
    this.logger = logger;
  }

  async load(): Promise<AuthState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return emptyAuthState();
      throw e;
    }
    try {
      const parsed = JSON.parse(raw) as AuthState;
      if (parsed.version !== 1) {
        this.logger.warn('mcp-auth.state.unsupported_version', { version: parsed.version });
        return emptyAuthState();
      }
      return {
        version: 1,
        clients: Array.isArray(parsed.clients) ? parsed.clients : [],
        tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
        password_fingerprint:
          typeof parsed.password_fingerprint === 'string' ? parsed.password_fingerprint : undefined,
      };
    } catch (e) {
      // A corrupt state file must not brick the server: the worst case is that
      // clients re-register and the operator logs in again.
      this.logger.error('mcp-auth.state.parse_failed', { error: (e as Error).message });
      return emptyAuthState();
    }
  }

  async save(state: AuthState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), 'utf8');
    try {
      await chmod(this.filePath, 0o600);
    } catch {
      // chmod fails on some filesystems (NTFS shares); non-fatal.
    }
  }

  /**
   * mtime + size, which is enough to notice `aula auth revoke` rewriting the
   * file. A deleted file is a distinct revision rather than an error: removing
   * it by hand is the oldest form of revocation there is, and it should take
   * effect just as promptly.
   */
  async revision(): Promise<string> {
    try {
      const info = await stat(this.filePath);
      return `${info.mtimeMs}:${info.size}`;
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return 'absent';
      throw e;
    }
  }
}

export interface RevokeSummary {
  tokens_revoked: number;
  clients_removed: number;
}

/**
 * Revoke issued access by rewriting the state file.
 *
 * Runs from the CLI, against a server that is very likely live — which is why
 * the provider re-checks the file's revision per request rather than trusting
 * the copy it loaded at boot. Client registrations are kept by default: they
 * are public metadata, not access, and dropping them forces the operator to
 * remove and re-add the connector in claude.ai instead of simply signing in
 * again. `includeClients` is for the case where the registrations themselves
 * are suspect.
 */
export async function revokeAuthState(
  store: AuthStore,
  opts: { includeClients?: boolean } = {},
): Promise<RevokeSummary> {
  const state = await store.load();
  const summary: RevokeSummary = {
    tokens_revoked: state.tokens.length,
    clients_removed: opts.includeClients ? state.clients.length : 0,
  };
  state.tokens = [];
  if (opts.includeClients) state.clients = [];
  await store.save(state);
  return summary;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface McpAuthConfig {
  publicUrl: string;
  passwordHash: string;
}

export interface ResolveAuthConfigResult {
  config: McpAuthConfig | null;
  /** Operator explicitly opted out via AULA_MCP_AUTH_DISABLED=1. */
  disabled: boolean;
  /** Why config is null despite not being explicitly disabled. */
  problem?: string;
}

/**
 * Read auth configuration from the environment.
 *
 *   AULA_MCP_AUTH_PASSWORD_HASH — argon2id hash from `aula auth set-password`
 *   AULA_MCP_PUBLIC_URL         — externally visible base URL, e.g.
 *                                 https://host.tailnet.ts.net/aula
 *   AULA_MCP_AUTH_DISABLED=1    — conscious opt-out (own proxy handles auth)
 */
export function resolveAuthConfig(env: NodeJS.ProcessEnv = process.env): ResolveAuthConfigResult {
  if (env.AULA_MCP_AUTH_DISABLED === '1') return { config: null, disabled: true };

  const passwordHash = env.AULA_MCP_AUTH_PASSWORD_HASH?.trim();
  const publicUrl = env.AULA_MCP_PUBLIC_URL?.trim();
  if (!passwordHash && !publicUrl) return { config: null, disabled: false };
  if (!passwordHash) {
    return { config: null, disabled: false, problem: 'AULA_MCP_AUTH_PASSWORD_HASH is not set' };
  }
  if (!publicUrl) {
    return { config: null, disabled: false, problem: 'AULA_MCP_PUBLIC_URL is not set' };
  }
  let normalized: string;
  try {
    normalized = normalizeBaseUrl(publicUrl);
  } catch (e) {
    return { config: null, disabled: false, problem: (e as Error).message };
  }
  return { config: { publicUrl: normalized, passwordHash }, disabled: false };
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !isLocalHostname(url.hostname)) {
    throw new Error(`AULA_MCP_PUBLIC_URL must be https (got ${url.protocol}//)`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * Secure-by-default gate, mirroring `assertSafeBindAddress`.
 *
 * Exposing the server off-box without *some* authentication hands an anonymous
 * caller full read/write access to a real family's Aula account. Refuse rather
 * than let that happen by omission — but keep an explicit opt-out for operators
 * who front the server with their own authenticated proxy, which is the setup
 * the README documents for Caddy.
 */
export function assertRemoteAuthConfigured(args: {
  allowRemote: boolean;
  auth: ResolveAuthConfigResult;
  onFatal?: (message: string) => never;
  logger?: Logger;
}): void {
  const logger = args.logger ?? silentLogger;
  if (!args.allowRemote) return;
  if (args.auth.config) return;

  if (args.auth.disabled) {
    logger.warn('mcp-auth.disabled_with_remote', {
      note: 'AULA_MCP_ALLOW_REMOTE=1 with AULA_MCP_AUTH_DISABLED=1 — anything that can reach /mcp can drive your Aula account. Only safe behind an authenticated proxy.',
    });
    return;
  }

  const fatal =
    args.onFatal ??
    ((message: string): never => {
      process.stderr.write(message);
      process.exit(2);
    });
  const detail = args.auth.problem ? `\n${args.auth.problem}.\n` : '\n';
  fatal(
    'Refusing to start: AULA_MCP_ALLOW_REMOTE=1 without authentication.' +
      detail +
      'Anyone who reaches /mcp can read your messages and write presence.\n' +
      'Fix one of these:\n' +
      '  1. Run `aula auth set-password`, then set AULA_MCP_AUTH_PASSWORD_HASH\n' +
      '     and AULA_MCP_PUBLIC_URL (the https URL clients connect to).\n' +
      '  2. Set AULA_MCP_AUTH_DISABLED=1 if an authenticated reverse proxy in\n' +
      '     front of this server already does the job.\n',
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface AuthProviderOptions {
  config: McpAuthConfig;
  store?: AuthStore;
  logger?: Logger;
  /** Injectable clock (ms since epoch) for tests. */
  now?: () => number;
  /** Injectable delay, so tests can assert throttling without waiting for it. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AuthProvider {
  /** Mount before the MCP routes. */
  routes: Hono;
  /** Register with `app.use('*', ...)` before the MCP routes. */
  middleware: MiddlewareHandler;
}

interface PendingCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
  resource?: string | undefined;
  scope?: string | undefined;
}

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  state?: string | undefined;
  code_challenge: string;
  code_challenge_method: string;
  response_type: string;
  scope?: string | undefined;
  resource?: string | undefined;
}

export async function createAuthProvider(opts: AuthProviderOptions): Promise<AuthProvider> {
  const logger = opts.logger ?? silentLogger;
  const now = opts.now ?? (() => Date.now());
  const store = opts.store ?? new FileAuthStore(DEFAULT_AUTH_FILE, logger);
  const { publicUrl, passwordHash } = opts.config;

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const state = await store.load();
  /** Authorization codes live for 60 s — memory only, never persisted. */
  const pendingCodes = new Map<string, PendingCode>();
  let failures = 0;
  let lastFailureAt = 0;

  /**
   * Slow guessing down without ever locking the operator out.
   *
   * A hard lockout would be a free denial-of-service: `POST /authorize` needs
   * no credentials in order to *fail*, so anyone who can reach it could keep
   * the one person who actually needs this server permanently locked out. This
   * gate stands between a parent and marking their child sick before school, so
   * availability for the operator is part of the security property, not a
   * trade-off against it. A delay costs an attacker the same wall-clock time it
   * costs the operator, and against the 12-character minimum password even one
   * attempt per second gets nowhere.
   */
  const throttleFailedAttempts = async (): Promise<void> => {
    if (failures === 0) return;
    if (now() - lastFailureAt > FAILURE_WINDOW_MS) {
      // Forget an old streak, so a typo last month costs nothing today.
      failures = 0;
      return;
    }
    if (failures < THROTTLE_AFTER_FAILURES) return;
    const delay = Math.min(
      THROTTLE_BASE_MS * 2 ** (failures - THROTTLE_AFTER_FAILURES),
      THROTTLE_MAX_MS,
    );
    logger.warn('mcp-auth.authorize.throttled', { failures, delay_ms: delay });
    await sleep(delay);
  };

  let knownRevision: string | null = store.revision ? await store.revision() : null;

  const persist = async (): Promise<void> => {
    const cutoff = Math.floor(now() / 1000);
    state.tokens = state.tokens.filter((t) => t.expires_at > cutoff);
    await store.save(state);
    if (store.revision) {
      try {
        knownRevision = await store.revision();
      } catch {
        // Leave the revision unknown; the next sync reloads defensively.
        knownRevision = null;
      }
    }
  };

  /**
   * Adopt any change made to the state file outside this process.
   *
   * Without this the state is read once at boot and never again, so
   * `aula auth revoke` would be worse than useless: it would report success,
   * leave every in-memory token still valid, and then be quietly overwritten
   * by the next `persist()`. A security command that lies is worse than one
   * that does not exist, so the file is re-checked (one `stat`) per request.
   *
   * Pending authorization codes are dropped along with the reload. They live
   * for 60 s in memory only, and honouring one minted before a revoke would
   * hand out fresh tokens immediately after access was withdrawn — the cost is
   * that an in-flight login has to be repeated.
   */
  const syncFromDisk = async (): Promise<void> => {
    if (!store.revision) return;
    let current: string;
    try {
      current = await store.revision();
    } catch (e) {
      logger.warn('mcp-auth.state.revision_failed', { error: (e as Error).message });
      return;
    }
    if (current === knownRevision) return;
    const fresh = await store.load();
    state.clients = fresh.clients;
    state.tokens = fresh.tokens;
    state.password_fingerprint = fresh.password_fingerprint;
    pendingCodes.clear();
    knownRevision = current;
    logger.info('mcp-auth.state.reloaded', {
      clients: state.clients.length,
      tokens: state.tokens.length,
    });
  };

  // A password change must actually take effect. Tokens issued under the old
  // password would otherwise survive it indefinitely, so `set-password` plus a
  // restart would look like a lockout while quietly being none.
  const passwordFingerprint = hashToken(passwordHash);
  if (state.password_fingerprint !== passwordFingerprint) {
    if (state.tokens.length > 0) {
      logger.warn('mcp-auth.password_changed.tokens_revoked', { tokens: state.tokens.length });
    }
    state.tokens = [];
    state.password_fingerprint = passwordFingerprint;
    await persist();
  }

  const findClient = (clientId: string): RegisteredClient | undefined =>
    state.clients.find((c) => c.client_id === clientId);

  // -- routes ---------------------------------------------------------------

  const routes = new Hono();

  // Registered before any route below, so every auth endpoint sees fresh state
  // even where `middleware` is not mounted in front of these routes.
  routes.use('*', async (_c, next) => {
    await syncFromDisk();
    return next();
  });

  const protectedResourceMetadata = {
    resource: `${publicUrl}/mcp`,
    authorization_servers: [publicUrl],
    bearer_methods_supported: ['header'],
  };
  routes.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata));
  // Clients derive the metadata path from the resource path, so /mcp callers
  // ask for `/.well-known/oauth-protected-resource/mcp`.
  routes.get('/.well-known/oauth-protected-resource/*', (c) => c.json(protectedResourceMetadata));

  routes.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/authorize`,
      token_endpoint: `${publicUrl}/token`,
      registration_endpoint: `${publicUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    }),
  );
  // Some clients look for the OpenID-style document at the same origin.
  // Absolute target: behind a path-prefixed reverse proxy a root-relative
  // redirect would land outside the mount point.
  routes.get('/.well-known/openid-configuration', (c) =>
    c.redirect(`${publicUrl}/.well-known/oauth-authorization-server`, 302),
  );

  routes.post('/register', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: 'invalid_client_metadata', error_description: 'body must be JSON' },
        400,
      );
    }
    const meta = body as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
    if (uris.length === 0) {
      return c.json(
        { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' },
        400,
      );
    }
    if (uris.length > MAX_REDIRECT_URIS) {
      return c.json(
        {
          error: 'invalid_redirect_uri',
          error_description: `at most ${MAX_REDIRECT_URIS} redirect_uris are accepted`,
        },
        400,
      );
    }
    const redirectUris: string[] = [];
    for (const uri of uris) {
      if (
        typeof uri !== 'string' ||
        uri.length > MAX_REDIRECT_URI_LENGTH ||
        !isAcceptableRedirectUri(uri)
      ) {
        return c.json(
          {
            error: 'invalid_redirect_uri',
            error_description: `redirect_uri must be https (or http on localhost) and at most ${MAX_REDIRECT_URI_LENGTH} characters`,
          },
          400,
        );
      }
      redirectUris.push(uri);
    }

    const nowSeconds = Math.floor(now() / 1000);
    const client: RegisteredClient = {
      client_id: randomBase64Url(24),
      client_name:
        typeof meta.client_name === 'string' ? meta.client_name.slice(0, 120) : undefined,
      redirect_uris: redirectUris,
      created_at: nowSeconds,
      last_used_at: nowSeconds,
    };
    // Registration needs no credentials by spec, so the list has to be capped.
    // Plain LRU eviction would hand an attacker a free denial-of-service: fill
    // the list with throwaway registrations and the operator's long-paired
    // connector falls out, forcing a manual re-pair. So a client is protected
    // while it holds a live token, or while it is still inside the pairing
    // grace period, and when every slot is protected the new registration is
    // refused instead of displacing anyone.
    //
    // A flood can therefore still block *new* pairings for the length of the
    // grace period. That is the lesser harm, and it cannot be avoided while
    // registration stays uncredentialed: working connectors keep working, and
    // adding one is merely delayed.
    if (state.clients.length >= MAX_CLIENTS) {
      const live = new Set(
        state.tokens.filter((t) => t.expires_at > nowSeconds).map((t) => t.client_id),
      );
      const evictable = state.clients
        .filter(
          (existing) =>
            !live.has(existing.client_id) && nowSeconds - existing.created_at > PAIRING_GRACE_S,
        )
        .sort((a, b) => a.last_used_at - b.last_used_at);
      const needed = state.clients.length - MAX_CLIENTS + 1;
      if (evictable.length < needed) {
        logger.warn('mcp-auth.client.registry_full', { clients: state.clients.length });
        return c.json(
          {
            error: 'invalid_client_metadata',
            error_description: 'client registry is full; every slot is held by an active client',
          },
          503,
        );
      }
      const drop = new Set(evictable.slice(0, needed).map((existing) => existing.client_id));
      state.clients = state.clients.filter((existing) => !drop.has(existing.client_id));
    }
    state.clients.push(client);
    await persist();
    logger.info('mcp-auth.client.registered', {
      client_id: client.client_id,
      client_name: client.client_name,
    });

    return c.json(
      {
        client_id: client.client_id,
        client_id_issued_at: client.created_at,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  });

  /**
   * Validate an /authorize request.
   *
   * Order matters. Until `client_id` and `redirect_uri` are both known-good we
   * must NOT redirect anywhere — that is exactly the open-redirect shape that
   * had to be patched out of the v1/v2 Python servers. Only after the
   * redirect target is proven to be one the client registered do we report
   * errors by redirecting.
   */
  const validateAuthorize = (
    params: URLSearchParams,
  ):
    | { ok: true; params: AuthorizeParams; client: RegisteredClient }
    | { ok: false; message: string }
    | { ok: false; redirect: string } => {
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const client = findClient(clientId);
    if (!client)
      return {
        ok: false,
        message: 'Unknown client_id. Re-add the connector so it can register again.',
      };
    if (!redirectUri || !redirectUriAllowed(client, redirectUri)) {
      return { ok: false, message: 'redirect_uri does not match this client registration.' };
    }

    const state_ = params.get('state') ?? undefined;
    const responseType = params.get('response_type') ?? '';
    const challenge = params.get('code_challenge') ?? '';
    const method = params.get('code_challenge_method') ?? '';

    const fail = (error: string, description: string): { ok: false; redirect: string } => ({
      ok: false,
      redirect: buildRedirect(redirectUri, {
        error,
        error_description: description,
        state: state_,
      }),
    });
    if (responseType !== 'code')
      return fail('unsupported_response_type', 'only response_type=code is supported');
    if (!challenge) return fail('invalid_request', 'code_challenge is required');
    if (method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');

    return {
      ok: true,
      client,
      params: {
        client_id: clientId,
        redirect_uri: redirectUri,
        state: state_,
        code_challenge: challenge,
        code_challenge_method: method,
        response_type: responseType,
        scope: params.get('scope') ?? undefined,
        resource: params.get('resource') ?? undefined,
      },
    };
  };

  routes.get('/authorize', (c) => {
    const url = new URL(c.req.url);
    const result = validateAuthorize(url.searchParams);
    if (!result.ok) {
      if ('redirect' in result) return c.redirect(result.redirect, 302);
      logger.warn('mcp-auth.authorize.rejected', { reason: result.message });
      return c.html(renderErrorPage(result.message), 400);
    }
    return c.html(renderLoginPage(publicUrl, result.params, null));
  });

  routes.post('/authorize', async (c) => {
    const form = await c.req.parseBody();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (typeof value === 'string') params.set(key, value);
    }
    // Re-validate from scratch: the hidden fields are attacker-controlled, and
    // only the stored client registration decides where we may redirect.
    const result = validateAuthorize(params);
    if (!result.ok) {
      if ('redirect' in result) return c.redirect(result.redirect, 302);
      return c.html(renderErrorPage(result.message), 400);
    }

    await throttleFailedAttempts();

    const password = params.get('password') ?? '';
    const ok = await verifyPassword(password, passwordHash, logger);
    if (!ok) {
      failures += 1;
      lastFailureAt = now();
      logger.warn('mcp-auth.authorize.password_rejected', { failures });
      return c.html(renderLoginPage(publicUrl, result.params, 'Forkert kodeord.'), 401);
    }

    failures = 0;

    const code = randomBase64Url(32);
    pendingCodes.set(code, {
      client_id: result.params.client_id,
      redirect_uri: result.params.redirect_uri,
      code_challenge: result.params.code_challenge,
      expires_at: now() + AUTH_CODE_TTL_S * 1000,
      resource: result.params.resource,
      scope: result.params.scope,
    });
    result.client.last_used_at = Math.floor(now() / 1000);
    await persist();
    logger.info('mcp-auth.authorize.granted', { client_id: result.params.client_id });

    return c.redirect(
      buildRedirect(result.params.redirect_uri, { code, state: result.params.state }),
      302,
    );
  });

  routes.post('/token', async (c) => {
    const form = await c.req.parseBody();
    const get = (key: string): string => {
      const value = form[key];
      return typeof value === 'string' ? value : '';
    };
    const grantType = get('grant_type');

    if (grantType === 'authorization_code') {
      const code = get('code');
      const pending = pendingCodes.get(code);
      // Single-use: burn the code whether or not the rest validates.
      pendingCodes.delete(code);
      if (!pending) return tokenError(c, 'invalid_grant', 'unknown or already-used code');
      if (pending.expires_at < now()) return tokenError(c, 'invalid_grant', 'code expired');
      if (pending.client_id !== get('client_id')) {
        return tokenError(c, 'invalid_grant', 'code was issued to a different client');
      }
      if (pending.redirect_uri !== get('redirect_uri')) {
        return tokenError(
          c,
          'invalid_grant',
          'redirect_uri does not match the authorization request',
        );
      }
      const verifier = get('code_verifier');
      if (
        !verifier ||
        !constantTimeEquals(challengeFromVerifier(verifier), pending.code_challenge)
      ) {
        return tokenError(c, 'invalid_grant', 'PKCE verification failed');
      }
      const issued = await issueTokens(pending.client_id, pending.resource);
      logger.info('mcp-auth.token.issued', { client_id: pending.client_id, grant: 'code' });
      return tokenResponse(c, issued);
    }

    if (grantType === 'refresh_token') {
      const hash = hashToken(get('refresh_token'));
      const record = state.tokens.find((t) => t.kind === 'refresh' && t.token_hash === hash);
      if (!record) return tokenError(c, 'invalid_grant', 'unknown refresh token');
      // Rotate: a refresh token is spent the moment it is presented, whether or
      // not it turns out to still be valid.
      state.tokens = state.tokens.filter((t) => t !== record);
      if (record.expires_at <= Math.floor(now() / 1000)) {
        await persist();
        return tokenError(c, 'invalid_grant', 'refresh token expired');
      }
      const issued = await issueTokens(record.client_id, record.resource);
      logger.info('mcp-auth.token.issued', { client_id: record.client_id, grant: 'refresh' });
      return tokenResponse(c, issued);
    }

    return tokenError(c, 'unsupported_grant_type', `unsupported grant_type: ${grantType}`);
  });

  async function issueTokens(
    clientId: string,
    resource: string | undefined,
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    const accessToken = randomBase64Url(32);
    const refreshToken = randomBase64Url(32);
    const issuedAt = Math.floor(now() / 1000);
    // Touch the client on every grant, refreshes included. Without this a
    // long-paired connector looks idle to the eviction rule above — after the
    // initial /authorize it only ever speaks to /token.
    const client = state.clients.find((existing) => existing.client_id === clientId);
    if (client) client.last_used_at = issuedAt;
    state.tokens.push({
      token_hash: hashToken(accessToken),
      client_id: clientId,
      kind: 'access',
      expires_at: issuedAt + ACCESS_TOKEN_TTL_S,
      resource,
    });
    state.tokens.push({
      token_hash: hashToken(refreshToken),
      client_id: clientId,
      kind: 'refresh',
      expires_at: issuedAt + REFRESH_TOKEN_TTL_S,
      resource,
    });
    await persist();
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_TTL_S,
    };
  }

  // -- middleware -----------------------------------------------------------

  const middleware: MiddlewareHandler = async (c, next) => {
    // Before the open-path shortcut: this is the one hook that runs for every
    // request, so it is also where a revoke made behind our back gets noticed.
    await syncFromDisk();
    const path = new URL(c.req.url).pathname;
    if (OPEN_PATHS.has(path) || path.startsWith('/.well-known/')) return next();

    const header = c.req.header('authorization') ?? '';
    const presented = /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1];
    if (!presented) return unauthorized(c, publicUrl, 'missing bearer token');

    const hash = hashToken(presented);
    const record = state.tokens.find((t) => t.kind === 'access' && t.token_hash === hash);
    if (!record) return unauthorized(c, publicUrl, 'unknown token');
    // `record.resource` (RFC 8707) is carried through from the authorization
    // request but deliberately not enforced: this server exposes exactly one
    // protected resource, so an audience check has nothing to distinguish. It
    // is persisted so that a future second resource can start enforcing it
    // without invalidating tokens issued before that change.
    if (record.expires_at <= Math.floor(now() / 1000)) {
      return unauthorized(c, publicUrl, 'token expired');
    }
    return next();
  };

  return { routes, middleware };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Exact string match, deliberately. Prefix or `startsWith` matching on
 * redirect URIs is how open redirects happen — `https://claude.ai/callback`
 * would otherwise also accept `https://claude.ai/callback.attacker.example`.
 */
export function redirectUriAllowed(client: RegisteredClient, candidate: string): boolean {
  return client.redirect_uris.some((uri) => uri === candidate);
}

/** https everywhere; http only for loopback, which local clients need. */
export function isAcceptableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLocalHostname(url.hostname);
}

export function hashToken(token: string): string {
  return sha256(token).toString('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function verifyPassword(password: string, hash: string, logger: Logger): Promise<boolean> {
  if (!password) return false;
  try {
    return await Bun.password.verify(password, hash);
  } catch (e) {
    // A malformed hash must fail closed, and loudly — otherwise the operator
    // sees "wrong password" forever without knowing why.
    logger.error('mcp-auth.password.hash_invalid', { error: (e as Error).message });
    return false;
  }
}

function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function tokenError(c: Context, error: string, description: string): Response {
  return c.json({ error, error_description: description }, 400, { 'Cache-Control': 'no-store' });
}

function tokenResponse(
  c: Context,
  issued: { access_token: string; refresh_token: string; expires_in: number },
): Response {
  return c.json({ ...issued, token_type: 'Bearer' }, 200, { 'Cache-Control': 'no-store' });
}

function unauthorized(c: Context, publicUrl: string, reason: string): Response {
  // RFC 9728: point the client at the resource metadata so it can discover the
  // authorization server and start the flow on its own.
  return c.json({ error: 'unauthorized', error_description: reason }, 401, {
    'WWW-Authenticate': `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`,
  });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100vh; background: Canvas; color: CanvasText; }
  main { width: min(24rem, 90vw); padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  label { display: block; font-size: .85rem; margin-bottom: .35rem; }
  input { width: 100%; padding: .6rem .7rem; font-size: 1rem; box-sizing: border-box;
          border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); border-radius: .4rem;
          background: Canvas; color: CanvasText; }
  button { width: 100%; margin-top: 1rem; padding: .65rem; font-size: 1rem; border: 0;
           border-radius: .4rem; background: CanvasText; color: Canvas; cursor: pointer; }
  .err { margin-top: 1rem; padding: .6rem .7rem; border-radius: .4rem; font-size: .9rem;
         background: color-mix(in srgb, red 15%, transparent); }
`;

function page(title: string, inner: string): string {
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body><main>${inner}</main></body>
</html>`;
}

function renderLoginPage(publicUrl: string, params: AuthorizeParams, error: string | null): string {
  const hidden = (
    [
      'client_id',
      'redirect_uri',
      'state',
      'code_challenge',
      'code_challenge_method',
      'response_type',
      'scope',
      'resource',
    ] as const
  )
    .map((key) => {
      const value = params[key];
      return value === undefined
        ? ''
        : `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`;
    })
    .join('\n');
  return page(
    'Log ind — aula-mcp',
    `<h1>aula-mcp</h1>
<p class="sub">Indtast serverens kodeord for at give denne klient adgang.</p>
<form method="post" action="${escapeHtml(publicUrl)}/authorize">
${hidden}
<label for="password">Kodeord</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Giv adgang</button>
</form>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}`,
  );
}

function renderErrorPage(message: string): string {
  return page(
    'Afvist — aula-mcp',
    `<h1>Anmodningen blev afvist</h1><p class="sub">${escapeHtml(message)}</p>`,
  );
}
