"""记忆酒馆 · seekdb 记忆服务

给 Dify Chatflow 提供两个 HTTP 接口：
  POST /memory/recall  按当前这句话，从 seekdb 里召回最相关的旧记忆
  POST /memory/write   把这一轮的玩家发言 + 老板娘反应写成一条记忆

seekdb 在这里承担「应用数据存储 + 中文全文检索」，检索结果直接决定老板娘怎么回答。
"""

import os
from contextlib import closing
from typing import Any

import pymysql
from fastapi import FastAPI
from pydantic import BaseModel, Field

DB_CONF = dict(
    host=os.getenv("SEEKDB_HOST", "127.0.0.1"),
    port=int(os.getenv("SEEKDB_PORT", "2881")),
    user=os.getenv("SEEKDB_USER", "root@sys"),
    password=os.getenv("SEEKDB_PASSWORD", ""),
    database=os.getenv("SEEKDB_DATABASE", "tavern"),
    charset="utf8mb4",
    autocommit=True,
    connect_timeout=5,
)

app = FastAPI(title="记忆酒馆 seekdb 记忆服务", version="1.0.0")


def get_conn() -> pymysql.connections.Connection:
    return pymysql.connect(**DB_CONF)


class RecallRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=64)
    query: str = Field(..., min_length=1)
    k: int = Field(4, ge=1, le=10)


class ResetRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=64)


class WriteRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=64)
    user_text: str = Field(..., min_length=1)
    npc_text: str = Field("", max_length=4000)
    tags: str = Field("", max_length=255)


@app.get("/health")
def health() -> dict[str, Any]:
    with closing(get_conn()) as conn, closing(conn.cursor()) as cur:
        cur.execute("SELECT 1")
        cur.fetchone()
        cur.execute("SELECT COUNT(*) FROM memory")
        total = cur.fetchone()[0]
    return {"ok": True, "table": "memory", "rows": total}


@app.post("/memory/recall")
def recall(req: RecallRequest) -> dict[str, Any]:
    """先走全文检索（MATCH...AGAINST, ngram 解析器），没有命中再退回最近几条。"""
    memories: list[dict[str, Any]] = []
    mode = "fulltext"
    with closing(get_conn()) as conn, closing(conn.cursor()) as cur:
        cur.execute(
            """
            SELECT user_text, npc_text,
                   MATCH(user_text, npc_text, tags) AGAINST(%s) AS score,
                   DATE_FORMAT(created_at, '%%Y-%%m-%%d %%H:%%i')
            FROM memory
            WHERE session_id = %s
              AND MATCH(user_text, npc_text, tags) AGAINST(%s)
            ORDER BY score DESC
            LIMIT %s
            """,
            (req.query, req.session_id, req.query, req.k),
        )
        for user_text, npc_text, score, created in cur.fetchall():
            memories.append(
                {
                    "text": f"玩家：{user_text}／老板娘：{npc_text or '（没吭声）'}",
                    "score": float(score),
                    "at": created,
                }
            )
        if not memories:
            mode = "recent"
            cur.execute(
                """
                SELECT user_text, npc_text, DATE_FORMAT(created_at, '%%Y-%%m-%%d %%H:%%i')
                FROM memory
                WHERE session_id = %s
                ORDER BY id DESC
                LIMIT %s
                """,
                (req.session_id, req.k),
            )
            for user_text, npc_text, created in cur.fetchall():
                memories.append(
                    {
                        "text": f"玩家：{user_text}／老板娘：{npc_text or '（没吭声）'}",
                        "score": None,
                        "at": created,
                    }
                )
    return {"mode": mode, "hits": len(memories), "memories": memories}


@app.post("/memory/reset")
def reset(req: ResetRequest) -> dict[str, Any]:
    """清掉某个会话的记忆，方便反复演示（对应验证样例里的“恢复初始状态”）。"""
    with closing(get_conn()) as conn, closing(conn.cursor()) as cur:
        cur.execute("DELETE FROM memory WHERE session_id = %s", (req.session_id,))
        removed = cur.rowcount
    return {"ok": True, "removed": removed}


@app.post("/memory/write")
def write(req: WriteRequest) -> dict[str, Any]:
    with closing(get_conn()) as conn, closing(conn.cursor()) as cur:
        cur.execute(
            "INSERT INTO memory(session_id, user_text, npc_text, tags) VALUES (%s, %s, %s, %s)",
            (req.session_id, req.user_text, req.npc_text, req.tags),
        )
        new_id = cur.lastrowid
        cur.execute("SELECT COUNT(*) FROM memory WHERE session_id = %s", (req.session_id,))
        total = cur.fetchone()[0]
    return {"ok": True, "id": new_id, "session_rows": total}
