// AMS WatchLater — the engine.
//
// Runs on the Mac only. Nothing leaves the machine except the metadata
// lookups to YouTube, and those happen HERE rather than in the browser:
// the watch page carries the duration but sends no CORS header, so a page
// script can never read it. Node has no such limit, which is the whole
// reason this app has a server instead of being a plain PWA.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const APP_DIR = __dirname;
const PORT = 7821;
const STORE = path.join(APP_DIR, "watchlater.json");
const BACKUPS = path.join(APP_DIR, "backups");
const THUMBS = path.join(APP_DIR, "thumbs");
const APP_VERSION = "1.7";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";

for (const dir of [BACKUPS, THUMBS]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ---------- store ---------- */

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE, "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.items)) throw new Error("shape");
    return data;
  } catch (e) {
    return { version: APP_VERSION, items: [] };
  }
}

// Today's backup keeps the FULLEST snapshot it has seen today, and older
// dated files are never rewritten. A blind "save whatever is in memory"
// backup is how an empty snapshot once ate a real catalogue — so a thinner
// copy is refused here even though the live store below is free to shrink
// (deleting a video is a legitimate shrink; an empty backup never is).
function writeBackup(data) {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const file = path.join(BACKUPS, `watchlater-${stamp}.json`);
    if (fs.existsSync(file)) {
      try {
        const existing = JSON.parse(fs.readFileSync(file, "utf8"));
        const had = Array.isArray(existing.items) ? existing.items.length : 0;
        if (data.items.length < had) return; // refuse to thin out a good copy
      } catch (e) {
        /* unreadable backup — replacing it is an improvement */
      }
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2));

    const kept = fs
      .readdirSync(BACKUPS)
      .filter((f) => /^watchlater-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - 14))) {
      fs.unlinkSync(path.join(BACKUPS, old));
    }
  } catch (e) {
    console.error("backup failed:", e.message);
  }
}

// A copy he asks for by hand gets its own timestamped name and never touches
// the daily one, so pressing the button can only ever ADD a safety net — it can
// never overwrite a good copy with a worse one. See the daily rule above.
function manualBackup(data, why) {
  const now = new Date().toISOString();
  const base = `watchlater-${now.slice(0, 10)}-${now.slice(11, 19).replace(/:/g, "")}${
    why ? "-" + why : ""
  }`;
  let file = base + ".json";
  let n = 1;
  while (fs.existsSync(path.join(BACKUPS, file))) file = `${base}-${++n}.json`;
  fs.writeFileSync(path.join(BACKUPS, file), JSON.stringify(data, null, 2));

  const mine = fs
    .readdirSync(BACKUPS)
    .filter((f) => /^watchlater-\d{4}-\d{2}-\d{2}-\d{6}(-[a-z]+)?(-\d+)?\.json$/.test(f))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - 10))) {
    fs.unlinkSync(path.join(BACKUPS, old));
  }
  return { file, count: data.items.length };
}

const BACKUP_NAME = /^watchlater-\d{4}-\d{2}-\d{2}(-\d{6})?(-[a-z]+)?(-\d+)?\.json$/;

function listBackups() {
  const out = [];
  for (const f of fs.readdirSync(BACKUPS)) {
    if (!BACKUP_NAME.test(f)) continue;
    try {
      const st = fs.statSync(path.join(BACKUPS, f));
      const d = JSON.parse(fs.readFileSync(path.join(BACKUPS, f), "utf8"));
      if (!Array.isArray(d.items)) continue;
      out.push({
        file: f,
        count: d.items.filter((it) => !it.deletedAt).length,
        bytes: st.size,
        at: st.mtime.toISOString(),
        manual: /-\d{6}(-[a-z]+)?(-\d+)?\.json$/.test(f),
      });
    } catch (e) {
      /* an unreadable file is simply not offered */
    }
  }
  return out.sort((a, b) => b.file.localeCompare(a.file));
}

// Write to a temp file and rename, so a crash mid-write cannot leave a
// half-written store behind.
function saveStore(data) {
  data.version = APP_VERSION;
  writeBackup(data);
  const tmp = STORE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE);
}

// The bin is undoable for a few seconds, so removing a video first only marks
// it. Nothing is really dropped until the window has passed, which means even
// closing the page mid-undo cannot lose one. Marked items are invisible to the
// list; a later write sweeps up the ones whose window has expired.
const TOMBSTONE_MS = 10 * 60 * 1000;

function liveItems(store) {
  return store.items.filter((it) => !it.deletedAt);
}

function purgeDeleted(store) {
  const cutoff = Date.now() - TOMBSTONE_MS;
  const before = store.items.length;
  store.items = store.items.filter(
    (it) => !it.deletedAt || new Date(it.deletedAt).getTime() > cutoff
  );
  return store.items.length !== before;
}

/* ---------- YouTube ---------- */

function videoId(url) {
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error("too many redirects"));
    const req = https.get(
      url,
      { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, url).href, redirects + 1).then(
            resolve,
            reject
          );
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error("HTTP " + res.statusCode));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("error", reject);
    req.setTimeout(12000, () => req.destroy(new Error("timeout")));
  });
}

// ISO-8601 durations, for the rare page that only exposes the meta tag.
function isoToSeconds(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return null;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

async function youtubeMeta(id, hint) {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const meta = { videoId: id, url: watch, seconds: null, title: null, channel: null };

  // oEmbed is the reliable source for title, channel and thumbnail.
  try {
    const body = await get(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`
    );
    const j = JSON.parse(body.toString("utf8"));
    meta.title = j.title || null;
    meta.channel = j.author_name || null;
  } catch (e) {
    /* fall through to the page scrape below */
  }

  // A length already read off a playlist page makes the watch page — by far the
  // heaviest fetch here — unnecessary.
  if (hint && hint.seconds != null) {
    meta.seconds = hint.seconds;
    if (meta.title) return meta;
  }

  // The watch page is the only keyless source of the duration.
  try {
    const html = (await get(watch)).toString("utf8");
    const len = html.match(/"lengthSeconds":"(\d+)"/);
    if (len) meta.seconds = +len[1];
    if (meta.seconds == null) {
      const iso = html.match(/itemprop="duration"\s+content="([^"]+)"/);
      if (iso) meta.seconds = isoToSeconds(iso[1]);
    }
    if (!meta.title) {
      const t = html.match(/<meta\s+name="title"\s+content="([^"]*)"/);
      if (t) meta.title = decodeEntities(t[1]);
    }
    if (!meta.channel) {
      const c = html.match(/"ownerChannelName":"([^"]+)"/);
      if (c) meta.channel = decodeEntities(c[1]);
    }
  } catch (e) {
    /* duration stays null; the card then asks for a rough length */
  }

  // Every lookup failed, so this id is dead, private or mistyped. Returning
  // no title lets the caller refuse it rather than park a blank card on the
  // list that has no picture, no length and no way to tell what it was.
  return meta;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u0026/g, "&")
    .replace(/\\"/g, '"');
}

// Unlike Amazon's image CDN, i.ytimg.com sends access-control-allow-origin: *
// and the files are ~20 KB, so every thumbnail is stored locally and the list
// keeps its pictures with no network at all.
async function cacheThumb(id) {
  const file = path.join(THUMBS, `${id}.jpg`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return true;
  for (const name of ["maxresdefault", "hqdefault", "mqdefault"]) {
    try {
      const buf = await get(`https://i.ytimg.com/vi/${id}/${name}.jpg`);
      if (buf.length > 1000) {
        fs.writeFileSync(file, buf);
        return true;
      }
    } catch (e) {
      /* try the next size down */
    }
  }
  return false;
}

// Anything that is not YouTube still gets saved — just with whatever the
// page's own <title> says and no duration.
async function genericMeta(url) {
  const meta = { videoId: null, url, seconds: null, title: null, channel: null };
  try {
    const html = (await get(url)).toString("utf8");
    const og = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
    const t = og || html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (t) meta.title = decodeEntities(t[1]).trim();
    const site = html.match(/<meta\s+property="og:site_name"\s+content="([^"]*)"/i);
    if (site) meta.channel = decodeEntities(site[1]).trim();
  } catch (e) {
    /* keep the bare URL */
  }
  if (!meta.title) meta.title = url.replace(/^https?:\/\//, "").slice(0, 80);
  if (!meta.channel) {
    try {
      meta.channel = new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      meta.channel = "Link";
    }
  }
  return meta;
}

/* ---------- keeping a card true ---------- */

// Titles get changed, videos get made private, thumbnails get replaced. Asking
// YouTube again either brings the card up to date or marks it as gone — and a
// video that has gone is flagged rather than quietly deleted, because deciding
// that is his.
async function refreshOne(item) {
  if (!item.videoId) return "skipped";
  const meta = await youtubeMeta(item.videoId);
  item.checkedAt = new Date().toISOString();
  if (!meta.title) {
    item.goneAt = item.goneAt || new Date().toISOString();
    return "gone";
  }
  item.goneAt = null;
  item.title = meta.title;
  if (meta.channel) item.channel = meta.channel;
  if (meta.seconds != null) item.seconds = meta.seconds;
  try {
    fs.rmSync(path.join(THUMBS, `${item.videoId}.jpg`), { force: true });
  } catch (e) {
    /* an old picture that will not budge is not worth failing over */
  }
  await cacheThumb(item.videoId);
  return "updated";
}

/* ---------- adding ---------- */

// A playlist link is one link that means fifty. oEmbed knows nothing about
// playlists, but the playlist PAGE lists them, and Node can read it — the same
// reason this app has an engine at all.
const PLAYLIST_MAX = 60;

function playlistId(url) {
  const m = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function clockToSeconds(t) {
  const parts = String(t).split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((n, x) => n * 60 + x, 0);
}

// Each row of the playlist page carries the video's id AND the little duration
// badge, so ONE page read replaces a one-megabyte watch page per video. That is
// the difference between a sixty-video playlist landing in half a minute and in
// six — measured, not guessed.
async function playlistVideos(listId) {
  const html = (
    await get(`https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`)
  ).toString("utf8");

  const out = [];
  const seen = new Set();
  const rows = [
    ...html.matchAll(/"contentId":"([A-Za-z0-9_-]{11})","contentType":"LOCKUP_CONTENT_TYPE_VIDEO"/g),
  ];
  // The badge comes about ten thousand characters BEFORE its own row's id, so a
  // row's length is the LAST one between the previous row and this one. Taking
  // the first badge after the id instead hands every video the next one's
  // length — which was silently true here until the numbers were checked
  // against a known-good run. A row with no badge at all (a live stream, say)
  // simply finds none in its stretch and keeps a null.
  for (let i = 0; i < rows.length && out.length < PLAYLIST_MAX; i++) {
    const id = rows[i][1];
    if (seen.has(id)) continue;
    seen.add(id);
    const from = i > 0 ? rows[i - 1].index : 0;
    const stretch = html.slice(from, rows[i].index);
    const badges = [...stretch.matchAll(/"text":"(\d{1,2}:\d{2}(?::\d{2})?)"/g)];
    const badge = badges.length ? badges[badges.length - 1][1] : null;
    out.push({ id, seconds: badge ? clockToSeconds(badge) : null });
  }

  // A page built some other way: fall back to every video id on it. Lengths then
  // come from each video's own page, the slow way, as they always did.
  if (!out.length) {
    for (const m of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ id: m[1], seconds: null });
      if (out.length === PLAYLIST_MAX) break;
    }
  }
  return out;
}

async function addOne(store, rawUrl, hint) {
  let url = String(rawUrl || "").trim();
  if (!url) return { ok: false, reason: "empty" };
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  const id = videoId(url);

  // A link already on the list is a no-op rather than a duplicate. Matching
  // on the video id means the same video pasted with a &t= timestamp or from
  // youtu.be is recognised as the one already saved.
  const existing = store.items.find((it) =>
    id ? it.videoId === id : it.url === url
  );
  // Saving a video that was binned a minute ago has to bring it back rather
  // than be waved away as a duplicate of something invisible.
  if (existing && existing.deletedAt) {
    existing.deletedAt = null;
    existing.savedAt = new Date().toISOString();
    return { ok: true, item: existing };
  }
  if (existing) return { ok: true, duplicate: true, item: existing };

  const meta = id ? await youtubeMeta(id, hint) : await genericMeta(url);
  if (id && !meta.title) return { ok: false, reason: "unavailable" };
  if (id) await cacheThumb(id);

  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    videoId: meta.videoId,
    url: meta.url,
    title: meta.title,
    channel: meta.channel || "",
    seconds: meta.seconds,
    savedAt: new Date().toISOString(),
    watchedAt: null,
    keptAt: null,
    pinnedAt: null,
    deletedAt: null,
    startedAt: null,
    answeredAt: null,
    checkedAt: null,
    goneAt: null,
    tags: [],
    note: "",
  };
  store.items.unshift(item);
  return { ok: true, item };
}

// His words, not a taxonomy — but two spellings of the same word would split a
// filter in half, so they are trimmed, de-duplicated case-blind and capped.
function cleanTags(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const tag = String(t).trim().replace(/\s+/g, " ").slice(0, 24);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === 6) break;
  }
  return out;
}

/* ---------- http ---------- */

// AMS Main Hub reads /health to fill in this app's version chip, and it is
// served from a different port, so those two answers alone are readable
// cross-origin. Nothing that changes the list is.
const HUB_ORIGINS = [
  "http://localhost:7780", "http://127.0.0.1:7780",   // Finance engine serves the hub
  "http://localhost:7794", "http://127.0.0.1:7794",   // the hub's own port
  "https://marsch124.github.io",                       // the published copy
];

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store, must-revalidate",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 2e6) req.destroy();
    });
    req.on("end", () => resolve(s));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const origin = req.headers.origin || "";

  if (HUB_ORIGINS.includes(origin) && (p === "/health" || p === "/version.json")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  // A page in the browser must not be able to add to or empty the list just by
  // knowing the port. Requests carrying no Origin at all are the app's own
  // tools — the Dock button, the shortcut, curl — and those are fine.
  const WRITES = ["/api/add", "/api/update", "/api/delete", "/api/backup", "/api/restore", "/api/refresh"];
  if (WRITES.includes(p) && origin && origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) {
    return send(res, 403, JSON.stringify({ ok: false, error: "origin not allowed" }));
  }

  try {
    if (p === "/" || p === "/index.html") {
      const html = fs.readFileSync(path.join(APP_DIR, "index.html"));
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (p === "/health") {
      return send(res, 200, JSON.stringify({ ok: true, version: APP_VERSION }));
    }
    if (p === "/version.json") {
      return send(res, 200, JSON.stringify({ version: APP_VERSION, app: "AMS WatchLater" }));
    }

    if (p.startsWith("/thumbs/")) {
      const name = path.basename(p);
      if (!/^[A-Za-z0-9_-]{11}\.jpg$/.test(name)) return send(res, 404, "no");
      const file = path.join(THUMBS, name);
      if (!fs.existsSync(file)) return send(res, 404, "no");
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
      return res.end(fs.readFileSync(file));
    }

    if (p === "/api/list") {
      // The badge in the page must show the version of the APP, not whatever
      // version happened to be stamped in the data file the last time it was
      // written — otherwise a fresh release keeps displaying the old number.
      const store = loadStore();
      return send(res, 200, JSON.stringify({ version: APP_VERSION, items: liveItems(store) }));
    }

    // The capture endpoint. "Add to WatchLater.app" and the Shortcut both
    // hit this, which is why it answers to GET as well as POST — a Shortcut
    // is far simpler to build around a plain URL.
    if (p === "/api/add") {
      let urls = [];
      if (req.method === "POST") {
        const body = await readBody(req);
        try {
          const j = JSON.parse(body);
          urls = Array.isArray(j.urls) ? j.urls : [j.url];
        } catch (e) {
          urls = body.split(/[\s\n]+/);
        }
      } else {
        urls = [url.searchParams.get("url")];
      }
      urls = urls.filter(Boolean);
      if (!urls.length) return send(res, 400, JSON.stringify({ ok: false, error: "no url" }));

      // Only a bare playlist link fans out. A watch link that happens to carry
      // &list= is still the one video he was looking at, which is how it has
      // always behaved and must keep behaving.
      let fromPlaylist = 0;
      const expanded = [];
      for (const u of urls) {
        const full = /^https?:\/\//i.test(u) ? u : "https://" + u;
        const list = !videoId(full) && playlistId(full);
        if (!list) { expanded.push({ url: u }); continue; }
        try {
          const vids = await playlistVideos(list);
          // Added last-first, so the playlist's own first video ends up on top.
          for (const v of vids.reverse()) {
            expanded.push({ url: `https://www.youtube.com/watch?v=${v.id}`, hint: v });
          }
          fromPlaylist += vids.length;
        } catch (e) {
          expanded.push({ url: u });
        }
      }
      urls = expanded;

      const store = loadStore();
      purgeDeleted(store);
      const added = [];
      const dupes = [];
      const failed = [];
      for (const u of urls) {
        try {
          const r = await addOne(store, u.url, u.hint);
          if (!r.ok) failed.push(u.url);
          else if (r.duplicate) dupes.push(r.item.title);
          else added.push(r.item.title);
        } catch (e) {
          failed.push(u.url);
        }
      }
      if (added.length) saveStore(store);

      // "Add to WatchLater.app" asks for fmt=text so it can put the answer
      // straight into a macOS notification without parsing any JSON.
      if (url.searchParams.get("fmt") === "text") {
        let line;
        if (added.length === 1) line = "Added — " + added[0];
        else if (added.length > 1 && fromPlaylist) line = `Added ${added.length} from a playlist`;
        else if (added.length > 1) line = `Added ${added.length} videos`;
        else if (dupes.length) line = "Already on your list";
        else line = "Could not read that link";
        return send(res, 200, line, "text/plain; charset=utf-8");
      }

      return send(
        res,
        200,
        JSON.stringify({ ok: true, added, dupes, failed, fromPlaylist, count: liveItems(store).length })
      );
    }

    // Takes `id` for one video or `ids` for several — ticking off six at once
    // is then a single write of the file rather than six.
    if (p === "/api/update" && req.method === "POST") {
      const j = JSON.parse(await readBody(req));
      const store = loadStore();
      const wanted = Array.isArray(j.ids) ? j.ids : [j.id];
      const touched = store.items.filter((it) => wanted.includes(it.id));
      if (!touched.length) return send(res, 404, JSON.stringify({ ok: false }));

      const now = new Date().toISOString();
      for (const item of touched) {
        if ("watched" in j) item.watchedAt = j.watched ? now : null;
        if ("keep" in j) item.keptAt = j.keep ? now : null;
        if ("seconds" in j) item.seconds = j.seconds == null ? null : +j.seconds;
        if ("note" in j) item.note = String(j.note || "").slice(0, 500);
        if ("pin" in j) item.pinnedAt = j.pin ? now : null;
        if ("started" in j) item.startedAt = j.started ? now : null;
        if ("answered" in j) item.answeredAt = j.answered ? now : null;
        if ("tags" in j) item.tags = cleanTags(j.tags);
        if (j.restore) item.deletedAt = null;
      }
      saveStore(store);
      return send(res, 200, JSON.stringify({ ok: true, item: touched[0], items: touched }));
    }

    if (p === "/api/delete" && req.method === "POST") {
      const j = JSON.parse(await readBody(req));
      const store = loadStore();
      const swept = purgeDeleted(store);
      const wanted = Array.isArray(j.ids) ? j.ids : [j.id];
      const now = new Date().toISOString();
      let marked = 0;
      for (const item of store.items) {
        if (wanted.includes(item.id) && !item.deletedAt) {
          item.deletedAt = now;
          marked++;
        }
      }
      if (marked || swept) saveStore(store);
      return send(res, 200, JSON.stringify({ ok: true, count: liveItems(store).length }));
    }

    if (p === "/api/backups") {
      return send(res, 200, JSON.stringify({ ok: true, backups: listBackups() }));
    }

    if (p === "/api/backup" && req.method === "POST") {
      const store = loadStore();
      const made = manualBackup(store, "byhand");
      return send(res, 200, JSON.stringify({ ok: true, ...made, backups: listBackups() }));
    }

    // A restore reads and checks the whole file BEFORE anything is written, and
    // puts today's list safely aside first — so a restore is itself undoable and
    // a bad file cannot leave him with nothing.
    if (p === "/api/restore" && req.method === "POST") {
      const j = JSON.parse(await readBody(req));
      const file = String(j.file || "");
      if (!BACKUP_NAME.test(file)) {
        return send(res, 400, JSON.stringify({ ok: false, error: "not a backup file" }));
      }
      const full = path.join(BACKUPS, file);
      if (!fs.existsSync(full)) {
        return send(res, 404, JSON.stringify({ ok: false, error: "that copy is gone" }));
      }

      let restored;
      try {
        restored = JSON.parse(fs.readFileSync(full, "utf8"));
        if (!restored || !Array.isArray(restored.items)) throw new Error("not a list");
        for (const it of restored.items) {
          if (!it || typeof it.id !== "string" || !it.id) throw new Error("a video has no id");
        }
      } catch (e) {
        return send(
          res,
          400,
          JSON.stringify({ ok: false, error: "that copy could not be read — nothing was changed" })
        );
      }

      const current = loadStore();
      const before = liveItems(current).length;
      const safety = manualBackup(current, "beforerestore");
      saveStore({ version: APP_VERSION, items: restored.items });

      return send(
        res,
        200,
        JSON.stringify({
          ok: true,
          count: restored.items.filter((it) => !it.deletedAt).length,
          before,
          safety: safety.file,
          backups: listBackups(),
        })
      );
    }

    if (p === "/api/refresh" && req.method === "POST") {
      const j = JSON.parse(await readBody(req));
      const wanted = Array.isArray(j.ids) ? j.ids : [j.id];
      const store = loadStore();
      const out = { updated: [], gone: [], skipped: [] };
      for (const item of store.items) {
        if (!wanted.includes(item.id)) continue;
        try {
          const what = await refreshOne(item);
          if (what === "updated") out.updated.push(item.title);
          else if (what === "gone") out.gone.push(item.title);
          else out.skipped.push(item.title);
        } catch (e) {
          out.skipped.push(item.title);
        }
      }
      saveStore(store);
      return send(res, 200, JSON.stringify({ ok: true, ...out }));
    }

    return send(res, 404, JSON.stringify({ ok: false, error: "not found" }));
  } catch (e) {
    console.error(e);
    return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const store = loadStore();
  if (purgeDeleted(store)) saveStore(store);
  console.log(`AMS WatchLater v${APP_VERSION} — http://localhost:${PORT}`);
});
