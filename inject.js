/*
 * Claude Usage Meter — page-world injector (MAIN world).
 *
 * Runs in claude.ai's own JS context so it can wrap window.fetch and
 * XMLHttpRequest. Because requests to claude.ai/api are SAME-ORIGIN, the
 * Fetch/XHR APIs expose ALL response headers to us here — including the
 * custom `anthropic-ratelimit-*` headers that carry utilization.
 *
 * It captures two things and forwards them via window.postMessage to
 * bridge.js (the isolated content script), which relays to the service
 * worker:
 *   1. Any `anthropic-ratelimit-*` response headers (the usage signal).
 *   2. JSON bodies from the credit/usage endpoints (the balance signal).
 *
 * Nothing is sent anywhere off-device. No auth tokens or cookies are read.
 */
(function () {
  if (window.__claudeUsageMeterInjected) return;
  window.__claudeUsageMeterInjected = true;

  const TAG = "claude-usage-meter";

  // Endpoints whose JSON bodies we want (credit / spend / subscription surface).
  const BODY_RE =
    /\/api\/(?:[^/]+\/)*(usage|balance|credits|subscription_details|paused_subscription_details|overage_spend_limit|overage_credit_grant|run-budget|consumer_pricing)\b/i;

  function post(payload) {
    try {
      window.postMessage(Object.assign({ source: TAG }, payload), location.origin);
    } catch (e) { /* noop */ }
  }

  function headersFromFetch(res) {
    const h = {};
    try {
      res.headers.forEach((v, k) => {
        const key = String(k).toLowerCase();
        if (key.startsWith("anthropic-ratelimit")) h[key] = v;
      });
    } catch (e) { /* noop */ }
    return h;
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  window.fetch = function () {
    const args = arguments;
    return origFetch.apply(this, args).then((res) => {
      try {
        const rawUrl =
          typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        const abs = new URL(rawUrl, location.href).href;

        const h = headersFromFetch(res);
        if (Object.keys(h).length) post({ kind: "headers", headers: h });

        if (BODY_RE.test(abs)) {
          res.clone().json()
            .then((body) => post({ kind: "body", url: abs, body }))
            .catch(() => {});
        }
      } catch (e) { /* noop */ }
      return res;
    });
  };

  // ---- XMLHttpRequest ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cum_url = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        const abs = new URL(this.__cum_url || "", location.href).href;

        const rawHeaders = this.getAllResponseHeaders() || "";
        const h = {};
        rawHeaders.trim().split(/\r?\n/).forEach((line) => {
          const i = line.indexOf(":");
          if (i > 0) {
            const k = line.slice(0, i).trim().toLowerCase();
            if (k.startsWith("anthropic-ratelimit")) h[k] = line.slice(i + 1).trim();
          }
        });
        if (Object.keys(h).length) post({ kind: "headers", headers: h });

        if (BODY_RE.test(abs)) {
          let body = null;
          try { body = JSON.parse(this.responseText); } catch (e) { /* noop */ }
          if (body) post({ kind: "body", url: abs, body });
        }
      } catch (e) { /* noop */ }
    });
    return origSend.apply(this, arguments);
  };
})();
