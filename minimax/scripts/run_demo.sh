#!/usr/bin/env bash
# 一键跑完整验证样例：建索引 → 输出上下文 → 改前测试 → MiniMax 修改 → 改后测试 → 状态保存/读取
set -e
cd "$(dirname "$0")/.."

echo "== 1/6 建索引"
python -m ctx.cli index

TASK="给 summarize 增加 min_amount 金额阈值过滤，注意边界与默认行为"

echo "== 2/6 输出上下文"
python -m ctx.cli resolve --task "$TASK" | head -40

echo "== 3/6 修改前测试（预期 5 failed, 4 passed）"
(cd biz && python -m pytest tests -q) || true

echo "== 4/6 交给 MiniMax 修改"
python -m ctx.cli patch --task "$TASK" --apply --with-state

echo "== 5/6 修改后测试（预期全部通过）"
(cd biz && python -m pytest tests -q)

echo "== 6/6 任务状态保存与读取"
python -m ctx.cli state save --step demo-done --text "验证样例执行完成，目标测试通过"
python -m ctx.cli state show
