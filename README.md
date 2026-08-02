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

## Install

Capd isn't on the Chrome Web Store, so you install it from the source folder. That folder becomes part of the extension — **Chrome loads it from that path every time the browser starts**, so put it somewhere permanent and don't delete or move it afterwards. (If you do, the extension breaks and Chrome shows it as missing.)

### Step 1 — get the folder

**Option A — download the ZIP** (no tools needed)

1. Go to **https://github.com/jgra-source/capd**
2. Click the green **`< > Code`** button → **Download ZIP**.
3. Find `capd-master.zip` in your Downloads, then **extract it** — on Windows, right-click → *Extract All…*; on macOS, double-click it.
4. Move the extracted **`capd-master`** folder somewhere you won't clean out later — e.g. `Documents\Extensions\capd`. Avoid Downloads.

> Chrome cannot load an extension from inside a `.zip`. If **Load unpacked** greys out the folder or errors, you're most likely still pointed at the zip rather than the extracted folder.

**Option B — clone it** (if you have git, and want `git pull` to update)

```bash
git clone https://github.com/jgra-source/capd.git
```

### Step 2 — load it into Chrome

1. Open **`chrome://extensions`** (paste it into the address bar).
2. Toggle **Developer mode** on — top-right corner.
3. Click **Load unpacked** (top-left).
4. Select the folder that **directly contains `manifest.json`**. Open the folder and confirm you can see `manifest.json` next to `popup.html` and `background.js` before clicking Select. Don't select a parent folder that merely *contains* that folder.
5. Pin **Capd**: click the puzzle-piece icon in the toolbar, then the pin next to Capd, so the badge stays visible.

### Step 3 — first reading

Open **claude.ai** and send any message, then click the Capd icon.

> **Already had claude.ai open?** Reload that tab. Capd's reader only attaches to tabs opened or refreshed *after* installing.

### Updating later

Replace the folder's contents with the newer version (or `git pull`), then return to `chrome://extensions` and click the **↺ reload** icon on the Capd card.

Works in Chrome, Edge, Brave, and other Chromium browsers (Manifest V3, Chrome 111+ for `world: "MAIN"` content scripts). In Edge the extensions page is `edge://extensions` and Developer mode is on the left.

---

## Using it

1. Open **claude.ai** and send any message.
2. Click the **Capd** icon. Your rings populate from that response.

The popup updates live whenever new data arrives. If you haven't used Claude in a while, the status dot turns amber ("stale") and the badge keeps showing the last reading.

### Settings (in the popup)

- **Alert threshold** — utilization % that triggers a notification.
- **Near-cap notifications** — on/off.
- **Badge shows** — highest cap, session only, or weekly only.
- **Clear history** — wipe the sparkline data only.
- **Clear all data** — erase every captured reading, raw body and history. Takes two clicks (the first arms the button) because it can't be undone. Your settings above are kept; the next claude.ai response repopulates everything.

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

- **v1.0.7** — Account cards are now readable rather than raw.
  - **Money is formatted as currency, but only where the unit is provable.** Claude's billing API mixes scales inside a single body: `credits` returns `amount: 6983` (minor units — $69.83, corroborated by the sibling `promo_tranches[].remaining_amount_minor_units: 6982`) directly alongside `balance_credits: 69`, which is *already* in whole units. So a money-sounding name proves nothing about scale, and dividing on name alone rendered $69 as $0.69. Conversion is now limited to keys that state their own unit (`*_cents`, `*_minor`, `*_minor_units`), plus the bare `amount` field when a sibling `currency` confirms the body is describing money. Ambiguous fields (`balance_credits`, `monthly_credit_limit`, `used_credits`) are printed exactly as sent.
  - **Dates render as dates.** Timestamps become local date-times; date-only strings like `next_charge_date: "2026-08-09"` are formatted in UTC with no clock time, so they can't drift a day across the date line or imply a precision the API never sent. Bare epoch numbers only convert when the key itself reads as a time (`_at`, `expires`, `reset`, …), so counts are never mistaken for dates.
  - Every reformatted value keeps the untouched API value in a hover tooltip (`raw: 6983`), so a conversion can always be checked against what Claude actually sent.
  - Two further fields were then confirmed as minor units by value rather than by name and added: `used_credits` reads `380` in the usage body, byte-identical to `spend.used.amount_minor: 380` tagged `{currency: "USD", exponent: 2}`, and `380/10000` equals the separately reported `utilization: 3.8`; `monthly_credit_limit` shares a body with `used_credits`, so `5000` renders as `$50.00`.
  - **Collapsible detail.** Everything below the two rings — other limits, account cards, session history — now sits under a **More details** toggle that remembers whether it was left open.
  - **Clear all data** action in Settings, wired to the previously unreachable `clearAll` handler. It wipes readings, raw bodies, history and seen endpoints — including any stale `unknown` body left over from the v1.0.5 bucketing bug — but restores `settings` afterwards, so a data reset is not a preferences reset. Arming it takes two clicks.
  - Rewrote the install guide with actual download steps (GitHub **Code → Download ZIP**, or `git clone`), the extract-before-loading gotcha, how to pick the folder containing `manifest.json`, and how to update later.
- **v1.0.6** — Fixed the badge showing no number. Three causes: (1) `parseUsageBodies()` filled each window/metric slot on a first-wins basis and accepted `null`, so a body captured before the usage body could lock a null into `5h.utilization` — the window was then emitted with a reset time but no number, drawing a `—` ring and a blank badge; it now takes the first *non-null* value. (2) The `7d` window pattern never matched claude.ai's `seven_day` field name, so the Weekly gauge silently never resolved. (3) `setSettings` refreshed the badge from header windows only, which are always empty on claude.ai, blanking the badge on every settings change; it now re-reads both stores, and opening the popup re-syncs the badge.
- **v1.0.5** — Fixed the gauge intermittently dropping to `—`: `kindFromUrl()` in `background.js` still keyed on the old `/api/v1/{account_id}/` prefix after `BODY_RE` was broadened in v1.0.3, so every captured body was bucketed as `unknown` and overwrote the previous one in storage. A non-usage response landing after the usage response wiped the reading. `kindFromUrl()` now matches the same endpoint tokens `BODY_RE` gates on, giving each body a distinct key.
- **v1.0.4** — Added a guarded background auto-refresh (`chrome.alarms`, ~20 min + on popup open) that re-polls the seen usage endpoints so readings stay current without re-sending a message. It parses fresh responses in isolation and only overlays real numbers, so it can never blank or corrupt an existing reading.
- **v1.0.3** — Broadened `BODY_RE` in `inject.js` to match Claude.ai's updated API URL structure (no longer requires the strict `/api/v1/{account_id}/` prefix), restoring session readings after the endpoint paths changed.
- **v1.0.2** — Confirmed claude.ai's web app emits no `anthropic-ratelimit-*` headers; pivoted utilization to a self-discovering `usage`-body parser (`usage-body-parser.js`) that emits native window objects, merged non-destructively with any header data. Added a Diagnostics raw-body dump with one-tap copy for schema verification.
- **v1.0.1** — Show partial data (balance without headers); add Diagnostics panel; fix stale-tab empty state.
- **v1.0.0** — Initial build: header + body capture, gauges, badge, notifications, history, settings.
