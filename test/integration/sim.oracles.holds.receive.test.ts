// INV-GROUP on the receive side (Plan 3 Task 14; 11-testing §3.4 row INV-GROUP, TC-ENG-06, 05 I6 / INV-HLD-RECEIVE; HLD-53, HLD-54;
// rulings R3-31, R3-53). Every run is real git against file:// bare remotes (holdsSetup's composition; git is never mocked), with the
// eight oracles of Task 14 judging every step. Fix round 1 (R3-55) split sim.oracles.holds by area; helpers in holdsOracleScript.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferralAges } from '../../src/holds/incoming.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { seededRandom } from '../../src/ports/random.js';
import { SIM_TIMEOUT, okOrFail, type Step, scriptRun, has, holdsOf, live, disk, engineAt } from '../helpers/holdsScript.js';
import { f40, G3, g3Steps, landedChange, loopsUntil } from '../helpers/holdsOracleScript.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { seedFilesPlan3 } from '../sim/generators.js';
import type { SimContext } from '../sim/harness.js';
import { holdsOracles, peerIdOf } from '../sim/oraclesHolds.js';

/** A crash handler killing p2 at its `hit`-th `site` crashpoint after the apply event naming `path` not applicable (once). */
function killAfterNotApplicable(ctx: SimContext, site: 'registry.cas' | 'apply.state', path: string, hit: number, onKill: () => void): (name: string) => void {
  const id2 = peerIdOf(ctx, 2);
  let hits = 0;
  let killed = false;
  return (name) => {
    if (name !== site || killed) return;
    const last = [...ctx.trace.events].reverse().find((e) => e.peer === id2 && (e.kind === 'apply' || e.kind === 'iteration'));
    if (last?.kind !== 'apply' || !last.notApplicable.some((x) => x.path === path)) return;
    if (++hits < hit) return;
    killed = true;
    onKill();
    throw new KilledAt(name);
  };
}

test('oracleGroup passes on nonconforming_push bad_name with a:b.txt on p0 and p1, and on a KilledAt between an apply event and its records (at registry.cas and at apply.state, with a no-kill run beside them) and right after the record\'s CAS', { timeout: 5 * SIM_TIMEOUT }, async (t) => {
  let checked = false;
  const badName: Step[] = [
    { rounds: 1 },
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'bad_name', name: 'a:b.txt' } },
    { rounds: 6 },
    {
      probe: 'bad-name', run: async (ctx) => {
        for (const i of [0, 1]) {
          assert.ok((await disk(ctx, i, 'np/team-1/ok.txt')) !== null, `p${i} wrote np/team-1/ok.txt`);
          const rs = live(await holdsOf(ctx, i)).filter((r) => r.paths.some((p) => p.includes('a:b.txt')));
          assert.deepEqual(rs, [], `p${i}: no record names the UNMANAGED a:b.txt`);
          const id = peerIdOf(ctx, i);
          assert.ok(ctx.trace.ofKind('apply').some((e) => e.peer === id && e.written.includes('np/team-1/ok.txt')), `p${i}'s apply wrote ok.txt`);
          // outside every closure (HLD-53: carried by scope class; a host that cannot write it lists it not applicable, Flags item 8)
          assert.ok(!ctx.trace.ofKind('apply').some((e) => e.peer === id && e.groups.some((g) => g.paths.some((x) => x.includes('a:b.txt')))), `p${i}: a:b.txt is in no write group`);
        }
        checked = true;
      },
    },
    { rounds: 2 },
  ];
  okOrFail((await scriptRun('holds-group-badname', () => badName, { oracles: holdsOracles() })).r);
  assert.ok(checked);
  // The KilledAt half (EF2 D5, the Task 14 engine finding E1). An apply's ENG-36 state commit journals LA_C = TIP and the not-applicable
  // path's meta.pending row; recordStep then creates its INCOMING record (HLD-53/HLD-54, ENG-31). A kill between the two (apply.state,
  // the pre-CAS registry.cas site) used to leave the path with no record for good: the restarted engine runs no apply (the path is out of
  // the trigger, P2-NA-TRIGGER) and recordStep took the not-applicable set only from its own iteration's apply report. The record is now
  // re-derived from the journaled pending rows whose re-check still holds, so it exists by p2's first iteration after the restart
  // (oracleGroup (iv) checks that at every step); the no-kill run pins that the re-derivation never adds a second record.
  const CON = 'np/team-1/con.py';
  const conRecords = (rs: readonly HoldRecord[]): HoldRecord[] => rs.filter((r) => r.kind === 'INCOMING' && r.paths.length === 1 && r.paths[0] === CON);
  for (const site of ['registry.cas', 'apply.state', null] as const) {
    const title = site === null
      ? `with no kill p2 holds ${CON} in exactly one INCOMING record over 6 rounds (re-deriving it at every iteration adds none)`
      : `a KilledAt at p2 ${site} right after the apply event naming ${CON} not applicable: the record exists by the first p2 iteration after the restart`;
    await t.test(title, { timeout: SIM_TIMEOUT }, async () => {
      let killed = 0;
      let restore: ((name: string) => void) | null = null;
      let done = false;
      const steps: Step[] = [
        { rounds: 1 },
        {
          probe: 'arm', run: async (ctx) => {
            if (site === null) return;
            // registry.ts write(): crashpoint('registry.cas') before casRef (hit 1); apply.ts: crashpoint('apply.state') after the state commit
            restore = setCrashHandler(killAfterNotApplicable(ctx, site, CON, 1, () => { killed++; }));
          },
        },
        { kind: 'nonconforming_push', peer: 0, params: { variant: 'bad_name', name: 'con.py' } },
        { rounds: 6 },
        {
          probe: 'killed', run: async (ctx) => {
            if (site !== null) {
              setCrashHandler(restore);
              restore = null;
              assert.equal(killed, 1, `p2 was killed at ${site} right after the apply event`);
              assert.ok(ctx.opLog.some((e) => e.kind === 'killed' && e.peer === 'p2' && e.detail.startsWith(site)), 'the op-log shows the kill');
            }
            const all = await holdsOf(ctx, 2);
            assert.equal(live(conRecords(all)).length, 1, `p2 holds ${CON} in its own INCOMING record`);
            assert.equal(conRecords(all).length, 1, `p2 created exactly one INCOMING record over ${CON}`);
            done = true;
          },
        },
      ];
      try {
        okOrFail((await scriptRun('holds-group-killed', () => steps, { oracles: holdsOracles() })).r);
      } finally {
        if (restore !== null) setCrashHandler(restore);
      }
      assert.ok(done);
    });
  }
  // Finding 3 (fix round 1): a kill at registry.cas right AFTER the CAS of that INCOMING record (registry.ts writes, then emits the `hold`
  // event once write() returns): the record is durable but its creation never reached the trace. oracleGroup's (iv) reads p2's registry
  // when the obligation comes due (p2's first iteration after the restart), so it passes.
  await t.test('a KilledAt at p2 registry.cas right after the CAS of np/team-1/con.py\'s INCOMING record (durable, no hold event): oracleGroup finds the record in p2\'s registry at p2\'s first iteration after the restart', { timeout: SIM_TIMEOUT }, async () => {
    let killed = 0;
    let restore: ((name: string) => void) | null = null;
    let done = false;
    const steps: Step[] = [
      { rounds: 1 },
      // registry.ts write(): crashpoint('registry.cas') before casRef (hit 1) and after it (hit 2)
      { probe: 'arm', run: async (ctx) => { restore = setCrashHandler(killAfterNotApplicable(ctx, 'registry.cas', CON, 2, () => { killed++; })); } },
      { kind: 'nonconforming_push', peer: 0, params: { variant: 'bad_name', name: 'con.py' } },
      { rounds: 6 },
      {
        probe: 'killed', run: async (ctx) => {
          setCrashHandler(restore);
          restore = null;
          assert.equal(killed, 1, 'p2 was killed at registry.cas right after the CAS');
          assert.ok(ctx.opLog.some((e) => e.kind === 'killed' && e.peer === 'p2' && e.detail.startsWith('registry.cas')), 'the op-log shows the kill');
          const rs = live(await holdsOf(ctx, 2)).filter((r) => r.kind === 'INCOMING' && r.paths.length === 1 && r.paths[0] === 'np/team-1/con.py');
          assert.equal(rs.length, 1, 'p2 holds np/team-1/con.py in its own INCOMING record (durable before the kill)');
          const id2 = peerIdOf(ctx, 2);
          const born = ctx.trace.ofKind('hold').filter((e) => e.peer === id2 && e.id === rs[0]!.id && e.rev === 1);
          assert.deepEqual(born, [], 'its creation emitted no hold event (killed between the CAS and emitHold)');
          done = true;
        },
      },
      { rounds: 2 },
    ];
    try {
      okOrFail((await scriptRun('holds-group-killed-cas', () => steps, { oracles: holdsOracles() })).r);
    } finally {
      if (restore !== null) setCrashHandler(restore);
    }
    assert.ok(done);
  });
});

test('TC-ENG-06 SIM shape: p1\'s one CS over g/a.txt, g/b.txt and g/c.txt with g/b.txt share-read-locked on p0 leaves all three unchanged on p0, one INCOMING lock record covers exactly [g/a.txt, g/b.txt, g/c.txt] from 60 virtual s, and after unlock one apply writes all three; oracleGroup passes every step', { timeout: SIM_TIMEOUT }, async () => {
  let checked = false;
  const before = new Map<string, Buffer>();
  let firstDeferMono: number | null = null;
  const steps: Step[] = [
    ...g3Steps(),
    { kind: 'lock_share_read', peer: 0, params: { path: 'g/b.txt' } },
    {
      probe: 'before', run: async (ctx) => {
        for (const p of G3) before.set(p, (await disk(ctx, 0, p))!);
      },
    },
    ...G3.map((path): Step => ({ kind: 'edit_own', peer: 1, params: { path, row: 1, text: `p1 changed ${path}` } })),
    ...Array.from({ length: 45 }, (): Step => ({ rounds: 1 })),
    {
      probe: 'held', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        for (const p of G3) assert.ok((await disk(ctx, 0, p))!.equals(before.get(p)!), `${p} unchanged on p0 while g/b.txt is locked`);
        const deferredAt = ctx.trace.events.findIndex((e) => e.kind === 'apply' && e.peer === id0 && e.groups.some((g) => g.outcome === 'deferred' && G3.every((p) => g.paths.includes(p))));
        assert.ok(deferredAt >= 0, 'p0 deferred the closure');
        firstDeferMono = ctx.trace.monoAt(deferredAt);
        const recs = live(await holdsOf(ctx, 0)).filter((r) => r.kind === 'INCOMING' && has(r, 'lock'));
        assert.equal(recs.length, 1, 'one INCOMING lock record');
        assert.deepEqual(recs[0]!.paths, G3, 'over exactly the closure');
        const born = ctx.trace.events.findIndex((e) => e.kind === 'hold' && e.peer === id0 && e.id === recs[0]!.id);
        assert.ok(ctx.trace.monoAt(born)! - firstDeferMono! >= 60_000, `the record came at 60 virtual s (${ctx.trace.monoAt(born)! - firstDeferMono!} ms)`);
      },
    },
    { kind: 'unlock', peer: 0 },
    { rounds: 6 },
    {
      probe: 'released', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        const writes = ctx.trace.ofKind('apply').filter((e) => e.peer === id0 && G3.some((p) => e.written.includes(p)));
        const last = writes.pop()!;
        assert.ok(G3.every((p) => last.written.includes(p)), `one apply wrote all three (${JSON.stringify(last.written)})`);
        for (const p of G3) assert.ok((await disk(ctx, 0, p))!.toString('latin1').includes(`p1 changed ${p}`), `${p} has p1's row on p0`);
        assert.deepEqual(live(await holdsOf(ctx, 0)).filter((r) => r.kind === 'INCOMING' && has(r, 'lock')), [], 'the lock record ended');
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-tceng06', () => steps, { oracles: holdsOracles() })).r);
  assert.ok(checked);
});

test('05 I6 / INV-HLD-RECEIVE: with f.py held by a p0 revert record and book.csv locked on p0, separate incoming CSs on f.py (other rows, by p1), g.py (by p2) and book.csv (a nonconforming_push \'plain\' commit) arrive: f.py and g.py are written on p0 within 2 loops, book.csv within 1 loop after unlock, and oracleGroup\'s closure-partition clause passes', { timeout: SIM_TIMEOUT }, async () => {
  const seedFiles = { ...seedFilesPlan3(seededRandom('holds-receive/files')), 'f.py': f40('f'), 'g.py': f40('g', 12), 'book.csv': f40('book', 5) };
  let checked = false;
  let unlockedAt = -1;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'f.py', insert: true, row: 5, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    { kind: 'stale_save', peer: 0, params: { path: 'f.py', buffer: 'genesis', row: 1 } },   // the revert of p1's row + an own row 2
    { rounds: 12 },
    { kind: 'lock_share_read', peer: 0, params: { path: 'book.csv' } },
    {
      probe: 'held', run: async (ctx) => {
        const recs = live(await holdsOf(ctx, 0)).filter((r) => has(r, 'revert') && r.paths.includes('f.py') && r.residence === 'ON_DISK');
        assert.equal(recs.length, 1, 'p0 holds f.py in one ON_DISK revert record');
      },
    },
    { kind: 'edit_band', peer: 1, params: { path: 'f.py', insert: false, row: 15, text: 'p1 row 16' } },
    { kind: 'edit_band', peer: 2, params: { path: 'g.py', insert: false, row: 3, text: 'p2 row 4' } },
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'plain', paths: ['book.csv'] } },
    ...Array.from({ length: 16 }, (): Step => ({ rounds: 1 })),
    {
      probe: 'f.py and g.py', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        for (const [i, path] of [[1, 'f.py'], [2, 'g.py']] as const) {
          const first = await landedChange(ctx, i, path, 0);
          assert.ok(first !== null, `p${i}'s ${path} landed`);
          // the newest landing of that path (p1's f.py insertion of the first phase landed earlier)
          let newest = first;
          for (let n = await landedChange(ctx, i, path, first.push + 1); n !== null; n = await landedChange(ctx, i, path, n.push + 1)) newest = n;
          const loops = loopsUntil(ctx, id0, newest.push, (e) => e.kind === 'apply' && e.peer === id0 && e.written.includes(path));
          assert.ok(loops !== null && loops <= 2, `${path} written on p0 within 2 loops of its landing (${loops})`);
        }
        assert.ok(ctx.trace.ofKind('apply').some((e) => e.peer === id0 && e.deferred.includes('book.csv')), 'book.csv deferred on p0 (locked)');
        assert.ok((await disk(ctx, 0, 'f.py'))!.toString('latin1').includes('p1 row 16'), 'p1\'s f.py rows reached p0\'s disk');
      },
    },
    ...Array.from({ length: 12 }, (): Step => ({ rounds: 1 })),
    { kind: 'unlock', peer: 0 },
    { probe: 'unlocked', run: async (ctx) => { unlockedAt = ctx.trace.events.length; } },
    { iterate: 0 },
    {
      probe: 'book.csv', run: async (ctx) => {
        const id0 = peerIdOf(ctx, 0);
        const loops = loopsUntil(ctx, id0, unlockedAt, (e) => e.kind === 'apply' && e.peer === id0 && e.written.includes('book.csv'));
        assert.equal(loops, 1, 'book.csv written in p0\'s first loop after unlock');
        checked = true;
      },
    },
    { rounds: 4 },
  ];
  okOrFail((await scriptRun('holds-receive', () => steps, { oracles: holdsOracles(), seedFiles })).r);
  assert.ok(checked);
});

// EF4 E3-1 (R3-EF4-5; classes group-iv E16-C, seeds 7 41 63, and group-v, seed 96): the join's first apply (01-engine §3.14 step 7, ENG-52)
// runs the loop's step 5R, so a not-applicable path has its own INCOMING record and a deferred closure its 60 s clock from that apply on
// (HLD-54 "from the start", ENG-07, R3-29, R3-30; 11-testing §3.4 INV-GROUP "after every apply"). Before, nothing created the record
// when TIP stopped changing the path before the joiner's first loop iteration (EF2 D5's re-derivation needs A != TIP), and a joiner
// frozen before its first apply-admitting iteration never started the closure clock. The SIM's start-then-later-step is the production
// window of a team push landing between the join's fetch and the first loop fetch.

test('INV-GROUP (iv) engine half (EF4 E3-1): a win32 peer joining while TIP carries np/team-1/con.py holds it in its own INCOMING record right after the join (no loop iteration yet); the team\'s rename before its first iteration ends that record SUBSUMED (HLD-54)', { timeout: SIM_TIMEOUT }, async () => {
  const CON = 'np/team-1/con.py';
  let joined = false;
  let ended = false;
  const steps: Step[] = [
    { iterate: 0 },   // p0: genesis
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'bad_name', name: 'con.py' } },
    { advance: 2_500 },
    { iterate: 2 },   // p2 (win32 on every host): Engine.start → join; its first apply names CON not applicable; no loop iteration
    {
      probe: 'joined', run: async (ctx) => {
        const id2 = peerIdOf(ctx, 2);
        assert.ok(ctx.trace.ofKind('apply').some((e) => e.peer === id2 && e.notApplicable.some((x) => x.path === CON)), 'p2\'s join apply named CON not applicable');
        assert.deepEqual(ctx.trace.ofKind('iteration').filter((e) => e.peer === id2), [], 'p2 ran no loop iteration yet');
        const rs = live(await holdsOf(ctx, 2)).filter((r) => r.kind === 'INCOMING' && r.paths.length === 1 && r.paths[0] === CON && has(r, 'unmaterializable'));
        assert.equal(rs.length, 1, 'HLD-54: the join\'s first apply leaves CON in its own INCOMING record (from the start)');
        joined = true;
      },
    },
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'bad_name_fix' } },
    { advance: 2_500 },
    { iterate: 2 },   // p2's first loop iteration: TIP no longer contains CON
    {
      probe: 'ended', run: async (ctx) => {
        const all = (await holdsOf(ctx, 2)).filter((r) => r.kind === 'INCOMING' && r.paths.length === 1 && r.paths[0] === CON);
        assert.deepEqual(all.map((r) => r.state), ['SUBSUMED'], 'one record, released when TIP no longer changes CON (HLD-54)');
        ended = true;
      },
    },
    { rounds: 2 },
  ];
  // Every holds oracle judges it, INV-GROUP included: group T's T-4 (R3-EF4-5, oracle half) accepts in settleObligations (iv) a record
  // created at the join and ended SUBSUMED at the first iteration once TIP no longer changes CON; the probes above assert the engine half.
  okOrFail((await scriptRun('holds-join-na', () => steps, { oracles: holdsOracles() })).r);
  assert.ok(joined && ended);
});

test('INV-GROUP (v) engine half (EF4 E3-1): a peer joining while TIP carries a form violation of form/flip.txt starts that closure\'s 60 s clock at its join\'s first apply, so its first loop iteration 61 virtual s later holds the closure in one INCOMING eol-form record; the holds oracles pass', { timeout: SIM_TIMEOUT }, async () => {
  const FORM = 'form/flip.txt';
  let clocked = false;
  let held = false;
  const steps: Step[] = [
    { iterate: 0 },   // p0: genesis
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'form_flip' } },
    { advance: 2_500 },
    { iterate: 1 },   // p1: Engine.start → join; its first apply defers FORM (eol_form, DAT-11); no loop iteration
    {
      probe: 'joined', run: async (ctx) => {
        const id1 = peerIdOf(ctx, 1);
        assert.ok(ctx.trace.ofKind('apply').some((e) => e.peer === id1 && e.groups.some((g) => g.outcome === 'deferred' && g.reason === 'eol_form' && g.paths.includes(FORM))), 'p1\'s join apply deferred FORM (eol_form)');
        assert.deepEqual(ctx.trace.ofKind('iteration').filter((e) => e.peer === id1), [], 'p1 ran no loop iteration yet');
        assert.ok(deferralAges(engineAt(ctx, 1).core.transient).has(FORM), 'R3-30, HLD-54: the closure\'s 60 s clock started at the join\'s first apply');
        assert.deepEqual(live(await holdsOf(ctx, 1)).filter((r) => r.kind === 'INCOMING'), [], 'no record before 60 s');
        clocked = true;
      },
    },
    { advance: 61_000 },
    { iterate: 1 },   // p1's first loop iteration, 61 virtual s after the join's first apply
    {
      probe: 'held', run: async (ctx) => {
        const rs = live(await holdsOf(ctx, 1)).filter((r) => r.kind === 'INCOMING' && r.paths.includes(FORM) && has(r, 'eol-form'));
        assert.equal(rs.length, 1, 'HLD-54: the closure deferred for 60 s since the join\'s first apply is one INCOMING eol-form record');
        held = true;
      },
    },
    { rounds: 2 },
  ];
  okOrFail((await scriptRun('holds-join-closure', () => steps, { oracles: holdsOracles() })).r);
  assert.ok(clocked && held);
});
