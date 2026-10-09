# Spike 01-github — custom refs, leases, Actions trigger, push load on GitHub

Run 2026-10-01 17:29–18:06 KST from one Windows 11 PC (git 2.55.0.windows.3, Python 3.12.10, Git Credential Manager),
against the private sandbox `https://github.com/Kingyoungmins/cowork-sync-sandbox.git` (token scopes seen in
`X-OAuth-Scopes`: `gist, read:org, repo, workflow`; Actions enabled). No other remote was pushed to. `claude -p` runs: 0.
All sandbox refs were left in place (list in `raw/e_final.json`).

Covers part of SPIKE-0 items **a** (push tolerance, Actions on custom refs) and **b** (CAS race) of 11-testing §3.18,
but from **one PC on one network** — see "Not measured" below.

## Questions

| # | Question |
|---|---|
| a | Do custom refs `refs/cowork/main/{board,code}` push/fetch? Two-parent commit on a custom ref? `--force-with-lease` success, stale-lease rejection, create with empty expect, delete? Are `atomic` / `push-options` advertised? Does REST `GET /git/ref/cowork/main/board` work? |
| b | Does an unfiltered `on: push` workflow run for pushes to `refs/cowork/*` (with and without skip markers), compared with a normal branch? |
| c | In 100 simultaneous leased pushes from two clones on the same tip: exactly one winner every time? Double wins / both lost / ambiguous? Push latency? |
| d | Push load ramp 6 → 12 → 24 → 48 pushes/min (4 workers, one custom ref each): latency per stage, failures, throttling? Fetch latency at 1 per 2.5 s? |

## Method

All scripts are in this folder (credentials removed by construction: the token is taken only via `git credential fill`
inside `common.py:_token()`, kept in memory, used only for the REST `Authorization` header; git uses the credential
helper itself; `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`). Every push goes through `common.push()`, which
asserts `origin` is the sandbox URL and stops on throttle text / 3 consecutive 5xx (rule 6).
Commits are built with plumbing (`hash-object`, `mktree`, `commit-tree`) and pushed as `<sha>:<full ref>`.

| Step | Script | Run as |
|---|---|---|
| a | `a_caps.py` (+ `a_fix_main.py`, see incident 1) | `python a_caps.py`; `GIT_TRACE_PACKET=<file>` on the first push captures the receive-pack advertisement |
| b | `b_actions.py` | `python b_actions.py` — adds `.github/workflows/probe.yml` (`on: push`, no filter, one `echo` job) on main; pushes three commits **that all contain probe.yml** (children of the workflow commit) to `refs/cowork/main/probe-a` (no markers), `refs/cowork/main/probe-b` (subject `… [skip ci] ***NO_CI***`, trailer `skip-checks: true`), `refs/heads/probe-branch` (no markers); waits 180 s; lists `/actions/runs` and matches by `head_sha`; reads `/events` (webhook proxy); removes the workflow from main **and** from probe-branch; polls `status=queued` / `status=in_progress` until both 0 and the total unchanged for ≥ 60 s |
| c | `c_race.py`, `c_summary.py` | `python c_race.py 100`. Clones `work-c-A`, `work-c-B`. Per round: both fetch `refs/cowork/main/race`, assert same tip, each builds a distinct child, `threading.Barrier(2)`, both run `git push --porcelain origin <child>:refs/cowork/main/race --force-with-lease=refs/cowork/main/race:<tip>`; **ground truth = `ls-remote` after both return** |
| d | `d_load.py`, `d_stats.py`, `d_analyze.py` | `python d_load.py` then `python d_load.py --resume` (incident 2). 4 workers each own `refs/cowork/main/load-<n>`, push one-file commits with lease = own last sha; per-worker interval 40/20/10/5 s, workers phase-offset by interval/4; a slot > interval/2 late is skipped, never caught up. A 5th clone runs `git fetch -q origin +refs/cowork/main/load-1:refs/remotes/origin/load-1` every 2.5 s during the last two stages |
| final | `e_final.py` | Actions runs, workflows, `/events`, remote ref list after everything |

## Raw data (`raw/`, not published)

The raw logs were removed before publication because they held machine-local paths and other local details. The file
names below are kept so each citation in this README still names the log a number came from; every number quoted here
was copied from those logs.

`a_caps.log` · `a_caps.json` · `a_trace_push.txt` (packet trace, redacted) · `b_actions.log` · `b_actions.json` ·
`c_race.log` · `c_race.csv` (one row per round) · `c_race.json` · `c_summary.json` ·
`d_load.log` · `d_push.csv` · `d_fetch.csv` · `d_load.json` · `d_stats.json` (stages 1–3) ·
`dresume_load.log` · `dresume_push.csv` · `dresume_fetch.csv` · `dresume_stats.json` (rest of stage 3 + stage 4) ·
`dsmoke_*` (30 s smoke test of the script, 16 pushes) · `d_analyze.json` (did failed pushes land; overlap) · `e_final.json`.

## Results

### (a) Capabilities — all MEASURED, `raw/a_caps.log`, `raw/a_caps.json`, `raw/a_trace_push.txt`

| Check | Result | Exact output |
|---|---|---|
| receive-pack advertises `atomic` | **yes** | `report-status report-status-v2 delete-refs side-band-64k ofs-delta atomic object-format=sha1 quiet agent=github/spokes-receive-pack-… session-id=… push-options` |
| receive-pack advertises `push-options` | **yes** | (same line) |
| push create `refs/cowork/main/board`, `…/code` | ok, 1.66 s / 1.73 s | `* [new reference]   <sha> -> refs/cowork/main/board` |
| plain `git fetch origin` in a fresh clone brings custom refs | **no** | only `refs/heads/main`, `refs/remotes/origin/{HEAD,main}` |
| explicit `git fetch origin +refs/cowork/main/*:refs/remotes/origin-cowork/*` | ok, 1.91 s, both refs | `* [new ref]  refs/cowork/main/board -> origin-cowork/board` |
| two-parent commit pushed to board with correct lease | ok; re-fetched commit has parents `[board1, code1]` in that order | `60bbdc1..e7c5aa5  <sha> -> refs/cowork/main/board` |
| lease success (`--force-with-lease=B:<current>`) | ok, rc 0 | `e7c5aa5..0a8f661  <sha> -> refs/cowork/main/board` |
| stale lease (expect = previous tip) | rejected, rc 1, ref unchanged | ` ! [rejected]        <sha> -> refs/cowork/main/board (stale info)` / `error: failed to push some refs to '…'` |
| create with empty expect (`--force-with-lease=R:`) on missing ref | ok | `* [new reference]   <sha> -> refs/cowork/main/lease-new` |
| same, ref now exists | rejected, rc 1 | ` ! [rejected]        <sha> -> refs/cowork/main/lease-new (stale info)` |
| delete with stale lease | rejected, rc 1 | ` ! [rejected]        (delete) -> refs/cowork/main/del-probe (stale info)` |
| delete with correct lease | ok, ref gone (ls-remote) | ` - [deleted]         refs/cowork/main/del-probe` |
| `--atomic`, 2 refs, one lease stale | rc 1, **neither ref moved** (ls-remote before = after) | ` ! [rejected] … -> refs/cowork/main/board (atomic push failed)` / ` ! [rejected] … -> refs/cowork/main/code (stale info)` |
| `--atomic`, 2 refs, both leases correct | ok, both moved | |
| `git push -o cowork-probe=1` to a custom ref | ok, rc 0 | `* [new reference] … -> refs/cowork/main/po-probe` |
| REST `GET /repos/Kingyoungmins/cowork-sync-sandbox/git/ref/cowork/main/board` | 200, `ref: refs/cowork/main/board`, sha equals ls-remote | |
| REST `GET …/git/matching-refs/cowork/` | 200, lists board, code, lease-new, po-probe | |

Note: every lease rejection in (a) is the **client-side** `(stale info)` check (the client saw the moved ref in the
advertisement). The concurrent case (c) produces a different, **server-side** line.

### (b) Actions trigger — MEASURED, `raw/b_actions.log`, `raw/b_actions.json`, `raw/e_final.json`

| Push (commit contains probe.yml) | Ref | Workflow run? |
|---|---|---|
| add workflow (baseline) | `refs/heads/main` | **yes** — `push`, head_branch `main`, success |
| no markers | `refs/cowork/main/probe-a` | **no** |
| `[skip ci] ***NO_CI***` + `skip-checks: true` | `refs/cowork/main/probe-b` | **no** |
| no markers | `refs/heads/probe-branch` | **yes** — `push`, head_branch `probe-branch`, success |
| remove workflow (commit without probe.yml) | `refs/heads/main`, `refs/heads/probe-branch` | no |

After cleanup: `queued=0 in_progress=0 total=2`, unchanged for ≥ 60 s (6 polls, 17:35:02–17:36:23); at the very end
(after c and d, ~30 min later) still exactly 2 runs and `/actions/workflows` empty. Repo `/events` feed: 0 events with a
`refs/cowork/*` ref out of 5 returned (PushEvent only for `refs/heads/main` ×2 and `refs/heads/probe-branch`). The
events feed is lossy (it showed 2 of the 5 pushes to main), so it is only a weak proxy for webhooks.

### (c) Lease race, 100 rounds — MEASURED, `raw/c_race.csv`, `raw/c_race.log`, `raw/c_summary.json`

| Metric | Value |
|---|---|
| rounds with exactly 1 winner (exit codes and ls-remote agree) | **100 / 100** |
| double wins | **0** |
| both lost | **0** |
| ambiguous (exit code disagrees with ls-remote) | **0** |
| wins A / B | 47 / 53 |
| loser's line | 100 / 100: ` ! <sha>:refs/cowork/main/race  [remote rejected] (cannot lock ref 'refs/cowork/main/race': is at <winner> but expected <tip>)` — never the client-side `(stale info)` |
| push latency, winner | p50 1.757 s, p95 1.850 s, max 2.246 s |
| push latency, loser | p50 1.841 s, p95 1.964 s, max 2.529 s |
| all attempts | p50 1.799 s, p95 1.927 s, min 1.644 s, max 2.529 s |
| start skew between the two `git push` spawns | ≤ 1.0 ms (Python `time.time()`, nominal resolution 15.6 ms on this OS) |

Both clones were on the same PC and network, so both requests reached GitHub within a few ms of each other; the
server-side `cannot lock ref … is at <winner>` line in every round shows both pushes passed the client lease check and
the server's compare-and-swap decided.

### (d) Push load ramp — MEASURED, `raw/d_push.csv`, `raw/dresume_push.csv`, `raw/d_stats.json`, `raw/dresume_stats.json`, `raw/d_analyze.json`

| Stage (target/min) | Pushes | Achieved/min | p50 s | p95 s | max s | Failed | Throttle text (429 / secondary / abuse) |
|---|---|---|---|---|---|---|---|
| 1 (6), 300 s | 30 | 6.0 | 1.783 | 1.875 | 1.927 | 0 | none |
| 2 (12), 300 s | 60 | 12.0 | 1.797 | 2.238 | 2.941 | 0 | none |
| 3 (24), first 256.8 s | 102 | 23.8 | 1.746 | 1.989 | 2.766 | 0 | none |
| 3 (24), resumed 60 s | 24 | 24.0 | 1.878 | 2.476 | 2.698 | 0 | none |
| 4 (48), 180 s | 144 | 48.0 | 1.890 | 2.817 | 3.123 | **15 (10.4 %)** | none |

No slot was skipped as late in any stage. Stage 4 failures, exact lines:
- 14 × ` ! [remote rejected] <sha> -> refs/cowork/main/load-<n> (failed)`
- 1 × `remote: fatal error in commit_refs`

None of the 15 rejected commits is on its ref afterwards (`git merge-base --is-ancestor` false for all 14 with a sha;
the `commit_refs` one is absent from the ref's history), so every failure left the ref unchanged — no hidden landing.
Each worker pushed only to its own ref with a correct lease, so these are **not** lease losses. In stage 4 every push
overlapped another worker's push to a different ref (144/144); in stages 1–3, 4 pushes overlapped and none failed. So
the data cannot separate "rate" from "concurrent pushes to different refs of one repo" as the cause.

Fetch (5th clone, one explicit refspec every 2.5 s), MEASURED `raw/d_fetch.csv`, `raw/dresume_fetch.csv`:

| Window | Fetches | p50 s | p95 s | max s | Failed |
|---|---|---|---|---|---|
| stage 3 (first 256.8 s) | 103 | 1.062 | 1.425 | 1.721 | 0 |
| stage 3 resumed | 24 | 1.213 | 1.582 | 1.586 | 0 |
| stage 4 | 72 | 1.218 | 1.531 | 1.595 | 0 |

### Totals

| | Push attempts |
|---|---|
| (a) incl. 4 intended rejections + 2 README-fix pushes | 18 |
| (b) | 6 |
| (c) 1 seed + 2 × 100 | 201 |
| (d) smoke 16 + 192 + 168 | 376 |
| **Total** | **601** (plus 199 timed fetches in d) |

Total runtime 17:29:54 → 18:05:57 = **36 min** (a ≈ 0.6 min, b ≈ 4.6 min, c ≈ 8.9 min, d 0.5 + 14.3 + 4.0 min).
No HTTP 429, secondary-rate-limit, abuse or 5xx response was seen anywhere. REST budget used: ~37 of 5,000.

## Answers

| Q | Answer | Confidence |
|---|---|---|
| a1 custom refs push + explicit fetch | **YES** | high (MEASURED) |
| a2 default fetch brings custom refs | **NO** — explicit refspec needed | high |
| a3 two-parent commit on custom ref | **YES** | high |
| a4 lease success / stale rejection / empty-expect create / delete | **YES / YES (`(stale info)`) / YES (and re-create rejected) / YES (stale delete rejected)** | high |
| a5 `atomic` advertised and enforced | **YES** (advertised; one stale lease → neither ref moved) | high |
| a6 `push-options` advertised and accepted | **YES** | high |
| a7 REST `git/ref/cowork/main/board` | **YES**, 200, sha matches | high |
| b1 unfiltered `on: push` runs for `refs/cowork/*` | **NO** (0 runs, with or without markers) | high for this repo/day; one sample per case |
| b2 same workflow runs for `refs/heads/*` | **YES** (main and probe-branch) | high |
| b3 skip markers needed on custom refs for Actions | **NOT DETERMINABLE** here — custom refs did not trigger even without markers | — |
| c lease atomic under a 2-client race | **YES**: 100/100 single winner, 0 double, 0 both-lost, 0 ambiguous | high for same-network clients |
| d1 throttling at 6–24 pushes/min | **NO** (0 failures, 0 throttle text, 216 pushes) | high for 18 min from one IP |
| d2 failures at 48 pushes/min | **YES, 10.4 %** server-side `(failed)` / `fatal error in commit_refs`, no 429 | medium on cause (rate vs concurrency not separable) |
| d3 push latency | p50 ≈ 1.75–1.9 s, p95 ≤ 2.8 s, max 3.1 s | high (this PC, includes GCM helper) |
| d4 fetch latency at 1/2.5 s | p50 ≈ 1.1–1.2 s, p95 ≤ 1.6 s, 0 failures / 199 | high |

## Not measured (and why)

- Clients on different networks/PCs (SPIKE-0 a and b ask for 4 / 2 networks): only one PC was available. The race
  result is for two clones on one host; an NTP-aligned cross-network race was not run.
- Webhook deliveries: no webhook endpoint exists for this spike; only the `/events` feed (weak proxy) was read.
- Push protection on custom refs, push rulesets on custom refs, a branch-push control phase for throttling, 60/min,
  4-peer fetch for 60 min: not part of this task.
- The 48/min stage only ran its 180 s in the resumed run (incident 2), after a 4-minute pause.

## Incidents

1. First `a_caps.py` run wrote tree entries via text-mode stdin, so Windows turned `\n` into `\r\n` and main's tree held
   `README.md\r` (clone checkout failed: `invalid path 'README.md?'`). Fixed in `common.new_commit` (bytes stdin) and
   corrected by two fast-forward commits on main (`a_fix_main.py`, the first of which still had the bug). Custom refs
   `board`, `code`, `lease-new`, `po-probe` from (a) still have trees with `\r`-suffixed names; it does not affect any
   ref/lease result.
2. `d_load.py` stopped itself at 856.8 s (stage 3) because the rule-6 regex matched the bare string `429` inside a
   commit sha printed by a **successful** push (`15ad0c682bfd9e4429e3dc…`, which is the current tip of `load-3`). This was
   a false positive, verified by ls-remote. The regex now excludes hex-adjacent matches, and the remaining 60 s of stage 3
   and all of stage 4 ran with `--resume` (prefix `dresume_`).

## Implications for the spec

1. **02-protocol §3.10 / PRO-50 and the 02-protocol non-goal "`--atomic` pushes"**: GitHub advertises `atomic` and
   enforces it (one stale lease → neither ref moved). The "never probed, never used" rule is a choice, not a host limit.
   If the board + mirror pair stays non-atomic, the reason should be written as "portability to other hosts". If not,
   `--atomic` for board+code could remove the non-atomic-pair failure class on hosts that advertise it (would need a
   `caps.atomic` probe step).
2. **01-engine ENG-44 / open question 6 (NONRETRYABLE threshold)**: the CAS loser on GitHub gets the server-side
   `[remote rejected] (cannot lock ref '…': is at <winner> but expected <tip>)` (100/100), never `(stale info)`, and the
   board always **had** changed. ENG-44's "re-fetch; T′ ≠ T → CAS loss" classifies it correctly; a text classifier
   that knows only `(stale info)` would not. Test 17(a) of 01-engine matches what GitHub does.
3. **New for ENG-44/ENG-45**: at 48 pushes/min, 10.4 % of pushes failed with `[remote rejected] … (failed)` or
   `remote: fatal error in commit_refs` while the ref stayed unchanged (T′ == T with a structured rejection line). As
   written, ENG-44 sends that to ENG-45 = NONRETRYABLE after one attempt, which would pin a publish on a transient host
   failure. Suggest: treat `(failed)` / `commit_refs` rejections (or any rejection of a ref that the lease would allow) as
   retryable with back-off, or require ≥ 2 identical rejections before NONRETRYABLE. Answers open question 6 against the
   "one attempt" default.
4. **Glossary §20 governor (≤ 6 attempts/min team-wide) and SPIKE-0 a**: 6, 12 and 24/min on custom refs gave 0
   failures and no throttle text for 5 min each; the U3 budget has ≥ 4× headroom on this measurement. The
   "governor B = 4" fallback is not triggered by this data. Latency budget per push ≈ 1.8 s p50 / ≤ 2.8 s p95.
5. **09-security §3.9 / SEC-16 and SPIKE-0 a "workflows fire despite markers"**: an unfiltered `on: push` workflow did
   **not** run for `refs/cowork/*` pushes, with or without markers, but did for `refs/heads/*`. The `CI_FIRES_ON_LIVE_REFS`
   refusal is not needed for GitHub Actions in the primary namespace; it stays relevant for the fallback namespace
   `refs/heads/cowork/*` (SEC-16 is right to warn). Markers are harmless and can stay for other hosts.
6. **Glossary §4 fetch refspecs**: confirmed necessary — a default `git fetch` never brings `refs/cowork/*`.
7. **02-protocol §3.10 probe steps 1–5**: every primitive used (ABSENT-lease create, two-parent push, stale-lease
   rejection with ref unchanged, `-o` push option, leased delete) works on GitHub; expected `caps` =
   `{custom_refs: true, lease: true, delete: true, push_options: true, two_parent_ok: true}`.
8. **Fetch polling (ENG-13, 2.5 s)**: one fetch takes ≈ 1.1–1.2 s p50, 0 failures in 199 — fits the 2.5 s interval for a
   single peer; the 4-peer read rate was not measured.
