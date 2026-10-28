"""按 backend/schema.sql 在 seekdb 里建库建表。"""

import os
import pathlib
import pymysql

HERE = pathlib.Path(__file__).resolve().parent
SCHEMA = HERE.parent / "backend" / "schema.sql"

conn = pymysql.connect(
    host=os.getenv("SEEKDB_HOST", "127.0.0.1"),
    port=int(os.getenv("SEEKDB_PORT", "2881")),
    user=os.getenv("SEEKDB_USER", "root@sys"),
    password=os.getenv("SEEKDB_PASSWORD", ""),
    charset="utf8mb4",
    autocommit=True,
)
cur = conn.cursor()
cur.execute("SELECT VERSION()")
print("seekdb:", cur.fetchone()[0])

body = "\n".join(l for l in SCHEMA.read_text(encoding="utf-8").splitlines() if not l.strip().startswith("--"))
for stmt in [s.strip() for s in body.split(";") if s.strip()]:
    cur.execute(stmt)
    print("OK:", stmt.split("(")[0].strip())

cur.execute("SHOW CREATE TABLE tavern.memory")
for line in cur.fetchone()[1].splitlines():
    if "FULLTEXT" in line:
        print("index:", line.strip())
conn.close()
