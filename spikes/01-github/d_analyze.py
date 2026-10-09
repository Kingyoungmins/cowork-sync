"""(d) follow-up: did 'failed' pushes land anyway? Are failures correlated with another worker's push in flight?
Reads d_push.csv + dresume_push.csv, re-fetches load refs. -> d_analyze.json"""
import csv, json, os, subprocess
from common import *
HERE = os.path.dirname(os.path.abspath(__file__))
rows = []
for pfx in ("d_", "dresume_"):
    for r in csv.DictReader(open(os.path.join(HERE, pfx + "push.csv"))):
        if r["status"] in ("ok", "fail"):
            r["run"] = pfx; r["t0"] = float(r["start_t"]); r["t1"] = r["t0"] + float(r["secs"]); rows.append(r)
# landed-anyway check: is the rejected commit an ancestor of the ref's current tip?
landed_anyway = []
for n in range(1, 5):
    cwd = os.path.join(HERE, f"work-d-{n}")
    git(["fetch", "-q", "origin", f"+refs/cowork/main/load-{n}:refs/remotes/origin/load-{n}"], cwd=cwd)
    for r in rows:
        if r["worker"] == str(n) and r["rc"] != "0":
            sha = r["stderr_first"].split("[remote rejected] ")[-1].split(" ")[0] if "remote rejected" in r["stderr_first"] else None
            if sha:
                rc = subprocess.run(["git", "merge-base", "--is-ancestor", sha, f"refs/remotes/origin/load-{n}"], cwd=cwd).returncode
                landed_anyway.append({"worker": n, "sha": sha, "is_ancestor_of_tip": rc == 0})
# overlap: another worker's push in flight during this push
def overlapped(r):
    return any(o is not r and o["run"] == r["run"] and o["worker"] != r["worker"] and o["t0"] < r["t1"] and r["t0"] < o["t1"] for o in rows)
tab = {}
for r in rows:
    k = (r["run"], r["stage"], "overlap" if overlapped(r) else "alone")
    a = tab.setdefault("%s stage%s %s" % k, [0, 0]); a[0] += 1; a[1] += r["rc"] != "0"
S = {"pushes_by_overlap": {k: {"pushes": v[0], "failed": v[1]} for k, v in sorted(tab.items())},
     "failed_landed_anyway": landed_anyway,
     "n_failed": sum(r["rc"] != "0" for r in rows), "n_failed_landed": sum(x["is_ancestor_of_tip"] for x in landed_anyway)}
json.dump(S, open(os.path.join(HERE, "d_analyze.json"), "w"), indent=1); print(json.dumps(S, indent=1))
