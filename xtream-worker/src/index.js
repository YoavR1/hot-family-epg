// FreeTV Xtream worker
//
// Live channels, movies and series are still served from the JSON files in this repo (xtream/*.json).
// Catch-up and EPG now come straight from Free TV's public API (web.freetv.tv/api),
// so they no longer depend on xtream/catchup/*.json being regenerated.
//
// How Free TV catch-up works (Redge Media platform):
//   catch-up = the channel's normal live URL + ?startTime=<ms>&stopTime=<ms>
//   where <ms> = unix ms - 978307200000 (milliseconds since 2001-01-01Z).
//   Free TV's own app uses the exact EPG since/till (no padding). The origin accepts
//   any second as a start and a stopTime in the future (show still airing).

const BASE = "https://raw.githubusercontent.com/YoavR1/hot-family-epg/HEAD/xtream/";
const CACHE_KEY = "?v=49";
const API = "https://web.freetv.tv/api";
const STREAM_HOST = "https://d1zqtf09wb8nt5.cloudfront.net";
const REDGE_EPOCH_MS = 978307200000; // 2001-01-01T00:00:00Z
const TZ = "Asia/Jerusalem";          // Xtream "start" values are in this timezone
const ARCHIVE_DAYS = 14;              // Free TV keeps 14 days (catchupTill = since + 14d)
const XMLTV_PAST_DAYS = 7;
const XMLTV_FUTURE_DAYS = 2;
const DAY = 86400000;

const FILES = {
  get_live_categories: "live_categories.json",
  get_live_streams: "live_streams.json",
  get_vod_categories: "vod_categories.json",
  get_vod_streams: "vod_streams.json",
  get_series_categories: "series_categories.json",
  get_series: "series.json",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

async function load(name) {
  const r = await fetch(BASE + name + CACHE_KEY, { cf: { cacheTtl: 1800, cacheEverything: true } });
  if (!r.ok) throw new Error("upstream " + r.status);
  return r.json();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Never cache redirects: a cached catch-up redirect is what made different
// requests come back with the same window.
function redirect(target) {
  return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store", ...CORS } });
}

function userinfo(url) {
  const user = url.searchParams.get("username") || "freetv";
  const pass = url.searchParams.get("password") || "freetv";
  return {
    username: user,
    password: pass,
    message: "",
    auth: "1",
    status: "Active",
    "exp-date": "4102444800",
    exp_date: "4102444800",
    is_trial: "0",
    active_cons: "0",
    created_at: "1700000000",
    max_connections: "4",
    allowedips: [],
  };
}

// timestamp_now / time_now matter: players (Televizo included) use them to work out
// the server clock. Without them Televizo sent catch-up starts relative to 1970.
function serverinfo(url) {
  const now = Date.now();
  return {
    url: url.origin,
    port: 443,
    protocol: "https",
    server_protocol: "https",
    http_port: 80,
    https_port: 443,
    rtmp_port: 0,
    server: "Nginx",
    version: "FreeTV Xtream",
    timezone: TZ,
    timestamp_now: Math.floor(now / 1000),
    time_now: formatLocal(now),
    process: true,
  };
}

// ------------------------------------------------------------------ time helpers

const pad = (n) => String(n).padStart(2, "0");
const DTF = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function localParts(ms) {
  const p = {};
  for (const { type, value } of DTF.formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

function tzOffsetMs(ms) {
  const p = localParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// Israel wall-clock time -> unix ms (handles summer time)
function zonedToUtc(y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - tzOffsetMs(guess);
  return guess - tzOffsetMs(first);
}

// unix ms -> "YYYY-MM-DD HH:mm:ss" in Israel time (what Xtream players expect)
function formatLocal(ms) {
  const p = localParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

function xmltvTime(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

const apiTime = (ms) => new Date(ms).toISOString().slice(0, 16) + "+0000";

// Xtream start: 2026-11-26:20-00 | 2026-11-26:20-00-30 | "2026-11-26 20:00" | unix s | unix ms.
// Wall-clock forms are Israel time, because server_info says Asia/Jerusalem.
function parseXStart(raw) {
  if (!raw) return NaN;
  const s = decodeURIComponent(String(raw)).trim();
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{9,10}$/.test(s)) return Number(s) * 1000;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[:\sT_.-]+(\d{1,2})[-:.](\d{1,2})(?:[-:.](\d{1,2}))?$/);
  if (m) return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
  m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/);
  if (m) return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
  if (/^-\d+$/.test(s)) return Date.now() + Number(s) * 60000;
  const t = Date.parse(s);
  return isNaN(t) ? NaN : t;
}

// ------------------------------------------------------------------ Free TV API

const mem = new Map(); // per-isolate cache
const memGet = (k) => { const e = mem.get(k); if (e && e.exp > Date.now()) return e.val; mem.delete(k); };
const memSet = (k, val, ttl) => { mem.set(k, { val, exp: Date.now() + ttl }); return val; };

async function apiProgrammes(ids, dayMs) {
  const u = new URL(API + "/products/lives/programmes");
  u.searchParams.set("platform", "BROWSER");
  for (const id of ids) u.searchParams.append("liveId[]", String(id));
  u.searchParams.set("since", apiTime(dayMs));
  u.searchParams.set("till", apiTime(dayMs + DAY)); // API refuses spans longer than ~24h
  const past = dayMs + DAY < Date.now() - 3600000;
  const r = await fetch(u.toString(), {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    cf: { cacheTtl: past ? 21600 : 600, cacheEverything: true },
  });
  if (!r.ok) throw new Error("freetv api " + r.status);
  const list = await r.json();
  return (Array.isArray(list) ? list : [])
    .map((p) => ({
      id: p.id, ch: p.live && p.live.id, s: Date.parse(p.since), e: Date.parse(p.till),
      t: p.title || "", d: p.description || p.lead || "",
      img: (p.images && p.images["16x9"] && p.images["16x9"][0] && p.images["16x9"][0].url) || "",
    }))
    .filter((p) => p.s >= dayMs && p.s < dayMs + DAY); // each programme belongs to the day it starts in
}

async function channelDay(id, dayMs) {
  const key = id + ":" + dayMs;
  const hit = memGet(key);
  if (hit) return hit;
  const list = await apiProgrammes([id], dayMs);
  return memSet(key, list, dayMs + DAY < Date.now() - 3600000 ? 6 * 3600000 : 600000);
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

function b64(s) {
  const bytes = new TextEncoder().encode(s || "");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const xmlEsc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const absUrl = (u) => (u && u.startsWith("//") ? "https:" + u : u || "");

// ------------------------------------------------------------------ live channels

async function liveStreams() {
  const all = await load("live_streams.json");
  return all.map((c) => ({ ...c, tv_archive: 1, tv_archive_duration: ARCHIVE_DAYS }));
}

async function findLive(id) {
  const all = await load("live_streams.json");
  return all.find((x) => String(x.stream_id) === String(id) || String(x.id) === String(id));
}

function livePath(item) {
  try { return new URL(item.direct_source).pathname; } catch { return ""; }
}

// Exact window - no snapping to programme boundaries (snapping is what made seeking jump).
async function catchupTarget(streamId, startMs, stopMs) {
  const item = await findLive(streamId);
  if (!item) return "";
  const path = livePath(item);
  if (!path || !Number.isFinite(startMs)) return "";
  const now = Date.now();
  if (startMs > now) return item.direct_source; // future -> live
  const oldest = now - ARCHIVE_DAYS * DAY + 60000;
  if (startMs < oldest) startMs = oldest;
  if (!Number.isFinite(stopMs) || stopMs <= startMs) stopMs = startMs + 3 * 3600000;
  const st = "?startTime=" + (Math.round(startMs) - REDGE_EPOCH_MS);
  // The origin answers 404 when stopTime is in the future. A window that reaches
  // "now" (live rewind, or a show still airing) is sent WITHOUT stopTime: the origin
  // then returns a growing playlist from startTime up to the live edge (no ENDLIST),
  // so the player can seek forward to live and keep watching. Verified on the origin.
  if (stopMs > now - 10000) return STREAM_HOST + path + st;
  return STREAM_HOST + path + st + "&stopTime=" + (Math.round(stopMs) - REDGE_EPOCH_MS);
}

// Xtream timeshift: start (server time) + duration in minutes.
async function timeshiftTarget(streamId, rawStart, rawDuration) {
  let start = parseXStart(rawStart);
  if (!Number.isFinite(start)) return "";
  const minutes = Number(rawDuration) || 120;
  // Older Televizo builds (before server_info had timestamp_now) sent times relative
  // to 1970: "HH:MM" = how far back from now. Kept as a fallback only.
  if (start < Date.UTC(2000, 0, 1)) {
    const wrap = String(rawStart).match(/^1969-12-31[:\s](\d{2})-(\d{2})/);
    const back = wrap ? 1440 - (+wrap[1] * 60 + +wrap[2]) : Math.abs(start - zonedToUtc(1970, 1, 1, 0, 0, 0)) / 60000;
    start = Date.now() - back * 60000;
  }
  return catchupTarget(streamId, start, start + minutes * 60000);
}

// ------------------------------------------------------------------ EPG

function epgEntry(p, streamId, epgId, now, full) {
  const o = {
    id: String(p.id),
    epg_id: epgId,
    title: b64(p.t),            // Xtream sends title/description base64-encoded
    lang: "he",
    start: formatLocal(p.s),    // server-local (Israel) time, matching server_info.timezone
    end: formatLocal(p.e),
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
  const now = Date.now();
  if (action === "get_short_epg") {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 4));
    const progs = await channelProgrammes(id, now, now + 2 * DAY);
    return json({ epg_listings: progs.filter((p) => p.e > now).slice(0, limit).map((p) => epgEntry(p, id, epgId, now, false)) });
  }
  // get_simple_data_table / get_epg: full archive window + 2 days ahead
  const progs = await channelProgrammes(id, now - ARCHIVE_DAYS * DAY, now + 2 * DAY);
  return json({ epg_listings: progs.map((p) => epgEntry(p, id, epgId, now, true)) });
}

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
  return memSet(key, out, dayMs + DAY < Date.now() - 3600000 ? 6 * 3600000 : 900000);
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
    } catch (e) { /* send what we have */ }
    await w.close().catch(() => {});
  };
  ctx.waitUntil(write());
  return new Response(readable, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=900", ...CORS },
  });
}

// ------------------------------------------------------------------ movies & series (unchanged)

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
    return json({ userinfo: u, user_info: u, server_info: serverinfo(url) });
  }

  if (action === "get_live_streams") {
    try {
      const cat = url.searchParams.get("category_id");
      const all = await liveStreams();
      return json(cat ? all.filter((c) => String(c.category_id) === cat) : all);
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  }

  if (FILES[action]) {
    try {
      return json(await load(FILES[action]));
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  }

  if (action === "get_series_info") {
    const id = String(url.searchParams.get("series_id") || "");
    try {
      return json(await load("series/" + id + ".json"));
    } catch (e) {
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
    } catch (e) {
      return json({ epg_listings: [] });
    }
  }

  return json({ error: "unsupported action", action });
}

async function clearHlsVariant(code, id, bandwidth) {
  const base = "https://vod.freetv.tv/hls/oil/freetv/vod/" + code + "/MOVIE/LIBCODER_HLS_1080/playlist.smil/";
  const r = await fetch(base + "playlist.m3u8?bandwidth=" + bandwidth + "&id=" + id + "&");
  if (!r.ok) throw new Error("variant " + r.status);
  const text = await r.text();
  const lines = text.split(/\r?\n/)
    .filter((l) => !l.toUpperCase().startsWith("#EXT-X-KEY"))
    .map((l) => (l && !l.startsWith("#") && !/^https?:/i.test(l) ? base + l : l));
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "Content-Type": "application/vnd.apple.mpegURL", ...CORS },
  });
}

async function clearHlsMaster(code) {
  const body = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",DEFAULT=YES,AUTOSELECT=YES,NAME="he",LANGUAGE="he",URI="./clearvar/' + code + '/0"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac"',
    "./clearvar/" + code + "/6",
  ].join("\n");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/vnd.apple.mpegURL", ...CORS },
  });
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

// M3U with catch-up tags. {utc}/{utcend} are second-accurate, so seeking works.
async function handleGet(url) {
  const type = (url.searchParams.get("type") || "").toLowerCase();
  if (type.includes("m3u")) {
    try {
      const base = url.origin;
      const user = encodeURIComponent(url.searchParams.get("username") || "freetv");
      const pass = encodeURIComponent(url.searchParams.get("password") || "freetv");
      const epg = `${base}/xmltv.php?username=${user}&password=${pass}`;
      const [live, cats] = await Promise.all([load("live_streams.json"), load("live_categories.json").catch(() => [])]);
      const catName = new Map(cats.map((c) => [String(c.category_id), c.category_name]));
      const lines = [`#EXTM3U x-tvg-url="${epg}" url-tvg="${epg}"`];
      for (const c of live) {
        const group = catName.get(String(c.category_id)) || "Live";
        lines.push(
          `#EXTINF:-1 tvg-id="${c.epg_channel_id}" tvg-logo="${c.stream_icon}" group-title="${group}" ` +
          `catchup="default" catchup-days="${ARCHIVE_DAYS}" ` +
          `catchup-source="${base}/catchup/${c.stream_id}.m3u8?start={utc}&end={utcend}",${c.name}`,
        );
        lines.push(`${base}/live/${user}/${pass}/${c.stream_id}.m3u8`);
      }
      return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "application/x-mpegURL", ...CORS } });
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  }
  return json({ error: "use direct_source URLs from player_api.php" });
}

function findEpisode(series, seasonNum, epNum) {
  const seasons = (series && series.episodes) || {};
  const list = seasons[String(Number(seasonNum))] || seasons[seasonNum] || [];
  return list.find((e) => Number(e.episode_num) === Number(epNum));
}

// ------------------------------------------------------------------ router

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path.includes("timeshift") || path.includes("catchup") || path.startsWith("/series/") || path.startsWith("/live/") || path.startsWith("/movie/")) {
      console.log("REQ", request.method, path, url.search);
    }

    // Xtream timeshift: /timeshift/user/pass/<minutes>/<start>/<id>.<ext>
    const tsA = path.match(/^\/timeshift\/[^/]+\/[^/]+\/(\d+)\/([^/]+)\/(\d+)\.[a-z0-9]+$/i);
    if (tsA) {
      const target = await timeshiftTarget(tsA[3], tsA[2], tsA[1]);
      return target ? redirect(target) : new Response("not found", { status: 404, headers: CORS });
    }
    // Televizo variant: /live/user/pass/<id>/<start>/<minutes>.<ext>
    const tsC = path.match(/^\/live\/[^/]+\/[^/]+\/(\d+)\/([^/]+)\/(\d+)\.[a-z0-9]+$/i);
    if (tsC) {
      const target = await timeshiftTarget(tsC[1], tsC[2], tsC[3]);
      return target ? redirect(target) : new Response("not found", { status: 404, headers: CORS });
    }
    if (path.endsWith("timeshift.php") || path.endsWith("/timeshift")) {
      const target = await timeshiftTarget(
        url.searchParams.get("stream") || url.searchParams.get("stream_id") || "",
        url.searchParams.get("start") || "",
        url.searchParams.get("duration") || "",
      );
      return target ? redirect(target) : new Response("not found", { status: 404, headers: CORS });
    }
    // M3U catch-up: /catchup/<id>.m3u8?start={utc}&end={utcend}  (unix seconds)
    const cu = path.match(/^\/catchup\/(\d+)(?:\.[a-z0-9]+)?$/i);
    if (cu) {
      const start = parseXStart(url.searchParams.get("start") || url.searchParams.get("utc"));
      const endRaw = url.searchParams.get("end") || url.searchParams.get("utcend");
      let stop = endRaw ? parseXStart(endRaw) : NaN;
      if (!Number.isFinite(stop) && url.searchParams.get("duration")) stop = start + Number(url.searchParams.get("duration")) * 1000;
      const target = await catchupTarget(cu[1], start, stop);
      return target ? redirect(target) : new Response("not found", { status: 404, headers: CORS });
    }

    // Televizo builds playback URLs itself instead of using direct_source.
    const movie = path.match(/^\/movie\/[^/]+\/[^/]+\/(\d+)\.[a-z0-9]+$/i);
    if (movie) {
      try {
        const all = await load("vod_streams.json");
        const item = all.find((x) => String(x.vod_id) === movie[1] || String(x.id) === movie[1]);
        if (!item) return new Response("not found", { status: 404, headers: CORS });
        if (item.direct_source.includes("/clearhls/")) return Response.redirect(item.direct_source, 302);
        return proxyStream(request, item.direct_source);
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    const live = path.match(/^\/live\/[^/]+\/[^/]+\/(\d+)\.[a-z0-9]+$/i);
    if (live) {
      try {
        const all = await load("live_streams.json");
        const item = all.find((x) => String(x.stream_id) === live[1] || String(x.id) === live[1]);
        if (!item) return new Response("not found", { status: 404, headers: CORS });
        return Response.redirect(item.direct_source, 302);
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    // /series/user/pass/<episode_id>.<ext>
    const episodeOne = path.match(/^\/series\/[^/]+\/[^/]+\/(\d+)\.[a-z0-9]+$/i);
    if (episodeOne) {
      try {
        const index = await load("episode_index.json");
        const seriesId = index[episodeOne[1]];
        if (!seriesId) return new Response("not found", { status: 404, headers: CORS });
        const series = await load("series/" + seriesId + ".json");
        let target = "";
        for (const list of Object.values(series.episodes || {})) {
          const ep = list.find((e) => String(e.id) === episodeOne[1]);
          if (ep) {
            target = ep.direct_source || "";
            break;
          }
        }
        if (!target) return new Response("not found", { status: 404, headers: CORS });
        if (target.includes("/clearhls/")) return Response.redirect(target, 302);
        return proxyStream(request, target);
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    // /series/user/pass/<series_id>/<season>/<episode>.<ext>
    const episodeThree = path.match(/^\/series\/[^/]+\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.[a-z0-9]+$/i);
    if (episodeThree) {
      try {
        const series = await load("series/" + episodeThree[1] + ".json");
        const ep = findEpisode(series, episodeThree[2], episodeThree[3]);
        if (!ep || !ep.direct_source) return new Response("not found", { status: 404, headers: CORS });
        if (ep.direct_source.includes("/clearhls/")) return Response.redirect(ep.direct_source, 302);
        return proxyStream(request, ep.direct_source);
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    const clearVar = path.match(/^\/clearvar\/([^/]+)\/(\d+)$/);
    if (clearVar) {
      try {
        return await clearHlsVariant(clearVar[1], clearVar[2], clearVar[2] === "0" ? 128000 : 2800000);
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }
    const clearMaster = path.match(/^\/clearhls\/([^/]+)$/);
    if (clearMaster) return clearHlsMaster(clearMaster[1]);

    if (path.endsWith("player_api.php")) return handlePlayerApi(url);
    if (path.endsWith("get.php")) return handleGet(url);
    if (path.endsWith("xmltv.php")) return handleXmltv(ctx);
    if (path === "/") {
      return json({
        service: "FreeTV Xtream API",
        endpoints: ["/player_api.php", "/get.php", "/xmltv.php", "/timeshift/u/p/{minutes}/{YYYY-MM-DD:HH-mm}/{id}.m3u8", "/catchup/{id}.m3u8?start={unix}&end={unix}"],
        timezone: TZ,
        note: "any username/password accepted",
      });
    }
    return new Response("not found", { status: 404, headers: CORS });
  },
};

export const _test = { parseXStart, formatLocal, timeshiftTarget, catchupTarget };
