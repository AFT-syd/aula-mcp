# Wiring aula-mcp into Claude Code / Claude Desktop

The MCP server speaks Streamable HTTP and listens on `http://127.0.0.1:7878/mcp` by default. Both Claude Code and Claude Desktop accept HTTP transports.

## Claude Code (CLI)

`~/.config/claude-code/config.json` (Linux) or `~/Library/Application Support/Claude Code/config.json` (macOS):

See [`claude-code.json`](./claude-code.json) for a copy-pasteable snippet.

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent Windows path. Restart the app after editing.

See [`claude-desktop.json`](./claude-desktop.json).

## Prerequisites

1. Run `pnpm --filter @aula-mcp/cli dev login` once to authenticate.
2. Start the server: `pnpm --filter @aula-mcp/mcp-server dev`.
3. Restart your MCP client.

## What the agent should do first

Tell the agent (in its system prompt or first message): **"Call `aula.discover` first, then use the listed subordinate tools to answer the user's question."** That way it picks integrations dynamically based on which providers your school uses.
