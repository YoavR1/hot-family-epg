"""Fetch Arutz Hagiborim listings from Partner TV's own EPG service.

The web app's GetEpg request has no channel/date body: the signed-in subscriber
session determines the returned guide. Set PARTNER_AUTH_KEY to the authKey HTTP
header value captured from a logged-in Partner TV web session.

Usage: python partner_epg.py
Output: partner.xml, mapped to ArutzHagiborim.il by guide_map.json
"""
import datetime as dt
import json
import os
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'partner.xml')
CHANNEL_ID = 'TVTeamArutzHagiborim.il'
BASE = 'https://my.partner.co.il/TV.Services/MyTvSrv.svc/SeaChange/'
METHODS = ('GetEpg', 'GetEpgMobile')
BODY = {'param': 'post data', '_keys': ['param'], '_values': ['post data']}
HEADERS = {
    'platform': 'WEB',
    'brand': 'orange',
    'category': 'TV',
    'lang': 'he-il',
    'appName': 'TV',
    'subCategory': 'EPG',
    'Content-Type': 'application/json',
    'Origin': 'https://www.partner.co.il',
    'Referer': 'https://www.partner.co.il/',
    'User-Agent': 'Mozilla/5.0',
}

try:
    from zoneinfo import ZoneInfo
    IL_TZ = ZoneInfo('Asia/Jerusalem')
except Exception:
    IL_TZ = dt.timezone(dt.timedelta(hours=3), 'IDT')


def write_xml(rows):
    root = ET.Element('tv', {'generator-info-name': 'partner_epg.py'})
    channel = ET.SubElement(root, 'channel', {'id': CHANNEL_ID})
    ET.SubElement(channel, 'display-name').text = 'Arutz Hagiborim'
    for start, end, title, desc in sorted(rows, key=lambda r: r[0]):
        programme = ET.SubElement(root, 'programme', {
            'start': start.strftime('%Y%m%d%H%M%S %z'),
            'stop': end.strftime('%Y%m%d%H%M%S %z'),
            'channel': CHANNEL_ID,
        })
        ET.SubElement(programme, 'title', {'lang': 'he'}).text = title
        if desc:
            ET.SubElement(programme, 'desc', {'lang': 'he'}).text = desc
    with open(OUT, 'wb') as f:
        f.write(ET.tostring(root, encoding='utf-8', xml_declaration=True))
    print(f'wrote {OUT}: {len(rows)} programme rows', flush=True)


def parse_date(value):
    if value is None or value == '':
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if number > 10_000_000_000:
            number /= 1000.0
        return dt.datetime.fromtimestamp(number, dt.timezone.utc)
    text = str(value).strip()
    match = re.search(r'/Date\((-?\d+)(?:[+-]\d+)?\)/', text)
    if match:
        return dt.datetime.fromtimestamp(int(match.group(1)) / 1000.0, dt.timezone.utc)
    if text.isdigit():
        number = int(text)
        if len(text) >= 13:
            number //= 1000
        return dt.datetime.fromtimestamp(number, dt.timezone.utc)
    try:
        parsed = dt.datetime.fromisoformat(text.replace('Z', '+00:00'))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=IL_TZ)
    except Exception:
        pass
    for fmt in (
        '%Y%m%d%H%M%S', '%Y%m%d%H%M', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M',
        '%d/%m/%Y %H:%M:%S', '%d/%m/%Y %H:%M', '%d-%m-%Y %H:%M:%S', '%d-%m-%Y %H:%M',
    ):
        try:
            return dt.datetime.strptime(text, fmt).replace(tzinfo=IL_TZ)
        except Exception:
            continue
    return None


def clean_text(value):
    if value is None:
        return ''
    if isinstance(value, dict):
        for key in ('epg', 'text', 'value', 'desc', 'description', 'shortSynopsis'):
            if value.get(key):
                return clean_text(value[key])
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return ' '.join(clean_text(v) for v in value if v)
    return re.sub(r'\s+', ' ', str(value)).strip()


def channel_marker(obj):
    if not isinstance(obj, dict):
        return ''
    parts = []
    for key in ('id', 'channelId', 'serviceId', 'channelNumber', 'name',
                'channelName', 'title', 'displayName', 'genrName'):
        value = obj.get(key)
        if isinstance(value, (str, int)):
            parts.append(str(value))
    return ' '.join(parts).lower()


def is_wanted_channel(obj):
    text = channel_marker(obj)
    if not text:
        return False
    return ('4051' in text or 'hagibor' in text or 'גיבורים' in text) and 'pesha' not in text


def iter_channels(obj, depth=0):
    if depth > 8:
        return
    if isinstance(obj, list):
        for item in obj:
            yield from iter_channels(item, depth + 1)
        return
    if not isinstance(obj, dict):
        return
    if 'events' in obj and is_wanted_channel(obj):
        yield obj
    for key in ('data', 'ChannelsDays', 'Channels', 'channels', 'channelList'):
        if key in obj:
            yield from iter_channels(obj[key], depth + 1)


def iter_events(channel):
    for key in ('events', 'Events', 'programmes', 'programs', 'Programs'):
        value = channel.get(key)
        if isinstance(value, list):
            for event in value:
                if isinstance(event, dict):
                    yield event


def row_from_event(event):
    start_value = None
    end_value = None
    for key in ('start', 'startDate', 'startTime', 'begin', 'from'):
        if event.get(key):
            start_value = event[key]
            break
    for key in ('end', 'endDate', 'endTime', 'stop', 'to'):
        if event.get(key):
            end_value = event[key]
            break
    start = parse_date(start_value)
    end = parse_date(end_value)
    if not start or not end or end <= start:
        return None
    if end - start > dt.timedelta(days=2):
        return None
    title = ''
    for key in ('name', 'title', 'eventName', 'programName'):
        title = clean_text(event.get(key))
        if title:
            break
    if not title:
        return None
    desc = ''
    for key in ('desc', 'description', 'shortSynopsis', 'synopsis'):
        desc = clean_text(event.get(key))
        if desc:
            break
    return start.astimezone(dt.timezone.utc), end.astimezone(dt.timezone.utc), title, desc


def main():
    auth_key = os.getenv('PARTNER_AUTH_KEY', '').strip()
    if not auth_key:
        write_xml([])
        print('PARTNER_AUTH_KEY is not set; wrote empty partner.xml', flush=True)
        return 0

    headers = dict(HEADERS)
    headers['authKey'] = auth_key
    unique_id = os.getenv('PARTNER_USER_UNIQUE_ID', '').strip()
    if unique_id:
        headers['userUniqueId'] = unique_id

    session = requests.Session()
    rows = []
    seen = set()
    for method in METHODS:
        url = urllib.parse.urljoin(BASE, method)
        try:
            response = session.post(url, headers=headers, json=BODY, timeout=90)
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            print(f'{method} failed: {exc!r}', flush=True)
            continue
        data = payload.get('data') if isinstance(payload, dict) else None
        count = 0
        for channel in iter_channels(data):
            for event in iter_events(channel):
                row = row_from_event(event)
                if not row:
                    continue
                key = (row[0], row[1], row[2])
                if key in seen:
                    continue
                seen.add(key)
                rows.append(row)
                count += 1
        print(f'{method}: {count} Arutz Hagiborim rows', flush=True)

    write_xml(rows)
    return 0


if __name__ == '__main__':
    sys.exit(main())
