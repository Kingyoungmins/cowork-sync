"""(b) Do pushes to custom refs trigger an 'on: push' (unfiltered) workflow? Writes b_actions.log/.json."""
import json, os, shutil, time
from common import *

HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.join(HERE, "work-b")
log = Log(os.path.join(HERE, "b_actions.log"))
R = {"pushes": {}}
WF = """name: probe
on: push
jobs:
  echo:
    runs-on: ubuntu-latest
    steps:
      - run: echo "ref=${{ github.ref }} sha=${{ github.sha }}"
"""


def P(tag, sha, dst, extra=()):
    rc, out, err, dt = push(W, ["origin", f"{sha}:{dst}", *extra])
    R["pushes"][tag] = {"sha": sha, "ref": dst, "rc": rc, "secs": round(dt, 3), "t": time.time()}
    log(tag, "rc=%d" % rc, "%.2fs" % dt, dst, sha, err.strip().replace("\n", " | "))


def runs():
    st, h, js = rest("GET", "/actions/runs?per_page=100")
    return st, [{k: r.get(k) for k in ("id", "event", "head_branch", "head_sha", "status", "conclusion",
                                      "created_at", "display_title")} for r in (js or {}).get("workflow_runs", [])]


st, before = runs()
log("runs before", st, len(before))
R["runs_before"] = before

if os.path.isdir(W):
    shutil.rmtree(W)
git(["clone", "-q", REPO_URL, W], cwd=HERE)
assert_sandbox(W)
os.makedirs(os.path.join(W, ".github", "workflows"), exist_ok=True)
open(os.path.join(W, ".github", "workflows", "probe.yml"), "w", newline="\n").write(WF)
git(["add", "-A"], cwd=W)
git(["commit", "-q", "-m", "add probe workflow (on: push, no filter)"], cwd=W)
w0 = git(["rev-parse", "HEAD"], cwd=W)[1].strip()
P("main_add_workflow", w0, "refs/heads/main")

tree = tree_of(W, w0)  # every probe commit below CONTAINS probe.yml
a = new_commit(W, [w0], "probe-a: plain commit on custom ref", base_tree=tree)
b = new_commit(W, [w0], "probe-b [skip ci] ***NO_CI***\n\nskip-checks: true", base_tree=tree)
c = new_commit(W, [w0], "probe-branch: plain commit on a normal branch", base_tree=tree)
P("probe_a_custom_ref_no_marker", a, "refs/cowork/main/probe-a")
P("probe_b_custom_ref_skip_markers", b, "refs/cowork/main/probe-b")
P("probe_branch_normal", c, "refs/heads/probe-branch")

log("waiting 180 s")
time.sleep(180)
st, after = runs()
R["runs_after_wait"] = after
by_sha = {}
for r in after:
    by_sha.setdefault(r["head_sha"], []).append(r)
for tag, p in R["pushes"].items():
    p["runs"] = by_sha.get(p["sha"], [])
    p["triggered"] = bool(p["runs"])
    log("RESULT", tag, p["ref"], "triggered=%s" % p["triggered"], [(r["event"], r["head_branch"], r["status"]) for r in p["runs"]])

# webhook proxy: repo events feed (what a push webhook would also see) -- may lag
st, h, ev = rest("GET", "/events?per_page=100")
R["events"] = [{"type": e.get("type"), "ref": (e.get("payload") or {}).get("ref"),
                "head": (e.get("payload") or {}).get("head"), "created_at": e.get("created_at")}
               for e in (ev or []) if isinstance(e, dict)]
log("events", st, R["events"])

# cleanup: remove workflow from main and from probe-branch
git(["rm", "-q", ".github/workflows/probe.yml"], cwd=W)
git(["commit", "-q", "-m", "remove probe workflow"], cwd=W)
w1 = git(["rev-parse", "HEAD"], cwd=W)[1].strip()
P("main_remove_workflow", w1, "refs/heads/main", [f"--force-with-lease=refs/heads/main:{w0}"])
c2 = new_commit(W, [c], "probe-branch: remove workflow", base_tree=tree_of(W, w1))
P("probe_branch_remove_workflow", c2, "refs/heads/probe-branch", [f"--force-with-lease=refs/heads/probe-branch:{c}"])

# verify nothing queued / in progress and total stable for >= 60 s
stable_since, last_total = None, None
for i in range(40):
    s1, _, q = rest("GET", "/actions/runs?status=queued&per_page=1")
    s2, _, ip = rest("GET", "/actions/runs?status=in_progress&per_page=1")
    s3, _, al = rest("GET", "/actions/runs?per_page=1")
    nq, nip, tot = q.get("total_count"), ip.get("total_count"), al.get("total_count")
    log("poll", i, "queued=%s in_progress=%s total=%s" % (nq, nip, tot))
    if nq == 0 and nip == 0 and tot == last_total:
        stable_since = stable_since or time.time()
        if time.time() - stable_since >= 60:
            break
    else:
        stable_since = None
    last_total = tot
    time.sleep(15)
R["final_poll"] = {"queued": nq, "in_progress": nip, "total": tot, "stable_60s": stable_since is not None}
st, final = runs()
R["runs_final"] = final
for tag, p in R["pushes"].items():
    p["runs_final"] = [r for r in final if r["head_sha"] == p["sha"]]
json.dump(R, open(os.path.join(HERE, "b_actions.json"), "w"), indent=1)
log("DONE", R["final_poll"])
