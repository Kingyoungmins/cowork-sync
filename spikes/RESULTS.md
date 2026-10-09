# SPIKE-0 results: synthesis of spikes 01–04

Written 2026-10-01 19:30 KST. Sources: the four spike READMEs (`01-github/`, `02-claude-host/`, `03-real-filter/`, `04-contention/`), their `raw/` folders, and the overnight credential log `<scratch>/overnight/gcm_watch.log` (snapshot at 19:32 in `_synthesis-raw/`).

**Raw logs not published.** The spikes' `raw/` folders were removed before publication because they held machine-local paths and a pilot team's repository file lists. Links into `raw/` below are kept as citations of the source log and no longer resolve; every number here was copied from those logs. The pilot repository and its files appear under neutral names (its 1.3 MB hot file is called `hub.py`).

**Spec revision compared against.** `docs/spec/00-glossary.md` at rev 2.2 (§25 present; file mtime 18:55:24, sha256 prefix `7b8aaf2dc8e2`), read at about 19:20 KST. At that time chapters 01, 03, 06, 07, 09 and 11 still contained pre-§25 text (examples are in "What changes in the spec", bucket A). Another process is editing `docs/` at the same time, so re-check the bucket A lines against the current files before acting on them.

**This synthesis** ran no experiments: 0 `claude -p` runs, 0 pushes, and no network calls. It read files and copied the overnight log into [`_synthesis-raw/`](_synthesis-raw/) so the item f evidence is inside the repo.

**Placement.** TST-27 requires the SPIKE-0 report at `docs/spikes/SPIKE-0.md`. This file is the input for that report. It sits in `spikes/` because this task may not write under `docs/`.

**Labels.** MEASURED means a raw log in this repo backs the number. NOT MEASURED means nobody ran it, and the reason is given. The verdict column uses the PASS column of 11-testing §3.18: **PASS**; **FAIL → routed** (failed, and a spec change exists or is proposed); **INCOMPLETE** (the measured part meets PASS, but the required setup, such as several PCs, OSes or exit forms, was not run); **NOT DONE**.

---

## Bottom line

1. **No show-stopper was found.** The GitHub lease is atomic: 100 of 100 races had exactly one winner and 0 had two. Every custom-ref primitive works. An unfiltered `on: push` workflow does not run for `refs/cowork/*`. `filter.<d>.required=true` fails closed in every failure mode tried. A private-index snapshot equals HEAD in 51 of 51 trees and never touches the real index.
2. **Three items fail their §3.18 PASS criterion: g, i and j.** Each has a routed remedy. For g and j, glossary §25 already contains it. For i, the remedy is the §3.18 default and is not yet written into the glossary.
3. **Item h passes. Five items (a–e) are incomplete in scope.** The cause is one PC, one network, one OS, `claude -p` only and no TTY. **Item f has not been done.** The overnight log is only supporting evidence.
4. **The gate as written (TST-27/28) is not met.** See "Go / No-go" at the end.

---

## The 10 SPIKE-0 questions

| §3.18 | Design §9 | Question | Answer | Label | Verdict vs §3.18 PASS | Evidence |
|---|---|---|---|---|---|---|
| **a** | 1 | GitHub push tolerance: does the U3 budget hold, and how do custom refs behave? | At **6, 12 and 24 pushes/min** (4 workers, separate `refs/cowork/main/load-n`): **0 failures**, and no 429, secondary-limit, abuse or 5xx text. Push p50 ≈ 1.8 s, p95 ≤ 2.8 s. At **48/min**: 15/144 (10.4 %) server rejections `[remote rejected] … (failed)` / `remote: fatal error in commit_refs`, ref unchanged, no throttle text. An unfiltered `on: push` workflow made **0 runs** for `refs/cowork/*` (with and without skip markers) and ran for `refs/heads/*`. One clone fetching every 2.5 s: p95 ≤ 1.6 s, 0/199 failed. | MEASURED on 1 PC, 1 network, 36 min. NOT MEASURED: 4 clients on 4 networks, 30-min governed phase, 60/min, branch-push control phase, webhook deliveries, push protection and rulesets on custom refs, 4-peer 60-min fetch, publish p95 (needs the daemon). | **INCOMPLETE.** The measured part meets PASS: 0 throttling at ≤ 6/min and 0 workflow runs. | [d_stats.json](01-github/raw/d_stats.json), [dresume_stats.json](01-github/raw/dresume_stats.json), [d_analyze.json](01-github/raw/d_analyze.json), [b_actions.json](01-github/raw/b_actions.json), [e_final.json](01-github/raw/e_final.json), [a_caps.json](01-github/raw/a_caps.json) |
| **b** | 2 | Two-PC CAS race: is the lease atomic on GitHub? | **100/100 rounds had exactly one winner. 0 double wins, 0 both-lost, 0 ambiguous** (exit codes agree with `ls-remote`). The loser line is always server-side: `[remote rejected] (cannot lock ref '…': is at <winner> but expected <tip>)`, never `(stale info)`. `ls-remote` shows the ref moved in every round, so ENG-44's re-fetch rule (T′ ≠ T → CAS loss, retryable) classifies 100/100 as retryable. The structural classifier does not exist yet and was not run. | MEASURED: 2 clones on 1 PC, start skew ≤ 1 ms. NOT MEASURED: 2 PCs on different networks. | **INCOMPLETE.** Same-host PASS. The "v1 does not ship on this host" trigger (any double win) did not fire. | [c_race.csv](01-github/raw/c_race.csv), [c_summary.json](01-github/raw/c_summary.json) |
| **c** | 3 | Inbox socket wire format; idle and mid-turn delivery | Only `{"type":"auth","token":…}` followed by **`{"type":"user","message":{"role":"user","content":…}}`** is delivered. The spec default `{"type":"message",…}` is **silently dropped**. The server sends **0 bytes back** for every frame; without auth it closes the connection after 2 ms. Idle session (`-p --input-format stream-json`): a new turn starts 30–36 ms after posting (4/4). Mid-turn: the message is queued and injected after the current tool result, in the same turn. UserPromptSubmit fires for each delivered message with the raw text and a new `prompt_id`. The model sees it wrapped as "Another Claude session sent a message …". | MEASURED on Windows, Claude Code 2.1.270, `-p` mode. NOT MEASURED: macOS/Linux, interactive TTY idle, `crossSessionInbound` hold/refuse on the wire, burst limits, whether slash text inside a message is expanded. | **INCOMPLETE.** Windows idle and mid-turn delivery pass. The other two OSes and slash-text expansion are unmeasured. Wire-format change routed (glossary §25 F1/F2). | [q3__inject_results.jsonl](02-claude-host/raw/q3__inject_results.jsonl), [q3.debug.filtered.log](02-claude-host/raw/q3.debug.filtered.log), [q3idle2__userpromptsubmit.jsonl](02-claude-host/raw/q3idle2__userpromptsubmit.jsonl), [q3idle3__userpromptsubmit.jsonl](02-claude-host/raw/q3idle3__userpromptsubmit.jsonl) |
| **d** | 4 | Do MCP servers inherit `CLAUDE_CODE_MESSAGING_SOCKET/TOKEN`? | **YES for a project stdio MCP server on Windows.** The socket path is identical to the SessionStart hook's. The token is present in both (length 32). `CLAUDE_PROJECT_DIR` is present. **`CLAUDE_PLUGIN_DATA` is absent.** Token equality was checked by length only. The hook-env token did authenticate to the socket in c. | MEASURED (Windows, project MCP). NOT MEASURED: plugin-packaged MCP server, macOS/Linux, token SHA-256 equality. | **INCOMPLETE.** Windows project-MCP meets PASS for the socket. 2 of 3 OSes and the plugin case are missing. | [q4__mcp_env.jsonl](02-claude-host/raw/q4__mcp_env.jsonl), [q4__sessionstart.jsonl](02-claude-host/raw/q4__sessionstart.jsonl) |
| **e** | 5 | Does a detached daemon survive `claude` exiting on Windows? | **YES for the path measured.** The daemon was spawned from a SessionStart hook (`detached`, `stdio:'ignore'`, `windowsHide`, `unref`). It was alive at claude exit and 10 s later, with heartbeats continuing (the last one 10.25 s after exit). The spawning hook's output was collected 73 ms after the spawn, so the detached child did not hold the hook (1 sample). | MEASURED: normal `claude -p` exit, claude launched from Python (no job object), 10 s observation. NOT MEASURED: 60 s observation; `/exit`, closing the terminal window, killing the process tree, closing VS Code (job-object launchers); a spawn from `mcp.js` as §3.18 e specifies. | **INCOMPLETE.** | [q5__summary.json](02-claude-host/raw/q5__summary.json), [q5__heartbeat.jsonl](02-claude-host/raw/q5__heartbeat.jsonl), [q5__spawn_hook.jsonl](02-claude-host/raw/q5__spawn_hook.jsonl), [q5.debug.filtered.log](02-claude-host/raw/q5.debug.filtered.log) |
| **f** | 6 | Does GCM refresh non-interactively? | **Not answered yet.** The overnight watcher is *not* the §3.18 procedure; see "Overnight credential log" below. So far it has **14 non-interactive `ls-remote` probes (17:24–19:27)**: 11 with exit 0 (0.95–2.26 s each), and 3 early lines with `exit=-1`, which the script itself attributes to a logging artifact. Supporting evidence: spike 01 made 601 pushes with `GCM_INTERACTIVE=never` and saw no prompt. | NOT MEASURED: fetch every 2.5 s for ≥ 24 h in DAEMON_ENV with `GCM_TRACE=1`; forced revocation → `publish_pause:"AUTH"` within 2 cycles; recovery. | **NOT DONE.** The current watcher runs at most ≈ 15 h, short of the 24 h default in 11-testing open question 5. | Snapshot at 19:32: [gcm_watch.2026-10-01T1932.log](_synthesis-raw/gcm_watch.2026-10-01T1932.log), [gcm_watch.ps1](_synthesis-raw/gcm_watch.ps1), [keep_awake.ps1](_synthesis-raw/keep_awake.ps1). Live file, still growing: `cowork-sync-scratch/overnight/gcm_watch.log` |
| **g** | 7 | Does UserPromptSubmit fire before `!` preprocessing of a typed `/cowork` command? | **NO.** UserPromptSubmit fires **after** the `!` line has **finished** (q7b: `!` start 0 → `!` end +1,503 ms → UPS +1,578 ms). **UserPromptExpansion fires before `!`** (q7c: UPE 0 → `!` start +475 ms), with the same `prompt_id` and `command_name`/`command_args`/`command_source`. The `!` line does not pass through PreToolUse(Bash). | MEASURED: 3 runs, `claude -p`, Windows. NOT MEASURED: 50 interactive CLI trials and 50 VS Code trials; the Skill-tool path; permission rules and the auto-mode classifier. | **FAIL → routed.** Glossary §25 F5 takes human evidence from UserPromptExpansion, a reviewed alternative to the §3.18 default "acting verbs TTY-only". Chapters are not yet aligned. The new mechanism still needs the 50-trial interactive ordering check. | [q7b__order.jsonl](02-claude-host/raw/q7b__order.jsonl), [q7c__order.jsonl](02-claude-host/raw/q7c__order.jsonl), [q7a__order.jsonl](02-claude-host/raw/q7a__order.jsonl) |
| **h** | 8 | A pilot team's real clean/smudge filter on a real clone | **PASS.** Round trip and idempotency hold for **21/21 files**: the only filtered path, `hub.py` (a 1.3 MB Python source file), plus 20 others, with and without the key file. With `required=true`, every broken-driver case (missing command, exit 3, empty value, section undefined) makes `git add` exit **rc 128 with the index byte-identical**. Without it, rc is 0 and **the secret is staged**, with no stderr at all in 2 cases. The filter works in DAEMON_ENV even with an empty PATH. One filter process takes ≈ 0.05 s; `cat-file --filters` takes 70 ms (≤ 200 ms). `autocrlf=true` + BOM gave 0 phantom changes in 51 trees. **Side finding: the spec's D4 preflight never runs the filter** (see cross-cutting finding 1). | MEASURED: fresh clone of a pilot team's private repository on this PC, dummy secret. NOT MEASURED: other pilot-team PCs and Python installs; `i/crlf` files (the repo has none); the real secret (excluded by design); a canary on a scratch file with the same attributes. | **PASS.** It rests on the direct checks run under DAEMON_ENV (spike 03 Q6 T1–T3, the 21/21 round trip and the Q3 `required` matrix). It does **not** rest on D4 as written: D4 "passes" only because it never runs the filter. The D4 rewrite is routed in glossary §25 F12, and corrections are still needed (B7/C2). | [q12_roundtrip_keys.jsonl](03-real-filter/raw/q12_roundtrip_keys.jsonl), [q12_roundtrip_nokeys.jsonl](03-real-filter/raw/q12_roundtrip_nokeys.jsonl), [q3_required.jsonl](03-real-filter/raw/q3_required.jsonl), [q6_env.jsonl](03-real-filter/raw/q6_env.jsonl), [q45_snapshot.jsonl](03-real-filter/raw/q45_snapshot.jsonl), [q1_d4_variants.log](03-real-filter/raw/q1_d4_variants.log) |
| **i** | 9 | 4-seat contention on the 1.3 MB BOM+CRLF file | **FAIL.** Setup: worktree `git add` snapshots every 2.5 s and 4 editor processes. Result: **11.4 failed saves per 1,000** (22/1,931; 95 % lower bound 7.7). In-place saves fail with Win32 1224 `ERROR_USER_MAPPED_FILE`, because git memory-maps the file while hashing: 6 of 6 failures fell inside `git add` windows and 0 of 950 saves outside them failed. **Staged hashing** (ENG-27 remedy) removed those failures: 0/963 in-place failures, and no failure overlapped the daemon's copy + add window. That run still totalled 9.9/1,000 because of one 19 s burst by an unidentified external file holder plus editor-vs-editor collisions. 0 daemon-attributable failures in 1,926 saves gives an upper bound of 1.55/1,000, which does not certify ≤ 1/1,000. Staged mode captured 1 empty file in 480 snapshots. | MEASURED on 1 PC with a harness daemon. This is not the real daemon and has no 300 ms quiet period (glossary §20), and it used 4 editor processes, not 4 seats on 2–4 PCs. NOT MEASURED: gate p95, T0, RSS, apply lag, INV-NOLOSS (all need the real daemon); 60 min; several PCs. | **FAIL → routed** by the §3.18 i default (staged hashing as the default). Not yet in the glossary or 01-engine. | [main/summary.json](04-contention/raw/main/summary.json), [main/attribution.json](04-contention/raw/main/attribution.json), [staged/summary.json](04-contention/raw/staged/summary.json), [staged/attribution.json](04-contention/raw/staged/attribution.json), [control/summary.json](04-contention/raw/control/summary.json), [probe_win32err.json](04-contention/raw/probe_win32err.json) |
| **j** | 10 | `mcp_tool` vs command hooks | Shell-form command hook (`node "…"` run through Git Bash): **62–66 ms end to end** (n = 5), of which ≈ 40 ms is process creation and ≈ 3 ms is the script. `mcp_tool` hook: 2–10 ms (n = 6). Exit 1 (uncaught throw) **fails open**; exit 2 **blocks** with `is_error`; past its `timeout` the hook **fails open** after ≈ 3.17 s. | MEASURED (n = 5, one session, shell form). NOT MEASURED: a real p95 (n is too small); exec-form `command`+`args` hooks (the glossary §13 form); Defender state during the run (spike 04 recorded it ON at 18:17 the same day; spike 02 did not record it); the §3.15 load; cold vs warm; the non-live fast path (≤ 45 ms bound); `mcp_tool` with its server killed or returning `isError`. | **FAIL → routed** against "≤ 60 ms live" (all 5 samples were 62–66 ms). Glossary §20/§25 F6 re-baselined the bound to ≤ 100 ms p95. That value rests on 5 shell-form samples. The ≤ 45 ms non-live bound is not addressed. | [q10__latency.json](02-claude-host/raw/q10__latency.json), [q10__summary.json](02-claude-host/raw/q10__summary.json), [q10.debug.filtered.log](02-claude-host/raw/q10.debug.filtered.log) |

Summary count: PASS 1 (h) · FAIL → routed 3 (g, i, j) · INCOMPLETE 5 (a, b, c, d, e) · NOT DONE 1 (f).

---

## Cross-cutting findings (MEASURED, not owned by one item)

1. **The spec's D4 filter preflight proves nothing.** Its scratch work tree and scratch index have no `.gitattributes`, so the filter never runs (0 filter processes in `GIT_TRACE`). `-q` hides "needs update" and the command still exits 0. When attributes are supplied, the pilot team's repo-relative driver path fails outside the real work tree (rc 128). Evidence: [q1_d4_variants.log](03-real-filter/raw/q1_d4_variants.log).
2. **At 48 pushes/min GitHub rejected 10.4 % of pushes with `(failed)` / `fatal error in commit_refs` and left the ref unchanged.** Every failing push overlapped another push to the same repo, so rate and concurrency cannot be told apart. As written, ENG-44/45 would make these NONRETRYABLE. Evidence: [d_analyze.json](01-github/raw/d_analyze.json).
3. **GitHub advertises and enforces `atomic`**: with one stale lease out of two, neither ref moved. PRO-50 forbids `--atomic`, but the host does not prevent its use. Evidence: [a_caps.json](01-github/raw/a_caps.json), [a_trace_push.txt](01-github/raw/a_trace_push.txt).
4. **The rename-over apply fallback is much weaker than the two-phase writer.** With a Node reader holding the file, rename-over succeeded in 0 of 15 applies and two-phase in 15 of 15. Editors' own atomic saves also fail against any resident share-all reader, whether or not the daemon runs (244 of 245). Evidence: [rnode/summary.json](04-contention/raw/rnode/summary.json), [probe_win32err.json](04-contention/raw/probe_win32err.json).
5. **Snapshot-only blobs grow fast.** About 205 MB of loose objects were written in 20 min with 4 editors saving the 1.3 MB file about 1.6 times per second (`gc.auto=0`). Real editing cadence is lower; that growth is NOT MEASURED. Evidence: [main/run.json](04-contention/raw/main/run.json).
6. **`CLAUDE_CODE_MESSAGING_TOKEN` is in every hook's environment** (SessionStart, UserPromptSubmit, PreToolUse), not only the MCP child's. An unset `crossSessionInbound` still delivered. Evidence: [q3__sessionstart.jsonl](02-claude-host/raw/q3__sessionstart.jsonl), [q3idle_default__summary.json](02-claude-host/raw/q3idle_default__summary.json).
7. **Edit after an external change elsewhere in the file applies cleanly**, and the host adds the note "the file had been modified on disk since you last read it". Evidence: [qedit__summary.json](02-claude-host/raw/qedit__summary.json).
8. **The pilot team's filter setup script prints a wrong status.** It says the placeholder was kept although smudge restored the value. This is cosmetic, but doctor must not rely on that output. Evidence: [setup_output.log](03-real-filter/raw/setup_output.log).

---

## What changes in the spec

Each line gives the location, then the new value. Bucket A was already decided in glossary §25, but older text still contradicts it. Bucket B is new and not in glossary §25. Bucket C covers contradictions inside the current spec found during this synthesis.

### A. Decided in glossary §25 — older text still to align

| # | Location (current text) | New value | Basis |
|---|---|---|---|
| A1 | Glossary §13 hooks table: UserPromptExpansion matcher "`cowork\|cowork-sync:cowork` (pause/resume only)" | Same matcher, **all verbs** (human evidence for acting verbs). | §25 F5; item g |
| A2 | Glossary §13 MCP↔daemon frame `ring_result{nonce, accepted\|held\|refused\|timeout}` | `ring_result{nonce, sent\|refused\|error}`: `sent` = line written and connection not closed within 100 ms; `refused` = server closed within 100 ms (auth); `error` = connect/write failure. Delivery is confirmed only by a UserPromptSubmit that carries the nonce. | §25 F1; item c |
| A3 | Glossary §15 "human evidence via UserPromptSubmit within 60 s" | "human evidence via UserPromptExpansion (`prompt_id`, `command_name`, `command_args`), ≤ 60 s old; the CLI waits ≤ 3 s". | §25 F5 |
| A4 | Glossary §20 row "Doorbell post timeout: 5 s; anything but explicit success = not delivered" | "Doorbell post: `sent` if the connection is not closed within 100 ms; delivered only when a UserPromptSubmit carries the nonce." | §25 F1 |
| A5 | 07-coordination §3.13 step 2 (default `{"type":"message","text":…}`), the §2 "Local definitions" row "doorbell post timeout 5 s; anything but explicit success = not delivered", and COO-23 ("any `ring_result` other than `accepted` … not delivered") | Frame `{"type":"user","message":{"role":"user","content":<text>}}` with **no `session_id`**; result semantics as in A2. | §25 F1 |
| A6 | 06-claude §3.16 ring paragraph ("replies `ring_result{… accepted\|held\|refused\|timeout}` … Only `accepted` counts as posted") | As in A2/A5. | §25 F1 |
| A7 | 09-security SEC-25 (b) "minted … from a UserPromptSubmit" | "minted from a UserPromptExpansion with the same `prompt_id`, `command_name` and normalised `command_args`". | §25 F5 |
| A8 | 01-engine ENG-44/ENG-45 (structured rejection with board unchanged → NONRETRYABLE after one attempt) | `(failed)` and `fatal error in commit_refs` must not be NONRETRYABLE after one attempt. **Implement as in C1, not by text matching.** | §25 F11; finding 2 |
| A9 | 03-data Algorithm D4 steps 1–2 (scratch index, `--work-tree=tmp/rt`, `update-index -q --refresh`) and DAT-01's "raw `cat-file blob` output goes only to the preflight scratch tree of D4" | Real-work-tree check per §25 F12, **with the corrections in B7/C2**. | §25 F12; finding 1 |
| A10 | 11-testing §3.18 j PASS "Command hooks: p95 ≤ 60 ms live" | "≤ 100 ms p95 end to end on Windows" (already in glossary §20 Perf gates). | §25 F6 |
| A11 | 11-testing §3.18 g PASS (UserPromptSubmit before the CLI's check) | Rewrite for the new mechanism: "50/50 interactive CLI and VS Code: UserPromptExpansion for `/cowork …` reaches the daemon before the `!` CLI's evidence check (≤ 3 s wait); `!` does not pass through PreToolUse(Bash)". | §25 F5 |
| A12 | 11-testing §3.18 c PASS / 07-coordination open question 3 | Record as answered on Windows: an inbox-started turn fires UserPromptSubmit with a new `prompt_id` and the raw text. | §25 F2 |

### B. New — not yet in glossary §25

| # | Location (current text) | New value | Basis |
|---|---|---|---|
| B1 | 01-engine **ENG-27** ("otherwise the snapshot add MUST switch to staged hashing") and test 32 | "On Windows the snapshot add MUST use staged hashing by default (copy stable bytes to `tmp/stage/<p>`, add with `--work-tree=<tmp/stage>`, delete the copy); the soak certifies it." This removes the soak-triggered switch. The §3.18 i on-FAIL default says the same. | Item i: 6/6 in-place failures inside `git add` windows, 0/950 outside; staged mode had 0/963 |
| B2 | ENG-27 "copy stable bytes" (undefined) | "Copy only if `lstat` before and after the read are equal (size, `mtime_ns`, file id) and size ≠ 0 unless it was 0 at the previous snapshot; otherwise the path gets the 01-engine §3.8 `unstable` reason for that tick." The existing §20 shrink guard (2 stable snapshots for a shrink to 0) still applies at publish. | Item i: 1/480 empty capture in staged mode |
| B3 | Glossary §20 "Soak acceptance" ("≤ 1 editor file-save failure per 1,000 … (caused by the daemon reading files)"), TST-18, 01-engine test 32 (2 h) | Define the attribution and the statistic: (1) run a **daemon-off control** on the same PC and file, and count only failures that overlap the daemon's file-read windows; (2) **one editor**; (3) state the statistic. Proposed default: a point estimate of ≤ 1/1,000 over **≥ 3,000 saves** (≈ 2.5 h at one save per 1–5 s). If a 95 % upper bound is wanted, it needs ≥ 2,995 saves with 0 daemon failures. The current 2 h single-editor soak gives ≈ 2,400 saves, and even with 0 failures its bound is 1.25/1,000. | Item i; Clopper-Pearson arithmetic (one-sided 95 %: 1 − 0.05^(1/n)) |
| B4 | 01-engine §3.11 "Volumes without hard links fall back to rename-over; this is logged once at start" | "Rename-over is a **degraded** apply mode: doctor WARN and a LIF preflight warning, shown in `status.json`. It fails whenever any process holds a share-all read handle." | Finding 4: 0/15 vs 15/15 |
| B5 | 01-engine ENG-04 / glossary §20 (no size rule for snapshot-only objects; `gc.auto=0` everywhere) | Add a bound and a prune policy for daemon-written snapshot-only loose objects. The owner chooses the value; options are periodic pruning of unreachable daemon objects older than N minutes, or a size cap with a doctor WARN. Measure growth at a realistic cadence first (unknown U18). | Finding 5: 205 MB / 20 min |
| B6 | 09-security **INV-TOKEN** ("exists only in the memory of the session's own MCP server process") | "No cowork process other than `dist/mcp.js` reads, stores, logs or forwards `CLAUDE_CODE_MESSAGING_TOKEN`." The host places the token in every hook env, so the old statement cannot be met. SEC-24's lint and the DAEMON_ENV never-list (`CLAUDE_*`) already cover the code side and stay. | Finding 6 |
| B7 | Glossary §25 F12 (replacement preflight) | (i) Compare **paired**: `cat-file --filters <B> \| hash-object --path=p --stdin` against `cat-file blob <B> \| hash-object --path=p --stdin`, never against the stored blob id (see C2). (ii) Add a **positive control** that proves the driver ran (a `GIT_TRACE` filter-process count, or a canary byte change). (iii) Fix the fact "needs `python` on PATH": the pilot team's driver uses an absolute interpreter path and works with an empty PATH; only a bare-`python` driver needs PATH. (iv) Use `EPOCH_BASE[p]`, as D4 does, not `HEAD:p`. | Spike 03 Q1/Q6/D4 |
| B8 | Glossary §13 "Non-live repo fast path: … exit 0 in ≤ 45 ms p95" and 11-testing §3.18 j "≤ 45 ms non-live" | A near-no-op command hook already measured 62–66 ms (shell form). Either re-baseline to ≤ 100 ms p95 like F6, or keep 45 ms only if an exec-form measurement (U9) supports it. Also record that §13's exec form was not the form measured. | Item j |
| B9 | 11-testing §3.18 i (one item mixing pre- and post-implementation metrics) | Split it. **i-pre** (editor-save failures under a snapshot harness) is now FAIL → routed by B1. **i-post** (gate p95, T0, RSS, apply lag, INV-NOLOSS on 2–4 PCs) moves to the TST-18 soak, because it cannot run without the real daemon. Otherwise TST-27 can never be met. | Item i |
| B10 | 02-protocol PRO-50 "`--atomic` MUST NOT be used" and the "not in v1: `--atomic` pushes" non-goal | **Owner decision, optional.** Either keep it, with the reason given as "portability to other hosts" (GitHub supports it), or add a `caps.atomic` probe and push board+code atomically where advertised. | Finding 3 |
| B11 | 11-testing §3.18 a on-FAIL `CI_FIRES_ON_LIVE_REFS` | Not triggered for GitHub Actions in `refs/cowork/*`, so do not adopt the code. Keep SEC-16's fallback-namespace warning and the README webhook warning; webhooks were NOT MEASURED. | Item a |
| B12 | 11-testing §3.18 e procedure ("Spawn the daemon from `mcp.js`") vs what was measured (SessionStart hook) | Name one spawner in 06-claude and test that one. The measurement covers the hook spawner only. | Item e |

### C. Contradictions inside the current spec

| # | Contradiction | Proposed resolution |
|---|---|---|
| C1 | Glossary §25 F11 (`(failed)`/`commit_refs` retryable) and F9 (`cannot lock ref …` = lease reject) classify by **rejection text**. Glossary §18 says "Message text … never causes a retry". | Decide by observation, not text. A structured rejection with the board unchanged (T′ == T) is **retried once in the next window**; a second structured rejection of the same publish with T′ == T → NONRETRYABLE. This matches TC-SEC-05's "NONRETRYABLE … after ≤ 1 extra attempt". F9 needs no text rule: in 100/100 races T′ ≠ T, so ENG-44's re-fetch already says "CAS loss, retryable". The one `commit_refs` failure without a ref status line is already a retryable transport failure under ENG-44. |
| C2 | Glossary §25 F12 compares `hash-object --path` output with `HEAD:p`'s **stored blob id**. 03-data D4's preamble forbids exactly that, because ENG-11 VERIFIED it misreports `i/crlf` files. | Use the paired comparison in B7 (i). Spike 03's 21/21 pass used the stored-id form, which is safe for this repo only because it has no `i/crlf` files. |
| C3 | Glossary §13 (non-live ≤ 45 ms), §20 Perf gates (hook ≤ 100 ms) and 11-testing §3.18 j (≤ 60 ms / ≤ 45 ms) give three different hook bounds. | One row in §20 for live and non-live hooks (B8), referenced from §13 and §3.18 j. |

---

## What is still unknown and how to measure it

| # | Unknown | Item | How to measure | Needs | Effort |
|---|---|---|---|---|---|
| U1 | Lease race and push budget across networks | a, b | Second PC on a different network (home line or phone tether); NTP-aligned start plus a barrier via a third ref; 100 races; 4 clients × 30 min at ≤ 6/min, then 20/min and 60/min. Reuse `cowork-sync-sandbox`. | **A second PC/person** | 1–2 h |
| U2 | Webhook deliveries for `refs/cowork/*` | a | Add a webhook to the sandbox pointing at an unroutable URL; read the delivery log via `GET /repos/{o}/{r}/hooks/{id}/deliveries`. | Agent; token must allow repo hooks | 15 min |
| U3 | Push protection and rulesets on custom refs | a | Push a revoked test token in a custom ref; try a push ruleset targeting `refs/cowork/**`. Plan-dependent, so record "not available" where the plan lacks it (11-testing open question 2). | Agent + plan info from the user | 30 min |
| U4 | Cause of the 48/min failures: rate or concurrent pushes | a | 48/min serialized (no overlap) vs 24/min with forced overlap, 3 min each. | Agent (sandbox) | 15 min |
| U5 | GCM over ≥ 24 h and revocation | f | Fetch every 2.5 s in DAEMON_ENV with `GCM_TRACE=1` for ≥ 24 h, then revoke the token on GitHub and check AUTH pause within 2 cycles and recovery after a terminal `git fetch`. | **User** to revoke; PC awake 24 h+ | 24 h + 15 min |
| U6 | Interactive ordering and delivery | c, e, g | 50 trials each, in an interactive CLI and in VS Code: UPE before `!`; inbox idle delivery in a TTY session; daemon survival for `/exit`, closing the window, killing the tree and closing VS Code, checked 60 s later. | **User at the keyboard** (TST-20 style) | 1–2 h |
| U7 | macOS / Linux | c, d | Repeat q3/q4 on each OS. Linux may be possible via WSL if installed. Otherwise the spec's own default applies (that OS's seats are `HOOK_ONLY`). | A Mac/Linux machine, or an owner decision | 1 h per OS |
| U8 | Plugin-packaged MCP server and hooks: socket/token inheritance, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT` | d | A minimal local plugin loaded for one session only (no global config change), 1–2 `claude -p --model haiku` runs. | Agent | 30 min |
| U9 | Exec-form hook latency (`command`+`args`), a real p95, the non-live fast path, Defender state recorded | j | ≥ 50 Write calls per form in 1–2 runs; record Defender status first. | Agent | 30 min |
| U10 | Is a hook past its `timeout` killed at the timeout? | j | Hook sleeps 8 s with timeout 3; keep the session alive ≥ 10 s; check whether `sleep_done` appears. | Agent, 1 run | 10 min |
| U11 | `mcp_tool` with its server killed or returning `isError` | j | 1 run. Low priority, because `mcp_tool` gating is banned. | Agent | 10 min |
| U12 | Is slash text inside a doorbell expanded? `crossSessionInbound` hold/refuse on the wire? | c | 3 runs posting `/cowork status` text and with hold/refuse settings. | Agent | 20 min |
| U13 | Write (not Edit) after an external change; Write after a permission prompt (06 open question 12) | — | 1–2 runs. | Agent | 15 min |
| U14 | Staged hashing at certification size | i | Staged mode with 1 editor, ≥ 3,000 saves (≈ 2.5 h), plus a daemon-off control of equal length; add the B2 stability check and the §20 300 ms quiet period. | Agent, unattended, local only | 5 h |
| U15 | Who held the file in the 19 s burst; Defender's share of failures | i | Re-run with handle tracing (Sysinternals `handle.exe` or ETW); read the Defender exclusion list. | **User (admin)** | 30 min |
| U16 | Real-daemon metrics: gate p95, T0, RSS, apply lag, INV-NOLOSS on 2–4 PCs | i (post) | The TST-18 soak after implementation (B9). | Implementation | — |
| U17 | The filter on other team PCs and Python installs (venv, WindowsApps stub) | h | Run `spikes/03-real-filter/scripts` on one more team PC. | A team member | 30 min |
| U18 | Snapshot-object growth at a realistic cadence | B5 | Count loose-object bytes during a real working session with the real daemon. | Implementation | — |

All GitHub follow-ups (U1–U4) can reuse the existing private sandbox `Kingyoungmins/cowork-sync-sandbox`; no new repository is needed for SPIKE-0. Its current leftover refs are listed in [e_final.json](01-github/raw/e_final.json). A separate CI test repository (TST-15/16, with `.cowork-test-repo`) is a later, implementation-phase decision.

---

## Overnight credential log (state at 19:27 KST)

- **What runs.** `gcm_watch.ps1` v2 (PID 15440, alive at 19:26) runs `git ls-remote <sandbox> refs/heads/main` every 600 s with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, for 90 iterations. `keep_awake.ps1` (PID 9272, alive) blocks system sleep for 14 h from about 17:24. Neither was started by this synthesis.
- **What the log shows.** 14 probe lines plus one restart comment:
  - 4 v1 lines (17:24–17:54). The first has exit 0; the next three show `exit=-1`, which the v2 header says came from `Select-Object` stopping the pipeline, not from git.
  - 10 v2 lines (17:57:39–19:27:51), **all exit 0**, 954–2,258 ms, each returning a `refs/heads/main` oid. No prompt and no failure.
  - The log keeps growing; re-read it before quoting these counts. A copy as of 19:32 is at [`_synthesis-raw/gcm_watch.2026-10-01T1932.log`](_synthesis-raw/gcm_watch.2026-10-01T1932.log).
- **What it is not.** It is not the §3.18 f procedure: it uses `ls-remote` every 10 min instead of fetch every 2.5 s, the full user environment instead of the DAEMON_ENV allowlist, no `GCM_TRACE`, and no revocation. Whether GCM had to refresh a credential during the window is NOT MEASURED.
- **How long it can run.** 90 × ≈ 601 s ≈ 15 h, so the last probe is due at about 08:59 KST on 2026-10-02. `keep_awake` expires at about 07:24, after which the PC may sleep (power settings NOT MEASURED). The best case is ≈ 15 h, under the 24 h + forced revocation default of 11-testing open question 5. Item f stays NOT DONE until U5 runs.

---

## Go / No-go for implementation

**Gate as written (TST-27/TST-28): NOT MET.** TST-27 needs every item PASS or FAIL-and-routed. TST-28 needs each FAIL resolved by a spec change merged in the owning chapter. Today: h PASS; g, i, j FAIL with routes, but the chapters are not merged (and the i route is not yet in the glossary); a–e incomplete; f not done.

**What was found.** Nothing invalidates the core model on GitHub + Windows:

- the lease/CAS model (0 double wins in 100);
- the custom-ref namespace (every primitive works, and Actions do not fire);
- the secret-filter safety rule (`required=true` fails closed every time);
- the private-index snapshot model (51/51 equal to HEAD, real index untouched);
- fail-closed gating through exit 2;
- socket inheritance by a project MCP server.

The failures change mechanisms (evidence hook, doorbell result, snapshot add mode, latency bound) and do not undermine the design.

**GO now:**

- Everything TST-27 permits: the harness, ports, the lint suite and spike tooling.
- Engine, fold and protocol code exercised only by the SIM harness against `file://` remotes may be *written* on a branch, because no spike result touches its model. It may *merge* only after the gate.

**NO-GO, until the named follow-ups are done and the spec changes are merged:**

| Area | Blocked until |
|---|---|
| Doorbell / inbox wiring (07, 06 §3.16) | A2/A4–A6 merged; U12; U7, or an owner decision that other OSes default to `HOOK_ONLY` |
| Human-verb evidence (09 SEC-25, 08, 06) | A1/A3/A7/A11 merged; U6 (UPE-before-`!` in interactive CLI and VS Code) |
| Daemon lifetime and spawn (06 CCI-51, 08) | B12 decided; U6 exit forms |
| Windows snapshot add mode (01 ENG-27) | B1–B3 merged; U14 |
| AUTH publish pause / credential handling (09) | U5 |
| Push classification (01 ENG-44/45) | C1 decided and merged; U4 recommended |
| Filter preflight (03 D4, DAT-16) | A9 + B7/C2 merged |
| Hook latency gates (06, 11 §3.15) | B8/C3 decided; U9 |
| Cross-network assumptions (02 governor, 11 §3.18 a/b) | U1, or an owner decision to accept single-network evidence for SPIKE-0 and keep the cross-network run as a REL-06 pre-release item |

**Shortest path to meeting the gate:**

1. The in-flight chapter alignment merges buckets A, B and C.
2. The owner rules on B9 (split item i), B10 (`--atomic`) and C1 (classification by observation).
3. The agent runs U2–U4 and U8–U14 (about 8 h, mostly unattended, about 10 `claude -p --model haiku` runs, within the TST-30 nightly budget of 30).
4. The user provides U1 (second PC), U5 (revocation after 24 h) and U6 (interactive trials).
