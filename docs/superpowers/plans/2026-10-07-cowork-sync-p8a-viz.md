# cowork-sync Plan 8a — Visualizer Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core of the read-only team viewer of 12-visualizer on the Plan 2 engine: `node dist/cli.js view [--repo <path>]… [--demo[=<file>]] [--no-open]` in `tty` mode, which starts the separate read-only process `dist/viz.js`; that process folds the already-fetched board of every `--repo` room (or a `cowork-viz-demo/1` demo log) with the engine's own `foldCommit`, turns the folded history into a deterministic, append-only timeline of scene events (the pure world model), and serves one page on `127.0.0.1` (random port, single-use launch token in the URL fragment, session token in a header, a JSON snapshot and an SSE stream) that draws the map of rooms, the office with desks, original "mallang" characters, the conversation/activity log and the rewind bar. `en` strings only. The 8a exit criterion is roadmap row 8 (8a): the listed T-VIZ-* tests green on the three CI OS legs, browser smoke items (a)–(g) and (i) green on one leg, and the Plan 2 storyboard of 12 §3.9.3 rendering in `en` through `node dist/cli.js view --demo`. 8a is a development milestone and is never released (12 §9.1).

**Architecture:** One new module tree, `src/viz/**`, in five layers, each importing only from the layers listed before it: `model/**` and `ui/**` (pure: the world model of 12 §3.3–§3.8 and the page's DOM-free logic; `model/{events,scene,layout,placement,cards,labels}.ts`, `ui/**` and `render/**` are also compiled into the page), `render/**` (pure art: palette, sprite maps, RGBA composition), `source/**` (the two room sources — git through a read-only git facade, and demo logs — plus `status.json` and room discovery), `server/**` (room stores, the poll loop, the view-model projection, the stream hub, tokens, the loopback HTTP server, the viewer log) and the two process edges `main.ts` (`dist/viz.js`) and `cli/**` (the `view` verb inside `dist/cli.js`). `client/**` is browser-only glue (canvas, DOM log, rewind bar, accessibility) over `ui/**`. Only `main.ts` and `cli/**` itself import `cli/**`; `cli/{paths,strings}.ts` are import-free leaves, so `cli.js` bundles nothing of `src/viz/**` outside `cli/**` (VIZ-01, R-V54). Outside `src/viz/**` the plan adds two new board files (`src/board/{batchRead,csActor}.ts`) and two additive board edits (the `opVerdicts` field in `src/board/fold.ts`, five exported parsers in `src/board/boardCommit.ts`), the first versions of the shared `src/text/sanitize.ts` and `src/i18n/render.ts`, the `view` dispatch in `src/entry/cli.ts`, the seventh entry `src/entry/viz.ts`, one runner security fix, and build and lint plumbing — the client program is typechecked inside `npm run lint`, and `package.json`'s `typecheck` script is not touched (§Scope rulings, "Files outside `src/viz/**`", R-V35). The viewer observes and never acts: no ref, object, index, worktree or `<gitdir>/cowork/` write, no IPC, no outbound socket. Tests run real git against `file://` bare remotes on boards built by Plan 2's own board writer; git is never mocked.

**Tech Stack:** unchanged from Plans 1–2 — Node ≥ 20 (`engines.node` `>=20.6` for contributors), TypeScript 5.x, esbuild (a second, `iife` browser build of `src/viz/client/main.ts` embedded into `dist/viz.js` as text), `node:test` via `tsx`, `fast-check`, git ≥ 2.43, GitHub Actions on windows-latest, macos-latest and ubuntu-latest. No new dependency, runtime or dev: `node:http` (server only, `src/viz/server/http.ts`), `node:crypto` (sha256, `timingSafeEqual`), the TypeScript compiler API already in devDependencies (JSON Schemas for T-VIZ-api, generated at test time), and Node ≥ 22's built-in `WebSocket` for the Chrome DevTools Protocol browser smoke (SKIPPED where Chrome or `WebSocket` is absent).

**Spec:** [`docs/spec/12-visualizer.md`](../../spec/12-visualizer.md) (the chapter this plan implements; the newest glossary section wins: §27 > §26 > §25 > §24 > base, and 12 follows glossary rev 2.4) — sections §1.1–§1.5, §2, §3.1–§3.8, §3.9.1–§3.9.3 (§3.9.4 export is 8b), §3.10.1–§3.10.10, §3.11 (`en` only), §3.12, §3.13, §4, §5, §6, §7, §9.7 — and rules **VIZ-01, VIZ-03, VIZ-05…VIZ-27, VIZ-30…VIZ-35, VIZ-37, VIZ-38, VIZ-40…VIZ-42** in full; **VIZ-02** without its `SHA256SUMS` sentence (8b); **VIZ-04** in its `tty` + "start nothing elsewhere" subset (R-V14); **VIZ-36** without its `scanSecrets` step (8b); **VIZ-39** in `en` only; **VIZ-28** and **VIZ-29** not at all (8b); invariants INV-VIZ-READONLY, INV-VIZ-NOCONTENT, INV-VIZ-DET, INV-VIZ-BOARDONLY, INV-VIZ-LOOPBACK, INV-VIZ-AUTH, INV-VIZ-CUSTODY, INV-VIZ-TEXT, and INV-CLOCK, INV-EGRESS (as amended by 12 §9.3), INV-UX-READONLY (as amended by 12 §9.4). Also touched:
- glossary §2, §3 (`H`, `base32c`, heights, live set, ghost, `K_evict`), §5 (trailers), §6 (`dist/`, per-user logs, as amended by 12 §9.2), §7 (ops), §14 (`status.json`), §18 (git runner), §19 (caps, + the 12 §9.2 viewer row), §20 (numbers, + the 12 §9.2 viewer row), §21, §24 defaults 9 and 12, §25 F3/F4, §26.1 W3;
- [`docs/spec/09-security.md`](../../spec/09-security.md) §3.4 (environment builder), SEC-20 (data-directory owner/ACL check), SEC-34 (`sanitize`, + channel `viz`), SEC-35 (validators), SEC-38 (log content), and the 12 §9.3 amendments (egress row E8, L-NET);
- [`docs/spec/10-product.md`](../../spec/10-product.md) §2 (output modes), §3.2 (`render`), §3.4 (refusal format), §3.14 (`PH_*`, `SS_*`), §3.17 (OS locale), I18N-07, UX-01, UX-03;
- [`docs/spec/11-testing.md`](../../spec/11-testing.md) §3.10 (lints, + the 12 §9.5 L-NET/L-PORTS amendments and the new L-VIZ-DOM, L-VIZ-GIT, L-VIZ-IMPORT; 8a implements §9.5's L-NET sub-rules and URL template as L-VIZ-NET and L-VIZ-URL and the client typecheck as L-VIZ-TYPES), §3.11 (CI matrix);
- [`docs/spec/02-protocol.md`](../../spec/02-protocol.md) §3.3 (the fold, read only), PRO-28 (checkpoint compare).

Roadmap: [`2026-10-02-cowork-sync-roadmap.md`](2026-10-02-cowork-sync-roadmap.md) row 8 (8a; "Plan 8a starts when plan 2 has landed", R-V01). Plan 2: `.worktrees/p2-engine/docs/superpowers/plans/2026-10-06-cowork-sync-p2-engine.md` — its Interfaces and its ledger rulings (`.superpowers/sdd/2026-10-06-cowork-sync-p2-engine/{contract,progress}.md`: P2-DEPTH, P2-UTF8, P2-GRAFTS, P2-SAFECRLF, the board size caps, P2-REFOLD) are the real interfaces this plan consumes; every Plan 1 and Plan 2 name below is used verbatim. 8a keeps its own contract and ledger (`.superpowers/sdd/<date>-cowork-sync-p8a-viz/{contract,progress}.md`); the 8a additions to Plan 2 files (`OpVerdict`, `opVerdicts`, the exported parsers) are recorded there, never in Plan 2's contract (R-V02).

**Plan form (controller ruling).** Ruling: this plan is design-complete, not code-complete — every task names its files, the exact interfaces it consumes and produces (§Interfaces), the 12-visualizer rule ids it implements and every test by title with what it asserts; implementers write the code test-first from that contract, and the controller runs independent tasks concurrently in separate worktrees by the parallel groups of §Tasks — the Plan 2 plan used the same form and its per-task reviews caught interface misreads at the next compile — cost if wrong: an implementer misreads an interface, caught by the per-task review and by the dependent task's compile. Executed with superpowers:subagent-driven-development (a fresh implementer and a reviewer per task).

## Global Constraints

**Carried from Plans 1–2 (still binding):**
- Node floor **20** for everything under `src/` and `dist/` (no API newer than Node 20 in shipped code; the browser smoke alone uses Node ≥ 22's `WebSocket` and is SKIPPED below it); dev tooling Node ≥ 20.6.
- Git floor **2.43.0** (glossary §18): the viewer refuses below it with `START_TOOL_VERSION` on its ready line.
- **No runtime dependencies** and **no new dev dependency**; nothing under `src/` imports a package that is not a Node built-in; `dist/viz.js` contains no third-party code (VIZ-20).
- Every git process is started by `createGitRunner(...).run(...)` (L-GIT-SPAWN); the viewer reaches git only through `VizGit` (`src/viz/source/vizGit.ts`), never `GitRepo`, never `child_process`.
- No `Date.now()`, `new Date()`, `performance.now()` outside `src/ports/clock.ts`, no `Math.random`/`randomBytes`/`randomUUID` outside `src/ports/random.ts` (L-CLOCK, L-RANDOM) — except in `src/viz/client/**` (browser code, R-V34). Tokens and salts come from the Random port (`realRandom` in release).
- No `child_process` in `src/` outside `src/git/runner.ts` (L-PORTS) — except `src/viz/cli/{spawn,opener,ownerProbe}.ts` (R-V34); no `fs` import outside `src/ports/fs.ts` (L-FS-PORT) — except `src/viz/cli/ownerProbe.ts` and `src/viz/source/boundedRead.ts` (R-V30); no network module (L-NET) — except the `node:http` import in `src/viz/server/http.ts`, used as a server only (L-VIZ-NET: no `http.request`/`get`/`Agent`, no `connect`/`createConnection`, a literal `'127.0.0.1'` listen host, and no `fetch`, `WebSocket`, `EventSource` or `XMLHttpRequest` global anywhere in `src/viz/**` outside `client/**`).
- Every read of user and cowork files goes through the `Fs` port on `Buffer`s, except the three bounded one-shot reads (`status.json`, `<gitdir>/cowork/peer`, a `--demo` file), which go through the injectable `BoundedReader` port (open with `O_NOFOLLOW` where defined, `fstat` regular file, read ≤ cap + 1 byte, close; R-V30); files are never held open (`status.json` is one open-read-close, glossary §26.1 W3).
- Forced git environment (glossary §18) and `--no-replace-objects` first, P2-UTF8 and P2-GRAFTS: all applied by `buildGitInvocation`, which the viewer uses unchanged.
- Board caps and the board size-before-read ruling (Plan 2 ledger, Task 5): `ops.jsonl` ≤ 64 KiB, ≤ 1,000 lines, ≤ 16 KiB per line; board files ≤ 5,000,000 bytes; a commit object ≤ 1,048,576 bytes is size-checked before it is read; checkpoints at heights divisible by **256**; `K_evict` = **200**; joiner replay ≤ **255**.
- INV-CLOCK: order is board position (height); every viewer lifetime is own staleness `max(Δwall, Δmono)` from a local `Anchor` (`ownStaleness`); poll timing and the 30 s plugin check use Δmono; the overlay's `down` and offline age use `machineMonoMs()`; no remote clock and no commit date is ever read.
- Message codes are registry names verbatim (`^[A-Z][A-Z0-9_]{2,47}$`); every human-facing string is `render(code, params, channel, lang)`.
- Files written by tools and fixtures: LF, UTF-8 without BOM (the repository's `.gitattributes` `* text=auto eol=lf` already checks out `*.jsonl` and `*.json` with LF on every OS; T-VIZ-demo tests assert no CR and no BOM in the bundled demo and the goldens).
- Integration tests run real git against `file://` bare remotes (Plan 1 `createBareRemote`, `clonePeer`; Plan 2 `makeRepoFixture`), temp roots from `makeTempRoot` (spaces and Hangul in the path); git is never mocked; boards are built with Plan 2's `buildBoardCommit`/`liveCommitTrailers` through `tools/viz/boardWriter.ts`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Viewer git (VIZ-06, VIZ-07; rulings R-V05, R-V06, R-V09, R-V10, R-V13):**
- Every viewer git call: class `local`, an absolute canonical `--git-dir`, cwd = the data directory, the absolute `gitPath` the CLI resolved and passed as `--git` (R-V13: realpath outside every repository root the CLI excludes, a regular file after following symlinks, on POSIX owned by uid 0 or the user and not group- or world-writable), `-c protocol.allow=never` and `-c protocol.{file,git,http,https,ssh}.allow=never` (`protocol.ext.allow=never` is already forced by the runner), environment `GIT_NO_LAZY_FETCH=1` (and the forced `GIT_OPTIONAL_LOCKS=0`); never `safe.directory`, never a command that can take a lock, run a filter, hook or fsmonitor, or touch the network. A demo run resolves and calls no git (VIZ-06).
- The allowlist (L-VIZ-GIT, enforced statically and by `VizGit` at run time through `vizGitArgvOk` of `src/viz/source/vizGitArgv.ts`), each form exactly, with no extra argument: `version`; `rev-parse --verify -q <ref>`; `for-each-ref --format=%(objectname) %(refname) refs/cowork-remote/`; `rev-list --first-parent --count <oid>`; `rev-list --first-parent [--skip=<n>] --max-count=<n> <oid>`; `cat-file --batch-check`; `cat-file --batch` — where `<ref>` matches `^refs/cowork-remote/[^\s]+/board$`, `<oid>` satisfies `isOid`, and `<n>` is decimal `^(0|[1-9][0-9]{0,9})$` (S22).
- Board and live commits are read only in batches of ≤ **1,280** board commits: one `cat-file --batch-check` (types and sizes) then one `cat-file --batch` (contents within the caps) per batch, covering the board commits and the live commits they name; a `cat-file` process lives for one batch.
- Per room and 2.5 s tick: **0** git processes while the stat pairs are unchanged; **1** `rev-parse` when one changed or **60 s** passed; with new commits + **1** `rev-list` (+ 1 `rev-list --count` only for a catch-up beyond 1,280 or a suspected rewrite) + **2** `cat-file` per batch; never 2 concurrent git children per room. A viewer git call is killed after **120 s** (the runner's read/hash watchdog value, R-V06).
- **Claim inputs (owner choice of 2026-10-08, X-92 decided; 12 §3.3.3; Task 20).** From Task 20 the allowlist also holds `merge-base --is-ancestor <oid> <oid>` (used only for the claim-input tombstone rule), and every board commit is folded with claim inputs: a commit whose `claimFoldNeeds` is not empty reads, while it is folded and for it alone, one `cat-file --batch` of the named `<commit>:<path>` entries and anchor blobs (32 MiB per call; a larger blob alone in one more call) and one `merge-base --is-ancestor` per tombstone anchor this viewer run has not answered yet; the bytes stay inside that one fold step (never on a `Frame`, in a fold state, a log, a file or a response); a room waiting for a missing object adds one `cat-file --batch-check` per 30 s. Tasks 1–19 build none of this (Plan 2's `foldCommit` has no claim inputs).

**Viewer process and CLI (12 §3.2, §3.10):**
- Ready handshake: the CLI reads ≤ **512** bytes within **5 s**; the line is `{"v":1,"port":<int>,"launch":"<64 lowercase hex>"}` or `{"v":1,"refuse":"<code>"[,"line":<n>]}`; anything else, or a timeout → kill the child's process tree and `RF_VIZ_START_FAILED`.
- Launch URL `^http://127\.0\.0\.1:[1-9][0-9]{0,4}/#k=[0-9a-f]{64}$`, re-validated immediately before the opener spawn; tokens 32 bytes (64 hex) from the Random port; launch token single use, TTL **120 s**; session token sent only as `X-Cowork-Session`.
- Exits: launch unredeemed **120 s** (`VIZ_EXIT_LAUNCH_UNUSED`); launch reused (`VIZ_EXIT_LAUNCH_REUSED`); no open stream and no authenticated request for **10 min** (`VIZ_EXIT_IDLE`); **24 h** (`VIZ_EXIT_LIFETIME`); `dist/viz.js` gone or changed at the **30 s** check (`VIZ_EXIT_PLUGIN_REMOVED`); `SIGTERM`/`SIGINT`/`SIGHUP` (`VIZ_EXIT_SIGNAL`).
- Read caps (file reads through the `BoundedReader`: read ≤ cap + 1 byte and refused when the extra byte arrives; a FIFO, a directory or a symlink is refused without blocking): `status.json` ≤ **1 MiB**; `--demo` file ≤ **4 MiB**; `<gitdir>/cowork/peer` ≤ **4 KiB**; the bundled demo (embedded in `dist/viz.js`, no file read) ≤ **64 KiB**.
- HTTP: `127.0.0.1`, port 0, `exclusive: true`, address verified; request line + headers ≤ **8 KiB**, URL ≤ **2 KiB**, `headersTimeout` **5 s**, `requestTimeout` **10 s**, `keepAliveTimeout` **5 s**, `connectionsCheckingInterval` **1 s**, ≤ **32** connections, a body only on the session POST and ≤ **256** bytes, `insecureHTTPParser` off, `requireHostHeader: false` (the admission check answers a missing `Host`); responses Node writes before the handler runs (`clientError`, `Expect`) also carry the whole header set (R-V48); the §3.10.4 header set on every response, CSP byte for byte.
- Stream: ids are one per-process sequence from 1; SSE message ≤ **64 KiB**; ring of the last **4,096** events or **10 min** (Δmono), whichever is less; a comment line every **15 s**; more than **64** new commits in one tick → one `room_snapshot` (the scene at the tip and its last **200** cards).
- Logs: `<data dir>/log/viz-<instance>-<n>.jsonl`, user-only, **10 MB × 5**, deleted after **14 days**; security events aggregated to one line per code per **60 s**.

**World model and page (12 §3.3–§3.9, verbatim numbers):**
- Window: tip at height `t` → `h0 = 256 · ⌊max(0, t − 1,023) / 256⌋` (1,024–1,279 heights, or the whole board); "load earlier" pages of **256**; ≤ **2,048** heights retained per room, older ones re-folded from the checkpoint ≤ them (≤ **255** folds, seek ≤ **500 ms**); ≤ **32** rooms.
- Positions `(height, sub, k)`: `sub` 0 room events at height 0; `1 + line index` (1–1,000) op events; **1,001** code events; **1,002** derived events. Seeds `uint32(sha256(utf8(base ‖ ":" ‖ k))[0..3])`, `base` = op id or `"<height>:<writer peer_id or '-'>:<sub>"`.
- Layout: tile **16** art px; desk slot **3 × 3** tiles; zone cell **7 × 10** tiles, 6 slots; lobby strip **4** tiles tall, door at (1, 0), **16** home spots at (2 + 2·(i mod 8), 1 + ⌊i / 8⌋), big table (17–20, 1–2), chair (18, 3), visitors (16, 3), (17, 3), (19, 3), (20, 3); door cluster (0, 1), (0, 2), (0, 3), (1, 2), (1, 3); grid **C = 3** columns, office **21** tiles (336 art px) wide; ≤ **15** zones + the overflow zone `…`; ≤ **4** cells per zone; ≤ **23** file desks per zone, the shelf desk in the **24th** slot; **1** chair + **4** visitor tiles per desk, then "+n"; a desk dims after **256** heights without an event.
- Looks: `n = uint32(sha256(peer_id ‖ 0x00 ‖ "viz-look")[0..3])`, `L = n mod 56`, hue `L mod 7`, accessory `⌊L / 7⌋`; **7** body hues (APRICOT `#D97757`, AMBER `#E69F00`, SKY `#56B4E9`, GREEN `#009E73`, LEMON `#F0E442`, BLUE `#0072B2`, PINK `#CC79A7`); highlight `mix(b, #FFFFFF, 0.35)`, outline `mix(b, #000000, 0.35)` (ruling R-V62); CIEDE2000 ΔE ≥ **20** outline vs both floor tones, ≥ **15** eye white vs body, ≥ **10** cheek vs body (L* adjusted in steps of 1 within **55–80**); accessory main pair ΔE ≥ **15** vs body, else the alternate pair; colour-vision minimum ≥ **0.9 ×** the minimum of the spec's own UNADJUSTED seven hues (ruling R-V63) under protanopia, deuteranopia and tritanopia (Machado et al. 2009, severity 1.0). Fixed tones: cheek `#F2B49A`, eye white `#FFFFFF`, pupil `#1A1A1A`, lens `#59C3FF`; floor `#3A3346` / `#342E40`, wall `#22222C`, desk `#6B4A2E` / `#8A6440`, monitor `#2B2B38`, screen `#59C3FF` / `#7FE0A0`; chrome accent `#D97757`.
- Thresholds: relaxed pose **64** heights after the actor's last publish; branch sign **64** heights; slowed until `height + 180`; board level `full` at `record_count ≥ 5,000` or a `BOARD_FULL` event, until a frame with `record_count < 5,000`; then `near_full` at `record_count ≥ 4,000`, else `none` (12 §3.4).
- Animation: ≤ **12 fps**; ≤ **2** draws/s for an idle room; idle bob 2 × 600 ms; walk 4 × 100 ms at **4 tiles/s**, a trip ≤ **3 s**; live beat **300 ms**, snap to the newest scene after a **5 s** backlog; replay beat **800 ms** at 1×, speeds **0.5×, 1×, 2×, 4×, 8×**; poof instead of walking at ≥ 4× over > **12** tiles; zoom `Z = max(2, ⌊panelW / worldW⌋)`, manual **2–8**, map `max(1, Z − 1)`; auto-scroll to a new event only when the user has not scrolled for **30 s**.
- Bubbles: duration `clamp(1.5 s, 0.5 s + Σ 1/cps(char), 6 s)`, cps **20** Latin and other scripts, **12** Hangul, **9** Han, **4** for every character of a text containing kana; ≤ **2** lines × **42** Latin / **16** full-width characters; ≤ **1** per actor, ≤ **3** per room; at k× divided by k, never below **1.0 s**.
- Log: right panel **340** CSS px, a drawer below a **1,100** px viewport; ≤ **2,000** cards per room in the page; ≤ **5** file chips per merged activity card, then "+n"; announcements ≤ **1 per 10 s**; the page keeps a reduced scene every **64** heights of each segment; reconnect after **1 s** doubling to **30 s**, then a world reload, then `UI_VIZ_STOPPED`.
- Text caps (channel `viz`): names **20** rendered / **64** raw, label **80**, path **80** (middle ellipsis), note **280**, branch **80**, room label **40**, card text **400**, tooltip **200**, plaque **16** (basename, middle ellipsis), demo caption text **1–120**; before the grapheme cap every string is cut to `VIZ_RAW_UNITS` = 4 × its cap in UTF-16 code units (name: 64) at a grapheme boundary and keeps ≤ **4** combining marks per grapheme (R-V50); a served `paths` list is the longest prefix whose JSON is ≤ **16 KiB** (`n` unchanged, R-V50).
- Budgets (§3.12): viewer RSS ≤ **200 MB** with 8 rooms; idle CPU ≤ **1 %** of one core over 60 s including git children; first `/api/v1/world` ≤ **3 s** for 8 rooms × 1,024 heights; seek outside the page ≤ **500 ms**; page JS heap ≤ **150 MB**; ≤ **10 %** of one core while animating; `dist/viz.js` ≤ **1.5 MB** including the client and the bundled demo. CI asserts RSS, retained heights, heap, git counts and byte caps exactly and only wall time and CPU with 2× slack; the exact time and CPU values are checked on the Windows reference laptop in Task 18's manual check (R-V41).

**Tests and CI:** every task is TDD (failing test first), `npm run ci` green before its commit, one commit per green step. CI wall time: at 8a's base `ci.yml` has Plan 2 Task 19's `timeout-minutes: 45` and also runs Plan 2's SIM seeds (the four tasks allowed ahead of Plan 2's exit, R-V01, may still run under the earlier `timeout-minutes: 20`), so every 8a test file stays within **10 s** (unit) or **60 s** (integration) on a CI leg, and long fixture boards are written with `BoardWriter.commitMany` (one `git fast-import`); the slow suites — T-VIZ-contention (≈ 7 min, Windows), T-VIZ-perf (≈ 3 min), T-VIZ-golden-board and T-VIZ-golden-sim — run only when `COWORK_VIZ_SLOW=1` (otherwise they report SKIPPED with that reason) and run in the new workflow `.github/workflows/viz-slow.yml` (three OS legs, Node 24, on every pull request touching `src/viz/**`, `src/board/**`, `tools/viz/**` or `test/**/viz/**`, timeout 30 min), whose green run on all three legs is part of the 8a exit. Unit tests in `test/unit/viz/`, real-git and process tests in `test/integration/viz/`, goldens in `test/golden/viz/`. Test titles below are the `test(...)` names; the text after the dash is what the test asserts. Every T-VIZ id of roadmap row 8 (8a) is carried by at least one test title that starts with `T-VIZ-<id>` (followed by `:` or ` (…):`), which is how Task 18's exit sweep finds it; the browser smoke is found by its file name. The viewer places **no crashpoint** (it writes nothing but its log); `test/crashpoints.json` is not edited.

## Review Focus

The five conditions most likely to bite users that no single task's tests would otherwise exercise (each has a test in the owning task):

1. **A teammate-authored string that is hostile** — a display name, branch, folder or file name, a demo caption, later a note — carrying `<img src=x onerror=…>`, `</script>`, `javascript:`, ANSI/OSC 8/OSC 52, bidi overrides, zero-width and tag characters, a URL, a 10 KB run, or a path such as `__proto__/a.ts` that `validPathSyntax` admits. Expected: it reaches the page only as sanitized, capped text through `textContent`/`fillText`, never as markup, a class name, a URL or an object key; it cannot impersonate another character (looks come from `peer_id` alone; equal tags show handles). A forged board code in a code slot (`event{freeze, reason_code: "UI_VIZ_LINK_REUSED"}`) must never print the viewer's own alarm text (R-V43). Pinned in Task 3 (`sanitize`, raw-unit caps, `render`'s reason nesting), Task 4 (layout keys are `Map`s), Task 9 (every served string through the validators, `sanitize(…, 'viz')` and its cap; closed code sets; name tags that keep the whole handle), Task 14 (L-VIZ-DOM on the real client) and Task 17 (the browser smoke's `window.__pwned` canaries, also through hand-written note, request, answer and claim events).
2. **A malicious web page or another local user attacking the loopback port**: DNS rebinding (`Host: evil.test:<port>`), the `0.0.0.0` route, a cross-site `fetch` with a copied session header, a CORS or Private Network Access preflight, framing, a duplicated `Host` header (Node keeps only the first, so the check counts `rawHeaders`), a local user racing the launch token from `/proc/<pid>/cmdline`. Expected: 421/403/405/401 with no request data echoed, no `Access-Control-*`, no cookie, the §3.10.4 header set even on responses Node writes itself (a missing `Host`, oversized headers, a stalled request), and a reused launch token ends the viewer with `UI_VIZ_LINK_REUSED` on the presenting page. Pinned in Task 10 (admission, headers, tokens) and Task 17 (browser smoke items (d) and (f)).
3. **A huge board history or a huge office**: a 20,000-height board, a viewer left open 24 h at B = 12 (17,280 live heights), a laptop waking up to 2,000 new commits, 2,000 file paths in one change-set history, 60 peers. Expected: the initial window is 1,024–1,279 heights, at most 2,048 heights stay in memory and older ones re-fold from a checkpoint in ≤ 255 folds with byte-identical events, > 64 commits in one tick become one `room_snapshot`, no SSE message exceeds 64 KiB (a 256-path change-set of emoji paths included), desks overflow into `…` folder desks and shelf desks without ever moving, looks repeat with handles, RSS ≤ 200 MB. Pinned in Task 4 (layout overflow), Task 8 (retention, catch-up, re-fold equality), Task 9 and Task 10 (path budgets, the 64 KiB split) and Task 15 (T-VIZ-perf: RSS and counts exact, time and CPU with 2× slack).
4. **The viewer racing a daemon that is writing** — on Windows `status.json` is replaced by rename every iteration (a rename over a file another process holds open fails, W3), the board ref moves between `rev-parse` and `rev-list`, `git pack-refs` rewrites `packed-refs` mid-poll, a fetch lands while a batch is being read. Expected: the viewer holds no handle (stat, one open-read-close, a `cat-file` process per batch), reads every tick against the one tip oid it resolved (never the moving ref name), keeps the previous overlay on `EPERM`/`ENOENT`, and causes zero rename or ref-update failures beyond the no-viewer control. Pinned in Task 7 (stat pairs, tip pinning, short reads) and Task 15 (T-VIZ-contention on the Windows legs, T-VIZ-readonly).
5. **A Windows, non-ASCII or unusual path opened in the browser**: `--repo "C:\Users\김\공 백\repo"`, a relative `--repo` from a subdirectory, a drive-letter-case variant of the same clone, a linked worktree (`.git` file), a UNC or `\\?\` path, a data directory under a profile with Hangul, explorer as the opener (exits 1 on success), a teammate-synced `explorer.exe`/`taskkill.exe`/`xdg-open`/`git` in the repository (put first on `PATH` by a direnv-style `PATH_add bin`, or reached through `<repo>//bin`, `<repo>/x/../bin` or a symlinked alias of the repository), Homebrew's symlinked git on macOS, a `Path` (not `PATH`) environment key on Windows. Expected: rooms deduplicate by the canonical root form, labels are basenames (never served paths), UNC/device paths refuse with the right code, no bare executable name is ever spawned and no repository-controlled program is ever executed (git, taskkill, explorer, open, xdg-open, PowerShell all by absolute path outside every excluded root, compared by realpath; cwd = the data directory), and the page receives `#k=` intact. Pinned in Task 7 (room discovery), Task 11 (CLI paths, git resolution, opener, tree kill, data directory) and Task 2 (runner `taskkill` by absolute path).

---

## Scope rulings

Each ruling is `Ruling: <decision> — <why> — <cost if wrong>`. Task writers follow them; a task that finds a ruling impossible stops and reports instead of improvising.

**Base, the start gate and the files outside `src/viz/**`:**
- **R-V01 Base branch, the start gate and merges.** Ruling: Plan 8a's base is Plan 2's exit commit — Plan 2 merged into `main`, which already holds `docs/spec/12-visualizer.md`, `docs/design/viz-mockups/*` and roadmap row 8 (f414c86) — and 8a runs on branch `feat/p8a-viz` in worktree `.worktrees/p8a-viz`. No early start is approved: none is recorded in a ledger or in a user message, and only an explicit user approval, recorded with its date in 8a's ledger, would let the gated tasks start before Plan 2's exit. Until then only Tasks 1, 3, 4 and 12 may run ahead, because they modify no Plan 2 file and consume only Plan 2 declarations that are already closed (types of Plan 2 Tasks 5–6: `FoldState`, `PeerRec`, `CsTrailer`, `WriterId`, `ProtocolJson`, `BoardDraft`, `PeerId`, `Json`). For them `feat/p8a-viz` is cut from `feat/p2-engine` at ≥ 0c04320, `main` (f414c86) is merged into it before Task 1 (the spec, the mockups and roadmap row 8 exist only there), and this plan is committed under `docs/superpowers/plans/`. When Plan 2 lands, the controller merges `main` forward into `feat/p8a-viz`; `npm run ci` green on that merge is **gate P** (the typecheck catches a Plan 2 final-review change to any declaration 8a consumes), and every other task starts only after gate P. Tasks of one group run in worktrees cut from `feat/p8a-viz` after the previous group merged and merge back in task order; `main` is merged forward only between groups, each time with `npm run ci` green as the gate — VD-8 ("started right after Plan 2 lands") is a binding user decision and roadmap row 8 says "Plan 8a starts when plan 2 has landed"; the four ahead tasks change only new files and Plan 1 build and lint files that no Plan 2 task lists, so they cannot change Plan 2 — cost if wrong: if the user wants an earlier start, the gated tasks wait for nothing but that approval; if the user objects even to the four ahead tasks, they are kept on their branch until gate P, with no rework.
- **R-V02 Files outside `src/viz/**`, their owners and the two contracts.** Ruling: exactly the files of the table below. The four ahead tasks (R-V01) touch only new files and Plan 1 files no Plan 2 task lists; every other file outside `src/viz/**` changes after gate P, so a conflict is possible only with a Plan 2 post-merge fix or Plans 3–7. 8a's additions to Plan 2 files (`OpVerdictKind`, `OpVerdict`, `FoldStepResult.opVerdicts`, the exported parsers) are recorded in 8a's contract only; the Plan 2 contract is amended only in the merge that brings 8a into `main`, and the controller adds the Plan 2 ledger note "Plan 2 code must not construct `FoldStepResult` literals (8a adds the required `opVerdicts`)". Before Task 2 starts, the two Plan 2 deferred items on the code 8a edits — "64 KiB cap measured on re-encoded strings, not stored bytes (fold.ts:255-256)" and "capViolation measures only the top-level held/ tree object" — are marked fixed or won't-fix in the Plan 2 ledger, and 8a builds every `BoardDraft` through the two helpers `toDraft()`/`noopDraft()` of `src/viz/model/frame.ts`, so a later `BoardDraft` change has one place to follow — 12 §1.5 item 11 allows three seams (the `view` dispatch, the §9.7 board interfaces, first versions of `sanitize`/`render`); the rest is build, lint and test plumbing that only 8a needs; an amended Plan 2 contract on a branch that lacks the field would mislead Plan 2 fix rounds — cost if wrong: a Plan 3 change to `foldCommit`'s loop merges first and the controller rebases the fold loop's verdict bookkeeping (every branch of the loop, not one hunk).

| File | Change | Owner task | Why it cannot conflict |
|---|---|---|---|
| `src/board/fold.ts` | additive: `OpVerdictKind`, `OpVerdict`, `FoldStepResult.opVerdicts`, the per-line verdict bookkeeping inside `foldCommit` (no existing line changes behaviour) | 2 | changed after gate P (Plan 2 has landed); no Plan 2 test compares a whole `FoldStepResult` (measured: `test/unit/fold.test.ts`, `fold.prop.test.ts`, `test/integration/folder.test.ts`); Plan 3's hold effects change the same loop — whichever merges second rebases (R-V02's cost) |
| `src/board/batchRead.ts` | new: `readBoardCommits`, `readLiveCommits`, `parseCommitObject`, `BoardRead`, `LiveRead` | 2 | new file |
| `src/board/csActor.ts` | new: `parseCsActor` | 2 | new file |
| `src/board/boardCommit.ts` | additive: the word `export` on five private parsers (`batchObjects`, `batchCheck`, `subtreeNames`, `capViolation`, `opsLinesOf`) and their record types (`BatchObject`, `EntryInfo`, `BoardEntries`) | 2 | changed after gate P; bodies unchanged |
| `src/git/runner.ts` | security fix (12 §9.7 item 5): `killTree` spawns `<SystemRoot>\System32\taskkill.exe` by absolute path | 2 | a Plan 1 file; changed after gate P |
| `src/text/sanitize.ts` | new (first version, SEC-34 signature; `cap`, `VIZ_CAPS`, `VIZ_RAW_UNITS`) | 3 (ahead) | new file; Plans 5/7 extend it without changing the signature |
| `src/i18n/render.ts` | new (first version, 10-product §3.2 signature) | 3 (ahead) | new file; Plan 7 extends it |
| `src/entry/cli.ts` | the `view` dispatch line (keeps `--version` and the no-argument no-op) | 11 | a Plan 1 stub; Plan 2 modifies only `src/entry/daemon.ts`; changed after gate P |
| `src/entry/viz.ts` | new: the seventh entry point | 1 (ahead), 15 | new file |
| `tools/build/build.mjs` | seventh entry `viz`, the client pre-bundle and the `viz-asset:*` plugin, written inline after the `--outdir` guard (R-V36) | 1 (ahead) | no Plan 2 task lists it |
| `test/integration/build.test.ts` | six → seven entries | 1 (ahead) | no Plan 2 task lists it |
| `tools/lint/lint.ts` | applies `VIZ_ALLOW`, `lintVizSource` and the client typecheck (`L-VIZ-TYPES`) from `tools/lint/vizRules.ts`; each only when its files exist under `--root` (R-V34, R-V35) | 1 (ahead) | Plan 2 Tasks 9 and 12 modify `tools/lint/rules.ts`, never `lint.ts` |
| `tools/lint/vizRules.ts` | new: L-VIZ-DOM, L-VIZ-GIT, L-VIZ-IMPORT, L-VIZ-URL, L-VIZ-NET, the client typecheck and the 8a exemptions | 1 (ahead) | new file |
| `tsconfig.json` | `"exclude": ["src/viz/client/**"]` | 1 (ahead) | no Plan 2 task lists it |
| `package.json` | one new line `"viz:golden": "tsx tools/viz/golden.ts"` directly after `"build"`; the `typecheck`, `lint`, `test` and `ci` lines are not touched (`test/unit/ci-config.test.ts` pins `typecheck`, `lint`, `sim:smoke` and `ci`) | 16 | changed after gate P, when Plan 2 Tasks 19–20's script lines are already in |
| `tools/viz/{boardWriter,export-demo,golden,storyboard}.ts`, `tools/viz/storyboard.captions.jsonl` | new dev tools (never shipped) | 2, 16, 18 | new files |
| `.github/workflows/viz-slow.yml` | new: the `COWORK_VIZ_SLOW=1` suites on three OS legs | 15 | new file; `test/unit/ci-config.test.ts` reads `ci.yml` and the `package.json` scripts, neither of which this file changes |
| `test/{unit,integration}/viz/**`, `test/golden/viz/**`, `test/fixtures/viz/**`, `test/helpers/viz*.ts`, `test/helpers/cdp.ts` | new tests, fixtures, helpers | all | new files |
| `docs/superpowers/plans/2026-10-07-cowork-sync-p8a-viz.md` | this plan | controller, before Task 1 (R-V01) | new file |
| `docs/spec/*`, the roadmap's execution-order sentence | 8a's spec-edit batch (§"Spec conflicts and gaps") and the 12 §9.2–§9.7 edits | Task 18 step B2 (controller) | applied only after `main` holds Plan 2's merge and Plan 2's own spec-wording batch (glossary §18 `GIT_GRAFT_FILE`, 02-protocol §3.3 caps, …), merged forward first: Plan 2's batch, then 8a's; it reaches `main` with 8a's merge |
| `docs/spec/12-visualizer.md` (2026-10-08, F-8a-1) | Task 19 only: the eight F32 codes move from §9.9 into §3.11's Scene labels and Controls and filters rows (and the §9.9 F32 bullet is removed) | 19 | lands after Task 18's B2 batch, so no other 8a task edits the file at the same time; T-VIZ-i18n needs the table and `codes.ts` in one merge (FEAT-F32-09) |
| the roadmap, row 8 (2026-10-08, F-8a-1) | Task 19 only, and only if row 8 lacks the Task 19 exit sentence (rev 2.5 carries it, so normally untouched) | 19 | as above |
| `test/integration/viz/browserSmoke.test.ts` (2026-10-08, F-8a-1) | Task 19 appends item (k) = T-VIZ-follow-privacy without its recording clause | 19 (Task 17's file) | Task 17 has merged before G9 |
| `src/data/pluginDataDir.ts`, `src/sec/sddl.ts` (2026-10-08, F-8a-2; X-61, X-62) | new node-only leaves holding the moved bodies of `pluginDataDir`/`resolveDataDir` and `Sddl`/`parseSddl`/`sddlUserOnly`/`sddlOwnerOk`; `src/viz/cli/dataDir.ts` re-exports them | follow-up F-8a-2, run by the 8a controller now (verify pass V-12; Plan 5 Task 1 only adds `pluginRoot?`/`pluginIdOf` to the moved module) | new files; one shared copy for Plans 5, 7, 8b |
| `src/data/canonRoot.ts` (2026-10-08, F-8a-3; X-63) | **created by Task 7** with `canonRoot` and, in `src/ports/fs.ts`, `RootProbe`/`realRootProbe`, at exactly Plan 5's declared signatures (Plan 5 reviewer); Plan 5 Task 1 adds `sameRoot`, `endpointRoot`, `findRepo`, `liveState` in place (verify pass V-12: Plan 5 Task 1 cannot start before Plan 3 merges, so waiting for it would hold 8a's G4) | 8a Task 7 | new file; no fallback branch |

**12 §9.7 board interfaces (what 8a takes and how):**
- **R-V03 Op verdicts (§9.7 item 1).** Ruling: an additive field in `src/board/fold.ts` — `FoldStepResult.opVerdicts: OpVerdict[]`, one entry per `opsLines` element, written by `foldCommit` itself at the five places it already decides (parse failure → `rejected`/`malformed`; `parseOpId(op.id)` null → `rejected`/`malformed`; `genericOk` false or past the 1,000-line/64 KiB loop bounds or writer null → `rejected`/`generic`; `applyOp` false → `rejected`/`type`; `applyOp` true → `effective` when the type is in `PLAN2_FOLDED_TYPES`, else `unfolded`); a wrapper over `ownRejections`/`landedOwnOpIds` was rejected because the fold records nothing for some lines and keys rejections by op id, so it cannot be exact, and VIZ-08 forbids re-deriving generic validity — 12 §3.3.3 says a Plan 8 build without verdicts does not ship — cost if wrong: Plans 3/4/6 must update `PLAN2_FOLDED_TYPES` (or its successor) in the same commit that gives a type an effect; Task 2's tripwire test fails until they do.
- **R-V04 `self` and verdicts.** Ruling: the viewer calls `foldCommit(prev, draft, self)` with the room's own `peer_id` when `<gitdir>/cowork/peer` exists, else (R-V46) the last parsed `status.json` `peer_id` when it matches `^[0-9a-f]{32}$`, else 32 zeros (12 §3.3.3), uses only `state` and `opVerdicts`, and Task 2 adds the §9.7 item 6 unit test that `state` and `opVerdicts` do not depend on `self` — `opVerdicts` is computed for every writer, unlike `ownRejections` — none.
- **R-V05 Batched readers (§9.7 items 2, 3, 8).** Ruling: `readBoardCommits` and `readLiveCommits` live in the new `src/board/batchRead.ts`, reuse `boardCommit.ts`'s five private parsers by exporting them (R-V02 table), and read in two processes per batch: one `cat-file --batch-check` naming, per board item, `<oid>`, `<oid>:ops.jsonl`, `<oid>:protocol.json`, `<oid>:held`, `<oid>:checkpoint/state.json` (heights divisible by 256 only) and the live commit `<oid>^2` (`<oid>^1` at height 0), then one `cat-file --batch` of the distinct well-typed objects within the caps; `BoardCommitData` gets no `csPaths` field — `BoardRead extends BoardCommitData` carries it — because a new required field would break every Plan 2 `BoardDraft` literal; the commit-object header parse (`tree`, `parent` lines, message via `parseMessage`) is re-implemented in 15 lines and pinned by an equality test against `GitRepo.readCommit` — Plan 2's size-before-read ruling forbids `--batch` on an unchecked object, a live commit object is as unbounded as a board one, and reusing the parsers removes drift — cost if wrong: two `cat-file` processes per batch instead of one (12 §3.3.2, §3.12 and T-VIZ-poll are amended: "+ 1 `rev-list` + 1 `cat-file --batch-check` + 1 `cat-file --batch` per batch"), and a board commit whose live commit is not its second parent (3+ parents) reads its shape as `null`.
- **R-V06 Read-only git binding (§9.7 item 5).** Ruling: no `GitRepo` for the viewer: `src/viz/source/vizGit.ts` builds its own runner with `createGitRunner({ clock, hooksPath: <dataDir>/viz-no-hooks (never created), daemonEnv: <the builder env> + GIT_NO_LAZY_FETCH=1, gitPath: <the --git value, R-V13>, watchdogOverrideMs: 120_000 })` and calls `run(args, { class: 'local', cwd: dataDir, gitDir, config: VIZ_GIT_CONFIG })`, asserting `vizGitArgvOk` (from `src/viz/source/vizGitArgv.ts`, shared with L-VIZ-GIT) before each call; `config` passes only `protocol.allow` and the five `protocol.<name>.allow` keys because `buildGitInvocation` throws on the forced `protocol.ext.allow`; the watchdog override gives liveness (a hung `cat-file` would otherwise stall every room's poll) and makes the runner's `killTree` reachable from the viewer, so Task 2 also fixes `killTree` to spawn `taskkill.exe` by absolute path (§9.7 item 5's second half) — every argument the item asks for already exists on `GitCallOptions` and `GitRunnerDeps`, so `repo.ts` stays untouched — cost if wrong: a viewer git call stuck for 120 s delays the other rooms' ticks by that much.
- **R-V07 `parseCsActor` (§9.7 item 4).** Ruling: in the new `src/board/csActor.ts`, built on `validId('cs')`, not appended to `src/sec/validators.ts` — the engine and the viewer still share one grammar (Plans 3/5 import it from there) without reopening a Plan 2 file — none.
- **R-V08 §9.7 item 7** (`to_holder` shape) is Plan 6's; 8a folds `request_status`/`answer` as `unfolded` and draws nothing for them — none.

**Git facts measured while planning (spec defects, flagged for a 12 §3.3.2 / §9.5 fix):**
- **R-V09 `for-each-ref -z` does not exist.** Ruling: room admission runs `for-each-ref --format=%(objectname) %(refname) refs/cowork-remote/` and splits on LF (check-ref-format forbids controls and spaces in ref names), the form Plan 2's `GitRepo.listRefs` uses — git 2.55 answers `-z` with "unknown switch `z'" — none.
- **R-V10 Version probe.** Ruling: the git floor is read with the subcommand `version` (`parseGitVersion`, `meetsFloor`), because `buildGitInvocation` refuses an `args[0]` that starts with `-` — none.

**Process, CLI and data directory:**
- **R-V11 Data directory in 8a.** Ruling: `cli/dataDir.ts` resolves `CLAUDE_PLUGIN_DATA` when set (absolute), else the derived directory `pluginDataDir(env, home) = <CLAUDE_CONFIG_DIR or <home>/.claude>/plugins/data/cowork-sync`, creates it `0700` when absent, and verifies it before any read: POSIX — not a symlink, a directory, owner uid = the process euid, `mode & 0o077 === 0`; Windows — the SDDL of `Get-Acl -LiteralPath $env:COWORK_ACL_PATH` read by `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command <fixed text>` (the path travels in the environment, never in command text; cwd = `%SystemRoot%\System32`), the directory not a symlink or junction (`lstat().isSymbolicLink()`), a present DACL that is not `NO_ACCESS_CONTROL`, only `A` and `D` ACE types (an object or callback ACE such as `OA`, `XA`, `ZA` refuses), owner = the user SID or `S-1-5-32-544`, at least one allow ACE for the user SID, and every allow ACE for the user SID, `S-1-5-18` or `S-1-5-32-544` only (S9: "every allow ACE ∈ {…}" is vacuously true for a NULL DACL); any probe failure fails closed (`RF_VIZ_START_FAILED`); the probe lives in `cli/ownerProbe.ts`, one of the two viz files allowed `node:fs` (with `source/boundedRead.ts`) and one of three allowed `child_process` (R-V34) — in a plain terminal `CLAUDE_PLUGIN_DATA` is almost always absent, so the derived path is the main path; SEC-20 fixes the check, not the derivation, which is unspecified (glossary §25 F3 "derive from the plugin id") — cost if wrong: Plans 5/7 replace `pluginDataDir` with the shared derivation (same signature; 2026-10-08, verify pass V-12: Plan 5's derivation names the directory `<pluginIdOf(plugin root)>` = `<plugin>-<marketplace>` instead of the fixed `cowork-sync`, so this rule's derived path and its landed test change when Plan 5 Task 1 lands, F-8a-2), and a locked-down Windows without PowerShell cannot run the 8a viewer; a PowerShell cold start adds ≈ 1 s to the CLI and to the viewer's start (inside the 5 s handshake, asserted on the Windows leg).
- **R-V12 Process-tree kill.** Ruling: `cli/spawn.ts` kills with `process.kill(-pid, 'SIGKILL')` on POSIX and `<SystemRoot>\System32\taskkill.exe /PID <pid> /T /F` on Windows, `SystemRoot` taken from the CLI's environment and required to be an absolute existing directory (else no tree kill, `child.kill()` only, still `RF_VIZ_START_FAILED`) — 12 §3.2 item 3 — none.
- **R-V13 The git executable.** Ruling: the CLI resolves git, because only it knows the cwd and the `--repo` worktrees, and only when `--repo` is given (a demo run resolves and calls no git, VIZ-06): `resolveGitPath` in `src/viz/cli/pathTrust.ts` reads the first environment key whose upper case is `PATH` (Windows keeps the source spelling `Path`), keeps the entries `filterPath` keeps (absolute; not empty, not `.`; normalized, then `Fs.realpath` of the entry not inside the realpath of an excluded root — the cwd's repository root and each `--repo` worktree, R-V39), and takes the first `git.exe` (win32) or `git` whose candidate passes `trustedExe`: its `Fs.realpath` lies outside every excluded root and `lstat`s as a regular file after following symlinks (Homebrew's `/opt/homebrew/bin/git` symlink is accepted, so macOS does not fall through to Apple's older git), and on POSIX it is owned by uid 0 or the euid and is not group- or world-writable (`OwnerProbe.posix`). The CLI passes the realpath as `--git <abs>` (`ViewerArgs.git`, `ServeArgs.git`; `parseServeArgv` requires it absolute with `--repo` and refuses it with `--demo`), and the viewer's environment `PATH` is the same filtered list. None → `START_TOOL_VERSION` from the CLI, nothing spawned — a direnv-style `PATH_add bin` plus a teammate-synced `<repo>/bin/git` would otherwise run a teammate's program as the user on every `view` (INV-NOEXEC, 12 §3.10.8, SEC-30), on Windows a bare `git` is looked up in the current directory first, and §9.7 item 5 asks for "a check that the runner spawns git by absolute path" — cost if wrong: a user whose only git is inside a repository or group-writable gets `START_TOOL_VERSION` and must install git elsewhere.
- **R-V14 Output modes in 8a.** Ruling: `tty` is implemented in full; in `slash` and `pipe` mode (10-product §2) `view` starts nothing and prints `UI_VIZ_TERMINAL_ONLY` with the terminal command, exit 0; `--json` is `RF_UNKNOWN_FLAG` in 8a — 12 §3.2 item 1 and §9.1 limit 8a to `tty`, and "start nothing" is the only `slash` behaviour that cannot put the token in Claude's context — cost if wrong: none (8b adds the `slash` open path and `--json`).
- **R-V15 `L_h` and catalogs in 8a.** Ruling: the CLI resolves `L_h` = OS locale (`Intl.DateTimeFormat().resolvedOptions().locale`, mapped by 10-product §3.17) → `en`, and passes `--lang`; `user.json` is Plan 7's and is not read; the only catalog is `en`: `EN_VIZ` (`src/viz/i18n/en.ts`: every §3.11 code and every code of `REASON_CODES`, R-V43) spreads `EN_VIZ_CLI` (`src/viz/cli/strings.ts`, the CLI's own codes, R-V54); `render` falls back to `en` (10-product §3.2 step 1), and `/api/v1/strings?lang=<any of the six>` answers `{lang: 'en', templates}` of the page subset (`PAGE_CODES`) — 12 §9.1 "`en` strings only" — none (8b moves the templates into the six shared catalogs).
- **R-V16 Handshake order.** Ruling: the viewer runs, in order: argv parse, SEC-20 re-check, self-hash, then demo parse (demo) or git floor + room admission (no folding), then bind, then the ready line; rooms fold only after the ready line, and `/api/v1/world` waits for each room's `init()` — 12 §3.2 item 3 lists "discovers its rooms … binds, then writes"; folding 8 × 1,024 heights would not fit the 5 s handshake on a slow disk — none.

**Model:**
- **R-V17 Op rows without a visual.** Ruling: an `effective` `caps` op makes no scene event and is not `unknown` (B0's `room_open` is its code event); an `effective` `event{kind: incident}` makes no scene event and counts in `unknown` (12 §3.4 has no row for it; R-27 says Plan 2 never posts one) — the closed set has no kind for either — none.
- **R-V18 Footprint spawns and `k`.** Ruling: at `sub` 1,001 the frame first emits the footprint `pet_spawn` events of seats seen in its trailers (`Cowork-Seat` values other than `human`, seat `cs_id`s) that have no live pet yet, at `k = 0 … m − 1` in ascending seat key, then one `publish` per `Cowork-CS` trailer at `k = m + trailer index`, then the big-table `publish` or the branch sign at `k = m + trailers` — a pet must exist before it publishes in the same beat; with no footprint (every Plan 2 board) `k` equals 12 §3.3.5's trailer index — none.
- **R-V19 Malformed board commits and unreadable live commits.** Ruling: a board commit whose batched read reports a `BoardMalformedReason` is folded as the no-op draft `noopDraft(previous draft)` (writer `null`, `opsLines` [], `heldIds` [], no trailers, checkpoint `null`, the previous `protocol` and the previous `liveCode`, so its frame's `code` is `{changed: false, shape: null, seats: [], base: null}`) and counts one `unknown`. A missing object — a board object, or a live commit read as `LiveReadFailure{malformed: 'missing'}` (partial clone, transports disabled) — stops the room exactly at its last folded scene with `UI_VIZ_NO_BOARD`, folds nothing of that batch, and retries next tick. A live read of `not_commit` or `commit_too_large` gives `code.shape = null` (no code event, one `unknown`). `export-demo` encodes the last two cases so that the demo's timeline stays byte-identical (12 §3.9.3): a shape-null live read as `code {changed: false, seats: [], base: null}` and a malformed board commit as `writer null, ops [], cs [], csPaths {}, held []` with that `code`; only `unknown` counts differ, and they are not in the serialized timeline; a missing object makes `export-demo` exit 1 — 12 §6 "Malformed board commit → deterministic no-op frame" and "a board or live object missing … `UI_VIZ_NO_BOARD`", while heights must stay aligned with the chain; a shape-null `changed` frame in a demo would otherwise make a `publish` — none.
- **R-V20 Seeds and looks.** Ruling: `uint32(sha256(…)[0..3])` reads the first four digest bytes big-endian (`readUInt32BE(0)`) — the spec names bytes, not an order — none.
- **R-V21 Desks never move across an incident rebuild.** Ruling: `WindowInput` gains an optional `layout` (the layout to extend, default empty); VIZ-14's rebuild after an incident passes the room's current layout, so desks keep their ordinals and the new chain's paths append; the page gets one `reset` — VIZ-16 "a desk MUST NOT move or disappear while the viewer runs" also holds across a rewritten board — none (a fresh viewer start lays the new chain out from scratch).
- **R-V22 Display ids and handles.** Ruling: the projection gives every peer the handle of its first 6 hex and every seat key the first 6 characters of `base32c(sha256(seat key))`, and every hold or claim id its first 8 characters — and, only when two different ids of one world share that prefix, the shortest unique longer prefix for both (sorted ids, deterministic); the `Handle`/`SeatHandle` schemas allow 6–32 characters, the page's filter fragment accepts a peer of `^[0-9a-f]{6,32}$`, and a world re-sent after a `reset` caused by `HandleTable.takeCollision()` may carry cards whose actor handles changed (T-VIZ-api exempts exactly those re-sends) — first-8 hold-id prefixes are ULID time digits that collide for records created within ~1 s, and a collision would merge two characters or two boxes into one map key — none in Plan 2 boards (no holds); flagged for Plan 3 and 10-product's "unique prefix" rule, and the fragment regex and the T-VIZ-api exemption are in the spec-edit list.
- **R-V23 `EventVM` shape.** Ruling: the projection rule's "Position by Pos" makes `EventVM` carry `at: Pos` in place of the three fields `height, sub, k`; the page's `ui/unproject.ts` restores them before `reduceScene` — one reducer for server and page (VIZ-26) — none.
- **R-V24 Overlay `down` for `--repo` rooms.** Ruling: a `--repo` room whose `status.json` is missing is `down` — the `--repo` argument stands in for the `live` marker, which 8a does not read (12 §1.5 item 4: Plan 7 writes it) — none.
- **R-V25 Two `ActorState` fields, position-typed recency and three `Frame` fields.** Ruling: `ActorState` gains `lastDesk` (the target desk of the actor's newest publish) and `lastClaimOp` (the position of a pet's newest claim op), and `lastPublish` becomes a `Position` too (spec: a height); recency (chairs, visitors, precedence 2) is compared with `comparePos`, and the 64-height relaxed rule reads `.height`; `Frame` gains the transient `protoMismatch`, `checkpoint` and `malformed` — §3.5.4's target-desk tie-break and character precedence 2 need both facts, precedence 2 compares "newer (board position)" and a human publish (sub 1,001) and a pet's claim op (sub 1 + line) can share a height, and the page reduces from served scenes (`TimelinePage.scene`) and from its own 64-height cache, so a scene alone must determine placement (VIZ-26); the frame flags carry the fold's `protoMismatch`, the PRO-28 compare and R-V19 to the store — none (additive to 12 §3.3.4 and §3.3.7 except `lastPublish`'s type, which is in the spec-edit list; `ActorStateVM` follows by the projection rule: `lastPublish` and `lastClaimOp` are `Pos | null`).

**Server and API:**
- **R-V26 `viewModel.ts` written out.** Ruling: `server/viewModel.ts` holds the §3.10.6 declarations verbatim and the `Projected` forms written out field by field (`EventVM`, `SceneVM`, `CardVM`, `ActorVM`, `ActorStateVM`, `PlaceVM`, `LineVM`), with the named string aliases of R-V27, so the T-VIZ-api schema generator reads plain declarations — 12 §3.10.6 "`Projected` is the projection rule above, written out as types in that file" — none.
- **R-V27 Schemas at test time.** Ruling: `test/helpers/vizSchema.ts` walks `viewModel.ts` with the TypeScript compiler API (already a devDependency) and emits JSON Schemas (`additionalProperties: false`, string-literal unions as `enum`, tuples as `prefixItems`, and every named string alias as its `pattern`: `Handle` `^[0-9a-f]{6,32}$`, `SeatHandle` `^[0-9A-HJKMNP-TV-Z]{6,32}$`, `ShortId` `^[0-9A-Za-z]{8,32}$`, `RoomId` `^r[0-9A-HJKMNP-TV-Z]{8}$`, `Code` `^[A-Z][A-Z0-9_]{2,47}$`, `Cid` `^[0-9A-HJKMNP-TV-Z]{8}$`, `ReqId` `^R[0-9A-HJKMNP-TV-Z]{8}$`, `CardId` `^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,5})$`, `Hex64` `^[0-9a-f]{64}$`, `InstanceId` `^[0-9A-HJKMNP-TV-Z]{8}$`); a construct it does not support fails the generator, and a `string` field of `viewModel.ts` that is neither a named alias, a literal union nor listed in project.ts's `SERVED_STRING_FIELDS` table fails a test (Task 9) — "nothing is added to `dist/`" and no package; a plain `string` schema could not catch a raw seat key, oid or path in an id field (§3.10.6 allowlist) — cost if wrong: `viewModel.ts` must stay inside the supported constructs.
- **R-V28 Rewind ticks and `seen_ms`.** Ruling: tick glyphs map `publish` → `publish`, `conflict` → `conflict`, `request_open` → `request`, `save` → `save`, `person_enter`/`person_respawn`/`person_exit` → `door`, `person_freeze` → `freeze`; "caught up" marks are page-side. A seen anchor (the store's Δmono when it folded a height) is created only for heights first folded by `tick()`'s fast-forward extension (a `snapshot` delta included), kept in one height → anchor `Map` for the whole window (never dropped by retention), and `CardModel.foldedAt` is that anchor or `null`; the initial window, "load earlier" pages, re-folds of dropped ranges (which reuse the stored anchor) and incident rebuilds (which drop the map: its heights named another chain) never create one, so a re-fold serves the same `seen_ms` basis and a historical card never reads "seen 0 min ago" — 12 §3.8 ("a card for a board commit that this viewer process folded while running"), VIZ-11 (a card the viewer did not see arrive shows its height), 12 §3.3.3 (re-folded events equal those first served) — none.
- **R-V29 One segment per page request below `h0`.** Ruling: `GET /api/v1/rooms/<id>/timeline` with `from < h0` extends the window by exactly one segment of 256 and answers that segment's page (clipped as usual); the page asks again for older heights — every request then costs ≤ 255 folds (VIZ-26) whatever `from` a page sends, where "by whole segments" (12 §3.10.5) would let one request re-fold the whole board — none.
- **R-V30 Bounded reads through an injectable port.** Ruling: `src/viz/source/boundedRead.ts` declares the port `BoundedReader { read(path, max): Promise<Buffer | 'not_file' | 'too_large' | null> }` with `realBoundedReader` (the second file allowed `node:fs`, R-V34: `open` with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` where the platform defines them (a symlink fails the open, a FIFO cannot block the poll loop; where `O_NOFOLLOW` is undefined, as on Windows, an `lstat` just before the open must not report a symlink), `fstat().isFile()` else `'not_file'`, read at most `max + 1` bytes, `'too_large'` when the extra byte arrives, close in `finally`; `ENOENT` → `null`) and `fsBoundedReader(fs: Fs)` (`lstat` regular file, then one `readFile`, for tests that need `FaultFs` rename-over and share-none emulation); `readStatus`, `readPeerFile` and `readDemoFile` take a `BoundedReader`, production binds `realBoundedReader`, and `StoreDeps`/`ViewerDeps` carry it so Task 7's and Task 15's spies see every such read — VIZ-27 asks for a read "with a 4 MiB + 1 byte limit", a FIFO at `status.json` would hang an `lstat`-then-`readFile` poll and a symlink to `/dev/zero` would read without bound; `src/ports/fs.ts` and `test/sim/faultfs.ts` stay untouched — cost if wrong: two read paths to keep equal (one test runs both over the same fixtures).
- **R-V31 Fast-forward check with allowlisted git.** Ruling: each tick with a moved ref lists `rev-list --first-parent --max-count=1281 <new tip>` and requires the last folded oid at index `n` (then `n` new commits); not found in a full page → `rev-list --first-parent --count` and `--skip=<T − h1> --max-count=1` decide catch-up (page by 1,280) versus rewrite (VIZ-14) — no `merge-base`, one `rev-list` in the common case — none.
- **R-V32 Captions in 8a.** Ruling: demo captions show in a caption strip under the office for one beat from their height (the recording canvas of §3.9.4 is 8b) — 12 §3.9.3 "shown in the caption strip from its height for one beat" — none.

**Page and build:**
- **R-V33 DOM-free page logic.** Ruling: everything in the page that can be decided without a DOM — the SSE parser, the connection state machine, animation states, the render-loop scheduler, A\*, bubbles, the log model (merging, filters, chips, seen labels), seek caches and the static-layer options, unprojection, fragment parsing, zoom, the map's room dots and overlay marks, the people list — lives in `src/viz/ui/**` (pure, unit-tested under Node, bundled into the client); `src/viz/client/**` is only DOM, canvas, `fetch` and event glue; L-VIZ-IMPORT treats `ui/**` like `model/**` — 12 §3.13 lists the client files but the T-VIZ-anim/-bubbles/-log/-seek assertions need Node-runnable code — none.
- **R-V34 Lint exemptions in the driver.** Ruling: `tools/lint/vizRules.ts` exports `VIZ_ALLOW` — `L-NET`: `src/viz/server/http.ts`, for its `node:http` module load only (L-VIZ-NET then forbids every client use there); `L-PORTS`: `src/viz/cli/{spawn,opener,ownerProbe}.ts`; `L-FS-PORT`: `src/viz/cli/ownerProbe.ts` and `src/viz/source/boundedRead.ts` (R-V30); the prefix `src/viz/client/`: `L-CLOCK`, `L-RANDOM`, `L-FS-PORT` and every rule whose id starts with `L-GIT-` (`L-GIT-SPAWN`, `L-GIT-FORBIDDEN`, `L-GIT-ATOMIC`) — and `lint.ts` drops a `lintSource` finding that `VIZ_ALLOW` covers, then adds `lintVizSource` findings, then (only when `<root>/src/viz/client/tsconfig.json` and `<root>/src/viz/client/main.ts` exist) the client-closure check and the client typecheck (`L-VIZ-TYPES`, R-V35); the summary line keeps `n` = the count of `src/**/*.ts` files, so Plan 1's `lint: 2 files, 0 findings` test on a two-file `--root` is unchanged — `tools/lint/rules.ts` is being changed by Plan 2 Tasks 9 and 12; 12 §9.5 names spawn.ts and opener.ts for L-PORTS, exempts `src/viz/client/**` from "L-GIT-*", and allows `node:http` in http.ts "as a server only"; ownerProbe.ts and boundedRead.ts are R-V11's and R-V30's additions — cost if wrong: two allow tables until Plan 7 consolidates them.
- **R-V35 Client typecheck and the client program.** Ruling: `tsconfig.json` excludes `src/viz/client/**`; `src/viz/client/tsconfig.json` is standalone (no `extends`, which would inherit the root `exclude` of its own files, TS18003, and the root `include` of `test/**`): `"include": ["./**/*.ts"]`, `"exclude": []`, `lib ["ES2022", "DOM"]`, `types []`, `module`/`moduleResolution` `NodeNext`, `noEmit`, and the root config's strictness flags copied; `npm run lint` typechecks it (`lint.ts`: `ts.getParsedCommandLineOfConfigFile` + `ts.createProgram` + `ts.getPreEmitDiagnostics`, each diagnostic a finding `L-VIZ-TYPES`), and `package.json`'s `typecheck` script stays `tsc -p tsconfig.json` (pinned by `test/unit/ci-config.test.ts`, which Plan 2 Task 19 also edits). The client program is exactly `src/viz/client/**`, `src/viz/ui/**`, `src/viz/model/{events,scene,layout,placement,cards,labels}.ts`, `src/viz/render/**`, `src/viz/server/viewModel.ts`, `src/text/sanitize.ts`, `src/i18n/render.ts` and `src/viz/i18n/codes.ts`; none of them imports a module outside this set, not even for types (so `scene.ts` declares `TimelineView` structurally, `viewModel.ts` imports nothing, `sanitize.ts` uses no `Buffer`), and L-VIZ-IMPORT checks the closure — a `DOM` lib in the main program would let server code reference browser globals, and with `types: []` any reach into `FoldState`, `Buffer` or `node:crypto` fails the client typecheck; a changed `typecheck` line would fail `ci-config.test.ts` on every leg and force an edit of a Plan 2 file — none.
- **R-V36 Build of `dist/viz.js`.** Ruling: `build.mjs` keeps `parseArgs` → `checkOutdir` → `rm`/`mkdir` as its first steps, then bundles `src/viz/client/main.ts` (`format: 'iife'`, the 12 §3.13 targets, minified, no source map, `write: false`), then builds the seven node entries with a plugin that resolves `viz-asset:app.js`, `viz-asset:app.css` and `viz-asset:demo.jsonl` to text modules; the pre-bundle and the plugin are written inline in `build.mjs`, which imports no other local module (Plan 1's test "build refuses an --outdir it must not empty" copies `build.mjs` alone into a fake repository without `src/viz` and expects exit 2); only `src/viz/assets.ts` imports the virtual modules and only `src/entry/viz.ts` imports `assets.ts`, so tests run every other module under `tsx` and inject assets — the metafile check requires every import of a bundle to be an external `node:` built-in — none.
- **R-V37 Golden timelines from boards and from the SIM.** Ruling: T-VIZ-golden-board (three scripted boards built by `tools/viz/boardWriter.ts`, read through git and through `export-demo`, byte-identical on every OS, golden on Linux) lands in Task 16; T-VIZ-golden-sim (12 §7) lands in Task 18 step B1, which needs Plan 2 Tasks 18–19 (real engine in SIM, `edits` profile) — part of Plan 2's exit, so after gate P (R-V01) it waits for nothing — the board goldens pin the git/demo equality with fixtures 8a controls, the SIM goldens with the real engine — cost if wrong: none (both run before 8a's exit).
- **R-V38 Secret scan.** Ruling: VIZ-36 step 3 (`scanSecrets`, D2 patterns) and the T-VIZ-text secret rows are 8b (Plan 7 writes the scanner); 8a serves free text only from names, branches, folders, paths and demo captions — 12 §3.10.7 — none (8a is never released).
- **R-V39 The `PATH` filter (opener and git) in 8a.** Ruling: `filterPath` (`src/viz/cli/pathTrust.ts`, async over `Fs`) drops empty, `.` and relative entries, normalizes each remaining entry, and drops every entry whose `Fs.realpath` fails or lies inside the realpath of an excluded root — the CLI cwd's repository root (the first ancestor of the cwd holding `.git`) and each `--repo` worktree; `trustedExe` applies the same realpath comparison to a candidate; one implementation serves the Linux opener and git resolution (R-V13); `repos.json` worktrees join in 8b — 12 §3.10.8; a lexical comparison misses `<repo>//bin`, `<repo>/x/../bin`, a symlinked alias of the repository and direnv's logical `$PWD` entry against the physical cwd, and a synced file is user-owned and 0755, so the owner and mode check alone cannot stop it — none.
- **R-V40 Viewer logs before Plan 7.** Ruling: every log line passes `sanitize(…, 'log')`; `scanSecrets(kind: 'log')` (SEC-38) is 8b; `vizLog.write` accepts only registry codes, numbers, booleans, `null`, opaque room ids, `ENOENT`-style error codes and `{fn, line, col}` frames, and throws on any other string, so a path or message cannot reach a log line by construction — none.
- **R-V41 Budgets on CI and on the reference laptop.** Ruling: CI (`viz-slow`, three legs; the browser smoke on one) asserts RSS ≤ 200 MB, page JS heap ≤ 150 MB, ≤ 2,048 retained heights, the git process counts and every byte cap at their exact §3.12 values; only wall time and CPU get 2× slack on shared runners (first world ≤ 6 s, idle CPU ≤ 2 %, seek ≤ 1 s, page CPU while animating ≤ 20 %), and Task 18's manual check measures those four at their exact values (3 s, 1 %, 500 ms, 10 %) on the Windows reference laptop — shared runners are not the reference laptop, but memory and counts do not depend on runner speed, and T-VIZ-manual (12 §7) has no performance item, so the exact time values would otherwise never be checked — cost if wrong: a 2× time regression passes CI and is caught by the manual check (the CI/manual split is in the spec-edit list).

**Added in review round 1:**
- **R-V42 Same-epoch rejoin.** Ruling: an effective `join` that moves `PeerRec.status` from `left` or `absent` back to `active` in the same epoch (Plan 2 `applyJoin`: "a left or absent epoch rejoins") emits `person_enter` at its op line (card `UI_VIZ_CARD_JOIN`), and the character re-enters through the door — none of the 12 §3.4 join rows (new peer, new epoch, version re-announce) covers it, and a character left outside while the fold says `active` breaks VIZ-12 and INV-VIZ-BOARDONLY — none (the §3.4 row is in the spec-edit list).
- **R-V43 Closed code sets for code-typed served fields.** Ruling: `src/viz/i18n/codes.ts` declares `FREEZE_REASON_CODES` (glossary §14 `freeze_reasons`: `EPOCH`, `MASS`, `PAUSED`, `INCIDENT`, `CONFIG`, `NOHOOKS`), `HEALTH_REASON_CODES` (what Plan 2 posts, `HOST_THROTTLED`, and PRO-06's `BOARD_FULL`), `PUBLISH_PAUSE_CODES` (`OFFLINE`, `AUTH`, `NONRETRYABLE`, `VERSION`), `STATUS_STATES` (glossary §14 `state`), `CHARACTER_BADGES` (`UI_VIZ_BADGE_VERSION`, `_RULES`, `_CREDIT`, `_HEALTH`) and `REASON_CODES` (the union of the first three); no set holds a code prefixed `UI_`, `RF_`, `SEC_`, `VIZ_`, `PH_`, `SS_` or `START_` (tested). At projection every code-typed field is checked against its set: `person_freeze.reasonCode` and `CharacterState.frozen` ∈ `FREEZE_REASON_CODES`, else the fixed placeholder `'?'` (the character stays frozen); `person_badge.code` ∈ `HEALTH_REASON_CODES`, else `null`; `CardVM.detail` ∈ the set of its row, else `'?'`; `CharacterVM.ph` ∈ the `PH_*` codes of 10-product §3.14 and `PetVM.ss`/`ssCode` ∈ the `SS_*` codes, else `null`; room badges ∈ `RoomBadge`, character badges ∈ `CHARACTER_BADGES`; `OverlayVM.state` ∈ `STATUS_STATES` (else the previous value), `freeze_reasons` ⊆ `FREEZE_REASON_CODES` (others dropped), `publish_pause` ∈ `PUBLISH_PAUSE_CODES`, else `null`. `projectEvent` and `projectScene` apply the same mapping, so the page's reduction over projected events equals the projected server scene (VIZ-26). `render` nests a `reason` parameter only when it is in the registered reason set (`registerReasonCodes(REASON_CODES)`; `renderWith` takes the set) and renders any other value as `?`; the `REASON_CODES` templates join `EN_VIZ` and `PAGE_CODES`. A later plan that posts a new reason or health code adds it to its set in the commit that adds the fold effect (as R-V03's tripwire) — `REASON_CODE_RE` is a shape check only, so a forged `event{freeze, reason_code: "UI_VIZ_LINK_REUSED"}` would print the viewer's own alarm text as teammate data (VIZ-25, VIZ-36, INV-VIZ-TEXT, SEC-34), while the legitimate reasons were outside the page subset; the check is at projection, not in the model, because the timeline and its `unknown` counts are the deterministic model (INV-VIZ-DET) — cost if wrong: a legitimate code a later plan forgot to add shows `?` or nothing until it is added (the §3.11 Reused row gains the reason codes: spec-edit list).
- **R-V44 `conflict{breach}` from an event before Plan 4.** Ruling: until Plan 4 folds claims, an effective `event{kind: breach}` makes `conflict{conflict: 'breach', source: 'event', on: <the writer's character>, desk: null, holdId: null, cid: <its cid>, eventKind: 'breach', line: null}` — 12 §3.4 puts the "!" on the holder's chair with a dashed line to the breaching writer, but with no folded claims (Plan 2) the holder cannot be derived from refs — cost if wrong: Plan 4/6 replaces `on`, `desk` and `line` with the holder's chair and the dashed line (a spec gap in the list).
- **R-V45 The rules badge follows the fold on every frame.** Ruling: for every peer, `rules` = (`PeerRec.regionSpec ≠ teamRegionSpec`) is compared between `before` and `after`; a change emits `person_badge{badge: 'rules', on}` at the line of that peer's own effective `join` in the frame when there is one (after that row's other events), else at sub 1,002 as a derived per-actor event; the per-actor order at sub 1,002 becomes ghost, unghost, rules, relaxed — `teamRegionSpec` is re-evaluated at fold step 6 on every commit, so a teammate's ghosting can switch a peer's badge with no join of its own, and a badge shown "while it holds" (12 §3.4) must follow — none (12 §3.3.5's sub-1,002 order and the §3.4 rules row are in the spec-edit list).
- **R-V46 "you" and `self` without the peer file.** Ruling: the overlay's `you` and the fold's `self` use `<gitdir>/cowork/peer` when it reads as 32 lowercase hex, else the last parsed `status.json` `peer_id` when it matches `^[0-9a-f]{32}$`, else `null` (`you`) or 32 zeros (`self`) — Plan 2 never writes the peer file while `status.json` carries `peer_id` (glossary §14), so on real Plan 2 clones "you" would never show — none (12 §3.3.2's read set already lists both fields).
- **R-V47 Pet events carry their owner.** Ruling: `pet_spawn` and `pet_poof` carry `owner: PeerRef` (projected to a `Handle`); the reducer takes a pet's owner — and with it the per-owner seat variant and the `behind` place — from the event and never parses a seat id; the server side derives the owner with `ownerOfSeatKey` (`model/start.ts`, used by `startScene` and the timeline builder) — on the page seat ids are `SeatHandle`s, so a parsed owner would be the handle itself and the page's scene would differ from the projected server scene (VIZ-26; 12 §3.13 "`reduceScene` treats every id as an opaque string") — none (12 §3.3.7 and §3.10.6 in the spec-edit list).
- **R-V48 Responses Node writes before the handler.** Ruling: `createServer` passes `{ requireHostHeader: false, insecureHTTPParser: false, maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000, keepAliveTimeout: 5000, connectionsCheckingInterval: 1000 }` (a value Node 20 accepts only as a server property is set on the server before `listen`); a `clientError` listener writes one fixed raw response — 431 for `HPE_HEADER_OVERFLOW`, 408 for `ERR_HTTP_REQUEST_TIMEOUT`, else 400 — with the whole §3.10.4 header set and `Connection: close`, never `err.rawPacket`, and counts `SEC_VIZ_LIMIT`; `checkContinue` and `checkExpectation` listeners run the normal admission (a bad `Host` → 421 and no `100 Continue`; another `Expect` → 417 with the full header set) — Node ≥ 20 answers a missing `Host` itself (400), writes bare 400/408/431 outside the admission order and headers, auto-answers `Expect: 100-continue`, and by default checks the header and request timeouts only every 30 s, while VIZ-32 and VIZ-33 say "every request" and "every response" — none.
- **R-V49 Layout deltas from the request path.** Ruling: whenever a timeline page appends desks, `WorldApi.page` publishes `{type: 'layout', room_id, layout}` on the hub before it returns the page (its `from_version` is the room's layout version before the call), and `projectDelta` emits the `layout` message before a `room_snapshot` as before a `timeline`; the page applies a layout delta whose `version` ≤ its own version as a no-op (the requesting tab receives the same delta on the stream and in the `TimelinePage`) and reloads the world only on a gap — 12 §3.5.3 ("sends the appended desks to every open stream as one `layout` event") and §3.10.5 ("also announced on the stream"); without it other tabs' desk ordinals go stale — none.
- **R-V50 Byte budgets for served text.** Ruling: `cap()` first cuts a string to `VIZ_RAW_UNITS[kind]` (4 × `VIZ_CAPS[kind]`; name 64) UTF-16 code units at a grapheme boundary and keeps at most 4 combining marks per grapheme, then applies the grapheme cap; the projection serves every `paths` list (`EventVM` publish, `CardVM`) as its longest prefix whose JSON is ≤ `PATHS_MAX_BYTES` = 16,384 bytes, `n` unchanged — the same cut on every route (world, timeline page, stream), so a re-sent card never changes and the page's events equal the server's; `StreamHub.publish` still replaces one event whose framed message with its card exceeds 64 KiB by one `reset` (unreachable with these budgets; a test pins it) — graphemes alone do not bound bytes (an emoji ZWJ sequence or a mark-stacked grapheme is one character), one 256-path change-set of 80-emoji paths is ≈ 82 KB, beyond VIZ-34's 64 KiB, and a hub-only cut would make one event differ between the stream and a timeline page — cost if wrong: a card of a huge change-set lists fewer than all its paths (the page shows ≤ 5 chips and "+n" anyway; the §3.10.6 `paths` cut is in the spec-edit list).
- **R-V51 First-touch heights for dashed desks.** Ruling: `Desk` gains `first: number` (the height of the frame that first touched it; the segment's `hs` for start-state claim paths; 0 for the big table), carried by `LayoutDelta`, `LayoutVM` and `LayoutDeltaVM`; on a past scene the page draws a desk dashed when `first > at.height` (`StaticOptions.dashedFrom` = the scene height, `null` live) — "desks first touched after the scene position are drawn as dashed outlines" (12 §3.5.3) needs a per-desk height, and ordinals stop being monotone in height once "load earlier" appends an earlier page's desks after the existing ones; `first` is a function of the same input, so INV-VIZ-DET holds — cost if wrong: desks never change, so a desk first touched in the window and named again by an earlier page keeps its later `first` and is drawn dashed between the two heights (cosmetic; 12 §3.3.7 `Desk` and §3.10.6 `LayoutVM` are in the spec-edit list).
- **R-V52 Name tags keep the whole handle.** Ruling: `nameTag` computes collisions on the uncapped sanitized display after `normalize('NFKC').toLowerCase()`; a display matching `[\s.·•-]+[0-9a-f]{6,}$` always counts as colliding; a colliding tag is the display capped to max(0, 20 − 3 − |handle|) graphemes, then ` · ` and the whole handle (a tag exceeds 20 only by an extended handle, R-V22) — capping `display · handle` to 20 cuts the handle off two 20-character names, and a display of `Ann . 3f2a1b` could forge a handle suffix next to the real `Ann`, defeating VIZ-18 — none.
- **R-V53 Over-cap viz text.** Ruling: in the `viz` channel a rendered result over `CHANNEL_CAPS.viz` (400) is end-ellipsized to 400 graphemes instead of becoming `UI_TEXT_TOO_LONG`, which is not in the §3.11 table (VIZ-39: the viewer renders no code outside it); other channels keep 10-product §3.2 step 4 — none.
- **R-V54 The CLI's own strings and paths.** Ruling: `src/viz/cli/strings.ts` exports `EN_VIZ_CLI` (the en templates of `UI_VIZ_OPENED`, `UI_VIZ_URL`, `UI_VIZ_OPEN_FAILED`, `UI_VIZ_TERMINAL_ONLY`, the five `RF_VIZ_*`, `RF_UNKNOWN_FLAG`, `START_TOOL_VERSION` and `UI_INTERNAL_ERROR`; it imports only the `Catalog` type), `src/viz/i18n/en.ts` spreads it into `EN_VIZ`, and `runView` registers `EN_VIZ_CLI` only; `isUncOrDevice` and `absolutize` live in the import-free leaf `src/viz/cli/paths.ts`, and `source/rooms.ts` does not re-check them (12 §3.3.1: `--repo` arguments arrive "already absolute and checked by the CLI") — VIZ-01: `cli.js` MUST import only `src/viz/cli/**`, and a `rooms.ts → cli/view.ts` import would pull `runView`, `spawn.ts` and `opener.ts` into `viz.js`; moving the catalog to `src/i18n/viz/**` instead would add a fourth seam outside `src/viz/**`, which 12 §1.5 item 11 does not allow — none.
- **R-V55 The two URL templates.** Ruling: L-VIZ-URL allows exactly two URL templates in `src/viz/**`: in `src/viz/cli/view.ts` a template literal whose head is exactly `http://127.0.0.1:`, then one substitution, then a span starting `/#k=` (the launch URL, re-checked with `URL_RE`), and in `src/viz/server/http.ts` a template that is exactly `http://127.0.0.1:` and one substitution (the viewer origin compared with `Origin`, 12 §2 "viewer origin", §3.10.3 item 2) — a shared `cli/url.ts` would make `server/http.ts` import `src/viz/cli/**`, inverting the layer order — none (the origin form joins 12 §9.5 L-NET and 09-security INV-EGRESS's template sentence in the spec-edit list).
- **R-V56 Health labels and place labels.** Ruling: `phOf(c, status, at)` (`src/viz/model/labels.ts`, pure, shared with the page) gives, first match wins: `status` `left` → `PH_LEFT`; `absent` → `PH_PRESUMED_ABSENT`; frozen with `PAUSED` → `PH_PAUSED`, with `NOHOOKS` → `PH_NOT_COORDINATED`, with any other reason or `'?'` → `PH_FROZEN`; slowed at the scene's position → `PH_SLOWED`; a ghost → `null` (no label fits; the ghost look is its sign); else `PH_OK`; never `PH_OFFLINE`. `placeLabel(s, actor, layout)` (same file) labels a sitting actor `UI_VIZ_HOLDING {label}` when it holds a HELD claim at that desk, else `UI_VIZ_LAST_SHARED_HERE {path, height}` for the desk of its newest publish, never a "working on" wording; `peopleList` (`ui/a11y.ts`) gives the hidden list's rows (name tag, PH or SS label, place label) — 10-product §3.14 says every other label takes precedence over `PH_SLOWED`; 12 §1.5 item 5 and UX-22 forbid "offline" for a teammate; VIZ-17 and 12 §3.11 ("last shared here: {path}") — none.

**Spec conflicts and gaps (the 8a spec-edit batch).** Task 18 step B2 applies every item below to `docs/spec/12-visualizer.md` and the named chapters, together with the 12 §9.2–§9.7 edits to `00-glossary`, `06`, `09`, `10`, `11` and the Plan 2 contract, in R-V02's order (after Plan 2's own spec batch):
1. Git facts: `for-each-ref -z` does not exist (R-V09: 12 §3.3.1, §3.3.2, VIZ-07, §9.5 L-VIZ-GIT); `version` as a subcommand (R-V10); the allowlist's exact positional shapes, `rev-list --count` and `--skip`/`--max-count` (R-V31, Global Constraints).
2. Reads: `cat-file --batch-check` beside `--batch` and the T-VIZ-poll and §3.12 counts (R-V05); `BoardCommitData.csPaths` replaced by `BoardRead` (R-V05, §9.7 item 2); the runner watchdog for viewer reads (R-V06); bounded reads through the `BoundedReader` (R-V30); the fast-forward check (R-V31); `LiveReadFailure` handling and the export encodings (R-V19).
3. Process and CLI: the data-directory derivation and the SDDL rules (R-V11); git resolved by the CLI and passed as `--git` (R-V13: §3.2 item 2's argv, VIZ-02, VIZ-07); `EN_VIZ_CLI` and `cli/paths.ts` (R-V54); `discoverRooms` without its `dataDir` parameter in 8a (8b restores it with `repos.json`); "you" from `status.json` (R-V46).
4. Model: footprint spawns and `k` (R-V18); malformed board commits (R-V19); `event{incident}` (R-V17); the `ActorState`/`Frame` additions and position-typed `lastPublish`/`lastClaimOp` (R-V25); the incident-rebuild layout (R-V21); same-epoch rejoin (R-V42, §3.4 join rows); `conflict{breach}` from an event before Plan 4 (R-V44); the per-frame rules badge and the sub-1,002 order (R-V45, §3.3.5, §3.4); `owner` on `pet_spawn`/`pet_poof` (R-V47, §3.3.7, §3.10.6); `Desk.first` (R-V51, §3.3.7, §3.10.6); VIZ-10's "no Node import": `timeline.ts` and `looks.ts` hash with `node:crypto` and are server-only, so the rule becomes "no I/O, clock, randomness or DOM; Node only for `node:crypto` hashing in the server-only model files".
5. Server and API: first-8 hold-id prefixes collide, handles of 6–32 characters, the fragment regex `^[0-9a-f]{6,32}$` and the T-VIZ-api re-send exemption (R-V22); the `EventVM` position shape (R-V23); `down` without a `live` marker (R-V24); seen anchors (R-V28); one segment per page request (R-V29); layout deltas from the request path and the page's idempotent apply (R-V49); closed code sets and the Reused row's reason codes (R-V43, §3.11); the served path budget and raw-unit caps (R-V50, §3.10.6, §3.11); name tags (R-V52, §3.6); the viz over-cap ellipsis (R-V53); Node's own responses (R-V48, §3.10.3); the origin template (R-V55: 12 §9.5 L-NET, 09-security INV-EGRESS).
6. Lint ids: 12 §9.5's L-NET server-only sub-rules and URL template are implemented as L-VIZ-NET and L-VIZ-URL, and the client typecheck as L-VIZ-TYPES (11-testing §3.10 lists them). Interfaces 8a writes differently from 12 §3.13: `RoomSource.tip(): Promise<TipInfo | null>`, `advance(last)`, `frames(start, from, to, self)`; `startPoll(stores, sink, clock)` returning `() => Promise<void>`; `RoomStore.tick()`'s `{delta, overlay, change}` and `page`/`earlier` returning `null`; `createServer` returning a `VizServer` or `{refuse}`; `main(argv, assets)`; `readStatus(gitdir, prev, { fs, reader })`; `parseDemoLog(buf, captionCodes)`; `killTree(pid, platform, systemRoot)`; `discoverRooms(repos, deps)`; `spawnViewer`'s `ViewerArgs` (with `git`); the new model file `model/labels.ts` compiled into the client (R-V56).
7. Budgets: the CI-exact versus 2× values and the manual time check (R-V41).
8. Roadmap, only if the four ahead tasks of R-V01 actually ran ahead: the execution-order sentence gains "(its tasks that touch no Plan 2 file may start earlier)".
9. (2026-10-08, X-92, F-8a-4; revised by the owner's choice of 2026-10-08, OWNER-CHOICES item 1 = ALTERNATIVE) **No 8a spec item.** The owner chose real-time claims: the viewer's own fold reads, in memory only, the tree entries and blobs Plan 4's `claimFoldNeeds` names, so claim events between checkpoints draw. The edits of 12 §1.1, §3.3.2, §3.3.3, §3.9.3, §3.12, VIZ-06, VIZ-27, INV-VIZ-NOCONTENT, T-VIZ-readset and T-VIZ-demo-format are the 12 owner's, applied on `proposals` with the choice (reconcile §7 V-1), and the code that uses them is 8a's new Task 20 (F-8a-13: the reader, inputs on every frame, the claims-pending state, the demo answers), with Plan 4 Task 8's `overlapPairsOf` and Plan 4's claim rows in its follow-up 4-V. The withdrawn re-seed (a claims-only checkpoint difference read as `match`) is not in 8a's batch; 12 §3.3.3 "Checkpoints" stays as written (a mismatch is display-only, the viewer keeps its own fold).
10. (2026-10-08, X-94, F-8a-10) 12 §3.8 "Card content": "for a hold record the first 8 characters of its hold id" → "the shortest unique prefix of at least 8 characters of its hold id (R-V22; the viewer keys every hold by its full id)"; 10-product §2 (show id) changes only if it no longer admits such a prefix (rev 2.5 admits a unique prefix of ≥ 6, so normally no 10-product sentence is needed).
11. (2026-10-08, X-03, X-04, F-8a-12) Batch form: the batch is applied against rev 2.5 (glossary §29, D1–D5 final), after Plan 2's batch and before Plan 3's (the one order Plan 2 → 8a → 3 → 4 → 5 → 6 → 7 → 8b), names the batch it follows, and drops every item rev 2.5 already carries — in particular the D3 (F32) and D4 text of 12 and roadmap row 8 (F32 §7 items 1–9 and 11 are in rev 2.5) and every D1/D2/D5 sentence. Task 19 moves its eight codes from 12 §9.9 into §3.11 in its own merge, never in this batch.
12. (2026-10-08, X-03; reported by the 8b reconciliation) 12 §9.1's "Originally proposed" copy of roadmap row 8: "(rev 2.5, F32; provisional, owner decision D3 of 2026-10-08)" → "(rev 2.5, F32; owner decision D3 of 2026-10-08)" — D3 is final (glossary §29.1) and the roadmap file, which §9.1 names authoritative, has no "provisional"; dropped if the rev 2.5 text no longer carries the word when Task 18 runs.

**Cross-plan reconciliation (2026-10-08).** Source: `.worktrees/proposals/.superpowers/reconcile/RECONCILIATION.md` (rulings X-01…X-119; §3 "Plan 8a" follow-ups F-8a-1…F-8a-12; §4 "Plan 8a: F-8a-1 … F-8a-12. No other edit"). 8a is executing (Tasks 1, 3, 4, 5, 10, 11, 12 merged; Task 2 in review — ledger, later on 2026-10-08: Task 2 merged as `04c190e`, and Tasks 6, 9 and 13 were dispatched with the Task 6 and Task 9 amendments below in their briefs), so its contract stays the landed code plus the ledger rulings R-V01…R-V74 (no R-V70 recorded), and every change from the reconciliation is additive: a new task (Task 19), a contract amendment of a task that has not started (Tasks 6, 7, 9, 16, 18), a follow-up with an owner (§Tasks, "Follow-ups from the cross-plan reconciliation"), or a note on what other plans do to 8a files. The spec baseline is rev 2.5 (`proposals/docs/spec`, glossary §29), which supersedes the header's "rev 2.4" for every rule rev 2.5 touches. Rulings applied:
- **X-03, X-04** (F-8a-12): spec-batch form and order — item 11 above (and item 12, a stale D3 word rev 2.5 still carries).
- **X-61, X-62** (F-8a-2): one plugin-data module `src/data/pluginDataDir.ts` (`pluginDataDir`, `resolveDataDir`; node-only) and one SDDL module `src/sec/sddl.ts` (`Sddl`, `parseSddl`, `sddlUserOnly`, `sddlOwnerOk`, one allowed-SID constant: the user, `S-1-5-18`, `S-1-5-32-544`); the bodies move out of `src/viz/cli/dataDir.ts`, which re-exports every name unchanged; user-only directory creation stays `verifyDataDir(dir, {create: true})` (8b binds it; there is no `createUserOnlyDir`). This settles R-V11's "Plans 5/7 replace `pluginDataDir`": Plan 5 then adds the optional `pluginRoot` parameter and `pluginIdOf` (`<plugin>-<marketplace>` id, R5-56) to the moved module.
- **X-63, X-105** (F-8a-3): Task 7 uses `canonRoot(p, probe, platform)` from `src/data/canonRoot.ts` instead of writing `canonicalRoot` — Task 7 creates that file (with `RootProbe`/`realRootProbe` in `src/ports/fs.ts`) at exactly Plan 5's declared signatures and Plan 5 Task 1 extends it in place (verify pass V-12: one creator, no "whichever first"); `readPeerFile(gitdir, reader)` keeps its name (Plan 7 names its reader `readPeerId`).
- **X-76**: F04-a (a Plan 2 follow-up) makes `layout.ts`'s `zoneOf` a re-export of `zone` from `src/data/zone.ts` and adds that file to the R-V35 client program in `vizRules.ts`, with the 8a reviewer; F04-a reads `BoardRead` (R-V05, R-V69), not a `BoardCommitData.csPaths`.
- **X-72, X-95, X-96, X-97, X-88** (F-8a-11): one human-facing text per code. Plan 7's generator (`tools/i18n/build.ts`) emits the import-free leaf `src/i18n/generated/shared.ts` and Plan 7 Task 2 makes `en.ts` take the shared entries (`PH_*`, `SS_*`, `UI_DUR_*`, `UI_INTERNAL_ERROR`, `RF_UNKNOWN_FLAG`, `START_TOOL_VERSION`, the `SEC_` trio, `DR_CATALOG_MISS`, the `REASON_CODES` templates) from it — when that lands, R-V60 reads "`en.ts` imports exactly `src/viz/cli/strings.ts` and `src/i18n/generated/shared.ts`" and L-VIZ-IMPORT and the client closure admit that one leaf; refusals follow Plan 7's `renderRefusal(code, params, next: NextLine, r, channel)` and `RF_UNKNOWN_FLAG {verb, flag}`; `render.ts`'s one `ParamType` union is appended in place (Plan 7 `sym`, `oid`, `hostmsg`; 8b `int`, `count`), misses go through `setMissObserver(f)` and `render.ts` stays I/O-free; Plan 7 appends `'sym'`, `'notif'` to `CapKind` with their `VIZ_CAPS`/`VIZ_RAW_UNITS` entries.
- **X-90**: R-V02's rebase rule for `foldCommit`'s loop: of 8a Task 2 and Plan 3 Task 3 the second to merge rebases; Plans 4 and 6 rebase onto both; every plan keeps `opVerdicts` exact (effective iff `applyOp` is true and the type ∈ `PLAN2_FOLDED_TYPES`); the commit that adds a type to `PLAN2_FOLDED_TYPES` flips that type's rows in `test/unit/viz/verdicts.test.ts` (for `hold`: whichever of 8a Task 2 / Plan 3 Task 3 merges second). The Plan 2 ledger note and the two R-V02 preconditions are Plan 2's follow-up F-P2-2.
- **X-91** (F-8a-4, F-8a-5): each producing plan owns its op → scene rows in `timeline.ts`, its `startScene` reads, its T-VIZ-timeline-fixtures rows and its goldens — in its fold commit when Task 6 has merged before it, else in a follow-up of that plan when Task 6 merges (Plan 3 "3-V" holds, Plan 4 R4-68 claims, Plan 5 seat and health rows, Plan 6 R6-63, Plan 7 `save` emit, `person_exit`, `room_sign`); goldens regenerate only through Task 16's `npm run viz:golden -- --update`.
- **X-92** (F-8a-4; "For the owner" item 1 — **the owner chose the ALTERNATIVE on 2026-10-08**, OWNER-CHOICES item 1): real-time claims. The viewer's own fold reads the tree entries and blobs `claimFoldNeeds` names, in memory only (never served, logged, stored or exported), so claim events between checkpoints draw and the README demo has its claim beat (8b). Task 6 has no re-seed, no `CLAIM_FOLD_KEYS` and no mismatch suppression (its amendment below); `foldFrame` keeps three parameters until the new Task 20 (F-8a-13, after Plan 4 Task 8) passes `inputs` on every frame and adds `readClaimInputs`, the demo answers, the exporter's `claims`, the claims-pending state (`UI_VIZ_CLAIMS_PENDING`) and the tests; Tasks 7 and 16 (not started) parse and write the demo fields `live` and `claims`; Plan 4's follow-up 4-V keeps only the claim rows (F-8a-11 table). A missing object never makes the viewer fold a commit without inputs. Do not restore the checkpoint-only default.
- **X-93** (F-8a-1): Task 19 (F32, owner decision D3) in group G9, `cameraTarget(…): number | null`, `NowCard` of §Interfaces.
- **X-94** (F-8a-10): R-V22 stands as the rule (Task 9 already tests it); item 10 above.
- **X-98**: amends R-V34's "two allow tables until Plan 7 consolidates them" and §Tasks' "`tools/lint/vizRules.ts` is Task 1's alone": Plan 7 Task 1 moves the allow entries to `tools/lint/allow.ts` (`VIZ_ALLOW` becomes its `owner: 'viz'` view, asserted ⊇ 8a's snapshot); the `L-VIZ-*` rule logic stays in `vizRules.ts`, owned by 8a and edited by F04-a and 8b with the 8a reviewer.
- **X-99**: settled by the landed `vizRules.ts` (it fires only on `src/entry/cli.ts → src/viz/<non-cli>`): Plan 5's `src/claude/client/cliClient.ts` import and F04-a's `since` line in `cli.ts` are allowed; no 8a change.
- **X-100, X-117**: 8a declares its codes once (`VIZ_CODES` in `codes.ts`); Plan 7's `carried.ts` imports `codes.ts` and marks the chapter-12 codes `langs: 'en'` (8b flips them).
- **X-104**: R-V43's closed sets grow in the producing plan's commit (or its viewer follow-up, X-91), each code with its en template: Plan 3 `HOLD_REVERT_HELD`; Plan 5 `SEAT_FULL`, `SEAT_NO_MCP`, `HOOK_ONLY`, `DEGRADED`, `SEAT_PULL_MODE`, `PEER_IDLE`, `LIVE_MARKER_RESTORED`; Plan 7 `BASE_MOVE_CONFLICT`, `BRANCH_ESCAPE` (all `HEALTH_REASON_CODES`); `SEC_REVIEW_ACCEPTED` stays outside every set.
- **X-106**: R-V71's freeze re-post is generic in Plan 2's loop over every `meta.freeze_reasons` entry (Plan 2 Task 17); Plans 5 and 7 write no re-post code.
- **X-107**: `build.mjs` keeps R-V36's order `parseArgs → checkOutdir → rm/mkdir` and the `viz` entry; `checkOutdir` admits `grammars/` (Plan 4), `i18n/` (Plans 5, 7), `schema/` (Plan 7); `build.test.ts` compares to an explicit list each plan appends to, later Plan 7 Task 19's `canonicalDistList()`.
- **X-108** (F-8a-9): F04-b is an 8a-controller follow-up after 8a's exit (§Out of Plan 8a).
- **X-110**: the global import order `src/ports → src/text → src/i18n → src/git → src/sec → src/data → src/regions → src/board → src/since → src/holds → src/claims → src/engine → …`; `src/viz/**` keeps L-VIZ-IMPORT (it may import `src/data` and `src/sec` leaves, e.g. F-8a-2, F-8a-3).
- F-8a-6, F-8a-7, F-8a-8 and F-8a-11 are follow-ups or ledger acts with an owner (§Tasks, "Follow-ups from the cross-plan reconciliation"); the landed forms F-8a-6 ratifies are annotated in §Interfaces.

### Out of Plan 8a (Plan 8b, and later plans)

- **8b (after Plans 5 and 7):** the `/cowork view` slash verb (the `commands/cowork.md` route, `slash`-mode opening with the framed `UI_VIZ_OPENED`/`UI_VIZ_OPEN_FAILED`) and `--json` with `dist/schema/cowork-view-1.json`; `repos.json`/`live` room discovery, the 30 s re-check, `room` events `added`/`gone` from it and `UI_VIZ_ROOM_AMBIGUOUS` on the map; the five other human catalogs for every §3.11 code and `user.json` in `L_h`; `scanSecrets` (VIZ-36 step 3, `SEC_SECRET_REDACTED`) and SEC-38's log scan; the `SHA256SUMS` check of `dist/viz.js` (VIZ-02, `SEC_REFUSE_RUNTIME_INTEGRITY`); the record panel, WebM and GIF export, `src/viz/client/{record,gif}.ts`, anonymize (VIZ-28, VIZ-29, §3.9.4); T-VIZ-anonymize, T-VIZ-recording, browser smoke item (h), T-VIZ-manual; the six-language bundled demo and a README GIF; the shared SEC-20 data-directory derivation (replacing R-V11's placeholder).
- **Plans 3–7 (each adds its rows to 8a's fixtures, per roadmap "Execution order"):** hold records, boxes, K4/K7 "!" (3); claims, chairs, tags, grants, reservations (4); pets from `seat_start` and seat CSs, checkpoint vs closed sparkles, wake icons, seat wiring labels (5); requests, statuses, answers, notes, presumed absence, STALE chairs, breach events (6); `leave`, save confetti, base moves, branch-escape badges (7). 8a's reducer, placement, cards, animation table and art handle the whole closed kind set of §3.4 (unit-tested with hand-written scene events), while 8a's timeline builder emits events only for what the Plan 2 fold applies (`join`, `leave`, `seat_start`, `seat_end`, `event`, `save`), code trailers and derived transitions; each of Plans 3–6 adds the op → event mapping of its types to `src/viz/model/timeline.ts` together with its fold effect, because the folded record shapes (`claims`, `requests`, `holds`, `notes`) are fixed by those plans. On a Plan 2 board those ops are `unfolded` and draw nothing.
- **(2026-10-08, X-91, X-104)** The rows each plan owns: Plan 3 "3-V" (hold → `conflict{k4 | k7, source: 'hold'}` + `box{terminal}`, `startScene` reads `FoldState.holds`); Plan 4 R4-68 (claims, folded in real time with the viewer's claim inputs of Task 20 — X-92 as chosen by the owner; Plan 4 follow-up 4-V after Task 20); Plan 5 (`seat_start` → `pet_spawn`, `seat_end` → `pet_poof`, health → wiring labels, its health codes); Plan 6 R6-63; Plan 7 (`save` emit, `person_exit`, `room_sign`, its health codes). Each lands in that plan's fold commit when Task 6 has merged first, else in a follow-up of that plan when Task 6 merges; goldens regenerate through Task 16's `npm run viz:golden -- --update`; Task 6's mapping table takes those rows without an 8a edit.
- **(2026-10-08, D3, F32) 8b's half of Task 19:** the eight follow codes in the five other catalogs, the recording clause of browser smoke item (k) (with T-VIZ-recording), and the 10-product §3.18 README `privacy` sentence (F32 §7 item 10).
- **(2026-10-08, X-108, F-8a-9) F04-b after 8a's exit:** an 8a-controller follow-up, not an 8a task and not in 8a's exit — `src/viz/model/moments.ts` (`moments`, `lastVisit`), the optional `RoomVM.open_h`, `AnimState` `'montage'`, the catch-up panel and Play in `en`, with its eight 12 §9.9 codes moved into §3.11 in its own merge (roadmap row 8); 8b's fallback Task 6b runs only if F04-b is absent at gate Q.

### Cross-plan assumptions (resolved, 2026-10-08)

The plan was written before Plans 3–7 and 8b, so it had no assumptions table; these are its clauses that name another plan, with the ruling that settles each.

| Clause | Resolution |
|---|---|
| R-V01 gate P | Waived by the owner for Tasks 10, 11 (2026-10-07 23:40) and 2, 5 (2026-10-08 09:40), ledger; other tasks still wait for their inputs. |
| R-V02 "whichever merges second rebases"; the Plan 2 ledger note and the two deferred items | X-90 (the rebase and verdict-test flip rule for 8a, Plans 3, 4, 6); the ledger note and the two preconditions are Plan 2's follow-up F-P2-2. |
| R-V03 tripwire: Plans 3/4/6 move a type into `PLAN2_FOLDED_TYPES` with its effect | X-90: the same commit flips that type's `verdicts.test.ts` rows. |
| R-V07 "Plans 3/5 import `parseCsActor` from `src/board/csActor.ts`" | Unchanged (no ruling moves it). |
| R-V08 `to_holder` shape is Plan 6's | Plan 6 R6-21 (nested `{peer, seat}` / `{seat}`); its rows are Plan 6's (X-91). |
| R-V11 "Plans 5/7 replace `pluginDataDir`" | X-61, X-62: the bodies move to `src/data/pluginDataDir.ts` and `src/sec/sddl.ts` (F-8a-2, the 8a controller's, run now — verify pass V-12); Plan 5 extends the moved module; Plan 7 computes its `source` locally. The fixed id `cowork-sync` in R-V11's derived path becomes Plan 5's `pluginIdOf(plugin root)` (`<plugin>-<marketplace>`, A1-12) when Plan 5 Task 1 lands, and the landed tests asserting the fixed id change with it (Plan 5 Task 1, 8a reviewer). |
| R-V15 `user.json` is Plan 7's; 8b moves the templates | X-95 (one generated leaf for the shared codes), X-100. |
| R-V22 first-8 hold-id prefixes collide | X-94: the shortest unique prefix ≥ 8, keyed by the full id; no Plan 3 change. |
| R-V24 the `--repo` argument stands in for the `live` marker | Unchanged; the marker holds `canonRoot(main worktree)` + LF (X-63), the string Task 7's room key uses. |
| R-V34 "two allow tables until Plan 7 consolidates them" | X-98. |
| R-V37 T-VIZ-golden-sim needs Plan 2 Tasks 18–19 | Unchanged. |
| R-V38, R-V40 `scanSecrets` is 8b (Plan 7 writes it) | X-51: Plan 7's async `scanSecrets`/`scanHit` and the sync `scanD2` that 8b binds. |
| R-V43 later plans extend the closed sets | X-104 (the codes and their plans). |
| R-V44 Plan 4/6 replace `on`, `desk`, `line` of `conflict{breach}` | X-91: their rows. |
| R-V46 Plan 2 never writes the peer file | Unchanged; Plan 7 writes it at START (R7-30); X-105 keeps `readPeerFile`. |
| R-V71 the freeze re-post (Plan 2 loop, Plans 5/7) | X-106: generic in Plan 2's loop. |
| R-V73 later plans fill `ClaimState.at` and sort a desk's claims by (order, at) | Unchanged; Plan 4's start-scene claims and its real-time `claim_take`/`claim_move` rows (X-91, X-92 as chosen by the owner). |
| R-V74 map `readBoardCommit`'s death on a hostile board to an incident | Plan 2's final review (F-P2-3). |
| "Out of Plan 8a": Plans 3–7 add rows to 8a's fixtures | X-91 (above). |
| Plan 5 asks `src/entry/cli.ts` to import `src/claude/client/cliClient.ts` (X5-40) | X-99: allowed by the landed lint. |
| Plan 5, 7 and F04-a edit 8a files | F-8a-11 (8a reviews them; listed in §Tasks, "Follow-ups"). |

---

## File Structure

```
src/board/fold.ts               (modify, additive) OpVerdict, FoldStepResult.opVerdicts, per-line verdicts in foldCommit (R-V03)
src/board/boardCommit.ts        (modify, additive) `export` on batchObjects, batchCheck, subtreeNames, capViolation, opsLinesOf and their record types
src/board/batchRead.ts          readBoardCommits / readLiveCommits: two cat-file processes per ≤ 1,280-commit batch (R-V05)
src/board/csActor.ts            parseCsActor: the shared cs_id grammar (R-V07)
src/git/runner.ts               (modify) killTree spawns <SystemRoot>\System32\taskkill.exe by absolute path (§9.7 item 5)
src/text/sanitize.ts            sanitize(text, channel): SEC-34 first version, channels claude|deny|terminal|notification|log|viz; viz caps
src/i18n/render.ts              render(code, params, channel, lang) and renderWith(catalog, …): 10-product §3.2 first version
src/data/pluginDataDir.ts       (follow-up F-8a-2; X-61) pluginDataDir, resolveDataDir: the moved bodies, node-only leaf; Plan 5 adds pluginRoot? and pluginIdOf
src/sec/sddl.ts                 (follow-up F-8a-2; X-62) Sddl, parseSddl, sddlUserOnly, sddlOwnerOk and the one allowed-SID constant: the moved bodies
src/entry/cli.ts                (modify) `view` → runView; --version and the no-argument no-op unchanged
src/entry/viz.ts                seventh entry: --version, no-argument no-op, `serve …` → main()
src/viz/assets.ts               the only importer of viz-asset:* (client bundle, app.css, bundled demo); imported only by src/entry/viz.ts
src/viz/assets.d.ts             ambient `declare module 'viz-asset:*'`
src/viz/main.ts                 the viewer process: serve argv, SEC-20 re-check, self-hash, rooms or demo, bind, ready line, exits, wiring
src/viz/i18n/codes.ts           every §3.11 code the viewer and its CLI use, by group; the closed code sets (R-V43); PAGE_CODES
src/viz/i18n/en.ts              the en template of every code in codes.ts and REASON_CODES (8a's only catalog; spreads EN_VIZ_CLI)
src/viz/model/events.ts         the closed SceneEvent set and its refs (§3.3.7 verbatim)
src/viz/model/scene.ts          Scene and its parts (§3.3.7), comparePos, emptyScene, applyEvent, reduceScene (shared with the page)
src/viz/model/layout.ts         Zone, Desk, Layout (§3.3.7), zoneOf, append-only allocation (§3.5.3), LayoutBuilder, deltas, tile coordinates (§3.5.2), isDashed (R-V51)
src/viz/model/looks.ts          lookOf, lookTable (§3.6; node:crypto, server only)
src/viz/model/placement.ts      §3.5.4: target desk, character and pet precedence, chairs and visitors, home spots (shared with the page)
src/viz/model/labels.ts         phOf, placeLabel: health and place label codes (R-V56; shared with the page)
src/viz/model/cards.ts          Card (§3.3.7) and cardFor (§3.4 card column, §3.8 closed list) (shared with the page)
src/viz/model/frame.ts          Frame (§3.3.4), FrameCode, toDraft/noopDraft (the BoardDraft builders), foldFrame: foldCommit + opVerdicts → Frame (server only)
src/viz/model/start.ts          startScene (§3.3.5), ownerOfSeatKey (R-V47) (server only)
src/viz/model/timeline.ts       WindowInput, Timeline, Carry, TimelineBuilder, build/extend/prependTimeline, serializeTimeline, eventSeed, actorOfCs (server only)
src/viz/render/palette.ts       hues, tones, mix, sRGB→CIELAB, CIEDE2000, Machado CVD, the L* adjustment, accessory pairs, environment palette
src/viz/render/sprites.ts       string maps: base 16×16, frame edits, 8 accessories, pet 8×8, seat variants, 3×5 digits, 8×8 icons, tiles
src/viz/render/raster.ts        Rgba buffers at art resolution: composeStatic, composeSprites, placeTile, rgbaHash input
src/viz/source/roomSource.ts    RoomSource, TipInfo, Advance, RoomSpec, Overlay, DemoCaption (types only: the room sources' contract)
src/viz/source/vizGitArgv.ts    VIZ_GIT_SUBCOMMANDS, vizGitArgvOk: the allowlist grammar (import-free; shared by VizGit and L-VIZ-GIT)
src/viz/source/vizGit.ts        VizGit: the read-only git facade (allowlist, VIZ-07 flags), vizGitRunner
src/viz/source/boundedRead.ts   BoundedReader, realBoundedReader (node:fs: O_NOFOLLOW, fstat, ≤ cap + 1 byte), fsBoundedReader (R-V30)
src/viz/source/git.ts           GitRoomSource: stat pairs, tip pinning, chain paging, batched reads, frames, checkpoint bytes
src/viz/source/demo.ts          parseDemoLog (§3.9.3), DemoRoomSource, demo room ids
src/viz/source/status.ts        readStatus (one bounded read ≤ 1 MiB), readPeerFile, youOf (R-V46), overlayOf (§3.3.6)
src/viz/source/rooms.ts         discoverRooms (--repo, already absolute and checked by the CLI), canonicalRoot, roomId, decodeEnc, labels
src/viz/server/models.ts        RoomDelta, TimelinePageModel, RoomSnapshotModel, CardModel, PeerInfo, PetInfo, Tick, RoomBadge, StoreLike, PollSink, WorldApi (types only)
src/viz/server/store.ts         RoomStore: window, segments, retention and re-fold, ticks, badges, incident freeze, overlay
src/viz/server/poll.ts          startPoll: the 2.5 s loop over all stores (§3.9.2)
src/viz/server/api.ts           createWorldApi (implements WorldApi): world/page/strings over the stores, world recomputed ≤ once per 2.5 s, page layout deltas published (R-V49); pollSinkFor
src/viz/server/viewModel.ts     every served JSON shape (§3.10.6 verbatim + the written-out projections, R-V26)
src/viz/server/project.ts       the only producer of served JSON: HandleTable, vizText, vizCode, servedPaths, SERVED_STRING_FIELDS, nameTag, project* (validators, sanitize, caps, closed code sets)
src/viz/server/stream.ts        StreamHub: sequence ids, resume ring, 64 KiB split, reset, bye, comment lines; SseSink
src/viz/server/tokens.ts        TokenAuthority: launch and session tokens, redemption, reuse, expiry; tokenEquals
src/viz/server/http.ts          createServer: 127.0.0.1 listener, admission, headers, routes, SSE sink (the only node:http importer)
src/viz/server/shell.ts         the static shell document (no data, no human text) and the asset map
src/viz/server/vizLog.ts        viewer log files: per-instance rotation, 14-day cleanup, per-code 60 s aggregation, content allowlist
src/viz/server/clockTimer.ts    (landed in Task 10; ratified, F-8a-6) ClockTimer, clockTimer(clock, ms, fn): Clock-driven timers for the server
src/viz/cli/view.ts             runView: flags, output mode, data dir, L_h, git resolution, the §3.10.9 tty row, refusals
src/viz/cli/paths.ts            isUncOrDevice, absolutize (import-free leaf, R-V54)
src/viz/cli/strings.ts          EN_VIZ_CLI: the en templates of the CLI's codes (R-V54)
src/viz/cli/pathTrust.ts        excludedRoots, filterPath, trustedExe, resolveGitPath (realpath-compared exclusions, R-V13, R-V39)
src/viz/cli/spawn.ts            spawnViewer (ready handshake), killTree (absolute taskkill / process group)
src/viz/cli/opener.ts           planOpener, openUrl: absolute opener per OS, Linux PATH filter and owner/mode checks through pathTrust.ts
src/viz/cli/dataDir.ts          pluginDataDir, resolveDataDir, verifyDataDir, parseSddl (SEC-20, R-V11); after F-8a-2 it re-exports the moved names from src/data and src/sec
src/viz/cli/ownerProbe.ts       OwnerProbe: lstat uid/mode (POSIX), SDDL via absolute PowerShell (Windows)
src/viz/ui/sse.ts               text/event-stream parser for fetch + ReadableStream
src/viz/ui/conn.ts              ApiRoute, connection state machine: redemption, world, stream, retry 1 s → 30 s, reload, stopped, reused; firstRoom
src/viz/ui/anim.ts              scene event kind → animation state, frames, durations, reduced forms (§3.7)
src/viz/ui/loop.ts              render-loop scheduler: ≤ 12 fps, draw on frame-index change, stop when idle
src/viz/ui/path.ts              A* on the tile grid (N, E, S, W; turn penalty 1), path cache, poof rule
src/viz/ui/bubbles.ts           bubble duration, wrapping, per-actor and per-room limits (§3.8)
src/viz/ui/logModel.ts          the log panel's model: ≤ 2,000 cards, publish merging, AND filters, chips and nesting, seen labels
src/viz/ui/seek.ts              per-segment scene cache every 64 heights, page fetch planning, live/caught-up state, staticFor (dashed desks, R-V51)
src/viz/ui/unproject.ts         view model → model-shaped events, scenes, layouts (handles as ids); applyLayoutDeltaVM (idempotent, R-V49)
src/viz/ui/fragment.ts          #k= launch token extraction and the filter fragment (fixed regexes, never a path)
src/viz/ui/zoom.ts              Z and the map zoom (§3.7), scroll-follow rule
src/viz/ui/a11y.ts              scene summary params, peopleList (R-V56), announcement rate limit, keyboard map
src/viz/ui/map.ts               roomDots, headerLamp, sceneOverlayMarks (12 §3.5.1, §3.3.6), MAP_DOTS_MAX, MAP_SCROLL_AFTER
src/viz/ui/follow.ts            (Task 19, F32) follow camera, focus actor, now card, the page-memory follow map, pan or jump (12 §3.8.1)
src/viz/client/main.ts          page boot: fragment, redemption, strings, world, stream, panels
src/viz/client/api.ts           createConnIo: one literal fetch per ApiRoute and the stream reader (fetch + ReadableStream, never EventSource)
src/viz/client/office.ts        office and map canvases: offscreen art buffers, sprite animation, pathfinding, text plates
src/viz/client/log.ts           the DOM log panel (textContent only), filters, cards, "new" pill
src/viz/client/rewind.ts        the rewind bar, ticks, speeds, live pill, load earlier, keyboard
src/viz/client/a11y.ts          aria-label, hidden people list, live region, reduced-motion and pause controls
src/viz/client/app.css          chrome styles (light and dark token sets, apricot accent, pixelated canvases)
src/viz/client/tsconfig.json    the client typecheck program: standalone, lib ES2022 + DOM, types [] (typechecked by npm run lint, R-V35)
src/viz/demo/plan2.jsonl        the bundled Plan 2 storyboard demo log (≤ 64 KiB, cowork-viz-demo/1)
tools/build/build.mjs           (modify) seventh entry viz, client pre-bundle, viz-asset:* text modules, all inline (R-V36)
tools/lint/lint.ts              (modify) applies VIZ_ALLOW, lintVizSource and the client typecheck (R-V34, R-V35)
tools/lint/vizRules.ts          L-VIZ-DOM, L-VIZ-GIT, L-VIZ-IMPORT, L-VIZ-URL, L-VIZ-NET, lintVizClientProgram (L-VIZ-TYPES), VIZ_ALLOW
tools/viz/boardWriter.ts        scripted board builder over Plan 2's buildBoardCommit (tests and the storyboard)
tools/viz/export-demo.ts        dev tool: a board chain → cowork-viz-demo/1 (12 §3.9.3)
tools/viz/golden.ts             `npm run viz:golden [-- --update]`: regenerate or compare test/golden/viz/*
tools/viz/storyboard.ts         builds the Plan 2 storyboard board and writes src/viz/demo/plan2.jsonl
tools/viz/storyboard.captions.jsonl   the storyboard's caption records (hand-written)
tsconfig.json                   (modify) exclude src/viz/client/**
package.json                    (modify, Task 16) one script line viz:golden; typecheck unchanged
test/integration/build.test.ts  (modify) seven entries
test/helpers/vizSchema.ts       JSON Schemas from viewModel.ts via the TypeScript compiler API (R-V27)
test/helpers/vizViewer.ts       in-process viewer (startViewer with injected ports) and a built dist/viz.js runner
test/helpers/vizHttp.ts         raw HTTP/1.1 client over node:net for admission tests (exact header bytes)
test/helpers/vizEvents.ts       builders for hand-written scene events, scenes and frames
test/helpers/cdp.ts             Chrome DevTools Protocol client over the built-in WebSocket (Node ≥ 22)
test/fixtures/viz/rows/*.json   one BoardDraft fixture per §3.4 row (with its plan)
test/golden/viz/                rows/*.events.json, board-<n>.timeline.json, frames.json (RGBA hashes), viz-golden-<n>.timeline.json
test/unit/viz/*.test.ts, test/integration/viz/*.test.ts   the T-VIZ-* tests, each named in its task
.github/workflows/viz-slow.yml  the COWORK_VIZ_SLOW=1 suites (contention, perf, golden board and SIM) on three OS legs
```

## Interfaces (the contract every task implements exactly)

Plan 1 and Plan 2 names are used as they are in the code (`Clock`, `Anchor`, `anchorNow`, `elapsedMono`, `ownStaleness`, `machineMonoMs`, `Random`, `realRandom`, `randomHex`, `Fs`, `FsLstat`, `realFs`, `Scheduler`, `GitRunner`, `GitResult`, `GitRunnerDeps`, `createGitRunner`, `watchdogMs`, `WATCHDOG`, `GitCallOptions`, `buildGitInvocation`, `buildDaemonEnv`, `GitVersion`, `parseGitVersion`, `meetsFloor`, `enc`, `Oid`, `parseOid`, `isOid`, `Trailer`, `parseMessage`, `CommitInfo`, `GitRepo`, `RepoPaths`, `RepoContext`, `GitCommandError`, `PeerId`, `EpochId`, `base32c`, `H`, `parseOpId`, `Json`, `canonicalJson`, `canonicalBytes`, `OpType`, `Op`, `OpDraft`, `PLAN2_FOLDED_TYPES`, `parseOpLine`, `serializeOps`, `OPS_MAX_LINES`, `OPS_MAX_BYTES`, `ProtocolJson`, `readProtocol`, `genesisProtocol`, `WriterId`, `CsTrailer`, `BoardCommitData`, `BoardDraft`, `BoardBuild`, `buildBoardCommit`, `liveCommitTrailers`, `boardTrailers`, `formatWriter`, `parseWriter`, `parseCsTrailers`, `encodeCsPaths`, `decodeCsPaths`, `LiveShape`, `liveShape`, `boardShapeOk`, `BoardMalformedReason`, `BOARD_COMMIT_OBJECT_MAX_BYTES`, `BOARD_TREE_MAX_BYTES`, `PeerRec`, `FoldEvent`, `FoldState`, `OwnRejection`, `FoldStepResult`, `initialFoldState`, `foldCommit`, `serializeFold`, `parseFold`, `liveSet`, `rankedSet`, `CHECKPOINT_EVERY`, `K_EVICT`, `REPLAY_MAX`, `validPathSyntax`, `validId`, `validName`, `REASON_CODE_RE`, `StatusJson` (Plan 2 Task 17, `src/engine/status.ts`), and in tests `makeTempRoot`, `testRunner`, `createBareRemote`, `clonePeer`, `seedRemote`, `makeRepoFixture`, `fixtureContext`, `FIXTURE_WALL_MS`, `VirtualClock`, `FaultFs`, `seededRandom`, `runSim`, `Oracle`, `SimContext`, `PeerClone`). Everything below is new or changed. A comment `(…)` after a member is part of the contract.

### Board seams (outside `src/viz/**`)

```ts
// src/board/fold.ts — additions only (R-V03); every existing declaration and behaviour is unchanged
export type OpVerdictKind = 'effective' | 'unfolded' | 'rejected';
export interface OpVerdict {
  line: number;                                  // 0-based index into BoardDraft.opsLines
  opId: string | null;                           // the parsed op's id; null when the line does not parse
  type: OpType | 'unknown';
  verdict: OpVerdictKind;                        // effective: applied by a type with an effect in this build; unfolded: generic- and
                                                 // type-valid, folded as a deterministic no-op (type ∉ PLAN2_FOLDED_TYPES, R-12); rejected: the rest
  reason?: 'malformed' | 'generic' | 'type';     // only with 'rejected': parseOpLine or parseOpId null | genericOk false, past the loop bounds or writer null | applyOp false
}
export interface FoldStepResult { state: FoldState; ownRejections: OwnRejection[]; landedOwnOpIds: string[]; protoMismatch: boolean; opVerdicts: OpVerdict[]; }
// foldCommit: opVerdicts.length === c.opsLines.length, in line order; independent of `self` (12 §9.7 items 1 and 6).

// src/board/boardCommit.ts — `export` added to existing private declarations (bodies unchanged, R-V02):
//   interface BatchObject, function batchObjects, function subtreeNames, interface EntryInfo, function batchCheck,
//   interface BoardEntries, function capViolation, function opsLinesOf

// src/board/csActor.ts (12 §9.7 item 4; R-V07)
export type CsActor = { kind: 'human'; peer: PeerId; n: number } | { kind: 'seat'; seat: string; turnSeq: number };
export function parseCsActor(csId: string): CsActor | null;      // validId('cs'); counters are safe integers ≥ 1; anything else null

// src/board/batchRead.ts (12 §9.7 items 2, 3, 8; R-V05)
export interface BatchGit { run(args: string[], opts: { stdin: Buffer }): Promise<GitResult>; }   // GitRepo and VizGit both satisfy it; rc ≠ 0 throws
export const READ_BATCH_MAX = 1_280;
export interface LiveRead {
  oid: Oid; info: CommitInfo;                    // info equals GitRepo.readCommit(oid)
  writer: WriterId | null;                       // exactly one Cowork-Writer that parseWriter accepts, else null
  seats: string[];                               // Cowork-Seat values in trailer order
  cs: CsTrailer[]; csPaths: Map<string, string[]>;   // parseCsTrailers(info.trailers)
  base: Oid | null;                              // the single Cowork-Base value when isOid, else null
}
export interface LiveReadFailure { oid: Oid | null; malformed: 'missing' | 'not_commit' | 'commit_too_large'; }   // missing stops the room (R-V19); the others → shape null
export interface BoardRead extends BoardCommitData {
  height: number;
  info: CommitInfo;                              // the board commit (boardShapeOk input)
  csPaths: Map<string, string[]>;                // the decoded Cowork-CS-Paths of the board commit (12 §9.7 item 2)
  live: LiveRead | LiveReadFailure | 'same' | null;   // the live commit it names (last parent); 'same' = the preceding item's (or opts.prevLive);
                                                      // null when opts.withLive is false
}
export interface BoardReadFailure { oid: Oid; height: number; malformed: BoardMalformedReason | 'missing'; }
export function isBoardReadFailure(r: BoardRead | BoardReadFailure): r is BoardReadFailure;
/** One `cat-file --batch-check` naming, per item, <oid>, <oid>:ops.jsonl, <oid>:protocol.json, <oid>:held, <oid>:checkpoint/state.json (height % 256 === 0
 *  only) and, with withLive, <oid>^2 (<oid>^1 at height 0); then one `cat-file --batch` of the distinct well-typed objects within the caps (a live
 *  commit only when its oid differs from the preceding item's). Every BoardCommitData field equals readBoardCommit(oid) except checkpoint (null off
 *  multiples of 256). Over-cap, mistyped or missing objects are reported per item and never read. items.length > READ_BATCH_MAX → RangeError. */
export function readBoardCommits(git: BatchGit, items: ReadonlyArray<{ oid: Oid; height: number }>, opts?: { withLive?: boolean; prevLive?: Oid | null }): Promise<Array<BoardRead | BoardReadFailure>>;
/** Commit objects only, never a tree: one --batch-check, one --batch (≤ READ_BATCH_MAX oids). */
export function readLiveCommits(git: BatchGit, oids: readonly Oid[]): Promise<Array<LiveRead | LiveReadFailure>>;
/** The commit-object parse (tree and parent header lines, message through parseMessage); equals GitRepo.readCommit (tested). */
export function parseCommitObject(oid: Oid, body: Buffer): CommitInfo;
// Landed forms that supersede the three declarations above (ledger R-V69, R-V74 contract amendments; ratified by F-8a-6, 2026-10-08) — what Tasks 6–8,
// 16 and F04-a consume:
//   export interface BatchReads<T> { reads: T[]; next: number; }   // the fitting prefix; callers loop on `next` (and pass prevLive across rounds)
//   readBoardCommits(…): Promise<BatchReads<BoardRead | BoardReadFailure>>; readLiveCommits(…): Promise<BatchReads<LiveRead | LiveReadFailure>>;
//     each `--batch` ≤ 32 MiB; the batch-check also names <oid>^{tree} and <oid>:checkpoint; a failing round is re-checked item by item (R-V74)
//   LiveReadFailure.malformed and BoardReadFailure.malformed also take 'unreadable' (a git-fatal item); an unparseable held/ tree gives heldIds [].

// src/git/runner.ts — killTree only (12 §9.7 item 5): on win32 it spawns win32.join(<SystemRoot>, 'System32', 'taskkill.exe') with
// ['/PID', String(pid), '/T', '/F'], shell false, windowsHide true, stdio 'ignore', cwd <SystemRoot>; SystemRoot is read case-insensitively from
// deps.daemonEnv and must be absolute, else only child.kill('SIGKILL'). No bare executable name is ever spawned. Signatures unchanged.
```

### Text and strings (first versions of the shared modules)

```ts
// src/text/sanitize.ts (SEC-34; later plans extend it, never change these signatures)
export type SanitizeChannel = 'claude' | 'deny' | 'terminal' | 'notification' | 'log' | 'viz';
/** NFC; strip C0/C1 controls (keep \n only in 'claude'), ANSI CSI and OSC (incl. OSC 8 and OSC 52), bidi U+061C, U+202A–U+202E, U+2066–U+2069,
 *  zero-width/format U+200B–U+200F, U+2060–U+2064, U+FEFF, tags U+E0000–U+E007F, lone surrogates; '<' '>' → U+FF1C U+FF1E; URLs → '[link removed]';
 *  leading '/' command tokens removed at the start of every line; in 'notification' and 'viz' every line break (\n, \r, U+0085, U+2028, U+2029) →
 *  one space and every run of ≥ 3 dash-like characters → '—'. Idempotent and total. */
export function sanitize(text: string, channel: SanitizeChannel): string;
export type CapKind = 'name' | 'label' | 'path' | 'note' | 'branch' | 'room' | 'card' | 'tooltip' | 'plaque' | 'caption' | 'version';
                                                   // X-88 (2026-10-08): Plan 7 appends 'sym' and 'notif' with their VIZ_CAPS and VIZ_RAW_UNITS entries
export const VIZ_CAPS: Readonly<Record<CapKind, number>>;   // name 20, label 80, path 80, note 280, branch 80, room 40, card 400, tooltip 200, plaque 16, caption 120, version 20
export const VIZ_RAW_UNITS: Readonly<Record<CapKind, number>>;   // 4 × VIZ_CAPS (name: NAME_RAW_MAX) UTF-16 code units (R-V50)
export const NAME_RAW_MAX = 64;
export const MARKS_PER_GRAPHEME_MAX = 4;
/** R-V50: first cut to VIZ_RAW_UNITS[kind] code units at a grapheme boundary and drop combining marks beyond 4 per grapheme; then cap the
 *  user-perceived characters (Intl.Segmenter graphemes): middle ellipsis for path, plaque and label, end ellipsis otherwise. */
export function cap(text: string, kind: CapKind): string;

// src/i18n/render.ts (10-product §3.2; first version)
export type Lang = 'en' | 'ko' | 'zh-CN' | 'ja' | 'fr' | 'es';
export const LANGS: readonly Lang[];
export type RenderChannel = 'terminal' | 'slash' | 'systemMessage' | 'notification' | 'json' | 'log' | 'viz';
export type ParamType = 'name' | 'path' | 'label' | 'id' | 'n' | 'dur' | 'cmd' | 'reason' | 'note' | 'code' | 'text' | 'url';
                                                   // X-97 (2026-10-08): appended in place — Plan 7 'sym', 'oid', 'hostmsg'; 8b 'int', 'count' (no second alias);
                                                   // render misses reach a log only through setMissObserver(f), added by whichever of Plan 7 Task 2 / 8b Task 7
                                                   // lands first; render.ts stays I/O-free (it is in the R-V35 client program)
export interface CatalogEntry { text: string; params?: Readonly<Record<string, ParamType>>; plural?: string; forms?: Readonly<Partial<Record<Intl.LDMLPluralRule, string>>>; }
export type Catalog = Readonly<Record<string, CatalogEntry>>;
export type Params = Readonly<Record<string, string | number | null>>;
export const CHANNEL_CAPS: Readonly<Record<RenderChannel, number | null>>;   // slash 4,000; systemMessage 1,050; notification 120; viz 400; others null
/** Merged per language; registering a code again with an identical entry is a no-op, with a different entry throws (cli.js registers EN_VIZ_CLI,
 *  viz.js EN_VIZ, which contains the same CLI entries). */
export function registerCatalog(lang: Lang, entries: Catalog): void;
/** The codes a `reason` parameter may nest (R-V43); throws on a code prefixed UI_, RF_, SEC_, VIZ_, PH_, SS_ or START_. */
export function registerReasonCodes(codes: Iterable<string>): void;
/** Step 1 catalog[lang][code] ?? catalog.en[code] (a miss → UI_INTERNAL_ERROR text, logged once); step 2 each placeholder sanitized for the
 *  channel's sanitize channel and capped by its type; n → Intl.NumberFormat(lang); dur → UI_DUR_S | UI_DUR_MIN | UI_DUR_H with Intl.PluralRules(lang);
 *  reason → nested render (depth ≤ 1) only when the value is a registered reason code, else '?'; url → kept only on the terminal channel and only
 *  when it matches the launch-URL shape ^http://127\.0\.0\.1:[1-9][0-9]{0,4}/#k=[0-9a-f]{64}$ (URL_RE's expression), else '[link removed]' (only
 *  UI_VIZ_URL declares a url param, tested); cmd copied from the fixed command table; step 3 plural form; step 4 over the channel cap
 *  → UI_TEXT_TOO_LONG, except the viz channel, which end-ellipsizes to 400 graphemes (R-V53). */
export function render(code: string, params: Params, channel: RenderChannel, lang: Lang): string;
/** The page's form: the same pipeline over catalogs fetched from /api/v1/strings and the reason set the client bundles (REASON_CODES). */
export function renderWith(catalogs: Partial<Record<Lang, Catalog>>, reasons: ReadonlySet<string>, code: string, params: Params, channel: RenderChannel, lang: Lang): string;

// src/viz/i18n/codes.ts (imports nothing; in the client program)
export type CodeGroup = 'cli' | 'page' | 'scene' | 'icon' | 'card' | 'recording' | 'control' | 'log' | 'reused';
export const VIZ_CODES: Readonly<Record<CodeGroup, readonly string[]>>;   // exactly the 12 §3.11 table (UI_VIZ_DEMO_CAPTION_<n> listed as defined)
                                                                          // (rev 2.5: the 12 §9.9 rows stay out until their task moves them in;
                                                                          // Task 19 adds 'control' UI_VIZ_CTRL_FOLLOW and seven 'scene' codes, F32)
export const ALL_VIZ_CODES: ReadonlySet<string>;
export const DEMO_CAPTION_CODES: readonly string[];                        // UI_VIZ_DEMO_CAPTION_1 … _5 (the storyboard's)
export const PAGE_SUBSET_PREFIXES: readonly string[];                      // 'UI_VIZ_', 'PH_', 'SS_', 'UI_DUR_'
/** R-V43: closed sets for code-typed served fields; later plans extend them with the fold effect that posts a new code. */
export const FREEZE_REASON_CODES: ReadonlySet<string>;                     // EPOCH, MASS, PAUSED, INCIDENT, CONFIG, NOHOOKS (glossary §14)
export const HEALTH_REASON_CODES: ReadonlySet<string>;                     // HOST_THROTTLED (Plan 2), BOARD_FULL (PRO-06)
                                                                           // X-104: + HOLD_REVERT_HELD (P3); SEAT_FULL, SEAT_NO_MCP, HOOK_ONLY, DEGRADED,
                                                                           // SEAT_PULL_MODE, PEER_IDLE, LIVE_MARKER_RESTORED (P5); BASE_MOVE_CONFLICT,
                                                                           // BRANCH_ESCAPE (P7) — each in its producer's commit; SEC_REVIEW_ACCEPTED in no set
export const PUBLISH_PAUSE_CODES: ReadonlySet<string>;                     // OFFLINE, AUTH, NONRETRYABLE, VERSION
export const STATUS_STATES: ReadonlySet<string>;                           // ok, degraded, offline, frozen, incident, paused, refused, down
export const PH_CODES: ReadonlySet<string>;                                // the PH_* codes of 10-product §3.14
export const SS_CODES: ReadonlySet<string>;                                // the SS_* codes of 10-product §3.14
export const CHARACTER_BADGES: ReadonlySet<string>;                        // UI_VIZ_BADGE_VERSION, _RULES, _CREDIT, _HEALTH
export const REASON_CODES: ReadonlySet<string>;                            // FREEZE ∪ HEALTH ∪ PUBLISH_PAUSE
/** The /api/v1/strings subset: the codes with a PAGE_SUBSET_PREFIXES prefix, REASON_CODES and UI_INTERNAL_ERROR. */
export const PAGE_CODES: ReadonlySet<string>;

// src/viz/i18n/en.ts
export const EN_VIZ: Catalog;   // { ...EN_VIZ_CLI, … }: a template for every code of ALL_VIZ_CODES (recording codes included, for 8b) and of REASON_CODES,
                                // within the viz caps at worst-case params
                                // X-95 (2026-10-08): Plan 7 Task 2 makes the shared entries (PH_*, SS_*, UI_DUR_*, UI_INTERNAL_ERROR, RF_UNKNOWN_FLAG,
                                // START_TOOL_VERSION, the SEC_ trio, DR_CATALOG_MISS, the REASON_CODES templates) come from src/i18n/generated/shared.ts;
                                // Task 19 adds the eight F32 codes (en)

// src/viz/cli/strings.ts (R-V54; imports only the Catalog type)
export const EN_VIZ_CLI: Catalog;   // UI_VIZ_OPENED, UI_VIZ_URL, UI_VIZ_OPEN_FAILED, UI_VIZ_TERMINAL_ONLY, RF_VIZ_START_FAILED, RF_VIZ_BIND_FAILED,
                                    // RF_VIZ_NO_ROOMS, RF_VIZ_REPO_NOT_LIVE, RF_VIZ_DEMO_INVALID, RF_UNKNOWN_FLAG, START_TOOL_VERSION, UI_INTERNAL_ERROR
```

### World model (`src/viz/model/**`)

```ts
// src/viz/model/events.ts — 12 §3.3.7 verbatim except `owner` on pet_spawn/pet_poof (R-V47), plus the constants and helpers after the union
export type PeerRef = string;                          // peer_id (32 lowercase hex)
export type SeatRef = string;                          // seat key "<peer>/<epoch>/<seat_id>"
export type ActorRef = { peer: PeerRef } | { seat: SeatRef };
export type DeskRef = number;                          // desk ordinal (§3.5.3); 0 = the big table
export interface Position { height: number; sub: number; k: number; }
export type Line = { actor: ActorRef } | { claimId: string };
export type SceneEvent = Position & { seed: number } & (
  | { kind: 'room_open' }
  | { kind: 'room_sign'; sign: 'branch_moved' }
  | { kind: 'room_badge'; level: 'none' | 'near_full' | 'full' }
  | { kind: 'person_enter' | 'person_respawn' | 'person_exit' | 'person_thaw' | 'person_absent' | 'person_ghost' | 'person_unghost'; peer: PeerRef }
  | { kind: 'person_freeze'; peer: PeerRef; reasonCode: string }
  | { kind: 'person_slowed'; peer: PeerRef; until: number }
  | { kind: 'person_bang'; peer: PeerRef; bang: 'host' }
  | { kind: 'person_badge'; actor: ActorRef; badge: 'version' | 'rules' | 'credit' | 'health'; on: boolean; code: string | null }
  | { kind: 'pet_spawn' | 'pet_poof'; seat: SeatRef; owner: PeerRef }   // R-V47: the reducer never parses a seat id
  | { kind: 'pose_relaxed'; actor: ActorRef }
  | { kind: 'publish'; actor: ActorRef; target: DeskRef; others: DeskRef[]; paths: string[]; n: number;
      state: 'closed' | 'checkpoint'; checks: 'pass' | 'fail' | 'skipped'; origin: 'prompt' | 'wake' | 'human' }
  | { kind: 'conflict'; conflict: 'k4' | 'claim' | 'k7' | 'breach' | 'generic'; source: 'hold' | 'event';
      on: ActorRef; desk: DeskRef | null; holdId: string | null; cid: string | null; eventKind: string | null; line: Line | null }
  | { kind: 'box'; holdId: string; owner: ActorRef; holdKind: string; residence: string; state: string; offer: string;
      desk: DeskRef; localOnly: boolean; terminal: boolean }
  | { kind: 'claim_take' | 'claim_move'; claimId: string; seat: SeatRef; desk: DeskRef; order: number;
      label: { simple: string; qualname: string } | null; granularity: 'symbol' | 'block' | 'file'; lines: [number, number] | null; otherRules: boolean }
  | { kind: 'claim_stale'; claimId: string }
  | { kind: 'claim_release'; claimId: string; reason: 'explicit' | 'answer' | 'save' | 'seat_end' | 'stop' | 'reservation_transfer' | 'superseded' }
  | { kind: 'claim_reserve'; claimId: string; request: string; requester: ActorRef }
  | { kind: 'grant_start' | 'grant_end'; claimId: string; grantee: ActorRef }
  | { kind: 'request_open'; request: string; from: ActorRef; holder: ActorRef; desk: DeskRef; requestKind: 'handoff' | 'go_first';
      estMinutes: number | null; attempt: number; note: string | null }
  | { kind: 'request_status'; request: string; holder: ActorRef;
      status: 'asked' | 'queued_until_turn_end' | 'awaiting_human' | 'undeliverable' | 'returned' }
  | { kind: 'answer'; request: string; holder: ActorRef; verb: 'accept' | 'grant' | 'decline' | 'later' | 'release'; by: 'claude' | 'human' | 'daemon'; note: string | null }
  | { kind: 'note'; actor: ActorRef; target: { request: string } | { claimId: string } | null; text: string }
  | { kind: 'save'; peer: PeerRef; desks: DeskRef[] }
);
export type SceneEventKind = SceneEvent['kind'];
export const SCENE_EVENT_KINDS: readonly SceneEventKind[];   // the closed set, in §3.4 order (pinned by a test)
export const SUB_ROOM = 0;                                     // op events use 1 + line index (1–1,000)
export const SUB_CODE = 1_001;
export const SUB_DERIVED = 1_002;
export function actorKey(a: ActorRef): string;               // 'p:<peer>' | 's:<seat>'; every actor-keyed Map uses it

// src/viz/model/scene.ts — 12 §3.3.7 verbatim, plus two ActorState fields and position-typed recency (R-V25) and the reducer
export type Place =
  | { at: 'home'; spot: number }
  | { at: 'chair' | 'stool' | 'beside'; desk: DeskRef }
  | { at: 'visitor'; desk: DeskRef; tile: number }
  | { at: 'facing'; actor: ActorRef; desk: DeskRef }
  | { at: 'behind'; peer: PeerRef };
export interface ActorState {
  place: Place; pose: 'idle' | 'sit' | 'relaxed';
  lastPublish: Position | null;                  // R-V25: the position of the actor's newest publish (spec: a height); compared with comparePos
  lastDesk: DeskRef | null;                      // R-V25: the target desk of the actor's newest publish (target-desk tie-break, chair recency)
  lastClaimOp: Position | null;                  // R-V25: the position of the newest claim op of a pet (character precedence 2); null for characters
}
export type CharacterState = ActorState & { ghost: boolean; absent: boolean; frozen: string | null; slowedUntil: number | null; rules: boolean; credit: boolean };
                                                 // frozen: the folded reason code (the projection maps an out-of-set one to '?', R-V43)
export type PetState = ActorState & { owner: PeerRef; variant: number; live: boolean; ssCode: string | null };   // owner from pet_spawn (R-V47)
export interface DeskState { lastEvent: number | null; chair: ActorRef | null; visitors: ActorRef[]; more: number; claims: string[] }
export interface ClaimState { seat: SeatRef; desk: DeskRef; order: number; label: { simple: string; qualname: string } | null;
                              granularity: 'symbol' | 'block' | 'file'; lines: [number, number] | null; stale: boolean;
                              reservedFor: string | null; grantee: ActorRef | null; otherRules: boolean }
                              // R-V73 (landed in Task 5; ratified, F-8a-6): ClaimState also carries `at: Position` (the position of the claim's newest
                              // claim_take/claim_move); Task 9 serves it as `at: Pos` in SceneVM.claims and Task 13's unprojection rebuilds it
export interface Scene {
  at: Position;
  badge: 'none' | 'near_full' | 'full';
  branchMovedAt: number | null;
  characters: Map<PeerRef, CharacterState>;
  pets: Map<SeatRef, PetState>;
  desks: Map<DeskRef, DeskState>;                // sparse (no entry = all defaults)
  claims: Map<string, ClaimState>;
  requests: Map<string, { from: ActorRef; holder: ActorRef; desk: DeskRef; status: string | null }>;
  boxes: Map<string, { owner: ActorRef; desk: DeskRef; holdKind: string; residence: string; state: string; localOnly: boolean }>;
  bangs: Map<string, { on: ActorRef; desk: DeskRef | null }>;
  beat: SceneEvent[];
}
/** Declared structurally (not Pick<Timeline, …>): scene.ts is in the client program and may not reach timeline.ts, which type-imports FoldState. */
export interface TimelineView { segments: Array<{ hs: number; start: Scene }>; events: SceneEvent[]; layout: Layout; }
export const SIGN_HEIGHTS = 64;
export const RELAX_HEIGHTS = 64;
export const DIM_HEIGHTS = 256;
export function comparePos(a: Position, b: Position): number;          // lexicographic (height, sub, k)
export function emptyScene(at: Position): Scene;
/** One event onto a copy of s (pure): moves actors by placement.ts, recomputes the touched desks' chairs and visitors, keeps persistent "!" only for
 *  non-terminal hold records, ends nothing by timer except slowedUntil and the branch sign, which are read relative to at; a new height clears beat. */
export function applyEvent(s: Scene, e: SceneEvent, layout: Layout): Scene;
/** The incremental form used by the timeline builder, the stores and the page's seek cache (same results as applyEvent). */
export class SceneReducer {
  constructor(start: Scene, layout: () => Layout);
  push(e: SceneEvent): void;                     // events in position order; an out-of-order event throws
  scene(): Scene;                                // a deep copy
}
/** 12 §3.3.5: the start scene of the segment with the greatest hs < at.height (the first segment when none), then that segment's events ≤ at. */
export function reduceScene(t: TimelineView, at: Position): Scene;
export function deskDimmed(s: Scene, d: DeskRef): boolean;             // no event for DIM_HEIGHTS heights before s.at.height
export function signVisible(s: Scene): boolean;                         // at.height − branchMovedAt < SIGN_HEIGHTS
export function isSlowed(c: CharacterState, at: Position): boolean;    // slowedUntil !== null && at.height < slowedUntil

// src/viz/model/layout.ts — Zone, Desk, Layout of 12 §3.3.7 verbatim, plus:
export interface Zone { index: number; key: string; cells: number[]; }
export interface Desk { ordinal: number; key: string; kind: 'big_table' | 'file' | 'folder' | 'shelf';
                        zone: number | null; cell: number | null; slot: number | null; path: string | null; lockbox: boolean;
                        first: number; }                // R-V51: the height that first touched it (0 for the big table; hs for start-state claim paths)
export interface Layout { version: number; zones: Zone[]; desks: Desk[]; homeOrder: PeerRef[]; deskOf: ReadonlyMap<string, DeskRef>; }   // ruling R-V57: version is +1 per new desk, per new cell AND per new home entry, so a home-only delta is a real version step (R-V49) — spec-edit-list entry for 12 §3.3.7
export interface LayoutDelta { fromVersion: number; version: number; zones: Zone[]; desks: Desk[]; homeOrder: PeerRef[]; }   // zones: new or grown; desks and homeOrder: new only
export interface Tile { x: number; y: number; }
export const TILE_PX = 16, GRID_COLS = 3, CELL_W = 7, CELL_H = 10, LOBBY_H = 4, OFFICE_W = 21, HOME_SPOTS = 16;
export const ZONES_MAX = 15, CELLS_PER_ZONE = 4, SLOTS_PER_CELL = 6, FILE_DESKS_PER_ZONE = 23, VISITOR_TILES = 4;
export const OVERFLOW_ZONE = '…', ROOT_ZONE = '·', BIG_TABLE_KEY = '⌂';
export const BIG_TABLE: DeskRef = 0;
export const DOOR: Tile;                                                // (1, 0)
export function emptyLayout(): Layout;                                  // version 0, desks = [the big table], no zones, no home entries
export function zoneOf(p: string): string;                              // s1/s2 (≥ 3 segments), s1 (2), '·' (root file)
                                                                        // X-76: F04-a turns it into a re-export of zone() from src/data/zone.ts (same results)
export class LayoutFrozenError extends Error {}
/** Append-only §3.5.3 allocation; never moves or removes a desk; version +1 per desk or grid cell added. */
export class LayoutBuilder {
  constructor(base: Layout);
  desk(path: string, h: number): DeskRef;         // the desk of a desk-eligible path, allocated on first touch at height h (Desk.first = h)
  has(path: string): boolean;
  home(peer: PeerRef): void;                      // appends to homeOrder when absent
  freeze(): void;                                 // later allocation throws LayoutFrozenError (re-fold of a retained range)
  layout(): Layout;                               // a snapshot (new arrays, new Map)
  takeDelta(): LayoutDelta | null;                // the additions since the previous takeDelta
}
export function applyLayoutDelta(l: Layout, d: LayoutDelta): Layout;   // the page's form; d.fromVersion !== l.version throws
export function officeTiles(l: Layout): { w: number; h: number };       // w = 21, h = 4 + 10·⌈cells / 3⌉
export function homeTile(spot: number): Tile;                           // < 16: (2 + 2·(i mod 8), 1 + ⌊i / 8⌋); ≥ 16: the door cluster, round-robin
export function cellOrigin(g: number): Tile;                            // (7·(g mod 3), 4 + 10·⌊g / 3⌋)
export function slotOrigin(g: number, s: number): Tile;                 // cell origin + (3·(s mod 2), 1 + 3·⌊s / 2⌋)
export function deskTiles(l: Layout, d: DeskRef): { desk: Tile[]; chair: Tile; visitors: Tile[] };
export function isBlocked(l: Layout, t: Tile): boolean;                 // lobby wall (row 0 but the door), desk and big-table tiles, outside the office
export function plaqueOf(d: Desk): string | null;                       // file: basename; folder: its folder; shelf and big table: null
export function isDashed(d: Desk, at: Position | null): boolean;        // R-V51: at !== null && d.first > at.height (rewinding keeps the head layout)

// src/viz/model/looks.ts (12 §3.6; server only: node:crypto)
export type LookTable = ReadonlyMap<PeerRef, { hue: number; accessory: number }>;
export const HUE_COUNT = 7, ACCESSORY_COUNT = 8, LOOK_COUNT = 56;
export function lookOf(peer: PeerRef): { hue: number; accessory: number };   // n = sha256(utf8(peer) ‖ 0x00 ‖ utf8("viz-look")).readUInt32BE(0) (R-V20)
export function lookTable(peers: Iterable<PeerRef>): LookTable;

// src/viz/model/placement.ts (12 §3.5.4; pure, shared with the page)
/** desks: the desk of each path (repeats allowed). Target: most paths; ties → lastDesk; then the lexicographically first desk key. Others ascending. */
export function targetDesk(desks: readonly DeskRef[], layout: Layout, lastDesk: DeskRef | null): { target: DeskRef; others: DeskRef[] };
export function homeSpot(layout: Layout, peer: PeerRef): number;          // index in homeOrder
export function characterPlace(s: Scene, peer: PeerRef, layout: Layout): Place;   // precedence 1–4
export function petPlace(s: Scene, seat: SeatRef, layout: Layout): Place;         // open request > newest HELD claim chair > granted stool > newest CS target > behind
/** Newest HELD claim holder, else most recent publisher; other claim holders first, then publishers by recency; beyond 4 visitors → more. */
export function seatDesk(s: Scene, d: DeskRef): { chair: ActorRef | null; visitors: ActorRef[]; more: number };

// src/viz/model/labels.ts (R-V56; pure, shared with the page; Task 5 — so Task 9's projection and Task 13's page logic both import it)
/** left → PH_LEFT; absent → PH_PRESUMED_ABSENT; frozen PAUSED → PH_PAUSED, NOHOOKS → PH_NOT_COORDINATED, any other reason or '?' → PH_FROZEN; slowed at `at`
 *  → PH_SLOWED; ghost → null; else PH_OK; never PH_OFFLINE (10-product §3.14 precedence; 12 §1.5 item 5). */
export function phOf(c: CharacterState | undefined, status: 'active' | 'left' | 'absent', at: Position): string | null;
export type PlaceLabel = { code: 'UI_VIZ_HOLDING'; label: string | null } | { code: 'UI_VIZ_LAST_SHARED_HERE'; path: string | null; height: number };
/** VIZ-17: HOLDING when the actor holds a HELD claim at its desk, else LAST_SHARED_HERE for the desk of its newest publish; null when not seated. */
export function placeLabel(s: Scene, actor: ActorRef, layout: Layout): PlaceLabel | null;

// src/viz/model/cards.ts — Card of 12 §3.3.7 verbatim, plus:
export interface Card {
  id: string; at: Position; group: 'conversation' | 'activity' | 'conflict' | 'system'; code: string;
  actor: ActorRef | null; target: ActorRef | null; paths: string[]; n: number; desks: DeskRef[];
  displayId: string | null; parent: string | null; label: string | null; text: string | null; detail: string | null;
}
/** The §3.4 row an event came from (the builder knows it; an event alone does not always tell, e.g. pet_spawn from seat_start vs a footprint). */
export type SceneRow =                                                       // join_back: R-V42; rules_change: a step-6 switch with no join (R-V45)
  | 'genesis' | 'join_new' | 'join_back' | 'join_epoch' | 'join_version' | 'join_rules' | 'rules_change' | 'join_credit' | 'leave' | 'seat_start' | 'seat_footprint' | 'seat_end'
  | 'publish_cs' | 'publish_big' | 'publish_nocs' | 'base_move' | 'freeze' | 'unfreeze' | 'slowed' | 'board_full' | 'health_other' | 'nonretryable'
  | 'hold_k4' | 'hold_claim' | 'hold_t0' | 'hold_breach' | 'hold_other' | 'event_breach' | 'event_k' | 'claim_new' | 'claim_reanchor' | 'claim_stale'
  | 'release' | 'reserve' | 'grant' | 'request' | 'request_status' | 'answer' | 'note' | 'presume_absent' | 'save' | 'ghost' | 'relaxed';
export const CARD_GROUP: Readonly<Record<string, Card['group']>>;          // every UI_VIZ_CARD_* code → its group
/** The §3.4 Card column: null for uncarded rows and for the secondary events of a row (pet_poof/claim_release of a respawn, …);
 *  request_status → null (a chip); person_badge{rules} carded only when on; room_badge carded only on entering 'full'. */
export function cardFor(e: SceneEvent, row: SceneRow): Card | null;

// src/viz/model/frame.ts — Frame of 12 §3.3.4 verbatim, plus three transient fields and the one BoardDraft builder (server only)
export interface Frame {
  height: number;
  oid: string;                                    // transient (demo: synthesized)
  writer: { peer: string; epoch: string; seq: number } | null;
  cs: CsTrailer[];
  csPaths: ReadonlyMap<string, readonly string[]>;
  code: FrameCode;
  ops: Array<{ line: number; type: string; op: Json | null; verdict: 'effective' | 'unfolded' | 'rejected' }>;
  before: FoldState; after: FoldState;
  protoMismatch: boolean;                         // the fold's protoMismatch (UI_VIZ_NEWER_PROTOCOL)
  checkpoint: 'match' | 'mismatch' | null;        // PRO-28 byte compare at heights % 256 === 0 when the commit carries one
                                                  // X-92 as chosen by the owner (Task 6 amendment): any difference is 'mismatch' and the viewer
                                                  // keeps its own fold — no re-seed; claims fold in real time once Task 20 passes inputs on every frame
  malformed: boolean;                             // R-V19: a no-op draft standing in for an unreadable board commit
}
export interface FrameCode {
  changed: boolean;                               // liveCode ≠ the previous board commit's liveCode; false at height 0
  shape: 'genesis' | 'ordinary' | 'base_move' | null;   // liveShape(live commit, previous liveCode) when changed, 'genesis' at height 0; null = malformed
  seats: string[];                                // Cowork-Seat values
  base: string | null;                            // Cowork-Base
}
/** R-V02, V17: every BoardDraft 8a builds (git source, demo source, tests) goes through these two, so a later BoardDraft change has one call site. */
export function toDraft(o: { liveCode: string; writer: WriterId | null; cs: readonly CsTrailer[]; protocol: ProtocolJson; opsLines: readonly string[];
                             checkpoint: Buffer | null; heldIds: readonly string[] }): BoardDraft;
export function noopDraft(prev: Pick<BoardDraft, 'protocol' | 'liveCode'>): BoardDraft;   // R-V19: writer null, no ops, no trailers, heldIds [], checkpoint null
export interface FrameInput { height: number; oid: string; draft: BoardDraft; csPaths: ReadonlyMap<string, readonly string[]>; code: FrameCode; malformed: boolean; }
/** foldCommit(prev, draft, self); ops from opVerdicts with op = parseOpLine(line) for parsed lines; checkpoint compared byte for byte with serializeFold. */
export function foldFrame(prev: FoldState, x: FrameInput, self: PeerId): Frame;
// Task 20 (owner choice of 2026-10-08): FrameInput gains `claimInputs: ClaimFoldInputs`, which foldFrame passes as foldCommit's fourth argument on every frame (§Sources, "Task 20 additions").
export const ZERO_PEER = '00000000000000000000000000000000';

// src/viz/model/start.ts (12 §3.3.5; server only)
/** The start scene of a segment at hs from fold state s (initialFoldState → an empty scene). Reads only s, the start peers' home spots in layout and the
 *  desks of HELD and STALE claims in s (empty in Plan 2). Characters: PeerRec.status active or absent; ghost = in liveSet(s) and not in rankedSet(s);
 *  frozen when the peer's newest freeze/unfreeze event is a freeze (its reason_code); slowed until h + 180 for a HOST_THROTTLED health event at h with
 *  h + 180 > hs; rules when regionSpec ≠ teamRegionSpec; credit when coauthor_optin ≠ false. Pets: seats live in s whose owner is drawn, variants in
 *  sorted seat-key order. Badge from record_count only. Every actor placed with no publish history. beat = []. */
export function startScene(s: FoldState, hs: number, layout: Layout): Scene;
/** R-V47: the peer segment of a board seat key "<peer>/<epoch>/<seat_id>"; server only (the page never parses a seat id). Used by startScene for start-state
 *  pets and by the timeline builder (timeline.ts imports it from here) for pet_spawn/pet_poof owners. */
export function ownerOfSeatKey(seat: SeatRef): PeerRef;

// src/viz/model/timeline.ts (12 §3.3.5; server only)
export interface WindowInput { h0: number; start: FoldState; frames: Iterable<Frame>; layout?: Layout; }   // layout: R-V21 only (default emptyLayout())
export interface Timeline extends TimelineView {     // = 12 §3.3.5's Timeline: h0, h1, segments, events, layout, looks, cards
  h0: number; h1: number;
  segments: Array<{ hs: number; start: Scene }>;
  events: SceneEvent[];
  layout: Layout;
  looks: LookTable;
  cards: Card[];
}
/** The builder's carry state: the reduced scene at the segment's last position and the desks published since the segment's last save. */
export interface Carry { scene: Scene; savedDesks: DeskRef[]; }
export interface FrameOutput { events: SceneEvent[]; cards: Card[]; layout: LayoutDelta | null; unknown: number; }
export class TimelineBuilder {
  /** A new segment at hs = h0 from `start`: the start peers (sorted) join homeOrder, then startScene. */
  static open(h0: number, start: FoldState, layout?: Layout): TimelineBuilder;
  /** Append-only continuation of t (carry recomputed from t's last segment). */
  static resume(t: Timeline): TimelineBuilder;
  /** Re-fold of a range the store dropped: from a kept checkpoint's carry, on a frozen copy of the head layout. */
  static replay(carry: Carry, layout: Layout): TimelineBuilder;
  push(f: Frame): FrameOutput;                   // steps 1–3 of §3.3.5 for one frame; f.height must be h1 + 1
  carry(): Carry;
  h1(): number;
  timeline(): Timeline;                           // a snapshot of everything pushed since open/resume
}
export function buildTimeline(w: WindowInput): Timeline;
/** extendTimeline(buildTimeline(w[0..k]), frames k+1..n) deep-equals buildTimeline(w[0..n]) (VIZ-10). */
export function extendTimeline(t: Timeline, frames: Iterable<Frame>): Timeline;
/** earlier.h0 = t.segments[0].hs − 256 (or 0); its frames run earlier.h0 + 1 … t.segments[0].hs (from 0 when earlier.h0 = 0); prepends one segment and
 *  appends the paths it first touches after every existing desk (§3.5.3). */
export function prependTimeline(t: Timeline, earlier: WindowInput): Timeline;
/** canonicalJson of t with every Map as ascending [key, value] pairs (UTF-16 code units), deskOf included. */
export function serializeTimeline(t: Timeline): string;
export function eventSeed(base: string, k: number): number;               // sha256(utf8(base ‖ ':' ‖ k)).readUInt32BE(0) (R-V20)
/** §3.5.4: <peer>/human/<n> → that peer's character, or the writer's when <peer> ≠ writer.peer; <seat_id>/<turn-seq> → the pet <writer.peer>/<writer.epoch>/<seat_id>. */
export function actorOfCs(csId: string, writer: WriterId): ActorRef | null;
export const BOARD_NEAR_FULL = 4_000, BOARD_FULL = 5_000, SLOWED_HEIGHTS = 180;
// X-91 (Task 6 amendment, 2026-10-08): the op → scene-event mapping is one table keyed by op type (and the code and derived rows beside it), so Plans
// 3–7 each add their rows in their own commit without editing the builder; X-92 (the owner chose real-time claims): no frame is re-seeded from a
// checkpoint; Task 20 passes claim inputs to foldFrame on every frame and Plan 4's 4-V claim rows draw from the viewer's own fold between checkpoints.
```

### Art (`src/viz/render/**`, pure, shared with the page)

```ts
// src/viz/render/palette.ts (12 §3.6)
export type Rgb = readonly [number, number, number];
export interface Lab { L: number; a: number; b: number; }
export const BODY_HUES: readonly Rgb[];                    // APRICOT #D97757, AMBER #E69F00, SKY #56B4E9, GREEN #009E73, LEMON #F0E442, BLUE #0072B2, PINK #CC79A7
export const HUE_NAMES: readonly string[];                 // 'APRICOT' … 'PINK' (UI_VIZ_ANON_NAME_* suffixes)
export const ACCESSORY_NAMES: readonly string[];           // 'BEANIE', 'HEADPHONES', 'SUNGLASSES', 'SCARF', 'SPROUT', 'CAP', 'BOW', 'GLASSES'
export const FIXED: Readonly<{ cheek: Rgb; eyeWhite: Rgb; pupil: Rgb; lens: Rgb }>;
export const ENV: Readonly<{ floorA: Rgb; floorB: Rgb; wall: Rgb; deskA: Rgb; deskB: Rgb; monitor: Rgb; screenIdle: Rgb; screenPublished: Rgb; accent: Rgb }>;
/** Main and alternate (a, A) pairs per accessory: beanie, headphones, sunglasses, scarf mains from option A; every other value chosen here. */
export const ACCESSORY_PAIRS: ReadonlyArray<{ main: readonly [Rgb, Rgb]; alt: readonly [Rgb, Rgb] }>;
export function mix(a: Rgb, b: Rgb, t: number): Rgb;       // per channel, rounded
export function srgbToLab(c: Rgb): Lab;                    // D65
export function labToSrgb(l: Lab): Rgb;
export function deltaE2000(x: Lab, y: Lab): number;
export function simulateCvd(c: Rgb, kind: 'protan' | 'deutan' | 'tritan'): Rgb;   // Machado et al. 2009, severity 1.0, in linear RGB
export interface CharacterColours { body: Rgb; highlight: Rgb; outline: Rgb; accessory: readonly [Rgb, Rgb]; }
export interface Palette { bodies: Rgb[]; characters: CharacterColours[][]; }   // characters[hue][accessory]
/** The §3.6 L* adjustment (steps of 1 within 55–80; lighter for the outline test, darker for eye white and cheek) then the accessory pair choice;
 *  throws when a hue has no passing L* (the build fails). Deterministic; evaluated once at module load as PALETTE. */
export function buildPalette(): Palette;
export const PALETTE: Palette;

// src/viz/render/sprites.ts (12 §3.6, §3.7)
export type SpriteMap = readonly string[];                 // equal-length rows; '.' transparent; keys o b h c w k f a A l
export const BASE: SpriteMap;                              // 16×16, option A verbatim
export type AccessoryName = 'beanie' | 'headphones' | 'sunglasses' | 'scarf' | 'sprout' | 'cap' | 'bow' | 'glasses';
export const ACCESSORIES: Readonly<Record<AccessoryName, ReadonlyMap<number, string>>>;   // row index → 16-char overlay; the first four verbatim
export const PET: SpriteMap;                               // 8×8
export const SEAT_VARIANTS: ReadonlyArray<SpriteMap | null>;   // 0 none, 1 sprout, 2 antenna, 3 star; ≥ 4 drawn as a DIGITS glyph
export const DIGITS: readonly SpriteMap[];                 // 3×5, 0–9
export type IconName = 'queued' | 'asked' | 'awaiting_human' | 'undeliverable' | 'accepted' | 'declined' | 'later' | 'daemon' | 'wake'
  | 'flag' | 'tick' | 'star' | 'snowflake' | 'door' | 'speech' | 'bang' | 'snail' | 'ice' | 'paused' | 'zzz' | 'parcel' | 'cart' | 'lockbox'
  | 'bin' | 'lock' | 'keyboard' | 'clipboard' | 'bolt' | 'version' | 'rules' | 'credit' | 'health' | 'plane' | 'sparkle' | 'confetti'
  | 'stamp' | 'sign' | 'cabinet' | 'more' | 'caught_up' | 'you' | 'think';
export const ICONS: Readonly<Record<IconName, SpriteMap>>; // 8×8 (clipboard and bolt 3×3); palette keys only, never a font glyph or emoji
export const TILES: Readonly<{ floorA: SpriteMap; floorB: SpriteMap; wall: SpriteMap; door: SpriteMap; desk: SpriteMap; monitor: SpriteMap;
                              chair: SpriteMap; bigTable: SpriteMap; signPlate: SpriteMap; plaque: SpriteMap; shelf: SpriteMap }>;
export type FrameName = 'idle0' | 'idle1' | 'squash' | 'rise' | 'peak' | 'land' | 'eyesClosed';
/** §3.7 edits of the base map: squash drops row 3 and moves rows 0–2 down one; eyes closed turns row 6 w/k into b and row 7 w/k into o; walk dy 0, −2, −3, −1. */
export function frameOf(f: FrameName): { map: SpriteMap; dy: number };
export function flipX(m: SpriteMap): SpriteMap;

// src/viz/render/raster.ts (12 §3.7; no DOM: tests hash the buffers)
export interface Rgba { readonly w: number; readonly h: number; readonly data: Uint8ClampedArray; }
export function rgba(w: number, h: number): Rgba;
export function blit(dst: Rgba, map: SpriteMap, colour: (key: string) => Rgb | null, x: number, y: number, flip?: boolean): void;
export interface StaticOptions { dashedFrom: number | null; dimmed: ReadonlySet<DeskRef>; coarse: boolean; lockboxDesks: ReadonlySet<DeskRef>; }   // dashedFrom: the
                                                 // scene height on a past scene (desks with isDashed drawn as dashed outlines), null live (R-V51)
/** Floor checker, walls, door, zone-sign plates, desks, monitors, plaque plates, big table — at art resolution (text is the page's fillText). */
export function composeStatic(layout: Layout, o: StaticOptions): Rgba;
export interface SpritePhase { reduced: boolean; frame(actor: string): FrameName; tile(actor: string): Tile; facingLeft(actor: string): boolean; screen(desk: DeskRef): 'idle' | 'published'; }
/** Characters, pets, badges and icons, z-sorted by foot y, then actorKey; looks by peer (or handle in the page). */
export function composeSprites(scene: Scene, layout: Layout, looks: ReadonlyMap<string, { hue: number; accessory: number }>, phase: SpritePhase): Rgba;
/** Where a Place stands (§3.5.2): home tile, chair, visitor tile, the tile facing a chair, one tile behind (below, else above) the character. */
export function placeTile(place: Place, layout: Layout, s: Scene): Tile;
```

### Sources (`src/viz/source/**`)

```ts
// src/viz/source/roomSource.ts
export interface TipInfo { height: number; key: string; }                 // key: the board oid (git) or `${room}:${height}` (demo)
export type Advance = { kind: 'none' } | { kind: 'ff'; to: TipInfo } | { kind: 'rewrite'; to: TipInfo } | { kind: 'gone' };
export interface RoomSpec {
  id: string;                                     // ^r[0-9A-HJKMNP-TV-Z]{8}$
  kind: 'git' | 'demo';
  label: string; branch: string;                  // raw; the projection sanitizes and caps them
  gitDir: string | null;                          // absolute realpath, never served
  boardRef: string | null;                        // refs/cowork-remote/<enc(b)>/board
  canonicalRoot: string | null;                   // glossary §24 default 12; dedupe and room id only, never served (X-63: a canonRoot value)
}
export interface RoomSource {
  readonly kind: 'git' | 'demo';
  /** The current tip, pinned: later frames()/startAt() calls of this tick read that oid, never the moving ref. null before genesis or when the ref vanished. */
  tip(): Promise<TipInfo | null>;
  /** git: a stat pair of the board ref's storage changed, or 60 s since the last rev-parse; demo: always false. */
  changed(): Promise<boolean>;
  /** Re-resolves and compares with the last folded tip (R-V31); pins the new tip. */
  advance(last: TipInfo): Promise<Advance>;
  /** initialFoldState(protocol of B0) at 0; parseFold(checkpoint at h) for h % 256 === 0 (git), or the demo's own fold state at h. */
  startAt(h: number): Promise<FoldState>;
  /** Frames of heights from…to (inclusive, oldest first) of the pinned tip, folded from `start` (the state at from − 1), batches ≤ 1,280. */
  frames(start: FoldState, from: number, to: number, self: PeerId): AsyncIterable<Frame>;
}
/** The local overlay of one room (12 §3.3.6), produced by status.ts's overlayOf; present only, never part of a timeline (VIZ-13). */
export interface Overlay {
  state: string; freezeReasons: string[]; publishPause: string | null; down: boolean; unreadable: boolean;
  offlineMin: number | null; holds: number; incoming: number; ready: number; you: PeerRef | null; versionSkew: boolean;
}
/** A demo caption record (12 §3.9.3); declared here (types only, Task 4) so the projection need not import demo.ts; demo.ts re-exports it. */
export interface DemoCaption { room: string; height: number; code: string | null; text: string | null; }

// src/viz/source/vizGitArgv.ts (imports nothing; Task 1 — shared by VizGit at run time and by L-VIZ-GIT statically)
export const VIZ_GIT_SUBCOMMANDS: ReadonlySet<string>;   // cat-file, rev-parse, rev-list, for-each-ref, version, log, show, fetch, push, update-ref, gc,
                                                         // checkout: an array literal starting with one of these is a git argv for L-VIZ-GIT
/** Exactly the Global Constraints forms: version; rev-parse --verify -q <ref>; for-each-ref --format=%(objectname) %(refname) refs/cowork-remote/;
 *  rev-list --first-parent --count <oid>; rev-list --first-parent [--skip=<n>] --max-count=<n> <oid>; cat-file --batch-check; cat-file --batch —
 *  <ref> ^refs/cowork-remote/[^\s]+/board$, <oid> isOid, <n> ^(0|[1-9][0-9]{0,9})$, nothing else. The static check stands in `placeholder` for a value it
 *  cannot read: a template whose literal head is exactly `--skip=` or `--max-count=` with one substitution becomes that flag with the value
 *  `placeholder`, and any other non-literal element becomes `placeholder` itself; `placeholder` matches a positional slot or such a flag value only
 *  (<ref>, <oid>, <n>), never a flag name. */
export function vizGitArgvOk(args: readonly string[], placeholder?: string): boolean;

// src/viz/source/vizGit.ts (VIZ-07; R-V06, R-V09, R-V10; the git path comes from the CLI, R-V13)
export const VIZ_GIT_CONFIG: Readonly<Record<string, string>>;    // protocol.allow=never and protocol.{file,git,http,https,ssh}.allow=never
export const VIZ_GIT_ENV: Readonly<Record<string, string>>;       // GIT_NO_LAZY_FETCH=1
export const VIZ_GIT_WATCHDOG_MS = 120_000;
export class VizGitRefused extends Error {}
export interface VizGit extends BatchGit {
  readonly gitDir: string;
  version(): Promise<GitVersion>;                                  // git version
  revParse(ref: string): Promise<Oid | null>;                      // rev-parse --verify -q <ref>
  remoteRefs(): Promise<Array<{ ref: string; oid: Oid }>>;          // for-each-ref --format=%(objectname) %(refname) refs/cowork-remote/
  chainCount(tip: Oid): Promise<number>;                            // rev-list --first-parent --count <tip>
  chain(tip: Oid, skip: number, max: number): Promise<Oid[]>;       // rev-list --first-parent --skip=<n> --max-count=<n> <tip>, newest first
}
/** createGitRunner({ clock, hooksPath: join(dataDir, 'viz-no-hooks'), daemonEnv: { ...env, ...VIZ_GIT_ENV }, gitPath, watchdogOverrideMs: VIZ_GIT_WATCHDOG_MS });
 *  gitPath is ServeArgs.git (absolute, resolved by the CLI, R-V13); a relative value throws. */
export function vizGitRunner(o: { clock: Clock; dataDir: string; env: Record<string, string>; gitPath: string }): GitRunner;
/** Every call: class 'local', cwd dataDir, gitDir (absolute), config VIZ_GIT_CONFIG; vizGitArgvOk false throws VizGitRefused before spawning; rc ≠ 0 throws. */
export function createVizGit(o: { runner: GitRunner; gitDir: string; dataDir: string }): VizGit;

// Task 20 additions (owner choice of 2026-10-08, X-92 decided; 12 §3.3.3) — none of these exists before Task 20, which needs Plan 4 Task 8's names:
// src/viz/source/vizGitArgv.ts: vizGitArgvOk also accepts `merge-base --is-ancestor <oid> <oid>` (both isOid, nothing else); VIZ_GIT_SUBCOMMANDS gains merge-base.
// src/viz/source/vizGit.ts: VizGit gains
//   isAncestor(a: Oid, b: Oid): Promise<boolean | 'missing'>;      // merge-base --is-ancestor <a> <b>: rc 0 → true, rc 1 → false, otherwise 'missing'
// src/viz/source/claimInputs.ts — imports types of src/board/fold.ts, src/claims/overlapPairs.ts (overlapPairsOf), src/regions/foldOverlap.ts
// (foldOverlap) and Plan 4 Task 3's lineArray; no worker pool, region service, cache or grammar runtime.
export const CLAIM_READ_MAX_BYTES = 32 * 1024 * 1024;   // one claim-input `cat-file --batch` call's output budget (R-V69's figure); a larger blob is read alone
export const CLAIMS_RETRY_MS = 30_000;
/** 12 §3.3.3: for one board commit, one `cat-file --batch` naming `<commit>:<path>` per needed tree entry and the anchor blobs the pairs need (never
 *  --filters or --textconv), VizGit.isAncestor per tombstone anchor (memoized per room for the viewer run: two oids and a boolean), the pairs of
 *  overlapPairsOf, and foldOverlap over lineArray in process. The bytes and line arrays live only inside this call; the result holds oids, 'ABSENT' and
 *  booleans. Empty needs → no git call. null = a named object missing or unreadable: the caller folds nothing at or after this commit. */
export function readClaimInputs(git: VizGit, prev: FoldState, draft: BoardDraft, needs: ClaimFoldNeeds, memo: Map<string, boolean>): Promise<ClaimFoldInputs | null>;
/** 12 §3.9.3 `claims`: a demo record's answers; an unanswered tree question → 'ABSENT', an unanswered pair → true (fails closed); null → the empty table. */
export function demoClaimInputs(rec: DemoClaims | null): ClaimFoldInputs;
/** The answers `inputs` gives to exactly the questions `needs` names (export-demo's `claims`); oids, 'ABSENT', ids and booleans only. */
export function recordClaimInputs(needs: ClaimFoldNeeds, inputs: ClaimFoldInputs): DemoClaims;
/** Thrown by GitRoomSource.frames() after it has yielded every frame before the commit whose claim inputs read null. */
export class ClaimsPendingError extends Error { readonly height: number; readonly oid: Oid | null; }
// src/viz/model/frame.ts: FrameInput gains `claimInputs: ClaimFoldInputs`; foldFrame passes it as foldCommit's fourth argument on every frame (Plan 4 R4-26:
//   without inputs the fold skips every claim effect, so a commit without claim ops gets inputs too, which are never asked).
// src/viz/source/git.ts: frames() computes claimFoldNeeds(prev, draft) and calls readClaimInputs before each foldFrame; on null it throws
//   ClaimsPendingError {height, oid} after the frames before that commit.
// src/viz/source/demo.ts: DemoRoomSource folds each draft with demoClaimInputs(commit.claims).
// src/viz/server/models.ts: RoomBadge gains 'UI_VIZ_CLAIMS_PENDING'; RoomStore keeps { height, oid, lastTryMono } while pending and retries on a stat-pair
//   change or after CLAIMS_RETRY_MS; a page or "load earlier" fold that meets it answers 404 {"code":"UI_VIZ_CLAIMS_PENDING"} (src/viz/server/api.ts).

// src/viz/source/boundedRead.ts (R-V30; the second viz file allowed node:fs)
export interface BoundedReader { read(path: string, max: number): Promise<Buffer | 'not_file' | 'too_large' | null>; }   // null: ENOENT
/** open(O_RDONLY | O_NOFOLLOW | O_NONBLOCK where defined; else an lstat just before must not report a symlink), fstat().isFile() else 'not_file',
 *  read ≤ max + 1 bytes ('too_large' when the extra byte arrives), close in finally; EPERM/EACCES/EBUSY propagate (the caller keeps its previous read). */
export const realBoundedReader: BoundedReader;
/** Over the Fs port (lstat regular file, then one readFile): the FaultFs form for rename-over and share-none tests. */
export function fsBoundedReader(fs: Fs): BoundedReader;

// src/viz/source/git.ts (12 §3.3.1–§3.3.4, §3.9.2)
export interface StatPair { size: number; mtimeNs: bigint; }
export const REVPARSE_SAFETY_MS = 60_000;
export class GitRoomSource implements RoomSource {
  constructor(spec: RoomSpec, git: VizGit, deps: { fs: Fs; clock: Clock });
  readonly kind: 'git';
  /** (size, mtime) of <gitdir>/refs/cowork-remote/<e>/board, <gitdir>/packed-refs and, when <gitdir>/reftable/ exists, reftable/tables.list. */
  statPairs(): Promise<Array<StatPair | null>>;
  // + the RoomSource members
}

// src/viz/source/demo.ts (12 §3.9.3; VIZ-27)
export const DEMO_FORMAT = 'cowork-viz-demo/1';
export const DEMO_MAX_BYTES = 4 * 1024 * 1024, BUNDLED_DEMO_MAX_BYTES = 64 * 1024, CAPTION_TEXT_MAX = 120;
export interface DemoRoomHeader { room: string; name: string; branch: string; }
/** owner choice of 2026-10-08 (12 §3.9.3 `claims`): the recorded answers of one commit's claim fold — oids, 'ABSENT', ids and booleans only. */
export interface DemoClaims { readonly trees: ReadonlyArray<readonly [string, string, string]>; readonly pairs: ReadonlyArray<readonly [string, string, boolean]>; }
export interface DemoCommit {
  room: string; height: number; writer: string | null; protocol: ProtocolJson | null;
  code: { changed: boolean; seats: string[]; base: string | null };
  cs: string[]; csPaths: Map<string, string[]>; ops: string[]; held: string[];   // csPaths: a Map (board-derived keys, VIZ-37)
  live: string | null;                            // owner choice of 2026-10-08: a changed record's live commit oid (unchanged records inherit it)
  claims: DemoClaims | null;                      // owner choice of 2026-10-08: used from Task 20 (demoClaimInputs)
  line: number;                                   // 1-based line in the file (refusals)
}
export type { DemoCaption } from './roomSource.js';
export interface DemoLog { rooms: DemoRoomHeader[]; commits: Map<string, DemoCommit[]>; captions: DemoCaption[]; }
/** Strict: an unknown t or field, a rule of the §3.9.3 table broken, or a non-UTF-8 or CR or BOM byte → { line } of the first bad record (0 = file level). */
export function parseDemoLog(buf: Buffer, captionCodes: ReadonlySet<string>): DemoLog | { line: number };
export function serializeDemoLog(log: DemoLog): Buffer;           // LF, no BOM, fixed key order; parseDemoLog(serializeDemoLog(x)) deep-equals x
/** One BoundedReader read with max DEMO_MAX_BYTES (R-V30): not_file, too_large or absent → { line: 0 }. */
export function readDemoFile(path: string, reader: BoundedReader): Promise<Buffer | { line: 0 }>;
export function demoRoomId(salt: Uint8Array, room: string): string;   // 'r' + base32c(sha256(salt ‖ "demo:" ‖ room))[0:8]
/** Each commit → a BoardDraft through toDraft (writer through parseWriter, cs through parseCsTrailers of Cowork-CS trailers, opsLines = ops, checkpoint null,
 *  heldIds = held, protocol carried from height 0, liveCode = a changed record's live when present, else hex sha1("<room>:<height>:live") at 0 and when code.changed; from Task 20
 *  each draft is folded with demoClaimInputs(commit.claims)); oid = hex
 *  sha1("<room>:<height>:board"); code.changed false at 0; shape 'genesis' at 0, 'base_move' when base ≠ null, else 'ordinary'. No git call. */
export class DemoRoomSource implements RoomSource {
  constructor(room: DemoRoomHeader, commits: readonly DemoCommit[]);
  readonly kind: 'demo';
}

// src/viz/source/status.ts (12 §3.3.6; VIZ-13)
export const STATUS_MAX_BYTES = 1_048_576;
export interface StatusFields {
  state: string; freeze_reasons: string[]; publish_pause: string | null; branch: string; peer_id: string; plugin_version: string;
  heartbeat_mono_ms: number; loop_period_ms: number; last_fetch_age_ms: number | null;
  pending: { cs_ready: number; holds_active: number; incoming: number };
}
export interface StatusRead { present: boolean; unreadable: boolean; mtimeNs: bigint | null; fields: StatusFields | null; }   // fields: the last parsed values
/** Fs.lstat; unchanged mtime → prev; else one BoundedReader read with max STATUS_MAX_BYTES (one open-read-close): too_large or not_file → unreadable with
 *  the previous fields; JSON.parse, schema check of the used fields only (message_params and not_converged are never read); EPERM, EACCES, EBUSY or
 *  ENOENT during a replace → prev. A compile-time test pins every StatusFields member as assignable from Plan 2's StatusJson member (V19). */
export function readStatus(gitdir: string, prev: StatusRead | null, deps: { fs: Fs; reader: BoundedReader }): Promise<StatusRead>;
/** <gitdir>/cowork/peer: one BoundedReader read with max 4,096; 32 lowercase hex after trim, else null. */
export function readPeerFile(gitdir: string, reader: BoundedReader): Promise<PeerRef | null>;   // X-105: keeps this name (Plan 7's is readPeerId)
/** R-V46: the peer file's value, else the last parsed status.json peer_id when it matches ^[0-9a-f]{32}$, else null (self then uses ZERO_PEER). */
export function youOf(peerFile: PeerRef | null, s: StatusRead | null): PeerRef | null;
/** down: missing (R-V24) or machineMonoMs() − heartbeat_mono_ms > 3 × loop_period_ms of the last parsed fields; unreadable keeps the previous values and
 *  never makes down; offline age = last_fetch_age_ms + (machineMonoMs() − heartbeat_mono_ms), in whole minutes, when state is 'offline'. */
export function overlayOf(s: StatusRead, nowMachineMono: number, viewerVersion: string, you: PeerRef | null): Overlay;

// src/viz/source/rooms.ts (12 §3.3.1)
export const ROOMS_MAX = 32;
export function canonicalRoot(realGitDir: string, platform: NodeJS.Platform): string;   // lower-case drive letter, '/', NFC, lower-cased on win32 and darwin
// X-63 (F-8a-3, Task 7 amendment, 2026-10-08): Task 7 does not write canonicalRoot. rooms.ts imports canonRoot(p: string, probe: RootProbe,
// platform: NodeJS.Platform): string from src/data/canonRoot.ts (Plan 5 Task 1; RootProbe/realRootProbe in src/ports/fs.ts) and sets
// RoomSpec.canonicalRoot (the landed field name stays) to canonRoot(<the --repo main worktree>, probe, platform) — the string the `live` marker holds;
// discoverRooms's deps gain `probe: RootProbe` (realRootProbe in production, a fake in tests).
export function roomId(salt: Uint8Array, canonical: string): string;                     // 'r' + base32c(sha256(salt ‖ canonical))[0:8]
export function decodeEnc(e: string): string | null;                                     // inverse of enc(); null unless enc(result) === e
export type Discovery = { rooms: RoomSpec[]; more: number } | { refuse: 'RF_VIZ_REPO_NOT_LIVE' | 'RF_VIZ_NO_ROOMS' };
/** --repo only in 8a (paths arrive absolute and checked by the CLI, R-V54): lstat <path>/.git (a directory → realpath gitdir; a file or nothing → refuse); remoteRefs() keeps */board refs; one → it; several →
 *  the one whose decoded enc(b) equals status.json.branch, else refuse; dedupe by canonicalRoot; sort by (label, canonical root); first 32. */
export function discoverRooms(repos: readonly string[], deps: { fs: Fs; reader: BoundedReader; git: (gitDir: string) => VizGit; salt: Uint8Array; platform: NodeJS.Platform }): Promise<Discovery>;
```

### Server (`src/viz/server/**`)

```ts
// src/viz/server/models.ts — the pre-projection (model-typed) forms of the served payloads (12 §3.13 "(types)") and the api contract; types only (Task 4)
export interface Tick { h: number; glyph: 'publish' | 'conflict' | 'request' | 'save' | 'door' | 'freeze'; }   // viewModel.ts declares an identical Tick (it imports nothing)
export type RoomBadge = 'UI_VIZ_VERSION_SKEW' | 'UI_VIZ_NEWER_PROTOCOL' | 'UI_VIZ_CHECKPOINT_MISMATCH' | 'UI_VIZ_INCIDENT_FROZEN' | 'UI_VIZ_NO_BOARD';
export interface PeerInfo { display: string; pluginVersion: string; status: PeerRec['status']; }
export interface CardModel { card: Card; foldedAt: number | null; }   // foldedAt: the seen anchor of its height — tick()'s fast-forward folds only (R-V28)
export interface PetInfo { owner: PeerRef; live: boolean; ssCode: string | null; variant: number; }
export interface RoomDelta {
  roomId: string; kind: 'timeline' | 'snapshot'; window: { h0: number; h1: number };
  events: SceneEvent[]; cards: CardModel[]; ticks: Tick[]; layout: LayoutDelta | null;
  peers: Map<PeerRef, PeerInfo>; pets: Map<SeatRef, PetInfo>;     // new or changed only
  scene: Scene | null;                                              // snapshot only: the scene at the new tip
}                                                                   // RoomDelta and TimelinePageModel hold no overlay value (VIZ-13)
export interface TimelinePageModel { roomId: string; from: number; to: number; scene: Scene; events: SceneEvent[]; cards: CardModel[]; layout: LayoutDelta | null; }
export interface RoomSnapshotModel {
  spec: RoomSpec; window: { h0: number; h1: number }; gone: boolean; badges: RoomBadge[]; unknown: number;
  layout: Layout; looks: LookTable; peers: Map<PeerRef, PeerInfo>; pets: Map<SeatRef, PetInfo>;
  scene: Scene; cards: CardModel[]; ticks: Tick[]; overlay: Overlay | null;
}
/** What the api and the poll loop need of a room store (RoomStore implements it; Tasks 9 and 17 use fakes). */
export interface StoreLike {
  readonly ready: Promise<void>;
  snapshot(): RoomSnapshotModel;
  page(from: number, to: number): Promise<TimelinePageModel | null>;
  earlier(): Promise<TimelinePageModel | null>;
  tick(): Promise<{ delta: RoomDelta | null; overlay: Overlay | null; change: 'state' | 'rebuilt' | null }>;   // a fake returns three nulls
}
export interface PollSink { delta(d: RoomDelta): void; overlay(roomId: string, o: Overlay): void; roomChanged(roomId: string): void; reset(): void; }
/** The routes' data contract: implemented by api.ts (Task 9), consumed by http.ts (Task 10) and main.ts (Task 15). */
export interface WorldApi {
  world(): Promise<World>;                          // waits for every store's ready; recomputed at most once per 2.5 s whatever the number of tabs
  /** null → 404; from < h0 extends one segment (R-V29, the store's earlier()); when the page appended desks, publishes {type: 'layout', room_id, layout}
   *  on the hub before returning (R-V49). */
  page(roomId: string, from: number, to: number): Promise<TimelinePage | null>;
  strings(lang: string): Strings | null;            // the six codes → { lang: 'en', templates } of PAGE_CODES (R-V15); else null → 404
}

// src/viz/server/store.ts (12 §3.3.3, §3.9.1, §3.9.2; VIZ-09, VIZ-14, VIZ-15, VIZ-41)
export interface StoreDeps { clock: Clock; fs: Fs; reader: BoundedReader; log: VizLog; viewerVersion: string; machineMonoMs(): number; }
export const RETAIN_HEIGHTS = 2_048, PAGE_HEIGHTS = 256, SNAPSHOT_AFTER = 64, LAST_CARDS = 200;
export class RoomStore implements StoreLike {
  constructor(spec: RoomSpec, source: RoomSource, deps: StoreDeps);
  /** Window [h0, h1] for tip t (VIZ-09), start state, frames (checkpoints compared), TimelineBuilder; keeps at every checkpoint height the fold state, the
   *  carry and the scene; keeps ≤ 2,048 heights of events and cards and the ticks of the whole window. A missing board → UI_VIZ_NO_BOARD, empty room.
   *  self = youOf(peer file, status.json) or ZERO_PEER (R-V46). No seen anchor is created (R-V28). */
  init(): Promise<void>;
  readonly ready: Promise<void>;
  /** One poll step (§3.9.2): status re-read on mtime change; changed() → advance(); ff → fold and extend (> 64 commits → kind 'snapshot'), every height
   *  folded here gets a seen anchor in the window-wide anchor map (R-V28); a missing board or live object → UI_VIZ_NO_BOARD, nothing of the batch folded,
   *  retry next tick (R-V19); rewrite or status 'incident' → freeze (UI_VIZ_INCIDENT_FROZEN), nothing folded; after a non-incident state with a fresh
   *  heartbeat → rebuild from the tip on the current layout (R-V21), drop the anchor map, and change 'rebuilt' (the page gets reset). */
  tick(): Promise<{ delta: RoomDelta | null; overlay: Overlay | null; change: 'state' | 'rebuilt' | null }>;
  /** ≤ 256 heights, never across a segment start (to clipped); the page's scene is the segment's start scene when from − 1 is its hs, else the scene at
   *  the last position of from − 1 (12 §3.10.6); a dropped range is re-folded from the kept checkpoint ≤ from (≤ 255 folds), reuses the stored anchors and
   *  equals the events first served; from below h0 extends the window by exactly one segment per call through earlier() (R-V29); out of range → null. */
  page(from: number, to: number): Promise<TimelinePageModel | null>;
  /** "Load earlier": one segment of 256 below h0 (prependTimeline), its new desks as one layout delta; no seen anchor; null when h0 = 0. */
  earlier(): Promise<TimelinePageModel | null>;
  snapshot(): RoomSnapshotModel;
}

// src/viz/server/poll.ts (12 §3.9.2)
export const POLL_MS = 2_500;
/** Every 2.5 s (Δmono), the stores one at a time, at most one git child per room; never re-entrant. Returns stop(), which waits for the running tick. */
export function startPoll(stores: readonly StoreLike[], sink: PollSink, clock: Clock): () => Promise<void>;

// src/viz/server/viewModel.ts (Task 4; types only) — 12 §3.10.6 verbatim, with Projected written out (R-V26) and R-V22/R-V23/R-V25/R-V43/R-V47/R-V51
// applied; imports nothing (it is in the client program). Every named alias becomes a schema `pattern` (R-V27).
export type Handle = string;                    // ^[0-9a-f]{6,32}$ — a peer (6 unless extended by R-V22)
export type SeatHandle = string;                // ^[0-9A-HJKMNP-TV-Z]{6,32}$
export type ShortId = string;                   // ^[0-9A-Za-z]{8,32}$ — a hold or claim id prefix (R-V22)
export type RoomId = string;                    // ^r[0-9A-HJKMNP-TV-Z]{8}$
export type Code = string;                      // ^[A-Z][A-Z0-9_]{2,47}$ — a code in its field's closed set (R-V43)
export type ReasonVM = string;                  // ^([A-Z][A-Z0-9_]{2,47}|\?)$ — a closed-set code, or '?' for a non-nullable field out of its set (R-V43)
export type Cid = string;                       // ^[0-9A-HJKMNP-TV-Z]{8}$ — glossary §3 H(…)
export type ReqId = string;                     // ^R[0-9A-HJKMNP-TV-Z]{8}$ — a request display id
export type CardId = string;                    // "<height>.<sub>.<k>"
export type Hex64 = string;                     // ^[0-9a-f]{64}$
export type InstanceId = string;                // ^[0-9A-HJKMNP-TV-Z]{8}$
export type ActorVM = { peer: Handle } | { seat: SeatHandle };
export type Pos = [height: number, sub: number, k: number];
export type LineVM = { actor: ActorVM } | { claimId: ShortId };
export type EventVM = { at: Pos; seed: number } & (
  | { kind: 'room_open' } | { kind: 'room_sign'; sign: 'branch_moved' } | { kind: 'room_badge'; level: 'none' | 'near_full' | 'full' }
  | { kind: 'person_enter' | 'person_respawn' | 'person_exit' | 'person_thaw' | 'person_absent' | 'person_ghost' | 'person_unghost'; peer: Handle }
  | { kind: 'person_freeze'; peer: Handle; reasonCode: ReasonVM } | { kind: 'person_slowed'; peer: Handle; until: number }
  | { kind: 'person_bang'; peer: Handle; bang: 'host' }
  | { kind: 'person_badge'; actor: ActorVM; badge: 'version' | 'rules' | 'credit' | 'health'; on: boolean; code: Code | null }
  | { kind: 'pet_spawn' | 'pet_poof'; seat: SeatHandle; owner: Handle } | { kind: 'pose_relaxed'; actor: ActorVM }
  | { kind: 'publish'; actor: ActorVM; target: number; others: number[]; paths: string[]; n: number;     // paths: the R-V50 prefix; n unchanged
      state: 'closed' | 'checkpoint'; checks: 'pass' | 'fail' | 'skipped'; origin: 'prompt' | 'wake' | 'human' }
  | { kind: 'conflict'; conflict: 'k4' | 'claim' | 'k7' | 'breach' | 'generic'; source: 'hold' | 'event'; on: ActorVM; desk: number | null;
      holdId: ShortId | null; cid: Cid | null; eventKind: string | null; line: LineVM | null }
  | { kind: 'box'; holdId: ShortId; owner: ActorVM; holdKind: string; residence: string; state: string; offer: string; desk: number; localOnly: boolean; terminal: boolean }
  | { kind: 'claim_take' | 'claim_move'; claimId: ShortId; seat: SeatHandle; desk: number; order: number;
      label: { simple: string; qualname: string } | null; granularity: 'symbol' | 'block' | 'file'; lines: [number, number] | null; otherRules: boolean }
  | { kind: 'claim_stale'; claimId: ShortId }
  | { kind: 'claim_release'; claimId: ShortId; reason: 'explicit' | 'answer' | 'save' | 'seat_end' | 'stop' | 'reservation_transfer' | 'superseded' }
  | { kind: 'claim_reserve'; claimId: ShortId; request: ReqId; requester: ActorVM }
  | { kind: 'grant_start' | 'grant_end'; claimId: ShortId; grantee: ActorVM }
  | { kind: 'request_open'; request: ReqId; from: ActorVM; holder: ActorVM; desk: number; requestKind: 'handoff' | 'go_first'; estMinutes: number | null; attempt: number; note: string | null }
  | { kind: 'request_status'; request: ReqId; holder: ActorVM; status: 'asked' | 'queued_until_turn_end' | 'awaiting_human' | 'undeliverable' | 'returned' }
  | { kind: 'answer'; request: ReqId; holder: ActorVM; verb: 'accept' | 'grant' | 'decline' | 'later' | 'release'; by: 'claude' | 'human' | 'daemon'; note: string | null }
  | { kind: 'note'; actor: ActorVM; target: { request: ReqId } | { claimId: ShortId } | null; text: string }
  | { kind: 'save'; peer: Handle; desks: number[] }
);
export type PlaceVM = { at: 'home'; spot: number } | { at: 'chair' | 'stool' | 'beside'; desk: number } | { at: 'visitor'; desk: number; tile: number }
  | { at: 'facing'; actor: ActorVM; desk: number } | { at: 'behind'; peer: Handle };
export interface ActorStateVM { place: PlaceVM; pose: 'idle' | 'sit' | 'relaxed'; lastPublish: Pos | null; lastDesk: number | null; lastClaimOp: Pos | null; }
export interface SceneVM {
  at: Pos; badge: 'none' | 'near_full' | 'full'; branchMovedAt: number | null;
  characters: Array<[Handle, ActorStateVM & { ghost: boolean; absent: boolean; frozen: ReasonVM | null; slowedUntil: number | null; rules: boolean; credit: boolean }]>;
  pets: Array<[SeatHandle, ActorStateVM & { owner: Handle; variant: number; live: boolean; ssCode: Code | null }]>;
  desks: Array<[number, { lastEvent: number | null; chair: ActorVM | null; visitors: ActorVM[]; more: number; claims: ShortId[] }]>;
  claims: Array<[ShortId, { seat: SeatHandle; desk: number; order: number; label: { simple: string; qualname: string } | null; granularity: 'symbol' | 'block' | 'file';
                            lines: [number, number] | null; stale: boolean; reservedFor: ReqId | null; grantee: ActorVM | null; otherRules: boolean }]>;
                                                // R-V73 (ledger carry to Task 9): each claims entry also has `at: Pos` (ClaimState.at)
  requests: Array<[ReqId, { from: ActorVM; holder: ActorVM; desk: number; status: string | null }]>;
  boxes: Array<[ShortId, { owner: ActorVM; desk: number; holdKind: string; residence: string; state: string; localOnly: boolean }]>;
  bangs: Array<[ShortId, { on: ActorVM; desk: number | null }]>;
  beat: EventVM[];
}
export interface CardVM { id: CardId; at: Pos; group: 'conversation' | 'activity' | 'conflict' | 'system'; code: Code; actor: ActorVM | null; target: ActorVM | null;
                          paths: string[]; n: number; desks: number[]; displayId: string | null; parent: ReqId | null; label: string | null; text: string | null;
                          detail: ReasonVM | null; seen_ms: number | null; }
export interface Session { session: Hex64; instance: InstanceId; }
export interface Strings { lang: 'en' | 'ko' | 'zh-CN' | 'ja' | 'fr' | 'es'; templates: Record<string, CatalogEntry>; }   // ruling R-V58: CatalogEntry (JSON), so plural forms and params travel to the page; spec-edit-list entry for 12 §3.10.6 ('code -> template')
export interface World { v: 1; cursor: number; demo: boolean; rooms: RoomVM[]; captions: CaptionVM[]; }
export interface RoomVM {
  room_id: RoomId; label: string; branch: string; gone: boolean; badges: Code[]; unknown: number;
  window: { h0: number; h1: number }; overlay: OverlayVM | null;
  layout: LayoutVM; looks: Array<[Handle, { hue: number; accessory: number }]>;
  characters: CharacterVM[]; pets: PetVM[]; scene: SceneVM; cards: CardVM[]; ticks: Tick[];
}
export interface OverlayVM { state: string; freeze_reasons: Code[]; publish_pause: Code | null; down: boolean; unreadable: boolean;
                             offline_min: number | null; holds: number; incoming: number; ready: number; you: Handle | null; }   // state: a STATUS_STATES value (SERVED_STRING_FIELDS 'enum')
export interface CharacterVM { handle: Handle; name: string; hue: number; accessory: number; ph: Code | null; version: string; badges: Code[]; }
export interface PetVM { seat: SeatHandle; owner: Handle; live: boolean; ss: Code | null; variant: number; }
export interface LayoutVM { version: number; zones: Array<{ index: number; sign: string; cells: number[] }>;
                            desks: Array<{ ordinal: number; kind: 'big_table' | 'file' | 'folder' | 'shelf'; zone: number | null; cell: number | null;
                                           slot: number | null; plaque: string | null; path: string | null; lockbox: boolean; first: number }>;   // first: R-V51
                            homeOrder: Handle[]; }
export interface LayoutDeltaVM { from_version: number; version: number; zones: LayoutVM['zones']; desks: LayoutVM['desks']; homeOrder: Handle[]; }
export interface CaptionVM { room_id: RoomId; height: number; code: Code | null; text: string | null; }
export interface Tick { h: number; glyph: 'publish' | 'conflict' | 'request' | 'save' | 'door' | 'freeze'; }
export interface TimelinePage { room_id: RoomId; from: number; to: number; scene: SceneVM; events: EventVM[]; cards: CardVM[]; layout: LayoutDeltaVM | null; }
export type StreamPayload =
  | { type: 'timeline'; room_id: RoomId; h1: number; events: EventVM[]; cards: CardVM[]; ticks: Tick[]; characters: CharacterVM[]; pets: PetVM[] }
  | { type: 'room_snapshot'; room_id: RoomId; window: { h0: number; h1: number }; scene: SceneVM; cards: CardVM[]; ticks: Tick[]; characters: CharacterVM[]; pets: PetVM[] }
  | { type: 'layout'; room_id: RoomId; layout: LayoutDeltaVM }
  | { type: 'overlay'; room_id: RoomId; overlay: OverlayVM }
  | { type: 'room'; room_id: RoomId; change: 'added' | 'gone' | 'state'; label: string; branch: string; gone: boolean; badges: Code[]; unknown: number }
  | { type: 'reset' } | { type: 'bye' };

// src/viz/server/project.ts (12 §3.10.6, §3.10.7; VIZ-35, VIZ-36)
export interface HandleTable {
  peer(p: PeerRef): Handle; seat(s: SeatRef): SeatHandle; shortId(id: string): ShortId;
  /** R-V22: true once a later id collided with an earlier prefix (the world must be re-sent: the api publishes reset). */
  takeCollision(): boolean;
}
export function createHandleTable(): HandleTable;
export type VizTextKind = 'name' | 'label' | 'path' | 'plaque' | 'branch' | 'room' | 'caption' | 'version' | 'sign' | 'note' | 'card' | 'tooltip';
/** Validators first (path: validPathSyntax else '?'; label: SEC-35 validLabel /^[\p{L}\p{M}\p{N}_.:#<>,$@\[\]()-]{1,200}$/u per label field else '?'), then
 *  sanitize(…, 'viz'), then cap (raw units first, R-V50). Every served free-text string goes through it; nothing else produces served text. */
export function vizText(kind: VizTextKind, raw: string): string;
/** R-V43: the value when it is in `set`, else `fallback` ('?' for a non-nullable field, null for a nullable one). */
export function vizCode<F extends '?' | null>(set: ReadonlySet<string>, raw: string | null, fallback: F): string | F;
export const PATHS_MAX_BYTES = 16_384;
/** R-V50: the longest prefix of the vizText'd paths whose JSON is ≤ PATHS_MAX_BYTES (the same cut on every route). */
export function servedPaths(paths: readonly string[]): string[];
/** S8: every string field of viewModel.ts that is neither a named alias nor a literal union → its check: an enum-like field's closed set
 *  ('enum': '?' or null when out of set) or a VizTextKind. A test fails when a string field of the generated schemas is missing here (R-V27). */
export const SERVED_STRING_FIELDS: ReadonlyMap<string, 'enum' | VizTextKind>;
/** R-V52: validName(display) ? display : `peer-<handle>`; when collide, the display capped to max(0, 20 − 3 − |handle|) graphemes + ' · ' + the whole handle. */
export function nameTag(display: string | null, handle: Handle, collide: boolean): string;
/** R-V52: peers whose tags collide in a room: equal looks, or equal normalize('NFKC').toLowerCase() of the uncapped sanitized display, or a display
 *  matching [\s.·•-]+[0-9a-f]{6,}$ (a handle-suffix lookalike always collides). */
export function tagCollisions(peers: ReadonlyMap<PeerRef, { display: string | null }>, looks: LookTable): ReadonlySet<PeerRef>;
export function projectEvent(e: SceneEvent, h: HandleTable): EventVM;          // R-V43 code mapping, R-V50 paths
export function projectScene(s: Scene, h: HandleTable): SceneVM;             // the same R-V43 mapping as projectEvent (VIZ-26)
export function projectCard(c: CardModel, nowMono: number, h: HandleTable): CardVM;   // seen_ms = nowMono − foldedAt, or null (R-V28)
export function projectLayout(l: Layout, h: HandleTable): LayoutVM;
export function projectLayoutDelta(d: LayoutDelta, h: HandleTable): LayoutDeltaVM;
export function projectOverlay(o: Overlay | null, h: HandleTable): OverlayVM | null;
/** CharacterVM.ph = phOf (R-V56) over the scene at h1 and PeerInfo.status; name tags from nameTag over tagCollisions. */
export function projectRoom(m: RoomSnapshotModel, nowMono: number, h: HandleTable): RoomVM;
/** timeline or room_snapshot, each preceded by a layout message when the delta carries one (R-V49). */
export function projectDelta(d: RoomDelta, nowMono: number, h: HandleTable): StreamPayload[];
export function projectPage(p: TimelinePageModel, nowMono: number, h: HandleTable): TimelinePage;
export function projectWorld(rooms: readonly RoomSnapshotModel[], cursor: number, demo: boolean, captions: readonly DemoCaption[], nowMono: number, h: HandleTable): World;

// src/viz/server/api.ts (implements models.ts's WorldApi)
export function createWorldApi(o: { stores: readonly StoreLike[]; handles: HandleTable; hub: StreamHub; clock: Clock; demo: boolean;
                                    captions: readonly DemoCaption[] }): WorldApi;
export function pollSinkFor(api: WorldApi, hub: StreamHub, handles: HandleTable, clock: Clock): PollSink;   // projects and publishes; a layout message before its timeline or snapshot

// src/viz/server/stream.ts (12 §3.10.5 "Stream ids and resume"; VIZ-34, VIZ-42)
export interface SseSink { write(chunk: string): boolean; end(): void; onClose(cb: () => void): void; }
export const SSE_MAX_BYTES = 65_536, RING_EVENTS = 4_096, RING_MS = 600_000, COMMENT_MS = 15_000;
export const LAST_EVENT_ID_RE: RegExp;              // ^(0|[1-9][0-9]{0,15})$
export class StreamHub {
  constructor(clock: Clock);
  /** Assigns the next id(s); a timeline payload over 64 KiB is split between events (never inside one), each part its own id; a layout delta or a
   *  snapshot scene over 64 KiB alone is replaced by one reset; a snapshot keeps as many of its newest cards as fit; a single event whose framed
   *  message with its card exceeds 64 KiB (unreachable under R-V50's budgets; pinned by a test) is replaced by one reset. */
  publish(p: StreamPayload): void;
  /** Valid, ≤ seq and covered by the ring (or no event yet) → replay every later event of every kind, then live; else one reset. Never echoed or logged. */
  attach(out: SseSink, lastEventId: string | undefined): void;
  comment(): void;                                  // ': \n\n' to every sink (the 15 s timer)
  close(): void;                                    // bye to every sink, then end
  seq(): number;
  open(): number;                                   // open streams (the idle exit)
}
export function frameSse(id: number, p: StreamPayload): string;   // `id: <n>\nevent: <type>\ndata: <escapeJson(p)>\n\n`

// src/viz/server/tokens.ts (12 §3.10.2; VIZ-31)
export const LAUNCH_TTL_MS = 120_000;
export type RedeemResult = { ok: true; session: string; instance: string } | { ok: false; why: 'shape' | 'mismatch' | 'expired' | 'reused' };
export class TokenAuthority {
  constructor(random: Random, clock: Clock);        // launch and session: 32 bytes each from random; instance: 8 base32c characters
  readonly launch: string;
  readonly instance: string;
  redeem(presented: string | undefined): RedeemResult;   // single use within 120 s own staleness; a second presentation → 'reused' and the session is revoked
  checkSession(presented: string | undefined): boolean;
  launchExpired(): boolean;
  redeemed(): boolean;
}
/** ^[0-9a-f]{64}$ else false (never throws); then crypto.timingSafeEqual(sha256(presented), sha256(expected)) — always two 32-byte digests. */
export function tokenEquals(presented: string, expected: string): boolean;

// src/viz/server/http.ts (12 §3.10.1–§3.10.5; VIZ-30…VIZ-34; the only node:http importer)
export interface ServerAssets { appJs: string; appCss: string; }
export interface ServerDeps {
  clock: Clock; log: VizLog; hub: StreamHub; tokens: TokenAuthority; api: WorldApi; assets: ServerAssets;
  onActivity(): void;                               // an authenticated request or an open stream
  onLaunchReused(): void;                           // after bye: main exits VIZ_EXIT_LAUNCH_REUSED
}
export const CSP: string;                           // the §3.10.4 value as one line, directives in order, '; ' separated, no trailing ';'
export const SECURITY_HEADERS: Readonly<Record<string, string>>;   // the §3.10.4 set minus Content-Type
export const HTTP_LIMITS: Readonly<{ maxHeaderSize: 8_192; maxUrl: 2_048; headersTimeout: 5_000; requestTimeout: 10_000; keepAliveTimeout: 5_000;
                                     connectionsCheckingInterval: 1_000; maxConnections: 32; maxSessionBody: 256 }>;   // R-V48
export function escapeJson(v: unknown): string;     // JSON with <, >, &, U+2028, U+2029 as \u escapes
export interface VizServer { port: number; close(): Promise<void>; }
/** http.createServer({ requireHostHeader: false, insecureHTTPParser: false, maxHeaderSize, headersTimeout, requestTimeout, keepAliveTimeout,
 *  connectionsCheckingInterval }) (a value Node 20 takes only as a property is set before listen); a clientError listener writes one fixed raw response
 *  (431 HPE_HEADER_OVERFLOW, 408 ERR_HTTP_REQUEST_TIMEOUT, else 400) with the §3.10.4 set and Connection: close, never err.rawPacket; checkContinue and
 *  checkExpectation run the normal admission (bad Host → 421, no 100; another Expect → 417) (R-V48); listen({ host: '127.0.0.1', port: 0,
 *  exclusive: true }); address() must be { address: '127.0.0.1', family: 'IPv4' } else close + refuse. The Origin check compares with the template
 *  `http://127.0.0.1:${port}` (R-V55). */
export function createServer(deps: ServerDeps): Promise<VizServer | { refuse: 'RF_VIZ_BIND_FAILED' }>;

// src/viz/server/shell.ts
export const SHELL_HTML: string;                    // <!doctype html>, meta charset, empty <title>, <link rel="stylesheet" href="/app.css">, <script src="/app.js" defer>, <main id="app">; no inline script or style, no human text
export function staticRoute(path: string, a: ServerAssets): { type: string; body: string } | 'favicon' | null;   // exactly '/', '/app.js', '/app.css', '/favicon.ico'

// src/viz/server/vizLog.ts (12 §3.10.10; VIZ-38; R-V40)
export type VizLogParam = number | boolean | null | string;    // strings only: registry codes, room ids, errno codes (^E[A-Z0-9]{2,15}$); anything else throws
export type SecVizCode = 'SEC_VIZ_BAD_HOST' | 'SEC_VIZ_BAD_ORIGIN' | 'SEC_VIZ_BAD_TOKEN' | 'SEC_VIZ_LAUNCH_REUSED' | 'SEC_VIZ_LAUNCH_EXPIRED' | 'SEC_VIZ_METHOD' | 'SEC_VIZ_LIMIT';
export interface VizLog {
  write(code: string, params?: Readonly<Record<string, VizLogParam>>): void;
  security(code: SecVizCode): void;                 // one line per code per 60 s with a count; SEC_VIZ_LAUNCH_REUSED at once
  error(code: string, err: unknown): void;          // err.code and stack frames only, never err.message or err.stack text
  flush(): Promise<void>;
}
export const LOG_ROTATE_BYTES = 10_000_000, LOG_FILES = 5, LOG_KEEP_MS = 1_209_600_000, SEC_WINDOW_MS = 60_000;
/** <dir>/viz-<instance>-<n>.jsonl, append-only; rotation renames only this instance's files; every line {"t": monoMs, "code", …} through sanitize(…, 'log'). */
export function openVizLog(o: { fs: Fs; clock: Clock; dir: string; instance: string }): Promise<VizLog>;
export function cleanupVizLogs(fs: Fs, clock: Clock, dir: string): Promise<number>;   // viz-*.jsonl whose mtime is older than 14 days
export function stackFrames(err: unknown): Array<{ fn: string; line: number; col: number }>;   // file reduced to its basename
export const nullVizLog: VizLog;
// Landed in Task 10 (ledger R-V65, R-V67, R-V72; ratified, F-8a-6): stream.ts SSE_BUFFER_MAX = 1 MiB (per-stream backlog cap) and
// RING_MAX_BYTES = SSE_BUFFER_MAX; http.ts REAP_MS, SSE_RECHECK_MS = 1_000, SseResponse, cappedSink; the log code VIZ_LOG_DROPPED {n} (pending its
// 12 §3.11 row); src/viz/server/clockTimer.ts ClockTimer, clockTimer(clock, ms, fn). Error bodies are {code} JSON for 401/404/421/500 (R-V66).
```

### CLI and process

```ts
// src/viz/cli/view.ts (12 §3.2, §3.10.9; VIZ-02, VIZ-04; R-V13, R-V14, R-V15)
export type OutputMode = 'tty' | 'slash' | 'pipe';
export function outputMode(isTTY: boolean, env: Readonly<Record<string, string | undefined>>): OutputMode;   // 10-product §2 (CLAUDECODE)
export interface ViewFlags { noOpen: boolean; demo: true | string | null; repos: string[]; }
/** --no-open, --demo, --demo=<file>, --repo <path> (repeatable); anything else, --json, or --demo with --repo → RF_UNKNOWN_FLAG. */
export function parseViewFlags(argv: readonly string[]): ViewFlags | { refuse: 'RF_UNKNOWN_FLAG' };
export function langOf(locale: string): Lang;                                                  // 10-product §3.17 mapping, else 'en'
export const URL_RE: RegExp;                                                                   // ^http://127\.0\.0\.1:[1-9][0-9]{0,4}/#k=[0-9a-f]{64}$
/** From the integer and the hex only, through the one allowed launch template `http://127.0.0.1:${port}/#k=${launch}` (R-V55), then URL_RE. */
export function launchUrl(port: number, launch: string): string | null;
export interface CliEnv {
  pluginRoot: string;                               // the parent of dist/
  cwd: string; env: Readonly<Record<string, string | undefined>>; platform: NodeJS.Platform; isTTY: boolean; home: string; locale: string;
  execPath: string; uid: number | null;
  out(s: string): void; err(s: string): void;       // every string written is a render() result (UX-01, tested)
  fs: Fs; clock: Clock; ownerProbe: OwnerProbe;
  spawnViewer(a: ViewerArgs): Promise<ReadyLine>; openUrl(url: string, ctx: OpenerCtx): Promise<boolean>;   // injectable for tests
}
/** registerCatalog('en', EN_VIZ_CLI) (R-V54); pipe/slash → UI_VIZ_TERMINAL_ONLY, exit 0, nothing started; tty → resolve and verify the data dir, L_h,
 *  absolute paths (cli/paths.ts), with --repo the git path (resolveGitPath over excludedRoots(cwd, repos); none → START_TOOL_VERSION, nothing spawned;
 *  R-V13), sha256 of <pluginRoot>/dist/viz.js, the viewer environment (buildDaemonEnv with PATH replaced by the filtered list), spawnViewer, launchUrl,
 *  open unless --no-open; prints UI_VIZ_OPENED, or UI_VIZ_URL with the URL (a 'url' param) after --no-open or an open failure; refusals in the
 *  10-product §3.4 two-line format with the 12 §1.2 next line; exit 0 / 1. */
export function runView(argv: readonly string[], env: CliEnv): Promise<number>;
export function realCliEnv(): CliEnv;

// src/viz/cli/paths.ts (R-V54; imports nothing)
export function isUncOrDevice(p: string): boolean;                                             // \\…, //…, \\.\…, \\?\…, /dev/…
export function absolutize(p: string, cwd: string, platform: NodeJS.Platform): string | null;   // null for UNC and device paths

// src/viz/cli/pathTrust.ts (R-V13, R-V39; 12 §3.10.8; INV-NOEXEC)
/** Realpaths of the cwd's repository root (the first ancestor of cwd holding .git) and of each --repo worktree; an unresolvable root is skipped. */
export function excludedRoots(cwd: string, repos: readonly string[], fs: Fs, platform: NodeJS.Platform): Promise<string[]>;
// Landed (ledger R-V68; ratified, F-8a-6): a fifth parameter `home: string | null = null` — the .git ancestor walk stops below the user's home.
/** The value of the first env key whose upper case is PATH, split by the platform delimiter; drops empty, '.' and relative entries, normalizes the
 *  rest, and drops an entry whose Fs.realpath fails or lies inside an excluded root (realpath-compared, case-insensitively on win32 and darwin). */
export function filterPath(env: Readonly<Record<string, string | undefined>>, excluded: readonly string[], platform: NodeJS.Platform, fs: Fs): Promise<string[]>;
/** The candidate's Fs.realpath when it lies outside every excluded root and lstats as a regular file (symlinks followed), and on POSIX is owned by
 *  uid 0 or the euid and is not group- or world-writable (OwnerProbe.posix); else null. */
export function trustedExe(candidate: string, excluded: readonly string[], o: { fs: Fs; probe: OwnerProbe; platform: NodeJS.Platform; euid: number | null }): Promise<string | null>;
/** The first git.exe (win32) or git in the filtered PATH that passes trustedExe; null → START_TOOL_VERSION. */
export function resolveGitPath(env: Readonly<Record<string, string | undefined>>, excluded: readonly string[], o: { fs: Fs; probe: OwnerProbe; platform: NodeJS.Platform; euid: number | null }): Promise<string | null>;

// src/viz/cli/spawn.ts (12 §3.2 items 2–3; R-V12)
export interface ViewerArgs { execPath: string; vizJs: string; dataDir: string; lang: Lang; sha256: string; repos: readonly string[];
                              demo: true | string | null; git: string | null;   // git: the resolved absolute git, set exactly when repos is non-empty (R-V13)
                              env: Record<string, string>; platform: NodeJS.Platform; systemRoot: string | null; }
export type ReadyLine = { port: number; launch: string } | { refuse: string; line?: number };
export const READY_TIMEOUT_MS = 5_000, READY_MAX_BYTES = 512;
export const READY_REFUSE_CODES: ReadonlySet<string>;   // RF_VIZ_START_FAILED, RF_VIZ_BIND_FAILED, RF_VIZ_NO_ROOMS, RF_VIZ_REPO_NOT_LIVE, RF_VIZ_DEMO_INVALID, START_TOOL_VERSION
export function parseReadyLine(buf: Buffer): ReadyLine | null;   // one LF-terminated JSON object by schema; "line" only with RF_VIZ_DEMO_INVALID
/** [vizJs, 'serve', '--data-dir', dataDir, '--lang', lang, '--sha256', sha256, ('--git', git, ('--repo', p)…) | '--demo' | '--demo=<abs>'] */
export function viewerArgv(a: ViewerArgs): string[];
/** spawn(execPath, viewerArgv(a), { shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: a.env, cwd: a.dataDir });
 *  ≤ 512 bytes within 5 s; then destroy the pipe and unref(); a timeout, a bad line or an early exit → killTree and { refuse: 'RF_VIZ_START_FAILED' }. */
export function spawnViewer(a: ViewerArgs): Promise<ReadyLine>;
export function killTree(pid: number, platform: NodeJS.Platform, systemRoot: string | null): Promise<void>;

// src/viz/cli/opener.ts (12 §3.10.8; VIZ-05; R-V39)
export interface OpenerCtx { platform: NodeJS.Platform; env: Readonly<Record<string, string | undefined>>; builderEnv: Record<string, string>;
                             dataDir: string; cwd: string; repos: readonly string[]; fs: Fs; uid: number | null; ownerProbe: OwnerProbe; }
export interface OpenerPlan { exe: string; argv: string[]; env: Record<string, string>; }
/** URL_RE re-check first; win32: <SystemRoot>\explorer.exe (SystemRoot absolute and existing); darwin: /usr/bin/open; else the first existing of
 *  /usr/bin/xdg-open, /usr/local/bin/xdg-open, /bin/xdg-open, /usr/bin/gio (argv ['open', url]), then xdg-open from filterPath; every Linux candidate
 *  through trustedExe (outside the excluded roots by realpath, owned by uid 0 or the user, not group- or world-writable); DISPLAY or WAYLAND_DISPLAY
 *  required; env = builder env + the opener display set (DISPLAY, WAYLAND_DISPLAY, XAUTHORITY) + PATH = the filtered list. null → no usable opener. */
export function planOpener(url: string, ctx: OpenerCtx): Promise<OpenerPlan | null>;
/** spawn(plan.exe, plan.argv, { shell: false, detached: true, windowsHide: true, stdio: 'ignore', cwd: dataDir, env }); 5 s; win32: only a spawn error fails. */
export function openUrl(url: string, ctx: OpenerCtx): Promise<boolean>;

// src/viz/cli/dataDir.ts (SEC-20; R-V11)
export function pluginDataDir(env: Readonly<Record<string, string | undefined>>, home: string, platform: NodeJS.Platform): string;
export function resolveDataDir(env: Readonly<Record<string, string | undefined>>, home: string, platform: NodeJS.Platform): string | null;   // CLAUDE_PLUGIN_DATA if absolute, else pluginDataDir
export type DataDirVerdict = { ok: true } | { ok: false; why: 'not_dir' | 'symlink' | 'owner' | 'mode' | 'acl' | 'probe_failed' };
/** create: mkdirp 0700 when absent (the CLI); the viewer passes create: false. POSIX: lstat directory, not a symlink, uid = euid, mode & 0o077 === 0.
 *  win32: lstat not a symlink or junction (isSymbolicLink), then parseSddl + sddlUserOnly. Any probe failure → probe_failed (fail closed). */
export function verifyDataDir(dir: string, o: { fs: Fs; probe: OwnerProbe; platform: NodeJS.Platform; create: boolean }): Promise<DataDirVerdict>;
export interface Sddl { owner: string | null; allow: string[]; deny: string[]; }   // SIDs; the aliases SY → S-1-5-18, BA → S-1-5-32-544, OW → owner rights kept as 'OW'
/** null for malformed SDDL, an absent DACL (no D: part), D:NO_ACCESS_CONTROL, or any ACE type other than A and D (OA, XA, ZA, …) (S9). */
export function parseSddl(sddl: string): Sddl | null;
/** owner ∈ {user, S-1-5-32-544}; at least one allow ACE for the user SID; every allow ACE ∈ {user, S-1-5-18, S-1-5-32-544}; inherit-only CO/OW allowed. */
export function sddlUserOnly(s: Sddl, userSid: string): boolean;
// Landed extras (ratified, F-8a-6): sddlOwnerOk(owner, userSid) here; WINDOWS_ACL_COMMAND (ownerProbe.ts); SpawnDeps, spawnViewerWith, KillDeps,
// killTreeWith (spawn.ts); OpenerSpawn, openUrlWith (opener.ts); withTrustCache(fs), withPath(childEnv, source, entries, platform) (pathTrust.ts).
// F-8a-2 (X-61, X-62, 2026-10-08): pluginDataDir and resolveDataDir move to src/data/pluginDataDir.ts (node-only), Sddl, parseSddl, sddlUserOnly and
// sddlOwnerOk to src/sec/sddl.ts (with the one allowed-SID constant: the user, S-1-5-18, S-1-5-32-544); this file re-exports each name with the
// signature above and keeps verifyDataDir (user-only creation stays verifyDataDir(dir, { create: true }); there is no createUserOnlyDir). Plan 5 then
// adds the optional fourth parameter pluginRoot and pluginIdOf (R5-56) to the moved module.
// F-8a-7: the repair allowlist (the private onlyViewerFiles: *.jsonl, probe.json, log/) also admits the per-user files Plans 7 and 8b add —
// notify-rate.json, notify-rate.lock, repos.json, user.json — each a regular file, never a link.

// src/viz/cli/ownerProbe.ts (R-V11; with source/boundedRead.ts the only viz files importing node:fs; child_process allowed)
export interface OwnerProbe {
  posix(path: string): Promise<{ uid: number; mode: number; isDir: boolean; isSymlink: boolean } | null>;   // lstat of a directory or a file
  euid(): number | null;
  /** <SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command <fixed text reading $env:COWORK_ACL_PATH>;
   *  env = { SystemRoot, COWORK_ACL_PATH: dir }; cwd <SystemRoot>\System32; 10 s timeout; returns the SDDL and the current user SID. */
  windows(dir: string): Promise<{ sddl: string; userSid: string } | null>;
}
export const realOwnerProbe: OwnerProbe;

// src/viz/main.ts (12 §3.2 items 2–9, §3.10.10; VIZ-01…VIZ-03, VIZ-06; R-V16)
export type VizExit = 'VIZ_EXIT_IDLE' | 'VIZ_EXIT_LIFETIME' | 'VIZ_EXIT_LAUNCH_UNUSED' | 'VIZ_EXIT_LAUNCH_REUSED' | 'VIZ_EXIT_PLUGIN_REMOVED' | 'VIZ_EXIT_SIGNAL';
export interface ServeArgs { dataDir: string; lang: Lang; sha256: string; repos: string[]; demo: true | string | null; git: string | null; }
/** `serve` then exactly these flags; absolute paths; 64-hex sha256; --git absolute and present exactly when --repo is (refused with --demo, R-V13). */
export function parseServeArgv(argv: readonly string[]): ServeArgs | null;
export interface ViewerDeps {
  fs: Fs; reader: BoundedReader; clock: Clock; random: Random; ownerProbe: OwnerProbe; machineMonoMs(): number;
  env: Record<string, string>; platform: NodeJS.Platform; selfPath: string; assets: VizAssets; viewerVersion: string;
  gitRunner?(o: { clock: Clock; dataDir: string; env: Record<string, string>; gitPath: string }): GitRunner;   // tests: a spying runner
  stores?: readonly StoreLike[];                    // tests only: replaces room discovery and the stores (S20); never set by main()
  signals?(cb: (sig: 'SIGTERM' | 'SIGINT' | 'SIGHUP') => void): void;
}
export interface ViewerHandle { port: number; launch: string; instance: string; exited: Promise<VizExit>; stop(reason: VizExit): Promise<void>; }
export const IDLE_MS = 600_000, LIFETIME_MS = 86_400_000, PLUGIN_CHECK_MS = 30_000;
/** R-V16 order; a demo run makes no git call and reads no repository file (VIZ-06); returns the ready values or the refusal for the ready line; rooms fold
 *  after it; exits per VIZ-03 (own staleness for the launch TTL, idle and lifetime, counting authenticated requests and open streams only; Δmono for the
 *  30 s check); stop() sends bye, closes every socket, flushes the log. */
export function startViewer(a: ServeArgs, d: ViewerDeps): Promise<ViewerHandle | { refuse: string; line?: number }>;
/** dist/viz.js: registerCatalog('en', EN_VIZ) and registerReasonCodes(REASON_CODES); writes exactly one ready line, closes stdout, exits 0 on a VizExit, 1 after a refusal. */
export function main(argv: readonly string[], assets: VizAssets): Promise<never>;

// src/viz/assets.ts (R-V36)
export interface VizAssets { appJs: string; appCss: string; bundledDemo: string; }
export const VIZ_ASSETS: VizAssets;                 // from 'viz-asset:app.js', 'viz-asset:app.css', 'viz-asset:demo.jsonl'
// src/viz/assets.d.ts: declare module 'viz-asset:*' { const text: string; export default text; }
// src/entry/viz.ts: --version → "cowork-sync viz <PLUGIN_VERSION>\n"; no argument → no-op exit 0; argv[0] === 'serve' → main(argv, VIZ_ASSETS)
// src/entry/cli.ts: argv[0] === 'view' → process.exitCode = await runView(argv.slice(1), realCliEnv()); --version and no-argument unchanged
```

### Page logic (`src/viz/ui/**`, pure, shared with the page) and the page (`src/viz/client/**`, browser only)

```ts
// src/viz/ui/sse.ts
export interface SseEvent { id: string | null; event: string; data: string; }
export function createSseParser(on: (e: SseEvent) => void): { push(chunk: string): void; end(): void };   // LF, CRLF, CR; ':' comments; multi-line data

// src/viz/ui/conn.ts (12 §3.10.2, §3.10.5; VIZ-42)
export type ConnState = 'booting' | 'live' | 'reconnecting' | 'stopped' | 'link_reused' | 'link_expired' | 'need_link';
/** V8/S11: one route per literal fetch in client/api.ts (L-VIZ-DOM: a fetch's first argument is a literal or a template with a literal /api/v1/ head). */
export type ApiRoute = { r: 'session' } | { r: 'world' } | { r: 'strings'; lang: Lang } | { r: 'timeline'; room: string; from: number; to: number };
export interface ConnIo {
  request(route: ApiRoute, init: { method: 'GET' | 'POST'; headers: Record<string, string> }): Promise<{ status: number; json: unknown }>;
  stream(headers: Record<string, string>): Promise<{ status: number; read(): Promise<string | null>; cancel(): void }>;
  timer(ms: number, f: () => void): () => void;
  storage: { get(): { session: string | null; room: string | null }; set(v: { session?: string; room?: string }): void; clear(): void };   // sessionStorage, try/catch
}
export const RETRY_START_MS = 1_000, RETRY_MAX_MS = 30_000;
export class Connection {
  constructor(io: ConnIo, on: { state(s: ConnState): void; world(w: World): void; payload(p: StreamPayload, id: number): void });
  /** launch from the fragment (already removed by the caller) or null; POST /api/v1/session once; else the stored session; then world, then stream with
   *  Last-Event-ID = world.cursor; broken stream → reconnecting, retry 1 s doubling to 30 s, then a world reload, then stopped; bye → stopped. */
  start(launch: string | null): Promise<void>;
  stop(): void;                                     // stopped (UI_VIZ_STOPPED) and link_reused clear the storage (12 §3.2 item 5)
}
/** 12 §3.2 item 11: the room kept in sessionStorage when it is still in the world, else the first room in server order; null with no rooms. */
export function firstRoom(w: World, kept: string | null): string | null;

// src/viz/ui/anim.ts (12 §3.7; VIZ-22)
export type AnimState = 'idle' | 'walk' | 'sit' | 'sparkle_small' | 'sparkle_big' | 'planes' | 'exclaim' | 'think' | 'bubble' | 'zzz' | 'relaxed'
  | 'ghost' | 'frozen' | 'slowed' | 'enter' | 'exit' | 'spawn' | 'poof' | 'celebrate' | 'parcel';
export interface AnimSpec { frames: number; frameMs: number; durationMs: number | null; reduced: 'static' | 'crossfade' | 'icon' | 'same' | 'off'; }
export const ANIM: Readonly<Record<AnimState, AnimSpec>>;   // the §3.7 table
export function statesFor(e: SceneEvent): AnimState[];      // total over SCENE_EVENT_KINDS
export const LIVE_BEAT_MS = 300, REPLAY_BEAT_MS = 800, BACKLOG_SNAP_MS = 5_000, WALK_TILES_PER_S = 4, TRIP_MAX_MS = 3_000;
export const SPEEDS: readonly number[];                      // 0.5, 1, 2, 4, 8

// src/viz/ui/loop.ts
export interface LoopIo { raf(cb: (t: number) => void): number; cancel(id: number): void; }
export const FPS_CAP = 12;
/** frameKey(t) changes exactly when a sprite's frame index changes; draw only then and ≤ 12 fps; stop when idle(t) (paused, reduced motion, nothing on
 *  screen, or a constant key with nothing animating); wake() restarts. */
export function createLoop(io: LoopIo, frameKey: (t: number) => string, idle: (t: number) => boolean, draw: (t: number) => void): { wake(): void; stop(): void; draws(): number };

// src/viz/ui/path.ts (12 §3.5.4 "Pathfinding")
export function findPath(from: Tile, to: Tile, blocked: (t: Tile) => boolean, size: { w: number; h: number }): Tile[] | null;   // 4-way A*, Manhattan, N,E,S,W, turn penalty 1
export class PathCache { constructor(max: number); get(version: number, from: Tile, to: Tile, compute: () => Tile[] | null): Tile[] | null; }
export function shouldPoof(path: Tile[] | null, speed: number): boolean;   // no path, or speed ≥ 4 and > 12 tiles

// src/viz/ui/bubbles.ts (12 §3.8; VIZ-23)
export function bubbleMs(text: string, speed: number): number;   // clamp(1.5 s, 0.5 s + Σ 1/cps, 6 s) / speed, ≥ 1.0 s
export function wrapBubble(text: string): string[];              // ≤ 2 lines × 42 Latin / 16 full-width, then '…'
export class BubbleSet { show(actor: string, room: string, text: string, nowMs: number, speed: number): void; active(nowMs: number): Array<{ actor: string; lines: string[]; untilMs: number }>; }

// src/viz/ui/logModel.ts (12 §3.8; VIZ-24, VIZ-25, VIZ-11)
export interface LogFilter { peer: Handle | null; desk: number | null; groups: ReadonlySet<CardVM['group']>; system: boolean; }
export type LogRow =
  | { kind: 'card'; card: CardVM; answers: CardVM[]; chips: string[] }
  | { kind: 'merged'; actor: ActorVM; cards: CardVM[]; chips: string[]; more: number };   // consecutive publishes of one actor, ≤ 5 chips
export const CARDS_MAX = 2_000, CHIPS_MAX = 5;
export class LogModel {
  add(cards: readonly CardVM[], receivedAtMono: number): void;            // ascending position; beyond 2,000 the oldest drop (fetched again by page)
  status(e: EventVM): void;                                                // request_status → a chip of its request card (a page-side join)
  rows(f: LogFilter): LogRow[];                                            // filters AND-combined; merging after filtering
  seenLabel(c: CardVM, nowMono: number, replay: boolean): { kind: 'seen_ago'; n: number } | { kind: 'before_open'; height: number } | { kind: 'height'; height: number };   // → UI_VIZ_SEEN_AGO, UI_VIZ_SEEN_BEFORE_OPEN, '#<height>'
}

// src/viz/ui/seek.ts (12 §3.9.1; VIZ-26)
export const SEEK_CACHE_EVERY = 64;
export class SeekCache {
  constructor(view: () => TimelineView);
  sceneAt(at: Position): Scene;                  // from the nearest cached scene ≤ at in at's segment
  holds(h: number): boolean;                     // the page holds the events of h
  invalidate(fromHeight: number): void;
}
/** The static layer's options for a scene, structurally render/raster.ts's StaticOptions (ui/** imports nothing from render/**): dashedFrom = s.at.height on a
 *  past scene, null live (R-V51); dimmed by deskDimmed; lockbox desks from the layout. */
export function staticFor(layout: Layout, s: Scene, o: { live: boolean; coarse: boolean }):
  { dashedFrom: number | null; dimmed: ReadonlySet<DeskRef>; coarse: boolean; lockboxDesks: ReadonlySet<DeskRef> };

// src/viz/ui/unproject.ts (R-V23)
export function unprojectEvent(e: EventVM): SceneEvent;
export function unprojectScene(s: SceneVM): Scene;
export function unprojectLayout(l: LayoutVM): Layout;      // deskOf rebuilt from desk paths
/** R-V49: d.version ≤ l.version → l unchanged (already applied: the stream and the TimelinePage carry the same delta); d.from_version ≠ l.version → 'reload'. */
export function applyLayoutDeltaVM(l: LayoutVM, d: LayoutDeltaVM): LayoutVM | 'reload';

// src/viz/ui/fragment.ts (12 §3.8 "Filters", §3.10.2)
export function takeLaunchToken(hash: string): string | null;   // ^#k=([0-9a-f]{64})$
export function parseFilterFragment(hash: string): { room: string | null; peer: string | null; desk: number | null };   // fixed regexes only, never a path;
                                                                                                                        // peer ^[0-9a-f]{6,32}$ (R-V22)
export function formatFilterFragment(f: { room: string | null; peer: string | null; desk: number | null }): string;

// src/viz/ui/zoom.ts (12 §3.5.3, §3.7)
export function autoZoom(panelW: number, worldW: number): number;   // max(2, ⌊panelW / worldW⌋), only on open, resize or user zoom
export function clampZoom(z: number): number;                       // 2–8
export function mapZoom(z: number): number;                         // max(1, z − 1)
export class FollowRule { scrolled(nowMono: number): void; follow(nowMono: number): boolean; }   // follow when the user has not scrolled for 30 s
                                                    // (the §3.5.3 auto-scroll, unrelated to F32's following of a person; in a room with a follow the
                                                    // client consults Task 19's FollowCamera instead; zoom.ts is unchanged by Task 19)

// src/viz/ui/a11y.ts (12 §3.11 "Accessibility"; VIZ-40)
export function sceneSummaryParams(s: Scene): { people: number; sessions: number; open: number; conflicts: number };
export class Announcer { constructor(minGapMs: number); offer(summary: string, nowMono: number): string | null; }   // ≤ 1 per 10 s
export type KeyAction = 'live' | 'clear_filters' | 'zoom_in' | 'zoom_out' | 'step_back' | 'step_fwd' | 'page_back' | 'page_fwd' | 'select';
export const KEYS: Readonly<Record<string, KeyAction>>;   // L, Escape, +, -, ArrowLeft, ArrowRight, PageUp, PageDown, Enter
// Task 19 (F32) appends the KeyAction 'follow' and the key F → 'follow' (inactive while focus is in a form control); 8b later appends 'close_panel'.
/** One row per character of the room (12 §3.11 hidden list): handle, name tag, PH code (CharacterVM.ph, or the pet's SS code), placeLabel (model/labels.ts). */
export function peopleList(s: Scene, characters: readonly CharacterVM[], layout: Layout): Array<{ handle: Handle; name: string; ph: string | null; place: PlaceLabel | null }>;

// src/viz/ui/map.ts (12 §3.5.1, §3.3.6; VIZ-13)
export const MAP_DOTS_MAX = 16, MAP_SCROLL_AFTER = 8;
/** ≤ 16 dots: ranked (non-ghost) characters first in homeOrder, then the rest of the live set; ghosts grey, absent hollow; the whole cell grey when the
 *  room is down, its board ref vanished, or it is gone. */
export function roomDots(s: Scene, looks: ReadonlyMap<string, { hue: number; accessory: number }>, homeOrder: readonly string[],
                         room: { down: boolean; noBoard: boolean; gone: boolean }): { grey: boolean; dots: Array<{ actor: string; hue: number | null; hollow: boolean }> };
/** The own room's lamp in the header (live and replay). */
export function headerLamp(o: OverlayVM | null): { state: string; unreadable: boolean; down: boolean } | null;
/** The overlay drawn on the scene (parcels at "you", the delivery cart and packed boxes at the door, the "you" marker): null in replay and for any room
 *  but its own (VIZ-13: never on a past scene). */
export function sceneOverlayMarks(o: OverlayVM | null, replay: boolean): { you: Handle | null; parcels: number; cart: number; boxes: number } | null;

// src/viz/ui/follow.ts (Task 19, 2026-10-08; F32, owner decision D3; 12 §3.8.1, §3.13; X-93). Pure and DOM-free; imports model/** only (Scene,
// comparePos, phOf, Layout, plaqueOf, Tile, ActorRef), so it is in the R-V35 client program by its directory. Ids are the page's handles, opaque
// strings (VIZ-26). Nothing here is sent, stored, logged or mirrored into the fragment (FEAT-F32-01).
export const FOLLOW_PAN_MS = 300;                  // one live beat
export const NOW_ROWS_MAX = 3;                     // holding, asks and asked-by rows each, then UI_VIZ_MORE
/** The peer's character (when in s.characters) and every pet of s.pets whose owner is `peer` and whose `live` is true. */
export function followedActors(s: Scene, peer: PeerRef): ActorRef[];
/** The followed actor whose place differs from prev's: the character first, then pets in ascending seat handle; when none moved, the character, else
 *  the first pet; null when nothing is followed at s. */
export function focusActor(prev: Scene | null, s: Scene, peer: PeerRef): ActorRef | null;
/** 12 §3.8.1 camera steps on one axis, in tiles (fractions allowed): the frame = the bounding box of `tiles` plus 1 tile; inside the view → null
 *  (step 1, skipped when `force`, a chip click); it fits → the view start that centres it, clamped to [0, officeH − view.h] (step 2); else the start
 *  that centres `focus`, clamped (step 3). null = nothing scrolls (X-93; 8b CPA-8a.1's `number` reads `number | null`). The vertical axis always;
 *  the horizontal axis, only when the office is wider than the panel, through the same function with each tile's x as y and the widths as heights.
 *  The client passes placeTile's tiles (render/raster.ts; ui/** imports nothing from render/**) or the zone table's tile in the coarse view. */
export function cameraTarget(tiles: readonly Tile[], focus: Tile | null, view: { top: number; h: number }, officeH: number, force: boolean): number | null;
/** FEAT-F32-04: after userScrolled(), due() is false until a beat in which a followed actor's place changes (then true once); scrolls the camera
 *  itself makes never call userScrolled(). */
export class FollowCamera { userScrolled(): void; due(prev: Scene | null, s: Scene, peer: PeerRef): boolean; }
/** FEAT-F32-05 (a Task 19 addition to 12 §3.13's list, pure so T-VIZ-follow-motion runs under Node): 'jump' under effective reduced motion, at
 *  speed ≥ 4 (shouldPoof's speed threshold) and for a seek, a room_snapshot, "load earlier" or a room switch; else 'pan' over FOLLOW_PAN_MS. */
export function followMotion(o: { reducedMotion: boolean; speed: number; cause: 'start' | 'beat' | 'chip' | 'seek' | 'snapshot' | 'earlier' | 'room' }): 'pan' | 'jump';
/** X-93's controller default (the 8a owner may refine it): ≤ NOW_ROWS_MAX entries per row list. `target` is the other side's peer handle (a pet's
 *  owner), whose name tag the client renders from the character table; `id` is the request's display id; lastShared.path is null at the big table
 *  (UI_VIZ_NOW_LAST_SHARED_TABLE). `more` is a Task 19 refinement for the UI_VIZ_MORE "+n" that T-VIZ-follow-now asserts (the uncapped count minus
 *  the rows shown; 0 when none) — X-93's shape has no field for it; ratified 2026-10-08 (reconcile §7 V-19, as the refinement X-93 allows; a return
 *  type with the extra field stays assignable to 8b's CPA-8a.1 re-baseline). */
export interface NowCard {
  peer: PeerRef; here: boolean;                    // here: s.characters has peer (else the UI_VIZ_NOW_NOT_HERE row)
  holding: ReadonlyArray<{ path: string; label: string | null }>;
  asks: ReadonlyArray<{ target: string; id: string }>;
  askedBy: ReadonlyArray<{ target: string; id: string }>;
  lastShared: { path: string | null; height: number } | null;
  more: { holding: number; asks: number; askedBy: number };   // Task 19 refinement (above; ratified, V-19)
}
/** The 12 §3.8.1 now-card table over the drawn scene and the layout only (FEAT-F32-06, -07): holding = s.claims with stale false whose seat is a pet
 *  of `peer`, by desk ordinal then order, label by the chair-tag rules (validLabel else '?'); asks / askedBy = s.requests whose from / holder is the
 *  peer's character or one of its pets, ascending display id; lastShared = among the character and every pet of `peer` (live or ended) the ActorState
 *  with the greatest lastPublish (comparePos), its lastDesk by desk kind: a file desk's path, a folder desk's plaque, a shelf desk's zone sign + '/…',
 *  null at the big table, and lastPublish.height. Never a time, an age, an overlay value, a note's text or an aggregate over time. The header's PH
 *  label is phOf(c, c.absent ? 'absent' : 'active', s.at) (model/labels.ts), which the client computes from the same scene. */
export function nowCard(s: Scene, layout: Layout, peer: PeerRef): NowCard;
/** FEAT-F32-01, -02 (a Task 19 addition, pure so T-VIZ-follow-filter runs under Node): the one page-memory Map<roomId, Handle>; at most one followed
 *  peer per room; never serialized. Selecting a room ends nothing: the client reads get(room) and pins LogFilter.peer to it. */
export class FollowSet {
  get(room: string): PeerRef | null;
  toggle(room: string, filterPeer: PeerRef | null): PeerRef | null;    // the toggle or F: none → follow filterPeer (null: nothing); on → off
  filterChanged(room: string, peer: PeerRef | null): void;             // another person filter, a cleared one or Esc with no export panel open → ends it
  worldReloaded(room: string, characters: ReadonlySet<PeerRef>): void; // the reloaded world no longer lists the followed handle (R-V22) → ends it
}

// src/viz/client/** — browser only (L-VIZ-DOM, L-VIZ-IMPORT); exports are internal to the page bundle:
//   main.ts   boot(): takeLaunchToken + history.replaceState(null, '', '/') before any request; Connection; renderWith over /api/v1/strings; panels
//   api.ts    createConnIo(): one fetch per ApiRoute with a literal '/api/v1/…' path or a template with that literal head, after re-checking the room id
//             (^r[0-9A-HJKMNP-TV-Z]{8}$), heights (^(0|[1-9][0-9]{0,9})$) and lang (one of six); every fetch credentials 'omit', cache 'no-store',
//             redirect 'error'; the X-Cowork-Launch / X-Cowork-Session headers; the stream via fetch('/api/v1/stream') + getReader()
//   office.ts createOffice(canvas, mapCanvas): composeStatic (dashedFrom = the scene height on a past scene, R-V51)/composeSprites into an art-size
//             offscreen canvas drawn at integer Z; imageSmoothingEnabled false; fillText plates cached per (string, size, theme); placeLabel plates;
//             sceneOverlayMarks and roomDots; createLoop; PathCache; BubbleSet; caption strip (R-V32); coarse toggle
//   log.ts    createLogPanel(root): LogModel → DOM via textContent/createTextNode only; quoted frame for teammate text; "new" pill; drawer < 1,100 px
//   rewind.ts createRewind(root): ticks by glyph shape, play/pause, speeds, live pill, load earlier, caught-up marks, keys
//   a11y.ts   the canvas aria-label (UI_VIZ_SCENE_SUMMARY), the hidden people list from peopleList (buttons filter the log), aria-live log, reduced-motion
//             and pause toggles
//   app.css   light and dark token sets (prefers-color-scheme), accent #D97757, image-rendering: pixelated, visible focus, ≥ 4.5:1 text contrast
//   Task 19 (F32) wires follow into office.ts (FollowCamera and cameraTarget instead of FollowRule in a room with a follow; followMotion picks a
//             300 ms smooth scroll or a jump), log.ts (the UI_VIZ_CTRL_FOLLOW toggle on the person-filter chip with aria-pressed; the now card as a
//             region labelled by UI_VIZ_FOLLOWING above the log, below the catch-up panel when F04-b shows one; textContent only) and a11y.ts (the
//             second toggle per hidden people-list row; follow start and end offered to the Announcer); one FollowSet per page, in memory only
```

### Tools, test helpers and lint

```ts
// tools/viz/boardWriter.ts (tests and the storyboard; never shipped)
export interface ScriptPeer { name: string; peer: PeerId; epoch: EpochId; seq: number; display: string; pluginVersion: string; regionSpec: string; coauthorOptin: false | string; }
export interface ScriptCs { csId?: string; seat?: string; state?: 'closed' | 'checkpoint'; origin?: 'prompt' | 'wake' | 'human'; checks?: 'pass' | 'fail' | 'skipped'; paths: readonly string[]; }
export interface ScriptCommit {
  writer: string | null; ops?: readonly OpDraft[]; rawOps?: readonly string[]; cs?: readonly ScriptCs[];
  code?: 'unchanged' | 'ordinary' | 'base_move'; seats?: readonly string[]; badWriterTrailer?: boolean;
}
export class BoardWriter {
  /** V10: over a runner and the paths of a clone (makeRepoFixture().runner and .paths); one GitRepo per writer peer with
   *  ctx = () => ({ attrTree: null, filterDrivers: [], identity: { name: peer.display, email: `${peer.peer}@cowork.invalid` }, wallMs: o.wallMs ?? (() => FIXTURE_WALL_MS) })
   *  (SEC-03 identities; commit dates from wallMs, honoured in test builds); ref refs/cowork-remote/<enc(branch)>/board; ids from seededRandom(seed). */
  static create(o: { runner: GitRunner; paths: RepoPaths; branch: string; seed: string; budget?: number; regionSpec?: string; wallMs?: () => number }): Promise<BoardWriter>;
  peer(name: string): ScriptPeer;
  genesis(writer: string): Promise<Oid>;          // L0 (no parents, Cowork-Base: the branch tip) and B0 (caps, join), checkpoint at 0
  join(name: string, o?: { newEpoch?: boolean; pluginVersion?: string; regionSpec?: string; coauthorOptin?: false | string; display?: string }): Promise<Oid>;
  /** A live commit per `code` (ordinary: [prevLive]; base_move: [prevLive, X] with Cowork-Base X; unchanged: none) with liveCommitTrailers, and a
   *  board commit by buildBoardCommit, its checkpoint the writer's own foldCommit + serializeFold at heights % 256 === 0; update-ref of the ref. */
  commit(c: ScriptCommit): Promise<Oid>;
  rewrite(fromHeight: number): Promise<Oid>;      // a non-fast-forward board diverging at fromHeight
  /** R-V19/F8 fixtures, built with hash-object/mktree/commit-tree (dev tooling): a board commit whose ops.jsonl is over 64 KiB ('board_ops_too_large'),
   *  a board commit naming a tag as its live commit ('live_not_commit') or a three-parent live commit ('live_three_parents'). */
  malformed(kind: 'board_ops_too_large' | 'live_not_commit' | 'live_three_parents'): Promise<Oid>;
  /** One git fast-import for long fixture boards; the same identities, dates and oids as step-by-step commit() (tested). */
  commitMany(cs: readonly ScriptCommit[]): Promise<Oid>;
  readonly ref: string;
  tip(): { oid: Oid; height: number };
  fold(): FoldState;
}
// tools/viz/export-demo.ts — node tools/viz/export-demo.ts --git-dir <abs> --ref <board ref> [--captions <file>] [--oplog <file>] --out <file>
/** One commit record per board commit from height 0 (R-V19 encodings: a shape-null live read → code {changed: false, seats: [], base: null}; a
 *  malformed board commit → writer null, ops [], cs [], csPaths {}, held [] with that code; a missing object → throws, the CLI exits 1). */
export function exportDemo(o: { gitDir: string; ref: string; room: DemoRoomHeader; captions: readonly DemoCaption[] }, deps: { git: VizGit }): Promise<Buffer>;
// tools/viz/golden.ts — npm run viz:golden [-- --update]: builds the golden boards (Task 16) and the SIM seeds (Task 18 step B1) and compares or rewrites test/golden/viz/*
// tools/viz/storyboard.ts — node tools/viz/storyboard.ts [--check]: builds the Plan 2 storyboard board (boardWriter, temp repo), exports it with
//   tools/viz/storyboard.captions.jsonl and writes (or, with --check, compares byte for byte) src/viz/demo/plan2.jsonl

// test/helpers/vizSchema.ts (R-V27)
export function viewModelSchemas(): Readonly<Record<'World' | 'RoomVM' | 'TimelinePage' | 'StreamPayload' | 'Session' | 'Strings', object>>;
export function validate(schema: object, value: unknown): string[];   // [] when valid; additionalProperties false everywhere
// test/helpers/vizViewer.ts
/** deps.stores (S20) replaces discovery and the stores; deps.reader and deps.gitRunner may be spies. */
export function startTestViewer(o: Partial<ServeArgs> & { repos?: string[] }, deps?: Partial<ViewerDeps>): Promise<ViewerHandle & { dataDir: string; session(): Promise<string> }>;
export function buildDistOnce(): Promise<string>;   // runs tools/build/build.mjs --outdir <temp> once per test process; returns the dist dir
// test/helpers/vizHttp.ts
export function rawRequest(port: number, bytes: string | Buffer): Promise<{ status: number; headers: Array<[string, string]>; body: Buffer }>;   // node:net, exact bytes
// test/helpers/vizEvents.ts
export type EventOf<K extends SceneEventKind> = K extends SceneEventKind ? Extract<SceneEvent, { kind: K }> : never;   // distributive (grouped kinds)
export function ev<K extends SceneEventKind>(kind: K, at: [number, number, number], fields: Omit<EventOf<K>, 'kind' | 'height' | 'sub' | 'k' | 'seed'>): SceneEvent;   // ruling R-V59
export function draft(o: Partial<BoardDraft> & { writer: WriterId | null }): BoardDraft;
// test/helpers/cdp.ts (Node ≥ 22; no package)
export function findChrome(): string | null;
export function launchChrome(url: string): Promise<{ send(method: string, params?: object): Promise<unknown>; on(event: string, f: (p: unknown) => void): void; close(): Promise<void> } | null>;

// tools/lint/vizRules.ts (R-V34; 12 §9.5)
export interface VizAllow { rule: string; files?: readonly string[]; prefix?: string; }
export const VIZ_ALLOW: readonly VizAllow[];
export function vizAllowed(f: LintFinding): boolean;
/** L-VIZ-DOM (src/viz/client/**: the §9.5 sink list).
 *  L-VIZ-GIT (src/viz/**, V6): the first argument of every `.run(` call and every array literal whose first element is a string literal in
 *  VIZ_GIT_SUBCOMMANDS must satisfy vizGitArgvOk, each non-literal element standing in as the placeholder (a positional slot or the value of a
 *  `--skip=`/`--max-count=` template, never a flag name); other string
 *  tables (sprite maps, SCENE_EVENT_KINDS, PAGE_SUBSET_PREFIXES, HUE_NAMES) are never git argvs; src/viz/cli/** spawns no bare executable name.
 *  L-VIZ-IMPORT: client/** and ui/** import no node:* and nothing from src/ports, src/git, src/engine, src/board/fold.ts; model/** and render/** import no
 *  I/O module; only src/viz/main.ts and src/viz/cli/** import src/viz/cli/**; every module reachable from client/main.ts lies in the R-V35 client program,
 *  type-only imports included; src/entry/{daemon,hook,core,mcp,worker}.ts import nothing from src/viz/**; src/entry/cli.ts imports only src/viz/cli/**.
 *  L-VIZ-URL (R-V55; string and template literals containing '://'): none in src/viz/** except, in src/viz/cli/view.ts, a template with the head
 *  `http://127.0.0.1:`, one substitution and a span starting `/#k=`, and in src/viz/server/http.ts the template `http://127.0.0.1:${…}` exactly.
 *  L-VIZ-NET (S6, V14): in src/viz/** outside client/**, any reference to the globals fetch, WebSocket, EventSource, XMLHttpRequest; in
 *  src/viz/server/http.ts, `request` or `get` on the http import, `Agent`, `connect`, `createConnection`, and a `listen(` whose options object's `host`
 *  is not the string literal '127.0.0.1'. */
export function lintVizSource(file: string, text: string): LintFinding[];
/** L-VIZ-TYPES (R-V35): typechecks <root>/src/viz/client/tsconfig.json with ts.getParsedCommandLineOfConfigFile + createProgram + getPreEmitDiagnostics,
 *  one finding per diagnostic; [] when that file is absent. lint.ts also runs the L-VIZ-IMPORT client-closure check only when it exists. */
export function lintVizClientProgram(root: string): LintFinding[];
```

## Tasks

| # | Task | Group | Depends on | Produces |
|---|---|---|---|---|
| 1 | Scaffolding: lint driver and client typecheck, the `dist/viz.js` build, the git argv grammar | G1 (may run ahead, R-V01) | — | `tools/lint/{lint,vizRules}.ts`, `tools/build/build.mjs`, `tsconfig.json`, `src/viz/client/tsconfig.json`, `src/entry/viz.ts`, `src/viz/assets{,.d}.ts`, `src/viz/source/vizGitArgv.ts`, client stubs |
| 2 | Board seams: verdicts, batched readers, `parseCsActor`, absolute `taskkill`, `VizGit`, the board writer | G2 (gate P) | 1 | `src/board/{fold,boardCommit}.ts` (additive), `src/board/{batchRead,csActor}.ts`, `src/git/runner.ts`, `src/viz/source/vizGit.ts`, `tools/viz/boardWriter.ts` |
| 3 | Text and strings: `sanitize`, `render`, the `en` catalog, the code sets | G1 (may run ahead) | — | `src/text/sanitize.ts`, `src/i18n/render.ts`, `src/viz/i18n/{codes,en}.ts`, `src/viz/cli/strings.ts` |
| 4 | Model types, layout and looks; every type-only declaration later groups import | G1 (may run ahead) | — | `src/viz/model/{events,layout,looks}.ts`, the type parts of `model/{scene,timeline,cards}.ts`, `model/frame.ts`'s types with `toDraft`/`noopDraft`, `source/roomSource.ts`, `server/models.ts`, `server/viewModel.ts` |
| 5 | Scene reducer, placement, start scene, labels | G2 (gate P) | 4 | `src/viz/model/{scene,placement,start,labels}.ts` |
| 6 | Frames, the timeline builder, cards | G3 | 2, 4, 5 | `foldFrame`, the builder and `cardFor` in `src/viz/model/{frame,timeline,cards}.ts` |
| 7 | Room sources: git, demo, `status.json`, rooms, bounded reads | G4 | 2, 6 | `src/viz/source/{git,demo,status,rooms,boundedRead}.ts` |
| 8 | Room store and the poll loop | G5 | 7, 10 | `src/viz/server/{store,poll}.ts` |
| 9 | View model projection | G3 | 3, 4, 5, 10 | `src/viz/server/{project,api}.ts`, `test/helpers/vizSchema.ts` |
| 10 | HTTP server, tokens, stream hub, viewer log | G2 (gate P) | 1, 3, 4 | `src/viz/server/{tokens,http,stream,shell,vizLog}.ts`, `test/helpers/vizHttp.ts` |
| 11 | The `view` verb: flags, modes, data directory, git resolution, spawn, opener | G2 (gate P) | 1, 3 | `src/viz/cli/{view,paths,pathTrust,spawn,opener,dataDir,ownerProbe}.ts`, `src/entry/cli.ts` |
| 12 | Art: palette, sprites, raster | G2 (may run ahead once Task 4 merged) | 4 | `src/viz/render/{palette,sprites,raster}.ts` |
| 13 | Page logic (DOM-free) | G3 | 3, 4, 5 | `src/viz/ui/*.ts` |
| 14 | The page | G4 | 6, 9, 12, 13 | `src/viz/client/*` |
| 15 | The viewer process | G6 | 7, 8, 9, 10, 11 | `src/viz/main.ts`, `src/entry/viz.ts`, `test/helpers/vizViewer.ts`, `.github/workflows/viz-slow.yml` |
| 16 | Demo export and golden board timelines | G5 | 7 | `tools/viz/{export-demo,golden}.ts`, `test/golden/viz/board-*.timeline.json`, `package.json` |
| 17 | Browser smoke (Chrome DevTools Protocol, no package) | G7 | 14, 15 | `test/helpers/cdp.ts`, `test/integration/viz/browserSmoke.test.ts` |
| 18 | Plan 2 storyboard, bundled demo, `view --demo`, SIM golden, spec batch, exit sweep | G8 | 15, 16, 17 | `tools/viz/storyboard{.ts,.captions.jsonl}`, `src/viz/demo/plan2.jsonl`, `test/golden/viz/viz-golden-*.timeline.json`, the spec-edit batch |
| 19 | Follow a teammate (F32; owner decision D3; added 2026-10-08, F-8a-1) | G9 | 5, 12, 13, 14, 17, 18 | `src/viz/ui/follow.ts`; `KeyAction` `'follow'`/`F` in `ui/a11y.ts`; the follow wiring in `client/{office,log,a11y}.ts`; the eight codes in `src/viz/i18n/{codes,en}.ts` and 12 §3.11; browser smoke item (k) |
| 20 | Claim inputs for the viewer's fold (owner choice of 2026-10-08, X-92 decided; F-8a-13) | G10 | 6, 7, 8, 9, 15, 16, 18; Plan 4 Task 8 | `src/viz/source/claimInputs.ts`; `merge-base --is-ancestor` in `vizGitArgv.ts` and `vizGit.ts`; claim inputs in `foldFrame`, `GitRoomSource`, `DemoRoomSource` and `export-demo`; the pending state in `server/store.ts`; `UI_VIZ_CLAIMS_PENDING` in `src/viz/i18n/{codes,en}.ts` and 12 §3.11 |

**Parallel groups.** The controller runs every task of a group concurrently, each in its own worktree cut from `feat/p8a-viz` after the previous group merged, and merges `main` forward only between groups with `npm run ci` green as the gate (R-V01): **G1** {1, 3, 4} → **G2** {2, 5, 10, 11, 12} → **G3** {6, 9, 13} → **G4** {7, 14} → **G5** {8, 16} → **G6** {15} → **G7** {17} → **G8** {18}. Before gate P only G1 and Task 12 may run (they modify no Plan 2 file); Tasks 2, 5, 10 and 11 start after gate P, and Task 12 may merge before them. Every "Depends on" points to an earlier group. Files never overlap inside a group: Task 4 creates every type-only declaration that a later task needs before its owner lands — the type parts of `model/{scene,timeline,cards,frame}.ts` (Tasks 5 and 6 complete them; `toDraft`/`noopDraft` are Task 4's), and the whole of `source/roomSource.ts` (with `DemoCaption`), `server/models.ts` (with `StoreLike`, `PollSink`, `WorldApi`) and `server/viewModel.ts`, which Tasks 7–10, 13 and 14 import; Task 1 creates `source/vizGitArgv.ts`, which Task 2's `vizGit.ts` imports; Task 3 creates `cli/strings.ts`, which Task 11 imports. A file that several tasks write is written by tasks of different groups only (`src/entry/viz.ts`: 1, 15; the client stubs: 1, 14; `src/viz/demo/plan2.jsonl`: 1, 18; `src/viz/i18n/en.ts`: 3, 18; `tools/viz/golden.ts`: 16, 18; the model files: 4, then 5 or 6); `tools/lint/vizRules.ts` is Task 1's alone (later tasks add fixtures, not rules), and `package.json` changes only in Task 16.

**Added 2026-10-08 (cross-plan reconciliation).** **G9** {19} runs after G8 (Task 19, F32, owner decision D3, F-8a-1); it writes files of earlier groups only after they merged (`ui/a11y.ts` of 13, `client/{office,log,a11y}.ts` of 14, `browserSmoke.test.ts` of 17, `i18n/{codes,en}.ts` of 3 and 18, `test/unit/viz/i18n.test.ts` of 3, `exitSweep.test.ts` of 18). Task 16's `viz:golden` commit may merge ahead of the rest of G5 (F-8a-5, Task 16 amendment). `tools/lint/vizRules.ts` stays 8a's for its rule logic, but F04-a (the R-V35 client-program list, X-76) and 8b (R8B-43) edit it with the 8a reviewer, and Plan 7 Task 1 moves the `VIZ_ALLOW` entries to `tools/lint/allow.ts` (X-98). **G10** {20} (owner choice of 2026-10-08) runs once Plan 4 Task 8 has merged into `main` and `main` has been merged forward — after G9, or, when 8a has exited first, as a follow-up with the same owner, like F04-b; it edits files of Tasks 1, 2, 4, 6, 7, 8, 9, 15, 16 and 18 only after they merged, and it is part of 8b's gate Q. The follow-ups F-8a-2, F-8a-6, F-8a-7, F-8a-8, F-8a-9 and F-8a-11 are listed after Task 20.

Every task: TDD (failing test first, then code), real git against `file://` bare remotes (never mocked), deterministic timelines (no clock, no randomness in `model/**`), `npm run ci` green before its commit, one commit per green step ending with the Co-Authored-By line. Test titles below are the `test(...)` names; each line after the dash is what the test asserts. No task places a crashpoint.

---

### Task 1: Scaffolding — lint driver, client typecheck, the `dist/viz.js` build, the git argv grammar

**Group:** G1 (parallel with 3, 4; may run ahead of Plan 2's exit, R-V01). **Depends on:** nothing in 8a.

**Files:**
- Modify: `tools/lint/lint.ts` (apply `vizAllowed` to `lintSource` findings, add `lintVizSource`, and — only when `<root>/src/viz/client/{tsconfig.json,main.ts}` exist — the client-closure check and `lintVizClientProgram`; the summary line's file count unchanged), `tools/build/build.mjs` (seventh entry, client pre-bundle, `viz-asset:*` plugin, all inline after the `--outdir` guard, R-V36), `tsconfig.json` (exclude `src/viz/client/**`), `test/integration/build.test.ts` (seven entries). `package.json` is not touched (R-V35).
- Create: `tools/lint/vizRules.ts`, `src/viz/source/vizGitArgv.ts`, `src/viz/client/tsconfig.json` (standalone, R-V35), `src/viz/client/main.ts` (stub: no DOM access beyond a `textContent` placeholder), `src/viz/client/app.css` (stub), `src/viz/assets.ts`, `src/viz/assets.d.ts`, `src/entry/viz.ts` (`--version`, no-argument no-op; `serve` → exit 1 until Task 15), `src/viz/demo/plan2.jsonl` (placeholder: a minimal valid log — the header of one room `shop-app` and one height-0 commit with `protocol`, `caps` and `join` — so `--demo` works from Task 15 on; replaced in Task 18)
- Test: `test/unit/viz/lints.test.ts`, `test/unit/viz/vizGitArgv.test.ts`, `test/integration/viz/bundle.test.ts`, `test/integration/viz/lintClient.test.ts`

**Interfaces:**
- Consumes: Plan 1 `lintSource`, `LintFinding`, the build script's `ENTRY_NAMES` and metafile option. `vizGitArgv.ts` imports nothing (it is read by the lint as well as bundled): its `<oid>` test is the same expression as Plan 1's `isOid` (`OID_RE`), pinned equal by a test.
- Produces: `VizAllow`, `VIZ_ALLOW`, `vizAllowed`, `lintVizSource`, `lintVizClientProgram`; `VIZ_GIT_SUBCOMMANDS`, `vizGitArgvOk`; `VizAssets`, `VIZ_ASSETS`; the `viz` entry; the client typecheck inside `npm run lint`.

**Spec:** 12 §3.13 (modules, Build), §9.5 (L-NET, L-PORTS, L-CLOCK/L-RANDOM/L-FS-PORT/L-GIT-* exemptions, L-VIZ-DOM, L-VIZ-GIT, L-VIZ-IMPORT), §9.3 (INV-EGRESS URL template); VIZ-01, VIZ-07 (allowlist grammar), VIZ-20, VIZ-37 (lint half); rulings R-V34, R-V35, R-V36, R-V54, R-V55.

**Tests:**
- `"T-VIZ-lints: VIZ_ALLOW exempts exactly http.ts's node:http load from L-NET, spawn/opener/ownerProbe from L-PORTS, ownerProbe and boundedRead from L-FS-PORT, and src/viz/client/** from L-CLOCK, L-RANDOM, L-FS-PORT and every L-GIT-* rule"` — the same planted line in `src/viz/server/store.ts`, `src/viz/ui/x.ts` and `src/viz/cli/view.ts` still fires; a client array starting `'restore'`, `'apply'` or `'switch'` does not fire L-GIT-FORBIDDEN there.
- `"T-VIZ-lints: L-VIZ-DOM fires on every 12 §9.5 sink in src/viz/client/** and on nothing else"` — one planted fixture per sink (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `setHTMLUnsafe`, `parseHTMLUnsafe`, `document.write`, `DOMParser`, `createContextualFragment`, `srcdoc`, `eval`, `new Function`, string `setTimeout`, `setAttributeNS`, `setAttribute('on…'|'href'|'src'|'style'|…)`, a non-literal `.href`/`.src`/`location`, `style.setProperty`, `insertRule`, a non-literal `replaceSync`, a non-numeric non-enum style write, `window.open`, a `message` listener, dynamic `import()`, `WebSocket`, `EventSource`, `sendBeacon`, `XMLHttpRequest`, `Worker`, a `fetch` whose first argument is a variable or does not start with the literal `/api/v1/`); `textContent`, `createTextNode`, `.value`, `fillText`, a Blob-URL download link, `fetch('/api/v1/world')` and `` fetch(`/api/v1/rooms/${room}/timeline?from=${a}&to=${b}`) `` pass.
- `"T-VIZ-lints: L-VIZ-GIT checks .run( argvs and git-subcommand array literals against vizGitArgvOk, and bare executable names spawned in src/viz/cli/**"` — `['rev-parse', '--verify', '-q', ref]`, `['rev-list', '--first-parent', '--max-count=1281', tip]` and `` ['rev-list', '--first-parent', `--skip=${a}`, `--max-count=${b}`, tip] `` (the form `VizGit.chain` and R-V31 send) pass; `['log']`, `['cat-file', 'blob', x]`, `['for-each-ref', 'refs/heads/']`, `['rev-list', '--first-parent', '--all']`, `spawn('taskkill', …)` and `spawn('explorer', …)` fire; a non-literal element never matches a flag slot (`['rev-list', flag, tip]` fires).
- `"T-VIZ-lints: L-VIZ-GIT ignores string tables that are not git argvs"` — a 16-row sprite map, `SCENE_EVENT_KINDS`, `PAGE_SUBSET_PREFIXES` and `HUE_NAMES` planted in `src/viz/render/` and `src/viz/model/` do not fire (V6).
- `"vizGitArgvOk accepts exactly the Global Constraints forms"` — S22: `['rev-list','--first-parent','--all']`, `['rev-parse','--verify','-q','refs/cowork-local/x']`, `['rev-list','--first-parent','HEAD']`, a `--max-count=01`, `--skip=-1`, an extra trailing argument and `['cat-file','-p',oid]` are refused; every allowed form with a real oid and ref passes; its `<oid>` test agrees with Plan 1's `isOid` over a fast-check corpus.
- `"T-VIZ-lints: L-VIZ-IMPORT fires on node:* or src/ports|src/git|src/engine|src/board/fold.ts imports from client/** or ui/**, on an I/O module in model/** or render/**, on a src/viz/cli/** import from server/** or source/**, on any src/viz import from the daemon, hook, core, mcp or worker entries, and on a non-cli src/viz import from src/entry/cli.ts"`.
- `"T-VIZ-lints: L-VIZ-URL allows only the launch template in view.ts and the origin template in http.ts"` — R-V55: `` `http://127.0.0.1:${port}/#k=${k}` `` in view.ts and `` `http://127.0.0.1:${port}` `` in http.ts pass; the origin template in view.ts, the launch template in http.ts, `'http://localhost:1/'` anywhere and a URL template in `src/viz/server/store.ts` fire.
- `"T-VIZ-lints: L-VIZ-NET forbids client network use in server code"` — S6: a planted `fetch(x)` in `store.ts`, `http.get(u)`, `http.request(u)`, `new http.Agent()` and `net.connect(p)` in `http.ts`, and `server.listen({ host: h })` with a non-literal host fire; `listen({ host: '127.0.0.1', port: 0, exclusive: true })` passes.
- `"build produces exactly the seven dist entry points, each runnable on its own"` — (modified Plan 1 test) `cli, core, daemon, hook, mcp, viz, worker`; `--version` prints `cowork-sync <name> 0.0.0`; no argument → exit 0, empty stdout; every metafile import is an external `node:` built-in.
- `"build refuses an --outdir it must not empty"` — Plan 1's test runs unchanged against the new `build.mjs` (copied alone, no `src/viz`): exit 2, nothing deleted (V12).
- `"T-VIZ-lints: viz.js bundles the client, app.css and the demo log as text; node:http appears only in viz.js; cli.js contains src/viz/cli/** and no other src/viz module; no src/viz module in daemon, hook, core, mcp or worker; the client bundle contains no module importing src/board/fold.ts; dist/viz.js ≤ 1.5 MB"` — from the metafile of both esbuild passes; rerun by every later task's CI (it goes red if a later task makes `cli.js` reach `src/viz/i18n/**`, R-V54).
- `"src/viz/assets.ts is imported only by src/entry/viz.ts"`.
- `"T-VIZ-lints: the main program excludes src/viz/client/** and npm run lint typechecks the client program with lib DOM"` — a DOM global referenced from `src/viz/server/` fails `npm run typecheck`; a `Buffer` referenced from `src/viz/ui/` fails `npm run lint` with `L-VIZ-TYPES`; `package.json`'s `typecheck` script is unchanged (`test/unit/ci-config.test.ts` stays green).
- `"T-VIZ-lints: the client program's import closure is exactly the R-V35 set"` — a planted type-only import of `src/viz/model/timeline.ts` (or of `src/board/fold.ts`) from `src/viz/ui/` fails L-VIZ-IMPORT and `L-VIZ-TYPES`.
- `"lint over a --root without src/viz/client keeps Plan 1's output"` — Plan 1's two-file `--root` test still prints `lint: 2 files, 0 findings` (V13).

**Crashpoints:** none. **Lint:** adds L-VIZ-DOM, L-VIZ-GIT, L-VIZ-IMPORT, L-VIZ-URL, L-VIZ-NET, L-VIZ-TYPES and the `VIZ_ALLOW` exemptions.

---

### Task 2: Board seams — verdicts, batched readers, `parseCsActor`, absolute `taskkill`, `VizGit`, the board writer

**Group:** G2 (parallel with 5, 10, 11, 12). **Gate:** gate P (Plan 2 has landed and `main` is merged forward, R-V01), and the two Plan 2 deferred items of R-V02 are marked fixed or won't-fix in the Plan 2 ledger. **Depends on:** 1 (`vizGitArgv.ts`).

**Files:**
- Modify: `src/board/fold.ts` (additive: `OpVerdictKind`, `OpVerdict`, `FoldStepResult.opVerdicts`, the bookkeeping inside `foldCommit`), `src/board/boardCommit.ts` (the word `export` on the eight declarations of R-V02), `src/git/runner.ts` (`killTree`)
- Create: `src/board/batchRead.ts`, `src/board/csActor.ts`, `src/viz/source/vizGit.ts`, `tools/viz/boardWriter.ts`
- Test: `test/unit/viz/verdicts.test.ts`, `test/unit/viz/csActor.test.ts`, `test/integration/viz/batchRead.test.ts`, `test/integration/viz/vizGit.test.ts`, `test/integration/viz/boardWriter.test.ts`, `test/unit/viz/runnerKill.test.ts`

**Interfaces:**
- Consumes: Task 1 `vizGitArgvOk`; Task 4 `toDraft` (through the `draft()` test helper); Plan 2 `foldCommit`, `initialFoldState`, `FoldStepResult`, `PLAN2_FOLDED_TYPES`, `parseOpLine`, `parseOpId`, `readBoardCommit`, `BoardCommitData`, `BoardMalformedReason`, `parseWriter`, `parseCsTrailers`, `liveCommitTrailers`, `boardTrailers`, `buildBoardCommit`, `serializeOps`, `serializeFold`, `formatMessage`, `parseMessage`, `GitRepo`, `RepoPaths`, `RepoContext`, `makeRepoFixture`, `FIXTURE_WALL_MS`; Plan 1 `createGitRunner`, `GitRunner`, `GitRunnerDeps`, `watchdogMs`, `buildDaemonEnv`, `parseGitVersion`, `meetsFloor`, `Fs`, `seededRandom`, `enc`.
- Produces: `OpVerdictKind`, `OpVerdict`, `FoldStepResult.opVerdicts` (recorded in 8a's contract only, R-V02); `BatchGit`, `READ_BATCH_MAX`, `LiveRead`, `LiveReadFailure`, `BoardRead`, `BoardReadFailure`, `isBoardReadFailure`, `readBoardCommits`, `readLiveCommits`, `parseCommitObject`; `CsActor`, `parseCsActor`; `VIZ_GIT_CONFIG`, `VIZ_GIT_ENV`, `VIZ_GIT_WATCHDOG_MS`, `VizGitRefused`, `VizGit`, `vizGitRunner`, `createVizGit`; `ScriptPeer`, `ScriptCs`, `ScriptCommit`, `BoardWriter` (with `malformed()` and with `commitMany` through one `git fast-import` for long fixture boards, test tooling only).

**Spec:** 12 §9.7 items 1–6 and 8 (R-V03…R-V08), §3.3.2 (read set, batches), §3.3.3 (per-op verdicts, self), VIZ-06, VIZ-07, VIZ-08; glossary §18; 02-protocol §3.3; Plan 2 ledger (board size caps, P2-UTF8, P2-GRAFTS); rulings R-V02, R-V03, R-V05, R-V06, R-V09, R-V10, R-V19.

**Tests:**
- `"opVerdicts has one entry per ops.jsonl line, in order"` — including an empty board, 1,000 lines, and a commit whose writer is null (every line `rejected`/`generic`).
- `"effective for join, leave, caps, seat_start, seat_end, event and save; unfolded for claim, release, request, request_status, answer, note, presume_absent and hold; rejected with malformed, generic or type"` — fixtures: bad JSON, nesting past `MAX_JSON_DEPTH`, an op whose id `parseOpId` refuses (`malformed`), an unknown type, a wrong writer, a seq ≤ last_seq, out-of-order seqs, a duplicated op id (first line decides, the second is `generic`), a retired epoch, an op past the 64 KiB loop bound, a `seat_start` of a live seat (`type`), a conflict-kind event whose cid is folded (`type`).
- `"state and opVerdicts do not depend on self"` — 12 §9.7 item 6: the same 600-commit chain folded with `self` = each writer and = 32 zeros gives byte-identical `serializeFold` at every height and identical verdicts.
- `"tripwire: every OpType outside PLAN2_FOLDED_TYPES folds as a no-op"` — for each such type a generic-valid op leaves the state equal to the same commit without it except the writer's `last_seq`; fails (by design) when a later plan gives a type an effect without moving it into the folded set (R-V03).
- `"parseCsActor accepts <peer>/human/<n> and <seat>/<turn-seq> and refuses near misses"` — 31 and 33 hex, upper case, n = 0, a leading zero, an extra segment, a seq beyond `MAX_SAFE_INTEGER`.
- `"readBoardCommits equals readBoardCommit for every oid of a 600-commit scripted board, except checkpoint off multiples of 256"` — 12 §9.7 item 8; `csPaths` equals `decodeCsPaths` of each `Cowork-CS-Paths` trailer; a > 256-path change-set has none.
- `"parseCommitObject equals GitRepo.readCommit"` — on board, live, genesis and base-move commits.
- `"a batch is exactly one cat-file --batch-check and one cat-file --batch process"` — runner spy over ≤ 1,280 items with live commits included; 1,281 items → `RangeError`; a live commit whose oid equals the preceding item's is reported `'same'` and not read again.
- `"over-cap, mistyped and missing objects are reported and never read"` — fixtures (built with `git hash-object -w` and `mktree` in the test, never through `src/`): a 2 MiB commit message (`commit_too_large`), a tag oid (`not_commit`), a 70 KiB `ops.jsonl` (`ops_too_large`), a 5,000,001-byte checkpoint (`board_too_large`), a parentless commit (`no_parent`), a missing object (`missing`); the oversized object's oid never appears on the `--batch` stdin; the same reasons for over-cap live commits.
- `"live reads: parents, writer, seats, cs, csPaths, base and info match what the writer put in liveCommitTrailers"` — genesis `L0` (`<B0>^1`), ordinary, base move and board-only (`'same'`).
- `"every VizGit call carries --no-replace-objects, an absolute --git-dir, cwd = the data directory, protocol.allow=never and protocol.{file,git,http,https,ssh}.allow=never, the runner's protocol.ext.allow=never, GIT_OPTIONAL_LOCKS=0 and GIT_NO_LAZY_FETCH=1, and an absolute git path"` — `buildGitInvocation` spy; `vizGitRunner` with a relative `gitPath` throws.
- `"VizGit refuses an argv outside the allowlist before spawning"` — `VizGitRefused` for `log`, `cat-file -p`, `rev-list` without `--first-parent`, `rev-list --first-parent --all`, `rev-parse --verify -q refs/cowork-local/x`, `for-each-ref refs/heads/`, `fetch`; no process started.
- `"remoteRefs uses for-each-ref --format=%(objectname) %(refname); for-each-ref -z is never sent"` — R-V09.
- `"version() uses the subcommand version and meetsFloor"` — R-V10; a fake runner printing `git version 2.42.9` → below the floor.
- `"a promisor clone's missing live commit is never lazily fetched"` — S5: a partial clone whose `file://` promisor remote is present and holds the missing live commit; `readLiveCommits` reports it `missing`; after the run `git cat-file -e <oid>` (with `GIT_NO_LAZY_FETCH=1`) still fails in the clone; negative control: the same `cat-file --batch-check` through the test runner without `VIZ_GIT_CONFIG` and `VIZ_GIT_ENV` fetches it (the fixture really would lazy-fetch).
- `"killTree spawns taskkill.exe by absolute path"` (Windows legs) — a `taskkill.exe` planted in the process cwd and on a relative PATH entry never runs; the git child and its grandchild are gone; without an absolute `SystemRoot` only `child.kill` runs.
- `"the board writer's boards pass boardShapeOk and liveShape and carry checkpoints that byte-match the fold"` — genesis, ordinary, base move, board-only steps; `rewrite(h)` yields a chain whose old tip is not a first-parent ancestor of the new one; each writer peer's commits carry `<peer>@cowork.invalid` and the `wallMs` dates (V10); `malformed(kind)` yields the three R-V19 fixtures (`readBoardCommits`/`readLiveCommits` report `ops_too_large`, `not_commit`, and a live shape `null`).
- `"commitMany and step-by-step commit give identical oids"` — same dates and identities through `git fast-import` and `commit-tree`; a 1,024-height board is written in under 10 s.

**Reconciliation note (2026-10-08; X-90, F-8a-6; binds this task's merge, changes no reviewed code).** Task 2 and Plan 3 Task 3 edit the same `foldCommit` loop and `FoldStepResult`: the second of the two to merge rebases (Plans 4 and 6 later rebase onto both), and `opVerdicts` stays exact (effective iff `applyOp` is true and the type ∈ `PLAN2_FOLDED_TYPES`). If Plan 3 Task 3 (which adds `hold` to `PLAN2_FOLDED_TYPES`) has merged first (into `main`, merged forward into `feat/p8a-viz`), this task's merge lists `hold` as effective in `verdicts.test.ts`; otherwise Plan 3's merge flips that row (the commit that adds a type to the set flips its rows). The landed forms — `BatchReads<T>` (R-V69), `'unreadable'` (R-V74), and `runnerKill.test.ts` in `test/integration/viz/` (the Files line's `test/unit/viz/` path is stale) — are ratified as written in the code (§Interfaces, "Board seams").

**Crashpoints:** none. **Lint:** none (L-VIZ-GIT covers `vizGit.ts`).

---

### Task 3: Text and strings — `sanitize`, `render`, the `en` catalog, the code sets

**Group:** G1 (parallel with 1, 4; may run ahead of Plan 2's exit, R-V01). **Depends on:** nothing in 8a.

**Files:**
- Create: `src/text/sanitize.ts`, `src/i18n/render.ts`, `src/viz/i18n/codes.ts`, `src/viz/i18n/en.ts`, `src/viz/cli/strings.ts`
- Test: `test/unit/viz/sanitize.test.ts`, `test/unit/viz/render.test.ts`, `test/unit/viz/i18n.test.ts`

**Interfaces:**
- Consumes: nothing beyond Node built-ins (`Intl.Segmenter`, `Intl.NumberFormat`, `Intl.PluralRules`).
- Produces: `SanitizeChannel`, `sanitize`, `CapKind`, `VIZ_CAPS`, `VIZ_RAW_UNITS`, `NAME_RAW_MAX`, `MARKS_PER_GRAPHEME_MAX`, `cap`; `Lang`, `LANGS`, `RenderChannel`, `ParamType`, `CatalogEntry`, `Catalog`, `Params`, `CHANNEL_CAPS`, `registerCatalog`, `registerReasonCodes`, `render`, `renderWith`; `CodeGroup`, `VIZ_CODES`, `ALL_VIZ_CODES`, `DEMO_CAPTION_CODES`, `PAGE_SUBSET_PREFIXES`, `FREEZE_REASON_CODES`, `HEALTH_REASON_CODES`, `PUBLISH_PAUSE_CODES`, `STATUS_STATES`, `PH_CODES`, `SS_CODES`, `CHARACTER_BADGES`, `REASON_CODES`, `PAGE_CODES`, `EN_VIZ`; `EN_VIZ_CLI`.

**Spec:** SEC-34 (+ channel `viz`, 12 §9.3), 10-product §3.2 (+ the `viz` row, 12 §9.4), §3.14 (`PH_*`, `SS_*` en wording), 12 §3.3.7 (card placeholders), §3.11 (channel `viz` caps, the code table), glossary §14 (status enums), §19; VIZ-36 (sanitize half), VIZ-39 (`en`); rulings R-V15, R-V38, R-V43, R-V50, R-V53, R-V54.

**Tests:**
- `"sanitize strips controls, ANSI CSI, OSC 8, OSC 52, bidi, zero-width, format and tag characters in every channel and keeps \\n only in claude"`.
- `"sanitize applies NFC, makes < and > full-width, replaces URLs with [link removed] and removes leading / command tokens on every line"`.
- `"in notification and viz every line break becomes one space and every run of three or more dash-like characters becomes —"`.
- `"cap: name 20 rendered (64 raw), label 80, path 80 and plaque 16 with a middle ellipsis, note 280, branch 80, room 40, card 400, tooltip 200, caption 120, counted in graphemes"` — Hangul, Han, emoji ZWJ sequences, combining marks.
- `"cap cuts to VIZ_RAW_UNITS first, at a grapheme boundary, and keeps at most 4 combining marks per grapheme"` — R-V50: an 80-emoji family-ZWJ path and an 80-grapheme path with 30 combining marks each come out ≤ `VIZ_RAW_UNITS.path` code units and never split a surrogate pair or a ZWJ sequence; a name never exceeds 64 code units.
- `"sanitize is total and idempotent"` — fast-check over arbitrary strings including lone surrogates and 10 KB inputs; `sanitize(sanitize(x)) === sanitize(x)`; never throws.
- `"render looks up the language, falls back to en, sanitizes and caps every placeholder by its type, formats n and dur, nests reason once and refuses an over-cap result with UI_TEXT_TOO_LONG outside the viz channel"`.
- `"T-VIZ-i18n: in the viz channel an over-cap result is end-ellipsized to 400 graphemes and UI_TEXT_TOO_LONG never appears"` — R-V53 (VIZ-39: no code outside the §3.11 table).
- `"render nests a reason parameter only when it is a registered reason code"` — R-V43: `EPOCH` nests its template; `UI_VIZ_LINK_REUSED`, `RF_VIZ_START_FAILED`, `SEC_VIZ_BAD_HOST`, `PH_OK` and an unregistered `ZZZ_CODE` render as `?` and their templates never appear; `registerReasonCodes` throws on a code prefixed `UI_`, `RF_`, `SEC_`, `VIZ_`, `PH_`, `SS_` or `START_`.
- `"the closed code sets hold only their registry values and no page-state code"` — `FREEZE_REASON_CODES` equals glossary §14's `freeze_reasons`, `PUBLISH_PAUSE_CODES` its `publish_pause`, `STATUS_STATES` its `state`; `PH_CODES`/`SS_CODES` equal 10-product §3.14's lists; `REASON_CODES` is their union and every one has an en template; `PAGE_CODES` contains every `PAGE_SUBSET_PREFIXES` code, `REASON_CODES` and `UI_INTERNAL_ERROR`.
- `"a url parameter survives only on the terminal channel and only in the launch-URL shape"` — S21: the viz channel, a `file:` URL, another host and a 63-hex token give `[link removed]`; only `UI_VIZ_URL` declares a `url` parameter.
- `"registerCatalog: an identical entry again is a no-op, a different one throws; EN_VIZ contains every EN_VIZ_CLI entry unchanged"` — R-V54 (`cli.js` registers `EN_VIZ_CLI`, `viz.js` registers `EN_VIZ`).
- `"renderWith over a fetched catalog and the bundled reason set equals render over the registered ones"`.
- `"T-VIZ-i18n (en): every code of the 12 §3.11 table is in VIZ_CODES and has an en template; every template fits the viz caps at worst-case parameters; every UI_VIZ_CARD_* template uses only {name}, {target}, {n}, {path}, {id} and {label}; the other codes use only those and {people}, {sessions}, {open}, {conflicts}, {zone}, {height}, {reason}, {cmd}, {est_minutes}, {lo}, {hi} and (UI_VIZ_URL only) {url}"` — F22 (12 §3.3.7: card templates take only the six, so anonymize changes no served data); every code matches `^[A-Z][A-Z0-9_]{2,47}$`.
- `"every code literal in src/viz/** is in ALL_VIZ_CODES"` — a source scan for `^(UI|RF|SEC|VIZ|PH|SS|START)_[A-Z0-9_]+$` string literals (VIZ-39 "no code outside the §3.11 table"); runs in every later task's CI.
- `"T-VIZ-notes (render): teammate text is never a code"` — `render` refuses a `code` that is not in a registered catalog without echoing it.

**Crashpoints:** none. **Lint:** none.

---

### Task 4: Model types, layout and looks; every type-only declaration later groups import

**Group:** G1 (parallel with 1, 3; may run ahead of Plan 2's exit, R-V01). **Depends on:** nothing in 8a.

**Files:**
- Create: `src/viz/model/events.ts`, `src/viz/model/layout.ts`, `src/viz/model/looks.ts`; the type-only parts of `src/viz/model/scene.ts` (`Place`, `ActorState`, `CharacterState`, `PetState`, `DeskState`, `ClaimState`, `Scene`, `TimelineView`, the constants, `comparePos`, `emptyScene`), `src/viz/model/timeline.ts` (`WindowInput`, `Timeline`, `Carry`, `FrameOutput`, the constants), `src/viz/model/cards.ts` (`Card`, `SceneRow`, `CARD_GROUP`) and `src/viz/model/frame.ts` (`Frame`, `FrameCode`, `FrameInput`, `ZERO_PEER`, and the two builders `toDraft`, `noopDraft`); the whole of `src/viz/source/roomSource.ts` (with `DemoCaption`), `src/viz/server/models.ts` (with `WorldApi`) and `src/viz/server/viewModel.ts` (types only, R-V26); `test/helpers/vizEvents.ts`
- Test: `test/unit/viz/events.test.ts`, `test/unit/viz/layout.test.ts`, `test/unit/viz/layout.prop.test.ts`, `test/unit/viz/looks.test.ts`, `test/unit/viz/viewModel.types.test.ts`

**Interfaces:**
- Consumes: Plan 2 `PeerId`, `FoldState`, `PeerRec`, `CsTrailer`, `WriterId`, `ProtocolJson`, `BoardDraft` (types only), `Json`.
- Produces: everything of §Interfaces "World model" for `events.ts`, `layout.ts`, `looks.ts`, the declarations listed above for `scene.ts`, `timeline.ts`, `cards.ts`, `frame.ts`; every declaration of `roomSource.ts` (`TipInfo`, `Advance`, `RoomSpec`, `RoomSource`, `Overlay`, `DemoCaption`), `models.ts` (`Tick`, `RoomBadge`, `PeerInfo`, `CardModel`, `PetInfo`, `RoomDelta`, `TimelinePageModel`, `RoomSnapshotModel`, `StoreLike`, `PollSink`, `WorldApi`) and `viewModel.ts` (every alias, `EventVM` … `StreamPayload`); `ev`, `draft` helpers (`draft` builds through `toDraft`).

**Spec:** 12 §3.3.7 (types), §3.10.6 (served shapes), §3.5.1–§3.5.3 (map, grid, coordinates, allocation), §3.6 (look assignment, home-spot order), §3.10.7 (Map keys); VIZ-16, VIZ-18, VIZ-37 (keys half); rulings R-V20, R-V22, R-V23, R-V25, R-V26, R-V47, R-V51.

**Tests:**
- `"SCENE_EVENT_KINDS is exactly the closed set of 12 §3.4"` — and every member of the `SceneEvent` union has a kind in it (type-level exhaustiveness check); `pet_spawn` and `pet_poof` carry `owner` (R-V47).
- `"viewModel.ts imports nothing and every EventVM kind mirrors a SceneEvent kind"` — the test file imports both modules and checks at the type level that `EventVM['kind']` equals `SceneEventKind`; `viewModel.ts` itself has no import declaration and never references `events.ts`.
- `"zoneOf: s1/s2 for three or more segments, s1 for two, · for a root-level file"`.
- `"T-VIZ-layout: allocation is append-only"` — fast-check over random path sequences: no existing desk's ordinal, key, zone, cell, slot or `first` ever changes; ordinals are allocation order; the big table is 0 with `first` 0; `version` +1 per desk or cell; each desk's `first` is the height it was first touched at (R-V51).
- `"T-VIZ-layout: the 16th zone goes to …, with one folder desk per overflow folder"` — and the `…` zone's 24th folder goes to its shelf.
- `"T-VIZ-layout: the 24th file of a zone goes to its shelf desk in the 24th slot; a zone grows annex cells up to 4"`.
- `"T-VIZ-layout: the same path sequence twice gives identical layouts"` — byte-identical canonical serialization.
- `"T-VIZ-layout: appending an earlier page's paths after every existing desk changes no ordinal"` — the "load earlier" form (§3.5.3).
- `"T-VIZ-layout: isDashed keeps the head layout and dashes exactly the desks first touched after the position"` — R-V51: at every position of a 3-segment fixture the set of dashed desks is `{d | d.first > at.height}`; live (`null`) dashes none.
- `"T-VIZ-layout: coordinates follow 12 §3.5.2"` — home spots (2 + 2·(i mod 8), 1 + ⌊i / 8⌋); spot ≥ 16 → the door cluster round-robin; cell origin (7·(g mod 3), 4 + 10·⌊g / 3⌋); slot origin, desk, chair and the four visitor tiles; the big table (17–20, 1–2), its chair (18, 3) and visitors; office width 21, height 4 + 10·⌈cells / 3⌉.
- `"blocked tiles are exactly the lobby wall, desk tiles and big-table tiles"`.
- `"T-VIZ-text (layout): paths __proto__/a.ts, constructor/b.ts, prototype/c.ts and a root __proto__ lay out as ordinary desks and change no prototype"` — `Object.prototype` unchanged, `deskOf` is a `Map`.
- `"applyLayoutDelta reproduces the builder's layout and refuses a delta from another version"`.
- `"T-VIZ-looks (model): lookOf follows the 12 §3.6 formula with a big-endian uint32"` — golden vectors; 56 distinct peers can cover all 56 looks; the same peer gets the same look in every call.
- `"homeOrder: start-state peers sorted by peer_id, then first appearance, never reordered"`.
- `"toDraft and noopDraft build exactly Plan 2's BoardDraft fields"` — a compile-time check that the result is assignable to `BoardDraft` with no extra property; `noopDraft` has writer `null`, no ops, no trailers, `heldIds` [], checkpoint `null` and the given `protocol` and `liveCode` (R-V19).

**Crashpoints:** none. **Lint:** none.

---

### Task 5: Scene reducer, placement, start scene, labels

**Group:** G2 (parallel with 2, 10, 11, 12; gate P, R-V01). **Depends on:** 4.

**Files:**
- Modify: `src/viz/model/scene.ts` (`applyEvent`, `SceneReducer`, `reduceScene`, `deskDimmed`, `signVisible`, `isSlowed`)
- Create: `src/viz/model/placement.ts`, `src/viz/model/start.ts`, `src/viz/model/labels.ts`
- Test: `test/unit/viz/scene.test.ts`, `test/unit/viz/placement.test.ts`, `test/unit/viz/start.test.ts`, `test/unit/viz/pets.test.ts`, `test/unit/viz/labels.test.ts`

**Interfaces:**
- Consumes: Task 4 model types; Plan 2 `FoldState`, `PeerRec`, `liveSet`, `rankedSet` (start.ts only).
- Produces: `applyEvent`, `SceneReducer`, `reduceScene`, `deskDimmed`, `signVisible`, `isSlowed`; `targetDesk`, `homeSpot`, `characterPlace`, `petPlace`, `seatDesk`; `startScene`, `ownerOfSeatKey`; `phOf`, `PlaceLabel`, `placeLabel`.

**Spec:** 12 §3.3.5 (start scene, `reduceScene`), §3.4 (Visual column: what each kind does to the scene), §3.5.4 (placement, chairs, walking, persistence), §3.6 (seat variants), §3.7 (persistent versus one-beat "!"); VIZ-10 (purity of `reduceScene`/`startScene`), VIZ-12, VIZ-17, VIZ-21, VIZ-22 (scene half); 10-product §3.14; rulings R-V25, R-V47, R-V56.

**Tests:**
- `"reduceScene starts from the segment with the greatest hs < at.height, or the first, and applies that segment's events up to at"` — three segments, positions on segment boundaries, `at.height = 0`.
- `"SceneReducer and applyEvent agree on every prefix"` — fast-check over random event sequences of every kind.
- `"an actor stays where its last event put it until its next event, person_exit, person_absent, pet_poof or person_ghost"`.
- `"T-VIZ-placement (reducer): publish seats the actor at the target desk, keeps lastPublish and lastDesk, and fills chairs: newest HELD claim holder, else the most recent publisher; claim holders, then publishers by recency on visitor tiles; the fifth visitor makes more = 1"`.
- `"T-VIZ-placement: character precedence: own open human request > newest human change-set newer than every claim op of its pets > supervising beside its pets' desk > home spot"` — hand-written Plan 4/6 events.
- `"T-VIZ-placement: recency compares board positions, not heights"` — F13: a human publish (sub 1,001) and a pet's claim op (sub 1 + line) at the same height: the publish is newer and wins precedence 2; two publishes at one height order by `k`.
- `"T-VIZ-placement: pet precedence: open request > newest HELD claim's chair > granted stool > newest change-set target > behind its character"`.
- `"T-VIZ-placement: only request_open puts an actor facing another actor"` — over every event of this task's hand-written sequences (V4; Task 6 asserts it over its fixtures).
- `"slowed ends at until without an event; the branch sign shows for 64 heights; a desk dims after 256 heights without an event"`.
- `"T-VIZ-anim (scene): a persistent bang exists only while its hold record is non-terminal; an event-sourced conflict and person_bang live in the beat only"`.
- `"T-VIZ-pets (reducer): exactly one pet per seat key"` — `pet_spawn` from `seat_start` and from a footprint, `pet_poof` on `seat_end`, respawn, `presume_absent`, `leave` and an owner ghost for a footprint-only seat; a pet's owner is the event's `owner` (R-V47), and a seat id that is a 6-character handle with no `/` reduces the same.
- `"T-VIZ-pets: seat variants follow the first footprint per owner within a segment; start-scene pets take sorted seat-key order and the owner ownerOfSeatKey gives"`.
- `"T-VIZ-start: startScene gives exactly the 12 §3.3.5 start scene"` — checkpoint fixtures with an active, an absent, a ghost, a frozen (newest event `freeze`), a slowed (`HOST_THROTTLED` 100 heights before `hs`), a different-rules and a credit peer, live and ended seats: characters at home spots, pets behind them, badge from `record_count`, empty beat.
- `"T-VIZ-start: startScene is independent of desks appended later"` — the same state with a 3-desk and a 40-desk layout gives deep-equal scenes (sparse `Scene.desks`).
- `"reduceScene treats ids as opaque"` — renaming every peer and seat id through a bijection commutes with reduction (the page's handle ids, VIZ-26); no function of `scene.ts`, `placement.ts`, `labels.ts` or `cards.ts` splits a seat id.
- `"T-VIZ-placement: a seated publisher is labelled UI_VIZ_LAST_SHARED_HERE with its path and height, a HELD claim holder UI_VIZ_HOLDING, never a working-on code"` — F10, VIZ-17: `placeLabel` over every event kind of this task's sequences returns only those two codes or `null`.
- `"phOf: left, absent, frozen (PAUSED → PH_PAUSED, NOHOOKS → PH_NOT_COORDINATED, other or '?' → PH_FROZEN), slowed, ok — in that precedence; a ghost has no label; no input gives PH_OFFLINE"` — R-V56; fast-check over character states shows `PH_SLOWED` only when no other label applies (10-product §3.14).

**Crashpoints:** none. **Lint:** none.

---

### Task 6: Frames, the timeline builder, cards

**Group:** G3 (parallel with 9, 13). **Depends on:** 2, 4, 5.

**Files:**
- Modify: `src/viz/model/frame.ts` (`foldFrame`), `src/viz/model/timeline.ts` (`TimelineBuilder`, `buildTimeline`, `extendTimeline`, `prependTimeline`, `serializeTimeline`, `eventSeed`, `actorOfCs`), `src/viz/model/cards.ts` (`cardFor`)
- Create (fixtures): `test/fixtures/viz/rows/<row>.json` (one `BoardDraft` sequence per 12 §3.4 row, each marked with its plan, loaded through `toDraft`), `test/golden/viz/rows/<row>.events.json`
- Test: `test/unit/viz/frame.test.ts`, `test/unit/viz/timeline.fixtures.test.ts`, `test/unit/viz/timeline.prop.test.ts`, `test/unit/viz/cards.test.ts`, `test/unit/viz/looks.windows.test.ts`

**Interfaces:**
- Consumes: Task 2 `foldCommit` with `opVerdicts`, `parseCsActor`; Task 4 `LayoutBuilder`, `lookTable`, `toDraft`, `noopDraft`, model types; Task 5 `SceneReducer`, `startScene`, `ownerOfSeatKey`, `targetDesk`; Plan 2 `initialFoldState`, `liveSet`, `rankedSet`, `serializeFold`, `parseOpLine`, `canonicalJson`, `PLAN2_FOLDED_TYPES`.
- Produces: `foldFrame`; `TimelineBuilder`, `buildTimeline`, `extendTimeline`, `prependTimeline`, `serializeTimeline`, `eventSeed`, `actorOfCs`, `BOARD_NEAR_FULL`, `BOARD_FULL`, `SLOWED_HEIGHTS`; `cardFor`.

**Spec:** 12 §3.3.4 (frames), §3.3.5 (steps 1–3, positions, seeds, serialization, start scenes and segments), §3.4 (the rows the Plan 2 fold applies; every `unfolded` row as no event), §3.5.3 (first-touch order), §3.5.4 (change-set actor, target desk), §3.6 (looks), §3.8 (cards); VIZ-08, VIZ-10, VIZ-11, VIZ-12, VIZ-16 (prepend), VIZ-17, VIZ-18, VIZ-21; rulings R-V17, R-V18, R-V19, R-V20, R-V21, R-V42, R-V44, R-V45, R-V47, R-V51.

**Tests:**
- `"T-VIZ-timeline-fixtures: every row the Plan 2 fold applies gives its golden events with positions"` — genesis `room_open` only; `join` → `person_enter`; new-epoch `join` → `person_respawn` then `pet_poof` per retired seat; same-epoch `join` with another `plugin_version` → `person_badge{version}`; regionSpec ≠ teamRegionSpec after a join → `person_badge{rules, on}` at the join's line (and `off`); `coauthor_optin ≠ false` → `person_badge{credit}`; `leave` → `person_exit` + `pet_poof` per seat; `leave` then a same-epoch `join` → `person_exit` … `person_enter` with `UI_VIZ_CARD_JOIN` (R-V42); `seat_start` → `pet_spawn`; `seat_end` → `pet_poof`; seat footprints from `Cowork-Seat` and a seat `cs_id` → `pet_spawn` at sub 1,001 before the publishes (R-V18); every `pet_spawn`/`pet_poof` carries its `owner` (R-V47); one `publish` per `Cowork-CS` trailer; a > 256-path change-set → `publish` at the big table with `paths: []` and `n`; a changed ordinary live commit without trailers → the writer's character at the big table; base move without `save` → `room_sign`; a save completion `Ls` → only `save` with the desks published since the previous save; `freeze`/`unfreeze` → `person_freeze{reasonCode}`/`person_thaw`; `HOST_THROTTLED` → `person_slowed{until: h + 180}`; `BOARD_FULL` and `record_count` 4,000 / 5,000 / 4,500 / back below 4,000 → `room_badge` `near_full`, `full`, `near_full`, `none`; another health code → `person_badge{health}`; `nonretryable` → `person_bang{host}`; `event{breach}` → `conflict{breach, source: 'event', on: <the writer's character>, desk: null, line: null}` (R-V44); `event{K1..K7}` → `conflict{generic}` with `cid`; ghost, unghost, rules and relaxed derived at sub 1,002 in (peer, seat key) order (R-V45).
- `"T-VIZ-timeline-fixtures: a step-6 teamRegionSpec switch with no join flips the rules badge at sub 1,002"` — R-V45: a third peer's `leave` or ghosting changes `teamRegionSpec` (fold step 6), and the remaining peer's `person_badge{rules}` turns `on` (then `off`) with no join of its own; the badge equals `regionSpec ≠ teamRegionSpec` of `after` at every frame.
- `"T-VIZ-version (unit): rows whose op is unfolded in Plan 2 make no event and count in unknown"` — `claim`, `release`, `request`, `request_status`, `answer`, `note`, `presume_absent`, `hold`, each fixture marked with its plan; also an op of an unknown type and a rejected op.
- `"caps makes no event and is not unknown; event{incident} makes no event and counts unknown"` — R-V17.
- `"a board-only publish makes no code event; a not_commit or commit_too_large live read gives shape null and counts unknown; a malformed board commit folds as a noopDraft frame that counts unknown"` — R-V19.
- `"positions are unique and increasing, k follows the row order, then ascending seat key, then claim id"`.
- `"seeds follow eventSeed and contain no oid"` — two frame sequences that differ only in `oid` serialize byte-identically.
- `"T-VIZ-append-only: 2,000 generated frames split at 50 random points: the extendTimeline chain serializes byte-equal to one buildTimeline, segments and their start scenes included"` — fast-check over the ops of every row the Plan 2 fold applies.
- `"T-VIZ-self: the timeline is identical for self = each peer and = zeros"`.
- `"T-VIZ-placement (cs grammar): actorOfCs: a human id of the writer → its character; a human id naming another peer → the writer's character; a seat id → the pet <writer.peer>/<writer.epoch>/<seat_id>"`.
- `"T-VIZ-placement (server): target desk: most paths, then the actor's most recent desk, then the first desk key; other desks get planes in ascending ordinal"`.
- `"T-VIZ-placement: across every fixture of this task the only actor-to-actor walks come from request_open"` — V4 (12 §7 "across all fixtures").
- `"first touch: within one change-set paths are allocated sorted; across a frame in op line order, then trailer order; each new desk's first is the frame's height"` — R-V51.
- `"T-VIZ-looks: the same peer gets the same look in two windows with different h0, before and after load earlier, and after a display rename; equal tags or looks show handles in both windows"` — F18 (12 §7 T-VIZ-looks).
- `"T-VIZ-start (relaxed): the first pose_relaxed of an actor comes 64 heights after its first publish inside the segment, and never twice without a publish between"`.
- `"prependTimeline prepends one segment, appends the earlier page's new desks after every existing desk, changes no ordinal, and leaves the scene at 100 random positions above the old h0 unchanged"`.
- `"TimelineBuilder.replay from a kept carry reproduces the events first built for that range and throws LayoutFrozenError if a new desk would be needed"`.
- `"T-VIZ-log (cards): cardFor gives the §3.4 code and group per row and none for uncarded rows"` — conversation, conflict, activity, system; `request_status` → none; `pet_spawn` from a footprint → none, from `seat_start` → `UI_VIZ_CARD_SEAT_START`; `person_badge{rules}` carded only when `on`; a `join_back` row → `UI_VIZ_CARD_JOIN`; publish cards carry paths, `n` and desks; `Card.text` only for teammate free text.
- `"foldFrame: code.changed false at height 0, shape read only when changed, protoMismatch and the checkpoint compare reported"`.

**Reconciliation amendment (2026-10-08; F-8a-4 as revised by the owner's choice of 2026-10-08; X-91, X-92).**
- **Real-time claims (X-92: OWNER-CHOICES item 1 = ALTERNATIVE; replaces the withdrawn "checkpoint re-seed" amendment).** There is no `CLAIM_FOLD_KEYS`, no `claimKeys` parameter, no re-seed and no claims-only mismatch suppression: at a height whose draft carries a checkpoint, `foldFrame` compares the PRO-28 bytes against `serializeFold(after)` and reports `'match'` or `'mismatch'`, and the viewer always continues from its own `after` (12 §3.3.3 "Checkpoints", unchanged). `foldFrame(prev, x, self)` keeps the three parameters of §Interfaces, because Plan 2's `foldCommit` has no claim inputs, and stays the only place a frame calls `foldCommit`. Claims reach the viewer through its own fold, between checkpoints too: Task 20 (F-8a-13, after Plan 4 Task 8) adds the fourth argument `inputs: ClaimFoldInputs` to `foldFrame` on every frame (passed as `foldCommit`'s fourth argument; R4-26 skips every claim effect without it), the claim inputs of Task 7's two sources (git: `readClaimInputs`, in memory only; demo: the record's `claims` answers) and the claims-pending state; Plan 4's follow-up 4-V adds the claim rows — 12 §3.3.2, §3.3.3, §3.9.3, VIZ-06, VIZ-27 and INV-VIZ-NOCONTENT as amended by the owner's choice. The run delivered on 2026-10-08 (report 17:07, `p8a-t6`) implemented the withdrawn re-seed; its fix round removes `CLAIM_FOLD_KEYS`, the `claimKeys` parameter, the re-seed branch and its test before merge (ledger).
- **Per-plan rows (X-91).** The §3.4 op → scene-event mapping is one table keyed by op type (with the code and derived rows beside it) that Plans 3–7 extend in their own commits — or in their viewer follow-ups when this task merges after their fold task — without editing `TimelineBuilder`; their fixtures go to `test/fixtures/viz/rows/` marked with their plan. The row goldens `test/golden/viz/rows/*.events.json` are produced by a function that Task 16's `npm run viz:golden [-- --update]` calls, so every plan regenerates them only through that script.
- Tests added: `"T-VIZ-version (checkpoint): a checkpoint byte-equal to the viewer's fold reads match; a checkpoint that differs in any member reads mismatch and the next frame folds from the viewer's own after, never from the checkpoint"`; `"the op → scene mapping table: every Plan 2 folded type has its rows; a type outside PLAN2_FOLDED_TYPES has none and its ops count in unknown"`.

**Crashpoints:** none. **Lint:** none.

---

### Task 7: Room sources — git, demo, `status.json`, rooms, bounded reads

**Group:** G4 (parallel with 14). **Depends on:** 2, 6.

**Files:**
- Create: `src/viz/source/git.ts`, `src/viz/source/demo.ts`, `src/viz/source/status.ts`, `src/viz/source/rooms.ts`, `src/viz/source/boundedRead.ts`
- Test: `test/integration/viz/gitSource.test.ts`, `test/unit/viz/demoFormat.test.ts`, `test/integration/viz/demoSource.test.ts`, `test/unit/viz/overlay.test.ts`, `test/integration/viz/rooms.test.ts`, `test/integration/viz/clock.test.ts`, `test/integration/viz/boundedRead.test.ts`, `test/unit/viz/statusFields.types.test.ts`

**Interfaces:**
- Consumes: Task 4 `RoomSource`, `RoomSpec`, `TipInfo`, `Advance`, `Overlay`, `DemoCaption`, `Frame`, `toDraft`, `noopDraft`, `ZERO_PEER`; Task 2 `VizGit`, `readBoardCommits`, `readLiveCommits`, `BoardWriter`; Task 6 `foldFrame`, `buildTimeline`, `serializeTimeline`; Plan 2 `liveShape`, `parseFold`, `initialFoldState`, `parseWriter`, `parseCsTrailers`, `validPathSyntax`, `parseOpLine`, `enc`, `base32c`, `StatusJson` (types, the V19 test); Plan 1 `Fs`, `Clock`, `machineMonoMs`. Nothing from `src/viz/cli/**` (R-V54).
- Produces: `StatPair`, `REVPARSE_SAFETY_MS`, `GitRoomSource`; `DEMO_FORMAT`, `DEMO_MAX_BYTES`, `BUNDLED_DEMO_MAX_BYTES`, `CAPTION_TEXT_MAX`, `DemoRoomHeader`, `DemoCommit`, `DemoLog`, `parseDemoLog`, `serializeDemoLog`, `readDemoFile`, `demoRoomId`, `DemoRoomSource` (and the re-export of Task 4's `DemoCaption`); `STATUS_MAX_BYTES`, `StatusFields`, `StatusRead`, `readStatus`, `readPeerFile`, `youOf`, `overlayOf`; `ROOMS_MAX`, `canonicalRoot`, `roomId`, `decodeEnc`, `Discovery`, `discoverRooms`; `BoundedReader`, `realBoundedReader`, `fsBoundedReader`.

**Spec:** 12 §3.3.1 (rooms, `--repo` part), §3.3.2 (read set), §3.3.3 (window start, checkpoints, version coupling), §3.3.6 (overlay), §3.9.2 (stat pairs, the 60 s safety net), §3.9.3 (format, folding, refusals), §6 (no board, missing objects); VIZ-06, VIZ-07, VIZ-11, VIZ-13, VIZ-15 (flags), VIZ-27; rulings R-V19, R-V24, R-V30, R-V31, R-V46, R-V54.

**Tests:**
- `"git source frames equal folding readBoardCommit per oid"` — a 1,300-height scripted board: `tip()` height 1,299, `startAt(256)` = `parseFold` of the height-256 checkpoint, frames 257…1,299 in batches ≤ 1,280 deep-equal a reference fold (minus the transient fields).
- `"changed(): no git process while the stat pairs are unchanged; a loose-ref update, git pack-refs --all and (where git supports it) a reftable repository each change a pair; 60 s without change → true once"` — runner spy, `VirtualClock`.
- `"tip pinning: a ref moved between tip() and frames() changes nothing that tick"` — the test moves the ref inside a spy hook between the two calls (Review Focus 4).
- `"advance: ff with one rev-list; a rewrite and a > 1,280 catch-up told apart with rev-list --count and one --skip read; a deleted ref → gone"` — R-V31.
- `"a missing live commit stops the batch; a not_commit or over-cap live commit gives shape null"` — R-V19, F7: `frames()` rejects with the missing-object error before yielding any frame of that batch (the store shows `UI_VIZ_NO_BOARD`, Task 8); `BoardWriter.malformed('live_not_commit')` and `('live_three_parents')` give `code.shape === null`; `malformed('board_ops_too_large')` gives a `noopDraft` frame with `malformed: true`.
- `"T-VIZ-clock: boards written with commit dates shuffled, reversed and set to 1970 give byte-identical timelines"` — the `BoardWriter` `wallMs` option (V10).
- `"T-VIZ-demo-format: valid logs fold to the expected timeline and protocol is carried from height 0 with no protoMismatch"`.
- `"T-VIZ-demo-format: every invalid record refuses the whole file with its line number"` — a second header, a missing header, an unknown `t`, an unknown field, a height-0 commit without `protocol`, `protocol` at height > 0, non-consecutive heights, a room not in the header, a bad `writer`, a `cs` value `parseCsTrailers` refuses, 0 or 257 `csPaths` entries, unsorted or duplicate paths, a path failing `validPathSyntax`, a `csPaths` key naming no `cs` entry, 1,001 ops, a 16 KiB + 1 op, ops over 64 KiB, a caption with both `code` and `text`, an unknown caption code, a 121-character caption, a caption beyond its room's heights, a CR, a BOM, invalid UTF-8.
- `"T-VIZ-demo-format: csPaths keys __proto__ and constructor are refused as naming no cs entry and change no prototype"` — S18: `DemoCommit.csPaths` is a `Map`; `Object.prototype` is unchanged after the parse.
- `"T-VIZ-demo-format: interleaved rooms and held lists fold as on a board; an op line parseOpLine refuses is a fold no-op exactly as on a board"`.
- `"T-VIZ-demo-format: readDemoFile refuses a FIFO, a directory, a symlink and a 4 MiB + 1 byte file"` — `{ line: 0 }` through `realBoundedReader`, without blocking on the FIFO; a UNC path is the CLI's (Task 11).
- `"a demo source spawns no git process and reads no file"` — runner and `BoundedReader`/`FaultFs` spies.
- `"a DemoLog built from a board's reads folds to the git source's timeline byte for byte"` — the property `export-demo` relies on (Task 16), over a board that includes a shape-null live read and a malformed board commit encoded per R-V19 (F8): the serialized timelines are byte-identical and only the `unknown` counts differ.
- `"T-VIZ-overlay: each status state maps to its light; a heartbeat 3 loop periods + 1 ms old → down; a missing status.json → down (R-V24); a 2 MiB or unparseable file → unreadable with the previous values and never down; the offline age is last_fetch_age_ms + Δ machine mono in whole minutes"`.
- `"T-VIZ-overlay: a serialized timeline holds no overlay value"` — F5: a room whose `status.json` carries canary values (state, reasons, counts, `peer_id`, `plugin_version`) gives a `serializeTimeline` output containing none of them; the same window with and without `status.json` serializes byte-identically.
- `"readStatus reads only after an mtime change, with one open-read-close, and keeps the previous read on EPERM and ENOENT during a replace"` — `fsBoundedReader(FaultFs)` rename-over and share-none lock.
- `"bounded reads: a FIFO and a symlink to /dev/zero at status.json → unreadable, at peer → null, a 1 MiB + 1 byte status.json → unreadable; none blocks"` — S16, POSIX legs; `realBoundedReader` and `fsBoundedReader` agree on every regular-file fixture.
- `"youOf: the peer file, else status.json's peer_id when it is 32 lowercase hex, else null"` — R-V46, V18; a Plan 2 clone (no peer file) shows "you".
- `"every StatusFields member is assignable from Plan 2's StatusJson member of the same name"` — V19, compile-time.
- `"rooms: --repo of a main worktree → its gitdir realpath, the basename label and the decoded branch; a .git file, no board ref, or two board refs without a matching status.json branch → RF_VIZ_REPO_NOT_LIVE"`.
- `"room ids match ^r[0-9A-HJKMNP-TV-Z]{8}$, differ by salt and never contain a path; two spellings of one clone (drive-letter case, a symlinked alias, an 8.3 short name on Windows) are one room; more than 32 rooms → the first 32 and more"` — temp roots with spaces and Hangul (Review Focus 5); relative paths are the CLI's (Task 11).
- `"decodeEnc inverts enc and refuses anything enc would not produce"`.
- `"T-VIZ-version (source): a board with proto = 2 reports protoMismatch on every frame; a corrupted checkpoint reports mismatch and folding continues"`.

**Reconciliation amendment (2026-10-08; F-8a-3; X-63, X-105, X-76; Task 7 had not started).**
- **Canonical root (X-63).** `rooms.ts` does not write `canonicalRoot`; it imports `canonRoot(p: string, probe: RootProbe, platform: NodeJS.Platform): string` from `src/data/canonRoot.ts`, which **this task creates** (verify pass V-12) with exactly Plan 5's declared body and signature (`realpathSync.native` of the nearest existing ancestor + the remaining components; lower-case drive letter; `\` → `/`; NFC), adding `RootProbe` and `realRootProbe` to `src/ports/fs.ts` (Plan 5 reviewer; Plan 5 Task 1 later adds `sameRoot`, `endpointRoot`, `findRepo`, `liveState` in place), and `RoomSpec.canonicalRoot` (the landed field name stays) is `canonRoot(<the --repo main worktree>, probe, platform)` — the same string the `live` marker holds for Plans 5, 7 and 8b. `discoverRooms`'s deps gain `probe: RootProbe` (`realRootProbe` in production). **Depends on** 2 and 6 only (verify pass V-12: the "hold Task 7 or fallback" reading is withdrawn — Task 7 is the one creator; tests: `"canonRoot gives one string for two spellings of a clone (8.3 short name, trailing separator, drive-letter case) and equals Plan 5's declared examples"`).
- **Names kept.** `readPeerFile(gitdir, reader)` keeps its name and shape (X-105). `zoneOf` may by then be F04-a's re-export of `src/data/zone.ts` (X-76); Task 7 does not use it.
- **Landed inputs.** Task 7 consumes Task 2's landed `readBoardCommits`/`readLiveCommits` (`BatchReads<T>`, looping on `next` and passing `prevLive` across rounds, R-V69) and treats `'unreadable'` like the other malformed reasons (R-V74): a board failure → a `noopDraft` frame, a live failure → shape `null`.
- Test changed in scope, not in title: `"room ids … two spellings of one clone … are one room"` runs over `canonRoot` with `realRootProbe` (and a fake `RootProbe` for the 8.3 case off Windows).
- **Demo fields `live` and `claims` (owner choice of 2026-10-08, X-92 decided; 12 §3.9.3 as amended; Task 7 has not started).** `parseDemoLog` accepts the two optional `commit` fields with the §3.9.3 rules: `live` (40 or 64 hex) only on a record whose `code.changed` is true, later unchanged records inheriting it; `claims` = `{trees: [[commit, path, blob | 'ABSENT'], …], pairs: [[c1, c2, boolean], …]}` within the row's caps (oids by `isOid`, paths by `validPathSyntax`, ids by `validId`, no key twice, no other key). `DemoRoomSource` uses `live` as the draft's `liveCode` when present; it carries `claims` on `DemoCommit`, unused until Task 20 (a Plan 2 build folds every claim op `unfolded` either way). `serializeDemoLog` writes both after `held` in a fixed key order. Test added: `"T-VIZ-demo-format: live and claims"` — a log with `live` on its changed records folds to the same timeline as without it; refused with the record's line: `live` on an unchanged record, a non-oid `live`, a `claims` entry with a non-oid, a bad path, a non-boolean pair answer, a key twice, an unknown key or a list over its cap; `parseDemoLog(serializeDemoLog(x))` deep-equals `x` with both fields.

**Crashpoints:** none. **Lint:** none.

---

### Task 8: Room store and the poll loop

**Group:** G5 (parallel with 16). **Depends on:** 7, 10.

**Files:**
- Create: `src/viz/server/store.ts`, `src/viz/server/poll.ts`
- Test: `test/integration/viz/store.test.ts`, `test/integration/viz/retention.test.ts`, `test/integration/viz/poll.test.ts`, `test/integration/viz/incident.test.ts`, `test/integration/viz/anchors.test.ts`

**Interfaces:**
- Consumes: Task 4 `server/models.ts` types (`StoreLike`, `PollSink`, `RoomDelta`, `TimelinePageModel`, `RoomSnapshotModel`, `CardModel`), `RoomSource`, `ZERO_PEER`; Task 7 `GitRoomSource`, `DemoRoomSource`, `readStatus`, `overlayOf`, `readPeerFile`, `youOf`, `BoundedReader`; Task 6 `TimelineBuilder`, `buildTimeline`, `prependTimeline`, `Carry`; Task 5 `SceneReducer`; Task 10 `VizLog` (type; `nullVizLog` in tests); Plan 1 `Clock`, `VirtualClock`.
- Produces: `StoreDeps`, `RETAIN_HEIGHTS`, `PAGE_HEIGHTS`, `SNAPSHOT_AFTER`, `LAST_CARDS`, `RoomStore`; `POLL_MS`, `startPoll`.

**Spec:** 12 §3.3.3 (window, retention, self, checkpoints, version coupling), §3.8 (seen labels), §3.9.1 (seeking on the server), §3.9.2 (live mode), §3.10.5 (timeline route semantics), §3.10.6 (`TimelinePage.scene`), §3.12 (git calls per tick), §6 (incident, no board, gone, version rows); VIZ-07 (budget), VIZ-09, VIZ-11, VIZ-13, VIZ-14, VIZ-15, VIZ-26 (server re-fold), VIZ-41; rulings R-V19, R-V21, R-V28, R-V29, R-V31, R-V46.

**Tests:**
- `"the window starts at 256·⌊max(0, t − 1,023)/256⌋"` — t ∈ {0, 1, 1,022, 1,023, 1,024, 1,279, 1,280, 5,000}; from `initialFoldState` at 0 (frames from height 0) and from the checkpoint otherwise (frames from h0 + 1).
- `"retention: a room extended live by 3,000 heights keeps at most 2,048 heights of events and cards; the window does not shrink; ticks cover the whole window"`.
- `"T-VIZ-seek (server): page() returns at most 256 heights, never across a segment start; a dropped range is re-folded from the kept checkpoint with at most 255 folds and gives the events first served for it"` — fold-call counter.
- `"T-VIZ-start (page scene): TimelinePage.scene at a segment start is that segment's start scene, and elsewhere the scene at the last position of from − 1"` — F18 (12 §3.10.6).
- `"page() below h0 extends exactly one segment per call"` — R-V29.
- `"earlier(): h0 moves down 256, one segment is prepended, the new desks come as one layout delta, scenes above the old h0 are unchanged"`.
- `"T-VIZ-seek (server): after three earlier() pages the scene at 100 random positions above the old h0 is unchanged and no ordinal moved"` — F18 (12 §7 "after three load earlier pages").
- `"tick(): 3 new commits → one timeline delta with their events, cards and ticks; 65 → one snapshot delta with the scene at the tip and its last 200 cards"`.
- `"T-VIZ-overlay (store): no RoomDelta or TimelinePageModel holds an overlay value"` — F5: with canary values in `status.json`, a deep scan of every delta and page model finds none of them; only `RoomSnapshotModel.overlay` carries them.
- `"T-VIZ-poll: 8 rooms idle for 60 virtual seconds run at most one rev-parse per room and no other git process; a fetch of 3 commits costs rev-parse, rev-list, cat-file --batch-check and cat-file --batch; never two git children of one room at once"` — runner spy over real repositories (R-V05's amended count).
- `"T-VIZ-incident: a non-fast-forward rewrite, or status.json state incident, folds nothing of the new chain and freezes the room with UI_VIZ_INCIDENT_FROZEN; after a non-incident state with a fresh heartbeat the room is rebuilt from the new tip on its old layout and reports rebuilt"` — R-V21.
- `"T-VIZ-version (store): version skew, newer protocol and checkpoint mismatch never stop the fold; unknown counts add up over the window"`.
- `"no board yet, a vanished ref and a missing board or live object show UI_VIZ_NO_BOARD and keep the last scene; the next tick retries and folds once the object exists"` — R-V19 (F7).
- `"T-VIZ-log (anchors): heights first folded by tick()'s fast-forward carry their Δmono fold time; the initial window, earlier(), page() re-folds and a rebuild create none"` — R-V28 (F3): cards from `earlier()`, from `page()` over a dropped range and after a rebuild have `foldedAt` null or their original anchor; a re-folded card's `foldedAt` equals the one first served; retention never drops an anchor inside the window.
- `"self comes from the peer file, else status.json's peer_id, else zeros"` — R-V46; the timeline is identical in all three cases.
- `"startPoll runs every 2.5 s of Δmono, one store at a time, never re-entrant, and stop() waits for the running tick"` — over `RoomStore`s and over fake `StoreLike`s whose `tick()` returns three nulls.

**Owner choice of 2026-10-08 (X-92 decided; Task 8 has not started).** The claims-pending state of 12 §3.3.3 (`UI_VIZ_CLAIMS_PENDING`, the 30 s retry, the 404 on a page that needs the missing heights) is Task 20's; this task keeps the `UI_VIZ_NO_BOARD` path for a missing board or live object as written, and keeps the room's badges in one set so Task 20 adds one member.

**Crashpoints:** none. **Lint:** none.

---

### Task 9: View model projection

**Group:** G3 (parallel with 6, 13). **Depends on:** 3, 4, 5, 10.

**Files:**
- Create: `src/viz/server/project.ts`, `src/viz/server/api.ts`, `test/helpers/vizSchema.ts`
- Test: `test/unit/viz/project.test.ts`, `test/unit/viz/handles.test.ts`, `test/unit/viz/servedText.test.ts`, `test/unit/viz/servedCodes.test.ts`, `test/unit/viz/viewModel.schema.test.ts`, `test/unit/viz/projectedReduce.test.ts`, `test/unit/viz/api.test.ts`

**Interfaces:**
- Consumes: Task 4 `viewModel.ts` types, model types, `server/models.ts` (`StoreLike`, `PollSink`, `WorldApi`, …), `source/roomSource.ts` (`RoomSpec`, `Overlay`, `DemoCaption`), `plaqueOf`, `lookTable`; Task 10 `StreamHub`; Task 3 `sanitize`, `cap`, `PAGE_CODES`, the closed code sets, `EN_VIZ`; Task 5 `reduceScene`, `phOf`; Plan 2 `validPathSyntax`, `validName`, `base32c`. Task 8's `RoomStore` implements `StoreLike`; Task 9's tests use fakes.
- Produces: `HandleTable`, `createHandleTable`, `VizTextKind`, `vizText`, `vizCode`, `PATHS_MAX_BYTES`, `servedPaths`, `SERVED_STRING_FIELDS`, `nameTag`, `tagCollisions`, `projectEvent`, `projectScene`, `projectCard`, `projectLayout`, `projectLayoutDelta`, `projectOverlay`, `projectRoom`, `projectDelta`, `projectPage`, `projectWorld`; `createWorldApi`, `pollSinkFor`; `viewModelSchemas`, `validate`.

**Spec:** 12 §3.10.6 (allowlist, projection rule, never-served list), §3.10.7 (untrusted text, server side), §3.6 (name tags), §3.8 (`seen_ms`), §3.5.3 (plaques, layout events), §3.10.5 (layout announcements); VIZ-17 (labels), VIZ-18 (handles in tags), VIZ-24 (`seen_ms`), VIZ-26 (projected equivalence), VIZ-35, VIZ-36 (without the scan), VIZ-37 (server half); rulings R-V22, R-V23, R-V26, R-V27, R-V28, R-V38, R-V43, R-V49, R-V50, R-V52, R-V56.

**Tests:**
- `"T-VIZ-view-model: no projected value contains coauthor_optin's name or e-mail, a config_fingerprint key, plugin_sha, an absolute path, the OS user or host name, a 64-hex token or a commit e-mail"` — a fold whose `PeerRec` has `coauthor_optin: "Ann <ann@corp.example>"` and a full fingerprint; OS user and host names differing from every fixture name.
- `"handles: the first 6 hex of a peer, base32c(sha256(seat key))[0:6] for a seat, the first 8 characters of a hold or claim id; colliding prefixes extend to the shortest unique length and report a collision"` — R-V22.
- `"T-VIZ-looks (tags): validName else peer-<handle>; equal tags or equal looks in a room show the display and the whole handle; a colliding tag never loses its handle"` — R-V52 (S7): two peers with the same 20-character name, and two 25-character names equal in their first 20, show tags ending in their distinct full handles; `Ann . 3f2a1b` next to a real `Ann` (handle `3f2a1b`) shows its own handle; `ANN` and `Ann` (NFKC + lower case) collide.
- `"T-VIZ-text (served): every served string passes its validator, sanitize(…, 'viz') and its cap"` — names, labels (SEC-35 `validLabel`: whitespace, 201 characters and `/` give `?`), paths, plaques (basename ≤ 16 with a middle ellipsis), zone signs, branch, room label, version, captions; the corpus `<img src=x onerror=…>`, `</script>`, `javascript:`, ANSI, OSC 8, OSC 52, bidi overrides, zero-width and tag characters, URLs and 10 KB strings: no `<` or `>`, no control, no URL, within the caps and `VIZ_RAW_UNITS` (the secret rows are 8b).
- `"T-VIZ-text: every string field of the generated schemas is a named alias, a literal union or a SERVED_STRING_FIELDS entry, and the projection applies that entry's check"` — S8, R-V27: an id field fed a raw seat key, an oid or a path fails its alias pattern; an enum-like field fed an unknown value gives `?` or `null`.
- `"T-VIZ-text: a forged code in a code slot is never a page-state, RF_ or SEC_ code"` — R-V43 (S2): a board freeze or health `reason_code` equal to each page-state, `RF_` and `SEC_` code projects to `'?'` (`person_freeze.reasonCode`, `frozen`, card `detail`) or `null` (`person_badge.code`), and its template is never rendered; `EPOCH` and `HOST_THROTTLED` project unchanged; the same mapping in `projectEvent` and `projectScene` keeps the page's reduction equal to the projected server scene.
- `"T-VIZ-api (paths): a 256-path change-set of 80-emoji paths and of 80-grapheme paths with 30 combining marks each is served as the longest prefix within 16 KiB with n = 256, identically by projectEvent, projectCard, projectPage and projectDelta"` — R-V50 (S3); the event and its card each fit, so the stream message stays ≤ 64 KiB.
- `"Maps become [key, value] arrays in ascending UTF-16 key order, Position becomes Pos, and nothing is added or renamed"` — field-by-field comparison against the model; `pet_spawn`/`pet_poof` carry `owner` as a handle (R-V47); layout desks carry `first` (R-V51).
- `"seen_ms is nowMono − foldedAt for cards with an anchor and null otherwise"` — R-V28: initial-window, earlier-page and re-folded cards without an anchor serve `null`.
- `"overlay VM: whole offline minutes, no message_params or not_converged, freeze_reasons and publish_pause only from their closed sets, null in demo mode"`.
- `"characters: CharacterVM.ph comes from phOf and no teammate is ever PH_OFFLINE"` — R-V56 (F10): over hand-written scenes with left, absent, frozen, slowed, ghost and ok characters.
- `"T-VIZ-api (projection half): viewModelSchemas() is generated from viewModel.ts with additionalProperties false and each alias as its pattern; every projection of this task's hand-written models validates; the generator refuses a construct it does not support"` — R-V27 (Task 14 validates every Task 6 fixture, V4).
- `"createWorldApi recomputes the world at most once per 2.5 s whatever the number of callers and waits for every store's ready"`.
- `"a page that appends desks publishes one layout event whose from_version is the version before the call"` — R-V49 (F4): a fake store whose `page(from < h0)` returns a layout delta; the hub receives exactly one `layout` payload before `page()` resolves; a page without new desks publishes nothing; `projectDelta` puts a `layout` message before a `room_snapshot`.
- `"strings(lang) answers en templates of PAGE_CODES for the six codes and null otherwise"` — R-V15; the reason codes' templates are included.

**Reconciliation amendment (2026-10-08; F-8a-6, F-8a-10; X-94, X-104; Task 9 had not started).** `SceneVM.claims` entries carry `at: Pos` from `ClaimState.at` (R-V73, ledger carry), checked by the projection test of Maps and Positions. Display ids of holds and claims follow R-V22 as written (the model keys every hold and claim by its full id; the served `ShortId` is the shortest unique prefix of at least 8 characters, X-94), which the `"handles: …"` test already asserts. The closed code sets are read from `codes.ts` at projection time, so the codes Plans 3, 5 and 7 add to `HEALTH_REASON_CODES` (X-104) need no projection change.

**Crashpoints:** none. **Lint:** none.

---

### Task 10: HTTP server, tokens, stream hub, viewer log

**Group:** G2 (parallel with 2, 5, 11, 12; gate P, R-V01). **Depends on:** 1, 3, 4.

**Files:**
- Create: `src/viz/server/tokens.ts`, `src/viz/server/http.ts`, `src/viz/server/stream.ts`, `src/viz/server/shell.ts`, `src/viz/server/vizLog.ts`, `test/helpers/vizHttp.ts`
- Test: `test/unit/viz/tokens.test.ts`, `test/integration/viz/launch.test.ts`, `test/integration/viz/admission.test.ts`, `test/integration/viz/nodeResponses.test.ts`, `test/integration/viz/headers.test.ts`, `test/integration/viz/routes.test.ts`, `test/unit/viz/stream.test.ts`, `test/integration/viz/vizLog.test.ts`

**Interfaces:**
- Consumes: Task 4 `viewModel.ts` types and `WorldApi` (`server/models.ts`); Task 3 `sanitize` (channel `log`); Plan 1 `Clock`, `Random`, `ownStaleness`, `anchorNow`, `Fs`, `base32c`; a stub `WorldApi` in tests.
- Produces: `LAUNCH_TTL_MS`, `RedeemResult`, `TokenAuthority`, `tokenEquals`; `ServerAssets`, `ServerDeps`, `CSP`, `SECURITY_HEADERS`, `HTTP_LIMITS`, `escapeJson`, `VizServer`, `createServer`; `SseSink`, `SSE_MAX_BYTES`, `RING_EVENTS`, `RING_MS`, `COMMENT_MS`, `LAST_EVENT_ID_RE`, `StreamHub`, `frameSse`; `SHELL_HTML`, `staticRoute`; `VizLogParam`, `SecVizCode`, `VizLog`, `LOG_ROTATE_BYTES`, `LOG_FILES`, `LOG_KEEP_MS`, `SEC_WINDOW_MS`, `openVizLog`, `cleanupVizLogs`, `stackFrames`, `nullVizLog`; `rawRequest`.

**Spec:** 12 §3.10.1–§3.10.5, §3.10.10, §6 (link reused, expired, probes, port reuse); VIZ-30, VIZ-31, VIZ-32, VIZ-33, VIZ-34, VIZ-38, VIZ-42 (`bye`); INV-VIZ-AUTH, INV-VIZ-LOOPBACK (listener half); rulings R-V40, R-V48, R-V50, R-V55.

**Tests:**
- `"the listener binds 127.0.0.1 port 0 exclusively and verifies address(); any other bound address closes and refuses RF_VIZ_BIND_FAILED"` — an injected `address()` of `0.0.0.0` and of `::1`.
- `"T-VIZ-token: wrong length, upper case, non-hex and near misses are false without throwing; the right token is true; timingSafeEqual always gets two 32-byte digests"`.
- `"T-VIZ-launch: redeem once → 200 {session, instance}; again → 401 UI_VIZ_LINK_REUSED, bye on the first session's stream, SEC_VIZ_LAUNCH_REUSED logged at once, onLaunchReused called; at 121 s own staleness → 401 UI_VIZ_LINK_EXPIRED and SEC_VIZ_LAUNCH_EXPIRED; a session POST without Origin → 403"` — a suspend gap (Δwall advances, Δmono does not) counts toward the TTL.
- `"T-VIZ-admission: Host must be byte-equal to 127.0.0.1:<port>"` — absent (HTTP/1.1 and HTTP/1.0), `localhost:p`, `127.0.0.1`, `127.0.0.1:p.`, `[::1]:p`, `0.0.0.0:p`, `evil.test:p`, userinfo, and two `Host` headers (counted in `rawHeaders`) → 421 `UI_VIZ_BAD_HOST` with the §3.10.4 header set, `SEC_VIZ_BAD_HOST` (Review Focus 2; R-V48: Node's own missing-`Host` 400 never answers).
- `"T-VIZ-admission: Origin, Sec-Fetch-Site and methods"` — a foreign `Origin`, `Origin: http://127.0.0.1:<port+1>`, `Origin: null` and `Origin: http://localhost:<port>` → 403; `Sec-Fetch-Site: cross-site` and `same-site` on `/api/*` and on `/` → 403 (other 127.0.0.1 ports are same-site, S12); `none` on `/` passes; `PUT`, `DELETE`, `OPTIONS` with `Access-Control-Request-Private-Network` → 405 and no `Access-Control-*` header; `HEAD /api/v1/stream` attaches no stream.
- `"T-VIZ-admission: limits"` — headers over 8 KiB → 431; a URL over 2 KiB → 400 (or 431 when Node's header limit trips first), never 414 (F21); a body on GET (also with `Transfer-Encoding: chunked`) → 400; a session body over 256 bytes (also chunked) → 413; an absolute-form target → 400; `Upgrade: websocket` and `CONNECT` → socket destroyed; the 33rd connection refused; no failure echoes any request byte.
- `"T-VIZ-admission: responses Node writes itself carry the header set (real timers)"` — R-V48 (S4), raw bytes: 9 KiB of headers → 431 with the §3.10.4 set and `Connection: close`; headers stalled mid-line → 408 with the set within 7 s; a malformed request line → 400 with the set; `Expect: 100-continue` with a bad `Host` → 421 and no `100 Continue`; `Expect: weird` → 417 with the set; no response contains `err.rawPacket` bytes.
- `"T-VIZ-headers: every route and status carries the 12 §3.10.4 set with the CSP byte-equal to the one-line form, and no Set-Cookie, WWW-Authenticate, Access-Control-*, Server, ETag, Last-Modified or X-Powered-By; JSON escapes <, >, &, U+2028 and U+2029"`.
- `"T-VIZ-routes: unknown paths → 404 UI_VIZ_NOT_FOUND; room ids in lower case, with I, L, O or U, of 7 or 9 characters, .., encoded slashes and path-like parameters → 404 or 400; a valid upper-case room id → 200; lang outside the six → 404; heights outside ^(0|[1-9][0-9]{0,9})$ → 400; an Fs spy sees no file access caused by any URL"`.
- `"T-VIZ-routes: a missing or bad session → 401 UI_VIZ_NEED_LINK and SEC_VIZ_BAD_TOKEN, no lockout; an EventSource-style query token is refused"`.
- `"an internal error answers 500 UI_INTERNAL_ERROR and logs stack frames only"` — no `err.message`, no absolute path.
- `"T-VIZ-stream (hub): ids from 1 shared by all rooms and kinds; Last-Event-ID in the ring replays every later event then goes live; malformed, larger than the sequence, or older than the ring → one reset; the header is never echoed or logged"`.
- `"T-VIZ-stream: no SSE message exceeds 64 KiB"` — a large timeline payload splits between events; an oversize layout delta or snapshot scene becomes one reset; a snapshot keeps the newest cards that fit; a single event whose framed message with its card exceeds 64 KiB (built past R-V50's budgets by hand) becomes one reset.
- `"a comment line every 15 s; close() sends bye to every stream; open() counts streams for the idle exit"`.
- `"T-VIZ-logs (unit): viz-<instance>-<n>.jsonl rotated at 10 MB, 5 files, by its owner only; two instances never rename each other's files; files older than 14 days are deleted at start; security codes aggregate to one line per 60 s; a non-code string parameter throws"`.
- `"the shell holds no data and no human text, links /app.js and /app.css, and has no inline script or style"`.

**Crashpoints:** none. **Lint:** none (Task 1's L-NET exemption for `http.ts`'s `node:http` load; L-VIZ-NET and L-VIZ-URL hold there).

---

### Task 11: The `view` verb — flags, modes, data directory, git resolution, spawn, opener

**Group:** G2 (parallel with 2, 5, 10, 12; gate P, R-V01). **Depends on:** 1, 3.

**Files:**
- Create: `src/viz/cli/view.ts`, `src/viz/cli/paths.ts`, `src/viz/cli/pathTrust.ts`, `src/viz/cli/spawn.ts`, `src/viz/cli/opener.ts`, `src/viz/cli/dataDir.ts`, `src/viz/cli/ownerProbe.ts`
- Modify: `src/entry/cli.ts` (the `view` dispatch)
- Test: `test/unit/viz/viewFlags.test.ts`, `test/unit/viz/dataDir.test.ts`, `test/unit/viz/opener.test.ts`, `test/integration/viz/pathTrust.test.ts`, `test/integration/viz/spawn.test.ts`, `test/integration/viz/cliModes.test.ts`, `test/integration/viz/ownerProbe.test.ts`, `test/fixtures/viz/probeViewer.mjs` (a probe child that writes its env keys, cwd and argv in a valid ready line, or sleeps, or prints garbage)

**Interfaces:**
- Consumes: Task 3 `render`, `registerCatalog`, `EN_VIZ_CLI` (never `EN_VIZ`: `cli.js` may bundle only `src/viz/cli/**`, VIZ-01, R-V54), `Lang`; Plan 1 `buildDaemonEnv`, `Fs`, `realFs`, `Clock`.
- Produces: `OutputMode`, `outputMode`, `ViewFlags`, `parseViewFlags`, `langOf`, `URL_RE`, `launchUrl`, `CliEnv`, `runView`, `realCliEnv`; `isUncOrDevice`, `absolutize`; `excludedRoots`, `filterPath`, `trustedExe`, `resolveGitPath`; `ViewerArgs`, `ReadyLine`, `READY_TIMEOUT_MS`, `READY_MAX_BYTES`, `READY_REFUSE_CODES`, `parseReadyLine`, `viewerArgv`, `spawnViewer`, `killTree`; `OpenerCtx`, `OpenerPlan`, `planOpener`, `openUrl`; `pluginDataDir`, `resolveDataDir`, `DataDirVerdict`, `verifyDataDir`, `Sddl`, `parseSddl`, `sddlUserOnly`; `OwnerProbe`, `realOwnerProbe`.

**Spec:** 12 §1.2 (refusals and next lines), §3.2 items 1–4 and 10, §3.10.8, §3.10.9, §6 (CLI rows); SEC-20, SEC-30, 09-security §3.4 (+ the opener display set, 12 §9.3), 10-product §2, §3.4, §3.17, UX-01; VIZ-02 (without `SHA256SUMS`), VIZ-04 (8a subset), VIZ-05; INV-NOEXEC, INV-VIZ-CUSTODY (CLI half); rulings R-V11, R-V12, R-V13, R-V14, R-V15, R-V39, R-V54, R-V55.

**Tests:**
- `"flags: --no-open, --demo, --demo=<file>, repeated --repo; anything else, --json and --demo with --repo → RF_UNKNOWN_FLAG"`.
- `"paths are made absolute against the CLI cwd; \\\\server\\share, //host/x, \\\\.\\x, \\\\?\\C:\\x and /dev/x are refused with RF_VIZ_REPO_NOT_LIVE or RF_VIZ_DEMO_INVALID; spaces and Hangul pass"` (Review Focus 5) — `cli/paths.ts` has no import declaration.
- `"T-VIZ-cli-modes (8a): pipe and slash start nothing and print UI_VIZ_TERMINAL_ONLY with the terminal command; tty opens and prints UI_VIZ_OPENED; tty --no-open and a simulated open failure print UI_VIZ_URL; a 64-hex token appears only in those two tty outputs"` — `CLAUDECODE=1` with a non-TTY stdout is slash; no `--json` envelope exists in 8a (R-V14); the tty `--no-open` output contains exactly one `URL_RE` match (S21).
- `"T-VIZ-lints (UX-01): every string runView passes to out() and err() is a render() result"` — F18: a recording `render` spy and `out`/`err` spies over every path of this task's tests; no other string reaches them.
- `"T-VIZ-env: the probe child's environment has none of CLAUDE_CODE_MESSAGING_TOKEN, CLAUDE_PLUGIN_DATA, NODE_OPTIONS, GIT_DIR, has LC_ALL=C, its cwd is the data directory, its PATH is the filtered list, and its argv carries --data-dir, --lang, --sha256 and, with --repo, --git"` — the messaging token appears in no file under the data directory; with `--demo` no `--git` is passed and no git is resolved.
- `"T-VIZ-handshake: a child that sleeps 6 s or prints a malformed or oversized line → RF_VIZ_START_FAILED and its whole process tree is gone"` — a grandchild pid is checked gone on every OS.
- `"T-VIZ-handshake: a taskkill.exe planted in the CLI's cwd is never executed"` (Windows legs).
- `"T-VIZ-handshake: a data directory that fails SEC-20 → RF_VIZ_START_FAILED and nothing is spawned or read"` — POSIX mode 0755 and a foreign owner; Windows an added `Everyone` ACE and a junction data directory; a localized Windows passes because SIDs are compared.
- `"parseSddl and sddlUserOnly"` — the user SID, `SY`, `BA` and inherit-only `CO`/`OW` pass; `WD`, `AU`, `BU`, another user's SID and a deny-only quirk are handled per SEC-20; `D:NO_ACCESS_CONTROL`, an SDDL with no `D:` part, `(OA;;GA;;;WD)`, `(XA;;FA;;;BU)` and a DACL without an allow ACE for the user are refused (S9); malformed SDDL → null.
- `"the Windows owner probe runs powershell.exe by absolute path with the directory in the environment, never in command text"` (Windows legs; a directory named `x'; Remove-Item …` probes safely).
- `"resolveDataDir: CLAUDE_PLUGIN_DATA when absolute, else pluginDataDir; created 0700 when absent"`.
- `"langOf maps OS locales to the six codes, else en, and --lang reaches the probe child under LC_ALL=C"`.
- `"the sha256 of dist/viz.js is passed as --sha256"`.
- `"T-VIZ-handshake: resolveGitPath never executes a repository-controlled git"` — R-V13 (S1, V11): a `git` (`git.exe` on Windows) planted in `<cwd repo>/bin` and in a `--repo` worktree, first on `PATH` after an empty entry, is never chosen or executed; a symlinked system git (Homebrew-style) is accepted and its realpath passed; a `Path`-only environment resolves on win32; on POSIX a group-writable git is skipped; no git anywhere → `START_TOOL_VERSION` and nothing spawned.
- `"filterPath compares realpaths"` — R-V39 (S10): `<repo>//bin`, `<repo>/x/../bin` and a symlinked alias of the repository root, each holding an executable `xdg-open` and `git`, are all dropped; an entry whose realpath fails is dropped.
- `"T-VIZ-opener: URL fuzz (spaces, quotes, &, %, ^, newline, --flag, file:, another host, a 63-hex token) is never spawned; a valid URL spawns an absolute executable with an argv array, shell false and cwd = the data directory"`.
- `"T-VIZ-opener (Windows): explorer.exe from an absolute SystemRoot; a planted explorer.exe in a repository directory never runs; exit 1 is success"`.
- `"T-VIZ-opener (Linux): an executable xdg-open planted in <cwd repo>/bin first on PATH with an empty entry is never executed; a group-writable candidate is skipped; the child's PATH holds only filtered entries; without DISPLAY and WAYLAND_DISPLAY the open fails"`.
- `"refusals print in the 10-product §3.4 two-line format with the 12 §1.2 next line"`.
- `"cli.js view is dispatched; --version and the no-argument no-op are unchanged"`.

**Crashpoints:** none. **Lint:** none (L-PORTS exemptions for `spawn.ts`, `opener.ts`, `ownerProbe.ts` and L-FS-PORT for `ownerProbe.ts` from Task 1).

---

### Task 12: Art — palette, sprites, raster

**Group:** G2 (parallel with 2, 5, 10, 11; it may run ahead of gate P once Task 4 has merged, R-V01). **Depends on:** 4.

**Files:**
- Create: `src/viz/render/palette.ts`, `src/viz/render/sprites.ts`, `src/viz/render/raster.ts`, `test/golden/viz/frames.json` (RGBA hashes)
- Test: `test/unit/viz/palette.test.ts`, `test/unit/viz/sprites.test.ts`, `test/unit/viz/raster.test.ts`

**Interfaces:**
- Consumes: Task 4 `Layout`, `Scene` types, coordinates, `isDashed`; the brainstorm maps of `docs/design/viz-mockups/character-style.html` (option A) as the art baseline.
- Produces: everything of §Interfaces "Art".

**Spec:** 12 §3.6 (maps, tones, hues, contrast, colour vision, accessories, pets), §3.7 (rendering, frame edits), §3.5.2 (tile geometry); VIZ-19, VIZ-20, VIZ-22 (reduced forms drawn); 10-product "colour is never the only carrier".

**Tests:**
- `"T-VIZ-palette: for every hue, outline vs both floor tones ΔE ≥ 20, eye white vs body ≥ 15, cheek vs body ≥ 10, after the bounded L* adjustment within 55–80"`.
- `"T-VIZ-palette: the minimum pairwise ΔE of the seven (adjusted) bodies under normal vision and simulated protanopia, deuteranopia and tritanopia is ≥ 0.9 × the same minimum for the spec's own UNADJUSTED seven hues (APRICOT in place of vermillion; ruling R-V63)"` — Machado 2009 matrices at severity 1.0.
- `"every (accessory, hue) uses the main pair when its main tone has ΔE ≥ 15 against the body, else the alternate pair, which passes"`.
- `"CIEDE2000 matches the Sharma et al. 2005 test vectors"`.
- `"sprite maps: the base map and the beanie, headphones, sunglasses and scarf overlays equal option A; every map has its size and only its keys; every icon is an 8×8 (or 3×3) map"` — no icon is a font glyph or emoji.
- `"frame edits: squash, eyes closed, walk offsets 0, −2, −3, −1, and a horizontal flip that keeps the symmetric blob"`.
- `"T-VIZ-frames: the static and sprite layers of 20 fixture scenes, normal and reduced motion, hash to test/golden/viz/frames.json"` — incl. ghosts, frozen, slowed, pets with variants 0–5, a desk with a chair, four visitors and +n, the big table, dashed future desks (`dashedFrom` = a past scene height, R-V51) and dimmed desks.
- `"composeSprites z-sorts by foot y, then actor key, and never reads outside the office"`.
- `"placeTile: home spots, chair, visitor tiles, facing a chair, behind (below, else above when blocked or outside)"`.

**Crashpoints:** none. **Lint:** none.

---

### Task 13: Page logic (DOM-free)

**Group:** G3 (parallel with 6, 9). **Depends on:** 3, 4, 5.

**Files:**
- Create: `src/viz/ui/sse.ts`, `src/viz/ui/conn.ts`, `src/viz/ui/anim.ts`, `src/viz/ui/loop.ts`, `src/viz/ui/path.ts`, `src/viz/ui/bubbles.ts`, `src/viz/ui/logModel.ts`, `src/viz/ui/seek.ts`, `src/viz/ui/unproject.ts`, `src/viz/ui/fragment.ts`, `src/viz/ui/zoom.ts`, `src/viz/ui/a11y.ts`, `src/viz/ui/map.ts`
- Test: `test/unit/viz/ui.sse.test.ts`, `test/unit/viz/ui.conn.test.ts`, `test/unit/viz/ui.anim.test.ts`, `test/unit/viz/ui.loop.test.ts`, `test/unit/viz/ui.path.test.ts`, `test/unit/viz/ui.bubbles.test.ts`, `test/unit/viz/ui.log.test.ts`, `test/unit/viz/ui.seek.test.ts`, `test/unit/viz/ui.map.test.ts`, `test/unit/viz/ui.misc.test.ts`

**Interfaces:**
- Consumes: Task 4 `viewModel.ts` types, `TimelineView`, layout coordinates, `isBlocked`, `isDashed`, `applyLayoutDelta`; Task 5 `SceneReducer`, `reduceScene`, `deskDimmed`, `placeLabel`; Task 3 `renderWith`, `REASON_CODES`, `Lang`. Nothing from `render/**` (the layer order; `staticFor`'s result is structurally `StaticOptions`, which Task 14's client passes to `composeStatic`).
- Produces: everything of §Interfaces "Page logic" (`ApiRoute`, `ConnIo`, `Connection`, `firstRoom`, `applyLayoutDeltaVM`, `peopleList`, `MAP_DOTS_MAX`, `MAP_SCROLL_AFTER`, `roomDots`, `headerLamp`, `sceneOverlayMarks`, `staticFor` and the rest).

**Spec:** 12 §3.2 item 11 (first room), §3.5.1 (map), §3.3.6 (overlay never on a past scene), §3.7 (states, beats, loop), §3.8 (panel model, merging, filters, bubbles, memory), §3.9.1 (seeking on the page), §3.10.2 (fragment), §3.10.5 (stream reading, reconnect, layout deltas), §3.11 (accessibility logic), §3.5.3 (zoom and scrolling, coarse view only by the user, dashed future desks), §3.5.4 (pathfinding); VIZ-13, VIZ-16 (zoom half), VIZ-17, VIZ-22, VIZ-23, VIZ-24, VIZ-25, VIZ-26 (page half), VIZ-37 (Maps), VIZ-40 (logic), VIZ-42; rulings R-V22, R-V23, R-V33, R-V49, R-V51, R-V56.

**Tests:**
- `"T-VIZ-anim: every kind of SCENE_EVENT_KINDS maps to its 12 §3.7 states and reduced forms; no state without an event; event-sourced exclaims last one beat"`.
- `"T-VIZ-anim: with a fake rAF the loop draws at most 12 frames per second, at most 2 per second for an idle room, and stops when nothing animates; wake() restarts it"`.
- `"T-VIZ-bubbles: Latin, Hangul, Han and kana durations; the 1.5 s and 6 s clamps; 2 lines × 42 Latin or 16 full-width then an ellipsis; one per actor, three per room with the oldest fading early; at 8× never below 1.0 s"`.
- `"T-VIZ-log: the card list; request_status is a chip; consecutive publishes of one actor merge with ≤ 5 chips and +n after filtering; character, person, file and kind filters AND-combine; system cards only behind their filter; at most 2,000 cards"`.
- `"T-VIZ-log: a live card the viewer saw arrive shows UI_VIZ_SEEN_AGO from seen_ms plus the page's own Δmono, a card with seen_ms null shows #height and UI_VIZ_SEEN_BEFORE_OPEN, replay shows #height, and a reload keeps both"` (VIZ-11, R-V28).
- `"T-VIZ-notes (page): teammate text is placed only in the quoted frame and never passed to renderWith as a code or a template"`.
- `"T-VIZ-seek (page): at 200 random positions the scene from the nearest cached 64-height scene equals reducing from the segment start"`.
- `"T-VIZ-layout (seek): a seek keeps the head layout — the layout version is unchanged and no desk is removed — and staticFor passes dashedFrom = the seek height, null when live"` — F18, R-V51: the dashed set equals `isDashed` at that height.
- `"T-VIZ-overlay (page): in replay at h1 − 10 sceneOverlayMarks is null — no lamp on the scene, no count chip and no you marker — while headerLamp still shows the own room's light"` — F5 (12 §7 "a seek to h1 − 10 draws no overlay element").
- `"unproject inverts the projection rule: Pos ↔ (height, sub, k), arrays ↔ Maps, ids kept as handles, pet events keep their owner handle"` — R-V47.
- `"applyLayoutDeltaVM applies each delta once"` — R-V49: the same delta received from the stream and in a `TimelinePage` is applied once; a delta with `version` ≤ the page's is a no-op; a gap (`from_version` ≠ the page's version, `version` greater) → `'reload'`.
- `"T-VIZ-layout (path): A* reaches every chair, visitor tile and home spot from the door in a 64-cell office; ties break N, E, S, W with a turn penalty of 1; actors pass through each other; no path or ≥ 4× over > 12 tiles → poof; paths are cached per (layout version, from, to)"`.
- `"T-VIZ-layout (zoom): Z = max(2, ⌊panelW / worldW⌋) on open, resize or a user zoom only; a growing office never changes Z and never enters the coarse view; follow only after 30 s without a user scroll"`.
- `"sse parser: chunks split anywhere, LF, CRLF and CR, comment lines, multi-line data, ids"`.
- `"T-VIZ-failure-signs (page): the launch token is removed before the first request; one POST /api/v1/session; the stored session after a reload; a broken stream → reconnecting, retry 1 s doubling to 30 s, then a world reload, then stopped; bye → stopped; 401 UI_VIZ_LINK_REUSED → link_reused; a layout gap or a room 'added' → world reload"`.
- `"conn: every request names an ApiRoute, never a path string; the first room is the kept room when it is still in the world, else the first in server order; stopped and link_reused clear the stored session and room"` — V8, F23 (12 §3.2 items 5 and 11).
- `"fragment: #k= must be 64 lowercase hex; filters parse only ^r[0-9A-HJKMNP-TV-Z]{8}$, ^[0-9a-f]{6,32}$ and ^(0|[1-9][0-9]{0,4})$; nothing is ever read as a path"` — R-V22 (F16).
- `"map: roomDots gives ≤ 16 dots, ranked characters first, ghosts grey, absent hollow, and a grey cell for a down, board-less or gone room; MAP_SCROLL_AFTER is 8"` — F23 (12 §3.5.1).
- `"a11y: the scene summary counts people, Claude sessions, open requests and conflicts; announcements at most one per 10 s, summarising; the keyboard map; peopleList rows carry the PH code and placeLabel's UI_VIZ_LAST_SHARED_HERE or UI_VIZ_HOLDING, never PH_OFFLINE"` — R-V56 (F10).
- `"T-VIZ-text (client): every table keyed by a served string is a Map: __proto__, constructor and prototype handles, paths and display ids change no prototype"`.

**Crashpoints:** none. **Lint:** none (L-VIZ-IMPORT keeps `ui/**` free of Node and DOM-dependent imports).

---

### Task 14: The page

**Group:** G4 (parallel with 7). **Depends on:** 6, 9, 12, 13.

**Files:**
- Modify: `src/viz/client/main.ts`, `src/viz/client/app.css`
- Create: `src/viz/client/api.ts`, `src/viz/client/office.ts`, `src/viz/client/log.ts`, `src/viz/client/rewind.ts`, `src/viz/client/a11y.ts`
- Test: `test/unit/viz/clientStatic.test.ts`, `test/integration/viz/clientBundle.test.ts`, `test/unit/viz/projectedFixtures.test.ts`

**Interfaces:**
- Consumes: Task 13 `ui/**`; Task 12 `composeStatic`, `composeSprites`, `PALETTE`, `ICONS`, `StaticOptions`; Task 4 `viewModel.ts` types; Task 9 `projectEvent`, `projectScene`, `projectPage`, `viewModelSchemas`, `validate` (tests only); Task 6 the row fixtures and `buildTimeline` (tests only); Task 3 `renderWith`, `REASON_CODES`.
- Produces: the page bundle (`app.js`, `app.css`); no export outside the bundle.

**Spec:** 12 §3.5.1 (map), §3.5.2–§3.5.3 (office panel, scrolling, coarse toggle, dashed future desks), §3.6 (name tags, "you" marker), §3.7 (rendering: integer `Z`, offscreen art canvas, `imageSmoothingEnabled = false`, `image-rendering: pixelated`, `fillText` plates cached per (string, size, theme), 12 fps), §3.8 (panel, cards, quoted frame, "new" pill, drawer), §3.9.1 (rewind bar), §3.9.3 (`UI_VIZ_DEMO_BANNER`, the caption strip, R-V32), §3.10.2 (fragment removal), §3.10.5 (`fetch` + reader), §3.11 (language switcher with `localStorage` in try/catch, reduced motion, pause, keyboard order, screen readers, contrast); VIZ-25, VIZ-26, VIZ-34 (page half), VIZ-37, VIZ-39 (no literal), VIZ-40; rulings R-V32, R-V33, R-V35, R-V47, R-V51.

**Tests:**
- `"T-VIZ-lints: L-VIZ-DOM is clean over the real client"` — and the sink list of 12 §9.5 is absent from the bundle text (`innerHTML`, `eval`, `new Function`, `EventSource`, `WebSocket`, `Worker`).
- `"T-VIZ-lints (I18N-07): src/viz/client/** contains no human-text literal"` — every string literal is a code, a CSS class from the fixed enum map, a literal `/api/v1/` path or path head, a header name or a DOM API name.
- `"T-VIZ-lints: every fetch in the client is one ApiRoute's literal /api/v1/ path or literal-headed template, with credentials omit, cache no-store and redirect error; the stream is read with fetch and getReader, never EventSource"` — V8, S11; a room id or height failing its regex makes no request.
- `"data never selects a CSS class outside the enum map and colours come only from palette indices"`.
- `"T-VIZ-lints: the client bundle builds for the 12 §3.13 targets, holds no Node built-in and no module importing src/board/fold.ts, and its size keeps dist/viz.js ≤ 1.5 MB"`.
- `"T-VIZ-seek (projection half): the page's reduceScene over unprojected events equals the projection of the server's reduceScene at every tested position"` — Task 9's `projectEvent`/`projectScene` and Task 13's `unprojectEvent`/`unprojectScene` over every Task 6 fixture (VIZ-26).
- `"T-VIZ-seek: a pet spawned only inside a TimelinePage below h0 reduces with its owner and variant equal to the server's"` — F2, R-V47: the page reduces from the projected page scene and events, never parsing a seat handle.
- `"T-VIZ-api (fixtures): every projection of every Task 6 fixture validates against the generated schemas"` — V4 (moved from Task 9: the fixtures land in G3).
- `"app.css defines the light and dark token sets with chrome text contrast ≥ 4.5:1 and the apricot accent never as text colour"` — computed from the CSS custom properties.

**Crashpoints:** none. **Lint:** none (behaviour in a real browser is Task 17's).

---

### Task 15: The viewer process

**Group:** G6. **Depends on:** 7, 8, 9, 10, 11 (and Task 14 for a real client in the built bundle; the in-process tests inject assets).

**Files:**
- Create: `src/viz/main.ts`, `test/helpers/vizViewer.ts`, `.github/workflows/viz-slow.yml` (Global Constraints, "CI wall time")
- Modify: `src/entry/viz.ts` (`serve` → `main`)
- Test: `test/integration/viz/process.ready.test.ts`, `test/integration/viz/lifetime.test.ts`, `test/integration/viz/readset.test.ts`, `test/integration/viz/readonly.test.ts`, `test/integration/viz/noNetwork.test.ts`, `test/integration/viz/apiE2E.test.ts`, `test/integration/viz/streamE2E.test.ts`, `test/integration/viz/failureSigns.test.ts`, `test/integration/viz/contention.test.ts`, `test/integration/viz/perf.test.ts`, `test/integration/viz/canaries.test.ts`, `test/integration/viz/demoProcess.test.ts`

**Interfaces:**
- Consumes: Tasks 7–11 (sources, `realBoundedReader`, stores, poll, projection, api, http, tokens, hub, log, `verifyDataDir`, `realOwnerProbe`), Task 2 `vizGitRunner`, `createVizGit`; Task 3 `registerCatalog`, `registerReasonCodes`, `EN_VIZ`, `REASON_CODES`; Task 4 `StoreLike`; Plan 1 `realFs`, `realClock`, `realRandom`, `machineMonoMs`, `ownStaleness`, `anchorNow`, `elapsedMono`, `PLUGIN_VERSION`. The git path is `ServeArgs.git` (resolved by the CLI, R-V13); `main.ts` resolves none.
- Produces: `VizExit`, `ServeArgs`, `parseServeArgv`, `ViewerDeps`, `ViewerHandle`, `IDLE_MS`, `LIFETIME_MS`, `PLUGIN_CHECK_MS`, `startViewer`, `main`; `startTestViewer`, `buildDistOnce`.

**Spec:** 12 §3.2 items 2–9, §3.3.2 (read set end to end), §3.9.2, §3.9.3 (a demo run), §3.10 (wiring), §3.12, §5 (invariants), §6 (server-side signs), §7 (T-VIZ-clock, -no-network, -api, -overlay); VIZ-01, VIZ-02 (viewer half), VIZ-03, VIZ-06, VIZ-07, VIZ-11, VIZ-13, VIZ-30, VIZ-35, VIZ-38, VIZ-41, VIZ-42; INV-CLOCK, INV-VIZ-READONLY, INV-VIZ-NOCONTENT, INV-VIZ-LOOPBACK, INV-VIZ-AUTH, INV-VIZ-CUSTODY; rulings R-V13, R-V16, R-V19, R-V22, R-V41, R-V49.

**Tests:**
- `"the ready line is exactly one {v:1, port, launch} line and stdout closes; refusals RF_VIZ_START_FAILED (SEC-20, self-hash), START_TOOL_VERSION (a --git that prints git version 2.42), RF_VIZ_NO_ROOMS, RF_VIZ_REPO_NOT_LIVE, RF_VIZ_DEMO_INVALID with its line and RF_VIZ_BIND_FAILED each produce one refuse line"` — the check order of R-V16; rooms fold only after the ready line; `parseServeArgv` refuses a relative `--git`, `--repo` without `--git` and `--git` with `--demo`.
- `"T-VIZ-lifetime (fake Clock): unredeemed 120 s → VIZ_EXIT_LAUNCH_UNUSED; a suspend gap counts toward the TTL, the idle exit and the lifetime; 10 min without a stream or request → VIZ_EXIT_IDLE; an open stream keeps it alive; 24 h → VIZ_EXIT_LIFETIME; dist/viz.js rewritten or removed → VIZ_EXIT_PLUGIN_REMOVED within 30 s; SIGTERM → bye and VIZ_EXIT_SIGNAL"`.
- `"T-VIZ-lifetime: unauthenticated probes never keep the viewer alive"` — S13: a 401 probe every 60 s for 15 min → `VIZ_EXIT_IDLE` at 10 min.
- `"T-VIZ-readset: every git argv matches the allowlist with the transport-disabling flags; no argument names refs/cowork-local/; cat-file input names only board commits, <oid>:ops.jsonl, <oid>:protocol.json, <oid>:held, <oid>:checkpoint/state.json and live commit objects; no cat-file process serves two batches; Fs and BoundedReader spies see no open under tmp/, log/ of a clone, prov/, cs/, any worktree, ipc.key, user.json or a Claude settings file"` — a 3-clone fixture (status ok, paused, incident) with a filtered secret file, a planted `tmp/stage/` copy and a planted `refs/cowork-local/<e>/holds` commit holding a canary; the canary is in no response, log line or stream payload. Task 20 extends this test with the claim-input clause of 12 §7 (owner choice of 2026-10-08); keep its allowed `cat-file` inputs and argv forms in one table so that edit is one row each.
- `"T-VIZ-readonly: refs, count-objects -v, index bytes, worktree and <gitdir>/cowork/ listings and mtimes are identical before and after 10 virtual minutes of polling, seeks and load earlier"`.
- `"T-VIZ-no-network: a viewer run makes 0 outbound connections and 0 name lookups and holds exactly one listening socket, on 127.0.0.1"` — S14: `net.Socket.prototype.connect`, `http.request`, `dns.lookup`, `dns.promises.lookup`, every `dns.resolve*` and `Resolver` method, and `dgram.Socket.prototype.bind`/`send` instrumented: 0 connects, 0 lookups of a name that is not an IP literal, ≤ 1 lookup of the literal `127.0.0.1` (Node's listen path), 0 datagram binds or sends.
- `"T-VIZ-no-network: a promisor clone's missing live commit makes 0 connections from git children and the room shows UI_VIZ_NO_BOARD"` — S5, F7: the Task 2 fixture (a `file://` promisor remote that is present and holds the object): after the run `git cat-file -e <oid>` (with `GIT_NO_LAZY_FETCH=1`) still fails, the remote's objects directory has no new access, and the world reports `UI_VIZ_NO_BOARD` for that room.
- `"T-VIZ-api (end to end): every response of every route and every stream payload validates against the generated schemas with no additional property; a served card is never re-sent with changed fields, except cards of a world re-sent after a reset caused by HandleTable.takeCollision (R-V22); a timeline page never spans a segment start"`.
- `"T-VIZ-api: a second tab's stream receives the layout delta a first tab's load earlier appended"` — R-V49 (F4): two sessions' streams open; tab 1 requests a page below `h0`; tab 2 receives one `layout` payload whose `from_version` is its version, and both tabs' layouts are equal afterwards.
- `"T-VIZ-stream (end to end): two rooms; commits fetched into the viewer's clone by a daemon fixture arrive as stream events equal to extendTimeline; 65 commits in one tick → one room_snapshot; a resumed stream with Last-Event-ID loses nothing of either room or any kind; SIGTERM → bye"`.
- `"T-VIZ-failure-signs (server): down, unreadable, no board, gone, incident, version skew, newer protocol, checkpoint mismatch, demo banner and stopped each reach the world or the stream as their code"` — the page-side signs are Task 13's and Task 17's; the `repos.json` rows (a room appended within 30 s, a removed `live` marker) are 8b.
- `"T-VIZ-overlay (process): room B's RoomVM and stream payloads contain none of room A's overlay values"` — F5: two rooms whose `status.json` files carry distinct canary values; room A's values appear only in room A's `overlay` and `overlay` payloads.
- `"T-VIZ-clock: no viewer surface renders a date"` — F18: every response, stream payload and log line of this task's runs is scanned for date patterns (ISO 8601, RFC 2822, `YYYY-MM-DD`, `HH:MM`, Unix-epoch seconds or milliseconds of the test run's wall clock) and none is found.
- `"T-VIZ-view-model and T-VIZ-logs (process): no response or log line contains an absolute path, the OS user or host name, a token, a name, a note, a path, a header value or err.message, after the admission and text corpora"`.
- `"T-VIZ-notes (process): transcript, prompt and tool-input canaries planted in the fixture PC's Claude directories appear in no response, log line or stream payload"`.
- `"T-VIZ-demo-format (process): a demo run makes 0 git spawns and touches no file but viz.js, the demo file, the data directory's SEC-20 check and its log directory"` — S17: `startTestViewer({ demo: true })` and `{ demo: <file> }` with a spying runner, an Fs spy and a BoundedReader spy; no `--git` is accepted.
- `"T-VIZ-contention (Windows legs): a writer replacing status.json by temp + rename every 100 ms for 3,000 writes and a daemon fixture fetching the board ref 1,000 times see zero rename or ref-update failures beyond the no-viewer control"` (Review Focus 4).
- `"T-VIZ-perf (Windows and Linux legs; R-V41): 8 rooms × 1,024 heights → first /api/v1/world ≤ 6 s (2×); git processes per tick and batch exactly as counted; 60 s idle CPU including git children ≤ 2 % of one core (2×); a 255-commit seek ≤ 1 s (2×); RSS after extending one room live by 17,280 heights ≤ 200 MB with ≤ 2,048 heights retained"` — boards written by `BoardWriter.commitMany` (Review Focus 3); RSS, the retained heights and the counts are exact (F6).
- `"T-VIZ-env (Linux): the real viewer's /proc/<pid>/environ has no CLAUDE_* value, NODE_OPTIONS, NODE_PATH, GIT_DIR or GIT_INDEX_FILE, has LC_ALL=C and the CLI's filtered PATH"`.
- `"the viewer re-runs the SEC-20 check before creating log/ and deletes viz-*.jsonl older than 14 days at start"`.

**Crashpoints:** none. **Lint:** none.

---

### Task 16: Demo export and golden board timelines

**Group:** G5 (parallel with 8). **Depends on:** 7.

**Files:**
- Create: `tools/viz/export-demo.ts`, `tools/viz/golden.ts`, `test/golden/viz/board-1.timeline.json`, `board-2.timeline.json`, `board-3.timeline.json`
- Modify: `package.json` (`"viz:golden": "tsx tools/viz/golden.ts"`, inserted directly after `"build"`; no other line, R-V02)
- Test: `test/integration/viz/exportDemo.test.ts`, `test/integration/viz/golden.board.test.ts`

**Interfaces:**
- Consumes: Task 2 `BoardWriter` (with `malformed()` and `commitMany`), `VizGit`, `createVizGit`, `vizGitRunner`, `readBoardCommits`, `readLiveCommits`; Task 7 `GitRoomSource`, `DemoRoomSource`, `serializeDemoLog`, `parseDemoLog`, `DemoCaption`; Task 6 `buildTimeline`, `serializeTimeline`.
- Produces: `exportDemo`; the `export-demo` CLI; `npm run viz:golden [-- --update]`; the three board goldens.

**Spec:** 12 §3.9.3 ("Producing a demo log"), §3.3.5 ("Serialization"), §7 T-VIZ-golden-sim (board form, R-V37); VIZ-27, INV-VIZ-DET; ruling R-V19.

**Tests:**
- `"export-demo writes one commit record per board commit from height 0 with held, code, cs and csPaths, and captions only from --captions"` — the output parses with `parseDemoLog` and has LF, no BOM, no CR.
- `"export-demo encodes unreadable live commits and malformed board commits so the demo folds to the same timeline"` — R-V19 (F8): a `not_commit` and a three-parent live commit → `code {changed: false, seats: [], base: null}`; a malformed board commit → `writer null, ops [], cs [], csPaths {}, held []` with that `code`; a board with a missing object → the CLI exits 1 and writes no file.
- `"--oplog only prints each op-log entry beside the heights of its peer's board commits and never adds a record"` (12 §1.5 item 8).
- `"export-demo reads the board only through VizGit"` — the runner spy sees only allowlisted argv.
- `"T-VIZ-golden-board: for three scripted boards (three peers, ≥ 300 heights, every row the Plan 2 fold applies, one > 256-path change-set, a respawn, a freeze, a throttle, a leave and same-epoch rejoin, a not_commit live commit, a three-parent live commit and a malformed board commit) the git-source timeline and the exported demo's timeline are byte-identical on every OS; a second run is byte-identical; on the Linux leg both equal test/golden/viz/board-<n>.timeline.json"`.
- `"viz:golden compares without --update and rewrites only with --update"`.

**Reconciliation amendment (2026-10-08; F-8a-5; X-91; Task 16 had not started).** `npm run viz:golden [-- --update]` is the one way every plan regenerates 8a's goldens (Plan 3's "3-V" rows, Plan 4's R4-55 `PLAN2_REGION_SPEC` and R4-68 rows, Plan 6's R6-63 goldens and storyboard), so it lands early: Task 16's first commit is `tools/viz/golden.ts` and the `package.json` line, covering every golden that exists when it lands — Task 6's `test/golden/viz/rows/*.events.json` from the start, the board goldens of this task, then Task 18's SIM seeds — and the controller merges that commit as soon as Task 6 has merged (it needs nothing of Task 7), ahead of the rest of Task 16 and of G5; the `export-demo` half and the board goldens keep their G5 slot. Test added: `"viz:golden --update regenerates the row goldens of Task 6 byte for byte, and compare mode reports the first differing file"`.

**Owner choice of 2026-10-08 (X-92 decided; 12 §3.9.3 as amended; Task 16 has not started).** `exportDemo` writes `live` (the named live commit's oid) on every record whose `code.changed` is true; `claims` is written by Task 20. Test added: `"export-demo writes live on every changed record and the git-source and demo timelines stay byte-identical"`.

**Crashpoints:** none. **Lint:** none.

---

### Task 17: Browser smoke (Chrome DevTools Protocol, no package)

**Group:** G7. **Depends on:** 14, 15.

**Files:**
- Create: `test/helpers/cdp.ts`, `test/integration/viz/browserSmoke.test.ts`, `test/fixtures/viz/xss-canaries.jsonl` (a demo log whose names, branch, room label, paths and captions carry the XSS corpus and set `window.__pwned` if ever executed), `test/fixtures/viz/xssStores.ts` (fake `StoreLike`s serving hand-written `note`, `request_open`, `answer` and `claim_take` events and cards whose text and labels carry the same corpus)

**Interfaces:**
- Consumes: Task 15 `startTestViewer` (with `deps.stores`), `buildDistOnce`; Task 4 `StoreLike`, `ev`; Node ≥ 22 `WebSocket`; the runner's preinstalled Chrome or Chromium.
- Produces: `findChrome`, `launchChrome`.

**Spec:** 12 §7 T-VIZ-browser-smoke items (a)–(g) and (i) (item (h) is 8b), §3.12 (page budgets), §9.5 (CI matrix: no package added); VIZ-05 (fragment arrives), VIZ-31, VIZ-33, VIZ-37, VIZ-40, VIZ-41 (page half), VIZ-42; ruling R-V41.

**Tests:** (each SKIPPED without Chrome or on Node < 22; 8a's exit needs one green leg; the exit sweep finds them by this file's name, F19)
- `"(a) after load the URL has no fragment and sessionStorage holds the session"`.
- `"(b) zero CSP violation reports"` — `Log.entryAdded` and `securitypolicyviolation` events.
- `"(c) every request goes to the viewer origin"` — `Network.requestWillBeSent` over the whole session.
- `"(d) a reload keeps working; a second tab opened with the same link shows UI_VIZ_LINK_REUSED and the first shows UI_VIZ_STOPPED"`.
- `"(e) the XSS canary demo never sets window.__pwned and every canary string renders as text"` — also against a `startTestViewer` whose `deps.stores` serve the hand-written note, request, answer and claim events (S20), so the quoted-frame and bubble paths are exercised on Plan 2 data too.
- `"(f) a page served from another local port reads nothing from /api/v1/world with or without a copied session header, and an iframe of the viewer is refused"` (Review Focus 2).
- `"(g) with emulated prefers-reduced-motion the root carries data-motion=\"reduced\" and no walk frame is drawn"`.
- `"(i) the canvas has the UI_VIZ_SCENE_SUMMARY label and the hidden people list exists"`.
- `"page budgets: JS heap ≤ 150 MB and CPU while animating ≤ 20 % of one core (2×, R-V41) over 60 s of the bundled demo replaying at 1×"` — F6: `Performance.getMetrics` (`JSHeapUsedSize`, `TaskDuration` over wall time); the heap value is exact, the CPU value has CI's 2× (the exact 10 % is Task 18's manual check).

**Note (2026-10-08, F-8a-1).** Rev 2.5's smoke list adds (j) (F34 postcards, 8b) and (k) (F32, T-VIZ-follow-privacy); Task 19 appends (k) without its recording clause to this file after this task has merged; (h), (j) and (k)'s recording clause are 8b's.

**Crashpoints:** none. **Lint:** none.

---

### Task 18: Plan 2 storyboard, bundled demo, `view --demo`, SIM golden, spec batch, exit sweep

**Group:** G8 — **step A** after Tasks 15, 16, 17; **step B** after step A (Plan 2 Tasks 18–19, which the SIM golden needs, are part of Plan 2's exit and so of gate P, R-V01, R-V37).

**Files:**
- Create: `tools/viz/storyboard.ts`, `tools/viz/storyboard.captions.jsonl`, `test/integration/viz/storyboard.test.ts`, `test/integration/viz/demoE2E.test.ts`; step B: `test/integration/viz/golden.sim.test.ts`, `test/golden/viz/viz-golden-1.timeline.json`, `viz-golden-2.timeline.json`, `viz-golden-3.timeline.json`, `test/integration/viz/exitSweep.test.ts`
- Modify: `src/viz/demo/plan2.jsonl` (the real storyboard), `src/viz/i18n/en.ts` (the five `UI_VIZ_DEMO_CAPTION_*` templates), `tools/viz/golden.ts` (step B: the SIM seeds); step B2 (controller): `docs/spec/12-visualizer.md`, the 12 §9.2–§9.7 target chapters (`00-glossary`, `06-claude`, `09-security`, `10-product`, `11-testing`) and, only if R-V01's ahead tasks ran ahead, the roadmap's execution-order sentence

**Interfaces:**
- Consumes: Task 2 `BoardWriter`; Task 16 `exportDemo`; Task 11 `runView`; Task 15 `buildDistOnce`; Task 17 `launchChrome` (when Chrome exists); step B: Plan 2 `runSim`, `Oracle` (its `atQuiescence(ctx)` hook), `SimContext`, `PeerClone`, `realEngine` (test/sim/engineAdapter.ts), the `edits` profile, `RELEASE_NAMESPACE`, `clonePeer`.
- Produces: the bundled Plan 2 storyboard demo; `node dist/cli.js view --demo` working end to end; the SIM goldens; the applied spec-edit batch.

**Spec:** 12 §3.9.3 ("The bundled demo", the Plan 2 storyboard), §7 T-VIZ-golden-sim, §9 (all edits), §9.1 (roadmap row 8, 8a exit criterion); VIZ-27, VIZ-41 (exact budgets on the reference laptop), INV-VIZ-DET; rulings R-V02, R-V37, R-V41.

**Steps:**
- [ ] Step A1: write `tools/viz/storyboard.ts`: a temp repository, `BoardWriter` peers `mina`, `theo`, `jun` (display names are fictional), the scripted Plan 2 storyboard below, `exportDemo` with `storyboard.captions.jsonl` (3–5 caption codes `UI_VIZ_DEMO_CAPTION_1…5`), output `src/viz/demo/plan2.jsonl`; `--check` compares byte for byte.
- [ ] Step A2: the storyboard tests and the end-to-end test below; commit.
- [ ] Step B1: `golden.sim.test.ts` and the three SIM goldens via `npm run viz:golden -- --update`, diff reviewed in the PR; commit.
- [ ] Step B2 (controller): merge `main` forward so it holds Plan 2's own spec-wording batch first (R-V02's order), then apply 8a's spec-edit batch (§Scope rulings, "Spec conflicts and gaps", items 1–8) and the 12 §9.2–§9.7 edits; commit.
- [ ] Step B3: the exit sweep; commit.

**Tests:**
- `"the bundled demo is cowork-viz-demo/1, ≤ 64 KiB, LF without BOM or CR, one room shop-app on main, ≤ 120 heights and 3–5 caption codes defined in en"`.
- `"the storyboard shows every Plan 2 fact 12 §3.9.3 lists"` — asserted on its timeline: the room opens; three people enter one after another; human change-sets reach at least six file desks in at least three zones (`src/…`, `test`, `·`); two people at one desk (chair and visitor); one change-set with paper planes to two other desks; one change-set of more than 256 paths at the big table; one person frozen (EPOCH) and thawed; one slowed (`HOST_THROTTLED`) and later `person_bang{host}`; one respawn with a new epoch; a `pose_relaxed` 64 heights after a person's last publish.
- `"regenerating the storyboard reproduces src/viz/demo/plan2.jsonl byte for byte"` — `node tools/viz/storyboard.ts --check`.
- `"node dist/cli.js view --demo works end to end"` — `runView(['--demo', '--no-open'])` in `tty` mode against the built `dist/`: prints `UI_VIZ_URL` with a URL matching `URL_RE`; redeeming it gives a session; `/api/v1/world` has `demo: true`, one room, the captions and the scene at `h1`; with Chrome, the page renders the office and shows `UI_VIZ_DEMO_BANNER`; the viewer exits on `SIGTERM` with `bye`.
- Step B: `"T-VIZ-golden-sim: SIM seeds viz-golden-1..3 (profile edits, 3 peers): the timeline read through git from peer 0's board after quiescence and the timeline of its exported demo log are byte-identical on every OS; a second run is byte-identical; on the Linux leg both equal test/golden/viz/viz-golden-<n>.timeline.json"` — V20: both timelines are computed inside an `Oracle.atQuiescence(ctx)` hook from `ctx.peers[0].dir`'s `RELEASE_NAMESPACE` board ref (`runSim` deletes its temp root on success), and the hook returns `null`.
- Step B: `"exit sweep: every T-VIZ id named in roadmap row 8 (8a) is carried by a test title starting with T-VIZ-<id> and is green on the three OS legs; browser smoke (a)–(g) and (i) green on one leg"` — F19: a title scan over `test/**/viz/**` against the row's list (each title must start with `T-VIZ-<id>` followed by `:` or ` (`), and the browser smoke is matched by `test/integration/viz/browserSmoke.test.ts`; a missing id fails the sweep; the spec files hold every item of the spec-edit batch (a checklist scan).

**Crashpoints:** none. **Lint:** none.

**Manual check (8a exit, recorded in the task report):** `node dist/cli.js view --demo` in a terminal on Windows, macOS and Linux opens the default browser on the storyboard with no firewall prompt; `node dist/cli.js view --repo <a Plan 2 clone>` shows the live room while `node dist/daemon.js run` publishes. On the Windows reference laptop (R-V41, F6): first `/api/v1/world` ≤ 3 s for 8 rooms × 1,024 heights, 60 s idle CPU including git children ≤ 1 % of one core, a 255-commit seek ≤ 500 ms, and the page ≤ 10 % of one core while animating — the exact values CI checks only with 2× slack.

**Reconciliation amendment (2026-10-08; F-8a-12; X-03, X-04, X-92, X-94; Task 18 had not started).**
- **Step B2's batch** is applied against rev 2.5, after Plan 2's batch and before Plan 3's (the one order Plan 2 → 8a → 3 → 4 → 5 → 6 → 7 → 8b), and names the batch it follows. It drops every item rev 2.5 already carries — the D1–D5 text of glossary §29.1/§29.8 and of roadmap rows 2, 3, 7 and 8, including F32's §7 items 1–9 and 11 (D3) and the first-release text (D4) — keeps every 8a item rev 2.5 lacks, and adds items 10–12 of §Scope rulings' list (item 9 is withdrawn: the owner chose X-92's real-time alternative, whose 12 edits are the 12 owner's on `proposals`, not 8a's batch; the X-94 prefix wording, the batch form, the stale "provisional" in 12 §9.1) plus the ledger's spec-edit-list entries (R-V57…R-V74 and the unnamed rulings). It does not touch 12 §9.9: each feature task moves its own codes into §3.11 (Task 19 for F32; Task 20 for `UI_VIZ_CLAIMS_PENDING`; F04-b and 8b for theirs).
- **Step B3's exit sweep** finds roadmap row 8 (8a) listing Task 19's ids too (T-VIZ-follow-camera, -follow-motion, -follow-now, -follow-plan2, -follow-replay, -follow-filter, -follow-keys, -follow-i18n and browser smoke item (k)); Task 18's run reports exactly those as pending Task 19 instead of failing, and Task 19 re-runs the sweep with them required — that re-run, not Task 18's, closes 8a's exit. The checklist scan counts an item rev 2.5 already carries as present.

---

### Task 19: Follow a teammate (F32)

*(Added 2026-10-08 by the cross-plan reconciliation, F-8a-1, from `proposals/docs/proposals/F32-follow-teammate.md` and spec rev 2.5 12 §3.8.1; owner decision D3, glossary §29.1: F32 ships in 8a as Task 19, its six-language strings and the recording clause of smoke item (k) in 8b.)*

**Group:** G9 (after G8). **Depends on:** 5 (`reduceScene`, `phOf`, R-V25's position-typed `lastPublish` and `lastDesk`), 12 (`placeTile`), 13 (`ui/a11y.ts`, `LogFilter`, `SeekCache`, `FollowRule`, `shouldPoof`, `unprojectScene`), 14 (the client), 17 (`browserSmoke.test.ts`, `cdp.ts`), 18 (the bundled demo, the spec batch, the exit sweep). Nothing from Plans 3–7: their claims (Plan 4, once a seat's pet exists) and requests (Plan 6) fill the now card's rows when their folds land, with no change to this task's code (12 §3.8.1 "What shows when"). Tasks 13 and 14 keep their reviewed contracts; F32 stays droppable without touching them.

**Files:**
- Create: `src/viz/ui/follow.ts`; `test/unit/viz/ui.follow.test.ts`, `test/unit/viz/follow.i18n.test.ts`, `test/integration/viz/follow.plan2.test.ts`; `test/fixtures/viz/two-rooms.jsonl` (a valid two-room `cowork-viz-demo/1` log for smoke item (k))
- Modify: `src/viz/ui/a11y.ts` (`KeyAction` `'follow'`, `KEYS` `F`), `src/viz/client/{office,log,a11y}.ts` (the wiring of §Interfaces' client note), `src/viz/i18n/codes.ts` and `src/viz/i18n/en.ts` (the eight codes), `test/unit/viz/i18n.test.ts` (row and wording maps), `test/integration/viz/browserSmoke.test.ts` (item (k)), `test/integration/viz/exitSweep.test.ts` (the F32 ids required); outside `src/viz/**` per the R-V02 rows of 2026-10-08: `docs/spec/12-visualizer.md` (the eight codes move from §9.9 into §3.11; the §9.9 F32 bullet is removed) and roadmap row 8 only if it lacks the Task 19 sentence. `ui/fragment.ts`, `ui/zoom.ts`, `src/viz/model/**`, `src/viz/server/**` and `viewModel.ts` are not modified (FEAT-F32-01).

**Interfaces:**
- Consumes: Task 5 `reduceScene`, `comparePos`, `phOf`, `Scene`, `ActorState`; Task 4 `Layout`, `Desk`, `plaqueOf`, `Tile`, `ActorRef`, `PeerRef`, the `viewModel.ts` types; Task 12 `placeTile` (client only); Task 13 `KeyAction`, `KEYS`, `LogFilter`, `LogModel`, `Announcer`, `peopleList`, `SeekCache`, `FollowRule`, `unprojectScene`; Task 3 `renderWith`, `VIZ_CODES`, `EN_VIZ`; Task 15 `startTestViewer`, `buildDistOnce`; Task 17 `findChrome`, `launchChrome`; Task 18 `src/viz/demo/plan2.jsonl`, `exitSweep.test.ts`.
- Produces: `FOLLOW_PAN_MS`, `NOW_ROWS_MAX`, `followedActors`, `focusActor`, `cameraTarget` (returns `number | null`, X-93), `FollowCamera`, `followMotion`, `NowCard` (X-93's shape plus the `more` refinement, ratified by reconcile §7 V-19), `nowCard`, `FollowSet` (§Interfaces, "Page logic"); `KeyAction` `'follow'` and `KEYS` `F`; the codes below with their en templates. No route, request, payload, view-model field, scene-event kind, `Timeline` or `Scene` field, log line, storage key or fragment key (FEAT-F32-01).

| Code | en template | Params | Group (`codes.ts`) |
|---|---|---|---|
| `UI_VIZ_CTRL_FOLLOW` | Follow | — | `control` (Controls and filters) |
| `UI_VIZ_FOLLOWING` | Following {name} | `name: name` | `scene` (Scene labels) |
| `UI_VIZ_NOW_ASKS` | asks {target} ({id}) | `target: name`, `id: id` | `scene` |
| `UI_VIZ_NOW_ASKED_BY` | asked by {target} ({id}) | `target: name`, `id: id` | `scene` |
| `UI_VIZ_NOW_LAST_SHARED` | last shared: {path} (#{height}) | `path: path`, `height: n` | `scene` |
| `UI_VIZ_NOW_LAST_SHARED_TABLE` | last shared: a change too large to list (#{height}) | `height: n` | `scene` |
| `UI_VIZ_NOW_NOTHING` | Nothing held, asked or shared yet in this view. | — | `scene` |
| `UI_VIZ_NOW_NOT_HERE` | {name} is not in this room at this point. | `name: name` | `scene` |

Reused: `UI_VIZ_HOLDING`, `UI_VIZ_MORE`, `UI_VIZ_ICON_*`, `PH_*`. All eight are `UI_VIZ_` codes, so `PAGE_CODES` and `/api/v1/strings` carry them with no server change.

**Spec:** 12 §3.8.1 (rev 2.5), §3.5.3 (the follow camera replaces the 30 s rule in a followed room), §3.8 (filters, never in the fragment), §3.11 (the follow codes; `Esc` with no export panel open also ends the selected room's follow; `F`), §3.13 (`ui/follow.ts`, the client wiring), §4 VIZ-24 and VIZ-28 (rev 2.5 sentences) and "Following" FEAT-F32-01…12, §7 the T-VIZ-follow-* rows and browser smoke item (k), §9.9 (the F32 bullet); glossary §2 (a display name is never an input), §29.1 D3; rulings R-V22, R-V25, R-V56; X-93. Rev 2.5 already carries F32 §7 items 1–9 and 11, so this task's only spec edit is the §9.9 → §3.11 move (X-03).

**Steps:**
- [ ] Step 1: `src/viz/ui/follow.ts` test-first with `ui.follow.test.ts` (the camera, motion, now, replay, filter and keys tests below); commit.
- [ ] Step 2 (one commit, FEAT-F32-09 — T-VIZ-i18n deep-equals the §3.11 table with `codes.ts`): the eight codes in `codes.ts` and `en.ts`, the 12 §3.11 edit (Scene labels: append the seven `scene` codes; Controls and filters: append `UI_VIZ_CTRL_FOLLOW`; remove the §9.9 F32 bullet), `i18n.test.ts`'s row and wording maps, and `follow.i18n.test.ts`.
- [ ] Step 3: the client wiring and the `KeyAction`/`KEYS` addition, with `follow.plan2.test.ts`; commit.
- [ ] Step 4: browser smoke item (k) without its recording clause, and the exit sweep re-run with the F32 ids required (Task 18's amendment); commit.

**Tests:** (titles start with the id for the exit sweep; unit tests in `ui.follow.test.ts` unless named)
- `"T-VIZ-follow-camera: the three-step camera over the followed actors"` — an office of 12 cells (44 tiles tall), a view of 20 tiles at the top (rows 0–19); peer A's character at the slot-0 chair of cell 0 (y 6) and its pet at the slot-0 chair of cell 1 (y 6), both visible; peer B publishes at a desk of cell 11 → `null`; A's pet walks to the slot-0 chair of cell 10 (y 36) → the frame (rows 5–37, 33 tiles) does not fit → the pet's tile is centred, clamped to the office (view rows 24–43); both A actors walk to the slot-0 chairs of cells 3 and 4 (y 16, above the view) → the frame (rows 15–17) fits and is centred (view top 6.5); one of them walks to cell 5 (y 16, inside the view) → `null` (step 1); a chip click (`force`) → the frame is centred even so; after `userScrolled()` a B beat and an A beat with no `place` change → no scroll, the next A move → scroll; room 2 without follow: `FollowRule`'s 30 s rule scrolls to an off-screen event only 30 s after the last user scroll (FEAT-F32-03, -04).
- `"T-VIZ-follow-motion: pan or jump"` — with a fake scroller: 2× replay → one 300 ms smooth scroll; 4× → jump; emulated reduced motion and the in-page toggle → jump; a seek, a `room_snapshot`, "load earlier" and a room switch → jump; paused → no scroll call; `Z` and the coarse flag unchanged after 100 beats (FEAT-F32-05, -03).
- `"T-VIZ-follow-now: the now card rows"` — a hand-built scene: A has pets P1 and P2, B has pet Q1; P1 holds 4 HELD claims and 1 STALE → 3 holding rows and `UI_VIZ_MORE` n = 1, no stale row; R1 from P1 to Q1 with status `queued_until_turn_end` → "asks {B's name} (R1)" with `UI_VIZ_ICON_QUEUED`; R3 from P1 with status null → an asks row without an icon; R2 from Q1 to P2 → an asked-by row; P2's `lastPublish` (40, 1001, 0) at the file desk `src/cart.ts` and the character's (38, 1001, 0) → "last shared: src/cart.ts (#40)", unchanged after P2 ends (`live` false); P2's newest publish at a folder desk → its plaque, at a shelf desk → its zone sign + `/…`, at the big table → `UI_VIZ_NOW_LAST_SHARED_TABLE`; A frozen with `PAUSED` → the header label `PH_PAUSED`; A a ghost → no header label; A at home with nothing → `UI_VIZ_NOW_NOTHING`; A removed from `characters` → `UI_VIZ_NOW_NOT_HERE`; an overlay canary (holds 7, incoming 5, A is "you") → no overlay value in the card; no row text contains a "working on" template (FEAT-F32-06).
- `"T-VIZ-follow-plan2: following each storyboard person shows only Plan 2 rows"` (`follow.plan2.test.ts`, integration) — the bundled Plan 2 storyboard demo (12 §3.9.3), following each of its three people over every height → only header, last-shared, empty or not-here rows; the last-shared row names the `target` desk and the height of that person's newest `publish` event in the segment at each height (FEAT-F32-06, -07).
- `"T-VIZ-follow-replay: live and replay agree"` (property) — at the 200 random positions of T-VIZ-seek, `nowCard` and `cameraTarget` from the page's `reduceScene` in replay equal those captured live at the same position, both over view-model ids (FEAT-F32-07).
- `"T-VIZ-follow-filter: follow pins the person filter per room"` — start → `LogFilter.peer` = A; file and kind filters AND-combine; choosing B, clearing the person filter or `Esc` with no export panel open → the follow ends in that room only; follow A in room 1, select room 2 (no follow, the 30 s rule), back to room 1 → A followed again and `LogFilter.peer` = A; rooms 1 and 2 each with a "Minji" of different peer ids → following room 1's Minji follows nobody in room 2; a world reload in which A's handle is extended (R-V22 collision) → the follow ends; a page reload → no follow, and `location.hash` never held follow state (FEAT-F32-02, -08).
- `"T-VIZ-follow-keys: F toggles follow only with a person filter"` — `F` with a person filter toggles the follow and `aria-pressed`; `F` without one → nothing; `F` in the language select → nothing (FEAT-F32-02, -11).
- `"T-VIZ-follow-i18n: the eight follow codes"` (`follow.i18n.test.ts`; CI lint) — each renders in every registered catalog (8a: `en`) within the `viz` caps with equal placeholder sets, and no template matches en `monitor|track|surveil|spy|supervis|watch` (8b adds the ko, ja, zh-CN, fr and es denylists of 12 §7) (FEAT-F32-09).
- `"(k) T-VIZ-follow-privacy: following sends, stores and logs nothing"` (`browserSmoke.test.ts`; SKIPPED without Chrome or on Node < 22, like Task 17) — with `two-rooms.jsonl`, toggling follow 50 times, switching rooms and seeking → zero requests besides the timeline pages the seeks need; no `localStorage` change and no `sessionStorage` change except the selected room id (12 §3.2 item 11); `location.hash` never contains follow state; the viewer log gains no line. The recording clause is 8b's (FEAT-F32-01; FEAT-F32-10 in 8b).
- `"T-VIZ-lints: the follow wiring is clean"` — L-VIZ-DOM, L-VIZ-IMPORT and `L-VIZ-TYPES` stay green over the real client with `follow.ts` in the client program (it imports `model/**` only), and the client still holds no human-text literal.

**Crashpoints:** none. **Lint:** none new (Task 1's rules cover `follow.ts` and the wiring).

---

### Task 20: Claim inputs for the viewer's fold (owner choice of 2026-10-08; X-92 decided; F-8a-13)

**Group:** G10 (after G9; when 8a has exited first, a follow-up with the same owner, the 8a controller, like F04-b). **Depends on:** Plan 4 Task 8 merged into `main` and `main` merged forward (`claimFoldNeeds`, `ClaimFoldNeeds`, `ClaimFoldInputs`, `FoldObjectMissingError`, the four-argument `foldCommit`, `overlapPairsOf` of `src/claims/overlapPairs.ts`, `foldOverlap`, `lineArray`); Tasks 6, 7, 8, 9, 15, 16 and 18 merged (it edits their files). Part of 8b's gate Q (R8B-01); not part of 8a's exit when 8a exits before Plan 4 Task 8.

**Why a new task.** On 2026-10-08 the owner chose X-92's alternative (12 §3.3.2, §3.3.3, §3.9.3, VIZ-06…VIZ-09; INV-VIZ-NOCONTENT narrowed, not removed): the viewer's own fold reads, in memory only, the tree entries and blobs `claimFoldNeeds` names, so claim events between checkpoints are drawn. Completed Task 1 (the allowlist grammar `vizGitArgvOk` and L-VIZ-GIT) and Task 2 (`VizGit`, with no ancestry call) built the read set without claim inputs; their task text stays as landed and this task changes their files. Plan 2's `foldCommit` has no fourth argument before Plan 4 Task 8, so nothing here can start earlier; on a Plan 2 build every claim op is `unfolded` with or without inputs, so the viewer before this task is correct for its build.

**Files:**
- Create: `src/viz/source/claimInputs.ts`
- Modify: `src/viz/source/vizGitArgv.ts` (Task 1: the form `merge-base --is-ancestor <oid> <oid>`; `VIZ_GIT_SUBCOMMANDS` gains `merge-base`), `src/viz/source/vizGit.ts` (Task 2: `VizGit.isAncestor`), `src/viz/model/frame.ts` (Task 6: `FrameInput.claimInputs`, passed as `foldCommit`'s fourth argument), `src/viz/source/git.ts` (Task 7: the per-commit `readClaimInputs`, `ClaimsPendingError`), `src/viz/source/demo.ts` (Task 7: `demoClaimInputs` per draft), `src/viz/server/store.ts` (Task 8: the pending state, the retry), `src/viz/server/models.ts` (Task 4: `RoomBadge` gains `'UI_VIZ_CLAIMS_PENDING'`), `src/viz/server/api.ts` (Task 9: the 404 body), `src/viz/main.ts` (Task 15: one ancestry memo per room), `src/viz/i18n/{codes,en}.ts` (Page states: `UI_VIZ_CLAIMS_PENDING`), `test/unit/viz/i18n.test.ts`, `tools/viz/export-demo.ts` (Task 16: `claims` per claim-carrying commit through `recordClaimInputs`), `test/integration/viz/readset.test.ts`, `test/integration/viz/poll.test.ts`, `test/integration/viz/perf.test.ts`; spec `docs/spec/12-visualizer.md` (§9.9's owner-choice item moves into the §3.11 Page states row in this task's merge)
- Test: `test/unit/viz/claimInputs.test.ts`, `test/integration/viz/claimInputsParity.test.ts`, `test/integration/viz/claimFold.test.ts`, `test/integration/viz/nocontent.test.ts`, `test/integration/viz/claimsPending.test.ts`, `test/integration/viz/demoClaims.test.ts`, and the modified tests above

**Interfaces:**
- Consumes: Plan 4 Task 8's names above and `generateClaimBoard`, `importClaimBoard`, `claimFoldResolver`, `Folder` (tests only); Tasks 1, 2, 4, 6, 7, 8, 9, 15, 16 as landed.
- Produces: exactly §Interfaces "Task 20 additions" (§Sources).

**Spec:** 12 §3.3.2 (the claim-fold row and "Never read"), §3.3.3 ("Claim inputs", "Missing claim inputs", "Checkpoints"), §3.3.4, §3.9.3 (`live`, `claims`, "Producing a demo log"), §3.12, §3.13, VIZ-06…VIZ-09, VIZ-27, §5 INV-VIZ-NOCONTENT and INV-VIZ-DET, §6 (the claim-input row), §7 T-VIZ-readset, T-VIZ-nocontent, T-VIZ-claim-fold, T-VIZ-demo-format, T-VIZ-poll, T-VIZ-perf, §9.5 L-VIZ-GIT, §9.9 — all as amended on 2026-10-08; Plan 4 R4-26, R4-27.

**Steps:**
- [ ] Step 1: confirm that Task 6's fix round removed the withdrawn re-seed (`CLAIM_FOLD_KEYS`, the `claimKeys` parameter, the re-seed branch and its test, ledger: the run reported at 17:07 on 2026-10-08 implemented it); if any of it merged, remove it here, red first (Task 6's amended checkpoint test fails on the re-seed and passes after the removal); commit.
- [ ] Step 2: the allowlist form and `VizGit.isAncestor` (tests first); commit.
- [ ] Step 3: `src/viz/source/claimInputs.ts` and the parity test against Plan 4's `claimFoldResolver`; commit.
- [ ] Step 4: claim inputs on every frame in `foldFrame`, `GitRoomSource.frames()` and `DemoRoomSource`; T-VIZ-claim-fold; commit.
- [ ] Step 5: the pending state, the retry, the 404, the poll counts; commit.
- [ ] Step 6: `export-demo` writes `claims`; the demo tests; commit.
- [ ] Step 7: `UI_VIZ_CLAIMS_PENDING` in `codes.ts`/`en.ts` and from 12 §9.9 into §3.11's Page states row, in one merge; commit.
- [ ] Step 8: T-VIZ-nocontent, T-VIZ-readset (claims), T-VIZ-perf (claims), the bundle check; `npm run ci` green; commit.

**Tests:**
- `"vizGitArgvOk: merge-base --is-ancestor <oid> <oid> exactly"` — accepted with two `isOid` values; refused: `['merge-base', a, b]`, `--is-ancestor` with a ref name or `HEAD`, a third argument, `--all`, `--octopus`; L-VIZ-GIT passes the new call site in `vizGit.ts` and fails a planted `['merge-base', a, b]` (T-VIZ-lints).
- `"VizGit.isAncestor: rc 0 → true, rc 1 → false, otherwise 'missing'; the transport-disabling flags and GIT_NO_LAZY_FETCH=1 are present"` — real git, a fixture with an ancestor, a non-ancestor and a missing object.
- `"readClaimInputs answers as Plan 4's claimFoldResolver"` (`claimInputsParity.test.ts`) — over 20 `generateClaimBoard` seeds and fixtures with a forged tombstone anchor (present, not an ancestor), an absent anchor commit, an absent path, a nested path and a deleted anchor blob: equal answers for every key `foldCommit` asks, and `null` exactly where `claimFoldResolver` throws `FoldObjectMissingError`.
- `"every frame folds with inputs; a commit without claim ops costs no read"` — a spy on `foldCommit` sees a fourth argument on every call from `GitRoomSource.frames()`, a re-fold, a "load earlier" page and `DemoRoomSource`; a runner spy counts 0 claim-input processes on a 300-height board without claim ops and, per claim-carrying commit, one `cat-file --batch` (plus one per blob over the budget) and one `merge-base` per tombstone anchor not answered yet; no claim-input `cat-file` process serves two board commits; no argv holds `--filters` or `--textconv`; a `leave` and a `seat_end` on a board with HELD claims release them in the viewer's state as in the daemons'.
- `"T-VIZ-claim-fold"` (12 §7) — a 4-peer SIM `claims` board of ≥ 1,300 heights read through git: every checkpoint compares `match`, and the frames' claim verdicts and states equal `Folder` with `claimFoldResolver` at every height; a demo exported from it (with `live` and `claims`) folds to the byte-identical serialized timeline; one claim-input answer flipped through a test seam → `UI_VIZ_CHECKPOINT_MISMATCH` at the next checkpoint and the viewer keeps folding its own state; `src/viz/**` exports no `CLAIM_FOLD_KEYS`.
- `"T-VIZ-nocontent"` (12 §7) — the board, the canary and the scans of 12 §7's row, over a real viewer run (`startTestViewer`) and over `export-demo` and `viz:golden` on that board: the canary is in no response body or header, stream payload, log file line, other written file (an fs spy: only the log files are written), stdout or stderr byte, exported demo or golden, and a deep scan after the run finds no `Buffer` and no canary string in any frame, fold state, timeline, kept checkpoint state, carry, card or view model; the `claim_take` of the valid claim is drawn.
- `"T-VIZ-readset (claims)"` — Task 15's test on a board with claim ops: `cat-file` input names, per board commit, exactly (as a multiset) the `<commit>:<path>` entries and the anchor blobs its `claimFoldNeeds` names (recomputed by the test over the same frames), and `merge-base --is-ancestor` runs only for its tombstone anchors.
- `"claims pending"` (`claimsPending.test.ts`) — a promisor clone missing a claimed anchor blob: the room's window stops below that commit with `UI_VIZ_CLAIMS_PENDING` among its badges and keeps the last folded scene; 0 outbound connections and the object still absent after the run (`GIT_NO_LAZY_FETCH=1`); with a `VirtualClock`, one `cat-file --batch-check` of that oid per 30 s and one on a stat-pair change; `GET …/timeline` over those heights → 404 `{"code":"UI_VIZ_CLAIMS_PENDING"}`; after the test writes the object (`git hash-object -w`), the next retry extends the window with the events, cards and layout a fresh `buildTimeline` gives (VIZ-10) and the badge clears; a claim-input `cat-file` that fails for another reason is handled the same way, and no viewer log line carries a path, a blob byte or git's message text.
- `"T-VIZ-poll (claims)"` — 8 idle rooms: still at most one `rev-parse` per room per 60 s; a room in the pending state adds at most two `cat-file --batch-check` per 60 s.
- `"demo claims"` (`demoClaims.test.ts`) — `demoClaimInputs` returns the recorded answers; an unanswered tree question → `'ABSENT'` and an unanswered pair → `true`, so a claim with a missing answer folds `rejected` and draws nothing (no refusal: demo rooms fold after the ready line); a record without `claims` still folds with inputs; `recordClaimInputs(needs, inputs)` lists exactly the named keys; `export-demo` writes `claims` only on commits with claim ops and only oids, `'ABSENT'`, ids and booleans.
- `"T-VIZ-lints: dist/viz.js carries no worker pool or grammar runtime"` — the esbuild metafile of `viz.js` holds `src/claims/overlapPairs.ts`, `src/regions/foldOverlap.ts`, `src/regions/mapper.ts` and `src/regions/lines.ts`, and no input under `src/regions/{pool,service,runtime,cache,snapshots}.ts`, `src/regions/worker/**`, `src/claims/foldInputs.ts` or `web-tree-sitter`, and no `node:worker_threads`; `dist/viz.js` ≤ 1.5 MB.
- `"T-VIZ-i18n: UI_VIZ_CLAIMS_PENDING"` — the code is in 12 §3.11's Page states row (moved from §9.9 in this merge), in `VIZ_CODES` and in `EN_VIZ` with the en text "Some shared changes are not on this PC yet; this room continues when they arrive."; T-VIZ-i18n deep-equals the table and `codes.ts`.
- `"T-VIZ-perf (claims)"` — Task 15's perf run with one of the 8 rooms carrying claim ops at the `claims` SIM rate: first `/api/v1/world` ≤ 6 s (2×, R-V41); RSS ≤ 200 MB.

**Crashpoints:** none. **Lint:** L-VIZ-GIT's grammar gains one form (Task 1's rule logic is unchanged).

**Notes:**
- **Privacy (binding, INV-VIZ-NOCONTENT as narrowed).** Blob `Buffer`s and line arrays exist only inside `readClaimInputs`; nothing in `src/viz/**` stores them, and `FrameInput.claimInputs` holds only oids, `'ABSENT'` and booleans. Errors on the claim path carry codes, heights and oids only (never git's stdout or stderr text); the viewer log gains no code (the badge is the visible surface). The ancestry memo is a per-room `Map` keyed by `<a>:<b>`, cleared on a rebuild (VIZ-14).
- **Why the room waits instead of folding without inputs.** Folding a claim-carrying commit without inputs skips every claim effect of that commit, so the viewer's state would differ from the daemons' from then on, and nothing would ever re-seed it; the daemons' own fold waits for the same object (Plan 4 R4-26), so the viewer waits with a visible state. R-V74 ("no hostile board stops a room") is about board commits the viewer cannot parse; a live-code object this PC has not fetched yet is not one.
- If the claims room breaks the first-world budget, the controller rules (a separate claims row in 12 §3.12) — never by caching blobs or line arrays across fold steps.
- Plan 4's follow-up 4-V (its claim rows), Plan 6's claim-derived rows and 8b Task 13's README storyboard (its h6 `claim_take`) build on this task.

---

### Follow-ups from the cross-plan reconciliation (2026-10-08)

Not 8a tasks with a group: each is a follow-up or ledger act with an owner (RECONCILIATION §3, "Plan 8a — owner: 8a controller"). F-8a-1 is Task 19; F-8a-3, F-8a-4, F-8a-5 and F-8a-12 are the amendments of Tasks 7, 6, 16 and 18; F-8a-10 is item 10 of the spec batch and Task 9's amendment. F-8a-13 (the owner's choice of 2026-10-08 on X-92) is Task 20.

- **F-8a-2 — move the shared data-directory and SDDL code (X-61, X-62).** Owner: the 8a controller, run now (verify pass V-12: one creator; Plan 5 Task 1 waits for this move and never makes it). Gate: none (Task 11 has merged); it merges before Plan 5 Task 1 starts. Create `src/data/pluginDataDir.ts` (imports only `node:*`; `pluginDataDir`, `resolveDataDir` with the landed bodies and signatures) and `src/sec/sddl.ts` (imports nothing; `Sddl`, `parseSddl`, `sddlUserOnly`, `sddlOwnerOk`, the one allowed-SID constant); `src/viz/cli/dataDir.ts` keeps `verifyDataDir`, `DataDirVerdict` and the repair path and re-exports the moved names. Tests: every existing `dataDir.test.ts` case unchanged and green; `"dataDir.ts re-exports pluginDataDir, resolveDataDir, Sddl, parseSddl, sddlUserOnly and sddlOwnerOk from src/data and src/sec unchanged"`; the T-VIZ-lints `cli.js` metafile test stays green (`cli.js` gains those two leaves and no `src/viz` module). Afterwards Plan 5 adds `pluginRoot?` and `pluginIdOf` (R5-56) to the moved module, Plan 7 deletes `resolvePluginData`, and 8b re-exports from `src/data`. **Behaviour change that follows (verify pass V-12):** with Plan 5 Task 1's `pluginIdOf`, the derived directory is `<CLAUDE_CONFIG_DIR or <home>/.claude>/plugins/data/<pluginIdOf(plugin root)>` (`<plugin>-<marketplace>`, A1-12; `null` → fail closed), no longer R-V11's fixed `plugins/data/cowork-sync`; Plan 5 Task 1 updates the landed `dataDir.test.ts` cases that expect the fixed id (8a reviewer), and `CLAUDE_PLUGIN_DATA` (the form Claude Code sets for a running plugin) is unchanged.
- **F-8a-6 — ratify the code-vs-plan drift in `contract.md`.** Owner: the 8a controller (a ledger act; no code). Record `ClaimState.at` (R-V73), `excludedRoots`'s fifth parameter (R-V68), the extra exports annotated in §Interfaces (`sddlOwnerOk`, `WINDOWS_ACL_COMMAND`, `SpawnDeps`, `spawnViewerWith`, `KillDeps`, `killTreeWith`, `OpenerSpawn`, `openUrlWith`, `withTrustCache`, `withPath`, `REAP_MS`, `SSE_RECHECK_MS`, `SseResponse`, `cappedSink`, `SSE_BUFFER_MAX`, `RING_MAX_BYTES`), `src/viz/server/clockTimer.ts`, `BatchReads<T>` (R-V69), `'unreadable'` (R-V74) and `runnerKill.test.ts` in `test/integration/viz/`. This plan's §Interfaces carries the same annotations from 2026-10-08; 8b re-baselines against them.
- **F-8a-7 — the repair allowlist admits the later per-user files.** Owner: the 8a controller; before Plan 7's first per-user file and 8b Task 2. `dataDir.ts`'s `onlyViewerFiles` also admits `notify-rate.json`, `notify-rate.lock`, `repos.json` and `user.json`, each only as a regular file (never a link or a directory); any other name still refuses the repair. Test: `"a repairable data directory holding notify-rate.json, notify-rate.lock, repos.json and user.json is repaired; one holding any other name, or one of those names as a link or a directory, is not"`. It may land with F-8a-2 (same file).
- **F-8a-8 — T-VIZ-i18n on rev 2.5.** Owner: the 8a controller. When `main` holding the rev 2.5 spec is merged forward into `feat/p8a-viz`, re-run `test/unit/viz/i18n.test.ts` (it parses 12 §3.11 and pins `SPEC_WORDING`); rev 2.5 keeps the F04-b, F29, F32 and F34 codes in §9.9, outside every table, and §9.9 stays non-parsed, so the run must stay green; a red run means a rev 2.5 edit changed a §3.11 row 8a lacks — fix the spec merge, not `codes.ts`. Record the run in the ledger.
- **F-8a-9 — F04-b (X-108).** Owner: the 8a controller, after 8a's exit (roadmap row 8); not part of 8a's exit; scope in §Out of Plan 8a; 8b's Task 6b only if F04-b is absent at gate Q.
- **F-8a-11 — inbound edits the 8a reviewer accepts.** Owner: the 8a reviewer, in each producing plan's review:

| Plan | 8a files | Edit | Ruling |
|---|---|---|---|
| F04-a (Plan 2 follow-up) | `src/viz/model/layout.ts`, `tools/lint/vizRules.ts` | `zoneOf` re-exports `zone` from `src/data/zone.ts`; the R-V35 client-program list gains `src/data/zone.ts` | X-76 |
| Plan 3 | `src/viz/i18n/{codes,en}.ts`, `src/viz/model/{timeline,start}.ts`, row fixtures and goldens, `verdicts.test.ts` | `HOLD_REVERT_HELD`; "3-V" hold rows; the `hold` verdict row | X-104, X-91, X-90 |
| Plan 4 | `src/viz/model/{timeline,start}.ts`, row fixtures and goldens, `tools/build/build.mjs`, `test/unit/viz/verdicts.test.ts` | claim rows and `startScene` claims in follow-up 4-V after Task 20 (real time, X-92 as chosen by the owner; Task 20 owns `foldFrame`'s inputs, `src/viz/source/claimInputs.ts`, the demo answers and the exporter's `claims`); R4-55/R4-68 goldens; grammars; the `claim`/`release` verdict rows in Plan 4 Task 8's commit that adds both types to `PLAN2_FOLDED_TYPES` (rows that pass claim inputs flip to `effective`/`rejected`; no-input rows stay `unfolded`, R4-26) | X-91, X-92, X-107, X-90 |
| Plan 5 | `src/viz/i18n/{codes,en}.ts`, `src/viz/model/timeline.ts`, `src/entry/cli.ts`, `src/data/pluginDataDir.ts`, `build.mjs`, `build.test.ts` | seven health codes; seat and health rows; its own dispatch lines; `pluginRoot?`, `pluginIdOf`; its build steps | X-104, X-91, X-99, X-61, X-107 |
| Plan 6 | `src/viz/model/{timeline,start}.ts`, `src/text/sanitize.ts`, `tools/viz/storyboard*`, `src/viz/demo/plan2.jsonl`, `test/unit/viz/verdicts.test.ts` | R6-63 rows and goldens; the Claude-channel placeholder functions; the `request`, `request_status`, `answer`, `note` and `presume_absent` verdict rows in Plan 6 Task 2's commit that adds the five types to `PLAN2_FOLDED_TYPES` | X-91, X-88, X-90 |
| Plan 7 | `src/viz/i18n/{en,codes}.ts`, `src/viz/cli/{strings,view}.ts`, `src/i18n/render.ts`, `src/text/sanitize.ts`, `tools/lint/{lint,allow}.ts` | shared entries from `src/i18n/generated/shared.ts`; `renderRefusal`/`NextLine`; `ParamType` `sym`/`oid`/`hostmsg`, `setMissObserver`; `CapKind` `sym`/`notif`, `pasteSafe`; `BASE_MOVE_CONFLICT`, `BRANCH_ESCAPE`; `VIZ_ALLOW` entries | X-95, X-96, X-97, X-88, X-104, X-98 |
| 8b | `tools/lint/vizRules.ts`, `src/viz/ui/a11y.ts`, the R8B-07 files | rule changes (R8B-43); `KeyAction` `'close_panel'` | X-98 |
