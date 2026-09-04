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
const APP_VERSION = "1.3";

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

// Write to a temp file and rename, so a crash mid-write cannot leave a
// half-written store behind.
function saveStore(data) {
  data.version = APP_VERSION;
  writeBackup(data);
  const tmp = STORE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE);
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

async function youtubeMeta(id) {
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

/* ---------- adding ---------- */

async function addOne(store, rawUrl) {
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
  if (existing) return { ok: true, duplicate: true, item: existing };

  const meta = id ? await youtubeMeta(id) : await genericMeta(url);
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
    note: "",
  };
  store.items.unshift(item);
  return { ok: true, item };
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
  const WRITES = ["/api/add", "/api/update", "/api/delete"];
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
      return send(res, 200, JSON.stringify({ ...store, version: APP_VERSION }));
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

      const store = loadStore();
      const added = [];
      const dupes = [];
      const failed = [];
      for (const u of urls) {
        try {
          const r = await addOne(store, u);
          if (!r.ok) failed.push(u);
          else if (r.duplicate) dupes.push(r.item.title);
          else added.push(r.item.title);
        } catch (e) {
          failed.push(u);
        }
      }
      if (added.length) saveStore(store);

      // "Add to WatchLater.app" asks for fmt=text so it can put the answer
      // straight into a macOS notification without parsing any JSON.
      if (url.searchParams.get("fmt") === "text") {
        let line;
        if (added.length === 1) line = "Added — " + added[0];
        else if (added.length > 1) line = `Added ${added.length} videos`;
        else if (dupes.length) line = "Already on your list";
        else line = "Could not read that link";
        return send(res, 200, line, "text/plain; charset=utf-8");
      }

      return send(
        res,
        200,
        JSON.stringify({ ok: true, added, dupes, failed, count: store.items.length })
      );
    }

    if (p === "/api/update" && req.method === "POST") {
      const j = JSON.parse(await readBody(req));
      const store = loadStore();
      const item = store.items.find((it) => it.id === j.id);
      if (!item) return send(res, 404, JSON.stringify({ ok: false }));
      if ("watched" in j) item.watchedAt = j.watched ? new Date().toISOString() : null;
      if ("keep" in j) item.keptAt = j.keep ? new Date().toISOString() : null;
      if ("seconds" in j) item.seconds = j.seconds == null ? null : +j.seconds;
      if ("note" in j) item.note = String(j.note || "").slice(0, 500);
      saveStore(store);
      return send(res, 200, JSON.stringify({ ok: true, item }));
    }

    if (p === "/api/delete" && req.method === "POST") {
      const j = JSON.parse(await readBody(req));
      const store = loadStore();
      const before = store.items.length;
      store.items = store.items.filter((it) => it.id !== j.id);
      if (store.items.length !== before) saveStore(store);
      return send(res, 200, JSON.stringify({ ok: true, count: store.items.length }));
    }

    return send(res, 404, JSON.stringify({ ok: false, error: "not found" }));
  } catch (e) {
    console.error(e);
    return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AMS WatchLater v${APP_VERSION} — http://localhost:${PORT}`);
});
