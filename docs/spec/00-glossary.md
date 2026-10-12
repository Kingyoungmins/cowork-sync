# 00 — Glossary, canonical interfaces and numbers

**Status:** normative. Every other chapter MUST use the names, schemas and numbers defined here verbatim and MUST NOT redefine them. A chapter that needs something not defined here adds it to its own "Local definitions" section and flags it for promotion into this file during review.

**Keywords:** MUST / MUST NOT / SHOULD / MAY as in RFC 2119.

**Inputs this file was assembled from:** `docs/research/consolidation/` (resolutions, seven subsystem catalogs, cross-check) and `docs/research/failure-sweep/` (205 findings). Where those sources disagree, this file is the decision. The cross-check fixes, interface-mismatch fixes and YAGNI cuts are all applied here.

**Revision 2** (after the first chapter drafts) folds in the definitions the chapters asked to promote and fixes the glossary defects they reported. Section §23 lists every rev-2 change with the chapter that raised it.

---

## 1. User decisions (binding)

| Id | Decision |
|---|---|
| U1 | Transport is the project's git remote only. Access control is the repository's own permissions. |
| U2 | One shared live state per branch on the remote; the working tree syncs both ways (human and Claude edits). |
| U3 | *(revised in §27.2, 2026-10-02)* A team push governor keeps the team at ≤ 12 push attempts per 60 s per repository (configurable 6–24), falling back automatically to 6 on any host-throttling signal. Push only on change; coalesce. Poll with `git fetch`. |
| U4 | Claims are optimistic and region-level: taken locally at once, published at the next push; races are decided by board order; the later one is the *conflict causer*. |
| U5 | A held region blocks the edit (deny + note). The attempted change is recorded automatically; the blocked seat continues other work; the leftover is offered to the holder; when the holder seat's own work ends, **its Claude presents the request to its human and asks "handle it?"** — in a human-origin turn the holder's Claude answers `accept` only on its human's word (S5 covers wake turns); decline/release returns it to the requester. Nothing is ever lost. |
| U6 | One canonical warning to the causer's Claude ("cowork-sync on behalf of `<holder>`'s session") and one notice to the holder's Claude; bystander Claudes are not woken. Causer options: wait, ask to go first, hand off. No override in v1. |
| U7 | Real-time delivery uses each session's inbox socket, posted by that session's own MCP server. Each delivered message costs a Claude turn: rare, batched, capped. |
| U8 | `save` (any human) commits the shared tree to the real branch with per-region attribution. |
| U9 | After a save, a peer's local branch follows the saved commit automatically when safe (§12). |
| U10 | New files sync automatically, except ignored, secret-like, quarantined, or > 1 MiB new files. Configurable per repo. |
| U11 | TypeScript bundled by esbuild into single-file JS, Node ≥ 20, no runtime dependencies; user-scope plugin from a GitHub marketplace. |
| U12 | Name `cowork-sync`. Private repository first, public later. README in en (default), ko, zh-CN, ja, fr, es with a language switcher. |
| S1 | *(revised in §27.1, 2026-10-02)* A Claude change-set is published at every **edit checkpoint** whose edit check passes, and at turn end, green checkpoint or `cowork_checkpoint`; claims are visible within seconds; a human change-set publishes after 20 s without edits on its paths (or `/cowork done`). |
| S2 | On a same-lines conflict the earlier-published version goes on disk; the later version becomes a team-visible hold record restorable with one command. Applies to human edits too. |
| S3 | If this PC's daemon is not answering, Claude's edits in a live repo are denied with a clear message (fail closed). |
| S4 | A holder whose PC (daemon epoch) publishes no op for **30 min** after a request is presumed absent; its claims become non-blocking (STALE); its unpublished bytes are preserved. If the holder PC acknowledged (`request_status`) but then goes silent without answering, the requester's daemon files exactly one automatic re-attempt 30 min after the acknowledgment, which re-arms the 30-min test. |
| S5 | Sessions in auto/acceptEdits/dontAsk/bypassPermissions mode are woken too (within caps). A turn started by a teammate notice MAY accept a request and edit code (user choice), limited to work it accepted or that targets its own claims (the *wake work set*); every such change is attributed `origin=wake` and listed to the human at their next prompt. Writes outside the wake work set (including by shell commands) are never published: they are PINned with guard `wake-scope`. |
| S6 | A hold whose bytes are on this PC's disk but not in the team version (an `ON_DISK` record with `local_only=false`) is automatically **parked** after 24 h: disk returns to the team version, bytes stay in the registry. `local_only` (secret-bearing) records are never auto-parked. |
| S7 | Relaxed adopt: the branch follows a save when the saved content is fully applied on disk, even if extra live/local edits exist on top (§12). |
| S8 | Quarantined paths (§16) never sync live and their bytes never reach any remote ref through cowork; they move only with ordinary git commits. *(Confirmed by the user 2026-10-02, §27.)* |

---

## 2. Actors and identities

| Term | Definition |
|---|---|
| **peer** | One clone/worktree participating in live sync on one PC, served by one daemon. `peer_id` = 128-bit random, stored at `<gitdir>/cowork/peer`. |
| **epoch** | Random id regenerated whenever a peer's local state is (re)initialised. |
| **seq** | Monotonic per `(peer_id, epoch)`, persisted before every push. |
| **op id** | `<peer_id>/<epoch>/<seq>`. |
| **seat** | One Claude Code session *process* on a peer. `seat_key` = SHA-256 of `CLAUDE_CODE_MESSAGING_SOCKET`, else the claude pid. `seat_id` = random, minted by the MCP server at `hello`, or by the daemon when no MCP `hello` arrives within 3 s (NO_MCP); the first bound id is kept for the process life. `/clear`, `/compact`, `/resume` inside the same process keep the seat. |
| **agent** | `agent_id` of a subagent inside a seat (hook input), or `main`. |
| **holder** | `(peer_id, seat_id, agent_id)` that owns a claim. |
| **human** | Edits on a peer not attributable to any seat's tool call. One pseudo-seat `human` per peer. |
| **display name** | From `user.json`; display only, never an input to a decision. |

---

## 3. Core state terms

| Term | Definition |
|---|---|
| **board** | The authority ref `refs/cowork/<enc(b)>/board`: a fast-forward-only chain of board commits. |
| **board commit** | Parents `[previous board commit, live code commit]` (genesis: `[live code commit]` only). Tree: `ops.jsonl` (only this commit's ops), `protocol.json` = `{proto: 1, regionSpec, budget: 6, G_s: 10, S_s: 3}`, `checkpoint/state.json` (full fold, RFC 8785 canonical JSON, at first-parent heights divisible by 256, otherwise carried), `held/<hold_id>/<stage>/<repo path>` (blob entries of unresolved displaced versions; stage ∈ `h0, h1, s1, s2, s3`; no entry for an ABSENT side). |
| **live code commit** | A commit whose tree is the shared working tree. Ordinary live commits have one parent (the previous live code commit). A **base-move** commit has two parents `[previous live code commit, X]` where X is a branch commit, and carries `Cowork-Base: <X>`. |
| `live_code(board)` | The LAST parent of a board commit. "Live tip" always means `live_code(board tip)`, never the mirror ref. |
| **TIP** | `live_code(fetched board tip)`. |
| **LA_C / LA_B** | Last applied live code commit / board commit on this peer. LA_C = the newest live code commit such that every path of its tree is on disk or is a *pending* path whose `A[p]` is retained (listed in the engine's `meta.pending`; carried by an INCOMING record once HLD-54's 60 s transient window (§9, §20) has passed, or at once for a not-applicable path, §21 INV-GROUP); advanced at the end of every completed apply. |
| **height** `ht(X)` | Genesis board commit = 0, +1 per first parent. **Board position** = `(height, ops.jsonl line index)`; "earlier/later" always means board position. |
| **live set / ghost / R** | Live set = peers with an active epoch in the fold. Ghost = live peer with no board commit in the last `K_evict = 200` heights. Ranked set R = live set minus ghosts (governor rank, regionSpec unanimity, per-PC wake share). |
| **teamRegionSpec** | `protocol.json.regionSpec` of the genesis; switched by the fold only when every peer in R announces the same new value in its latest `join`. A peer whose regionSpec differs is in the VERSION publish pause (§8). |
| **live base** `live_base(L)` | X of the newest base-move commit on L's first-parent chain, or the base recorded in the genesis. |
| **Hb / Hr / H_adopt** | Live base of TIP / remote `refs/heads/<b>` / the branch commit this peer's local branch currently points at as far as cowork knows. |
| **EPOCH_BASE** | `live_base(LA_C)` on this peer. Used for `attr.tree` and config reads. Not assumed equal across peers. |
| **A[p]** | Per-path base: the stored-form blob this peer last had from the team for path p. |
| **S_raw** | `write-tree` of the private index before canon; the private index always holds S_raw. |
| **S_disk** | `canon(S_raw)`: the snapshot of the working tree in stored form. |
| **MASK(X)** | X with every held path region, quarantined path, SAVE_ONLY/UNMANAGED path and `local_only` path reset to `A[p]`. |
| **S_pub** | `MASK(S_disk)`. Used for detection and status. |
| **ready pair** | `(A_cap, R)` captured at a CS boundary, where `R = S_disk` at the trigger (not masked); rebased at every apply that changes `A[p]` for its paths: `R[p] := merge-file(A_new, A_cap, R)`, `A_cap := A_new`. |
| **P (publish composition)** | For every ready, unheld publication group: `MASK(R)` on that group's paths; `A[p]` everywhere else. This is the publish-side input. |
| **OUT** | Outgoing tree `merge-tree --write-tree --merge-base=A P TIP`, plus the conflict function's whole-path replacements and concat blobs (03-data). |
| **DISK_EQ(p, X)** | The single disk-versus-blob comparator: refresh the private index entry for p with index context and compare against X under canon. Every "disk equals blob" test in the spec uses it. |
| **write group** | All-or-none apply unit = the applicable paths of one publication group (one CS closure). |
| **pathState(p)** | Gate query answer: `idle | applying | pending(reason) | frozen | incident`. |
| **scope class** | Per-path treatment: `LIVE` (synced), `SAVE_ONLY` (`.gitignore`, custom merge-driver paths, blobs ≥ 50 MiB: local changes are never published live and never enter a save, because save commits `tree(Lk)`, which holds the team's entry; they reach the branch only through an ordinary git commit and push, and reach other peers with the next branch move (base move); incoming branch changes are applied like LIVE. The name is historical: "save" here does not mean `/cowork save`), `UNMANAGED` (never touched: LFS, `cowork-sync=off`/generated attribute, `sync.exclude`, existing 120000/160000 entries, existing tracked paths that fail the syntactic part of SEC-35 `validPath`, which carry not-shared reason `portability`), `QUARANTINED` (§16), `NOT_ADMITTED` (new file not admitted by U10 rules), `LOCAL_ONLY` (secret-like or scanner hit). "Save-only set" = SAVE_ONLY ∪ UNMANAGED. |
| **LIVE_UNSAVED** | `paths(diff(tree(EPOCH_BASE), tree(LA_C)))`. |
| **M_disk** | Tree this peer must write to disk on apply. |
| **stored form** | Blob content after clean filter and EOL normalisation (what git stores). All region line numbers are stored-form 1-based inclusive line rows. |
| **CS (change-set)** | Unit of publication: one seat's edits between two boundaries, or one human edit burst. `cs_id = <seat_id>/<turn-seq>` or `<peer_id>/human/<n>`. |
| **ready tree** | Shorthand for the `R` of a ready pair. Captured at a CS boundary (Stop, StopFailure, SubagentStop, green checkpoint, `cowork_checkpoint`, human quiet/`/cowork done`); published later by the governor as part of P. |
| **publication group** | Transitive path closure of open/ready CSs and held PINs that share paths; the unit of publication and of apply (INV-GROUP). |
| **claim** | A region held by a holder. States: `TENTATIVE` (local; sub-flag `confirmed` once PostToolUse shows the region changed — only confirmed claims are published or block sibling seats) → `HELD` (published, blocking) → released, or `STALE` (non-blocking after presume_absent). `claim_id` = 16 lowercase base32 chars from 80 random bits, stable across re-anchors. |
| **claim view** | HELD non-STALE folded claims + this daemon's confirmed TENTATIVE claims in local order + active go-first grants. The gate and B1 decide against it. |
| **region** | A unit from the region table (symbol, pseudo-symbol, block or whole file) identified by `claim_id` and stored-form line ranges anchored on a live code commit. `<imports>` is a pseudo-region that is never claimed and never blocks. |
| **hold record** | One entry in the hold registry (§9). The only place a displaced or withheld version lives. |
| **request** | A handoff or go-first request. Identity = `(req_id, to_holder.seat)` with `req_id == hold_id` of the PATCH/PIN record carrying the attempted change (one PIN may produce one request per holder seat). |
| **FREEZE** | Branch-loop state with a reason set (§8). |
| **seat wiring / flags** | Wiring (exactly one): `FULL`, `HOOK_ONLY` (no MCP inbox posting), `NO_MCP`, `NO_HOOKS`. Flags (any): `DEGRADED`, `PAUSED`, `PULL_MODE` (over budget). Display precedence: NO_HOOKS > PAUSED > DEGRADED > NO_MCP > HOOK_ONLY > PULL_MODE > FULL. |
| **seat activity** | `MID_TURN | AWAITING_PERMISSION | IDLE | ENDED`. Turn origin: `human | wake` (a turn started by a doorbell; nonce `cws-[0-9a-f]{16}`). |
| **H(x, y)** | `base32c(sha256(x ‖ 0x00 ‖ y))[0:8]` (Crockford alphabet). Conflict id `cid = H(winner op id, loser op id)`, displayed `C<cid>`; non-conflict event cid = `H(event op id, kind)`. Request display id `R` + `base32c(sha256(hold_id))[0:8]`; a collision is refused with `AMBIGUOUS_ID`. |

---

## 4. Refs

`enc(b)`: percent-encode every byte of the branch name outside `[A-Za-z0-9_-]` as `%XX` (uppercase hex). Result ≤ 150 bytes, else refuse the branch (v1).

**Remote**

| Ref | Role |
|---|---|
| `refs/cowork/<enc(b)>/board` | Authority. Fast-forward only. |
| `refs/cowork/<enc(b)>/code` | Mirror. Always set to `live_code(leased board tip)`; lags ≤ 1 publish; never a decision input except as a lease value. |
| `refs/cowork/<enc(b)>/displaced/<oid12>`, `refs/cowork/<enc(b)>/displaced/<peer_id>/v-<k>` | During an incident: a copy of this peer's LA_B (pre-incident chain) at detection (`<oid12>`), and a copy of the observed bad tip before `/cowork recover` overwrites it (`<peer_id>/v-<k>`, recover's own copy, which recover's candidate set excludes; Plan 2 merge, Task 16 ruling, 01-engine §3.7) (≤ 3 per branch in total). |
| `refs/cowork/probe-<peer_id>` | Start-time probe of the active namespace (`refs/heads/cowork/probe-<peer_id>` in the fallback namespace); deleted after the probe. The only remote deletion cowork performs. |
| `refs/cowork-ci/<run_id>/…`, branch `ci/<run_id>/<b>` | Test builds only (real-host CI and soak). Release builds refuse them (lint). |
| `refs/heads/<b>` | The real branch; written only by `save`. |
| Fallback | `refs/heads/cowork/<enc(b)>/{board,code}` only with explicit per-repo opt-in after the probe shows custom refs are refused. |

**Local** (common namespace, never `refs/worktree/*`)

| Ref | Role |
|---|---|
| `refs/cowork-remote/<enc(b)>/{board,code,branch}` | Fetched values. |
| `refs/cowork-local/<enc(b)>/state` | Commit `[LA_C, LA_B]`; tree `{base, snap, journal/, meta}` where `journal/` is a tree (`intent.json`, `t/`, `ready/<base64url(cs_id)>/{R,A}`, `keep/<name>`) so every referenced tree stays reachable under `gc --prune=now`. |
| `refs/cowork-local/<enc(b)>/holds` | Hold registry chain (§9). |
| `refs/cowork-local/<enc(b)>/incident-<n>` | Observed bad tip during an incident. |
| `refs/cowork-local/<enc(b)>/incident-<n>-own` | This peer's own newer first-parent-valid commits kept when a late peer re-anchors onto a team that already built on an earlier recover's tip (they become restart records; `LOST_STATE` is emitted). |

Removed (v2): `refs/cowork-archive/*`, `/cowork end`, `/cowork gc`, `uninstall --remote-refs`.

Fetch refspecs: `+refs/cowork/<enc(b)>/board:refs/cowork-remote/<enc(b)>/board`, `+refs/cowork/<enc(b)>/code:refs/cowork-remote/<enc(b)>/code` (lease value only), `+refs/heads/<b>:refs/cowork-remote/<enc(b)>/branch`.

**One live branch per clone** in v1.

---

## 5. Commit formats and trailers (single set)

**Live code commits and board commits**
- Subject begins with `[skip ci] ***NO_CI***`.
- Trailers: `skip-checks: true`, `Cowork-Proto: 1`, `Cowork-Writer: <peer_id>/<epoch>/<seq>` (seq greater than every op seq in that publish; the code commit and board commit of one publish intent share the value; `presume_absent.last_seq_seen` compares against it), one `Cowork-Seat: <seat_id>|human` per distinct contributing seat or human (code commits), one `Cowork-CS: <cs_id> state=closed|checkpoint seq=<n> origin=prompt|wake|human checks=pass|fail|skipped paths=<n>` per published CS, `Cowork-CS-Paths: <cs_id> <base64url(zlib(NUL-joined sorted paths))>` when n ≤ 256, `Cowork-Base: <X>` on base-move commits.
- Author and committer: `<display name> <peer_id@cowork.invalid>`, set explicitly through `GIT_AUTHOR_*`/`GIT_COMMITTER_*` with timezone `+0000`. Never signed.

**Save commit S**
- No skip markers. Human summary as subject.
- Trailers: `Cowork-Saved-Live: <Lk>`, `Cowork-Symbol: <path>::<label> by <display>` (≤ 300 lines) and `Cowork-Symbol-More: <n>` beyond that. `Co-authored-by:` only for users who opted in (privacy default off).
- Parent: `Hb`. Tree: exactly `tree(Lk)`.

---

## 6. Files

**Per clone** under `git rev-parse --git-path cowork/` (`<gitdir>/cowork/`):

| File | Purpose |
|---|---|
| `live` | Marker written by `/cowork start`, removed by `/cowork stop` or by the plugin-removal shutdown; names the main-worktree realpath. The hook loader checks it before any IPC. |
| `tmp/evidence.jsonl` | HMAC-tagged human-evidence lines written by the hook loader from UserPromptSubmit when no daemon IPC is possible (non-live or paused repo). Untagged evidence is accepted only for `start` and `doctor` before `ipc.key` exists. |
| `paused` | Written only by human `/cowork pause`; removed by `/cowork resume`. |
| `peer` | `peer_id`. |
| `daemon.lock` | `{pid, process start time, plugin version, instance id}`. Advisory; single-instance is enforced by the IPC endpoint bind. |
| `<enc(b)>.index` | Persistent private index (stat-fresh). |
| `status.json` | Health (§14). Atomic temp+rename on every cycle and transition. |
| `tmp/` | `.new/.old` write ring, scratch indexes, `save-<n>/` worktrees, `deny-<id>.bin` pre-records. Never a store. |
| `prov/<enc(b)>.jsonl` | Provenance journal cache (14 days; rebuildable). |
| `cs/<enc(b)>.json` | Open CS table and ready pairs (cache; truth is in the state ref journal). |
| `cs/<enc(b)>.reverts.jsonl` | `{cs, of, t_local_ms, written: {path → oid | ABSENT}}` per `/cowork revert`, plus one more line of the same shape each time a clean HLD-41 rebase carries the D2 mark forward (05-holds Algorithm REV step 8; per path, the newest line of a `cs` that matches the journaled content wins, 05-holds §8 Q18); the local "revert of" label, and, while the revert CS is pending (ready, or named by a non-terminal record), the source from which the D2 shrink-attribution mark is re-derived at start (05-holds §8 Q18; losing it loses the label and falls back to the ordinary shrink guard), 14 days. Never pushed. *(rev 2.5, F10; `written` added at merge; the rebase line added by the owner's D2 decision, 2026-10-08)* |
| `empty-hooks/` | Empty, user-only directory used as `core.hooksPath` for every cowork git call. |
| `log/daemon-<n>.jsonl`, `log/security.jsonl` | Rotating logs (10 MB × 5, 14 days). |

**Per user** under `CLAUDE_PLUGIN_DATA`:

| File | Purpose |
|---|---|
| `ipc.key` | 256-bit key, user-only ACL. |
| `user.json` | displayName, language, env passthrough, notification prefs, per-repo-identity flags (`privateConfirmed`, `saveCheckApproved[sha256]`, `wake` overrides). Never secrets. Losing it never loses team data. |
| `repos.json` | Gitdirs where live mode ran (cache). |
| `runtime/<version>/` | Copied `daemon.js`, `worker.js`, grammars (`*.wasm`). |

**Plugin `dist/` (canonical list):** `hook.js`, `core.js`, `daemon.js`, `worker.js`, `mcp.js`, `cli.js`, `grammars/*.wasm`, `i18n/{en,ko,zh-CN,ja,fr,es}.json` (human-facing), `i18n/claude.{en,ko}.json` (Claude-facing), `i18n/codes.json` (message-code registry), `schema/*.json`, `SHA256SUMS`.

**Per repo (team)**: `.cowork/config.json` (§17), read only from `EPOCH_BASE`.

---

## 7. Board ops (single schema)

Every op: `{id: <op id>, type, ...}`. Ops travel in `ops.jsonl` of the board commit that introduces them. **Code content appears on the board only as blob ids produced through the pinned clean path** (private index / `hash-object -w --path=<p>`). Never raw tool input, prompt text or inline patch text. Notes are ≤ 280 chars, only from `cowork_note`, after a local secret scan.

| Type | Fields |
|---|---|
| `join` | `display, plugin_version, plugin_sha, proto, regionSpec, config_fingerprint{filter driver hashes, core.autocrlf, eol attrs hash, git version}, coauthor_optin: false | "<name> <email>"` (re-announced on upgrade) |
| `leave` | — |
| `caps` | probe results `{custom_refs, lease, delete, push_options, two_parent_ok}` |
| `seat_start` / `seat_end` | `seat_id, permission_mode` |
| `claim` | `claim_id, path, anchor (live code commit oid), base_blob, ranges[[lo,hi]] (stored-form, 1-based inclusive), tombstones[{anchor, ranges}], granularity: symbol|block|file, label{kind, qualname, simple, type, disc} (display + group-name rule only), regionSpec, cs_id, holder{peer, seat, agent}, reserved_for_req?` |
| `release` | `claim_ids[], reason: explicit|answer|save|seat_end|stop|reservation_transfer` (the fold may also record the derived reason `superseded` when a new-epoch join retires an old epoch; never written in an op) |
| `request` | `req_id (= hold_id), kind: handoff|go_first, ckind: claim_visible|claim_posthoc|claim_race|human_in_claim|dependency, from{peer, seat, agent}, to_holder{peer, seat}, claim_ids[], path, cs_id, attempt, est_minutes?, note? (≤ 280), origin: claude|human|wake` — **no blob fields**; bytes are in `held/<req_id>/`. Published when the record's offer becomes `offered` (U5); before that the holder sees the `hold` op as a notice. Each re-attempt (`attempt+1`) re-arms the presume-absent timer. |
| `request_status` | `req_id, to_holder.seat, status: asked|queued_until_turn_end|awaiting_human|undeliverable|returned` — `returned` may also be written by the requester (withdrawal, grant lapse) |
| `answer` | `req_id, to_holder.seat, verb: accept|decline|later|release|grant, by: claude|human|daemon, reason_code, note?` — tool `accept` on a go_first request is written as `grant`, on a handoff as `accept`. Human answers: the holder's human via `/cowork release` (writes `answer{verb: release, by: human}`) or via their own Claude; the requester's human via `/cowork resolve <id> --handoff|--park|--discard|--restore`. |
| `note` | `target: req_id | claim_id | null, text (≤ 280, secret-scanned)` — carries `cowork_note` |
| `presume_absent` | `peer, epoch, last_seq_seen` |
| `hold` | `hold_id, rev, prev_rev, kind, residence, state, offer, guards[], paths[], origin, cs_ids[], peer_authors[], local_only` (+ tree entries `held/<hold_id>/…` unless `local_only`; a `local_only` record produces a content-free stub: no `held/` entries and no blob oids) |
| `event` | `cid, kind: K1..K7 | breach | freeze | unfreeze | incident | nonretryable | health, refs, reason_code` — codes and params only, never rendered text; `reason_code` values come from the message-code registry (§19) |
| `save` | `save_commit, saved_live (Lk), chain_base (Hb), released_claim_ids[]` |

**Fold:** deterministic over the board's first-parent chain, commit order then line order. An op whose id is already folded is a no-op. An op invalid against the prior state is a deterministic no-op and its writer is told. Checkpoint every 256 first-parent heights; a joiner replays ≤ 255 commits. A checkpoint that differs from a daemon's own fold triggers one refold from the previous verified checkpoint; if it still differs, that daemon enters the VERSION publish pause with `cause = checkpoint_mismatch` and a P2 alert. Compaction drops only terminal records older than 2 checkpoints from `state.json` and `held/`; history keeps them.

**Ordering:** the only order is board first-parent position, then line order. Wall-clock fields are display only.

---

## 8. FREEZE reasons (single set) and publish pauses

A branch loop has one FREEZE state holding a reason set, persisted in state meta:

| Reason | Set by | Lifted by |
|---|---|---|
| `EPOCH` | HEAD/stash/marker change not explained by cowork (human git operation) | the HEAD decision table (lifecycle) or `/cowork resume` |
| `MASS` | Mass-change breaker | `/cowork resume` |
| `PAUSED` | `/cowork pause` | `/cowork resume` |
| `INCIDENT` | Rewrite incident (non-FF board or code pointer) | `/cowork recover` on one peer; every other peer clears it when its first-parent check passes again; a late peer whose newer commits are not on the restored chain runs `/cowork recover` in re-anchor mode (its commits are kept under `incident-<n>-own` and as restart records, never pushed over the team's tip) |
| `CONFIG` | A start-time invariant changed while live: `url`, `identity`, `filter`, `public` (detail in state meta) | `/cowork resume` after doctor passes; a legitimately changed URL is re-pinned only by `/cowork stop` + `/cowork start`. `CONFIG(url|public)` also forbids every network call on the branch. |
| `NOHOOKS` | A seat is live in this checkout but its hooks provably do not fire, or managed policy disables hooks/plugins | hooks observed again / policy lifted |

While any reason is set: no daemon-initiated working-tree write, no code publish, no adopt, no save from this peer; new claims stay TENTATIVE; the gate still enforces foreign claims from the last fold. Allowed: fetch and fold, base moves (R3), human `/cowork resolve`, board-only pushes of freeze/health events, answer-class ops (`answer`, `request_status`), release-class ops (`release`, `seat_end`, `leave`) and hold mirrors. `INCIDENT` forbids every push on the branch except (a) the one governed, `ABSENT`-leased copy of `LA_B` to `displaced/<oid12>` made at detection (01-engine ENG-21; §4; ≤ 3 displaced refs per branch, §20) and (b) the pushes of the human-typed `/cowork recover`; `CONFIG(url|public)` forbids every network call.

**Publish pauses (not FREEZE; applying continues):**
- `OFFLINE` (no successful fetch for > 30 s) and `AUTH` (credential failure) behave identically; the AUTH label is explanation only.
- `NONRETRYABLE` (host rejected a push for policy/size): the whole rejected publish is PINned; publishing stops until human `/cowork resume`.
- `VERSION`: board `proto` differs from ours → zero pushes of any kind; only `regionSpec` differs from `teamRegionSpec` → code pushes paused, board-only ops allowed (`join`/`leave`/`seat_end`/`release`/`request_status`/`answer` with decline|later|release/`hold`), and every peer gates claims written under a different regionSpec as whole-file. Message: "update cowork-sync".

**Lost state** (local state ref unusable) is not a FREEZE: the daemon rebuilds conservatively (restart records) and emits `LOST_STATE`.

Removed: `DISK` freeze (the per-apply free-space check covers it), `SNAPSHOT` hold kind.

---

## 9. Hold registry (single store)

Every reason this PC's disk or outgoing tree differs from (TIP + its own ready, unblocked CSs) is one record in `refs/cowork-local/<enc(b)>/holds`, except path-class masks (quarantine set §16, the save-only set) and transient exclusions younger than 60 s (local monotonic): an append-only commit chain; each transition is a commit whose first parent is the previous registry commit, tree `records/<id>.json` + referenced blobs; updated only by CAS `update-ref` with `core.logAllRefUpdates=always --create-reflog`; re-attached before the first publish after start. Every non-`local_only` record is mirrored to the board (`hold` op + `held/` blobs).

```
{ id: ULID, rev: int, owner: peer_id,
  kind: PATCH | PIN | INCOMING,
  residence: ON_DISK | OFF_DISK,
  state: ACTIVE | CONFLICTED | PARKED | SUBSUMED | GONE | RESOLVED_PUBLISH | RESOLVED_DISCARD,
  offer: none | pending_leftover | offered | accepted | returned,
  declines: int, displaced_by: op id | null,
  paths: [repo-relative POSIX NFC, sorted],
  blobs: { h0: {path: oid|ABSENT}, h1: {path: oid|ABSENT} } | { s1, s2, s3: {path: oid|ABSENT} },
  guards: [{name: "<name>[:<arg>]", class: PREDICATE | DECISION, owner}],
  origin: human | <seat_id>[/<agent_id>] | daemon | wake,
  cs_ids: [], peer_authors: [], local_only: bool, age_anchor, proto: 1 }
```

- **Only LIVE paths enter a mirrored record.** A record created from a CS (K2, K3, K6, K7, B1 PIN, `wake-scope`) includes only the CS's paths whose scope class is LIVE; non-LIVE paths stay on disk under their path-class mask. If a record would have to include a non-LIVE path, it is `local_only` (content-free board stub).
- Valid residence × state: `ON_DISK` with `ACTIVE | CONFLICTED`; `OFF_DISK` with `PARKED | CONFLICTED`; terminal `SUBSUMED | GONE | RESOLVED_PUBLISH | RESOLVED_DISCARD` (no residence).
- S6 auto-park applies to every `ON_DISK` record with `local_only=false`, including records of restore markers; restore markers never reach any remote ref (neither live blobs nor `held/` blobs).
- A record whose hold op the fold deterministically rejects stays unmirrored with status `HOLD_MIRROR_REJECTED` (visible, INV-NOSILENT); its bytes stay in the local registry.
- `h1` is optional for records guarded by `filter-failure` (bytes cannot be hashed safely and stay on disk).
- `displaced_by`: the causing op id — the incoming `Cowork-Writer` op for K4/breach, the `leave` op for a stop-time PARK, the `branch_escape` event op; `null` for `--park`, S6 auto-park, SHADOW and PIN records.
- Guard names form a closed table owned by 05-holds (e.g. `conflict`, `claim-breach`, `eol-bom`, `eol-form`, `portability`, `collision`, `unmaterializable`, `generated?`, `filter-failure`, `markers`, `secret-scan`, `quarantine-review`, `base-move`, `restart`, `join`, `phantom`, `host-reject`, `local-only-conflict`, `wake-scope` (DECISION, owner local human: writes in a wake turn outside the wake work set)).

- **PATCH**: a displaced or withheld version of specific paths (SHADOW of a denied edit, later side of a text conflict, revert-tainted human hunk).
- **PIN**: a whole CS withheld from publication (claim race, human-in-claim, dependency failure).
- **INCOMING**: an incoming change that could not be applied yet (lock, fence, deferral).
- Kinds vs states are distinct: `CONFLICTED` is a state, `base-move` and `restart` are guards.
- Forbidden (CI lint fails the build): any other holding store; claim state exempting a held change; per-hunk withdrawal, `-U0` subtraction or symbol splicing of an outgoing blob, working file or saved tree (exceptions: `taintOnlyH1()`, whose output is only a record's `h1`; and `revertInverse()` (Algorithm REV, 05), whose `merge-file --ours` output is only (a) the target of a human-confirmed `writeLocalGroup` (verb mode) or (b) rendered, never written, as the undo view (view mode) *(rev 2.5, F10)*); PostToolUse hunk restores; time-capped WIP publishing; `git apply`/checkout/`read-tree -u` of a stored hold (`merge-file --theirs` is allowed only inside RESTORE).

---

## 10. Conflict taxonomy (closed set)

| Kind | Detected by | Byte-preserving record | Recipients |
|---|---|---|---|
| **K1 claim_visible** | causer's daemon, PreToolUse gate: predicted region intersects a foreign HELD claim, or a confirmed TENTATIVE claim of another seat on the same daemon earlier in local order | G1 deny + PATCH (SHADOW, `offer=pending_leftover`) | causer seat (T1); holder gets a notice at the next window and the request when the leftover is offered |
| **K2 claim_posthoc** | causer's daemon at PostToolUse or Bash/PowerShell transaction close: a Claude change inside a foreign claim already folded at PreToolUse | PIN of the whole CS; **no disk write** ("kept on this PC, not shared") | causer seat (PostToolUse block) |
| **K3 claim_race** | later publisher's daemon in publish gate B1 (also after every CAS re-merge): CS hunk inside a claim earlier in board order not folded at edit time | PIN of the whole CS | causer seat (canonical warning) + holder (one notice) |
| **K4 text** | later publisher's daemon: `merge-tree` rc 1 on a path not resolved by insertion-concat | TIP version on disk and in OUT; local version → PATCH (CONFLICTED) | later publisher's seat/human |
| **K5 breach** | holder's daemon at apply: a non-holder change inside a symbol this seat claimed earlier | none needed (bytes are in the live chain); event only | holder seat (notice) |
| **K6 human_in_claim** | human's own daemon at publish: human-CS hunk inside a foreign claim | PIN | local human (OS notification + status) + holder notice |
| **K7 dependency** | later publisher's daemon: T0 failure on its merged OUT (caller arity, import name, new ERROR/MISSING parse nodes relative to TIP, label count above max(TIP, local), > 50 % shrink) | PIN of the CS | causer seat |

Exactly one daemon creates the canonical event for a situation (`cid = H(winner op id, loser op id)`); bystanders only render the folded board. Adding a kind requires a protocol bump. Removed (v2): override, fork detector, wait-for cycle detection, K2 disk restore.

---

## 11. Gate outcomes (PreToolUse on `Edit|Write|MultiEdit|NotebookEdit`)

| Outcome | Condition | Output |
|---|---|---|
| **G1 deny** | daemon answers: conflict (K1), held-region overlap (±1 line), SUSPECT not confirmed in 5 s, `PATH_BUSY` (the verifying writer's write group on the target path did not finish within 250 ms, so no INFLIGHT lease can be granted), or any other ordered gate check of 06-claude (moved edit, `<gitdir>/**` target, non-portable path, symlink, wake-turn scope, version restart, Claude Code too old) | exit 2, stderr reason (template, ≤ caps §19) |
| **G2 pass** | daemon answers: no conflict | exit 0, empty stdout or `{hookSpecificOutput:{hookEventName, additionalContext}}` |
| **G3 pass, degraded** | daemon answers but remote unreachable/auth expired | exit 0 + additionalContext stating claims cannot be confirmed; edits stay local until checked at publish (gate B1 is the hard boundary) |
| **G4 deny, daemon down** | loader cannot get an answer within its deadline (daemon not running, IPC refused, crash) and the repo is live and not paused (S3) | exit 2: "cowork-sync is not running on this PC, so edits in this live repo are paused. It restarts automatically; if not, the user can run /cowork doctor or /cowork pause." |

The gate never emits `permissionDecision: "allow"` and never `"ask"`. **The hook script maps every internal failure (exception, missing module, bad JSON) to exit 2** (fail closed). The only fail-open cases are host-level ones cowork cannot control (Node missing on PATH, host hook timeout). They are detected at SessionStart, by Pre/Post pairing and by doctor: one unmatched edit-class Pre/Post pair marks the seat `DEGRADED` (seat-scoped); ≥ 3 unmatched within 10 min, or provably missing hooks, set `FREEZE(NOHOOKS)` (§8). The **publish gate B1 in the daemon is the hard safety boundary**: nothing inside a foreign claim earlier in board order is ever published, regardless of what the PreToolUse gate did.

---

## 12. Save and adopt (summary; full rules in lifecycle)

- **Save** commits `tree(Lk)` of an existing live commit `Lk` on TIP's first-parent chain whose live base equals `Hb == Hr`; never a spliced or synthesized tree. Then `Ls = commit-tree tree(TIP) -p TIP -p S` with `Cowork-Base: S`. Pushes are leased fast-forwards. Optional `checks.save` runs in a throwaway worktree on candidates (≤ 20; 300 s each by default, 15 min total).
- **Adopt (S7, relaxed):** after `live_base(LA_C)` moves to X, move the local branch from `H_adopt` to X automatically when ALL hold: symbolic HEAD is `refs/heads/<b>` and `HEAD == H_adopt`; `H_adopt` is an ancestor of X; no git operation marker; `.git/index.lock` can be created exclusively; for every p in `diff(H_adopt, X)`: the user's index entry equals `H_adopt[p]` (nothing staged) and p is not INCOMING/deferred; and LA_C is at or after the base-move commit that introduced X (all saved content applied). Action: update only those index entries to `X[p]`, update `refs/heads/<b>` to X, **never touch working-tree files**. `git status` then shows exactly the edits made on top of the save. Otherwise do nothing and show `ADOPT_BLOCKED(paths, reasons)`. The `.git/index.lock` that adopt itself created (identified by the journaled content hash) is the only lock cowork may remove.

---

## 13. Hooks (registration)

Every handler: `{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/dist/hook.js","<Event>"],"timeout":10}` (SessionEnd `timeout: 2`).

| Event | Matcher |
|---|---|
| SessionStart | `startup|resume|clear|compact|fork` |
| UserPromptSubmit | — |
| UserPromptExpansion | `cowork|cowork-sync:cowork` (pause/resume only) |
| PreToolUse | `^(Edit|Write|MultiEdit|NotebookEdit)$`; `^(Bash|PowerShell|Monitor)$`; `^(Agent|EnterWorktree)$` |
| PostToolUse, PostToolUseFailure | `.*` |
| PostToolBatch, Stop, StopFailure, SubagentStart, SubagentStop, SessionEnd | — |
| PermissionDenied | `.*` (closes fences/transactions of denied calls) |
| Notification | `idle_prompt|permission_prompt` |

**Loader protocol:** one authenticated `hook{…payload}` request → optionally one `extend{deadline_ms}` frame (SUSPECT path only, total ≤ 7 s) → reply `{batch_id, decision, text, system?, events[], cursor}` → after flushing stdout the loader sends `printed{batch_id}` on the same connection, then exits. MCP ↔ daemon frames: `hello`, `heartbeat` (15 s), `seat_end` (stdin EOF), `ring{event_ids, text, nonce}`, `ring_result{nonce, accepted|held|refused|timeout}`. Non-live repo fast path: no IPC (marker absent → exit 0 in ≤ 45 ms p95). Paused repo: no IPC; on SessionStart and UserPromptSubmit the loader prints one line of additionalContext "cowork-sync is paused for this repo by the user; edits are not coordinated."

---

## 14. status.json (single schema)

```
{ v: 1,
  state: "ok" | "degraded" | "offline" | "frozen" | "incident" | "paused" | "refused" | "down",
  freeze_reasons: [EPOCH|MASS|PAUSED|INCIDENT|CONFIG|NOHOOKS],
  publish_pause: null | "OFFLINE"|"AUTH"|"NONRETRYABLE"|"VERSION",
  branch, peer_id, plugin_version,
  heartbeat_mono_ms, loop_period_ms,
  last_fetch_age_ms, last_push_age_ms,
  pending: {cs_ready, cs_open, holds_active, holds_local_only, incoming, not_converged:[path]},
  claims_held, requests_in, requests_out,
  adopt: {state: "current"|"blocked", reasons:[]},
  message_code, message_params }
```

A heartbeat older than 3 loop periods means `down`. Readers: hook loader (no IPC), statusline helper (v2), `/cowork status`, doctor.

---

## 15. Claude-facing surfaces

**MCP tools** (per-session stdio server; the only model-invocable surface; schema total ≤ 3,000 chars in a live repo, one tool ≤ 400 chars otherwise). Every description says: "files a record on the shared cowork board; this is not a message to another session."

| Tool | Signature |
|---|---|
| `cowork_status` | `()` |
| `cowork_show` | `(id)` — id: a cowork id, or a repo-relative path or glob, or a list of ≤ 20 (path view, F05) *(rev 2.5, F05)*; signature otherwise unchanged; the tool description adds "a change-set id of this PC adds an undo diff" (undo view of Algorithm REV, F10), measured with F05's path clause inside the ≤ 3,000-char schema total *(rev 2.5, F10)* |
| `cowork_request` | `(rid, mode: "go_first" | "handoff", est_minutes?, note? ≤ 280)` — "hand off" (U6) is `mode: "handoff"`; there is no separate handoff tool |
| `cowork_respond` | `(rid, verb: "accept" | "decline" | "later" | "release", note? ≤ 280)` |
| `cowork_note` | `(text ≤ 280)` |
| `cowork_release` | `(claim_id | "all")` |
| `cowork_checkpoint` | `()` — declares the seat's tree coherent; captures a ready tree |
| `cowork_resolve` | `(id, "restore")` |

**Slash verbs** (`/cowork <verb>`, all `disable-model-invocation: true`, executed via `!` preprocessing of `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <verb> $ARGUMENTS`; human evidence via UserPromptSubmit within 60 s):

Read-only: `status`, `queue`, `show <id|path|glob>…` *(rev 2.5, F05)* (`show <cs_id>|last --undo`: the undo view of a change-set of this PC *(rev 2.5, F10)*), `doctor`, `log`. Acting: `start`, `stop`, `pause`, `resume`, `save "<summary>"`, `done`, `resolve <id> --publish|--discard|--park|--restore|--handoff`, `review <id> --accept`, `revert <cs_id>|last` *(rev 2.5, F10)*, `release <claim_id>|--all`, `recover`, `uninstall [--purge]`. Every read-only verb supports `--json`. Exit 0 success, 1 refusal (reason code + one-line next command), 2 internal error.

- `start` flags: `--publish=all|none|<paths>`, `--remote <name>`, `--name <display>`, `--lang <code>`, `--coauthor=on`, `--private-confirmed`, `--wake=off`, `--wake-turn-edits=deny`, `--allow-cloud-folder`, `--human <1-480 min>`, `--fresh` (only after the remote board was deleted by hand; deletes only the local state ref, human-confirmed; proposed default pending user sign-off, §23). The preview id digests the flag values.
- `save` flags: `--sign`, `--approve-check=<sha8>` (records the full SHA-256 in `user.json.saveCheckApproved`), `--confirm=<id>`.
- Preview/confirm (6-hex digest of the exact oids/paths/flags shown, `--confirm=<id>`; stale ids refused with a fresh preview) is required for `save`, `recover`, `start --publish` with pre-existing local work, `start --fresh`, `stop --discard-holds`, `uninstall --purge --discard-holds`, `review <id> --accept` (digest of record rev, team blob and disk blob; the write uses the digested disk blob as `expectedCleanBlob`), and `revert` (digest of the target, its commit oids and every path's disk and result blob, and the kept and skipped lists, FEAT-F10) *(rev 2.5, F10)*.
- Every human acting verb renews a 60-min human lease on the daemon.

Removed (v2): `override`, `adopt`, `end`, `gc`, `eol`, `protocol`, `blame`, `where`, `holds`, statusline chaining, `undo` (own change-sets use `revert`; a teammate's change is F11) *(rev 2.5, F10)*.

Rev 2.5 additions that are not applied in place above (read-only `status --flow`, `since` and `wrap`, with their flags): §29.4.

---

## 16. Quarantine set (single list)

`.claude/**`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, the configured `core.hooksPath` directory, `.husky/**`, `.githooks/**`, `.gitattributes`, `.gitmodules`, `.lfsconfig`, `.cowork/**`, `.github/workflows/**`, `.gitlab-ci.yml`, `azure-pipelines*.yml`, `bitbucket-pipelines.yml`, `.vscode/{settings,tasks,launch}.json`, `.devcontainer/**`, `.envrc`, and every new `120000` (symlink) or `160000` (submodule) entry.

These are carried through MASK (`S_pub[p] := A[p]`), never published live, and incoming changes to them (only via a branch move) are written to disk only after the local human's `/cowork review <id> --accept`. Status reason: `quarantine: commit with git`.

**Default secret-like new-file patterns (U10):** `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `*.keystore`, `*credentials*`, `secrets.*`, `*.kdbx`, `.npmrc`, `.pypirc`, `.netrc`, `*.tfstate*`, `appsettings.*.json`, `local.settings.json`.

**Content scan** of every new blob, note and log line (`scanSecrets`, 09-security): private-key headers (`-----BEGIN … PRIVATE KEY-----`), cloud key prefixes (`AKIA`/`ASIA` + 16 base32, `AIza` + 35), GitHub tokens (`gh[pousr]_`, `github_pat_`), Slack tokens (`xox[abpr]-`), the team's `secretPatterns`, and high-entropy assignments (value ≥ 20 chars with Shannon entropy ≥ 4.0 bits/char assigned to a key matching `(?i)(secret|token|password|passwd|api[_-]?key|sig)`). A hit makes the path `LOCAL_ONLY` with a `secret-scan` DECISION guard owned by the local human.

---

## 17. Configuration

**Team:** `.cowork/config.json` at `EPOCH_BASE` (quarantined; changes only via git commit). UTF-8 JSON, no BOM, validated against `dist/schema/config.v1.json`:

```
{ "schema": "cowork-config/1",
  "language": "en|ko|zh-CN|ja|fr|es",
  "sync": { "include": [glob], "exclude": [glob], "allowSecretLike": [path], "maxNewFileBytes": ≤1048576 },
  "merge": { "insertionMerge": [glob] },          // default: CHANGELOG*, HISTORY*, NEWS*, *.md, *.txt
  "checks": { "checkpoint": [command prefix], "save": "<command>", "saveTimeoutSec": ≤1800 },
  "secretPatterns": [regex ≤ 200 chars],
  "host": { "fallbackNamespace": bool } }
```

Unknown keys: doctor WARN, ignored. Invalid config at a new EPOCH_BASE: keep last valid, save refuses until fixed. `checks.save` requires one-time human approval per SHA-256 of the command string.

**Per user:** `CLAUDE_PLUGIN_DATA/user.json`. Language precedence for human-facing text: `user.json` → team config → OS locale → `en` (the dependency-free hook loader, which cannot read team config, uses `user.json` → OS locale → `en` for its few embedded texts). Claude-facing language `L_c` = the human language if `en` or `ko`, else `en`. Keys: `notifications.os` (default true), `wake.enabled` (default true), `wake.maxPerSeatPerHour` (default 4), `wake.turnEdits` (default `allow`, S5).

---

## 18. Git runner (single spec)

Every git process goes through `runGit(args, {class: local|network|attr|refupdate})`; a CI lint forbids any other git spawn. Always:

`-c core.hooksPath=<gitdir>/cowork/empty-hooks` · `-c core.fsmonitor=<true if git builtin fsmonitor is supported and was chosen by data-handling, else false; never a hook path>` · `-c filter.<d>.required=true` for every discovered driver and `filter.lfs` · `-c attr.tree=<EPOCH_BASE>` on every attribute-reading command (add, hash-object, read-tree, merge-tree, cat-file --filters, checkout-index) · `-c core.quotepath=off` with `-z`/`--porcelain` parsing · `-c commit.gpgSign=false -c tag.gpgSign=false` (live/board commits) · `-c gc.auto=0 -c maintenance.auto=false` · `-c fetch.fsckObjects=true -c transfer.fsckObjects=true` · `-c protocol.ext.allow=never` · `-c core.askPass=` · `-c core.longpaths=true` (Windows) · `-c core.logAllRefUpdates=always` and `-c core.fsync=committed,reference,index -c core.fsyncMethod=batch` on ref/registry/state/index writes.

Also: `-c submodule.recurse=false`; `--no-ext-diff --no-textconv` on every diff-family command; on every `merge-tree`/`merge-file`: `-c merge.renormalize=false -c merge.renames=true -c merge.directoryRenames=false` (MERGE_FLAGS), never `-X` options.

Environment (DAEMON_ENV, fixed at spawn from an allowlist): `LC_ALL=C`, `LANGUAGE=`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `SSH_ASKPASS_REQUIRE=never`, `GIT_OPTIONAL_LOCKS=0`, explicit `GIT_AUTHOR_*`/`GIT_COMMITTER_*` for live and board commits; stdin ignored. Test builds may add `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` from the virtual clock through the GitRunner port; release builds may not (lint). Network class adds `-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10`, `fetch --no-write-fetch-head --no-auto-maintenance --no-tags`, and appends ` -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3` to the user's effective ssh command.

Watchdogs (process-tree kill): fetch 45 s, push 90 s, read/hash commands (add, cat-file --filters, hash-object) 120 s. Ref-updating plumbing (update-ref, update-index, commit-tree, read-tree into a private index) is never killed. Results are classified by exit code and structured output. Message text may only select a human explanation or make handling stricter (for example `local_only` on a push-protection rejection); it never causes a retry, a publish or a lift. Remote URL: never assume `origin`; resolve `branch.<b>.pushRemote`/`remote.pushDefault`/`branch.<b>.remote`, pin the resolved URL at start, refuse if any `url.*.insteadOf`/`pushInsteadOf` rewrites it (re-checked on config change and every 60 s). Repo identity = sorted root oids of fetched `refs/heads/<b>`.

Floors: **git ≥ 2.43**, **Node ≥ 20**, **Claude Code ≥ 2.1.270**.

---

## 19. Text caps (single table, every language)

| Carrier | Cap (chars) |
|---|---|
| T1 first deny (K1), worst case with ≤ 1 optional clause | 1,050 |
| Other deny / withhold reasons (incl. T1R repeat form ≤ 300); PreToolUse G2/G3 additionalContext notes | 800 |
| PostToolUse: one coordination event (a PostToolUse `block` reason uses this row) + attribution; the 600-char attribution slot carries `ATTRIBUTION` first and then, when both fit, `CLAIM_AHEAD` or `CLAIM_AHEAD_ENDED` (F05) *(rev 2.5, F05)* | 1,000 + 600 |
| UserPromptSubmit digest delta (only when changed) | 1,500 |
| Stop block (≤ 1 per turn, ≤ 1 per (request identity, attempt) ever) | 1,200 |
| SessionStart / SubagentStart (rules ≤ 1,000 + digest ≤ 1,500) | 2,500 |
| Doorbell (inbox message) | 1,500 |
| Teammate note | 280 |
| MCP tool result text (except `cowork_show` ≤ 8,000) | 400 |
| Placeholders: names 20 rendered / 64 raw, label 80, path 80, `{sym}` = `path::label` 80 total (middle ellipsis keeping the label) | — |
| Human-facing: OS notification title 40 / body 120; systemMessage 1,050; slash-mode CLI output 4,000 | — |

`sanitize()` truncates placeholders, never whole rendered templates. All Claude-facing carriers stay under the host's 2,000-char preview. Caps apply in every shipped language: human-facing text ships in 6 languages, Claude-facing templates in `en` and `ko` only (others fall back to `en`, §17 `L_c`).

**Message codes:** one registry, `dist/i18n/codes.json`; every code matches `^[A-Z][A-Z0-9_]{2,47}$` and is used verbatim in `status.json.message_code`, board `reason_code`, CLI refusals and template lookup. Chapters define codes in their own sections; the registry is the union and a CI check fails on a code without templates in every required language. Template owner for Claude-facing text: 07-coordination (one RULES text; the word "violation" never appears). Every engine event (`FROZEN`, `UNFROZEN`, `INCIDENT`, `NONRETRYABLE`, `OFFLINE`, `ONLINE`, `LOST_STATE`, `PHANTOM`, `DEFERRED`, `ADOPT_BLOCKED`, `BASE_MOVE_CONFLICT`, `SAVE_REPORT`, `VERSION_PAUSED`, `NOT_CONVERGED`) and every Claude-facing code defined by any chapter (01–10) has a template in 07-coordination.

---

## 20. Numbers (single source)

| Parameter | Value | Basis |
|---|---|---|
| Loop period | 2.5 s active (any local seat active or work pending), 10 s idle | ≈ 11 % of GitHub's 15 git reads/s/repo for 4 peers |
| Governor | B = 6 attempts/min team-wide; G = 10 s; S = 3 s; LRU rank by first-parent height of each peer's latest board commit; per-peer cap 6 per 60 s Δmono; **sliding team guard: no attempt starts while this peer has observed ≥ 6 landed board commits in the last 60 s Δmono** (keeps U3 per 60 s, not only on average); host throttling doubles G up to 60 s | U3; MODEL p50 44 s / p95 47 s with 4 busy peers, p50 9 s light load; spike 01 |
| Worst normal publish wait | G + (N−1)·S = 19 s for 4 peers (+1 cycle per collision; ≈ 40 s full contention) | MODEL |
| Snapshot quiet period | dirty path hashed only when mtime ≥ 300 ms old | VERIFIED partial-write test |
| Deletion confirmation | missing ≥ 1 s across two reads, or hook-attributed | VERIFIED atomic-save window |
| Shrink guard | > 50 % shrink or to 0 bytes needs 2 stable snapshots + attribution | VERIFIED torn snapshot 5/416 |
| Human CS close | 20 s quiet on all its paths, or `/cowork done` | S1 |
| Seat CS fallback close | 10 min without a hook from the seat | — |
| Unpublished-CS nudge | once per CS after 300 s | — |
| Apply coalescing | ≤ 1 apply per 10 s per worktree; ≤ 1 per 2 min into files fully read by a mid-turn seat | VERIFIED dev-server restart storm |
| Free space before apply | ≥ 2 × bytes to write + 256 MB | — |
| Writer | ≤ 3 re-merge retries per path, then defer (INCOMING); `.old` kept ≥ 2 s; gate waits ≤ 250 ms for an in-flight write group | — |
| Mass-change breaker | unobserved delta > max(10 files, 2 % of tracked files), or deletion of a file with peer-provenance lines | REASONED; measure before GA |
| index.lock | loop only fetches while present; one notice after 30 s same mtime; never deleted | — |
| Offline | no successful fetch for > 30 s; backoff 30 s doubling to 5 min | — |
| Holder self-guard | own last fetch/push older than 60 s by max(Δwall, Δmono), or suspend gap > 5 s → own claims SUSPECT; gate waits ≤ 5 s for a fresh fetch, else G1 | — |
| Request acknowledgment | holder daemon publishes `request_status` at its next window; requester shows "not responding" after 120 s | — |
| Presume absent | **30 min** Δmono after the requester observed its request (attempt) folded, with no op from the holder's (peer, epoch); one automatic re-attempt 30 min after an acknowledgment without answer; a holder that granted go-first may presume the grantee's (peer, epoch) absent 30 min after folding the grant with no op from it, which ends the grant | S4 |
| ON_DISK hold auto-park (`local_only=false`) | **24 h** | S6 |
| Hold escalation | revert-tainted record: board event at +10 min; INCOMING health stub at 60 s; K6 human-held record offered to the holder at +10 min; group-waiting nudge at 10 min | — |
| Transient exclusion → record | 60 s local monotonic | — |
| MASS breaker window | unobserved paths within any 30 s local-monotonic window | — |
| Ghost exclusion | `K_evict` = 200 first-parent heights | — |
| Request "not responding" display | 120 s Δmono after the requester observed its request folded | — |
| Attended window / cache window | last human-origin prompt ≤ 10 min / prompt-cache TTL 60 min (5 min for API-key, Bedrock, Vertex, Foundry sessions) — used for wording and cost accounting only, never to suppress a doorbell the user enabled (S5) | — |
| Digest reminders | ≤ 1 line per request per 30 min, ≤ 3 per digest; `cowork_status` full result ≤ 1 per 30 s per seat | — |
| Doorbell post timeout | 5 s; anything but explicit success = not delivered | — |
| Region numbers | `D_reanchor` 1,000 lines; `T_predict` 10 ms; caller grep 150 ms total, partial-type grep 100 ms; > 50 hits or stoplist name → note only; binary = NUL in first 8,000 bytes | measured / research |
| Data numbers | new path ≤ 200 UTF-16 units, component ≤ 255 UTF-8 bytes; filter preflight sample 200 paths; filter canary every 10 min; fsmonitor full rescan every 10 min; churn guard 3 snapshots × ≥ 20 % rows; concat marker size max(32, longest run + 1) | — |
| Seat numbers | MCP pairing 3 s; MCP heartbeat 15 s; claude pid check 5 s; NO_HOOKS window 10 s; DEGRADED after 60 s silence mid-turn, cleared by 3 matched pairs; ≥ 3 unmatched Pre/Post in 10 min → NOHOOKS; daemon lease loss: stop syncing at 2 min, exit at 10 min; plugin/key check 30 s; host reminders ≤ 15 and ≤ 20,000 chars per seat-hour; pre-image cap 64 MB; deny pre-record fsync ≤ 5 ms | — |
| Lifecycle numbers | stop/save final sync ≤ 2 governor windows (stop cap 60 s); mid-turn window 60 s; REATTACH index rename retry 5 × 100 ms; save attribution cap 10 s; join base-move wait 60 s; start WARN below 1 GiB free | — |
| Wake (doorbell) caps | per seat ≥ 10 min apart and ≤ 4 per 60 min; per PC ≤ max(2, floor(12 / max(1, \|R ∪ {self}\|))) per 60 min (R = ranked set, §3: live set minus ghosts; this peer always counts itself); coalescing window 10 s | U7, S5 |
| Per seat-hour context budget | ≤ 20,000 injected chars; over budget → PULL_MODE | cost model |
| Request age notification | one OS notification per request per side at 30 min | — |
| Go-first | ≤ 1 open per (cid, requester); ≤ 1 per (requester seat, claim) per 15 min; holder asked ≤ 3 go-first per 60 min (excess → auto `later`) | — |
| Decline escalation | 2 declines of the same (requester, claim, H1) → requester's human | — |
| Hook timeouts | 10 s every hook, SessionEnd 2 s | below host default, above internal deadlines |
| Loader deadlines | 1.5 s (3 s SessionStart); SUSPECT extension ≤ 7 s | — |
| Gate latency | daemon ≤ 15 ms p95; end-to-end ≤ 100 ms p95 on Windows (command-hook process creation ≈ 40 ms, §25 F6); event loop block ≤ 20 ms | VERIFIED 42.8 ms p95 |
| Fences / leases | INFLIGHT backstop 120 s; READ lease 120 s, ≤ 3 renewals, hard cap 300 s; Bash/PowerShell TXN cap 120 s; formatter grace 3 s | — |
| Region mapper | D > 5,000 lines → WHOLE_FILE everywhere; > 200 ms → WHOLE_FILE in local decisions | measured |
| Parse | worker threads only; ≤ 400 ms per parse; cache 300 MB LRU by blob oid | VERIFIED 337–368 ms main-thread parse of 1.3 MB |
| T0 checks | ≤ 0.5 s on a 1.3 MB file | VERIFIED 397 ms |
| Grammarless text files | ≤ 300 lines → whole file; longer → blank-line block | — |
| New-file cap | 1,048,576 bytes; blobs ≥ 50 MiB are save-only | U10; GitHub warns at 50 MiB |
| Save | ≤ 20 candidates; `saveTimeoutSec` default 300, max 1,800; 15 min total; ≤ 3 base-move restarts | — |
| Join replay | ≤ 255 board commits from the nearest checkpoint | — |
| Incidents | ≤ 3 displaced refs per branch | — |
| Board caps | 5,000 folded records, 5 MB tree, 64 KiB and 1,000 ops per `ops.jsonl` | — |
| Lost-state rebuild | ≤ 500 first-parent commits | — |
| Convergence | **K = 20** loops after quiescence, then zero pushes | single bound |
| Logs | 10 MB × 5 files, 14 days | — |
| OS notifications | ≤ 1 per 30 min per reason class | — |
| CI | 200 seeds/OS per PR; nightly 10,000 Linux / 2,000 Windows / 1,000 macOS; ≤ 30 real `claude -p` runs per night | — |
| Soak acceptance | ≤ 6 push attempts in any 60 s window (measured by the harness); publish p95 ≤ 70 s; zero HTTP 429; ≤ 1 **editor** file-save failure per 1,000 editor saves on Windows (caused by the daemon reading files); per-path apply lag p95 ≤ 60 s; hold rate not > 2 × the 4-run median | — |
| Perf gates | idle cycle ≤ 100 ms and ≤ 2 % CPU; hook p95 ≤ 100 ms end to end on Windows (§25 F6); RSS ≤ 500 MB | — |
| Cost acceptance | ≤ 15 % extra input tokens per seat-hour at median context, ≤ 20 % for a 200k-window seat; ≤ 4 doorbells and ≤ 20,000 injected chars per seat-hour; 0 for idle seats unless woken | — |
| Release | ≥ 72 h on the `next` channel with ≥ 1 real team and zero severity-1 incidents (data loss, secret leak, silent stall); soak ≤ 7 days old at the gate; 3 consecutive green nightlies; rollback within 24 h of a severity-1 | — |
| Claims ahead (F05) *(rev 2.5, F05)* | ≤ 3 items per note; 1 note per (seat, agent, claim_id) while the claim stays in the claim view; ≤ 5,000 of the 20,000 injected chars per seat-hour; path view ≤ 20 paths, full result ≤ 1 per 30 s per (seat, path set) unless changed | F05 |
| Revert (F10) *(rev 2.5, F10)* | window = the provenance journal (14 days, HLD-25); ≤ 2,000 paths per revert; ≤ 500 `merge-file` runs per computation (paths unchanged since the CS need none); computation in a daemon worker ≤ 30 s, then `RF_REVERT_TOO_BIG`; preview lists ≤ 50 lines each; slash output ≤ 4,000; `cowork_show` ≤ 8,000; `cs/<enc(b)>.reverts.jsonl` kept 14 days | F10 |

---

## 21. Invariants (single definitions)

| Id | Statement |
|---|---|
| **INV-FF** | Every daemon update of the board and mirror refs is a fast-forward leased on the observed old value; never `--force`/`+`, except human `/cowork recover`. |
| **INV-FIRSTPARENT** | Before any merge, LA_C is on TIP's first-parent chain (and LA_B on the board tip's); a bare `merge-base --is-ancestor` is not sufficient. Violation = REWRITE INCIDENT. |
| **INV-BASE** | Every 3-way merge of local work passes the explicit per-path base A via `--merge-base`; `git merge-base` on cowork refs is forbidden (CI lint). |
| **INV-PUSHED-IS-MERGE** | A pushed tree equals `merge-tree --merge-base=A P TIP` (plus the conflict function's whole-path replacements and concat blobs) where TIP is exactly the lease value; `paths(diff(TIP, pushed)) ⊆ paths(diff(A, P))`. |
| **INV-MASK** | `S_pub = MASK(S_disk)`, P is built only from `MASK(R)`, and no held, quarantined, save-only or local-only path differs from A in S_pub or P. |
| **INV-FENCE** | No hunk inside a foreign claim earlier in board order is ever published (publish gate B1 on P, re-run after every CAS re-merge). |
| **INV-GROUP** | An apply writes all or none of a publication group's *applicable* paths; a deferral defers the whole group. Unmaterialisable, locally colliding and incoming quarantined paths (guard `quarantine-review`) are not applicable and get their own INCOMING records. |
| **INV-NOLOSS** | Every byte any peer ever had in a synced path is in exactly one of: the live chain, the saved branch, a board-mirrored hold record, a `local_only` hold record on its owner's disk, an undisplaced edit still on its author's disk, or a human `RESOLVED_DISCARD` event. A `.old` late write observed within the ring window becomes a hold record at once. Out of scope (documented, doctor warns when detected): a process that keeps a file handle open across the ring window and keeps writing through it (long-lived appenders; such files belong in `.gitignore`). |
| **INV-CONVERGE** | After quiescence every live peer reaches `S_disk == A == tree(live_code(T*))` on every synced path not listed in `not_converged` within K = 20 loops, then makes zero pushes. (Each peer's K loops count from its first successful fetch of T\*, 02-protocol §3.11; Plan 2 merge, R-32.) |
| **INV-CLOCK** | No decision compares wall-clock values across machines. Every timer is a Δ from a local anchor; own staleness uses max(Δwall, Δmono). |
| **INV-OID** | cowork never deletes a remote ref except its own probe ref of the active namespace. |
| **INV-ONE-EVENT** | Each conflict situation produces exactly one canonical event (`cid`), created by the daemon named in §10. |
| **INV-NOSILENT** | Every FREEZE, publish pause, hold, deferral and NOT-CONVERGED path is visible in `status.json` and to the affected seat's Claude at its next hook. |
| **INV-SECRET** | No blob from an unfiltered or failed-filter path, no `local_only` path, no secret-scanner hit, no quarantined path's local bytes (S8) and no restore-marker blob ever reaches a remote ref. |

---

## 22. Deferred to v2 (do not implement; do not reference as v1 behaviour)

| Item | v1 replacement |
|---|---|
| `/cowork override` | wait / go-first request / handoff; 30-min age notification to both humans |
| K2 post-hoc disk restore | record + whole-CS PIN, no disk write |
| Fork detector | standing rules text + dependency bundle |
| Wait-for cycle detection | 30-min age notifications; either side's release/decline breaks it |
| Exact-match base B′ for base-move conflicts | treat as base-move conflict: hold, block save, tell the committer |
| `/cowork end`, `gc`, `--remote-refs`, `refs/cowork-archive` | refs stay; README documents manual `git push --delete` |
| Manual relaxed `/cowork adopt` | automatic relaxed adopt (S7) only |
| Seat adoption across processes | release on seat end; resumed session re-claims on next edit |
| OFFLINE_RECONCILE batching | per-CS warnings with 10 s coalescing |
| SNAPSHOT hold kind | FREEZE reasons |
| FREEZE(DISK) | per-apply free-space check |
| Sub-block claims, rename aliases, file:line attribution from tool_response | whole-unit claims, plain labels |
| Protocol raise / `/cowork protocol` | fixed `proto = 1`; mismatch → VERSION publish pause |
| Statusline chaining | `status.json`, systemMessage on transitions, OS notifications |
| Board rotation (new genesis) | none needed in v1 |
| Multiple live branches per clone | one live branch per clone |
| Notebook cell-level claims | whole-file claims for `.ipynb` |
| Claude-facing templates in zh-CN, ja, fr, es | `en` fallback (`L_c`); human-facing text ships in all 6 languages |
| `stop`/`uninstall --export=<dir>` | `--discard-holds` with preview/confirm is the only override; `local_only` records stay on disk and never block `stop` (`purge` still refuses) |

---

## 23. Revision 2 change log

| Area | Change | Raised by |
|---|---|---|
| §3 | LA_C defined with pending paths; S_raw, MASK, ready pair, P, OUT with conflict replacements, DISK_EQ, write group, pathState, scope classes, LIVE_UNSAVED, height/board position, live set/ghost/R, teamRegionSpec (unanimity), claim `confirmed` sub-flag and `claim_id` format, claim view, `<imports>`, request identity `(req_id, to_holder.seat)`, seat wiring/flags/activity, H() and display ids | 01, 02, 03, 04, 05, 06, 07 |
| §2 | `seat_key`; daemon mints `seat_id` for NO_MCP seats | 06 |
| §3–4 | `held/<hold_id>/<stage>/<repo path>`; displaced refs semantics; probe ref of the active namespace; test ref prefix; state `journal/` is a tree | 01, 02, 05, 11 |
| §5 | Cowork-Writer seq semantics; one Cowork-Seat per contributing seat; explicit author/committer env | 01, 02, 09 |
| §6 | evidence.jsonl; live marker removal by plugin-removal shutdown; canonical `dist/` list | 06, 08, 11 |
| §7 | `note` op; `request.note?`; `ckind: text` dropped; requester may write `request_status: returned`; accept→grant mapping; human answer paths; derived `superseded` release; typed `coauthor_optin`; local_only hold stub; checkpoint mismatch → VERSION pause; protocol.json fields | 02, 05, 06, 07, 08, 10 |
| §8 | answer/release-class ops allowed while frozen; INCIDENT lift on other peers; CONFIG detail and network ban; OFFLINE≡AUTH; NONRETRYABLE PINs the publish; VERSION split (proto vs regionSpec); lost state is not a FREEZE | 01, 02, 04, 09, 11 |
| §9 | path-class and transient exceptions; `rev`, per-path blob maps, `age_anchor`; residence × state; optional h1 for filter-failure; `displaced_by` mapping; closed guard table; `taintOnlyH1` and RESTORE exceptions | 03, 05, 08 |
| §10 | K1 includes sibling seats' confirmed TENTATIVE claims and notice-then-request timing; K7 relative parse/duplicate checks | 04, 07 |
| §11 | G1 includes PATH_BUSY and the ordered checks; DEGRADED vs NOHOOKS split | 06 |
| §12 | adopt may remove only its own index.lock | 08 |
| §13 | `extend` frame, `system` field, MCP frames | 06 |
| §15 | `start`/`save` flags, `--fresh`, extended confirm list, human lease, handoff = `cowork_request(…, "handoff")` | 06, 07, 08, 10, 11 |
| §16 | `*credentials*`, `appsettings.*.json`, `local.settings.json`; concrete scanner detectors | 03, 09 |
| §17 | loader language precedence; `L_c`; `notifications.os` | 06, 10 |
| §18 | submodule/ext-diff/textconv flags; MERGE_FLAGS; DAEMON_ENV; message-text rule; test-build env | 03, 09, 11 |
| §19 | caps for G2/G3 notes, PostToolUse block, `{sym}`, MCP results, human-facing carriers; language split; message-code registry | 06, 07, 10 |
| §20 | escalation, transient, MASS window, K_evict, not-responding, attended/cache windows (never suppress S5 wakes), reminders, region/data/seat/lifecycle numbers, soak/cost/release rows | 02, 03, 04, 05, 06, 07, 08, 11 |
| §21 | INV-PUSHED-IS-MERGE and INV-MASK over P; INV-FENCE on P; INV-GROUP over applicable paths; INV-OID probe of active namespace | 01, 02, 03, 05 |
| §22 | Claude-facing templates beyond en/ko; `--export` | 05, 10 |

**Decided technical defaults recorded here:** conflicted RESTORE writes `cowork:`-labelled conflict markers on the owner's disk with the path masked until they are removed; `.gitignore` is SAVE_ONLY; comment-only insertions directly above a held unit touch it.

**Proposed defaults pending user sign-off** (they ship as the default if unanswered; 07-coordination §8 Q4 and 08-lifecycle §8 Q1 stay open until the owner signs off): go-first grant pauses the holder's own edits to that region until the requester's change lands (T-GRANT_PAUSE; a NEEDS USER SIGN-OFF item carried from the coordination catalog); `/cowork start --fresh` exists with preview/confirm (one explicit, human-confirmed exception to INV-LIF-NOREINIT).

---

## 24. Revision 2.1 change log (owner decisions after review pass 1)

| Area | Decision | Source |
|---|---|---|
| U5 | The holder's Claude presents an offered request to **its human** at the end of the seat's work and answers `accept` only on the human's word in human-origin turns; wake turns follow S5. (The ko-summary had been changed to "Claude is asked"; that misread the user's choice "내 작업 끝나면 물어봄: '…처리할까요?'".) | pass-1 ko-summary fixer, owner |
| S4 | PC-level wording; one automatic re-attempt 30 min after an acknowledgment without answer; a go-first grant ends when the grantee is presumed absent | 02 Q4/issue 9, 07 Q7 |
| S5 | Wake work set; shell writes outside it are PINned with new guard `wake-scope` | 07 Q6 |
| S8 / INV-SECRET | Quarantined bytes and restore markers never reach any remote ref | review critical (06 K2/B1), 05 Q10 |
| §9 | Only LIVE paths enter a mirrored record; S6 applies to marker records; `HOLD_MIRROR_REJECTED` | review critical, 05 Q10, 02 issue 4 |
| §4 / §8 | `incident-<n>-own`; re-anchor mode of `/cowork recover` | 01 Q5 |
| §15 | `review <id> --accept` uses preview/confirm | 09 issue 5 |
| §19 | Stop block ≤ 1 per (request identity, attempt) | 07 issue 14 |
| §20 | Sliding team guard keeps U3 per 60 s; soak gate ≤ 6 in any 60 s; wake share counts self, never divides by zero | glossary issue 4, issue 3 |
| §21 | INV-GROUP: incoming quarantined paths not applicable; INV-NOLOSS: long-lived appenders across the ring window are out of scope (doctor warns) | 01 issues 4, 6 |

**Technical defaults decided by the owner (implementers follow these; chapters must not re-open them):**
1. 03-data D8: before creating a K4 record, if every conflict region has an empty base block and LOCAL's block already occurs as a contiguous row run inside TIP's block, return TIP's entry with no record and no event (prevents self-K4 after a publish-side concat).
2. Rename carry: when TIP renames a path the local side edited, the local edit becomes a K4 PATCH record (no automatic re-keying in v1).
3. K4 TAKE_TIP: the rest of the change-set still publishes (05 INV-HLD-ATOMIC-PUB exception (c)).
4. A CS touching a `generated?` path is PINned until the human answers; the answer `exclude` releases it (03 DAT-39 semantics).
5. Collision verbs: `--publish` = take the team version, `--discard` = keep the local version.
6. `stop` during a regionSpec-only VERSION pause proceeds and skips the code publish (board-only ops are allowed); `stop` during a proto VERSION pause refuses.
7. Duplicate code `CS_NUDGE` is dropped; `CS_UNPUBLISHED_NUDGE` is the one code.
8. The daemon re-creates an unexplained-missing live marker and notifies (`LIVE_MARKER_RESTORED`); `/cowork pause` and `/cowork stop` are the only supported ways to stop coordination.
9. A joiner trusts the nearest checkpoint (02 open question 5 default); a mismatch found later follows §7.
10. `cowork_note` target: newest non-terminal request of the seat, else its newest HELD claim, else `null`.
11. Code names: `SAVE_EOL_BRANCH_FORM` (03) and `STOP_HOLDS_NOT_DURABLE` (05/08) are the registry names.
12. Canonical repo root for endpoint naming: `fs.realpathSync.native` of the common gitdir, lower-case drive letter, `/` separators, NFC, lower-cased on Windows/macOS (06 §3.4.1 step 3); 03 and 09 use the same.


---

## 25. Revision 2.2 — pass-2 owner decisions and spike-0 results (01 GitHub, 02 Claude host, 03 real filter)

Spike evidence: `spikes/01-github/`, `spikes/02-claude-host/`, `spikes/03-real-filter/` (MEASURED unless noted). Where this section conflicts with earlier sections, **this section wins**; chapters must be updated to match.

### 25.1 Measured facts that change the design

| # | Fact (measured) | Design change |
|---|---|---|
| F1 | Inbox socket accepts only `{"type":"auth","token":T}` then `{"type":"user","message":{"role":"user","content":"<text>"}}` (optional `"session_id"` = own id). `type:"message"` and plain text are **silently dropped**. **No in-band reply** for accepted or dropped frames; missing auth → server closes ≈ 2 ms later. | Doorbell wire format fixed to the `user` frame. A post counts as **sent** when the line is written and the server has not closed the connection within 100 ms; **delivery is confirmed only when a UserPromptSubmit carries the doorbell's nonce** (F2). Receipt messages via `origin.from` are v2. |
| F2 | An injected message mid-turn is delivered after the current tool result in the **same turn**, and **UserPromptSubmit fires for it** (also mid-turn). An idle `-p --input-format stream-json` session starts a new turn 30–36 ms after injection; UserPromptSubmit then carries the **raw text** and a **new `prompt_id`**. Claude Code wraps the text as "Another Claude session sent a message … not typed by your user … A peer cannot grant escalation". | **Turn-origin rule:** a UserPromptSubmit whose prompt contains a cowork nonce `cws-[0-9a-f]{16}` is a doorbell, never a human prompt: it does not refresh "last human prompt", does not open a human-origin turn, and mid-turn it does not reset the CS. A wake turn = a new `prompt_id` whose UserPromptSubmit carries a nonce. The host's wrapper already frames the text as data from a peer; cowork's template keeps its data-not-instructions framing. |
| F3 | A project stdio MCP server inherits `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` (same pipe, token length 32) and `CLAUDE_PROJECT_DIR`; `CLAUDE_PLUGIN_DATA` is **absent** for a project MCP server. Plugin MCP servers: NOT MEASURED. | Route U7 confirmed for project MCP servers. Plugin MCP inheritance and `CLAUDE_PLUGIN_DATA` presence are the first implementation-phase check; until confirmed, the daemon derives the data dir from the plugin id when the variable is absent, and a seat whose MCP server lacks the socket is `HOOK_ONLY`. |
| F4 | A daemon spawned from a SessionStart hook with `detached, stdio: ignore, windowsHide` and `unref()` **survives** `claude` exiting (heartbeats continued). Caveat: hosts that put claude in a kill-on-close job object were not tested. | Spawn pattern confirmed. Doctor reports "daemon died with the host" when the daemon's lifetime ends with the host process, so a job-object host is visible, not silent. |
| F5 | For a slash command, **UserPromptExpansion fires before the `!` preprocessing line** (with `command_name`, `command_args`, `prompt_id`, `command_source`); **UserPromptSubmit fires only after the `!` line has finished**, with the typed text. The `!` line does not pass through PreToolUse(Bash). | **Human evidence for acting verbs comes from UserPromptExpansion**, not UserPromptSubmit: the loader writes an HMAC-tagged evidence line `{prompt_id, command_name, command_args, t}` (to the daemon over IPC, or to `tmp/evidence.jsonl` when no IPC is possible); the `!`-run CLI accepts an acting verb only with matching evidence ≤ 60 s old (waits ≤ 3 s). A UserPromptSubmit-based evidence wait would deadlock and is forbidden. UserPromptExpansion is registered for `cowork|cowork-sync:cowork` for **all** verbs. |
| F6 | Command hooks on Windows cost **62–66 ms** end to end (process creation ≈ 40 ms; script ≈ 3 ms). `mcp_tool` hooks cost ≈ 3 ms but fail open when the server is down (docs). A command hook exiting 1 → **fail-open** (tool runs, no hint); exit 2 → blocked with `is_error`; exceeding `timeout` → **fail-open** after the timeout. | v1 keeps **command hooks** for gating (a fail-closed mapping is only possible there). **Hook p95 ≤ 100 ms end to end on Windows** (was 60 ms, infeasible); daemon-side gate ≤ 15 ms unchanged. `mcp_tool` hooks only for non-gating events, v2. The loader's top-level try/catch → exit 2 mapping and the 10 s host timeout are mandatory. |
| F7 | Edit after an external change applies cleanly when `old_string` still matches, with the note "the file had been modified on disk since you last read it". | Confirms the file fence (no change). |
| F8 | GitHub: custom refs push/fetch; two-parent commits accepted; `--force-with-lease` create/update/delete semantics as expected; **`atomic` and `push-options` advertised**; REST `git/ref/cowork/...` works; a plain `git fetch` does not bring custom refs (explicit refspecs needed). **Actions `on: push` did not run for pushes to `refs/cowork/*`** (with or without skip markers). | Probe expectations confirmed for GitHub. Skip markers stay (other hosts). |
| F9 | 100 simultaneous leased pushes from two clones: **exactly one winner every round**, 0 double wins, 0 ambiguous. The loser's line is server-side: `! <sha>:<ref> [remote rejected] (cannot lock ref '<ref>': is at <X> but expected <Y>)`. | Lease arbitration confirmed on GitHub. `cannot lock ref … is at … but expected …` is classified as a **lease reject** (retryable), like `(stale info)`. |
| F10 | Push latency p50 ≈ 1.8 s, p95 1.9–2.8 s (Seoul → GitHub). Fetch of one explicit refspec p50 1.06–1.21 s, p95 1.43–1.57 s. | Governor model inputs updated (push RTT 1.8 s, fetch 1.2 s); publish latency rises by ≈ 1.5 s per window; G = 10 s still dominates. Loop period stays 2.5 s active; a peer never runs two fetches at once (the next fetch starts ≥ 2.5 s after the previous one started, or right after it ends if it took longer). |
| F11 | Push load: 6, 12 and 24 pushes/min (4 workers, separate refs) → **0 failures, no throttling text**. 48/min → **10.4 % failures** `! [remote rejected] <sha> -> <ref> (failed)` and one `remote: fatal error in commit_refs`, ref unchanged, no throttling text; every failing push overlapped another push to the same repo. | Budget stays **B = 6/min** (U3, GitHub guidance); measured headroom to ≥ 24/min is recorded, not used. **`[remote rejected] … (failed)` and `fatal error in commit_refs` are retryable transient failures** (never NONRETRYABLE): fetch, check op-id presence (ambiguous-push rule), retry in the next window. |
| F12 | A pilot team's clean/smudge filter: round trip and idempotency hold for 21/21 files with and without the key file; `filter.<d>.required=true` aborts `git add` with rc 128 and an unchanged index on every failure mode, while without it a failing or undefined filter silently stores the **plaintext secret** (rc 0). The filter needs **cwd = the repository root** (repo-relative script path) and `python` on PATH. | INV-SECRET's `required=true` rule confirmed. **The previous filter preflight (scratch work tree + `update-index -q --refresh`) is broken** (no attributes there, `-q` hides failures, the filter's cwd breaks) and is **replaced**: for each filtered path p, in the **real work tree**, `git cat-file --filters HEAD:p | git hash-object --path=p --stdin` must equal `HEAD:p`'s blob id, and `git hash-object --path=p` of the working file run twice gives the same id. Filters always run with cwd = repo root. DAEMON_ENV keeps the PATH entries the configured filter drivers need (resolved at start, shown in doctor). |
| F13 | Private-index snapshot of the 4,353-file repo: warm `add -A` 16 ms, cold 0.58–0.62 s; `cat-file --filters` / `hash-object` of the 1.3 MB file ≈ 65–70 ms; the real `.git/index` stays byte-identical. | Perf gates confirmed (idle cycle ≤ 100 ms). |

### 25.2 Owner decisions after review pass 2

1. **S6 waits for durability:** a record that is not mirrored (offline, `HOLD_MIRROR_REJECTED`) is never auto-parked; it stays on disk and visible.
2. `generated?` records: `/cowork resolve <id> --discard` means **exclude** (`generated?:exclude`), as in 05 Table 4.
3. Codes: `RESTORE_MARKERS` for a conflicted text restore; `HOLD_RESTORE_CONFLICT` only for the binary refusal. `SEC_QUARANTINE_HUMAN_ONLY` and `SEC_NOTE_REFUSED_SECRET` are dropped in favour of `QUARANTINE_HUMAN_ONLY` and `NOTE_SECRET_HIT`.
4. `OFFLINE` carries `offline_for_s` (local Δmono) and its templates show the duration.
5. A later request attempt also updates `est_minutes`.
6. `IDLE_NO_SESSION`: when the daemon exits because no seat or human lease remained for 10 min, its last status write sets `state: "down"`, `message_code: "IDLE_NO_SESSION"` (01 ENG-56, 06 CCI-50).
7. `/cowork show` accepts an id **or a path**.
8. §24 default 1 is widened: when every conflict region has an empty base block and LOCAL's block already occurs inside TIP's block, return TIP's entry, or the merge-file output with each such region replaced by its TIP block when the tripwire passes (otherwise the general rule), with no record and no event.
9. `HOLD_MIRROR_REJECTED` gets a Claude-facing template delivered at the next hook of the record's origin seat (or the peer's next seat); `CLAIM_REJECTED` stays human-only.
10. Crashpoint call sites listed in 11-testing are owned and placed by the named chapters (01, 05, 06, 08).
11. §20 row "Local-only hold auto-park" means **ON_DISK hold auto-park (`local_only=false`)** (renamed below).


---

## 26. Revision 2.3 — spike 04 (Windows file contention) and spike-synthesis decisions

Evidence: `spikes/04-contention/`, `spikes/RESULTS.md` (sections A, B, C). This section wins over earlier sections.

### 26.1 Measured facts (spike 04, Windows 11, Git for Windows, 1.3 MB BOM+CRLF file, 4 simulated editors)

| # | Fact | Design change |
|---|---|---|
| W1 | Running `git add` directly on the user's working file made editor saves fail **11.4 per 1,000** (control without daemon: 4.2). Cause: `git add` holds the file as a **memory mapping** while hashing; a concurrent truncating open fails with Win32 1224 (`ERROR_USER_MAPPED_FILE`, Node `UNKNOWN −4094`). 16 of 22 failures fell inside snapshot windows covering ≈ 2 % of the time. | **Staged-copy reads on every OS (one code path):** the daemon never runs git on a user's working file. For each stat-dirty path it reads the file with one short read (open share-all, read whole file, close), checks size+mtime before and after (re-read once if changed, else skip this tick), writes the bytes to `<gitdir>/cowork/tmp/stage/<path>` and hashes/adds **the copy** with `--path=<p>` so attributes and filters apply. Measured: in-place editor saves 0 / 963 failures with staging. |
| W2 | The staged copy once captured a **0-byte** file in 480 snapshots (read in the instant after an in-place editor truncated it). | Covered by the existing shrink guard (> 50 % shrink or to 0 bytes needs 2 stable snapshots + attribution) and the before/after stat check (W1). Test added. |
| W3 | `MoveFileEx(REPLACE)` onto a file fails with ACCESS_DENIED (Node `EPERM`) whenever **any** handle is open on it, even a share-all read handle. Atomic-save editors therefore fail occasionally even without the daemon (control 8.3 / 1,000 atomic saves). | The daemon keeps every handle on a user file as short as one read call. The acceptance gate measures **daemon-attributable** failures: editor save failures with the daemon minus the no-daemon control, ≤ 1 per 1,000 saves, with ≥ 3,000 saves per arm (one-sided 95 % bound). |
| W4 | The verifying writer's **two-phase** form (rename target → `.old`, rename `.new` → target) succeeded 15/15 while a share-all reader held the file; the rename-over form failed 15/15. Against a `FileShare.Read` holder (Excel-like) both are refused → `deferred_locked`. 0 late writes into `.old` in 135 checks. | Two-phase is the only writer form. A locked file defers as designed (INCOMING record after 60 s). |
| W5 | Snapshot cost p50 53 ms / p95 58 ms; daemon + git children CPU ≈ 2.2 % of one core (gate ≤ 2 % — borderline). | Perf gate stays; staged copies are only for stat-dirty paths, which lowers CPU when idle. |
| W6 | **Object store growth: 205 MB of loose objects in 20 min** (a new 1.3 MB blob on every 2.5 s snapshot of a changing file). | **Snapshot ticks never write objects.** Change detection = stat-dirty + `hash-object` **without `-w`** on the staged copy. Objects are written only for ready-pair captures, publishes, applies and hold records. Soak gate: loose-object growth ≤ 50 MB per busy peer-hour. |

### 26.2 Decisions on the synthesis questions

1. **`--atomic` is not used in v1** (one rule for every host, P3). The board-authority / lagging-mirror rule already makes the pair safe; GitHub's measured `atomic` support is recorded for v2.
2. **Push rejections are classified by outcome, not text** (resolves the §18 vs §25 F9/F11 conflict). After any rejection: fetch; if the leased ref moved → lease loss (retry in the next window); if it did not move and our op ids are absent → transient (retry in the next window with backoff); after **3 consecutive rejections of the same publish with the ref unchanged** → `NONRETRYABLE` (PIN the publish, human `/cowork resume`). Message text only chooses the explanation shown.
3. **Filter preflight compares through DISK_EQ-safe forms only:** the round trip `cat-file --filters HEAD:p | hash-object --path=p --stdin` == `HEAD:p` (both sides converted by the same path); disk comparisons always use DISK_EQ, never `hash-object --path` of a working file against a blob (it misreports `i/crlf` files).
4. **Hook timing, one table:** non-live fast path (no IPC) ≤ 80 ms p95; live gating hook ≤ 100 ms p95 end to end on Windows; daemon-side ≤ 15 ms p95. All three are measured over ≥ 200 calls, not 5.
5. **Spike-0 item (i) is split:** (i-a) daemon-attributable editor save failures (runnable now with the experimental daemon, W3 gate) and (i-b) apply lag / RSS under a real daemon (runs in the implementation phase, gates the first release, not the start of implementation).
6. **Token wording:** the messaging token is present in every hook's and the MCP server's environment (host behaviour, spike 02); the rule is that **cowork code reads it only in the MCP server** and never sends it over IPC or writes it to disk.
7. A filesystem without hard links (some network drives) uses the copy fallback of the writer, which is weaker; `/cowork start` warns and doctor shows it.

### 26.3 What remains before implementation of host-dependent parts (needs the user)

- A second PC on a different network for the cross-network lease race and fetch latency (spike items a, b).
- 24 h unattended credential run plus a forced sign-out (item f).
- Interactive runs in a terminal and in VS Code: `/cowork` typed 50 times, and the different ways of closing a session (items c, e, g).
- Optional: macOS/Linux machine; a teammate's PC for the filter check.

Implementation of the simulator, test ports, lints and the core engine against a local bare remote may start once the user approves the spec.


---

## 27. Revision 2.4 — user review answers (2026-10-02) and spec approval

**The user approved the design on 2026-10-02.** Answers to the review questions:

| Item | Answer | Effect |
|---|---|---|
| S8 (quarantine of settings/CI/hook files) | Confirmed | S8 is a binding user decision (no longer "pending sign-off"). |
| S5 wake-turn scope (accepted work + own claims, other writes PINned `wake-scope`, recap at next prompt) | Confirmed | Binding. |
| Go-first grant pauses the holder's own edits to that region until the requester's change lands (T-GRANT_PAUSE) | Confirmed | Binding (07 §8 Q4 closed). |
| `/cowork start --fresh` with preview/confirm | Confirmed | Binding (08 §8 Q1 closed). |
| Speed of Claude edits (30 s – 3 min) | **"Must be faster"** | **S1 and U3 change (below).** |

### 27.1 S1 (revised): publish Claude edits at every passing edit checkpoint

**S1 (rev 2.4):** A Claude change-set is published at the first of:
- (a) an **edit checkpoint**: after every Claude edit (PostToolUse of Edit/Write/MultiEdit/NotebookEdit, or a Bash/PowerShell transaction close), when the **edit check** passes on the CS's current content;
- (b) turn end (Stop, StopFailure, SubagentStop);
- (c) a green checkpoint (configured test command passed);
- (d) `cowork_checkpoint`.

Claims stay visible within seconds; a human change-set still publishes after 20 s without edits on its paths (or `/cowork done`).

**Edit check** (runs in the daemon worker, budget ≤ 0.5 s on a 1.3 MB file, reuses the K7/T0 machinery of 04-regions and 05-holds) on `merge-tree --merge-base=A R TIP` restricted to the CS's paths, where R is the ready-pair capture taken at that edit:
1. no new ERROR/MISSING parse nodes relative to TIP in any touched file;
2. no breaking interface change (04-regions classifier: removed or renamed symbol, removed/reordered/new-required parameter, removed export) whose callers in the merged tree are not updated in the same CS;
3. no reference to a name that the merged tree does not define (local import names, called functions removed by this CS);
4. no label count above max(TIP, local) and no > 50 % shrink of a touched file.

- **Pass** → capture the ready pair now (same rules as any capture: rebased at every apply, published by the governor as part of P). A later edit in the same turn that passes replaces the CS's ready pair (newest passing capture wins); publication of an older capture is never blocked by a newer failing edit.
- **Fail** → no capture; the CS keeps its last passing capture (if any). The failed check is not an error and creates no record or message; at turn end the normal path applies (a still-failing CS becomes a K7 PIN as before).
- Unsupported languages (no grammar) pass checks 1–3 trivially; check 4 still applies.
- A green checkpoint or turn end still publishes even when the edit check never passed only if the K7 T0 checks pass (unchanged).

Consequence: **expected Claude-edit latency ≈ edit check (≤ 0.5 s) + governor window + receiver fetch/apply ≈ 10–30 s** (model; measured in the soak). The 05-holds rule "no time-capped WIP publishes" stays: an edit checkpoint is a structural checkpoint, not a timer, and half-done states that break callers are not published.

### 27.2 U3 (revised): push budget 12 per minute with automatic fallback to 6

- `protocol.json.budget = 12` attempts per minute team-wide (default for new boards; configurable per team between 6 and 24 in `.cowork/config.json` `host.pushBudgetPerMin`, which seeds `protocol.json` only at genesis).
- Governor parameters for B = 12: **G = 5 s, S = 1.5 s**; worst normal wait for 4 peers = G + 3·S = 9.5 s. The sliding team guard becomes "no attempt while ≥ B landed board commits were observed in the last 60 s". The per-peer cap is B per 60 s Δmono.
- **Automatic fallback:** any host-throttling signal (HTTP 429, any 5xx, push RTT > 10 s, or a transient-rejection streak ≥ 2 per §26.2 item 2) makes that peer use B = 6, G = 10 s, S = 3 s for 30 min (local Δmono), and posts a `health` event so other peers follow (each peer applies the stricter of its own state and any folded `health{throttle}` event in the last 30 min of its own observation).
- Soak gates: ≤ B attempts in any 60 s window; zero HTTP 429; publish p95 ≤ 40 s; fallback engages within one window of an injected throttle signal.
- Basis: spike 01 measured 0 failures at 12 and 24 pushes/min (separate refs, concurrent); failures appeared only at 48/min with heavy overlap. cowork pushes are serialized on one board ref, so overlap is lower than in the spike.

### 27.3 Changes to earlier sections

- §1 S1 and U3 rows are superseded by §27.1 and §27.2.
- §20 Governor row, worst-wait row, soak row and the Claude-edit latency figures in the design doc and Korean summary follow §27.2 and §27.1.
- 05-holds publication timing, 06-claude PostToolUse/TXN-close capture trigger, 02-protocol governor, 01-engine ENG-46, 04-regions (edit-check entry point reusing interfaceCheck/regionTripwire), 07-coordination (no message on a failing edit check), 11-testing (edit-check tests, governor/fallback tests, soak gates) are updated accordingly.


---

## 28. Visualizer (2026-10-06; superseded by §29 where they differ)

*(8a batch, after Plan 2's)* The pending section of 12-visualizer §9.2, merged with Plan 8a's spec-edit batch (2026-10-10). It wins over the sections before it; §29 (rev 2.5, 2026-10-08) is newer and wins over it where they differ. Its rev 2.5 additions (F29, F32, F34) are the ones §29.7 records; the additions tagged "8a batch" come from Plan 8a's rulings. The viewer itself is 12-visualizer's; Plan 8a, which builds its core (`node dist/cli.js view` in `tty` mode, `en` only), is a development milestone and is never released, and the product (the slash verb, `--json`, six languages) ships with Plan 8b (12 §9.1).

- **§6 Plugin `dist/`:** "`hook.js`, `core.js`, `daemon.js`, `worker.js`, `mcp.js`, `cli.js`, **`viz.js`** (the read-only viewer of 12-visualizer; its page assets and the bundled demo log are embedded as strings), `grammars/*.wasm`, …" (unchanged after that).
- **§6 Per user:** new row "`log/viz-<instance>-<n>.jsonl` — viewer logs, one set per viewer process (12-visualizer; 10 MB × 5, 14 days)". *(8a batch, after Plan 2's; Task 15 rulings)* Beside them, `log/viz-stderr.txt`: the viewers' raw stderr, not a log file (outside the rotation and the 14-day cleanup, shared by the viewers of the data directory, started over at a spawn past 1 MiB; 12 §3.10.10).
- **§15 Slash verbs:** `view` joins the read-only list (the list is otherwise unchanged; §29.4 lists the rev 2.5 additions `status --flow`, `show <id|path|glob>…`, `show … --undo`, `since` and `wrap`). `view` flags: `--no-open`, `--demo[=<file>]`, `--repo <path>` (repeatable). `view` opens the read-only viewer of 12-visualizer; it needs no human evidence; its `--json` envelope never contains the viewer URL.
- **§17:** the viewer (12-visualizer), which spans repositories, resolves the human language as `user.json` → OS locale → `en`, like the hook loader; the CLI resolves it and passes it to the viewer process.

**§19 viewer row:**

| Carrier | Cap (chars) |
|---|---|
| Viewer (`viz` channel): bubble 2 lines × 42 Latin / 16 full-width chars; card text 400; tooltip 200; room label 40; branch 80; names, label, path and note as the placeholder row; (rev 2.5, F29) reel title 60 (one line); *(8a batch, after Plan 2's; R-V50)* before the grapheme cap every string is cut to 4 × its cap in UTF-16 code units (names 64) | as listed |

**§20 viewer row:**

| Parameter | Value | Basis |
|---|---|---|
| Viewer | poll 2.5 s by `stat`, `rev-parse` only on a change or every 60 s; batches of ≤ 1,280 board commits; ready handshake 5 s; launch token TTL 120 s, idle exit 10 min without an open stream, lifetime 24 h (own staleness); plugin check 30 s; `repos.json` and `live` re-check 30 s; ≤ 32 rooms; initial window 1,024–1,279 heights from a checkpoint, earlier pages of 256, ≤ 2,048 heights kept per room, seek ≤ 255 folds; live beat 300 ms, snap after a 5 s backlog or > 64 commits in one tick; replay beat 800 ms at 1×, speeds 0.5×–8×; ≤ 12 fps, ≤ 2 draws/s idle; bubbles 1.5–6 s, ≤ 1 per actor, ≤ 3 per room; ≤ 15 zones + overflow, ≤ 4 cells × 6 slots per zone, shelf at the 24th slot; 1 chair + 4 visitor tiles; relaxed pose after 64 heights; board near-full badge at 4,000 records; stream comment every 15 s, SSE message ≤ 64 KiB, resume ring 4,096 events or 10 min; recording art viewport 480 × 270, WebM 1,920 × 1,080 at ≈ 2 Mbps ≤ 120 s, GIF 960 × 540 at 10 fps ≤ 10 MB; `status.json` read ≤ 1 MiB; viewer RSS ≤ 200 MB; (rev 2.5, F32) follow: ≤ 1 peer per room, page memory only; pan 300 ms, jump at ≥ 4× or reduced motion; now card ≤ 3 holding, ≤ 3 asks, ≤ 3 asked-by rows; (rev 2.5, F34) postcard 960 × 540 PNG, text ≤ 16 lines (≤ 12 actor lines + one "+n"), line ≤ 400; (rev 2.5, F29) reel: range ≤ 2,048 heights, ≤ 9 timeline pages per range, ≤ 18 to choose the default range; 1–8 chapters (default 5); cap 20/30/40/60 s (default 40); intro 2,000 ms, beat and fold 800 ms, ≤ 6 steps per chapter body, montage 1,200 ms, end card 1,500 ms; *(8a batch, after Plan 2's)* the resume ring also ≤ 1 MiB, a stream closed when its backlog stays above 1 MiB across two checks 1 s apart (R-V65, R-V72); a re-folded timeline page ≤ 256 folds, the genesis "load earlier" 257 (R-V29); viewer V8 heap capped at 150 MB + 16 MB per room beyond 8, ≤ 4 first windows built at once; RSS measured settled (Task 15 rulings); a viewer git call killed after 120 s (R-V06); ≤ 32 MiB of `cat-file --batch` output per read call (R-V69) | 12-visualizer |

---

## 29. Revision 2.5 (2026-10-08) — nice-to-have features F04, F05, F10, F12, F14, F29, F32, F34

Sources: `docs/proposals/F04-since-catchup.md`, `F05-claims-ahead.md`, `F10-revert-own-change-set.md`, `F12-wrap-and-save-draft.md`, `F14-status-flow.md`, `F29-highlight-reel.md`, `F32-follow-teammate.md`, `F34-postcard.md` (each revised by its adversarial review; a design file wins over `docs/proposals/QUEUE.md`). **This section wins over every earlier section.** The edits that F05 and F10 ask to make in place (§6, §9, §15, §19, §20) are applied there, tagged *(rev 2.5, F##)*, and restated here so that this section is complete; every other change lives only here. The text of §27 (rev 2.4) is unchanged.

- **Protocol: unchanged** (`proto = 1`). No feature adds a board op, op field, trailer, ref, board file, `status.json` field (§14), push, fetch or transport, so none has to land before any given release (under D4, §29.1, all eight ship in the first public release, which follows Plan 8b). Local-only additions: the optional `meta.since` heights in the never-pushed state ref (01 §3.2, F04; the meta parser accepts the key before any build writes it, ENG-05); the file `cs/<enc(b)>.reverts.jsonl` (§6, F10); the CLI↔daemon IPC frames `since_query` and `since_ran` (F04), the read-only IPC request kind `wrap` (F12) and the status-detail `flow` selector (F14), all registered in the 09 §3.11 schema; and the daemon-memory `last_check`/`last_pass` per open seat CS (F14, shared by F12; §29.8).
- **Numbering.** §28 stays reserved for 12-visualizer §9.2's pending section, relabelled there "§28 Visualizer (2026-10-06; superseded by §29 where they differ)" so that only this section carries the "Revision 2.5" label; it is not merged yet. *(8a batch, after Plan 2's: merged on 2026-10-10 as §28 above.)* This section (2026-10-08) is newer and wins over §28 wherever they differ. Every §15 change below is an append, and §28's own §15 change is an append too (`view` joins the read-only list), so the two compose.
- **Ids.** Requirements keep their `FEAT-Fxx-NN` ids as aliases in their chapters. Chapter rule ids assigned in this revision: F05 — CCI-57…CCI-67 (06), COO-34, COO-35 (07), UX-32 (10); F10 — HLD-68 (05), CCI-68 (06), COO-36 (07), UX-35, UX-36 (10); F12 — UX-37…UX-54 (10); F14 — UX-33, UX-34 (10); F04 — none (its `FEAT-F04-NN` ids are 10-product §4's rules). Test and lint ids: 05 §7 I18, 06 §7 tests 48–60, 09 §7 tests 32–35, 11 §7.11 (TC-F10-01…17), 11 §3.10 lint `L-PURE`; the F04, F12 and F14 tests are 10-product §7 rows. 12-visualizer: §3.8.1 (F32), §3.9.5 (F34), §3.9.6 (F29); browser smoke items (j) (F34) and (k) (F32). This file adds no requirement id. F29, F32 and F34 change no glossary term; their only glossary-level text is the pending viewer rows (§29.7).

### 29.1 Owner decisions (final, 2026-10-08)

Proposed on 2026-10-08 with the recommended option and **decided by the owner the same day**: D1 wider than proposed (the result is shown in slash output too), D2 with option (a) of 05-holds §8 Q18 added, D3 and D5 as proposed, and D4 with the other option (the first public release waits for Plan 8b). The last column records the alternative that was not taken. *(Changed by the owner's decisions of 2026-10-08: until then this section was "provisional".)*

| Id | Decision (final) | Text it changes | Alternative not taken |
|---|---|---|---|
| D1 | A failed edit check keeps one last result per open seat CS in this PC's memory (`last_check`), and that result is shown **in full whenever `/cowork status --flow` or `/cowork wrap` runs**, both as a slash command inside Claude Code and in a terminal: in every output mode (`tty`, `slash`, `pipe`) and in the `--json` of those two verbs. The output of a slash verb is the conversation and is read by that seat's Claude (10 §3.3); that is intended (owner: "중요한 정보라면 대화형식으로 다 보여줘야할듯" — if it is important, show all of it in the conversation). The daemon does not test who asked, so a `flow` or `wrap` request from Claude's own Bash call gets the same reply: a pull Claude made, not a push. The result is **never pushed unasked** to Claude or any teammate: no carrier (06 §3.14.1), no hook message (additionalContext, `systemMessage`, Stop block), no doorbell, no board op, event or hold record, no human mirror, OS notification, log line or `status.json` field. Plain `/cowork status` (section 6) and `/cowork show <path>`, which the decision does not name, print stage O10's first line and the pointer line `UI_FLOW_LAST_WITHHELD`, which names `/cowork status --flow` (10 §3.5.1). *The provisional text (merge rounds 1 and 2) showed the result only in a terminal and gated it on a route-(a) request; that gate is removed, and route (a) now serves only F04's `since_ran` (§29.2, FEAT-F04-18).* | §27.1 "Fail" bullet (§29.8); 01 §6; 04 §1.1, §3.1, §3.18, §3.19, §3.20, REG-31, REG-36, INV-NOSILENT, INV-REG-EDITCHECK, §6, §8 Q10; 05 §1, §2, HLD-43, HLD-67 step 4, §6, §7 U10; 06 §3.8.4, §3.9, §3.14.4, §3.16.1, CCI-56, INV-CCI-EDITCHECK, §6, §8; 07 §1.1, §3.4, COO-10, §6, I-edit-check-silent; 09 §3.11, SEC-38, test 35; 10 §2 output mode, §3.5, §3.5.1, §3.8, §3.18, §3.19, §3.20, W3, §3.20.4, UX-33, UX-34, UX-42, §7, §8 item 7 (F14 §8 items 4–7, F12 §7); 11 §7.9 | (a) the provisional terminal-only display (a route-(a) request only; `UI_FLOW_LAST_WITHHELD` in slash, pipe and Bash output); (b) no display: `last_check`, F14's `{last}` line (the second line of stage O10) and F12's W3 edit-check reason dropped, §27.1 keeping its rev 2.4 sentence |
| D2 | A human-confirmed `/cowork revert` write counts as attribution for T0's shrink guard (05 HLD-50 item 3) for exactly the content it wrote: while its CS is pending (its ready pair in `journal/ready/`, or its `cs_id` in a non-terminal record, a hold included; the mark is dropped when the CS publishes, when that record becomes terminal, e.g. RESOLVED_DISCARD or SUBSUMED, or when the CS leaves `journal/ready/` without publishing), a path whose checked content equals the result blob that the confirmed revert wrote to it (or ABSENT, for a deletion) is exempt, so that shrink of more than half, or that deletion of a file the reverted CS created, is not a K7 by itself. **The mark follows a clean teammate rebase** (05 §8 Q18 option (a)): when a clean HLD-41 rebase (§29.2: an apply that wrote p as a clean merge or `CONCAT` with `S_disk[p] == R[p]` before it) rebases the revert CS's ready pair on p, the mark's oid for p becomes the new `R[p]` **if `R[p]` before the rebase was the mark's oid** (the marked blob with the teammate's change merged in), and the daemon appends that oid to `cs/<enc(b)>.reverts.jsonl` (§6) so that a restart re-derives the same mark; so a confirmed revert still publishes when a teammate changed another part of the file before the push, instead of ending as a K7 `t0` PIN that can only be discarded. The mark still covers only the blob the confirmed revert wrote, carried forward by such a rebase: any other content on that path (a later human or Claude edit, a teammate apply that conflicts with the revert or displaces the local side (K4, `TAKE_TIP`, DAT-43), a torn read) gets the ordinary guard, and ENG-25's snapshot shrink and removal exclusions are lifted only for a snapshot whose blob equals the mark's current oid (or, for an ABSENT mark, in which the path is missing) while that CS is pending (01 ENG-25; 05 Algorithm REV step 8, §8 Q18). Every other safety check stays (B1/K6, T0's parse, caller and import checks, MASK, S2/K4, F10's `TEAMMATE_LINE` backstop). | 00 §6 `reverts.jsonl`, §29.2 (clean HLD-41 rebase, merge round 3); 01 ENG-25; 05 §2 "observed change", HLD-26, HLD-41 (the mark note), HLD-50 item 3, Algorithm REV step 8, §8 Q18; 07 §1.1, §3.4 K7; 10 §3.4, §8 item 7 (F10 §8); 11 TC-F10-10 variant, TC-F10-15, TC-F10-17. Glossary effect: §10 K7's "> 50 % shrink" test, and the shrink part of §27.1 check 4 in F10's preview prediction, do not fire on that write by themselves | (a) the mark stays on the written oid (05 §8 Q18 option (b), the merge-round-2 text): a clean teammate apply into a reverted file before the push leaves a K7 `t0` PIN that can only be discarded; (b) no attribution: F10 refuses, or predicts as unshippable, every revert that shrinks a file by more than half or deletes a file the CS created |
| D3 | F32 ships in Plan 8a as Task 19 (group G9, after Task 18); its six-language strings and the recording clause of browser smoke item (k) ship in 8b. | none in this file (12-visualizer, roadmap) | F32 wholly in 8b |
| D4 | **The first public release happens only after Plan 8b**, as one release that includes the visualizer product (the `/cowork view` slash verb and six-language viewer), the highlight reel (F29) and postcards (F34), with the 8b halves of F04 and F32. Plan 7 prepares the release (packaging, the README in six languages, the FSL licence and the CLA, the scrub list) but publishes nothing; the publish/release task is Plan 8b's last task. | §29 intro ("Protocol: unchanged" bullet); roadmap rows 7 and 8 and both order paragraphs; 10 §3.18, §8 item 7; 12 status paragraph, §9.1 | release after Plan 7, with Plan 8b and its features shipped later as updates (the provisional text) |
| D5 | Option (가): right after Plan 2, only slice F04-a (the pure catch-up core and a terminal-only English `since`) starts early. | none in this file (roadmap row 2 and order paragraph; 11 §7.9) | option (나): also start the F12/F14 pure carve-outs with their additive Plan 2 interface asks |

**Also decided on 2026-10-08 (privacy scope).** FEAT-F04-12 ("no surface shows a teammate's last-seen time") stays scoped to F04's surfaces (10-product FEAT-F04-12, merge round 2's R2-20); F05's `{ACT}` #4 / `UI_ACT_LAST_BOARD` and 12-visualizer's `UI_VIZ_SEEN_AGO` stay as they are.

### 29.2 Terms (§3)

| Term | Definition |
|---|---|
| **flow entry** *(rev 2.5, F14)* | (path, direction `out|in`) of a path whose disk differs from TIP, with exactly one stage (10 §3.5.1). |
| **clean HLD-41 rebase** *(rev 2.5, F10; owner decision D2; merge round 3)* | A rebase of a ready group's pair for p (05 HLD-41) in which (i) the update is an apply (or the restart's completion of an interrupted apply, 01 ENG-53) that wrote p as a clean merge or a `CONCAT` blob, with no member file effect on p after the capture (`S_disk[p] == R[p]` before that apply), whether the plain `merge-file` rebase returned rc 0 or HLD-41's first bullet decided its conflict, and (ii) the pair's `R[p]` immediately before the rebase equals the current oid for p of a pending confirmed revert's D2 shrink mark (§29.1 D2). It is the only rebase that moves that mark, to the new `R[p]` (05 Algorithm REV step 8); a displaced local side, a conflicting apply (K4), `A[p]` changed without a write of p, a member effect after the capture, or an `R[p]` that is not the mark's oid leaves the mark where it is. |
| **route-(a) request** *(rev 2.5, F04; merge round 2)* | A CLI → daemon `since_ran` request whose CLI reports `tty` true (stdin and stdout are TTYs) and `ancestry_has_claude` false (no claude ancestor and no `CLAUDECODE`): the fields and the test of SEC-25 route (a), 09 §3.13 steps 3–4, sent with that request (09 §3.11). It is always `tty` output mode, but a `tty`-mode CLI under a claude ancestor (a PTY given to a Claude Bash call) is not one. Like route (a), it is hardening, not a boundary (09 §3.1). Only F04's `since_ran` uses it (FEAT-F04-18, which had its own `tty` rule before the merge). *(Until the owner's D1 decision of 2026-10-08 the `flow` and `wrap` requests used it too, to keep `last_check` out of slash output; D1 removed that gate, §29.1.)* |

### 29.3 Files and stores (§6, §9)

- §6 per clone, applied in place: `cs/<enc(b)>.reverts.jsonl` = `{cs, of, t_local_ms, written}` per `/cowork revert`, plus a line of the same shape each time a clean HLD-41 rebase carries the D2 mark forward (per path, the newest line of a `cs` that matches the journaled content wins, 05-holds §8 Q18); the "revert of" label and the start-time source of the D2 mark (`written` = path → oid or ABSENT, added at merge so that the mark is keyed to the written blob, §29.1 D2), kept 14 days, never pushed. *(rev 2.5, F10; the rebase line: owner decision D2, 2026-10-08)*
- §9 forbidden list, applied in place: `revertInverse()` (Algorithm REV, 05) is a second exception beside `taintOnlyH1()`; its `merge-file --ours` output is only (a) the target of a human-confirmed `writeLocalGroup` (verb mode) or (b) rendered, never written, as the undo view (view mode). The lint that enforces §9 (11 §3.10 L-HOLD-STORES) names both exceptions and flags `merge-file --ours` outside `revertInverse()`. *(rev 2.5, F10; lint named in merge round 2)*

### 29.4 Claude-facing and human surfaces (§15)

**MCP tools** (still the eight of §15; the ≤ 3,000-char schema total is re-measured with both description clauses below, T-F05-schema and TC-F10-14):
- `cowork_show(id)`, applied in place: `id` is a cowork id, or a repo-relative path or glob (03-data §3.6 dialect), or a list of ≤ 20 of them, resolved ids first; a path gives the claims-ahead path view (F05 §2.3, ≤ 8,000 chars). Description clause: "Also takes repo paths or globs (up to 20): other sessions' held functions in them." *(rev 2.5, F05)* For a `cs_id` of this PC the result adds the undo view (Algorithm REV in `view` mode); description clause: "a change-set id of this PC adds an undo diff". *(rev 2.5, F10)*

**Slash verbs** (appends to the §15 lists):
- Read-only (no human evidence; `--json` on each): `status [--flow]` *(rev 2.5, F14)*, `queue`, `show <id|path|glob>…` *(rev 2.5, F05)* and `show <cs_id>|last --undo` *(rev 2.5, F10)*, `doctor`, `log`, `since` *(rev 2.5, F04)*, `wrap` *(rev 2.5, F12)*. With 12-visualizer's pending section, `view` joins this list. *(8a batch, after Plan 2's: it has, §28.)*
- Acting, inserted after `review <id> --accept` (in place): `revert <cs_id>|last [--confirm=<id>]` (SEC-25 evidence, preview/confirm, human lease like every acting verb). *(rev 2.5, F10)*
- `status` flag: `--flow` prints the headline, its next line and the whole "In flight" section (10 §3.5.1), with the latest edit-check result of each open Claude session in every output mode, slash included (§29.8, D1). *(rev 2.5, F14)*
- `show` arguments: one or more positional paths or globs form one list (≤ 20 shown), so a glob the shell expanded through the `!` line gives the same result; with two or more arguments each one is a path or glob only. *(rev 2.5, F05)* `--undo` takes exactly one change-set id or `last`. *(rev 2.5, F10)*
- `since` flags: `--since=save:<oid>|#<height>|last-run`, `--json`; default anchor = the local return mark (01 `meta.since`, F04), else this peer's newest `join`. *(rev 2.5, F04)*
- `wrap` takes only `--json`; it needs no human evidence and renews no human lease. *(rev 2.5, F12)*
- `revert` ids: a full `cs_id`, a unique prefix of ≥ 6 characters among the change-sets in the revert window, or `<cs_id>@<epoch8>` (the first 8 characters of the epoch in `Cowork-Writer`) when the id occurs under more than one epoch of this peer (unqualified: `AMBIGUOUS_ID`); `last` = this peer's newest closed change-set, refused while it is not fully shared, never skipped to an older one. Only this peer's own change-sets qualify. *(rev 2.5, F10)*
- Preview/confirm list, applied in place: `revert` (digest of the target, its commit oids and every path's disk and result blob, and the kept and skipped lists). *(rev 2.5, F10)*
- Removed list, applied in place: `undo` (own change-sets use `revert`; a teammate's change is F11). *(rev 2.5, F10)*

### 29.5 Configuration (§17)

`user.json` keys gain `since.recap` (default true; the human return recap) and `since.claudePointer` (default true; the one Claude-facing `T-SINCE` line). *(rev 2.5, F04)*

### 29.6 Text caps (§19)

| Carrier | Cap (chars) |
|---|---|
| Catch-up pointer line (inside the UserPromptSubmit digest delta; template `T-SINCE`, code `SINCE_POINTER`) *(rev 2.5, F04)*; up to 2 `T-SINCE.touch` items are added in order only while the whole line stays ≤ 300, so a worst-case line carries 0 touches in en and 1 in ko (07-coordination §3.16.3) *(changed at merge from F04 §2.3's "up to 2 touches"; open for the F04 owner)* | 300 |

- PostToolUse row, applied in place: the 600-char attribution slot carries `ATTRIBUTION` first and then, when both fit, `CLAIM_AHEAD` or `CLAIM_AHEAD_ENDED`. *(rev 2.5, F05)*

### 29.7 Numbers (§20)

| Parameter | Value | Basis |
|---|---|---|
| Catch-up (F04) *(rev 2.5, F04)* | return = human activity after ≥ 30 min of this PC's own `max(Δwall, Δmono)` without one, or the first after daemon start; ≤ 1 recap per return; range cap 5,000 heights; CLI p95 ≤ 2 s at the cap | F04 |
| Claims ahead (F05) *(rev 2.5, F05; also in §20)* | ≤ 3 items per note; 1 note per (seat, agent, claim_id) while the claim stays in the claim view; ≤ 5,000 of the 20,000 injected chars per seat-hour; path view ≤ 20 paths, full result ≤ 1 per 30 s per (seat, path set) unless changed | F05 |
| Revert (F10) *(rev 2.5, F10; also in §20)* | window = the provenance journal (14 days, HLD-25); ≤ 2,000 paths per revert; ≤ 500 `merge-file` runs per computation (paths unchanged since the CS need none); computation in a daemon worker ≤ 30 s, then `RF_REVERT_TOO_BIG`; preview lists ≤ 50 lines each; slash output ≤ 4,000; `cowork_show` ≤ 8,000; `cs/<enc(b)>.reverts.jsonl` kept 14 days | F10 |
| Wrap (F12) *(rev 2.5, F12)* | sections ≤ 10 lines (W5 6 authors / 20 paths, W6 5); W8 reserved ≤ 900 chars; draft ≤ 12 bullets × 100 chars, ≤ 1,000 chars in slash mode, ≤ 8 bullets in the save preview in slash mode (dropped first over the slash cap); attribution 10 s wall time shared with save, background worker priority; per-commit mapper memo ≤ 5,000 entries (LRU, never a budget-degraded result); typical slash output ≤ 2,500 | F12 |

F14 changes none of §14, §19 and §20; its entry caps (≤ 5 in `status`, 200 in `tty`/`pipe`, 2,000 in `--json` and in the IPC reply) are 10 §3.5.1's.

**Viewer rows (pending §28).** The §19 "Viewer (`viz` channel)" row and the §20 "Viewer" row enter this file only with 12-visualizer §9.2's section. *(8a batch, after Plan 2's: §28 is merged, and its two rows carry the additions below.)* F29, F32 and F34 amend those rows through 12 §9.2 (F29 §7 item 12, F32 §7 item 9, F34 §7); the additions are recorded here so that the merge carries them:
- §19 Viewer row: + "reel title 60 (one line)". *(rev 2.5, F29)*
- §20 Viewer row: + "reel: range ≤ 2,048 heights, ≤ 9 timeline pages per range, ≤ 18 to choose the default range; 1–8 chapters (default 5); cap 20/30/40/60 s (default 40); intro 2,000 ms, beat and fold 800 ms, ≤ 6 steps per chapter body, montage 1,200 ms, end card 1,500 ms" *(rev 2.5, F29)*; + "follow: ≤ 1 peer per room, page memory only; pan 300 ms, jump at ≥ 4× or reduced motion; now card ≤ 3 holding, ≤ 3 asks, ≤ 3 asked-by rows" *(rev 2.5, F32)*; + "postcard 960 × 540 PNG, text ≤ 16 lines (≤ 12 actor lines + one "+n"), line ≤ 400" *(rev 2.5, F34)*.

### 29.8 Edit checkpoints: §27.1 "Fail" bullet (D1, final)

In the §27.1 "Fail" bullet, the sentence "The failed check is not an error and creates no record or message;" reads as follows (the rest of the bullet is unchanged):

> The failed check is not an error and creates no hold record, no board op, no event and no daemon-initiated text on any carrier; the daemon keeps only the CS's last result in memory (`last_check`, 10 §3.5.1) and shows it in full whenever `/cowork status --flow` *(rev 2.5, F14)* or `/cowork wrap` *(rev 2.5, F12)* runs, as a slash command (whose output the seat's Claude reads) or in a terminal; it is never pushed to Claude or any teammate;

- `last_check` is one store shared by F14 and F12 with F14 §4's shape (`{edit_n, kind: fail | conflict | incomplete | stale | skipped, check?, path?, line?, skip?, more}`), one slot per open seat CS, written by HLD-67 step 4, the T0 drop of an open-CS capture at publish and 06 §3.8.4's skip conditions 3–6, and cleared when the CS closes or a passing capture with a higher `edit_n` lands. It is never persisted, logged, published, or delivered to a seat carrier (06 §3.14.1), a human mirror (10 §3.12) or an OS notification, and it is lost at daemon restart. *(rev 2.5, F14, F12)*
- §27.3's "07-coordination (no message on a failing edit check)" therefore means no **pushed** message: the output of a `/cowork status --flow` or `/cowork wrap` run — slash output, which is the human's conversation and which the seat's Claude reads, as well as terminal output — is not a carrier and MAY show `last_check` (07 COO-10 and §3.4, 04 REG-36 and §3.20, 05 HLD-67 step 4, 06 §3.8.4 and §3.16.1, as F14 §8 items 4–7 and F12 §7 amend them). The daemon puts `last_check` into every all-paths `flow` IPC reply and every `wrap` reply, whoever asked (a CLI run from Claude's own Bash included: a pull, not a push), and into no path-scoped `flow` reply; plain `status` (section 6) and `show <path>` print O10's first line and the pointer line `UI_FLOW_LAST_WITHHELD`, which names `/cowork status --flow`. *(rev 2.5, F14, F12; owner decision D1, final on 2026-10-08, §29.1: the merge-time route-(a) gate is removed)*
- D1 is final, so this replacement stands; §27.1's rev 2.4 sentence no longer applies.

### 29.9 Change log

| Area | Change | Feature |
|---|---|---|
| §3 | term **flow entry** | F14 |
| §3 | term **route-(a) request** (merge round 2; `since_ran` only since the owner's D1, 2026-10-08) | F04 |
| §3 | term **clean HLD-41 rebase** (merge round 3: the one trigger of the D2 mark move, with the precondition that `R[p]` was the mark's oid) | F10 |
| §6 | `cs/<enc(b)>.reverts.jsonl` (in place; the rebase line of the owner's D2; per-path matching at restart, merge round 3) | F10 |
| §9 | forbidden-list exception `revertInverse()` (in place) | F10 |
| §15 | `cowork_show` takes paths, globs and lists of ≤ 20; `show <id|path|glob>…` (in place) | F05 |
| §15 | `cowork_show` undo-view clause; acting `revert <cs_id>|last`; `show … --undo`; preview/confirm entry; `undo` in the removed list (in place) | F10 |
| §15 | read-only `since` and its flags | F04 |
| §15 | read-only `wrap` (`--json` only) | F12 |
| §15 | `status --flow` | F14 |
| §17 | `since.recap`, `since.claudePointer` | F04 |
| §19 | catch-up pointer line 300 | F04 |
| §19 | attribution-slot order (in place) | F05 |
| §19, §20 viewer rows | reel, follow and postcard additions (pending §28) | F29, F32, F34 |
| §20 | rows Catch-up, Wrap | F04, F12 |
| §20 | rows Claims ahead, Revert (in place) | F05, F10 |
| §27.1 | "Fail" bullet: memory-only `last_check`, shown in full in every `status --flow` and `wrap` output, slash or terminal, and never pushed (D1) | F14, F12 |
| §29.1 | owner decisions D1–D5 recorded as provisional at merge, then decided by the owner on 2026-10-08 (D1 wider: slash and terminal; D2 with 05 §8 Q18 option (a); D3, D4 "after 8b", D5 as stated); privacy scope of FEAT-F04-12 decided | controller, owner |

**Merge-time departures from the design files** (each with its reason; for the named design owner to confirm — `docs/proposals/MERGE-LOG.md` has the full list):
- D1: the merge first narrowed the display to the `tty` output of `status --flow` and `wrap`, and merge round 2 gated it on a route-(a) request (§29.2). The owner's final D1 (2026-10-08) shows `last_check` in full in every `status --flow` and `wrap` output, slash included, and removes that gate; F04's `since_ran` keeps its route-(a) test. Plain `status` and `show <path>` still print O10's first line and `UI_FLOW_LAST_WITHHELD`, now a pointer to `/cowork status --flow` (the F14 and F12 designs showed the result there too; the decision names only the two verbs). F12's fallback codes `UI_WRAP_EDITCHECK_*` are not defined: W3 renders F14's `UI_FLOW_LAST_*`.
- D2 keyed to content: the shrink exemption covers only the blob the confirmed revert wrote (F10 keyed it to the CS and path). Merge round 2: the mark lives only while the revert CS is pending (ready, or named by a non-terminal record), the same condition in memory and at restart; 01 ENG-25 states its snapshot side. Owner decision (2026-10-08): the mark follows a clean HLD-41 rebase (05 §8 Q18 option (a)), recorded as a new `reverts.jsonl` line, so a clean teammate apply into a reverted path before the push no longer leaves a K7 `t0` PIN.
- 05 §8 Q17: the undo view writes no file (the design's alternative made the default); the view is throttled (30 s, `SHOW_NO_CHANGE`), runs at background priority and passes its diff lines through `scanSecrets` (06 §3.16.3, CCI-68; F10 had none of these).
- 04 §3.20 and REG-35/REG-36: a read-only exception lets the revert preview run the edit check and `gate()` on in-memory result buffers (F10 asked for no 04 edit).
- 07: en `T-SHOW_UNDO.foot` and `.trunc` rewritten as third-person facts; ko for `.head`, `.trunc`, `.human` and `.notown` written at merge; F10's `{kind}` became `{UNDOKIND}`; `T-SHOW_UNDO.kept` and `.skip` added (F10 gave the undo view's kept and skipped lines no template). `T-SINCE` carries up to 2 touches only while the line stays ≤ 300 (en worst case 0, ko 1; F04 §2.3 asked for 2 within 300).
- 10: `UI_DRAFT_LABEL` "DRAFT" became "draft" (I18N-07 bans all-caps words); `UI_WRAP_CMD_HANDOFF`, `UI_WRAP_CMD_AWAY` and `UI_WRAP_WAITING_NAMES` are reserved, outside the catalogs and the I18N/TST-26 lints (F12 §7 lists them as codes); the revert prefix is matched among every change-set in the window, as 05 does; `/cowork since` gained the row and anchor codes F04 left unnamed (`UI_SINCE_ANCHOR_*`, `UI_SINCE_REQ_ROW`, `UI_SINCE_TEAM_*`, `UI_SINCE_EV_*`).
- 04 REG-36: F14's "MUST carry `line`" exempts a failed entry whose `M[p]` cannot be decoded. 02 §3.8: `wait_detail()` lists its terms in display priority (`in_flight` fifth), not in `may_attempt`'s evaluation order. §9: "sole exception" became "exceptions". 08 §2.6: the `since` and `revert` flags sit in their own sentence, not in the "This chapter interprets" list.

**Added at merge with no design source** (kept for consistency; the owner may object): 05 HLD-12's `--ours` exception, 11 `L-HOLD-STORES`'s `revertInverse()` exception and `--ours` clause, 01 §3.3 item 4 and ENG-10's `revertInverse()` clause, 01 §2 / ENG-03 / §7 test 6, 01 ENG-05's meta-parser rule for `since` and ENG-25's D2 sentence (round 2), 06 §3.9 class (d) `revert`, 09 §3.13 step 5, 11 `L-HUMAN-ONLY` "undo", §29.2 **route-(a) request** (round 2) and **clean HLD-41 rebase** (round 3) (needed so that chapters agree); 10's `UI_REVERT_PATH_DELETED`/`_RESTORED`, the seven keyed `UI_REVERT_SKIP_<KEY>` codes, including the view-only `UI_REVERT_SKIP_CHANGED_NOW` (F10 named one keyed `UI_REVERT_SKIP`), and `UI_DUR_AT_LEAST` (F05 counted nine codes but named eight); 09 §7 test 35 and its two new §6 rows; 08 §8 Q7; 05 §8 Q17 and Q18 (discretionary).
