"""Recover Arutz Hagiborim listings from the channel's own DVR title bugs.

Designed for GitHub Actions. The provider token is read from playlist.m3u8, so no
secret is needed. Samples one title-bug frame every SAMPLE_MINUTES, OCRs it with
Hebrew Tesseract, groups identical titles into programme blocks, then merges the
result into dvr_schedule.json and rebuilds dvr.xml.

Usage: python dvr_ocr.py
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse

import imageio_ffmpeg
import pytesseract
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
PLAYLIST = os.path.join(HERE, 'playlist.m3u8')
SCHEDULE = os.path.join(HERE, 'dvr_schedule.json')
UA = {'User-Agent': 'Mozilla/5.0'}
SAMPLE_MINUTES = int(os.getenv('SAMPLE_MINUTES', '20'))
CHANNEL_ID = 'TVTeamArutzHagiborim.il'
ORIGIN = 'https://4.hls.gd'
# Optional proxy for local/manual recovery. The scheduled cloud job stays direct:
# Cloudflare-to-DVR returned 522 from GitHub, while direct failures finish fast.
DVR_BASE = os.getenv('DVR_BASE', '').rstrip('/')
MANIFEST_TIMEOUT = int(os.getenv('MANIFEST_TIMEOUT', '20'))
DAILY_TIMEOUT = int(os.getenv('DAILY_TIMEOUT', '45'))
SEGMENT_TIMEOUT = int(os.getenv('SEGMENT_TIMEOUT', '30'))

TITLES = {
    'A': 'גיבורי חרבות ברזל',
    'B': 'נזכור את כולם',
    'C': '"בשבילם" עם הדסה בן ארי',
    'D': 'גיבורי מערכות ישראל',
    'E': 'מנגינות של געגוע',
    'F': 'עוז 77',
}

SESSION = requests.Session()
SESSION.headers.update(UA)
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def token_from_playlist():
    text = open(PLAYLIST, encoding='utf-8', errors='replace').read()
    m = re.search(r'ch4051[^\n]*?token=([A-Za-z0-9._-]+)', text)
    if not m:
        raise RuntimeError('ch4051 token not found in playlist.m3u8')
    return m.group(1)


def dvr_url(rel, token):
    base = DVR_BASE or ORIGIN
    return f'{base}/ch4051/{rel}?token={token}'


def parse_manifest(url, text):
    entries = []
    cur = None
    for line in text.splitlines():
        if line.startswith('#EXT-X-PROGRAM-DATE-TIME:'):
            cur = dt.datetime.fromisoformat(line.split(':', 1)[1].replace('Z', '+00:00')).timestamp()
        elif line and not line.startswith('#') and cur is not None:
            entries.append([cur, None, urllib.parse.urljoin(url, line.strip())])
            cur = None
    for i, e in enumerate(entries):
        e[1] = entries[i + 1][0] if i + 1 < len(entries) else e[0] + 6.0
    return entries


def hourly_entries(day, token):
    entries = []
    failures = {}
    stubs = 0
    for hour in range(24):
        when = day + dt.timedelta(hours=hour)
        rel = f'mono-{int(when.timestamp())}-3600.m3u8'
        url = dvr_url(rel, token)
        try:
            r = SESSION.get(url, timeout=MANIFEST_TIMEOUT)
            if r.status_code != 200:
                key = f'http {r.status_code}'
                failures[key] = failures.get(key, 0) + 1
                continue
            if len(r.content) <= 1000:
                stubs += 1
                continue
            entries.extend(parse_manifest(url, r.text))
        except Exception as e:
            key = type(e).__name__
            failures[key] = failures.get(key, 0) + 1
    entries.sort(key=lambda e: e[0])
    print(
        f'{day:%Y-%m-%d}: hourly manifests: {len(entries)} segments, '
        f'{stubs} stubbed, {failures}',
        flush=True,
    )
    if len(entries) < 100:
        raise RuntimeError(f'too few hourly segments for {day:%Y-%m-%d}: {len(entries)}')
    return entries


def daily_entries(day, token):
    start = int(day.timestamp())
    url = dvr_url(f'mono-{start}-86400.m3u8', token)
    r = SESSION.get(url, timeout=DAILY_TIMEOUT)
    if r.status_code == 200 and len(r.content) > 100000:
        entries = parse_manifest(url, r.text)
        if len(entries) >= 100:
            return entries
    print(
        f'{day:%Y-%m-%d}: daily manifest stubbed (http {r.status_code}, '
        f'{len(r.content)} bytes), using hourly manifests',
        flush=True,
    )
    return hourly_entries(day, token)


def get_segment(url):
    for attempt in range(2):
        try:
            r = SESSION.get(url, timeout=SEGMENT_TIMEOUT)
            r.raise_for_status()
            if len(r.content) > 1000:
                return r.content
        except Exception:
            pass
        if attempt < 1:
            time.sleep(0.5)
    raise RuntimeError(f'could not fetch segment {url.split("?")[0]}')


def extract_frame(when, entries, out_path, tmp_dir):
    target = when.timestamp()
    chosen = None
    for start, end, url in entries:
        if start <= target < end:
            chosen = (url, target - start)
            break
    if chosen is None:
        raise RuntimeError(f'no segment for {when:%Y-%m-%dT%H:%M:%SZ}')
    url, offset = chosen
    body = get_segment(url)
    seg_path = os.path.join(tmp_dir, 'segment.ts')
    with open(seg_path, 'wb') as f:
        f.write(body)
    vf = 'crop=700:120:1200:130,scale=2100:360:flags=lanczos'
    cmd = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', seg_path,
           '-ss', f'{offset:.3f}', '-frames:v', '1', '-vf', vf, '-c:v', 'png', out_path]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if p.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) < 100:
        raise RuntimeError(p.stderr.decode('utf-8', 'replace')[:300])
    return out_path


def classify(raw):
    s = (raw or '').replace('\n', ' ')
    if re.search(r'(חרבו|ברזל)', s):
        return 'A'
    if re.search(r'(נזכו|נזכוה|נזכיר|נזכור)', s) and re.search(r'(כולם|כולב|כולו|כולה|כול)', s):
        return 'B'
    if re.search(r'(בשבילם|הדסה|בן ארי|בן ארו)', s):
        return 'C'
    if re.search(r'גיבור.*(מערכ|מעבכ|ישראל|נשראל)', s) or re.search(r'(מערכות ישראל|מערכות ושראל)', s):
        return 'D'
    if re.search(r'(מנגינות|מנגומות|געגוע|ועגוע)', s):
        return 'E'
    if re.search(r'עוז\s*77', s):
        return 'F'
    return None


def read_title(path):
    for psm in ('6', '11', '12'):
        try:
            raw = pytesseract.image_to_string(path, lang='heb', config=f'--psm {psm}')
        except Exception:
            continue
        label = classify(raw)
        if label:
            return label, raw.strip().replace('\n', ' ')[:120]
    return None, ''


def fmt(when):
    return when.strftime('%Y-%m-%dT%H:%M:%SZ')


def sample_day(day, token, tmp_dir):
    now = dt.datetime.now(dt.timezone.utc)
    end = min(day + dt.timedelta(days=1), now - dt.timedelta(minutes=SAMPLE_MINUTES))
    if end <= day:
        return [], {}
    entries = daily_entries(day, token)
    rows = []
    samples = {}
    when = day
    total = int((end - day).total_seconds() // (SAMPLE_MINUTES * 60))
    done = 0
    while when < end:
        name = f'{when:%Y%m%d_%H%M}'
        path = os.path.join(tmp_dir, name + '.png')
        try:
            extract_frame(when, entries, path, tmp_dir)
            label, raw = read_title(path)
            samples[name] = [label or '-', raw]
            if label:
                rows.append((when, label))
        except Exception as e:
            samples[name] = ['X', repr(e)[:120]]
        done += 1
        if done % 12 == 0 or done == total:
            print(f'{day:%Y-%m-%d}: sampled {done}/{total}, recognised {len(rows)}', flush=True)
        when += dt.timedelta(minutes=SAMPLE_MINUTES)
    return rows, samples


def rows_to_schedule(rows):
    step = dt.timedelta(minutes=SAMPLE_MINUTES)
    gap = step * 3
    out = []
    for when, label in sorted(rows):
        if out and out[-1]['label'] == label and when - out[-1]['last'] <= gap:
            out[-1]['last'] = when
        else:
            out.append({'label': label, 'first': when, 'last': when})
    schedule = []
    for block in out:
        schedule.append({
            'start': fmt(block['first']),
            'end': fmt(block['last'] + step),
            'title': TITLES[block['label']],
        })
    return schedule


def load_schedule():
    if not os.path.exists(SCHEDULE):
        return []
    return json.load(open(SCHEDULE, encoding='utf-8'))


def save_schedule(items):
    items = sorted(items, key=lambda x: x['start'])
    with open(SCHEDULE, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
        f.write('\n')


def main():
    token = token_from_playlist()
    now = dt.datetime.now(dt.timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    days = [today - dt.timedelta(days=1), today]
    current = load_schedule()
    cutoff = today - dt.timedelta(days=7)
    fresh = []
    sampled_ok = set()
    with tempfile.TemporaryDirectory() as tmp_dir:
        for day in days:
            try:
                rows, samples = sample_day(day, token, tmp_dir)
            except Exception as e:
                print(f'{day:%Y-%m-%d}: {e!r}', flush=True)
                continue
            if not rows:
                print(f'{day:%Y-%m-%d}: no title bugs recognised', flush=True)
                continue
            sampled_ok.add(day.date().isoformat())
            blocks = rows_to_schedule(rows)
            fresh.extend(blocks)
            counts = {}
            for b in blocks:
                counts[b['title']] = counts.get(b['title'], 0) + 1
            print(f'{day:%Y-%m-%d}: {len(rows)} title frames, {len(blocks)} blocks, {counts}', flush=True)
            sample_log = os.path.join(HERE, 'dvr_ocr_samples.json')
            try:
                old_log = json.load(open(sample_log, encoding='utf-8'))
            except Exception:
                old_log = {}
            for name, value in samples.items():
                old_log[name] = value
            with open(sample_log, 'w', encoding='utf-8', newline='\n') as f:
                json.dump({k: old_log[k] for k in sorted(old_log)[-5000:]}, f, ensure_ascii=False, indent=1)
                f.write('\n')
    fresh_ranges = []
    for item in fresh:
        fresh_ranges.append((
            dt.datetime.fromisoformat(item['start'].replace('Z', '+00:00')),
            dt.datetime.fromisoformat(item['end'].replace('Z', '+00:00')),
        ))

    def overlaps(start, end):
        return any(start < b_end and end > b_start for b_start, b_end in fresh_ranges)

    kept = []
    for item in current:
        start = dt.datetime.fromisoformat(item['start'].replace('Z', '+00:00'))
        if start < cutoff:
            continue
        if start.date().isoformat() in sampled_ok:
            end = dt.datetime.fromisoformat(item['end'].replace('Z', '+00:00'))
            if overlaps(start, end):
                continue
        kept.append(item)
    save_schedule(kept + fresh)
    print(f'dvr_schedule.json: {len(kept) + len(fresh)} programmes', flush=True)
    subprocess.run([sys.executable, os.path.join(HERE, 'dvr_epg.py')], check=True)


if __name__ == '__main__':
    main()
