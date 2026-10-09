# Git remote as a sync bus: verification report (2026-10-01)

The binding limit is pushes. GitHub recommends at most 6 pushes per minute per repository. Shared by 4 users, that is one push every 40 s per PC, so sync lags by about 40 s rather than seconds. Reads are well within limits.

Labels: **DOC** = documented (URL) · **SRC** = seen in source code or issues (URL) · **OBS** = measured on this PC (Windows 11, Git 2.55.0.windows.3, GCM 2.9.0, Seoul; GitHub edge IP 20.200.245.247; test repos in the scratchpad `plumb/` folder) · **INF** = inference · **UNK** = unknown, with a test that would settle it.

## 1. Custom ref namespaces (`refs/cowork/...`)

| Host | Arbitrary `refs/<x>/` refs | Reserved or hidden | Label |
|---|---|---|---|
| GitHub | Advertised (OBS); accepted (INF: someone pushed them; I pushed nothing to GitHub). `git ls-remote` shows 454 `refs/bugs/*`, 312 `refs/identities/*` and `refs/for/*` on github.com/git-bug/git-bug, and `refs/notes/amlog` on github.com/git/git | `refs/pull/*` is read-only: "deny updating a hidden ref" (https://github.com/ad-m/github-push-action/issues/143) | OBS / SRC |
| GitLab | Not on the internal list, so INF accepted | `InternalRefPrefixes`: hidden = `refs/keep-around/`, `refs/remotes/`, `refs/tmp/`; read-only = `refs/environments/`, `refs/merge-requests/`, `refs/pipelines/` (https://gitlab.com/gitlab-org/gitaly/-/raw/master/internal/git/reference.go). Push rejection for these was merged 2021-04-29 (https://gitlab.com/gitlab-org/gitaly/-/merge_requests/3426) | SRC |
| Gitea | Any ref that is not a branch, tag or `refs/for` hits `default: ourCtx.assertCanWriteRef(refFullName)`, which requires code-write permission (https://raw.githubusercontent.com/go-gitea/gitea/main/routers/private/hook_pre_receive.go). Forgejo: UNK (fork, not checked) | none found | SRC |
| Bitbucket Cloud, Azure DevOps | UNK (search snippets only; Azure runs its own git server, see §2) | — | UNK |

- **Permissions.**
  - Only Gitea checks write access per ref explicitly (SRC above).
  - INF for the other hosts: pushing needs write access and fetching needs read access, whatever the ref name.
- **Protection.**
  - Branch and tag rulesets target "selected branches and tags" (fnmatch).
  - Push rulesets "apply to every push to the repository" (DOC, https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).
  - INF: nothing protects `refs/cowork/*`, so anyone with write access can force-update or delete it. Push rulesets (path and size rules) still apply to the daemon's pushes.
- **REST access.**
  - The docs say `:ref` "must be formatted as heads/<branch> … tags/<tag>" (DOC, https://docs.github.com/en/rest/git/refs).
  - Despite that, `GET /repos/git-bug/git-bug/git/ref/bugs/<id>` returned 200, and `git/matching-refs/identities/` also worked (OBS).

## 2. Compare-and-swap

- **Server-side check (DOC).**
  - The server "validate[s] each reference … hasn't changed while the request was being processed (the obj-id is still the same as the old-id)" (https://git-scm.com/docs/gitprotocol-pack).
  - `--force-with-lease=<ref>:<expect>` updates "only if the 'lease' is still valid". An empty `<expect>` means the ref must not exist yet (https://git-scm.com/docs/git-push).
- **OBS on plain git, local file:// remote.**
  - The client sends `<old> <new> refs/cowork/main/code` (seen in a packet trace). A stale lease is refused on the client with `(stale info)`.
  - I ran 15 rounds of two parallel pushes holding the same lease. Exactly one push won every round; there were no double wins.
  - Both clients had seen the same advertised value, so the loser was rejected by the server's old-id check, not by the client's `(stale info)` check.
  - Caveat: this was file:// transport on one machine, not a network race.
  - A push updating 2 refs with `--atomic` succeeded.
- **`--atomic` support.**
  - "If the server does not support atomic pushes the push will fail" (DOC, git-push).
  - Azure DevOps fails with `fatal: the receiving end does not support --atomic push` (SRC, a Q&A answer, not official docs: https://learn.microsoft.com/en-us/answers/questions/2262768/(ado)-(repo)-support-for-git-push-atomic, 2025-05).
  - GitHub, GitLab, Bitbucket and Gitea: UNK. Test: `GIT_TRACE_PACKET=1 git push --dry-run origin HEAD:refs/cowork/probe`, then look for `atomic` in the capabilities.
- **CAS on hosted servers: UNK.** Test: two PCs race 100 lease pushes against a throwaway repo and count double wins.

## 3. Rate limits

| Host | Limit | Label |
|---|---|---|
| GitHub | Git reads: "recommended maximum … 15 operations per second per repository"; beyond that, "throttled performance". **Pushes: "6 pushes per minute per repository"**. Branches: 5,000 (recommended). Push size: enforced at 2 GB. On-disk size: 10 GB (https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits) | DOC |
| GitHub | Since 2025-05-08, unauthenticated limits are tighter, including "cloning repositories over HTTPS" (https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/) | DOC |
| GitHub REST | 5,000 requests/h per user. A 304 is free only when "correctly authorized". "If a response includes an `x-poll-interval` header, wait at least that many seconds". Wait 1 s between write calls (https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api). Secondary limits: 100 concurrent, 900 points/min, 80 content-creating requests/min and 500/h (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) | DOC |
| GitHub REST, git/ref | Response carried `X-Poll-Interval: 300` and `Cache-Control: public, max-age=60, s-maxage=60`. An unauthenticated 304 still lowered the remaining count (51→50) | OBS |
| GitLab.com | Git SSH: 600 ops/min per user, project and command. Git HTTPS: 10,000 requests/min per user (authenticated), 15,000/min per IP (unauthenticated) (https://docs.gitlab.com/user/gitlab_com/rate_limits/). Gitaly concurrency: 60 HTTP and 30 SSH fetches (https://docs.gitlab.com/user/gitlab_com/) | DOC |
| Bitbucket Cloud | Git over HTTPS and SSH: 60,000 requests/h per user, rolling hour (https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/) | DOC |
| Azure DevOps | "Git participates in rate limiting along with the rest of Azure DevOps Services" (https://learn.microsoft.com/en-us/azure/devops/repos/git/limits). I did not fetch the TSTU numbers | DOC (partial) |

**Polling with `ls-remote` vs `fetch` (OBS).**
- `git ls-remote <url> refs/heads/master` sent **no `ref-prefix`**, so the server returned every ref: 4,400 packet lines for git/git. The full v0 advertisement for git/git is 329,226 bytes.
- `git fetch origin +refs/heads/master:…` did send `ref-prefix refs/heads/master`.
- So poll with `git fetch` on explicit refspecs.

**Estimate for 4 users polling every 2.5 s (INF).**
- **Reads.** 96 fetches/min is about 1.6 fetches/s, or 3.2 HTTP requests/s with protocol v2. That is 11–21% of GitHub's 15/s, depending on whether GitHub counts git operations or requests (UNK). It is fine on every host listed.
- **Pushes are the binding constraint.** If each daemon pushes every 2–3 s while editing, that is 80–120 pushes/min, 13–20× GitHub's recommended 6/min. Board (claim) pushes come out of the same budget.
- What GitHub's "throttling" looks like in practice is UNK. Test: a throwaway private repo, 4 clients, 20–60 pushes/min for 30 min. Record latency, HTTP 429/5xx responses and error text.

## 4. Latency (OBS, Seoul → GitHub over HTTPS)

- **Connection.** TCP 3–4 ms; TLS done at 24–31 ms; first byte of `info/refs` at 206–229 ms. GitHub's back-end time dominates, so keeping connections open would save only about 25 ms.
- **No-op `fetch` with protocol v2: 451–476 ms.** This takes 2 HTTP requests, `GET info/refs` then `POST git-upload-pack`.
- **Protocol v0: 288–324 ms.** One request, but it downloads the full ref list.
- **Protocol v2 on GitHub.**
  - Supported since 2018-11-07; needs git ≥ 2.18. Benefit: "reference filtering on the server-side" (https://github.blog/changelog/2018-11-07-git-protocol-v2-support/).
  - With `protocol.version` unset, "the default is 2" (DOC, local `C:/Program Files/Git/mingw64/share/doc/git-doc/git-config.html`).
- **Push latency to GitHub: UNK** (I used no test repo). INF: at least 2 requests, plus server hooks and replication.
- **End-to-end propagation (INF).** About half the poll interval + push + fetch + merge: roughly 2–4 s at a 2.5 s poll, but only if the push budget allowed it. It does not (see §3).

## 5. Repository bloat

- **GitHub garbage collection (DOC, 2022-09-13).**
  - Data overwritten by force-pushes becomes unreachable. GitHub keeps it in "cruft packs" with a per-object timestamp and deletes objects that "haven't been written since <date>".
  - Example from the post: a repository shrank from 186 GB to 2 GB, mostly force-push residue (https://github.blog/engineering/architecture-optimization/scaling-gits-garbage-collection/).
  - The expiry window and GC frequency are UNK.
- **Azure (DOC).** Hard limit 250 GB, recommended under 10 GB. Near the limit, writes fail with "The Git pack file limit has been reached" (limits URL in §3).
- **Number of refs.** GitHub warns that many branches make fetches heavier (DOC, limits page). INF: never create a ref per snapshot or per claim.

## 6. Unattended authentication (Windows daemon)

- **Git variables (DOC, https://git-scm.com/docs/git).**
  - `GIT_TERMINAL_PROMPT=false`: "git will not prompt on the terminal".
  - `GIT_OPTIONAL_LOCKS=false`: skips optional locks; "useful for processes running in the background which do not want to cause lock contention" (DOC, local `.../git-doc/git.html`, 2.55).
- **Git Credential Manager (GCM) settings (DOC, https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/environment.md).**
  - `GCM_INTERACTIVE=never` means "Never prompt – fail if interaction is required". It is meant for "headless and unattended environments … preferable to fail than to hang".
  - `GCM_CREDENTIAL_STORE` defaults to `wincredman` on Windows.
- **SRC.** GCM issue #1775 (Bitbucket Data Center OAuth2, still open): after the access token expires, the next git operation fails once and the retry succeeds (https://github.com/git-ecosystem/git-credential-manager/issues/1775).
- **UNK.** Whether the GitHub OAuth tokens GCM obtains expire or refresh silently (search snippets only). Test: run a daemon for 2+ weeks with `GCM_TRACE=1`.
- **INF.**
  - Windows Credential Manager stores credentials per user, so the daemon must run in that user's logon session, not as a SYSTEM service.
  - For SSH, set `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`.

## 7. Local plumbing (OBS unless marked; tested with `core.autocrlf=true` and a clean/smudge secret filter)

- **Snapshot.** Steps: `GIT_INDEX_FILE=.git/cowork-index`, then `git read-tree HEAD`, `git add -A`, `git write-tree`.
  - The stored file had the clean filter applied (`REAL_SECRET`→`@@SECRET@@`) and LF-only line endings. Checked with `od`; `ls-files --eol` shows `i/lf`.
  - The real `.git/index` checksum and `git status --porcelain` were identical before and after, even with a file staged by the user.
  - Untracked, non-ignored files were included. `.gitignore` handling was not tested.
  - Conversion order: check-in = filter → ident → text; checkout = text → ident → filter (DOC, https://git-scm.com/docs/gitattributes).
- **Seed the temp index from HEAD.** With seeding, `run.sh` kept its executable mode `100755`. Without seeding it became `100644`, because Windows uses `core.filemode=false`.
- **Merge with `git merge-tree --write-tree --merge-base=B O T`.**
  - Edits to different functions in one file: exit 0, clean tree.
  - Edits to the same function: exit 1, with the three conflict versions listed plus `CONFLICT (content)`.
  - The docs warn against reading conflicts out of the result tree, and the command accepts only one merge base (DOC, https://git-scm.com/docs/git-merge-tree).
- **`git merge-file`.**
  - On files: a CRLF working-tree file merged against LF stored versions gave a **whole-file conflict** (exit 1).
  - With `--object-id` on the stored versions, the same merge was clean (exit 0). `--object-id` arrived in Git 2.43 (DOC, https://github.com/git/git/blob/master/Documentation/RelNotes/2.43.0.adoc).
- **Apply.** In a second clone (B): snapshot the working tree into a temp index as BASE, then run `git read-tree -m -u BASE THEIRS`.
  - Files were written with the smudge filter and CRLF line endings (`w/crlf`). B's real index was untouched.
  - When a target file was edited after the snapshot: `error: Entry 'a.py' not uptodate. Cannot merge.`, exit 128.
  - The **other changed file, which was clean, was not written either**. In this test the apply was all-or-nothing.
  - The overwrite-safety rules are documented in the carry-forward table (DOC, https://git-scm.com/docs/git-read-tree).
- **Filter tools can change line endings.**
  - A smudge filter written with git-bash `sed` stripped CR: `printf 'x\r\n' | sed` printed `x\n`.
  - With `smudge=cat`, CRLF was kept.

## 8. Edge cases

- **Case collision (OBS).**
  - I applied a tree containing both `README.md` and `readme.md` with `read-tree -m -u` on Windows (`core.ignorecase=true`). It returned exit 0 with no warning.
  - Only one file existed on disk (holding the `readme.md` content). A fresh snapshot still listed both paths with their original contents.
  - Which of the two a later edit would update is undefined.
- **Symlinks.** Windows has `core.symlinks=false` (OBS). INF: seeding from HEAD keeps the symlink mode `120000`, the same way it kept `100755`. An unseeded snapshot would turn the link into a regular file for everyone.
- **Deletions, renames, binaries, submodules.**
  - A deleted file is removed if clean and refused if dirty (read-tree table rows 10–13, DOC).
  - `merge-tree` detects renames (DOC).
  - INF: a binary conflict covers the whole file, and a submodule is recorded only as a commit pointer (gitlink).
- **LFS (INF).** The daemon's `git push` runs the repository's `pre-push` hooks, so git-lfs would upload objects for `refs/cowork` pushes.
- **Windows file locks: UNK.** If an editor or Excel holds a file open, `read-tree -u` could fail after its up-to-date check has passed, leaving a partial apply. Test by holding a file open in Excel.
- **GitHub Actions and webhooks: UNK** whether `on: push` workflows or webhooks fire for `refs/cowork/*`. Test on a throwaway repo.

## Implications for cowork-sync

- **Pushes are the bottleneck, not reads.**
  - Push only when the snapshot tree changed, and debounce, merge pending changes into one push and back off adaptively.
  - Send code and board together in one push: `--atomic` where the host advertises it. Azure needs a sequential fallback (per a Q&A answer, not official docs).
  - **The arithmetic:** 6 pushes/min shared by 4 users is one push per 40 s per daemon. Under the documented guidance that is a lag floor of about 40 s, which is not "live". The team should see this number before committing to the design. Only the load test can show whether GitHub tolerates more.
  - Between pushes, CAS arbitration still works, but a claim takes effect only at the next push, not at the next fetch.
- **No push per keystroke or per claim.** Batch claims and give each claim an expiry (lease TTL), so one push carries several.
- **Use the board-ref CAS as the lock arbiter.** The loser of a claim race is rejected, refetches and sees the winner's claim. The "please wait / may I go first" exchange starts from there, with no extra server.
- **Poll by fetch.** Run `git fetch --no-tags origin +refs/cowork/<b>/*:refs/cowork-remote/<b>/*` every 2–3 s; protocol v2 sends `ref-prefix`. Do not poll with `ls-remote <pattern>` or with GitHub REST ETags (`X-Poll-Interval: 300`, 60 s cache).
- **Never touch the user's index or HEAD.** Snapshot through a temp index seeded from the last applied tree or HEAD, which keeps file modes and symlinks. Set `GIT_OPTIONAL_LOCKS=0`.
- **Merge stored versions, never working-tree files.**
  - Use `merge-tree --write-tree --merge-base=<last-synced live commit>` (git ≥ 2.38 per the brief, not re-verified) or `merge-file --object-id` (git ≥ 2.43).
  - Have `live start` check the git version.
- **Apply with `read-tree -m -u BASE MERGED`.** On exit 128 ("not uptodate"), re-snapshot and retry; nothing was written. Treat a failure caused by a Windows file lock as possibly partial and re-check.
- **Check before applying.** Reject trees with paths that differ only by case, skip submodule pointers, and confirm the team's secret filter keeps line endings and gives the same output when run twice.
- **Keep refs and history small.** One code ref and one board ref per branch. Keep the parent chain short, and reset the live ref onto the saved commit at each `live save`.
- **Make auth unattended.**
  - Run the daemon in the user's own logon session, not as a SYSTEM service.
  - Set `GCM_INTERACTIVE=never` and `GIT_TERMINAL_PROMPT=0`; for SSH, `BatchMode=yes`.
  - Retry once on 401 (GCM issue #1775), then show "re-auth needed" through the hooks.
- **Probe the host at `live start`.** Create and delete `refs/cowork/probe`, and check whether `atomic` is advertised. If the custom ref is rejected (Bitbucket and Azure are UNK), fall back to `refs/heads/live/<b>`.
- **Write down the security trade-offs.**
  - Custom refs fall outside branch protection, so anyone with write access can overwrite them.
  - Push rulesets and `pre-push` hooks still apply. Decide the `--no-verify` policy explicitly, because LFS depends on that hook.
- **Tests to run before building:**
  - GitHub push latency.
  - The push load test (§3).
  - A two-PC CAS race on GitHub.
  - Which hosts advertise `atomic`.
  - Authenticated REST headers.
  - Whether Actions or webhooks fire on `refs/cowork`.
  - Whether Bitbucket and Azure accept custom refs.
  - GCM token expiry over 2+ weeks.

A copy of this report is saved at `<scratchpad>\git_bus_report.md`.