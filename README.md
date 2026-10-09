# cowork-sync

cowork-sync is a Claude Code plugin that keeps the working tree of one git
branch in sync between several clones, in real time. Each teammate works on
their own PC, in their own clone, with their own Claude Code session. When
someone saves a file, the change reaches everyone else's working tree. The only
transport is the project's own git remote. There is no server.

cowork-sync is a personal source-available project. It is not affiliated with,
sponsored by or endorsed by any company or employer. It is licensed under
FSL-1.1-ALv2 (see [LICENSE.md](LICENSE.md)), and contributions need the CLA
described in [CONTRIBUTING.md](CONTRIBUTING.md).

## Status: v0.1.0-preview

This is an early preview, not a finished product. What works now: the sync
engine. One background process (the daemon) per clone picks up saved edits,
publishes them to the remote, and writes teammates' edits into your working
tree. It was tested on a real GitHub repository with two clones: edits to
different files, to the same file ten lines apart, and to the same line all
ended in the same state on both clones, on one fast-forward history. The core
of the read-only viewer, which draws the team's activity in a browser, is in
too. What is not in yet: the conflict holds UX (a displaced version is kept,
but there is no command to see or restore it), function-level claims,
Claude Code session hooks and Claude-to-Claude coordination (in this preview
Claude does not know about the sync; its edits sync like any other saved
file), the full command line (save, doctor, start checks such as the
private-remote check, pause and resume), and viewer 2 (six languages,
recording, highlight reel). Use the preview on a test repository only.
[docs/STATUS.md](docs/STATUS.md) lists what is done and what is next.

## Requirements

- Claude Code 2.1.270 or newer.
- Node.js 20 or newer on `PATH` (20.6 or newer to build from source).
- git 2.43 or newer. Start refuses an older git.
- Windows, macOS or Linux.
- A **private** git remote that accepts custom refs (`refs/cowork/*`) and
  enforces `--force-with-lease`. GitHub does both. Start probes the host and
  refuses one that does not.
- Credentials from a git credential helper. cowork-sync turns git's prompts
  off, so a missing credential gives a clear refusal instead of a hang.

## Install

Every PC that takes part installs the plugin and has its own clone of the
repository.

In a Claude Code session:

```text
/plugin marketplace add Kingyoungmins/cowork-sync
/plugin install cowork-sync@cowork-sync
```

Or from a shell:

```sh
claude plugin marketplace add Kingyoungmins/cowork-sync
claude plugin install cowork-sync@cowork-sync
```

Run `/reload-plugins` (or restart Claude Code) to load it. Updates are not
automatic for this marketplace. To update, run
`/plugin marketplace update cowork-sync`, then
`claude plugin update cowork-sync@cowork-sync`. To remove the plugin, run
`claude plugin uninstall cowork-sync@cowork-sync`.

## Use

Open Claude Code in your clone and type the commands below. Claude Code names
the plugin's command `/cowork-sync:cowork`; type that name in full. The same
verbs also run in a terminal, as `node "<plugin folder>/dist/cli.js" <verb>`;
`/cowork-sync:cowork view` prints that path.

| Command | What it does |
| :- | :- |
| `/cowork-sync:cowork start [--branch <b>]` | Starts sync for this repository, on the current branch. The first PC creates the shared board on the remote; every later PC joins it. The daemon keeps running in the background. |
| `/cowork-sync:cowork status` | Prints a short summary: the state (`ok`, `degraded`, `offline`, `frozen`, `down` and so on), the branch, and what is still waiting to be published or applied. |
| `/cowork-sync:cowork view` | Prints the command that opens the read-only viewer. The viewer opens only from a terminal: run that command there and it opens in your browser. If your build does not have the viewer process yet, it refuses with `RF_VIZ_START_FAILED` (see [CHANGELOG.md](CHANGELOG.md)). |
| `/cowork-sync:cowork stop` | Stops the daemon cleanly. Your files stay as they are. |
| `/cowork-sync:cowork help` | Lists the commands. |

When a command refuses, it prints the reason with a code, and a `next:` line
with the command to run. When the daemon itself refuses to start, its own lines
follow `the daemon did not start; it said:`.

What `start` checks:

- It runs in the main clone. A linked worktree or a submodule is refused.
- The branch is checked out, exists on the remote, and is neither ahead of nor
  behind it. Push or pull first. No merge or rebase may be in progress.
- The remote's fetch URL equals its push URL, and no `insteadOf` rewrite
  applies.
- Only one daemon runs per clone.
- If you have uncommitted changes at the first start, it stops and asks you to
  choose: share them with the team, or keep them on this PC.

While sync runs:

- Save files as usual. Your saved edits are published, and teammates' edits
  are written into your files.
- Do not run git commands that move `HEAD` in a synced clone (commit, switch,
  checkout, pull, merge, rebase, stash). Sync freezes until `HEAD` is back
  where it was. Stop sync first.
- There is no `save` step yet that turns the shared work into a commit on the
  branch. That comes with the full command line. Treat the preview as a way to
  try live sync on a test branch.

Each clone keeps its own files under `.git/cowork/`: `status.json` (the current
state) and `log/daemon-0.jsonl` (the daemon log).

## How it works

1. Each clone runs one daemon. It reads your saved files through its own private
   git index and never touches yours.
2. The shared state lives in two custom refs on your remote:
   `refs/cowork/<branch>/board`, a fast-forward-only chain of board commits that
   is the authority, and `refs/cowork/<branch>/code`, a mirror of the latest
   shared tree. Branch names are percent-encoded in these refs.
3. Every push is a fast-forward guarded by a lease (`--force-with-lease`), so
   no PC can overwrite another's update. The loser fetches and tries again. A
   team-wide budget (12 pushes a minute, 6 for half an hour after any
   throttling) keeps the load on the host low.
4. Incoming changes are merged with `git merge-tree` using explicit merge bases.
5. A file is written only if it still holds the bytes the daemon last read, so
   an edit you just saved is never overwritten. A group of files is written all
   or none.
6. When two people change the same line, one version wins and the other is kept
   as a hold record in your clone. It is never thrown away.
7. Settings, hooks and CI files (`.claude/`, `.github/workflows/`,
   `.gitattributes` and similar) never sync live. If the board's history is
   ever rewritten, every PC freezes until it is recovered.
8. The preview never pushes to your branch (`refs/heads/<branch>`). A plain
   `git fetch` does not download the custom refs, so your normal git history
   stays clean.

## Safety notes

- cowork-sync writes into your working tree, and so do your teammates' edits.
  Try it on a test repository first, and back up anything you care about.
- Use a **private** remote only. Everything you save in a synced clone is
  pushed to `refs/cowork/*`, and anyone who can read the repository can fetch
  it. The preview does not check yet that the remote is private.
- New files whose names look like secrets (`.env`, `*.pem`, `*.key`,
  `id_rsa*`, `*credentials*` and more) are not shared. File contents are not
  scanned for secrets yet, so do not put secrets into synced files.
- Files over 1 MiB are not shared when new, and files of 50 MiB or more never
  sync live.
- Stopping sync or uninstalling the plugin leaves the custom refs on the
  remote. After every PC has stopped, you can delete them by hand, for example
  `git push origin --delete refs/cowork/main/board refs/cowork/main/code`.

## Licence

cowork-sync is released under the Functional Source License 1.1 with the
Apache License 2.0 as its future licence (FSL-1.1-ALv2,
[LICENSE.md](LICENSE.md)). In short: you may use, copy, change and share it
for any purpose except a competing use, which means offering it, or something
that does substantially the same thing, to others as a commercial product or
service. Internal use, education, research and professional services for a
licensee are allowed. Each release becomes available under the Apache License
2.0 two years after it is released.

Contributions need the contributor licence agreement in [CLA.md](CLA.md). See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to sign it and how to work on the
code.

## Contact

Questions: minzbusiness0204@gmail.com. Please report security problems
through the repository's private vulnerability reporting, not by e-mail. See
[SECURITY.md](SECURITY.md).
