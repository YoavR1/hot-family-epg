"""Build a small XMLTV file for Israeli channels that the usual free guides don't cover.

Sources (all public, no login):
  - yes schedule API (svc.yes.co.il)        - Hebrew listings with descriptions
  - FreeTV schedule API (web.freetv.tv)      - Hebrew listings
  - epg.one big guide                        - a few channels only found there
"""
import gzip, io, os, sys, ssl, json, urllib.request, urllib.parse, datetime, xml.etree.ElementTree as ET

YES = {   # yes channelId -> (our id, name)
    'YS21': ('YesPlusLove.il.extra', 'Yes+ Love'),
    'YS22': ('YesPlusDark.il.extra', 'Yes+ Dark'),
    'YS19': ('YesPlusCinema.il.extra', 'Yes+ Cinema'),
    'YS20': ('YesPlusDiamonds.il.extra', 'Yes+ Diamonds'),
    'CN48': ('Sport6.il.extra', 'Sport 6'),
    'CN49': ('5SportMAX.il.extra', '5Sport MAX'),
    'TV37': ('MTV00s.il.extra', 'MTV 00s'),
    'TV35': ('MTV.il.extra', 'MTV'),
    'CN57': ('BamaIsraelit.il.extra', 'Bama Israelit'),
    'CN66': ('Channel16.il.extra', 'Channel 16'),
    'CN58': ('DramotYomiyot.il.extra', 'Dramot Yomiyot'),
}
FREETV = {  # FreeTV live id -> (our id, name)
    '7313888': ('FreeTVTeva.il.extra', 'Free TV Teva'),
    '7313885': ('FreeTVComedy2.il.extra', 'Free TV Comedy 2'),
}
HOT = {     # hot.net.il channelID -> (our id, name). HOT's site only answers from Israel.
    '676': ('HOTBuzz.il.extra', 'HOT Buzz'),
}
BIG = {     # large XMLTV guides: channel id -> (our id, name)
    'http://epg.one/epg.xml.gz': {'11375': ('HOTSenior.il.extra', 'HOT Senior')},
}
DAYS = 3
FREETV_DAYS = 14   # FreeTV publishes ~2 weeks ahead; it only answers from Israel, so fetch far ahead when we can
# If a source is unreachable (FreeTV and HOT block non-Israeli servers), keep the listings already in the
# previous extra.xml for that channel, so a run on GitHub never wipes data fetched earlier from Israel.
ctx = ssl._create_unverified_context()
UA = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'}
now = datetime.datetime.now(datetime.timezone.utc)

# extra channels requested by playlists, kept in sources_new.json: {'yes': {code: name}, 'hot': {...}, 'ftv': {...}}
_SN = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sources_new.json')
NEW = json.load(open(_SN, encoding='utf-8')) if os.path.exists(_SN) else {}
def merged(base, new, prefix):
    out = {}
    for code, (cid, name) in base.items(): out.setdefault(code, []).append((cid, name))
    for code, name in new.items(): out.setdefault(code, []).append((f'{prefix}_{code}.il', name))
    return out
YESM = merged(YES, NEW.get('yes', {}), 'yes')
FTVM = merged(FREETV, NEW.get('ftv', {}), 'ftv')
HOTM = merged(HOT, NEW.get('hot', {}), 'hot')

def get(url, timeout=60):
    data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout, context=ctx).read()
    return gzip.decompress(data) if data[:2] == bytes([0x1f, 0x8b]) else data

def xmltime(iso):
    d = datetime.datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(datetime.timezone.utc)
    return d.strftime('%Y%m%d%H%M%S +0000')

tv = ET.Element('tv', {'generator-info-name': 'extra_epg.py'})
channels, progs, report = [], [], {}

def add(cid, start, stop, title, desc=None, icon=None):
    p = ET.Element('programme', {'start': xmltime(start), 'stop': xmltime(stop), 'channel': cid})
    ET.SubElement(p, 'title', {'lang': 'he'}).text = title
    if desc: ET.SubElement(p, 'desc', {'lang': 'he'}).text = desc
    if icon: ET.SubElement(p, 'icon', {'src': icon})
    progs.append(p); report[cid] = report.get(cid, 0) + 1

# yes
for code, ents in YESM.items():
    for cid, name in ents: channels.append((cid, name))
    seen = set()
    for d in range(-1, DAYS):
        day = (now + datetime.timedelta(days=d)).astimezone(datetime.timezone(datetime.timedelta(hours=2))).strftime('%Y-%m-%d')
        try:
            items = json.loads(get(f'https://svc.yes.co.il/api/content/broadcast-schedule/channels/{code}?date={day}&ignorePastItems=false'))['items']
        except Exception as e:
            print('yes', code, day, e); continue
        for it in items:
            if it['id'] in seen or not it.get('starts') or not it.get('ends'): continue
            seen.add(it['id'])
            for cid, _ in ents: add(cid, it['starts'], it['ends'], it['title'], it.get('description'), it.get('imageUrl'))

# FreeTV
for live, ents in FTVM.items():
    for cid, name in ents: channels.append((cid, name))
    seen = set()
    for d in range(-1, FREETV_DAYS):
        base = (now + datetime.timedelta(days=d)).astimezone(datetime.timezone(datetime.timedelta(hours=2))).replace(hour=0, minute=0, second=0, microsecond=0)
        q = urllib.parse.urlencode({'liveId[]': live, 'since': base.strftime('%Y-%m-%dT%H:%M%z'),
                                    'till': (base + datetime.timedelta(days=1)).strftime('%Y-%m-%dT%H:%M%z'), 'lang': 'HEB', 'platform': 'BROWSER'})
        try:
            items = json.loads(get('https://web.freetv.tv/api/products/lives/programmes?' + q))
        except Exception as e:
            print('freetv', live, e); continue
        for it in items:
            if it.get('id') in seen or not it.get('since') or not it.get('till'): continue
            seen.add(it.get('id'))
            for cid, _ in ents: add(cid, it['since'], it['till'], it['title'], it.get('description') or it.get('lead'))

# HOT
IL = datetime.timezone(datetime.timedelta(hours=2))
try:
    from zoneinfo import ZoneInfo
    IL = ZoneInfo('Asia/Jerusalem')
except Exception:
    pass
for ents in HOTM.values():
    for cid, name in ents: channels.append((cid, name))
try:
    d0 = datetime.datetime.now(IL); d1 = d0 + datetime.timedelta(days=7)
    body = json.dumps({'ProgramsStartDateTime': d0.strftime('%Y/%m/%d 00:00:00'),
                       'ProgramsEndDateTime': d1.strftime('%Y/%m/%d 23:59:59')}).encode()
    req = urllib.request.Request('https://www.hot.net.il/HotCmsApiFront/api/ProgramsSchedual/GetProgramsSchedual', data=body,
                                 headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    hp = json.load(urllib.request.urlopen(req, timeout=120, context=ctx))['data']['programsDetails']
    def hiso(s): return datetime.datetime.strptime(s, '%Y/%m/%d %H:%M:%S').replace(tzinfo=IL).isoformat()
    seen = set()
    for p in sorted(hp, key=lambda p: p['programStartTime']):
        if p['channelID'] in HOTM and (p['channelID'], p['programStartTime']) not in seen:
            seen.add((p['channelID'], p['programStartTime']))
            for cid, _ in HOTM[p['channelID']]:
                add(cid, hiso(p['programStartTime']), hiso(p['programEndTime']), p['programTitle'], (p.get('synopsis') or '').strip() or None)
except Exception as e:
    print('hot', e)

# big XMLTV guides
cutoff = (now - datetime.timedelta(hours=12)).strftime('%Y%m%d%H%M%S')
def utc14(s):
    s = s.strip(); b = datetime.datetime.strptime(s[:14], '%Y%m%d%H%M%S'); off = s[14:].strip() or '+0000'
    sign = 1 if off[0] == '+' else -1
    return (b - sign * datetime.timedelta(hours=int(off[1:3]), minutes=int(off[3:5]))).strftime('%Y%m%d%H%M%S')
for url, wanted in BIG.items():
    for cid, name in wanted.values(): channels.append((cid, name))
    try:
        data = get(url, timeout=300)
    except Exception as e:
        print('big', url, e); continue
    for ev, el in ET.iterparse(io.BytesIO(data)):
        if el.tag == 'programme' and el.get('channel') in wanted:
            try:
                if utc14(el.get('stop')) > cutoff:
                    el.set('channel', wanted[el.get('channel')][0]); progs.append(el)
                    report[el.get('channel')] = report.get(el.get('channel'), 0) + 1
                    continue
            except Exception:
                pass
            el.clear()
        elif el.tag in ('programme', 'channel'):
            el.clear()

# keep earlier listings for channels whose source was unreachable this time
try:
    for p in ET.parse(sys.argv[1]).getroot().findall('programme'):
        c = p.get('channel')
        if c in {cid for cid, _ in channels} and not report.get(c) and utc14(p.get('stop')) > cutoff:
            progs.append(p); report[c + ' (kept)'] = report.get(c + ' (kept)', 0) + 1
except Exception as e:
    print('no previous file to keep from:', e)
for k in [k for k in report if k.endswith(' (kept)')]:
    report[k[:-7]] = f'{report.pop(k)} (kept from last run)'

for cid, name in channels:
    ch = ET.SubElement(tv, 'channel', {'id': cid}); ET.SubElement(ch, 'display-name').text = name
for p in progs: tv.append(p)
ET.ElementTree(tv).write(sys.argv[1], encoding='utf-8', xml_declaration=True)
for cid, _ in channels: print(f'{cid:28} {report.get(cid, 0)} programmes')
