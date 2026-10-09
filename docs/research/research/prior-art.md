# cowork-sync: prior art and how it failed (research report, 2026-10-01)

*English for the orchestrator; translate to Korean for the user. **[D]** documented, **[O]** observed in source or issues, **[I]** inferred, **[U]** unknown. Text in quotation marks is quoted; everything else is paraphrased. Durable copy: <scratchpad>\prior_art_report.md*

## 1. Coordination MCPs and plugins for Claude Code

**mcp_agent_mail** ([README](https://github.com/Dicklesworthstone/mcp_agent_mail))
- **Locks only advise.** On overlap, `file_reservation_paths(project_key, agent_name, paths[], ttl_seconds, exclusive, reason)` still grants: "conflicts are returned alongside grants". There is a guard mode `AGENT_MAIL_GUARD_MODE=warn` and a bypass `AGENT_MAIL_BYPASS=1`/`--no-verify`. Example TTL 3600 s; a sweeper releases a lease after inactivity plus mail, filesystem and git silence. [D]
- **False positives teach bypass.** Pre-push used `git diff-tree -m`, which flagged files a merge of origin/main only carried through; fixed with `--cc`. The issue says this was training agents to switch to `warn` ([#238](https://github.com/Dicklesworthstone/mcp_agent_mail/issues/238)). [O]
- **Windows.** A chained hook with a shebang was exec'd directly and failed with `WinError 193`; fix: dispatch by shebang through git's `sh` ([#262](https://github.com/Dicklesworthstone/mcp_agent_mail/issues/262)). [O]
- **Scale.** The sweeper ran `iter_commits` once per file over 56,103 glob matches: about 80 s per 60 s tick, server unresponsive. One `:(glob)` walk took 8 ms ([#240](https://github.com/Dicklesworthstone/mcp_agent_mail/issues/240)). A global storage lock made mutations "lost the lock race… continuously for ~30s" ([#234](https://github.com/Dicklesworthstone/mcp_agent_mail/issues/234)). [O]
- **Spam.** A hook omitted `unread_only` and re-announced read mail every 2 min ([#274](https://github.com/Dicklesworthstone/mcp_agent_mail/issues/274)). [O]
- **Agents tidy away each other's work.** [AGENTS.md](https://raw.githubusercontent.com/Dicklesworthstone/mcp_agent_mail/main/AGENTS.md) bans `git stash`, overwriting with `git checkout`, and `reset --hard`, and says "treat those changes identically to changes that you yourself made" [D]. In [#272](https://github.com/Dicklesworthstone/mcp_agent_mail/issues/272), a repo-wide `ruff check --fix --unsafe-fixes` rewrote other agents' code [O].

**claude-presence** ([README](https://github.com/garniergeorges/claude-presence)): local SQLite. A "session can ignore a held lock and push anyway". Lock TTL 10 min (max 24 h), `force: true`, self-declared IDs. [D] Issues [O]:
- `C:/…` vs `C:\…` compared as exact strings; the hook "degrades" silently ([#44](https://github.com/garniergeorges/claude-presence/issues/44)).
- About 1.5 s per prompt on Windows from 4–5 Node cold starts, roughly 177 ms floor each ([#43](https://github.com/garniergeorges/claude-presence/issues/43)).
- The start hook announces a registration it never writes ([#42](https://github.com/garniergeorges/claude-presence/issues/42)).

**Others.**
- [mclaude](https://github.com/AnastasiyaW/mclaude): `O_CREAT|O_EXCL` lock files, heartbeat every 30 s, stale after 3 min and then force-release with an audit trail; advisory unless the pre-commit guard is on. [D]
- [huddle](https://github.com/halrad-com/huddle): never refuses a claim; overlapping units queue under `ipc/workledger/queue/`. [D]
- [edit-guard](https://github.com/hahahahahahahahah6/edit-guard): PreToolUse hash check; fails open.

**Claude Code's built-in features**
- **Agent Teams** ([docs](https://code.claude.com/docs/en/agent-teams)): `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; task claims use "file locking"; mailbox at `~/.claude/teams/{team}/inboxes/{agent}.json`. The docs list "One team per session", say "Two teammates editing the same file leads to overwrites", and warn "Task status can lag". [D]
- **Cross-session messaging** ([docs](https://code.claude.com/docs/en/cross-session-messaging)): v2.1.224, or v2.1.234 on native Windows. [D]
  - Plain text, delivered between tool calls, marked not-the-user, and it "can't approve anything".
  - Other machines need Remote Control with a claude.ai sign-in.
  - Held by default across permission classes; `crossSessionInbound` takes `accept`/`hold`/`refuse`; identical repeats are dropped and at most 50 are queued.
  - It lists only "your" sessions and reaches other machines only through your own claude.ai login, so it cannot connect teammates on different accounts. [I]
- **Hooks** ([reference](https://code.claude.com/docs/en/hooks)): [D]
  - Exit 2 blocks.
  - Any other non-zero exit is non-blocking and the tool runs. So is exit 0 with JSON that fails to parse or validate.
  - The decision must sit in `hookSpecificOutput.permissionDecision`.
  - `SessionEnd` hooks share a **1.5 s budget** unless a hook sets a longer `timeout` (cap 60 s).
  - Subagents carry the parent's `session_id`; `agent_id` tells them apart.
- **Hook issues** [O]:
  - Denials ignored in [#4669](https://github.com/anthropics/claude-code/issues/4669) and [#37210](https://github.com/anthropics/claude-code/issues/37210), both closed as not planned (#37210 had the JSON outside the wrapper).
  - [#76726](https://github.com/anthropics/claude-code/issues/76726) (open): the parent sees `permission_denials: []` after a subagent was denied.
  - [#76727](https://github.com/anthropics/claude-code/issues/76727): 29% of 13,782 Edit/Write calls targeted another tree by absolute path, so key guards on the target path, not `cwd`.
- **Stale-read guard** [O]: "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it." fires on formatter or watcher writes ([#28383](https://github.com/anthropics/claude-code/issues/28383)). Also spurious modified notices ([#5981](https://github.com/anthropics/claude-code/issues/5981)) and a stuck state ([#33856](https://github.com/anthropics/claude-code/issues/33856)). Whether it checks mtime or content is [U]; test by having the daemon rewrite identical bytes.

## 2. Tools that auto-sync through git

- **gitwatch** has no documented Windows support ([README](https://github.com/gitwatch/gitwatch)) [D]. A broken fswatch exclude let `.git/index.lock` changes restart the loop forever, so it never pushed ([#115](https://github.com/gitwatch/gitwatch/issues/115)) [O].
- **obsidian-git** [O]:
  - Frequent "Unable to create '.git/index.lock': File exists" with a 2-min auto-backup ([#342](https://github.com/Vinzent03/obsidian-git/issues/342)).
  - A stale lock after a crash blocks every run; closed as not planned ([#683](https://github.com/Vinzent03/obsidian-git/issues/683)).
- **git status** [D]: git's docs say a background `status` writes the index and its lock "may conflict with other simultaneous processes"; use `git --no-optional-locks status` ([git-status](https://git-scm.com/docs/git-status)).
- **git-sync** refuses during rebase, merge or detached HEAD, only rebases, and leaves a failed rebase for manual repair ([README](https://github.com/simonthum/git-sync)). [D]
- **git-auto-sync** ignores hidden, gitignored and vim/emacs swap files, and on conflict will "abort and stop syncing that repo" ([README](https://github.com/GitJournal/git-auto-sync)). [D] With both tools, sync stops quietly and the copies drift. [I]
- **SparkleShare** [O]: one user's still-open file silently overwrote a teammate's save ([#1158](https://github.com/hbons/SparkleShare/issues/1158)). It is being archived, and losing its notification service means slower polling ([#2006](https://github.com/hbons/SparkleShare/issues/2006)).
- **git-annex** renames conflicted files `.variant-XXX` with a hash-derived suffix, so resolutions made independently do not conflict again ([doc](https://git-annex.branchable.com/automatic_conflict_resolution/)). [D]
- **Git primitives** [D]:
  - A bare `--force-with-lease` "interacts very badly with anything that implicitly runs git fetch… in the background"; use `<refname>:<expect>` ([git-push](https://git-scm.com/docs/git-push)).
  - `merge-tree --write-tree` "does not read from or write to either the working tree or index" and exits 1 on conflict ([doc](https://git-scm.com/docs/git-merge-tree)).
  - Filters: "clean→clean" should be equivalent to "clean", and "smudge→smudge→clean" should be equivalent to "clean" ([gitattributes](https://git-scm.com/docs/gitattributes)). A filter that breaks this, combined with `autocrlf`, leaves files permanently dirty and the daemon commits forever. [I]

## 3. Real-time collaborative editors

- **Live Share**: the code "resides solely on the machine of the developer who initiated the share". It goes through an Azure relay, and access ends when the host goes offline ([FAQ](https://learn.microsoft.com/en-us/visualstudio/liveshare/faq)). [D] Edits carry a server-sequenced `changeServerVersion`. Desyncs were common enough to get a dedicated [issue template](https://raw.githubusercontent.com/microsoft/live-share/HEAD/.github/ISSUE_TEMPLATE/desync_report.md) and a master list; the tracker now answers 410. [O]
- **Zed**: CRDT operations, Lamport timestamps, per-user undo ([blog](https://zed.dev/blog/crdts)). The host owns the disk: collaborators "access your local file system" ([docs](https://zed.dev/docs/collaboration)). [D]
- **Teletype**: CRDT plus WebRTC plus a signaling server with GitHub login; archived on 2022-12-15 together with Atom ([repo](https://github.com/atom/teletype)). [D] It died with its platform, not because the CRDT failed. [I]
- **Code With Me**: host-side thin clients, 5 concurrent typists ([help](https://www.jetbrains.com/help/idea/2025.3/code-with-me.html)). Unbundled in 2026.1, relays off in Q1 2027 ("Demand… peaked during the pandemic") ([blog](https://blog.jetbrains.com/platform/2026/03/sunsetting-code-with-me/)). [D]
- **What git snapshots cannot give** [I]:
  - These editors converge per keystroke on one buffer, with no merge conflicts and no drift.
  - Git snapshots only see saved files, so a dirty buffer drifts. VS Code then shows "The content of the file is newer" ([#171805](https://github.com/microsoft/vscode/issues/171805)).
  - Snapshots are good enough when claims keep people apart.
  - Tools tied to a hosted relay or an editor died, which supports a git-only transport.

## 4. Multi-agent coding systems

- **CAID** ([arXiv 2603.21489](https://arxiv.org/html/2603.21489v1), on OpenHands): on PaperBench, a shared workspace with instruction-only isolation scored 55.5%, a single agent 57.2%, and worktree isolation 63.3%. Results are best at 2–4 agents and worse at 8; integration is "sequential and test-gated". [D]
- **Cursor**: one worktree per task, `cursor.worktreeMaxCount` = 25, merged back with `/apply-worktree`; no conflict handling documented ([docs](https://cursor.com/docs/configuration/worktrees)). [D]
- **ccswarm**: checkpoint recovery is "the next design, not shipped" ([README](https://github.com/nwiizo/ccswarm)). [D]
- **ruflo**: concurrent MCP processes resolved a stale cached `@claude-flow/cli@latest` and "self-healed" newer files back to old content ([#3005](https://github.com/ruvnet/ruflo/issues/3005)). [O]
- **No surveyed system detects deadlocks or negotiates.** All use TTLs, a manager or a queue. The closest are agent_mail's `ack_required` and huddle's queue. [I]

## Top 15 failure modes to design against

| # | Failure mode | Source |
|---|---|---|
| 1 | Enforcement fails open silently (wrong exit code or JSON, hidden subagent denials, false "success") | hooks doc [D]; #76726, #37210, cp#42 [O] |
| 2 | Advisory locks ignored or granted anyway; false positives push teams to `warn` | agent_mail README [D]; #238 [O] |
| 3 | Last write wins from a stale buffer or stale read | SparkleShare#1158 [O]; Agent Teams doc [D] |
| 4 | Agents "repair" unexpected changes (stash, checkout, repo-wide fixers) | AGENTS.md [D]; #272 [O] |
| 5 | `index.lock` races with the user's git; stale locks after a crash | obsidian-git#342/#683 [O]; git-status doc [D] |
| 6 | Watcher loops on `.git` or the daemon's own writes; editor temp files synced | gitwatch#115 [O]; git-auto-sync [D] |
| 7 | Sync halts silently on conflict and copies diverge | git-sync, git-auto-sync [D] |
| 8 | Background fetch defeats a bare `--force-with-lease` | git-push doc [D] |
| 9 | Claims released only on a clean exit (1.5 s SessionEnd) | hooks doc, mclaude [D] |
| 10 | Identity mix-ups: shared `session_id`, keying on `cwd`, `/` vs `\` | hooks doc [D]; #76727, cp#44 [O] |
| 11 | Hook latency and repeated context spam | cp#43, #274, #5981 [O] |
| 12 | "Modified since read" edit failures or stuck state | #28383, #33856 [O] |
| 13 | Filters or EOL that do not round-trip leave files permanently dirty | gitattributes [D]; effect [I] |
| 14 | O(files) git walks and global locks | #240, #234 [O] |
| 15 | Peers on mixed tool versions revert newer work | ruflo#3005 [O] |

**Unknowns to test**:
- Whether Windows `ReadDirectoryChangesW` loses events on overflow (touch 10k files, count events).
- How fast a Python hook cold-starts on Windows.
- Whether `--atomic` works across the code and board refs on GitHub.

## Implications for cowork-sync

- **Deny path**: exit 2 and print the exact `hookSpecificOutput` JSON. Ship `live doctor`, which tries a denied edit on a temp file and confirms the edit did not happen. If the board is unreachable, allow the edit but say so in `additionalContext`; never degrade silently.
- **Precision, no default warn mode**: an override is explicit (`live override`) and notifies the holder. Never offer an env-var bypass.
- **Leases**: the daemon renews them by heartbeat (renew every 30 s, expire after about 3 min). `SessionEnd` only writes a local release marker (well under 1.5 s) and the daemon pushes it.
- **Keys**: the holder is (machine, `session_id`, `agent_id`). The region is a repo-relative POSIX path from `tool_input.file_path` plus the symbol; lowercase the drive letter.
- **Hooks**: one process, no git, no network. Read the daemon's local snapshot in about 200 ms or less on Windows (measure).
- **Daemon and the user's index**: never touch it. Use `--no-optional-locks`, a private `GIT_INDEX_FILE`, `merge-tree --write-tree`, `commit-tree` and `update-ref`. Pause while `index.lock`, `MERGE_HEAD` or `REBASE_HEAD` exists.
- **Writing files**: compare the file on disk with the base before writing and skip if it changed. Replace atomically, skip identical bytes, and coalesce writes. Ignore `.git/`, gitignored files and editor temp files.
- **Push**: always `--force-with-lease=<ref>:<oid>`, never the bare form.
- **Conflicts**: never halt. Keep both versions under deterministic names and post a conflict record to the board, which every involved Claude's next hook injects.
- **Negotiation**: no prior art has one, so it becomes a board protocol: `request{region, est_duration, reason}` → `grant/deny/queue` with a TTL.
- **Teammate transport**: the board ref. Cross-session messaging cannot cross accounts and helps on one machine at most.
- **Context**: say "lines X–Y were synced from <teammate>'s Claude; do not revert". While live, block `git stash`, `checkout --`, `reset --hard`, `clean` and repo-wide fixers in Bash. Expect "modified since read" and tell Claude to re-read.
- **No repeats**: keep a per-session event cursor and inject only events that session has not seen.
- **`live start` checks**: the secret filter's clean step is idempotent and `required`, and runs in the daemon's environment, so a smudged secret is never pushed.
- **Versions**: record each peer's plugin and protocol version on the board, refuse incompatible peers, and never self-heal files from bundled content.
- **Sweeper cost**: grows with the number of claims, not the number of files.
- **Team size**: evidence peaks at 2–4 parallel agents, so the first pilot team fits.