def directly_after_helper(items):
    """Inserted 22-row block (fwd directly_after)."""
    weight = 0.0
    heaviest = None
    for item in items:
        item_weight = item.weight * item.quantity
        weight += item_weight
        if heaviest is None:
            heaviest = item
            continue
        if item_weight > heaviest.weight:
            heaviest = item
    if heaviest is not None:
        heaviest.flag = "heaviest"
    packages = int(weight // 20) + 1
    if packages > 10:
        packages = 10
    for item in items:
        item.packages = packages
    return round(weight, 3)


