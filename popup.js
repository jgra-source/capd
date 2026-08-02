/* Capd — popup controller */

const C = 2 * Math.PI * 52; // ring circumference (r = 52)

const $ = (sel) => document.querySelector(sel);

function send(type, extra) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (r) => resolve(r));
    } catch (e) { resolve(null); }
  });
}

// ---- formatting helpers ----
function meterColor(v) {
  if (typeof v !== "number") return "var(--track)";
  if (v >= 90) return "var(--red)";
  if (v >= 75) return "var(--amber)";
  return "var(--accent)";
}

function fmtCountdown(ms) {
  const d = ms - Date.now();
  if (d <= 0) return "resetting…";
  const total = Math.floor(d / 1000);
  const days = Math.floor(total / 86400);
  const hrs = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `resets in ${days}d ${hrs}h`;
  if (hrs > 0) return `resets in ${hrs}h ${mins}m`;
  if (mins > 0) return `resets in ${mins}m ${secs}s`;
  return `resets in ${secs}s`;
}

function fmtAgo(ts) {
  if (!ts) return "no data";
  const d = Date.now() - ts;
  const s = Math.floor(d / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function fmtNumber(n) {
  if (typeof n !== "number" || !isFinite(n)) return String(n);
  return n % 1 === 0 ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function prettyKey(k) {
  return k.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// A date-only value ("2026-08-09") is rendered in UTC and without a clock time.
// Parsing it as local would shift it a day either side of the date line, and
// tacking on "12:00 AM" invents precision the API never sent.
function fmtDate(ms, dateOnly) {
  const opts = dateOnly
    ? { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }
    : { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };
  return new Date(ms).toLocaleString(undefined, opts);
}

// Returns a readable date string when the value reads as a date, else null.
// ISO-like strings always qualify; bare epoch numbers only when the key sounds
// like a timestamp, so counts/amounts are never mistaken for dates.
const DATEISH_KEY = /(_at\b|date|time|expir|reset|start|end|until|renew)/i;
function dateDisplay(key, val) {
  if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(val.trim())) {
    const s = val.trim();
    const t = Date.parse(s);
    if (!isNaN(t)) return fmtDate(t, /^\d{4}-\d{2}-\d{2}$/.test(s));
  }
  if (typeof val === "number" && DATEISH_KEY.test(key)) {
    if (val > 1e12 && val < 4e12) return fmtDate(val);       // ms epoch
    if (val > 1e9 && val < 4e9) return fmtDate(val * 1000);  // s epoch
  }
  return null;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- builders ----
function gaugeHTML(win, fallbackLabel) {
  const has = win && typeof win.utilizationNum === "number";
  const v = has ? win.utilizationNum : null;
  const offset = has ? C * (1 - v / 100) : C;
  const color = meterColor(v);
  const label = (win && win.label) || fallbackLabel;
  const token = win && win.token ? win.token : "";
  const resetAttr = win && win.resetAt ? ` data-reset="${win.resetAt}"` : "";
  const sub = win && win.resetAt
    ? `${token ? `<span class="tok">${esc(token)}</span> · ` : ""}…`
    : (token ? `<span class="tok">${esc(token)}</span> window` : (has ? "no reset info" : "no reading"));

  return `
    <div class="gauge fade">
      <div class="ring-wrap">
        <svg class="ring" viewBox="0 0 116 116">
          <circle class="track" cx="58" cy="58" r="52" fill="none" stroke-width="9"/>
          <circle class="meter" cx="58" cy="58" r="52" fill="none" stroke-width="9"
                  stroke-dasharray="${C.toFixed(3)}" stroke-dashoffset="${offset.toFixed(3)}"
                  style="stroke:${color}"/>
        </svg>
        <div class="ring-center">
          <div class="ring-pct">${has ? Math.round(v) : "—"}<span class="unit">%</span></div>
        </div>
      </div>
      <div class="gauge-label">${esc(label)}</div>
      <div class="gauge-sub"${resetAttr}>${sub}</div>
    </div>`;
}

function extraWindowsHTML(state) {
  const used = new Set();
  if (state.session) used.add(state.session.token);
  if (state.weekly) used.add(state.weekly.token);
  const extras = Object.values(state.windows).filter(
    (w) => !used.has(w.token) && typeof w.utilizationNum === "number"
  );
  if (!extras.length) return "";
  const rows = extras.map((w) => `
    <div class="win-row">
      <span class="win-name">${esc(w.label || w.token)}</span>
      <span class="win-bar"><i style="width:${Math.round(w.utilizationNum)}%;background:${meterColor(w.utilizationNum)}"></i></span>
      <span class="win-val">${Math.round(w.utilizationNum)}%</span>
    </div>`).join("");
  return `<div class="card"><div class="card-title">Other limits</div>${rows}</div>`;
}

// Money conversion is deliberately restricted to fields that state their own
// unit in the name, because Claude's billing API mixes scales within a single
// body: `credits` reports `amount` in minor units right next to
// `balance_credits`, which is already in whole units and reads as roughly
// one-hundredth of it. A name like "balance" or "credits" therefore proves
// nothing about scale, and converting on the name alone divides an already-
// whole value by 100 — turning $69 into $0.69.
const MINOR_UNIT_KEY = /_cents$|_minor$|minor_units?$/i;

// `amount` is the sole exception: it never names its unit, but the credits body
// pins it down — it tracks the promo tranche's `remaining_amount_minor_units`
// to within a unit. Only trusted when a sibling `currency` field confirms the
// body is talking about money at all.
//
// Nothing else earns an exception. `monthly_credit_limit` was briefly added on
// the reasoning that it shares a body with a field proven to be minor units.
// That produced a plausible figure which matched no limit the account actually
// displays — the real one is asserted independently by
// `spend.limit.amount_minor`, `extra_usage.monthly_limit`,
// `overage_credit_grant.amount_minor_units` and the promo tranche's
// `granted_amount_minor_units`, which all agree. `monthly_credit_limit` is a
// disabled organization-scoped setting describing something else entirely.
// Sharing a body is proximity, not proof; only the value's own declared unit is.
const BARE_AMOUNT_KEY = /^amount$/i;

function formatCurrency(major, currency) {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(major);
    } catch (e) { /* unknown currency code — fall through */ }
  }
  return major.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    + (currency ? " " + currency : "");
}

function fmtMoney(minorUnits, currency) {
  return formatCurrency(minorUnits / 100, currency);
}

function moneyDisplay(key, val, currency) {
  if (typeof val !== "number" || !isFinite(val)) return null;
  const isMinor = MINOR_UNIT_KEY.test(key) || (currency && BARE_AMOUNT_KEY.test(key));
  if (!isMinor) return null;
  return fmtMoney(val, currency);
}

function scalarRows(body, max = 8) {
  const rows = [];
  const currency = typeof body.currency === "string" ? body.currency.toUpperCase() : null;
  for (const k in body) {
    if (rows.length >= max) break;
    const val = body[k];
    const t = typeof val;
    if (t === "string" || t === "number" || t === "boolean") {
      const asDate = dateDisplay(k, val);
      const asMoney = asDate ? null : moneyDisplay(k, val, currency);
      let display = asDate ? esc(asDate)
        : asMoney ? esc(asMoney)
        : t === "boolean" ? (val ? "Yes" : "No")
        : t === "number" ? fmtNumber(val) : esc(val);
      // Keep the untouched API value one hover away, so a reformatted row can
      // always be checked against what Claude actually sent.
      const title = (asDate || asMoney) ? ` title="raw: ${esc(val)}"` : "";
      rows.push(`<div class="kv"><span class="k">${esc(prettyKey(k))}</span><span class="v"${title}>${display}</span></div>`);
    }
  }
  return rows.join("");
}

function balanceHTML(bodies) {
  // `usage` and `overage_spend_limit` are deliberately absent: their top-level
  // scalars are org UUIDs, internal flags and ambiguous counts that no one can
  // act on.
  const order = ["balance", "credits", "subscription_details"];
  let out = "";
  for (const kind of order) {
    const entry = bodies[kind];
    if (!entry || !entry.body) continue;
    const rows = scalarRows(entry.body);
    if (!rows) continue;
    out += `<div class="card"><div class="card-title">${esc(prettyKey(kind))}</div>${rows}</div>`;
  }
  return out;
}

function sparkHTML(history) {
  const pts = history.filter((p) => typeof p.s === "number");
  if (pts.length < 2) return "";
  const W = 328, H = 40, pad = 2;
  const n = pts.length;
  const xs = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * (W - pad * 2) + pad);
  const ys = (v) => H - pad - (v / 100) * (H - pad * 2);
  let d = "";
  pts.forEach((p, i) => { d += `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.s).toFixed(1)} `; });
  const area = `M${pad},${H} ` + pts.map((p, i) => `L${xs(i).toFixed(1)},${ys(p.s).toFixed(1)}`).join(" ") + ` L${(W - pad)},${H} Z`;
  return `
    <div class="card">
      <div class="card-title">Session history</div>
      <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <path class="area" d="${area}"/>
        <path class="line" d="${d.trim()}"/>
      </svg>
    </div>`;
}

// Collapsible wrapper for everything below the two rings (other limits,
// account cards, history). Open/closed choice is remembered across popups.
const MORE_KEY = "capd.moreOpen";
function moreHTML(inner) {
  const open = localStorage.getItem(MORE_KEY) !== "0";
  return `
    <details class="more" id="more"${open ? " open" : ""}>
      <summary class="more-toggle">
        <span>More details</span>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      ${inner}
    </details>`;
}

// ---- main render ----
function emptyHTML() {
  return `
    <div class="empty fade">
      <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
      </svg>
      <h3>No readings yet</h3>
      <p>Open <b>claude.ai</b> and send a message. If a tab was already open, <b>reload it</b> after installing Capd — the reader only attaches to tabs opened or refreshed after install.</p>
    </div>`;
}

function waitingHeadersHTML() {
  return `
    <div class="card fade">
      <div class="card-title">Rate limits</div>
      <p style="margin:0;font-size:12px;color:var(--muted);line-height:1.5">
        Waiting for usage headers — these arrive when you <b>send a message</b> on claude.ai. Account data below is already in.
      </p>
    </div>`;
}

function renderMain(state) {
  const main = $("#main");
  const windows = state.windows || {};
  const hasHeaders = Object.keys(windows).length > 0;
  const bodies = state.bodies || {};
  const hasBodies = Object.keys(bodies).length > 0;

  let html = "";
  if (!hasHeaders && !hasBodies) {
    html += emptyHTML();
  } else {
    if (hasHeaders) {
      html += `<div class="gauges">${gaugeHTML(state.session, "Session")}${gaugeHTML(state.weekly, "Weekly")}</div>`;
    } else {
      html += waitingHeadersHTML();
    }
    const details = extraWindowsHTML(state) + balanceHTML(bodies) + sparkHTML(state.history);
    if (details) html += moreHTML(details);
  }
  main.innerHTML = html;
  const more = $("#more");
  if (more) more.addEventListener("toggle", () => {
    localStorage.setItem(MORE_KEY, more.open ? "1" : "0");
  });
  tick(); // fill countdowns immediately
}

function updateStatus(state) {
  const dot = $("#status-dot");
  const text = $("#status-text");
  const bodies = state.bodies || {};
  let updatedAt = state.updatedAt || 0;
  for (const k in bodies) if (bodies[k].updatedAt) updatedAt = Math.max(updatedAt, bodies[k].updatedAt);
  const hasAny = !!state.rl || Object.keys(bodies).length > 0;
  if (!hasAny) { dot.className = "dot"; text.textContent = "—"; text.dataset.ts = ""; return; }
  const stale = Date.now() - updatedAt > 5 * 60 * 1000;
  dot.className = "dot " + (stale ? "stale" : "live");
  const status = state.session && state.session.status;
  text.dataset.ts = updatedAt || "";
  text.textContent = status ? esc(status) : fmtAgo(updatedAt);
}

// ---- live ticking for countdowns + "ago" ----
function tick() {
  document.querySelectorAll(".gauge-sub[data-reset]").forEach((el) => {
    const at = parseInt(el.dataset.reset, 10);
    const tok = el.querySelector(".tok");
    const prefix = tok ? tok.outerHTML + " · " : "";
    if (!isNaN(at)) el.innerHTML = prefix + fmtCountdown(at);
  });
  const st = $("#status-text");
  if (st && st.dataset.ts && !(currentState && currentState.session && currentState.session.status)) {
    st.textContent = fmtAgo(parseInt(st.dataset.ts, 10));
  }
}

// ---- settings ----
function initSettings(settings) {
  const thr = $("#threshold"), thrVal = $("#threshold-val");
  thr.value = settings.threshold;
  thrVal.textContent = settings.threshold + "%";
  thr.addEventListener("input", () => { thrVal.textContent = thr.value + "%"; });
  thr.addEventListener("change", () => send("setSettings", { settings: { threshold: parseInt(thr.value, 10) } }));

  const notif = $("#notifications");
  notif.checked = !!settings.notifications;
  notif.addEventListener("change", () => send("setSettings", { settings: { notifications: notif.checked } }));

  const badge = $("#badge-metric");
  badge.value = settings.badgeMetric || "max";
  badge.addEventListener("change", () => send("setSettings", { settings: { badgeMetric: badge.value } }));

  const toggle = $("#settings-toggle"), body = $("#settings-body");
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    body.hidden = open;
  });

  $("#open-claude").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://claude.ai/" });
    window.close();
  });
  $("#clear-history").addEventListener("click", async () => {
    await send("clearHistory");
    refresh();
  });

  // Clearing everything is destructive and can't be undone, so it takes two
  // clicks: the first arms the button and relabels it, the second (within 4s)
  // commits. Walking away disarms it on its own.
  const clearAll = $("#clear-all");
  const label = clearAll.querySelector("[data-label]");
  let armTimer = null;
  const disarm = () => {
    clearTimeout(armTimer);
    armTimer = null;
    clearAll.classList.remove("is-armed");
    label.textContent = "Clear all data";
  };
  clearAll.addEventListener("click", async () => {
    if (!armTimer) {
      clearAll.classList.add("is-armed");
      label.textContent = "Click again to erase";
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    await send("clearAll");
    refresh();
  });
}

// ---- boot ----
let currentState = null;

async function refresh() {
  currentState = await send("getState");
  if (!currentState) return;
  renderMain(currentState);
  updateStatus(currentState);
}

async function boot() {
  currentState = await send("getState");
  currentState = currentState || { settings: { threshold: 80, notifications: true, badgeMetric: "max" }, bodies: {}, windows: {}, history: [] };
  initSettings(currentState.settings);
  renderMain(currentState);
  updateStatus(currentState);
  setInterval(tick, 1000);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.rl || changes.rlb || changes.bodies || changes.history) refresh();
});

document.addEventListener("DOMContentLoaded", boot);
