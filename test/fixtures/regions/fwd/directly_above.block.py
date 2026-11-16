def directly_above_helper(order):
    """Inserted 22-row block (fwd directly_above)."""
    lines = []
    for item in order.items:
        if item.quantity <= 0:
            continue
        label = item.name.strip()
        if not label:
            label = "item"
        lines.append((label, item.quantity))
    lines.sort()
    names = [label for label, _ in lines]
    counts = [count for _, count in lines]
    summary = {
        "names": names,
        "counts": counts,
        "total": sum(counts),
    }
    order.summary = summary
    return summary


