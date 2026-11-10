"""Build an XMLTV guide for HOT Family from HOT's official TV guide (hot.net.il).

Usage:  python hot_family_epg.py [output.xml]
HOT's site returns about 3 days of listings, so run this at least once a day.
"""
import json, sys, ssl, urllib.request, datetime
from xml.sax.saxutils import escape

API = 'https://www.hot.net.il/HotCmsApiFront/api/ProgramsSchedual/GetProgramsSchedual'
HOT_CHANNEL = '606'            # HOT Family on HOT's site
XMLTV_ID = 'HOTFamily.il'      # must match tvg-id in the playlist
NOTICE = ('החל מה', 'מ-11.11')  # 2-minute "channel is moving" cards, folded into the previous show

try:
    from zoneinfo import ZoneInfo
    IL = ZoneInfo('Asia/Jerusalem')
except Exception:              # no tz database: fall back to Israel standard time
    IL = datetime.timezone(datetime.timedelta(hours=2))

def fetch(day):
    body = json.dumps({'ProgramsStartDateTime': day.strftime('%Y/%m/%d 00:00:00'),
                       'ProgramsEndDateTime': day.strftime('%Y/%m/%d 23:59:59')}).encode()
    req = urllib.request.Request(API, data=body, headers={'Content-Type': 'application/json',
                                                          'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60, context=ssl.create_default_context()) as r:
        return json.load(r)['data']['programsDetails']

def ts(s):
    d = datetime.datetime.strptime(s, '%Y/%m/%d %H:%M:%S').replace(tzinfo=IL)
    return d.strftime('%Y%m%d%H%M%S %z')

def main(out):
    seen, progs = set(), []
    for p in fetch(datetime.datetime.now(IL)):
        if p['channelID'] == HOT_CHANNEL and p['programStartTime'] not in seen:
            seen.add(p['programStartTime']); progs.append(p)
    progs.sort(key=lambda p: p['programStartTime'])
    clean = []
    for p in progs:
        if clean and p['programTitle'].startswith(NOTICE):
            clean[-1]['programEndTime'] = p['programEndTime']; continue
        clean.append(dict(p))
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="hot_family_epg">',
             f'  <channel id="{XMLTV_ID}"><display-name lang="he">HOT Family</display-name>'
             '<display-name lang="en">HOT Cinema Family</display-name></channel>']
    for p in clean:
        lines.append(f'  <programme channel="{XMLTV_ID}" start="{ts(p["programStartTime"])}" stop="{ts(p["programEndTime"])}">')
        lines.append(f'    <title lang="he">{escape(p["programTitle"])}</title>')
        if p.get('synopsis'):
            lines.append(f'    <desc lang="he">{escape(p["synopsis"].strip())}</desc>')
        lines.append('  </programme>')
    lines.append('</tv>')
    open(out, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines) + '\n')
    print(f'wrote {len(clean)} programmes to {out}: {clean[0]["programStartTime"]} -> {clean[-1]["programEndTime"]}')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'hot_family.xml')
