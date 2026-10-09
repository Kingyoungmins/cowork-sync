# -*- coding: utf-8 -*-
"""Q4 private-index snapshot == HEAD^{tree}, and Q5 timings.

Snapshot, as the spec does it (temp GIT_INDEX_FILE outside the clone; the real .git/index must not change):
  variant 'task'   : read-tree HEAD ; add -A ; write-tree
  variant 'engine' : read-tree HEAD ; update-index -q --refresh ; add -A ; write-tree   (01-engine line 498)
each with flags 'spec' (glossary §18 subset: attr.tree=HEAD, filter.secret.required=true, core.fsmonitor=false,
core.longpaths=true, gc.auto=0) and 'plain' (no -c flags).
Phases: 'fresh' (right after clone/setup) and 'touched' (mtime of every file under the clone bumped, contents unchanged).
3 repetitions per cell; each repetition starts with a new temp index (cold), then a second add -A on the same index (warm).
"""
import os, sys
from common import *

log = Log("q45_snapshot")
HEAD_TREE = oid("HEAD^{tree}")
SPEC = ["-c", "attr.tree=HEAD", "-c", "filter.secret.required=true", "-c", "core.fsmonitor=false",
        "-c", "core.longpaths=true", "-c", "gc.auto=0"]
FLAGS = {"spec": SPEC, "plain": []}
REPS = 3
idx = TMP / "snap.index"


def snapshot(variant, flags):
    if idx.exists():
        idx.unlink()
    env = dict(BASE_ENV, GIT_INDEX_FILE=str(idx), GIT_OPTIONAL_LOCKS="0")
    t = {}
    rc, _, err, t["read_tree"] = run(flags + ["read-tree", "HEAD"], env=env); assert rc == 0, redact(err)
    rc, out, _, _ = run(["ls-files"], env=env); n = len(out.splitlines())
    if variant == "engine":
        rc, _, err, t["refresh_q"] = run(flags + ["update-index", "-q", "--refresh"], env=env)
    rc_add, _, err_add, t["add_A_cold"] = run(flags + ["add", "-A"], env=env)
    rc, tree, _, t["write_tree"] = run(["write-tree"], env=env)
    rc_add2, _, _, t["add_A_warm"] = run(flags + ["add", "-A"], env=env)
    rc, tree2, _, _ = run(["write-tree"], env=env)
    tree, tree2 = tree.decode().strip(), tree2.decode().strip()
    diff = []
    if tree != HEAD_TREE:
        rc, d, _, _ = run(["-c", "core.quotepath=off", "diff-tree", "-r", "--name-status", "HEAD^{tree}", tree])
        diff = d.decode("utf-8", "replace").splitlines()[:20]
    return dict(entries_after_read_tree=n, add_rc=rc_add, add_rc_warm=rc_add2, add_stderr=redact(err_add),
                tree_eq_HEAD=tree == HEAD_TREE, warm_tree_eq_HEAD=tree2 == HEAD_TREE, phantom_paths=diff,
                secs={k: round(v, 3) for k, v in t.items()})


def touch_all():
    n = 0
    for root, dirs, files in os.walk(CLONE):
        if ".git" in dirs:
            dirs.remove(".git")
        for f in files:
            fp = os.path.join(root, f); st = os.stat(fp)
            os.utime(fp, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000)); n += 1
    return n


real_before = index_fingerprint()
for phase in ("fresh", "touched"):
    if phase == "touched":
        log(event="touch_all", files_touched=touch_all())
    for variant in ("task", "engine"):
        for fname, flags in FLAGS.items():
            for rep in range(REPS):
                if phase == "touched" and rep > 0:
                    touch_all()   # every rep sees freshly touched files
                r = snapshot(variant, flags)
                log(phase=phase, variant=variant, flags=fname, rep=rep, **r)
log(event="real_index_unchanged_by_private_snapshots", value=real_before == index_fingerprint())

# Q5 single-file timings (real index; 5 reps each)
ts_add, ts_cat, ts_hash = [], [], []
for _ in range(5):
    st = os.stat(CLONE / FILTER_PATH); os.utime(CLONE / FILTER_PATH, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    rc, _, _, dt = run(SPEC + ["add", "--", FILTER_PATH]); assert rc == 0; ts_add.append(dt)
    rc, _, _, dt = run(SPEC + ["cat-file", "--filters", f"HEAD:{FILTER_PATH}"]); assert rc == 0; ts_cat.append(dt)
    rc, _, _, dt = run(SPEC + ["hash-object", f"--path={FILTER_PATH}", FILTER_PATH]); assert rc == 0; ts_hash.append(dt)
# baseline: same commands on a similar-size unfiltered file? none that large; use git --version for process overhead
ts_ver = [run(["--version"])[3] for _ in range(5)]
log(event="single_file_timings_secs", add_hub_after_touch=[round(x, 3) for x in ts_add], add_median=median(ts_add),
    catfile_filters_hub=[round(x, 3) for x in ts_cat], catfile_median=median(ts_cat),
    hash_object_path_hub=[round(x, 3) for x in ts_hash], hash_median=median(ts_hash),
    git_version_overhead_median=median(ts_ver))
rc, out, _, _ = run(["status", "--porcelain"])
log(event="final_real_status_lines", value=len(out.splitlines()))
