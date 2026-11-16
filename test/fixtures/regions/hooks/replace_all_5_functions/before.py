def part_0(items):
    total = sum(item.price for item in items) * 1
    return round(total, 2)


def part_1(items):
    total = sum(item.price for item in items) * 2
    return round(total, 2)


def part_2(items):
    total = sum(item.price for item in items) * 3
    return round(total, 2)


def part_3(items):
    total = sum(item.price for item in items) * 4
    return round(total, 2)


def part_4(items):
    total = sum(item.price for item in items) * 5
    return round(total, 2)
