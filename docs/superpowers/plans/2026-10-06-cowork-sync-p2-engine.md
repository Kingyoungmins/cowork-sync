# cowork-sync Plan 2 — Engine Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the sync engine kernel on the Plan 1 foundation: the board and code refs, the board op schema and the fold (claims excluded), the state ref and its journal, staged-copy snapshots whose detection ticks write no objects, merges with explicit bases and the one conflict function, the two-phase verifying writer, the push governor (B = 12 with automatic fallback to 6), the fetch/apply/publish loop, genesis, join, restart and lost state, rewrite incidents with recover, `status.json`, a foreground daemon (`node dist/daemon.js run`), the real engine inside the SIM harness with the INV-FIRSTPARENT, INV-BASE, INV-PUSHED-IS-MERGE and INV-CONVERGE oracles, and a real-remote two-clone sync test. Exit criterion (roadmap row 2): SIM with human-only edits passes INV-FF, INV-FIRSTPARENT, INV-BASE, INV-PUSHED-IS-MERGE and INV-CONVERGE on 1,000 seeds.

**Architecture:** Seven source directories, each importing only from the directories listed before it: `src/ports` (Plan 1 ports plus Trace, Lease and Log), `src/git` (typed plumbing over the single Plan 1 runner: `Oid`, `GitRepo`, merge, push, fetch), `src/sec` (the SEC-35 validators Plan 2 needs), `src/data` (03-data byte functions: rows and forms, canon, blob routes, the conflict function, attributes, filters, team config, scope classes), `src/board` (02-protocol: ids, op schema, board commits, the fold, the outbox, the governor), `src/holds` (the Plan 2 subset of 05-holds: the record schema, the local hold registry, MASK, the human change-set with its ready pairs, receiver write groups — Plan 3 extends these files in place) and `src/engine` (01-engine: refs, meta, the state ref, staged reads and snapshot, DISK_EQ, the writer, fetch, incidents, apply, publish, start, restart, recover, the epoch guard, status and the `Engine` class). `src/daemon/run.ts` is the foreground daemon behind `dist/daemon.js`. `Engine.iterate()` runs one 01-engine §3.5 iteration; production drives it with `runLoop()` on the real scheduler, the SIM harness drives it one iteration per harness step with virtual ports. Tests run real git against `file://` bare remotes; git is never mocked.

**Tech Stack:** unchanged from Plan 1 — Node ≥ 20 (`engines.node` `>=20.6` for contributors), TypeScript 5.x, esbuild, `node:test` via `tsx`, `fast-check`, git ≥ 2.43, GitHub Actions on windows-latest, macos-latest and ubuntu-latest. No new dependency: `node:zlib` (`Cowork-CS-Paths`) and `node:crypto` (sha256 for `H()`, `regionSpecId`) are built-ins.

**Spec:** [`docs/spec/00-glossary.md`](../../spec/00-glossary.md) (rev 2.4; the newest section wins: §27 > §26 > §25 > §24 > base) and these sections, which the tasks quote:
- glossary §3 (core terms), §4 (refs), §5 (commit formats and trailers), §6 (per-clone files), §7 (ops), §8 (FREEZE reasons, publish pauses), §9 (record schema), §14 (`status.json`), §16 (quarantine set, secret-like names), §17 (team config), §18 (git runner), §20 (numbers), §21 (invariants), §24 defaults 1–3 and 9, §25 F9–F13 and §25.2 items 4, 6 and 8, §26.1 W1–W6, §26.2 items 1–3 and 7, §27.2;
- [`docs/spec/01-engine.md`](../../spec/01-engine.md) §2, §3.2–§3.12, §3.14–§3.16, ENG-01…ENG-46 and ENG-51…ENG-59 (ENG-47…ENG-50 are out, ruling R-08), tests 1–6, 8–19, 21, 22, 26–28, 34, 38, 39, 43–52, 57, 58;
- [`docs/spec/02-protocol.md`](../../spec/02-protocol.md) §2, §3.1–§3.4, §3.8, §3.10, §3.11, PRO-01…PRO-16, PRO-20, PRO-22…PRO-29, PRO-38…PRO-51, PRO-54, PRO-55, tests T-PRO-01, -04, -06, -07, -10, -11, -21, -23…-26, -30…-32;
- [`docs/spec/03-data.md`](../../spec/03-data.md) §2, §3.1–§3.4, §3.6, §3.7, §3.9 (Algorithms D1, D3, D5–D9), DAT-01…DAT-07, DAT-13…DAT-15, DAT-23…DAT-34, DAT-40…DAT-43, DAT-46;
- [`docs/spec/05-holds.md`](../../spec/05-holds.md) §3.2, §3.4 item 2 (MASK), HLD-01…HLD-05, HLD-33, HLD-35…HLD-38, HLD-40…HLD-42, HLD-53 (Plan 2 subsets, rulings R-01…R-05);
- [`docs/spec/08-lifecycle.md`](../../spec/08-lifecycle.md) §3.3 Table 3.3-A, §3.3.1, §3.3.2, §3.3.3 (LIF-05…LIF-08 subsets, rulings R-22, R-23, R-26);
- [`docs/spec/09-security.md`](../../spec/09-security.md) SEC-03, SEC-11 (subset), SEC-35 (`validPathSyntax`, `validId`, `validName`);
- [`docs/spec/11-testing.md`](../../spec/11-testing.md) §2, §3.2–§3.6, §3.11, TST-02, TST-03, TST-06, TST-07, TST-13, TST-16, the oracle rows INV-FF, INV-FIRSTPARENT, INV-BASE, INV-PUSHED-IS-MERGE, INV-CONVERGE, INV-OID, O-STATE, O-REACH, O-FETCH, O-STAGED, and mutants M05, M06, M07, M12, M17, M18, M20.

Roadmap: [`2026-10-02-cowork-sync-roadmap.md`](2026-10-02-cowork-sync-roadmap.md) row 2. Plan 1: [`2026-10-02-cowork-sync-p1-foundation.md`](2026-10-02-cowork-sync-p1-foundation.md) (its header's Interfaces are the real Plan 1 names this plan builds on). Plan 1 ledger carries two items into this plan: the `--no-replace-objects` determinism requirement and monotonic time across sleep; both are Global Constraints below.

**Plan form (controller ruling).** Ruling: this plan is design-complete, not code-complete — every task names its files, the exact interfaces it consumes and produces (§Interfaces), the spec rule ids it implements and every test by title with what it asserts; implementers write the code test-first from that contract — 20 tasks of this size written out as code would double the plan's volume (Plan 1's code-complete plan made execution transcription) — cost if wrong: an implementer misreads an interface, caught by the per-task review and by the next task's compile. Executed with superpowers:subagent-driven-development (a fresh implementer and a reviewer per task).

## Global Constraints

**Carried from Plan 1 (still binding):**
- Node floor **20** for everything under `src/` and `dist/` (no APIs newer than Node 20); dev tooling Node ≥ 20.6.
- Git floor **2.43.0** (glossary §18); `meetsFloor` rejects anything below it; `daemon.js run` refuses below it with `START_TOOL_VERSION`.
- **No runtime dependencies**; nothing under `src/` imports a package that is not a Node built-in.
- `dist/` stays the glossary §6 list; Plan 2 turns `dist/daemon.js` from a stub into the foreground daemon, the other five entry points stay stubs.
- Every git process is started by `createGitRunner(...).run(...)` (lint L-GIT-SPAWN); engine code calls git only through `GitRepo.run` (Task 2), which calls the runner.
- No `Date.now()`, `new Date()`, `performance.now()` outside `src/ports/clock.ts`; no `Math.random`, `crypto.randomBytes`, `randomUUID` outside `src/ports/random.ts` (L-CLOCK, L-RANDOM). `process.hrtime` is read only in `src/ports/clock.ts` (`machineMonoMs`).
- No `child_process` outside `src/git/runner.ts` in `src/` (L-PORTS). Plan 2 adds: no `fs`/`node:fs`/`fs/promises`/`node:fs/promises` import in `src/` outside `src/ports/fs.ts` (L-FS-PORT, Task 2).
- Every read and write of user and cowork files goes through the `Fs` port on `Buffer`s.
- Forced git environment (glossary §18): `LC_ALL=C`, `LANGUAGE=`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `SSH_ASKPASS_REQUIRE=never`, `GIT_OPTIONAL_LOCKS=0`, stdin ignored unless a Buffer is piped.
- Watchdogs (glossary §18): fetch 45 s, push 90 s, read/hash commands 120 s; `update-ref`, `update-index`, `commit-tree`, `read-tree` are never killed.
- `enc(b)`: percent-encoding outside `[A-Za-z0-9_-]`, ≤ 150 bytes, else refuse.
- Push rejections are classified by outcome after a fresh fetch (glossary §26.2 item 2; `classifyPush`); message text never decides.
- Files written by tools and fixtures: LF, UTF-8 without BOM, except fixtures that test BOM/CRLF.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Git use (Plan 2):**
- **`--no-replace-objects` on every git call** (Plan 1 ledger carry): `buildGitInvocation` puts `--no-replace-objects` as `argv[0]` for all four classes, before `--git-dir`/`--work-tree` and the `-c` list, so `merge-tree`, `cat-file`, `read-tree`, `rev-list` and `write-tree` never see `refs/replace/*` (`GIT_NO_REPLACE_OBJECTS` stays never-listed). Plan 1's argv snapshots in `test/unit/flags.test.ts` change accordingly (Task 2).
- `GIT_INDEX_FILE`, `--git-dir` and `--work-tree` are absolute; a relative value throws before spawning (ENG-08, 01-engine test 2).
- Every engine git call runs with cwd = the main-worktree root (filters name their scripts repo-relative, glossary §25 F12); a command that may run a filter never gets `--work-tree=<tmp/stage>` (ENG-08).
- **No git process reads a user's working file** (glossary §26.1 W1, ENG-27): content is read only by the staged read (01-engine §2) into `<gitdir>/cowork/tmp/stage/<p>`; listing commands (`ls-files -o --exclude-standard`, `check-attr`) may name the real work tree.
- Blobs come only from route (a) (private-index `add` of stage copies, unfiltered paths only), route (b) (`hash-object [-w] --path=<p>` of a stage copy or stdin, cwd = repo root) and route (c) (`hash-object [-w] --stdin --no-filters` for canon and concat output and for metadata blobs) (ENG-08, DAT-01).
- **Detection ticks write no object** (glossary §26.1 W6, ENG-04): objects are written only at ready-pair captures, publishes, applies and hold records. `update-index --refresh` never carries `-q`, runs only on a private or scratch index whose work tree is `tmp/stage`, and its result is read only from the `diff-files -z` that follows it on the same index (ENG-24, ENG-58).
- Code trees (A, `S_raw`, `S_disk`, `M_disk`, ready-pair `R`/`A_cap`, P, OUT, C) are produced only by ENG-10's four operations; metadata trees by `mktree` (ruling R-15).
- Never in daemon code: `git merge-base`, `-X …`, `--union`, `read-tree -u`/`-m`, `checkout`, `checkout-index`, `switch`, `restore`, `reset --hard`, `stash`, `apply`, `add -A`/`add .`, `push --atomic`, `--force`, a `+` push refspec, `git gc` (L-GIT-FORBIDDEN, L-MERGE-BASE, L-MERGE-OPTS, L-GIT-ATOMIC, L-REFS). The only non-fast-forward push is the human-typed recover, and it uses `--force-with-lease` (INV-FF).
- Every push refspec is built by `pushSpec()` (ENG-09, L-PUSH-ARGV); the only remote deletion is `deleteProbeRef()` (INV-OID); every push attempt goes through `governedPush()` and is counted (PRO-41).
- Every local ref update uses `--create-reflog` under `core.logAllRefUpdates=always` (refupdate class; fetch passes `-c core.logAllRefUpdates=always`) (ENG-02). The engine never writes `FETCH_HEAD`, `ORIG_HEAD`, `refs/remotes/*`, `refs/heads/*` or `.git/index` (INV-ENG-USER).
- Outcomes come from exit codes and `-z`/`--porcelain` output. The only reader of git's text is `readHttpThrottle` (Task 12), and its result can only start the throttle fallback (ENG-46, ENG-58, L-CLASSIFY-TEXT).
- Every git call carries `-c filter.<d>.required=true` for every discovered driver and `filter.lfs` (glossary §18, DAT-15), `-c attr.tree=<EPOCH_BASE>` on attribute-reading commands (DAT-13), `-c core.fsmonitor=false` and, on the private index, `-c core.untrackedCache=false` (ruling R-38).
- Every git call also carries `-c core.safecrlf=false` (controller ruling P2-SAFECRLF): a user's `core.safecrlf=true` makes `hash-object -w`/`add` die (rc 128) on CRLF↔LF conversion, which would read as a filter failure.
- Every git call also forces `-c i18n.commitEncoding=UTF-8` and `-c i18n.logOutputEncoding=UTF-8` (controller ruling P2-UTF8: a user's commitEncoding would put an `encoding` header and non-UTF-8 bytes into shared commits) and the environment `GIT_GRAFT_FILE=<hooksPath>/.no-grafts` (a path that never exists; `GIT_GRAFT_FILE` joins the never-list so it cannot be passed through) — controller ruling P2-GRAFTS: `.git/info/grafts` is still honoured under `--no-replace-objects` and would give one peer different first-parent chains.
- Every git call also forces `-c core.splitIndex=false` (ruling P2-SPLITINDEX: a user's split index would make scratch/private index calls write shared index files).

**Time:**
- Loop period **2.5 s** active (work pending or a capture due), **10 s** idle; one iteration at a time; a fetch starts ≥ 2.5 s after the previous fetch started, or right after it ends if it took longer; a fresh-fetch request during a fetch waits for that fetch (ENG-13, glossary §25 F10).
- Every timer is a Δ from a local `Anchor` (`anchorNow`, `elapsedMono`, `ownStaleness`, `suspendGapMs`); no wall-clock value from another machine is ever compared (INV-CLOCK).
- **Monotonic time across sleep is not trusted alone** (Plan 1 ledger carry): every iteration computes, against the previous iteration's anchor, both `suspendGapMs` and the plain Δmono; Δwall − Δmono > 5 s (`SUSPEND_GAP_THRESHOLD_MS`) **or** Δmono > 3 × the loop period (a monotonic clock that kept counting through a sleep, or a stalled event loop) both mean "suspended": abandon in-flight network calls and fetch before any apply or publish decision (01-engine §3.5 step 0a).
- The snapshot quiet period compares this PC's wall clock with this PC's file mtime only: a path whose mtime is < **300 ms** old is not read; a path whose mtime is in the future needs its stat unchanged for ≥ 300 ms Δmono.
- `meta.json` carries no wall-clock or monotonic timestamp (ENG-05); every timer restarts at daemon start.

**Snapshot and data:** deletion confirmation: missing in two reads ≥ **1 s** apart (Δmono); shrink guard: a > **50 %** shrink or a shrink to 0 bytes needs **2 stable snapshots** plus attribution (ruling R-25); staged read: `lstat`, one whole-file read, `lstat`, one re-read when `(size, mtime_ns)` changed, else UNSTABLE; an open or read error is UNREADABLE (01-engine §2). New-file cap **1,048,576** bytes; blobs ≥ **52,428,800** bytes (50 MiB) are SAVE_ONLY; binary = a NUL in the first **8,000** bytes; a new path ≤ **200** UTF-16 code units, each component ≤ **255** UTF-8 bytes; concat marker size `max(32, longest run + 1)` (glossary §20).

**Writer and apply:** ≤ 1 apply per **10 s** per worktree; free space ≥ **2 × bytes to write + 256 MB** (else `DEFERRED(disk_low)`); ≤ **3** re-merge retries per path, then the group defers `mismatch`; `.old` kept ≥ **2 s**; a gate query waits ≤ **250 ms** for an in-flight group; the writer is two-phase (rename target → `.old`, link `.new` → target) with the copy fallback only on a volume without hard links (glossary §26.1 W4, §26.2 item 7).

**Publish and governor (glossary §27.2, 02-protocol §3.1 and §3.8):** `B = protocol.json.budget` — 12 by default, seeded once at genesis from `host.pushBudgetPerMin` when it is an integer in 6–24, else 12 (ruling R-19); `G_s = ⌈60,000 / budget⌉ / 1,000` s and `S_s = ⌈18,000 / budget⌉ / 1,000` s (12 → 5 s, 1.5 s); local constants normal `(B_local, G_local, S_local) = (24, 2.5 s, 0.75 s)`, fallback `(6, 10 s, 3 s)`; `B_eff = min(B_local, budget)`, `G_base = max(G_local, G_s, 60 s / B_eff)`, `S_eff = max(S_local, S_s)`; throttle level k doubles `G_eff` up to **60 s**; per-peer cap `B_eff` attempts per 60 s Δmono; sliding team guard: no attempt while ≥ `B_eff` observed landings in the last 60 s Δmono; aging after 2 pre-emptions; fallback for **30 min** Δmono after a throttle signal (HTTP 429 or any 5xx on a push or fetch, a push taking > **10 s** Δmono or killed, a transient-rejection streak of **2**) or after folding a `HOST_THROTTLED` event; at most one `HOST_THROTTLED` event per **15 min** per peer; `NONRETRYABLE` at the **3rd** consecutive transient rejection of the same publish with the board unchanged; offline after > **30 s** without a successful fetch; network backoff **30 s doubling to 5 min**. Push only on change: no periodic, heartbeat or renewal push.

**Board:** caps **5,000** folded records, **5 MB** board tree, **1,000** ops and **64 KiB** per `ops.jsonl`, **16 KiB** per line; checkpoint at first-parent heights divisible by **256**; a joiner replays ≤ **255** commits; compaction drops terminal records with `terminal_height ≤ h − 512`; `K_evict` = **200** heights; `proto = 1`.

**State, incidents, convergence:** the state ref changes only by one CAS `update-ref` per transition; a CAS loss is a second writer (security log + exit, ENG-03); ≤ **3** displaced refs per branch; lost-state rebuild reads ≤ **500** first-parent commits; INV-CONVERGE: within **K = 20** loops after quiescence, then zero pushes (the SIM oracle runs **40** more loops).

**Status and lease:** `status.json` is written by temp file + rename on every iteration and transition, retried 3 × 50 ms on EPERM/EACCES then skipped; a heartbeat older than 3 loop periods means `down`; without a lease the loop stops syncing after **2 min** and drains and exits after **10 min** with `IDLE_NO_SESSION` (CCI-50, ENG-56).

**Tests and SIM:**
- Integration tests run real git against `file://` bare remotes (Plan 1 `createBareRemote`, `clonePeer`); git is never mocked; temp roots come from `makeTempRoot` (spaces and non-ASCII).
- SIM determinism (TST-03): the same seed tuple gives an identical op-log, trace and remote ref oids; every id comes from the peer's `seededRandom`; every commit carries `wallMsForDates = clock.wallMs()` (the engine passes it on every commit; the runner honours it only in test builds — Plan 7's L-DIST must keep that branch out of release bundles); generated edits set the file mtime to the peer's virtual wall clock (`utimes`) so the quiet-period rule compares one clock.
- Generated edits to "the same file, different lines" are separated by ≥ 2 unchanged lines: git's merge treats edits on adjacent lines as one conflict (measured on git 2.55 while planning: lines 1 and 2 of a 3-line file conflict; one unchanged line between them merges).
- CI per PR: 100 SIM seeds per leg (80 `edits` + 20 `faults` at Plan 2's merge), distinct seed ranges for the two Node legs, so 200 seeds per OS per PR (glossary §20 CI row, 11-testing §3.11). The exit criterion run is `sim-exit.yml`: 1,000 `edits` seeds per OS. (2026-10-08, X-113, F-P2-4: the later mix follows one rule asserted by `test/unit/ci-config.test.ts` — per PR leg 100 seeds; every merged non-`edits` profile gets its final count, `faults` 15, `holds` 15, `claims` 15, `seats` 15, `coord` 15, `lifecycle` 10, and `edits` takes the remainder, in any merge order; each plan adds its own `sim-exit.yml` shards.)
- Message codes are the registry names verbatim (`^[A-Z][A-Z0-9_]{2,47}$`); no rendered text reaches the board.
- Crashpoints: Plan 2 places 14 names — the 13 of 01-engine ENG-59 plus `registry.cas` (HLD-01, two call sites); all are already in `test/crashpoints.json` (L-CRASHPOINTS). (2026-10-08, X-116, F-P2-4: the assertion is "the placed names equal the catalogue `test/crashpoints.json`" (`lintCrashpoints`), not "exactly 14": each later plan appends its names, and yield points to the Scheduler list, in its own commit.)
- Yield points (Scheduler port; SIM interleaving): `publish.beforePush` (after the push intent is journaled, before `governedPush`), `apply.beforePhase2` (after P1 of a write group, before P2), `start.beforeGenesisPush` (after L0 and B0 are built, before their push). No other yield point is part of the contract.

## Review Focus

The five conditions most likely to break in real use that no single task's tests would otherwise exercise (each has a test in the owning task):

1. **Editor saves racing the staged read on Windows** (glossary §26.1 W1–W3): an in-place truncating save that lands between the staged read's first `lstat` and its read (a 0-byte capture), an atomic save (temp file + rename over the target) between two detection ticks, and a share-all reader holding a file the writer replaces. Expected: no 0-byte or shortened blob and no deletion is ever captured or published from such a window; the two-phase writer succeeds against a share-all reader and defers `locked` (whole group, nothing written) against a share-read holder. Pinned in Task 9 (`FaultFs.interpose` truncation and rename-over between the reads; the 2-snapshot shrink rule) and Task 10 (`holdLock('share-read')` → deferred group; a real share-all reader on the Windows legs).
2. **`core.autocrlf=true` and `core.autocrlf=false` peers converging** on BOM+CRLF and CRLF-stored files. Expected: identical stored blobs on every peer (canon), DISK_EQ never reports an i/crlf file as changed, 200 applies of one-line changes to the 1.3 MB BOM+CRLF fixture give 0 mismatch deferrals and 0 phantoms (01-engine test 1, TC-ENG-08), and a CRLF new file created on an autocrlf=false peer is stored LF. Pinned in Task 3 (canon properties), Task 9 (DISK_EQ on i/crlf; the `hash-object --path` comparator mutant M18 fails), Task 13 (200 teammate changes applied on an autocrlf=true peer) and Task 17 (three engines, one autocrlf=true, converge on the same stored trees; the `edits` SIM of Tasks 18–19 alternates the profiles on every seed).
3. **A peer offline for minutes, then reconnecting**: the remote is unreachable (renamed) for 10 virtual minutes while that peer keeps editing and the others publish. Expected: `OFFLINE` after 30 s with `offline_for_s` growing, backoff 30 s → 60 s → … ≤ 5 min, zero pushes while offline, captures continue; on reconnect one fetch → incident check → fold → apply → publish against the fetched tip; no double publish, no lost edit, convergence. Pinned in Task 17 (partition test) and in the `faults` profile run of Task 19.
4. **Two peers pushing within the same second**: both build their Bnew on the same T; exactly one lands; the other classifies `lease_lost` by outcome (never by text), re-fetches, re-merges against the new tip, waits for its newly computed window (never an immediate retry) and lands next; when both edited the same line the loser's version becomes one K4 record and its other paths still publish (glossary §24 default 3). Pinned in Task 14 (two cores interleaved at `yieldPoint('publish.beforePush')`; rejection texts swapped → identical decisions).
5. **A crash between the push and the state update, or inside an apply** (`publish.sent`, `publish.landed`, `apply.group.mid`, `apply.state`). Expected: restart resolves a journaled push intent by observation (Bnew on the fetched board's first-parent chain → the ok update, else discard), never publishes twice, leaves A and LA_C correct, rolls back an incomplete write group and keeps every byte on disk or in a `restart` record, also when a teammate then deletes the just-applied line and `git gc --prune=now` runs. Pinned in Task 15 (one test per crashpoint with `setCrashHandler`) and Task 19 (SIM crash matrix over all 14 Plan 2 crashpoints).

---

## Scope rulings

Each ruling is `Ruling: <decision> — <why> — <cost if wrong>`. Task writers follow them; a task that finds a ruling impossible stops and reports instead of improvising.

**Change-sets, holds and MASK (Plan 3 extends, never replaces):**
- **R-01 Human change-set.** Ruling: Plan 2 has one CS kind, the peer's human CS (HLD-35): `cs_id = <peer_id>/human/<n>` with `n = meta.cs_human_next` (HLD-33); it opens at the first local delta (every Plan 2 delta is unattributed), closes after **20 s** Δmono without a change on any of its paths or at `Engine.done()`, and the closing iteration materializes `S_disk` and captures one ready pair `(A_cap, R)` written to `journal/ready/<base64url(cs_id)>/{R,A}` as sparse trees holding only that CS's paths (glossary §4, HLD-40); P is `MASK(R)` of the newest ready pair covering each path and `A[p]` elsewhere (HLD-42 restricted to human CSs; the newest capture wins); every state update that changes `A[p]` on a ready path rebases it by HLD-41, including its four-case conflict split; the open CS is not journaled and is re-formed after a restart from `diff(A, S_disk)` minus ready paths (HLD-36's lost-table rule) — the journal layout, `cs_id` grammar, `Cowork-CS … origin=human` and `Cowork-CS-Paths` trailers and the rebase are the spec's own, so Plan 3 adds seat CSs, edit checkpoints, group readiness and T0 by extending `src/holds/changesets.ts` — an open human CS lost in a crash closes 20 s after the restart instead of 20 s after the last edit.
- **R-02 Where a K4 loser's bytes go.** Ruling: a K4 displacement (03-data D8 steps 2–3, and the 01-engine §3.10 rename carry) creates, before any disk write, one PATCH record with state CONFLICTED, guard `conflict` (DECISION) and stages `s1, s2, s3 = (A[p], LOCAL, TIP[p])` in the local registry `refs/cowork-local/<e>/holds`. On the **publish** side the record is born `ON_DISK` because LOCAL is still on disk: MASK step 4 then resets `S_pub[p]` and every later `P[p]` to `A[p]`, so no later human capture republishes LOCAL; the next apply merges `A/S_disk/TIP` again, the conflict function returns TAKE_TIP for the same unit, the registry dedupes onto the same record (same kind, guard and path, same `s2`; `s1`/`s3` are not part of the key because `s3` may have moved — the record's stages are updated to the newer call's by a new rev), the writer puts `TIP[p]` on disk, and the record becomes `OFF_DISK` (masks nothing, INV-HLD-OFFDISK) while `A[p] := TIP[p]`. On the **apply** side the record is created `ON_DISK` and becomes `OFF_DISK` after the verified write. The ready pair that carried LOCAL counts as published once the push lands (or once OUT == tree(TIP) with no ops, when nothing is pushed) — the glossary §9 store is the only holding store (L-HOLD-STORES), so Plan 3 adds mirroring, offers and resolve verbs without moving bytes — until Plan 3 the displaced bytes exist only in their owner's registry (INV-NOLOSS's "local registry" location holds, its "board-mirrored" location does not).
- **R-03 Minimal registry.** Ruling: `HoldRegistry` implements HLD-01's commit chain (CAS `update-ref --create-reflog`, `crashpoint("registry.cas")` immediately before and after the CAS, re-attached at start), HLD-02 identity (ULID from the Random port), HLD-03's clean-path content rule, the glossary §9 record schema verbatim and HLD-05's `hold()` entry point restricted to the guards Plan 2 creates — `conflict`, `restart`, `phantom`, `host-reject`, `eol-bom`, `join` — with their 05-holds Table 3 classes; the registry tree is `records/<id>.json` plus `blobs/<oid>` entries that keep every referenced blob reachable; Plan 2 writes no `hold` op and no board `held/` entry, makes no offers, and transitions records only by (i) the writer's ON_DISK → OFF_DISK move of a CONFLICTED record and (ii) dropping the `eol-bom` guard when a later snapshot of the path passes canon; (iii) the ring's late-write PATCH (ENG-35: `h0 = S_disk[p]`, `h1` = the late bytes, origin `daemon`) has no Table 3 guard, so it is born OFF_DISK PARKED with an empty guard set (bytes kept, nothing masked) — everything Plan 3 adds (mirroring, R1 evaluation, REBASE, PARK, RESTORE, resolve) is additive on the same ref and schema — DECISION-guarded Plan 2 records (`restart`, `phantom`, `host-reject`, `join`) stay listed in `not_converged` until Plan 3/7 ship their verbs.
- **R-04 MASK.** Ruling: `maskEntries` implements 05-holds §3.4 item 2 steps 1–4 exactly and step 5 in whole-path form (an ON_DISK ACTIVE PATCH with a non-empty guard set resets its whole path to `A[p]` instead of reverse-merging its H0→H1 hunks); the quarantine set (glossary §16) and the save-only set are carried through by step 1 — whole-path masking can only withhold more, never publish held bytes (INV-MASK direction), and every record Plan 2 creates is whole-path anyway — none for Plan 2; Plan 3 replaces step 5 with the `merge-file` form.
- **R-05 Deferrals and not-applicable paths without INCOMING records.** Ruling: deferred paths (01-engine §3.11 defer table) and not-applicable paths (`collision`, `unmaterializable`) keep `A[p]`, are listed in `meta.pending` with their reason, count in `status.json.pending.incoming`, appear in `not_converged` (not-applicable paths at once, deferrals once they outlive one apply, ENG-57), and are re-merged at every apply (never a cached blob); no INCOMING record is created (HLD-54/HLD-55 are Plan 3); incoming changes to quarantined paths cannot occur in Plan 2 because they arrive only by base moves (R-08) — glossary §9's 60 s transient exception covers young deferrals, and Plan 3 adds the record at 60 s without changing `meta.pending` — a deferral older than 60 s is visible only in `status.json`, not on the board.

**Data:**
- **R-06 Scope classes and U10.** Ruling: Plan 2 implements 03-data D5 rows 1, 1a, 2–8 and 10 (row 9 has no Plan 2 source: no `local_only` record exists), D6 steps 1, 2 (all guards: nested repo, temp, secret-like name, quarantine/symlink, lfs/generated/exclude/include/`.gitignore`/merge driver, portability, size) and 4, and D7 `portable()`; a non-portable new path is NOT_ADMITTED without DAT-33's `portability` record; D6 step 3's content scan (`scanSecrets`, SEC-07) is out (Plan 7); `.cowork/config.json` at EPOCH_BASE is read leniently for `sync.*`, `merge.insertionMerge` and `host.pushBudgetPerMin` (CFG-02 validation is Plan 7) — the SIM creates new files, and the real-remote harness must never publish editor temp files or secret-named files — until Plan 7 a secret inside an ordinarily named new file is published (Plan 2 is never released).
- **R-07 Canon and forms.** Ruling: canon is D1 in full (BOM, LF/CRLF/NONE conversion, the MIXED matched-row check with a Myers row diff, the tripwire); new paths are hashed with `-c core.autocrlf=input` unless EPOCH_BASE attributes decide (DAT-07); a canon `REFUSE(eol-bom)` on a LIVE path creates one ON_DISK PATCH record with the whole-path guard `eol-bom` (DAT-06, masked) whose guard is dropped when a later snapshot of the path passes canon; DAT-08 disk repair and the D2 incoming form check are out (Plan 3) — canon is what makes autocrlf=true and autocrlf=false peers publish identical blobs, and the exit SIM alternates them — a non-conforming writer's form violation is applied instead of deferred (no Plan 2 peer is non-conforming).
- **R-10 Filters.** Ruling: Algorithm D3 discovery runs at start (and would run at every EPOCH_BASE change, which Plan 2 never makes); every git call carries `-c filter.<d>.required=true` for every driver plus `lfs`; filtered paths are hashed one per call by route (b) at the repository root; an rc 128 on a filtered path makes it a per-loop exclusion `filter_failure` and blocks every publish of that loop (ENG-24); no `filter-failure` record, no canary, no D4 preflight and no `FREEZE(CONFIG)` (Plan 7 start preflight, DAT-16…DAT-18) — `required=true` and "nothing published that loop" are what keep plaintext off the remote (INV-SECRET); the rest is start-time and doctor machinery — a permanently failing filter keeps the path in `not_converged` instead of producing a record.
- **R-15 Which trees ENG-10 governs.** Ruling: ENG-10's four operations govern code trees (A, `S_raw`, `S_disk`, `M_disk`, ready-pair trees, P, OUT, C), built only by `write-tree` of a private or scratch index, `merge-tree`, whole-path replacement in a scratch index (`update-index -z --index-info`) and `commit-tree`; metadata trees (the state commit tree and its `journal/`, the registry tree, the board tree around `ops.jsonl`/`protocol.json`/`checkpoint/state.json`/carried `held/`) are built with `mktree -z` from existing blobs and trees — metadata holds no hunk-level code content (the failure class ENG-10 prevents), and nested metadata trees need tree entries a scratch index cannot hold — a later tree lint (Plan 7 L-GIT-FORBIDDEN tree rule) must allow-list `src/engine/state.ts`, `src/holds/registry.ts`, `src/board/boardCommit.ts` and `src/git/repo.ts`.
- **R-39 Conflict function scope.** Ruling: D8 steps 0 (a `local_only` path → DEFER; no Plan 2 source), 0a, 1, 2, 3 and 5 are in; D9 qualifies through `merge.insertionMerge` globs only (no grammars until Plan 4; tripwire legs (i) and (iii) run, leg (ii) needs a grammar); step 4's claim tie-break and REG-24's `placementCheck`/identity sub-check are Plan 4, so every Plan 2 displacement is K4 on the later publisher and rc 0 merge results are accepted as is, except the 01-engine §3.10 rename carry, which is in — "claims excluded" — until Plan 4 an rc 0 merge that misplaces an edit into a same-tail neighbour (merge-misplaces-edit-into-same-tail-neighbor) is published.

**Board and governor:**
- **R-12 Fold scope.** Ruling: the fold implements PRO-14…PRO-16 (the 7-step algorithm and generic validity), PRO-26…PRO-29 (checkpoints, compaction, verification, joiner replay), PRO-39's R and rank, PRO-47/PRO-48 (proto flag, `teamRegionSpec` unanimity) and the effects of `join`, `leave`, `seat_start`, `seat_end`, `event`, `caps` and `save` (its claim-release part is a no-op without claims); `claim`, `release`, `request`, `request_status`, `answer`, `note`, `presume_absent` and `hold` fold as deterministic no-ops in Plan 2 (Plans 3, 4 and 6 add their effects); the canonical state keeps the full key set with empty `claims`, `requests`, `holds` and `notes`; own-op rejections are acted on only for the generic checks (PRO-24 first bullet: renumber) — the roadmap says "claims excluded" and Plan 2 never emits those ops — a Plan 2 build folding a board written by a later build computes a different checkpoint (never happens: one plugin version per team).
- **R-13 `checkpoint_mismatch`.** Ruling: a mismatch that persists after one refold enters the VERSION publish pause in its board-only (regionSpec) form with `cause = checkpoint_mismatch` (02-protocol §8 question 2 default) — the peer keeps posting allowed board-only ops, each re-validated by every other fold — a peer with a wrong fold can still post board-only ops.
- **R-14 What the state ref persists beyond 01-engine §3.2.** Ruling: the outbox (ops with allocated seqs) is `meta.outbox`, the fold state is the blob `journal/keep/fold/state.json` with `meta.fold_board` naming its board commit (PRO-25), `meta.cs_human_next` is HLD-33's `n` and `meta.incident_next` numbers `incident-<n>`; all four are Plan 2 additions to the 01-engine §3.2 meta schema, flagged for that section (08-lifecycle §2.2 adds meta fields the same way) — 02-protocol requires the outbox and the fold state to be "persisted with the state" but 01-engine §3.2 names no field — a rename later costs a `meta.v` migration (LIF-37).
- **R-16 One throttle code.** Ruling: `HOST_THROTTLED` (02-protocol §2.1, PRO-55) is both the board `event{kind: health}` `reason_code` and the `status.json.message_code` of the fallback; 01-engine §2's `THROTTLE` is retired (one situation, two codes; 02-protocol owns the mechanism that posts and follows it); its status params are the union `{source, until_min, budget, fallback_left_s, signal}` — one situation one code (02-protocol §1.2) — a constant rename.
- **R-17 Fallback persistence.** Ruling: both rules hold and the stricter wins: ENG-05 persists the own fallback as `meta.throttle` (no timestamp; the 30-min timer restarts at daemon start), and PRO-55's first fetch of a run treats a `HOST_THROTTLED` event within the last 180 first-parent heights as folded at that fetch's completion — they do not contradict; each covers a restart the other misses — a restarted peer may run at B = 6 up to 30 min longer than needed.
- **R-18 When the health event is posted.** Ruling: PRO-55 wins over 01-engine §3.12: one `HOST_THROTTLED` event on an own signal that came from a push attempt, or from a fetch while other work is pending, unless one was folded or queued by this peer in the last 15 min Δmono; a follower never posts; an unpublished one is dropped once the mode is normal again — INV-PRO-QUIET and INV-CONVERGE's zero pushes after quiescence need a fetch-only 429 to post nothing — teammates follow a fetch-only throttle one window later.
- **R-19 Genesis budget outside 6–24.** Ruling: ENG-51 (an integer in 6–24 seeds `budget`, anything else gives 12) wins over 02-protocol §3.1 / §8 question 7 (clamp to the nearest bound), because 10-product's T-UX-budget-config treats `30` as an invalid config (DR_CONFIG FAIL), not a clampable one — tie-breaker named — a team that committed 30 gets 12 instead of 24.
- **R-20 Pacing after a transient rejection.** Ruling: the next attempt waits for the stricter of PRO-44 (throttle level k + 1, `G_eff` doubling ≤ 60 s) and ENG-44's §3.6 backoff (30 s doubling to 5 min) — both are MUSTs — the third (NONRETRYABLE) rejection arrives ≈ 90 s after the first instead of ≈ 30 s.
- **R-21 Governed pushes without a window.** Ruling: the genesis host probe (PRO-49 steps 1–5) and the genesis push go through `governedPush()` and are counted for the per-peer cap and the sliding guard, but do not wait for a window or the `G_eff` spacing (there is no board tip to anchor on; PRO-49: "bounded by the per-peer cap"); the pushes of the human-typed `/cowork recover` likewise — no spec text exempts them from `may_attempt`, so this part is a Plan 2 decision argued from glossary §8 (INCIDENT allows exactly "the pushes of the human-typed `/cowork recover`", a human action like save, whose two pushes 02-protocol §3.8 places "inside one window") and from the incident itself (the board was rewritten, so there is no trustworthy anchor), flagged; the ENG-21 displaced copy waits for an ordinary window; the fallback namespace (PRO-50 opt-in, SEC-16) is out (Plan 7), so `custom_refs = false` refuses `START_REFUSED_CUSTOM_REFS` — a genesis spends ≤ 6 attempts within a minute on one peer, inside the cap.

**Engine, start and daemon:**
- **R-08 Branch moves are out (roadmap gap).** Ruling: ENG-47…ENG-50 (base moves, save completion, base-move records, the EPOCH_BASE change), the save primitives of ENG-49 and adopt are out and assigned to Plan 7, where save and adopt, their main producer and consumer, live (no roadmap row lists base moves: flagged); Plan 2 fetches the branch refspec, computes `Hb = live_base(TIP)`, writes `BRANCH_REWRITTEN` to `status.json` when `Hr` is missing or `Hb` is not an ancestor of `Hr`, and otherwise ignores `Hr ≠ Hb` (EPOCH_BASE stays `Hb`); join with `HEAD == Hr ≠ Hb` refuses `START_HEAD_AHEAD` with param `base_move: "unsupported"` — no SIM run moves the branch, and a base move without base-move records and save would be a new revert path — after an external push to the live branch no new peer can join until Plan 7; running peers keep syncing on the old base.
- **R-09 Minimal epoch guard.** Ruling: loop step 0c is a Plan 2 subset of LIF-10/LIF-11: the observation set (symbolic HEAD, HEAD oid, `refs/stash`, the markers `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `BISECT_LOG`, `rebase-merge/`, `rebase-apply/`, `sequencer/`) read with `GIT_OPTIONAL_LOCKS=0`; equal to `meta.expected_epoch` with no marker (E1) → proceed; anything else → `FREEZE(EPOCH)` (no daemon-initiated write, no code publish; board `freeze`/`unfreeze` events), lifted automatically when E1 holds again; RECONCILE and rows E2–E6 are Plan 7 — without it a human `git checkout` or `reset` on a live clone (the real-remote harness clones, or any clone running `daemon.js run`) would be snapshotted and published as a mass revert — a human commit on the live branch freezes the clone until HEAD returns to `H_adopt` (Plan 7's E2 reconcile lifts it properly).
- **R-11 Lease.** Ruling: `LeasePort` with the binding `alwaysLeased` (`idleMs() = 0`) for the foreground `daemon.js run` (a running foreground daemon is its human's lease) and for SIM; the engine still implements CCI-50/ENG-13's 2-min stop and 10-min drain against `idleMs()` — the rule's shape is fixed now and Plan 5 binds seat and human leases — none (a binding change).
- **R-22 Genesis and join with local work.** Ruling: `startDispatch(core, {publishLocal})`, at genesis and at join: when the LIVE paths of `diff(A, S_disk)` (M of LIF-08, with `A = tree(HEAD)`) are non-empty and `publishLocal` is null, start refuses `START_PREVIEW{n_in, m_out, unshared}` (no preview id: preview/confirm is Plan 7); `'none'` holds M in one ON_DISK PIN with guard `join` (masked, local registry); `'all'` makes M one human CS captured after the first apply — LIF-08's semantics without the preview UI — none.
- **R-23 `daemon.js run` dispatch.** Ruling: Table 3.3-A with its automatic-respawn column: state present + board absent → RESTART, whose incident check sets `INCIDENT` (not `START_BOARD_GONE`, which is Plan 7's human `/cowork start` refusal) — the foreground daemon is how Plan 2 keeps a clone live across runs, so a human re-running it is a respawn — none (Plan 7's start verb applies the human column).
- **R-24 Restart and lost state are in.** Ruling: ENG-53 (own-leftover cleanup, writer rollback, `.old` resolution, the per-path many-candidate decision, push-intent resolution by observation, the HLD-41 rebase in the same update) and ENG-54 (per-path rebuild with `restart` records) are in Plan 2; the adopt-intent branch is out (Plan 7) — a human re-running `daemon.js run` and the SIM crash matrix both restart — none.
- **R-25 Shrink attribution (spec gap).** Ruling: glossary §20, ENG-25 and HLD-32 require "attribution" before a > 50 % or to-0-bytes shrink publishes, but no hook ever attributes a human edit, so a human shrink could never publish; Plan 2 routes the decision through `AttributionPort.shrinkAttributed(path)`, whose Plan 2 binding `humanOnlyAttribution` answers true, so a shrink publishes once two consecutive detection ticks ≥ 1 s apart (Δmono) saw the same shrunken stat; `removalAttributed` answers false (deletions use the 1 s two-read rule); flagged for 05-holds/06-claude; Plan 5 binds hook windows for seat deltas — the W2 torn capture lasts microseconds, while two reads ≥ 1 s apart with an unchanged stat are a real truncation — a truncation left unchanged for ≥ 1 s is published (it would be published after Plan 5 too once attributed).
- **R-26 Single instance and remote pinning.** Ruling: `daemon.js run` takes an advisory `<gitdir>/cowork/daemon.lock` (exclusive create holding `{pid, plugin version, instance id}`; a lock whose pid is not alive is replaced; the IPC-bind single instance is Plan 5); it resolves the remote by LIF-05's order (`branch.<b>.pushRemote` → `remote.pushDefault` → `branch.<b>.remote` → `--remote` → the only remote; `origin` is never assumed), requires fetch URL == push URL (`SEC_REFUSE_REMOTE_SPLIT`), refuses a `url.*.insteadOf`/`pushInsteadOf` prefix of either (`SEC_REFUSE_URL_REWRITE`), pins `meta.pinned.url` and the repo identity (sorted root oids of the fetched branch), and passes the resolved `core.sshCommand` to `createGitRunner` (Plan 1 ledger minor #4); the 60 s drift re-check is Plan 7 — two foreground daemons on one clone after a misread stale lock still cannot both write, because the state CAS makes the second one exit (ENG-03).
- **R-27 Engine events.** Ruling: Plan 2 raises the engine events of 01-engine §3.16 into `status.json` (`message_code`, `message_params`) and the daemon log only; delivery to seats and OS notifications are Plans 5–7; the board gets `event{kind: freeze|unfreeze}` (EPOCH), `event{kind: health, reason_code: HOST_THROTTLED}` and `event{kind: nonretryable}` (after the pause lifts); `INCIDENT` posts nothing (INCIDENT forbids pushes) — none.
- **R-28 Leaving NONRETRYABLE.** Ruling: the human `/cowork resume` verb is Plan 7; Plan 2 offers `node dist/daemon.js resume --repo <p> --branch <b>`, which clears `meta.nonretryable` and the rejection streak by one state CAS while no daemon holds the lock, so the next run retries once (the `host-reject` PIN stays) — none.
- **R-29 Mutant switches.** Ruling: `EngineDeps.testMutants` (test builds only; Plan 7's L-DIST must reject a bundle that can set it) re-introduces M05, M06, M07, M12, M17, M18 and M20 at exactly one site each, so every oracle Plan 2 adds is shown to fail on its mutant (TC-TST-02 form) — a test seam sits in `dist/daemon.js` until Plan 7 strips it by define.
- **R-35 Heartbeat.** Ruling: `status.json.heartbeat_mono_ms` comes from `EngineDeps.heartbeatMs`, bound in production to `machineMonoMs()` (`process.hrtime.bigint()`, machine-wide; `performance.now()` is per-process) and in SIM to the peer's `VirtualClock.monoMs` — 01-engine §3.16 — none.
- **R-37 Daemon log.** Ruling: `<gitdir>/cowork/log/daemon-0.jsonl`, append-only JSON lines of codes, oids, paths and numbers (never file content, never host text outside the doctor fields of ENG-45); rotation (10 MB × 5, 14 days) is Plan 7 — none.
- **R-38 fsmonitor and untracked cache.** Ruling: `core.fsmonitor=false` (the runner default) and `core.untrackedCache=false` on the private index in Plan 2 (DAT-21/DAT-22 choose `true` only after their perf gates, Plan 7) — `false` is always safe (03-data §3.5) — the idle metadata walk of 01-engine §8 question 8 is measured only in Plan 7's perf gates.

**Implementation notes the plan cannot verify yet (each pinned by a named test):**
- **R-30 merge-tree arguments are always commits.** Ruling (controller, overrides the architect's measure-then-fallback form): `mergeTree` always wraps base, ours and theirs in parentless commits built by `commit-tree` with the fixed identity `cowork <merge@cowork.invalid>`, the ordinary commit-date rule (glossary §18: the virtual clock's date in test builds through `wallMsForDates`, never a set date in release builds) and message `cowork-merge`, and passes those commits to `merge-tree --write-tree -z --name-only --no-messages --merge-base=<base commit> <ours commit> <theirs commit>` — the git 2.43 floor's acceptance of tree arguments is unmeasured and CI runs only the newest git, so one path that works on every floor-or-newer git replaces a guess; the wrapper commits are unreferenced scratch objects (deterministic per seed in SIM) written only on apply/publish occasions, which already write objects (glossary §26.1 W6); never a merge-base lookup — cost if wrong: one extra `commit-tree` per merge input (cached by tree oid within an iteration).
- **R-36 One `cat-file --batch --filters` process per write group.** The runner pipes one `stdin` Buffer per call (Plan 1 `runner.ts`), so the writer sends every `<oid> <path>` line of a group in one call and parses the batch output; a persistent process is not available. Pinned by Task 10's "P0 smudges a whole group in one git call".
- **`update-index --refresh` writes no object.** 01-engine §3.3 calls this REASONED; Task 9's "detection ticks write no objects" (01-engine test 47) pins it with a loose-object count.
- **`live_base` lookup.** `GitRepo.newestWithTrailer(tip, 'Cowork-Base')` uses one `rev-list --first-parent -1 --grep=^Cowork-Base: <tip>` (cost independent of chain length); Task 12's "liveBase finds the genesis base on a 300-commit chain in one git call" pins it. (Superseded by Task 12 round 2: liveBase memoizes per GitRepo — 0 calls for the same tip, one incremental rev-list over the new commits when the tip continues the remembered one, else a full walk; Task 13 reuses one GitRepo across iterations.)

**SIM and CI:**
- **R-31 Exit profile.** Ruling: the exit criterion runs profile `edits`: 3 peers (odd peers `core.autocrlf=true`, Plan 1 `clonePeer`), 40 generated steps per seed (edits and engine iterations), human edits only (new files, own-file edits, disjoint-band edits of a shared file, same-line edits → K4, CRLF and LF rewrites, own-file deletions, end-of-file appends to `notes.md` → insertion-concat, a temp-named and a secret-named new file → NOT_ADMITTED), no filter attributes, no network faults, no crashes; then quiescence; oracles INV-FF, INV-OID, INV-FIRSTPARENT, INV-BASE, INV-PUSHED-IS-MERGE, INV-CONVERGE. A second profile `faults` (partitions of up to 10 virtual minutes, 1–2 transient rejections, lease races by yield interleaving, crash injection p = 0.02 per step with restart) runs with the same oracles in CI only — "human-only edits" (roadmap) — none.
- **R-32 INV-CONVERGE, operationally.** Ruling: after the op budget the harness runs rounds; in each round every peer clock advances `loopMs` = 2.5 s and every engine runs one iteration in peer-name order. T* is the remote board tip once every peer has run K = 20 iterations since the tip last changed (the count restarts at every change; at most 400 rounds, else the run fails "no quiescence"). The oracle then requires, for every peer: `LA_B == T*`; `A == tree(live_code(T*))` and the working tree's stored form `== tree(live_code(T*))` on every LIVE path not in its `status.json` `not_converged`; then 40 further rounds with zero push attempts by any peer and an unchanged tip — 02-protocol §3.11 counts K from observing T*, 11-testing §3.3 runs K then 40 more — a correct engine that needs more than 20 loops after T* fails (that is the spec's bound).
- **R-33 CI budgets.** Ruling: each PR leg runs `npm run sim:seeds -- --profile edits --seeds 80` and `--profile faults --seeds 20` with a per-leg seed offset (Node 20 legs 0–99, Node 24 legs 100–199), 4 child processes in parallel, job timeout 45 min; `.github/workflows/sim-exit.yml` (manual dispatch and nightly) runs 1,000 `edits` seeds per OS in 10 shards — glossary §20 "200 seeds/OS per PR" — the nightly 10,000/2,000/1,000 budgets of 11-testing §3.11 start in Plan 7.
- **R-34 Real remote.** Ruling: `tools/real/two-clone.ts` runs only when `COWORK_REAL_REMOTE` is set, refuses (`TEST_TARGET_REFUSED`, zero pushes) a remote whose default branch lacks `.cowork-test-repo` (TST-16), creates the per-run branch `ci/<run_id>/main` and runs both engines under the test namespace `refs/cowork-ci/<run_id>/` (glossary §4; the sandbox repository keeps earlier runs' state), takes credentials only from the user's credential helper through DAEMON_ENV, prints every URL through `sanitizeUrl`, and never deletes remote refs (cleanup is the separate, explicit `tools/real/cleanup.ts`, limited to one run's `refs/cowork-ci/<run_id>/*` and `refs/heads/ci/<run_id>/*`) — TST-16 isolation — none.

**Spec conflicts and gaps recorded above:** throttle code `THROTTLE` vs `HOST_THROTTLED` (R-16); fallback persistence (R-17); health-event posting (R-18); genesis budget clamp vs 12 (R-19); transient-rejection pacing (R-20); shrink attribution for human edits (R-25); base moves in no roadmap row (R-08); `checkpoint_mismatch` form (R-13, 02-protocol §8 Q2 default); metadata trees vs ENG-10 (R-15); outbox and fold-state persistence fields absent from 01-engine §3.2 (R-14); recover pushes exempt from the governor window without explicit spec text (R-21).

### Out of Plan 2 (owner plan)

- **Plan 3 (holds and change-sets):** hold mirroring (`hold` ops and their fold effect, board `held/` entries, PRO-21/PRO-24 hold rejections), offers, record evaluation R1, REBASE/PARK/RESTORE and `/cowork resolve`, MASK step 5 in `merge-file` form, the revert detector, the mass-change breaker (`FREEZE(MASS)`), 60 s transient-exclusion records, INCOMING records (HLD-54, HLD-55), S6 auto-park, seat CSs, edit checkpoints and the edit check, publication-group readiness beyond human CSs, T0/K7 (HLD-50), DAT-08 disk repair, the D2 incoming form check, the INV-NOLOSS, INV-MASK and INV-GROUP oracles.
- **Plan 4 (regions and claims):** claim ops and their fold effects (`claim`, `release`, grants, reservations), B1 publish gate, REG-24 placement/identity check, K1/K2/K3/K5/K6/K7, D8 step 4 tie-break, D9 grammar tripwire and grammar-based qualification, `regionSpec` from grammars, INV-FENCE.
- **Plan 5 (Claude Code integration):** seats and `seat_start`/`seat_end` emission, hooks, gate G1–G4, fences, READ leases and TXNs (so the defer reasons `fence`, `read_lease`, `txn`, `conflicted_leased` never arise in Plan 2), MCP, IPC and its single-instance bind, `pathState` over IPC, seat and human lease bindings, hook attribution windows, FakeHost.
- **Plan 6 (coordination):** `request`, `request_status`, `answer`, `note`, `presume_absent` (effects and emission), the other PRO-37 consumers (the SUSPECT overlay, `Coordinator.markOwnClaimsSuspect`), doorbells, K-event templates, engine-event delivery to seats. (2026-10-08, R5-06, X-85, F-P2-4: the SUSPECT gate half is Plan 5's; `Engine.requestFreshFetch(): void` stays as landed, Plan 5 adds `freshFetch`, X-77.)
- **Plan 7 (lifecycle, security, product):** base moves and save completion (ENG-47…ENG-50), save, adopt and the adopt intent, the HEAD decision table rows E2–E6 and RECONCILE, the start preflight (LIF-04, D4 filter preflight, canary, `FREEZE(CONFIG)`, the 60 s URL drift re-check), the `/cowork` verbs (start, stop, pause, resume, recover, done, resolve, review) and preview/confirm ids, `--fresh`, the fallback namespace, the secrets scanner (SEC-07, SEC-08) and content scan, quarantine review (SEC-32, SEC-33), config validation (CFG-02), doctor, OS notifications, i18n and templates, log rotation, L-DIST, the nightly mutation gate, STRESS mode, the GitHub soak, the federated job, the regression-corpus import (TST-10) and the shrinker (TST-09).

---

## File Structure

```
src/ports/fs.ts                 (modify) + FsLstat (bigint mtime_ns, ino), sameStat, lstat, writeFileExclusive, rmdir,
                                appendFile, realpath, freeBytes; mkdirp gains an optional mode
src/ports/clock.ts              (modify) + machineMonoMs()
src/ports/trace.ts              Trace port: TraceEvent union, PushPurpose, ASetCause, noTrace
src/ports/lease.ts              LeasePort, alwaysLeased, LEASE_STOP_SYNC_MS, LEASE_EXIT_MS
src/ports/log.ts                Log port: nullLog, fileLog (JSONL of codes/oids, never content)
src/git/flags.ts                (modify) --no-replace-objects first; gitDir/workTree/config/literalPathspecs; absolute paths
src/git/oid.ts                  Oid brand, ABSENT, parseOid, isOid, oid12
src/git/repo.ts                 GitRepo: typed plumbing (objects, trees, indexes, commits, refs CAS, first-parent walks)
src/git/trailers.ts             commit subject + trailer formatting and parsing
src/git/merge.ts                mergeTree (-z --name-only --no-messages --merge-base), mergeFile (--object-id)
src/git/push.ts                 pushSpec (the only refspec builder), push argv, porcelain parse, runPush, deleteProbeRef
src/git/fetch.ts                fetchRefs (explicit refspecs, ls-remote fallback), lsRemote
src/git/httpStatus.ts           readHttpThrottle: HTTP 429/5xx from git's report, fallback signal only
src/sec/validators.ts           SEC-35 subset: validPathSyntax, validId, validName
src/data/rows.ts                rows, form, binary sniff, conflict-marker and restore-marker rows
src/data/linediff.ts            Myers matched rows with endings ignored
src/data/canon.ts               Algorithm D1
src/data/blobRoutes.ts          routes (b) and (c), the DAT-07 new-path hash
src/data/conflict.ts            Algorithm D8 (steps 0, 0a, 1–3, 5) and D9 insertion-concat
src/data/attrs.ts               AttrCache: check-attr under attr.tree=EPOCH_BASE
src/data/filters.ts             Algorithm D3: filter drivers and their fingerprint
src/data/config.ts              lenient .cowork/config.json reader; genesisBudget
src/data/scope.ts               D5 scopeOfTracked, D6 admitNew, D7 portable, wildmatch, built-in name lists
src/board/ids.ts                peer/epoch ids, op ids, base32c, H()
src/board/canonicalJson.ts      RFC 8785 serializer
src/board/ops.ts                glossary §7 op schema, parse/serialize, ops.jsonl caps
src/board/protocol.ts           protocol.json: genesis seeding, stricter-of reader
src/board/boardCommit.ts        board commit build/read, live/board trailers, Cowork-CS(-Paths), shape checks
src/board/fold.ts               fold state, the 7-step fold, checkpoints, compaction, R and rank, Folder
src/board/outbox.ts             outbox: seq allocation, PRO-09 renumbering, PRO-45 state filter
src/board/governor.ts           governor: windows, rank, cap, sliding guard, throttle level, fallback
src/holds/record.ts             glossary §9 record schema, Plan 2 guard subset
src/holds/registry.ts           HoldRegistry on refs/cowork-local/<e>/holds
src/holds/mask.ts               MASK steps 1–4 and whole-path step 5
src/holds/changesets.ts         human change-set, ready pairs, HLD-41 rebase, composeP
src/holds/groups.ts             HLD-53 receiver write groups
src/engine/deps.ts              EngineDeps, AttributionPort, MutantId, regionSpecId, PLAN2_REGION_SPEC
src/engine/refs.ts              RefNamespace, refNames()
src/engine/meta.ts              meta.json (01-engine §3.2 + the flagged Plan 2 fields)
src/engine/state.ts             StateStore: state commit read, CAS write, journal layout
src/engine/stagedRead.ts        stagedRead, StageDir
src/engine/statCache.ts         StatCache
src/engine/snapshot.ts          Snapshotter: detection tick, materialize, reseed
src/engine/diskEq.ts            DISK_EQ and the many-candidates form
src/engine/writer.ts            two-phase verifying writer, ring, rollback, round trip, writeLocal
src/engine/fetcher.ts           single-flight fetch, offline state, network backoff
src/engine/incident.ts          FP_OK, the incident check, live_base
src/engine/pushResult.ts        classifyPublish: outcome classification (never reads text)
src/engine/core.ts              EngineCore, IterationCtx, createEngineCore
src/engine/apply.ts             applyStep (01-engine §3.11)
src/engine/assertions.ts        ENG-41 pre-push asserts
src/engine/publish.ts           publishStep (01-engine §3.12), governedPush, NONRETRYABLE, throttle handling
src/engine/start.ts             start dispatch, genesis with the host probe, join
src/engine/restart.ts           restart (ENG-53), lost-state per-path rebuild (ENG-54)
src/engine/recover.ts           incident entry, displaced copy, recover (restore and re-anchor)
src/engine/epoch.ts             minimal epoch guard
src/engine/status.ts            status.json: precedence and writer
src/engine/loop.ts              Engine class, iterate(), runLoop()
src/daemon/run.ts               foreground daemon: args, remote resolution, lock, runner, Engine, signals
src/entry/daemon.ts             (modify) `run`, `recover`, `resume`, `--version`
test/helpers/repoFixture.ts     temp repo + bare remote + GitRepo for integration tests
test/helpers/coreFixture.ts     N peers with EngineCores on real clones and virtual ports
test/helpers/engineFixture.ts   N peers with Engines (start, iterate, inspect)
test/sim/faultfs.ts             (modify) locks, no hard links, interpose, new ops
test/sim/traceRecorder.ts       TraceRecorder
test/sim/harness.ts             (modify) SimOptions: generator, quiescence, trace, ctx.engines
test/sim/engineAdapter.ts       realEngine(): the real Engine as a SimEngine
test/sim/generators.ts          human-edit generator, profiles `edits` and `faults`, Plan 2 seed files
test/sim/oracles.ts             (modify) INV-FF trace clause; INV-FIRSTPARENT, INV-BASE, INV-PUSHED-IS-MERGE, INV-CONVERGE
tools/sim/run-seeds.ts          seed runner: profiles, shards, parallel child processes, report
tools/sim/run-shard.ts          child process: runs a seed list, prints one JSON line per seed
tools/real/two-clone.ts         real-remote two-clone sync test (COWORK_REAL_REMOTE)
tools/real/cleanup.ts           deletes one run's refs/cowork-ci/<run_id>/* and refs/heads/ci/<run_id>/*
tools/lint/rules.ts             (modify) L-GIT-FORBIDDEN, L-FS-PORT, L-OBJ-WRITE, L-PUSH-ARGV, L-CLASSIFY-TEXT, L-MIRROR
package.json                    (modify) scripts sim:seeds, sim:exit, real:two-clone, real:cleanup
.github/workflows/ci.yml        (modify) 100 SIM seeds per leg, timeout 45 min
.github/workflows/sim-exit.yml  1,000 `edits` seeds per OS in 10 shards (dispatch + nightly)
test/crashpoints.json           unchanged: the 14 names Plan 2 places are already catalogued
```

Unit tests live in `test/unit/`, real-git tests in `test/integration/`, each named in its task.

## Interfaces (the contract every task implements exactly)

Plan 1 names are used as they are in the code (`Clock`, `Anchor`, `anchorNow`, `elapsedMono`, `ownStaleness`, `suspendGapMs`, `SUSPEND_GAP_THRESHOLD_MS`, `Random`, `seededRandom`, `randomHex`, `ulid`, `Scheduler`, `Fs`, `realFs`, `crashpoint`, `KilledAt`, `setCrashHandler`, `Ports`, `enc`, `EncTooLongError`, `meetsFloor`, `parseGitVersion`, `buildDaemonEnv`, `GitCallOptions`, `GitIdentity`, `buildGitInvocation`, `MERGE_FLAGS`, `GitRunner`, `GitResult`, `createGitRunner`, `PushOutcome`, `classifyPush`, `NONRETRYABLE_STREAK`, and in tests `VirtualClock`, `VirtualScheduler`, `FaultFs`, `createBareRemote`, `BareRemote`, `clonePeer`, `PeerClone`, `seedRemote`, `generateBigBomCrlf`, `runSim`, `SimEngine`, `EngineFactory`, `Oracle`, `SimContext`, `makeTempRoot`, `testRunner`, `retryGit`). Everything below is new or changed. A comment `(…)` after a member is part of the contract.

### Ports

```ts
// src/ports/fs.ts — additions (Plan 1 members unchanged)
export interface FsLstat {
  size: number;
  mtimeNs: bigint;           // lstat({ bigint: true }).mtimeNs
  ino: bigint;
  dev: bigint;
  mode: number;              // st_mode bits
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
export function sameStat(a: FsLstat, b: FsLstat): boolean;      // size, mtimeNs, ino, dev and mode all equal
export interface Fs {
  // …readFile, writeFile, rename, link, unlink, stat, readdir, rmrf as in Plan 1
  mkdirp(p: string, mode?: number): Promise<void>;              // mode for the directories it creates (0o700 for <gitdir>/cowork/tmp)
  lstat(p: string): Promise<FsLstat | null>;                     // null on ENOENT or ENOTDIR; never follows a symlink
  writeFileExclusive(p: string, data: Buffer): Promise<void>;    // open 'wx', one write, fsync, close; EEXIST when p exists
  rmdir(p: string): Promise<void>;                               // non-recursive; ENOTEMPTY and ENOENT propagate
  appendFile(p: string, data: Buffer): Promise<void>;            // Buffer only (TypeError otherwise)
  realpath(p: string): Promise<string>;                          // realpathSync.native semantics
  freeBytes(dir: string): Promise<number | null>;                // statfs bavail × bsize; null where statfs is unavailable
}
// realFs implements every member; readFile stays one open-read-close (share read+write+delete on Windows, glossary §26.1 W3).

// test/sim/faultfs.ts — additions
export type FaultOp = 'readFile' | 'writeFile' | 'rename' | 'link' | 'unlink' | 'lstat' | 'writeFileExclusive' | 'rmdir' | 'appendFile';
export type LockMode = 'share-none' | 'share-read';
export class FaultFs implements Fs {
  constructor(inner: Fs);
  addRule(r: FaultRule): void;                                   // FaultRule.op uses the widened FaultOp
  readonly hits: Map<string, number>;
  /** A Windows holder on every path containing pathIncludes: 'share-none' → readFile, rename, unlink and link of it fail EBUSY;
   *  'share-read' (Excel-like) → readFile passes, rename and unlink fail EPERM. Errors are built like Node's. Returns release(). */
  holdLock(pathIncludes: string, mode: LockMode): () => void;
  /** F-FS-8: while on, every link() fails EPERM and creates nothing. */
  setNoHardLinks(on: boolean): void;
  /** Runs fn(path) before the inner op on a matching path, at most `times` times (default 1): the races of F-ED-4 and F-ED-7. */
  interpose(op: FaultOp, pathIncludes: string, fn: (p: string) => Promise<void>, times?: number): void;
  /** Every call in order: `${op} ${path}`, or `${op} ${from} -> ${to}` for rename and link. */
  readonly calls: string[];
  // + every Fs member
}

// src/ports/clock.ts — addition
/** Machine-wide monotonic ms (process.hrtime.bigint() / 1e6), comparable between processes on one PC; only for heartbeat_mono_ms. */
export function machineMonoMs(): number;

// src/ports/trace.ts — trace events (11-testing §2); test builds record them, release binds noTrace
export type PushPurpose = 'publish' | 'board_only' | 'genesis' | 'probe' | 'displaced' | 'recover';
export type ASetCause = 'genesis' | 'join' | 'write_verified' | 'disk_equal' | 'push_confirmed' | 'unmanaged_follow' | 'restart_decision' | 'lost_state' | 'recover_reanchor';
// disk_equal: ENG-36's applicable, non-deferred path with M_disk[p] == S_disk[p], whose A[p] := TIP[p] needs no write
export type TraceOutcome = 'ok' | 'landed' | 'lease_lost' | 'transient' | 'network' | 'nonretryable' | 'denied';
export type TraceEvent =
  | { kind: 'iteration'; peer: string; n: number; fetched: boolean; applied: boolean; pushes: number }
  | { kind: 'fetch'; peer: string; ok: boolean; board: string | null; code: string | null; branch: string | null }
  | { kind: 'state'; peer: string; prev: string | null; next: string; laC: string; laB: string; base: string }
  | { kind: 'merge'; peer: string; use: 'apply' | 'publish'; base: string; ours: string; theirs: string; aTree: string; laC: string; laB: string; tip: string; t: string; rc: number }
  | { kind: 'A_set'; peer: string; path: string; blob: string | null; cause: ASetCause }
  | { kind: 'apply'; peer: string; tip: string; written: readonly string[]; deferred: readonly string[] }
  | { kind: 'publish'; peer: string; t: string; tip: string; aTree: string; pTree: string; outTree: string; c: string | null; bnew: string; conflicted: readonly string[]; replaced: ReadonlyArray<{ path: string; blob: string | null }> }
  | { kind: 'push'; peer: string; purpose: PushPurpose; argv: readonly string[]; bnew: string | null; outcome: TraceOutcome }
  | { kind: 'incident'; peer: string; n: number; why: string; observedBoard: string | null }
  | { kind: 'hold'; peer: string; id: string; holdKind: 'PATCH' | 'PIN'; guard: string; paths: readonly string[]; residence: 'ON_DISK' | 'OFF_DISK' };
// peer = peer_id; oids as hex strings; no durations and no wall times (SIM determinism, TST-03).
export interface Trace { emit(ev: TraceEvent): void; }
export const noTrace: Trace;

// src/ports/lease.ts (CCI-50; ruling R-11)
export interface LeasePort { /** Δmono since the last valid seat or human lease ended; 0 while one is valid. */ idleMs(): number; }
export const alwaysLeased: LeasePort;               // idleMs() === 0
export const LEASE_STOP_SYNC_MS = 120_000;          // no capture, apply or new publish
export const LEASE_EXIT_MS = 600_000;               // drain and exit, last status IDLE_NO_SESSION

// src/ports/log.ts (ruling R-37)
export type LogLevel = 'info' | 'warn' | 'error' | 'security';
export type LogParam = string | number | boolean | null;
export interface Log { write(level: LogLevel, code: string, params?: Readonly<Record<string, LogParam>>): void; }
export const nullLog: Log;
/** Appends {"t":<wall ms>,"level","code","params"} lines through the Fs port, one write at a time (queued). */
export function fileLog(fs: Fs, clock: Clock, file: string): Log;
```

### Git layer

```ts
// src/git/flags.ts — additions (ledger carry; ENG-08)
export interface GitCallOptions {
  // …class, cwd, filterDrivers, attrTree, fsmonitor, identity, wallMsForDates, indexFile, stdin, extraEnv as in Plan 1
  gitDir?: string;                                  // --git-dir=<abs>; relative → throws before spawning
  workTree?: string;                                // --work-tree=<abs>; relative → throws before spawning
  config?: Readonly<Record<string, string>>;        // extra -c key=value after the forced list; a forced key throws
  literalPathspecs?: boolean;                       // GIT_LITERAL_PATHSPECS=1
  abort?: AbortSignal;                              // ruling P2-ABORT: on abort the process tree is killed like a watchdog kill; GitResult.aborted = true
}
export const GLOBAL_PREFIX: readonly string[];      // ['--no-replace-objects']
// argv = [...GLOBAL_PREFIX, --git-dir=…?, --work-tree=…?, ...Plan 1 -c list, ...config, ...MERGE_FLAGS?, sub, ...post, ...rest]
// GitResult gains `aborted: boolean` (P2-ABORT). Forced per subcommand (ruling P2-PUSHCFG): every push carries -c push.pushOption= -c push.gpgSign=false -c push.followTags=false -c push.recurseSubmodules=no; every fetch carries -c core.logAllRefUpdates=always (ENG-02); all are FORCED_KEYS.
// indexFile must be absolute (throws otherwise).
// Ruling P2-NTFS: `-c core.protectNTFS=false` is allowed ONLY on index-only git calls on private/scratch indexes (read-tree, update-index --index-info/--cacheinfo, write-tree, ls-files -s), never on a call that touches a work tree, and only together with P2-DOTGIT. Ruling P2-DOTGIT: a path with a component that case-folds to `.git`, to `.git` followed only by dots or spaces, to `git~<digits>`, or that carries an NTFS stream suffix (`:`), is a dotgit alias on EVERY platform: never admitted (D6), always carried (P2-CARRY), never lstat'd, read, staged or written by any engine module (src/data/scope.ts exports `isDotGitAlias(component)`, used by componentOk, the carry set, DiskEq, the writer and apply).

// src/git/oid.ts (ENG-09)
declare const OID_BRAND: unique symbol;
export type Oid = string & { readonly [OID_BRAND]: true };
export const ABSENT = 'ABSENT' as const;            // JSON form of an absent side/lease in records, intents and leases
export type Absent = typeof ABSENT;
export type OidOrAbsent = Oid | Absent;
export class OidError extends Error {}
export function parseOid(s: string): Oid;           // strips one trailing '\n'; only /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export function isOid(x: unknown): x is Oid;
export function oid12(o: Oid): string;              // first 12 hex chars

// src/git/trailers.ts (glossary §5)
export interface Trailer { key: string; value: string; }
export const SKIP_SUBJECT_PREFIX = '[skip ci] ***NO_CI***';
export function formatMessage(subject: string, trailers: readonly Trailer[]): Buffer;  // subject, blank line, `Key: value` lines; LF; CR/LF inside a field throws
export function parseMessage(raw: string): { subject: string; trailers: Trailer[] };    // trailers = the last paragraph's `Key: value` lines

// src/git/repo.ts
export interface RepoPaths {
  workTree: string;         // main-worktree root (realpath.native, absolute)
  gitDir: string;           // absolute git dir (== common dir; linked worktrees are refused)
  coworkDir: string;        // <gitDir>/cowork
}
export interface RepoContext {
  attrTree: Oid | null;               // EPOCH_BASE commit for -c attr.tree (null until known)
  filterDrivers: readonly string[];   // Algorithm D3 drivers (the runner always adds lfs)
  identity: GitIdentity;              // { name: display, email: `${peer_id}@cowork.invalid` } (glossary §5, SEC-03)
  wallMs: () => number;               // commit dates (honoured only in test builds)
}
export class GitCommandError extends Error { readonly argv: readonly string[]; readonly code: number; readonly stderrText: string; }
export type FileMode = '100644' | '100755' | '120000' | '160000';
export interface TreeEntry { path: string; mode: FileMode; oid: Oid; }         // a leaf of a recursive tree, full repo-relative path
export type TreeMap = ReadonlyMap<string, TreeEntry>;
export interface MktreeEntry { name: string; mode: FileMode | '040000'; type: 'blob' | 'tree' | 'commit'; oid: Oid; }
export type IndexEdit = { path: string; mode: FileMode; oid: Oid } | { path: string; remove: true };
export interface CommitSpec { tree: Oid; parents: readonly Oid[]; subject: string; trailers: readonly Trailer[]; }
export interface CommitInfo { oid: Oid; tree: Oid; parents: Oid[]; subject: string; trailers: Trailer[]; }
export interface RunOpts extends Partial<GitCallOptions> { okCodes?: readonly number[]; }
export class GitRepo {
  constructor(runner: GitRunner, paths: RepoPaths, ctx: () => RepoContext);
  readonly paths: RepoPaths;
  /** class 'local' and cwd = workTree unless given; filterDrivers and attrTree from ctx() unless given; rc ∉ okCodes (default [0]) → GitCommandError. */
  run(args: string[], opts?: RunOpts): Promise<GitResult>;
  resolve(rev: string): Promise<Oid | null>;                               // rev-parse --verify --quiet
  hasObject(o: Oid, type: 'commit' | 'tree' | 'blob'): Promise<boolean>;   // exact type: o exists and IS that type (no peeling: a commit is not a 'tree'); ENG-09 gate
  emptyTree(): Promise<Oid>;                                                // cached
  hashBytes(bytes: Buffer, write: boolean): Promise<Oid>;                   // route (c): hash-object [-w] --stdin --no-filters
  readBlob(o: Oid): Promise<Buffer>;                                        // cat-file blob
  readBlobs(oids: readonly Oid[]): Promise<Buffer[]>;                       // one cat-file --batch call
  smudgeBlobs(items: ReadonlyArray<{ oid: Oid; path: string }>): Promise<Buffer[]>;  // one cat-file --batch --filters call (attr.tree, cwd root; R-36)
  blobSizes(oids: readonly Oid[]): Promise<number[]>;                      // cat-file --batch-check
  readTreeMap(tree: Oid): Promise<TreeMap>;                                 // ls-tree -r -z --full-tree; LRU cache of 64 trees by oid
  writeTreeMap(entries: TreeMap, scratchIndex: string): Promise<Oid>;      // code trees: fresh scratch index + update-index -z --index-info + write-tree (ENG-10 (3)+(1))
  editTree(base: Oid, edits: readonly IndexEdit[], scratchIndex: string): Promise<Oid>;   // read-tree base into the scratch index, edits, write-tree
  mktree(entries: readonly MktreeEntry[]): Promise<Oid>;                   // metadata trees only (R-15)
  commitTree(c: CommitSpec, identity?: GitIdentity): Promise<Oid>;          // class refupdate; ctx identity unless given (only mergeTree's R-30 wrapper passes one), +0000, never signed
  readCommit(o: Oid): Promise<CommitInfo>;
  readRef(ref: string): Promise<Oid | null>;
  listRefs(prefix: string): Promise<Array<{ ref: string; oid: Oid }>>;     // sorted by ref
  /** update-ref --create-reflog -m <reason> <ref> <next> <prev|zero oid> (refupdate). false iff a re-read after a failure shows the ref ≠ prev (outcome, never stderr). */
  casRef(ref: string, next: Oid, prev: Oid | null, reason: string): Promise<boolean>;
  deleteLocalRef(ref: string, prev: Oid): Promise<boolean>;                 // refs/cowork-local/* and refs/cowork-remote/* only
  firstParents(tip: Oid, stop: Oid | null, max: number): Promise<Oid[]>;   // rev-list --first-parent <tip> [^stop], newest first
  firstParentCount(tip: Oid): Promise<number>;                              // rev-list --first-parent --count
  isAncestor(a: Oid, b: Oid): Promise<boolean>;                             // a reachable from b, by rev-list (never merge-base)
  newestWithTrailer(tip: Oid, key: string): Promise<Oid | null>;           // rev-list --first-parent -1 --grep=^<key>: <tip>
  readTreeIntoIndex(indexFile: string, tree: Oid): Promise<void>;          // read-tree <tree>; never -u or -m (refupdate)
  writeTree(indexFile: string): Promise<Oid>;                               // parseOid of stdout; empty stdout → OidError (ENG-09)
  editIndex(indexFile: string, edits: readonly IndexEdit[]): Promise<void>; // update-index -z --index-info
  listIndex(indexFile: string): Promise<Map<string, TreeEntry>>;            // ls-files -s -z, stage 0
  configGet(key: string): Promise<string | null>;
  configGetRegexp(regex: string): Promise<Array<{ key: string; value: string }>>;
}

// src/git/merge.ts (INV-BASE, DAT-40; ruling R-30)
export interface MergeTreeResult { rc: 0 | 1; tree: Oid; conflicted: string[]; }   // conflicted: unique, sorted
export class MergeFailedError extends Error { readonly code: number; }
/** merge-tree --write-tree -z --name-only --no-messages --merge-base=<base> <ours> <theirs> (MERGE_FLAGS by the runner; attr.tree and filters from the context). rc > 1 → MergeFailedError. */
export function mergeTree(repo: GitRepo, base: Oid, ours: Oid, theirs: Oid): Promise<MergeTreeResult>;
export interface MergeFileOpts { diff3?: boolean; markerSize?: number; labels?: readonly [string, string, string]; }
export interface MergeFileResult { rc: number; out: Buffer; }                     // 0 clean, > 0 conflicts, < 0 error
/** merge-file -p --object-id [--diff3] [--marker-size=M] [-L ×3] <current> <base> <other>; ABSENT sides are the empty blob. */
export function mergeFile(repo: GitRepo, current: OidOrAbsent, base: OidOrAbsent, other: OidOrAbsent, opts?: MergeFileOpts): Promise<MergeFileResult>;

// src/git/push.ts (ENG-09, ENG-43, INV-OID)
export type PushRefStatus = 'ok' | 'rejected' | 'none';         // 'none' = no porcelain line for that ref
export interface PushSpec { readonly ref: string; readonly newOid: Oid; readonly lease: OidOrAbsent; }
export interface PushOutcomeRaw {
  code: number; killedByWatchdog: boolean; durationMs: number;
  statuses: ReadonlyMap<string, PushRefStatus>;                   // per spec ref
  stderr: Buffer;                                                 // only for readHttpThrottle and the doctor record
  argv: readonly string[];
}
/** The only refspec builder: newOid re-validated by parseOid, ref starts 'refs/' with no '+' or ':'; anything else throws. */
export function pushSpec(newOid: Oid, ref: string, lease: OidOrAbsent): PushSpec;
/** ['push','--porcelain','--no-verify', ('-o', opt)…, '--force-with-lease=<ref>:<lease|>'…, url, '<newOid>:<ref>'…]; never --atomic, --force or '+'. */
export function buildPushArgv(url: string, specs: readonly PushSpec[], pushOptions: readonly string[]): string[];
export function parsePorcelain(stdout: Buffer, refs: readonly string[]): Map<string, PushRefStatus>;   // '!' → rejected; ' ', '*', '+', '=' → ok
export function runPush(repo: GitRepo, url: string, specs: readonly PushSpec[], pushOptions: readonly string[]): Promise<PushOutcomeRaw>;   // class 'network' (push watchdog 90 s)
/** The only remote deletion: `--force-with-lease=<ref>:<lease> :<ref>`; throws before spawning unless ref === allowed and the last path segment of allowed starts with 'probe-' (the caller passes RefNames.probe(own peer_id)). */
export function deleteProbeRef(repo: GitRepo, url: string, ref: string, allowed: string, lease: Oid): Promise<PushOutcomeRaw>;

// src/git/fetch.ts (ENG-18)
export interface FetchSpec { remote: string; local: string; }   // fetched as +<remote>:<local> (L-REFS allows '+' in fetch argv)
export interface FetchResult {
  ok: boolean;                                    // fetch rc 0, or ls-remote answered after a failed fetch
  remoteAnswered: boolean;                        // ruling P2-FETCHLOCAL: the remote answered (fetch rc 0 or ls-remote rc 0); ok=false with remoteAnswered=true is a LOCAL failure (e.g. a stale ref lock), never OFFLINE and never the network backoff
  values: ReadonlyMap<string, OidOrAbsent>;       // per remote ref, read back from the local refs; ABSENT when ls-remote shows it missing
  code: number; killedByWatchdog: boolean; durationMs: number;
  stderr: Buffer;                                 // only for readHttpThrottle
}
/** fetch <url> +<remote>:<local>… (network class; -c core.logAllRefUpdates=always); on failure one lsRemote of the same refs and, if it answered, a re-fetch of the present ones only. */
export function fetchRefs(repo: GitRepo, url: string, specs: readonly FetchSpec[], abort?: AbortSignal): Promise<FetchResult>;   // remoteAnswered is false when the re-fetch after an answered ls-remote is killed/aborted; a NETWORK failure of that re-fetch is a network failure (backoff), not a local one
export function lsRemote(repo: GitRepo, url: string, refs: readonly string[]): Promise<{ ok: boolean; values: Map<string, Oid> }>;
// fetchRefs, lsRemote, runPush and deleteProbeRef MUST pass class 'network' explicitly (GitRepo.run defaults to 'local'): only then does the
// runner's watchdog bound them (ls-remote gets the 45 s network watchdog via watchdogMs' class rule) — a blackholed remote must not hang the loop.

// src/git/httpStatus.ts (ENG-46; read only to start the fallback)
export type HttpThrottle = 'http_429' | 'http_5xx' | null;
export function readHttpThrottle(stderr: Buffer): HttpThrottle;  // e.g. "The requested URL returned error: 429", "HTTP 503"
```

### Validators and data

```ts
// src/sec/validators.ts (SEC-35 subset)
export function validPathSyntax(p: string): boolean;     // repo-relative POSIX, NFC, non-empty components, no '..', no leading '/', no drive letter, no ':', no '\', no NUL, ≤ 4,096 UTF-8 bytes
export type IdKind = 'op' | 'ulid' | 'cs' | 'hex128';
export function validId(kind: IdKind, s: string): boolean;   // op `<32 hex>/<32 hex>/<seq ≥ 1>`; ULID; cs `<seat_id>/<turn-seq>` | `<peer_id>/human/<n>`
export function validName(s: string): boolean;          // [\p{L}\p{M}\p{N}_ .'-]{1,64}

// src/data/rows.ts (03-data §2)
export type Eol = 'LF' | 'CRLF' | 'MIXED' | 'NONE';
export interface Form { bom: boolean; eol: Eol; }
export const BOM: Buffer;                                       // EF BB BF
export function rows(blob: Buffer): Buffer[];                   // BOM in row 1, CR in its row, a non-empty unterminated last row
export function form(blob: Buffer): Form;                       // DAT-03 (text, unfiltered paths only)
export function isBinaryBytes(blob: Buffer): boolean;           // NUL in the first 8,000 bytes
export function stripEnding(row: Buffer): Buffer;               // one trailing CRLF or LF
export function conflictMarkerRows(blob: Buffer): Set<string>;  // rows matching ^(<{7} |={7}$|>{7} |\|{7} ) after one CR is stripped (latin1 keys; ENG-41 (e))
export function hasRestoreMarkerRow(blob: Buffer): boolean;     // a row starting '<<<<<<< cowork:', '||||||| cowork:' or '>>>>>>> cowork:' (DAT-46)

// src/data/linediff.ts
/** Myers diff of two row lists compared with endings ignored; the matched index pairs in order. Pure. */
export function matchedRows(a: readonly Buffer[], b: readonly Buffer[]): Array<[number, number]>;

// src/data/canon.ts (Algorithm D1, DAT-05)
export type CanonResult = { ok: true; out: Buffer } | { ok: false; refuse: 'eol-bom' };
/** Pure, deterministic, idempotent. ref null (new path), skip (binary by EPOCH_BASE attributes, or filtered), isBinaryBytes(ref) (DAT-04: the path is binary by its blob) or isBinaryBytes(next) (D1 step 1: `new` binary) → next unchanged. */
export function canon(next: Buffer, ref: Buffer | null, skip: boolean): CanonResult;

// src/data/blobRoutes.ts (03-data §3.1; DAT-01, DAT-07)
export interface FilterFailure { readonly failed: 'filter'; readonly path: string; }
export function isFilterFailure(x: unknown): x is FilterFailure;
/** Route (b): hash-object [-w] --path=<path> <stageFile>, cwd = repo root, attr.tree + required filters; rc 128 → FilterFailure (nothing stored). */
export function hashRouteB(repo: GitRepo, path: string, stageFile: string, write: boolean): Promise<Oid | FilterFailure>;
/** Route (c): stored-form bytes (canon and concat output). */
export function hashRouteC(repo: GitRepo, bytes: Buffer, write: boolean): Promise<Oid>;
/** DAT-07: a new path in a call of its own, route (b) with -c core.autocrlf=input (EPOCH_BASE text/eol attributes still decide). */
export function hashNewPath(repo: GitRepo, path: string, stageFile: string, write: boolean): Promise<Oid | FilterFailure>;

// src/data/conflict.ts (Algorithm D8 steps 0, 0a, 1–3, 5 and D9; ruling R-39)
export type Stage = OidOrAbsent;
export type UnitKind = 'content' | 'other';      // 'other' = binary, filtered, mode, add/add, modify/delete, rename, directory/file
export interface ConflictCtx {
  repo: GitRepo;
  isText(path: string): boolean;                 // not binary (content or EPOCH_BASE `binary`/`merge=binary`, D9 (a)) and not filtered at EPOCH_BASE (DAT-04)
  insertionMerge(path: string): boolean;         // matches merge.insertionMerge
  concatAllowed: boolean;                        // D9 (c): no peer of the folded live set announced a regionSpec other than this peer's
  localOnly(path: string): boolean;              // covered by a non-terminal local_only record (always false in Plan 2)
  ref(path: string): Promise<Buffer | null>;     // ref(p) bytes for canon of a concat output
  write: boolean;                                // objects may be written (apply/publish)
}
export type ConflictVerdict =
  | { kind: 'CONCAT'; blob: Oid }                                                    // D9 or D8 step 0a; no record, no event
  | { kind: 'TAKE_TIP'; entry: Stage; stages: { s1: Stage; s2: Stage; s3: Stage } }  // the caller records the stages before any disk write
  | { kind: 'DEFER'; reason: 'local_only_conflict' };
/** One conflict unit: s1 = A[p], s2 = LOCAL, s3 = TIP[p]. Never returns a marker-bearing blob. */
export function conflict(ctx: ConflictCtx, path: string, s1: Stage, s2: Stage, s3: Stage, unit: UnitKind): Promise<ConflictVerdict>;
export function concatMarkerSize(stages: readonly Buffer[]): number;   // max(32, 1 + longest run of <, |, =, > at a row start)

// src/data/attrs.ts (DAT-13)
export interface PathAttrs { filter: string | null; merge: string | null; text: 'set' | 'unset' | 'auto' | null; binary: boolean; eol: string | null; generated: boolean; coworkOff: boolean; }
export interface AttrSnapshot { readonly epochBase: Oid; get(path: string): PathAttrs; }
/** check-attr -z --stdin filter merge text binary eol linguist-generated cowork-sync under -c attr.tree=<epochBase>; cached per (epochBase, path);
 *  invalidated when the stat of $GIT_DIR/info/attributes or core.attributesFile changes. */
export class AttrCache {
  constructor(repo: GitRepo, fs: Fs);
  snapshot(epochBase: Oid, paths: Iterable<string>): Promise<AttrSnapshot>;
  invalidate(): void;
}

// src/data/filters.ts (Algorithm D3, DAT-15)
export interface FilterSet { drivers: string[]; fingerprint: Record<string, string>; overCap: number | null; }   // sorted; sha256 hex of clean\0smudge\0process\0required per driver (command-scope config ignored); bounds (ruling P2-DRIVERCAP): at most 64 drivers, each name <= 128 bytes, summed `-c filter.<d>.required=true` pairs <= 8 KiB; a discovered set exceeding any bound returns only names within the bounds and overCap = the full discovered count: the engine MUST fail closed (every path under a filter attribute is a filter_failure exclusion, nothing filtered publishes, reason surfaced); mode-120000 .gitattributes blobs are read (git reads them under attr.tree), 160000 entries skipped
export function discoverFilters(repo: GitRepo, fs: Fs, epochBase: Oid): Promise<FilterSet>;

// src/data/config.ts (glossary §17; rulings R-06, R-19)
export interface TeamConfig {
  sync: { include: string[]; exclude: string[]; allowSecretLike: string[]; maxNewFileBytes: number };
  merge: { insertionMerge: string[] };
  host: { pushBudgetPerMin: unknown };            // raw; genesisBudget() decides
}
export const DEFAULT_INSERTION_MERGE: readonly string[];   // CHANGELOG*, HISTORY*, NEWS*, *.md, *.txt
export const DEFAULT_TEAM_CONFIG: TeamConfig;              // maxNewFileBytes 1,048,576
/** .cowork/config.json at <epochBase>: absent → defaults; not a UTF-8 JSON object → defaults + invalid; a mistyped field is ignored. */
export function readTeamConfig(repo: GitRepo, epochBase: Oid): Promise<{ config: TeamConfig; invalid: boolean; reason: string | null }>;   // any invalid glob in include/exclude/insertionMerge → invalid, DEFAULT_TEAM_CONFIG (glossary §17 keep-last-valid), reason set; '' and '/' globs are ignored; allowSecretLike entries are exact canonPaths (not globs): entries failing validPathSyntax are dropped and noted in reason while invalid stays false — consumers MUST NOT read reason !== null as invalid
/** ENG-51: an integer in 6–24 → itself; anything else (absent, 30, "fast", 7.5) → 12. */
export function genesisBudget(cfg: TeamConfig): number;

// src/data/scope.ts (Algorithms D5–D7; DAT-23…DAT-34)
export type ScopeClass = 'LIVE' | 'SAVE_ONLY' | 'UNMANAGED' | 'QUARANTINED' | 'NOT_ADMITTED' | 'LOCAL_ONLY';
export type NotSharedReason = 'secret-like' | 'secret-scan' | 'temp' | 'too-large' | 'huge' | 'nested-repo' | 'submodule' | 'symlink'
  | 'lfs' | 'generated' | 'excluded-by-config' | 'not-included' | 'save-only' | 'merge-driver' | 'quarantine' | 'portability' | 'filter-failure' | 'ignored';
export interface Scope { cls: ScopeClass; reason: NotSharedReason | null; }
export interface ScopeInputs {
  attrs: AttrSnapshot;
  config: TeamConfig;
  mergeDrivers: ReadonlySet<string>;          // names with merge.<name>.driver configured
  localOnlyPaths: ReadonlySet<string>;        // non-terminal local_only records (empty in Plan 2)
  hooksPathDir: string | null;                // user core.hooksPath as a repo-relative dir (quarantine set)
}
export const HUGE_BYTES = 52_428_800;
export const NEW_FILE_CAP = 1_048_576;
export const QUARANTINE_PATTERNS: readonly string[];   // glossary §16
export const TEMP_PATTERNS: readonly string[];         // D6 step 2.2 (case-insensitive basenames)
export const SECRET_LIKE_PATTERNS: readonly string[];  // glossary §16 secret-like names (case-insensitive basenames)
/** D5 for a path in A or TIP; size = max(local lstat size, TIP blob size), taken before any staged copy. */
export function scopeOfTracked(path: string, mode: FileMode, size: number, inp: ScopeInputs): Scope;
/** D6 step 2 for one `ls-files -o` entry ('/'-terminated = directory); `others` = D7's set. LIVE when admitted. */
export function admitNew(entry: string, lstatSize: number, isSymlink: boolean, others: ReadonlySet<string>, inp: ScopeInputs): Scope;
export function isQuarantined(path: string, hooksPathDir: string | null): boolean;
export type PortRule = 1 | 2 | 3 | 4;
export function portable(path: string, others: ReadonlySet<string>): { ok: true } | { ok: false; rule: PortRule };   // D7
export function wildmatch(pattern: string, path: string, caseInsensitive?: boolean): boolean;   // gitignore-style, no negation
```

### Board

```ts
// src/board/ids.ts (glossary §2, §3)
export type PeerId = string;     // 32 lowercase hex
export type EpochId = string;    // 32 lowercase hex
export interface OpId { peer: PeerId; epoch: EpochId; seq: number; }
export function formatOpId(id: OpId): string;              // `${peer}/${epoch}/${seq}`
export function parseOpId(s: string): OpId | null;
export function newPeerId(r: Random): PeerId;               // randomHex(r, 16)
export function newEpoch(r: Random): EpochId;               // randomHex(r, 16)
export function base32c(bytes: Uint8Array): string;         // Crockford alphabet
export function H(x: string, y: string): string;            // base32c(sha256(utf8(x) ‖ 0x00 ‖ utf8(y)))[0:8] (PRO-11)

// src/board/canonicalJson.ts (RFC 8785)
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export function canonicalJson(v: Json): string;            // keys by UTF-16 code units, no whitespace, ES number form; non-finite → throws
export function canonicalBytes(v: Json): Buffer;           // UTF-8, no BOM
export const MAX_JSON_DEPTH = 64;   // P2-DEPTH: scalar = depth 0, each array/object +1; canonicalJson throws TypeError above it (never a stack overflow); an op line nested deeper is malformed (parseOpLine → null, measured iteratively after JSON.parse); a sparse array throws TypeError

// src/board/ops.ts (glossary §7, PRO-03, PRO-05)
export type OpType = 'join' | 'leave' | 'caps' | 'seat_start' | 'seat_end' | 'claim' | 'release' | 'request' | 'request_status' | 'answer' | 'note' | 'presume_absent' | 'hold' | 'event' | 'save';
export const PLAN2_FOLDED_TYPES: ReadonlySet<OpType>;      // join, leave, caps, seat_start, seat_end, event, save (R-12)
export interface ConfigFingerprint { filters: Record<string, string>; autocrlf: string; eol_attrs: string; git: string; }   // autocrlf: core.autocrlf or ''; eol_attrs: sha256 hex of the root .gitattributes blob oid at EPOCH_BASE or ''
export interface JoinOp { id: string; type: 'join'; display: string; plugin_version: string; plugin_sha: string; proto: number; regionSpec: string; config_fingerprint: ConfigFingerprint; coauthor_optin: false | string; }
export interface LeaveOp { id: string; type: 'leave'; }
export interface CapsOp { id: string; type: 'caps'; custom_refs: boolean; lease: boolean; delete: boolean; push_options: boolean; two_parent_ok: boolean; }
export type TeamCaps = Omit<CapsOp, 'id' | 'type'>;
export interface SeatStartOp { id: string; type: 'seat_start'; seat_id: string; permission_mode: string; }
export interface SeatEndOp { id: string; type: 'seat_end'; seat_id: string; permission_mode: string; }
export type EventKind = 'K1' | 'K2' | 'K3' | 'K4' | 'K5' | 'K6' | 'K7' | 'breach' | 'freeze' | 'unfreeze' | 'incident' | 'nonretryable' | 'health';
export interface EventOp { id: string; type: 'event'; cid: string; kind: EventKind; refs: string[]; reason_code: string; }
export interface SaveOp { id: string; type: 'save'; save_commit: string; saved_live: string; chain_base: string; released_claim_ids: string[]; }
export interface OpaqueOp { id: string; type: 'claim' | 'release' | 'request' | 'request_status' | 'answer' | 'note' | 'presume_absent' | 'hold'; [field: string]: Json; }
export type Op = JoinOp | LeaveOp | CapsOp | SeatStartOp | SeatEndOp | EventOp | SaveOp | OpaqueOp;
export type OpDraft = Op extends infer O ? (O extends { id: string } ? Omit<O, 'id'> : never) : never;   // event drafts carry cid '' (filled at seq allocation)
export const OPS_MAX_LINES = 1_000;
export const OPS_MAX_BYTES = 65_536;
export const OP_MAX_LINE_BYTES = 16_384;
export const REASON_CODE_RE: RegExp;                       // /^[A-Z][A-Z0-9_]{2,47}$/
export class BoardCapError extends Error {}
export function serializeOps(ops: readonly Op[]): Buffer;  // canonical JSON per line, LF, increasing seq; caps → BoardCapError
export function parseOpLine(line: string): Op | null;      // schema + SEC-35 validators; unknown fields ignored; null = malformed (fold no-op)
export function eventCid(opId: string, kind: EventKind): string;   // H(opId, kind) for the non-conflict kinds (PRO-11)

// src/board/protocol.ts (PRO-04, PRO-07; R-19)
export interface ProtocolJson { proto: number; regionSpec: string; budget: number; G_s: number; S_s: number; }
export const PROTO = 1;
/** G_s = ⌈60,000/budget⌉/1,000, S_s = ⌈18,000/budget⌉/1,000 (12 → 5, 1.5; 6 → 10, 3; 24 → 2.5, 0.75; 7 → 8.572, 2.572). */
export function genesisProtocol(budget: number, regionSpec: string): ProtocolJson;
export function serializeProtocol(p: ProtocolJson): Buffer;   // canonical JSON, byte-identical on every OS
/** A missing or malformed budget/G_s/S_s reads as 6/10/3; a missing proto reads as 0 (≠ 1 → VERSION). */
export function readProtocol(buf: Buffer | null): ProtocolJson;

// src/board/boardCommit.ts (glossary §3, §5; PRO-01…PRO-03, PRO-07; ENG-12, ENG-20)
export interface WriterId { peer: PeerId; epoch: EpochId; seq: number; }
export interface CsTrailer { csId: string; state: 'closed' | 'checkpoint'; seq: number; origin: 'prompt' | 'wake' | 'human'; checks: 'pass' | 'fail' | 'skipped'; paths: number; }
export const BOARD_SUBJECT = '[skip ci] ***NO_CI*** cowork board';
export const CODE_SUBJECT = '[skip ci] ***NO_CI*** cowork live';
export const STATE_SUBJECT = 'cowork-state';
export interface BoardCommitData {
  oid: Oid; parents: Oid[]; firstParent: Oid | null; liveCode: Oid;
  writer: WriterId | null;                 // null: missing or malformed Cowork-Writer (every op a no-op)
  cs: CsTrailer[];
  protocol: ProtocolJson;
  opsLines: string[];                      // ops.jsonl split on LF (<= 1,000 lines; the file itself <= 64 KiB, else BoardMalformedError); a non-UTF-8 line reads as '' (malformed)
  checkpoint: Buffer | null;               // checkpoint/state.json
  heldIds: string[];                       // held/<id>/ subtrees present
}
export type BoardDraft = Omit<BoardCommitData, 'oid' | 'parents' | 'firstParent'>;   // what a writer knows before the commit exists
export const BOARD_TREE_MAX_BYTES = 5_000_000;   // ops.jsonl + protocol.json + checkpoint/state.json; a held/ tree object is capped on its own
export const BOARD_COMMIT_OBJECT_MAX_BYTES = 1_048_576;   // the board commit object itself (message + trailers), size-checked before it is read
export type BoardMalformedReason = 'no_parent' | 'ops_too_large' | 'board_too_large' | 'commit_too_large' | 'not_commit';
export class BoardMalformedError extends Error { readonly reason: BoardMalformedReason; }
/** Type and sizes are checked (cat-file --batch-check) before any content is read; a missing oid throws a plain Error (a missing local object is not a teammate's malformed board); ops.jsonl > 64 KiB, the tree caps or the commit object cap → BoardMalformedError (never reads the oversized blob); any 2-part batch record (missing, ambiguous, submodule, or another word) reads as an absent entry; a non-UTF-8 ops line is an empty (malformed) line. Callers (Folder, the incident check) treat BoardMalformedError exactly like a failed board shape check (IncidentWhy 'board_shape'), never as a crash. buildBoardCommit refuses (BoardCapError) to build a commit readBoardCommit would refuse. */
export function readBoardCommit(repo: GitRepo, oid: Oid): Promise<BoardCommitData>;   // first call: one `cat-file --batch-check` of the unpeeled oid giving type and size; type !== commit → BoardMalformedError('not_commit') (a tag must never peel past the size cap); size > BOARD_COMMIT_OBJECT_MAX_BYTES → 'commit_too_large'; only then `cat-file commit`
export interface BoardBuild {
  prevBoard: Oid | null;                   // null only for B0
  liveCode: Oid;                           // C, or TIP for a board-only publish, or L0
  writer: WriterId;
  ops: readonly Op[];
  cs: readonly CsTrailer[];
  csPaths: ReadonlyMap<string, readonly string[]>;
  protocol: ProtocolJson | null;           // B0 only; later commits carry the previous protocol.json blob by oid
  checkpoint: Buffer | null;               // a new checkpoint/state.json, or null to carry the previous entry
}
/** Tree = the previous board tree with ops.jsonl replaced (+ checkpoint when given), protocol.json and held/ carried by oid (mktree, R-15); parents [prevBoard, liveCode] or [L0]. */
export function buildBoardCommit(repo: GitRepo, b: BoardBuild): Promise<Oid>;
export function liveCommitTrailers(writer: WriterId, seats: readonly string[], cs: readonly CsTrailer[], csPaths: ReadonlyMap<string, readonly string[]>, base: Oid | null): Trailer[];
export function boardTrailers(writer: WriterId, cs: readonly CsTrailer[], csPaths: ReadonlyMap<string, readonly string[]>): Trailer[];
export function formatWriter(w: WriterId): string;
export function parseWriter(s: string): WriterId | null;
export function encodeCsPaths(paths: readonly string[]): string;    // base64url(zlib(NUL-joined sorted paths)); callers only for ≤ 256 paths
export function decodeCsPaths(s: string): string[] | null;
export function parseCsTrailers(trailers: readonly Trailer[]): { cs: CsTrailer[]; paths: Map<string, string[]> };
export type LiveShape = 'genesis' | 'ordinary' | 'base_move';
export function boardShapeOk(c: CommitInfo, expectedPrev: Oid | null): boolean;
export function liveShape(c: CommitInfo, expectedPrev: Oid | null): LiveShape | null;

// src/board/fold.ts (02-protocol §3.3, §3.4; PRO-14…PRO-16, PRO-20, PRO-22, PRO-23, PRO-25…PRO-29, PRO-39, PRO-47, PRO-48; R-12, R-13)
export interface PeerRec {
  epoch: EpochId; status: 'active' | 'left' | 'absent'; retired_epochs: EpochId[];
  display: string; plugin_version: string; plugin_sha: string; regionSpec: string;
  config_fingerprint: Json; coauthor_optin: false | string; last_seq: number; last_height: number;
}
export interface FoldEvent { kind: EventKind; refs: string[]; reason_code: string; op_id: string; height: number; }
export interface FoldState {
  v: 1; height: number; proto: number; teamRegionSpec: string;
  caps: TeamCaps | null;
  peers: Record<PeerId, PeerRec>;
  seats: Record<string, { status: 'live' | 'ended'; permission_mode: string; ended_height?: number }>;
  claims: Record<string, Json>; requests: Record<string, Json>; holds: Record<string, Json>; notes: Record<string, Json>;   // empty in Plan 2
  events: Record<string, FoldEvent>;
  last_save: { save_commit: string; saved_live: string; chain_base: string; height: number } | null;
  record_count: number;
}
export interface OwnRejection { opId: string; type: OpType | 'unknown'; reason: 'generic' | 'type'; }
export interface FoldStepResult { state: FoldState; ownRejections: OwnRejection[]; landedOwnOpIds: string[]; protoMismatch: boolean; }
export const CHECKPOINT_EVERY = 256;
export const COMPACT_AGE = 512;
export const K_EVICT = 200;
export const REPLAY_MAX = 255;
export function initialFoldState(protocol: ProtocolJson): FoldState;   // the empty state B0 folds onto (height −1)
/** 02-protocol §3.3 7-step algorithm for one commit at height prev.height + 1 (0 for B0). Pure, total, never throws; compaction at h mod 256 == 0. */
export function foldCommit(prev: FoldState, c: BoardDraft, self: PeerId): FoldStepResult;
export function serializeFold(s: FoldState): Buffer;       // RFC 8785, integers only
export function parseFold(buf: Buffer): FoldState | null;
export function liveSet(s: FoldState): PeerId[];           // active epochs, sorted
export function rankedSet(s: FoldState): PeerId[];         // live set minus ghosts (no board commit in the last K_EVICT heights)
/** PRO-39: 1 + |{p ∈ R : (last_height(p), p) < (last_height(self), self)}| (−1 when none); 1 when self ∉ R. */
export function governorRank(s: FoldState, self: PeerId): number;
/** PRO-55 restart rule: a HOST_THROTTLED health event within the last `heights` first-parent heights. */
export function recentThrottleEvent(s: FoldState, heights: number): boolean;
export interface VersionVerdict { proto: boolean; regionSpec: boolean; checkpointMismatch: boolean; }
export interface FoldOutcome {
  board: Oid; state: FoldState;
  newCommits: BoardCommitData[];            // folded by this call, oldest first
  ownRejections: OwnRejection[]; landedOwnOpIds: string[];
  version: VersionVerdict;
  throttleEventsFolded: number;             // HOST_THROTTLED health events among newCommits
}
/** Incremental fold along the first-parent chain. from null (join, lost state, refold): start at the newest checkpoint ≤ tip (≤ 255 replayed), trusted (glossary §24 default 9). Every checkpoint height folded is compared byte for byte (PRO-28): mismatch → one refold from the previous verified checkpoint, then checkpointMismatch. */
/** Controller ruling P2-REFOLD: a refold starts only from a checkpoint THIS instance verified by a byte match on the current chain, lying below the checked height AND at or below the height this call started folding from (so the refold recomputes every report of the call); the verified state is kept as a private copy (a trusted joiner start, glossary §24 default 9, is not verified), else from genesis; a refold that started from an unverified base never clears checkpointMismatch. Ruling P2-FOLDPERSIST: the verification survives restarts through meta.fold_verified and meta.checkpoint_mismatch (Task 8), restored at construction. A persisted `from` whose board is unknown or off the tip's first-parent chain is discarded (PRO-25), never a throw. BoardMalformedError from readBoardCommit propagates typed. */
export interface FoldVerification { verified: { board: Oid; height: number } | null; checkpointMismatch: boolean; }
export class Folder {
  constructor(repo: GitRepo, self: PeerId, restored?: FoldVerification | null);
  foldTo(tip: Oid, from: { board: Oid; state: FoldState } | null, ownRegionSpec: string): Promise<FoldOutcome>;
  verification(): FoldVerification;                 // persisted by the caller with each fold-state update
}

// src/board/outbox.ts (PRO-08, PRO-09, PRO-45)
export type PushState = 'ok' | 'frozen' | 'incident' | 'config_net' | 'offline' | 'nonretryable' | 'version_proto' | 'version_board_only';
export interface SeqAllocator { next(): number; }          // backed by meta.seq_next; persisted before the push (PRO-08)
export interface PendingOp { draft: OpDraft; op: Op | null; }   // op set once a seq is allocated (ids kept across rebuilds)
export class Outbox {
  constructor(entries?: readonly PendingOp[]);
  add(draft: OpDraft): void;
  /** Allowed ops (PRO-45) in seq order within the caps; allocates seqs on first placement (event drafts get cid = eventCid(id, kind)). */
  take(states: readonly PushState[], self: { peer: PeerId; epoch: EpochId }, alloc: SeqAllocator, room: { maxOps: number; maxBytes: number }): Op[];   // P2-PUSHSTATES: an op is allowed only if allowed in EVERY active state (e.g. FREEZE + VERSION regionSpec); [] means 'ok'
  /** After an own intent with writer seq w landed: drop its ops; renumber every op with seq < w that was not in it (order kept; cids recomputed). */
  landed(intentOpIds: ReadonlySet<string>, writerSeq: number, alloc: SeqAllocator, self: { peer: PeerId; epoch: EpochId }): void;
  renumberAtOrBelow(lastSeq: number, alloc: SeqAllocator, self: { peer: PeerId; epoch: EpochId }): void;
  drop(pred: (d: OpDraft) => boolean): number;
  pendingAllowed(states: readonly PushState[]): boolean;
  readonly size: number;
  toJson(): Json;
  static fromJson(j: Json): Outbox;
}
export function allowedInState(d: OpDraft, state: PushState): boolean;   // the 02-protocol §3.8 table; the most restrictive row wins
export function allowedInAll(d: OpDraft, states: readonly PushState[]): boolean;   // intersection (P2-PUSHSTATES)

// src/board/governor.ts (PRO-39…PRO-46, PRO-54 counter input, PRO-55; glossary §27.2; R-17, R-18, R-20, R-21)
export interface GovernorParams { budget: number; G_s: number; S_s: number; }   // readProtocol of the board tip
export type GovernorMode = 'normal' | 'fallback';
export type ThrottleSignal = 'http_429' | 'http_5xx' | 'slow_push' | 'rejection_streak';
export const NORMAL_LOCAL: Readonly<{ B: number; G_ms: number; S_ms: number }>;     // 24, 2_500, 750
export const FALLBACK_LOCAL: Readonly<{ B: number; G_ms: number; S_ms: number }>;   // 6, 10_000, 3_000
export const FALLBACK_MS = 1_800_000;
export const EVENT_SPACING_MS = 900_000;
export const G_CAP_MS = 60_000;
export const WINDOW_MS = 60_000;
export const SLOW_PUSH_MS = 10_000;
export const RESTART_EVENT_HEIGHTS = 180;
export const NET_BACKOFF_MIN_MS = 30_000;
export const NET_BACKOFF_MAX_MS = 300_000;
export interface AttemptEnd { durationMs: number; killed: boolean; hadRefStatus: boolean; transient: boolean; landed: boolean; }
export class Governor {
  constructor(clock: Clock, params: GovernorParams);
  setParams(params: GovernorParams): void;
  /** A fetch completed with board tip T: anchor := now when T changed; `revealed` new first-parent commits are observed landings unless firstOfRun; a tip change by another writer while `pending` counts one pre-emption. */
  onFetch(tip: Oid | null, revealed: number, firstOfRun: boolean, pending: boolean): void;   // `revealed` = every new first-parent board commit since the tip this governor last observed (an own Bnew included); `pending` = pending ∧ allowed in every active push state (P2-PUSHSTATES); called after EVERY completed fetch, the classify fetch included
  onOwnOk(bnew: Oid): void;                      // anchor := now and one observed landing ONLY when no fetch since the attempt started observed the board past its lease (a fetch that revealed Bnew or a newer tip already counted it; the tip never moves back); callers: Task 14 ok path, Task 15 restart push-intent resolution
  onAttemptStart(): void;
  onAttemptEnd(e: AttemptEnd): void;             // PRO-44 throttle level k; a transient, or a status-less failure (hadRefStatus false, not landed: transport failure or watchdog kill), arms the ENG-44/ENG-19 backoff (30 s doubling to 5 min, R-20; ruling P2-NETBACKOFF); clears in-flight before validating its input (never wedges the governor)
  /** last_signal := now; postEvent when the signal came from a push, or from a fetch with other pending work, and no HOST_THROTTLED event was folded or queued by this peer within 15 min. */
  onSignal(s: ThrottleSignal, fromPush: boolean, otherPending: boolean): { postEvent: boolean };
  onThrottleEventFolded(own: boolean): void;      // ruling P2-R18: ANY folded HOST_THROTTLED event (own or a teammate's) counts toward the 15-min spacing; a follower never posts
  onEventQueued(): void;
  mode(): GovernorMode;
  effective(): { B: number; Gbase_ms: number; S_ms: number; G_ms: number; k: number };
  /** PRO-40 (rank, aging, per-peer cap, sliding guard, G_eff spacing, transient backoff). exempt skips the window and the spacing but never the cap or the guard. */
  mayAttempt(rank: number, pending: boolean, stateAllows: boolean, exempt?: boolean): boolean;
  msUntilWindow(rank: number): number;           // Δmono until mayAttempt could be true; Infinity when nothing is pending
  fallbackLeftMs(): number;
  fallbackSource(): ThrottleSignal | 'team' | null;
  attemptsInWindow(): number;
  toMeta(): { signal: ThrottleSignal } | null;   // meta.throttle (ENG-05)
  restore(m: { signal: ThrottleSignal } | null): void;   // daemon start: the own fallback restarts for 30 min (R-17)
}
```

### Holds (Plan 2 subset; Plan 3 extends these files)

```ts
// src/holds/record.ts (glossary §9 verbatim; R-03)
export type HoldKind = 'PATCH' | 'PIN' | 'INCOMING';
export type Residence = 'ON_DISK' | 'OFF_DISK';
export type HoldState = 'ACTIVE' | 'CONFLICTED' | 'PARKED' | 'SUBSUMED' | 'GONE' | 'RESOLVED_PUBLISH' | 'RESOLVED_DISCARD';
export type Offer = 'none' | 'pending_leftover' | 'offered' | 'accepted' | 'returned';
export type BlobMap = Record<string, OidOrAbsent>;
export type HoldBlobs = { h0: BlobMap; h1: BlobMap } | { s1: BlobMap; s2: BlobMap; s3: BlobMap };
export interface Guard { name: string; class: 'PREDICATE' | 'DECISION'; owner: string; }
export interface AgeAnchor { since_rev: number; anchor_wall_ms: number; mono_accum_ms: number; }   // 05-holds §2
export interface HoldRecord {
  id: string; rev: number; owner: PeerId;
  kind: HoldKind; residence: Residence | null; state: HoldState; offer: Offer;
  declines: number; displaced_by: string | null;
  paths: string[];                          // repo-relative POSIX NFC, sorted
  blobs: HoldBlobs; guards: Guard[];
  origin: string;                           // 'human' | 'daemon' in Plan 2
  cs_ids: string[]; peer_authors: string[]; local_only: boolean;
  age_anchor: AgeAnchor; proto: 1;
}
export type Plan2Guard = 'conflict' | 'restart' | 'phantom' | 'host-reject' | 'eol-bom' | 'join';
export const PLAN2_GUARD_CLASS: Readonly<Record<Plan2Guard, 'PREDICATE' | 'DECISION'>>;   // eol-bom PREDICATE, the rest DECISION (05-holds Table 3)
export const WHOLE_PATH_GUARDS: ReadonlySet<string>;    // eol-bom, generated?, portability, markers
export const TERMINAL_STATES: ReadonlySet<HoldState>;   // SUBSUMED, GONE, RESOLVED_PUBLISH, RESOLVED_DISCARD
export function isTerminal(r: HoldRecord): boolean;
export function heldSide(r: HoldRecord): BlobMap;       // h1, or s2 for a stage record
export function serializeRecord(r: HoldRecord): Buffer; // canonical JSON
export function parseRecord(buf: Buffer): HoldRecord;

// src/holds/registry.ts (HLD-01…HLD-05; R-02, R-03)
export interface NewRecord {
  kind: 'PATCH' | 'PIN'; residence: Residence; state: 'ACTIVE' | 'CONFLICTED' | 'PARKED';
  paths: string[]; blobs: HoldBlobs;
  guard: Plan2Guard | null;                 // null only for the ring late-write PATCH (OFF_DISK PARKED, ruling R-03 (iii))
  origin: string; cs_ids: string[]; displaced_by: string | null; local_only: boolean;
}
// Plan 2 record shapes: conflict = PATCH CONFLICTED (ON_DISK on the publish side until the apply writes TIP, then OFF_DISK; R-02);
// restart = PATCH ACTIVE ON_DISK; phantom, host-reject, join = PIN ACTIVE ON_DISK (host-reject: origin 'daemon'; a board-only NONRETRYABLE still creates one with paths [] and cs_ids [], so meta.nonretryable.hold_id always names a record); eol-bom = PATCH ACTIVE ON_DISK (whole path).
export interface RegistryDeps { repo: GitRepo; ref: string; random: Random; clock: Clock; peer: PeerId; trace: Trace; log: Log; }
export class RegistryCasLostError extends Error {}       // a second writer: security log + exit (as ENG-03)
export class HoldRegistry {
  constructor(d: RegistryDeps);
  load(): Promise<void>;                                  // re-attach (HLD-01); an absent ref is an empty registry
  all(): readonly HoldRecord[];
  nonTerminal(): readonly HoldRecord[];
  get(id: string): HoldRecord | undefined;
  /** HLD-05 hold(). Dedupe: an h0/h1 record dedupes on kind + guard + paths + h1; a stage record (s1/s2/s3) dedupes on kind + guard + paths + s2 ONLY —
   *  its s1/s3 are then updated to the newer call's stages by transition() (between a publish-side TAKE_TIP and the next apply, s3 can differ while
   *  s2 = LOCAL is the same; R-02). A dedupe returns the existing id; otherwise one registry commit
   *  (tree records/<id>.json + blobs/<oid>, mktree) with a new ULID record at rev 1; crashpoint('registry.cas') immediately before and after the CAS. */
  hold(r: NewRecord): Promise<string>;
  transition(id: string, patch: Partial<Pick<HoldRecord, 'residence' | 'state' | 'blobs' | 'guards'>>): Promise<HoldRecord>;   // a new rev, one commit
  /** Non-terminal records that MASK reads (ON_DISK with guards, CONFLICTED). */
  maskingRecords(): readonly HoldRecord[];
}

// src/holds/mask.ts (05-holds §3.4 item 2; R-04)
export interface MaskInputs { A: TreeMap; scope: (path: string) => ScopeClass; records: readonly HoldRecord[]; }
export type MaskReason = 'path_class' | 'local_only' | 'whole_path_guard' | 'pin' | 'conflicted' | 'patch' | null;
/** MASK(X): masked paths take A's entry (absent when A has none); steps 1–4 exactly, step 5 whole-path. Pure. */
export function maskEntries(X: TreeMap, inp: MaskInputs): Map<string, TreeEntry>;
export function maskReason(path: string, inp: MaskInputs): MaskReason;

// src/holds/groups.ts (HLD-53; 01-engine §3.11 defer table)
export type DeferReason = 'fence' | 'read_lease' | 'txn' | 'unreadable' | 'unstable' | 'conflicted_leased' | 'eol_form' | 'local_only_conflict'   // + 'quarantine' (Task 13 round 1, P2-QUARANTINE-IN; parseMeta accepts it)
  | 'disk_low' | 'locked' | 'mismatch' | 'race' | 'closure' | 'filter_failure' | 'collision' | 'unmaterializable';
export interface IncomingCs { commit: Oid; csId: string; paths: string[]; }   // Cowork-CS(-Paths) of LA_C..TIP; a commit without them is one CS of paths(diff(parent, commit))
export interface WriteGroupsResult { groups: string[][]; deferred: Array<{ paths: string[]; reason: DeferReason }>; }
/** Connected components of the incoming CSs over the applicable paths of W ∪ D to a fixed point; a group with a deferred path is deferred whole
 *  (its own reason for that path, 'closure' for the rest); a path of W in no incoming CS is a singleton group. Pure. */
export function writeGroups(incoming: readonly IncomingCs[], applicable: ReadonlySet<string>, deferred: ReadonlyMap<string, DeferReason>): WriteGroupsResult;

// src/holds/changesets.ts (HLD-33, HLD-35, HLD-37, HLD-38, HLD-40…HLD-42; R-01)
export const HUMAN_CS_QUIET_MS = 20_000;
export interface ReadyPair { csId: string; R: Oid; A: Oid; paths: string[]; order: number; }   // order: capture sequence (newest wins)
// The journal holds only ready/<k>/{R,A} (glossary §4): StateStore.read derives csId from the key, paths from the union of R's and A's
// entries, and order from n of `<peer>/human/<n>` (R-01), so "newest capture wins" survives a restart.
export interface RebaseChange {
  path: string;
  aOld: TreeEntry | null; aNew: TreeEntry | null;            // A[p] before / after the state update
  written: 'clean' | 'concat' | 'take_tip' | 'none';         // what the update did to p ('none' = A changed without a write)
  sDiskBefore: TreeEntry | null;                              // S_disk[p] before the apply
  writtenEntry: TreeEntry | null;                             // the verified-written M_disk[p] (clean or concat)
}
export interface RebaseResult { ready: ReadyPair[]; cancelled: string[]; recapture: ReadonlySet<string>; }   // cancelled → CS_READY_CANCELLED
export class ReadyBaseMismatchError extends Error { readonly path: string; }
export function readyKey(csId: string): string;               // base64url(utf8(cs_id)), no padding
export class ChangeSets {
  constructor(peer: PeerId, clock: Clock);
  restore(ready: readonly ReadyPair[], nextN: number): void; // journal + meta.cs_human_next; the open CS re-forms through observe()
  observe(changed: Iterable<string>): void;                  // HLD-35: open or extend the human CS; restart its 20 s quiet timer
  done(): void;                                              // /cowork done: close at the next iteration
  closeDue(): boolean;                                       // 20 s Δmono quiet, done(), or a pending recapture
  /** HLD-40 at the close (the iteration materialized): R[p] = S_disk[p], A_cap[p] = A[p] over the CS paths (+ pending recaptures), sparse trees by writeTreeMap. */
  capture(repo: GitRepo, sDisk: TreeMap, A: TreeMap, scratchIndex: string): Promise<{ pair: ReadyPair; nextN: number } | null>;
  /** HLD-41 R[p] := merge-file(A_new, A_cap, R), A_cap := A_new, with the four-case conflict split. */
  rebase(repo: GitRepo, changes: readonly RebaseChange[], scratchIndex: string): Promise<RebaseResult>;
  /** P (HLD-42): MASK(R) of the newest ready pair covering p, A[p] elsewhere; A_cap[p] ≠ A[p] → ReadyBaseMismatchError (ENG-39).
   *  01-engine §3.12 step 1 (controller ruling P2-PIN): a ready pair whose CS shares any path with a non-terminal ON_DISK PIN
   *  (`pinnedPaths`, from HoldRegistry: guards `join`, `phantom`, `host-reject`) is skipped whole and stays journaled. */
  composeP(repo: GitRepo, A: TreeMap, mask: (X: TreeMap) => Map<string, TreeEntry>, pinnedPaths: ReadonlySet<string>): Promise<{ P: Map<string, TreeEntry>; csIds: string[]; csPaths: Map<string, string[]> }>;
  published(csIds: readonly string[]): void;
  ready(): readonly ReadyPair[];
  counts(): { open: number; ready: number };
  openPaths(): ReadonlySet<string>;
}
```

### Engine

```ts
// src/engine/deps.ts
export type MutantId = 'M05' | 'M06' | 'M07' | 'M12' | 'M17' | 'M18' | 'M20';   // ruling R-29; one site each
export interface AttributionPort { removalAttributed(path: string): boolean; shrinkAttributed(path: string): boolean; }
export const humanOnlyAttribution: AttributionPort;         // removal false, shrink true (ruling R-25)
export function regionSpecId(parts: readonly string[]): string;   // sha256 hex over the sorted parts joined by '\n'
export const PLAN2_REGION_SPEC: string;                      // regionSpecId(['FoldMapper/1', 'extent-convention/1', 'label-convention/1'])
export interface EngineDeps {
  ports: Ports;                    // git = createGitRunner with hooksPath <coworkDir>/empty-hooks, DAEMON_ENV, sshCommand, testBuild
  trace: Trace; log: Log; lease: LeasePort; attribution: AttributionPort;
  heartbeatMs: () => number;       // R-35
  paths: RepoPaths;
  branch: string; namespace: RefNamespace;
  url: string;                     // pinned URL, never a remote name
  display: string;                 // validName-checked
  pluginVersion: string; pluginSha: string; regionSpec: string;
  platform: NodeJS.Platform;
  testBuild: boolean; testMutants: ReadonlySet<MutantId>;
}

// src/engine/refs.ts (glossary §4; ENG-02)
export interface RefNamespace { readonly remotePrefix: string; }    // 'refs/cowork/' or (test builds) 'refs/cowork-ci/<run_id>/'
export const RELEASE_NAMESPACE: RefNamespace;
export function testNamespace(runId: string): RefNamespace;        // runId /^[0-9A-Za-z_-]{1,40}$/
export interface RefNames {
  readonly branch: string; readonly e: string;
  readonly remoteBoard: string; readonly remoteCode: string; readonly remoteBranch: string;   // <prefix><e>/board, <prefix><e>/code, refs/heads/<b>
  readonly localBoard: string; readonly localCode: string; readonly localBranch: string;     // refs/cowork-remote/<e>/{board,code,branch}
  readonly state: string; readonly holds: string;                                            // refs/cowork-local/<e>/{state,holds}
  readonly displacedPrefix: string;                                                          // <prefix><e>/displaced/
  displaced(o: Oid): string;
  incident(n: number): string; incidentOwn(n: number): string;
  probe(peer: PeerId): string;                                                               // <prefix>probe-<peer>
  readonly fetchSpecs: readonly FetchSpec[];                                                 // the three glossary §4 refspecs
}
export function refNames(branch: string, ns: RefNamespace): RefNames;   // EncTooLongError beyond 150 bytes

// src/engine/meta.ts (01-engine §3.2 + flagged Plan 2 fields, R-14)
export type FreezeReason = 'EPOCH' | 'MASS' | 'PAUSED' | 'INCIDENT' | 'CONFIG' | 'NOHOOKS';
export type ConfigDetail = 'url' | 'identity' | 'filter' | 'public';
export interface Meta {
  v: 1; proto: 1;
  peer_id: PeerId; epoch: EpochId; seq_next: number;
  branch: string; enc: string;
  pinned: { url: string; identity: string[] };
  H_adopt: Oid; EPOCH_BASE: Oid;
  expected_epoch: { symref: string; head: Oid; stash: Oid | null };
  freeze_reasons: FreezeReason[]; config_detail: ConfigDetail[];
  incident: null | { n: number; observed_board: Oid | null; observed_code: Oid | null };
  nonretryable: null | { lease: Oid; hold_id: string };
  rejections: null | { lease: Oid; n: number };
  throttle: null | { signal: ThrottleSignal };
  pending: Record<string, DeferReason>;
  displaced: string[];                 // oid12 list (cap 3)
  // Plan 2 additions — flagged for 01-engine §3.2:
  fold_board: Oid | null;
  fold_verified: { board: Oid; height: number } | null;   // P2-FOLDPERSIST (Folder.verification())
  checkpoint_mismatch: boolean;                          // P2-FOLDPERSIST; R-13 pause survives restarts
  outbox: Json;
  cs_human_next: number;
  incident_next: number;
}
export class MetaTooNewError extends Error {}           // meta.v > 1: branch 'refused' (LIF-37)
export function parseMeta(buf: Buffer): Meta;
export function serializeMeta(m: Meta): Buffer;         // canonical JSON, no timestamps (ENG-05)

// src/engine/state.ts (ENG-03, ENG-04, INV-ENG-REACH, INV-ENG-STATE)
export type ApplyIntentEntry = { path: string; kind: 'create' | 'modify' | 'delete'; slot: number };
export type Intent =
  | { kind: 'none' }
  | { kind: 'apply'; tip: Oid; board: Oid; groups: Array<{ n: number; entries: ApplyIntentEntry[] }> }            // journal t/M, t/S, t/TIP
  | { kind: 'local'; origin: string; entries: Array<{ path: string; expected: OidOrAbsent; target: Oid | 'DELETE'; slot: number }> }   // INV-ENG-REACH (ruling P2-INTENTREACH): every blob an intent names is also kept reachable by the same state commit — writeLocal journals them under journal/keep/local-intent (a tree of the target/expected blobs)
  | { kind: 'push'; bnew: Oid; c: Oid | null; lease_board: OidOrAbsent; lease_code: OidOrAbsent; cs_ids: string[]; writer_seq: number; op_ids: string[] };   // journal t/P
export type JournalTree = 'M' | 'S' | 'TIP' | 'P';
export interface StateView {
  commit: Oid; laC: Oid; laB: Oid;
  base: Oid; snap: Oid;                         // A and S_disk at the last transition (trees)
  meta: Meta; intent: Intent;
  t: ReadonlyMap<JournalTree, Oid>;
  ready: readonly ReadyPair[];                  // journal/ready/<readyKey>/{R,A}
  keep: ReadonlyMap<string, Oid>;               // journal/keep/<name>; keep/fold/state.json = the fold state
  fold: FoldState | null;
}
export interface Transition {
  laC?: Oid; laB?: Oid; base?: Oid; snap?: Oid; meta?: Meta; intent?: Intent;
  t?: ReadonlyMap<JournalTree, Oid>;            // replaces t/ (an empty map clears it)
  ready?: readonly ReadyPair[]; keep?: ReadonlyMap<string, Oid>; fold?: FoldState;
}
export class StateCasLostError extends Error {}   // second writer: log 'security', exit (ENG-03)
export class LostStateError extends Error { readonly stateOid: Oid | null; }   // ref or a named object missing/unparsable (ENG-54); stateOid = the unusable commit the ref names (null if the ref value itself is unreadable)
export class StateStore {
  constructor(d: { repo: GitRepo; refs: RefNames; trace: Trace; peer: () => PeerId });
  read(): Promise<StateView | null>;                                       // null = no ref; LostStateError; MetaTooNewError — LIF-37: a root 'meta' blob with v > own is found leniently and refused FIRST, before the subject, parent and layout checks (ruling P2-METAFIRST)
  create(init: { laC: Oid; laB: Oid; base: Oid; snap: Oid; meta: Meta; ready?: readonly ReadyPair[]; fold?: FoldState }): Promise<StateView>;
  /** ENG-54 lost-state rebuild over an existing but unusable state ref: one CAS from `unusable` (LostStateError.stateOid) to the new commit (ruling P2-REBUILD); never used for a MetaTooNewError state. */
  rebuild(unusable: Oid, init: { laC: Oid; laB: Oid; base: Oid; snap: Oid; meta: Meta; ready?: readonly ReadyPair[]; fold?: FoldState }): Promise<StateView>;
  /** Commit [laC, laB], tree {base, snap, meta, journal/{intent.json, t/, ready/<k>/{R,A}, keep/}} built bottom-up with one mktree per directory level
   *  (journal/ready/<k>, journal/ready, journal/t, journal/keep/fold, journal/keep, journal, root; existing trees and blobs referenced by oid; never
   *  read-tree --prefix; R-15), subject 'cowork-state', one CAS update-ref --create-reflog; trace 'state'. */
  commit(prev: StateView, t: Transition): Promise<StateView>;
}

// src/engine/stagedRead.ts (01-engine §2 staged read; glossary §26.1 W1–W3)
export type ReadOutcome =
  | { kind: 'ok'; bytes: Buffer; stat: FsLstat }
  | { kind: 'missing' }
  | { kind: 'unstable' }
  | { kind: 'unreadable'; code: string };
export function stagedRead(fs: Fs, abs: string): Promise<ReadOutcome>;   // lstat → readFile → lstat; one re-read on change; never git
export class StageDir {
  constructor(fs: Fs, root: string);             // <coworkDir>/tmp/stage (0o700)
  write(path: string, bytes: Buffer): Promise<string>;   // validPathSyntax; never follows a symlink component; returns the absolute copy path
  abs(path: string): string;
  remove(path: string): Promise<void>;
  clear(): Promise<void>;
  readonly root: string;
}

// src/engine/statCache.ts (01-engine §2 stat cache)
export interface StatEntry {
  stat: FsLstat | null;                          // null: missing at the last look
  id: Oid | null;                                // detection id (null for a removal)
  state: 'clean' | 'dirty';
  missingSinceMono?: number;                     // deletion confirmation
  shrink?: { stat: FsLstat; firstMono: number; ticks: number };   // shrink guard
}
export class StatCache {
  get(path: string): StatEntry | undefined;
  set(path: string, e: StatEntry): void;
  delete(path: string): void;
  clear(): void;
  entries(): IterableIterator<[string, StatEntry]>;
  readonly size: number;
}

// src/engine/snapshot.ts (01-engine §3.8; ENG-23…ENG-27; R-25)
export const QUIET_MS = 300;
export const DELETE_CONFIRM_MS = 1_000;
export const SHRINK_RATIO = 0.5;
export type Exclusion = 'unreadable' | 'unstable' | 'filter_failure' | 'shrink' | 'deletion_pending' | 'quiet';
export interface DirtyEntry { kind: 'modify' | 'new' | 'remove'; mode: FileMode; id: Oid | null; }
export interface SnapshotDeps {
  repo: GitRepo; fs: Fs; clock: Clock; trace: Trace; peer: PeerId;
  privateIndex: string;                          // <coworkDir>/<e>.index
  scratch: { detect: string; canon: string };    // absolute scratch indexes under tmp/
  stage: StageDir; statCache: StatCache; attribution: AttributionPort;
  filters: FilterSet;                            // ruling P2-SNAPFILTERS: required (discovered once at start; R-08 never changes EPOCH_BASE); overCap or an unknown driver → filter_failure exclusion (fail closed)
}
export interface TickInput { A: TreeMap; aTree: Oid; epochBase: Oid; scope: ScopeInputs; skip: ReadonlySet<string>; }   // skip: Plan 5 fences (empty in Plan 2); aTree = A's tree oid (required, P2-ATREE: U+FFFD paths match A byte for byte)
// Ruling P2-CARRY: a tracked path is carried through (never read, hashed or staged as a removal; S_raw keeps A's entry; listed in not_converged) when it fails validPathSyntax, decodes with U+FFFD, is not creatable on this OS (D7 portable() receive side), or collides case-insensitively with another tracked path on a case-insensitive file system (DAT-29). Ruling P2-EXECBIT: on a file system with core.fileMode true, a regular file whose lstat has the owner-exec bit is staged as 100755 (new and tracked paths); a mode-only change is a change.
export interface TickResult {
  dirty: ReadonlyMap<string, DirtyEntry>;        // differs from S_raw, cumulative since the last materialization
  changed: ReadonlySet<string>;                  // dirty-set changes at this tick (ChangeSets.observe)
  excluded: ReadonlyMap<string, Exclusion>;      // per-loop exclusions: S_pub[p] := A[p], apply defers p
  notAdmitted: ReadonlyMap<string, NotSharedReason>;
  failed: boolean;                               // refresh rc ∉ {0,1} or diff-files failure: no capture/apply/publish this loop
  publishBlocked: boolean;                       // a filter failure this loop (ENG-24)
  carried: ReadonlySet<string>;                  // P2-CARRY paths this tick (listed in not_converged by the engine; never written, read or published)
}
export interface Materialized { sRaw: Oid; sDisk: Oid; sRawMap: TreeMap; sDiskMap: TreeMap; canonRefused: ReadonlySet<string>;
  excluded: ReadonlyMap<string, Exclusion>;      // materialize-time per-path exclusions (e.g. a route (b) -w rc 128): the path keeps its S_raw entry and stays dirty
  publishBlocked: boolean;                       // a filtered path failed at materialize (ENG-24): nothing publishes this loop
}
export class Snapshotter {
  constructor(d: SnapshotDeps);
  /** Steps 1–6: a detection tick; writes no object (route (a) does not run; routes (b)/(c) without -w). */
  tick(inp: TickInput): Promise<TickResult>;
  /** Steps 7–9: route (a) add --ignore-errors --pathspec-from-file=- --pathspec-file-nul of dirty unfiltered copies (--work-tree=<tmp/stage>, literal pathspecs), route (b) -w + --cacheinfo for filtered ones, removals, 160000/120000 forced to A, crashpoint('snapshot.index_written'), write-tree → S_raw, canon in tmp/canon.index → S_disk. `only` = a record's paths (occasion (c)). */
  materialize(inp: TickInput, only?: ReadonlySet<string>): Promise<Materialized>;
  last(): Materialized | null;
  reseed(tree: Oid): Promise<void>;              // read-tree into the private index; stat cache and stage dir emptied
  markClean(path: string, stat: FsLstat, id: Oid): void;   // after a verified write (round trip)
}

// src/engine/diskEq.ts (01-engine §3.3; ENG-11)
export type DiskEqResult = { equal: true } | { equal: false; reason: 'differs' | 'unstable' | 'unreadable' | 'error' };
export interface DiskEqDeps { repo: GitRepo; fs: Fs; stage: StageDir; statCache: StatCache; cmpIndex: string; addIndex: string; isFiltered: (p: string) => boolean; isText: (p: string) => boolean; mutants: ReadonlySet<MutantId>; }
// DiskEqDeps gains `filters: FilterSet` (ruling P2-SNAPFILTERS applies to manyCandidates' route (b) -w: an over-cap or unknown driver is never hashed with -w) and every DiskEq entry point refuses (result 'carried', no lstat/read) a path in the current carry set or with a dotgit-alias component (P2-DOTGIT).
// Ratified (Task 9 round 2): DiskEqDeps.isCarried(p) (required) and Snapshotter.isCarried(p); DiskEqResult.reason gains 'carried' and 'filter_failure' (callers defer on both); manyCandidates().read is the exported type ManyRead; StageDir refuses dotgit aliases and U+FFFD names; isCarried knows case collisions only after the first tick following a start/reseed (Task 15 ticks before its many-candidate decisions).
export class DiskEq {
  constructor(d: DiskEqDeps);
  /** ABSENT ⇔ ENOENT; clean stat-cache fast path when x equals sRaw; else one staged read + cmp.index cacheinfo, --work-tree=<tmp/stage> update-index --refresh, diff-files -z (unfiltered) or a route (b) id (filtered). No object. Mutant M18: hash-object --path of the copy compared with x for every path. */
  eq(path: string, x: TreeEntry | Absent, sRaw: TreeEntry | null): Promise<DiskEqResult>;
  eqFile(path: string, file: string, x: TreeEntry | Absent): Promise<DiskEqResult>;   // variant (3): a ring .old
  /** MANY CANDIDATES: one staged read, raw blob r written (route (a) into addIndex, or route (b) -w); first c with canon(r, c) == c (unfiltered) or r == c (filtered); ABSENT matches ENOENT. */
  manyCandidates(path: string, candidates: readonly (TreeEntry | Absent)[], file?: string): Promise<{ match: TreeEntry | Absent | null; raw: Oid | null; read: ReadOutcome['kind'] }>;
}

// src/engine/writer.ts (01-engine §3.11 writer protocol, ROLLBACK, ring, round trip; ENG-31…ENG-35, ENG-37, ENG-38)
export const RING_KEEP_MS = 2_000;
export const MAX_REMERGE = 3;
export const PATH_BUSY_WAIT_MS = 250;
export type WriteKind = 'create' | 'modify' | 'delete';
export interface WriteEntry { path: string; kind: WriteKind; slot: number; target: TreeEntry | null; sRaw: TreeEntry | null; sDisk: TreeEntry | null; }
export interface WriteGroup { n: number; entries: WriteEntry[]; }
export type Remerge = (entry: WriteEntry, found: TreeEntry) => Promise<TreeEntry | null>;   // merge-file(base S_disk[p], ours found, theirs target); null = conflict
export interface GroupResult { n: number; outcome: 'written' | 'deferred'; reason: DeferReason | null; written: TreeEntry[]; deleted: string[]; phantoms: string[];
  stranded: boolean; }   // P2-STRANDED: a rollback restore could not complete — the caller keeps ONLY the stranded groups of the intent (Writer.narrowToStranded(intent, results)), never the whole multi-group intent, until Writer.strandedPaths() is empty after a sweepRing; while strandedPaths() is non-empty no new intent is journaled (no apply, no push); `written` may list unverified RT-error paths (not marked clean)
// Writer also exports: strandedPaths(): string[] (read after every sweepRing and after every writeLocal returning LOCKED/DEFERRED); narrowToStranded(intent: Intent, results: readonly GroupResult[]): Intent (ruling P2-NARROW).
export type WriteLocalResult =                                   // ENG-37, verbatim
  | { kind: 'WRITTEN' } | { kind: 'MISMATCH'; found: OidOrAbsent } | { kind: 'LOCKED' } | { kind: 'COLLISION' }
  | { kind: 'FROZEN' } | { kind: 'DEFERRED'; reason: DeferReason } | { kind: 'PHANTOM' };
export interface WriterDeps {
  repo: GitRepo; fs: Fs; clock: Clock; scheduler: Scheduler; trace: Trace; log: Log; peer: PeerId;
  workTree: string; tmpDir: string; privateIndex: string;
  stage: StageDir; statCache: StatCache; diskEq: DiskEq; snapshot: Snapshotter;
  mode: 'link' | 'copy';                                          // Writer.probeMode at start (glossary §26.2 item 7)
  isFiltered: (path: string) => boolean; isText: (path: string) => boolean;   // from the AttrCache at EPOCH_BASE: the re-merge applies canon only to text, unfiltered paths
  journal: (intent: Intent) => Promise<void>;                     // one state update
  frozen: () => boolean;
  onPhantom: (path: string, target: TreeEntry) => Promise<void>;  // PHANTOM PIN, guard 'phantom' (ENG-34)
  onLateWrite: (path: string, stageCopy: string) => Promise<void>;// ring late write → PATCH (ENG-35)
}
export interface RollbackReport { complete: number[]; rolledBack: number[]; leftoverOld: Array<{ path: string; file: string }>; }
export class Writer {
  constructor(d: WriterDeps);
  /** Groups of one journaled apply intent (the caller journaled J and called crashpoint('apply.intent')): P0 .new by one smudgeBlobs call per group (ENOSPC → defer disk_low), P1 (DISK_EQ pre-image, ≤ 3 re-merges, st0, rename → tmp/<n>.old + stat re-check; creates only into ENOENT), crashpoint('apply.group.phase1'), yieldPoint('apply.beforePhase2'), P2 (mkdir -p, link or copy fallback; crashpoint('apply.group.mid') between paths), RT, crashpoint('apply.group.phase2'); crashpoint('apply.between_groups') between groups; full ROLLBACK of a failing group. */
  applyGroups(groups: readonly WriteGroup[], remerge: Remerge): Promise<GroupResult[]>;
  writeLocal(path: string, expected: OidOrAbsent, target: Oid | 'DELETE', origin: string, humanEvidence?: boolean): Promise<WriteLocalResult>;
  writeLocalGroup(entries: ReadonlyArray<{ path: string; expected: OidOrAbsent; target: Oid | 'DELETE' }>, origin: string, humanEvidence?: boolean): Promise<WriteLocalResult>;
  sweepRing(): Promise<void>;                                     // .old ≥ 2 s Δmono: stat-compare, late write → onLateWrite, delete
  rollbackIntent(intent: Intent, targets: ReadonlyMap<string, TreeEntry | null>): Promise<RollbackReport>;   // ENG-53 step 4
  pathState(path: string): Promise<'idle' | 'applying' | 'pending' | 'busy'>;   // ENG-38, ≤ 250 ms wait
  static probeMode(fs: Fs, tmpDir: string, workTree: string): Promise<'link' | 'copy'>;   // probes a hard link from tmp/ into the work-tree root; EXDEV/EPERM/ENOTSUP → copy
  // The loop calls writer.sweepRing() every iteration (ring expiry, orphan handling P2-ORPHANS, stranded restores P2-STRANDED).
}

// src/engine/fetcher.ts (ENG-13, ENG-18, ENG-19; glossary §25 F10)
export const FETCH_SPACING_MS = 2_500;
export const OFFLINE_AFTER_MS = 30_000;
export interface FetchView { ok: boolean; board: OidOrAbsent; code: OidOrAbsent; branch: OidOrAbsent; completedMono: number; httpThrottle: HttpThrottle; killedByWatchdog: boolean; firstOfRun: boolean;
  deferred: boolean;          // P2-NOSLEEP: no fetch ran (spacing or backoff); the fields are the last view's
  localFailure: boolean;      // P2-FETCHLOCAL: the remote answered but the local ref update failed (shown distinctly, not OFFLINE)
}
export type FetchImpl = (repo: GitRepo, url: string, specs: readonly FetchSpec[], abort?: AbortSignal) => Promise<FetchResult>;   // abort passed to every network call (P2-ABORT)
export class Fetcher {
  constructor(d: { repo: GitRepo; url: string; refs: RefNames; clock: Clock; trace: Trace; peer: PeerId; impl?: FetchImpl });
  /** Single flight: during an in-flight fetch, await it; else, if ≥ 2.5 s since the previous start, fetch. Ruling P2-NOSLEEP: fetch never sleeps — inside the spacing or a backoff it returns the last view at once with `deferred: true` (the iteration continues with snapshots and captures, ENG-19); force skips the spacing (never the backoff, never the single flight). */
  fetch(force?: boolean): Promise<FetchView>;
  lastSuccessMono(): number | null;
  offline(): { offline: boolean; offlineForMs: number };
  nextAllowedMono(): number;
  inFlight(): boolean;
  abandon(): void;                                 // suspend gap: the in-flight fetch is ABORTED (process tree killed via GitCallOptions.abort) and its result discarded; the next fetch starts only after the aborted process exited (O-FETCH: never two fetches at once)
}

// src/engine/incident.ts (01-engine §3.7 CHECK; ENG-20; INV-FIRSTPARENT)
export function fpOk(repo: GitRepo, old: Oid, next: Oid): Promise<boolean>;
export type IncidentWhy = 'board_missing' | 'board_not_ff' | 'code_not_ff' | 'board_shape' | 'live_shape';
export type IncidentVerdict = { ok: true } | { ok: false; why: IncidentWhy; observedBoard: Oid | null; observedCode: Oid | null };
/** FP_OK(LA_B, T), FP_OK(LA_C, TIP), shapes on LA_B..T and LA_C..TIP, board present; never reads the mirror or displaced refs. Mutant M07: always ok. */
export function incidentCheck(repo: GitRepo, laB: Oid, laC: Oid, T: OidOrAbsent, mutants: ReadonlySet<MutantId>): Promise<IncidentVerdict>;
/** live_base(L): X of the newest base-move commit on L's first-parent chain, else the genesis Cowork-Base; with the commit that introduced it. */
export function liveBase(repo: GitRepo, L: Oid): Promise<{ base: Oid; introducedBy: Oid }>;

// src/engine/pushResult.ts (ENG-44, PRO-54; never reads text — L-CLASSIFY-TEXT)
export type PublishOutcome = 'landed' | 'lease_lost' | 'transient' | 'network' | 'nonretryable';
export interface PublishObservation { boardStatus: PushRefStatus; refetchedBoard: OidOrAbsent; lease: OidOrAbsent; ourWriterOnChain: boolean; previousStreak: number; }
/** landed (our writer or an op id on T′'s chain after the lease) > lease_lost (T′ ≠ T) > status 'rejected' with T′ == T → transient (streak + 1; nonretryable at 3) > status 'none' with T′ == T → network (streak unchanged). Built on classifyPush. */
export function classifyPublish(o: PublishObservation): { outcome: PublishOutcome; streak: number };

// src/engine/core.ts
export type ScratchName = 'a' | 'p' | 'out' | 'r' | 'cmp' | 'detect' | 'canon' | 'add';
export interface EngineCore {
  readonly deps: EngineDeps; readonly peerId: PeerId;
  readonly repo: GitRepo; readonly refs: RefNames;
  readonly state: StateStore; readonly holds: HoldRegistry; readonly cs: ChangeSets;
  readonly snapshot: Snapshotter; readonly diskEq: DiskEq; readonly writer: Writer;
  readonly fetcher: Fetcher; readonly governor: Governor; readonly folder: Folder;
  readonly attrs: AttrCache; readonly stage: StageDir; readonly statCache: StatCache;
  view: StateView | null;          // last committed state (null before genesis or join)
  outbox: Outbox;
  filters: FilterSet; config: TeamConfig;
  caps: TeamCaps | null;           // folded team caps (push options)
  lastApplyMono: number | null; lastPushMono: number | null;
  pushAttempts: number;            // counted attempts (status, tests, SIM)
  path(rel: string): string;       // absolute path under coworkDir
  scratch(name: ScratchName): string;
  commit(t: Transition): Promise<StateView>;   // view := state.commit(view, t)
  identity(): GitIdentity;
}
export interface IterationCtx {
  n: number; start: Anchor;
  fetched: FetchView | null;
  T: OidOrAbsent; tip: Oid; tipMap: TreeMap; A: TreeMap;
  fold: FoldState; version: VersionVerdict;
  epochBase: Oid; scopeInputs: ScopeInputs; scope(path: string): Scope;
  tick: TickResult | null; mat: Materialized | null;
  freeze: readonly FreezeReason[]; pushStates: readonly PushState[];   // P2-PUSHSTATES: every active state ([] = ok), passed to Outbox.take/pendingAllowed and Governor.onFetch's pending
  leaseIdleMs: number;
}
/** Builds every component for one clone (no network, no state write): creates <coworkDir>, tmp/ (0o700), tmp/stage, empty-hooks/, probes the writer mode, loads the registry, discovers filters at EPOCH_BASE (or HEAD before a state exists). */
export function createEngineCore(deps: EngineDeps): Promise<EngineCore>;
export interface PrepareOptions { materialize: boolean | 'auto'; forceFetch: boolean; }   // 'auto' = when a capture is due or applyNeeded
export type Prepared =
  | { ok: true; it: IterationCtx }
  | { ok: false; why: 'incident'; verdict: Extract<IncidentVerdict, { ok: false }>; T: OidOrAbsent }
  | { ok: false; why: 'no_state' | 'snapshot_failed' | 'config_net' };   // config_net: FREEZE(CONFIG url|public), unreachable in Plan 2 (Plan 7)
/** 01-engine §3.5 steps 1–3: fetch (Fetcher, ls-remote fallback), incident check (entering the incident is the caller's, Task 16), fold + VERSION verdict, detection tick, materialize per the option. Shared by Engine.iterate, startDispatch and tests.
 *  An answered ls-remote fallback with the board ABSENT is a successful fetch and takes the incident branch (board_missing) when a state exists.
 *  A failed fetch (transport: no answer) is NOT a failure branch (§3.5 step 1, ENG-19): the result is ok with it.fetched.ok === false and T/tip/fold of the last
 *  successfully checked board (LA_B when this run has none), so steps 3–5 (tick, capture, apply of pending paths) still run; no publish
 *  in that iteration, and pushState 'offline' once ENG-19's 30 s hold. */
export function prepareIteration(core: EngineCore, n: number, o: PrepareOptions): Promise<Prepared>;

// src/engine/apply.ts (01-engine §3.11; ENG-06, ENG-29 apply side, ENG-30…ENG-36; R-02, R-05)
export const APPLY_COALESCE_MS = 10_000;
export const FREE_SPACE_MARGIN_BYTES = 268_435_456;
export interface ApplyReport {
  ran: boolean;
  skipped: null | 'frozen' | 'coalesced' | 'nothing' | 'disk_low' | 'snapshot_failed' | 'lease' | 'merge_failed';
  written: string[]; deleted: string[];
  deferred: Map<string, DeferReason>; notApplicable: Map<string, 'collision' | 'unmaterializable' | 'quarantine'>;   // ApplyReport.skipped also gains 'stranded'; prepareIteration commits one transition clearing a narrowed apply intent THIS run kept once its stranded restore succeeded (never one left by a crash); ruling P2-STRANDED-SKIP: TickInput.skip includes writer.strandedPaths() and no capture/materialize-for-capture happens while any restore is stranded (core.ts exports tickSkip(core) and captureDue(core); Task 17 captures only on captureDue)   // P2-QUARANTINE-IN: an incoming change to a QUARANTINED path is not applicable (A keeps its entry, listed in not_converged 'quarantine: commit with git'), never written live (S8, glossary §16); not-applicable paths leave the apply trigger and are re-checked cheaply each loop (P2-NA-TRIGGER); a whole-apply disk_low commits a meta.pending-only transition (P2-DISKLOW-PENDING)
  records: string[]; cancelled: string[];
}
export function applyNeeded(core: EngineCore, it: IterationCtx): boolean;    // ∃ applicable p: A[p] ≠ TIP[p]; mutant M17: TIP ≠ LA_C
/** Admission, M_disk = merge-tree --merge-base=A S_disk TIP, rename carry, conflict routing (records before any write), not-applicable paths, defer set, write groups, intent J + crashpoint('apply.intent'), Writer.applyGroups, the ENG-36 state update (A, LA_C := TIP, LA_B := T, snap, pending, HLD-41 rebased pairs, intent cleared) + crashpoint('apply.state'), trace A_set. Ruling P2-PUSHINTENT-FIRST: not admitted and nothing journaled while view.intent.kind === 'push' (callers run resolvePushIntent first). Ruling P2-SCRATCHLOCK: every read-tree into an engine scratch index (tmp/*.index) first runs resetScratchIndex (index + .lock), never .git/index.lock or the private index. */
export function applyStep(core: EngineCore, it: IterationCtx): Promise<ApplyReport>;

// src/engine/assertions.ts (ENG-41; letter (f) is SEC-07's scan, out per ruling R-06 (Plan 7))
export type AssertLetter = 'a' | 'b' | 'c' | 'd' | 'e' | 'g' | 'h' | 'i' | 'j' | 'INV-MASK';
export interface PrePushInput {
  T: OidOrAbsent; tip: Oid; tipMap: TreeMap; A: TreeMap; P: TreeMap; out: TreeMap; outTree: Oid; emptyTree: Oid;
  bnewParents: readonly Oid[]; liveCode: Oid; cParents: readonly Oid[] | null;   // null = board-only (liveCode == tip)
  scope: (p: string) => ScopeClass; masked: (p: string) => boolean;
  heldEntriesAdded: number;                                                       // 0 in Plan 2
  readBlob: (o: Oid) => Promise<Buffer>;
}
export function prePushAsserts(inp: PrePushInput): Promise<{ ok: true } | { ok: false; letter: AssertLetter; path: string | null }>;

// src/engine/publish.ts (01-engine §3.12; ENG-39…ENG-46; PRO-40…PRO-45, PRO-54, PRO-55)
export interface PublishReport {
  attempted: boolean;
  outcome: PublishOutcome | 'skipped' | 'aborted' | 'nothing';
  why: string | null;                 // e.g. 'window', 'state', 'publish_assert:b', 'snapshot_failed', 'filter_failure'
  bnew: Oid | null; c: Oid | null; records: string[];
}
export function publishPending(core: EngineCore, it: IterationCtx): Promise<boolean>;   // PRO-42: P ≠ A somewhere, or allowed outbox ops
/** Steps 1 and 3–8 of the §3.12 pipeline (B1 is Plan 4, T0 Plan 3) on the leased tip, re-run from scratch every window: P, OUT + rename carry + conflict function (K4 records before the push), ENG-41, C (omitted when OUT == tree(TIP)) and Bnew, push intent with t/P and seq_next + crashpoint('publish.out_built'), yieldPoint('publish.beforePush'), governedPush whose classify callback runs crashpoint('publish.sent'), the fresh fetch and classifyPublish, then crashpoint('publish.landed') + applyPushOk on landing, streak/NONRETRYABLE/host-reject PIN, throttle signals. No publish in an iteration whose fetch failed (it.fetched?.ok === false). Mutant M06 pushes S_disk as OUT; M12 classifies by text. */
export function publishStep(core: EngineCore, it: IterationCtx): Promise<PublishReport>;
/** Resolves a kept push intent by observation (landed → applyPushOk; not landed → discard; a failed first-parent walk → stays ambiguous, kept). Restart and iterate call it before applyStep while view.intent.kind === 'push' (P2-PUSHINTENT-FIRST). A landing is decided by Bnew's oid on the board's first-parent chain. */
export function resolvePushIntent(core: EngineCore, it: IterationCtx): Promise<PublishReport>;
/** One governed attempt as the caller observed it after the push (never by text): publishStep's fresh fetch + classifyPublish, the probe's re-fetch of Q, the displaced/recover re-fetch. */
export interface AttemptClass { outcome: TraceOutcome; transient: boolean; landed: boolean; }
export type GovernedBody = { specs: readonly PushSpec[] } | { deleteProbe: { ref: string; lease: Oid } };   // deleteProbe: PRO-49 step 5, through deleteProbeRef
/** PRO-41: the one function that spawns a push (runPush, or deleteProbeRef for a deleteProbe body): governor gate (exempt per R-21), attempt counted (onAttemptStart), the push, slow-push and HTTP throttle signals; then `classify(raw)`; only after it returns: onAttemptEnd (its transient/landed come from the AttemptClass) and trace 'push' with the classified outcome (a KilledAt inside classify leaves that attempt untraced). Only publishStep's classify hits a publish.* crashpoint. */
export function governedPush(core: EngineCore, purpose: PushPurpose, body: GovernedBody, exempt: boolean, rank: number, classify: (raw: PushOutcomeRaw) => Promise<AttemptClass>, opts?: { pushOptions?: readonly string[] }): Promise<{ raw: PushOutcomeRaw; cls: AttemptClass } | 'denied'>;   // opts.pushOptions: '-o <opt>' each, honouring caps.push_options (the probe's ci.skip)
/** Task 14 fix-round exports: hostText(s) + HOST_TEXT_MAX (C0/DEL/C1/bidi/U+2028/2029/200B/FEFF stripped, capped by code points); assertions.ts heldPathInP (the one place assigning 'i' vs 'INV-MASK'); Outbox.maxOwnSeq(self); src/engine/treeEdit.ts (index-only tree edits, resetScratchIndex before every read-tree, P2-SCRATCHLOCK); src/engine/treeDiff.ts (pure diffPaths, sameTreeEntry, isRegularEntry). */
/** ENG-44 ok update in one state update: LA_C := C (unchanged when board-only), LA_B := Bnew, A[p] := C[p] where C[p] == P[p] and A[p] unchanged since capture, streak reset, outbox.landed, published pairs leave the journal, intent cleared; trace A_set push_confirmed. Restart reuses it. */
export function applyPushOk(core: EngineCore, intent: Extract<Intent, { kind: 'push' }>, P: TreeMap): Promise<void>;

// src/engine/start.ts (Table 3.3-A; ENG-51, ENG-52; PRO-07, PRO-49; R-21…R-23)
export type StartMode = 'genesis' | 'join' | 'restart';
export interface StartOptions { publishLocal: 'all' | 'none' | null; }
export type StartRefusal = 'GENESIS_BOARD_MISSING' | 'START_HEAD_BEHIND' | 'START_HEAD_AHEAD' | 'START_HEAD_STATE' | 'START_PREVIEW' | 'START_VERSION'
  | 'START_STATE_NEWER' | 'START_REPO_IDENTITY' | 'START_BRANCH_NOT_ON_REMOTE' | 'START_REFUSED_CUSTOM_REFS' | 'START_REFUSED_NO_LEASE' | 'START_REMOTE' | 'START_REPO_SHAPE';   // START_REPO_SHAPE{reason:'tmp_volume'} (08-lifecycle Table): tmp/ (gitdir) and the work tree on different volumes (rename probe EXDEV); START_REMOTE reasons also 'unreachable', 'board_malformed', 'genesis_push_failed' (spec-edits.md); startDispatch never throws for remote content or the network
export type StartResult = { ok: true; mode: StartMode; restart: RestartReport | null } | { ok: false; code: StartRefusal; params: Record<string, Json> };
export function startDispatch(core: EngineCore, opts: StartOptions): Promise<StartResult>;
export function runProbe(core: EngineCore, hr: Oid): Promise<TeamCaps>;                      // PRO-49 steps 1–5 (3 consecutive rejections = refusal)
export function genesis(core: EngineCore, hr: Oid, opts: StartOptions): Promise<StartResult>;   // ENG-51 (+ R-22 local work); yieldPoint('start.beforeGenesisPush')
export function join(core: EngineCore, T: Oid, hr: OidOrAbsent, opts: StartOptions): Promise<StartResult>;   // ENG-52; crashpoint('join.first_apply')

// src/engine/restart.ts (ENG-53, ENG-54; R-24)
export const LOST_STATE_MAX_COMMITS = 500;
export interface LostStateReport { mode: 'lost_state' | 're_anchor'; records: string[]; paths: string[]; }
export interface RestartReport { intent: Intent['kind']; rolledBackGroups: number[]; restartRecords: string[]; pushResolved: 'landed' | 'discarded' | null; lostState: LostStateReport | null; }
/** Leftovers (own <e>.index.lock, tmp/*.new, tmp/stage, own-namespace ref locks, tmp scratch index locks; ages compared with a tmp/restart-mark file's mtime; ruling P2-REPOLOCKS: packed-refs.lock is never deleted, only logged when stale; a kept or unknown .old becomes tmp/orphan-<k>.old, never deleted blindly), lost-state path only when HEAD is the symbolic branch (else START_HEAD_STATE), state read (LostStateError → lostStateRebuild), intent resolution with the HLD-41 rebase in ONE state update, private index reseed when missing. */
export function restart(core: EngineCore): Promise<RestartReport>;
/** ENG-54 per-path rebuild against T; `paths` restricts it to the per-path primitive. LIVE unmatched → A[p] := TIP[p] + 'restart' record; QUARANTINED/SAVE_ONLY → newest match else TIP, no record; UNMANAGED → TIP unread; LA_C := TIP, LA_B := T, new epoch, LOST_STATE. */
export function lostStateRebuild(core: EngineCore, T: Oid, mode: 'lost_state' | 're_anchor', paths?: ReadonlySet<string>, metaOverrides?: Partial<Meta>): Promise<LostStateReport>;   // metaOverrides: committed in the SAME state update (the re-anchor clears INCIDENT, incident, displaced and sets the rebuilt outbox and fold_board in one update); fold persisted from the new LA_B
/** Remote-content errors are typed at their source: BoardMalformedError (board) and RemoteContentError (live code/base chain, fold shape); startDispatch/recover map only these to START_REMOTE{board_malformed} / RECOVER refusals, never a plain Error. Orphan files are never reused: tmp/orphan-<ulid>.old (Random port), each moved with a WRITE_TMP_ORPHAN{file, path|null} line; a stranded .old moved aside by the writer goes to an orphan name with its known path, never to tmp/ring-*. Own-namespace locks (refs/cowork-local/<e>/*.lock, refs/cowork-remote/**/*.lock, the private index lock, tmp scratch index locks) are removed at restart while daemon.lock is held without an age check (only this daemon writes them); the restart-mark age rule applies to tmp/ring-* only; packed-refs.lock is never removed (P2-REPOLOCKS). resetScratchIndex and ScratchResetError live in src/git/scratchIndex.ts (diskEq re-exports), so src/holds can use them. */

// src/engine/recover.ts (01-engine §3.7; ENG-21, ENG-22)
export const DISPLACED_CAP = 3;
export type RecoverRefusal = 'RECOVER_NOT_IN_INCIDENT' | 'RECOVER_OFFLINE' | 'RECOVER_AMBIGUOUS' | 'RECOVER_DISPLACED_FULL' | 'RECOVER_PREVIEW_STALE' | 'RECOVER_HEAD_STATE';   // PREVIEW_STALE: the confirm's preview id no longer matches (LA_B, V, X, A) after resolving a kept push intent; HEAD_STATE{op}: a re-anchor needs the symbolic branch HEAD (same rule as the lost-state rebuild); RECOVER_OFFLINE params carry reason (fetch | walk | lease_lost | rejected | push_intent_unresolved); RECOVER_AMBIGUOUS params carry the displaced ref names (spec-edits.md)
export interface RecoverPreview { mode: 'restore' | 'reanchor'; V: OidOrAbsent; X: Oid | null; candidates: Oid[]; restartPaths: string[]; id: string; }   // id: 6 hex over the shown oids and paths
export type RecoverResult = { ok: true; preview: RecoverPreview; done: boolean } | { ok: false; code: RecoverRefusal; params: Record<string, Json> };
export function enterIncident(core: EngineCore, v: Extract<IncidentVerdict, { ok: false }>, T: OidOrAbsent): Promise<void>;   // FREEZE(INCIDENT), incident-<n>, one governed ABSENT-leased displaced copy of LA_B (< 3)
export function clearIncidentIfHealed(core: EngineCore, it: IterationCtx): Promise<boolean>;  // check passes again → refold (PRO-25), UNFROZEN
export function recover(core: EngineCore, confirm: string | null): Promise<RecoverResult>;    // null = preview; crashpoints recover.displaced, recover.reanchor

// src/engine/epoch.ts (ruling R-09)
export const OPERATION_MARKERS: readonly string[];   // MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, REBASE_HEAD, BISECT_LOG, rebase-merge, rebase-apply, sequencer
export const INDEX_LOCK_NOTICE_MS = 30_000;
export interface EpochObservation { symref: string | null; head: Oid | null; stash: Oid | null; markers: string[]; indexLock: { present: boolean; mtimeNs: bigint | null }; }
export function observeEpoch(repo: GitRepo, fs: Fs): Promise<EpochObservation>;
export function epochVerdict(o: EpochObservation, expected: Meta['expected_epoch']): 'E1' | 'FREEZE';

// src/engine/status.ts (glossary §14; 01-engine §3.16; ENG-56, ENG-57; R-16, R-35)
export type StatusState = 'ok' | 'degraded' | 'offline' | 'frozen' | 'incident' | 'paused' | 'refused' | 'down';
export type PublishPause = null | 'OFFLINE' | 'AUTH' | 'NONRETRYABLE' | 'VERSION';
export interface StatusJson {   // glossary §14 exactly; no other field
  v: 1; state: StatusState; freeze_reasons: FreezeReason[]; publish_pause: PublishPause;
  branch: string; peer_id: string; plugin_version: string;
  heartbeat_mono_ms: number; loop_period_ms: number;
  last_fetch_age_ms: number | null; last_push_age_ms: number | null;
  pending: { cs_ready: number; cs_open: number; holds_active: number; holds_local_only: number; incoming: number; not_converged: string[] };
  claims_held: number; requests_in: number; requests_out: number;
  adopt: { state: 'current' | 'blocked'; reasons: string[] };
  message_code: string | null; message_params: Record<string, Json>;
}
export interface StatusInputs {
  refused: { code: string; params: Record<string, Json> } | null;
  down: { code: 'IDLE_NO_SESSION' | null } | null;
  freeze: readonly FreezeReason[];
  offline: { label: 'OFFLINE' | 'AUTH'; explanation: string; offlineForS: number } | null;
  nonretryable: { holdId: string } | null;
  version: { form: 'proto' | 'regionSpec'; cause: 'checkpoint_mismatch' | null } | null;
  notConverged: readonly string[]; pendingOlderThan60s: boolean;
  throttle: { source: string; untilMin: number; budget: number; fallbackLeftS: number; signal: ThrottleSignal | 'team' } | null;
  branchRewritten: { hb: string; hr: string } | null;
  lastEvent: { code: string; params: Record<string, Json> } | null;
  counts: { csReady: number; csOpen: number; holdsActive: number; holdsLocalOnly: number; incoming: number };
  branch: string; peerId: string; pluginVersion: string;
  heartbeatMs: number; loopPeriodMs: number; lastFetchAgeMs: number | null; lastPushAgeMs: number | null;
}
/** State precedence refused > incident > frozen > paused > offline > degraded > ok ('down' only from `down`); message_code of the highest condition; in 'ok': BRANCH_REWRITTEN, else HOST_THROTTLED, else lastEvent, else null. Pure. */
export function computeStatus(i: StatusInputs): StatusJson;
export class StatusWriter {
  constructor(fs: Fs, file: string, tmpDir: string, clock: Clock);
  write(s: StatusJson): Promise<boolean>;   // temp + rename; EPERM/EACCES retry 3 × 50 ms, then skip (false)
}

// src/engine/loop.ts (01-engine §3.5; ENG-13…ENG-19, ENG-55…ENG-57)
export const LOOP_ACTIVE_MS = 2_500;
export const LOOP_IDLE_MS = 10_000;
export const SUSPEND_LOOP_FACTOR = 3;          // Δmono > 3 × loop period between iterations = suspended (Global Constraints)
export interface IterationReport { n: number; fetched: boolean; applied: boolean; pushAttempts: number; landed: boolean; frozen: boolean; incident: boolean; active: boolean; nextDueMs: number; }
export interface EngineInspection {
  peerId: PeerId; laC: Oid; laB: Oid; aTree: Oid; snapTree: Oid; epochBase: Oid;
  freeze: FreezeReason[]; publishPause: PublishPause;
  pending: Record<string, DeferReason>; notConverged: string[];
  holds: HoldRecord[]; ready: ReadyPair[]; pushAttempts: number; status: StatusJson;
}
export class Engine {
  static create(deps: EngineDeps): Promise<Engine>;
  readonly peerId: PeerId;
  readonly core: EngineCore;
  start(opts: StartOptions): Promise<StartResult>;
  /** One iteration, steps 0–7 with the Plan 2 subsets; never overlaps itself. */
  iterate(): Promise<IterationReport>;
  done(): void;
  requestFreshFetch(): void;
  recover(confirm: string | null): Promise<RecoverResult>;
  resumeAfterNonretryable(): Promise<boolean>;  // R-28 (no daemon running)
  inspect(): Promise<EngineInspection>;
  drain(downCode: 'IDLE_NO_SESSION' | null): Promise<void>;
  readonly drained: boolean;
}
export interface LoopHandle { stop(): Promise<void>; readonly finished: Promise<void>; }
/** Production driver: iterate() every LOOP_ACTIVE_MS while active, else LOOP_IDLE_MS (or sooner per nextDueMs), one at a time; drain(IDLE_NO_SESSION) after LEASE_EXIT_MS without a lease. */
export function runLoop(engine: Engine, d: { scheduler: Scheduler; clock: Clock; lease: LeasePort }): LoopHandle;

// src/daemon/run.ts (R-26…R-28; dist/daemon.js)
export type DaemonCommand = 'run' | 'recover' | 'resume';
export interface DaemonArgs { cmd: DaemonCommand; repo: string; branch: string; publish: 'all' | 'none' | null; name: string | null; remote: string | null; confirm: string | null; }
export function parseDaemonArgs(argv: readonly string[]): DaemonArgs | { usage: string; exitCode: 0 | 2 };
export interface ResolvedRemote { name: string; url: string; }
export type RemoteRefusal = 'START_REMOTE' | 'SEC_REFUSE_REMOTE_SPLIT' | 'SEC_REFUSE_URL_REWRITE';
export function resolveRemote(repo: GitRepo, branch: string, explicit: string | null): Promise<ResolvedRemote | { refuse: RemoteRefusal; params: Record<string, Json> }>;
export function sanitizeUrl(url: string): string;   // drops userinfo from every printed URL
export interface DaemonIo { out(line: string): void; err(line: string): void; onStop(cb: () => void): void; }
/** Exit 0 success, 1 refusal (code + one next command), 2 internal error. */
export function runDaemon(args: DaemonArgs, env: Readonly<Record<string, string | undefined>>, io: DaemonIo): Promise<number>;
```

### Test helpers, SIM and tools

```ts
// test/helpers/repoFixture.ts
export interface RepoFixture { root: string; remote: BareRemote; peer: PeerClone; repo: GitRepo; paths: RepoPaths; runner: GitRunner; cleanup(): Promise<void>; }
export async function makeRepoFixture(label: string, opts?: { files?: Record<string, Buffer>; autocrlf?: boolean; filter?: boolean }): Promise<RepoFixture>;

// test/sim/traceRecorder.ts
export class TraceRecorder implements Trace {
  emit(ev: TraceEvent): void;
  readonly events: readonly TraceEvent[];
  since(index: number): readonly TraceEvent[];
  ofKind<K extends TraceEvent['kind']>(kind: K): Array<Extract<TraceEvent, { kind: K }>>;
  readonly names: Map<string, string>;        // peer_id → harness peer name
}

// test/helpers/coreFixture.ts — EngineCores on real clones with virtual ports
export interface PeerFixture { name: string; clone: PeerClone; clock: VirtualClock; fs: FaultFs; deps: EngineDeps; core: EngineCore; }
export interface CoreFixture {
  root: string; remote: BareRemote; peers: PeerFixture[]; scheduler: VirtualScheduler; trace: TraceRecorder;
  advance(ms: number): void;                                   // every peer clock and the scheduler clock
  /** Test-only stand-in for genesis/join until Task 15: L0/B0 built with the Task 5 builders, pushed with ABSENT leases, each peer's state created with A = tree(HEAD), LA_C = L0, LA_B = B0, a new epoch. */
  bootstrap(): Promise<void>;
  /** A synthetic teammate lands one live commit (bytes or null = delete, stored as given) with Cowork-CS/Cowork-CS-Paths trailers and its board commit, leased. */
  pushTeamChange(changes: Readonly<Record<string, Buffer | null>>, opts?: { csId?: string }): Promise<{ board: Oid; live: Oid }>;
  cleanup(): Promise<void>;
}
export async function makeCores(label: string, opts: { n: number; files?: Record<string, Buffer>; autocrlf?: readonly boolean[]; seed?: string; mutants?: ReadonlySet<MutantId> }): Promise<CoreFixture>;

// test/helpers/engineFixture.ts — Engines on real clones with virtual ports
export interface EngineFixture extends Omit<CoreFixture, 'peers'> {
  peers: Array<PeerFixture & { engine: Engine }>;
  startAll(opts?: StartOptions): Promise<void>;          // peer 0 genesis, the others join
  rounds(n: number, loopMs?: number): Promise<void>;    // advance every clock loopMs (default 2,500), iterate every engine in name order
}
export async function makeEngines(label: string, opts: { n: number; files?: Record<string, Buffer>; autocrlf?: readonly boolean[]; seed?: string; mutants?: ReadonlySet<MutantId> }): Promise<EngineFixture>;

// test/sim/harness.ts — additions (Plan 1 members unchanged; the 4th runSim argument is optional)
export interface SimOp { readonly peer: string; readonly kind: string; run(ctx: SimContext): Promise<string>; }   // returns the op-log detail
export interface OpGenerator { next(ctx: SimContext, step: number): SimOp | null; }   // null → one engine iteration of a random peer
export interface QuiescenceOptions { loopMs: number; k: number; extraLoops: number; maxRounds: number; }
export const DEFAULT_QUIESCENCE: QuiescenceOptions;          // { loopMs: 2_500, k: 20, extraLoops: 40, maxRounds: 400 }
export interface QuiescenceInfo { reached: boolean; tStar: string | null; rounds: number; pushAttemptsInExtra: number; boardChangedInExtra: boolean; }
export interface SimOptions {
  generator?: OpGenerator;
  quiescence?: QuiescenceOptions;                            // omitted = Plan 1 behaviour (no quiescence phase)
  seedFiles?: Record<string, Buffer>;
  peerProfile?: (index: number) => { autocrlf: boolean; withFilter: boolean };
  crash?: { rate: number };                                  // p per step of arming a KilledAt at a random peer's next crashpoint
}
export interface SimContext {
  // …Plan 1 fields
  engines: SimEngine[]; trace: TraceRecorder;
  phase: 'ops' | 'quiescence' | 'extra';
  quiescence: QuiescenceInfo | null;
}
export interface SimEngine {
  readonly peer: PeerClone;
  step(ctx: SimContext): Promise<void>;
  inspect?(): Promise<EngineInspection>;
  pushAttempts?(): number;
}
export interface SimResult { /* …Plan 1 fields */ quiescence?: QuiescenceInfo; }
export async function runSim(t: SeedTuple, makeEngine: EngineFactory, oracles: Oracle[], opts?: SimOptions): Promise<SimResult>;

// test/sim/engineAdapter.ts
export interface RealEngineOptions { publishLocal?: 'all' | 'none'; mutants?: ReadonlySet<MutantId>; namespace?: RefNamespace; }   // publishLocal defaults to 'all' (an edit op may precede a peer's first step)
/** Per peer: Engine bound to the peer VirtualClock, ctx.scheduler, seededRandom(`${seed}/${peer}`), FaultFs(realFs), ctx.git, ctx.trace, alwaysLeased, humanOnlyAttribution, heartbeatMs = clock.monoMs, url = ctx.remote.url, testBuild true. First step: start() (a refusal throws). Later: iterate(). A KilledAt ends the step; the next step re-creates the Engine from disk (RESTART). */
export function realEngine(opts?: RealEngineOptions): EngineFactory;

// test/sim/generators.ts (11-testing §3.5 F-ED-2, F-ED-6, F-ED-8, F-ED-9, F-NET-2, F-NET-5, F-NET-10; R-31)
export type EditKind = 'new_file' | 'edit_own' | 'edit_band' | 'edit_same_line' | 'append_md' | 'eol_rewrite' | 'delete_own' | 'temp_file' | 'secret_name';
export type FaultKind = 'partition' | 'heal' | 'reject_transient' | 'race_push';
export interface GeneratorProfile { readonly name: 'edits' | 'faults'; readonly engineWeight: number; readonly weights: Readonly<Partial<Record<EditKind | FaultKind, number>>>; }
export const PROFILES: Readonly<Record<'edits' | 'faults', GeneratorProfile>>;
/** shared.txt (60 numbered LF rows, 6 bands of 10; peer i edits rows 3–7 of band i, rows 0–2 and 8–9 never edited), crlf.txt (CRLF-stored), notes.md, big.py (generateBigBomCrlf(400, r)), README.md, notes.txt. */
export function seedFilesPlan2(random: Random): Record<string, Buffer>;
/** Draws only from ctx.random; writes Buffers (node:fs, test code) in the file's dominant ending except eol_rewrite; sets every written file's mtime to the peer's virtual wall clock (utimes). */
export function editGenerator(profile: GeneratorProfile): OpGenerator;

// test/sim/oracles.ts — additions (oracleFF/oracleOID keep their Plan 1 signatures)
export function oracleFF(refPrefix: string): Oracle;          // + trace clause: no push argv with '--force' or a '+…refs/…' refspec unless purpose 'recover'
export function oracleOID(allowedDeletePrefixes: string[]): Oracle;
export function oracleFirstParent(): Oracle;                  // each 'merge' event: laC on TIP's first-parent chain, laB on T's (afterEveryOp)
export function oracleBase(): Oracle;                         // each 'merge' base == the peer's latest 'state'.base; each 'A_set' cause backed by an 'apply' write or a landed 'push' of that path ('disk_equal' by that step's 'apply' event); each 'join'/'genesis' A_set blob == the peer's tree(HEAD)[p] / tree(L0)[p] (what makes M05, A seeded from TIP, fail) (afterEveryOp)
export function oraclePushedIsMerge(): Oracle;                // each landed 'publish': recompute merge-tree --merge-base=aTree pTree tip in the peer repo + accepted replacements == tree(c); paths(diff(TIP, C)) ⊆ paths(diff(A, P)) (afterEveryOp)
export function oracleConverge(): Oracle;                     // ruling R-32 (atQuiescence): per peer LA_B == T*, A == tree(live_code(T*)) and the working tree's stored form (scratch index from T* + update-index --refresh + diff-files -z in the peer repo; test code may read working files) on LIVE paths outside not_converged; untracked files only if admitNew classifies them NOT_ADMITTED; then zero push attempts and an unchanged tip in the extra loops
export function exitOracles(ns?: RefNamespace): Oracle[];     // [FF, OID, FIRSTPARENT, BASE, PUSHED-IS-MERGE, CONVERGE]

// tools/real/two-clone.ts (R-34)
export interface TwoCloneReport { runId: string; branch: string; scenarios: Array<{ name: string; ok: boolean; detail: string }>; converged: boolean; ffHistory: boolean; pushes: number; k4Records: number; elapsedS: number; }
export function twoCloneRun(opts: { url: string; root: string; timeoutMs: number; log: (line: string) => void; runId?: string }): Promise<TwoCloneReport>;
```

**CLIs.**
- `tsx tools/sim/run-seeds.ts [--profile edits|faults] [--seeds N] [--from I] [--prefix P] [--peers 3] [--steps 40] [--parallel J] [--seed S]... [--report <file.json>]` — seeds `${prefix}${profile}-${i}` for i in [from, from + N); J child processes (`tools/sim/run-shard.ts`) each run a contiguous slice and print one JSON line per seed `{seed, ok, oracle?, step?, message?, ms, artifacts?}`; exit 0 all passed, 1 any failure, 2 usage or internal error; every failure is printed with its rerun command.
- `npm run sim:exit` = `run-seeds --profile edits --seeds 1000 --parallel 8`.
- `node dist/daemon.js run --repo <path> --branch <b> [--publish=all|none] [--name <display>] [--remote <name>]` (foreground until SIGINT/SIGTERM), `node dist/daemon.js recover --repo <path> --branch <b> [--confirm=<id>]`, `node dist/daemon.js resume --repo <path> --branch <b>`, `node dist/daemon.js --version`.
- `COWORK_REAL_REMOTE=<https url> npm run real:two-clone [-- --timeout-min 15 --keep]`; `npm run real:cleanup -- --remote <url> --run <run_id> [--yes]`.

**Lint rules added** (`tools/lint/rules.ts`; keyed on Plan 1's `argvOf`, so a non-git string array must not start with one of these words):

| Rule | Fails on | Source |
|---|---|---|
| L-GIT-FORBIDDEN | an argv whose subcommand is `checkout`, `checkout-index`, `switch`, `restore`, `stash`, `apply` or `gc`; `read-tree` with `-u` or `-m`; `reset` with `--hard`; `add` with `-A`, `--all` or `.`; `update-index` with both `--refresh` and `-q` | ENG-58, 11-testing §3.10 |
| L-FS-PORT | `fs`, `node:fs`, `fs/promises`, `node:fs/promises` loaded in `src/` outside `src/ports/fs.ts` | TST-01 |
| L-OBJ-WRITE | an argv starting `hash-object` outside `src/git/repo.ts` and `src/data/blobRoutes.ts`; an argv starting `add` outside `src/engine/snapshot.ts` and `src/engine/diskEq.ts` | glossary §26.1 W6 (approximation; 01-engine test 47 is the check) |
| L-PUSH-ARGV | an argv starting `push` outside `src/git/push.ts` | ENG-09, ENG-58 |
| L-CLASSIFY-TEXT | the identifiers `stderr`, `stderrText` or `message` in `src/git/classify.ts` or `src/engine/pushResult.ts` | ENG-58, glossary §26.2 item 2 |
| L-MIRROR | a property access `.localCode` or `.remoteCode` outside `src/engine/refs.ts`, `src/engine/fetcher.ts`, `src/engine/publish.ts`, `src/engine/start.ts` (genesis mirror push with an ABSENT lease, ENG-51) and `src/engine/recover.ts` (the recover push's mirror lease, ENG-22 step 5) | PRO-13, INV-ENG-AUTH |

---

## Tasks

| # | Task | Produces |
|---|---|---|
| 1 | Ports for the engine | `src/ports/{fs,clock}.ts` (modify), `src/ports/{trace,lease,log}.ts`, `test/sim/faultfs.ts` (modify) |
| 2 | Typed git layer | `src/git/flags.ts` (modify), `src/git/{oid,trailers,repo,merge}.ts`, `test/helpers/repoFixture.ts`, lint L-GIT-FORBIDDEN, L-FS-PORT |
| 3 | Data bytes: rows, canon, blob routes, conflict function | `src/data/{rows,linediff,canon,blobRoutes,conflict}.ts` |
| 4 | Scope classes, attributes, filters, team config, validators | `src/sec/validators.ts`, `src/data/{attrs,filters,config,scope}.ts` |
| 5 | Board format | `src/board/{ids,canonicalJson,ops,protocol,boardCommit}.ts` |
| 6 | The fold | `src/board/fold.ts` |
| 7 | Outbox and governor | `src/board/{outbox,governor}.ts` |
| 8 | Refs, meta, the state ref, engine deps | `src/engine/{refs,meta,state,deps}.ts` |
| 9 | Staged reads, stat cache, snapshot, DISK_EQ | `src/engine/{stagedRead,statCache,snapshot,diskEq}.ts`, lint L-OBJ-WRITE |
| 10 | Two-phase verifying writer | `src/engine/writer.ts` |
| 11 | Minimal holds: records, registry, MASK, write groups, human change-set | `src/holds/{record,registry,mask,groups,changesets}.ts` |
| 12 | Fetch, push, classification, incident check | `src/git/{push,fetch,httpStatus}.ts`, `src/engine/{fetcher,incident,pushResult}.ts`, lint L-PUSH-ARGV, L-CLASSIFY-TEXT, L-MIRROR |
| 13 | Engine core, iteration preparation, apply | `src/engine/{core,apply}.ts`, `test/sim/traceRecorder.ts`, `test/helpers/coreFixture.ts` |
| 14 | Publish | `src/engine/{assertions,publish}.ts` |
| 15 | Start (genesis with probe, join), restart, lost state | `src/engine/{start,restart}.ts` |
| 16 | Incidents and recover | `src/engine/recover.ts` |
| 17 | The loop, epoch guard, status.json, foreground daemon | `src/engine/{epoch,status,loop}.ts`, `src/daemon/run.ts`, `src/entry/daemon.ts` (modify), `test/helpers/engineFixture.ts` |
| 18 | Real engine in the SIM harness, op generator | `test/sim/harness.ts` (modify), `test/sim/{engineAdapter,generators}.ts` |
| 19 | SIM oracles, crash matrix, seed runner, CI budgets | `test/sim/oracles.ts` (modify), `tools/sim/{run-seeds,run-shard}.ts`, `.github/workflows/{ci,sim-exit}.yml`, `package.json` |
| 20 | Real-remote two-clone sync test | `tools/real/{two-clone,cleanup}.ts`, `package.json` |

Every task: TDD (failing test first, then code), real git against `file://` bare remotes (never mocked), SIM tests deterministic by seed, `npm run ci` green before its commit, one commit per green step ending with the Co-Authored-By line. Test titles below are the `test(...)` names; each line after the dash is what the test asserts. A task that adds a crashpoint call site places it exactly at the 11-testing §3.6 anchor quoted for it; `test/crashpoints.json` already lists all 14 Plan 2 names and is not edited.

---

### Task 1: Ports for the engine

**Files:**
- Modify: `src/ports/fs.ts`, `src/ports/clock.ts`, `test/sim/faultfs.ts`, `test/unit/fs.test.ts`, `test/unit/faultfs.test.ts`
- Create: `src/ports/trace.ts`, `src/ports/lease.ts`, `src/ports/log.ts`
- Test: `test/unit/ports-plan2.test.ts`

**Interfaces:**
- Consumes: Plan 1 `Fs`, `realFs`, `FaultFs`, `FaultRule`, `Clock`, `realClock`.
- Produces: `FsLstat`, `sameStat`, the new `Fs` members and their `realFs` implementations; `FaultOp` (widened), `LockMode`, `FaultFs.holdLock`/`setNoHardLinks`/`interpose`/`calls`; `machineMonoMs`; `Trace`, `TraceEvent`, `PushPurpose`, `ASetCause`, `TraceOutcome`, `noTrace`; `LeasePort`, `alwaysLeased`, `LEASE_STOP_SYNC_MS`, `LEASE_EXIT_MS`; `Log`, `LogLevel`, `LogParam`, `nullLog`, `fileLog`.

**Spec:** 11-testing §3.2 (Fs row: lock probe, lock emulation, link failure; Notifier trace events), §2 (trace event); glossary §26.1 W3, W4, §26.2 item 7 (F-FS-8); 01-engine §3.16 (machine-wide heartbeat); CCI-50 (lease numbers); glossary §6 (`log/daemon-<n>.jsonl`); rulings R-11, R-35, R-37.

**Tests:**
- `"lstat returns bigint mtimeNs, ino, dev and mode, null on ENOENT and ENOTDIR, and never follows a symlink"` — the POSIX symlink case is skipped where symlinks need privileges.
- `"writeFileExclusive creates a new file and fails EEXIST without touching an existing one"`.
- `"rmdir removes an empty directory and fails ENOTEMPTY on a non-empty one"`.
- `"appendFile appends Buffers in order and throws TypeError for a string"`.
- `"freeBytes returns a positive number for the temp volume"`.
- `"mkdirp applies its mode to the directories it creates (POSIX)"`.
- `"sameStat compares size, mtimeNs, ino, dev and mode"`.
- `"share-none lock: readFile, rename, unlink and link fail EBUSY with Node-identical errors until released"`.
- `"share-read lock: readFile passes, rename and unlink fail EPERM"`.
- `"setNoHardLinks: link fails EPERM and creates nothing"`.
- `"interpose runs its hook before the inner op, at most times times"`.
- `"calls records every op in call order"`.
- `"machineMonoMs is non-decreasing and within 5 ms of process.hrtime.bigint()"`.
- `"noTrace and nullLog accept everything and write nothing"`.
- `"fileLog appends one JSON line per write, in call order, never interleaved under 50 concurrent writes"`.
- `"alwaysLeased.idleMs() is 0; LEASE_STOP_SYNC_MS is 120,000 and LEASE_EXIT_MS 600,000"`.

**Crashpoints:** none. **Lint:** none (L-CLOCK keeps `process.hrtime` inside `src/ports/clock.ts` by review; `machineMonoMs` is its only reader).

---

### Task 2: Typed git layer

**Files:**
- Modify: `src/git/flags.ts`, `test/unit/flags.test.ts` (Plan 1 argv snapshots gain `--no-replace-objects`), `tools/lint/rules.ts`, `test/unit/lint.rules.test.ts`
- Create: `src/git/oid.ts`, `src/git/trailers.ts`, `src/git/repo.ts`, `src/git/merge.ts`, `test/helpers/repoFixture.ts`
- Test: `test/unit/oid.test.ts`, `test/unit/trailers.test.ts`, `test/integration/repo.test.ts`, `test/integration/merge.test.ts`

**Interfaces:**
- Consumes: Plan 1 `buildGitInvocation`, `GitCallOptions`, `GitIdentity`, `MERGE_FLAGS`, `GitRunner`, `GitResult`, `createGitRunner`, `testRunner`, `makeTempRoot`, `createBareRemote`, `clonePeer`, `seedRemote`.
- Produces: `GitCallOptions.gitDir`/`workTree`/`config`/`literalPathspecs`, `GLOBAL_PREFIX`; `Oid`, `ABSENT`, `Absent`, `OidOrAbsent`, `OidError`, `parseOid`, `isOid`, `oid12`; `Trailer`, `SKIP_SUBJECT_PREFIX`, `formatMessage`, `parseMessage`; `RepoPaths`, `RepoContext`, `GitCommandError`, `FileMode`, `TreeEntry`, `TreeMap`, `MktreeEntry`, `IndexEdit`, `CommitSpec`, `CommitInfo`, `RunOpts`, `GitRepo`; `MergeTreeResult`, `MergeFailedError`, `mergeTree`, `MergeFileOpts`, `MergeFileResult`, `mergeFile`; `RepoFixture`, `makeRepoFixture`.

**Spec:** glossary §18; ENG-08 (absolute paths, Buffers), ENG-09 (typed oids, `cat-file -e`), ENG-10 (four operations), ENG-12 (trailers, never signed), 01-engine §3.3 items 1–6; DAT-40 (MERGE_FLAGS, explicit base); SEC-03; Plan 1 ledger carry `--no-replace-objects`; rulings R-15, R-30.

**Tests:**
- `"--no-replace-objects is argv[0] for every class"` — before `--git-dir`, `--work-tree` and every `-c`.
- `"relative gitDir, workTree and indexFile throw before spawning"` — 01-engine test 2.
- `"config adds -c pairs after the forced list and refuses a forced key"`.
- `"literalPathspecs sets GIT_LITERAL_PATHSPECS=1"`.
- `"parseOid accepts 40 and 64 lowercase hex and rejects empty, short, uppercase and whitespace input"` — 01-engine test 3 (oid part).
- `"formatMessage and parseMessage round-trip; trailers come only from the last paragraph; a CR or LF inside a field throws"`.
- `"a refs/replace/* object changes nothing GitRepo reads"` — with a replace ref planted, `readBlob`, `readTreeMap`, `readTreeIntoIndex`, `mergeTree` and `firstParents` return the unreplaced objects (ledger carry).
- `"writeTreeMap and editTree give the same tree oid as git add of the same bytes"`.
- `"casRef moves the ref with a reflog entry; a moved ref returns false; a wrong prev never moves it"`.
- `"commitTree uses the context identity at +0000 and the virtual date in test builds, and is unsigned under a user commit.gpgSign=true"`.
- `"firstParents and firstParentCount follow first parents only; isAncestor is plain reachability (a second-parent ancestor counts); none runs merge-base"` — controller ruling P2-ANC.
- `"newestWithTrailer finds the newest commit carrying the trailer in one git call"`.
- `"smudgeBlobs runs a repo-relative filter driver with cwd = the repo root in one call"` — glossary §25 F12, ruling R-36.
- `"readTreeMap caches by oid"`.
- `"writeTree throws OidError when git prints nothing"` — runner wrapper returning exit 128 and empty stdout (ENG-09).
- `"mergeTree wraps base, ours and theirs in deterministic parentless commits"` — R-30: the wrapper commits have no parents and carry exactly the given trees, the merged tree is the expected clean merge (and rc 1 with the path listed on a same-line conflict), and no ref is written.
- `"mergeTree: same-line edits give rc 1 with the path listed; adjacent-line edits conflict; edits separated by one unchanged line merge cleanly"`.
- `"mergeTree rc > 1 throws MergeFailedError"`.
- `"MERGE_FLAGS hold against a user merge.renormalize=true: an i/crlf blob is not flipped"`.
- `"mergeFile --object-id with diff3, labels and marker size; an ABSENT side merges as the empty blob"`.
- `"L-GIT-FORBIDDEN fires on each forbidden argv and not on the allowed ones"`.
- `"L-FS-PORT fires on every fs load form outside src/ports/fs.ts"`.

**Crashpoints:** none. **Lint:** adds L-GIT-FORBIDDEN and L-FS-PORT (table in §Interfaces).

---

### Task 3: Data bytes — rows, canon, blob routes, conflict function

**Files:**
- Create: `src/data/rows.ts`, `src/data/linediff.ts`, `src/data/canon.ts`, `src/data/blobRoutes.ts`, `src/data/conflict.ts`
- Test: `test/unit/rows.test.ts`, `test/unit/linediff.test.ts`, `test/unit/canon.test.ts`, `test/integration/blobRoutes.test.ts`, `test/integration/conflict.test.ts`

**Interfaces:**
- Consumes: `GitRepo`, `Oid`, `ABSENT`, `OidOrAbsent`, `mergeFile`, `makeRepoFixture`, Plan 1 `generateBigBomCrlf`, `seededRandom`.
- Produces: `Eol`, `Form`, `BOM`, `rows`, `form`, `isBinaryBytes`, `stripEnding`, `conflictMarkerRows`, `hasRestoreMarkerRow`; `matchedRows`; `CanonResult`, `canon`; `FilterFailure`, `isFilterFailure`, `hashRouteB`, `hashRouteC`, `hashNewPath`; `Stage`, `UnitKind`, `ConflictCtx`, `ConflictVerdict`, `conflict`, `concatMarkerSize`.

**Spec:** 03-data §2 (rows, form, binary), §3.1 (byte discipline, routes, (2a)/(2b)), §3.2 (D1), §3.9 (D8 steps 0, 0a, 1–3, 5; D9); DAT-01…DAT-07, DAT-40…DAT-43, DAT-46; glossary §24 defaults 1 (as widened by §25.2 item 8), 2 and 3; ENG-41 (e) marker rows; rulings R-07, R-39.

**Tests:**
- `"rows and form follow 03-data §2"` — BOM in row 1, CR in its row, a non-empty unterminated last row, LF/CRLF/MIXED/NONE.
- `"isBinaryBytes looks at the first 8,000 bytes only"`.
- `"conflictMarkerRows strips one CR and matches exactly the four marker shapes; hasRestoreMarkerRow matches only cowork: labels"`.
- `"matchedRows equals a longest common subsequence of rows with endings ignored"` — fast-check against a quadratic oracle.
- `"canon is idempotent"` — fast-check over text, refs of every form.
- `"for LF, CRLF and NONE refs form(canon(x, ref)) == form(ref)"` — fast-check.
- `"canon never changes row content ignoring endings and BOM"` — fast-check; the tripwire never fires on valid input.
- `"MIXED ref: a changed ending on a matched row refuses eol-bom; a new row with either ending passes"`.
- `"binary, filtered and new paths come back unchanged"`.
- `"an LF-edited copy of the 1.3 MB BOM+CRLF fixture canonicalises to the CRLF edit byte for byte"`.
- `"route (b) of a stage copy equals the blob git add stores for the same bytes at p"` — autocrlf=true and autocrlf=false repos.
- `"a failing required clean filter gives FilterFailure and stores nothing"` — loose-object count unchanged.
- `"hashNewPath stores LF for a CRLF new file on autocrlf=true and autocrlf=false repos"` — DAT-07.
- `"route (c) with write=false writes no object"`.
- `"same-line edit gives TAKE_TIP with stages (A, LOCAL, TIP)"`.
- `"end-of-file appends to notes.md give CONCAT with TIP's block first and the D9 separator; tripwire legs (i) and (iii) hold"`.
- `"an already-concatenated unit gives CONCAT of TIP's entry with no record, and LOCAL rows outside the regions survive when the tripwire passes"` — D8 step 0a, 01-engine test 43 unit form.
- `"binary, add/add, modify/delete and rename units give TAKE_TIP"` — D8 step 5.
- `"a localOnly path gives DEFER(local_only_conflict)"`.
- `"no verdict ever carries a conflict-marker row absent from both sides"`.
- `"concatMarkerSize is max(32, longest run + 1)"`.

**Crashpoints:** none. **Lint:** none.

---

### Task 4: Scope classes, attributes, filters, team config, validators

**Files:**
- Create: `src/sec/validators.ts`, `src/data/attrs.ts`, `src/data/filters.ts`, `src/data/config.ts`, `src/data/scope.ts`
- Test: `test/unit/validators.test.ts`, `test/unit/scope.test.ts`, `test/unit/config.test.ts`, `test/integration/attrs.test.ts`, `test/integration/filters.test.ts`

**Interfaces:**
- Consumes: `GitRepo`, `Oid`, `FileMode`, `Fs`, `makeRepoFixture`.
- Produces: `validPathSyntax`, `IdKind`, `validId`, `validName`; `PathAttrs`, `AttrSnapshot`, `AttrCache`; `FilterSet`, `discoverFilters`; `TeamConfig`, `DEFAULT_INSERTION_MERGE`, `DEFAULT_TEAM_CONFIG`, `readTeamConfig`, `genesisBudget`; `ScopeClass`, `NotSharedReason`, `Scope`, `ScopeInputs`, `HUGE_BYTES`, `NEW_FILE_CAP`, `QUARANTINE_PATTERNS`, `TEMP_PATTERNS`, `SECRET_LIKE_PATTERNS`, `scopeOfTracked`, `admitNew`, `isQuarantined`, `PortRule`, `portable`, `wildmatch`.

**Spec:** 03-data §3.3, §3.4 (D3 only), §3.6 (D5, D6, configuration semantics), §3.7 (D7); DAT-13, DAT-15, DAT-23…DAT-34; glossary §16, §17, §27.2; SEC-35; ENG-51 (budget); rulings R-06, R-10, R-19.

**Tests:**
- `"validPathSyntax accepts repo-relative NFC paths and rejects '..', a leading '/', 'C:/x', 'a:b', 'a\\b', NUL, NFD and over 4,096 bytes"`.
- `"validId accepts op ids, ULIDs, cs ids and 128-bit hex and rejects near misses"`; `"validName"`.
- `"D5 row by row, first match wins"` — quarantine → invalid path (row 1a, UNMANAGED portability) → 160000/120000 → lfs → generated/cowork-sync=off → sync.exclude → .gitignore → merge driver → ≥ 50 MiB → LIVE.
- `"D6 order, first match wins"` — directory or `.claude/worktrees/` → temp → secret-like (exact `allowSecretLike` exempt) → quarantine/symlink → lfs/generated/exclude/include/.gitignore/merge driver → portability → > maxNewFileBytes.
- `"tracked-in-live paths are exempt from the 1 MiB new-file cap"`.
- `"D7 rules 1–4, including case-fold and NFC collisions with others and an allowed case-only rename"`.
- `"wildmatch: basename and path patterns, **, case-insensitive built-in lists"`.
- `"readTeamConfig: absent gives defaults; malformed JSON gives defaults and invalid; a mistyped field is ignored"`.
- `"genesisBudget: 6 → 6, 24 → 24, 7 → 7, absent → 12, 30 → 12, \"fast\" → 12, 7.5 → 12"` — ruling R-19.
- `"check-attr under attr.tree ignores a working-tree .gitattributes edit"` — TC-DAT-05 form.
- `"personal info/attributes still apply and invalidate the cache when they change"`.
- `"discoverFilters finds drivers named at EPOCH_BASE and in info/attributes; the fingerprint changes when a clean command changes"`.

**Crashpoints:** none. **Lint:** none.

---

### Task 5: Board format

**Files:**
- Create: `src/board/ids.ts`, `src/board/canonicalJson.ts`, `src/board/ops.ts`, `src/board/protocol.ts`, `src/board/boardCommit.ts`
- Test: `test/unit/ids.test.ts`, `test/unit/canonicalJson.test.ts`, `test/unit/ops.test.ts`, `test/unit/protocol.test.ts`, `test/integration/boardCommit.test.ts`

**Interfaces:**
- Consumes: `Random`, `randomHex`, `GitRepo`, `Oid`, `Trailer`, `formatMessage`, `parseMessage`, `CommitInfo`, `validPathSyntax`, `validId`, `makeRepoFixture`.
- Produces: `PeerId`, `EpochId`, `OpId`, `formatOpId`, `parseOpId`, `newPeerId`, `newEpoch`, `base32c`, `H`; `Json`, `canonicalJson`, `canonicalBytes`; `JoinOp`, `LeaveOp`, `CapsOp`, `SeatStartOp`, `SeatEndOp`, `EventOp`, `SaveOp`, `OpaqueOp`, `OpType`, `PLAN2_FOLDED_TYPES`, `ConfigFingerprint`, `TeamCaps`, `EventKind`, `Op`, `OpDraft`, `OPS_MAX_LINES`, `OPS_MAX_BYTES`, `OP_MAX_LINE_BYTES`, `REASON_CODE_RE`, `BoardCapError`, `serializeOps`, `parseOpLine`, `eventCid`; `ProtocolJson`, `PROTO`, `genesisProtocol`, `serializeProtocol`, `readProtocol`; `WriterId`, `CsTrailer`, `BOARD_SUBJECT`, `CODE_SUBJECT`, `STATE_SUBJECT`, `BoardCommitData`, `BoardDraft`, `readBoardCommit`, `BoardBuild`, `buildBoardCommit`, `liveCommitTrailers`, `boardTrailers`, `formatWriter`, `parseWriter`, `encodeCsPaths`, `decodeCsPaths`, `parseCsTrailers`, `LiveShape`, `boardShapeOk`, `liveShape`.

**Spec:** glossary §2, §3 (`H`), §5, §7; 02-protocol §3.1, §3.2 item 4; PRO-01…PRO-07, PRO-11; ENG-12; SEC-03; rulings R-15, R-19.

**Tests:**
- `"H matches the golden vectors"` — T-PRO-06 (Crockford base32 of SHA-256 over x ‖ 0x00 ‖ y, 8 chars).
- `"formatOpId and parseOpId round-trip and reject malformed ids"`.
- `"canonicalJson follows RFC 8785"` — key order by UTF-16 units, 1.5, 2.572, 1e21, escapes; a non-finite number throws.
- `"every glossary §7 op type parses and re-serializes byte-identically; unknown fields are ignored"`.
- `"malformed lines parse to null"` — bad JSON, a missing field, a reason_code outside the registry pattern, a path failing validPathSyntax.
- `"serializeOps refuses 1,001 ops, more than 64 KiB, or a line over 16 KiB"`.
- `"eventCid is H(op id, kind)"`.
- `"genesisProtocol bytes for budgets 6, 12, 24 and 7 are exactly the T-PRO-24 values on every OS"`.
- `"readProtocol reads a missing or malformed budget, G_s, S_s as 6, 10, 3 and a missing proto as 0"`.
- `"B0 has the single parent [L0], the PRO-01 subject and trailers, and a tree of exactly ops.jsonl, protocol.json, checkpoint/state.json"`.
- `"a later board commit has parents [prev, live], carries protocol.json and held/ by oid and replaces ops.jsonl"`.
- `"live commit trailers: skip-checks, Cowork-Proto, the Cowork-Writer shared with its board commit, Cowork-Seat: human, Cowork-CS, Cowork-CS-Paths only up to 256 paths, Cowork-Base on L0"`.
- `"author and committer are <display> <peer_id@cowork.invalid> at +0000 and the commits are unsigned"`.
- `"readBoardCommit reports writer null for a missing or malformed Cowork-Writer"`.
- `"boardShapeOk and liveShape accept the three live shapes and reject a last parent that jumps to a non-descendant"`.

**Crashpoints:** none. **Lint:** none.

---

### Task 6: The fold

**Files:**
- Create: `src/board/fold.ts`
- Test: `test/unit/fold.test.ts`, `test/unit/fold.prop.test.ts`, `test/integration/folder.test.ts`

**Interfaces:**
- Consumes: Task 5 board types, `canonicalJson`, `parseOpLine`, `GitRepo`, `readBoardCommit`.
- Produces: `PeerRec`, `FoldEvent`, `FoldState`, `OwnRejection`, `FoldStepResult`, `CHECKPOINT_EVERY`, `COMPACT_AGE`, `K_EVICT`, `REPLAY_MAX`, `initialFoldState`, `foldCommit`, `serializeFold`, `parseFold`, `liveSet`, `rankedSet`, `governorRank`, `recentThrottleEvent`, `VersionVerdict`, `FoldOutcome`, `Folder`.

**Spec:** 02-protocol §3.3, §3.4, §3.9; PRO-14…PRO-16, PRO-20, PRO-22, PRO-23, PRO-25…PRO-29, PRO-39, PRO-47, PRO-48; glossary §7 (fold), §24 default 9; rulings R-12, R-13.

**Tests:**
- `"generic validity for the Plan 2 types gives the exact no-op and own-rejection sets"` — T-PRO-01 subset: wrong writer, seq ≤ last_seq, out-of-order seq, inactive and retired epochs, unknown type, unknown field, a line over 16 KiB, line 1,001, ops over 64 KiB.
- `"[join(1), seat_start(2), event(3)] with writer seq 4 from a new epoch after last_seq 4,812 folds valid and sets last_seq 4"`.
- `"a join of a new epoch retires the old one; leave; a rejoin after leave"` — T-PRO-04 subset.
- `"claim, release, request, request_status, answer, note, presume_absent and hold fold as no-ops"` — ruling R-12.
- `"a conflict-kind event whose cid is folded is a no-op; a non-conflict event records op_id and height"` — PRO-22.
- `"last_height and last_seq advance even when every op of a commit is a no-op"` — step 5.
- `"random bytes, truncated JSON, deep nesting and huge numbers never throw, and a 1,000-op commit folds in ≤ 50 ms"` — T-PRO-11, fast-check.
- `"folds of one 600-commit board from genesis and from each checkpoint are byte-identical at every height, and no non-terminal record is compacted"` — T-PRO-10 subset.
- `"rankedSet drops ghosts after 200 heights; governorRank orders by (last_height, peer_id) with peers without commits first and gives 1 outside R"`.
- `"teamRegionSpec switches only when every peer of R announced the same value; a ghost does not block"` — T-PRO-30 subset.
- `"recentThrottleEvent sees a HOST_THROTTLED health event within the last 180 heights only"`.
- `"a joiner starts at the newest checkpoint at or below the tip and reads at most 255 commits"` — PRO-29.
- `"a corrupted incremental state is repaired by one refold; a wrong checkpoint that persists sets checkpointMismatch"` — PRO-28, ruling R-13.
- `"a protocol.json with proto 2 sets version.proto while folding continues"` — PRO-47.

**Crashpoints:** none. **Lint:** none.

---

### Task 7: Outbox and governor

**Files:**
- Create: `src/board/outbox.ts`, `src/board/governor.ts`
- Test: `test/unit/outbox.test.ts`, `test/unit/governor.test.ts`

**Interfaces:**
- Consumes: `Op`, `OpDraft`, `eventCid`, `serializeOps`, caps constants, `Clock`, `VirtualClock`.
- Produces: `PushState`, `SeqAllocator`, `PendingOp`, `Outbox`, `allowedInState`; `GovernorParams`, `GovernorMode`, `ThrottleSignal`, `NORMAL_LOCAL`, `FALLBACK_LOCAL`, `FALLBACK_MS`, `EVENT_SPACING_MS`, `G_CAP_MS`, `WINDOW_MS`, `SLOW_PUSH_MS`, `RESTART_EVENT_HEIGHTS`, `NET_BACKOFF_MIN_MS`, `NET_BACKOFF_MAX_MS`, `AttemptEnd`, `Governor`.

**Spec:** 02-protocol §3.2 step 2, §3.8; PRO-08, PRO-09, PRO-38…PRO-46, PRO-54 (counter input), PRO-55; glossary §20 governor row as revised by §27.2; ENG-44 (§3.6 backoff), ENG-46; rulings R-17, R-18, R-20, R-21.

**Tests:**
- `"intent [c(10), r(11)] writer 12 loses, intent [r(11)] writer 13 lands, and c is renumbered above 13"` — T-PRO-07.
- `"renumberAtOrBelow renumbers ops at or below the folded last_seq, order kept"`.
- `"every op type in every PushState follows the 02-protocol §3.8 table; the most restrictive row wins"` — T-PRO-23 unit form.
- `"event drafts get cid = H(id, kind) at allocation and again after renumbering"`.
- `"take keeps within 1,000 ops and 64 KiB, oldest seq first"`.
- `"toJson and fromJson round-trip allocated ids"`.
- `"the window opens at G_eff + (rank − 1)·S_eff after the anchor; the anchor moves only on a tip change or the own ok"`.
- `"no 13th attempt within 60 s at B = 12"` — per-peer cap.
- `"12 observed landings within 40 s block every attempt until the oldest is 60 s old, then exactly one; aging never bypasses it; in fallback it stops at 6"` — T-PRO-24.
- `"two pre-emptions age a peer to rank 1 at G_base"`.
- `"k rises on > 10 s, killed, status-less and transient attempts, falls by one otherwise, and G_eff never exceeds 60 s"` — PRO-44.
- `"after a transient the next window waits for the stricter of G_eff and the 30 s doubling backoff"` — ruling R-20.
- `"each throttle signal switches to B 6, G 10 s, S 3 s for the next decision and back after 30 min; a second signal restarts the timer"` — PRO-55.
- `"postEvent only for a push signal or a fetch with pending work, at most once per 15 min; a follower never posts"` — ruling R-18.
- `"a budget-3 board gives B_eff 3; a missing G_s reads 10"` — stricter-of.
- `"restore(meta.throttle) restarts the own fallback for 30 min"` — ruling R-17.
- `"±600 s wall offsets and a 2 h suspend give identical decisions"` — Δmono only.
- `"exempt skips the window and the spacing but never the cap or the guard"` — ruling R-21.

**Crashpoints:** none. **Lint:** none.

---

### Task 8: Refs, meta, the state ref, engine deps

**Files:**
- Create: `src/engine/refs.ts`, `src/engine/meta.ts`, `src/engine/state.ts`, `src/engine/deps.ts`
- Test: `test/unit/refs.test.ts`, `test/unit/meta.test.ts`, `test/unit/deps.test.ts`, `test/integration/state.test.ts`

**Interfaces:**
- Consumes: `enc`, `EncTooLongError`, `GitRepo`, `Oid`, `oid12`, `FetchSpec` (type from Task 12's `src/git/fetch.ts` — this task creates the type-only declaration `export interface FetchSpec { remote: string; local: string; }` in `src/git/fetch.ts`; Task 12 adds the functions), `canonicalJson`, `FoldState`, `serializeFold`, `parseFold`, `ReadyPair`, `readyKey` (type and function from `src/holds/changesets.ts`: this task creates `readyKey` and the `ReadyPair` interface there; Task 11 adds `ChangeSets`), `DeferReason` (type from `src/holds/groups.ts`, created here as a type-only declaration; Task 11 adds `writeGroups`), `ThrottleSignal`, `Ports`, `Trace`, `Log`, `LeasePort`, `RepoPaths`.
- Produces: the type-only seeds `FetchSpec` (in `src/git/fetch.ts`), `DeferReason` (in `src/holds/groups.ts`), `ReadyPair` and `readyKey` (in `src/holds/changesets.ts`); `RefNamespace`, `RELEASE_NAMESPACE`, `testNamespace`, `RefNames`, `refNames`; `FreezeReason`, `ConfigDetail`, `Meta`, `MetaTooNewError`, `parseMeta`, `serializeMeta`; `ApplyIntentEntry`, `Intent`, `JournalTree`, `StateView`, `Transition`, `StateCasLostError`, `LostStateError`, `StateStore`; `MutantId`, `AttributionPort`, `humanOnlyAttribution`, `regionSpecId`, `PLAN2_REGION_SPEC`, `EngineDeps`.

**Spec:** glossary §4, §6; 01-engine §3.2; ENG-02…ENG-05, ENG-07; PRO-25; LIF-37 (`meta.v`); INV-ENG-REACH, INV-ENG-STATE; rulings R-14, R-15, R-25, R-29.

**Tests:**
- `"refNames for main, feature/x, a Korean branch and a test namespace; over 150 bytes throws EncTooLongError"`.
- `"fetchSpecs are exactly the three glossary §4 refspecs"`.
- `"parseMeta and serializeMeta round-trip byte-stably with every 01-engine §3.2 field and no timestamp"`.
- `"meta.v 2 throws MetaTooNewError"`.
- `"the state commit has parents [LA_C, LA_B] and a tree of exactly base, snap, meta, journal/{intent.json, t/, ready/<k>/{R,A}, keep/}"`.
- `"every intent kind round-trips and every referenced tree is a subtree of the state commit"` — 01-engine test 6.
- `"after git gc --prune=now every object named by the state commit still exists"` — O-REACH.
- `"a second writer's CAS throws StateCasLostError and leaves the ref unchanged"` — ENG-03.
- `"each transition adds one reflog entry to the state ref"`.
- `"a missing ref reads null; a missing named object throws LostStateError"`.
- `"readyKey is base64url without padding"`.
- `"the fold state survives in journal/keep/fold/state.json with meta.fold_board"`.
- `"PLAN2_REGION_SPEC is regionSpecId of the three Plan 2 parts, lowercase hex"`.
- `"humanOnlyAttribution: removal false, shrink true"` — ruling R-25.

**Crashpoints:** none. **Lint:** none.

---

### Task 9: Staged reads, stat cache, snapshot, DISK_EQ

**Files:**
- Create: `src/engine/stagedRead.ts`, `src/engine/statCache.ts`, `src/engine/snapshot.ts`, `src/engine/diskEq.ts`
- Modify: `tools/lint/rules.ts`, `test/unit/lint.rules.test.ts`
- Test: `test/unit/stagedRead.test.ts`, `test/integration/snapshot.test.ts`, `test/integration/diskEq.test.ts`, `test/integration/noobjects.test.ts`

**Interfaces:**
- Consumes: `Fs`, `FsLstat`, `sameStat`, `FaultFs`, `Clock`, `GitRepo`, `TreeMap`, `TreeEntry`, `FileMode`, `IndexEdit`, `hashRouteB`, `hashRouteC`, `hashNewPath`, `isFilterFailure`, `canon`, `ScopeInputs`, `scopeOfTracked`, `admitNew`, `NotSharedReason`, `AttributionPort`, `validPathSyntax`, `MutantId`, `Trace`, `crashpoint`.
- Produces: `ReadOutcome`, `stagedRead`, `StageDir`; `StatEntry`, `StatCache`; `QUIET_MS`, `DELETE_CONFIRM_MS`, `SHRINK_RATIO`, `Exclusion`, `DirtyEntry`, `SnapshotDeps`, `TickInput`, `TickResult`, `Materialized`, `Snapshotter`; `DiskEqResult`, `DiskEqDeps`, `DiskEq`.

**Spec:** glossary §26.1 W1–W3, W6, §26.2 item 3; 01-engine §2 (staged read, stat cache, detection tick, materialize), §3.3 (DISK_EQ, items 7–8), §3.8; ENG-04, ENG-08, ENG-11, ENG-23…ENG-27; DAT-01, DAT-05, DAT-07, DAT-24; INV-ENG-NOREAD; O-STAGED; mutant M18; rulings R-07, R-10, R-25, R-38.

**Tests:**
- `"a stable file reads ok with its bytes and the second stat"`.
- `"a change between the two lstats triggers one re-read, then unstable if it changes again"`.
- `"EBUSY, EPERM and EACCES read as unreadable and ENOENT as missing"`.
- `"an in-place truncation interposed between lstat and read never yields a 0-byte ok with a stale stat"` — Review Focus 1.
- `"StageDir refuses a path failing validPathSyntax and never follows a symlinked component"`.
- `"a tick on an unchanged tree reads no file and spawns no git"`.
- `"an edit is detected by id at the tick and its blob is written only at materialize"`.
- `"the quiet period skips an mtime under 300 ms old; a future mtime needs 300 ms Δmono of unchanged stat"`.
- `"a deletion is staged only after two reads at least 1 s apart"`.
- `"an atomic save (temp file + rename over) between two ticks never stages a removal"` — Review Focus 1.
- `"a shrink over 50 % or to 0 bytes needs two ticks at least 1 s apart with the same stat"` — ruling R-25.
- `"a share-none lock makes the path unreadable before any git call; after unlock it is detected next tick"` — 01-engine test 8 form.
- `"a failing required clean filter excludes the path, blocks publishing for the loop and stores no plaintext object"` — 01-engine test 9 form, counting filter fixture.
- `"new files go through admitNew: a .swp and a .env are NOT_ADMITTED, an ordinary file is dirty new"`.
- `"a CRLF rewrite of an LF-stored file on an autocrlf=false repo gives S_disk == A while S_raw differs"`.
- `"a MIXED ref with a changed ending lands in canonRefused"`.
- `"160000 and 120000 entries are forced to A at materialize"`.
- `"crashpoint('snapshot.index_written') fires after the private index update and before write-tree"`.
- `"reseed empties the stat cache so the next tick stage-reads every tracked path"`.
- `"20 virtual minutes of saves of the 1.3 MB file every 2.5 s without a materialize leave the loose-object count and bytes unchanged; one materialize adds exactly the dirty blobs"` — 01-engine test 47.
- `"a DISK_EQ refresh comparison writes no object"`.
- `"over 1,000 ticks and 50 DISK_EQ calls no git argv names a working file"` — 01-engine test 45 (SIM form): every content command names `tmp/stage` or stdin (runner argv + `FaultFs.calls`).
- `"DISK_EQ on an i/crlf BOM+CRLF file under core.autocrlf=true is equal across 200 rewrites; mutant M18 reports not equal"` — 01-engine test 1.
- `"a filtered path compares a route (b) id with a route (b) id"`.
- `"manyCandidates picks the newest matching candidate, matches ABSENT to ENOENT and writes the raw blob only then"`.
- `"eqFile compares a .old file as if it were at p"`.
- `"L-OBJ-WRITE fires on hash-object and add argv outside the allowed files"`.

**Crashpoints:** `snapshot.index_written` (11-testing §3.6: 01-engine §3.8 after steps 4–7 updated the private index, before step 8). **Lint:** adds L-OBJ-WRITE.

---

### Task 10: Two-phase verifying writer

**Files:**
- Create: `src/engine/writer.ts`
- Test: `test/integration/writer.test.ts`, `test/integration/writer.windows.test.ts` (skips off Windows)

**Interfaces:**
- Consumes: `Fs` (lstat, rename, link, writeFileExclusive, rmdir, unlink, freeBytes), `FaultFs`, `GitRepo.smudgeBlobs`, `editIndex`, `DiskEq`, `StatCache`, `StageDir`, `Snapshotter.markClean`, `Intent`, `DeferReason`, `Scheduler.yieldPoint`, `crashpoint`.
- Produces: `RING_KEEP_MS`, `MAX_REMERGE`, `PATH_BUSY_WAIT_MS`, `WriteKind`, `WriteEntry`, `WriteGroup`, `Remerge`, `GroupResult`, `WriteLocalResult`, `WriterDeps`, `RollbackReport`, `Writer`.

**Spec:** glossary §26.1 W4, §26.2 item 7; 01-engine §3.11 (writer protocol, ROLLBACK, round trip, ring, writeLocal), ENG-31…ENG-35, ENG-37, ENG-38; INV-GROUP, INV-NOLOSS (ring scope); O-STAGED (writer part); ruling R-36.

**Tests:**
- `"a 3-path group is written all or none: a share-read lock on one path defers the group as locked, writes nothing and links every .old back"` — 01-engine test 11 form, Review Focus 1.
- `"P0 smudges a whole group in one cat-file --batch --filters call"` — ruling R-36.
- `"a create into an existing file defers race and leaves the local bytes untouched"`.
- `"a write interposed between P1 and P2 is re-merged up to 3 times or defers mismatch, and the human bytes survive on disk or in the merge"` — 01-engine test 12, SIM form.
- `"rollback restores the exact .old bytes, also for an already linked path"`.
- `"no rename onto an existing target is ever issued"` — `FaultFs.calls`.
- `"with setNoHardLinks the copy fallback creates exclusively and rolls back by exclusive create from .old"` — 01-engine test 50 form.
- `"a written path that cannot round-trip calls onPhantom and is reported"` — ENG-34.
- `"a write into a .old within 2 s reaches onLateWrite with the late bytes, then the .old is deleted"` — ENG-35.
- `"writeLocal returns WRITTEN, MISMATCH, LOCKED, COLLISION, FROZEN, DEFERRED and PHANTOM as ENG-37 says and never changes A"`.
- `"pathState waits up to 250 ms for an in-flight group, then answers busy"` — ENG-38.
- `"a kill at each of apply.group.phase1, apply.group.mid, apply.group.phase2 and apply.between_groups leaves files that rollbackIntent restores"`.
- `"a share-all reader holding the target does not stop the two-phase write"` — Windows only, glossary §26.1 W4.

**Crashpoints:** `apply.group.phase1` (end of P1, before P2), `apply.group.mid` (inside P2, after one path is linked and before the next), `apply.group.phase2` (after P2 and RT of a group, before the next group or step C), `apply.between_groups` (between two iterations of the group loop). **Lint:** none.

---

### Task 11: Minimal holds — records, registry, MASK, write groups, human change-set

**Files:**
- Create: `src/holds/record.ts`, `src/holds/registry.ts`, `src/holds/mask.ts`
- Modify: `src/holds/groups.ts` (adds `IncomingCs`, `WriteGroupsResult`, `writeGroups` to the type created in Task 8), `src/holds/changesets.ts` (adds `ChangeSets`, `RebaseChange`, `RebaseResult`, `ReadyBaseMismatchError`, `HUMAN_CS_QUIET_MS` next to Task 8's `ReadyPair` and `readyKey`)
- Test: `test/unit/record.test.ts`, `test/unit/mask.test.ts`, `test/unit/groups.test.ts`, `test/integration/registry.test.ts`, `test/integration/changesets.test.ts`

**Interfaces:**
- Consumes: `GitRepo`, `TreeMap`, `TreeEntry`, `Oid`, `OidOrAbsent`, `mergeFile`, `Random`, `ulid`, `Clock`, `Trace`, `Log`, `ScopeClass`, `canonicalJson`, `crashpoint`.
- Produces: `HoldKind`, `Residence`, `HoldState`, `Offer`, `BlobMap`, `HoldBlobs`, `Guard`, `AgeAnchor`, `HoldRecord`, `Plan2Guard`, `PLAN2_GUARD_CLASS`, `WHOLE_PATH_GUARDS`, `TERMINAL_STATES`, `isTerminal`, `heldSide`, `serializeRecord`, `parseRecord`; `NewRecord`, `RegistryDeps`, `RegistryCasLostError`, `HoldRegistry`; `MaskInputs`, `MaskReason`, `maskEntries`, `maskReason`; `IncomingCs`, `WriteGroupsResult`, `writeGroups`; `HUMAN_CS_QUIET_MS`, `RebaseChange`, `RebaseResult`, `ReadyBaseMismatchError`, `ChangeSets`.

**Spec:** glossary §3 (ready pair, P, publication group, MASK), §9; 05-holds §3.2, §3.4 item 2, Table 3 (classes of the Plan 2 guards); HLD-01…HLD-05, HLD-33, HLD-35…HLD-38, HLD-40…HLD-42, HLD-53; INV-GROUP shape; mutant M20; rulings R-01…R-05.

**Tests:**
- `"records round-trip the glossary §9 schema; ABSENT sides serialize as \"ABSENT\""`.
- `"PLAN2_GUARD_CLASS matches 05-holds Table 3"`.
- `"hold() writes one commit with records/<id>.json and blobs/<oid>, CAS with a reflog, and hits crashpoint registry.cas before and after the CAS"`.
- `"hold() with the same kind, guard, paths and held side returns the existing id"`.
- `"transition bumps rev and keeps the history on the chain"`.
- `"load() re-attaches; a second writer throws RegistryCasLostError"`.
- `"every referenced blob survives git gc --prune=now"`.
- `"MASK steps 1–4 apply in order and OFF_DISK records mask nothing"` — path classes, local_only or whole-path guard, ON_DISK PIN with guards, ON_DISK CONFLICTED (ruling R-02).
- `"an ON_DISK ACTIVE PATCH with guards masks its whole path"` — ruling R-04.
- `"a masked path that A lacks is absent from the result"`.
- `"write groups are connected components over shared paths; a deferred path defers its group with closure for the rest; other groups are unaffected"`.
- `"a path of W in no incoming CS is a singleton group"`.
- `"the human CS opens at the first change and closes 20 s Δmono after the last change on any of its paths; done() closes it at the next iteration"`.
- `"capture writes sparse R and A trees of the CS paths with cs_id <peer>/human/<n> and n increments"`.
- `"composeP takes the newest ready pair covering each path, A elsewhere, and applies MASK at compose time"`.
- `"composeP throws ReadyBaseMismatchError when A_cap ≠ A"` — the mutant M20 shape.
- `"composeP skips a ready pair sharing a path with an ON_DISK PIN and keeps it journaled"` — a `join` PIN on `a.txt` and a ready human CS over `a.txt` and `b.txt`: P equals A on both paths, `csIds` is empty, `ready()` still lists the pair (01-engine §3.12 step 1, ruling P2-PIN).
- `"rebase merges R[p] := merge-file(A_new, A_cap, R) when it is clean"`.
- `"a rebase conflict follows HLD-41's split"` — clean or concat write with `S_disk == R` keeps the pair ready with `R := written`; a later file effect withdraws the whole capture; `take_tip` cancels with `CS_READY_CANCELLED` and schedules a recapture; A changed without a write cancels the same way.

**Crashpoints:** `registry.cas` (05-holds HLD-01: immediately before and immediately after the CAS `update-ref` of `refs/cowork-local/<enc(b)>/holds`; two call sites, one name). **Lint:** none.

---

### Task 12: Fetch, push, classification, incident check

**Files:**
- Create: `src/git/push.ts`, `src/git/httpStatus.ts`, `src/engine/fetcher.ts`, `src/engine/incident.ts`, `src/engine/pushResult.ts`
- Modify: `src/git/fetch.ts` (adds `FetchResult`, `fetchRefs`, `lsRemote` to Task 8's `FetchSpec`), `tools/lint/rules.ts`, `test/unit/lint.rules.test.ts`
- Test: `test/unit/push.test.ts`, `test/unit/httpStatus.test.ts`, `test/unit/pushResult.test.ts`, `test/unit/fetcher.test.ts`, `test/integration/pushfetch.test.ts`, `test/integration/incident.test.ts`

**Interfaces:**
- Consumes: `GitRepo`, `Oid`, `parseOid`, `OidOrAbsent`, `classifyPush`, `NONRETRYABLE_STREAK`, `RefNames`, `Clock`, `Trace`, `readBoardCommit`, `boardShapeOk`, `liveShape`, `MutantId`, `createBareRemote` (`rejectNext`, `readRefTxLog`).
- Produces: `PushRefStatus`, `PushSpec`, `PushOutcomeRaw`, `pushSpec`, `buildPushArgv`, `parsePorcelain`, `runPush`, `deleteProbeRef`; `FetchResult`, `fetchRefs`, `lsRemote`; `HttpThrottle`, `readHttpThrottle`; `FETCH_SPACING_MS`, `OFFLINE_AFTER_MS`, `FetchView`, `FetchImpl`, `Fetcher`; `fpOk`, `IncidentWhy`, `IncidentVerdict`, `incidentCheck`, `liveBase`; `PublishOutcome`, `PublishObservation`, `classifyPublish`.

**Spec:** glossary §4 (fetch refspecs), §18, §25 F9–F11, §26.2 items 1–2; ENG-09, ENG-13, ENG-18…ENG-20, ENG-43, ENG-44; PRO-12, PRO-13, PRO-54; INV-OID, INV-FIRSTPARENT, INV-ENG-AUTH; mutants M07, M34 shape, M35 shape.

**Tests:**
- `"pushSpec refuses an empty or invalid oid, a ref without refs/, a '+' and a ':'"` — 01-engine test 3 (push part).
- `"buildPushArgv never contains --atomic, --force or a '+' refspec and renders an ABSENT lease as an empty expect"`.
- `"parsePorcelain maps '!', ' ', '*', '+', '=' and a missing line"`.
- `"readHttpThrottle finds 429 and 5xx in git's transport messages and nothing else"`.
- `"classifyPublish: landed over lease_lost over transient; nonretryable at the third; status none with the board unchanged is network with the streak unchanged"`.
- `"spreading rejection text onto the observation changes nothing"`.
- `"a 7 s fetch starts no second fetch; a request during it awaits it; the next starts right after it ends"` — 01-engine test 48 (injected FetchImpl, VirtualClock).
- `"fetch starts are at least 2.5 s apart"`.
- `"offline after 30 s Δmono; backoff 30 s, 60 s, … 300 s; a success resets it"`.
- `"abandon() forces the next fetch"`.
- `"runPush to a file:// remote reports ok, a stale-lease rejection and a pre-receive rejection per ref"`.
- `"deleteProbeRef deletes only the allowed probe ref and throws before spawning for any other"` — INV-OID.
- `"fetchRefs with the mirror missing falls back to ls-remote, fetches the board and reports code ABSENT"`.
- `"fetchRefs with the board missing reports board ABSENT and fetches the branch"`.
- `"fetch writes no FETCH_HEAD and no refs/remotes/*, and the fetched local refs get reflog entries"`.
- `"fpOk: equal and fast-forward pass; a rewind, a rewrite keeping the old chain as second parent and an unrelated root fail"`.
- `"incidentCheck reports board_missing, board_not_ff, code_not_ff, board_shape and a last parent that jumps"`.
- `"a corrupted mirror changes no verdict; the mirror and displaced refs are never read"` — 01-engine test 19 (check part).
- `"liveBase finds the genesis Cowork-Base on a 300-commit chain in one git call"`.
- `"mutant M07 makes incidentCheck always ok"`.
- `"L-PUSH-ARGV, L-CLASSIFY-TEXT and L-MIRROR fire on planted sources and not on the real files"`.

**Crashpoints:** none. **Lint:** adds L-PUSH-ARGV, L-CLASSIFY-TEXT, L-MIRROR.

---

### Task 13: Engine core, iteration preparation, apply

**Files:**
- Create: `src/engine/core.ts`, `src/engine/apply.ts`, `test/sim/traceRecorder.ts`, `test/helpers/coreFixture.ts`
- Test: `test/integration/apply.test.ts`, `test/integration/apply.bomcrlf.test.ts`

**Interfaces:**
- Consumes: everything Tasks 1–12 produce.
- Produces: `ScratchName`, `EngineCore`, `IterationCtx`, `PrepareOptions`, `Prepared`, `prepareIteration`, `createEngineCore`; `APPLY_COALESCE_MS`, `FREE_SPACE_MARGIN_BYTES`, `ApplyReport`, `applyNeeded`, `applyStep`; `TraceRecorder`; `PeerFixture`, `CoreFixture` (with `bootstrap`, `pushTeamChange`), `makeCores`.

**Spec:** 01-engine §3.5 steps 1–3 (as `prepareIteration`), §3.10 (apply side, rename carry, record before displace), §3.11; ENG-06, ENG-14, ENG-29, ENG-30…ENG-36; INV-ENG-PROGRESS; HLD-41, HLD-53; DAT-29, DAT-33 (receive side), DAT-41…DAT-43; mutant M17; rulings R-02, R-05.

**Tests:**
- `"applyNeeded is any A[p] ≠ TIP[p] over applicable paths; mutant M17 misses a pending path"` — 01-engine test 16.
- `"a path deferred by a share-read lock is applied at the next permitted apply after unlock, even with TIP == LA_C"` — INV-ENG-PROGRESS.
- `"at most one apply per 10 s Δmono"`.
- `"free space below 2 × bytes + 256 MB defers the whole apply as disk_low"` — injected `freeBytes`.
- `"200 one-line teammate changes to the 1.3 MB BOM+CRLF fixture on an autocrlf=true peer give 0 mismatch deferrals and 0 phantoms"` — 01-engine test 1 / TC-ENG-08, Review Focus 2.
- `"an ignored local .env stays byte-identical as a collision while src/a.ts of the same CS applies"` — 01-engine test 13.
- `"con.py and a:b.txt are unmaterializable on platform win32 while the rest of their group applies"` — 01-engine test 14 form.
- `"an apply-side K4 commits its conflict record before the writer renames p; afterwards the record is OFF_DISK and A[p] = TIP[p]"` — ruling R-02.
- `"apply first: TIP renamed p.py to p2.py and edited line 3 while the local side edited line 25 — disk gets TIP's p2.py and no p.py, and one K4 record holding the local p.py exists before the delete"` — 01-engine test 34 (a).
- `"a same-position append to notes.md is written as the D9 concat with no record"`.
- `"UNMANAGED paths follow TIP without a write; SAVE_ONLY paths are written like LIVE"`.
- `"one ENG-36 state update sets A, LA_C := TIP, LA_B := T, snap, pending and the rebased ready pairs"` — 01-engine test 38 (a)(b); trace `A_set` causes `write_verified` and `unmanaged_follow`.
- `"crashpoint('apply.intent') fires after the intent is journaled and before any .new; crashpoint('apply.state') after the state update"`.
- `"prepareIteration fetches, checks, folds and ticks, and materializes only when asked"`.

**Crashpoints:** `apply.intent` (01-engine §3.11 after step J, before P0 of the first group), `apply.state` (after the step C state update, before the in-memory A cache and the provenance journal are updated). **Lint:** none.

**Notes:** `prepareIteration` is 01-engine §3.5 steps 1–3 only (fetch with the ls-remote fallback, incident check, fold and VERSION verdict, detection tick, optional materialize); it returns `{ok: false, why: 'incident', verdict}` without entering the incident (Task 16) and is shared by `Engine.iterate`, `startDispatch` and the tests. `CoreFixture.bootstrap()` is the test-only stand-in for genesis and join until Task 15 (it builds L0 and B0 with the Task 5 builders, pushes them with ABSENT leases and creates each peer's state with `A = tree(HEAD)`); `pushTeamChange(changes, {csId})` lands a teammate live commit and board commit from a synthetic writer with real `Cowork-CS`/`Cowork-CS-Paths` trailers.

---

### Task 14: Publish

**Files:**
- Create: `src/engine/assertions.ts`, `src/engine/publish.ts`
- Test: `test/unit/assertions.test.ts`, `test/integration/publish.test.ts`, `test/integration/publish.race.test.ts`, `test/integration/publish.rejections.test.ts`

**Interfaces:**
- Consumes: Tasks 1–13 (notably `ChangeSets.composeP`, `maskEntries`, `mergeTree`, `conflict`, `buildBoardCommit`, `liveCommitTrailers`, `Outbox.take`, `Governor`, `governorRank`, `runPush`, `pushSpec`, `classifyPublish`, `readHttpThrottle`, `HoldRegistry.hold`, `Fetcher`, `makeCores`).
- Produces: `AssertLetter`, `PrePushInput`, `prePushAsserts`; `PublishReport`, `publishPending`, `publishStep`, `AttemptClass`, `GovernedBody`, `governedPush`, `applyPushOk`.

**Spec:** 01-engine §3.12; ENG-39…ENG-46; PRO-09, PRO-12, PRO-40…PRO-45, PRO-54, PRO-55; HLD-42; glossary §24 default 3, §26.2 items 1–2, §27.2; INV-PUSHED-IS-MERGE, INV-FF; tests 01-engine 17, 27, 34 (b), 43, 58 (subset), T-PRO-21, T-PRO-25, T-PRO-26 (1), (2), (7); mutants M06, M12; rulings R-02, R-06 (ENG-41 (f) out), R-16…R-21.

**Tests:**
- `"each ENG-41 letter fails on its planted violation and passes on a clean input"` — (a) wrong first parent, (b) a path outside `diff(A, P)`, (c) OUT ≠ TIP where P == A, (d) an empty OUT over a non-empty TIP, (e) a new conflict-marker row, (g) a changed 160000 entry, (h) a changed quarantined path, (i) a masked path differing from A in P, (j) an added `held/` entry.
- `"a human CS publishes after 20 s quiet: C = commit-tree OUT -p TIP with Cowork-CS state=closed origin=human checks=skipped and Cowork-CS-Paths; Bnew parents [T, C]; the mirror refspec only when the fetched mirror is ABSENT or an ancestor of TIP"` — ENG-43.
- `"with P == A and no allowed ops no push is spawned"` — PRO-42.
- `"a board-only publish carries ops only and repeats TIP as its last parent"`.
- `"the ok update sets LA_C := C, LA_B := Bnew and A[p] := C[p] only where C[p] == P[p]; a K4 path keeps its A"` — ENG-44, ruling R-02.
- `"a publish-side K4 commits an ON_DISK CONFLICTED record before the push, publishes TIP[p] and the CS's other paths, never republishes LOCAL from a later capture, and the next apply moves the record OFF_DISK"` — ruling R-02, glossary §24 default 3.
- `"publish first: OUT keeps p2.py == TIP[p2.py] with the same K4 record and ENG-41 (b) passes"` — 01-engine test 34 (b).
- `"after a publish-side concat the publisher's next apply takes TIP's entry with no record"` — 01-engine test 43.
- `"commit-tree exiting 128 with empty stdout spawns no push and leaves the remote unchanged"` — 01-engine test 27.
- `"mutant M06 (S_disk pushed as OUT) is stopped by assert (b) or (c) before any push"`.
- `"the publish trace event carries aTree, pTree, tip, outTree, c, bnew, conflicted and replaced"`.
- `"the push intent with t/P and seq_next is journaled before the push; publish.out_built fires before the spawn, publish.sent after the push returns, publish.landed before the ok update"`.
- `"two peers interleaved at publish.beforePush: one lands, the other classifies lease_lost, re-merges in its next window and lands"` — Review Focus 4; the governor anchor moved, no immediate retry.
- `"the same race with one line edited on both sides leaves one K4 record on the loser and publishes its other paths"` — Review Focus 4.
- `"rejection texts cannot lock ref, (stale info), (failed) and empty give identical decisions"` — glossary §25 F9, F11.
- `"a cannot-lock rejection after another push landed is a lease loss with streak 0"` — 01-engine test 17 (a).
- `"rejections with the board unchanged give transient, transient, then NONRETRYABLE exactly at the third: one host-reject PIN, no further attempt, meta.nonretryable, host text only in the log"` — 01-engine test 17 (b)(c).
- `"a push the server accepted while the client was killed is landed by writer id; nothing is published twice; A and LA_C are correct"` — 01-engine test 17 (d), runner wrapper reporting exit −1.
- `"a transport failure without a porcelain line is network and leaves the streak unchanged"` — 01-engine test 17 (e).
- `"one (failed) rejection then acceptance lands and resets the streak"` — 01-engine test 17 (f).
- `"mutant M12 (classify by text) changes a decision and fails"` — 01-engine test 17 (g).
- `"the second attempt after a transient waits for the stricter of k and the 30 s backoff"` — ruling R-20.
- `"a push slower than 10 s enters the fallback for the next window decision, queues one HOST_THROTTLED event and sets meta.throttle"` — runner wrapper on the virtual clock; 01-engine test 58 subset.
- `"a 429 on a push does the same; a 429 on a fetch with nothing pending enters the fallback and queues no event"` — rulings R-16, R-18.
- `"a rejection streak of 2 enters the fallback; the 429 text never changes a classification"`.

**Crashpoints:** `publish.out_built` (01-engine §3.12 after steps 6–7, before step 8), `publish.sent` (after `git push` is spawned — in this runner, right after it returns — and before ENG-44 classifies it: the first statement of publishStep's `classify` callback to `governedPush`, before its fresh fetch), `publish.landed` (after a board line `ok`, before ENG-44's ok state update). **Lint:** none.

---

### Task 15: Start (genesis with the host probe, join), restart, lost state

**Files:**
- Create: `src/engine/start.ts`, `src/engine/restart.ts`
- Test: `test/integration/start.test.ts`, `test/integration/probe.test.ts`, `test/integration/restart.test.ts`, `test/integration/loststate.test.ts`

**Interfaces:**
- Consumes: Tasks 1–14 (`prepareIteration`, `applyStep`, `publishStep`, `applyPushOk`, `governedPush` with `GovernedBody` (the probe's step-5 `deleteProbe`) and `AttemptClass`, `Writer.rollbackIntent`, `DiskEq.manyCandidates`, `liveBase`, `genesisProtocol`, `genesisBudget`, `readTeamConfig`, `Folder`, `makeCores`, `setCrashHandler`, `KilledAt`).
- Produces: `StartMode`, `StartOptions`, `StartRefusal`, `StartResult`, `startDispatch`, `runProbe`, `genesis`, `join`; `LOST_STATE_MAX_COMMITS`, `LostStateReport`, `RestartReport`, `restart`, `lostStateRebuild`.

**Spec:** 01-engine §3.14; ENG-51…ENG-54, ENG-59 (`join.first_apply`); PRO-07, PRO-29, PRO-49, PRO-50 (refusal codes); 08-lifecycle Table 3.3-A, §3.3.2, §3.3.3; LIF-06…LIF-08 subsets; tests 01-engine 21, 22, 26, 36 (part), 38 (c), 44, 57 (part), T-PRO-32 (subset), T-PRO-41; rulings R-08, R-19, R-21…R-24.

**Tests:**
- `"genesis builds L0 = tree(Hr) with no parents and Cowork-Base, B0 with [join, caps], pushes both in one push with ABSENT leases and creates state [L0, B0] with A = tree(L0), EPOCH_BASE = Hr, H_adopt = HEAD"`.
- `"host.pushBudgetPerMin 6, 24, absent and 30 seed budget 6, 24, 12 and 12; a config change after genesis changes nothing"` — 01-engine test 57 part, ruling R-19.
- `"two peers starting together (interleaved at start.beforeGenesisPush) make one genesis; the other refetches and joins"` — 01-engine test 21.
- `"no state, board deleted, mirror present refuses GENESIS_BOARD_MISSING and writes nothing locally or remotely"` — 01-engine test 44.
- `"join: HEAD == Hb proceeds; a strict ancestor refuses START_HEAD_BEHIND; ahead or diverged refuses START_HEAD_AHEAD; HEAD == Hr ≠ Hb refuses START_HEAD_AHEAD with base_move unsupported"` — ruling R-08.
- `"join sets A := tree(HEAD) and state [L_b, T], applies first, then LA_C := TIP; join.first_apply fires between the first apply and the first publish"` — ENG-52.
- `"a join with nothing opted in publishes OUT == tree(TIP)"`.
- `"local work at genesis and at join with publishLocal null refuses START_PREVIEW{n_in, m_out, unshared}; none holds it in one masked join PIN; all publishes it after the first apply"` — ruling R-22.
- `"a board with proto 2 refuses START_VERSION"`.
- `"state present and board absent dispatches RESTART, never START_BOARD_GONE, and the next prepareIteration returns the incident branch with why board_missing"` — ruling R-23 (entering INCIDENT is Task 16's `enterIncident`, tested there).
- `"a default file:// remote probes to {custom_refs, lease, delete, two_parent_ok: true, push_options: false} and the probe ref deletion is the only deletion in the reference-transaction log"` — PRO-49, INV-OID.
- `"a hook refusing refs/cowork/* three times refuses START_REFUSED_CUSTOM_REFS; refusing once then accepting gives custom_refs true"`.
- `"a hook that accepts any old value refuses START_REFUSED_NO_LEASE"`.
- `"every probe push is a counted governed attempt and none waits for a window"` — ruling R-21.
- `"a kill at apply.intent, apply.group.phase1, apply.group.mid, apply.group.phase2, apply.between_groups or apply.state, then a teammate deleting the just-applied line and git gc --prune=now: after restart no resurrection, no missing path, O-REACH holds, every byte on disk or in a restart record"` — 01-engine test 26 (single-run form), Review Focus 5.
- `"a kill at publish.out_built discards the intent; a kill at publish.sent or publish.landed resolves as landed by observation and nothing is published twice"` — Review Focus 5.
- `"a kill after the writes and before ENG-36 with a journaled ready pair on a written path: the next publish's A_cap == A assert passes and the pair carries the peer's change"` — 01-engine test 26 inner case, test 38 (c).
- `"restart removes the own <e>.index.lock, tmp/*.new and tmp/stage and never a foreign .git/index.lock"`.
- `"a missing private index is reseeded from state:snap"`.
- `"a kill between seq allocation and its persistence never reuses a landed seq"` — T-PRO-41.
- `"deleting the state ref while live rebuilds per path: matched paths take the newest matching version, unmatched LIVE paths become masked restart records, a new epoch, LOST_STATE, no re-join"` — 01-engine test 22.
- `"a QUARANTINED and a SAVE_ONLY local edit are reseeded without a record and an UNMANAGED path is never read"` — 01-engine test 36 part.
- `"the rebuild reads at most 500 first-parent commits"`.

**Crashpoints:** `join.first_apply` (01-engine §3.14 Join after step 7, before step 8 or the first publish). **Lint:** none.

---

### Task 16: Incidents and recover

**Files:**
- Create: `src/engine/recover.ts`
- Test: `test/integration/incident.flow.test.ts`, `test/integration/recover.test.ts`

**Interfaces:**
- Consumes: `incidentCheck`, `fpOk`, `IncidentVerdict`, `prepareIteration`, `startDispatch`, `governedPush`, `GovernedBody`, `AttemptClass`, `pushSpec`, `lsRemote`, `fetchRefs`, `lostStateRebuild`, `Folder`, `StateStore`, `RefNames.displaced/incident/incidentOwn`, `makeCores`.
- Produces: `DISPLACED_CAP`, `RecoverRefusal`, `RecoverPreview`, `RecoverResult`, `enterIncident`, `clearIncidentIfHealed`, `recover`.

**Spec:** 01-engine §3.7; ENG-20…ENG-22, ENG-59 (`recover.displaced`, `recover.reanchor`); glossary §4 (displaced, `incident-<n>`, `incident-<n>-own`), §8 (INCIDENT); PRO-25; tests 01-engine 18, 19, 35, 39; INV-FF (recover exception), INV-OID; rulings R-21, R-27.

**Tests:**
- `"a rewound board, a rewrite keeping the old chain as second parent, a deleted board and a jumped last parent each raise INCIDENT within 2 polls on every peer with zero applies and zero board or code pushes"` — 01-engine test 18.
- `"each detecting peer pushes one ABSENT-leased displaced copy of LA_B and stores incident-<n>; with 3 displaced refs present the copy stays local and the status says kept_local"`.
- `"a restart with state present and the board absent enters INCIDENT (board_missing) on its first iteration and pushes nothing but the displaced copy"` — ruling R-23 (Task 15's dispatch plus `enterIncident`).
- `"recover without --confirm changes nothing and returns a preview id"`.
- `"recover with the preview id displaces V when it is not on X's chain, hits recover.displaced, then pushes X to the board and live_code(X) to the mirror with --force-with-lease and clears INCIDENT"`.
- `"other peers clear INCIDENT when their check passes again and refold"` — PRO-25.
- `"recover refuses RECOVER_NOT_IN_INCIDENT, RECOVER_OFFLINE, RECOVER_AMBIGUOUS and RECOVER_DISPLACED_FULL in their situations"`.
- `"a mirror moved onto the bad chain is healed by the recover push"` — 01-engine test 39.
- `"a late peer whose newer commits are not on the restored chain re-anchors: no force push, incident-<n>-own written before any state change, recover.reanchor hit, own-only bytes become restart records, a new epoch, LOST_STATE{re_anchor}"` — 01-engine test 35 core.
- `"a bad-shaped commit on the restored tip and a plain rewind with an old displaced ref take the normal recover, not the re-anchor"` — 01-engine test 35 controls.
- `"a missing or rewound mirror alone never raises INCIDENT"` — 01-engine test 19.
- `"every recover push is a counted governed push whose argv has --force-with-lease and never '+' or --force"`.

**Crashpoints:** `recover.displaced` (01-engine §3.7 Recover after step 4, before step 5), `recover.reanchor` (step 2a after `incident-<n>-own` is written, before the state update that ends the re-anchor's rebuild). **Lint:** none.

---

### Task 17: The loop, epoch guard, status.json, foreground daemon

**Files:**
- Create: `src/engine/epoch.ts`, `src/engine/status.ts`, `src/engine/loop.ts`, `src/daemon/run.ts`, `test/helpers/engineFixture.ts`
- Modify: `src/entry/daemon.ts` (keeps `--version`, which Plan 1's `test/integration/build.test.ts` runs on every bundle)
- Test: `test/unit/status.test.ts`, `test/integration/loop.test.ts`, `test/integration/epoch.test.ts`, `test/integration/partition.test.ts`, `test/integration/daemon.cli.test.ts`

**Interfaces:**
- Consumes: Tasks 1–16, Plan 1 `realScheduler`, `realClock`, `buildDaemonEnv`, `createGitRunner`, `parseGitVersion`, `meetsFloor`, `PLUGIN_VERSION`.
- Produces: `OPERATION_MARKERS`, `INDEX_LOCK_NOTICE_MS`, `EpochObservation`, `observeEpoch`, `epochVerdict`; `StatusState`, `PublishPause`, `StatusJson`, `StatusInputs`, `computeStatus`, `StatusWriter`; `LOOP_ACTIVE_MS`, `LOOP_IDLE_MS`, `SUSPEND_LOOP_FACTOR`, `IterationReport`, `EngineInspection`, `Engine`, `LoopHandle`, `runLoop`; `DaemonCommand`, `DaemonArgs`, `parseDaemonArgs`, `ResolvedRemote`, `RemoteRefusal`, `resolveRemote`, `sanitizeUrl`, `DaemonIo`, `runDaemon`; `EngineFixture`, `makeEngines`.

**Spec:** 01-engine §3.5 (the whole iteration, out-of-cycle request (a), preconditions), §3.6, §3.15, §3.16; ENG-13…ENG-19, ENG-55…ENG-57; glossary §8, §14, §25.2 items 4 and 6; CCI-50; LIF-05, LIF-06 (respawn column), SEC-11 subset; tests 01-engine 5, 23 (network part), 24 (subset), 25 (subset), 48, 49; T-PRO-23 (VERSION rows); Plan 1 ledger carries (monotonic time across sleep; `core.sshCommand`); rulings R-07 (eol-bom records), R-09, R-11, R-23, R-26…R-28, R-35, R-37.

**Tests:**
- `"status precedence over every combination of freeze reasons and pauses, with exactly the glossary §14 fields"` — 01-engine test 5; offline carries label, explanation and offline_for_s; HOST_THROTTLED only in ok with {source, until_min, budget, fallback_left_s, signal}; BRANCH_REWRITTEN in ok.
- `"StatusWriter retries EPERM 3 × 50 ms, then skips the write"`.
- `"three peers (one autocrlf=true) editing different files, disjoint bands of one file and one shared line converge within 20 rounds of the last landing, then make zero pushes for 40 rounds"`.
- `"iterations never overlap and fetches stay single-flight inside the loop"`.
- `"a 60 s wall-only suspend and a 60 s advance of both clocks between iterations each force a fetch before any apply or publish"` — ledger carry (Δwall − Δmono > 5 s, or Δmono > 3 × loop period).
- `"with .git/index.lock present the loop only fetches and folds, raises INDEX_LOCK_WAIT after 30 s of the same mtime, and never deletes it"` — ENG-15.
- `"a board with proto 2 gets zero pushes while apply continues; an own regionSpec ≠ teamRegionSpec pauses code pushes and allows the board-only list"` — ENG-55, T-PRO-23 VERSION rows.
- `"after 3 min without a lease no capture, apply or new publish happens but ready pairs still flush; after 10 min the engine drains with status down and IDLE_NO_SESSION; a plain drain writes down without a code"` — 01-engine test 49, CCI-50.
- `"offline_for_s grows with Δmono in status.json while the remote is unreachable"` — 01-engine test 49.
- `"a canon refusal on a LIVE path creates one ON_DISK eol-bom PATCH that masks the path and drops its guard when a later snapshot passes canon"` — ruling R-07.
- `"git checkout -b other, reset --hard with a modified file, git stash and a MERGE_HEAD marker each freeze EPOCH within one iteration with no apply and no code publish, and post a board-only freeze event; returning to E1 unfreezes"` — ruling R-09, 01-engine test 25 subset.
- `"a peer cut off from the remote for 10 virtual minutes goes OFFLINE after 30 s, spaces fetches 30 s, 60 s, … ≤ 5 min, pushes nothing, keeps capturing; after reconnect it fetches, checks, folds, applies and publishes once; everything converges"` — Review Focus 3.
- `"dist/daemon.js --version prints the version"` — built bundle.
- `"run on a fresh clone performs genesis, run on a second clone joins, a stop signal drains to status down, and running again restarts"` — ruling R-23.
- `"a second run on the same clone refuses while the first holds daemon.lock; a lock with a dead pid is replaced"` — ruling R-26.
- `"remote resolution follows pushRemote, pushDefault, branch remote, --remote, the only remote; a fetch/push URL split refuses SEC_REFUSE_REMOTE_SPLIT and an insteadOf prefix SEC_REFUSE_URL_REWRITE, both with exit 1"`.
- `"the resolved core.sshCommand reaches the runner"` — ledger minor #4.
- `"recover without --confirm prints the preview id; resume clears meta.nonretryable while no daemon runs"` — ruling R-28.
- `"no printed line contains URL userinfo"` — `sanitizeUrl`.

**Crashpoints:** none new (the loop calls the steps that hold them). **Lint:** none.

**Notes:** `Engine.iterate()` composes, in order: step 0 gates (suspend rule, `index.lock`, `observeEpoch` → FREEZE(EPOCH) per R-09, lease idle per CCI-50), `prepareIteration` (step 1–3), `enterIncident` / `clearIncidentIfHealed` (step 2), the branch classification of R-08, `ChangeSets.observe(tick.changed)`, materialize when a capture is due or `applyNeeded`, the eol-bom records of R-07, `S_pub := maskEntries(S_disk)` (step 4), `ChangeSets.capture` + journal, `applyStep` (step 5), `publishStep` (step 6), `Writer.sweepRing`, status and events (step 7). When `prepareIteration` returns the incident branch (for example `board_missing`, where `T` is ABSENT), the iteration has no `IterationCtx` and no TIP: `iterate()` enters or keeps the incident, writes status and stops without touching `tip`, the tick, apply or publish. `runLoop` and `runDaemon` bind `realClock`, `realScheduler`, `realFs`, `realRandom`, `alwaysLeased`, `humanOnlyAttribution`, `heartbeatMs = machineMonoMs`, `fileLog(<coworkDir>/log/daemon-0.jsonl)` and a runner with `hooksPath = <coworkDir>/empty-hooks`, `daemonEnv = buildDaemonEnv(process.env, [])` and the resolved `sshCommand`.

---

### Task 18: Real engine in the SIM harness, op generator

**Files:**
- Modify: `test/sim/harness.ts`
- Create: `test/sim/engineAdapter.ts`, `test/sim/generators.ts`
- Test: `test/integration/sim.engine.test.ts`, `test/unit/generators.test.ts` (Plan 1's `sim.harness`, `sim.oracles`, `sim.naive` tests stay unchanged and green)

**Interfaces:**
- Consumes: `Engine`, `EngineDeps`, `StartOptions`, `EngineInspection`, `MutantId`, `RefNamespace`, `RELEASE_NAMESPACE`, `alwaysLeased`, `humanOnlyAttribution`, `TraceRecorder`, `FaultFs`, Plan 1 harness, `seededRandom`, `randomInt`, `generateBigBomCrlf`, `setCrashHandler`, `KilledAt`.
- Produces: `SimOp`, `OpGenerator`, `QuiescenceOptions`, `DEFAULT_QUIESCENCE`, `QuiescenceInfo`, `SimOptions`, the `SimContext`/`SimEngine`/`SimResult` additions, the 4-argument `runSim`; `RealEngineOptions`, `realEngine`; `EditKind`, `FaultKind`, `GeneratorProfile`, `PROFILES`, `seedFilesPlan2`, `editGenerator`.

**Spec:** 11-testing §3.3 (setup, run steps 1–5, host emulation), §3.5 (F-ED-2, F-ED-6, F-ED-8, F-ED-9, F-NET-2, F-NET-5, F-NET-10, F-PEER-4); TST-02, TST-03; rulings R-31, R-32.

**Tests:**
- `"Plan 1 harness, oracle and NaiveEngine tests pass unchanged without the fourth argument"`.
- `"the same edits seed twice in different temp roots gives identical op-logs, identical trace events and identical remote ref oids"` — TC-TST-01.
- `"a 3-peer edits run of 40 steps reaches quiescence and every engine shows LA_B == T*"`.
- `"editGenerator draws every EditKind of profile edits and every FaultKind of profile faults within 300 draws, using only ctx.random"`.
- `"written files get the peer's virtual wall clock as mtime, and files on autocrlf=true peers keep CRLF endings"`.
- `"edit_band touches only rows 3–7 of the peer's band"` — no adjacent-row conflicts.
- `"edit_same_line on two peers before either publishes yields exactly one K4 record, on the later publisher"`.
- `"a KilledAt at a crashpoint ends the step and the next step restarts the engine from disk"`.
- `"race_push interleaves two engines at publish.beforePush and records a lease_lost push outcome"`.
- `"partition renames the bare remote and heal restores it"`.

**Crashpoints:** none. **Lint:** none.

---

### Task 19: SIM oracles, crash matrix, seed runner, CI budgets

**Files:**
- Modify: `test/sim/oracles.ts`, `package.json` (scripts `sim:seeds`, `sim:exit`), `.github/workflows/ci.yml`, `test/unit/ci-config.test.ts`
- Create: `tools/sim/run-seeds.ts`, `tools/sim/run-shard.ts`, `.github/workflows/sim-exit.yml`
- Test: `test/integration/sim.oracles.plan2.test.ts`, `test/integration/sim.crash.test.ts`, `test/integration/sim.seeds.cli.test.ts`, `test/unit/crashpoints-placed.test.ts`

**Interfaces:**
- Consumes: Task 18 harness, `realEngine`, `PROFILES`, `editGenerator`, `seedFilesPlan2`, `TraceRecorder`, `MutantId`, `RefNamespace`, Plan 1 `oracleFF`, `oracleOID`, `lintCrashpoints`.
- Produces: `oracleFF` (trace clause), `oracleOID`, `oracleFirstParent`, `oracleBase`, `oraclePushedIsMerge`, `oracleConverge`, `exitOracles`; the `run-seeds` / `run-shard` CLIs; `sim-exit.yml`.

**Spec:** 11-testing §3.4 rows INV-FF (trace clause), INV-FIRSTPARENT, INV-BASE, INV-PUSHED-IS-MERGE, INV-CONVERGE, INV-OID; §3.6; §3.9 (M05, M06, M07, M17, M18, M20); §3.11; TST-03, TST-06, TST-07, TST-13; glossary §20 CI row; 01-engine tests 28 and 52; rulings R-29, R-31…R-33.

**Tests:**
- `"each new oracle fires on its mutant and on no other"` — TC-TST-02 form: M07 + a board-rewind fault → INV-FIRSTPARENT; M05 (A seeded from TIP at join) → INV-BASE; M06 → INV-PUSHED-IS-MERGE; M17 with a deferred path → INV-CONVERGE; M18 → INV-CONVERGE (phantom ping-pong); M20 → INV-PUSHED-IS-MERGE or the `A_cap` assert.
- `"a '+' refspec planted into a recorded push argv fails the INV-FF trace clause"`.
- `"every exit oracle passes on 20 edits seeds and 10 faults seeds"`.
- `"each of the 14 crashpoints killed once in each of 3 faults seeds, with restart, passes every exit oracle"` — TST-06 SIM form, 01-engine test 26.
- `"the 14 Plan 2 crashpoint names are call sites in src/ and all appear in test/crashpoints.json"` — 01-engine test 52.
- `"run-seeds exits 0 for passing seeds, 1 when a mutant seed fails, 2 on bad arguments; shards cover [from, from + N) exactly once; failures print their rerun command"`.
- `"each ci.yml leg runs 80 edits and 20 faults seeds with a per-Node seed offset and a 45-minute timeout; sim-exit.yml runs 1,000 edits seeds per OS in 10 shards"` — ruling R-33.
- `"npm run ci ends with sim:smoke and a 5-seed real-engine run (sim:seeds --profile edits --seeds 5)"` — Plan 1's `ci-config.test.ts` order assertions are extended, not dropped.

**Exit evidence (recorded in the ledger, not a unit test):** the acceptance artifact for roadmap row 2 is one manually dispatched `sim-exit.yml` run on the plan's final commit whose three OS jobs (windows-latest, macos-latest, ubuntu-latest; 1,000 `edits` seeds each, 10 shards of 100) are all green with the six exit oracles; the ledger records the run URL, the commit and the per-OS seed and failure counts. A local `npm run sim:exit` on one PC is a rehearsal, not the artifact.

**Crashpoints:** none new. **Lint:** none.

---

### Task 20: Real-remote two-clone sync test

**Files:**
- Create: `tools/real/two-clone.ts`, `tools/real/cleanup.ts`
- Modify: `package.json` (scripts `real:two-clone`, `real:cleanup`)
- Test: `test/integration/real.twoclone.test.ts`

**Interfaces:**
- Consumes: `Engine`, `runLoop`, `EngineDeps`, `testNamespace`, `createGitRunner`, `buildDaemonEnv`, `realClock`, `realScheduler`, `realFs`, `realRandom`, `alwaysLeased`, `humanOnlyAttribution`, `machineMonoMs`, `sanitizeUrl`, `lsRemote`, `fpOk`, `makeTempRoot`.
- Produces: `TwoCloneReport`, `twoCloneRun`; the `two-clone` and `cleanup` CLIs.

**Spec:** TST-16; glossary §4 (test ref prefix `refs/cowork-ci/<run_id>/…`, branch `ci/<run_id>/<b>`); 11-testing §2 (REAL-HOST mode), §3.12 (shape); INV-CONVERGE, INV-FF; ruling R-34.

**Behaviour (the script, in order):** refuse unless `COWORK_REAL_REMOTE` is set (usage, exit 0, no network); `ls-remote` the default branch and refuse with `TEST_TARGET_REFUSED` (exit 1, zero pushes) unless its tree has `.cowork-test-repo`; `run_id = ulid`; push the default branch head to `refs/heads/ci/<run_id>/main`; clone it twice into a temp root (peer A `core.autocrlf=false`, peer B `core.autocrlf=true`); create both engines with real ports under `testNamespace(run_id)` and branch `ci/<run_id>/main`; A starts (genesis, with the host probe), then B (join); `runLoop` both in-process; run three scenarios, each waiting for convergence (both `inspect()` show `LA_B` equal, `aTree == tree(live_code)`, empty `not_converged` apart from records the scenario expects) with a timeout: (1) A and B edit different files; (2) A and B edit the same file on lines 10 rows apart; (3) A and B edit the same line → one K4 record on the later publisher, TIP's version on both disks; record every board tip either peer fetched and assert each later tip has the earlier one on its first-parent chain (`fpOk`); print the report (`TwoCloneReport`, every URL through `sanitizeUrl`, never a token) and the cleanup command; stop both loops (drain); remove the local temp root unless `--keep`. It never deletes a remote ref.

**Tests:**
- `"a remote whose default branch lacks .cowork-test-repo is refused with TEST_TARGET_REFUSED and zero pushes"`.
- `"with COWORK_REAL_REMOTE unset the CLI prints usage and exits 0 without network"`.
- `"the rehearsal against a file:// remote holding .cowork-test-repo runs genesis, join and the three scenarios to convergence with ffHistory true and one K4 record"` — real clocks; runs only when `COWORK_REAL_REHEARSAL=1` (it takes minutes) and in `sim-exit.yml`.
- `"every report line passes through sanitizeUrl"` — a `https://user:token@host/x` URL never appears.
- `"cleanup lists and deletes only refs/cowork-ci/<run_id>/* and refs/heads/ci/<run_id>/*, and refuses any other ref"`.

**Manual run (recorded in the ledger):** `COWORK_REAL_REMOTE=<private GitHub https url> npm run real:two-clone` against the user's sandbox repository with credentials from the user's git credential helper (DAEMON_ENV passes `GCM_*`, `HOME`, `APPDATA` etc.; prompts are disabled, so authenticate once with a plain `git push` first). Report and elapsed time go into the ledger; cleanup is a separate explicit `npm run real:cleanup -- --remote <url> --run <run_id> --yes`.

**Crashpoints:** none. **Lint:** none (tools/ is outside `src/`).
