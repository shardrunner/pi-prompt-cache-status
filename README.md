# pi-prompt-cache-status

A small, opinionated [pi](https://github.com/earendil-works/pi-mono) extension that shows **observed prompt-cache usage across providers** and an **inactivity reminder** (5 minutes for Muse Spark 1.3, otherwise 30 minutes). It leaves pi's footer, token totals, costs, and other extensions alone.

It does not keep a cache alive or predict whether your next request will hit one.

## Install

Requires **Pi 0.86.1+**; development dependencies pin **0.86.1**. Newer versions are intended targets, not a guarantee against upstream API changes. Local development requires **Node.js 22.19.0 or newer**. All providers and models are tracked through pi's normalized usage fields, including Codex, OpenAI, Anthropic, Google, OpenRouter, and custom providers. No allowlist is required.

From a local checkout:

```sh
pi install /absolute/path/to/pi-prompt-cache-status
```

Run `/reload` in an existing pi session, or start a new one. To try the extension without installing it:

```sh
pi -e ./index.ts
```

Pi supplies the core packages at runtime; no build step is required. Install the extension **once**: do not also copy it into an auto-discovered extensions directory if you installed the package.

Remove a local installation with:

```sh
pi remove /absolute/path/to/pi-prompt-cache-status
```

A published Git checkout can also be installed with `pi install https://github.com/OWNER/REPOSITORY` (replace the placeholders with its actual location). This project does not require an npm release.

## What it shows

| Example | Meaning |
| --- | --- |
| `Prompt cache: no observations` | No qualifying response for this model on the active session branch. **Not** proof of a cold cache. |
| `Prompt cache: last request 14:03; cached 40.0%` | The latest qualifying request's timestamp in local time and the proportion of its prompt tokens reported as cache reads. |
| `…; inactive 30m+ (heuristic)` | That request's timestamp is at least 30 minutes old. This is a reminder, **not** a provider TTL or proof of eviction. |
| `…; inactive 5m+ (reported TTL)` | For `openrouter/meta/muse-spark-1.3-contributor` only: at least five minutes have passed since the observed request timestamp. The model's reported cache TTL is five minutes; this does **not** prove eviction or predict a cache miss. |

Zero hits remain visible as `cached 0.0%` in the status. The extension does not emit cache-miss notifications; with pi's `showCacheMissNotices` enabled, pi displays its own notice instead. Small prompts and changed prefixes can legitimately have no cached tokens.

The percentage is **per request, not a session average**:

```text
cacheRead / (input + cacheRead + cacheWrite) × 100
```

These are pi's normalized usage fields, not raw provider token totals. Cache writes count toward the prompt denominator, not hits; `cacheWrite1h` is already part of `cacheWrite` and is not added again. Token and cost totals remain pi's responsibility, including nested tool calls, compaction, and branch summaries.

Some adapters normalize absent cache metrics to zero. Thus `cached 0.0%` means zero cache reads in pi's usage report, not proof that the provider supports caching or explicitly reported a miss. This extension does not enable caching or change provider requests.

## Evidence and scope

- Only finalized assistant responses from any provider ending in `stop`, `length`, or `toolUse` qualify. Errors, cancellations, partial responses, and zero-prompt-token responses do not replace the last observation.
- Invalid token counts and invalid/future timestamps are ignored. If the local clock moves backward, elapsed time is clamped to zero.
- The timestamp is the assistant message's **request timestamp**, not a measured completion time. A long-running request can therefore reach the inactivity threshold sooner after completion.
- Observations are scoped to the **selected provider/model pair and active session branch**. Startup, reload, session replacement, and `/tree` navigation reconstruct that history consistently. Activity in other sessions, branches, accounts, or processes is not tracked.
- HTTP response headers are not evidence of successful completion. Listening to finalized messages supports both HTTP and WebSocket transports.
- Tool-result usage and summary usage are not treated as ordinary prompt-cache observations.
- The last observed hit rate says nothing definitive about the next request. Prompt-prefix changes, routing, retention policy, and compaction can all affect reuse.

The default 30-minute threshold is a fixed personal preference, not a retention guarantee. Muse Spark 1.3 on OpenRouter instead uses its reported five-minute cache TTL as the reminder threshold. The timer starts at pi's message timestamp and does not observe server-side cache expiry; other models (even on OpenRouter) retain the 30-minute heuristic. Actual retention varies; see the official [Anthropic prompt-caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching), [Gemini caching docs](https://ai.google.dev/gemini-api/docs/caching), and [OpenAI prompt-caching docs](https://platform.openai.com/docs/guides/prompt-caching). Keeping these reminders explicit and non-configurable keeps this tool small.

## UI and coexistence

The extension uses only a namespaced `setStatus()` entry. It never calls `setFooter()`, renders terminal lines, applies cached ANSI styling, or rewrites another extension's status.

- **TUI:** pi owns layout, terminal-width truncation, and styling. A narrow terminal may truncate the status. Custom footers must render extension statuses for it to appear.
- **RPC:** pi forwards status calls as `extension_ui_request` events; actual display depends on the client.
- **Print/JSON:** no UI calls or inactivity timers.

Only one inactivity timer is active, and only for a selected model with a recent observation. It is replaced when needed, unreferenced so it cannot keep Node alive, and cleared on shutdown. There is no polling.

## Privacy and permissions

The extension reads the active session branch in memory and displays usage metadata. It does not read credentials, make network requests, run shell commands, write files, send telemetry, or modify prompts. Like all pi extensions, it nevertheless runs with pi's full process permissions; review the source before installing it.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

`check` runs strict TypeScript checking and the Node.js test suite. Tests use typed pi fixtures and a fake clock; no provider credentials or live model calls are required. CI runs on Node 22.19.0, 24, and 26.

- `index.ts`: lifecycle, branch restoration, status updates, timer cleanup.
- `prompt-cache-status.ts`: evidence validation, percentage calculation, and plain-text formatting.
- `prompt-cache-status.test.ts`: unit and lifecycle regression tests.
- [Design notes](docs/ai/design.md): implementation constraints and verification checklist.

To inspect the publication contents without publishing:

```sh
npm pack --dry-run
```

## License

[MIT](LICENSE) © 2026 Michael Brunner.
