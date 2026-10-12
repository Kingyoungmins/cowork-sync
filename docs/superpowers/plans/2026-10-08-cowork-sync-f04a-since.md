# cowork-sync F04-a — catch-up core (Plan 2 follow-up F-P2-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The F04-a slice of rev 2.5 F04 (roadmap row 2 follow-up; owner decision D5 option (가)): the pure catch-up core `src/since/report.ts` (an accumulator byte-equal to the batch) over the facts the Plan 2 fold makes `effective` (CS groups with `Cowork-CS-Paths`, saves, joins, rejoins, leaves, freeze, unfreeze, incident), its batched board walker `walkSince`, `zone()` moved into the one shared pure module `src/data/zone.ts`, the additive `meta.since` parse (`SinceMarks`, no `meta.v` bump, written by nothing before Plan 5), and a terminal-only English `node dist/cli.js since [--since=#<n> | --since=save:<prefix>]`. Exit: T-F04-golden (without the Plan 4 label variant), T-F04-incremental, T-F04-cap, T-F04-readonly (`tty` rows) and T-F04-anchors (without its `last-run` rows) green on the three CI OS legs.

**Owner:** the Plan 2 controller (RECONCILIATION X-76, F-P2-1). Ledger: `.worktrees/p2-engine/.superpowers/sdd/2026-10-06-cowork-sync-p2-engine/progress.md` under "F04-a". Reviewer of the two 8a files it edits: the 8a reviewer (8a F-8a-11 table, row "F04-a").

**Gate:** gate P (Plan 2 merged into `main` and forward into `feat/p8a-viz`, CI green), 8a Task 2 (12 §9.7 items 1, 2, 8: `opVerdicts`, `readBoardCommits`, `BoardRead`), 8a Task 4 (`src/viz/model/layout.ts`) and 8a Task 11 (`src/entry/cli.ts`'s dispatch line). Branch `feat/f04a-since` from `main` after gate P, worktree `.worktrees/f04a`.

**Consumers waiting on this plan (each names it as a gate):** Plan 3 Task 19 (hold-transition rows, X-12), Plan 4 Task 13 (claim rows and the label variant, R4-66, C-15), Plan 5 Task 16 (`SinceMarks` writer, recap, `since_query`, R5-61), Plan 6 Task 16 (request/answer/note/STALE rows, X6-47), Plan 7 Task 17 (the full `since` verb over this core, X7-60), 8b (F04-b's sibling, through 8a).

**Architecture:** `src/since/**` is pure (L-PURE, 11-testing §3.10 rev 2.5): no I/O, clock, randomness or `src/git` import except in `src/since/walk.ts`, the one file that reads git (and `src/since/cli.ts`, the `since` CLI's environment I/O — F04-a Task A3 ruling), through 8a's `readBoardCommits` (`cat-file --batch`, ≤ 1,280 board commits per process) and Plan 2's `Folder`-free fold (`foldCommit` with `opVerdicts`, one call per commit from the checkpoint at or below `from`). Import order (X-110): `src/data/zone.ts` is a leaf under `src/data`; `src/since` sits after `src/board` and before `src/holds`. `src/viz/model/layout.ts` keeps `zoneOf` as a re-export of `zone`; 8a's `CLIENT_PROGRAM_FILES` in `tools/lint/vizRules.ts` (the landed R-V35 client-program constant — it exists now, so X-76's "no constant of that name" note is moot) gains `src/data/zone.ts`, and 8a's R-V02 table of files outside `src/viz/**` gains the same row.

**Spec:** glossary §29 (rev 2.5, D5), §29.7 "Catch-up (F04)"; 10-product §3.9a (sections, anchors, caps, terminal form), FEAT-F04-01, -02, -06, -07, -08, -17, -18; 01-engine §3.2 (`meta`, ENG-03, ENG-05: additive field parsed by every build); 11-testing §3.10 L-PURE (rev 2.5), §7.9 (F04 registration); 12-visualizer §9.7 items 1, 2, 8; `docs/proposals/F04-since-catchup.md` §2.2, §3 (where it differs from 10 §3.9a, the spec wins).

## Global constraints

- Plan 2's Global Constraints apply unchanged (TDD, `npm run ci` green on three OS legs, no new dependency).
- Additive only on Plan 2 files: `src/engine/meta.ts` gains the optional `since` member and its parse; nothing else in `src/engine/**` changes. No hook, seat, carrier, IPC or `user.json` code (roadmap row 2).
- The `since` verb reads only board commits, `<oid>:ops.jsonl`, `<oid>:protocol.json`, `<oid>:held` (tree object, names only) and `<oid>:checkpoint/state.json` (T-F04-readonly): no live-code tree or blob, no save or branch commit, no registry blob, no network-class `runGit`, no write.
- English only, `tty` mode only; slash mode, `--json`, `last-run`, `away`, return marks and the six catalogs are Plan 5's and Plan 7's.

## Interfaces (the contract)

```ts
// src/data/zone.ts — pure leaf; moved verbatim from 8a's layout.ts zoneOf (12 §2 / §3.5.3 area rule)
export function zone(p: string): string;

// src/engine/meta.ts (additive; X-75) — parsed by every build (ENG-05), written by nothing before Plan 5
export interface SinceMarks { seen_h: number | null; return_h: number | null; run_h: number | null; }
// Meta gains: since?: SinceMarks   — absence and null members accepted; an unknown member or a non-integer height → the meta parse error Plan 2 already raises

// src/since/report.ts — pure (L-PURE); FEAT-F04-07: sinceFinish(steps.reduce(sincePush, sinceInit(…))) equals the batch for every split
export interface SinceStep { data: BoardRead; verdicts: OpVerdict[]; after: FoldState; }        // 8a BoardRead (R-V05/R-V69): BoardCommitData has no csPaths
export interface MyRecord { readonly id: string; readonly paths: readonly string[]; readonly state: string; readonly offer: string; }   // registry metadata, never blobs (F04 design §2.2)
/** The one label-lookup slot (X-23; verify pass V-6): Plan 4's lookup, which never schedules a parse. Absent in F04-a and on every Plan 2/3 board (no claims): claim rows
 *  Plan 4 adds then carry no label (T-F04-golden's "label not verified → omitted" variant). Called during sincePush, so the accumulator and the batch see the same labels. */
export interface SinceLabel { readonly simple: string; readonly qualname: string; }               // structural: Plan 4's ClaimLabel (src/board/ops.ts, later) is assignable;
                                                                                                   // Plan 4 Task 13 may retype the slot to ClaimLabel in place
export interface SinceOptions { readonly verifiedLabel?: (claimId: string, anchor: string) => SinceLabel | null; }
export type SinceAcc = { readonly __since: unique symbol };                                       // opaque, immutable
export function sinceInit(start: FoldState, from: number, you: PeerId, mine: readonly MyRecord[], o?: SinceOptions): SinceAcc;
export function sincePush(a: SinceAcc, s: SinceStep): SinceAcc;                                  // returns a new value; never mutates
export function sinceFinish(a: SinceAcc, capFrom: number | null): SinceReport;
export interface SinceRow { readonly code: string; readonly params: Params; readonly csIds?: readonly string[]; }
export interface SinceReport {
  from: number; to: number; truncatedFrom: number | null;
  you: { requests: readonly SinceRow[]; records: readonly SinceRow[]; touches: readonly SinceRow[];
         notes: ReadonlyArray<SinceRow & { note: { target: string; author: string; text: string } }>; wake: number };
  saves: readonly SinceRow[]; team: ReadonlyArray<{ row: SinceRow; areas: readonly SinceRow[] }>; events: readonly SinceRow[];
}   // P7 X7-60's shape, adopted by X-76; F04-a fills touches, saves, team and events; requests/records/notes/wake stay [] / 0 until Plans 3, 6, 5 add rows

// src/since/walk.ts — the one git reader of src/since. readBoardCommits yields BoardRead | BoardReadFailure (8a R-V69/R-V74): a failure item folds as 8a's noopDraft
// (every op a no-op, no row) and the walk continues; callers loop on `next` and carry prevLive (8a ledger carry to Tasks 7/8).
export const SINCE_CAP_HEIGHTS = 5_000;                                                            // 10 §3.9a cap (T-F04-cap)
export function walkSince(repo: GitRepo, b: string, o: { from: number; to: number; you: PeerId; mine: readonly MyRecord[]; verifiedLabel?: SinceOptions['verifiedLabel'] }):
  Promise<{ report: SinceReport; joinHeight: number | null; saves: (prefix: string) => readonly number[] }>;
/** Anchors F04-a resolves (10 §3.9a table; FEAT-F04-02): '#<n>' (n below the tip), 'save:<hex prefix>' (an effective save op; ambiguous → AMBIGUOUS_ID), default = this
 *  peer's newest folded join; every other value (incl. 'last-run', 'away') → RF_SINCE_ANCHOR until Plan 5/7 add them. */
export function resolveSinceAnchor(v: string | null, ctx: { tip: number; joinHeight: number | null; saves: (prefix: string) => readonly number[] }): { from: number } | { refuse: 'RF_SINCE_ANCHOR' | 'AMBIGUOUS_ID' };

// src/since/cli.ts — terminal English `since` (tty only), dispatched from 8a's src/entry/cli.ts (one added line, X-99 allows it)
export function runSince(argv: readonly string[], env: CliEnv): Promise<number>;                  // exit 0, or 1 with the refusal line
```

**Naming ruling (verify pass V-6):** the plans' "`sinceReport` takes `verifiedLabel(claimId, anchor)`" means `sinceInit`'s optional `o.verifiedLabel` (and `walkSince`'s `o.verifiedLabel`, passed through). There is no exported function named `sinceReport`; it names the batch `sinceFinish(steps.reduce(sincePush, sinceInit(…)))`.

## Tasks

### Task A1: `zone.ts`, `SinceMarks` and the `meta.since` parse

**Files:** Create `src/data/zone.ts`, `test/unit/zone.test.ts`; Modify `src/viz/model/layout.ts` (`zoneOf` re-exports `zone`; 8a reviewer), `tools/lint/vizRules.ts` (`CLIENT_PROGRAM_FILES` gains `src/data/zone.ts`; 8a reviewer), `src/engine/meta.ts` (`SinceMarks`, `Meta.since?`), `test/unit/meta.test.ts`.
**Tests:** `"zone equals 8a's zoneOf on every T-VIZ layout fixture path"`; `"a meta without since, with since: null members, and with all three heights parses; an unknown member or a float height fails like any malformed meta; serializeMeta round-trips"` (ENG-05); `"L-VIZ-IMPORT accepts layout.ts importing src/data/zone.ts and still rejects a client import of src/engine"`.

### Task A2: The pure core and the walker

**Files:** Create `src/since/report.ts`, `src/since/walk.ts`, `test/unit/since.report.test.ts`, `test/unit/since.incremental.test.ts`, `test/integration/since.walk.test.ts`, the SIM board builder `test/helpers/sbF04.ts` (board `SB-F04` of 10 §7).
**Tests:** T-F04-golden without its Plan 4 label variant (its Plan 3/4/6 variants are added by those plans' tasks); T-F04-incremental (2,000 fast-check splits of a 3,000-height SIM board → canonical JSON byte-equal); T-F04-cap (6,200 heights → `(to − 5,000, to]`, `truncatedFrom` set, ≤ 5 `cat-file --batch` processes, p95 ≤ 2 s on the Windows reference, 2× in CI); `"sinceInit with o.verifiedLabel absent gives byte-identical reports to a lookup that returns null for every id"` (V-6); `"L-PURE: src/since/report.ts imports no node:* module and nothing from src/git, src/engine or src/ports values"`.

### Task A3: Terminal `since`

**Files:** Create `src/since/cli.ts`, `test/integration/since.cli.test.ts`; Modify `src/entry/cli.ts` (one dispatch line; 8a's file, 8a reviewer), `tools/build/build.mjs` only if `cli.js`'s entry list needs the new module (X-107 order kept).
**Tests:** T-F04-anchors without `last-run` (`#17`, `save:<c8>`, `save:deadbee` → `RF_SINCE_ANCHOR`, `#999999` → `RF_SINCE_ANCHOR`, the default anchor on a clone with no `meta.since` → this peer's join height; `--since=away` → `RF_SINCE_ANCHOR`); T-F04-readonly `tty` rows (refs, registry and worktree mtimes unchanged across 3 runs; argv spy: only the five board object kinds, no network-class `runGit`).

**Exit (ledger):** CI green on the three legs with the tests above; the ledger records the merge commit; Plans 3 (Task 19), 4 (Task 13), 5 (Task 16), 6 (Task 16) and 7 (Task 17) are told it merged.
