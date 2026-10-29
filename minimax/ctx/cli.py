"""上下文模块 CLI（模块的调用入口）。

子命令：
  index    建立/重建 seekdb 索引（规格、代码、测试）
  resolve  给定任务描述，输出本次任务的开发上下文（规格/代码/测试 + 来源）
  patch    把上下文交给 MiniMax，拿回代码修改并写入文件
  state    保存/读取任务状态（PowerContext）
  test     运行目标测试与回归测试
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ctx import indexer, resolver, state  # noqa: E402
from ctx import minimax as mm  # noqa: E402


def cmd_index(args: argparse.Namespace) -> int:
    r = indexer.index_all(rebuild=not args.no_rebuild)
    print(json.dumps({"ok": True, **r}, ensure_ascii=False))
    return 0


def cmd_resolve(args: argparse.Namespace) -> int:
    c = resolver.resolve(args.task, k_each=args.k)
    if args.json:
        print(json.dumps(c.as_dict(), ensure_ascii=False, indent=2))
    else:
        print(c.to_prompt())
    return 0


def cmd_patch(args: argparse.Namespace) -> int:
    c = resolver.resolve(args.task, k_each=args.k)
    if args.with_state:
        scope = state.ensure_scope(args.scope)
        c.state = {"scope_id": scope, "entries": [e["text"] for e in state.load(scope)]}
    ctx_text = c.to_prompt()
    # 追加「要改的文件全文」：只给函数片段，模型容易自己发明 import / 丢掉同文件的其它定义
    seen = set()
    for item in c.code:
        rel = item["path"]
        if rel in seen:
            continue
        seen.add(rel)
        f = ROOT / rel
        if f.exists():
            NL = chr(10)
            body = f.read_text(encoding="utf-8")
            ctx_text += (
                NL + NL + "## 文件全文（必须整体保留，只改需要改的地方）：" + rel
                + NL + "```python" + NL + body + NL + "```"
            )
    (ROOT / "devlog").mkdir(exist_ok=True)
    (ROOT / "devlog" / "last_context.md").write_text(ctx_text, encoding="utf-8")

    res = mm.request_patch(ctx_text)
    record = {
        "ok": res.ok, "latency_ms": res.latency_ms, "usage": res.usage,
        "files": list(res.files), "error": res.error,
    }
    (ROOT / "devlog").mkdir(exist_ok=True)
    (ROOT / "devlog" / f"minimax-{int(__import__('time').time())}.md").write_text(
        "# MiniMax 调用记录\n\n```json\n" + json.dumps(record, ensure_ascii=False, indent=2)
        + "\n```\n\n## 模型回复\n\n" + res.text, encoding="utf-8")

    if not res.ok:
        print(json.dumps({"ok": False, "error": res.error}, ensure_ascii=False))
        return 1
    if not res.files:
        print(json.dumps({"ok": False, "error": "模型回复里没有解析到 file= 代码块", "text_head": res.text[:400]},
                         ensure_ascii=False))
        return 1

    for rel, content in res.files.items():
        dst = ROOT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if args.apply:
            if dst.exists():
                (ROOT / "devlog" / (dst.name + ".before")).write_text(dst.read_text(encoding="utf-8"),
                                                                      encoding="utf-8")
            dst.write_text(content, encoding="utf-8")
    print(json.dumps({"ok": True, "applied": args.apply, "files": list(res.files)}, ensure_ascii=False))
    return 0


def cmd_state(args: argparse.Namespace) -> int:
    if not state.alive():
        print(json.dumps({"ok": False, "error": "PowerContext 未启动（默认 http://127.0.0.1:8000）"},
                         ensure_ascii=False))
        return 1
    scope = state.ensure_scope(args.scope)
    if args.action == "save":
        print(json.dumps(state.save(scope, args.step, args.text, args.reason), ensure_ascii=False))
    else:
        entries = state.load(scope)
        print(json.dumps({"scope_id": scope, "entries": entries}, ensure_ascii=False, indent=2))
    return 0


def cmd_test(args: argparse.Namespace) -> int:
    cmd = [sys.executable, "-m", "pytest", "-q", *args.pytest_args]
    p = subprocess.run(cmd, cwd=ROOT / "biz")
    return p.returncode


def main() -> int:
    ap = argparse.ArgumentParser(prog="ctx", description="SDD 工程上下文模块")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("index", help="建立 seekdb 索引")
    p.add_argument("--no-rebuild", action="store_true", help="保留已有 chunk，只增量 upsert")
    p.set_defaults(func=cmd_index)

    p = sub.add_parser("resolve", help="输出任务上下文")
    p.add_argument("--task", required=True)
    p.add_argument("--k", type=int, default=3)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_resolve)

    p = sub.add_parser("patch", help="调用 MiniMax 生成代码修改")
    p.add_argument("--task", required=True)
    p.add_argument("--k", type=int, default=3)
    p.add_argument("--apply", action="store_true", help="把结果写入文件")
    p.add_argument("--with-state", action="store_true", help="把 PowerContext 里的任务状态也放进上下文")
    p.add_argument("--scope", default=None)
    p.set_defaults(func=cmd_patch)

    p = sub.add_parser("state", help="任务状态读写")
    p.add_argument("action", choices=["save", "show"])
    p.add_argument("--scope", default=None)
    p.add_argument("--step", default="progress")
    p.add_argument("--text", default="")
    p.add_argument("--reason", default=None)
    p.set_defaults(func=cmd_state)

    p = sub.add_parser("test", help="运行 pytest")
    p.add_argument("pytest_args", nargs="*", default=[])
    p.set_defaults(func=cmd_test)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
