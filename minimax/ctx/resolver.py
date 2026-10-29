"""根据任务描述，从 seekdb 检索出本次开发要用的规格、代码和测试，形成上下文。"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .embedder import get_embedder
from . import store


@dataclass
class TaskContext:
    task: str
    specs: list[dict] = field(default_factory=list)
    code: list[dict] = field(default_factory=list)
    tests: list[dict] = field(default_factory=list)
    state: dict | None = None

    def as_dict(self) -> dict:
        return asdict(self)

    def to_prompt(self) -> str:
        """给 LLM 的上下文文本：每条都带真实来源（文件 + 符号）。"""
        parts = [f"## 开发任务\n{self.task}\n"]

        parts.append("## 必须遵守的规格（来自 specs/）")
        for s in self.specs:
            parts.append(f"### [{s['path']} · {s['symbol']}]\n{s['content']}")
        if not self.specs:
            parts.append("（本次任务没有检索到相关规格条目）")

        parts.append("\n## 需要修改的代码（来自 biz/）")
        for c in self.code:
            parts.append(f"### [{c['path']} · {c['symbol']}]\n{c['content']}")
        if not self.code:
            parts.append("（没有检索到相关代码）")

        parts.append("\n## 用于验证的测试（来自 biz/tests/）")
        for t in self.tests:
            parts.append(f"### [{t['path']} · {t['symbol']}]\n{t['content']}")
        if not self.tests:
            parts.append("（没有检索到相关测试）")

        if self.state:
            parts.append("\n## 任务进展（PowerContext 保存的状态）")
            for key, val in self.state.items():
                parts.append(f"- {key}: {val}")
        return "\n".join(parts)


def _pick(hits, want: int) -> list[dict]:
    out = []
    for h in hits[:want]:
        out.append({"path": h.path, "symbol": h.symbol, "score": round(h.score, 5),
                    "content": h.content, "vec_rank": h.vec_rank, "ft_rank": h.ft_rank})
    return out


def resolve(task: str, k_each: int = 3) -> TaskContext:
    """分别按 kind 检索，保证规格/代码/测试三类都能进入上下文。"""
    emb = get_embedder()
    qv = emb.encode([task])[0]

    specs = store.hybrid_search(task, qv, kinds=["spec"], k=k_each)
    code = store.hybrid_search(task, qv, kinds=["code"], k=k_each)
    tests = store.hybrid_search(task, qv, kinds=["test"], k=k_each)

    return TaskContext(task=task, specs=_pick(specs, k_each),
                       code=_pick(code, k_each), tests=_pick(tests, k_each))
