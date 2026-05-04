# Demo recordings

GIF/MP4 demos for the README and the OSS launch. We use [VHS](https://github.com/charmbracelet/vhs)
because the `.tape` file is declarative — no live typing, no PII drift, reproducible across machines.

## Render

```sh
brew install vhs ffmpeg     # one-time, macOS
vhs docs/demos/help.tape    # produces docs/demos/help.gif
vhs docs/demos/discover.tape
```

Each tape writes its own `<name>.gif` (and optionally `<name>.mp4`) next to itself. Commit the tape, commit the GIF.

## What we record

| Tape | What it shows | Needs login? |
| ---- | ------------- | ------------ |
| `help.tape` | `aula --help` — a menu of every CLI command. | No. |
| `discover.tape` | The shape of `aula.discover`'s manifest using a redacted fixture. | No. |
| `login.tape` *(TODO)* | The MitID QR + identity-picker flow. **You** must record this against your real account, then sanitise the GIF before committing. | Yes. |
| `claude-code.tape` *(TODO)* | A Claude Code session prompting `hvad står der på ugeplanen næste uge for X` and getting an answer. | Yes. |

## PII rules

Don't commit any GIF that shows real children's names, real CPRs, real institution codes, real
unilogin tokens (`abcd1234`-style), or real MitID screens with personal info. The fixture in
`fixtures/discover-manifest.json` is fully synthetic — use it as the template for any new tape.

## Why VHS over terminalizer

We used to plan for terminalizer. VHS won because:

- **Declarative `.tape` files** — keystrokes are scripted, no awkward live recording.
- **Reproducible** — the same tape produces the same GIF on any machine.
- **Cleaner output** — modern font rendering, transparent backgrounds, no chrome.
- **One binary** — `brew install vhs` and you're done.

If you really want terminalizer instead, `npx terminalizer record demo.yml` still works — but
you'll be live-typing into a terminal and editing YAML afterwards to scrub PII.
