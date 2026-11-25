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
  const r = await fetch(BASE + name + "?v=2", { cf: { cacheTtl: 1800, cacheEverything: true } });
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
  return {
    username: url.searchParams.get("username") || "freetv",
    password: url.searchParams.get("password") || "freetv",
    message: "",
    auth: "1",
    status: "Active",
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
  if (!action) return json({ userinfo: userinfo(url), server_info: serverinfo(url) });

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

  if (action === "get_info" || action === "get_info_vod") {
    const id = String(url.searchParams.get("vod_id") || "");
    try {
      const all = await load("vod_streams.json");
      const item = all.find((x) => String(x.vod_id) === id);
      return json(item ? { info: item, movie_data: item } : { info: {}, movie_data: {} });
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  }

  if (action === "get_short_epg" || action === "get_simple_data_table") {
    return json({ epg_listings: [] });
  }

  return json({ error: "unsupported action", action });
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
