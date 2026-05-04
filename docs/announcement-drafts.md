# Announcement drafts

Copy/paste ready. Each draft includes the unaffiliated-with-Aula line so we
don't get into trademark trouble.

## 1. Cross-link in scaarup/aula

**Where**: open an issue (not a PR — too presumptuous) on
[scaarup/aula](https://github.com/scaarup/aula/issues) titled
*"For users who want an MCP-friendly Aula client"*.

> Hi 👋
>
> Big fan of this project — used it as the technical reference for porting
> the auth flow to a different ecosystem. I've published an MCP-friendly
> Aula client at [Casperjuel/aula-mcp](https://github.com/Casperjuel/aula-mcp)
> aimed at AI agents (Claude, Cursor, etc.) rather than Home Assistant.
>
> It's a TypeScript port (Bun runtime, Hono server, MCP SDK). The MitID auth
> chain, custom SRP, OAuth/SAML handoff, and integration plugins (EasyIQ,
> Meebook, Min Uddannelse, Systematic, EasyIQ SkolePortal) all map back to
> patterns from this repo — credit and a link in the README.
>
> Bake-ins from your issue tracker that I implemented as part of the port:
> #311 (widget JWT expiry retry), #246/#248 (API version probing),
> #310/#306/#287 (SAML/broker tolerance), #257 (UniLogin retired), and
> PR #352 (EasyIQ SkolePortal widget 0128).
>
> Not asking for anything — just leaving a pointer for users who reach this
> repo looking for the AI-agent angle. Happy to help reverse-direction with
> any HTTP shapes I've learned along the way.
>
> *Not affiliated with KMD, Netcompany, or the Aula consortium. Aula is a
> trademark of its respective owner.*

## 2. Aula community Discord (linked from scaarup/aula's README)

> Built an MCP server for Aula so I could ask Claude "any unread messages
> from the school?" and "what's on my kid's schedule tomorrow?". TypeScript
> port of scaarup/aula's auth flow. Link: github.com/Casperjuel/aula-mcp.
>
> Source-available, MIT licensed, runs on `localhost`. Tokens stay on your
> machine — there's no SaaS layer. *Not affiliated with KMD/Netcompany.*

## 3. /r/Denmark (Danish)

**Title**: "Open source: AI-assistent kan nu læse din ungs Aula (MCP server)"

> Jeg har bygget en MCP-server der eksponerer Aula til AI-agenter som
> Claude, Cursor, ChatGPT desktop osv. — så du kan stille spørgsmål som
> *"Er der nye beskeder fra skolen?"* eller *"Hvad har Emma i skoleskema i
> morgen?"*.
>
> 100 % open source (MIT), kører lokalt på din egen maskine — alle Aula-
> tokens forbliver på din computer. Ingen SaaS, ingen tredjepart.
> Bygget oven på det fantastiske reverse-engineering-arbejde fra
> scaarup/aula (Python/Home Assistant) — denne her er TypeScript/Bun for AI-
> agent brug.
>
> github.com/Casperjuel/aula-mcp
>
> *Ikke tilknyttet KMD, Netcompany eller Aula-konsortiet. Aula er et varemærke
> tilhørende dets respektive ejer.*

## 4. Hacker News (English, technical angle)

**Title**: "Show HN: Aula MCP — Owning MitID auth in TypeScript (no headless browser)"

> Aula is the Danish national school communication platform. To talk to it
> programmatically you have to walk through MitID (Denmark's national digital
> ID), an OIDC + SAML federation chain, and a custom SRP-6a handshake with a
> 3072-bit prime that isn't any RFC group.
>
> The existing Python integration (scaarup/aula, for Home Assistant) handles
> all of that. I wanted the same capability for AI agents — Claude, Cursor,
> ChatGPT — so I ported the entire auth chain to TypeScript and put it
> behind a Model Context Protocol server.
>
> What's interesting:
>
> - **No headless browser.** The whole MitID flow is HTTP — `requests` in
>   Python, Bun's native `fetch` here. SRP, AES-GCM, PBKDF2 are all
>   `node:crypto`. tough-cookie for the cross-domain cookie jar. cheerio for
>   HTML form extraction.
> - **Custom SRP**, byte-for-byte verified against the Python implementation
>   via golden vectors generated with a pinned random `a`.
> - **Wire-trace tooling**: every request/response captured with secrets
>   sanitised — including `access_token` query params, MitID auth codes,
>   SAML responses. JSONL transcripts safe to paste into bug reports.
> - **MCP discover pattern**: agents call `aula.discover` first, get a
>   manifest of children/institutions/capabilities, then dynamically pick
>   subordinate tools. No hard-coded tool tree.
>
> Repo: github.com/Casperjuel/aula-mcp
>
> Stack: TypeScript 6, Bun, Hono, `@modelcontextprotocol/sdk`, Biome 2,
> Zod 4, pnpm workspaces.
>
> *Not affiliated with KMD, Netcompany, or the Aula consortium.*

## 5. LinkedIn

> Spent the last few nights building an MCP server for Aula — Denmark's
> national school platform — so AI agents can read messages, calendars,
> presence and weekly plans on behalf of a parent.
>
> TypeScript, Bun, Hono. The interesting bit was porting MitID auth (custom
> SRP-6a + OAuth + SAML chain) without a headless browser — every line is
> verifiable HTTP. Wire-trace tooling redacts every secret so debug
> transcripts are safe to share.
>
> Open source (MIT): github.com/Casperjuel/aula-mcp
>
> Heavy lift on the reverse engineering side belongs to scaarup/aula
> (Python/Home Assistant) — this is the AI-agent-shaped sibling.
>
> *Personal project; not affiliated with my employer or with KMD/
> Netcompany.*
