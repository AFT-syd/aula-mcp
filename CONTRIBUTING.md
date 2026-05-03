# Contributing to aula-mcp

## Repo layout

```
packages/
  aula-auth/    — MitID + SRP + OAuth/SAML + token store
  aula-client/  — Aula API + integration plugins
  mcp-server/   — Hono + MCP SDK
apps/
  cli/          — aula login/status/whoami/logout
aula-python-reference/    (gitignored) — clone of scaarup/aula for porting
```

Cross-package imports use the workspace name (`@aula-mcp/aula-auth`). Bun runs `.ts` directly; `tsc -p tsconfig.json --noEmit` is type-check only.

## Standing rules

Every commit must leave the tree green:

```bash
pnpm typecheck && pnpm lint && bun test
```

The CI workflow at `.github/workflows/ci.yml` enforces this.

Other rules baked into the codebase:
- **No headless browsers.** The whole point is that we own the MitID flow at the HTTP/SRP level.
- **TypeScript strict + `verbatimModuleSyntax` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`** — leave them on. They catch real bugs in this code.
- **Imports use `.ts` extensions** within a package (Bun + bundler resolution allows this).
- **Tests live next to source** as `*.test.ts`; they're collected by `bun test` automatically.
- **No `vitest`** — we use `bun:test`. Don't reintroduce it.
- **Comments: WHY not WHAT.** A comment that paraphrases the code is noise. Explain non-obvious constraints, workarounds for specific upstream behaviour, and references to issues.

## Adding a new integration plugin

The third-party providers (EasyIQ, Meebook, Min Uddannelse, Systematic) all follow the same shape — a class with a `getXxx(ctx)` method that hits the upstream API through `WidgetTokenManager.withRetry`. To add a new one:

1. Create `packages/aula-client/src/integrations/<vendor>.ts`.
2. Define the class with:
   - `static readonly id` (string literal),
   - `static readonly capabilities` (array of capability tags),
   - constructor taking `{ http: AulaHttpClient; widgets: WidgetTokenManager; widgetId?: string }`,
   - one method per logical query that calls `widgets.withRetry(widgetId, async (token) => …)` and returns `NormalisedWeekPlan` (or a vendor-specific shape if it doesn't fit).
3. The fetch closure should:
   - call `this.http.request(url, { method, headers: { authorization: Bearer ${token}, … }, body })`,
   - return `{ _expired: true, status, bodySnippet }` when `isWidgetTokenExpiredResponse(res.body, res.status)` returns true (the manager will refresh + retry once),
   - throw with a descriptive message on other non-200s,
   - parse JSON and return.
4. Re-export from `packages/aula-client/src/integrations/index.ts`.
5. Wire into `packages/mcp-server/src/aula-context.ts` (a new `getXxx()` method) and `tools.ts` (a new `server.registerTool(...)`).
6. Add the tool name to the relevant `capabilities` block in `discover.ts`.

The Python reference at `aula-python-reference/custom_components/aula/client.py` is the source-of-truth for new endpoints. Look in `update_data` for the exact URLs/headers/body shapes.

## Adding a new MitID flow change

If MitID rotates an endpoint or changes a payload shape, the affected file is one of:

- `packages/aula-auth/src/mitid-urls.ts` — URL builders.
- `packages/aula-auth/src/mitid-types.ts` — wire JSON types.
- `packages/aula-auth/src/mitid-client.ts` — request orchestration.
- `packages/aula-auth/src/mitid-flow-proof.ts` — flowValueProof signing.
- `packages/aula-auth/src/srp.ts` — Aula's custom 3072-bit SRP-6a.

The SRP code has **golden vectors** captured by running the Python reference with a pinned random `a`. Regenerate via `/tmp/aula_srp_vectors.py` (a venv with `pycryptodome`) and update `srp.test.ts` if the algorithm ever changes — pinning prevents subtle drift. Don't change the SRP algorithm without re-running the vector script.

## Wire-trace transcripts

When investigating a MitID failure:

```bash
pnpm --filter @aula-mcp/cli dev login --debug
```

This appends a JSONL transcript at `~/.config/aula-mcp/transcripts/login-<ts>.jsonl` with secrets redacted. Open with `jq` for inspection or `cat` for raw browse. The redaction list lives in `packages/aula-auth/src/wire-tracer.ts` (`SECRET_HEADERS` / `SECRET_BODY_FIELDS`) — extend if MitID ships a new sensitive field.

## Releasing

This package isn't published yet; clone+run is the only path. When we do publish, we'll:
- Drop the workspace `bin` shim into a real `aula` command (already configured to `bun build --compile`).
- Switch workspace exports from `./src/index.ts` (Bun-direct) to a built `./dist/index.js` so Node consumers can also `npm install` the libraries.
- Tag with a real version.
