// The pure catch-up core (F04-a Task A2; 10-product §3.9a, §7 T-F04-golden; FEAT-F04-06, -07; 11-testing §3.10 L-PURE):
// sinceInit/sincePush/sinceFinish over in-memory SB-F04 steps (test/helpers/sbF04.ts), the row rules of §3.9a, the
// finish-time range cap, the label slot (verify pass V-6) and the purity lint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import type { FoldState } from '../../src/board/fold.js';
import { TERMINAL_STATES } from '../../src/holds/record.js';
import {
  MY_PATHS_LOOKBACK, sinceFinish, sinceInit, sincePush, TERMINAL_HOLD_STATES, type MyRecord, type SinceReport, type SinceStep,
} from '../../src/since/report.js';
import {
  batchReport, LOOP, many, SB_MINE, SB_SEED, sbF04, sbF04Golden, sbF04Peers, sbPeerIds, sbRandom, sbSteps, type SbAction, type SbF04Variant,
} from '../helpers/sbF04.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const canon = (r: SinceReport): string => canonicalJson(r as unknown as Json);
const byUnits = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** SB-F04 folded in memory and its report for from 10 (A's last activity) to the tip, you = A. */
function sbReport(v: SbF04Variant, mine: readonly MyRecord[] = []): SinceReport {
  const sim = sbSteps(SB_SEED, sbF04(v));
  return batchReport(sim.start, sim.steps, { from: 10, you: sbF04Peers().a.peer, mine });
}

test('T-F04-golden: SB-F04 from 10 to 30 — one group of B under src/engine, C\'s save at 20 without a subject, B\'s rejoin and C\'s freeze, no touch', () => {
  const r = sbReport({});
  assert.deepEqual(r, sbF04Golden({}));
  assert.equal(canon(r), canon(sbF04Golden({})));
  // The save row carries the save commit as 8 hex and no subject or other free text (FEAT-F04-11).
  assert.deepEqual(Object.keys(r.saves[0]!.params).sort(), ['c8', 'h', 'name', 'peer']);
  // Section 2 (you) comes first in the report object, then saves, team and events (FEAT-F04-06).
  assert.deepEqual(Object.keys(r), ['from', 'to', 'truncatedFrom', 'you', 'saves', 'team', 'events']);
});

test('T-F04-golden variant: A\'s change-set on loop.ts at 8 makes B\'s group a touch of my paths, listed in the you section', () => {
  const r = sbReport({ aCsAt8: true });
  assert.deepEqual(r, sbF04Golden({ aCsAt8: true }));
  assert.deepEqual(r.you.touches.map((t) => [t.params['path'], t.params['name'], t.params['k']]), [[LOOP, 'B', 1]]);
});

test('T-F04-golden variant: a board-only commit repeating B\'s trailer is still one group', () => {
  assert.deepEqual(sbReport({ boardOnlyRepeat: true }), sbF04Golden({ boardOnlyRepeat: true }));
  assert.deepEqual(sbReport({ boardOnlyRepeat: true, aCsAt8: true }), sbF04Golden({ boardOnlyRepeat: true, aCsAt8: true }));
});

test('T-F04-golden variant: a 300-path group of C is counted under the area … with its paths value and never yields a touch', () => {
  const v = { bigGroupOfC: true, aCsAt8: true };
  const r = sbReport(v);
  assert.deepEqual(r, sbF04Golden(v));
  const c = sbF04Peers().c.peer;
  assert.deepEqual(r.team[1]!.areas.map((a) => a.params), [{ area: '\u2026', n: 1, paths: 300 }]);
  assert.ok(r.you.touches.every((t) => t.params['peer'] !== c), 'C\'s 300-path group touches loop.ts but carries no path list');
});

test('T-F04-golden variant: C\'s group first in the range lists C before B whatever the counts', () => {
  const r = sbReport({ cFirst: true });
  assert.deepEqual(r, sbF04Golden({ cFirst: true }));
  assert.deepEqual(r.team.map((t) => [t.row.params['name'], t.row.params['k']]), [['C', 1], ['B', 2]]);
});

test('my paths include the paths of my non-terminal hold records (registry metadata), not those of terminal ones', () => {
  const r = sbReport({ cOnMyRecords: true }, SB_MINE);
  assert.deepEqual(r, sbF04Golden({ cOnMyRecords: true }));
  // Without the records nothing of C's group is mine.
  assert.deepEqual(sbReport({ cOnMyRecords: true }).you.touches, []);
});

/**
 * A board from actions over named peers, folded in memory; `ids` gives the peer id of each of `names` (the peers first used in
 * this order, before any fresh epoch is drawn); `sim.peer(name)` gives any other.
 */
function board(seed: string, names: readonly string[], build: (ids: Map<string, string>) => SbAction[]): { start: FoldState; steps: SinceStep[]; ids: Map<string, string>; sim: ReturnType<typeof sbSteps> } {
  const ids = new Map([...sbPeerIds(seed, names)].map(([n, p]) => [n, p.peer]));
  const sim = sbSteps(seed, build(ids));
  for (const [n, id] of ids) assert.equal(sim.peer(n).peer, id, `the twin draws ${n}'s id in first-use order`);
  return { start: sim.start, steps: sim.steps, ids, sim };
}

const commit = (c: Extract<SbAction, { kind: 'commit' }>['c']): SbAction => ({ kind: 'commit', c });

test('events: join of a new peer, leave, a same-epoch return, a new epoch, unfreeze and incident in board order; re-announcements, other event kinds and rejected ops make no row', () => {
  const { start, steps, ids, sim } = board('since-events', ['b', 'c', 'a'], () => [
    { kind: 'genesis', writer: 'b' },                                                          // 0
    { kind: 'join', name: 'c' },                                                               // 1
    { kind: 'join', name: 'a' },                                                               // 2 (from)
    commit({ writer: 'c', ops: [{ type: 'leave' }] }),                                         // 3 leave
    { kind: 'join', name: 'c' },                                                               // 4 back in the same epoch: joined
    { kind: 'join', name: 'b' },                                                               // 5 re-announcement while active: nothing
    { kind: 'join', name: 'a', newEpoch: true },                                               // 6 new epoch: rejoined
    commit({ writer: 'b', ops: [{ type: 'event', cid: '', kind: 'unfreeze', refs: [], reason_code: 'EPOCH' }] }),   // 7
    commit({ writer: 'c', ops: [{ type: 'event', cid: '', kind: 'incident', refs: [], reason_code: 'REWRITE' }] }), // 8
    commit({ writer: 'a', ops: [{ type: 'event', cid: '', kind: 'health', refs: [], reason_code: 'HOST_THROTTLED' }] }), // 9 no row
    commit({ writer: 'b', rawOps: ['{"truncated":', '{"id":"x","type":"leave"}'] }),           // 10 rejected lines: nothing
    commit({ writer: null, rawOps: ['{}'] }),                                                   // 11 no writer
    { kind: 'join', name: 'd' },                                                               // 12 a new peer joined
  ]);
  const d = sim.peer('d').peer;
  const r = batchReport(start, steps, { from: 2, you: ids.get('a')! });
  assert.deepEqual(r.events, [
    { code: 'UI_SINCE_EV_LEAVE', params: { h: 3, peer: ids.get('c')!, name: 'C' } },
    { code: 'UI_SINCE_EV_JOIN', params: { h: 4, peer: ids.get('c')!, name: 'C' } },
    { code: 'UI_SINCE_EV_REJOIN', params: { h: 6, peer: ids.get('a')!, name: 'A' } },
    { code: 'UI_SINCE_EV_UNFREEZE', params: { h: 7, peer: ids.get('b')!, name: 'B' } },
    { code: 'UI_SINCE_EV_INCIDENT', params: { h: 8, peer: ids.get('c')!, name: 'C' } },
    { code: 'UI_SINCE_EV_JOIN', params: { h: 12, peer: d, name: 'D' } },
  ]);
  assert.deepEqual([r.saves, r.team, r.you.touches], [[], [], []]);
  // Events at or below from are not in the range.
  assert.deepEqual(batchReport(start, steps, { from: 6, you: ids.get('a')! }).events.map((e) => e.params['h']), [7, 8, 12]);
});

test('saves: at most 10 rows, newest first, each the save commit as 8 hex; earlier saves are dropped', () => {
  const commits = (): SbAction[] => {
    const out: SbAction[] = [{ kind: 'genesis', writer: 'b' }, { kind: 'join', name: 'a' }];
    for (let i = 0; i < 12; i++) out.push(commit({ writer: 'b', ops: [{ type: 'save', save_commit: `${String(i).padStart(2, '0')}${'e'.repeat(38)}`, saved_live: 'a'.repeat(40), chain_base: 'b'.repeat(40), released_claim_ids: [] }] }));
    return out;
  };
  const { start, steps, ids } = board('since-saves', ['b', 'a'], commits);
  const r = batchReport(start, steps, { from: 1, you: ids.get('a')! });
  assert.deepEqual(r.saves.map((s) => [s.params['h'], s.params['c8']]), Array.from({ length: 10 }, (_, i) => [13 - i, `${String(11 - i).padStart(2, '0')}eeeeee`]));
});

test('team: one row per teammate with its change-set count, then at most 3 areas by group count (ties by area), a root file under ·, trailers on unchanged live code and my own groups never counted', () => {
  const groups: Array<[string, string[]]> = [
    ['src/engine', ['src/engine/a.ts']], ['src/engine', ['src/engine/b.ts', 'src/engine/c.ts']], ['src/engine', ['src/engine/d.ts']],
    ['docs', ['docs/a.md']], ['lib', ['lib/x.ts']], ['docs', ['docs/b.md']], ['lib', ['lib/y.ts']], ['tools/lint', ['tools/lint/z.ts']], ['·', ['README.md']],
  ];
  const { start, steps, ids } = board('since-team', ['b', 'a'], (m) => [
    { kind: 'genesis', writer: 'b' },
    { kind: 'join', name: 'a' },
    ...groups.map(([, paths], i) => commit({ writer: 'b', cs: [{ csId: `${m.get('b')!}/human/${i + 1}`, paths }] })),
    commit({ writer: 'b', code: 'unchanged', cs: [{ csId: `${m.get('b')!}/human/99`, paths: ['src/ui/never.ts'] }] }),
    commit({ writer: 'a', cs: [{ csId: `${m.get('a')!}/human/1`, paths: ['src/ui/mine.ts'] }] }),
  ]);
  const b = ids.get('b')!;
  const r = batchReport(start, steps, { from: 1, you: ids.get('a')! });
  const all = groups.map((_, i) => `${b}/human/${i + 1}`);
  assert.equal(r.team.length, 1);
  assert.deepEqual(r.team[0]!.row, { code: 'UI_SINCE_TEAM_ROW', params: { peer: b, name: 'B', k: 9 }, csIds: all });
  assert.deepEqual(r.team[0]!.areas, [
    { code: 'UI_SINCE_TEAM_AREA_NOLABEL', params: { area: 'src/engine', n: 3 }, csIds: [all[0], all[1], all[2]] },
    { code: 'UI_SINCE_TEAM_AREA_NOLABEL', params: { area: 'docs', n: 2 }, csIds: [all[3], all[5]] },
    { code: 'UI_SINCE_TEAM_AREA_NOLABEL', params: { area: 'lib', n: 2 }, csIds: [all[4], all[6]] },
  ]);
});

test('a teammate\'s seat change-set counts for the teammate that wrote it; one group spans its checkpoint and closed commits', () => {
  const seat = '5e'.repeat(16);
  const { start, steps, ids } = board('since-seat', ['b', 'a'], () => [
    { kind: 'genesis', writer: 'b' },
    { kind: 'join', name: 'a' },
    commit({ writer: 'b', cs: [{ seat, state: 'checkpoint', paths: ['src/a.ts'] }] }),
    commit({ writer: 'b', cs: [{ csId: `${seat}/1`, seat, state: 'closed', paths: ['src/a.ts', 'src/b.ts'] }] }),
  ]);
  const r = batchReport(start, steps, { from: 1, you: ids.get('a')! });
  assert.deepEqual(r.team.map((t) => [t.row.params, t.row.csIds, t.areas.map((a) => a.params)]), [[{ peer: ids.get('b')!, name: 'B', k: 1 }, [`${seat}/1`], [{ area: 'src', n: 1 }]]]);
});

test('a trailer naming another peer\'s change-set id is its writer\'s group: it neither merges into nor takes over the named peer\'s group', () => {
  const { start, steps, ids } = board('since-forged', ['b', 'c', 'a'], (m) => [
    { kind: 'genesis', writer: 'b' },
    { kind: 'join', name: 'c' },
    { kind: 'join', name: 'a' },
    commit({ writer: 'c', cs: [{ csId: `${m.get('b')!}/human/1`, paths: ['docs/x.md'] }] }),
    commit({ writer: 'b', cs: [{ csId: `${m.get('b')!}/human/1`, paths: ['src/engine/a.ts'] }] }),
  ]);
  const g = `${ids.get('b')!}/human/1`;
  const r = batchReport(start, steps, { from: 2, you: ids.get('a')! });
  assert.deepEqual(r.team.map((t) => [t.row.params['name'], t.row.params['k'], t.row.csIds, t.areas.map((x) => x.params['area'])]), [
    ['C', 1, [g], ['docs']],
    ['B', 1, [g], ['src/engine']],
  ]);
});

test('my paths: my groups in (from − 1,024, to] — a path of mine published exactly at from − 1,024 is not mine, one at from − 1,023 is', () => {
  // The one lookback constant (report.ts exports it; walk.ts starts its walk that far below the range with the same value).
  assert.equal(MY_PATHS_LOOKBACK, 1_024);
  const from = 1_100;
  const { start, steps, ids } = board('since-lookback', ['b', 'a'], (m) => {
    const out: SbAction[] = [{ kind: 'genesis', writer: 'b' }, { kind: 'join', name: 'a' }];
    while (out.length < from - MY_PATHS_LOOKBACK) out.push(commit({ writer: 'b' }));
    out.push(commit({ writer: 'a', cs: [{ csId: `${m.get('a')!}/human/1`, paths: ['src/x.ts'] }] }));   // height from − 1,024
    out.push(commit({ writer: 'a', cs: [{ csId: `${m.get('a')!}/human/2`, paths: ['src/y.ts'] }] }));   // height from − 1,023
    while (out.length <= from) out.push(commit({ writer: 'b' }));
    out.push(commit({ writer: 'b', cs: [{ csId: `${m.get('b')!}/human/1`, paths: ['src/x.ts', 'src/y.ts'] }] }));
    return out;
  });
  assert.equal(steps[from - MY_PATHS_LOOKBACK]!.data.cs[0]!.csId.endsWith('/human/1'), true);
  const r = batchReport(start, steps, { from, you: ids.get('a')! });
  assert.deepEqual(r.you.touches.map((t) => t.params['path']), ['src/y.ts']);
});

test('sinceFinish(a, capFrom): rows only above capFrom, my paths from capFrom − 1,024 (not from − 1,024), from as given and truncatedFrom = capFrom', () => {
  const sim = sbSteps(SB_SEED, sbF04({ aCsAt8: true }));
  const acc = sim.steps.reduce(sincePush, sinceInit(sim.start, 10, sbF04Peers().a.peer, []));
  const capped = sinceFinish(acc, 15);
  const full = sbF04Golden({ aCsAt8: true });
  assert.deepEqual(capped, { ...full, truncatedFrom: 15, team: [], you: { ...full.you, touches: [] } });
  // The accumulator is unchanged by a finish: the uncapped report is still the golden one.
  assert.deepEqual(sinceFinish(acc, null), full);

  // My paths reach capFrom − 1,024, not from − 1,024 (final review M6): with from 1 and capFrom 1,100, a path of mine
  // published at capFrom − 1,024 = 76 (far above from − 1,024) is not mine, one at capFrom − 1,023 is.
  const capFrom = 1_100;
  const { start, steps, ids } = board('since-cap-lookback', ['b', 'a'], (m) => {
    const out: SbAction[] = [{ kind: 'genesis', writer: 'b' }, { kind: 'join', name: 'a' }];
    while (out.length < capFrom - MY_PATHS_LOOKBACK) out.push(commit({ writer: 'b' }));
    out.push(commit({ writer: 'a', cs: [{ csId: `${m.get('a')!}/human/1`, paths: ['src/x.ts'] }] }));   // height capFrom − 1,024
    out.push(commit({ writer: 'a', cs: [{ csId: `${m.get('a')!}/human/2`, paths: ['src/y.ts'] }] }));   // height capFrom − 1,023
    while (out.length <= capFrom) out.push(commit({ writer: 'b' }));
    out.push(commit({ writer: 'b', cs: [{ csId: `${m.get('b')!}/human/1`, paths: ['src/x.ts', 'src/y.ts'] }] }));
    return out;
  });
  assert.equal(steps[capFrom - MY_PATHS_LOOKBACK]!.data.cs[0]!.csId.endsWith('/human/1'), true);
  const r = batchReport(start, steps, { from: 1, you: ids.get('a')!, capFrom });
  assert.deepEqual([r.from, r.truncatedFrom, r.you.touches.map((t) => t.params['path'])], [1, capFrom, ['src/y.ts']]);
});

test('sinceFinish sets truncatedFrom only when capFrom truncates the range (capFrom > from): a capFrom at or below from gives the uncapped report (final review M13)', () => {
  const sim = sbSteps(SB_SEED, sbF04({ aCsAt8: true }));
  const acc = sim.steps.reduce(sincePush, sinceInit(sim.start, 10, sbF04Peers().a.peer, []));
  const full = sbF04Golden({ aCsAt8: true });
  for (const capFrom of [10, 9, -1]) assert.deepEqual(sinceFinish(acc, capFrom), full, `capFrom ${capFrom}`);
  assert.equal(sinceFinish(acc, 11).truncatedFrom, 11);
});

test('TERMINAL_HOLD_STATES (report.ts\'s copy: src/holds sits after src/since) equals src/holds/record.ts TERMINAL_STATES (final review M7)', () => {
  assert.deepEqual([...TERMINAL_HOLD_STATES].sort(byUnits), [...TERMINAL_STATES].sort(byUnits));
  assert.equal(TERMINAL_HOLD_STATES.size, TERMINAL_STATES.size);
});

test('sincePush never mutates its accumulator or its step (deep-frozen inputs), and a finished accumulator can be pushed further', () => {
  const sim = sbSteps(SB_SEED, sbF04({ aCsAt8: true, cFirst: true }));
  const freeze = <T>(o: T): T => {
    if (o !== null && typeof o === 'object' && !Object.isFrozen(o) && !Buffer.isBuffer(o)) {
      Object.freeze(o);
      for (const v of Object.values(o as object)) freeze(v);
    }
    return o;
  };
  const steps = sim.steps.map((s) => freeze({ data: { ...s.data, csPaths: s.data.csPaths }, verdicts: s.verdicts, after: s.after }));
  let acc = sinceInit(freeze(sim.start), 10, sbF04Peers().a.peer, freeze([...SB_MINE]));
  const seen: string[] = [];
  for (const s of steps) {
    const next = sincePush(acc, s);
    assert.notEqual(next, acc);
    seen.push(canon(sinceFinish(acc, null)));
    acc = next;
  }
  assert.equal(canon(sinceFinish(acc, null)), canon(sbF04Golden({ aCsAt8: true, cFirst: true })));
  // Re-finishing every earlier accumulator gives the same bytes again.
  let again = sinceInit(sim.start, 10, sbF04Peers().a.peer, [...SB_MINE]);
  steps.forEach((s, i) => {
    assert.equal(canon(sinceFinish(again, null)), seen[i]);
    again = sincePush(again, s);
  });
});

test('sinceInit with o.verifiedLabel absent gives byte-identical reports to a lookup that returns null for every id', () => {
  const calls: string[] = [];
  const lookup = (claimId: string, anchor: string): null => {
    calls.push(`${claimId} ${anchor}`);
    return null;
  };
  const variants: SbF04Variant[] = [{}, { aCsAt8: true }, { boardOnlyRepeat: true }, { bigGroupOfC: true, aCsAt8: true }, { cFirst: true }, { cOnMyRecords: true }];
  for (const v of variants) {
    const sim = sbSteps(SB_SEED, sbF04(v));
    const o = { from: 10, you: sbF04Peers().a.peer, mine: SB_MINE };
    assert.equal(canon(batchReport(sim.start, sim.steps, o)), canon(batchReport(sim.start, sim.steps, { ...o, label: lookup })), JSON.stringify(v));
  }
  const sim = sbSteps('since-v6', sbRandom('since-v6', 600));
  const you = sbPeerIds('since-v6', ['b', 'c', 'a', 'd']).get('a')!.peer;
  for (const capFrom of [null, 300]) {
    const o = { from: 100, you, capFrom };
    assert.equal(canon(batchReport(sim.start, sim.steps, o)), canon(batchReport(sim.start, sim.steps, { ...o, label: lookup })));
  }
  // F04-a: no folded claim carries a label before Plan 4 (claims are empty in Plan 2), so the slot is wired and never called.
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------------------------------------------------------
// L-PURE (11-testing §3.10, rev 2.5): src/since/** except walk.ts, and src/data/zone.ts, load no Node module and nothing under
// src/ports, src/git or src/engine — checked over the whole run-time import closure (type-only imports load nothing). The
// roots are every file under src/since but walk.ts, listed from the disk (final review M5), so a file a later plan adds is
// checked whether or not anything imports it yet. The two exceptions (F04-a Task A3 fix r1 ruling; spec-edit "src/since/** is
// pure except walk.ts (git) and cli.ts (CliEnv I/O)"): walk.ts, the one file of src/since that reads git, is no root; and
// cli.ts, which does its I/O through the CliEnv ports it is handed, may itself load node:path (pure path arithmetic) and
// walk.ts, but nothing else of Node and nothing under src/git, src/engine or src/ports, so every git call of `since` goes
// through walk.ts. cli.ts's exception is its own: a module it loads gets none of it (final review M5).

const FORBIDDEN_DIRS = ['src/git/', 'src/engine/', 'src/ports/'];
const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** The specifiers a module loads at run time: imports and re-exports that are not type-only, import-equals, require() and import(). */
function valueImports(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const lit = (e: ts.Expression | undefined): string => (e !== undefined && ts.isStringLiteralLike(e) ? e.text : '<non-literal>');
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      const named = c?.namedBindings;
      const typeOnly = c !== undefined && (c.isTypeOnly
        || (c.name === undefined && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) out.push(lit(n.moduleSpecifier));
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined) {
      const ec = n.exportClause;
      const typeOnly = n.isTypeOnly || (ec !== undefined && ts.isNamedExports(ec) && ec.elements.length > 0 && ec.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) out.push(lit(n.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      if (!n.isTypeOnly) out.push(lit(n.moduleReference.expression));
    } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      out.push(lit(n.arguments[0]));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** An exception to L-PURE for one file: Node modules that file itself may load (by specifier), and files it may load without their closure being walked. */
interface LPureAllow { readonly node?: readonly string[]; readonly boundary?: readonly string[]; }
/**
 * The exceptions, by the file that imports (final review M5: an exception is that file's alone, never its closure's). cli.ts may
 * load node:path, and walk.ts as the boundary (the git reader; its own imports are not cli.ts's). Its import of 8a's CliEnv
 * (src/viz/cli/view.ts) is type-only and loads nothing, as every type-only import, so it needs no entry (R-V54 allows it).
 */
const L_PURE_ALLOW: ReadonlyMap<string, LPureAllow> = new Map([['src/since/cli.ts', { node: ['node:path'], boundary: ['src/since/walk.ts'] }]]);

/**
 * The L-PURE findings of the run-time import closure of `roots` (repo-relative): a Node built-in, a package, a non-literal
 * specifier or a module under src/git, src/engine or src/ports, each with the chain that loads it. `read` gives a file's text.
 * `allow` maps a file to its exception: the Node modules it names are not flagged when that file loads them, and the boundary
 * files it names are not walked when that file loads them; a file `allow` does not name has no exception, whoever loads it.
 */
function lPure(roots: readonly string[], read: (rel: string) => string, allow: ReadonlyMap<string, LPureAllow> = new Map()): string[] {
  const findings: string[] = [];
  const seen = new Set<string>();
  const walk = (rel: string, chain: readonly string[]): void => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const own = allow.get(rel) ?? {};
    for (const spec of valueImports(rel, read(rel))) {
      const via = [...chain, rel].join(' → ');
      if (own.node?.includes(spec) === true) continue;
      if (spec.startsWith('node:') || BUILTINS.has(spec)) { findings.push(`${via}: Node module "${spec}"`); continue; }
      if (!spec.startsWith('.')) { findings.push(`${via}: module "${spec}"`); continue; }
      const target = relative(REPO, resolve(REPO, dirname(rel), spec)).split('\\').join('/').replace(/\.js$/, '.ts');
      if (FORBIDDEN_DIRS.some((d) => target.startsWith(d))) { findings.push(`${via}: ${target}`); continue; }
      if (own.boundary?.includes(target) === true) continue;
      walk(target, [...chain, rel]);
    }
  };
  for (const r of roots) walk(r, []);
  return findings;
}

const fromDisk = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

/** Every file under src/since (src/since/**), repository-relative with '/'. */
function sinceFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(REPO, ...rel.split('/')), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('src/since');
  return out.sort(byUnits);
}

/** L-PURE's roots among `files`: every .ts file under src/since/ except walk.ts (the git reader), then src/data/zone.ts. */
function lPureRoots(files: readonly string[]): string[] {
  return [...files.filter((f) => f.startsWith('src/since/') && f.endsWith('.ts') && f !== 'src/since/walk.ts'), 'src/data/zone.ts'];
}

test('L-PURE: every file of src/since/** except walk.ts, and src/data/zone.ts, loads no Node module and nothing from src/git, src/engine or src/ports; cli.ts alone may load node:path and walk.ts (final review M5)', () => {
  const files = sinceFiles();
  const roots = lPureRoots(files);
  assert.ok(files.includes('src/since/walk.ts') && !roots.includes('src/since/walk.ts'), 'walk.ts, the git reader, is no root');
  for (const f of ['src/since/report.ts', 'src/since/cli.ts', 'src/data/zone.ts']) assert.ok(roots.includes(f), f);
  assert.deepEqual(lPure(roots, fromDisk, L_PURE_ALLOW), []);
  // A file a later plan adds under src/since is a root of its own, imported or not, at any depth; walk.ts's exception and
  // cli.ts's are theirs alone.
  const added = new Map<string, string>([
    ['src/since/fresh.ts', "import { readFileSync } from 'node:fs';\nexport const n = readFileSync.length;\n"],
    ['src/since/deep/more.ts', "import { join } from 'node:path';\nimport { openBoard } from '../walk.js';\nexport const m = [join, openBoard];\n"],
  ]);
  const read = (rel: string): string => added.get(rel) ?? fromDisk(rel);
  const found = lPure(lPureRoots([...files, ...added.keys()]), read, L_PURE_ALLOW);
  for (const f of [
    'src/since/fresh.ts: Node module "node:fs"',
    'src/since/deep/more.ts: Node module "node:path"',
    'src/since/deep/more.ts → src/since/walk.ts: Node module "node:path"',
    'src/since/deep/more.ts → src/since/walk.ts: src/git/repo.ts',
  ]) assert.ok(found.includes(f), `${f} in\n${found.join('\n')}`);
  // Only the two added files are flagged: the real files stay clean.
  assert.deepEqual([...new Set(found.map((f) => f.split(/[: ]/)[0]))].sort(byUnits), ['src/since/deep/more.ts', 'src/since/fresh.ts']);
});

test('L-PURE: src/since/report.ts imports no node:* module and nothing from src/git, src/engine or src/ports values', () => {
  assert.deepEqual(lPure(['src/since/report.ts'], fromDisk), []);
  // The shared area module report.ts uses is pure too (11-testing §3.10; F04-a ledger carry from Task A1).
  assert.deepEqual(lPure(['src/data/zone.ts'], fromDisk), []);
  assert.ok(valueImports('src/since/report.ts', fromDisk('src/since/report.ts')).includes('../data/zone.js'), 'report.ts uses the shared zone()');
  // The check itself: each forbidden load is found, directly or through a module, and type-only imports pass.
  const fake = new Map<string, string>([
    ['src/since/fake.ts', [
      "import type { Oid } from '../git/oid.js';",
      "import { type GitRepo } from '../git/repo.js';",
      "export type { Clock } from '../ports/clock.js';",
      "import { isOid } from '../git/oid.js';",
      "import { readFileSync } from 'node:fs';",
      "import os from 'os';",
      "export { realClock } from '../ports/clock.js';",
      "import { via } from './helper.js';",
      "const m = await import('../engine/meta.js');",
    ].join('\n')],
    ['src/since/helper.ts', "import { randomHex } from '../ports/random.js';\nexport const via = 1;"],
  ]);
  assert.deepEqual(lPure(['src/since/fake.ts'], (rel) => fake.get(rel)!), [
    'src/since/fake.ts: src/git/oid.ts',
    'src/since/fake.ts: Node module "node:fs"',
    'src/since/fake.ts: Node module "os"',
    'src/since/fake.ts: src/ports/clock.ts',
    'src/since/fake.ts → src/since/helper.ts: src/ports/random.ts',
    'src/since/fake.ts: src/engine/meta.ts',
  ]);
});

test('L-PURE: src/since/cli.ts loads node:path and walk.ts but no other Node module and nothing from src/git, src/engine or src/ports', () => {
  assert.deepEqual(lPure(['src/since/cli.ts'], fromDisk, L_PURE_ALLOW), []);
  assert.ok(valueImports('src/since/cli.ts', fromDisk('src/since/cli.ts')).includes('./walk.js'), 'cli.ts reaches git through walk.ts');
  // The rule itself: cli.ts's own node:path passes and its own walk.ts import is not walked, but another Node module, a
  // src/git, src/engine or src/ports load of cli.ts itself is still found — and a module cli.ts loads has no exception at
  // all (final review M5): its node:path is a finding, and its walk.ts import is walked like any other.
  const fake = new Map<string, string>([
    ['src/since/cli.ts', [
      "import { posix } from 'node:path';",
      "import { openBoard } from './walk.js';",
      "import { via } from './helper.js';",
      "import { createGitRunner } from '../git/runner.js';",
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'path';",
    ].join('\n')],
    ['src/since/walk.ts', "import { GitRepo } from '../git/repo.js';\nimport { join } from 'node:path';"],
    ['src/since/helper.ts', "import { realClock } from '../ports/clock.js';\nimport { posix } from 'node:path';\nimport { openBoard } from './walk.js';\nexport const via = 1;"],
  ]);
  assert.deepEqual(lPure(['src/since/cli.ts'], (rel) => fake.get(rel)!, L_PURE_ALLOW), [
    'src/since/cli.ts → src/since/helper.ts: src/ports/clock.ts',
    'src/since/cli.ts → src/since/helper.ts: Node module "node:path"',
    'src/since/cli.ts → src/since/helper.ts → src/since/walk.ts: src/git/repo.ts',
    'src/since/cli.ts → src/since/helper.ts → src/since/walk.ts: Node module "node:path"',
    'src/since/cli.ts: src/git/runner.ts',
    'src/since/cli.ts: Node module "node:fs"',
    'src/since/cli.ts: Node module "path"',
  ]);
  // Without the rule, walk.ts's git load and node:path are findings (the exception is cli.ts's alone).
  assert.deepEqual(lPure(['src/since/walk.ts'], (rel) => fake.get(rel)!), ['src/since/walk.ts: src/git/repo.ts', 'src/since/walk.ts: Node module "node:path"']);
  // The exception follows the file, not the walk's root: rooted at helper.ts, cli.ts's allowance does not apply to it.
  assert.deepEqual(lPure(['src/since/helper.ts'], (rel) => fake.get(rel)!, L_PURE_ALLOW).slice(0, 2), [
    'src/since/helper.ts: src/ports/clock.ts',
    'src/since/helper.ts: Node module "node:path"',
  ]);
});

test('the 300-path fixture really is over the Cowork-CS-Paths cap (glossary §5: lists only up to 256 paths)', () => {
  assert.equal(new Set([...many(299, 'big'), LOOP]).size, 300);
  const sim = sbSteps(SB_SEED, sbF04({ bigGroupOfC: true }));
  const big = sim.steps[18]!.data;
  assert.equal(big.cs.length, 1);
  assert.equal(big.cs[0]!.paths, 300);
  assert.equal(big.csPaths.size, 0);
});
