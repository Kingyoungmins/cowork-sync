"""Shared helpers for spike 01-github. Token is obtained only via `git credential fill`
and kept in memory; it is never printed, logged or written to disk."""
import json, os, re, subprocess, time, urllib.request, urllib.error

REPO_URL = "https://github.com/Kingyoungmins/cowork-sync-sandbox.git"
OWNER, REPO = "Kingyoungmins", "cowork-sync-sandbox"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"
ENV = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never")

# NOTE: the first version used a bare "429", which matched inside a commit sha printed by git push
# ("15ad0c682bfd9e4429e3dc...") and stopped run d at 856.8 s (false positive, see README).
THROTTLE_RE = re.compile(r"(?<![0-9a-f])429(?![0-9a-f])|too many requests|secondary rate limit|abuse|rate limit", re.I)


class StopLoad(Exception):
    """Raised when rule 6 (429 / secondary rate limit / abuse / repeated 5xx) fires."""


def redact(s: str) -> str:
    s = re.sub(r"https://[^@\s/]+@", "https://<redacted>@", s)
    s = re.sub(r"(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})", "<token>", s)
    s = re.sub(r"(?i)(authorization:\s*)(\S+\s+)?\S+", r"\1<redacted>", s)
    return s


def git(args, cwd=None, env=None, timeout=120):
    """Run git, return (exit, stdout, stderr, seconds). Output is redacted."""
    t0 = time.perf_counter()
    try:
        p = subprocess.run(["git", *args], cwd=cwd, env=env or ENV, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=timeout)
        rc, out, err = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        rc, out, err = -999, "", "TIMEOUT"
    return rc, redact(out), redact(err), time.perf_counter() - t0


_TOKEN = None


def _token():
    global _TOKEN
    if _TOKEN is None:
        p = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                           env=ENV, capture_output=True, text=True, timeout=60)
        for line in p.stdout.splitlines():
            if line.startswith("password="):
                _TOKEN = line[len("password="):]
        if not _TOKEN:
            raise RuntimeError("no credential available (exit %d)" % p.returncode)
    return _TOKEN


def rest(method, path, body=None):
    """Return (status, headers-subset, parsed json or text). path is relative to repo API or absolute."""
    url = path if path.startswith("https://") else API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + _token(), "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cowork-sync-spike01"})
    keep = ("x-ratelimit-remaining", "x-ratelimit-limit", "x-oauth-scopes", "retry-after")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            st, hdr, raw = r.status, r.headers, r.read().decode()
    except urllib.error.HTTPError as e:
        st, hdr, raw = e.code, e.headers, e.read().decode(errors="replace")
    h = {k: hdr.get(k) for k in keep if hdr.get(k) is not None}
    try:
        js = json.loads(raw) if raw else None
    except ValueError:
        js = raw[:500]
    if st == 429 or (st == 403 and THROTTLE_RE.search(raw or "")):
        raise StopLoad(f"REST {st}: {redact(str(raw)[:200])}")
    return st, h, js


class Log:
    def __init__(self, path):
        self.f = open(path, "a", encoding="utf-8")

    def __call__(self, *parts):
        line = time.strftime("%Y-%m-%dT%H:%M:%S") + "\t" + "\t".join(redact(str(p)) for p in parts)
        print(line, flush=True)
        self.f.write(line + "\n"); self.f.flush()


def check_throttle(err: str):
    if THROTTLE_RE.search(err or ""):
        raise StopLoad("git stderr: " + err.strip().splitlines()[0][:200])


# ---- spike identity (local only) + push wrapper with rule-1/rule-6 guards ----
ENV.update(GIT_AUTHOR_NAME="cowork-spike", GIT_AUTHOR_EMAIL="spike@cowork-sync.invalid",
           GIT_COMMITTER_NAME="cowork-spike", GIT_COMMITTER_EMAIL="spike@cowork-sync.invalid")
FIVEXX_RE = re.compile(r"(HTTP|error:?|returned error:)\s*5\d\d", re.I)
_consec_5xx = [0]


def assert_sandbox(cwd):
    rc, out, _, _ = git(["remote", "get-url", "origin"], cwd=cwd)
    if out.strip() != REPO_URL:
        raise SystemExit("RULE 1 GUARD: origin is not the sandbox: " + out.strip())


def push(cwd, args, env=None, timeout=120):
    """git push with throttle/5xx guards. Returns (rc, out, err, secs)."""
    assert_sandbox(cwd)
    rc, out, err, dt = git(["push", *args], cwd=cwd, env=env, timeout=timeout)
    check_throttle(err)
    if FIVEXX_RE.search(err):
        _consec_5xx[0] += 1
        if _consec_5xx[0] >= 3:
            raise StopLoad("3 consecutive 5xx: " + err.strip().splitlines()[0][:200])
    else:
        _consec_5xx[0] = 0
    return rc, out, err, dt


def new_commit(cwd, parents, msg, files=None, base_tree=None):
    """Create a commit object with plumbing. files: {name: content} replacing the tree (flat)."""
    if files is not None:
        entries = []
        for name, content in sorted(files.items()):
            # bytes, not text: on Windows text-mode stdin turns \n into \r\n (corrupted tree names
            # to 'README.md\r' in the first run of a_caps.py; fixed by a_fix_main.py)
            p = subprocess.run(["git", "hash-object", "-w", "--stdin"], cwd=cwd, env=ENV,
                               input=content.encode(), capture_output=True, check=True)
            entries.append(f"100644 blob {p.stdout.decode().strip()}\t{name}")
        p = subprocess.run(["git", "mktree"], cwd=cwd, env=ENV, input=("\n".join(entries) + "\n").encode(),
                           capture_output=True, check=True)
        tree = p.stdout.decode().strip()
    else:
        tree = base_tree
    args = ["commit-tree", tree]
    for par in parents:
        args += ["-p", par]
    args += ["-m", msg]
    p = subprocess.run(["git", *args], cwd=cwd, env=ENV, capture_output=True, text=True, check=True)
    return p.stdout.strip()


def tree_of(cwd, rev):
    return subprocess.run(["git", "rev-parse", rev + "^{tree}"], cwd=cwd, env=ENV,
                          capture_output=True, text=True, check=True).stdout.strip()


def ls_remote(cwd, pattern=None):
    rc, out, err, dt = git(["ls-remote", "origin"] + ([pattern] if pattern else []), cwd=cwd)
    refs = {}
    for line in out.splitlines():
        if "\t" in line:
            sha, ref = line.split("\t", 1)
            refs[ref] = sha
    return refs


def init_clone(path):
    """Fresh local repo pointing at the sandbox (works for empty or non-empty remote)."""
    os.makedirs(path, exist_ok=True)
    git(["init", "-q", "-b", "main"], cwd=path)
    git(["remote", "remove", "origin"], cwd=path)
    git(["remote", "add", "origin", REPO_URL], cwd=path)
    git(["config", "core.autocrlf", "false"], cwd=path)
    assert_sandbox(path)
