RATES = {"EUR": 1.0, "USD": 1.1}


def compute_price(amount, currency):
    return round(amount * 1.2 * RATES[currency], 2)
