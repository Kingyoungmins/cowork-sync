// INV-NOLOSS against its mutants and plants (Plan 3 Task 15; 11-testing §3.4 INV-NOLOSS row, §3.9 M05, M06, M07, M19, M28; TC-TST-02
// form; TC-ENG-02 / TC-ENG-13 (M05 shape); TST-07; rulings R3-48, R3-50, R3-64). Each mutant runs in a scripted holds scenario that gives
// it something to lose, and the same script without the mutant passes. Under M05, M06 and M07 INV-NOLOSS (the only Plan 3 oracle here)
// names the lost marker. M19 and M28 are stopped by the engine's own HLD-19 assertion (HOLD_MASK_INVALID, R3-57) before any commit lands,
// so nothing is lost for INV-NOLOSS to name: their tests are titled and assert that observed behaviour, and carry the brief's INV-NOLOSS
// pairing as a todo subtest (controller ruling, fix round 1: the R3-50/T-09 pairing goes to the Plan 3 final review). The resurrection
// clause (R3-64) is made to fire by a plant: one oracle instance judged over a board sequence on one scratch remote. Real git against
// file:// bare remotes; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MutantId } from '../../src/engine/deps.js';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { alone, okOrFail, play, SIM_TIMEOUT, type Step } from '../helpers/holdsScript.js';
import { dropScratch, g, judge, liveRewritten, REFS, scratchRemote, viewOf, withoutRow } from '../helpers/nolossPlants.js';
import { dropArtifacts, observing, type Fired } from '../helpers/simOps.js';
import { holdsSetup, seedFilesPlan3 } from '../sim/generators.js';
import { runSim, type Oracle, type SimContext, type SimResult } from '../sim/harness.js';
import { findMarkers, MarkerModel, markerRun, type MarkerOwner } from '../sim/markers.js';
import { locateMarker, oracleNoloss } from '../sim/oracleNoloss.js';
import { currentRemoteDir, exitOracles } from '../sim/oracles.js';
import { seededRandom } from '../../src/ports/random.js';

const NS = RELEASE_NAMESPACE;
const T = { timeout: SIM_TIMEOUT };

/** seedFilesPlan3 plus m.txt: 45 LF rows `m row <k>` (the M19/M28 file). */
function seedWithM(seed: string): Record<string, Buffer> {
  const files = seedFilesPlan3(seededRandom(`${seed}/files`));
  files['m.txt'] = Buffer.from(Array.from({ length: 45 }, (_, k) => `m row ${k}\n`).join(''), 'utf8');
  return files;
}

interface Run { r: SimResult; markers: MarkerModel; fired: Map<string, Fired>; facts: Map<string, unknown>; }

/** A scripted holds run (crash rate 0) with `mutants`; `observe` wraps the oracles so the run never stops on them. */
async function scripted(seed: string, make: (markers: MarkerModel, facts: Map<string, unknown>) => Step[], o: { mutants?: readonly MutantId[]; oracles?: (markers: MarkerModel) => Oracle[]; observe?: boolean; quiescence?: boolean; seedFiles?: Record<string, Buffer>; peers?: number } = {}): Promise<Run> {
  const s = holdsSetup(seed, { script: [], ...(o.mutants === undefined ? {} : { mutants: new Set(o.mutants) }), ...(o.seedFiles === undefined ? {} : { seedFiles: o.seedFiles }), ...(o.peers === undefined ? {} : { peers: o.peers }) });
  const facts = new Map<string, unknown>();
  const steps = make(s.markers, facts);
  const options = { ...s.options, generator: play(steps, s.markers) };
  if (o.quiescence !== true) delete options.quiescence;
  const base = (o.oracles ?? ((m: MarkerModel) => [oracleNoloss(m, NS)]))(s.markers);
  const obs = o.observe === true ? observing(base) : { oracles: base, fired: new Map<string, Fired>() };
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, obs.oracles, options);
  return { r, markers: s.markers, fired: obs.fired, facts };
}

const lastMarker = (ctx: SimContext, kind: string, peer: string): string => {
  const e = [...ctx.opLog].reverse().find((x) => x.kind === kind && x.peer === peer && findMarkers(Buffer.from(x.detail, 'latin1')).length > 0);
  assert.ok(e !== undefined, `an op ${kind} by ${peer} with a marker`);
  const ms = findMarkers(Buffer.from(e.detail, 'latin1'));
  return ms[ms.length - 1]!;
};

/** A human deletes the row holding `m` from peer i's `path` (mtime on its virtual wall clock); `tell` notes it in the model as informed. */
function deleteRow(i: number, path: string, m: () => string, markers: MarkerModel | null): Step {
  return {
    probe: `delete ${path}`, run: async (ctx) => {
      const p = ctx.peers[i]!;
      const abs = join(p.dir, ...path.split('/'));
      const before = await readFile(abs);
      const mk = m();
      const rows = before.toString('latin1').split(/(?<=\n)/);
      assert.ok(rows.some((r) => r.includes(mk)), `${p.name}:${path} holds ${mk}`);
      await writeFile(abs, Buffer.from(rows.filter((r) => !r.includes(mk)).join(''), 'latin1'));
      const t = ctx.clocks.get(p.name)!.wallMs() / 1_000;
      await utimes(abs, t, t);
      if (markers !== null) markers.noteEdit(p.name, path, [], [mk], true, () => true);
      return mk;
    },
  };
}

const show = (x: Run): string => JSON.stringify({ failure: x.r.failure, fired: Object.fromEntries(x.fired), tail: x.r.opLog.slice(-6) });

// ---- TC-TST-02: the NOLOSS plant ---------------------------------------------------------------------------------------------

test('TC-TST-02 NOLOSS plant: deleting one unpublished marker row from its author\'s working file between two steps without telling the model fails INV-NOLOSS at that step naming the marker, while Plan 2\'s six stay green on that plant; Plan 2\'s non-FF board-move plant and a pushed-tree plant that appends one row do not fire INV-NOLOSS', T, async () => {
  const x = await scripted('holds-nl-tst02', (markers, facts) => [
    { rounds: 1 },
    { kind: 'edit_band', peer: 0, params: { insert: false } },
    { probe: 'mark', run: async (ctx) => { facts.set('m', lastMarker(ctx, 'edit_band', 'p0')); } },
    deleteRow(0, 'shared.txt', () => facts.get('m') as string, null),   // the plant: the model is not told
    { rounds: 12 },
    {
      probe: 'other plants', run: async (ctx) => {
        // Plan 2's non-FF board move (the same live code under a board commit that skips one first parent) and a pushed-tree plant that
        // appends one row to shared.txt: neither loses a marker.
        const others = modelWith(markers.run, [...markers.live()].filter(([mk]) => mk !== facts.get('m')));
        const dir = await scratchRemote(ctx, 'nonff');
        const tip = await g(dir, ['rev-parse', `${REFS.remoteBoard}^{commit}`]);
        const parents = (await g(dir, ['rev-list', '--no-walk', '--parents', '-n', '1', tip])).split(' ').slice(1);
        const grand = (await g(dir, ['rev-list', '--no-walk', '--parents', '-n', '1', parents[0]!])).split(' ').slice(1)[0]!;
        const moved = await g(dir, ['commit-tree', `${tip}^{tree}`, '-p', grand, '-p', parents[parents.length - 1]!, '-m', 'non-FF board move']);
        await g(dir, ['update-ref', REFS.remoteBoard, moved]);
        facts.set('nonff', await judge(oracleNoloss(others, NS), viewOf(ctx, { remoteDir: dir })));
        await dropScratch(dir);
        const dir2 = await scratchRemote(ctx, 'append');
        await liveRewritten(dir2, (path, bytes) => (path === 'shared.txt' ? Buffer.concat([bytes, Buffer.from('planted row\n', 'utf8')]) : undefined));
        facts.set('append', await judge(oracleNoloss(others, NS), viewOf(ctx, { remoteDir: dir2 })));
        await dropScratch(dir2);
      },
    },
  ], { observe: true, quiescence: true, oracles: (m) => [...exitOracles(), oracleNoloss(m, NS)] });
  await dropArtifacts(x.r);
  const m = x.facts.get('m') as string;
  const plantStep = x.r.opLog.find((e) => e.kind === 'probe' && e.detail.includes('delete shared.txt'))?.step;
  const f = x.fired.get('INV-NOLOSS');
  assert.ok(f !== undefined, `INV-NOLOSS fired: ${show(x)}`);
  assert.equal(f.step, plantStep, 'at the plant\'s step');
  assert.match(f.message, new RegExp(`marker ${m} \\(author p0, path shared\\.txt, written at step \\d+\\) is in no location`));
  assert.deepEqual([...x.fired.keys()], ['INV-NOLOSS'], `Plan 2's six stay green on that plant: ${show(x)}`);
  assert.equal(x.facts.get('nonff'), null, 'the non-FF board move loses no marker');
  assert.equal(x.facts.get('append'), null, 'the appended pushed row loses no marker');
});

/** A MarkerModel holding exactly `live` as obligations (a plant's model; the run's own model is never touched). */
function modelWith(run: string, live: ReadonlyArray<readonly [string, MarkerOwner]>): MarkerModel {
  const mm = new MarkerModel(run);
  for (const [m, o] of live) mm.noteEdit(o.peer, o.path, [m], [], true, () => false);
  return mm;
}

// ---- M19 and the re-add rule ----------------------------------------------------------------------------------------------------

/** Task 14's M19 scenario on m.txt, continued by an untainted p0 edit of row 20 and 12 rounds. */
function m19Steps(markers: MarkerModel, facts: Map<string, unknown>): Step[] {
  return [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'm.txt', insert: true, row: 10, n: 1, text: 'Y' } },
    { kind: 'edit_band', peer: 1, params: { path: 'm.txt', insert: true, row: 31, n: 1, text: 'Z' } },
    { probe: 'YZ', run: async (ctx) => {
      const ms = ctx.opLog.filter((e) => e.kind === 'edit_band' && e.peer === 'p1').map((e) => findMarkers(Buffer.from(e.detail, 'latin1'))[0]!);
      facts.set('Y', ms[0]);
      facts.set('Z', ms[1]);
    } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'm.txt', buffer: 'genesis' } },   // removes Y and Z: one revert PATCH
    ...alone(0, 14),
    deleteRow(1, 'm.txt', () => facts.get('Y') as string, markers),                   // p1 deletes Y: informed, Y retired
    ...alone(1, 12),
    ...alone(0, 12),                                                                    // p0 applies: REBASE clean, the record over Z only
    { probe: 'record', run: async (ctx) => {
      const e = ctx.engines[0]!;
      const hs = (await e.inspect!()).holds.filter((r) => r.guards.some((x) => x.name === 'revert'));
      facts.set('record', hs.map((r) => ({ state: r.state, rev: r.rev })));
    } },
    { kind: 'edit_own', peer: 0, params: { path: 'm.txt', row: 20, text: 'm row 20 p0 untainted' } },
    { rounds: 12 },
    outcome(facts, 'edit_own', () => facts.get('Y') as string),
  ];
}

/**
 * What p0's step-5 mutant came to: the HLD-19 clauses p0's daemon log raised HOLD_MASK_INVALID with (R3-20, R3-57), and whether p0's last
 * untainted edit (`kind`'s marker) reached live_code — a P built under the mutant landed only if it did.
 */
function outcome(facts: Map<string, unknown>, kind: string, watch?: () => string): Step {
  return {
    probe: 'outcome', run: async (ctx) => {
      const log = await readFile(join(ctx.peers[0]!.dir, '.git', 'cowork', 'log', 'daemon-0.jsonl'), 'utf8').catch(() => '');
      const clauses = log.split(/\r?\n/).filter((l) => l.length > 0).map((l) => JSON.parse(l) as { code: string; params?: Record<string, unknown> })
        .filter((l) => l.code === 'HOLD_MASK_INVALID').map((l) => String(l.params?.['clause'] ?? ''));
      facts.set('maskInvalid', [...new Set(clauses)]);
      const m = lastMarker(ctx, kind, 'p0');
      facts.set('untaintedLanded', (await locateMarker(ctx, NS, m, { peer: 'p0', path: 'm.txt' }, {}))?.at === 'live');
      if (watch !== undefined) facts.set('watchLive', (await locateMarker(ctx, NS, watch(), { peer: 'p2', path: 'm.txt' }, {}))?.at === 'live');
      return JSON.stringify({ clauses: [...new Set(clauses)], landed: facts.get('untaintedLanded') });
    },
  };
}

test('M19 is stopped by the engine\'s HLD-19 assertion before anything lands: Task 14\'s M19 scenario on m.txt (p1 adds Y at row 10 and Z at row 30; p0\'s stale save removes both into one revert PATCH; p1 deletes Y, an informed removal that retires Y\'s marker; p0 applies, REBASE clean, the record ACTIVE over Z only) continued by an untainted p0 edit of m.txt row 20 and {rounds: 12}: under M19 assertSPub refuses the mutant\'s S_pub (HOLD_MASK_INVALID reapply), no code commit of p0 lands, Y stays out of live_code and INV-NOLOSS stays green; with M19 off the untainted edit lands (the brief\'s INV-NOLOSS pairing is the todo subtest)', T, async (t) => {
  const control = await scripted('holds-nl-m19', m19Steps, { seedFiles: seedWithM('holds-nl-m19') });
  okOrFail(control.r);
  const y = control.facts.get('Y') as string;
  assert.ok(control.markers.retired().has(y), 'Y is retired');
  assert.deepEqual([control.facts.get('maskInvalid'), control.facts.get('untaintedLanded'), control.facts.get('watchLive')], [[], true, false],
    'with M19 off: no HLD-19 failure, p0\'s untainted row-20 edit lands, Y stays out of live_code');
  const m = await scripted('holds-nl-m19', m19Steps, { mutants: ['M19'], seedFiles: seedWithM('holds-nl-m19') });
  await dropArtifacts(m.r);
  // Observed on this engine (Task 15 report, a ruling is asked for): M19's step 5 from the unrebased pair re-adds Y in S_pub, and HLD-19's
  // assertSPub ('reapply': reapply(S_pub) != reapply(S_disk), R3-57) rejects it at every materialization, so EngineCore.maskInvalid stays
  // set and no code commit of p0 lands — Y never re-enters live_code. The engine's own assertion (and INV-MASK, Task 14) kills M19 before
  // anything lands; INV-NOLOSS, which judges landed content, stays green (no false positive) and has nothing to name.
  assert.ok(m.r.ok, `INV-NOLOSS stays green under M19: ${show(m)}`);
  assert.deepEqual(m.facts.get('maskInvalid'), ['reapply'], 'HOLD_MASK_INVALID {clause: reapply, path: m.txt}');
  assert.equal(m.facts.get('untaintedLanded'), false, 'no code commit of p0 landed under M19');
  assert.equal(m.facts.get('watchLive'), false, 'Y never re-entered live_code');
  await t.test('M19 fails INV-NOLOSS (resurrection clause): under M19 p0\'s P re-adds Y, the landed commit puts Y\'s retired marker back into live_code, and INV-NOLOSS (run as the only Plan 3 oracle) fails naming it (the brief\'s TC-TST-02 pairing)', {
    todo: 'unreachable on this engine: assertSPub (reapply) blocks every code commit under M19 before it lands (R3-57); the R3-50/T-09 pairing is carried to the Plan 3 final review (controller ruling, Task 15 fix round 1)',
  }, () => undefined);
});

test('resurrection clause stays quiet on legitimate re-adds: p1 deletes its row (marker retired), then p1\'s own rewind restores it (a noted stale re-add by the deleter, untainted, published) and, in a second run, p0\'s tainted stale re-add is released by resolve --publish; neither run fails INV-NOLOSS', T, async () => {
  const y = (seed: string): string => `CWM_${markerRun(seed)}_1_p1`;
  const one = await scripted('holds-nl-readd-1', (markers, facts) => [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'm.txt', insert: true, row: 10, n: 1, text: 'Y' } },
    { rounds: 12 },
    deleteRow(1, 'm.txt', () => y('holds-nl-readd-1'), markers),
    { rounds: 12 },
    { probe: 'left', run: async (ctx) => { facts.set('retired', markers.retired().has(y('holds-nl-readd-1'))); facts.set('leftLive', !(await liveHas(ctx, y('holds-nl-readd-1')))); } },
    { kind: 'rewind', peer: 1, params: { path: 'm.txt', buffer: `after:${y('holds-nl-readd-1')}` } },
    { rounds: 12 },
    { probe: 'back', run: async (ctx) => { facts.set('back', await liveHas(ctx, y('holds-nl-readd-1'))); facts.set('retiredAfter', markers.retired().has(y('holds-nl-readd-1'))); } },
  ], { seedFiles: seedWithM('holds-nl-readd-1') });
  okOrFail(one.r);
  assert.deepEqual([one.facts.get('retired'), one.facts.get('leftLive'), one.facts.get('back'), one.facts.get('retiredAfter')], [true, true, true, false], 'Y retired, left the board, re-added by p1\'s rewind and published');
  const two = await scripted('holds-nl-readd-2', (markers, facts) => [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'm.txt', insert: true, row: 10, n: 1, text: 'Y' } },
    { rounds: 12 },
    { kind: 'append_md', peer: 2 },   // any holds op: the rings record p0's m.txt holding Y (stale_save's 'after:' buffer)
    deleteRow(1, 'm.txt', () => y('holds-nl-readd-2'), markers),
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'm.txt', buffer: `after:${y('holds-nl-readd-2')}` } },   // p0's stale buffer re-adds Y
    ...alone(0, 14),
    { probe: 'tainted', run: async (ctx) => {
      const hs = (await ctx.engines[0]!.inspect!()).holds.filter((r) => r.guards.some((x) => x.name === 'revert') && r.paths.includes('m.txt'));
      facts.set('tainted', hs.map((r) => r.state));
    } },
    { kind: 'resolve', peer: 0, params: { verb: 'publish' } },
    { rounds: 12 },
    { probe: 'back', run: async (ctx) => { facts.set('back', await liveHas(ctx, y('holds-nl-readd-2'))); } },
  ], { seedFiles: seedWithM('holds-nl-readd-2') });
  okOrFail(two.r);
  assert.ok((two.facts.get('tainted') as string[]).length > 0, `p0's re-add is held as a revert: ${JSON.stringify(two.facts.get('tainted'))}`);
  assert.equal(two.facts.get('back'), true, 'released by resolve --publish: Y is live again');
});

/**
 * The resurrection plant (R3-64; controller ruling, fix round 1): p1 publishes a band row (marker m); a scratch copy of the remote is
 * judged by ONE oracle instance over ONE view, one probe step per board shape (each probe is a new op, so each judgment is a new check):
 * m live (seen as an obligation), then — m retired by p1's informed removal in the plant's own model — a tip still holding m, a tip whose
 * live code is rewritten without m's row, and a tip whose live code re-adds it. The run's own oracle and model are not touched.
 */
function resurrectSteps(markers: MarkerModel, facts: Map<string, unknown>): Step[] {
  const plant: { view: SimContext | null; dir: string | null; mm: MarkerModel | null; o: ReturnType<typeof oracleNoloss> | null; row: Buffer | null } = { view: null, dir: null, mm: null, o: null, row: null };
  const m = (): string => facts.get('m') as string;
  return [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { insert: false } },
    { rounds: 12 },
    {
      probe: 'seen live', run: async (ctx) => {
        facts.set('m', lastMarker(ctx, 'edit_band', 'p1'));
        facts.set('liveAtRun', (await locateMarker(ctx, NS, m(), { peer: 'p1', path: 'shared.txt' }, {}))?.at ?? null);
        plant.dir = await scratchRemote(ctx, 'resurrect');
        plant.view = viewOf(ctx, { remoteDir: plant.dir });
        plant.mm = modelWith(markers.run, [[m(), { peer: 'p1', path: 'shared.txt' }]]);
        plant.o = oracleNoloss(plant.mm, NS);
        facts.set('seen', await judge(plant.o, plant.view));
        facts.set('seenAt', plant.o.locations(plant.view).get(m())?.at ?? null);
        // p1's informed removal (its A and disk held m): retired in the plant's model.
        plant.mm.noteEdit('p1', 'shared.txt', [], [m()], true, () => true);
        facts.set('retired', plant.mm.retired().has(m()) && !plant.mm.live().has(m()));
      },
    },
    {
      probe: 'tip still holds the retired marker', run: async () => {
        facts.set('held', await judge(plant.o!, plant.view!));
        await liveRewritten(plant.dir!, (path, bytes) => {
          if (path !== 'shared.txt' || !bytes.includes(m())) return undefined;
          plant.row = bytes;
          return withoutRow(bytes, m());
        });
      },
    },
    {
      probe: 'tip without it', run: async () => {
        facts.set('left', await judge(plant.o!, plant.view!));
        await liveRewritten(plant.dir!, (path) => (path === 'shared.txt' ? plant.row! : undefined));
      },
    },
    {
      probe: 'tip re-adds it', run: async () => {
        facts.set('readded', await judge(plant.o!, plant.view!));
        await dropScratch(plant.dir!);
      },
    },
  ];
}

test('resurrection clause fires (R3-64 plant): one INV-NOLOSS instance judged on one scratch remote after a marker\'s retirement over a board tip still holding it, a tip without it and a tip whose live code re-adds it passes the first two and fails the third, naming the marker, its author, path, the step it was written and the last location it was seen at', T, async () => {
  const x = await scripted('holds-nl-resurrect', resurrectSteps);
  okOrFail(x.r);
  const m = x.facts.get('m') as string;
  assert.deepEqual([x.facts.get('liveAtRun'), x.facts.get('seen'), x.facts.get('seenAt'), x.facts.get('retired')], ['live', null, 'live', true], 'm published, seen live by the plant oracle, then retired');
  assert.equal(x.facts.get('held'), null, 'a retired marker still in live_code is not a resurrection');
  assert.equal(x.facts.get('left'), null, 'the board leaving a retired marker loses nothing');
  assert.match(String(x.facts.get('readded') ?? ''), new RegExp(`^INV-NOLOSS \\(resurrection, R3-64\\): retired marker ${m} \\(author p1, path shared\\.txt, written at step \\d+; last seen at live \\(live shared\\.txt @ [0-9a-f]{12}\\)\\) reappears in live_code of board [0-9a-f]{12} \\(shared\\.txt\\) after the board had left it`));
});

async function liveHas(ctx: SimContext, m: string): Promise<boolean> {
  return (await locateMarker(ctx, NS, m, { peer: 'p1', path: 'm.txt' }, {}))?.at === 'live';
}

// ---- M28 -----------------------------------------------------------------------------------------------------------------------

function m28Steps(markers: MarkerModel, facts: Map<string, unknown>): Step[] {
  return [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'm.txt', insert: false, row: 21, text: 'p1 line 21' } },
    { kind: 'edit_band', peer: 1, params: { path: 'm.txt', insert: false, row: 22, text: 'p1 line 22' } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'm.txt', buffer: 'genesis' } },   // rows 21–22 back to genesis: a revert PATCH
    ...alone(0, 14),
    {
      probe: 'p2 inserts', run: async (ctx) => {
        // p2 inserts three marker rows after row 19 (rows 20–22), each with its own fresh marker.
        const p = ctx.peers[2]!;
        const abs = join(p.dir, 'm.txt');
        const before = await readFile(abs);
        const rows = before.toString('latin1').split(/(?<=\n)/);
        const ms = [markers.mint('p2'), markers.mint('p2'), markers.mint('p2')];
        rows.splice(20, 0, ...ms.map((m, k) => `p2 ins ${k + 1} ${m}\n`));
        const after = Buffer.from(rows.join(''), 'latin1');
        await writeFile(abs, after);
        const t = ctx.clocks.get(p.name)!.wallMs() / 1_000;
        await utimes(abs, t, t);
        markers.noteEdit('p2', 'm.txt', ms, [], true, () => false);
        facts.set('p2', ms);
        return ms.join(' ');
      },
    },
    ...alone(2, 12),
    ...alone(0, 12),
    { kind: 'edit_own', peer: 0, params: { path: 'm.txt', row: 43, text: 'm row 40 p0 untainted' } },
    { rounds: 12 },
    outcome(facts, 'edit_own', () => (facts.get('p2') as string[])[1]!),
  ];
}

test('M28 is stopped by the engine\'s HLD-19 assertion before anything lands: p0 holds a revert PATCH on rows 21–22 of m.txt (p1\'s lines replaced by the genesis rows); p2 inserts 3 marker rows after row 19 and publishes; p0 applies and captures an untainted row-40 edit; under M28 step 5 puts H0\'s rows over p2\'s inserted rows in S_pub, assertSPub/assertP refuse it (HOLD_MASK_INVALID reapply or p_range), no code commit of p0 lands, p2\'s rows stay live and INV-NOLOSS stays green; with M28 off the untainted edit lands and p2\'s rows stay live (the brief\'s INV-NOLOSS pairing is the todo subtest)', T, async (t) => {
  const control = await scripted('holds-nl-m28', m28Steps, { seedFiles: seedWithM('holds-nl-m28') });
  okOrFail(control.r);
  assert.deepEqual([control.facts.get('maskInvalid'), control.facts.get('untaintedLanded'), control.facts.get('watchLive')], [[], true, true],
    'with M28 off: no HLD-19 failure, p0\'s untainted row-40 edit lands, p2\'s inserted rows stay live');
  const m = await scripted('holds-nl-m28', m28Steps, { mutants: ['M28'], seedFiles: seedWithM('holds-nl-m28') });
  await dropArtifacts(m.r);
  // Observed on this engine (Task 15 report, a ruling is asked for): M28's positional step 5 puts H0's rows over p2's inserted rows in
  // S_pub, and HLD-19's assertSPub ('reapply', R3-57; assertP's 'p_range' on a composition) refuses it, so no code commit of p0 lands and
  // p2's rows are never lost: the mutant is killed by the engine's own assertion (and INV-MASK, Task 14) before INV-NOLOSS could see a loss.
  assert.ok(m.r.ok, `INV-NOLOSS stays green under M28: ${show(m)}`);
  const clauses = m.facts.get('maskInvalid') as string[];
  assert.ok(clauses.length > 0 && clauses.every((c) => c === 'reapply' || c === 'p_range'), `HOLD_MASK_INVALID raised: ${JSON.stringify(clauses)}`);
  assert.equal(m.facts.get('untaintedLanded'), false, 'no code commit of p0 landed under M28');
  assert.equal(m.facts.get('watchLive'), true, 'p2\'s inserted rows stay live');
  await t.test('M28 fails INV-NOLOSS: under M28 step 5 writes H0\'s rows at positions 21–22 over p2\'s 2nd and 3rd inserted rows, P publishes their loss, and INV-NOLOSS fails naming those markers once p2 applies (the brief\'s TC-TST-02 pairing)', {
    todo: 'unreachable on this engine: HLD-19 (assertSPub reapply / assertP p_range) blocks every code commit under M28 before it lands (R3-57); the R3-50/T-09 pairing is carried to the Plan 3 final review (controller ruling, Task 15 fix round 1)',
  }, () => undefined);
});

// ---- M05, M06, M07 (Plan 2's sites) ---------------------------------------------------------------------------------------------

/**
 * M05's only site is join (src/engine/start.ts: A := tree(HEAD), the mutant A := tree(TIP)); a restart reads A from the state ref, so the
 * TC-ENG-13 shape is played on p0's join: p0 holds an unpublished own row (m0) before its first start, p1 has published a row 10 lines
 * away (m1), p0 joins and is killed at join.first_apply (KilledAt), restarts and publishes m0's row.
 */
function m05Steps(_markers: MarkerModel, facts: Map<string, unknown>): Step[] {
  return [
    { iterate: 1 },                                                      // p1: genesis
    { kind: 'edit_band', peer: 1, params: { insert: false, row: 14, text: 'shared band 1 row 4 (14) p1' } },
    ...alone(1, 12),                                                     // p1 publishes m1
    { kind: 'edit_band', peer: 0, params: { insert: false, row: 4, text: 'shared band 0 row 4 (04) p0' } },   // p0's unpublished m0
    {
      probe: 'join, killed', run: async (ctx) => {
        let killed = false;
        const prev = setCrashHandler((name) => {
          if (!killed && name === 'join.first_apply') {
            killed = true;
            throw new KilledAt(name);
          }
        });
        try {
          await ctx.engines[0]!.step(ctx);
        } finally {
          setCrashHandler(prev);
        }
        facts.set('killed', killed);
        return `killed=${killed}`;
      },
    },
    { advance: 2_500 },
    { iterate: 0 },                                                      // the restart
    ...alone(0, 14),
    { rounds: 8 },
    {
      probe: 'live', run: async (ctx) => {
        const m1 = lastMarker(ctx, 'edit_band', 'p1');
        const m0 = lastMarker(ctx, 'edit_band', 'p0');
        facts.set('m1', m1);
        facts.set('live', [(await locateMarker(ctx, NS, m0, { peer: 'p0', path: 'shared.txt' }, {}))?.at, (await locateMarker(ctx, NS, m1, { peer: 'p1', path: 'shared.txt' }, {}))?.at]);
      },
    },
  ];
}

test('M05 fails INV-NOLOSS: a restart that seeds A from TIP loses a teammate\'s marker', T, async () => {
  const control = await scripted('holds-nl-m05', m05Steps, { peers: 2 });
  okOrFail(control.r);
  assert.equal(control.facts.get('killed'), true, 'p0 was killed at join.first_apply');
  assert.deepEqual(control.facts.get('live'), ['live', 'live'], 'with M05 off both markers are live');
  const m = await scripted('holds-nl-m05', m05Steps, { peers: 2, mutants: ['M05'] });
  await dropArtifacts(m.r);
  const m1 = control.facts.get('m1') as string;   // the same seed and script mint the same markers
  assert.equal(m.r.failure?.oracle, 'INV-NOLOSS', show(m));
  assert.match(m.r.failure!.message, new RegExp(`marker ${m1} \\(author p1, path shared\\.txt`), show(m));
});

function m06Steps(_markers: MarkerModel, facts: Map<string, unknown>): Step[] {
  return [
    { rounds: 1 },
    { kind: 'edit_band', peer: 0, params: { insert: false, row: 4, text: 'shared band 0 row 4 (04) p0' } },
    { kind: 'lock_share_read', peer: 0, params: { path: 'shared.txt' } },   // p0's apply of shared.txt defers; its snapshot still reads it
    { kind: 'edit_band', peer: 1, params: { insert: false, row: 14, text: 'shared band 1 row 4 (14) p1' } },
    ...alone(1, 12),                                                        // p1 publishes m1
    ...alone(0, 14),                                                        // p0 publishes its CS before it applies m1
    { kind: 'unlock', peer: 0 },
    { rounds: 8 },
    {
      probe: 'live', run: async (ctx) => {
        const m1 = lastMarker(ctx, 'edit_band', 'p1');
        const m0 = lastMarker(ctx, 'edit_band', 'p0');
        facts.set('m1', m1);
        facts.set('live', [(await locateMarker(ctx, NS, m0, { peer: 'p0', path: 'shared.txt' }, {}))?.at, (await locateMarker(ctx, NS, m1, { peer: 'p1', path: 'shared.txt' }, {}))?.at]);
      },
    },
  ];
}

test('M06 fails INV-NOLOSS: a raw snapshot pushed on top of TIP drops an unapplied teammate marker', T, async () => {
  const control = await scripted('holds-nl-m06', m06Steps);
  okOrFail(control.r);
  assert.deepEqual(control.facts.get('live'), ['live', 'live'], 'with M06 off p0\'s publish is the merge and both rows land');
  const m1 = control.facts.get('m1') as string;
  const m = await scripted('holds-nl-m06', m06Steps, { mutants: ['M06'] });
  await dropArtifacts(m.r);
  assert.equal(m.r.failure?.oracle, 'INV-NOLOSS', show(m));
  assert.match(m.r.failure!.message, new RegExp(`marker ${m1} \\(author p1, path shared\\.txt`), show(m));
});

/** The remote's board and code refs moved back past p1's landed publish (a host rewrite fault), then p1, p0 and p2 iterate once. */
function rewindPastP1(): Step {
  return {
    probe: 'rewind', run: async (ctx) => {
      const p1 = [...ctx.trace.names].find(([, n]) => n === 'p1')![0];
      const pub = ctx.trace.ofKind('publish').filter((e) => e.peer === p1 && e.c !== null);
      const landed = new Set(ctx.trace.ofKind('push').filter((e) => e.peer === p1 && e.outcome === 'landed').map((e) => e.bnew));
      const last = [...pub].reverse().find((e) => landed.has(e.bnew))!;
      const dir = await currentRemoteDir(ctx);
      const prevBoard = (await g(dir, ['rev-list', '--no-walk', '--parents', '-n', '1', last.bnew])).split(' ')[1]!;
      const prevParents = (await g(dir, ['rev-list', '--no-walk', '--parents', '-n', '1', prevBoard])).split(' ').slice(1);
      await g(dir, ['update-ref', REFS.remoteBoard, prevBoard]);
      await g(dir, ['update-ref', REFS.remoteCode, prevParents[prevParents.length - 1]!]);
      for (const e of [...ctx.engines].sort((a, b) => (a.peer.name < b.peer.name ? -1 : 1))) {
        for (const c of ctx.clocks.values()) c.advance(2_500);
        await e.step(ctx);
      }
      return `board -> ${prevBoard}`;
    },
  };
}

function m07Steps(_markers: MarkerModel, facts: Map<string, unknown>): Step[] {
  return [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { insert: false, row: 14, text: 'shared band 1 row 4 (14) p1' } },
    ...alone(1, 12),
    { rounds: 4 },
    { probe: 'm1', run: async (ctx) => { facts.set('m1', lastMarker(ctx, 'edit_band', 'p1')); facts.set('mark', ctx.trace.events.length); } },
    rewindPastP1(),
    { kind: 'edit_band', peer: 0, params: { insert: false, row: 4, text: 'shared band 0 row 4 (04) p0' } },
    { rounds: 12 },
    {
      probe: 'after', run: async (ctx) => {
        const mark = facts.get('mark') as number;
        facts.set('incidents', ctx.trace.since(mark).filter((e) => e.kind === 'incident').length);
        facts.set('publishedOnRewind', ctx.trace.since(mark).filter((e) => e.kind === 'push' && e.purpose === 'publish' && e.outcome === 'landed').length);
        facts.set('m1At', (await locateMarker(ctx, NS, facts.get('m1') as string, { peer: 'p1', path: 'shared.txt' }, {}))?.at ?? null);
      },
    },
  ];
}

test('M07 fails INV-NOLOSS: an undetected board rewind drops a marker', T, async () => {
  const control = await scripted('holds-nl-m07', m07Steps);
  okOrFail(control.r);
  assert.ok((control.facts.get('incidents') as number) > 0, 'with M07 off the rewind raises INCIDENT');
  assert.equal(control.facts.get('publishedOnRewind'), 0, 'and nothing publishes on it');
  assert.equal(control.facts.get('m1At'), 'author_disk', 'the marker stays accounted for on its author\'s disk');
  const m1 = control.facts.get('m1') as string;
  const m = await scripted('holds-nl-m07', m07Steps, { mutants: ['M07'] });
  await dropArtifacts(m.r);
  assert.equal(m.r.failure?.oracle, 'INV-NOLOSS', show(m));
  assert.match(m.r.failure!.message, new RegExp(`marker ${m1} \\(author p1, path shared\\.txt`), show(m));
});
