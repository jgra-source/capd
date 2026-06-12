/*
 * Claude Usage Meter — bridge (ISOLATED world content script).
 *
 * The MAIN-world injector cannot call chrome.* APIs. This isolated-world
 * script can. It listens for the injector's window.postMessage events and
 * relays them to the background service worker.
 */
window.addEventListener(
  "message",
  (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "claude-usage-meter") return;

    try {
      chrome.runtime.sendMessage({
        type: data.kind, // "headers" | "body"
        url: data.url,
        body: data.body,
        headers: data.headers,
      });
    } catch (e) {
      // Service worker may be asleep mid-teardown; the next event re-wakes it.
    }
  },
  false
);
