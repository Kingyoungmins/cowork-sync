# Spike 04-contention — Windows file contention on a 1.3 MB BOM+CRLF file

Run 2026-10-01 18:15–19:15 KST on one Windows 11 Pro 26200 PC (i9-14900K, 32 logical CPUs, NTFS), Node v24.21.0,
Git for Windows 2.55.0.windows.3 (`mingw64/bin/git.exe` called directly), Python 3.12.10 (`raw/env.txt`).
Local only: no remote, no network, no credentials. `claude -p` runs: **0**. Windows Defender real-time protection was **on**
for every run and its settings were not touched; its one configured exclusion path is not readable without admin, so
whether Defender scans this folder is **NOT MEASURED** (`raw/env.txt`).

Tests the gate of glossary §"Soak acceptance" / ENG-27 / 01-engine test 32: **≤ 1 failed editor save per 1,000 saves**.

## Questions

| # | Question |
|---|---|
| Q1 | With 4 editor processes saving every 1–4 s (in-place and atomic alternating) and the daemon snapshotting every 2.5 s with a private index, how many editor saves fail per 1,000, by style, and with which error? |
| Q2 | Does the daemon snapshot (`git add -A` + `write-tree`, private `GIT_INDEX_FILE`) ever fail or capture a half-written file? |
| Q3 | How often does the 10 s verifying-writer apply fail or retry? |
| Q4 | p50/p95 durations of editor saves, snapshots and applies. |
| Q5 | CPU cost of the daemon loop (including every git child). |
| Q6 | Effect of a reader holding the file open: (a) Node process with default sharing, (b) Excel-like `FileShare.Read`. |
| Q7 | Effect of Windows Defender as-is. |
| Q8 | Does the spec's own remedy (ENG-27 staged hashing) bring the daemon-caused failures under the gate? (added — see "Method") |

## Method

Scripts are in `scripts/` (no credentials anywhere). Work dir `<scratch>/s04/`:
`orig_hub.py` = byte copy of a pilot team's hottest file, a 1.3 MB Python source file shown here as `hub.py`
(1,304,437 B, UTF-8 BOM, 26,436 CRLF, 0 bare LF;
sha256 checked equal to the source); `repo/` = `git init`, `core.autocrlf=true`, `gc.auto=0`, one commit of the pristine file,
`.git/info/exclude` = `*.tmp-*` (the editors' temp files).

| Piece | Script | What it does |
|---|---|---|
| editor ×4 | `editor.js` | Every 1–4 s (uniform, seeded xorshift; seeds in `raw/<v>/run.json`) saves the file, alternating **inplace** (`fs.openSync(p,'w')` = CREATE_ALWAYS/truncate → one `writeSync` of 1.3 MB → close) and **atomic** (`writeFileSync(p.tmp-eN-seq)` → `renameSync(tmp, p)` = MoveFileExW REPLACE_EXISTING). No retries; first-attempt outcome, failing step, `code`/`errno` and duration are logged. Every version = pristine bytes + one fixed-width 40-byte marker line, so all versions have equal length. |
| daemon | `daemon.js` | Fixed 2.5 s cadence (overrun → slot skipped and logged). **Snapshot**: `GIT_INDEX_FILE=.git/cowork/index git add -A` then `git write-tree`. Every 4th tick (10 s): one **apply** of a daemon-marked version through a verifying writer, alternating two modes: **twophase** (01-engine §3.11 shape: read disk, compare LF-normalised bytes to the snapshot blob, lstat unchanged, write `.git/cowork/tmp/<n>.new`, `rename p → <n>.old`, lstat(.old) == st0, `fs.link(.new, p)`, unlink .new, .old kept ≥ 2 s in a ring and checked for late writes) and **renameover** (same compare, then `rename .new → p`). Mismatch → re-snapshot p (`git add -- p`, `cat-file :p`) and re-compare, ≤ 3 retries, then `deferred_mismatch`; rename EBUSY/EPERM/EACCES → `deferred_locked`; link EEXIST → `race_eexist`. Argument `staged` switches the snapshot to ENG-27 staged hashing: `fs.readFileSync(p)` → `.git/cowork/stage/hub.py` → `git --git-dir=… --work-tree=<stage> add -A`. |
| reader (node) | `reader.js` | Holds `fs.openSync(p,'r')` (libuv default share R\|W\|D); every 500 ms re-opens if the file id changed, so it always holds the current file; reads it through the handle. |
| reader (share-read) | inline in `run.py` | PowerShell `[IO.File]::Open(p,'Open','Read','Read')` (FileShare.Read, the .NET/`File.OpenRead` default and an Excel-like lock) held for the whole run. |
| orchestrator | `run.py` | One variant at a time. Resets file, private index and tmp. The daemon is put in a **Windows Job Object**; `JobObjectBasicAccountingInformation` gives user+kernel CPU of the daemon **and every git child** (1,097 processes in the main run). |
| analysis | `analyze.py`, `attribution.py` | Rates with exact (Clopper-Pearson) one-sided 95 % bounds; torn-snapshot check **post-run** from the logged tree oids (each snapshot blob must be the LF-normalised pristine file or pristine + exactly one valid marker line); time-overlap of each failed save with git-add / write-tree / apply / other-editor windows (Date.now(), ±2 ms). |
| Win32 probe | `probe_win32err.py` | Separate folder `s04/probe`. 6 s cells: actor `open_w` (CreateFileW GENERIC_WRITE, share R\|W\|D, CREATE_ALWAYS — what libuv does for `'w'`) or `move` (MoveFileExW REPLACE_EXISTING) in a loop against a holder loop (`none`, `read` share-all read+close, `map` CreateFileMapping+MapViewOfFile ~30 ms, real `git add -A` with a private index, another `open_w`, another `move`); records raw `GetLastError()`. |

Invocations (in this order): `python run.py smoke` · `python run.py main control rnode rshare` · `python probe_win32err.py` ·
`python run.py staged` · `python analyze.py <variant>` and `python attribution.py <variant>` per variant.

| Variant | Length | Daemon | Reader | Purpose |
|---|---|---|---|---|
| smoke | 60 s | yes | node | harness check (data kept; it is measured data) |
| **main** | **20 min** | yes (worktree `git add`) | none | the asked run, Defender as-is |
| control | 5 min | **no** | none | editors only, Defender as-is — see Q7 |
| rnode | 5 min | yes | node, default sharing | Q6a |
| rshare | 5 min | yes | PowerShell FileShare.Read | Q6b (Excel-like) |
| **staged** | **20 min** | yes, **staged hashing** | none | Q8 |

**Deviation, stated plainly:** the task asked for a "5-minute variant with Windows Defender as-is". Defender was on, unchanged,
in *every* run, so such a variant would be indistinguishable from the main run. I used that slot for an **editors-only control
with Defender as-is**, which is what separates daemon-caused failures from editor-vs-editor and environment (Defender, indexer,
…) failures. The staged-hashing variant was added because ENG-27 names it as the remedy if the gate fails.

## Raw data (`raw/`, not published)

The raw logs were removed before publication because they held machine-local paths and other local details. The file
names below are kept so each citation in this README still names the log a number came from; every number quoted here
was copied from those logs.

`env.txt` · `run_console.log`, `run_console_staged.log` · per variant `raw/<v>/`: `editor1..4.jsonl` (one line per save),
`daemon.jsonl` (`snap` / `apply` / `ring` / `skip` / `end` records), `reader.jsonl` (rnode, smoke) or `reader.txt` (rshare), `run.json`
(times, seeds, job CPU accounting, object-store size), `summary.json` (from `analyze.py`), `attribution.json` (main, control, rnode, staged) ·
`probe_win32err.json`, `probe_win32err.log`.

## Results

### Editor saves (Q1, Q4, Q6, Q7, Q8) — MEASURED, `raw/<v>/summary.json`

Rate = failures per 1,000 first-attempt saves; [exact one-sided 95 % lower, upper bound].

| Variant | inplace fail / saves | inplace /1000 | atomic fail / saves | atomic /1000 | **all /1000** | Errors |
|---|---|---|---|---|---|---|
| main (20 min) | 6 / 966 | 6.2 [2.7, 12.2] | 16 / 965 | 16.6 [10.4, 25.1] | **11.4 [7.7, 16.2]** | inplace `open` UNKNOWN −4094 ×6; atomic `rename` EPERM −4048 ×16 |
| control (no daemon, 5 min) | 0 / 239 | 0 [0, 12.5] | 2 / 240 | 8.3 [1.5, 26.0] | 4.2 [0.7, 13.1] | `rename` EPERM ×2 (both overlapped another editor's save) |
| staged (20 min) | **0 / 963** | 0 [0, 3.1] | 19 / 963 | 19.7 [13.0, 28.8] | 9.9 [6.5, 14.4] | `rename` EPERM ×19 (16–17 in one 19 s burst, below) |
| rnode (node reader) | 1 / 245 | 4.1 | 244 / 245 | **995.9** | 500 | atomic `rename` EPERM ×244 |
| rshare (FileShare.Read) | 237 / 237 | **1000** | 238 / 238 | **1000** | 1000 | inplace `open` EBUSY −4082; atomic `rename` EPERM |

Successful-save durations (ms, p50 / p95): main inplace 0.75 / 1.29, atomic 1.16 / 2.19; staged inplace 0.78 / 1.53, atomic 1.21 / 2.27;
control inplace 0.77 / 6.53, atomic 1.19 / 2.85.

**Attribution of the main-run failures** — MEASURED, `raw/main/attribution.json`. `git add` windows cover 1.31 % of wall time,
`write-tree` 0.78 %.

| Style · error | in `git add` window | in `write-tree` window only | other editor saving | none |
|---|---|---|---|---|
| inplace · UNKNOWN −4094 | **6** (1 also touches write-tree) | 0 | 0 | 0 |
| atomic · EPERM −4048 | 6 | 4 | 3 | 3 |

Of the 16 inplace saves that overlapped a `git add`, 6 failed; of the 950 that did not, **0** failed. Of the 25 atomic saves that
overlapped a `git add`, 6 failed. 16 of 22 failures (73 %) fell inside daemon snapshot windows that cover ~2 % of the time.
The 4 `write-tree`-window failures are **unattributed**: `write-tree` does not open the work file; they may be a post-close scan
of the file git just read, or 1 ms clock granularity — not distinguished.

**What the errors are** — MEASURED, `raw/probe_win32err.json` (counts of raw `GetLastError()` per 6 s cell):

| Actor ↓ / holder → | none | read (share R\|W\|D, read, close) | map (file mapping ~30 ms) | real `git add -A` | other open_w | other move |
|---|---|---|---|---|---|---|
| `open_w` (CREATE_ALWAYS) | 0 / 16,723 | 0 / 4,134 | **117,519 / 117,856 — 1224 ERROR_USER_MAPPED_FILE** | **3,249 / 18,234 — 1224** | 0 / 10,712 | 0 / 12,839 |
| `move` (MoveFileEx REPLACE) | 7 / 8,778 — 5 ACCESS_DENIED | **7,166 / 8,241 — 5** | 8,825 / 8,836 — 5 | **1,747 / 8,137 — 5** | 4,869 / 6,067 — 5 | 297 / 6,235 — 5 |

So: (1) `git add` on this Git for Windows build holds the file as a **memory mapping** while hashing; a concurrent truncating open
fails with Win32 1224, which libuv has no mapping for and Node reports as `UNKNOWN −4094` (exactly the main-run inplace error).
(2) MoveFileEx onto a target fails with ACCESS_DENIED (Node `EPERM −4048`) whenever **any** handle is open on it, **even a
share-all read handle**; libuv's open does not block a truncating open, only a mapping does. (3) MoveFileEx failed 7/8,778
times with no second process of ours touching the file (cause not measured).

**The staged-run burst** — MEASURED, `raw/staged/editor*.jsonl`, `raw/staged/daemon.jsonl`: from 18:57:38 to 18:57:57 KST, 17 of 18
atomic saves failed while all 18 inplace saves succeeded and the daemon's renameover apply in that window was `deferred_locked`
while its twophase apply succeeded — the signature of an external process holding a share-all handle on the file (see rnode).
The daemon in staged mode does not hold the file that long (one `readFileSync` per tick), and I ran nothing against the repo then.
The holder is **NOT MEASURED** (no handle tracing was running). Outside the burst: 2–3 atomic failures / ~945, comparable to control.
**No staged-run failure overlapped the daemon's copy + `git add` window** (in staged mode the measured window starts at the
stage copy; 14 atomic + 19 inplace saves overlapped it and all succeeded).

### Daemon snapshots (Q2, Q4) — MEASURED, `raw/<v>/summary.json` → `snapshots`

| Variant | Snapshots | `git add` fail | `write-tree` fail | skipped ticks | snapshot ms p50 / p95 | `git add` ms p50 / p95 | Content check of every snapshot blob |
|---|---|---|---|---|---|---|---|
| main | 480 | 0 | 0 | 0 | 53.4 / 58.4 | 32.5 / 35.6 | 479 valid + 1 pristine, **0 torn** |
| staged | 480 | 0 | 0 | 0 | 47.1 / 53.6 (incl. copy) | 31.1 / 33.9 | 478 valid + 1 pristine + **1 TORN (0 bytes)** |
| rnode | 120 | 0 | 0 | 0 | 46.7 / 54.7 | 31.9 / 33.5 | 0 torn |
| rshare | 120 | 0 | 0 | 0 | 23.1 / 25.3 | 12.1 / 13.2 | 120 pristine (nothing could write) |
| smoke | 24 | 0 | 0 | 0 | 47.7 / 55.6 | 32.0 / 34.3 | 0 torn |

The staged copy (`fs.readFileSync` then write to the stage dir) once read the file in the instant after an inplace editor had
truncated it and captured an **empty file**; worktree `git add` captured 0 torn files in 480. Note that the inplace editor writes
1.3 MB in **one** `write` call (truncate→full size in ~0.4 ms); editors that write in chunks leave a longer window.

Object store growth (loose objects, `gc.auto=0`): main **205 MB in 20 min**, staged 149 MB, rnode 35 MB (`run.json`).

### Applies (Q3, Q4) — MEASURED, `raw/<v>/summary.json` → `apply`, `ring`

| Variant | Mode | Applies | Outcomes | Retries (mismatch → re-snapshot) | ms p50 / p95 |
|---|---|---|---|---|---|
| main | twophase | 60 | 60 ok | 2 (2 applies needed a 2nd attempt) | 21.0 / 41.7 |
| main | renameover | 60 | 60 ok | 6 | 21.0 / 79.2 |
| staged | twophase | 60 | 60 ok | 4 | 21.6 / 57.1 |
| staged | renameover | 60 | 59 ok, 1 `deferred_locked` (EPERM, in the burst) | 6 | 21.3 / 74.0 |
| rnode | twophase | 15 | **15 ok** | 1 | 21.3 / 112.1 |
| rnode | renameover | 15 | **15 `deferred_locked` (EPERM)** | 0 | 21.0 / 25.6 |
| rshare | twophase | 15 | 15 `deferred_locked` (EBUSY on rename p → .old) | 0 | 19.6 / 21.6 |
| rshare | renameover | 15 | 15 `deferred_locked` (EPERM) | 0 | 18.9 / 20.0 |

No apply reached `deferred_mismatch`, `race_eexist` or a stat-rollback. `.old` ring: 60 + 60 + 15 files checked ≥ 2 s after
rename, **0 late writes**, 0 unlink errors.

### CPU (Q5) — MEASURED, `raw/<v>/run.json` → `job`, `raw/<v>/daemon.jsonl` → `end`

| Variant | Job CPU (user+kernel, daemon + all git children) | Wall | % of one core | Processes | Node process alone |
|---|---|---|---|---|---|
| main | 25.9 s | 1,199.7 s | **2.16 %** | 1,097 | 2.4 s |
| staged | 22.5 s | 1,199.7 s | 1.87 % | 1,101 | 3.6 s |
| rnode | 5.3 s | 299.7 s | 1.77 % | 273 | 0.5 s |
| rshare | 3.0 s | 299.6 s | 1.01 % | 271 | 0.5 s |

≈ 90 % of the daemon loop's CPU is in the git children (process start-up + hashing 1.3 MB every 2.5 s).

## Answers

| Q | Answer | Label · confidence |
|---|---|---|
| Q1 | **NO, the gate fails.** 11.4 failed saves per 1,000 (22/1,931; 95 % lower bound 7.7) with the daemon running worktree `git add`. inplace 6.2/1000 (all `open` UNKNOWN −4094 = Win32 1224 ERROR_USER_MAPPED_FILE, all inside `git add` windows, 0 in control), atomic 16.6/1000 (`rename` EPERM = ACCESS_DENIED). Daemon-attributable: 16 of 22 fell inside snapshot windows (≈ 8.3/1000); 6 did not (other editor or unknown). | MEASURED (`raw/main/`, `raw/probe_win32err.json`) · high that the gate fails; medium on the exact split |
| Q2 | Snapshot failures: **0** of 480 (main), 0 in every variant. Torn captures: **0/480** with worktree `git add`; **1/480 (empty file)** with the staged copy. | MEASURED (`raw/*/summary.json`) · high |
| Q3 | Main: **0 apply failures** in 120; 8 retries (re-snapshot after mismatch), none exhausted. With a node reader: renameover 0/15 succeeded, twophase 15/15. With a FileShare.Read holder: 0/30, all `deferred_locked`. 0 late writes into the `.old` ring. | MEASURED · high |
| Q4 | Editor saves p50/p95 0.75/1.29 ms (inplace), 1.16/2.19 ms (atomic). Snapshot 53/58 ms (`git add` 33/36 ms). Apply 21 ms p50; p95 42 ms (twophase) / 79 ms (renameover). | MEASURED · high |
| Q5 | **2.2 % of one core** (26 s CPU in 20 min incl. 1,097 git processes) on an i9-14900K. Slower office PCs not measured. | MEASURED · high for this PC |
| Q6a | A Node process holding a default-sharing read handle makes **every atomic (rename-over) save fail**: 244/245 editor saves and 15/15 renameover applies; inplace saves and twophase applies are unaffected (1/245 inplace failed, 15/15 twophase ok). Also in smoke (49/49, 3/3). | MEASURED (`raw/rnode/`, `raw/smoke/`) · high |
| Q6b | A FileShare.Read holder (Excel-like) makes **every** save and every apply fail (475/475 saves; 30/30 applies `deferred_locked`); snapshots keep working. | MEASURED (`raw/rshare/`) · high |
| Q7 | Defender on, unchanged, in all runs. Editors-only control: 2/479 (4.2/1000, both atomic, both overlapping another editor's save). MoveFileEx with no other holder of ours: 7/8,778 ACCESS_DENIED. Whether Defender itself caused any failure, and whether this folder is excluded: **NOT MEASURED** (exclusion list needs admin; no handle tracing). | control MEASURED (`raw/control/`); Defender's share NOT MEASURED |
| Q8 | Staged hashing removed the `git add` (mapping) failures: **0/963 inplace failures** (vs 6/966), and **0 failures overlapped a `git add` window**. The run as a whole still failed the gate (9.9/1000) because of one 19 s external-holder burst (16–17 of 19 failures) and editor-vs-editor collisions. 0 daemon-attributable failures in 1,926 saves gives an upper bound of 1.55/1000 — not enough to certify ≤ 1/1000 (needs ≥ 2,995 failure-free saves). Staged hashing introduced 1 empty-file capture in 480 snapshots. | MEASURED (`raw/staged/`) · medium |

## Implications for the spec

1. **ENG-27 / 01-engine test 32 / glossary "Soak acceptance":** worktree `git add` fails the gate on Windows, and the mechanism is
   now known: Git for Windows hashes through a **file mapping**, so a concurrent truncating save gets Win32 1224
   (`UNKNOWN` in Node). Make **staged hashing the default on Windows** instead of the fallback the soak switches to; keep the
   2 h soak to certify it (20 min cannot certify ≤ 1/1000). Staged hashing does not reach zero by construction: the probe's
   `move` vs `read` cell shows MoveFileEx also fails against the daemon's own short `readFileSync` handle. At ~1 ms per 2.5 s
   that is ~0.04 % of the time, i.e. an expected order of 0.4 atomic-save failures per 1,000 at this save cadence. That is
   an estimate, not a measurement (the 20 min staged run saw 0). It is inside the gate, but the soak should not expect 0.
2. **ENG-27 staged-copy rule needs a stability check.** "Copy stable bytes" must be concrete: copy only when `lstat` before and
   after the read are equal (size, mtime_ns, file id) and the size is not 0 unless it was 0 at the previous snapshot; else skip
   the path this tick (the §3.8 `unstable` reason). Measured: one empty-file capture in 480 without such a check. The
   mechanism is a plain read landing in an editor's truncate-then-write window. 0/480 for worktree `git add` versus 1/480
   staged is **not** a statistically meaningful difference, so this does not show that worktree add is safer.
3. **The gate's wording ("caused by the daemon reading files") needs a measurement rule.** A plain soak cannot tell causes apart:
   editor-vs-editor collisions and an unknown external holder produced failures with no daemon involvement. Glossary "Soak
   acceptance" / test 32 should say: run a daemon-off control on the same PC and file, and gate on failures that overlap the
   daemon's file-read windows (or with-daemon minus control); use one editor as test 32 says (4 editors on one file is an upper bound).
4. **01-engine §3.11 "Volumes without hard links fall back to rename-over"** is a materially weaker mode: rename-over fails while any
   process holds a share-all read handle (15/15 vs 15/15 ok for rename-away + link). Treat it as a degraded mode (doctor/LIF-
   preflight warning), not an equal fallback. The two-phase writer itself held up: 0 failures, 0 late writes, 0 races.
5. **Editors' atomic saves fail against any resident reader, independent of the daemon** (a file watcher, previewer or LSP that keeps
   the file open). The daemon must never keep a handle on a work file between reads (it does not in this harness), and the
   `DEFERRED(locked)` path (01-engine §3.11 table) is exercised for real by an Excel-like `FileShare.Read` holder: every apply defers
   — the 60 s INCOMING escalation (HLD-54) is the right user-visible surface.
6. **Object growth:** snapshot blobs of a 1.3 MB file saved ~1.6×/s across 4 editors wrote ~205 MB of loose objects in 20 min. The
   engine needs a prune/repack policy for snapshot-only objects (ENG-04 keeps reachability of journal objects but says nothing about
   size); not a gate item, but a disk-space risk on long sessions.
7. CPU is not a constraint: ~2 % of one core.

## Not measured

- Who held the file during the 19 s burst in the staged run, and Defender's share of any failure (no ETW/handle tracing; exclusion list needs admin).
- Real Excel (only an Excel-like FileShare.Read holder), real editors (VS Code, Notepad++), chunked writers.
- Office-grade PCs, HDDs, network or OneDrive folders (the Desktop here is not OneDrive-redirected).
- Apply lag across PCs (no remote in this spike).
- A 2 h soak (the spec's length) — the 20 min runs only bound the rate.
