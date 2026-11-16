def far_above_helper(records):
    """Inserted 22-row block (fwd far_above)."""
    out = []
    seen = set()
    for record in records:
        key = record.get("id")
        if key in seen:
            continue
        seen.add(key)
        value = record.get("value", 0)
        if value is None:
            value = 0
        out.append((key, value))
    out.sort()
    total = 0
    for _, value in out:
        total += value
    average = total / len(out) if out else 0
    result = {"count": len(out), "total": total, "average": average}
    return result


