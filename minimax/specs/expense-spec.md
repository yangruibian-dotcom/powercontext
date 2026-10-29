# 费用报销统计模块 · 规格

> 本文件是「规有所依」任务的规格来源。上下文模块会把每一条二级标题切成一个可检索的规格条目。

## REQ-1 输入解析

`parse_expenses(records)` 接收原始记录列表，每条形如
`{"item": str, "category": str, "amount": str|number}`。

必须跳过：缺少字段、字段为空、金额无法转成 `Decimal`、金额 ≤ 0 的条目。
合法条目返回 `Expense` 列表，`amount` 一律为 `Decimal`。

## REQ-2 按类别汇总

`summarize(expenses)` 返回 `{类别: 合计金额}`，金额为 `Decimal`，按类别名升序排列。
传入空列表时返回空字典。

## REQ-3 金额阈值筛选（本次新增）

`summarize(expenses)` 增加可选参数 `min_amount`：

- 语义：先过滤掉 `amount < min_amount` 的条目，再按 REQ-2 汇总。
- `min_amount` 为 `None` 时行为必须与 REQ-2 完全一致（默认值，不可改变既有调用方结果）。
- `min_amount` 允许 `Decimal` 或可转成 `Decimal` 的字符串/数字；必须是有限值，且 ≥ 0。
- 边界：`amount == min_amount` 的条目**保留**（是“大于等于”而非“大于”）。
- 过滤后若无任何条目，返回空字典，不抛异常。

## REQ-4 兼容性约束

`top_category(expenses)`、`total_amount(expenses)` 的签名与返回类型不得改变；
现有回归测试 `tests/test_regression.py` 必须全部继续通过。

## REQ-5 数值精度

金额一律使用 `Decimal`，禁止用 `float` 做累加，避免 0.1+0.2 类误差。
输出与输入的小数位保持原样，不做四舍五入。
