/*
 * Capd — usage-body parser (worker-safe, no ES modules).
 *
 * WHY: Diagnostics confirmed claude.ai's web app emits no anthropic-ratelimit-*
 * headers, so the header path never fills the gauges. This recovers the same
 * per-window utilization from the captured account/usage JSON bodies instead.
 *
 * Loaded by background.js via importScripts("usage-body-parser.js"), which
 * exposes self.parseUsageBodies(bodies).
 *
 * INPUT  : the stored bodies map -> { [kind]: { body, updatedAt } }
 * OUTPUT : { windows } where each window is NATIVE Capd shape, identical to what
 *          parseHeaders() produces, so pickWindow / gauges / badge / history /
 *          notifications consume it unchanged:
 *            windows["5h"] = {
 *              token: "5h", label: "Session",
 *              utilizationNum: 0..100 | undefined,
 *              resetAt: <ms epoch> | undefined,
 *              status: <string> | undefined,
 *              used, limit, source: "body"
 *            }
 *
 * DESIGN: self-discovering, like the header parser. It walks every body, buckets
 * fields by WINDOW (5h / 7d) and METRIC (utilization / used+limit / reset /
 * status), and picks one of two branches per window:
 *   (A) a direct utilization value exists  -> normalize it.
 *   (B) only raw counts exist              -> utilization = used / limit * 100.
 * No hardcoded endpoint schema, so it survives field renames.
 */
(function () {
  const WINDOW_LABELS = { "5h": "Session", "7d": "Weekly" };

  // Map any window-ish token onto a canonical Capd token that pickWindow knows.
  const WINDOW_PATTERNS = [
    { token: "5h", re: /(5\s*h|five[_-]?hour|session|short[_-]?term|rolling|current)/i },
    { token: "7d", re: /(7\s*d|7[_-]?day|week|weekly|long[_-]?term)/i },
  ];

  const METRIC = {
    utilization: /(utiliz|percent|pct|ratio|fraction)/i,
    used:        /(used|consum|spent|count|requests?|messages?|sent)/i,
    limit:       /(limit|cap|quota|max|allow|allotment|threshold|total)/i,
    reset:       /(reset|refresh|renew|expir|resets?_?at|window_?end|ends?_?at)/i,
    status:      /(status|state|tier|exceeded|throttl)/i,
    remaining:   /(remain|left|available)/i,
  };

  function flatten(obj, prefix, out) {
    out = out || [];
    if (obj == null || typeof obj !== "object") return out;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const path = prefix ? prefix + "." + k : k;
      if (v != null && typeof v === "object") flatten(v, path, out);
      else out.push([path, v]);
    }
    return out;
  }

  function windowOf(path) {
    for (const w of WINDOW_PATTERNS) if (w.re.test(path)) return w.token;
    return null;
  }

  function metricOf(path) {
    // utilization before used: a key literally named "utilization" must not be
    // swallowed by the broad used/count matcher.
    if (METRIC.utilization.test(path)) return "utilization";
    if (METRIC.reset.test(path))       return "reset";
    if (METRIC.status.test(path))      return "status";
    if (METRIC.limit.test(path))       return "limit";
    if (METRIC.remaining.test(path))   return "remaining";
    if (METRIC.used.test(path))        return "used";
    return null;
  }

  function toNum(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string") { const n = parseFloat(v); return isNaN(n) ? null : n; }
    return null;
  }

  // ms epoch from ISO string, unix seconds, unix ms, or seconds-remaining.
  function toResetMs(v) {
    if (v == null) return null;
    if (typeof v === "number" || /^\d+$/.test(String(v).trim())) {
      const n = typeof v === "number" ? v : parseInt(v, 10);
      if (n > 1e12) return n;            // ms epoch
      if (n > 1e9)  return n * 1000;     // s epoch
      return Date.now() + n * 1000;      // seconds remaining
    }
    const t = Date.parse(String(v));
    return isNaN(t) ? null : t;
  }

  function normPct(raw) {
    const n = toNum(raw);
    if (n == null) return null;
    const pct = n <= 1 ? n * 100 : n;    // 0..1 fraction vs 0..100 percent
    return Math.max(0, Math.min(100, pct));
  }

  function asObject(body) {
    if (body == null) return null;
    if (typeof body === "object") return body;
    if (typeof body === "string") { try { return JSON.parse(body); } catch (e) { return null; } }
    return null;
  }

  function parseUsageBodies(bodies) {
    const buckets = { "5h": {}, "7d": {} };

    for (const kind of Object.keys(bodies || {})) {
      const obj = asObject(bodies[kind] && bodies[kind].body);
      if (!obj) continue;
      for (const [path, value] of flatten(obj)) {
        const w = windowOf(path);
        const m = metricOf(path);
        if (!w || !m) continue;
        if (buckets[w][m] === undefined) buckets[w][m] = value; // first wins
      }
    }

    const windows = {};
    for (const token of ["5h", "7d"]) {
      const b = buckets[token];
      if (!Object.keys(b).length) continue;

      let utilizationNum = null;
      let used  = toNum(b.used);
      let limit = toNum(b.limit);

      if (b.utilization !== undefined) {
        utilizationNum = normPct(b.utilization);                 // branch A
      } else if (used != null && limit != null && limit > 0) {
        utilizationNum = Math.max(0, Math.min(100, (used / limit) * 100)); // branch B
      } else if (b.remaining !== undefined && limit != null && limit > 0) {
        const rem = toNum(b.remaining);                          // branch B'
        if (rem != null) { used = limit - rem; utilizationNum = ((limit - rem) / limit) * 100; }
      }

      const win = { token, label: WINDOW_LABELS[token] || token, source: "body" };
      if (utilizationNum != null) win.utilizationNum = utilizationNum;
      if (b.reset !== undefined) { const r = toResetMs(b.reset); if (r != null) win.resetAt = r; }
      if (b.status !== undefined) win.status = String(b.status);
      if (used != null) win.used = used;
      if (limit != null) win.limit = limit;

      // only emit if we actually recovered something useful
      if (win.utilizationNum != null || win.resetAt != null) windows[token] = win;
    }

    return { windows };
  }

  self.parseUsageBodies = parseUsageBodies;
})();
