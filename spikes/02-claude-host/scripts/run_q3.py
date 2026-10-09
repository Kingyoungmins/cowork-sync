"""q3: inbox socket. Hooks hand the socket path + token to this script; while Claude runs a ~45 s Bash
command, inject candidate frames (one connection each) and see which ones the session reports."""
import json, os, shutil, subprocess, time
from runner import Run, SCRATCH, RAW, collect, init_info, redact

S = os.path.dirname(os.path.abspath(__file__))
p = os.path.join(SCRATCH, "q3inbox")
out, secret = os.path.join(p, "out"), os.path.join(p, "out", "secret")
PROMPT = ("Run this exact Bash command in the foreground and wait for it: node wait.js  (about 45 seconds). "
          "After it finishes, quote verbatim every message you received from another session or user during "
          "this conversation (any text containing PING), or say NONE.")
r = Run("q3", p, PROMPT, ["--settings", os.path.join(SCRATCH, "flag_settings_accept.json"),
        "--max-turns", "6", "--allowedTools", "Bash(node wait.js)"], 240,
        "q3 inbox socket: inject candidate frames during a 45 s Bash call").start()

def wait_for(path, secs):
    end = time.time() + secs
    while time.time() < end:
        if os.path.exists(path):
            return True
        time.sleep(0.3)
    return False

notes = {}
notes["token_file_seen"] = wait_for(os.path.join(secret, "token.txt"), 60)
token = open(os.path.join(secret, "token.txt")).read().strip() if notes["token_file_seen"] else ""
sock = open(os.path.join(secret, "socket.txt")).read().strip() if notes["token_file_seen"] else ""
parent_sock = os.environ.get("CLAUDE_CODE_MESSAGING_SOCKET")
notes["socket_differs_from_orchestrator"] = bool(sock) and sock != parent_sock
notes["bash_started"] = wait_for(os.path.join(out, "pretooluse_bash.jsonl"), 90)
results = os.path.join(out, "inject_results.jsonl")
if notes["socket_differs_from_orchestrator"] and notes["bash_started"]:
    time.sleep(3)
    sid = r.session_id
    cands = [
        ("PING-1", True, json.dumps({"type": "message", "text": "PING-1"})),
        ("PING-2", True, json.dumps({"type": "message", "content": "PING-2"})),
        ("PING-3", True, "PING-3"),
        ("PING-4", True, json.dumps({"type": "user", "message": {"role": "user", "content": "PING-4"}})),
        ("PING-5", False, json.dumps({"type": "user", "message": {"role": "user", "content": "PING-5"}})),
        ("PING-6", True, json.dumps({"type": "user", "session_id": sid, "message": {"role": "user", "content": "PING-6"}})),
    ]
    tokfile = os.path.join(secret, "token.txt")
    for name, auth, line in cands:
        lf = os.path.join(out, f"cand_{name}.txt")
        open(lf, "w", encoding="utf-8").write(line)
        subprocess.run(["node", os.path.join(S, "inject.js"), sock, tokfile if auth else "-", lf, results], timeout=30)
        time.sleep(2)
r.wait(secrets=[token])
if os.path.exists(results):
    shutil.copy(results, os.path.join(RAW, "q3__inject_results.jsonl"))
shutil.rmtree(secret, ignore_errors=True)
notes["secret_dir_deleted"] = not os.path.exists(secret)
collect("q3", p)
seen = {f"PING-{i}": (f"PING-{i}" in (r.result_text() or "")) for i in range(1, 7)}
json.dump({"notes": notes, "pings_in_final_result": seen}, open(os.path.join(RAW, "q3__summary.json"), "w"), indent=1)
print(json.dumps({"rc": r.rc, "dur": r.dur, "notes": notes, "seen": seen, "result": r.result_text()}, indent=1))
