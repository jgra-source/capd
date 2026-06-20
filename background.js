/*
 * Claude Usage Meter — background service worker.
 *
 * Responsibilities:
 *   - Read `anthropic-ratelimit-*` response headers off claude.ai / anthropic.com
 *     API responses via webRequest.onHeadersReceived (primary, robust path).
 *   - Accept header + body data relayed from the page injector via runtime msgs
 *     (fallback / credit-balance path).
 *   - Parse the headers into per-window utilization + reset times.
 *   - Drive the toolbar badge, near-cap notifications, and a usage history log.
 *   - Assemble state for the popup.
 *
 * All data lives in chrome.storage.local. Nothing leaves the device.
 */

// Body-derived utilization (used when claude.ai emits no ratelimit headers).
// Exposes self.parseUsageBodies(bodies).
importScripts("usage-body-parser.js");

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  threshold: 80,        // notify at/above this utilization %
  notifications: true,  // master toggle for near-cap alerts
  badgeMetric: "max",   // "max" | "session" | "weekly"
};

const HISTORY_MAX = 300;        // points kept
const HISTORY_MIN_GAP_MS = 45 * 1000; // throttle between points

const WINDOW_LABELS = {
  "5h": "Session", "1h": "Hourly", "24h": "Daily", "7d": "Weekly",
  "session": "Session", "hourly": "Hourly", "daily": "Daily", "weekly": "Weekly",
  "monthly": "Monthly",
};
const SESSION_PREF = ["5h", "session", "1h", "hourly"];
const WEEKLY_PREF = ["7d", "weekly"];

// ---------------------------------------------------------------------------
// Tiny async lock so concurrent ingests don't clobber each other
// ---------------------------------------------------------------------------
let _chain = Promise.resolve();
function withLock(fn) {
  const run = () => Promise.resolve().then(fn);
  _chain = _chain.then(run, run);
  return _chain;
}

const sget = (keys) => chrome.storage.local.get(keys);
const sset = (obj) => chrome.storage.local.set(obj);

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------
function lowerKeys(obj) {
  const out = {};
  for (const k in obj) out[String(k).toLowerCase()] = obj[k];
  return out;
}

function parseUtil(s) {
  const str = String(s).trim();
  let n = parseFloat(str);
  if (isNaN(n)) return null;
  if (str.includes(".") && n <= 1) n = n * 100; // fraction like 0.62 -> 62
  return Math.max(0, Math.min(100, n));
}

function parseReset(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n > 1e12) return n;          // ms epoch
    if (n > 1e9) return n * 1000;    // s epoch
    return Date.now() + n * 1000;    // seconds-remaining
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

const WINDOW_TOKEN = /^\d+[smhdw]$/;
const KNOWN_WINDOWS = ["weekly", "daily", "monthly", "session", "hourly"];
const KNOWN_METRICS = ["utilization", "status", "reset", "limit", "remaining", "used", "requests", "tokens"];

// Turn a flat {header: value} map into { windows: {win: {metric: value}}, raw }
function parseHeaders(rl) {
  const windows = {};
  const raw = {};
  for (const name in rl) {
    const value = rl[name];
    raw[name] = value;

    const rest = name.replace(/^anthropic-ratelimit-?/, "");
    const parts = rest.split("-").filter(Boolean);

    let win = null, metric = null;
    const ns = [];
    for (const p of parts) {
      if (WINDOW_TOKEN.test(p) || KNOWN_WINDOWS.includes(p)) win = p;
      else if (KNOWN_METRICS.includes(p)) metric = p;
      else ns.push(p);
    }
    if (!win) win = ns.join("-") || "general";
    if (!metric) metric = parts[parts.length - 1] || "value";

    if (!windows[win]) windows[win] = { _ns: ns.join("-") };
    windows[win][metric] = value;
  }

  // normalize
  for (const w in windows) {
    const win = windows[w];
    win.label = WINDOW_LABELS[w] || w;
    win.token = w;
    if (win.utilization != null) win.utilizationNum = parseUtil(win.utilization);
    if (win.reset != null) win.resetAt = parseReset(win.reset);
  }
  return { windows, raw };
}

function pickWindow(windows, prefs) {
  for (const p of prefs) if (windows[p]) return windows[p];
  return null;
}

function maxUtil(windows) {
  let m = null;
  for (const w in windows) {
    const u = windows[w].utilizationNum;
    if (typeof u === "number") m = Math.max(m == null ? 0 : m, u);
  }
  return m;
}

// Merge header-derived and body-derived windows. For any window present in both,
// prefer the source that actually carries a utilization number; on a tie headers
// win (they're the canonical signal when present).
function mergeWindows(headerWindows, bodyWindows) {
  const out = {};
  const add = (src) => {
    for (const w in (src || {})) {
      const cand = src[w];
      const ex = out[w];
      if (!ex) { out[w] = cand; continue; }
      const exHas = typeof ex.utilizationNum === "number";
      const candHas = typeof cand.utilizationNum === "number";
      if (candHas && !exHas) out[w] = cand;
    }
  };
  add(bodyWindows);
  add(headerWindows); // second pass → headers win ties
  return out;
}

// ---------------------------------------------------------------------------
// Ingest: headers
// ---------------------------------------------------------------------------
function ingestHeaders(rlMap) {
  return withLock(async () => {
    const filtered = {};
    for (const k in rlMap) {
      const lk = k.toLowerCase();
      if (lk.startsWith("anthropic-ratelimit")) filtered[lk] = rlMap[k];
    }
    if (!Object.keys(filtered).length) return;

    const store = await sget(["rl", "history", "notified", "settings"]);
    const prev = store.rl || { windows: {}, raw: {} };

    // merge raw headers (newer wins), then re-parse the merged set so a partial
    // response (e.g. only utilization on one call) doesn't wipe a known reset.
    const mergedRaw = Object.assign({}, prev.raw || {}, filtered);
    const parsed = parseHeaders(mergedRaw);

    const rl = { windows: parsed.windows, raw: parsed.raw, updatedAt: Date.now() };
    await sset({ rl });

    await maybeRecordHistory(parsed.windows, store.history || []);
    await maybeNotify(parsed.windows, store.notified || {}, store.settings || DEFAULT_SETTINGS);
    await updateBadge(parsed.windows);
  });
}

// ---------------------------------------------------------------------------
// Ingest: bodies (credit / balance / subscription surface)
// ---------------------------------------------------------------------------
function kindFromUrl(url) {
  const m = url.match(/\/api\/v1\/[^/]+\/([a-z_]+(?:-[a-z]+)*)/i);
  return m ? m[1].toLowerCase() : "unknown";
}

function ingestBody(url, body) {
  return withLock(async () => {
    if (!url || body == null) return;
    const kind = kindFromUrl(url);
    const store = await sget(["bodies", "rl", "history", "notified", "settings"]);
    const bodies = store.bodies || {};
    bodies[kind] = { body, updatedAt: Date.now() };
    await sset({ bodies });

    // Headers are absent on the claude.ai web app, so derive utilization from
    // the bodies themselves. Store separately (rlb) so a future header response
    // never clobbers it and vice-versa; they're merged at read time.
    const derived = self.parseUsageBodies(bodies); // { windows }
    const rlb = { windows: derived.windows, updatedAt: Date.now() };
    await sset({ rlb });

    const merged = mergeWindows((store.rl && store.rl.windows) || {}, derived.windows);
    if (Object.keys(merged).length) {
      await maybeRecordHistory(merged, store.history || []);
      await maybeNotify(merged, store.notified || {}, store.settings || DEFAULT_SETTINGS);
      await updateBadge(merged);
    }
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
async function maybeRecordHistory(windows, history) {
  const session = pickWindow(windows, SESSION_PREF);
  const weekly = pickWindow(windows, WEEKLY_PREF);
  const s = session && typeof session.utilizationNum === "number" ? session.utilizationNum : null;
  const w = weekly && typeof weekly.utilizationNum === "number" ? weekly.utilizationNum : null;
  if (s == null && w == null) return;

  const now = Date.now();
  const last = history[history.length - 1];
  const changed = !last || (s != null && s !== last.s) || (w != null && w !== last.w);
  const aged = !last || now - last.t >= HISTORY_MIN_GAP_MS;
  if (!changed && !aged) return;

  history.push({ t: now, s, w });
  if (history.length > HISTORY_MAX) history = history.slice(history.length - HISTORY_MAX);
  await sset({ history });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
async function maybeNotify(windows, notified, settings) {
  settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  if (!settings.notifications) return;

  // prune expired reset keys
  const now = Date.now();
  for (const key in notified) {
    const at = notified[key];
    if (typeof at === "number" && at < now) delete notified[key];
  }

  let changed = false;
  for (const w in windows) {
    const win = windows[w];
    const u = win.utilizationNum;
    if (typeof u !== "number" || u < settings.threshold) continue;
    const resetAt = win.resetAt || 0;
    const key = `${w}:${resetAt}`;
    if (notified[key]) continue;

    notified[key] = resetAt || (now + 6 * 3600 * 1000);
    changed = true;

    const label = win.label || w;
    chrome.notifications.create(`cum-${key}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `Claude ${label} usage at ${Math.round(u)}%`,
      message: resetAt
        ? `Resets ${formatReset(resetAt)}. You're approaching this cap.`
        : `You're approaching this cap.`,
      priority: 1,
    });
  }
  if (changed) await sset({ notified });
}

function formatReset(ms) {
  const d = ms - Date.now();
  if (d <= 0) return "now";
  const mins = Math.round(d / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem ? `in ${hrs}h ${rem}m` : `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `in ${days}d ${hrs % 24}h`;
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------
async function updateBadge(windows) {
  if (!windows) {
    const store = await sget(["rl", "rlb"]);
    windows = mergeWindows(
      (store.rl && store.rl.windows) || {},
      (store.rlb && store.rlb.windows) || {}
    );
  }
  const store = await sget(["settings"]);
  const settings = Object.assign({}, DEFAULT_SETTINGS, store.settings || {});

  let value = null;
  if (settings.badgeMetric === "session") {
    const s = pickWindow(windows, SESSION_PREF);
    value = s ? s.utilizationNum : null;
  } else if (settings.badgeMetric === "weekly") {
    const w = pickWindow(windows, WEEKLY_PREF);
    value = w ? w.utilizationNum : null;
  } else {
    value = maxUtil(windows);
  }

  if (typeof value !== "number") {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  chrome.action.setBadgeText({ text: String(Math.round(value)) });
  const color = value >= 90 ? "#e5484d" : value >= 75 ? "#fcc419" : "#ff7a18";
  chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#ffffff" });
}

// ---------------------------------------------------------------------------
// State assembly for popup
// ---------------------------------------------------------------------------
async function getState() {
  const store = await sget(["rl", "rlb", "bodies", "history", "settings"]);
  const headerWindows = (store.rl && store.rl.windows) || {};
  const bodyWindows = (store.rlb && store.rlb.windows) || {};
  const windows = mergeWindows(headerWindows, bodyWindows);
  const updatedAt = Math.max(
    (store.rl && store.rl.updatedAt) || 0,
    (store.rlb && store.rlb.updatedAt) || 0
  ) || null;
  return {
    rl: store.rl || (store.rlb ? { windows, raw: {}, updatedAt } : null),
    session: pickWindow(windows, SESSION_PREF),
    weekly: pickWindow(windows, WEEKLY_PREF),
    windows,
    bodies: store.bodies || {},
    history: store.history || [],
    settings: Object.assign({}, DEFAULT_SETTINGS, store.settings || {}),
    updatedAt,
  };
}

// ---------------------------------------------------------------------------
// webRequest: primary header capture
// ---------------------------------------------------------------------------
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    try {
      const rl = {};
      for (const h of details.responseHeaders || []) {
        const name = (h.name || "").toLowerCase();
        if (name.startsWith("anthropic-ratelimit")) rl[name] = h.value;
      }
      if (Object.keys(rl).length) ingestHeaders(rl);
    } catch (e) { /* noop */ }
  },
  { urls: ["https://claude.ai/api/*", "https://*.anthropic.com/*"] },
  ["responseHeaders"]
);

// ---------------------------------------------------------------------------
// Messages from the page bridge + popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "headers":
      if (msg.headers) ingestHeaders(lowerKeys(msg.headers));
      return;
    case "body":
      if (msg.url) ingestBody(msg.url, msg.body);
      return;
    case "getState":
      getState().then(sendResponse);
      return true; // async
    case "setSettings":
      withLock(async () => {
        const store = await sget(["settings", "rl"]);
        const next = Object.assign({}, DEFAULT_SETTINGS, store.settings || {}, msg.settings || {});
        await sset({ settings: next });
        await updateBadge((store.rl && store.rl.windows) || {});
        sendResponse({ ok: true, settings: next });
      });
      return true;
    case "clearHistory":
      withLock(async () => {
        await sset({ history: [] });
        sendResponse({ ok: true });
      });
      return true;
    case "clearAll":
      withLock(async () => {
        await chrome.storage.local.clear();
        chrome.action.setBadgeText({ text: "" });
        sendResponse({ ok: true });
      });
      return true;
  }
});

// Restore badge on worker wake.
chrome.runtime.onStartup.addListener(() => updateBadge());
chrome.runtime.onInstalled.addListener(() => updateBadge());
