# -*- coding: utf-8 -*-
"""Q1 round trip + Q2 idempotency, for hub.py and 20 sampled tracked files.

Per file p with HEAD blob B:
  Q1a  oid(hash-object --path=p  <  cat-file --filters HEAD:p) == B           (clean(smudge(B)) == B)
  Q1b  spec D4.1: scratch index cacheinfo B + `--work-tree=tmp/rt update-index -q --refresh` reports nothing
  Q2a  oid1 = hash-object -w --path=p < smudged ; oid(hash-object --path=p < blob(oid1)) == oid1   (clean(clean(x)) == clean(x))
  Q2b  oid(hash-object --path=p < cat-file blob B) == B                       (clean(B) == B)
  Q2c  spec D4.2: raw B bytes in tmp/id/<p>, same scratch refresh, reports nothing
  Q2d  (hub.py only) direct python filter: clean(clean(s)) == clean(s) by sha256
  DISK worktree file: oid(hash-object --path=p < disk) == B
Run with argument `keys` (dummy secrets.local.json present: smudge inserts the dummy) or `nokeys` (file renamed away: smudge no-op).
"""
import random, shutil, subprocess, sys
from common import *

state = sys.argv[1]
log = Log(f"q12_roundtrip_{state}")
keys = CLONE / "secrets.local.json"; keys_off = S03 / "secrets.local.json.off"
if state == "nokeys":
    shutil.move(keys, keys_off)
try:
    # ---- sample: hub.py + 20 stratified random tracked files (fixed seed) ----
    rc, out, _, _ = run(["-c", "core.quotepath=off", "ls-files", "-z", "--eol"])
    rows = []
    for rec in out.split(b"\0"):
        if not rec:
            continue
        meta, path = rec.split(b"\t", 1)
        rows.append((meta.split()[0].decode(), path.decode("utf-8")))
    rnd = random.Random(20261001)
    none_ = [p for e, p in rows if e == "i/none"]
    bin_ = [p for e, p in rows if e == "i/-text"]
    lf = [p for e, p in rows if e == "i/lf" and p != FILTER_PATH]
    sample = [FILTER_PATH] + none_[:1] + rnd.sample(bin_, 4) + rnd.sample(lf, 15)
    eol = dict((p, e) for e, p in rows)

    scratch_idx = TMP / f"scratch_{state}.index"
    for p in sample:
        B = oid(f"HEAD:{p}")
        rc, smudged, err, t_cat = run(["cat-file", "--filters", f"HEAD:{p}"])
        assert rc == 0, redact(err)
        rc, raw, _, _ = run(["cat-file", "blob", B])
        rc, o, err1, t_hash = run(["hash-object", f"--path={p}", "--stdin"], inp=smudged)
        q1a = o.decode().strip() == B
        rc, o1, _, _ = run(["hash-object", "-w", f"--path={p}", "--stdin"], inp=smudged)
        oid1 = o1.decode().strip()
        rc, c1, _, _ = run(["cat-file", "blob", oid1])
        rc, o2, _, _ = run(["hash-object", f"--path={p}", "--stdin"], inp=c1)
        q2a = o2.decode().strip() == oid1
        rc, o3, _, _ = run(["hash-object", f"--path={p}", "--stdin"], inp=raw)
        q2b = o3.decode().strip() == B
        disk = (CLONE / p).read_bytes()
        rc, o4, _, _ = run(["hash-object", f"--path={p}", "--stdin"], inp=disk)
        disk_eq = o4.decode().strip() == B

        # spec D4.1 / D4.2: scratch index + refresh against a throwaway work tree
        d4 = {}
        for tag, data in (("rt", smudged), ("id", raw)):
            wt = TMP / f"{tag}_{state}"
            f = wt / p; f.parent.mkdir(parents=True, exist_ok=True); f.write_bytes(data)
            if scratch_idx.exists():
                scratch_idx.unlink()
            env = dict(BASE_ENV, GIT_INDEX_FILE=str(scratch_idx))
            run(["update-index", "--add", "--cacheinfo", f"100644,{B},{p}"], env=env)
            rc, o, e, _ = run([f"--work-tree={wt}", "update-index", "-q", "--refresh"], env=env)
            rc2, o5, e5, _ = run([f"--work-tree={wt}", "-c", "filter.secret.required=true", "update-index", "--refresh"], env=env)
            d4[tag] = {"q_rc": rc, "q_stdout_nonempty": bool(o.strip()), "rc_noq": rc2,
                       "needs_update": b"needs update" in (o5 + e5), "stderr": redact(e + e5)}
        rec = dict(path=p, eol=eol[p], size=len(raw), blob=B, smudged_differs=smudged != raw,
                   smudged_has_dummy=DUMMY_MARKER in smudged, Q1a_roundtrip=q1a, Q2a_idem=q2a, Q2b_clean_blob_is_blob=q2b,
                   disk_eq=disk_eq, t_catfile_filters=round(t_cat, 3), t_hash_object=round(t_hash, 3), D4=d4)
        if p == FILTER_PATH:
            py = [sys.executable, "tools/secret_filter.py", "clean"]
            c1 = subprocess.run(py, cwd=CLONE, input=smudged, capture_output=True).stdout
            c2 = subprocess.run(py, cwd=CLONE, input=c1, capture_output=True).stdout
            rec["Q2d_python_clean_idem"] = sha(c1) == sha(c2)
            rec["Q2d_clean_of_smudged_equals_raw_working_form"] = True if q1a else None
            rec["smudged_bom"] = smudged[:3] == b"\xef\xbb\xbf"
            rec["smudged_crlf_lines"] = smudged.count(b"\r\n"); rec["smudged_lf_lines"] = smudged.count(b"\n")
            rec["blob_crlf_lines"] = raw.count(b"\r\n")
        log(**rec)
finally:
    if state == "nokeys":
        shutil.move(keys_off, keys)
