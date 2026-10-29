## 开发任务
给 summarize 增加 min_amount 金额阈值过滤，注意边界（等于阈值要保留）与默认行为（None 时完全保持原样）

## 必须遵守的规格（来自 specs/）
### [specs/expense-spec.md · REQ-3 金额阈值筛选（本次新增）]
## REQ-3 金额阈值筛选（本次新增）
`summarize(expenses)` 增加可选参数 `min_amount`：

- 语义：先过滤掉 `amount < min_amount` 的条目，再按 REQ-2 汇总。
- `min_amount` 为 `None` 时行为必须与 REQ-2 完全一致（默认值，不可改变既有调用方结果）。
- `min_amount` 允许 `Decimal` 或可转成 `Decimal` 的字符串/数字；必须是有限值，且 ≥ 0。
- 边界：`amount == min_amount` 的条目**保留**（是“大于等于”而非“大于”）。
- 过滤后若无任何条目，返回空字典，不抛异常。
### [specs/expense-spec.md · REQ-5 数值精度]
## REQ-5 数值精度
金额一律使用 `Decimal`，禁止用 `float` 做累加，避免 0.1+0.2 类误差。
输出与输入的小数位保持原样，不做四舍五入。
### [specs/expense-spec.md · REQ-2 按类别汇总]
## REQ-2 按类别汇总
`summarize(expenses)` 返回 `{类别: 合计金额}`，金额为 `Decimal`，按类别名升序排列。
传入空列表时返回空字典。

## 需要修改的代码（来自 biz/）
### [biz/expense/calc.py · top_category]
def top_category(expenses: Iterable[Expense]) -> Optional[str]:
    """金额最高的类别；没有数据时返回 None。"""
    totals = summarize(expenses)
    if not totals:
        return None
    return max(totals.items(), key=lambda kv: kv[1])[0]
### [biz/expense/calc.py · summarize]
def summarize(expenses: Iterable[Expense]) -> dict[str, Decimal]:
    """按类别汇总金额，返回 {类别: 合计}，金额为 Decimal。"""
    totals: dict[str, Decimal] = {}
    for e in expenses:
        totals[e.category] = totals.get(e.category, Decimal("0")) + e.amount
    return dict(sorted(totals.items()))
### [biz/expense/calc.py · total_amount]
def total_amount(expenses: Iterable[Expense]) -> Decimal:
    return sum((e.amount for e in expenses), Decimal("0"))

## 用于验证的测试（来自 biz/tests/）
### [biz/tests/test_target.py · test_min_amount_boundary_is_inclusive]
def test_min_amount_boundary_is_inclusive():
    # amount == 6 的条目在 min_amount=6 时必须保留
    totals = summarize(parse_expenses(RECORDS), min_amount=6)
    assert totals["交通"] == Decimal("62.5")
### [biz/tests/test_target.py · test_min_amount_accepts_string_and_none]
def test_min_amount_accepts_string_and_none():
    assert summarize(parse_expenses(RECORDS), min_amount="499") == {"设备": Decimal("499")}
    assert summarize(parse_expenses(RECORDS), min_amount=None) == {
        "交通": Decimal("62.5"),
        "餐饮": Decimal("60"),
        "设备": Decimal("499"),
    }
### [biz/tests/test_target.py · test_min_amount_filters_small_items]
def test_min_amount_filters_small_items():
    totals = summarize(parse_expenses(RECORDS), min_amount=30)
    assert totals == {"交通": Decimal("56.5"), "餐饮": Decimal("38"), "设备": Decimal("499")}

## 任务进展（PowerContext 保存的状态）
- scope_id: scp_3skedme6swzyhs4ck5sq259pkp
- entries: ['[SDD-STATE][create-context] 已定位 REQ-3 / calc.summarize / test_target.py', '[create-context] 已定位 REQ-3 / calc.summarize / test_target.py，下一步交给 MiniMax']

## 文件全文（必须整体保留，只改需要改的地方）：biz/expense/calc.py
```python
"""费用报销统计：按类别汇总、按金额阈值筛选。

这是本次任务的业务工程。任务目标是：给 summarize() 增加 min_amount 过滤能力，
同时保证不传 min_amount 时的原有行为完全不变。
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, Optional


@dataclass(frozen=True)
class Expense:
    item: str
    category: str
    amount: Decimal


def parse_expenses(records: Iterable[dict]) -> list[Expense]:
    """把原始记录（dict）解析成 Expense 列表，忽略非法条目。"""
    out: list[Expense] = []
    for r in records:
        try:
            item = str(r["item"]).strip()
            category = str(r["category"]).strip()
            amount = Decimal(str(r["amount"]))
        except (KeyError, TypeError, ValueError, ArithmeticError):
            continue
        if not item or not category or amount <= 0:
            continue
        out.append(Expense(item=item, category=category, amount=amount))
    return out


def summarize(expenses: Iterable[Expense]) -> dict[str, Decimal]:
    """按类别汇总金额，返回 {类别: 合计}，金额为 Decimal。"""
    totals: dict[str, Decimal] = {}
    for e in expenses:
        totals[e.category] = totals.get(e.category, Decimal("0")) + e.amount
    return dict(sorted(totals.items()))


def top_category(expenses: Iterable[Expense]) -> Optional[str]:
    """金额最高的类别；没有数据时返回 None。"""
    totals = summarize(expenses)
    if not totals:
        return None
    return max(totals.items(), key=lambda kv: kv[1])[0]


def total_amount(expenses: Iterable[Expense]) -> Decimal:
    return sum((e.amount for e in expenses), Decimal("0"))

```