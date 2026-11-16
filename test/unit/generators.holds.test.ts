// The `holds` profile's pure parts (Plan 3 Task 13; X-02, X-04, TST-05, F-PATH-1, F-PATH-2; rulings R3-47, R3-53): the Plan 3 seed
// files, the weight table, holdsGenerator's draws and schedule, and the non-portable host names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isBinaryBytes } from '../../src/data/rows.js';
import { portable } from '../../src/data/scope.js';
import { stageable } from '../../src/engine/stagedRead.js';
import type { GitRunner } from '../../src/git/runner.js';
import { seededRandom, type Random } from '../../src/ports/random.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { realEngine } from '../sim/engineAdapter.js';
import type { OpLogEntry, SimContext, SimOp } from '../sim/harness.js';
import type { PeerClone } from '../sim/peers.js';
import type { BareRemote } from '../sim/remote.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { VirtualClock } from '../sim/vclock.js';
import { VirtualScheduler } from '../sim/vscheduler.js';
import { MarkerModel } from '../sim/markers.js';
import {
  hangul304, holdsGenerator, holdsOp, hostNames, massResumeAllowance, nfdName, PROFILES, seedFilesPlan2, seedFilesPlan3,
  type HoldsEditKind, type HoldsFaultKind, type HoldsOpSpec, type HoldsSimOp,
} from '../sim/generators.js';

test('seedFilesPlan3 is deterministic and adds the Plan 3 fixtures with their exact shapes', () => {
  const a = seedFilesPlan3(seededRandom('f'));
  const b = seedFilesPlan3(seededRandom('f'));
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const k of Object.keys(a)) assert.ok((a[k] as Buffer).equals(b[k] as Buffer), `${k} is byte-equal across two calls`);
  const fmt = Array.from({ length: 24 }, (_, i) => `fmt/m${String(i).padStart(2, '0')}.py`);
  const want = [...Object.keys(seedFilesPlan2(seededRandom('f'))), 'ko.txt', 'bin.dat', 'big_bomcrlf.py', '.gitignore', 'form/flip.txt', ...fmt];
  for (const k of want) assert.ok(k in a, `has ${k}`);
  assert.equal(Object.keys(a).length, new Set(want).size, 'nothing else');
  // the Plan 2 files come first from the same stream: identical bytes
  const p2 = seedFilesPlan2(seededRandom('f'));
  for (const k of Object.keys(p2)) assert.ok((a[k] as Buffer).equals(p2[k] as Buffer), `${k} is seedFilesPlan2's`);

  const ko = a['ko.txt'] as Buffer;
  assert.equal(ko.filter((x) => x === 0x0a).length, 40, 'ko.txt: 40 LF rows');
  assert.ok(!ko.includes(0x0d), 'ko.txt: no CR');
  assert.equal(new TextDecoder('euc-kr', { fatal: true }).decode(ko).split('\n')[0], 'row 1 \u{d55c}\u{ae00}');
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(ko));

  const bin = a['bin.dat'] as Buffer;
  assert.equal(bin.length, 4_096);
  assert.equal(bin[0], 0x00);
  assert.equal(isBinaryBytes(bin), true);

  const big = a['big_bomcrlf.py'] as Buffer;
  assert.deepEqual([...big.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'big_bomcrlf.py starts with a UTF-8 BOM');
  assert.ok(!big.includes(0x0d), 'big_bomcrlf.py is stored LF');
  assert.equal(big.filter((x) => x === 0x0a).length, 26_436);
  assert.ok(big.length >= 1_100_000 && big.length <= 1_600_000, `big_bomcrlf.py is ${big.length} bytes`);

  assert.equal((a['.gitignore'] as Buffer).toString('utf8'), '*.log\nbuild/\n');
  assert.equal((a['form/flip.txt'] as Buffer).toString('utf8'), Array.from({ length: 12 }, (_, k) => `flip ${k + 1}\n`).join(''));
  for (const f of fmt) {
    const rows = (a[f] as Buffer).toString('utf8').split('\n');
    assert.equal(rows.pop(), '', `${f} ends with LF`);
    assert.equal(rows.length, 12, `${f}: 12 rows`);
    assert.ok(rows.every((r) => r.startsWith('    ') && !r.startsWith('     ')), `${f}: every row starts with 4 spaces`);
    assert.equal(rows[0], '    v1 = 1');
  }
});

test('PROFILES.holds has steps 60, engineWeight 45 and exactly the Task 13 weight table (partition, heal, reject_transient, race_push, formatter and resume at 0); PROFILES.edits and PROFILES.faults gain steps 40 and are otherwise unchanged', () => {
  const h = PROFILES.holds;
  assert.equal(h.name, 'holds');
  assert.equal(h.steps, 60);
  assert.equal(h.engineWeight, 45);
  assert.deepEqual({ ...h.weights }, {
    new_file: 3, edit_own: 6, edit_band: 6, edit_same_line: 3, append_md: 2, eol_rewrite: 1, delete_own: 1, temp_file: 1, secret_name: 1,
    edit_peer_line: 5, stale_save: 4, rewind: 2, collide_ignored: 2, nonportable_name: 2, write_during_apply: 2,
    lock_share_read: 2, lock_share_none: 1, unlock: 3, age_24h: 1, resolve: 6, gc_prune: 1, nonconforming_push: 2,
    partition: 0, heal: 0, reject_transient: 0, race_push: 0, formatter: 0, resume: 0,
  });
  const plan2 = { new_file: 4, edit_own: 3, edit_band: 4, edit_same_line: 1, append_md: 2, eol_rewrite: 1, delete_own: 1, temp_file: 1, secret_name: 1 };
  assert.deepEqual({ ...PROFILES.edits }, { name: 'edits', engineWeight: 18, steps: 40, weights: plan2 });
  assert.deepEqual({ ...PROFILES.faults, weights: { ...PROFILES.faults.weights } }, {
    name: 'faults', engineWeight: 22, steps: 40, weights: { ...plan2, partition: 1, heal: 1, reject_transient: 1, race_push: 2 },
  });
  assert.ok(Object.isFrozen(PROFILES) && Object.isFrozen(PROFILES.holds) && Object.isFrozen(PROFILES.holds.weights));
});

/** A SimContext without git or disk; every property but random, peers and clocks throws when read (a Proxy), as do Math.random and Date.now. */
function stubCtx(random: Random, peers = 3): { ctx: SimContext; read: Set<string> } {
  const names = Array.from({ length: peers }, (_, i) => `p${i}`);
  const clones = names.map((name, i): PeerClone => ({
    name, dir: `/nowhere/${name}`, filterCountFile: '', canary: '', opts: { name, autocrlf: i % 2 === 1, withFilter: false },
  }));
  const base: SimContext = {
    root: '/nowhere', remote: {} as BareRemote, peers: clones, git: {} as GitRunner, random,
    clocks: new Map(names.map((n) => [n, new VirtualClock()] as const)), scheduler: new VirtualScheduler(new VirtualClock(), seededRandom('s')),
    opLog: [], seed: 'g', engines: [], trace: new TraceRecorder(), phase: 'ops', quiescence: null,
  };
  const read = new Set<string>();
  const allowed = new Set(['random', 'peers', 'clocks']);
  const ctx = new Proxy(base, {
    get(t, prop, recv) {
      if (typeof prop === 'string') {
        read.add(prop);
        if (!allowed.has(prop)) throw new Error(`holdsGenerator.next read ctx.${prop}`);
      }
      return Reflect.get(t, prop, recv) as unknown;
    },
  });
  return { ctx, read };
}

interface Drawn { step: number; kind: string; peer: string; specs: readonly HoldsOpSpec[]; }

/** The spec(s) a drawn op runs (holdsOp's HoldsSimOp; a step-57 composite carries several). */
function specsOf(op: SimOp): readonly HoldsOpSpec[] {
  assert.ok('specs' in op, `${op.kind} carries its specs`);
  return (op as HoldsSimOp).specs;
}

/**
 * The fixes still owed after the ops drawn up to `upTo`: a bad_name without its bad_name_fix, a form_flip without its form_fix, and per
 * peer each nonportable_name without a later `fix: true` of that peer — as fix specs in the generator's step-S−3 order.
 */
function owedFixes(drawn: readonly Drawn[], upTo: number): HoldsOpSpec[] {
  let badName = false;
  let formFlip = false;
  const np = new Map<number, number>();
  for (const d of drawn) {
    if (d.step > upTo) continue;
    for (const sp of d.specs) {
      const v = sp.params?.['variant'];
      if (sp.kind === 'nonconforming_push') {
        if (v === 'bad_name') badName = true;
        if (v === 'bad_name_fix') badName = false;
        if (v === 'form_flip') formFlip = true;
        if (v === 'form_fix') formFlip = false;
      }
      if (sp.kind === 'nonportable_name') np.set(sp.peer, (np.get(sp.peer) ?? 0) + (sp.params?.['fix'] === true ? -1 : 1));
    }
  }
  const out: HoldsOpSpec[] = [];
  if (badName) out.push({ kind: 'nonconforming_push', peer: 0, params: { variant: 'bad_name_fix' } });
  if (formFlip) out.push({ kind: 'nonconforming_push', peer: 0, params: { variant: 'form_fix' } });
  for (const [peer, n] of [...np.entries()].sort((a, b) => a[0] - b[0])) for (let x = 0; x < n; x++) out.push({ kind: 'nonportable_name', peer, params: { fix: true } });
  return out;
}

const specKey = (sp: HoldsOpSpec): string => JSON.stringify([sp.kind, sp.peer, sp.params ?? {}]);
const isFix = (sp: HoldsOpSpec): boolean => sp.params?.['fix'] === true || sp.params?.['variant'] === 'bad_name_fix' || sp.params?.['variant'] === 'form_fix';

/**
 * Step 57 (S − 3) of one run: when fixes are still owed after step 56, the step's op runs exactly them (a composite, or the one fix);
 * when none is owed, no fix op runs there; and nothing is owed after step 57. Returns whether any fix was owed after step 56.
 */
function checkStep57(drawn: readonly Drawn[], label: string): boolean {
  const owed = owedFixes(drawn, 56);
  const at57 = drawn.find((d) => d.step === 57);
  if (owed.length > 0) {
    assert.ok(at57 !== undefined, `${label}: step 57 runs the owed fixes ${JSON.stringify(owed)}`);
    assert.deepEqual(at57.specs.map(specKey).sort(), owed.map(specKey).sort(), `${label}: step 57 runs exactly the owed fixes`);
  } else {
    assert.ok(at57 === undefined || !at57.specs.some(isFix), `${label}: no fix at step 57 when none is owed (${JSON.stringify(at57)})`);
  }
  assert.deepEqual(owedFixes(drawn, 57), [], `${label}: no fix owed after step 57`);
  return owed.length > 0;
}

test('holdsGenerator.next draws every weighted kind within 600 draws of a SimContext stub with seededRandom(\'g\'), schedules exactly one formatter at a step in [10, 30] with its resume 3–8 steps later, emits the step 57–59 cleanup ops, draws lock ops only before step 40 and age_24h at most twice from step 20, and reads nothing but ctx.random', () => {
  const random = seededRandom('g');
  const gen = holdsGenerator(PROFILES.holds, new MarkerModel('g'));
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = () => assert.fail('Math.random called by the generator');
  Date.now = () => assert.fail('Date.now called by the generator');
  const seen = new Set<string>();
  const reads = new Set<string>();
  let lockOps = 0;
  /** Runs in which a fix was still owed after step 56 (step 57's cleanup then had work to do). */
  let owedAt56 = 0;
  try {
    for (let run = 0; run < 10; run++) {
      const { ctx, read } = stubCtx(random);
      const drawn: Drawn[] = [];
      /** Every peer's virtual mono at each step (the clocks advance together). */
      const monos: number[] = [];
      // Each step advances every peer clock 1–5 s, as the harness does; next() sees only the draws and the clocks.
      for (let step = 0; step < 60; step++) {
        const dt = 1_000 + (step * 1_013) % 4_001;
        for (const c of ctx.clocks.values()) c.advance(dt);
        monos.push((ctx.clocks.get('p0') as VirtualClock).monoMs());
        const op = gen.next(ctx, step);
        if (op !== null) {
          drawn.push({ step, kind: op.kind, peer: op.peer, specs: specsOf(op) });
          seen.add(op.kind);
        }
      }
      for (const r of read) reads.add(r);
      const at = (k: string): Drawn[] => drawn.filter((d) => d.kind === k);
      // exactly one formatter in [10, 30], its peer's resume 3–8 steps later
      const fmt = at('formatter');
      assert.equal(fmt.length, 1, `run ${run}: one formatter (${JSON.stringify(fmt)})`);
      const f = fmt[0] as Drawn;
      assert.ok(f.step >= 10 && f.step <= 30, `run ${run}: formatter at ${f.step}`);
      const resume = at('resume').filter((d) => d.step < 57);
      assert.equal(resume.length, 1, `run ${run}: one scheduled resume before the cleanup (${JSON.stringify(resume)})`);
      const rs = resume[0] as Drawn;
      assert.equal(rs.peer, f.peer, `run ${run}: the formatter's peer is resumed`);
      assert.ok(rs.step - f.step >= 3 && rs.step - f.step <= 8, `run ${run}: resume ${rs.step - f.step} steps after the formatter`);
      // cleanup: 58 resumes every MASS peer ('*'); 59 unlocks every lock when one is still held; 57 runs the pending fixes
      assert.deepEqual(drawn.filter((d) => d.step === 58).map((d) => [d.kind, d.peer]), [['resume', '*']], `run ${run}: step 58`);
      let held = 0;
      for (const d of drawn.filter((x) => x.step < 59)) {
        if (d.kind === 'lock_share_read' || d.kind === 'lock_share_none') held++;
        if (d.kind === 'unlock') held--;
      }
      const s59 = drawn.find((d) => d.step === 59);
      if (held > 0) assert.deepEqual([s59?.kind, s59?.peer], ['unlock', '*'], `run ${run}: step 59 unlocks the ${held} lock(s) still held`);
      else assert.ok(s59 === undefined || s59.peer !== '*' || s59.kind !== 'unlock', `run ${run}: no forced unlock without a lock`);
      const lateFixable = drawn.filter((d) => d.kind === 'nonportable_name' || d.kind === 'nonconforming_push');
      assert.ok(lateFixable.every((d) => d.step <= 57), `run ${run}: no non-portable name or team push after the step-57 fixes`);
      if (checkStep57(drawn, `run ${run}`)) owedAt56++;
      // lock ops only before step 40, at most one per peer and two in all; unlocks only for a lock held 60 s of its holder's mono
      const locks = drawn.filter((d) => d.kind === 'lock_share_read' || d.kind === 'lock_share_none');
      for (const d of locks) assert.ok(d.step < 40, `run ${run}: ${d.kind} at ${d.step}`);
      assert.ok(locks.length <= 2, `run ${run}: ${locks.length} lock ops`);
      assert.equal(new Set(locks.map((d) => d.peer)).size, locks.length, `run ${run}: one lock per peer`);
      for (const u of drawn.filter((d) => d.kind === 'unlock' && d.peer !== '*')) {
        const l = locks.filter((d) => d.peer === u.peer && d.step < u.step).pop();
        assert.ok(l !== undefined && (monos[u.step] as number) - (monos[l.step] as number) >= 60_000, `run ${run}: unlock of ${u.peer} at ${u.step} after a lock held 60 s`);
      }
      lockOps += locks.length;
      // age_24h at most twice, only from step 20
      const ages = at('age_24h');
      assert.ok(ages.length <= 2 && ages.every((d) => d.step >= 20 && d.peer === '*'), `run ${run}: age_24h ${JSON.stringify(ages)}`);
    }
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
  const weighted = (Object.entries(PROFILES.holds.weights) as Array<[HoldsEditKind | HoldsFaultKind, number]>).filter(([, w]) => w > 0).map(([k]) => k);
  for (const k of weighted) assert.ok(seen.has(k), `${k} drawn within 600 draws`);
  assert.ok(lockOps > 2, `the lock rules were exercised (${lockOps} lock ops over 10 runs)`);
  // A fix-heavy profile: a nonportable_name or team push drawn late leaves its fix owed at step 56 in every run, so step 57 must run it.
  for (let run = 0; run < 5; run++) {
    const g = holdsGenerator({ ...PROFILES.holds, engineWeight: 1, weights: { nonportable_name: 20, nonconforming_push: 20, edit_own: 1 } }, new MarkerModel('g'));
    const { ctx } = stubCtx(seededRandom(`fixes-${run}`));
    const drawn: Drawn[] = [];
    for (let step = 0; step < 60; step++) {
      for (const c of ctx.clocks.values()) c.advance(4_000);
      const op = g.next(ctx, step);
      if (op !== null) drawn.push({ step, kind: op.kind, peer: op.peer, specs: specsOf(op) });
    }
    assert.ok(checkStep57(drawn, `fix-heavy run ${run}`), `fix-heavy run ${run}: a fix was owed after step 56`);
    owedAt56++;
  }
  assert.ok(owedAt56 > 5, `step 57's cleanup had owed fixes to emit in ${owedAt56} runs`);
  // A lock-heavy profile: still at most one lock per peer and two in all per seed, however many unlocks free a peer again.
  for (let run = 0; run < 5; run++) {
    const g = holdsGenerator({ ...PROFILES.holds, engineWeight: 1, weights: { lock_share_read: 20, lock_share_none: 20, unlock: 20, edit_own: 1 } }, new MarkerModel('g'));
    const { ctx } = stubCtx(seededRandom(`locks-${run}`));
    const kinds: Array<[string, string]> = [];
    for (let step = 0; step < 60; step++) {
      for (const c of ctx.clocks.values()) c.advance(4_000);
      const op = g.next(ctx, step);
      if (op !== null) kinds.push([op.kind, op.peer]);
    }
    const locks = kinds.filter(([k]) => k === 'lock_share_read' || k === 'lock_share_none');
    assert.equal(locks.length, 2, `lock-heavy run ${run}: two lock ops in all (${JSON.stringify(kinds)})`);
    assert.notEqual(locks[0]![1], locks[1]![1], `lock-heavy run ${run}: on two peers`);
    assert.ok(kinds.some(([k, p]) => k === 'unlock' && p !== '*'), `lock-heavy run ${run}: a drawn unlock freed a peer`);
  }
  for (const k of ['partition', 'heal', 'reject_transient', 'race_push']) assert.ok(!seen.has(k), `no ${k} (weight 0)`);
  assert.deepEqual([...reads].sort(), ['clocks', 'peers', 'random'], 'next() reads ctx.random, the peers (their count) and their clocks, nothing else');

  // ctx.random is the only source of draws: the same stream replays the same ops
  const replay = (): string[] => {
    const g = holdsGenerator(PROFILES.holds, new MarkerModel('g'));
    const { ctx } = stubCtx(seededRandom('g2'));
    const out: string[] = [];
    for (let step = 0; step < 60; step++) {
      for (const c of ctx.clocks.values()) c.advance(2_000);
      const op = g.next(ctx, step);
      out.push(op === null ? 'engine' : `${op.peer} ${op.kind}`);
    }
    return out;
  };
  assert.deepEqual(replay(), replay());
});

test('no op writes a path under its peer\'s active lock: with p0\'s shared.txt, notes.md or p1\'s notes.txt locked, edit_band, append_md, edit_same_line (from either peer) and the explicit-path ops skip with \'locked\' and leave the bytes unchanged, eol_rewrite\'s drawn list passes over the locked file, and another peer\'s copy stays writable', async () => {
  const { root, cleanup } = await makeTempRoot('holds-lock-targets');
  try {
    const files = seedFilesPlan2(seededRandom('lock-targets'));
    const names = ['p0', 'p1'];
    const peers: PeerClone[] = [];
    for (const name of names) {
      const dir = join(root, name);
      for (const [path, bytes] of Object.entries(files)) {
        const abs = join(dir, ...path.split('/'));
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, bytes);
      }
      peers.push({ name, dir, filterCountFile: '', canary: '', opts: { name, autocrlf: false, withFilter: false } });
    }
    const ctx: SimContext = {
      root, remote: { dir: join(root, 'remote.git'), url: 'file:///nowhere' } as BareRemote, peers, git: testRunner(), random: seededRandom('lock-targets'),
      clocks: new Map(names.map((n) => [n, new VirtualClock()] as const)), scheduler: new VirtualScheduler(new VirtualClock(), seededRandom('s')),
      opLog: [], seed: 'lock-targets', engines: [], trace: new TraceRecorder(), phase: 'ops', quiescence: null,
    };
    // realEngine peers that never step: opLock needs each peer's FaultFs (faultFsOf); no engine runs, so no op reads an A tree.
    const factory = realEngine();
    ctx.engines.push(...peers.map((p) => factory(ctx, p)));
    const markers = new MarkerModel('locks');
    const run = async (spec: HoldsOpSpec): Promise<string> => {
      ctx.opLog.push({ step: ctx.opLog.length, peer: `p${spec.peer}`, kind: spec.kind, detail: '' });
      return holdsOp(spec, markers).run(ctx);
    };
    const bytes = async (i: number, path: string): Promise<Buffer> => readFile(join(peers[i]!.dir, ...path.split('/')));
    const unchanged = async (i: number, path: string, label: string): Promise<void> => {
      assert.ok((await bytes(i, path)).equals(files[path]!), `${label}: p${i}'s ${path} is unchanged`);
    };

    // p0's shared.txt under a share-none lock
    assert.equal(await run({ kind: 'lock_share_none', peer: 0, params: { path: 'shared.txt' } }), 'shared.txt mode=share-none');
    const onLocked: HoldsOpSpec[] = [
      { kind: 'edit_band', peer: 0, params: { insert: false } },
      { kind: 'edit_band', peer: 0, params: { insert: true, n: 2 } },
      { kind: 'edit_own', peer: 0, params: { path: 'shared.txt', row: 0 } },
      { kind: 'eol_rewrite', peer: 0, params: { path: 'shared.txt' } },
      { kind: 'edit_peer_line', peer: 0, params: { path: 'shared.txt' } },
      { kind: 'stale_save', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },
      { kind: 'rewind', peer: 0, params: { path: 'shared.txt', buffer: 'genesis' } },
      { kind: 'delete_own', peer: 0, params: { path: 'shared.txt' } },
      { kind: 'new_file', peer: 0, params: { path: 'shared.txt' } },
      { kind: 'write_during_apply', peer: 0, params: { path: 'shared.txt' } },
    ];
    for (const spec of onLocked) {
      assert.equal(await run(spec), `${spec.kind} p0 skipped (locked)`, JSON.stringify(spec));
      await unchanged(0, 'shared.txt', spec.kind);
    }
    // the drawn eol_rewrite list (crlf.txt, shared.txt, big.py, the unicode file, ko.txt, own files) never picks the locked file
    for (let n = 0; n < 8; n++) {
      const detail = await run({ kind: 'eol_rewrite', peer: 0 });
      assert.ok(!detail.startsWith('shared.txt '), `drawn eol_rewrite ${n}: ${detail}`);
      await unchanged(0, 'shared.txt', `drawn eol_rewrite ${n}`);
    }
    // a lock is on its holder's disk only: p1's shared.txt stays writable
    assert.match(await run({ kind: 'edit_band', peer: 1, params: { insert: false } }), /^shared\.txt row=\d+ CWM_locks_\d+_p1$/);
    assert.match(await run({ kind: 'unlock', peer: 0 }), /^shared\.txt held_ms=/);
    assert.match(await run({ kind: 'edit_band', peer: 0, params: { insert: false } }), /^shared\.txt row=\d+ CWM_locks_\d+_p0$/, 'unlocked: writable again');

    // append_md's fixed target
    await run({ kind: 'lock_share_read', peer: 0, params: { path: 'notes.md' } });
    assert.equal(await run({ kind: 'append_md', peer: 0 }), 'append_md p0 skipped (locked)');
    await unchanged(0, 'notes.md', 'append_md');
    await run({ kind: 'unlock', peer: 0 });

    // edit_same_line writes notes.txt on both peers: a lock on either one skips the op, and neither copy changes
    await run({ kind: 'lock_share_read', peer: 1, params: { path: 'notes.txt' } });
    assert.equal(await run({ kind: 'edit_same_line', peer: 0, params: { other: 1 } }), 'edit_same_line p0 skipped (locked)');
    assert.equal(await run({ kind: 'edit_same_line', peer: 1, params: { other: 0 } }), 'edit_same_line p1 skipped (locked)');
    await unchanged(0, 'notes.txt', 'edit_same_line');
    await unchanged(1, 'notes.txt', 'edit_same_line');
    await run({ kind: 'unlock', peer: 1 });
    assert.match(await run({ kind: 'edit_same_line', peer: 0, params: { other: 1 } }), /^notes\.txt row=\d+ peers=p0,p1 /, 'unlocked: both write');
  } finally {
    await cleanup();
  }
});

test('every host-table name fails portable() with the rule it names (con.py 2, a:b.txt 2, trail. 2, HANGUL304 2, the NFD name 1), con.py, trail. and HANGUL304 are stageable() while a:b.txt and NFD are not, and an emulated win32 peer draws only NFD on a Linux host and skips the op (`no host name`) on a darwin host, while a real win32 host draws HANGUL304 or NFD', async () => {
  const rule = (p: string): number | null => {
    const r = portable(p, new Set());
    return r.ok ? null : r.rule;
  };
  assert.deepEqual([rule('con.py'), rule('a:b.txt'), rule('trail.'), rule(hangul304(1)), rule(nfdName(1))], [2, 2, 2, 2, 1]);
  assert.ok(Buffer.byteLength(hangul304(1).split('/')[1] as string, 'utf8') > 300, 'HANGUL304: one component over 300 UTF-8 bytes');
  assert.equal(nfdName(1), 'nfd/\u{1112}\u{1161}\u{11ab}-1.txt');
  assert.equal(nfdName(1).normalize('NFC'), 'nfd/\u{d55c}-1.txt');
  assert.deepEqual([stageable('con.py'), stageable('trail.'), stageable(hangul304(1))], [true, true, true]);
  assert.deepEqual([stageable('a:b.txt'), stageable(nfdName(1))], [false, false]);

  assert.deepEqual(hostNames(undefined, 'linux', 3), ['con.py', 'trail.', 'a:b.txt', nfdName(3)]);
  assert.deepEqual(hostNames(undefined, 'darwin', 3), ['con.py', 'trail.', 'a:b.txt']);
  assert.deepEqual(hostNames('win32', 'linux', 3), [nfdName(3)], 'an emulated win32 peer on Linux: NFD only');
  assert.deepEqual(hostNames('win32', 'darwin', 3), [], 'an emulated win32 peer on darwin: nothing');
  assert.deepEqual(hostNames(undefined, 'win32', 3), [hangul304(3), nfdName(3)], 'a real win32 host');
  assert.deepEqual(hostNames('win32', 'win32', 3), [hangul304(3), nfdName(3)], 'p2 on a real win32 host is a real win32 host');

  // The op itself on an emulated win32 peer of a darwin host: skipped before it writes anything.
  const clone: PeerClone = { name: 'p0', dir: '/nowhere/p0', filterCountFile: '', canary: '', opts: { name: 'p0', autocrlf: false, withFilter: false, platform: 'win32' } };
  const ctx = {
    root: '/nowhere', peers: [clone], clocks: new Map([['p0', new VirtualClock()]]), engines: [], opLog: [{ step: 4, peer: 'p0', kind: 'nonportable_name', detail: '' }],
    seed: 'np', random: seededRandom('np'),
  } as unknown as SimContext;
  const op = holdsOp({ kind: 'nonportable_name', peer: 0, params: { host: 'darwin' } }, new MarkerModel('np'));
  assert.equal(await op.run(ctx), 'nonportable_name p0 skipped (no host name)');
});

test('EF2 r1 F4: massResumeAllowance attributes a quiescence resume of a peer frozen MASS to a formatter op of that peer (or a kill of it after one) not yet consumed by a resume that lifted MASS', () => {
  const lifted = JSON.stringify({ nonretryable: false, hostRejectReleased: null, massLifted: true });
  const nothing = JSON.stringify({ nonretryable: false, hostRejectReleased: null, massLifted: false });
  const row = (step: number, peer: string, kind: string, detail = ''): OpLogEntry => ({ step, peer, kind, detail });
  // No formatter op at all: nothing to attribute a MASS freeze to.
  assert.deepEqual(massResumeAllowance([row(1, 'p1', 'edit_band', 'dt=1 shared.txt row=4')], 'p1'), { credits: 0, used: 0 });
  // A formatter op whose scheduled resume was skipped (the peer was down): one credit, unused.
  const skipped = [row(10, 'p1', 'formatter', 'dt=2 24 files glob=fmt/*.py'), row(11, 'p1', 'killed', 'apply.state'), row(14, 'p1', 'resume', 'dt=3 resume p1 skipped (no engine)')];
  assert.deepEqual(massResumeAllowance(skipped, 'p1'), { credits: 2, used: 0 }, 'the formatter and the kill after it');
  // A skipped formatter op is no credit; another peer's formatter op is not this peer's.
  assert.deepEqual(massResumeAllowance([row(10, 'p1', 'formatter', 'dt=2 formatter p1 skipped (nothing matches fmt/*.py)'), row(12, 'p2', 'formatter', 'dt=2 24 files glob=fmt/*.py')], 'p1'), { credits: 0, used: 0 });
  // A scheduled resume that lifted MASS consumes the credit; one that lifted nothing does not.
  assert.deepEqual(massResumeAllowance([row(10, 'p1', 'formatter', 'dt=2 24 files'), row(14, 'p1', 'resume', `dt=3 ${lifted}`)], 'p1'), { credits: 1, used: 1 });
  assert.deepEqual(massResumeAllowance([row(10, 'p1', 'formatter', 'dt=2 24 files'), row(14, 'p1', 'resume', `dt=3 ${nothing}`)], 'p1'), { credits: 1, used: 0 });
  // Step S−2's forced cleanup (one row by p0 naming every resumed peer) and an earlier quiescence resume count for the peer they name.
  const cleanup = [row(10, 'p1', 'formatter', 'dt=2 24 files'), row(58, '*', 'resume', `dt=1 p1 ${lifted}; p2 ${lifted}`)];
  assert.deepEqual(massResumeAllowance(cleanup, 'p1'), { credits: 1, used: 1 });
  assert.deepEqual(massResumeAllowance(cleanup, 'p2'), { credits: 0, used: 1 });
  assert.deepEqual(massResumeAllowance([row(10, 'p1', 'formatter', 'dt=2 24 files'), row(61, 'p1', 'resume', `quiescence ${lifted}`)], 'p1'), { credits: 1, used: 1 });
});
