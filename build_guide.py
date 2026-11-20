"""Combine every guide the playlist needs into ONE small file (guide.xml.gz) with simple English channel ids.

IPTV apps like TiviMate handle one guide link far more reliably than a long list of links,
and some of the source guides use Hebrew ids with spaces. guide_map.json says, for each
channel: our id, and which source guide + channel id to take its listings from.
Usage: python build_guide.py guide.xml.gz
"""
import gzip, io, os, sys, json, ssl, urllib.request, datetime, collections, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_RAW = 'https://raw.githubusercontent.com/YoavR1/hot-family-epg/main/'
ctx = ssl._create_unverified_context()
cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=12)).strftime('%Y%m%d%H%M%S')

def utc14(s):
    s = s.strip(); b = datetime.datetime.strptime(s[:14], '%Y%m%d%H%M%S'); off = s[14:].strip() or '+0000'
    sign = 1 if off[0] == '+' else -1
    return (b - sign * datetime.timedelta(hours=int(off[1:3]), minutes=int(off[3:5]))).strftime('%Y%m%d%H%M%S')

def load(src):
    if src.startswith(REPO_RAW) and os.path.exists(os.path.join(HERE, src[len(REPO_RAW):])):
        data = open(os.path.join(HERE, src[len(REPO_RAW):]), 'rb').read()      # our own files: use the fresh local copy
    else:
        data = urllib.request.urlopen(urllib.request.Request(src, headers={'User-Agent': 'Mozilla/5.0'}), timeout=300, context=ctx).read()
    return gzip.decompress(data) if data[:2] == bytes([0x1f, 0x8b]) else data

MAP = json.load(open(os.path.join(HERE, 'guide_map.json'), encoding='utf-8'))
by_src = collections.defaultdict(dict)
for m in MAP: by_src[m['src']].setdefault(m['src_id'], []).append(m['id'])

out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'guide.xml.gz')
old = collections.defaultdict(list)               # previous guide, used if a source is down this time
try:
    for p in ET.fromstring(gzip.decompress(open(out_path, 'rb').read())).findall('programme'):
        if utc14(p.get('stop')) > cutoff: old[p.get('channel')].append(p)
except Exception:
    pass

tv = ET.Element('tv', {'generator-info-name': 'build_guide.py'})
for m in MAP:
    c = ET.SubElement(tv, 'channel', {'id': m['id']}); ET.SubElement(c, 'display-name').text = m['name']
progs = collections.defaultdict(list)
for src, wanted in by_src.items():
    try:
        data = load(src)
    except Exception as e:
        print('could not load', src, e); continue
    for ev, el in ET.iterparse(io.BytesIO(data)):
        if el.tag == 'programme':
            ids = wanted.get(el.get('channel'))
            if ids:
                try:
                    keep = utc14(el.get('stop')) > cutoff
                except Exception:
                    keep = False
                if keep:
                    for our in ids:
                        p = ET.fromstring(ET.tostring(el)); p.set('channel', our); progs[our].append(p)
            el.clear()
        elif el.tag == 'channel':
            el.clear()
empty = []
for m in MAP:
    lst = progs.get(m['id']) or old.get(m['id'], [])
    if not progs.get(m['id']): empty.append(m['name'] + (' (kept old)' if lst else ''))
    seen = set()
    for p in sorted(lst, key=lambda p: p.get('start')):
        if p.get('start') in seen: continue
        seen.add(p.get('start')); tv.append(p)
raw = ET.tostring(tv, encoding='utf-8', xml_declaration=True)
with gzip.GzipFile(out_path, 'wb', mtime=0) as f: f.write(raw)
print(f'{len(MAP)} channels, {sum(1 for _ in tv.iter("programme"))} programmes, {os.path.getsize(out_path)//1024} KB')
print('no fresh listings:', empty)
