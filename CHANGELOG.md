# Changelog

All notable changes to cowork-sync are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
preview versions carry a `-preview` suffix.

## [0.1.1-preview] - 2026-10-10

Fixes for the test suite on GitHub's Linux, macOS and Windows runners, and three
small product changes. Still a preview: use it on a test repository only.

### Changed

- `view` on Windows: the data-folder owner check calls its PowerShell cmdlets by
  their full module names (so a same-named cmdlet elsewhere cannot stand in), and the CLI waits
  up to 15 seconds for the viewer to report ready on Windows (5 seconds on Linux
  and macOS).
- Refusal hints no longer glue a comma to a git command you would copy: they say
  `<command> — then: <next step>`.

### Fixed

- Test suite on hosted runners: viewer tests now use the plugin's own version;
  fresh clones settle before a test starts sync; the POSIX owner-probe fake and a
  test commit's git identity match real machines; on Node 20 the test launcher
  gives each test file its own time budget and keeps test output on macOS.

### Known limitations

- Starting sync within a fraction of a second after a fresh checkout can be
  refused as local work on a fast machine; start it again a moment later.

## [0.1.0-preview] - 2026-10-09

The first preview. It contains the sync engine and the core of the read-only
viewer. Use it on a test repository only.

### Added

- Live sync of one branch's working tree between several clones, through the
  git remote only: custom refs `refs/cowork/<branch>/board` (the authority, fast
  forward only) and `refs/cowork/<branch>/code` (a mirror), leased fast-forward
  pushes, merges with `git merge-tree` and explicit bases.
- A sync daemon per clone (`dist/daemon.js run | recover | resume`): genesis on
  the first PC and join on the others, restart after a crash or a stop,
  rebuilding lost local state, and a freeze when the board's history is
  rewritten, with `recover` to restore it.
- A verifying writer: a file is written only if it still holds the bytes the
  daemon last read, and a group of files is written all or none.
- A team-wide push budget of 12 pushes a minute, falling back to 6 after any
  throttling.
- Same-line conflicts keep both versions: one wins on the board, the other is
  kept as a hold record in the clone.
- Settings, hooks and CI files (`.claude/`, `.github/workflows/`,
  `.gitattributes` and similar) never sync live. New files with secret-like
  names (`.env`, `*.pem`, `*.key` and more) are not shared.
- A freeze while `HEAD` is moved by a human git command, lifted when `HEAD` is
  back.
- `.git/cowork/status.json` and a JSON-lines daemon log in each clone.
- The Claude Code plugin package and a minimal `/cowork-sync:cowork` command with
  `start`, `stop`, `status`, `view` and `help`.
- The read-only viewer core: `node dist/cli.js view` from a terminal starts a
  local viewer that draws the team's board in the browser (English only).
- A real two-clone test against a remote (`npm run real:two-clone`) and its
  cleanup script (`npm run real:cleanup`).

### Known limitations

- The remote is not checked for being private. Use a private repository.
- File contents are not scanned for secrets. Only file names are checked.
- There is no command to see or restore a hold record.
- There is no `save` step that turns the shared work into a commit, and no
  `pause`, `resume`, `doctor` or `uninstall` verb. Git commands that move
  `HEAD` freeze sync; stop sync before you run them.
- Claude Code sessions do not know about the sync: no hooks, no MCP tools, no
  function-level claims, no Claude-to-Claude coordination. Claude's edits sync
  like any saved file.
- `/cowork-sync:cowork view` only prints the command that opens the viewer; the viewer
  opens from a terminal. If the viewer process (Plan 8a Task 15) did not make
  this build, `view` refuses with `RF_VIZ_START_FAILED`. Some refusals point at
  `/cowork doctor`, which does not exist yet.
- Messages are in English only.
- The real test against GitHub runs both clones' engines in one process. A run
  of the daemon on two separate machines against GitHub is still to do.

[0.1.1-preview]: https://github.com/Kingyoungmins/cowork-sync/releases/tag/v0.1.1-preview
[0.1.0-preview]: https://github.com/Kingyoungmins/cowork-sync/releases/tag/v0.1.0-preview
