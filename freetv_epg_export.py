#!/usr/bin/env python3
"""Build a real XMLTV guide for all FreeTV live channels from FreeTV's API."""

import datetime as dt
import html
import json
import gzip

import requests

API = "https://web.freetv.tv/api/products/lives/programmes"
CATALOGUE = "https://web.freetv.tv/api/products/lives?platform=BROWSER"
OUT = r"C:\Users\Yoav\AppData\Local\Temp\opencode\freetv_epg.xml.gz"

s = requests.Session()
s.headers.update({"User-Agent": "Mozilla/5.0", "Accept-Language": "he-IL,he;q=0.9"})

channels = []
first = 0
while True:
    r = s.get(CATALOGUE, params={"platform": "BROWSER", "firstResult": first, "maxResults": 500}, timeout=120)
    r.raise_for_status()
    d = r.json()
    channels.extend([x for x in d["items"] if x.get("type") == "LIVE"])
    first += 500
    if first >= d["meta"]["totalCount"]:
        break
print("live channels", len(channels), flush=True)

today = dt.datetime.now(dt.timezone.utc).date()
days = [(today + dt.timedelta(days=d)).strftime("%Y-%m-%d") for d in (-1, 0, 1, 2, 3)]
print("days", days, flush=True)

def tvtime(value):
    if not value:
        return ""
    d = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return d.astimezone(dt.timezone.utc).strftime("%Y%m%d%H%M%S") + " +0000"

def clean(x):
    return html.escape(str(x or ""), quote=True)

lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator="freetv_epg_export">']
for c in channels:
    cid = f"ftv_{c['id']}.il"
    name = clean(c["title"])
    lines.append(f'  <channel id="{cid}"><display-name lang="he">{name}</display-name></channel>')

total = 0
for i, c in enumerate(channels, 1):
    cid = f"ftv_{c['id']}.il"
    seen = set()
    for day in days:
        r = s.get(API, params={"platform": "BROWSER", "since": day + "T00:00+0000", "till": day + "T23:59+0000", "limit": 500, "liveId[]": c["id"]}, timeout=90)
        if r.status_code != 200:
            continue
        for p in r.json() or []:
            pid = p.get("id")
            if pid in seen:
                continue
            seen.add(pid)
            start = tvtime(p.get("since"))
            stop = tvtime(p.get("till"))
            if not start or not stop:
                continue
            title = clean(p.get("title"))
            desc = clean(p.get("description") or p.get("lead"))
            lines.append(f'  <programme start="{start}" stop="{stop}" channel="{cid}">')
            lines.append(f'    <title lang="he">{title}</title>')
            if desc:
                lines.append(f'    <desc lang="he">{desc}</desc>')
            for g in (p.get("genres") or []):
                gname = g.get("title") if isinstance(g, dict) else g
                if gname:
                    lines.append(f'    <category lang="he">{clean(gname)}</category>')
                    break
            lines.append("  </programme>")
            total += 1
    if i % 10 == 0:
        print(f"  {i}/{len(channels)} programmes={total}", flush=True)

lines.append("</tv>")
data = "\n".join(lines).encode("utf-8")
with gzip.open(OUT, "wb") as f:
    f.write(data)
print("wrote", OUT, "programmes", total, "raw", len(data), flush=True)
