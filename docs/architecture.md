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

## The Tabulex session: shared, reusable, and recoverable

The Tabulex session is a WS-Federation `FedAuth` cookie that lives in the **shared** cookie jar on
`AulaContext`'s single `AulaHttpClient` — not on a `TabulexClient` instance. `getTabulex()` hands out
a fresh client per call, so its `sessionEstablished` flag starts `false` every time. Until 2026-10
`ensureSession()` checked only that flag, which meant every single Fravær tool call re-ran the full
6-8-request SSO handshake: measured live 2026-10-02 as **27 HTTP calls for 4 tool calls**.

`ensureSession()` now checks the jar before handshaking. That alone was not enough, and the gap is
worth remembering because it is the kind that hides for weeks:

- **A FedAuth cookie carries no client-visible expiry.** The jar keeps handing it out long after
  Tabulex has forgotten the session. With only the jar check, the handshake would never run again
  for the lifetime of the process — and this server runs for days — so a dead session wedged until
  restart, surfacing as a bare `status N` or a JSON parse error (a sign-in page answered with 200
  and handed to `JSON.parse`) rather than as "session expired". `callWithSession()` therefore
  retries **once**: on a failure that looks like a dead session, it removes the FedAuth cookies,
  re-handshakes and repeats the call. Only a session it did *not* just create is retried — if the
  handshake ran in this very call and the request still failed, the failure is real, and retrying
  would just double the load on the school's IdP.
- **`reportSick` is deliberately excluded from that retry.** Tabulex has no undo for it, and a write
  that failed after landing is indistinguishable from one that never landed. The tool layer reads
  the state back instead.
- **A token switch has to drop the session.** `invalidate()` cannot clear the jar synchronously, so
  it sets `tabulexSessionStale`; the next `getTabulex()` clears the FedAuth cookies before handing
  out the client. Without this, the next guardian's first Fravær call would adopt the previous
  login's session — the same hole the profiles cache guards against, one layer down.

Removal is by cookie name, scoped to Tabulex's host: clearing a Tabulex session must never log the
user out of Aula itself, since both live in the one shared jar. `AulaCookieJar.removeCookies()`
exists for this — before it, the jar could store and read cookies but never delete one, which is
precisely why a dead session had no way back.

Note that this applies to the Streamable HTTP transport. The legacy `/sse` path builds its own
`AulaContext` per session (`setup.ts`), so each SSE session has its own jar and re-handshakes once;
neither the shared session nor the profiles cache reaches it.

## Wire-trace + sanitisation

`--debug` tees a JSONL transcript of every request/response to `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl`. The redaction lists live in `wire-tracer.ts` (`SECRET_HEADERS`, `SECRET_BODY_FIELDS`, `SECRET_URL_PARAMS`).

What's redacted:

- **Headers**: `authorization`, `aula-authorization`, `cookie`, `set-cookie`, `csrfp-token`, `x-csrf-token`.
- **Body fields** (form-urlencoded or JSON): passwords, MitID auth codes, OAuth codes/tokens, code verifiers, SAMLResponse, RelayState, anti-forgery tokens, session UUIDs, M1, flowValueProof, randomA, identityClaim, chosenOptionJson, CPR, `wresult` (WS-Federation's SAMLResponse equivalent — the Tabulex SSO handshake's security token).
- **URL query params**: `access_token`, `refresh_token`, `code`, `code_verifier`, `state`, `mitidauthcode`, `__requestverificationtoken`, `ticket`, `session_code`, `authstate` (Tabulex SSO's short-lived state correlator), `wctx` (WS-Federation's `state` equivalent).

What is _not_ redacted: structural fields (`status.code`, error messages, redirect URLs minus their secret query params, HTTP method/host/path), and timing. These are what makes a transcript diagnosable.

### The same tracer, wired into the long-running server

`--debug` above is the CLI's path (`aula login`/`aula doctor`): it builds an `InMemoryTracer` or `JsonlFileTracer` and passes it to a one-shot `AulaHttpClient`. Until 2026-10, `packages/mcp-server/src/server.ts` never did the equivalent — `AulaContext` always built its `AulaHttpClient` with no `tracer` option, so it silently used `AulaHttpClient`'s own noop default. The only server-side visibility was `AULA_MCP_LOG=1`, which logs `http.request` (method + sanitised URL) from `logger.debug` calls in `http.ts` — no status, no duration, no response body, because that line is independent of the tracer. Confirmed live 2026-10-02: a 35-request Tabulex SSO + absence-report session produced 35 `http.request` log lines and zero way to tell which of them succeeded.

`packages/mcp-server/src/trace-config.ts` closes that gap: `AULA_MCP_TRACE_FILE=/path/to/file.jsonl`, read at boot, builds a `JsonlFileTracer` and passes it into `AulaContext`'s constructor, which forwards it to the shared `AulaHttpClient` every integration plugin (Aula, Tabulex, EasyIQ, Meebook, Min Uddannelse, Systematic) uses. Unset (the default): `createHttpTracer` returns `undefined`, `AulaContext` omits the `tracer` option, and `AulaHttpClient` falls back to its noop exactly as before this file existed — no behaviour change for a server that doesn't opt in.

The trace file:

- Is created (or reused) with **mode 0600** at boot, via `ensureTraceFileWritable` — not lazily on first write, so a path the process can't write to (bad parent dir, read-only filesystem) fails startup loudly instead of the server coming up "healthy" and then dropping every trace entry for a debugging session that looked like it was working.
- Contains the **same sanitised shape** as a CLI `--debug` transcript — one JSON object per HTTP exchange, redacted by the same `SECRET_HEADERS`/`SECRET_BODY_FIELDS`/`SECRET_URL_PARAMS` lists in `wire-tracer.ts`, including the CPR-shaped-path-segment redaction Tabulex's Fravær API needs (see below).
- Is **append-only and unbounded** — nothing in this server rotates, caps, or truncates it. It grows for as long as `AULA_MCP_TRACE_FILE` stays set. An operator enabling it for a debugging session is expected to unset the variable and remove/rotate the file afterwards; this is a diagnostic switch, not a standing audit log.
- Covers **both transports**: the shared Streamable HTTP context (`sharedContext` in `server.ts`) and, separately, each legacy `/sse` session's own per-connection `AulaContext`.

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
  and the server compares a hash of the file's content before each request, reloading when it
  differs. The first version compared mtime+size instead; it passed on Windows and failed on the
  Linux host, where the kernel stamps file times on a coarse tick and a same-size rewrite within
  that tick is invisible. A revoke also always bumps `revoked_at`, so it changes the content even
  when there is nothing left to remove. One small read per request buys a revoke that takes effect
  immediately, on a running service, with no restart.

An independent review then found the mirror image of the first bug: a revoke landing between the
server's own write and its revision read was adopted as the server's revision, leaving a token
issued in that same request valid in memory. `save()` now returns the revision of exactly what
it wrote, and `persist()` syncs before writing and re-syncs if the file afterwards holds anything
else — the external change wins. One gap is left deliberately: the sub-millisecond window
between that first sync and the write. Closing it for certain needs a file lock shared with the
CLI, which was judged disproportionate for a command an operator runs by hand. Pending authorization codes are dropped
  along with the reload — honouring a code minted before a revoke would hand out fresh tokens
  seconds after access was withdrawn.

Client registrations survive a plain revoke. They are public metadata, not access, and dropping
them turns "sign in again" into "remove and re-add the connector in claude.ai". `--clients` is
there for when the registrations themselves are what you distrust.

## Streamable HTTP sessions: one transport per client

The first deployment authenticated against claude.ai perfectly and then showed no tools. The cause
was in `server.ts`, not the auth layer: it connected a single stateful transport at boot, and a
stateful transport accepts exactly one `initialize` in its lifetime. The first client owned the
server until it restarted; every later one — a second device, a new tab, claude.ai simply
reconnecting — got `400 Server already initialized`, never received a session id, and had every
following call refused.

`mcp-sessions.ts` gives each client its own server and transport, keyed by `mcp-session-id`. An
unknown session id gets 404, which the MCP spec defines as "start a new session", so an evicted or
restarted session recovers without anyone noticing. Idle sessions are swept, and a full map evicts
its least recently active session rather than refusing the new one — only authenticated callers
reach this code, and a refusal would turn a busy moment into a lockout.

Eviction has one hard exception: a session with a request in flight is never closed. The SDK's
`close()` drops a pending JSON response without resolving it, so evicting a busy session does not
fail its call — it hangs it forever. When every session is busy the cap is exceeded briefly
instead. The cap is enforced after a session has landed, not reserved before `initialize`: a
reservation could only evict sessions that already existed, so a burst of concurrent initializes
against a near-empty map found nothing to evict and every one of them got in. A session counts as
busy until its own `initialize` response is out, so a burst cannot evict a session mid-handshake.

All sessions share one `AulaContext`. Each context de-duplicates its own token refresh; one context
per session would let several sessions refresh Aula's tokens at once, and a rotating refresh token
lets the loser of that race invalidate the winner. It also makes `child_ref` handles per session:
a ref minted in one conversation means nothing in another.

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
for the life of the MCP session. Refs are deliberately not persisted: one that survived a restart
would be a CPR cache on disk under another name. Two supporting choices:

- The child entry is built from an **allowlist**, not by deleting the CPR from the upstream
  object. A field added upstream is withheld until someone decides it should travel. That also
  drops `foedselsdato` — the first six digits of the CPR — along with `pige` and
  `skoleBestyrelsesValgAdgang`, none of which do anything for absence reporting.
- `raw` is stripped from the day records too. It exists so the library loses nothing from a
  response whose shape on an actual absence day has never been observed — which is exactly why it
  cannot be asserted to be CPR-free. `TabulexClient` still returns it; the boundary is drawn at
  the tool layer, where data leaves the machine, not in the client that models the API.

### Failures are part of the boundary

The first version of this boundary was verified field by field — on successful responses only.
Review found two other exits. A tool handler that throws has its `error.message` returned to the
client verbatim, and Tabulex errors embedded the request URL with the CPR in it; and
`AulaHttpClient` logged raw URLs, so `AULA_MCP_LOG=1` would have written the CPR — and Aula's
`access_token` — to journald. Both now go through `sanitizeUrl`, and the tool layer wraps the
Tabulex client in a proxy that strips anything CPR-shaped from any error, so a tool added later is
covered without anyone remembering a `catch`. `meld_syg` passes nothing of Tabulex's response on.
The lesson generalises: checking what a boundary returns is not the same as checking everything
that crosses it.

## Sending messages: drafts, cross-checks, read-back

Messages are the first tools whose output other people read, so "the model asked for it" cannot be
what triggers a send. Three mechanisms carry that, the same for a reply, a reply in a sensitive
thread and a new thread.

**A draft the model cannot invent.** `prepare_*` sends nothing; it returns a `draft_ref` and the
exact preview the user has to see. `send_*` takes only that ref. Refs live in process memory for
five minutes and are taken out of the store *before* the send, so a send that fails halfway — where
Aula may or may not have posted — cannot be retried into a duplicate with the same ref. A
`confirm: true` argument would not do this: the model can set it itself.

**Two sources agree on the address, or nothing is drafted** — for a reply and a new thread. (A
reply in a sensitive thread is the exception: it may not open the thread, so it uses the listing's
thread id alone, the number the ordinary path cross-checks; see below.) Both Aula ids involved in
sending turned out to be different from what the frontend's naming suggests, and both were caught
by a cross-check before anything went out:

- A reply targets the thread's own `id`. Aula's frontend calls the value it sends
  "subscriptionId", but the listing's `subscriptionId` field is a different number; the first
  version expected it, and the check that the listing and the opened thread agree on the id refused
  before sending.
- A new thread's recipient is the person's institution-profile id. In a contact list, a guardian
  listed under a child carries only `id`, no `institutionProfileId`. `prepare_thread` therefore
  runs Aula's own recipient search (the new-message form's `search.findRecipients`) for the person
  and drafts only if it returns them under that same number, with the same name, and with the same
  role when both state one. A hit with the same name and another id is treated as a different
  person; a hit with the id and another name as the two sources not meaning the same number.
  Only parents and staff can be recipients, never an alias profile, and one person reached under
  two refs is one recipient.

**Success is what a fresh read shows.** `send_*` reads the thread back and reports `stateRead`
(the read worked) separately from `verified` (the message is there; for a new thread: with the text
and every intended recipient among the participants). A municipality can block communication
between profiles, so an accepted request is not evidence of a delivered message. Before sending,
the reply path records the thread's message ids and the new-thread path the inbox's thread ids;
the read-back may only be confirmed by something that was not there before — otherwise an
identical earlier message, or an earlier attempt inside the clock-skew window, would confirm a
send that never landed. If that baseline cannot be read, nothing is sent. The connection to Aula
is made before the draft is taken, so a failure to connect does not use the draft up.

People are never addressed by name. Contacts are reached child → `group_ref` → contact list, every
person gets a session-scoped `person_ref`, and `find_recipients` matches on name AND role
(optionally relation and child). Two parents with the same first name give two candidates and an
instruction to ask the user — never a pick. Groups are not accepted as recipients: how Aula
addresses one is unverified, and a mistake there reaches a whole class.

What leaves the server about other families follows Aula's own contacts page, read from its
frontend and checked against live responses: phone, email and address only with the person's
consent flag (on a list row also `currentUserCanViewContactInformation`), never a child's address
(nor that of a row without a role), no group home's home phone in a relation row, and nothing for
an alias profile. `hasCustody` passes when Aula sends it, which it does only to roles that may see
it. The same rules apply to `aula.contacts.parents`, the "Kontaktforældre" view. The contact list was measured to send an alias profile *without*
the `alias` flag the frontend's name helper checks, so the placeholder name Aula shows instead
("Alias-fornavn …") is recognised too.

**Sensitive threads** are a category of their own: listed by subject only, refused by the ordinary
message tools before anything is fetched, read only through a one-use read permit issued after the
user has seen the subject, and replied to without ever opening the thread — the reply is confirmed
from the listing's latest-message id instead.

### Profile activation belongs to the access token

Messaging and contact calls are refused (HTTP 403, Aula status code 10) until the guardian profile
has been activated for the current access token — which `profiles.getProfileContext` does as a side
effect. `AulaContext` used to cache the guardian id once per context, but `getClient()` builds a new
client when the token expires, so after a refresh the activation was skipped and the first message
call failed. The cache is now bound to the client it was fetched with, and every message and
contact tool calls `getGuardianUserId()` before its first messaging or contacts request.

## Where this leaves us

v0.1 is built and unit-tested. The next step is exercising the live MitID flow end-to-end and catching whatever didn't survive contact with reality. The wire-trace tooling exists precisely to make that loop short.
