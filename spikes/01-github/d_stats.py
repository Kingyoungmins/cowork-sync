"""Per-stage statistics for d_push.csv / d_fetch.csv -> d_stats.json (and printed table)."""
import csv, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PFX = sys.argv[1] if len(sys.argv) > 1 else "d_"
meta = json.load(open(os.path.join(HERE, PFX + "load.json")))


def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(p * len(xs)))], 3) if xs else None


rows = list(csv.DictReader(open(os.path.join(HERE, PFX + "push.csv"))))
out = {"stages": [], "total_pushes": 0}
for si, (rate, dur) in enumerate(meta["stages"], 1):
    rs = [r for r in rows if r["stage"] == str(si)]
    done = [r for r in rs if r["status"] in ("ok", "fail")]
    lat = [float(r["secs"]) for r in done]
    fails = [r for r in done if r["rc"] != "0"]
    thr = [r["stderr_first"] for r in done if any(w in r["stderr_first"].lower() for w in ("429", "rate limit", "abuse", " 5"))]
    st = {"stage": si, "target_per_min": rate, "duration_s": dur, "pushes": len(done),
          "achieved_per_min": round(len(done) / (dur / 60), 2), "skipped_late": sum(r["status"] == "skipped_late" for r in rs),
          "p50": pct(lat, .5), "p95": pct(lat, .95), "max": max(lat) if lat else None,
          "failures": len(fails), "fail_lines": sorted(set(r["stderr_first"] for r in fails))[:5], "throttle_lines": thr[:5]}
    out["stages"].append(st)
    out["total_pushes"] += len(done)
fp = os.path.join(HERE, PFX + "fetch.csv")
if os.path.exists(fp):
    fr = list(csv.DictReader(open(fp)))
    t0 = meta["t_start"]
    bounds, acc = [], 0
    for rate, dur in meta["stages"]:
        bounds.append((t0 + acc, t0 + acc + dur)); acc += dur
    out["fetch"] = []
    for si, (a, b) in enumerate(bounds, 1):
        fs = [f for f in fr if a <= float(f["start_t"]) < b]
        if not fs:
            continue
        lat = [float(f["secs"]) for f in fs]
        out["fetch"].append({"stage": si, "fetches": len(fs), "p50": pct(lat, .5), "p95": pct(lat, .95), "max": max(lat),
                             "failures": sum(f["rc"] != "0" for f in fs), "saw_new_sha": sum(f["new_sha"] == "1" for f in fs)})
out["runtime_s"] = round(meta["runtime_s"], 1)
out["stop_reason"] = meta["stop_reason"]
json.dump(out, open(os.path.join(HERE, PFX + "stats.json"), "w"), indent=1)
print(json.dumps(out, indent=1))
