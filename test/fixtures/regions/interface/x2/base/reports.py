from pricing import compute_price, legacy_total


def report_line(order):
    return f"{order.id}: {compute_price(order.amount)}"


def report_total(orders):
    return legacy_total([o.amount for o in orders])
