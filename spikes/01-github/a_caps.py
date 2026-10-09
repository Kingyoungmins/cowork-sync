"""(a) Capabilities probe on the sandbox repo. Writes a_caps.log + a_caps.json + trace files."""
import json, os, re, sys
from common import *

HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.join(HERE, "work-a")
W2 = os.path.join(HERE, "work-a2")
log = Log(os.path.join(HERE, "a_caps.log"))
R = {}
B, C = "refs/cowork/main/board", "refs/cowork/main/code"


def P(tag, args, env=None):
    rc, out, err, dt = push(W, args, env=env)
    log(tag, "rc=%d" % rc, "%.2fs" % dt, "ARGS=" + " ".join(args), "STDERR=" + err.strip().replace("\n", " | "))
    R[tag] = {"rc": rc, "secs": round(dt, 3), "stderr": err.strip().splitlines()}
    return rc


init_clone(W)
rem = ls_remote(W)
log("remote refs before", rem)

# 1. initial commit on main (with packet trace -> receive-pack capability advertisement)
main0 = new_commit(W, [], "initial: sandbox for cowork-sync experiments",
                   files={"README.md": "sandbox for cowork-sync experiments\n"})
trace = os.path.join(HERE, "a_trace_push.txt").replace("\\", "/")
if os.path.exists(trace):
    os.remove(trace)
P("push_main_initial", [ "origin", f"{main0}:refs/heads/main"], env=dict(ENV, GIT_TRACE_PACKET=trace))
tr = redact(open(trace, encoding="utf-8", errors="replace").read())
open(trace, "w", encoding="utf-8").write(tr)
caps_line = next((l for l in tr.splitlines() if "report-status" in l), "")
caps = sorted(set(re.findall(r"[a-z][a-z0-9-]+(?:=[^\s\\]+)?", caps_line.split("\\0", 1)[-1] if "\\0" in caps_line else caps_line)))
R["receive_pack_caps_line"] = caps_line[-400:]
R["advertises_atomic"] = "atomic" in caps_line
R["advertises_push_options"] = "push-options" in caps_line
log("caps atomic=%s push-options=%s" % (R["advertises_atomic"], R["advertises_push_options"]), caps_line[-300:])

# 2. create board + code custom refs
tree = tree_of(W, main0)
board1 = new_commit(W, [main0], "board v1", files={"board.json": '{"v":1}\n'})
code1 = new_commit(W, [main0], "code v1", files={"code.txt": "v1\n"})
P("push_board_create", ["origin", f"{board1}:{B}"])
P("push_code_create", ["origin", f"{code1}:{C}"])
rem = ls_remote(W, "refs/cowork/*")
R["ls_remote_after_create"] = rem
log("ls-remote cowork", rem)

# 3. fetch behaviour in a fresh clone: default fetch vs explicit refspec
if not os.path.isdir(os.path.join(W2, ".git")):
    rc, out, err, dt = git(["clone", "-q", REPO_URL, W2], cwd=HERE)
    log("clone work-a2", rc, err.strip())
rc, out, err, dt = git(["fetch", "origin"], cwd=W2)
rc, refs_default, _, _ = git(["for-each-ref", "--format=%(refname)"], cwd=W2)
R["default_fetch_brings_custom_refs"] = "refs/cowork" in refs_default or "cowork" in refs_default
log("default fetch refs", refs_default.split())
rc, out, err, dt = git(["fetch", "origin", "+refs/cowork/main/*:refs/remotes/origin-cowork/*"], cwd=W2)
rc2, refs_explicit, _, _ = git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/origin-cowork"], cwd=W2)
R["explicit_fetch"] = {"rc": rc, "secs": round(dt, 3), "refs": refs_explicit.split("\n")}
log("explicit fetch rc=%d %.2fs" % (rc, dt), refs_explicit.split("\n"), err.strip())

# 4. two-parent commit pushed to board with correct lease
merge = new_commit(W, [board1, code1], "merge board+code (2 parents)",
                   files={"board.json": '{"v":2}\n', "code.txt": "v1\n"})
P("push_two_parent_lease_ok", ["origin", f"{merge}:{B}", f"--force-with-lease={B}:{board1}"])
git(["fetch", "origin", f"+{B}:refs/remotes/origin-cowork/board"], cwd=W2)
rc, cat, _, _ = git(["cat-file", "-p", "refs/remotes/origin-cowork/board"], cwd=W2)
R["two_parent_parents_seen_after_fetch"] = [l.split()[1] for l in cat.splitlines() if l.startswith("parent ")]
R["two_parent_ok"] = R["two_parent_parents_seen_after_fetch"] == [board1, code1]
log("two-parent fetched parents", R["two_parent_parents_seen_after_fetch"], "ok=%s" % R["two_parent_ok"])

# 5. stale lease: X moves board; Y (also based on merge) pushes with expect=merge -> must be rejected
X = new_commit(W, [merge], "X", files={"board.json": '{"v":3}\n', "code.txt": "v1\n"})
Y = new_commit(W, [merge], "Y", files={"board.json": '{"v":"y"}\n', "code.txt": "v1\n"})
P("lease_X_success", ["origin", f"{X}:{B}", f"--force-with-lease={B}:{merge}"])
P("lease_Y_stale_reject", ["origin", f"{Y}:{B}", f"--force-with-lease={B}:{merge}"])
R["board_after_stale"] = ls_remote(W, B).get(B)
R["stale_left_X_in_place"] = R["board_after_stale"] == X

# 6. create with empty expect, then repeat (must reject since ref now exists)
NEWREF = "refs/cowork/main/lease-new"
n1 = new_commit(W, [main0], "lease-new 1", files={"n.txt": "1\n"})
n2 = new_commit(W, [main0], "lease-new 2", files={"n.txt": "2\n"})
if NEWREF in ls_remote(W, NEWREF):
    log("WARN lease-new already exists (rerun)")
P("lease_create_empty_expect", ["origin", f"{n1}:{NEWREF}", f"--force-with-lease={NEWREF}:"])
P("lease_create_empty_expect_again_reject", ["origin", f"{n2}:{NEWREF}", f"--force-with-lease={NEWREF}:"])

# 7. delete a custom ref: stale-lease delete (reject), then correct-lease delete
DEL = "refs/cowork/main/del-probe"
d1 = new_commit(W, [main0], "del-probe", files={"d.txt": "d\n"})
P("del_probe_create", ["origin", f"{d1}:{DEL}"])
P("delete_stale_lease_reject", ["origin", f":{DEL}", f"--force-with-lease={DEL}:{main0}"])
P("delete_correct_lease", ["origin", f":{DEL}", f"--force-with-lease={DEL}:{d1}"])
R["del_probe_gone"] = DEL not in ls_remote(W, DEL)

# 8. --atomic with two refs, one stale lease -> neither may move
before = ls_remote(W, "refs/cowork/*")
b2 = new_commit(W, [X], "atomic board", files={"board.json": '{"v":4}\n', "code.txt": "v1\n"})
c2 = new_commit(W, [code1], "atomic code", files={"code.txt": "v2\n"})
P("atomic_one_stale", ["--atomic", "origin", f"{b2}:{B}", f"{c2}:{C}",
                       f"--force-with-lease={B}:{X}", f"--force-with-lease={C}:{main0}"])
after = ls_remote(W, "refs/cowork/*")
R["atomic_neither_moved"] = before.get(B) == after.get(B) and before.get(C) == after.get(C)
log("atomic neither moved", R["atomic_neither_moved"], before, after)
P("atomic_both_ok", ["--atomic", "origin", f"{b2}:{B}", f"{c2}:{C}",
                     f"--force-with-lease={B}:{X}", f"--force-with-lease={C}:{code1}"])
after2 = ls_remote(W, "refs/cowork/*")
R["atomic_both_moved"] = after2.get(B) == b2 and after2.get(C) == c2

# 9. push-options actually accepted?
po = new_commit(W, [main0], "push-option probe", files={"po.txt": "po\n"})
P("push_option_probe", ["-o", "cowork-probe=1", "origin", f"{po}:refs/cowork/main/po-probe"])

# 10. REST read of a custom ref
st, h, js = rest("GET", "/git/ref/cowork/main/board")
R["rest_get_board"] = {"status": st, "sha": (js or {}).get("object", {}).get("sha") if isinstance(js, dict) else None,
                       "ref": js.get("ref") if isinstance(js, dict) else None, "ratelimit_remaining": h.get("x-ratelimit-remaining")}
R["rest_sha_matches_ls_remote"] = R["rest_get_board"]["sha"] == after2.get(B)
st2, _, js2 = rest("GET", "/git/matching-refs/cowork/")
R["rest_matching_refs"] = {"status": st2, "refs": [x.get("ref") for x in js2] if isinstance(js2, list) else js2}
log("REST", R["rest_get_board"], R["rest_matching_refs"])

R["shas"] = {"main0": main0, "board1": board1, "code1": code1, "merge": merge, "X": X, "Y": Y,
             "b2": b2, "c2": c2}
json.dump(R, open(os.path.join(HERE, "a_caps.json"), "w"), indent=1)
log("DONE")
