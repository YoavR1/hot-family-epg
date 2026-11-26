const BASE = "https://raw.githubusercontent.com/YoavR1/hot-family-epg/HEAD/xtream/";
const EPG = "https://raw.githubusercontent.com/YoavR1/hot-family-epg/HEAD/freetv_epg.xml.gz";
const CACHE_KEY = "?v=44";

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

function serverinfo(url) {
  return {
    url: url.origin,
    port: 443,
    protocol: "https",
    http_port: 80,
    https_port: 443,
    server: "Nginx",
    version: "FreeTV Xtream",
    timezone: "Asia/Jerusalem",
  };
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
    return json({ userinfo: u, user_info: u, server_info: serverinfo(url) });
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
    const id = String(url.searchParams.get("stream_id") || url.searchParams.get("id") || "");
    try {
      const all = await load("catchup.json");
      const channel = all[id];
      const items = ((channel && channel.items) || []).slice(-30);
      return json({
        epg_listings: items.map((it) => ({
          title: it.title,
          description: "",
          start: xDate(it.start_unix),
          end: xDate(it.stop_unix),
          start_timestamp: Math.floor(it.start_unix / 1000),
          stop_timestamp: Math.floor(it.stop_unix / 1000),
          channel_id: id,
          id: it.id,
          has_archive: "1",
          archive_duration: String(Math.max(1, Math.round((it.stop_unix - it.start_unix) / 60000))),
        })),
      });
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

async function handleGet(url) {
  const type = (url.searchParams.get("type") || "").toLowerCase();
  if (type.includes("m3u")) {
    try {
      const live = await load("live_streams.json");
      const lines = ["#EXTM3U"];
      for (const c of live) {
        lines.push(`#EXTINF:-1 tvg-id="${c.epg_channel_id}" tvg-logo="${c.stream_icon}" group-title="Live",${c.name}`);
        lines.push(c.direct_source);
      }
      return new Response(lines.join("\n"), { headers: { "Content-Type": "application/x-mpegURL", ...CORS } });
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

function xDate(ms) {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function parseXStart(raw) {
  if (!raw) return NaN;
  raw = decodeURIComponent(String(raw).replace(/ /g, ":"));
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return NaN;
  }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[:\-](\d{2})-?(\d{2})(?::?(\d{2}))?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (compact) return Date.UTC(+compact[1], +compact[2] - 1, +compact[3], +compact[4], +compact[5]);
  if (/^-\d+$/.test(raw)) return Date.now() + Number(raw) * 60000;
  const t = Date.parse(raw);
  return isNaN(t) ? NaN : t;
}

function clampCatchupUrl(u) {
  if (!u) return "";
  const stop = u.match(/stopTime=(\d+)/);
  if (!stop) return u;
  const nowShift = Date.now() - 978307200000;
  const value = Math.min(Number(stop[1]), nowShift);
  return u.replace(/stopTime=\d+/, "stopTime=" + value);
}

async function catchupUrl(streamId, rawStart, rawDuration) {
  const target = parseXStart(rawStart);
  if (!isFinite(target)) return "";
  let all;
  try {
    all = await load("catchup.json");
  } catch (e) {
    return "";
  }
  const channel = all[String(streamId)];
  if (!channel || !channel.items) return "";
  // Televizo encodes the exact target UTC clock time as 1970-01-01:HH-MM,
  // where HH:MM = target time-of-day minus 11:59. The first path segment is
  // the window length in minutes. Build the stream at that exact moment.
  if (target < 86400000) {
    const offset = target / 60000;
    const minutesOfDay = ((offset + 719) % 1440 + 1440) % 1440;
    const dateText = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const parts = dateText.split("-").map(Number);
    const nowMs = Date.now();
    const midnight = Date.UTC(parts[0], parts[1] - 1, parts[2], 0, 0, 0);
    // Clients differ: some send UTC clock time, some send the panel's local
    // clock time. Pick the interpretation that lands in the past and nearest now.
    const candidates = [minutesOfDay * 60000, (minutesOfDay - 120) * 60000, (minutesOfDay + 120) * 60000];
    const wantedMinutes = Number(rawDuration) || 0;
    let startMs = midnight + candidates[0];
    let bestScore = Infinity;
    for (const c of candidates) {
      const d = midnight + c;
      if (d > nowMs - 60000) continue;
      let score = 1000;
      for (const item of channel.items) {
        if (d < item.start_unix || d > item.stop_unix) continue;
        const len = (item.stop_unix - item.start_unix) / 60000;
        score = Math.min(score, Math.abs(len - wantedMinutes));
      }
      if (score < bestScore) {
        bestScore = score;
        startMs = d;
      }
    }
    const durationMs = Math.max(60000, Math.min(Number(rawDuration) || 30, 600) * 60000);
    const stopMs = Math.min(startMs + durationMs, nowMs);
    const shiftedStart = startMs - 978307200000;
    const shiftedStop = stopMs - 978307200000;
    return "https://d1zqtf09wb8nt5.cloudfront.net" + channel.path +
      "?startTime=" + shiftedStart + "&stopTime=" + shiftedStop;
  }
  let best = null;
  let bestDist = Infinity;
  for (const candidate of [target, target - 2 * 3600000, target - 3 * 3600000]) {
    for (const item of channel.items) {
      const d = Math.abs(item.start_unix - candidate);
      if (d < bestDist) {
        bestDist = d;
        best = item;
      }
    }
  }
  if (!best || bestDist > 12 * 3600000) return "";
  return clampCatchupUrl(best.url || "");
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path.includes("timeshift") || path.startsWith("/series/") || path.startsWith("/live/") || path.startsWith("/movie/")) {
      console.log("REQ", request.method, path, url.search);
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

    // Xtream timeshift URLs. Televizo uses a few variants across versions.
    const tsA = path.match(/^\/timeshift\/[^/]+\/[^/]+\/(\d+)\/([^/]+)\/(\d+)\.[a-z0-9]+$/i);
    if (tsA) {
      const target = await catchupUrl(tsA[3], tsA[2], tsA[1]);
      if (!target) return new Response("not found", { status: 404, headers: CORS });
      return Response.redirect(target, 302);
    }
    const tsC = path.match(/^\/live\/[^/]+\/[^/]+\/(\d+)\/([^/]+)\/(\d+)\.[a-z0-9]+$/i);
    if (tsC) {
      const target = await catchupUrl(tsC[1], tsC[2], tsC[3]);
      if (!target) return new Response("not found", { status: 404, headers: CORS });
      return Response.redirect(target, 302);
    }
    if (path.endsWith("timeshift.php") || path.endsWith("/timeshift")) {
      const target = await catchupUrl(
        url.searchParams.get("stream") || url.searchParams.get("stream_id") || "",
        url.searchParams.get("start") || "",
        url.searchParams.get("duration") || ""
      );
      if (!target) return new Response("not found", { status: 404, headers: CORS });
      return Response.redirect(target, 302);
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
    if (path.endsWith("xmltv.php")) {
      const r = await fetch(EPG, { cf: { cacheTtl: 3600 } });
      return new Response(r.body, {
        status: r.status,
        headers: { "Content-Type": "application/gzip", ...CORS },
      });
    }
    if (path === "/") {
      return json({
        service: "FreeTV Xtream API",
        endpoints: ["/player_api.php", "/get.php", "/xmltv.php"],
        note: "any username/password accepted",
      });
    }
    return new Response("not found", { status: 404, headers: CORS });
  },
};
