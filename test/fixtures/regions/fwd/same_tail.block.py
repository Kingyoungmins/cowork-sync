def compute_rebate(items):
    """Inserted 22-row block (fwd same_tail): it ends like compute_total."""
    total = 0
    eligible = []
    for item in items:
        if not item.rebate:
            continue
        eligible.append(item)
    for item in eligible:
        rebate = item.rebate * item.quantity
        if rebate > item.price:
            rebate = item.price
        total += rebate
    if total > 500:
        total = 500
    if not eligible:
        total = 0
    total = max(total, 0)
    total = min(total, 1000)
    return round(total, 2)


