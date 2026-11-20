"""Build a small XMLTV file with a few Israeli channels that only exist in very large guides
(iptvx.one, epg.one), so the IPTV app does not have to download those huge files itself."""
import gzip, io, sys, ssl, urllib.request, datetime, xml.etree.ElementTree as ET

# source guide -> {channel id in that guide: (id written to our file, display name)}
SOURCES = {
    'https://iptvx.one/epg/epg.xml.gz': {
        'sport6-il': ('Sport6.il.extra', 'Sport 6'),
        'yes-plus-love-il': ('YesPlusLove.il.extra', 'Yes+ Love'),
        'yes-plus-dark-il': ('YesPlusDark.il.extra', 'Yes+ Dark'),
        'mtv-00s-il': ('MTV00s.il.extra', 'MTV 00s'),
    },
    'http://epg.one/epg.xml.gz': {
        '11375': ('HOTSenior.il.extra', 'HOT Senior'),
    },
}
ctx = ssl._create_unverified_context()
cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=12)).strftime('%Y%m%d%H%M%S')

def utc14(s):
    s = s.strip(); base = datetime.datetime.strptime(s[:14], '%Y%m%d%H%M%S'); off = s[14:].strip() or '+0000'
    sign = 1 if off[0] == '+' else -1
    return (base - sign * datetime.timedelta(hours=int(off[1:3]), minutes=int(off[3:5]))).strftime('%Y%m%d%H%M%S')

tv = ET.Element('tv', {'generator-info-name': 'extra_epg.py'})
progs = []
for url, wanted in SOURCES.items():
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    data = urllib.request.urlopen(req, timeout=300, context=ctx).read()
    if data[:2] == bytes([0x1f, 0x8b]): data = gzip.decompress(data)
    for ev, el in ET.iterparse(io.BytesIO(data)):
        if el.tag == 'programme':
            c = el.get('channel')
            if c in wanted:
                try:
                    keep = utc14(el.get('stop')) > cutoff
                except Exception:
                    keep = False
                if keep:
                    el.set('channel', wanted[c][0]); progs.append(el)
                    continue
            el.clear()
        elif el.tag == 'channel':
            el.clear()
for url, wanted in SOURCES.items():
    for _, (cid, name) in wanted.items():
        ch = ET.SubElement(tv, 'channel', {'id': cid}); ET.SubElement(ch, 'display-name').text = name
for p in progs: tv.append(p)
ET.ElementTree(tv).write(sys.argv[1], encoding='utf-8', xml_declaration=True)
print(len(progs), 'programmes written')
