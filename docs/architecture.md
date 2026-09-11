# Architecture

Design rationale for the choices that aren't obvious from reading the code. The README covers _what_ the project does; this doc covers _why_ it's shaped this way.

## Why a monorepo

The package layout mirrors layered responsibility, with a strict one-way dependency direction:

```
aula-auth  →  aula-client  →  mcp-server
                                  ↑
                                apps/cli
```

- `aula-auth` knows about MitID, SRP, OAuth/SAML, cookies, and the encrypted token store. It does not know what an Aula API call looks like.
- `aula-client` knows about Aula's REST API and integration plugins. It does not know about MCP, Hono, or the CLI.
- `mcp-server` and `apps/cli` are leaves — they wire the two libraries together for two different transports (MCP-over-HTTP and a terminal).

Keeping the layers separate means:

- The auth package can be reused by anyone who wants Aula tokens without buying into MCP.
- A bug report can usually be triaged into one package without reading the others.
- Tests live next to source and import only their own layer's internals — `*.test.ts` files in `aula-auth` don't reach into `aula-client`.

A monorepo (vs. four separate repos) is right because the layers move together. The MitID flow can change tomorrow; the Aula API version drifts every few months; both ripple downward. Versioning four packages independently would create lockstep busywork without buying anything.

## Why Bun + pnpm split

`packageManager` is `pnpm@10.12.1`. Tests and dev scripts run under Bun. Two tools, two roles:

- **pnpm installs.** Workspace resolution, hoisting policy (`.npmrc` opts into the strict default), the lockfile that CI freezes against. Bun's installer doesn't yet match pnpm's strictness for this workspace.
- **Bun runs.** Bun executes `.ts` directly, so dev has no build step. `bun test` runs the test suite (currently 112 cases) without a transpiler, watch-mode, or config file. The CLI uses `bun --filter` indirectly via pnpm scripts.

Node 22 is installed only for `tsc -p tsconfig.json --noEmit` — TypeScript 6 is the type-checker, not the runtime.

If you're used to a Node + npm + ts-node setup: the split feels unusual but the rationale is mechanical. Use the tool that's best at the job and move on.

## Why we own the MitID flow

The Python reference (`scaarup/aula`) historically used a headless browser to drive MitID. We don't, because:

- **Dependency footprint.** Playwright pulls 300 MB of Chromium per platform. For a CLI that runs a login once a week and otherwise just refreshes OAuth tokens, that's absurd.
- **Auditability.** `wire-tracer.ts` produces a JSONL transcript of every HTTP exchange. With a real browser, the actual SRP / flowValueProof / SAML steps happen inside the browser process and are invisible to us. Owning the HTTP/SRP layer means a `--debug` transcript captures the entire auth chain, which is what makes upstream issues reproducible.
- **Failure modes.** When MitID changes, a headless-browser flow tends to fail with "selector not found" or "page load timeout" — useless errors. Our implementation fails with "SRP step 3 returned status 401, body: ..." or "RelayState missing from SAML response" — actionable errors that point at a specific line.
- **Cost.** No subprocess, no port allocation, no shutdown lifecycle to manage. The auth package is pure HTTP + crypto.

The cost is that we have to track MitID's protocol changes ourselves. So far that's been worth it; the protocol is stable on the order of months, and the wire-trace tooling makes diagnosis fast.

## Why custom-prime SRP rather than RFC group

Aula's SRP-6a uses a 3072-bit prime that is **not** any of the RFC 5054 groups. We don't get a vote; the server picks the group. `srp.ts` ships the constants Aula sends and a from-scratch SRP-6a implementation against them.

Two consequences:

- We can't drop in `node-srp` or any off-the-shelf SRP library — they assume RFC groups.
- Subtle drift in the algorithm (padding rules, hash inputs) silently breaks login with a useless "M1 mismatch" from the server. To prevent that, `srp.test.ts` runs **golden vectors** generated from the Python reference with a pinned random `a`. Don't touch the SRP algorithm without re-generating those vectors.

## Token storage decisions

`EncryptedFileTokenStore` writes AES-256-GCM-encrypted JSON at `~/.config/aula-mcp/tokens.json` (mode `0600`). The encryption key is resolved in this order:

1. an explicit `Buffer` passed to the constructor — strongest, intended for callers that read from a system keychain,
2. `process.env.AULA_MCP_KEY` — hex (64 chars) or arbitrary passphrase (SHA-256-derived),
3. a generated key file at `~/.config/aula-mcp/.key` (`chmod 600`) — convenience fallback. We log a warning that 1 or 2 are stronger.

### Why not OS Keychain in v0.1

Three reasons:

- **Cross-platform.** macOS Keychain, GNOME Keyring, KWallet, Windows Credential Manager — four bindings, four edge cases, four ways to fail in CI. Not worth shipping until v0.1 has been used in anger.
- **Headless boxes.** Many users will run the MCP server on a NAS or VPS where no keychain daemon exists. The file-key fallback works everywhere.
- **Composability.** A caller _can_ already read from the keychain themselves and pass the result via option 1. We aren't blocking that path; we're just not bundling a keychain dependency.

Plan: add a thin platform-specific shim (probably `keytar`-shaped) once the auth flow has stabilised against the live service.

## Why the `aula.discover` first pattern

MCP clients expect a tool tree. Hard-coding one would make the agent's behaviour brittle:

- A user with one child shouldn't see eight per-child variants of every tool.
- A school using EasyIQ shouldn't have Meebook tools cluttering the menu.
- Adding a new integration plugin shouldn't require changing the agent's system prompt.

Instead, agents call `aula.discover` once. They get back a typed manifest — children, institutions, the active API version, and a `capabilities` map listing which subordinate tools are usable for this user. The agent picks from that menu dynamically. New integrations become available the moment they're registered server-side; no agent change required.

The convention is documented in `examples/claude-config/README.md`: tell the agent in its system prompt to call `aula.discover` first.

## Bake-ins from upstream issues

The Python reference has accumulated lessons in its issue tracker. The README has the full table; the rationales here:

- **#311 — widget JWT goes dead.** The `getAulaToken` response is a short-lived JWT for a third-party widget (Min Uddannelse, EasyIQ, Meebook, Systematic). When it expires the upstream returns a JSON body with `{"message":"JWT-Token expired..."}` and a 200 status (not a 401), so naive callers don't notice. `WidgetTokenManager.withRetry` runs the call, detects the expiry shape, refreshes once, and retries. Implemented inside the manager, not at every call site, so plugin authors can't forget.
- **#246, #248 — API version drifts.** Aula's `/api/v{N}/` constant bumps every few months. `AulaClient` probes lazily on first use, retries once on `410` mid-session, and fires an `onApiVersionChanged` callback so consumers can log it.
- **#310 — RelayState missing from Level-3 SAML response.** Some MitID step-up responses omit the `RelayState` form field. `extractSamlForm` returns `hadRelayState: false` and an empty string instead of throwing. Downstream code already tolerates that.
- **#306, #287 — confirmation form returns 200 instead of 302.** `post-broker-login` sometimes returns a 200 with an HTML confirmation form ("are you sure you want to log in as X?") instead of redirecting. `detectConfirmationForm` finds `button#confirmation-button`, submits its parent form, then continues the chain.
- **#290, #351 — `password`/`token` required for auth methods that don't need them.** APP method needs no password, only a username + the QR scan. `AulaLoginOptions` only demands fields that the chosen `method` actually uses.
- **Sensitive messages (status.code 403).** Aula's messaging API returns `status.code = 403` for sensitive threads that need MitID step-up. We surface this as a typed `AulaStepUpRequiredError`; the MCP tool returns a structured `step_up_required` JSON instead of empty data, which is what the agent actually needs to react.

See the README's table for issue links.

## Wire-trace + sanitisation

`--debug` tees a JSONL transcript of every request/response to `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl`. The redaction lists live in `wire-tracer.ts` (`SECRET_HEADERS`, `SECRET_BODY_FIELDS`, `SECRET_URL_PARAMS`).

What's redacted:

- **Headers**: `authorization`, `aula-authorization`, `cookie`, `set-cookie`, `csrfp-token`, `x-csrf-token`.
- **Body fields** (form-urlencoded or JSON): passwords, MitID auth codes, OAuth codes/tokens, code verifiers, SAMLResponse, RelayState, anti-forgery tokens, session UUIDs, M1, flowValueProof, randomA, identityClaim, chosenOptionJson.
- **URL query params**: `access_token`, `refresh_token`, `code`, `code_verifier`, `state`, `mitidauthcode`, `__requestverificationtoken`, `ticket`, `session_code`.

What is _not_ redacted: structural fields (`status.code`, error messages, redirect URLs minus their secret query params, HTTP method/host/path), and timing. These are what makes a transcript diagnosable.

### Why URL query params needed sanitising too

Aula passes `access_token` as a query parameter (not a `Bearer` header — their choice, not ours). Without `SECRET_URL_PARAMS`, every API URL in the transcript would leak the JWT in plaintext. Same for OAuth `code` on the callback URL. Sanitising headers + body alone is not enough.

The redacted form is `<redacted N chars>` where `N` is the original length, so the trace still tells you "yes there was a token here" without revealing it. That's the right trade-off for a file the user is going to paste into a GitHub issue.

## Remote access: why there is an OAuth server in here

The server is single-user: anyone who reaches `/mcp` effectively *is* the
logged-in Aula parent. `assertSafeBindAddress` therefore refuses non-loopback
binds unless `AULA_MCP_ALLOW_REMOTE=1`, and the README's answer for remote use
is a reverse proxy with Basic Auth. That covers a phone on the LAN and Home
Assistant. It does not cover claude.ai.

claude.ai's custom-connector UI takes a URL and, under Advanced settings, an
OAuth client ID/secret. There is no field for a password, an API key, or a
bearer header, and the connection is made server-side from Anthropic's cloud
rather than from the user's browser — so a proxy that challenges the caller
gets no credentials back. For that client the choice is authenticated OAuth or
an endpoint with no authentication at all, protected only by the secrecy of its
URL. `mcp-auth.ts` exists so the first option is available.

**MitID is not part of it.** Trust in Aula is established once by `aula login`
and lives on in the encrypted token store, exactly as before. Re-running the
MitID flow per client connection would mean rebuilding the hardest part of the
login stack behind a second protocol, to re-prove something the server already
knows. The authorization server answers a narrower question: *may this client
talk to the MCP server at all?* The gate is one operator password, hashed with
argon2id via `Bun.password` and supplied as `AULA_MCP_AUTH_PASSWORD_HASH`, so no
plaintext secret sits in env, config, or git.

Design points worth keeping:

- **Secure by default.** `AULA_MCP_ALLOW_REMOTE=1` without either the built-in
  auth or an explicit `AULA_MCP_AUTH_DISABLED=1` is a startup failure, not a
  warning. Exposing a real family's account is not something to do by omission.
  The opt-out remains for operators who genuinely do front it with an
  authenticated proxy.
- **Exact-match redirect URIs.** `redirectUriAllowed` compares full strings and
  nothing else. Prefix matching is how open redirects happen, and errors are
  only reported *via* the redirect once the target has been proven to be one
  the client registered — before that, the browser gets an error page.
- **PKCE S256 is mandatory and there are no client secrets.** Clients onboard
  through RFC 7591 dynamic registration, which is what claude.ai and Claude
  Code do; a public client plus PKCE means there is no long-lived shared
  secret to leak. Registration is uncredentialed by spec, so the client list
  is capped and LRU-evicted.
- **Tokens are stored as SHA-256 hashes, not ciphertext.** Encrypting issued
  tokens would mean managing a key that can turn them back into working
  `Authorization` headers. Hashing removes that possibility entirely: the state
  file at `~/.config/aula-mcp/mcp-auth.json` holds no secret, only hashes and
  public client metadata. It is still written `0600`, and refresh tokens rotate
  on every use.
- **Availability for the operator is part of the security property.** Two
  places would otherwise let an unauthenticated stranger deny service to the
  one person the server exists for — someone who may need to mark a child sick
  before school. A hard lockout after failed passwords would do it, since
  `POST /authorize` needs no credentials in order to *fail*; instead attempts
  are progressively delayed and the right password always works. Plain LRU
  eviction of registered clients would do it too, since `/register` is
  uncredentialed: a flood would push the paired connector out of the list. So a
  client is protected while it holds a live token or is still pairing, and a
  full registry refuses new registrations rather than displacing anyone. The
  residual cost — a flood can delay *new* pairings by the grace period — is the
  lesser harm and is unavoidable while registration stays uncredentialed.
- **`/healthz` stays open.** Uptime monitors have no token, and the endpoint
  answers liveness and nothing else.
- **Absolute URLs everywhere.** The issuer, the metadata documents and the
  login form's action all derive from `AULA_MCP_PUBLIC_URL`, so a path-prefixed
  reverse proxy (`https://host/aula/mcp`) works without rewriting bodies.

## Revocation: making a password change mean something

The authorization server holds its state in memory, loaded once at boot. That is fine until you
need to *withdraw* access, at which point it is the whole problem: an operator who edits
`mcp-auth.json` to cut someone off changes nothing, and the next `persist()` writes the old state
back over the edit. A revoke that silently fails is worse than no revoke at all — it tells you
you are safe while you are not.

Two mechanisms close that gap, deliberately from different directions:

- **A password fingerprint in the state.** The state records `sha256` of the password hash its
  tokens were issued under. A hash that no longer matches at startup wipes every token. So
  `aula auth set-password` + restart genuinely locks everyone out, rather than leaving live
  sessions that outlive the password they came from. The fingerprint is not a secret: computing
  it requires the argon2id hash itself, salt included, so anyone who can derive it already holds
  everything it might protect.
- **A revision check per request.** `aula auth revoke` writes the file from a separate process,
  and the server compares the file's mtime+size before each request, reloading when it differs.
  One `stat` per request buys a revoke that takes effect immediately, on a running service, with
  no restart and no race against the server's own writes. Pending authorization codes are dropped
  along with the reload — honouring a code minted before a revoke would hand out fresh tokens
  seconds after access was withdrawn.

Client registrations survive a plain revoke. They are public metadata, not access, and dropping
them turns "sign in again" into "remove and re-add the connector in claude.ai". `--clients` is
there for when the registrations themselves are what you distrust.

## CPR stays on this side of the tool boundary

Tabulex identifies a child by their real CPR number: it is the path segment in every Fravær URL
and the single field `MeldSyg` PUTs. `wire-tracer.ts` already redacts it from `--debug`
transcripts, but that only covers the trace. The tool *results* were a second, unredacted path —
`tabulex_boern` returned `cpr` as a field and again inside the untouched `raw` object, and every
other Fravær tool then took the CPR back as an input parameter.

That is a real exposure, not a theoretical one. Everything a tool returns goes to whichever model
is driving the server and lands in a conversation history the operator does not control. A
child's CPR is a different category of data from "was he away on Tuesday", and nothing about
reporting a child sick actually needs the number — only the ability to say *which* child.

So the tool layer trades in an opaque `child_ref` (`tbx_…`) and keeps the ref→CPR map in memory
for the life of the process. Refs are deliberately not persisted: one that survived a restart
would be a CPR cache on disk under another name. Two supporting choices:

- The child entry is built from an **allowlist**, not by deleting the CPR from the upstream
  object. A field added upstream is withheld until someone decides it should travel. That also
  drops `foedselsdato` — the first six digits of the CPR — along with `pige` and
  `skoleBestyrelsesValgAdgang`, none of which do anything for absence reporting.
- `raw` is stripped from the day records too. It exists so the library loses nothing from a
  response whose shape on an actual absence day has never been observed — which is exactly why it
  cannot be asserted to be CPR-free. `TabulexClient` still returns it; the boundary is drawn at
  the tool layer, where data leaves the machine, not in the client that models the API.

## Where this leaves us

v0.1 is built and unit-tested. The next step is exercising the live MitID flow end-to-end and catching whatever didn't survive contact with reality. The wire-trace tooling exists precisely to make that loop short.
