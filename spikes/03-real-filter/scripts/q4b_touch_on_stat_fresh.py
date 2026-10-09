# -*- coding: utf-8 -*-
"""Q4b: a stat-fresh private index (as the daemon keeps it), then mtime of every file bumped, then add -A + write-tree.
This is the case where git must re-read+re-filter every file because stat data no longer matches. 3 reps.
Also: the real index (status / add -A) after touching everything."""
from common import *


log = Log("q4b_touch_on_stat_fresh")
HEAD_TREE = oid("HEAD^{tree}")
idx = TMP / "snap_b.index"
env = dict(BASE_ENV, GIT_INDEX_FILE=str(idx), GIT_OPTIONAL_LOCKS="0")
if idx.exists():
    idx.unlink()
run(SPEC + ["read-tree", "HEAD"], env=env)
rc, _, _, t0 = run(SPEC + ["add", "-A"], env=env)
log(step="seed_add_A", rc=rc, secs=round(t0, 3))
for rep in range(3):
    n = touch_all()
    rc, _, err, t = run(SPEC + ["add", "-A"], env=env)
    rc2, tree, _, _ = run(["write-tree"], env=env)
    log(step="touch_all_then_add_A", rep=rep, files_touched=n, rc=rc, secs=round(t, 3),
        tree_eq_HEAD=tree.decode().strip() == HEAD_TREE, stderr=redact(err))
# real index: touch all, then status (refresh) and add -A
real_before = index_fingerprint()
n = touch_all()
rc, out, _, t_status = run(SPEC + ["status", "--porcelain"])
log(step="real_index_status_after_touch", rc=rc, porcelain_lines=len(out.splitlines()), secs=round(t_status, 3))
n = touch_all()
rc, _, _, t_add = run(SPEC + ["add", "-A"])
rc, out, _, _ = run(["diff", "--cached", "--name-only"])
log(step="real_index_add_A_after_touch", rc=rc, secs=round(t_add, 3), staged_changes=len(out.splitlines()))
