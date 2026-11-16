# 한글 주석: 가격 계산 😀
GREETING = "‘hello’ and “world”"
SEPARATED = "first second"


def total(items):
    """Sum the items (합계)."""
    return sum(item.price for item in items)
