// Not-applicable incoming paths (Plan 3 Task 6; 05-holds HLD-53, HLD-54, I14; 03-data DAT-29, DAT-33 receive side; 01-engine
// TC-ENG-15; glossary §21 INV-GROUP; rulings R3-31, Flags item 8): a path this OS cannot create (D7 rules 2 and 4 on a win32 peer,
// emulated on every OS through EngineDeps.platform) or that collides with a local ignored file is never written, gets its own
// INCOMING record at once and never defers the rest of its change-set; the record is released when TIP no longer contains the path
// or it becomes materialisable and applies. A path that fails SEC-35 syntax (`a:b.txt`) is no record's path: it stays carried by
// scope class. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWork, writeWork } from '../helpers/coreFixture.js';
import { incomingRecords, loop, withGuard } from '../helpers/incomingFixture.js';
import { buf, withCores } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

test('05 I14: unmaterialisable and colliding paths of a CS do not defer the rest', T10, async () => {
  const files = { 'README.md': buf('# i14\n'), '.gitignore': buf('.env\n'), 'src/a.txt': buf('a\n') };
  await withCores('rport-i14', { n: 1, files, platform: 'win32' }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, '.env', 'SECRET=local\n');   // a local ignored file
    await fx.pushTeamChange({ 'con.py': buf('print(1)\n'), '.env': buf('SECRET=team\n'), 'src/x.txt': buf('x\n') });   // one CS
    fx.advance(10_000);
    const l = await loop(p);
    assert.deepEqual(l.apply.written, ['src/x.txt'], 'src/x.txt applies in the same loop');
    assert.deepEqual([...l.apply.notApplicable].sort(), [['.env', 'collision'], ['con.py', 'unmaterializable']]);
    assert.deepEqual(l.apply.closures, [], 'nothing of the CS is deferred');
    const recs = incomingRecords(p);
    assert.deepEqual(recs.map((r) => [r.paths, r.guards.map((g) => g.name)]).sort(), [[['.env'], ['collision']], [['con.py'], ['unmaterializable']]], 'one INCOMING record each');
    const tr = fx.trace.ofKind('apply').at(-1)!;
    assert.deepEqual(tr.notApplicable, [{ path: '.env', reason: 'collision' }, { path: 'con.py', reason: 'unmaterializable' }]);
    assert.deepEqual(tr.groups, [{ paths: ['src/x.txt'], outcome: 'written', reason: null }]);
    assert.ok(tr.mDisk !== null);
    assert.equal((await readWork(p, '.env'))?.toString(), 'SECRET=local\n');
  });
});

test('TC-ENG-15: each non-portable path gets its own INCOMING record and later applies continue', T10, async () => {
  const files = { 'docs.md': buf('# tc-eng-15\n'), 'src/a.txt': buf('a1\na2\n') };
  await withCores('rport-tceng15', { n: 1, files, platform: 'win32' }, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({
      'con.py': buf('c\n'), 'a:b.txt': buf('ab\n'), 'trail.': buf('t\n'), 'README.md': buf('# upper\n'), 'readme.md': buf('# lower\n'),
      'src/a.txt': buf('a1\na2 team\n'),
    });
    fx.advance(10_000);
    const l = await loop(p);
    assert.deepEqual(l.apply.written, ['README.md', 'src/a.txt'], 'the valid edit applies, and the earlier spelling of the case pair');
    for (const x of ['con.py', 'a:b.txt', 'trail.', 'readme.md']) assert.equal(l.apply.notApplicable.get(x), 'unmaterializable', x);
    assert.deepEqual([...l.apply.notApplicableRules].sort(), [['a:b.txt', 2], ['con.py', 2], ['readme.md', 4], ['trail.', 2]]);
    const recs = incomingRecords(p);
    assert.deepEqual(recs.map((r) => r.paths[0]).sort(), ['con.py', 'readme.md', 'trail.'], 'one record each; a:b.txt (fails SEC-35 syntax) gets none');
    for (const r of recs) assert.deepEqual([r.paths.length, r.guards.map((g) => g.name), r.state], [1, ['unmaterializable'], 'ACTIVE']);
    const told = l.codes.filter((c) => c.code === 'INCOMING_UNMATERIALIZABLE').map((c) => [c.params['path'], c.params['rule']]).sort();
    assert.deepEqual(told, [['con.py', 2], ['readme.md', 4], ['trail.', 2]], 'each record names its D7 rule');
    for (const c of l.codes.filter((x) => x.code === 'INCOMING_UNMATERIALIZABLE')) {
      assert.equal(c.params['id'], recs.find((r) => r.paths[0] === c.params['path'])!.id);
    }
    // Later applies continue.
    await fx.pushTeamChange({ 'src/a.txt': buf('a1 again\na2 team\n') });
    fx.advance(10_000);
    const later = await loop(p);
    assert.deepEqual(later.apply.written, ['src/a.txt']);
    assert.equal((await readWork(p, 'src/a.txt'))?.toString(), 'a1 again\na2 team\n');
    assert.deepEqual(incomingRecords(p).map((r) => r.paths[0]).sort(), ['con.py', 'readme.md', 'trail.'], 'no new record');
  });
});

test('a not-applicable record is released when TIP no longer contains p or p becomes materialisable', T10, async () => {
  const files = { 'docs.md': buf('# release\n'), 'readme.md': buf('# lower\n') };
  await withCores('rport-release', { n: 1, files, platform: 'win32' }, async (fx) => {
    const p = fx.peers[0]!;
    // con.py (D7 rule 2) and README.md (rule 4: readme.md is on this disk) arrive.
    await fx.pushTeamChange({ 'con.py': buf('c\n') });
    await fx.pushTeamChange({ 'README.md': buf('# upper\n') });
    fx.advance(10_000);
    const l = await loop(p);
    assert.deepEqual(l.apply.written, []);
    const con = withGuard(p, 'unmaterializable').find((r) => r.paths[0] === 'con.py')!;
    const upper = withGuard(p, 'unmaterializable').find((r) => r.paths[0] === 'README.md')!;
    assert.equal(l.apply.notApplicableRules.get('README.md'), 4);
    // TIP deletes con.py: SUBSUMED.
    await fx.pushTeamChange({ 'con.py': null });
    fx.advance(10_000);
    const gone = await loop(p);
    assert.equal(p.core.holds.get(con.id)!.state, 'SUBSUMED', 'TIP no longer contains con.py');
    assert.ok(gone.released.includes(con.id));
    assert.equal(p.core.holds.get(upper.id)!.state, 'ACTIVE');
    // The case pair loses readme.md: README.md becomes materialisable and applies; its record ends SUBSUMED. (On a case-insensitive
    // disk the old spelling's file is removed by that same apply, so README.md may meet it as a collision for one loop first.)
    await fx.pushTeamChange({ 'readme.md': null });
    for (let i = 0; i < 4 && p.core.holds.get(upper.id)!.state !== 'SUBSUMED'; i++) {
      fx.advance(10_000);
      await loop(p);
    }
    assert.equal((await readWork(p, 'README.md'))?.toString(), '# upper\n', 'README.md applies');
    assert.equal(p.core.holds.get(upper.id)!.state, 'SUBSUMED', 'its record ends SUBSUMED');
    assert.deepEqual(incomingRecords(p), []);
  });
});
