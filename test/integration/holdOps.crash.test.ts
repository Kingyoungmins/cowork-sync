// Record before displacement and crashes (Plan 3 Task 5; Review Focus 3; 05 F7; HLD-16; rulings R3-15, R3-22, R3-60, R3-67;
// contract addition settleHoldOps): kills at registry.cas, apply.group.phase1/phase2 inside every hold operator and at
// apply.group.mid inside a two-path PIN park (the only place a group has a second path), then
// `git gc --prune=now` and a process restart (a fresh EngineCore over the same clone) whose restart(core) settles every
// interrupted operator by observation (DISK_EQ). Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOpId } from '../../src/board/ids.js';
import { applyStep } from '../../src/engine/apply.js';
import { collisionTake, evaluateRecords, markersPark, park, restore, settleHoldOps } from '../../src/engine/holdOps.js';
import { resolve } from '../../src/engine/resolve.js';
import { restart } from '../../src/engine/restart.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { HOLD_CODES, HOLD_LOG_CODES } from '../../src/holds/codes.js';
import { makeGuard, parseRecord, type HoldRecord } from '../../src/holds/record.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { remoteLive } from '../helpers/dataRecordsFixture.js';
import { blob, nr, P, pair, prepIt, recordLog, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { win } from '../helpers/mirrorFixture.js';
import { buf, captureReady, editAndCapture, prep } from '../helpers/publishHelpers.js';
import { captureAndLand, HUMAN } from '../helpers/resolveFixture.js';
import { gitIn, restartCore } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

/** Throws KilledAt at the `nth` hit of `point` (a dead process: the core is abandoned). */
async function killedAt<T>(point: string, nth: number, fn: () => Promise<T>): Promise<void> {
  let hits = 0;
  setCrashHandler((name) => {
    if (name === point && ++hits === nth) throw new KilledAt(name);
  });
  try {
    await assert.rejects(fn(), (e: unknown) => e instanceof KilledAt && e.point === point, `killed at ${point} #${nth}`);
  } finally {
    setCrashHandler(null);
  }
}

const U = 'src/u9.txt';
const HUMAN_PARK = { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false } as const;

/** Every record of the registry head, read test-side from the registry commit's records/ tree. */
async function headRecords(p: PeerFixture): Promise<HoldRecord[]> {
  const head = await p.core.repo.readRef(p.core.refs.holds);
  if (head === null) return [];
  const leaves = [...(await p.core.repo.readTreeMap((await p.core.repo.readCommit(head)).tree))].filter(([path]) => path.startsWith('records/'));
  return (await p.core.repo.readBlobs(leaves.map(([, e]) => e.oid))).map((b) => parseRecord(b));
}

async function writerOf(p: PeerFixture, live: Oid): Promise<{ op: string; peer: string }> {
  const t = (await p.core.repo.readCommit(live)).trailers.find((x) => x.key === 'Cowork-Writer')!;
  return { op: t.value, peer: parseOpId(t.value)!.peer };
}

test('a K4 record moved OFF_DISK by Plan 2\'s restart decision carries displaced_by and peer_authors', T10, async () => {
  await withPeers('k4-restart-decision', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two local']));
    await prepIt(p);
    const { live } = await fx.pushTeamChange({ [P]: buf(t9([2, 'two team'])) });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true });
    const team = await writerOf(p, live);
    // Killed after the TIP write (its round trip done) and before the registry move and the state update.
    await killedAt('apply.group.phase2', 1, () => applyStep(p.core, it));
    const k4 = p.core.holds.all().find((h) => h.guards.some((g) => g.name === 'conflict'))!;
    assert.deepEqual([k4.residence, k4.state], ['ON_DISK', 'CONFLICTED'], 'the crashed apply never moved the record');
    assert.deepEqual(await readWork(p, P), buf(t9([2, 'two team'])), 'TIP[p] is on disk');
    await gitIn(p, ['gc', '-q', '--prune=now']);
    await restartCore(p);
    const report = await restart(p.core);
    assert.equal(report.intent, 'apply');
    const rec = p.core.holds.get(k4.id)!;
    assert.deepEqual([rec.residence, rec.state], ['OFF_DISK', 'CONFLICTED'], "the restart decision found the write complete");
    assert.equal(rec.displaced_by, team.op);
    assert.deepEqual(rec.peer_authors, [team.peer]);
    assert.equal(rec.rev, k4.rev + 1, 'in that same rev');
  });
});

test('a kill between the park\'s snap transition and its final registry commit is completed by settleHoldOps with the snap entry kept', T10, async () => {
  // registry.cas hits: the inflight commit (1 before, 2 after its CAS), then the snap transition, then the final commit (3 before,
  // 4 after its CAS). Hit 3: the snap is committed and the inflight entry still set, so settleHoldOps writes the final patch; hit 4
  // (the brief's "second hit of the final commit"): the final commit landed and the restart finds it done.
  for (const nth of [3, 4]) {
    await withPeers(`park-kill-final-${nth}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      await writeWork(p, P, t9([2, 'two']));
      const it = await prepIt(p, { holdPaths: [P] });
      const id = await p.core.holds.hold(nr({ blobs: pair(it.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
      await killedAt('registry.cas', nth, () => park(p.core, it, id, HUMAN_PARK));
      const target = await blob(p, T9);
      if (nth === 3) {
        assert.equal(p.core.holds.local().inflight[id]?.op, 'park', 'hit 3: the inflight entry is still set');
        const snapNow = (await p.core.state.read())!.snap;
        assert.equal((await p.core.repo.readTreeMap(snapNow)).get(P)?.oid, target, 'hit 3: the snap transition was committed');
      }
      await gitIn(p, ['gc', '-q', '--prune=now']);
      await restartCore(p);
      await restart(p.core);
      const r = p.core.holds.get(id)!;
      assert.deepEqual([r.residence, r.state], ['OFF_DISK', 'PARKED'], `hit ${nth}`);
      assert.deepEqual(p.core.holds.local().inflight, {}, 'the inflight entry is cleared');
      assert.equal((await p.core.repo.readTreeMap(p.core.view!.snap)).get(P)?.oid, target, 'state:snap[p] is the written blob');
      const it2 = await prepIt(p, { materialize: false });
      assert.equal(it2.tick?.changed.has(P), false, 'the first tick lists p as unchanged');
      assert.equal(it2.tick?.dirty.has(P), false);
    });
  }
});

const ROWS = '1\n<<<<<<< cowork:disk\nTWO\n||||||| cowork:base\n2\n=======\ntwo\n>>>>>>> cowork:held\n3\n4\n5\n6\n7\n8\n9\n';
const ENV = '.env';
const CRASH_FILES: Record<string, Buffer> = { 'README.md': buf('# crash\n'), '.gitignore': buf('.env\n'), [P]: buf(T9) };
const KILLS = [{ point: 'registry.cas', nth: 2 }, { point: 'apply.group.phase1', nth: 1 }, { point: 'apply.group.phase2', nth: 1 }] as const;

/** One operator under test: its setup (returns the run and the consistency check after the restart). */
interface Case {
  name: string;
  setup(fx: CoreFixture, p: PeerFixture): Promise<{ run: () => Promise<unknown>; check: (p: PeerFixture) => Promise<void> }>;
}

const CASES: Case[] = [
  {
    name: 'PARK',
    async setup(_fx, p) {
      await writeWork(p, P, t9([2, 'two'], [6, 'six']));
      const it = await prepIt(p, { holdPaths: [P] });
      const id = await p.core.holds.hold(nr({ blobs: pair(it.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
      return {
        run: () => park(p.core, it, id, { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false }),
        async check(q) {
          const r = q.core.holds.get(id)!;
          const disk = (await readWork(q, P))!.toString('utf8');
          const pairs = `${disk === t9([2, 'two'], [6, 'six']) ? 'old' : disk === t9([6, 'six']) ? 'target' : `other:${disk}`}/${r.residence}/${r.state}`;
          assert.ok(['old/ON_DISK/ACTIVE', 'target/OFF_DISK/PARKED'].includes(pairs), pairs);
        },
      };
    },
  },
  {
    name: 'RESTORE',
    async setup(_fx, p) {
      const it0 = await prepIt(p);
      const id = await p.core.holds.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', blobs: pair(it0.A.get(P)!.oid, await blob(p, t9([2, 'two']))) }));
      const it = await prepIt(p, { holdPaths: [P] });
      return {
        run: () => restore(p.core, it, id, { humanEvidence: true, actor: 'human' }),
        async check(q) {
          const r = q.core.holds.get(id)!;
          const disk = (await readWork(q, P))!.toString('utf8');
          const pairs = `${disk === T9 ? 'old' : disk === t9([2, 'two']) ? 'result' : `other:${disk}`}/${r.residence}/${r.state}/${r.guards.map((g) => g.name).join(',')}`;
          assert.ok(['old/OFF_DISK/PARKED/revert', 'result/ON_DISK/ACTIVE/revert'].includes(pairs), pairs);
        },
      };
    },
  },
  {
    name: 'markers park',
    async setup(_fx, p) {
      await writeWork(p, P, ROWS);
      const it = await prepIt(p, { holdPaths: [P] });
      const id = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(it.A.get(P)!.oid, await blob(p, t9([2, 'two'])), await blob(p, t9([2, 'team']))) }));
      return {
        run: () => markersPark(p.core, it, id, { humanEvidence: true, displacedBy: null }),
        async check(q) {
          const r = q.core.holds.get(id)!;
          const comps = q.core.holds.companionsOf(id);
          const disk = (await readWork(q, P))!.toString('utf8');
          const pairs = `${disk === ROWS ? 'rows' : disk === T9 ? 'A' : 'other'}/${comps.map((c) => c.state).join(',')}/${r.residence}/${r.guards.map((g) => g.name).join(',')}`;
          assert.ok(['rows//ON_DISK/markers', 'rows/GONE/ON_DISK/markers', 'A/PARKED/OFF_DISK/'].includes(pairs), pairs);
        },
      };
    },
  },
  {
    name: 'collision take',
    async setup(fx, p) {
      await writeWork(p, ENV, 'SECRET=local\n');
      await fx.pushTeamChange({ [ENV]: buf('SECRET=team\n') });
      const it = await prepIt(p, { forceFetch: true, materialize: true });
      const c = await p.core.holds.hold(nr({ kind: 'INCOMING', paths: [ENV], guard: 'collision', origin: 'daemon', blobs: pair(ABSENT, it.tipMap.get(ENV)!.oid, ENV) }));
      const L = await blob(p, 'SECRET=local\n');
      return {
        run: () => collisionTake(p.core, it, c),
        async check(q) {
          const k = q.core.holds.all().filter((h) => h.kind === 'PATCH' && h.paths.includes(ENV));
          const disk = (await readWork(q, ENV))!.toString('utf8');
          const held = k.map((h) => ('h1' in h.blobs && h.blobs.h1[ENV] === L ? 'L' : '?'));
          const pairs = `${disk === 'SECRET=local\n' ? 'L' : disk === 'SECRET=team\n' ? 'T' : 'other'}/${k.map((h) => h.state).join(',')}/${held.join(',')}/${q.core.holds.get(c)!.state}`;
          assert.ok(['L///ACTIVE', 'L/GONE/L/ACTIVE', 'T/PARKED/L/ACTIVE'].includes(pairs), pairs);
        },
      };
    },
  },
  {
    name: 'apply-side K4',
    async setup(fx, p) {
      await writeWork(p, P, t9([2, 'two local']));
      await prepIt(p);
      await fx.pushTeamChange({ [P]: buf(t9([2, 'two team'])) });
      fx.advance(10_000);
      const it = await prepIt(p, { forceFetch: true });
      return {
        run: () => applyStep(p.core, it),
        async check(q) {
          const k = q.core.holds.all().filter((h) => h.guards.some((g) => g.name === 'conflict'));
          const disk = (await readWork(q, P))!.toString('utf8');
          const pairs = `${disk === t9([2, 'two local']) ? 'LOCAL' : disk === t9([2, 'two team']) ? 'TIP' : 'other'}/${k.map((h) => `${h.residence}/${h.state}/${h.displaced_by === null ? 'null' : 'op'}`).join(',')}`;
          assert.ok(['LOCAL/', 'LOCAL/ON_DISK/CONFLICTED/null', 'TIP/OFF_DISK/CONFLICTED/op'].includes(pairs), pairs);
        },
      };
    },
  },
  {
    // EF4 E4-1 (ruling R3-EF4-7): the companion and r's marker-free stages are one registry commit before the TIP write. Killed after it
    // (registry.cas #2) or inside the write before the target moved (phase1): the marker file is still on r's disk, so the companion is
    // redundant and settleHoldOps ends it GONE by observation, r stays ON_DISK CONFLICTED with `markers` and `conflict`. Killed after the
    // write (phase2): the restart decision moves r OFF_DISK and releases `markers`; the companion keeps the marker file.
    name: 'apply-side K4 onto a markers record',
    async setup(fx, p) {
      await writeWork(p, P, ROWS);
      const it0 = await prepIt(p, { holdPaths: [P] });
      const a = it0.A.get(P)!.oid;
      const held = await blob(p, t9([2, 'two']));
      const id = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(a, held, await blob(p, t9([2, 'team']))) }));
      await fx.pushTeamChange({ [P]: buf(t9([2, 'TEAM2'])) });
      fx.advance(10_000);
      const it = await prepIt(p, { forceFetch: true });
      const tip = it.tipMap.get(P)!.oid;
      const rows = await blob(p, ROWS);
      return {
        run: () => applyStep(p.core, it),
        async check(q) {
          const r = q.core.holds.get(id)!;
          const comps = q.core.holds.companionsOf(id);
          const disk = (await readWork(q, P))!.toString('utf8');
          const pairs = `${disk === ROWS ? 'rows' : disk === t9([2, 'TEAM2']) ? 'TIP' : 'other'}/${comps.map((c) => c.state).join(',')}/${r.residence}/${r.state}/${r.guards.map((g) => g.name).join(',')}`;
          assert.ok(['rows/GONE/ON_DISK/CONFLICTED/markers,conflict', 'TIP/PARKED/OFF_DISK/CONFLICTED/conflict'].includes(pairs), pairs);
          assert.deepEqual(r.blobs, stages(a, held, tip), "r's stages are marker-free: (A[p], r's held side, TIP[p])");
          assert.deepEqual(comps[0]!.blobs, pair(a, rows), 'the companion holds the marker file over A[p]');
          assert.ok(comps[0]!.local_only, 'the companion is local_only');
        },
      };
    },
  },
];

// One test per operator (each kills at the three anchors), so each stays well inside the 10-minute timeout under load.
for (const c of CASES) {
  test(`Review Focus 3: kill between the registry commit and the disk write, gc --prune=now, restart (${c.name})`, T10, async () => {
    for (const kill of KILLS) {
      await withPeers(`rf3-${c.name.replace(/\W+/g, '-')}-${kill.point}`, { files: CRASH_FILES }, async (fx) => {
        const p = fx.peers[0]!;
        const { run, check } = await c.setup(fx, p);
        const before = p.core.holds.all().map((h) => h.id);
        await killedAt(kill.point, kill.nth, run);
        await gitIn(p, ['gc', '-q', '--prune=now']);
        await restartCore(p);
        await restart(p.core);
        const ids = p.core.holds.all().map((h) => h.id);
        assert.equal(new Set(ids).size, ids.length, `${c.name} @ ${kill.point}: no duplicated id`);
        for (const id of before) assert.ok(ids.includes(id), `${c.name} @ ${kill.point}: record ${id} kept`);
        assert.ok(ids.length - before.length <= 1, `${c.name} @ ${kill.point}: at most the operator's own new record`);
        const named = new Set<string>();
        for (const h of p.core.holds.all()) for (const m of Object.values(h.blobs) as Array<Record<string, string>>) for (const o of Object.values(m)) if (o !== ABSENT) named.add(o);
        for (const o of named) assert.equal(await p.core.repo.hasObject(o as Oid, 'blob'), true, `${c.name} @ ${kill.point}: blob ${o} survived gc`);
        assert.deepEqual(p.core.holds.local().inflight, {}, `${c.name} @ ${kill.point}: no inflight entry left`);
        await check(p);
      });
    }
  });
}

// EF4 round 2 K-1 (ruling R3-EF4-15): a K4 at a path of a two-path markers record takes the companion route in two registry commits — the
// K4 record with marker-free stages (registry.cas #1/#2), then its marker companion (#3/#4) — before the TIP write. Killed after the first
// commit: the K4 record masks p and the marker file is still on disk (no companion yet); after the second or inside the write before the
// target moved (phase1): the companion is redundant and settleHoldOps ends it GONE by observation; after the write (phase2): the restart
// decision moves the K4 OFF_DISK and the companion keeps the marker file. No record but a marker companion ever holds the marker file.
// Between the two commits no record names the marker blob (it is only on disk and in the private index): a `gc --prune=now` there makes
// the restart's first tick meet E16-D (the private index names a missing object; EF4 round 2 R-1 reseeds from state:snap), so that kill
// restarts without the prune here; git's own gc never prunes an object that young.
test('K-1 crash: a K4 at a path of a two-path markers record killed at each commit and in the write, gc --prune=now, restart', T10, async () => {
  const kills = [{ point: 'registry.cas', nth: 2 }, { point: 'registry.cas', nth: 4 }, { point: 'apply.group.phase1', nth: 1 }, { point: 'apply.group.phase2', nth: 1 }] as const;
  const want: Record<string, string> = {
    'registry.cas#2': 'rows/ON_DISK/CONFLICTED/', 'registry.cas#4': 'rows/ON_DISK/CONFLICTED/GONE',
    'apply.group.phase1#1': 'rows/ON_DISK/CONFLICTED/GONE', 'apply.group.phase2#1': 'TIP/OFF_DISK/CONFLICTED/PARKED',
  };
  for (const kill of kills) {
    await withPeers(`k1-crash-${kill.point}-${kill.nth}`, { files: { ...CRASH_FILES, [U]: buf(T9) } }, async (fx) => {
      const p = fx.peers[0]!;
      await writeWork(p, P, ROWS);
      await writeWork(p, U, t9([3, 'held u']));
      const it0 = await prepIt(p, { holdPaths: [P, U] });
      const a = it0.A.get(P)!.oid;
      const heldP = await blob(p, t9([2, 'two']));
      const r = await p.core.holds.hold(nr({
        guard: 'markers', origin: 'daemon', paths: [P, U], blobs: { h0: { [P]: a, [U]: a }, h1: { [P]: heldP, [U]: await blob(p, t9([3, 'held u'])) } },
      }));
      await fx.pushTeamChange({ [P]: buf(t9([2, 'TEAM2'])) });
      fx.advance(10_000);
      const it = await prepIt(p, { forceFetch: true });
      const tip = it.tipMap.get(P)!.oid;
      await killedAt(kill.point, kill.nth, () => applyStep(p.core, it));
      const name = `${kill.point}#${kill.nth}`;
      if (name !== 'registry.cas#2') await gitIn(p, ['gc', '-q', '--prune=now']);
      await restartCore(p);
      await restart(p.core);
      const k4s = p.core.holds.all().filter((h) => h.id !== r && h.guards.some((g) => g.name === 'conflict'));
      assert.equal(k4s.length, 1, `${name}: one K4 record`);
      const k = k4s[0]!;
      const comps = p.core.holds.companionsOf(k.id);
      const disk = (await readWork(p, P))!.toString('utf8');
      const shape = `${disk === ROWS ? 'rows' : disk === t9([2, 'TEAM2']) ? 'TIP' : 'other'}/${k.residence}/${k.state}/${comps.map((c) => c.state).join(',')}`;
      assert.equal(shape, want[name], name);
      assert.deepEqual(k.blobs, stages(a, heldP, tip), `${name}: the K4 record's stages are marker-free`);
      for (const c of comps) assert.deepEqual([c.local_only, c.blobs], [true, pair(a, await blob(p, ROWS))], `${name}: the companion holds the marker file`);
      for (const h of p.core.holds.all()) {
        if (p.core.holds.isCompanion(h.id)) continue;
        for (const m of Object.values(h.blobs) as Array<Record<string, string>>) {
          for (const o of Object.values(m)) if (o !== ABSENT) assert.ok(!/^(<{7}|\|{7}|>{7}) cowork:/m.test((await p.core.repo.readBlob(o as Oid)).toString('utf8')), `${name}: ${h.id} holds a restore-marker blob`);
        }
      }
      for (const h of p.core.holds.all()) for (const m of Object.values(h.blobs) as Array<Record<string, string>>) for (const o of Object.values(m)) if (o !== ABSENT) assert.equal(await p.core.repo.hasObject(o as Oid, 'blob'), true, `${name}: blob ${o} survived gc`);
      assert.deepEqual(p.core.holds.local().inflight, {}, `${name}: no inflight entry left`);
    });
  }
});

// EF4 round 2 K-2 (ruling R3-EF4-15; HLD-08, HLD-41): the restart decision of an apply killed after its verified TIP write treats EVERY
// K4 record of p as the TAKE_TIP it is — a PIN target too (HLD-07 attaches a K4 to an ON_DISK PIN of the same path set; R3-EF4-7's markers
// PIN) — so the PIN goes OFF_DISK in the decision and HLD-41 sees a `take_tip` write: a ready pair whose R[p] conflicts with TIP is
// cancelled whole, as the in-process apply cancels it. Before, the decision's records were PATCH-only: the write counted as `clean`,
// HLD-41 took the written TIP[p] into R and kept the pair — its other paths would publish without its p change (that change only in the
// K4's s2) — and the PIN waited for settleHoldOps' completion.
test('K-2 crash: a K4 onto an ON_DISK PIN killed after the TIP write: the restart decision moves the PIN OFF_DISK and cancels the ready pair carrying p', T10, async () => {
  await withPeers('k2-crash-pin', { files: { ...CRASH_FILES, 'src/other.txt': buf('other\n') } }, async (fx) => {
    const p = fx.peers[0]!;
    // A ready pair carrying P (row 2) and src/other.txt, then a PIN over [P] (an ON_DISK `join` PIN, HLD-07's K4 target).
    const { pair: ready } = await editAndCapture(fx, p, { [P]: t9([2, 'two local']), 'src/other.txt': 'other, local\n' });
    const it0 = await prepIt(p, { holdPaths: [P] });
    const a = it0.A.get(P)!.oid;
    const pin = await p.core.holds.hold(nr({ kind: 'PIN', guard: 'join', origin: 'daemon', blobs: pair(a, a) }));
    const { live } = await fx.pushTeamChange({ [P]: buf(t9([2, 'two team'])) });
    fx.advance(10_000);
    const it = await prepIt(p, { forceFetch: true });
    const team = await writerOf(p, live);
    const tip = it.tipMap.get(P)!.oid;
    await killedAt('apply.group.phase2', 1, () => applyStep(p.core, it));
    const before = p.core.holds.get(pin)!;
    assert.deepEqual([before.residence, before.state, before.guards.map((g) => g.name)], ['ON_DISK', 'CONFLICTED', ['join', 'conflict']]);
    assert.deepEqual(await readWork(p, P), buf(t9([2, 'two team'])), 'TIP[p] is on disk');
    await gitIn(p, ['gc', '-q', '--prune=now']);
    await restartCore(p);
    const report = await restart(p.core);
    assert.equal(report.intent, 'apply');
    const rec = p.core.holds.get(pin)!;
    assert.deepEqual([rec.kind, rec.residence, rec.state, rec.guards.map((g) => g.name)], ['PIN', 'OFF_DISK', 'CONFLICTED', ['join', 'conflict']]);
    assert.deepEqual(rec.blobs, stages(a, await blob(p, t9([2, 'two local'])), tip));
    assert.equal(rec.displaced_by, team.op);
    assert.ok(ready.paths.includes(P) && ready.paths.includes('src/other.txt'), JSON.stringify(ready.paths));
    assert.ok(!p.core.view!.ready.some((x) => x.csId === ready.csId), 'HLD-41 take_tip: the ready pair carrying p is cancelled whole, as in-process');
  });
});

test('Review Focus 3: a two-path PIN PARK killed at apply.group.mid, gc --prune=now, restart: both paths end on one side', T10, async () => {
  // The brief's Crashpoints line: apply.group.mid fires between the paths of a two-path group (writer phase 2, i > 0).
  await withPeers('rf3-park-mid', { files: { ...CRASH_FILES, [U]: buf(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    const OLD_P = t9([2, 'pin p']);
    const OLD_U = t9([3, 'pin u']);
    await writeWork(p, P, OLD_P);
    await writeWork(p, U, OLD_U);
    const it = await prepIt(p, { holdPaths: [P, U] });
    const t = it.A.get(P)!.oid;
    const id = await p.core.holds.hold(nr({ kind: 'PIN', guard: 'join', paths: [P, U], blobs: { h0: { [P]: t, [U]: t }, h1: { [P]: t, [U]: t } } }));
    await killedAt('apply.group.mid', 1, () => park(p.core, it, id, HUMAN_PARK));
    await gitIn(p, ['gc', '-q', '--prune=now']);
    await restartCore(p);
    await restart(p.core);
    const r = p.core.holds.get(id)!;
    const dP = (await readWork(p, P))!.toString('utf8');
    const dU = (await readWork(p, U))!.toString('utf8');
    const side = `${dP === OLD_P && dU === OLD_U ? 'old' : dP === T9 && dU === T9 ? 'target' : `mixed:${dP}|${dU}`}/${r.residence}/${r.state}`;
    assert.ok(['old/ON_DISK/ACTIVE', 'target/OFF_DISK/PARKED'].includes(side), side);
    assert.deepEqual(p.core.holds.local().inflight, {}, 'the in-flight entry is cleared');
    assert.ok('h1' in r.blobs);
    assert.deepEqual([r.blobs.h1[P], r.blobs.h1[U]], [await blob(p, OLD_P), await blob(p, OLD_U)], 'the refreshed held side holds both disk versions');
    for (const o of [r.blobs.h1[P], r.blobs.h1[U]]) assert.equal(await p.core.repo.hasObject(o as Oid, 'blob'), true, 'survived gc');
  });
});

test('settleHoldOps settles inflight operators by DISK_EQ', T10, async () => {
  const W = 'src/w9.txt';
  const X = 'src/x9.txt';
  await withPeers('settle-disk-eq', { files: { ...CRASH_FILES, [U]: buf(T9), 'src/other.txt': buf('other\n'), [W]: buf(T9), [X]: buf(T9) } }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p);
    const t = await blob(p, T9);
    const six = await blob(p, t9([6, 'six']));
    const two = await blob(p, t9([2, 'two']));
    const four = await blob(p, t9([4, 'four']));
    const other = await blob(p, 'other\n');
    // A park whose write completed (disk = target), a restore whose write completed, a park that never wrote (disk = pre-image)
    // and a park whose disk is neither.
    const parked = await p.core.holds.hold(nr({ blobs: pair(t, two) }));
    const restored = await p.core.holds.hold(nr({ paths: [U], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(t, four, U) }));
    const unwritten = await p.core.holds.hold(nr({ paths: ['src/other.txt'], blobs: pair(other, await blob(p, 'other, held\n'), 'src/other.txt') }));
    const changedHeld = await p.core.holds.hold(nr({ paths: [W], blobs: pair(t, two, W) }));
    const changedGone = await p.core.holds.hold(nr({ paths: [X], blobs: pair(t, two, X) }));
    const parkFinal = { residence: 'OFF_DISK' as const, state: 'PARKED' as const, displaced_by: null };
    await p.core.holds.commitMany([], [], { setInflight: {
      [parked]: { op: 'park', entries: [{ path: P, expected: two, target: six }], final: parkFinal, explicit: false },
      [restored]: { op: 'restore', entries: [{ path: U, expected: t, target: four }], final: { residence: 'ON_DISK', state: 'ACTIVE', guards: [makeGuard('revert')] }, explicit: true },
      [unwritten]: { op: 'park', entries: [{ path: 'src/other.txt', expected: other, target: await blob(p, 'other, parked\n') }], final: parkFinal, explicit: false },
      [changedHeld]: { op: 'park', entries: [{ path: W, expected: two, target: t }], final: parkFinal, explicit: false },
      [changedGone]: { op: 'park', entries: [{ path: X, expected: two, target: t }], final: parkFinal, explicit: false },
    } });
    await writeWork(p, P, t9([6, 'six']));
    await writeWork(p, U, t9([4, 'four']));
    await writeWork(p, W, t9([2, 'two'], [9, 'nine']));
    await writeWork(p, X, t9([9, 'nine']));
    const log = recordLog(p);
    await settleHoldOps(p.core);
    assert.deepEqual(p.core.holds.local().inflight, {}, 'every entry cleared');
    const st = (id: string): string => `${p.core.holds.get(id)!.residence}/${p.core.holds.get(id)!.state}`;
    assert.equal(st(parked), 'OFF_DISK/PARKED', 'all targets: the final patch');
    assert.equal((await p.core.repo.readTreeMap(p.core.view!.snap)).get(P)?.oid, six, "a park's snap transition");
    assert.equal(st(restored), 'ON_DISK/ACTIVE');
    assert.ok(p.core.holds.local().explicit.includes(restored), 'explicit for a restore');
    assert.equal(st(unwritten), 'ON_DISK/ACTIVE', 'all expected: only cleared');
    assert.equal(st(changedHeld), 'ON_DISK/ACTIVE', 'neither, the held change still on disk: the record left as it is (masked)');
    assert.equal(st(changedGone), 'OFF_DISK/PARKED', "neither, the held change no longer on disk (R1 would end it GONE): the park's final patch");
    assert.equal((await p.core.repo.readTreeMap(p.core.view!.snap)).get(X)?.oid, t, 'no snap transition: the disk is not the target');
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_DISK_CHANGED').map((l) => l.params), [{ hid: changedHeld }, { hid: changedGone }]);
  });
});

test('settleHoldOps completes an interrupted ON_DISK --discard with its discard trace and no unregistered log code', T10, async () => {
  await withPeers('settle-discard', { files: CRASH_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p);
    const t = await blob(p, T9);
    const two = await blob(p, t9([2, 'two']));
    const id = await p.core.holds.hold(nr({ blobs: pair(t, two) }));
    await p.core.holds.commitMany([], [], { setInflight: { [id]: { op: 'discard', entries: [{ path: P, expected: two, target: t }], final: { state: 'RESOLVED_DISCARD' }, explicit: false } } });
    const log = recordLog(p);
    const from = fx.trace.events.length;
    await settleHoldOps(p.core);
    assert.equal(p.core.holds.get(id)!.state, 'RESOLVED_DISCARD', 'the disk is the target: the final patch');
    assert.deepEqual(p.core.holds.local().inflight, {});
    assert.deepEqual(fx.trace.since(from).filter((e) => e.kind === 'discard').map((e) => (e as { id: string }).id), [id], "R3-28's discard trace");
    // Task 11: R3-28's daemon log line, HOLD_DISCARDED, a registered log-only code (HOLD_LOG_CODES; HOLD_CODES stays 38).
    const registered = new Set([...HOLD_CODES, ...HOLD_LOG_CODES, 'FROZEN', 'UNFROZEN']);
    assert.deepEqual(log.lines.filter((l) => !registered.has(l.code)).map((l) => l.code), [], 'every log code is a registered one (Codes constraint)');
    assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_DISCARDED').map((l) => l.params), [{ hid: id, rev: p.core.holds.get(id)!.rev, paths: P }], "R3-28's daemon log line");
  });
});

test('a PARK interrupted after its write whose disk then changed keeps the held change in a non-terminal record (no R1 GONE)', T10, async () => {
  // Finding 6 (INV-NOLOSS): registry.cas hit 3 (the snap transition committed, the final commit not) and apply.group.phase2 (the
  // write landed, nothing after it); the human then edits the same file elsewhere while the daemon is down. The held change `two`
  // is on disk nowhere, so leaving the record ON_DISK would let the next R1 end it GONE (its reverse merge leaves the disk as is).
  for (const kill of [{ point: 'registry.cas', nth: 3 }, { point: 'apply.group.phase2', nth: 1 }] as const) {
    await withPeers(`park-neither-${kill.point}`, { files: CRASH_FILES }, async (fx) => {
      const p = fx.peers[0]!;
      await writeWork(p, P, t9([2, 'two'], [6, 'six']));
      const it = await prepIt(p, { holdPaths: [P] });
      const two = await blob(p, t9([2, 'two']));
      const id = await p.core.holds.hold(nr({ blobs: pair(it.A.get(P)!.oid, two) }));
      await killedAt(kill.point, kill.nth, () => park(p.core, it, id, HUMAN_PARK));
      assert.deepEqual(await readWork(p, P), buf(t9([6, 'six'])), 'the park wrote its target');
      const EDIT = t9([6, 'six'], [9, 'nine by the human']);
      await writeWork(p, P, EDIT);
      await gitIn(p, ['gc', '-q', '--prune=now']);
      await restartCore(p);
      await restart(p.core);
      // The next materializing iteration runs R1 on every ON_DISK record.
      fx.advance(2_500);
      await evaluateRecords(p.core, await prepIt(p, { materialize: true }), new Set(), []);
      const r = p.core.holds.get(id)!;
      assert.deepEqual([r.residence, r.state], ['OFF_DISK', 'PARKED'], `${kill.point}: the held change keeps a non-terminal home`);
      assert.equal('h1' in r.blobs ? r.blobs.h1[P] : null, two, 'h1 still holds two');
      assert.deepEqual(await readWork(p, P), buf(EDIT), "the human's edit is untouched");
      assert.deepEqual(p.core.holds.local().inflight, {}, 'the in-flight entry is cleared');
    });
  }
});

test('a PARK killed before its write whose disk then changed elsewhere stays ON_DISK with the held change masked', T10, async () => {
  // Finding 6, the quadrant that must not move: registry.cas hit 2 (the in-flight entry committed, nothing written); the human edits
  // another row, so the disk is neither the pre-image nor the target, but the held change is still on it.
  await withPeers('park-neither-unwritten', { files: CRASH_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two'], [6, 'six']));
    const it = await prepIt(p, { holdPaths: [P] });
    const two = await blob(p, t9([2, 'two']));
    const id = await p.core.holds.hold(nr({ blobs: pair(it.A.get(P)!.oid, two) }));
    await killedAt('registry.cas', 2, () => park(p.core, it, id, HUMAN_PARK));
    const EDIT = t9([2, 'two'], [6, 'six'], [9, 'nine by the human']);
    await writeWork(p, P, EDIT);
    await restartCore(p);
    await restart(p.core);
    fx.advance(2_500);
    await evaluateRecords(p.core, await prepIt(p, { materialize: true }), new Set(), []);
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state], ['ON_DISK', 'ACTIVE'], 'the held change is on disk: masked, never OFF_DISK');
    assert.deepEqual(await readWork(p, P), buf(EDIT));
    assert.deepEqual(p.core.holds.local().inflight, {});
    // Final review r3 A3-2: r's reverse merge alone is clean on this disk (the edit is elsewhere), so no safety copy is made.
    assert.deepEqual(p.core.holds.nonTerminal().map((x) => x.id), [id], 'no safety copy');
  });
});

// Plan 3 final review r3, A3-2 (Ruling R3-FF3-A2, INV-NOLOSS; r2 fix A concern 1, rereview A outOfScope[0]): a park that is not whole
// — an ACTIVE PATCH whose target is its step-5 MASK alone, so its held side stays r's own change — killed after its write, with the
// human's offline edit on r's own line. r's reverse merge alone conflicts on that disk, so nothing lands and r stays ON_DISK; when the
// line later returns to A's text R1 ends r GONE, and r's change was on no disk. A safety copy (h0 = the park's target, h1 = its
// pre-image) keeps it whenever r's reverse-alone merge on the current disk conflicts; the 'killed before its write' shape above makes none.
test('a MASK-alone park interrupted after its write, with an offline edit of the held line, keeps the held change in a copy after the line returns to A (final review r3 A3-2)', T10, async () => {
  // (The `revert` case: final review r3 A3-4 — the copy keeps r's `revert`.)
  const cases = [
    { guard: 'restart', kill: { point: 'registry.cas', nth: 3 } }, { guard: 'restart', kill: { point: 'apply.group.phase2', nth: 1 } },
    { guard: 'revert', kill: { point: 'registry.cas', nth: 3 } },
  ] as const;
  for (const { guard, kill } of cases) {
    await withPeers(`park-neither-maskalone-${guard}-${kill.point}`, { files: CRASH_FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const PRE = t9([2, 'two'], [6, 'six']);
      const TARGET = t9([6, 'six']);
      await writeWork(p, P, PRE);
      const it = await prepIt(p, { holdPaths: [P] });
      const a = it.A.get(P)!.oid;
      const two = await blob(p, t9([2, 'two']));
      const id = await p.core.holds.hold(nr({ guard, blobs: pair(a, two) }));
      await killedAt(kill.point, kill.nth, () => park(p.core, it, id, HUMAN_PARK));
      assert.deepEqual(await readWork(p, P), buf(TARGET), "the park wrote r's step-5 MASK alone (the human's row 6 stays)");
      const parked = p.core.holds.get(id)!;
      assert.deepEqual([parked.residence, parked.state, parked.blobs], ['ON_DISK', 'ACTIVE', pair(a, two)], 'precondition: not a whole park (h1 not refreshed)');
      await writeWork(p, P, t9([2, 'two, edited by the human while the daemon is down'], [6, 'six']));
      await gitIn(p, ['gc', '-q', '--prune=now']);
      await restartCore(p);
      const log = recordLog(p);
      await restart(p.core);
      const r = p.core.holds.get(id)!;
      assert.deepEqual([r.residence, r.state], ['ON_DISK', 'ACTIVE'], `${kill.point}: nothing lands (the reverse merge of r alone conflicts)`);
      assert.deepEqual(p.core.holds.local().inflight, {}, 'the in-flight entry is cleared');
      // (A kill at apply.group.phase2 also leaves the writer's local intent journaled: ENG-54 keeps the human's edit in an ON_DISK
      // `restart` record of its own, not the copy.)
      const copies = p.core.holds.nonTerminal().filter((x) => x.id !== id && x.residence === 'OFF_DISK');
      assert.equal(copies.length, 1, `${kill.point}: one copy record: ${JSON.stringify(p.core.holds.nonTerminal().map((x) => [x.id === id ? 'r' : x.id, x.kind, x.residence, x.state]))}`);
      const copy = copies[0]!;
      assert.deepEqual([copy.kind, copy.state, copy.guards.map((g) => g.name), copy.origin], ['PATCH', 'PARKED', guard === 'revert' ? ['revert'] : [], r.origin]);
      assert.deepEqual(copy.blobs, pair(await blob(p, TARGET), await blob(p, PRE)), "h0 = the park's target, h1 = its pre-image");
      assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_DISK_CHANGED').map((l) => l.params), [{ hid: id, copy: copy.id }]);
      assert.deepEqual(p.core.holds.local().settleCopies, { [copy.id]: id });

      // The human puts line 2 back to A's text (and edits line 9): R1's reverse merge is clean and leaves the disk as is, so r ends GONE.
      fx.advance(2_500);
      await evaluateRecords(p.core, await prepIt(p, { materialize: true }), new Set(), []);
      const LATER = t9([6, 'six'], [9, 'nine, a later unrelated edit']);
      await writeWork(p, P, LATER);
      fx.advance(2_500);
      await prepIt(p, { materialize: false });
      fx.advance(2_500);
      await evaluateRecords(p.core, await prepIt(p, { materialize: true }), new Set(), []);
      assert.equal(p.core.holds.get(id)!.state, 'GONE', 'R1 ended r GONE (the loss point the copy guards)');
      assert.deepEqual([p.core.holds.get(copy.id)!.residence, p.core.holds.get(copy.id)!.state], ['OFF_DISK', 'PARKED'], 'the copy is non-terminal');
      const out = await restore(p.core, await prepIt(p, { holdPaths: [P] }), copy.id, { humanEvidence: true, actor: 'human' });
      assert.deepEqual(out, { kind: 'RESTORED', markers: false });
      assert.deepEqual(await readWork(p, P), buf(t9([2, 'two'], [6, 'six'], [9, 'nine, a later unrelated edit'])), "--restore of the copy brings r's line back");
    });
  }
});

// Final review F2 (INV-NOLOSS; Task 5 carry 'FIX NEEDED, data safety'): a PIN or an UNSEPARABLE CONFLICTED record (carrying conflict,
// claim-breach or base-move) is parked whole — its held side refreshed := S_disk (Da), then A written. Killed after the write and before
// the final commit, with a human edit while the daemon is down, the restart settles 'neither'. R1's GONE for these records is S_disk == A,
// which an edited disk never is, so ruling (a)'s landing never fires: the record stayed ON_DISK holding a Da the disk no longer had, and
// the human's later return to A made R1 end it GONE (or a bundled capture refreshed its h1 first). Da was in no record and on no disk.
// The record still stays ON_DISK (masking: whether the edit came before or after the write cannot be told, and an edit made before it
// still holds the held change), and a guard-less OFF_DISK PARKED copy of the removed bytes keeps them, mirrored and restorable.
for (const shape of ['PIN', 'UNSEPARABLE'] as const) {
  test(`a ${shape === 'PIN' ? 'PIN' : 'CONFLICTED base-move PATCH'} PARK interrupted after its write whose disk then changed keeps the removed bytes in a restorable OFF_DISK copy, and R1 ending the record GONE later loses nothing (final review F2)`, T10, async () => {
    for (const kill of [{ point: 'registry.cas', nth: 3 }, { point: 'apply.group.phase2', nth: 1 }] as const) {
      await withPeers(`park-neither-${shape}-${kill.point}`, { files: CRASH_FILES }, async (fx) => {
        const p = fx.peers[0]!;
        const DA = t9([2, 'two, local work the park removes']);
        await writeWork(p, P, DA);
        const it = await prepIt(p, { holdPaths: [P] });
        const a = it.A.get(P)!.oid;
        const da = await blob(p, DA);
        const id = await p.core.holds.hold(shape === 'PIN'
          ? nr({ kind: 'PIN', guard: 'join', blobs: pair(a, a) })
          : nr({ state: 'CONFLICTED', guard: 'base-move', blobs: pair(a, da) }));
        await killedAt(kill.point, kill.nth, () => park(p.core, it, id, HUMAN_PARK));
        assert.deepEqual(await readWork(p, P), buf(T9), `${kill.point}: the park wrote A[p]`);
        const EDIT = t9([8, 'eight, by the human while the daemon was down']);
        await writeWork(p, P, EDIT);
        await gitIn(p, ['gc', '-q', '--prune=now']);
        await restartCore(p);
        const log = recordLog(p);
        await restart(p.core);
        const r = p.core.holds.get(id)!;
        assert.equal(r.residence, 'ON_DISK', `${kill.point}: the record stays ON_DISK (it may still mask the held change)`);
        assert.deepEqual(p.core.holds.local().inflight, {}, 'the in-flight entry is cleared');
        // (A kill at apply.group.phase2 also leaves the writer's local intent journaled: its restart resolution keeps the human's edit in
        // a `restart` record, ENG-54 — an ON_DISK record of its own, not the copy.)
        const others = p.core.holds.nonTerminal().filter((x) => x.id !== id);
        const copies = others.filter((x) => x.residence === 'OFF_DISK');
        assert.equal(copies.length, 1, `${kill.point}: one copy record: ${JSON.stringify(others.map((x) => [x.kind, x.residence, x.state, x.guards.map((g) => g.name)]))}`);
        const copy = copies[0]!;
        assert.deepEqual([copy.kind, copy.residence, copy.state, copy.guards.length, copy.origin, copy.local_only], ['PATCH', 'OFF_DISK', 'PARKED', 0, r.origin, false]);
        assert.deepEqual(copy.blobs, pair(a, da), 'h0 = what the park wrote (A[p]), h1 = the bytes it removed (Da)');
        assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_DISK_CHANGED').map((l) => l.params), [{ hid: id, copy: copy.id }]);
        assert.deepEqual(await readWork(p, P), buf(EDIT), "the human's edit is untouched");

        // The human returns the file to A: R1 ends the record GONE (S_disk == A); the copy keeps Da.
        await writeWork(p, P, T9);
        fx.advance(2_500);
        await evaluateRecords(p.core, await prepIt(p, { materialize: true }), new Set(), []);
        assert.equal(p.core.holds.get(id)!.state, 'GONE', 'R1 ended the record GONE');
        assert.deepEqual([p.core.holds.get(copy.id)!.residence, p.core.holds.get(copy.id)!.state], ['OFF_DISK', 'PARKED'], 'the copy is non-terminal');
        // --restore of the copy brings the removed bytes back (RESTORE: mf(disk = A, h0 = A, h1 = Da) = Da).
        const out = await restore(p.core, await prepIt(p, { holdPaths: [P] }), copy.id, { humanEvidence: true, actor: 'human' });
        assert.deepEqual(out, { kind: 'RESTORED', markers: false });
        assert.deepEqual(await readWork(p, P), buf(DA), 'Da is back on disk');
      });
    }
  });
}

// Plan 3 final review r2, A-1 (INV-NOLOSS; Ruling R3-FF2-A1, Task 5 ruling (a) amended): the F2 sibling goneOnlyAtA left open. A whole
// park of a PATCH that is not UNSEPARABLE also refreshes its held side := S_disk (Da) and writes A[p]: a CONFLICTED revert PATCH, an
// ACTIVE PATCH that the park's own step-5 merge makes CONFLICTED (HLD-15's adjacent-line edit), and a whole-path-guard PATCH (eol-bom).
// Killed after the write, the human edits the same line while the daemon is down, so R1's reverse merge on the edited disk conflicts:
// nothing lands, and the record stays ON_DISK holding a Da the disk no longer has. When the human later returns the file to A, the
// reverse merge is clean and R1 ends the record GONE — Da must still be held by a non-terminal record (the safety copy).
const WHOLE_PATCH_SHAPES = [
  { name: 'CONFLICTED revert PATCH', disk: t9([2, 'two, local work the park removes']), held: t9([2, 'two, local work the park removes']), state: 'CONFLICTED', parkedState: 'CONFLICTED', guard: 'revert' },
  { name: 'ACTIVE PATCH made CONFLICTED by its park (HLD-15)', disk: t9([2, 'two, local work the park removes'], [3, 'three, an adjacent human edit']), held: t9([2, 'two, local work the park removes']), state: 'ACTIVE', parkedState: 'CONFLICTED', guard: 'restart' },
  { name: 'whole-path-guard (eol-bom) PATCH', disk: t9([2, 'two, local work the park removes']), held: t9([2, 'two, local work the park removes']), state: 'ACTIVE', parkedState: 'ACTIVE', guard: 'eol-bom' },
] as const;
for (const shape of WHOLE_PATCH_SHAPES) {
  test(`a whole park of a ${shape.name} interrupted after its write, with an offline edit of the held line, keeps Da in a non-terminal record after disk == A (final review r2 A-1)`, T10, async () => {
    for (const kill of [{ point: 'registry.cas', nth: 3 }, { point: 'apply.group.phase2', nth: 1 }] as const) {
      await withPeers(`park-neither-whole-${shape.guard}-${kill.point}`, { files: CRASH_FILES }, async (fx) => {
        const p = fx.peers[0]!;
        await writeWork(p, P, shape.disk);
        const it = await prepIt(p, { holdPaths: [P] });
        const a = it.A.get(P)!.oid;
        const da = await blob(p, shape.disk);
        const id = await p.core.holds.hold(nr({ state: shape.state, guard: shape.guard, blobs: pair(a, await blob(p, shape.held)) }));
        await killedAt(kill.point, kill.nth, () => park(p.core, it, id, HUMAN_PARK));
        assert.deepEqual(await readWork(p, P), buf(T9), `${kill.point}: the park wrote A[p]`);
        const parked = p.core.holds.get(id)!;
        assert.deepEqual([parked.residence, parked.state, 'h1' in parked.blobs ? parked.blobs.h1[P] : null], ['ON_DISK', shape.parkedState, da],
          'precondition: a whole park (its held side := S_disk, CONFLICTED where the park made it so), killed before its final commit');
        await writeWork(p, P, t9([2, 'two, the human edits the same line while the daemon is down']));
        await gitIn(p, ['gc', '-q', '--prune=now']);
        await restartCore(p);
        const log = recordLog(p);
        await restart(p.core);
        const r = p.core.holds.get(id)!;
        assert.equal(r.residence, 'ON_DISK', `${kill.point}: R1's reverse merge conflicts on the edited disk, so nothing lands`);
        assert.deepEqual(p.core.holds.local().inflight, {}, 'the in-flight entry is cleared');
        const others = p.core.holds.nonTerminal().filter((x) => x.id !== id);
        const copies = others.filter((x) => x.residence === 'OFF_DISK');
        assert.equal(copies.length, 1, `${kill.point}: one copy record: ${JSON.stringify(others.map((x) => [x.kind, x.residence, x.state, x.guards.map((g) => g.name)]))}`);
        const copy = copies[0]!;
        // Final review r3 A3-4: the copy of a record carrying `revert` keeps that guard alone; the other shapes' copies are guard-less.
        assert.deepEqual([copy.kind, copy.residence, copy.state, copy.guards.map((g) => g.name), copy.origin], ['PATCH', 'OFF_DISK', 'PARKED', shape.guard === 'revert' ? ['revert'] : [], r.origin]);
        assert.deepEqual(copy.blobs, pair(a, da), 'h0 = what the park wrote (A[p]), h1 = the bytes it removed (Da)');
        assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_DISK_CHANGED').map((l) => l.params), [{ hid: id, copy: copy.id }]);

        // The human returns the file to A: R1's reverse merge is clean there and ends the record GONE; Da is still held.
        await writeWork(p, P, T9);
        fx.advance(2_500);
        await evaluateRecords(p.core, await prepIt(p, { materialize: true }), new Set(), []);
        assert.equal(p.core.holds.get(id)!.state, 'GONE', 'R1 ended the record GONE (the loss point the copy guards)');
        const holdingDa = p.core.holds.nonTerminal().filter((x) => 'h1' in x.blobs && x.blobs.h1[P] === da).map((x) => x.id);
        assert.deepEqual(holdingDa, [copy.id], 'Da is held by a non-terminal record after disk == A');
        const out = await restore(p.core, await prepIt(p, { holdPaths: [P] }), copy.id, { humanEvidence: true, actor: 'human' });
        assert.deepEqual(out, { kind: 'RESTORED', markers: false });
        assert.deepEqual(await readWork(p, P), buf(shape.disk), 'Da is back on disk');
      });
    }
  });
}

// Plan 3 final review r3, A3-1 (Ruling R3-FF3-A1; r2 rereview A, A-1 residual and newBreakage[0]): a guard-less ON_DISK PATCH is
// parkable (--publish released its guards and it stays ON_DISK ACTIVE until RESOLVED_PUBLISH, R3-17). Its whole park (made CONFLICTED
// by its own step-5 merge, HLD-15) refreshes h1 := Da, so at restart the guard-less safety copy (h0 = A, h1 = Da) used to attach to r
// itself by HLD-07's guard-less twin rule: no copy, HOLD_DISK_CHANGED {hid: r, copy: r}, and R1 ending r GONE at disk == A lost Da.
// A settle copy never attaches to its parent or to any ON_DISK record; a repeat of the settlement still dedupes onto the earlier copy.
for (const explicit of [true, false]) {
  test(`a whole park of a guard-less ON_DISK PATCH (${explicit ? 'explicit' : 'not explicit'}) interrupted after its write keeps Da in a distinct OFF_DISK copy, never r itself, and a repeat settlement reuses that copy (final review r3 A3-1)`, T10, async () => {
    await withPeers(`park-neither-guardless-${explicit}`, { files: CRASH_FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const disk = t9([2, 'two, local work the park removes'], [3, 'three, an adjacent human edit']);
      await writeWork(p, P, disk);
      const it = await prepIt(p, { holdPaths: [P] });
      const a = it.A.get(P)!.oid;
      const da = await blob(p, disk);
      const id = await p.core.holds.hold(nr({ guard: 'restart', blobs: pair(a, await blob(p, t9([2, 'two, local work the park removes']))) }));
      await p.core.holds.transition(id, { guards: [] });   // released as --publish does: ON_DISK ACTIVE and guard-less (R3-17)
      if (explicit) await p.core.holds.markExplicit(id);
      await killedAt('registry.cas', 3, () => park(p.core, it, id, HUMAN_PARK));
      assert.deepEqual(await readWork(p, P), buf(T9), 'the park wrote A[p]');
      const parked = p.core.holds.get(id)!;
      assert.deepEqual([parked.residence, parked.state, parked.guards.length, 'h1' in parked.blobs ? parked.blobs.h1[P] : null], ['ON_DISK', 'CONFLICTED', 0, da],
        'precondition: a whole park of a guard-less PATCH (made CONFLICTED by its park, h1 := Da), killed before its final commit');
      await writeWork(p, P, t9([2, 'two, the human edits the same line while the daemon is down']));
      await gitIn(p, ['gc', '-q', '--prune=now']);
      await restartCore(p);
      const op = p.core.holds.local().inflight[id]!;
      const log = recordLog(p);
      await restart(p.core);
      assert.equal(p.core.holds.get(id)!.residence, 'ON_DISK', 'nothing lands: the reverse merge conflicts on the edited disk');
      const copiesNow = (): HoldRecord[] => p.core.holds.nonTerminal().filter((x) => x.id !== id && x.residence === 'OFF_DISK');
      assert.equal(copiesNow().length, 1, `one copy record besides r: ${JSON.stringify(p.core.holds.nonTerminal().map((x) => [x.id === id ? 'r' : x.id, x.kind, x.residence, x.state]))}`);
      const copy = copiesNow()[0]!;
      assert.notEqual(copy.id, id);
      assert.deepEqual([copy.kind, copy.state, copy.guards.length, copy.blobs], ['PATCH', 'PARKED', 0, pair(a, da)], 'h0 = A[p], h1 = Da');
      assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_DISK_CHANGED').map((l) => l.params), [{ hid: id, copy: copy.id }], 'copy names another record than hid');
      assert.deepEqual(p.core.holds.local().settleCopies, { [copy.id]: id }, 'the copy is marked');

      // A repeat of the same settlement (a kill before its in-flight entry was cleared) attaches to the copy made the first time.
      await p.core.holds.commitMany([], [], { setInflight: { [id]: op } });
      await settleHoldOps(p.core);
      assert.deepEqual(copiesNow().map((x) => x.id), [copy.id], 'no second copy');
      assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_DISK_CHANGED').map((l) => l.params), [{ hid: id, copy: copy.id }, { hid: id, copy: copy.id }]);
      assert.deepEqual(p.core.holds.local().settleCopies, { [copy.id]: id });

      // The human returns the file to A: R1 ends r GONE; Da is still held by the copy.
      await writeWork(p, P, T9);
      fx.advance(2_500);
      await evaluateRecords(p.core, await prepIt(p, { materialize: true }), new Set(), []);
      assert.equal(p.core.holds.get(id)!.state, 'GONE', 'R1 ended r GONE (the loss point the copy guards)');
      const holdingDa = p.core.holds.nonTerminal().filter((x) => 'h1' in x.blobs && x.blobs.h1[P] === da).map((x) => x.id);
      assert.deepEqual(holdingDa, [copy.id], 'Da is held by a non-terminal record after disk == A');
    });
  });
}

// Plan 3 final review r3, A3-3 (Ruling R3-FF3-A3; r2 fix A concern 4, rereview A A-1 'second gap'): an ACTIVE PATCH that R3-18 withheld
// whole only because its held side before the park was binary (S_disk, A and h0 text). The park refreshed h1 := Da (text), so settle,
// recomputing R3-18 from the refreshed record, saw text everywhere and took the park for a MASK-alone one. The whole-park decision is
// the park's own: a whole park settled 'neither' and not landed keeps its copy whenever the held side is not DISK_EQ (row 14), here an
// offline edit elsewhere in the file (r's reverse merge alone is clean there, so the MASK-alone rule would make none).
test('a park withheld whole by R3-18 only for its pre-park binary held side, interrupted after its write, is settled as a whole park (final review r3 A3-3)', T10, async () => {
  for (const kill of [{ point: 'registry.cas', nth: 3 }, { point: 'apply.group.phase2', nth: 1 }] as const) {
    await withPeers(`park-neither-binheld-${kill.point}`, { files: CRASH_FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const DA = t9([2, 'two, local work the park removes']);
      await writeWork(p, P, DA);
      const it = await prepIt(p, { holdPaths: [P] });
      const a = it.A.get(P)!.oid;
      const da = await blob(p, DA);
      const binHeld = await blob(p, Buffer.concat([buf('1\n'), Buffer.from([0, 1, 2]), buf('\nan older binary save\n')]));
      const id = await p.core.holds.hold(nr({ guard: 'restart', blobs: pair(a, binHeld) }));
      await killedAt(kill.point, kill.nth, () => park(p.core, it, id, HUMAN_PARK));
      assert.deepEqual(await readWork(p, P), buf(T9), `${kill.point}: the park wrote A[p] (withheld whole by R3-18)`);
      const parked = p.core.holds.get(id)!;
      assert.deepEqual([parked.residence, parked.state, parked.guards.map((g) => g.name), parked.blobs], ['ON_DISK', 'ACTIVE', ['restart'], pair(a, da)],
        'precondition: the whole park refreshed h1 := Da (text) and kept r ACTIVE');
      const EDIT = t9([2, 'two, local work the park removes'], [8, 'eight, by the human while the daemon was down']);
      await writeWork(p, P, EDIT);
      await gitIn(p, ['gc', '-q', '--prune=now']);
      await restartCore(p);
      const log = recordLog(p);
      await restart(p.core);
      assert.equal(p.core.holds.get(id)!.residence, 'ON_DISK', `${kill.point}: nothing lands (Da's change is still on disk)`);
      assert.deepEqual(p.core.holds.local().inflight, {}, 'the in-flight entry is cleared');
      const copies = p.core.holds.nonTerminal().filter((x) => x.id !== id && x.residence === 'OFF_DISK');
      assert.equal(copies.length, 1, `${kill.point}: one copy record: ${JSON.stringify(p.core.holds.nonTerminal().map((x) => [x.id === id ? 'r' : x.id, x.kind, x.residence, x.state]))}`);
      assert.deepEqual([copies[0]!.kind, copies[0]!.state, copies[0]!.blobs], ['PATCH', 'PARKED', pair(a, da)], 'h0 = A[p], h1 = Da');
      assert.deepEqual(log.lines.filter((l) => l.code === 'HOLD_DISK_CHANGED').map((l) => l.params), [{ hid: id, copy: copies[0]!.id }]);
      assert.deepEqual(await readWork(p, P), buf(EDIT), "the human's edit is untouched");
    });
  }
});

// Plan 3 final review r3, A3-4 (Ruling R3-FF3-A4, INV-HLD-NOREVERT; r2 rereview A outOfScope[1], guard laundering): the safety copy of a
// record carrying `revert` keeps that guard (and only that one). A guard-less copy, once --restore'd, was an ON_DISK ACTIVE record that
// masked nothing: the restored write is observed (HLD-26), so the revert detector skipped it and the human CS published the removal of
// a teammate's line without the --publish the original `revert` guard required.
test("the safety copy of a CONFLICTED revert PATCH keeps `revert`: after --restore the teammate's line stays on the live branch until --publish (final review r3 A3-4)", T10, async () => {
  await withPeers('settle-copy-revert', { files: CRASH_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const WITH_TEAM = '1\n2\n3\n4\nTEAM = 1\n5\n6\n7\n8\n9\n';
    await prepIt(p);
    await fx.pushTeamChange({ [P]: buf(WITH_TEAM) });
    fx.advance(10_000);
    assert.ok((await applyStep(p.core, await prepIt(p, { forceFetch: true }))).ran, "the teammate's line is applied");
    assert.deepEqual(await readWork(p, P), buf(WITH_TEAM));
    // This peer's local work removes the teammate's line (Da), held by a CONFLICTED revert PATCH.
    await writeWork(p, P, T9);
    fx.advance(2_500);
    const it = await prepIt(p, { holdPaths: [P] });
    const a = it.A.get(P)!.oid;
    const da = await blob(p, T9);
    assert.equal(a, await blob(p, WITH_TEAM), 'precondition: A holds the teammate line');
    const id = await p.core.holds.hold(nr({ state: 'CONFLICTED', guard: 'revert', blobs: pair(a, da) }));
    await killedAt('registry.cas', 3, () => park(p.core, it, id, HUMAN_PARK));
    assert.deepEqual(await readWork(p, P), buf(WITH_TEAM), 'the whole park wrote A[p]');
    await writeWork(p, P, '1\n2\n3\n4, edited by the human while the daemon is down\nTEAM = 1\n5\n6\n7\n8\n9\n');
    await gitIn(p, ['gc', '-q', '--prune=now']);
    await restartCore(p);
    await restart(p.core);
    const copy = p.core.holds.nonTerminal().find((x) => x.id !== id && x.residence === 'OFF_DISK');
    assert.ok(copy !== undefined, `a safety copy: ${JSON.stringify(p.core.holds.nonTerminal().map((x) => [x.id === id ? 'r' : x.id, x.kind, x.residence, x.state]))}`);
    assert.deepEqual([copy.kind, copy.state, copy.blobs], ['PATCH', 'PARKED', pair(a, da)]);
    const copyGuards = copy.guards.map((g) => g.name);

    // The human returns the file to A (R1 ends r GONE), then restores the copy: Da (the removal) is back on disk.
    await writeWork(p, P, WITH_TEAM);
    fx.advance(2_500);
    await evaluateRecords(p.core, await prepIt(p, { materialize: true }), new Set(), []);
    assert.equal(p.core.holds.get(id)!.state, 'GONE');
    const res = await resolve(p.core, await prepIt(p, { holdPaths: [P] }), copy.id, 'restore', HUMAN);
    assert.deepEqual(res, { kind: 'done', code: 'HOLD_RESTORED', id: copy.id, created: null });
    assert.deepEqual(await readWork(p, P), buf(T9), 'the restore wrote Da');
    // The restored content closes in the human CS and is captured; no window publishes the teammate-line removal.
    fx.advance(3_000);
    await prepIt(p, { materialize: true });
    fx.advance(21_000);
    await captureReady(p, await prep(p, true));
    for (let i = 0; i < 3; i++) await win(fx, p);
    assert.equal((await remoteLive(fx, p)).get(P), a, "the live branch keeps the teammate's line after --restore");
    assert.deepEqual(copyGuards, ['revert'], 'the copy kept `revert` (only that guard)');
    const restored = p.core.holds.get(copy.id)!;
    assert.deepEqual([restored.residence, restored.state, restored.guards.map((g) => g.name)], ['ON_DISK', 'ACTIVE', ['revert']], 'restored, still guarded');

    // --publish is the human's release: the removal then publishes and the copy ends RESOLVED_PUBLISH.
    const pub = await resolve(p.core, await prepIt(p, { holdPaths: [P] }), copy.id, 'publish', HUMAN);
    assert.deepEqual(pub, { kind: 'done', code: 'RESOLVED_PUBLISH', id: copy.id, created: null });
    await captureAndLand(fx, p);
    assert.equal((await remoteLive(fx, p)).get(P), da, 'after --publish the removal publishes');
    assert.equal(p.core.holds.get(copy.id)!.state, 'RESOLVED_PUBLISH');
  });
});

test('a safety copy with h0 ABSENT is never settled as a collision-take capture at a later restart (final review r2 A-2)', T10, async () => {
  // The reachable case of rereview A newBreakage[0]: a PIN over a new local file (A lacks it) whose park deletes the file is killed
  // after the write, and the human recreates the file while the daemon is down: the restart keeps Da in a guard-less OFF_DISK PARKED
  // copy with h0 ABSENT — a collision-take capture's shape. At a LATER restart, a teammate's creation of the path has made an INCOMING
  // collision record and the disk holds Da again: R3-67's take settlement (the TIP write did not happen → GONE) must not end the copy.
  const N = 'src/new9.txt';
  await withPeers('settle-copy-not-take', { files: CRASH_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const DA = 'new local work the park removes\n';
    await writeWork(p, N, DA);
    const it = await prepIt(p, { holdPaths: [N] });
    assert.equal(it.A.has(N), false, 'precondition: A lacks the path');
    const da = await blob(p, DA);
    const id = await p.core.holds.hold(nr({ kind: 'PIN', guard: 'join', paths: [N], blobs: pair(ABSENT, da, N) }));
    await killedAt('registry.cas', 3, () => park(p.core, it, id, HUMAN_PARK));
    assert.equal(await readWork(p, N), null, 'the park deleted the file (its target A[p] is ABSENT)');
    await writeWork(p, N, 'recreated by the human while the daemon was down\n');
    await restartCore(p);
    await restart(p.core);
    const copy = p.core.holds.nonTerminal().find((x) => x.id !== id && x.residence === 'OFF_DISK');
    assert.ok(copy !== undefined, `the first restart keeps a safety copy: ${JSON.stringify(p.core.holds.nonTerminal().map((x) => [x.kind, x.residence, x.state]))}`);
    assert.deepEqual([copy.kind, copy.state, copy.guards.length, copy.blobs], ['PATCH', 'PARKED', 0, pair(ABSENT, da, N)], "h0 ABSENT: the take capture's shape");

    // Later, a teammate's creation of N has made an INCOMING collision record, and the disk happens to hold Da again.
    await p.core.holds.hold(nr({ kind: 'INCOMING', paths: [N], guard: 'collision', origin: 'daemon', blobs: pair(ABSENT, await blob(p, 'the team version\n'), N) }));
    await writeWork(p, N, DA);
    await restartCore(p);
    await restart(p.core);
    const after = p.core.holds.get(copy.id)!;
    assert.deepEqual([after.residence, after.state], ['OFF_DISK', 'PARKED'], 'the later restart leaves the safety copy (and its --restore handle) alone');
    assert.deepEqual(p.core.holds.local().settleCopies, { [copy.id]: id }, 'the mark outlives the restart that made the copy');
    // Once the copy has ended (here the human discarded it), the next restart drops its mark.
    await p.core.holds.transition(copy.id, { state: 'RESOLVED_DISCARD' });
    await restartCore(p);
    await restart(p.core);
    assert.equal(p.core.holds.local().settleCopies, undefined, 'an ended copy loses its mark at the next restart');
  });
});

test('settleHoldOps also runs on the lost-state restart path', T10, async () => {
  await withPeers('settle-lost-state', { files: CRASH_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([2, 'two']));
    const it = await prepIt(p, { holdPaths: [P] });
    const id = await p.core.holds.hold(nr({ kind: 'PIN', guard: 'join', blobs: pair(it.A.get(P)!.oid, it.A.get(P)!.oid) }));
    await killedAt('apply.group.phase2', 1, () => park(p.core, it, id, { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false }));
    assert.deepEqual(await readWork(p, P), buf(T9), 'disk = target');
    assert.equal(p.core.holds.local().inflight[id]?.op, 'park', 'inflight set');
    // A broken state ref (garbage after a power cut): the restart takes the lost-state branch.
    await writeFile(join(p.deps.paths.gitDir, ...p.core.refs.state.split('/')), 'garbage\n');
    await restartCore(p);
    const order: string[] = [];
    const commitMany = p.core.holds.commitMany.bind(p.core.holds);
    p.core.holds.commitMany = (c, patches, local) => {
      if ((local?.clearInflight ?? []).includes(id)) order.push(`settle:${p.core.view === null ? 'no-state' : 'state'}`);
      return commitMany(c, patches, local);
    };
    const report = await restart(p.core);
    assert.equal(report.lostState?.mode, 'lost_state');
    assert.deepEqual(order, ['settle:state'], 'settled once, after the rebuilt state was attached');
    const r = p.core.holds.get(id)!;
    assert.deepEqual([r.residence, r.state], ['OFF_DISK', 'PARKED'], 'the PARK completed');
    assert.deepEqual(p.core.holds.local().inflight, {}, 'inflight cleared');
  });
});

test('every displacing operator holds the bytes in a record before the disk changes', T10, async () => {
  await withPeers('record-before-displacement', { files: CRASH_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const seen: string[] = [];
    /** At the first .new of the next write: some record of the registry holds the disk's current clean blob as h1/s2. */
    const expectHeldAtNew = (path: string, what: string): void => {
      p.fs.interpose('writeFileExclusive', '.new', async () => {
        const disk = (await readWork(p, path))!;
        const clean = await p.core.repo.hashBytes(disk, false);
        const holds = (await headRecords(p)).some((r) => !['GONE', 'SUBSUMED'].includes(r.state) && (('h1' in r.blobs && r.blobs.h1[path] === clean) || ('s2' in r.blobs && r.blobs.s2[path] === clean)));
        seen.push(`${what}:${holds}`);
      });
    };
    // A PIN PARK (its held side refreshed first).
    await writeWork(p, P, t9([2, 'pin']));
    const it1 = await prepIt(p, { holdPaths: [P] });
    const pin = await p.core.holds.hold(nr({ kind: 'PIN', guard: 'join', blobs: pair(it1.A.get(P)!.oid, it1.A.get(P)!.oid) }));
    expectHeldAtNew(P, 'pin park');
    assert.equal((await park(p.core, it1, pin, { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false })).kind, 'PARKED');
    // A markers park.
    await writeWork(p, P, ROWS);
    fx.advance(2_500);
    const it2 = await prepIt(p, { holdPaths: [P] });
    const mk = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(it2.A.get(P)!.oid, await blob(p, t9([2, 'x'])), await blob(p, t9([2, 'y']))) }));
    expectHeldAtNew(P, 'markers park');
    assert.equal((await markersPark(p.core, it2, mk, { humanEvidence: true, displacedBy: null })).kind, 'PARKED');
    // A collision take.
    await writeWork(p, ENV, 'SECRET=local\n');
    await fx.pushTeamChange({ [ENV]: buf('SECRET=team\n') });
    const it3 = await prepIt(p, { forceFetch: true, materialize: true });
    const c = await p.core.holds.hold(nr({ kind: 'INCOMING', paths: [ENV], guard: 'collision', origin: 'daemon', blobs: pair(ABSENT, it3.tipMap.get(ENV)!.oid, ENV) }));
    expectHeldAtNew(ENV, 'take');
    assert.equal(await collisionTake(p.core, it3, c), 'WRITTEN');
    // An apply-side K4.
    await writeWork(p, P, t9([2, 'two local']));
    fx.advance(2_500);
    await prepIt(p);
    await fx.pushTeamChange({ [P]: buf(t9([2, 'two team'])) });
    fx.advance(10_000);
    const it4 = await prepIt(p, { forceFetch: true });
    expectHeldAtNew(P, 'k4');
    assert.ok((await applyStep(p.core, it4)).records.length === 1);
    assert.deepEqual(seen, ['pin park:true', 'markers park:true', 'take:true', 'k4:true']);
  });
});
