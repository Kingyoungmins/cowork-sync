"""attribution.py <variant> -- failed editor saves by (style, error, overlapping activity), plus the chance baseline:
how many saves of each style (ok or not) overlapped a `git add` window at all. Windows from Date.now() (1 ms), +-2 ms."""
import collections, json, sys
from analyze import load, RAW
v = sys.argv[1]; d = RAW / v
eds = [r for i in range(1, 5) for r in load(d / f"editor{i}.jsonl")]; dm = load(d / "daemon.jsonl")
snaps = [r for r in dm if r["kind"] == "snap"]
add = [(r["t"] - r["ms"], r["t"] - r["ms"] + r["add"]["ms"]) for r in snaps]
wt = [(r["t"] - r["wt"]["ms"], r["t"]) for r in snaps]
wall = json.loads((d / "run.json").read_text())["seconds"] * 1e3
ov = lambda ws, a, b: any(x <= b and a <= y for x, y in ws)
fails, saves = collections.Counter(), collections.Counter()
for f in eds:
    a, b = f["t"] - 2, f["t"] + f["ms"] + 2
    in_add = ov(add, a, b); saves[f'{f["style"]} in_git_add={in_add}'] += 1
    if f["ok"]: continue
    h = [n for n, w in (("git_add", add), ("write_tree", wt)) if ov(w, a, b)]
    if any(o is not f and o["editor"] != f["editor"] and o["t"] <= b and a <= o["t"] + o["ms"] for o in eds): h.append("other_editor")
    fails[f'{f["style"]} {f["err"]["code"]} {"+".join(h) or "none"}'] += 1
res = {"git_add_duty_pct": round(100 * sum(y - x for x, y in add) / wall, 2), "write_tree_duty_pct": round(100 * sum(y - x for x, y in wt) / wall, 2),
       "saves_by_overlap": dict(saves), "failures_by_style_error_overlap": dict(fails)}
print(json.dumps(res, indent=1)); (d / "attribution.json").write_text(json.dumps(res, indent=1))
