// AniList OEL Companion (MangaDex) — content script
// Injects a personal, local-only OEL/manhwa/manhua library into anilist.co's
// real Activity feed: a compact inline card (search + add + edit-in-place)
// sits above the feed, and titles with 1+ chapter logged get a cloned feed
// entry that blends in with your real activity. Nothing here touches your
// actual AniList account or data — it's all local to this browser.

(async function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   *  Storage (chrome.storage.local — local to you, not synced to AniList)
   * ------------------------------------------------------------------ */
  const STORAGE_KEY = "oel_companion_library_v1";

  function loadLibrary() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        try {
          resolve(JSON.parse(res[STORAGE_KEY] || "[]"));
        } catch (e) {
          resolve([]);
        }
      });
    });
  }

  function saveLibrary(list, opts) {
    chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(list) }, () => {
      if (chrome.runtime.lastError) console.error("[OEL Companion] storage error:", chrome.runtime.lastError);
    });
    if (typeof scheduleInjectIntoFeed === "function") scheduleInjectIntoFeed();
    if (!opts || !opts.skipBackup) writeAutoBackup(list);
  }

  let library = await loadLibrary();

  /* ------------------------------------------------------------------ *
   *  Backup — persists the directory handle in IndexedDB (survives
   *  uninstall) and writes oel-companion-library.json on every change.
   *  Chrome persists the folder permission per-site, so once granted it
   *  stays enabled automatically without re-picking the folder.
   * ------------------------------------------------------------------ */
  const BAK_DB = "oel_companion_backup";
  const BAK_STORE = "handles";
  const BAK_KEY = "backupDir";
  const BAK_BASENAME = "oel-companion-library";

  let backupDir = null; // live handle kept for this session

  function bakOpenDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(BAK_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(BAK_STORE)) {
          req.result.createObjectStore(BAK_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function bakGetDir() {
    try {
      const db = await bakOpenDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(BAK_STORE, "readonly");
        const req = tx.objectStore(BAK_STORE).get(BAK_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  async function bakPutDir(dir) {
    const db = await bakOpenDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BAK_STORE, "readwrite");
      tx.objectStore(BAK_STORE).put(dir, BAK_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function bakEnsure(dir) {
    if (!dir) return null;
    try {
      let p = "prompt";
      if (dir.queryPermission) {
        p = await dir.queryPermission({ mode: "readwrite" });
      } else {
        p = dir.permission;
      }
      // "prompt" usually means granted earlier this session; ask to confirm.
      if (p !== "granted" && dir.requestPermission) {
        try {
          p = await dir.requestPermission({ mode: "readwrite" });
        } catch (e) {
          p = "denied";
        }
      }
      return p === "granted" ? dir : null;
    } catch (e) {
      return null;
    }
  }

  async function bakRequestFolder() {
    if (typeof window.showDirectoryPicker !== "function") {
      throw new Error("This browser needs File System Access (Chrome 86+).");
    }
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    const ok = await bakEnsure(dir);
    if (!ok) throw new Error("Permission not granted.");
    backupDir = ok;
    await bakPutDir(ok);
    return ok;
  }

  async function writeAutoBackup(list) {
    let dir = backupDir || await bakGetDir();
    dir = await bakEnsure(dir);
    if (!dir) return;
    try {
      const name = await writeBackupFile(dir, list);
      console.log("[OEL Companion] auto-backup snapshot written:", name);
    } catch (e) {
      console.error("[OEL Companion] auto-backup failed:", e);
    }
  }

  function bakTimestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
      `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}` +
      `-${String(d.getMilliseconds()).padStart(3, "0")}`
    );
  }

  async function writeBackupFile(dir, list) {
    const name = `${BAK_BASENAME}-${bakTimestamp()}.json`;
    const fh = await dir.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(list, null, 2));
    await writable.close();
    return name;
  }

  /* ------------------------------------------------------------------ *
   *  Progress tracking (local, per-entry)
   * ------------------------------------------------------------------ */
  const STATUS_META = {
    reading: { label: "Reading", color: "#3db4f2" },
    planning: { label: "Planning", color: "#8b98ab" },
    completed: { label: "Completed", color: "#4cd964" },
    paused: { label: "Paused", color: "#e8c14a" },
    dropped: { label: "Dropped", color: "#ff5c68" },
  };
  const STATUS_ORDER = ["reading", "planning", "completed", "paused", "dropped"];

  function defaultTrack() {
    return { status: "planning", chapterFrom: null, chapterTo: 0, updatedAt: Date.now() };
  }

  function ensureTrack(series) {
    if (!series._track) series._track = defaultTrack();
    if (series._track.chapterTo === undefined) {
      series._track.chapterTo = series._track.progress || 0;
      series._track.chapterFrom = null;
    }
    return series._track;
  }

  function findInLibrary(id) {
    return library.find((s) => String(s.id) === String(id));
  }

  /* ------------------------------------------------------------------ *
   *  MangaDex API (relayed through the background worker for CORS).
   *  Chosen over MangaBaka because MangaDex's response shape is public,
   *  documented, and stable — no more guessing field names blind.
   * ------------------------------------------------------------------ */
  const API_BASE = "https://api.mangadex.org/";
  const COVER_BASE = "https://uploads.mangadex.org/covers/";
  const FORMAT_TAGS = ["Manhwa", "Manhua", "Webtoon", "Long Strip"];

  function buildQuery(params) {
    const usp = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (Array.isArray(value)) {
        value.forEach((v) => usp.append(key, v));
      } else if (value !== undefined && value !== null) {
        usp.append(key, value);
      }
    }
    return usp.toString();
  }

  function apiGet(path, params) {
    const qs = buildQuery(params);
    const url = API_BASE + path + (qs ? "?" + qs : "");
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "OEL_FETCH", url }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Extension messaging error: ${chrome.runtime.lastError.message}`));
          return;
        }
        if (!res || !res.ok) {
          reject(new Error((res && res.error) || `Network error contacting MangaDex. URL: ${url}`));
          return;
        }
        let json;
        try {
          json = JSON.parse(res.text);
        } catch (e) {
          reject(new Error(`MangaDex returned non-JSON (HTTP ${res.status}). URL: ${url}`));
          return;
        }
        if (res.status !== 200 || json.result === "error") {
          const msg = (json && json.errors && json.errors[0] && json.errors[0].detail) || `HTTP ${res.status}`;
          reject(new Error(`MangaDex API error: ${msg}. URL: ${url}`));
          return;
        }
        resolve(json);
      });
    });
  }

  function pickLocalized(obj) {
    if (!obj || typeof obj !== "object") return "";
    return obj.en || Object.values(obj)[0] || "";
  }

  // Turns a raw MangaDex manga object into the plain shape the rest of the
  // extension uses (id, title, type, cover, description) — computed once,
  // right here, using MangaDex's documented (stable) response fields.
  function normalizeSeries(m) {
    const attrs = m.attributes || {};
    const relationships = m.relationships || [];
    const coverRel = relationships.find((r) => r.type === "cover_art");
    const fileName = coverRel && coverRel.attributes && coverRel.attributes.fileName;
    const cover = fileName ? `${COVER_BASE}${m.id}/${fileName}.256.jpg` : "";

    const tagNames = (attrs.tags || [])
      .map((t) => t.attributes && t.attributes.name && pickLocalized(t.attributes.name))
      .filter(Boolean);
    const formatTag = tagNames.find((n) => FORMAT_TAGS.includes(n));
    const type = formatTag || (attrs.originalLanguage === "en" ? "OEL" : (attrs.originalLanguage || "Manga"));

    return {
      id: m.id,
      title: pickLocalized(attrs.title) || (attrs.altTitles && attrs.altTitles.length && pickLocalized(attrs.altTitles[0])) || "Untitled",
      type,
      cover,
      description: pickLocalized(attrs.description),
    };
  }

  // OEL/manhwa/manhua-ish: has a matching format tag, or its original
  // language is English (true OEL — written in English from the start).
  function isOelLike(m) {
    const attrs = m.attributes || {};
    const tagNames = (attrs.tags || [])
      .map((t) => t.attributes && t.attributes.name && pickLocalized(t.attributes.name))
      .filter(Boolean);
    return tagNames.some((n) => FORMAT_TAGS.includes(n)) || attrs.originalLanguage === "en";
  }

  function searchSeries(query) {
    return apiGet("manga", {
      title: query,
      limit: 20,
      "includes[]": ["cover_art"],
      "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
    }).then((res) => {
      const data = (res && res.data) || [];
      if (!data.length) return [];
      const filtered = data.filter(isOelLike);
      return (filtered.length ? filtered : data).map(normalizeSeries);
    });
  }

  /* ------------------------------------------------------------------ *
   *  Small utilities
   * ------------------------------------------------------------------ */
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function slugify(str) {
    return (String(str || "untitled").trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")) || "untitled";
  }

  // normalizeSeries() already resolved the real cover URL (or "") up front,
  // using MangaDex's documented cover_art relationship — nothing to guess here.
  // When it comes back empty, kick off a background lookup so the poster can
  // still be filled in from another source the moment it's ready.
  function coverUrl(series) {
    const url = (series && series.cover) || "";
    if (!url && series) resolveFallbackCover(series);
    return url;
  }

  /* ------------------------------------------------------------------ *
   *  Cover fallback — when MangaDex has no cover, grab a poster from
   *  Comick, then MangaBaka. Matches by title similarity and caches the
   *  resolved URL into the series object (persisted for library items).
   * ------------------------------------------------------------------ */
  const MANGABAKA_API = "https://api.mangabaka.dev/v1";
  const coverLookupPending = new Set();
  const coverLookupDone = new Set();

  function apiGetUrl(url, headers) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "OEL_FETCH", url, headers }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Extension messaging error: ${chrome.runtime.lastError.message}`));
          return;
        }
        if (!res || !res.ok) {
          reject(new Error((res && res.error) || `Network error. URL: ${url}`));
          return;
        }
        let json;
        try {
          json = JSON.parse(res.text);
        } catch (e) {
          reject(new Error(`Non-JSON response (HTTP ${res.status}). URL: ${url}`));
          return;
        }
        resolve(json);
      });
    });
  }

  // Downloads an image through the extension worker (extension context sends
  // no page referrer, so it sidesteps any hotlink/CORS blocking) and returns
  // it as a data URL for embedding straight into the feed entry.
  function imageAsDataUrl(url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "OEL_FETCH", url, binary: true }, (res) => {
        if (!res || !res.ok || !res.b64) {
          resolve("");
          return;
        }
        resolve(`data:${res.mime || "image/jpeg"};base64,${res.b64}`);
      });
    });
  }

  function normTitle(str) {
    return String(str || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function titleScore(a, b) {
    const A = normTitle(a);
    const B = normTitle(b);
    if (!A || !B) return 0;
    if (A === B) return 1;
    if (A.includes(B) || B.includes(A)) return 0.85;
    let hits = 0;
    for (const ch of B) if (A.includes(ch)) hits++;
    return (hits / Math.max(B.length, 1)) * 0.6;
  }

  // Most reliable recovery: the stored MangaDex id is exact, so ask MangaDex
  // itself for the cover_art relationship — no title matching needed. This
  // also repairs library entries saved by older versions that had no cover.
  async function fallbackCoverFromMangadex(series) {
    const json = await apiGet("manga/" + series.id, { "includes[]": ["cover_art"] });
    const rel = json && json.data && json.data.relationships;
    const coverRel = rel && rel.find((r) => r.type === "cover_art");
    const fileName = coverRel && coverRel.attributes && coverRel.attributes.fileName;
    return fileName ? `${COVER_BASE}${series.id}/${fileName}.256.jpg` : "";
  }

  const COMICK_HEADERS = {
    "Referer": "https://comick.io/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  async function fallbackCoverFromComick(title) {
    for (const host of ["https://api.comick.io", "https://api.comick.fun"]) {
      try {
        const json = await apiGetUrl(`${host}/v1.0/search?q=${encodeURIComponent(title)}&limit=15`, COMICK_HEADERS);
        if (!Array.isArray(json)) continue;
        let best = null;
        let bestScore = 0;
        for (const item of json) {
          const t = (item && (item.title || item.slug)) || "";
          const s = titleScore(title, t);
          if (s > bestScore) {
            bestScore = s;
            best = item;
          }
        }
        if (!best || bestScore < 0.4) continue;
        const b2 = best.md_covers && best.md_covers[0] && best.md_covers[0].b2key;
        if (b2) return `https://meo.comick.pictures${String(b2).startsWith("/") ? b2 : "/" + b2}`;
      } catch (e) {
        // try the next host
      }
    }
    return "";
  }

  async function fallbackCoverFromMangabaka(title) {
    const json = await apiGetUrl(`${MANGABAKA_API}/series/search?q=${encodeURIComponent(title)}&limit=15`);
    const data = json && Array.isArray(json.data) ? json.data : [];
    let best = null;
    let bestScore = 0;
    for (const item of data) {
      const t = (item && item.title) || "";
      const s = titleScore(title, t);
      if (s > bestScore) {
        bestScore = s;
        best = item;
      }
    }
    if (!best || bestScore < 0.4) return "";
    return (best.cover && best.cover.x250 && best.cover.x250.x1) || "";
  }

  async function resolveFallbackCover(series) {
    if (!series) return;
    const key = String(series.id);
    if (coverLookupPending.has(key) || coverLookupDone.has(key)) return;
    coverLookupPending.add(key);
    try {
      let url = await fallbackCoverFromMangadex(series);
      if (!url) url = await fallbackCoverFromComick(series.title || "");
      if (!url) url = await fallbackCoverFromMangabaka(series.title || "");
      if (url) {
        series.cover = url;
        console.log(`[OEL Companion] resolved cover for "${series.title}": ${url}`);
        if (findInLibrary(series.id)) saveLibrary(library);
        renderResults([...lastResultsMap.values()]);
        renderMyList();
        scheduleInjectIntoFeed();
      }
    } catch (e) {
      // offline or rate-limited — a later render can try again
    } finally {
      coverLookupPending.delete(key);
      coverLookupDone.add(key);
    }
  }

  // Neutral grey placeholder — used whenever coverUrl() comes back empty, so
  // a missing cover never keeps showing whatever image was there before
  // (e.g. a cloned real entry's own cover).
  const PLACEHOLDER_COVER =
    'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="44">' +
      '<rect width="32" height="44" fill="#3a4152"/>' +
      '<text x="16" y="26" font-size="18" text-anchor="middle" fill="#8b98ab" font-family="sans-serif">?</text>' +
      '</svg>'
    );

  function timeAgo(ts) {
    if (!ts) return "";
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    const units = [
      ["year", 31536000], ["month", 2592000], ["day", 86400],
      ["hour", 3600], ["minute", 60], ["second", 1],
    ];
    for (const [name, secs] of units) {
      const val = Math.floor(s / secs);
      if (val >= 1) return `${val} ${name}${val > 1 ? "s" : ""} ago`;
    }
    return "just now";
  }

  /* ------------------------------------------------------------------ *
   *  Styles — scoped under #oel-inline-card so nothing leaks into AniList
   * ------------------------------------------------------------------ */
  const style = document.createElement("style");
  style.textContent = `
    #oel-inline-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 16px;
      font-family: inherit;
      color: inherit;
    }
    #oel-inline-card .oel-header {
      display: flex; align-items: center; justify-content: space-between;
      cursor: pointer; user-select: none;
    }
    #oel-inline-card .oel-title { font-weight: 700; font-size: 15px; opacity: 0.9; }
    #oel-inline-card .oel-count { font-size: 12px; opacity: 0.55; margin-left: 6px; }
    #oel-inline-card .oel-toggle { font-size: 12px; opacity: 0.6; }
    #oel-inline-card .oel-body { margin-top: 12px; }
    #oel-inline-card .oel-body.oel-collapsed { display: none; }
    #oel-inline-card .oel-search-row { display: flex; gap: 8px; margin-bottom: 10px; }
    #oel-inline-card input[type="text"], #oel-inline-card input[type="number"] {
      background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px; color: inherit; padding: 6px 8px; font-size: 13px;
    }
    #oel-inline-card .oel-search-row input[type="text"] { flex: 1; }
    #oel-inline-card button.oel-btn {
      background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
      border-radius: 6px; color: inherit; padding: 6px 10px; font-size: 12px; cursor: pointer;
    }
    #oel-inline-card button.oel-btn:hover { background: rgba(255,255,255,0.16); }
    #oel-inline-card button.oel-btn.add { border-color: #3db4f2; color: #3db4f2; }
    #oel-inline-card button.oel-btn.remove { border-color: #ff5c68; color: #ff5c68; }
    #oel-inline-card button.oel-btn.save { border-color: #4cd964; color: #4cd964; }
    #oel-inline-card .oel-empty { font-size: 12px; opacity: 0.5; padding: 6px 0; }
    #oel-inline-card .oel-section-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: 0.45; margin: 10px 0 6px; }
    #oel-inline-card .oel-row {
      display: flex; align-items: center; gap: 10px; padding: 6px 0;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    #oel-inline-card .oel-row:first-of-type { border-top: none; }
    #oel-inline-card .oel-row img { width: 32px; height: 44px; object-fit: cover; border-radius: 3px; flex-shrink: 0; background: rgba(255,255,255,0.08); }
    #oel-inline-card .oel-row .oel-info { flex: 1; min-width: 0; }
    #oel-inline-card .oel-row .oel-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #oel-inline-card .oel-row .oel-sub { font-size: 11px; opacity: 0.55; }
    #oel-inline-card .oel-badge { font-size: 10px; padding: 2px 6px; border-radius: 999px; font-weight: 600; }
    #oel-inline-card .oel-actions { display: flex; gap: 6px; flex-shrink: 0; }
    #oel-inline-card select {
      background-color: #2b3242; border: 1px solid rgba(255,255,255,0.14);
      border-radius: 6px; color: #e6e9f0; padding: 5px 6px; font-size: 12px;
    }
    #oel-inline-card select option {
      background-color: #2b3242; color: #e6e9f0;
    }
    #oel-inline-card .oel-edit-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    #oel-inline-card .oel-stepper { display: flex; align-items: center; gap: 4px; }
    #oel-inline-card .oel-stepper input[type="number"] {
      width: 50px; text-align: center;
      background: rgba(0,0,0,0.35); color: inherit;
      -moz-appearance: textfield; appearance: textfield;
    }
    #oel-inline-card .oel-stepper input[type="number"]::-webkit-inner-spin-button,
    #oel-inline-card .oel-stepper input[type="number"]::-webkit-outer-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    #oel-inline-card .oel-backup-row { border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 8px; }
    #oel-inline-card .oel-bak-status { font-size: 11px; opacity: 0.7; margin-left: 4px; }
    [data-oel-fake] { }
  `;
  document.documentElement.appendChild(style);

  /* ------------------------------------------------------------------ *
   *  Card DOM
   * ------------------------------------------------------------------ */
  const card = document.createElement("div");
  card.id = "oel-inline-card";
  card.innerHTML = `
    <div class="oel-header" data-action="toggle-card">
      <span class="oel-title">OEL Library <span class="oel-count">(0)</span></span>
      <span class="oel-toggle">▸</span>
    </div>
    <div class="oel-body oel-collapsed">
      <div class="oel-search-row">
        <input type="text" id="oel-search-input" placeholder="Search OEL / manhwa / manhua on MangaDex…" />
        <button class="oel-btn" id="oel-search-btn">Search</button>
      </div>
      <div class="oel-search-row oel-backup-row">
        <button class="oel-btn" id="oel-export-btn" title="Download your library as a JSON file">Export</button>
        <button class="oel-btn" id="oel-import-btn" title="Load a library from a JSON file">Import</button>
        <button class="oel-btn" id="oel-backup-btn" title="Save every change to a folder on this PC">Auto-backup</button>
        <input type="file" id="oel-import-file" accept=".json,application/json" style="display:none" />
        <span class="oel-bak-status" id="oel-bak-status"></span>
      </div>
      <div id="oel-results"></div>
      <div class="oel-section-label">My titles</div>
      <div id="oel-mylist"></div>
    </div>
  `;

  const body = card.querySelector(".oel-body");
  const countEl = card.querySelector(".oel-count");
  const resultsEl = card.querySelector("#oel-results");
  const myListEl = card.querySelector("#oel-mylist");
  const searchInput = card.querySelector("#oel-search-input");
  const searchBtn = card.querySelector("#oel-search-btn");

  card.querySelector('[data-action="toggle-card"]').addEventListener("click", () => {
    body.classList.toggle("oel-collapsed");
    card.querySelector(".oel-toggle").textContent = body.classList.contains("oel-collapsed") ? "▸" : "▾";
  });

  let lastResultsMap = new Map();
  let editingId = null;

  function renderResults(results) {
    if (!results.length) {
      resultsEl.innerHTML = `<div class="oel-empty">No OEL/manhwa/manhua results.</div>`;
      return;
    }
    const rowsHtml = results.slice(0, 8).map((s) => {
      const already = !!findInLibrary(s.id);
      const img = coverUrl(s);
      return `
        <div class="oel-row">
          <img src="${escapeHtml(img || PLACEHOLDER_COVER)}" alt="" />
          <div class="oel-info">
            <div class="oel-name">${escapeHtml(s.title || "Untitled")}</div>
            <div class="oel-sub">${escapeHtml((s.type || "").toUpperCase())}</div>
          </div>
          <div class="oel-actions">
            ${already
              ? `<button class="oel-btn remove" data-action="remove" data-id="${s.id}">Remove</button>`
              : `<button class="oel-btn add" data-action="add" data-id="${s.id}">Add</button>`}
          </div>
        </div>
      `;
    }).join("");
    resultsEl.innerHTML = rowsHtml;
  }
  function renderMyList() {
    countEl.textContent = `(${library.length})`;
    if (!library.length) {
      myListEl.innerHTML = `<div class="oel-empty">Nothing added yet — search above to add a title.</div>`;
      return;
    }
    const sorted = [...library].sort((a, b) => (ensureTrack(b).updatedAt || 0) - (ensureTrack(a).updatedAt || 0));
    myListEl.innerHTML = sorted.map((s) => {
      const track = ensureTrack(s);
      const meta = STATUS_META[track.status] || STATUS_META.planning;
      const img = coverUrl(s);
      if (editingId !== null && String(editingId) === String(s.id)) {
        return `
          <div class="oel-row" data-id="${s.id}">
            <img src="${escapeHtml(img || PLACEHOLDER_COVER)}" alt="" />
            <div class="oel-info">
              <div class="oel-name">${escapeHtml(s.title || "Untitled")}</div>
              <div class="oel-edit-row">
                <select data-action="status">
                  ${STATUS_ORDER.map((k) => `<option value="${k}" ${k === track.status ? "selected" : ""}>${STATUS_META[k].label}</option>`).join("")}
                </select>
                <div class="oel-stepper">
                  <button class="oel-btn" data-action="dec" data-id="${s.id}">−</button>
                  <input type="number" data-field="to" value="${track.chapterTo || 0}" min="0" />
                  <button class="oel-btn" data-action="inc" data-id="${s.id}">+</button>
                </div>
                <button class="oel-btn save" data-action="save" data-id="${s.id}">Save</button>
                <button class="oel-btn" data-action="cancel" data-id="${s.id}">Cancel</button>
              </div>
            </div>
          </div>
        `;
      }
      return `
        <div class="oel-row" data-id="${s.id}">
          <img src="${escapeHtml(img || PLACEHOLDER_COVER)}" alt="" />
          <div class="oel-info">
            <div class="oel-name">${escapeHtml(s.title || "Untitled")}</div>
            <div class="oel-sub">
              <span class="oel-badge" style="background:${meta.color}22;color:${meta.color}">${meta.label}</span>
              &nbsp;ch. ${track.chapterTo || 0}
            </div>
          </div>
          <div class="oel-actions">
            <button class="oel-btn" data-action="edit" data-id="${s.id}">Edit</button>
            <button class="oel-btn remove" data-action="remove" data-id="${s.id}">Remove</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function doSearch() {
    const q = searchInput.value.trim();
    if (!q) return;
    resultsEl.innerHTML = `<div class="oel-empty">Searching…</div>`;
    searchSeries(q)
      .then((results) => {
        lastResultsMap = new Map(results.map((s) => [String(s.id), s]));
        renderResults(results);
      })
      .catch((err) => {
        console.error("[OEL Companion]", err);
        resultsEl.innerHTML = `<div class="oel-empty">Search failed: ${escapeHtml(err.message || String(err))}<br>Open the browser console (F12) for details.</div>`;
      });
  }

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  card.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const row = btn.closest(".oel-row");

    if (action === "add") {
      const series = lastResultsMap.get(id);
      if (!series || findInLibrary(id)) return;
      series._track = defaultTrack();
      library.push(series);
      saveLibrary(library);
      renderResults([...lastResultsMap.values()]);
      renderMyList();
      return;
    }

    if (action === "remove") {
      library = library.filter((s) => String(s.id) !== String(id));
      saveLibrary(library, { skipBackup: true });
      renderResults([...lastResultsMap.values()]);
      renderMyList();
      return;
    }

    if (action === "edit") {
      editingId = id;
      renderMyList();
      return;
    }

    if (action === "cancel") {
      editingId = null;
      renderMyList();
      return;
    }

    if (action === "inc" || action === "dec") {
      const input = row && row.querySelector('input[data-field="to"]');
      if (input) {
        const next = Math.max(0, (parseInt(input.value, 10) || 0) + (action === "inc" ? 1 : -1));
        input.value = next;
      }
      return;
    }

    if (action === "save") {
      const series = findInLibrary(id);
      if (!series || !row) return;
      const track = ensureTrack(series);
      const select = row.querySelector('select[data-action="status"]');
      const toInput = row.querySelector('input[data-field="to"]');

      const isFirstEver = track.chapterFrom === null && track.chapterTo === 0;
      const newTo = Math.max(0, parseInt(toInput && toInput.value, 10) || 0);

      track.status = select ? select.value : track.status;
      if (newTo === 0) {
        track.chapterFrom = null;
      } else if (isFirstEver) {
        track.chapterFrom = 1;
      } else {
        track.chapterFrom = track.chapterTo;
      }
      track.chapterTo = newTo;
      track.updatedAt = Date.now();

      saveLibrary(library);
      editingId = null;
      renderMyList();
      return;
    }
  });

  renderMyList();

  /* ------------------------------------------------------------------ *
   *  Backup UI — export / import / auto-backup wiring.
   * ------------------------------------------------------------------ */
  const exportBtn = card.querySelector("#oel-export-btn");
  const importBtn = card.querySelector("#oel-import-btn");
  const importFile = card.querySelector("#oel-import-file");
  const backupBtn = card.querySelector("#oel-backup-btn");
  const bakStatus = card.querySelector("#oel-bak-status");

  let bakStatusTimer = null;
  function setBakStatus(msg) {
    bakStatus.textContent = msg;
    clearTimeout(bakStatusTimer);
    bakStatusTimer = setTimeout(() => { bakStatus.textContent = ""; }, 4000);
  }

  exportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(library, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "oel-companion-library.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setBakStatus(`Exported ${library.length} titles`);
  });

  importBtn.addEventListener("click", () => importFile.click());

  importFile.addEventListener("change", () => {
    const file = importFile.files && importFile.files[0];
    importFile.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const incoming = JSON.parse(reader.result);
        if (!Array.isArray(incoming)) throw new Error("not an array of entries");
        const byId = new Map(library.map((s) => [String(s.id), s]));
        let added = 0;
        let updated = 0;
        incoming.forEach((item) => {
          if (!item || item.id === undefined || item.title === undefined) return;
          const key = String(item.id);
          const existing = byId.get(key);
          const inTs = (item._track && item._track.updatedAt) || 0;
          const exTs = existing && existing._track ? existing._track.updatedAt : 0;
          if (!existing) {
            byId.set(key, item);
            added++;
          } else if (inTs >= exTs) {
            byId.set(key, item);
            updated++;
          }
        });
        const merged = Array.from(byId.values());
        merged.forEach((s) => ensureTrack(s));
        library.length = 0;
        library.push(...merged);
        saveLibrary(library);
        renderMyList();
        setBakStatus(`Imported: ${added} added, ${updated} updated`);
      } catch (e) {
        setBakStatus("Import failed: invalid file");
      }
    };
    reader.readAsText(file);
  });

  (async function initBackup() {
    const dir = await bakGetDir();
    if (!dir) return;
    const ok = await bakEnsure(dir);
    if (ok) {
      backupDir = ok;
      backupBtn.textContent = "Auto-backup on";
      setBakStatus(`Auto-backup → ${dir.name}`);
    } else {
      backupBtn.textContent = "Auto-backup (grant)";
    }
  })();

  backupBtn.addEventListener("click", async () => {
    try {
      let dir = backupDir || await bakGetDir();
      if (!dir) dir = await bakRequestFolder(); // first time: pick a folder
      else dir = await bakEnsure(dir);          // later: just re-grant the same folder
      if (!dir) throw new Error("not granted");
      backupDir = dir;
      await bakPutDir(dir);
      backupBtn.textContent = "Auto-backup on";
      writeAutoBackup(library);
      setBakStatus(`Auto-backup → ${dir.name}`);
    } catch (e) {
      setBakStatus("Auto-backup not enabled");
    }
  });

  /* ------------------------------------------------------------------ *
   *  Locate AniList's real Activity feed and place the card above it,
   *  using text-pattern heuristics (not hardcoded class names, since we
   *  can't see AniList's actual DOM/CSS from here).
   * ------------------------------------------------------------------ */
  const ACTIVITY_PATTERN = /^(Read chapter|Read volume|Watched episode|Plans to (watch|read)|Completed|Rated|Dropped|Paused)\b/;
  const FAKE_MARK = "data-oel-fake";

  function isInOwnCard(el) {
    return el.id === "oel-inline-card" || (el.closest && el.closest("#oel-inline-card"));
  }

  function findTextLeafMatching(root, pattern) {
    const all = root.querySelectorAll("*");
    for (const el of all) {
      if (el.hasAttribute && el.hasAttribute(FAKE_MARK)) continue;
      if (isInOwnCard(el)) continue;
      if (el.children.length <= 2 && pattern.test((el.textContent || "").trim())) return el;
    }
    return null;
  }

  function findTimeLeaf(root) {
    const all = root.querySelectorAll("*");
    for (const el of all) {
      if (el.children.length === 0 && /\bago$/i.test((el.textContent || "").trim())) return el;
    }
    return null;
  }

  // All distinct text leaves that look like a real activity line ("Read
  // chapter…", "Plans to watch…", etc), anywhere on the page.
  function collectActivityLines() {
    const all = document.body.querySelectorAll("*");
    const matches = [];
    for (const el of all) {
      if (el.hasAttribute && el.hasAttribute(FAKE_MARK)) continue;
      if (isInOwnCard(el)) continue;
      if (el.children.length <= 2 && ACTIVITY_PATTERN.test((el.textContent || "").trim())) matches.push(el);
    }
    return matches;
  }

  function commonAncestor(a, b) {
    const ancestors = new Set();
    for (let n = a; n; n = n.parentElement) ancestors.add(n);
    for (let n = b; n; n = n.parentElement) if (ancestors.has(n)) return n;
    return null;
  }

  // Walk up from `node` until we hit the element that is a *direct* child
  // of `ancestor` — i.e. the full single-entry container, not just the
  // inner text line.
  function directChildOf(node, ancestor) {
    let n = node;
    while (n && n.parentElement !== ancestor) n = n.parentElement;
    return n;
  }

  // Finds the real Activity feed by requiring at least two separate real
  // entries that share a common container — a single matched line isn't
  // enough proof, since it can sit inside nested wrappers that aren't the
  // actual list (that's what caused the card to get welded inside one
  // entry's narrow text column instead of sitting above the whole feed).
  function findFeed() {
    const matches = collectActivityLines();

    if (matches.length >= 2) {
      for (let i = 1; i < matches.length; i++) {
        const list = commonAncestor(matches[0], matches[i]);
        if (!list || list === document.body) continue;
        const entryA = directChildOf(matches[0], list);
        const entryB = directChildOf(matches[i], list);
        if (entryA && entryB && entryA !== entryB && list.children.length >= 2) {
          return { list, sample: entryA };
        }
      }
    }

    if (matches.length === 1) {
      // Fallback when only one real entry is currently in the DOM: walk up
      // until we find a container that has other sibling content too
      // (better than nothing, but less reliable than the two-entry case).
      let item = matches[0];
      for (let i = 0; i < 8 && item && item.parentElement; i++) {
        const parent = item.parentElement;
        if (parent.children.length >= 2 && parent !== document.body) {
          return { list: parent, sample: item };
        }
        item = parent;
      }
    }

    return null;
  }

  function placeCard(list) {
    if (card.isConnected && card.nextElementSibling === list) return;
    if (list && list.parentElement) {
      list.parentElement.insertBefore(card, list);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Cloned feed entries — only for titles with 1+ chapter logged
   * ------------------------------------------------------------------ */

  // Whichever element is visually the biggest PORTRAIT image in a real,
  // already rendered entry is the cover thumbnail — whether it's a plain
  // <img> or a div carrying a CSS background-image. Preferring portrait over
  // the plain "biggest" avoids landing on the square user avatar that can
  // appear earlier in the entry's DOM.
  function findLargestImage(root) {
    const candidates = [];
    for (const el of root.querySelectorAll("img")) candidates.push(el);
    for (const el of root.querySelectorAll("*")) {
      if (el instanceof HTMLImageElement) continue;
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== "none") candidates.push(el);
    }
    let bestPortrait = null;
    let bestPortraitArea = 0;
    let bestAny = null;
    let bestAnyArea = 0;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const w = r.width;
      const h = r.height;
      const area = w * h;
      if (area > bestAnyArea) {
        bestAnyArea = area;
        bestAny = el;
      }
      if (area > 0 && h > w * 1.05 && area > bestPortraitArea) {
        bestPortraitArea = area;
        bestPortrait = el;
      }
    }
    return bestPortrait || bestAny;
  }

  // Maps an element to an index path from a root, then back again — so we
  // can locate the *same* element inside the freshly cloned node, where
  // matching by content won't work yet.
  function getIndexPath(el, root) {
    const path = [];
    for (let n = el; n && n !== root; n = n.parentElement) {
      if (!n.parentElement) return null;
      path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
    }
    return path;
  }

  function elementAtPath(root, path) {
    let n = root;
    for (const idx of path || []) {
      if (!n || !n.children || idx < 0 || idx >= n.children.length) return null;
      n = n.children[idx];
    }
    return n;
  }

  function buildFakeEntry(sample, series, track) {
    const clone = sample.cloneNode(true);
    clone.setAttribute(FAKE_MARK, "1");
    clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));

    // The clone isn't attached yet, so it has no rendered layout — measure
    // the real entry instead, then map the found cover over to the clone.
    const coverSource = findLargestImage(sample);
    const cloneCover = coverSource ? elementAtPath(clone, getIndexPath(coverSource, sample)) : null;
    let coverAnchor = null;
    // Replace the cover element with a fresh <img> we fully control — exact
    // src, explicit size (copied from the measured real cover), no lazy-load
    // hooks. Setting src on the unknown original element was too fragile.
    if (cloneCover) {
      const rect = coverSource.getBoundingClientRect();
      const poster = document.createElement("img");
      poster.alt = "";
      poster.src = coverUrl(series) || PLACEHOLDER_COVER;
      poster.loading = "eager";
      poster.setAttribute("data-oel-poster", String(series.id));
      // Keep the original element's classes so AniList's own cover CSS
      // (sizing, position, radius) still applies to the replacement.
      const origClass = cloneCover.getAttribute("class");
      if (origClass) poster.className = origClass;
      poster.style.width = (rect.width || 40) + "px";
      poster.style.height = (rect.height || 60) + "px";
      poster.style.objectFit = "cover";
      poster.onerror = () => {
        if (poster.src && poster.src.indexOf("data:image") === 0) return;
        // Direct load failed — grab the bytes via the extension worker (no
        // referrer) and embed as a data URL; if even that fails, show the
        // placeholder and ask the resolver to try another source.
        imageAsDataUrl(coverUrl(series) || series.cover || "").then((dataUrl) => {
          if (dataUrl) {
            poster.src = dataUrl;
          } else {
            poster.src = PLACEHOLDER_COVER;
            resolveFallbackCover(series);
          }
        });
      };
      cloneCover.replaceWith(poster);
      coverAnchor = poster.closest("a");
    } else {
      const img = clone.querySelector("img");
      if (img) {
        img.src = coverUrl(series) || PLACEHOLDER_COVER;
        img.removeAttribute("srcset");
        img.setAttribute("loading", "eager");
        coverAnchor = img.closest("a");
      }
    }
    // The cloned entry is copied from a *real* AniList post, so its poster is
    // still wrapped in that post's own link (e.g. Tower of God). Neutralize it
    // so clicking the poster opens this entry for editing instead of steering
    // the user to another work.
    if (coverAnchor) {
      coverAnchor.setAttribute("data-oel-cover", "1");
      coverAnchor.removeAttribute("href");
    }

    const lineEl = findTextLeafMatching(clone, ACTIVITY_PATTERN);
    if (lineEl) {
      const existingAnchor = lineEl.querySelector("a");
      const anchorClass = existingAnchor ? existingAnchor.getAttribute("class") || "" : "";
      const readRange =
        track.chapterFrom && track.chapterFrom !== track.chapterTo
          ? `${track.chapterFrom} - ${track.chapterTo}`
          : `${track.chapterTo || "?"}`;
      lineEl.innerHTML = `Read chapter ${escapeHtml(readRange)} of <a class="${anchorClass}" data-oel-id="${series.id}" href="#" style="color:#3db4f2">${escapeHtml(series.title || "Untitled")}</a>`;
    }

    const timeEl = findTimeLeaf(clone);
    if (timeEl) timeEl.textContent = timeAgo(track.updatedAt) || "just now";

    // Clicking the injected title OR the poster scrolls to & opens the entry
    // for editing in the inline card, instead of navigating anywhere.
    clone.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-oel-id], a[data-oel-cover]");
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      editingId = series.id;
      body.classList.remove("oel-collapsed");
      card.querySelector(".oel-toggle").textContent = "▾";
      renderMyList();
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    return clone;
  }

  function injectIntoFeed() {
    const found = findFeed();
    if (!found) return;
    const { list, sample } = found;

    placeCard(list);

    list.querySelectorAll(`[${FAKE_MARK}]`).forEach((el) => el.remove());

    const entries = library
      .filter((s) => ensureTrack(s).chapterTo > 0) // only titles with 1+ chapter logged
      .sort((a, b) => (ensureTrack(b).updatedAt || 0) - (ensureTrack(a).updatedAt || 0))
      .slice(0, 5);

    entries.forEach((series) => {
      const fake = buildFakeEntry(sample, series, ensureTrack(series));
      list.insertBefore(fake, list.firstChild);
    });
  }

  let feedInjectTimer = null;
  function scheduleInjectIntoFeed() {
    clearTimeout(feedInjectTimer);
    feedInjectTimer = setTimeout(injectIntoFeed, 400);
  }

  function isForeignMutation(mutations) {
    return mutations.some((m) => {
      const nodes = [...m.addedNodes, ...m.removedNodes];
      return nodes.some((n) => {
        if (n.nodeType !== 1) return true;
        if (n.hasAttribute && n.hasAttribute(FAKE_MARK)) return false;
        if (n.id === "oel-inline-card") return false;
        return true;
      });
    });
  }

  new MutationObserver((mutations) => {
    if (isForeignMutation(mutations)) scheduleInjectIntoFeed();
  }).observe(document.body, { childList: true, subtree: true });

  scheduleInjectIntoFeed();
})();
