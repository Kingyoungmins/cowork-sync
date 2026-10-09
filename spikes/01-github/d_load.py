"""(d) Push load ramp: 4 workers each own refs/cowork/main/load-<n> and push small commits with a lease.
Stages (total pushes/min, minutes): 6x5, 12x5, 24x5, 48x3. A 5th clone fetches one explicit refspec every
2.5 s during stages 3-4. No catch-up bursts: a slot that is >interval/2 late is skipped and logged.
Stops everything on 429 / secondary rate limit / abuse / 3x 5xx. Writes d_push.csv, d_fetch.csv, d_load.log/.json."""
import csv, json, os, sys, threading, time
from common import *

HERE = os.path.dirname(os.path.abspath(__file__))
STAGES = [(6, 300), (12, 300), (24, 300), (48, 180)]
PFX = "d_"
if len(sys.argv) > 1 and sys.argv[1] == "--smoke":
    STAGES, PFX = [(24, 20), (48, 10)], "dsmoke_"
if len(sys.argv) > 1 and sys.argv[1] == "--resume":  # after the false-positive stop at 856.8 s
    STAGES, PFX = [(24, 60), (48, 180)], "dresume_"
NW = 4
log = Log(os.path.join(HERE, PFX + "load.log"))
stop = threading.Event()
lock = threading.Lock()
pf = open(os.path.join(HERE, PFX + "push.csv"), "a", newline="")
pw = csv.writer(pf)
ff = open(os.path.join(HERE, PFX + "fetch.csv"), "a", newline="")
fw = csv.writer(ff)
if pf.tell() == 0:
    pw.writerow(["worker", "stage", "seq", "sched_t", "start_t", "secs", "rc", "stderr_first", "status"])
if ff.tell() == 0:
    fw.writerow(["start_t", "secs", "rc", "stderr_first", "new_sha"])
stop_reason = []

clones = {n: os.path.join(HERE, f"work-d-{n}") for n in range(1, NW + 2)}
for p in clones.values():
    init_clone(p)
main = ls_remote(clones[1], "refs/heads/main")["refs/heads/main"]
for p in clones.values():
    git(["fetch", "-q", "origin", "main"], cwd=p)


def first(err):
    """stderr first line + the first rejected/error/fatal line (if different)."""
    lines = err.strip().splitlines() or [""]
    key = next((l for l in lines if any(w in l for w in ("rejected", "error", "fatal", "remote:"))), "")
    return (lines[0] + (" || " + key if key and key != lines[0] else ""))[:300]


def worker(n, t_start):
    ref = f"refs/cowork/main/load-{n}"
    cwd = clones[n]
    last = ls_remote(cwd, ref).get(ref, "")
    seq = 0
    t_stage = t_start
    for si, (rate, dur) in enumerate(STAGES, 1):
        interval = 60.0 * NW / rate
        slot = t_stage + (n - 1) * interval / NW
        while slot < t_stage + dur and not stop.is_set():
            now = time.time()
            if now < slot:
                stop.wait(slot - now)
                if stop.is_set():
                    break
            now = time.time()
            if now - slot > interval / 2:
                with lock:
                    pw.writerow([n, si, "", round(slot, 3), round(now, 3), "", "", "", "skipped_late"]); pf.flush()
                slot += interval
                continue
            seq += 1
            parents = [last] if last else [main]
            c = new_commit(cwd, parents, f"load w{n} s{si} #{seq}", files={"load.txt": f"w{n} stage{si} seq{seq} {now}\n"})
            t0 = time.time()
            try:
                rc, out, err, dt = push(cwd, ["origin", f"{c}:{ref}", f"--force-with-lease={ref}:{last}"])
            except StopLoad as e:
                stop_reason.append(f"worker {n}: {e}"); stop.set(); break
            status = "ok" if rc == 0 else "fail"
            if rc == 0:
                last = c
            else:
                last = ls_remote(cwd, ref).get(ref, "")  # resync lease expectation
            with lock:
                pw.writerow([n, si, seq, round(slot, 3), round(t0, 3), round(dt, 3), rc, first(err), status]); pf.flush()
            slot += interval
        t_stage += dur


def fetcher(t_from, t_to):
    cwd = clones[NW + 1]
    ref = "refs/cowork/main/load-1"
    prev = ""
    if time.time() < t_from:
        stop.wait(t_from - time.time())
    nxt = time.time()
    while time.time() < t_to and not stop.is_set():
        t0 = time.time()
        rc, out, err, dt = git(["fetch", "-q", "origin", f"+{ref}:refs/remotes/origin/load-1"], cwd=cwd)
        try:
            check_throttle(err)
        except StopLoad as e:
            stop_reason.append(f"fetcher: {e}"); stop.set(); break
        sha = git(["rev-parse", "refs/remotes/origin/load-1"], cwd=cwd)[1].strip()
        with lock:
            fw.writerow([round(t0, 3), round(dt, 3), rc, (err.strip().splitlines() or [""])[0][:200], int(sha != prev)]); ff.flush()
        prev = sha
        nxt += 2.5
        if nxt > time.time():
            stop.wait(nxt - time.time())
        else:
            nxt = time.time()


t_start = time.time() + 3
log("START", "stages", STAGES, "t_start", t_start)
th = [threading.Thread(target=worker, args=(n, t_start)) for n in range(1, NW + 1)]
fetch_from = t_start + sum(d for _, d in STAGES[:-2]) if len(STAGES) >= 2 else t_start
th.append(threading.Thread(target=fetcher, args=(fetch_from, t_start + sum(d for _, d in STAGES))))
[t.start() for t in th]
[t.join() for t in th]
log("END", "runtime_s=%.1f" % (time.time() - t_start), "stop_reason", stop_reason or "none")
json.dump({"t_start": t_start, "stages": STAGES, "stop_reason": stop_reason,
           "runtime_s": time.time() - t_start}, open(os.path.join(HERE, PFX + "load.json"), "w"), indent=1)
