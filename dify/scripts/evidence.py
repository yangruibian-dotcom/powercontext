"""生成 seekdb 侧的证据：表结构、索引解析器、行数、全文检索打分。输出 UTF-8 到 stdout。"""

import pymysql

conn = pymysql.connect(host="127.0.0.1", port=2881, user="root@sys", password="", database="tavern",
                       charset="utf8mb4", autocommit=True)
cur = conn.cursor()

print("## 1. 连通性与版本")
cur.execute("SELECT VERSION()")
print("SELECT VERSION() ->", cur.fetchone()[0])

print("\n## 2. 表结构（含全文索引与解析器）")
cur.execute("SHOW CREATE TABLE memory")
ddl = cur.fetchone()[1]
for line in ddl.splitlines():
    if "FULLTEXT" in line or line.strip().startswith("CREATE TABLE") or "`session_id`" in line:
        print("   ", line.strip())

print("\n## 3. 当前记忆行数")
cur.execute("SELECT COUNT(*) FROM memory")
print("   rows =", cur.fetchone()[0])
cur.execute("SELECT id, session_id, LEFT(user_text, 24), LEFT(npc_text, 24) FROM memory ORDER BY id DESC LIMIT 5")
for row in cur.fetchall():
    print("   ", row)

print("\n## 4. 全文检索打分（ngram 中文）")
for kw in ("偷吃", "桂花酒", "蜘蛛"):
    cur.execute(
        "SELECT id, MATCH(user_text, npc_text, tags) AGAINST(%s) AS score, LEFT(user_text, 30) "
        "FROM memory WHERE MATCH(user_text, npc_text, tags) AGAINST(%s) ORDER BY score DESC LIMIT 3",
        (kw, kw),
    )
    rows = cur.fetchall()
    print(f"   MATCH ... AGAINST('{kw}') -> {len(rows)} 行")
    for r in rows:
        print(f"      id={r[0]} score={r[1]:.4f} {r[2]}")

print("\n## 5. 会话隔离（结构化过滤）")
cur.execute("SELECT session_id, COUNT(*) FROM memory GROUP BY session_id")
for row in cur.fetchall():
    print("   ", row)

conn.close()
