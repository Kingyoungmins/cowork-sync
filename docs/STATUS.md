# Project status

Written on 2026-10-09 (afternoon), while v0.1.0-preview was being cut. This
file is for the next developer, who may continue without the agents that wrote
most of the code.

**Read this first.**

- Some branches below were still moving when this was written. The state is the
  state at the time of writing. Check `git log <branch>` for the newest commits.
- Commit ids are given only to help you find things. They may change if the
  history is rewritten before the repository goes public. The branch names are
  the stable handle.
- At the time of writing, only `main` and `feat/p1-foundation` are on the
  remote. Every other branch named here exists only in the owner's local clone.
  Push them before you rely on them from another machine.
- The task ledgers (`progress.md`, `contract.md` and the task briefs) live
  untracked under `.worktrees/<plan>/.superpowers/sdd/<plan>/` on the owner's
  PC. They are not in the repository. This file summarises what matters in
  them.

## Where things are

| What | Where |
| :- | :- |
| Design (entry point) | `docs/superpowers/specs/2026-10-01-cowork-sync-design.md` (Korean summary next to it) |
| Spec (binding) | `docs/spec/00-glossary.md` and chapters `01-engine.md` … `12-visualizer.md`. The glossary wins over the chapters. Inside the glossary, the newest revision section wins (§29 > §27 > §26 > §25 > §24 > base). |
| Roadmap | `docs/superpowers/plans/2026-10-02-cowork-sync-roadmap.md` (plans, dependencies, exit criteria, owner decisions D1–D5) |
| Plans on `main` | Plan 1 `2026-10-02-cowork-sync-p1-foundation.md`, Plan 2 `2026-10-06-cowork-sync-p2-engine.md`, Plan 8a `2026-10-07-cowork-sync-p8a-viz.md`, F04-a `2026-10-08-cowork-sync-f04a-since.md` (all in `docs/superpowers/plans/`) |
| Plans only on their branch | Plan 3 on `feat/p3-holds`, Plan 4 on `feat/p4-regions`, Plan 5 on `feat/p5-claude`, Plan 6 on `feat/p6-coord`, Plan 7 on `feat/p7-product`, Plan 8b on `feat/p8b-viz2` (each in `docs/superpowers/plans/`) |
| Feature proposals (rev 2.5) | `docs/proposals/F*.md`, the work order in `docs/proposals/QUEUE.md` |
| Spike results (real hosts) | `spikes/` and glossary §25–§26 |
| CI | `.github/workflows/ci.yml` (every push to `main` and every pull request), `sim-exit.yml` and `sim-long.yml` (nightly and on demand) |

## How the work is organised

- One integration branch per plan, `feat/pN-<name>`, with a worktree under
  `.worktrees/`. Each task gets its own branch `feat/pN-tM`, cut from the plan
  branch and merged back with `--no-ff` after review. A plan branch merges into
  `main` when its exit criterion holds.
- Test first (TDD). `npm run ci` must be green before a merge.
- The worktrees share one `node_modules` through a link to
  `.worktrees/p2-engine/node_modules`. Never run `npm install` or `npm ci`
  through such a link: it rewrites the tree for every worktree. A task that adds
  a dependency gets its own `node_modules`.
- Each plan's controller copies the review rules into its ledger. Since
  2026-10-08 the review is simplified: two reviewers per task (spec and tests
  in one lens, robustness in the other), adversarial checks only for Critical
  findings, at most three fix rounds.
- Lint rule L-PID-KILL: never kill a process by a bare PID. The only allowed
  forms are the runner's tree kill and the viewer's process-group kill.

## Plans

State as of writing. "Merged" means merged into `main` unless another branch is
named.

| Plan | Builds | State | Next step and gate |
| :- | :- | :- | :- |
| 1 Foundation | Toolchain, ports (clock, random, scheduler, fs, crashpoints), `runGit`, push-outcome classifier, bare-remote fixtures, SIM harness, lint suite, CI | **Done.** Tasks 1–15 merged. | — |
| 2 Engine | Board and code refs, op fold, state ref, snapshot, `merge-tree`, verifying writer, push governor, publish and fetch loop, genesis and join, restart, incidents and recover, `status.json`, the foreground daemon `dist/daemon.js` | **Done.** Tasks 1–20 and the final-review fixes FA–FD merged (`main` 0d025a5). CI when it landed: lint clean, 981 tests (965 pass, 0 fail, 16 skipped), `sim:smoke` 10/10, `sim:seeds` 5/5; after the Plan 8a merge (9e9a22b): 1,341 tests (1,321 pass, 0 fail, 20 skipped), same SIM results. The real two-clone run on a GitHub sandbox passed (three scenarios, converged, one first-parent history, 16 pushes, 226 s). | Parked items, see "Known open items". |
| F04-a Catch-up core | `src/data/zone.ts`, `SinceMarks`, the `meta.since` parse (A1); the pure core `src/since/report.ts` and the walker `walkSince` (A2); a terminal `node dist/cli.js since` (A3) | Gate met. **A1 complete** on `feat/f04a-since` (3cf1ee7). **A2 implemented** on `feat/f04a-a2` (570cde3), review not finished. A3 not started. Nothing on `main`. | Finish A2's review, then A3, then merge into `main`. At that merge: add the `src/data/zone.ts` row to Plan 8a's R-V02 table and to the member list in `test/integration/viz/lintClient.test.ts`; share the `'·'` root glyph that `zone.ts` and `layout.ts` both define. |
| 3 Holds and change-sets | Hold registry, MASK, ready pairs and rebase, publication groups, revert detector, mass-change breaker, INCOMING records, the INV-NOLOSS oracle; F10 revert kernel; F14 inputs | **In progress** on `feat/p3-holds` (825e665): Tasks 1–7 merged there, plus the finished Plan 2 (CI: 1,349 tests, 1,328 pass, 0 fail, 21 skipped). Task 8 implemented on `feat/p3-t8` (eaaa7c4), in review. Task 9 started on `feat/p3-t9`. Tasks 10–19 open. | Tasks 8–18, then merge Plan 3 into `main` (this is the gate for Plans 4, 5 and 7). Task 19 waits for F04-a. Exit: INV-NOLOSS, INV-MASK and INV-GROUP pass on 1,000 seeds. |
| 4 Regions and claims | tree-sitter WASM worker, region tables, claim ops and fold, publish gate B1, edit check, interface check | **Started** on `feat/p4-regions` (e704bad = plan + `main`). Task 1 (grammar runtime, worker pool; web-tree-sitter 0.27.0) in fix round 1 on `feat/p4-t1` (5eda470). Task 2 (fixture corpus) in fix round 1 on `feat/p4-t2` (c721b5d). | Tasks 3, 4, 6 and 7 may start now (3, then 4, then 6 and 7 in parallel). Tasks 5 and 8–18 wait until Plan 3 is on `main` through its Task 18. |
| 5 Claude Code integration | Plugin layout, `hooks.json`, hook loader, gate G1–G4, fences, leases, seats, MCP server and tools, local IPC, FakeHost for SIM; F04 marks and recap | **Set up** on `feat/p5-claude` (7e694bd = plan + `main`). No task commits yet. | Task 1A (shared declarations) may start now; then 2 and 3 in parallel; then 4. Task 1B and Tasks 5–18 wait until Plan 3 is on `main` through its Task 18. Task 16 also needs F04-a; Task 18 needs Plan 4. |
| 6 Coordination | K1–K7 conflict flows, requests and answers, liveness, doorbells, wake turns, templates en/ko; F05 notes | **Plan only** on `feat/p6-coord` (d541241), 18 tasks. | Starts after Plans 4 and 5. |
| 7 Lifecycle, security, product | The full `/cowork` verb set (start, stop, pause, resume, save, adopt, recover, uninstall, status, doctor), HEAD decision table, private-remote check, secrets scanner, i18n in six languages, packaging and release preparation; F14, F10, F04, F12 verbs | **Set up** on `feat/p7-product` (63f8917 = plan + `main`), 21 tasks. None can start: every task roots in Task 1 or 2, which need Plan 5 Task 1 (notifier, locale, i18n files) and Task 8 (`onHoldCode`), and Plan 3 on `main`. | Re-check when Plan 3 and Plan 5 Tasks 1 and 8 are on `main`. |
| 8a Viewer core | `node dist/cli.js view`, the read-only viewer `dist/viz.js` (loopback HTTP, tokens, SSE), world model, layout, sprites, log, rewind, demo logs | **Partly merged.** On `main`: Tasks 1–7 and 9–14, follow-ups F-8a-2 (`pluginDataDir`, `sddl`), F-8a-3 (`canonRoot`) and FS. On `feat/p8a-viz` (ae0c21f) but not on `main`: Task 8 (room store, poll loop) and Task 16 (demo export, golden timelines). Task 15 (the viewer process) implemented on `feat/p8a-t15` (bf81ff4), in review. Tasks 17–20 open. | Finish Task 15 and merge `feat/p8a-viz` into `main`: until then `view` cannot open the viewer. Then Tasks 17 (browser smoke), 18 (storyboard, bundled demo, exit sweep), 19 (follow a teammate, F32) and 20 (claim inputs). |
| 8b Viewer 2 | `/cowork view` as a slash verb, room discovery, six-language catalogs, WebM and GIF export, postcards, highlight reel, README demo; last task = the first full public release | **Started** on `feat/p8b-viz2` (1da0a28 = plan + `main`). Task 4 (recording core) implemented on `feat/p8b-t4` (ebe28e9), in review. | Task 6 after Task 4 merges. Everything else waits for Plans 5, 7 and 8a. |

### The v0.1.0-preview release

Branch `feat/release-preview`, cut from `main` 9e9a22b. It adds plugin
packaging, a minimal `/cowork-sync:cowork start | stop | status | view | help` shell over
the Plan 2 daemon, and these documents. Shipping a preview now departs from
roadmap decision D4 (the first public release was to be Plan 8b's last task).
The owner decided this on 2026-10-09. Plans that merge and pass CI before the
cut may join the preview; everything else continues as planned.

## Order to continue

The chain is 1 → 2 → 3 → 4 → 5 → 6 → 7, with 8a alongside and 8b at the end.

1. Finish what is in flight: Plan 8a Task 15, then merge `feat/p8a-viz` into
   `main`. F04-a A2 and A3, then merge into `main`. Plan 3 Tasks 8–18, then
   merge Plan 3 into `main`. Plan 4's early tasks (1–4, 6, 7). Plan 5 Task 1A.
2. With Plan 3 on `main`: Plan 4 Tasks 5 and 8–18, and Plan 5 Task 1B onward.
   Plans 4 and 5 may run side by side (`src/regions/**` and `src/claude/**` do
   not overlap). Plan 3 Task 19 after F04-a.
3. Plan 6 after Plans 4 and 5.
4. Plan 7 after Plans 2–6.
5. Plan 8a Tasks 17–20 alongside. Plan 8b after Plans 5, 7 and 8a. Its last
   task publishes the first full release.

Two rules hold across plans:

- Once 8a has landed, each later plan's exit includes its rows of the viewer's
  timeline fixtures (`T-VIZ-timeline-fixtures`) and a reviewed update of the
  SIM golden timeline.
- Host-dependent work in Plans 5 and 6 is not released before the three human
  spikes of glossary §26.3 have run: a second PC on another network, a 24-hour
  credential run with a forced sign-out, and interactive terminal and VS Code
  runs.

## Running the checks

```sh
npm ci
npm run ci
```

`npm run ci` runs, in order: `lint`, `typecheck`, `build`, `test`, `sim:smoke`
and `sim:seeds -- --profile edits --seeds 5`. It needs Node.js 20.6 or newer
and git 2.43 or newer. The hosted CI runs the same gates on Windows, macOS and
Linux, each with Node 20 and Node 24. On a busy machine a few long SIM tests can
hit their 600-second limit; rerun that file alone before you call it a failure.

Other scripts: `npm run test:unit`, `npm run test:integration`,
`npm run sim:exit` (1,000 seeds, 8 in parallel).

### The real two-clone test

This runs two engines against a real remote. Use a sandbox repository that you
own and that nobody else uses. Its default branch must contain a file named
`.cowork-test-repo`; without it the test refuses before any push.

```sh
COWORK_REAL_REMOTE=<https url of the sandbox> npm run real:two-clone
COWORK_REAL_REMOTE=<https url> npm run real:two-clone -- --timeout-min 15 --keep
```

Credentials come from your git credential helper. A URL with a password in it
is refused. The test pushes the default branch to `ci/<run_id>/main`, clones it
twice, runs three scenarios (different files, same file ten lines apart, same
line) and checks that both clones converge on one first-parent history. It
prints a report and the cleanup command. It never deletes a remote ref itself.
To remove a run's refs:

```sh
npm run real:cleanup -- --remote <url> --run <run_id>         # lists the refs
npm run real:cleanup -- --remote <url> --run <run_id> --yes   # deletes them
```

## Known open items

- **Not built yet, so missing from the preview:** the private-remote check
  (SEC-12) and the content secrets scan (both Plan 7); the HEAD decision table,
  `save`, `pause`, `resume` and `doctor` as user verbs (Plan 7); any way to see
  or restore a hold record (Plan 3); Claude session hooks and MCP tools
  (Plan 5).
- **The daemon is foreground only.** `node dist/daemon.js run` has no detach
  mode. The release shell's `start` launches it in the background; the real
  detached `spawnDaemon()` of the spec is Plan 5 work.
- **Data folder name.** `src/data/pluginDataDir.ts` falls back to
  `~/.claude/plugins/data/cowork-sync`, while Claude Code gives hooks and MCP
  servers `~/.claude/plugins/data/cowork-sync-<marketplace>`. Harmless today
  (only the viewer uses it); Plan 5 or 7 must reconcile it.
- **Plan 2 items parked for Plan 7:** the long mutation and crash matrices were
  not re-run after the quiescence change (`sim-long.yml` runs them); load-bound
  tests (the SIM determinism test, the seed runner's hang test) need their own
  CI step or larger budgets; open-handle warnings in the daemon CLI and
  two-clone tests; a few message codes to rename or register
  (`RECOVER_PREVIEW_STALE`, `START_REMOTE{genesis_push_failed}`,
  `START_REPO_SHAPE`).
- **Not yet tried:** `node dist/daemon.js run` as a long-lived process against
  GitHub on two separate machines. The two-clone test drives both engines in
  one process.
- **Spec edits owed.** Several ledgers collected small "spec-edit" items (for
  example `meta.since` heights may be null, the L-PID-KILL exceptions, the
  viewer's `killTree` signature). Plan 7's and 8a's final spec batches are
  where they were meant to land.
