const BASE = "https://raw.githubusercontent.com/YoavR1/hot-family-epg/main/xtream/";
const EPG = "https://raw.githubusercontent.com/YoavR1/hot-family-epg/main/freetv_epg.xml.gz";

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
  const r = await fetch(BASE + name + "?v=6", { cf: { cacheTtl: 1800, cacheEverything: true } });
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
      const all = await load("series_episodes.json");
      return json(all[id] || { seasons: [], info: {} });
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  }

  if (action === "get_info" || action === "get_info_vod" || action === "get_vod_info") {
    const id = String(url.searchParams.get("vod_id") || "");
    try {
      const all = await load("vod_streams.json");
      const item = all.find((x) => String(x.vod_id) === id || String(x.id) === id);
      if (!item) return json({ info: {}, movie_data: {} });
      const info = {
    name: item.title, title: item.title, year: item.year,
    cover: item.cover, stream_icon: item.cover, icon: item.cover,
    plot: item.plot, category_id: item.category_id,
    rating: item.rating || "0", duration: item.duration || 0,
      };
      return json({ info, movie_data: item });
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  }

  if (action === "get_short_epg" || action === "get_simple_data_table") {
    return json({ epg_listings: [] });
  }

  return json({ error: "unsupported action", action });
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

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Televizo builds playback URLs itself instead of using direct_source.
    const movie = path.match(/^\/movie\/[^/]+\/[^/]+\/(\d+)\.[a-z0-9]+$/i);
    if (movie) {
      try {
        const all = await load("vod_streams.json");
        const item = all.find((x) => String(x.vod_id) === movie[1] || String(x.id) === movie[1]);
        if (!item) return new Response("not found", { status: 404, headers: CORS });
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
        return proxyStream(request, item.direct_source);
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    const episode = path.match(/^\/series\/[^/]+\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.[a-z0-9]+$/i);
    if (episode) {
      try {
        const all = await load("series_episodes.json");
        const seasons = (all[episode[1]] || {}).seasons || [];
        const season = seasons.find((s) => Number(s.season_number) === Number(episode[2]));
        const ep = (season ? season.episodes : []).find((e) => Number(e.episode_num) === Number(episode[3]));
        if (!ep) return new Response("not found", { status: 404, headers: CORS });
        return proxyStream(request, ep.url);
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

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
