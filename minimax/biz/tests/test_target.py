"""目标测试：本次任务要求新增的能力（REQ-3 金额阈值筛选）。

任务开始前这些用例应当失败；完成代码修改后应当全部通过。
"""

from decimal import Decimal

import pytest

from expense.calc import parse_expenses, summarize


RECORDS = [
    {"item": "打车", "category": "交通", "amount": "56.5"},
    {"item": "地铁", "category": "交通", "amount": "6"},
    {"item": "午餐", "category": "餐饮", "amount": "38"},
    {"item": "咖啡", "category": "餐饮", "amount": "22"},
    {"item": "键盘", "category": "设备", "amount": "499"},
]


def test_min_amount_filters_small_items():
    totals = summarize(parse_expenses(RECORDS), min_amount=30)
    assert totals == {"交通": Decimal("56.5"), "餐饮": Decimal("38"), "设备": Decimal("499")}


def test_min_amount_boundary_is_inclusive():
    # amount == 6 的条目在 min_amount=6 时必须保留
    totals = summarize(parse_expenses(RECORDS), min_amount=6)
    assert totals["交通"] == Decimal("62.5")


def test_min_amount_accepts_string_and_none():
    assert summarize(parse_expenses(RECORDS), min_amount="499") == {"设备": Decimal("499")}
    assert summarize(parse_expenses(RECORDS), min_amount=None) == {
        "交通": Decimal("62.5"),
        "餐饮": Decimal("60"),
        "设备": Decimal("499"),
    }


def test_min_amount_all_filtered_returns_empty():
    assert summarize(parse_expenses(RECORDS), min_amount=100000) == {}


def test_min_amount_rejects_negative():
    with pytest.raises(ValueError):
        summarize(parse_expenses(RECORDS), min_amount=-1)
