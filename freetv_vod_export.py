#!/usr/bin/env python3
"""Export FreeTV's VOD catalogue (movies + series episodes) to M3U/JSON.

Discovery is done through FreeTV's own public player API:
  /api/products/vods                 catalogue (paged, 500 max)
  /api/products/vods/serials/<id>/seasons
  /api/products/vods/serials/<id>/seasons/<season>/episodes
  /api/products/<id>/videos/playlist?videoType=MOVIE&platform=BROWSER

The returned HLS sources are open (tokenInPath=false) and playable directly.
Set FREETV_COOKIE to a cookie from your own logged-in browser session if the
service later gates playback.

Usage:
  python freetv_vod_export.py --movies          # 4,955 movies
  python freetv_vod_export.py --serials         # all series episodes
  python freetv_vod_export.py --all             # both
"""

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

API = "https://web.freetv.tv/api"
FROM = "https://raw.githubusercontent.com/YoavR1/hot-family-epg/main"
CATALOGUE = f"{API}/products/vods"
PLAYLIST = f"{API}/products/{{id}}/videos/playlist"
SEASONS = f"{API}/products/vods/serials/{{id}}/seasons"
EPISODES = f"{API}/products/vods/serials/{{serial}}/seasons/{{season}}/episodes"
PAGE = 500

GROUP = {"movie": "Movies", "movies": "Movies", "series": "Series", "kids": "Kids"}


def session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0 Safari/537.36",
        "Accept-Language": "he-IL,he;q=0.9",
        "Strapi-Response-Format": "v4",
    })
    cookie = os.environ.get("FREETV_COOKIE")
    if cookie:
        s.headers["Cookie"] = cookie
    return s


def get(s, url, params=None, tries=4):
    time.sleep(0.35)
    for i in range(tries):
        try:
            r = s.get(url, params=params, timeout=60)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                return None
            if r.status_code == 403:
                # IP-level throttle from the edge. Back off hard.
                time.sleep(90 * (i + 1))
                continue
        except Exception:
            pass
        time.sleep(2 * (i + 1))
    return None


def load_json(path, default):
    if path and os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return default


def save_json(path, obj):
    if not path:
        return
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def hls(s, product_id, cache):
    key = str(product_id)
    if key in cache:
        return cache[key]
    d = get(s, PLAYLIST.format(id=product_id), {"videoType": "MOVIE", "platform": "BROWSER"})
    out = None
    if d:
        for src in (d.get("sources") or {}).get("HLS") or []:
            u = src.get("src", "")
            if u:
                out = "https:" + u if u.startswith("//") else u
                break
    cache[key] = out
    return out


def image(item, key="16x9"):
    try:
        u = item["images"][key][0]["url"]
        return "https:" + u if u.startswith("//") else u
    except Exception:
        return ""


def entry(item, url):
    title = str(item.get("title", "")).replace("\n", " ").strip()
    dur = int(item.get("duration") or -1)
    attrs = []
    logo = image(item) or image(item, "3x4")
    if logo:
        attrs.append(f'tvg-logo="{logo}"')
    cat = (item.get("mainCategory") or {}).get("slug", "")
    attrs.append(f'group-title="{GROUP.get(cat, cat.title())}"')
    year = item.get("year")
    if year:
        attrs.append(f'tvg-year="{year}"')
    head = f'#EXTINF:{dur} {" ".join(attrs)},{title}'.rstrip()
    return [head, url]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--movies", action="store_true", help="export VOD movies")
    ap.add_argument("--serials", action="store_true", help="export series episodes")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out", default="freetv_vod.m3u8")
    ap.add_argument("--catalog-out", default="")
    ap.add_argument("--cache", default="")
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()
    if not (args.movies or args.serials or args.all):
        args.movies = True

    s = session()
    cache = load_json(args.cache, {})

    print("fetching catalogue...", flush=True)
    catalogue = []
    first = 0
    while True:
        d = get(s, CATALOGUE, {"platform": "BROWSER", "firstResult": first, "maxResults": PAGE})
        if not d or not d.get("items"):
            break
        catalogue.extend(d["items"])
        total = d["meta"]["totalCount"]
        print(f"  {len(catalogue)}/{total}", flush=True)
        first += PAGE
        if first >= total:
            break

    movies = [c for c in catalogue if c.get("type") == "VOD"]
    serials = [c for c in catalogue if c.get("type") == "SERIAL"]
    print(f"movies={len(movies)} serials={len(serials)}", flush=True)

    targets = []
    if args.movies or args.all:
        targets = [(c, c["title"]) for c in movies]
    if args.serials or args.all:
        for serial in serials:
            seasons = get(s, SEASONS.format(id=serial["id"]), {"platform": "BROWSER"}) or []
            for season in seasons:
                eps = get(s, EPISODES.format(serial=serial["id"], season=season["id"]), {"platform": "BROWSER"}) or []
                for ep in eps:
                    targets.append((ep, f"{serial['title']} - {ep.get('title', ep['id'])}"))

    print(f"resolving {len(targets)} HLS sources...", flush=True)
    resolved = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(hls, s, item["id"], cache): (item, label) for item, label in targets}
        for i, fut in enumerate(as_completed(futures), 1):
            item, label = futures[fut]
            try:
                url = fut.result()
            except Exception:
                url = None
            if url:
                resolved[item["id"]] = (item, label, url)
            if i % 250 == 0:
                print(f"  {i}/{len(targets)} ok={len(resolved)}", flush=True)
                save_json(args.cache, cache)

    lines = [
        f'#EXTM3U url-tvg="{FROM}/guide.xml.gz" x-tvg-url="{FROM}/guide.xml.gz"',
        "#EXTINF:-1 group-title=\"Info\",FreeTV VOD - %d titles" % len(resolved),
    ]
    for item, label, url in sorted(resolved.values(), key=lambda x: x[1].lower()):
        shown = dict(item)
        shown["title"] = label
        lines.extend(entry(shown, url))

    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    save_json(args.cache, cache)
    if args.catalog_out:
        save_json(args.catalog_out, [
            {"title": label, "id": item["id"], "type": item.get("type"), "url": url, "year": item.get("year")}
            for item, label, url in sorted(resolved.values(), key=lambda x: x[1].lower())
        ])
    print(f"wrote {args.out}: {len(resolved)} titles", flush=True)


if __name__ == "__main__":
    main()
