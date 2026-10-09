"""run.py <variant> [<variant> ...]  -- orchestrates spike 04 runs, one variant at a time (never in parallel).

Variants (name: seconds, daemon?, reader):
  smoke      60 s  daemon  node-reader   (script check only)
  main     1200 s  daemon  none          4 editors + daemon, Defender as-is
  control   300 s  -       none          4 editors only, Defender as-is (attributes failures that are not the daemon's)
  rnode     300 s  daemon  node          + a node process holding the file open with libuv default sharing (R|W|D)
  staged   1200 s  daemon(staged hashing, ENG-27 remedy)  none
  rshare    300 s  daemon  shareread     + a PowerShell process holding [IO.File]::Open(p,Open,Read,FileShare.Read)
The daemon runs inside a Windows Job Object; its accounting (TotalUserTime/TotalKernelTime) covers every git child.
No network, no credentials.
"""
import ctypes, ctypes.wintypes as wt, hashlib, json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
# The source was a pilot team's 1.3 MB Python file (<pilot-repo>/hub.py); point PILOT_HOT_FILE at any large file to rerun.
SRC = Path(os.environ.get("PILOT_HOT_FILE", "<pilot-repo>/hub.py"))
WORK = Path(os.environ.get("COWORK_SCRATCH_S04", HERE.parents[3] / "cowork-sync-scratch" / "s04"))   # <scratch>/s04
REPO = WORK / "repo"
ORIG = WORK / "orig_hub.py"
RAW = HERE.parent / "raw"
GIT = r"C:/Program Files/Git/mingw64/bin/git.exe"   # real binary, not the cmd/ launcher (one process per call)
VARIANTS = {"smoke": (60, True, "node"), "main": (1200, True, None), "control": (300, False, None),
            "rnode": (300, True, "node"), "rshare": (300, True, "shareread"),
            "staged": (1200, "staged", None)}
ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}

def git(*a):
    return subprocess.run([GIT, *a], cwd=REPO, env=ENV, capture_output=True, text=True, check=True).stdout.strip()

def setup():
    WORK.mkdir(parents=True, exist_ok=True)
    if not ORIG.exists():
        shutil.copyfile(SRC, ORIG)
    if not (REPO / ".git").exists():
        REPO.mkdir(exist_ok=True)
        shutil.copyfile(ORIG, REPO / "hub.py")
        git("init", "-q")
        git("config", "core.autocrlf", "true"); git("config", "gc.auto", "0")
        git("config", "user.name", "spike04"); git("config", "user.email", "spike04@invalid")
        (REPO / ".git/info/exclude").write_text("*.tmp-*\n")
        git("add", "hub.py"); git("commit", "-q", "-m", "pristine")
    assert hashlib.sha256(ORIG.read_bytes()).digest() == hashlib.sha256(SRC.read_bytes()).digest()

def dir_bytes(p):
    return sum(f.stat().st_size for f in Path(p).rglob("*") if f.is_file())

class JobAcct(ctypes.Structure):
    _fields_ = [("TotalUserTime", ctypes.c_int64), ("TotalKernelTime", ctypes.c_int64),
                ("ThisPeriodTotalUserTime", ctypes.c_int64), ("ThisPeriodTotalKernelTime", ctypes.c_int64),
                ("TotalPageFaultCount", wt.DWORD), ("TotalProcesses", wt.DWORD),
                ("ActiveProcesses", wt.DWORD), ("TotalTerminatedProcesses", wt.DWORD)]

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateJobObjectW.restype = wt.HANDLE

def run(name):
    secs, with_daemon, reader = VARIANTS[name]
    out = RAW / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    # reset working file + private index + writer tmp
    shutil.copyfile(ORIG, REPO / "hub.py")
    for f in (REPO / ".git/cowork/index", REPO / ".git/cowork/index.lock"):
        f.unlink(missing_ok=True)
    shutil.rmtree(REPO / ".git/cowork/tmp", ignore_errors=True)
    for f in REPO.glob("hub.py.tmp-*"):
        f.unlink()
    meta = {"variant": name, "seconds": secs, "daemon": with_daemon, "reader": reader,
            "objects_bytes_before": dir_bytes(REPO / ".git/objects"), "t_start": time.time()}
    ms = str(secs * 1000)
    procs = []
    job = None
    if with_daemon:
        job = k32.CreateJobObjectW(None, None)
        d = subprocess.Popen(["node", str(HERE / "daemon.js"), str(REPO), str(ORIG), ms, str(out / "daemon.jsonl"), GIT, "staged" if with_daemon == "staged" else "worktree"], env=ENV)
        ok = k32.AssignProcessToJobObject(job, wt.HANDLE(int(d._handle)))
        meta["job_assigned"] = bool(ok)
        procs.append(d)
    seeds = {}
    for i in range(1, 5):
        seeds[i] = (int(time.time() * 1000) + i * 7919) & 0x7FFFFFFF
        procs.append(subprocess.Popen(["node", str(HERE / "editor.js"), str(i), str(REPO / "hub.py"), str(ORIG), ms,
                                       str(out / f"editor{i}.jsonl"), str(seeds[i])], env=ENV))
    meta["editor_seeds"] = seeds
    if reader == "node":
        procs.append(subprocess.Popen(["node", str(HERE / "reader.js"), str(REPO / "hub.py"), ms, str(out / "reader.jsonl")], env=ENV))
    elif reader == "shareread":
        ps = (f"$f=[IO.File]::Open('{REPO / 'hub.py'}','Open','Read','Read'); "
              f"Start-Sleep -Seconds {secs}; $f.Close(); 'held {secs}s FileShare.Read' | Out-File -Encoding utf8 '{out / 'reader.txt'}'")
        procs.append(subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], env=ENV))
    deadline = time.time() + secs + 60
    for p in procs:
        try:
            p.wait(timeout=max(1, deadline - time.time()))
        except subprocess.TimeoutExpired:
            p.kill(); meta.setdefault("killed", []).append(p.args[1] if len(p.args) > 1 else str(p.args))
    if job:
        acct = JobAcct()
        k32.QueryInformationJobObject(job, 1, ctypes.byref(acct), ctypes.sizeof(acct), None)
        meta["job"] = {"user_s": acct.TotalUserTime / 1e7, "kernel_s": acct.TotalKernelTime / 1e7,
                       "processes": acct.TotalProcesses, "active_at_end": acct.ActiveProcesses}
        k32.TerminateJobObject(job, 1); k32.CloseHandle(job)
    meta["t_end"] = time.time()
    meta["objects_bytes_after"] = dir_bytes(REPO / ".git/objects")
    (out / "run.json").write_text(json.dumps(meta, indent=1))
    print(name, "done", json.dumps(meta.get("job")))

if __name__ == "__main__":
    setup()
    for v in sys.argv[1:]:
        run(v)
