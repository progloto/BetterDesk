#!/usr/bin/env python3
"""Check peer ID history in the database. Pass a search pattern as argument."""
import sqlite3, sys

db_path = sys.argv[1] if len(sys.argv) > 1 else '/opt/rustdesk/db_v2.sqlite3'
pattern = sys.argv[2] if len(sys.argv) > 2 else '%'

c = sqlite3.connect(db_path)
rows = c.execute("SELECT id, previous_ids, id_changed_at FROM peer WHERE id LIKE ? OR previous_ids LIKE ?", (pattern, pattern)).fetchall()
for r in rows:
    print(f"ID: {r[0]}, previous_ids: {r[1]}, changed_at: {r[2]}")
c.close()
