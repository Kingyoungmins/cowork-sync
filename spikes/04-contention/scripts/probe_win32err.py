"""probe_win32err.py -- raw Win32 error codes behind Node's `open('w') UNKNOWN (-4094)` and `rename EPERM (-4048)`.
Separate scratch folder (<scratch>/s04/probe), 1.3 MB file. Each cell runs 6 s: one *actor* in a loop against
one *holder* in a loop, recording GetLastError() of every failed actor call.
  actors : open_w  = CreateFileW(GENERIC_WRITE, share R|W|D, CREATE_ALWAYS) + WriteFile + Close   (libuv open('w'))
           move    = write tmp, MoveFileExW(tmp, f, MOVEFILE_REPLACE_EXISTING)                    (libuv rename)
  holders: none, read (CreateFileW GENERIC_READ share R|W|D, read all, close), map (CreateFileMapping+MapViewOfFile
           held ~30 ms), git_add (real `git add -A` with a private index, as the daemon does), other_open_w, other_move.
Every Win32 code is printed with its symbolic name where known."""
import collections, ctypes, ctypes.wintypes as wt, json, os, subprocess, threading, time
from pathlib import Path

D = Path(os.environ.get("COWORK_SCRATCH_S04", Path(__file__).resolve().parents[4] / "cowork-sync-scratch" / "s04")) / "probe"   # <scratch>/s04/probe
D.mkdir(parents=True, exist_ok=True)
F = str(D / "f.txt"); GIT = r"C:/Program Files/Git/mingw64/bin/git.exe"
k = ctypes.WinDLL("kernel32", use_last_error=True)
k.CreateFileW.restype = wt.HANDLE
k.CreateFileW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p, wt.DWORD, wt.DWORD, wt.HANDLE]
k.CreateFileMappingW.restype = wt.HANDLE
k.CreateFileMappingW.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD, wt.DWORD, wt.DWORD, wt.LPCWSTR]
k.MapViewOfFile.restype = ctypes.c_void_p
k.MapViewOfFile.argtypes = [wt.HANDLE, wt.DWORD, wt.DWORD, wt.DWORD, ctypes.c_size_t]
k.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
k.CloseHandle.argtypes = [wt.HANDLE]
k.ReadFile.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD, ctypes.POINTER(wt.DWORD), ctypes.c_void_p]
k.WriteFile.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD, ctypes.POINTER(wt.DWORD), ctypes.c_void_p]
INVALID = wt.HANDLE(-1).value
NAMES = {5: "ERROR_ACCESS_DENIED", 32: "ERROR_SHARING_VIOLATION", 33: "ERROR_LOCK_VIOLATION", 1224: "ERROR_USER_MAPPED_FILE",
         303: "ERROR_DELETE_PENDING", 2: "ERROR_FILE_NOT_FOUND", 183: "ERROR_ALREADY_EXISTS"}
DATA = b"x" * 1_300_000
ENV = {**os.environ, "GIT_INDEX_FILE": str(D / ".git" / "probe-index"), "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}

def open_w(tag):
    h = k.CreateFileW(F, 0x40000000, 7, None, 2, 0x80, None)
    if h in (INVALID, None): return ctypes.get_last_error()
    k.WriteFile(h, DATA, len(DATA), ctypes.byref(wt.DWORD()), None); k.CloseHandle(h)

def move(tag):
    t = str(D / f"{tag}-{time.perf_counter_ns()}.tmp"); Path(t).write_bytes(DATA)
    if not k.MoveFileExW(t, F, 1):
        e = ctypes.get_last_error(); Path(t).unlink(missing_ok=True); return e

buf = ctypes.create_string_buffer(2_000_000)
def hold_read(_):
    h = k.CreateFileW(F, 0x80000000, 7, None, 3, 0x80, None)
    if h in (INVALID, None): return
    k.ReadFile(h, buf, len(buf), ctypes.byref(wt.DWORD()), None); k.CloseHandle(h)

def hold_map(_):
    h = k.CreateFileW(F, 0x80000000, 7, None, 3, 0x80, None)
    if h in (INVALID, None): return
    m = k.CreateFileMappingW(h, None, 2, 0, 0, None)
    if m:
        v = k.MapViewOfFile(m, 4, 0, 0, 0); time.sleep(0.03)
        if v: k.UnmapViewOfFile(v)
        k.CloseHandle(m)
    k.CloseHandle(h)

def hold_git(_):
    subprocess.run([GIT, "add", "-A"], cwd=D, env=ENV, capture_output=True)

HOLDERS = {"none": lambda _: time.sleep(0.01), "read": hold_read, "map": hold_map, "git_add": hold_git,
           "other_open_w": lambda t: open_w(t), "other_move": lambda t: move(t)}

def cell(actor, holder, secs=6):
    Path(F).write_bytes(DATA); stop = time.time() + secs; errs = collections.Counter(); n = [0, 0]
    def a():
        while time.time() < stop:
            n[0] += 1; e = (open_w if actor == "open_w" else move)("a")
            if e: errs[f"{e} {NAMES.get(e, '?')}"] += 1
    def h():
        while time.time() < stop:
            n[1] += 1; HOLDERS[holder]("h")
    ts = [threading.Thread(target=a), threading.Thread(target=h)]; [t.start() for t in ts]; [t.join() for t in ts]
    for f in D.glob("*.tmp"): f.unlink(missing_ok=True)
    return {"actor": actor, "holder": holder, "actor_calls": n[0], "holder_calls": n[1], "failures": sum(errs.values()), "win32": dict(errs)}

if __name__ == "__main__":
    if not (D / ".git").exists():
        subprocess.run([GIT, "init", "-q"], cwd=D, check=True)
        (D / ".git/info/exclude").write_text("*.tmp\n")
    res = [cell(a, h) for a in ("open_w", "move") for h in HOLDERS]
    for r in res: print(json.dumps(r))
    (Path(__file__).resolve().parent.parent / "raw" / "probe_win32err.json").write_text(json.dumps(res, indent=1))
