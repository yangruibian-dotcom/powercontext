"""费用报销统计：按类别汇总、按金额阈值筛选。

这是本次任务的业务工程。任务目标是：给 summarize() 增加 min_amount 过滤能力，
同时保证不传 min_amount 时的原有行为完全不变。
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, Optional, Union


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


def summarize(
    expenses: Iterable[Expense],
    min_amount: Optional[Union[Decimal, str, int, float]] = None,
) -> dict[str, Decimal]:
    """按类别汇总金额，可选保留金额大于等于 min_amount 的条目。"""
    threshold: Optional[Decimal] = None
    if min_amount is not None:
        try:
            threshold = Decimal(str(min_amount))
        except (ArithmeticError, TypeError, ValueError) as exc:
            raise ValueError("min_amount 必须是非负有限数") from exc
        if not threshold.is_finite() or threshold < 0:
            raise ValueError("min_amount 必须是非负有限数")

    totals: dict[str, Decimal] = {}
    for e in expenses:
        if threshold is not None and e.amount < threshold:
            continue
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
