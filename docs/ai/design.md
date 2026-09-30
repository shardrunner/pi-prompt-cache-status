---
summary: Evidence rules, lifecycle invariants, and verification for the provider-neutral prompt-cache status extension.
read_when:
  - Changing cache observations, status wording, or inactivity behavior.
  - Changing pi event handling or package publication.
---

# Design

## Intent

Report observations rather than inventing server-side state. Keep a personal 30-minute inactivity reminder by default, identified as a heuristic. For the exact `openrouter/meta/muse-spark-1.3-contributor` pair, use a five-minute reminder based on the reported cache TTL, without claiming observed server-side expiry. Accept normalized pi usage from all providers, including custom providers; do not restrict observations with provider or model allowlists.

## Invariants

1. Live and restored responses use the same evidence predicate. Successful terminal stop reasons and valid, positive prompt usage are required. Failed or aborted messages never refresh an observation.
2. Physical provider/model-pair-scoped observations (keyed by a serialized tuple to avoid collisions) describe the active session branch. Physical selections show only their pair. Virtual selections show the latest qualifying physical response with an explicit `latest physical response on branch: provider/model` label, never a merged virtual cache. Track its identity by newest request timestamp; ties follow branch/event order. Rebuild both observations and identity on `session_start` and `session_tree`, and clear both on shutdown/session replacement.
3. Process `message_end` directly: session persistence may not yet contain the message when the handler runs. Do not depend on scanning the branch at that point.
4. HTTP 2xx headers are insufficient evidence and are intentionally ignored. Finalized assistant messages support both HTTP and WebSocket transports.
5. The provider message timestamp is the request timestamp. Do not mix local completion time for live events with request time when restoring history.
6. Use `setStatus()` for status and leave cache-miss notices to pi's `showCacheMissNotices` setting. The status is UI-only and does not add model context. Do not replace the footer or reproduce pi's accounting, layout, theme, or auto-compaction state.
7. No activity timer in non-UI modes. At most one timer for the displayed physical model, using that pair's existing policy even under a virtual selection; clear it before replacement, on provider changes, and at shutdown. Expired observations do not schedule another timer.
8. Do not retain sensitive prompts or introduce persistence, provider requests, background polling, or credential access.

## Deliberate tradeoffs

- No inference about the next request, real cache retention, or billing. A zero cache-read report does not explain why a hit was absent. Adapters can normalize missing cache metrics to zero, so zero does not prove caching support or an explicit provider miss.
- Use pi's normalized `input + cacheRead + cacheWrite` denominator for all APIs; do not apply raw-provider accounting again. `cacheWrite1h` is a subset of `cacheWrite`, not extra tokens. The extension observes usage only and never enables caching.
- Failed/aborted responses with partial usage are excluded even if some caching may have occurred. This avoids calling an unsuccessful request a success.
- Unknown and inactive observations retain different meanings. No observations is not equivalent to cold.
- The current branch's latest successful request survives later failed attempts. `last request` in the display means the last qualifying observation, not every attempted request.
- Inactivity is measured from the request timestamp, not server-side cache state. Default to a 30-minute heuristic; Muse Spark 1.3 on OpenRouter uses its reported five-minute TTL as the reminder threshold, not proof of eviction. Future-dated messages are ignored; existing observations use clamped elapsed time if the clock moves backward.
- Keep cache-hit rate per request and per physical provider/model pair. A virtual selection's displayed response may predate selecting the router or have come from another router; never attribute it to the current router or predict its next dispatch. Failed routing and virtual-identity messages are not physical evidence. Leave aggregate costs and tokens to pi.
- Target Pi 0.99.0+. Its selected `ctx.model` can be virtual while finalized assistant messages carry physical identity ([exact-tag virtual-model contract](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/virtual-models.md)). Use the public `getBranch()` and `message_end` contracts. The `pi-virtual` API marker check is isolated in `index.ts` because Pi 0.99.0 does not publicly export its detector; no deep imports or old-host compatibility layer.
- Plain text avoids storing old theme escape sequences. Pi or a user's custom footer owns truncation and rendering.

## Verification

Run `npm ci --ignore-scripts` and `npm run check`. No credentials or provider calls are needed. Test both the minimum supported Node version and current versions via CI.

Before release:

- Confirm zero hits update the status without extension notifications; failures, aborts, and HTTP-stream failures have the intended semantics.
- Exercise restoration, tree navigation, model switching, both timer thresholds/expiry/replacement, and idempotent cleanup. For virtual selections, verify changing physical routes without selection events, failed/older responses, pre-router history, abandoned-branch exclusion, physical fallback/pair isolation, and timer policy following the displayed pair.
- Confirm TUI/RPC use status APIs only and print/JSON modes stay silent.
- Inspect `npm pack --dry-run`: only runtime sources, manifest, README, license, and design notes should be shipped; never backups or test fixtures.
- Manually smoke-test with Pi 0.99.0+ in a disposable profile if changing host integration. Do not make a live model request without authorization.

Core pi packages are peer dependencies supplied by the host; pinned development dependencies make typechecking reproducible. The package manifest explicitly selects `index.ts`, so tests and helper modules cannot be auto-loaded as extensions.
