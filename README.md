# pi-prompt-cache-status

> **Disclaimer:** This extension is vibe coded for personal use. Use at your own risk.

See how much of each prompt [Pi](https://pi.dev) served from the provider's cache, for
any provider, without replacing the footer or changing requests.

```text
Prompt cache: last request 14:03; cached 40.0%; inactive 30m+ (heuristic)
```

## Why

- Prompt caching cuts cost and latency. Pi's footer shows a cache-hit percentage, but not when that request happened, which model actually served it behind a router, or whether a long break has probably let the cache expire.

## Features

- Shows the cache-read share of the last completed request.
- Shows an inactivity reminder once the cache has probably expired: 5 minutes for Muse
  Spark 1.3, 30 minutes for everything else.
- Works for every provider through Pi's normalized usage fields (Codex, OpenAI,
  Anthropic, Google, OpenRouter, custom providers), with no allowlist.
- Tracks each physical model separately, including models behind virtual routers.
- Read-only: no network calls, file writes, telemetry or changes to prompts.

It doesn't keep a cache alive or predict whether the next request will hit it.

## Installation

Requires **Pi 0.99.0+** and **Node.js 22.19+**.

```sh
pi install git:github.com/shardrunner/pi-prompt-cache-status
```

Run `/reload` in open Pi sessions. Update with `pi update --extensions`.
For local development, install a checkout instead
(`pi install /absolute/path/to/pi-prompt-cache-status`) or try it once with
`pi -e ./index.ts`. Don't also copy it into an auto-discovered extensions directory.
No runtime dependencies, no build step.

## Usage

The status line updates automatically:

| Example                                                        | Meaning                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Prompt cache: no observations`                                | No completed response for the selected model yet (under a virtual model: none on this branch). **This doesn't mean** the cache is cold.  |
| `Prompt cache: last request 14:03; cached 40.0%`               | Local time of the latest completed request and the share of its prompt tokens read from cache.                                           |
| `…; latest physical response on branch: anthropic/claude-test` | Under a virtual model: the actual provider and model whose response is shown. This is past branch history, **not** a prediction.         |
| `…; inactive 30m+ (heuristic)`                                 | At least 30 minutes have passed since that request. A reminder only, **not** a provider TTL or proof the cache was evicted.              |
| `…; inactive 5m+ (reported TTL)`                               | `openrouter/meta/muse-spark-1.3-contributor` only: the model's reported five-minute cache TTL has passed. This **doesn't prove** a miss. |

The percentage applies to **one request**, not the whole session:

```text
cacheRead / (input + cacheRead + cacheWrite) × 100
```

Cache writes count as misses. `cacheWrite1h` is already part of `cacheWrite`. Some
adapters report missing cache data as zero, so `cached 0.0%` means Pi recorded no cache
reads. It doesn't prove the provider supports caching or reported a miss. To get Pi's
own cache-miss notices, turn on `showCacheMissNotices`.

## Behavior and limitations

- Only completed responses count (stop reason `stop`, `length` or `toolUse`). Errors,
  cancellations, partial responses, tool-result usage and summary usage are ignored, as
  are invalid token counts and timestamps.
- The time shown is when the request was sent, not when it finished, so long requests
  reach the inactivity threshold sooner.
- Data is kept per physical provider/model on the active session branch and rebuilt on
  startup, reload, session switches and `/tree` navigation. Other sessions and processes
  are not tracked.
- The thresholds are fixed on purpose. Real retention varies by provider: see the
  [Anthropic](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching),
  [Gemini](https://ai.google.dev/gemini-api/docs/caching) and
  [OpenAI](https://platform.openai.com/docs/guides/prompt-caching) caching docs.
- **UI:** only a namespaced `setStatus()` entry. It never replaces the footer or touches
  other extensions' statuses. RPC clients get the usual status events; print and JSON
  modes get no UI and no timers. At most one timer runs at a time, and it can't keep
  Node alive or poll.
- Like every Pi extension, it runs with Pi's full process permissions, so review the
  source before installing.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

Requires Node.js 22.19+. `check` runs strict TypeScript checking and the test suite.
Tests use typed Pi 0.99.0 fixtures and a fake clock, and need no credentials or live
model calls. CI runs on Node 22.19, 24 and 26.

- `index.ts`: lifecycle, branch restoration, status updates, timer cleanup.
- `prompt-cache-status.ts`: usage validation, percentage calculation, formatting.
- [Design notes](docs/ai/design.md): implementation constraints and verification checklist.

## License

[MIT](LICENSE) © 2026 Michael Brunner
