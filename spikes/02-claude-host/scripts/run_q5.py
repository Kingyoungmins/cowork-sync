"""q5: does a detached daemon spawned by a SessionStart hook survive `claude -p` exiting?"""
import json, os, subprocess, time
from runner import Run, SCRATCH, RAW, collect

p = os.path.join(SCRATCH, "q5daemon")
hb = os.path.join(p, "out", "heartbeat.jsonl")
r = Run("q5", p, "Reply with just OK.", ["--max-turns", "1"], 120,
        "q5 detached daemon survival (trivial prompt)").start().wait()
t_exit = int(time.time() * 1000)

def beats():
    return [json.loads(l) for l in open(hb)] if os.path.exists(hb) else []

def alive(pid):
    o = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    return str(pid) in o, o.strip()

spawn = [json.loads(l) for l in open(os.path.join(p, "out", "spawn_hook.jsonl"))]
pid = spawn[0]["daemon_pid"]
obs = {"claude_rc": r.rc, "claude_dur_s": r.dur, "t_claude_exit_ms": t_exit, "daemon_pid": pid,
       "beats_at_exit": len(beats()), "alive_at_exit": alive(pid)}
time.sleep(10)
obs["beats_after_10s"] = len(beats())
obs["alive_after_10s"] = alive(pid)
obs["last_beat_after_exit_ms"] = (beats()[-1]["t_ms"] - t_exit) if beats() else None
k = subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, text=True)
obs["taskkill"] = (k.returncode, k.stdout.strip() or k.stderr.strip())
time.sleep(1)
obs["alive_after_kill"] = alive(pid)
collect("q5", p)
json.dump(obs, open(os.path.join(RAW, "q5__summary.json"), "w"), indent=1)
print(json.dumps(obs, indent=1))
