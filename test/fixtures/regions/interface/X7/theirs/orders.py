from lib import foo


def subtotal(lines):
    total = 0
    for price, qty in lines:
        total += foo(price, qty)
    return total


def checkout(order):
    price = order.price
    qty = order.quantity
    total = foo(price, qty)
    return round(subtotal(order.lines) + total, 2)


def describe(order):
    return f"order {order.id}"
