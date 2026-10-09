"""q3 IDLE: -p with --input-format stream-json keeps the process alive after turn 1. Inject one documented
frame while the session is idle and watch ~40 s for a new turn; then close stdin."""
import json, os, shutil, subprocess, sys, time
from runner import Run, SCRATCH, RAW, collect

S = os.path.dirname(os.path.abspath(__file__))
p = os.path.join(SCRATCH, "q3inbox")
for f in os.listdir(os.path.join(p, "out")):
    fp = os.path.join(p, "out", f)
    shutil.rmtree(fp) if os.path.isdir(fp) else os.remove(fp)
out, secret = os.path.join(p, "out"), os.path.join(p, "out", "secret")
LABEL = sys.argv[1] if len(sys.argv) > 1 else "q3idle"
ACCEPT = "--default-inbound" not in sys.argv  # without the flag file: crossSessionInbound left at its default
flag = ["--settings", os.path.join(SCRATCH, "flag_settings_accept.json")] if ACCEPT else []
r = Run(LABEL, p, None, flag + ["--max-turns", "3", "--replay-user-messages"], 150,
        f"q3 idle delivery (crossSessionInbound={'accept' if ACCEPT else 'default'})", stdin_stream=True).start()

def results_count():
    n = 0
    for _, l in list(r.lines):
        if '"type":"result"' in l:
            n += 1
    return n

notes = {}
r.send_user("Reply with just OK.")
end = time.time() + 60
while time.time() < end and results_count() < 1:
    time.sleep(0.3)
notes["turn1_result_seen"] = results_count() >= 1
notes["token_file_seen"] = os.path.exists(os.path.join(secret, "token.txt"))
token = open(os.path.join(secret, "token.txt")).read().strip() if notes["token_file_seen"] else ""
sock = open(os.path.join(secret, "socket.txt")).read().strip() if notes["token_file_seen"] else ""
notes["socket_differs_from_orchestrator"] = bool(sock) and sock != os.environ.get("CLAUDE_CODE_MESSAGING_SOCKET")
results = os.path.join(out, "inject_results.jsonl")
if notes["turn1_result_seen"] and notes["socket_differs_from_orchestrator"]:
    time.sleep(3)
    lf = os.path.join(out, "cand_PING-7.txt")
    open(lf, "w").write(json.dumps({"type": "user", "message": {"role": "user", "content": "PING-7: reply with just PONG-7"}}))
    notes["inject_t_ms"] = int(time.time() * 1000)
    subprocess.run(["node", os.path.join(S, "inject.js"), sock, os.path.join(secret, "token.txt"), lf, results], timeout=30)
    end = time.time() + 40
    while time.time() < end and results_count() < 2:
        time.sleep(0.3)
    notes["turn2_result_seen_within_40s"] = results_count() >= 2
notes["pong7_in_stream"] = any("PONG-7" in l for _, l in r.lines)
r.p.stdin.close()
r.wait(secrets=[token])
if os.path.exists(results):
    shutil.copy(results, os.path.join(RAW, f"{LABEL}__inject_results.jsonl"))
shutil.rmtree(secret, ignore_errors=True)
notes["secret_dir_deleted"] = not os.path.exists(secret)
collect(LABEL, p)
json.dump(notes, open(os.path.join(RAW, f"{LABEL}__summary.json"), "w"), indent=1)
print(json.dumps({"rc": r.rc, "dur": r.dur, "notes": notes}, indent=1))
