# cowork-sync

> Saved edits reach every teammate's clone through git. cowork-sync is a Claude Code plugin that keeps the working tree of one git branch in sync between teammates' clones, in real time, using only the project's own git remote and no server.

- Version: 0.1.1-preview, a GitHub pre-release published on 2026-10-09. It is a preview, not a finished product: use it on a test repository only, and back up anything you care about.
- Licence: FSL-1.1-ALv2 (Functional Source License 1.1, with the Apache License 2.0 as the future licence). The project is source-available.
- Author: Youngmin Seo, a personal project. Not affiliated with or endorsed by Anthropic or any company or employer.
- Repository: https://github.com/Kingyoungmins/cowork-sync
- Release: https://github.com/Kingyoungmins/cowork-sync/releases/tag/v0.1.1-preview
- Website: https://kingyoungmins.github.io/cowork-sync/ (Korean: https://kingyoungmins.github.io/cowork-sync/ko/)

## What it is

cowork-sync is for a small team that edits one repository at the same time, each person on their own PC, in their own clone, with their own Claude Code session. A background process in each clone, the daemon, picks up the files you save, publishes them to two custom refs on your existing private git remote, and writes teammates' saved edits into your working tree, never over an edit you just saved. There is no server: the git remote is the only transport, and your branch itself is not pushed to.

Version 0.1.1-preview contains the sync engine and a minimal `/cowork-sync:cowork` command (start, status, stop, view, help). In this preview Claude does not know about the sync, there is no step that turns the shared work into a commit, and the remote is not checked for being private.

## The problem it addresses

A small team edits one codebase with Claude Code. Pushes and pulls collide, so the team takes turns: one person finishes, pushes and says so, and the next person pulls. What the team wants is closer to a shared spreadsheet: everyone works in the same files at once, and each person’s Claude knows what the others are touching.

cowork-sync covers the first part of that. Each teammate works on their own PC, in their own clone, with their own Claude Code session, on one branch of one repository. When someone saves a file, the change reaches everyone else’s working tree.

The second part, each person’s Claude knowing what the others are touching, is planned and not in this preview. Today Claude does not know about the sync; its edits sync like any other saved file.

**Who the preview is for:** people who want to try live sync on a test repository with a private remote. It is not for production repositories or public repositories.

## Install

Every PC that takes part installs the plugin and has its own clone of the repository.

In a Claude Code session, one line at a time:

```text
/plugin marketplace add Kingyoungmins/cowork-sync
/plugin install cowork-sync@cowork-sync
```

Or from a shell:

```sh
claude plugin marketplace add Kingyoungmins/cowork-sync
claude plugin install cowork-sync@cowork-sync
```

Run `/reload-plugins` (or restart Claude Code) to load it. Updates are not automatic for this marketplace. To update, run `/plugin marketplace update cowork-sync`, then `claude plugin update cowork-sync@cowork-sync`. To remove the plugin, run `claude plugin uninstall cowork-sync@cowork-sync`.

## Requirements

- Claude Code 2.1.270 or newer.
- Node.js 20 or newer on `PATH`.
- git 2.43 or newer. `start` refuses an older git.
- Windows, macOS or Linux.
- A **private** git remote that accepts custom refs (`refs/cowork/*`) and enforces `--force-with-lease`. GitHub does both. The first PC’s `start` probes the host and refuses one that does not.
- Credentials from a git credential helper. Git’s prompts are off, so a missing credential gives a refusal, not a hang.
- Every PC that takes part installs the plugin and has its own clone, with `.git` on the same volume as the work tree.

## Commands

Claude Code names the plugin’s command `/cowork-sync:cowork`; type that name in full. The same verbs also run in a terminal, as `node "<plugin folder>/dist/cli.js" <verb>`; `/cowork-sync:cowork view` prints that path.

| Command | What it does |
| :- | :- |
| `/cowork-sync:cowork start [--branch <b>]` | Starts sync for this repository, on the current branch. The first PC creates the shared board on the remote; every later PC joins it. The daemon keeps running in the background. |
| `/cowork-sync:cowork status` | Prints a short summary: the state (`ok`, `degraded`, `offline`, `frozen`, `down` and so on), the branch, and what is still waiting to be published or applied. |
| `/cowork-sync:cowork view` | Prints the command that opens the read-only viewer. The viewer opens only from a terminal: run that command there and it opens in your browser. If your build does not have the viewer process yet, it refuses with `RF_VIZ_START_FAILED`. |
| `/cowork-sync:cowork stop` | Stops the daemon cleanly. Your files stay as they are. |
| `/cowork-sync:cowork help` | Lists the commands. |

`start` also takes `--publish=all|none` (at the first start, share or keep your uncommitted local work), `--remote <name>` and `--name <display name>`.

When a command refuses, it prints the reason with a code, and a `next:` line with the command to run. When the daemon itself refuses to start, its own lines follow `the daemon did not start; it said:`.

Help output of the preview:

```text
cowork-sync 0.1.1-preview: live sync of one git branch between clones, through the git remote.
  /cowork-sync:cowork start [--branch <b>] [--publish=all|none]  start sync in this clone; the daemon keeps running in the background
  /cowork-sync:cowork status                                     show the sync state of this clone
  /cowork-sync:cowork stop                                       stop the daemon; your files stay as they are
  /cowork-sync:cowork view [--no-open] [--demo]                  open the read-only viewer (from a terminal)
  /cowork-sync:cowork help                                       this list
start also takes --remote <name> and --name <display name>.
```

### What `start` checks

- It runs in the main clone. A linked worktree or a submodule is refused.
- The branch is checked out, exists on the remote, and is neither ahead of nor behind it. No merge or rebase may be in progress.
- The remote’s fetch URL equals its push URL, and no `insteadOf` rewrite applies.
- Only one daemon runs per clone.
- If you have uncommitted changes at the first start, it asks you to choose: share them with the team, or keep them on this PC.

### While sync runs

- Save files as usual. Your saved edits are published, and teammates' edits are written into your files.
- Do not run git commands that move `HEAD` in a synced clone (commit, switch, checkout, pull, merge, rebase, stash). Sync freezes until `HEAD` is back where it was. Stop sync first.
- There is no `save` step yet that turns the shared work into a commit on the branch. Treat the preview as a way to try live sync on a test branch.
- Each clone keeps its own files under `.git/cowork/`: `status.json` (the current state) and `log/daemon-0.jsonl` (the daemon log).

### Clean up the remote

Stopping sync or uninstalling the plugin leaves the custom refs on the remote. After every PC has stopped, you can delete them by hand, for example:

```sh
git push origin --delete refs/cowork/main/board refs/cowork/main/code
```

## How it works

Each clone runs one background process, the daemon. The daemons share work through two custom refs on the git remote you already use. Nothing else is in the path: there is no server.

What happens when you save a file:

1. You save a file, from Claude Code or any editor. The daemon in your clone picks it up. It reads through its own private git index and never touches yours.
2. It publishes the change to your remote. `refs/cowork/<branch>/board` is a fast-forward-only chain of board commits and is the authority; `refs/cowork/<branch>/code` mirrors the latest shared tree.
3. Every push is a fast-forward guarded by a lease (`--force-with-lease`), so no PC can overwrite another’s update. When two PCs push at once, the one that loses fetches and tries again.
4. Teammates’ daemons fetch the change and merge it with `git merge-tree`, using explicit merge bases.
5. Each daemon writes the result into its working tree. A file is written only if it still holds the bytes the daemon last read, so an edit you just saved is never overwritten. A group of files is written all or none.

Details that matter:

- When two people change the same line, one version wins. The other is kept as a hold record in the clone and is never thrown away. The preview has no command yet to see or restore it.
- The preview never pushes to your branch (`refs/heads/<branch>`). A plain `git fetch` does not download the custom refs, so your normal history stays clean.
- Settings, hooks and CI files (`.claude/`, `CLAUDE.md`, `.github/workflows/`, `.gitattributes` and similar) never sync live. They move only through ordinary git commits.
- New files with secret-like names (`.env`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*` and more) are not shared. New files over 1 MiB are not shared, and files of 50 MiB or more never sync live.
- The team shares a push budget of 12 pushes a minute, 6 for half an hour after any throttling, to keep the load on the host low. The daemon’s loop runs every 2.5 s when active and every 10 s when idle.
- Git commands that move `HEAD` (commit, switch, checkout, pull, merge, rebase, stash) freeze sync until `HEAD` is back. Stop sync before you run them. If the board’s history is ever rewritten, every PC freezes until it is recovered.

What leaves your PC:

- **Where it goes:** only to your clone’s own git remote, through git. The daemon runs git as child processes with git’s prompts turned off, and its bundle loads no Node network module.
- **What is sent:** the paths and contents of the files you save that are in sync scope, plus board commits. Anyone who can read the repository can fetch them, and the preview does not check that the remote is private.
- **Your name:** shared commits carry a display name: `--name` if you pass it, else your git `user.name`, else “cowork peer”. The commit address is a placeholder, not your git e-mail.
- **Join record:** when a PC joins the board, the board records its display name, the plugin version, a hash of the plugin, the protocol number, the `core.autocrlf` setting and hashed fingerprints of the repository’s filter drivers (no paths). When the first PC starts sync, the daemon also pushes a short-lived probe ref to test the host, then deletes it.
- **What stays on your PC:** `.git/cowork/status.json`, the daemon log (`.git/cowork/log/daemon-0.jsonl`), hold records, and the optional read-only viewer, which listens on 127.0.0.1 only.
- The design rules out telemetry, crash reporting, update checks and analytics, and a source lint bans Node network modules everywhere except the viewer’s local server. This is a design rule plus a lint, not an independent audit.

## What works in v0.1.1-preview

- Live sync of one branch’s working tree between several clones, through the git remote only.
- One daemon per clone. The first PC creates the shared board and later PCs join it. After a crash or a stop, the next `start` resumes from the saved state and rebuilds lost local state.
- A freeze when the board’s history is rewritten, with a `recover` step to restore it.
- No overwrite of an edit you just saved; groups of files are written all or none.
- Same-line conflicts keep both versions: one on the board, the other as a hold record in the clone.
- Settings, hooks and CI files never sync live; new files with secret-like names are not shared.
- A freeze while a git command has moved `HEAD`, lifted when `HEAD` is back.
- A status file and a JSON-lines daemon log in each clone.
- The `/cowork-sync:cowork` command with `start`, `status`, `stop`, `view` and `help`.
- The core of a read-only viewer that draws the team’s board in a browser, started from a terminal (English only; see the `view` limit).

Tested so far:

- On a real GitHub repository with two clones: edits to different files, to the same file ten lines apart, and to the same line all ended in the same state on both clones, on one fast-forward history.
- Hosted CI runs every check on Windows, macOS and Linux, each with Node 20 and Node 24, against local bare remotes and a simulator.

## Preview limits

**Safety and privacy**

- The remote is not checked for being private. Use a private repository: anyone who can read it can fetch `refs/cowork/*`.
- File contents are not scanned for secrets; only new file names are checked. Keep secrets out of synced files.
- Teammates with write access are trusted: their edits are written into your working tree. Back up anything you care about.

**Not built yet**

- Claude does not know about the sync: no hooks, no MCP tools, no function-level claims, no Claude-to-Claude coordination.
- No `save` step that turns shared work into a commit, and no `pause`, `resume`, `doctor` or `uninstall` verb.
- No command to see or restore a hold record.
- `view` only prints a terminal command. A build without the viewer process refuses with `RF_VIZ_START_FAILED`.
- Messages are in English only. Some refusals point at `/cowork doctor`, which does not exist yet, or name the bare `/cowork` instead of `/cowork-sync:cowork`.

**Testing gaps**

- The real GitHub test ran both clones’ engines in one process. A run on two separate machines is still to do.
- Only GitHub has been tried as a real host. Treat hosts that reject custom refs as unsupported.

**Repositories and day-to-day use**

- Linked worktrees and submodules are refused.
- Git commands that move `HEAD` freeze sync; stop sync first.
- Custom refs stay on the remote after stop or uninstall; delete them by hand.
- There is no autostart: after a reboot or logout, run `start` again.
- Updates are not automatic.
- This is a personal project. Reports are answered as time allows, and only the latest preview gets security fixes.

## Roadmap

Planned for v1, the first full public release. These are plans; no dates are set.

- **Holds and change-sets:** see and restore hold records, a mass-change breaker, a revert detector.
- **Function-level claims:** Python, JS/TS and C# by symbol, other text files by block.
- **Claude Code integration:** hooks, an edit gate, MCP tools and local IPC.
- **Claude-to-Claude coordination:** conflict flows, requests and answers, notifications to sessions.
- **The full command set:** start, stop, pause, resume, save, adopt, recover, uninstall, status, doctor; a check that the remote is private; a secrets scanner; messages in six languages.
- **Sync tied to a session:** sync while a Claude Code session is open, or for a set time with `/cowork start --human <minutes>`. Public remotes refused.
- **Hosts:** GitHub, GitLab and Gitea, once the start probe confirms custom refs and leases.
- **Viewer 2:** `view` as a slash command, six-language catalogs, WebM and GIF export, a highlight reel. Its last task is the first full public release.
- **Before host-dependent work ships:** a second PC on another network, a 24-hour credential run with a forced sign-out, and interactive terminal and VS Code runs.

Developer notes: https://raw.githubusercontent.com/Kingyoungmins/cowork-sync/main/docs/STATUS.md

## Licence in plain words

cowork-sync is source-available under the Functional Source License 1.1, with the Apache License 2.0 as its future licence (FSL-1.1-ALv2). Copyright 2026 Youngmin Seo.

- You may use, copy, change and share it for any purpose except a competing use.
- A competing use means offering it, or something that does substantially the same thing, to others as a commercial product or service.
- Internal use, non-commercial education, non-commercial research, and professional services for a licensee are allowed.
- Each release becomes available under the Apache License 2.0 two years after it is released.
- There is no warranty, and the licence grants no trademark rights.
- Contributions need the contributor licence agreement (CLA). You agree to it with a comment on your pull request.

This summary is not the licence. The terms are in LICENSE.md: https://raw.githubusercontent.com/Kingyoungmins/cowork-sync/main/LICENSE.md

## Contributing and security

- Every contribution needs the individual contributor licence agreement (CLA). To agree, comment on your pull request with the exact sentence "I have read the CLA and agree to it". Contributions must pass `npm run ci` and hosted CI on three operating systems. See https://raw.githubusercontent.com/Kingyoungmins/cowork-sync/main/CONTRIBUTING.md
- Report security problems only through GitHub's private vulnerability reporting: the repository's Security tab, then "Report a vulnerability" (https://github.com/Kingyoungmins/cowork-sync/security). Not in a public issue. See https://raw.githubusercontent.com/Kingyoungmins/cowork-sync/main/SECURITY.md
- Only the latest preview release gets security fixes. Reports are answered as time allows; there is no bug bounty.

## FAQ

### Is it ready for my real project?

No. It is an early preview, not a finished product. Use it on a test repository only, and back up anything you care about.

### Is there a server? Where does my code go?

There is no server. The only transport is your project’s own git remote. Saved files go to two custom refs on it: `refs/cowork/<branch>/board` and `refs/cowork/<branch>/code`.

### Which git hosts work?

A host that accepts custom refs and enforces `--force-with-lease`. GitHub does both, and the first PC’s `start` refuses a host that fails its probe. Only GitHub has been tried for real; GitLab and Gitea are in the v1 plan.

### Will it push to my branch or clutter my history?

No. The preview never pushes to `refs/heads/<branch>`, and a plain `git fetch` does not download the custom refs. The refs stay on the remote until you delete them.

### What happens when two people edit the same line?

One version wins. The other is kept as a hold record in the clone whose version lost, and it is never thrown away. There is no command yet to see or restore it.

### Does my Claude coordinate with my teammates’ Claude?

Not in this preview. Claude does not know about the sync; its edits sync like any saved file. Hooks, MCP tools, claims and coordination are planned.

### Can I use a public repository? Who can read the shared work?

Use a private remote only. Anyone who can read the repository can fetch `refs/cowork/*`, and the preview does not check that the remote is private.

### How do I turn the shared work into a commit?

There is no `save` step yet; it comes with the full command set. Do not run git commands that move `HEAD` while sync runs; stop sync first.

### How fast do edits arrive?

No end-to-end latency is published for the preview. The daemon’s loop runs every 2.5 s when active, and the team shares a budget of 12 pushes a minute (6 after throttling).

### Do I need Claude Code open while it syncs? Does it work with other editors?

You install the plugin and run the command in Claude Code, and the same verbs run from a terminal. After `start`, the daemon keeps running in the background and picks up saved files, whatever saved them. As far as the code shows, the preview’s daemon is not tied to an open Claude Code session; it runs until you stop it.

### Will it share my .env or keys?

New files with secret-like names (`.env`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*` and more) are not shared. File contents are not scanned yet, so do not put secrets in synced files.

### Can I use it at work, and can I contribute?

Internal use is allowed under FSL-1.1-ALv2; offering it, or something substantially similar, to others as a commercial product or service is not. Each release becomes Apache-2.0 two years after it is released. Contributions need the CLA, agreed with a comment on your pull request.

