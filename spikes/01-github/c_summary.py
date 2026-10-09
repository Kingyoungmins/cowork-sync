"""Summarise c_race.csv: classes, loser-reason categories, winner/loser latency, A/B win split."""
import csv, json, os, re
HERE = os.path.dirname(os.path.abspath(__file__))
rows = list(csv.DictReader(open(os.path.join(HERE, "c_race.csv"))))
def pct(xs, p):
    xs = sorted(xs); return round(xs[min(len(xs) - 1, int(p * len(xs)))], 3)
cls, cat, win_l, lose_l = {}, {}, [], []
for r in rows:
    cls[r["class"]] = cls.get(r["class"], 0) + 1
    c = re.sub(r"[0-9a-f]{40}", "<sha>", r["loser_reason"].split("\t")[-1] if "\t" in r["loser_reason"] else r["loser_reason"])
    c = re.sub(r"^.*?\[", "[", c)
    cat[c] = cat.get(c, 0) + 1
    for n in "AB":
        (win_l if r["winner_by_ls_remote"] == n else lose_l).append(float(r[n + "_secs"]))
S = {"rounds": len(rows), "classes": cls, "loser_reason_categories": cat,
     "wins": {n: sum(r["winner_by_ls_remote"] == n for r in rows) for n in "AB"},
     "winner_latency_s": {"p50": pct(win_l, .5), "p95": pct(win_l, .95), "max": max(win_l)},
     "loser_latency_s": {"p50": pct(lose_l, .5), "p95": pct(lose_l, .95), "max": max(lose_l)},
     "start_skew_ms_max": max(float(r["start_skew_ms"]) for r in rows)}
json.dump(S, open(os.path.join(HERE, "c_summary.json"), "w"), indent=1); print(json.dumps(S, indent=1))
