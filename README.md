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

It is **passive**: it reads the usage figures that claude.ai already returns on your normal requests. It never sends extra API calls and never reads your cookies or auth tokens.

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

1. A page-context script (`inject.js`) wraps `fetch` and `XMLHttpRequest` on claude.ai. Because those calls are same-origin, it can read the `anthropic-ratelimit-*` response headers that carry utilization, plus the JSON bodies of the account/credit endpoints.
2. `bridge.js` relays that to the service worker.
3. The service worker (`background.js`) also reads the same headers directly via `webRequest.onHeadersReceived` (the robust primary path), parses everything into per-window utilization + reset times, drives the badge and notifications, and keeps a short history.
4. The popup renders it.

The header parsing is **self-discovering**: it groups any `anthropic-ratelimit-*` header by its time window (`5h`, `7d`, etc.) and metric (`utilization`, `reset`, `status`…), so it keeps working even if Anthropic adds or renames windows.

---

## License

MIT — see [`LICENSE`](LICENSE). You're free to use, modify, and distribute it; just keep the copyright notice. Provided as-is, no warranty.

## Privacy

Everything is stored locally in `chrome.storage.local`. No network requests are made by the extension itself. No tokens, cookies, message contents, or personal data are read or transmitted.

## Permissions

- `webRequest` + host access to `claude.ai` / `*.anthropic.com` — to read rate-limit response headers.
- `storage` — to keep your readings, history, and settings.
- `notifications` — for near-cap alerts.

## Notes & limits

- Readings refresh only when claude.ai returns fresh headers (i.e. when you use Claude). This is by design — it stays passive and free.
- Endpoint shapes are Anthropic's internal, undocumented surface and may change; the parser is built to degrade gracefully if they do.

## Troubleshooting

- **Empty popup** — open claude.ai and send a message, then reopen the popup.
- **No badge** — pin the extension; confirm the rings show data first.
- **Headers not detected** — make sure host access to `claude.ai` is granted in `chrome://extensions` → Capd → Details → Site access.

## Changelog

- **v1.0.3** — Broadened `BODY_RE` in `inject.js` to match Claude.ai's updated API URL structure (no longer requires the strict `/api/v1/{account_id}/` prefix), restoring session readings after the endpoint paths changed.
- **v1.0.2** — Confirmed claude.ai's web app emits no `anthropic-ratelimit-*` headers; pivoted utilization to a self-discovering `usage`-body parser (`usage-body-parser.js`) that emits native window objects, merged non-destructively with any header data. Added a Diagnostics raw-body dump with one-tap copy for schema verification.
- **v1.0.1** — Show partial data (balance without headers); add Diagnostics panel; fix stale-tab empty state.
- **v1.0.0** — Initial build: header + body capture, gauges, badge, notifications, history, settings.
