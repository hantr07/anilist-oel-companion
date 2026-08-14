// AniList OEL Companion (MangaDex) — background service worker
// Only job: relay fetches to api.mangadex.org, since the content script
// running on anilist.co can't hit a different origin itself, but this
// worker can thanks to host_permissions.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "OEL_FETCH") return false;

  (async () => {
    const controller = new AbortController();
    const timeout = msg.binary ? 25000 : 20000;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(msg.url, {
        method: "GET",
        headers: msg.headers || {},
        signal: controller.signal,
      });
      if (msg.binary) {
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        sendResponse({
          ok: true,
          status: res.status,
          mime: res.headers.get("content-type") || "image/jpeg",
          b64: btoa(binary),
        });
      } else {
        const text = await res.text();
        sendResponse({ ok: true, status: res.status, text });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    } finally {
      clearTimeout(timer);
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});
