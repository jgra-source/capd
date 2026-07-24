# Capd

A Chrome extension that shows your **Claude usage** at a glance — session (5-hour) and weekly rate-limit utilization with live reset countdowns, plus your credit balance — read straight from claude.ai as you browse.

No accounts, no API keys, nothing leaves your machine.

![icon](icons/icon48.png)

---

## What it shows

- **Session (5h)** and **Weekly** utilization rings — how close you are to each cap right now.
- **Reset countdowns** — when each window rolls over.
- **Toolbar badge** — your highest cap as a live % on the extension icon (orange → amber → red).
- **Credit / balance** — pulled from claude.ai's account endpoints when present.
- **Near-cap notifications** — a one-time ping when you cross your threshold (default 80%).
- **Session history** — a small sparkline of recent utilization.

It reads the usage figures that claude.ai already returns on your normal requests, and — while you have a claude.ai session — periodically re-checks those same usage endpoints in the background so the reading stays current even when you're not actively chatting. It never reads your cookies, auth tokens, or message content, and nothing ever leaves your machine.

---

## Install (unpacked)

1. Download / unzip this folder somewhere permanent (don't delete it after loading).
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the `capd` folder (the one with `manifest.json`).
5. Pin **Capd** from the puzzle-piece menu so the badge is visible.

Works in Chrome, Edge, Brave, and other Chromium browsers (Manifest V3, Chrome 111+ for `world: "MAIN"` content scripts).

---

## Using it

1. Open **claude.ai** and send any message.
2. Click the **Capd** icon. Your rings populate from that response.

The popup updates live whenever new data arrives. If you haven't used Claude in a while, the status dot turns amber ("stale") and the badge keeps showing the last reading.

### Settings (in the popup)

- **Alert threshold** — utilization % that triggers a notification.
- **Near-cap notifications** — on/off.
- **Badge shows** — highest cap, session only, or weekly only.
- **Clear history** — wipe the sparkline data.

---

## How it works

1. A page-context script (`inject.js`) wraps `fetch` and `XMLHttpRequest` on claude.ai. Because those calls are same-origin, it can read the JSON bodies of the usage/account endpoints, plus any `anthropic-ratelimit-*` response headers when present.
2. `bridge.js` relays that to the service worker.
3. The service worker (`background.js`) derives per-window utilization from the response **bodies** (`usage-body-parser.js`) — the primary path, since the claude.ai web app no longer reliably emits rate-limit headers. When headers *are* present (read directly via `webRequest.onHeadersReceived`), they're merged in non-destructively. It drives the badge and near-cap notifications and keeps a short history.
4. The popup renders it, with a Diagnostics panel that dumps the raw captured bodies for schema verification.

Both paths are **self-discovering**: the header parser groups any `anthropic-ratelimit-*` header by time window (`5h`, `7d`, …) and metric, and the body parser emits native per-window objects — so readings keep working even if Anthropic adds or renames windows.

---

## License

MIT — see [`LICENSE`](LICENSE). You're free to use, modify, and distribute it; just keep the copyright notice. Provided as-is, no warranty.

## Privacy

Everything is stored locally in `chrome.storage.local`. The only network requests the extension makes are the background re-checks of claude.ai's own usage endpoints (same data your browser already fetches) — nothing is sent anywhere else. No tokens, cookies, message contents, or personal data are read or transmitted.

## Permissions

- `webRequest` + host access to `claude.ai` / `*.anthropic.com` — to read rate-limit response headers.
- `storage` — to keep your readings, history, and settings.
- `notifications` — for near-cap alerts.
- `alarms` — to schedule the periodic background refresh.

## Notes & limits

- Readings refresh when claude.ai returns fresh usage data (as you use Claude) and via a guarded background re-check (~20 min) that re-polls the endpoints already seen. The background refresh only ever *updates* a reading with a real number — it can never blank or corrupt what's shown — so if you're logged out or the endpoints don't respond usefully, the last good reading simply stays.
- Endpoint shapes are Anthropic's internal, undocumented surface and may change; the parser is built to degrade gracefully if they do.

## Troubleshooting

- **Empty popup** — open claude.ai and send a message, then reopen the popup.
- **Reading looks stale** — Capd updates when claude.ai fetches its usage endpoints, which happens on page load. If you've sent several messages and the reading hasn't changed, reload the tab to get a fresh value.
- **No badge** — pin the extension; confirm the rings show data first.
- **Headers not detected** — make sure host access to `claude.ai` is granted in `chrome://extensions` → Capd → Details → Site access.

## Changelog

- **v1.0.6** — Fixed the badge showing no number. Three causes: (1) `parseUsageBodies()` filled each window/metric slot on a first-wins basis and accepted `null`, so a body captured before the usage body could lock a null into `5h.utilization` — the window was then emitted with a reset time but no number, drawing a `—` ring and a blank badge; it now takes the first *non-null* value. (2) The `7d` window pattern never matched claude.ai's `seven_day` field name, so the Weekly gauge silently never resolved. (3) `setSettings` refreshed the badge from header windows only, which are always empty on claude.ai, blanking the badge on every settings change; it now re-reads both stores, and opening the popup re-syncs the badge.
- **v1.0.5** — Fixed the gauge intermittently dropping to `—`: `kindFromUrl()` in `background.js` still keyed on the old `/api/v1/{account_id}/` prefix after `BODY_RE` was broadened in v1.0.3, so every captured body was bucketed as `unknown` and overwrote the previous one in storage. A non-usage response landing after the usage response wiped the reading. `kindFromUrl()` now matches the same endpoint tokens `BODY_RE` gates on, giving each body a distinct key.
- **v1.0.4** — Added a guarded background auto-refresh (`chrome.alarms`, ~20 min + on popup open) that re-polls the seen usage endpoints so readings stay current without re-sending a message. It parses fresh responses in isolation and only overlays real numbers, so it can never blank or corrupt an existing reading.
- **v1.0.3** — Broadened `BODY_RE` in `inject.js` to match Claude.ai's updated API URL structure (no longer requires the strict `/api/v1/{account_id}/` prefix), restoring session readings after the endpoint paths changed.
- **v1.0.2** — Confirmed claude.ai's web app emits no `anthropic-ratelimit-*` headers; pivoted utilization to a self-discovering `usage`-body parser (`usage-body-parser.js`) that emits native window objects, merged non-destructively with any header data. Added a Diagnostics raw-body dump with one-tap copy for schema verification.
- **v1.0.1** — Show partial data (balance without headers); add Diagnostics panel; fix stale-tab empty state.
- **v1.0.0** — Initial build: header + body capture, gauges, badge, notifications, history, settings.
