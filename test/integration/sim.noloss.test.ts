// INV-NOLOSS against the real engine (Plan 3 Task 15; 11-testing §3.4 INV-NOLOSS, TST-07, TST-08; 05-holds §5 INV-NOLOSS harness
// extension, INV-HLD-DURABLE, I11 shape; 03-data P-DAT-05, D-26, DAT-43; 05 §7 P7 (Plan 3 subset); rulings R3-28, R3-29, R3-48, R3-49,
// R3-55). Real git against file:// bare remotes; git is never mocked.
//
// Most tests here judge the oracle on one shared scripted holds run (scenario S, run once and memoized): its probes record what
// locateMarker answers at each shape and run planted variants — a scratch copy of the remote with the board tip rewritten, an edited
// trace, an inspect() wrapper, a second MarkerModel — through a fresh oracleNoloss; each test then asserts its part. The long seeds run
// their first seed under `npm test` and all of them under `npm run test:sim` (TEST_SIM_FULL=1, R3-55).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stageable } from '../../src/engine/stagedRead.js';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import { isTerminal, type HoldRecord } from '../../src/holds/record.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { alone, engineAt, has, holdsOf, okOrFail, play, SIM_TIMEOUT, until, type Step } from '../helpers/holdsScript.js';
import { boardWithoutHeld, d26Steps, dropScratch, g, judge, liveRewritten, REFS, scratchRemote, traceView, viewOf, withInspect, withoutRow } from '../helpers/nolossPlants.js';
import { currentRemoteDir } from '../sim/oracles.js';
import { dropArtifacts, observing } from '../helpers/simOps.js';
import { seededRandom } from '../../src/ports/random.js';
import { realEngine } from '../sim/engineAdapter.js';
import { editGenerator, holdsSetup, hostNames, PROFILES, seedFilesPlan2 } from '../sim/generators.js';
import { DEFAULT_QUIESCENCE, runSim, type Oracle, type SimContext, type SimResult } from '../sim/harness.js';
import { readRegistry } from '../sim/holdsView.js';
import { findMarkers, MarkerModel, markerRun, type MarkerOwner } from '../sim/markers.js';
import { locateMarker, oracleNoloss, twoStores, type NolossFound } from '../sim/oracleNoloss.js';

const NS = RELEASE_NAMESPACE;
const FULL = process.env['TEST_SIM_FULL'] === '1';

const ownerOf = (markers: MarkerModel, m: string): MarkerOwner => {
  const o = markers.live().get(m);
  assert.ok(o !== undefined, `${m} is an obligation`);
  return o;
};
const locate = (ctx: SimContext, markers: MarkerModel, m: string): Promise<NolossFound | null> => locateMarker(ctx, NS, m, ownerOf(markers, m), {});
const lastMarker = (ctx: SimContext, kind: string, peer: string): string => {
  const e = [...ctx.opLog].reverse().find((x) => x.kind === kind && x.peer === peer && findMarkers(Buffer.from(x.detail, 'latin1')).length > 0);
  assert.ok(e !== undefined, `an op ${kind} by ${peer} with a marker`);
  const ms = findMarkers(Buffer.from(e.detail, 'latin1'));
  return ms[ms.length - 1]!;
};
const recordsOf = async (ctx: SimContext, i: number): Promise<HoldRecord[]> => (await holdsOf(ctx, i)).filter((r) => !isTerminal(r));
const blobsHold = async (ctx: SimContext, i: number, side: Record<string, string> | undefined, m: string): Promise<boolean> => {
  for (const oid of Object.values(side ?? {})) {
    if (oid === 'ABSENT') continue;
    const r = await ctx.git.run(['cat-file', 'blob', oid], { class: 'local', cwd: ctx.peers[i]!.dir });
    if (r.code === 0 && findMarkers(r.stdout).includes(m)) return true;
  }
  return false;
};
/** A MarkerModel holding exactly `live` as obligations (a plant's model; the run's own model is never touched). */
function modelWith(run: string, live: ReadonlyArray<readonly [string, MarkerOwner]>): MarkerModel {
  const mm = new MarkerModel(run);
  for (const [m, o] of live) mm.noteEdit(o.peer, o.path, [m], [], true, () => false);
  return mm;
}

// ---- scenario S ------------------------------------------------------------------------------------------------------------

interface ScenarioS {
  r: SimResult;
  markers: MarkerModel;
  /** Location answers by label. */
  at: Map<string, NolossFound | null>;
  /** Plant verdicts by label (null = the oracle passed). */
  plant: Map<string, string | null>;
  /** Facts the probes asserted or recorded. */
  facts: Map<string, unknown>;
}

let scenarioS: Promise<ScenarioS> | null = null;

/**
 * Scenario S: p0's fresh band edit (author_disk) then published (live); p1's band edit published; p0's portability record
 * (local_only_disk); exempt markers (temp_file, collide_ignored) whose files are then deleted; p2's unmaterializable INCOMING record (its window
 * before and after 60 s); a K4 over notes.txt row 4 on p0 while p0's pushes are rejected (registry), then 10 virtual minutes partitioned
 * (OFFLINE, registry), then healed (held, s2); window plants; p0's revert PATCH discarded (RESOLVED_DISCARD) and the discard-accounting
 * plants; p1's informed replacement of its own band row (retired) and its stale twin; the published-CS plant; the two-stores plants.
 */
function runScenarioS(): Promise<ScenarioS> {
  scenarioS ??= (async () => {
    const s = holdsSetup('holds-nl-s', { script: [] });
    const markers = s.markers;
    const at = new Map<string, NolossFound | null>();
    const plant = new Map<string, string | null>();
    const facts = new Map<string, unknown>();
    const run = markers.run;
    const npName = hostNames(undefined, process.platform, 1).find((x) => stageable(x) && x !== 'a:b.txt')!;
    let k4: { id: string; m: string } | null = null;
    let incoming: { id: string; m: string; path: string } | null = null;
    const probe = (label: string, fn: (ctx: SimContext) => Promise<void>): Step => ({ probe: label, run: async (ctx) => { await fn(ctx); return label; } });
    // A second INV-NOLOSS instance over the same run (finding 4's run-time test): it checks every step like the run's own oracle until
    // the k4-held probe judges it once over the real remote with held/<k4>/ removed (then put back); it never stops the run itself.
    const watch = oracleNoloss(markers, NS);
    let watchArmed = true;
    const watcher: Oracle = {
      name: 'INV-NOLOSS-WATCH',
      async afterEveryOp(ctx) {
        if (!watchArmed) return null;
        const v = await watch.afterEveryOp!(ctx);
        if (v !== null && !facts.has('watchEarly')) facts.set('watchEarly', v);
        return null;
      },
    };
    const steps: Step[] = [
      { rounds: 1 },
      // ---- live and author_disk (B), published-CS plant (J) ----
      { kind: 'edit_band', peer: 0, params: { insert: false } },
      ...alone(0, 1),   // one p0 iteration: the edit is in p0's open CS (finding 3: not the fresh-write allowance)
      probe('fresh', async (ctx) => {
        const m = lastMarker(ctx, 'edit_band', 'p0');
        facts.set('liveMarker', m);
        at.set('fresh', await locate(ctx, markers, m));
        plant.set('fresh-open', await judge(oracleNoloss(markers, NS), ctx));
      }),
      { rounds: 12 },
      until(0, 'published wait', async (ctx) => (await locate(ctx, markers, facts.get('liveMarker') as string))?.at === 'live', 20),
      probe('published', async (ctx) => {
        const m = facts.get('liveMarker') as string;
        at.set('published', await locate(ctx, markers, m));
        // J: the landed live commit rewritten without m's row while p0's disk keeps it (p0's CS has published).
        const dir = await scratchRemote(ctx, 'pubcs');
        await liveRewritten(dir, (path, bytes) => (path === 'shared.txt' && bytes.includes(m) ? withoutRow(bytes, m) : undefined));
        plant.set('published-cs', await judge(oracleNoloss(markers, NS), viewOf(ctx, { remoteDir: dir })));
        await dropScratch(dir);
      }),
      // ---- p1's band row (a teammate line for edit_peer_line; retired later) ----
      { kind: 'edit_band', peer: 1, params: { insert: false } },
      { rounds: 12 },
      probe('p1-band', async (ctx) => { facts.set('p1Band', lastMarker(ctx, 'edit_band', 'p1')); }),
      // ---- local_only_disk (D) ----
      { kind: 'nonportable_name', peer: 0, params: { name: npName } },
      ...alone(0, 3),
      probe('np', async (ctx) => {
        const e = [...ctx.opLog].reverse().find((x) => x.kind === 'nonportable_name')!;
        const m = findMarkers(Buffer.from(e.detail, 'latin1'))[0]!;
        facts.set('npMarker', m);
        at.set('np', await locate(ctx, markers, m));
      }),
      // ---- exempt (E) and a not-applicable INCOMING record's window ----
      { kind: 'temp_file', peer: 0 },
      { kind: 'collide_ignored', peer: 1, params: { other: 2, name: 'nl.cfg' } },
      probe('exempt', async (ctx) => {
        const temp = lastMarker(ctx, 'temp_file', 'p0');
        const col = [...ctx.opLog].reverse().find((x) => x.kind === 'collide_ignored')!;
        const [mx, my] = findMarkers(Buffer.from(col.detail, 'latin1'));
        facts.set('exempt', { temp, mx, my, exempt: [...markers.exempt().keys()], live: [...markers.live().keys()] });
        // Finding 3: a marker its author's engine never materializes (p1's locally excluded file, which a plant model calls synced)
        // no longer counts on p1's disk once p1 has iterated since the write (a fresh oracle cannot date the write: it never counts).
        plant.set('never-observed', await judge(oracleNoloss(modelWith(run, [[mx!, { peer: 'p1', path: markers.exempt().get(mx!)!.path }]]), NS), ctx));
      }),
      // A not-applicable INCOMING record: the team's np/team-1/con.py cannot be materialized on p2 (EngineDeps.platform win32 on every
      // host): one INCOMING `unmaterializable` record at once, its creation op due at 60 s (R3-29).
      { kind: 'nonconforming_push', peer: 0, params: { variant: 'bad_name', name: 'con.py' } },
      until(2, 'unmaterializable', async (ctx) => (await recordsOf(ctx, 2)).some((r) => r.kind === 'INCOMING' && has(r, 'unmaterializable')), 40),
      probe('incoming-young', async (ctx) => {
        const r = (await recordsOf(ctx, 2)).find((x) => x.kind === 'INCOMING' && has(x, 'unmaterializable'))!;
        const e = [...ctx.opLog].reverse().find((x) => x.kind === 'nonconforming_push')!;
        const mb = findMarkers(Buffer.from(e.detail, 'latin1'))[0]!;
        incoming = { id: r.id, m: mb, path: r.paths[0]! };
        facts.set('incomingYoung', { age: (await engineAt(ctx, 2).inspect()).holdAgeMs[r.id], held: await blobsHold(ctx, 2, (r.blobs as { h1?: Record<string, string> }).h1, mb), localOnly: r.local_only, path: r.paths[0] });
        plant.set('incoming-young', await incomingPlant(ctx, markers, incoming));
      }),
      // 65 virtual s in p2's own iterations (a single 60 s jump would leave it offline in its network backoff: OFFLINE keeps a window open).
      ...alone(2, 26),
      probe('incoming-old', async (ctx) => {
        const ins = await engineAt(ctx, 2).inspect();
        facts.set('incomingOld', { age: ins.holdAgeMs[incoming!.id], mirror: ins.mirror[incoming!.id], pause: ins.publishPause });
        plant.set('incoming-old', await incomingPlant(ctx, markers, incoming!));
      }),
      probe('exempt-delete', async (ctx) => {
        const ex = facts.get('exempt') as { temp: string };
        const tempPath = markers.exempt().get(ex.temp)!.path;
        await rm(join(ctx.peers[0]!.dir, ...tempPath.split('/')), { force: true });
        await rm(join(ctx.peers[1]!.dir, 'local', 'nl.cfg'), { force: true });
      }),
      // ---- K4 (F): registry while pushes are rejected and while partitioned, then held ----
      { kind: 'edit_same_line', peer: 1, params: { other: 0, row: 4 } },
      ...alone(1, 14),
      { kind: 'reject_transient', peer: 0, params: { n: 2 } },
      until(0, 'k4', async (ctx) => (await recordsOf(ctx, 0)).some((r) => has(r, 'conflict')), 20),
      probe('k4-registry', async (ctx) => {
        const r = (await recordsOf(ctx, 0)).find((x) => has(x, 'conflict'))!;
        const m = lastMarker(ctx, 'edit_same_line', 'p1');   // the op's last marker is p0's (peers=p1,p0)
        k4 = { id: r.id, m };
        const b = r.blobs as { s1?: Record<string, string>; s2?: Record<string, string>; s3?: Record<string, string> };
        facts.set('k4Stages', { s1: await blobsHold(ctx, 0, b.s1, m), s2: await blobsHold(ctx, 0, b.s2, m), s3: await blobsHold(ctx, 0, b.s3, m), kinds: Object.keys(r.blobs) });
        at.set('k4-registry', await locate(ctx, markers, m));
      }),
      { kind: 'partition', peer: 0 },
      ...Array.from({ length: 20 }, (): Step[] => [{ advance: 30_000 }, { iterate: 0 }]).flat(),
      probe('k4-offline', async (ctx) => {
        facts.set('offlinePause', (await engineAt(ctx, 0).inspect()).publishPause);
        at.set('k4-offline', await locate(ctx, markers, k4!.m));
        // The watch instance checks the record while p0 is OFFLINE (a full scan shares the run's caches, as the quiescence scan does).
        facts.set('watchOffline', (await watch.fullScan(ctx)).locations.get(k4!.m)?.at ?? null);
      }),
      { kind: 'heal', peer: 0 },
      // After 10 virtual minutes offline p0's network backoff has grown to 5 min: up to 160 iterations (400 s) to its landed push.
      until(0, 'k4-held', async (ctx) => (await locate(ctx, markers, k4!.m))?.at === 'held', 160),
      probe('k4-held', async (ctx) => {
        at.set('k4-held', await locate(ctx, markers, k4!.m));
        // Window plants (test 2): the board tip without held/<k4>/ (window closed: the oracle fails), plus a trace whose mirror events
        // omit the record (a missed mirror), and (test 3) the same board with inspect().mirror[k4].rejected = 'validator' (stays open).
        const dir = await scratchRemote(ctx, 'held');
        await boardWithoutHeld(dir, [k4!.id]);
        const view = viewOf(ctx, { remoteDir: dir });
        plant.set('window-closed', await judge(oracleNoloss(markers, NS), view));
        const events: TraceEvent[] = ctx.trace.events.map((e) => (e.kind === 'mirror' ? { ...e, holds: e.holds.filter((h) => h.id !== k4!.id) } : e));
        plant.set('window-missed', await judge(oracleNoloss(markers, NS), viewOf(ctx, { remoteDir: dir, trace: traceView(ctx, events) })));
        plant.set('window-rejected', await withInspect(ctx, 0, (ins) => ({ ...ins, mirror: { ...ins.mirror, [k4!.id]: { durable: false, rejected: 'validator' } } }),
          () => judge(oracleNoloss(markers, NS), view)));
        // OFFLINE keeps the window open even after the closing push (the minor finding: the OFFLINE branch must be able to fail a test).
        plant.set('window-offline', await withInspect(ctx, 0, (ins) => ({ ...ins, publishPause: 'OFFLINE' }), () => judge(oracleNoloss(markers, NS), view)));
        await dropScratch(dir);
        // Finding 4 at run time: the watch instance, which saw p0 OFFLINE and then the heal and the closing push, judges the real remote
        // with held/<k4>/ removed from the board tip (no engine runs meanwhile; the ref is put back before the probe returns).
        const real = await currentRemoteDir(ctx);
        const board = await g(real, ['rev-parse', REFS.remoteBoard]);
        try {
          await boardWithoutHeld(real, [k4!.id]);
          facts.set('windowRuntime', await watch.afterEveryOp!(ctx));
        } finally {
          await g(real, ['update-ref', REFS.remoteBoard, board]);
          watchArmed = false;
        }
      }),
      // ---- revert PATCH discarded (G) and the discard-accounting plants (test 9) ----
      { rounds: 6 },
      { kind: 'edit_peer_line', peer: 0, params: { path: 'shared.txt' } },
      until(0, 'revert', async (ctx) => (await recordsOf(ctx, 0)).some((r) => has(r, 'revert')), 30),
      probe('revert', async (ctx) => {
        const r = (await recordsOf(ctx, 0)).find((x) => has(x, 'revert'))!;
        const m = lastMarker(ctx, 'edit_peer_line', 'p0');
        facts.set('revert', { id: r.id, m, inH1: await blobsHold(ctx, 0, (r.blobs as { h1?: Record<string, string> }).h1, m) });
      }),
      { kind: 'resolve', peer: 0, params: { verb: 'discard' } },
      ...alone(0, 2),
      probe('discard', async (ctx) => {
        const rv = facts.get('revert') as { id: string; m: string };
        const rec = (await holdsOf(ctx, 0)).find((x) => x.id === rv.id);
        facts.set('discard', { state: rec?.state, discarded: markers.discarded().get(rv.m) ?? null, live: markers.live().has(rv.m) });
        // test 9: a noteDiscard for a record still ACTIVE in its owner's registry (the portability record), and one whose 'discard' event
        // names no held blob holding the marker (p1's band marker accounted to the discarded revert).
        const np = facts.get('npMarker') as string;
        const npRec = (await recordsOf(ctx, 0)).find((x) => has(x, 'portability'))!;
        const mmActive = modelWith(run, [[np, ownerOf(markers, np)]]);
        mmActive.noteDiscard(npRec.id, [np]);
        plant.set('discard-active', await judge(oracleNoloss(mmActive, NS), ctx));
        // The K4 loser's notes.txt marker: bytes of another path, never in the revert record's held side (an edit_peer_line row keeps
        // the teammate's own markers, HLD-27, so p1's band marker would be in it).
        const km = k4!.m;
        const mmBlob = modelWith(run, [[km, ownerOf(markers, km)]]);
        mmBlob.noteDiscard(rv.id, [km]);
        plant.set('discard-blob', await judge(oracleNoloss(mmBlob, NS), ctx));
      }),
      // ---- retirement (test 4): p1 replaces its own published band row (an informed edit by the peer whose A and disk held it) ----
      probe('p1 replaces its row', async (ctx) => {
        const old = facts.get('p1Band') as string;
        const p = ctx.peers[1]!;
        const abs = join(p.dir, 'shared.txt');
        const before = await readFile(abs);
        const fresh = markers.mint('p1');
        const after = Buffer.from(before.toString('latin1').split(/(?<=\n)/).map((row) => (row.includes(old) ? `shared band 1 p1 again ${fresh}${row.endsWith('\r\n') ? '\r\n' : '\n'}` : row)).join(''), 'latin1');
        await writeFile(abs, after);
        const t = ctx.clocks.get(p.name)!.wallMs() / 1_000;
        await utimes(abs, t, t);
        markers.noteEdit('p1', 'shared.txt', [fresh], [old], true, () => true);
      }),
      { rounds: 12 },
      probe('retired', async (ctx) => {
        const old = facts.get('p1Band') as string;
        const replaced = !(await readFile(join(ctx.peers[1]!.dir, 'shared.txt'))).includes(old);
        facts.set('retired', { replaced, retired: markers.retired().has(old), live: markers.live().has(old) });
        const owner: MarkerOwner = { peer: 'p1', path: 'shared.txt' };
        const informed = modelWith(run, [[old, owner]]);
        informed.noteEdit('p1', 'shared.txt', [], [old], true, () => true);
        plant.set('retired-informed', await judge(oracleNoloss(informed, NS), ctx));
        const stale = modelWith(run, [[old, owner]]);
        stale.noteEdit('p1', 'shared.txt', [], [old], false, () => true);
        plant.set('retired-stale', await judge(oracleNoloss(stale, NS), ctx));
      }),
      // ---- two stores (test 6) ----
      probe('two-stores', async (ctx) => { await twoStorePlants(ctx, plant); }),
    ];
    const options = { ...s.options, generator: play(steps, markers) };
    delete options.quiescence;
    const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [oracleNoloss(markers, NS), watcher], options);
    return { r, markers, at, plant, facts };
  })();
  return scenarioS;
}

/** The INCOMING plant: live_code without the record's path and the board without held/<id>/ (the marker's author is the team writer). */
async function incomingPlant(ctx: SimContext, markers: MarkerModel, c: { id: string; m: string; path: string }): Promise<string | null> {
  const dir = await scratchRemote(ctx, 'incoming');
  await boardWithoutHeld(dir, [c.id]);
  await liveRewritten(dir, (path) => (path === c.path ? null : undefined));
  const mm = modelWith(markers.run, [[c.m, ownerOf(markers, c.m)]]);
  const v = await judge(oracleNoloss(mm, NS), viewOf(ctx, { remoteDir: dir }));
  await dropScratch(dir);
  return v;
}

/**
 * The two-stores plants, each on the real clones and undone before the next (the scenario's last step; no engine runs meanwhile): a hold
 * id copied into a second peer's registry (a scratch registry commit), a hold moved to a registry other than its folded owner's, a ref
 * refs/cowork-held/x in a clone, a directory <gitdir>/cowork/conflicts/.
 */
async function twoStorePlants(ctx: SimContext, plant: Map<string, string | null>): Promise<void> {
  const REG = 'refs/cowork-local/main/holds';
  const [p0, p1, p2] = [ctx.peers[0]!.dir, ctx.peers[1]!.dir, ctx.peers[2]!.dir];
  plant.set('stores-clean', await twoStores(ctx, NS));
  const h0 = await g(p0, ['rev-parse', REG]);
  const h1 = await g(p1, ['rev-parse', REG]);
  const reg0 = await readRegistry(ctx.git, p0, 'main');
  const id = [...reg0.records.values()].find((r) => has(r, 'conflict'))!.id;
  const file = `records/${id}.json`;
  // p0's record file into p1's registry tree (objects fetched from p0's clone first).
  await g(p1, ['fetch', '-q', p0, `${h0}:refs/plant/p0holds`]);
  const blob = await g(p1, ['rev-parse', `${h0}:${file}`]);
  const add = async (dir: string, head: string, without?: string): Promise<string> => {
    const index = join(ctx.root, 'plant-reg.index');
    await g(dir, ['read-tree', head], { indexFile: index });
    if (without !== undefined) await g(dir, ['update-index', '--force-remove', without], { indexFile: index });
    else await g(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { indexFile: index });
    const tree = await g(dir, ['write-tree'], { indexFile: index });
    await rm(index, { force: true });
    return g(dir, ['commit-tree', tree, '-p', head, '-m', 'plant']);
  };
  try {
    await g(p1, ['update-ref', REG, await add(p1, h1), h1]);
    plant.set('stores-copied', await twoStores(ctx, NS));
    await g(p0, ['update-ref', REG, await add(p0, h0, file), h0]);
    plant.set('stores-moved', await twoStores(ctx, NS));
  } finally {
    await g(p1, ['update-ref', REG, h1]);
    await g(p0, ['update-ref', REG, h0]);
    await g(p1, ['update-ref', '-d', 'refs/plant/p0holds']);
  }
  await g(p2, ['update-ref', 'refs/cowork-held/x', await g(p2, ['rev-parse', 'HEAD'])]);
  try {
    plant.set('stores-ref', await twoStores(ctx, NS));
  } finally {
    await g(p2, ['update-ref', '-d', 'refs/cowork-held/x']);
  }
  const conflicts = join(p1, '.git', 'cowork', 'conflicts');
  await mkdir(conflicts, { recursive: true });
  await writeFile(join(conflicts, 'x'), 'plant\n');
  try {
    plant.set('stores-dir', await twoStores(ctx, NS));
  } finally {
    await rm(conflicts, { recursive: true, force: true });
  }
  plant.set('stores-after', await twoStores(ctx, NS));
}

const T = { timeout: SIM_TIMEOUT };
/** The tests that wait for scenario S (and the first of them also for D-26): one long scripted run each, slow on a loaded machine. */
const TS = { timeout: 2 * SIM_TIMEOUT };

test('locateMarker finds each location: a published marker → live; a K4 loser\'s marker after its owner\'s next landed push → held (h1/s2 only, never h0/s1/s3); the marker of a portability record\'s file → local_only_disk; an unpublished edit → author_disk; a K4 loser\'s marker before that push → registry; a marker companion\'s marker → registry (companion h1); a discarded revert marker → removed from obligations with its RESOLVED_DISCARD verified', TS, async () => {
  const s = await runScenarioS();
  okOrFail(s.r);
  assert.equal(s.at.get('fresh')?.at, 'author_disk', JSON.stringify(s.at.get('fresh')));
  assert.match(s.at.get('fresh')!.detail, /\(open CS\)$/, 'after one p0 iteration the unpublished edit counts by its open CS (R3-48), not by an allowance');
  assert.equal(s.at.get('published')?.at, 'live', JSON.stringify(s.at.get('published')));
  assert.equal(s.at.get('np')?.at, 'local_only_disk', JSON.stringify(s.at.get('np')));
  assert.equal(s.at.get('k4-registry')?.at, 'registry', JSON.stringify(s.at.get('k4-registry')));
  assert.match(s.at.get('k4-registry')!.detail, /\bs2\//);
  assert.equal(s.at.get('k4-held')?.at, 'held', JSON.stringify(s.at.get('k4-held')));
  assert.match(s.at.get('k4-held')!.detail, /^held [0-9A-Z]+\/s2\/notes\.txt$/, 'the K4 loser\'s s2 (never s1/s3)');
  assert.deepEqual(s.facts.get('k4Stages'), { s1: false, s2: true, s3: false, kinds: ['s1', 's2', 's3'] }, 'the loser\'s marker is only in s2');
  const d = s.facts.get('discard') as { state: string; discarded: string | null; live: boolean };
  const rv = s.facts.get('revert') as { id: string; inH1: boolean };
  assert.ok(rv.inH1, 'the revert PATCH held the marker in h1');
  assert.deepEqual(d, { state: 'RESOLVED_DISCARD', discarded: rv.id, live: false }, 'removed from obligations, accounted to the RESOLVED_DISCARD (the run\'s oracle verified it)');
  const c = await runScenarioD26();
  okOrFail(c.r);
  assert.equal(c.at.get('companion')?.at, 'registry', JSON.stringify(c.at.get('companion')));
  assert.match(c.at.get('companion')!.detail, /\(marker companion\)$/);
});

test('the pre-mirror window closes at the owner\'s first landed push after the rev that added the marker: against a copy of the remote whose board tip is rewritten without held/<id>/ the oracle fails naming the marker, and a mirror event of that push that omits the record fails as a missed mirror', TS, async () => {
  const s = await runScenarioS();
  okOrFail(s.r);
  const m = s.facts.get('k4Stages') === undefined ? '' : lastK4Marker(s);
  assert.match(s.plant.get('window-closed') ?? '', new RegExp(`marker ${m} \\(author p0, path notes\\.txt, written at step \\d+\\) is in no location; last seen at`));
  assert.match(s.plant.get('window-missed') ?? '', new RegExp(`marker ${m} .*missed mirror: p0's record [0-9A-Z]+ holds ${m} since rev \\d+`));
});

test('the pre-mirror window closes at run time after a partition: the same INV-NOLOSS instance that checked the K4 record while its owner was OFFLINE (registry) fails once the heal\'s closing push has landed and the board tip then loses held/<id>/ (a stay-open condition seen earlier never re-opens a closed window)', TS, async () => {
  const s = await runScenarioS();
  okOrFail(s.r);
  const m = lastK4Marker(s);
  assert.equal(s.facts.get('watchEarly'), undefined, `the watch instance stayed green until the plant: ${String(s.facts.get('watchEarly'))}`);
  assert.equal(s.facts.get('watchOffline'), 'registry', 'while p0 was OFFLINE the watch instance found the K4 marker in p0\'s registry');
  assert.equal(s.at.get('k4-held')?.at, 'held', 'after the heal the closing push mirrored it');
  assert.match(String(s.facts.get('windowRuntime') ?? ''), new RegExp(`^INV-NOLOSS: marker ${m} \\(author p0, path notes\\.txt, written at step \\d+\\) is in no location; last seen at held \\(held [0-9A-Z]+/s2/notes\\.txt\\)$`));
});

function lastK4Marker(s: ScenarioS): string {
  const e = [...s.r.opLog].reverse().find((x) => x.kind === 'edit_same_line')!;
  const ms = findMarkers(Buffer.from(e.detail, 'latin1'));
  return ms[ms.length - 1]!;
}

test('the registry keeps counting indefinitely while the owner is partitioned (publishPause OFFLINE for 10 virtual minutes) and while inspect().mirror[id].rejected is \'validator\' (wrapper plant), and a not-applicable INCOMING record\'s marker counts there until the record is 60 s old, while a closure INCOMING record\'s window closes at the owner\'s first landed push after its creation', TS, async () => {
  const s = await runScenarioS();
  okOrFail(s.r);
  assert.equal(s.facts.get('offlinePause'), 'OFFLINE');
  assert.equal(s.at.get('k4-offline')?.at, 'registry', JSON.stringify(s.at.get('k4-offline')));
  assert.equal(s.plant.get('window-rejected'), null, 'rejected keeps the window open');
  assert.equal(s.plant.get('window-offline'), null, 'OFFLINE keeps the window open, even after the closing push');
  assert.ok(s.plant.get('window-closed') !== null, 'the same plant without the rejection or OFFLINE fails');
  const young = s.facts.get('incomingYoung') as { age: number; held: boolean; localOnly: boolean };
  assert.ok(young.age < 60_000 && young.held && !young.localOnly, `p2's unmaterializable record is young, not local_only, its h1 holds the team's marker: ${JSON.stringify(young)}`);
  assert.equal(s.plant.get('incoming-young'), null, 'younger than 60 s: the registry counts');
  const old = s.facts.get('incomingOld') as { age: number; mirror: { rejected: string | null }; pause: string | null };
  assert.ok(old.age >= 60_000 && old.mirror.rejected === null && old.pause === null, JSON.stringify(old));
  assert.match(s.plant.get('incoming-old') ?? '', /marker CWM_\w+_team \(author team, path np\/team-1\/con\.py, .*is in no location/, 'older than 60 s and mirrored by p2\'s landed push: no longer');
  const l = await runScenarioLock();
  okOrFail(l.r);
  assert.equal(l.plant.get('lock-before'), null, `before p2's first landed push after the record: the registry counts (${JSON.stringify(l.facts.get('lockBefore'))})`);
  assert.match(l.plant.get('lock-after') ?? '', /is in no location/, `after it: the window is closed (${JSON.stringify(l.facts.get('lockAfter'))})`);
});

test('retirement: a marker removed by an informed edit of a peer whose A held it is never searched again; the same removal tagged stale keeps it obligated and the oracle fails once no location holds it', TS, async () => {
  const s = await runScenarioS();
  okOrFail(s.r);
  assert.deepEqual(s.facts.get('retired'), { replaced: true, retired: true, live: false });
  assert.equal(s.plant.get('retired-informed'), null);
  const old = s.facts.get('p1Band') as string;
  assert.match(s.plant.get('retired-stale') ?? '', new RegExp(`marker ${old} \\(author p1, path shared\\.txt, .*is in no location`));
});

test('two stores: a hold id copied into a second peer\'s registry (scratch registry commit), a folded hold whose owner differs from the registry holding it, a ref refs/cowork-held/x in a clone and a directory <gitdir>/cowork/conflicts/ each fail the oracle with the store named', TS, async () => {
  const s = await runScenarioS();
  okOrFail(s.r);
  assert.equal(s.plant.get('stores-clean'), null);
  assert.match(s.plant.get('stores-copied') ?? '', /hold [0-9A-Z]+ is in 2 registries \(p0, p1\)/);
  assert.match(s.plant.get('stores-moved') ?? '', /the board folds hold [0-9A-Z]+ with owner p0, but p1's registry holds it/);
  assert.match(s.plant.get('stores-ref') ?? '', /p2's clone has the ref refs\/cowork-held\/x/);
  assert.match(s.plant.get('stores-dir') ?? '', /p1's clone has the directory <gitdir>\/cowork\/conflicts\//);
  assert.equal(s.plant.get('stores-after'), null);
});

test('a published CS\'s marker no longer counts on its author\'s disk: a landed commit that omits one unheld marker row while the author\'s disk keeps it fails INV-NOLOSS', TS, async () => {
  const s = await runScenarioS();
  okOrFail(s.r);
  const m = s.facts.get('liveMarker') as string;
  assert.equal(s.plant.get('fresh-open'), null, 'the same row on p0\'s disk while the CS is still open passes');
  assert.equal(s.at.get('published')?.at, 'live', JSON.stringify(s.at.get('published')));
  assert.match(s.plant.get('published-cs') ?? '', new RegExp(`marker ${m} \\(author p0, path shared\\.txt, written at step \\d+\\) is in no location`));
});

test('author_disk counts only by R3-48 (an open CS or a captured, unpublished ready pair) and the ruled allowances (engine down, INCIDENT, a restart or a write not yet followed by its author\'s next iteration, an own ON_DISK local_only or CONFLICTED record): an unpublished edit after one iteration of its author counts by its open CS, and a marker its author\'s engine never materializes (an excluded file a plant\'s model calls synced) is in no location once its author has iterated', TS, async () => {
  const s = await runScenarioS();
  okOrFail(s.r);
  assert.match(s.at.get('fresh')?.detail ?? '', /^author_disk p0:shared\.txt \(open CS\)$/);
  const ex = s.facts.get('exempt') as { mx: string };
  assert.match(s.plant.get('never-observed') ?? '', new RegExp(`^INV-NOLOSS: marker ${ex.mx} \\(author p1, path local/nl\\.cfg, written at step \\d+\\) is in no location; last seen at nowhere$`));
});

test('author_disk counts a fresh write at a path absent from its author\'s A until the author iterates past the untracked-listing backstop (ruling R3-EF4-2; Plan 2 Task 9\'s gate, UNTRACKED_RESCAN_MS 30 s): p0\'s local/ holds only its locally excluded x.cfg, so a collide_ignored write of a non-excluded local/y.cfg there is in no open CS after p0\'s next iteration and counts at author_disk by that window; after 35 virtual s of p0 iterations it is in p0\'s open CS (or published), and INV-NOLOSS passes every step', T, async () => {
  const s = holdsSetup('holds-nl-untracked', { script: [] });
  const markers = s.markers;
  const nl = oracleNoloss(markers, NS);
  const facts = new Map<string, unknown>();
  let mark = '';
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'collide_ignored', peer: 0, params: { other: 1, name: 'x.cfg' } },   // p0's local/ holds only its excluded x.cfg
    { rounds: 2 },
    { kind: 'collide_ignored', peer: 1, params: { other: 0, name: 'y.cfg' } },   // p0 writes a new, non-excluded local/y.cfg there
    ...alone(0, 1),
    {
      probe: 'within', run: async (ctx) => {
        const col = [...ctx.opLog].reverse().find((x) => x.kind === 'collide_ignored')!;
        mark = findMarkers(Buffer.from(col.detail, 'latin1'))[1]!;   // `local/y.cfg excluded_by=p1 other=p0 <p1's> <p0's>`
        facts.set('owner', markers.live().get(mark));
        facts.set('within', nl.locations(ctx).get(mark) ?? null);
        // The ratified gate the oracle allows for: p0's snapshot has not listed the file yet, so no CS holds it.
        facts.set('openWithin', engineAt(ctx, 0).core.cs.openPaths().has('local/y.cfg'));
      },
    },
    ...alone(0, 14),
    { probe: 'after', run: async (ctx) => { facts.set('after', nl.locations(ctx).get(mark) ?? null); } },
  ];
  const options = { ...s.options, generator: play(steps, markers) };
  delete options.quiescence;
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [nl], options);
  okOrFail(r);
  assert.deepEqual(facts.get('owner'), { peer: 'p0', path: 'local/y.cfg' }, 'p0\'s marker in local/y.cfg is an obligation');
  assert.equal(facts.get('openWithin'), false, 'after one p0 iteration the untracked-listing gate has not admitted local/y.cfg (no open CS holds it)');
  const within = facts.get('within') as NolossFound | null;
  assert.equal(within?.detail, 'author_disk p0:local/y.cfg (fresh untracked write, within the untracked-listing backstop)', JSON.stringify(within));
  const after = facts.get('after') as NolossFound | null;
  assert.ok(after !== null && (after.at === 'live' || /^author_disk p0:local\/y\.cfg \((open CS|ready .+)\)$/.test(after.detail)), `past the backstop the file is in p0's open CS, a ready pair or live: ${JSON.stringify(after)}`);
});

test('a marker written to a path that is not synced is exempt, not an obligation', TS, async () => {
  const s = await runScenarioS();
  okOrFail(s.r);
  const ex = s.facts.get('exempt') as { temp: string; mx: string; my: string; exempt: string[]; live: string[] };
  assert.ok(ex.exempt.includes(ex.temp) && ex.exempt.includes(ex.mx), `temp_file's and collide_ignored's excluded markers are exempt: ${JSON.stringify(ex)}`);
  assert.ok(!ex.live.includes(ex.temp) && !ex.live.includes(ex.mx), 'and never obligations');
  assert.ok(ex.live.includes(ex.my), 'the other peer\'s (synced) colliding file is an obligation');
  // The scenario deleted both files without telling the model; its oracle stayed green (okOrFail above).
});

test('RESOLVED_DISCARD accounting is checked: a noteDiscard for a record that is still ACTIVE in its owner\'s registry, and one whose \'discard\' event names no held blob containing the marker, each fail the oracle', TS, async () => {
  const s = await runScenarioS();
  okOrFail(s.r);
  assert.match(s.plant.get('discard-active') ?? '', /p0's record [0-9A-Z]+ is ACTIVE, not RESOLVED_DISCARD/);
  assert.match(s.plant.get('discard-blob') ?? '', /no 'discard' event of [0-9A-Z]+ names a held blob holding it/);
});

// ---- the lock closure (test 3's last clause) --------------------------------------------------------------------------------

interface Planted { r: SimResult; plant: Map<string, string | null>; at: Map<string, NolossFound | null>; facts: Map<string, unknown>; }
let scenarioLock: Promise<Planted> | null = null;

/**
 * p2's shared.txt under a share-read lock while p1 publishes a band row: p2's closure defers `locked` and becomes an INCOMING lock record
 * at 60 s (h1 = TIP's blob, p1's marker); the plant (live_code without p1's row, the board without held/<id>/) passes while p2 has landed
 * no push after the record and fails once it has.
 */
function runScenarioLock(): Promise<Planted> {
  scenarioLock ??= (async () => {
    const s = holdsSetup('holds-nl-lock', { script: [] });
    const markers = s.markers;
    const plant = new Map<string, string | null>();
    const facts = new Map<string, unknown>();
    let rec: { id: string; m: string } | null = null;
    const lockPlant = async (ctx: SimContext): Promise<string | null> => {
      const dir = await scratchRemote(ctx, 'lock');
      await boardWithoutHeld(dir, [rec!.id]);
      await liveRewritten(dir, (path, bytes) => (path === 'shared.txt' && bytes.includes(rec!.m) ? withoutRow(bytes, rec!.m) : undefined));
      const mm = modelWith(markers.run, [[rec!.m, ownerOf(markers, rec!.m)]]);
      const v = await judge(oracleNoloss(mm, NS), viewOf(ctx, { remoteDir: dir }));
      await dropScratch(dir);
      return v;
    };
    const steps: Step[] = [
      { rounds: 1 },
      { kind: 'lock_share_read', peer: 2, params: { path: 'shared.txt' } },
      { kind: 'edit_band', peer: 1, params: { insert: false } },
      ...alone(1, 12),
      // The record's creation op is pushed in the iteration that creates it: two transient rejections keep that push (and the next) from
      // landing, so the probe below sees the record before p2's first landed push after it.
      { kind: 'reject_transient', peer: 0, params: { n: 2 } },
      // p2 in its own iterations (a single 30 s jump would leave it offline in its network backoff: OFFLINE keeps a window open).
      until(2, 'lock record', async (ctx) => (await recordsOf(ctx, 2)).some((r) => r.kind === 'INCOMING' && has(r, 'lock')), 40),
      {
        probe: 'lock-before', run: async (ctx) => {
          const r = (await recordsOf(ctx, 2)).find((x) => x.kind === 'INCOMING' && has(x, 'lock'))!;
          rec = { id: r.id, m: lastMarker(ctx, 'edit_band', 'p1') };
          facts.set('lockBefore', { pushes: ctx.trace.ofKind('push').filter((e) => e.peer === engineAt(ctx, 2).peerId).map((e) => e.outcome).slice(-3) });
          plant.set('lock-before', await lockPlant(ctx));
          return r.id;
        },
      },
      // p2's landed push carries the record (held/<id>/ on the remote board tip), then one more iteration: the window's closing push.
      until(2, 'lock mirrored', async (ctx) => (await g(await currentRemoteDir(ctx), ['ls-tree', REFS.remoteBoard, `held/${rec!.id}`])).length > 0, 40),
      ...alone(2, 2),
      {
        probe: 'lock-after', run: async (ctx) => {
          const ins = await engineAt(ctx, 2).inspect();
          facts.set('lockAfter', { pause: ins.publishPause, mirror: ins.mirror[rec!.id] });
          plant.set('lock-after', await lockPlant(ctx));
        },
      },
      { kind: 'unlock', peer: 2 },
      { rounds: 4 },
    ];
    const options = { ...s.options, generator: play(steps, markers) };
    delete options.quiescence;
    const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [oracleNoloss(markers, NS)], options);
    return { r, plant, at: new Map(), facts };
  })();
  return scenarioLock;
}

// ---- D-26: conflicted restore then markers park -----------------------------------------------------------------------------

let scenarioD26: Promise<Planted> | null = null;

/**
 * p0 loses a same-row race on notes.txt row 4 (a K4 record, OFF_DISK after the TIP write), edits row 4 again (overlapping), restores the
 * K4 record (`cowork:` markers on p0's disk, guard `markers`), types a half-done resolution with a fresh marker, and after age_24h the
 * markers park moves it into a companion; then resolve --restore of the companion brings the rows and the marker back.
 */
function runScenarioD26(): Promise<Planted> {
  scenarioD26 ??= (async () => {
    const s = holdsSetup('holds-nl-d26', { script: [] });
    const markers = s.markers;
    const at = new Map<string, NolossFound | null>();
    const facts = new Map<string, unknown>();
    const plant = new Map<string, string | null>();
    const steps = d26Steps(markers, facts, at);
    const options = { ...s.options, generator: play(steps, markers) };
    delete options.quiescence;
    const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [oracleNoloss(markers, NS)], options);
    return { r, plant, at, facts };
  })();
  return scenarioD26;
}

test('conflicted restore then markers park: a K4 record restored over an overlapping p0 edit writes cowork: markers on p0\'s disk (guard markers); after p0 types a half-done resolution containing a fresh marker, age_24h markers-parks it: that marker is in the companion\'s registry h1, the record\'s own markers stay on the board, INV-NOLOSS passes every step, and resolve --restore of the companion brings the rows and the marker back', TS, async () => {
  const c = await runScenarioD26();
  okOrFail(c.r);
  const restored = c.facts.get('restored') as { markersOnDisk: boolean; guards: Array<[string, string[], string, string]> };
  assert.ok(restored.markersOnDisk, `cowork: markers on p0's disk: ${JSON.stringify(restored)}`);
  assert.ok(restored.guards.some(([, gs]) => gs.includes('markers')), `a record carries the markers guard: ${JSON.stringify(restored)}`);
  const comp = c.facts.get('companion') as { id: string; parent: string; h1: boolean };
  assert.ok(comp.h1, 'the fresh marker is in the companion\'s h1');
  assert.equal(c.at.get('companion')?.at, 'registry');
  assert.equal(c.at.get('parent')?.at, 'held', `the record's own (K4) marker stays on the board: ${JSON.stringify(c.at.get('parent'))}`);
  assert.deepEqual(c.facts.get('back'), { marker: true, rows: true }, `resolve --restore of the companion brings the rows and the marker back: ${JSON.stringify(c.facts.get('restoreCompanion'))}`);
});

// ---- long seeds ----------------------------------------------------------------------------------------------------------------

/** 05 P7 Plan 3 subset weights. */
const P7_WEIGHTS = { stale_save: 8, rewind: 4, edit_band: 8, edit_same_line: 6, edit_peer_line: 6, lock_share_none: 3, gc_prune: 3, resolve: 10 } as const;
/**
 * Pinned at implementation time (Task 15 report: holds-p7-0…22 scanned with INV-NOLOSS): five seeds whose op-logs together contain every
 * required kind — 9 (stale saves, insertions, a KilledAt, gc, a share-none lock), 2 (resolve --publish and --discard), 5 (--park), 7
 * (rewinds), 20 (--restore). holds-p7-11 and holds-p7-1 failed INV-NOLOSS on the pre-EF2 engine (Task 15 findings 2 and 3); they pass
 * since EF2 (D4 and D3) and are pinned as TEST_SIM_FULL regression seeds both here (EF2_P7_SEEDS, subtests below) and in
 * sim.ef2.holds.test.ts. holds-p7-12 threw the gc_prune write-tree rc 128 that Task EF fixed (01-engine §6's reseed-and-retry).
 */
const P7_SEEDS: readonly string[] = ['holds-p7-9', 'holds-p7-2', 'holds-p7-5', 'holds-p7-7', 'holds-p7-20'];

/**
 * The required kinds of 05 P7 (Plan 3 subset), each a predicate over one op-log entry. A resolve verb counts when the op ran it (`→ done`
 * or `→ refused`; a skipped op found no record): which verb the generator draws depends on the records the seed made.
 */
const P7_KINDS: ReadonlyArray<readonly [string, (e: { kind: string; detail: string }) => boolean]> = [
  ['stale save', (e) => e.kind === 'stale_save' && !e.detail.includes('skipped')],
  ['rewind', (e) => e.kind === 'rewind' && !e.detail.includes('skipped')],
  ['1–40-row insertion', (e) => e.kind === 'edit_band' && / insert at=\d+ n=\d+/.test(e.detail)],
  ['same-row edit', (e) => e.kind === 'edit_same_line' && !e.detail.includes('skipped')],
  ['formatter', (e) => e.kind === 'formatter' && !e.detail.includes('skipped')],
  ['resume', (e) => e.kind === 'resume' && !e.detail.includes('skipped')],
  ['KilledAt', (e) => e.kind === 'killed'],
  ['gc --prune=now', (e) => e.kind === 'gc_prune' && e.detail.includes('rc=0')],
  ['share-none lock', (e) => e.kind === 'lock_share_none' && e.detail.includes('mode=share-none')],
  ['resolve publish', (e) => e.kind === 'resolve' && / --publish → /.test(e.detail)],
  ['resolve discard', (e) => e.kind === 'resolve' && / --discard → /.test(e.detail)],
  ['resolve park', (e) => e.kind === 'resolve' && / --park → /.test(e.detail)],
  ['resolve restore', (e) => e.kind === 'resolve' && / --restore → /.test(e.detail)],
];

/** One holds seed with INV-NOLOSS alone (after every op and at quiescence); a thrown runSim is a reported failure, never silent. */
async function nolossSeed(seed: string, weights: Readonly<Record<string, number>>): Promise<{ seed: string; r: SimResult | null; thrown: string | null }> {
  const s = holdsSetup(seed, { weights });
  try {
    return { seed, r: await runSim(s.tuple, s.factory, [oracleNoloss(s.markers, NS)], s.options), thrown: null };
  } catch (e) {
    return { seed, r: null, thrown: e instanceof Error ? e.message : String(e) };
  }
}
const verdict = (x: { seed: string; r: SimResult | null; thrown: string | null }): string | null =>
  x.thrown !== null ? `${x.seed}: runSim threw: ${x.thrown}` : x.r!.ok ? null : `${x.seed}: ${JSON.stringify(x.r!.failure)} (artifacts ${String(x.r!.artifactsDir)})`;

/**
 * Seeds INV-NOLOSS failed on the pre-EF2 engine (Task 15 report, engine findings; fixed by the engine-fix effort EF2, D3 and D4): pinned
 * as regression subtests that run the seed and assert INV-NOLOSS green (they were todo subtests until EF2 landed; controller ruling, Task 15
 * fix round 1). They run under `npm run test:sim` only (R3-55: npm test runs a multi-seed test's first seed).
 */
const EF2_P7_SEEDS: ReadonlyArray<readonly [string, string]> = [
  ['holds-p7-11', 'EF2 D4: after a rewind and KilledAt at registry.cas / publish.out_built, p0\'s final publish dropped p1\'s notes.txt rows with no revert record'],
  ['holds-p7-1', 'EF2 D3: restart re-form (restart.ts reformOpenCs) skipped every path of a ready pair, so an edit never captured was in no CS after a restart'],
];
const EF2_PDAT_SEEDS: ReadonlyArray<readonly [string, string]> = [
  ['holds-pdat-1', 'EF2 D3: restart re-form skipped every path of the join start-capture pair; p1\'s shared.txt edit was in no CS after its restart'],
];

/** A subtest per EF2 regression seed: INV-NOLOSS green after every op and at quiescence; skipped under npm test (R3-55). */
async function ef2Seeds(t: TestContext, seeds: ReadonlyArray<readonly [string, string]>, weights: Readonly<Record<string, number>>): Promise<void> {
  for (const [seed, why] of seeds) {
    await t.test(`${seed} passes INV-NOLOSS after every op and at quiescence (EF2 regression seed — ${why})`, {
      timeout: 30 * 60_000,
      ...(FULL ? {} : { skip: 'runs under npm run test:sim (TEST_SIM_FULL=1, R3-55)' }),
    }, async () => {
      assert.equal(verdict(await nolossSeed(seed, weights)), null);
    });
  }
}

test('05 P7 Plan 3 subset: five pinned holds seeds with weights stale_save 8, rewind 4, edit_band 8, edit_same_line 6, edit_peer_line 6, lock_share_none 3, gc_prune 3, resolve 10 contain, across their op-logs, stale saves, rewinds, 1–40-row insertions, same-row edits, a formatter with resume, a KilledAt, gc --prune=now, a share-none lock and resolve publish, discard, park and restore, and pass INV-NOLOSS after every op and at quiescence', { timeout: FULL ? 180 * 60_000 : SIM_TIMEOUT }, async (t) => {
  const seeds = FULL ? P7_SEEDS : P7_SEEDS.slice(0, 1);
  const runs = [];
  for (const seed of seeds) runs.push(await nolossSeed(seed, P7_WEIGHTS));
  const failures = runs.map(verdict).filter((x): x is string => x !== null);
  assert.deepEqual(failures, [], 'INV-NOLOSS after every op and at quiescence');
  if (FULL) {
    const entries = runs.flatMap((x) => x.r!.opLog);
    const missing = P7_KINDS.filter(([, pred]) => !entries.some(pred)).map(([k]) => k);
    assert.deepEqual(missing, [], `the pinned P7 seeds lack these kinds — re-pick the seeds (scan holds-p7-<k> from k = 0): ${missing.join(', ')}`);
  }
  await ef2Seeds(t, EF2_P7_SEEDS, P7_WEIGHTS);
});

const PDAT_WEIGHTS = { edit_same_line: 15, resolve: 15, stale_save: 5 } as const;

test('P-DAT-05: holds seeds holds-pdat-0…holds-pdat-4 with weights edit_same_line 15, resolve 15 and stale_save 5 pass INV-NOLOSS after every op — every LOCAL byte of each K4 conflict, clean restore, conflicted restore and discard is in live_code, a record, the disk or a RESOLVED_DISCARD (holds-pdat-1, an EF2 D3 regression seed, runs as its own subtest)', { timeout: FULL ? 150 * 60_000 : SIM_TIMEOUT }, async (t) => {
  const own = new Set(EF2_PDAT_SEEDS.map(([s]) => s));
  const seeds = FULL ? [0, 1, 2, 3, 4].map((k) => `holds-pdat-${k}`).filter((s) => !own.has(s)) : ['holds-pdat-0'];
  const runs = [];
  for (const seed of seeds) runs.push(await nolossSeed(seed, PDAT_WEIGHTS));
  assert.deepEqual(runs.map(verdict).filter((x) => x !== null), []);
  const k4 = runs.flatMap((x) => x.r!.opLog).filter((e) => e.kind === 'edit_same_line' && !e.detail.includes('skipped')).length;
  assert.ok(k4 > 0, 'the seeds wrote same-row edits (K4 conflicts)');
  await ef2Seeds(t, EF2_PDAT_SEEDS, PDAT_WEIGHTS);
});

// ---- late writes (test 5) ------------------------------------------------------------------------------------------------------

/**
 * The F-ED-4 'old_handle' write as a plant (a ring that lost the late write): during p0's apply, at apply.beforePhase2, the late row is
 * appended to the tmp/*.old holding the pre-step bytes, the model notes a late write, and the .old is put back to its pre-step bytes at once.
 */
function lostLateWrite(markers: MarkerModel, facts: Map<string, unknown>): Step {
  return {
    probe: 'lost late write', run: async (ctx) => {
      const p = ctx.peers[0]!;
      const path = 'shared.txt';
      const target = join(p.dir, path);
      const before = await readFile(target);
      const m = markers.mint('p0');
      const tmp = join(p.dir, '.git', 'cowork', 'tmp');
      const sched = ctx.scheduler;
      const prev = sched.onYield;
      let fired = false;
      sched.onYield = async (name: string): Promise<void> => {
        if (!fired && name === 'apply.beforePhase2' && (await lstat(target).catch(() => null)) === null) {
          for (const f of (await readdir(tmp).catch(() => [] as string[])).filter((x) => x.endsWith('.old'))) {
            const bytes = await readFile(join(tmp, f)).catch(() => null);
            if (bytes === null || !bytes.equals(before)) continue;
            await writeFile(join(tmp, f), Buffer.concat([bytes, Buffer.from(`x-late-lost ${m}\n`, 'latin1')]));
            await writeFile(join(tmp, f), before);   // the ring lost it
            fired = true;
            break;
          }
        }
        if (prev !== null) await prev(name);
      };
      try {
        await ctx.engines[0]!.step(ctx);
      } finally {
        sched.onYield = prev;
      }
      if (fired) {
        markers.noteEdit('p0', path, [m], [], true, () => false);
        markers.noteLateWrite(m);
        facts.set('lost', m);
      }
      return `fired=${fired} ${m}`;
    },
  };
}

test('late write: a write_during_apply \'old_handle\' marker is at held or registry at the next check; a plant whose handler, right after appending the late row, restores the .old to its pre-step bytes (a ring that lost the late write) fails INV-NOLOSS at that check naming the late marker', T, async () => {
  const s = holdsSetup('holds-nl-late', { script: [] });
  const markers = s.markers;
  const facts = new Map<string, unknown>();
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { insert: false } },
    ...alone(1, 12),
    { kind: 'write_during_apply', peer: 0, params: { path: 'shared.txt', variant: 'old_handle' } },
    { advance: 2_500 },
    { iterate: 0 },   // p0's next step settles the write through the .old handle (ENG-35)
    {
      probe: 'late', run: async (ctx) => {
        const m = lastMarker(ctx, 'write_during_apply', 'p0');
        facts.set('isLate', markers.lateWrites().has(m));
        facts.set('lateAt', await locate(ctx, markers, m));
      },
    },
    { rounds: 6 },
    { kind: 'edit_band', peer: 1, params: { insert: false } },
    ...alone(1, 12),
    lostLateWrite(markers, facts),
    { advance: 2_500 },
    { iterate: 0 },
  ];
  const obs = observing([oracleNoloss(markers, NS)]);
  const options = { ...s.options, generator: play(steps, markers) };
  delete options.quiescence;
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, obs.oracles, options);
  await dropArtifacts(r);
  assert.equal(facts.get('isLate'), true);
  assert.ok(['held', 'registry'].includes((facts.get('lateAt') as NolossFound | null)?.at ?? ''), `the late marker is in a hold record: ${JSON.stringify(facts.get('lateAt'))}`);
  const lost = facts.get('lost') as string | undefined;
  assert.ok(lost !== undefined, `the plant fired: ${JSON.stringify(r.opLog.slice(-4))}`);
  const f = obs.fired.get('INV-NOLOSS');
  assert.ok(f !== undefined, 'INV-NOLOSS fired');
  // The first check after p0's next iteration (the step after the plant's own).
  const plantStep = r.opLog.find((e) => e.kind === 'probe' && e.detail.includes('lost late write'))!.step;
  const nextIterate = r.opLog.find((e) => e.kind === 'iterate' && e.step > plantStep)!.step;
  assert.equal(f.step, nextIterate, `at the check after p0's next iteration: ${JSON.stringify(f)}`);
  assert.match(f.message, new RegExp(`late write ${lost} \\(author p0, path shared\\.txt`));
});

// ---- every profile (R3-49) and the incremental check (R3-49 cadence) ------------------------------------------------------------

async function profileSeed(seed: string, profile: 'edits' | 'faults'): Promise<{ r: SimResult; markers: MarkerModel }> {
  const markers = new MarkerModel(markerRun(seed));
  const r = await runSim({ seed, peers: 3, ops: PROFILES[profile].steps }, realEngine(), [oracleNoloss(markers, NS)], {
    generator: editGenerator(PROFILES[profile], markers), quiescence: DEFAULT_QUIESCENCE, seedFiles: seedFilesPlan2(seededRandom(`${seed}/files`)),
    ...(profile === 'faults' ? { crash: { rate: 0.02 } } : {}),
  });
  return { r, markers };
}

test('INV-NOLOSS runs on every profile: edits seed edits-n-0 and faults seed faults-n-0, whose editGenerator now carries markers, pass INV-NOLOSS after every op and at quiescence, revert records of R3-37 included', { timeout: FULL ? 60 * 60_000 : SIM_TIMEOUT }, async () => {
  const runs: Array<[string, 'edits' | 'faults']> = FULL ? [['edits-n-0', 'edits'], ['faults-n-0', 'faults']] : [['edits-n-0', 'edits']];
  for (const [seed, profile] of runs) {
    const { r, markers } = await profileSeed(seed, profile);
    okOrFail(r);
    assert.ok(markers.live().size > 0, `${seed}: the generator wrote markers`);
  }
});

test('incremental and full checks agree: on holds seed holds-n-0 a full scan forced at every 10th step returns the same verdict and the same location for every obligation as the incremental check', { timeout: FULL ? 60 * 60_000 : SIM_TIMEOUT }, async () => {
  const s = holdsSetup('holds-n-0', FULL ? {} : { steps: 20 });
  const o = oracleNoloss(s.markers, NS);
  let compared = 0;
  let lastStep = -1;
  const agree: Oracle = {
    name: 'NOLOSS-AGREE',
    async afterEveryOp(ctx) {
      const inc = await o.afterEveryOp!(ctx);
      const step = ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
      if (step === lastStep || step % 10 !== 0 || (!FULL && step > 20)) return inc;
      lastStep = step;
      const full = await o.fullScan(ctx);
      compared++;
      if ((inc === null) !== (full.verdict === null)) return `step ${step}: incremental verdict ${JSON.stringify(inc)} vs full ${JSON.stringify(full.verdict)}`;
      const locs = o.locations(ctx);
      for (const [m] of s.markers.live()) {
        const a = locs.get(m) ?? null;
        const b = full.locations.get(m) ?? null;
        if (a?.at !== b?.at || a?.detail !== b?.detail) return `step ${step}: ${m} incremental ${JSON.stringify(a)} vs full ${JSON.stringify(b)}`;
      }
      return inc;
    },
    async atQuiescence(ctx) {
      return o.atQuiescence!(ctx);
    },
  };
  const r = await runSim(s.tuple, s.factory, [agree], s.options);
  okOrFail(r);
  assert.ok(compared >= 2, `full scans compared: ${compared}`);
});
