"""seekdb 数据层：工程资料（规格 / 代码 / 测试）的存储与混合检索。

表结构同时具备：
  - VECTOR(384) + HNSW 向量索引（语义召回）
  - FULLTEXT(ngram) 全文索引（精确术语召回，中文必须用 ngram）
  - kind/path 等结构化字段（按资料类型过滤）
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

import pymysql

DIM = 384

DB_CONF = dict(
    host=os.environ.get("SEEKDB_HOST", "127.0.0.1"),
    port=int(os.environ.get("SEEKDB_PORT", "2881")),
    user=os.environ.get("SEEKDB_USER", "root@sys"),
    password=os.environ.get("SEEKDB_PASSWORD", ""),
    database=os.environ.get("SEEKDB_DATABASE", "sdd"),
    charset="utf8mb4",
    autocommit=True,
)

SCHEMA = [
    "CREATE DATABASE IF NOT EXISTS sdd DEFAULT CHARACTER SET utf8mb4",
    """CREATE TABLE IF NOT EXISTS sdd.artifacts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        chunk_id VARCHAR(128) NOT NULL,
        kind VARCHAR(16) NOT NULL,          -- spec / code / test
        path VARCHAR(300) NOT NULL,
        symbol VARCHAR(200) DEFAULT '',
        content TEXT NOT NULL,
        embedding VECTOR(384),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_chunk (chunk_id),
        FULLTEXT INDEX ft_content (content) WITH PARSER ngram,
        VECTOR INDEX vidx_emb (embedding) WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
    )""",
]


@dataclass
class Hit:
    chunk_id: str
    kind: str
    path: str
    symbol: str
    content: str
    score: float
    vec_rank: int | None
    ft_rank: int | None


def connect() -> pymysql.connections.Connection:
    return pymysql.connect(**DB_CONF)


def ensure_schema() -> None:
    conf = dict(DB_CONF)
    conf.pop("database", None)
    conn = pymysql.connect(**conf)
    with conn.cursor() as cur:
        for stmt in SCHEMA:
            cur.execute(stmt)
    conn.close()


def upsert(chunks: list[dict]) -> int:
    """chunks: [{chunk_id, kind, path, symbol, content, embedding}]"""
    conn = connect()
    n = 0
    with conn.cursor() as cur:
        for c in chunks:
            cur.execute(
                """INSERT INTO artifacts (chunk_id, kind, path, symbol, content, embedding)
                   VALUES (%s,%s,%s,%s,%s,%s)
                   ON DUPLICATE KEY UPDATE kind=VALUES(kind), path=VALUES(path),
                     symbol=VALUES(symbol), content=VALUES(content), embedding=VALUES(embedding)""",
                (c["chunk_id"], c["kind"], c["path"], c.get("symbol", ""), c["content"],
                 json.dumps(c["embedding"])),
            )
            n += 1
    conn.close()
    return n


def clear() -> None:
    conn = connect()
    with conn.cursor() as cur:
        cur.execute("DELETE FROM artifacts")
    conn.close()


def hybrid_search(query_text: str, query_vec: list[float], kinds: list[str] | None = None,
                  k: int = 8) -> list[Hit]:
    """一条 SQL 里做全文 + 向量两路召回，再用 RRF 融合（与 seekdb 内部完成）。"""
    kind_clause = ""
    kind_args: list = []
    if kinds:
        kind_clause = " AND kind IN (" + ",".join(["%s"] * len(kinds)) + ")"
        kind_args = list(kinds)

    sql = f"""
    WITH ft AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY MATCH(content) AGAINST(%s) DESC) AS rnk
      FROM artifacts WHERE MATCH(content) AGAINST(%s){kind_clause}
    ), vc AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY cosine_distance(embedding, %s) ASC) AS rnk
      FROM artifacts WHERE embedding IS NOT NULL{kind_clause}
    )
    SELECT a.chunk_id, a.kind, a.path, a.symbol, a.content,
           COALESCE(1.0/(60+ft.rnk),0) + COALESCE(1.0/(60+vc.rnk),0) AS score,
           vc.rnk AS vec_rank, ft.rnk AS ft_rank
    FROM artifacts a
    LEFT JOIN ft ON ft.id = a.id
    LEFT JOIN vc ON vc.id = a.id
    WHERE ft.id IS NOT NULL OR vc.id IS NOT NULL
    ORDER BY score DESC LIMIT %s
    """
    args = [query_text, query_text, *kind_args, json.dumps(query_vec), *kind_args, k]
    conn = connect()
    with conn.cursor() as cur:
        cur.execute(sql, args)
        rows = cur.fetchall()
    conn.close()
    return [
        Hit(chunk_id=r[0], kind=r[1], path=r[2], symbol=r[3] or "", content=r[4],
            score=float(r[5]), vec_rank=r[6], ft_rank=r[7])
        for r in rows
    ]
