# 08 — Lifecycle, save, adopt and human git operations

**Status:** normative, conformed to glossary revision 2.4 (§23, §24, §25, §26, §27; the design was approved by the user on 2026-10-02, glossary §27) · **Depends on:** 00-glossary (+ 01-engine ENG-, 02-protocol PRO-, 03-data DAT-, 04-regions REG-, 05-holds HLD-, 06-claude CCI-, 07-coordination COO-, 09-security SEC-/CFG-, 10-product UX-/I18N-, 11-testing TST-) · **Rev 2.5 feature deltas (2026-10-08, glossary §29):** F04 (`/cowork since`), F10 (`/cowork revert`) and F12 (`/cowork wrap` and the save-preview summary draft) are merged where a block is tagged `rev 2.5`; none changes the protocol, and none of the owner decisions D1–D5 (taken provisionally that day and decided by the owner the same day, glossary §29.1) changes this chapter's text.

This chapter defines how a peer enters, leaves, pauses, resumes, recovers and saves a live cowork session, how the local branch follows a save (adopt, S7), and how the daemon reacts to the human's own git commands (the one HEAD decision table). It applies the glossary (revision 2 with the revision 2.1 owner decisions and technical defaults of §24, the revision 2.2 spike facts F1–F13 and pass-2 owner decisions of §25, the revision 2.3 Windows-contention facts W1–W6 and synthesis decisions of §26, and the revision 2.4 user answers of §27: S1 edit checkpoints §27.1, the U3 push budget of 12 per minute with its automatic fallback §27.2, and the confirmations of S5, S8, T-GRANT_PAUSE and `start --fresh`) as written and does not re-open them. Where §25, §26 or §27 differs from an earlier glossary section, the newer section wins here too, and §27 wins over everything. Every name in `code` that this chapter does not define is a glossary name (00-glossary §N). Glossary symbols keep their glossary meaning here: `P` is the publish composition, `R` a ready tree or the ranked set (glossary §3); this chapter writes the pinned remote URL as `pinned_url` and the resolved remote as `remote_name`. The HEAD decision table's classes are named `E1..E6` so they never collide with the glossary's `T0` checks or `T1` deny carrier (§19).

It aims at five properties:

- **P1 no loss.** No byte is lost across any lifecycle transition (INV-NOLOSS).
- **P2 loud uncertainty.** An uncertain git state freezes the branch loudly. It is never published.
- **P3 one of each.** There is one FREEZE state (glossary §8), one HEAD decision table, one REATTACH primitive and one preview/confirm step.
- **P4 refuse, don't guess.** An unsupported situation is refused with a message code and the one command that gets the user out of it.
- **P5 local clocks only.** No decision compares clocks across machines (INV-CLOCK).

---

## 1. Scope

### 1.1 v1 in scope

- Human-only lifecycle verbs, as slash commands and the same terminal CLI: `start`, `stop`, `pause`, `resume`, `save "<summary>"`, `uninstall [--purge]`. Their flags are glossary §15's; §2.6 says which of them this chapter interprets.
- The one preview/confirm step (§3.2) for every verb on the glossary §15 confirm list, including `recover` and `review <id> --accept`, whose mechanics belong to ENG-22 and SEC-33.
- The verb surface of `/cowork recover` (§3.13): its preview and report in both modes (restore and re-anchor, 01-engine §3.7), not its mechanics.
- The start preflight. It checks tool floors, repo shape, HEAD state, branch-name encoding, remote resolution and URL pinning, repo identity, the one-live rules, and the version check. It also calls the host probe (PRO-49, genesis only), the filter preflight (DAT-16), the anonymity check, policy detection and the IPC key ACL (SEC-12, SEC-28, SEC-20).
- Start dispatch into GENESIS, JOIN or RESTART, and the human-confirmed `start --fresh` (glossary §15). The engine owns their mechanics (ENG-51..ENG-54). This chapter owns the HEAD preconditions, the preview of pre-existing local work, the `--publish` opt-in, and when the `live` marker is written.
- Epoch observation and the one HEAD decision table (E1–E6). Lifting `EPOCH` automatically includes reconciling a human `git pull` (E2).
- Pause (`PAUSED`) and resume. Resume is the single definition for every resumable FREEZE reason.
- Save (glossary §12): final sync, candidate walk-back, `checks.save`, preview/confirm, building the save commit in the CLI (including signing), the leased branch push, the `save` board op, attribution trailers, and the save report.
- Automatic relaxed adopt (S7, glossary §12) through the one REATTACH primitive, its crash recovery, and `ADOPT_BLOCKED` reporting.
- Stop: flush, durability check, release/return/leave, PARK, kept state.
- Uninstall, and plugin removal or disable without uninstall: the shutdown sequence on key/runtime loss.
- Plugin update: forward-only state meta, and the `VERSION` publish pause as seen by lifecycle verbs.
- Offline, sleep, crash and reboot as they affect lifecycle verbs and restart.

### 1.2 v1 refuses (user-visible message codes; exit 1 with the next command, glossary §15)

| Situation | Code | Next command shown |
|---|---|---|
| git < 2.43 in the daemon environment | `START_TOOL_VERSION{git}` | upgrade instruction for git |
| Node < 20, Claude Code < 2.1.270 | `REFUSE_NODE_VERSION`, `REFUSE_CC_VERSION` (owned by CCI-04) | upgrade instruction for the named tool |
| Linked worktree, path under `.claude/worktrees/`, submodule checkout | `REFUSE_WORKTREE` (owned by CCI-04) | "run from the main worktree" |
| Bare repo, shallow clone, partial (promisor) clone, sparse checkout or skip-worktree entries, `core.splitIndex=true`, `<gitdir>/cowork/tmp` on another volume, a name in the live tree that git refuses in any index on this OS (e.g. a root drive-prefix name `a:b.txt` on Windows) met at join or at a lost-state rebuild *(Plan 2 merge, final review FB-6)* | `START_REPO_SHAPE{reason}` | per reason, e.g. `git fetch --unshallow`, `git sparse-checkout disable`, `git config core.splitIndex false` |
| `refs/heads/<b>` is checked out in a linked worktree | `START_BRANCH_ELSEWHERE{path}` | "remove that worktree or switch it to another branch" |
| Repo root under a cloud-sync folder | `START_CLOUD_FOLDER{root}` | "move the clone, or `/cowork start --allow-cloud-folder`" |
| Detached HEAD, HEAD on another branch or unborn (the join and lost-state HEAD checks), git operation in progress, unmerged entries, `.git/index.lock` present | `START_HEAD_STATE{op}` | the way back for that op (§3.4 table; for `detached`, `other_branch` and `unborn`: `git switch <b>`) |
| `enc(b)` > 150 bytes, or case-fold collision with another branch's cowork refs | `START_BRANCH_NAME{reason, other}` | "use a different branch name" |
| No resolvable remote | `START_REMOTE{reason: no_remote}` | `/cowork start --remote <name>` |
| The start's fetch (join, or the lost-state rebuild of 01-engine §3.14) gets no answer from the remote; the remote answered but a local ref update of that fetch failed; the fetched board fails the board checks (`BoardMalformedError` or a fold check) *(Plan 2 merge, Task 15 rulings)* | `START_REMOTE{reason: unreachable \| local_ref_update \| board_malformed}` | `unreachable`: check the network and the remote, then `/cowork start`; `local_ref_update`: check `git for-each-ref refs/cowork-remote/` (another git process, or a stale `.lock` there), then `/cowork start`; `board_malformed`: a teammate whose cowork runs on `<b>` runs `/cowork recover` |
| Fetch URL ≠ push URL; URL rewritten by `insteadOf`/`pushInsteadOf` | `SEC_REFUSE_REMOTE_SPLIT`, `SEC_REFUSE_URL_REWRITE` (owned by SEC-11) | the config line to remove |
| Branch does not exist on the remote | `START_BRANCH_NOT_ON_REMOTE` | `git push -u <remote> <b>` |
| Another branch live in this clone | `START_ONE_LIVE{other}` | `/cowork stop` on the other branch |
| Another clone live on the same (repo identity, branch) for this OS user | `REFUSE_SECOND_CHECKOUT` (owned by CCI-04) | `/cowork stop` in the other checkout |
| HEAD behind the live base at genesis or join | `START_HEAD_BEHIND` | `git pull --ff-only`, then `/cowork start` |
| HEAD ahead of or diverged from the live base (unpushed local commits) | `START_HEAD_AHEAD{c8}` | "push or move your local commits first" (`git push`) |
| Joiner's base move conflicts | `START_BASE_MOVE_CONFLICT{paths, commit}` | "ask the committer to run `git revert --no-edit <c8> && git push`" |
| Board `protocol.json` proto ≠ own (glossary §8 VERSION, proto case: zero pushes) | `START_VERSION` | "update cowork-sync" |
| State meta written by a newer plugin | `START_STATE_NEWER` | "update cowork-sync" |
| Repo identity differs from the one pinned in state | `START_REPO_IDENTITY` | "this clone now points at a different repository; fix the remote" |
| State ref exists but the remote board is absent | `START_BOARD_GONE` | "if your team deleted the board on purpose: `/cowork start --fresh`; otherwise a teammate who is live runs `/cowork recover`" (§3.3.5) |
| No state ref, board absent, code mirror present; or a lost state (state ref unusable, broken or deleted, or a leftover `tmp/broken-state-ref-*` of this branch, 01-engine §3.14) whose fetch finds no board *(Plan 2 merge, Task 15 decision 1)* | `GENESIS_BOARD_MISSING{branch}` (owned by 01-engine ENG-51, cited here; LIF-06 dispatches to it) | "a teammate whose cowork has state for `<b>` should run /cowork recover" |
| `start --fresh` while the remote board exists | `START_FRESH_BOARD_PRESENT` | `/cowork start` (§3.3.5) |
| Local changes at genesis, join, start-after-stop or `--fresh` need an explicit choice | `START_PREVIEW{n_in, m_out, unshared, id}` | `/cowork start --publish=all\|none\|<paths> --confirm=<id>` |
| Save while frozen, publish-paused, base-move-blocked, branch rewritten, config invalid, nothing to save, check not approved, all candidates failing, host rejection | `SAVE_*` (§2.7) | per code |
| Save where every candidate differs in stored form (EOL/BOM) from `Hb` (§3.7 step 5) | `SAVE_EOL_BRANCH_FORM(paths)` (owned by DAT-12; the one registry name, glossary §24 default 11) | "line endings or BOM changed; ask the committer to revert that change" |
| Stop on another branch or during a git op, during an incident, while offline/auth-paused, non-retryable-paused or in the proto form of the VERSION pause, or while another local seat is mid-turn (the board-only form of VERSION does not refuse stop, glossary §24 default 6) | `STOP_*` (§2.7) | per code |
| Stop or uninstall with non-durable non-`local_only` records (durability: HLD-62; condition: HLD-63 step 2) | `STOP_HOLDS_NOT_DURABLE{ids}` (owned here; the registry name, glossary §24 default 11) | retry when online, or `--discard-holds=<ids> --confirm=<id>` |
| Resume of E3/E4/E5, INCIDENT, NOHOOKS, or an unrestored CONFIG change | `RESUME_*` (§2.7) | per code |
| `uninstall --purge` with `local_only` records | `UNINSTALL_HOLDS{ids}` | `/cowork uninstall --purge --discard-holds=<ids> --confirm=<id>` |
| A save to a branch the host rejects for direct pushes (protected branch, required PR, required checks or signatures, GH013, pre-receive), recognised by outcome only: 3 consecutive rejections of the same branch push with `Hr` unchanged (§3.7 step 10; glossary §26.2 item 2) | `SAVE_REJECTED_BY_HOST{host_text}` | "cowork-sync v1 saves only to branches you can push to directly; go live on a feature branch and open the PR from it" |
| A human branch commit that conflicts with live (base move refused) | `BASE_MOVE_CONFLICT` event (ENG-) + `SAVE_BASE_MOVE_BLOCKED` | `git revert --no-edit <c8> && git push`, then `/cowork save` |

Further refusals owned by other chapters but raised during the start preflight (§3.3 step 2): `REFUSE_PROJECT_SCOPE` (CCI-04); `SEC_REFUSE_PUBLIC_REMOTE` and `SEC_REFUSE_PRIVATE_UNCONFIRMED` (SEC-12, anonymity); `SEC_REFUSE_ENV_AUTH` (SEC-05, `git ls-remote` fails in the daemon environment); `SEC_NOHOOKS` (SEC-28, managed policy disables hooks or the plugin); `SEC_REFUSE_IPC_ACL` (SEC-20); `START_FILTER(driver, path, check, fix)` (DAT-16); `CFG_REFUSE_INVALID` (CFG-02: first start or join with an invalid `.cowork/config.json` and no valid config ever recorded); `START_REFUSED_CUSTOM_REFS`, `START_REFUSED_NO_LEASE`, `START_REFUSED_FALLBACK_LINEAR` (PRO-50, genesis probe and fallback namespace). The human evidence check of every acting verb refuses with SEC-25's `SEC_REFUSE_NOT_HUMAN`. *(rev 2: this chapter's former `START_PUBLIC_REPO`, `START_PRIVATE_UNCONFIRMED`, `START_POLICY`, `START_IPC_KEY_ACL`, and the CCI-/SEC-owned parts of `START_TOOL_VERSION`, `START_REPO_SHAPE`, `START_REMOTE` and `START_ONE_LIVE` are replaced by the owning chapters' codes; one situation has one code. rev 2.1: the filter refusal is DAT-16's `START_FILTER` and the probe refusals are PRO-50's `START_REFUSED_CUSTOM_REFS`, `START_REFUSED_NO_LEASE` and `START_REFUSED_FALLBACK_LINEAR`, spelled as 02-protocol defines them (02 retired the `START_*_REFUSED` spelling); the rev-2 name `FILTER_PREFLIGHT_FAILED` existed in no owning chapter and is withdrawn. "No state ref, board absent, mirror present" refuses with 01-engine's `GENESIS_BOARD_MISSING` (ENG-51), and `START_BOARD_GONE` covers only the state-ref case; an earlier rev-2.1 draft of this chapter folded both into `START_BOARD_GONE{case}`, which is withdrawn.)*

### 1.3 Deferred (glossary §22; not v1 behaviour)

- Manual relaxed `/cowork adopt`. v1 has only the automatic S7 adopt.
- `/cowork end`, `gc`, `uninstall --remote-refs`, `refs/cowork-archive`. Remote refs stay; the README documents a manual `git push --delete`.
- Protocol raise, `/cowork protocol`, and automatic proto raising. v1 has fixed `proto = 1`; a mismatch sets the `VERSION` publish pause.
- Statusline chaining. v1 uses `status.json`, systemMessage and OS notifications.
- `FREEZE(DISK)` and the `SNAPSHOT` hold kind. v1 relies on the per-apply free-space check (ENG-) and FREEZE reasons.
- Exact-match base B′ for base-move conflicts. v1 treats them as base-move conflicts: hold, block save, tell the committer.
- Multiple live branches per clone.
- Seat adoption across processes.
- `stop`/`uninstall --export=<dir>`. `--discard-holds` with preview/confirm is the only override; `local_only` records stay on disk and never block `stop` (`uninstall --purge` still refuses on them).
- Claude-facing templates in zh-CN, ja, fr, es. Claude-facing renderings of this chapter's codes exist in `en` and `ko` only (`L_c`, glossary §17/§19); human-facing text ships in all six languages.
- Also deferred by this chapter, as v2 candidates (each refused in §1.2): following a branch switch automatically, per-worktree live mode, shallow/partial/sparse support, saving to a PR branch, and guided rebase of live onto a rewritten branch.

---

## 2. Local definitions

### 2.1 Terms

Glossary terms this chapter used to define locally and now takes from the glossary: **LIVE_UNSAVED** (glossary §3), **seat activity** `MID_TURN` (glossary §3, computed by CCI-), **ready pair / ready tree / P** (glossary §3), **DISK_EQ** (glossary §3, ENG-11), **scope class** and the save-only set (glossary §3), **request identity** `(req_id, to_holder.seat)` (glossary §3).

| Term | Definition |
|---|---|
| **LIVE_UNSAVED** | *(rev 2: now glossary §3; used here unchanged — teammates' (and own) published but unsaved work.)* |
| **E-class** | The result `E1..E6` of the HEAD decision table (§3.4). *(rev 2: renamed from `T1..T6`, which collided with glossary `T0`/`T1`.)* |
| **snap_pre_freeze** | The per-path stored-form oids of the last snapshot taken under the expected epoch, recorded when `EPOCH` or `MASS` is first entered in an episode. Snapshot ticks write no objects (glossary §26.1 W6), so the blobs of that snapshot's dirty paths do not exist and a tree naming them must never be kept reachable (a reachable missing object would break the user's own `git gc`/`fsck`). It is therefore stored as two state tree entries (ENG §3.2, ENG-04): `journal/keep/pre_freeze_base`, a copy of the state's `base` tree (`A`) at that snapshot, whose blobs exist; and `journal/keep/pre_freeze`, a blob holding the canonical JSON map `{path: oid \| "ABSENT"}` of every path where that snapshot differed from `A`. `snap_pre_freeze[p]` is the map value when present, else `pre_freeze_base[p]`. Its oids are only compared (DISK_EQ against an oid, §3.4.2), never read as objects. *(changed in rev 2.3 per glossary §26.1 W6: was "the `S_disk` tree, kept reachable as `journal/keep/pre_freeze`".)* |
| **reconciled set** | The paths `diff(old H_adopt, HEAD)` whose `A[p]` was adjusted by an E2 reconcile. They are excluded from the post-freeze unobserved-delta count (§3.5). |
| **settled candidate** | A save candidate `Lk` such that, for every CS whose most recent `Cowork-CS` trailer on the first-parent chain from the base-move commit that introduced `Hb` (or genesis) up to `Lk` exists, that trailer says `state=closed`. |
| **preview id** | The first 6 lowercase hex digits of SHA-256 over the canonical JSON `{verb, normalized args, items}`. `items` are exactly the oids, paths and record ids the preview printed, sorted; the normalized args include every flag value (glossary §15: "the preview id digests the flag values"). For `review <id> --accept` the items are exactly the record rev, the team blob and the disk blob (glossary §15). The summary draft printed in the save preview (10-product §3.20, FEAT-F12-12) is not a source of `items`; every path it names is already in the digested `diff(Hb, Lk)` list. *(new in rev 2.5, F12.)* It guards against staleness; it is not a secret. |
| **mid-turn seat** | A local seat whose seat activity (glossary §3) is `MID_TURN` and that had hook traffic within the mid-turn window (60 s local monotonic, glossary §20 lifecycle numbers). The seat that issued the current verb is exempt. |
| **stopping** | State-meta flag set during `/cowork stop`. While it is set, new claims stay `TENTATIVE` and are not published. |

### 2.2 Lifecycle fields in state meta

The state ref layout and `meta.json` belong to ENG (01-engine §3.2, ENG-03..ENG-05). This chapter reads these ENG fields: `v` (meta format version, forward-only migration), `pinned.url` (written `pinned_url` in this chapter), `pinned.identity` (the repo identity), `H_adopt`, `expected_epoch.{symref, head, stash}` (`head` is kept equal to `H_adopt`; `stash` is the expected refs/stash value), `freeze_reasons`. It adds the following fields, which ENG persists in the same `meta.json` (no wall-clock or monotonic values, ENG-05):

```
{ remote_name,                                 // resolved remote, display and re-check only (§3.3.1)
  allow_cloud_folder: bool,                    // --allow-cloud-folder given at start
  logs_head_size, orig_head: oid|null,         // §3.4.1 baselines
  freeze_detail: {EPOCH: {cls, op}, CONFIG: {detail: url|identity|filter|public}},  // glossary §8
  reconciled: [path],                          // §3.4.2 RECONCILE; snap_pre_freeze is journal/keep/{pre_freeze_base, pre_freeze} (§2.1)
  stop_mode: "live" | "stopped" | "removed",
  stopping: bool,
  last_adopt_blocked: {X, reasons_hash} | null,
  save_intent: null | {S, Lk, Hb, released_claim_ids} }   // §2.3
```

### 2.3 Intents owned here

- **adopt intent:** `{kind: "adopt", from: H_adopt, to: X, paths: [p], sha_orig, sha_new}` in ENG's `journal/intent.json` (ENG §3.2 lists it). `sha_*` is the SHA-256 of the user index bytes before and after.
- **save intent:** `{S, Lk, Hb, released_claim_ids}` in `meta.save_intent` (§2.2). It is written before the branch push and cleared when the `save` op is on the board's first-parent chain. It lives in meta, not in `intent.json`, because it must survive across loops while the single `intent.json` slot is reused by apply, push and adopt intents. Like every commit named in an intent, S needs no reachability: if the push landed a fetch brings it back; if not, the intent is cleared.

### 2.4 Hold guard name

`join`, class `DECISION`, owner `human` (glossary §9 closed guard table; 05-holds). It is used on the PIN that withholds pre-existing local changes the human did not opt in at genesis, join, start-after-stop or `start --fresh`. It is released by `/cowork resolve <id> --publish|--discard` (HLD-58).

### 2.5 Numbers

Every number this chapter uses is in glossary §20: the "Lifecycle numbers" row (stop/save final sync ≤ 2 governor windows, stop cap 60 s; mid-turn window 60 s; REATTACH index rename retry 5 × 100 ms on EACCES/EPERM; save attribution cap 10 s; join base-move wait 60 s; start WARN below 1 GiB free on the worktree volume, not a refusal), the "Save" row (≤ 20 candidates; `saveTimeoutSec` default 300, max 1,800; 15 min total; ≤ 3 base-move restarts), "index.lock" (notice after 30 s), "Offline" (> 30 s), "OS notifications" (≤ 1 per 30 min per reason class), "Presume absent" (30 min, S4) and the seat numbers (lease loss: stop syncing at 2 min, exit at 10 min; plugin/key check 30 s). `--human <minutes>` takes 1–480 (glossary §15). Every push a lifecycle verb makes (save's branch push and board publish, stop's flush and board push, the removal push) is a governed attempt: it counts toward the per-peer cap (B per 60 s Δmono) and waits for the sliding team guard (no attempt while this peer has observed ≥ B landed board commits in the last 60 s Δmono), where B is the board's `protocol.json.budget`: 12 by default (configurable 6–24 at genesis, §3.3 step 2.10), with governor window G = 5 s and slot S = 1.5 s, and B = 6, G = 10 s, S = 3 s while this peer is in the automatic 30-min throttle fallback (glossary §27.2, which supersedes the §20 "Governor" row's 6 per minute). "2 governor windows" is therefore 10 s normally and 20 s in the fallback, and can last longer under load; the stop cap of 60 s still bounds stop. A rejected lifecycle push is classified by outcome, never by text (glossary §26.2 item 2): after a fetch, a moved leased ref is a lease loss and an unmoved ref with our change absent is transient (retried in the next window with backoff); only the 3rd consecutive rejection of the same push with the ref unchanged is final. Lifecycle pushes feed the §27.2 throttle signals like every other push: HTTP 429, any 5xx, a push RTT > 10 s, or a streak of 2 transient rejections (so the 2nd transient rejection of save's branch push) puts this peer into the fallback and posts the `health{throttle}` event; the save or stop continues under the fallback parameters. *(changed in rev 2.4, glossary §27.2: was "≥ 6 landed board commits".)* `--atomic` is never used (glossary §26.2 item 1). The E3 notice waits for a fetch that completed after HEAD was first seen ≠ `H_adopt` (§3.4.2); that is an ordering rule, not a timer.

One number is local to this chapter and flagged for promotion into glossary §20: the `checks.save` output tail kept for display is the last 4 KiB (§3.7.1).

### 2.6 Flags

The flags are glossary §15's, verbatim. This chapter interprets:

- `start`: `--publish=all|none|<paths>`, `--remote <name>`, `--name <display>`, `--lang <code>`, `--coauthor=on`, `--private-confirmed` (SEC-12), `--wake=off`, `--wake-turn-edits=deny` (stored in `user.json`, glossary §17, used by COO-/CCI-), `--allow-cloud-folder`, `--human <1-480 min>`, `--fresh` (§3.3.5), `--confirm=<id>`.
- `stop`: `--discard-holds=<ids>`, `--confirm=<id>`.
- `save "<summary>"`: `--sign`, `--approve-check=<sha8>`, `--confirm=<id>`.
- `uninstall`: `--purge`, `--discard-holds=<ids>`, `--confirm=<id>`.

Flags of three *(8a batch, after Plan 2's: was two)* glossary §15 verbs that are not lifecycle verbs, cited here and interpreted by their owners: `since`: `--since=<anchor>`, `--json` (read-only; 10-product §3.9a) *(new in rev 2.5, F04)*; `revert <cs_id>|last`: `--confirm=<id>` (acting; the computation is 05-holds Algorithm REV and the verb surface is 10-product's; this chapter interprets only its `--confirm` through §3.2) *(new in rev 2.5, F10)*; `view`: `--no-open`, `--demo[=<file>]`, `--repo <path>` (12-visualizer; read-only) *(8a batch, after Plan 2's; 12 §9.4)*.

Verbs that use the preview/confirm step (§3.2) are exactly glossary §15's list: `save`, `recover` (mechanics in ENG-22, surface §3.13), `start --publish` with pre-existing local work, `start --fresh`, `stop --discard-holds`, `uninstall --purge --discard-holds`, `review <id> --accept` (write in SEC-33; digest of record rev, team blob and disk blob), and `revert <cs_id>|last` (§3.2 item 5; digest of the target, its commit oids and every path's disk and result blob, and the kept and skipped lists) *(new in rev 2.5, F10)*.

### 2.7 Message codes

All codes are entries of the one registry `dist/i18n/codes.json` (glossary §19). Codes owned by other chapters are cited with their rule in §1.2 and are not redefined here. Every code this chapter defines is listed exactly once below, in one of two tables:

- **Table 2.7-A, human-facing only.** Carriers: CLI refusal or report (exit codes per glossary §15), `status.json.message_code`, systemMessage, OS notification. 10-product (UX-/I18N-) renders them in all six languages. Claude never receives them, except as the read-only `cowork_status` summary.
- **Table 2.7-B, Claude-facing.** 07-coordination writes their templates in `en` and `ko` (glossary §19; other languages fall back to `en`, `L_c` §17) and 10-product writes the human mirror in all six languages.

**Table 2.7-A Human-facing codes**

| Code | Params | Next command |
|---|---|---|
| `START_TOOL_VERSION` | `{git}` found version | upgrade instruction for git |
| `START_REPO_SHAPE` | `{reason: bare \| shallow \| partial \| sparse \| skip_worktree \| split_index \| tmp_volume \| path_not_indexable}` (`path_not_indexable` added at the Plan 2 merge: a live-tree name git refuses in any index on this OS, met at join or at a lost-state rebuild, nothing written; final review FB-6) | per reason (§1.2) |
| `START_BRANCH_ELSEWHERE` | `{path}` | "remove that worktree or switch it to another branch" |
| `START_CLOUD_FOLDER` | `{root}` | "move the clone, or `/cowork start --allow-cloud-folder`" |
| `START_HEAD_STATE` | `{op}` (a §3.4.2 E5 op, `unmerged`, `index_lock`, `reset_back`, or — the join and lost-state HEAD checks, added at the Plan 2 merge — `detached`, `other_branch`, `unborn`) | the way back for that op (§3.4.2; `git switch <b>` for `detached`, `other_branch` and `unborn`) |
| `START_BRANCH_NAME` | `{reason: too_long \| case_fold, other}` | "use a different branch name" |
| `START_REMOTE` | `{reason: no_remote \| unreachable \| local_ref_update \| board_malformed}` (the last three added at the Plan 2 merge, Task 15 rulings: the start's fetch got no answer; the remote answered but a local ref update of that fetch failed; the fetched board fails `BoardMalformedError` or a fold check) | `no_remote`: `/cowork start --remote <name>`; the others per reason (§1.2) |
| `START_BRANCH_NOT_ON_REMOTE` | `{remote, branch}` | `git push -u <remote> <b>` |
| `START_ONE_LIVE` | `{other}` | `/cowork stop` on the other branch |
| `START_HEAD_BEHIND` | `{head8, base8}` | `git pull --ff-only`, then `/cowork start` |
| `START_HEAD_AHEAD` | `{c8}` | `git push`, or `git reset --soft <H_adopt8>` at restart (Table 3.3-B) |
| `START_BASE_MOVE_CONFLICT` | `{paths, commit}` | `git revert --no-edit <c8> && git push` by the committer |
| `START_VERSION` | `{board_proto, own_proto}` | "update cowork-sync" |
| `START_STATE_NEWER` | `{meta_v, own_v}` | "update cowork-sync" |
| `START_REPO_IDENTITY` | — | "this clone now points at a different repository; fix the remote" |
| `START_BOARD_GONE` | — (state ref present, remote board absent; the no-state-ref mirror case is 01-engine's `GENESIS_BOARD_MISSING`, ENG-51) | see §1.2 and §3.3.5 |
| `START_FRESH_BOARD_PRESENT` | `{board8}` | `/cowork start` (§3.3.5) |
| `START_PREVIEW` | `{n_in, m_out, unshared, id}` | `/cowork start --publish=all\|none\|<paths> --confirm=<id>` |
| `START_LOW_SPACE` | `{free_bytes}` (WARN below 1 GiB free, never a refusal, §2.5) | — |
| `START_CC_CHECK_SKIPPED` | — (WARN: start run from a terminal skips the Claude Code version check, §3.3 step 2.1) | — |
| `START_NO_HARDLINKS` | `{volume}` (WARN, never a refusal: the volume of `<gitdir>/cowork/tmp` and the worktree has no hard links, so the verifying writer uses its weaker copy fallback; glossary §26.2 item 7, §3.3 step 2.2; doctor shows the same line) | — *(new in rev 2.3)* |
| `START_STASH_CHANGED` | — (restart after a stop with a changed refs/stash, Table 3.3-B row E6) | `git stash show -p` before popping it while live |
| `PREVIEW_STALE` | `{verb, new_id}` + the fresh preview | re-run with the new `--confirm` (the one registry code for every confirm verb; 10-product renders it, §3.4; *Plan 2 merge:* the Plan 2 engine refuses a stale recover confirm with 01-engine's `RECOVER_PREVIEW_STALE` and the fresh preview, Task 16 ruling — an open question for the owner: keep it as the one exception, or fold it into this code) |
| `SAVE_FROZEN` | `{reasons}` | the exit for each reason (§3.5) |
| `SAVE_PUBLISH_PAUSED` | `{pause, offline_for_s?}` (`offline_for_s`, local Δmono, present for `OFFLINE`/`AUTH`, and the template shows the duration; glossary §25.2 item 4) | `OFFLINE`/`AUTH`: reconnect or sign in (`git fetch`); `NONRETRYABLE`: see `/cowork status`; `VERSION` (any form): update cowork-sync |
| `SAVE_BASE_MOVE_BLOCKED` | `{hold_ids, c8}` | `git revert --no-edit <c8> && git push`, or resolve the base-move holds |
| `SAVE_BRANCH_REWRITTEN` | `{Hb8, Hr8}` | "the branch was rewritten; v1 cannot save until it is restored" |
| `SAVE_BRANCH_MOVING` | — | "the branch keeps moving; try again" |
| `SAVE_CONFIG_INVALID` | `{errors}` | fix `.cowork/config.json` with a git commit |
| `SAVE_EOL_BRANCH_FORM` | *(owned by DAT-12 with params `paths`; cited in §1.2 and raised by §3.7 step 5, not redefined here)* | "line endings or BOM changed; ask the committer to revert that change" |
| `SAVE_NOTHING` | — | — |
| `SAVE_SUMMARY_EMPTY` | — | 10-product's `NX_WRAP_THEN_SAVE` (§3.19 there): "`/cowork wrap` shows a suggested summary; then `/cowork save "<summary>"`" *(changed in rev 2.5, F12: was `/cowork save "<summary>"`; the refusal and its condition are unchanged)* |
| `SAVE_CHECK_UNAPPROVED` | `{command, sha8}` | `/cowork save --approve-check=<sha8>` |
| `SAVE_CHECK_FAILED` | `{candidate, output_tail, form_skipped}` (candidates skipped for branch form, §3.7 step 5; `timeout` per §8 Q4) | fix and re-run |
| `SAVE_PREVIEW` | the §3.7 step 6 preview fields, `{id}`, `draft?` (the summary draft of `(G, Lk]` as codes and params, 10-product §3.20, including its unavailable and empty forms; dropped first when a slash-mode preview exceeds the slash cap; never digested, §2.1) *(`draft?` new in rev 2.5, F12)* | `/cowork save "<summary>" --confirm=<id>` |
| `SAVE_SIGN_FAILED` | `{signer_error}` (sanitized) | fix signing, or set `commit.gpgSign=false` |
| `SAVE_REJECTED_BY_HOST` | `{host_text}` (sanitized, verbatim; shown only in this CLI refusal, i.e. slash-mode output, and in the daemon's doctor record read over IPC by `/cowork status` and `/cowork doctor`, never in `status.json.message_params` or a systemMessage, as for 01-engine ENG-45's NONRETRYABLE text) | see §1.2 |
| `SAVE_ALREADY_SAVED` | `{by, S8}` | — |
| `SAVE_BRANCH_MOVED` | — | `/cowork save "<summary>"` (fresh preview) |
| `SAVE_UNCONFIRMED` | — | "the push did not complete; run `/cowork save` again" |
| `STOP_GIT_OP` | `{op}` | the way back (§3.4.2) |
| `STOP_INCIDENT` | — | `/cowork recover` |
| `STOP_PUBLISH_PAUSED` | `{pause: OFFLINE \| AUTH \| NONRETRYABLE \| VERSION, offline_for_s?}` (`VERSION` only in its proto form; the board-only form does not refuse, glossary §24 default 6; `offline_for_s` as for `SAVE_PUBLISH_PAUSED`, glossary §25.2 item 4) | reconnect (or update cowork-sync), or `/cowork pause` to edit uncoordinated now |
| `STOP_SEAT_BUSY` | `{seat_display}` | "wait for that Claude session to finish its turn" |
| `STOP_HOLDS_NOT_DURABLE` | `{ids}` | retry when online, or `--discard-holds=<ids> --confirm=<id>` *(restored in rev 2.1: glossary §24 default 11 names it the registry code; 05-holds HLD-63 cites it; the rev-2 replacement `HOLD_NOT_DURABLE` is withdrawn)* |
| `STOP_LOCAL_ONLY` (stop report line) | `{n_claims, n_requests}` not yet released | "your claims and requests are released on the board at your next `/cowork start`; until then a teammate's PC may presume this PC absent 30 min after a request to it (S4)" (§3.9 step 0) |
| `STOP_REPORT` | the §3.9 step 8 fields: claims released, CSs published and not published, records parked or kept (incl. `local_only` "kept on this PC only", and records carrying `markers` listed with their marker companion, "kept on this PC only"), LIVE_UNSAVED files, number of other Claude sessions no longer coordinated, `skipped_code_publish` (board-only VERSION form) | — |
| `RESUME_NOTHING` | — | — |
| `RESUME_GIT_OP` | `{op}` | the way back (E5) |
| `RESUME_LOCAL_COMMIT` | `{c8}` | `git push`, or `git reset --soft <H_adopt8>` |
| `RESUME_RESET_BACK` | `{H_adopt8}` | `git reset --soft <H_adopt8>` (files are not touched) |
| `RESUME_WAITING_BASE_MOVE` | `{Hr8}` | — (shows the base-move state) |
| `RESUME_INCIDENT` | — | `/cowork recover` |
| `RESUME_CONFIG_URL` | `{old, new}` | restore the remote URL, or `/cowork stop` then `/cowork start` |
| `RESUME_CONFIG_IDENTITY` | — | `/cowork stop`; fix the remote |
| `RESUME_CONFIG_FILTER` | DAT-16's `{driver, path, check, fix}` | DAT- fix line |
| `RESUME_NOHOOKS` | `{cause}` | SEC-/CCI- fix line |
| `RESUME_REPORT` | `{restored_paths, held_ids, remaining_reasons, publish_pause, stash_warning}` (§3.6 REBUILD; `stash_warning` for E6) | — |
| `PAUSE_UNEXPLAINED` | — (OS notification class `NT_PAUSE_UNEXPLAINED` of 10-product, "cowork-sync was paused without a /cowork pause command", §3.6 pause step 4) | `/cowork resume` |
| `RECOVER_PREVIEW` | `{mode: restore \| reanchor, candidate8, observed8, displaced_refs, restart_paths, id}` (§3.13; 10-product renders the headline as `UI_RECOVER_RESTORE` or `UI_RECOVER_REANCHOR`) | `/cowork recover --confirm=<id>` |
| `RECOVER_REPORT` | `{mode, board8, record_ids}` (§3.13) | — |
| `UNINSTALL_HOLDS` | `{ids}` of `local_only` records | `/cowork uninstall --purge --discard-holds=<ids> --confirm=<id>` (non-durable records are refused earlier by the stop step with `STOP_HOLDS_NOT_DURABLE`) |
| `UNINSTALL_REPORT` | `{gitdirs_stopped, purged}` | `/plugin uninstall cowork-sync` |
| `DAEMON_REMOVED` | `{n_held}` | "reinstall and run /cowork start" *(restored in rev 2.1: 10-product UX-27's OS notification class `NT_PLUGIN_REMOVED` renders this code, and 09-security cites it; the rev-2 removal note is withdrawn)* |
| `INDEX_LOCK_WAIT` | `{age}` (status and one notice) | "a git command holds .git/index.lock (for example a commit message editor); sync waits" |

**Table 2.7-B Claude-facing codes** (07-coordination templates `en`/`ko`; 10-product human mirror)

| Code | Params | Carrier and audience |
|---|---|---|
| `EPOCH_COMMIT_HAS_LIVE_WORK` | `{c8, paths, record_ids, H_adopt8}` | E3 notice (§3.4.2): additionalContext at the next hook of every live seat on this clone, plus systemMessage and OS notification to the human. Content: commit `<c8>` contains teammates' unsaved live changes (or held change `<id>`) in `<paths>`; pushing it blocks saves for the whole team; undo with `git reset --soft <H_adopt8>` and use `/cowork save`, or commit only other files. |
| `EPOCH_LOCAL_COMMIT` | `{c8, H_adopt8}` | same carriers. Content: a local commit froze live sync; push it (then it follows as E2) or `git reset --soft <H_adopt8>`. |
| `EPOCH_PULL_WAITING`, `EPOCH_RESET_BACK`, `EPOCH_GIT_OP{op}`, `EPOCH_SWITCHED`, `EPOCH_STASH` | `{op, way_back}` | values of the `cls` parameter of the engine events `FROZEN`/`UNFROZEN` for reason `EPOCH` (glossary §19; 07's `{FREEZEREASON}` value 1). Each needs a human status line with its way back (§3.4.2) and MAY refine Claude's `{FREEZEREASON}` text. |
| `ADOPT_BLOCKED` (engine event, glossary §19; emitted here) | `{paths, reasons}` with reason values `frozen`, `head_moved`, `not_ancestor`, `git_op`, `index_locked`, `txn_open`, `staged`, `incoming`, `not_applied` | once per `(X, reason set)` to the human and each live seat (§3.8.4). 07's `{ADOPTREASON}` needs one text per reason value. |
| `SAVE_REPORT` (engine event, glossary §19; emitted here) | `{saver, branch, S8, Lk8, files, cs_by_author_and_state, own_held, claims_on_saved, attribution_unavailable}` | to the saver and every live seat of the team at its next hook (§3.7 step 12) |

Engine events this chapter also triggers but does not define (templates already in 07-coordination): `FROZEN`, `UNFROZEN` (§3.5), `LOST_STATE` (recover re-anchor, §3.13; REBUILD, §3.6), `BASE_MOVE_CONFLICT` (§3.4.2), `VERSION_PAUSED` (§3.10.3). `LIVE_MARKER_RESTORED` is 06-claude's (CCI-53, §3.6 and INV-LIF-MARKER here). For `PAUSED`, Claude gets no `FROZEN` text: the loader's glossary §13 line is the only Claude-facing pause text.

*(Withdrawn in rev 2.1: `FILTER_PREFLIGHT_FAILED`, `HOLD_NOT_DURABLE`, the `{case}` parameter of `START_BOARD_GONE`, and this chapter's rev-1 spellings `START_CUSTOM_REFS_REFUSED`, `START_NO_LEASE_REFUSED`, `START_FALLBACK_LINEAR_REFUSED`. `GENESIS_BOARD_MISSING` (01-engine ENG-51) and `START_REFUSED_*` (02-protocol PRO-50) are the owning chapters' codes: cited here, not withdrawn; see §1.2.)*

---

## 3. Design

### 3.1 Command authority and evidence

1. Every lifecycle verb is a `/cowork <verb>` slash command with `disable-model-invocation: true`. Its body runs `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <verb> $ARGUMENTS` through `!` preprocessing (glossary §15). The same CLI runs from a terminal.
2. No MCP tool performs a lifecycle verb. Lifecycle state is visible to Claude only read-only, through `cowork_status` (glossary §15) and hook context.
3. The CLI forwards acting verbs to the daemon over the authenticated IPC (SEC-22). The daemon executes a verb only with human evidence: a TTY, or a matching UserPromptExpansion evidence line (SEC-25, CCI-54; 09-security INV-HUMANONLY). For a slash command, UserPromptExpansion fires before the `!` line runs and UserPromptSubmit fires only after it has finished (glossary §25 F5, MEASURED). So the hook loader writes an HMAC-tagged evidence line `{prompt_id, command_name, command_args, t}` from the UserPromptExpansion of the `/cowork` command, to the daemon over IPC or to `tmp/evidence.jsonl` when no IPC is possible (glossary §6). The `!`-run CLI accepts an acting verb only with matching evidence ≤ 60 s old and waits ≤ 3 s for it. An evidence wait on UserPromptSubmit would deadlock and is forbidden (glossary §25 F5). *(changed in rev 2.3: was "a matching UserPromptSubmit within 60 s".)* Evidence is never minted for a wake-origin turn (glossary §3 turn origin; §25 F2: a prompt carrying a cowork nonce `cws-[0-9a-f]{16}` is a doorbell, never a human prompt, and does not refresh "last human prompt"; S5; SEC-25), so a turn started by a teammate notice can never run a lifecycle verb, `recover` or `review --accept`, whatever the wake work set contains. Every human acting verb renews the 60-min human lease on the daemon (glossary §15; CCI-50). UserPromptExpansion is registered for `cowork|cowork-sync:cowork` for every verb (glossary §25 F5), because it carries the evidence. `pause`, and the marker step of `resume`, also run in the dependency-free hook loader on that UserPromptExpansion, so they work while the daemon or `core` cannot load. This is the escape from G4.
4. The advisory PreToolUse(Bash|PowerShell) deny covers command lines that name `dist/cli.js` or `cowork` with a lifecycle verb, and writes into `<gitdir>/cowork/` (CCI-28). It is advisory. The hard boundaries are the human-evidence check and B1.
5. Every board op and commit produced by a lifecycle verb is attributed `origin=human` and `Cowork-Seat: human`.

### 3.2 Preview and confirm

1. A verb that publishes local work, moves a branch, discards held bytes, overwrites the observed disk with a reviewed team version, or force-pushes the board first prints a preview and exits 1 with `--confirm=<id>`. The verbs are exactly glossary §15's confirm list (§2.6).
2. On `--confirm=<id>`, the CLI asks the daemon to recompute the preview from current state and the given flags. If the recomputed id ≠ `<id>`, the daemon refuses with `PREVIEW_STALE` and prints the fresh preview and its id. `PREVIEW_STALE` is the one registry code for this refusal on every confirm verb.
3. Save caches its preview (Lk, check results) in daemon memory, keyed by id (§3.7). A daemon restart drops the cache, and the next confirm re-previews.
4. `review <id> --accept` (glossary §15; SEC-33): the preview shows the record, the team version and the current disk version; its id digests exactly the record rev, the team blob and the disk blob. On a matching confirm, SEC-33 writes through `writeLocal` with the digested disk blob as `expectedCleanBlob`, so the bytes overwritten are exactly the bytes the human looked at; a disk that changed since the preview gives a different id (`PREVIEW_STALE`) or a writer `MISMATCH` (refused, nothing written).
5. `revert <cs_id>|last` (FEAT-F10-01): the preview, its digest (the target, the oids of its commits, and per path the disk blob and the result blob, plus the kept and skipped lists) and the confirmed all-or-none `writeLocalGroup` with the digested disk blobs as expected values are 05-holds Algorithm REV step 8's; items 1 and 2 apply unchanged (a recomputed id that differs, or a writer `MISMATCH`, is `PREVIEW_STALE` and nothing is written). *(new in rev 2.5, F10.)*

### 3.3 `/cowork start`

**Algorithm START (human-typed, or `--human` lease; nothing is written until step 6 unless stated):**

1. **Spawn or connect** the daemon (CCI-51 spawn, SEC-05 env allowlist, CCI-52 version handshake). Every later check that depends on the environment runs in the daemon's process environment. This is the environment that will later run filters and git. DAEMON_ENV keeps the `PATH` entries that the configured filter drivers need. They are resolved at start and shown by doctor (glossary §25 F12), and filters always run with cwd = the repository root.
2. **Preflight**, in order. The first failure refuses with its code (§1.2), and nothing is written. `/cowork doctor` runs the same list in report mode.
   1. Floors (glossary §18): git ≥ 2.43 in the daemon environment (`START_TOOL_VERSION{git}`); Node ≥ 20 and Claude Code ≥ 2.1.270 (CCI-04: `REFUSE_NODE_VERSION`, `REFUSE_CC_VERSION`, the Claude Code version read from MCP `clientInfo.version`; run from a terminal, the Claude Code check is skipped with a WARN). Plugin scope: CCI-04 `REFUSE_PROJECT_SCOPE`.
   2. Repo shape: non-bare. `git rev-parse --git-dir` == `--git-common-dir` and the realpath of the worktree root is not under `.claude/worktrees/` (else CCI-04 `REFUSE_WORKTREE`). `git worktree list --porcelain` shows no linked worktree with `refs/heads/<b>` checked out. `--is-shallow-repository` is false. There is no `extensions.partialClone` or `remote.*.promisor`. `core.sparseCheckout` is false and `git ls-files -t -z` has no `S` entries. `core.splitIndex` is not true. `<gitdir>/cowork/tmp` is on the worktree's volume (ENG-). Hard links are probed on that volume; without them start continues with the WARN `START_NO_HARDLINKS{volume}`, because the writer then uses its weaker copy fallback (glossary §26.2 item 7; two-phase rename is the only full-strength writer form, §26.1 W4), and doctor shows the same line. The root is not under `%OneDrive%`, `%OneDriveCommercial%`, a Dropbox or Google Drive root, or `~/Library/Mobile Documents`, unless `--allow-cloud-folder` is given (recorded in `meta.allow_cloud_folder` and shown in status).
   3. HEAD: symbolic to `refs/heads/<b>`; no marker of §3.4; no unmerged entries; no `.git/index.lock`.
   4. Remote (§3.3.1). This gives `pinned_url`, a fresh fetch, `Hr`, and the repo identity. `Hr` absent → `START_BRANCH_NOT_ON_REMOTE`.
   5. Branch name: `enc(b)` ≤ 150 bytes (glossary §4). One read-only `git ls-remote <pinned_url> refs/cowork/` lists existing names (a failure here in the daemon environment is SEC-05's `SEC_REFUSE_ENV_AUTH`). If another `enc` name case-folds equal to `enc(b)`, refuse.
   6. One-live rules: no other branch of this clone has a `live` marker (glossary §4: one live branch per clone; `START_ONE_LIVE`). No other gitdir listed in `repos.json` for the same (repo identity, `b`) has a `live` marker and a live `daemon.lock` process (CCI-04 `REFUSE_SECOND_CHECKOUT`). Gitdirs in `repos.json` are stored and compared in the one canonical root form of glossary §24 default 12 (`fs.realpathSync.native`, lower-case drive letter, `/` separators, NFC, lower-cased on Windows/macOS), so two spellings of one checkout never pass as two clones.
   7. SEC-: anonymous-readability refusal or one-time private confirmation (SEC-12, `--private-confirmed`); policy detection (SEC-28: a policy that would set NOHOOKS refuses start with `SEC_NOHOOKS`); IPC key ACL (SEC-20).
   8. Versions: if a board exists, its `protocol.json` proto equals own (`proto = 1`), else `START_VERSION` (glossary §8: a proto mismatch allows zero pushes, so this peer could not even publish its `join`). A regionSpec that differs from the folded `teamRegionSpec` does NOT refuse: the peer starts, announces its regionSpec in its `join` (PRO-48) and runs in the regionSpec case of the `VERSION` publish pause (glossary §8: code pushes paused, board-only ops allowed) until the team switches by unanimity of the ranked set R (glossary §3). If a state ref exists, `meta.v` ≤ own (else `START_STATE_NEWER`) and `meta.pinned.identity` equals the fresh identity (else `START_REPO_IDENTITY`).
   9. DAT-15/DAT-16: filter discovery, `required=true` and the idempotency/round-trip preflight (refusal DAT-16 `START_FILTER(driver, path, check, fix)`) at the EPOCH_BASE this start will use (`live_base(TIP)` for join, `Hr` for genesis, `live_base(LA_C)` for restart). The preflight is the glossary §25 F12 replacement, as corrected by §26.2 item 3. It runs in the real work tree with cwd = the repository root (never a scratch work tree or `update-index -q --refresh`). For each filtered path p, `cat-file --filters HEAD:p | hash-object --path=p --stdin` must equal `HEAD:p`, with both sides converted by the same path. Every disk comparison goes through DISK_EQ, never `hash-object --path` of a working file against a blob. DAT-16 owns the exact steps.
   10. Config: `.cowork/config.json` at that EPOCH_BASE is valid or absent. If absent, print the proposed initial config to commit with git (09-security CFG-07, UX-25); nothing is written, and absence is never blocking. An invalid config does not block start when a valid config was recorded earlier (restart): the last valid one is kept and save refuses until it is fixed (glossary §17, CFG-02). A first start or join with an invalid config and no valid config ever recorded refuses with CFG-02's `CFG_REFUSE_INVALID`. At GENESIS only (including the GENESIS that `--fresh` dispatches to, §3.3.5), this config's `host.pushBudgetPerMin` (6–24, default 12 when absent; its validation is 09-security CFG-02's) seeds the genesis `protocol.json.budget` (glossary §27.2; 01-engine ENG-51 writes it, 02-protocol derives the governor parameters). JOIN and RESTART never read it for the budget: a later config change does not change a live board's budget. *(new in rev 2.4, glossary §27.2.)*
   11. PRO-49, GENESIS only: the host capability probe on `refs/cowork/probe-<peer_id>` (glossary §4, active namespace). It runs last, so a refusal at an earlier local check never spends governor budget on a probe. Its result travels in the genesis `caps` op. JOIN and RESTART run no probe; they reuse the folded team caps (PRO-49). Refusals: PRO-50 (`START_REFUSED_CUSTOM_REFS`, `START_REFUSED_NO_LEASE`, `START_REFUSED_FALLBACK_LINEAR`), unless the per-repo fallback opt-in applies (PRO-50, SEC-16).
3. **Identity**: create `<gitdir>/cowork/peer` if absent (128-bit random `peer_id`). The display name is `--name <display>`, else `user.json` displayName, else `git config user.name`, else `peer-<first 8 hex of peer_id>`. It is stored in `user.json`. `--lang` sets the `user.json` language. `--coauthor=on` opts this repo identity into co-author credit with the user's git identity `user.name <user.email>` (privacy default off, glossary §5); it is announced as `join.coauthor_optin` (glossary §7). The display name is never an input to a decision.
4. **Dispatch** (Table 3.3-A), or `--fresh` (§3.3.5).
5. **Preview** of pre-existing local work (§3.3.3). This applies to GENESIS, JOIN, RESTART-after-stop and `--fresh`.
6. **Commit to live**, in order:
   1. The state ref commit exists: created by ENG- genesis/join (ENG-51, ENG-52), or kept by restart (ENG-53).
   2. `repos.json` gets `{gitdir, pinned_url, b}` (gitdir in the canonical root form, step 2.6).
   3. The `live` marker is written, naming the main-worktree realpath. From here on the daemon watches it and re-creates it if it vanishes outside stop or the removal sequence (CCI-53, INV-LIF-MARKER).
   4. `meta.stop_mode := "live"`.
   5. HLD-64 re-attaches the registry, imports this peer's own non-terminal records from the board fold and re-mirrors every non-durable record. This happens BEFORE the loop starts, so the first iteration's MASK sees every held path and P is built only from `MASK(R)` (INV-MASK).
   6. The loop starts. Its first apply goes through ENG- (ENG-30..ENG-36).
   7. After the first apply, HLD-64 offers RESTORE of `PARKED` records. RESTORE merges against the current disk, so it must follow the apply. The offer is made before the first code publish.
   8. The `join` op (and, at genesis only, `caps`) rides the first board push.

The marker is written only after the state ref exists. A crash after that point is a RESTART, never a JOIN (INV-LIF-NOREINIT).

**Table 3.3-A Dispatch**

| State ref for b | Remote board | Remote code mirror | Path |
|---|---|---|---|
| absent | absent | absent | GENESIS (§3.3.2) |
| absent | absent | present | `GENESIS_BOARD_MISSING` (01-engine ENG-51, §1.2; a teammate with state runs `/cowork recover`, ENG-22) |
| absent | present | — | JOIN (§3.3.2) |
| present | present | — | RESTART (§3.3.4) |
| present | absent | — | human start: `START_BOARD_GONE` (exits: `/cowork start --fresh`, §3.3.5, or a live teammate's `/cowork recover`, ENG-22); automatic respawn (marker present): RESTART, whose ENG §3.7 check fails on the missing board ref and sets FREEZE `INCIDENT`, so `/cowork recover` can run on this peer |

#### 3.3.1 Remote resolution, pinning and identity

1. Resolve the remote `remote_name` (SEC-11, glossary §18). Use `branch.<b>.pushRemote`. If that is unset, use `remote.pushDefault`. If that is unset, use `branch.<b>.remote` (glossary §18). Otherwise use `--remote <name>`, or the only configured remote. With none of these → `START_REMOTE{reason: no_remote}`. `origin` is never assumed.
2. Compute `Pf := git remote get-url <remote_name>` and `Pp := git remote get-url --push <remote_name>`. Require `Pf == Pp`, else SEC-11 `SEC_REFUSE_REMOTE_SPLIT`. A split remote would make `Hr` disagree with the user's own pulls, and E2 depends on `Hr`.
3. Refuse with SEC-11 `SEC_REFUSE_URL_REWRITE` if any `url.*.insteadOf` or `url.*.pushInsteadOf` value is a prefix of `Pp` or of the remote's configured URL.
4. Pin `pinned_url := Pp` in `meta.pinned.url`, with `meta.remote_name`. Every daemon fetch and push uses `pinned_url`, never the remote name. The re-check every 60 s and on any config mtime/size change is SEC-11's runner duty. A drift sets FREEZE `CONFIG` with detail `url`.
5. Fetch `refs/heads/<b>` from `pinned_url` (runGit network class). Repo identity := the sorted root oids of the fetched `refs/heads/<b>` (glossary §18), pinned in `meta.pinned.identity`.
6. While live, a change of the resolved URL, the repo identity, the filter set (DAT-17) or a public probe result (SEC-12) sets FREEZE `CONFIG` with detail `url`, `identity`, `filter` or `public` (glossary §8). `CONFIG(url|public)` also forbids every network call on the branch (glossary §8, SEC-11). Managed-policy changes set `NOHOOKS`, not `CONFIG` (glossary §8, SEC-28). Resume (§3.6) lifts `CONFIG` only when the pinned values are restored and doctor passes. An intentional URL change is made by `/cowork stop` and then `/cowork start`, which re-pins as long as the identity is unchanged; under `CONFIG(url|public)` that stop is the local stop of §3.9 step 0.

#### 3.3.2 GENESIS and JOIN preconditions

The engine performs genesis (L0/B0, ABSENT-lease pushes, the loser becomes a joiner; ENG-51), the join fold, A seeding, and the first apply (ENG-52). This chapter adds the HEAD preconditions and their user-visible outcomes.

**GENESIS:**
- Require `HEAD == Hr`.
- HEAD a strict ancestor of `Hr` → `START_HEAD_BEHIND`.
- Otherwise → `START_HEAD_AHEAD`.

**JOIN.** `Hb` is `live_base(TIP)` (glossary §3). Rows are evaluated in order:

| Condition | Outcome |
|---|---|
| `HEAD == Hb` | proceed |
| HEAD strict ancestor of `Hb` | `START_HEAD_BEHIND` (`git pull --ff-only`; safe because cowork is not live yet) |
| `HEAD == Hr` and `Hr ≠ Hb` (the branch moved; live has not base-moved yet) | Wait ≤ 60 s (glossary §20 lifecycle numbers) for a running daemon's base move. Otherwise the joiner performs the ENG- base move (ENG-47, ENG-48, ENG-52) from remote data only and joins on the new base. A conflict → `START_BASE_MOVE_CONFLICT` |
| anything else (ahead or diverged) | `START_HEAD_AHEAD` |

WHY: `late-join-wrong-merge-base` (VERIFIED). A base equal to the live tip reverted all live work. A base equal to the live base reverted a saved edit. Only the joiner's own HEAD was correct. Requiring `HEAD == Hb` makes the joiner's own HEAD also the team base.

#### 3.3.3 Pre-existing local work (GENESIS, JOIN, RESTART after stop, `--fresh`)

1. Base for the preview: `A := tree(HEAD)` (genesis, join, `--fresh`), or the kept `A` (restart after stop).
2. Snapshot `S_disk` with the U10 admission rules (DAT-24), so admitted untracked files count. Like every snapshot, this one reads each user file through a staged copy and never runs git on the working file (glossary §26.1 W1). It writes no objects (W6), so this preview hashes only. Objects are written later, when the opt-in CS captures its ready pair or the `join` PIN record is created.
3. The preview lists:
   - **N**: paths that will change on disk, `diff(A, TIP)`. Paths that also differ locally are marked "will be merged; a same-lines conflict keeps the team version on disk and your version as a hold (S2)".
   - **M**: local changes that would be published, `diff(A, S_disk)` restricted to scope class `LIVE` (glossary §3). Each shows its size and whether it is a new untracked file.
   - **Unshared**: files present but not shared, with exactly one reason per path (DAT-31, UX-09), by scope class (glossary §3): `NOT_ADMITTED` (ignored, `sync.exclude`-excluded, or a new file > 1 MiB), `LOCAL_ONLY` (secret-like name or scanner hit), `QUARANTINED` (glossary §16; "commit with git"), and the save-only set `SAVE_ONLY` ∪ `UNMANAGED`.
4. If M = 0, proceed with no confirmation. The first apply only overwrites files equal to `A`, so no local byte is displaced.
5. If M > 0, nothing is written or published until `--publish=all|none|<pathspec,...> --confirm=<id>`.
   - Opted-in paths form one human CS (HLD-35). Its ready pair is published after the first apply as part of P (glossary §3), through every gate (B1 on P, T0, MASK). A hunk inside a foreign claim becomes K6 → PIN.
   - The remaining paths form one human CS held as a PIN with guard `join` (§2.4). It is kept on disk, masked, and mirrored (`hold` op + `held/<hold_id>/<stage>/<repo path>`, glossary §3/§7).
   - Both sets contain only paths of M, which are LIVE: only LIVE paths enter a mirrored record (glossary §9). A `--publish=<paths>` entry outside M publishes nothing and is shown with its Unshared reason. Non-LIVE paths stay on disk under their path-class mask; a quarantined path's local bytes never reach a remote ref (S8, INV-SECRET).
   - If nothing was opted in, ENG-52 asserts that the first publish changes nothing (`OUT == tree(TIP)`).

#### 3.3.4 RESTART

RESTART is used whenever the state ref exists: after a crash, kill, power loss, reboot, plugin update, or start after stop.

1. Take the daemon instance (IPC bind, SEC-).
2. Remove this chapter's own leftovers: every `<gitdir>/cowork/tmp/save-*` worktree (`git worktree remove --force` via runGit, then `git worktree prune`).
3. ENG-53 restart: writer group rollback, journal apply/push intents, `DISK_EQ` decisions (glossary §3, ENG-11), and ENG-54 LOST-STATE when the state ref or an object is missing. *(Plan 2 merge, Task 15 rulings and decision 1:)* a broken state ref, and a leftover `tmp/broken-state-ref-*` of this branch with no state ref (a state existed, 01-engine §3.14), also take the lost-state path, never JOIN. That path needs HEAD symbolic on `refs/heads/<b>` with no operation in progress (else `START_HEAD_STATE{op}`, nothing written) and refuses, with nothing written, `START_REMOTE{unreachable | local_ref_update}` when its fetch fails, `START_REMOTE{board_malformed}` when the fetched board fails the board checks, `GENESIS_BOARD_MISSING{branch}` when the board is absent, and `START_REPO_SHAPE{path_not_indexable}` when git cannot index a name of the live tree.
   - An **adopt intent** (in `journal/intent.json`) is resolved by §3.8.3.
   - A **save intent** (`meta.save_intent`) is resolved like this: fetch; if `Hr == S` and no `save` op for `S` is on the board, publish it (§3.7 step 11) and clear the intent when that op is on the first-parent chain; if `Hr ≠ S`, clear the intent.
4. Run the HEAD decision table (§3.4) with `H_adopt` from meta. Table 3.3-B decides the outcome.
5. If `stop_mode == "stopped"`, run §3.3.3 with the kept `A`. Edits made while stopped are treated like pre-join work.
6. Continue at START step 6. RESTART never re-joins, and never seeds `A` from TIP or from the live base (INV-LIF-NOREINIT).

**Table 3.3-B Table result at restart**

| E-class | Human `/cowork start` | Automatic respawn (crash, reboot, update; marker present) |
|---|---|---|
| E1 | proceed | proceed |
| E2 | proceed with FREEZE `EPOCH` (E2), reconcile per §3.4.2 | same |
| E3 | refuse `START_HEAD_AHEAD` (push or `git reset --soft <H_adopt8>`) | start frozen, `EPOCH` E3, with notice |
| E4 | refuse `START_HEAD_STATE{reset_back}` | start frozen, `EPOCH` E4 |
| E5 | refuse `START_HEAD_STATE{op}` | start frozen, `EPOCH` E5 |
| E6 | after a stop: re-baseline `expected_epoch.stash`. If refs/stash changed while stopped, print "your stash changed while cowork-sync was stopped; if it contains teammates' work, review it with `git stash show -p` before popping it while live" | start frozen, `EPOCH` E6 |

After a stop, restart also re-baselines `logs_head_size` and `orig_head`.

WHY: lc/P6 (VERIFIED). A restart with kept `A` merges to the tip. A rejoin with `A = HEAD` conflicts. So the state is kept on stop and restart never rejoins.

#### 3.3.5 `/cowork start --fresh` (glossary §15)

`--fresh` exists only for the case the glossary names: the team deleted the remote board by hand (the README's manual `git push --delete`, glossary §22) and this clone still has a state ref for b. It is the one explicit, human-confirmed exception to INV-LIF-NOREINIT. It is binding as specified here: the user confirmed `start --fresh` with preview/confirm on 2026-10-02 (glossary §27; §8 Q1 closed). *(changed in rev 2.4: was "a proposed default pending the owner's sign-off".)*

1. Preflight (§3.3 step 2) runs as usual. The fresh fetch must show the board absent; otherwise refuse `START_FRESH_BOARD_PRESENT` (plain `/cowork start` then restarts on the existing board). No state ref → `--fresh` is ignored and dispatch proceeds per Table 3.3-A.
2. Preview (§3.2, glossary §15 confirm list): the pre-existing local work of §3.3.3 with `A := tree(HEAD)`, the state ref oid that will be deleted, and this peer's non-terminal registry records (kept). Nothing changes until `--confirm=<id>`.
3. On confirm: delete only `refs/cowork-local/<enc(b)>/state` (glossary §15). The hold registry `refs/cowork-local/<enc(b)>/holds`, the private index and `peer` are kept.
4. Dispatch per Table 3.3-A as for a clone without state: GENESIS (board and mirror absent; ENG-51) or `GENESIS_BOARD_MISSING` (mirror present; 01-engine ENG-51), with the §3.3.2 HEAD preconditions and the §3.3.3 opt-in. The new board is an ordinary genesis board: its `protocol.json.budget` is seeded from the current config's `host.pushBudgetPerMin` (§3.3 step 2.10; glossary §27.2), never copied from the deleted board.
5. START step 6 follows. HLD-64 re-attaches the kept registry and re-mirrors every record, since none is durable on the new board (HLD-62).

### 3.4 Epoch observation and the HEAD decision table

#### 3.4.1 Reads

At loop step 0 (ENG-14, ENG-16), and in join, restart and resume, the daemon reads the following. It runs with `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`, and paths from `git rev-parse --git-path`.

- symbolic HEAD; HEAD oid; refs/stash oid or absence
- markers `{MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, REBASE_HEAD, AUTO_MERGE, BISECT_LOG, BISECT_START, rebase-merge/, rebase-apply/, sequencer/}`
- unmerged entries (`git ls-files -u -z`)
- `.git/index.lock` (existence, mtime)
- byte size of `logs/HEAD`; ORIG_HEAD oid

Rules:
- **index.lock.** While it exists, the iteration only fetches and folds (ENG-15). If it keeps the same mtime for ≥ 30 s, one `INDEX_LOCK_WAIT` notice is shown. The daemon never deletes it (glossary §20). The only exception is a lock adopt itself created for REATTACH, identified by the journaled content hash (§3.8.3; glossary §12: "the only lock cowork may remove").
- **logs/HEAD and ORIG_HEAD.** Growth of `logs/HEAD` or a change of ORIG_HEAD never freezes by itself. It marks the next snapshot's unobserved delta as git-op-caused, as input to HLD-'s revert detector (HLD-27) and mass-change breaker (HLD-30). This catches `reset --hard` with HEAD unchanged. The daemon re-baselines both after its own REATTACH (VERIFIED lc/P1: `update-ref` on the checked-out branch appends to `logs/HEAD`).

Expected epoch `E_exp` = {symref `refs/heads/<b>`, HEAD == `H_adopt`, stash == `expected_epoch.stash`, no marker, no unmerged entry} (ENG meta `expected_epoch`, §2.2).

#### 3.4.2 Table (evaluated in row order; first match wins)

| E-class | Condition | Effect | Way back shown (human + every live seat on this clone) |
|---|---|---|---|
| **E5** | symref ≠ `refs/heads/<b>` (switch, `checkout <oid>`, bisect, stopped rebase), or any marker, or any unmerged entry | FREEZE `EPOCH` (`EPOCH_GIT_OP{op}` or `EPOCH_SWITCHED`); no snapshot while E5 | `git switch <b>`; `git bisect reset`; `git rebase --continue\|--abort`; `git cherry-pick --abort`; `git revert --abort`; `git merge --abort`; "resolve the conflicts" (unmerged only) |
| **E6** | stash ≠ `expected_epoch.stash` | FREEZE `EPOCH` (`EPOCH_STASH`) | "run `git stash pop` to continue, or `/cowork resume` to restore the team version and keep your stash" |
| **E1** | HEAD == `H_adopt` | none; if `EPOCH` is set, run the lift check (§3.5) | — |
| **E4** | HEAD strict ancestor of `H_adopt` (reset backwards) | FREEZE `EPOCH` (`EPOCH_RESET_BACK`) | "move your branch back with `git reset --soft <H_adopt8>` (files are not touched)"; cowork never moves the branch here |
| **E2** | `H_adopt` ancestor of HEAD, and HEAD ancestor-or-equal of the freshly fetched `Hr` (human `git pull`, ff-merge, `reset` forward onto a branch commit) | FREEZE `EPOCH` (`EPOCH_PULL_WAITING`) until `HEAD` is ancestor-or-equal of `live_base(TIP)`, then RECONCILE | none needed; status shows "waiting for the team's base move" |
| **E3** | otherwise: HEAD ahead of `H_adopt` but not ≤ `Hr` (commit, amend, merge, cherry-pick, rebase result), or HEAD unrelated | FREEZE `EPOCH`; E3 notice (below) | push it (`git push`, then it becomes E2), or `git reset --soft <H_adopt8>` |

**RECONCILE (E2).** This is one state update. It runs as soon as `HEAD ⊑ live_base(TIP)` on the fetched TIP. It does not wait for an apply, because no apply runs while frozen. Base moves may run while frozen (glossary §8), so this daemon itself performs the ENG- base move (ENG-47, ENG-48) when no other daemon does.

```
for p in paths(diff(old H_adopt, HEAD)):
    if   DISK_EQ(p, TIP[p])  : A[p] := TIP[p]     # disk already has the team version
    elif DISK_EQ(p, HEAD[p]) : A[p] := HEAD[p]    # disk is exactly the pulled branch version,
                                                  # which TIP contains via the base move; next apply brings TIP
    else                     : keep A[p]          # e.g. reset --soft/--mixed forward: disk untouched
H_adopt := HEAD ; reconciled := those paths
then run the lift check (§3.5)
```

`DISK_EQ` is the glossary §3 single comparator (ENG-11). ABSENT compares equal to a missing file. Like every daemon read of a user file, it reads p through the staged copy: one short share-all read with a size+mtime check before and after, hashed with `--path=p` and without `-w`. It never runs git on the working file (glossary §26.1 W1, W6). If p is unstable in this tick (it changed across the read and the one re-read), it is decided neither way: the whole RECONCILE waits for the next loop, because RECONCILE is one state update. The same holds for the lift check (§3.5) and REBUILD (§3.6). *(added in rev 2.3.)* The `else` branch must not default to `HEAD[p]`. `git reset --soft <Hr>` has the E2 shape but leaves the disk untouched, and a `HEAD[p]` base would then publish a revert of `Hr`'s change.

RECONCILE changes `A[p]` without a write and without a confirmed push. ENG-06 lists it as one of the permitted ways `A[p]` may change: "by LIF- RECONCILE (LIF-12, 08-lifecycle §3.4.2) to a blob X with `DISK_EQ(p, X)` true and X ∈ {`TIP[p]`, `HEAD[p]`}". A ready pair on a reconciled path is rebased in the same state update. A rebase conflict there is decided by HLD-41's no-write case: the group's readiness is cancelled (`CS_READY_CANCELLED`) and the group is re-captured.

If the base move is refused (ENG-47: rewritten branch; ENG-48: conflict, identity failure or branch-guard hit), E2 stays frozen. Status shows `BASE_MOVE_CONFLICT`. The exit is that the base-move holds get resolved (ENG-48, HLD-56, HLD-58). Typically the committer runs `git revert --no-edit <c8> && git push`; the revert is base-moved cleanly, and RECONCILE then completes once HEAD is ≤ the new live base.

WHY: VERIFIED lc/P4. `git pull --ff-only` with disjoint dirty paths succeeds and keeps live bytes; it refuses on overlap. So a pulled path is either already team-equal or exactly the branch version.

**E3 notice.** It is sent only after a fetch that completed after HEAD was first seen ≠ `H_adopt` confirms `HEAD ⋢ Hr`. Without that wait, every push the human makes would raise a false alarm. Let `Pk := paths(diff(H_adopt, HEAD))` and `LU := LIVE_UNSAVED (glossary §3) ∪ paths of non-terminal registry records`.

- If `Pk ∩ LU ≠ ∅`: `EPOCH_COMMIT_HAS_LIVE_WORK{c8, paths, record ids}` with the text "commit <c8> contains teammates' unsaved live changes (or held change <id>) in <paths>; pushing it will block saves for the whole team; undo with `git reset --soft <H_adopt8>` and use /cowork save, or commit only other files".
- Otherwise: `EPOCH_LOCAL_COMMIT{c8}`.

Either notice goes to the human (systemMessage at the next hook and an OS notification) and to every live seat on this clone at its next hook (INV-NOSILENT).

WHY: VERIFIED lc/P5. A commit that touches a live-changed path conflicts in the base move (rc=1). A disjoint commit, or one equal to TIP, merges cleanly.

### 3.5 FREEZE entry, notices and automatic lift

1. **Entering a reason** (`EPOCH` here; `MASS` from HLD-30; `PAUSED` §3.6; `INCIDENT` ENG-21; `CONFIG` §3.3.1, SEC-11, SEC-12, DAT-17; `NOHOOKS` CCI-35, SEC-28):
   - Add the reason to `meta.freeze_reasons` (and its `freeze_detail`).
   - If `EPOCH` or `MASS` is the first of the episode, record `snap_pre_freeze` as `journal/keep/pre_freeze_base` plus the oid-map blob `journal/keep/pre_freeze` (§2.1; no snapshot blob is written for it, glossary §26.1 W6).
   - Queue one board `event{kind: freeze, reason_code}`. Glossary §8 allows board-only pushes of freeze/health events while frozen, except that `INCIDENT` forbids every push and `CONFIG(url|public)` forbids every network call; under those the event stays in the outbox (PRO-45).
   - Write `status.json` (ENG-56).
   - Show the human one systemMessage and one OS notification (≤ 1 per 30 min per reason class, glossary §20; UX-20).
   - Give each live seat on this clone one `FROZEN` additionalContext per episode, rendered from 07-coordination's `EV.FROZEN` template (COO-31) with the reason and, for `EPOCH`, the `cls` sub-code of Table 2.7-B. The template text is 07's; this chapter requires only that it says edits stay on this PC and are checked before they are shared when the freeze ends. It has no `PAUSED` variant, because the loader handles paused seats (§3.6).
2. **While frozen**, the glossary §8 effects apply verbatim (ENG-17): no daemon-initiated working-tree write, no code publish, no adopt, no save; new claims stay TENTATIVE; allowed are fetch and fold, base moves, human `/cowork resolve`, board-only freeze/health events, answer-class ops (`answer`, `request_status`), release-class ops (`release`, `seat_end`, `leave`) and hold mirrors. Ready pairs captured before the freeze stay referenced in the state journal, are rebased at every apply (glossary §3), and publish as part of P after the lift (HLD-40, HLD-41).
3. **Automatic lift of `EPOCH`.** The table must return E1, or an E2 RECONCILE must just have completed. Then compute `D := {p : snap_pre_freeze[p] ≠ S_disk_now[p]} \ reconciled`, comparing oids only. If a path is unstable in this tick (§3.4.2), the check waits for the next loop.
   - If HLD-30's mass-change test does not trip on D: remove `EPOCH`, drop `journal/keep/pre_freeze_base` and `journal/keep/pre_freeze`, and clear `reconciled`, and post `event{kind: unfreeze}` and `UNFROZEN`. D then flows through HLD-27's revert detector as an ordinary unobserved delta, marked git-op-caused when `logs/HEAD` or ORIG_HEAD changed during the episode.
   - If it trips: replace `EPOCH` by `MASS`. Only `/cowork resume` lifts it.
   - A freeze is never lifted on a timeout.

WHY: VERIFIED `breaker-freezes-publish-not-apply` (exp_k_stash). With apply continuing, `git stash pop` exits 1 and the team state stays in stash@{0}. So both directions freeze, and stash pop or switching back lifts the freeze automatically only when the disk returned to where it was.

### 3.6 Pause and resume

**`/cowork pause`:**

1. The loader (UserPromptExpansion) or the CLI writes `<gitdir>/cowork/paused` (temp+rename). This works with the daemon down.
2. If the daemon is reachable, it adds `PAUSED` (glossary §8) and publishes `event{kind: freeze, reason_code: PAUSED}` (a board-only push, allowed while frozen). Teammates' status renders the peer as not coordinated from that event (UX-22). Seat-state publication is the `event{kind: health}` record (PRO-38, UX-22).
3. Effects:
   - The hook loader sees `paused` and makes no IPC (no gate, so G4 never fires).
   - On SessionStart and UserPromptSubmit, the loader prints the one glossary §13 line: "cowork-sync is paused for this repo by the user; edits are not coordinated."
   - The daemon makes no working-tree write and publishes no code.
   - No edit checkpoint (glossary §27.1) runs: the PostToolUse and TXN-close hooks make no IPC, so no edit check is run and no ready pair is captured for edits made while paused. Ready pairs captured before the pause stay and publish after resume like any ready pair (§3.5 item 2). *(new in rev 2.4.)*
4. A `paused` marker the daemon observes with no `/cowork pause` human evidence in the last 60 s is still honoured, because it is the user's escape hatch. It is logged to `log/security.jsonl` and raises one OS notification `PAUSE_UNEXPLAINED` (10-product class `NT_PAUSE_UNEXPLAINED`; "cowork-sync was paused without a /cowork pause command"; SEC-25 evidence, which is the UserPromptExpansion evidence of §3.1, SEC-38 logs).
5. The `live` marker is treated the other way round (glossary §24 default 8; CCI-53): a `live` marker that disappears while no stop (§3.9) and no removal sequence (§3.10.2) is running is re-created by the daemon at once, with a security log entry, a `LIVE_MARKER_RESTORED` health event and one OS notification (10-product class `NT_LIVE_MARKER_RESTORED`). `/cowork pause` and `/cowork stop` are the only supported ways to stop coordination; deleting the marker by hand is not one.

**`/cowork resume`.** This is the single resume definition. It handles reasons in this order, never clears a reason it cannot justify, and prints what remains.

1. **PAUSED.** The loader or CLI removes the marker. The daemon lifts `PAUSED` at its next loop or on the CLI request. `A` is unchanged. Edits made while paused are ordinary unobserved local edits: HLD-27's revert detector and HLD-30's breaker apply, and B1 on P / K6 apply at publish.
2. **EPOCH or MASS.** Run the table.
   - E5 → `RESUME_GIT_OP`.
   - E3 → `RESUME_LOCAL_COMMIT`.
   - E4 → `RESUME_RESET_BACK`.
   - E2 with the base move not yet done → `RESUME_WAITING_BASE_MOVE`; nothing changes.
   - E1, E6, or E2 reconciled → **REBUILD** (below).

   **REBUILD:**
   - For each path where `DISK_EQ(p, snap_pre_freeze[p])` is false (an oid comparison through the staged copy, §3.4.2; REBUILD waits for the next loop while a path is unstable), run ENG's lost-state per-path primitive (01-engine §3.14, ENG-54). That sets `A[p] :=` the newest version of p on TIP's first-parent chain (back to the live base, ≤ 500 commits, glossary §20) that matches the disk. Unchanged paths keep `A[p]`.
   - An unmatched p gets `A[p] := TIP[p]`, and its disk bytes become a PATCH record with guard `restart` (glossary §9). It is not published and not overwritten; HLD-58 resolves it. Only LIVE paths enter such a mirrored record; a record that would need a non-LIVE path is `local_only` (glossary §9), and a quarantined path's bytes never leave this PC (S8).
   - Set `expected_epoch.stash :=` the current refs/stash.
   - Ready pairs on rebuilt paths are rebased in the same state update; a rebase conflict follows HLD-41's no-write case (readiness cancelled, `CS_READY_CANCELLED`, group re-captured).
   - Re-run HLD-27's revert detector over the whole batch.
   - Clear `EPOCH`/`MASS`, and drop `journal/keep/pre_freeze_base` and `journal/keep/pre_freeze`.
   - Print the restored and held paths (`RESUME_REPORT`).
   - For E6, also print "your stash@{0} still contains teammates' live changes; review it with `git stash show -p` instead of popping it while live".

   The effect is that paths a git operation reverted (a matching older chain blob exists) get the team version back at the next apply, and genuinely new bytes are held.
3. **CONFIG.** Run doctor's checks for the recorded detail (glossary §8: "`/cowork resume` after doctor passes"): preflight steps 2.4 (URL and identity), 2.7 (anonymity, SEC-12) and 2.9 (filters, DAT-16). Lift only if the URL, identity and filter set equal the pinned values, the remote is not anonymously readable and the filter preflight passes. Otherwise refuse with `RESUME_CONFIG_URL`, `RESUME_CONFIG_IDENTITY` or `RESUME_CONFIG_FILTER` (a remote that is still public refuses with SEC-12's `SEC_REFUSE_PUBLIC_REMOTE`). Under `CONFIG(url|public)` these checks are local except the one re-resolution SEC-11 requires.
4. **INCIDENT** → `RESUME_INCIDENT` (`/cowork recover`, ENG-22; on other peers INCIDENT clears when their first-parent check passes again, glossary §8). **NOHOOKS** → `RESUME_NOHOOKS`; CCI-35/SEC-28 lift it when hooks are observed again or the policy is lifted.
5. If no reason was set → `RESUME_NOTHING`.
6. `VERSION` (either case), `OFFLINE`, `AUTH` and `NONRETRYABLE` are publish pauses, not FREEZE reasons (glossary §8). Resume reports them and changes nothing, except `NONRETRYABLE`, which glossary §8 lifts by human `/cowork resume` (ENG-45 owns the retry of the PINned publish). `NONRETRYABLE` is entered only after 3 consecutive rejections of the same publish with the leased ref unchanged, classified by outcome and never by text (glossary §26.2 item 2). Its host text appears only in the slash-mode `/cowork status` and `/cowork doctor` output (ENG-45). *(changed per glossary §8: the source's resume branches for VERSION and DISK are removed)*

### 3.7 Save

Save commits `tree(Lk)` of an existing live commit to the real branch, as a leased fast-forward. The branch push comes first and the board second, on every host (`--atomic` is never used in v1, glossary §26.2 item 1, although GitHub advertises it, §25 F8). Any daemon can complete an interrupted save (ENG- base move, save-completion case).

**Algorithm SAVE("<summary>"):**

0. **Approval.** If `checks.save` is configured and its SHA-256 is not in `user.json.saveCheckApproved` → `SAVE_CHECK_UNAPPROVED{command, sha8}`. `/cowork save --approve-check=<sha8>` (human evidence) records the approval and does nothing else. A changed command needs a new approval. No repository program runs before approval (INV-NOEXEC, SEC-).
1. **Refusals**, before anything else:
   - an empty summary → `SAVE_SUMMARY_EMPTY`
   - any FREEZE reason → `SAVE_FROZEN`
   - any publish pause → `SAVE_PUBLISH_PAUSED`
   - an ACTIVE base-move hold in the fold → `SAVE_BASE_MOVE_BLOCKED`
   - config invalid at EPOCH_BASE → `SAVE_CONFIG_INVALID`
2. **Final sync.**
   - Close the issuing seat's open CS, if any, as at Stop, and the human CS, as `/cowork done`.
   - Ask the governor to publish this peer's ready CSs, and wait ≤ 2 governor windows. These include the newest passing edit-checkpoint capture of every open Claude CS on this peer, including another local seat's mid-turn CS (glossary §27.1): it is published as `Cowork-CS … state=checkpoint` (glossary §5) and shown in the preview with that state. An open CS whose edit check has not yet passed has no ready pair and contributes nothing; save never runs or waits for an edit check.
   - Fetch. Read TIP, `Hb := live_base(TIP)` and `Hr`.
   - Other seats' and peers' open CSs are not waited for. They are listed in the preview. Their latest passing edit checkpoints are usually already on TIP (Claude-edit latency ≈ 10–30 s, glossary §27.1), so the candidates of step 5 may contain them; they are unsettled until the CS closes.
   - Own ready CSs still unpublished are listed as "not included".
3. **Branch moved.**
   - If `Hb` is not an ancestor of `Hr`, or `Hr` is absent → `SAVE_BRANCH_REWRITTEN`.
   - If `Hr ≠ Hb`, wait for or perform the ENG- base move and go back to 2. After 3 restarts → `SAVE_BRANCH_MOVING`.
4. *(Removed in this revision: the branch-form check now runs per candidate in step 5, against the tree that is actually saved. Step numbers are kept.)*
5. **Candidates.**
   - The set is the first-parent chain from TIP back, while `live_base == Hb`, at most 20 commits.
   - Order: settled candidates newest-first, then unsettled newest-first.
   - Edit checkpoints (glossary §27.1) make live commits more frequent: while a seat is mid-turn, its CS's most recent trailer is `state=checkpoint`, so every candidate from that CS's first checkpoint publish of the turn up to its closing publish is unsettled. At the team budget B = 12 the 20-commit window can span as little as ≈ 100 s (§2.5), so a settled candidate may fall outside it; save then takes the newest unsettled candidate that passes, as before. No candidate is trusted because its edit check passed: every candidate still runs the branch-form check, T0 and `checks.save` below (§8 Q6). *(new in rev 2.4.)*
   - For each candidate `L`, first run DAT-12's branch-form check `formCheckSave(Hb, L)` (EOL/BOM stored form of every text, unfiltered path changed between `Hb` and `tree(L)`). A candidate that fails it is skipped: T0 and `checks.save` are not run for it.
   - Then run T0 (HLD- dependency checks, in the daemon). If `checks.save` is configured, also run it (§3.7.1).
   - The first candidate that passes all of these is `Lk`. Total check time is ≤ 15 min.
   - None passes → if every candidate failed the branch-form check, `SAVE_EOL_BRANCH_FORM(paths)` (DAT-12's code; `paths` of the newest candidate); otherwise `SAVE_CHECK_FAILED{candidate, output tail}`, which also lists the candidates skipped for form.
   - `tree(Lk) == tree(Hb)` → `SAVE_NOTHING`.
6. **Preview.** It shows:
   - `Lk8`, `Hb8`, and the files `diff(Hb, Lk)` with per-file contributors
   - the included CSs by author and state (closed/checkpoint; an edit-checkpoint, green-checkpoint or `cowork_checkpoint` publish all carry `state=checkpoint`, glossary §5, §27.1)
   - CSs not included
   - this peer's own non-terminal records ("stay held, not saved")
   - this peer's local changes on save-only (`SAVE_ONLY` ∪ `UNMANAGED`) and quarantined paths ("not included: commit with git"; glossary §3 scope class, §16)
   - claims of other seats on included regions ("work likely in progress")
   - check results ("no smoke check configured" when unset)
   - the suggested summary draft (FEAT-F12-12; not digested, §2.1): the 10-product §3.20 draft for `(G, Lk]`, computed by the same `saveAttribution` as the trailers (§3.7.2), under `UI_DRAFT_LABEL`, ≤ 8 bullets in slash mode and dropped first when the preview exceeds the slash cap; when the typed summary, normalized, is the draft's headline (optionally followed only by bullets of that draft), the preview adds the warning `UI_SAVE_SUMMARY_IS_DRAFT`, never a refusal. Over the 10 s attribution cap the draft line is `UI_DRAFT_UNAVAILABLE` and the rest of the preview and its id are unchanged. *(new in rev 2.5, F12.)*
   - whether S will be signed

   The preview is cached in daemon memory under its id (§3.2) and the command exits 1 with `SAVE_PREVIEW`.
7. **Confirm** (`--confirm=<id>`, human evidence). Fetch again. The cached preview must exist, `Lk` must still be on TIP's first-parent chain, `live_base(Lk) == Hb == Hr`, and the recomputed id must equal `<id>`. Otherwise → `PREVIEW_STALE` with a fresh preview. Checks are not re-run, because `Lk` is unchanged.
8. **Build S** in the CLI process (the user's environment, needed for signing):
   - `S := commit-tree tree(Lk) -p Hb`, through runGit, without the gpgSign override and with `-S` when `--sign` is given or the user's `commit.gpgSign=true` (VERIFIED T5a: commit-tree ignores `commit.gpgSign`).
   - Author and committer are the saver's git identity. The message is built per §3.7.2.
   - A signing failure → `SAVE_SIGN_FAILED`; nothing is pushed.
   - Asserts:
     - S, Hb and Lk are typed oids that exist (ENG- typed-oid rule);
     - `tree(S) == tree(Lk)` and `S^1 == Hb ==` the freshly fetched `Hr`;
     - Lk is on TIP's first-parent chain;
     - the message contains none of `[skip ci]`, `***NO_CI***` or `skip-checks`.

     A failed assert pushes nothing.
9. **Journal** the save intent (§2.3) via a state CAS.
10. **Branch push.** The daemon pushes `S:refs/heads/<b>` with `--force-with-lease=refs/heads/<b>:<Hb>` in a governor slot (a counted attempt under the per-peer cap and the sliding team guard, glossary §20). It never uses `+` or `--force`. Outcomes:
    - **ok** → `crashpoint("save.branch_pushed")` (11-testing §3.6, TST-06; glossary §25.2 item 10), then step 11.
    - **rejected, and the fetch after it shows `Hr ≠ Hb`** (the leased ref moved, glossary §26.2 item 2):
      - If `Hr == S`, our change is present and the push landed despite the reported rejection (the ambiguous-push rule) → step 11.
      - Else if the new `Hr` carries `Cowork-Saved-Live` and `Hr^1 == Hb` → `SAVE_ALREADY_SAVED{by, S8}`, reported after ENG- completes it.
      - Otherwise (lease loss) → `SAVE_BRANCH_MOVED`. The confirmation was for `Hb`, so the user needs a fresh preview.
    - **rejected while the fetched `Hr == Hb`** (the ref did not move and S is absent): classified by outcome, never by text (glossary §26.2 item 2; this resolves the §18 vs §25 F9/F11 conflict). The 1st and 2nd consecutive such rejection are transient. GitHub's `[remote rejected] … (failed)` and `fatal error in commit_refs` under concurrent pushes look exactly like this (glossary §25 F11). The push is retried in the next governor slot with backoff, under the same lease on `Hb` and the same confirmation. The 2nd consecutive transient rejection is a throttle signal (glossary §27.2): this peer enters the 30-min fallback (B = 6, G = 10 s, S = 3 s) and the 3rd attempt waits for a fallback slot; the count is unchanged by that. The 3rd consecutive rejection of this branch push with `Hr == Hb` → `SAVE_REJECTED_BY_HOST`: the save intent is cleared and nothing else changes. No NONRETRYABLE publish pause is set, because the live chain has no rejected live publish to PIN. Message text only selects the explanation, and the sanitized host text is shown verbatim, only in this CLI refusal and the doctor record (§2.7). A lease rejection or a no-answer outcome between attempts ends the count and is handled by its own bullet. *(changed in rev 2.3: was "non-retryable after one rejection, no retry".)*
    - **no answer or watchdog** → fetch. Success iff `Hr == S`. Else → `SAVE_UNCONFIRMED`. The save intent is KEPT. Each later loop resolves it with a fresh fetch: `Hr == S` (the push landed late) → step 11 publishes the `save` op; `Hr ≠ S` → clear the intent. ENG-'s completion produces only the base move, so the `save` op with `released_claim_ids` can come only from the intent.
11. **Board.** In its next slot, the saver's daemon publishes one board commit. Its ops are `save{save_commit: S, saved_live: Lk, chain_base: Hb, released_claim_ids}` and `release{claim_ids, reason: save}`. `released_claim_ids` are this peer's own claims that PRO-'s release-at-save rule selects; other peers release their own. Its last parent is `Ls := commit-tree tree(TIP) -p TIP -p S` with `Cowork-Base: S` (ENG- base-move shape and lease).
    - On a CAS loss, refetch. If `live_base(TIP') == S`, another daemon completed the base move, and the `save` op still rides this peer's next board push. Otherwise rebuild `Ls` on the new TIP.
    - The save intent is cleared when the `save` op is on the board's first-parent chain.
12. **Report.** `SAVE_REPORT` (glossary §19, COO- template) goes to the saver and to every live seat of the team at its next hook. It contains `S8`, `Lk8`, the included CSs by author and state, the file count, own held records, and claims on saved regions. Peers then adopt (§3.8).

WHY:
- `save-splice-commits-untested-tree` (VERIFIED x6a/x6b): the saved tree must be an existing live tree.
- `f-save-lagging-tree-reverts-peers` (VERIFIED): the tree must not come from the saver's disk.
- `save-race-reverts-concurrent-edits` (VERIFIED): the live chain is never reset.
- `save-reverts-external-commits` (VERIFIED e9): `S^1 == Hb == Hr`, with any merge done earlier as a base move.
- x1_save_completion (VERIFIED): completion with base `tree(Lk)` equals `tree(TIP)`, so a crash between the two pushes is harmless.

#### 3.7.1 `checks.save` execution

- It is spawned by the CLI process, only with approval (step 0). Its environment is built by the 09-security §3.4 builder from the CLI's own environment: the allowlist (which carries the interactive `PATH`, so the user's toolchain is found), the names in `user.json` `env.passthrough`, the never-list and the forced values. The never-list drops every `CLAUDE_*` value, including the messaging socket and token. The host puts the token in every hook's environment and the MCP server's (glossary §26.2 item 6, spike 02), and the CLI runs under Claude Code's `!` preprocessing, so it may inherit them too. cowork code reads the token only in the MCP server, never in the CLI (09-security INV-TOKEN). A check that needs another variable gets it through `env.passthrough`. *(rev 2.1: was "in the CLI process environment", which let `CLAUDE_*` values reach a repository-defined command; 09-security §8 Q8.)*
- Per candidate:
  1. `runGit worktree add --detach <gitdir>/cowork/tmp/save-<n> <Lk>`, with `GIT_LFS_SKIP_SMUDGE=1`, filters required, and `attr.tree=EPOCH_BASE`. Smudge runs with cwd = that worktree's root (glossary §25 F12). Because of `required=true`, a filter failure aborts the checkout, and that candidate fails like a failing check.
  2. Run the command through the platform shell, with cwd = that worktree and `COWORK_SAVE_CANDIDATE=<Lk>` added to the env, under a timeout of `saveTimeoutSec` (default 300, max 1,800). A timeout kills the process tree.
  3. Exit 0 = pass. The last 4 KiB of output is kept, sanitized and secret-scanned (SEC-) before display.
  4. `git worktree remove --force` and `git worktree prune`.
- RESTART removes any leftovers (§3.3.4).

Measured cost: `worktree add` takes 0.49–0.51 s and `remove` about 0.16 s for 3,001 files plus the 1.34 MB file (VERIFIED).

#### 3.7.2 Save message and attribution (glossary §5)

```
<summary first line>

<summary remaining lines, with any line starting "Cowork-" removed>

Cowork-Saved-Live: <Lk>
Cowork-Symbol: <path>::<label> by <display>[, <display>...]     (≤ 300 lines, sorted by path then label)
Cowork-Symbol-More: <n>                                          (only when more than 300)
Co-authored-by: <name> <email>                                   (only contributing peers whose join op carries a co-author identity)
```

- Attribution is computed in the daemon from the live first-parent chain `(G, Lk]`. G is the base-move commit that introduced `Hb`, or genesis.
- The computation is `saveAttribution(G, Lk, Hb)`, the one function 10-product's summary draft also calls (FEAT-F12-07); its result is the table `{path, label, displays[]}` that the `Cowork-Symbol` lines above render. Save's trailers, their order, the 10 s cap and save's own priority in the REG worker pool are unchanged; the per-commit mapper memo (which lets save reuse its preview's work) and the draft's background priority are 10-product's (§3.20 there). The range `(G, Lk]` is kept as is (§8 Q7). *(new in rev 2.5, F12.)*
- For each live commit c, the display name is the author name of c (`<display> <peer_id@cowork.invalid>`). The regions changed are REG-'s mapper over `diff(c^1, c)` at c, keeping only paths in `diff(Hb, Lk)`. A region changed by several peers lists all of them.
- The label rendering is REG-'s.
- Provenance across saves comes from the never-reset live chain, never from `git blame` of S.
- If attribution is not computed within 10 s, S carries no `Cowork-Symbol` lines, and `SAVE_REPORT` says "attribution unavailable". *(changed per glossary §5: the source's `Cowork-Contributor`, per-CS and `Cowork-Attribution` trailers are dropped; included CS ids appear only in `SAVE_REPORT`)*

### 3.8 Adopt (S7, automatic, relaxed)

#### 3.8.1 Trigger and conditions

The trigger is `X := live_base(LA_C) ≠ H_adopt`. It is evaluated after each loop's apply step.

Adopt runs only if ALL of these hold. The first six are glossary §12 verbatim; the last two are this chapter's additions.

1. Symbolic HEAD is `refs/heads/<b>` and `HEAD == H_adopt`.
2. `H_adopt` is an ancestor of X.
3. There is no git operation marker (§3.4.1).
4. `.git/index.lock` can be created exclusively (busy → retry next loop).
5. For every p in `diff(H_adopt, X)`: the user's index entry (mode, oid) equals `H_adopt[p]` (absent equals absent; an intent-to-add entry counts as staged), and p is not INCOMING or deferred.
6. `LA_C` is at or after the base-move commit that introduced X (all saved content applied).
7. No FREEZE reason is set (glossary §8).
8. No Bash/PowerShell transaction is open on this worktree (CCI-).

Extra local edits on top of the saved content do not block. After adopt, `git status` shows exactly the edits made on top of the save. *(changed per glossary §12: the source's literal `disk == X` test, its staged apply at base-move boundaries, and the manual `/cowork adopt` are removed)*

#### 3.8.2 REATTACH (the only writer of `.git/index` and `refs/heads/<b>`)

```
REATTACH(from = H_adopt, to = X, paths = diff(from, to)):
 1  sha_orig := SHA-256(.git/index); copy .git/index -> tmp/adopt.orig and -> tmp/adopt.index
 2  GIT_INDEX_FILE=tmp/adopt.index:
      verify entries(paths) == from[p]                     (else abort; condition 5 failed)
      git update-index -z --index-info  <- (to[p] mode, oid, p) ; deletions as mode 0
      (no `update-index --refresh`: it would hash the user's working files in place, glossary §26.1 W1;
       the changed entries carry no cached stat data, so the user's next git command compares their content)
    sha_new := SHA-256(tmp/adopt.index)
 3  journal adopt intent {from, to, paths, sha_orig, sha_new}         (state CAS)
 4  open .git/index.lock with O_CREAT|O_EXCL                          (EEXIST -> clear intent, retry next loop)
    crashpoint("adopt.lock")
 5  if SHA-256(.git/index) != sha_orig: unlink our lock, clear intent, retry next loop
 6  write tmp/adopt.index bytes into the lock, fsync, close
 7  rename .git/index.lock -> .git/index   (EACCES/EPERM: retry 5 x 100 ms; else unlink our lock, clear intent)
    crashpoint("adopt.index_renamed")
    crashpoint("adopt.ref")
 8  git update-ref -m "cowork adopt <from8>..<to8>" refs/heads/<b> <to> <from>      (CAS; runGit refupdate class: fsync, reflog)
      CAS failure -> ROLLBACK: lock again (O_EXCL); if SHA-256(.git/index) == sha_new write tmp/adopt.orig bytes
                     into the lock and rename; else leave the index; clear intent
 9  state update: H_adopt := to; logs_head_size, orig_head re-baselined; intent cleared
```

- REATTACH never writes a working-tree file, never runs git on one (it reads only `.git/index` and its copies; glossary §26.1 W1), never moves the branch backwards, and never runs while frozen. *(changed in rev 2.3: step 2's `git update-index -q --refresh` is removed.)* Without stat data, git compares the content of an adopted path the next time it needs that path, so `git status`, `git pull --ff-only` and `git diff` give the same answers as before. The first such command may be slower, and the user's own git, not the daemon, may refresh the index then.
- Crashpoints (11-testing §3.6, TST-06; placed here per glossary §25.2 item 10): `adopt.lock` after step 4, `adopt.index_renamed` after step 7, `adopt.ref` immediately before step 8.
- It never writes FETCH_HEAD, ORIG_HEAD or `refs/remotes/*`. A stale `refs/remotes/<R>/<b>` may show "ahead by 1" until the user's next fetch; this is documented as harmless (UX-).

WHY: x3_adopt.sh (VERIFIED, with the step-2 refresh that rev 2.3 removes; it is re-run without the refresh, §7 test 10):
- the staged unrelated `u.py` was preserved;
- mtimes were unchanged;
- `git pull --ff-only` exited 0;
- a stale CAS was refused.

Without adopt, `post-save-head-drift` (VERIFIED) leaves peers with a refused `git pull` and a stash that reverts work.

#### 3.8.3 Adopt crash recovery (called from ENG- restart for an adopt intent)

| Observed | Action |
|---|---|
| HEAD == `to` | finish step 9 |
| HEAD == `from`, `.git/index.lock` exists with SHA-256 == `sha_new` | crashed before the rename: unlink that lock (ours); clear the intent (adopt re-evaluates next loop) |
| HEAD == `from`, SHA-256(`.git/index`) == `sha_new` | rename done, ref not: redo step 8 (with its rollback) |
| HEAD == `from`, otherwise | nothing of ours landed: clear the intent |
| HEAD neither | if SHA-256(`.git/index`) == `sha_new`, restore `tmp/adopt.orig` through the lock protocol; clear the intent; the table classifies HEAD |
| any `.git/index.lock` whose content hash ≠ `sha_new` (including a partly written one) | never touched; the §3.4.1 30 s notice tells the human |

#### 3.8.4 ADOPT_BLOCKED

When adopt is triggered and blocked, the reasons are drawn from:
- `frozen`
- `head_moved`
- `not_ancestor`
- `git_op`
- `index_locked` (reported only after 30 s)
- `txn_open`
- `staged:<p>`
- `incoming:<p>`
- `not_applied`

They are sent ONCE per `(X, reason set)`, as the `ADOPT_BLOCKED(paths, reasons)` engine event, to the human (status line + systemMessage) and to each live seat on this clone. The check repeats every loop silently. `status.json.adopt` is `{state: "blocked", reasons}` until adopt succeeds. For `staged:` the next step is `git restore --staged -- <paths>`, which leaves the files untouched.

### 3.9 Stop

`/cowork stop [--discard-holds=<ids> --confirm=<id>]`. Stop keeps files: it never removes teammates' unsaved work from the working tree. Glossary §15 gives stop no confirmation except for discarding holds, so a stop that removed bytes from disk would need a confirm the glossary does not define. The stop report lists what the files contain instead.

**Algorithm STOP:**

0. **Refusals:**
   - E5 → `STOP_GIT_OP` ("switch back first").
   - `INCIDENT` → `STOP_INCIDENT`.
   - publish pause `OFFLINE`/`AUTH`/`NONRETRYABLE`, or `VERSION` in its proto form (zero pushes) → `STOP_PUBLISH_PAUSED`. The suggestion is `/cowork pause` to edit uncoordinated now and stop later, or remove the plugin; §3.10.2 keeps state intact.
   - `VERSION` in its board-only form (own regionSpec ≠ `teamRegionSpec`, or the `checkpoint_mismatch` cause, which 02-protocol §3.8 treats the same way) does NOT refuse (glossary §24 default 6): stop proceeds, skips the code publish of step 3, and its step 4–5 ops are exactly glossary §8's board-only list (`hold`, `release`, `seat_end`, `request_status`, `leave`). The report says the ready CSs were not published.
   - another local seat mid-turn → `STOP_SEAT_BUSY`. The issuing seat is the seat whose UserPromptExpansion evidence (§3.1) authorised this stop.
   - **Local stop** under `CONFIG(url|public)`, which forbids every network call (glossary §8): stop proceeds without any fetch or push. Steps 3–5 make no network call; records that are not durable stay ON_DISK (step 6 is skipped anyway, because `CONFIG` is a FREEZE reason) and are listed; the report carries `STOP_LOCAL_ONLY` (claims and requests not yet released on the board). The next `/cowork start` re-pins (§3.3.1 step 6) and its first board push carries the deferred `release`/`seat_end`/`request_status`/`leave` ops. This is the only stop that does not wait for durability: HLD-63's durability refusal protects the parking of step 6, and the local stop parks nothing, so no byte leaves the disk (INV-NOLOSS: undisplaced edits on their author's disk; the registry is kept).
1. Set `meta.stopping := true`. New claims stay `TENTATIVE`.
2. Close the issuing seat's open CS (as at Stop) and the human CS (as `/cowork done`), capturing ready trees. Closing runs the turn-end path of glossary §27.1 (b), not an edit check: a CS whose last edit check failed is still captured if the K7 T0 checks pass, and otherwise becomes the K7 PIN as at any turn end.
3. If no FREEZE reason is set and the board-only form of `VERSION` is not in effect, publish every ready CS through every gate (B1, T0, MASK) via the governor, including ready pairs captured earlier at passing edit checkpoints (glossary §27.1). Wait ≤ 2 governor windows (10 s at G = 5 s; 20 s in the throttle fallback, §2.5), cap 60 s. A capture taken after this step (an edit checkpoint or turn end of a seat that starts a turn while `stopping` is set) is not published by this stop: it stays a ready pair in the kept state and is listed in step 8 with the CSs not published. Under `EPOCH`/`MASS`/`PAUSED`/`CONFIG`/`NOHOOKS`, or in the board-only `VERSION` form, no code is published; the ready CSs stay on disk and are listed.
4. Mirror every non-`local_only` registry record and wait (same window) until it is durable: its `hold` op and `held/` blobs are on the remote board's first-parent chain.
   - Any non-durable non-`local_only` record (HLD-62) → `STOP_HOLDS_NOT_DURABLE{ids}` (HLD-63 step 2), and `stopping` is cleared. A record in `HOLD_MIRROR_REJECTED` (glossary §9; PRO-24) is non-durable and is listed with that status (§8 Q5). The S6 timer never parks it either (glossary §25.2 item 1).
   - Mirrored records contain only LIVE paths (glossary §9), so this step never pushes a quarantined path's bytes, a restore marker or a `local_only` path (S8, INV-SECRET).
   - The override is `--discard-holds=<ids> --confirm=<id>`. Each discard is a human `RESOLVED_DISCARD` (HLD-).
   - `local_only` records do not block stop. The registry is kept, and INV-NOLOSS allows a `local_only` record on its owner's disk.

   Then `crashpoint("stop.flushed")` (11-testing §3.6, TST-06; glossary §25.2 item 10), after steps 3–4 and before the single step-5 board push. There is no separate `leave` push.
5. One board push (board-only, allowed while frozen), with:
   - `release{all claim ids of this peer, reason: stop}`
   - `seat_end` for each local seat
   - one `request_status{returned}` per unanswered request identity `(req_id, to_holder.seat)` addressed to a seat of this peer (glossary §3; U5: decline or release returns the leftover to its requester, so nothing is lost)
   - `leave`

   Requests this peer made stay open with their records (COO-).
6. If no FREEZE reason is set, PARK every ON_DISK PATCH or PIN record with `local_only = false`, in state ACTIVE or CONFLICTED (HLD-63 step 3), via HLD-'s PARK operator (HLD-16: capture first, then `writeLocal`, ENG-), with `displaced_by` = the op id of this peer's `leave` op. `local_only` records and INCOMING records are never parked (HLD-16): `local_only` records stay ON_DISK and are listed as "kept on this PC only"; INCOMING records' disk bytes are already in the live chain. A record carrying `markers` (a conflicted RESTORE being resolved on disk) is parked by HLD-'s markers park (05-holds §3.4 item 3, HLD-63 step 3). Its held side is never refreshed from disk. The half-done resolution with its restore-marker rows goes into a `local_only` marker companion, which is listed as "kept on this PC only", so no restore-marker row reaches a remote ref (glossary §9 rev 2.1, INV-SECRET). *(changed in rev 2.3 to follow 05-holds rev 2.1: was "not parked by stop; stays ON_DISK".)* If frozen, skip this step (no daemon working-tree write while frozen) and list the records.
7. Set `meta.stop_mode := "stopped"`, then remove `<gitdir>/cowork/live`, last. This removal is part of the stop sequence, so the daemon's marker watch does not re-create it (CCI-53). The daemon ends the branch loop and exits.
8. **STOP report** (`STOP_REPORT`):
   - claims released;
   - CSs published, and CSs not published ("they will be offered at the next `/cowork start`");
   - records parked or kept;
   - files whose disk contains LIVE_UNSAVED content ("these files contain teammates' unsaved work; do not commit them with git; `/cowork start` again or ask a teammate to `/cowork save`");
   - the number of other Claude sessions in this repo that are no longer coordinated.

The state ref, hold registry and private index are KEPT (INV-LIF-STATE-KEPT). The supported branch-switch path is `/cowork stop` → `git switch` → … → `git switch <b>` → `/cowork start` (RESTART).

### 3.10 Uninstall, removal, update and versions

#### 3.10.1 `/cowork uninstall [--purge]`

1. For each gitdir in `repos.json` with a `live` marker, run STOP with its refusals. A refusal stops the uninstall.
2. `--purge` then deletes `refs/cowork-local/<enc(b)>/*` and `<gitdir>/cowork/`. It does this only after verifying that every non-terminal record of this peer is durable and that none is `local_only`; otherwise → `UNINSTALL_HOLDS{ids}`, unless `--discard-holds=<ids> --confirm=<id>`. It never deletes a remote ref (INV-OID). The README documents manual `git push --delete` of `refs/cowork/<enc(b)>/*` once nobody is live (glossary §22).
3. Remove the `repos.json` entries and print "now run `/plugin uninstall cowork-sync`" (`UNINSTALL_REPORT`).

#### 3.10.2 Removal or disable without uninstall

- Lease expiry is CCI-'s: no apply or push 2 min after the last lease, and exit at 10 min. A daemon exiting for lease expiry does NOT park and does NOT remove the marker; state stays for RESTART. Its last `status.json` write sets `state: "down"` and `message_code: "IDLE_NO_SESSION"` (glossary §25.2 item 6; 01-engine ENG-56, 06-claude CCI-50), which 10-product renders as "idle (no session)".
- Every 30 s the daemon also checks plugin enablement, `ipc.key` and its `runtime/<version>/` copy (CCI-53, SEC- key liveness). On any failure, it runs this sequence:
  1. Remove every `<gitdir>/cowork/live` marker it owns, first, so surviving hooks exit 0 instead of denying with G4.
  2. Make no further working-tree write and take no new snapshot.
  3. If online and not frozen, make one board push: the already-captured ready trees (through every gate), `release{reason: stop}`, `seat_end` and `leave`. If frozen, make a board-only push of release, seat_end and leave.
  4. Set `meta.stop_mode := "removed"` and write state.
  5. Exit.
  6. Raise one OS notification, `DAEMON_REMOVED` (rendered by 10-product UX-27 as the class `NT_PLUGIN_REMOVED`, with the count of held changes).
- The marker removal of step 1 is part of this sequence, so the marker watch of CCI-53 does not re-create it.
- Correctness state under `<gitdir>` stays for a later reinstall. *(consolidation cross-check fix: the research catalog's LIFE-15(b) variant was chosen over the seat-side variant)*

#### 3.10.3 Update and version

- **Update.** On a version-handshake mismatch (CCI-), the old daemon drains and exits, and the new one takes RESTART. It never joins.
- **State meta.** `meta_v` migrates forward only: the new daemon writes the migrated meta in a new state commit, and the old one stays in the reflog. A daemon finding `meta_v` > own refuses the branch: status `refused`, `START_STATE_NEWER`.
- **Runtime assets.** They load from `CLAUDE_PLUGIN_DATA/runtime/<version>/` (CCI-). A process whose environment lacks `CLAUDE_PLUGIN_DATA` uses the data directory the daemon derives from the plugin id. A project MCP server measurably lacks the variable; for plugin MCP servers this is not yet measured (glossary §25 F3).
- **VERSION while live.** The `VERSION` publish pause (glossary §8) has two forms; applying continues in both.
  - **Proto form.** The board's `protocol.json` proto ≠ own (v1: ≠ 1) → zero pushes of any kind. Start is refused with `START_VERSION` (§3.3 step 8).
  - **regionSpec form.** Own regionSpec ≠ the folded `teamRegionSpec` (glossary §3, PRO-48) → code pushes paused; the glossary §8 board-only ops stay allowed. This is never compared with `protocol.json.regionSpec`, which is the genesis value only (02-protocol §3.9). Start is NOT refused (§3.3 step 8).

  - **`checkpoint_mismatch` cause** (glossary §7, PRO-28): the board-only form, as for regionSpec (02-protocol §3.8).

  The engine event is `VERSION_PAUSED` ("update cowork-sync"). Save refuses in every form with `SAVE_PUBLISH_PAUSED` (its base-move commit `Ls` is a code push). Stop refuses with `STOP_PUBLISH_PAUSED` only in the proto form; in the board-only form it proceeds without the code publish (§3.9 step 0; glossary §24 default 6). *(changed per glossary §8/§22: the source's FREEZE(VERSION), automatic proto raise and cross-proto checkpoint rule are removed)*
- **Status.** `/cowork status` lists each peer's plugin version, sha and proto from its `join` op (UX-).

### 3.11 Offline, sleep, crash and reboot

- **Offline** (no successful fetch for > 30 s) and **AUTH** are publish pauses (glossary §8).
  - Snapshots and ready captures continue, edit-checkpoint captures included (glossary §27.1: newest passing capture wins per CS). Nothing is published.
  - Reconnect follows the ordinary ENG- loop order: fetch → fold → INV-FF → base move → apply → tentative-claim check (SEC-/PRO-) → publish.
  - Save, stop and recover refuse while offline. Uninstall refuses through stop.
- **Sleep.** A suspend gap (Δwall − Δmono > 5 s on this machine) does the following:
  - kills in-flight network git processes (process tree);
  - marks own claims SUSPECT (PRO-);
  - forces a fresh fetch + fold before any apply, publish, adopt or save decision;
  - restarts the lease timers (CCI-) from the wake moment, so a session that is still alive is not dropped at wake.
- **Long absence.** It needs nothing extra. Objects stay reachable from `refs/cowork-local/*`, `A` is per path, and `LA_C` is a remote commit. Presumption is PC-level (S4): a requester's daemon may presume this PC (its daemon epoch) absent when no op from it is folded for 30 min after the request was folded, with one automatic re-attempt 30 min after an acknowledgment that got no answer; a go-first grant to this PC ends when it is presumed absent (glossary §20 "Presume absent"; PRO-). Its claims then stop blocking (STALE); its unpublished bytes stay on its disk and in its registry.
- **Crash or reboot.** The marker persists. While no daemon answers, Claude edits get G4 (S3). The daemon is respawned by CCI-51's spawn path: detached, hidden, stdio ignored, `unref()`, from the hook-side `core` (the SessionStart spawn measured in glossary §25 F4, where the daemon survived `claude` exiting) or from the CLI. RESTART then runs with no preview (not a stop). A host that kills its children on close (a kill-on-close job object, not measured, §25 F4) ends the daemon with the host. Doctor reports that as "daemon died with the host", the marker stays, and Claude edits get G4 until the next respawn, so the failure is visible, never silent. Human edits made while the daemon was down are ordinary unobserved local edits relative to the kept `A`. Status reads `down` while the heartbeat is stale (glossary §14).
- **Power loss.** It may lose the state ref or objects. ENG-'s LOST-STATE rebuild runs; it never joins and never seeds `A` from TIP. Ref writes use the runGit fsync flags (glossary §18).
- **Headless human editing** (no Claude session) is coordinated only under `/cowork start --human <minutes>` (CCI- human lease). Otherwise the daemon is not running, and status shows "idle (no session)": the exiting daemon's last status write is `state: "down"`, `message_code: "IDLE_NO_SESSION"` (glossary §25.2 item 6; ENG-56, CCI-50; §3.10.2).

### 3.12 Human branch commits and save-only paths

- While live, `refs/heads/<b>` on the remote moves only by a cowork save or by another push (a teammate's plain push, a PR merge, a bot, this human's commit + push). Every daemon treats the latter as an ENG- base move: explicit base, outgoing revert/provenance guards (HLD- branch test), a conflict blocks saves.
- Local human commits and pulls are classified only by the HEAD table (E3/E2).
- Quarantined and save-only paths never enter a save, because `tree(S)` is a live tree and live never publishes them (MASK, glossary §16).
  - They reach the branch only through a human commit of exactly those paths: `git commit -- <paths>`, then push. That gives E3 (`EPOCH_LOCAL_COMMIT`), then E2, then a clean base move (disjoint from live-changed paths; VERIFIED lc/P5), then RECONCILE.
  - Peers receive quarantined changes only through `/cowork review <id> --accept` (preview/confirm, §3.2 item 4; SEC-32, SEC-33). Save-only changes arrive with the base move and are applied like LIVE (glossary §3).
  - After the base move, EPOCH_BASE changes, and DAT- re-runs filter discovery and the preflight (glossary §25 F12, §26.2 item 3; §3.3 step 2.9) before the next snapshot; a failure sets `CONFIG`.

### 3.13 `/cowork recover` (verb surface; mechanics ENG-22, 01-engine §3.7)

1. **Authority.** `recover` is a human-typed acting verb: SEC-25 evidence, never from a wake turn (§3.1), and the preview/confirm step of §3.2. Its refusals are ENG-22's codes: `RECOVER_NOT_IN_INCIDENT`, `RECOVER_OFFLINE`, `RECOVER_AMBIGUOUS`, `RECOVER_DISPLACED_FULL`.
2. **Preview** (`RECOVER_PREVIEW{mode: restore|reanchor, candidate8, observed8, displaced_refs, restart_paths, id}`; 10-product §3.4 renders its headline as `UI_RECOVER_RESTORE` or `UI_RECOVER_REANCHOR`). It names the mode ENG-22 selects from a fresh fetch:
   - **restore** (01-engine §3.7 steps 3–6): the candidate X that will be force-pushed with a lease (oid8, height), the observed bad tip V and the displaced ref it is copied to first, the number of displaced refs left (≤ 3 per branch, glossary §20), and that every other peer clears `INCIDENT` when its first-parent check passes again (glossary §8).
   - **re-anchor** (01-engine §3.7 step 2a: the team already recovered and has continued on V; glossary §8 `INCIDENT` lift by a late peer): no push of any kind; this peer's `LA_B` is kept at `refs/cowork-local/<enc(b)>/incident-<n>-own` (glossary §4); `A` is rebuilt per path from V's chain (ENG-54 primitive). The preview lists every path whose disk bytes match no version on V's chain, which become `restart` PATCH records (kept on disk, masked, mirrored; only LIVE paths enter a mirrored record and a record that would need a non-LIVE path is `local_only`, glossary §9), and names this peer's displaced copy of its `LA_B` when ENG-21 pushed one.

   The preview id (§2.1) digests the mode, the oids shown and the listed paths.
3. **Report** (`RECOVER_REPORT{mode, board8, record_ids}`). After ENG-22 completes: the mode, the new board tip and, in re-anchor mode, the record ids. Re-anchor also emits the engine event `LOST_STATE` with the list of records (ENG-22) to the human and every live seat on this clone; `UNFROZEN` follows when `INCIDENT` clears (§3.5).
4. **Policy** (glossary §4/§8, rev 2.1). Once the team has built on an earlier recover's tip, a late peer never rewinds the team again: its newer commits survive as `restart` records, under `incident-<n>-own`, and in its displaced ref.

---

## 4. Rules

- **LIF-01** Every lifecycle verb (`start`, `stop`, `pause`, `resume`, `save`, `uninstall`) MUST exist only as a slash command with `disable-model-invocation: true` that runs `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <verb> $ARGUMENTS`, and as the same terminal CLI. No MCP tool may perform one. The daemon MUST execute an acting verb only with SEC-'s human evidence: a TTY, or a UserPromptExpansion evidence line for the same `prompt_id`, `command_name` and `command_args`, ≤ 60 s old, for which the `!`-run CLI waits ≤ 3 s. It MUST NOT wait on UserPromptSubmit evidence (glossary §25 F5; §3.1). Every board op a verb produces MUST carry `origin=human`. Every live code commit a verb produces MUST carry `Cowork-Seat: human`. The save commit S MUST carry only the glossary §5 save trailers. _Covers: model-invocable-save_
- **LIF-02** The verbs listed in §2.6 (glossary §15's confirm list, including `recover` and `review <id> --accept`) MUST print a preview and change nothing until re-run with `--confirm=<id>`, where id = the first 6 hex digits of SHA-256 over the canonical JSON of the verb, its normalized arguments and the exact sorted oids, paths and record ids shown (for `review <id> --accept`: the record rev, the team blob and the disk blob, and the write MUST use the digested disk blob as `expectedCleanBlob`, SEC-33). A confirm whose recomputed id differs MUST be refused with `PREVIEW_STALE` and a fresh preview. The summary draft printed in the save preview (10-product, FEAT-F12-12) is not a source of `items`; every path it names is already in the digested `diff(Hb, Lk)` list. *(new in rev 2.5, F12.)* _Covers: model-invocable-save, save-race-reverts-concurrent-edits_
- **LIF-03** Start MUST refuse unless all of the following hold:
  - the checkout is the main worktree (`--git-dir == --git-common-dir`, not under `.claude/worktrees/`);
  - no linked worktree has `refs/heads/<b>` checked out;
  - no other branch of this clone is live;
  - no other gitdir in `repos.json` (canonical root form, glossary §24 default 12) is live for the same (repo identity, branch) with a live daemon;
  - `enc(b)` is ≤ 150 bytes and does not case-fold-collide with an existing `refs/cowork/*` name on the remote.

  `peer_id` MUST be 128-bit random in `<gitdir>/cowork/peer`. The display name MUST never be a decision input. _Covers: clones-worktrees-identity, duplicate-daemon-same-clone, worktree-isolation-gitlink-and-unmapped-edits_
- **LIF-04** Start and doctor MUST run the §3.3 step-2 preflight in order, in the daemon's process environment. The first failure refuses with its code and writes nothing. The checks are:
  - floors;
  - repo shape, including refusal of shallow, partial, sparse and split-index repos and of cloud-sync folders without `--allow-cloud-folder`, and the `START_NO_HARDLINKS` WARN (never a refusal) on a volume without hard links (glossary §26.2 item 7);
  - HEAD state;
  - remote;
  - branch name;
  - one-live;
  - SEC- anonymity, policy and IPC ACL;
  - versions and identity;
  - DAT- filter preflight, in its glossary §25 F12 / §26.2 item 3 form (real work tree, cwd = repository root, round trip compared through the same path, disk comparisons only through DISK_EQ);
  - config;
  - PRO- probe, last.

  _Covers: cloud-sync-folder-second-sync-engine, policy-fail-open (via SEC-), filter-passthrough-leak (via DAT-), secret-filter-fails-open-in-daemon-env (via DAT-)_
- **LIF-05** Start MUST resolve the remote as `branch.<b>.pushRemote` → `remote.pushDefault` → `branch.<b>.remote` → `--remote` → the only remote, never assuming `origin`. It MUST refuse when fetch URL ≠ push URL or an `insteadOf`/`pushInsteadOf` value prefixes the URL. It MUST pin the push URL and the sorted root oids of the fetched `refs/heads/<b>` in state meta. While live, a change of URL, identity, filter set or public probe result MUST set FREEZE `CONFIG` with that detail (glossary §8); a managed-policy change sets `NOHOOKS` instead (SEC-28). _Covers: remote-url-drift_
- **LIF-06** Start MUST dispatch by Table 3.3-A. It MUST write the `live` marker only after the state ref for b exists and the preview was accepted. A board absent while a state ref exists MUST refuse with `START_BOARD_GONE`; a board absent with no state ref while the code mirror exists MUST refuse with 01-engine's `GENESIS_BOARD_MISSING` (ENG-51), and so MUST a lost state (01-engine §3.14) whose fetch finds no board (`GENESIS_BOARD_MISSING{branch}`; a readable state ref with the board absent stays `START_BOARD_GONE`; Plan 2 merge, Task 15 decision 1). `/cowork start --fresh` (binding, glossary §27) MUST run only as §3.3.5 specifies: refuse `START_FRESH_BOARD_PRESENT` when the fresh fetch shows the board, preview and change nothing until `--confirm=<id>`, delete only the state ref, keep and re-mirror the registry, and dispatch as for a clone without state. GENESIS MUST seed `protocol.json.budget` from the config's `host.pushBudgetPerMin` (default 12), and JOIN or RESTART MUST NOT change it (glossary §27.2). _Covers: join-or-restart-seeds-revert, ref-rewind-silent-revert (detection routed to ENG-)_
- **LIF-07** GENESIS MUST require `HEAD == Hr`. JOIN MUST require `HEAD == live_base(TIP)`, refuse `START_HEAD_BEHIND` when HEAD is a strict ancestor, run or await the base move when `HEAD == Hr ≠ Hb` (≤ 60 s wait, then ENG- base move by the joiner, conflict → `START_BASE_MOVE_CONFLICT`), and refuse `START_HEAD_AHEAD` otherwise. A missing `Hr` MUST refuse with `START_BRANCH_NOT_ON_REMOTE`. _Covers: late-join-wrong-merge-base, join-or-restart-seeds-revert_
- **LIF-08** At genesis, join, start-after-stop and `--fresh`, local changes `diff(A, S_disk)` (U10 scope, with `A = tree(HEAD)` or the kept `A`) MUST NOT be published or overwritten until the human confirms with `--publish=all|none|<paths> --confirm=<id>`. Only LIVE paths MAY be opted in or enter the record. Opted-in paths MUST publish as one human CS through every gate. The rest MUST become one PIN with guard `join` (ON_DISK, masked, mirrored). _Covers: late-join-wrong-merge-base, naive-push-reverts-unapplied-paths, join-or-restart-seeds-revert_
- **LIF-09** RESTART MUST run whenever the state ref exists:
  - remove `tmp/save-*` worktrees;
  - run ENG- restart, including this chapter's adopt-intent (§3.8.3) and save-intent resolution;
  - run the HEAD table per Table 3.3-B;
  - after a stop, re-run the LIF-08 preview and re-baseline the stash, `logs/HEAD` size and ORIG_HEAD;
  - publish nothing before these complete;
  - never join and never seed `A` from TIP or a live base.

  _Covers: crash-between-apply-and-state-resurrects-deletes, stale-base-after-crash, ambiguous-push-and-crash-stale-base, gc-prunes-daemon-only-objects (via ENG-)_
- **LIF-10** At every loop step 0 and in join, restart and resume, the daemon MUST read the §3.4.1 epoch set with `GIT_OPTIONAL_LOCKS=0`. While `.git/index.lock` exists, it MUST only fetch, show one `INDEX_LOCK_WAIT` after 30 s with an unchanged mtime, and never delete the lock (except its own adopt lock per §3.8.3). `logs/HEAD` growth and ORIG_HEAD changes MUST only mark the next delta git-op-caused. _Covers: in-progress-ops-not-paused-conflict-markers-broadcast, conflict-markers-enter-live-ref, fetch-head-hijack-and-auto-maintenance (lock handling only; fetch flags via SEC-)_
- **LIF-11** The daemon MUST classify the epoch with the §3.4.2 table in row order (E5, E6, E1, E4, E2, E3). Every class except E1 MUST set FREEZE `EPOCH` with the class's sub-code and way back. Cowork itself MUST never move HEAD or the branch to resolve E3, E4 or E5. _Covers: branch-switch-publishes-other-branch, user-git-ops-broadcast-as-revert, git-ops-publish-team-revert, human-git-mass-revert, local-git-ops-propagate-as-reverts, bash-git-verbs-revert-and-markers, worktree-reset-commands-broadcast-revert, b-bypass-revert-of-unsaved-peer-work_
- **LIF-12** In E2, once HEAD is ancestor-or-equal of `live_base(fetched TIP)`, the daemon MUST perform RECONCILE in one state update: for every p in `diff(old H_adopt, HEAD)`, `A[p] := TIP[p]` if `DISK_EQ(p, TIP[p])`, else `A[p] := HEAD[p]` if `DISK_EQ(p, HEAD[p])`, else keep `A[p]`. Then `H_adopt := HEAD`, and the lift check runs. DISK_EQ MUST read p through the staged copy and never run git on the working file (glossary §26.1 W1). While any p is unstable in the tick, RECONCILE MUST wait for the next loop and MUST NOT decide that path either way. A frozen daemon MUST perform the ENG- base move itself when no other daemon does. _Covers: head-drift-after-pull-or-save, branch-moves-under-live_
- **LIF-13** In E3, after a fetch completed after HEAD was first seen confirms `HEAD ⋢ Hr`, the daemon MUST send `EPOCH_COMMIT_HAS_LIVE_WORK` when `paths(diff(H_adopt, HEAD))` intersects LIVE_UNSAVED or non-terminal registry paths, and `EPOCH_LOCAL_COMMIT` otherwise. The notice goes to the human and every live seat on this clone. _Covers: held-hunk-escapes-via-branch-commit, b-bypass-revert-of-unsaved-peer-work_
- **LIF-14** `EPOCH` MUST lift automatically only when the table returns E1 (or a RECONCILE just completed) and HLD-'s mass-change test does not trip on `paths(diff(snap_pre_freeze, S_disk)) \ reconciled`. If it trips, `EPOCH` MUST be replaced by `MASS`. No freeze MAY lift on a timeout. _Covers: breaker-freezes-publish-not-apply, human-git-mass-revert_
- **LIF-15** Entering a FREEZE reason MUST:
  - record it in meta (and `snap_pre_freeze` for the first `EPOCH`/`MASS` of an episode, stored as `journal/keep/pre_freeze_base` plus the oid-map blob `journal/keep/pre_freeze`, never as a reachable tree that names unwritten snapshot blobs; §2.1, glossary §26.1 W6);
  - post one board `event{kind: freeze}`;
  - write `status.json`;
  - show the human one systemMessage and one OS notification (≤ 1 per 30 min per reason class);
  - give each live seat one `FROZEN` context per episode.

  Lifting MUST post `unfreeze` and `UNFROZEN`. _Covers: silent-stall-no-visible-surface, breaker-freezes-publish-not-apply_
- **LIF-16** `/cowork pause` MUST write `<gitdir>/cowork/paused` from the dependency-free loader or the CLI, with or without a daemon, and the daemon MUST add `PAUSED`. While `paused` exists, the loader MUST make no IPC and MUST print the glossary §13 line on SessionStart and UserPromptSubmit. A `paused` marker seen without human pause evidence MUST be honoured and reported as a security event (`PAUSE_UNEXPLAINED`). A `live` marker that disappears outside stop and the removal sequence MUST be re-created by the daemon with `LIVE_MARKER_RESTORED` (CCI-53; glossary §24 default 8): `/cowork pause` and `/cowork stop` are the only supported ways to stop coordination. _Covers: mcp-or-daemon-death-fails-open-and-stuck-fences_
- **LIF-17** `/cowork resume` MUST handle reasons in the §3.6 order. It MUST refuse E3, E4 and E5 with their codes. For E1, E6 and reconciled E2 it MUST rebuild `A` only for paths whose disk differs from `snap_pre_freeze`, using ENG-'s LOST-STATE primitive; unmatched bytes become `restart`-guard PATCH records. It MUST accept the current stash, re-run HLD-'s revert detector over the batch, lift `CONFIG` only when the pinned values are restored, and refuse `INCIDENT` and `NOHOOKS`. _Covers: worktree-reset-commands-broadcast-revert, local-git-ops-propagate-as-reverts, human-git-mass-revert_
- **LIF-18** Quarantined and save-only path changes MUST reach the branch only through a human git commit and push, handled as E3 → E2 → ENG- base move. Lifecycle MUST NOT add any other path for them. A held or `local_only` change leaving through a human commit MUST be caught by HLD-'s branch test in the base move. _Covers: gitattributes-edit-unfilters (via DAT- EPOCH_BASE re-preflight), held-hunk-escapes-via-branch-commit, branch-moves-under-live_
- **LIF-19** Save MUST refuse, pushing nothing, when:
  - the summary is empty;
  - `checks.save` is unapproved for its SHA-256;
  - any FREEZE reason or publish pause is set;
  - an ACTIVE base-move hold exists;
  - the config at EPOCH_BASE is invalid;
  - `Hb` is not an ancestor of `Hr`;
  - DAT-12's branch-form check `formCheckSave(Hb, L)` fails for every candidate `L` (§3.7 step 5; a candidate that fails it MUST NOT become `Lk`);
  - `tree(Lk) == tree(Hb)`.

  _Covers: push-rejection-poisons-chain, save-reverts-external-commits_
- **LIF-20** Save MUST close the issuing seat's open CS and the human CS, publish own ready CSs (including the newest passing edit-checkpoint capture of any open local CS, glossary §27.1) within ≤ 2 governor windows (§2.5, glossary §27.2), fetch, and, while `Hr ≠ Hb`, run the ENG- base move first (≤ 3 restarts). It MUST NOT wait for other seats' open CSs and MUST NOT run or wait for an edit check. _Covers: save-reverts-external-commits, explicit-base-not-ancestry_
- **LIF-21** Save MUST choose `Lk` from TIP's first-parent chain while `live_base == Hb` (≤ 20), settled candidates first, each newest-first. `Lk` is the first candidate that passes DAT-12's branch-form check against `Hb`, T0 and, when configured, `checks.save`, within 15 min total. Save MUST NOT synthesize, splice or exclude anything in a tree. _Covers: save-splice-commits-untested-tree, f-save-lagging-tree-reverts-peers_
- **LIF-22** `checks.save` MUST run only after `/cowork save --approve-check=<sha8>` has recorded the FULL SHA-256 of the exact command string in `user.json.saveCheckApproved`. `<sha8>` is only the typed confirmation. It MUST be spawned by the CLI process with an environment built by the 09-security §3.4 builder from the CLI's own environment (allowlist, `env.passthrough`, never-list, forced values), so no `CLAUDE_*` value reaches it (09-security INV-TOKEN), inside `git worktree add --detach <gitdir>/cowork/tmp/save-<n> <Lk>` with `GIT_LFS_SKIP_SMUDGE=1`, under `saveTimeoutSec` (default 300, max 1,800) with a process-tree kill. The worktree MUST be removed afterwards; RESTART removes leftovers. _Covers: save-splice-commits-untested-tree_
- **LIF-23** Save MUST print a preview (§3.7 step 6) and act only on a matching `--confirm=<id>`. Before building S, it MUST re-fetch and re-verify that `Lk` is on TIP's first-parent chain and `live_base(Lk) == Hb == Hr`. _Covers: model-invocable-save, save-race-reverts-concurrent-edits_
- **LIF-24** S MUST be built in the CLI process as `commit-tree tree(Lk) -p Hb`, with `-S` when `--sign` or `commit.gpgSign=true`. Its message is per §3.7.2, with no skip-CI marker. These asserts MUST hold before any push: typed existing oids, `tree(S) == tree(Lk)`, `S^1 == Hb ==` fetched `Hr`, `Lk` on TIP's first-parent chain. A signing failure or failed assert MUST push nothing. _Covers: f-save-lagging-tree-reverts-peers, empty-oid-push-deletes-live-ref_
- **LIF-25** Save MUST journal the save intent, then push only `S:refs/heads/<b>` with `--force-with-lease=refs/heads/<b>:<Hb>` in a governor slot, never `+` or `--force`. Outcomes MUST be classified per §3.7 step 10 by ref state after a fetch, never by message text (glossary §26.2 item 2). A rejection with `Hr` moved is a lease loss. A rejection with `Hr == Hb` MUST be retried in the next governor slot with backoff, and only the 3rd consecutive one MUST end the save with `SAVE_REJECTED_BY_HOST`, after which it MUST NOT be retried. Its host text MUST be shown sanitized and verbatim only in the CLI refusal and the doctor record, never in `status.json.message_params` or a systemMessage. `--atomic` MUST NOT be used (glossary §26.2 item 1). _Covers: save-race-reverts-concurrent-edits, push-rejection-poisons-chain_
- **LIF-26** After a successful branch push and `crashpoint("save.branch_pushed")` (TST-06), the saver's daemon MUST publish `save{save_commit, saved_live, chain_base, released_claim_ids}` plus `release{reason: save}` with last parent `Ls = commit-tree tree(TIP) -p TIP -p S` (`Cowork-Base: S`). If another daemon completed the base move, the `save` op MUST still be published. The save intent MUST be kept until it is resolved. This includes the no-answer case: each loop and each restart re-fetches, and then `Hr == S` → publish the op if it is missing; otherwise → clear the intent. _Covers: save-race-reverts-concurrent-edits, no-history-undo_
- **LIF-27** Save attribution MUST be computed from the live first-parent chain `(G, Lk]` using author names and REG- region mapping. It is written only as glossary §5 trailers (`Cowork-Saved-Live`, `Cowork-Symbol … by …` ≤ 300, `Cowork-Symbol-More`, opt-in `Co-authored-by`). It MUST NEVER be derived from `git blame` of S. When it exceeds 10 s, the Symbol lines MUST be omitted. It MUST be computed only by `saveAttribution` (§3.7.2; FEAT-F12-07). *(new in rev 2.5, F12.)* _Covers: save-squash-erases-provenance, no-history-undo_
- **LIF-28** Adopt MUST run automatically exactly when the §3.8.1 conditions all hold: the glossary §12 conditions plus "not frozen" and "no open Bash/PowerShell TXN". It MUST NOT require the disk to equal X. _Covers: post-save-head-drift, head-drift-after-pull-or-save_
- **LIF-29** REATTACH (§3.8.2) MUST be the only code that writes `.git/index` or `refs/heads/<b>`. It MUST:
  - journal first;
  - hold `.git/index.lock` taken with O_EXCL;
  - verify the index is unchanged since the copy;
  - change only the entries of `diff(from, to)`;
  - rename the lock (5 × 100 ms retry);
  - CAS `update-ref` from `H_adopt`, rolling back the index on a CAS failure;
  - never touch a working-tree file, FETCH_HEAD, ORIG_HEAD or `refs/remotes/*`, and never run git on a working-tree file (no `update-index --refresh`; glossary §26.1 W1);
  - call the crashpoints `adopt.lock`, `adopt.index_renamed` and `adopt.ref` at the §3.8.2 positions (TST-06).

  _Covers: post-save-head-drift, head-drift-after-pull-or-save_
- **LIF-30** Restart with an adopt intent MUST follow the §3.8.3 table. A `.git/index.lock` whose content hash ≠ the journaled `sha_new` MUST NEVER be removed or modified. _Covers: crash-between-apply-and-state-resurrects-deletes (adopt case)_
- **LIF-31** A blocked adopt MUST emit `ADOPT_BLOCKED(paths, reasons)` once per `(X, reason set)` to the human and each live seat, set `status.json.adopt = {state: "blocked", reasons}`, and re-check every loop silently. _Covers: post-save-head-drift, silent-stall-no-visible-surface_
- **LIF-32** Stop MUST refuse on E5, `INCIDENT`, the publish pauses `OFFLINE`, `AUTH`, `NONRETRYABLE` and the proto form of `VERSION`, or another local seat mid-turn (the issuing seat is exempt). In the board-only form of `VERSION` it MUST proceed and skip the code publish (glossary §24 default 6). Under `CONFIG(url|public)` it MUST run as the local stop of §3.9 step 0 (no network call, nothing parked). Otherwise, after the flush, it MUST refuse with `STOP_HOLDS_NOT_DURABLE{ids}` while any non-`local_only` non-terminal record is not durable (HLD-62, HLD-63), unless `--discard-holds=<ids> --confirm=<id>`. _Covers: stop-semantics-undefined, local-only-holds-break-nothing-lost_
- **LIF-33** Stop MUST:
  - set `stopping`;
  - close the issuing seat's and the human CS;
  - publish ready CSs, including earlier edit-checkpoint captures, when not frozen (≤ 2 governor windows, cap 60 s; glossary §27.1, §27.2);
  - call `crashpoint("stop.flushed")` after the flush and durability check, before the board push (TST-06);
  - make one board push with all-claim release (`reason: stop`), `seat_end` per seat, `request_status{returned}` per unanswered request identity addressed to this peer, and `leave`;
  - PARK every ON_DISK PATCH or PIN record with `local_only = false` (state ACTIVE or CONFLICTED) when not frozen (HLD-63); `local_only` and INCOMING records are never parked (HLD-16), and a record carrying `markers` is parked only by HLD-'s markers park (05-holds §3.4 item 3, HLD-63 step 3), which keeps its marker rows in a `local_only` marker companion on this PC;
  - set `stop_mode := stopped`;
  - remove the `live` marker last;
  - print the STOP report, including the LIVE_UNSAVED files.

  Stop MUST NOT otherwise write the working tree. _Covers: stop-semantics-undefined, held-hunk-escapes-via-branch-commit, branch-switch-publishes-other-branch_
- **LIF-34** Stop MUST keep `refs/cowork-local/<enc(b)>/{state,holds}`, `<enc(b)>.index` and `peer`. Only `uninstall --purge` MAY delete them, and only after LIF-35's durability check. _Covers: park-refs-in-worktree-namespace-vanish, local-only-holds-break-nothing-lost_
- **LIF-35** `/cowork uninstall` MUST run STOP for every live gitdir in `repos.json`. `--purge` MUST refuse with `UNINSTALL_HOLDS` while any non-terminal record of this peer is non-durable or `local_only`, unless `--discard-holds=<ids> --confirm=<id>`. It MUST never delete a remote ref, and MUST end with the `/plugin uninstall` instruction. _Covers: uninstall-deletes-state-daemon-orphaned, orphan-daemon-uninstall, local-only-holds-break-nothing-lost_
- **LIF-36** A daemon MUST check plugin enablement, `ipc.key` and `runtime/<version>/` every 30 s (CCI-53). On any failure it MUST:
  - first remove every `live` marker it owns;
  - then make no working-tree write and no new snapshot;
  - make one board push (ready trees through all gates when not frozen, plus `release`, `seat_end`, `leave`) when online;
  - set `stop_mode := removed`;
  - exit;
  - raise `DAEMON_REMOVED` (UX-27 `NT_PLUGIN_REMOVED`).

  A daemon exiting for lease expiry MUST NOT park or remove markers, and its last `status.json` write MUST set `state: "down"` and `message_code: "IDLE_NO_SESSION"` (glossary §25.2 item 6; ENG-56, CCI-50). _Covers: orphan-daemon-outlives-sessions-and-plugin, orphan-daemon-uninstall_
- **LIF-37** A plugin update MUST lead to RESTART (never JOIN). `meta_v` MUST migrate forward only. A daemon finding `meta_v` > own MUST refuse the branch (`refused`). A board `protocol.json` proto ≠ own (v1: ≠ 1) MUST set the proto form of the `VERSION` publish pause while live (zero pushes) and refuse start with `START_VERSION`. An own regionSpec ≠ the folded `teamRegionSpec` (PRO-48) MUST set the regionSpec form (code pushes paused, glossary §8 board-only ops allowed) and MUST NOT refuse start. regionSpec MUST NOT be compared with `protocol.json.regionSpec` (genesis value only). _Covers: version-skew-board-and-guards, version-skew-board-loss, supply-chain-versions (versioned runtime dir; release pinning via TST-/REL-)_
- **LIF-38** While `OFFLINE` or `AUTH`, save and stop MUST refuse, and uninstall refuses through stop. Snapshots and ready captures (edit-checkpoint captures included, glossary §27.1) MUST continue. Reconnect MUST follow the ENG- loop order before any publish. _Covers: offline-split-brain, offline-auth-claims_
- **LIF-39** A suspend gap (Δwall − Δmono > 5 s, same machine) MUST:
  - kill in-flight network git process trees;
  - mark own claims SUSPECT (PRO-);
  - force a fresh fetch and fold before any apply, publish, adopt or save decision;
  - restart lease timers from the wake moment.

  _Covers: hung-network-git-after-sleep, sleep-offline-stale-and-suspect-claims_
- **LIF-40** After a crash or reboot with the marker present, edits MUST be denied (G4) until the respawned daemon answers. RESTART MUST run without a preview. Status MUST read `down` while the heartbeat is older than 3 loop periods. _Covers: mcp-or-daemon-death-fails-open-and-stuck-fences, silent-stall-no-visible-surface_
- **LIF-41** `/cowork start --human <minutes>` (1–480) MUST grant a CCI- human lease. It is the only v1 way to coordinate human editing with no Claude session; without it, status shows "idle (no session)" from the `IDLE_NO_SESSION` code that LIF-36's lease-expiry exit writes (glossary §25.2 item 6). _Covers: silent-stall-no-visible-surface_
- **LIF-42** `/cowork recover` MUST run only as a human-typed acting verb with preview/confirm (§3.13). Its preview MUST name the mode ENG-22 selects. In restore mode it MUST show the candidate to be force-pushed and the displaced ref the observed tip goes to. In re-anchor mode it MUST show that nothing is pushed, that this peer's `LA_B` is kept at `refs/cowork-local/<enc(b)>/incident-<n>-own`, and every path that becomes a `restart` record; the report MUST list those records and re-anchor MUST emit `LOST_STATE`. _Covers: ref-rewind-silent-revert, no-history-undo_

---

## 5. Invariants

**Glossary invariants enforced here:**
- **INV-NOLOSS.** Across every lifecycle transition (join, stop, pause/resume, crash/restart, recover, adopt, save, uninstall), in the glossary §21 wording (rev 2.1: a process holding a file handle open across the ring window is out of scope and doctor warns; the warning is 10-product's doctor row `DR_LATE_WRITE`, fed by 01-engine ENG-35's late-write records). Snapshot ticks write no objects (glossary §26.1 W6), and that does not weaken it. Unpublished bytes are in ready pairs, which do write objects, or on their author's disk, and a non-durable record is never parked (glossary §25.2 item 1).
- **INV-FF.** Save's branch push is a leased fast-forward; the base move is ENG-'s.
- **INV-OID.** No lifecycle verb deletes a remote ref.
- **INV-NOSILENT.** Every freeze, pause, adopt block and refusal is visible in status and to the seat.
- **INV-CLOCK.** All lifecycle timers are local Δmono.
- **INV-SECRET.** Start refuses before any push when the filter preflight fails (DAT-16, in its glossary §25 F12 / §26.2 item 3 form, with `filter.<d>.required=true` confirmed to fail closed, §25 F12). No lifecycle push carries a `local_only` path, a secret-scanner hit, a quarantined path's local bytes (S8) or a restore-marker blob: the save tree is an existing live tree, and the records mirrored by start, stop and recover contain only LIVE paths (glossary §9).
- **INV-GROUP.** The first apply of start and RESTART is ENG-'s and writes whole publication groups of applicable paths only; incoming quarantined paths are not applicable (review items, SEC-32).

**Chapter-local invariants:**

| Id | Statement |
|---|---|
| **INV-LIF-EPOCH** | No daemon working-tree write, no code publish, no adopt and no save happens for branch b while the table is not E1 (or a completed E2 RECONCILE), or while any FREEZE reason is set. INCIDENT additionally forbids every push except ENG-21's one displaced copy of `LA_B` and the pushes of a human-typed `/cowork recover` (glossary §8). |
| **INV-LIF-NOREINIT** | A missing, corrupt or newer-format state ref never causes JOIN, never seeds `A` from TIP or a live base, and never publishes before ENG- LOST-STATE completes or the branch is refused. The one exception is the human-confirmed `start --fresh` (§3.3.5; binding, glossary §27), which deletes the state ref on purpose and runs GENESIS with `A = tree(HEAD)`, never JOIN. |
| **INV-LIF-REATTACH** | `refs/heads/<b>` and `.git/index` are written only by REATTACH. The write is a CAS from `H_adopt`; index entries change only for `diff(from, to)`; no file content or mtime changes, and no git process reads a working-tree file on its behalf (glossary §26.1 W1); it never moves the branch backwards and never runs while frozen. |
| **INV-LIF-SAVE** | A save pushes only `refs/heads/<b>`, with a lease on `Hb`, never `+`/`--force`. `tree(S)` equals the tree of an existing live commit `Lk` on TIP's first-parent chain, and `S^1 == Hb ==` the fetched branch head. A failed step pushes nothing. |
| **INV-LIF-HUMAN** | Every lifecycle verb that publishes local work, moves a branch, discards held bytes, force-pushes the board (`recover`) or overwrites disk with a reviewed team version (`review --accept`) runs only with human evidence (never from a wake turn), after a preview with a matching `--confirm`/`--publish`. |
| **INV-LIF-STATE-KEPT** | Stop never deletes `refs/cowork-local/<enc(b)>/*`, the private index or the registry. Only `uninstall --purge` removes them, after its durability check. |
| **INV-LIF-MARKER** | The `live` marker is written only after the state ref exists. It is removed only by stop (last step) or by the removal sequence (first step). A disappearance outside those two is undone by the daemon, which re-creates the marker with the same content and raises `LIVE_MARKER_RESTORED` (CCI-53; glossary §24 default 8). |
| **INV-LIF-PREFLIGHT** | A refused start leaves no new ref, no `live` marker, no `repos.json` entry and no state commit. The probe ref is deleted per PRO-. |

---

## 6. Failure handling

| Situation | Detection | Behaviour | What the human sees | What Claude sees |
|---|---|---|---|---|
| Human `git pull` while live | E2 at step 0 | `EPOCH` until the base move, then RECONCILE and lift | status "waiting for the team's base move"; then nothing | `FROZEN`/`UNFROZEN` once |
| Human commit while live | E3 after a confirming fetch | `EPOCH`; E3 notice | `EPOCH_COMMIT_HAS_LIVE_WORK` or `EPOCH_LOCAL_COMMIT` + OS notification | same notice at next hook |
| Pushed commit conflicts with live | ENG- base move rc=1 | base-move holds, save blocked, committer stays E2-frozen | `BASE_MOVE_CONFLICT` with `git revert` command | `BASE_MOVE_CONFLICT` |
| Branch switch / bisect / rebase stop | E5 | `EPOCH`, no snapshot | op + way back | `FROZEN{EPOCH_GIT_OP}` |
| `git stash` | E6 | `EPOCH`; lift on pop if delta small, else `MASS` | `EPOCH_STASH` | `FROZEN{EPOCH_STASH}` |
| `reset --hard` with HEAD unchanged | `logs/HEAD` growth marks delta; HLD- revert/breaker | taint or `MASS` | HLD- notices | HLD- notices |
| Commit editor holds `index.lock` | lock present | fetch only; never delete | `INDEX_LOCK_WAIT` after 30 s | nothing (no state change) |
| Daemon crash or reboot | loader IPC fails; stale heartbeat | G4 for Claude edits; CCI- respawn; RESTART | status `down` | G4 deny text |
| Power loss corrupts state | state ref or object missing | ENG- LOST-STATE; `restart` holds | `LOST_STATE` list | `LOST_STATE` |
| Crash during REATTACH | adopt intent in journal | §3.8.3 table | nothing unless a foreign lock remains | nothing |
| Crash between save branch push and board push | save intent; any daemon sees `Cowork-Saved-Live` | ENG- completion; restart publishes the `save` op | `SAVE_REPORT` later | `SAVE_REPORT` |
| Two concurrent saves | branch lease rejected; `Hr` has `Cowork-Saved-Live` | loser reports | `SAVE_ALREADY_SAVED` | — |
| Protected branch | 3 consecutive rejections of the branch push with unchanged `Hr` (outcome, not text; glossary §26.2 item 2) | refuse after the 3rd, intent cleared, nothing else changes | `SAVE_REJECTED_BY_HOST` + host text (CLI refusal and doctor only) | — |
| Transient host rejection of save's branch push (`[remote rejected] … (failed)`, `fatal error in commit_refs` under concurrent pushes, glossary §25 F11) | rejection with unchanged `Hr` | retried in the next governor slot with backoff; the 2nd consecutive one also engages the 30-min throttle fallback (B = 6, glossary §27.2); the save completes when a retry lands | nothing extra (the save completes; status shows the fallback) | — |
| Host throttling during a lifecycle push (HTTP 429, any 5xx, push RTT > 10 s) | governor throttle signal (glossary §27.2) | this peer uses B = 6, G = 10 s, S = 3 s for 30 min and posts `health{throttle}`; save/stop continue at the slower pace, stop still capped at 60 s | nothing extra; `STOP_REPORT` lists any CS not published within the 60 s cap | — |
| Daemon died with the host (kill-on-close job object, glossary §25 F4) | doctor: the daemon's lifetime ended with the host process | marker kept; G4 until respawn | doctor line "daemon died with the host" | G4 deny text |
| User file unstable during RECONCILE, the lift check or REBUILD | staged-copy read: size/mtime changed across the read and the re-read (glossary §26.1 W1) | decision waits for the next loop; nothing decided for that path | nothing extra | nothing extra |
| Signing fails (e.g. no pinentry without TTY) | commit-tree -S exit ≠ 0 | refuse | `SAVE_SIGN_FAILED` | — |
| All save candidates fail checks | checks exit ≠ 0 | refuse | `SAVE_CHECK_FAILED` with output tail | — |
| Every save candidate fails the branch-form check (DAT-12) | `formCheckSave(Hb, L)` per candidate | refuse; a form-failing candidate is never `Lk` | `SAVE_EOL_BRANCH_FORM(paths)` | — |
| Adopt blocked by staged path | condition 5 | no move; repeat silently | `ADOPT_BLOCKED` once + `git restore --staged` | `ADOPT_BLOCKED` once |
| Stop while another seat mid-turn | mid-turn rule | refuse | `STOP_SEAT_BUSY` | — |
| Stop while offline | publish pause | refuse; suggest pause | `STOP_PUBLISH_PAUSED` with the offline duration (`offline_for_s`, glossary §25.2 item 4) | — |
| Volume without hard links | start preflight probe (§3.3 step 2.2) | start continues; the writer uses its copy fallback | `START_NO_HARDLINKS` WARN at start and in doctor (glossary §26.2 item 7) | — |
| Acting slash verb without UserPromptExpansion evidence (e.g. typed by a script, or from a wake turn) | the CLI's evidence wait (≤ 3 s, glossary §25 F5) | refuse, nothing done | `SEC_REFUSE_NOT_HUMAN` | `SEC_REFUSE_NOT_HUMAN` (SEC-25) |
| Stop while own regionSpec ≠ `teamRegionSpec` (board-only `VERSION` form) | publish pause form | proceed; skip the code publish; board-only ops pushed (glossary §24 default 6) | `STOP_REPORT` lists the unpublished ready CSs | — |
| Stop under `CONFIG(url\|public)` | freeze detail | local stop: no network call, nothing parked | `STOP_REPORT` + `STOP_LOCAL_ONLY` | — |
| Stop with unmirrored records (incl. `HOLD_MIRROR_REJECTED`) | durability check (HLD-62) | refuse unless discard | `STOP_HOLDS_NOT_DURABLE{ids}` | — |
| `live` marker deleted outside stop (shell, manual) | marker watch (CCI-53) | marker re-created; security log | `LIVE_MARKER_RESTORED` OS notification (`NT_LIVE_MARKER_RESTORED`) | gate active again from the next call |
| Late peer after the team recovered and continued | ENG-22 step 2a | re-anchor: no push; `incident-<n>-own` kept; `restart` records | `RECOVER_PREVIEW{mode: reanchor}`, `RECOVER_REPORT`, `LOST_STATE` | `LOST_STATE`, then `UNFROZEN` |
| Disk changed between `review` preview and confirm | preview id / `writeLocal` MISMATCH | refuse, nothing written | `PREVIEW_STALE` + fresh preview | — |
| Plugin uninstalled or disabled mid-session | plugin enablement, key or runtime check fails (30 s, CCI-53) | markers removed first, one board push, exit | `DAEMON_REMOVED` (`NT_PLUGIN_REMOVED`) OS notification | hooks exit 0 (non-live fast path, ≤ 80 ms p95, glossary §26.2 item 4) |
| Plugin disabled, sessions closed | lease expiry (CCI-) | no apply/push at 2 min, exit at 10 min, state kept; last status write `state: "down"`, `IDLE_NO_SESSION` (glossary §25.2 item 6) | "idle (no session)" | — |
| Teammate on a newer protocol | `protocol.json` mismatch | `VERSION` pause, apply continues | `VERSION_PAUSED` "update cowork-sync" | `VERSION_PAUSED` |
| Downgrade with newer meta | `meta_v` > own | branch refused | `START_STATE_NEWER` | status `refused` |
| Sleep through lunch | suspend gap | kill net git, SUSPECT, fresh fetch | `OFFLINE`→`ONLINE` if applicable | same |
| Remote URL changed by `insteadOf` | SEC- 60 s re-check | `CONFIG` freeze | `FROZEN{CONFIG}` old/new URL | `FROZEN{CONFIG}` |
| Board deleted on remote while stopped | dispatch | refuse | `START_BOARD_GONE` → `/cowork start --fresh` (deleted on purpose; binding, glossary §27) or a live teammate's `/cowork recover` | — |
| Pause written by a non-human | marker without UserPromptExpansion evidence | honoured + security log | OS notification (`NT_PAUSE_UNEXPLAINED`) | paused line |

---

## 7. Tests

All lifecycle tests run with real git (no mocks) on Windows 11 and Linux CI, using the TST- fixtures (BOM+CRLF 5k-line Python file, `autocrlf=true`, a clean/smudge filter).

**Fixed regressions** (VERIFIED, from `sweep/lc/lc1.sh` and core_engine):

| Test | Proves |
|---|---|
| lc/P1: `update-ref` on the checked-out branch appends to `logs/HEAD` | LIF-10, LIF-29 |
| lc/P4: `git pull --ff-only` succeeds with disjoint dirty paths and keeps live bytes; refuses on overlap | LIF-12 |
| lc/P5: base move of a commit touching a live-changed path conflicts; a disjoint commit or one equal to TIP merges cleanly | LIF-13, LIF-18 |
| lc/P6: restart with kept `A` merges to the tip; rejoin with `A=HEAD` conflicts | LIF-09, LIF-34 |
| x1_save_completion | LIF-26 |
| x3_adopt (staged unrelated path kept, mtimes unchanged, stale CAS refused; VERIFIED with the step-2 refresh, re-run without it in integration test 10) | LIF-29, INV-LIF-REATTACH |
| late-join variants (HEAD behind / equal / ahead) | LIF-07 |

**Integration:**

1. **Preflight matrix** (LIF-03, LIF-04, LIF-05, INV-LIF-PREFLIGHT). Each case refuses with its code, and the test asserts no ref, marker, `repos.json` entry or state commit was written. Cases:
   - fetch URL ≠ push URL; `pushInsteadOf` rewrite
   - shallow; partial; sparse; split index
   - linked worktree; branch checked out in a linked worktree
   - repo under `%OneDrive%`
   - two clones live on the same (URL, branch); a second branch in one clone
   - case-fold collision; `enc(b)` > 150 bytes
   - branch not on remote; no remote resolvable
   - filter preflight in its glossary §25 F12 / §26.2 item 3 form: a driver that is undefined or exits non-zero refuses with `START_FILTER`. A driver with a repository-relative script path passes, because filters run with cwd = the repository root, and the test proves the driver actually ran (spike 03 found that the old scratch-work-tree preflight never ran it)
   - a volume without hard links: start succeeds with the `START_NO_HARDLINKS` WARN, and doctor shows it (glossary §26.2 item 7); this is the one case here that does not refuse, and it writes the normal start state
   - each refusal code is the owning chapter's registry name (`START_FILTER`, `START_REFUSED_CUSTOM_REFS`, `CFG_REFUSE_INVALID`, `START_BOARD_GONE`, `GENESIS_BOARD_MISSING`), and every code of Table 2.7-A/B has templates in every required language (L-CODES, glossary §19)
2. **Epoch table harness** (LIF-11, LIF-14, INV-LIF-EPOCH). For each of switch, `checkout <oid>`, `bisect start`, `rebase -i` break, cherry-pick conflict, revert conflict, stash, stash-pop conflict, commit, amend, `reset --hard` (HEAD unchanged), `reset --soft HEAD~1`, `reset --soft <Hr>` forward and `pull`, run it on peer B between loops at random points (1,000 seeds). Assert:
   - the E-class and sub-code;
   - no remote change except board freeze events;
   - B's working-tree bytes are unchanged by the daemon;
   - peers' trees are byte-identical before and after;
   - automatic lift after the documented way back (stash pop, switch back, bisect reset, rebase --abort, `reset --soft <H_adopt>`);
   - after every episode, `git fsck --connectivity-only` and `git gc --prune=now` succeed: `journal/keep/pre_freeze_base` and the `pre_freeze` oid-map blob reference no missing object (§2.1, glossary §26.1 W6);
   - an editor rewriting a file during the lift check or RECONCILE (an unstable staged read, glossary §26.1 W1) postpones the decision by one loop and never decides that path as changed or unchanged.
3. **E2 reconcile** (LIF-12). An outsider pushes U (disjoint), and B runs `git pull`. Assert:
   - E2, then RECONCILE after the base move;
   - `H_adopt := U` with no daemon write to `refs/heads`;
   - no breaker trip;
   - `A` converges;
   - `git status` is clean except unpublished live work.

   Variant: `reset --soft <Hr>`, which must NOT publish a revert of U (the `else keep A[p]` branch).
4. **E3 notice timing** (LIF-13). The human commits and pushes within one loop: no `EPOCH_COMMIT_HAS_LIVE_WORK` is emitted. Commit only: the notice is emitted once after a confirming fetch, and names the LIVE_UNSAVED intersection.
5. **Human `commit -a` + push of overlapping live content** (LIF-13, LIF-18). Assert the E3 warning before the push, the base-move conflict, saves blocked with one board event, that the documented `git revert` + push unblocks, and that no marker line is lost.
6. **Save-only path** (LIF-18). `git commit -- .gitattributes && git push`. Assert a clean base move, the EPOCH_BASE change, the DAT- preflight re-run, and that a planted plaintext secret never appears in any live blob afterwards.
7. **Save matrix** (LIF-19..LIF-27, INV-LIF-SAVE):
   - no check / passing check / failing newest candidate / all failing / unapproved check (no process spawned);
   - settled-first ordering;
   - two concurrent saves (`SAVE_ALREADY_SAVED`);
   - outsider push mid-save (`SAVE_BRANCH_MOVED`, fresh preview);
   - protected branch simulated by a pre-receive hook on the file:// remote: exactly 3 attempts with `Hr` unchanged, then `SAVE_REJECTED_BY_HOST`, no ref change, the save intent cleared, and the host text absent from `status.json` and every systemMessage (glossary §26.2 item 2; ENG-45);
   - one injected rejection with `Hr` unchanged (the glossary §25 F11 `(failed)` shape), then acceptance: the save completes in the next slot, and no `SAVE_REJECTED_BY_HOST` appears;
   - two injected rejections with `Hr` unchanged, then acceptance: the 2nd engages the throttle fallback (B = 6, G = 10 s, a `health{throttle}` event on the board), the 3rd attempt lands in a fallback slot, the save completes, and no `SAVE_REJECTED_BY_HOST` appears (glossary §27.2);
   - edit checkpoints (glossary §27.1): seat B on this peer is mid-turn with one passing edit checkpoint and a later failing one; `/cowork save` from seat A publishes B's passing capture with `state=checkpoint` within the final sync, lists it as checkpoint in the preview, does not wait for B's turn end and runs no edit check; the later failing edit does not withdraw the earlier capture;
   - settled-first ordering under edit checkpoints: a teammate seat publishes `state=checkpoint` commits every few seconds; the newest settled candidate within the 20-commit window is chosen, and when none is settled the newest unsettled candidate that passes T0 and `checks.save` is chosen;
   - a rejection whose text is a lease-reject string while `Hr` did not move is still counted as a transient rejection, never as a lease loss (classification by outcome, glossary §26.2 item 2);
   - `commit.gpgSign=true` with a missing `gpg.program` (`SAVE_SIGN_FAILED`, no push);
   - stale `--confirm` after TIP moved past a changed `Hb` (`PREVIEW_STALE`);
   - message contains no skip markers and trailers match glossary §5;
   - `Cowork-Symbol` lines ≤ 300 with `Cowork-Symbol-More`;
   - attribution > 10 s (injected) → no Symbol lines.
   - summary draft (T-F12-draft-same-computation; LIF-27, LIF-02): a chain `(G, Lk]` of 30 live commits by 3 authors over 5 areas with one unsupported-language file. The set of (path, label, name) in the preview's draft, before its caps, equals the set in the `Cowork-Symbol` trailers of the save built from the same `Lk`, and the unsupported file appears as its whole-file label. The preview id is the same with draft generation disabled (T-F12-preview), and `/cowork save ""` refuses `SAVE_SUMMARY_EMPTY` with the `NX_WRAP_THEN_SAVE` next line. *(new in rev 2.5, F12.)*
8. **Save crash points** (LIF-25, LIF-26, LIF-09). Kill -9 (TerminateProcess on Windows) before the branch push, at `crashpoint("save.branch_pushed")`, and before the board push, over 200 seeded trials. Assert:
   - completion by another daemon;
   - restart publishes the missing `save` op;
   - every edit ever pushed is in the branch or in `diff(branch, live tip)`;
   - no marker line is lost.
9. **Adopt** (LIF-28..LIF-31):
   - Peers publish edits to a saved path 1–5 s after a save. Adopt succeeds for peers whose index is clean on the saved paths, even with extra local edits (S7), and `git status` shows only those edits.
   - A peer with a staged saved path gets exactly one `ADOPT_BLOCKED`, not one per loop.
   - Adopt is skipped while frozen and while a Bash TXN is open.
10. **REATTACH crash injection** (LIF-30, INV-LIF-REATTACH). Kill after each of steps 3–8, including the crashpoints `adopt.lock`, `adopt.index_renamed` and `adopt.ref`. Assert the §3.8.3 outcome, that a planted foreign `.git/index.lock` survives untouched, and that no file mtime changes. Re-run x3_adopt without the step-2 refresh (rev 2.3). After adopt, `git status` shows exactly the edits on top of the save, a staged unrelated path is kept, and `git pull --ff-only` exits 0. A file-access trace shows that no git process the daemon started opened a working-tree file during REATTACH (glossary §26.1 W1).
11. **Pause/resume** (LIF-16, LIF-17):
    - Pause with the daemon killed: the loader writes the marker, no G4, and the paused line appears.
    - Resume after a stash: rebuild restores the team version, and the stash warning is printed.
    - Claude edits while paused run no edit check and capture no ready pair (glossary §27.1); a capture taken before the pause publishes after resume.
    - Resume refuses E3/E4/E5 with codes.
    - Resume of `CONFIG` with the URL still changed refuses `RESUME_CONFIG_URL`.
    - A marker written by a script raises the security event.
    - Evidence (glossary §25 F5). A typed `/cowork save` succeeds on the evidence line from its UserPromptExpansion (same `prompt_id`, `command_name`, `command_args`), which reaches the daemon before the `!` CLI checks it. A CLI run with no evidence, or with evidence older than 60 s, refuses with `SEC_REFUSE_NOT_HUMAN` after waiting ≤ 3 s. A UserPromptSubmit alone never counts, and a prompt carrying a cowork nonce never produces evidence.
12. **Stop matrix** (LIF-32..LIF-34, INV-LIF-STATE-KEPT, INV-LIF-MARKER):
    - stop typed in seat A proceeds on its UserPromptExpansion evidence (seat A is the issuing seat, exempt from the mid-turn rule);
    - with another seat mid-turn it is refused;
    - with HEAD on another branch it is refused;
    - with an unmirrored record it is refused, then succeeds with `--discard-holds` + confirm;
    - a `local_only` record does not block;
    - stop while `EPOCH`-frozen makes no working-tree write;
    - stop, then `git switch feature`, commit there, switch back, start: no live content lands on feature, and RESTART applies the tip;
    - stop, then `git stash`, then start: the re-baseline note is printed.
    - a board whose teamRegionSpec differs from own (board-only `VERSION` form): stop proceeds, pushes no code commit, pushes `release`/`seat_end`/`request_status`/`leave`, and the report lists the unpublished ready CSs; with board proto ≠ 1 stop is refused with `STOP_PUBLISH_PAUSED`;
    - under `CONFIG(url)`: local stop makes zero network calls, parks nothing, prints `STOP_LOCAL_ONLY`, and the next start's first board push releases the claims;
    - a record carrying `markers` is parked by the markers park: the disk returns to the team version, the half-done resolution is in a `local_only` marker companion listed as "kept on this PC only", and no restore-marker row is in any pushed blob (05-holds §3.4 item 3);
    - a ready pair captured at a passing edit checkpoint before stop is published by step 3 (glossary §27.1); a seat that starts a turn after step 3 and passes an edit check gets a ready pair that is not published by this stop, is listed as not published, and is offered at the next `/cowork start`;
    - kill at `crashpoint("stop.flushed")`: restart finds the flushed CSs and durable records, and the next stop sends `release`/`seat_end`/`request_status`/`leave` exactly once;
    - `rm <gitdir>/cowork/live` while live: the marker is back within 30 s with one `LIVE_MARKER_RESTORED`; `/cowork stop` removes it with no re-creation.
13. **Uninstall/disable** (LIF-35, LIF-36):
    - `claude plugin uninstall` mid-session, and `/plugin disable`. Within 30–120 s: the marker is gone, no file mtime changes afterwards, the board shows `leave`/`release`, the process has exited, and the OS notification was raised.
    - Reinstall + start resumes from kept state with no revert.
    - `--purge` refuses on `local_only`.
    - Close every session with no human lease: after 10 min the daemon has exited, and its last `status.json` reads `state: "down"`, `message_code: "IDLE_NO_SESSION"` (glossary §25.2 item 6).
14. **Version** (LIF-37, LIF-32).
    - A board with proto ≠ 1: the `VERSION` pause in its proto form, applying continues with zero pushes; start is refused with `START_VERSION`.
    - A peer whose regionSpec ≠ `teamRegionSpec`: the regionSpec form, applying continues, no code push, board-only ops (`join`, `leave`, `release`, …) still pushed; start succeeds.
    - Genesis regionSpec X, every peer of R upgraded to X′: `teamRegionSpec` becomes X′, no peer is VERSION-paused although `protocol.json` still says X, and restart is not refused.
    - A newer `meta_v` gives `refused`.
15. **Network/sleep** (LIF-38, LIF-39). A black-hole HTTP server and a non-answering SSH server: watchdog kill within the glossary §18 limits, `OFFLINE` after 30 s, and a fresh fetch + fold before any publish after reconnect. SIGSTOP/NtSuspendProcess for 5 min, then resume: the wake path runs and the lease is not dropped while the seat is alive.
16. **Restart/lost state** (LIF-09, INV-LIF-NOREINIT). Delete the state ref, truncate its loose ref, and `gc --prune=now` after unreferencing an object, each at every loop step boundary; then restart. Assert that no pushed commit removes a marker line present in the live tip, and that the `LOST_STATE` list is shown.
17. **INV-NOLOSS lifecycle extension** (TST- harness). The random schedule includes stop/start, pause/resume, kill -9 at every lifecycle step boundary, uninstall/reinstall, human pull/commit/push/stash/switch, save and adopt. The predicate is asserted after every step.
18. **Recover surface** (LIF-42, LIF-02). Restore mode: the preview names the candidate and displaced ref; a stale `--confirm` after another peer's recover gives `PREVIEW_STALE`. Re-anchor mode (team continued on an earlier recover's tip, peer asleep through both): the preview says nothing is pushed and lists the paths that become `restart` records; after confirm, `incident-<n>-own` exists, zero pushes were made, `LOST_STATE` lists the records, and no team commit is lost.
19. **Review confirm** (LIF-02, §3.2 item 4). Preview `review <id> --accept`, edit the file, confirm: refused (`PREVIEW_STALE` or writer `MISMATCH`), nothing written; confirm without the edit writes the team version and records the prior local version as a `local_only` PATCH (SEC-33). A wake-origin turn cannot produce evidence for it.
20. **Static** (LIF-01, INV-LIF-HUMAN). Every command file has `disable-model-invocation: true`. No MCP tool exposes a lifecycle verb. The advisory Bash deny matches `node …/cli.js save` variants. CI lint: no write to `.git/index` or `refs/heads/*` outside `reattach.ts`.
21. **`start --fresh` and the genesis budget** (LIF-06, LIF-08, glossary §27; new in rev 2.4). A peer with a kept state ref after the board was deleted by hand: plain start refuses `START_BOARD_GONE`; `--fresh` while the board exists refuses `START_FRESH_BOARD_PRESENT`; `--fresh` without `--confirm` changes nothing (no ref, marker or `repos.json` write); a stale `--confirm` after the disk changed gives `PREVIEW_STALE`; confirm deletes only `refs/cowork-local/<enc(b)>/state`, keeps the registry, private index and `peer`, dispatches GENESIS (or `GENESIS_BOARD_MISSING` with the mirror present), and every kept record is re-mirrored and durable on the new board. Budget: genesis with no `host.pushBudgetPerMin` writes `protocol.json.budget = 12`; with 18 it writes 18; a later config change to 6 followed by restart or a teammate's join leaves the board's budget at 18; a `--fresh` genesis seeds from the config current at that start (glossary §27.2).

---

## 8. Open questions (each with the default that ships if unanswered)

Closed by glossary rev 2.1 (§24) and removed from this list: stop under the regionSpec form of `VERSION` (default 6: proceed, skip the code publish); the stop/uninstall durability code name (default 11: `STOP_HOLDS_NOT_DURABLE`); re-creation of a missing `live` marker (default 8); the RECONCILE exception (now in ENG-06); the recover re-anchor policy and its local ref (§4/§8 rev 2.1, `incident-<n>-own`); preview/confirm for `review <id> --accept` (§15). Decided by glossary rev 2.2/2.3 (§25, §26) and folded into the text: the evidence mechanism (§25 F5; Q2 now covers only the interactive measurement); push-rejection classification by outcome (§26.2 item 2, §3.7 step 10); no `--atomic` (§26.2 item 1); the writer of `IDLE_NO_SESSION` (§25.2 item 6). Closed by glossary rev 2.4 (§27, user answers of 2026-10-02): Q1 (`start --fresh` confirmed with preview/confirm; binding in §3.3.5 and LIF-06). Also folded in from §27: edit checkpoints in save's final sync, the candidate walk, stop and pause (§3.6, §3.7 steps 2/5/6, §3.9 steps 2–3, LIF-20, LIF-33, LIF-38), and the push budget of 12 per minute with its throttle fallback for every lifecycle push and the genesis budget seed (§2.5, §3.3 step 2.10, §3.7 step 10, LIF-06). Numbers stay in this list so that references to Q2–Q5 keep working.

1. **`/cowork start --fresh` — closed in rev 2.4 (glossary §27): the user confirmed it on 2026-10-02; it is binding as specified in §3.3.5 and LIF-06, and is tested by §7 test 21.** *(Text kept for the record; it was "owner sign-off pending, glossary §23".)* Retiring local state after the team deletes the remote board by hand (glossary §22 README path): without `--fresh`, a teammate with an old state ref hits `START_BOARD_GONE`, and the only other exit, `/cowork recover`, would re-create the old board (an incident fight if someone already started fresh). **Default (ships, specified in §3.3.5):** `/cowork start --fresh --confirm=<id>` previews `diff(tree(HEAD), S_disk)` as pre-existing local work, deletes only `refs/cowork-local/<enc(b)>/state` (the registry is kept, re-attached and re-mirrored), then dispatches as GENESIS (or `GENESIS_BOARD_MISSING`, 01-engine ENG-51) with `A = tree(HEAD)`. It is the one explicit, human-confirmed exception to INV-LIF-NOREINIT. *(Closed: the user signed off on 2026-10-02, glossary §27.)*
2. **Human evidence for slash-command verbs: interactive confirmation still open.** The mechanism is decided. SPIKE-0 item g measured that UserPromptSubmit fires only after the `!` line has finished and that UserPromptExpansion fires before it. Glossary §25 F5 therefore takes evidence from UserPromptExpansion (§3.1), and the rev-2.1 default ("acting lifecycle verbs become TTY-only") is withdrawn. What remains is the measurement in glossary §26.3: 50 interactive CLI trials and 50 VS Code trials showing that the UserPromptExpansion evidence reaches the daemon before the `!` CLI's check. The spike measured only `claude -p`. **Default (ships):** UserPromptExpansion evidence as in §3.1. On a host form where that check fails, acting verbs there refuse with `SEC_REFUSE_NOT_HUMAN`, and the refusal prints the terminal command to run (TTY evidence). `pause` and the marker step of `resume` stay available through the loader's UserPromptExpansion path.
3. **Signed saves without a TTY on Windows** (GPG4Win pinentry, ssh-agent signing through `commit-tree -S` from the `!` CLI). **Default:** attempt; any signing failure refuses with `SAVE_SIGN_FAILED` and the hint "run the same /cowork save from a terminal". SPIKE-0 did not cover it (no spike in `spikes/01`–`04` exercises signing). Verify it with the interactive runs of glossary §26.3 before GA.
4. **Long `checks.save` runs inside `!` preprocessing.** `checks.save` can run for up to 15 min inside the CLI, and the CLI runs inside slash-command `!` preprocessing. Whether the host kills that path, and after how long, is unmeasured. SPIKE-0 measured only the order of UserPromptExpansion, the `!` line and UserPromptSubmit (glossary §25 F5; the measured `!` line ran ≈ 1.5 s, spike 02 q7b), not a long `!` line. The hook timeout of §25 F6 applies to hooks, not to `!` preprocessing. **Default:** the save preview phase returns at once and hands check execution to a detached CLI helper started with the captured user environment. The helper writes the results under `<gitdir>/cowork/tmp/save-<n>.result`. The next `/cowork save "<summary>"` (or `/cowork status`) shows the finished preview and its id. The measurement goes to TST- SPIKE-0. Until it is done, a save whose checks exceed the host limit is refused with `SAVE_CHECK_FAILED{timeout}` and the hint "run `/cowork save` from a terminal".
5. **Stop with a `HOLD_MIRROR_REJECTED` record** (glossary §9 rev 2.1; PRO-24). Such a record is deterministically unmirrorable until it changes, so it can never become durable, and the stop durability check (HLD-62/HLD-63) refuses on it. **Default:** keep the refusal (`STOP_HOLDS_NOT_DURABLE{ids}` lists the record with its `HOLD_MIRROR_REJECTED` status); the human resolves it (`/cowork resolve <id> …`, which creates a new rev and a new hold op) or discards it with `--discard-holds=<ids> --confirm=<id>`. Nothing is parked or lost meanwhile. Glossary §25.2 item 1 (S6 waits for durability: a non-mirrored record, `HOLD_MIRROR_REJECTED` included, is never auto-parked and stays on disk and visible) already rules out parking such a record. Only one choice is left: whether stop refuses, or proceeds and keeps the record ON_DISK. The alternative (treat it like a `local_only` record: kept ON_DISK, never parked, never blocking stop) needs a 05-holds HLD-63 change and a glossary §9/INV-NOLOSS statement.
6. **Save candidate window under edit checkpoints (new in rev 2.4, glossary §27.1/§27.2).** Edit checkpoints and the budget of 12 per minute make live commits more frequent, so the glossary §20 window of ≤ 20 save candidates can span ≈ 100 s at full team budget, and a long mid-turn seat can leave no settled candidate inside it (§3.7 step 5). **Default (ships):** keep ≤ 20 candidates and the 15-min total, settled first, then unsettled newest-first; every candidate still runs the branch-form check, T0 and `checks.save`, and the preview names the open CSs and their `state=checkpoint`. The soak (glossary §27.2 soak gates; 11-testing) records how often save picks an unsettled `Lk`; if that is common, a wider window (by commits or by Δmono) is a glossary §20 change, not a lifecycle one.
7. **Save attribution range (new in rev 2.5, raised by F12 to this chapter's owner).** §3.7.2 walks `(G, Lk]`, where G is the base-move commit that introduced `Hb`. But `diff(Hb, Lk)` can also contain changes made after the previous save's `Lk` and before that save's base move, and, when the newest base move came from a human branch commit (§3.12), older unsaved live work. Neither the `Cowork-Symbol` trailers nor 10-product's summary draft (the same `saveAttribution`, FEAT-F12-07) name the authors of those changes; `/cowork wrap` counts such paths as "changed before the last save or branch move" (`UI_WRAP_UNSAVED_EARLIER`) so they are not lost from view. Starting the walk at the `Cowork-Saved-Live` value of `Hb` when `Hb` is a save commit would close the gap for both. **Default (ships):** the range stays `(G, Lk]`, so save behaviour and trailers are unchanged; changing it changes the trailers and the draft together, through the one function.
