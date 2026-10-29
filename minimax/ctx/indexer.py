"""把工程资料切成块并写入 seekdb：
  - specs/**.md     -> kind=spec（按二级标题切分）
  - biz/**.py       -> kind=code（按函数/类切分）
  - biz/tests/*.py  -> kind=test（按测试函数切分）
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

from .embedder import get_embedder
from . import store

ROOT = Path(__file__).resolve().parent.parent


def _chunk_markdown(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    parts = re.split(r"(?m)^##\s+", text)
    chunks = []
    head = parts[0].strip()
    if head:
        chunks.append({"symbol": "(文件头)", "content": head})
    for p in parts[1:]:
        lines = p.splitlines()
        if not lines:
            continue
        title = lines[0].strip()
        body = "\n".join(lines[1:]).strip()
        chunks.append({"symbol": title, "content": f"## {title}\n{body}".strip()})
    return chunks


def _chunk_python(path: Path) -> list[dict]:
    src = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return [{"symbol": "(parse error)", "content": src[:2000]}]
    lines = src.splitlines()
    chunks = []

    header_end = min([getattr(n, "lineno", 1) for n in tree.body if hasattr(n, "lineno")] or [1])
    header = "\n".join(lines[: max(header_end - 1, 0)]).strip()
    if header:
        chunks.append({"symbol": "(imports)", "content": header})

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            start = node.lineno - 1
            end = getattr(node, "end_lineno", node.lineno)
            body = "\n".join(lines[start:end]).strip()
            kind = "test" if node.name.startswith("test_") else "code"
            chunks.append({"symbol": node.name, "content": body, "kind_override": kind})
    if not chunks:
        chunks.append({"symbol": "(module)", "content": src})
    return chunks


def collect(root: Path = ROOT) -> list[dict]:
    out: list[dict] = []
    for md in sorted((root / "specs").rglob("*.md")):
        for c in _chunk_markdown(md):
            rel = md.relative_to(root).as_posix()
            out.append({
                "chunk_id": f"spec:{rel}#{c['symbol']}",
                "kind": "spec", "path": rel, "symbol": c["symbol"], "content": c["content"],
            })
    for py in sorted((root / "biz").rglob("*.py")):
        rel = py.relative_to(root).as_posix()
        for c in _chunk_python(py):
            kind = c.get("kind_override") or ("test" if "/tests/" in f"/{rel}" else "code")
            out.append({
                "chunk_id": f"{kind}:{rel}#{c['symbol']}",
                "kind": kind, "path": rel, "symbol": c["symbol"], "content": c["content"],
            })
    return out


def index_all(rebuild: bool = False) -> dict:
    store.ensure_schema()
    if rebuild:
        store.clear()
    chunks = collect()
    emb = get_embedder()
    # 用「路径 + 符号 + 正文」一起编码，让检索更容易命中「哪个文件里的哪个函数」
    texts = [f"{c['path']} :: {c['symbol']}\n{c['content']}" for c in chunks]
    vecs = emb.encode(texts)
    for c, v in zip(chunks, vecs):
        c["embedding"] = v
    n = store.upsert(chunks)
    by_kind: dict[str, int] = {}
    for c in chunks:
        by_kind[c["kind"]] = by_kind.get(c["kind"], 0) + 1
    return {"indexed": n, "by_kind": by_kind}


if __name__ == "__main__":
    print(index_all(rebuild=True))
