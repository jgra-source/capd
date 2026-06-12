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

function scalarRows(body, max = 8) {
  const rows = [];
  for (const k in body) {
    if (rows.length >= max) break;
    const val = body[k];
    const t = typeof val;
    if (t === "string" || t === "number" || t === "boolean") {
      let display = t === "boolean" ? (val ? "Yes" : "No") : t === "number" ? fmtNumber(val) : esc(val);
      rows.push(`<div class="kv"><span class="k">${esc(prettyKey(k))}</span><span class="v">${display}</span></div>`);
    }
  }
  return rows.join("");
}

function balanceHTML(bodies) {
  const order = ["balance", "credits", "usage", "subscription_details", "overage_spend_limit"];
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

// ---- main render ----
function renderMain(state) {
  const main = $("#main");
  const hasData = !!state.rl;

  if (!hasData) {
    main.innerHTML = `
      <div class="empty fade">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
        </svg>
        <h3>No readings yet</h3>
        <p>Open <b>claude.ai</b> and send a message. Capd reads your usage from the response as you go — then it shows up here.</p>
      </div>`;
    return;
  }

  let html = `<div class="gauges">
    ${gaugeHTML(state.session, "Session")}
    ${gaugeHTML(state.weekly, "Weekly")}
  </div>`;
  html += extraWindowsHTML(state);
  html += balanceHTML(state.bodies);
  html += sparkHTML(state.history);
  main.innerHTML = html;
  tick(); // fill countdowns immediately
}

function updateStatus(state) {
  const dot = $("#status-dot");
  const text = $("#status-text");
  if (!state.rl) { dot.className = "dot"; text.textContent = "—"; return; }
  const age = Date.now() - (state.updatedAt || 0);
  const stale = age > 5 * 60 * 1000;
  dot.className = "dot " + (stale ? "stale" : "live");
  const status = state.session && state.session.status;
  text.dataset.ts = state.updatedAt || "";
  text.textContent = status ? esc(status) : fmtAgo(state.updatedAt);
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
  if (changes.rl || changes.bodies || changes.history) refresh();
});

document.addEventListener("DOMContentLoaded", boot);
