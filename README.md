# aula-mcp

[![CI](https://github.com/Casperjuel/aula-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Casperjuel/aula-mcp/actions)
[![Licens: MIT](https://img.shields.io/badge/Licens-MIT-yellow.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/Bun-≥%201.3-black?logo=bun)](https://bun.sh)
[![pnpm](https://img.shields.io/badge/pnpm-≥%2010-F69220?logo=pnpm)](https://pnpm.io)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-Streamable_HTTP-6B5BFF)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-209%20pass-brightgreen)](#udvikling)

> Spørg Claude (eller en hvilken som helst MCP-klient) om dit barns skole eller daginstitution på dansk — og få et reelt svar baseret på live-data fra [Aula](https://www.aula.dk).

![Claude Code spørger om næste uges ugeplan](./docs/demos/claude-code.gif)

Aula's egen app er hverken hurtig eller brugervenlig når du bare skal vide hvad Lukas har i morgen, hvilke beskeder lærerne har sendt i dag, eller hvornår næste forældremøde er. Med `aula-mcp` kan du spørge i naturligt sprog — fra Claude på din telefon, fra dit terminal, fra Home Assistant, fra Siri Shortcuts, eller fra en automatisering der kører hver morgen kl. 7. Alt sammen kører på din egen maskine; intet forlader hjemmet.

### Hvad åbner det op for?

**Hverdagsforespørgsler i naturligt sprog**

> *hvad har theo i morgen?*
> *kom der nye beskeder fra Lukas' lærer i denne uge? lav et resume*
> *er maja i institution lige nu, og hvornår er hun blevet tjekket ind?*
> *hvilke forældremøder er der i denne måned?*
> *hvad står der på ugeplanen næste uge — kort og kun for fag der har lektier*

**Automatiseringer**

- Send dig et morgenbrief kl. 7: ugeplan + skoleskema + nye beskeder
- Push-notifikation når der kommer en besked fra en specifik lærer
- Skab et kalenderelement når der annonceres en aktivitet — automatisk
- Voice-control fra Claude Desktop, Siri Shortcuts eller HA Voice/Assist
- Familiedashboard: en kid-friendly Today-view per barn

**Foundation til hvad du nu kunne tænke dig**

`aula-mcp` er bare en MCP-server. Alt der taler MCP — Claude, ChatGPT desktop, Cursor, Cline, og snart Home Assistant — kan bruge den. Det er ikke en ny app du skal lære, det er et lag der gør Aula tilgængeligt fra det værktøj du i forvejen bruger.

### Hvad er det rent teknisk?

`aula-mcp` er en self-hosted **Model Context Protocol**-server til Aula, den platform alle danske grundskoler og mange daginstitutioner kører på. Den taler hele Aula API'et (beskeder, kalender, tilstedeværelse, opslag, notifikationer, ugeplaner) plus de tredjeparts-widgets skolerne lægger ovenpå (EasyIQ, EasyIQ SkolePortal, Meebook, Min Uddannelse, Systematic). Login er en fra-grunden port af MitID-protokollen — ingen headless browser, ingen Playwright, ingen SaaS-mellemmand. **Alle data forbliver på din egen computer.**

TypeScript + Bun + Hono. Åndelig efterfølger til [`scaarup/aula`](https://github.com/scaarup/aula) (Home Assistant Python-integrationen), tilrettet AI-agenter.

---

## Indhold

- [Sikkerhed — hvorfor du trygt kan køre det her lokalt](#sikkerhed--hvorfor-du-trygt-kan-køre-det-her-lokalt)
- [Kom i gang](#kom-i-gang)
- [Forbind til Claude Code (eller claude.ai)](#forbind-til-claude-code-eller-claudeai)
- [Self-hosting — kør det altid og overalt](#self-hosting--kør-det-altid-og-overalt)
- [Hvad er der i manifestet](#hvad-er-der-i-manifestet)
- [CLI-kommandoer](#cli-kommandoer)
- [Konfiguration](#konfiguration)
- [Arkitektur](#arkitektur)
- [Rettelser fra Aula-issues](#rettelser-fra-aula-issues)
- [Fejlfinding](#fejlfinding)
- [Udvikling](#udvikling)
- [Bidrag](#bidrag)
- [Privatliv & jura](#privatliv--jura)

---

## Sikkerhed — hvorfor du trygt kan køre det her lokalt

Det her værktøj rører ved dine børns skoledata. Det skal du ikke gøre på autopilot, så her er præcis hvad det rør og hvad det ikke rør:

- **Dine tokens bliver på din maskine.** På macOS gemmes de i systemets **Keychain** — samme sikre opbevaring som Safari og Mail bruger til adgangskoder, beskyttet af din login-adgangskode. På Linux/Windows krypteres de med **AES-256-GCM** i en fil under `~/.config/aula-mcp/`. Tokens forlader aldrig din computer.
- **MCP-serveren lytter kun på `127.0.0.1` (loopback).** Den nægter at binde til en ekstern IP-adresse medmindre du eksplicit sætter `AULA_MCP_ALLOW_REMOTE=1` (og selv fronter den med en authenticeret reverse proxy). Som default er det strengt single-user, single-host: kun programmer der kører på *din* computer kan tilgå serveren.
- **Ingen SaaS, ingen telemetri, ingen tredjepart.** Programmet kommunikerer kun med Aula's egne servere (`api.aula.dk`, `login.aula.dk`), MitID (`nemlog-in.mitid.dk`, `www.mitid.dk`) og — hvis din skole har dem — vendor-API'erne (EasyIQ, Meebook m.fl.). Der er ingen "phone home"-funktion, ingen analytics, ingen udleveret kopi af dine data nogen steder.
- **MitID-loginnet sker direkte mellem din browser/computer og nemlog-in.dk.** Vi har implementeret protokollen i TypeScript, men selve godkendelsen (QR-koden i din MitID-app) går som altid igennem MitID's egen infrastruktur. Vi sidder ikke i midten — vi har bare oversat den dialog som Aula's officielle app fører.
- **`--debug`-tracen er opt-in og automatisk redaktet.** Hvis du beder om en wire-transcript til fejlfinding, fjerner vi automatisk cookies, OAuth-koder, MitID-payload, M1-værdier, flowValueProof, adgangstokens og andre hemmelige felter *før* noget bliver skrevet til disk. Du kan trygt vedhæfte en transcript til en GitHub-issue.
- **Kildekoden er åben (MIT).** Hele integrationen er ~7000 linjer kommenteret TypeScript fordelt på fire pakker. Du kan læse den selv, eller få en udvikler-bekendt til det. Der er ingen lukkede binærer.
- **Loopback-only betyder også at familien ikke automatisk kan tilgå serveren fra deres egen enhed.** Hvis I vil have flere enheder i hjemmet til at kunne spørge — uden at åbne for internettet — er den rigtige vej en Home Assistant-integration (se nedenfor).

> 🛣️ **På vej: Home Assistant MCP-server-addon.** En addon der pakker `aula-mcp` ind så det kan køre direkte på din HA-installation, og dermed være tilgængeligt for hele husstanden via dit lokale netværk (LAN-only) — uden at noget eksponeres til internettet. Hvis du allerede bruger Nabu Casa, åbner det også for sikker fjernadgang ad samme vej. *Spores som [issue (TBD)] i repo'et — feedback fra HA-folk meget velkommen.*

---

## Kom i gang

Kræver **[Bun](https://bun.sh) ≥ 1.3** og **[pnpm](https://pnpm.io) ≥ 10**. macOS eller Linux.

```sh
git clone git@github.com:Casperjuel/aula-mcp.git
cd aula-mcp
pnpm install

# 1. Sanity-tjek
pnpm typecheck && pnpm lint && pnpm test

# 2. Første-gangs MitID-login (QR-kode i MitID-appen)
pnpm login

# 3. Health-check af alle Aula-endpoints
pnpm doctor

# 4. Start MCP-serveren (http://127.0.0.1:7878/mcp)
pnpm mcp
```

Og det var det — du har en kørende, single-user MCP-server der står foran Aula på din laptop.

De fleste CLI-kommandoer har en kort genvej: `pnpm login`, `pnpm doctor`, `pnpm whoami`, `pnpm status`, `pnpm logout`. Til alt andet videresender `pnpm aula <kommando>` til CLI'en (fx `pnpm aula transcript list`, `pnpm aula log --last 5`).

`doctor`-kommandoen kører hvert read-endpoint igennem og rapporterer status + svartid for hvert. Det er det hurtigste "virker det her overhovedet?"-tjek:

![aula doctor kører igennem alle endpoints](./docs/demos/doctor.gif)

`whoami` viser hvilken identitet dine tokens hører til, og hvilke børn der returneres af `getProfilesByLogin`:

![aula whoami viser identitet + børn](./docs/demos/whoami.gif)

---

## Forbind til Claude Code (eller claude.ai)

### Claude Code (anbefalet til lokal brug)

```sh
# 1. Server kører i ét terminalvindue
pnpm mcp

# 2. Registrér serveren med Claude Code (kun én gang)
claude mcp add --transport http aula http://127.0.0.1:7878/mcp

# 3. I en hvilken som helst Claude Code-session, bekræft at den er forbundet
/mcp
```

Så kan du bare spørge naturligt — børnenes navne bliver fuzzy-matched mod `discover`-manifestet, du behøver ikke kende deres ID:

> *hvad står der på ugeplanen næste uge for theo*

Claude kalder `aula.discover` én gang, vælger den rigtige ugeplan-vendor for din skole ud fra `detectedWidgets`, og svarer på dansk med dansk-formatterede datoer.

### Claude Desktop

Drop snippet'et fra [`examples/claude-config/claude-desktop.json`](./examples/claude-config/claude-desktop.json) ind i `~/Library/Application Support/Claude/claude_desktop_config.json`.

### claude.ai (web)

Web-UI'et kræver en offentlig HTTPS-URL — `127.0.0.1` virker ikke, fordi forbindelsen sker server-side fra Anthropic's cloud. Til en hurtig test:

```sh
cloudflared tunnel --url http://127.0.0.1:7878
# → https://<random>.trycloudflare.com — indsæt med `/mcp` på enden
```

> ⚠️ **Tunnel-URL'en er offentligt tilgængelig så længe den kører** — hvis nogen gætter den, kan de styre dine Aula-tokens. Fint til en hurtig demo, men lad den ikke stå åben. Til en permanent setup, se næste sektion.

---

## Self-hosting — kør det altid og overalt

At køre det på din laptop er fint til at lege med, men du vil sandsynligvis have at serveren er tilgængelig:

- **Døgnet rundt** (også når laptoppen er klappet sammen)
- **Til hele familien** (ikke kun din egen Mac)
- **Fra en automatisering** (n8n, Home Assistant, cron-jobs)

Her er fire stier — vælg den der passer dit setup. Alle holder data lokalt; ingen lægger noget på en SaaS.

### Mulighed 1: Single binary på en Linux-boks (Pi, NAS, gammel laptop, billig VPS)

Den simpleste vej. Compile-til-én-binary og kør den under systemd.

```sh
# Byg en standalone binary (~50 MB)
bun build --compile --outfile dist/aula-mcp packages/mcp-server/src/server.ts

# Kopiér til din server (Pi, NAS, VPS, what have you)
scp dist/aula-mcp aula:/usr/local/bin/aula-mcp

# Kør første gang manuelt for at oprette tokens via login (kræver MitID)
# — eller log ind på din laptop og kopiér tokens.json over
```

Eksempel `systemd`-unit i `/etc/systemd/system/aula-mcp.service`:

```ini
[Unit]
Description=aula-mcp server
After=network.target

[Service]
Type=simple
User=aula
ExecStart=/usr/local/bin/aula-mcp
Environment=AULA_MCP_PORT=7878
Environment=AULA_MCP_HOST=127.0.0.1
Environment=AULA_MCP_DIR=/var/lib/aula-mcp
Environment=AULA_MCP_KEY=<en lang hex-streng eller passphrase>
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Aktivér med `systemctl enable --now aula-mcp`. Tjek `journalctl -u aula-mcp -f` for logs.

### Mulighed 2: Bag en authenticeret reverse proxy (familien tilgår fra mobilen)

Default binder serveren kun til `127.0.0.1`. For at familien (eller dig selv på telefonen via VPN) skal kunne ramme den, sæt en reverse proxy foran med authentication. Eksempel med [Caddy](https://caddyserver.com):

```caddyfile
aula.dithjem.dk {
    basicauth {
        familie $2a$14$<bcrypt-hash>
    }
    reverse_proxy 127.0.0.1:7878
}
```

`AULA_MCP_HOST` forbliver `127.0.0.1` — Caddy står for TLS, basic auth, rate limit. Det er Caddy der er på det offentlige internet, ikke selve MCP-serveren.

> ⚠️ Hvis du *skal* exposé serveren direkte (springe proxy-laget over) skal du eksplicit sætte `AULA_MCP_ALLOW_REMOTE=1` — det er en kontrolleret, tilsigtet handling, ikke et uheld.

### Mulighed 3: Home Assistant addon (på vej)

Den nemmeste vej for HA-brugere bliver en addon der pakker `aula-mcp` ind, så den kører som en del af din HA-installation og er tilgængelig fra HA's Voice/Assist + alle dine HA-automatiseringer. Hvis du har **Nabu Casa**, åbner det også for sikker fjernadgang via deres tunnel.

> 🛣️ Spores som [issue (TBD)] — feedback fra HA-folk meget velkommen. Hvis du har erfaring med HA add-on-byggeri, så bliver det her din hjælp.

### Mulighed 4: VPS i Tyskland (Hetzner, Coolify)

Hvis du allerede har en europæisk VPS (Hetzner, Scaleway, OVH) og en domæne — så er det bare en `git clone` + `bun install` + systemd-unit som mulighed 1. Lav GDPR-mæssigt set er det fortsat dine egne data på din egen infrastruktur.

### Backup & nøgle-håndtering

- **Token-store**: gem en kryptert kopi af `~/.config/aula-mcp/tokens.json` + `.key` (eller Keychain-eksport på macOS). Mister du dem, skal du logge ind igen — ingen panik, men irriterende.
- **AULA_MCP_KEY**: hvis du bruger fil-backenden i produktion, sæt en stærk `AULA_MCP_KEY` (env-var) og lad være med at committe den. Roterer du den, skal du re-loginne.
- **Nye Aula-versioner**: Aula bumper deres API-version 1-2 gange om året. `aula-mcp` prober selv den nye version ved næste kald (intet manuelt arbejde), men hold et øje på release-noter for breaking changes vi har spottet.

---

## Hvad er der i manifestet

Agenter kalder `aula.discover` én gang og genbruger resultatet resten af sessionen. Manifestet fortæller agenten hvem brugeren er, hvilke børn man kan handle på vegne af, hvilke tredjeparts-widgets skolerne har konfigureret, og hvilke MCP-tools der skal kaldes:

![aula.discover-manifest pretty-printet](./docs/demos/discover.gif)

Form:

```ts
{
  user: { name, username, identityName? },
  children: [{ id, name, userId?, institution: { id, name?, code? } }],
  apiVersion: 23,
  tokens: { expires_at, seconds_remaining },
  detectedWidgets: ['0001', '0029', '0030'],   // fra Aula's pageConfiguration
  capabilities: {
    profiles:      { summary, tools: ['aula.profiles.list'] },
    presence:      { summary, tools: ['aula.presence.today'] },
    calendar:      { summary, tools: ['aula.calendar.events'] },
    messages:      { summary, tools: ['aula.messages.list_threads', 'aula.messages.get_thread'] },
    notifications: { summary, tools: ['aula.notifications.list'] },
    posts:         { summary, tools: ['aula.posts.list'] },
    ugeplan:       { summary, tools: ['aula.ugeplan.easyiq'] },          // kun den detekterede vendor
    opgaver:       { summary, tools: ['aula.opgaver.minuddannelse'] },
    ugebrev:       { summary, tools: ['aula.ugebrev.minuddannelse'] },
    huskelisten:   { summary, tools: ['aula.huskelisten.systematic'] }
  },
  usage: {
    cache, nameResolution, pickOne, timeWindows, language
  },
  rawRequestEnabled: false
}
```

`capabilities[area].tools[0]` er altid det rigtige tool at kalde — når en skoles widgets bliver detekteret, lister vi kun den matchende vendor, så agenten ikke fanger ud over flere providers. Det inline `usage`-blok fortæller agenten hvordan den skal opføre sig (cache manifestet, fuzzy-match børnenavne, default til Europe/Copenhagen, svar på brugerens sprog).

---

## CLI-kommandoer

```
aula login [--username <user>] [--method APP|CODE_TOKEN] [--debug] [--transcript <file>]
aula status [--json]
aula whoami [--json]
aula doctor [--json] [--verbose]
aula log [--last N] [--json]
aula transcript {list|view <file>|prune} [--json] [--keep N] [--dry-run]
aula logout
aula --help
```

| Kommando | Hvad den gør |
| -------- | ------------ |
| `aula login` | Kører hele MitID-flowet (APP-metoden er default — scan QR med MitID-appen). Gemmer tokens. `--debug` opfanger en saneret wire-transcript så fejl er diagnoserbare. |
| `aula status` | Viser om der er tokens, deres udløbstid og den aktive identitet. Kontakter ikke netværket. Exit-kode 1 hvis der ingen tokens er. |
| `aula whoami` | Indlæser tokens (refresher hvis nødvendigt), kalder `getProfilesByLogin` + `getProfileContext`. Smoke-test af at hele auth + client-pipelinen virker. |
| `aula doctor` | Kører hvert read-endpoint igennem og rapporterer per-call status med svartid. Det hurtigste "virker det her?"-tjek. `--verbose` dumper wire-transcripten inline ved fejl. |
| `aula log` | Seneste login-forsøg (success/failure, timestamps, fejlklasse). |
| `aula transcript` | Inspicér opfangede `--debug`-transcripts; `prune` beholder de seneste N (default 10). |
| `aula logout` | Sletter de gemte tokens. Krypteringsnøglen beholdes så næste login genbruger den. |

Komplet hjælp med eksempler: `pnpm aula --help`

![aula --help](./docs/demos/help.gif)

---

## Konfiguration

### Hvor tokens gemmes

| Platform | Default | Override |
| -------- | ------- | -------- |
| macOS | Keychain (`security` CLI; service `aula-mcp`, account `tokens`) | `AULA_MCP_NO_KEYCHAIN=1` falder tilbage til fil-backenden |
| Linux / Windows | AES-256-GCM-krypteret fil i `~/.config/aula-mcp/tokens.json` | `AULA_MCP_KEY=<hex|passphrase>` for krypteringsnøglen (ellers genereret i `~/.config/aula-mcp/.key`, `chmod 600`) |

### Server-miljøvariabler

| Variabel | Default | Effekt |
| -------- | ------- | ------ |
| `AULA_MCP_PORT` | `7878` | Bind-port. |
| `AULA_MCP_HOST` | `127.0.0.1` | Bind-interface. Nægter ikke-loopback medmindre `AULA_MCP_ALLOW_REMOTE=1`. |
| `AULA_MCP_DIR` | `~/.config/aula-mcp` | Konfig-mappe (fil-backend + transcripts + login-log). |
| `AULA_MCP_RAW=1` | off | Aktiverer `aula.raw_request` escape-hatch-toolet. |
| `AULA_MCP_LOG=1` | off | Verbose console-logs fra auth/client-lagene. |
| `AULA_MCP_ALLOW_REMOTE=1` | off | Tillader at binde til ikke-loopback adresser (fx bag en reverse proxy). |

### Wire-transcripts

`--debug`-tilstand tee'r en JSONL-transcript af hvert HTTP-request/response til `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl`. Cookies, OAuth/SAML-payloads, MitID-auth-koder, adgangskoder, M1, flowValueProof, `access_token`-query-parameter og andre hemmelige felter bliver alle redaktet (`<redacted N chars>`). Transcripten kan trygt vedhæftes en GitHub-issue.

`aula transcript view <file>` pretty-printer en af dem.

---

## Arkitektur

```
packages/
  aula-auth/    — MitID + 3072-bit SRP-6a + OAuth/SAML-kæde + token-store + wire-trace
  aula-client/  — Aula REST API + version-probing + integrations-plugins
  mcp-server/   — Hono + @modelcontextprotocol/sdk + aula.discover + 11 capability-tools
apps/
  cli/          — aula login/status/whoami/doctor/log/transcript/logout
```

Cross-package-imports bruger workspace-navnet (`@aula-mcp/aula-auth`); Bun resolver `.ts` direkte, så der er intet build-trin i dev. `tsc -p tsconfig.json --noEmit` kører i CI til ren type-checking.

| Lag | Status | Noter |
| --- | ------ | ----- |
| `@aula-mcp/aula-auth` | ✅ unit-testet + live-verificeret | MitID APP + CODE_TOKEN + PASSWORD; macOS Keychain eller AES-GCM-fil. |
| `@aula-mcp/aula-client` | ✅ unit-testet | Native Aula API + EasyIQ / EasyIQ SkolePortal / Meebook / Min Uddannelse / Systematic-plugins. |
| `@aula-mcp/mcp-server` | ✅ unit-testet + live-verificeret med Claude Code | Streamable HTTP-transport, stateful session. Single-user, loopback by default. |
| `apps/cli` | ✅ unit-testet | QR-rendering, debug-transcripts, JSONL login-log. |

`@aula-mcp/aula-auth` og `@aula-mcp/aula-client` bruger kun Web-standarder + `node:crypto` + `node:child_process` — de kører på Node ≥ 20 såvel som Bun. MCP-serveren bruger `Bun.serve` og er Bun-only. CLI'en bruger Bun's TS-support og shipper via `bun build --compile`. For at bruge libraries fra et Node-script, se [`examples/script/`](./examples/script/).

Detaljeret design-rationale: [docs/architecture.md](./docs/architecture.md).

---

## Rettelser fra Aula-issues

Python-integrationen har års akkumuleret erfaring i sin issue-tracker. Vi har proaktivt rettet de mest forekommende:

| Upstream issue / PR | Hvad vi gør |
| ------------------- | ----------- |
| [#311](https://github.com/scaarup/aula/issues/311) — sensor dør når widget-JWT'en udløber | `WidgetTokenManager.withRetry` detekterer `{"message":"JWT-Token expired..."}` (samt 401/403) og refresher én gang før retry. |
| [#246, #248](https://github.com/scaarup/aula/issues/246) — Aula API-version drifter (v22 → v23 mid-life) | `AulaClient` prober versioner lazily, retry én gang ved 410, kalder `onApiVersionChanged` ved bumps. |
| [#310](https://github.com/scaarup/aula/issues/310) — RelayState mangler i Level-3 SAML-svar | `extractSamlForm` returnerer `hadRelayState: false` og en tom string i stedet for at kaste. |
| [#306, #287](https://github.com/scaarup/aula/issues/306) — `post-broker-login` returnerer 200 med bekræftelses-form i stedet for 302 | `detectConfirmationForm` finder `button#confirmation-button`, submitter dens form og fortsætter. |
| [#290, #351](https://github.com/scaarup/aula/issues/351) — `password`/`token` krævet for auth-metoder der ikke har brug for det | `AulaLoginOptions` kræver kun felter pr. valgt `method`. APP-metoden skal ikke have password. |
| [PR #352](https://github.com/scaarup/aula/pull/352) — EasyIQ SkolePortal (widget 0128) | Implementeret som `EasyIqSkoleportalClient` + `aula.ugeplan.easyiq_skoleportal` MCP-tool. Per-barn auth + dansk-entity-decode. |
| Følsomme beskeder (`status.code` 403) | Surfaced som typed `AulaStepUpRequiredError`; MCP-tool returnerer struktureret `step_up_required` JSON i stedet for tomme data. |

---

## Fejlfinding

| Symptom | Sandsynlig årsag / fix |
| ------- | ---------------------- |
| `aula login` hænger efter username-prompt | MitID-appen er ikke åbnet endnu, eller QR-koderne er ikke renderet (terminal for smal). Sørg for at terminalen er ≥ 80 kolonner. |
| `Login failed: MitID initialize failed (status …)` | nemlog-in.mitid.dk er ikke tilgængelig eller returnerede en fejl. Kør igen med `--debug` og inspicér transcripten. |
| `Login failed: APP poll error: …` | MitID-appen afviste eller annullerede. Tjek at MitID-appen er logget ind på din konto. |
| `Login failed: appProve failed (status …)` | Sjælden — MitID afviste SRP-proof'et. Kør igen med `--debug` og inspicér `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl`. |
| `aula whoami` → `step_up_required` for beskeder | En specifik tråd er følsom (Aula returnerer 403). Kør `aula login` igen for at re-etablere en step-up-session, prøv så igen. |
| `aula doctor` siger `Aula API v22 → 410` | API-versionen er bumpet. Kør `aula doctor` igen — `AulaClient` prober frem og husker. |
| `aula status` viser `expired N min ago` | Tokens er udløbet siden sidste brug. Et hvilket som helst read-kald (eller `aula doctor`) refresher dem automatisk. |
| MCP-server: `Refusing to bind to non-loopback address` | Du har sat `AULA_MCP_HOST` til `0.0.0.0` eller lignende. Serveren er single-user; alle der kan ramme `/mcp` bliver dig. Sæt `AULA_MCP_ALLOW_REMOTE=1` hvis du forstår implikationerne. |

Når noget fejler er JSONL-transcripten i `~/.config/aula-mcp/transcripts/login-<timestamp>.jsonl` (efter `--debug`) det første sted at kigge. `aula transcript view <file>` pretty-printer den.

---

## Udvikling

```sh
pnpm install          # installér alt
pnpm typecheck        # tsc -p tsconfig.json --noEmit
pnpm lint             # biome check .
pnpm lint:fix         # biome check --write .
pnpm test             # bun:test-suiterne (209 cases)
pnpm test:watch       # re-run ved ændring
```

Alle andre top-level-scripts: `pnpm aula <cmd>`, `pnpm mcp`, plus per-kommando-genvejene (`pnpm login`, `pnpm doctor`, `pnpm whoami`, `pnpm status`, `pnpm logout`).

---

## Bidrag

Se [CONTRIBUTING.md](./CONTRIBUTING.md) for repo-layout, konventioner og en guide til at tilføje integrations-plugins. Bidragydere accepterer at følge [Code of Conduct](./CODE_OF_CONDUCT.md). Sikkerhedsproblemer: skriv venligst til **cj@signifly.com** i stedet for at åbne en offentlig issue — se [SECURITY.md](./SECURITY.md).

---

## Privatliv & jura

Alle tokens forbliver på din maskine. MCP-serveren kører på `localhost` som default — ingen eksterne afhængigheder. Wire-trace-værktøjet er opt-in (`--debug`-flag) og redaktér hvert kendt-hemmeligt felt.

Den oprindelige Python-integration er til personlig/familiær brug af ens egne børns skoledata. Dette projekt er det samme — log ind som dig selv med din egen MitID; brug det ikke til at tilgå nogen andens konto.

> **Forbehold.** Dette projekt er ikke tilknyttet, godkendt af eller sponsoreret af KMD A/S, Netcompany A/S eller Aula-konsortiet. *Aula* er et varemærke tilhørende sin respektive ejer; navnet bruges her udelukkende til at identificere hvad denne software taler med.

---

## Licens

[MIT](./LICENSE).
