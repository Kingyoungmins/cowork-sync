"""Shared helper: launch one `claude -p` run in a throwaway project with a clean env.

- strips every inherited CLAUDE* env var (the orchestrating session's own
  CLAUDE_CODE_MESSAGING_SOCKET/TOKEN must never leak into the child),
- always --model haiku, stream-json output, timestamps every stdout line,
- --debug-file into the project, filtered + redacted afterwards,
- hard wall-clock timeout, kills the whole process tree,
- appends one record per run to raw/runs.jsonl (purpose, duration, exit code).
"""
import json, os, re, subprocess, threading, time, uuid

# The original run used the npm-installed binary <nodejs>\node_modules\@anthropic-ai\claude-code\bin\claude.exe.
CLAUDE_EXE = os.environ.get("CLAUDE_EXE", "claude")
RESULTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # <repo>/spikes/02-claude-host
RAW = os.path.join(RESULTS, "raw")
_REPO = os.path.dirname(os.path.dirname(RESULTS))
SCRATCH = os.environ.get("COWORK_SCRATCH_S02",
                         os.path.join(os.path.dirname(_REPO), "cowork-sync-scratch", "s02"))  # <scratch>/s02


def clean_env():
    env = dict(os.environ)
    stripped = sorted(k for k in env if k.upper().startswith("CLAUDE"))
    for k in stripped:
        del env[k]
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "never"
    return env, stripped


def redact(text, secrets=()):
    for s in secrets:
        if s:
            text = text.replace(s, "[REDACTED]")
    text = re.sub(r"sk-ant-[A-Za-z0-9_\-]+", "[REDACTED-sk-ant]", text)
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+", r"\1[REDACTED]", text)
    text = re.sub(r"https?://[^\s/@]+:[^\s/@]+@", "https://[REDACTED]@", text)
    return text


class Run:
    def __init__(self, label, project, prompt, extra_args, timeout_s, purpose,
                 stdin_stream=False, session_id=None, keep_all_debug=False):
        self.label, self.project, self.prompt = label, project, prompt
        self.extra, self.timeout_s, self.purpose = extra_args, timeout_s, purpose
        self.stdin_stream = stdin_stream
        self.keep_all_debug = keep_all_debug
        self.session_id = session_id or str(uuid.uuid4())
        self.lines = []  # (t_ms, line)
        self.debug_raw = os.path.join(project, "out", f"{label}.debug.raw.log")
        os.makedirs(os.path.join(project, "out"), exist_ok=True)

    def start(self):
        env, self.stripped = clean_env()
        args = [CLAUDE_EXE, "-p"]
        if not self.stdin_stream:
            args.append(self.prompt)
        args += ["--model", "haiku", "--verbose", "--output-format", "stream-json",
                 "--setting-sources", "project,local",
                 "--debug-file", self.debug_raw,
                 "--session-id", self.session_id] + self.extra
        if self.stdin_stream:
            args += ["--input-format", "stream-json"]
        self.argv_logged = [a if a != self.prompt else "<prompt>" for a in args[1:]]
        self.t0 = time.time()
        self.p = subprocess.Popen(args, cwd=self.project, env=env,
                                  stdin=subprocess.PIPE if self.stdin_stream else subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        self.claude_pid = self.p.pid
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()
        return self

    def _read(self):
        for raw in self.p.stdout:
            self.lines.append((int(time.time() * 1000), raw.decode("utf-8", "replace").rstrip("\r\n")))

    def _read_err(self):
        self.stderr = self.p.stderr.read().decode("utf-8", "replace")

    def send_user(self, text):
        msg = {"type": "user", "message": {"role": "user", "content": text}}
        self.p.stdin.write((json.dumps(msg) + "\n").encode())
        self.p.stdin.flush()

    def wait(self, secrets=()):
        try:
            self.rc = self.p.wait(timeout=self.timeout_s)
            self.timed_out = False
        except subprocess.TimeoutExpired:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.p.pid)], capture_output=True)
            self.rc = self.p.wait()
            self.timed_out = True
        self.dur = round(time.time() - self.t0, 1)
        time.sleep(0.5)
        self.save(secrets)
        return self

    def save(self, secrets=()):
        with open(os.path.join(RAW, f"{self.label}.stream.jsonl"), "w", encoding="utf-8") as f:
            for t, line in self.lines:
                f.write(json.dumps({"t_ms": t, "line": redact(line, secrets)}, ensure_ascii=False) + "\n")
        with open(os.path.join(RAW, f"{self.label}.stderr.txt"), "w", encoding="utf-8") as f:
            f.write(redact(getattr(self, "stderr", ""), secrets))
        # filtered + redacted debug log; raw copy deleted
        keep = re.compile(r"uds-messaging|cross-session|crossSession|hook|Hook|MCP|mcp|SessionStart|"
                          r"UserPromptSubmit|PreToolUse|PostToolUse|inbox|queue|STARTUP|error|Error", re.I)
        if os.path.exists(self.debug_raw):
            with open(self.debug_raw, encoding="utf-8", errors="replace") as f:
                kept = [redact(l, secrets) for l in f if self.keep_all_debug or keep.search(l)]
            with open(os.path.join(RAW, f"{self.label}.debug.filtered.log"), "w", encoding="utf-8") as f:
                f.writelines(kept)
            os.remove(self.debug_raw)
        rec = {"label": self.label, "purpose": self.purpose, "session_id": self.session_id,
               "start": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(self.t0)),
               "duration_s": self.dur, "exit_code": self.rc, "timed_out": self.timed_out,
               "argv": self.argv_logged, "stripped_env_keys": self.stripped}
        with open(os.path.join(RAW, "runs.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")

    def result_text(self):
        for _, line in reversed(self.lines):
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("type") == "result":
                return o.get("result")
        return None


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)


def collect(label, project):
    """copy the project's out/*.jsonl probe files into raw/ (never the secret/ folder)."""
    import glob, shutil
    for fp in glob.glob(os.path.join(project, "out", "*.jsonl")):
        shutil.copy(fp, os.path.join(RAW, f"{label}__{os.path.basename(fp)}"))


def init_info(run):
    """mcp server status + hook/tool names from the stream-json init message."""
    for _, line in run.lines:
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") == "system" and o.get("subtype") == "init":
            return {"mcp_servers": o.get("mcp_servers"), "claude_code_version": o.get("claude_code_version"),
                    "model": o.get("model"), "permissionMode": o.get("permissionMode")}
    return None
