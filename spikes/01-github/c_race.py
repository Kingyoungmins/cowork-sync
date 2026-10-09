"""(c) Lease race: clones A and B push distinct children of the same tip simultaneously with
--force-with-lease=<ref>:<tip>. Ground truth = ls-remote after both return. Writes c_race.log/.csv/.json."""
import csv, json, os, sys, threading, time
from common import *

HERE = os.path.dirname(os.path.abspath(__file__))
REF = "refs/cowork/main/race"
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 100
log = Log(os.path.join(HERE, "c_race.log"))
CL = {n: os.path.join(HERE, "work-c-" + n) for n in "AB"}
for n, p in CL.items():
    init_clone(p)

# seed the race ref from main (created only if missing)
main = ls_remote(CL["A"], "refs/heads/main")["refs/heads/main"]
git(["fetch", "-q", "origin", "main"], cwd=CL["A"])
if REF not in ls_remote(CL["A"], REF):
    seed = new_commit(CL["A"], [main], "race seed", files={"race.txt": "seed\n"})
    rc, _, err, _ = push(CL["A"], ["origin", f"{seed}:{REF}", f"--force-with-lease={REF}:"])
    log("seed", rc, err.strip().replace("\n", " | "))

rows = []
for rnd in range(1, ROUNDS + 1):
    tips = {}
    for n, p in CL.items():
        rc, _, err, dt = git(["fetch", "-q", "origin", f"+{REF}:refs/remotes/origin/race"], cwd=p)
        check_throttle(err)
        tips[n] = git(["rev-parse", "refs/remotes/origin/race"], cwd=p)[1].strip()
    if tips["A"] != tips["B"]:
        log("round", rnd, "TIPS DIFFER", tips); continue
    tip = tips["A"]
    child = {n: new_commit(CL[n], [tip], f"race r{rnd} by {n}", files={"race.txt": f"r{rnd} {n}\n"}) for n in CL}
    bar = threading.Barrier(2)
    res = {}

    def run(n):
        bar.wait()
        t0 = time.time()
        rc, out, err, dt = git(["push", "--porcelain", "origin", f"{child[n]}:{REF}",
                                f"--force-with-lease={REF}:{tip}"], cwd=CL[n])
        res[n] = {"start": t0, "rc": rc, "secs": dt, "out": out, "err": err}

    th = [threading.Thread(target=run, args=(n,)) for n in CL]
    [t.start() for t in th]; [t.join() for t in th]
    for n in CL:
        check_throttle(res[n]["err"])
    truth = ls_remote(CL["A"], REF).get(REF)
    rc_win = [n for n in CL if res[n]["rc"] == 0]
    truth_win = [n for n in CL if child[n] == truth]
    if len(rc_win) == 1 and truth_win == rc_win:
        cls = "one_winner"
    elif len(rc_win) == 2:
        cls = "double_win"
    elif len(rc_win) == 0 and truth == tip:
        cls = "both_lost"
    else:
        cls = "ambiguous"
    loser_reason = ""
    for n in CL:
        if res[n]["rc"] != 0:
            pl = [l for l in res[n]["out"].splitlines() + res[n]["err"].splitlines() if "rejected" in l or l.startswith("!")]
            loser_reason = pl[0].strip() if pl else (res[n]["err"].strip().splitlines() or [""])[0]
    row = {"round": rnd, "class": cls, "winner_by_rc": ",".join(rc_win), "winner_by_ls_remote": ",".join(truth_win),
           "start_skew_ms": round(abs(res["A"]["start"] - res["B"]["start"]) * 1000, 1),
           "A_rc": res["A"]["rc"], "A_secs": round(res["A"]["secs"], 3),
           "B_rc": res["B"]["rc"], "B_secs": round(res["B"]["secs"], 3), "loser_reason": loser_reason}
    rows.append(row)
    log("round", rnd, cls, "win_rc=%s win_truth=%s skew=%sms A=%.2fs B=%.2fs" % (
        row["winner_by_rc"], row["winner_by_ls_remote"], row["start_skew_ms"], row["A_secs"], row["B_secs"]), loser_reason)

with open(os.path.join(HERE, "c_race.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
summ = {}
for r in rows:
    summ[r["class"]] = summ.get(r["class"], 0) + 1
reasons = {}
for r in rows:
    k = r["loser_reason"].split("(")[-1] if "(" in r["loser_reason"] else r["loser_reason"]
    reasons[k] = reasons.get(k, 0) + 1
lat = sorted([r["A_secs"] for r in rows] + [r["B_secs"] for r in rows])
q = lambda p: lat[min(len(lat) - 1, int(p * len(lat)))]
S = {"rounds": len(rows), "classes": summ, "loser_reasons": reasons,
     "wins": {"A": sum(r["winner_by_ls_remote"] == "A" for r in rows), "B": sum(r["winner_by_ls_remote"] == "B" for r in rows)},
     "push_latency_s": {"p50": q(0.5), "p95": q(0.95), "max": lat[-1], "min": lat[0]},
     "start_skew_ms_max": max(r["start_skew_ms"] for r in rows)}
json.dump(S, open(os.path.join(HERE, "c_race.json"), "w"), indent=1)
log("SUMMARY", S)
