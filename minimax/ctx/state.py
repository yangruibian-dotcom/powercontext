"""PowerContext 状态层：保存任务进展，并在模块重启后读回使用。

直接走 PowerContext 的 HTTP API（官方客户端是 async 的，这里用同步 httpx 更简单）：
  GET  /v1/scopes                      列出/查找 scope
  POST /v1/scopes                      新建 scope
  POST /v1/memory/remember             写入一条记忆（任务进展）
  POST /v1/memory/search               按语义检索记忆，用于重启后恢复上下文
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

import httpx

BASE_URL = os.environ.get("POWERCONTEXT_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
SCOPE_TITLE = "SDD-任务状态"
KIND = "sdd-task-state"
MARK = "SDD-STATE"


@dataclass
class TaskState:
    scope_id: str
    entries: list[dict]

    def as_dict(self) -> dict:
        return {"scope_id": self.scope_id, "entries": self.entries, "source": "PowerContext"}


def alive() -> bool:
    try:
        return httpx.get(f"{BASE_URL}/openapi.json", timeout=5).status_code == 200
    except Exception:  # noqa: BLE001
        return False


def ensure_scope(scope_id: str | None = None) -> str:
    """拿到（或创建）保存任务状态用的 scope。"""
    if scope_id:
        return scope_id
    with httpx.Client(base_url=BASE_URL, timeout=20) as c:
        r = c.get("/v1/scopes")
        if r.status_code == 200:
            for it in r.json().get("items", []):
                if it.get("title") == SCOPE_TITLE:
                    return it["scope_id"]
        r = c.post("/v1/scopes", json={
            "title": SCOPE_TITLE,
            "summary": "SDD 上下文模块的任务进展与验证结果",
            "idempotency_key": f"sdd-{uuid.uuid4().hex[:12]}",
        })
        r.raise_for_status()
        return r.json()["scope_id"]


def save(scope_id: str, step: str, text: str, reason: str | None = None) -> dict:
    with httpx.Client(base_url=BASE_URL, timeout=30) as c:
        r = c.post("/v1/memory/remember", json={
            "scope_id": scope_id,
            "kind": KIND,
            "text": f"[{MARK}][{step}] {text}",
            "reason": reason or "SDD 任务进展",
        })
    return {"saved": r.status_code in (200, 201), "status": r.status_code,
            "scope_id": scope_id, "step": step, "response": r.text[:300]}


def load(scope_id: str, query: str = MARK) -> list[dict]:
    with httpx.Client(base_url=BASE_URL, timeout=30) as c:
        r = c.post("/v1/memory/search", json={"scope_id": scope_id, "query": query, "limit": 10})
    if r.status_code != 200:
        return [{"error": f"HTTP {r.status_code}", "detail": r.text[:200]}]
    data = r.json()
    raw = data.get("hits") or data.get("items") or data.get("entries") or []
    out = []
    for it in raw:
        mem = it.get("memory") if isinstance(it, dict) else None
        if isinstance(mem, dict):
            out.append({"text": mem.get("text", ""), "kind": mem.get("kind"),
                        "score": it.get("score")})
        elif isinstance(it, dict):
            out.append({"text": it.get("text") or it.get("content") or str(it)[:200],
                        "kind": it.get("kind")})
        else:
            out.append({"text": str(it)[:200]})
    return out
