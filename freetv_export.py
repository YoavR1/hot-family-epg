#!/usr/bin/env python3
"""Export FreeTV's live channel catalogue into an M3U playlist.

Uses FreeTV's own public player API to discover channels and their stream
slugs, then resolves each to the CDN manifest. All channel identities and
logos come from FreeTV's CMS/API - nothing is guessed.

Usage:
    python freetv_export.py [output.m3u8]

Optional: if FreeTV later requires a logged-in session, put the cookie value
from your own browser session in FREETV_COOKIE and it will be sent on every
request.
"""

import gzip
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import requests

API = "https://web.freetv.tv/api"
CATALOGUE = f"{API}/products/lives"
PLAYLIST = f"{API}/products/{{id}}/videos/playlist"
GUIDE = "https://raw.githubusercontent.com/YoavR1/hot-family-epg/main/guide.xml.gz"

HOSTS = [
    "https://r.il.cdn-redge.media",
    "https://d1zqtf09wb8nt5.cloudfront.net",
]
MANIFEST = "/livehls/oil/freetv/live/{slug}/live.livx/playlist.m3u8"

GROUP_NAMES = {
    "news": "News", "sport": "Sports", "kids": "Kids", "movies": "Movies",
    "series": "Series", "lifestyle": "Lifestyle", "music": "Music",
    "documentary": "Documentary", "religion": "Religion", "general": "General",
}


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


def guide_ids():
    """Channel IDs already present in the published guide, for EPG mapping."""
    try:
        r = requests.get(GUIDE, timeout=180)
        data = gzip.decompress(r.content) if r.content[:2] == b"\x1f\x8b" else r.content
        return set(re.findall(rb'<channel id="([^"]+)"', data))
    except Exception:
        return set()


def stream_slug(item):
    blob = json.dumps(item, ensure_ascii=False)
    m = re.search(r"streams/oil/freetv/live/([^/]+)/live\.livx", blob)
    return m.group(1) if m else None


def logo_url(item):
    images = item.get("images") or {}
    for key in ("1x1", "16x9"):
        arr = images.get(key) or []
        if arr and arr[0].get("url"):
            u = arr[0]["url"]
            return "https:" + u if u.startswith("//") else u
    return ""


def resolve(s, slug):
    """Return the first CDN host that serves this channel's manifest."""
    path = MANIFEST.format(slug=slug)
    for host in HOSTS:
        try:
            r = s.get(host + path, timeout=20)
            if r.status_code == 200 and "#EXTM3U" in r.text:
                return host + path
        except Exception:
            continue
    return None


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "freetv_channels.m3u8"
    s = session()

    r = s.get(CATALOGUE, params={"platform": "BROWSER"}, timeout=90)
    r.raise_for_status()
    items = r.json()["items"]
    print(f"catalogue: {len(items)} channels", flush=True)

    known = guide_ids()
    print(f"guide ids: {len(known)}", flush=True)

    with ThreadPoolExecutor(max_workers=10) as ex:
        urls = list(ex.map(lambda c: resolve(s, stream_slug(c)) if stream_slug(c) else None, items))

    lines = [
        f'#EXTM3U url-tvg="{GUIDE}" x-tvg-url="{GUIDE}"',
    ]
    live = 0
    for item, url in zip(items, urls):
        if not url:
            print(f"  SKIP {item['title']} (no manifest)")
            continue
        live += 1
        cid = item["id"]
        tvg = f"ftv_{cid}.il"
        if tvg.encode() not in known:
            tvg = ""
        group = (item.get("mainCategory") or {}).get("slug", "other")
        group = GROUP_NAMES.get(group, group.title())
        name = item["title"]
        attrs = []
        if tvg:
            attrs.append(f'tvg-id="{tvg}"')
        logo = logo_url(item)
        if logo:
            attrs.append(f'tvg-logo="{logo}"')
        attrs.append(f'group-title="{group}"')
        lines.append(f"#EXTINF:-1 {' '.join(attrs)},{name}")
        lines.append(url)

    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {out_path}: {live} channels", flush=True)


if __name__ == "__main__":
    main()
