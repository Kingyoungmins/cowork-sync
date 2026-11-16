// Closures under a lock (Plan 3 Task 6; 05-holds HLD-32 apply side, HLD-53, HLD-54, I5, I6; 01-engine TC-ENG-06; glossary §20
// "≤ 1 apply per 10 s", §21 INV-GROUP; mutants M38, M39; rulings R3-29…R3-31; Review Focus 2): a write group with a locked path is
// deferred whole and is ONE closure (ApplyReport.closures, the apply trace's groups); for 60 s Δmono it creates no record and no
// board op, then exactly one INCOMING `lock` record covers it, follows TIP, widens with the closure and is released (SUBSUMED) when
// the closure applies or TIP stops changing it. FaultFs.holdLock emulates an Excel-like share-read or share-none holder on every
// OS. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setChainWindow } from '../../src/data/formCheck.js';
import { applyStep } from '../../src/engine/apply.js';
import { restart } from '../../src/engine/restart.js';
import type { Oid } from '../../src/git/oid.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { incomingRecords, loop, onlyWithGuard, registryHead } from '../helpers/incomingFixture.js';
import { holdOpsSince, holdPatch, remoteTip } from '../helpers/mirrorFixture.js';
import { buf, LogRecorder, prep, withCores } from '../helpers/publishHelpers.js';
import { restartCore } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const PA = 'src/a.txt';
const PB = 'src/b.txt';
const PC = 'src/c.txt';
const PD = 'src/d.txt';
const BASE: Record<string, Buffer> = { [PA]: buf('a1\na2\na3\n'), [PB]: buf('b1\nb2\nb3\n'), [PC]: buf('c1\nc2\nc3\n'), [PD]: buf('d1\nd2\nd3\n') };
const FILES: Record<string, Buffer> = { 'README.md': buf('# receive lock\n'), ...BASE };
const TEAM: Record<string, Buffer> = { [PA]: buf('a1\na2 team\na3\n'), [PB]: buf('b1\nb2 team\nb3\n'), [PC]: buf('c1\nc2 team\nc3\n') };
const ABC = [PA, PB, PC];

/**
 * An Excel-like holder on one working file of the peer (FaultFs, every OS); returns release(). The peer has run one loop before, so
 * its stat cache knows the file clean and no detection tick reads it again: the holder is met by the writer (W4), as when a program
 * opens a file that was synced earlier.
 */
const lock = (p: PeerFixture, path: string, mode: 'share-read' | 'share-none'): (() => void) => p.fs.holdLock(workPath(p, path), mode);

/** The warm-up loop every lock test runs before taking its lock (the stat cache learns every tracked file). */
async function warm(fx: CoreFixture, p: PeerFixture): Promise<void> {
  await loop(p);
  fx.advance(10_000);
}

async function onDisk(p: PeerFixture, paths: readonly string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const path of paths) out[path] = (await readWork(p, path))?.toString('utf8') ?? null;
  return out;
}
const textOf = (m: Record<string, Buffer>, paths: readonly string[]): Record<string, string> => Object.fromEntries(paths.map((x) => [x, m[x]!.toString('utf8')]));

/** The hold ops of record `id` the remote board carries since `from`. */
async function boardOpsOf(fx: CoreFixture, p: PeerFixture, from: Oid, id: string): Promise<Array<{ state: string; rev: number }>> {
  return (await holdOpsSince(p, from, await remoteTip(fx, p))).filter((x) => x.op.hold_id === id).map((x) => ({ state: x.op.state, rev: x.op.rev }));
}

/** Loops every `stepMs` until the closure's INCOMING record exists (at most `maxMs`); the record. */
async function untilRecord(fx: CoreFixture, p: PeerFixture, stepMs: number, maxMs: number, o: { publish?: boolean; mirror?: boolean } = {}): Promise<{ id: string; atMs: number }> {
  for (let t = 0; t <= maxMs; t += stepMs) {
    await loop(p, o);
    const rs = incomingRecords(p);
    if (rs.length > 0) return { id: rs[0]!.id, atMs: t };
    fx.advance(stepMs);
  }
  throw new Error(`no INCOMING record within ${maxMs} ms`);
}

test('ApplyReport.closures has one entry per deferred write group', T10, async () => {
  // (a) A share-read holder on b.txt: the writer defers the group [a, b, c] whole (its rename of b fails): one closure, `locked`.
  await withCores('rlock-closures-writer', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await warm(fx, p);
    lock(p, PB, 'share-read');
    await fx.pushTeamChange(TEAM);
    fx.advance(10_000);
    const l = await loop(p);
    assert.deepEqual(l.apply.closures, [{ paths: ABC, reason: 'locked', path: PB }], 'one closure, waiting for b (GroupResult.path)');
    const [tr] = fx.trace.ofKind('apply');
    assert.deepEqual(tr!.groups, [{ paths: ABC, outcome: 'deferred', reason: 'locked' }]);
    assert.deepEqual(await onDisk(p, ABC), textOf(BASE, ABC), 'nothing written');
  });
  // (b) Plan 2's WriteGroupsResult.deferred splits one group into per-(group, reason) entries — here {[b], eol_form} (a form
  // violation, DAT-11), {[c], unreadable} (a share-none holder on a locally edited c: the staged read fails) and {[a], closure}.
  // ApplyReport.closures regroups them into one entry whose reason is the group-level one: eol_form beats the lock-like reason.
  const files = { ...FILES, [PB]: buf('b1\r\nb2\r\nb3\r\n') };
  await withCores('rlock-closures-regroup', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await warm(fx, p);
    await writeWork(p, PC, 'c1\nc2\nc3 local\n');
    lock(p, PC, 'share-none');
    await fx.pushTeamChange({ [PA]: TEAM[PA]!, [PB]: buf('b1\nb2 team\nb3\n'), [PC]: TEAM[PC]! }, { raw: true });
    fx.advance(10_000);
    const l = await loop(p);
    assert.equal(l.apply.deferred.get(PB), 'eol_form');
    assert.equal(l.apply.deferred.get(PC), 'unreadable');
    assert.equal(l.apply.deferred.get(PA), 'closure');
    assert.deepEqual(l.apply.closures, [{ paths: ABC, reason: 'eol_form', path: PB }], 'one entry for the group, never one per reason');
    const tr = fx.trace.ofKind('apply').at(-1)!;
    assert.deepEqual(tr.groups, [{ paths: ABC, outcome: 'deferred', reason: 'eol_form' }]);
  });
});

test('a closure deferred less than 60 s creates no record and no board op', T10, async () => {
  await withCores('rlock-under60', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await warm(fx, p);
    lock(p, PB, 'share-read');
    await fx.pushTeamChange(TEAM);
    fx.advance(10_000);
    const head = registryHead(p);
    for (let t = 0; t < 60_000; t += 2_500) {
      const l = await loop(p, { mirror: true });
      assert.deepEqual(Object.keys(p.core.view!.meta.pending).sort(), ABC, `+${t} ms: meta.pending lists all three`);
      assert.equal(registryHead(p), head, `+${t} ms: the registry head does not move`);
      assert.deepEqual(l.created, []);
      assert.ok(!p.core.outbox.drafts().some((d) => d.type === 'hold'), `+${t} ms: no hold op in the outbox`);
      fx.advance(2_500);
    }
    assert.deepEqual(incomingRecords(p), []);
  });
});

test('at 60 s one INCOMING record covers the whole closure', T10, async () => {
  await withCores('rlock-at60', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await warm(fx, p);
    lock(p, PB, 'share-read');
    await fx.pushTeamChange(TEAM);
    fx.advance(10_000);
    await loop(p);
    const mono0 = p.core.deps.ports.clock.monoMs();
    for (let t = 10_000; t < 60_000; t += 10_000) {
      fx.advance(10_000);
      assert.deepEqual((await loop(p, { mirror: true })).created, [], `+${t} ms`);
    }
    fx.advance(10_000);
    const due = await loop(p, { mirror: true });
    assert.equal(due.created.length, 1, 'one record at the first incomingStep with the closure clock ≥ 60,000 ms');
    assert.equal(p.core.deps.ports.clock.monoMs() - mono0, 60_000);
    const r = onlyWithGuard(p, 'lock');
    assert.equal(r.id, due.created[0]);
    assert.deepEqual([r.kind, r.residence, r.state, r.paths, r.guards.map((g) => [g.name, g.class])], ['INCOMING', 'ON_DISK', 'ACTIVE', ABC, [['lock', 'PREDICATE']]]);
    assert.ok('h1' in r.blobs);
    for (const path of ABC) {
      assert.equal(r.blobs.h0[path], due.it.A.get(path)!.oid, `h0[${path}] = A`);
      assert.equal(r.blobs.h1[path], due.it.tipMap.get(path)!.oid, `h1[${path}] = TIP`);
    }
    assert.equal(r.local_only, false);
    assert.ok(p.core.outbox.pendingHold(r.id) !== null, 'its creation op is drafted in the same loop (R3-29: created at 60 s, due at once)');
  });
});

test('TC-ENG-06: a locked 3-path group writes nothing; after unlock all three are written in one group with one state update', T10, async () => {
  await withCores('rlock-tceng06', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const from = p.core.view!.laB;
    await warm(fx, p);
    const release = lock(p, PB, 'share-none');
    await fx.pushTeamChange(TEAM);
    fx.advance(10_000);
    const { id, atMs } = await untilRecord(fx, p, 10_000, 70_000, { publish: true });
    assert.equal(atMs, 60_000, 'the record created at 60 s');
    assert.deepEqual(await onDisk(p, ABC), textOf(BASE, ABC), 'no path written');
    // Two more locked windows: the creation op lands, nothing else.
    for (let i = 0; i < 2; i++) {
      fx.advance(10_000);
      await loop(p, { publish: true });
    }
    release();
    fx.advance(10_000);
    const statesBefore = fx.trace.ofKind('state').filter((e) => e.peer === p.core.peerId).length;
    const baseBefore = p.core.view!.base;
    const l = await loop(p, { publish: true });
    assert.deepEqual(l.apply.written, ABC, 'the next permitted apply writes the three');
    assert.deepEqual(fx.trace.ofKind('apply').at(-1)!.groups, [{ paths: ABC, outcome: 'written', reason: null }], 'in one group');
    const states = fx.trace.ofKind('state').filter((e) => e.peer === p.core.peerId).slice(statesBefore);
    const moves = states.filter((e, i) => e.base !== (i === 0 ? baseBefore : states[i - 1]!.base));
    assert.equal(moves.length, 1, 'one state update sets A for the three (the other is the apply intent J)');
    assert.deepEqual(await onDisk(p, ABC), textOf(TEAM, ABC));
    assert.equal(p.core.holds.get(id)!.state, 'SUBSUMED', 'incomingStep ends the record');
    assert.deepEqual(l.released, [id]);
    for (let i = 0; i < 3; i++) {
      fx.advance(10_000);
      await loop(p, { publish: true });
    }
    assert.deepEqual((await boardOpsOf(fx, p, from, id)).map((o) => o.state), ['ACTIVE', 'SUBSUMED'], 'exactly two hold ops: creation and release');
  });
});

test('mutant M38 writes the available paths of a locked group', T10, async () => {
  await withCores('rlock-m38', { n: 1, files: FILES, mutants: new Set(['M38']) }, async (fx) => {
    const p = fx.peers[0]!;
    await warm(fx, p);
    lock(p, PB, 'share-read');
    await fx.pushTeamChange(TEAM);
    fx.advance(10_000);
    const l = await loop(p);
    // The partial state INV-GROUP's oracle (Task 14) kills: a and c are new while b, in the same CS, is old.
    assert.deepEqual(l.apply.written, [PA, PC]);
    assert.deepEqual(await onDisk(p, ABC), { [PA]: TEAM[PA]!.toString(), [PB]: BASE[PB]!.toString(), [PC]: TEAM[PC]!.toString() });
  });
});

test('a TIP move refreshes the INCOMING record and a grown closure widens it', T10, async () => {
  await withCores('rlock-refresh', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await warm(fx, p);
    lock(p, PB, 'share-read');
    await fx.pushTeamChange(TEAM);
    fx.advance(10_000);
    const { id } = await untilRecord(fx, p, 10_000, 70_000);
    const r0 = p.core.holds.get(id)!;
    // TIP changes a.txt again (another CS): one new rev with the new h1[a].
    await fx.pushTeamChange({ [PA]: buf('a1\na2 team again\na3\n') });
    fx.advance(10_000);
    const l1 = await loop(p);
    const r1 = p.core.holds.get(id)!;
    assert.equal(r1.rev, r0.rev + 1, 'one new rev');
    assert.ok('h1' in r1.blobs && 'h1' in r0.blobs);
    assert.equal(r1.blobs.h1[PA], l1.it.tipMap.get(PA)!.oid, 'h1[a] = the new TIP blob');
    assert.deepEqual(r1.paths, ABC);
    fx.advance(10_000);
    await loop(p);
    assert.equal(p.core.holds.get(id)!.rev, r1.rev, 'no rev while nothing moves');
    // A further incoming CS touching c.txt and d.txt grows the closure: the same record now covers [a, b, c, d] in one rev.
    await fx.pushTeamChange({ [PC]: buf('c1\nc2 team again\nc3\n'), [PD]: buf('d1\nd2 team\nd3\n') });
    fx.advance(10_000);
    const l2 = await loop(p);
    assert.deepEqual(l2.apply.closures, [{ paths: [...ABC, PD], reason: 'locked', path: PB }]);
    const r2 = p.core.holds.get(id)!;
    assert.equal(r2.rev, r1.rev + 1, 'one rev');
    assert.deepEqual(r2.paths, [...ABC, PD]);
    assert.ok('h1' in r2.blobs);
    for (const path of [...ABC, PD]) assert.equal(r2.blobs.h1[path], l2.it.tipMap.get(path)!.oid, path);
    for (let i = 0; i < 7; i++) {
      fx.advance(10_000);
      await loop(p);
    }
    assert.deepEqual(incomingRecords(p).map((r) => r.id), [id], 'never a second record');
  });
});

test('a closure record is released when TIP no longer changes its paths', T10, async () => {
  await withCores('rlock-revert', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await warm(fx, p);
    lock(p, PB, 'share-read');
    await fx.pushTeamChange(TEAM);
    fx.advance(10_000);
    const { id } = await untilRecord(fx, p, 10_000, 70_000);
    await fx.pushTeamChange(Object.fromEntries(ABC.map((x) => [x, BASE[x]!])));   // the teammate reverts: TIP[p] == A[p]
    fx.advance(10_000);
    const l = await loop(p);
    assert.deepEqual(l.apply.written, [], 'no write');
    assert.equal(p.core.holds.get(id)!.state, 'SUBSUMED');
    assert.deepEqual(l.released, [id]);
    assert.deepEqual(await onDisk(p, ABC), textOf(BASE, ABC));
    assert.deepEqual([...p.core.transient.ages().keys()].filter((k) => k.startsWith('closure:')), [], 'the closure clock is forgotten');
  });
});

test('INCOMING_WAITING is raised while a closure is pending', T10, async () => {
  await withCores('rlock-waiting', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const log = new LogRecorder();
    p.deps.log = log;
    await warm(fx, p);
    const release = lock(p, PB, 'share-read');
    await fx.pushTeamChange(TEAM);
    fx.advance(10_000);
    const first = await loop(p);
    const csId = first.apply.incoming.find((c) => c.paths.includes(PB))!.csId;
    // The writer defers the group whole at b's rename (GroupResult.path): the code names the path the closure waits for.
    const want = { code: 'INCOMING_WAITING', params: { cs: csId, path: PB, reason: 'locked' } };
    assert.deepEqual(first.codes, [want]);
    assert.deepEqual(p.core.holdCode, want, 'holdCode equals it after raiseHoldCodes');
    for (let i = 0; i < 4; i++) {
      fx.advance(10_000);
      assert.deepEqual((await loop(p)).codes.filter((c) => c.code === 'INCOMING_WAITING'), [], 'once per episode');
    }
    const lines = (): number => log.lines.filter((l) => l.code === 'INCOMING_WAITING').length;
    assert.equal(lines(), 1, 'one log line for the episode');
    assert.deepEqual(log.lines.find((l) => l.code === 'INCOMING_WAITING')!.params, { cs: csId, path: PB, reason: 'locked' });
    // The episode ends when the closure applies; a new deferral is a new episode.
    release();
    fx.advance(10_000);
    assert.deepEqual((await loop(p)).apply.written, ABC);
    lock(p, PD, 'share-read');
    await fx.pushTeamChange({ [PD]: buf('d1\nd2 team\nd3\n') });
    fx.advance(10_000);
    const again = await loop(p);
    assert.equal(again.codes.filter((c) => c.code === 'INCOMING_WAITING').length, 1);
    assert.equal(lines(), 2, 'one line per episode');
  });
  // A group deferred before writing names the path it waits for: the one whose own reason is not `closure` (here b's form).
  const files = { ...FILES, [PB]: buf('b1\r\nb2\r\nb3\r\n') };
  await withCores('rlock-waiting-named', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ [PA]: TEAM[PA]!, [PB]: buf('b1\nb2 team\nb3\n') }, { raw: true });
    fx.advance(10_000);
    const l = await loop(p);
    const csId = l.apply.incoming.find((c) => c.paths.includes(PB))!.csId;
    assert.deepEqual(l.codes, [{ code: 'INCOMING_WAITING', params: { cs: csId, path: PB, reason: 'eol_form' } }]);
    assert.deepEqual(p.core.holdCode, { code: 'INCOMING_WAITING', params: { cs: csId, path: PB, reason: 'eol_form' } });
  });
});

test('the apply trace carries groups, notApplicable and mDisk', T10, async () => {
  await withCores('rlock-trace', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await warm(fx, p);
    lock(p, PB, 'share-read');
    await fx.pushTeamChange(TEAM);
    await fx.pushTeamChange({ [PD]: buf('d1\nd2 team\nd3\n') });
    fx.advance(10_000);
    await loop(p);
    const tr = fx.trace.ofKind('apply').at(-1)!;
    assert.deepEqual(tr.groups, [{ paths: ABC, outcome: 'deferred', reason: 'locked' }, { paths: [PD], outcome: 'written', reason: null }]);
    assert.deepEqual(tr.notApplicable, []);
    assert.ok(tr.mDisk !== null);
    const m = await p.core.repo.readTreeMap(tr.mDisk as Oid);
    const tip = (await prep(p)).tipMap;
    for (const path of [...ABC, PD]) assert.equal(m.get(path)?.oid, tip.get(path)?.oid, `M_disk[${path}] is the merge result (TIP's)`);
  });
});

/** Throws KilledAt at the first hit of `point` while `fn` runs (a dead process: the core is abandoned). */
async function killedAt(point: string, fn: () => Promise<unknown>): Promise<void> {
  setCrashHandler((name) => {
    if (name === point) throw new KilledAt(name);
  });
  try {
    await assert.rejects(fn(), (e: unknown) => e instanceof KilledAt && e.point === point);
  } finally {
    setCrashHandler(null);
  }
}

test('05 I5: a closure is all-new or all-old across kills, and six CSs landing together give exactly two applies', T10, async () => {
  for (const [point, want] of [['apply.group.phase1', BASE], ['apply.group.phase2', TEAM]] as const) {
    await withCores(`rlock-i5-${point}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      await warm(fx, p);
      const release = lock(p, PB, 'share-read');
      await fx.pushTeamChange(TEAM);
      fx.advance(10_000);
      await loop(p);   // deferred whole while b is held
      release();
      fx.advance(10_000);
      const it = await prep(p, 'auto');
      await killedAt(point, () => applyStep(p.core, it));
      await restartCore(p);
      await restart(p.core);
      assert.deepEqual(await onDisk(p, ABC), textOf(want, ABC), `killed at ${point}: all ${want === BASE ? 'old' : 'new'} after restart`);
    });
  }
  const six = Array.from({ length: 6 }, (_, i) => `src/f${i + 1}.txt`);
  const files = { ...FILES, ...Object.fromEntries(six.map((f) => [f, buf(`${f}\n`)])) };
  await withCores('rlock-i5-six', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    const applies: Array<{ at: number; written: string[] }> = [];
    const landed: number[] = [];
    const mono = (): number => p.core.deps.ports.clock.monoMs();
    let next = 0;
    // Six CSs, one every 1.5 virtual s (all six within 7.5 s); the test loop every 2.5 s from the first commit on.
    for (let t = 0; t <= 30_000; t += 500) {
      if (next < 6 && t === next * 1_500) {
        await fx.pushTeamChange({ [six[next]!]: buf(`${six[next]} team\n`) });
        landed.push(mono());
        next++;
      }
      if (t % 2_500 === 0) {
        const l = await loop(p);
        if (l.apply.ran && l.apply.written.length > 0) applies.push({ at: mono(), written: l.apply.written });
      }
      fx.advance(500);
    }
    assert.equal(applies.length, 2, `exactly two applies: ${JSON.stringify(applies)}`);
    assert.equal(applies[0]!.at, landed[0], 'the first at the first loop after the first commit');
    assert.ok(applies[1]!.at - applies[0]!.at >= 10_000, 'no two written applies < 10 s Δmono apart');
    assert.deepEqual([...applies[0]!.written, ...applies[1]!.written].sort(), six, 'every CS applied');
    assert.ok(applies[1]!.at <= landed[5]! + 10_000 + 2_500, 'within 10 s plus one loop after the last commit');
  });
});

test('mutant M39 drops apply coalescing', T10, async () => {
  for (const mutant of [true, false]) {
    await withCores(`rlock-m39-${mutant}`, { n: 1, files: FILES, mutants: new Set(mutant ? ['M39'] : []) }, async (fx) => {
      const p = fx.peers[0]!;
      let applies = 0;
      await fx.pushTeamChange({ [PA]: TEAM[PA]! });
      if ((await loop(p)).apply.ran) applies++;
      fx.advance(3_000);
      await fx.pushTeamChange({ [PC]: TEAM[PC]! });
      if ((await loop(p)).apply.ran) applies++;
      fx.advance(3_000);
      if ((await loop(p)).apply.ran) applies++;
      assert.equal(applies, mutant ? 2 : 1, mutant ? 'two applies within 10 s Δmono with M39' : 'one without');
    });
  }
});

test('a long deferral walks the chains once per (TIP, pending set): no git process per pending path and per apply', T10, async () => {
  // HLD-53 across applies (incomingBase) and formCheckIncoming read the chains of the deferred paths in ONE walk, cached by (TIP, the
  // window's bound, the pending (path, A blob) set): an 8-path closure under a lock plus an eol-form path cost one walk per TIP move.
  const many = Array.from({ length: 8 }, (_, i) => `src/m${i + 1}.txt`);
  const W = 'src/w.cs';
  const files = { 'README.md': buf('# walks\n'), [W]: buf('w1\r\nw2\r\n'), ...Object.fromEntries(many.map((m) => [m, buf(`${m}\n`)])) };
  await withCores('rlock-walks', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await warm(fx, p);
    lock(p, many[3]!, 'share-read');
    await fx.pushTeamChange(Object.fromEntries(many.map((m) => [m, buf(`${m} team\n`)])));
    await fx.pushTeamChange({ [W]: buf('w1\nw2 team\n') }, { raw: true });   // a form violation (DAT-11)
    fx.advance(10_000);
    const first = await loop(p);
    assert.deepEqual(first.apply.closures.map((c) => c.reason).sort(), ['eol_form', 'locked']);
    const calls: string[][] = [];
    const run = p.core.repo.run.bind(p.core.repo);
    p.core.repo.run = async (args, opts) => {
      calls.push([...args]);
      return run(args, opts);
    };
    // A chain walk names paths (`--` or `--stdin`); a per-path read is an `ls-tree … -- <path>`.
    const walks = (): number => calls.filter((a) => (a[0] === 'log' || a[0] === 'rev-list') && (a.includes('--') || a.includes('--stdin'))).length;
    const reads = (): number => calls.filter((a) => a[0] === 'ls-tree' && a.includes('--')).length;
    for (let i = 0; i < 3; i++) {
      calls.length = 0;
      fx.advance(10_000);
      const l = await loop(p);
      assert.equal(l.apply.ran, true, `apply ${i + 2} ran`);
      assert.equal(l.apply.closures.length, 2, `apply ${i + 2}: both closures still deferred`);
      assert.ok(walks() <= (i === 0 ? 2 : 0), `apply ${i + 2}: ${walks()} chain walks (${i === 0 ? 'one per caller after LA_C moved' : 'none: the same TIP and pending set'})`);
      assert.equal(reads(), 0, `apply ${i + 2}: no per-path ls-tree`);
    }
  });
});

test("a closure whose A blob lies beyond the chain window keeps its change-set (incomingBase's no-stop branch)", T10, async () => {
  // The commit that gave a and b their A blobs (genesis) is outside the window by the second apply, but the CS that changed both is
  // inside: the chains have no stop, so the range reaches back to that CS's first parent and the closure is not split.
  const filler = 'src/filler.txt';
  await withCores('rlock-nostop', { n: 1, files: { ...FILES, [filler]: buf('f0\n') } }, async (fx) => {
    const p = fx.peers[0]!;
    await warm(fx, p);
    for (let i = 1; i <= 3; i++) await fx.pushTeamChange({ [filler]: buf(`f${i}\n`) });
    fx.advance(10_000);
    await loop(p);
    lock(p, PB, 'share-read');
    const x = await fx.pushTeamChange({ [PA]: TEAM[PA]!, [PB]: TEAM[PB]! });
    fx.advance(10_000);
    const first = await loop(p);
    assert.deepEqual(first.apply.closures, [{ paths: [PA, PB], reason: 'locked', path: PB }]);
    assert.equal(p.core.view!.laC, x.live, 'the apply moved LA_C to the CS while a and b stay deferred');
    try {
      setChainWindow(2);
      for (let i = 4; i <= 6; i++) await fx.pushTeamChange({ [filler]: buf(`f${i}\n`) });
      fx.advance(10_000);
      const l = await loop(p);
      assert.ok(l.apply.incoming.some((c) => c.commit === x.live), 'the incoming change-sets still hold the CS of a and b');
      assert.deepEqual(l.apply.closures, [{ paths: [PA, PB], reason: 'locked', path: PB }], 'the closure is not split');
      assert.deepEqual(l.apply.written, [filler]);
      assert.deepEqual(await onDisk(p, [PA, PB]), textOf(BASE, [PA, PB]), 'a waits with b');
    } finally {
      setChainWindow(null);
    }
  });
});

test('a CS below LA_C that declares a deferred path without changing it does not tie that closure to a later independent CS (R3-EF4-4)', T10, async () => {
  // HLD-53 across applies (Task 6 ruling, R3-EF4-4): below LA_C only the CSs of commits that changed a still-deferred path since the
  // commit that gave it its A blob count. J changes README.md only but declares {README.md, a, b} (a start/join capture CS has this
  // shape: Cowork-CS-Paths = R ∪ A); a's A blob dates to genesis, so the old range (genesis, TIP] re-read J and tied b to a's closure.
  await withCores('rlock-range', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await warm(fx, p);
    const J = await fx.pushTeamChange({ 'README.md': buf('# receive lock v2\n'), [PA]: BASE[PA]!, [PB]: BASE[PB]! });
    fx.advance(10_000);
    const lj = await loop(p);
    assert.deepEqual(lj.apply.written, ['README.md'], 'J applies whole (its only change)');
    assert.equal(p.core.view!.laC, J.live);
    // K: a's change, deferred whole under a share-read holder.
    lock(p, PA, 'share-read');
    await fx.pushTeamChange({ [PA]: TEAM[PA]! });
    fx.advance(10_000);
    const lk = await loop(p);
    assert.deepEqual(lk.apply.closures.map((c) => ({ paths: c.paths, reason: c.reason })), [{ paths: [PA], reason: 'locked' }]);
    // L: b's change, an independent CS. HLD-53: "A closure never blocks other closures".
    await fx.pushTeamChange({ [PB]: TEAM[PB]! });
    fx.advance(10_000);
    const ll = await loop(p);
    assert.deepEqual(ll.apply.closures.map((c) => ({ paths: c.paths, reason: c.reason })), [{ paths: [PA], reason: 'locked' }], 'b is not tied to a by J (which changed neither)');
    assert.ok(!ll.apply.incoming.some((c) => c.commit === J.live), "J (below LA_C, it changed no deferred path) is not among the apply's incoming CSs");
    assert.deepEqual(ll.apply.written, [PB], 'b lands while a waits');
    assert.deepEqual(await onDisk(p, [PA, PB]), { [PA]: BASE[PA]!.toString(), [PB]: TEAM[PB]!.toString() });
    const tr = fx.trace.ofKind('apply').at(-1)!;
    assert.deepEqual(tr.groups.map((g) => g.paths), [[PA], [PB]], 'two write groups in the apply trace');
  });
});

test('05 I6: a deferred closure never blocks other closures', T10, async () => {
  const fpy = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  const files = { 'README.md': buf('# i6\n'), 'f.py': buf(fpy), 'g.py': buf('g1\ng2\n'), 'book.csv': buf('k,v\n1,2\n') };
  await withCores('rlock-i6', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    // f.py: a human's line 2 held by an ON_DISK ACTIVE revert PATCH (made with hold()).
    const local = fpy.replace('l2\n', 'l2 human\n');
    await writeWork(p, 'f.py', local);
    await warm(fx, p);
    await holdPatch(p, 'f.py', local, 'revert');
    const release = lock(p, 'book.csv', 'share-none');
    await fx.pushTeamChange({ 'f.py': buf(fpy.replace('l6\n', 'l6 team\n')) });   // 4 lines from the held line
    await fx.pushTeamChange({ 'g.py': buf('g1\ng2 team\n') });
    await fx.pushTeamChange({ 'book.csv': buf('k,v\n1,3\n') });
    fx.advance(10_000);
    let rounds = 0;
    while (rounds < 2 && (await readWork(p, 'g.py'))?.toString() !== 'g1\ng2 team\n') {
      await loop(p);
      rounds++;
      fx.advance(10_000);
    }
    assert.equal((await readWork(p, 'g.py'))?.toString(), 'g1\ng2 team\n', 'g.py lands within 2 rounds');
    assert.equal((await readWork(p, 'f.py'))?.toString(), fpy.replace('l2\n', 'l2 human\n').replace('l6\n', 'l6 team\n'), 'f.py merged, the held line kept');
    assert.equal((await readWork(p, 'book.csv'))?.toString(), 'k,v\n1,2\n', 'book.csv waits for its holder');
    release();
    await loop(p);
    assert.equal((await readWork(p, 'book.csv'))?.toString(), 'k,v\n1,3\n', 'book.csv lands within 1 round after unlock');
  });
});
