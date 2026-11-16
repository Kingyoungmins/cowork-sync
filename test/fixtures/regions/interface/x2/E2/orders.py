from pricing import compute_price


def order_price(order):
    return compute_price(order.amount, order.currency)
