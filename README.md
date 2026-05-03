# aula-mcp

MCP server for [Aula](https://www.aula.dk) — the Danish school communication platform — so AI agents can read your kid's messages, calendar, ugeplaner, opgaver, and huskeliste.

TypeScript port of [scaarup/aula](https://github.com/scaarup/aula). Owns its own MitID auth (no headless browser), exposes everything as Model Context Protocol tools.

## Status

Early. Building toward a v1 milestone — see open issues / [project board](https://github.com/Casperjuel/aula-mcp/issues).

## Architecture

```
packages/
  aula-auth/    — MitID + SRP + OAuth/SAML, pure HTTP
  aula-client/  — Aula API + integration plugins (EasyIQ, Meebook, MU, Systematic)
  mcp-server/   — Hono app exposing MCP over Streamable HTTP
apps/
  cli/          — `aula login`, `aula status`, `aula logout`
```

## Quickstart (once it works)

```bash
pnpm install
pnpm build

# first-time auth — uses MitID app via QR code
pnpm aula login

# run the MCP server
pnpm --filter @aula-mcp/mcp-server dev
```

Then add to your Claude Code / Claude Desktop MCP config — see [`examples/claude-config/`](./examples/claude-config/).

## The `aula.discover` tool

Agents call `aula.discover` once and get a typed manifest of children, institutions, available capabilities (which integrations the school uses for ugeplaner, etc.), and which subordinate tools are callable. Then the agent picks dynamically.

## License

MIT.
