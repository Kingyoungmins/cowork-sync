// Restart (01-engine §3.14 Restart; ENG-53; Review Focus 5; 01-engine tests 26 single-run form and 38 (c); T-PRO-41;
// ruling R-24 and the Task 15 carry rulings): kills at the apply and publish crashpoints, then a process restart (a fresh
// EngineCore over the same clone) resolves the journal by observation. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { buildBoardCommit, readBoardCommit, type WriterId } from '../../src/board/boardCommit.js';
import { newEpoch, parseOpId } from '../../src/board/ids.js';
import { applyStep } from '../../src/engine/apply.js';
import { pathIsFiltered, prepareIteration } from '../../src/engine/core.js';
import { publishStep } from '../../src/engine/publish.js';
import { startDispatch } from '../../src/engine/start.js';
import type { Intent } from '../../src/engine/state.js';
import { orphanAside, type WriteEntry } from '../../src/engine/writer.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { realFs } from '../../src/ports/fs.js';
import type { Log, LogLevel, LogParam } from '../../src/ports/log.js';
import { seededRandom } from '../../src/ports/random.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blobText, buf, captureReady, editAndCapture, lines, LogRecorder, prep, remoteBoard, setMutants, treeOf, withCores, wrapGit } from '../helpers/publishHelpers.js';
import { gitIn, gitRemote, restartCore, startOk } from '../helpers/startFixture.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { SIM_WALL_EPOCH_MS, VirtualClock } from '../sim/vclock.js';

const row = (text: string, i: number, value: string): string => {
  const rs = text.split('\n');
  rs[i - 1] = value;
  return rs.join('\n');
};
const BASE = lines(12, (i) => `row ${i}`);
const FILES: Record<string, Buffer> = {
  'README.md': buf('# restart fixture\n'),
  'a.txt': buf(BASE),
  'b.txt': buf(BASE),
  'c.txt': buf(BASE),
  'd.txt': buf(BASE),
  'keep.txt': buf('keep\n'),
};
/** Real file-system time an hour before and after now (seconds, for utimes): before and after any restart marker. */
const PAST = (): number => (Date.now() - 3_600_000) / 1_000;
const FUTURE = (): number => (Date.now() + 3_600_000) / 1_000;

/** Throws KilledAt at the first hit of `point` (a dead process: the core is abandoned). */
async function killedAt<T>(point: string, fn: () => Promise<T>): Promise<void> {
  setCrashHandler((name) => {
    if (name === point) throw new KilledAt(name);
  });
  try {
    await assert.rejects(fn(), (e: unknown) => e instanceof KilledAt && e.point === point, `killed at ${point}`);
  } finally {
    setCrashHandler(null);
  }
}

/** Iterations with applies until A == tree(TIP) (at most 4). */
async function converge(fx: CoreFixture, p: PeerFixture): Promise<void> {
  for (let i = 0; i < 4; i++) {
    fx.advance(10_000);
    const it = await prep(p);
    const same = it.A.size === it.tipMap.size && [...it.tipMap].every(([k, e]) => it.A.get(k)?.oid === e.oid);
    if (same) return;
    await applyStep(p.core, it);
  }
}

/** The restart records (guard 'restart') of the peer naming `path`. */
function restartRecordsOf(p: PeerFixture, path: string): HoldRecord[] {
  return p.core.holds.nonTerminal().filter((h) => h.paths.includes(path) && h.guards.some((g) => g.name === 'restart'));
}

/** The held h1 blob of a record for `path`. */
function heldBlob(r: HoldRecord, path: string): string | undefined {
  return 'h1' in r.blobs ? r.blobs.h1[path] : undefined;
}

/** A log that records every line and appends it, synchronously, to a daemon log file (the R-37 form). */
class TeeLog implements Log {
  readonly lines: Array<{ level: LogLevel; code: string; params: Readonly<Record<string, LogParam>> }> = [];
  constructor(private readonly file: string) {}
  write(level: LogLevel, code: string, params?: Readonly<Record<string, LogParam>>): void {
    this.lines.push({ level, code, params: params ?? {} });
    appendFileSync(this.file, `${JSON.stringify({ t: 0, level, code, params: params ?? {} })}\n`);
  }
}

const tmpOf = (p: PeerFixture): string => join(p.deps.paths.coworkDir, 'tmp');
const oldsIn = (p: PeerFixture): string[] => readdirSync(tmpOf(p)).filter((n) => n.endsWith('.old')).sort();

/** An orphan name of ruling P2-ORPHANNAMES: tmp/orphan-<ULID>.<ext> (26 Crockford base32 characters). */
const ORPHAN_OLD_RE = /^orphan-[0-9A-HJKMNP-TV-Z]{26}\.old$/;
const orphanLine = (file: string, path: string | null): string => `${JSON.stringify({ t: 0, level: 'warn', code: 'WRITE_TMP_ORPHAN', params: { file, path, kept: true } })}\n`;

const APPLY_POINTS = ['apply.intent', 'apply.group.phase1', 'apply.group.mid', 'apply.group.phase2', 'apply.between_groups', 'apply.state'];

test('a kill at apply.intent, apply.group.phase1, apply.group.mid, apply.group.phase2, apply.between_groups or apply.state, then a teammate deleting the just-applied line and git gc --prune=now: after restart no resurrection, no missing path, O-REACH holds, every byte on disk or in a restart record', async () => {
  for (const point of APPLY_POINTS) {
    await withCores(`restart-${point}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      // A local edit the apply must merge and keep (b.txt row 10), and two incoming change-sets of two paths each.
      const LOCAL_B = row(BASE, 10, 'row 10 edited by p1');
      await writeWork(p, 'b.txt', LOCAL_B);
      await prep(p);
      const NEW_LINE = 'a line the teammate adds, then deletes';
      const A1 = BASE + `${NEW_LINE}\n`;
      await fx.pushTeamChange({ 'a.txt': buf(A1), 'b.txt': buf(row(BASE, 1, 'row 1 by the team')) });
      await fx.pushTeamChange({ 'c.txt': buf(row(BASE, 5, 'row 5 by the team')), 'd.txt': buf(row(BASE, 5, 'row 5 by the team')) });
      fx.advance(10_000);
      const it = await prep(p);
      await killedAt(point, () => applyStep(p.core, it));

      // The teammate deletes the line that was being applied; the dead process's unreachable objects are pruned.
      await fx.pushTeamChange({ 'a.txt': buf(BASE) });
      await gitIn(p, ['gc', '-q', '--prune=now']);

      await restartCore(p);
      const r = await startOk(p, 'restart');
      assert.ok(r.restart !== null);
      assert.equal(r.restart.intent, point === 'apply.state' ? 'none' : 'apply', `${point}: the journaled intent`);
      // O-REACH: every object the journaled state named survived the prune (else the state reads as lost), and so did
      // everything the resolved state and the registry name.
      assert.equal(r.restart.lostState, null, `${point}: the state survived git gc --prune=now`);
      const view = await p.core.state.read();
      assert.ok(view !== null && view.intent.kind === 'none', `${point}: the restart resolved the intent`);
      await p.core.holds.load();

      await converge(fx, p);
      const a = (await readWork(p, 'a.txt'))?.toString('utf8');
      assert.equal(a, BASE, `${point}: no resurrection of the deleted line`);
      for (const path of Object.keys(FILES)) assert.ok((await readWork(p, path)) !== null, `${point}: ${path} is on disk`);
      const b = (await readWork(p, 'b.txt'))?.toString('utf8') ?? '';
      if (!b.includes('row 10 edited by p1')) {
        // Every byte not on disk is in a restart record: the record's held blob carries the local edit.
        const held = restartRecordsOf(p, 'b.txt').map((h) => heldBlob(h, 'b.txt')).filter((o): o is string => o !== undefined && o !== ABSENT);
        assert.ok(held.length > 0, `${point}: the local edit of b.txt is not on disk, so a restart record holds it`);
        const texts = await Promise.all(held.map(async (o) => (await p.core.repo.readBlob(o as Oid)).toString('utf8')));
        assert.ok(texts.some((t) => t.includes('row 10 edited by p1')), `${point}: the record's blob carries the local edit`);
      }
      assert.ok(b.includes('row 1 by the team'), `${point}: the team edit of b.txt arrived`);
      assert.equal((await readWork(p, 'c.txt'))?.toString('utf8'), row(BASE, 5, 'row 5 by the team'), `${point}: c.txt converged`);
    });
  }
});

test('a kill at publish.out_built discards the intent; a kill at publish.sent or publish.landed resolves as landed by observation and nothing is published twice', async () => {
  for (const point of ['publish.out_built', 'publish.sent', 'publish.landed']) {
    await withCores(`restart-${point}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const { pair } = await editAndCapture(fx, p, { 'keep.txt': 'keep, edited\n' });
      fx.advance(30_000);
      const before = await remoteBoard(fx, p);
      const it = await prep(p);
      await killedAt(point, () => publishStep(p.core, it));
      const kept = (await p.core.state.read())?.intent as Intent;
      assert.equal(kept.kind, 'push', `${point}: the push intent is journaled`);
      const bnew = kept.kind === 'push' ? kept.bnew : null;

      await restartCore(p);
      const r = await startOk(p, 'restart');
      assert.ok(r.restart !== null);
      assert.equal(r.restart.intent, 'push');
      if (point === 'publish.out_built') {
        assert.equal(r.restart.pushResolved, 'discarded');
        assert.equal(await remoteBoard(fx, p), before, 'nothing was pushed');
      } else {
        assert.equal(r.restart.pushResolved, 'landed');
        assert.equal(await remoteBoard(fx, p), bnew);
        assert.equal(p.core.view?.laB, bnew, 'LA_B := Bnew by the ok update');
      }
      assert.equal(p.core.view?.intent.kind, 'none');
      fx.advance(30_000);
      const next = await publishStep(p.core, await prep(p));
      assert.equal(next.outcome, point === 'publish.out_built' ? 'landed' : 'nothing', `${point}: ${JSON.stringify(next)}`);
      // The pair's change-set is on the board exactly once.
      const tip = (await remoteBoard(fx, p)) as Oid;
      let carrying = 0;
      for (const b of await p.core.repo.firstParents(tip, null, 50)) {
        const c = await p.core.repo.readCommit(b);
        if (c.parents.length < 2) break;
        if (c.trailers.some((t) => t.key === 'Cowork-CS' && t.value.startsWith(`${pair.csId} `))) carrying += 1;
      }
      assert.equal(carrying, 1, `${point}: published exactly once`);
    });
  }
});

test('a kill after the writes and before ENG-36 with a journaled ready pair on a written path: the next publish\'s A_cap == A assert passes and the pair carries the peer\'s change', async () => {
  await withCores('restart-ready-pair', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const OWN = row(BASE, 2, 'row 2 by p1');
    const { pair } = await editAndCapture(fx, p, { 'a.txt': OWN });
    await fx.pushTeamChange({ 'a.txt': buf(row(BASE, 10, 'row 10 by the team')) });
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.group.phase2', () => applyStep(p.core, it));

    await restartCore(p);
    const r = await startOk(p, 'restart');
    assert.equal(r.restart?.intent, 'apply');
    const rebased = p.core.cs.ready().find((x) => x.csId === pair.csId);
    assert.ok(rebased !== undefined, 'the pair stays ready');
    const both = row(row(BASE, 2, 'row 2 by p1'), 10, 'row 10 by the team');
    assert.equal(await blobText(p, await p.core.repo.readTreeMap(rebased.R), 'a.txt'), both, "R carries the peer's change");
    await prep(p);   // the restarted governor anchors on its first fetch
    fx.advance(30_000);
    const pub = await publishStep(p.core, await prep(p));
    assert.equal(pub.outcome, 'landed', `the A_cap == A assert passes: ${JSON.stringify(pub)}`);
    assert.equal(await blobText(p, await treeOf(p, pub.c!), 'a.txt'), both);
  });
});

test('38(c) under a kill: a concat write keeps its pair ready with R = the written concat, a TAKE_TIP displacement cancels its pair (CS_READY_CANCELLED) and moves its conflict record OFF_DISK', async () => {
  const files = { ...FILES, 'notes.md': buf('# Notes\n\nalpha\n') };
  await withCores('restart-38c', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    const { pair: notes } = await editAndCapture(fx, p, { 'notes.md': '# Notes\n\nalpha\nlocal line\n' });
    fx.advance(1_000);
    const { pair: same } = await editAndCapture(fx, p, { 'b.txt': row(BASE, 6, 'row 6 local') });
    const { live } = await fx.pushTeamChange({ 'notes.md': buf('# Notes\n\nalpha\nteam line\n'), 'b.txt': buf(row(BASE, 6, 'row 6 team')) });
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.group.phase2', () => applyStep(p.core, it));

    await restartCore(p);
    const log = new LogRecorder();
    p.deps.log = log;
    const r = await startOk(p, 'restart');
    assert.equal(r.restart?.intent, 'apply');
    assert.deepEqual(p.core.cs.ready().map((x) => x.csId), [notes.csId], 'the concat pair stays ready; the TAKE_TIP pair is cancelled');
    const pair = p.core.cs.ready()[0]!;
    const concat = '# Notes\n\nalpha\nteam line\nlocal line\n';
    assert.equal(await blobText(p, await p.core.repo.readTreeMap(pair.R), 'notes.md'), concat, 'R[p] := the written concat');
    const tip = await treeOf(p, live);
    assert.equal((await p.core.repo.readTreeMap(pair.A)).get('notes.md')?.oid, tip.get('notes.md')?.oid, 'A_cap := A_new = TIP[p]');
    assert.ok(log.lines.some((l) => l.code === 'CS_READY_CANCELLED' && l.params['cs_id'] === same.csId), 'CS_READY_CANCELLED for the TAKE_TIP pair');
    const conflicts = p.core.holds.nonTerminal().filter((h) => h.paths.includes('b.txt') && h.guards.some((g) => g.name === 'conflict'));
    assert.equal(conflicts.length, 1, 'one K4 record holds the displaced local line');
    assert.equal(conflicts[0]!.residence, 'OFF_DISK', 'TIP[p] is on disk: the record went OFF_DISK');
    assert.equal((await readWork(p, 'b.txt'))?.toString('utf8'), row(BASE, 6, 'row 6 team'));
    await prep(p);
    fx.advance(30_000);
    const pub = await publishStep(p.core, await prep(p));
    assert.equal(pub.outcome, 'landed', `the A_cap == A assert passes: ${JSON.stringify(pub)}`);
    assert.equal(await blobText(p, await treeOf(p, pub.c!), 'notes.md'), concat);
  });
});

test('restart removes the own <e>.index.lock, tmp/*.new and tmp/stage and never a foreign .git/index.lock', async () => {
  await withCores('restart-leftovers', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { coworkDir, gitDir } = p.deps.paths;
    const e = p.core.refs.e;
    const own = [
      join(coworkDir, `${e}.index.lock`),
      join(coworkDir, 'tmp', '3.0.new'),
      join(coworkDir, 'tmp', 'L.7.new'),
      join(coworkDir, 'tmp', 'stage', 'src', 'copy.txt'),
      join(coworkDir, 'tmp', 'p.index.lock'),
      join(coworkDir, 'tmp', 'out.index'),
      join(gitDir, 'refs', 'cowork-local', e, 'state.lock'),
    ];
    const foreign = join(gitDir, 'index.lock');
    for (const f of [...own, foreign]) {
      await mkdir(join(f, '..'), { recursive: true });
      await writeFile(f, 'leftover\n');
      await utimes(f, PAST(), PAST());
    }
    await restartCore(p);
    await startOk(p, 'restart');
    for (const f of own) assert.equal(existsSync(f), false, `${f} removed`);
    assert.equal(existsSync(foreign), true, '.git/index.lock is never touched');
    // The state ref still moves (no stale state.lock blocks the CAS).
    const tick = await prep(p);
    assert.ok(tick.tick !== null);
    await p.core.commit({ meta: { ...p.core.view!.meta } });
    await unlink(foreign);
  });
});

test('the ring window is measured against tmp/restart-mark: a ring .old from before the marker goes, one stamped after it stays, and a Clock port far in the past changes nothing; every other own leftover goes whatever its mtime (P2-OWNLOCKS); a stale packed-refs.lock is logged once and left', async () => {
  for (const clock of ['fixture', 'far_past'] as const) {
    await withCores(`restart-mark-${clock}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const { coworkDir, gitDir } = p.deps.paths;
      const e = p.core.refs.e;
      const tmp = join(coworkDir, 'tmp');
      // Scratch indexes only publish uses (a restart's own tick and reseed re-create detect/canon and the private index).
      const before = [
        join(tmp, '1.0.new'), join(tmp, 'out.index'), join(coworkDir, `${e}.index.lock`), join(tmp, 'ring-3.old'),
        join(gitDir, 'refs', 'cowork-local', e, 'holds.lock'), join(gitDir, 'refs', 'cowork-remote', e, 'board.lock'),
      ];
      // Stamped after the marker: own leftovers still go (no age check, P2-OWNLOCKS); only a ring .old waits for its window.
      const youngOwn = [join(tmp, '2.0.new'), join(tmp, 'p.index.lock')];
      const after = [join(tmp, 'ring-4.old')];
      for (const f of [...before, ...youngOwn, ...after]) {
        await mkdir(join(f, '..'), { recursive: true });
        await writeFile(f, 'leftover\n');
      }
      for (const f of before) await utimes(f, PAST(), PAST());
      for (const f of [...youngOwn, ...after]) await utimes(f, FUTURE(), FUTURE());
      const packed = join(gitDir, 'packed-refs.lock');
      await writeFile(packed, '');
      await utimes(packed, PAST(), PAST());
      if (clock === 'far_past') {
        // A Clock port in the year 2000 (a backward clock step, or a SIM peer's skewed wall): no age reads it.
        p.deps = { ...p.deps, ports: { ...p.deps.ports, clock: new VirtualClock({ wallOffsetMs: 946_684_800_000 - SIM_WALL_EPOCH_MS, startMono: 1_000 }) } };
      }
      const log = new LogRecorder();
      p.deps.log = log;
      await restartCore(p);
      await startOk(p, 'restart');
      for (const f of before) assert.equal(existsSync(f), false, `${clock}: ${f} (before the marker) removed`);
      for (const f of youngOwn) assert.equal(existsSync(f), false, `${clock}: ${f} (an own leftover after the marker) removed`);
      for (const f of after) assert.equal(existsSync(f), true, `${clock}: ${f} (a ring .old after the marker) kept`);
      assert.equal(existsSync(packed), true, `${clock}: packed-refs.lock is never removed (P2-REPOLOCKS)`);
      const stale = log.lines.filter((l) => l.code === 'PACKED_REFS_LOCK_STALE');
      assert.equal(stale.length, 1, `${clock}: logged once`);
      assert.ok(Number(stale[0]!.params['age_s']) >= 3_000, `${clock}: its age in seconds`);
      assert.equal(existsSync(join(tmp, 'restart-mark')), false, 'the marker is removed at the end');
      await unlink(packed);
    });
  }
});

test('a missing or a corrupt private index is reseeded from state:snap (PRIVATE_INDEX_RESEEDED), also under a journaled apply intent', async () => {
  for (const variant of ['missing', 'corrupt', 'corrupt+apply'] as const) {
    await withCores(`restart-reseed-${variant.replace('+', '-')}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const index = join(p.deps.paths.coworkDir, `${p.core.refs.e}.index`);
      if (variant === 'corrupt+apply') {
        await fx.pushTeamChange({ 'c.txt': buf(row(BASE, 7, 'row 7 by the team')) });
        fx.advance(10_000);
        const it = await prep(p);
        await killedAt('apply.group.phase2', () => applyStep(p.core, it));
      }
      if (variant === 'missing') await unlink(index);
      else await writeFile(index, 'garbage, not an index\n');
      const log = new LogRecorder();
      p.deps.log = log;
      await restartCore(p);
      const r = await startOk(p, 'restart');
      assert.equal(r.restart?.intent, variant === 'corrupt+apply' ? 'apply' : 'none');
      assert.ok(log.lines.some((l) => l.code === 'PRIVATE_INDEX_RESEEDED'), `${variant}: PRIVATE_INDEX_RESEEDED`);
      assert.ok(existsSync(index), 'the private index exists again');
      const snap = await p.core.repo.readTreeMap(p.core.view!.snap);
      const idx = await p.core.repo.listIndex(index);
      assert.deepEqual([...idx].map(([k, v]) => [k, v.oid]).sort(), [...snap].map(([k, v]) => [k, v.oid]).sort());
      if (variant === 'corrupt+apply') {
        assert.equal(p.core.view!.intent.kind, 'none', 'the apply intent was resolved');
        assert.equal((await readWork(p, 'c.txt'))?.toString('utf8'), row(BASE, 7, 'row 7 by the team'));
      }
    });
  }
});

test('an open human change-set whose edit an apply already took into state:snap, then a kill at snapshot.index_written: the restart re-forms it from diff(A, snap) minus the ready paths (R-01), and the edit is captured and published', async () => {
  await withCores('restart-open-cs', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    // A captured, journaled ready pair on b.txt (not published yet), then an open CS on a.txt (never journaled).
    const CAPTURED = row(BASE, 4, 'row 4 captured before the crash');
    const { pair: earlier } = await editAndCapture(fx, p, { 'b.txt': CAPTURED });
    const OWN = row(BASE, 3, 'row 3 edited, its change-set still open');
    await writeWork(p, 'a.txt', OWN);
    await prep(p);
    // A teammate change on c.txt: the apply's ENG-36 update takes S_disk, with a.txt's edit, into state:snap.
    await fx.pushTeamChange({ 'c.txt': buf(row(BASE, 5, 'row 5 by the team')) });
    fx.advance(10_000);
    const applied = await applyStep(p.core, await prep(p));
    assert.equal(applied.skipped, null, `the apply ran: ${JSON.stringify(applied)}`);
    const snap = await p.core.repo.readTreeMap(p.core.view!.snap);
    assert.equal(await blobText(p, snap, 'a.txt'), OWN, 'state:snap holds the uncaptured edit');
    assert.deepEqual(p.core.cs.ready().map((x) => x.csId), [earlier.csId], 'only the b.txt pair is journaled');
    // The next materialize dies after the private-index update (the process is gone; its open CS with it).
    fx.advance(1_000);
    await killedAt('snapshot.index_written', () => prep(p, true));

    await restartCore(p);
    await startOk(p, 'restart');
    await prep(p);   // the first iteration after the restart (and the restarted governor's first fetch)
    fx.advance(20_000);
    const pair = await captureReady(p, await prep(p, true));
    // (c.txt, written by the apply after its S_disk was taken, reads as changed against the reseeded index: a member whose
    // R equals A, so the pair publishes nothing for it.)
    assert.ok(pair.paths.includes('a.txt'), `the re-formed change-set holds the open edit: ${JSON.stringify(pair.paths)}`);
    assert.ok(!pair.paths.includes('b.txt'), `and not the ready path b.txt: ${JSON.stringify(pair.paths)}`);
    const R = await p.core.repo.readTreeMap(pair.R);
    assert.equal(await blobText(p, R, 'a.txt'), OWN);
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    for (const q of pair.paths.filter((x) => x !== 'a.txt')) assert.equal(R.get(q)?.oid, A.get(q)?.oid, `${q}: R == A (no change of its own)`);
    fx.advance(30_000);
    const pub = await publishStep(p.core, await prep(p));
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    const pushed = await treeOf(p, pub.c!);
    assert.equal(await blobText(p, pushed, 'a.txt'), OWN, 'the edit is published');
    assert.equal(await blobText(p, pushed, 'b.txt'), CAPTURED, 'the earlier pair is published too');
    assert.equal(await blobText(p, pushed, 'c.txt'), row(BASE, 5, 'row 5 by the team'));
  });
});

test('a kill inside a local write with a DELETE entry, then a restart: the targets come from the journal, the deletion reads as done (no record, nothing resurrected)', async () => {
  await withCores('restart-local-delete', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const A = new Map([...(await p.core.repo.readTreeMap(p.core.view!.base))].map(([k, v]) => [k, v.oid]));
    const NEW_A = row(BASE, 4, 'row 4 by a local write');
    const target = await p.core.repo.hashBytes(buf(NEW_A), true);
    await prep(p);
    await killedAt('apply.group.phase2', () => p.core.writer.writeLocalGroup([
      { path: 'a.txt', expected: A.get('a.txt')!, target },
      { path: 'd.txt', expected: A.get('d.txt')!, target: 'DELETE' },
    ], 'test'));
    assert.equal((await p.core.state.read())?.intent.kind, 'local', 'the local intent is journaled');
    await restartCore(p);
    const r = await startOk(p, 'restart');
    assert.equal(r.restart?.intent, 'local');
    assert.deepEqual(r.restart?.rolledBackGroups, [], 'the group was complete: nothing rolled back');
    assert.deepEqual(r.restart?.restartRecords, [], 'the DELETE entry reads as done, never as an unplaced path');
    assert.equal(await readWork(p, 'd.txt'), null, 'd.txt stays deleted');
    assert.equal((await readWork(p, 'a.txt'))?.toString('utf8'), NEW_A);
    assert.equal(p.core.view!.intent.kind, 'none');
    assert.deepEqual(oldsIn(p), [], 'the matched .old files are gone');
  });
});

test('a kill inside a local write whose relink fails again at the restart: the bytes become a restart record and the path\'s absence is never published as a deletion', async () => {
  await withCores('restart-local-relink', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const A = new Map([...(await p.core.repo.readTreeMap(p.core.view!.base))].map(([k, v]) => [k, v.oid]));
    const target = await p.core.repo.hashBytes(buf(row(BASE, 4, 'row 4 by a local write')), true);
    await prep(p);
    await killedAt('apply.group.phase1', () => p.core.writer.writeLocalGroup([{ path: 'a.txt', expected: A.get('a.txt')!, target }], 'test'));
    assert.equal(await readWork(p, 'a.txt'), null, 'P1 moved a.txt to its .old');
    // The restart's relink of the .old fails again (a Windows holder on the name).
    p.fs.addRule({ op: 'link', pathIncludes: workPath(p, 'a.txt'), code: 'EPERM', times: 1 });
    await restartCore(p);
    const r = await startOk(p, 'restart');
    assert.equal(r.restart?.restartRecords.length, 1, 'one restart record');
    const rec = p.core.holds.nonTerminal().find((h) => h.id === r.restart!.restartRecords[0]);
    assert.ok(rec !== undefined);
    assert.deepEqual([rec.kind, rec.residence, rec.state, rec.paths], ['PATCH', 'ON_DISK', 'ACTIVE', ['a.txt']]);
    assert.equal(heldBlob(rec, 'a.txt'), A.get('a.txt'), 'the record holds the .old bytes (the only copy)');
    assert.ok(p.core.holds.maskingRecords().some((h) => h.id === rec.id), 'masked');
    assert.deepEqual(oldsIn(p), [], 'the .old went only after its record');
    // The absence is observed, confirmed, captured and composed; the record masks it, the other edit publishes.
    await writeWork(p, 'keep.txt', 'keep, edited after the crash\n');
    await prep(p);
    fx.advance(1_500);
    await prep(p);
    fx.advance(20_000);
    const it = await prep(p, true);
    const pair = await captureReady(p, it);
    assert.ok(pair.paths.includes('a.txt'), 'the deletion was captured');
    fx.advance(30_000);
    const pub = await publishStep(p.core, await prep(p));
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.ok(pub.c !== null, `a code commit: ${JSON.stringify(pub)}`);
    const live = await treeOf(p, pub.c);
    assert.equal(live.get('a.txt')?.oid, A.get('a.txt'), 'a.txt was never published as deleted');
    assert.equal(await blobText(p, live, 'keep.txt'), 'keep, edited after the crash\n');
  });
});

test('final review FB-4: a torn write of p (p holds neither the target nor the pre-image) keeps the leftover .old that matches the pre-image: its bytes, the unpublished local edit, become a restart record before the .old goes', async () => {
  await withCores('restart-torn', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const LOCAL_B = row(BASE, 10, 'row 10 edited by p1');
    await writeWork(p, 'b.txt', LOCAL_B);
    await prep(p);
    await fx.pushTeamChange({ 'b.txt': buf(row(BASE, 1, 'row 1 by the team')) });
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.group.phase1', () => applyStep(p.core, it));
    assert.equal(await readWork(p, 'b.txt'), null, 'P1 moved b.txt to its .old');
    // A copy-mode P2 killed inside its exclusive create (512 KiB chunks, no fsync yet): p holds a prefix of M_disk[p].
    const view = await p.core.state.read();
    assert.ok(view !== null && view.intent.kind === 'apply');
    const M = await p.core.repo.readTreeMap(view.t.get('M')!);
    const mBytes = await p.core.repo.readBlob(M.get('b.txt')!.oid);
    const torn = mBytes.subarray(0, Math.floor(mBytes.length * 0.5));
    assert.equal(torn.toString('utf8').includes('row 10 edited by p1'), false, 'the torn prefix lacks the local edit');
    await writeWork(p, 'b.txt', torn);
    await restartCore(p);
    const r = await startOk(p, 'restart');
    await p.core.holds.load();
    const held = restartRecordsOf(p, 'b.txt').map((h) => heldBlob(h, 'b.txt')).filter((o): o is string => o !== undefined && o !== ABSENT);
    const texts = await Promise.all(held.map(async (o) => (await p.core.repo.readBlob(o as Oid)).toString('utf8')));
    assert.ok(texts.includes(LOCAL_B), `a restart record holds the .old bytes with the local edit (records: ${JSON.stringify(r.restart?.restartRecords)}, held: ${JSON.stringify(texts)})`);
    assert.deepEqual(oldsIn(p), [], 'the .old went only after its record');
    assert.deepEqual(await readWork(p, 'b.txt'), torn, 'the disk keeps the torn bytes (never overwritten by the restart)');
  });
});

test('final review FB-1: a ring .old an earlier apply left at an intent name (a kill at apply.state, or an unlink that kept failing) is never read as the .old of the next apply killed at apply.intent: no restart record holds its bytes against another path, and a path deleted in the crash window is not brought back with them', async () => {
  const ALPHA = lines(8, (i) => `alpha ${i}`);
  const BETA = lines(8, (i) => `beta ${i}`);
  for (const variant of ['present', 'deleted', 'inrun'] as const) {
    await withCores(`restart-fb1-${variant}`, { n: 1, files: { 'README.md': buf('# fb1\n'), 'a.txt': buf(ALPHA), 'b.txt': buf(BETA) } }, async (fx) => {
      const p = fx.peers[0]!;
      await fx.pushTeamChange({ 'a.txt': buf(ALPHA.replace('alpha 3', 'alpha 3 by team')) });
      fx.advance(10_000);
      if (variant === 'inrun') {
        // a.txt's .old enters the ring at tmp/0.0.old, and its unlink keeps failing (a Windows virus scanner).
        p.fs.addRule({ op: 'unlink', pathIncludes: '0.0.old', code: 'EBUSY', times: 5 });
        const r1 = await applyStep(p.core, await prep(p));
        assert.deepEqual(r1.written, ['a.txt']);
      } else {
        const it0 = await prep(p);
        await killedAt('apply.state', () => applyStep(p.core, it0));
        await restartCore(p);
        await startOk(p, 'restart');
      }
      assert.ok(oldsIn(p).includes('0.0.old'), `${variant}: a.txt's .old sits at tmp/0.0.old`);
      await fx.pushTeamChange({ 'b.txt': buf(BETA.replace('beta 5', 'beta 5 by team')) });
      fx.advance(10_000);
      const it = await prep(p);
      await killedAt('apply.intent', () => applyStep(p.core, it));
      const view = await p.core.state.read();
      assert.ok(view !== null && view.intent.kind === 'apply' && view.intent.groups[0]?.n === 0 && view.intent.groups[0]?.entries[0]?.slot === 0, `${variant}: b.txt is journaled at the same temp name 0.0`);
      if (variant === 'deleted') await unlink(workPath(p, 'b.txt'));
      await restartCore(p);
      await startOk(p, 'restart');
      await p.core.holds.load();
      for (const h of restartRecordsOf(p, 'b.txt')) {
        const o = heldBlob(h, 'b.txt');
        const text = o === undefined || o === ABSENT ? '' : (await p.core.repo.readBlob(o as Oid)).toString('utf8');
        assert.equal(text.includes('alpha'), false, `${variant}: no record holds a.txt's bytes against b.txt`);
      }
      const b = (await readWork(p, 'b.txt'))?.toString('utf8') ?? null;
      if (variant === 'deleted') assert.equal(b, null, 'b.txt, deleted in the crash window, is not brought back with a.txt\'s bytes');
      else assert.equal(b, BETA, `${variant}: b.txt is as it was`);
    });
  }
});

test('final review FB-5: a kill after an apply wrote TIP[p] over two ON_DISK conflict records of p (a publish-side K4 and the apply\'s own): the restart moves both OFF_DISK', async () => {
  const X_LOCAL = row(BASE, 2, 'row 2 local');
  const X_MORE = row(X_LOCAL, 10, 'row 10 more local');
  const X_TEAM = row(BASE, 2, 'row 2 team');
  await withCores('restart-fb5', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { 'a.txt': X_LOCAL, 'keep.txt': 'keep, edited\n' });
    await fx.pushTeamChange({ 'a.txt': buf(X_TEAM) });
    await prep(p);
    fx.advance(6_000);
    const pub = await publishStep(p.core, await prep(p));
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    assert.equal(pub.records.length, 1, 'the publish-side K4 record');
    await writeWork(p, 'a.txt', X_MORE);
    await prep(p);
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.group.phase2', () => applyStep(p.core, it));
    const onDisk = (): string[] => p.core.holds.nonTerminal()
      .filter((h) => h.residence === 'ON_DISK' && h.state === 'CONFLICTED' && h.paths.includes('a.txt')).map((h) => h.id);
    await restartCore(p);
    assert.equal(onDisk().length, 2, 'two ON_DISK conflict records of a.txt before the restart decides');
    await startOk(p, 'restart');
    assert.equal((await readWork(p, 'a.txt'))?.toString('utf8'), X_TEAM, 'TIP[p] is on disk');
    assert.deepEqual(onDisk(), [], 'both records are OFF_DISK');
  });
});

test('final review FB-4: a leftover .old that matches the pre-image is still deleted with no record when p holds the target (a complete group) or the pre-image (a rolled-back group)', async () => {
  await withCores('restart-old-decided', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ 'c.txt': buf(row(BASE, 5, 'row 5 by the team')) });
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.group.phase2', () => applyStep(p.core, it));
    assert.equal(oldsIn(p).length, 1, 'the written group left its .old');
    await restartCore(p);
    const r = await startOk(p, 'restart');
    assert.deepEqual(r.restart?.restartRecords, [], 'p holds the target: the .old (the pre-image) goes with no record');
    assert.deepEqual(oldsIn(p), []);
    assert.equal((await readWork(p, 'c.txt'))?.toString('utf8'), row(BASE, 5, 'row 5 by the team'));
  });
});

test('final review (group FC\'s LEFT item): a journaled path named __proto__ that the restart rolls back is pending again as an own meta.pending key (never the prototype setter), and the next apply writes it', async () => {
  const PROTO = '__proto__';
  const TEAM = row(BASE, 3, 'row 3 by the team');
  await withCores('restart-proto', { n: 1, files: { ...FILES, [PROTO]: buf(BASE) } }, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [PROTO]: buf(TEAM) });
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.intent', () => applyStep(p.core, it));
    await restartCore(p);
    await startOk(p, 'restart');
    const pending = p.core.view!.meta.pending;
    assert.equal(Object.hasOwn(pending, PROTO), true, `the rolled-back __proto__ is pending (keys: ${JSON.stringify(Object.keys(pending))})`);
    assert.equal(pending[PROTO], 'race');
    const read = await p.core.state.read();
    assert.ok(read !== null);
    assert.equal(Object.hasOwn(read.meta.pending, PROTO), true, 'parseMeta reads it back');
    await converge(fx, p);
    assert.equal((await readWork(p, PROTO))?.toString('utf8'), TEAM);
    assert.equal(Object.hasOwn(p.core.view!.meta.pending, PROTO), false);
  });
});

test('a known-path orphan .old (WRITE_TMP_ORPHAN in any daemon log, matched by its path under the cowork dir) is decided by MANY CANDIDATES against state:snap: other bytes become one restart record before the file goes, equal bytes go with no record, an unknown path is kept', async () => {
  await withCores('restart-orphans', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { coworkDir } = p.deps.paths;
    const tmp = tmpOf(p);
    const other = join(tmp, 'orphan-1.old');
    const same = join(tmp, 'orphan-2.old');
    const unknown = join(tmp, 'orphan-3.old');
    await writeFile(other, 'bytes no version holds\n');
    await writeFile(same, BASE);
    await writeFile(unknown, 'whose bytes these are nobody logged\n');
    for (const f of [other, same, unknown]) await utimes(f, PAST(), PAST());
    await mkdir(join(coworkDir, 'log'), { recursive: true });
    const line = (file: string, path: string): string => `${JSON.stringify({ t: 0, level: 'warn', code: 'WRITE_TMP_ORPHAN', params: { file, path, kept: true } })}\n`;
    // The writer logs absolute names; a later daemon log names one by its path under the cowork dir.
    await writeFile(join(coworkDir, 'log', 'daemon-0.jsonl'), line(other, 'a.txt'));
    await writeFile(join(coworkDir, 'log', 'daemon-1.jsonl'), line('tmp/orphan-2.old', 'b.txt'));
    // A kill at the record's registry CAS: the file must still be there.
    await restartCore(p);
    setCrashHandler((name) => {
      if (name === 'registry.cas') throw new KilledAt(name);
    });
    try {
      await assert.rejects(startDispatch(p.core, { publishLocal: null }), KilledAt);
    } finally {
      setCrashHandler(null);
    }
    assert.equal(existsSync(other), true, 'the orphan stays until its record committed');
    await restartCore(p);
    const r = await startOk(p, 'restart');
    assert.equal(r.restart?.restartRecords.length, 1, 'one record');
    const recs = restartRecordsOf(p, 'a.txt');
    assert.equal(recs.length, 1);
    assert.equal(heldBlob(recs[0]!, 'a.txt'), await p.core.repo.hashBytes(buf('bytes no version holds\n'), false), 'the record holds those bytes');
    assert.equal(existsSync(other), false, 'removed after the record');
    assert.equal(existsSync(same), false, 'bytes equal to snap[b.txt]: removed');
    assert.deepEqual(restartRecordsOf(p, 'b.txt'), [], 'no record for equal bytes');
    assert.equal(existsSync(unknown), true, 'an orphan of unknown path is kept');
  });
});

test('a rollback-reported leftover .old whose bytes match nothing becomes a restart record', async () => {
  await withCores('restart-old-mismatch', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ 'c.txt': buf(row(BASE, 5, 'row 5 by the team')) });
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.group.phase2', () => applyStep(p.core, it));
    const olds = oldsIn(p);
    assert.equal(olds.length, 1, 'the written group left its .old');
    // A late write into the .old before the ring could look at it.
    await writeFile(join(tmpOf(p), olds[0]!), 'a late write nobody placed\n');
    await restartCore(p);
    const r = await startOk(p, 'restart');
    assert.equal(r.restart?.restartRecords.length, 1);
    const recs = restartRecordsOf(p, 'c.txt');
    assert.equal(recs.length, 1);
    assert.equal(heldBlob(recs[0]!, 'c.txt'), await p.core.repo.hashBytes(buf('a late write nobody placed\n'), false));
    assert.deepEqual(oldsIn(p), [], 'removed after its record');
    assert.equal((await readWork(p, 'c.txt'))?.toString('utf8'), row(BASE, 5, 'row 5 by the team'));
  });
});

test('a leftover .old the restart cannot read is kept as a known-path orphan and survives two more restarts; once readable, the known-path branch decides it', async () => {
  await withCores('restart-old-unreadable', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { coworkDir } = p.deps.paths;
    await mkdir(join(coworkDir, 'log'), { recursive: true });
    const log = new TeeLog(join(coworkDir, 'log', 'daemon-0.jsonl'));
    p.deps.log = log;
    await fx.pushTeamChange({ 'c.txt': buf(row(BASE, 5, 'row 5 by the team')) });
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.group.phase2', () => applyStep(p.core, it));
    const [old] = oldsIn(p);
    assert.ok(old !== undefined);
    const bytes = readFileSync(join(tmpOf(p), old));
    await utimes(join(tmpOf(p), old), PAST(), PAST());
    // Every read of a .old fails (an antivirus holding it), until released.
    let blocked = true;
    p.fs.interpose('readFile', '.old', async (f) => {
      if (blocked) throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES', syscall: 'open', path: f });
    }, 1_000);
    await restartCore(p);
    await startOk(p, 'restart');
    const orphan = log.lines.find((l) => l.code === 'WRITE_TMP_ORPHAN');
    assert.ok(orphan !== undefined, 'kept as a known-path orphan');
    assert.equal(orphan.params['path'], 'c.txt');
    const file = String(orphan.params['file']);
    assert.match(basename(file), ORPHAN_OLD_RE, 'a never-reused orphan name (P2-ORPHANNAMES)');
    for (let i = 0; i < 2; i++) {
      await restartCore(p);
      await startOk(p, 'restart');
      assert.deepEqual(readFileSync(file), bytes, `restart ${i + 2}: the unreadable leftover survives, its bytes intact`);
    }
    assert.ok(log.lines.some((l) => l.code === 'RESTART_ORPHAN_KEPT' && l.params['file'] === file), 'kept and logged');
    blocked = false;
    await restartCore(p);
    await startOk(p, 'restart');
    assert.equal(existsSync(file), false, 'readable again: equal to state:snap[c.txt], removed');
    assert.deepEqual(restartRecordsOf(p, 'c.txt'), []);
  });
});

test('a path whose clean filter fails at the restart decision is undecided (pending unreadable), never recorded as ABSENT', async () => {
  const files = { ...FILES, '.gitattributes': buf('secret.txt filter=secret\n'), 'secret.txt': buf('s v0\n') };
  await withCores('restart-filter-fails', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await gitIn(p, ['config', 'filter.secret.clean', 'cat']);
    await gitIn(p, ['config', 'filter.secret.smudge', 'cat']);
    await fx.pushTeamChange({ 'secret.txt': buf('s v1\n') });
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.group.phase2', () => applyStep(p.core, it));
    await gitIn(p, ['config', 'filter.secret.clean', 'false']);
    await restartCore(p);
    const log = new LogRecorder();
    p.deps.log = log;
    const r = await startOk(p, 'restart');
    assert.equal(r.restart?.intent, 'apply');
    for (const h of restartRecordsOf(p, 'secret.txt')) assert.notEqual(heldBlob(h, 'secret.txt'), ABSENT, 'a readable file is never held as ABSENT');
    assert.deepEqual(restartRecordsOf(p, 'secret.txt'), [], 'no record: the bytes could not be stored');
    assert.ok(log.lines.some((l) => l.code === 'RESTART_PATH_UNDECIDED' && l.params['path'] === 'secret.txt'), 'logged undecided');
    assert.equal(p.core.view!.meta.pending['secret.txt'], 'unreadable');
    assert.equal(await readWork(p, 'secret.txt') !== null, true, 'the file stays on disk');
  });
});

test('a kill between seq allocation and its persistence never reuses a landed seq', async () => {
  await withCores('restart-seq', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    // 1: a publish whose push lands, killed before its ok update (publish.sent).
    await editAndCapture(fx, p, { 'keep.txt': 'keep 1\n' });
    fx.advance(30_000);
    const it1 = await prep(p);
    await killedAt('publish.sent', () => publishStep(p.core, it1));
    await restartCore(p);
    await startOk(p, 'restart');
    // 2: a kill between the seq allocation and the journal write that persists it (the intent's state update).
    await editAndCapture(fx, p, { 'keep.txt': 'keep 2\n' });
    fx.advance(30_000);
    const it2 = await prep(p);
    const stateRef = p.core.refs.state;
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'update-ref' && args.includes(stateRef)) throw new KilledAt('seq.persist');
      return inner(args, opts);
    });
    try {
      await assert.rejects(publishStep(p.core, it2), KilledAt);
    } finally {
      restore();
    }
    await restartCore(p);
    await startOk(p, 'restart');
    // 3: the next publish lands (the restarted governor anchors on its first fetch).
    await prep(p);
    fx.advance(30_000);
    const r3 = await publishStep(p.core, await prep(p));
    assert.equal(r3.outcome, 'landed', JSON.stringify(r3));
    // No op id and no writer id appears twice on the board, and this peer's seqs only grow.
    const tip = (await remoteBoard(fx, p)) as Oid;
    const ids: string[] = [];
    const mine: number[] = [];
    const chain = (await p.core.repo.firstParents(tip, null, 100)).reverse();
    for (const b of chain) {
      const c = await p.core.repo.readCommit(b);
      if (c.parents.length === 0) continue;
      const board = await readBoardCommit(p.core.repo, b);
      for (const l of board.opsLines) ids.push((JSON.parse(l) as { id: string }).id);
      if (board.writer !== null) {
        ids.push(`${board.writer.peer}/${board.writer.epoch}/${board.writer.seq}`);
        if (board.writer.peer === p.core.peerId) mine.push(board.writer.seq);
      }
    }
    assert.equal(new Set(ids).size, ids.length, `no duplicate op ids: ${JSON.stringify(ids)}`);
    for (let i = 1; i < mine.length; i++) assert.ok(mine[i]! > mine[i - 1]!, `writer seqs grow: ${JSON.stringify(mine)}`);
    assert.ok(ids.every((id) => parseOpId(id) !== null));
  });
});


test('in a repo with a filter driver the restart decides with the attributes at EPOCH_BASE (Task 13 decision 8): an unfiltered path is not treated as filtered', async () => {
  const files = { ...FILES, '.gitattributes': buf('secret.txt filter=secret\n'), 'secret.txt': buf('s\n') };
  await withCores('restart-attrs', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await gitIn(p, ['config', 'filter.secret.clean', 'cat']);
    await gitIn(p, ['config', 'filter.secret.smudge', 'cat']);
    await fx.pushTeamChange({ 'a.txt': buf(row(BASE, 3, 'row 3 by the team')) });
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.group.phase2', () => applyStep(p.core, it));
    await restartCore(p);
    assert.ok(p.core.filters.drivers.includes('secret'), 'the clone has a filter driver');
    const r = await startOk(p, 'restart');
    assert.equal(r.restart?.intent, 'apply');
    assert.deepEqual(r.restart?.restartRecords, [], 'the written path matched M_disk: no record');
    assert.equal(pathIsFiltered(p.core, 'a.txt'), false, 'a.txt was scoped at EPOCH_BASE (not failed closed as filtered)');
    assert.equal(pathIsFiltered(p.core, 'secret.txt'), true);
    assert.equal((await stateAOf(p)).get('a.txt')?.oid, (await treeOf(p, p.core.view!.laC)).get('a.txt')?.oid, 'A[a.txt] := TIP[a.txt]');
  });
});

async function stateAOf(p: PeerFixture): Promise<Map<string, { oid: string }>> {
  return new Map([...(await p.core.repo.readTreeMap(p.core.view!.base))]);
}

// ---- fix round 2 ----

test('within one daemon log the latest WRITE_TMP_ORPHAN line for a file wins, a null path included (P2-ORPHANNAMES): a known line followed by a null-path line leaves the orphan unknown and kept, and two logs that disagree keep it too', async () => {
  await withCores('restart-orphan-null', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { coworkDir } = p.deps.paths;
    const tmp = tmpOf(p);
    const nulled = join(tmp, 'orphan-01JA0000000000000000000001.old');
    const split = join(tmp, 'orphan-01JA0000000000000000000002.old');
    await writeFile(nulled, 'bytes of a name a later line made unknown\n');
    await writeFile(split, 'bytes two logs disagree about\n');
    await mkdir(join(coworkDir, 'log'), { recursive: true });
    await writeFile(join(coworkDir, 'log', 'daemon-0.jsonl'), orphanLine(nulled, 'a.txt') + orphanLine(nulled, null) + orphanLine(split, 'b.txt'));
    await writeFile(join(coworkDir, 'log', 'daemon-1.jsonl'), orphanLine(split, null));
    await restartCore(p);
    const r = await startOk(p, 'restart');
    assert.deepEqual(restartRecordsOf(p, 'a.txt'), [], 'the latest line names no path: no record against snap[a.txt]');
    assert.deepEqual(restartRecordsOf(p, 'b.txt'), [], 'the logs disagree: no record against snap[b.txt]');
    assert.deepEqual(r.restart?.restartRecords, []);
    assert.equal(existsSync(nulled), true, 'unknown path: kept');
    assert.equal(existsSync(split), true, 'conflicting logs: kept');
  });
});

test('orphan names are tmp/orphan-<ulid>.old from the Random port and never reused (P2-ORPHANNAMES): the restart\'s orphan and, after it is gone, the writer\'s orphan get different names under a seeded Random', async () => {
  await withCores('restart-orphan-names', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { coworkDir } = p.deps.paths;
    const tmp = tmpOf(p);
    await mkdir(join(coworkDir, 'log'), { recursive: true });
    const log = new TeeLog(join(coworkDir, 'log', 'daemon-0.jsonl'));
    p.deps = { ...p.deps, log, ports: { ...p.deps.ports, random: seededRandom('t15-orphan-names') } };
    await restartCore(p);
    await startOk(p, 'restart');
    // Producer 1, the restart: a leftover .old it cannot read is kept as an orphan.
    await fx.pushTeamChange({ 'c.txt': buf(row(BASE, 5, 'row 5 by the team')) });
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.group.phase2', () => applyStep(p.core, it));
    let blocked = true;
    p.fs.interpose('readFile', '.old', async (f) => {
      if (blocked) throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES', syscall: 'open', path: f });
    }, 1_000);
    await restartCore(p);
    await startOk(p, 'restart');
    const first = log.lines.filter((l) => l.code === 'WRITE_TMP_ORPHAN').map((l) => String(l.params['file']));
    assert.equal(first.length, 1, 'the restart kept one orphan');
    const f1 = first[0]!;
    blocked = false;
    await restartCore(p);
    await startOk(p, 'restart');
    assert.equal(existsSync(f1), false, 'readable again and equal to snap[c.txt]: removed');
    // Producer 2, the writer: a holder at the next apply's tmp/0.0.old is moved aside.
    await writeFile(join(tmp, '0.0.old'), 'a holder of an earlier run\n');
    await fx.pushTeamChange({ 'd.txt': buf(row(BASE, 6, 'row 6 by the team')) });
    fx.advance(10_000);
    const r = await applyStep(p.core, await prep(p));
    assert.equal(r.ran, true);
    const second = log.lines.filter((l) => l.code === 'WRITE_TMP_ORPHAN').map((l) => String(l.params['file'])).slice(1);
    assert.equal(second.length, 1, 'the writer moved the holder aside');
    const f2 = second[0]!;
    assert.notEqual(basename(f2), basename(f1), 'a name once used is never used again, even after its file is gone');
    for (const f of [f1, f2]) assert.match(basename(f), ORPHAN_OLD_RE);
    assert.equal(readFileSync(f2, 'utf8'), 'a holder of an earlier run\n');
  });
});

test('orphanAside draws again when the drawn name exists (W4: nothing is ever renamed over a file): two producers seeded alike at the same instant never pick the same name', async () => {
  const { root, cleanup } = await makeTempRoot('orphan-aside');
  try {
    const clock = new VirtualClock({ startMono: 1_000 });
    const a = await orphanAside(realFs, seededRandom('one seed'), clock, root, 'old');
    await writeFile(a, 'the first producer\'s orphan\n');
    const b = await orphanAside(realFs, seededRandom('one seed'), clock, root, 'old');
    assert.notEqual(b, a, 'the second producer drew the same ULID first and drew again');
    for (const f of [a, b]) assert.match(basename(f), ORPHAN_OLD_RE);
  } finally {
    await cleanup();
  }
});

test('a stranded .old the writer moves aside goes to tmp/orphan-<ulid>.old with its known path (WRITE_TMP_ORPHAN), never to a ring name: after a crash the restart puts its bytes in a restart record, never deletes them', async () => {
  await withCores('restart-stranded-aside', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { coworkDir } = p.deps.paths;
    const tmp = tmpOf(p);
    await mkdir(join(coworkDir, 'log'), { recursive: true });
    const log = new TeeLog(join(coworkDir, 'log', 'daemon-0.jsonl'));
    p.deps.log = log;
    await restartCore(p);
    await startOk(p, 'restart');
    const A = await stateAOf(p);
    await fx.pushTeamChange({ 'c.txt': buf(row(BASE, 5, 'row 5 by the team')) });
    fx.advance(10_000);
    const it = await prep(p);
    // Every link onto c.txt fails (a Windows holder): P2's link, the rollback's relink and every retry.
    p.fs.addRule({ op: 'link', pathIncludes: workPath(p, 'c.txt'), code: 'EPERM', times: 50 });
    await applyStep(p.core, it);
    assert.deepEqual(p.core.writer.strandedPaths(), ['c.txt'], 'the restore is stranded');
    assert.equal(await readWork(p, 'c.txt'), null, 'c.txt is absent');
    const kept = p.core.view!.intent;
    assert.ok(kept.kind === 'apply', 'the narrowed apply intent is kept');
    const g = kept.groups[0]!;
    const slot = g.entries[0]!.slot;
    const intentOld = `${g.n}.${slot}.old`;
    assert.equal(readFileSync(join(tmp, intentOld), 'utf8'), BASE, 'the stranded .old holds the only copy of c.txt');
    // A later writer operation needs the same name: the stranded .old is moved aside.
    const keep = A.get('keep.txt')!;
    const entry: WriteEntry = { path: 'keep.txt', kind: 'modify', slot, target: { path: 'keep.txt', mode: '100644', oid: keep.oid as Oid }, sRaw: { path: 'keep.txt', mode: '100644', oid: keep.oid as Oid }, sDisk: { path: 'keep.txt', mode: '100644', oid: keep.oid as Oid } };
    const [res] = await p.core.writer.applyGroups([{ n: g.n, entries: [entry] }], async () => null);
    assert.equal(res?.outcome, 'written');
    const moved = readdirSync(tmp).filter((n) => n.endsWith('.old') && n !== intentOld && readFileSync(join(tmp, n), 'utf8') === BASE);
    assert.equal(moved.length, 1, 'the stranded .old was moved aside');
    const aside = join(tmp, moved[0]!);
    // keep.txt's own .old leaves the ring after 2 s; the stranded retry fails again. The file is an hour old.
    fx.advance(3_000);
    await p.core.writer.sweepRing();
    assert.equal(existsSync(join(tmp, intentOld)), false, "keep.txt's ringed .old is gone");
    await utimes(aside, PAST(), PAST());
    // The daemon dies; the restart decides.
    await restartCore(p);
    await startOk(p, 'restart');
    const held = restartRecordsOf(p, 'c.txt').map((h) => heldBlob(h, 'c.txt'));
    const restored = (await readWork(p, 'c.txt'))?.toString('utf8') === BASE;
    assert.ok(restored || held.includes(A.get('c.txt')!.oid), `the bytes end in a restart record or are restored, never deleted (held ${JSON.stringify(held)})`);
    assert.equal(existsSync(aside), false, 'the orphan went only after its record');
    assert.match(moved[0]!, ORPHAN_OLD_RE, 'moved to an orphan name');
    const line = log.lines.find((l) => l.code === 'WRITE_TMP_ORPHAN' && l.params['file'] === aside);
    assert.equal(line?.params['path'], 'c.txt', 'WRITE_TMP_ORPHAN names its known path');
  });
});

test('own-namespace locks are removed at restart without an age check (P2-OWNLOCKS): an own state.lock stamped an hour in the future (a backward clock step) goes, so do the other own locks; a young tmp/ring-* .old stays and packed-refs.lock is never removed', async () => {
  await withCores('restart-own-locks', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { coworkDir, gitDir } = p.deps.paths;
    const e = p.core.refs.e;
    const tmp = join(coworkDir, 'tmp');
    const own = [
      join(gitDir, 'refs', 'cowork-local', e, 'state.lock'), join(gitDir, 'refs', 'cowork-local', e, 'holds.lock'),
      join(gitDir, 'refs', 'cowork-remote', e, 'board.lock'), join(coworkDir, `${e}.index.lock`),
      join(tmp, 'r.index.lock'), join(tmp, 'a.index.lock'),
    ];
    const ring = join(tmp, 'ring-5.old');
    const packed = join(gitDir, 'packed-refs.lock');
    for (const f of [...own, ring, packed]) {
      await mkdir(join(f, '..'), { recursive: true });
      await writeFile(f, 'leftover\n');
      await utimes(f, FUTURE(), FUTURE());
    }
    await restartCore(p);
    await startOk(p, 'restart');
    for (const f of own) assert.equal(existsSync(f), false, `${f} (an hour in the future) removed`);
    assert.equal(existsSync(ring), true, 'a ring .old younger than the marker stays (its window is the only age rule left)');
    assert.equal(existsSync(packed), true, 'packed-refs.lock is never removed (P2-REPOLOCKS)');
    await unlink(packed);
    // The state ref moves again.
    await prep(p);
    await p.core.commit({ meta: { ...p.core.view!.meta } });
  });
});

test('remote content on a usable-state restart with a kept push intent is the loop\'s incident, never a start refusal: a real malformed live chain (live_shape) and, with M07, a board ref naming a parentless commit (the Folder\'s RemoteContentError, board_shape) leave the restart ok with the intent kept and nothing written or pushed, and the next prepareIteration takes the incident branch; a local plain Error there (an EIO) is thrown as it is', async () => {
  for (const kind of ['live_shape', 'board_shape', 'local'] as const) {
    await withCores(`restart-push-${kind}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      await editAndCapture(fx, p, { 'keep.txt': 'keep, edited\n' });
      fx.advance(30_000);
      const it = await prep(p);
      await killedAt('publish.out_built', () => publishStep(p.core, it));
      assert.equal((await p.core.state.read())?.intent.kind, 'push', 'the push intent is journaled');
      const repo = p.core.repo;
      const T0 = p.core.view!.laB;
      const L0 = p.core.view!.laC;
      if (kind === 'live_shape') {
        // A teammate's board commit on T0 whose live code commit carries none of the live-commit markers.
        const stray = await repo.commitTree({ tree: (await repo.readCommit(L0)).tree, parents: [L0], subject: 'an ordinary commit, not a cowork live commit', trailers: [] });
        const writer: WriterId = { peer: 'd'.repeat(32), epoch: newEpoch(p.deps.ports.random), seq: 1 };
        const B1 = await buildBoardCommit(repo, { prevBoard: T0, liveCode: stray, writer, ops: [], cs: [], csPaths: new Map(), protocol: null, checkpoint: null });
        const pushed = await runPush(repo, fx.remote.url, [pushSpec(B1, p.core.refs.remoteBoard, T0), pushSpec(stray, p.core.refs.remoteCode, L0)], []);
        assert.equal(pushed.statuses.get(p.core.refs.remoteBoard), 'ok');
      } else if (kind === 'board_shape') {
        const empty = await gitRemote(fx, ['mktree']);
        const bad = (await testRunner().run(['commit-tree', empty, '-m', 'not a board commit'], {
          class: 'refupdate', cwd: fx.remote.dir, identity: { name: 'Other', email: 'other@cowork.invalid' },
        })).stdout.toString('utf8').trim();
        await gitRemote(fx, ['update-ref', p.core.refs.remoteBoard, bad]);
        setMutants(p, ['M07']);   // the incident check off: the Folder is the first reader of the board
      }
      const stateBefore = await repo.readRef(p.core.refs.state);
      const remoteBefore = await fx.remote.refs();
      await restartCore(p);
      if (kind === 'local') {
        const err = Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO', syscall: 'read' });
        p.core.folder.foldTo = async () => {
          throw err;
        };
        await assert.rejects(startDispatch(p.core, { publishLocal: null }), (e: unknown) => e === err);
      } else {
        const r = await startDispatch(p.core, { publishLocal: null });
        assert.ok(r.ok && r.mode === 'restart', `${kind}: ${JSON.stringify(r)}`);
        assert.equal(r.restart?.intent, 'push');
        assert.equal(r.restart?.pushResolved, null, `${kind}: the push intent is not resolved against remote content`);
        assert.equal(p.core.view?.intent.kind, 'push', `${kind}: the push intent is kept`);
        const next = await prepareIteration(p.core, 1, { materialize: false, forceFetch: true });
        assert.ok(!next.ok && next.why === 'incident' && next.verdict.why === kind, `${kind}: the loop's incident branch: ${JSON.stringify(next)}`);
      }
      assert.equal(await p.core.repo.readRef(p.core.refs.state), stateBefore, `${kind}: the state is as it was (the push intent kept)`);
      assert.deepEqual(await fx.remote.refs(), remoteBefore, `${kind}: nothing pushed`);
    });
  }
});

test('the restart draws a kept leftover\'s orphan name inside its try: a failure while drawing it (lstat EACCES on tmp/orphan-*) leaves the .old where it is with its bytes, logged RESTART_OLD_KEPT, and the restart completes', async () => {
  await withCores('restart-aside-draw', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await fx.pushTeamChange({ 'c.txt': buf(row(BASE, 5, 'row 5 by the team')) });
    fx.advance(10_000);
    const it = await prep(p);
    await killedAt('apply.group.phase2', () => applyStep(p.core, it));
    const [old] = oldsIn(p);
    assert.ok(old !== undefined);
    const bytes = readFileSync(join(tmpOf(p), old));
    // Every read of a .old fails (it is kept as an orphan), and the orphan name's lstat fails once.
    p.fs.interpose('readFile', '.old', async (f) => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES', syscall: 'open', path: f });
    }, 1_000);
    p.fs.addRule({ op: 'lstat', pathIncludes: join('tmp', 'orphan-'), code: 'EACCES', times: 1 });
    await restartCore(p);
    await startOk(p, 'restart');
    const kept = log.lines.find((l) => l.code === 'RESTART_OLD_KEPT');
    assert.ok(kept !== undefined, 'RESTART_OLD_KEPT');
    assert.equal(kept.params['code'], 'EACCES');
    assert.deepEqual(readFileSync(join(tmpOf(p), old)), bytes, 'the .old stays where it is, its bytes intact');
    assert.equal(log.lines.some((l) => l.code === 'WRITE_TMP_ORPHAN'), false, 'no orphan name was taken');
    assert.deepEqual(readdirSync(tmpOf(p)).filter((n) => n.startsWith('orphan-')), [], 'no orphan file');
  });
});
