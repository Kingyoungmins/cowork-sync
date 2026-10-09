# -*- coding: utf-8 -*-
"""Shared helpers for spike 03-real-filter. Never logs file contents or secrets: only oids, sizes, rc, booleans, timings."""
import hashlib, json, os, re, statistics, subprocess, time
from pathlib import Path

# <scratch>/s03: the scripts were run from a copy placed in that folder, next to the clone.
S03 = Path(os.environ.get("COWORK_SCRATCH_S03", Path(__file__).resolve().parent))
CLONE = S03 / "clone"
LOGS = S03 / "logs"
TMP = S03 / "tmp"          # outside the clone so `add -A` never sees it
LOGS.mkdir(exist_ok=True); TMP.mkdir(exist_ok=True)
GIT = "git"
FILTER_PATH = "hub.py"   # placeholder name for the pilot repo's one filtered file (1.3 MB Python source)
DUMMY_MARKER = b"example.invalid"   # present only in the dummy secret (never the real one)

_DROP = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT")
BASE_ENV = {k: v for k, v in os.environ.items() if k not in _DROP and not k.startswith("CLAUDE")}
BASE_ENV.update(GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never")

_URL = re.compile(r"https?://\S+")


def redact(s):
    if isinstance(s, bytes):
        s = s.decode("utf-8", "replace")
    return _URL.sub("<url-redacted>", s)[:400]


def run(args, env=None, inp=None, cwd=CLONE, git=GIT):
    e = dict(BASE_ENV if env is None else env)
    t = time.perf_counter()
    p = subprocess.run([git, *args], cwd=str(cwd), env=e, input=inp, capture_output=True)
    dt = time.perf_counter() - t
    return p.returncode, p.stdout, p.stderr, dt


def sha(b):
    return hashlib.sha256(b).hexdigest()[:16]


def oid(rev):
    rc, out, err, _ = run(["rev-parse", rev])
    assert rc == 0, redact(err)
    return out.decode().strip()


def index_fingerprint(index_file=None):
    """sha of `ls-files -s` (+ the raw index file bytes) to prove an index did / did not change."""
    env = dict(BASE_ENV)
    if index_file:
        env["GIT_INDEX_FILE"] = str(index_file)
    rc, out, err, _ = run(["ls-files", "-s"], env=env)
    raw = Path(index_file or CLONE / ".git" / "index").read_bytes()
    return {"ls_files_sha": sha(out), "index_bytes_sha": sha(raw)}


def median(xs):
    return round(statistics.median(xs), 3)


class Log:
    def __init__(self, name):
        self.path = LOGS / f"{name}.jsonl"
        self.path.write_text("", encoding="utf-8")

    def __call__(self, **rec):
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(json.dumps(rec, ensure_ascii=False))


SPEC = ["-c", "attr.tree=HEAD", "-c", "filter.secret.required=true", "-c", "core.fsmonitor=false",
        "-c", "core.longpaths=true", "-c", "gc.auto=0"]


def touch_all(bump_ns=5_000_000_000):
    """Bump mtime of every file under the clone (not .git); contents untouched."""
    n = 0
    for root, dirs, files in os.walk(CLONE):
        if ".git" in dirs:
            dirs.remove(".git")
        for f in files:
            fp = os.path.join(root, f); st = os.stat(fp)
            os.utime(fp, ns=(st.st_atime_ns, st.st_mtime_ns + bump_ns)); n += 1
    return n
