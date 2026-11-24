"""Extract only the Israeli TV.Team channels we need from the huge epg.team guide.

The provider feed is hundreds of MB, so build_guide.py should not download it on
its own. This script streams it once, keeps the requested channel ids, and writes
a small XMLTV file. The generated file is committed and used by build_guide.py.

Fresh rows win where they overlap. Non-overlapping rows from the previous run are
kept so a sparse upstream refresh cannot erase valid catch-up listings.

Usage: python tvteam_epg.py tvteam.xml
"""
import datetime as dt
import gzip
import io
import os
import ssl
import sys
import urllib.request
import xml.etree.ElementTree as ET

URL = 'https://epg.team/3.1.xml'
WANTED = {
    'ch1153': 'TVTeamHotCinemaFamily.il',
    'ch2613': 'TVTeamHotSenior.il',
    'ch2614': 'TVTeamHotBuzz.il',
    'ch2499': 'TVTeamCellcomIsrael.il',
    'ch4051': 'TVTeamArutzHagiborim.il',
    'ch4054': 'TVTeamArutzPeshaAmiti.il',
}
NAMES = {
    'TVTeamHotCinemaFamily.il': 'HOT Cinema Family HD IL',
    'TVTeamHotSenior.il': 'HOT Senior',
    'TVTeamHotBuzz.il': 'HOT Buzz',
    'TVTeamCellcomIsrael.il': 'Cellcom Israel',
    'TVTeamArutzHagiborim.il': 'Arutz Hagiborim',
    'TVTeamArutzPeshaAmiti.il': 'Arutz Pesha Amiti (True Crime)',
}
KEEP_DAYS = 7

ctx = ssl._create_unverified_context()
req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0'})
data = urllib.request.urlopen(req, timeout=600, context=ctx).read()
if data[:2] == bytes([0x1f, 0x8b]):
    data = gzip.decompress(data)


def utc14(s):
    s = s.strip()
    base = dt.datetime.strptime(s[:14], '%Y%m%d%H%M%S')
    off = s[14:].strip() or '+0000'
    sign = 1 if off[0] == '+' else -1
    delta = dt.timedelta(hours=int(off[1:3]), minutes=int(off[3:5]))
    return (base - sign * delta).strftime('%Y%m%d%H%M%S')


path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tvteam.xml')
out = ET.Element('tv', {'generator-info-name': 'tvteam_epg.py', 'generator-info-url': URL})
for our, name in NAMES.items():
    ch = ET.SubElement(out, 'channel', {'id': our})
    ET.SubElement(ch, 'display-name').text = name

fresh = []
fresh_ranges = {our: [] for our in NAMES}
for _, el in ET.iterparse(io.BytesIO(data), events=('end',)):
    if el.tag != 'programme':
        continue
    src = el.get('channel')
    our = WANTED.get(src)
    if our:
        p = ET.fromstring(ET.tostring(el))
        p.set('channel', our)
        fresh.append(p)
        fresh_ranges[our].append((utc14(p.get('start')), utc14(p.get('stop'))))
    el.clear()

cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=KEEP_DAYS)).strftime('%Y%m%d%H%M%S')
old_rows = []
try:
    for p in ET.parse(path).getroot().findall('programme'):
        our = p.get('channel')
        if our not in NAMES:
            continue
        try:
            start = utc14(p.get('start'))
            stop = utc14(p.get('stop'))
        except Exception:
            continue
        if stop <= cutoff:
            continue
        if any(start < f_stop and stop > f_start for f_start, f_stop in fresh_ranges[our]):
            continue
        old_rows.append((our, start, p))
except Exception as e:
    print('could not merge previous tvteam.xml:', e)

old_rows.sort(key=lambda row: (row[0], row[1]))
seen = set()
for our, start, p in old_rows:
    key = (our, start)
    if key in seen:
        continue
    seen.add(key)
    out.append(p)
for p in fresh:
    key = (p.get('channel'), utc14(p.get('start')))
    if key in seen:
        continue
    seen.add(key)
    out.append(p)

ET.ElementTree(out).write(path, encoding='utf-8', xml_declaration=True)
final_count = {}
for p in out.findall('programme'):
    ch = p.get('channel')
    final_count[ch] = final_count.get(ch, 0) + 1
for our in NAMES:
    print(f'{our:32} {final_count.get(our, 0)} programmes')
