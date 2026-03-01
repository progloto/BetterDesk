#!/usr/bin/env python3
"""Check hbbs API for online devices."""
import json, os, sys, urllib.request

API_KEY = os.environ.get('HBBS_API_KEY', '')
if not API_KEY:
    print('Error: HBBS_API_KEY environment variable is not set.')
    print('Usage: HBBS_API_KEY=your_key python check_hbbs_online.py')
    sys.exit(1)
URL = 'http://127.0.0.1:21114/api/peers'

req = urllib.request.Request(URL)
req.add_header('X-API-Key', API_KEY)
data = json.loads(urllib.request.urlopen(req, timeout=5).read())

total = len(data)
live = [p for p in data if p.get('live_online')]
online_field = [p for p in data if p.get('online')]

print('total peers from hbbs:', total)
print('live_online=true:', len(live))
print('online=true:', len(online_field))

if live:
    for p in live:
        print('  LIVE:', p['id'])
elif online_field:
    for p in online_field:
        print('  ONLINE:', p['id'])
else:
    print('  -> NO devices marked live_online or online!')
    statuses = set(p.get('status', '?') for p in data)
    print('  statuses found:', statuses)
    live_statuses = set(p.get('live_status', '?') for p in data)
    print('  live_statuses found:', live_statuses)
