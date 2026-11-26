// FreeTV Xtream worker
//
// Serves Free TV Israel (web.freetv.tv) as an Xtream Codes server: live channels, catch-up and
// timeshift, EPG (player_api + XMLTV), an M3U playlist with catch-up tags, and the movie/series
// library. Live channels, movies and series come from the JSON files in this repo (xtream/*.json);
// catch-up and EPG come straight from Free TV's public API.
//
// ------------------------------------------------------------------------------------------------
// How Free TV catch-up works (checked against web.freetv.tv, Nov 2026)
//
//   Free TV runs on the Redge Media platform. For catch-up its web app calls
//     /api/products/{programRecordingId}/videos/playlist?videoType=CATCHUP&platform=BROWSER
//   and gets the channel's normal live URL back with
//     ?startTime=<ms>&stopTime=<ms>     <ms> = unix ms - 978307200000 (ms since 2001-01-01Z)
//   set exactly to the programme's EPG since/till. Facts about the origin:
//     * any window inside the last 14 days works, to the millisecond (it snaps to its 2 s grid);
//     * a past window comes back as a VOD playlist (#EXT-X-ENDLIST);
//     * a stopTime in the future is a 404;
//     * startTime alone gives an open live playlist up to the live edge. Every player treats that
//       as live and jumps to the edge - which is why rewinding inside the show that was on air
//       "only went back one second".
//
// What this worker does with a catch-up/timeshift window [start, end):
//   * start within 10 s of now            -> the live channel.
//   * end already in the past             -> 302 to the origin's exact VOD window.
//   * end still in the future (on air)    -> a "delayed live" stream served from /cu/: it starts
//     with just the first 3 segments after `start` and grows by one 2 s segment every 2 s. Every
//     player (ExoPlayer, VLC, FFmpeg, AVPlayer, hls.js) starts 3 segments from the live edge, so it
//     starts exactly at `start` and then plays on continuously, the way an Xtream timeshift stream
//     does. When the window is complete the playlist gets #EXT-X-ENDLIST.
//
// Time formats: Xtream timeshift starts are wall-clock times in server_info.timezone
// (Asia/Jerusalem). A username containing "utc" (e.g. freetv-utc) switches that login to UTC,
// for apps that send UTC.
// ------------------------------------------------------------------------------------------------

const DATA = "https://raw.githubusercontent.com/YoavR1/hot-family-epg/HEAD/xtream/";
const DATA_VERSION = "?v=50";
const API = "https://web.freetv.tv/api";
const REDGE_EPOCH_MS = 978307200000; // 2001-01-01T00:00:00Z
const SERVER_TZ = "Asia/Jerusalem";
const ARCHIVE_DAYS = 14;             // Free TV keeps 14 days (catchupTill = since + 14 days)
const SEG_MS = 2000;                 // origin segment length
const HOLD_MS = 3 * SEG_MS;          // a delayed-live playlist starts with 3 segments
const EDGE_GUARD_MS = 4000;          // never list anything newer than now - 4 s (segment complete)
const LIVE_SLACK_MS = 10000;         // a start this close to now is simply live
const END_PAD_MS = 2 * 60000;        // when a request has no end: programme end + 2 min
const XMLTV_PAST_DAYS = 14;          // the whole archive, so every recording can be picked in the guide
const XMLTV_FUTURE_DAYS = 2;
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0 Safari/537.36";
const M3U8_TYPE = "application/x-mpegURL";

const FILES = {
  get_live_categories: "live_categories.json",
  get_vod_categories: "vod_categories.json",
  get_series_categories: "series_categories.json",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
};

// ------------------------------------------------------------------ responses

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function m3u8(text, cache = "no-cache") {
  return new Response(text, { headers: { "Content-Type": M3U8_TYPE, "Cache-Control": cache, ...CORS } });
}

// Never cache redirects: each catch-up request must be resolved on its own.
function redirect(target) {
  return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store", ...CORS } });
}

const notFound = () => new Response("not found", { status: 404, headers: CORS });

// ------------------------------------------------------------------ in-memory cache (per isolate)

const mem = new Map();
const memGet = (k) => {
  const e = mem.get(k);
  if (e && e.exp > Date.now()) return e.val;
  mem.delete(k);
  return undefined;
};
const memSet = (k, val, ttl) => {
  if (mem.size > 2000) mem.clear();
  mem.set(k, { val, exp: Date.now() + ttl });
  return val;
};

// ------------------------------------------------------------------ time

const pad = (n) => String(n).padStart(2, "0");
const dtfs = new Map();

function dtf(tz) {
  let f = dtfs.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    dtfs.set(tz, f);
  }
  return f;
}

function wallParts(ms, tz) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

function tzOffsetMs(ms, tz) {
  const p = wallParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// wall-clock time in `tz` -> unix ms (handles summer time)
function wallToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

// unix ms -> "YYYY-MM-DD HH:mm:ss" in `tz` (the Xtream EPG/server time format)
function formatWall(ms, tz) {
  const p = wallParts(ms, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

function xmltvTime(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

const apiTime = (ms) => new Date(ms).toISOString().slice(0, 16) + "+0000";
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms));

// A login whose username contains "utc" gets UTC wall-clock times; everyone else Asia/Jerusalem.
const tzFor = (user) => (/utc/i.test(String(user || "")) ? "UTC" : SERVER_TZ);

// Catch-up start in any format players send:
//   2026-11-26:20-48 | 2026-11-26:20-48-30 | 2026-11-26 20:48:30 | 2026-11-26T20:48:30Z
//   20261126204830 | unix seconds | unix ms | -90 (minutes ago)
// Wall-clock forms without a zone are in `tz` (the server's timezone).
function parseStart(raw, tz) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (/%[0-9a-f]{2}/i.test(s)) {
    try { s = decodeURIComponent(s).trim(); } catch { /* keep raw */ }
  }
  if (!s) return NaN;
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{9,10}$/.test(s)) return Number(s) * 1000;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[:\sT_.-]+(\d{1,2})[-:.](\d{1,2})(?:[-:.](\d{1,2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], sec = +(m[6] || 0);
    if (m[7]) {
      const z = m[7].toUpperCase();
      const off = z === "Z" ? 0 : (z[0] === "-" ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(-2));
      return Date.UTC(y, mo - 1, d, h, mi, sec) - off * MIN;
    }
    return wallToUtc(y, mo, d, h, mi, sec, tz);
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/);
  if (m) return wallToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), tz);
  if (/^-\d+$/.test(s)) return Date.now() + Number(s) * MIN;
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

// Xtream durations are minutes. Anything above two days must be seconds.
function parseMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n > 2880 ? n * 1000 : n * MIN;
}

function parseSeconds(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n * 1000 : NaN;
}

// ------------------------------------------------------------------ repo data

async function load(name) {
  const key = "data:" + name;
  const hit = memGet(key);
  if (hit) return hit;
  const r = await fetch(DATA + name + DATA_VERSION, { cf: { cacheTtl: 1800, cacheEverything: true } });
  if (!r.ok) throw new Error("upstream " + r.status);
  return memSet(key, await r.json(), 5 * MIN);
}

async function findLive(id) {
  const all = await load("live_streams.json");
  return all.find((x) => String(x.stream_id) === String(id) || String(x.id) === String(id));
}

// Xtream "added" is a unix-seconds string; the repo JSON has ISO dates.
function unixString(v) {
  if (v == null || v === "") return "";
  if (/^\d+$/.test(String(v))) return String(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? "" : String(Math.floor(t / 1000));
}

function liveOut(c) {
  return {
    ...c,
    added: unixString(c.added),
    is_adult: "0",
    category_ids: [Number(c.category_id) || 0],
    tv_archive: 1,
    tv_archive_duration: ARCHIVE_DAYS,
  };
}

// The channel's origin directory, e.g. https://cdn/livehls/oil/freetv/live/keshet_12/live.livx/
function originDir(ch) {
  const u = new URL(ch.direct_source);
  return u.origin + u.pathname.replace(/[^/]*$/, "");
}

// ------------------------------------------------------------------ Free TV API (EPG)

async function apiProgrammes(ids, dayMs) {
  const u = new URL(API + "/products/lives/programmes");
  u.searchParams.set("platform", "BROWSER");
  for (const id of ids) u.searchParams.append("liveId[]", String(id));
  u.searchParams.set("since", apiTime(dayMs));
  u.searchParams.set("till", apiTime(dayMs + DAY)); // the API refuses spans much longer than a day
  const past = dayMs + DAY < Date.now() - HOUR;
  const r = await fetch(u.toString(), {
    headers: { Accept: "application/json", "User-Agent": UA },
    cf: { cacheTtl: past ? 21600 : 600, cacheEverything: true },
  });
  if (!r.ok) throw new Error("freetv api " + r.status);
  const list = await r.json();
  return (Array.isArray(list) ? list : [])
    .map((p) => ({
      id: p.id,
      ch: p.live && p.live.id,
      s: Date.parse(p.since),
      e: Date.parse(p.till),
      t: p.title || "",
      d: p.description || p.lead || "",
      img: (p.images && p.images["16x9"] && p.images["16x9"][0] && p.images["16x9"][0].url) || "",
    }))
    .filter((p) => p.s >= dayMs && p.s < dayMs + DAY); // a programme belongs to the UTC day it starts in
}

async function channelDay(id, dayMs) {
  const key = "day:" + id + ":" + dayMs;
  const hit = memGet(key);
  if (hit) return hit;
  const list = await apiProgrammes([id], dayMs);
  return memSet(key, list, dayMs + DAY < Date.now() - HOUR ? 6 * HOUR : 10 * MIN);
}

async function channelProgrammes(id, fromMs, toMs) {
  const days = [];
  for (let d = Math.floor(fromMs / DAY) * DAY - DAY; d < toMs; d += DAY) days.push(d);
  const lists = await Promise.all(days.map((d) => channelDay(id, d).catch(() => [])));
  const seen = new Set();
  const out = [];
  for (const p of lists.flat()) {
    if (seen.has(p.id) || p.e <= fromMs || p.s >= toMs) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out.sort((a, b) => a.s - b.s);
}

// ------------------------------------------------------------------ catch-up core

// When a request gives no end: the end of the programme airing at `start` (+2 min), else 2 h.
async function guessEnd(sid, startMs) {
  try {
    const progs = await channelProgrammes(sid, startMs - 6 * HOUR, startMs + 6 * HOUR);
    const p = progs.find((x) => x.s <= startMs && startMs < x.e);
    if (p) return p.e + END_PAD_MS;
  } catch { /* fall through */ }
  return startMs + 2 * HOUR;
}

// Resolve a catch-up window and send the player to the right stream.
async function catchup(url, sid, startMs, endMs, via) {
  const ch = await findLive(sid);
  if (!ch) return notFound();
  const now = Date.now();
  if (!Number.isFinite(startMs)) return redirect(ch.direct_source);
  // Times before 2000 are relative to "now" (old Televizo builds without a server clock).
  if (startMs < Date.UTC(2000, 0, 1)) startMs = now + startMs;
  // Free TV lists a programme for 14 days after it starts and the origin keeps a few hours more,
  // so a show that started 13 days 23 h ago still plays from its first second. Anything the origin
  // no longer has is answered with "no recording" below.
  const oldest = now - ARCHIVE_DAYS * DAY - 6 * HOUR;
  if (startMs < oldest) startMs = oldest;
  if (!Number.isFinite(endMs) || endMs <= startMs) endMs = await guessEnd(sid, startMs);
  startMs = Math.round(startMs);
  endMs = Math.round(endMs);

  let kind = "delayed";
  if (startMs > now - LIVE_SLACK_MS) kind = "live";
  else if (endMs <= now - LIVE_SLACK_MS) kind = "vod";
  console.log("CATCHUP", via, sid, iso(startMs), iso(endMs), kind, "behind=" + Math.round((now - startMs) / 1000) + "s");

  if (kind === "live") return redirect(ch.direct_source);
  if (kind === "vod") {
    const target = `${ch.direct_source.split("?")[0]}?startTime=${startMs - REDGE_EPOCH_MS}&stopTime=${endMs - REDGE_EPOCH_MS}`;
    // The origin answers an empty "#EXTM3U" for times it has no recording of (some channels keep
    // less than 14 days). Say so plainly instead of handing players an empty playlist.
    // Same URL the player fetches next, so it comes from CloudFront's cache.
    try {
      const r = await fetch(target, { headers: { "User-Agent": UA } });
      const text = r.ok ? await r.text() : "";
      if (r.ok && !text.includes("#EXT-X-STREAM-INF")) {
        console.log("CATCHUP no recording", sid, iso(startMs));
        return new Response("no recording for this time", { status: 404, headers: { "Cache-Control": "no-store", ...CORS } });
      }
    } catch { /* let the player try */ }
    return redirect(target);
  }
  return redirect(`${url.origin}/cu/${sid}/${startMs}-${endMs}-${now}/index.m3u8`);
}

async function originMaster(ch) {
  const key = "master:" + ch.stream_id;
  const hit = memGet(key);
  if (hit) return hit;
  const r = await fetch(ch.direct_source, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("origin master " + r.status);
  const text = await r.text();
  if (!text.includes("#EXT-X-STREAM-INF")) throw new Error("origin master has no variants");
  return memSet(key, text, 30 * MIN);
}

// Origin variant query (bitrate/audioId/videoId) without any time parameters.
function variantQuery(u) {
  const i = u.indexOf("?");
  const q = new URLSearchParams(i >= 0 ? u.slice(i + 1) : "");
  q.delete("startTime");
  q.delete("stopTime");
  return q.toString();
}

// Master playlist of a delayed-live window: the channel's variants, pointed at /cu/.../v.m3u8.
async function delayedMaster(url, sid, start, end, issued) {
  const ch = await findLive(sid);
  if (!ch) return notFound();
  const master = await originMaster(ch);
  const base = `${url.origin}/cu/${sid}/${start}-${end}-${issued}/v.m3u8?`;
  const out = master.split(/\r?\n/).map((line) => {
    if (!line) return line;
    if (line.startsWith("#")) return line.replace(/URI="([^"]*)"/g, (_, u) => `URI="${base}${variantQuery(u)}"`);
    return base + variantQuery(line);
  });
  console.log("CU-MASTER", sid, iso(start), iso(end), "issued", iso(issued));
  return m3u8(out.join("\n"), "no-store");
}

// Media playlist of a delayed-live window. It lists the segments from `start` up to
// start + (time since the window was opened) + 3 segments, never past now - 4 s or `end`,
// so it grows by one 2 s segment every 2 s. Once `end` is reached it is closed with ENDLIST.
async function delayedVariant(url, sid, start, end, issued) {
  const ch = await findLive(sid);
  if (!ch) return notFound();
  const dir = originDir(ch);
  const q = variantQuery(url.search);
  const now = Date.now();
  const cap = now - EDGE_GUARD_MS;
  const reach = start + Math.max(0, now - issued) + HOLD_MS;
  let stop;
  let done = false;
  if (end <= cap && reach >= end) {
    stop = end;
    done = true;
  } else {
    const limit = Math.min(reach, cap, end);
    stop = start + Math.max(1, Math.floor((limit - start) / SEG_MS)) * SEG_MS;
  }
  const target = `${dir}playlist.m3u8?${q}${q ? "&" : ""}startTime=${start - REDGE_EPOCH_MS}&stopTime=${stop - REDGE_EPOCH_MS}`;
  const r = await fetch(target, {
    headers: { "User-Agent": UA },
    cf: { cacheTtl: done ? 3600 : 5, cacheEverything: true },
  });
  if (!r.ok) {
    console.log("CU-VARIANT upstream", r.status, target);
    return new Response("upstream " + r.status, { status: 502, headers: { "Cache-Control": "no-store", ...CORS } });
  }
  let text = (await r.text()).replace(/\r\n/g, "\n");
  // One playlist type for the whole life of the playlist: EVENT (segments are only ever appended).
  text = text.replace(/^#EXTM3U[^\n]*\n/, "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n");
  if (!done) text = text.replace(/^#EXT-X-ENDLIST[^\n]*\n?/m, "");
  // Segments go straight to the CDN, never through this worker.
  const lines = text.split("\n");
  let segs = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || l[0] === "#") continue;
    segs++;
    if (!/^[a-z]+:\/\//i.test(l)) lines[i] = dir + l;
  }
  text = lines.join("\n");
  console.log("CU-VARIANT", sid, iso(start), "segs=" + segs, done ? "ENDLIST" : "growing", "watched=" + Math.round((now - issued) / 1000) + "s");
  return m3u8(text, "no-cache, no-store");
}

// ------------------------------------------------------------------ catch-up URL styles

// Xtream: /timeshift/u/p/<minutes>/<start>/<id>.ext, /streaming/timeshift.php?... etc.
async function xtreamTimeshift(url, sid, rawStart, rawMinutes, user, via) {
  let start = parseStart(rawStart, tzFor(user));
  const dur = parseMinutes(rawMinutes);
  const end = Number.isFinite(start) && Number.isFinite(dur) ? start + dur : NaN;
  // Xtream starts are whole minutes, but movie/series channels start programmes at hh:mm:ss.
  // When that minute holds the start of the programme this window runs to, begin exactly there.
  // (A seek into the end of the previous programme runs to that programme's end, so it never snaps.)
  if (Number.isFinite(end) && start % MIN === 0 && start > Date.now() - ARCHIVE_DAYS * DAY - 6 * HOUR) {
    try {
      const progs = await channelProgrammes(sid, start - HOUR, start + 2 * MIN);
      const p = progs.find((x) => x.s > start && x.s < start + MIN && end >= x.e - MIN && end <= x.e + 4 * MIN);
      if (p) start = p.s;
    } catch { /* keep the minute */ }
  }
  return catchup(url, sid, start, end, via);
}

// Query-string catch-up (our M3U template, "append"/"shift" styles, Flussonic-ish parameters).
// Unix times are seconds; `duration` is seconds; `offset` is seconds before now.
function queryWindow(params, tz) {
  const get = (...names) => {
    for (const n of names) {
      const v = params.get(n);
      if (v != null && v !== "" && !/^[{$]/.test(v)) return v;
    }
    return null;
  };
  let start = parseStart(get("start", "utc", "utcstart", "from", "begin", "timestamp", "catchup_start"), tz);
  const offset = get("offset");
  if (!Number.isFinite(start) && offset != null) start = Date.now() - Number(offset) * 1000;
  let end = parseStart(get("end", "utcend", "stop", "to", "catchup_end"), tz);
  if (!Number.isFinite(end) && Number.isFinite(start)) {
    const durS = parseSeconds(get("duration", "dur"));
    if (Number.isFinite(durS)) end = start + durS;
  }
  return { start, end };
}

const hasCatchupQuery = (params) =>
  ["start", "utc", "utcstart", "timestamp", "offset", "catchup_start"].some((n) => {
    const v = params.get(n);
    return v != null && v !== "" && !/^[{$]/.test(v);
  });

// ------------------------------------------------------------------ Xtream API

function userinfo(url) {
  const user = url.searchParams.get("username") || "freetv";
  const pass = url.searchParams.get("password") || "freetv";
  return {
    username: user,
    password: pass,
    message: "",
    auth: 1,
    status: "Active",
    exp_date: "4102444800",
    is_trial: "0",
    active_cons: "0",
    created_at: "1700000000",
    max_connections: "4",
    allowed_output_formats: ["m3u8", "ts"],
  };
}

// timestamp_now / time_now matter: players (Televizo included) use them to work out the server
// clock. Without them Televizo sent catch-up starts relative to 1970.
function serverinfo(url) {
  const now = Date.now();
  const tz = tzFor(url.searchParams.get("username"));
  return {
    url: url.hostname,
    port: url.protocol === "http:" ? (url.port || "80") : "80",
    https_port: "443",
    server_protocol: url.protocol.replace(":", ""),
    rtmp_port: "0",
    timezone: tz,
    timestamp_now: Math.floor(now / 1000),
    time_now: formatWall(now, tz),
    process: true,
  };
}

const b64 = (s) => {
  const bytes = new TextEncoder().encode(s || "");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const xmlEsc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const absUrl = (u) => (u && u.startsWith("//") ? "https:" + u : u || "");

function epgEntry(p, streamId, epgId, now, tz, full) {
  const o = {
    id: String(p.id),
    epg_id: epgId,
    title: b64(p.t),          // Xtream sends title/description base64-encoded
    lang: "he",
    start: formatWall(p.s, tz), // server time (server_info.timezone)
    end: formatWall(p.e, tz),
    description: b64(p.d),
    channel_id: epgId,
    start_timestamp: String(Math.floor(p.s / 1000)),
    stop_timestamp: String(Math.floor(p.e / 1000)),
    stream_id: String(streamId),
  };
  if (full) {
    o.now_playing = p.s <= now && now < p.e ? 1 : 0;
    o.has_archive = p.s < now && p.s > now - ARCHIVE_DAYS * DAY ? 1 : 0;
  }
  return o;
}

async function handleEpg(url, action) {
  const id = String(url.searchParams.get("stream_id") || url.searchParams.get("id") || "");
  const item = await findLive(id).catch(() => null);
  if (!item) return json({ epg_listings: [] });
  const epgId = item.epg_channel_id || "ftv_" + id + ".il";
  const tz = tzFor(url.searchParams.get("username"));
  const now = Date.now();
  if (action === "get_short_epg") {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 4));
    const progs = await channelProgrammes(id, now, now + 2 * DAY);
    return json({ epg_listings: progs.filter((p) => p.e > now).slice(0, limit).map((p) => epgEntry(p, id, epgId, now, tz, false)) });
  }
  // get_simple_data_table / get_epg: the whole archive window + 2 days ahead
  const progs = await channelProgrammes(id, now - ARCHIVE_DAYS * DAY, now + 2 * DAY);
  return json({ epg_listings: progs.map((p) => epgEntry(p, id, epgId, now, tz, true)) });
}

function filterCat(list, url) {
  const cat = url.searchParams.get("category_id");
  return cat ? list.filter((c) => String(c.category_id) === String(cat)) : list;
}

function posterOf(item) {
  return item.cover || item.stream_icon || item.icon || "";
}

function backdropOf(item) {
  const b = item.backdrop || item.backdrop_path;
  if (Array.isArray(b)) return b.filter(Boolean);
  return b ? [b] : [];
}

async function handlePlayerApi(url) {
  const action = url.searchParams.get("action");
  if (!action) {
    const u = userinfo(url);
    return json({ user_info: u, userinfo: u, server_info: serverinfo(url) });
  }

  try {
    if (action === "get_live_streams") return json(filterCat((await load("live_streams.json")).map(liveOut), url));
    if (action === "get_vod_streams") return json(filterCat(await load("vod_streams.json"), url));
    if (action === "get_series") return json(filterCat(await load("series.json"), url));
    if (FILES[action]) return json(await load(FILES[action]));
  } catch (e) {
    return json({ error: String(e) }, 502);
  }

  if (action === "get_series_info") {
    const id = String(url.searchParams.get("series_id") || "");
    try {
      return json(await load("series/" + id + ".json"));
    } catch {
      return json({ seasons: [], info: {}, episodes: {} });
    }
  }

  if (action === "get_vod_info" || action === "get_info" || action === "get_info_vod") {
    const id = String(url.searchParams.get("vod_id") || "");
    try {
      const all = await load("vod_streams.json");
      const item = all.find((x) => String(x.vod_id) === id || String(x.id) === id);
      if (!item) return json({ info: {}, movie_data: {} });
      const poster = posterOf(item);
      const info = {
        name: item.title,
        title: item.title,
        year: item.year,
        cover: poster,
        cover_big: poster,
        movie_image: poster,
        stream_icon: poster,
        icon: poster,
        backdrop_path: backdropOf(item),
        backdrop: item.backdrop || "",
        plot: item.plot || "",
        description: item.plot || "",
        category_id: item.category_id,
        rating: item.rating || "0",
        rating_5based: item.rating ? Number(item.rating) / 2 : 0,
        duration: item.duration || 0,
        duration_secs: item.duration || 0,
        releasedate: item.releasedate || "",
        releaseDate: item.releasedate || "",
        genre: item.genre || "",
        director: item.director || "",
        actors: item.actors || "",
        cast: item.actors || "",
        tmdb_id: "",
        youtube_trailer: "",
      };
      return json({ info, movie_data: item });
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  }

  if (action === "get_short_epg" || action === "get_simple_data_table" || action === "get_epg") {
    try {
      return await handleEpg(url, action);
    } catch {
      return json({ epg_listings: [] });
    }
  }

  return json({ error: "unsupported action", action });
}

// ------------------------------------------------------------------ XMLTV

async function xmltvDay(ids, byId, dayMs) {
  const key = "xml:" + dayMs;
  const hit = memGet(key);
  if (hit) return hit;
  const list = await apiProgrammes(ids, dayMs);
  let out = "";
  for (const p of list) {
    const ch = byId.get(String(p.ch));
    if (!ch) continue;
    out += `<programme start="${xmltvTime(p.s)}" stop="${xmltvTime(p.e)}" channel="${ch.epg_channel_id}" catchup-id="${p.id}">` +
      `<title lang="he">${xmlEsc(p.t)}</title>` + (p.d ? `<desc lang="he">${xmlEsc(p.d)}</desc>` : "") +
      (p.img ? `<icon src="${xmlEsc(absUrl(p.img))}"/>` : "") + "</programme>\n";
  }
  return memSet(key, out, dayMs + DAY < Date.now() - HOUR ? 6 * HOUR : 15 * MIN);
}

async function handleXmltv(ctx) {
  const live = await load("live_streams.json");
  const byId = new Map(live.map((c) => [String(c.stream_id), c]));
  const ids = live.map((c) => c.stream_id);
  const today = Math.floor(Date.now() / DAY) * DAY;
  const days = [];
  for (let d = today - XMLTV_PAST_DAYS * DAY; d <= today + XMLTV_FUTURE_DAYS * DAY; d += DAY) days.push(d);
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const write = async () => {
    const w = writable.getWriter();
    try {
      let head = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="freetv-xtream">\n';
      for (const c of live) {
        head += `<channel id="${xmlEsc(c.epg_channel_id)}"><display-name lang="he">${xmlEsc(c.name)}</display-name>` +
          (c.stream_icon ? `<icon src="${xmlEsc(c.stream_icon)}"/>` : "") + "</channel>\n";
      }
      await w.write(enc.encode(head));
      for (let i = 0; i < days.length; i += 3) {
        const parts = await Promise.all(days.slice(i, i + 3).map((d) => xmltvDay(ids, byId, d).catch(() => "")));
        for (const p of parts) await w.write(enc.encode(p));
      }
      await w.write(enc.encode("</tv>\n"));
    } catch { /* send what we have */ }
    await w.close().catch(() => {});
  };
  ctx.waitUntil(write());
  return new Response(readable, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=900", ...CORS },
  });
}

// ------------------------------------------------------------------ M3U

// Second-accurate catch-up for M3U players: {utc}/{utcend} are unix seconds of the exact
// position, so seeking is not limited to whole minutes the way Xtream timeshift URLs are.
async function handleGet(url) {
  const type = (url.searchParams.get("type") || "m3u_plus").toLowerCase();
  if (!type.includes("m3u")) return json({ error: "use type=m3u_plus" });
  try {
    const base = url.origin;
    const user = encodeURIComponent(url.searchParams.get("username") || "freetv");
    const pass = encodeURIComponent(url.searchParams.get("password") || "freetv");
    const ext = (url.searchParams.get("output") || "").toLowerCase() === "ts" ? "ts" : "m3u8";
    const epg = `${base}/xmltv.php?username=${user}&password=${pass}`;
    const [live, cats] = await Promise.all([load("live_streams.json"), load("live_categories.json").catch(() => [])]);
    const catName = new Map(cats.map((c) => [String(c.category_id), c.category_name]));
    const lines = [`#EXTM3U x-tvg-url="${epg}" url-tvg="${epg}"`];
    for (const c of live) {
      const group = catName.get(String(c.category_id)) || "Live";
      const name = String(c.name || "").trim();
      lines.push(
        `#EXTINF:-1 tvg-id="${c.epg_channel_id}" tvg-name="${name.replace(/"/g, "'")}" tvg-logo="${c.stream_icon}" group-title="${group}" ` +
        `catchup="default" catchup-days="${ARCHIVE_DAYS}" tvg-rec="${ARCHIVE_DAYS}" timeshift="${ARCHIVE_DAYS}" ` +
        `catchup-source="${base}/catchup/${c.stream_id}.m3u8?start={utc}&end={utcend}",${name}`,
      );
      lines.push(`${base}/live/${user}/${pass}/${c.stream_id}.${ext}`);
    }
    return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "audio/x-mpegurl; charset=utf-8", ...CORS } });
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
}

// ------------------------------------------------------------------ movies & series

async function clearHlsVariant(code, id, bandwidth) {
  const base = "https://vod.freetv.tv/hls/oil/freetv/vod/" + code + "/MOVIE/LIBCODER_HLS_1080/playlist.smil/";
  const r = await fetch(base + "playlist.m3u8?bandwidth=" + bandwidth + "&id=" + id + "&");
  if (!r.ok) throw new Error("variant " + r.status);
  const text = await r.text();
  const lines = text.split(/\r?\n/)
    .filter((l) => !l.toUpperCase().startsWith("#EXT-X-KEY"))
    .map((l) => (l && !l.startsWith("#") && !/^https?:/i.test(l) ? base + l : l));
  return new Response(lines.join("\n"), { status: 200, headers: { "Content-Type": M3U8_TYPE, ...CORS } });
}

function clearHlsMaster(code) {
  const body = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",DEFAULT=YES,AUTOSELECT=YES,NAME="he",LANGUAGE="he",URI="./clearvar/' + code + '/0"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac"',
    "./clearvar/" + code + "/6",
  ].join("\n");
  return new Response(body, { status: 200, headers: { "Content-Type": M3U8_TYPE, ...CORS } });
}

async function proxyStream(request, target) {
  const h = new Headers();
  for (const key of ["range", "if-range", "user-agent"]) {
    const v = request.headers.get(key);
    if (v) h.set(key, v);
  }
  h.set("accept-encoding", "identity");
  const up = await fetch(target, { headers: h, cf: { cacheEverything: false } });
  const out = new Headers(CORS);
  for (const key of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control"]) {
    const v = up.headers.get(key);
    if (v) out.set(key, v);
  }
  return new Response(up.body, { status: up.status, headers: out });
}

function findEpisode(series, seasonNum, epNum) {
  const seasons = (series && series.episodes) || {};
  const list = seasons[String(Number(seasonNum))] || seasons[seasonNum] || [];
  return list.find((e) => Number(e.episode_num) === Number(epNum));
}

async function playVod(request, target) {
  if (!target) return notFound();
  if (target.includes("/clearhls/")) return redirect(target);
  return proxyStream(request, target);
}

// ------------------------------------------------------------------ router

async function route(request, url, ctx) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const q = url.searchParams;
  let m;

  // Delayed-live catch-up windows (see the header comment).
  if ((m = path.match(/^\/cu\/(\d+)\/(\d{11,14})-(\d{11,14})-(\d{11,14})\/(index|v)\.m3u8$/))) {
    const [sid, start, end, issued] = [m[1], +m[2], +m[3], +m[4]];
    if (!(end > start)) return notFound();
    return m[5] === "index" ? delayedMaster(url, sid, start, end, issued) : delayedVariant(url, sid, start, end, issued);
  }

  // Xtream timeshift: /timeshift/u/p/<minutes>/<start>/<id>[.ext]
  if ((m = path.match(/^\/timeshift\/([^/]+)\/([^/]+)\/(\d+)\/([^/]+)\/(\d+)(?:\.[a-z0-9]+)?$/i))) {
    return xtreamTimeshift(url, m[5], decodeURIComponent(m[4]), m[3], decodeURIComponent(m[1]), "xtream");
  }
  // Some apps put the id first: /live/u/p/<id>/<start>/<minutes>[.ext]
  if ((m = path.match(/^\/live\/([^/]+)\/([^/]+)\/(\d+)\/([^/]+)\/(\d+)(?:\.[a-z0-9]+)?$/i))) {
    return xtreamTimeshift(url, m[3], decodeURIComponent(m[4]), m[5], decodeURIComponent(m[1]), "xtream-live");
  }
  // timeshift.php / streaming/timeshift.php ?username&password&stream&start&duration
  if (/\/timeshift(?:\.php)?$/i.test(path)) {
    return xtreamTimeshift(url, q.get("stream") || q.get("stream_id") || q.get("id") || "",
      q.get("start") || q.get("utc") || "", q.get("duration") || "", q.get("username"), "timeshift.php");
  }
  // M3U catch-up template: /catchup/<id>.m3u8?start={utc}&end={utcend}
  if ((m = path.match(/^\/catchup\/(\d+)(?:\.[a-z0-9]+)?$/i))) {
    const w = queryWindow(q, tzFor(q.get("username")));
    return catchup(url, m[1], w.start, w.end, "m3u");
  }
  // Flussonic-style archive URLs: .../<id>/(index|archive|video)-<start>-<seconds|now>.m3u8,
  // .../<id>/timeshift_abs-<start>.(m3u8|ts), .../<id>-<start>-<seconds>.m3u8
  if ((m = path.match(/\/(\d+)[/-](?:(?:index|archive|video|mono|timeshift_abs(?:_video)?)-)?(\d{10})(?:-(\d+|now))?\.(?:m3u8|ts)$/i))) {
    const start = Number(m[2]) * 1000;
    const end = m[3] && m[3] !== "now" ? start + Number(m[3]) * 1000 : NaN;
    if (await findLive(m[1])) return catchup(url, m[1], start, end, "flussonic");
  }

  // Live: /live/u/p/<id>.ext (with ?utc=/?start= it is catch-up, "append"/"shift" style)
  if ((m = path.match(/^\/live\/([^/]+)\/([^/]+)\/(\d+)(?:\.[a-z0-9]+)?$/i))) {
    if (hasCatchupQuery(q)) {
      const w = queryWindow(q, tzFor(decodeURIComponent(m[1])));
      return catchup(url, m[3], w.start, w.end, "live-query");
    }
    const item = await findLive(m[3]);
    return item ? redirect(item.direct_source) : notFound();
  }

  // Movies: /movie/u/p/<id>.ext
  if ((m = path.match(/^\/movie\/[^/]+\/[^/]+\/(\d+)\.[a-z0-9]+$/i))) {
    const all = await load("vod_streams.json");
    const item = all.find((x) => String(x.vod_id) === m[1] || String(x.id) === m[1]);
    return item ? playVod(request, item.direct_source) : notFound();
  }

  // Series: /series/u/p/<episode_id>.ext
  if ((m = path.match(/^\/series\/[^/]+\/[^/]+\/(\d+)\.[a-z0-9]+$/i))) {
    const index = await load("episode_index.json");
    const seriesId = index[m[1]];
    if (!seriesId) return notFound();
    const series = await load("series/" + seriesId + ".json");
    for (const list of Object.values(series.episodes || {})) {
      const ep = list.find((e) => String(e.id) === m[1]);
      if (ep) return playVod(request, ep.direct_source || "");
    }
    return notFound();
  }
  // Series: /series/u/p/<series_id>/<season>/<episode>.ext
  if ((m = path.match(/^\/series\/[^/]+\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.[a-z0-9]+$/i))) {
    const series = await load("series/" + m[1] + ".json");
    const ep = findEpisode(series, m[2], m[3]);
    return ep ? playVod(request, ep.direct_source || "") : notFound();
  }

  if ((m = path.match(/^\/clearvar\/([^/]+)\/(\d+)$/))) {
    return clearHlsVariant(m[1], m[2], m[2] === "0" ? 128000 : 2800000);
  }
  if ((m = path.match(/^\/clearhls\/([^/]+)$/))) return clearHlsMaster(m[1]);

  if (/\/player_api\.php$/i.test(path)) return handlePlayerApi(url);
  if (/\/get\.php$/i.test(path)) return handleGet(url);
  if (/\/(xmltv\.php|epg\.xml|xmltv\.xml)$/i.test(path)) return handleXmltv(ctx);

  if (path === "/") {
    return json({
      service: "FreeTV Xtream API",
      timezone: SERVER_TZ,
      archive_days: ARCHIVE_DAYS,
      endpoints: [
        "/player_api.php",
        "/get.php?username=freetv&password=freetv&type=m3u_plus",
        "/xmltv.php",
        "/live/{user}/{pass}/{id}.m3u8",
        "/timeshift/{user}/{pass}/{minutes}/{YYYY-MM-DD:HH-MM}/{id}.m3u8",
        "/catchup/{id}.m3u8?start={unix}&end={unix}",
      ],
      note: "any username/password works; a username containing 'utc' uses UTC timeshift times",
    });
  }

  // Bare Xtream live URL: /u/p/<id>[.ext]
  if ((m = path.match(/^\/[^/]+\/[^/]+\/(\d+)(?:\.[a-z0-9]+)?$/i))) {
    const item = await findLive(m[1]);
    if (item) return redirect(item.direct_source);
  }
  return notFound();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (/^\/(timeshift|catchup|live|series|movie)\b|timeshift/i.test(url.pathname)) {
      console.log("REQ", request.method, url.pathname, url.search, request.headers.get("user-agent") || "");
    }
    try {
      return await route(request, url, ctx);
    } catch (e) {
      console.log("ERR", url.pathname, String(e && e.stack || e));
      return json({ error: String(e) }, 502);
    }
  },
};

export const _test = { parseStart, parseMinutes, formatWall, wallToUtc, queryWindow, tzFor };
