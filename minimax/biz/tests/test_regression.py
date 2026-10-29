"""回归测试：这些行为在本次任务前后都必须保持不变。"""

from decimal import Decimal

from expense.calc import Expense, parse_expenses, summarize, top_category, total_amount


RECORDS = [
    {"item": "打车", "category": "交通", "amount": "56.5"},
    {"item": "地铁", "category": "交通", "amount": "6"},
    {"item": "午餐", "category": "餐饮", "amount": "38"},
    {"item": "咖啡", "category": "餐饮", "amount": "22"},
    {"item": "键盘", "category": "设备", "amount": "499"},
]


def test_parse_filters_invalid_rows():
    rows = RECORDS + [
        {"item": "", "category": "交通", "amount": "10"},
        {"item": "负数", "category": "餐饮", "amount": "-5"},
        {"category": "缺失条目"},
    ]
    parsed = parse_expenses(rows)
    assert len(parsed) == 5
    assert all(isinstance(e.amount, Decimal) for e in parsed)


def test_summarize_groups_by_category():
    totals = summarize(parse_expenses(RECORDS))
    assert totals == {
        "交通": Decimal("62.5"),
        "餐饮": Decimal("60"),
        "设备": Decimal("499"),
    }


def test_top_category_and_total():
    expenses = parse_expenses(RECORDS)
    assert top_category(expenses) == "设备"
    assert total_amount(expenses) == Decimal("621.5")


def test_empty_input():
    assert summarize([]) == {}
    assert top_category([]) is None
    assert total_amount([]) == Decimal("0")
