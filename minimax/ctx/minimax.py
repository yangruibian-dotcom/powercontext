"""MiniMax 客户端：把「任务 + 上下文」发给模型，拿回可应用的代码补丁。

使用 MiniMax 的 OpenAI 兼容接口（可配置），不依赖任何 SDK。
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass

import httpx

BASE_URL = os.environ.get("MINIMAX_BASE_URL", "https://api.minimax.chat/v1")
API_KEY = os.environ.get("MINIMAX_API_KEY", "")
MODEL = os.environ.get("MINIMAX_MODEL", "MiniMax-Text-01")

SYSTEM = """你是一名严谨的 Python 工程师。你会收到：
1) 开发任务；2) 必须遵守的规格条目；3) 需要修改的代码；4) 验证用的测试。

请只输出**修改后的完整文件内容**，用如下格式包裹，不要输出其它解释：

```python file=相对路径
<完整文件内容>
```

要求：
- 严格满足规格条目，尤其是边界与默认值；
- 不改动无关代码，保持函数签名兼容；
- 只输出一个文件（除非任务确实需要改多个文件）。
"""


def _extract_files(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in re.finditer(r"```(?:python|py)?\s*file=([^\s`]+)\s*\n(.*?)```", text, re.S):
        out[m.group(1).strip()] = m.group(2)
    return out


@dataclass
class MiniMaxResult:
    ok: bool
    text: str
    files: dict[str, str]
    usage: dict
    latency_ms: int
    error: str | None = None


def chat(messages: list[dict], temperature: float = 0.2, retries: int = 3) -> MiniMaxResult:
    if not API_KEY:
        return MiniMaxResult(False, "", {}, {}, 0, "未设置 MINIMAX_API_KEY")

    payload = {"model": MODEL, "messages": messages, "temperature": temperature}
    last_err = ""
    for attempt in range(retries):
        t0 = time.time()
        try:
            with httpx.Client(timeout=120) as c:
                r = c.post(f"{BASE_URL}/chat/completions",
                           headers={"Authorization": f"Bearer {API_KEY}",
                                    "Content-Type": "application/json"},
                           json=payload)
            ms = int((time.time() - t0) * 1000)
            data = r.json()
            if r.status_code != 200:
                last_err = f"HTTP {r.status_code}: {json.dumps(data, ensure_ascii=False)[:300]}"
            else:
                # 兼容 OpenAI 结构与 MiniMax 原生结构
                choices = data.get("choices") or []
                text = ""
                if choices:
                    text = (choices[0].get("message") or {}).get("content") or ""
                if not text and "reply" in data:
                    text = data["reply"]
                files = _extract_files(text)
                return MiniMaxResult(True, text, files, data.get("usage", {}), ms)
        except Exception as e:  # noqa: BLE001
            last_err = f"{type(e).__name__}: {e}"
        time.sleep(1.5 * (attempt + 1))
    return MiniMaxResult(False, "", {}, {}, 0, last_err)


def request_patch(context_prompt: str) -> MiniMaxResult:
    return chat([
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": context_prompt + "\n\n请给出修改后的完整文件。"},
    ])
