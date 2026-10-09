# -*- coding: utf-8 -*-
"""Q3: filter.secret.required semantics on `git add hub.py` (real index of the scratch clone).

Before every add the file's mtime is bumped so git must re-run the clean filter (unchanged stat = filter never runs).
Cases (clean driver x required):
  ok_req      real driver,                 required=true
  ok_noreq    real driver,                 required=false
  missing_req clean = nonexistent command, required=true
  missing_noreq clean = nonexistent command, required=false
  fail_req    clean = command exiting 3,   required=true
  fail_noreq  clean = command exiting 3,   required=false
  empty_req   clean = '' (driver unset),   required=true
  empty_noreq clean = '' (driver unset),   required=false
Also smudge side: `cat-file --filters HEAD:hub.py` with a nonexistent smudge, required true/false.
Records rc, whether the index changed, whether the staged blob == HEAD blob, whether it contains the dummy marker. Restores after each case.
"""
import os, time
from common import *

log = Log("q3_required")
p = FILTER_PATH
B = oid(f"HEAD:{p}")
BROKEN = {"ok": None, "missing": "nonexistent_cmd_xyz_s03", "fail": "sh -c 'exit 3'", "empty": ""}


def staged():
    rc, out, _, _ = run(["ls-files", "-s", "--", p])
    return out.decode().split()[1]


def touch():
    st = os.stat(CLONE / p); os.utime(CLONE / p, ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))


for kind, cmd in BROKEN.items():
    for req in ("true", "false"):
        assert staged() == B
        touch()
        before = index_fingerprint()
        args = ["-c", f"filter.secret.required={req}"]
        if cmd is not None:
            args += ["-c", f"filter.secret.clean={cmd}"]
        rc, out, err, dt = run(args + ["add", "--", p])
        after = index_fingerprint()
        s = staged()
        rc2, blob, _, _ = run(["cat-file", "blob", s])
        log(case=f"{kind}_{'req' if req == 'true' else 'noreq'}", clean_cmd=("<team driver>" if cmd is None else cmd), required=req,
            add_rc=rc, secs=round(dt, 3), index_changed=before != after, staged_eq_HEAD=s == B,
            staged_contains_dummy_secret=DUMMY_MARKER in blob, stderr=redact(err))
        run(["reset", "-q", "--", p])
        run(["update-index", "--refresh"])   # restat with the real driver so the next case starts clean

for req in ("true", "false"):
    rc, out, err, dt = run(["-c", f"filter.secret.required={req}", "-c", "filter.secret.smudge=nonexistent_cmd_xyz_s03",
                            "cat-file", "--filters", f"HEAD:{p}"])
    log(case=f"smudge_missing_{req}", catfile_rc=rc, stdout_len=len(out), stdout_has_dummy=DUMMY_MARKER in out, stderr=redact(err))
rc, out, _, _ = run(["status", "--porcelain"])
log(case="final_status", porcelain_lines=len(out.splitlines()), staged_eq_HEAD=staged() == B)

# Driver truly undefined (no filter.secret.* in any config, as on a clone where setup was never run):
# temporarily rename the local section, then restore it.
run(["config", "--local", "--rename-section", "filter.secret", "filter.secret_s03off"])
try:
    for extra, name in ((["-c", "filter.secret.required=true"], "undefined_req_via_-c"), ([], "undefined_no_flag")):
        touch(); before = index_fingerprint()
        rc, out, err, dt = run(extra + ["add", "--", p])
        s = staged(); rc2, blob, _, _ = run(["cat-file", "blob", s])
        log(case=name, add_rc=rc, index_changed=before != index_fingerprint(), staged_eq_HEAD=s == B,
            staged_contains_dummy_secret=DUMMY_MARKER in blob, stderr=redact(err))
        run(["reset", "-q", "--", p])
finally:
    run(["config", "--local", "--rename-section", "filter.secret_s03off", "filter.secret"])
    run(["update-index", "--refresh"])
rc, out, _, _ = run(["config", "--local", "--get-regexp", r"^filter\.secret\."])
log(case="config_restored", n_keys=len(out.splitlines()))
