# 12 — Visualizer (`/cowork view`)

**Status:** normative draft, conformed to glossary REVISION 2.4 (§23, §24, §25, §26, §27; where §25/§26/§27 differ from earlier glossary sections, the newest section wins and this chapter follows it). New chapter, written 2026-10-06 from the eight user decisions of that day (§1.4) and three research inputs (data inventory, security constraints, prior art); revised the same day after three adversarial reviews (consistency, security, product) and a completeness pass (model and API types, segments and start scenes, tile coordinates, the demo-log schema, the module map, per-milestone acceptance). · **Depends on:** 00-glossary (+ 01-engine ENG-, 02-protocol PRO-, 05-holds HLD-, 06-claude CCI-, 07-coordination COO-, 08-lifecycle LIF-, 09-security SEC-/CFG-, 10-product UX-/I18N-, 11-testing TST-/REL-) and the Plan 2 contract `docs/superpowers/plans/2026-10-06-cowork-sync-p2-engine.md` (Interfaces: Board, Git layer).

**Revision 2.5 feature deltas (2026-10-08).** Four reviewed proposals of `docs/proposals/` are merged into this chapter: F04 (the viewer half of the catch-up summary, slice F04-b: the catch-up panel, Play and the last-visit flag), F32 (following a person), F34 (postcards) and F29 (the highlight reel). Every added block carries a "(rev 2.5, F##)" tag, and their requirements keep their `FEAT-F##-NN` ids (no `VIZ-` renumbering). None of them changes the protocol, the read set, a route, the stream or the timeline; F04 adds one view-model field (`RoomVM.open_h`). The §3.11 table entries they add wait in the non-parsed block §9.9 and move into the table only in the same merge as the code that defines them, because T-VIZ-i18n deep-equals that table with `src/viz/i18n/codes.ts` (the `UI_VIZ_RECORD_NOTICE` revision of F34 likewise waits there). Glossary §29 is the rev 2.5 glossary section; the pending §28 of §9.2 is relabelled so that only §29 carries that name. Where an owner decision of 2026-10-08 changes text, the text names it; the owner decided both on 2026-10-08 (glossary §29.1): D3, F32 is Plan 8a Task 19, and D4, the first public release happens only after Plan 8b, as one release that includes the viewer product, the highlight reel and postcards (Plan 8b's last task publishes it).

**Owner choice of 2026-10-08: claims in the viewer (RECONCILIATION X-92, the alternative).** The viewer's own fold reads, in memory only, the live-code tree entries and blobs that Plan 4's `claimFoldNeeds` names, so a claim op folds in the viewer exactly as it folds in the daemons and claim events between board checkpoints are drawn when they happen. INV-VIZ-NOCONTENT is narrowed, not removed: those bytes are read only to fold claim state, stay in memory for that one fold step, and are never written to disk, logged, kept for a later fold, sent to the page, rendered or counted; only claim structure (ids, holders, paths, ranges, labels, states) reaches the world model, and every drawn claim field comes from board ops. The viewer never re-seeds its fold from a checkpoint, so a checkpoint mismatch, claims included, is a defect; every board commit is folded with claim inputs (a commit without claim ops costs no read); an object the claim fold needs that is not on this PC holds the room at its last folded scene (`UI_VIZ_CLAIMS_PENDING`) instead of folding without inputs, because the viewer never fetches and the daemons' fold waits for the same object. Plan 4 Task 8 exports the pure pairing `overlapPairsOf` that the daemon and the viewer share; Plan 8a Task 20 builds the viewer's reader `readClaimInputs`. This decision edits §1.1, §1.3, §3.1, §3.3.2, §3.3.3, §3.3.4, §3.9.3, §3.11 (one pending code, §9.9), §3.12, §3.13, VIZ-06…VIZ-09, §5, §6, §7, §8 Q2, §9.5 and §9.9; where an earlier sentence of this chapter says that the viewer reads no live-code blob or tree, this paragraph wins.

This chapter defines the **viewer**: a separate, read-only process started by `/cowork view` that serves one local web page showing the team at work, live and as a replay, built only from what the board already carries. It fixes the process and its lifetime, the read set, the world model (a pure function from folded board history to a timeline of scene events), the room and desk layout, the characters and pets, animation, the conversation log, replay, demo mode and export, the local HTTP server and its security, the UI languages, accessibility and the budgets. It changes nothing the engine, protocol or coordination does. The viewer observes and never acts: every element on the page is a rendering of a folded board fact, or of this PC's own `status.json`.

---

## 1. Scope

### 1.1 v1 in scope

- The read-only verb `/cowork view` and the viewer process `dist/viz.js`: spawn, ready handshake, opening the browser, lifetime and exit (VIZ-01..VIZ-05).
- The read set: the fetched board chain of each room, the message of each live code commit a board commit names, (owner decision of 2026-10-08, real-time claims) the live-code tree entries and blobs a board commit's claim fold needs, in memory only for that fold, `status.json`, `<gitdir>/cowork/{peer,live}`, the stat of the board ref's storage, the data directory's `repos.json`, and nothing else (VIZ-06, VIZ-07).
- The world model: folding with the engine's own fold code, frames, the timeline of scene events (a closed kind set), the scene reducer, and the local overlay (VIZ-08..VIZ-15).
- The map of rooms and the zoomed office: a deterministic, append-only desk layout and the placement of characters at desks (VIZ-16, VIZ-17).
- One character per peer, one pet per seat, original "mallang" pixel art, looks derived from `peer_id` only, a colour-blind-safe palette (VIZ-18..VIZ-21).
- Animation states and timing, speech bubbles, the conversation log and its filters (VIZ-22..VIZ-25).
- (rev 2.5, F04) The catch-up panel at the top of the log: what changed since this user's last visit, with Play and a page-drawn last-visit flag on the rewind bar (§3.8, §3.9.1, FEAT-F04-13, -14); page state only, no new read.
- (rev 2.5, F32) Following a person in a room (§3.8.1): a page-only toggle that steers the office scroll and pins a now card; no new read, route, payload or scene event.
- The rewind bar (replay by height), demo mode from a demo log, export to WebM and GIF with an anonymize mode (VIZ-26..VIZ-29).
- (rev 2.5, F34) Postcards: a still 960 × 540 PNG of the recording canvas and a plain-text status, copied to the clipboard or saved, anonymized by default (§3.9.5, FEAT-F34-01..09).
- (rev 2.5, F29) The highlight reel: a one-click, chaptered, anonymized recording of a height range, planned by a pure function of its scene events (§3.9.6, FEAT-F29-01..13).
- The local HTTP server on `127.0.0.1`: tokens, request admission, response headers, a read-only JSON snapshot and an SSE stream, the view-model allowlist, text sanitizing (VIZ-30..VIZ-38).
- UI chrome in six languages, accessibility, performance budgets and visible failure states (VIZ-39..VIZ-42).
- The field-level model types (§3.3.7), the served JSON shapes (§3.10.6) and the module map with its interfaces and build (§3.13), so that the plan can be written from this chapter alone.

### 1.2 v1 refuses (user-visible message codes)

Every refusal uses the 10-product §3.4 two-line format; the next line (INV-UX-ONE-NEXT) is given in the last column.

| Situation | Code | Behaviour | Next line |
|---|---|---|---|
| The viewer cannot listen on `127.0.0.1` (or the bound address is anything else) | `RF_VIZ_BIND_FAILED` | exit 1; nothing opened | `/cowork doctor` |
| The viewer does not report ready within 5 s (15 s on Windows), or its ready line is malformed; or the data directory fails the SEC-20 owner and ACL verification | `RF_VIZ_START_FAILED` | the CLI kills the child's process tree (§3.2 item 3); exit 1 | `/cowork doctor` |
| `dist/viz.js` does not match `dist/SHA256SUMS` (Plan 8b onward, §9.1) | `SEC_REFUSE_RUNTIME_INTEGRITY` (existing code, SEC-36) | nothing is spawned; exit 1 | `/cowork doctor` |
| No room: no `repos.json` entry with a `live` marker and no `--repo` | `RF_VIZ_NO_ROOMS` | exit 1 (the refusal text mentions `--demo`, but not as a second next command) | `/cowork start` |
| `--repo <path>` is not a main worktree with a fetched board ref (no `<path>/.git` directory, a linked worktree, no `refs/cowork-remote/*/board`), or is a UNC or device path | `RF_VIZ_REPO_NOT_LIVE` | exit 1 | `/cowork start` |
| `--demo=<file>` larger than 4 MiB, not a regular file, a UNC or device path, not `cowork-viz-demo/1`, or with an invalid record | `RF_VIZ_DEMO_INVALID` | exit 1 with the first bad line number; no partial demo | (none: fix the demo file) |
| git missing or below 2.43 (glossary §18) | `START_TOOL_VERSION` (existing code) | exit 1 | `/cowork doctor` |
| Any other flag, or `--demo` together with `--repo` (§3.2 item 10) | `RF_UNKNOWN_FLAG` (10-product §1.2) | exit 1, prints the verb's flags | (as 10-product) |
| Any HTTP method other than GET/HEAD, and POST other than session redemption | (HTTP 405, no CLI code) | nothing changes; the page offers no acting control at all | — |

### 1.3 Deferred

- **Acting from the page.** Sending notes or requests, answering, resolving holds, releasing claims: never from the viewer in v1. Acting stays with Claude (MCP tools) and the `/cowork` verbs.
- **Multiplayer page features and custom art.** Shared cursors, chat, uploaded avatars, user-chosen colours or accessories (a `join.avatar` field would be a protocol change), custom office layouts and a layout editor.
- **Reading this PC's hold registry or state ref** (an own-PC conflict "!" before Plan 3, boxes for unpublished change-sets, envelopes for the outbox): §8 Q1.
- **Reading live code trees** (`diff-tree --name-status` for new and deleted desks, desks for change-sets with more than 256 paths, the K4 `TAKE_TIP` intersection of glossary §24 default 3): §8 Q2. (The claim inputs of §3.3.3 look up single named paths for the fold only; they list no tree and place no desk.)
- **Commit dates** in replay, even as display-only labels: §8 Q3.
- **WebM duration/cue patching, WebCodecs fast export, MP4 as a chosen format.**
- **Reel extras** (rev 2.5, F29): sound or music, user-written titles (free text in a recording), MP4, sharing a reel range through the URL.
- **Viewing from another device** (phone, LAN, another PC): never; the listener is loopback only.
- **REG-34 label verification inside the viewer** (needs the grammar worker): §8 Q6.

### 1.4 User decisions this chapter implements (binding, 2026-10-06)

Quoted as given (only the paths of the brainstorm mockup files are shortened). Where the text needs correcting against the binding spec, §1.5 says so; the decision text itself is not reworded.

| Id | Decision |
|---|---|
| VD-1 | "Purpose: BOTH a live team presence view that teammates keep open while working AND a recordable replay/demo for promotion (README GIF, intro video)." |
| VD-2 | "Character: an ORIGINAL cute round pixel creature ("mallang" blob) in a warm Claude-like orange spirit; per-account body colour + accessory (beanie, headphones, sunglasses, scarf, ...). NOT Anthropic's official mascot (trademark/copyright risk for a public open-source project; the project name also avoids "Claude"). Sprite maps are in `character-style.html` (option A) — reuse them as the art baseline." |
| VD-3 | "World layout: a small MAP where each repository is a ROOM (the cowork-live clones on this PC), plus the selected room ZOOMED: an office where FILES (or folders) are DESKS; characters sit at the desk of the file/region they work on; walking to another character's desk = a request. Mockup: `world-layout.html` (option 3)." |
| VD-4 | "Conversation: a RIGHT-SIDE conversation log (time-ordered cards, filter by person/file; clicking a character filters to them) + a BOTTOM REWIND BAR that replays past scenes; in-scene speech bubbles appear briefly. Mockup: `conversation-view.html` (option A)." |
| VD-5 | "Character unit: ONE character per PERSON (peer/account) + a SMALL PET per Claude session (seat) that follows them and can work at a different desk; human edits are done by the person's character." |
| VD-6 | "Architecture: a separate read-only VIEWER process started by `/cowork view` (cli.js), serving a local page on 127.0.0.1 with a random key in the URL; it reads the already-fetched local board refs of every live clone on this PC and folds them with the engine's own fold code; NO new network calls, NO web server inside the daemon, NO external server (glossary U1). Live updates every 2.5 s; replay = the board's first-parent history; demo mode = SIM op-logs." |
| VD-7 | ""Conversations" shown = only what is on the board: requests, answers, notes (<= 280 chars, secret-scanned), K-events, join/leave/seat events. Full Claude chat transcripts are NEVER on the board by design and are not shown." |
| VD-8 | "Schedule: a new roadmap row "Plan 8 — Visualizer", started right after Plan 2 lands, in its own module src/viz/**; it shows Plan 2 data first (joins, who published which paths via Cowork-CS/Cowork-CS-Paths/Cowork-Seat trailers, K4 events, freezes) and grows as Plans 4–6 add claims, requests, answers and notes." |

### 1.5 What each plan can actually show (corrections to the decision text)

1. **Teammates' K4 conflicts are not on the board in Plan 2** (VD-8 "K4 events"). Plan 2 keeps a K4 loser's record only in the loser's local registry (Plan 2 ruling R-02) and posts only `event{freeze|unfreeze}` (EPOCH), `event{health, reason_code: HOST_THROTTLED}` and `event{nonretryable}` (R-27); the `BOARD_FULL` health event of PRO-06 is not among them, so it arrives with whichever plan implements PRO-06's record withholding. The red "!" for teammates arrives with Plan 3's `hold` ops (guard `conflict`, state `CONFLICTED`). The winner of a K4 is never on the board: `displaced_by` is a hold-registry field (glossary §9) that the `hold` op does not carry (glossary §7), so no line to a winner is drawn. Before Plan 3, this PC's own held changes appear only as a count from `status.json.pending.holds_active` (local overlay).
2. **No pets before Plan 5.** In Plan 2 every `cs_id` is `<peer_id>/human/<n>`, every `Cowork-Seat` is `human`, and no `seat_start` is emitted.
3. **No `leave` before Plan 7.** A stopped Plan 2 daemon writes nothing on the board, so its character stays until it becomes a ghost (`K_evict` = 200 heights).
4. **No room discovery before Plan 7.** `repos.json` and the `live` marker are written by `/cowork start` (08-lifecycle). Until then rooms come from `--repo <path>`.
5. **No "offline" for teammates, ever.** No heartbeat op exists (PRO-38, INV-PRO-QUIET); a quiet peer and a dead peer look the same on the board, and UX-22 forbids a remote "last seen". Grey and "zzz" come only from folded facts.
6. **No clock times.** The mockup's "14:02" on cards is not shown (I18N-03, UX-22, INV-CLOCK); order is board position.
7. **K-kind events may never reach the board.** Glossary §7 lists `event.kind: K1..K7`, but 07-coordination INV-COO-CLOSED produces only `event{breach}` among them. VD-7's "K-events" are therefore drawn from hold records (guards `conflict`, `claim`, `t0`, `claim-breach`) and `event{breach}`; a folded K-kind event, if one ever exists, is drawn generically (§3.4).
8. **Demo logs are not SIM op-logs** (VD-6 "demo mode = SIM op-logs"). An op-log (11-testing §2) lists generated operations, not board commits, so it cannot be folded. The demo log (§3.9.3) is exported from a SIM run's board chain; the op-log is only an aid for writing its captions by hand.
9. **Plans 3 and 7 add to the view too** (VD-8 names Plans 4–6): Plan 3 adds hold records (parcels, K4 and K7 conflicts), Plan 7 adds `leave`, save confetti, base moves and branch-escape badges (§3.4 "What each plan adds").
10. **Publishes are activity cards, not conversations.** VD-8 lists "who published which paths" as Plan 2 data. Publishes appear in the scene and, merged per actor, as **activity** cards (§3.8), a card kind separate from VD-7's conversation cards and filterable on its own, so the conversation list of VD-7 is unchanged and the log is not empty before Plan 6.
11. **Plan 8 has two milestones, and three seams outside `src/viz/**`** (VD-8 "started right after Plan 2 lands, in its own module src/viz/**"). After Plan 2, `cli.js` is a stub, and `sanitize`, `render`, the six catalogs, the secret scanner, `SHA256SUMS` and the slash command are Plan 5 and 7 work (Plan 2 "Out of Plan 2"). Plan 8a therefore starts right after Plan 2 with the core and a terminal-only, English-only `node dist/cli.js view`; Plan 8b completes the product after Plans 5 and 7 (§9.1). Outside `src/viz/**` Plan 8 touches only: the `view` dispatch line in the `cli.js` entry; the additive board interfaces of §9.7; and, when no earlier plan has created them, first versions of the shared `src/text/sanitize.ts` and `src/i18n/render.ts` with the signatures SEC-34 and 10-product §3.2 fix, which later plans extend without changing those signatures.

---

## 2. Local definitions

Terms the glossary defines are used by reference: board, board commit, live code commit, height and board position (§3), peer, epoch, seat, agent, holder (§2), `cs_id` and CS (§3), op ids and display ids `C<cid>` / `R…` (§3 `H(x, y)`), live set, ghost, `K_evict` (§3, §20), the `Cowork-*` trailers (§5), `status.json` (§14), `L_h` (10-product §2), output modes `tty`/`slash`/`pipe` (10-product §2), `PH_*` and `SS_*` labels (10-product §3.14).

| Term | Definition | Status |
|---|---|---|
| **viewer** | The process `node <plugin root>/dist/viz.js` started by `/cowork view`. It serves one page and is never the daemon. | local |
| **page** | The single-page web app the viewer serves. | local |
| **viewer origin** | Exactly `http://127.0.0.1:<port>`, where `<port>` is the OS-chosen listening port. | local |
| **world** | Everything the page shows: the map of rooms, the office of the selected room and the conversation log, each room at its own board position. | local |
| **room** | One live clone on this PC, that is one `(gitdir, b)` (one live branch per clone, glossary §4): a `repos.json` entry with a `live` marker, or one `--repo`. Drawn as a cell on the map; zoomed, it is the **office**. | local |
| **room id** | `r` + `base32c(sha256(salt ‖ canonical root))[0:8]` with a 16-byte salt per viewer process; `base32c` is the shared upper-case Crockford encoder (glossary §3), so a room id matches `^r[0-9A-HJKMNP-TV-Z]{8}$`. Opaque, not stable across viewer runs, never a path. | local |
| **zone** | The office area for one folder: `zone(p)` of §3.5.3 (the first two path segments for a path of three or more segments, the first segment for two, `·` for a root-level file; overflow folders: the zone `…`). Made of 1–4 **zone cells**. | local |
| **desk** | What a character sits at: a **file desk** (one repo path named on the board), a **folder desk** (one overflow folder in the zone `…`), a **shelf desk** (the overflow paths of a zone), or the room's **big table** (change-sets whose paths are not on the board). Desks are numbered by a **desk ordinal** in allocation order; because the layout is append-only (§3.5.3), an ordinal never changes while the viewer runs. | local |
| **slot** | One of the 6 fixed desk positions of a zone cell. A desk owns one **chair tile** and up to four **visitor tiles** (glossary "seat" means a Claude session, so the spec never calls a chair a seat). | local |
| **character** | The sprite of one peer (`peer_id`): "one per person" in the user's words. Glossary §2 has no cross-clone person identity, so one human on two PCs or in two repositories is two characters. | local |
| **pet** | The small sprite of one **seat key** `"<peer>/<epoch>/<seat_id>"` that is live in the fold or has a board footprint (a `Cowork-Seat` value, a seat `cs_id`, a claim or request naming the seat). It follows its character and can work at another desk. Its lifetime is VIZ-21. | local |
| **actor** | The character or pet a scene event animates. | local |
| **handle** | The first 6 hex of `peer_id` (already public on the board and in commit e-mails `peer_id@cowork.invalid`). | local |
| **look** | `(hue, accessory)` of a character, derived from `peer_id` alone (§3.6). | local |
| **window** | The first-parent heights `[h0, h1]` of a room's timeline. `h0` is a checkpoint height (a multiple of 256, or 0); it moves down only by "load earlier" and `h1` moves up with live extension. The server may drop old heights from memory (§3.3.3); they stay inside the window and are re-folded on request. | local |
| **frame** | The per-board-commit input of the world model: `{height, oid, writer, cs, csPaths, code: {changed, shape, seats, base}, ops: [{line, type, op, verdict}], before, after}` (§3.3.4). | local |
| **op verdict** | The fold's verdict on one `ops.jsonl` line: `effective` (valid, and this build folds the type with an effect), `unfolded` (generic-valid, but this build folds the type as a deterministic no-op, Plan 2 ruling R-12) or `rejected` (malformed, generic- or type-invalid) (§9.7 item 1). | local |
| **scene event** | One element of the closed kind set of §3.4, at **position** `(height, sub, k)` (§3.3.5). | local |
| **timeline** | The ordered scene events of a window, plus its segments, the layout and look table they imply, and one card per carded event: the output of `buildTimeline`, extended by `extendTimeline` and `prependTimeline` (§3.3.5, types §3.3.7). | local |
| **segment** | The part of a timeline folded from one start state: the initial window is one segment, and each "load earlier" page adds one. It starts at a checkpoint height `hs` with a **start scene** (§3.3.5) and holds the events of heights `hs + 1` up to the next segment's `hs` (from height 0 when `hs = 0`). | local |
| **scene** | The reduction of a timeline up to a board position: who is where, in which pose, with which badges, chairs, boxes, open requests, and the events of the current beat (which open bubbles and one-beat effects; their fading is the page's animation, not scene state). Type in §3.3.7. | local |
| **beat** | The playback unit: the scene events of one board commit, animated together. | local |
| **card** | One entry of the right-side log (§3.8): a **conversation** card (VD-7), an **activity** card (publishes), a conflict card or a **system** card. | local |
| **local overlay** | This PC's present-only layer: the own room's light, held-change and incoming counts, and the "you" marker, from `status.json` and `<gitdir>/cowork/peer`. Never part of the timeline. | local |
| **replay** | Playing the timeline from a past height with the rewind bar. | local |
| **demo** | A world built from a demo log instead of git. | local |
| **demo log** | A JSONL file in format `cowork-viz-demo/1` (§3.9.3). | local |
| **launch token / session token** | The single-use 256-bit secret in the URL fragment, and the 256-bit secret it is exchanged for (§3.10.2). | local |
| **view model** | The allowlisted JSON the API serves; never raw ops or a raw `FoldState` (§3.10.6). | local |
| **channel `viz`** | The `sanitize`/`render` channel for viewer text (§3.11). | promote: SEC-34 channel set, 10-product §3.2 table (§9.3, §9.4) |
| **following (a person)** | (rev 2.5, F32) A page-only, per-room choice of one peer whose character and pets steer the office scroll (§3.8.1); never served, stored or logged. Not the live pill's following of the tip (§3.9.1) nor the log's following of new cards (§3.8). | local |
| **now card** | (rev 2.5, F32) The region pinned above the log while a follow is on, computed from the drawn scene (§3.8.1); not a card of §3.8's list. | local |
| **reel** | (rev 2.5, F29) A recording made by `UI_VIZ_CTRL_REEL` from a `ReelPlan` (§3.9.6). | local |
| **chapter** | (rev 2.5, F29) One selected reel moment (`reelMoments`, §3.9.6), played as an intro step and its beats. | local |
| **montage step** | (rev 2.5, F29) One reel step that stands for the routine publishes of a gap between chapters (§3.9.6). | local |

---

## 3. Design

### 3.1 Picture

```
 this PC                                                                      browser tab
 ──────────────────────────────────────────────────────────────────────────  ───────────────────────
  daemon (one per clone, unchanged)     viewer: node dist/viz.js              page (same origin only)
  fetch, fold, apply, publish           read-only, separate process
          │ writes                               │ reads: stat, runGit local class, ▲ GET /api/v1/world
          ▼                                      │ batched cat-file, short reads    │ GET /api/v1/stream (SSE)
  refs/cowork-remote/<e>/board ────────► foldCommit (engine code) ───────────┐      │ GET /api/v1/rooms/…/timeline
  live code commits (messages only) ───► frames ──► buildTimeline (pure) ────┼─► view model
  <gitdir>/cowork/status.json, peer ───► local overlay (present only) ───────┘
  <data dir>/repos.json ──────────────► rooms
  claim entries, blobs (§3.3.3) ───────► foldCommit inputs only: in memory, one fold step
                                         one listener on 127.0.0.1:<port 0>; no outbound socket; no IPC
```

```
┌ map ───┐┌───────────────── office (selected room) ─────────────────┐┌ conversation log ────┐
│▣ room 1││ [door]  home spots ·· ··  ·· ··            [big table]   ││ All · person · file  │
│□ room 2││ ┌ zone src/ ───────┐ ┌ zone test/ ──────┐ ┌ zone · ─────┐ ││ ┌ card ────────────┐ │
│□ room 3││ │ ▭ loop.ts ▭ io.ts│ │ ▭ a.test.ts      │ │ ▭ README.md │ ││ │ Theo → Mina …    │ │
│        ││ │  ☻ ∙pet          │ │                  │ │  ☻          │ ││ └──────────────────┘ │
│        ││ └──────────────────┘ └──────────────────┘ └─────────────┘ ││ ┌ card ────────────┐ │
└────────┘└──────────────────────────────────────────────────────────┘└──────────────────────┘
┌ ❚❚  ● live  ├──┼──◆──▲───────★──●───────────────────┤  0.5× 1× 2× 4× 8×   ⏺ record   A/文 ┐
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Every 2.5 s the viewer checks each room's board ref (a stat of its storage, §3.9.2) and `status.json`; when the ref moved it folds only the new first-parent commits, extends the timeline and sends the new scene events on the SSE stream; the page animates them. A new board commit that carries claim ops is folded with the claim inputs its fold needs, read for that fold step only (§3.3.3). Replay asks for timeline pages of past heights. Demo mode builds the same timeline from a file.

Principles:

1. **Observe, never act.** No ref, object, index, worktree or `<gitdir>/cowork/` write; no IPC to any daemon; no outbound connection (INV-VIZ-READONLY).
2. **Only board facts.** No state is guessed from timers or heuristics; Claude transcripts are never read (VD-7, INV-VIZ-BOARDONLY).
3. **One fold.** The viewer folds with the engine's own `foldCommit` from the same build; it never re-implements op semantics.
4. **Height is the only time axis** (glossary §7 "Ordering", INV-CLOCK).
5. **Deterministic and append-only.** The same initial window and the same ordered extensions give the same timeline and layout; looks depend on `peer_id` alone; nothing moves while the user watches (INV-VIZ-DET).
6. **Recordable by design.** Every served string passes the board-text pipeline; recordings of real rooms are anonymized by default.
7. **One new socket, nothing more.** A single loopback listener is the whole new attack surface.

### 3.2 Viewer process and lifetime

1. **Verb.** `/cowork view [--no-open] [--demo[=<file>]] [--repo <path>]… [--json]` runs `cli.js view`. The output mode follows 10-product §2. In `pipe` mode the CLI starts nothing (a script or a tool call has no screen) and prints `UI_VIZ_TERMINAL_ONLY` with the terminal command; exit 0. (Plan 8a implements `tty` mode only, without `--json`; §9.1.)
2. **Resolve, then spawn.** In its own environment the CLI resolves: the **data directory** (`CLAUDE_PLUGIN_DATA`, or the SEC-20 derived directory when the variable is absent, glossary §25 F3), with SEC-20's owner and ACL verification; **`L_h`** (§3.11); and every `--repo` and `--demo` argument to an absolute path against its own cwd, refusing a path that starts with `\\` or `//` or names a device namespace (`\\.\`, `\\?\`, `/dev/`) with `RF_VIZ_REPO_NOT_LIVE` or `RF_VIZ_DEMO_INVALID`. It computes the SHA-256 of `dist/viz.js` and, from Plan 8b, refuses `SEC_REFUSE_RUNTIME_INTEGRITY` when it differs from `dist/SHA256SUMS` (SEC-36's rule applied to the viewer; no runtime copy is made). It then runs `process.execPath <plugin root>/dist/viz.js serve --data-dir <abs> --lang <code> --sha256 <64 hex> [--repo <abs>]… [--demo[=<abs>]]` with `shell: false`, `detached: true`, `windowsHide: true`, `stdio: ['ignore', 'pipe', 'ignore']`, the 09-security §3.4 environment builder (no `CLAUDE_*` value, no `NODE_OPTIONS`, `NODE_PATH`, `GIT_DIR`, `GIT_INDEX_FILE`; `LC_ALL=C` forced) and **cwd = the data directory**. Never a repository directory: on Windows a bare executable name is resolved in the current directory first, and git discovery starts from cwd. The viewer never derives the data directory or the language from its own environment, which has neither. Before reading `repos.json` or creating `log/` it repeats the SEC-20 owner and ACL verification on `--data-dir`, and before binding it hashes its own `viz.js` and refuses `RF_VIZ_START_FAILED` when either check fails; the `--sha256` value is the start hash of the 30 s check (item 5).
3. **Ready handshake.** The viewer checks the git floor (glossary §18), discovers its rooms (§3.3.1) or parses its demo log, binds, then writes exactly one line `{"v":1,"port":<int>,"launch":"<64 lowercase hex>"}` to stdout and closes stdout. When it cannot serve, it writes `{"v":1,"refuse":"<code>"}` instead (`code` ∈ `RF_VIZ_START_FAILED`, `RF_VIZ_BIND_FAILED`, `RF_VIZ_NO_ROOMS`, `RF_VIZ_REPO_NOT_LIVE`, `RF_VIZ_DEMO_INVALID` with `"line":<n>`, `START_TOOL_VERSION`) and exits; the CLI prints that refusal in the 10-product §3.4 format. The CLI reads at most 512 bytes within 5 s (15 s on Windows), validates the line by schema, destroys its end of the pipe and calls `unref()`. Nothing about the token is written to disk. Timeout or a bad line: the CLI kills the child's process tree and refuses `RF_VIZ_START_FAILED`. The kill is `process.kill(-pid, 'SIGKILL')` on POSIX (the detached child leads its own process group) and, on Windows, `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F` by that absolute path, without a shell, with cwd = the data directory. The CLI never spawns a bare executable name.
4. **Open.** The CLI builds `http://127.0.0.1:<port>/#k=<launch>`, re-validates it against `^http://127\.0\.0\.1:[1-9][0-9]{0,4}/#k=[0-9a-f]{64}$` and runs the opener (§3.10.8). It prints `UI_VIZ_OPENED` and exits 0; the `!` line of a slash command returns at once.
5. **Lifetime.** The viewer exits, closing every socket, on the first of: the launch token unredeemed 120 s after start (`VIZ_EXIT_LAUNCH_UNUSED`); a redeemed launch token presented again (`VIZ_EXIT_LAUNCH_REUSED`, §3.10.2); no open stream and no authenticated request for 10 min (`VIZ_EXIT_IDLE`); 24 h after start (`VIZ_EXIT_LIFETIME`); the 30 s check finding `dist/viz.js` gone or with a SHA-256 other than the start hash (`VIZ_EXIT_PLUGIN_REMOVED`; this catches removal and update); `SIGTERM`, `SIGINT` or `SIGHUP` (`VIZ_EXIT_SIGNAL`). The launch-token TTL, the idle exit and the 24 h lifetime are measured as own staleness, max(Δwall, Δmono) from a local anchor (the Clock port's `ownStaleness`, INV-CLOCK), so time spent asleep counts; the poll loop and the 30 s check use Δmono. No remote clock is involved. A plugin that is disabled but still installed does not stop a running viewer, which is read-only and bounded by the idle exit and the lifetime. An open page then shows `UI_VIZ_STOPPED` ("The viewer stopped. Run /cowork view to open it again.") and clears its `sessionStorage` entry.
6. **Instances.** Every `/cowork view` starts its own process with a fresh port, fresh tokens and a fresh 8-character `instance` id. There is no lock file and no secret at rest.
7. **Writes.** The viewer's only writes are its own log files `<data dir>/log/viz-<instance>-<n>.jsonl` (user-only, §3.10.10). It writes nothing inside any gitdir or worktree.
8. **No daemon coupling.** The viewer opens no IPC connection (VD-6). It works while a daemon is down and adds no work to any daemon; its git reads run with `GIT_OPTIONAL_LOCKS=0`, take no lock and have every transport disabled, so a missing object is a read error, never a fetch (VIZ-07).
9. **Host kill.** A Claude Code host that kills its process tree on exit may kill a viewer it spawned (glossary §25 F4). The page then shows `UI_VIZ_STOPPED`; no workaround is attempted.

10. **Stopping, and flag combinations.** There is no stop verb and no stop flag: the CLI stops a viewer only inside the handshake (item 3), and a running viewer ends only by the item 5 exits (closing its last tab ends it 10 min later; `bye` reaches every open page). `--demo` together with `--repo` is `RF_UNKNOWN_FLAG` (demo and real rooms never mix). In `slash` and `pipe` modes `--no-open` starts nothing and prints `UI_VIZ_TERMINAL_ONLY` with the terminal command, because the URL can never be printed there (§3.10.9).
11. **First room.** The page opens on the room whose id the tab kept in `sessionStorage` when it is still in the world, else on the first room in server order (§3.3.1).

`--json` prints one 10-product §3.4 envelope (`code` `UI_VIZ_OPENED` or the refusal, `data: {opened, rooms}`, `rooms` being the number of rooms served), never the URL; the schema is `dist/schema/cowork-view-1.json`.

### 3.3 Data sources and the world model

#### 3.3.1 Rooms

- **Discovery.** The union of (a) `repos.json` entries whose `<gitdir>/cowork/live` marker exists (Plan 8b, once Plan 7 writes them) and (b) `--repo` arguments, already absolute and checked by the CLI (§3.2 item 2). For `--repo` the viewer reads `<path>/.git` with the Fs port: a directory gives the gitdir (realpath); a file (linked worktree, submodule) or nothing is `RF_VIZ_REPO_NOT_LIVE`. The viewer never runs git with cwd inside a worktree to discover a repository.
- **Later changes.** Every 30 s the viewer re-reads `repos.json` when its mtime changed and checks each listed `live` marker. A new live clone is appended at the end of the map (no re-sort while the viewer runs) and announced with a `room` stream event; a room whose marker or gitdir vanished greys out with `UI_VIZ_ROOM_GONE` and keeps its folded history until the viewer exits.
- **Branch.** `for-each-ref -z --format=%(refname) refs/cowork-remote/` under `--git-dir`, keeping refs ending in `/board`. One live branch per clone means one match; with more than one (a stale ref), the one whose `enc(b)` decodes to `status.json.branch` wins, else the room is `RF_VIZ_REPO_NOT_LIVE` for `--repo` and skipped (with `UI_VIZ_ROOM_AMBIGUOUS` on the map) for `repos.json`.
- **Identity and order.** Rooms are deduplicated by the canonical gitdir root form (glossary §24 default 12) and sorted at start by `(label, canonical root)` on the server; the root itself is never served. At most 32 rooms; the rest appear as "+n" (`UI_VIZ_MORE`) on the map.
- **Label.** The basename of the main-worktree realpath named by the `live` marker (for `--repo`, of the given path), sanitized, ≤ 40; and the decoded branch (≤ 80). The realpath itself is used for nothing else and never served. Never the remote URL: `repos.json.pinned_url` is read past and never used.

#### 3.3.2 Read set (exhaustive)

| Source | How | Fields used | Class |
|---|---|---|---|
| `<plugin root>/dist/viz.js` | read and hashed at start and every 30 s | SHA-256 only (VIZ-03) | local |
| `<data dir>` and `<data dir>/log/` | SEC-20 owner/ACL check at start; a listing of `log/` at start | names and mtimes of `viz-*.jsonl` (14-day cleanup, §3.10.10) | local |
| A `--demo=<file>` | `lstat`, then one read ≤ 4 MiB + 1 byte | the demo log (§3.9.3) | local |
| `<path>/.git` of a `--repo` argument | `lstat`; `realpath` when it is a directory | directory or not; the gitdir | local |
| `<data dir>/repos.json` | `stat` every 30 s; one short read ≤ 256 KiB when its mtime changed, schema-validated (CFG-06-style user-only check) | `gitdir`, `b` | local |
| `<gitdir>/cowork/live` | existence every 30 s; one short read ≤ 4 KiB | presence; the main-worktree realpath (label basename only, never served) | local |
| `<gitdir>/cowork/peer` | one short read | `peer_id` ("you") | local |
| `<gitdir>/cowork/status.json` | `stat` per tick; open, read ≤ 1 MiB, close, only when its mtime changed; never held open, never watched | `v`, `state`, `freeze_reasons`, `publish_pause`, `branch`, `peer_id`, `plugin_version`, `heartbeat_mono_ms`, `loop_period_ms`, `last_fetch_age_ms`, `pending.cs_ready`, `pending.holds_active`, `pending.incoming` | local |
| The storage of the board ref: `<gitdir>/refs/cowork-remote/<enc(b)>/board`, `<gitdir>/packed-refs`, and `<gitdir>/reftable/tables.list` when `<gitdir>/reftable/` exists | `stat` per tick (Fs port; no handle kept) | (size, mtime) of each, as the change trigger of §3.9.2 | local |
| `refs/cowork-remote/<enc(b)>/board` and its first-parent chain | `runGit` local class: `for-each-ref -z` under `refs/cowork-remote/` (room admission), `rev-parse --verify -q`, `rev-list --first-parent`, and `cat-file --batch` only through `readBoardCommits` (§9.7 item 8): one process per batch of ≤ 1,280 board commits, reading each commit object, `<oid>:ops.jsonl`, `<oid>:protocol.json`, the `<oid>:held` tree object (parsed for entry names only) and `<oid>:checkpoint/state.json` at checkpoint heights. Never one git process per commit | everything `BoardCommitData` holds (`heldIds` are names only) | board-public |
| The live code commit each board commit names (its last parent) | `cat-file --batch` of the **commit objects only**, through `readLiveCommits` (§9.7 item 3), one process per batch: parents and message, never a tree | parent count (for `liveShape`), `Cowork-Seat`, `Cowork-CS`, `Cowork-CS-Paths`, `Cowork-Base`, `Cowork-Writer` | board-public |
| (owner decision of 2026-10-08, real-time claims; Plan 4 Task 8, Plan 8a Task 20) The claim-fold inputs of a board commit that carries `claim` ops: the tree entries and blobs `claimFoldNeeds(prev, draft)` names (04-regions, 02 §3.3 inputs) | `cat-file --batch` through `readClaimInputs` (8a Task 20, `src/viz/source/claimInputs.ts`, pairing with Plan 4's `overlapPairsOf`), one process per such board commit (a blob larger than one call's budget is read alone in one more call), its stdin naming only `<commit>:<path>` for the `(commit, path)` pairs `claimFoldNeeds` lists and the `base_blob` oids of the claims those pairs are tested against; the viewer parses no tree object (git resolves the path); ≤ 32 MiB of output per call; and `merge-base --is-ancestor <anchor> <liveCode>` once per distinct tombstone anchor, so a tombstone anchor that is not an ancestor reads `ABSENT` as in the daemons' resolver | the entry's blob oid or absence, and the blob's lines, held **in memory for that one `foldCommit` call only** to answer `ClaimFoldInputs.treeEntry` and `ClaimFoldInputs.overlaps` (FoldMapper/1 in `fold` mode, the daemon's own `foldOverlap`); then dropped — never cached across commits, served, logged, written or exported; only the fold's own claim records (oids, ranges, labels) remain | live-code, memory only |

`status.json` is read with one short read because the daemon replaces it by rename on every iteration, and on Windows a rename over a file fails while any handle is open (glossary §26.1 W3). The viewer never uses `message_params`, `message_code` or `pending.not_converged` (local work-in-progress detail it has no use for); the read cap is 1 MiB because `not_converged` has no size limit and the whole file must be parsed.

**Never read:** any blob other than the three board files above and the claim-fold blobs of the last row (no other live-code blob, no `held/<hold_id>/…` blob, no save commit, no `refs/heads/*` or `refs/cowork-remote/<e>/branch` commit, whose messages carry real names, `Co-authored-by` e-mails and `Cowork-Symbol` lines); any tree other than a board commit's `held` tree (no live-code tree, §8 Q2; a claim-fold `<commit>:<path>` name is resolved by git, and the viewer receives only the blob); `refs/cowork-local/*` (§8 Q1); `refs/cowork-remote/<e>/code` (PRO-13: a lease value only); the working tree, the user's index, the private index, `<gitdir>/cowork/tmp/**` (staged plaintext copies, SEC-37), `prov/`, `cs/`, `log/`, `daemon.lock`; `ipc.key`, `runtime/` and `user.json` in the data directory (the CLI resolves the language, §3.2 item 2); any Claude Code settings file; any environment value; the team `.cowork/config.json`.

#### 3.3.3 Folding

- **Same code, same build.** Each room is folded by `foldCommit(prev, draft, self, inputs)` of the viewer's own build (`src/board/fold.ts`), called once per board commit in first-parent order, with `draft` built from `readBoardCommits` (§9.7 item 8), `inputs` the claim inputs below and `prev` seeded at `h0` as below. `Folder.foldTo` is not the viewer's entry point: it returns only the final state, while a frame needs the state before and after every commit and the per-op verdicts. The viewer never interprets an op whose verdict is not `effective`.
- **Claim inputs** (owner choice of 2026-10-08). Every board commit is folded with claim inputs, as the daemon's `Folder` folds it (02 §3.3; without inputs the fold skips every claim effect, so a commit without claim ops gets inputs too, which are never asked and cost no read). Before `foldCommit`, the viewer computes `claimFoldNeeds(prev, draft)` and resolves exactly what it names with the viewer's reader `readClaimInputs` (8a Task 20; the read-only reads of §3.3.2), which pairs the claims exactly as the daemons' resolver does (Plan 4's `overlapPairsOf`): the blob oid or absence at each named `(commit, path)`, the ancestry answer of the tombstone rule (a tombstone anchor that is not an ancestor of the commit's live code reads as absent), and the overlap answer of each named pair, computed in this process by the fold's own `foldOverlap` (FoldMapper/1, `fold` mode) over the line arrays of the pair's anchor blobs; a pair with a file-granularity claim reads no blob. The blob bytes and their line arrays exist only inside that resolution: they are dropped when the overlap answers are computed, and the inputs handed to `foldCommit` hold only oids, `ABSENT` and booleans. A demo commit takes its answers from the record's `claims` field instead (§3.9.3). No byte, line, line count, size or hash of such a blob is written to disk, logged, kept for a later fold step or a re-fold, put in a frame, a fold state, a timeline, a card, a view model, a stream payload, an export or a demo log, or rendered; ancestry answers (two oids and a boolean, no content) may be kept per room for the viewer run. Only what the fold derives reaches the world model: each claim op's verdict and the claims' records, whose drawn fields (id, holder, path, ranges, label, state) all come from board ops. A re-fold (retention, "load earlier", a rebuild) resolves its inputs again.
- **Missing claim inputs** (owner choice of 2026-10-08). The viewer never fetches (VIZ-07). When an object the resolution needs is not in the local object store (a partial clone, or an object this PC's daemon has not fetched yet; the daemon's own fold waits for the same object), the viewer folds nothing at or after that board commit: the room keeps its last folded scene and its window's `h1`, shows `UI_VIZ_CLAIMS_PENDING` "Some shared changes are not on this PC yet; this room continues when they arrive.", and retries that commit when the board ref's storage changes (§3.9.2) or, failing that, once every 30 s with one `cat-file --batch-check` of the missing object. Any other failure of a claim-input read is handled the same way. The viewer never folds that commit, or a later one, without its inputs and never guesses an answer. A timeline-page or "load earlier" request whose fold meets a missing object is answered 404 `{"code":"UI_VIZ_CLAIMS_PENDING"}`, never with a partial page.
- **Inputs, precisely.** The three inputs of the world model are the folded board states along the first-parent chain, the trailers of the live commits those board commits name, and this PC's local status. Only the first two feed the timeline; local status feeds the present-only local overlay (§3.3.6, VIZ-13), because INV-VIZ-DET must hold on every PC.
- **Window start.** For a board tip at height `t`: `h0 = 256 · ⌊max(0, t − 1,023) / 256⌋`. When `h0 = 0` the start state is `initialFoldState(protocol of B0)` and the frames run from height 0, so the room's opening is part of the timeline. Otherwise the start state is `parseFold(checkpoint/state.json at h0)`, trusted as a joiner trusts it (glossary §24 default 9), and the frames run from `h0 + 1`. The initial window therefore holds between 1,024 and 1,279 heights, or the whole board when it is shorter.
- **Retention.** Live extension appends to the window for as long as the viewer runs (up to 24 h). The server keeps at most the newest 2,048 heights of each room's timeline in memory; older heights stay inside the window `[h0, h1]` (the rewind axis does not shrink) and are re-folded on request from the checkpoint at or below them (§3.10.5). For that, the server keeps at every checkpoint height the fold state, the timeline builder's carry state (each actor's last publish height, open badges, the board-full level) and the scene reduced to the last position of that height, so a re-folded range reproduces exactly the events first served for it and a timeline page can start from a kept scene. The rewind-bar ticks (§3.10.6 `Tick`) of the whole window stay in memory. The layout is not affected (§3.5.3).
- **Self.** `foldCommit(prev, draft, self)` is called with the room's own `peer_id` when `<gitdir>/cowork/peer` exists, else 32 zeros. Only `state` is used, never `ownRejections`, so the timeline does not depend on `self` (tested, §7).
- **Per-op verdicts.** The world model needs, for every `ops.jsonl` line, the fold's verdict (§2 "op verdict"): `effective`, `unfolded` or `rejected`. `unfolded` matters because Plan 2 folds `claim`, `release`, `request`, `request_status`, `answer`, `note`, `presume_absent` and `hold` as deterministic no-ops after generic validity (ruling R-12, `PLAN2_FOLDED_TYPES`), and each later plan adds effects for some of them; an op of such a type written by a newer teammate build must not produce `claim_take`, `request_open` or a note from its raw fields while the fold state stays empty. Plan 2's `FoldStepResult` reports only own rejections; this chapter asks for an additive `opVerdicts` (§9.7 item 1). A Plan 8 build without it does not ship.
- **Checkpoints.** Every checkpoint height inside the window is compared byte for byte with the viewer's own fold (the PRO-28 comparison). Because the viewer folds claims with the daemons' inputs, its fold equals every honest checkpoint, claims included, so a mismatch is a defect, never an expected state. It is display-only: the room shows `UI_VIZ_CHECKPOINT_MISMATCH` and the viewer keeps folding its own state. The viewer never re-seeds its fold from a checkpoint inside the window and never exempts a member, claims included, from the comparison (only the window start and a re-fold start from a checkpoint, as above).
- **Version coupling.** The viewer and this PC's daemons normally come from the same `dist/`. When a room's `status.json.plugin_version` differs from the viewer's version, the room shows `UI_VIZ_VERSION_SKEW`. An op whose verdict is `unfolded` or `rejected` (a type the fold does not know, folds as a no-op in this build, or rejects) makes no scene event; the frame counts it as `unknown`. A board whose `protocol.json.proto ≠ 1` (the fold's `protoMismatch`) shows `UI_VIZ_NEWER_PROTOCOL`; the viewer keeps folding by the fold's own rules, so newer ops render as nothing, never as wrong state.

#### 3.3.4 Frames

For each board commit in the window the server builds one frame:

```ts
// src/viz/model/frame.ts
export interface Frame {
  height: number;
  oid: string;                                       // transient: never in a timeline, seed, card or response (demo: synthesized, §3.9.3)
  writer: { peer: string; epoch: string; seq: number } | null;   // BoardCommitData.writer
  cs: CsTrailer[];                                   // board commit Cowork-CS trailers, in trailer order
  csPaths: ReadonlyMap<string, readonly string[]>;   // decoded Cowork-CS-Paths (≤ 256 paths each)
  code: {
    changed: boolean;                                // liveCode ≠ the previous board commit's liveCode; false at height 0
    shape: 'genesis' | 'ordinary' | 'base_move' | null;   // Plan 2 liveShape(live commit, previous liveCode); null = malformed; read only when changed (or at height 0)
    seats: string[];                                 // Cowork-Seat values
    base: string | null;                             // Cowork-Base
  };
  ops: Array<{ line: number; type: string; op: Json | null; verdict: 'effective' | 'unfolded' | 'rejected' }>;   // every ops.jsonl line
  before: FoldState; after: FoldState;               // transient: only checkpoint-height states are retained
}
```

Frames are streamed into the timeline builder; after a frame is consumed only the fold states at checkpoint heights stay in memory (for seeking, §3.9.1). A frame never holds a claim input: no tree entry, blob, line array or overlap answer (§3.3.3).

#### 3.3.5 `buildTimeline`: the pure world model

```ts
// src/viz/model/timeline.ts — pure: no I/O, no clock, no randomness, no Node or DOM import
export interface WindowInput { h0: number; start: FoldState; frames: Iterable<Frame>; }
export interface Timeline {
  h0: number; h1: number;
  segments: Array<{ hs: number; start: Scene }>;   // ascending hs; the initial window is one segment, each earlier page prepends one
  events: SceneEvent[];          // ordered by position (height, sub, k); types §3.3.7
  layout: Layout;                // §3.5, a function of the same input
  looks: LookTable;              // §3.6, a function of the peer ids alone
  cards: Card[];                 // §3.8: one per carded event, never merged or edited (merging is a log-panel render rule)
}
export function buildTimeline(w: WindowInput): Timeline;
/** Live mode. Append-only: extendTimeline(buildTimeline(w[0..k]), frames k+1..n) deep-equals buildTimeline(w[0..n]). */
export function extendTimeline(t: Timeline, frames: Iterable<Frame>): Timeline;
/** "Load earlier": prepends a segment with the events of an earlier page and appends the desks it first touches (§3.5.3). */
export function prependTimeline(t: Timeline, earlier: WindowInput): Timeline;
/** The start scene of a segment (below); in src/viz/model/start.ts, server only (§3.13). */
export function startScene(s: FoldState, hs: number, layout: Layout): Scene;
/** In src/viz/model/scene.ts, shared with the page (§3.13). The scene at a board position: the start scene of the segment with the greatest hs < at.height (the first segment when
 *  none), then every event of that segment at a position ≤ at, in order. */
export function reduceScene(t: Timeline, at: { height: number; sub: number; k: number }): Scene;
```

**Start scene.** `startScene(S, hs, layout)` for a segment that starts at `hs` from fold state `S` (`initialFoldState` when `hs = 0`, which gives an empty scene; the checkpoint state otherwise) holds: one character per peer whose `PeerRec.status` is `active` or `absent`, ghost when it is in `liveSet(S)` and not in `rankedSet(S)`, absent when its status is `absent`, frozen when its newest `freeze`/`unfreeze` event in `S.events` is a `freeze` (with that `reason_code`), slowed until `h + 180` when `S.events` holds a `HOST_THROTTLED` health event of that peer at a height `h` with `h + 180 > hs`, with the rules badge when `regionSpec ≠ S.teamRegionSpec` and the credit badge when `coauthor_optin ≠ false`; one pet per seat key whose status in `S.seats` is `live` and whose owner is drawn, seat variants in sorted seat-key order; the claims, open requests, non-terminal hold records and their persistent "!" that `S.claims`, `S.requests` and `S.holds` hold (empty in Plan 2; each plan that adds those fold effects adds their reading here); the board-full level from `S.record_count` alone; every actor placed by §3.5.4 with no publish history (characters at their home spots unless supervising, pets by their claims and requests, else behind their character); an empty beat. `startScene` reads only the layout entries that §3.5.3 first-touch step 1 and the start state's peers create, and `Scene.desks` is sparse (§3.3.7), so a segment's start scene is the same whatever desks later extensions append, and `extendTimeline` keeps the deep equality of VIZ-10 for `segments` too. The timeline builder's carry state starts empty at every segment start: no actor has a last publish height, so `pose_relaxed` first fires 64 heights after the actor's first publish inside the segment. Because a segment's scenes depend only on its own start and events, "load earlier" never changes the scene at a position of a later segment, and replay equals live there (VIZ-26).

**Position.** Every scene event has the position `(height, sub, k)`, unique within a room and ordered lexicographically:

| `sub` | Events | `k` |
|---|---|---|
| 0 | room events at height 0 (`room_open`) | 0 |
| 1 + line index (1–1,000) | the events of that `ops.jsonl` line (step 1) | the event's index in the order its §3.4 row lists events; events of one kind for several seats or claims follow ascending seat key, then claim id |
| 1,001 | code events (step 2) | `Cowork-CS` trailer index; the big-table publish or the branch sign comes after every trailer |
| 1,002 | derived events (step 3) | room-level events first, then per actor in (`peer_id`, seat key) order, the character before its pets, and per actor in the order ghost, unghost, relaxed |

Per frame, in this order:

1. **Op events.** For each op whose verdict is `effective`, in line order, the events of §3.4 for its type, using `before` and `after` for derived facts (a `join` of a new epoch retires seats and claims; a `presume_absent` makes claims STALE; and so on). An `unfolded` or `rejected` op makes none.
2. **Code events.** At height 0 the live commit is the genesis `L0`: the frame makes `room_open` (sub 0) and no other code event, because the `Cowork-Base` of `L0` is the initial base, not a move. At a later height, a frame whose `code.changed` is false (a board-only publish names the previous live commit again) makes no code event, and a frame whose `code.changed` is true makes, by `code.shape`: `ordinary` — one `publish` per `Cowork-CS` trailer in trailer order (§3.5.4) and, when the frame carries no `Cowork-CS` trailer at all, one `publish` by the writer's character at the big table; `base_move` — `room_sign{branch_moved}`, unless the frame has an effective `save` op (then the live commit is the save completion `Ls`, glossary §12, and the `save` event of step 1 is its only image); `genesis` or `null` (malformed) — nothing, counted in `unknown`. A base-move commit is the only code commit of its window and carries no `Cowork-CS` trailer (01-engine §3.6), so it never makes a `publish`.
3. **Derived events.** Transitions that no op names: `person_ghost` for a peer that is in `liveSet(after)` and in `rankedSet(before)` but not in `rankedSet(after)`, and `person_unghost` for a peer in `rankedSet(after)` that was in `liveSet(before)` but not in `rankedSet(before)` (Plan 2 fold helpers: the ghost rule is the fold's own, never re-derived here); `pose_relaxed` when 64 heights have passed since the actor's last publish; `room_badge{level}` when the board-full level of §3.4 changes through `after.record_count` (a `BOARD_FULL` event changes it in step 1). A slowed badge has no end event: the reducer ends it at its `until` height.

**Seed.** Every event carries `seed = uint32(sha256(utf8(base ‖ ":" ‖ k))[0..3])`, where `base` is the op id for op events and `"<height>:<writer peer_id or '-'>:<sub>"` otherwise. No oid enters a seed or the serialized timeline, so a timeline read from git and one read from a demo log exported from the same board are byte-identical (§3.9.3). Every cosmetic choice (bob phase, idle wander tile, confetti pattern) draws from a generator seeded with it, so replays, recordings and tests see the same choices.

**Serialization.** A serialized timeline (the golden files, T-VIZ-append-only, INV-VIZ-DET) is `canonicalJson` of the `Timeline` with every `Map` written as an array of `[key, value]` pairs in ascending key order (UTF-16 code units, as RFC 8785 orders keys), the same rule the view-model projection uses (§3.10.6); `Layout.deskOf` is included.

#### 3.3.6 Local overlay

`overlay(room)` is computed from `status.json`, `<gitdir>/cowork/peer` and the viewer's own version, and holds: the own room's light (table in §3.4); `down` when the last **parsed** `heartbeat_mono_ms` is older than 3 × `loop_period_ms` measured with the machine-wide monotonic clock (`machineMonoMs()`, Plan 2 R-35), or when `status.json` is missing while `live` exists; `unreadable` when `status.json` exists but is over 1 MiB or fails to parse — the previous values stay, the lamp shows `UI_VIZ_STATUS_UNREADABLE`, and an unreadable file never makes `down`; the offline age `last_fetch_age_ms + (machineMonoMs() − heartbeat_mono_ms)` (`UI_VIZ_LAST_FETCH`, a same-machine monotonic sum, so it is right even for a room that was offline before the viewer started); the counts `pending.holds_active` (parcels), `pending.incoming` (delivery cart) and `pending.cs_ready` (packed boxes at the door); and the "you" marker on the character whose `peer_id` equals the `peer` file. The overlay describes the present only: in replay it stays in the room header and is never drawn on a past scene, never recorded, never part of the timeline.

#### 3.3.7 Model types

The world model's types, field by field. Actors are referred to by board-public ids (`peer_id`, seat key), never by handle or oid; handles appear only in the view model (§3.10.6). Every field comes from the §3.4 row of its kind; nothing here is a new board fact.

```ts
// src/viz/model/events.ts — the closed set of §3.4
export type PeerRef = string;                          // peer_id (32 lowercase hex)
export type SeatRef = string;                          // seat key "<peer>/<epoch>/<seat_id>"
export type ActorRef = { peer: PeerRef } | { seat: SeatRef };
export type DeskRef = number;                          // desk ordinal (§3.5.3); 0 = the big table
export interface Position { height: number; sub: number; k: number; }
export type Line = { actor: ActorRef } | { claimId: string };   // the target of a conflict's dotted or dashed line
export type SceneEvent = Position & { seed: number } & (
  | { kind: 'room_open' }
  | { kind: 'room_sign'; sign: 'branch_moved' }
  | { kind: 'room_badge'; level: 'none' | 'near_full' | 'full' }
  | { kind: 'person_enter' | 'person_respawn' | 'person_exit' | 'person_thaw' | 'person_absent' | 'person_ghost' | 'person_unghost'; peer: PeerRef }
  | { kind: 'person_freeze'; peer: PeerRef; reasonCode: string }
  | { kind: 'person_slowed'; peer: PeerRef; until: number }
  | { kind: 'person_bang'; peer: PeerRef; bang: 'host' }
  // version: one pop; rules, credit: on/off with the PeerRec; health: one pop for a character, an SS_* label kept on a pet
  // until that seat's next health event or pet_poof (event-sourced badges never persist, §3.7 exclaim rule)
  | { kind: 'person_badge'; actor: ActorRef; badge: 'version' | 'rules' | 'credit' | 'health'; on: boolean; code: string | null }
  | { kind: 'pet_spawn' | 'pet_poof'; seat: SeatRef }
  | { kind: 'pose_relaxed'; actor: ActorRef }
  | { kind: 'publish'; actor: ActorRef; target: DeskRef; others: DeskRef[]; paths: string[]; n: number;   // paths: [] at the big table; n = the trailer's paths count; no cs_id (it embeds a peer_id)
      state: 'closed' | 'checkpoint'; checks: 'pass' | 'fail' | 'skipped'; origin: 'prompt' | 'wake' | 'human' }
  | { kind: 'conflict'; conflict: 'k4' | 'claim' | 'k7' | 'breach' | 'generic'; source: 'hold' | 'event';
      on: ActorRef; desk: DeskRef | null; holdId: string | null; cid: string | null; eventKind: string | null; line: Line | null }
  | { kind: 'box'; holdId: string; owner: ActorRef; holdKind: string; residence: string; state: string; offer: string;
      desk: DeskRef; localOnly: boolean; terminal: boolean }
  | { kind: 'claim_take' | 'claim_move'; claimId: string; seat: SeatRef; desk: DeskRef; order: number;      // order = ranges[0][0]
      label: { simple: string; qualname: string } | null; granularity: 'symbol' | 'block' | 'file'; lines: [number, number] | null; otherRules: boolean }
  | { kind: 'claim_stale'; claimId: string }
  | { kind: 'claim_release'; claimId: string; reason: 'explicit' | 'answer' | 'save' | 'seat_end' | 'stop' | 'reservation_transfer' | 'superseded' }
  | { kind: 'claim_reserve'; claimId: string; request: string; requester: ActorRef }                     // request = display id R…
  | { kind: 'grant_start' | 'grant_end'; claimId: string; grantee: ActorRef }
  | { kind: 'request_open'; request: string; from: ActorRef; holder: ActorRef; desk: DeskRef; requestKind: 'handoff' | 'go_first';
      estMinutes: number | null; attempt: number; note: string | null }
  | { kind: 'request_status'; request: string; holder: ActorRef;
      status: 'asked' | 'queued_until_turn_end' | 'awaiting_human' | 'undeliverable' | 'returned' }
  | { kind: 'answer'; request: string; holder: ActorRef; verb: 'accept' | 'grant' | 'decline' | 'later' | 'release'; by: 'claude' | 'human' | 'daemon'; note: string | null }
  | { kind: 'note'; actor: ActorRef; target: { request: string } | { claimId: string } | null; text: string }   // request: display id R…
  | { kind: 'save'; peer: PeerRef; desks: DeskRef[] }                          // desks published since the previous save
);

// src/viz/model/scene.ts
export type Place =
  | { at: 'home'; spot: number }                       // 0–15; ≥ 16 = the door cluster (§3.5.2)
  | { at: 'chair' | 'stool' | 'beside'; desk: DeskRef }   // beside = supervising (§3.5.4 character rule 3)
  | { at: 'visitor'; desk: DeskRef; tile: number }     // 0–3; ≥ 4 = counted in the desk's "+n"
  | { at: 'facing'; actor: ActorRef; desk: DeskRef }   // an open request: standing at the holder's chair
  | { at: 'behind'; peer: PeerRef };                   // a pet one tile behind its character
export interface ActorState { place: Place; pose: 'idle' | 'sit' | 'relaxed'; lastPublish: number | null; }
export interface Scene {
  at: Position;
  badge: 'none' | 'near_full' | 'full';
  branchMovedAt: number | null;                        // height of the last room_sign; the sign shows while at.height − branchMovedAt < 64
  characters: Map<PeerRef, ActorState & { ghost: boolean; absent: boolean; frozen: string | null; slowedUntil: number | null; rules: boolean; credit: boolean }>;
  pets: Map<SeatRef, ActorState & { owner: PeerRef; variant: number; live: boolean; ssCode: string | null }>;
  desks: Map<DeskRef, { lastEvent: number | null; chair: ActorRef | null; visitors: ActorRef[]; more: number; claims: string[] }>;   // sparse: an entry exists only
                                                       // once a desk has an event, a chair, a visitor or a claim; no entry = all defaults
  claims: Map<string, { seat: SeatRef; desk: DeskRef; order: number; label: { simple: string; qualname: string } | null;
                        granularity: 'symbol' | 'block' | 'file'; lines: [number, number] | null; stale: boolean;
                        reservedFor: string | null; grantee: ActorRef | null; otherRules: boolean }>;
  requests: Map<string, { from: ActorRef; holder: ActorRef; desk: DeskRef; status: string | null }>;   // open requests by display id
  boxes: Map<string, { owner: ActorRef; desk: DeskRef; holdKind: string; residence: string; state: string; localOnly: boolean }>;   // non-terminal records
  bangs: Map<string, { on: ActorRef; desk: DeskRef | null }>;   // persistent "!" of non-terminal conflict records, by hold id
  beat: SceneEvent[];                                  // the events of at.height up to at: bubbles, sparkles, planes, one-beat "!"
}

// src/viz/model/layout.ts (§3.5)
export interface Zone { index: number; key: string; cells: number[]; }   // key: zone(p), '…' for overflow; cells: grid cell indices
export interface Desk { ordinal: number; key: string; kind: 'big_table' | 'file' | 'folder' | 'shelf';
                        zone: number | null; cell: number | null; slot: number | null; path: string | null; lockbox: boolean; }
export interface Layout { version: number; zones: Zone[]; desks: Desk[]; homeOrder: PeerRef[];   // version: +1 per desk or grid cell added
                          deskOf: ReadonlyMap<string, DeskRef>; }   // every desk-eligible path → its desk (server and model only)
// src/viz/model/looks.ts (§3.6)
export type LookTable = ReadonlyMap<PeerRef, { hue: number; accessory: number }>;
// src/viz/model/cards.ts (§3.8)
export interface Card {
  id: string;                                          // "<height>.<sub>.<k>" of its source event
  at: Position;
  group: 'conversation' | 'activity' | 'conflict' | 'system';
  code: string;                                        // the UI_VIZ_CARD_* code of its §3.4 row
  actor: ActorRef | null; target: ActorRef | null;
  paths: string[]; n: number; desks: DeskRef[];
  displayId: string | null;                            // R…, C<cid>, or a hold id's first 8 characters
  parent: string | null;                               // an answer's request display id
  label: string | null; text: string | null;           // text: teammate free text only (note, request or answer note)
  detail: string | null;                               // a reason, status or verb code, shown only in the detail tooltip
}
```

`Card` templates take only the placeholders `{name}` (the actor's name tag), `{target}` (the target's name tag), `{n}`, `{path}` (the first file chip), `{id}` (the display id) and `{label}`; the page resolves them from the card and the character table, so anonymize changes no served data. Status chips on a request card and the nesting of answers under their request are joins the page makes from the events and cards it holds (a `request_status` or `answer` event names its request's display id); a served card is never edited, so the timeline stays append-only.

### 3.4 Mapping: board fact → scene event → visual, by plan

The scene event kinds below are a **closed set**. A new kind needs a change to this table. "Card" names the log card (§3.8); "system" cards are hidden unless the system filter is on; "activity" cards have their own filter. "Plan" is the roadmap plan that first puts the fact on a real board (fold effects that exist earlier are noted). Every icon is an 8 × 8 sprite with a text label for screen readers (§3.8), never an emoji.

| Board fact (exact fields) | Plan | Scene event | Visual | Card |
|---|---|---|---|---|
| Height 0: genesis `B0` (its `caps` op) with the genesis live commit `L0`, whose `Cowork-Base` is the initial base and makes no other event | 2 | `room_open` | the room's lights come on, the door opens | system `UI_VIZ_CARD_ROOM_OPEN` |
| `join` of a peer with no `PeerRec` before | 2 | `person_enter` | the character walks in through the door with a sparkle and goes to its home spot | `UI_VIZ_CARD_JOIN` |
| `join` of a new epoch of a known peer (old epoch retired) | 2 | `person_respawn`, plus `pet_poof` per retired seat and `claim_release{superseded}` per retired claim (Plan 4) | puff, then re-entry at the door | `UI_VIZ_CARD_REJOIN` |
| `join` re-announce of the same epoch with another `plugin_version` | 2 | `person_badge{version}` | small "v" badge (`UI_VIZ_BADGE_VERSION`) pops once | system `UI_VIZ_CARD_VERSION` |
| `PeerRec.regionSpec ≠ teamRegionSpec` after a `join` | 2 | `person_badge{rules}` | badge `UI_VIZ_BADGE_RULES` "different rules" while it holds | system `UI_VIZ_CARD_RULES` |
| `join.coauthor_optin ≠ false` | 2 | `person_badge{credit}` | small credit badge (`UI_VIZ_BADGE_CREDIT`); the name and e-mail in the field are never served | — |
| `leave` | 7 | `person_exit`, `pet_poof` per seat, `claim_release{stop}` per claim | waves, walks out the door; its chairs free | `UI_VIZ_CARD_LEAVE` |
| `seat_start` | 2 fold / 5 emit | `pet_spawn` | the pet pops in beside its character | `UI_VIZ_CARD_SEAT_START` |
| First footprint of a seat key with no folded `seat_start` (a `Cowork-Seat` value, a seat `cs_id`, `claim.holder.seat`, `request.from.seat`) | 5 | `pet_spawn` | as above | — |
| `seat_end` | 2 fold / 5 emit | `pet_poof` | puff | `UI_VIZ_CARD_SEAT_END` |
| One `Cowork-CS` trailer of a changed, ordinary live commit (actor by the `cs_id` grammar, §3.5.4) | 2 human / 5 seat | `publish{actor, target, others, state, checks, origin}` | the actor walks to the target desk and sits; sparkle on it; paper planes to the change-set's other desks; `state=closed` → big sparkle and a "done" flag, `checkpoint` → small sparkle; `checks=pass` → green tick; `origin=wake` → alarm-clock icon (`UI_VIZ_ICON_WAKE`) on the pet | activity `UI_VIZ_CARD_PUBLISH` (merged per actor, §3.8) and a rewind-bar tick |
| A `Cowork-CS` whose paths are not on the board (no `Cowork-CS-Paths`: more than 256 paths) | 2 | `publish` to the big table | as above, at the big table labelled `UI_VIZ_BIG_TABLE` "{n} files" | as above |
| A changed, ordinary live commit with no `Cowork-CS` trailer | 2 | `publish` by the writer's character to the big table | as above | as above |
| A changed, base-move live commit (`code.shape = base_move`, `Cowork-Base: <X>`) whose board commit has no effective `save` op (with one, it is the save completion `Ls`: only the `save` row applies) | 7 | `room_sign{branch_moved}` | sign at the door `UI_VIZ_SIGN_BASE_MOVE` "following the saved branch" for 64 heights | system `UI_VIZ_CARD_BASE_MOVE` |
| `event{kind: freeze}` (its writer) | 2 | `person_freeze{reason_code}` | ice block or "paused" sign with the `PH_FROZEN` / `PH_PAUSED` / `PH_NOT_COORDINATED` label (10-product §3.14) | system `UI_VIZ_CARD_FREEZE` |
| `event{kind: unfreeze}` | 2 | `person_thaw` | thaw | system `UI_VIZ_CARD_THAW` |
| `event{kind: health, reason_code: HOST_THROTTLED}` | 2 | `person_slowed{until: height + 180}` | snail badge (`PH_SLOWED`) until the scene position reaches `until` (the PRO-55 restart window; the reducer ends it, no event) | system `UI_VIZ_CARD_SLOWED` |
| The board-full level, from `after.record_count` and `event{kind: health, reason_code: BOARD_FULL}` (PRO-06): `full` from that event or from `record_count ≥ 5,000` until a frame with `record_count < 5,000`; otherwise `near_full` at `record_count ≥ 4,000` (80 % of the cap, the doctor's `DR_BOARD_SIZE` warning); otherwise `none` | 2 (count) / PRO-06 (event) | `room_badge{level}` when the level changes | `full`: filing-cabinet badge `UI_VIZ_BOARD_FULL`; `near_full`: its thin outline, `UI_VIZ_BOARD_NEAR_FULL`; `none`: no badge | system `UI_VIZ_CARD_BOARD_FULL` on entering `full` |
| `event{kind: health}` with any other code (e.g. `HOLD_REVERT_HELD` (3), seat wiring codes (5), `BRANCH_ESCAPE` (7)) | 3–7 | `person_badge{code}`; seat wiring codes → the pet's `SS_*` label | yellow badge `UI_VIZ_BADGE_HEALTH` popping for one beat (the code only in the detail tooltip), or the pet label, kept until that seat's next health event or `pet_poof` | system `UI_VIZ_CARD_HEALTH` |
| `event{kind: nonretryable}` (posted only after the pause lifted, Plan 2 R-27) | 2 | `person_bang{host}` | a one-beat orange "!" exclaim and no persistent badge; label `UI_VIZ_HOST_REFUSED` "the host refused pushes from this PC for a while; sharing has resumed" | system `UI_VIZ_CARD_NONRETRYABLE` |
| `hold` op creating a record with guard `conflict`, state `CONFLICTED` (K4) | 3 | `conflict{k4, owner}` + `box` | red "!" on the record owner's actor (its pet when `origin` names a seat of the owner, else its character) at the desk of the record's first path, persistent until the record is terminal; no line to a winner (the winning op is not on the board, §1.5 item 1) | `UI_VIZ_CARD_K4` |
| `hold` op creating a PIN with guard `claim` or `claim:<claim_id>` (K2, K3 or K6; `origin = human` → K6, otherwise K2 or K3, which the board does not distinguish) | 4 | `conflict{claim}` + `box` | parcel at the causer's desk; dotted line to the chair of the claim the guard argument names, else of a HELD claim on the same path, if any | `UI_VIZ_CARD_CONFLICT` |
| `hold` op creating a record with guard `t0` (K7) | 3–4 | `conflict{k7}` + `box` | parcel with the tag `UI_VIZ_TAG_CHECKS` "waiting for checks" | `UI_VIZ_CARD_CONFLICT` |
| `hold` op creating a record with guard `claim-breach` (a K5 breach whose apply conflicted with the holder's unshared lines) | 4–6 | `conflict{breach}` + `box` | red "!" on the holder's chair, persistent until the record is terminal; parcel at the desk | `UI_VIZ_CARD_BREACH` |
| Any other `hold` op (including `dependency:<id>` bundling and every later transition of a record) | 3 | `box{kind, residence, state, offer}` | parcel visuals: `ON_DISK` box on the owner's desk; `OFF_DISK`/`PARKED` on a shelf; `INCOMING` delivery cart; `local_only` stub: lockbox at the big table, or on a desk that already exists for its path from another source (a stub creates no desk, §3.5.3); `SUBSUMED` dissolves; `RESOLVED_PUBLISH` unpacks with a sparkle; `RESOLVED_DISCARD`/`GONE` goes to the bin | — |
| `event{kind: breach}` | 4 detect / 6 event | `conflict{breach}` | one-beat red "!" on the holder's chair; dashed line to the breaching writer | `UI_VIZ_CARD_BREACH` |
| `event{kind: K1..K7}`, if ever folded | — | `conflict{kind}` (generic) | one-beat red "!" on the writer; `C<cid>` on the card | `UI_VIZ_CARD_CONFLICT` |
| `claim` (new `claim_id`) | 4 | `claim_take` | the holder's pet sits at a chair of the claim's desk with a chair tag (§3.5.4) | — |
| `claim` re-anchor (same `claim_id`) | 4 | `claim_move` | the chair moves to its new range order | — |
| A claim becomes `STALE` | 6 | `claim_stale` | ghost chair (translucent pet) | — |
| `release`, or a fold-derived release | 4 | `claim_release{reason}` | the pet stands up and moves on; `reason=answer` → handover bubble | — |
| `reserved_for_req` set | 6 | `claim_reserve` | chair tag `UI_VIZ_TAG_RESERVED` "reserved for R…" in the requester's colour | — |
| A grant starts / ends | 6 | `grant_start` / `grant_end` | the grantee's pet sits on a stool beside the chair; the holder's pet shows `UI_VIZ_GRANT_PAUSE` "paused for {name}'s change" | — |
| `request` | 6 | `request_open` | the requester (its pet; its character when `origin=human`) walks to the holder's chair and stands facing it; `go_first` → bubble `UI_VIZ_BUBBLE_GO_FIRST` "go first? ~{est_minutes} min"; `handoff` → carries a parcel; `attempt > 1` → chip `UI_VIZ_CHIP_ASKED_AGAIN` "asked again" | `UI_VIZ_CARD_REQUEST` |
| `request_status` | 6 | `request_status` | icon bubble over the holder: `queued_until_turn_end` hourglass (`UI_VIZ_ICON_QUEUED`), `asked` question mark (`UI_VIZ_ICON_ASKED`), `awaiting_human` raised hand (`UI_VIZ_ICON_AWAITING_HUMAN`), `undeliverable` empty mailbox (`UI_VIZ_ICON_UNDELIVERABLE`); `returned` → the requester walks back (with the parcel) | chip on the request card |
| `answer` | 6 | `answer{verb, by}` | `accept`/`grant` thumbs-up (`UI_VIZ_ICON_ACCEPTED`) and a handshake; `decline` head shake (`UI_VIZ_ICON_DECLINED`), the requester walks back; `later` clock (`UI_VIZ_ICON_LATER`); `release` the holder hands over the chair; `by=human` → the holder's character speaks; `by=daemon` → gear icon (`UI_VIZ_ICON_DAEMON`) instead of speech | `UI_VIZ_CARD_ANSWER` (linked under its request) |
| `note` | 6 | `note` | bubble over the writer's pet when the target names one of its records, else over its character | `UI_VIZ_CARD_NOTE` |
| `presume_absent` | 6 | `person_absent`, `pet_poof` per seat, `claim_stale` per claim | "zzz" over the character | `UI_VIZ_CARD_ABSENT` (`PH_PRESUMED_ABSENT`) |
| `save` | 2 fold / 7 emit | `save` | confetti over every desk published since the previous save; a stamp | `UI_VIZ_CARD_SAVE` "{name} saved" (no summary: the save commit is never read) |
| Derived: a peer in `liveSet(after)` leaves `rankedSet` (no board commit in the last `K_evict` = 200 heights; Plan 2 `rankedSet`) | 2 | `person_ghost`; `person_unghost` when it is back in `rankedSet` | translucent and grey | — |
| Derived: 64 heights since the actor's last publish | 2 | `pose_relaxed` | leaning, reading pose (never "zzz", which means presumed absent) | — |
| An op whose verdict is `unfolded` or `rejected`; a changed live commit of malformed shape | — | none | the frame's `unknown` count (room detail tooltip) | — |

**Local overlay (own room only, present only).**

| `status.json` | Own room light | Extra |
|---|---|---|
| `ok` | normal | — |
| `degraded` | yellow lamp | — |
| `offline` | storm window | `UI_VIZ_LAST_FETCH` "last fetch {n} min ago": `last_fetch_age_ms + (machineMonoMs() − heartbeat_mono_ms)` (§3.3.6) |
| `frozen` | ice banner | reason chips from `freeze_reasons` (`PH_FROZEN` wording) |
| `paused` | "paused" sign on the door | — |
| `incident` | red siren | the room is frozen at its last good scene (§6) |
| `refused` | closed sign | — |
| `down` (or a parsed heartbeat older than 3 loop periods, or a missing `status.json` while `live` exists) | dim room, `UI_VIZ_ROOM_DOWN` "cowork-sync is not running on this PC" | the board history is still shown |
| present but over 1 MiB or unparseable | the previous light, with `UI_VIZ_STATUS_UNREADABLE` | never `down` |
| `pending.holds_active > 0` / `pending.incoming > 0` / `pending.cs_ready > 0` | — | count chips: parcels at the "you" character / delivery cart at the door / packed boxes at the door |

**What each plan adds on screen.**

| After plan | New on screen |
|---|---|
| 2 | Rooms from `--repo`; the room opening; people entering (join) with version, rules and credit badges; human change-sets: the person walks to file desks, sparkles and paper planes, the big table for large change-sets, activity cards; freeze and thaw (EPOCH), the slowed snail, the host-refused "!"; ghosts and relaxed poses; the board-full levels from the record count (the `BOARD_FULL` event joins them in whichever plan implements PRO-06's record withholding); the own room's light, `down` state, counts and "you"; join cards; rewind by height; demo mode. Not yet: pets, claims, requests, notes, teammates' conflicts, leave, save. |
| 3 | Teammates' K4 conflicts ("!" on the record owner, no winner line); K7 "waiting for checks"; parcels, shelves, delivery carts, lockboxes; the `MASS` freeze label; revert badges; conflict cards. |
| 4 | Claims as chairs with labels, re-anchors and releases; reservations in the fold; K2/K3/K6 claim PINs and `claim-breach` records. |
| 5 | Pets (`seat_start`/`seat_end`, seat ids in `Cowork-Seat` and `cs_id`); checkpoint versus closed sparkles; the wake alarm clock; seat wiring labels; the `NOHOOKS` freeze label. |
| 6 | Conversations: requests (walking to the holder), statuses, answers, notes, grants, presumed-absent "zzz" and STALE ghost chairs, breach events. |
| 7 | Rooms from `repos.json` and `live` (Plan 8b); leave; save confetti; the base-move sign; branch-escape badges; `PAUSED` and `CONFIG` freeze labels; complete six-language catalogs (Plan 8b). |

### 3.5 Room and desk layout

#### 3.5.1 The map

The map column lists the rooms in server order (§3.3.1). A room cell is 48 × 32 art pixels: the room label, the own room's light (overlay), and up to 16 dots coloured by the looks of its present characters (ranked set first, then the rest of the live set; ghosts grey, absent hollow). A room whose overlay is `down`, whose board ref vanished, or which is gone (§3.3.1) is grey; rooms added while the viewer runs are appended at the end. The selected room is outlined; Enter or a click selects it. Beyond 8 rooms the column scrolls.

#### 3.5.2 The office grid

- **Tile** = 16 art pixels. **Desk slot** = 3 × 3 tiles: row 0 holds the desk (2 tiles wide, monitor overhanging the top edge) and its plaque; row 1 holds the chair tile at column 0 and visitor tiles at columns 1 and 2; row 2 holds visitor tiles at columns 0 and 1; the rest is aisle.
- **Zone cell** = 7 × 10 tiles: row 0 is the zone sign; rows 1–9 hold three rows of two desk slots; column 6 is an aisle.
- **Lobby strip** = 4 tiles tall across the office width, above the zone grid: the door at column 1, 16 home spots at fixed positions (two rows of 8, two tiles apart) and the big table (4 × 2 tiles) at the right end.
- **Office** = the lobby strip, then zone cells in a grid of `C = 3` columns, filled row-major in allocation order. The office grows downward only.
- **Coordinates** (tiles; x to the right, y down, origin at the office's top-left; the office is `7·C = 21` tiles = 336 art pixels wide and `4 + 10·⌈cells / 3⌉` tiles tall). Lobby: row 0 is wall except the door tile (1, 0); home spot `i` (0–15) is (2 + 2·(i mod 8), 1 + ⌊i / 8⌋); the big table covers (17–20, 1–2), its chair tile is (18, 3) and its visitor tiles, in order, are (16, 3), (17, 3), (19, 3), (20, 3); characters beyond 16 home spots stand on the door cluster (0, 1), (0, 2), (0, 3), (1, 2), (1, 3), assigned round-robin in home-spot order. Grid cell `g` (creation order) has its origin at (7·(g mod 3), 4 + 10·⌊g / 3⌋); its sign is drawn over its row 0, and an annex cell repeats its zone's sign. Slot `s` (0–5, row-major) of a cell has its origin (x, y) = the cell origin + (3·(s mod 2), 1 + 3·⌊s / 2⌋): the desk covers (x, y) and (x + 1, y), the chair tile is (x, y + 1) and the visitor tiles, in order, are (x + 1, y + 1), (x + 2, y + 1), (x, y + 2), (x + 1, y + 2). A pet `behind` its character stands one tile below it, or one tile above it when the tile below is blocked or outside the office. A supervising character (`beside`) stands on the first free visitor tile of that desk. **Blocked tiles** are exactly the lobby wall, desk tiles and big-table tiles; every other tile (signs, chairs, visitor tiles, home spots, aisles) is floor for pathfinding.

The layout guarantees one-tile aisles between all furniture, so every chair, visitor tile and home spot is reachable.

#### 3.5.3 Allocation (append-only)

```
desk-eligible paths: paths named on the board inside the window —
  decoded Cowork-CS-Paths (Plan 2), claim.path (4), request.path (6),
  hold.paths[] of records that are not local_only (3); a local_only stub names no desk-eligible path
first-touch order:
  1. paths of HELD and STALE claims in the start state, sorted by path
  2. then each path at its first naming in frame order (op line order, then CS trailer order; within one CS, sorted)
zone(p) = s1/s2  if p has three or more segments s1/s2/…   (e.g. src/engine/)
          s1     if p has two segments                      (e.g. test)
          '·'    if p is a root-level file
desk key: a file desk's key is p; a folder desk's key is zone(p) + '/'; a shelf desk's key is zone + '/…';
          the big table's key is '⌂'
allocate(p):
  z := zone(p)
  if z has no cell:
    if 15 zones exist: z := '…' and the desk key becomes zone(p) + '/'   (one folder desk per overflow folder)
    else: create z with one cell at the next free grid cell
  if z has fewer than 23 file desks:
    take the next slot (row-major in z's newest cell); when that cell is full, first add an annex cell
    at the next free grid cell (at most 4 cells per zone)
  else:
    map p to z's shelf desk, created on first use in z's 24th slot and labelled UI_VIZ_SHELF_DESK "{zone}/… +{n}"
desk ordinal: the allocation index of the desk (the big table is 0)
home spots: in home-spot order (§3.6); beyond 16, characters stand in a cluster by the door
```

- A desk never moves and is never removed while the viewer runs. A desk with no event for 256 heights is drawn dimmed (a pure function of height distance).
- **Rewinding** keeps the layout of the head of the window; desks first touched after the scene position are drawn as dashed outlines, so scrubbing never reflows.
- **Live extension** is append-only, so `extendTimeline` and a fresh `buildTimeline` over the longer window give the same layout (§3.3.5).
- **"Load earlier"** (§3.9.1) never rebuilds the layout: `prependTimeline` allocates the paths that the earlier page names and the layout lacks, in that page's first-touch order, **after** every existing desk, and moves nothing. The server holds one layout per room for all tabs and sends the appended desks to every open stream as one `layout` event, so desk ordinals in events and cards stay valid in every tab. The layout is therefore a function of the initial window and the ordered sequence of extensions (live frames and earlier pages), which INV-VIZ-DET pins.
- **Scrolling, not automatic coarse zoom.** The office panel scrolls vertically. The zoom `Z` (§3.7) is computed only when the page opens, on a window resize or on a user zoom, never because the office grew. In live mode the panel scrolls to an off-screen desk of a new event only when the user has not scrolled in the last 30 s. (rev 2.5, F32) In a room with a follow (§3.8.1), the follow camera replaces this rule; in replay it is the only automatic scroll. A **coarse view**, in which each zone is drawn as one table with a desk count and its characters standing around it, is a user toggle (`UI_VIZ_CTRL_COARSE`), never entered automatically; positions in the layout do not change.
- **`local_only` stubs** create no zone and no desk: their lockbox stands at the big table, or on a desk that already exists for that path from another source. On the recording canvas a desk carrying a `local_only` lockbox shows a lock glyph instead of its plaque, with anonymize on or off (§3.9.4).
- The plaque shows the file's basename (≤ 16 characters, middle ellipsis); the full path (≤ 80, glossary §19) is in the tooltip and in the screen-reader list.

#### 3.5.4 Placement: who sits where

**Actor of a change-set** (the `cs_id` grammar, glossary §3): `<peer_id>/human/<n>` → that peer's character (if `<peer_id>` is not the frame's writer peer, the writer's character: a peer publishes only its own change-sets); `<seat_id>/<turn-seq>` → the pet of the seat key `"<writer.peer>/<writer.epoch>/<seat_id>"`.

**Target desk of a change-set**: the desk holding most of its paths (paths mapped through §3.5.3); ties → the desk this actor sat at most recently; then the lexicographically first desk key. Its other desks get paper planes and sparkles.

**Character, in precedence order:**
1. an open request it filed with `origin=human` (Plan 6): standing at the holder's chair;
2. the target desk of its newest human change-set, when that publish is newer (board position) than every claim op of its pets;
3. otherwise, when its pets hold claims (Plan 4+): standing beside the desk where most of its pets sit ("supervising");
4. otherwise its home spot.

**Pet, in precedence order** (Plan 5+): an open request it filed (standing at the holder's chair); its newest HELD claim's chair; a stool at a claim it was granted; the target desk of its newest change-set (edits that carry no claim); one tile behind its character.

**Chairs.** A desk's chair belongs to its newest HELD claim holder (Plan 4+), else to its most recent publisher; other claim holders and publishers take visitor tiles, claim holders first, then by recency; beyond four visitors a "+n" chip (`UI_VIZ_MORE`). A desk's claims are ordered by `ranges[0][0]` and each shows a chair tag: `label.simple` (or `qualname` when two tags on the desk share `simple`), cleaned by `validLabel` (else `?`, SEC-35), 80-character middle ellipsis, marked unverified (§8 Q6); `granularity: file` tints the whole desk; `block` shows `UI_VIZ_TAG_LINES` "lines {lo}–{hi}"; a claim under another `regionSpec` is drawn whole-file with the `UI_VIZ_BADGE_RULES` "different rules" badge.

**Walking means something.** Only `request_open` makes an actor walk to another actor: it stands facing the holder, with a bubble or a parcel and a dashed line. Every other walk ends at a desk (sitting, or standing at a visitor tile facing the desk). Sitting after a publish is labelled `UI_VIZ_LAST_SHARED_HERE` "last shared here (#{height})", never "working on": in Plans 2–3 nothing proves current work, and sitting must not look like a lock. A HELD claim is labelled `UI_VIZ_HOLDING` "holding {label}".

**Persistence.** An actor stays where its last event put it until its next event, `person_exit`, `person_absent`, `pet_poof` or `person_ghost`.

**Pathfinding.** 4-way A\* on the tile grid with a Manhattan heuristic, neighbour order N, E, S, W, a turn penalty of 1, ties broken by that order. Actors pass through each other; only chair tiles are reserved. With no path, or at replay speed ≥ 4× over a distance of more than 12 tiles, the actor poofs and reappears at the target. Paths are cached per (layout version, from, to).

### 3.6 Characters, pets and palettes

**Art.** Original "mallang" blobs (VD-2), drawn from string maps embedded in the client bundle: no image files, no fonts, no third-party art. The page and every export carry no Anthropic or Claude logo, mascot or mark; text may say "Claude session" where it names what the user runs, as 10-product does. The 16 × 16 base map and the first four accessory overlays come verbatim from the brainstorm's option A:

```
base (16×16)          keys: o outline  b body  h highlight  c cheek  w eye white  k pupil  f foot (= o)
................      accessory overlays — row index: 16 chars; '.' transparent; a/A accessory tones; l lens
.....oooooo.....      beanie : 0 "......aaaa......"   1 "....aaaaaaaa...."   2 "...AAAAAAAAAA..."
...oobbbbbboo...      phones : 1 ".....AAAAAA....."   5 "aa............aa"   6 "aA............Aa"
..obbhhbbbbbbo..               7 "aA............Aa"   8 "aa............aa"
..obhhbbbbbbbo..      shades : 6 "...AllAAAAllA..."   7 "....ll....ll...."
.obbbbbbbbbbbbo.      scarf  : 10 "..aaaaaaaaaaaa.."  11 "..........aa...."  12 "..........aA...."
.obbwkbbbbwkbbo.      sprout : 0 "......aaAaa....."
.obbwkbbbbwkbbo.      cap    : 1 ".....AAAAAA....."   2 "...aaaaaaaaaa..."   3 "..........aaaaa."
.obcbbbbbbbbcbo.      bow    : 1 "..aAa..........."   2 "...a............"
.obbbbbkkbbbbbo.      glasses: 5 "...AAAA..AAAA..."   6 "...A..AAAA..A..."   7 "...A..A..A..A..."
..obbbbbbbbbbo..               8 "...AAAA..AAAA..."
..obbbbbbbbbbo..
...oobbbbbboo...      pet (8×8)        seat variant, drawn above the pet's row 0
....ofo..ofo....      "..oooo.."        0 none   1 sprout "aa"   2 antenna "A"   3 star ".a." / "aAa" / ".a."
....ooo..ooo....      ".obhhbo."        ≥ 4: a 3×5 digit
................      "obhbbbbo"
                      "obkbbkbo"
                      "obcbbcbo"
                      "obbbbbbo"
                      ".oobboo."
                      "..o..o.."
```

The other four accessories (sprout, cap, bow, glasses) and the pet are original designs of this chapter. The implementer may refine any map within the same keys and size; every change is reviewed for originality. Fixed tones: cheek `#F2B49A`, eye white `#FFFFFF`, pupil `#1A1A1A`, lens `l` `#59C3FF`. The main tone pairs `(a, A)` of the first four accessories come from option A: beanie `#3E7CB1` / `#2A5578`, headphones `#E4E4E4` / `#333344`, sunglasses `#222222` / `#222222`, scarf `#C8463D` / `#8E2E28`; the main pairs of the other four and every alternate pair are chosen by the implementer in `src/viz/render/palette.ts`, reviewed with the art, and bound by the ΔE test below.

**Body hues (7).** The Okabe-Ito set without black, with vermillion replaced by the Claude-like apricot of the mockups:

| Index | Name (`UI_VIZ_ANON_NAME_*`) | Body `b` |
|---|---|---|
| 0 | APRICOT | `#D97757` |
| 1 | AMBER | `#E69F00` |
| 2 | SKY | `#56B4E9` |
| 3 | GREEN | `#009E73` |
| 4 | LEMON | `#F0E442` |
| 5 | BLUE | `#0072B2` |
| 6 | PINK | `#CC79A7` |

Highlight `h = mix(b, #FFFFFF, 0.35)` and outline `o = mix(b, #000000, 0.62)` per channel, rounded, computed at build time. **Contrast on the scene.** A build test requires, for every hue, CIEDE2000 ΔE ≥ 20 between the outline and both floor tones, ΔE ≥ 15 between the eye white and the body, and ΔE ≥ 10 between the cheek and the body. A hue that fails is adjusted in CIELAB L* in steps of 1 (lighter for the outline test, darker for the eye-white and cheek tests; hue angle and chroma kept) within L* 55–80, the band of the option-A pastels, and the build fails when no value passes all three. The adjustment runs before the colour-vision test below, which then uses the adjusted bodies.

**Accessories (8):** beanie, headphones, sunglasses, scarf, sprout, cap, bow, glasses (names `UI_VIZ_ACC_*`, used by anonymize and screen readers). Each has a fixed main tone pair and a fixed alternate pair. A build step chooses, per (accessory, hue), the main pair when its main tone has CIEDE2000 ΔE ≥ 15 against the body, else the alternate pair (which a build test proves qualifies), so an accessory never melts into its body.

**Look assignment.** `n = uint32(sha256(peer_id ‖ 0x00 ‖ "viz-look")[0..3])`, `L = n mod 56`, hue = `L mod 7`, accessory = `⌊L / 7⌋`. The look depends on `peer_id` alone, with no collision probing, so one peer has the same look in every room, window, viewer and run, on every teammate's PC; "load earlier" and a later viewer start never recolour anyone. Two peers can share a look (about 10 % of rooms with 4 peers, 41 % with 8); both then show their handle in the name tag (below), so tags always tell characters apart. A look never derives from the display name, so a teammate cannot take another's look by renaming. (A collision-free assignment needs a board-wide join order: §8 Q13.)

**Home-spot order.** The peers of the start state sorted by `peer_id`, then each new peer at its first appearance in the frames; a peer that "load earlier" reveals is already in the start state (the fold keeps every `PeerRec`), so home spots never move.

**Name tag.** `display` through `validName` (else `peer-<handle>`), sanitized, ≤ 20 rendered characters; two peers in a room with the same tag, or with the same look, get `display · handle`. The "you" marker (overlay) is an arrow and `UI_VIZ_YOU`.

**Pets.** The 8 × 8 pet uses its owner's highlight as body and its owner's outline as outline, with no accessory. The seat variant follows the order of each seat's first footprint (or `seat_start`) among its owner's seats in the window. A pet whose seat's `permission_mode` (Plan 5) is `plan` MAY show a 3 × 3 clipboard badge, and any mode other than `default` and `plan` MAY show a 3 × 3 bolt.

**Colour is never the only carrier.** Every character has an accessory shape and a name tag (WCAG 1.4.1); states have icons and text labels; rewind-bar ticks differ by glyph shape; a conflict is a "!" glyph, not only red. A palette test computes the minimum pairwise CIEDE2000 distance of the seven body hues under normal vision and simulated protanopia, deuteranopia and tritanopia (Machado et al. 2009, severity 1.0); for each of the four views it MUST be at least 0.9 × the same minimum for the unmodified Okabe-Ito set without black. Request and status icons, the wake clock, the gear, flags and ticks are 8 × 8 sprites in the same palette, never emoji or font glyphs, so they look the same on every OS.

**Environment palette** (from the mockups): floor checker `#3A3346` / `#342E40`, wall and margins `#22222C`, desk `#6B4A2E` / `#8A6440`, monitor `#2B2B38` with screen `#59C3FF` (idle) or `#7FE0A0` (published within the current beat). The chrome (log, bars) follows `prefers-color-scheme` with one light and one dark token set; the scene keeps its own palette in both. The chrome's accent (selected room outline, live pill, rewind progress, focus ring) is the apricot `#D97757` in both themes, the warm orange of VD-2; it is never a text colour, so the 4.5:1 text contrast rule does not depend on it.

### 3.7 Animation states and timing

**Rendering.** One canvas per view (map, office). The backing store is sized in device pixels; every art pixel is a block of `Z` device pixels with integer `Z` (auto-fit `Z = max(2, ⌊panelW / worldW⌋)`, computed only when the page opens, on a window resize or on a user zoom, never because the office grew; manual 2–8; the office panel scrolls vertically, §3.5.3; the map uses `max(1, Z − 1)`); never `ctx.scale(dpr)`; `imageSmoothingEnabled = false` and CSS `image-rendering: pixelated`. The art layers are composed at art resolution by the pure module `src/viz/render/raster.ts` into RGBA buffers (no DOM, so tests can hash them), which the page puts into an art-size offscreen canvas and draws scaled by `Z`. A static layer (floor, walls, desks, plaques) is recomposed only on a layout or zoom change; the sprite layer is recomposed per drawn frame, z-sorted by foot y, then by actor id. Text (names, plaques, bubbles) is drawn with `fillText` in the system UI font at device resolution and cached per (string, size, theme), so CJK renders natively; text glyphs may therefore differ by OS, art pixels never. `requestAnimationFrame` drives the loop, capped at **12 fps**. The loop draws only when some sprite's frame index changes: idle-bob phases are 0 or 600 ms, so a room where everyone is idle draws at most 2 frames per second; with nothing animating (paused, reduced motion, or no actor on screen) the loop stops; it pauses with the tab (browser behaviour).

**States.** Every state is entered only through a scene event (§3.4); no timer guesses activity (VIZ-22). (rev 2.5, F29, F04) Two render states are not entered by a scene event, and each is built only from scene events: the **title card**, which exists only on the recording canvas and is entered only by a reel `intro` step (§3.9.6), and the **montage**, entered only by a reel `montage` step or a catch-up Play montage beat (§3.9.1). Neither is a scene-event kind, so the closed set of §3.4, VIZ-10 and the golden timelines are unchanged.

| State | Frames × duration | Entered by | Reduced motion |
|---|---|---|---|
| idle bob | 2 × 600 ms, phase 0 or 600 ms from the seed | present with nothing pending | off (static) |
| walk (hop) | 4 × 100 ms (squash, rise, peak, land) at 4 tiles/s, sped up so a trip lasts ≤ 3 s | `publish`, `request_open`, `claim_take`, walking back | 150 ms crossfade at the target |
| sit and type | 2 × 140 ms with 1-px key sparks; minimum dwell 1.5 s | arriving at a publish target or a claim chair | static keyboard icon |
| sparkle small / big + flag | 4 × 100 ms / 6 × 100 ms | `publish` (`checkpoint` / `closed`) | static star for 1 s |
| paper planes | 6 × 100 ms per desk, ≤ 4 desks, then "+n" | `publish` with other desks | a static dot on those desks |
| exclaim "!" | 2-px jump and pop, 700 ms; for a conflict that comes from a hold record, then a persistent "!" badge until that record is terminal; a conflict or bang that comes from an event (terminal at creation) exclaims for one beat only | `conflict`, `person_bang` | static outline and "!" glyph |
| think "…" | 3 × 350 ms | `pet_spawn` before its first change-set; `request_status{asked}` | static "…" |
| icon bubble | 200 ms pop, then the bubble duration (§3.8) | `request_status`, `answer` | no pop |
| zzz | eyes closed, rising "z", 3 × 600 ms | `person_absent` | static "zzz" |
| relaxed | 2 × 900 ms lean | `pose_relaxed` | static pose |
| ghost | 50 % alpha, desaturated | `person_ghost` | same |
| frozen / paused | ice block or sign, no bob | `person_freeze` | same |
| slowed | snail badge until the position reaches `until` | `person_slowed` | same |
| enter / exit | walk from or to the door, 0.4 s dither dissolve | `person_enter`, `person_respawn`, `person_exit` | crossfade |
| pet spawn / poof | 0.3 s puff | `pet_spawn`, `pet_poof` | crossfade |
| celebrate | 3-frame jump and 12 confetti pixels, 1.2 s, everyone in the room | `save` | static stamp on the desks |
| parcel states | per §3.4 | `box` | static icons |
| title card (rev 2.5, F29) | scene held still; a 1-art-pixel `#D97757` ring on the focus actor (a conflict chapter: on the conflict's desk; none when it has no desk); title and `k/N` (3 × 5 digits) in the caption strip; 2,000 ms | a reel `intro` step (§3.9.6) | same |
| montage (rev 2.5, F04, F29) | 150 ms crossfade to the end scene of the run it stands for, then a small sparkle on each desk that run's publishes touched (≤ 12 by count, then ordinal; `UI_VIZ_MORE` beyond), 100 ms apart; an 8 × 8 fast-forward sprite and the caller's caption in the caption strip (`UI_VIZ_REEL_MONTAGE` for a reel, `UI_VIZ_MONTAGE` for Play); 1,200 ms in a reel, ≤ 1.5 s in Play | a reel `montage` step (§3.9.6); a catch-up Play montage beat (§3.9.1) | static dots on those desks |

Frames are deterministic edits of the base map: squash drops row 3 and moves rows 0–2 down one; eyes closed turns the `w`/`k` pixels of row 6 into `b` and those of row 7 into `o`; the walk frames are vertical offsets of 0, −2, −3 and −1 art pixels; facing left is a horizontal flip (the blob is symmetric).

**Beats.** Live: each board commit is one beat of 300 ms; when queued beats exceed 5 s of playback, or a `room_snapshot` arrives (§3.9.2), the page crossfades to the newest scene and marks "caught up" (`UI_VIZ_CAUGHT_UP`) on the rewind bar. Replay: 800 ms per beat at 1×, with speeds 0.5×, 1×, 2×, 4× and 8×. The events of a beat play in `sub` order; a walk that crosses a beat boundary finishes within 3 s. Because the axis is height, idle hours cost no playback time.

### 3.8 Conversation log, filters and bubbles

**Panel.** The right panel is DOM, not canvas, so text is selectable and readable by screen readers; 340 CSS px wide by default, a drawer below a 1,100 px viewport.

**Cards (closed list).** Conversation cards (VD-7): `request` (with its note), `answer` (with its note, linked under its request), `note`, `join`, re-join, `leave`, `seat_start`, `seat_end`, `presume_absent`. Conflict cards: a K4 hold, a `claim`/`t0`/`claim-breach` hold creation, `event{breach}`, a generic K-kind event. Activity cards: change-set publishes (below). System cards (hidden unless the system filter is on): room opening, version, rules, other health codes, freeze, thaw, slowed, host refused, save, base move, board full. `request_status` is a status chip on its request card, not a card.

**Activity cards.** A change-set publish is an activity card `UI_VIZ_CARD_PUBLISH` ("{name} shared {n} files"). Consecutive publishes of one actor, with no other visible card between them, merge into one card with up to 5 file chips and "+n" (`UI_VIZ_MORE`); merging is done by the log panel when it renders, after filters, while the timeline and the API keep one card per publish (§3.3.7). Activity cards carry only trailer facts: the actor, the paths, `state`, `checks` and `origin`. They are not conversations (§1.5 item 10), have their own filter, and are shown by default.

**Card content.** The actor (look swatch, accessory glyph, name tag); the target (holder, request); file chips (path ≤ 80, middle ellipsis); display ids so that a user can type `/cowork show <id>`: `R…` for requests, `C<cid>` for events, and for a hold record the first 8 characters of its hold id (a unique prefix is a show id, 10-product §2); the text rendered from the card's `UI_VIZ_CARD_*` template (§3.11); teammate free text inside a quoted note frame (§3.11); and a position label. In replay the label is `#<height>`. In live mode, a card for a board commit that this viewer process folded while running shows `UI_VIZ_SEEN_AGO` "seen {n} min ago": the server serves `seen_ms`, its own Δmono since it folded that commit, relative to the response, and the page adds its own Δmono since the response, so a reload or a later tab shows the true age. A card that was already in the window when the viewer first folded the room shows `#<height>` and `UI_VIZ_SEEN_BEFORE_OPEN` "before this view opened". No absolute or remote clock time appears (I18N-03, UX-22).

**Order and scrolling.** Board position ascending, newest at the bottom; the list follows new cards unless the user scrolled up, in which case a "new" pill (`UI_VIZ_NEW_PILL`) jumps down.

**Catch-up panel** (rev 2.5, F04). On page load each room shows a **catch-up panel** at the top of the log. It is page state, not a card: never in `Timeline.cards`, never served, merged, filtered or counted. It reads `UI_VIZ_CATCHUP` "Since #{h}: {m} for you, {t} team moments, {r} other changes" (`h` the anchor height; the three counts from the lanes of `moments`, §3.9.1) with **Play** (§3.9.1) and an anchor menu: **last visit** (`UI_VIZ_ANCHOR_VISIT`, the default), **last save** (`UI_VIZ_ANCHOR_SAVE`: the newest `save` event ≤ `open_h`), **since this view opened** (`UI_VIZ_ANCHOR_OPEN`: `open_h`, §3.10.6) and **#height** (`UI_VIZ_ANCHOR_HEIGHT`).
- **Last visit** = `lastVisit(t, you, open_h)`: the newest position ≤ the last position of `open_h` of a board fact made by **you** (the `peer` file's `peer_id`, the overlay's "you", §3.3.6) or your pets: `publish` with `origin ∈ {prompt, human}`, `answer` with `by = human` whose holder is you or your pet, `request_open` whose `from` is your character (`origin = human`), or `save` by you. This is a board-only proxy: a long human-started Claude turn that keeps publishing `origin=prompt` after the human left moves it later than the real departure. The CLI's local marks (`/cowork since`, 10-product) are the precise anchor; the viewer stays board-only on purpose, because its read set (§3.3.2) is exhaustive.
- No such fact in the timeline the page holds → `UI_VIZ_CATCHUP_OLDER` with "load earlier" (pages of 256, ≤ 5,000 heights below `open_h`; beyond that the panel names `/cowork since`). `you` unknown (no `peer` file, demo) → no panel.
- The panel and the last-visit flag (§3.9.1) are page state: they change no `Timeline`, golden output, card, tick or recording (FEAT-F04-13), no served JSON has a visit field for any peer, and teammates never get a visit flag.
- When a follow is on (§3.8.1), the now card sits directly below the catch-up panel.

**Filters.** All; by person (clicking a character on the canvas, its name chip, or the screen-reader list); by file (clicking a desk or a file chip); by kind (conversation, activity, conflicts, system). Filters combine with AND. Filter state lives in the page; it MAY be mirrored into the fragment as `#room=r…&peer=<handle>&desk=<ordinal>`, parsed with fixed regexes (`^r[0-9A-HJKMNP-TV-Z]{8}$`, `^[0-9a-f]{6}$`, `^(0|[1-9][0-9]{0,4})$`) and never with a path. (rev 2.5, F32) Following (§3.8.1) pins the person filter while its room is selected; whom a page follows is never mirrored into the fragment.

**Bubbles.** The text of a `request`, `answer` or `note` appears briefly in the scene above its actor:
- duration = clamp(1.5 s, 0.5 s + Σ 1/cps(char), 6 s), where cps is 20 for Latin and other scripts, 12 for Hangul, 9 for Han, and 4 for every character of a text that contains kana (reading speeds of the Netflix timed-text guides);
- at most 2 lines × 42 Latin or 16 full-width characters, then an ellipsis; the whole text is in the card, and clicking the bubble scrolls the log to it;
- at most one bubble per actor (a newer one replaces it) and three per room (the oldest fades early);
- in replay at k× the duration is divided by k, never below 1.0 s;
- request, status and answer icons (8 × 8 sprites, §3.6) use the same rules, with the icon's `UI_VIZ_ICON_*` label as the screen-reader text.

**Never in the log or the scene:** Claude transcripts, prompts, tool input, file content, diffs, held bytes, save-commit summaries (never read), e-mails, host text, raw reason codes (codes appear only in a detail tooltip).

**Memory.** At most 2,000 cards per room stay in the page; older ones are fetched by timeline page.

#### 3.8.1 Following a person (rev 2.5, F32)

A person who keeps `/cowork view` open on a second monitor may want to keep one teammate in view, while the office panel otherwise scrolls to whoever moved last (§3.5.3). **Follow** is a per-room, page-only choice of one peer. While it is on, the office scroll follows only that peer's character and pets, the log's person filter is pinned to that peer, and a **now card** pinned above the log shows what the scene says about them: the claims their sessions hold, their open requests in and out, and the last path they shared. Live and replay behave the same. Follow is a lens over the scene the page already computes: it adds no read, route, request, stream payload, view-model field, scene-event kind or `Timeline`/`Scene` field, and nothing in `src/viz/model/**` changes, so VIZ-10 and INV-VIZ-DET are untouched.

##### Turning it on and off

| Action | Effect |
|---|---|
| The follow toggle `UI_VIZ_CTRL_FOLLOW` ("Follow", `aria-pressed`) on the person-filter chip of the log (the visible control, shown when a person filter is set, e.g. after clicking a character; it sits there, not on the canvas, because the office canvas is `role="img"` and carries no controls) and, for screen-reader users, as a second button on each row of the visually hidden people list (§3.11) | follow that peer in the selected room; the person filter becomes that peer; the now card appears |
| `F` (focus not in a form control) | toggles follow for the peer of the current person filter; does nothing when no person filter is set |
| The toggle again, `Esc` while no export panel is open (it clears filters, §3.11), clearing the person filter, or choosing another person filter (clicking another character or chip) | follow ends in the selected room; the §3.5.3 30-second rule applies again |
| Selecting another room | not a person-filter change and no end of a follow: that room's own follow (or none) applies, and with one it pins the person filter to its peer; the first room's follow is kept in page memory, and when that room is selected again its follow is back and pins the person filter to the followed peer again |
| A world reload (`reset`, §3.10.5) after which the followed handle is no longer a character of the room (a handle extended after a prefix collision, Plan 8a ruling R-V22) | follow ends in that room |
| A page reload | every follow ends (page memory only; a person filter the page mirrored into the fragment, §3.8, survives and `F` restores the follow) |
| A click on the `UI_VIZ_FOLLOWING` chip of the now card | re-centres the camera at once: camera steps 2–3 below apply even when the frame is already visible |

One follow per room, at most 32 (one per room, §3.3.1). Follow is keyed by the peer's handle inside one room (6–32 hex, Plan 8a ruling R-V22; a character is one peer of one clone, §2 "character"); it never carries to another room, even to a character there with the same display name (glossary §2; §8 Q4). No scene event starts or ends a follow: a followed character that becomes a ghost, absent or frozen stays followed and keeps its look; one with no `Scene.characters` entry at the drawn position (before its `person_enter` in replay, after `person_exit`) stays followed and the now card shows `UI_VIZ_NOW_NOT_HERE`. "Not a character of the room" (the reload row above) means absent from the room's `CharacterVM` list, which holds every peer of the window, not absent from the scene at one position.

##### The follow camera

The **followed actors** are the peer's character (when in `Scene.characters`) and every pet in `Scene.pets` whose `owner` is that peer and whose `live` is true. The **focus actor** of a beat is the followed actor whose `place` differs from the previous beat's scene: the character first, then pets in the order the page holds them (ascending seat handle, the view model's array order); when none moved, the character, else the first pet. Tiles come from the page's existing `placeTile` (Plan 8a `render/raster.ts`), or the zone table in the coarse view.

The camera is evaluated on follow start, on every beat (with the scene at the beat's last position: the destination of its walks), after a seek, a `room_snapshot` or "load earlier", on room selection and on a click on the chip. On each axis the panel can scroll (vertical always; horizontal only when the office is wider than the panel, after a user zoom or in a panel narrower than the office at the minimum `Z`):

1. Let the frame be the bounding box of the followed actors' tiles plus a 1-tile margin. When the frame is inside the visible area, nothing scrolls.
2. Else, when the frame fits the visible area, scroll so that it is centred, clamped to the office.
3. Else centre the focus actor's tile, clamped to the office.

| Rule | Value |
|---|---|
| Other actors' events in the followed room | never scroll the panel (in live mode the follow camera replaces the §3.5.3 30 s rule in that room; in replay, where no automatic scroll exists, it is the only one) |
| Pan | smooth scroll over 300 ms (one live beat; REASONED) |
| Jump instead of pan | effective reduced motion (OS `prefers-reduced-motion` or the in-page toggle), replay speed ≥ 4× (the speed threshold of `shouldPoof`, §3.5.4), a seek, a `room_snapshot`, "load earlier", a room switch |
| A user scroll (wheel, touch, scrollbar, keys) while following | honoured: the camera does not move until the next beat in which a followed actor's `place` changes, or a chip click; scrolls the camera itself makes never count as user scrolls |
| Pause control (WCAG 2.2.2) | no beats, so no pan |
| Zoom `Z`, coarse view | never changed by follow (VIZ-16) |
| Recording camera (§3.9.4) | never steered by follow, nor the reel's precomputed path (§3.9.6) or the postcard's still camera (§3.9.5); the now card is never recorded (the log is not, VIZ-29) |

##### The now card

Pinned at the top of the log panel (also in the drawer below 1,100 px), a labelled region, **not** a card of the §3.8 list: never in `Timeline.cards`, never served, merged, filtered or counted. When the catch-up panel (§3.8) is shown at the top of the log, the now card sits directly below it. It is recomputed from the scene the office draws (live: after each beat; replay: at the rewind position), the layout and the character table, and from nothing else.

| Row | Source (scene `s`, followed peer `p`) | Text | Limit |
|---|---|---|---|
| Header | `c = s.characters.get(p)`, its look swatch and accessory glyph, its name tag (§3.6), and `phOf(c, c.absent ? 'absent' : 'active', s.at)` (Plan 8a ruling R-V56, `model/labels.ts`), which needs only the scene, so live and replay agree (not `CharacterVM.ph`, which is computed at the tip) | `UI_VIZ_FOLLOWING` "Following {name}" + the `PH_*` label (none for a ghost); the toggle `UI_VIZ_CTRL_FOLLOW` (pressed) | 1 |
| Holding | `s.claims` entries with `stale = false` whose `seat` is a pet of `p` (`s.pets.get(seat).owner = p`), ordered by desk ordinal, then `order` | `UI_VIZ_HOLDING` "holding {label}" (existing code; the chair-tag label rules of §3.5.4: `validLabel` else `?`, unverified mark) + the desk's file chip | ≤ 3, then `UI_VIZ_MORE` |
| Asks | `s.requests` entries whose `from` is `p`'s character or a pet of `p`, ascending display id | `UI_VIZ_NOW_ASKS` "asks {target} ({id})" + the status icon of `status` (`UI_VIZ_ICON_*`; no icon while `status` is null) | ≤ 3, then `UI_VIZ_MORE` |
| Asked by | `s.requests` entries whose `holder` is `p`'s character or a pet of `p`, ascending display id | `UI_VIZ_NOW_ASKED_BY` "asked by {target} ({id})" + status icon (as above) | ≤ 3, then `UI_VIZ_MORE` |
| Last shared | among `p`'s character and **every** pet of `p` in `s.pets` (live or ended: a pet whose session ended still made `p`'s newest share), the `ActorState` with the greatest `lastPublish` (`comparePos`; the position-typed `lastPublish` and the `lastDesk` field of Plan 8a ruling R-V25); its `lastDesk` and `lastPublish.height` | `UI_VIZ_NOW_LAST_SHARED` "last shared: {path} (#{height})", where `{path}` is, by the desk's served kind (`LayoutVM.desks`, which carries no desk key): a file desk's `path` (≤ 80, middle ellipsis); a folder desk's `plaque` (its folder); a shelf desk's zone `sign` followed by `/…`; at the big table `UI_VIZ_NOW_LAST_SHARED_TABLE` "last shared: a change too large to list (#{height})" | 1 |
| Empty | no row above | `UI_VIZ_NOW_NOTHING` "Nothing held, asked or shared yet in this view." | — |
| Not here | no `s.characters` entry for `p` | `UI_VIZ_NOW_NOT_HERE` "{name} is not in this room at this point." | — |

`{target}` is the name tag of the other side's character (a pet's owner). A file chip sets the file filter and a display id scrolls the log to its card (existing §3.8 behaviour). The card never says "working on" (VIZ-17), never shows a time, age, "last seen" or "offline" (VIZ-11, UX-22), never a count over time or a history (the only number besides `#height` and display ids is the `UI_VIZ_MORE` "+n" of rows held now), never a note's text (notes stay in the log's quoted frame), and never an overlay value (VIZ-13), also when following the "you" character. A segment's start scene carries no publish history (§3.3.5), so the last-shared row shows only publishes inside the segment of the drawn position (the initial window's own segment starts at `h0`; after "load earlier" each earlier segment starts empty too); before the first one it is the empty row, which is why that row says "in this view".

**What shows when.** Plan 2 boards fold no claims or requests and have no pets (§1.5 item 2; §3.4 "What each plan adds"), so only the header, last-shared, empty and not-here rows appear. The holding row fills in with Plan 4's claims (held by seats, so it shows once the seat's pet exists: its first footprint, or `seat_start` from Plan 5); the asks and asked-by rows fill in with Plan 6's requests. None of this changes the follow code.

**Page state.** One `Map<roomId, Handle>` in page memory and nowhere else (`ui/follow.ts`, §3.13). It is **not** mirrored into the filter fragment (§3.8): browsers keep fragment URLs in their history files, so a fragment key would store whom a page followed on disk. The strings arrive with the existing `/api/v1/strings` viewer subset; the viewer process, its routes, stream payloads, view model, logs and budgets are unchanged.

**Wording.** The templates of the follow codes (§3.11) use, in every catalog, the "follow along" sense (ko "따라가기", ja "フォロー", zh-CN "跟随", fr "suivre", es "seguir") and never a word of surveillance (the denylist of T-VIZ-follow-i18n, §7). Docs present follow as keeping a pair-programming partner's corner of the office in view, never as supervision (FEAT-F32-12).

### 3.9 Rewind, replay, demo and export

#### 3.9.1 Rewind bar and seeking

- **Axis**: the heights `[h0, h1]` of the selected room's window. Ticks: code publishes (small bar), conflicts ("!" triangle), requests (speech glyph), saves (star), joins and leaves (door), freezes (snowflake), "caught up" marks (live). Shape and colour together; hovering shows `#height` and the card text (for a publish tick, its activity card).
- **Controls**: play/pause; drag or arrow keys (±1 height, PageUp/PageDown ±64); the speed selector; a "live" pill that returns to the tip and follows it; "load earlier", which extends `h0` by 256 per use and appends the desks the earlier page first touches (§3.5.3).
- **Seeking**: the page keeps a reduced scene every 64 heights of each segment and reduces forward from the nearest one ≤ the target in the target's segment (§3.3.5). A height the page does not hold (below `h0`, or older than the server's 2,048 retained heights, §3.3.3) is fetched from the server, which folds from the checkpoint ≤ its start (≤ 255 folds, glossary §20 "Join replay").
- **Equivalence**: the scene drawn at position p in replay equals the scene a live viewer drew at p (same timeline, same reducer), except the local overlay (absent from past scenes) and the animation phase.
- **Last-visit flag** (rev 2.5, F04): the rewind bar shows a page-drawn flag `UI_VIZ_LAST_VISIT` at the last-visit height of the catch-up panel (§3.8). It is not a `Tick`, not served and never recorded; teammates never get a visit flag.
- **Play** (rev 2.5, F04): `moments(t, from, to, you)` splits the events of `(from, to]` of the catch-up panel's range (`from` = its anchor height) into **mine**, **team** and **routine** by the lane table below. Play walks mine ∪ team in position order: for each, `reduceScene` to the position before it and animate its beat at 1×; each run of routine events between two moments is one **montage beat** ≤ 1.5 s in the montage state of §3.7, which sparkles every desk those publishes targeted (≤ 12, then `UI_VIZ_MORE`) with the caption `UI_VIZ_MONTAGE` "{n} more changes by {k} people"; then the live pill. Play draws only desks of folded publishes (FEAT-F04-14).

```ts
// src/viz/model/moments.ts (rev 2.5, F04) — pure; server and client (§3.13). Position, SceneEvent, ActorRef, DeskRef, PeerRef: §3.3.7.
export interface Moment { at: Position; lane: 'mine' | 'team'; event: SceneEvent; }
export interface Montage { from: Position; to: Position; n: number; actors: ActorRef[]; desks: DeskRef[]; }
export interface Moments { mine: Moment[]; team: Moment[]; routine: Montage[]; }   // routine: maximal runs between moments
export function moments(t: Timeline, from: number, to: number, you: PeerRef | null): Moments;
export function lastVisit(t: Timeline, you: PeerRef | null, openH: number): Position | null;
```

Lanes of `moments` (closed; `P` = you and your pets; rev 2.5, F04):

| Lane | Scene events (§3.4 kinds) |
|---|---|
| mine | `publish` by another actor whose `target` or `others` hits a desk where `P` published or held a claim in the same segment up to that event; `publish` by `P` with `origin=wake`; `request_open`, `request_status`, `answer`, `grant_start`, `grant_end` whose requester or holder is in `P`; `note` targeting a request or claim of `P`; `conflict` with `on ∈ P` or a `line` to `P` or `P`'s claim; `box` owned by `P` entering `PARKED`, `SUBSUMED` or `offer=returned`; `claim_stale` of `P`'s claim; `person_freeze`, `person_thaw`, `person_bang` of you |
| team | `room_open`, `person_enter`, `person_respawn`, `person_exit`, `person_absent`, `save`, `conflict` (not mine), `person_freeze`/`person_thaw`/`person_bang` of others, `room_sign`, `room_badge{full}` |
| routine | every other event |

`you = null` gives an empty mine lane. The highlight reel (§3.9.6) does not use these lanes: they are relative to "you", which a reel must not read.

#### 3.9.2 Live mode

The server's poll loop runs every 2.5 s over all rooms, one room at a time, with at most one git child per room at a time. Per room it stats the storage of the board ref (§3.3.2: the loose ref file, `packed-refs`, and `reftable/tables.list` when the repository uses reftable) and `status.json`, and re-reads `status.json` when its mtime changed. It runs `rev-parse --verify -q` of the board ref only when one of those (size, mtime) pairs changed, or when 60 s passed since its last `rev-parse` (a safety net for a ref update a stat cannot see); the local ref changes only when this PC's daemon fetches, so an idle room costs no git process for 60 s. A new tip triggers `rev-list --first-parent <last>..<tip>`, `readBoardCommits` and `readLiveCommits` for the new commits (one batch each, §3.3.2), folds them, calls `extendTimeline`, and sends the new scene events and cards on every open stream, split into SSE messages of at most 64 KiB. One fetch by a daemon can reveal several board commits; they are animated in sequence as beats (§3.7). A tick that reveals more than 64 new board commits for a room sends one `room_snapshot` event instead (the scene at the new tip and its last 200 cards), and the page crossfades to it. Every 30 s the loop also re-reads `repos.json` and checks the `live` markers (§3.3.1).

#### 3.9.3 Demo mode and the demo log

- `--demo` uses the bundled demo log embedded in `dist/viz.js` (≤ 64 KiB); `--demo=<file>` uses a local file of at most 4 MiB: the CLI has made the path absolute and refused UNC and device paths (§3.2 item 2), the viewer refuses a target that `lstat` does not report as a regular file, and it reads at most 4 MiB + 1 byte and refuses when the extra byte arrives. A demo run performs **no git call** and reads no repository and no data-directory file (it still checks, lists and writes its own log directory); demo rooms are never mixed with real rooms; the page shows `UI_VIZ_DEMO_BANNER` "Demo data — not your team" at all times.
- **Format `cowork-viz-demo/1`** (UTF-8 JSONL, LF, no BOM):

```
{"t":"header","format":"cowork-viz-demo/1","rooms":[{"room":"a","name":"shop-app","branch":"main"}]}
{"t":"commit","room":"a","height":0,
 "writer":"<32 hex>/<32 hex>/<seq>",
 "protocol":{"proto":1,"regionSpec":"<id>","budget":12,"G_s":5,"S_s":1.5},          (height 0 only)
 "code":{"changed":false,"seats":[],"base":null},
 "cs":[], "csPaths":{},
 "ops":["{\"id\":\"<op id>\",\"type\":\"caps\",…}","{\"id\":\"<op id>\",\"type\":\"join\",…}"]}
{"t":"commit","room":"a","height":1,
 "writer":"<32 hex>/<32 hex>/<seq>",
 "code":{"changed":true,"seats":["human"],"base":null},
 "cs":["<cs_id> state=closed seq=1 origin=human checks=skipped paths=2"],
 "csPaths":{"<cs_id>":["src/cart.ts","src/price.ts"]},
 "ops":[]}
{"t":"caption","room":"a","height":12,"code":"UI_VIZ_DEMO_CAPTION_3"}
{"t":"caption","room":"a","height":20,"text":"Two people, two PCs, only git in between."}
```

| Record | Field | Rule (strict: an unknown `t` or an unknown field is an invalid record) |
|---|---|---|
| `header` | `t`, `format` | `"header"`, `"cowork-viz-demo/1"`; the first line, exactly once |
| | `rooms` | 1–32 entries `{room, name, branch}`; `room` matches `^[a-z0-9]{1,8}$` and is unique; `name` (≤ 40) and `branch` (≤ 80) are served as the room label and branch, through the same validators and caps (§3.10.7); a demo room's id is `r` + `base32c(sha256(salt ‖ "demo:" ‖ room))[0:8]` |
| `commit` | `room`, `height` | a header room; per room the heights are 0, 1, 2, … in file order (records of different rooms may interleave) |
| | `writer` | the `parseWriter` form `<32 hex>/<32 hex>/<seq>`, or `null` for a commit whose `Cowork-Writer` is missing or malformed (every op a no-op, as on a board) |
| | `protocol` | required at height 0 and forbidden elsewhere: a `ProtocolJson` (`proto`, `regionSpec`, `budget`, `G_s`, `S_s`) |
| | `code` | `{changed: boolean, seats: string[], base: <40 or 64 hex> \| null}`: the `Cowork-Seat` values and `Cowork-Base` of the named live commit |
| | `cs` | the `Cowork-CS` trailer values, each accepted by the Plan 2 trailer parser (`parseCsTrailers`) |
| | `csPaths` | `cs_id → paths`: 1–256 paths per entry, each passing `validPathSyntax`, sorted, unique; every key names an entry of `cs`; a `cs` entry without a key is a change-set whose paths are not on the board (big table) |
| | `ops` | ≤ 1,000 strings, each ≤ 16 KiB, ≤ 64 KiB together (the board caps `OPS_MAX_*`): the `ops.jsonl` lines |
| | `held` | optional, default `[]`: the `held/<hold_id>/` entry names of the board tree (`heldIds`) |
| | `live` | (owner decision of 2026-10-08, real-time claims; Plan 4) optional, allowed only when `code.changed` is true: a 40 or 64 hex oid that stands as this draft's `liveCode` instead of the synthesized one (later unchanged records carry it), so that claim ops' `anchor` checks hold; the exporter writes it on every changed record of a board whose ops carry claims |
| | `claims` | (owner decision of 2026-10-08, real-time claims; Plan 4) optional, absent for a commit without `claim` ops: `{trees, pairs}` — `trees` ≤ 1,000 entries `[commit, path, entry]` (`commit` 40/64 hex, `path` passing `validPathSyntax`, `entry` a 40/64 hex blob oid or `"ABSENT"`); `pairs` ≤ 4,096 entries `[c1, c2, overlap]` (ids passing `validId`, `overlap` boolean). Answers only: no blob, line or file content is ever in a demo log |
| `caption` | `room`, `height` | a header room and a height that room's commits reach |
| | `code` or `text` | exactly one: a `code` matching `^UI_VIZ_DEMO_CAPTION_[0-9]{1,2}$` that the catalogs define, or a `text` of 1–120 characters |

- Each `commit` record becomes one `BoardDraft` and is folded by the same `foldCommit`: `writer` through `parseWriter`, `cs` through the Plan 2 trailer parser, `opsLines` = `ops`, `checkpoint` null, `heldIds` = `held`; `protocol` = the height-0 record's `protocol`, carried unchanged to every later draft (PRO-04: the board carries `protocol.json` by oid), so the fold reports no `protoMismatch` for a demo; `liveCode` = the hex `sha1("<room>:<height>:live")` at height 0 and whenever `code.changed`, else the previous draft's `liveCode` (the frame's `code.changed` is false at height 0 whatever the record says, §3.3.4); (owner decision of 2026-10-08) a changed record with `live` takes `live` as its `liveCode` instead, and every record is folded with `ClaimFoldInputs` answering `treeEntry` and `overlaps` from its `claims.trees` and `claims.pairs` (an empty table when it has no `claims`; a record is never folded without inputs, §3.3.3): a question the table does not answer gets `ABSENT` or `true`, so a claim the demo does not support folds invalid and is never drawn as valid. This is not a refusal, because demo rooms are folded after the ready line (§3.2 item 3); T-VIZ-demo-format checks that the bundled demo and every exported demo answer every question. `code` stands in for the live commit's trailers, and `code.shape` is `genesis` at height 0, `base_move` at a later height whose `base` is not null, else `ordinary`. The frame's transient `oid` is the hex `sha1("<room>:<height>:board")`; no oid reaches a seed or a timeline (§3.3.5), so a demo exported from a board gives that board's timeline byte for byte. Every op line passes the same `parseOpLine` schema and SEC-35 validators as on a real board. Heights per room start at 0 and are consecutive; a height-0 record without `protocol` is invalid. A `caption` carries a catalog `code` (bundled demo) or a `text` ≤ 120 characters (sanitized as a note) and is shown in the caption strip from its height for one beat. Any invalid record refuses the whole file (`RF_VIZ_DEMO_INVALID` with its line number).
- **Producing a demo log.** The dev tool `tools/viz/export-demo.ts` (never shipped; `node tools/viz/export-demo.ts --git-dir <abs> --ref <board ref> [--captions <file>] [--oplog <file>] --out <file>`) reads the whole board chain of a SIM run from height 0 (a peer's clone or the bare remote, in any namespace including `refs/cowork-ci/<run_id>/`) with the viewer's own batched readers, and writes one `commit` record per board commit (`held` from `heldIds`, `code` from the named live commit's trailers, and — owner decision of 2026-10-08, Plan 4 — `live` and `claims` from the live commit's oid and the answers the viewer's claim resolver gave that commit's fold: oids, paths and booleans, never content). Captions come only from `--captions <file>`, a JSONL file of `caption` records written by hand. A SIM op-log step has no board height (an op-log lists generated operations, not board commits, 11-testing §2), so `--oplog` only prints each op-log entry (`step peer kind detail`) beside the heights of the board commits its peer wrote, as an aid for writing captions; the exporter never places a caption by itself and never parses board data from the op-log (§1.5 item 8).
- **The bundled demo** is a hand-checked storyboard. Because demo logs are folded by the build's own fold, a storyboard op from a later plan (a claim, a request) shows only in a build whose fold has that plan's effects; the bundled demo uses only facts the build's fold applies, and grows with the plans. **Plan 2 storyboard** (the bundled demo of Plan 8a; one room `shop-app`, branch `main`, at most 120 heights, 3–5 captions, en only): the room opens; three people enter one after another; they publish human change-sets to at least six file desks in at least three zones (for example `src`, `test` and `·`), including two people at one desk (chair and visitor), one change-set with paper planes to two other desks and one change-set of more than 256 paths at the big table; one person is frozen (EPOCH) and thawed; one is slowed (`HOST_THROTTLED`) and later shows the host-refused "!"; one rejoins with a new epoch (respawn); a person who stops publishing turns to the relaxed pose 64 heights later. The **README storyboard** (once Plans 4–6 have landed): two people with pets labelled as on different PCs, sitting at file desks; (owner decision of 2026-10-08) a pet takes a claim chair between checkpoints (`claim_take`; its `live` and `claims` are written by `export-demo` from the storyboard's board, Plan 8b Task 13); one pet walks to the other's desk with a go-first bubble; a same-line "!"; a save with confetti.

#### 3.9.4 Export (recording)

- **Panel.** The record button opens a panel: source (the selected room live, a replay range, the demo, or (rev 2.5, F29) a highlight reel of a range, §3.9.6), format (WebM or GIF), anonymize (default **on** for real rooms; demo data needs none), and the length cap. Recording a real room with anonymize off first shows `UI_VIZ_RECORD_NOTICE` ("This recording will show your teammates' names, file names and notes."). (rev 2.5, F34: the postcard task revises this template in all six catalogs, code unchanged, to "With anonymize off, recordings and postcards show your teammates' names and file names; recordings also show their notes."; the revision is pending in §9.9 and lands with F34's code, because 8a's T-VIZ-i18n pins the current en wording.) (rev 2.5, F34) While an export panel (record or postcard, §3.9.5) is open, `Esc` closes only that panel (§3.11).
- **Recording canvas.** A fixed art viewport of 480 × 270 art pixels: the office's full width of 336 art pixels at x = 72 (the bands x 0–71 and 408–479 are wall `#22222C`), a camera window 224 art pixels tall (the lobby and one zone row) at y = 0, and the caption strip at y 224–269; drawn at 4× for WebM (1,920 × 1,080 device pixels) and at 2× for GIF (960 × 540), independent of the window size and DPR, so every machine produces the same art pixels (text glyphs may differ by OS, §3.7). When the office is taller than the viewport, the camera pans vertically only, toward the desk of the current beat's first event, at most one tile per 100 ms of recording time; in demo mode and (rev 2.5, F29) for a reel (§3.9.6) the camera path is computed from the timeline before recording starts. The canvas also draws a caption strip with the latest card text or demo caption; the map, the log and the local overlay are not recorded.
- **Clock.** Recording renders on its own virtual clock, never on `requestAnimationFrame` time: frame n shows the scene at t = n × 100 ms (GIF) or n × 1000/30 ms (WebM).
- **WebM.** `canvas.captureStream(0)` and one `requestFrame()` per frame, pushed by a 30 fps timer; `MediaRecorder` with the first supported of `video/webm;codecs=vp9` and `video/webm;codecs=vp8`; about 2 Mbps; at most 120 s; the panel shows the running size (`UI_VIZ_RECORD_SIZE`), since a GitHub README video must stay under 10 MB (about 40 s at this rate). When the tab becomes hidden (`visibilitychange`), the recording stops and saves what it has, with `UI_VIZ_RECORD_INTERRUPTED`, because MediaRecorder's clock keeps running while a hidden tab stops drawing. Without `MediaRecorder` or without either codec the WebM option is disabled with `UI_VIZ_RECORD_UNSUPPORTED`; GIF is still offered.
- **GIF.** An in-house GIF89a encoder (`src/viz/client/gif.ts`, LZW, no third-party code): 960 × 540, a fixed global palette of at most 256 entries (the sprite and environment palette, a 32-step text ramp, the chrome tones), per frame only the changed bounding box with a transparent index, 10 fps (delay 10 cs); pixels outside the palette map to the nearest entry through a cache. Frames are rendered off-screen on the virtual clock and encoded on the main thread in slices of at most 8 ms (no Worker, CSP `worker-src 'none'`), independent of `requestAnimationFrame` and of tab visibility. The file stops at 10 MB with `UI_VIZ_RECORD_CAP` (target ≤ 5 MB; GitHub accepts 10 MB).
- **Saving** (rev 2.5, F34, F29). The page saves through the one helper `client/save.ts` `saveBlob(blob, name)` (Blob, object URL, `<a download>`, URL revoked after the click), with the fixed name `cowork-view-<n>.webm` or `.gif`, or `cowork-reel-<n>.webm` or `.gif` for a highlight reel (§3.9.6) (no date, no room name); postcards use the same helper with `cowork-postcard-<n>.png` (§3.9.5). `<n>` is a per-page counter from 1. `saveBlob` requires `name` to match `^cowork-(view-[1-9][0-9]{0,3}\.(webm|gif)|postcard-[1-9][0-9]{0,3}\.png|reel-[1-9][0-9]{0,3}\.(webm|gif))$`; every other export feature that merges adds its own fixed alternative to this one pattern. Nothing leaves the page except the user's own download.
- **Anonymize** (a presentation transform of the recording canvas only): names → hue names (`UI_VIZ_ANON_NAME_*`, with the accessory name `UI_VIZ_ACC_*` when two share a hue), and no handle is drawn; paths, zone signs and plaques → `zone-<i>/file-<j>` keeping the zone structure; labels → `fn-<j>`; every teammate free-text field (`note.text`, `request.note`, `answer.note`, a demo caption's `text`, and any free-text field a later plan adds) → "…"; the room label and branch → `UI_VIZ_ANON_ROOM`. With anonymize on, no served name, handle, path, label, branch, room label or free-text string reaches the recording canvas, including through the caption strip. `local_only` stub paths never reach it, anonymized or not: a stub creates no desk, and a desk carrying a stub's lockbox shows a lock glyph instead of its plaque (§3.5.3). (rev 2.5, F34) Anonymize is one in-memory page state shared by the record and postcard panels, on at every page load for real rooms and never persisted. Two or more characters with the same hue and accessory get `UI_VIZ_ANON_NAME_NTH` "{name} {n}" by their `homeOrder` rank among the characters of that look.

#### 3.9.5 Postcard (still and text) (rev 2.5, F34)

At a stand-up, people want to drop "what the office looks like now" into the team chat. A **postcard** is one click in the viewer page: either a 960 × 540 PNG of the current scene, drawn on the fixed recording canvas of §3.9.4, or a short plain-text status in the page's language. The user copies it to the clipboard or saves it as a file. Both are anonymized by default with the recording's own transform. The postcard reads only what the page already holds: `SceneVM` reduced by the page's `reduceScene` (§3.13), `CharacterVM`, `PetVM`, `LayoutVM`, the look table, `RoomVM.label`, `RoomVM.branch` and `RoomVM.window.h1`, all served through the §3.10.6 allowlist and VIZ-36. It adds no route, view-model field, server code, git call, IPC, `status.json` read, board op or network use; a postcard is a pure function of one reduced scene (FEAT-F34-08).

##### Control and panel

- A **postcard** button (`UI_VIZ_CTRL_POSTCARD`) sits in the bottom bar after `UI_VIZ_CTRL_RECORD` and is reachable in the same Tab order (§3.11). It works in live mode, in replay and in demo mode, for the selected room.
- Clicking it takes a **snapshot**: the selected room's scene at the position currently shown (the live tip or the replay position), the layout, the look table, the character and pet tables, and the anonymize state. The panel then opens with:
  - a preview of the picture: a `<canvas>` with `role="img"` and `aria-label` = `UI_VIZ_SCENE_SUMMARY` of the snapshot;
  - a read-only `<textarea>` with the text summary (below);
  - the anonymize switch (below);
  - the buttons `UI_VIZ_POSTCARD_COPY_IMAGE` ("Copy picture"), `UI_VIZ_POSTCARD_SAVE_IMAGE` ("Save picture"), `UI_VIZ_POSTCARD_COPY_TEXT` ("Copy text") and `UI_VIZ_POSTCARD_RETAKE` ("Take again"). The last one takes a new snapshot.
- **What you see is what you paste.** Every output is made from the snapshot shown in the panel, never from a later scene. New beats do not change an open panel.
- **`Esc`.** While an export panel (record or postcard) is open, `Esc` closes only that panel. The §3.11 meaning of `Esc` (clear filters and end the selected room's follow, §3.8.1) applies only while no export panel is open.
- Results go to an `aria-live="polite"` status line: `UI_VIZ_POSTCARD_COPIED` ("Copied. Paste it into your chat."), or a failure code of "Copy and save" below.

##### The picture

- **Canvas.** The 480 × 270 art viewport of §3.9.4 (office width 336 at x = 72, wall bands `#22222C`, a 224-pixel camera window, the caption strip at y 224–269), drawn at **2×**, so the PNG is 960 × 540 on every machine and DPR. It is drawn by the same viewport composer as the recording ("Drawing" below), so the art pixels equal those of a recording frame of the same scene.
- **Camera (still).** The focus desk is the desk with the greatest `lastEvent` in `scene.desks`, ties broken by the lowest ordinal. The camera top is `max(0, min(focusY − 112, officeH − 224))` art pixels, where `focusY` is the art y of the centre of the focus desk's tiles (§3.5.2: a slot desk's two desk tiles; the big table's 4 × 2 tiles in the lobby, which always gives 0) and `officeH = 16 · (4 + 10 · ⌈cells / 3⌉)`. The outer `max` covers an office shorter than the 224-pixel window (no zone cell yet). With no focus desk, the top is 0 (the lobby).
- **Settled scene.** Every actor stands or sits at its `Place` (no walk in progress). Every state is drawn in its §3.7 **reduced-motion form**, at animation frame 0. States that last one beat or less are omitted: sparkles, paper planes, the event-sourced "!", puffs, confetti and icon-bubble pops. Every monitor screen is idle. **No bubble is drawn.** Persistent marks stay: hold-record "!", parcels, chair tags, badges, ghosts, ice, "zzz" and dashed future desks in replay.
- **Caption strip.** It shows the lines of the text summary that come before the first actor line, at most 3: the head, the demo or replay line (never both, "The text" item 2), and the scene summary. These lines go through the same anonymize transform. The strip never shows card text or a demo caption.
- **Never drawn:** the local overlay (the "you" marker, the own room's lamp, count chips, `down`), the map, the log and the rewind bar (VIZ-13, VIZ-29).

##### The text

The summary is plain UTF-8 text with LF line breaks, rendered by the shared `render(code, params, 'viz', lang)` in the page's current language (`L_h` or the switcher's choice). Items inside a line are joined with the catalog separator `UI_VIZ_POSTCARD_SEP` (en `", "`, ko `", "`, ja and zh-CN `"、"`, fr and es `", "`; drafts until I18N-08), so the client holds no separator literal (I18N-07) and the output does not depend on the browser's CLDR data. (`Intl.ListFormat` with `type: 'unit'` was rejected: it joins with no separator at all in zh-CN and with a bare space in ko and ja, and its output differs between Node's and each browser's ICU, which would break the byte-for-byte golden of T-F34-text.) The lines, in order:

1. The head. With anonymize off: `UI_VIZ_POSTCARD_HEAD` "{room} · {branch} · #{height}". With anonymize on: `UI_VIZ_POSTCARD_HEAD_ANON` "{room} · #{height}", where `{room}` is the rendered `UI_VIZ_ANON_ROOM`. The separator is `·` rather than `@` so that a branch named `here` or `everyone` cannot form a chat mention.
2. In demo mode only: `UI_VIZ_DEMO_BANNER`, at any position. For a real room in replay only: `UI_VIZ_POSTCARD_REPLAY` "replay of an earlier point; live is at #{height}" (the room's `RoomVM.window.h1`). A demo is never live, so a demo never gets the replay line and the two lines never appear together.
3. `UI_VIZ_SCENE_SUMMARY` of the snapshot (the alt text).
4. One line per actor that has at least one item (below): the characters that are not ghosts, in `homeOrder`, each followed by its pets in variant order:
   - a character: `UI_VIZ_POSTCARD_PERSON` "{name}: {items}";
   - a pet: `UI_VIZ_POSTCARD_PET` "{name}'s Claude: {items}", or `UI_VIZ_POSTCARD_PET_N` "{name}'s Claude {n}: {items}" when its owner has two or more pets in the snapshot (`n` = variant + 1).

   `{items}` lists, in this order, every item that applies:
   - the health label: for a character, `phOf(c, status, snapshot.at)` (Plan 8a `model/labels.ts`, ruling R-V56) evaluated **at the snapshot's position**, where the page takes `status` from the scene character (`'absent'` when its `absent` flag is set, else `'active'`; a peer that left is no longer in the scene), not `CharacterVM.ph`, which is computed at `h1` and would be wrong in replay; shown when it is not `PH_OK` or null. For a pet, its scene `ssCode` when it is not `SS_FULL` or null (a healthy seat adds no item, as a healthy person does);
   - the place label from `placeLabel`: `UI_VIZ_HOLDING` "holding {label}", or `UI_VIZ_POSTCARD_LAST_SHARED` "last shared {path}". The big table's path is null, so a publish there gives `UI_VIZ_POSTCARD_LAST_SHARED_BIG` "last shared a large change-set";
   - when the actor's place is `facing` (an open request it filed): `UI_VIZ_POSTCARD_WAITING` "waiting on {target} ({id})", where `{target}` is the holder's name and `{id}` the request's `R…` display id (glossary §3: `R` + 8 Crockford base32 characters).

   An actor with no item gets **no line**, whether character or pet. A postcard describes the room, not each person's output: a per-person "nothing shared" line would read as a productivity call-out once pasted into a team chat. The scene-summary line still counts everyone present. The rows are the rows of Plan 8a's hidden people list (`peopleList`, `ui/a11y.ts`) in the same order and with the same place labels, except that health comes from `phOf` at the snapshot's position and actors with no item are left out.
5. **Limits.** At most 12 actor lines. Beyond that, one `UI_VIZ_MORE` "+{n}" line, where `n` counts the actors **with a line** that were left out (actors with no item are not counted anywhere). Each line is capped at 400 characters (the `viz` card cap, §3.11; glossary §19 viewer row, §9.2); when a line would exceed it, the item list is cut and ends with `UI_VIZ_MORE`. `{items}` is the viewer-rendered list, declared as a `text` parameter (capped at the 400-character card cap without trimming whitespace, so the `_SEP` spaces survive); `postcardLines` itself cuts the list to 300 characters (ending with `UI_VIZ_MORE`) before rendering, so a line stays within 400. A summary therefore has at most 16 lines: the head, at most one demo-or-replay line, the scene summary, 12 actor lines and one "+n" line.

Example, en, anonymize off:

```
shop-app · main · #1234
3 people, 1 Claude sessions, 1 requests open, 0 conflicts
Mina: last shared src/cart.ts
Theo: last shared test/price.test.ts
Theo's Claude: holding applyDiscount, waiting on Mina (R7Q2K9MB)
Ana: paused (git outside cowork-sync)
```

The same snapshot in ko with anonymize on (the ko drafts await I18N-08 review; the health label is the 10-product §3.14 `PH_FROZEN` wording):

```
방 · #1234
사람 3명, Claude 세션 1개, 열린 요청 1개, 충돌 0개
살구: 마지막 공유 zone-1/file-1
하늘: 마지막 공유 zone-2/file-4
하늘의 Claude: fn-1 잡는 중, 살구 기다리는 중 (R7Q2K9MB)
초록: 일시중지(cowork-sync 밖의 git)
```

(If Ana had no health label and nothing at a desk, she would have no line; the summary line would still say "3 people". The "1 Claude sessions, 1 requests" wording is the Plan 8a `en` catalog's `UI_VIZ_SCENE_SUMMARY`, which has no plural forms yet; T-F34-text pins this example byte for byte, so its golden follows whatever plural fix that code gets.)

##### Anonymize and the notice

- **One switch per page.** The record panel and the postcard panel show the same `UI_VIZ_CTRL_ANONYMIZE` control, bound to one in-memory page state (§3.9.4 "Anonymize"). On every page load that state starts **on** for real rooms. It is never written to `localStorage`, `sessionStorage` or the fragment, so a reload or a new tab starts anonymized. In demo mode the control is hidden (demo data needs none, §3.9.4).
- **Notice.** While anonymize is off for a real room, every open record or postcard panel shows `UI_VIZ_RECORD_NOTICE` above its buttons, and in that state the postcard's Copy and Save buttons are enabled only once the notice is in the DOM and visible. With anonymize on (or in demo mode) no notice is needed and the buttons are enabled at once.
- **Same transform, one map per snapshot.** The image and the text use the same instance of the §3.9.4 transform, built once per snapshot. `file-3` in the text is therefore the `file-3` plaque in the picture. The rules: names become hue names; paths, zone signs and plaques become `zone-<i>/file-<j>`; labels become `fn-<j>`; the room and branch become `UI_VIZ_ANON_ROOM`; no handle is drawn; two or more characters that share both hue and accessory get `UI_VIZ_ANON_NAME_NTH` (§3.9.4, also for recordings). Display ids (`R…`, `C<cid>`) are kept: they are board hashes, carry no name or path, and let a reader run `/cowork show`.

##### Copy and save

- **Copy picture.** Inside the click handler, synchronously, the page calls `navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])`, where `png` is a Promise of the snapshot canvas's `toBlob('image/png')`. Passing a Promise keeps the call inside the user's activation, which Safari and Firefox require.
- **Copy text.** Inside the click handler, synchronously, the page calls `navigator.clipboard.writeText(text)` with the textarea's text.
- **Save picture.** The shared download helper `saveBlob` (§3.9.4 "Saving") saves the PNG as `cowork-postcard-<n>.png`. `<n>` is a per-page counter from 1. The name holds no date and no room name. The page adds no PNG metadata chunk (what the browser's own `toBlob` encoder writes is outside the page's control; T-F34-download pins the CI browser's output).
- **Unsupported.** "Copy picture" is disabled, with `UI_VIZ_POSTCARD_COPY_UNSUPPORTED` ("This browser cannot copy pictures. Use Save picture."), when any of these is missing: `window.isSecureContext`, `navigator.clipboard.write`, `ClipboardItem`, or (where `ClipboardItem.supports` exists) `supports('image/png')`. Copy text has the textarea as its fallback, which the user can select by hand.
- **Refused.** A rejected write shows `UI_VIZ_POSTCARD_COPY_FAILED` ("The browser did not allow copying. Use Save picture, or select the text below.") and is never retried automatically.
- **Never.** No clipboard read, no `paste` listener, no `document.execCommand`, no `navigator.permissions` query and no prompt. Nothing leaves the page except through the user's own clipboard write or download.

##### Drawing and browser contract

- **Drawing.** Plan 8a's layer rule (rulings R-V33 and R-V35: `ui/**` imports nothing from `render/**`; `render/**` may import `model/**` and `ui/**`) splits the work in three:
  - the pure `src/viz/ui/postcard.ts` provides `postcardCamera(scene, layout)` ("The picture") and `postcardLines(snapshot, anon, render, lang)` ("The text"), and imports nothing from `render/**`;
  - the pure `src/viz/render/viewport.ts` provides `stillPhase(scene, layout): SpritePhase`, the phase of "The picture" (`reduced: true`, every `frame(actor)` the first frame of the actor's reduced form, `tile(actor)` = `placeTile` of its `Place`, every `screen(desk)` `'idle'`), next to the Plan 8b viewport composer `composeViewport(static, sprites, cameraTop)` (bands, camera window and strip, shared with `record.ts`);
  - the browser-only `src/viz/client/postcard.ts` calls Plan 8a's `composeStatic` and `composeSprites` (`render/raster.ts`) with `stillPhase`, then `composeViewport`, then draws text with `fillText` at device resolution, as everywhere (§3.7).
- **Browser contract.** The viewer origin `http://127.0.0.1:<port>` is a potentially trustworthy origin (W3C Secure Contexts), so `navigator.clipboard` exists. The §3.10.4 `Permissions-Policy` denies `clipboard-read` and does not list `clipboard-write`, whose default allowlist `self` covers the top-level page. The page is never framed (`frame-ancestors 'none'`). The PNG preview is the canvas itself, because the CSP's `img-src 'self' data:` would block a `blob:` `<img>`. **No header changes**, so T-VIZ-headers is unchanged.

##### Privacy and safety

- **Never leaves this PC except by the user's click.** The page sends nothing anywhere. The only exits are the user's clipboard write and the user's download. The postcard is never posted to the board, a log, a file written by cowork or Claude's context. Once copied, the clipboard is the OS's: Windows clipboard history and cloud clipboard, or Apple's Universal Clipboard, may keep or sync a copy, and a web page cannot opt out of that. This is one more reason why anonymize starts on, and the notice covers it by saying what an un-anonymized postcard shows.
- **Never in a postcard (picture or text), whatever the anonymize state** (the never-list of FEAT-F34-05):
  - teammate free text (`note.text`, `request.note`, `answer.note`, demo caption `text`, any later free-text field). There are no bubbles in the picture and no note item in the text. This is stricter than recordings, because a chat paste travels further than a video file;
  - `local_only` stub paths: a desk with a stub's lockbox shows the lock glyph (§3.5.3);
  - the local overlay (VIZ-13);
  - the map and the log;
  - tokens, the viewer URL, `127.0.0.1`, the room id, absolute paths, e-mails, the OS user or host name;
  - wall-clock times. Order and labels are heights only (I18N-03, VIZ-11).
- **With anonymize on, also never:** a served name, handle, path, label, branch or room label, in the picture (including the strip) or the text (VIZ-29 extended).
- **Chat hardening (text only).** In every parameter value inserted into the text, `@` becomes U+FF20 `＠`. A name such as `@everyone` or `@here` therefore cannot ping a channel. (A path such as `src/@types/x.d.ts` is shown as `src/＠types/x.d.ts`; that is the price of covering every parameter.) `sanitize(…, 'viz')` has already removed URLs, controls and bidi characters, turned `<` and `>` into U+FF1C and U+FF1E (no `<!here>`), and stripped leading `/` commands. **Not covered:** chat apps may still auto-link a file name that looks like a domain (`README.md`, `setup.py`, `notes.zip`) and may re-format markdown characters (`*`, `_`, `` ` ``, `~`) in paths and names; with anonymize on (the default) paths are `zone-<i>/file-<j>` and cannot form a domain.
- **Clipboard rules.** The page writes only from a trusted click on a postcard button and only the snapshot shown. It never reads the clipboard (L-VIZ-DOM, §9.5).

#### 3.9.6 Highlight reel (rev 2.5, F29)

A team lead wants today's session — a go-first negotiation, a conflict that got untangled, a save with confetti — as a 20–40 s anonymous clip for team chat, a retro or a README GIF, with no editing. VD-1 already makes the viewer "a recordable replay/demo for promotion"; the highlight reel turns a height range into a short, chaptered recording with **one click** in the record panel. It is built only from scene events the page already receives or fetches as timeline pages (§3.3.7, §3.10.5), runs only in the page, and uses the existing recording pipeline (virtual clock, WebM/GIF, anonymize, caption strip). It adds no board op, route, server code, transport or stored state.

##### Control

The record panel (§3.9.4) gains the source **highlight reel** and the button `UI_VIZ_CTRL_REEL` ("Make reel" / "영상 만들기"). With every option at its default, one click on it plans the reel, renders it on the virtual clock and saves the file. Above the button the panel shows `UI_VIZ_REEL_SUMMARY` ("#{lo}–#{hi} · {n} highlights · {dur}", `{dur}` = the video's length as a `dur` param, "Texts" below) and the rendered chapter titles, recomputed whenever the range or an option changes; while it fetches timeline pages it shows `UI_VIZ_REEL_LOADING`. Options (reset on every page load, never persisted): range (the panel's replay-range inputs, prefilled by "Range" below), chapters `UI_VIZ_REEL_CHAPTERS` 1–8 (default **5**), length cap 20 / 30 / **40** / 60 s, format **GIF** (default) or WebM, anonymize (the record panel's own switch, default **on** for real rooms; demo data needs none), end card `UI_VIZ_REEL_END_TOGGLE` (default on).

##### Range

`[lo, hi]` heights of the selected room, frozen at the click (live extension during rendering changes nothing). Default, first rule that applies:

1. The selected room's catch-up panel (§3.8) has a resolved anchor height `a` (last visit, last save, since this view opened, or a typed height) → `[a + 1, h1]`, **if** `[max(a + 1, h0, h1 − 2,047), h1]` holds an eligible moment ("Chapters" below; the same probe as rule 2). Otherwise, or without a catch-up panel (no "you", demo), rule 2. (A short absence would otherwise give an empty reel by default.)
2. Let `s1` be the newest and `s2` the second-newest `save` tick (§3.10.6 `Tick`, glyph `save`) in the window. If `s1` exists and `[max(s1 + 1, h1 − 2,047), h1]` holds an eligible moment (the clip comes first, so this check fetches no more than the reel would) → `[s1 + 1, h1]` ("since the last save"). Else if `s1` exists → `[(s2 ?? h0 − 1) + 1, s1]` (the session that save closed, ending in its confetti).
3. Otherwise → `[max(h0, h1 − 255), h1]`. (Before Plan 7 no `save` is emitted, so rule 3 applies.)

Typed inputs match `^(0|[1-9][0-9]{0,9})$` (an input that does not match, or gives `lo > hi`, `lo < h0` or `hi > h1`, leaves `UI_VIZ_CTRL_REEL` disabled with no new message, as the replay-range inputs already behave); every range, default or typed, satisfies `h0 ≤ lo ≤ hi ≤ h1` of the window at the click (a rule-1 range is intersected with it; older history: "load earlier" first, so a reel never makes the server extend the window). A range longer than **2,048** heights (the server's retention, §3.3.3) keeps `hi` and raises `lo` to `hi − 2,047`, with `UI_VIZ_REEL_CLIPPED`.

##### Chapters

Moments come from `reelMoments` ("Reel moments" below), which groups the scene events of `[lo, hi]` by the closed table there. A moment is **eligible** when `complete` is true (a request whose answer other than `later` lies in the range, a hold-record conflict whose record reached a terminal state in the range, an event-sourced conflict (terminal at creation, §3.7), a freeze with its thaw; saves, joins and rejoins are single-beat and always complete). Selection, from the eligible moments of `[lo, hi]`:

1. **Kind order:** conflict → negotiation → save → freeze → arrival. **Within a kind:** more beats first, then earlier `start` position.
2. **Round-robin:** pass 1 takes the best remaining moment of each kind in kind order, pass 2 the next of each, …, until `N` chapters are chosen or none remain. A candidate whose height span `[beats[0], beats[last]]` intersects an already chosen chapter's span is skipped.
3. **Fit** (`totalMs ≤ cap`, "Steps and timing" below): while over the cap, drop the last-chosen chapter (its events fall into a gap, whose montage count grows); a dropped chapter is not replaced. One chapter always fits: ≤ 6,800 + 2 × 1,200 + 1,500 = 10,700 ms < 20 s, the smallest cap.
4. Chosen chapters play in ascending `start` order.

A **gap** is a maximal run of heights of `[lo, hi]` outside every chosen chapter's span `[beats[0], beats[last]]` (before the first chapter, between two, after the last). Heights inside a span that are not its beats are applied silently by the cut ("Steps and timing") and belong to no gap.

No eligible moment → `UI_VIZ_REEL_EMPTY` ("Nothing to highlight between #{lo} and #{hi}. Pick a longer range, or try the demo."); nothing is recorded.

##### Steps and timing

| Step | Duration | Shows |
|---|---|---|
| `intro` (one per chapter, "1-beat lead-in") | 2,000 ms | the scene at the last position of `beats[0] − 1` (when that height is a segment's `hs`, the segment's start scene, i.e. `TimelinePage.scene`; before height 0, the empty scene), reached by the 150 ms crossfade when it is not the scene already shown, then held still; the **title card** state (§3.7): the chapter title and `k/N` (3 × 5 digit sprites) in the caption strip, and a spotlight ring on the focus actor — for a **conflict** chapter on the desk of its first `conflict` event instead, and no ring when that desk is null ("Privacy and safety" item 7) |
| `beat` | 800 ms (the 1× replay beat) | one board height of the chapter: every event of that height animates as in replay; between non-consecutive heights the scene **cuts** (150 ms crossfade inside the step's 800 ms, skipped events applied silently) |
| `fold` | 800 ms | a chapter of more than 6 beats shows its first 3, one fold step `UI_VIZ_REEL_FOLD` ("… {n} more steps": a cut to the scene after the folded beats), then its last 2 |
| `montage` | 1,200 ms | at most one per gap ("Chapters") that contains ≥ 1 `publish`: the **montage** state (§3.7; the one state the catch-up Play montage beat also uses, §3.9.1) with `UI_VIZ_REEL_MONTAGE` ("+{n} shares") |
| `end` | 1,500 ms | `UI_VIZ_REEL_END` ("cowork-sync · {n} highlights") over the final scene; only with the end-card option |

Longest chapter = 2,000 + 6 × 800 = 6,800 ms. Every crossfade lies inside its step, so `totalMs` is the plain sum of the step durations. "Steps" are beats (board heights), never minutes (INV-CLOCK); `{dur}` in the summary is the video's own length, not a time on the board.

##### Texts

All six catalogs; English and Korean shown:

| Code | en | ko |
|---|---|---|
| `UI_VIZ_REEL_CH_CONFLICT` | A clash, untangled in {n} steps | {n}단계 만에 풀린 충돌 |
| `UI_VIZ_REEL_CH_REQUEST` | Go-first, settled in {n} steps | {n}단계로 정리된 go-first |
| `UI_VIZ_REEL_CH_HANDOFF` | A handoff in {n} steps | {n}단계로 끝난 넘겨주기 |
| `UI_VIZ_REEL_CH_SAVE` | {name} saves the team's work | {name}, 팀 작업 저장 |
| `UI_VIZ_REEL_CH_FREEZE` | {name} pauses, then picks up again | {name} 잠시 멈춤, 다시 출발 |
| `UI_VIZ_REEL_CH_JOIN` / `_REJOIN` | {name} joins / {name} is back | {name} 합류 / {name} 다시 합류 |
| `UI_VIZ_REEL_MONTAGE`, `_FOLD`, `_END` | +{n} shares · … {n} more steps · cowork-sync · {n} highlights | 공유 +{n} · … {n}단계 더 · cowork-sync · 하이라이트 {n}개 |
| `UI_VIZ_CTRL_REEL`, `UI_VIZ_REEL_CHAPTERS`, `_END_TOGGLE`, `_SUMMARY`, `_LOADING`, `_EMPTY`, `_CLIPPED` | Make reel · Highlights: {n} · End card · ("Control") · Gathering highlights… · ("Chapters") · Reels cover at most 2,048 heights; starting at #{lo}. | 영상 만들기 · 하이라이트 {n}개 · 끝 카드 · #{lo}–#{hi} · 하이라이트 {n}개 · {dur} · 하이라이트 모으는 중… · #{lo}–#{hi} 사이에 보여 줄 장면이 없습니다. 범위를 넓히거나 데모로 해 보세요. · 영상은 최대 2,048 높이까지; #{lo}부터 시작합니다. |

Chapter-title templates (`UI_VIZ_REEL_CH_*`) take **only** `{name}`, `{target}` and `{n}`: `{name}`/`{target}` are resolved by the page from the character table exactly like card placeholders (§3.3.7), so anonymize maps them to hue names; `{n}` is a count. Never `{id}` (display ids are not anonymized), `{path}` or `{label}` (their anonymized indices follow the per-viewer layout order), free text, the room label, the branch, a height or a duration. Each title renders in one line, ≤ **60** rendered characters at worst-case parameters (names 20, `n` = 999,999, I18N-07). Every template whose `{n}` counts a noun (highlights, steps, shares) carries its CLDR plural forms (I18N-03; "1 highlight", "+1 share"). `{lo}` and `{hi}` are `n` params; `{dur}` (summary only) is a `dur` param, which `render` formats with `UI_DUR_S`/`UI_DUR_MIN` (10-product §3.2, I18N-03) — no template hard-codes a unit such as "s" or "초".

##### Reel moments

```ts
// src/viz/model/reel.ts (with "The reel plan") — pure, compiled into the client (§3.13). Deliberately not named Moment/moments:
// those names and src/viz/model/moments.ts belong to the catch-up lanes (§3.9.1), which are relative to "you" and which a
// reel must not read ("Privacy and safety" item 5).
export type ReelKind = 'conflict' | 'negotiation' | 'save' | 'freeze' | 'arrival';
export interface ReelMoment {
  kind: ReelKind;
  sub: 'k4' | 'claim' | 'k7' | 'breach' | 'generic' | 'go_first' | 'handoff' | 'join' | 'rejoin' | null;
  start: Position; end: Position;       // its first and last own scene event
  beats: number[];                      // ascending distinct heights of its own events, ≥ 1 entry
  complete: boolean;                    // by the table below; single-beat kinds: true
  actors: ActorRef[];                   // focus actor first, target second when any (table below)
}
export function reelMoments(events: readonly SceneEvent[], lo: number, hi: number): ReelMoment[];   // ascending start; ids compared only for equality
// page layer (src/viz/ui/**, not pure): the selected room's catch-up anchor height (§3.8), else null
export function catchUpAnchor(roomId: string): number | null;
```

**Grouping (closed; §3.4 kinds and §3.3.7 fields only).** A moment is opened by an event of its first column at a position in `[lo, hi]`; events before `lo` open nothing and events after `hi` are never read, so `complete` depends on `[lo, hi]` alone. Each event belongs to at most one moment.

| `kind` (`sub`) | Opened by | Own events | `complete` when | `actors` (focus, target) |
|---|---|---|---|---|
| `conflict` (`conflict.conflict`) | `conflict` | it and, when `source = 'hold'`, every later `box` with the same `holdId`, up to the first with `terminal: true` | `source = 'event'`, or that terminal `box` is in the range | `on`; then `line.actor` when the line names an actor |
| `negotiation` (`requestKind`) | `request_open` | it and every later `request_status` and `answer` with the same `request`, up to the first `answer` whose `verb` is not `later` | that answer is in the range (a `returned` or `undeliverable` request never settles) | `from`, `holder` |
| `save` (`null`) | `save` | itself | always | `peer` |
| `freeze` (`null`) | `person_freeze` | it and the next `person_thaw` of the same `peer` | that thaw is in the range | `peer` |
| `arrival` (`join` / `rejoin`) | `person_enter` / `person_respawn` | itself | always | `peer` |

Every other kind (publishes, claims, notes, badges, ghosts, …) opens no moment; publishes feed only the montage counts. Before Plan 3 only `arrival` and `freeze` moments can occur on a real board (§3.4 "What each plan adds"); the unit tests use synthetic events of every kind, which the Plan 8a model types already declare.

##### The reel plan

```ts
// src/viz/model/reel.ts — pure: no I/O, clock, randomness, Node or DOM import; compiled into the client like scene.ts
export interface ReelOptions { chapters: number; capMs: 20000 | 30000 | 40000 | 60000; endCard: boolean; }
export type ReelStep =
  | { step: 'intro'; chapter: number; of: number; code: string; name: ActorRef | null; target: ActorRef | null; n: number; at: Position }
  | { step: 'beat'; chapter: number; height: number }
  | { step: 'fold'; chapter: number; n: number; to: Position }
  | { step: 'montage'; from: number; to: number; n: number }      // n = publish events in the gap
  | { step: 'end'; n: number };
export interface ReelPlan { v: 1; lo: number; hi: number; steps: ReelStep[]; totalMs: number; }
export function planReel(events: readonly SceneEvent[], m: readonly ReelMoment[], lo: number, hi: number, o: ReelOptions): ReelPlan | { empty: true };
export function reelRange(ticks: readonly Tick[], h0: number, h1: number, anchor: number | null,      // anchor: catchUpAnchor(), "Range" rule 1
                          eligibleAfter: (lo: number) => boolean): { lo: number; hi: number; clipped: boolean };   // eligibleAfter(x): [x, h1] holds an eligible moment
export function reelCamera(p: ReelPlan, layout: Layout, sceneAt: (pos: Position) => Scene): number[];   // camera top tile per step
export function serializeReelPlan(p: ReelPlan): string;   // canonicalJson, as §3.3.5 "Serialization"
```

`planReel` reads only scene-event kinds, positions, `publish` counts and the moments; it never reads a desk ordinal, a layout, an id's value (only equality, as `reduceScene`, §3.13), the language, the anonymize flag, the overlay, `self` or `seed`.

##### Data path, rendering, output

- **Events:** the page fetches the heights of `[lo, hi]` it does not hold through the existing `GET /api/v1/rooms/<room id>/timeline` route (≤ 256 heights per page, never across a segment start, so ≤ **9** requests for one range of ≤ 2,048 heights), reusing the seek cache of §3.9.1; a height the page already holds is never fetched again. Choosing the default range probes at most two stretches of ≤ 2,048 heights (the one ending at `h1`, and for the rule-2 fallback the one ending at `s1`), so ≤ **18** pages; the panel preview and the click then reuse those pages. Fetched pages are kept only until the reel is saved or the panel closes, outside the 2,000-card store of §3.8. No new route, parameter, server code, stream event or log line; the server cannot tell a reel from a seek.
- **Scenes:** every step's scene comes from the page's `reduceScene` (§3.3.5) at the step's position; reel steps never enter the timeline. Board facts are shown exactly as in replay (VIZ-26); the title card (reel only) and the montage state (reel montage steps, and the catch-up Play montage beat, §3.9.1: one §3.7 row, one visual, ≤ 12 desks) are render states of §3.7, **not** scene-event kinds, so the closed set of §3.4, VIZ-10 and the goldens are unchanged.
- **Camera:** `reelCamera` computes the whole path before frame 0, as demo mode does (§3.9.4); at frame 0 the camera stands at the first step's target. Target of a step: the desk of its first event that has one (intro: of its chapter's first beat; montage: the gap's most-published desk, then lowest ordinal; end, or no event with a desk, e.g. an arrival: unchanged); vertical only, ≤ 1 tile per 100 ms; at the first frame of an `intro` step whose target is more than 20 tiles away (what 2,000 ms can pan) the camera **cuts** once, under the 150 ms crossfade.
- **Output:** the §3.9.4 pipeline unchanged — the 480 × 270 art viewport, the virtual clock, WebM (`MediaRecorder`, VP9/VP8, ≈ 2 Mbps) or the in-house GIF encoder (960 × 540, 10 fps, stop at 10 MB with `UI_VIZ_RECORD_CAP`), the caption strip (titles during `intro`, the latest card text during `beat`, montage/fold/end texts during theirs). Saved through `saveBlob` as `cowork-reel-<n>.gif|.webm` (`n` = a per-page counter from 1, at most 4 digits as the §3.9.4 name check requires; no date, no room name); this is the one change to the pipeline (§3.9.4 "Saving").

##### Determinism scope

For the same range, every PC computes the byte-identical `ReelPlan` (chapters, order, titles' codes and counts, step timing), whatever the viewer's window, layout, language or anonymize setting. (The *default* range may differ between PCs, because rule 1 starts at this PC's catch-up anchor; a typed range does not.) The **picture** is identical only when the layouts are (INV-VIZ-DET pins layout to the initial window and extension order; teammates who opened `/cowork view` at different times may have different desk positions). Rendered titles are identical for the same language and anonymize setting, because they carry only names and counts.

##### Privacy and safety

1. **Nothing leaves the PC** except the file the user saves. No request beyond timeline pages, no write by the viewer, no board op, no IPC, no log line, no `localStorage`/`sessionStorage` key, no telemetry; teammates are not notified that a reel was made.
2. **Only on a click.** A reel is never made automatically, on a timer, on a stream event or by the server; there is no reel without `UI_VIZ_CTRL_REEL`.
3. **Inherited from VIZ-29:** anonymize defaults **on** for real rooms; turning it off shows `UI_VIZ_RECORD_NOTICE` before frame 0; with it on, no served name, handle, path, label, branch, room label or teammate free-text string reaches the recording canvas (free text → "…"); `local_only` stub paths never, anonymized or not; the map, the log and the local overlay are never recorded.
4. **Reel-only text is closed:** title, fold, montage, end and summary texts are catalog templates with the "Texts" placeholders only. Teammate free text (notes, request and answer notes, demo caption `text`) never reaches a reel-only text, even with anonymize off; with anonymize off it appears only where replay already shows it (bubbles, the caption strip's card text).
5. **The recorder stays anonymous:** `reelMoments` and `planReel` take no overlay, `self` or "you" input (this is why the catch-up lanes of §3.9.1 are not used), and the "you" marker is overlay (never recorded), so a reel does not reveal whose PC made it. The default range may start at this PC's catch-up anchor ("Range" rule 1), but no height, range or anchor is drawn in the recording.
6. **Brand:** the end card says "cowork-sync" only; no Anthropic or Claude mark (VIZ-20).
7. **No blame framing.** Conflict and negotiation titles carry no `{name}`, and a conflict chapter's spotlight ring is on the conflict's desk, never on an actor. The record owner of a K4 is the side whose change was held, and no winner is on the board (§1.5 item 1); looks are stable per `peer_id` (VIZ-18), so teammates would recognise a ringed blob even in an anonymized reel posted to team chat, and conflicts are ranked first. Rings on an actor are kept only where the person is the point of the chapter (save, freeze, arrival) or neutral (a negotiation's requester), in the spirit of VIZ-17's `phrasing-blame` rule.

### 3.10 Local HTTP server, API and security

#### 3.10.1 Listener

`server.listen({ host: '127.0.0.1', port: 0, exclusive: true })`; after `listening`, `server.address()` MUST be `{ address: '127.0.0.1', family: 'IPv4' }`, else close and refuse `RF_VIZ_BIND_FAILED`. Never `localhost`, `0.0.0.0`, `::` or a LAN address; no IPv6 in v1; no fixed or user-chosen port. HTTP/1.1 only: `upgrade` and `connect` events destroy the socket; absolute-form request targets get 400. The viewer opens no outbound socket and resolves no name; it needs no proxy setting.

#### 3.10.2 Tokens

- **Launch token**: 32 bytes from the Random port (CSPRNG in release), lowercase hex. It travels only viewer → CLI over the stdout pipe → opener argv as the URL fragment `#k=<hex>`. The fragment never appears in an HTTP request, a `Referer` or a server log.
- **Redemption**: the shell page's script reads `location.hash`, removes it at once with `history.replaceState(null, '', '/')` (the URL bar and any screen recording show a clean URL), then sends `POST /api/v1/session` with header `X-Cowork-Launch: <hex>` and an empty body. The launch token is single use and valid for 120 s (own staleness, §3.2 item 5). The answer is `{"session":"<64 hex>","instance":"<8 base32>"}`. Single use matters because the opener's argv can be visible to other local users (on Linux `/proc/<pid>/cmdline` is world-readable by default, and a freshly started browser keeps the URL in its own command line).
- **Reuse ends the viewer.** A presentation of a launch token that was already redeemed means two parties hold it, and the viewer cannot tell which one is the user. It therefore revokes the session minted from it, sends `bye` on every open stream, logs `SEC_VIZ_LAUNCH_REUSED` and exits (`VIZ_EXIT_LAUNCH_REUSED`). The presenting page shows `UI_VIZ_LINK_REUSED` ("This link was opened twice, so the viewer stopped. If you did not open it twice, another program or user on this PC may have opened it. Run /cowork view again."), and every other open page shows `UI_VIZ_STOPPED`. A thief who wins the race thus holds the session only until the user's own redemption, and the user learns of it. A local user who can read the link could already deny the viewer by redeeming it first, so this adds no new denial of service. A token presented after its TTL, while the viewer is exiting, gets 401 with `UI_VIZ_LINK_EXPIRED` ("This link has expired. Run /cowork view again.") and `SEC_VIZ_LAUNCH_EXPIRED`.
- **Session token**: 32 bytes from the Random port; sent as `X-Cowork-Session` on every `/api/v1/*` request except redemption; kept by the page in memory and `sessionStorage` (per origin, gone with the tab) and nowhere else — never `localStorage`, IndexedDB, a cookie, a URL or a `postMessage`. A custom header is not CORS-safelisted, so a cross-origin script would need a preflight this server never grants.
- **Comparison**: the header must match `^[0-9a-f]{64}$`; then `crypto.timingSafeEqual(sha256(presented), sha256(expected))` (the SEC-22 primitive).
- **No cookies, ever**: cookies for `127.0.0.1` are sent to every port of that host, so another local server would receive them, and they would reopen CSRF. The server never sends `Set-Cookie`, `WWW-Authenticate` or any `Access-Control-*` header.
- A bad or missing session → 401 with body `{"code":"UI_VIZ_NEED_LINK"}`, counted `SEC_VIZ_BAD_TOKEN`; no lockout (a hostile local user must not be able to deny service).

#### 3.10.3 Request admission (in this order, before routing; failures never echo request data)

1. `Host` MUST be byte-equal to `127.0.0.1:<port>`; anything else (absent, `localhost:<port>`, `[::1]:<port>`, `0.0.0.0:<port>`, no port, a trailing dot, userinfo) → 421 with `UI_VIZ_BAD_HOST`, counted `SEC_VIZ_BAD_HOST`. This defeats DNS rebinding (the attacker's name is in `Host`) and the browser route of `0.0.0.0` to loopback services.
2. `Origin`, when present, MUST equal the viewer origin, and on `POST /api/v1/session` it MUST be present → else 403, `SEC_VIZ_BAD_ORIGIN`.
3. `Sec-Fetch-Site`, when present: `same-origin` for `/api/*`; `none` or `same-origin` for `/` and the static assets (`/app.js`, `/app.css`, `/favicon.ico`); anything else → 403.
4. Method: GET and HEAD; POST only on `/api/v1/session`; everything else (including `OPTIONS` and Private Network Access preflights) → 405 without any `Access-Control-*` header, `SEC_VIZ_METHOD`.
5. Limits: request line and headers ≤ 8 KiB, URL ≤ 2 KiB, `headersTimeout` 5 s, `requestTimeout` 10 s, `keepAliveTimeout` 5 s, at most 32 connections, a body only on the session POST and ≤ 256 bytes, `insecureHTTPParser` off → else 400/408/413/431, `SEC_VIZ_LIMIT`.
6. The remote address MUST be in `127.0.0.0/8` (defence in depth; the bind already guarantees it).

#### 3.10.4 Response headers (every response)

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'self'; font-src 'none'; media-src 'none'; worker-src 'none'; manifest-src 'none';
  object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';
  require-trusted-types-for 'script'; trusted-types 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Origin-Agent-Cluster: ?1
Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), clipboard-read=(), payment=()
X-DNS-Prefetch-Control: off
Cache-Control: no-store
Content-Type: <exact type>; charset=utf-8
```

No inline `<script>` or `<style>`: the shell links `/app.js` and `/app.css`. Never `upgrade-insecure-requests` (it would rewrite the page's own `http://127.0.0.1` requests). No `Server`, `X-Powered-By`, `ETag` or `Last-Modified`. JSON is `application/json; charset=utf-8` with `<`, `>`, `&`, U+2028 and U+2029 escaped as `\u` sequences; no JSONP. Error bodies are `{"code":"<registry code>"}` (API) or one rendered sentence (shell); never the path, query, headers or a stack (internal errors: 500 `{"code":"UI_INTERNAL_ERROR"}`; the log gets the stack frames only as `{fn, line, col}` tuples with the file reduced to its basename, never `err.message` or `err.stack` text, which carry absolute paths). The `Content-Security-Policy` value is one header line: the directives exactly as listed above and in that order, separated by `; ` (one space) with no trailing `;`. The line breaks above are typographic only.

#### 3.10.5 Routes

| Route | Method | Auth | Returns |
|---|---|---|---|
| `/` | GET, HEAD | none | the static shell (no data); links `/app.js`, `/app.css` |
| `/app.js`, `/app.css` | GET, HEAD | none | bundled client assets from memory |
| `/favicon.ico` | GET, HEAD | none | 204 |
| `/api/v1/session` | POST | `X-Cowork-Launch` | `{session, instance}`, once |
| `/api/v1/strings?lang=<code>` | GET | session | the viewer subset (`UI_VIZ_*`, `PH_*`, `SS_*`, `UI_DUR_*`) of one of the six human catalogs (default `L_h`), and the resolved default `lang`; the language switcher fetches each language once |
| `/api/v1/world` | GET | session | `World` (§3.10.6): the rooms (view model), and per room the window `[h0, h1]`, layout, look table, characters and pets, the scene at `h1`, the overlay, the last ≤ 200 cards and the rewind-bar ticks of the whole window; `cursor` = the sequence number of the last stream event it includes |
| `/api/v1/rooms/<room id>/timeline?from=<h>&to=<h>` | GET | session | `TimelinePage` (§3.10.6): the scene the page's events reduce from, and the scene events and cards of heights `[from, to]`, ≤ 256 heights per page and never across a segment start (the server clips `to` to the next segment's `hs`); a range below `h0` extends the window downward by whole segments of 256 heights, and a range the server no longer retains (§3.3.3) is re-folded, both from the checkpoint ≤ `from`; desks first touched below `h0` are appended to the layout (§3.5.3) and also announced on the stream |
| `/api/v1/stream` | GET | session | `text/event-stream`, one JSON payload per message (§3.10.6 `StreamPayload`): `timeline` (new scene events and cards of one room), `room_snapshot` (one room's scene at its new tip and its last 200 cards, after a tick that revealed more than 64 commits, §3.9.2), `layout` (desks, cells and home-spot entries appended to one room's layout, sent before the `timeline` message that first uses them), `overlay` (own-room light changes), `room` (a room appended, greyed out or changed state), `reset` (the page must reload `/api/v1/world`), `bye` (the viewer is stopping); a comment line every 15 s |
| anything else | any | — | 404 `{"code":"UI_VIZ_NOT_FOUND"}` |

`<room id>` must match `^r[0-9A-HJKMNP-TV-Z]{8}$` (the upper-case Crockford alphabet of the shared `base32c`, §2) and be a key of the room map; heights must match `^(0|[1-9][0-9]{0,9})$` and be in range; `lang` must be one of the six codes. **No parameter ever names a file, gitdir, ref, oid or path.** Static assets come from an in-memory map, so path traversal is impossible by construction. No route writes anything, starts a fetch or contacts a daemon. The world snapshot is recomputed at most once per 2.5 s whatever the number of tabs.

**Stream ids and resume.** Every stream event carries an `id:` that is a per-process sequence number (decimal, from 1, shared by all rooms and kinds), and every SSE message is at most 64 KiB (a tick's events are split across messages). The server keeps the last 4,096 events or the last 10 min of them (Δmono), whichever is less. The page sends `Last-Event-ID` on every stream request: the world's `cursor` the first time, then the last id it received. The value MUST match `^(0|[1-9][0-9]{0,15})$` and be at most the current sequence number. When it does and the ring holds every event after it (or there is none yet), the server first sends those events of every kind, then continues live; otherwise (absent, malformed, larger than the current number, or older than the ring) it sends one `reset`, and the page reloads `/api/v1/world`. The header value is never echoed or logged.

The page reads the stream with `fetch` and a `ReadableStream` reader, parsing `text/event-stream` itself, because `EventSource` cannot send the session header and would force the token into a URL or a cookie. On a broken stream it greys the live pill, shows `UI_VIZ_RECONNECTING` and retries with `Last-Event-ID` after 1 s, doubling to 30 s; when a retry at 30 s fails, it reloads `/api/v1/world`, and when that fails too, it shows `UI_VIZ_STOPPED`.

#### 3.10.6 View model (allowlist)

Everything not listed is not served.

- **Room**: `room_id`, `label` (sanitized, ≤ 40), `branch` (decoded `enc(b)`, sanitized, ≤ 80), window `[h0, h1]`, (rev 2.5, F04-b; absent until F04-b merges) `open_h` (the `h1` of the room's first fold in this viewer process, the height that "before this view opened" and the catch-up panel's anchors use, §3.8), badges (codes), `unknown` counts, `gone` flag; overlay for this PC: `state` code, `freeze_reasons` codes, `publish_pause` code, `down` and `unreadable` flags, the offline age in whole minutes, the three counts, the "you" handle.
- **Character**: `handle`, `name` (§3.6 name tag), look indices, `PH_*` code, plugin version string (sanitized, ≤ 20), badges (codes).
- **Pet**: an opaque seat handle (`base32c(sha256(seat key))[0:6]`), owner handle, `live|ended`, `SS_*` code when known, variant index.
- **Scene events, scenes and cards**: kind, position `(height, sub, k)`, actor and target handles, desk ordinals, `path` (only after `validPathSyntax`, sanitized, ≤ 80), `label` (`validLabel` else `?`), codes (`reason_code`, status, verb), counts, display ids (including a hold or claim id's first 8 characters), `seed`, `seen_ms` (live cards only, §3.8); notes (Plan 6) as sanitized, re-scanned text ≤ 280 with the actor handle and target id; rewind-bar ticks (height and glyph).
- **Layout**: zones (index, sign text sanitized, grid cells), desks (ordinal, kind, zone, cell, slot, plaque text, full path, a `local_only`-lockbox flag), the home-spot order (handles), the layout version.
- **World**: the stream `cursor`, a `demo` flag and, in demo mode, the captions (code, or sanitized text ≤ 120, with their room and height).

```ts
// src/viz/server/viewModel.ts — every served JSON shape; field names are the wire names
type Handle = string;                 // ^[0-9a-f]{6}$ — a peer
type SeatHandle = string;             // ^[0-9A-HJKMNP-TV-Z]{6}$ — base32c(sha256(seat key))[0:6]
type ActorVM = { peer: Handle } | { seat: SeatHandle };
type Pos = [height: number, sub: number, k: number];
// Projection rule: an EventVM, SceneVM or CardVM is the §3.3.7 SceneEvent, Scene or Card with every PeerRef replaced by its
// handle, every SeatRef by its seat handle, every hold and claim id by its first 8 characters, Position by Pos, Maps by
// [key, value] arrays in ascending key order, and every string through §3.10.7; nothing else is added or renamed.
type EventVM = Projected<SceneEvent>;  type SceneVM = Projected<Scene>;  type CardVM = Projected<Card> & { seen_ms: number | null };
interface Session { session: string; instance: string; }                          // POST /api/v1/session
interface Strings { lang: 'en' | 'ko' | 'zh-CN' | 'ja' | 'fr' | 'es'; templates: Record<string, string>; }   // code → template
interface World { v: 1; cursor: number; demo: boolean; rooms: RoomVM[]; captions: CaptionVM[]; }
interface RoomVM {
  room_id: string; label: string; branch: string; gone: boolean; badges: string[]; unknown: number;
  window: { h0: number; h1: number };
  open_h?: number;                    // (rev 2.5, F04-b) h1 of the room's first fold in this viewer process (§3.8);
                                      // served only once F04-b merges (absent in 8a)
  overlay: OverlayVM | null;          // null in demo mode
  layout: LayoutVM; looks: Array<[Handle, { hue: number; accessory: number }]>;
  characters: CharacterVM[]; pets: PetVM[];
  scene: SceneVM;                     // at the last position of h1
  cards: CardVM[];                    // the last ≤ 200, ascending
  ticks: Tick[];                      // the whole window, ascending
}
interface OverlayVM { state: string; freeze_reasons: string[]; publish_pause: string | null; down: boolean; unreadable: boolean;
                      offline_min: number | null; holds: number; incoming: number; ready: number; you: Handle | null; }
interface CharacterVM { handle: Handle; name: string; hue: number; accessory: number; ph: string | null; version: string; badges: string[]; }
interface PetVM { seat: SeatHandle; owner: Handle; live: boolean; ss: string | null; variant: number; }
interface LayoutVM { version: number; zones: Array<{ index: number; sign: string; cells: number[] }>;
                     desks: Array<{ ordinal: number; kind: 'big_table' | 'file' | 'folder' | 'shelf'; zone: number | null; cell: number | null;
                                    slot: number | null; plaque: string | null; path: string | null; lockbox: boolean }>;
                     homeOrder: Handle[]; }   // plaque: a file desk's basename (≤ 16, middle ellipsis) or a folder desk's folder;
                                              // null for the shelf and the big table, which the page labels from their templates
interface LayoutDeltaVM { from_version: number; version: number;
                          zones: LayoutVM['zones'];   // new zones, and zones whose cells grew
                          desks: LayoutVM['desks'];   // new desks only (desks never change)
                          homeOrder: Handle[]; }      // new home-spot entries only
interface Tick { h: number; glyph: 'publish' | 'conflict' | 'request' | 'save' | 'door' | 'freeze'; }
interface CaptionVM { room_id: string; height: number; code: string | null; text: string | null; }
interface TimelinePage { room_id: string; from: number; to: number;   // to as clipped
                         scene: SceneVM;   // the segment's start scene when from − 1 is its hs, else the scene at the last position of from − 1
                         events: EventVM[]; cards: CardVM[]; layout: LayoutDeltaVM | null; }   // layout: when this page appended desks
type StreamPayload =                    // the SSE `event:` name is `type`; `data:` is the JSON object
  | { type: 'timeline'; room_id: string; h1: number; events: EventVM[]; cards: CardVM[]; ticks: Tick[];
      characters: CharacterVM[]; pets: PetVM[] }          // characters and pets: new or changed ones only
  | { type: 'room_snapshot'; room_id: string; window: { h0: number; h1: number }; scene: SceneVM; cards: CardVM[]; ticks: Tick[];
      characters: CharacterVM[]; pets: PetVM[] }
  | { type: 'layout'; room_id: string; layout: LayoutDeltaVM }
  | { type: 'overlay'; room_id: string; overlay: OverlayVM }
  | { type: 'room'; room_id: string; change: 'added' | 'gone' | 'state'; label: string; branch: string; gone: boolean; badges: string[]; unknown: number }
  | { type: 'reset' } | { type: 'bye' };
```

A `timeline` message that would exceed 64 KiB is split between events (never inside one) into several messages, each with its own id; the page applies them in id order. A `room_snapshot` keeps as many of the newest of its 200 cards as fit in 64 KiB; a `layout` delta or a `room_snapshot` scene that alone would exceed 64 KiB is sent as one `reset` instead, and the page reloads `/api/v1/world`, which has no message cap. A `layout` delta whose `from_version` is not the page's version also makes the page reload the world. On `room` with `change: 'added'` the page reloads `/api/v1/world`. `Projected` is the projection rule above, written out as types in that file; T-VIZ-api checks every response and stream payload against JSON Schemas generated from these types at test time (nothing is added to `dist/`).

**Never served**, even when on the board: raw `ops.jsonl` lines or a raw `FoldState`; any blob content, diff or 3-way view (the viewer is not `/cowork show`); `join.coauthor_optin` (a name and an **e-mail**), `config_fingerprint`, `plugin_sha`; commit author or committer e-mails; absolute paths (gitdir, worktree, plugin root, data directory); the OS user name or host name as values the viewer obtains from this PC (`os.userInfo()`, `os.hostname()`, absolute paths, the environment) — a board `display` name, room label or branch that happens to equal one is not this item (SEC-09 exempts `display`); the pinned remote URL or its host; `status.json` `message_params` and `not_converged`; any token or salt except the one redemption response; environment values; wall-clock fields.

#### 3.10.7 Untrusted text

Every string from the board, a commit message, a path, a folder or branch name, a demo log or `status.json` is untrusted data.

- **Server, before serialization:** (1) the SEC-35 validators (a record failing `validPath`/`validId` is already a fold no-op; names through `validName`, labels through `validLabel`, paths through `validPathSyntax`); (2) `sanitize(text, 'viz')` (§3.11); (3) every free-text string (notes, request and answer notes, names, labels, demo captions) through `scanSecrets` with the built-in D2 patterns; a hit replaces the whole string with `[redacted: secret-scan]` and logs `SEC_SECRET_REDACTED` (carrier kind `viz`, detector only). The writer already scanned its notes, but a non-conforming or forged peer may not have, and this page is meant to be recorded. D1 (daemon memory) and D3 (team patterns, a blob read) are not available to the viewer by design. The scanner is Plan 7 work, so step (3) arrives with Plan 8b; a Plan 8a build is a development milestone and is never released (§9.1).
- **Client:** text reaches the DOM only through `textContent`, `createTextNode` or an input's `.value`, and the canvas only through `fillText`. No element is created from a tag name taken from data; data never selects a CSS class outside a fixed enum map; colours come from palette indices. Lint `L-VIZ-DOM` (§9.5) enforces the sink list.
- **Keys, server and client:** every table keyed by a board-derived string (paths, zones, desk keys, `cs_id`, labels, names, handles, seat keys) is a `Map` or an `Object.create(null)` object, so a path such as `__proto__/a.ts`, which `validPathSyntax` admits, cannot reach an object prototype.

#### 3.10.8 Opening the browser

The URL is built only from the integer port and the hex token, re-validated against the §3.2 regex immediately before the spawn. The opener runs without a shell, with an argv array, `windowsHide: true`, `detached: true`, `stdio: 'ignore'`, a 5 s timeout, cwd = the data directory, the §3.4 builder environment plus the opener display set (§9.3), and an **absolute executable path** (on Windows a bare name is looked up in the current directory first, so a repository-committed `explorer.exe` must never be reachable). Never `cmd.exe /c start`, a `.cmd` or `.bat`, or PowerShell with the URL in command text. Repository-controlled programs are never executed (INV-NOEXEC): live sync can put a teammate's file into any worktree at any time.

| OS | argv | Notes |
|---|---|---|
| Windows | `%SystemRoot%\explorer.exe <url>` | `SystemRoot` must be an absolute existing directory; explorer exits 1 even on success, so only a spawn error counts as failure |
| macOS | `/usr/bin/open <url>` | the URL starts with `http`, so it can never be read as an option |
| Linux, BSD, WSL | the first existing of `/usr/bin/xdg-open`, `/usr/local/bin/xdg-open`, `/bin/xdg-open`, `/usr/bin/gio` (as `gio open <url>`); only when none exists, `xdg-open` resolved from the filtered `PATH` below | needs `DISPLAY` or `WAYLAND_DISPLAY`; without one, the open is treated as failed |

**Linux opener hardening.** The filtered `PATH` drops empty, `.` and relative entries and every entry inside the CLI cwd's repository root, a `--repo` worktree or a `repos.json` worktree (an `.envrc`-style `PATH_add bin` must not put a teammate-synced `xdg-open` first). A candidate MUST lie outside those directories, MUST be owned by uid 0 or the user, and MUST NOT be group- or world-writable. The opener child's `PATH` is the filtered list, because `xdg-open` is itself a script that resolves `gio`, `x-www-browser` and `sensible-browser` from its own `PATH`.

#### 3.10.9 CLI output per mode

| Mode | Opens the browser | Prints the launch URL | Text |
|---|---|---|---|
| `tty` | yes, unless `--no-open` | only with `--no-open` or after an open failure | `UI_VIZ_OPENED` ("Opened the read-only viewer in your browser. It stops 10 minutes after you close the tab.") or `UI_VIZ_URL` |
| `slash` (Claude reads the output) | yes | **never**: the token would enter Claude's context and the session transcript on disk | framed `UI_VIZ_OPENED` or `UI_VIZ_OPEN_FAILED` with the terminal command, ≤ 4,000 chars |
| `pipe` | no | never | `UI_VIZ_TERMINAL_ONLY` with the terminal command |

The `slash` mode and a Claude Bash call of `node cli.js view` are indistinguishable to the CLI. Such a call may open a read-only window but never yields the token to Claude (§8 Q5).

#### 3.10.10 Logs

`<data dir>/log/viz-<instance>-<n>.jsonl`, user-only, opened append-only and rotated 10 MB × 5 by the viewer process that owns `<instance>` only, so concurrent viewers never rename each other's files (on Windows a rename over a file another process holds open fails, glossary §26.1 W3). At start a viewer deletes `viz-*.jsonl` files older than 14 days (glossary §20). A line holds only a local monotonic time, a registry code, counts, durations, HTTP status numbers, opaque room ids, exit reason codes, error `code` properties (`ENOENT`, never `err.message`, which carries absolute paths) and stack frames as `{fn, line, col}` tuples with basenames (§3.10.4). Never a request URL, path or header value, a token or salt, a name, note, label, branch, folder or repository path, an absolute path or an environment value. There is no per-request access log; security events are aggregated to at most one line per code per 60 s with a count (`SEC_VIZ_BAD_HOST`, `SEC_VIZ_BAD_ORIGIN`, `SEC_VIZ_BAD_TOKEN`, `SEC_VIZ_LAUNCH_REUSED` (logged at once, as the viewer then exits), `SEC_VIZ_LAUNCH_EXPIRED`, `SEC_VIZ_METHOD`, `SEC_VIZ_LIMIT`). Every line still passes `scanSecrets(kind: 'log')` and `sanitize(…, 'log')` (SEC-38). Fold findings use `SEC_RECORD_INVALID` semantics (ids only) in this log, never in a clone's `log/security.jsonl`.

### 3.11 Languages and accessibility

**One renderer.** The pure `render(code, params, channel, lang)` of 10-product §3.2 is a shared module bundled into both `viz.js` and the client. The server serves the viewer subset of each of the six human catalogs on request (`/api/v1/strings?lang=`, default `L_h`); every parameter the client inserts comes from the view model, already validated, sanitized and capped on the server. The client contains no human-text literal (the I18N-07 lint extends to `src/viz/client/**`). Rendering in the page lets anonymize work without a server round trip, and the language switcher costs one request per language.

**Language.** `L_h` for the viewer = `user.json` `language` → OS locale (10-product §3.17 mapping) → `en`, resolved by the CLI in its own environment and passed as `--lang` (§3.2 item 2), because the viewer's builder environment forces `LC_ALL=C`, which would make every OS locale read as `en`. The per-repository team language is not used, because one viewer spans several repositories (the precedence the hook loader already uses, glossary §17; §9.2). A switcher in the page header (the six languages) overrides it for this page; the choice is a per-viewer convenience kept in `localStorage` inside try/catch.

**Channel `viz`.** `sanitize` as the `notification` channel (NFC; strip C0/C1, ANSI/OSC, bidi, zero-width, format and tag characters; `<` `>` → U+FF1C/U+FF1E; URLs → `[link removed]`; leading `/` command tokens removed; every line break → one space; dash runs → `—`), no ANSI, and these caps: names 20 rendered / 64 raw, label 80, path 80, note 280 in a card, bubble 2 lines × 42 Latin / 16 full-width characters, branch 80, room label 40, card text ≤ 400, tooltip ≤ 200, (rev 2.5, F29) reel title 60 (one line). Teammate notes and names are data, never translated, and are shown in a visually distinct quoted frame (the human equivalent of COO-'s data-not-instructions block). Durations use `UI_DUR_*` with `Intl.PluralRules(L_h)`; numbers use `Intl.NumberFormat(L_h)`.

**Codes defined by this chapter** (all `^[A-Z][A-Z0-9_]{2,47}$`, each with templates in all six human catalogs; registry `dist/i18n/codes.json`):

| Group | Codes |
|---|---|
| CLI | `UI_VIZ_OPENED`, `UI_VIZ_URL`, `UI_VIZ_OPEN_FAILED`, `UI_VIZ_TERMINAL_ONLY`; refusals `RF_VIZ_START_FAILED`, `RF_VIZ_BIND_FAILED`, `RF_VIZ_NO_ROOMS`, `RF_VIZ_REPO_NOT_LIVE`, `RF_VIZ_DEMO_INVALID` |
| Page states | `UI_VIZ_STOPPED`, `UI_VIZ_LINK_EXPIRED`, `UI_VIZ_LINK_REUSED`, `UI_VIZ_NEED_LINK`, `UI_VIZ_BAD_HOST`, `UI_VIZ_NOT_FOUND`, `UI_VIZ_NO_ROOMS`, `UI_VIZ_ROOM_AMBIGUOUS`, `UI_VIZ_ROOM_DOWN`, `UI_VIZ_ROOM_GONE`, `UI_VIZ_NO_BOARD`, `UI_VIZ_RECONNECTING`, `UI_VIZ_VERSION_SKEW`, `UI_VIZ_NEWER_PROTOCOL`, `UI_VIZ_CHECKPOINT_MISMATCH`, `UI_VIZ_INCIDENT_FROZEN`, `UI_VIZ_STATUS_UNREADABLE`, `UI_VIZ_LAST_FETCH`, `UI_VIZ_BOARD_FULL`, `UI_VIZ_BOARD_NEAR_FULL`, `UI_VIZ_DEMO_BANNER`, `UI_VIZ_DEMO_CAPTION_<n>`, `UI_VIZ_CAUGHT_UP`, `UI_VIZ_NEW_PILL`, `UI_VIZ_MORE`, `UI_VIZ_SEEN_AGO`, `UI_VIZ_SEEN_BEFORE_OPEN` |
| Scene labels | `UI_VIZ_YOU`, `UI_VIZ_LAST_SHARED_HERE`, `UI_VIZ_HOLDING`, `UI_VIZ_SHELF_DESK`, `UI_VIZ_BIG_TABLE`, `UI_VIZ_GRANT_PAUSE`, `UI_VIZ_HOST_REFUSED`, `UI_VIZ_LABEL_UNVERIFIED`, `UI_VIZ_SCENE_SUMMARY`, `UI_VIZ_SIGN_BASE_MOVE`, `UI_VIZ_TAG_RESERVED`, `UI_VIZ_TAG_LINES`, `UI_VIZ_TAG_CHECKS`, `UI_VIZ_CHIP_ASKED_AGAIN`, `UI_VIZ_BUBBLE_GO_FIRST`, `UI_VIZ_BADGE_VERSION`, `UI_VIZ_BADGE_RULES`, `UI_VIZ_BADGE_CREDIT`, `UI_VIZ_BADGE_HEALTH` |
| Icons (screen-reader labels of the 8 × 8 sprites) | `UI_VIZ_ICON_QUEUED`, `_ASKED`, `_AWAITING_HUMAN`, `_UNDELIVERABLE`, `_ACCEPTED`, `_DECLINED`, `_LATER`, `_DAEMON`, `_WAKE` (each prefixed `UI_VIZ_ICON`) |
| Cards | `UI_VIZ_CARD_ROOM_OPEN`, `_JOIN`, `_REJOIN`, `_LEAVE`, `_SEAT_START`, `_SEAT_END`, `_REQUEST`, `_ANSWER`, `_NOTE`, `_K4`, `_CONFLICT`, `_BREACH`, `_ABSENT`, `_SAVE`, `_FREEZE`, `_THAW`, `_SLOWED`, `_NONRETRYABLE`, `_BASE_MOVE`, `_BOARD_FULL`, `_VERSION`, `_RULES`, `_HEALTH`, `_PUBLISH` (each prefixed `UI_VIZ_CARD`) |
| Recording | `UI_VIZ_RECORD_NOTICE`, `UI_VIZ_RECORD_UNSUPPORTED`, `UI_VIZ_RECORD_CAP`, `UI_VIZ_RECORD_SIZE`, `UI_VIZ_RECORD_INTERRUPTED`, `UI_VIZ_ANON_ROOM`, `UI_VIZ_ANON_NAME_APRICOT`, `_AMBER`, `_SKY`, `_GREEN`, `_LEMON`, `_BLUE`, `_PINK` (prefixed `UI_VIZ_ANON_NAME`), `UI_VIZ_ACC_BEANIE`, `_HEADPHONES`, `_SUNGLASSES`, `_SCARF`, `_SPROUT`, `_CAP`, `_BOW`, `_GLASSES` (prefixed `UI_VIZ_ACC`) |
| Controls and filters | `UI_VIZ_CTRL_PLAY`, `UI_VIZ_CTRL_PAUSE`, `UI_VIZ_CTRL_LIVE`, `UI_VIZ_CTRL_SPEED`, `UI_VIZ_CTRL_LOAD_EARLIER`, `UI_VIZ_CTRL_RECORD`, `UI_VIZ_CTRL_REDUCED_MOTION`, `UI_VIZ_CTRL_LANGUAGE`, `UI_VIZ_CTRL_ZOOM`, `UI_VIZ_CTRL_COARSE`, `UI_VIZ_CTRL_ANONYMIZE`, `UI_VIZ_FILTER_ALL`, `UI_VIZ_FILTER_PERSON`, `UI_VIZ_FILTER_FILE`, `UI_VIZ_FILTER_CONVERSATION`, `UI_VIZ_FILTER_ACTIVITY`, `UI_VIZ_FILTER_CONFLICTS`, `UI_VIZ_FILTER_SYSTEM` |
| Log only | `SEC_VIZ_BAD_HOST`, `SEC_VIZ_BAD_ORIGIN`, `SEC_VIZ_BAD_TOKEN`, `SEC_VIZ_LAUNCH_REUSED`, `SEC_VIZ_LAUNCH_EXPIRED`, `SEC_VIZ_METHOD`, `SEC_VIZ_LIMIT`, `VIZ_EXIT_IDLE`, `VIZ_EXIT_LIFETIME`, `VIZ_EXIT_LAUNCH_UNUSED`, `VIZ_EXIT_LAUNCH_REUSED`, `VIZ_EXIT_PLUGIN_REMOVED`, `VIZ_EXIT_SIGNAL` |
| Reused | `PH_*`, `SS_*` (10-product §3.14), `UI_DUR_*`, `UI_INTERNAL_ERROR`, `SEC_SECRET_REDACTED` (carrier kind `viz`), `SEC_RECORD_INVALID`, `SEC_REFUSE_RUNTIME_INTEGRITY` (SEC-36), `RF_UNKNOWN_FLAG`, `START_TOOL_VERSION` |

This table lists every code the CLI, the page and the viewer log use; a human-facing string with no code here is a defect (VIZ-39, T-VIZ-i18n). Chair tags may show the single glyph `?` for an unverifiable label (SEC-35), which is a symbol, not text. (rev 2.5) The codes of F04, F29, F32 and F34 — including the new "Postcard" group and `UI_VIZ_ANON_NAME_NTH` — and (owner choice of 2026-10-08) `UI_VIZ_CLAIMS_PENDING` are **not** in this table yet: T-VIZ-i18n parses every table row of this section and deep-equals it with `src/viz/i18n/codes.ts` (FEAT-F32-09), so each feature's rows wait in the non-parsed block §9.9 and move into this table only in the same merge as the code that defines them (F32: 8a Task 19; F04-b: its follow-up after 8a; F34 and F29: their 8b tasks; `UI_VIZ_CLAIMS_PENDING`: 8a Task 20). Codes and texts named in §3.7–§3.9 and §4 for those features are defined there and enter the registry with that merge.

**Accessibility.**
- **Reduced motion**: `prefers-reduced-motion: reduce` switches every state to its §3.7 reduced form; an in-page toggle overrides the OS setting in both directions. Information is never removed, only motion.
- **Pause** (WCAG 2.2.2): a visible pause control stops all scene motion; the scene runs all day, so this is required, not optional.
- **Keyboard**: every control is reachable by Tab in a fixed order (map rooms → people list → log filters → cards → rewind bar → controls); Enter selects; the rewind-bar keys of §3.9.1; `L` returns to live; `Esc` clears filters (rev 2.5, F34, F32: `Esc` closes an open export panel, record or postcard, first; only with no export panel open does it clear filters and end the selected room's follow, §3.8.1); (rev 2.5, F32) `F` toggles following the person-filtered character (§3.8.1); `+`/`-` zoom. Focus is always visible.
- **Screen readers**: the office canvas has `role="img"` and an `aria-label` from `UI_VIZ_SCENE_SUMMARY` ("{people} people, {sessions} Claude sessions, {open} requests open, {conflicts} conflicts"); a visually hidden list holds one button per character with its name, `PH_`/`SS_` label and desk ("last shared here: {path}"), which filters the log; the log is `aria-live="polite"`, rate-limited to one announcement per 10 s that summarises what arrived.
- **Contrast**: chrome text ≥ 4.5:1 in both themes; name tags and bubbles sit on contrasting plates.

### 3.12 Performance budgets

| Budget | Value | Basis |
|---|---|---|
| Viewer resident memory | ≤ 200 MB with 8 rooms, each holding at most 2,048 heights of timeline (§3.3.3) | REASONED; measured by T-VIZ-perf, including a room extended live by 17,280 heights (24 h at B = 12) |
| Viewer CPU with no new board commits | ≤ 1 % of one core including git children, averaged over 60 s, 8 rooms | REASONED (at most one `rev-parse` per room per 60 s, glossary §25 F6 process cost); T-VIZ-perf |
| Git calls per room per 2.5 s tick | 0 while the stat pairs of §3.3.2 are unchanged; 1 `rev-parse` when one changed or 60 s passed; with new commits, + 1 `rev-list` + 1 `cat-file --batch` for board commits and 1 for live commits per batch of ≤ 1,280, + 1 `cat-file --batch` per board commit that carries `claim` ops and 1 `merge-base --is-ancestor` per distinct tombstone anchor of its claims (owner decision of 2026-10-08, §3.3.3 "Claim inputs"; a blob over one call's budget alone in one more call), and + 1 `cat-file --batch-check` per 30 s for a room waiting for claim inputs; never 2 concurrent per room | read set §3.3.2, §3.3.3; T-VIZ-poll |
| First `/api/v1/world` | ≤ 3 s for 8 rooms × 1,024 heights on the Windows reference laptop | REASONED (≈ 6 git processes per room with batched reads, plus the claim-input reads of each claim-carrying commit, §3.3.3); T-VIZ-perf (one of its rooms carries claim ops) |
| Seek outside what the page holds | ≤ 500 ms (≤ 255 folds) | glossary §20 "Join replay"; T-VIZ-perf |
| Stream payload | ≤ 64 KiB per SSE message; a tick's events are split across messages; more than 64 new commits in one tick → one `room_snapshot` | board caps bound one commit to 1,000 ops, not one tick; T-VIZ-stream |
| Page | ≤ 12 fps; ≤ 2 draws/s for a room where everyone is idle; ≤ 10 % of one core while animating; the loop stopped when nothing animates; JS heap ≤ 150 MB; ≤ 2,000 cards per room | REASONED; T-VIZ-anim |
| Bundle | `dist/viz.js` ≤ 1.5 MB including the client assets and the bundled demo log (≤ 64 KiB) | T-VIZ-lints |
| Effect on daemons | none measurable: the glossary §20 perf gates (idle cycle ≤ 100 ms, ≤ 2 % CPU) hold with a viewer open on every room; the viewer never holds a handle on any file a daemon writes | glossary §20, §26.1 W3; T-VIZ-contention |
| Postcard preview (rev 2.5, F34) | ≤ 250 ms from the click to the drawn preview on the Windows reference laptop, 64-cell office, 12 characters, 12 pets (FEAT-F34-09, SHOULD) | REASONED; T-F34-perf |

### 3.13 Modules and their interfaces

Everything lives under `src/viz/**` except the seams of §1.5 item 11, the dev tool `tools/viz/export-demo.ts` and, (rev 2.5, F04-a; merge round 2) the shared pure module `src/data/zone.ts` (below). Arrows are imports. `model/**` and `render/**` are pure. The files that touch a `FoldState` (`model/frame.ts`, `model/timeline.ts`, `model/start.ts` with `startScene`) run on the server only; `model/{events,scene,layout,placement,cards}.ts` and `render/**` are compiled into the client too. `reduceScene` treats every id as an opaque string and orders only by position and the layout's `homeOrder`, so the page runs the same reducer over view-model ids and replay equals live (VIZ-26). (rev 2.5, F04, F29) `model/moments.ts` and `model/reel.ts` are pure and compiled into the client too; like `reduceScene` they compare ids only for equality. (rev 2.5, F32, F34, F29) The page logic in `src/viz/ui/**` follows Plan 8a's layer rule (rulings R-V33, R-V35): `ui/**` imports nothing from `render/**`, type-only imports included (L-VIZ-IMPORT, §9.5), and `render/**` may import `model/**` and `ui/**`.

```
cli.js ─► src/viz/cli/{view,spawn,opener}.ts                       (the verb; nothing else from src/viz)
viz.js ─► src/viz/main.ts ─► source/{rooms,git,demo,status,claimInputs}.ts ─► model/**  (fold via src/board/fold.ts; claim pairs via src/claims/overlapPairs.ts)
                         └─► server/{store,poll,project,stream,tokens,http}.ts ─► model/**
client (app.js) ─► src/viz/client/** ─► model/{events,scene,layout,placement,cards,moments,reel}.ts, ui/**, render/**, src/i18n/render.ts   (rev 2.5: moments, reel, ui/**)
model/layout.ts ─► src/data/zone.ts                                (rev 2.5, F04-a: zoneOf lives there; part of the client program, R-V35)
```

| File | Responsibility | Interface (summary) |
|---|---|---|
| `cli/view.ts` | flags, output mode, data directory, `L_h`, absolute paths, `--json`, the §3.10.9 table | `runView(argv: string[], env: CliEnv): Promise<number>` (exit code) |
| `cli/spawn.ts` | spawn, ready line, tree kill (§3.2 items 2–3) | `spawnViewer(a: ViewerArgs): Promise<{ port: number; launch: string } \| { refuse: string; line?: number }>`; `killTree(pid: number): Promise<void>` |
| `cli/opener.ts` | §3.10.8 | `openUrl(url: string, ctx: OpenerCtx): Promise<boolean>` |
| `main.ts` | the `serve` argv, SEC-20 re-check, self-hash, git floor, rooms or demo, bind, ready line, the §3.2 item 5 exits | `main(argv: string[]): Promise<never>` |
| `source/rooms.ts` | §3.3.1 discovery and the 30 s re-check | `discoverRooms(dataDir: string, repos: string[]): Promise<RoomSpec[]>` |
| `source/git.ts`, `source/demo.ts` | the two room sources; the git source keeps the room's first-parent oid list and its stat pairs | `interface RoomSource { tip(): Promise<number \| null>; changed(): Promise<boolean>; startAt(h: number): Promise<FoldState>; frames(start: FoldState, from: number, to: number): AsyncIterable<Frame>; }` (`tip`: the tip height, null before genesis; `startAt`: `initialFoldState` at 0, else the checkpoint state at `h`; `frames`: folded with `foldCommit` and the claim inputs of §3.3.3, batches ≤ 1,280; the demo source's `changed` is always false) |
| `source/claimInputs.ts` (owner choice of 2026-10-08) | the claim inputs of §3.3.3: the read-only reads (`cat-file --batch`, `merge-base --is-ancestor`), the pairing of Plan 4's `overlapPairsOf`, overlap answers by `foldOverlap` in this process, and the record-backed inputs of a demo; holds no blob or line array after a call returns; imports no worker pool, grammar runtime or region cache | `readClaimInputs(git: VizGit, prev: FoldState, draft: BoardDraft, needs: ClaimFoldNeeds, memo: Map<string, boolean>): Promise<ClaimFoldInputs \| null>` (null: the commit waits, §3.3.3); `demoClaimInputs(rec: DemoClaims \| null): ClaimFoldInputs`; `recordClaimInputs(needs: ClaimFoldNeeds, inputs: ClaimFoldInputs): DemoClaims` |
| `source/demo.ts` | the §3.9.3 parser | `parseDemoLog(buf: Buffer): DemoLog \| { line: number }` |
| `source/status.ts` | §3.3.6 short read | `readStatus(gitdir: string, prev: StatusRead \| null): Promise<StatusRead>` |
| `model/frame.ts`, `model/events.ts`, `model/timeline.ts`, `model/start.ts`, `model/scene.ts`, `model/layout.ts`, `model/looks.ts`, `model/placement.ts`, `model/cards.ts` | §3.3.4, §3.3.5, §3.3.7, §3.5, §3.6, §3.8 | the signatures and types of those sections |
| `src/data/zone.ts` (rev 2.5, F04-a; outside `src/viz/**`; merge round 2) | the area rule `zone(p)` of §2 / §3.5.3, moved out of `model/layout.ts` so that `cli.js` (`since`, `wrap`) and the daemon share it (10-product §3.9a, §3.20.2); pure, imports nothing outside the client program (L-PURE, L-VIZ-IMPORT). The F04-a change that moves it adds the path to Plan 8a's R-V35 client program (`CLIENT_PROGRAM_FILES` in `tools/lint/vizRules.ts`) and to Plan 8a's R-V02 table of files outside `src/viz/**`, in the same merge | `zoneOf(p: string): string`; `model/layout.ts` imports or re-exports it |
| `model/moments.ts` (rev 2.5, F04) | the catch-up lanes and the last-visit anchor (§3.8, §3.9.1); pure, server and client | `moments(t: Timeline, from: number, to: number, you: PeerRef \| null): Moments`; `lastVisit(t: Timeline, you: PeerRef \| null, openH: number): Position \| null` (types §3.9.1) |
| `model/reel.ts` (rev 2.5, F29) | reel moments, the reel plan, its range and camera (§3.9.6); pure, compiled into the client | `reelMoments`, `planReel`, `reelRange`, `reelCamera`, `serializeReelPlan` (signatures §3.9.6) |
| `server/store.ts` | one per room: window, segments, retention (§3.3.3), ticks, overlay | `class RoomStore { init(): Promise<void>; tick(): Promise<RoomDelta \| null>; page(from: number, to: number): Promise<TimelinePageModel>; earlier(): Promise<TimelinePageModel>; snapshot(): RoomSnapshotModel; }` |
| (types) | `RoomDelta`, `TimelinePageModel` and `RoomSnapshotModel` are the pre-projection (model-typed) forms of the `timeline`/`room_snapshot` payloads, `TimelinePage` and `RoomVM` of §3.10.6 | — |
| `server/poll.ts` | the 2.5 s loop of §3.9.2 over all stores | `startPoll(stores: RoomStore[], hub: StreamHub, clock: Clock): () => void` |
| `server/project.ts` | the only producer of served JSON: model → view model (§3.10.6), validators, `sanitize(…, 'viz')`, `scanSecrets` | `projectRoom(…): RoomVM`, `projectDelta(…): StreamPayload[]`, `projectPage(…): TimelinePage` |
| `server/stream.ts` | sequence ids, the resume ring, 64 KiB split | `class StreamHub { publish(p: StreamPayload): void; attach(out: SseSink, lastEventId: string \| undefined): void; close(): void; }` (`SseSink`: `write`, `end`, `onClose`, implemented by `http.ts`, so no other file imports `node:http`) |
| `server/tokens.ts`, `server/http.ts` | §3.10.1–§3.10.5; `http.ts` is the only file importing `node:http` | `createServer(deps: ServerDeps): Promise<{ port: number }>` |
| `render/sprites.ts`, `render/palette.ts`, `render/raster.ts` | §3.6, §3.7 art; build-time colour checks | `composeStatic(layout)`, `composeSprites(scene, layout, phase)` → RGBA buffers at art resolution |
| `render/viewport.ts` (rev 2.5, F34) | the still phase of a postcard and the viewport composer shared by `record.ts` and postcards (§3.9.4, §3.9.5) | `stillPhase(scene, layout): SpritePhase`; `composeViewport(static, sprites, cameraTop)` |
| `ui/follow.ts` (rev 2.5, F32) | the follow camera and the now card (§3.8.1); pure, DOM-free, imports `model/**` only | `FOLLOW_PAN_MS = 300`, `NOW_ROWS_MAX = 3`, `followedActors(s, peer)`, `focusActor(prev, s, peer)` (pets in ascending seat handle), `cameraTarget(tiles, focus, view, office, force)` (tiles passed in by the client; `force` skips camera step 1 for a chip click), `class FollowCamera { userScrolled(): void; due(prev, s, peer): boolean }`, `nowCard(s, layout, peer): NowCard`; in a room with a follow the client consults `FollowCamera` instead of Plan 8a's 30 s auto-scroll rule (`ui/zoom.ts` `FollowRule`); `ui/a11y.ts` gains the `KeyAction` `'follow'` and the key `F` |
| `ui/postcard.ts` (rev 2.5, F34) | the postcard's still camera and text (§3.9.5); pure, imports nothing from `render/**` | `postcardCamera(scene, layout)`, `postcardLines(snapshot, anon, render, lang)` |
| `ui/**` page layer (rev 2.5, F29) | the reel's default-range anchor (§3.9.6 "Range" rule 1); not pure | `catchUpAnchor(roomId: string): number \| null`: the selected room's catch-up anchor height (§3.8), else null |
| `client/main.ts`, `api.ts`, `office.ts`, `log.ts`, `rewind.ts`, `record.ts`, `gif.ts`, `a11y.ts`, `app.css` | the page: redemption, `fetch` + SSE parser, canvas loop and A\* pathfinding, log panel, rewind bar, recording, accessibility; (rev 2.5) the catch-up panel, Play and the last-visit flag (F04), the follow wiring in `office.ts`, `log.ts`, `a11y.ts` (F32), the reel source and the title-card and montage drawing in `record.ts` (F29) | browser only (`L-VIZ-IMPORT`, `L-VIZ-DOM`) |
| `client/postcard.ts` (rev 2.5, F34) | the postcard panel, snapshot, composition and clipboard writes (§3.9.5); the only file that touches the clipboard | browser only |
| `client/save.ts` (rev 2.5, F34) | the one Blob download of every export (§3.9.4 "Saving") | `saveBlob(blob, name)` (checks the §3.9.4 name pattern, revokes the object URL after the click) |

**Build.** The build first bundles `src/viz/client/main.ts` with esbuild (`format: 'iife'`, `target: ['es2022', 'chrome120', 'edge120', 'firefox128', 'safari17']`, minified, no source map) and then bundles `dist/viz.js` from `src/viz/main.ts`, importing the client bundle, `app.css` and the bundled demo log as strings (esbuild `text` loader), so `/app.js` and `/app.css` are served from that in-memory map. The browser floor is therefore Chrome and Edge 120, Firefox 128 and Safari 17.

---

## 4. Rules

`_Covers:_` names that do not exist in the failure sweep are new with this chapter: `viewer-web-server-in-daemon`, `viewer-token-in-claude-context`, `windows-exe-lookup-cwd`, `opener-shell-injection`, `viewer-reads-local-secrets`, `viewer-holds-repo-handles`, `viewer-fold-drift`, `layout-reflow-disorients`, `guessed-presence-states`, `recording-leaks-team-data`, `sitting-reads-as-lock`, `teammate-impersonation-by-name`, `colour-only-meaning`, `trademark-mascot`, `viewer-cpu-drain`, `bubble-too-fast-to-read`, `transcript-leak-into-view`, `loopback-listener-other-local-users`, `dns-rebinding-loopback-service`, `cross-site-request-to-loopback`, `xss-from-board-text`, `path-traversal-local-server`, `motion-accessibility`, `launch-token-theft`, `opener-path-hijack`, `prototype-pollution-from-paths`, `git-lazy-fetch-egress`; (rev 2.5, F32) `follow-feels-like-surveillance`. (rev 2.5) The requirements merged from the F04, F32, F34 and F29 proposals keep their `FEAT-F##-NN` ids.

### Process, CLI and opening

- **VIZ-01** The viewer MUST be the separate bundle `dist/viz.js`, started only by `cli.js view` (tests may start it directly). `daemon.js`, `hook.js`, `core.js`, `mcp.js` and `worker.js` MUST NOT import any module under `src/viz/**`; `cli.js` MUST import only `src/viz/cli/**` (spawner, opener, output); `node:http` MUST appear in `viz.js` only, and only as a server (esbuild metafile check). _Covers: viewer-web-server-in-daemon, supply-chain-versions_
- **VIZ-02** The CLI MUST resolve the data directory (with SEC-20's owner and ACL verification), `L_h` and absolute `--repo`/`--demo` paths in its own environment, refusing UNC and device paths, and MUST pass them as viewer arguments (§3.2 item 2); from Plan 8b it MUST verify `dist/viz.js` against `dist/SHA256SUMS` and refuse `SEC_REFUSE_RUNTIME_INTEGRITY` on a mismatch, passing the verified hash as the viewer's start hash. It MUST spawn the viewer with `process.execPath`, without a shell, detached and hidden, with cwd = the data directory and an environment built by the 09-security §3.4 builder. It MUST receive the port and launch token, or a refusal code, only as the child's single stdout line within 5 s (15 s on Windows), validated by schema; otherwise it MUST kill the child's process tree — `process.kill(-pid, 'SIGKILL')` on POSIX, `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F` by absolute path on Windows — and refuse `RF_VIZ_START_FAILED`. The CLI MUST NOT spawn any bare executable name. Nothing about a token may be written to disk. The viewer MUST repeat the SEC-20 verification before reading `repos.json` or creating `log/`. _Covers: windows-exe-lookup-cwd, viewer-token-in-claude-context, supply-chain-versions_
- **VIZ-03** The viewer MUST exit when its launch token is unredeemed 120 s after start, when a redeemed launch token is presented again (§3.10.2), after 10 min with no open stream and no authenticated request, 24 h after start, within 30 s of `dist/viz.js` disappearing or its SHA-256 differing from the start hash, and on `SIGTERM`, `SIGINT` or `SIGHUP`. The launch TTL, the idle exit and the lifetime MUST be measured as own staleness, max(Δwall, Δmono) from a local anchor, so a suspend counts. _Covers: orphan-daemon-outlives-sessions-and-plugin, launch-token-theft_
- **VIZ-04** The launch URL MUST NOT appear in `slash` or `pipe` output, in a `--json` envelope, a log, a file or an IPC frame; in `tty` mode it MAY be printed only with `--no-open` or after an open failure. In `pipe` mode the CLI MUST NOT start a viewer. _Covers: viewer-token-in-claude-context_
- **VIZ-05** The opener MUST re-validate the URL against `^http://127\.0\.0\.1:[1-9][0-9]{0,4}/#k=[0-9a-f]{64}$` immediately before spawning, MUST spawn the absolute-path executable of the §3.10.8 table with an argv array, no shell and cwd = the data directory (on Linux: the fixed candidates first, then the filtered `PATH`, with the owner and mode checks, and the filtered `PATH` in the child), and MUST NOT use `cmd.exe`, a `.cmd`/`.bat` file or PowerShell command text containing the URL. _Covers: windows-exe-lookup-cwd, opener-shell-injection, opener-path-hijack_

### Read set and world model

- **VIZ-06** The viewer MUST read only the §3.3.2 read set and MUST NOT read anything on its never-read list: in particular no blob other than a board commit's `ops.jsonl`, `protocol.json` and `checkpoint/state.json` and (owner decision of 2026-10-08) the claim-fold blobs `claimFoldNeeds` names for a board commit that carries `claim` ops, which it MUST read only to fold that commit, MUST hold in memory for that one fold only and MUST NOT cache across commits, serve, log, write, export, render or count in any output — only claim structure (ids, holders, paths, ranges, labels, states) may reach the world model; no tree other than a board commit's `held` tree (names only), no `refs/cowork-local/*`, no save or branch commit, no working-tree file, no `<gitdir>/cowork/tmp/**`, no `ipc.key`, no `user.json`, no Claude Code settings file, no environment value. A demo run MUST perform no git call and read no repository and no data-directory file (its log directory excepted). _Covers: viewer-reads-local-secrets, board-plaintext-and-permanence, peer-normalization-secret-leak_
- **VIZ-07** Every viewer git call MUST go through `runGit` in the `local` class with the glossary §18 flags, `--no-replace-objects`, an absolute canonical `--git-dir`, cwd = the data directory, `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`, and `-c protocol.allow=never` plus `-c protocol.<name>.allow=never` for `file`, `git`, `http`, `https`, `ssh` and `ext` (command-line values override repository config at the git 2.43 floor, so a missing object in a partial clone is a read error, never a fetch). Its argv MUST match the `L-VIZ-GIT` allowlist (`rev-parse --verify -q`, `for-each-ref -z` under `refs/cowork-remote/`, `rev-list --first-parent`, `cat-file --batch`, and — owner decision of 2026-10-08, the claim-fold reads of §3.3.2 only — `merge-base --is-ancestor <oid> <oid>`). It MUST NOT run a command that can take a lock, run a filter, hook or fsmonitor, or touch the network, and MUST NOT override `safe.directory`. Board and live commits MUST be read only in batches (`readBoardCommits`, `readLiveCommits`, §9.7), never one git process per commit, and a `cat-file --batch` process MUST live for one batch only. Claim inputs (§3.3.3) are the one per-commit read: they MUST be read only for a board commit whose `claimFoldNeeds` is not empty, only while that commit is folded, with at most the calls §3.12 counts, and a claim-input `cat-file` process MUST serve that one commit only. `status.json` MUST be read with one open-read-close, at most 1 MiB, and only after its mtime changed; the board ref's storage MUST be watched by `stat` only (§3.9.2). _Covers: windows-exe-lookup-cwd, viewer-holds-repo-handles, git-lazy-fetch-egress, viewer-cpu-drain_
- **VIZ-08** The viewer MUST fold every room with the `foldCommit` of its own build, passing the claim inputs of §3.3.3 for every board commit (it MUST NOT fold a commit whose claim inputs it could not resolve: the room then waits with `UI_VIZ_CLAIMS_PENDING`), and MUST create scene events only for ops whose verdict is `effective`; it MUST NOT re-implement op semantics or fold rules (the ghost rule comes from `liveSet`/`rankedSet`, the live-commit shape from `liveShape`). An `unfolded` or `rejected` op MUST produce no scene event and MUST be counted in its frame's `unknown`. The timeline MUST NOT depend on the `self` argument. _Covers: viewer-fold-drift, version-skew-board-loss_
- **VIZ-09** A room's window MUST start at `h0 = 256 · ⌊max(0, t − 1,023) / 256⌋` for a tip at height `t`, from `initialFoldState` when `h0 = 0` and from the checkpoint at `h0` otherwise; every checkpoint inside the window MUST be compared with the viewer's fold, and a mismatch MUST be shown (`UI_VIZ_CHECKPOINT_MISMATCH`) without stopping the fold; the viewer MUST NOT re-seed its fold from a checkpoint inside the window and MUST NOT exempt any member, claims included, from the comparison. Earlier history MUST be loaded only on request, 256 heights at a time. _Covers: viewer-fold-drift_
- **VIZ-10** `buildTimeline`, `extendTimeline`, `prependTimeline`, `startScene` and `reduceScene` MUST be pure and total: no I/O, clock, randomness, Node or DOM import; `extendTimeline(buildTimeline(w[0..k]), w[k+1..n])` MUST deep-equal `buildTimeline(w[0..n])`; positions `(height, sub, k)` MUST be unique and follow §3.3.5; every cosmetic random choice MUST come from the event's `seed`, which no oid may enter; scene event kinds MUST be exactly the closed set of §3.4. _Covers: layout-reflow-disorients, guessed-presence-states_
- **VIZ-11** Every viewer surface MUST order by board position. No wall-clock value, including commit dates, MAY order, pace, filter or label anything; a live "seen {n} min ago" label MUST come from the viewer's own monotonic clock since it folded that commit (`seen_ms`, §3.8), and a card the viewer did not see arrive MUST show its height instead; no remote "last seen" MAY be shown. _Covers: lease-expiry-clocks-heartbeats_
- **VIZ-12** Every scene element outside the local overlay MUST be the image of a folded board fact or of a trailer of a live commit named by a board commit. Teammate liveness MUST come only from `PeerRec.status`, the ghost rule (`K_evict`), folded `freeze`/`unfreeze` events and `health` codes; no timer, heuristic or local observation MAY make a teammate look offline, idle or busy. _Covers: guessed-presence-states, zombie-claims-idle-holder_
- **VIZ-13** Data from `status.json` and `<gitdir>/cowork/peer` MUST stay in the local overlay: present only, never in the timeline, never drawn on a past scene, never recorded or exported, never shown for another room. `down` MUST be derived only from a parsed `heartbeat_mono_ms` against 3 × `loop_period_ms` on the machine-wide monotonic clock, or from a missing `status.json` while `live` exists; an unreadable `status.json` MUST keep the previous overlay with `UI_VIZ_STATUS_UNREADABLE` and MUST NOT make `down`. _Covers: recording-leaks-team-data, silent-stall-no-visible-surface_
- **VIZ-14** The viewer MUST NOT fold a board commit that does not have the room's last folded commit on its first-parent chain, nor fold any commit while the room's `status.json.state` is `incident`. The room MUST then stay at its last folded scene with `UI_VIZ_INCIDENT_FROZEN` and MUST be rebuilt from the current tip only after the room's daemon reports another state with a fresh heartbeat. _Covers: ref-rewind-silent-revert_
- **VIZ-15** A room MUST show `UI_VIZ_VERSION_SKEW` when `status.json.plugin_version` differs from the viewer's version, `UI_VIZ_NEWER_PROTOCOL` when the board's `proto ≠ 1`, and `UI_VIZ_CHECKPOINT_MISMATCH` per VIZ-09; none of them may stop the display of what the fold applied. _Covers: version-skew-board-loss, silent-stall-no-visible-surface_

### Layout, characters and art

- **VIZ-16** Desks MUST be allocated by the §3.5.3 algorithm from board-named paths only (never a `local_only` stub's), append-only in first-touch order. A desk MUST NOT move or disappear while the viewer runs; rewinding MUST keep the head layout; "load earlier" MUST only append desks after the existing ones; the office MUST scroll rather than switch to the coarse view, which only the user may toggle; the zoom MUST change only on page open, window resize or a user zoom. _Covers: layout-reflow-disorients_
- **VIZ-17** Actors MUST be placed by §3.5.4: the change-set actor by the `cs_id` grammar, the target desk by the stated tie-breaks, chairs by the stated precedence. Only `request_open` MAY make an actor walk to another actor. Sitting after a publish MUST be labelled `UI_VIZ_LAST_SHARED_HERE`, never as current work or ownership. _Covers: sitting-reads-as-lock, phrasing-blame-and-peer-text-injection_
- **VIZ-18** A character's look MUST be derived from `peer_id` alone by the §3.6 formula, never from the display name, a window or another peer; two peers in a room with the same sanitized name or the same look MUST both be shown with their handle. _Covers: teammate-impersonation-by-name_
- **VIZ-19** Colour MUST NOT be the only carrier of any meaning: every character has an accessory and a name tag, every state an icon or text, every rewind-bar tick a distinct glyph. The body palette MUST pass the §3.6 scene-contrast and colour-vision tests and every accessory tone pair the ΔE ≥ 15 test; icons MUST be sprites, never emoji or font glyphs. _Covers: colour-only-meaning_
- **VIZ-20** All art MUST be original sprite maps embedded in the bundle; the page MUST load no external font, image, script, style or URL and MUST show no Anthropic or Claude logo, mascot or mark; `dist/viz.js` MUST contain no third-party code. _Covers: trademark-mascot, supply-chain-versions_
- **VIZ-21** There MUST be exactly one pet per seat key that is live in the fold or has a board footprint, spawned on `seat_start` or the seat's first footprint (whichever folds first) and removed on `seat_end`, epoch retirement, `presume_absent` or `leave`, and — for a seat with no folded `seat_start`, which PRO-20 lets end without `seat_end` — when its owner becomes a ghost; a pet MUST use its owner's colours. _Covers: guessed-presence-states_

### Animation, bubbles and the log

- **VIZ-22** Animation states MUST be entered only through scene events (§3.7 table), except (rev 2.5, F29, F04) the title-card state, entered only by a reel `intro` step on the recording canvas, and the montage state, entered only by a reel `montage` step or a catch-up Play montage beat (FEAT-F29-06, FEAT-F04-14); the render loop MUST cap at 12 fps, MUST draw only when a sprite's frame index changes (≤ 2 draws/s for an idle room) and MUST stop when nothing animates; each state MUST have the reduced-motion form of the table; a persistent "!" MUST come only from a non-terminal hold record. _Covers: guessed-presence-states, viewer-cpu-drain_
- **VIZ-23** Bubbles MUST follow §3.8: the reading-speed duration clamped to 1.5–6 s, at most 2 lines × 42 Latin / 16 full-width characters, at most one per actor and three per room, the whole text kept in the log. _Covers: bubble-too-fast-to-read_
- **VIZ-24** The log MUST hold exactly the §3.8 card list (conversation, conflict, activity and system cards; system cards behind their filter; consecutive publishes of one actor merged), ordered by board position, with `request_status` as a chip on its request card; clicking a character MUST filter the log to it, and person, file and kind filters MUST combine with AND. (rev 2.5, F32, F04) The now card of §3.8.1 and the catch-up panel of §3.8 are not cards of this list. _Covers: silent-stall-no-visible-surface_
- **VIZ-25** Teammate free text MUST appear only inside the quoted note frame of a card or a bubble, never translated and never styled as viewer text. Claude transcripts, prompts, tool input, file content, diffs and held bytes MUST NOT appear anywhere on the page. (rev 2.5, F34) A postcard (§3.9.5) MUST NOT contain teammate free text, with anonymize on or off (FEAT-F34-05). _Covers: teammate-text-as-instructions, transcript-leak-into-view_

### Catch-up (rev 2.5, F04)

- **FEAT-F04-13** `moments` and `lastVisit` MUST be pure and total, classify exactly by the §3.9.1 lane table, and MUST NOT change `Timeline`, golden output, cards, ticks or recordings; the panel and the visit flag are page state.
- **FEAT-F04-14** Play MUST show every mine and team moment in position order and collapse each routine run to one montage beat ≤ 1.5 s that draws only desks of folded publishes.

### Following (rev 2.5, F32)

- **FEAT-F32-01** Follow MUST be page state only: at most one followed peer per room, in page memory only. It MUST NOT be sent in any request, stored in browser storage, the URL fragment or a file, logged or written to the board, and MUST NOT add a route, parameter, payload, view-model field, scene-event kind or `Timeline`/`Scene` field.
- **FEAT-F32-02** Follow MUST start only from the §3.8.1 controls and MUST set the person filter to the followed peer; it MUST end only when the user toggles it off, presses `Esc` while no export panel is open, or clears or changes the person filter while its room is selected, when the page reloads, or when a world reload no longer lists the followed handle among the room's characters (Plan 8a ruling R-V22). A room switch MUST NOT end it. No scene event MAY start or end it, and it MUST NOT apply to another room.
- **FEAT-F32-03** In a room with a follow, the office panel MUST scroll only by the §3.8.1 three-step camera rule over the followed actors; another actor's event MUST NOT scroll it. Follow MUST NOT change `Z` or enter the coarse view.
- **FEAT-F32-04** A user scroll while following MUST be honoured until the next beat in which a followed actor's `place` changes, or a chip click (which centres even a visible frame); the camera's own scrolls MUST NOT count as user scrolls.
- **FEAT-F32-05** The camera MUST pan over 300 ms, and MUST jump under effective reduced motion, at replay speed ≥ 4×, and on a seek, `room_snapshot`, "load earlier" or room switch.
- **FEAT-F32-06** The now card MUST be computed only from the drawn scene, the layout and the character table by the §3.8.1 now-card table and limits; it MUST NOT be a §3.8 card, show an overlay value, a time or age, "working on", a note's text, or any aggregate over time.
- **FEAT-F32-07** For every position p, the now card and the camera target MUST be equal in live and replay (both functions of `reduceScene(p)`, the layout and the viewport).
- **FEAT-F32-08** Follow MUST be keyed by the peer handle within one room and MUST NOT link characters across rooms or by display name.
- **FEAT-F32-09** The eight follow codes MUST be in the §3.11 table (moved there from §9.9 by the Task 19 merge) with templates in all six human catalogs (Plan 8a: `en` only), within the channel `viz` caps, and MUST NOT contain a denylisted surveillance word (T-VIZ-follow-i18n). The codes MUST land in the same merge as the §3.11 table edit (T-VIZ-i18n compares `codes.ts` with the spec table).
- **FEAT-F32-10** Follow MUST NOT steer the recording camera; the now card MUST never reach the recording canvas.
- **FEAT-F32-11** (SHOULD) The toggles SHOULD be buttons with `aria-pressed`, the now card a region labelled by `UI_VIZ_FOLLOWING`, and follow start and end SHOULD be offered to the existing announcer (≤ 1 per 10 s).
- **FEAT-F32-12** (SHOULD) User docs SHOULD introduce follow as keeping a pair-programming partner's corner of the office in view, stating that nothing is sent and the followed person sees the same board; they SHOULD avoid the T-VIZ-follow-i18n denylist words in every language too.

_Covers (FEAT-F32-01..12): follow-feels-like-surveillance, layout-reflow-disorients_

### Replay, demo and export

- **VIZ-26** The rewind bar's axis MUST be height. The scene shown at a position in replay MUST equal the scene a live viewer showed at that position, except the local overlay and the animation phase; seeking to a height the page does not hold MUST fold at most 255 commits from a checkpoint. _Covers: layout-reflow-disorients_
- **VIZ-27** Demo mode MUST read only the bundled demo log or the given `cowork-viz-demo/1` file (a regular file, ≤ 4 MiB, read with a 4 MiB + 1 byte limit); it MUST fold every record with the same `foldCommit` and validators as a real board, with `protocol` carried from height 0, (owner decision of 2026-10-08) claim inputs answered only from the record's `claims` field, and no oid in any seed or timeline, MUST refuse the whole file on any invalid record, MUST never mix demo and real rooms, and MUST show `UI_VIZ_DEMO_BANNER` at all times. _Covers: recording-leaks-team-data_
- **VIZ-28** Recording MUST draw the fixed 480 × 270 art viewport (at 4× for WebM, 2× for GIF) on its own virtual clock, MUST pan the camera only by the §3.9.4 rule (rev 2.5, F29: for a reel, the precomputed path of §3.9.6 with its one cut per intro step), MUST encode WebM only with the browser's `MediaRecorder` (VP9 or VP8) and GIF only with the in-house encoder, MUST stop at 120 s (WebM), on a hidden tab (WebM, saving what it has) or at 10 MB (GIF), and MUST deliver the file only as a local download. (rev 2.5, F32) A follow (§3.8.1) never moves the recording camera. _Covers: supply-chain-versions, board-plaintext-and-permanence_
- **VIZ-29** Recordings of real rooms MUST default to anonymize on and MUST show `UI_VIZ_RECORD_NOTICE` before the first frame when anonymize is off. With anonymize on, no served name, handle, path, label, branch, room label or teammate free-text string MAY reach the recording canvas. With anonymize on or off, no `local_only` stub path MAY reach it, and the local overlay, the map and the log MUST never be recorded. _Covers: recording-leaks-team-data_

Highlight reel (rev 2.5, F29):

- **FEAT-F29-01** The record panel MUST offer the highlight-reel source and `UI_VIZ_CTRL_REEL`; one click with default options MUST produce a saved file; a reel MUST start only from that click.
- **FEAT-F29-02** The default range MUST follow §3.9.6 "Range" (the catch-up anchor of §3.8 when the room has one and its range holds an eligible moment → since the newest save, or the session the newest save closed → the last 256 heights), MUST be frozen at the click, MUST satisfy `h0 ≤ lo ≤ hi ≤ h1`, and MUST be clipped to 2,048 heights with `UI_VIZ_REEL_CLIPPED`.
- **FEAT-F29-03** `reelMoments`, `planReel`, `reelRange` and `reelCamera` MUST be pure and total; `reelMoments` MUST group exactly by the §3.9.6 grouping table and MUST NOT take a `you`, `self` or overlay input; `planReel` MUST depend only on the scene events of `[lo, hi]`, the `reelMoments` result and the options; a plan built from server ids and then projected (§3.10.6 rule: ids → handles) MUST serialize byte-equal to the plan built in the page from view-model events, and page-side plans MUST be byte-equal for any two windows covering the range.
- **FEAT-F29-04** Chapters MUST be chosen by §3.9.6 "Chapters" (eligible only, kind order, round-robin, beats then start, disjoint spans, 1–8 with default 5) and played in ascending start order.
- **FEAT-F29-05** Steps MUST use the §3.9.6 durations; `totalMs` MUST be ≤ the cap (20, 30, 40 or 60 s; default 40) by the §3.9.6 fit order.
- **FEAT-F29-06** The title-card state MUST be a render state of §3.7 entered only by a reel `intro` step on the recording canvas, and MUST NOT appear in live or replay. The montage state MUST be one render state of §3.7, entered only by a reel `montage` step or a catch-up Play montage beat (§3.9.1). Neither MAY be a scene-event kind.
- **FEAT-F29-07** The camera path MUST be computed before frame 0 and start at the first step's target; it MUST move vertically, ≤ 1 tile per 100 ms, except one cut at the first frame of an `intro` step whose target is more than 20 tiles away.
- **FEAT-F29-08** Output MUST use the §3.9.4 pipeline (virtual clock, encoders, caps, download), changed only in the file name `cowork-reel-<n>.gif|.webm` that §3.9.4 "Saving" names.
- **FEAT-F29-09** Reels MUST inherit VIZ-29 in full; reel-only texts MUST use only their §3.9.6 "Texts" placeholders, chapter titles only `{name}`, `{target}`, `{n}`; a conflict chapter's spotlight ring MUST be on its desk, never on an actor (§3.9.6 "Privacy and safety" item 7).
- **FEAT-F29-10** Making a reel MUST send no request other than `GET …/timeline` pages — at most 9 for the frozen range and at most 18 to choose the default range, never one for heights the page already holds — and MUST write nothing but the user's download.
- **FEAT-F29-11** With no eligible moment the page MUST show `UI_VIZ_REEL_EMPTY` and start no encoder.
- **FEAT-F29-12** Every §3.9.6 "Texts" code MUST exist in the six catalogs, with CLDR plural forms wherever `{n}` counts a noun; each chapter title MUST fit 60 rendered characters in one line at worst-case parameters; the summary's length MUST be a `dur` param rendered through `UI_DUR_*` (I18N-03), and no chapter title MAY carry a duration.
- **FEAT-F29-13** The end card SHOULD be on by default and switchable; the panel SHOULD show the summary and rendered titles before the click.

### Postcards (rev 2.5, F34)

- **FEAT-F34-01** The page MUST offer the postcard control of §3.9.5. Every output MUST be made from the snapshot shown in the panel, and the panel MUST NOT change with later beats. _Covers: recording-leaks-team-data_
- **FEAT-F34-02** The picture MUST be the 480 × 270 art viewport of §3.9.4 at 2× (960 × 540 PNG), drawn by the shared viewport composer. It MUST use the §3.9.5 still camera and the settled scene (reduced-motion forms, frame 0, no one-beat effect, no bubble). The caption strip MUST hold only the pre-actor lines of the §3.9.5 text. The picture MUST NOT contain the overlay, the map or the log. For a fixed snapshot and anonymize state its art-resolution RGBA MUST be byte-identical on every run and OS. _Covers: recording-leaks-team-data, colour-only-meaning_
- **FEAT-F34-03** The text MUST follow §3.9.5 "The text": the codes and line order given there, `UI_VIZ_POSTCARD_SEP` between items, no line for an actor with no item, health from `phOf` at the snapshot's position, at most 12 actor lines plus one `UI_VIZ_MORE` line, at most 400 characters per line, LF breaks, and no human-text literal in the client. It MUST be built only from the page's view-model data. _Covers: phrasing-blame-and-peer-text-injection, path-quoting-and-git-locale_
- **FEAT-F34-04** Anonymize MUST be one in-memory page state shared with the record panel, on at every page load for real rooms and never persisted. Image and text MUST use one transform instance per snapshot. Identical looks MUST get `UI_VIZ_ANON_NAME_NTH`. While anonymize is off for a real room, `UI_VIZ_RECORD_NOTICE` MUST be visible before any postcard output can be made. While an export panel is open, `Esc` MUST close only that panel. _Covers: recording-leaks-team-data_
- **FEAT-F34-05** No postcard MAY contain an item of the §3.9.5 never-list ("Privacy and safety"). Text parameters MUST have `@` replaced by U+FF20. _Covers: recording-leaks-team-data, teammate-text-as-instructions, viewer-token-in-claude-context_
- **FEAT-F34-06** Clipboard writes MUST happen only synchronously inside a postcard button's click handler, using `ClipboardItem({'image/png': Promise<Blob>})` or `writeText`, with feature detection and the §3.9.5 "Copy and save" failure codes. The client MUST NOT read the clipboard, listen for `paste`, call `execCommand` or query permissions. _Covers: xss-from-board-text_
- **FEAT-F34-07** Saving MUST go through the single `saveBlob` helper with the fixed name pattern of §3.9.4 "Saving", and the page MUST NOT add any PNG chunk to what `toBlob` produced. _Covers: board-plaintext-and-permanence_
- **FEAT-F34-08** Postcards MUST add no route, view-model field, server code, git call, IPC, board op or network use. INV-VIZ-READONLY, INV-VIZ-LOOPBACK and the §3.10.4 headers MUST hold unchanged. _Covers: viewer-web-server-in-daemon_
- **FEAT-F34-09** (SHOULD) The panel SHOULD open, with its preview drawn, within 250 ms of the click on the Windows reference laptop for a 64-cell office (the §3.12 "Postcard preview" row).

### HTTP server and security

- **VIZ-30** The viewer MUST listen with `node:http` on the literal `127.0.0.1`, port 0, and MUST verify the bound address before announcing it. It MUST NOT open any outbound socket, resolve any name, accept an upgrade or `CONNECT`, or serve anything but HTTP/1.1. _Covers: board-plaintext-and-permanence, loopback-listener-other-local-users_
- **VIZ-31** Launch and session tokens MUST be 32 bytes from the Random port, hex-encoded and held only in memory by the viewer. The launch token MUST travel only in the URL fragment, MUST be single use and MUST expire after 120 s; a second presentation of a redeemed launch token MUST revoke the session minted from it, send `bye` on every open stream, log `SEC_VIZ_LAUNCH_REUSED` and stop the viewer, and the presenting page MUST show `UI_VIZ_LINK_REUSED`; the page MUST remove the fragment before its first request; the session token MUST be sent only in `X-Cowork-Session` and kept by the page only in memory and `sessionStorage`. Token checks MUST validate the shape and then use `timingSafeEqual` over SHA-256 digests. The server MUST NOT emit `Set-Cookie`, `WWW-Authenticate` or any `Access-Control-*` header. _Covers: viewer-token-in-claude-context, loopback-listener-other-local-users, dns-rebinding-loopback-service, launch-token-theft_
- **VIZ-32** Every request MUST pass the §3.10.3 admission checks in order before routing (exact `Host`, `Origin`, `Sec-Fetch-Site`, method, limits, remote address), and no failure response MAY echo request data. _Covers: dns-rebinding-loopback-service, cross-site-request-to-loopback_
- **VIZ-33** Every response MUST carry the §3.10.4 header set with that CSP byte for byte (one line, directives in the listed order, `; ` separated, no trailing `;`); pages MUST contain no inline script or style. _Covers: xss-from-board-text, dns-rebinding-loopback-service_
- **VIZ-34** The API MUST be exactly the §3.10.5 routes with their parameter regexes; no parameter MAY name a file, gitdir, ref, oid or path; static assets MUST come from an in-memory map; stream events MUST carry per-process sequence ids and `Last-Event-ID` MUST be validated, resumed from the ring or answered with `reset`, and never echoed or logged; every SSE message MUST be ≤ 64 KiB; the stream MUST be read by the page with `fetch` and the session header, never `EventSource`. _Covers: path-traversal-local-server, viewer-token-in-claude-context_
- **VIZ-35** The API MUST serve only the §3.10.6 view-model allowlist and MUST NOT serve any item of its never-served list (notably `coauthor_optin`, `config_fingerprint`, `plugin_sha`, e-mails, absolute paths, this PC's OS user or host name, the remote URL, `status.json` params or `not_converged`, raw ops or fold state, blob content, tokens other than the one redemption, environment values, wall-clock fields). _Covers: recording-leaks-team-data, board-plaintext-and-permanence_
- **VIZ-36** Every served string from the board, a commit, a path, a branch, a folder, a demo log or `status.json` MUST pass the SEC-35 validators, `sanitize(…, 'viz')` with the §3.11 caps, and, for free text, `scanSecrets` with the D2 patterns (Plan 8b), a hit replacing the whole string with `[redacted: secret-scan]`. _Covers: teammate-text-as-instructions, xss-from-board-text, peer-normalization-secret-leak_
- **VIZ-37** Client code MUST insert data only through `textContent`, `createTextNode`, an input's `.value` or canvas `fillText`; lint `L-VIZ-DOM` MUST fail on the §9.5 sink list; the client MUST `fetch` only literal same-origin `/api/v1/` paths and MUST import no Node module. Every table keyed by a board-derived string, on the server and in the client, MUST be a `Map` or a null-prototype object. _Covers: xss-from-board-text, prototype-pollution-from-paths_
- **VIZ-38** Viewer logs MUST follow §3.10.10: one set of files per viewer instance, rotated only by its owner; SEC-38 content only; security events aggregated per code per 60 s; stack frames only as `{fn, line, col}` with basenames; and no URL, header value, token, name, note, label, path, error message or environment value. _Covers: peer-normalization-secret-leak, viewer-token-in-claude-context_

### Languages, accessibility, budgets and failures

- **VIZ-39** Every human-facing viewer string MUST be produced by the shared `render(code, params, channel, lang)` from the six human catalogs, in `L_h` resolved by the CLI as `user.json` → OS locale → `en` and passed to the viewer, unless the page's language switcher overrides it; the client MUST contain no human-text literal and MUST render no code outside the §3.11 table; every code of §3.11 MUST have templates in all six languages within the channel `viz` caps (Plan 8a has `en` only and is not released, §9.1). _Covers: path-quoting-and-git-locale, phrasing-blame-and-peer-text-injection_
- **VIZ-40** The page MUST honour `prefers-reduced-motion` with an in-page override, MUST offer a pause control that stops all scene motion, MUST be fully usable by keyboard with visible focus, MUST give the canvas a `UI_VIZ_SCENE_SUMMARY` label and a hidden per-character list, MUST rate-limit live announcements to one per 10 s, and MUST keep chrome text contrast ≥ 4.5:1. _Covers: motion-accessibility, colour-only-meaning_
- **VIZ-41** The viewer MUST stay within the §3.12 budgets, MUST keep at most 2,048 heights of timeline per room in memory, and MUST NOT measurably change any daemon's glossary §20 perf gates; it MUST NOT hold a handle on any file a daemon writes. _Covers: viewer-cpu-drain, viewer-holds-repo-handles_
- **VIZ-42** Every situation of §6 MUST show its stated sign; the page MUST NOT present a stale scene as live (a broken stream greys the live pill and shows `UI_VIZ_RECONNECTING`; when the 30 s retry and a reload of `/api/v1/world` both fail, or the viewer sent `bye`, the page shows `UI_VIZ_STOPPED`). _Covers: silent-stall-no-visible-surface_

---

## 5. Invariants

Enforced from the glossary and other chapters:

- **INV-CLOCK** (glossary §21): no viewer decision or display uses a remote wall clock; order is board position; live ages are local monotonic deltas (VIZ-11); the viewer's own lifetimes use own staleness, max(Δwall, Δmono) (VIZ-03).
- **INV-SECRET** (glossary §21), display side: nothing the viewer serves, logs or exports contains a blob, a `local_only` path in a recording or (rev 2.5, F34) postcard, or a scanner hit (VIZ-06, VIZ-29, VIZ-35, VIZ-36, FEAT-F34-05).
- **INV-EGRESS** (09-security, as amended in §9.3): the viewer adds no outbound connection; its listener is egress row E8 (VIZ-30).
- **INV-UX-READONLY** (10-product, as amended in §9.4): `view` changes no ref, hold record, claim, config or working-tree file (VIZ-06, VIZ-07).

Chapter-local:

| Id | Statement |
|---|---|
| **INV-VIZ-READONLY** | A viewer run changes no ref, object, index, worktree file or file under any `<gitdir>/cowork/`, opens no IPC connection and no outbound socket, and writes only its own user-only log files in the data directory. |
| **INV-VIZ-NOCONTENT** | (as amended by the owner decision of 2026-10-08, real-time claims) No live-code, `held/` or registry blob content, file content or diff ever reaches the page, a log, a file, an export or a recording. The viewer never reads `held/` or registry blob content, a diff, a working-tree file or a live-code tree object; the only blobs it reads are `ops.jsonl`, `protocol.json` and `checkpoint/state.json` of board commits and the live-code blobs `claimFoldNeeds` names for a board commit's claim fold — read only to fold that commit's claim state, held in memory for that one fold step and dropped (never written to disk, logged, cached across folds, sent to the page, rendered or counted; only claim structure — ids, holders, paths, ranges, labels, states — reaches the world model); the only trees are board `held` trees, for entry names. |
| **INV-VIZ-DET** | For a room, the same initial window (same `h0`, same first-parent board commits and live-commit trailers; the claim inputs are a function of the objects those commits reach, INV-REG-FOLD, so they add no PC-dependent input, and a PC missing such an object builds a shorter timeline, never a different one) and the same ordered sequence of extensions (live frames, earlier pages) give byte-identical serialized timelines and layouts on every PC, OS and run; live extension equals a fresh build; a look depends on `peer_id` alone; the timeline depends on neither `self`, the local overlay, a clock, an oid nor the page. |
| **INV-VIZ-BOARDONLY** | Every scene element outside the local overlay is the image of a folded board fact or of a trailer of a board-named live commit; nothing is inferred from time, transcripts or local files. |
| **INV-VIZ-LOOPBACK** | The viewer's only socket is one listener on `127.0.0.1`; it makes zero outbound connections and zero name lookups; no daemon bundle contains an HTTP server. |
| **INV-VIZ-AUTH** | No data route answers without a valid session token; a launch token authorizes at most one session within 120 s, and a second presentation of it ends that session and the viewer; no cookie exists. |
| **INV-VIZ-CUSTODY** | No viewer token appears in Claude-readable output, a log, a file written by cowork, an IPC frame, an HTTP request line, a `Referer`, or the URL bar after load. |
| **INV-VIZ-TEXT** | Every served string is an allowlisted view-model field that passed the validators, `sanitize(…, 'viz')` and, for free text, the secret re-scan; the client never parses a served string as HTML, script, CSS or URL. |
| **INV-VIZ-REEL** | (rev 2.5, F29) A reel plan is a pure function of the scene events of its range (grouped by `reelMoments`) and its options; it reads no layout ordinal, id value, language, anonymize flag, overlay, `self`, "you", clock or randomness. Making a reel sends only timeline-page requests, writes only the user's download and puts nothing on the board. |

---

## 6. Failure handling

| Situation | Detection | Behaviour | What the human sees | What Claude sees |
|---|---|---|---|---|
| A room's daemon is down | a parsed heartbeat older than 3 loop periods (machine monotonic), or `status.json` missing while `live` exists | overlay `down`; the folded history stays; polling continues | dim room, `UI_VIZ_ROOM_DOWN` | nothing (the viewer has no Claude surface) |
| `status.json` being replaced while read (Windows) | `EPERM`/`ENOENT` on the short read | keep the previous overlay; retry next tick (the daemon's own write retries 3 × 50 ms) | nothing new | — |
| `status.json` over 1 MiB or unparseable | read cap, JSON parse | keep the previous overlay; never `down` from it | `UI_VIZ_STATUS_UNREADABLE` on the lamp | — |
| No board ref yet (before genesis) or the ref vanished; a board or live object missing (a partial clone: transports are disabled, VIZ-07) | `rev-parse` or `cat-file` fails | the room is shown empty, or stays at its last folded scene | `UI_VIZ_NO_BOARD` | — |
| (owner choice of 2026-10-08) An object the claim inputs of a board commit need is not in the local store (a partial clone, or not fetched yet), or another claim-input read fails | `cat-file` reports it missing; the read fails | fold nothing at or after that board commit; keep the last folded scene; retry when the board ref's storage changes, else every 30 s; never fold without the inputs; a page request that needs those heights gets 404 `UI_VIZ_CLAIMS_PENDING` | `UI_VIZ_CLAIMS_PENDING` | — |
| The gitdir moved or was deleted, or its `live` marker was removed | Fs read error; the 30 s marker check | the room greys out and keeps its folded history; removed at the next viewer start | `UI_VIZ_ROOM_GONE`; `UI_VIZ_NO_ROOMS` when no room remains | — |
| A new live clone appears in `repos.json` | the 30 s `repos.json` check | the room is appended to the map (no re-sort) | a new room cell | — |
| Board rewritten (new tip not a first-parent descendant of the last folded commit) or `status.json.state = incident` | first-parent check; overlay | stop folding; keep the last scene; rebuild from the tip after a non-incident state with a fresh heartbeat (VIZ-14) | siren and `UI_VIZ_INCIDENT_FROZEN` | — |
| Checkpoint differs from the viewer's fold (a defect: the viewer folds claims with the daemons' inputs) | byte compare at checkpoint heights, every member | badge; keep folding the viewer's own state (no re-seed) | `UI_VIZ_CHECKPOINT_MISMATCH` | — |
| Viewer and daemon versions differ | `status.json.plugin_version` | badge; fold with the viewer's build | `UI_VIZ_VERSION_SKEW` | — |
| Board from a newer protocol, or op types this build does not know or folds as no-ops | fold `protoMismatch`; verdict `unfolded` or `rejected` | no scene events for those ops; count them | `UI_VIZ_NEWER_PROTOCOL`; the unknown count in the room tooltip | — |
| Malformed board commit (bad `Cowork-Writer`, over the caps) | the fold's own rules | deterministic no-op frame | nothing (count only) | — |
| Very long board | tip height | initial window of 1,024–1,279 heights; earlier pages on request; at most 2,048 heights kept in memory, older ones re-folded on request | the rewind bar starts at `h0`; "load earlier" | — |
| A fetch reveals more than 64 board commits at once (after sleep or offline) | `rev-list` count | one `room_snapshot` instead of beats | crossfade to the new scene; "caught up" | — |
| Many paths (16+ zones, 24+ files in a zone, a tall office) | allocator | `…` zone, folder desks, shelf desks; the office scrolls | folder desks, shelf desks with "+n"; the coarse view on request | — |
| Many peers (57+ in a room, 17+ without desks) | look table, home spots | repeated looks with handles; a cluster by the door | name tags with handles | — |
| More than 32 rooms | discovery | the first 32 in order | "+n" on the map | — |
| Hostile or forged board text | validators, sanitize, scan, text-only sinks | cleaned, redacted or `?` | cleaned text | — |
| Launch link presented a second time (a double open, or a local thief who redeemed first) | redemption check | revoke the session, `bye` on every stream, `SEC_VIZ_LAUNCH_REUSED`, exit `VIZ_EXIT_LAUNCH_REUSED` | `UI_VIZ_LINK_REUSED` on the presenting page; `UI_VIZ_STOPPED` on the others | — |
| Launch link presented after its TTL | redemption check | 401, `SEC_VIZ_LAUNCH_EXPIRED` (the viewer is exiting) | `UI_VIZ_LINK_EXPIRED` | — |
| Tab reloaded | `sessionStorage` | continues | normal page | — |
| Tab closed | no stream, no request | exit after 10 min | — | — |
| Stream broken | read error or end without `bye` | retry with `Last-Event-ID` 1 s doubling to 30 s, then reload the world | grey live pill, `UI_VIZ_RECONNECTING` | — |
| Resume point no longer in the ring (more than 4,096 events or 10 min) | `Last-Event-ID` check | one `reset`; the page reloads the world | a short crossfade | — |
| The viewer is gone (the retry at 30 s and the world reload both fail) | fetch errors | stop retrying | `UI_VIZ_STOPPED` | — |
| DNS rebinding, `0.0.0.0` route, cross-site request, framing | Host / Origin / Sec-Fetch / CSP | 421 / 403 / refused frame; counted | nothing | — |
| Another local user probes the port | missing token | 401; counted | nothing | — |
| Plugin removed or updated | 30 s hash check of `dist/viz.js` | exit `VIZ_EXIT_PLUGIN_REMOVED` | `UI_VIZ_STOPPED` | — |
| Plugin disabled but still installed | not checked (no settings file is read) | the read-only viewer runs on until its idle exit or lifetime | normal page | — |
| `dist/viz.js` differs from `dist/SHA256SUMS` at start (Plan 8b) | CLI hash check | nothing spawned | `SEC_REFUSE_RUNTIME_INTEGRITY` | framed refusal |
| The data directory fails the SEC-20 owner/ACL verification | CLI or viewer check | nothing read, nothing logged | `RF_VIZ_START_FAILED` | framed refusal |
| `--repo` or `--demo` names a UNC or device path, or `--demo` is not a regular file | CLI path check; viewer `lstat` | refuse | `RF_VIZ_REPO_NOT_LIVE` / `RF_VIZ_DEMO_INVALID` | framed refusal |
| Port reused by another process after exit | — | an open tab may get foreign responses; text-only rendering bounds the impact | possibly wrong text, or `UI_VIZ_STOPPED` | — (residual, §8 Q10) |
| No opener or no display | spawn error; no `DISPLAY`/`WAYLAND_DISPLAY` | the viewer exits after 120 s | tty: the URL (`UI_VIZ_URL`); slash/pipe: `UI_VIZ_OPEN_FAILED` with the terminal command | the framed slash text, never the URL |
| git missing or below 2.43 | the runner's version floor | the viewer reports a refusal on its ready line and exits | `START_TOOL_VERSION` (existing code) | framed refusal |
| `repos.json` missing, corrupt or not user-only | read, schema, CFG-06-style ACL check | treated as empty; `--repo` still works | `RF_VIZ_NO_ROOMS` when nothing remains | framed refusal |
| Invalid demo file | parser | refuse the whole file | `RF_VIZ_DEMO_INVALID` with the line number | framed refusal |
| `MediaRecorder` unavailable, or neither VP9 nor VP8 WebM supported | feature check | WebM disabled; GIF still offered | `UI_VIZ_RECORD_UNSUPPORTED` | — |
| The tab is hidden during a WebM recording | `visibilitychange` | stop and save what was recorded | `UI_VIZ_RECORD_INTERRUPTED` | — |
| GIF reaches 10 MB | running size | stop and save what was encoded | `UI_VIZ_RECORD_CAP` | — |
| (rev 2.5, F34) Clipboard API or PNG clipboard unsupported | feature check | Copy picture disabled; save and text still offered | `UI_VIZ_POSTCARD_COPY_UNSUPPORTED` | — |
| (rev 2.5, F34) Clipboard write refused | rejected promise | no retry | `UI_VIZ_POSTCARD_COPY_FAILED`; text left selectable | — |
| Claude runs `node cli.js view` through Bash | indistinguishable from `slash` | a window may open; no token in the output | a viewer tab | the framed `UI_VIZ_OPENED` only (§8 Q5) |

---

## 7. Tests

Every test runs on the three CI operating systems unless marked. Fixtures use synthetic peers, fictional names and paths.

| Test | Kind | Proves |
|---|---|---|
| T-VIZ-timeline-fixtures: one hand-built `BoardDraft` fixture per §3.4 row (ops, trailers, live-commit shapes, derived thresholds) folded by the build's `foldCommit` → expected scene events with positions `(height, sub, k)` as golden JSON; ops whose verdict in this build is `unfolded` produce no events and count in `unknown` (asserted, and the fixture is marked for its plan); the genesis `L0` (`Cowork-Base`) makes only `room_open`; a board-only publish makes no code event; a save completion `Ls` makes only `save`; a base move makes `room_sign` and no `publish`; a `local_only` stub makes no desk; positions are unique | unit | VIZ-08, VIZ-10, VIZ-12 |
| T-VIZ-append-only: 2,000 generated frames (fast-check, ops of every §3.4 row the build folds) split at random heights 50 times; the chain of `extendTimeline` calls serializes (§3.3.5 "Serialization") byte-equal to one `buildTimeline`, including `segments` and their start scenes | property | VIZ-10, INV-VIZ-DET |
| T-VIZ-self: the same window folded with `self` = each peer and = zeros gives identical timelines | unit | VIZ-08 |
| T-VIZ-clock: the same fixtures with commit dates shuffled, reversed and set to 1970 give identical timelines; no viewer surface renders a date | unit | VIZ-11, INV-CLOCK |
| T-VIZ-layout: appending paths never moves an existing desk; the 16th zone maps to `…`; the 24th file of a zone maps to its shelf; `zone(p)` uses two segments for three-segment paths; rewinding keeps the head layout with dashed future desks; the same window twice gives the same layout; "load earlier" appends the earlier page's new desks after every existing one and changes no ordinal; a growing office never changes `Z` and never enters the coarse view; home spots, cell and slot origins, chair and visitor tiles are at the §3.5.2 coordinates, and A\* reaches every chair, visitor tile and home spot from the door in a 64-cell office | property | VIZ-16 |
| T-VIZ-placement: `cs_id` grammar (human, seat, a human id naming another peer), target-desk ties, chair precedence with claims and publishers, the 5th visitor "+n"; across all fixtures, the only actor-to-actor walks come from `request_open` | unit | VIZ-17 |
| T-VIZ-looks: the same `peer_id` gets the same look in every room, in two windows with different `h0`, before and after "load earlier", and on every run; renaming changes no look; two peers with equal names or equal looks both show their handle | unit | VIZ-18 |
| T-VIZ-palette: the scene-contrast tests (outline vs both floor tones ΔE ≥ 20, eye white vs body ≥ 15, cheek vs body ≥ 10, with the bounded L* adjustment), then the colour-vision ΔE test of §3.6, and the accessory ΔE ≥ 15 test for every (accessory, hue) | unit | VIZ-19 |
| T-VIZ-frames: the art layers of 20 fixture scenes (normal and reduced motion), composed by `src/viz/render/raster.ts` into RGBA buffers, hash to checked-in values; no icon is a font glyph | unit | VIZ-19, VIZ-22 |
| T-VIZ-anim: every scene event kind maps to its §3.7 state and reduced form; no state is entered without an event; a persistent "!" exists only while its hold record is non-terminal and an event-sourced "!" lasts one beat; with a fake rAF clock the loop draws ≤ 12 fps, ≤ 2 draws/s for an idle room, and stops when nothing animates | unit | VIZ-22 |
| T-VIZ-pets: `seat_start`, a first-footprint spawn without `seat_start`, `seat_end`, epoch retirement, `presume_absent`, `leave`, and the owner of a footprint-only seat becoming a ghost → exactly one pet per seat key, in its owner's colours | unit | VIZ-21 |
| T-VIZ-bubbles: durations for Latin, Hangul, Han and kana texts; the 1.5 s and 6 s clamps; truncation at 42/16; one per actor, three per room; replay at 8× floors at 1.0 s | unit | VIZ-23 |
| T-VIZ-log: per fixture the card list is exactly §3.8 (conversation, conflict, activity, system); `request_status` is a chip; consecutive publishes of one actor merge with ≤ 5 chips and "+n"; character click, person, file and kind filters AND-combine; a live card the viewer saw arrive shows its age from `seen_ms`, a pre-open card shows `#height` and `UI_VIZ_SEEN_BEFORE_OPEN`, and a reload keeps both | unit | VIZ-24, VIZ-11 |
| T-VIZ-notes: teammate text (notes, request and answer notes, names) appears only in the quoted frame and is never passed to `render` as a code or translated; transcript, prompt and tool-input canaries planted in the fixture PC's Claude directories are in no response, log line or export | unit | VIZ-25 |
| T-VIZ-overlay: each `status.json` state; a heartbeat 3 loop periods + 1 ms old → `down`; a missing `status.json` with `live` present → `down`; a 2 MiB or unparseable `status.json` → `UI_VIZ_STATUS_UNREADABLE` and never `down`; the offline age from `last_fetch_age_ms`; a seek to `h1 − 10` draws no overlay element; overlay values appear in no timeline JSON, recording frame or other room | unit | VIZ-13 |
| T-VIZ-seek: at 200 random positions, `reduceScene` from the window start equals reducing from the nearest cached 64-height scene, and equals the live scene captured at that position minus overlay and animation phase; a seek below `h0` or below the 2,048 retained heights folds ≤ 255 commits (fold-call counter), and the re-folded events of a dropped range equal the events first served for it; after three "load earlier" pages the scene at 100 random positions above the old `h0` is unchanged, and the page's `reduceScene` over view-model ids equals the server's over board ids (projected) at every tested position | property | VIZ-26, VIZ-09 |
| T-VIZ-start: checkpoint fixtures whose fold state holds an active, an absent, a ghost, a frozen (newest event `freeze`), a slowed (`HOST_THROTTLED` 100 heights before `hs`), a different-rules and a credit peer, live and ended seats → `startScene` gives exactly the §3.3.5 start scene (characters at home spots, pets behind them, badge from `record_count`, empty beat); the first `pose_relaxed` of an actor comes 64 heights after its first publish in the segment; `TimelinePage.scene` at a segment start is that segment's start scene | unit | VIZ-10, VIZ-26 |
| T-VIZ-demo-format: valid logs fold to the expected timeline; `protocol` is carried from height 0 and no demo frame reports `protoMismatch`; each kind of invalid record of the §3.9.3 table (including a height-0 record without `protocol`, an unknown field, a caption with both `code` and `text`, and a `csPaths` key that names no `cs` entry) refuses with its line number; interleaved rooms and a `held` list fold as on a board; (owner decision of 2026-10-08) a record with `live` and `claims` folds its claim ops with those answers to the claim records and `claim_take`/`claim_move`/`claim_release` events the git source gives for the board it was exported from, a question the `claims` table does not answer folds as `ABSENT` or overlapping (the claim folds invalid and is never drawn as valid; not a refusal), every record without `claims` still folds with (empty) claim inputs, the bundled demo and every exported demo answer every question, `live` on an unchanged record refuses, and no `claims` content but oids, paths and booleans parses; an op line that fails `parseOpLine` is a fold no-op exactly as on a board; a FIFO, a directory, a UNC path and a 4 MiB + 1 byte file are refused; a demo run spawns no git process (spawn spy) and opens no data-directory file except its log | unit | VIZ-27, VIZ-06 |
| T-VIZ-golden-sim: SIM seeds `viz-golden-1..3` (profile `edits`, 3 peers) → (a) the viewer's timeline read through git from SIM peer 0's clone (`--repo <peer0>`, its `refs/cowork-remote/<e>/board` after quiescence) and (b) the timeline of the demo log that `tools/viz/export-demo.ts` writes from the same board are byte-identical on every OS, and a second run is byte-identical; on the Linux leg both equal `test/golden/viz/<seed>.timeline.json` (other legs compare with the golden only once TST-03 promises identical boards across OSes); the golden changes only through `npm run viz:golden -- --update` with the diff reviewed in the PR (Plans 3–7 update it as their fold effects land) | integration (SIM) | INV-VIZ-DET, VIZ-08, VIZ-27 |
| T-VIZ-readset: a 3-clone fixture (live, paused, incident) with a filtered secret file, a planted `tmp/stage/` copy and a `local_only` registry record holding a canary; every git argv matches `L-VIZ-GIT` and carries the transport-disabling flags; no argument names `refs/cowork-local/`; `cat-file` stdin names only board commits, `<oid>:ops.jsonl`, `<oid>:protocol.json`, `<oid>:held`, `<oid>:checkpoint/state.json`, live commit objects and (owner decision of 2026-10-08; with a claim on a tracked file in the fixture, Plan 4) exactly the `<commit>:<path>` names and `base_blob` oids `claimFoldNeeds` lists for the board commits that carry `claim` ops — no other live-code path, no `held/` or registry blob, no tree object; `merge-base --is-ancestor` runs only for their tombstone anchors; a canary line in the claimed file appears in no response, log line, written file or export; no `cat-file` process serves two batches; an fs spy sees no open under `tmp/`, `log/`, `prov/`, `cs/`, any worktree, `ipc.key`, `user.json` or a Claude settings file; the canary appears in no response, log line or export | integration | VIZ-06, VIZ-07, INV-VIZ-NOCONTENT |
| T-VIZ-nocontent (owner choice of 2026-10-08): a two-peer board whose claimed function's lines in the live-code blob hold a planted string `COWORK_VIZ_CANARY_<run>`, with a second peer's overlapping claim on the same path (an overlap answer reads both anchor blobs) and a re-anchored claim with a tombstone (an ancestry answer is asked); the viewer folds and draws the claims (`claim_take` for the valid one, so the blobs were read); the canary appears in no HTTP response body or header of any route, no stream payload, no line of any file under `<data dir>/log/`, no other file the viewer process writes (an fs spy over the run sees writes to its log files only: no cache, temp or dump file), no byte the viewer writes to stdout or stderr, and no demo log or golden exported from that board; after the run no frame, fold state, timeline, kept checkpoint state, carry, card or view model holds a `Buffer` or a string containing the canary (a deep scan) | integration | VIZ-06, VIZ-35, INV-VIZ-NOCONTENT, INV-SECRET |
| T-VIZ-claim-fold (owner choice of 2026-10-08): a 4-peer SIM `claims` board of ≥ 1,300 heights read through git → every checkpoint compares match and the frames' claim verdicts and states equal the daemon fold (`Folder` with its resolver) at every height; a demo exported from it (with `live` and `claims`) folds to the byte-identical timeline; one claim-input answer flipped by a test seam → `UI_VIZ_CHECKPOINT_MISMATCH` at the next checkpoint while the viewer keeps its own state; a promisor fixture missing a claimed blob → `UI_VIZ_CLAIMS_PENDING`, 0 connections, the window stops below that commit, and after the object is added the next retry extends it with the events a fresh build gives | integration | VIZ-07, VIZ-08, VIZ-09, INV-VIZ-DET |
| T-VIZ-poll: with no ref change, 60 s of polling 8 rooms runs at most one `rev-parse` per room and no other git process (a room waiting for claim inputs adds at most two `cat-file --batch-check`); a loose-ref update, a `git pack-refs --all` and (where the CI git supports it) a reftable repository each trigger a `rev-parse` within one tick; a fetch of 3 commits costs `rev-list` + 2 `cat-file --batch` | integration | VIZ-07, VIZ-41 |
| T-VIZ-readonly: refs (`for-each-ref` of everything), `count-objects -v`, index bytes, worktree and `<gitdir>/cowork/` listings and mtimes are identical before and after 10 virtual minutes of live polling, replay seeks and "load earlier" | integration | INV-VIZ-READONLY |
| T-VIZ-no-network: with `net.Socket.prototype.connect`, `dns.lookup` and `http.request` instrumented, a viewer run makes 0 outbound connections and 0 lookups, and the process has exactly one listening socket, on `127.0.0.1`; a promisor (partial-clone) fixture with a missing live commit object makes 0 connections from git children (the room shows `UI_VIZ_NO_BOARD`) | integration | VIZ-30, VIZ-07, INV-VIZ-LOOPBACK |
| T-VIZ-env: in a test build the spawner is pointed at a probe child that writes `Object.keys(process.env)` and `process.cwd()` in its ready line; the CLI started with `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_PLUGIN_DATA`, `NODE_OPTIONS` and `GIT_DIR` set → none of them in the child's environment, its cwd is the data directory, and its argv carries `--data-dir`, `--lang` and `--sha256`; on Linux the real viewer's `/proc/<pid>/environ` is checked too; the messaging token appears in no file under the data directory | integration | VIZ-02 |
| T-VIZ-handshake: a child that sleeps past the ready window (6 s; 16 s on Windows), or prints a malformed line → `RF_VIZ_START_FAILED` and its whole process tree is gone; a planted `taskkill.exe` in the CLI's cwd is never executed; a data directory with a foreign ACE → `RF_VIZ_START_FAILED`, nothing read; from Plan 8b, a `viz.js` that differs from `SHA256SUMS` → `SEC_REFUSE_RUNTIME_INTEGRITY`, nothing spawned | integration | VIZ-02 |
| T-VIZ-cli-modes: `tty` with and without `--no-open`, `slash` (`CLAUDECODE=1`, non-TTY), `pipe`, `--json`: a 64-hex launch token occurs only in `tty` output with `--no-open` or a simulated open failure; slash output is framed and ≤ 4,000 chars; `pipe` starts no viewer; `--no-open` in `slash` or `pipe` mode starts no viewer and prints `UI_VIZ_TERMINAL_ONLY`; `--demo` with `--repo` → `RF_UNKNOWN_FLAG`; no `--json` envelope has the URL | integration | VIZ-04 |
| T-VIZ-lifetime (fake Clock): unredeemed 120 s → exit `VIZ_EXIT_LAUNCH_UNUSED`; a simulated suspend gap (Δwall advances, Δmono does not) counts toward the TTL, the idle exit and the lifetime; 10 min without stream or request → exit; an open stream keeps it alive; 24 h → exit; `dist/viz.js` rewritten → exit within 30 s; `SIGTERM` → exit and a `bye` event | unit | VIZ-03 |
| T-VIZ-incident: a non-FF board rewrite with `status.json.state = incident` → no commit of the new chain folded, the room frozen with its badge; after a non-incident state with a fresh heartbeat → rebuilt from the new tip | integration | VIZ-14 |
| T-VIZ-version: a different `plugin_version` → `UI_VIZ_VERSION_SKEW`; a board op of an unknown type → no event and `unknown` = 1; a `claim` op in a Plan 2 build → verdict `unfolded`, no event; `proto = 2` → `UI_VIZ_NEWER_PROTOCOL`; a corrupted checkpoint, including one that differs only in its claim records → `UI_VIZ_CHECKPOINT_MISMATCH` and folding continues from the viewer's own state (no re-seed) | integration | VIZ-08, VIZ-09, VIZ-15 |
| T-VIZ-contention (Windows legs): a writer replaces `status.json` by temp+rename every 100 ms for 3,000 writes, and a daemon fixture updates `refs/cowork-remote/<e>/board` by fetch 1,000 times, while the viewer polls → zero rename or ref-update failures beyond the no-viewer control | integration | VIZ-07, VIZ-41 |
| T-VIZ-perf (Windows and Linux legs): 8 rooms × 1,024 heights, one of them carrying claim ops (owner choice of 2026-10-08) → first `/api/v1/world` ≤ 3 s; git processes counted per tick and per batch; 60 s idle CPU including git children ≤ 1 % of one core; a 255-commit seek ≤ 500 ms; RSS after extending one room live by 17,280 heights ≤ 200 MB with ≤ 2,048 heights retained | integration | VIZ-41 |
| T-VIZ-stream: two rooms; new commits fetched by a daemon fixture → stream events equal `extendTimeline`; no SSE message exceeds 64 KiB; 65 commits in one tick → one `room_snapshot`; a resumed stream with `Last-Event-ID` loses nothing in either room and of any kind; an id outside the ring, malformed or larger than the current sequence → `reset`, never echoed or logged; `SIGTERM` → `bye` | integration | VIZ-34, VIZ-42 |
| T-VIZ-token: shapes (wrong length, upper case, non-hex, near miss) → false without throwing; correct → true; `timingSafeEqual` always receives two 32-byte digests | unit | VIZ-31 |
| T-VIZ-launch: redeem once → 200; again → 401 `UI_VIZ_LINK_REUSED`, a `bye` on the first session's stream, `SEC_VIZ_LAUNCH_REUSED` and process exit `VIZ_EXIT_LAUNCH_REUSED`; at 121 s (exit delayed by the test) → 401 `UI_VIZ_LINK_EXPIRED`; a request without `Origin` on the POST → 403 | unit | VIZ-31, VIZ-32 |
| T-VIZ-admission: `Host` ∈ {absent, `localhost:p`, `127.0.0.1`, `127.0.0.1:p.`, `[::1]:p`, `0.0.0.0:p`, `evil.test:p`, userinfo} → only the exact value passes; `Origin` and `Sec-Fetch-Site` variants; `OPTIONS` with `Access-Control-Request-Private-Network` → 405 with no `Access-Control-*`; oversize headers, slow headers, a body on GET, an absolute-form target, `Upgrade: websocket`, `CONNECT` | unit | VIZ-32, VIZ-30 |
| T-VIZ-headers: every route × status code carries the §3.10.4 set, the CSP byte-equal to the one-line form, and no `Set-Cookie`, `WWW-Authenticate`, `Access-Control-*`, `Server`, `ETag`; JSON escapes `<`, `>`, `&`, U+2028, U+2029 | unit | VIZ-33, VIZ-31 |
| T-VIZ-routes: unknown paths → 404; room-id fuzz (lower case, `I`, `L`, `O`, `U`, 7 or 9 characters), `..`, encoded slashes and path-like parameters → 404/400; an upper-case room id from the world snapshot → 200; `lang` outside the six codes → 404; an fs spy sees no file access caused by a URL | unit | VIZ-34 |
| T-VIZ-view-model: a fold whose `PeerRec` has `coauthor_optin: "Ann <ann@corp.example>"` and a full `config_fingerprint` → no response contains the e-mail, the name from that field or any fingerprint key; with an OS user name and host name different from every fixture name, no response matches an absolute-path pattern, the OS user or host name, the `pinned_url` from `repos.json` or a 64-hex token (outside the redemption) | integration | VIZ-35 |
| T-VIZ-api: every response of every route and every stream payload of T-VIZ-stream, T-VIZ-failure-signs and the demo validates against the JSON Schemas generated from the §3.10.6 types, with no additional property; a served card is never re-sent with changed fields (chips and answer nesting are page-side joins); a `timeline` page never spans a segment start; a `room` event with `change: 'added'` is followed by a world reload in the page | integration | VIZ-34, VIZ-35 |
| T-VIZ-text: names, notes, labels, paths, branch and folder names and demo captions carrying `<img src=x onerror=…>`, `</script>`, `javascript:`, ANSI/OSC 8/OSC 52, bidi overrides, zero-width and tag characters, URLs, `ghp_…`, AWS keys and 10 KB strings → served text has no `<`/`>`, no control, no URL, respects the caps, and (Plan 8b) secrets are `[redacted: secret-scan]`; the paths `__proto__/a.ts`, `constructor/b.ts`, `prototype/c.ts` and a root file `__proto__` lay out as ordinary desks and change no object prototype on the server or in the client | unit | VIZ-36, VIZ-37 |
| T-VIZ-anonymize (CI browser): every §3.4 fixture is recorded with canary strings in names, handles, paths, labels, branch, room label, `note.text`, `request.note`, `answer.note` and a caption; a `fillText` spy on the recording canvas sees none of them with anonymize on, and no `local_only` stub path with anonymize on or off; a real-room recording defaults to anonymize on, and turning it off shows `UI_VIZ_RECORD_NOTICE` before the first frame; the map, the log and the overlay are in no frame | CI browser | VIZ-29 |
| T-VIZ-recording: frames come from the virtual clock (a tab hidden mid-GIF still yields every frame; a hidden tab ends a WebM with `UI_VIZ_RECORD_INTERRUPTED`); the camera moves at most one tile per 100 ms and only vertically; WebM uses only VP9 or VP8, else the option is disabled; the GIF stops at 10 MB | CI browser | VIZ-28 |
| T-VIZ-opener: URL fuzz (spaces, quotes, `&`, `%`, `^`, newline, `--flag`, `file:`, another host, a 63-hex token) → never spawned; a valid URL → spawn spy shows an absolute executable, an argv array, `shell: false`, cwd = the data directory; on Windows a planted `explorer.exe` in a repository directory is never executed; on Linux, with no `repos.json`, an executable `xdg-open` planted in `<cwd repo>/bin` with that directory first on `PATH` plus an empty `PATH` entry is never executed, a group-writable candidate is skipped, and the opener child's `PATH` holds only filtered entries | unit | VIZ-05 |
| T-VIZ-logs: after the admission and text corpora, `viz-*.jsonl` holds no token, header value, name, note, path, URL, `err.message` or absolute path, and at most one line per code per 60 s; two concurrent viewers write only their own `viz-<instance>-*` files and each rotates only its own; files older than 14 days are deleted at start | integration | VIZ-38 |
| T-VIZ-failure-signs: every §6 row with a human sign is driven by a fixture and shows that sign (rows tagged rev 2.5 run only once their feature's task has merged, with its §9.9 codes: the two F34 clipboard rows from the 8b task "Postcards"; merge round 2); a viewer killed mid-stream → `UI_VIZ_RECONNECTING`, then `UI_VIZ_STOPPED` once the 30 s retry and the world reload fail; a room appended to `repos.json` appears within 30 s and a removed `live` marker greys its room | integration | VIZ-42 |
| T-VIZ-lints: metafile — `node:http` only in `viz.js`, no `src/viz/**` module in `daemon.js`, `hook.js`, `core.js`, `mcp.js`, `worker.js`, only `src/viz/cli/**` in `cli.js`, no third-party module in `viz.js`, `dist/viz.js` ≤ 1.5 MB; `L-VIZ-DOM` (every §9.5 sink), `L-VIZ-GIT`, `L-VIZ-IMPORT` each fail on a planted violation; `L-DIST` includes `viz.js`; the UX-01/I18N-07 lints cover `viz.js` and `src/viz/client/**`; no URL literal other than the allowlisted template; no CLI spawn of a bare executable name; the client bundle contains no module that imports `src/board/fold.ts` (`model/frame.ts`, `model/timeline.ts`, `model/start.ts` are server only, §3.13) | CI lint | VIZ-01, VIZ-20, VIZ-37, VIZ-39 |
| T-VIZ-i18n: every §3.11 code renders in all six catalogs at worst-case params within the channel `viz` caps; placeholder sets equal across languages; every code the client and the server can emit (collected from the source) is in the §3.11 table; the CLI-resolved `--lang` reaches the page under the builder's `LC_ALL=C` | CI lint | VIZ-39 |
| T-VIZ-browser-smoke: on the Node ≥ 22 legs, the runner's preinstalled Chrome or Chromium is started headless with `--remote-debugging-port=0` and driven over the Chrome DevTools Protocol with Node's built-in `WebSocket`, so **no package is added** (not even a dev dependency): (a) after load the URL has no fragment; (b) zero CSP violation reports; (c) every request goes to the viewer origin; (d) a reload keeps working, and a second tab opened with the same link shows `UI_VIZ_LINK_REUSED` while the first shows `UI_VIZ_STOPPED`; (e) XSS canary fixtures never set `window.__pwned`; (f) a page served from another local port can read nothing from `/api/v1/world` with or without a copied session header, and an iframe of the viewer is refused; (g) with emulated `prefers-reduced-motion` the root carries `data-motion="reduced"` and no walk frame is drawn; (h) a 3 s GIF of the bundled demo starts with `GIF89a` and stays under the cap; (i) the scene summary label and the hidden people list exist; (j) (rev 2.5, F34; Plan 8b) a postcard is saved and copied (T-F34-download, T-F34-clipboard); (k) (rev 2.5, F32) T-VIZ-follow-privacy, its recording clause run from Plan 8b. Without Chrome the test reports SKIPPED; a release requires one green run (REL-) | CI (browser) | VIZ-31, VIZ-33, VIZ-37, VIZ-40, VIZ-28, FEAT-F32-01, FEAT-F32-10, FEAT-F34-06, FEAT-F34-07 |
| T-VIZ-manual (Windows, macOS, Linux checklist): with Chrome, Edge and Firefox each as the default browser, the opened page receives `#k=` (redemption returns 200); no firewall prompt; on Linux `ps -ef` during start shows only a token that is already redeemed afterwards; NVDA or VoiceOver reads the scene summary and the people list; a GIF and a ≤ 40 s WebM of the bundled demo play in a browser and upload to a GitHub README | manual | VIZ-05, VIZ-28, VIZ-40 |
| T-F04-moments (rev 2.5, F04): the timeline of F04's SIM board `SB-F04` (peers A = you, B, C; human and fake seats) with `you` = A → golden `{mine, team, routine}`; deep-equal across `extendTimeline` splits; `you = null` → mine empty; no import of clock, I/O or DOM (lint) | unit | FEAT-F04-13 |
| T-F04-visit (rev 2.5, F04): A publishes `origin=prompt` at 40 and `origin=wake` at 60; the view opens at `open_h` 90 → last visit 40; variant with A's save at 70 → 70; variant with no A fact in the window → `UI_VIZ_CATCHUP_OLDER`; served JSON has no visit field for any peer; recording frames identical with and without the panel | unit | FEAT-F04-13 |
| T-VIZ-follow-camera (rev 2.5, F32): office of 12 cells (44 tiles tall, §3.5.2), view of 20 tiles at the top (rows 0–19). Peer A's character at the slot-0 chair of cell 0 (y 6), its pet at the slot-0 chair of cell 1 (y 6), both visible; peer B publishes at a desk of cell 11 → `null`. A's pet walks to the slot-0 chair of cell 10 (y 36) → the frame (rows 5–37, 33 tiles) does not fit → `cameraTarget` centres the pet's tile, clamped to the office (view rows 24–43). Both A actors then walk to the slot-0 chairs of cells 3 and 4 (y 16, above the view) → the frame (rows 15–17) fits and is centred (view top at row 6.5; the panel scrolls by device pixels); one of them then walks to cell 5 (y 16, inside the view) → `null` (step 1); a chip click → the frame is centred even so (`force`). After `userScrolled()`: a B beat and an A beat with no `place` change → no scroll; the next A move → scroll. Room 2 without follow: the 30 s rule scrolls to an off-screen event only 30 s after the last user scroll | unit | FEAT-F32-03, FEAT-F32-04 |
| T-VIZ-follow-motion (rev 2.5, F32): fake scroller: 2× replay → a 300 ms smooth scroll; 4× → jump; emulated reduced motion and the in-page toggle → jump; seek, `room_snapshot`, "load earlier", room switch → jump; paused → no scroll call; zoom and coarse flag unchanged after 100 beats | unit | FEAT-F32-05, FEAT-F32-03 |
| T-VIZ-follow-now (rev 2.5, F32): hand-built scene: A has pets P1, P2; B has pet Q1; P1 holds 4 HELD claims and 1 STALE → 3 holding rows + `UI_VIZ_MORE` n=1, no stale row; R1 from P1 to Q1 with status `queued_until_turn_end` → asks row "asks {B's name} (R1)" with `UI_VIZ_ICON_QUEUED`; R3 from P1 with status null → asks row without an icon; R2 from Q1 to P2 → asked-by row; P2 `lastPublish` (40, 1001, 0) at the file desk `src/cart.ts`, the character (38, 1001, 0) → "last shared: src/cart.ts (#40)"; P2 then ends (`live` false) → the same row; variants: P2's newest publish at a folder desk → its plaque, at a shelf desk → its zone sign + `/…`, at the big table → `UI_VIZ_NOW_LAST_SHARED_TABLE`; A frozen with `PAUSED` → header label `PH_PAUSED`, A a ghost → no header label; A at home with nothing → `UI_VIZ_NOW_NOTHING`; A removed from `characters` → `UI_VIZ_NOW_NOT_HERE`; overlay canary (holds 7, incoming 5, A is "you") → no overlay value in the card; no row text contains a template of "working on" | unit | FEAT-F32-06 |
| T-VIZ-follow-plan2 (rev 2.5, F32): the Plan 2 storyboard demo (§3.9.3), following each of its three people over every height → only header, last-shared, empty or not-here rows; the last-shared row names the `target` desk and the height of that person's newest `publish` event in the segment at each height | integration | FEAT-F32-06, FEAT-F32-07 |
| T-VIZ-follow-replay (rev 2.5, F32): at the 200 random positions of T-VIZ-seek, `nowCard` and `cameraTarget` from the page's `reduceScene` in replay equal those the page captured live at the same position (both over view-model ids) | property | FEAT-F32-07 |
| T-VIZ-follow-filter (rev 2.5, F32): start → `LogFilter.peer` = A; file and kind filters AND-combine; choosing B or clearing the person filter or `Esc` (no export panel open) → follow ends in that room only; follow A in room 1, select room 2 (no follow, 30 s rule), back to room 1 → A followed again and `LogFilter.peer` = A; rooms 1 and 2 each have a "Minji" with different peer ids → following room 1's Minji follows nobody in room 2; a world reload in which A's handle is extended (R-V22 collision) → follow ends; a page reload → no follow, and `location.hash` never held follow state | unit | FEAT-F32-02, FEAT-F32-08 |
| T-VIZ-follow-keys (rev 2.5, F32): `F` with a person filter toggles follow and `aria-pressed`; `F` without one → nothing; `F` in the language select → nothing | unit | FEAT-F32-02, FEAT-F32-11 |
| T-VIZ-follow-privacy (rev 2.5, F32; browser smoke item (k)): with a two-room demo log, toggling follow 50 times, switching rooms and seeking → zero requests besides the timeline pages the seeks need; no `localStorage` change and no `sessionStorage` change except the selected room id that §3.2 item 11 keeps; `location.hash` never contains follow state; the viewer log gains no line. **Plan 8b clause** (recording is 8b, §3.9.4): a recording with follow on draws the same frames as with follow off | CI browser | FEAT-F32-01, FEAT-F32-10 |
| T-VIZ-follow-i18n (rev 2.5, F32): the eight follow codes render in every catalog (8a: `en`) within the caps with equal placeholder sets; their templates match none of: en `monitor\|track\|surveil\|spy\|supervis\|watch`; ko `감시\|추적\|모니터\|감독\|사찰`; ja `監視\|追跡\|監督`; zh-CN `监视\|监控\|追踪\|监督`; fr `surveill\|espionn\|traqu\|supervis`; es `vigil\|espi\|rastre\|supervis` | CI lint | FEAT-F32-09 |
| T-F34-frame (rev 2.5, F34): 12 fixture snapshots (Plan 2 storyboard positions, a 64-cell office, a replay position with dashed desks, a beat mid-walk, a beat with sparkles and planes, a pet facing a holder, a ghost, a frozen person) → `postcardCamera` values and art RGBA hashes equal `test/golden/viz/postcard.json`. Mid-walk actors stand at their `Place`. No sparkle, plane, bubble or published screen pixel appears. A snapshot whose overlay has a "you" marker and count chips hashes equal to the same snapshot without an overlay. Two runs give equal bytes | unit | FEAT-F34-02 |
| T-F34-text (rev 2.5, F34): the §3.9.5 en example is reproduced byte for byte from its fixture. Further fixtures give: replay → the `UI_VIZ_POSTCARD_REPLAY` line with `h1`, and a person frozen at the replay position but thawed at `h1` (and the reverse) gets the health label of the replay position; demo → the banner line; 20 characters that each have an item → 12 actor lines and "+8"; 20 characters of which 5 have no item → 12 actor lines and "+3"; a 40-claim pet → a line ≤ 400 ending in `UI_VIZ_MORE`; a ghost → no line; a character with no health label and no place item → no line; an idle pet and a pet whose `ssCode` is `SS_FULL` → no line; a big-table publish → `UI_VIZ_POSTCARD_LAST_SHARED_BIG`. Items are joined by the catalog's `UI_VIZ_POSTCARD_SEP` (`"、"` in ja and zh-CN); the client source holds no separator literal | unit | FEAT-F34-03 |
| T-F34-anonymize (rev 2.5, F34): canary strings in names, handles, paths, labels, branch, room label, `note.text`, `request.note`, `answer.note`, a caption text and a `local_only` stub path. With anonymize on, a `fillText` spy on the postcard canvas and the textarea's `.value` (the exact text Copy text writes) see no canary. With anonymize off, they still see no note canary and no stub path. `file-<j>` in the text equals the plaque drawn for the same desk. Two characters with the same look get `… 1` and `… 2`. After turning anonymize off and reloading, the switch is on. With anonymize off, the buttons are disabled until `UI_VIZ_RECORD_NOTICE` is in the DOM. With a panel open, `Esc` closes it and leaves the log filters unchanged | CI browser | FEAT-F34-04, FEAT-F34-05 |
| T-F34-never (rev 2.5, F34): the text (the `postcardLines` output in the unit leg; the textarea's `.value` and the T-F34-clipboard harness read-back in the browser leg) never matches `[0-9a-f]{64}`, `127\.0\.0\.1`, a room id anywhere in the text (`\br[0-9A-HJKMNP-TV-Z]{8}\b`, unanchored; the fixture's own room ids are also searched for literally), an absolute-path pattern, a date or clock pattern, or the fixture's OS user or host name. A name `@everyone` is copied as `＠everyone`, and a branch `here` gives `shop-app · here · #…` | unit + CI browser | FEAT-F34-05 |
| T-F34-clipboard (rev 2.5, F34; CI browser over CDP, clipboard permissions granted to the test profile): the harness reads the clipboard back **from a separate harness page on another origin** (a page the harness serves on another loopback port, as browser-smoke item (f) already does, opened over CDP with `clipboard-read` granted to that origin), never from the viewer page, whose §3.10.4 `Permissions-Policy: clipboard-read=()` blocks any read there; the test also asserts that `navigator.clipboard.read()` evaluated in the viewer page rejects. Copy picture → the read-back is an `image/png` that decodes to 960 × 540 and equals the preview canvas pixels. Copy text → the read-back equals the textarea. A spy shows `clipboard.write`/`writeText` called only within trusted click handlers, and a `Runtime.evaluate` without a user gesture triggers none. With `ClipboardItem` deleted → the button is disabled with `UI_VIZ_POSTCARD_COPY_UNSUPPORTED`. A stubbed rejection → `UI_VIZ_POSTCARD_COPY_FAILED`, no retry, and the textarea still holds the text | CI browser | FEAT-F34-06 |
| T-F34-download (rev 2.5, F34; CI browser, `Browser.setDownloadBehavior` to a temp directory): two saves → `cowork-postcard-1.png` and `cowork-postcard-2.png`. Each starts with the PNG signature, has IHDR 960 × 540, and has no `tEXt`, `zTXt`, `iTXt`, `eXIf` or `tIME` chunk; its bytes equal the `toBlob` output (the page added nothing). This pins CI Chrome's encoder only. A recording save still yields `cowork-view-1.gif` through the same helper | CI browser | FEAT-F34-07 |
| T-F34-quiet (rev 2.5, F34): a request spy sees zero requests while the panel opens, retakes, copies and saves; the server's request counter is unchanged. T-VIZ-headers, T-VIZ-readonly and T-VIZ-no-network pass unchanged with the postcard actions added to their scripts | CI browser | FEAT-F34-08 |
| T-F34-lints (rev 2.5, F34): each planted violation fails L-VIZ-DOM: `navigator.clipboard.readText()`, `.read()`, `addEventListener('paste', …)`, `document.execCommand('copy')`, `clipboard.write` in `client/log.ts`, `new ClipboardItem({ [t]: b })`, `new ClipboardItem({ 'text/html': b })`, a Blob-URL `href` outside `client/save.ts`, and an import of `src/viz/render/**` from `src/viz/ui/postcard.ts` (fails L-VIZ-IMPORT, which gains the `ui/** → render/**` rule, §9.5). The real client passes. T-VIZ-i18n renders every Postcard code of §3.11 and `UI_VIZ_ANON_NAME_NTH` in six languages at worst-case params within the caps, with equal placeholder sets | CI lint | FEAT-F34-03, FEAT-F34-06, FEAT-F34-07 |
| T-F34-perf (rev 2.5, F34): the panel's preview is drawn ≤ 250 ms after the click (64-cell office, 12 characters, 12 pets), measured in the browser smoke run | CI browser | FEAT-F34-09 |
| T-VIZ-reel-moments (rev 2.5, F29): a `conflict{k4, source: hold}` at 40 with `box` events of its `holdId` at 41 and 55 (terminal at 55) → one conflict moment, beats [40, 41, 55], complete; the same with the terminal `box` at 310 and range [1, 300] → incomplete; a `conflict{breach, source: event}` → complete, 1 beat; `request_open` at 60, `request_status{asked}` at 61, `answer{later}` at 62, `answer{grant}` at 63 → negotiation `go_first`, beats [60–63], complete, actors (from, holder); only `answer{later}` → incomplete; `request_status{returned}` → incomplete; a request opened at 0 with range [1, 300] → no moment, and its answer at 5 opens none; `person_freeze` with no thaw in range → incomplete; `person_enter`/`person_respawn` → `join`/`rejoin`; a `publish`, `note` or `claim_take` → no moment; the result is identical with `self`, overlay and every id replaced by its handle (projection) | unit | FEAT-F29-03 |
| T-VIZ-reel-plan (rev 2.5, F29): moments A conflict k4 beats [40, 41, 55], B go_first [60–63], C go_first [100, 101], D join [5], E freeze [120, 180], F handoff [200] incomplete, G save [290]; publishes at 10, 20, 30, 70, 80, 150, 210, 250; range [1, 300], N 5, cap 40 s, end card on → chapters D, A, B, E, G; steps: D intro + beat, montage n=3, A intro + 3 beats, B intro + 4 beats, montage n=2, E intro + 2 beats, montage n=2, G intro + beat, end n=5; `totalMs` = 23,900; titles `CH_JOIN`, `CH_CONFLICT{n:3}`, `CH_REQUEST{n:4}`, `CH_FREEZE`, `CH_SAVE`; golden JSON | unit | FEAT-F29-04, FEAT-F29-05 |
| T-VIZ-reel-fit (rev 2.5, F29): the same input with cap 20 s → D dropped, then E (its gap merges: one montage n=5) → chapters A, B, G, steps montage n=3, A, B, montage n=5, G, end n=3, `totalMs` = 16,300; a 9-beat negotiation → intro, beats 1–3, fold n=4, beats 8–9 (6 body steps); a 6-beat one → 6 beats, no fold; 8 eligible 9-beat chapters with publishes in every gap at cap 20 s → 2 chapters, `totalMs` ≤ 20,000 | unit | FEAT-F29-05 |
| T-VIZ-reel-det (rev 2.5, F29): 500 generated timelines (fast-check, every kind the build folds), random ranges and options: `serializeReelPlan` of the server-side plan after projection equals that of the page-side plan; page-side plans equal for two windows with different `h0` and desk ordinals, and with language, anonymize, overlay, `self`, `Date.now` and `Math.random` varied; always `totalMs ≤ capMs`, ≤ N chapters, disjoint ascending spans, each intro followed by ≥ 1 beat | property | FEAT-F29-03, FEAT-F29-04 |
| T-VIZ-reel-range (rev 2.5, F29): catch-up anchor 699, `h1` 900, an eligible moment in [700, 900] → [700, 900]; the same anchor with none there → rule 2; no anchor (no catch-up panel) → rule 2; saves at 400 and 820, `h1` 900, eligible moment at 850 → [821, 900]; none after 820 → [401, 820]; no save, `h0` 768 → [768, 900], `h0` 0 → [645, 900]; window [0, 3,000], input [0, 3,000] → [953, 3,000] with `UI_VIZ_REEL_CLIPPED`; `hi > h1`, `lo < h0`, `lo > hi` or a non-matching input → `UI_VIZ_CTRL_REEL` disabled, no request | unit | FEAT-F29-02 |
| T-VIZ-reel-empty (rev 2.5, F29): a range with 40 publishes and one incomplete request → `UI_VIZ_REEL_EMPTY`; no `MediaRecorder` or GIF encoder constructed; no download | unit | FEAT-F29-11 |
| T-VIZ-reel-states (rev 2.5, F29): title card and montage map to their §3.7 rows and reduced forms; a replay and a live scene of the same range never enter the title card; the montage state is entered only by a reel `montage` step and a catch-up Play montage beat, never by a scene event; `SCENE_EVENT_KINDS` and every T-VIZ-golden-sim timeline are byte-unchanged by the reel | unit | FEAT-F29-06 |
| T-VIZ-reel-camera (rev 2.5, F29): a 60-cell office with chapters at its top and bottom desks → the path exists before frame 0 (encoder spy), vertical only, ≤ 1 tile per 100 ms between frames except exactly one cut per `intro` whose target is > 20 tiles away, at its first frame | unit | FEAT-F29-07 |
| T-VIZ-reel-requests (rev 2.5, F29): a reel over 2,048 heights issues only `GET …/timeline` (≤ 9 for the frozen range) and no other route; a default range chosen by the rule-2 fallback issues ≤ 18 pages in all, preview and click included; a second reel of the same range issues none; no request names a height below `h0`; the T-VIZ-readonly listings, the viewer log and the data directory are unchanged; no storage key is added | integration | FEAT-F29-10 |
| T-VIZ-reel-privacy (rev 2.5, F29): the T-VIZ-anonymize canary fixtures as a reel at defaults → the `fillText` spy sees no canary; titles render hue names; anonymize off → `UI_VIZ_RECORD_NOTICE` before frame 0 and no note canary in any title, fold, montage, end or summary text; no "you" marker, map, log or overlay pixel; no `local_only` path either way; a K4 conflict chapter's intro draws its ring pixels only around the conflict's desk, none around any actor; saved name matches `^cowork-reel-[1-9][0-9]{0,3}\.(gif\|webm)$` | CI browser | FEAT-F29-08, FEAT-F29-09 |
| T-VIZ-reel-i18n (rev 2.5, F29): the 17 reel codes in six catalogs, with plural forms on the noun-counting `{n}` of `UI_VIZ_REEL_CH_CONFLICT`, `_CH_REQUEST`, `_CH_HANDOFF`, `_MONTAGE`, `_FOLD`, `_END` and `_SUMMARY`; `UI_VIZ_REEL_CH_*` use only `{name}`, `{target}`, `{n}` (a planted `{path}` or `{dur}` fails); worst-case titles ≤ 60 rendered characters; `UI_VIZ_REEL_SUMMARY` declares `{dur}` as type `dur` and renders 40,000 ms through `UI_DUR_S` in every language; no reel template contains a literal unit ("s", "초", …) | CI lint | FEAT-F29-12 |
| T-VIZ-reel-size (rev 2.5, F29): Make reel on the bundled demo at defaults → `GIF89a`, ≤ 5 MB, sum of frame delays = `totalMs` ± 100 ms ≤ 40 s; WebM ≤ 10 MB where VP9 or VP8 exists | CI browser | FEAT-F29-05, FEAT-F29-08 |

---

## 8. Open questions (each with a proposed default)

1. **Q1 Read this PC's hold registry** (record metadata only, never `blobs/`) to show the own K4 "!" before Plan 3 and lockboxes for `local_only` records? *Default: no.* The data is local, could never be recorded or served to the page safely, and Plan 3 mirrors K4 records to the board soon after Plan 2; the own count from `status.json` covers the gap.
2. **Q2 Read live-code tree names** (`diff-tree -r -z --no-renames --name-status`, trees only, capped at 2,000 entries per commit) for new and deleted desks, desks of change-sets over 256 paths, and the K4 `TAKE_TIP` intersection? *Default: no in v1;* the big table covers large change-sets. Revisit after field use if the big table is frequent; adopting it adds the argv to `L-VIZ-GIT` and keeps INV-VIZ-NOCONTENT (names, never blobs; the fold-only claim inputs of §3.3.3 are the one content read, and Q2 would not widen them).
3. **Q3 Commit dates in replay** (the writer's clock, labelled display only)? *Default: no;* `#height`, "seen {n} min ago" and "before this view opened" only. Adopting it needs an I18N-03 exception like the one for `log` dates and never affects order or pacing.
4. **Q4 One look per human across rooms** (linking peers by normalized display name)? *Default: no:* the display name is never an input to a decision (glossary §2), and copying a look by renaming would allow impersonation. A per-user avatar choice would need a `join` field (protocol change, v2).
5. **Q5 Claude-run `node cli.js view`.** *Default:* add `view` to the `SHELL_COWORK_CLI` advisory list of 06-claude §3.9 row (d), so a Claude Bash call does not open windows on the human's screen; the human types `/cowork view`.
6. **Q6 Claim labels without REG-34 verification.** SEC-35 shows a label that `verifyLabel` cannot re-derive as `?`, and the viewer has no grammar worker. *Default:* show `validLabel`-clean labels marked unverified (dotted underline and `UI_VIZ_LABEL_UNVERIFIED` tooltip) on this human-only surface, with the SEC-35 amendment of §9.3. Alternative: bundle the worker and verify (bundle size and CPU).
7. **Q7 `seat_start` timing** (PRO-20: no later than the seat's first claim or request; 06-claude §3.11: with the next governed push). *Default:* a pet appears at `seat_start` or the seat's first footprint, whichever folds first; an idle session with no footprint has no pet; a footprint-only seat's pet goes when its owner becomes a ghost (VIZ-21).
8. **Q8 Lifetimes.** *Default:* idle exit 10 min with no open stream, hard lifetime 24 h; a page kept open for days is reopened with `/cowork view`.
9. **Q9 Windows opener.** *Default:* `%SystemRoot%\explorer.exe <url>`; `rundll32 url.dll,FileProtocolHandler` only if explorer proves unreliable (some EDR products flag that pattern, and it is reported to drop URL fragments). Decided by the manual checklist, which checks on each OS and default browser that the page receives `#k=`. If an opener drops the fragment, the fix is another opener for that OS; never a query parameter, a cookie, or a file that holds the token (VIZ-02: nothing about a token is written to disk).
10. **Q10 Port reuse after exit.** *Default:* accept; text-only rendering bounds the impact to wrong text, and the page shows `UI_VIZ_STOPPED` once its session is rejected.
11. **Q11 Shape of `to_holder.seat` in `request_status` and `answer`.** The Plan 2 `OpaqueOp` leaves it open. *Default:* nested `to_holder: {seat}` as glossary §7 writes it, pinned before Plan 6 (§9.7).
12. **Q12 Start-time integrity of `dist/viz.js`.** *Resolved:* adopted as VIZ-02 (from Plan 8b, when `dist/SHA256SUMS` exists): the CLI checks `viz.js` against `SHA256SUMS` before spawning it, refuses with `SEC_REFUSE_RUNTIME_INTEGRITY` on a mismatch and passes the verified hash as the start hash of the 30 s check; no runtime copy is made.
13. **Q13 Collision-free looks.** Looks depend on `peer_id` alone (§3.6), so two peers share a look in about 10 % of 4-person rooms; handles then tell them apart. A collision-free assignment that agrees across windows and viewers needs a board-wide join order, for example a `PeerRec.first_height` field in the canonical fold state (02-protocol §3.3). That changes checkpoint bytes, so it would have to land before any real board exists, with the protocol owner's sign-off. *Default: no;* revisit if users report confusing look collisions.

---

## 9. Changes to other documents

Exact proposed edits; each needs the owner's review like any spec change.

### 9.1 Roadmap (`docs/superpowers/plans/2026-10-02-cowork-sync-roadmap.md`)

**Applied.** *(rev 2.5, merge note)* The roadmap file already carries row 8 and its "Execution order" and "Feature work in this order (rev 2.5)" paragraphs, and **the roadmap file is authoritative** for them: it adds, beyond the text below, the F04-b follow-up after 8a's exit (T-F04-moments, -visit), 8b ending with the first public release as its last task, Plan 7 only preparing that release (owner decision D4, decided 2026-10-08; it replaced the merge-time text "8b ships as an update after the Plan 7 release"), the F04 six-language panel strings, montage polish and T-F04-agree in 8b, the F32 README `privacy` sentence, and the optional 8a follow-up for F29's pure core. The text below is kept only as the record of what this chapter first proposed (its "provisional" tag on D3 predates the owner's decision); do not apply it again.

Originally proposed, after row 7:

| # | Plan | Builds | Depends on | Spec chapters | Exit criterion |
|---|---|---|---|---|---|
| 8 | **Visualizer** | Two milestones. **8a, core:** `node dist/cli.js view [--repo <path>]… [--demo[=<file>]] [--no-open]` in `tty` mode only (no slash verb, no `--json`); the read-only viewer `dist/viz.js` (loopback HTTP server, tokens, JSON snapshot and SSE stream); the world model (`buildTimeline` over the engine's fold) with the batched board readers of 12 §9.7, the desk layout, original sprite art, the log, rewind, demo logs and `tools/viz/export-demo.ts`; `en` strings only; first versions of the shared `src/text/sanitize.ts` (SEC-34 channels incl. `viz`) and `src/i18n/render.ts` (10-product §3.2 signature) unless an earlier plan created them; (rev 2.5, F32; provisional, owner decision D3 of 2026-10-08) a last Task 19 "Follow a teammate (F32)" after Task 18: following a person and the now card (12 §3.8.1) with its eight codes in `en`. 8a is a development milestone and is never released. **8b, product:** the `/cowork view` slash verb and `--json`; `repos.json`/`live` room discovery; six-language catalogs for every §3.11 code (rev 2.5: including the follow codes of F32); the `scanSecrets` D2 re-scan of VIZ-36; the `SHA256SUMS` check of VIZ-02; WebM and GIF export with anonymize; (rev 2.5, F34) postcards (12 §3.9.5: PNG and text, clipboard and download), right after the export task; (rev 2.5, F29) the highlight reel (12 §3.9.6), after the export task and the postcards | 8a: 2. 8b: 5, 7, 8a | 12 (+ the 00, 09, 10, 11 edits of 12 §9) | **8a:** green on the three CI OS legs: T-VIZ-timeline-fixtures (every row whose ops or trailers the Plan 2 fold applies, including `leave`, `seat_start`, `seat_end`, `save` and seat footprints, with its events; every row whose op is `unfolded` in Plan 2 asserted as no event and counted in `unknown`), -append-only, -self, -clock, -layout, -placement, -looks, -palette, -frames, -anim, -pets, -bubbles, -log, -notes, -overlay, -seek, -start, -demo-format, -golden-sim (byte-identical from git and from the demo log on every OS, golden file on Linux), -readset, -poll, -readonly, -no-network, -env, -handshake (without its `SHA256SUMS` row), -cli-modes (`tty` rows), -lifetime, -incident, -version, -contention (Windows), -perf, -stream, -token, -launch, -admission, -headers, -routes, -view-model, -api, -text (without its secret rows), -opener, -logs, -failure-signs, -lints and -i18n (`en` only); browser smoke items (a)–(g) and (i) green on one leg; (rev 2.5, F32, Task 19) T-VIZ-follow-camera, -follow-motion, -follow-now, -follow-plan2, -follow-replay, -follow-filter, -follow-keys, -follow-i18n (`en`) and browser smoke item (k) without its recording clause; the Plan 2 storyboard of 12 §3.9.3 renders in `en`. **8b:** in addition T-VIZ-handshake's `SHA256SUMS` row, every T-VIZ-cli-modes row, the T-VIZ-text secret rows, T-VIZ-i18n in six languages, T-VIZ-anonymize, T-VIZ-recording and browser smoke item (h) green; T-VIZ-manual signed off; the bundled demo renders in six languages; a README GIF recorded from the bundled demo; (rev 2.5, F32) the recording clause of browser smoke item (k) and the follow codes in six languages; (rev 2.5, F34) T-F34-frame, -text, -anonymize, -never, -clipboard, -download, -quiet, -lints and -perf and browser smoke item (j) green; (rev 2.5, F29) T-VIZ-reel-moments, -plan, -fit, -det, -range, -empty, -states, -camera, -requests and -i18n green on the three CI OS legs, T-VIZ-reel-privacy and -size green on the browser leg, and the README GIF made with Make reel from the bundled demo |

Replace the "Execution order" paragraph with: "**Execution order:** 1 → 2 → 3 → 4 → 5 → 6 → 7. Plans 4 and 5 may overlap once plan 3 has landed, because they touch disjoint modules (`src/regions/**` and `src/claude/**`). Plan 8a starts when plan 2 has landed and runs alongside plans 3–7 in its own module `src/viz/**`, plus the `view` dispatch line of the `cli.js` entry, the additive board interfaces of 12-visualizer §9.7 and, when no earlier plan has created them, first versions of the shared `sanitize` and `render` modules with their spec signatures; Plan 8b follows plans 5 and 7. Each later plan adds the scene events of its ops to Plan 8's fixtures and golden timelines: once Plan 8a has landed, the exit criterion of each of plans 3–7 includes that the T-VIZ-timeline-fixtures rows of its plan (12-visualizer §3.4 Plan column) produce their scene events instead of `unknown`, that `startScene` reads the fold-state fields the plan fills (12 §3.3.5), that T-VIZ-golden-sim passes after a reviewed `--update`, and that the bundled demo shows the plan's facts."

### 9.2 Glossary (`00-glossary.md`), as a new "§28 Visualizer (2026-10-06; superseded by §29 where they differ)" section that wins over sections before it

*(Relabelled at the rev 2.5 merge: glossary §29, "Revision 2.5" of 2026-10-08, is newer and wins over this section where they differ, so this one no longer carries the "Revision 2.5" label; glossary §29 "Numbering" says the same. Its §15 change is an append, so it composes with §29.4.)*

- **§6 Plugin `dist/`:** "`hook.js`, `core.js`, `daemon.js`, `worker.js`, `mcp.js`, `cli.js`, **`viz.js`** (the read-only viewer of 12-visualizer; its page assets and the bundled demo log are embedded as strings), `grammars/*.wasm`, …" (unchanged after that). **Per user:** new row "`log/viz-<instance>-<n>.jsonl` — viewer logs, one set per viewer process (12-visualizer; 10 MB × 5, 14 days)".
- **§15 Slash verbs:** append `view` to the read-only list (the list is otherwise unchanged; glossary §29.4 lists the rev 2.5 additions `status --flow`, `show <id|path|glob>…`, `show … --undo`, `since` and `wrap`). New bullet: "`view` flags: `--no-open`, `--demo[=<file>]`, `--repo <path>` (repeatable). `view` opens the read-only viewer of 12-visualizer; it needs no human evidence; its `--json` envelope never contains the viewer URL."
- **§17:** append "The viewer (12-visualizer), which spans repositories, resolves the human language as `user.json` → OS locale → `en`, like the hook loader; the CLI resolves it and passes it to the viewer process."
- **§19:** new row "Viewer (`viz` channel): bubble 2 lines × 42 Latin / 16 full-width chars; card text 400; tooltip 200; room label 40; branch 80; names, label, path and note as the placeholder row; (rev 2.5, F29) reel title 60 (one line)".
- **§20:** new row "Viewer | poll 2.5 s by `stat`, `rev-parse` only on a change or every 60 s; batches of ≤ 1,280 board commits; ready handshake 5 s; launch token TTL 120 s, idle exit 10 min without an open stream, lifetime 24 h (own staleness); plugin check 30 s; `repos.json` and `live` re-check 30 s; ≤ 32 rooms; initial window 1,024–1,279 heights from a checkpoint, earlier pages of 256, ≤ 2,048 heights kept per room, seek ≤ 255 folds; live beat 300 ms, snap after a 5 s backlog or > 64 commits in one tick; replay beat 800 ms at 1×, speeds 0.5×–8×; ≤ 12 fps, ≤ 2 draws/s idle; bubbles 1.5–6 s, ≤ 1 per actor, ≤ 3 per room; ≤ 15 zones + overflow, ≤ 4 cells × 6 slots per zone, shelf at the 24th slot; 1 chair + 4 visitor tiles; relaxed pose after 64 heights; board near-full badge at 4,000 records; stream comment every 15 s, SSE message ≤ 64 KiB, resume ring 4,096 events or 10 min; recording art viewport 480 × 270, WebM 1,920 × 1,080 at ≈ 2 Mbps ≤ 120 s, GIF 960 × 540 at 10 fps ≤ 10 MB; `status.json` read ≤ 1 MiB; viewer RSS ≤ 200 MB; (rev 2.5, F32) follow: ≤ 1 peer per room, page memory only; pan 300 ms, jump at ≥ 4× or reduced motion; now card ≤ 3 holding, ≤ 3 asks, ≤ 3 asked-by rows; (rev 2.5, F34) postcard 960 × 540 PNG, text ≤ 16 lines (≤ 12 actor lines + one "+n"), line ≤ 400; (rev 2.5, F29) reel: range ≤ 2,048 heights, ≤ 9 timeline pages per range, ≤ 18 to choose the default range; 1–8 chapters (default 5); cap 20/30/40/60 s (default 40); intro 2,000 ms, beat and fold 800 ms, ≤ 6 steps per chapter body, montage 1,200 ms, end card 1,500 ms | 12-visualizer".

### 9.3 09-security

- **§3.2 egress list**, new row: "| E8 | none (inbound loopback listener) | `dist/viz.js` only: one `node:http` server on the literal `127.0.0.1`, port 0, serving this PC's browser the read-only viewer page; it opens no outbound socket and resolves no name | 12-visualizer VIZ-30 |".
- **INV-EGRESS** becomes: "The only network connections cowork opens are the egress list E1–E7, made through git. The only listening socket outside local IPC is E8, the viewer's loopback listener. `dist/*.js` contains no HTTP client, TLS, DNS or UDP module; `node:http` appears only in `dist/viz.js` and only as a server; no non-documentation URL literal exists except the viewer's `http://127.0.0.1:${port}/` template."
- **SEC-01:** after "imports `http`" add "(except the E8 server in `dist/viz.js`, 12-visualizer VIZ-01)".
- **SEC-34:** add the channel `viz` to the channel set: sanitized as `notification`, caps of glossary §19's viewer row.
- **SEC-35**, last bullet, append: "A human-only viewer surface that cannot run `verifyLabel` (12-visualizer) MAY show a `validLabel`-clean label marked unverified (12 §8 Q6)."
- **§3.4:** append "The browser opener of 12-visualizer additionally receives `DISPLAY`, `WAYLAND_DISPLAY` and `XAUTHORITY` (the opener display set; `XDG_*` and `DBUS_SESSION_BUS_ADDRESS` are already in item 2), and on Linux a `PATH` filtered as 12-visualizer §3.10.8 says; the viewer process does not receive the display set. Because this builder drops `CLAUDE_*` and forces `LC_ALL=C`, the viewer receives its data directory and language as arguments from the CLI."
- **SEC-38:** add the carrier kind `viz` and the files `CLAUDE_PLUGIN_DATA/log/viz-<instance>-<n>.jsonl`.
- **SEC-36:** append "The CLI applies the same `SHA256SUMS` check to `dist/viz.js` before spawning the viewer (12-visualizer VIZ-02); no runtime copy is made for the viewer."
- **§3.1 threat model:** add the rows of 12 §3.10 (other local users and web pages against the loopback listener, including a local user who races the launch token; teammate-synced executables against the opener and the tree kill; viewers of recordings).

### 9.4 10-product

- **§1.1:** add "The `/cowork view` command output; the viewer page itself is 12-visualizer's."
- **§3.2 channel table:** new row "`viz` | the viewer page (12-visualizer) | glossary §19 viewer row | `notification` | never | no".
- **UX-01:** the lint file list becomes `dist/{cli,daemon,hook,mcp,viz}.js` plus `src/viz/client/**`.
- **INV-UX-READONLY:** add `view`.
- **§3.3 command file:** no new file. The single `commands/cowork.md` (06-claude §3.2: `disable-model-invocation: true`, one `!` line with `$ARGUMENTS`, the UX-05 framing sentence) already carries every verb as its first argument; `cli.js` gains the `view` verb, and 08-lifecycle §2.6 gains the line "`view`: `--no-open`, `--demo[=<file>]`, `--repo <path>` (12-visualizer)" so that these flags are not `RF_UNKNOWN_FLAG`.
- **§3.18 README, anchor `privacy`:** add a sentence: the viewer shows only what is on the board and on this PC, runs only on this PC, and recordings (rev 2.5, F34: and postcards) of real rooms are anonymized unless the user turns that off; (rev 2.5, F34) postcards never contain teammates' notes. (rev 2.5, F32) Append: "You can follow a teammate in the viewer to keep their corner of the office in view, like glancing at a pair-programming partner. Following sends nothing and tells no one; it shows only the board facts every teammate's viewer already has." (rev 2.5, F29) Append: "Highlight reels are made only when you click Make reel, only from what the viewer already shows, and are anonymized unless you turn that off."

### 9.5 11-testing §3.10 and §3.11

- **L-NET:** allow `http`/`node:http` in exactly `src/viz/server/http.ts`, as a server only (`http.request`, `http.get`, `http.Agent`, `net.connect`, `createConnection` and global `fetch` stay forbidden there); the `listen` host argument must be the literal `'127.0.0.1'`; allow the URL template `http://127.0.0.1:${port}/` in `src/viz/**` only.
- **L-PORTS:** add `src/viz/cli/spawn.ts` (the viewer spawner and its tree kill) and `src/viz/cli/opener.ts` (the browser opener).
- **L-CLOCK, L-RANDOM, L-FS-PORT, L-GIT-*:** exempt `src/viz/client/**` (browser code), which `L-VIZ-IMPORT` covers instead.
- **New L-VIZ-DOM:** in `src/viz/client/**`, fails on `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `setHTMLUnsafe`, `parseHTMLUnsafe`, `document.write`/`writeln`, `DOMParser`, `createContextualFragment`, `srcdoc`, `eval`, `new Function`, string arguments to `setTimeout`/`setInterval`, `setAttributeNS` (any name), `setAttribute` of `on*`/`href`/`src`/`srcset`/`xlink:href`/`style`/`srcdoc`/`action`/`formaction`, non-literal assignments to `.href`, `.src`, `.srcset`, `.action`, `.formAction`, `.style.cssText` or `location` (except the one Blob-URL download link in `src/viz/client/save.ts`; rev 2.5, F34), `style.setProperty`, `insertRule`, `replace` or `replaceSync` with a non-literal value, any style property write whose value is not a number or an enum-map constant, `window.open`, `message` event listeners, dynamic `import()`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `XMLHttpRequest`, `Worker`, and any `fetch` whose first argument is not a literal (or a template with a literal head) starting `/api/v1/`; (rev 2.5, F34) any `clipboard` member access outside `src/viz/client/postcard.ts`; `read` or `readText` on a clipboard object anywhere; `ClipboardItem` outside that file or with a key other than the literal `'image/png'`; `execCommand`; an event listener of type `paste`; `navigator.permissions`.
- **New L-VIZ-GIT:** every `runGit` argv in `src/viz/**` matches the §3.3.2 allowlist (`rev-parse --verify -q`, `for-each-ref -z` under `refs/cowork-remote/`, `rev-list --first-parent`, `cat-file --batch`, and — owner decision of 2026-10-08, Plan 4's claim-fold reads only — `merge-base --is-ancestor <oid> <oid>`), always with `--git-dir` and the transport-disabling `-c protocol.*` values of VIZ-07; `src/viz/cli/**` spawns no bare executable name.
- **New L-VIZ-IMPORT:** `src/viz/client/**` imports no `node:*` module and nothing from `src/ports`, `src/git` or `src/engine`; `src/viz/model/**` and `src/viz/render/**` import no I/O module; the `daemon`, `hook`, `core`, `mcp` and `worker` entries import nothing from `src/viz/**`; (rev 2.5, F34) `src/viz/ui/**` imports nothing from `src/viz/render/**`, type-only imports included.
- **§3.11 CI matrix:** the browser smoke T-VIZ-browser-smoke runs on the Node 24 legs with the runner's preinstalled Chrome; no package is added.
- The T-VIZ-* tests of 12 §7 join the TST- tables, owned by 12-visualizer.

### 9.6 06-claude

- **§3.9 row (d):** add `view` to the `SHELL_COWORK_CLI` advisory list (pending §8 Q5).

### 9.7 Plan 2 contract (`.worktrees/p2-engine/docs/superpowers/plans/2026-10-06-cowork-sync-p2-engine.md`), additive interface asks

To land in Plan 2's board tasks if still open, otherwise as the first task of Plan 8 in the same files:

1. `FoldStepResult.opVerdicts: Array<{ line: number; opId: string | null; type: OpType | 'unknown'; verdict: 'effective' | 'unfolded' | 'rejected'; reason?: 'malformed' | 'generic' | 'type' }>` — pure, one entry per `ops.jsonl` line; `unfolded` = passed generic validity, but this build folds the type as a deterministic no-op (Plan 2: every type outside `PLAN2_FOLDED_TYPES`, ruling R-12; each later plan shrinks that set); `reason` only with `rejected`.
2. `BoardCommitData.csPaths: Map<string, string[]>` — the decoded `Cowork-CS-Paths` of the board commit (`readBoardCommit` already parses its trailers).
3. `readLiveCommits(repo, oids: readonly Oid[]): Promise<Array<{ parents: Oid[]; writer: WriterId | null; seats: string[]; cs: CsTrailer[]; csPaths: Map<string, string[]>; base: Oid | null }>>` — one `cat-file --batch` process per call (≤ 1,280 oids), commit objects only, never a tree; `liveShape` is computed from `parents` by the caller.
4. `parseCsActor(csId): { kind: 'human'; peer: PeerId; n: number } | { kind: 'seat'; seat: string; turnSeq: number } | null` next to `validId`, so the engine and the viewer share one grammar.
5. A `GitRepo` binding for a gitdir without a worktree: every call with `--git-dir=<abs>`, a caller-given cwd (the viewer passes its data directory) and caller-given extra `-c` values and environment entries (the viewer's transport-disabling set, VIZ-07), plus a read-only facade type exposing only `rev-parse`, `for-each-ref`, `rev-list` and `cat-file --batch`; a check that the runner spawns git by absolute path; and the same fix for the runner's `killTree`, which today spawns the bare name `taskkill` with an inherited cwd (on Windows a bare name is looked up in the current directory first): it MUST spawn `%SystemRoot%\System32\taskkill.exe` by absolute path.
6. A unit test that `foldCommit(prev, draft, self).state` does not depend on `self`.
7. Pin the JSON shape of `to_holder` in `request_status` and `answer` before Plan 6 (§8 Q11).
8. `readBoardCommits(repo, items: ReadonlyArray<{ oid: Oid; height: number }>): Promise<BoardCommitData[]>` — the batched form of `readBoardCommit`: one `cat-file --batch` process per call (≤ 1,280 items) whose input names, per oid, the commit object, `<oid>:ops.jsonl`, `<oid>:protocol.json`, the `<oid>:held` tree object (parsed for entry names) and, at heights divisible by 256 only, `<oid>:checkpoint/state.json`; results equal `readBoardCommit` for every oid, except that `checkpoint` is null at heights not divisible by 256, where the fold does not compare it (PRO-28; tested). The engine may keep its per-commit reader.

### 9.8 Design entry (`docs/superpowers/specs/2026-10-01-cowork-sync-design.md`)

- **§11 Chapters:** add "| 12 | [Visualizer](../../spec/12-visualizer.md) | `/cowork view`: the read-only team view, replay, demo and export |".

### 9.9 Pending §3.11 rows (land with their code) *(rev 2.5)*

8a's T-VIZ-i18n parses every table row of §3.11 and deep-equals it with `src/viz/i18n/codes.ts`, and its `SPEC_WORDING` pins the en text of `UI_VIZ_RECORD_NOTICE`. The rev 2.5 codes are therefore kept here, outside §3.11 and outside any table, until the task that defines them merges; that task moves its list into the named §3.11 rows (and updates `codes.ts`, `en.ts` and the test's row and wording maps) in the same merge. Chapters 00–11 may carry their rev 2.5 edits earlier.

- **F32 — 8a Task 19 "Follow a teammate" (owner decision D3, decided 2026-10-08).** Scene labels: append `UI_VIZ_FOLLOWING`, `UI_VIZ_NOW_ASKS`, `UI_VIZ_NOW_ASKED_BY`, `UI_VIZ_NOW_LAST_SHARED`, `UI_VIZ_NOW_LAST_SHARED_TABLE`, `UI_VIZ_NOW_NOTHING`, `UI_VIZ_NOW_NOT_HERE`. Controls and filters: append `UI_VIZ_CTRL_FOLLOW`. (Eight codes, FEAT-F32-09.)
- **F04-b — the viewer catch-up follow-up after 8a's exit.** Page states: append `UI_VIZ_CATCHUP`, `UI_VIZ_CATCHUP_OLDER`. Scene labels: append `UI_VIZ_LAST_VISIT`, `UI_VIZ_MONTAGE`. Controls and filters: append `UI_VIZ_ANCHOR_VISIT`, `UI_VIZ_ANCHOR_SAVE`, `UI_VIZ_ANCHOR_OPEN`, `UI_VIZ_ANCHOR_HEIGHT`. (Eight codes.) The same task starts serving the optional `RoomVM.open_h` of §3.10.6 (absent in 8a; merge round 2).
- **F34 — 8b task "Postcards".** Recording: append `UI_VIZ_ANON_NAME_NTH`. New group row "Postcard" (the test's `ROW_GROUP` gains it in the same merge): `UI_VIZ_CTRL_POSTCARD`, `UI_VIZ_POSTCARD_COPY_IMAGE`, `_SAVE_IMAGE`, `_COPY_TEXT`, `_RETAKE`, `_COPIED`, `_COPY_UNSUPPORTED`, `_COPY_FAILED`, `_HEAD`, `_HEAD_ANON`, `_REPLAY`, `_PERSON`, `_PET`, `_PET_N`, `_LAST_SHARED`, `_LAST_SHARED_BIG`, `_WAITING`, `_SEP` (prefixed `UI_VIZ_POSTCARD`; the last one is the symbol-only item separator of §3.9.5, with no placeholder). Template revision: `UI_VIZ_RECORD_NOTICE` becomes, in all six catalogs, en "With anonymize off, recordings and postcards show your teammates' names and file names; recordings also show their notes." (code unchanged; §3.9.4 keeps the current text until then). (Nineteen codes.)
- **F29 — 8b task "Highlight reel".** Recording: append `UI_VIZ_REEL_CH_CONFLICT`, `_CH_REQUEST`, `_CH_HANDOFF`, `_CH_SAVE`, `_CH_FREEZE`, `_CH_JOIN`, `_CH_REJOIN`, `_MONTAGE`, `_FOLD`, `_END`, `_CHAPTERS`, `_END_TOGGLE`, `_SUMMARY`, `_LOADING`, `_EMPTY`, `_CLIPPED` (prefixed `UI_VIZ_REEL`). Controls and filters: append `UI_VIZ_CTRL_REEL`. (Seventeen codes.)
- **Owner choice of 2026-10-08 (claims in the viewer) — 8a Task 20 "Claim inputs for the viewer's fold".** Page states: append `UI_VIZ_CLAIMS_PENDING` (en "Some shared changes are not on this PC yet; this room continues when they arrive.", §3.3.3). (One code.)
