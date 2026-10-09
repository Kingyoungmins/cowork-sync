# F32 — Follow a teammate (`/cowork view`)

**Status:** proposal (spec delta), 2026-10-08; adversarially reviewed and corrected 2026-10-08 (see "Review notes" at the end). · **Targets:** 12-visualizer (rev of 2026-10-06, as amended by the Plan 8a rulings R-V22, R-V25, R-V56); 10-product §3.18; the roadmap row 8. · **Depends on:** 12 §3.3.5 (`reduceScene`), §3.3.7 (`Scene`, `ActorState`), §3.5 (layout, scrolling), §3.8 (log, filters), §3.11 (codes, keyboard). No glossary term changes; glossary §2 ("display name … never an input to a decision") is binding here. · **Ids:** requirements keep their `FEAT-F32-NN` ids when merged (no renumbering into `VIZ-`), as F29 and F34 do, so no two proposals claim the same `VIZ-` numbers. · **Placement:** Plan 8a, a new Task 19 after Task 18; six languages and the recording check in Plan 8b (§8).

---

## 1. Purpose

A person who keeps `/cowork view` open on a second monitor wants to keep one teammate in view: today the office panel jumps to whoever moved last (12 §3.5.3, after 30 s without a user scroll). F32 adds **follow**: a per-room, page-only choice of one peer. While it is on, the office scroll follows only that peer's character and pets, the log's person filter is pinned to that peer, and a **now card** pinned above the log shows what the scene says about them: the claims their sessions hold, their open requests in and out, and the last path they shared. Live and replay behave the same.

Follow is a lens over the scene every viewer already computes. It adds no read, no route, no request, no stream payload, no view-model field, no scene-event kind and no `Timeline` or `Scene` field. VIZ-10 and INV-VIZ-DET are untouched because nothing in `src/viz/model/**` changes.

## 2. User-visible behaviour

### 2.1 Turning it on and off

| Action | Effect |
|---|---|
| The follow toggle `UI_VIZ_CTRL_FOLLOW` ("Follow", `aria-pressed`) on the person-filter chip of the log (the visible control, shown when a person filter is set, e.g. after clicking a character; it sits there, not on the canvas, because the office canvas is `role="img"` and carries no controls) and, for screen-reader users, as a second button on each row of the visually hidden people list (12 §3.11) | follow that peer in the selected room; the person filter becomes that peer; the now card appears |
| `F` (focus not in a form control) | toggles follow for the peer of the current person filter; does nothing when no person filter is set |
| The toggle again, `Esc` (clears filters, as today), clearing the person filter, or choosing another person filter (clicking another character or chip) | follow ends in the selected room; the §3.5.3 30-second rule applies again |
| Selecting another room | not a person-filter change and no end of a follow: that room's own follow (or none) applies, and with one it pins the person filter to its peer; the first room's follow is kept in page memory, and when that room is selected again its follow is back and pins the person filter to the followed peer again |
| A world reload (`reset`, 12 §3.10.5) after which the followed handle is no longer a character of the room (a handle extended after a prefix collision, R-V22) | follow ends in that room |
| A page reload | every follow ends (page memory only; a person filter the page mirrored into the fragment, 12 §3.8, survives and `F` restores the follow) |
| A click on the `UI_VIZ_FOLLOWING` chip of the now card | re-centres the camera at once: §2.2 steps 2–3 apply even when the frame is already visible |

One follow per room, at most 32 (one per room, 12 §3.3.1). Follow is keyed by the peer's handle inside one room (6–32 hex, R-V22; a character is one peer of one clone, 12 §2 "character"); it never carries to another room, even to a character there with the same display name (glossary §2; 12 §8 Q4). No scene event starts or ends a follow: a followed character that becomes a ghost, absent or frozen stays followed and keeps its look; one with no `Scene.characters` entry at the drawn position (before its `person_enter` in replay, after `person_exit`) stays followed and the now card shows `UI_VIZ_NOW_NOT_HERE`. "Not a character of the room" (the reload row above) means absent from the room's `CharacterVM` list, which holds every peer of the window, not absent from the scene at one position.

### 2.2 The follow camera

The **followed actors** are the peer's character (when in `Scene.characters`) and every pet in `Scene.pets` whose `owner` is that peer and whose `live` is true. The **focus actor** of a beat is the followed actor whose `place` differs from the previous beat's scene: the character first, then pets in the order the page holds them (ascending seat handle, the view model's array order); when none moved, the character, else the first pet. Tiles come from the page's existing `placeTile` (Plan 8a `render/raster.ts`), or the zone table in the coarse view.

The camera is evaluated on follow start, on every beat (with the scene at the beat's last position: the destination of its walks), after a seek, a `room_snapshot` or "load earlier", on room selection and on a click on the chip. On each axis the panel can scroll (vertical always; horizontal only when the office is wider than the panel, after a user zoom or in a panel narrower than the office at the minimum `Z`):

1. Let the frame be the bounding box of the followed actors' tiles plus a 1-tile margin. When the frame is inside the visible area, nothing scrolls.
2. Else, when the frame fits the visible area, scroll so that it is centred, clamped to the office.
3. Else centre the focus actor's tile, clamped to the office.

| Rule | Value |
|---|---|
| Other actors' events in the followed room | never scroll the panel (in live mode the follow camera replaces the §3.5.3 30 s rule in that room; in replay, where no automatic scroll exists, it is the only one) |
| Pan | smooth scroll over 300 ms (one live beat; REASONED) |
| Jump instead of pan | effective reduced motion (OS `prefers-reduced-motion` or the in-page toggle), replay speed ≥ 4× (the speed threshold of `shouldPoof`), a seek, a `room_snapshot`, "load earlier", a room switch |
| A user scroll (wheel, touch, scrollbar, keys) while following | honoured: the camera does not move until the next beat in which a followed actor's `place` changes, or a chip click; scrolls the camera itself makes never count as user scrolls |
| Pause control (WCAG 2.2.2) | no beats, so no pan |
| Zoom `Z`, coarse view | never changed by follow (VIZ-16) |
| Recording camera (12 §3.9.4) | never steered by follow; the now card is never recorded (the log is not, VIZ-29) |

### 2.3 The now card

Pinned at the top of the log panel (also in the drawer below 1,100 px), a labelled region, **not** a card of the §3.8 list: never in `Timeline.cards`, never served, merged, filtered or counted. When another pinned page panel is shown at the top of the log (F04's catch-up panel, if adopted), the now card sits directly below it. It is recomputed from the scene the office draws (live: after each beat; replay: at the rewind position), the layout and the character table, and from nothing else.

| Row | Source (scene `s`, followed peer `p`) | Text | Limit |
|---|---|---|---|
| Header | `c = s.characters.get(p)`, its look swatch and accessory glyph, its name tag (12 §3.6), and `phOf(c, c.absent ? 'absent' : 'active', s.at)` (R-V56), which needs only the scene, so live and replay agree (not `CharacterVM.ph`, which is computed at the tip) | `UI_VIZ_FOLLOWING` "Following {name}" + the `PH_*` label (none for a ghost); the toggle `UI_VIZ_CTRL_FOLLOW` (pressed) | 1 |
| Holding | `s.claims` entries with `stale = false` whose `seat` is a pet of `p` (`s.pets.get(seat).owner = p`), ordered by desk ordinal, then `order` | `UI_VIZ_HOLDING` "holding {label}" (existing code; the chair-tag label rules of §3.5.4: `validLabel` else `?`, unverified mark) + the desk's file chip | ≤ 3, then `UI_VIZ_MORE` |
| Asks | `s.requests` entries whose `from` is `p`'s character or a pet of `p`, ascending display id | `UI_VIZ_NOW_ASKS` "asks {target} ({id})" + the status icon of `status` (`UI_VIZ_ICON_*`; no icon while `status` is null) | ≤ 3, then `UI_VIZ_MORE` |
| Asked by | `s.requests` entries whose `holder` is `p`'s character or a pet of `p`, ascending display id | `UI_VIZ_NOW_ASKED_BY` "asked by {target} ({id})" + status icon (as above) | ≤ 3, then `UI_VIZ_MORE` |
| Last shared | among `p`'s character and **every** pet of `p` in `s.pets` (live or ended: a pet whose session ended still made `p`'s newest share), the `ActorState` with the greatest `lastPublish` (`comparePos`, R-V25); its `lastDesk` and `lastPublish.height` | `UI_VIZ_NOW_LAST_SHARED` "last shared: {path} (#{height})", where `{path}` is, by the desk's served kind (`LayoutVM.desks`, which carries no desk key): a file desk's `path` (≤ 80, middle ellipsis); a folder desk's `plaque` (its folder); a shelf desk's zone `sign` followed by `/…`; at the big table `UI_VIZ_NOW_LAST_SHARED_TABLE` "last shared: a change too large to list (#{height})" | 1 |
| Empty | no row above | `UI_VIZ_NOW_NOTHING` "Nothing held, asked or shared yet in this view." | — |
| Not here | no `s.characters` entry for `p` | `UI_VIZ_NOW_NOT_HERE` "{name} is not in this room at this point." | — |

`{target}` is the name tag of the other side's character (a pet's owner). A file chip sets the file filter and a display id scrolls the log to its card (existing §3.8 behaviour). The card never says "working on" (VIZ-17), never shows a time, age, "last seen" or "offline" (VIZ-11, UX-22), never a count over time or a history (the only number besides `#height` and display ids is the `UI_VIZ_MORE` "+n" of rows held now), never a note's text (notes stay in the log's quoted frame), and never an overlay value (VIZ-13), also when following the "you" character. A segment's start scene carries no publish history (12 §3.3.5), so the last-shared row shows only publishes inside the segment of the drawn position (the initial window's own segment starts at `h0`; after "load earlier" each earlier segment starts empty too); before the first one it is the empty row, which is why that row says "in this view".

**What shows when.** Plan 2 boards fold no claims or requests and have no pets (12 §1.5 item 2; §3.4 "What each plan adds"), so only the header, last-shared, empty and not-here rows appear. The holding row fills in with Plan 4's claims (held by seats, so it shows once the seat's pet exists: its first footprint, or `seat_start` from Plan 5); the asks and asked-by rows fill in with Plan 6's requests. None of this changes F32 code.

### 2.4 Message codes (new; 12 §3.11 table)

| Code | en template | Params | Group |
|---|---|---|---|
| `UI_VIZ_CTRL_FOLLOW` | Follow | — | Controls and filters |
| `UI_VIZ_FOLLOWING` | Following {name} | `name: name` | Scene labels |
| `UI_VIZ_NOW_ASKS` | asks {target} ({id}) | `target: name`, `id: id` | Scene labels |
| `UI_VIZ_NOW_ASKED_BY` | asked by {target} ({id}) | `target: name`, `id: id` | Scene labels |
| `UI_VIZ_NOW_LAST_SHARED` | last shared: {path} (#{height}) | `path: path`, `height: n` | Scene labels |
| `UI_VIZ_NOW_LAST_SHARED_TABLE` | last shared: a change too large to list (#{height}) | `height: n` | Scene labels |
| `UI_VIZ_NOW_NOTHING` | Nothing held, asked or shared yet in this view. | — | Scene labels |
| `UI_VIZ_NOW_NOT_HERE` | {name} is not in this room at this point. | `name: name` | Scene labels |

Reused: `UI_VIZ_HOLDING`, `UI_VIZ_MORE`, `UI_VIZ_ICON_*`, `PH_*`. Every template stays within the channel `viz` caps (12 §3.11). **Wording rule:** the templates of these codes in every catalog use the "follow along" sense (ko "따라가기", ja "フォロー", zh-CN "跟随", fr "suivre", es "seguir") and never a word of surveillance (the denylist of §6 T-VIZ-follow-i18n).

## 3. How it uses existing mechanisms

- **Scene model only.** Every value is read from `reduceScene` output (12 §3.3.5), the layout (§3.5) and `CharacterVM`/looks (§3.10.6) that the page already holds; the page runs the same reducer in live and replay (VIZ-26), so the now card and the camera target at a position are the same in both.
- **No server change.** The viewer process, its routes (§3.10.5), stream payloads, view model (§3.10.6), logs (§3.10.10) and budgets (§3.12) are unchanged; the strings arrive with the existing `/api/v1/strings` viewer subset (`UI_VIZ_*`).
- **No board, IPC, daemon or network.** No board op, fold, hold, seat, `status.json` field or IPC frame is read or written beyond what 12 already reads; there is no server, relay, telemetry or new transport.
- **Page state.** One `Map<roomId, Handle>` in page memory and nowhere else. It is **not** mirrored into the filter fragment (12 §3.8): browsers keep fragment URLs in their history files, so a fragment key would store whom a page followed on disk. `ui/fragment.ts` is unchanged.
- **New pure module** `src/viz/ui/follow.ts` (DOM-free, imports `model/**` only, L-VIZ-IMPORT): `FOLLOW_PAN_MS = 300`, `NOW_ROWS_MAX = 3`, `followedActors(s, peer)`, `focusActor(prev, s, peer)` (pets in ascending seat handle), `cameraTarget(tiles, focus, view, office, force)` (tiles passed in by the client, since `ui/**` imports nothing from `render/**`; `force` skips step 1 for a chip click), `class FollowCamera { userScrolled(): void; due(prev, s, peer): boolean }`, `nowCard(s, layout, peer): NowCard`. In a room with a follow the client consults `FollowCamera` instead of `ui/zoom.ts`'s `FollowRule` (Plan 8a's 30 s auto-scroll rule, whose name says "follow" but is unrelated to following a person). The client (`office.ts`, `log.ts`, `a11y.ts`) wires them; `ui/a11y.ts` gains the `KeyAction` member `'follow'` and `KEYS` the entry `F → 'follow'`.

## 4. Privacy and safety

1. **Nothing leaves the page.** Whom a tab follows is never sent in a request, never stored in `localStorage`, `sessionStorage`, a cookie, the URL fragment (and so never in the browser's history) or a file, never logged, never put on the board. The followed person is not notified because nothing is sent anywhere; their own viewer, and every teammate's, can show the same board facts.
2. **No new data, no new inference.** The now card shows only scene facts the office already draws; it adds no timer-based state (VIZ-12), no wall-clock or remote age (VIZ-11), no "working on", no per-person statistics or history beyond the log the person filter already shows, and no overlay value (VIZ-13).
3. **No identity linking.** Follow never links characters across rooms or by display name (glossary §2; 12 §8 Q4); the key is the room's peer handle (R-V22).
4. **Recordings unchanged.** Follow never steers the recording camera and the now card is never on the recording canvas (VIZ-28, VIZ-29).
5. **Framing.** Docs and strings present follow as keeping a pair-programming partner's corner of the office in view, never as supervision (§2.4 wording rule; 10-product §3.18 edit in §7).

## 5. Requirements

| Id | Rule |
|---|---|
| **FEAT-F32-01** | Follow MUST be page state only: at most one followed peer per room, in page memory only. It MUST NOT be sent in any request, stored in browser storage, the URL fragment or a file, logged or written to the board, and MUST NOT add a route, parameter, payload, view-model field, scene-event kind or `Timeline`/`Scene` field. |
| **FEAT-F32-02** | Follow MUST start only from the §2.1 controls and MUST set the person filter to the followed peer; it MUST end only when the user toggles it off, presses `Esc`, or clears or changes the person filter while its room is selected, when the page reloads, or when a world reload no longer lists the followed handle among the room's characters (R-V22). A room switch MUST NOT end it. No scene event MAY start or end it, and it MUST NOT apply to another room. |
| **FEAT-F32-03** | In a room with a follow, the office panel MUST scroll only by the §2.2 three-step rule over the followed actors; another actor's event MUST NOT scroll it. Follow MUST NOT change `Z` or enter the coarse view. |
| **FEAT-F32-04** | A user scroll while following MUST be honoured until the next beat in which a followed actor's `place` changes, or a chip click (which centres even a visible frame); the camera's own scrolls MUST NOT count as user scrolls. |
| **FEAT-F32-05** | The camera MUST pan over 300 ms, and MUST jump under effective reduced motion, at replay speed ≥ 4×, and on a seek, `room_snapshot`, "load earlier" or room switch. |
| **FEAT-F32-06** | The now card MUST be computed only from the drawn scene, the layout and the character table by the §2.3 table and limits; it MUST NOT be a §3.8 card, show an overlay value, a time or age, "working on", a note's text, or any aggregate over time. |
| **FEAT-F32-07** | For every position p, the now card and the camera target MUST be equal in live and replay (both functions of `reduceScene(p)`, the layout and the viewport). |
| **FEAT-F32-08** | Follow MUST be keyed by the peer handle within one room and MUST NOT link characters across rooms or by display name. |
| **FEAT-F32-09** | The eight §2.4 codes MUST be in the 12 §3.11 table with templates in all six human catalogs (Plan 8a: `en` only), within the channel `viz` caps, and MUST NOT contain a denylisted surveillance word (§6 T-VIZ-follow-i18n). The codes MUST land in the same merge as the §3.11 table edit (T-VIZ-i18n compares `codes.ts` with the spec table). |
| **FEAT-F32-10** | Follow MUST NOT steer the recording camera; the now card MUST never reach the recording canvas. |
| **FEAT-F32-11** | (SHOULD) The toggles SHOULD be buttons with `aria-pressed`, the now card a region labelled by `UI_VIZ_FOLLOWING`, and follow start and end SHOULD be offered to the existing announcer (≤ 1 per 10 s). |
| **FEAT-F32-12** | (SHOULD) User docs SHOULD introduce follow as keeping a pair-programming partner's corner of the office in view, stating that nothing is sent and the followed person sees the same board; they SHOULD avoid the §6 denylist words in every language too. |

## 6. Tests

| Test | Kind | Input → expected | Proves |
|---|---|---|---|
| T-VIZ-follow-camera | unit | Office of 12 cells (44 tiles tall, 12 §3.5.2), view of 20 tiles at the top (rows 0–19). Peer A's character at the slot-0 chair of cell 0 (y 6), its pet at the slot-0 chair of cell 1 (y 6), both visible; peer B publishes at a desk of cell 11 → `null`. A's pet walks to the slot-0 chair of cell 10 (y 36) → the frame (rows 5–37, 33 tiles) does not fit → `cameraTarget` centres the pet's tile, clamped to the office (view rows 24–43). Both A actors then walk to the slot-0 chairs of cells 3 and 4 (y 16, above the view) → the frame (rows 15–17) fits and is centred (view top at row 6.5; the panel scrolls by device pixels); one of them then walks to cell 5 (y 16, inside the view) → `null` (step 1); a chip click → the frame is centred even so (`force`). After `userScrolled()`: a B beat and an A beat with no `place` change → no scroll; the next A move → scroll. Room 2 without follow: the 30 s rule scrolls to an off-screen event only 30 s after the last user scroll | FEAT-F32-03, -04 |
| T-VIZ-follow-motion | unit | Fake scroller: 2× replay → a 300 ms smooth scroll; 4× → jump; emulated reduced motion and the in-page toggle → jump; seek, `room_snapshot`, "load earlier", room switch → jump; paused → no scroll call; zoom and coarse flag unchanged after 100 beats | FEAT-F32-05, -03 |
| T-VIZ-follow-now | unit | Hand-built scene: A has pets P1, P2; B has pet Q1; P1 holds 4 HELD claims and 1 STALE → 3 holding rows + `UI_VIZ_MORE` n=1, no stale row; R1 from P1 to Q1 with status `queued_until_turn_end` → asks row "asks {B's name} (R1)" with `UI_VIZ_ICON_QUEUED`; R3 from P1 with status null → asks row without an icon; R2 from Q1 to P2 → asked-by row; P2 `lastPublish` (40, 1001, 0) at the file desk `src/cart.ts`, the character (38, 1001, 0) → "last shared: src/cart.ts (#40)"; P2 then ends (`live` false) → the same row; variants: P2's newest publish at a folder desk → its plaque, at a shelf desk → its zone sign + `/…`, at the big table → `UI_VIZ_NOW_LAST_SHARED_TABLE`; A frozen with `PAUSED` → header label `PH_PAUSED`, A a ghost → no header label; A at home with nothing → `UI_VIZ_NOW_NOTHING`; A removed from `characters` → `UI_VIZ_NOW_NOT_HERE`; overlay canary (holds 7, incoming 5, A is "you") → no overlay value in the card; no row text contains a template of "working on" | FEAT-F32-06 |
| T-VIZ-follow-plan2 | integration | The Plan 2 storyboard demo (12 §3.9.3), following each of its three people over every height → only header, last-shared, empty or not-here rows; the last-shared row names the `target` desk and the height of that person's newest `publish` event in the segment at each height | FEAT-F32-06, -07 |
| T-VIZ-follow-replay | property | At the 200 random positions of T-VIZ-seek, `nowCard` and `cameraTarget` from the page's `reduceScene` in replay equal those the page captured live at the same position (both over view-model ids) | FEAT-F32-07 |
| T-VIZ-follow-filter | unit | Start → `LogFilter.peer` = A; file and kind filters AND-combine; choosing B or clearing the person filter or `Esc` → follow ends in that room only; follow A in room 1, select room 2 (no follow, 30 s rule), back to room 1 → A followed again and `LogFilter.peer` = A; rooms 1 and 2 each have a "Minji" with different peer ids → following room 1's Minji follows nobody in room 2; a world reload in which A's handle is extended (R-V22 collision) → follow ends; a page reload → no follow, and `location.hash` never held follow state | FEAT-F32-02, -08 |
| T-VIZ-follow-keys | unit | `F` with a person filter toggles follow and `aria-pressed`; `F` without one → nothing; `F` in the language select → nothing | FEAT-F32-02, -11 |
| T-VIZ-follow-privacy | CI browser (browser smoke item (k), or the next free letter: F34 proposes (j)) | With a two-room demo log: toggling follow 50 times, switching rooms and seeking → zero requests besides the timeline pages the seeks need; no `localStorage` change and no `sessionStorage` change except the selected room id that 12 §3.2 item 11 keeps; `location.hash` never contains follow state; the viewer log gains no line. **Plan 8b clause** (recording is 8b, 12 §3.9.4): a recording with follow on draws the same frames as with follow off | FEAT-F32-01, -10 |
| T-VIZ-follow-i18n | CI lint | The eight codes render in every catalog (8a: `en`) within the caps with equal placeholder sets; their templates match none of: en `monitor|track|surveil|spy|supervis|watch`; ko `감시|추적|모니터|감독|사찰`; ja `監視|追跡|監督`; zh-CN `监视|监控|追踪|监督`; fr `surveill|espionn|traqu|supervis`; es `vigil|espi|rastre|supervis` | FEAT-F32-09 |

## 7. Spec edits (exact text)

1. **12 §1.1**, new bullet: "- Following a person in a room (§3.8.1, F32): a page-only toggle that steers the office scroll and pins a now card; no new read, route, payload or scene event."
2. **12 §2**, two rows: "| **following (a person)** | A page-only, per-room choice of one peer whose character and pets steer the office scroll (§3.8.1); never served, stored or logged. Not the live pill's following of the tip (§3.9.1) nor the log's following of new cards (§3.8). | local |" and "| **now card** | The region pinned above the log while a follow is on, computed from the drawn scene (§3.8.1); not a card of §3.8's list. | local |".
3. **12 §3.5.3**, "Scrolling" bullet: after "…only when the user has not scrolled in the last 30 s." insert "In a room with a follow (§3.8.1), the follow camera replaces this rule; in replay it is the only automatic scroll."
4. **12 §3.8 Filters**, append: "Following (§3.8.1) pins the person filter while its room is selected; whom a page follows is never mirrored into the fragment."
5. **12 §3.8.1 Following a person** (new, at the end of §3.8): §2.1–§2.3 of this proposal verbatim.
6. **12 §3.11**: the §2.4 codes into the Controls and Scene labels rows; Keyboard bullet: "`Esc` clears filters" → "`Esc` clears filters and ends the selected room's follow; `F` toggles following the person-filtered character". This table edit lands in the same merge as `src/viz/i18n/{codes,en}.ts` (FEAT-F32-09; §8).
7. **12 §4**: VIZ-24 append "The now card of §3.8.1 is not a card of this list."; VIZ-28 append "A follow (§3.8.1) never moves the recording camera."; new group "### Following" with FEAT-F32-01–12 verbatim, keeping their ids (as F29 and F34 do), `_Covers:_ follow-feels-like-surveillance, layout-reflow-disorients` (the first is new).
8. **12 §7**: the nine rows of §6 (owned by 12-visualizer); T-VIZ-browser-smoke gains item (k) (or the next free letter; F34 proposes (j)) = T-VIZ-follow-privacy, its recording clause run from Plan 8b.
9. **12 §9.2** (glossary §20 viewer row), append: "follow: ≤ 1 peer per room, page memory only; pan 300 ms, jump at ≥ 4× or reduced motion; now card ≤ 3 holding, ≤ 3 asks, ≤ 3 asked-by rows".
10. **12 §9.4 → 10-product §3.18 README, anchor `privacy`**, append: "You can follow a teammate in the viewer to keep their corner of the office in view, like glancing at a pair-programming partner. Following sends nothing and tells no one; it shows only the board facts every teammate's viewer already has."
11. **Roadmap row 8**: 8a exit adds "(Task 19) -follow-camera, -follow-motion, -follow-now, -follow-plan2, -follow-replay, -follow-filter, -follow-keys, -follow-i18n (`en`) and browser smoke item (k) without its recording clause"; 8b exit adds "the recording clause of browser smoke item (k) and the F32 codes in six languages".

## 8. Placement

F32 cannot ride inside Tasks 13–14. T-VIZ-i18n (Task 3, merged) parses the 12 §3.11 table from `docs/spec/12-visualizer.md` and deep-equals it with `VIZ_CODES`, and its source scan fails on any `UI_VIZ_*` literal in `src/viz/**` outside that set. So the eight codes, the §3.11 table edit and every file that renders them must land in **one** merge. 8a's spec edits are applied only by Task 18 step B2 (R-V02), and `npm run ci` must be green at every task merge (R-V01). F32 is therefore one additive task at the end of 8a:

- **Plan 8a, new Task 19 "Follow a teammate (F32)"**, group G9 after Task 18. **Depends on:** 5 (`reduceScene`, `phOf`, R-V25 `lastDesk`), 12 (`placeTile`), 13, 14, 17, 18. Before it starts, the controller records in 8a's ledger an R-V02 table row for the files it touches outside `src/viz/**`: `docs/spec/12-visualizer.md`, the roadmap and `test/integration/viz/browserSmoke.test.ts`, owner Task 19. The row's reason is that Task 19 lands after Task 18's spec batch, so no other task edits those files at the same time. Without that row, R-V02 ("exactly the files of the table") would make an implementer stop. In one merge: §7 items 1–9 and 11 (12 and the roadmap; approved by the owner with this proposal), the eight codes in `src/viz/i18n/{codes,en}.ts`, `src/viz/ui/follow.ts` (new) and its unit tests, the `KeyAction`/`KEYS` addition in `ui/a11y.ts`, the client wiring in `client/{office,log,a11y}.ts` (DOM via `textContent` only, L-VIZ-DOM), browser smoke item (k) without its recording clause in `test/integration/viz/browserSmoke.test.ts`, and a re-run of Task 18 step B's exit sweep with the F32 titles added. `ui/fragment.ts` and `ui/zoom.ts` are unchanged. Tasks 13 and 14 keep their reviewed contracts; F32 stays droppable without touching them.
- **Plan 8b:** the six-language templates of the eight codes with the other catalogs; the recording clause of smoke item (k) together with T-VIZ-recording; §7 item 10 (the 10-product §3.18 README sentence) with the README work.
- **Implementable now:** yes with respect to Plans 3–7. F32 needs nothing from them, and their facts appear in the now card when their folds land. It is not codeable today: Tasks 5, 13, 14, 17 and 18 are behind gate P (Plan 2's exit, R-V01). Of its inputs only Task 4 (types, `lastDesk` in the model types) and Task 12 (`placeTile`) have merged.

## 9. Open question

- **Q1 Follow in recordings.** Steering the recording camera by a follow would make "a day of Minji" clips. *Default: no* (FEAT-F32-10): it would make a per-person recording the easy path, which is the surveillance reading §4 avoids.
- **Q2 Single-character shortcut (WCAG 2.1.4).** `F`, like the existing `L`, is a one-key shortcut that a speech-input or screen-reader user can trigger by accident. *Default:* keep it, active only while focus is inside the page's own panels (never in a form control), and settle `F` and `L` together in 12 §3.11 if an accessibility review asks for a way to turn them off.
- **Q3 `Esc` with an open panel.** F34 proposes `Esc` to close the postcard panel. *Default:* `Esc` closes an open panel first; only an `Esc` with no panel open clears filters and ends the follow.

## Review notes

Adversarial review, 2026-10-08. Checked against 12-visualizer (whole chapter), glossary §2, 10-product UX-22 and §3.18, the roadmap row 8, the Plan 8a plan (rulings R-V01, R-V02, R-V22, R-V25, R-V56; the task and group table; the `ui/**` interfaces) and the code merged on `feat/p8a-viz` (Tasks 1, 3, 4, 12), and against the sibling proposals F04, F29 and F34.

**Refutation attempts that failed (the design stands):** follow is not in the spec under another name: the nearest things are the person filter (§3.8), the 30 s auto-scroll (§3.5.3, Plan 8a's `FollowRule`) and the hidden people list's place labels (§3.11), and F32 builds on them without duplicating them. It breaks no invariant: nothing is read, served, stored, logged or sent; no board, IPC, hook, hold or MASK path is touched; it is git-remote-only by having no transport at all; it needs no Claude Code hook. Teammates see no noise because nothing reaches them. The surveillance reading is handled by the page-only design, the wording rule, the no-recording default and the "nothing is sent" docs.

**Changed:**
1. **Fragment key dropped.** `&follow=1` contradicted "never stored in a file" (browsers keep fragment URLs in their history files) and the §7 item 9 text "page memory only". Follow is now page memory only; `ui/fragment.ts` is unchanged; a page reload ends every follow (§2.1, §3, §4 item 1, FEAT-F32-01/-02, §7 item 4, T-VIZ-follow-filter, -privacy).
2. **Handle change after a collision (R-V22).** A handle can grow after a prefix collision, and the world is then re-sent. A follow keyed by the old handle would have shown `UI_VIZ_NOW_NOT_HERE` forever. It now ends when a world reload no longer lists the handle (§2.1, FEAT-F32-02, T-VIZ-follow-filter).
3. **Placement.** T-VIZ-i18n parses the 12 §3.11 table and deep-equals it with `codes.ts`, and 8a's spec edits come only from Task 18 (R-V02). The codes therefore could not land in Task 13 with the spec edit deferred to Task 18. F32 is now one additive Plan 8a Task 19 after Task 18 (codes, spec edits and wiring in one merge), with six languages and the recording clause in 8b. "Implementable now" is kept with respect to Plans 3–7, now qualified: Tasks 5, 13, 14, 17 and 18 are behind gate P. Only Tasks 4 and 12 have merged (§8, header).
4. **Id collisions with F34.** F34 already claims VIZ-43..VIZ-50 and browser smoke item (j). F32 now keeps its `FEAT-F32-NN` ids, as F29 and F34 do, and takes item (k) or the next free letter. F34's own §7 still says VIZ-43..VIZ-50 in two places; that is left to F34's owner.
5. **Contradiction on the privacy smoke item.** It was placed in 8a (Task 17) and also in 8b. Its recording clause needs 8b's export (12 §3.9.4), so that clause now runs in 8b and the rest in 8a. "Switching rooms" needs two rooms, but the bundled demo has one, so the test now uses a two-room demo log. "No `sessionStorage` change" was false: room selection writes the room id there (12 §3.2 item 11). That write is now excepted.
6. **Last-shared row.** The desk `key` it printed is not served (`LayoutVM.desks` has no key). It now prints the path, the plaque, or the zone sign + `/…` by desk kind. It also ignored ended pets, so a pet that published and then ended would have hidden the person's newest share; every pet of the peer now counts. The camera still frames live pets only.
7. **Header label.** `phOf` needs a status the scene does not carry, and `CharacterVM.ph` is computed at the tip, which would put a live label on a past scene in replay. The header now calls `phOf(c, c.absent ? 'absent' : 'active', s.at)`, computed from the scene alone.
8. **Plan mapping and citation in "What shows when".** It mapped asked-by to Plan 5 and cited §1.5 item 9. Holding comes with Plan 4 (claims, once the seat's pet exists) and asks and asked-by with Plan 6; the citation is now §1.5 item 2 and the §3.4 plan table.
9. **Tests with wrong expectations.**
   - T-VIZ-follow-camera: after the pet was centred, the view was rows 24–43, and the walk to cells 6–7 stayed inside it, so step 1 means no scroll, not "centred". The test now uses cells 3–4, with exact tile rows.
   - T-VIZ-follow-replay: T-VIZ-seek uses 200 positions, not 100.
   - T-VIZ-follow-plan2: the newest publish *card*'s first chip is not the target desk; the test now compares with the `publish` event's `target`.
   - T-VIZ-follow-now: it gains the ended-pet, desk-kind, null-status and header-label cases, and uses pet-to-pet requests, which is how claims are held.
10. **Chip click.** "Re-centres at once" contradicted step 1, under which a visible frame does nothing. A chip click now skips step 1 (the `force` argument).
11. **Smaller fixes.**
    - The control is the visible person-filter chip, plus a second button per row of the *hidden* people list for screen readers.
    - A room switch is defined as no filter change and no end of a follow; `Esc` ends the selected room's follow.
    - Horizontal scroll also happens in a panel narrower than the office at the minimum `Z`.
    - The 30 s rule is live-only, so the wording now says the camera "replaces" it in live mode and is the only automatic scroll in replay.
    - "As `shouldPoof`" became "the speed threshold of `shouldPoof`", because the poof also needs more than 12 tiles.
    - "Never a count" became "never a count over time", since `UI_VIZ_MORE` shows "+n".
    - The segment-start note was generalized.
    - The `KeyAction` union gains `'follow'`.
    - The relation to `FollowRule` is stated, and the 12 §2 term is "following (a person)", to keep it apart from the live pill and the log, which also "follow".
    - FEAT-F32-12 said "watching", against its own denylist; it is reworded.
    - The denylist reference pointed at §5; it now points at §6.
    - The now card's order next to F04's catch-up panel is defined.

**Left open:** Q1–Q3 above. Task 19's number and group, and its R-V02 row for the files outside `src/viz/**` (§8), are the controller's to confirm and record in 8a's ledger. If the owner prefers, the whole task can move to 8b instead, which costs nothing but time to the public release. The coarse view's tile for a zone table is page-defined (12 does not give one); the camera uses whatever tile the office draws there.
