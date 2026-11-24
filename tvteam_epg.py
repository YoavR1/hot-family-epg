"""Extract only the Israeli TV.Team channels we need from the huge epg.team guide.

The provider feed is hundreds of MB, so build_guide.py should not download it on
its own. This script streams it once, keeps the requested channel ids, and writes
a small XMLTV file. The generated file is committed and used by build_guide.py.

Usage: python tvteam_epg.py tvteam.xml
"""
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

ctx = ssl._create_unverified_context()
req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0'})
data = urllib.request.urlopen(req, timeout=600, context=ctx).read()
if data[:2] == bytes([0x1f, 0x8b]):
    data = gzip.decompress(data)

out = ET.Element('tv', {'generator-info-name': 'tvteam_epg.py', 'generator-info-url': URL})
for our, name in NAMES.items():
    ch = ET.SubElement(out, 'channel', {'id': our})
    ET.SubElement(ch, 'display-name').text = name

count = {}
for _, el in ET.iterparse(io.BytesIO(data), events=('end',)):
    if el.tag != 'programme':
        continue
    src = el.get('channel')
    our = WANTED.get(src)
    if our:
        p = ET.fromstring(ET.tostring(el))
        p.set('channel', our)
        out.append(p)
        count[our] = count.get(our, 0) + 1
    el.clear()

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tvteam.xml')
ET.ElementTree(out).write(path, encoding='utf-8', xml_declaration=True)
for our in NAMES:
    print(f'{our:32} {count.get(our, 0)} programmes')
