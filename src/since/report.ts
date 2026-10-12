// The catch-up report of `/cowork since` (10-product §3.9a; glossary §29, rev 2.5, F04; F04-a, owner decision D5): one pure
// reducer, so the daemon's incremental accumulator (Plan 5's return recap) equals the CLI's batch report by construction
// (FEAT-F04-07): sinceFinish(steps.reduce(sincePush, sinceInit(…)), capFrom) — named `sinceReport` in the plans.
//
// Pure and total (L-PURE, 11-testing §3.10): no I/O, clock, randomness, git or IPC; it loads only src/board's change-set id
// grammar, the shared area rule src/data/zone.ts, and types. A step is one folded board commit (12 §9.7 items 1, 2, 8): the
// batched read, the fold's per-op verdicts (only `effective` ops count) and the state after it.
//
// The accumulator is a log: sincePush appends the facts of one step (O(1) in the steps before it; it never copies or
// mutates what it was given) and sinceFinish builds every section from the whole log. That is what lets the cap be applied
// at the end (`capFrom`, known only once `to` is), and lets "my paths" look 1,024 heights below the range start.
//
// What F04-a fills (the facts the Plan 2 fold makes effective): `you.touches`, `saves`, `team` and `events` (joins, rejoins,
// leaves, freeze, unfreeze, incident). `you.requests`, `records`, `notes`, `wake` and the held-changes event stay empty until
// Plans 3, 5 and 6 add their rows; claim labels arrive with Plan 4 through `SinceOptions.verifiedLabel`.
import type { BoardRead } from '../board/batchRead.js';
import { parseCsActor } from '../board/csActor.js';
import type { FoldState, OpVerdict } from '../board/fold.js';
import type { PeerId } from '../board/ids.js';
import { zone } from '../data/zone.js';
import type { Oid } from '../git/oid.js';
import type { Params } from '../i18n/render.js';

/** One folded board commit (12 §9.7 items 1, 2, 8): its batched read (BoardRead carries csPaths, R-V05), verdicts and state after. */
export interface SinceStep { data: BoardRead; verdicts: OpVerdict[]; after: FoldState; }
/** This peer's hold-record metadata (the registry's records/<id>.json fields, never a blob; F04 design §2.2). */
export interface MyRecord { readonly id: string; readonly paths: readonly string[]; readonly state: string; readonly offer: string; }
/** A verified claim label (structural: Plan 4's ClaimLabel is assignable). */
export interface SinceLabel { readonly simple: string; readonly qualname: string; }
/**
 * The one label-lookup slot (X-23; verify pass V-6): Plan 4's lookup of labels the daemon has already verified, which never
 * schedules a parse. Absent in F04-a and on every Plan 2/3 board: no folded claim exists, so it is never called and claim rows
 * carry no label. When Plan 4 adds claim rows, sincePush calls it, so the accumulator and the batch see the same labels.
 */
export interface SinceOptions { readonly verifiedLabel?: (claimId: string, anchor: string) => SinceLabel | null; }
/** The accumulator: opaque and immutable (sincePush returns a new one). */
export type SinceAcc = { readonly __since: unique symbol };
/** One row: a catalog code and its typed params (no rendered text); csIds, when given, the change-sets it summarizes. */
export interface SinceRow { readonly code: string; readonly params: Params; readonly csIds?: readonly string[]; }
/**
 * Sections in §3.9a order: `you` first, then saves, team and events (FEAT-F04-06). `from` is the range start the accumulator
 * was made with (the anchor's height); `to` the height of the last step pushed; `truncatedFrom` the `capFrom` of sinceFinish
 * when it truncates the range (capFrom > from; rows cover `(truncatedFrom, to]`), else null.
 */
export interface SinceReport {
  from: number; to: number; truncatedFrom: number | null;
  you: { requests: readonly SinceRow[]; records: readonly SinceRow[]; touches: readonly SinceRow[];
         notes: ReadonlyArray<SinceRow & { note: { target: string; author: string; text: string } }>; wake: number };
  saves: readonly SinceRow[]; team: ReadonlyArray<{ row: SinceRow; areas: readonly SinceRow[] }>; events: readonly SinceRow[];
}

/** "My paths" reach this far below the range start: this peer's groups in (from − 1,024, to] (10-product §3.9a). The one
 *  definition: walk.ts imports it to start its walk that far below the range, so the reader and the core cannot disagree. */
export const MY_PATHS_LOOKBACK = 1_024;
const SAVES_MAX = 10;
const AREAS_MAX = 3;
/** The area of a group whose trailers carry no Cowork-CS-Paths (more than 256 paths, glossary §5). */
const AREA_UNLISTED = '…';
/**
 * Glossary §9 / 05-holds: a record in one of these states is terminal. A copy of src/holds/record.ts's TERMINAL_STATES (src/holds
 * sits after src/since, X-110, so it is not imported); exported only so that a unit test holds the two equal (final review M7).
 */
export const TERMINAL_HOLD_STATES: ReadonlySet<string> = new Set(['SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD']);

const EV_JOIN = 'UI_SINCE_EV_JOIN';
const EV_REJOIN = 'UI_SINCE_EV_REJOIN';
const EV_LEAVE = 'UI_SINCE_EV_LEAVE';
const EV_FREEZE = 'UI_SINCE_EV_FREEZE';
const EV_UNFREEZE = 'UI_SINCE_EV_UNFREEZE';
const EV_INCIDENT = 'UI_SINCE_EV_INCIDENT';
const EVENT_KIND_CODES: ReadonlyMap<string, string> = new Map([['freeze', EV_FREEZE], ['unfreeze', EV_UNFREEZE], ['incident', EV_INCIDENT]]);

/**
 * One fact of a step. cs: a Cowork-CS trailer of a board commit whose live code changed, written by `peer` (its writer), at
 * trailer index i; paths null when the trailer has no Cowork-CS-Paths (then n is its paths=<n>). save and ev: an effective op
 * at ops.jsonl line `line`.
 */
type Fact =
  | { readonly k: 'cs'; readonly h: number; readonly i: number; readonly peer: PeerId; readonly csId: string; readonly paths: readonly string[] | null; readonly n: number }
  | { readonly k: 'save'; readonly h: number; readonly line: number; readonly peer: PeerId; readonly saveCommit: string }
  | { readonly k: 'ev'; readonly h: number; readonly line: number; readonly code: string; readonly peer: PeerId };
/** The log, newest step first; a step without facts adds no node. */
interface LogNode { readonly facts: readonly Fact[]; readonly prev: LogNode | null; }
interface Acc {
  readonly from: number; readonly you: PeerId; readonly mine: readonly MyRecord[];
  readonly label: SinceOptions['verifiedLabel'] | null;
  /** The state the next step folds onto (start, then the last step's `after`): join classification and display names. */
  readonly last: FoldState;
  /** The last step's live code; null before the first step, whose trailers therefore never count (see sincePush). */
  readonly lastLive: Oid | null;
  readonly log: LogNode | null;
}

const toAcc = (a: SinceAcc): Acc => a as unknown as Acc;
const fromAcc = (a: Acc): SinceAcc => Object.freeze(a) as unknown as SinceAcc;
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The accumulator of a range starting after `from` (the anchor's height; −1 for the whole board), for this peer `you` with its
 * hold-record metadata `mine`. `start` is the state the first pushed step folds onto. The first step only sets the live-code
 * baseline (its trailers do not count, as at height 0), so a caller starts at genesis or at a height at or below
 * from − 1,024 (walkSince does); steps at or below `from` feed only "my paths".
 */
export function sinceInit(start: FoldState, from: number, you: PeerId, mine: readonly MyRecord[], o?: SinceOptions): SinceAcc {
  const copy = mine.map((r) => Object.freeze({ id: r.id, paths: Object.freeze([...r.paths]), state: r.state, offer: r.offer }));
  return fromAcc({ from, you, mine: Object.freeze(copy), label: o?.verifiedLabel ?? null, last: start, lastLive: null, log: null });
}

/** The accumulator with one more step (the next height): a new value; neither `a` nor `s` is changed. */
export function sincePush(a: SinceAcc, s: SinceStep): SinceAcc {
  const acc = toAcc(a);
  const facts = factsOf(acc.last, acc.lastLive, s);
  return fromAcc({ ...acc, last: s.after, lastLive: s.data.liveCode, log: facts.length === 0 ? acc.log : Object.freeze({ facts, prev: acc.log }) });
}

/** A string member of an effective op's line (the fold parsed it, so it is a JSON object), else null. */
function member(line: string | undefined, key: string): string | null {
  if (line === undefined) return null;
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v !== 'object' || v === null || Array.isArray(v) || !has(v, key)) return null;
    const x = (v as Record<string, unknown>)[key];
    return typeof x === 'string' ? x : null;
  } catch {
    return null;
  }
}

/**
 * The facts of one step, in board position order (12 §3.3.5): step 1, the effective ops in line order; step 2, when the live
 * code changed (12 §3.3.5 step 2: the board commit names another live commit than the one before it; never at height 0),
 * every Cowork-CS trailer with a valid change-set id, written by the board commit's writer. A join is classified against
 * the writer's record as the commit's earlier ops left it: no record, or a left or absent one of the same epoch → joined; a
 * record of another epoch → rejoined (new epoch); an active record of the same epoch (a re-announcement) → nothing.
 */
function factsOf(prev: FoldState, prevLive: Oid | null, s: SinceStep): Fact[] {
  const d = s.data;
  const h = d.height;
  const w = d.writer;
  const out: Fact[] = [];
  if (w === null) return out;
  const rec0 = has(prev.peers, w.peer) ? prev.peers[w.peer]! : undefined;
  let rec: { epoch: string; status: string } | undefined = rec0 === undefined ? undefined : { epoch: rec0.epoch, status: rec0.status };
  for (const v of s.verdicts) {
    if (v.verdict !== 'effective') continue;
    const line = v.line;
    if (v.type === 'join') {
      const code = rec === undefined ? EV_JOIN : rec.epoch !== w.epoch ? EV_REJOIN : rec.status !== 'active' ? EV_JOIN : null;
      rec = { epoch: w.epoch, status: 'active' };
      if (code !== null) out.push({ k: 'ev', h, line, code, peer: w.peer });
    } else if (v.type === 'leave') {
      out.push({ k: 'ev', h, line, code: EV_LEAVE, peer: w.peer });
      if (rec !== undefined) rec = { epoch: rec.epoch, status: 'left' };
    } else if (v.type === 'event') {
      const code = EVENT_KIND_CODES.get(member(d.opsLines[line], 'kind') ?? '');
      if (code !== undefined) out.push({ k: 'ev', h, line, code, peer: w.peer });
    } else if (v.type === 'save') {
      const saveCommit = member(d.opsLines[line], 'save_commit');
      if (saveCommit !== null) out.push({ k: 'save', h, line, peer: w.peer, saveCommit });
    }
  }
  if (h > 0 && prevLive !== null && d.liveCode !== prevLive) {
    d.cs.forEach((t, i) => {
      if (parseCsActor(t.csId) === null) return;
      const paths = d.csPaths.get(t.csId);
      out.push({ k: 'cs', h, i, peer: w.peer, csId: t.csId, paths: paths === undefined ? null : Object.freeze([...paths]), n: t.paths });
    });
  }
  return out;
}

/** UTF-16 code-unit order (deterministic on every platform; areas and paths are ASCII in practice). */
const byUnits = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** A teammate's change-set group in the range: its first counted trailer's position, and the paths its trailers list. */
interface Group { peer: PeerId; csId: string; h: number; i: number; paths: Set<string>; unlisted: boolean; unlistedN: number; }

/**
 * The report of everything pushed so far. capFrom (the 5,000-height cap, 10-product §3.9a "Limits"; null when the range is not
 * capped): rows cover heights above max(from, capFrom), and my paths reach 1,024 heights below that; truncatedFrom is capFrom
 * only when it truncates (capFrom > from), so a capFrom at or below `from` gives the uncapped report (final review M13).
 * Total; does not change `a`.
 */
export function sinceFinish(a: SinceAcc, capFrom: number | null): SinceReport {
  const acc = toAcc(a);
  const lower = capFrom === null ? acc.from : Math.max(acc.from, capFrom);
  const facts: Fact[] = [];
  const nodes: LogNode[] = [];
  for (let n = acc.log; n !== null; n = n.prev) nodes.push(n);
  for (let j = nodes.length - 1; j >= 0; j--) facts.push(...nodes[j]!.facts);
  const peers = acc.last.peers;
  const nameOf = (p: PeerId): string | null => (has(peers, p) ? peers[p]!.display : null);

  // My paths: my groups in (lower − 1,024, to] and my non-terminal hold records (claims: Plan 4).
  const mine = new Set<string>();
  for (const r of acc.mine) if (!TERMINAL_HOLD_STATES.has(r.state)) for (const p of r.paths) mine.add(p);
  // Teammates' groups in (lower, to], in board order of their first trailer. One group per cs_id (FEAT-F04-06), keyed with
  // its writer too: a cs_id names its peer or seat, so on an honest board that is the same, and a trailer that names another
  // peer's cs_id can neither merge into that peer's group nor take it over.
  const groups = new Map<string, Group>();
  for (const f of facts) {
    if (f.k !== 'cs') continue;
    if (f.peer === acc.you) {
      if (f.h > lower - MY_PATHS_LOOKBACK && f.paths !== null) for (const p of f.paths) mine.add(p);
      continue;
    }
    if (f.h <= lower) continue;
    const key = `${f.peer}\n${f.csId}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { peer: f.peer, csId: f.csId, h: f.h, i: f.i, paths: new Set(), unlisted: false, unlistedN: 0 };
      groups.set(key, g);
    }
    if (f.paths === null) {
      g.unlisted = true;
      g.unlistedN = Math.max(g.unlistedN, f.n);
    } else {
      for (const p of f.paths) g.paths.add(p);
    }
  }

  // Touches (section 2 (c)): per (path of mine, teammate), the teammate's groups that listed that path; in board order of
  // the first such group, then path. A group without a path list never touches (10-product §3.9a).
  const touchRows = new Map<string, { peer: PeerId; path: string; csIds: string[] }>();
  for (const g of groups.values()) {
    for (const p of [...g.paths].sort(byUnits)) {
      if (!mine.has(p)) continue;
      const key = `${p}\n${g.peer}`;
      let t = touchRows.get(key);
      if (t === undefined) {
        t = { peer: g.peer, path: p, csIds: [] };
        touchRows.set(key, t);
      }
      t.csIds.push(g.csId);
    }
  }
  const touches: SinceRow[] = [...touchRows.values()].map((t) => ({ code: 'UI_SINCE_TOUCH', params: { peer: t.peer, name: nameOf(t.peer), path: t.path, k: t.csIds.length }, csIds: t.csIds }));

  // Team (section 4): teammates in board order of their first group, never ranked by count; per teammate ≤ 3 areas, the
  // most groups first, ties by area. A group counts once in each area of its listed paths, and under '…' when one of its
  // trailers had no path list (with the paths=<n> values of those groups as `paths`). The area is zone(p) unchanged, so a
  // root-level file and a top-level folder named '·' share the area '·' (12 §2's rule; a display grouping only).
  const mates = new Map<PeerId, Group[]>();
  for (const g of groups.values()) {
    const list = mates.get(g.peer);
    if (list === undefined) mates.set(g.peer, [g]);
    else list.push(g);
  }
  const team = [...mates].map(([peer, gs]) => {
    const areas = new Map<string, { csIds: string[]; paths: number }>();
    for (const g of gs) {
      const zs = new Set([...g.paths].map(zone));
      if (g.unlisted) zs.add(AREA_UNLISTED);
      for (const z of zs) {
        let x = areas.get(z);
        if (x === undefined) {
          x = { csIds: [], paths: 0 };
          areas.set(z, x);
        }
        x.csIds.push(g.csId);
        if (z === AREA_UNLISTED && g.unlisted) x.paths += g.unlistedN;
      }
    }
    const top = [...areas].sort(([za, xa], [zb, xb]) => xb.csIds.length - xa.csIds.length || byUnits(za, zb)).slice(0, AREAS_MAX);
    const areaRows: SinceRow[] = top.map(([z, x]): SinceRow => {
      const params: Params = z === AREA_UNLISTED ? { area: z, n: x.csIds.length, paths: x.paths } : { area: z, n: x.csIds.length };
      return { code: 'UI_SINCE_TEAM_AREA_NOLABEL', params, csIds: x.csIds };
    });
    return { row: { code: 'UI_SINCE_TEAM_ROW', params: { peer, name: nameOf(peer), k: gs.length }, csIds: gs.map((g) => g.csId) }, areas: areaRows };
  });

  // Saves (section 3): the effective save ops in the range, newest first, at most 10; the save commit as 8 hex, no subject.
  const saves: SinceRow[] = facts
    .filter((f): f is Extract<Fact, { k: 'save' }> => f.k === 'save' && f.h > lower)
    .reverse()
    .slice(0, SAVES_MAX)
    .map((f) => ({ code: 'UI_SINCE_SAVE', params: { peer: f.peer, name: nameOf(f.peer), c8: f.saveCommit.slice(0, 8), h: f.h } }));

  // Events (section 5): joins, rejoins, leaves, freeze, unfreeze and incident in board order.
  const events: SinceRow[] = facts
    .filter((f): f is Extract<Fact, { k: 'ev' }> => f.k === 'ev' && f.h > lower)
    .map((f) => ({ code: f.code, params: { h: f.h, peer: f.peer, name: nameOf(f.peer) } }));

  return {
    from: acc.from,
    to: acc.last.height,
    truncatedFrom: capFrom !== null && capFrom > acc.from ? capFrom : null,
    you: { requests: [], records: [], touches, notes: [], wake: 0 },
    saves,
    team,
    events,
  };
}
