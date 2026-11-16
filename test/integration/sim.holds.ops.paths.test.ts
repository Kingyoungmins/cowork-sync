// The holds catalogue's ops against the real engine: paths (Plan 3 Task 13; 11-testing §3.5 F-PATH-1, F-ED-9; DAT-29, DAT-32, DAT-33,
// HLD-42, HLD-52, R3-31…R3-33, R3-47, R3-53, I-DAT-13 shape): collide_ignored, nonportable_name (stageable and not), and the
// non-conforming team writer (bad_name, form_flip). Scripted holds runs on real git against file:// bare remotes (fix round 1 split of
// sim.holds.ops.test.ts; helpers in test/helpers/holdsScript.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageable } from '../../src/engine/stagedRead.js';
import { parseOid } from '../../src/git/oid.js';
import { isTerminal } from '../../src/holds/record.js';
import { REFS, SIM_TIMEOUT, okOrFail, type Step, scriptRun, engineAt, has, holdsOf, live, liveTree, liveFile, disk, blobOf, logCodes, watch } from '../helpers/holdsScript.js';
import { realEngineOf } from '../sim/engineAdapter.js';
import { hangul304, nfdName } from '../sim/generators.js';
import type { Oracle } from '../sim/harness.js';
import { boardHolds, readStatus } from '../sim/holdsView.js';
import { findMarkers } from '../sim/markers.js';

// ---- DAT-29 ----------------------------------------------------------------------------------------------------------------

test('collide_ignored: p0\'s excluded local/c1.cfg stays byte-identical while p1 publishes local/c1.cfg; p0 holds one INCOMING collision record at once (INCOMING_COLLISION in status), p2 has the file; resolve --publish on p0 creates one OFF_DISK PARKED PATCH holding p0\'s bytes before p1\'s version is on p0\'s disk; in a second run resolve --discard keeps p0\'s file and the record ends SUBSUMED when p1 deletes the path', { timeout: SIM_TIMEOUT }, async () => {
  const PATH = 'local/c1.cfg';
  let mine: Buffer | null = null;
  let theirs: Buffer | null = null;
  const collided: Step[] = [
    { rounds: 1 },
    { kind: 'collide_ignored', peer: 0, params: { other: 1, name: 'c1.cfg' } },
    {
      probe: 'bytes', run: async (ctx) => {
        mine = await disk(ctx, 0, PATH);
        theirs = await disk(ctx, 1, PATH);
      },
    },
    { rounds: 12 },
    {
      probe: 'collision', run: async (ctx) => {
        assert.deepEqual(await disk(ctx, 0, PATH), mine, 'p0\'s excluded file is byte-identical');
        assert.ok((await liveFile(ctx, PATH)) !== null, 'p1 published local/c1.cfg');
        const p2 = await disk(ctx, 2, PATH);
        assert.ok(p2 !== null && findMarkers(p2).join() === findMarkers(theirs!).join(), 'p2 has p1\'s file');
        const rs = live(await holdsOf(ctx, 0)).filter((r) => r.kind === 'INCOMING' && has(r, 'collision') && r.paths.includes(PATH));
        assert.equal(rs.length, 1, 'one INCOMING collision record');
        const st = await readStatus(ctx.peers[0]!.dir);
        const logged = (await logCodes(ctx, 0)).some((l) => l.code === 'INCOMING_COLLISION');
        assert.ok(st?.message_code === 'INCOMING_COLLISION' || logged, `INCOMING_COLLISION in status (${st?.message_code}) or its log`);
        assert.ok(st!.pending.not_converged.includes(PATH));
      },
    },
  ];
  // run 1: --publish takes p1's version; p0's bytes go into a guard-less OFF_DISK PARKED capture first
  let checked1 = false;
  const one = await scriptRun('holds-collide-publish', () => [
    ...collided,
    { kind: 'resolve', peer: 0, params: { verb: 'publish' } },
    { rounds: 6 },
    {
      probe: 'take', run: async (ctx) => {
        const peer = engineAt(ctx, 0).peerId;
        const caps = live(await holdsOf(ctx, 0)).filter((r) => r.kind === 'PATCH' && r.residence === 'OFF_DISK' && r.state === 'PARKED' && r.paths.includes(PATH));
        assert.equal(caps.length, 1, 'one OFF_DISK PARKED capture');
        const held = await blobOf(ctx, 0, (caps[0]!.blobs as { h1: Record<string, string> }).h1[PATH]);
        assert.deepEqual(held, mine, 'it holds p0\'s bytes');
        const onDisk = await disk(ctx, 0, PATH);
        assert.deepEqual(findMarkers(onDisk!), findMarkers(theirs!), 'p1\'s version is on p0\'s disk now');
        // record before displacement: the capture's creation event precedes the apply that wrote p1's version on p0
        const evs = ctx.trace.events;
        const created = evs.findIndex((e) => e.kind === 'hold' && e.peer === peer && e.id === caps[0]!.id);
        const wrote = evs.findIndex((e) => e.kind === 'apply' && e.peer === peer && e.written.includes(PATH));
        assert.ok(created >= 0 && (wrote < 0 || created < wrote), `the capture (${created}) before the write (${wrote})`);
        checked1 = true;
      },
    },
  ]);
  okOrFail(one.r);
  assert.ok(checked1);
  // run 2: --discard keeps p0's file (collision:keep); p1 deletes the path and the record ends SUBSUMED
  let checked2 = false;
  const two = await scriptRun('holds-collide-discard', () => [
    ...collided,
    { kind: 'resolve', peer: 0, params: { verb: 'discard' } },
    { rounds: 3 },
    { kind: 'delete_own', peer: 1, params: { path: PATH } },
    { rounds: 12 },
    {
      probe: 'keep', run: async (ctx) => {
        assert.deepEqual(await disk(ctx, 0, PATH), mine, 'p0\'s file is kept');
        const rs = (await holdsOf(ctx, 0)).filter((r) => r.kind === 'INCOMING' && has(r, 'collision'));
        assert.equal(rs.length, 1);
        assert.equal(rs[0]!.state, 'SUBSUMED');
        assert.ok(rs[0]!.guards.some((g) => g.name === 'collision:keep'), 'the answer was recorded');
        checked2 = true;
      },
    },
  ]);
  okOrFail(two.r);
  assert.ok(checked2);
});

// ---- F-PATH-1, F-ED-9: non-portable names --------------------------------------------------------------------------------

test('nonportable_name on p0 with a stageable host-table name (con.py on Linux and macOS, HANGUL304 on Windows) and np/ok-p0-1.txt gives one local_only PATCH \'portability\' (PATH_NOT_PORTABLE, board stub without held/) and one dependency PIN over np/ok-p0-1.txt; the fix op ends both records and np/fixed-1.txt and np/ok-p0-1.txt publish in one live commit', { timeout: SIM_TIMEOUT }, async (t) => {
  const BAD = process.platform === 'win32' ? hangul304(1) : 'con.py';
  assert.ok(stageable(BAD));
  let ids: { portability: string; pin: string } | null = null;
  let checked = false;
  let fixed = false;
  let oneCommit: string[] = [];
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'nonportable_name', peer: 0, params: { name: BAD } },
    { rounds: 12 },
    {
      probe: 'records', run: async (ctx) => {
        const rs = live(await holdsOf(ctx, 0));
        const port = rs.filter((r) => has(r, 'portability'));
        assert.equal(port.length, 1, `one portability record: ${JSON.stringify(rs.map((r) => [r.kind, r.guards.map((g) => g.name), r.paths]))}`);
        const p = port[0]!;
        assert.deepEqual([p.kind, p.residence, p.local_only, p.paths], ['PATCH', 'ON_DISK', true, [BAD]]);
        const pins = rs.filter((r) => r.kind === 'PIN' && r.guards.some((g) => g.name === `dependency:${p.id}`));
        assert.equal(pins.length, 1, 'one dependency PIN');
        assert.deepEqual(pins[0]!.paths, ['np/ok-p0-1.txt']);
        assert.ok((await logCodes(ctx, 0)).some((l) => l.code === 'PATH_NOT_PORTABLE'), 'PATH_NOT_PORTABLE in the log');
        const board = (await ctx.remote.refs())[REFS.remoteBoard]!;
        const view = await boardHolds(ctx.git, ctx.peers[0]!.dir, parseOid(board));
        assert.equal(view.holds[p.id]?.local_only, true, 'the board holds the stub');
        assert.equal(view.held.has(p.id), false, 'no held/ for a local_only record');
        assert.equal((await liveFile(ctx, 'np/ok-p0-1.txt')), null, 'np/ok-p0-1.txt waits with the CS');
        ids = { portability: p.id, pin: pins[0]!.id };
        fixed = true;   // the next step is the fix
      },
    },
    { kind: 'nonportable_name', peer: 0, params: { fix: true } },
    { rounds: 12 },
    {
      probe: 'fixed', run: async (ctx) => {
        const all = await holdsOf(ctx, 0);
        for (const id of [ids!.portability, ids!.pin]) assert.ok(isTerminal(all.find((r) => r.id === id)!), `${id} ended`);
        const lt = await liveTree(ctx);
        assert.ok(lt.files.has('np/fixed-1.txt') && lt.files.has('np/ok-p0-1.txt'), 'both publish after the fix');
        oneCommit = (await ctx.git.run(['log', '--format=%H', '--first-parent', lt.commit, '--', 'np/fixed-1.txt', 'np/ok-p0-1.txt'], { class: 'local', cwd: ctx.remote.dir })).stdout.toString('utf8').trim().split('\n');
        checked = true;
      },
    },
  ];
  // np/ok-p0-1.txt waits with its CS (the dependency PIN) until the fix
  const pinned = watch('HLD-42_PIN', () => ids === null || !fixed, async (ctx) => ((await liveFile(ctx, 'np/ok-p0-1.txt')) === null ? null : 'np/ok-p0-1.txt published before the fix'));
  okOrFail((await scriptRun('holds-np-stageable', () => steps, { oracles: [pinned] })).r);
  assert.ok(checked);
  // The brief's last clause. Task 13 found two live commits: the dependency PIN released at the tick that ended the portability record
  // and its pinned group published in the next window, while the fixed name's new human CS published after its own quiet period. Since
  // Plan 3 Task EF that tick latches R3-53's gate on the fixed name's open CS (as the unstageable case does), so both publish in one.
  await t.test('np/fixed-1.txt and np/ok-p0-1.txt publish in one live commit', () => {
    assert.equal(oneCommit.length, 1, `one live commit carries both: ${oneCommit.join(',')}`);
  });
});

test('nonportable_name on p0 with a name that is not stageable (a:b.txt on Linux and macOS, NFD on Linux and Windows) creates no record, shows PATH_NOT_PORTABLE without an id, publishes nothing of its CS (np/ok-p0-2.txt included) while the file exists, and the fix op publishes np/fixed-2.txt and np/ok-p0-2.txt in one live commit', { timeout: SIM_TIMEOUT }, async () => {
  const BAD = process.platform === 'darwin' || process.platform === 'linux' ? 'a:b.txt' : nfdName(2);
  assert.equal(stageable(BAD), false);
  let checked = false;
  let fixing = false;   // set right before the fix op: until then nothing of p0's CS may be live (R3-53)
  const steps: Step[] = [
    { rounds: 1 },
    // k counts the run's nonportable_name ops: k = 1 is p1's (a stageable name, its own records), so p0's is k = 2
    { kind: 'nonportable_name', peer: 1, params: { name: process.platform === 'win32' ? hangul304(1) : 'con.py' } },
    { kind: 'nonportable_name', peer: 0, params: { name: BAD } },     // k = 2
    { rounds: 12 },
    {
      probe: 'gate', run: async (ctx) => {
        const rs = live(await holdsOf(ctx, 0));
        assert.equal(rs.filter((r) => r.paths.includes('np/ok-p0-2.txt')).length, 0, 'no record over np/ok-p0-2.txt');
        assert.equal(rs.length, 0, `p0 holds no record: ${JSON.stringify(rs.map((r) => [r.guards.map((g) => g.name), r.paths]))}`);
        const lines = (await logCodes(ctx, 0)).filter((l) => l.code === 'PATH_NOT_PORTABLE');
        assert.ok(lines.length >= 1, 'PATH_NOT_PORTABLE in the log');
        for (const l of lines) assert.ok(!('id' in l.params) && !('hid' in l.params), `no id: ${JSON.stringify(l.params)}`);
        const st = await readStatus(ctx.peers[0]!.dir);
        assert.ok(st!.pending.not_converged.includes('np/ok-p0-2.txt'), 'the gated path is listed not converged');
        fixing = true;
      },
    },
    { kind: 'nonportable_name', peer: 0, params: { fix: true } },
    { rounds: 12 },
    {
      probe: 'fixed', run: async (ctx) => {
        assert.ok(fixing);
        const lt = await liveTree(ctx);
        assert.ok(lt.files.has('np/fixed-2.txt') && lt.files.has('np/ok-p0-2.txt'));
        const commits = (await ctx.git.run(['log', '--format=%H', '--first-parent', lt.commit, '--', 'np/fixed-2.txt', 'np/ok-p0-2.txt'], { class: 'local', cwd: ctx.remote.dir })).stdout.toString('utf8').trim().split('\n');
        assert.equal(commits.length, 1, `one live commit carries both: ${commits.join(',')}`);
        checked = true;
      },
    },
  ];
  const gated = watch('R3-53_GATE', () => !fixing, async (ctx) => ((await liveFile(ctx, 'np/ok-p0-2.txt')) === null ? null : 'np/ok-p0-2.txt published while the non-portable file exists'));
  okOrFail((await scriptRun('holds-np-unstageable', () => steps, { oracles: [gated] })).r);
  assert.ok(checked);
});

// ---- R3-47's non-conforming writer -----------------------------------------------------------------------------------------

test('nonconforming_push bad_name with con.py: every peer whose EngineDeps.platform is win32 (p2 on every host) writes np/team-1/ok.txt in that apply and holds np/team-1/con.py in its own INCOMING unmaterializable record (INCOMING_UNMATERIALIZABLE) listed in not_converged; other peers write both; bad_name_fix ends p2\'s record SUBSUMED and writes fixed.txt', { timeout: SIM_TIMEOUT }, async () => {
  const BAD = 'np/team-1/con.py';
  const win: number[] = [];
  let checked = false;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'bad_name', name: 'con.py' } },
    { rounds: 6 },
    {
      probe: 'apply', run: async (ctx) => {
        for (let i = 0; i < ctx.peers.length; i++) {
          const engine = engineAt(ctx, i);
          assert.ok((await disk(ctx, i, 'np/team-1/ok.txt')) !== null, `p${i} wrote ok.txt`);
          const apply = ctx.trace.ofKind('apply').find((e) => e.peer === engine.peerId && e.written.includes('np/team-1/ok.txt'));
          assert.ok(apply !== undefined, `p${i}: ok.txt in an apply`);
          if (engine.core.deps.platform === 'win32') {
            win.push(i);
            assert.ok(!apply.written.includes(BAD));
            const rs = live(await holdsOf(ctx, i)).filter((r) => r.kind === 'INCOMING' && has(r, 'unmaterializable') && r.paths.includes(BAD));
            assert.equal(rs.length, 1, `p${i}: one INCOMING unmaterializable record`);
            const ins = await engine.inspect();
            assert.ok(ins.notConverged.includes(BAD), `p${i}: ${BAD} not converged`);
            const st = await readStatus(ctx.peers[i]!.dir);
            assert.ok(st?.message_code === 'INCOMING_UNMATERIALIZABLE' || (await logCodes(ctx, i)).some((l) => l.code === 'INCOMING_UNMATERIALIZABLE'), `p${i}: INCOMING_UNMATERIALIZABLE`);
          } else {
            assert.ok((await disk(ctx, i, BAD)) !== null, `p${i} wrote both`);
          }
        }
        assert.ok(win.includes(2), 'p2 is a win32 receiver on every host');
      },
    },
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'bad_name_fix' } },
    { rounds: 6 },
    {
      probe: 'fix', run: async (ctx) => {
        for (const i of win) {
          const rs = (await holdsOf(ctx, i)).filter((r) => r.kind === 'INCOMING' && has(r, 'unmaterializable') && r.paths.includes(BAD));
          assert.deepEqual(rs.map((r) => r.state), ['SUBSUMED'], `p${i}: the record ended SUBSUMED`);
          assert.ok((await disk(ctx, i, 'np/team-1/fixed.txt')) !== null, `p${i} wrote fixed.txt`);
        }
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-team-badname', () => steps)).r);
  assert.ok(checked);
});

test('nonconforming_push form_flip: each peer defers form/flip.txt with reason eol_form at once, holds one INCOMING eol-form record from 60 virtual s (not before), and form_fix makes the next permitted apply write the LF form and end the record SUBSUMED', { timeout: SIM_TIMEOUT }, async () => {
  const PATH = 'form/flip.txt';
  /** per peer: the pending age when the INCOMING eol-form record first showed, and whether it ever showed before 60 s */
  const seen = new Map<number, { deferredAt: number | null; recordAge: number | null; early: boolean }>();
  let armed = false;
  let checked = false;
  const tracker: Oracle = {
    name: 'EOL_FORM',
    async afterEveryOp(ctx) {
      if (!armed) return null;
      for (let i = 0; i < ctx.peers.length; i++) {
        const engine = realEngineOf(ctx.engines[i]!);
        if (engine === null) continue;
        const ins = await engine.inspect();
        const s = seen.get(i) ?? { deferredAt: null, recordAge: null, early: false };
        if (ins.pending[PATH] === 'eol_form' && s.deferredAt === null) s.deferredAt = ctx.opLog[ctx.opLog.length - 1]!.step;
        const rec = ins.holds.find((r) => r.kind === 'INCOMING' && has(r, 'eol-form') && r.paths.includes(PATH));
        const age = ins.pendingAgeMs[PATH];
        if (rec !== undefined && s.recordAge === null) {
          s.recordAge = age ?? -1;
          if (age !== undefined && age < 60_000) s.early = true;
        }
        seen.set(i, s);
      }
      return null;
    },
  };
  const steps: Step[] = [
    { rounds: 1 },
    { probe: 'arm', run: async () => { armed = true; } },
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'form_flip' } },
    ...Array.from({ length: 24 }, (): Step => ({ rounds: 1 })),
    {
      probe: 'deferred', run: async (ctx) => {
        for (let i = 0; i < ctx.peers.length; i++) {
          const s = seen.get(i)!;
          assert.ok(s.deferredAt !== null, `p${i} deferred ${PATH} with eol_form`);
          assert.ok(s.deferredAt <= 4, `p${i} deferred it at once (step ${s.deferredAt})`);
          assert.ok(s.recordAge !== null && s.recordAge >= 60_000 && !s.early, `p${i}: the INCOMING eol-form record from 60 s (age ${s.recordAge})`);
          assert.equal(live(await holdsOf(ctx, i)).filter((r) => r.kind === 'INCOMING' && has(r, 'eol-form')).length, 1, `p${i}: one record`);
          assert.deepEqual(findMarkers((await disk(ctx, i, PATH))!), [], `p${i}: the violating form was not written`);
        }
      },
    },
    { kind: 'nonconforming_push', peer: 0, params: { variant: 'form_fix' } },
    { rounds: 8 },
    {
      probe: 'fixed', run: async (ctx) => {
        const tip = (await liveFile(ctx, PATH))!;
        for (let i = 0; i < ctx.peers.length; i++) {
          const rs = (await holdsOf(ctx, i)).filter((r) => r.kind === 'INCOMING' && has(r, 'eol-form'));
          assert.deepEqual(rs.map((r) => r.state), ['SUBSUMED'], `p${i}: the record ended SUBSUMED`);
          const d = (await disk(ctx, i, PATH))!;
          assert.equal(findMarkers(d).length, 2, `p${i}: both marker rows`);
          assert.ok(!tip.includes(0x0d), 'TIP holds the LF form');
          if (!ctx.peers[i]!.opts.autocrlf) assert.deepEqual(d, tip, `p${i} wrote the LF form`);
        }
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-team-formflip', () => steps, { oracles: [tracker] })).r);
  assert.ok(checked);
});
