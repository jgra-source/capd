# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Capd is a Manifest V3 Chrome extension that reads Claude usage data (session/weekly utilization, reset countdowns, credit balance) directly from claude.ai — no extra API calls, no auth tokens read.

## No build step

There is no bundler, transpiler, or package manager. All files are plain JS loaded directly by Chrome. To test changes: go to `chrome://extensions` → reload the Capd card (↺). Changes to `background.js` or content scripts take effect on reload; popup changes take effect immediately on next open.

## Data flow architecture

Two parallel paths feed utilization data into storage, merged at read time:

```
inject.js (MAIN world)
  └─ wraps window.fetch + XHR on claude.ai
  └─ captures anthropic-ratelimit-* headers  →  postMessage → bridge.js → background.js → ingestHeaders()
  └─ captures JSON bodies from BODY_RE URLs  →  postMessage → bridge.js → background.js → ingestBody()

background.js (service worker)
  └─ also reads headers via webRequest.onHeadersReceived (primary/robust path)
  └─ ingestHeaders() → parseHeaders() → stores as rl { windows, raw }
  └─ ingestBody()   → parseUsageBodies() → stores as rlb { windows }
  └─ mergeWindows(rl.windows, rlb.windows) → badge + notifications + history

popup.js
  └─ sends getState → background assembles merged windows + bodies + history
```

**Headers path**: `anthropic-ratelimit-*` response headers. Confirmed absent on claude.ai's web app — this path currently produces nothing but is retained for when Anthropic re-enables them.

**Bodies path**: the active path. `BODY_RE` in `inject.js` filters which API response bodies are captured. `usage-body-parser.js` then flattens the JSON and pattern-matches field names to window tokens (`5h`, `7d`) and metrics (`utilization`, `used`, `limit`, `reset`, `status`, `remaining`).

## Key patterns and gotchas

**`BODY_RE` in `inject.js`** — the single most fragile point. It determines which API URLs trigger body capture. Claude.ai's internal API paths have changed before; if readings stop, this is the first thing to check. Current pattern accepts any `/api/.../{endpoint}` shape (broadened from the original strict `/api/v1/{account_id}/` prefix).

**`parseHeaders()` in `background.js`** — self-discovering: it groups any `anthropic-ratelimit-*` header by window token and metric without hardcoding field names, so it survives Anthropic adding/renaming windows.

**`parseUsageBodies()` in `usage-body-parser.js`** — also self-discovering: flattens entire JSON body into dot-paths and pattern-matches each path for window and metric. Two branches per window: (A) direct utilization field, (B) `used/limit` counts → compute %. Only emits a window entry if utilization or resetAt was recovered.

**`mergeWindows(headerWindows, bodyWindows)`** — body-derived data is added first, then header data overwrites on ties (headers are canonical when present).

**Async lock (`withLock`)** — all storage reads/writes go through a promise chain to prevent concurrent ingests from clobbering each other in the service worker.

## Storage keys (`chrome.storage.local`)

| Key | Contents |
|-----|----------|
| `rl` | Header-derived `{ windows, raw, updatedAt }` |
| `rlb` | Body-derived `{ windows, updatedAt }` |
| `bodies` | Raw captured bodies `{ [kind]: { body, updatedAt } }` |
| `history` | Array of `{ t, s, w }` utilization snapshots (max 300) |
| `settings` | `{ threshold, notifications, badgeMetric }` |
| `notified` | Tracks which cap alerts have already fired |

## Window tokens

`SESSION_PREF = ["5h", "session", "1h", "hourly"]` — tried in order to find the session window.  
`WEEKLY_PREF = ["7d", "weekly"]` — tried in order to find the weekly window.  
The body parser only emits `5h` and `7d` tokens; the header parser can produce any window token present in the headers.

## Diagnostics

The popup's collapsed **Diagnostics** section (`<details>`) shows raw header keys, which account endpoints were captured, which body-derived windows were resolved, and the full raw JSON of each captured body with a copy button. This is the primary tool for debugging when readings stop.
