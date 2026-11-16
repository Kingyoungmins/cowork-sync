from pricing import compute_price


def report_line(order):
    return f"{order.id}: {compute_price(order.amount, order.currency)}"


def report_total(orders):
    return sum(compute_price(o.amount, o.currency) for o in orders)
