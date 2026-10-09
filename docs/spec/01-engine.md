# 01 — Sync engine and git storage

**Status:** normative · **Depends on:** 00-glossary (+ 02-protocol PRO-, 03-data DAT-, 04-regions REG-, 05-holds HLD-, 06-claude CCI-, 07-coordination COO-, 08-lifecycle LIF-, 09-security SEC-, 11-testing TST-)

The engine keeps one shared live tree per branch on the project's own git remote and keeps every peer's working tree in step with it without ever losing bytes. It snapshots local edits through a private index, merges them against an explicit per-path base, publishes them as first-parent fast-forward commits under one compare-and-swap on the board ref, writes incoming changes into the working tree path group by path group through a verifying writer, and survives crashes, host rejections and ref rewrites. It never moves the real branch itself; `save` (LIF-) and adopt (LIF-) use the primitives defined here.

Keywords MUST / MUST NOT / SHOULD / MAY as in RFC 2119. Every name, ref, file, schema and number in this chapter is the glossary's, conformed to glossary **revision 2.4**: REVISION 2 (§23), the Revision 2.1 owner decisions and technical defaults (§24), the Revision 2.2 spike facts F1–F13 and pass-2 owner decisions (§25), the Revision 2.3 Windows-contention facts W1–W6 and synthesis decisions (§26) and the Revision 2.4 user review answers (§27, user-approved 2026-10-02: S1 revised to publish at every passing **edit checkpoint**, §27.1; U3 revised to a push budget of 12 per minute with automatic fallback to 6, §27.2), and the Revision 2.5 feature additions (§29, 2026-10-08: F04's `meta.since` marks and F14's flow requests in this chapter, and F10's `revertInverse()` clause (§3.3 item 4, ENG-10) and owner decision D2's snapshot-side attribution (ENG-25); owner decisions D1–D5 final since 2026-10-08, glossary §29.1); where they differ the newest section wins. Where a source rule was changed to match the glossary the rule says "(changed per glossary §N)"; a glossary §24 technical default is cited as "glossary §24 default n", a measured fact as "glossary §25 Fn" or "§26.1 Wn", and a decision as "glossary §25.2 item n" or "§26.2 item n". Terms the glossary now defines (S_raw, MASK, ready pair, P, OUT, DISK_EQ, write group, pathState, scope class, LA_C, claim view, teamRegionSpec, the not-applicable paths of INV-GROUP, the local ref `incident-<n>-own`) are used as defined there and are not redefined here.

---

## 1. Scope

### 1.1 v1 in scope

- One daemon per clone, one live branch per clone, main worktree only (glossary §4); one loop iteration at a time.
- All daemon git state in the user's own `GIT_DIR`: the refs of glossary §4, the files of glossary §6, the state ref `refs/cowork-local/<enc(b)>/state` as the single source of truth.
- Engine use of the git runner (glossary §18): absolute paths, Buffers only, three blob-producing operations, four tree-producing operations, typed oids, the mechanics of the one disk comparator `DISK_EQ` (glossary §3).
- The sync loop: gates, epoch observation call site, fetch, incident check, fold call site, branch-move handling, snapshot, outgoing guards and MASK call site, apply, publish, status.
- Snapshot through **staged-copy reads on every OS** (glossary §26.1 W1: no git process ever reads a user's working file) with a stat cache, quiet period, structural unreadable/unstable/filter-failure detection, deletion confirmation and shrink guard; **detection ticks write no objects** and objects are written only when the iteration materializes the snapshot for a capture, an apply or a record (glossary §26.1 W6); canon call site.
- Apply through the two-phase verifying writer (the only writer form, glossary §26.1 W4) in change-set write groups, with defer set, coalescing, free-space check, round trip and the `.old` ring; the copy fallback on volumes without hard links (glossary §26.2 item 7); the local-origin entry point `writeLocal`.
- Publish: the publish composition P (glossary §3) from ready pairs, B1/T0/identity/conflict call order on the leased tip, pre-push asserts, one leased push of board + mirror (never `--atomic`, glossary §26.2 item 1), classification of rejections by outcome (glossary §26.2 item 2), ambiguous-push resolution, NONRETRYABLE handling, governor call sites, host-throttling signal detection, the 30-min throttle fallback and its `health` event (glossary §27.2).
- The engine side of the edit checkpoint (glossary §27.1): the out-of-cycle iteration, the candidate capture and the call of the edit check (owned by 04-regions/05-holds), and the ready-pair journal update on a pass.
- The production `crashpoint()` call sites that 11-testing §3.6 anchors to this chapter's steps (glossary §25.2 item 10).
- Branch moves: save completion, live base moves for external branch commits, base-move hold records; the branch-then-board push primitive used by save.
- Genesis, join mechanics, restart from the journal (including writer rollback), lost-state per-path rebuild.
- Rewrite-incident detection, displaced copies, `/cowork recover` mechanics.
- VERSION publish pause and upgrade drain; `status.json` writer; engine events.

### 1.2 v1 refuses

| Situation | Behaviour | Message code |
|---|---|---|
| Join while HEAD is a strict ancestor of the live base | start refused, nothing written | `START_HEAD_BEHIND` (LIF-07; code owned by LIF-) |
| Join while HEAD is ahead of or diverged from the live base (other than `HEAD == Hr`) | start refused | `START_HEAD_AHEAD` (LIF-07) |
| Join needs a base move that conflicts | start refused, conflicting paths listed | `START_BASE_MOVE_CONFLICT` (LIF-07) |
| Start while the board is absent and this peer's state ref exists | start refused (no genesis) | `START_BOARD_GONE` (LIF-06, Table 3.3-A; code owned by LIF-) |
| Start with no state ref while the board is absent and the code mirror exists | start refused (no genesis: the live chain existed and its board is gone) | `GENESIS_BOARD_MISSING` (defined here, ENG-51; LIF-06 Table 3.3-A dispatches to it; a teammate whose cowork has state for the branch runs `/cowork recover`, ENG-22) |
| Remote branch rewritten or deleted (`Hb` not an ancestor of `Hr`, or `Hr` missing) | no base move, no save; live continues on `Hb` | `BRANCH_REWRITTEN` |
| Automatic recovery from a rewrite incident | only human-typed `/cowork recover` exits INCIDENT on the recovering peer (in re-anchor mode on a late peer once the team has built on an earlier recover's tip, §3.7 step 2a); other peers clear it when their first-parent check passes again (glossary §8) | `INCIDENT` (status), recover refusals `RECOVER_NOT_IN_INCIDENT`, `RECOVER_OFFLINE`, `RECOVER_AMBIGUOUS`, `RECOVER_DISPLACED_FULL` |
| Automatic bisection after a non-retryable push rejection (the third consecutive rejection of the same publish with the board unchanged, glossary §26.2 item 2) | publishing stops until the human acts | `NONRETRYABLE` |
| `--atomic` pushes | never used, on every host: one rule for all hosts; the board-authority / lagging-mirror rule (INV-ENG-AUTH) already makes the board + mirror pair safe and save completion (ENG-47 case (ii)) covers the branch + board gap. GitHub's measured `atomic` support (glossary §25 F8) is recorded for v2 only (glossary §26.2 item 1) | — |
| Live publication of `QUARANTINED`, `SAVE_ONLY` or `UNMANAGED` paths (glossary §3 scope classes, §16) | masked to `A[p]`; incoming `QUARANTINED` changes (including every new `120000`/`160000` entry) are not applicable (§3.11, glossary §21 INV-GROUP): their own INCOMING record with guard `quarantine-review`, written only after the local human's `/cowork review <id> --accept` with preview/confirm (glossary §15; SEC-32, SEC-33), never deferring the rest of their group; incoming `UNMANAGED` changes are never written (`A[p]` follows `TIP[p]` without a write, DAT-26); incoming `SAVE_ONLY` changes are written like `LIVE` (DAT-27) | review item in `not_converged` (status reason `quarantine: commit with git`, glossary §16) |
| Any remote ref deletion other than this peer's probe ref of the active namespace (`refs/cowork/probe-<peer_id>`, or `refs/heads/cowork/probe-<peer_id>` in the fallback namespace) | impossible by construction (INV-OID) | — |

Start-time refusals (git/node floors, linked worktree, tmp on another volume, URL mismatch or rewrite, anonymous readability, host refusing custom refs, branch name whose `enc(b)` exceeds 150 bytes, start dispatch by state ref / board / mirror presence) are owned by LIF- (LIF-04 preflight, LIF-06 dispatch, LIF-07 HEAD checks), SEC- (SEC-11, SEC-12 URL/auth) and PRO- (PRO-49, PRO-50 host probe). The engine only consumes their results; its only start refusal code is `GENESIS_BOARD_MISSING` (the genesis precondition of ENG-51).

### 1.3 Deferred (glossary §22) — not v1 behaviour

- Exact-match base B′ for base-move conflicts (v1: base-move hold record, save blocked, committer told; ENG-48).
- `/cowork end`, `gc`, `--remote-refs`, `refs/cowork-archive` (v1: refs stay; a vanished board is a plain incident).
- Manual relaxed `/cowork adopt` (v1: automatic relaxed adopt S7 only, LIF-).
- `SNAPSHOT` hold kind and `FREEZE(DISK)` (v1: FREEZE reasons in state meta; per-apply free-space check, ENG-30).
- Board rotation; multiple live branches per clone; protocol raise (fixed `proto = 1`).
- `OFFLINE_RECONCILE` batching (v1: reconnect runs the ordinary loop, per-CS warnings with 10 s coalescing by COO-).
- Engine-local, not in glossary §22 but also not v1: automatic incident recovery by ancestry agreement; Windows `ReplaceFile`-based native swap; symlink live sync; an `atomic` board + mirror push where the host advertises it (recorded for v2, glossary §26.2 item 1); a rename-over writer (removed: it failed 15/15 against a share-all reader, glossary §26.1 W4).

---

## 2. Local definitions

Glossary-defined terms this chapter relies on (not redefined here): S_raw, S_disk, MASK, S_pub, ready pair `(A_cap, R)`, P (publish composition), OUT, DISK_EQ, write group, pathState, scope class (`LIVE`, `SAVE_ONLY`, `UNMANAGED`, `QUARANTINED`, `NOT_ADMITTED`, `LOCAL_ONLY`; "save-only set" = `SAVE_ONLY ∪ UNMANAGED`), LA_C / LA_B, height and board position, live set / ghost / R, teamRegionSpec, claim view, M_disk, EPOCH_BASE (glossary §3); the not-applicable paths of INV-GROUP (glossary §21); the local refs `incident-<n>` and `incident-<n>-own` (glossary §4). This section defines only engine-internal terms.

| Term | Definition |
|---|---|
| **T** | The fetched board tip `refs/cowork-remote/<enc(b)>/board` at this loop. `TIP = live_code(T)` (glossary §3). |
| **Bnew / C** | The board commit and live code commit a publish builds. C is absent on board-only publishes. |
| **L′** | A base-move commit built by the engine (`Cowork-Base: <Hr>`), including the save-completion form `Ls` (`Cowork-Base: <S>`). |
| **write group `n`** | The glossary's write group (the applicable paths of one publication group), numbered `n` within one apply intent. The groups come from HLD-53. |
| **defer set D** | Paths not written by the current apply, each with one reason code (ENG-31). Its paths keep `A[p]`. |
| **pending path** | A path with `A[p] != TIP[p]` that the last apply did not write. Listed in `meta.pending` with its reason; it is the "pending path whose `A[p]` is retained" of the glossary's LA_C definition. HLD-54 (deferral ≥ 60 s; younger deferrals are glossary §9 transient exclusions carried by `meta.pending` alone) and DAT-29/DAT-33/SEC-32 (collision, unmaterializable, quarantine review: at once) carry it as an INCOMING record. |
| **not applicable** | The glossary §21 INV-GROUP term, used verbatim: an incoming path that is unmaterializable on this OS (DAT-33), a local creation collision (DAT-29), or an incoming change to a `QUARANTINED` path (guard `quarantine-review`, SEC-32, HLD-54). Engine consequence: it keeps `A[p]`, gets its own INCOMING record, and is listed in `not_converged`; the rest of its group still applies. |
| **carry-through** | Treatment of a path the engine must neither publish nor write: the snapshot keeps A's entry (none for a new path), the writer never writes or deletes it, MASK resets it to `A[p]`. Applies to `UNMANAGED` and `NOT_ADMITTED` paths and to not-applicable paths. |
| **writeLocal result** | `WRITTEN | MISMATCH(found_blob) | LOCKED | COLLISION | FROZEN | DEFERRED(reason) | PHANTOM` (§3.11, ENG-37). |
| **writeLocalGroup(entries[])** | All-or-none variant of `writeLocal` over several paths, same per-path semantics, one write group. |
| **transition** | A loop step that changes A, LA_C, LA_B, the journal, pending set, ready pairs, FREEZE reasons or meta. Only transitions update the state ref. A change of `meta.since` alone (the F04 catch-up marks) is not a transition: it is held in memory and rides the next transition's state update, or the drain's state write at exit (§3.2 "Transitions only"). _(rev 2.5, F04)_ |
| **staged read** | The only way the daemon reads the bytes of a user's working file (glossary §26.1 W1, W3): `st1 := lstat(p)`; open p with share read + write + delete, read the whole file, close (the handle lives for that one read); `st2 := lstat(p)`; if `(size, mtime_ns)` of `st1` and `st2` differ, read once more (`st2 → st3`), and if they still differ the path is UNSTABLE for this tick; an open or read error (sharing violation, `EBUSY`, `EPERM`, `EACCES`) makes it UNREADABLE for this tick; otherwise the bytes (a Buffer) are written to `<gitdir>/cowork/tmp/stage/<p>` (the **stage copy**) and every git command that needs those bytes reads the copy, never p. A `.old` file of the writer ring and any other daemon-owned file that a user process may still hold are read the same way. |
| **blob routes** | 03-data §3.1's three ways to compute a blob id or create a blob: (a) the private-index `git add` of stage copies (`--work-tree=<tmp/stage>`), used here only for paths without a clean filter; (b) `git hash-object [-w] --path=<p>` of a stage copy or of stdin, run with cwd = the repository root (glossary §25 F12), used for every path with a clean filter; (c) `git hash-object [-w] --stdin --no-filters` for bytes already in stored form (canon, concat, restore output), never for working-tree bytes. |
| **stat cache** | In-memory, per path: the `lstat` (size, mtime_ns, file id, mode) seen by the path's last staged read, its **detection id** (the route (b) id of that stage copy computed without `-w`; for an unfiltered path `S_raw[p]` when §3.8 step 5 found the copy equal, otherwise that route (b) id, computed only when a hook request needs a handle (§3.8 "Hook requests") and never compared with a stored blob, ENG-11; route (a) does not run at a detection tick, 03-data §3.1 (2b)), and its state: `clean` (the stage copy equals the private-index entry `S_raw[p]`) or `dirty` (the stage copy is kept until it is materialized). Emptied at daemon start, join, lost state and every private-index reseed, so the first snapshot after them stage-reads every tracked path once. It replaces the stat data of the private index as the source of stat-dirtiness: private-index entries are written from stage copies, so their stat data describes the copy, not the working file (changed per glossary §26.1 W1). Chapter-local; flagged for glossary promotion (§8 question 8). |
| **detection tick / materialize** | A snapshot that computes ids only and writes no object is a detection tick (glossary §26.1 W6). **Materializing** writes the `dirty` stage copies into the private index and the object store (routes (a) and (b) with `-w`) and produces a new `S_raw` / `S_disk`; it happens only in an iteration that captures a ready pair, applies, or creates or refreshes a hold record from disk bytes (§3.8), the occasions of glossary §26.1 W6 (publishes write their own objects). A hook request for the current content of named paths never materializes: it is answered with detection ids and in-memory bytes (§3.8 "Hook requests"). |
| **copy fallback** | The writer's phase 2 on a volume without hard links (glossary §26.2 item 7): exclusive create of p (`wx`, so an existing p still fails with `EEXIST`) and one write of the `.new` bytes, then fsync and close. Weaker than the link: a reader can see a partly written file while the write runs. |
| **rejection streak** | `meta.rejections = {lease, n}`: the number of consecutive host rejections of publishes leased on the same board value with the board unchanged (glossary §26.2 item 2); reset when a push lands, when the board ref moves, or by `/cowork resume`. |
| **edit checkpoint / candidate capture** | Glossary §27.1 (a): after every Claude edit (PostToolUse of `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, or a Bash/PowerShell TXN close) the engine runs one out-of-cycle iteration (§3.5) that materializes and builds a **candidate capture** `(A_cap, R)` for the seat's open CS exactly as a ready-pair capture would, then calls the **edit check** (glossary §27.1; entry point 04-regions/05-holds) on `merge-tree --merge-base=A R TIP` restricted to the CS's paths. Pass → the candidate becomes the CS's ready pair (journaled; it replaces an earlier one of the same CS, newest passing capture wins). Fail → the candidate is discarded (no journal entry, no record, no message); its blobs stay referenced only by the private index (`S_raw`) and are superseded by the next materialization. |
| **throttle fallback** | Glossary §27.2: for 30 min of local Δmono after a host-throttling signal (§3.12 "Throttle signals"), or while a folded `event{kind: health, reason_code: THROTTLE}` observed in the last 30 min applies, this peer's governor uses B = 6, G = 10 s, S = 3 s (the stricter of each value and the normal one). Persisted as `meta.throttle` (§3.2) without a timestamp; the 30-min timer restarts at daemon start (INV-CLOCK). |

**Message codes defined by this chapter** (glossary §19: chapters define codes in their own sections; the registry `dist/i18n/codes.json` is the union; Claude-facing template texts are owned by COO- in `en` and `ko`, human-facing texts by 10-product/I18N- in all 6 languages). Every code matches `^[A-Z][A-Z0-9_]{2,47}$`; no text this chapter supplies contains the word glossary §19 bans.

*Engine events* — both Claude-facing (COO- `EV.*` template at the next hook of each affected seat plus systemMessage, COO-31) and human-facing (`status.json.message_code`, OS notification class, `/cowork status`):

| Code | Params (`message_params`) | Raised by |
|---|---|---|
| `FROZEN` | `reasons` (subset of `freeze_reasons`), `config_detail` when CONFIG is set, the way back per reason | ENG-17, ENG-57 |
| `UNFROZEN` | `reasons` lifted | ENG-57, §3.7 |
| `INCIDENT` | `n`, old oids (`LA_B`, `LA_C`), observed oids (board, code or absent), displaced ref name or `kept_local` | ENG-21 |
| `NONRETRYABLE` | hold id of the `host-reject` PIN; **never** the host's text (ENG-45) | ENG-45 |
| `OFFLINE` | `label`: `OFFLINE` \| `AUTH`, `explanation` (SEC-18: `auth`, `host`, `network`, `network-or-auth`), `offline_for_s` (whole seconds of local Δmono since the last successful fetch; its templates show the duration, glossary §25.2 item 4) | ENG-19 |
| `ONLINE` | — | ENG-19 |
| `LOST_STATE` | `mode`: `lost_state` \| `re_anchor`, restart record ids and paths | ENG-54, ENG-22 (§3.7 step 2a) |
| `PHANTOM` | path, hold id | ENG-34 |
| `DEFERRED` | `reason` (one value of the §3.11 defer table), paths or group count | ENG-30, ENG-31, ENG-57 |
| `BASE_MOVE_CONFLICT` | `Hr` (8 hex), paths, hold ids, `reason`: `conflict` \| `identity` \| `guard` \| `BRANCH_REWRITTEN` | ENG-47, ENG-48 |
| `VERSION_PAUSED` | `form`: `proto` \| `regionSpec`, `cause`: `checkpoint_mismatch` when PRO-28 set it | ENG-55 |
| `NOT_CONVERGED` | paths, `cause` per path: `phantom` \| `not_applicable` (with its guard) \| `round_trip` \| `blocked_publish` (with the publish pause or FREEZE reason) \| `publish_assert` (the failing ENG-41 letter or `INV-MASK`) | ENG-57, ENG-28, ENG-41 |

*Human-facing only* (status line or slash-mode CLI refusal, exit 1 with one next command, glossary §15; rendered by 10-product; never sent to Claude except as noted):

| Code | Carrier | Params | Next command |
|---|---|---|---|
| `BRANCH_REWRITTEN` | `status.json.message_code` | `Hb` (8 hex), `Hr` (8 hex) or `missing` | "the branch was rewritten or deleted on the remote; restore it with git; live sync continues on the old base" (Claude sees it only as `BASE_MOVE_CONFLICT{reason: BRANCH_REWRITTEN}`) |
| `GENESIS_BOARD_MISSING` | `/cowork start` refusal | branch | "a teammate whose cowork has state for `<b>` runs `/cowork recover`" |
| `RECOVER_NOT_IN_INCIDENT` | `/cowork recover` refusal | — | `/cowork status` |
| `RECOVER_OFFLINE` | `/cowork recover` refusal | SEC-18 explanation; `reason`: `fetch` (no fetch, listing or push answer) \| `walk` (a first-parent walk of step 2a failed) \| `lease_lost` \| `rejected` (a host rejection of a recover push) \| `denied` (the governor still denied a recover push after the cap wait) \| `push_intent_unresolved` (a kept push intent could not be resolved, state unchanged) *(Plan 2 merge, Task 16 ruling; `denied` is in the Plan 2 code beyond the ruling's list)* | reconnect (`git fetch`), then `/cowork recover` |
| `RECOVER_AMBIGUOUS` | `/cowork recover` refusal | candidate oids (8 hex) and the displaced ref names; with `reason: x_check` (and the failing ref and why) when the containing candidate X fails the incident CHECK (§3.7 step 3) *(Plan 2 merge, Task 16 ruling)* | the refusal lists the candidate oids; the team decides which chain to keep (README) |
| `RECOVER_DISPLACED_FULL` | `/cowork recover` refusal | the 3 existing displaced refs | remove an old displaced ref by hand (`git push <remote> --delete refs/cowork/<enc(b)>/displaced/<name>`, a name the refusal lists, README), then `/cowork recover` |
| `RECOVER_PREVIEW_STALE` | `/cowork recover` refusal | the fresh preview | the confirm's preview id no longer matches (for example after a kept push intent resolved as landed): re-run with the new `--confirm` *(Plan 2 merge, Task 16 ruling; 08-lifecycle's `PREVIEW_STALE` is the registry code for every other confirm verb — an open question for the owner whether recover keeps its own code)* |
| `RECOVER_HEAD_STATE` | `/cowork recover` refusal | `op` (as `START_HEAD_STATE`, 08-lifecycle Table 2.7-A) | the re-anchor of §3.7 step 2a needs HEAD symbolic on `refs/heads/<b>` with no operation in progress: `git switch <b>` or finish the operation, then `/cowork recover` *(Plan 2 merge, Task 16 ruling)* |
| `THROTTLE` | board `event{kind: health, reason_code: THROTTLE}` (glossary §7, §27.2 `health{throttle}`; codes only) and `status.json.message_code` while `state` is `ok` and the throttle fallback is active (own or followed; §3.16; the fallback is not a pause and changes no `state`) | `budget` (6), `fallback_left_s` (whole seconds of local Δmono left in this peer's 30-min fallback), `signal`: `http_429` \| `http_5xx` \| `slow_push` \| `rejection_streak` \| `team` (a folded teammate event) | none: "publishing is slowed for up to 30 min because the host is throttling; nothing to do" (added in rev 2.4, glossary §27.2; no Claude event or template: the code in `status.json` is code-only, like `IDLE_NO_SESSION`) |

*Used here, owned elsewhere* (cited, not redefined): `START_HEAD_BEHIND`, `START_HEAD_AHEAD`, `START_BASE_MOVE_CONFLICT`, `START_BOARD_GONE`, `INDEX_LOCK_WAIT` (LIF-07, LIF-06, LIF-10), `ADOPT_BLOCKED`, `SAVE_REPORT` (LIF-), `PATH_BUSY` (glossary §11, CCI-), `CS_READY_CANCELLED` (HLD-41), `HOLD_MIRROR_REJECTED` (PRO-24; Claude-facing at the next hook of the record's origin seat, glossary §25.2 item 9), `IDLE_NO_SESSION` (10-product §3.19; written by ENG-56 as the last status of a lease-expiry exit, glossary §25.2 item 6).

---

## 3. Design

### 3.1 Picture

```
remote                                  local (same GIT_DIR, common namespace)
refs/cowork/<e>/board  ──fetch──▶  refs/cowork-remote/<e>/board   (T)
refs/cowork/<e>/code   ──fetch──▶  refs/cowork-remote/<e>/code    (lease value only)
refs/heads/<b>         ──fetch──▶  refs/cowork-remote/<e>/branch  (Hr)
                                   refs/cowork-local/<e>/state    commit [LA_C, LA_B]
                                        tree { base=A, snap=S_disk, journal/, meta }
                                   refs/cowork-local/<e>/holds    (HLD-)
                                   refs/cowork-local/<e>/incident-<n>       (observed bad tip)
                                   refs/cowork-local/<e>/incident-<n>-own   (re-anchor, §3.7 step 2a)
                                   (fallback namespace: remote refs/heads/cowork/<e>/{board,code}, glossary §4)
board chain:  B0 ── B1 ── B2 ── …   (first parents)       each Bi's LAST parent = live code commit
live chain:   L0 ── L1 ── L2 ── L′ ── L3 …               L′ = [prev, X] with Cowork-Base: X (branch commit)
```

`<e>` is `enc(b)` everywhere. The board is the only authority; the code mirror is written with every publish to `live_code(leased board tip)` and is never read for a decision (INV-ENG-AUTH).

### 3.2 Storage layout

**Why one GIT_DIR.** A private GIT_DIR would have to mirror the user's filters, autocrlf and attributes; any drift is the critical secret-leak class (filter-passthrough-leak, secret-filter-fails-open-in-daemon-env, VERIFIED). Refs under `refs/worktree/*` vanish with the worktree and have no reflog (park-refs-in-worktree-namespace-vanish, VERIFIED); objects referenced only by a private index are pruned (objects-only-in-private-index e8, VERIFIED). Custom namespaces get no reflog unless `core.logAllRefUpdates=always` (no-history-undo e7, VERIFIED).

**State commit.** `refs/cowork-local/<e>/state` points to a commit (never pushed, message `cowork-state`, author/committer as glossary §5):

- parents `[LA_C, LA_B]` — both remote commits, so they stay reachable when a `+` fetch overwrites `refs/cowork-remote/*`;
- tree:

```
base     tree   A (per-path base; stored form)
snap     tree   S_disk at the last transition
meta     blob   meta.json (below)
journal  tree
  intent.json   blob   {"kind":"none"} | apply intent | push intent | adopt intent (LIF-)
  t/            tree   trees an intent references: t/M (M_disk), t/S (S_disk at intent), t/TIP (tree(TIP)), t/P (P)
  ready/<k>/    tree   ready pairs (glossary §3, HLD-40/41); <k> = base64url(cs_id); ready/<k>/R (unmasked S_disk at the trigger, rebased)
                       and ready/<k>/A (A_cap) are sparse trees holding only that CS's paths
  keep/<name>   tree   trees other chapters ask the engine to keep reachable (e.g. keep/pre_freeze for LIF- resume)
```

Making `journal` a tree (not a blob holding oids) is what keeps every referenced object reachable for `git gc --prune=now` (INV-ENG-REACH). Commits named in an intent (Bnew, C) need no reachability: if they landed, a fetch brings them; if not, they are discarded.

**meta.json** (UTF-8 JSON, no wall-clock or monotonic timestamps; every timer restarts at daemon restart, INV-CLOCK):

```
{ v: 1, proto: 1,                          // v = meta_v of LIF-37 (forward-only migration)
  peer_id, epoch, seq_next,                 // op identity (PRO-08, PRO-09); seq_next persisted before every push
  branch, enc,
  pinned: { url, identity: [root oids] },   // set by LIF- start (§3.3.1), read by every network call
  H_adopt, EPOCH_BASE,
  expected_epoch: { symref, head, stash },  // input of LIF-'s HEAD decision table (LIF-11)
  freeze_reasons: [EPOCH|MASS|PAUSED|INCIDENT|CONFIG|NOHOOKS],
  config_detail: [url|identity|filter|public],   // glossary §8 CONFIG detail; empty unless CONFIG is set
  incident: null | { n, observed_board: oid|null, observed_code: oid|null },
  nonretryable: null | { lease: oid, hold_id },
  rejections: null | { lease: oid, n },       // rejection streak (§2, ENG-44; glossary §26.2 item 2)
  throttle: null | { signal },              // own throttle fallback (§2, §3.12, ENG-46; glossary §27.2); no timestamp:
                                            // the 30-min timer restarts at daemon start, then null when it ends
  pending: { "<path>": "<defer reason>" },
  displaced: [oid12, ...],                  // displaced refs known on the remote for this branch (cap 3)
  since: { seen_h, return_h, run_h } }      // optional (rev 2.5, F04 catch-up marks): heights only; persisted with the
                                            // next transition or the drain's state write ("Transitions only" below);
                                            // absent = no marks; the meta parser MUST accept the key (absent, or
                                            // exactly three non-negative safe integers) before any build writes it,
                                            // so no meta.v change (LIF-37, ENG-05)
```

**Transitions only.** The state ref is updated by exactly one `git update-ref --create-reflog refs/cowork-local/<e>/state <new> <old>` (fsync flags, glossary §18) per transition, never for a snapshot that changed nothing else. Detection ticks keep their result in the stat cache and the stage copies, write no object (glossary §26.1 W6) and never update the state ref; a materialized snapshot that changes nothing else stays in the private index. This bounds object churn and reflog growth. A CAS failure means a second writer: the daemon logs it to `log/security.jsonl` and exits. A change of `meta.since` alone (F04: `seen_h` and `return_h` are folded board heights set on human activity, 06-claude §3.12.2; `run_h` is the `to` of the last accepted `/cowork since`, 10-product §3.9a) updates the in-memory meta and waits for the next transition. The one exception: a drain at exit (the lease-expiry exit of §3.5, the version drain of §3.15, LIF- `stop`) whose only change is `meta.since` writes it in one CAS update, so F04 causes at most one `meta`-only state-ref update per daemon lifetime; a mark lost with the process only makes a catch-up range longer. _(rev 2.5, F04)_

**Files** are exactly glossary §6 (the state commit's `journal/` layout is glossary §4's). Engine-specific use of `tmp/`: `<n>.new`, `<n>.old`, `<n>.redo` (writer ring), `cmp.index` (DISK_EQ scratch), `canon.index`, `out.index` (scratch indexes), `stage/<p>` (stage copies of staged reads, §2, ENG-27; glossary §26.1 W1). Nothing in `tmp/` is a store; every byte the ring holds is either already in git or turned into a hold record at once (INV-NOLOSS). A stage copy holds bytes that are still on the user's disk or already in git: a `dirty` copy is kept until it is materialized or a later staged read supersedes it, a `clean` one is deleted at once, and all stage copies are deleted at restart; their content rules (user-only directory, never logged, never pushed) are SEC-'s (09-security scope, glossary §26.1 W1).

`CLAUDE_PLUGIN_DATA` holds no correctness state; deleting it never changes sync state (uninstall-deletes-state-daemon-orphaned, orphan-daemon-uninstall).

### 3.3 Git usage

Every git process goes through `runGit` (glossary §18, SEC-). The engine adds:

1. **Absolute paths.** `GIT_INDEX_FILE`, `--git-dir` and `--work-tree` are always absolute. VERIFIED (sweep/engine_rc): a relative `GIT_INDEX_FILE` with `--work-tree` resolved inside the work tree and failed `Unable to create …index.lock`. The engine's runner wrapper rejects a relative value before spawning.
2. **Bytes are Buffers.** File bytes never become JS strings. Read-only analysis decodes with `TextDecoder('utf-8', {fatal:true, ignoreBOM:true})` (daemon-text-handling-corrupts-cp949-bom, VERIFIED).
3. **Three blob-producing operations only** (03-data §3.1 routes (a)–(c), §2 "blob routes"): (a) the private-index `git add` of stage copies, for paths without a clean filter; (b) `git hash-object -w --path=<p>` of a stage copy or of stdin (every filtered path, records of denied edits, late `.old` bytes read by a staged read); (c) `git hash-object -w --stdin --no-filters` for canon output (DAT-). Board and hold records therefore carry clean-path blobs only (board-plaintext-and-permanence, splice-text-from-worktree-leaks-secret). At a detection tick routes (a) and (b) compute ids only and write nothing (glossary §26.1 W6, 03-data §3.1 (2b)).
4. **Four tree-producing operations only:** (1) `write-tree` of an index; (2) `merge-tree --write-tree -z --merge-base=<explicit tree> <ours> <theirs>`; (3) whole-path entry replacement in a scratch index (`update-index --cacheinfo` / `--force-remove`) using blobs that already exist; (4) `commit-tree` of an existing tree. No hunk subtraction, symbol splicing, marker-bearing merge output or stored patch application ever produces a tree (hunk-withdrawal x2/x1b, intra-file-withdrawal, move-splice-duplicates, csharp-overload-group-splice, all VERIFIED). The sole -U0 exception in glossary §9, HLD-'s `taintOnlyH1()`, produces only a hold record's `h1` blob, never a tree, an outgoing blob, a working-tree file or a saved blob; glossary §9's reverse-merge exception `revertInverse()` (05-holds HLD-12, Algorithm REV; rev 2.5, F10) reaches a tree only as disk content that its human-confirmed `writeLocalGroup` wrote and HLD-40 then captures, never directly.
5. **Typed oids.** Every oid is parsed into an `Oid` type accepting only `^[0-9a-f]{40}$|^[0-9a-f]{64}$`, and verified with `cat-file -e <oid>^{commit|tree}` before it reaches `commit-tree`, `update-ref` or a refspec. Pushes are composed only by `push(newOid: Oid, ref, lease: Oid | ABSENT)`, which cannot emit an empty source (VERIFIED empty-oid-push-deletes-live-ref: `push … :refs/cowork/main/code` deleted the live ref).
6. **Classification by exit code, structured output and outcome** (glossary §18, §26.2 item 2): `-z`, `--porcelain`, `diff-files`, `ls-files`, `ls-remote` output; never stderr text. A push rejection is classified by what a re-fetch shows (ENG-44), never by its text. Host messages are shown to humans (sanitised, within the glossary §19 cap of the carrier that shows them) but never drive a decision; message text may only select an explanation or make handling stricter (glossary §18, SEC-04), and it never decides lease loss, transient or NONRETRYABLE (glossary §26.2 item 2).
7. **No git process reads a user's working file** (glossary §26.1 W1: `git add` on the working file holds it as a memory mapping while hashing, and a concurrent truncating editor save then fails with Win32 1224 `ERROR_USER_MAPPED_FILE`; MEASURED 11.4 failed saves per 1,000 vs 0 / 963 in-place failures with staged copies). Every command that reads working-tree content (`add`, `update-index --add|--refresh|--really-refresh`, `hash-object` of a path, any work-tree diff) reads stage copies only (`--work-tree=<tmp/stage>` or an explicit stage-copy file argument); listing commands that read only directory entries or attributes (`ls-files -o --exclude-standard`, `check-attr`) may name the real work tree. The same single code path runs on every OS.
8. **Filters run with cwd = the repository root** (glossary §25 F12: a pilot team's driver names its script by a repo-relative path). Every command that may run a clean or smudge filter (route (b), `cat-file --filters`, DAT-'s preflight) is spawned with cwd = the main-worktree root and without `--work-tree=<tmp/stage>`; that is why filtered paths use route (b) and never route (a) (REASONED: a command given `--work-tree` changes into that directory before it runs filters; test 46 proves the rule with a repo-relative driver).

**DISK_EQ(p, X) mechanics.** DISK_EQ is defined in glossary §3 (refresh the private-index entry for p with index context and compare against X under canon); this section fixes how the engine computes it. Bare `git hash-object --path` disagrees with the stored blob for i/crlf files: VERIFIED (git 2.55.0.windows.3, `core.autocrlf=true`, BOM+CRLF file stored i/crlf) `hash-object --path=big.py` = a40da32 while the stored blob = 32315a1; the private-index add kept 32315a1, and `--cacheinfo 32315a1` + `--refresh` reported up to date. So unfiltered comparisons use git's check-in path with index context, and since glossary §26.1 W1 they run on a stage copy, never on p itself (changed per glossary §26.1 W1 and §26.2 item 3: disk comparisons always go through DISK_EQ, never through `hash-object --path` of a working file against a blob):

```
DISK_EQ(p, X):
  ABSENT: X == ABSENT ⇔ lstat(p) reports ENOENT
  (1) fast path, no read: the stat-cache entry of p is clean, lstat(p) still equals its stat, and X == S_raw[p] → equal
  (2) otherwise one staged read of p (§2); UNSTABLE or UNREADABLE → "not equal" with that reason (callers defer)
      p without a clean filter: in tmp/cmp.index, a scratch index holding only p's entry X (X is p's index context):
        GIT_INDEX_FILE=<cmp.index> git update-index --add --cacheinfo <mode>,X,p ;
        GIT_INDEX_FILE=<cmp.index> git --work-tree=<tmp/stage> update-index --refresh   (never -q, and no path
          argument, which would hash and store the copy; rc 0 or 1 both normal, its rc and "needs update" text are
          never read as the result; any other rc → not equal, callers defer)
        GIT_INDEX_FILE=<cmp.index> git --work-tree=<tmp/stage> diff-files -z --name-only  → p not listed ⇔ equal
      p with a clean filter (route (b), cwd = repo root, no -w; filtered paths get no canon, 03-data §3.4):
        hash-object --path=<p> <stage copy> == X ⇔ equal
  (3) bytes not at p (a file F elsewhere, e.g. a ring .old): staged read of F into tmp/stage/<p>; then as (2)
  the stage copy is deleted after the comparison unless the snapshot keeps it as p's dirty copy
MANY CANDIDATES (restart, lost state and its reseed/re-anchor uses, round-trip check):
  one staged read; raw blob r of the stage copy (route (a) into a scratch index for an unfiltered path, route (b)
  with -w for a filtered one); r is written only because every caller is an apply step (the round trip, ENG-34;
  restart's resolution of a journaled apply intent, ENG-53) or a hold-record step (the lost-state per-path rebuild,
  ENG-54, also run by the §3.7 step 2a re-anchor and the DAT-26 reseed, whose unmatched disk bytes become a
  `restart` record), the apply and hold-record occasions of glossary §26.1 W6; no other caller may use this form;
  unfiltered: for each candidate c: canon(r, ref=c) == c   (DAT- canon is a pure byte transform; candidates read by one cat-file --batch)
  filtered:   for each candidate c: r == c
```

The update-index form writes no object (REASONED: a refresh only compares; test 47 checks the loose-object count). `update-index --refresh` is used only on a private or scratch index whose work tree is `tmp/stage`, never with `-q`, and its equality result is always read from the structured `diff-files -z` that follows it on the same index, never from the refresh's exit code or "needs update" text (glossary §25 F12: `-q` hid "needs update" while the old filter preflight exited 0; §26.2 item 3; the same rule as 03-data DAT-47 and ENG-58). A filtered path whose stored blob depends on index context (a filtered path stored i/crlf) can read as "not equal" through route (b); for a DISK_EQ caller the result is a deferral or a PHANTOM record, never a wrong write (REASONED). The snapshot side of the same case is §8 question 12. `.old` files in the live ring are compared by stat identity (size, mtime_ns, file id) against the stat captured at p immediately before the rename, not by content.

### 3.4 Commit shapes and trailers

Live code commits have exactly three shapes (glossary §3): **genesis** L0 (no parents, `tree(Hr)`, `Cowork-Base: <Hr>`), **ordinary** (one parent, the previous live code commit), **base-move** (parents `[previous live code commit, X]`, X a branch commit, `Cowork-Base: <X>`). Board commits have parents `[previous board commit, live code commit]` (genesis board: `[L0]`). No branch commit ever has a live commit as an ancestor, because save commits are built only with `commit-tree tree(Lk) -p <Hb>` (LIF-) and carry no skip markers.

Every live code and board commit: subject begins `[skip ci] ***NO_CI***` (GitHub Actions `on: push` did not run for `refs/cowork/*` with or without the markers, glossary §25 F8; the markers stay for other hosts); trailers exactly as glossary §5 (`skip-checks: true`, `Cowork-Proto: 1`, `Cowork-Writer: <peer_id>/<epoch>/<seq>` whose seq is greater than every op seq in that publish, with the code commit and the board commit of one publish intent sharing the value, so that `presume_absent.last_seq_seen` compares against it; one `Cowork-Seat: <seat_id>|human` per distinct contributing seat or human on code commits; `Cowork-CS` and `Cowork-CS-Paths` (when the CS has ≤ 256 paths) per published CS from HLD-; `Cowork-Base` on base-move commits). Author and committer: `<display name> <peer_id@cowork.invalid>` set explicitly via `GIT_AUTHOR_*`/`GIT_COMMITTER_*` with timezone `+0000`; never signed (`-c commit.gpgSign=false`). Wall-clock commit dates are display only.

The board tree (`ops.jsonl`, `protocol.json`, `checkpoint/state.json`, `held/<hold_id>/<stage>/<repo path>` with stage ∈ `h0, h1, s1, s2, s3` and no entry for an ABSENT side; glossary §3, PRO-02) is produced by PRO-'s board builder from the fold and the pending ops; the engine supplies parents, trailers and the push. Board commits are never merged: a CAS loser rebuilds its board commit on the new tip.

**Reading a commit object** *(Plan 2 merge, final review FA-1)*. Every commit header the engine reads (shape checks, the incident CHECK, board and live-code reads) is parsed exactly as git's `parse_commit_buffer` parses it, so cowork never sees another tree or other parents than git does for a commit git (and fsck) accepts: the first header line must be `tree <hex>`; the parents are only the consecutive `parent <hex>` lines right after it; every later header (a second `tree`, a `parent` after `author`/`committer`) is ignored; and hex digits of either case name the same (lower-case) oid.

### 3.5 The loop

One daemon per clone serves one live branch. Iterations never overlap. Period: 2.5 s while any local seat is active or work is pending, 10 s idle (glossary §20). **A peer never runs two fetches at once** (glossary §25 F10: a fetch of one explicit refspec took p50 1.06–1.21 s, p95 up to 1.57 s): the next fetch starts ≥ 2.5 s after the previous one started, or right after it ends if it took longer; an out-of-cycle fresh-fetch request that arrives while a fetch is in flight waits for that fetch instead of starting another.

**Preconditions for apply and publish** (fetch and fold need none of them, except that `FREEZE(CONFIG)` with detail `url` or `public` forbids every network call on the branch, fetch included; glossary §8):

- a valid lease exists (CCI-50: seat lease or human CLI lease); after 2 min without one the loop stops syncing (glossary §20 seat numbers): no new capture, snapshot publish or apply, only the flush of already-captured ready pairs and pending board ops that CCI-50 allows; after 10 min the daemon drains and exits, so an orphaned daemon cannot keep syncing (orphan-daemon-outlives-sessions-and-plugin, VERIFIED H5); its last `status.json` write sets `state: "down"` and `message_code: "IDLE_NO_SESSION"` (glossary §25.2 item 6; ENG-56);
- restart recovery (ENG-53) has completed;
- `.git/index.lock` is absent (ENG-15);
- the FREEZE reason set and publish pauses allow the step (ENG-17, ENG-19, ENG-55; push classes per state: PRO-45).

**Algorithm (one iteration):**

```
0  GATES
   a. suspend gap (Δwall − Δmono > 5 s since last iteration) or watchdog kill → abandon in-flight
      network calls; this iteration must fetch before any apply or publish decision; PRO- marks own claims SUSPECT
   b. index.lock present → do 1–2 only (ENG-15)
   c. epoch observation (read set + HEAD decision table: LIF-10, LIF-11) → set/clear FREEZE(EPOCH)
   d. pinned URL / identity / filter-set / public drift (LIF- §3.3.1, SEC-11 checks) → set FREEZE(CONFIG) with detail;
      CONFIG(url|public) → skip 1–2 and 6 (no network call), continue with 3–4 and 7
1  FETCH (ENG-18); on failure → OFFLINE logic (AUTH is only its label, ENG-19), continue with steps 3–5 against
   the last successfully checked T (no publish), then 7
2  INCIDENT CHECK (ENG-20) on T and TIP → on failure enter INCIDENT (ENG-21), skip 3–6
   FOLD (PRO-) from LA_B to T, including checkpoint verification (PRO-28) and teamRegionSpec (PRO-48); VERSION check (ENG-55)
   BRANCH MOVE (ENG-47): classify Hr vs Hb; may queue a base-move publish or create base-move holds
3  SNAPSHOT (ENG-23..27): detection tick by staged reads, no object written (glossary §26.1 W1, W6); §3.8 steps 7–9
   MATERIALIZE → S_raw, S_disk only when this iteration captures a ready pair (including the candidate capture
   of an edit checkpoint, glossary §27.1), applies (step 5 admitted), or creates or refreshes a hold record from
   disk bytes (§3.8; glossary §26.1 W6); hook requests never materialize
                                                   [skipped while a Bash/PowerShell TXN is open]
4  OUTGOING GUARDS, before any merge or capture of this iteration:
   HLD- mass-change breaker on every detection tick's dirty set (may set FREEZE(MASS)); HLD- revert detector on
   the newly materialized S_disk; S_pub := MASK(S_disk) (HLD-); assert INV-MASK
   CAPTURE (after the guards): a change-set boundary captures its ready pair (HLD-40); an edit checkpoint builds
   the candidate capture, calls the edit check (≤ 0.5 s, glossary §27.1; 04-regions/05-holds) and journals the
   candidate as the CS's ready pair only on a pass (one state update); a fail journals nothing
5  APPLY (ENG-30..36) if not frozen, not coalesced, no TXN, and ∃p: A[p] != TIP[p]
   → one state update; HLD- ready rebase (HLD-41) in the same update; then LIF- adopt check (LIF-28)
6  PUBLISH (ENG-39..46) if the governor grants a window (PRO-40, with the glossary §27.2 parameters and the
   throttle fallback, §3.12) and there is a base move, a ready delta or pending ops allowed in the current state (PRO-45)
   → compose P, journal push intent (state update), push, classify, state update
7  STATUS (ENG-56): write status.json; queue engine events (ENG-57)
```

**Out-of-cycle iterations.** Three requests start an iteration immediately instead of waiting for the period, with at most one iteration in flight: (a) a gate request for a fresh fetch (PRO-37 SUSPECT self-guard: own last fetch/push older than 60 s by max(Δwall, Δmono), or suspend gap > 5 s; the gate waits ≤ 5 s) runs steps 0–2; (b) a hook-driven change-set boundary (HLD-40: Stop, StopFailure, SubagentStop, SessionEnd, green checkpoint, `cowork_checkpoint`, human quiet or `/cowork done`) runs steps 0–4 so the ready pair is captured from a fresh snapshot (`R = S_disk` at the trigger, unmasked; glossary §3); (c) an **edit checkpoint** (glossary §27.1 (a), added in rev 2.4: the PostToolUse of `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, or the close of a Bash/PowerShell TXN, reported by CCI-) runs steps 0–4 with the edit-check capture of step 4. An edit checkpoint does not start its iteration before step 2's quiet period (mtime ≥ 300 ms old, §3.8) has passed for the paths the hook names, i.e. at most ≈ 300 ms after the edit; the quiet period is never waived for hook-named paths, because it is what keeps a half-written file out of a capture. Edit checkpoints that arrive while an iteration is in flight or waiting coalesce into one iteration (newest passing capture wins anyway, glossary §27.1); one that arrives while a TXN is open on the worktree waits for the TXN close, which is itself an edit checkpoint. Neither (b) nor (c) bypasses the step 0 gates or the lease rule (after 2 min without a lease no new capture is taken, §3.5 preconditions, CCI-50). A failing edit check is not an error: it creates no record, no event and no message (glossary §27.1; 07-coordination), and at turn end the ordinary (b) boundary applies (a CS still failing T0 then becomes a K7 PIN as before, HLD-). The other HLD-40 triggers — the seat-end close, the HLD-34 fallback close (10 min without a hook, glossary §20) and the HLD-36 close of a `recovered` CS — are decided inside an ordinary iteration and start no out-of-cycle iteration: their capture is the `S_disk` of the iteration that closes the CS (HLD-40), and a group whose readiness HLD-41 cancelled with every member closed is re-captured from the next completed snapshot.

The detectors in step 4 run before the apply merge and before any ready capture of the same iteration (an edit checkpoint's candidate capture included), on the `S_disk` that iteration materialized, so a stale-buffer save, a `/rewind` "Restore code" or a Bash rewrite saved in the same loop as an incoming change is classified before it can be blended or captured (stale-editor-buffer-reverts-peer-work, rewind-restore-code-reverts-teammates). A detection tick that materializes nothing changes no `S_disk`, so the revert detector has nothing new to read; every byte that can reach a merge, a capture or a record passes it first (changed per glossary §26.1 W6: the detector no longer runs on every tick; the mass-change breaker still does, on the dirty set).

The apply trigger is "any `A[p] != TIP[p]`" over applicable paths, not "TIP != LA_C": after this peer's own push sets LA_C := C, a pending path still has `A[p] != C[p]` and must be retried as soon as its defer reason clears (INV-ENG-PROGRESS; VERIFIED pending-path-base-misset-reverts). Not-applicable paths (unmaterializable, collision, quarantine review) are re-evaluated every loop and join the trigger again once their INCOMING record's guard releases (DAT-29, DAT-33, SEC-33). `UNMANAGED` paths never trigger a write: their `A[p]` follows `TIP[p]` in the apply's state update (DAT-26).

### 3.6 Fetch, offline and publish pauses

The fetch is exactly the glossary §4 refspecs against the pinned URL, never the remote name, with the runner's network class (`--no-write-fetch-head --no-auto-maintenance --no-tags`; fetch-head-hijack-and-auto-maintenance VERIFIED e5). `git fetch` with an explicit refspec whose source is missing fails as a whole; so on a failed fetch the engine runs one `git ls-remote <url> refs/cowork/<e>/board refs/cowork/<e>/code refs/heads/<b>` and, if the remote answered, re-fetches only the refs that exist and records the absent ones: absent board → genesis (no state ref) or INCIDENT (state ref exists); absent mirror → mirror lease `ABSENT`; absent branch → `BRANCH_REWRITTEN`.

The fetch runs against the active namespace (glossary §4: `refs/cowork/<e>/…`, or `refs/heads/cowork/<e>/{board,code}` only after the opt-in fallback of PRO-50); every rule of this chapter reads "board" and "mirror" as the active namespace's refs.

**Publish pauses** (glossary §8; not FREEZE; applying continues; what may be pushed in each: PRO-45):

| Pause | Entered | Lifted |
|---|---|---|
| `OFFLINE` / `AUTH` | no successful fetch for > 30 s (Δmono). They behave identically; `AUTH` is only the label shown when SEC-18 derives the explanation `auth` from structured evidence. The event and `status.json.message_params` carry `offline_for_s`, the local Δmono since the last successful fetch, refreshed at every status write (glossary §25.2 item 4) | next successful fetch |
| `NONRETRYABLE` | ENG-45: the third consecutive host rejection of the same publish with the board unchanged (glossary §26.2 item 2) | human `/cowork resume` (one retry; the rejection streak restarts at 0): it first ends the `host-reject` PIN that `meta.nonretryable.hold_id` names, so that PIN no longer holds the rejected publish back (05-holds: "lifted by human `/cowork resume`"; Plan 2 merge, ruling R-28 as amended by final review FC-5) |
| `VERSION` | ENG-55: board `proto` ≠ 1 (zero pushes of any kind), or own regionSpec ≠ teamRegionSpec (code pushes paused, PRO-45 board-only ops allowed), or a persisting checkpoint mismatch (PRO-28, `cause = checkpoint_mismatch`) | the condition no longer holds (PRO-28, PRO-47, PRO-48) |

Failed network attempts back off 30 s doubling to 5 min, no bursts; the same backoff paces the retries of transient push rejections (ENG-44). A push rejection is not a network failure and never sets `OFFLINE`/`AUTH`: it is classified by outcome (ENG-44, glossary §26.2 item 2). While `OFFLINE`/`AUTH`: snapshots, ready captures and local holds continue; nothing new is applied (nothing new is fetched); no push of any kind is attempted and publishes queue. On reconnect the ordinary loop runs (fetch → incident check → fold → branch move → apply → publish with every guard against the fetched tip); there is no separate reconcile mechanism (`OFFLINE_RECONCILE` batching is v2, glossary §22) (offline-split-brain, offline-auth-claims).

### 3.7 Incidents and recover

**Check, every iteration, before any fold, apply or merge** (INV-FIRSTPARENT; a bare `merge-base --is-ancestor` passes a rewrite that keeps the old chain as a second parent):

```
FP_OK(old, new):  new == old
               or (L = rev-list --first-parent old..new) non-empty and parent1(oldest(L)) == old
CHECK: FP_OK(LA_B, T)  and  FP_OK(LA_C, TIP)
       and every commit in LA_B..T (first-parent) has the board shape
       and every commit in LA_C..TIP (first-parent) has one of the three live shapes
       and the board ref exists
```

**Incident.** On failure: set `FREEZE(INCIDENT)` with `meta.incident = {n, observed_board, observed_code}`; store T at `refs/cowork-local/<e>/incident-<n>`; apply nothing, publish no code or board commit; emit `INCIDENT` (old and new oids) to the human and to every live seat's Claude. Push **one** governed copy of `LA_B` to `refs/cowork/<e>/displaced/<oid12(LA_B)>` with an `ABSENT` lease (an existing ref with the same value counts as done) unless 3 displaced refs already exist for the branch, in which case the copy stays local and the status says so. This copy is the displaced ref glossary §4 defines for the incident window ("a copy of this peer's LA_B at detection"); it is the only daemon push during INCIDENT, it writes no board, mirror or branch ref, it is governed and counted (PRO-41), and it makes the pre-incident chain durable on the remote. Every other push on the branch is forbidden while INCIDENT is set (glossary §8), except the human-typed `/cowork recover` below.

**Recover** (human-typed `/cowork recover`, preview id + `--confirm` per glossary §15, human evidence per SEC-25; verb surface LIF-/UX-, mechanics here):

```
1  refuse RECOVER_NOT_IN_INCIDENT unless INCIDENT is set; refuse RECOVER_OFFLINE{fetch} unless a fetch succeeds now
   (a human recover fetches at once, ignoring the network backoff of §3.6);
   V = the board tip of that fetch (ABSENT if the board is gone);
   a confirm first resolves a kept push intent by observation (unresolved: RECOVER_OFFLINE{push_intent_unresolved},
   state unchanged), then re-plans; a confirm whose preview id no longer matches is refused RECOVER_PREVIEW_STALE
   with the fresh preview                          (Plan 2 merge, Task 16 ruling)
2  candidates = {LA_B} ∪ {every refs/cowork/<e>/displaced/* listed by ls-remote, fetched by explicit name}, minus
   recover's own copies of an observed V (displaced/<peer>/v-<n>, step 4); a displaced value equal to V stays a
   candidate                                       (Plan 2 merge, Task 16 ruling)
2a TEAM ALREADY RECOVERED: if all of these hold, an earlier recover restored D and the team has continued on V:
   (i) V exists and is on the first-parent chain of no candidate other than V itself (a plain rewind never
       qualifies; this is the only place a candidate equal to V is left out);
   (ii) D = the newest common first-parent ancestor of V and this peer's LA_B is a displaced candidate, D != V
        (computed as the first commit of `rev-list --first-parent LA_B` that also appears in
        `rev-list --first-parent V`, never `git merge-base`, ENG-58; a recover restores exactly a candidate, so
        late peers fork from the team exactly there; a rewrite forks wherever it was made);
   (iii) the full incident CHECK passes from D to V (FP_OK(D, V), FP_OK(live_code(D), live_code(V)), board
        shapes on D..V, live shapes on the code range), so a bad-shaped commit on top of D never qualifies.
   A first-parent walk of (i)–(iii) that fails refuses RECOVER_OFFLINE{walk}: 2a fails closed, never falls through
   to step 3 (Plan 2 merge, Task 16 ruling). The re-anchor needs HEAD symbolic on refs/heads/<b> with no operation in
   progress, as the lost-state rebuild does (else RECOVER_HEAD_STATE{op}). Then recover MUST NOT force-push and MUST NOT push V to
   a displaced ref. Before any state change it stores this peer's LA_B at refs/cowork-local/<e>/incident-<n>-own
   (glossary §4; with --create-reflog), so the pre-incident chain stays reachable even when ENG-21's displaced copy stayed
   local because the cap was full; then crashpoint("recover.reanchor") (11-testing §3.6), which lies before the state
   update that ends the rebuild below. It re-anchors this peer on V instead: the lost-state per-path rebuild of §3.14 with T = V
   (A per path from V's chain; disk bytes matching no version there, which include this peer's own commits that
   are not on V's chain, become 'restart' PATCH records kept on disk, masked and mirrored like any other hold (LIVE paths
   only; path-class-masked paths are reseeded without a record, §3.14); journaled ready pairs are rebased onto the rebuilt A per HLD-41 in
   the same state update — the rebuild writes no file, so a rebase conflict on p is decided by HLD-41's fourth case (added in
   rev 2.1: A[p] changed without a write), which decides it as the displaced-local-side case (the local bytes are in the restart record): the group's readiness is cancelled
   and it is re-captured per HLD-41; LA_C := live_code(V), LA_B := V, new epoch), clears INCIDENT and emits
   LOST_STATE{mode: re_anchor} with the list of records. This peer's displaced copy of its LA_B (ENG-21) keeps those commits on the remote.
   The preview shows this mode and the paths that would become records. Stop here.
3  X = the candidate that has every other candidate on its first-parent chain; none → RECOVER_AMBIGUOUS (list oids
   and displaced ref names); X MUST pass the incident CHECK from LA_B (its chain board-shaped, its live code chain
   live-shaped), else RECOVER_AMBIGUOUS{reason: x_check}: an X that fails it is never force-pushed. Both run in the
   plan, before any push or crashpoint (a preview refuses too)   (Plan 2 merge, Task 16 ruling)
4  if the observed bad board value V exists, is not on X's first-parent chain and no displaced ref holds it already
   (a re-run after a kill or a failed recover push):
       push V to recover's own refs/cowork/<e>/displaced/<peer>/v-<k> (k above every listed v-<n> of this peer) with
       an ABSENT lease; it counts toward the 3 displaced refs of glossary §20
       (no free displaced slot → RECOVER_DISPLACED_FULL; the human removes an old displaced ref manually, README)
       (Plan 2 merge: was displaced/<oid12(V)>; the per-peer v-<k> name is what step 2 excludes)
   crashpoint("recover.displaced")   (after step 4, before step 5; 11-testing §3.6)
5  push X with --force-with-lease=refs/cowork/<e>/board:<V | ABSENT expect>   (the only non-FF daemon push, INV-FF)
   and, in the same push, live_code(X) with --force-with-lease=refs/cowork/<e>/code:<fetched mirror | ABSENT>
   (the mirror may sit on the displaced chain, where ENG-43's ancestor test would never include it again;
   a mirror line that is not ok is ignored as in ENG-44)
6  on board ok: clear INCIDENT; the ordinary loop resumes; a mirror line that was not ok leaves the mirror
   stale until a publish whose ENG-43 test includes it (the mirror is never a decision input, INV-ENG-AUTH)
```

**Windows of the incident pushes** *(Plan 2 merge, ruling R-21 as read in Task 16)*. The ENG-21 detection copy of `LA_B` is governed and counted and waits for an ordinary governor window like any attempt (PRO-41). Recover's step-4 copy of V and its step-5 push are governed and counted too, but exempt from the window: a denial by the per-peer cap or the team guard is waited out for a bounded time, and a push the governor still denies after that wait refuses `RECOVER_OFFLINE{denied}`.

On every other peer INCIDENT is lifted by the effect of that recover (glossary §8 "every other peer clears it when its first-parent check passes again"): when the incident check passes again on a fresh fetch, the reason is cleared, PRO-25's refold runs, and `UNFROZEN` is emitted. A peer whose `LA_B` is ahead of X (X is a strict ancestor of its LA_B) keeps failing the check and its human runs recover there; ancestry, never clocks, decides which tip is newer. That recover force-pushes only while the team has not yet built on X: once the current tip forks from this peer's chain exactly at a displaced candidate and descends from it through a passing incident check (step 2a), the late peer re-anchors on the current tip and keeps its newer, unshared commits under `incident-<n>-own`, as records and as its displaced ref (glossary §4 and §8 "Lifted by", owner-confirmed in glossary §24), because force-pushing again would displace the team's newer chain and leave every other peer in `RECOVER_AMBIGUOUS` (REASONED, not run: a peer asleep through both the rewind and the first recover otherwise rewinds the team a second time; test 35). A missing or rewound mirror is never an incident. The recover preview and report wording for both modes (including the paths that become restart records in re-anchor mode) belongs to LIF-/10-product; the codes are this chapter's (§2).

### 3.8 Snapshot

Changed per glossary §26.1 W1/W6 (rev 2.3): the snapshot no longer runs `git add` on working files and no longer relies on the private index's stat data. It reads each stat-dirty file once into a stage copy (§2 staged read), computes ids without writing objects at every tick, and writes objects only when the iteration materializes (§2). Step numbers 7–9 keep their meaning for 11-testing §3.6 (steps 4–7 update the private index when the iteration materializes, step 8 is `write-tree`).

```
SNAPSHOT:
  skip entirely while any live seat on this worktree has an open Bash/PowerShell TXN (CCI-, cap 120 s)
  1  candidates (metadata only, no file content is read):
       every path of the private index whose lstat (size, mtime_ns, file id, mode) differs from its stat-cache entry
       (no entry, or ENOENT, counts as different)
       ∪ new files admitted by DAT- Algorithm D6 (ls-files -o --exclude-standard -z on the private index;
         NOT_ADMITTED paths are never added)
     a platform stat that opens a handle closes it before the next path is queried (glossary §26.1 W3)
     scope class per path from DAT- `scopeOf` (glossary §3):
       LIVE, SAVE_ONLY, QUARANTINED, LOCAL_ONLY (secret-scan) → read and hashed (the last three are reset by MASK in §3.5 step 4)
       UNMANAGED → dropped: never read or hashed, entry stays A[p] (DAT-26), never staged as a removal
       a path whose class changed from UNMANAGED to any other class (new EPOCH_BASE, ENG-50, or a mode change away
         from 120000/160000) → before it is hashed for the first time in its new class, A[p] is reseeded by the
         lost-state per-path primitive of §3.14 (DAT-26) in one state update; the difference between the old A[p]
         and the disk is never treated as a local delta
       LOCAL_ONLY under a `filter-failure` record → dropped until the record resolves (DAT- §3.4)
  2  per candidate: skip (keep its stat-cache entry) if under a live Edit/Write/MultiEdit/NotebookEdit fence (CCI-),
     or if now_wall − mtime < 300 ms (local clock; if mtime is in the future, require the stat to be unchanged
     for ≥ 300 ms Δmono instead); never waived for hook-named paths: an edit checkpoint's iteration starts only once
     its paths are past this window (§3.5 (c), glossary §27.1)
  3  deletion: a path missing on disk is dirty as a removal only if it was also missing in a snapshot ≥ 1 s earlier
     (Δmono) or the removal falls in a hook-attributed window (CCI-: tool call, TXN, git rm)
  4  STAGED READ (§2; glossary §26.1 W1) of every remaining candidate → stage copy tmp/stage/<p>, or
     UNSTABLE / UNREADABLE for this tick (stat-cache entry and private-index entry unchanged)
  5  DETECT (ids only, no object written; glossary §26.1 W6, 03-data §3.1 (2b)):
     split U = candidates without a clean filter, F = candidates with one (filter attribute from
       `check-attr -z --stdin filter` under attr.tree=EPOCH_BASE, cached per path, invalidated when EPOCH_BASE,
       $GIT_DIR/info/attributes or core.attributesFile changes)
     U, in one call: a scratch index tmp/detect.index holding the private-index entries of the U candidates that
       have a stage copy (new paths and removals are not in it);
       GIT_INDEX_FILE=<detect.index> git --work-tree=<tmp/stage> update-index --refresh   (never -q; rc 0 or 1 both
         normal and never read as the result), then
       GIT_INDEX_FILE=<detect.index> git --work-tree=<tmp/stage> diff-files --name-only -z
       → a path still listed differs from S_raw[p] (structured output, never the refresh's rc or "needs update" text,
         §3.3 item 6, glossary §25 F12; an up-to-date entry took the stage copy's stat and is no longer listed)
     each p ∈ F in its own call, cwd = repo root (glossary §25 F12): hash-object --path=<p> <stage copy> (no -w)
       → id d; d ≠ S_raw[p] → differs (S_raw[p] of a filtered path is itself a route (b) id once it has been
       materialized, so like is compared with like; ENG-11)
       rc 128 on a filtered path → that path is LOCAL_ONLY (`filter-failure` record, DAT- §3.4); nothing is
       published this loop
     any rc other than 0 or 1 on the U refresh (e.g. 128), or a non-zero rc of its diff-files → the snapshot fails
       (no capture, apply or publish this loop)
     new paths and confirmed removals are dirty without a comparison
     differs → stat cache {stat, id, dirty}, the stage copy is kept; equal → stat cache {stat, id, clean}, the stage
       copy is deleted
  6  shrink guard on the staged size: non-empty → empty, or > 50 % shrink → excluded until stable across 2 snapshots
     and attributable (CCI-/HLD-; glossary §26.1 W2: a staged read can catch the instant after an in-place editor
     truncated the file)
  -- a detection tick ends here; steps 7–9 run only when this iteration MATERIALIZEs (§2, §3.5 step 3) --
  7  MATERIALIZE every dirty path, or only a hold record's paths when that record is the only reason (below, (c))
     (objects are written; glossary §26.1 W6):
       U paths, one call: GIT_INDEX_FILE=<private index> git --work-tree=<tmp/stage> add --ignore-errors
                          --pathspec-from-file=- --pathspec-file-nul   (route (a): index context of S_raw[p])
         rc 1 → afterwards, any p still listed by `diff-files -z` against the stage tree is UNREADABLE this loop
                (entry unchanged)
       each p ∈ F: hash-object -w --path=<p> <stage copy> (route (b), cwd = repo root), then
                   update-index --cacheinfo <mode>,<oid>,<p> on the private index
         rc 128 → that path is LOCAL_ONLY (`filter-failure` record, DAT- §3.4); nothing is published this loop
       confirmed removals: update-index --force-remove -- <p>
       every materialized path: stat cache state := clean, stage copy deleted
     force special modes (existing entries are UNMANAGED, DAT-36/37): every 160000 entry := A's value; every 120000
     entry keeps A's mode and target
     crashpoint("snapshot.index_written")   (after steps 4–7 updated the private index, before step 8; 11-testing §3.6)
  8  S_raw = write-tree (validated oid)
  9  S_disk = canon(S_raw) (DAT-), built in tmp/canon.index by whole-path replacement for p ∈ diff(A, S_raw);
     the private index keeps S_raw
```

**When an iteration materializes** (glossary §26.1 W6: objects only for ready-pair captures, publishes, applies and hold records): (a) it captures a ready pair (a change-set boundary, §3.5 out-of-cycle iterations, HLD-40), or builds the candidate capture of an edit checkpoint (§2, §3.5 (c); glossary §27.1: `merge-tree --merge-base=A R TIP` needs R as a tree, so the candidate is materialized before the edit check runs; on a fail its blobs stay only in the private index's `S_raw` and are superseded by the next materialization, and they count against the W6 soak gate like any capture, test 33, §8 question 13); (b) step 5 of §3.5 will apply (some applicable `A[p] != TIP[p]` and the apply is admitted, §3.11), because `M_disk` merges against `S_disk`; (c) it creates a hold record from disk bytes (K2/K6 PINs, HLD-) or refreshes one: a path that carries a non-terminal ON_DISK record and is dirty at this tick has its current blob written as that record's content (05-holds MASK step 5, HLD-03, HLD-21; W6's "hold records" occasion); when (c) is the only reason, only the record's paths are materialized through steps 7–9 and every other dirty path keeps its stage copy and stays dirty. These blobs count against the W6 soak gate (test 33). A hook request never materializes (removed in rev 2.3 per glossary §26.1 W6; §8 question 10). A publish needs no materialization: P is built from the captured ready pairs and A (glossary §3). The materialized blob is made from the same stage copy whose id the tick computed (03-data §3.1 (2b)). For an unfiltered path the tick's comparison and the materialized blob both use the index context of `S_raw[p]`; a dirty path whose materialized blob equals `S_raw[p]` is simply clean afterwards, and canon (step 9) absorbs a form-only difference for existing text paths.

**Hook requests** (glossary §26.1 W1, W6; 06-claude §3.7.6 item 4 "Objects only for records"; 04-regions §2 `diskSnapshotId`, REG-35). A hook that needs the current content of named paths (PostToolUse claim confirmation, REG- mapping) is answered per path with one staged read (§2), its detection id (§2 stat cache: route (b) without `-w`, or `S_raw[p]` for an unfiltered copy found equal; no private-index, state-ref or object-store write) and the read bytes held in daemon memory as a `diskSnapshotId`; UNSTABLE or UNREADABLE is answered as such. The request writes no object and materializes nothing; only a hold record the hook's handling creates (deny shadows, K2 and `wake-scope` PINs, 06-claude) writes its blob, as occasion (c) above. The same PostToolUse also reports an edit checkpoint (glossary §27.1, added in rev 2.4); that is not a hook request: it is answered by no content, and it starts the separate out-of-cycle iteration (c) of §3.5, which materializes as occasion (a). The hook's own answer never waits for that iteration.

Structural detection replaces the source catalog's stderr parsing ("unable to index file", "clean filter failed"): a path git could not index is found by structure (still listed by `diff-files` against the stage tree, or rc 128 of its own call), never by text (changed per glossary §18). VERIFIED (x2_snapshot_list.sh, measured on the former in-place add): with `b.txt` opened FileShare.None the add exits 1, indexes a, c, n, stages d's removal, keeps b's old blob; `add -A` was fatal instead (locked-file-stalls-snapshot). With staged reads such a file is refused at the open of step 4 and is UNREADABLE before git runs (test 8). VERIFIED (sweep/engine_rc): under `required=true` a failing or missing clean command aborts the whole add with rc 128 leaving the entry unchanged, which is why filtered paths are handled one by one; route (b) likewise stores nothing when the filter fails (glossary §25 F12: `required=true` aborted with rc 128 and an unchanged index in every failure mode tried).

UNREADABLE, UNSTABLE (steps 4 and 6) and not-yet-confirmed deletions are per-loop exclusions (glossary §9 transient exclusions): `S_pub[p] := A[p]` and p joins the apply defer set. HLD- turns one that lasts ≥ 60 s (local monotonic) into a record (`unreadable` / `unstable` guard). MEASURED cost: snapshot with staged copies p50 53 ms / p95 58 ms per loop on the 1.3 MB BOM+CRLF file, daemon plus git children ≈ 2.2 % of one core, borderline against the ≤ 2 % gate (glossary §26.1 W5); staged copies are made only for stat-dirty paths, which keeps idle cost low; private-index snapshot of the 4,353-file repository warm 16 ms, cold 0.58–0.62 s, real `.git/index` byte-identical (glossary §25 F13). The per-tick metadata walk of step 1 replaces git's own stat comparison and is measured by test 31 on the 4,353-file repository (REASONED, not yet measured; §8 question 8). The private index is reseeded only on join, lost state, or when `write-tree` fails because an object was pruned (`read-tree <state:snap>` into the private index, no refresh of working files; the stat cache is emptied, so the next snapshot stage-reads every tracked path once and materializes only those that differ).

### 3.9 Outgoing guards and the MASK call site

Step 4 order is fixed: HLD-'s mass-change breaker reads every detection tick's dirty set (paths only) and HLD-'s revert detector reads the `S_disk` this iteration materialized, each with the provenance journal (changed per glossary §26.1 W6, §3.5); then `S_pub := MASK(S_disk)` (MASK as glossary §3: every held path region, every `QUARANTINED`, `SAVE_ONLY`, `UNMANAGED` and `local_only` path reset to `A[p]`; operator HLD- §3.4); then HLD-'s INV-MASK assertion. A failed assertion means: no publish this iteration, a doctor record, `NOT_CONVERGED{cause: publish_assert, check: INV-MASK}` to the human and live seats, and never a fallback to pushing `S_disk`. `S_pub` is used for detection and status only (glossary §3). Ready pairs capture the unmasked `S_disk` (`R`), and masking for publication happens at publish time when P is composed as `MASK(R)` per ready, unheld group (glossary §3, HLD-42), so a record created after a capture still masks. `S_disk` is the only "ours" of an apply (masked-tree-as-apply-base-starves, VERIFIED).

### 3.10 Merges and conflict routing

Every 3-way merge of local work has one form and an explicit base (INV-BASE):

| Use | Command |
|---|---|
| apply | `M_disk = merge-tree --write-tree -z --merge-base=A S_disk TIP` |
| publish | `OUT = merge-tree --write-tree -z --merge-base=A P TIP` (glossary §3 OUT, P) |
| base move | `newtree = merge-tree --write-tree -z --merge-base=tree(B) tree(TIP) Hr` |
| writer re-merge of one path | `git merge-file -p --object-id <base> <ours> <theirs>` |

No `-X` option (renormalize flipped an i/crlf blob, ours/theirs drop a side with exit 0; DH2/DH3/e5 VERIFIED), no `--union` (SyntaxError and fused bodies, e5/DH6 VERIFIED), object-store inputs only, `attr.tree=<EPOCH_BASE>` from the runner.

- **rc 0**: the result is accepted only after REG-'s `placementCheck` identity sub-check (REG-24) passes for every path changed on both sides (merge-misplaces-edit-into-same-tail-neighbor VERIFIED: rc 0 moved an edit into a same-tail neighbour). A failing path is treated as conflicted.
- **Rename carry** (rc 0 or rc 1; MERGE_FLAGS set `merge.renames=true`, glossary §18; the K4 route below is glossary §24 default 2: no automatic re-keying in v1). A result is never accepted as is where it moves local work onto a path the local side did not change. For every path q with `ours[q] == A[q]` (both may be ABSENT) and `result[q] != theirs[q]`, merge-tree has carried a local change of another path into theirs' renamed path q: q is rebuilt as `theirs[q]` by whole-path replacement, and every source path p with `ours[p] != A[p]`, `theirs[p]` ABSENT and `result[p]` ABSENT goes to DAT-'s conflict function as a rename unit with stages `(A[p], ours[p], ABSENT)` (D8 step 5 → step 2: TIP's entry, i.e. the absence, plus a K4 PATCH record holding the local version, created before any disk write). This holds for the apply (`M_disk`, ours = `S_disk`, theirs = TIP) and the publish (`OUT`, ours = P, theirs = TIP). VERIFIED (git 2.55.0.windows.3, `merge.renames=true`): base `p.py`, local edit of line 25, TIP `git mv p.py p2.py` plus an edit of line 3 → rc 0 and a tree with only `p2.py` holding both edits. Accepted as is, the apply would write the local edit into `p2.py` while ENG-36 sets `A[p2] := TIP[p2]` and the round trip makes the private index hold `M_disk[p2]`, so no later snapshot sees a delta: the edit is never published, never in a record and never reported (and a held revert on `p` would escape its mask); the publish would fail ENG-41 (b) in every window. The opposite direction (the local side renamed p, TIP edited p) leaves the result on the local path, which the local change-set already covers, and is accepted. For a carried q that merge-tree also lists as conflicted, this rule replaces the conflict function's handling of q.
- **rc 1**: the conflicted paths (from merge-tree's `-z` conflicted-file-info section) plus identity failures go to DAT-'s one conflict function (DAT-41, Algorithm D8) with the stage triple `(base[p], ours[p], theirs[p])`. It returns either an insertion-concat blob; or, when every conflict region has an empty base block and LOCAL's block already occurs inside TIP's block, TIP's entry, or the merge-file output with each such region replaced by its TIP block when the D9 tripwire passes (otherwise the general rule), with no record and no event (glossary §24 default 1 as widened by §25.2 item 8, DAT- D8 step 0a; LOCAL's cleanly merged changes outside those regions stay, INV-NOLOSS); or `take-TIP` plus a K4 PATCH record (state CONFLICTED, guard `conflict`); a `take-TIP` displacement does not withhold the rest of the change-set (glossary §24 default 3, HLD-42). The result tree is rebuilt by whole-path replacement; these replacements and concat blobs are part of OUT (glossary §3). Marker-bearing merge-tree blobs are never written to disk, an index, a hold or a push. (The only marker-bearing bytes the engine ever writes are the `cowork:`-labelled conflict markers of a conflicted RESTORE, which HLD- composes and hands to `writeLocal` on the record owner's disk, with the path masked until the markers are removed; glossary §23 decided defaults. They never enter a tree the engine builds.)
- **rc > 1**: the step fails; nothing is written or pushed.

**Record before displace.** When the conflict function displaces a local version (take-TIP), the hold record carrying the local blob is committed to the registry ref (HLD-) before the writer replaces the disk bytes; the local blob is already in git (the apply iteration materialized `S_disk`, §3.8). Every record the engine creates (K4 PATCH here and in Rename carry, ring late-write PATCH §3.11, PHANTOM PIN, `host-reject` PIN, base-move records, `restart` PATCH records of §3.14) obeys glossary §9 "Only LIVE paths enter a mirrored record". Path-class-masked paths (quarantine set, save-only set) are not made into records where the mask already keeps their bytes on disk (the §3.14 per-path rebuild reseeds them without a record); where bytes would otherwise vanish — a ring late write into the `.old` of an applied `SAVE_ONLY` path, a leftover `.old` or an unmatched journaled path at restart — the record for a non-LIVE path is `local_only` and is mirrored only as its content-free stub (ENG-42). On the apply side the TIP write of a conflicted path is deferred while a fence or read lease on it is live (record stays ON_DISK CONFLICTED, HLD-).

### 3.11 Apply

**Trigger and admission.** Apply runs when ∃p with `A[p] != TIP[p]`, the branch is not frozen, no Bash/PowerShell TXN is open, the last apply was ≥ 10 s ago on this worktree (coalescing), and the worktree volume has ≥ 2 × (bytes to write) + 256 MB free (otherwise the whole apply is deferred with `DEFERRED(reason=disk_low)`). Paths in the full-read set of a mid-turn seat (CCI-) are applied at most once per 2 min.

**Write set, not-applicable paths and defer set.** `W = diff(S_disk, M_disk)` minus `UNMANAGED` paths (never written; their `A[p]` follows `TIP[p]` in the apply's state update, DAT-26). `SAVE_ONLY` paths in W are written like `LIVE` paths (DAT-27).

First, the **not-applicable** paths are removed from W (INV-GROUP over applicable paths, glossary §21): they are excluded from their write group, keep `A[p]`, get their own INCOMING record at once, and are listed in `not_converged`; the rest of their group stays applicable.

| Not applicable | Paths | Record |
|---|---|---|
| `unmaterializable` | DAT- portability predicate fails on this OS (reserved names, invalid characters, trailing dot/space, length, case-fold or NFC collision), checked before grouping | INCOMING, guard `unmaterializable` (DAT-33) |
| `collision` | a creation (`A[p]` absent) whose target already exists on disk (untracked, ignored, directory, case variant), checked by `lstat` before grouping | INCOMING, guard `collision` (DAT-29) |
| `quarantine` | incoming changes to `QUARANTINED` paths, including every new `120000`/`160000` entry (glossary §16) | INCOMING, DECISION guard `quarantine-review` (SEC-32); written only via the local human's `/cowork review <id> --accept` with preview/confirm (glossary §15: the id digests record rev, team blob and disk blob; SEC-33) through `writeLocal` with `expectedCleanBlob` = the digested disk blob |

Then D contains, each with one reason:

| Reason | Paths |
|---|---|
| `fence` / `read_lease` | under a live INFLIGHT fence or READ lease (CCI-20, CCI-21) |
| `txn` | every path while a live seat's TXN is open (CCI-22; the apply does not run) |
| `unreadable` / `unstable` | per-loop snapshot exclusions (§3.8) |
| `conflicted_leased` | conflict take-TIP writes while a lease on p is live |
| `eol_form` | incoming blob's stored form differs from A's form (DAT-11) |
| `local_only_conflict` | the conflict function would displace the local side of a path with a `local_only` record (HLD-55) |
| `disk_low` | free-space check failed (whole apply) or ENOSPC while preparing a group |
| `locked` | rename failed EBUSY/EPERM/EACCES (MEASURED: a `FileShare.Read` holder such as Excel refuses the rename, glossary §26.1 W4) |
| `mismatch` | writer pre-image re-merge failed 3 times or conflicted |
| `race` | the writer found something new at a create target, or `ENAMETOOLONG`/`EINVAL`, after grouping; the group is rolled back for this iteration and the path is re-classified (collision / unmaterializable) at the next one |
| `closure` | shares a write group with any deferred path |

D is computed, then HLD-53 partitions the applicable paths of `W ∪ D` into write groups (change-set closures from the `Cowork-CS` / `Cowork-CS-Paths` trailers of LA_C..TIP), iterated to a fixed point: a group with any deferred path is deferred whole (INV-GROUP). A deferred group never blocks other groups. Not-applicable and deferred paths stay in the tree and are never deleted by later snapshots (carry-through). Deferred paths keep `A[p]` and are listed in `meta.pending`; HLD-54 turns a deferral lasting ≥ 60 s into one INCOMING record (the 60 s transient window of glossary §9 and §20) that is retried every loop by a fresh 3-way merge, never by writing a cached blob.

**Writer protocol.** VERIFIED reasons for not letting git write the worktree: `read-tree -m -u` overwrote concurrent saves with exit 0 in 6/6 trials (apply-clobbers-concurrent-save) and half-applied under a Windows lock (partial-apply-on-lock e2, apply-partial-on-file-lock e6). `read-tree -u`, `checkout-index`, `checkout`, `switch`, `restore`, `reset --hard`, `stash` and `apply` are forbidden in daemon code.

```
APPLY(TIP, M_disk, groups):
  J  journal apply intent {tip, board: T, groups:[{n, entries:[{path, kind: create|modify|delete}]}]}
     with t/M, t/S, t/TIP; one state update            ← before any .new exists
     crashpoint("apply.intent")   (after J, before P0 of the first group; 11-testing §3.6)
  for each group g (in group order):
   [between two iterations of this loop: crashpoint("apply.between_groups")]
   P0 PREPARE: for every create/modify path, bytes from one persistent `git cat-file --batch --filters`
      (input "<oid> <path>"; cwd = repo root, glossary §25 F12) written as Buffers to tmp/<n>.new (same volume
      as the worktree); ENOSPC → delete g's .new files, defer g (disk_low)
   P1 re-check D for every path of g (a fence or TXN opened after J stops every write not yet started)
      for each path p of g:
        modify/delete: DISK_EQ(p, S_raw[p]) must hold (§3.3; normally the no-read fast path)
             not equal → re-snapshot p (quiet-period rules, staged read); found := canon(materialized blob of p);
                         merge-file -p --object-id (base S_disk[p], ours found, theirs M_disk[p])
                         clean → retarget p to the merge result and retry P1 for p (≤ 3 times)
                         conflict, unstable or 3 retries → roll back g, defer g (mismatch)
             st0 := lstat(p); st0 must equal the stat the staged read (or the clean stat-cache entry) validated,
                         else retry as "not equal"
             rename p → tmp/<n>.old   (EBUSY/EPERM/EACCES → roll back g, defer g: locked)
             lstat(tmp/<n>.old) == st0 (size, mtime_ns, file id), else roll back g
        create: lstat(p) must be ENOENT; anything there → roll back g, defer g (race; re-classified as a
                not-applicable collision at the next iteration); local bytes are never touched
                (ignored-file-overwrite, VERIFIED e14)
      crashpoint("apply.group.phase1")   (end of P1, before P2)
   P2 for each create/modify path: mkdir -p parents (recorded), fs.link(tmp/<n>.new, p), unlink .new
        (copy fallback on a volume without hard links, §2: exclusive create of p and one write of the .new bytes);
        [after one path of g is linked and before the next: crashpoint("apply.group.mid")]
        EEXIST → roll back g, defer g (race); ENAMETOOLONG/EINVAL → roll back g, defer g (race; re-classified
        as unmaterializable); executable bit from M_disk's mode when core.filemode=true
      delete paths keep only the .old; empty parent directories are removed (non-recursive rmdir)
   RT round trip per written path (ENG-34)
      crashpoint("apply.group.phase2")   (after P2 and RT of g, before the next group or step C)
  C  after all groups: one state update (ENG-36)
     crashpoint("apply.state")   (after the step C state update, before the in-memory A cache and the
                                  provenance journal are updated)
ROLLBACK(g): for every path already linked: if lstat(p) still equals the stat recorded after its link,
             rename p → tmp/<n>.redo and link tmp/<n>.old back to p (link-no-replace), then delete .redo;
             otherwise (someone wrote p after the link) leave p as written and delete the .old, whose bytes
             equal S_raw[p] and are already in git; for every path renamed but not linked: link .old back;
             for every created path: remove it if its stat is still the post-link stat, else leave it
             (copy fallback: "link .old back" is an exclusive create of p from the .old bytes)
```

The writer is **two-phase** and this is its only form (glossary §26.1 W4, MEASURED: with a share-all reader holding the file, the two-phase form (rename target → `.old`, then put the new bytes at the target) succeeded 15/15 while rename-over failed 15/15; 0 late writes into `.old` in 135 checks). Phase 1 + phase 2 of a group are renames and links only (about 1–2 ms per path). Readers may see ENOENT inside that gap; they never see a zero-byte or partial file (readers-see-missing-or-empty-files, VERIFIED ed/e4). A volume without hard links uses the **copy fallback** (§2) instead of `fs.link` (changed per glossary §26.2 item 7: the former rename-over fallback is removed). It is weaker, because a reader can see a partly written file while the write runs. LIF-'s start preflight detects the volume once, `/cowork start` warns and doctor shows the degraded writer for as long as it is in use; there is no per-write switch.

**Round trip (ENG-34).** For each written path: `update-index --cacheinfo <mode>,<M_disk[p]>,<p>` on the private index, then `DISK_EQ(p, M_disk[p])` through a staged read of p (§3.3; no git process reads p, glossary §26.1 W1); for a deletion `update-index --force-remove -- <p>` and lstat ENOENT. Not equal → MANY-CANDIDATES check of the staged bytes against `M_disk[p]`: equal after canon → the private-index entry becomes the raw blob, done; not equal → **PHANTOM**: HLD- PIN record with DECISION guard `phantom` (glossary §9 guard table; never published), path listed in `not_converged`, `PHANTOM` event. This is the ping-pong breaker (phantom-delta-pingpong-convergence). A passing round trip sets the stat cache of p to the post-write lstat with state `clean`, so the next detection tick neither reads nor hashes p.

**Ring.** Each `tmp/<n>.old` is kept ≥ 2 s, then lstat-compared with its post-rename stat before deletion. A change means a late write through an open handle: the bytes are taken by a staged read of the `.old` (§2; the writing process may still hold it, so no git process reads it, glossary §26.1 W1), hashed from the stage copy with `hash-object -w --path=<p>` (route (b)) and become an HLD- PATCH record at once (`h0` = `S_disk[p]`, `h1` = late bytes, origin `daemon`; `local_only` when p is not LIVE, §3.10), then the `.old` is deleted (changed per glossary §21 INV-NOLOSS: the source's merge-back through the writer is replaced by a record). INV-NOLOSS covers late writes observed within the ring window; a process that keeps a handle open beyond it and keeps writing (a long-lived appender) writes into an unlinked inode and is out of scope (glossary §21, decided in §24). Each ring late-write record is also written to the doctor record with its path, so doctor warns about a likely long-lived appender and suggests `.gitignore` for that file.

**Commit of the apply (ENG-36).** In one state update: `A[p] := TIP[p]` for every written path, for every applicable non-deferred path with `M_disk[p] == S_disk[p]`, and for every `UNMANAGED` path (no write; its private-index entry is set to `TIP[p]` by `--cacheinfo`, never hashed, DAT-26); deferred and not-applicable paths keep `A[p]`; `LA_C := TIP` (glossary §3 LA_C: every path of `tree(TIP)` is now on disk or a pending path whose `A[p]` is retained); `LA_B := T`; `snap := S_disk`; pending set replaced; journal intent cleared; HLD-41 rebases every ready pair whose `A[p]` changed (`R[p] := merge-file(cur=A_new[p], base=A_cap[p], other=R[p])`, `A_cap := A_new`, glossary §3 ready pair) and decides a rebase conflict on p by what this apply did to p: a clean or `CONCAT` write of p in a ready group sets `R[p] :=` the verified-written `M_disk[p]` and the group stays ready; a group that is not ready drops the conflicting pair and is re-captured at its open member's next trigger; a `TAKE_TIP` displacement of p's local side cancels the whole group's readiness (`CS_READY_CANCELLED`), and a group whose members are all closed is re-captured from the next completed snapshot. The rebased pairs are written into `journal/ready/` in the same update (VERIFIED X1: an unrebased R drops a peer's fix with rc 0 while the asserts pass). The provenance journal `prov/<e>.jsonl` then gets one line per written path (introduced and removed non-trivial line hashes, writer peer, CS id, live commit, local Δmono) for HLD-'s revert detector. After the update, LIF-'s adopt check runs if `live_base(LA_C) != H_adopt`.

**writeLocal(path, expectedCleanBlob|ABSENT, newBlob|DELETE).** The local-origin entry point used by HLD- PARK/RESTORE (HLD-16, HLD-17; a conflicted RESTORE may hand it a blob with `cowork:`-labelled conflict markers, glossary §23 decided defaults, and HLD- keeps that path masked until the markers are removed), HLD-61 S6 auto-park (only of a record that is durable, i.e. mirrored on the board; a record that is offline or `HOLD_MIRROR_REJECTED` is never auto-parked and stays on disk, glossary §25.2 item 1), LIF- stop CLEAN and resume restore, SEC-33 `review --accept` (preview/confirm, glossary §15: `expectedCleanBlob` is the disk blob digested in the confirmed preview id, so a disk changed since the preview returns `MISMATCH`), COO- go-first merge, DAT-08 disk-form repair, DAT-29 collision take-team (`/cowork resolve <id> --publish` = take the team version; `--discard` = keep the local version; glossary §24 default 5), and the base-move `--restore` (ENG-48). It is the same writer with these differences: the pre-image check is `DISK_EQ(path, expectedCleanBlob)` (ABSENT: lstat ENOENT); the target is `newBlob` (smudged by `cat-file --filters`) or a deletion; it never changes A, LA_C or LA_B — the write is a local edit that the next snapshot picks up and publishes through every gate; every write is recorded in the provenance journal with the caller's origin so HLD-'s detectors treat it as attributed, not unobserved; it returns `MISMATCH(found_blob)` instead of re-merging (the caller decides); `FROZEN` while any FREEZE reason is set (a FREEZE forbids daemon-initiated working-tree writes, glossary §8) unless the request carries human evidence (SEC-25) of a typed `/cowork` acting verb (`resolve`, `review`, `stop`, `resume`); `LOCKED`, `COLLISION`, `DEFERRED(reason)` for fence/lease/TXN/unmaterializable; `PHANTOM` from the round trip. `writeLocalGroup(entries[])` writes several paths all-or-none as one write group. Both journal an apply intent of kind `local` so restart rolls back an incomplete group.

**Gate queries.** `pathState(p)` (glossary §3) is answered from memory. If p is between phase 1 of its group and its round trip, the answer waits for the group, bounded at 250 ms (glossary §20 writer row); if the group has not finished by then the gate answers G1 `PATH_BUSY` (glossary §11).

### 3.12 Publish

**Trigger.** The governor grants a window (PRO-40, with the parameters of glossary §27.2: Δmono since anchor ≥ G + (rank − 1)·S with rank over R, per-peer cap B per 60 s Δmono, and the sliding team guard: no attempt starts while this peer has observed ≥ B landed board commits in the last 60 s Δmono, so U3 holds per 60 s and not only on average; PRO-44's throttle level, as 02-protocol keeps or revises it per glossary §27.2). B is the board's `protocol.json.budget` (12 by default, 6–24 as seeded at genesis, §3.14) with G = 5 s, S = 1.5 s at B = 12; during the throttle fallback (below) the engine hands the governor B = 6, G = 10 s, S = 3 s, each the stricter of the fallback and the normal value (changed per glossary §27.2: B was 6, G 10 s, S 3 s). The ready pairs a window carries include those captured at passing edit checkpoints (glossary §27.1), so a Claude edit whose edit check passes leaves in the next window, not at turn end; expected Claude-edit latency ≈ edit check (≤ 0.5 s) + governor window + receiver fetch/apply ≈ 10–30 s (MODEL, glossary §27.1; measured by test 59). Besides the window, a publish needs at least one of: a queued base move (ENG-48), a non-empty ready delta, pending board ops allowed in the current state (PRO-45). Push only on change: no periodic, heartbeat or renewal pushes (lease-expiry-clocks-heartbeats). One window carries everything pending (PRO-42), with one engine constraint: a queued base move L′ is the only code commit of its window (no local code delta rides with it; that delta merges against L′ in the next window), while pending board ops still ride with it.

**Pipeline (all on the leased tip T, re-run from scratch after any CAS loss, re-merge or base move; a verdict computed against another tip is never reused):**

```
1  groups      ← HLD-38/39: ready, unheld publication groups with rebased ready pairs; assert A_cap[p] == A[p]
                 (a group joined by a held PIN — e.g. `join`, `phantom`, `host-reject`, or the S5 `wake-scope` PIN
                 of wake-turn writes outside the wake work set — is not ready for publication)
   P           ← glossary §3 / HLD-42: MASK(R) on the paths of every ready, unheld group; A[p] everywhere else
2  B1          ← REG-20 Algorithm GATE over hunks(A[p], R[p]) of every ready group, against the claim view
                 (glossary §3) folded from exactly T, with REG-19 seat-level foreignness:
                 a group with a hunk inside a foreign claim earlier in board order → HLD-45 whole-group PIN
                 (K3 claim_race; K6 for a human CS); the group leaves P: its paths revert to A[p]
3  merge       OUT ← merge-tree --merge-base=A P TIP; REG-24 placementCheck; conflict function (§3.10);
               OUT includes the conflict function's whole-path replacements and concat blobs (glossary §3);
               a K4 TAKE_TIP path does not take the rest of its group out of P (glossary §24 default 3)
4  T0          ← HLD-50 checks on OUT (≤ 0.5 s on a 1.3 MB file); failing group → PIN (K7), it leaves P, go to 3
               (each pass removes ≥ 1 group, so this terminates)
5  asserts     ENG-41 (a)–(j) and SEC-07 secret scan (OUT delta, new held/ blobs, ops.jsonl); any failure →
               abort, doctor record, NOT_CONVERGED{cause: publish_assert}; never push S_disk instead
6  build       C = commit-tree OUT -p TIP (omitted when OUT == tree(TIP));
               Bnew = commit-tree <PRO- board tree: this publish's ops> -p T -p (C | TIP)
7  journal     push intent {bnew, c, lease_board: T, lease_code, cs_ids} with t/P = P; seq_next persisted; state update
               crashpoint("publish.out_built")   (after steps 6–7, before step 8; 11-testing §3.6)
8  push        ENG-43 (two leased refspecs, never --atomic, glossary §26.2 item 1);
               crashpoint("publish.sent")   (after git push is spawned, before its result is classified)
               classify ENG-44 by outcome (glossary §26.2 item 2);
               on a board line ok: crashpoint("publish.landed")   (before ENG-44's ok state update persists
               LA_C, LA_B, A and seq)
```

**A merged tree git cannot index** *(Plan 2 merge, final review FB-6)*. When git refuses a name of the merged tree in any index on this OS (TIP's root drive-prefix name `a:b.txt` on Windows), no OUT can be built until that name leaves TIP. The publish aborts with nothing pushed (`path_not_indexable`, never a silent build failure); the paths of every ready pair it composes are listed in `status.json` `pending.not_converged` with `cause: not_applicable` (guard `unmaterializable`), like the carried name itself; the daemon log gets one `PUBLISH_TREE_REFUSED{refused}` line when the condition starts; it ends at the first publish that builds an OUT.

Because B1 reads only the snapshot and the folded board, it runs on every outgoing tree whatever wrote the bytes and whatever the hooks did; with every hook failing open, nothing B1 withholds is published (gate-fails-open-on-every-hook-failure, bash-powershell-bypass-after-deny, deny-then-bash-workaround, race-loser-hunk-lands VERIFIED). Withholding is always whole groups, never hunks.

**Ops riding with code.** This peer's claim ops for the change-sets in C ride in the same Bnew, so a claim and its code land in one CAS or not at all (non-atomic-pair-and-fence VERIFIED). Every not-yet-mirrored hold-registry record (HLD- outbox; only LIVE paths enter a mirrored record and a record with a non-LIVE path is `local_only`, glossary §9; a `local_only` record is mirrored only as its content-free stub with no `held/` entries and no blob oids, glossary §7; restore-marker blobs never enter `held/`, glossary §9 and INV-SECRET; a record whose hold op the fold deterministically rejects stays unmirrored with `HOLD_MIRROR_REJECTED`, PRO-24) and every pending op allowed in the current state (`request`, `request_status`, `answer`, `note`, `release`, `event`, …; PRO-45) is coalesced into the same Bnew, subject to the glossary §20 board caps (5,000 folded records, 5 MB tree, 64 KiB and 1,000 ops per `ops.jsonl`; PRO-06); if the caps force a split, change-sets are dropped from C (whole groups) until their claim ops fit, and the rest wait for the next window.

**Board-only publishes** (last parent repeats TIP) carry ops only. Which ops each state allows is PRO-45's table (glossary §8): in ok/degraded all; under any FREEZE reason other than INCIDENT only freeze/unfreeze/health `event`s, answer-class ops (`answer`, `request_status`), release-class ops (`release`, `seat_end`, `leave`) and `hold` mirrors (no claim ops: new claims stay TENTATIVE while frozen); under the regionSpec VERSION pause only PRO-45's VERSION list; none during INCIDENT, the proto VERSION pause, NONRETRYABLE, OFFLINE or AUTH. Base moves are code publishes and are allowed while FROZEN (glossary §8), not during INCIDENT or any publish pause.

**Throttle signals and fallback** (added in rev 2.4, glossary §27.2). A **host-throttling signal** is any of these, observed by this peer on its own git network calls of the branch:

1. HTTP 429 or any HTTP 5xx reported by git for a push or a fetch of the branch (fetch included, §8 question 14). git reports the HTTP status only in its stderr text; reading it here is allowed because it only makes handling stricter (glossary §18, §3.3 item 6). It never decides lease loss, transient, NONRETRYABLE or `OFFLINE`, which stay decided by outcome (ENG-19, ENG-44).
2. A push attempt that took > 10 s Δmono from spawn to exit, whatever its outcome (push RTT > 10 s).
3. The rejection streak `meta.rejections.n` reaching 2 (ENG-44; glossary §26.2 item 2). The third consecutive rejection is still NONRETRYABLE (ENG-45).

On a signal the engine sets `meta.throttle := {signal}` in the next state update, (re)starts this peer's 30-min fallback timer (local Δmono), and hands the governor the fallback parameters (§2 "throttle fallback"). It queues one board `event{kind: health, reason_code: THROTTLE}` (codes only, glossary §7) on entering the fallback, and queues another when a signal arrives during the fallback and this peer's last `THROTTLE` event was queued ≥ 15 min ago (local Δmono; a chapter-local implementation constant below 30 min, so teammates keep following while the signals continue). The event rides the next allowed window like every health event (PRO-45 allows it while frozen; it waits in the outbox while `OFFLINE`, `NONRETRYABLE` or INCIDENT stop every push), and every attempt made in the fallback is governed and counted as usual (PRO-41). When the timer ends without a new signal, `meta.throttle := null` and the normal parameters return.

**Following a teammate's fallback.** Every peer folds `event{kind: health, reason_code: THROTTLE}` from any peer. An event's observed instant is the local Δmono at which the fetch that revealed its board commit completed (or this peer's own `ok` for it), the same rule as observed landings (PRO- §3.8). While any such event was observed in the last 30 min Δmono, this peer's governor uses the fallback parameters too, the stricter of its own state and the folded events (glossary §27.2; `signal: team` in status). Following sets no `meta.throttle` and posts no event of its own (no echo). At restart only board commits beyond `LA_B` are newly observed; at join, commits replayed from the checkpoint count as observed at the join's fetch (§8 question 15).

The fallback is not a publish pause and not a FREEZE: `state` in `status.json` is unchanged, `message_code` is `THROTTLE` only when no higher-precedence condition holds (§3.16), and no Claude event and no OS notification is raised.

### 3.13 Branch moves

Applies when the fetched branch head `Hr != Hb` (`Hb = live_base(TIP)`); runs even while FROZEN because it reads only remote trees (glossary §8).

```
BRANCH_MOVE:
 (i)  Hr missing, or Hb not an ancestor of Hr        → BRANCH_REWRITTEN: no base move, no save; live continues on Hb
 (ii) Hr carries Cowork-Saved-Live: <Lk>, parent1(Hr) == Hb, tree(Hr) == tree(Lk),
      Lk on TIP's first-parent chain                  → newtree = tree(TIP)          (save completion)
 (iii) otherwise: B = newest of {Hb} ∪ {second parents of base-move commits on TIP's first-parent chain}
                      that is an ancestor of Hr (normally Hb)
       newtree = merge-tree --merge-base=tree(B) tree(TIP) Hr; REG-24 placementCheck on paths changed on both sides
       HLD-56 branch-escape test / revert-provenance guard on diff(tree(TIP), newtree)
       conflict, identity failure or guard hit on any path → no base move; base-move hold records; save blocked
 publish L′ = commit-tree newtree -p TIP -p Hr  (Cowork-Base: <Hr>)  as a board-leased code publish
```

Case (ii) uses `tree(Lk)` as the effective base: VERIFIED (x1_save_completion.sh) base `tree(Hb)` resurrects a line deleted after Lk, base `tree(Lk)` gives exactly `tree(TIP)`. One rule therefore completes a save interrupted between its branch push and its board push on any daemon. Case (iii) is the VERIFIED fix for save-reverts-external-commits (e9) and branch-moves-under-live.

**Base-move hold records** (changed per glossary §22: no exact-match base B′ in v1). Each conflicting, identity-failing or guard-flagged path becomes one HLD- record with DECISION guard `base-move` (glossary §9 guard table), stages `s1,s2,s3 = (B[p], TIP[p], Hr[p])` (board entries `held/<hold_id>/s1|s2|s3/<repo path>`, none for an ABSENT side), keyed by `(Hr, p)`, `displaced_by` = the op id of the `event` this daemon posts with it (`reason_code` `BASE_MOVE_CONFLICT`; HLD-56's escape case uses `branch_escape`; glossary §9). A path already held by a non-terminal record gains the guard on that record instead (HLD-56). A daemon creates one only when the fold shows no non-terminal base-move record for the same key; it rides on that daemon's next board publish; a CAS loser whose re-fold shows the winner's record drops its own unpublished one. The record's `owner` is the daemon whose board publish carried it first (§8 question 4). No bytes are at risk (Hr is on the remote branch, TIP in the live chain); the record exists to block save, to tell the committer (`BASE_MOVE_CONFLICT`) and to carry the decision:

- `/cowork resolve <id> --restore`: `writeLocal(p, disk, merge-file(cur=disk, base=B[p], other=Hr[p]))` — the branch's change enters live as an ordinary local edit through every gate; the next base-move attempt then merges cleanly. A conflicting `merge-file` result follows HLD-'s RESTORE conflict rule (glossary §23 decided default: `cowork:`-labelled markers on the owner's disk, path masked until they are removed).
- `--discard`: logged; in the next base-move attempt `newtree[p] := TIP[p]` (whole-path replacement); the human is told the next save will revert that change on the branch.

The base move is recomputed every iteration while records for `Hr` are non-terminal and published as soon as none blocks it. Every daemon may attempt L′; the board lease admits one; the others refetch and see `Cowork-Base == Hr`. A base move never moves a branch ref. A base-move publish carries no local code delta; that delta waits for the next window and merges against L′.

**Save primitives (procedure in LIF-23..LIF-26).** Save uses: the final sync round (publish own ready delta, then fetch); the candidate walk on TIP's first-parent chain while the live base is still `Hb`; the branch push `--force-with-lease=refs/heads/<b>:<Hb> <S>:refs/heads/<b>` (a fast-forward; the repo's hooks do not run under the empty hooksPath); then, as a separate push (never `--atomic`, glossary §26.2 item 1), the board publish of `Ls = commit-tree tree(TIP) -p TIP -p S` with `Cowork-Base: <S>` (assert `tree(Ls) == tree(TIP)`) and ops `save{save_commit, saved_live, chain_base, released_claim_ids}`. A board CAS loss after a landed branch push is completed by case (ii) on any daemon; an ambiguous result is success iff the branch == S and a live commit with `Cowork-Base: <S>` is on the code first-parent chain. Save never pushes the saver's working tree, never splices, never resets the live chain (f-save-lagging-tree-reverts-peers, save-race-reverts-concurrent-edits, save-splice-commits-untested-tree VERIFIED), so pre-save live history and per-commit attribution stay on the remote (save-squash-erases-provenance).

**EPOCH_BASE change.** When an apply moves `LA_C` across a base-move commit, `EPOCH_BASE := live_base(LA_C)`; attribute caches are invalidated, `.cowork/config.json` is re-read at the new EPOCH_BASE (SEC-), and DAT-'s filter discovery and preflight re-run before the next snapshot (in the real work tree with cwd = the repository root and DISK_EQ-safe comparisons only, glossary §25 F12 as corrected by §26.2 item 3; DAT-16); a failure sets `FREEZE(CONFIG)`. The stat cache is emptied, because attributes and filters decide every id it holds. Every path whose scope class changes from `UNMANAGED` at the new EPOCH_BASE gets its `A[p]` reseeded by the lost-state per-path primitive (§3.14) before the first snapshot that hashes it (DAT-26, §3.8 step 1).

### 3.14 Genesis, join, restart, lost state

**Genesis** (board and mirror both absent on the remote and no state ref, LIF-06 Table 3.3-A; LIF-07 has checked symbolic HEAD `refs/heads/<b>`, `HEAD == Hr`, no git-operation marker; PRO-49 has run the host probe):

```
L0 = commit-tree tree(Hr)                         (no parents; Cowork-Base: <Hr>; live markers)
B0 = commit-tree <genesis board (PRO-07): protocol.json {proto: 1, regionSpec, budget: B, G_s, S_s},
                  ops [join, caps], checkpoint/state.json> -p L0
     B = `host.pushBudgetPerMin` of `.cowork/config.json` in tree(Hr) when it validates (an integer 6–24, glossary
         §27.2; config schema, glossary §17), else 12; G_s and S_s for that B as PRO-07 sets them (B = 12: G_s 5,
         S_s 1.5); the value is read only here and never again after genesis (changed per glossary §27.2: was
         budget 6, G_s 10, S_s 3)
push board and mirror with ABSENT leases (both refspecs in one push)
loser of a simultaneous genesis: refetch and JOIN
state := commit [L0, B0], A := tree(L0), EPOCH_BASE := Hr, H_adopt := HEAD, new epoch
```

Board absent while a state ref exists is not a genesis: start refuses with LIF-06's `START_BOARD_GONE` (an automatic respawn instead restarts and enters INCIDENT on the missing board ref, §3.7). Board absent with no state ref while the mirror exists is not a genesis either: start refuses with this chapter's `GENESIS_BOARD_MISSING` (ENG-51; LIF-06 Table 3.3-A).

**Join** (board exists, no state ref for `<b>`):

```
1  fetch; fold from the nearest checkpoint (≤ 255 replayed board commits, PRO-; the joiner trusts that checkpoint,
   glossary §24 default 9, and a mismatch found later follows glossary §7 / PRO-28); incident check vs nothing
   (shapes only)
2  Hb := live_base(TIP)
3  require symbolic HEAD == refs/heads/<b>   (LIF-07 owns the refusal codes)
   HEAD == Hb                    → continue
   HEAD strict ancestor of Hb    → refuse START_HEAD_BEHIND
   HEAD == Hr != Hb              → wait ≤ 60 s for a running daemon's base move (refetch each loop);
                                   none → perform BRANCH_MOVE (iii) from remote data only and publish L′ in the
                                   same board commit as this peer's join op; conflict → refuse START_BASE_MOVE_CONFLICT
   otherwise                     → refuse START_HEAD_AHEAD
4  A := tree(HEAD); private index := read-tree HEAD (no refresh of working files, glossary §26.1 W1); stat cache empty;
   snapshot and materialize S_disk (every tracked path is stage-read once, §3.8)
5  state := commit [L_b, T] where L_b = the oldest commit on TIP's first-parent chain whose live base is Hb
   (the base-move or genesis commit that introduced Hb); EPOCH_BASE := Hb; H_adopt := HEAD; new epoch
6  preview and per-path confirmation of local work (LIF-08): unconfirmed paths become one PIN record with
   guard `join` (ON_DISK, masked, mirrored)
7  first apply through the writer; LA_C := TIP only after it
   crashpoint("join.first_apply")   (after step 7, before step 8 / the first publish; 11-testing §3.6)
8  if nothing was opted in, assert that the first publish has OUT == tree(TIP)
```

`A := tree(HEAD)` and nothing else: VERIFIED late-join-wrong-merge-base — a live-tip base reverted all live work, a live-base base reverted a saved edit; only the joiner's own HEAD was correct, and requiring `HEAD == Hb` makes it also the team base (join-or-restart-seeds-revert).

**Restart** (state ref exists; crash, kill, power loss, reboot, update, start after stop). Nothing is snapshot-published until steps 1–5 complete.

```
1  single instance: the IPC endpoint bind (SEC-) decides; daemon.lock is advisory and replaced atomically
2  delete own leftovers only: <gitdir>/cowork/<e>.index.lock, tmp/*.new, every stage copy under tmp/stage/ (copies, never a
   store, §3.2), stale tmp/save-* worktrees
   (git worktree remove --force, then git worktree prune); never .git/index.lock (sole exception: the lock adopt
   itself created, identified by the journaled content hash; glossary §12, LIF-30); never the repo-wide
   packed-refs.lock (any git process may hold it): one at least 30 s older than this restart's marker is logged
   PACKED_REFS_LOCK_STALE{age_s} once and left for the human, as git's own refusal advises
   (Plan 2 merge, Task 15 finding 6, which amends the Task 12 carry ruling)
3  read the state ref; it or any object it names missing, or the ref broken → LOST STATE (below); no state ref
   while a leftover tmp/broken-state-ref-<e>-<k> of this branch exists (a crash between moving a broken ref aside
   and committing the new state) counts as a state present → LOST STATE too, never JOIN
   (Plan 2 merge, Task 15 ruling, R-23)
4  journal intent:
   apply|local: WRITER ROLLBACK first. Per journaled path, "linked" means DISK_EQ(p, target) where target is
        M_disk[p] (apply) or newBlob (local), and for a deletion "linked" means p absent while tmp/<n>.old exists.
        A group is COMPLETE iff every path of it is linked; otherwise it is rolled back completely:
          modify/delete with tmp/<n>.old present: p linked → rename p → tmp/<n>.redo, link .old back to p;
                                                  p absent  → link .old back to p;
                                                  p is something else (written after the link) → p stays
          create: p linked → remove p (its bytes are in the live chain or the caller's blob); otherwise p stays
        then every leftover tmp/<n>.old (completed groups, or kept beside a path that stayed): staged read of it into
        tmp/stage/<p> (§2), MANY-CANDIDATES check against S_disk[p] (§3.3: raw blob r by route (a) or (b)) → equal: delete;
        otherwise its bytes become a 'restart' PATCH record (route (b) hash-object -w --path of the stage copy; `local_only` for a non-LIVE
        path, §3.10), then delete; then .redo files
        then per journaled path p (MANY CANDIDATES over {target[p], pre-image[p]} with pre-image = S_disk[p] (apply)
        or expectedCleanBlob (local)):
          apply: matches M_disk[p] → A[p] := TIP[p]; matches S_disk[p] → A[p] unchanged, p pending;
          local: matches either → nothing to do;
          neither → 'restart' record (kept on disk, masked, apply deferred; `local_only` for a non-LIVE path, §3.10),
                    shown to the human
        apply intents: LA_C := intent.tip, LA_B := intent.board (ENG-07: unmatched or rolled-back paths keep A[p]);
          then HLD-41 rebases every journaled ready pair whose A[p] changed in this decision
          (R[p] := merge-file(cur=A_new[p], base=A_cap[p], other=R[p]), A_cap := A_new; a rebase conflict is
          decided by HLD-41's split exactly as in ENG-36: clean or CONCAT write of p → R[p] := M_disk[p], group
          stays ready; group not ready → pair dropped; TAKE_TIP displacement → readiness cancelled,
          CS_READY_CANCELLED), and the rebased pairs, A, LA_C and LA_B are written in ONE state update, exactly as
          ENG-36 would have (a crash after the writes and before ENG-36's update must not leave A_cap stale)
   push: fetch; Bnew on T's first-parent chain → the 'ok' update of ENG-44; otherwise discard
   adopt: LIF- REATTACH restart rule (LIF-30, LIF- §3.8.3)
5  private index missing or unreadable → read-tree <state:snap> (no refresh of working files, glossary §26.1 W1); the stat
   cache starts empty after every restart, so the first snapshot stage-reads every tracked path once
6  epoch observation (LIF-10, LIF-11); then the ordinary loop
```

VERIFIED crash-between-apply-and-state-resurrects-deletes and ambiguous-push-and-crash-stale-base (e3, e3b, e10): the per-path journal decision fixes both; seeding A from TIP would resurrect deleted lines.

**Created-then-deleted ready paths** *(Plan 2 merge, final review FD)*. A LIVE path that a ready pair holds, that A lacks and that is absent from the disk is a file the pair's capture created and the user deleted since. The close that would have dropped it from that pair (05-holds HLD-40, "kept push intents") happens in memory and dies with the process, so after step 4 the restart makes it: every ready pair that a still-kept push intent does not name drops p (R and `A_cap` lose it; a pair left with no path leaves the journal), the pairs are journaled in one state update, and the daemon log gets one `RESTART_READY_VANISHED{paths}` line; in a pair a kept intent names, p waits for the next close after the intent resolved. Without this, the loop's first publish would send the creation and TIP would hold a file the user deleted.

**Lost state** (state ref or a referenced object missing; also the per-path primitive LIF-'s `/cowork resume` calls for selected paths, the DAT-26 reseed of a path leaving `UNMANAGED` (§3.8 step 1, ENG-50), and the recover re-anchor of §3.7 step 2a with T = the current board tip):

```
never seed A wholesale from TIP or the live base; never silently re-join
reseed the private index from tree(TIP) (read-tree; no refresh of working files, glossary §26.1 W1); empty the stat cache;
snapshot and materialize (every path stage-read once, §3.8)
for every path p in tree(TIP) ∪ admitted disk paths, by scope class (DAT- scopeOf):
   candidates = the distinct versions of p (including ABSENT) on TIP's first-parent chain back to the live base,
                newest first, at most 500 commits
   UNMANAGED              → A[p] := TIP[p]; the disk is never read (DAT-26); no record
   QUARANTINED, SAVE_ONLY → A[p] := the newest candidate that matches the disk, else TIP[p]; no record: the
                            difference stays under its path-class mask (glossary §9 exempts path-class masks)
   LIVE                   → A[p] := the newest candidate that matches the disk (MANY CANDIDATES; ABSENT matches
                            ENOENT); no match → A[p] := TIP[p] only together with a 'restart' PATCH record holding
                            the disk bytes (not published, not overwritten) — the per-path fallback, never a
                            wholesale seed
LA_C := TIP; LA_B := T; new epoch; emit LOST_STATE{mode: lost_state} with the list of restart records
(the DAT-26 reseed of a path leaving UNMANAGED and LIF-'s resume run only the per-path loop body for their paths
 and change nothing else)
```

At start, the lost-state path *(Plan 2 merge, Task 15 rulings and decision 1)* first requires HEAD symbolic on `refs/heads/<b>` with no operation in progress (else `START_HEAD_STATE{op}` with `op` ∈ `detached`, `other_branch`, `unborn` or the operation, nothing written: the rebuild pins `expected_epoch` and `H_adopt` from HEAD). A broken ref is moved aside to `tmp/broken-state-ref-<e>-<k>` only after an `ls-remote` answered (git fetch dies on a broken local ref) and is put back on any failure while no state was created. It then fetches once and reads the board before the rebuild: no answer → `START_REMOTE{unreachable}`; the remote answered but a local ref update failed → `START_REMOTE{local_ref_update}`; board absent → `GENESIS_BOARD_MISSING{branch}` (the team's state lives with a teammate, who runs `/cowork recover`; a readable state ref with the board absent is LIF-06's `START_BOARD_GONE` instead, as above); board failing the board checks → `START_REMOTE{board_malformed}`; a name of the live tree git cannot index on this OS → `START_REPO_SHAPE{path_not_indexable}`. Every leftover `tmp/broken-state-ref-*` of this branch is removed once the new state is committed.

A running daemon that finds its state ref missing stops the iteration and enters this path (changed per glossary §8: lost state is not a FREEZE; the rebuild is conservative because unmatched bytes are held, never published or overwritten). The engine never deletes or re-initialises a state ref on its own; the only path that discards one is the human-confirmed `/cowork start --fresh` (glossary §15, LIF-), allowed only after the remote board was deleted by hand.

### 3.15 Version

v1 has fixed `proto = 1` (glossary §22). After each fold the engine evaluates the glossary §8 VERSION split (`VERSION_PAUSED`, "update cowork-sync"); fetch, fold and apply continue in every case, and unknown op types fold as deterministic no-ops (PRO-47):

| Condition | Effect |
|---|---|
| board tip `protocol.json.proto` ≠ 1 (PRO-47) | zero pushes of any kind |
| this daemon's regionSpec ≠ `teamRegionSpec` (computed by the fold over R, PRO-48) | code pushes (including base moves) paused; board-only pushes of the PRO-45 VERSION list allowed (`join`, `leave`, `seat_end`, `release`, `request_status`, `answer` with decline/later/release, `hold`); claims written under another regionSpec are gated as whole-file (REG-04) |
| a checkpoint mismatch that persists after one refold (PRO-28) | VERSION with `message_params.cause = "checkpoint_mismatch"` and a P2 alert; push classes as for the regionSpec row unless the proto row also holds |

The pause lifts when its condition no longer holds (PRO-28, PRO-48). `/cowork stop` during the regionSpec form proceeds and skips its code publish (its board-only ops are allowed); during the proto form it refuses (glossary §24 default 6; verb mechanics LIF-). Each board commit carries only its own ops and no daemon rewrites another peer's records, so an older daemon can never drop a newer peer's records (version-skew-board-loss). On a version handshake asking the daemon to drain (CCI-), it finishes the current step, completes any state update, writes `status.json` with `state: "down"` and exits; the new version starts through RESTART, never JOIN (LIF-37). A state ref whose `meta.v` (LIF-37's `meta_v`) is greater than this daemon's makes the branch `refused` (LIF-37) and the engine writes nothing to that state ref.

### 3.16 Health and status.json

Every iteration and every transition write `<gitdir>/cowork/status.json` (glossary §14) by temp file + rename (on EPERM/EACCES retry 3 × 50 ms, a chapter-local implementation constant not in glossary §20, then skip this write). `heartbeat_mono_ms` comes from the machine-wide monotonic clock (`process.hrtime.bigint()`), which readers on the same PC compare with their own reading; a heartbeat older than 3 × `loop_period_ms` is `down`.

`state` precedence (first match):

| state | condition |
|---|---|
| `refused` | live mode refused for this branch by a start-time check that still holds (LIF-) |
| `incident` | `INCIDENT ∈ freeze_reasons` |
| `frozen` | any freeze reason other than `PAUSED` |
| `paused` | `freeze_reasons == [PAUSED]` |
| `offline` | `publish_pause ∈ {OFFLINE, AUTH}` (they behave identically; `publish_pause` carries the `AUTH` label for the explanation only, glossary §8) |
| `degraded` | `publish_pause ∈ {NONRETRYABLE, VERSION}`, or `pending.not_converged` non-empty, or a pending path older than 60 s, or a live seat whose wiring is `NO_MCP` or `HOOK_ONLY` or whose flags include `DEGRADED` (glossary §3 seat wiring / flags; `NO_HOOKS` sets `FREEZE(NOHOOKS)` and so shows as `frozen`) |
| `ok` | none of the above |
| `down` | written only as the last write of an orderly exit; otherwise inferred by readers. The lease-expiry exit (no seat or human lease for 10 min, §3.5, CCI-50) writes `message_code: "IDLE_NO_SESSION"` (glossary §25.2 item 6; the code and its texts are 10-product's); a version drain (§3.15) writes no message code |

`message_code` is the code (glossary §19 message-code registry) of the highest-precedence condition, with `message_params`; for `offline` the params carry `label`, `explanation` and `offline_for_s` (local Δmono since the last successful fetch, recomputed at every write; glossary §25.2 item 4). When `state` is `ok` (no other condition sets a message code) and the throttle fallback is active (own or followed, §3.12), `message_code` is `THROTTLE` with `budget`, `fallback_left_s` and `signal` (§2; glossary §27.2; `state` is not changed by it). `pending` fills `cs_ready`, `cs_open` (HLD-), `holds_active`, `holds_local_only` (HLD-), `incoming` (count of pending paths + INCOMING records), `not_converged` (phantom paths, not-applicable paths, quarantine review items, paths excluded by the round-trip check, and every path of a ready publication group that a publish pause (`VERSION`, `NONRETRYABLE`, `OFFLINE`/`AUTH`) or a FREEZE reason keeps from publishing, 02-protocol §3.11 A2; the pause or FREEZE reason itself is already in `publish_pause` / `freeze_reasons`). `adopt` comes from LIF-31. No other field is written (glossary §14 schema exactly).

Engine events (each with a COO- template in `en` and `ko`, glossary §19): `FROZEN`, `UNFROZEN`, `INCIDENT`, `NONRETRYABLE`, `OFFLINE`, `ONLINE`, `LOST_STATE`, `PHANTOM`, `DEFERRED`, `BASE_MOVE_CONFLICT`, `VERSION_PAUSED`, `NOT_CONVERGED` (LIF- emits `ADOPT_BLOCKED` and `SAVE_REPORT`). Events are queued for each live seat's next hook (COO-/CCI- delivery) and raised as OS notifications (UX-, ≤ 1 per 30 min per reason class, glossary §20). Entering or leaving a freeze posts one board `event{kind: freeze|unfreeze}` by board-only push when pushes are allowed; non-retryable rejections post `event{kind: nonretryable}` only after the pause lifts. A host-throttling signal posts `event{kind: health, reason_code: THROTTLE}` on entering the 30-min fallback and again at most once per 15 min while signals continue (§3.12, ENG-46; glossary §27.2); it is human-facing only (no Claude event, no OS notification). A failing edit check raises no event of any kind (glossary §27.1). Board health stubs for long deferrals are HLD-'s escalation (INCOMING health stub at 60 s, glossary §20; changed per glossary §20 — the source's separate "3 consecutive failed applies" counter is dropped).

**Flow requests** _(rev 2.5, F14)_. On a CLI flow request (10 §3.5.1) the engine answers from the last iteration's in-memory state (the `A ≠ TIP` apply trigger set with the writer of each path, the `S_disk ≠ A` set, `meta.pending` with HLD-54 anchors, the apply-coalescing state, push intent, snapshot exclusions, ready pairs), runs no git process and writes nothing; it adds no `status.json` field.

---

## 4. Rules

### Storage and state

- **ENG-01** All daemon git state MUST live in the user's own repository (same `GIT_DIR`, object store, config, attributes and filters); the engine MUST NOT use a private `GIT_DIR`, alternates, `refs/worktree/*` or any state file as a source of truth, and MUST NOT keep correctness state in `CLAUDE_PLUGIN_DATA`. The daemon MUST NOT run `git gc` and passes `gc.auto=0` (runner). _Covers: park-refs-in-worktree-namespace-vanish, uninstall-deletes-state-daemon-orphaned, orphan-daemon-uninstall, filter-passthrough-leak, gc-prunes-daemon-only-objects_
- **ENG-02** The engine MUST use exactly the refs of glossary §4 with `enc(b)` in the active namespace (the `refs/heads/cowork/<enc(b)>/{board,code}` fallback only after PRO-50's opt-in), MUST fetch only the three explicit glossary refspecs, MUST create every local ref update with `--create-reflog` under `core.logAllRefUpdates=always`, and MUST serve exactly one live branch per clone. _Covers: no-history-undo, park-refs-in-worktree-namespace-vanish_
- **ENG-03** `refs/cowork-local/<enc(b)>/state` MUST point to a commit with parents `[LA_C, LA_B]` and tree `{base, snap, journal, meta}` laid out as §3.2, and MUST change only by one CAS `update-ref <new> <old>` per transition (or by the one `meta.since`-only CAS update a drain at exit may make, §3.2); a CAS failure MUST make the daemon log a security event and exit. _(changed in rev 2.5, F04: the drain-time `meta.since` write.)_ _Covers: stale-base-after-crash, ambiguous-push-and-crash-stale-base_
- **ENG-04** Every object an intent, a ready pair or a kept tree references MUST be reachable from the state commit's tree (journal subtrees `t/`, `ready/`, `keep/`); the state ref MUST NOT be updated for snapshot-only changes; a detection tick MUST write no object, and objects MUST be written only for ready-pair captures, publishes, applies and hold records (an iteration materializes only for a ready-pair capture — including the candidate capture an edit checkpoint builds before its edit check, glossary §27.1, whether or not the check passes —, an apply, or a hold record it creates or refreshes; the many-candidate `DISK_EQ` writes only as an apply or hold-record step, §3.3), and a hook request for named paths MUST be answered with detection ids and in-memory bytes (`diskSnapshotId`, 04-regions) without writing any object (glossary §26.1 W6: 205 MB of loose objects in 20 min when every 2.5 s snapshot of a changing 1.3 MB file wrote its blob; soak gate ≤ 50 MB of loose-object growth per busy peer-hour, test 33); when `write-tree` or a merge fails on a missing object the engine MUST reseed the private index from `state:snap` and retry next iteration. _(changed per glossary §26.1 W6.)_ _Covers: gc-prunes-daemon-only-objects, no-history-undo_
- **ENG-05** `meta.json` MUST follow §3.2 and MUST NOT contain wall-clock or monotonic timestamps; FREEZE reasons, the incident record, the NONRETRYABLE record, the rejection streak (ENG-44, glossary §26.2 item 2), the own throttle fallback `meta.throttle` without a timestamp (ENG-46, glossary §27.2; its 30-min timer restarts at daemon start) and the pending set MUST be persisted there so they survive restart, and the F04 `since` heights (`meta.since`, board heights only) too, but only inside the next transition's state update or the drain's state write at exit (§3.2; a crash loses only marks). The meta parser MUST accept `since` (absent, or an object of exactly the three keys `seen_h`, `return_h`, `run_h`, each a non-negative safe integer) before any build writes it: F04-a extends Plan 2's `parseMeta` (exact key set) with this optional key, so a meta carrying `since` is never read as a lost state and rebuilt over (LIF-37 refuses only a newer `meta_v`). _(changed in rev 2.5, F04: `meta.since` added; no `meta.v` change; the parser rule added in merge round 2.)_ _Covers: silent-stall-no-visible-surface, breaker-freezes-publish-not-apply_
- **ENG-06** `A[p]` MUST change only after a verified write of p (ENG-36, including the restart per-path decision of ENG-53), for an `UNMANAGED` path by following `TIP[p]` in an apply's state update (DAT-26), after a confirmed push in which p went out with `C[p] == P[p]` and `A[p]` unchanged since capture (ENG-44), by LIF- RECONCILE (LIF-12, 08-lifecycle §3.4.2) to a blob X with `DISK_EQ(p, X)` true and X ∈ {`TIP[p]`, `HEAD[p]`}, at join (`A := tree(HEAD)`, ENG-52), by the lost-state per-path rebuild (ENG-54, also used by the recover re-anchor of §3.7 step 2a and by LIF-'s resume for selected paths), or by the DAT-26 reseed of a path whose class leaves `UNMANAGED` (the same per-path primitive, run before the first snapshot that hashes p in its new class, §3.8 step 1); in the per-path primitive `A[p] := TIP[p]` is allowed for a LIVE path only when no version on TIP's chain matches the disk and only together with a `restart` record holding the disk bytes (path-class-masked paths reseed without a record, `UNMANAGED` paths follow TIP without a read); A MUST never be computed from ancestry, seeded wholesale from TIP or the live base, taken from `S_pub`, or taken from an unfetched merge result; pending paths MUST keep the team blob actually underlying the disk. _Covers: pending-path-base-misset-reverts, absorbed-hold-evades-history-detectors, naive-push-reverts-unapplied-paths, explicit-base-not-ancestry_
- **ENG-07** `LA_C` and `LA_B` MUST only be commits that exist on the remote (fetched, or this peer's push confirmed by `ok` or by a later fetch) and MUST only move forward along first parents; `LA_C` follows the glossary §3 definition and advances to TIP at the end of every completed apply, when every path of `tree(TIP)` is on disk or is a pending path whose `A[p]` is retained (listed in `meta.pending`, carried by an INCOMING record per HLD-54, DAT-29, DAT-33 or SEC-32). _Covers: ambiguous-push-and-crash-stale-base, crash-between-apply-and-state-resurrects-deletes_

### Git usage

- **ENG-08** Every git call MUST go through `runGit` (glossary §18) with absolute `GIT_INDEX_FILE`, `--git-dir` and `--work-tree` (the wrapper rejects relative values before spawning); file bytes MUST be Buffers end to end; blobs MUST be produced only by the three routes of §3.3 item 3 (route (a), the private-index add of stage copies, only for paths without a clean filter; route (b), `hash-object -w --path=<p>` of a stage copy or stdin; route (c), `hash-object -w --stdin --no-filters` for canon output); no git process may read a user's working file (§3.3 item 7, glossary §26.1 W1); every command that may run a filter MUST be spawned with cwd = the repository root and without `--work-tree=<tmp/stage>` (§3.3 item 8, glossary §25 F12). _(changed per glossary §25 F12 and §26.1 W1.)_ _Covers: filter-passthrough-leak, secret-filter-passthrough, daemon-text-handling-corrupts-cp949-bom, board-plaintext-and-permanence, splice-text-from-worktree-leaks-secret, gitattributes-edit-unfilters_
- **ENG-09** Every oid MUST be a validated typed `Oid` checked with `cat-file -e` before use in `commit-tree`, `update-ref` or a refspec; pushes MUST be composed only by `push(newOid, ref, lease: Oid|ABSENT)`; remote deletion MUST exist in one function that accepts only this peer's probe ref of the active namespace (`refs/cowork/probe-<peer_id>`, or `refs/heads/cowork/probe-<peer_id>` in the fallback namespace; glossary §4, INV-OID); a push whose OUT is the empty tree MUST be refused unless `tree(TIP)` is empty. _Covers: empty-oid-push-deletes-live-ref_
- **ENG-10** Trees MUST be produced only by the four operations of §3.3; the engine MUST NOT subtract hunks, splice symbol text, use a marker-bearing merge result, or check out or apply a stored patch (glossary §9 forbidden list; its sole -U0 exception, HLD-'s `taintOnlyH1()`, yields only a record's `h1`, never a tree; and glossary §9's reverse-merge exception `revertInverse()` (05-holds HLD-12; rev 2.5, F10), whose output reaches a tree only as disk content captured by HLD-40, never directly). _Covers: hunk-withdrawal-publishes-signature-without-callers, intra-file-withdrawal-mangles-file, move-splice-duplicates, csharp-overload-group-splice, splice-source-stale-board-text_
- **ENG-11** Every "disk bytes at p equal blob X" decision MUST use `DISK_EQ` (glossary §3; mechanics §3.3, variants 1–3 and the many-candidate form), which reads the disk only through a staged read (glossary §26.1 W1, §26.2 item 3); no `hash-object --path` result of an unfiltered path may be compared with a stored blob; a route (b) id is compared only with an id of the same form for the same path (a filtered path's `S_raw[p]` and its candidates, which get no canon, 03-data §3.4). _Covers: apply-clobbers-concurrent-save, phantom-delta-pingpong-convergence, eol-bom-stored-form-flip_
- **ENG-12** Live code and board commits MUST have the shapes and trailers of §3.4 (glossary §5), built with `commit-tree` and never signed; board commits MUST never be merged; save commits MUST be the only branch commits cowork creates and MUST carry no skip marker. _Covers: non-atomic-pair-and-fence, op-identity-cursors-board-merge, host-policy-and-ci, save-squash-erases-provenance_

### Loop

- **ENG-13** The daemon MUST run one iteration at a time on the 2.5 s active / 10 s idle period, MUST never run two fetches at once (the next fetch starts ≥ 2.5 s after the previous one started, or right after it ends if it took longer; a fresh-fetch request during a fetch waits for it; glossary §25 F10), MUST start an immediate iteration for a gate fresh-fetch request (steps 0–2), a change-set boundary (steps 0–4) or an edit checkpoint (steps 0–4 with the edit-check capture, glossary §27.1; started only once the hook-named paths are past the 300 ms quiet period of §3.8 step 2, which is never waived for them; edit checkpoints arriving meanwhile coalesce into one iteration) with at most one in flight, MUST journal an edit checkpoint's candidate capture as the CS's ready pair only when the edit check passes and otherwise journal, record and report nothing, and MUST apply or publish only while a valid lease exists (CCI-50), restart recovery has completed, `.git/index.lock` is absent, and FREEZE/publish pauses allow it (PRO-45); after 2 min without a lease it MUST stop syncing (no capture, apply or new publish; only CCI-50's flush of already-captured ready pairs and pending board ops), and after 10 min it MUST drain and exit with the `IDLE_NO_SESSION` last status of ENG-56 (glossary §20 seat numbers, §25.2 item 6). _(changed per glossary §27.1, rev 2.4: edit checkpoints added.)_ _Covers: orphan-daemon-outlives-sessions-and-plugin, orphan-daemon-uninstall_
- **ENG-14** Each iteration MUST run the steps of §3.5 in order; the HLD- mass-change breaker MUST run on every detection tick's dirty set, and the HLD- revert detector MUST run on the `S_disk` an iteration materialized before any merge or ready capture of that iteration (changed per glossary §26.1 W6: a tick that materializes nothing has no new `S_disk`); apply MUST use the materialized `S_disk` (never `S_pub`) as ours. _Covers: stale-editor-buffer-reverts-peer-work, rewind-restore-code-reverts-teammates, masked-tree-as-apply-base-starves, user-git-ops-broadcast-as-revert_
- **ENG-15** While `.git/index.lock` exists the iteration MUST only fetch and fold; after it has kept the same mtime for 30 s one notice MUST be raised (`INDEX_LOCK_WAIT`, LIF-10); the daemon MUST never delete it, except the lock adopt itself created (glossary §12, LIF-30). _Covers: git-ops-publish-team-revert_
- **ENG-16** Step 0 MUST read the epoch observation set and apply LIF-'s HEAD decision table (LIF-10, LIF-11), setting or clearing `FREEZE(EPOCH)`; MUST set `FREEZE(CONFIG)` with its detail (`url`, `identity`, `filter`, `public`) when LIF-/SEC- report drift, and under `CONFIG(url|public)` MUST make no network call on the branch (glossary §8); and after a suspend gap > 5 s or a watchdog kill MUST fetch before any apply or publish decision. _Covers: branch-switch-publishes-other-branch, git-ops-publish-team-revert, local-git-ops-propagate-as-reverts, worktree-reset-commands-broadcast-revert, human-git-mass-revert, bash-git-verbs-revert-and-markers, in-progress-ops-not-paused-conflict-markers-broadcast, b-bypass-revert-of-unsaved-peer-work, remote-url-drift, hung-network-git-after-sleep_
- **ENG-17** While any FREEZE reason is set the engine MUST NOT write the working tree on its own initiative, publish code, adopt or save, and MUST keep new claims TENTATIVE; it MUST continue fetch and fold, base moves, human-typed `/cowork resolve` writes, and board-only pushes of exactly the glossary §8 allowed classes (freeze/unfreeze/health `event`s, answer-class `answer`/`request_status`, release-class `release`/`seat_end`/`leave`, and `hold` mirrors; PRO-45); `INCIDENT` MUST additionally forbid every push on the branch except the glossary §4 displaced copy of ENG-21 and the human-typed `/cowork recover`; `CONFIG(url|public)` MUST additionally forbid every network call. _(changed per glossary §8: one FREEZE reason set in meta replaces the SNAPSHOT record; base moves allowed while frozen.)_ _Covers: breaker-freezes-publish-not-apply, branch-switch-publishes-other-branch_

### Fetch and pauses

- **ENG-18** The fetch MUST be the three explicit glossary refspecs against the pinned URL with the runner's network class; on failure the engine MUST run one `ls-remote` of the same three refs and refetch only those that exist, treating an absent board as genesis (no state) or incident (state), an absent mirror as lease `ABSENT`, and an absent branch as `BRANCH_REWRITTEN`; the engine MUST NOT write `FETCH_HEAD`, `ORIG_HEAD`, `refs/remotes/*` or `refs/heads/*`. _Covers: fetch-head-hijack-and-auto-maintenance, ref-rewind-silent-revert_
- **ENG-19** No successful fetch for > 30 s (Δmono) MUST set `OFFLINE` (labelled `AUTH` when SEC-18 derives the `auth` explanation; the two MUST behave identically, glossary §8), and the `OFFLINE` event and status params MUST carry `offline_for_s`, the local Δmono since the last successful fetch (glossary §25.2 item 4); a push rejection MUST NOT set `OFFLINE`/`AUTH` (it follows ENG-44); failed network attempts MUST back off 30 s doubling to 5 min; while `OFFLINE`/`AUTH` the engine MUST continue snapshots, ready captures and local holds, MUST make no push, and MUST queue publishes; reconnect MUST run the ordinary loop with every guard on the fetched tip. _Covers: offline-split-brain, offline-auth-claims, hung-network-git-after-sleep, silent-stall-no-visible-surface_

### Incidents

- **ENG-20** Before any fold, apply or merge, the engine MUST verify `FP_OK(LA_B, T)`, `FP_OK(LA_C, TIP)`, the board and live commit shapes on the new ranges, and the board ref's existence (§3.7); a bare ancestry test MUST NOT be used; the mirror and displaced refs MUST NOT be inputs. _Covers: ref-rewind-silent-revert, empty-oid-push-deletes-live-ref_
- **ENG-21** A failed check MUST set `FREEZE(INCIDENT)`, store T at `refs/cowork-local/<enc(b)>/incident-<n>`, emit `INCIDENT` with old and new oids, and push one governed copy of `LA_B` to `refs/cowork/<enc(b)>/displaced/<oid12>` with an `ABSENT` lease while fewer than 3 displaced refs exist; the copy waits for an ordinary governor window like any attempt *(Plan 2 merge, ruling R-21)*. _Covers: ref-rewind-silent-revert, no-history-undo_
- **ENG-22** `/cowork recover` MUST follow §3.7: refuse unless INCIDENT and online; when the current board tip forks from this peer's chain exactly at a displaced candidate and passes the full incident check from it (the team already recovered and continued, step 2a), re-anchor on it through the lost-state per-path rebuild instead of force-pushing; otherwise choose the candidate containing all others on its first-parent chain or refuse `RECOVER_AMBIGUOUS`; preserve the observed bad tip in a displaced ref before overwriting (or refuse `RECOVER_DISPLACED_FULL`); push with `--force-with-lease=…/board:<observed | ABSENT expect>` together with `live_code(X)` to the mirror leased on the fetched mirror value (or ABSENT), so a mirror left on the displaced chain heals; other peers clear INCIDENT when their check passes again. The re-anchor MUST keep this peer's `LA_B` at `incident-<n>-own` (glossary §4) before any state change and emit `LOST_STATE{mode: re_anchor}`. *(Plan 2 merge, Task 16 rulings:)* recover MUST fetch at once, ignoring the network backoff; a confirm MUST resolve a kept push intent first (`RECOVER_OFFLINE{push_intent_unresolved}` when it cannot) and MUST refuse `RECOVER_PREVIEW_STALE` when the preview id no longer matches; step 2's candidates MUST exclude only recover's own `displaced/<peer>/v-<n>` copies, and the exclusion of a candidate equal to V MUST apply to step 2a(i) only; a failing step-2a walk MUST refuse (`RECOVER_OFFLINE{walk}`); the re-anchor MUST refuse `RECOVER_HEAD_STATE{op}` without the symbolic branch HEAD; an X that fails the incident CHECK from `LA_B` MUST never be force-pushed (`RECOVER_AMBIGUOUS{reason: x_check}`); recover's pushes are exempt from the governor window (§3.7 "Windows of the incident pushes"). _Covers: ref-rewind-silent-revert, no-history-undo_

### Snapshot

- **ENG-23** The snapshot MUST use the persistent private index `<gitdir>/cowork/<enc(b)>.index` (holding `S_raw`) and the stat cache, with candidates from metadata only (paths whose lstat differs from the stat cache, plus DAT--admitted new files; §3.8 step 1), MUST NOT use `git add -A` or reseed per loop, MUST skip entirely while a live seat's Bash/PowerShell TXN is open, and MUST not re-read a fenced path or a path whose mtime is < 300 ms old. _(changed per glossary §26.1 W1: stat-dirtiness comes from the stat cache, because private-index entries are written from stage copies.)_ _Covers: locked-file-stalls-snapshot, snapshot-captures-half-written-file, untracked-sweep, untracked-sweep-editor-temp-and-secrets, sync-scope-excludes-and-untracked_
- **ENG-24** A candidate whose staged read fails MUST be UNREADABLE for this loop, and one whose `(size, mtime_ns)` still changes after the one re-read MUST be UNSTABLE for this loop (entries unchanged); unfiltered candidates MUST be compared at a detection tick by one stage-tree `update-index --refresh` call without `-q` on the scratch index followed by one `diff-files --name-only -z` on the same index, whose structured output alone decides equality (the refresh's exit code and "needs update" text never do; glossary §25 F12, §26.2 item 3; 03-data DAT-47), and added in one stage-tree `add --ignore-errors` call when materialized, and filtered candidates MUST be hashed one per call by route (b) at the repository root; after the add, rc 1 MUST mark the paths still listed by `diff-files` against the stage tree UNREADABLE for this loop; rc 128 on a single filtered path MUST make it LOCAL-ONLY and publish nothing this loop; any other failure MUST fail the snapshot. _(changed per glossary §18: structural detection, no stderr parsing; and per glossary §26.1 W1/W6: staged reads, ids only at detection ticks.)_ _Covers: filter-passthrough-leak, secret-filter-fails-open-in-daemon-env, secret-filter-passthrough, peer-normalization-secret-leak, locked-file-stalls-snapshot, snapshot-captures-half-written-file_
- **ENG-25** A missing tracked path MUST be staged as a removal only if also missing ≥ 1 s earlier or hook-attributed; a non-empty → empty change or a > 50 % shrink (measured on the staged size) MUST be excluded until stable across 2 snapshots and attributable (glossary §26.1 W2: a staged read once caught a 0-byte file in 480 snapshots). *(rev 2.5, F10; owner decision D2, final 2026-10-08; stated here in merge round 2)* A snapshot of p whose blob equals the mark's current oid for p of a confirmed `/cowork revert` whose CS is still pending (05-holds Algorithm REV step 8: the written oid, or the new `R[p]` after a clean HLD-41 rebase carried the mark forward; its ready pair in `journal/ready/` or its `cs_id` in a non-terminal record; the mark is re-derived at start per 05-holds §8 Q18), or in which p is missing when that mark is ABSENT, counts as attributed and needs neither a second stable snapshot nor the 1-s second reading; any other content of p, and any snapshot of p once that CS is no longer pending, keeps this rule. A closed CS whose capture hit this exclusion is captured again at the next completed snapshot (as HLD-41's all-closed case). _Covers: atomic-save-window-publishes-deletion, torn-snapshot-publishes-empty-file_
- **ENG-26** The snapshot MUST obey DAT-'s scope classes (carry-through keeps `A[p]` and is never staged as a removal), MUST force every `160000` entry to A's value and keep A's mode and target for every `120000` entry, and MUST produce `S_disk = canon(S_raw)` (DAT-) in a scratch index while the private index keeps `S_raw`. _Covers: eol-bom-stored-form-flip, worktree-isolation-gitlink-and-unmapped-edits, synced-execution-surfaces, untracked-sweep_
- **ENG-27** On every OS, through one code path, the daemon MUST read a user's working file only by the staged read of §2 (open with share read + write + delete, read the whole file, close; `(size, mtime_ns)` checked before and after, one re-read, otherwise skip the path this tick) and MUST run git only on the stage copy, never on the working file (glossary §26.1 W1); every handle the daemon opens on a user file MUST last no longer than one read or metadata call (W3). Acceptance (test 32): the Windows save-failure soak MUST show ≤ 1 **daemon-attributable** failed editor save per 1,000 saves, where daemon-attributable = failures with the daemon minus failures of a no-daemon control on the same PC and file, with ≥ 3,000 saves per arm (one-sided 95 % bound; glossary §26.1 W3). _(changed per glossary §26.1 W1/W3: staged reads are the only mode, no longer a switch triggered by a failed soak; MEASURED 11.4 failed saves per 1,000 with `git add` on the working file vs 0 / 963 in-place failures with staged copies.)_ _Covers: snapshot-captures-half-written-file_

### Guards and merges

- **ENG-28** Step 4 MUST compute `S_pub := MASK(S_disk)` through HLD- after the detectors and MUST abort every publish of the iteration when HLD-'s INV-MASK assertion fails, never falling back to `S_disk`. _Covers: masked-tree-as-apply-base-starves, absorbed-hold-evades-history-detectors, rewind-restore-code-reverts-teammates_
- **ENG-29** Every 3-way merge MUST use the forms of §3.10 with an explicit `--merge-base` and no `-X`/`--union`; rc 0 results MUST pass REG- `identityCheck` on both-sides paths; rc 1 paths and identity failures MUST go to DAT-'s single conflict function and the tree MUST be rebuilt by whole-path replacement; a result that carries local content onto a path the local side did not change (rename detection) MUST be rebuilt per §3.10 "Rename carry" (target := theirs, source path to the conflict function as a rename unit) on both the apply and the publish side; the record holding a displaced local blob MUST be committed before the disk is overwritten. _Covers: explicit-base-not-ancestry, conflict-tree-applied-or-auto-resolved, conflict-markers-enter-live-ref, disjoint-claims-textual-conflict, merge-misplaces-edit-into-same-tail-neighbor, eol-renormalization-whole-file-conflict_

### Apply

- **ENG-30** Apply MUST run when any `A[p] != TIP[p]` (not merely when `TIP != LA_C`), at most once per 10 s per worktree and at most once per 2 min into files fully read by a mid-turn seat, and only with ≥ 2 × bytes to write + 256 MB free (else `DEFERRED(disk_low)`). _Covers: pending-path-base-misset-reverts, dev-servers-restart-and-crash-on-split-apply, disk-full-or-locked-file-partial-apply-broadcast_
- **ENG-31** The defer set MUST contain every path with a reason of the §3.11 defer table (fence, read lease, TXN, unreadable/unstable, leased conflict, EOL form, local-only conflict, disk low, locked, mismatch, race) and its closure; deferred paths MUST keep `A[p]`, be listed in `meta.pending`, and stay in the tree (carry-through). Not-applicable paths (unmaterializable DAT-33, collision DAT-29, incoming quarantined SEC-32) MUST be excluded from their write group before grouping, keep `A[p]`, get their own INCOMING record at once, be listed in `not_converged`, and MUST NOT defer the rest of their group (glossary §21 INV-GROUP). _Covers: poison-path, unrepresentable-paths-wedge-or-half-apply, fence-vs-inflight-apply-and-stuck-fence, synced-execution-surfaces_
- **ENG-32** The writer MUST write each HLD--supplied write group all or none and defer a group whole when any of its paths is deferred; a deferred group MUST NOT block other groups. _Covers: receiver-path-deferral-materializes-half-cs, partial-apply-on-lock, partial-apply-on-locked-file, apply-partial-on-file-lock, dev-servers-restart-and-crash-on-split-apply_
- **ENG-33** The writer MUST follow §3.11 exactly: journal intent first; `.new` from `cat-file --batch --filters`; per path `DISK_EQ` pre-image check, stat capture, rename to `.old` with stat re-check; creations only into ENOENT; `fs.link` into place; full group rollback on any failure; no git command writes the working tree. It MUST be two-phase and MUST NOT rename over a target (glossary §26.1 W4); on a volume without hard links it MUST use the copy fallback of §2, and `/cowork start` MUST warn and doctor MUST show that degraded writer (glossary §26.2 item 7). _(changed per glossary §26.1 W4 and §26.2 item 7: the rename-over fallback is removed.)_ _Covers: apply-clobbers-concurrent-save, ignored-file-overwrite, readers-see-missing-or-empty-files, partial-apply-on-locked-file, disk-full-or-locked-file-partial-apply-broadcast_
- **ENG-34** Every written path MUST pass the round trip of §3.11 (private-index entry := `M_disk[p]`, then `DISK_EQ` through a staged read, glossary §26.1 W1); a path that fails it and also fails the canon many-candidate check MUST become a PHANTOM PIN record, listed in `not_converged`, and never be published. _Covers: phantom-delta-pingpong-convergence_
- **ENG-35** Each `.old` MUST be kept ≥ 2 s and stat-compared with its post-rename stat before deletion; a changed `.old` MUST be read by a staged read, hashed from its stage copy (route (b)), become an HLD- PATCH record at once and be reported to doctor (long-lived appender warning); writes through a handle held beyond the ring window are outside INV-NOLOSS (glossary §21). _(changed per glossary §21 INV-NOLOSS, rev 2.1.)_ _Covers: apply-clobbers-concurrent-save_
- **ENG-36** An apply MUST end with one state update setting A per §3.11, `LA_C := TIP`, `LA_B := T`, the pending set and the HLD- rebased ready pairs (a rebase conflict decided by HLD-41's split: clean or `CONCAT` write keeps the group ready with `R[p] := M_disk[p]`; a group that is not ready drops the pair; a `TAKE_TIP` displacement cancels the group's readiness with `CS_READY_CANCELLED`), then append the provenance journal, then call LIF-'s adopt check. _Covers: pending-path-base-misset-reverts, naive-push-reverts-unapplied-paths, debounce-splits-every-multifile-turn_
- **ENG-37** `writeLocal(path, expectedCleanBlob|ABSENT, newBlob|DELETE)` and `writeLocalGroup` MUST be the only way any chapter writes a working-tree file; they MUST use the writer's CAS, rename, link, rollback, round trip and journal, MUST NOT change A, LA_C or LA_B, MUST record provenance with the caller's origin, and MUST return the results of §2. _Covers: apply-clobbers-concurrent-save, b-bypass-revert-of-unsaved-peer-work_
- **ENG-38** `pathState(p)` MUST be answered from memory, waiting at most 250 ms for an in-flight write group. _Covers: fence-vs-inflight-apply-and-stuck-fence_

### Publish

- **ENG-39** A publish candidate MUST be P (glossary §3, HLD-42: `MASK(R)` on the paths of every ready, unheld group, built from HLD-'s rebased ready pairs while asserting `A_cap[p] == A[p]`; `A[p]` everywhere else), and `OUT` MUST be `merge-tree --merge-base=A P TIP` with TIP exactly the board lease's live code; a raw snapshot, a stack of local commits or `S_disk` MUST never be pushed. _Covers: pushed-tree-must-be-merge-result, naive-push-reverts-unapplied-paths, debounce-splits-every-multifile-turn_
- **ENG-40** The publish pipeline MUST run B1 (REG- gate, whole-group PIN) before the merge, the identity check and conflict function on the merge, and T0 on OUT, all against the board state folded from exactly the leased tip, and MUST re-run from a fresh fetch after any CAS loss, base move or re-merge. _Covers: race-loser-hunk-lands, a-race-window-overlap-leaks-code, non-atomic-pair-and-fence, cas-remerge-breaks-cs-invariant, gate-fails-open-on-every-hook-failure, bash-powershell-bypass-after-deny, deny-then-bash-workaround, hunk-withdrawal-publishes-signature-without-callers_
- **ENG-41** Before any push the engine MUST assert: (a) Bnew's first parent == T == lease value and its last parent is TIP, an ordinary C with sole parent TIP, or an L′ with first parent TIP, second parent the branch commit named by `Cowork-Base`, and tree == the computed newtree; (b) `paths(diff(TIP, OUT)) ⊆ paths(diff(A, P))`; (c) `OUT[p] == TIP[p]` for every p with `P[p] == A[p]`; (d) OUT is a validated, non-empty tree oid; (e) no blob in `diff(TIP, OUT)` contains a conflict-marker line (`^(<{7} |={7}$|>{7} |\|{7} )` after stripping one trailing CR) absent from both `P[p]` and `TIP[p]`; (f) every blob the push would add passes SEC-07's scan (blobs of `diff(TIP, OUT)`, new `held/` blobs, the new `ops.jsonl`; a hit follows SEC-07's own handling — abort before any network call, no governor attempt, `local_only` `secret-scan` PIN, path/line/detector notice — not the generic failure below); (g) no `160000`/`120000` entry differs from TIP; (h) no quarantined or save-only path differs from TIP; (i) no held region, no path of a held PIN or a `local_only` record, and no `QUARANTINED`, `SAVE_ONLY` or `UNMANAGED` path differs from `A` in P (glossary §21 INV-MASK); (j) every `held/` entry Bnew adds belongs to a non-`local_only` record and to a LIVE path, and no `held/` blob contains a `cowork:`-labelled conflict-marker line (glossary §9, INV-SECRET; restore markers never reach a remote ref). For L′, (b) and (c) are replaced by the base-move guards. A failure MUST abort the push with a doctor record and `NOT_CONVERGED{cause: publish_assert}` to the human and every live seat. _Covers: pushed-tree-must-be-merge-result, naive-push-reverts-unapplied-paths, conflict-markers-enter-live-ref, in-progress-ops-not-paused-conflict-markers-broadcast, empty-oid-push-deletes-live-ref, synced-execution-surfaces_
- **ENG-42** Bnew MUST carry, in one board commit, this publish's ops, the claim ops for every change-set in C, every not-yet-mirrored hold record (only LIVE paths enter a mirrored record; a record with a non-LIVE path, including every engine-created record of §3.10, is `local_only` and travels as its content-free stub; glossary §9) and every other pending op within PRO- board caps; if caps force a split, whole change-sets MUST be dropped from C rather than their claim ops. _Covers: non-atomic-pair-and-fence, local-only-holds-break-nothing-lost_
- **ENG-43** A publish MUST be one `git push --porcelain --no-verify <pinned URL>` with `--force-with-lease=refs/cowork/<enc(b)>/board:<T> <Bnew>:refs/cowork/<enc(b)>/board` and, when the fetched mirror value is ABSENT or an ancestor of `TIP`, `--force-with-lease=refs/cowork/<enc(b)>/code:<mirror|ABSENT> <TIP>:refs/cowork/<enc(b)>/code`; `-o ci.skip` only when the `caps` op recorded push options; the push MUST NOT use `--atomic` (glossary §26.2 item 1: one rule for every host; the board is the authority and the mirror may lag, INV-ENG-AUTH); the push intent MUST be journaled first. _Covers: non-atomic-pair-and-fence, host-policy-and-ci_
- **ENG-44** The push result MUST be decided by observation, never by message text (glossary §26.2 item 2, which resolves the glossary §18 vs §25 F9/F11 conflict): board line `ok` → `LA_C := C` (or unchanged on board-only and L′ publishes), `LA_B := Bnew`, `A[p] := C[p]` where `C[p] == P[p]` and `A[p]` unchanged since capture, rejection streak reset; anything else → fetch the board: Bnew on T′'s first-parent chain → treat as `ok`; `T′ != T` → lease loss, retry in a later window, streak reset (this covers GitHub's server-side loser line `cannot lock ref '<ref>': is at <X> but expected <Y>`, which moved the ref in 100/100 measured races, glossary §25 F9); `T′ == T`, our op ids absent and a porcelain status line for the board ref other than `ok` (a host rejection, whatever its text, e.g. `[remote rejected] … (failed)`, glossary §25 F11) → transient: the rejection streak `meta.rejections` for lease T is incremented in the state update, the publish is retried in a later window after the §3.6 backoff (30 s doubling to 5 min, glossary §20), the second consecutive such rejection is also a host-throttling signal that starts the throttle fallback (ENG-46, glossary §27.2), and the third consecutive such rejection → ENG-45; `T′ == T` without such a line (transport failure, kill, `fatal error in commit_refs` without a ref status line, glossary §25 F11) → retryable network failure, not counted in the streak. The mirror line MUST be ignored. _(changed per glossary §26.2 item 2: one rejection with the board unchanged is no longer NONRETRYABLE; and per glossary §27.2: a streak of 2 starts the throttle fallback.)_ _Covers: ambiguous-push-and-crash-stale-base, op-identity-cursors-board-merge, push-rejection-poisons-chain_
- **ENG-45** The third consecutive host rejection of the same publish with the board unchanged (the rejection streak of ENG-44 reaching 3; glossary §26.2 item 2) MUST set `NONRETRYABLE`: no further push attempts on the branch, the change-sets of the rejected publish become one HLD- PIN record (guard `host-reject`, glossary §9; when the rejected publish was board-only the PIN carries `paths: []`, 05-holds Table 3 row `host-reject`, Plan 2 merge, Task 14 ruling), the host's message (sanitised, display only, labelled `UI_HOST_SAID`, I18N-04) goes to the human only: it is kept in the daemon's doctor record (`log/daemon-<n>.jsonl`) and shown only by `/cowork status` and `/cowork doctor` (read over IPC) on the human surfaces, i.e. the CLI's `tty`/`pipe` output (10-product §3.2 channel `terminal`); in `slash` mode, whose framed output Claude sees (10-product §3.3, §3.19), those verbs MUST print instead a code-only line (`NONRETRYABLE`, the hold id and the absolute terminal command that shows the text, as in `UI_TRUNCATED_SLASH`) and never the text; it never enters any Claude context — not `status.json.message_params` (hook loaders read `status.json`), an event's params, a systemMessage or slash-mode output — because it may carry server-side hook output written by whoever runs the server (a prompt-injection surface); each live seat and the human's systemMessage get only the `NONRETRYABLE` engine event with its code and the hold id (COO-31); fetch/fold/apply continue, and only human `/cowork resume` retries once (the streak restarts at 0): resume MUST end the `host-reject` PIN named by `meta.nonretryable.hold_id` before it clears the pause, so the rejected publish is retried and a crash between the two leaves the pause, never a PIN nothing lifts *(Plan 2 merge, ruling R-28 as amended by final review FC-5; the earlier Plan 2 wording "the host-reject PIN stays" is withdrawn)*; no automatic bisection. Message text may only choose the explanation shown or make the PIN stricter (`local_only` on a host secret-scanner rejection, SEC-17; glossary §18), never decide transient vs NONRETRYABLE. _(changed per glossary §18 and §26.2 item 2: no decision from message text; NONRETRYABLE only at the third consecutive rejection.)_ _Covers: push-rejection-poisons-chain, host-policy-and-ci_
- **ENG-46** Every push attempt (publish, base move, displaced copy, recover, save branch push, save board push, probe) MUST be granted and counted by PRO-'s governor with the glossary §27.2 parameters: B = the board's `protocol.json.budget` (seeded once at genesis from `host.pushBudgetPerMin`, 6–24, default 12, §3.14), G = 5 s and S = 1.5 s at B = 12, per-peer cap B per 60 s Δmono; an attempt MUST NOT start while the sliding team guard holds (≥ B landed board commits observed in the last 60 s Δmono). On a host-throttling signal (§3.12: HTTP 429 or any 5xx on a push or fetch of the branch, a push taking > 10 s Δmono, or the ENG-44 rejection streak reaching 2) the engine MUST put this peer in the throttle fallback for 30 min of local Δmono, restarted by every further signal (B = 6, G = 10 s, S = 3 s, each the stricter of fallback and normal value), persist it as `meta.throttle` (ENG-05), and queue one board `event{kind: health, reason_code: THROTTLE}` on entry and at most one more per 15 min while signals continue; every peer MUST apply the same fallback parameters while it has observed a folded `THROTTLE` event in the last 30 min Δmono (the stricter of its own state and the folded events), without posting an event of its own. Reading the HTTP status from git's text MUST only ever make handling stricter and MUST NOT decide lease loss, transient, NONRETRYABLE or OFFLINE (glossary §18, §3.3 item 6). A CAS loser MUST re-anchor and never retry immediately; the engine MUST push only on change and MUST NOT make periodic, heartbeat or renewal pushes (a `THROTTLE` event is caused only by a signal, never by a timer, and rides the next allowed window). _(changed per glossary §27.2, rev 2.4: B 6 → 12 (6–24), G 10 → 5 s, S 3 → 1.5 s, guard ≥ 6 → ≥ B; automatic fallback and health event added.)_ _Covers: cas-storm-starvation-governor, lease-expiry-clocks-heartbeats_

### Branch moves

- **ENG-47** When `Hr != Hb` the engine MUST classify per §3.13: rewritten → `BRANCH_REWRITTEN`, no base move, no save; save completion → `newtree = tree(TIP)`; otherwise `newtree = merge-tree --merge-base=tree(B) tree(TIP) Hr` with B as defined. Base moves MUST run while FROZEN and MUST never move a branch ref. _Covers: save-reverts-external-commits, branch-moves-under-live, head-drift-after-pull-or-save_
- **ENG-48** A base-move conflict, identity failure or HLD- branch-guard hit MUST block the whole base move and create one base-move hold record per `(Hr, p)` (deduplicated through the fold); `--restore` MUST go through `writeLocal`; `--discard` MUST make the next attempt take `TIP[p]` by whole-path replacement; L′ MUST be published alone under the board lease. _(changed per glossary §22: no exact-match base B′.)_ _Covers: save-reverts-external-commits, held-hunk-escapes-via-branch-commit_
- **ENG-49** The save primitives MUST push the branch first with `--force-with-lease=refs/heads/<b>:<Hb>` and then the board with `Ls` (`tree(Ls) == tree(TIP)`), as two pushes, never `--atomic` (glossary §26.2 item 1), never force, and an interrupted save MUST be completable by any daemon through ENG-47 case (ii). _Covers: save-race-reverts-concurrent-edits, f-save-lagging-tree-reverts-peers, save-splice-commits-untested-tree, save-squash-erases-provenance_
- **ENG-50** When `LA_C` crosses a base-move commit, `EPOCH_BASE := live_base(LA_C)`, attribute caches MUST be invalidated, team config re-read, the stat cache emptied and DAT-'s filter preflight re-run before the next snapshot (real work tree, cwd = repository root, DISK_EQ-safe comparisons only; glossary §25 F12, §26.2 item 3); failure MUST set `FREEZE(CONFIG)`. _Covers: gitattributes-edit-unfilters, filter-passthrough-leak_

### Genesis, join, restart, version

- **ENG-51** Genesis MUST run only when board and mirror are both absent and no state ref exists (board absent with no state ref and the mirror present MUST refuse with `GENESIS_BOARD_MISSING`, §1.2), build L0 and B0 per §3.14 (with `protocol.json.budget` from `host.pushBudgetPerMin` when it validates as 6–24, else 12; glossary §27.2), push both with ABSENT leases in one push, and send the loser of a simultaneous genesis to JOIN. _Covers: join-or-restart-seeds-revert_
- **ENG-52** Join MUST follow §3.14: `A := tree(HEAD)` only after `HEAD == Hb` holds (or after this peer's own base move when `HEAD == Hr`), the initial state's LA_C is the commit that introduced Hb, LA_C moves to TIP only after the first apply, and a join with nothing opted in MUST publish `OUT == tree(TIP)`. _Covers: late-join-wrong-merge-base, join-or-restart-seeds-revert_
- **ENG-53** Restart MUST complete §3.14 steps 1–5 (own-leftover cleanup — which MUST NOT delete the repo-wide `packed-refs.lock`; a stale one, ≥ 30 s untouched at restart, is logged `PACKED_REFS_LOCK_STALE` and left for the human *(Plan 2 merge, Task 15 finding 6)* —, writer rollback of incomplete groups, `.old` resolution, per-path journal decision with the many-candidate `DISK_EQ`, the HLD-41 rebase of every journaled ready pair whose `A[p]` that decision changed (conflicts decided by HLD-41's split as in ENG-36), written in the same state update as `LA_C`/`LA_B`, push and adopt intents, and the drop of created-then-deleted ready paths with its `RESTART_READY_VANISHED` log line, §3.14 *(Plan 2 merge, final review FD)*) before any snapshot is published. A leftover `tmp/broken-state-ref-*` of this branch with no state ref MUST count as a state present (the lost-state path, never JOIN; Plan 2 merge, R-23). _Covers: crash-between-apply-and-state-resurrects-deletes, stale-base-after-crash, ambiguous-push-and-crash-stale-base, join-or-restart-seeds-revert_
- **ENG-54** Lost state MUST rebuild A per path from the newest matching version on TIP's first-parent chain (≤ 500 commits), MUST set `A[p] := TIP[p]` for an unmatched LIVE path only together with a restart record holding its disk bytes, MUST reseed `QUARANTINED` and `SAVE_ONLY` paths without a record (their difference stays under the path-class mask) and MUST NOT read `UNMANAGED` paths (DAT-26), MUST never seed A wholesale from TIP or the live base or re-join, and MUST emit `LOST_STATE`. At start, a lost state whose fetch finds no board MUST refuse `GENESIS_BOARD_MISSING{branch}` with nothing written *(Plan 2 merge, Task 15 decision 1; §3.14 "Lost state")*. _Covers: join-or-restart-seeds-revert, stale-base-after-crash_
- **ENG-55** A board proto or regionSpec different from this daemon's MUST set the `VERSION` publish pause with fetch, fold and apply continuing; a drain request MUST finish the current step, complete the state update, write `status.json` and exit, and the next start MUST be RESTART. _(changed per glossary §8/§22: VERSION is a publish pause, not a FREEZE; no minReader/minWriter raise in v1.)_ _Covers: version-skew-board-and-guards, version-skew-board-loss_

### Health

- **ENG-56** The engine MUST write `status.json` (glossary §14) atomically on every iteration and transition with the state precedence of §3.16 and the machine-wide monotonic heartbeat; `offline` MUST carry `offline_for_s` in `message_params` (glossary §25.2 item 4); when the daemon drains and exits because no seat or human lease remained for 10 min, its last write MUST set `state: "down"` and `message_code: "IDLE_NO_SESSION"` (glossary §25.2 item 6, CCI-50). _Covers: silent-stall-no-visible-surface_
- **ENG-57** Every FREEZE change, publish pause, deferral lasting past one apply, PHANTOM and NOT-CONVERGED path (including every path of a ready publication group that a publish pause or FREEZE keeps from publishing, 02-protocol §3.11 A2) MUST produce the engine event of §3.16 for every live seat on the worktree and the human, and appear in `status.json`. _Covers: silent-stall-no-visible-surface, offline-auth-claims_
- **ENG-58** CI lint MUST fail the build on: a git spawn outside `runGit`; `hash-object --stdin` without `--path` or `--no-filters`; `fs.writeFile*`/`fs.write` with a string payload in daemon code; any `-X` or `--union` on merge-tree; `merge-tree` without `--merge-base`; `git merge-base` on cowork refs; any of `read-tree -u`, `checkout-index`, `checkout`, `switch`, `restore`, `reset --hard`, `stash`, `apply` in daemon code; a tree produced outside the four operations; a `hash-object --path` result compared with a stored blob; a git command that reads working-tree content (`add`, `update-index --add|--refresh|--really-refresh`, `hash-object` of a file argument, a work-tree diff) whose file argument or work tree is the user's work tree rather than `tmp/stage` (glossary §26.1 W1); `update-index --refresh` with `-q`, or one whose result is not read from a following `diff-files -z` on the same index (glossary §25 F12, §26.2 item 3; the same rule as 03-data DAT-47); `hash-object -w` or an object-writing `add` reachable from the detection-tick or hook-request code paths, or outside the ready-pair capture, publish, apply and hold-record modules (W6; 11-testing L-GIT-FORBIDDEN; an edit checkpoint's candidate capture is part of the ready-pair capture module, glossary §27.1); a filter-running command spawned with a cwd other than the repository root or with `--work-tree=<tmp/stage>` for a filtered path (glossary §25 F12); `--atomic` in any push (glossary §26.2 item 1); a push-result branch that reads stderr text to choose retry or NONRETRYABLE (glossary §26.2 item 2; the §3.12 throttle-signal reader, which reads only git's HTTP status and can only start the throttle fallback, is a separate module whose result no classification branch reads, glossary §27.2); `Date.now()` comparisons outside the clock anchor helper; a refspec built outside `push()`; a `crashpoint()` call site missing from `test/crashpoints.json` (L-CRASHPOINTS, 11-testing). _Covers: harness-mock-blind-mixed-os, empty-oid-push-deletes-live-ref, conflict-tree-applied-or-auto-resolved_
- **ENG-59** Production code MUST call `crashpoint(name)` (TST-06; glossary §25.2 item 10: the owning chapter places the call sites that 11-testing §3.6 lists) exactly at these steps of this chapter: `snapshot.index_written` (§3.8, after steps 4–7 updated the private index, before step 8), `apply.intent` (§3.11 after J, before P0), `apply.group.phase1` (end of P1, before P2), `apply.group.mid` (inside P2, between two linked paths of one group), `apply.group.phase2` (after P2 and RT of a group, before the next group or C), `apply.between_groups` (between two iterations of the group loop), `apply.state` (after the step C state update, before the in-memory A cache and the provenance journal are updated), `publish.out_built` (§3.12 after steps 6–7, before step 8), `publish.sent` (after `git push` is spawned, before ENG-44 classifies it), `publish.landed` (after a board line `ok`, before ENG-44's `ok` state update), `recover.displaced` (§3.7 Recover after step 4, before step 5), `recover.reanchor` (§3.7 step 2a after `incident-<n>-own` is written, before the state update that ends the re-anchor's rebuild) and `join.first_apply` (§3.14 Join after step 7, before step 8 or the first publish). _(added in rev 2.3, glossary §25.2 item 10.)_ _Covers: stale-base-after-crash, crash-between-apply-and-state-resurrects-deletes, ambiguous-push-and-crash-stale-base_

---

## 5. Invariants

**Glossary invariants enforced here**

| Invariant | Enforced by |
|---|---|
| INV-FF | ENG-43 (leased FF pushes), ENG-22 (only the human-typed recover pushes non-FF, board and mirror), ENG-09 |
| INV-FIRSTPARENT | ENG-20 |
| INV-BASE | ENG-29, ENG-06, ENG-58 |
| INV-PUSHED-IS-MERGE | ENG-39, ENG-41 (b)(c) — the engine checks the stricter per-path form `diff(A, P)` |
| INV-MASK | ENG-28 (call site; definition HLD-), ENG-39 (P built from `MASK(R)`), ENG-41 (i) |
| INV-FENCE | ENG-40 (B1 on the leased tip, re-run after every re-merge) |
| INV-GROUP | ENG-31 (not-applicable paths, including incoming quarantined paths, excluded before grouping), ENG-32, ENG-33 |
| INV-NOLOSS | ENG-29 (record before displace), ENG-33/35 (ring: late writes observed within the ring window, read by a staged read; long-lived appenders out of scope, doctor warns), ENG-24/ENG-27 (scope note: bytes that were on disk only between two staged reads, or only in a stage copy discarded at restart or superseded before materialization, were never captured, published or displaced, so they are not covered and nothing the daemon did removed them), ENG-53/54 (restart records), ENG-22 (`incident-<n>-own` and displaced ref in re-anchor mode); harness extension HLD-/TST- |
| INV-CONVERGE | ENG-30 (apply until `A == TIP`), ENG-34 (phantoms listed), ENG-46 (no push without change) |
| INV-CLOCK | ENG-05, ENG-58, §3.8 mtime rule (same-machine only) |
| INV-OID | ENG-09 |
| INV-NOSILENT | ENG-56 (including `offline_for_s` and `IDLE_NO_SESSION`), ENG-57, ENG-33 (copy-fallback warning) |
| INV-SECRET | ENG-24 (filter failure → LOCAL-ONLY; route (b) under `required=true` stores nothing when the filter fails, glossary §25 F12), ENG-08 (filters run at the repository root, never on a stage tree), ENG-41 (f) (SEC-07 scan of OUT, `held/` and `ops.jsonl`; SEC-07 also scans the ENG-21 displaced push), (h), (i) (quarantined bytes stay masked, S8), (j) (no `held/` entry for a non-LIVE path or a `local_only` record, no restore-marker blob), ENG-42 (LIVE-only mirrored records) |

**Chapter-local invariants**

| Id | Statement |
|---|---|
| **INV-ENG-AUTH** | The live tip is always `live_code(fetched board tip)`; no engine decision reads `refs/cowork/<enc(b)>/code` or `displaced/*` (the mirror value is used only as a lease and to decide whether to include the mirror refspec). |
| **INV-ENG-BASEPARENT** | Second parents occur only on base-move commits (code chain, naming a branch commit in `Cowork-Base`) and on every board commit (the live code link); no branch commit has a commit carrying `Cowork-Writer` as an ancestor. |
| **INV-ENG-STATE** | The state ref changes only by CAS `update-ref`; `LA_C` and `LA_B` are monotone on their first-parent chains. |
| **INV-ENG-USER** | The user's HEAD, `refs/heads/*`, `.git/index`, `FETCH_HEAD`, `ORIG_HEAD` and `refs/remotes/*` are byte-identical across every iteration except a journaled LIF- adopt. |
| **INV-ENG-NOMARKER** | No pushed blob newly contains a conflict-marker line absent from both its `P` and TIP versions; no marker-bearing merge-tree blob is written to disk, an index or a hold. |
| **INV-ENG-NOSYNTH** | Every tree the engine produces comes from one of the four operations; every published blob exists in `P`, TIP, a clean merge-tree result, an insertion-concat output or a canon output. |
| **INV-ENG-PROGRESS** | A pending path whose defer reason has cleared is applied at the next permitted apply (≤ 10 s coalescing + one iteration), even when `TIP == LA_C`. |
| **INV-ENG-REACH** | After `git gc --prune=now` at any step boundary, every object referenced by the state ref (including journal subtrees) still exists. |
| **INV-ENG-NOREAD** | No git process reads the content of a user's working file (or of a ring `.old` a user process may hold); every daemon handle on a user file lasts one read or metadata call; detection ticks write no object (glossary §26.1 W1, W3, W6). |

---

## 6. Failure handling

| Situation | Detection | Behaviour | What the human sees | What Claude sees |
|---|---|---|---|---|
| Network down / sleep | fetch fails; > 30 s without success; suspend gap > 5 s | OFFLINE pause, backoff 30 s → 5 min, local work continues, publishes queue | status `offline` with `offline_for_s` (glossary §25.2 item 4), OS notification | `OFFLINE{offline_for_s}` at next hook; `ONLINE` on recovery |
| Credential failure | SEC- classification | AUTH pause (behaves exactly as OFFLINE); no prompt (non-interactive env) | status `offline` with the `AUTH` label, fix instruction | `OFFLINE{label: AUTH}` |
| Board missing on remote, state exists | `ls-remote` after failed fetch | INCIDENT, displaced copy of LA_B | `INCIDENT` with oids, `/cowork recover` | `INCIDENT`: edits stay local |
| Board missing on remote, no state, mirror present (start) | `ls-remote` at start dispatch (LIF-06) | start refused, nothing written | `GENESIS_BOARD_MISSING` | nothing (no live session yet) |
| Late peer recovers after the team continued on an earlier recover | §3.7 step 2a | re-anchor: `incident-<n>-own`, restart records, no force-push | recover preview shows re-anchor mode; `LOST_STATE{mode: re_anchor}` | `LOST_STATE` |
| Ready group blocked by a publish pause or FREEZE | state check before publish | paths listed in `not_converged` (`blocked_publish`) | status headline names the pause or FREEZE reason | the pause/FREEZE event already delivered |
| Board rewound / rewritten / shape violation | ENG-20 check | INCIDENT, no apply/push | same | same |
| Mirror missing or rewound | lease value / ls-remote | none; next publish rewrites it | nothing | nothing |
| CAS loss (lease loss) | board tip ≠ lease after the re-fetch, whatever the rejection text (GitHub: `cannot lock ref … is at … but expected …`, glossary §25 F9) | discard Bnew/C, re-anchor, rebuild next window; rejection streak reset | nothing (status pending) | nothing |
| Ambiguous push (timeout, kill, lost reply) | no `ok` line | fetch; Bnew on chain → ok, else retry | nothing | nothing |
| Transient host rejection | `!` status line for the board, board unchanged after the re-fetch, our op ids absent, fewer than 3 in a row (e.g. `[remote rejected] … (failed)`, glossary §25 F11) | retry in a later window with backoff 30 s doubling to 5 min; streak +1 (glossary §26.2 item 2); streak 2 also starts the throttle fallback (next row; glossary §27.2) | nothing (status pending, `last_push_age_ms`) | nothing |
| Host throttling | HTTP 429 or any 5xx in git's report of a push or fetch, a push taking > 10 s Δmono, or a rejection streak of 2 (§3.12; glossary §27.2) | 30-min throttle fallback (B = 6, G = 10 s, S = 3 s), restarted by every further signal; `meta.throttle` set; one `event{kind: health, reason_code: THROTTLE}` on entry, ≤ 1 more per 15 min while signals continue; teammates that fold it follow for 30 min | status `message_code` `THROTTLE` with `budget`, `fallback_left_s`, `signal` while `state` is `ok`; teammates see the health code (UX-22) | nothing |
| Edit check fails at an edit checkpoint | 04-regions/05-holds edit check on the candidate capture (glossary §27.1) | candidate discarded; the CS keeps its last passing ready pair (if any), which still publishes; turn end follows the ordinary boundary (K7 PIN if T0 still fails) | nothing pushed (no event, notification or `status.json` field); the CS's last failed result is kept in daemon memory only (`last_check`, 05-holds HLD-67) and shown in full whenever `/cowork status --flow` or `/cowork wrap` runs, as a slash command (read by the seat's Claude) or in a terminal, never pushed (10 §3.5.1, §3.20.4) _(rev 2.5, F14/F12; owner decision D1, final 2026-10-08, glossary §29.1)_ | nothing (no record, no message; 07-coordination) |
| Host policy rejection | the third consecutive `!` status line for the board with the board unchanged (glossary §26.2 item 2) | NONRETRYABLE, whole-publish PIN | `NONRETRYABLE` notification; host message (sanitised) only in `/cowork status` and `/cowork doctor` terminal (`tty`/`pipe`) output, a code-only line in `slash` mode (ENG-45); `/cowork resume` | `NONRETRYABLE` (code only; the host text never reaches Claude: no systemMessage, `status.json` param, event param or slash output carries it, ENG-45, COO-31) |
| File locked during apply | rename EBUSY/EPERM/EACCES | group rolled back and deferred; retried each loop | status pending; INCOMING record after 60 s | `DEFERRED(locked)` |
| Concurrent save during apply | DISK_EQ mismatch / stat change | re-merge ≤ 3, else defer group | nothing unless persistent | nothing unless persistent |
| Late write into `.old` | ring stat compare | PATCH record at once (`local_only` for a non-LIVE path); doctor record | hold listed in status; doctor warns about a likely long-lived appender (glossary §21 INV-NOLOSS scope) | hold notice (HLD-) |
| Creation collides with local file | lstat before grouping (a collision found by the writer after grouping: `race`, group rolled back, re-classified next loop) | path carried through, local bytes untouched, own INCOMING record (`collision`); rest of group applies | collision listed in `not_converged`, `/cowork resolve <id> --publish` (take the team version) or `--discard` (keep the local version) (DAT-29, glossary §24 default 5) | same |
| Unmaterializable path | DAT- predicate | path carried through, own INCOMING record (`unmaterializable`); rest of group applies | listed in `not_converged` | same |
| Incoming change to a quarantined path | scope class `QUARANTINED` | path carried through, own INCOMING record (`quarantine-review`); rest of group applies | review item, `/cowork review <id> --accept` with preview/confirm (glossary §15; SEC-32/33) | nothing (human decision) |
| Disk nearly full | free-space check / ENOSPC in P0 | whole apply deferred | `DEFERRED(disk_low)` OS notification | same |
| Phantom path | round trip + canon check fail | PIN record, `not_converged` | `NOT_CONVERGED` | `PHANTOM` |
| Unreadable path (snapshot) | staged read refused (sharing violation, `EBUSY`, `EPERM`, `EACCES`), or still listed against the stage tree after `add` rc 1 | excluded this loop, `S_pub[p] := A[p]` | listed if ≥ 60 s (HLD-) | same |
| File changing during the staged read | `(size, mtime_ns)` differs before and after, also after the one re-read (glossary §26.1 W1) | UNSTABLE this loop, retried next tick; a 0-byte capture is held by the shrink guard (W2) | listed if ≥ 60 s (HLD-) | same |
| Volume without hard links | LIF- start preflight | writer uses the copy fallback (readers may see a partial file during a write) | `/cowork start` warning; doctor shows the degraded writer (glossary §26.2 item 7) | nothing |
| Daemon idle: no seat or human lease for 10 min | lease check (CCI-50) | drain and exit | status `down` with `IDLE_NO_SESSION` (glossary §25.2 item 6) | nothing (no seat) |
| Clean filter fails | rc 128 of a filtered path's own route (b) call | path LOCAL-ONLY, no publish this loop | filter error, doctor | path "not shared" |
| index.lock held | file present | fetch/fold only; notice after 30 s | "a git command holds .git/index.lock" | nothing |
| Human git operation | LIF- table | FREEZE(EPOCH) | `FROZEN` with way back | `FROZEN` |
| Mass change | HLD- breaker | FREEZE(MASS) | `FROZEN`, `/cowork resume` | `FROZEN` |
| Branch moved externally, clean | ENG-47 (iii) | base move published | nothing (adopt follows, LIF-) | nothing |
| Branch moved, conflicting | merge rc 1 / identity / guard | base-move holds, save blocked | `BASE_MOVE_CONFLICT`, resolve options | `BASE_MOVE_CONFLICT` |
| Branch rewritten or deleted | ancestry test / missing ref | no base move, no save | status `BRANCH_REWRITTEN` | `BASE_MOVE_CONFLICT{reason: BRANCH_REWRITTEN}` |
| Crash mid-apply | journal apply intent at restart | group rollback, per-path decision | restart records listed | restart records at next hook |
| Crash mid-push | journal push intent | resolve by observation | nothing | nothing |
| State ref deleted | read fails | LOST STATE rebuild | `LOST_STATE` + list | `LOST_STATE` |
| Second daemon writer | state CAS fails | exit, security log | doctor reports | gate G4 until restart |
| Board proto/regionSpec mismatch | fold | VERSION pause, apply continues | "update cowork-sync" | `VERSION_PAUSED` |
| Missing object after user `gc --prune=now` | write-tree / merge rc 128 | reseed private index from `state:snap`, retry | nothing | nothing |
| INV-MASK or pre-push assert fails | assertion | no push this iteration, doctor record | `NOT_CONVERGED{cause: publish_assert}` | `NOT_CONVERGED{cause: publish_assert}` |

---

## 7. Tests

All integration tests run real git ≥ 2.43 against a `file://` bare remote in the TST- simulator; only the network and Claude are faked.

**Unit**

1. `DISK_EQ` on i/crlf: `core.autocrlf=true`, BOM+CRLF file stored i/crlf, 200 applies without concurrent edits → 0 mismatch deferrals, 0 phantoms; the mutant using `hash-object --path` fails. (ENG-11)
2. Runner wrapper rejects a relative `GIT_INDEX_FILE` with `--work-tree` before spawn. (ENG-08)
3. `Oid` parser rejects empty, short, uppercase and whitespace input; `push()` cannot produce `:ref`; deletion function rejects any ref but `refs/cowork/probe-<peer_id>`. (ENG-09, INV-OID)
4. Marker detector: CRLF, BOM, diff3 `|||||||`, markers present in R or TIP not flagged. (ENG-41e)
5. `status.json` precedence table over all combinations of freeze reasons and pauses. (ENG-56)
6. State/meta round trip: every intent kind serialises and every referenced tree is a subtree of the state commit. `meta.since` absent reads as no marks and present round-trips as three heights with `meta.v` unchanged; with only `meta.since` changed, loop iterations make no state-ref update and a drain at exit makes exactly one CAS update (T-F04-restart, owner 10-product, is the end-to-end case). A state commit whose meta carries `since` is read through the same `load()` path as one without it: no lost-state rebuild, every FREEZE reason, incident and NONRETRYABLE record and the pending set intact; a `since` with a missing, extra or negative key is the ordinary unparsable meta. _(rev 2.5, F04; the `load()` case added in merge round 2)_ (ENG-03, ENG-04, ENG-05)

**Integration (deterministic regressions)**

7. x1_save_completion: branch push lands, board push lost; another daemon completes; base `tree(Hb)` mutant resurrects the line. (ENG-47, ENG-49)
8. x2_snapshot_list: `b.txt` held FileShare.None → its staged read is refused, so b is UNREADABLE before any git call; a, c, n and d's deletion published; b keeps its blob and is deferred; after unlock b publishes. (ENG-24, ENG-27)
9. Filter failure: clean command `false`, then driver unset → rc 128 of the path's own route (b) call (at a detection tick and at materialization), path LOCAL-ONLY, nothing pushed that loop, other paths next loop, no plaintext blob reachable from any cowork ref. (ENG-24, INV-SECRET)
10. Torn and atomic saves: partial.js in-place writer and JetBrains/vim/Sublime save sequences → 0 truncated or 0-byte blobs, no D/R entry; an in-place truncate placed between the staged read's two lstat calls, and one placed just before the read, are never captured as a published 0-byte or shortened blob (glossary §26.1 W2: 1 empty capture in 480 staged snapshots). (ENG-25, ENG-27)
11. Write group: closure of 3 paths, one locked → none written, pending recorded; unlock → all three in one group, A updated only for them, one state update. (ENG-32, INV-GROUP)
12. Concurrent writer at random 0–1500 ms offsets during 600 applies → every human write survives on disk, merged, or in a record; tight-loop reader sees 0 zero-byte/partial reads. (ENG-33, INV-NOLOSS)
13. Creation collision: peer B has an ignored `.env`; A publishes `.env` together with `src/a.ts` in one CS → B's `.env` bytes unchanged, `.env` is its own INCOMING record (`collision`) in `not_converged`, `src/a.ts` applies in the same loop (no closure deferral). (ENG-31, ENG-33, INV-GROUP)
14. Portability: a Linux-built tree with `con.py`, `a:b.txt`, `trail.`, `README.md`+`readme.md` plus an edit to `x.txt` in the same CS applied on Windows → `x.txt` applied in the same loop, the others carried through as their own INCOMING records (`unmaterializable`) in `not_converged`, later applies continue. A third case: a branch move changing `.github/workflows/ci.yml` and `src/b.ts` → `src/b.ts` applies, the workflow file becomes a `quarantine-review` item. (ENG-31, INV-GROUP)
15. Disk full: 300 MB loop volume (Linux) and VHD (Windows) filled mid-apply → no truncated file, apply deferred, convergence after freeing space. (ENG-30)
16. Pending progress: defer p by a lock, publish an unrelated change (LA_C := C), unlock with no remote change → p applied at the next permitted apply; mutant "APPLY if TIP != LA_C" fails. (INV-ENG-PROGRESS)
17. Push classification by outcome with pre-receive hooks (glossary §26.2 item 2): (a) `cannot lock ref` after another push landed → lease loss (the ref moved), streak reset; (b) marker blob rejected on every attempt, board unchanged → retried with backoff, NONRETRYABLE at exactly the third consecutive counted attempt and not before; (c) every board commit rejected → NONRETRYABLE at the third, host message shown to the human and absent from every seat's Claude context (the hook prints an instruction-like line); (d) push killed after server accepted → treated as landed, nothing published twice, A and LA_C correct; (e) transport failure with board unchanged and no porcelain line → retryable, not counted; (f) the hook rejects with `[remote rejected] … (failed)` once (and, in a second run, with `cannot lock ref` while the ref stays unchanged) and then accepts → no NONRETRYABLE, the publish lands, streak reset (glossary §25 F11); (g) the rejection text is swapped between runs ("permanent", "try again") with identical outcomes → identical decisions; mutant "classify by text" fails. (ENG-44, ENG-45)
18. Incidents: rewind the board; rewrite keeping the old chain as second parent; delete the board; push a board commit whose last parent jumps to a non-descendant → INCIDENT within 2 polls on every peer, zero applies and pushes, one displaced ref (cap 3); `/cowork recover` restores; peers clear INCIDENT. (ENG-20..22, INV-FIRSTPARENT)
19. Missing mirror: delete the remote mirror between loops → identical decisions; next publish recreates it at `live_code(previous board tip)`. (INV-ENG-AUTH, ENG-18)
20. Branch moves: external commit (e9) → base move keeps both sides; conflicting external commit → base-move holds, save blocked, `--restore` then clean base move; human `git commit -a && git push` of older live content → base-move hold (no B′). (ENG-47, ENG-48)
21. Genesis race: two simultaneous first starters → one genesis, other joins. Join with HEAD behind / equal / ahead / diverged / `HEAD == Hr != Hb`. Join with nothing opted in → first publish `OUT == tree(TIP)`. (ENG-51, ENG-52)
22. Lost state: delete the state ref while live → rebuild, unmatched paths become restart records, no re-join, `LOST_STATE`. (ENG-54)
23. URL drift and network: pushurl ≠ url refused at start (LIF-); blackhole remote → offline after 30 s, backoff 30 s → 5 min, recovery within 60 s, no credential prompt. (ENG-19)
24. Version: a board with a different regionSpec → VERSION pause within one loop; apply continues; no record written by the other version disappears over 1,000 random ops. (ENG-55)
25. Epoch: stash, checkout of another branch, `checkout -- .`, `reset --hard`, bisect, `git commit`, cherry-pick with conflict, `/rewind`-style restore → FROZEN within one loop, no apply/code publish, board-only pushes still mirror holds, base moves still happen. (ENG-16, ENG-17)

**Fault injection and property**

26. Crash matrix: kill -9 / TerminateProcess at every step boundary (apply intent, between P1 and P2 of a group, between groups, after the last write and before the ENG-36 state update with a journaled ready pair on a written path — the next publish's `A_cap[p] == A[p]` assert must pass and the pair must carry the peer's change —, push intent, after push before state update, adopt between index and ref), followed by a peer deleting the just-applied line and `git gc --prune=now`; 100 randomized runs per OS → no resurrection, no missing path, INV-ENG-REACH, leftover `.git/index.lock` handled only per LIF-. (ENG-53, INV-ENG-REACH)
27. Empty-oid injection: `write-tree`/`commit-tree` exit 128 with empty stdout → no push spawned, remote unchanged. (ENG-09)
28. Property oracles after every simulator step: INV-FF, INV-FIRSTPARENT, INV-PUSHED-IS-MERGE (recomputed from the journaled `t/P`), INV-ENG-BASEPARENT (no `Cowork-Writer` commit in `rev-list refs/heads/<b>`), INV-ENG-STATE (reflog shows only CAS updates), INV-ENG-USER (hash `.git/index`, `FETCH_HEAD`, `ORIG_HEAD`, `refs/heads` before/after every non-adopt iteration with a concurrent `git pull`), INV-ENG-NOMARKER, INV-ENG-NOSYNTH, INV-NOLOSS with unique per-edit markers, INV-CONVERGE (K = 20 loops, then zero pushes for 5 min), INV-CLOCK (per-peer offsets ±600 s and suspend gaps yield identical decisions). Seed counts per glossary §20.
29. Mutation testing: re-seeded index per loop; applying a conflicted tree; ancestry or stale base; missing attr.tree; `hash-object` comparator; "APPLY if TIP != LA_C"; raw-snapshot push; text-based push classification; relative `GIT_INDEX_FILE`; unrebased ready pair — each must make the suite fail; a surviving mutant blocks release. (TST-)
30. Mixed-OS: a Linux job publishes `Utils.py` + `utils.py` and `con.py`; a Windows job applies from the same bare-remote artifact → not-applicable INCOMING records for the unmaterializable paths, the rest applied, nothing silently overwritten. (ENG-31)

**Performance and soak**

31. 3,001-file repo with the 1.3 MB file, and the 4,353-file repository of glossary §25 F13: snapshot loop with staged reads p95 ≤ 100 ms (baseline p50 53 ms / p95 58 ms, glossary §26.1 W5) including the step 1 metadata walk; idle cycle ≤ 100 ms and ≤ 2 % CPU (W5 measured ≈ 2.2 %, borderline); Windows end-to-end apply of a 1-line change to the 1.3 MB file p95 ≤ 250 ms; report the first snapshot after a restart (full staged pass) as a soak value. (ENG-23, ENG-27, ENG-33)
32. Windows save-failure soak (glossary §26.1 W3; SPIKE-0 item i-a, §26.2 item 5): one editor-like writer saving every 1–5 s on the 1.3 MB BOM+CRLF file, in-place and atomic-save arms, each with a no-daemon control arm of equal length on the same PC and file, ≥ 3,000 saves per arm (≈ 2.5 h) → daemon-attributable failures (with-daemon minus control) ≤ 1 per 1,000 saves (one-sided 95 % bound); 0 Win32 1224 (`ERROR_USER_MAPPED_FILE`) failures in the in-place arm (W1). Apply lag and RSS under the real daemon are SPIKE-0 item i-b and gate the first release, not the start of implementation (§26.2 item 5). (ENG-27)
33. State churn and object growth: 1 h of 4 busy seats, with edit checkpoints on (glossary §27.1: every Claude edit materializes a candidate capture, and every passing one is a journal transition) → state ref updates only at transitions; loose-object growth ≤ 50 MB per busy peer-hour (glossary §26.1 W6 soak gate), counting the blobs of failed candidates; report reflog bytes per hour and candidate captures per hour (soak report values; §8 question 13). (ENG-04)

**Added in review (numbers continue so earlier references stay valid)**

34. Rename carry: local unpublished edit of line 25 of `p.py`; TIP renames `p.py` → `p2.py` and edits line 3. (a) apply first: disk gets TIP's `p2.py` (no line 25 edit) and no `p.py`, one K4 PATCH record holds the local `p.py`, created before the delete, listed in status; (b) publish first (apply coalesced): OUT keeps `p2.py == TIP[p2.py]`, the same record, ENG-41 (b) passes; mutant "accept the carried result" fails both. (ENG-29)
35. Recover after the team continued: sequence (peer X offline at B100, peer Y publishes B101..B105 and sleeps, board rewound to B50, X recovers to B100, team publishes B101′..B110′, Y wakes) → Y's recover does not force-push, Y re-anchors on B110′ through the lost-state rebuild, Y's B101..B105-only bytes are restart records, no other peer enters INCIDENT, `displaced/` holds B100 and B105. Controls, each a normal recover (no re-anchor): a bad-shaped commit pushed on top of B100; a plain rewind to B50 while an old `displaced/B30` from an earlier incident still exists; a well-shaped rewrite forking at B50. (ENG-22)

**Added for glossary rev 2.1 (numbers continue)**

36. LIVE-only records: local edits to `.github/workflows/ci.yml` (QUARANTINED), `.gitignore` (SAVE_ONLY), an excluded `gen/x.ts` (UNMANAGED) and `src/a.ts` (LIVE); delete the state ref → only `src/a.ts` gets a restart record (mirrored), the two path-class-masked paths are reseeded with no record and stay masked, `gen/x.ts` is never read; a ring late write into the `.old` of an applied SAVE_ONLY path becomes a `local_only` stub (no `held/` entries, no blob oids on the board); mutant "mirror the quarantined record with `held/` blobs" is stopped by ENG-41 (j) before any network call. (ENG-41, ENG-42, INV-SECRET)
37. Leaving UNMANAGED (engine side of 03-data I-DAT-16): the reseed runs in one state update before the first snapshot that hashes the path, the revert detector never sees the old difference, and no push touches the path; mutant "hash first, reseed later" publishes a revert and fails. (ENG-06, ENG-50, DAT-26)
38. HLD-41 split in ENG-36 and in restart: (a) ready group whose path gets a same-position end-of-file append from TIP → apply writes the D9 concat, the group stays ready with `R[p] == M_disk[p]` and publishes without re-capture; (b) TAKE_TIP displacement → `CS_READY_CANCELLED`, and with every member closed the group is re-captured from the next completed snapshot without waiting for a hook; (c) both cases repeated with a kill between the last write and the ENG-36 update. (ENG-36, ENG-53)
39. Mirror heal on recover: rewind the board and move the mirror onto the bad chain; `/cowork recover` → the mirror equals `live_code(X)` after the recover push; mutant without the mirror refspec leaves the mirror stale after 10 later publishes. (ENG-22)
40. Sliding team guard: 4 busy peers in the simulator with collisions → no peer starts an attempt while it has observed ≥ B landed board commits in the last 60 s Δmono, and the harness counts ≤ B attempts in every 60 s window; run with B = 12 (default) and again in the throttle fallback (B = 6). (ENG-46, U3; changed per glossary §27.2: was ≥ 6 / ≤ 6)
41. Host text isolation (extends 17c): the instruction-like line printed by the pre-receive hook is absent from `status.json` (including `message_params`), from every event's params, from every systemMessage and from `/cowork status` and `/cowork doctor` output in `slash` mode (which prints the code-only `NONRETRYABLE` line with the hold id), and present in `/cowork status` and `/cowork doctor` output in `tty` mode. (ENG-45)
42. Blocked publish is visible: a ready group under the regionSpec VERSION pause and under FREEZE(MASS) → its paths are in `not_converged` with `blocked_publish`; after the lift they publish and the list empties. (ENG-57, INV-NOSILENT)
43. No self-K4 after a publish-side concat: apply coalesced, publish resolves p by D9 concat; the publisher's next apply returns TIP's entry with no record and no event, and later edits stay on disk. (glossary §24 default 1, ENG-29, ENG-44)
44. `GENESIS_BOARD_MISSING`: no state ref, remote board deleted, mirror present → start refused, nothing written locally or remotely. (ENG-51)

**Added for glossary rev 2.2 / 2.3 (numbers continue)**

45. No git on working files (glossary §26.1 W1): with a probe that holds the 1.3 MB file and records every process that maps or reads it, 1,000 snapshot, apply-round-trip, DISK_EQ and ring checks → no git process ever opens a user's working file or a ring `.old` (only stage copies), and every daemon handle on the file lasts one read or metadata call; the same suite runs unchanged on Linux and macOS (one code path). Mutant "git add on the working file" fails. (ENG-27, ENG-08, INV-ENG-NOREAD)
46. Filter cwd (glossary §25 F12): a clean/smudge driver named by a repo-relative script path (the pilot team's form) with `required=true` → detection, materialization, DISK_EQ, `cat-file --filters` and the round trip all run it on stage copies or stdin and get the same ids as a manual `git add` in the real work tree; mutants "route (a) for a filtered path" (`--work-tree=<tmp/stage>`) and "cwd = tmp/stage" fail with rc 128 and publish nothing. (ENG-08, ENG-24)
47. Detection ticks write no objects (glossary §26.1 W6): 20 min of an editor saving the 1.3 MB file every 2.5 s with no capture, apply or record → loose-object count and bytes unchanged; then one `cowork_checkpoint` → exactly the dirty paths' blobs appear; a stage-tree `update-index --refresh` comparison leaves the object count unchanged. Mutant "hash-object -w at every tick" fails. (ENG-04, ENG-24)
48. Fetch single-flight (glossary §25 F10): a remote that delays one fetch by 7 s → no second fetch starts before it ends, the next starts right after it; a gate fresh-fetch request during the slow fetch waits for it and starts none of its own. (ENG-13)
49. `offline_for_s` and `IDLE_NO_SESSION` (glossary §25.2 items 4 and 6): a blackholed remote → `status.json.message_params.offline_for_s` grows monotonically with local Δmono and the `OFFLINE` event carries it; no seat and no human lease for 10 min (virtual clock) → the last `status.json` has `state: "down"` and `message_code: "IDLE_NO_SESSION"`, and a version drain writes `down` without that code. (ENG-19, ENG-56)
50. Copy fallback (glossary §26.2 item 7, §26.1 W4): on a volume without hard links (FAT32/exFAT image) `/cowork start` warns and doctor shows the degraded writer; applies succeed through the exclusive-create fallback; an existing target at create defers `race`; a rollback restores the `.old` bytes; no rename-over is ever issued (an fs trace shows none, also on NTFS). (ENG-33)
51. No `--atomic` (glossary §26.2 item 1): on a host that advertises `atomic`, every publish, save and recover push is issued without `--atomic`; a board lease failure while the mirror line is ok leaves the mirror at `TIP`, a live commit already on the board's chain (ENG-43 never moves the mirror past `live_code(leased board tip)`), and the next iteration decides from the board only (INV-ENG-AUTH). (ENG-43, ENG-49)
52. Crashpoint placement (glossary §25.2 item 10): the 13 names of ENG-59 exist as call sites at the listed steps, `test/crashpoints.json` equals the set of call sites (L-CRASHPOINTS), and each is killed in the test 26 matrix. (ENG-59)

**Added for glossary rev 2.4 (numbers continue)**

53. Edit checkpoint, pass (glossary §27.1): a Claude `Edit` that changes a function body (callers unaffected) → one out-of-cycle iteration, the candidate capture is journaled as the CS's ready pair in one state update and published in the next governor window, before the turn ends; a second passing edit in the same turn replaces the ready pair (newest passing capture wins) and only its content is published. (ENG-13)
54. Edit checkpoint, fail: an `Edit` that removes a parameter while its callers in the merged tree are not yet updated → no ready pair, no record, no event, no message, nothing published from that edit; a CS that had an earlier passing capture still publishes that capture; the next `Edit` that updates the callers passes and is published; a turn that ends with the check still failing follows the ordinary boundary (K7 PIN when T0 fails). Mutant "publish the newest capture whatever the check says" publishes a half-done state and fails. (ENG-13)
55. Quiet period at an edit checkpoint: the iteration starts no earlier than 300 ms after the hook-named path's mtime and its capture holds the edited bytes; with a concurrent in-place writer appending to that path, no capture holds a half-written file; mutant "waive the quiet period for hook-named paths" captures one and fails. Ten `Edit`s within 1 s coalesce into one iteration per loop slot (at most one in flight); an `Edit` reported while a Bash TXN is open is captured at the TXN close. (ENG-13, ENG-23)
56. Hook request and edit checkpoint on one PostToolUse: the claim-confirmation request is answered from detection ids with no object written and without waiting for the capture; the edit checkpoint's candidate writes the dirty paths' blobs; a failing candidate leaves the state ref unchanged and its blobs referenced only by the private index. (ENG-04)
57. Governor at B = 12 (glossary §27.2): 4 busy peers in the simulator → ≤ 12 attempts in every 60 s window, no peer starts an attempt while it has observed ≥ 12 landings in the last 60 s Δmono, worst normal wait G + 3·S = 9.5 s plus one cycle per collision. Genesis with `host.pushBudgetPerMin` = 6, 24, absent and 30 (invalid) → `protocol.json.budget` 6, 24, 12 and 12; changing the config after genesis changes nothing. (ENG-46, ENG-51)
58. Throttle fallback (glossary §27.2): inject each signal alone — HTTP 429 on a push, HTTP 503 on a fetch, a 12 s pre-receive delay, two consecutive transient rejections → the peer's next window uses B = 6, G = 10 s, S = 3 s, `meta.throttle` is set and exactly one `event{kind: health, reason_code: THROTTLE}` is posted; every other peer folds it and uses the fallback parameters from its next window, posting no event; with no further signal every peer returns to B = 12 after 30 min of virtual clock; signals repeated for 60 min re-post at most once per 15 min and no follower returns to 12 in between; a daemon restart during the fallback keeps it (the timer restarts); the 429/5xx text never changes a classification (lease loss, transient, NONRETRYABLE and OFFLINE decisions identical with and without it). Mutant "no health event" leaves followers at B = 12 and fails. (ENG-44, ENG-46, ENG-05)
59. Soak gates for rev 2.4 (glossary §27.1, §27.2): 4 peers with active Claude seats on the real host for 1 h → ≤ B attempts in every 60 s window, zero HTTP 429, publish p95 ≤ 40 s, the fallback engages within one window of an injected throttle signal; report Claude-edit latency (edit → applied on a receiving peer; MODEL 10–30 s) as a soak value; test 33's object-growth gate runs in the same soak. (ENG-46, ENG-13, ENG-04)

---

## 8. Open questions

Numbering is kept so citations from other chapters stay valid; closed items keep one line saying where they were decided.

1. *(Closed in glossary rev 2: glossary §3 LA_C uses the ENG-07 reading — every path on disk or a pending path whose `A[p]` is retained.)*
2. *(Closed in glossary rev 2: the publish-side input is P, glossary §3; `R_out` is retired.)*
3. *(Closed in glossary rev 2: one `Cowork-Seat` trailer per distinct contributing seat or `human`, glossary §5.)*
4. **Base-move hold ownership.** Records are team-wide in effect but owned by one peer in the registry schema. *Default (ships unless changed):* owner = the daemon whose board publish carried the record first (dedupe key `(Hr, p)`); any human may resolve it through HLD-'s resolve rules.
5. *(Closed in glossary rev 2.1, §24: `incident-<n>-own` is in glossary §4, glossary §8 "Lifted by" names the re-anchoring recover on a late peer, and the owner confirmed the re-anchor policy of §3.7 step 2a. Recover preview and report wording stays with LIF-/10-product.)*
7. *(Closed in glossary rev 2.1, §24 default 1, widened in rev 2.2 by §25.2 item 8: when every conflict region has an empty base block and LOCAL's block already occurs inside TIP's block, 03-data D8 step 0a returns TIP's entry, or the merge-file output with each such region replaced by its TIP block when the tripwire passes (otherwise the general rule), with no record and no event, so LOCAL's cleanly merged changes outside those regions stay (INV-NOLOSS); ENG-44 keeps `A[p]` unchanged after a publish-side concat; test 43.)*
6. *(Closed in glossary rev 2.3, §26.2 item 2: rejections are classified by outcome; a rejection with the board unchanged and our op ids absent is transient and retried with backoff, and only the third consecutive one of the same publish is NONRETRYABLE (ENG-44, ENG-45, test 17). The SPIKE-0 load test measured `[remote rejected] … (failed)` and `fatal error in commit_refs` at 48 pushes/min with the ref unchanged, glossary §25 F11.)*
8. **Stat cache and the private index's stat data (glossary promotion).** Glossary §26.1 W1 forbids git from reading a working file, so the private index's entries are written from stage copies and their stat data no longer describes the working tree; the engine therefore keeps the chapter-local **stat cache** (§2) as the source of stat-dirtiness, and glossary §6's description of `<enc(b)>.index` as "(stat-fresh)" no longer holds literally. The stat cache is in memory, so the first snapshot after a daemon start reads every tracked path once. 03-data §3.5's sentence "`false` is always safe: the persistent stat-fresh index already meets the budget" rests on the old mechanism. *Default (ships unless changed):* promote "stat cache" to glossary §3 and reword glossary §6 to "persistent private index (holds `S_raw`; stat data of stage copies)"; candidates come from a per-tick metadata walk of the tracked paths (§3.8 step 1), measured by test 31; if the walk misses the ≤ 100 ms idle gate on the 4,353-file repository, DAT-21's fsmonitor change list becomes the narrowing source between its 10-min full rescans (03-data decides how).
9. **Revert-detector timing (05-holds).** With glossary §26.1 W6, `S_disk` is new only in an iteration that materializes, so HLD-'s revert detector runs on the materialized `S_disk` before any merge or ready capture of that iteration rather than on every tick (§3.5, ENG-14); the mass-change breaker still runs on every tick's dirty set. *Default (ships unless changed):* this timing; 05-holds states the same call site for its detectors.
10. *(Closed by glossary §26.1 W6: objects are written only for ready-pair captures, publishes, applies and hold records, so a hook request for the current content of named paths (PostToolUse claim confirmation, REG- mapping) never materializes and writes no object; it is answered with detection ids and in-memory bytes as a `diskSnapshotId`, 04-regions §2, REG-35; §3.8 "Hook requests", ENG-04. 06-claude §3.7.6 item 4 states the same.)*
11. *(Closed in rev 2.3: the NONRETRYABLE host text goes only to `/cowork status` and `/cowork doctor` on human surfaces (`tty`/`pipe` output, from the doctor record over IPC); it never enters a systemMessage, `status.json.message_params`, an event's params or any Claude context, and in `slash` mode, whose output Claude sees, those verbs print a code-only line (ENG-45, test 41). 07-coordination COO-31, 08-lifecycle `SAVE_REJECTED_BY_HOST` and 09-security §3.9 use the same carrier set.)*
12. **Filtered paths stored i/crlf.** Filtered paths get no canon (03-data §3.4), and route (b) has no index context, so for a filtered path whose stored form at `EPOCH_BASE` is i/crlf the first materialization can produce a blob in another line-ending form than `A[p]`; without a guard the snapshot would read that as a whole-file local change (the eol-bom-stored-form-flip class). The team's repository has no such path (spikes/RESULTS.md C2). *Default (ships unless changed):* doctor WARNs at start and at every `EPOCH_BASE` change for each filtered path whose `EPOCH_BASE[p]` form is i/crlf, and such a path is treated like a 03-data `MIXED` file (a LIVE path becomes one ON_DISK PATCH record with guard `eol-bom`, masked to `A[p]`, never published) until it is normalised with an ordinary git commit; 03-data decides the final scope class.
13. **Object growth under per-edit captures (glossary §27.1 vs §26.1 W6).** Every Claude edit now materializes a candidate capture, so the dirty paths' blobs are written per edit, not per turn; a failing candidate's blobs are superseded but stay as loose objects (the daemon never runs `gc`, ENG-01). On the 1.3 MB file a fast edit rate could approach the ≤ 50 MB per busy peer-hour gate. *Default (ships unless changed):* §27.1 as written; tests 33 and 59 measure loose-object growth and candidate captures per hour with edit checkpoints on; if the gate is missed, the result goes to the user for a decision rather than a redesign in this chapter.
14. **HTTP 429/5xx on a fetch as a throttle signal.** Glossary §27.2 lists "HTTP 429, any 5xx, push RTT > 10 s, or a transient-rejection streak ≥ 2" as "any host-throttling signal" without naming the call. *Default (ships unless changed):* a 429 or 5xx reported for a fetch of the branch counts too (§3.12 item 1); it only makes the governor stricter and never changes the `OFFLINE` decision.
15. **`THROTTLE` events replayed at join.** A joiner folds up to 255 board commits from the checkpoint at once, so it cannot tell how long ago a `THROTTLE` event in them was posted. *Default (ships unless changed):* replayed events count as observed at the join's fetch (§3.12), so a joiner may run up to 30 min at B = 6 after a recent teammate fallback; restart counts only commits beyond `LA_B`.
16. **`protocol.json` G_s and S_s for budgets other than 12 (cross-chapter, PRO-07).** Glossary §27.2 gives G and S only for B = 12 (5 s, 1.5 s) and the fallback B = 6 (10 s, 3 s); `host.pushBudgetPerMin` allows any integer 6–24. *Default (ships unless changed):* PRO-07 sets G_s and S_s for each budget and this chapter's genesis writes PRO-07's values (§3.14); PRO-04's `G_base = max(G_local, G_s, 60 / B_eff)` keeps landed publishes spaced by at least 60 / B whatever PRO-07 chooses. The health reason code `THROTTLE` (§2) is defined here for 02-protocol, 07-coordination and 10-product (UX-22 `PH_` label) to use.
