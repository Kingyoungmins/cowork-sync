def compute_total(items):
    total = 0
    for item in items:
        total += item.price * item.quantity
    return round(total, 2)


def compute_tax(total, rate):
    total = total * rate
    return round(total, 2)
