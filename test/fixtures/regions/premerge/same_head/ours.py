import functools
from tracing import traced


# Sum the line items of an order, rounded to cents.
def compute_total(items):
    total = 0
    for item in items:
        price = item.price * item.quantity
        if item.discount:
            price -= item.discount
        total += price
    return round(total, 2)


@functools.lru_cache(maxsize=None)
@traced
def compute_vat(total):
    total = total * 0.2
    return round(total, 2)


@functools.lru_cache(maxsize=None)
@traced
def compute_tax(total, rate):
    total = total * rate
    return round(total, 2)


def compute_fee(total):
    return round(total * 0.01, 2)
