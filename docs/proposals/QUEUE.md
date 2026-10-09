# Proposal queue — controller view

2026-10-08. Source: `docs/proposals/F*.md`, each revised in place by its adversarial review (see each file's "Review notes"). **The design file is authoritative**; where an earlier summary (the review's placement/deps strings) differs, §5 lists the difference and the file wins. Owner summary in Korean: [README.ko.md](README.ko.md).

Result: 35 ideas (F01–F35) → 8 kept (all "keep with changes"), 0 dropped by review, 27 ranked below the top 8 and **not queued** (§6). No kept proposal changes the protocol (`proto = 1`, no op, op field, trailer, ref or board file), so none must land before the public release for compatibility.

**Owner gates (README.ko.md §5).** D1 relax the approved "failed edit check creates no record or message" wording to allow a human-pulled display (F14 `{last}` lines, F12 W3 reason) · D2 accept the HLD-50 shrink attribution for a confirmed revert (F10) · D3 F32 as 8a Task 19 vs 8b · D4 hold the public release for 8b or not (F29, F34, the 8b halves of F04/F32) · D5 which early slices start when Plan 2 lands (recommended: F04-a only). Also implicit: the owner approves the eight as a set.

**State used for this queue** (ledgers read 2026-10-08): Plan 2 Tasks 1–14 merged, 15–17 in review/fix rounds, 18–20 open; gate P (Plan 2 merged into main and forward into `feat/p8a-viz`, CI green) not passed. 8a: Tasks 1, 3, 4, 12 merged; 10 and 11 started early; 2, 5–9, 13–18 wait for gate P. Plan 3: draft plan `2026-10-07-cowork-sync-p3-holds.md` (16 tasks, reviewed once), no code. No 8b plan file exists.

---

## 1. Order at a glance

| # | Feature | Design file | implementableNow | First code can start | Main delivery | Size | Gate |
|---|---|---|---|---|---|---|---|
| 1 | F04 catch-up `/cowork since` | `F04-since-catchup.md` | **partial** — slice F04-a only | gate P + 8a Task 2 + 8a Task 11 | Plan 7 (verb) · 8a follow-up (viewer) · 8b (strings) | L | D5 |
| 2 | F32 follow a teammate | `F32-follow-teammate.md` | **yes** w.r.t. Plans 3–7; not codeable before gate P | 8a Tasks 5, 12, 13, 14, 17, 18 merged | 8a Task 19 (+ 8b catalogs) | S | D3 |
| 3 | F05 claims ahead | `F05-claims-ahead.md` | no | Plan 6 | Plan 6 task + Plan 7 `show` task | M | — |
| 4 | F14 `/cowork status --flow` | `F14-status-flow.md` | no (optional pure carve-out after Plan 2) | Plan 3 Task 10 (`last_check`) | Plan 7 status/show task | M | D1 (O10 `{last}` only) |
| 5 | F10 `/cowork revert` | `F10-revert-own-change-set.md` | no (optional kernel; review recommends writing it inside Plan 3) | Plan 3 | Plan 7 "F10 own-change revert" | L | D2 |
| 6 | F12 `/cowork wrap` + save draft | `F12-wrap-and-save-draft.md` | no (optional attribution core after Plan 2) | Plan 7 (core optional earlier) | Plan 7 wrap task | L | D1 (W3 only) |
| 7 | F34 postcard | `F34-postcard.md` | no | 8b | 8b "Postcards (F34)" | S | D4 |
| 8 | F29 highlight reel | `F29-highlight-reel.md` | no (pure core may be an 8a follow-up after 8a Task 6) | 8b (or after 8a Task 6) | 8b "Highlight reel (F29)" | M | D4 |

---

## 2. Work queue (chronological slices)

Each slice lands with its tests; "gate" = what must be merged first.

**Q1 — F04-a: pure catch-up core + tty `since`** (Plan 2 follow-up task, own module; D5)
- Gate: gate P; 8a Task 2 (`FoldStepResult.opVerdicts`, `BoardCommitData.csPaths`, `readBoardCommits` = 12 §9.7 items 1, 2, 8); 8a Task 11 (`cli.js` dispatch line; Plan 2 has no CLI).
- Build: `src/since/report.ts` (`sinceInit`/`sincePush`/`sinceFinish`, accumulator = batch by construction) over the facts Plan 2 makes `effective` (CS groups with `Cowork-CS-Paths`, saves, joins/rejoins/leaves, freeze/unfreeze/incident); move `zoneOf` out of `src/viz/model/layout.ts` into one shared pure module (also F12's home for `zone()`, §4 item 11); terminal-only English `node dist/cli.js since [--since=#n|save:<oid>]`, default anchor = this peer's newest folded `join` (no marks before Plan 5); `last-run` refuses. Optional: additive `meta.since` field (Plan 2 Task 8 is closed; no `meta.v` bump), written by nothing before Plan 5.
- Tests: T-F04-golden (minus the label variant, Plan 4), -incremental, -cap, -readonly (tty rows), -anchors (`#n`, `save:`, default).
- Touches no hook, seat, carrier, IPC or `user.json`.

**Q2 — F32: 8a Task 19 "Follow a teammate (F32)"**, group G9 after Task 18 (D3)
- Gate: 8a Tasks 5 (`reduceScene`, `phOf`, R-V25 `lastDesk`), 12 (`placeTile`, merged), 13, 14, 17, 18.
- Before start: record an R-V02 table row in the 8a ledger for files outside `src/viz/**` (`docs/spec/12-visualizer.md`, the roadmap, `test/integration/viz/browserSmoke.test.ts`), owner Task 19.
- One merge: F32 §7 items 1–9 and 11 (12 + roadmap), the eight codes in `src/viz/i18n/{codes,en}.ts` (T-VIZ-i18n deep-equals 12 §3.11 with `codes.ts`), new `src/viz/ui/follow.ts`, `KeyAction 'follow'`/`KEYS F` in `ui/a11y.ts`, wiring in `client/{office,log,a11y}.ts`, browser smoke item (k) without its recording clause, re-run of Task 18 step B's exit sweep. `ui/fragment.ts`, `ui/zoom.ts` unchanged.
- Tests: T-VIZ-follow-camera, -motion, -now, -plan2, -replay, -filter, -keys, -i18n (`en`), -privacy (k).

**Q3 — F04-b: viewer catch-up** (follow-up task after 8a exits; **not** an 8a task)
- Gate: 8a exit.
- Build: `src/viz/model/moments.ts` (`moments`, `lastVisit`), `RoomVM.open_h`, the catch-up panel and Play on the dev page (en), the §3.7 **montage** render state (one row, shared later by F29).
- Tests: T-F04-moments, -visit.

**Q4 — optional (only if D5 option (나)): Plan 2 interface asks + pure carve-outs**
- Gate: gate P.
- Plan 2 additive asks (union, §4 item 12) in one follow-up task; then F14 `flowEntries()` (`src/status/flow.ts`; O1, O4, O5, O6, O8 human-CS only, I1, I3, I4; Plan 2 extra `DeferReason` mapping per F14 §9) and F12 `attributionRows`/`draftModel` (codes + params only, whole-file `RegionMapper` binding). Neither shows anything to users.

**Q5 — Plan 3 contributions** (add to the Plan 3 draft plan before its next review)
- F10 (placement §9): journal lookup and epoch-scoped `locateCs`, `revertInverse()` (step 4 with rename pairing, step 7), BUSY guards, step-5 taint backstop, observed attribution (HLD-26), the HLD-50 shrink attribution (**D2**), the second human-class CS (like HLD-36 `recovered`), `RF_REVERT_NOT_SHARED`. Natural home: next to Plan 3 Tasks 8 (provenance) and 9 (CS table). **File-name collision:** Plan 3 Task 8 creates `src/holds/revert.ts` for the HLD-27 revert *detector*; F10's kernel must use another name (e.g. `src/holds/revertCs.ts`).
- F14/F12 (**D1**): `last_check`/`last_pass` per open seat CS written at HLD-67 step 4, the T0-at-publish drop (`stale`) and 06 §3.8.4 skips 3–6 (`skipped`) — Plan 3 Task 10 owns HLD-67 steps 1, 3, 4 (ruling R3-03). F14 O2/O3/O7/I2 inputs (seat CSs, hold registry, INCOMING/not-applicable records).
- F04: hold-transition rows (PARKED, returned, SUBSUMED) in the `sinceReport` fixtures.

**Q6 — Plan 4 contributions**
- F14: `editCheck` returns `line` for checks 1–3 as a row of `M'` (FEAT-F14-07; R3-03 puts `editCheck` in Plan 4).
- F10: step-6 predictions (REG `gate()` on the result hunks → `WOULD_HOLD`/K6; edit-check entry point → `WOULD_BREAK`).
- F04: claims and daemon-verified labels in fixtures. F05: prerequisites only (claim fold, `mapRanges` local mode, REG-34 labels).

**Q7 — Plan 5 contributions**
- F04: human-activity marks (CCI-37 nonce rule), return detection with this PC's `max(Δwall, Δmono)`, `meta.since` writes/persistence, IPC frames `since_query`/`since_ran` (FEAT-F04-18 acceptance rule), the loader `system` carrier, CCI-46 metering, `PULL_MODE` shrink. Tests T-F04-return, -restart, -since-first.
- F14: the IPC `flow` selector (registered in the 09 §3.11 schema, ≤ 2,000 entries + omitted count), seat numbers ("Claude session N"), `PULL_MODE`/`MID_TURN` read sets (I4a/I4b), `fence`/`read_lease`/`txn` defer reasons.
- F10: `cowork_show(cs_id)` undo view and the tool-description clause (FEAT-F10-10).

**Q8 — Plan 6**
- **F05 main task** "F05 claims-ahead notes and `cowork_show` path view": daemon selection/dedupe (key `(seat, agent_id, claim_id)`), `T-AHEAD*`/`R.show.*` en/ko, the `cowork_show` description clause (RULES unchanged), MCP argument extension; tests T-F05-read-hit … -schema, -text, -reorder (TST-19 weekly rotation, shared ≤ 30 runs/night).
- F04: `T-SINCE` en/ko, digest priority 7 after `T-WAKE_RECAP`; request/answer/note/STALE/`presume_absent` rows in fixtures.
- F10: `T-SHOW_UNDO.*`, `T-WAKE_RECAP.undo`.
- Plan 6 exit cost soak MUST run with F05 notes on (and with the F04/F10 texts merged by then).

**Q9 — Plan 7** (in this order)
1. Status/show rendering task: **F14** (`--flow`, section 6 → "In flight", path view lines, `UI_FLOW_*`/`UI_DEFER_*` in six languages, `data.flow`) together with **F05**'s human path-view claims section (`UI_PATH_*`, `UI_ACT_*`, `--json data.claims[]`, several positional args, T-F05-cli). Fix the section priority under the shared 4,000-char slash cap (§4 item 8).
2. **F10** "F10 own-change revert": verb, `last`, preview/confirm (LIF-02), SEC-25 evidence, slash cut order, six-language catalogs, `/cowork log` hint, TST-25.
3. **F04** verb: `/cowork since` slash, `--json cowork-since/1`, six-language `UI_SINCE_*`, `user.json` keys `since.recap`/`since.claudePointer`, TST-25, T-F04-text, slash rows of -readonly, -i18n.
4. **F12** "`/cowork wrap` + `saveAttribution` + save-preview draft", last: after the status/queue tasks (10 §3.5, §3.7), save (08 §3.7) and the catalogs; reuses F14's `last_check` and `UI_FLOW_LAST_*`, F10's candidate predicate (W6), and refactors 08 §3.7.2 into `saveAttribution`.

**Q10 — Plan 8b** (in this order)
1. F04: six-language panel strings, montage polish, T-F04-agree. F32: six-language templates, smoke (k) recording clause, the 10-product §3.18 README sentence (F32 §7 item 10).
2. **F34** "Postcards (F34)" right after the 8b record/export task. It extracts `client/save.ts` `saveBlob` and `render/viewport.ts` `composeViewport` if the export task has not (recommend the export task creates them).
3. **F29** "Highlight reel (F29)" after the export task and F34: adds the `reel-` alternative to the `saveBlob` name pattern, reconciles its §3.7 montage row with F04-b's, `catchUpAnchor` reads F04's panel anchor. Its pure core (`reelMoments`, `planReel`, `reelRange`, `reelCamera` + T-VIZ-reel-moments/-plan/-fit/-det/-range/-camera) MAY be pulled forward as an 8a follow-up once 8a Task 6 has merged.

---

## 3. Feature cards

### F05 — Claims ahead: who is changing what, seen before the edit
- **Design file:** `docs/proposals/F05-claims-ahead.md`
- **implementableNow:** false. Plan 2 folds `claim` ops as no-ops (contract R-12); no hook carrier, seat or MCP server yet. No protocol change; can also land after the public release.
- **Dependencies:** Plan 4 (claim fold, claim view, `mapRanges` local mode, REG-34 labels); Plan 5 (PostToolUse(Read) payload and view blob, carrier slots and `printed{batch_id}`, CCI-46 meter and `PULL_MODE`, MCP server and `cowork_show`, seat activity); Plan 6 (template registry). Plan 3 indirectly.
- **Target:** Plan 6 new task "F05 claims-ahead notes and `cowork_show` path view"; Plan 7 `/cowork show` task gets the human section (six-language `UI_` codes, `--json`, T-F05-cli).
- **Spec sections to edit:** 00 §15 (`cowork_show` id forms; `show <id|path|glob>…`), §19 (PostToolUse attribution slot), §20 (new "Claims ahead" row), new revision section; 06 §3.13 (item 7), §3.14.1, §3.14.4, §3.16.1 (`PULL_MODE` list), §3.16.3, §4 (FEAT-F05-01…11 under next free CCI ids), §7; 07 §1.2, §3.14 item 4, §3.16.1–§3.16.4, §3.17 (item 4a), COO-30, §4 (FEAT-F05-13, -14), §7 G-templates; 10 §2, §3.8, §3.18 (quote globs), UX-11, §3.19 (nine `UI_` codes), §4 (FEAT-F05-12); 11 (T-F05-* registration, TST-19 rotation, cost soak with notes on). 12: none.
- **Owner gate:** none. **Open (defaults ship):** no per-user opt-out; read-only subagents spend the 5,000-char share; `WHOLE_FILE` overlap loudness; host default Read line count and `offset` base to pin (SPIKE-0 style); RULES trimmed line only if T-F05-reorder fails.

### F04 — Catch-up summary (`/cowork since`)
- **Design file:** `docs/proposals/F04-since-catchup.md`
- **implementableNow:** partial — only F04-a (Q1). Everything user-visible waits for Plans 5–7 and 8b; the viewer part is a follow-up after 8a (Q3).
- **Dependencies:** F04-a: gate P, 8a Task 2 (12 §9.7 items 1, 2, 8), 8a Task 11 (`cli.js` dispatch). Later: Plan 5 (UserPromptSubmit/Expansion hooks, CCI-37, loader `system` field, CCI-46), Plan 6 (07 templates, digest), Plan 7 (slash verb, catalogs, sanitize/`scanSecrets`, 08 §2.6 flags, TST-25), 8a exit (F04-b), 8b (six-language panel). Content rows from Plans 3, 4, 6. F01 optional (`--since=away`, not defined here).
- **Target:** Q1 F04-a (Plan 2 follow-up) → Q3 F04-b (after 8a) → Q5/Q6 fixture rows (Plans 3, 4) → Q7 (Plan 5) → Q8 (Plan 6) → Q9.3 (Plan 7) → Q10.1 (8b).
- **Spec sections to edit:** 00 new revision section: §15 (append `since`; flags), §17 (`since.recap`, `since.claudePointer`), §19 (catch-up pointer 300), §20 ("Catch-up" row); 01 §3.2 (`meta.since`, "Transitions only" exception), ENG-05; 06 §3.12.2 (human activity definition), CLI↔daemon frames `since_query`/`since_ran`, §3.14.1 (`system` recap), §3.16.1 (`T-SINCE` non-mandatory; recap shrink), CCI-46; 07 §3.16.1–§3.16.4 (`T-SINCE`, no `MR_` mirror), §3.17, COO-29; 08 §2.6; 10 §1.1, §1.2 (`RF_SINCE_ANCHOR`, verb list), new §3.9a, §3.12 (recap; named I18N-10 exception), §3.19, §4 (FEAT-F04 ids kept), INV-UX-READONLY, schema list `cowork-since/1`; 11 TST-25, T-F04-* tables, §3.10 lints (`src/since/**` and the shared zone module join the pure set); 12 §3.8 (panel), §3.9.1 (visit flag, Play/montage), §3.10.6 (`RoomVM.open_h`), §3.11 (eight `UI_VIZ_CATCHUP*`/`ANCHOR*`/`MONTAGE` codes — land with Q3's code, §4 item 10), §3.13 (`model/moments.ts`), §4.
- **Owner gate:** D5 (start of F04-a). **Open, controller/spec-level (not routed to the owner):** "no mirror" exception vs a 07 human-only template row for the recap; untagged human-class writers can suppress a recap; restarts within 30 min count as a return; only one seat's Claude gets `T-SINCE`; six-language `UI_SINCE_*` texts and `T-SINCE` worst-case lengths unwritten; whether `systemMessage` mirrors count toward CCI-46 (F04 meters anyway).

### F12 — End-of-day wrap and save-summary draft (`/cowork wrap`)
- **Design file:** `docs/proposals/F12-wrap-and-save-draft.md`
- **implementableNow:** false. Optional carve-out after Plan 2: pure attribution core (`attributionRows`, `draftModel`), codes + params only, with three Plan 2 asks (§4 item 12).
- **Dependencies:** Plan 3 (open-CS table, ready pairs, PIN records, seat CSs), Plan 4 (REG mapper and labels, `editCheck`, claims in the fold), Plan 5 (IPC, seats, evidence), Plan 6 (`requests` in the fold), Plan 7 (verb surface, slash mode, save and its preview, `render`/i18n, `scanSecrets`). Optional: F10 (W6), F14 (shared `last_check`), F01/F08 (absent → lines omitted); F25 would reuse the generator.
- **Target:** Plan 7 task "`/cowork wrap` + `saveAttribution` + save-preview draft" (Q9.4).
- **Spec sections to edit:** 00 new revision section: §15 (`wrap`, `--json` only), §20 ("Wrap" row), §27.1 "Fail" bullet (= F14); 04 §3.20 Result, REG-36, INV-REG-EDITCHECK (`last_check` is not a record/status text; `no_snapshot`/`merge_conflict`/`no_merge` never as checks 1–4); 05 HLD-67 step 4 (= F14, + `/cowork wrap`); 06 §3.8.4 (= F14), §3.9 read-only verb list; 07 COO-10, §3.4 (= F14, + `/cowork wrap`); 08 §2.1 + LIF-02 (draft is not a source of `items`), §3.7 step 6, §3.7.2, LIF-27, Table 2.7-A (`SAVE_PREVIEW draft?`; `SAVE_SUMMARY_EMPTY` next → `NX_WRAP_THEN_SAVE`), §7 test 7; 09 §3.11 (IPC kind `wrap`), §3.2 (state no change), SEC-08, SEC-34 (paste-safe pass); 10 §1.1, §1.2, new §3.20, §3.2, §3.3 + **UX-03** (truncation line above a commands block), §3.4 + §3.18 (`cowork-wrap/1`), §3.19 codes, I18N-07 lint (no `" \` $ \\ !` in `UI_DRAFT_*`), §4 (FEAT-F12 under next free UX ids), INV-UX-READONLY, quick-start/guides, §7; 11 TST-26, security set. 02, 03, 12: none. (The review summary's "no change to 06, 07" is wrong; the file's "= F14" edits apply.)
- **Owner gate:** D1 for W3's edit-check reason only. **Open (defaults ship):** paste-ready `/cowork save "<draft>"` stays off; 08 §3.7.2 attribution-range gap belongs to the 08 owner; multi-line paste through `!` unmeasured; which shell runs the `!` line on Windows unmeasured (T-F12-draft-hostile runs both); F01/F08 command forms are placeholders.

### F14 — In-flight view (`/cowork status --flow`)
- **Design file:** `docs/proposals/F14-status-flow.md`
- **implementableNow:** false for the visible feature. Optional pure `flowEntries()` carve-out after Plan 2 with **six** additive Plan 2 asks (not three) and the Plan 2 `DeferReason` mapping.
- **Dependencies:** Plan 3 (seat CSs, HLD-67 `last_check`, hold registry, INCOMING/not-applicable records), Plan 4 (`editCheck` line numbers, T0 findings), Plan 5 (IPC detail request, seats, `fence`/`read_lease`/`txn`), Plan 7 (status/show CLI, render, catalogs, schemas). Data from Plan 2 (ready pairs, human CSs, `meta.pending`, push intent, exclusions, governor). No 8a dependency.
- **Target:** Plan 7 task "`/cowork status` and `show` rendering" (Q9.1); contributions Q5 (Plan 3), Q6 (Plan 4), Q7 (Plan 5). The edit-check ownership conflict F14 flags (Plan 3 vs Plan 4) is resolved by Plan 3 draft ruling R3-03: Plan 4 implements `editCheck`, Plan 3 owns HLD-67 steps 1, 3, 4.
- **Spec sections to edit:** 00 new revision section: §15 (`status [--flow]`), §27.1 "Fail" bullet (**D1**), §3 term "flow entry"; 01 §3.16; 02 §3.8 (`wait_detail()`); 04 §3.1 (`failed[].line`), REG-36 (**D1**), §3.20 (**D1**); 05 HLD-67 step 4; 06 §3.8.4 (skips 3–6 → `last_check{skipped}`; "no pushed message"), §3.16.1 item (1); 07 COO-10, §3.4 (**D1**); 09 §3.11 (`flow` selector), SEC-38 (+ teammates' display names); 10 §1.1, §3.5 section 6 → "In flight", new §3.5.1, §3.8 path view, §3.19 (`UI_SECTION_IN_FLIGHT` replaces `UI_SECTION_PENDING`; `UI_FLOW_*`, `UI_DEFER_*`), UX-F14a/b (next free UX ids), §7, §8 Q2 closed, §3.18 troubleshooting + `conflicts.md`; 11 test registry, T-F14-secret in the security set. 12: none.
- **Owner gate:** D1 (if "no": drop `{last}`/O10's second line and `last_check`; the rest ships). **Open (controller):** whether apply-coalescing paths enter the defer set and with which reason (06 §3.7.5); "session N" numbering not defined in 06 §3.11; `UI_DEFER_*` vs mirrored `{DEFREASON}` two wordings; default top-5 may hide a stuck `in` line (consider ≥ 1 `in` line).

### F10 — Revert my own change-set (`/cowork revert <cs_id|last>`)
- **Design file:** `docs/proposals/F10-revert-own-change-set.md`
- **implementableNow:** false. Optional kernel (`revertInverse()`, `locateCs()` over a bounded first-parent walk of `parseCsTrailers`) on Plan 2's `GitRepo`, `mergeFile`, `parseCsTrailers`, `Writer.writeLocalGroup`; review recommends writing it inside Plan 3 (Q5) to avoid rework.
- **Dependencies:** Plan 3 (provenance journal HLD-25, D2 predicate, T0/K7, HLD-26, a second human-class CS), Plan 4 (B1/K6, edit-check entry), Plan 5 (`cowork_show`, MCP), Plan 6 (Claude-facing templates, `T-WAKE_RECAP`), Plan 7 (verbs, preview/confirm LIF-02, SEC-25 evidence, i18n).
- **Target:** ships in Plan 7 task "F10 own-change revert" (Q9.2); pieces Q5 (Plan 3), Q6 (Plan 4), Q7 (Plan 5), Q8 (Plan 6). Plan 8: none.
- **Spec sections to edit:** 00 §15 (acting verb `revert`; `show --undo`; preview/confirm list; `undo` stays removed), §6 (`cs/<enc(b)>.reverts.jsonl`), §9 (forbidden-list exception `revertInverse()`), §20 ("Revert" row); 05 §2 "observed change", HLD-26, HLD-50 item 3 (**D2**), new rule Algorithm REV (id at merge), §3.6; 06 `cowork_show` row + new rule (FEAT-F10-10); 07 RULES **unchanged**, `T-WAKE_RECAP.undo`, `T-SHOW_UNDO.head/.foot/.trunc/.human/.notown`, registry rows, cap-table rows, new rule (FEAT-F10-12); 08 §2.6; 09 §2 (acting verb list); 10 §1.3, §3.4, §3.8 (change-set view, `--undo`), §3.9 (`UI_LOG_REVERT_OF`, `UI_LOG_REVERT_HINT`), §3.19, two UX rules (ids at merge); 11 TST-25, new §7 subsection (§7.11 today) TC-F10-01…16. 12: none.
- **Owner gate:** D2 (if "no": refuse or predict-unshippable any revert that shrinks a file by more than half or deletes a CS-created file). **Open (controller):** the `@<epoch8>` id form; line-hash name attribution heuristic; ≥ 6-char prefixes usually ambiguous (`/cowork log` should print full ids; a short display id is a follow-up); re-measure the combined human-origin digest (≤ 1,500) with `T-WAKE_RECAP.undo` + `T-SINCE`.

### F32 — Follow a teammate (`/cowork view`)
- **Design file:** `docs/proposals/F32-follow-teammate.md`
- **implementableNow:** true with respect to Plans 3–7 (their facts fill the now card with no F32 change); not codeable before gate P because Tasks 5, 13, 14, 17, 18 wait for it.
- **Dependencies:** 8a Tasks 4 (merged), 5, 12 (merged), 13, 14, 17, 18; rulings R-V22, R-V25, R-V56. Six-language strings and the recording clause of smoke (k) wait for 8b.
- **Target:** 8a new Task 19, group G9 after Task 18 (Q2) — or all of it in 8b if D3 says so (costs only time). 8b: catalogs, recording clause, README sentence (Q10.1). Requirements keep `FEAT-F32-01…12` ids.
- **Spec sections to edit:** 12 §1.1, §2 (terms "following (a person)", "now card"), §3.5.3 (follow camera replaces the 30 s rule), §3.8 Filters, new §3.8.1, §3.11 (eight codes + Keyboard `F`/`Esc`), §4 (VIZ-24, VIZ-28 amendments; new "Following" group with FEAT-F32-01…12), §7 (nine rows; smoke item (k)), §9.2 (glossary §20 viewer row); 10 §3.18 README `privacy` (via 12 §9.4); roadmap row 8 (8a/8b exit criteria).
- **Owner gate:** D3. **Open (defaults ship):** Q1 no follow in recordings; Q2 keep one-key `F` (settle with `L` if accessibility review asks); Q3 `Esc` closes an open panel first (consistent with F34).

### F34 — Postcard: still picture and text status for chat
- **Design file:** `docs/proposals/F34-postcard.md`
- **implementableNow:** false. Needs 8a Tasks 5, 13, 14, 17 and 8b's recording canvas, viewport composer, anonymize transform and six catalogs; 8b follows Plans 5 and 7. Pure parts (`ui/postcard.ts`, `stillPhase`, T-F34-text) could start after 8a Tasks 5 and 13 once the anonymize map interface is fixed; F34 §9 Q3 default keeps them in 8b.
- **Dependencies:** as above; for release, Plan 7 `scanSecrets` (VIZ-36 D2 re-scan, already 8b's gate). No Plan 3–7 data needed.
- **Target:** 8b task "Postcards (F34)" right after the record/export task (Q10.2). Requirements keep `FEAT-F34-01…09` ids.
- **Spec sections to edit:** 12 §1.1, §3.9.4 (Saving → `saveBlob`; Anonymize shared state + `UI_VIZ_ANON_NAME_NTH`; Panel `Esc`), new §3.9 subsection (§3.9.5 or next free), §3.11 (Postcard row, 19 codes, `UI_VIZ_RECORD_NOTICE` template revised in six catalogs, Keyboard `Esc`), §3.12 (perf row), §3.13 (`ui/postcard.ts`, `client/postcard.ts`, `client/save.ts`, `render/viewport.ts`), §4 ("Postcards" FEAT-F34-01…08; VIZ-25 amendment), §5 INV-SECRET (`local_only` in a postcard), §6 (two clipboard rows), §7 (T-F34-*; smoke item (j)), §9.1 (8b builds + exit), §9.2 (glossary §20 viewer row), §9.5 L-VIZ-DOM (save.ts exception; clipboard rules) and L-VIZ-IMPORT (`ui/** → render/**` ban); 10 §3.18 README `privacy`.
- **Owner gate:** D4 (only whether it is in the first public release). **Open (defaults ship):** notes never, even with anonymize off; no combined image+text clipboard item; chat auto-linking and markdown characters not escaped; stable anonymize numbering across "Take again" (proposed default for 8b's transform); health labels kept; `UI_VIZ_SCENE_SUMMARY` plural fix pins the T-F34-text golden.

### F29 — Highlight reel (`Make reel`)
- **Design file:** `docs/proposals/F29-highlight-reel.md`
- **implementableNow:** false. Recording is 8b (R-V32); the pure core may be an 8a follow-up once 8a Task 6 has merged (after gate P).
- **Dependencies:** 8a Tasks 4–6, 13–14; the 8b export task (§3.9.4: record panel, virtual clock, WebM/GIF, anonymize, caption strip); 8b catalogs. F04 optional (default-range anchor, shared montage state). F29 does **not** use F04's `moments()` (it owns `reelMoments`/`ReelMoment` in `model/reel.ts`). Plans 3, 4, 6, 7 only add data to kinds already grouped.
- **Target:** 8b task "Highlight reel (F29)" after the export task and F34 (Q10.3). Requirements keep `FEAT-F29-01…13` ids.
- **Spec sections to edit:** 12 §1.1, §1.3 (reel extras out of scope), §2 (reel, chapter, montage step), §3.7 (States sentence; title-card and montage rows — one montage row shared with F04-b), §3.9.4 (Panel source, Recording canvas, Saving `cowork-reel-<n>`), new §3.9 subsection (§3.9.5 or next free), §3.11 (17 codes; "reel title 60" cap), §3.13 (`model/reel.ts`; `catchUpAnchor` with F04), §4 (VIZ-22, VIZ-28 amendments; FEAT-F29-01…13), §5 (INV-VIZ-REEL), §7 (twelve T-VIZ-reel-* rows), §9.1 (8b builds/exit), §9.2 (glossary §19/§20 viewer rows); 10 §3.18 README `privacy`.
- **Owner gate:** D4. **Open (defaults ship):** ranking recency vs richness; no range sharing in the fragment; no clips > 60 s; one `CH_REQUEST` title for accept/decline; 40 s GIF may hit the 10 MB cap (drop GIF default to 30 s if a field reel hits `UI_VIZ_RECORD_CAP`); freeze chapters name a teammate.

---

## 4. Merge-time collisions and shared pieces

Assign numbers in merge order and record them in the table at the end of this section.

1. **Glossary revision section.** 12 §9.2 already claims §28; F04, F05, F10, F12, F14 each add a revision section → next free number at each merge (newest wins).
2. **UX ids.** UX-32/33 were proposed by F04, F10, F12, F14 → all now say "next free at merge"; F04 keeps FEAT ids only.
3. **CCI ids.** F05 and F10 both wrote CCI-57 → next free at merge. Same for COO and HLD rule ids F10 needs.
4. **VIZ ids.** F32 and F34 both wrote VIZ-43… → both keep `FEAT-Fxx-NN` ids (as F29). No VIZ renumbering.
5. **12 §3.9.5.** F29 and F34 both propose it → per Q10 order F34 merges first and takes §3.9.5, F29 takes §3.9.6; fix every "§3.9.5" reference in the second.
6. **Browser smoke letters.** F34 = (j), F32 = (k) as written (F32 may merge first in 8a; keep (k) so F34's text stays valid).
7. **`saveBlob` name pattern.** F34 creates `^cowork-(view-…|postcard-…)$`; F29 adds `reel-[1-9][0-9]{0,3}\.(webm|gif)`.
8. **`/cowork show <path>` under the 4,000-char slash cap.** F05 adds a claims section, F14 adds 1–2 flow lines. Proposed (not decided by either file): scope line → F14 flow lines → F05 claims section, F05 section truncated first with `UI_AND_MORE`.
9. **`cowork_show` tool description.** F05 adds ≈ 80 chars, F10 ≈ 45 chars; CCI-47 schema total ≤ 3,000 measured with both (T-F05-schema, TC-F10-14). RULES unchanged by both (990/1,000 en); F05's trimmed RULES line is an alternative only after a failed T-F05-reorder.
10. **12 §3.11 code tables land with their code.** T-VIZ-i18n deep-equals 12 §3.11 with `src/viz/i18n/codes.ts`; F32, F04-b, F34, F29 code-table edits must merge together with the code that defines them. Chapters 00–11 edits may be batched earlier.
11. **`zone()` home.** F04 moves `zoneOf` out of `src/viz/model/layout.ts` (merged in 8a Task 4); F12 proposes `src/data/zone.ts`. Use one module. 12 §9.5 L-VIZ-IMPORT bans `src/ports`, `src/git`, `src/engine` from the client, not `src/data`, but check 8a's client-closure lint before relying on it; fallback: duplicate with a parity test. F12 renders a root file by its own name instead of `·` at render time; `zone()` itself is unchanged.
12. **Plan 2 interface asks (union, all additive).** F12: `authorName` on `CommitInfo` or `readLiveCommits`; a changed-paths reader for a single-parent live commit (`diff-tree --no-ext-diff --no-textconv -z --name-only c^1 c` via `GitRepo.run`); the `zone()` home (item 11). F14: `ChangeSets.quietLeftMs()`; `EngineInspection.dirtyPaths`; `EngineInspection.incomingPaths` with writer, needing `IncomingCs.writer` and the fold's peer → display-name map; `EngineInspection.pushIntentPaths`, `exclusions` and a Δmono first-seen anchor per `pending` path; `Governor.waitDetail()`. F04: 12 §9.7 items 1, 2, 8 (delivered by 8a Task 2) and optional `meta.since`. F10: none.
13. **`last_check` single store.** F12 and F14 share it with F14 §4's shape; the "= F14" spec edits (glossary §27.1, HLD-67 step 4, 06 §3.8.4, COO-10/07 §3.4) are applied once by whichever merges first, the other only appends its verb to the human-typed outputs list. Gated by D1.
14. **Montage render state.** One 12 §3.7 row: introduced by F04-b (≤ 1.5 s, ≤ 12 desks), reused by F29 (1,200 ms). Captions stay separate codes (`UI_VIZ_MONTAGE`, `UI_VIZ_REEL_MONTAGE`) unless the F29 merge decides otherwise.
15. **Digest budget.** `T-WAKE_RECAP` (+ F10 `.undo`, 101 en / 75 ko) then F04 `T-SINCE` (≤ 300) in one human-origin digest delta (≤ 1,500) — re-measure when both merge.
16. **`Esc` order.** F34: `Esc` closes an open export panel first; F32: otherwise clears filters and ends the selected room's follow. Apply both 12 §3.11 Keyboard edits together.
17. **Catch-up panel and now card.** When both exist, F32's now card sits directly below F04-b's catch-up panel at the top of the log.
18. **File-name collision (new, found while queuing).** Plan 3 draft Task 8 creates `src/holds/revert.ts` (HLD-27 revert detector); F10's kernel planned the same name. Rename F10's module.
19. **F04 `T-SINCE` mirror.** F04 keeps a named "no `MR_` mirror" exception (I18N-10); the alternative (a 07 human-only template row) is a spec-mechanics choice for the 07/10 owners at merge, not an owner decision.

| Proposal | Glossary rev § | Chapter rule ids | 12 subsection | Smoke letter |
|---|---|---|---|---|
| F04 | §29 | — (FEAT-F04 ids in 10-product §4; tests in 10-product §7) | §3.8 panel (codes pending in §9.9) | — |
| F05 | §29 (+ §15, §19, §20 in place) | CCI-57…CCI-67, COO-34, COO-35, UX-32 | — | — |
| F10 | §29 (+ §6, §9, §15, §20 in place) | HLD-68, CCI-68, COO-36, UX-35, UX-36; tests 11 §7.11 TC-F10-01…17 | — | — |
| F12 | §29 | UX-37…UX-54 | — | — |
| F14 | §29 | UX-33, UX-34 | — | — |
| F32 | — (pending §28 viewer rows, §29.7) | — (FEAT ids) | §3.8.1 (codes pending in §9.9) | (k) |
| F34 | — (pending §28 viewer rows, §29.7) | — (FEAT ids) | §3.9.5 (codes pending in §9.9) | (j) |
| F29 | — (pending §28 viewer rows, §29.7) | — (FEAT ids) | §3.9.6 (codes pending in §9.9) | — |

*Filled 2026-10-08 at the merge (MERGE-LOG.md).* Other ids assigned: 05 §7 I18, 06 §7 tests 48–60, 09 §7 tests 32–35, 11 §3.10 lint `L-PURE`. 12 §9.2's pending glossary section is relabelled "§28 Visualizer (2026-10-06; superseded by §29 where they differ)".

---

## 5. Known differences between the review summary and the files (file wins)

- **F04:** summary put F04-b "inside Plan 8a"; file §8 says a follow-up after 8a, not an 8a task. F29 §8 still says "F04-b, in Plan 8a" (stale). Summary put `meta.since` into "Plan 2 Task 8 if still open"; Task 8 is closed, so it is an optional additive follow-up.
- **F12:** summary said "no change to 02, 03, 06, 07 or 12" and "UX-32..UX-46"; file edits 06 §3.8.4/§3.9 and 07 COO-10/§3.4 (= F14) and takes next free UX ids.
- **F14:** summary said three Plan 2 asks; file says six.
- **F34:** summary said VIZ-43..VIZ-50 in a new §3.9.5; file keeps FEAT-F34 ids and the next free §3.9 number.
- **F29:** summary said the pure core waits for "F04's moments contract"; file no longer uses F04's `moments()`.
- **F34 vs F29 order:** F34 §8 says postcards after the reel task; F29 §8 says the reel after F34. Both texts tolerate either; this queue picks F34 first (it creates `saveBlob`/`composeViewport`; F29 only adds a name alternative and needs F04-b's montage row).
- **F14 edit-check ownership flag:** resolved by Plan 3 draft ruling R3-03 (Plan 4 implements `editCheck`; Plan 3 owns HLD-67 steps 1, 3, 4).
- **Merge-time departures from the design files (2026-10-08):** listed in glossary §29.9 and in `MERGE-LOG.md` (D1 narrowed to the `tty` output of `status --flow` and `wrap`; D2 keyed to the written blob; F10's undo view writes no file, is throttled, background-priority and secret-scanned; the 04 read-only preview exception; the 12 §3.11 rows parked in 12 §9.9; the codes and templates named at merge).

---

## 6. Not queued (ranked below the top 8)

F17, F19, F31, F30, F33, F01, F02, F16, F07, F18, F22, F23, F03, F20, F15, F21, F11, F06, F26, F24, F35, F27, F25, F08, F13, F09, F28. No design files exist for them. One-line reasons in README.ko.md §4. Those whose descriptions add a board op, op field or trailer (F01, F02, F06, F09, F13, F15, F27; F08 likely, since the recipient must reach the board) would need protocol-compatibility work if added after the public release. Kept proposals reference some of them only as optional hooks (F12: F01, F08, F25; F04: F01); their lines and anchors are omitted until those exist.
