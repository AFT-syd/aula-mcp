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

## Where this leaves us

v0.1 is built and unit-tested. The next step is exercising the live MitID flow end-to-end and catching whatever didn't survive contact with reality. The wire-trace tooling exists precisely to make that loop short.
