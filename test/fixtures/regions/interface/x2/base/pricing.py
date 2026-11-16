def compute_price(amount):
    return round(amount * 1.2, 2)


def legacy_total(amounts):
    return sum(compute_price(a) for a in amounts)
