# Use the libraries directly, without the MCP server

A 5-minute example of calling the Aula API from a plain Bun script — no MCP, no CLI, no Hono. Useful when you want to script a one-off query or build a different transport.

## Run

```bash
# one-time: log in via MitID and persist tokens to ~/.config/aula-mcp/tokens.json
pnpm --filter @aula-mcp/cli dev login

# then:
bun examples/script/fetch-profiles.ts
```

You should see your name, Aula API version, and a list of children with their institutions.

## What it shows

- `EncryptedFileTokenStore` loads the tokens that `aula login` wrote (and `withFreshTokens` refreshes the access token if it's expired).
- `AulaClient` is the typed wrapper around `https://www.aula.dk/api/v{N}/`. It probes the API version on first use, so you don't hard-code `v22`.
- `getProfilesByLogin()` returns the same envelope the official Aula web app fetches on page load.

That's the whole "library mode" surface. Everything else (calendar, messages, presence, integration plugins) is the same shape: build the client, call a method.
