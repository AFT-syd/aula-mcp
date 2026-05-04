# aula-mcp

[![CI](https://github.com/Casperjuel/aula-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Casperjuel/aula-mcp/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

MCP server for [Aula](https://www.aula.dk) — the Danish school communication platform — so AI agents can read your kid's messages, calendar, ugeplaner, opgaver, and huskeliste through a typed interface.

TypeScript port of [`scaarup/aula`](https://github.com/scaarup/aula). Owns its own MitID auth (no headless browser, no Playwright). Exposes everything as Model Context Protocol tools over a Hono Streamable-HTTP server. Runs on Bun.

> **Disclaimer.** This project is not affiliated with, endorsed by, or sponsored by KMD A/S, Netcompany A/S, or the Aula consortium. *Aula* is a trademark of its respective owner; the name is used here solely to identify what this software talks to. All Aula data stays on your machine — there is no SaaS layer.

## Status

**v0.1 in progress** — auth + core API + integration plugins + MCP server are all built and unit-tested. Live MitID flow has not yet been exercised against the real service; first real attempt is the next step.

| Layer | What it does | Status |
| ----- | ------------ | ------ |
| `@aula-mcp/aula-auth` | MitID (APP / CODE_TOKEN / PASSWORD) + custom 3072-bit SRP-6a + OAuth/SAML chain + token store + wire-trace debug | ✅ unit-tested |
| `@aula-mcp/aula-client` | Aula API (profiles, presence, calendar, messages) with version probing + widget token manager (#311 fix) + integration plugins (EasyIQ, Meebook, Min Uddannelse, Systematic) | ✅ types-only, awaiting live verification |
| `@aula-mcp/mcp-server` | Hono + `@modelcontextprotocol/sdk` (`WebStandardStreamableHTTPServerTransport`) + `aula.discover` + per-capability tools | ✅ boots, smoke-tested |
| `apps/cli` | `aula login` (with QR rendering for the MitID app), `status`, `whoami`, `logout`, `--debug` wire-transcript capture | ✅ runs |

## Quickstart

Requires **[Bun](https://bun.sh) ≥ 1.3** and **[pnpm](https://pnpm.io) ≥ 10**. macOS/Linux. Node 22 is installed only for `tsc` type-checking.

```bash
git clone git@github.com:Casperjuel/aula-mcp.git
cd aula-mcp
pnpm install

# verify the build is healthy
pnpm typecheck && pnpm lint && bun test

# first-time MitID login (uses the MitID app via QR code by default)
pnpm --filter @aula-mcp/cli dev login

# add --debug to capture a sanitised wire transcript when something fails
pnpm --filter @aula-mcp/cli dev login --debug

# smoke-test that tokens work
pnpm --filter @aula-mcp/cli dev whoami

# run the MCP server (listens on http://127.0.0.1:7878/mcp)
pnpm --filter @aula-mcp/mcp-server dev
```

Then point any MCP client at `http://127.0.0.1:7878/mcp`. See [`examples/claude-config/`](./examples/claude-config/) for a Claude Code / Claude Desktop snippet.

## CLI

```
aula login [--username <user>] [--method APP|CODE_TOKEN] [--debug] [--transcript <file>]
aula status
aula whoami
aula logout
aula --help
```

Tokens are stored AES-256-GCM-encrypted at `~/.config/aula-mcp/tokens.json`. The encryption key is loaded in this order:

1. an explicit Buffer passed to `EncryptedFileTokenStore({ key })` — the most secure (e.g. read from a system keychain),
2. `process.env.AULA_MCP_KEY` — hex (64 chars) or arbitrary passphrase (SHA-256-derived),
3. a key file at `~/.config/aula-mcp/.key` — generated on first use, `chmod 600`. We warn that 1 or 2 are stronger.

`--debug` mode tees a sanitised JSONL transcript of every HTTP request/response to `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl`. Cookies, OAuth/SAML payloads, MitID auth codes, passwords, M1/flowValueProof and similar fields are redacted to `<redacted N chars>`, so the transcript is safe to paste into a GitHub issue.

## The `aula.discover` tool

Agents call `aula.discover` once and get a typed manifest:

```ts
{
  user: { name, username, identityName? },
  children: [{ id, name, userId?, institution: { id, name?, code? } }],
  apiVersion: 22,
  tokens: { expires_at, seconds_remaining },
  capabilities: {
    profiles:    { summary, tools: ['aula.profiles.list'] },
    presence:    { summary, tools: ['aula.presence.today'] },
    calendar:    { summary, tools: ['aula.calendar.events'] },
    messages:    { summary, tools: ['aula.messages.list_threads', 'aula.messages.get_thread'] },
    ugeplan:     { summary, tools: ['aula.ugeplan.easyiq', 'aula.ugeplan.meebook'] },
    opgaver:     { summary, tools: ['aula.opgaver.minuddannelse'] },
    ugebrev:     { summary, tools: ['aula.ugebrev.minuddannelse'] },
    huskelisten: { summary, tools: ['aula.huskelisten.systematic'] }
  },
  rawRequestEnabled: false
}
```

Subordinate tools accept child IDs / institution codes from the manifest. New integrations become discoverable without changing the agent.

## Architecture

```
packages/
  aula-auth/    — MitID + SRP + OAuth/SAML + token store + wire-trace
  aula-client/  — Aula API + integration plugins
  mcp-server/   — Hono + @modelcontextprotocol/sdk
apps/
  cli/          — aula login/status/whoami/logout
```

Cross-package imports use the workspace name (`@aula-mcp/aula-auth`) — Bun resolves `.ts` directly, so there's no build step in dev. `tsc -p tsconfig.json --noEmit` runs in CI for type-checking only.

## Bake-ins from upstream issues

The Python integration has years of accumulated lessons in its issue tracker. We pre-empted the top ones:

| Upstream issue | Mitigation |
| -------------- | ---------- |
| [#311](https://github.com/scaarup/aula/issues/311) — sensor goes dead when widget JWT expires | `WidgetTokenManager.withRetry` detects `{"message":"JWT-Token expired..."}` (and 401/403) and refreshes once before retrying. |
| [#246, #248](https://github.com/scaarup/aula/issues/246) — Aula API version drifts (v22 → v23 mid-life) | `AulaClient` probes versions lazily, retries once on 410, fires `onApiVersionChanged` on bumps. |
| [#310](https://github.com/scaarup/aula/issues/310) — RelayState missing from Level-3 SAML response | `extractSamlForm` returns `hadRelayState: false` and an empty string instead of throwing. |
| [#306, #287](https://github.com/scaarup/aula/issues/306) — `post-broker-login` returns 200 with confirmation form instead of 302 | `detectConfirmationForm` finds `button#confirmation-button`, submits its parent form, then continues. |
| [#290, #351](https://github.com/scaarup/aula/issues/351) — `password`/`token` required for auth methods that don't need them | `AulaLoginOptions` only demands fields per chosen `method`. APP method needs no password. |
| Sensitive messages (`status.code` 403) | Surfaced as the typed `AulaStepUpRequiredError`; MCP tool returns a structured `step_up_required` JSON instead of empty data. |

## Development

```bash
pnpm install          # install everything
pnpm typecheck        # tsc -p tsconfig.json --noEmit
pnpm lint             # biome check .
pnpm lint:fix         # biome check --write .
bun test              # run the bun:test suites (currently 108 cases)
```

A full guide for adding integration plugins or porting more endpoints is in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Privacy

All tokens stay on your machine. The MCP server runs on `localhost` by default — no external dependencies. The wire-trace tooling is opt-in (`--debug` flag) and redacts every known-secret field.

The reference Python repo is for personal/family use of one's own children's school data. This project is the same — log in as yourself with your own MitID; do not use to access anyone else's account.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for repo layout, conventions, and a guide for adding integration plugins. Contributors agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Security issues: please email **cj@signifly.com** rather than opening a public issue — see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE).
