"""Build XMLTV for Arutz Hagiborim from DVR title-bug OCR.

The title/times in dvr_schedule.json are recovered from real channel recordings.
Usage: python dvr_epg.py
"""
import json
import os
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
CHANNEL_ID = 'TVTeamArutzHagiborim.il'
CHANNEL_NAME = 'Arutz Hagiborim'

def fmt(ts):
    core = ts.replace('-', '').replace(':', '').replace('T', '').removesuffix('Z')
    return core + ' +0000'

def main():
    schedule = json.load(open(os.path.join(HERE, 'dvr_schedule.json'), encoding='utf-8'))
    parts = ["<?xml version='1.0' encoding='utf-8'?>", '<tv generator-info-name="dvr_epg.py">']
    parts.append(f'<channel id="{CHANNEL_ID}"><display-name>{escape(CHANNEL_NAME)}</display-name></channel>')
    for item in schedule:
        title = escape(item['title'])
        desc = escape(item.get('desc', ''))
        desc_xml = f'<desc lang="he">{desc}</desc>' if desc else ''
        parts.append(
            f'<programme start="{fmt(item["start"])}" stop="{fmt(item["end"])}" channel="{CHANNEL_ID}">'
            f'<title lang="he">{title}</title>{desc_xml}</programme>'
        )
    parts.append('</tv>')
    with open(os.path.join(HERE, 'dvr.xml'), 'w', encoding='utf-8', newline='') as f:
        f.write(''.join(parts))
    print(f'dvr.xml: {len(schedule)} programmes')

if __name__ == '__main__':
    main()
