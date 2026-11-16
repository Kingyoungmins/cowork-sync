from lib import foo


def subtotal(lines):
    total = 0
    for price, qty in lines:
        total += foo((price, qty))
    return total


def checkout(order):
    price = order.price
    qty = order.quantity
    return round(subtotal(order.lines), 2)


def describe(order):
    return f"order {order.id}"
