# engine — Keep one shared live tree per branch on the project's own git remote, and keep every peer's working tree in step with it, without ever losing bytes. The engine: snapshots local edits from a private index; merges them against an explicit per-path base; publishes them as first-parent fast-forward commits under a single CAS on the board ref, within the team push budget; writes incoming changes into the working tree path by path, verifying each write; survives crashes and host rejections. It moves the real branch only on a human-typed save, and peers adopt that save only when it is safe.

## v1 in scope
- One daemon per clone, live mode in the main worktree only, one loop per branch (ENG-02, ENG-13).
- Board-authority ref model with a lagging code mirror; first-parent fast-forward-only chains; genesis, base-move and save shapes (ENG-01).
- All state in the user's own GIT_DIR: refs/cowork-remote, refs/cowork-local state/holds/incident refs with reflogs; a CAS-updated state commit holding A, S_disk, journal and meta (ENG-02, ENG-03).
- Single git wrapper with pinned config, required filters, attr.tree, empty hooksPath, absolute paths and watchdogs; file bytes handled only as Buffers (ENG-04).
- Pinned-URL transport with explicit refspecs, no FETCH_HEAD or auto-maintenance, non-interactive auth and backoff (ENG-05).
- Snapshot from a persistent stat-fresh private index: quiet period, stability checks, per-path UNREADABLE and LOCAL-ONLY handling, canon applied before any merge (ENG-08); U10 scope with carry-through (ENG-09).
- One comparator (DISK_EQ) based on the private index (ENG-07).
- Merges only with explicit bases, no -X, one conflict function and a post-merge identity check (ENG-11); only four tree operations (ENG-10).
- Epoch guard that freezes both directions on any git-detectable user operation or mass change (ENG-12).
- Apply through the two-phase per-path verifying writer in change-set closure groups, with defer set, coalescing, free-space check and round trip (ENG-14, ENG-15).
- Publish of (R, A_R) candidates: pre-push asserts; one push per window carrying code and board ops; observation-based result classification; ambiguous-push resolution; stop on non-retryable rejection (ENG-16..ENG-19).
- Governor mechanics per protocol (10a); push only on change (ENG-20).
- Rewrite-incident detection with displaced copies and human-typed recover (ENG-21).
- Branch moves: save completion, external-commit base moves with an exact-match per-path base, base-move holds (ENG-22).
- Human-typed save from an existing, checked live commit, pushing branch then board (ENG-23); U9 safe adopt (ENG-24).
- Genesis, join with preview, restart from the journal including writer rollback, lost-state per-path rebuild (ENG-25, ENG-26).
- Start probe: git and node floors, volume and hard-link checks, anonymous-readability check, filter and round-trip checks, one-time host capability probe (ENG-27).
- Protocol version gating (ENG-28); status.json health with loud transitions; work continues offline (ENG-29).
- Real-git property harness across Windows, macOS and Linux, with mutation testing (ENG-30).

## v1 refuse/defer
- v1: refuse - live mode in a linked worktree, including .claude/worktrees/* (ENG-02).
- v1: refuse - fetch URL != push URL at start; pause on any URL change mid-session (ENG-05; remote-url-drift).
- v1: refuse - remotes readable without credentials; SSH remotes on unknown hosts need a one-time human confirmation (ENG-27).
- v1: refuse - git < 2.43; node missing or < 20; tmp on a different volume than the worktree (ENG-27).
- v1: refuse - hosts that reject custom refs, unless the human opts in to refs/heads/cowork/<b>/{board,code}; refuse that fallback too where 2-parent commits are rejected (ENG-27; host-policy-and-ci).
- v1: refuse - branch rewritten or force-pushed (live base not an ancestor of the new branch head): save and base moves frozen, live continues on the old base (ENG-22).
- v1: refuse - join while HEAD is behind, ahead of or diverged from the live base (ENG-25). Exception: HEAD == new branch head while live lags, where the joiner may perform the base move itself.
- v1: refuse - save when host policy rejects the branch push (protected branch, required reviews, signatures). NEEDS USER SIGN-OFF on whether to offer a PR branch instead (ENG-23).
- v1: refuse - automatic bisection after a non-retryable push rejection whose message names no path; publishing stops until the human acts (ENG-19).
- v1: refuse - automatic recovery from a rewrite incident; only human-typed /cowork recover (ENG-21). v2: support - automatic recovery when all peers agree by ancestry.
- v1: save-only (carry-through in live) - submodule pointers, symlinks, filter=lfs paths, blobs >= 50 MiB, .gitattributes, .cowork/config.json, custom merge drivers, and quarantine-set paths without a human accept (ENG-09, ENG-15, ENG-16).
- v1: refuse - automatic adopt when any affected path differs from the saved content (U9 read literally); human-typed /cowork adopt offers the relaxed test (ENG-24).
- defer - '--atomic' pushes: never used, because save completion covers the gap (ENG-23).
- defer - staged-copy hashing (a VERIFIED alternative), used only if the Windows save-failure soak exceeds 1 failed save per 1,000 (ENG-08).
- v2: support - board rotation (a new genesis, with the old board archived under refs/cowork-archive/<b>/<n>).
- Outside this subsystem (the engine only provides the call points): claim mapping and region identity, hold-registry policy and the revert detector, Claude Code hook and gate semantics, messaging and IPC security. Findings owned there are not claimed here unless the engine has its own obligation (ordering, evaluation on the leased tip, re-run after a re-merge).

## interfaces
- REMOTE REFS: refs/cowork/<b>/board (authority, FF-only; each board commit = [prev board, live code]), refs/cowork/<b>/code (mirror, write-only for decisions), refs/cowork/<b>/displaced/<oid12> (incident copies), refs/cowork/probe-<peer_id> (start probe), refs/heads/<b> (save target; read for branch moves).
- LOCAL REFS: refs/cowork-remote/<b>/{board,code,branch}; refs/cowork-local/<b>/state (commit [LA_C, LA_B], tree {base, snap, journal, meta}); refs/cowork-local/<b>/holds (written by local-change-mgmt, carried as an outbox by every board push); refs/cowork-local/<b>/incident-<n>.
- FILES under <gitdir>/cowork/: <b>.index; tmp/ (.new/.old/.redo ring, scratch indexes incl. cmp.index, save-<n> worktrees, rt/ round-trip checkout, stage/); daemon.lock; status.json (health, read by hooks and the status line); peer_id.
- LIVE COMMIT FORMAT (written): '[skip ci] ***NO_CI***' at the start of the subject, plus the trailers Cowork-Base, Cowork-Saved-Live (save commit only), Cowork-CS (one per change-set, LCM-10), Cowork-Proto, Cowork-Writer and 'skip-checks: true'.
- CONSUMES from claude-integration over daemon IPC: seat and human leases; per-path fences (tool_use_id) and read leases; Bash/PowerShell transaction open/close per seat; hook attribution windows. ANSWERS gate queries from memory {path: applying-now | pending(reason) | frozen | incident}, waiting at most 250 ms for an in-flight write group.
- CONSUMES from local-change-mgmt: MASK(S_disk) -> S_pub and the INV-MASK check; revert-taint and mass-change detection on S_disk; ready captures (R, A_R) at change-set triggers; change-set ids for Cowork-CS trailers; T0 checks; hold-registry records (INCOMING, PIN, CONFLICTED, SNAPSHOT, base-move, restart) created and updated through its API. PROVIDES to it: the apply journal (for each written path: introduced and removed non-trivial lines, peer, CS id, local apply time).
- CONSUMES from data-handling: canon(blob, refBlob); the conflict function (path, stages) -> concat blob | take-TIP + CONFLICTED hold; scope and exclude config at EPOCH_BASE; the portability predicate; filter-driver discovery and preflight; the fsmonitor setting.
- CONSUMES from protocol: fold(board chain) -> claims, live set, protocol.json {proto, minReader, minWriter, budget, G_s, S_s}; pending ops to publish; LRU rank.
- CONSUMES from messaging-security: the secret tripwire scan over new blobs, the quarantine set and the message templates. EMITS events with ids: FROZEN, UNFROZEN, INCIDENT, NONRETRYABLE(message), OFFLINE, ONLINE, LOST_STATE, PHANTOM(path), DEFERRED(path, reason), BASE_MOVE_CONFLICT(paths), BASE_MOVE_EXACT_MATCH(paths), ADOPT_BLOCKED(paths, reasons), SAVE_REPORT, DISK_LOW, VERSION_PAUSED.
- HUMAN CLI VERBS implemented by the engine (not model-invocable where they move refs): /cowork start, stop, save, recover, resume, adopt, doctor. /cowork status reads status.json.

## rules
- **ENG-01** REF MODEL (merges protocol (9) with engine-model INV-FF). Per branch <b>, the remote holds exactly three refs the engine uses:
- refs/cowork/<b>/board is the AUTHORITY.
- refs/cowork/<b>/code is a MIRROR and is never an input to any decision.
- refs/heads/<b> is the real branch, moved only by save (ENG-23) or by humans.
live_code(X) := the LAST parent of board commit X. 'TIP' everywhere in the engine means live_code(fetched board tip).
BOARD COMMIT: parents [previous board commit, live code commit]; the genesis board commit has only [L0]. Its tree holds only protocol data (ops.jsonl, protocol.json, checkpoint/, held/), never code paths.
LIVE CODE COMMITS have exactly three shapes:
(a) ORDINARY: one parent, the previous live code commit.
(b) BASE-MOVE: two parents [previous live code commit, X], where X is a commit of refs/heads/<b> (never a live commit), with trailer 'Cowork-Base: <X>'.
(c) GENESIS L0: no parents, tree = tree(Hr), trailer 'Cowork-Base: <Hr>'.
The live base of a live commit = X of the newest base-move or genesis commit on its first-parent chain.
MARKERS: every live code and board commit message begins '[skip ci] ***NO_CI***' and carries the trailers 'skip-checks: true', 'Cowork-Proto: <n>' and 'Cowork-Writer: <peer_id>/<epoch>/<seq>'. Save commits carry none of these markers and are built only with 'commit-tree -p <Hb>'. So no branch commit ever has a live commit as an ancestor (Azure skips CI if ANY pushed commit has a marker).
NO RESET OP: the code pointer moves only along first parents, saves included (INV-FF). A code-pointer move that is not a first-parent fast-forward is always an incident (ENG-21).
Engine-model's code-ref lease and three-ref fetch are replaced by board-leased publishes (ENG-17). Board commits are never merged; a CAS loser only rebuilds its board commit on the new tip.
Principles: P3 (one CAS point), P5, P6 (non-atomic-pair-and-fence VERIFIED; dp2/x1 steps 2-4 VERIFIED).  _(covers: non-atomic-pair-and-fence, op-identity-cursors-board-merge, host-policy-and-ci)_
- **ENG-02** STORAGE. All daemon git state lives in the user's own repository: the same GIT_DIR, object store, config, attributes and filters. There is no private GIT_DIR, no alternates, no refs/worktree/*, and no state.json as a source of truth.
LOCAL REFS: all in the common namespace, every update run with '-c core.logAllRefUpdates=always':
- refs/cowork-remote/<b>/{board,code,branch} (fetch targets);
- refs/cowork-local/<b>/state (ENG-03);
- refs/cowork-local/<b>/holds (hold registry; policy owned by local-change-mgmt);
- refs/cowork-local/<b>/incident-<n>.
FILES under $(git rev-parse --git-path cowork)/, always resolved to absolute paths:
- <b>.index (private index, a rebuildable cache);
- tmp/ (writer .new/.old ring, scratch indexes, save worktrees, staging copies);
- daemon.lock {pid, process start time};
- status.json;
- peer_id (128-bit random per clone);
- IPC rendezvous info.
CLAUDE_PLUGIN_DATA holds only the IPC key and runtime copies; deleting it never changes sync state.
LOST STATE: a running daemon re-reads refs/cowork-local/<b>/state each loop. If that ref, or any object it names, is missing, the daemon does NOT re-initialise or re-join. It freezes the branch and waits for a human-typed '/cowork resume' (ENG-26 LOST STATE).
LINKED WORKTREES: live mode is refused (v1) when 'git rev-parse --git-dir' != '--git-common-dir'. This covers linked worktrees, including .claude/worktrees/*.
SINGLE INSTANCE: a second daemon on the same clone refuses to start while daemon.lock names a live process with the same start time. A stale daemon.lock is taken over, and only the daemon's own lock files under cowork/ (e.g. <b>.index.lock) are removed. .git/index.lock is never touched except under ENG-24's journal check.
GC: the daemon never runs gc. The user's auto-gc is safe, because everything needed across loops is reachable from refs/cowork-local/* and their reflogs (kept for gc.reflogExpire, default 90 days).
Principles: P1, P3, P6 (park-refs-in-worktree-namespace-vanish VERIFIED; objects-only-in-private-index e8 VERIFIED; e7 reflog VERIFIED).  _(covers: park-refs-in-worktree-namespace-vanish, uninstall-deletes-state-daemon-orphaned, orphan-daemon-uninstall, no-history-undo)_
- **ENG-03** STATE REF AND THE PER-PATH BASE A. refs/cowork-local/<b>/state points to one commit:
- parents: [LA_C, LA_B];
- tree: base -> tree A; snap -> tree S_disk; journal -> blob (JSON apply | push | adopt intent; empty when idle); meta -> blob (JSON: live base Hb, H_adopt, EPOCH_BASE, expected epoch {symbolic HEAD, HEAD oid, refs/stash oid}, pending paths with reasons, pinned URL, protocol version).
LA_C = the newest remote live code commit processed: each of its changes is on disk or is a pending path. LA_B = the last board commit folded.
Both are only ever commits that exist on the remote (fetched, or this peer's own push confirmed by 'ok' or by a later fetch). Both move only forward along first parents.
LA_B is a PARENT, not a meta field, so it stays reachable after a '+' fetch overwrites refs/cowork-remote/<b>/board. (This extends the binding's parents=[LA_C].)
THE BASE A:
- A[p] = tree(LA_C)[p], except pending INCOMING paths, which keep the older team blob actually underlying the disk.
- A[p] changes only after a verified write of p (ENG-14), or after a confirmed push in which p went out with C[p] == R[p] (ENG-17).
- A is never computed from ancestry, never seeded from TIP, never taken from a masked tree (S_pub), and never taken from a merge result that was not fetched.
- When nothing is pending, A == tree(LA_C).
Every transition is exactly one 'git update-ref refs/cowork-local/<b>/state <new> <old>'. A CAS failure means a second writer exists, and the daemon exits.
Principles: P1, P3, P6 (naive-push e1, pending-path-base-misset-reverts and absorbed-hold-evades-history-detectors VERIFIED).  _(covers: pending-path-base-misset-reverts, absorbed-hold-evades-history-detectors, stale-base-after-crash)_
- **ENG-04** ONE GIT WRAPPER AND BLOB PRODUCTION. Every daemon git call goes through one wrapper. The wrapper does all of the following.
SPAWN: stdin ignored, so Git for Windows' 'Unlink ... try again? (y/n)' can never block; windowsHide; the daemon env allowlist plus LC_ALL=C, LANGUAGE= (empty), GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never and GIT_OPTIONAL_LOCKS=0.
CONFIG FLAGS:
- always: '-c gc.auto=0 -c maintenance.auto=false -c core.hooksPath=<empty user-only dir under cowork/> -c core.fsmonitor=<true|false, data-handling rule> -c core.quotePath=false -c core.logAllRefUpdates=always';
- on Windows: '-c core.longpaths=true';
- on every attribute-reading command (add, update-index --add/--refresh, hash-object --path, cat-file --filters, merge-tree, merge-file --object-id, check-attr, diff): '-c attr.tree=<EPOCH_BASE>';
- '-c filter.<d>.required=true' for every discovered filter driver, plus '-c filter.lfs.required=true'.
OUTPUT AND PATHS: reads only -z / --porcelain output. Passes GIT_INDEX_FILE, --git-dir and --work-tree as ABSOLUTE paths (VERIFIED sweep/engine_rc: a relative GIT_INDEX_FILE combined with --work-tree resolved inside the work tree and failed 'Unable to create ...index.lock').
FAILURES: any non-zero exit fails that step; partial stdout is never used.
WATCHDOGS kill the whole process tree (Windows 'taskkill /T /F', POSIX process group): fetch 45 s, push 90 s, any local command 120 s (catches a hung filter).
BLOB PRODUCTION: blobs are created ONLY by:
(a) the private-index 'git add' (ENG-08);
(b) 'git hash-object -w --path=<p>' with the required-filter flags (records of denied edits);
(c) 'git hash-object -w --stdin --no-filters' for canon output (data-handling).
Board records (held/, proposed blobs) therefore carry only clean-path blobs, never smudged plaintext.
BYTES: file bytes are Node Buffers end to end. JS decodes text only for read-only analysis, with TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).
CI LINT rejects: any git spawn outside the wrapper; 'hash-object --stdin' without --path or --no-filters; fs.writeFile*/fs.write with a string payload in daemon code; any -X option on merge-tree.
Principles: P2, P3, P6 (filter-passthrough-leak e1/ed-e6/sec-t1 VERIFIED; sec/t7 required=true -> exit 128 VERIFIED; DH4 attr.tree VERIFIED; t4_hooks.sh VERIFIED; daemon-text-handling VERIFIED).  _(covers: filter-passthrough-leak, secret-filter-passthrough, secret-filter-fails-open-in-daemon-env, gitattributes-edit-unfilters, synced-execution-surfaces, daemon-text-handling-corrupts-cp949-bom, splice-text-from-worktree-leaks-secret, board-plaintext-and-permanence)_
- **ENG-05** TRANSPORT: PINNED URL, FETCH, AUTH, BACKOFF.
PINNED URL: at /cowork start the daemon resolves U_fetch = 'git remote get-url <remote>' and U_push = 'git remote get-url --push <remote>', with insteadOf / pushInsteadOf expanded. If they differ, start is refused (v1). The resolved URL and the repo identity (root commit oids reachable from Hb) are pinned in state meta and in the join op. Every network call uses the literal pinned URL, never the remote name.
DRIFT: each loop re-resolves both URLs (local config read only). Any difference pauses the branch with 'remote URL changed from <a> to <b>; run /cowork doctor', and no network call is made to the new URL.
FETCH is exactly:
'git -c fetch.fsckObjects=true -c protocol.version=2 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 fetch --no-tags --no-write-fetch-head --no-auto-maintenance <URL> +refs/cowork/<b>/board:refs/cowork-remote/<b>/board +refs/cowork/<b>/code:refs/cowork-remote/<b>/code +refs/heads/<b>:refs/cowork-remote/<b>/branch'
Refspecs are explicit only, never refs/cowork/* wildcards. The mirror is fetched only to supply its lease value.
SSH: the user's core.sshCommand / GIT_SSH_COMMAND gets ' -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3' appended, never replaced.
USER REFS: the daemon never writes FETCH_HEAD, ORIG_HEAD, refs/remotes/* or refs/heads/*. The sole exception is the ENG-24 adopt.
FAILURE CLASSES (parsed under LC_ALL=C):
- auth: HTTP 401/403, 'Authentication failed', 'could not read Username', 'Permission denied (publickey)';
- network: DNS, connect, 'Operation too slow', watchdog kill;
- host: 5xx/429.
Auth and network failures back off exponentially (30 s -> 60 s -> ... -> 5 min, no bursts) and feed the OFFLINE state (ENG-29). Credentials are never stored and never prompted for.
Principles: P2, P5, P6 (fetch-head-hijack e5 VERIFIED; blackhole.js VERIFIED: default fetch hung > 25 s, lowSpeedTime=5 failed in 5 s).  _(covers: remote-url-drift, fetch-head-hijack-and-auto-maintenance, hung-network-git-after-sleep, offline-auth-claims)_
- **ENG-06** TYPED OIDS AND REFSPECS.
- Every oid the engine uses is parsed from git stdout into a typed Oid that accepts only /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.
- Each Oid is verified with 'git cat-file -e <oid>^{commit}' (or ^{tree}) before it reaches commit-tree, update-ref or a refspec.
- Pushes are composed only by push(newOid: Oid, ref: RefName, lease: Oid | ABSENT). This function cannot emit a refspec with an empty source (':ref' = delete).
- Remote deletion exists in ONE separate function that accepts only refs/cowork/probe-<peer_id> (ENG-27).
- Before any push, OUT must not be the empty tree (4b825dc642cb6eb9a060e54bf8d69288fbee4904, or the sha256 equivalent) unless tree(TIP) is empty too.
Principles: P2, P6 (empty-oid-push-deletes-live-ref VERIFIED: 'push ... origin :refs/cowork/main/code' deleted the live ref).  _(covers: empty-oid-push-deletes-live-ref)_
- **ENG-07** ONE DISK COMPARATOR. The question 'are the bytes at p equal to blob X' is answered by exactly one function, DISK_EQ(p, X). Its users: the writer pre-image check and round trip (ENG-14), the restart journal decision and lost-state rebuild (ENG-26), adopt (ENG-24) and the join preview (ENG-25).
DISK_EQ uses git's own check-in path WITH INDEX CONTEXT, never bare 'git hash-object --path':
(1) If the private-index entry for p already holds X: run 'git update-index -q --refresh -- <p>' on the private index. Up to date <=> equal. This is git's stat rule, and it re-hashes racily clean entries. Variant (1) also covers an entry restored without stat data (ENG-08 step 5): the refresh re-hashes the file with index context.
(2) Otherwise, work in a SCRATCH copy of the private index (<gitdir>/cowork/tmp/cmp.index), so the real entry is never left pointing at X without stat data: run 'git update-index --cacheinfo <mode>,<X>,<p>', then the same refresh.
MANY CANDIDATES PER PATH (ENG-26 lost-state): hash the disk once ('git add' into the reseeded index -> raw blob), then compare canon(raw, ref=candidate) == candidate in memory for each candidate. canon is a pure byte transform, and candidates are read via one 'cat-file --batch'. The cost is one git process per path, not per candidate. (ENG-22's exact-match base compares trees only and needs no disk.)
BYTES NOT AT p (the writer's tmp/<n>.old) are compared by stat identity (size, mtime_ns, file id/inode) against the stat captured at p immediately before the rename.
EVIDENCE (VERIFIED in sweep/engine_rc, git 2.55.0.windows.3, core.autocrlf=true, a BOM+CRLF file stored i/crlf):
- 'git hash-object --path=big.py big.py' = a40da32, while the stored blob = 32315a1 (same result with GIT_INDEX_FILE seeded);
- 'git add' into the private index kept 32315a1;
- '--cacheinfo 32315a1' + '--refresh' reported up to date.
So the binding's hash-object comparisons (writer steps 3 and 5, restart, adopt) would flag every write of an i/crlf file (possibly hub.py) both as a concurrent edit and as a phantom path.
CI LINT: no 'hash-object --path' result is ever compared for equality with a stored blob.
Principles: P3, P6.  _(covers: apply-clobbers-concurrent-save, phantom-delta-pingpong-convergence, eol-bom-stored-form-flip)_
- **ENG-08** SNAPSHOT. S_disk is built from the persistent private index <gitdir>/cowork/<b>.index. It is never built with 'git add -A' and never reseeded per loop; it is reseeded only on join or recovery ('read-tree <tree>' + 'update-index -q --refresh').
(0) No snapshot runs while any live seat on this worktree has an open Bash/PowerShell transaction (LCM-15, cap 120 s).
(1) Candidates = 'git diff-files --name-only -z' on the private index (stat-dirty tracked paths), plus U10-admitted new files (ENG-09).
(2) A candidate is hashed this loop only if its mtime is >= 300 ms old and it is not under a live Edit/Write/NotebookEdit fence. Otherwise its previous entry is kept.
(3) A tracked path missing on disk is staged as a removal only if it was also missing in a snapshot >= 1 s earlier, or if the removal falls inside a hook-attributed window (Claude tool, Bash/PowerShell transaction, git rm). Editor temp names (ENG-09) are never admitted, so an atomic save never shows up as a rename.
(4) Run 'GIT_INDEX_FILE=<abs> git add --ignore-errors --pathspec-from-file=- --pathspec-file-nul' with the stable list (user's config and filters, attr.tree pin, required filters).
- Exit 1 with 'unable to index file <p>' (LC_ALL=C) marks p UNREADABLE for this loop: its entry keeps the previous blob, p is excluded from the outgoing delta (S_pub[p] := A[p]), and p is added to the apply defer set.
- Exit 128 with 'fatal: <p>: clean filter '<d>' failed' marks p LOCAL-ONLY (data-handling filter rule). Nothing is published this loop, and the next loop excludes p. VERIFIED in sweep/engine_rc: under required=true a failing or missing clean command aborts the WHOLE add with rc 128 and leaves the entry unchanged, so --ignore-errors alone is not enough.
- Any other non-zero exit fails the snapshot.
(5) Every hashed path is re-stat'ed after the add. If (size, mtime_ns) changed, its previous entry is restored ('update-index --cacheinfo') and the path is excluded this loop.
(6) A non-empty -> empty change, or a shrink of more than 50%, is excluded until it is stable across two snapshot loops and attributable (LCM-15 SNAP-3).
(7) S_raw = 'git write-tree' (validated, ENG-06). S_disk = canon(S_raw), built in a scratch index by applying data-handling's canon to each path in diff(A, S_raw). The private index keeps S_raw, so its stat data stays valid. Canon output is the only form any merge or push sees.
MEASURED COST: 54-60 ms per loop with a stat-fresh index, vs 750-1000 ms when reseeded (VERIFIED).
RESIDUAL (VERIFIED sweep/engine_rc/daemon.js, 1.3 MB BOM+CRLF file, truncating saves every 50-150 ms): an editor save that starts while git hashes the file fails with UNKNOWN (-4094):
- 9/140 saves failed with back-to-back adds;
- 0/138 failed with one add per 2.5 s;
- derived mapping window: about 2-4 ms per add.
ACCEPTANCE: the Windows soak (ENG-30) must show <= 1 failed save per 1,000 saves. If not, step (4) switches to staged hashing: Node copies the stable bytes to <gitdir>/cowork/tmp/stage/<p>, then runs the same 'git add' with --work-tree=<stage>, and deletes the staging copy after the add. Staged hashing is VERIFIED in sweep/engine_rc: byte-identical blobs (44679639 / 68c443d1 in both modes), the clean filter ran from attr.tree, it failed closed under required=true, and 0/139 saves failed.
Principles: P2, P3, P6.  _(covers: locked-file-stalls-snapshot, snapshot-captures-half-written-file, atomic-save-window-publishes-deletion, torn-snapshot-publishes-empty-file, filter-passthrough-leak, secret-filter-fails-open-in-daemon-env, peer-normalization-secret-leak, eol-bom-stored-form-flip)_
- **ENG-09** SCOPE ADMISSION AND CARRY-THROUGH (U10; data-handling's scope rule, used as the engine's admission function).
NEW UNTRACKED FILES come only from 'GIT_INDEX_FILE=<abs> git ls-files -o --exclude-standard -z' (honours repo .gitignore files, info/exclude and core.excludesFile), minus:
- the U10 secret-like list (.env*, *.pem, *.key, *.pfx, *.p12, id_rsa*, id_ed25519*, *credentials*, secrets.json, *.tfstate, .npmrc, .pypirc, appsettings.*.json, local.settings.json), plus config additions;
- the editor/OS temp list (*.swp, *.swo, 4913, #*#, .#*, *~, *.orig, *___jb_tmp___, *___jb_old___, ~$*, .DS_Store, Thumbs.db, desktop.ini, .vs/**);
- every directory containing a .git file or directory, .claude/worktrees/**, and submodule paths;
- filter=lfs paths;
- portability failures;
- '.cowork/config.json' exclude globs (read at EPOCH_BASE);
- new files > 1 MB.
SIZE: tracked-in-live paths are exempt from the 1 MB cap, so hub.py syncs. Any blob >= 50 MiB makes its path save-only.
CARRY-THROUGH: for every excluded path, the snapshot keeps A's entry (never staged as a removal), the writer never writes or deletes it, and save keeps its base entry.
SPECIAL MODES: every 160000 entry is forced to A's value ('update-index --cacheinfo 160000,<A oid>,<p>'); every 120000 entry keeps A's mode and target.
STATUS lists each present-but-unshared file as 'not shared (<reason>)'.
Principles: P1, P4, P6 (untracked-sweep e12, editor-fs e12, wt/e12 gitlinks, sec T5b VERIFIED).  _(covers: untracked-sweep, untracked-sweep-editor-temp-and-secrets, sync-scope-excludes-and-untracked, worktree-isolation-gitlink-and-unmapped-edits)_
- **ENG-10** ALLOWED TREE OPERATIONS (NO SYNTHESIS). The engine produces trees by exactly four operations:
(1) 'git write-tree' of the private index.
(2) 'git merge-tree --write-tree -z --merge-base=<explicit tree> <ours> <theirs>'.
(3) Whole-path entry replacement in a scratch index ('update-index --cacheinfo' / '--force-remove'), using only blobs that already exist in git: PIN to A[p], conflict take-TIP, carry-through, canon output, 160000/120000 forcing, change-set closure surgery, the base-move per-path base B'.
(4) commit-tree of an EXISTING tree: save uses tree(Lk); base moves use tree(TIP) or a clean merge result.
The engine never subtracts hunks or symbol ranges from a blob, never splices symbol text into a blob, never uses a merge result that contains conflict markers, and never checks out or applies a stored .patch.
A CI lint fails the build on any other tree-producing code path. Every published or saved path is therefore a whole blob that existed on some disk, in the live chain, or in a clean merge result.
Principles: P3, P6 (hunk-withdrawal x2/x1b, intra-file-withdrawal, move-splice-duplicates, csharp-overload-group-splice VERIFIED).  _(covers: hunk-withdrawal-publishes-signature-without-callers, intra-file-withdrawal-mangles-file, move-splice-duplicates, csharp-overload-group-splice, splice-source-stale-board-text)_
- **ENG-11** MERGE AND CONFLICT ROUTING. Every 3-way merge of local work uses the same form:
- apply: M_disk = merge(A, S_disk, TIP);
- publish: OUT = merge(A_R, R, TIP);
- base move: merge(B', TIP, Hr).
Each runs 'git merge-tree --write-tree -z --merge-base=<explicit tree>' with the ENG-04 -c set; NO -X option (never renormalize, ours or theirs); no --union; object-store inputs only, never working-tree files.
'git merge-base' on cowork refs, and merge-tree without --merge-base, are forbidden (CI lint).
EXIT 0: the result is accepted only after the region group's post-merge identity check passes for every path changed on both sides. A failing path is treated as conflicted. (merge-misplaces-edit-into-same-tail-neighbor VERIFIED: exit 0 moved an edit into a same-tail neighbour.)
EXIT 1: the conflicted paths (from merge-tree's -z conflicted-file-info section) and the identity-check failures go to the ONE conflict function of data-handling, identically on the apply side and the publish side. That function tries the insertion-concat fast path first; otherwise TIP's entry wins on disk and in OUT, and the whole LOCAL blob becomes one CONFLICTED hold record. The result tree is rebuilt by whole-path replacement (ENG-10). merge-tree's marker-bearing blobs are never written, indexed, held or pushed.
EXIT > 1: the loop step fails, and nothing is written or pushed.
Principles: P1, P3, P6 (e2 explicit base, DH2/DH3 renormalize, e5/DH6 union VERIFIED).  _(covers: explicit-base-not-ancestry, conflict-tree-applied-or-auto-resolved, disjoint-claims-textual-conflict, merge-misplaces-edit-into-same-tail-neighbor, eol-renormalization-whole-file-conflict)_
- **ENG-12** EPOCH GUARD = ONE FREEZE (merges engine-model loop step 0, the LCM-6 SNAPSHOT freeze and the mass-change breaker).
READS: each loop first reads, with GIT_OPTIONAL_LOCKS=0 and paths from 'git rev-parse --git-path':
- symbolic HEAD, HEAD oid, refs/stash oid, HEAD reflog length, ORIG_HEAD oid;
- the markers MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, REBASE_HEAD, AUTO_MERGE, BISECT_LOG, BISECT_START, rebase-merge/, rebase-apply/, sequencer/;
- unmerged entries in the user's index ('git ls-files -u -z');
- index.lock.
EXPECTED EPOCH: symbolic HEAD == refs/heads/<b>, HEAD == H_adopt, stash oid == meta's, no marker, no unmerged entry.
INDEX.LOCK: while it exists, the loop does no snapshot, apply, adopt or publish (fetch continues). After 30 s (local monotonic) it is reported loudly as stale.
TRIGGERS: any other deviation, and every local-change-mgmt mass-change trigger (unobserved delta > max(10 files, 2% of tracked files), or deletion of a file with peer provenance), creates ONE SNAPSHOT record in the hold registry.
FREEZE: while any SNAPSHOT record is ACTIVE, the branch is FROZEN for this peer in BOTH directions:
- fetch and fold continue;
- no apply, no code publish, no adopt, no save, and no base move by this peer;
- board-only pushes continue (last parent repeats TIP: claims, hold mirrors, the single 'paused: <reason>' event), so held bytes still become remote-durable.
NOTICES: the human (status line + OS notification) and each live seat's Claude on this worktree (next hook output) are told.
RELEASE happens only:
- automatically, when the epoch is back to expected (e.g. HEAD back on <b> at H_adopt, stash oid restored) and the unobserved delta is under the threshold;
- when HEAD equals a new live base produced by ENG-22 from this peer's own pushed commit (H_adopt := HEAD);
- by human-typed '/cowork resume' (runs the ENG-26 per-path rebuild) or '/cowork resolve <id> --restore|--publish'.
Every release re-runs the LCM-5 revert detector over the whole pending delta before any publish. A freeze is never released on a timeout. The daemon's own adopt pre-registers its new epoch in the journal.
Principles: P2, P3, P4, P6 (marker survey sweep/lifecycle/mk; e17/e10/e13/e3 stash, restore and checkout; exp_k_stash VERIFIED).  _(covers: user-git-ops-broadcast-as-revert, git-ops-publish-team-revert, branch-switch-publishes-other-branch, worktree-reset-commands-broadcast-revert, local-git-ops-propagate-as-reverts, human-git-mass-revert, bash-git-verbs-revert-and-markers, in-progress-ops-not-paused-conflict-markers-broadcast, b-bypass-revert-of-unsaved-peer-work, breaker-freezes-publish-not-apply)_
- **ENG-13** LOOP ORDER AND TRIGGERS. One daemon per clone, one iteration at a time per branch. Period: 2.5 s while any local seat is active or work is pending, 10 s when idle.
The loop applies and publishes only while all three hold:
(a) the daemon holds a valid seat or human lease (claude-integration lifetime rule). With no lease for 2 min, the loop stops applying and pushing, so a daemon orphaned by uninstall, disable or update cannot keep syncing;
(b) gating states allow it:
- INCIDENT (ENG-21) and FROZEN (ENG-12) stop apply and code publish; FROZEN still allows board-only pushes;
- NONRETRYABLE (ENG-19) and own proto < minWriter stop publishing only;
- own proto < minReader stops fold beyond that commit, apply and publish (ENG-28);
(c) journal recovery has completed (ENG-26).
STEPS:
0. Epoch guard.
1. Fetch (ENG-05).
2. Board INV-FF check and fold (ENG-21), then branch-move handling (ENG-22).
3. Snapshot (ENG-08).
4. Outgoing guards. The hold-registry detectors (LCM-5 revert taint, LCM-6 breaker) run on the NEW S_disk BEFORE any merge of this loop, so a stale-buffer save, a /rewind 'Restore code' or a Bash rewrite saved in the same loop as an incoming change is classified before it can be blended. Then S_pub = MASK(S_disk), and INV-MASK is checked.
5. APPLY whenever ANY path has A[p] != TIP[p], using S_disk (never S_pub) as 'ours'. Not merely when TIP != LA_C: after this peer's own push sets LA_C := C, a pending INCOMING path still has A[p] != C[p] and must be retried as soon as its defer reason clears. The binding's 'APPLY if TIP != LA_C' would starve it.
6. PUBLISH when a ready candidate has a non-empty diff(A_R, R), or board ops are pending (ENG-16/17).
Steps 5 and 6 each end with one state update-ref.
Principles: P2, P3 (masked-tree-as-apply-base-starves, pending-path-base-misset-reverts and absorbed-hold VERIFIED).  _(covers: stale-editor-buffer-reverts-peer-work, rewind-restore-code-reverts-teammates, masked-tree-as-apply-base-starves, pending-path-base-misset-reverts, orphan-daemon-uninstall, orphan-daemon-outlives-sessions-and-plugin)_
- **ENG-14** APPLY = PER-PATH VERIFYING WRITER IN CLOSURE GROUPS.
NO GIT WRITES TO THE WORKTREE: read-tree -u, checkout-index, checkout, switch, restore, reset --hard, stash and apply are forbidden in daemon code (CI lint).
WRITE SET: W = diff(S_disk, M_disk) minus the defer set D (ENG-15), partitioned into closure groups (ENG-15).
JOURNAL FIRST: before any .new is prepared, the apply intent {A, S_disk, M_disk, TIP, group map n -> (path, kind)} is written to the state journal with one update-ref. ENG-26 uses it to roll back.
PREPARE, per group: every target's bytes come from one persistent 'git cat-file --batch --filters' (input '<oid> <path>') and are written as Buffers to <gitdir>/cowork/tmp/<n>.new, on the same volume as the worktree. ENOSPC here leaves p untouched and defers the group.
RE-CHECK D for every path immediately before phase 1, so a fence or transaction opened after the apply began stops every write not yet started.
PHASE 1, per path:
(a) DISK_EQ(p, S_raw[p]) (ENG-07 variant 1; the private-index entry is S_raw[p], with or without stat data). If not equal, p changed since the snapshot: re-snapshot p and re-merge with 'git merge-file -p --object-id' (base S_disk[p], ours = found, theirs M_disk[p]). Clean -> retry with that target (max 3 times). Conflict -> defer the group.
(b) lstat p (st0); rename p -> tmp/<n>.old (EBUSY/EPERM/EACCES -> reason 'locked'); lstat of .old must equal st0 (size, mtime_ns, file id), else roll back.
CREATIONS lstat p first. If anything is there (untracked or ignored), the group is rolled back and p becomes an INCOMING hold, with the local bytes untouched.
PHASE 2, per path: fs.link(.new, p), then unlink .new. EEXIST (someone recreated p) rolls back the group. A deletion keeps only the .old. The executable bit follows M's mode where core.filemode=true.
ROLLBACK moves every already-linked p of the group back to tmp and re-links its .old. A failed group therefore leaves every path exactly as before (no half change-set on disk).
ROUND TRIP per written p, on the private index: 'update-index --cacheinfo <mode>,<M_disk[p]>,<p>', then 'update-index -q --refresh -- <p>'. For a deletion: 'update-index --force-remove -- <p>' and an lstat showing p absent. 'needs update' = PHANTOM path: PIN hold, never published, human and Claude told. This is the ping-pong breaker.
RING: .old files are kept >= 2 s and lstat-compared with their post-rename stat before deletion. A change means a late write through an open handle. Those bytes are merged back as a local edit ('merge-file --object-id', base S_disk[p]) through this same writer, or held if that merge conflicts.
NO HARD LINKS: such volumes fall back to rename-over (logged once at start).
ACCEPTED COST: readers may see ENOENT for the milliseconds between a group's phase 1 and phase 2. They never see a zero-byte or partial file.
AFTER THE BATCH:
- A[p] := TIP[p] for every written path and every path where M_disk[p] == S_disk[p]; deferred paths keep A[p];
- LA_C := TIP; LA_B := folded board tip; one state update-ref;
- the apply journal (LCM-5 detector input) records each written path's introduced and removed non-trivial lines, with peer and CS id.
Principles: P1, P2, P3, P6 (ed/e3 lost.js 6/6 clobbers; e2/e6 partial apply; e14 ignored overwrite; ed/e4 readers; partial-apply-on-lock-splits-cs VERIFIED).  _(covers: apply-clobbers-concurrent-save, partial-apply-on-lock, partial-apply-on-locked-file, apply-partial-on-file-lock, readers-see-missing-or-empty-files, ignored-file-overwrite, receiver-path-deferral-materializes-half-cs, phantom-delta-pingpong-convergence, daemon-text-handling-corrupts-cp949-bom, disk-full-or-locked-file-partial-apply-broadcast)_
- **ENG-15** DEFER SET, CHANGE-SET CLOSURE, COALESCING, FREE SPACE.
THE DEFER SET D = paths not written this apply:
- paths under a live fence or read lease (claude-integration);
- EVERY path while a Bash/PowerShell transaction of a live seat on this worktree is open (nothing is applied then);
- UNREADABLE paths;
- CONFLICTED paths whose lease is live;
- quarantine-set paths (messaging-security EXEC-SURFACE: never applied live without a human accept);
- incoming 120000/160000 changes;
- paths this OS cannot materialize: Windows-reserved names CON/PRN/AUX/NUL/COM1-9/LPT1-9 with any extension; <>:"|?* or control characters; a trailing dot or space; repo-relative length > 200; a case-fold or NFC collision with an existing disk path;
- paths whose incoming blob has an EOL/BOM form different from A's form (data-handling protocol violation);
- locked paths and creation collisions (ENG-14);
- the CHANGE-SET CLOSURE: every path of every incoming change-set that shares a change-set with a deferred path, iterated to a fixed point (LCM-16). Change-sets come from the Cowork-CS trailers of the live commits in LA_C..TIP; a commit without trailers is one change-set.
INCOMING RECORDS: each closure becomes, or refreshes, ONE INCOMING hold record with LA_eff, built only from fetched blobs. Its paths keep A[p] and are retried every loop by a fresh 3-way merge (base A[p], ours = current disk, theirs = current TIP[p]), never by writing a cached blob. A deferred closure never blocks other closures (INV-RECEIVE).
UNMATERIALIZABLE paths stay in the tree and are never deleted by later snapshots (carry-through). Every other path still applies.
COALESCING:
- at most one apply per 10 s per worktree (apply_min_interval);
- at most one apply per 2 min into files in the full-read set of a mid-turn seat (claude-integration budget).
GATE QUERIES are answered from memory. If a path is between its group's phase 1 and its round trip, the gate waits for that group, bounded at 250 ms. A group's phase 1 + phase 2 are renames and links only, about 1-2 ms per path.
FREE SPACE: an apply starts only if the worktree volume has >= 2 x (bytes to write) + 256 MB free. Otherwise the whole apply is deferred with a loud 'disk nearly full' notice.
Principles: P2, P3, P4, P6 (e4/e9/e13 portability; receiver-path-deferral; dev-servers-restart VERIFIED).  _(covers: poison-path, unrepresentable-paths-wedge-or-half-apply, fence-vs-inflight-apply-and-stuck-fence, receiver-path-deferral-materializes-half-cs, dev-servers-restart-and-crash-on-split-apply, disk-full-or-locked-file-partial-apply-broadcast, synced-execution-surfaces)_
- **ENG-16** PUBLISH CANDIDATE AND PRE-PUSH ASSERTS.
THE CANDIDATE is a pair (R, A_R): R = an S_pub tree; A_R = the per-path base A at the moment R was captured.
- By default, R = S_pub recomputed after this loop's apply, and A_R = A.
- When local-change-mgmt captures a ready tree at a change-set trigger (LCM-11: Stop, green checkpoint, cowork_checkpoint), that (R, A_R) is stored in the state journal and later published unchanged. A newer capture supersedes an older one.
- The engine never chooses which change-sets a capture includes.
OUT = merge(A_R, R, TIP) (ENG-11).
PRE-PUSH ASSERTS, each mandatory. A failure aborts the push, opens a doctor record, and alerts the human and the session loudly.
(a) Bnew's first parent == fetched board tip == lease value. Bnew's last parent is one of:
- TIP (no code delta);
- an ORDINARY C with exactly one parent, TIP;
- a BASE-MOVE/SAVE commit L' with first parent == TIP, second parent == the branch commit named in its 'Cowork-Base' trailer, and tree == ENG-22's newtree (or tree(TIP) for a save's Ls).
For L', asserts (a) and (d)-(h) apply; (b) and (c) are replaced by ENG-22's guard on diff(TIP, newtree), since L' has no (R, A_R).
(b) paths(diff(TIP, OUT)) is a subset of paths(diff(A_R, R)).
(c) For every p with R[p] == A_R[p]: OUT[p] == TIP[p].
(d) OUT is a validated, non-empty tree oid (ENG-06).
(e) No blob in diff(TIP, OUT) contains a line matching ^(<{7} |={7}$|>{7} |\|{7} ), after stripping a trailing CR, that is absent from both R[p] and TIP[p].
(f) Every new blob passes the messaging-security secret tripwire.
(g) No 160000 or 120000 entry differs from TIP.
(h) No quarantine-set or save-only path (.gitattributes, .cowork/config.json, filter=lfs, blobs >= 50 MiB, custom merge drivers) differs from TIP.
NEVER PUSHED: a raw snapshot, a stack of local commits, or S_disk as a fallback.
C = 'commit-tree OUT -p TIP', with the ENG-01 markers and one 'Cowork-CS:' trailer per included change-set (LCM-10).
Principles: P2, P3, P6 (naive-push e1, conflict-markers-enter-live-ref, in-progress-ops cherry-pick markers VERIFIED; x12 capture-at-trigger VERIFIED in simulation).  _(covers: pushed-tree-must-be-merge-result, naive-push-reverts-unapplied-paths, conflict-markers-enter-live-ref, in-progress-ops-not-paused-conflict-markers-broadcast, debounce-splits-every-multifile-turn)_
- **ENG-17** PUSH, OBSERVABLE RESULT CLASSIFICATION, STATE UPDATE.
ONE PUSH: a publish is ONE 'git push --porcelain --no-verify <URL>' with two refspecs:
- '--force-with-lease=refs/cowork/<b>/board:<fetched board tip> <Bnew>:refs/cowork/<b>/board';
- '--force-with-lease=refs/cowork/<b>/code:<fetched mirror value | ABSENT> <live_code(fetched board tip)>:refs/cowork/<b>/code'. The mirror lags one publish and is never set to Bnew's own code commit.
Add '-o ci.skip' only when the start probe recorded push-options.
Bnew = commit-tree <board tree: this publish's ops, every not-yet-mirrored hold-registry record (outbox, LCM-1), protocol data> -p <fetched board tip> -p <C, or TIP when there is no code delta>. Everything pending is coalesced into this one push.
JOURNAL: before pushing, the journal records {push intent: Bnew, C, R, A_R}.
RESULT is decided by OBSERVATION, never by message text.
'ok' on the board line:
- LA_C := C, LA_B := Bnew;
- A[p] := C[p] for every p where C[p] == R[p] and A[p] still == A_R[p] (no apply wrote p since capture); other paths keep A[p];
- journal cleared; one state update-ref.
For a base-move or save commit L' (no (R, A_R)), 'ok' advances only LA_B. LA_C and A stay, and the next loop applies L' through ENG-14 (apply trigger A[p] != TIP[p]). A base-move or save-completion push carries no local code delta; that delta waits for the next window and merges against L'.
ANYTHING ELSE (rejected, no per-ref status, transport error, watchdog kill): fetch the board, then:
- Bnew is on the new tip's first-parent chain -> treat as 'ok'. Bnew's oid is deterministic: it contains this peer's unique op ids.
- Else, board tip != the lease value -> CAS LOSS, retryable: re-fold, re-merge, re-run every guard (ENG-18), wait for the next governor window. Never retry immediately.
- Else (board tip == lease value and the push did not land) -> NON-RETRYABLE (ENG-19).
Why not text: a server-side lease loss can arrive as '[remote rejected] (cannot lock ref ...)', which a text classifier would misread as policy and stop publishing.
The mirror line's result is ignored; the next publish heals it.
Principles: P1, P2, P3, P5, P6 (e3/e3b/e10 ambiguous push VERIFIED; 15-round lease race on file:// VERIFIED).  _(covers: ambiguous-push-and-crash-stale-base, non-atomic-pair-and-fence, op-identity-cursors-board-merge, local-only-holds-break-nothing-lost, push-rejection-poisons-chain)_
- **ENG-18** GUARDS ARE EVALUATED ON THE LEASED TIP. Every outgoing guard verdict is computed against the board state folded from exactly the board commit the push leases on, and on exactly the OUT being pushed. The guards: claude-integration's B1 publish gate on foreign claims; local-change-mgmt change-set holds and T0 checks (LCM-12/13/14); data-handling's conflict policy; INV-MASK.
- After any CAS loss, base move or re-merge, the whole pipeline re-runs from the newly fetched tip. A verdict computed against another tip is never reused.
- This peer's new claim ops ride in the same board commit as the code they cover, so a claim and its code land in one CAS or not at all.
- If the fetched tip already holds a foreign claim earlier in board order, B1 withholds the overlapping change-set before the merge.
- The pipeline runs on every outgoing tree, whatever wrote the bytes (Edit, Bash/PowerShell, a human editor) and whatever the state of the Claude Code hooks, because it reads only the snapshot and the folded board. Even with every hook failing open, nothing B1 would withhold is published.
Principles: P2, P3, P6 (race-loser-hunk-lands, non-atomic-pair-and-fence, cas-remerge-breaks-cs-invariant VERIFIED).  _(covers: race-loser-hunk-lands, a-race-window-overlap-leaks-code, non-atomic-pair-and-fence, cas-remerge-breaks-cs-invariant, gate-fails-open-on-every-hook-failure, bash-powershell-bypass-after-deny, deny-then-bash-workaround)_
- **ENG-19** NON-RETRYABLE REJECTIONS. When a push is rejected and the observed board tip still equals the lease value (ENG-17), the cause is host policy: pre-receive declined, GH013 / push protection, ruleset, protected ref, size limit, or signature requirement.
- The branch enters NONRETRYABLE for this peer: no further push attempts on that branch and no governor attempts spent on retries. Fetch, fold and apply continue.
- The host's exact stderr (LC_ALL=C, first 800 chars, control characters stripped) is shown to the human (status + OS notification) and to every live seat's Claude on this worktree.
- If the message names paths (GH013 'path:' lines, size-limit file names), those paths become PIN holds, and the human may run '/cowork resume' to retry once.
- Otherwise the human must resolve it (v1: no automatic bisection of the outgoing delta).
Each publish is one commit built fresh on the current TIP from (R, A_R), so a retry never carries the rejected commit.
Principles: P2, P4 (push-rejection-poisons-chain REASONED; host-policy-and-ci DOCUMENTED).  _(covers: push-rejection-poisons-chain, host-policy-and-ci)_
- **ENG-20** GOVERNOR MECHANICS (parameters and ranking from protocol (10a)).
PARAMETERS: team budget B = 6 attempts/min, G = 10 s, S = 3 s. Each is the stricter of the local value and board protocol.json.
WINDOW: a peer with pending work starts an attempt only when Δmono since its anchor >= G + (rank - 1) x S.
- The anchor is its local observation of the current board tip, or receipt of its own 'ok'.
- rank = LRU position in the fold's live set (least-recently-written first, ties by peer_id). It is identical on every peer that folded the same tip.
COUNTING: every attempt counts (ok, rejected, ambiguous, probe, save). Per-peer cap: 6 attempts per 60 s of Δmono.
CAS LOSER: re-anchors and re-ranks; never retries immediately.
THROTTLING: host throttling (HTTP 429/5xx, or a push taking > 10 s) doubles G locally, up to 60 s, and is shown in status.
PUSH ONLY ON CHANGE: an attempt requires a non-empty diff(A_R, R) or pending board ops. There are no periodic, heartbeat, renewal or liveness pushes: claims carry no TTL, and liveness is proven only on contest.
FETCH POLLING (2.5 s active / 10 s idle) is not governed: 4 peers make about 1.6 fetches/s, vs GitHub's 15 git ops/s recommendation.
SAVE uses two attempts in one window: branch push, then board push.
CLOCKS: all timers are deltas of the local monotonic clock (lint: no Date.now() comparisons outside the anchor helper).
MODEL (not measured on a host; sweep/dp2/gov_sim.py, 1 h x 8 seeds):
- 4 busy peers: 5.05 attempts/min sustained, 1.00 attempts per landed, publish latency p50 44 s / p95 47 s, equal shares 76/76/76/75;
- naive baseline: 79 attempts/min, 2.12 per landed.
Principles: P3, P5, P6 (e6c 2.5x attempts VERIFIED).  _(covers: cas-storm-starvation-governor, lease-expiry-clocks-heartbeats)_
- **ENG-21** RECEIVER FAST-FORWARD CHECK AND REWRITE INCIDENTS (merges engine-model R1(c) with messaging-security REF-TRUST 3).
CHECKS, every loop, before any fold, apply or merge:
(1) BOARD: with T = fetched board tip, either T == LA_B, or 'git rev-list --first-parent LA_B..T' is non-empty and its oldest commit's first parent == LA_B. A bare 'merge-base --is-ancestor' is NOT sufficient: a rewrite that keeps the old chain as a second parent passes it.
(2) CODE: TIP = live_code(T) passes the same first-parent test against LA_C.
(3) SHAPES: every board commit in LA_B..T has the ENG-01 two-parent shape, and every live code commit in LA_C..TIP has one of the three ENG-01 shapes.
INCIDENT: a failed check, or a vanished board ref, is a REWRITE INCIDENT for that branch:
- apply nothing, and publish no code or board commit;
- store T at refs/cowork-local/<b>/incident-<n>;
- show the old and new oids to the human, and inject the same into every live seat's Claude on this worktree;
- push ONE governed copy of LA_B to refs/cowork/<b>/displaced/<first 12 hex of LA_B> (empty lease; an existing ref with the same value counts as done). At most 3 displaced refs per branch; later incidents keep local copies and alert. This makes the pre-incident chain durable on the remote, not only on one disk.
RECOVERY: the only exit is human-typed '/cowork recover'. It pushes this peer's newest first-parent-valid board commit with '--force-with-lease=refs/cowork/<b>/board:<observed bad value | ABSENT>'.
- Peers whose LA_B is on the restored first-parent chain resume.
- A peer that is further ahead runs recover itself. Ancestry decides which tip is newer, not clocks.
The code mirror and refs/cowork/<b>/displaced/* are never decision inputs. A missing or rewound mirror is not an incident; the next publish rewrites it.
The live chain is never reset, and every live commit stays reachable from the board, so pre-save history and per-commit attribution remain browsable with plain git.
Principles: P1, P2, P4, P5, P6 (t3 rewind VERIFIED; e7 reflog VERIFIED).  _(covers: ref-rewind-silent-revert, empty-oid-push-deletes-live-ref, no-history-undo)_
- **ENG-22** BRANCH MOVES (live base move and save completion). Applies when the fetched branch head Hr != Hb (live base of TIP).
(i) REWRITTEN: Hb is not an ancestor of Hr, or Hr is missing -> v1 refuse. No save and no base move; live continues on Hb; the humans and their Claude sessions are told.
(ii) SAVE COMPLETION: Hr has the trailer 'Cowork-Saved-Live: <Lk>', Hr^1 == Hb, tree(Hr) == tree(Lk), and Lk is on TIP's first-parent chain -> newtree = tree(TIP). This equals merge-tree --merge-base=tree(Lk) TIP Hr. (x1 VERIFIED that base tree(Hb) would resurrect a deleted line.)
(iii) OTHERWISE: newtree = 'merge-tree --merge-base=<B'> TIP Hr'.
- B = the newest commit, among Hb and earlier base-move second parents on TIP's first-parent chain, that is an ancestor of Hr (normally Hb).
- B' = B, except B'[p] := Hr[p] for every p where Hr[p] equals a blob of p found on TIP's first-parent chain back to B (at most 500 commits). Hr then carries an older or equal LIVE version of p (typically a human's 'git commit -a && git push' while live), so live keeps TIP[p]. Those paths are listed in one board event and in status.
CONFLICTS or identity-check failures in (iii):
- No base move; live continues on Hb.
- Each conflicting path becomes ONE hold record (guard 'base-move', stages B'[p] / TIP[p] / Hr[p]).
- '/cowork resolve <id> --restore' re-applies Hr's change to live as an ordinary local edit, through every gate.
- '--discard' is logged; that path takes TIP in the next base-move attempt, and the human is told the next save will revert it on the branch.
- Save stays blocked while any base-move record is ACTIVE.
CLEAN (iii): diff(TIP, newtree) passes the same outgoing guards as a local delta (revert/provenance guard). Hunks that re-introduce content the live chain removed pause those paths and ask the humans.
PUBLISH: L' = 'commit-tree newtree -p TIP -p Hr' with 'Cowork-Base: <Hr>', published like any code commit under the board lease. Every daemon may attempt it; the lease admits one; the others refetch and see Cowork-Base == Hr. A base move never moves a branch ref.
LOCAL COMMITS: a local 'git commit' while live does not move the live base (ENG-12 freezes). After a base move every peer runs ENG-24. A peer whose HEAD already equals Hr (it made that commit) just sets H_adopt := Hr, which lifts its freeze.
Principles: P1, P2, P3, P4, P6 (save-reverts-external-commits e9 VERIFIED; x1_save_completion.sh VERIFIED; exact-match base REASONED).  _(covers: save-reverts-external-commits, held-hunk-escapes-via-branch-commit)_
- **ENG-23** SAVE (U8; human-typed only, disable-model-invocation). Refused while FROZEN, INCIDENT, OFFLINE, NONRETRYABLE or version-paused, or while any base-move record is ACTIVE.
(1) FINAL SYNC: publish this peer's own non-held ready delta (governed), then fetch. Read TIP, Hb = live base of TIP, and Hr = fetched branch head.
(2) Hr != Hb -> run ENG-22 and restart; at most 3 tries, then refuse loudly.
(3) CANDIDATES = TIP's first-parent chain while the live base is still Hb, at most 20 commits. Each runs T0 plus the configured T1 smoke command (timeout 300 s, configurable) in 'git worktree add --detach <gitdir>/cowork/tmp/save-<n> <Lk>', removed afterwards. Choose the newest passing candidate whose Cowork-CS trailers are all state=closed; else the newest passing one (reported). If none passes, refuse and show the output.
(4) S = 'commit-tree tree(Lk) -p Hb', with the human's summary, per-symbol attribution trailers and 'Cowork-Saved-Live: <Lk>'. Assert: tree(S) == tree(Lk); Lk is on TIP's first-parent chain; live base(Lk) == Hb == Hr; no skip-ci marker in the message.
(5) Ls = 'commit-tree tree(TIP) -p TIP -p S' with 'Cowork-Base: <S>'. Assert tree(Ls) == tree(TIP).
(6) PUSH THE BRANCH: '--force-with-lease=refs/heads/<b>:<Hb> <S>:refs/heads/<b>'. This is a fast-forward; the repo's own hooks do not run under the empty core.hooksPath, and LFS paths are carry-through. Then publish Bs under the board lease: ops save{chain_base: Hb, save_commit: S} plus the releases of included claims, last parent Ls. --atomic is never used: a crash or rejection between the two pushes is completed by ENG-22(ii) on any daemon.
(7) FAILURES:
- Branch push rejected -> refetch. Branch moved -> back to (2). Branch unchanged -> non-retryable (protected branch, required reviews, required signatures): save refused with the host's message (v1: refuse).
- Board push CAS loss -> refetch. If the new TIP's live base == S, done (another daemon completed it). Else rebuild Ls on the new TIP (Lk is still on the chain) and retry.
- Ambiguous -> fetch. Success iff branch == S and a live commit with 'Cowork-Base: <S>' is on the code first-parent chain.
- Never force.
(8) THE SAVE REPORT lists: the included change-sets per author with their states; the saver's held hunks (still held); peers that could not adopt, and why (ENG-24).
The live chain is never reset, so pre-save live history and per-commit attribution stay on the remote.
Principles: P1, P2, P3, P6 (save-race, f-save-lagging, save-splice x6a/x6b, x1 VERIFIED).  _(covers: save-race-reverts-concurrent-edits, f-save-lagging-tree-reverts-peers, save-splice-commits-untested-tree, save-reverts-external-commits, save-squash-erases-provenance)_
- **ENG-24** U9 SAFE ADOPT. Trigger: the live base X of LA_C differs from H_adopt.
CONDITIONS: automatic adopt runs only if ALL hold:
(1) symbolic HEAD == refs/heads/<b>, HEAD == H_adopt, and H_adopt is an ancestor of X;
(2) no ENG-12 marker;
(3) .git/index.lock can be created with O_EXCL (busy -> retry next loop);
(4) for every p in diff(H_adopt, X): the user's index entry for p == H_adopt[p] (nothing staged there); DISK_EQ(p, X[p]) (ENG-07; U9 literally: the files equal the saved content); and p is not pending, deferred or held.
ACTION, index first, then ref:
- write the journal {adopt: H_adopt -> X, checksum of the index to be written};
- copy .git/index to a temp file;
- with GIT_INDEX_FILE=temp, update ONLY the entries of diff(H_adopt, X) ('update-index --index-info', then 'update-index -q --refresh');
- move the temp file into .git/index.lock and rename it to .git/index;
- run 'git update-ref -m "cowork adopt" refs/heads/<b> X H_adopt' (CAS);
- update state: H_adopt := X, journal cleared.
RESTART:
- if the index entries equal X and HEAD == H_adopt, redo the update-ref;
- a leftover .git/index.lock is removed only if its trailing checksum equals the one in the journal;
- if the CAS fails, the index entries are rolled back to H_adopt.
No working-tree file is touched, and staged entries on other paths are preserved.
IF ANY CONDITION FAILS, nothing moves. The human gets one status line naming the failing paths and reasons, and that session's Claude gets the same. The check repeats every loop.
MANUAL: human-typed '/cowork adopt' may use a relaxed per-path test ('git merge-file -p --object-id H_adopt:p <disk blob> X:p' is clean and equals the disk blob), after showing the paths and asking.
refs/remotes/origin/<b> may show 'ahead by 1' until the user's next fetch; this is documented and harmless.
Principles: P2, P4, P6 (x3_adopt.sh VERIFIED: staged u.py preserved, mtimes unchanged, pull --ff-only exit 0, stale CAS refused).  _(covers: post-save-head-drift, head-drift-after-pull-or-save, human-git-mass-revert)_
- **ENG-25** GENESIS AND JOIN.
GENESIS applies when neither refs/cowork/<b>/board nor refs/cowork/<b>/code exists on the remote. (Board absent but mirror present is the vanished-ref case of ENG-21 -> refuse with 'a teammate whose cowork has state for <b> should run /cowork recover'.)
- Require: symbolic HEAD == refs/heads/<b>; HEAD == Hr (fetched remote branch head); no ENG-12 marker.
- L0 = 'commit-tree tree(Hr)' with no parents and 'Cowork-Base: <Hr>'.
- B0 = commit-tree <genesis board tree: protocol.json, join op> -p L0.
- Push with ABSENT leases on board and mirror.
- Two simultaneous starters: the lease admits one; the loser refetches and runs JOIN.
JOIN applies when the board exists and there is no state ref for <b>.
- Fold the board from its nearest checkpoint (<= 255 replayed commits).
- Require symbolic HEAD == refs/heads/<b> and HEAD == Hb (live base of TIP).
- HEAD an ancestor of Hb -> refuse: 'run git pull --ff-only, then /cowork start' (safe: cowork is not live yet).
- HEAD == Hr but Hr != Hb (the branch moved and live has not base-moved yet) -> wait up to 60 s for a running daemon's base move. If none happens (no teammate is live), the joiner performs ENG-22 itself from remote data only, publishes L' in the same board commit as its join op, then joins on the new base (HEAD == Hr == new Hb). If that base move conflicts, join is refused with the conflicting paths listed.
- HEAD ahead of or diverged from Hb -> refuse: 'push or move your local commits first'.
AFTER THE CHECKS:
- A := tree(HEAD); private index := 'read-tree HEAD' + 'update-index -q --refresh'; snapshot S_disk.
- PREVIEW: N files will change on disk (diff A -> TIP); M local changes would be published (diff A -> S_disk).
- Local changes are published only after the human confirms the preview (per-path opt-out). Unconfirmed ones become park-join PIN holds: kept on disk, masked, mirrored to the board.
- The first apply runs via ENG-14. LA_C := TIP only after it. H_adopt := HEAD.
- If nothing was opted in, assert that the first publish changes nothing (OUT == tree(TIP)).
Principles: P2, P4, P6 (late-join-wrong-merge-base VERIFIED: a live-tip base reverted all live work, a live-base base reverted a saved edit, the joiner's own HEAD was correct).  _(covers: late-join-wrong-merge-base, join-or-restart-seeds-revert)_
- **ENG-26** RESTART AND LOST STATE.
RESTART (state ref exists). Nothing is snapshot-published before recovery completes.
JOURNAL APPLY INTENT {A, S_disk, M_disk, TIP, groups: [{n -> path, kind create|modify|delete}]}, written before any .new is prepared:
- FIRST, writer rollback. A group is INCOMPLETE if any of its create/modify paths is absent on disk while its tmp/<n>.old exists (a crash between phase 1 and phase 2). Every incomplete group is rolled back completely: each already-linked p is moved to tmp/<n>.redo, and each .old is linked back to its path (link-no-replace). If the user has meanwhile created p, p stays and the .old bytes become a 'restart' hold.
- Leftover tmp/*.new files are deleted.
- THEN, for each journaled p: DISK_EQ(p, M_disk[p]) -> A[p] := TIP[p]; DISK_EQ(p, S_disk[p]) -> A[p] unchanged; otherwise p becomes a 'restart' hold (unknown; kept on disk, not published, apply deferred), shown to the human.
- tmp/*.old files stay in the ring until their path is resolved.
JOURNAL PUSH INTENT {Bnew, C, R, A_R}: fetch. If Bnew is on the board first-parent chain, apply ENG-17's 'ok' update; otherwise discard it (the next loop rebuilds from (R, A_R)).
JOURNAL ADOPT INTENT: finish or roll back per ENG-24.
LOST STATE (the state ref or any object it names is missing, or a human-typed '/cowork resume' after a freeze):
- Never seed A from TIP or from the live base, and never silently re-join.
- Reseed the private index from tree(TIP) + refresh + snapshot.
- Rebuild A per path: A[p] := the NEWEST blob of p on TIP's first-parent chain (back to the live base, at most 500 commits) that matches the disk by the ENG-07 many-candidate form.
- For an unmatched p: A[p] := TIP[p], and the disk bytes are kept as a 'restart' hold (not published, not overwritten, apply deferred). The list is shown to the human.
- LA_C := TIP; LA_B := fetched board tip.
Principles: P1, P2, P6 (crash-between-apply harness; e3/e3b/e10 VERIFIED).  _(covers: crash-between-apply-and-state-resurrects-deletes, stale-base-after-crash, ambiguous-push-and-crash-stale-base, join-or-restart-seeds-revert)_
- **ENG-27** START PROBE AND HOST REQUIREMENTS. '/cowork start' (and doctor) check the following, refusing with the exact fix:
- git >= 2.43 (merge-tree --write-tree, merge-file --object-id, attr.tree);
- node >= 20 on Claude Code's PATH;
- main worktree (ENG-02);
- <gitdir>/cowork/tmp on the same volume as the worktree, with hard links supported (else rename-over fallback, logged);
- the pinned URL (ENG-05);
- anonymous readability: if 'git -c credential.helper= ls-remote <https URL> refs/heads/<b>' succeeds with GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never, refuse (the board and live WIP would be public). For SSH URLs on github.com, gitlab.com and bitbucket.org, the derived https URL is probed. For other SSH hosts, the human confirms once that the repo is private;
- data-handling's filter preflight and attr.tree discovery;
- a ROUND-TRIP check: TIP is checked out into <gitdir>/cowork/tmp/rt with the daemon's own environment and re-snapshotted. Every synced path must reproduce TIP's blob; paths that do not are excluded loudly. This is convergence assumption A3.
HOST CAPABILITY PROBE: runs only at the first start per (clone, pinned URL) and after a protocol-version change. It is recorded in the join op so teammates need not repeat it, and each probe push is counted by the governor. Steps:
- create refs/cowork/probe-<peer_id> with an ABSENT lease, using a 2-parent commit;
- fast-forward it under a lease;
- a stale-lease push that must be refused;
- check push-options advertisement (capability list);
- delete the probe ref (if refused, leave it and note it).
If custom refs are refused -> v1 refuse. The refs/heads/cowork/<b>/{board,code} fallback is used only with explicit per-repo opt-in after a probe in that namespace. The opt-in warns when CI config exists (.github/workflows, azure-pipelines*.yml, .gitlab-ci.yml, bitbucket-pipelines.yml), and the fallback is refused if 2-parent commits are rejected there.
--atomic is not probed, since it is never used. The probe never touches refs/heads or another peer's refs.
Principles: P2, P4, P6 (host-policy-and-ci DOCUMENTED; git-transport.md sections 1-3; dp2/x1 atomic refusal VERIFIED).  _(covers: host-policy-and-ci, remote-url-drift, phantom-delta-pingpong-convergence)_
- **ENG-28** VERSION GATING. The board's protocol.json carries {proto, minReader, minWriter}. Every live and board commit carries 'Cowork-Proto: <n>'.
ON EACH FOLD:
- own proto < minReader -> the branch is paused for this peer (no fold beyond that commit, no apply, no publish), and the human and Claude are told 'update cowork-sync';
- own proto < minWriter -> no publish (fetch and apply continue).
NO DROPPED RECORDS: each board commit carries only its own ops (ops.jsonl replaced per commit), and no daemon rewrites another peer's records. So an older daemon cannot drop unknown fields or records. Unknown op types fold as no-ops and stay in history.
minWriter is raised only for incompatible changes.
UPGRADE: on a version-handshake mismatch with a newer plugin, the daemon drains (finishes the current step, flushes the journal) and exits. The new version restarts from the state ref (ENG-26 RESTART, never a re-join).
Principles: P1, P2, P3 (prior-art #15 ruflo#3005 OBSERVED).  _(covers: version-skew-board-and-guards, version-skew-board-loss)_
- **ENG-29** HEALTH, STATUS AND OFFLINE.
STATUS FILE: each loop writes <gitdir>/cowork/status.json atomically (temp file + rename) with:
- state, one of {ok, degraded, offline, frozen, incident, nonretryable, version-paused, lost-state};
- Δmono since the last successful fetch and push;
- pending publish (paths, ops); pending INCOMING paths with reasons;
- hold counts; expired fences; governor rank and G; auth state;
- daemon pid and loop counter.
Readers treat a heartbeat older than 3 loop periods as 'cowork: DOWN'.
OFFLINE = no successful fetch for > 30 s on the daemon's monotonic clock.
- Snapshot and local holds continue, nothing new is applied, and publishes queue.
- On reconnect the ordinary loop runs (fetch, ENG-21 check, fold, merge with A, every guard against the fetched tip). There is no separate reconcile mechanism.
- Tentative claims that lost while offline are reported as one list (AUTH rule).
LOUD TRANSITIONS: every transition into offline, frozen, incident, nonretryable, version-paused or lost-state reaches the human (OS notification at most once per 30 min per state) and each live seat's Claude at its next hook. The state is never 'ok' while any of these hold.
HEALTH STUB: three consecutive failed applies for the same reason publish one board health stub ('not receiving <path> for <local duration>: <reason>').
Principles: P2, P5 (silent-stall DOCUMENTED; blackhole.js VERIFIED).  _(covers: silent-stall-no-visible-surface, offline-split-brain, offline-auth-claims, hung-network-git-after-sleep)_
- **ENG-30** REAL-GIT PROPERTY HARNESS.
CORE: the engine core is a deterministic state machine with an injectable monotonic clock, scheduler, fs watcher and process runner.
REAL GIT: the runner always executes REAL git (>= 2.43) against a file:// bare remote. Only two things are faked: the network (renamed remote, delayed fetch, server-side pre-receive hooks for rejections and lease emulation) and Claude (scripted calls into the real hook binary).
CI: Windows, macOS and Linux each run >= 10,000 seeded interleavings per run, each reproducible from its seed. Mixed-OS rounds pass the same bare remote between a Linux job and a Windows job as a CI artifact (case collisions, invalid names, EOL, locks).
MUTATION TESTING: reintroducing each VERIFIED defect must make the suite fail:
- re-seeded index;
- applying a conflicted tree;
- stale or ancestry base;
- missing attr.tree;
- hash-object comparator;
- 'APPLY if TIP != LA_C';
- raw-snapshot push;
- text-based push classification;
- relative GIT_INDEX_FILE.
A surviving mutant blocks release.
Principles: P6 (harness-mock-blind-mixed-os e13 VERIFIED).  _(covers: harness-mock-blind-mixed-os)_

## invariants
- **INV-AUTH** The live tip is always live_code(fetched board tip). No engine decision reads refs/cowork/<b>/code or refs/cowork/<b>/displaced/*.
  TEST: Harness: corrupt or delete the remote code mirror between loops. Assert identical apply and publish decisions, and assert that the next publish rewrites the mirror to live_code(previous board tip).
- **INV-FF** Every observed board tip change is a first-parent fast-forward from LA_B, and every observed code pointer change is a first-parent fast-forward from LA_C, except during an incident.
  TEST: After every harness operation, walk the observed tips. Inject rewinds, deletions, and a rewrite that keeps the old chain as a second parent. Assert each injection raises INCIDENT within 2 polls and nothing is applied or pushed.
- **INV-BASEPARENT** Second parents occur only on base-move commits (on the code chain) and on every board commit (the live code link). Base-move second parents are branch commits. No branch commit has a live commit as an ancestor.
  TEST: After every save and base move: 'git rev-list refs/heads/<b>' contains no commit carrying a Cowork-Writer trailer, and every 2-parent live code commit has a Cowork-Base trailer naming its second parent.
- **INV-BASE** Every 3-way merge of local work passes an explicit tree as --merge-base (A, A_R or B'). A[p] changes only after a verified write or a confirmed push of p.
  TEST: CI lint (no merge-tree without --merge-base; no git merge-base on cowork refs), plus a harness trace assertion on every A transition.
- **INV-DELTA** For every pushed commit C on TIP: paths(diff(TIP, C)) is a subset of paths(diff(A_R, R)), and every path with R[p] == A_R[p] has C[p] == TIP[p].
  TEST: For every landed commit, the harness recomputes both conditions from the journaled (R, A_R).
- **INV-STATE** refs/cowork-local/<b>/state changes only by CAS update-ref. LA_C and LA_B are monotone on their first-parent chains.
  TEST: The state ref's reflog shows only CAS updates. The harness checks first-parent monotonicity after every step, including kill -9 at each step boundary.
- **INV-USER** The user's HEAD, refs/heads/*, .git/index, FETCH_HEAD and ORIG_HEAD are byte-identical across every loop, except a journaled ENG-24 adopt. That adopt changes only refs/heads/<b> and the index entries of diff(H_adopt, X).
  TEST: The harness hashes .git/index, FETCH_HEAD, ORIG_HEAD and refs/heads before and after every non-adopt loop (10 polls, with a concurrent 'git pull' as in e5) and asserts equality.
- **INV-NOCLOBBER** No byte sequence written to a working file by a human or Claude is lost. It is in a live commit, a hold record, the merged file, or a .old ring file pending merge-back.
  TEST: A concurrent writer at 0-1500 ms during applies (ed/e3 lost.js, extended) writes unique markers. Assert every marker reaches one of those stores.
- **INV-GROUP** After any apply, for every incoming change-set, either all of its applicable paths equal M_disk on disk, or none changed.
  TEST: Lock one of three paths of a change-set with FileShare.None during an apply; assert none of the three changed. Release the lock; assert all three are written in one group.
- **INV-PROGRESS** A pending path whose defer reason has cleared is applied within one loop, even when TIP == LA_C.
  TEST: Defer p (lock). Let this peer publish an unrelated change (LA_C := C). Release the lock with no further remote change. Assert p is written in the next loop.
- **INV-NOMARKER** No pushed blob newly contains a conflict-marker line that is absent from both its R and TIP versions. No marker-bearing merge-tree blob is ever written to disk, an index or a hold.
  TEST: Run the marker-survey operations (cherry-pick, revert, stash pop, switch -m, rebase -i break) on one peer for 5 loops. Assert the board's live trees never gain ^<<<<<<< lines. Unit-test the marker detector on CRLF, BOM and diff3 markers.
- **INV-NOSYNTH** Every tree the engine produces comes from one of the four ENG-10 operations.
  TEST: CI lint over daemon sources, plus a harness check that every published blob exists in R, in TIP, in a clean merge-tree result, or in a canon output.
- **INV-OID** No refspec, update-ref or commit-tree argument carries an unvalidated or empty oid. The daemon never deletes a remote ref outside refs/cowork/probe-*.
  TEST: Fault injection: write-tree / commit-tree exit 128 with empty stdout. Assert no push process is spawned and the remote board ref is unchanged.
- **INV-SAVE-TREE** tree(saved commit) == the tree of some live commit on the chain, and its parent == the branch head it was leased on.
  TEST: After every save in the harness, check both equalities. Include two concurrent saves and a non-atomic save interrupted between its two pushes.
- **INV-ADOPT** An adopt changes no working-tree file, preserves the index entries of unaffected paths, and happens only when ENG-24's conditions hold.
  TEST: x3_adopt.sh regression, plus randomized staged and unstaged index states. Compare file mtimes and 'git ls-files -s' before and after.
- **INV-REACH** After 'git gc --prune=now' at any step boundary, every object referenced by the state ref, the holds or the journal still exists.
  TEST: In randomized runs, the harness runs gc --prune=now at every step boundary, then 'git cat-file -e' on all referenced oids.
- **INV-NOLOSS** Every edit marker is at all times in the live tip, the saved branch, or a hold reachable from the remote board. The only exception: a later edit by a peer whose A contained the marker changed it.
  TEST: The shared property harness, with unique per-edit markers across all fault injections. This is the acceptance gate.
- **INV-CONVERGE** With no new edits, every peer reaches snap == A == tree(TIP) within K = 10 loops, modulo its own holds and listed NOT-CONVERGED paths, and makes zero pushes afterwards.
  TEST: N peers with random edits, rejects, ambiguous pushes and a partition, then quiet. Assert the fixed point within 10 loops and no further push for 5 minutes.
- **INV-NOCLOCK** No engine decision compares wall-clock values from different machines. Every timer is a delta of the local monotonic clock.
  TEST: Lint for Date.now() comparisons outside the anchor helper. In the harness, per-peer clock offsets of +/-600 s and suspend gaps must yield identical decisions.

## tests
- Regressions kept from the sweep (real git, file:// remote): x1_save_completion.sh (save-completion base), x2_snapshot_list.sh (locked path in snapshot), x3_adopt.sh (adopt with staged index), e1 (naive push revert), e2 (explicit base), e3/e3b (ambiguous push), t3 (rewind), ed/e3 lost.js (apply clobber), e10, e5 (FETCH_HEAD/pull race), dp2/x1.sh (non-atomic pair), and the late-join variants (HEAD behind, equal, ahead, diverged).
- COMPARATOR (sweep/engine_rc): with core.autocrlf=true and a BOM+CRLF file stored i/crlf, run 200 applies to it with no concurrent edit. Assert 0 'changed since snapshot' deferrals and 0 phantom holds. A mutant using 'hash-object --path' must fail this test.
- ABSOLUTE PATHS: run the snapshot with --work-tree and a relative GIT_INDEX_FILE (mutant). Assert the wrapper rejects it before spawning git.
- FILTER FAILURE: under required=true, set the clean command for cfg.txt to 'false', then unset the driver. Assert: rc 128; cfg.txt becomes LOCAL-ONLY; nothing is pushed that loop; the next loop publishes the other changed paths; no plaintext blob exists in the object store reachable from any cowork ref.
- SAVE-FAILURE SOAK (Windows, 1.3 MB BOM+CRLF file): an editor-like writer saves every 1-5 s for 2 h while the daemon runs normally. Assert <= 1 failed save per 1,000 saves. Otherwise switch to staged hashing and re-run (expected: 0 failures).
- TORN AND ATOMIC SAVES: run partial.js (in-place writer) and the e15 freeze-step harness for the JetBrains, vim and Sublime save sequences. Assert 0 truncated or 0-byte blobs published, and no D/R entry for the saved file.
- LOCKED SNAPSHOT: hold b.txt with FileShare.None (x2). Assert a, c, n and the deletion of d are published; b keeps its old blob and is in the apply defer set; after unlock, b publishes.
- WRITER GROUPS: a closure of 3 paths with one locked. Assert none is written and an INCOMING record with LA_eff exists. Then unlock and assert all three are written, A is updated only for them, and there is one state update-ref.
- CONCURRENT WRITE DURING APPLY: a writer at random 0-1500 ms offsets during 600 applies. Assert every human write survives (in the file or merged). With a tight-loop reader (ed/e4 harness), assert 0 zero-byte or partial reads, and ENOENT only inside phase 1->2 gaps.
- CREATION COLLISION: B has .env ignored via info/exclude; A publishes .env (allowed by A's config for the test). Assert B's .env bytes are unchanged and an INCOMING hold exists (e14).
- PORTABILITY: apply on Windows a Linux-built tree (git mktree) containing con.py, a:b.txt, 'trail.', README.md+readme.md, plus an edit to x.txt. Assert x.txt is applied, the others become INCOMING holds, and later applies continue.
- DISK FULL: fill a Linux loop-mounted 300 MB volume mid-apply; repeat on a Windows VHD. Assert no truncated file on disk, the apply is deferred with a notice, and the peers converge after space is freed.
- PENDING PROGRESS: defer p by a lock, publish an unrelated local change, then unlock with no remote change. Assert p is applied in the next loop. The mutant 'APPLY if TIP != LA_C' must fail.
- PUSH CLASSIFICATION, with a pre-receive hook on the bare remote that: (a) rejects with 'cannot lock ref' after another peer's push landed (CAS loss) -> retryable; (b) rejects a blob containing a marker while the board is unchanged -> NONRETRYABLE after exactly 1 counted attempt; (c) rejects every board commit (ruleset emulation) -> NONRETRYABLE, message shown.
- AMBIGUOUS PUSH: kill the push process after the server accepted (watchdog). Separately, make the client report failure while the ref landed. Assert the next loop treats Bnew as landed, publishes nothing twice, and A and LA_C are correct.
- INCIDENTS: (1) rewind the board to an ancestor; (2) replace it with a rewrite that keeps the old chain as second parent; (3) delete it; (4) push a board commit whose last parent jumps to a non-descendant code commit. Assert INCIDENT within 2 polls on every peer, zero applies and pushes, and one displaced ref (max 3). Assert '/cowork recover' restores the board and all peers resume.
- EPOCH: run each operation of the marker survey, plus stash, checkout <other branch>, checkout -- ., reset --hard, bisect, git commit, and a /rewind-style whole-file restore. Assert FROZEN within one loop; no apply and no code publish while frozen; board-only pushes still mirror hold records; automatic release when the epoch returns.
- BRANCH MOVES: (1) an external commit to <b> (e9) -> the base move keeps both sides; (2) a non-atomic save interrupted between branch and board push -> another daemon completes it (x1); (3) a human 'git commit -a && git push' of live content, followed by more live edits to the same lines -> the base move succeeds via the exact-match base and live keeps TIP; (4) a conflicting external change -> base-move hold, save blocked until resolved.
- SAVE: run two concurrent saves; a save with T1 failing at the tip (walk-back to an older candidate); a save on a branch protected by a pre-receive hook -> refused with the host message, live untouched. Assert INV-SAVE-TREE, and that peers whose disks match adopt.
- GENESIS/JOIN: two simultaneous first starters -> one genesis, the other joins. Join with HEAD == Hr != Hb -> waits for the base move. Join with local WIP -> preview; opted-out paths become park-join holds; if nothing is opted in, the first publish changes nothing.
- CRASH: kill -9 / TerminateProcess at every step boundary (apply intent, between phase 1 and phase 2 of a group, between groups, push intent, adopt between index and ref), followed by a peer deleting the just-applied line and by 'git gc --prune=now'; 100 randomized runs. Assert: no resurrection; no path left missing (incomplete groups fully rolled back from .old); INV-REACH; a leftover .git/index.lock removed only when its checksum matches the journal.
- LOST STATE: delete the state ref while live. Assert FROZEN and no re-join. Assert '/cowork resume' rebuilds A per path (newest matching candidate), with unmatched paths as restart holds.
- NETWORK: point the pinned URL at sweep/lifecycle/blackhole.js. Assert the loop recovers within 60 s, status is 'offline' after 30 s, backoff goes 30 s -> 5 min, and there is no credential prompt (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never).
- URL DRIFT: pushurl != url -> start refused. Change origin mid-session -> paused, zero network calls to the new URL. An anonymously readable remote (http daemon without auth) -> start refused.
- VERSION SKEW: run bundles N-1 and N over 1,000 random board ops. Raise minWriter and assert N-1 stops publishing within one loop. Assert no record written by N disappears.
- GOVERNOR: gov_sim.py regression, plus a 30-min 4-peer file:// soak with 200-800 ms injected latency. Assert: sustained <= 6 attempts/min; attempts/landed <= 1.3; each peer's landed share within +/-15% of 1/N; no peer with 0 landed.
- PERF: on a 3,001-file repo with the 1.3 MB file and a stat-fresh private index, the snapshot loop p95 <= 100 ms (measured baseline 54-60 ms). On Windows, applying a 1-line change to the 1.3 MB file end-to-end p95 <= 250 ms.
- MIXED-OS CI: a Linux job publishes Utils.py + utils.py and con.py; a Windows job applies them from the same bare-remote artifact. Assert holds are created and nothing is silently overwritten (e13).

## numbers
- Loop period: 2.5 s while any local seat is active or work is pending, 10 s idle. Why: protocol (10a); 4 peers x 0.4 fetch/s = 1.6/s, about 11% of GitHub's 15 git ops/s recommendation.
- Governor: B = 6 attempts/min team-wide, G = 10 s, S = 3 s; per-peer cap 6 per 60 s Δmono; throttle doubling up to 60 s. Worst normal wait = G + (N-1)S = 19 s for 4 peers. Why: protocol (10a); GitHub recommends <= 6 pushes/min per repo.
- Snapshot quiet period: a dirty path is hashed only when its mtime is >= 300 ms old. Why: editor-fs partial.js gave 0 partial blobs with a quiet period plus a stat-before/after check.
- Deletion confirmation: a missing tracked path is published as deleted only if it was also missing >= 1 s earlier, or the deletion is hook-attributed. Why: LCM-15 SNAP-2; e15 atomic-save window.
- Shrink guard: a non-empty -> empty change, or a > 50% shrink, needs 2 stable snapshot loops plus attribution. Why: LCM-15 SNAP-3; torn-snapshot 5/416 VERIFIED.
- Snapshot cost: 54-60 ms per loop with a stat-fresh persistent private index, vs 750-1000 ms reseeded (VERIFIED e3/e1). Perf gate: p95 <= 100 ms.
- Save-failure residual: about 2-4 ms of file mapping per git add of a 1.3 MB file, derived from 9/140 failed saves over 575 back-to-back adds and 46/187 over 1,185 adds. Soak gate: <= 1 failed save per 1,000 saves.
- Writer: at most 3 re-merge retries per path, then defer. .old ring kept >= 2 s before re-check and deletion. Gate wait for an in-flight group <= 250 ms (groups are renames and links only, about 1-2 ms per path).
- Apply coalescing: <= 1 apply per 10 s per worktree (LCM-16 apply_min_interval); <= 1 apply per 2 min into full-read files of a mid-turn seat (claude-integration budget).
- Free space before an apply: >= 2 x bytes to write + 256 MB. Why: disk-full mitigation; a 1.3 MB file needs about 259 MB free.
- Network: http.lowSpeedLimit = 1000 B/s for http.lowSpeedTime = 10 s (blackhole.js: a 5 s setting failed in 5 s instead of hanging > 25 s). SSH: ConnectTimeout 10 s, ServerAliveInterval 5 s x 3.
- Watchdogs (process-tree kill): fetch 45 s, push 90 s, any local git command 120 s (catches a hung filter).
- Offline: no successful fetch for > 30 s (Δmono). Auth and network backoff: 30 s, doubling to 5 min (AUTH rule).
- index.lock: the loop is skipped while it is present; present > 30 s = stale, reported loudly (LCM-6).
- Mass-change breaker: unobserved delta > max(10 files, 2% of tracked files). Source: LCM-6; REASONED, not measured.
- Save: <= 20 candidates, T1 timeout 300 s (configurable), <= 3 base-move restarts. worktree add takes 0.49-0.51 s for 3,001 files (VERIFIED LCM-17).
- Lost-state rebuild and the exact-match base walk <= 500 first-parent commits. The cost is bounded: the 1.3 MB file is about 0.9 KiB packed per version (x2).
- Join: board replay from the nearest checkpoint <= 255 commits (a checkpoint every 256 first-parent heights, per protocol). Wait <= 60 s for a pending base move.
- Incidents: <= 3 displaced refs per branch, one governed push each.
- Scope caps: new files > 1 MB are excluded (U10); tracked paths are exempt; any blob >= 50 MiB is save-only (GitHub warns at 50 MiB and blocks at 100 MiB).
- Version floors: git 2.43 (attr.tree, merge-file --object-id); merge-tree --write-tree needs 2.38; node >= 20 (U11).
- Health: a heartbeat older than 3 loop periods = DOWN. OS notification at most once per 30 min per state. Board health stub after 3 consecutive failed applies for the same reason.
- Repo growth: about 0.9 KiB packed per live commit of the 1.38 MB file (x2: 301 versions = 280 KiB). Worst case about 3 MB/day at 6 commits/min for 10 h (protocol).
- Harness: >= 10,000 seeded interleavings per OS per CI run; INV-CONVERGE within K = 10 loops.

## open questions
- BINDING CONFLICT, resolved here (please confirm): engine-model and protocol (9) disagree. Engine-model's save step 6 uses 'push --atomic' with a lease on refs/cowork/<b>/code, and its loop fetches code + board + branch. Protocol (9) makes the board the only authority, makes the code ref a lagging mirror, and says the protocol never needs --atomic. ENG-01/17/23 follow protocol (9): publishes lease only the board; the save pushes branch then board sequentially; ENG-22(ii) save completion is the only completion path. Engine-model's --atomic branch is dropped as dead code.
- BINDING CONFLICT: protocol (6) allows a non-fast-forward code-pointer move when the board commit carries a reset op (save). Engine-model INV-FF makes saves first-parent fast-forwards. ENG-01/21 keep INV-FF and drop the reset op, so any non-FF code pointer is an incident. The protocol group should delete reset{code_commit}, or limit it to '/cowork recover'.
- BINDING CONFLICT: protocol's convergence proof says join REFUSES a peer whose config_fingerprint (autocrlf, eol attrs, filter hash, git version) differs. Data-handling's EOL resolution says there is no join refusal on autocrlf mismatch, because canon makes blobs identical. This catalog follows data-handling: join refuses only on filter-preflight failure, round-trip failure (ENG-27) and git < 2.43; the fingerprint is published for display only. Consequence: convergence is promised at blob level; working-tree bytes are identical only among peers with equal checkout config.
- EXTENSIONS of engine-model text that need the engine-model owner's acknowledgment:
(a) the state ref has parents [LA_C, LA_B] instead of [LA_C];
(b) DISK_EQ via private-index refresh replaces 'hash-object --path' in writer steps 3/5, restart, lost-state and adopt (VERIFIED mismatch: a40da32 vs 32315a1);
(c) the apply trigger is 'any A[p] != TIP[p]' instead of 'TIP != LA_C', because the latter starves a pending path after this peer's own push;
(d) the writer is two-phase per change-set closure group instead of per path, with journal-driven rollback on restart, so that LCM-16 is satisfied without read-tree.
- ENG-22(iii) exact-match base (REASONED): when a human's direct 'git commit && git push' carries an OLDER live version of a file, live keeps the newer TIP version and only a notice is shown. A deliberate revert made that way stays in branch history but is not applied to live. Is a notice enough, or should such paths become base-move hold records instead?
- Windows save-failure residual of 'git add' mapping files: VERIFIED under stress, but at realistic cadence measured over only 138 saves. Is a soak gate of <= 1 failed save per 1,000 the right threshold before switching to staged hashing?
- LCM-11 capture-at-trigger when two sessions on one PC edit the same file while one change-set is still open: the captured R necessarily includes the open change-set's bytes in that file. Owned by local-change-mgmt; the engine publishes whatever (R, A_R) it is given.
- ENG-12 lets board-only pushes (claims, hold mirrors, the paused event) continue while a peer is FROZEN, reading LCM-6's 'no publish' as 'no code publish'. Please confirm this reading with local-change-mgmt. It is needed so that holds created by the freeze become durable on the remote (P1).
- UNKNOWN; needs tests on a throwaway private GitHub repo before v1 GA (git-transport.md):
- whether pushes to refs/cowork/* count toward the 6/min recommendation the same way branch pushes do;
- whether Actions or webhooks fire for refs/cowork/*;
- whether the server-side lease check holds under a real two-PC network race (100 races, count double wins);
- real push latency;
- whether GitHub push protection scans non-branch refs.
- The anonymous-readability check for SSH remotes on unknown hosts relies on one human confirmation at start. Is that acceptable for v1?
- NEEDS USER SIGN-OFF: 팀의 main 브랜치에 'PR을 거쳐야만 반영' 같은 보호 규칙이 걸려 있으면 cowork의 저장(save)이 서버에서 거절되는데, 이때는 저장을 막고 이유만 알려 드릴까요(기본안), 아니면 저장본을 별도 브랜치에 올려 PR을 만들 수 있게 할까요?
- NEEDS USER SIGN-OFF (inherited from protocol (9); affects ENG-01/17): 겉으로는 지금처럼 '코드 ref'와 '보드 ref' 두 개를 그대로 두되, 진짜 기준은 보드 ref로 하고 코드 ref는 한 박자 늦게 따라오는 보조 사본으로 두어도 될까요?
- NEEDS USER SIGN-OFF (inherited from engine-model R10; affects ENG-24): 저장(save) 뒤에 팀원 파일에 저장된 내용이 이미 다 들어 있고 그 위에 아직 저장 안 한 수정만 더 있다면, 그 팀원의 브랜치도 자동으로 새 저장본으로 옮겨도 될까요?
