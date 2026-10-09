# -*- coding: utf-8 -*-
"""Q6: does the pilot team's filter work under the spec's DAEMON_ENV (LC_ALL=C, LANGUAGE=, minimal PATH)? Which PATH entries are needed?

Each env variant x git binary runs:
  T1 smudge : cat-file --filters HEAD:hub.py           -> rc, output carries the dummy secret (smudge really ran)
  T2 clean  : hash-object --path=hub.py <disk file>     -> == HEAD blob (disk holds the dummy, so equality => clean ran)
  T3 snap   : temp index read-tree HEAD; add -A; write-tree   -> == HEAD^{tree}
All with SPEC flags (filter.secret.required=true etc.). Also: the same with a hypothetical bare-`python` driver, and cwd = a subdirectory.
"""
import os, sys
from common import *

log = Log("q6_env")
B = oid(f"HEAD:{FILTER_PATH}"); HEAD_TREE = oid("HEAD^{tree}")
GIT_CMD = r"C:\Program Files\Git\cmd\git.exe"
GIT_MINGW = r"C:\Program Files\Git\mingw64\bin\git.exe"
SYS = r"C:\Windows\System32;C:\Windows"
GIT_USR = r"C:\Program Files\Git\usr\bin"
GIT_MBIN = r"C:\Program Files\Git\mingw64\bin"
PY_DIR = os.path.dirname(sys.executable)   # the run used the per-user Python 3.12 install dir
FORCED = {"LC_ALL": "C", "LANGUAGE": "", "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never",
          "SSH_ASKPASS_REQUIRE": "never", "GIT_OPTIONAL_LOCKS": "0"}
ALLOW = ["PATH", "SystemRoot", "ComSpec", "USERPROFILE", "HOME", "TEMP", "TMP", "TMPDIR", "LANG", "APPDATA",
         "LOCALAPPDATA", "ProgramData", "ProgramFiles", "HOMEDRIVE", "HOMEPATH", "PATHEXT", "WINDIR", "SYSTEMDRIVE"]
cur = {k.upper(): v for k, v in os.environ.items()}
full = {k: cur[k.upper()] for k in ALLOW if k.upper() in cur}
full.update({k: v for k, v in os.environ.items() if k.startswith("LC_")})

ENVS = {
    "daemon_allowlist_session_PATH": dict(full, **FORCED),
    "sys32_only+SystemRoot": dict(FORCED, SystemRoot=r"C:\Windows", PATH=SYS),
    "sys32+git_usr_bin": dict(FORCED, SystemRoot=r"C:\Windows", PATH=SYS + ";" + GIT_USR),
    "sys32+python_dir": dict(FORCED, SystemRoot=r"C:\Windows", PATH=SYS + ";" + PY_DIR),
    "PATH_empty+SystemRoot": dict(FORCED, SystemRoot=r"C:\Windows", PATH=""),
    "no_PATH+SystemRoot": dict(FORCED, SystemRoot=r"C:\Windows"),
    "sys32_only_no_SystemRoot": dict(FORCED, PATH=SYS),
}


def trial(env, git, extra=(), cwd=CLONE):
    r = {}
    rc, out, err, dt = run(SPEC + list(extra) + ["cat-file", "--filters", f"HEAD:{FILTER_PATH}"], env=env, git=git, cwd=cwd)
    r["T1_smudge_rc"], r["T1_smudge_inserted_dummy"], r["T1_secs"] = rc, DUMMY_MARKER in out, round(dt, 3)
    r["T1_stderr"] = redact(err)
    rc, out, err, dt = run(SPEC + list(extra) + ["hash-object", f"--path={FILTER_PATH}", "--stdin"], env=env, git=git,
                           cwd=cwd, inp=(CLONE / FILTER_PATH).read_bytes())
    r["T2_clean_rc"], r["T2_clean_eq_HEAD_blob"], r["T2_stderr"] = rc, out.decode().strip() == B, redact(err)
    idx = TMP / "env.index"
    if idx.exists():
        idx.unlink()
    e2 = dict(env, GIT_INDEX_FILE=str(idx))   # test-harness only (GIT_INDEX_FILE is on the never-list for inherited env)
    rc1, _, _, _ = run(SPEC + list(extra) + ["read-tree", "HEAD"], env=e2, git=git, cwd=cwd)
    rc2, _, err, dt = run(SPEC + list(extra) + ["add", "-A"], env=e2, git=git, cwd=cwd)
    rc3, tree, _, _ = run(["write-tree"], env=e2, git=git, cwd=cwd)
    r.update(T3_add_rc=rc2, T3_tree_eq_HEAD=tree.decode().strip() == HEAD_TREE, T3_add_secs=round(dt, 3), T3_stderr=redact(err))
    return r


for ename, env in ENVS.items():
    for gname, git in (("cmd/git.exe", GIT_CMD), ("mingw64/bin/git.exe", GIT_MINGW)):
        try:
            log(env=ename, git=gname, env_keys=sorted(env), **trial(env, git))
        except Exception as ex:   # e.g. git cannot even start
            log(env=ename, git=gname, exception=redact(repr(ex)))

# hypothetical driver that relies on PATH for python (not what the pilot team's setup writes; shows what PATH would be needed)
bare = ["-c", "filter.secret.clean=python tools/secret_filter.py clean",
        "-c", "filter.secret.smudge=python tools/secret_filter.py smudge"]
for ename in ("daemon_allowlist_session_PATH", "sys32_only+SystemRoot", "sys32+python_dir"):
    log(env=ename, git="cmd/git.exe", driver="bare python (hypothetical)", **trial(ENVS[ename], GIT_CMD, extra=bare))
# cwd = subdirectory of the work tree (relative script path tools/secret_filter.py)
log(env="daemon_allowlist_session_PATH", git="cmd/git.exe", cwd="clone/docs", **trial(ENVS["daemon_allowlist_session_PATH"], GIT_CMD, cwd=CLONE / "docs"))
# filter process count in one cold add -A (GIT_TRACE run_command lines)
idx = TMP / "trace.index"
if idx.exists():
    idx.unlink()
e3 = dict(ENVS["daemon_allowlist_session_PATH"], GIT_INDEX_FILE=str(idx))
run(SPEC + ["read-tree", "HEAD"], env=e3)
rc, _, err, _ = run(SPEC + ["add", "-A"], env=dict(e3, GIT_TRACE="1"))
lines = [l for l in err.decode("utf-8", "replace").splitlines() if "run_command" in l]
log(event="filter_processes_in_cold_add_A", run_command_lines=len(lines),
    sh_used=[l.split("start_command: ")[1].split(" -c ")[0] for l in err.decode("utf-8", "replace").splitlines() if "start_command" in l][:2])
