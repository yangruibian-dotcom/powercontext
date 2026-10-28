"""本地端到端验证：建表 -> 写 3 条记忆 -> 按关键词召回，证明 seekdb 真的在起作用。

用法：先启动 backend（uvicorn main:app --port 8010），再跑本脚本。
"""

import json
import urllib.request

BASE = "http://127.0.0.1:8010"


def post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def get(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=15) as r:
        return json.loads(r.read())


SESSION = "demo-session-001"

print("== 恢复初始状态（清空本会话旧记忆） ==")
print(json.dumps(post("/memory/reset", {"session_id": SESSION}), ensure_ascii=False))

print("== 健康检查 ==")
print(json.dumps(get("/health"), ensure_ascii=False))

print("\n== 写入三轮互动 ==")
for user_text, npc_text, tags in [
    ("我把你家的招牌烤鸡偷吃了", "老板娘抄起抹布追了我三条街", "恶作剧,食物"),
    ("我夸她家的桂花酒好喝", "她摆摆手说下次多给半杯", "讨好,酒"),
    ("我在门口放了一只假蜘蛛", "她尖叫着把整坛酒泼了", "恶作剧,惊吓"),
]:
    r = post("/memory/write", {"session_id": SESSION, "user_text": user_text, "npc_text": npc_text, "tags": tags})
    print(f"write -> {r}")

print("\n== 按「偷吃」召回（全文检索） ==")
r = post("/memory/recall", {"session_id": SESSION, "query": "偷吃", "k": 4})
print(json.dumps(r, ensure_ascii=False, indent=2))

print("\n== 按「桂花酒」召回 ==")
r = post("/memory/recall", {"session_id": SESSION, "query": "桂花酒", "k": 4})
print(json.dumps(r, ensure_ascii=False, indent=2))

print("\n== 全新会话（无记忆）应回退到 recent 模式 ==")
r = post("/memory/recall", {"session_id": "brand-new-session", "query": "偷吃", "k": 3})
print(json.dumps(r, ensure_ascii=False))
