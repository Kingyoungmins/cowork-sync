"""Order helpers (S7 error-tree fixture)."""


def load_orders(rows):
    """Turn raw rows into order dicts."""
    return [dict(row) for row in rows]


def compute(a, b):
    """Multiply two amounts."""
    return a * b


def order_total(order):
    """Sum the lines of one order."""
    total = 0
    for line in order["lines"]:
        total += compute(line["price"], line["quantity"])
    return total


def report(orders):
    """One line per order."""
    out = []
    for order in orders:
        total = compute(order_total(order), 1
        out.append(f"{order['id']}: {total}")
    return out


def main(rows):
    """Entry point."""
    return report(load_orders(rows))
