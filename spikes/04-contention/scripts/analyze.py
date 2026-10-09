"""analyze.py <variant> [...] -- summarises raw/<variant>/*.jsonl into raw/<variant>/summary.json and prints it.
Torn-snapshot check is done here, post-run, from the tree oids the daemon logged (zero cost to the daemon):
every snapshot blob must be the LF-normalised pristine file, or that plus exactly one fixed-width marker line."""
import collections, json, math, os, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE.parent / "raw"
WORK = Path(os.environ.get("COWORK_SCRATCH_S04", HERE.parents[3] / "cowork-sync-scratch" / "s04"))   # <scratch>/s04
REPO = WORK / "repo"
ORIG = WORK / "orig_hub.py"
GIT = r"C:/Program Files/Git/mingw64/bin/git.exe"
ORIG_LF = ORIG.read_bytes().replace(b"\r\n", b"\n")
MARK = re.compile(rb"# SPIKE04 (e[1-4] |d0 ) \d{8} (inplace |atomic  |twophase|renameover)\.*\n\Z")

def load(f):
    return [json.loads(l) for l in open(f, encoding="utf-8") if l.strip()] if f.exists() else []

def pct(xs, q):
    if not xs: return None
    xs = sorted(xs); i = min(len(xs) - 1, max(0, math.ceil(q / 100 * len(xs)) - 1)); return round(xs[i], 2)

def upper95(k, n):  # exact (Clopper-Pearson) one-sided 95% upper bound, by bisection on the binomial CDF
    if n == 0: return None
    def cdf(p): return sum(math.comb(n, i) * p**i * (1 - p)**(n - i) for i in range(k + 1))
    lo, hi = k / n, 1.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if cdf(mid) > 0.05: lo = mid
        else: hi = mid
    return round(hi * 1000, 2)

def lower95(k, n):  # exact one-sided 95% lower bound
    if n == 0 or k == 0: return 0.0 if n else None
    def sf(p): return 1 - sum(math.comb(n, i) * p**i * (1 - p)**(n - i) for i in range(k))
    lo, hi = 0.0, k / n
    for _ in range(60):
        mid = (lo + hi) / 2
        if sf(mid) < 0.05: lo = mid
        else: hi = mid
    return round(lo * 1000, 2)

def torn_check(trees):
    if not trees: return {}
    q = "".join(f"{t}:hub.py\n" for t in trees)
    out = subprocess.run([GIT, "cat-file", "--batch-check"], cwd=REPO, input=q.encode(), capture_output=True, check=True).stdout.decode().splitlines()
    blob_of = {t: line.split()[0] for t, line in zip(trees, out)}
    verdict = {}
    for b in set(blob_of.values()):
        data = subprocess.run([GIT, "cat-file", "blob", b], cwd=REPO, capture_output=True, check=True).stdout
        if data == ORIG_LF: verdict[b] = "pristine"
        elif data.startswith(ORIG_LF) and MARK.match(data[len(ORIG_LF):]): verdict[b] = "valid_version"
        else: verdict[b] = f"TORN(size={len(data)})"
    return {t: verdict[blob_of[t]] for t in trees}, len(verdict)

def attribute(eds, dm, slack=2):
    """For each failed editor save, which activity overlapped its window [t, t+ms] (+-slack ms, Date.now() resolution 1 ms):
    git add / write-tree (from daemon snap records), daemon apply, or another editor's save. A failure can match several."""
    snaps = [r for r in dm if r.get("kind") == "snap"]
    wins = {"git_add": [(r["t"] - r["ms"], r["t"] - r["ms"] + r["add"]["ms"]) for r in snaps],
            "write_tree": [(r["t"] - r["wt"]["ms"], r["t"]) for r in snaps],
            "apply": [(r["t"], r["t"] + r["ms"]) for r in dm if r.get("kind") == "apply"]}
    out = collections.Counter(); total = 0
    for f in (r for r in eds if not r["ok"]):
        total += 1; a, b = f["t"] - slack, f["t"] + f["ms"] + slack
        hit = [k for k, ws in wins.items() if any(x <= b and a <= y for x, y in ws)]
        if any(o is not f and o["editor"] != f["editor"] and o["t"] <= b and a <= o["t"] + o["ms"] for o in eds): hit.append("other_editor")
        out["+".join(sorted(hit)) or "none"] += 1
    # chance baseline: fraction of wall time covered by git add windows
    return {"failures": total, "overlaps": dict(out)}

def analyze(v):
    d = RAW / v; meta = json.loads((d / "run.json").read_text())
    eds = [r for i in range(1, 5) for r in load(d / f"editor{i}.jsonl")]
    dm = load(d / "daemon.jsonl")
    s = {"variant": v, "seconds": meta["seconds"], "reader": meta["reader"], "daemon": meta["daemon"]}
    # editors
    ed = {}
    for style in ("inplace", "atomic", "all"):
        rs = [r for r in eds if style == "all" or r["style"] == style]
        fails = [r for r in rs if not r["ok"]]
        ed[style] = {"saves": len(rs), "failures": len(fails),
                     "per_1000": round(1000 * len(fails) / len(rs), 2) if rs else None,
                     "upper95_per_1000": upper95(len(fails), len(rs)), "lower95_per_1000": lower95(len(fails), len(rs)),
                     "ms_p50_ok": pct([r["ms"] for r in rs if r["ok"]], 50), "ms_p95_ok": pct([r["ms"] for r in rs if r["ok"]], 95),
                     "by_error": dict(collections.Counter(f'{r["step"]}:{r["err"]["code"]}:{r["err"]["errno"]}' for r in fails))}
    s["editors"] = ed
    if dm:
        snaps = [r for r in dm if r["kind"] == "snap"]
        s["snapshots"] = {"count": len(snaps), "add_fail": sum(r["add"]["rc"] != 0 for r in snaps),
                          "writetree_fail": sum(r["wt"]["rc"] != 0 for r in snaps),
                          "stderr_nonempty": sum(bool(r["add"]["stderr"] or r["wt"]["stderr"]) for r in snaps),
                          "stderr_samples": list({(r["add"]["stderr"] or r["wt"]["stderr"])[:200] for r in snaps if r["add"]["stderr"] or r["wt"]["stderr"]})[:5],
                          "skipped_ticks": sum(r["kind"] == "skip" for r in dm),
                          "ms_p50": pct([r["ms"] for r in snaps], 50), "ms_p95": pct([r["ms"] for r in snaps], 95),
                          "add_ms_p50": pct([r["add"]["ms"] for r in snaps], 50), "add_ms_p95": pct([r["add"]["ms"] for r in snaps], 95),
                          "late_ms_p95": pct([r["lateMs"] for r in snaps], 95)}
        tv, nblobs = torn_check(sorted({r["tree"] for r in snaps if r["tree"]}))
        s["snapshots"]["content"] = dict(collections.Counter(tv.get(r["tree"], "no_tree") for r in snaps))
        s["snapshots"]["distinct_blobs"] = nblobs
        aps = [r for r in dm if r["kind"] == "apply"]
        s["apply"] = {}
        for mode in ("twophase", "renameover"):
            rs = [r for r in aps if r["mode"] == mode]
            s["apply"][mode] = {"count": len(rs), "outcomes": dict(collections.Counter(r["outcome"] for r in rs)),
                                "attempts": dict(collections.Counter(r["attempts"] for r in rs)),
                                "retries_total": sum(r["attempts"] - 1 for r in rs),
                                "errors": dict(collections.Counter(f'{r["err"]["code"]}:{r["err"]["errno"]}' for r in rs if "err" in r)),
                                "ms_p50": pct([r["ms"] for r in rs], 50), "ms_p95": pct([r["ms"] for r in rs], 95)}
        ring = [r for r in dm if r["kind"] == "ring"]
        s["ring"] = {"old_files": len(ring), "late_writes": sum(bool(r.get("late_write")) for r in ring),
                     "unlink_errors": sum("unlink_err" in r for r in ring)}
        # time overlap of editor failures with daemon activity windows (git add+write-tree, apply), +-50 ms
        wins = [(r["t"] - r["ms"] - 50, r["t"] + 50) for r in snaps] + [(r["t"] - 50, r["t"] + r["ms"] + 50) for r in aps]
        fails = [r for r in eds if not r["ok"]]
        s["editor_failures_overlapping_daemon_activity"] = sum(any(a <= f["t"] + f["ms"] and f["t"] <= b for a, b in wins) for f in fails)
        end = [r for r in dm if r["kind"] == "end"]
        wall = end[0]["wallMs"] / 1000 if end else meta["seconds"]
        job = meta.get("job", {})
        cpu = job.get("user_s", 0) + job.get("kernel_s", 0)
        s["cpu"] = {"job_cpu_s": round(cpu, 2), "wall_s": round(wall, 1), "pct_of_one_core": round(100 * cpu / wall, 2),
                    "processes": job.get("processes"),
                    "node_only_cpu_s": round(sum(end[0]["cpu"].values()) / 1e6, 2) if end else None}
    s["failure_attribution"] = attribute(eds, dm)
    rd = load(d / "reader.jsonl")
    if rd: s["reader_log"] = rd[-1]
    s["objects_growth_MB"] = round((meta["objects_bytes_after"] - meta["objects_bytes_before"]) / 1e6, 1)
    (d / "summary.json").write_text(json.dumps(s, indent=1))
    return s

if __name__ == "__main__":
    for v in sys.argv[1:]:
        print(json.dumps(analyze(v), indent=1))
