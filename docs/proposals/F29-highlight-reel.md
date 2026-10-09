# F29 — Highlight reel (`Make reel`)

**Status:** proposal (spec delta), 2026-10-08, revised after an adversarial review the same day (see "Review notes"). Targets 12-visualizer (conformed to glossary rev 2.4) and the pending glossary §28 of 12 §9.2. · **Depends on:** 12 §3.9.4 export (Plan 8b). **Optional:** F04 (its viewer catch-up anchor seeds the default range, §2.2 rule 1, and its Play montage beat shares the montage state, §3.3). F29 does **not** use F04's `moments()`: that function classifies single events into `mine`/`team` lanes relative to `you` (F04 §3a), which a reel must not read (§4 item 5); F29 owns its own grouping, `reelMoments` (§3.1). · **Section number:** this proposal writes the new 12 section as §3.9.5; F34 (postcard) proposes a §3.9.5 too, so whichever merges second takes the next free number and every "§3.9.5" below follows it. · **Ids:** requirements keep their `FEAT-F29-NN` ids when merged (no renumbering into `VIZ-`, so parallel proposals cannot collide).

## 1. Purpose

A team lead wants today's session — a go-first negotiation, a conflict that got untangled, a save with confetti — as a 20–40 s anonymous clip for team chat, a retro or a README GIF, with no editing. VD-1 already makes the viewer "a recordable replay/demo for promotion"; F29 turns a height range into a short, chaptered recording with **one click** in the record panel. It is built only from scene events the page already receives or fetches as timeline pages (§3.3.7, §3.10.5), runs only in the page, and uses the existing recording pipeline (virtual clock, WebM/GIF, anonymize, caption strip). It adds no board op, route, server code, transport or stored state.

## 2. User-visible behaviour

### 2.1 Control

The record panel (§3.9.4) gains the source **highlight reel** and the button `UI_VIZ_CTRL_REEL` ("Make reel" / "영상 만들기"). With every option at its default, one click on it plans the reel, renders it on the virtual clock and saves the file. Above the button the panel shows `UI_VIZ_REEL_SUMMARY` ("#{lo}–#{hi} · {n} highlights · {dur}", `{dur}` = the video's length as a `dur` param, §2.5) and the rendered chapter titles, recomputed whenever the range or an option changes; while it fetches timeline pages it shows `UI_VIZ_REEL_LOADING`. Options (reset on every page load, never persisted): range (the panel's replay-range inputs, prefilled by §2.2), chapters `UI_VIZ_REEL_CHAPTERS` 1–8 (default **5**), length cap 20 / 30 / **40** / 60 s, format **GIF** (default) or WebM, anonymize (the record panel's own switch, default **on** for real rooms; demo data needs none), end card `UI_VIZ_REEL_END_TOGGLE` (default on).

### 2.2 Range

`[lo, hi]` heights of the selected room, frozen at the click (live extension during rendering changes nothing). Default, first rule that applies:

1. F04 is merged and the selected room's catch-up panel has a resolved anchor height `a` (F04 §2.4: last visit, last save, since this view opened, or a typed height) → `[a + 1, h1]`, **if** `[max(a + 1, h0, h1 − 2,047), h1]` holds an eligible moment (§2.3; the same probe as rule 2). Otherwise, or without F04, rule 2. (A short absence would otherwise give an empty reel by default.)
2. Let `s1` be the newest and `s2` the second-newest `save` tick (§3.10.6 `Tick`, glyph `save`) in the window. If `s1` exists and `[max(s1 + 1, h1 − 2,047), h1]` holds an eligible moment (§2.3; the clip comes first, so this check fetches no more than the reel would) → `[s1 + 1, h1]` ("since the last save"). Else if `s1` exists → `[(s2 ?? h0 − 1) + 1, s1]` (the session that save closed, ending in its confetti).
3. Otherwise → `[max(h0, h1 − 255), h1]`. (Before Plan 7 no `save` is emitted, so rule 3 applies.)

Typed inputs match `^(0|[1-9][0-9]{0,9})$` (an input that does not match, or gives `lo > hi`, `lo < h0` or `hi > h1`, leaves `UI_VIZ_CTRL_REEL` disabled with no new message, as the replay-range inputs already behave); every range, default or typed, satisfies `h0 ≤ lo ≤ hi ≤ h1` of the window at the click (a rule-1 range is intersected with it; older history: "load earlier" first, so a reel never makes the server extend the window). A range longer than **2,048** heights (the server's retention, §3.3.3) keeps `hi` and raises `lo` to `hi − 2,047`, with `UI_VIZ_REEL_CLIPPED`.

### 2.3 Chapters

Moments come from `reelMoments` (§3.1), which groups the scene events of `[lo, hi]` by the closed table there. A moment is **eligible** when `complete` is true (a request whose answer other than `later` lies in the range, a hold-record conflict whose record reached a terminal state in the range, an event-sourced conflict (terminal at creation, 12 §3.7), a freeze with its thaw; saves, joins and rejoins are single-beat and always complete). Selection, from the eligible moments of `[lo, hi]`:

1. **Kind order:** conflict → negotiation → save → freeze → arrival. **Within a kind:** more beats first, then earlier `start` position.
2. **Round-robin:** pass 1 takes the best remaining moment of each kind in kind order, pass 2 the next of each, …, until `N` chapters are chosen or none remain. A candidate whose height span `[beats[0], beats[last]]` intersects an already chosen chapter's span is skipped.
3. **Fit** (`totalMs ≤ cap`, §2.4): while over the cap, drop the last-chosen chapter (its events fall into a gap, whose montage count grows); a dropped chapter is not replaced. One chapter always fits: ≤ 6,800 + 2 × 1,200 + 1,500 = 10,700 ms < 20 s, the smallest cap.
4. Chosen chapters play in ascending `start` order.

A **gap** is a maximal run of heights of `[lo, hi]` outside every chosen chapter's span `[beats[0], beats[last]]` (before the first chapter, between two, after the last). Heights inside a span that are not its beats are applied silently by the cut (§2.4) and belong to no gap.

No eligible moment → `UI_VIZ_REEL_EMPTY` ("Nothing to highlight between #{lo} and #{hi}. Pick a longer range, or try the demo."); nothing is recorded.

### 2.4 Steps and timing

| Step | Duration | Shows |
|---|---|---|
| `intro` (one per chapter, "1-beat lead-in") | 2,000 ms | the scene at the last position of `beats[0] − 1` (when that height is a segment's `hs`, the segment's start scene, i.e. `TimelinePage.scene`; before height 0, the empty scene), reached by the 150 ms crossfade when it is not the scene already shown, then held still; the **title card** state (§3.7): the chapter title and `k/N` (3 × 5 digit sprites) in the caption strip, and a spotlight ring on the focus actor — for a **conflict** chapter on the desk of its first `conflict` event instead, and no ring when that desk is null (§4 item 7) |
| `beat` | 800 ms (the 1× replay beat) | one board height of the chapter: every event of that height animates as in replay; between non-consecutive heights the scene **cuts** (150 ms crossfade inside the step's 800 ms, skipped events applied silently) |
| `fold` | 800 ms | a chapter of more than 6 beats shows its first 3, one fold step `UI_VIZ_REEL_FOLD` ("… {n} more steps": a cut to the scene after the folded beats), then its last 2 |
| `montage` | 1,200 ms | at most one per gap (§2.3) that contains ≥ 1 `publish`: the **montage** state (§3.7; the one state F04's Play montage beat also uses, when F04 is merged) with `UI_VIZ_REEL_MONTAGE` ("+{n} shares") |
| `end` | 1,500 ms | `UI_VIZ_REEL_END` ("cowork-sync · {n} highlights") over the final scene; only with the end-card option |

Longest chapter = 2,000 + 6 × 800 = 6,800 ms. Every crossfade lies inside its step, so `totalMs` is the plain sum of the step durations. "Steps" are beats (board heights), never minutes (INV-CLOCK); `{dur}` in the summary is the video's own length, not a time on the board.

### 2.5 Texts (all six catalogs; English and Korean shown)

| Code | en | ko |
|---|---|---|
| `UI_VIZ_REEL_CH_CONFLICT` | A clash, untangled in {n} steps | {n}단계 만에 풀린 충돌 |
| `UI_VIZ_REEL_CH_REQUEST` | Go-first, settled in {n} steps | {n}단계로 정리된 go-first |
| `UI_VIZ_REEL_CH_HANDOFF` | A handoff in {n} steps | {n}단계로 끝난 넘겨주기 |
| `UI_VIZ_REEL_CH_SAVE` | {name} saves the team's work | {name}, 팀 작업 저장 |
| `UI_VIZ_REEL_CH_FREEZE` | {name} pauses, then picks up again | {name} 잠시 멈춤, 다시 출발 |
| `UI_VIZ_REEL_CH_JOIN` / `_REJOIN` | {name} joins / {name} is back | {name} 합류 / {name} 다시 합류 |
| `UI_VIZ_REEL_MONTAGE`, `_FOLD`, `_END` | +{n} shares · … {n} more steps · cowork-sync · {n} highlights | 공유 +{n} · … {n}단계 더 · cowork-sync · 하이라이트 {n}개 |
| `UI_VIZ_CTRL_REEL`, `UI_VIZ_REEL_CHAPTERS`, `_END_TOGGLE`, `_SUMMARY`, `_LOADING`, `_EMPTY`, `_CLIPPED` | Make reel · Highlights: {n} · End card · (§2.1) · Gathering highlights… · (§2.3) · Reels cover at most 2,048 heights; starting at #{lo}. | 영상 만들기 · 하이라이트 {n}개 · 끝 카드 · #{lo}–#{hi} · 하이라이트 {n}개 · {dur} · 하이라이트 모으는 중… · #{lo}–#{hi} 사이에 보여 줄 장면이 없습니다. 범위를 넓히거나 데모로 해 보세요. · 영상은 최대 2,048 높이까지; #{lo}부터 시작합니다. |

Chapter-title templates (`UI_VIZ_REEL_CH_*`) take **only** `{name}`, `{target}` and `{n}`: `{name}`/`{target}` are resolved by the page from the character table exactly like card placeholders (§3.3.7), so anonymize maps them to hue names; `{n}` is a count. Never `{id}` (display ids are not anonymized), `{path}` or `{label}` (their anonymized indices follow the per-viewer layout order), free text, the room label, the branch, a height or a duration. Each title renders in one line, ≤ **60** rendered characters at worst-case parameters (names 20, `n` = 999,999, I18N-07). Every template whose `{n}` counts a noun (highlights, steps, shares) carries its CLDR plural forms (I18N-03; "1 highlight", "+1 share"). `{lo}` and `{hi}` are `n` params; `{dur}` (summary only) is a `dur` param, which `render` formats with `UI_DUR_S`/`UI_DUR_MIN` (10-product §3.2, I18N-03) — no template hard-codes a unit such as "s" or "초".

## 3. How it uses existing mechanisms

### 3.1 Reel moments (owned by F29)

```ts
// src/viz/model/reel.ts (with §3.2) — pure, compiled into the client (§3.13). Deliberately not named Moment/moments:
// F04 owns those names and src/viz/model/moments.ts for its you-relative lanes, which a reel must not read (§4 item 5).
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
// page layer (src/viz/ui/**, not pure), present only when F04 is merged: the selected room's catch-up anchor height (F04 §2.4), else null
export function catchUpAnchor(roomId: string): number | null;
```

**Grouping (closed; 12 §3.4 kinds and §3.3.7 fields only).** A moment is opened by an event of its first column at a position in `[lo, hi]`; events before `lo` open nothing and events after `hi` are never read, so `complete` depends on `[lo, hi]` alone. Each event belongs to at most one moment.

| `kind` (`sub`) | Opened by | Own events | `complete` when | `actors` (focus, target) |
|---|---|---|---|---|
| `conflict` (`conflict.conflict`) | `conflict` | it and, when `source = 'hold'`, every later `box` with the same `holdId`, up to the first with `terminal: true` | `source = 'event'`, or that terminal `box` is in the range | `on`; then `line.actor` when the line names an actor |
| `negotiation` (`requestKind`) | `request_open` | it and every later `request_status` and `answer` with the same `request`, up to the first `answer` whose `verb` is not `later` | that answer is in the range (a `returned` or `undeliverable` request never settles) | `from`, `holder` |
| `save` (`null`) | `save` | itself | always | `peer` |
| `freeze` (`null`) | `person_freeze` | it and the next `person_thaw` of the same `peer` | that thaw is in the range | `peer` |
| `arrival` (`join` / `rejoin`) | `person_enter` / `person_respawn` | itself | always | `peer` |

Every other kind (publishes, claims, notes, badges, ghosts, …) opens no moment; publishes feed only the montage counts. Before Plan 3 only `arrival` and `freeze` moments can occur on a real board (12 §3.4 "What each plan adds"); the unit tests use synthetic events of every kind, which the 8a model types already declare.

### 3.2 The reel plan (pure)

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
export function reelRange(ticks: readonly Tick[], h0: number, h1: number, anchor: number | null,      // anchor: catchUpAnchor(), §2.2 rule 1
                          eligibleAfter: (lo: number) => boolean): { lo: number; hi: number; clipped: boolean };   // eligibleAfter(x): [x, h1] holds an eligible moment
export function reelCamera(p: ReelPlan, layout: Layout, sceneAt: (pos: Position) => Scene): number[];   // camera top tile per step
export function serializeReelPlan(p: ReelPlan): string;   // canonicalJson, as §3.3.5 "Serialization"
```

`planReel` reads only scene-event kinds, positions, `publish` counts and the moments; it never reads a desk ordinal, a layout, an id's value (only equality, as `reduceScene`, §3.13), the language, the anonymize flag, the overlay, `self` or `seed`.

### 3.3 Data path, rendering, output

- **Events:** the page fetches the heights of `[lo, hi]` it does not hold through the existing `GET /api/v1/rooms/<room id>/timeline` route (≤ 256 heights per page, never across a segment start, so ≤ **9** requests for one range of ≤ 2,048 heights), reusing the seek cache of §3.9.1; a height the page already holds is never fetched again. Choosing the default range probes at most two stretches of ≤ 2,048 heights (the one ending at `h1`, and for the rule-2 fallback the one ending at `s1`), so ≤ **18** pages; the panel preview and the click then reuse those pages. Fetched pages are kept only until the reel is saved or the panel closes, outside the 2,000-card store of 12 §3.8. No new route, parameter, server code, stream event or log line; the server cannot tell a reel from a seek.
- **Scenes:** every step's scene comes from the page's `reduceScene` (§3.3.5) at the step's position; reel steps never enter the timeline. Board facts are shown exactly as in replay (VIZ-26); the title card (reel only) and the montage state (reel montage steps, and F04's Play montage beat when F04 is merged: one §3.7 row, one visual, F04's cap of ≤ 12 desks) are render states of §3.7, **not** scene-event kinds, so the closed set of §3.4, VIZ-10 and the goldens are unchanged.
- **Camera:** `reelCamera` computes the whole path before frame 0, as demo mode does (§3.9.4); at frame 0 the camera stands at the first step's target. Target of a step: the desk of its first event that has one (intro: of its chapter's first beat; montage: the gap's most-published desk, then lowest ordinal; end, or no event with a desk, e.g. an arrival: unchanged); vertical only, ≤ 1 tile per 100 ms; at the first frame of an `intro` step whose target is more than 20 tiles away (what 2,000 ms can pan) the camera **cuts** once, under the 150 ms crossfade.
- **Output:** the §3.9.4 pipeline unchanged — the 480 × 270 art viewport, the virtual clock, WebM (`MediaRecorder`, VP9/VP8, ≈ 2 Mbps) or the in-house GIF encoder (960 × 540, 10 fps, stop at 10 MB with `UI_VIZ_RECORD_CAP`), the caption strip (titles during `intro`, the latest card text during `beat`, montage/fold/end texts during theirs). Saved through the existing Blob download as `cowork-reel-<n>.gif|.webm` (`n` = a per-page counter from 1, at most 4 digits as in F34's name check; no date, no room name); this is the one change to the pipeline, written into 12 §3.9.4 "Saving" by §7 item 4.

### 3.4 Determinism scope

For the same range, every PC computes the byte-identical `ReelPlan` (chapters, order, titles' codes and counts, step timing), whatever the viewer's window, layout, language or anonymize setting. (The *default* range may differ between PCs, because rule 1 starts at this PC's F04 anchor; a typed range does not.) The **picture** is identical only when the layouts are (INV-VIZ-DET pins layout to the initial window and extension order; teammates who opened `/cowork view` at different times may have different desk positions). Rendered titles are identical for the same language and anonymize setting, because they carry only names and counts.

## 4. Privacy and safety

1. **Nothing leaves the PC** except the file the user saves. No request beyond timeline pages, no write by the viewer, no board op, no IPC, no log line, no `localStorage`/`sessionStorage` key, no telemetry; teammates are not notified that a reel was made.
2. **Only on a click.** A reel is never made automatically, on a timer, on a stream event or by the server; there is no reel without `UI_VIZ_CTRL_REEL`.
3. **Inherited from VIZ-29:** anonymize defaults **on** for real rooms; turning it off shows `UI_VIZ_RECORD_NOTICE` before frame 0; with it on, no served name, handle, path, label, branch, room label or teammate free-text string reaches the recording canvas (free text → "…"); `local_only` stub paths never, anonymized or not; the map, the log and the local overlay are never recorded.
4. **Reel-only text is closed:** title, fold, montage, end and summary texts are catalog templates with the §2.5 placeholders only. Teammate free text (notes, request and answer notes, demo caption `text`) never reaches a reel-only text, even with anonymize off; with anonymize off it appears only where replay already shows it (bubbles, the caption strip's card text).
5. **The recorder stays anonymous:** `reelMoments` and `planReel` take no overlay, `self` or "you" input (this is why F04's you-relative `moments()` is not used), and the "you" marker is overlay (never recorded), so a reel does not reveal whose PC made it. The default range may start at this PC's F04 anchor (§2.2 rule 1), but no height, range or anchor is drawn in the recording.
6. **Brand:** the end card says "cowork-sync" only; no Anthropic or Claude mark (VIZ-20).
7. **No blame framing.** Conflict and negotiation titles carry no `{name}`, and a conflict chapter's spotlight ring is on the conflict's desk, never on an actor. The record owner of a K4 is the side whose change was held, and no winner is on the board (12 §1.5 item 1); looks are stable per `peer_id` (VIZ-18), so teammates would recognise a ringed blob even in an anonymized reel posted to team chat, and conflicts are ranked first. Rings on an actor are kept only where the person is the point of the chapter (save, freeze, arrival) or neutral (a negotiation's requester), in the spirit of VIZ-17's `phrasing-blame` rule.

## 5. Requirements

- **FEAT-F29-01** The record panel MUST offer the highlight-reel source and `UI_VIZ_CTRL_REEL`; one click with default options MUST produce a saved file; a reel MUST start only from that click.
- **FEAT-F29-02** The default range MUST follow §2.2 (F04's catch-up anchor when F04 is merged and its range holds an eligible moment → since the newest save, or the session the newest save closed → the last 256 heights), MUST be frozen at the click, MUST satisfy `h0 ≤ lo ≤ hi ≤ h1`, and MUST be clipped to 2,048 heights with `UI_VIZ_REEL_CLIPPED`.
- **FEAT-F29-03** `reelMoments`, `planReel`, `reelRange` and `reelCamera` MUST be pure and total; `reelMoments` MUST group exactly by the §3.1 table and MUST NOT take a `you`, `self` or overlay input; `planReel` MUST depend only on the scene events of `[lo, hi]`, the `reelMoments` result and the options; a plan built from server ids and then projected (§3.10.6 rule: ids → handles) MUST serialize byte-equal to the plan built in the page from view-model events, and page-side plans MUST be byte-equal for any two windows covering the range.
- **FEAT-F29-04** Chapters MUST be chosen by §2.3 (eligible only, kind order, round-robin, beats then start, disjoint spans, 1–8 with default 5) and played in ascending start order.
- **FEAT-F29-05** Steps MUST use the §2.4 durations; `totalMs` MUST be ≤ the cap (20, 30, 40 or 60 s; default 40) by the §2.3 fit order.
- **FEAT-F29-06** The title-card state MUST be a render state of §3.7 entered only by a reel `intro` step on the recording canvas, and MUST NOT appear in live or replay. The montage state MUST be one render state of §3.7, entered only by a reel `montage` step or (when F04 is merged) F04's Play montage beat. Neither MAY be a scene-event kind.
- **FEAT-F29-07** The camera path MUST be computed before frame 0 and start at the first step's target; it MUST move vertically, ≤ 1 tile per 100 ms, except one cut at the first frame of an `intro` step whose target is more than 20 tiles away.
- **FEAT-F29-08** Output MUST use the §3.9.4 pipeline (virtual clock, encoders, caps, download), changed only in the file name `cowork-reel-<n>.gif|.webm` that §7 item 4 adds to §3.9.4 "Saving".
- **FEAT-F29-09** Reels MUST inherit VIZ-29 in full; reel-only texts MUST use only their §2.5 placeholders, chapter titles only `{name}`, `{target}`, `{n}`; a conflict chapter's spotlight ring MUST be on its desk, never on an actor (§4 item 7).
- **FEAT-F29-10** Making a reel MUST send no request other than `GET …/timeline` pages — at most 9 for the frozen range and at most 18 to choose the default range, never one for heights the page already holds — and MUST write nothing but the user's download.
- **FEAT-F29-11** With no eligible moment the page MUST show `UI_VIZ_REEL_EMPTY` and start no encoder.
- **FEAT-F29-12** Every §2.5 code MUST exist in the six catalogs, with CLDR plural forms wherever `{n}` counts a noun; each chapter title MUST fit 60 rendered characters in one line at worst-case parameters; the summary's length MUST be a `dur` param rendered through `UI_DUR_*` (I18N-03), and no chapter title MAY carry a duration.
- **FEAT-F29-13** The end card SHOULD be on by default and switchable; the panel SHOULD show the summary and rendered titles before the click.

## 6. Tests

| Test | Kind | Proves |
|---|---|---|
| T-VIZ-reel-moments: a `conflict{k4, source: hold}` at 40 with `box` events of its `holdId` at 41 and 55 (terminal at 55) → one conflict moment, beats [40, 41, 55], complete; the same with the terminal `box` at 310 and range [1, 300] → incomplete; a `conflict{breach, source: event}` → complete, 1 beat; `request_open` at 60, `request_status{asked}` at 61, `answer{later}` at 62, `answer{grant}` at 63 → negotiation `go_first`, beats [60–63], complete, actors (from, holder); only `answer{later}` → incomplete; `request_status{returned}` → incomplete; a request opened at 0 with range [1, 300] → no moment, and its answer at 5 opens none; `person_freeze` with no thaw in range → incomplete; `person_enter`/`person_respawn` → `join`/`rejoin`; a `publish`, `note` or `claim_take` → no moment; the result is identical with `self`, overlay and every id replaced by its handle (projection) | unit | FEAT-F29-03 |
| T-VIZ-reel-plan: moments A conflict k4 beats [40, 41, 55], B go_first [60–63], C go_first [100, 101], D join [5], E freeze [120, 180], F handoff [200] incomplete, G save [290]; publishes at 10, 20, 30, 70, 80, 150, 210, 250; range [1, 300], N 5, cap 40 s, end card on → chapters D, A, B, E, G; steps: D intro + beat, montage n=3, A intro + 3 beats, B intro + 4 beats, montage n=2, E intro + 2 beats, montage n=2, G intro + beat, end n=5; `totalMs` = 23,900; titles `CH_JOIN`, `CH_CONFLICT{n:3}`, `CH_REQUEST{n:4}`, `CH_FREEZE`, `CH_SAVE`; golden JSON | unit | FEAT-F29-04, -05 |
| T-VIZ-reel-fit: the same input with cap 20 s → D dropped, then E (its gap merges: one montage n=5) → chapters A, B, G, steps montage n=3, A, B, montage n=5, G, end n=3, `totalMs` = 16,300; a 9-beat negotiation → intro, beats 1–3, fold n=4, beats 8–9 (6 body steps); a 6-beat one → 6 beats, no fold; 8 eligible 9-beat chapters with publishes in every gap at cap 20 s → 2 chapters, `totalMs` ≤ 20,000 | unit | FEAT-F29-05 |
| T-VIZ-reel-det: 500 generated timelines (fast-check, every kind the build folds), random ranges and options: `serializeReelPlan` of the server-side plan after projection equals that of the page-side plan; page-side plans equal for two windows with different `h0` and desk ordinals, and with language, anonymize, overlay, `self`, `Date.now` and `Math.random` varied; always `totalMs ≤ capMs`, ≤ N chapters, disjoint ascending spans, each intro followed by ≥ 1 beat | property | FEAT-F29-03, -04 |
| T-VIZ-reel-range: F04 anchor 699, `h1` 900, an eligible moment in [700, 900] → [700, 900]; the same anchor with none there → rule 2; no anchor (F04 absent) → rule 2; saves at 400 and 820, `h1` 900, eligible moment at 850 → [821, 900]; none after 820 → [401, 820]; no save, `h0` 768 → [768, 900], `h0` 0 → [645, 900]; window [0, 3,000], input [0, 3,000] → [953, 3,000] with `UI_VIZ_REEL_CLIPPED`; `hi > h1`, `lo < h0`, `lo > hi` or a non-matching input → `UI_VIZ_CTRL_REEL` disabled, no request | unit | FEAT-F29-02 |
| T-VIZ-reel-empty: a range with 40 publishes and one incomplete request → `UI_VIZ_REEL_EMPTY`; no `MediaRecorder` or GIF encoder constructed; no download | unit | FEAT-F29-11 |
| T-VIZ-reel-states: title card and montage map to their §3.7 rows and reduced forms; a replay and a live scene of the same range never enter the title card; the montage state is entered only by a reel `montage` step (and, with F04 merged, a Play montage beat), never by a scene event; with F29 merged, `SCENE_EVENT_KINDS` and every T-VIZ-golden-sim timeline are byte-unchanged | unit | FEAT-F29-06 |
| T-VIZ-reel-camera: a 60-cell office with chapters at its top and bottom desks → the path exists before frame 0 (encoder spy), vertical only, ≤ 1 tile per 100 ms between frames except exactly one cut per `intro` whose target is > 20 tiles away, at its first frame | unit | FEAT-F29-07 |
| T-VIZ-reel-requests: a reel over 2,048 heights issues only `GET …/timeline` (≤ 9 for the frozen range) and no other route; a default range chosen by the rule-2 fallback issues ≤ 18 pages in all, preview and click included; a second reel of the same range issues none; no request names a height below `h0`; the T-VIZ-readonly listings, the viewer log and the data directory are unchanged; no storage key is added | integration | FEAT-F29-10 |
| T-VIZ-reel-privacy: the T-VIZ-anonymize canary fixtures as a reel at defaults → the `fillText` spy sees no canary; titles render hue names; anonymize off → `UI_VIZ_RECORD_NOTICE` before frame 0 and no note canary in any title, fold, montage, end or summary text; no "you" marker, map, log or overlay pixel; no `local_only` path either way; a K4 conflict chapter's intro draws its ring pixels only around the conflict's desk, none around any actor; saved name matches `^cowork-reel-[1-9][0-9]{0,3}\.(gif|webm)$` | CI browser | FEAT-F29-08, -09 |
| T-VIZ-reel-i18n: the 17 codes in six catalogs, with plural forms on the noun-counting `{n}` of `_CH_CONFLICT`, `_CH_REQUEST`, `_CH_HANDOFF`, `_MONTAGE`, `_FOLD`, `_END` and `_SUMMARY`; `UI_VIZ_REEL_CH_*` use only `{name}`, `{target}`, `{n}` (a planted `{path}` or `{dur}` fails); worst-case titles ≤ 60 rendered characters; `UI_VIZ_REEL_SUMMARY` declares `{dur}` as type `dur` and renders 40,000 ms through `UI_DUR_S` in every language; no reel template contains a literal unit ("s", "초", …) | CI lint | FEAT-F29-12 |
| T-VIZ-reel-size: Make reel on the bundled demo at defaults → `GIF89a`, ≤ 5 MB, sum of frame delays = `totalMs` ± 100 ms ≤ 40 s; WebM ≤ 10 MB where VP9 or VP8 exists | CI browser | FEAT-F29-05, -08 |

## 7. Spec edits (exact)

1. **12 §1.1**, after the export bullet: "- The highlight reel: a one-click, chaptered, anonymized recording of a height range, planned by a pure function of its scene events (§3.9.5, FEAT-F29)." **§1.3**, append: "- **Reel extras:** sound or music, user-written titles (free text in a recording), MP4, sharing a reel range through the URL."
2. **12 §2**, new rows: "**reel** | a recording made by `UI_VIZ_CTRL_REEL` from a `ReelPlan` (§3.9.5) | local"; "**chapter** | one selected reel moment (`reelMoments`, §3.9.5), played as an intro step and its beats | local"; "**montage step** | one reel step that stands for the routine publishes of a gap between chapters | local".
3. **12 §3.7**, "States" sentence becomes: "Every state is entered only through a scene event (§3.4); no timer guesses activity (VIZ-22). Two render states are not entered by a scene event, and each is built only from scene events: the title card, which exists only on the recording canvas and is entered only by a reel `intro` step (§3.9.5), and the montage, entered only by a reel `montage` step or (F04) a catch-up Play montage beat." New rows: "| title card | scene held still; a 1-art-pixel `#D97757` ring on the focus actor (a conflict chapter: on the conflict's desk; none when it has no desk); title and `k/N` (3 × 5 digits) in the caption strip; 2,000 ms | a reel `intro` step | same |" and "| montage | 150 ms crossfade to the end scene of the run it stands for, then a small sparkle on each desk that run's publishes touched (≤ 12 by count, then ordinal; `UI_VIZ_MORE` beyond), 100 ms apart; an 8 × 8 fast-forward sprite and the caller's caption (`UI_VIZ_REEL_MONTAGE` for a reel) in the caption strip; 1,200 ms in a reel, ≤ 1.5 s in Play | a reel `montage` step; F04's Play montage beat | static dots on those desks |". If F04 merged first with its own montage wording, this row replaces it (one row, one visual).
4. **12 §3.9.4**, Panel: "source (the selected room live, a replay range, the demo, or a highlight reel of a range, §3.9.5)"; Recording canvas: "in demo mode **and for a reel (§3.9.5)** the camera path is computed … before recording starts"; Saving: "… with the fixed name `cowork-view-<n>.webm` or `.gif`, **or `cowork-reel-<n>.webm` or `.gif` for a highlight reel (§3.9.5)** (no date, no room name) …". If F34 merged first, its `saveBlob` name check gains the alternative `reel-[1-9][0-9]{0,3}\.(webm|gif)`.
5. **12, new §3.9.5 "Highlight reel"** (or the next free §3.9 number: F34 also proposes a §3.9.5): §2 and §3 of this proposal verbatim (headings demoted one level).
6. **12 §3.11** codes: Controls group + `UI_VIZ_CTRL_REEL`; Recording group + `UI_VIZ_REEL_CH_CONFLICT`, `_CH_REQUEST`, `_CH_HANDOFF`, `_CH_SAVE`, `_CH_FREEZE`, `_CH_JOIN`, `_CH_REJOIN`, `_MONTAGE`, `_FOLD`, `_END`, `_CHAPTERS`, `_END_TOGGLE`, `_SUMMARY`, `_LOADING`, `_EMPTY`, `_CLIPPED` (prefixed `UI_VIZ_REEL`). Channel `viz` caps: + "reel title 60 (one line)". No new placeholder name or type: `{lo}`/`{hi}` are `n` params and the summary's `{dur}` is a `dur` param (10-product §3.2; Plan 8a's `render` already formats both).
7. **12 §3.13**: `model/reel.ts` (`reelMoments`, `planReel`, `reelRange`, `reelCamera`, `serializeReelPlan`) joins the "compiled into the client too" list; the client row gains the reel in `record.ts`; `src/viz/ui/**` gains `catchUpAnchor` when F04 is merged.
8. **12 §4**: **VIZ-22** "…MUST be entered only through scene events (§3.7 table), except the title-card state, entered only by a reel `intro` step on the recording canvas, and the montage state, entered only by a reel `montage` step or F04's Play montage beat (FEAT-F29-06); …". **VIZ-28** "…MUST pan the camera only by the §3.9.4 rule (for a reel, the precomputed path of §3.9.5 with its one cut per intro step); …". Append under "Replay, demo and export": FEAT-F29-01…13 as in §5.
9. **12 §5**, chapter-local: "| **INV-VIZ-REEL** | A reel plan is a pure function of the scene events of its range (grouped by `reelMoments`) and its options; it reads no layout ordinal, id value, language, anonymize flag, overlay, `self`, "you", clock or randomness. Making a reel sends only timeline-page requests, writes only the user's download and puts nothing on the board. |".
10. **12 §7**: the twelve T-VIZ-reel-* rows of §6.
11. **12 §9.1 roadmap row 8**: 8b Builds + "; the highlight reel (12 §3.9.5, F29)"; Depends unchanged ("8b: 5, 7, 8a"; F04 is optional); 8b exit + "T-VIZ-reel-moments, -plan, -fit, -det, -range, -empty, -states, -camera, -requests and -i18n green on the three CI OS legs; T-VIZ-reel-privacy and -size green on the browser leg; the README GIF made with Make reel from the bundled demo".
12. **12 §9.2** (pending glossary §28): §19 viewer row + "reel title 60"; §20 viewer row + "reel: range ≤ 2,048 heights, ≤ 9 timeline pages per range, ≤ 18 to choose the default range; 1–8 chapters (default 5); cap 20/30/40/60 s (default 40); intro 2,000 ms, beat and fold 800 ms, ≤ 6 steps per chapter body, montage 1,200 ms, end card 1,500 ms".
13. **10-product §3.18** README `privacy`: append "Highlight reels are made only when you click Make reel, only from what the viewer already shows, and are anonymized unless you turn that off."

## 8. Placement

**Plan 8b**, a new task "Highlight reel (F29)" immediately after the 8b export task (record panel, `record.ts`, `gif.ts`, anonymize, VIZ-28/29). Files: `src/viz/model/reel.ts` (new), `src/viz/client/record.ts` (reel source, title-card and montage drawing), the six catalogs, `test/unit/viz/reel.*.test.ts`, the browser smoke. If F34 (postcard) is in the same plan, the reel task comes after both the export task and the F34 task, so `saveBlob` and the viewport composer exist once (F34 §8). If F04 is merged, its catch-up panel and Play (F04 task F04-b, in Plan 8a) already exist when the reel task runs, so `catchUpAnchor` reads that panel's anchor and the montage row of §7 item 3 is reconciled with F04's montage beat in that task; without F04, rule 1 is simply absent. **Not implementable now:** recording itself is 8b (after Plans 5 and 7; Plan 8a ruling R-V32 keeps the recording canvas out of 8a), and 8a's reducer, timeline and page logic (Plan 8a Tasks 5–6 and 13–14, groups G2–G4) start only after Plan 2's exit gate (gate P), which has not passed. The pure core (`reelMoments`, `planReel`, `reelRange`, `reelCamera` with T-VIZ-reel-moments/-plan/-fit/-det/-range/-camera) depends on nothing outside 12 and MAY be pulled forward as an 8a follow-up task once Plan 8a Task 6 has merged; it needs nothing from Plans 3–7, which only put real data behind kinds the §3.1 table already groups (conflicts 3–4, requests 6, saves 7).

## 9. Open questions (with defaults)

1. **Recency vs richness** in ranking. *Default:* more beats first, then earlier; revisit after field use.
2. **Sharing a range** (`#reel=lo-hi` in the fragment) so teammates get the same plan in one click. *Default: no in v1;* the summary shows `#lo–#hi` to type.
3. **Clips longer than 60 s.** *Default: no;* WebM's 120 s limit stays for plain recordings only.
4. **Settled vs declined negotiations.** `CH_REQUEST` reads "settled" for an accept, grant, decline or release alike. *Default: one title;* a decline is a legitimate outcome, and naming it would single out the holder.
5. **Default format and size.** A 40 s GIF with many cuts (each crossfade frame is a full-frame change) may reach the 10 MB GIF cap and lose its end card. *Default:* keep GIF and 40 s; T-VIZ-reel-size measures the bundled demo, and the cap drops to 30 s for GIF if a field reel hits `UI_VIZ_RECORD_CAP`.

## Review notes

Adversarial review, 2026-10-08, against glossary rev 2.4, 12-visualizer (incl. §3.7, §3.9, §3.10.5–§3.10.6, §3.11, §4, §7, §9), 10-product §3.2 / I18N-03 / I18N-07, the Plan 8a plan (`.worktrees/p8a-viz`, Tasks 5–6, 13–14, ruling R-V32, gate P) and the parallel proposals F04 and F34 in this directory.

**Not a duplicate.** Nothing in `docs/spec` is a reel (the only "highlight" hits are sprite palette keys). The base spec has plain recording (12 §3.9.4) and a hand-written README storyboard (§3.9.3); the closest neighbour is F04's catch-up Play (moments plus a montage beat in the live page), a different product that shares a mechanism. They are reconciled below, not merged.

**Invariants checked, no defect:** git-remote-only and no telemetry (page-only, loopback `GET …/timeline` only, no write but the user's download); collaborators only and privacy (VIZ-29 inherited, anonymize default on, free text never in reel-only text, `local_only` paths never); hold/MASK rules (untouched: the viewer never reads hold bytes); Claude Code hook limits (no hook, no Claude surface); INV-CLOCK (steps are beats, no clock in titles); VIZ-10 closed kind set (unchanged). The timing arithmetic was re-derived and is correct: longest chapter 6,800 ms, one-chapter bound 10,700 ms, T-VIZ-reel-plan 23,900 ms, T-VIZ-reel-fit 16,300 ms and the 2-chapter 18,700 ms case, and every T-VIZ-reel-range value.

**Changed:**

1. **Broken F04 dependency (blocking).** F04 now exists (`F04-since-catchup.md`) and its `moments(t, from, to, you): { mine, team, routine }` is a different contract: single events in lanes relative to `you`, with no `kind`, `beats` or `complete`. F29 could neither be "re-pointed" at it (the shape lacks what §2.3 needs) nor use it (a `you` input would make the plan depend on whose PC records it, breaking FEAT-F29-03, §3.4 and §4 item 5), and both proposals claimed `src/viz/model/moments.ts` and the names `Moment`/`moments`. F29 now owns `reelMoments`/`ReelMoment` in `model/reel.ts` with a closed grouping table (§3.1). F04 is optional. The roadmap "Depends" no longer names F04. §8's "no F04 text was found" is removed. A new test, T-VIZ-reel-moments, pins the grouping (twelve reel tests now).
2. **Catch-up range.** F04 has no `catchUpRange(roomId)`, only panel anchors (F04 §2.4). Rule 1 now reads F04's anchor through `catchUpAnchor` and gets the same eligibility probe as rule 2, because a short absence would otherwise make the one-click default produce `UI_VIZ_REEL_EMPTY`. `reelRange` and T-VIZ-reel-range were updated to match.
3. **Montage collision.** F04's Play already draws a montage beat (≤ 1.5 s, ≤ 12 desks), and the old FEAT-F29-06 ("MUST NOT appear in live or replay") would have forbidden it. Now there is one shared §3.7 montage row with F04's 12-desk cap, plus a reel-only title card. FEAT-F29-06, the VIZ-22 amendment, the §3.7 sentence and T-VIZ-reel-states were rewritten to match. The two captions stay separate codes (`UI_VIZ_MONTAGE` from F04, `UI_VIZ_REEL_MONTAGE` here).
4. **Section number and file name.** F34 also proposes a new 12 §3.9.5, so the section now takes the next free number at merge. FEAT-F29-08 said "pipeline unchanged" but changed the name, and §7 never amended 12 §3.9.4 "Saving". §7 item 4 now amends it. F34's `saveBlob` name check must gain `reel-[1-9][0-9]{0,3}`, so the counter is capped at 4 digits to match it.
5. **I18N-03.** The summary had a hard-coded `{seconds} s` / `{seconds}초`, and the i18n test banned `UI_DUR_*`, the opposite of the rule. `{dur}` is now a `dur` param rendered through `UI_DUR_*`. The templates with `{n}` carry plural forms. No placeholder is new: the `{seconds}` addition was dropped from §7 item 6.
6. **Request bound.** "≤ 9 requests" ignored the default-range probe and the fallback range. It is now ≤ 9 pages per range and ≤ 18 to choose the default, with nothing refetched (FEAT-F29-10, §3.3, T-VIZ-reel-requests, glossary §20 row). Fetched pages live outside the 2,000-card store.
7. **Blame framing (the "creepy" check).** The spotlight ring sat on a conflict's focus actor, which is the K4 record owner: the side whose change was held, with no winner on the board. Looks are stable per `peer_id`, so an anonymized reel in team chat would still single that person out, and conflicts are ranked first. The ring for conflict chapters is now on the desk (§2.4, §4 item 7, FEAT-F29-09, T-VIZ-reel-privacy).
8. **Small precision fixes.** Definition of a gap. Intro scene at a segment start and before height 0. Crossfades sit inside their steps, so `totalMs` is the plain sum. Camera target for intro steps and desk-less chapters. The window is now stated in the clipped-range test, and a test case was added for `lo < h0`. An invalid typed range now disables the button instead of an uncoded "refusal" (VIZ-39). Plural forms are required only where `{n}` counts a noun.
9. **Placement.** The gates were made concrete. Recording is 8b (R-V32). The pure core may move into 8a once Plan 8a Task 6 has merged, after gate P. Task order relative to F34 and F04 is now stated. **implementableNow stays false.**

**Left open:**

- Merge order with F34. Which 8b task extracts `saveBlob` and the shared viewport composer, and which proposal gets §3.9.5, is decided at merge (both texts now handle either order).
- If F04 merges, its montage wording and F29's §3.7 row must be folded into one row in F04's 8a task. Whether the reel should reuse F04's `UI_VIZ_MONTAGE` caption instead of `UI_VIZ_REEL_MONTAGE` is left to that merge (default: keep both codes).
- GIF size at the 40 s default with many cuts (open question 5) is only measured on the bundled demo.
- `CH_REQUEST` does not tell accept from decline (open question 4, default kept).
- Freeze chapters name a teammate ("{name} pauses…") for what 12 treats as a system card. This was kept because the wording is neutral and freeze ranks below conflict, negotiation and save; revisit if users find it noisy.
