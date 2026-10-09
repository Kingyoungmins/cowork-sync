// Final review FB-6 (status visibility, loop.ts): a path a teammate's TIP holds that this clone carries by its name alone
// (P2-CARRY / P2-DOTGIT: `a:b.txt`, `docs/12:30.md` — a ':' stream — on every platform) is never written and A never
// follows it, so it is in no tick's carry set (A ∪ the private index) and never in meta.pending (not a valid meta key).
// It is listed in not_converged as not_applicable{guard: unmaterializable} while A differs from TIP there, and not once it
// leaves TIP. On Windows git also refuses a ROOT drive-prefix name (`a:b.txt`) in any index, so a publish whose OUT needs a
// whole-path edit over a TIP holding one cannot be built: that pause is visible too (every path of the ready pairs it
// would compose), never a silent build_failed. Real git, Engines over file://.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { blobText, buf, treeOf } from '../helpers/publishHelpers.js';

test('final review FB-6: a TIP-only path carried by its name (a:b.txt, docs/12:30.md) is listed in not_converged as not_applicable{guard: unmaterializable}, and not once it leaves TIP', async () => {
  await withEngines('loop-carry-tip', { n: 1, files: { 'README.md': buf('# carry tip\n'), 'docs/x.md': buf('x\n') } }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(1);
    const CARRIED = ['a:b.txt', 'docs/12:30.md'];
    await fx.pushTeamChange({ 'a:b.txt': buf('ab\n'), 'docs/12:30.md': buf('half past twelve\n'), 'docs/x.md': buf('x2\n') });
    await fx.rounds(6);
    const s = await p.engine.inspect();
    assert.equal((await p.core.repo.readTreeMap(p.core.view!.base)).get('docs/x.md')?.oid, await p.core.repo.hashBytes(buf('x2\n'), false), 'the rest applied');
    for (const c of CARRIED) {
      assert.deepEqual(s.notConvergedWhy?.[c], { cause: 'not_applicable', guard: 'unmaterializable' }, `${c} is visible`);
      assert.ok(s.notConverged.includes(c), c);
    }
    await fx.pushTeamChange({ 'a:b.txt': null, 'docs/12:30.md': null });
    await fx.rounds(6);
    const s2 = await p.engine.inspect();
    for (const c of CARRIED) assert.equal(s2.notConvergedWhy?.[c], undefined, `${c} left TIP: not listed`);
  });
});

const NOTES = '# Notes\n\nalpha\n';
const PUB_FILES: Record<string, Buffer> = { 'README.md': buf('# carry publish\n'), 'notes.md': buf(NOTES), 'y.txt': buf('y0\n') };

/** Local edits of notes.md (a same-position append the team also makes: a D9 concat) and y.txt (clean), then TIP adds a:b.txt. */
async function editsAgainstColonTip(fx: EngineFixture, p: PeerFixture): Promise<void> {
  await fx.startAll();
  await fx.rounds(1);
  await writeWork(p, 'notes.md', `${NOTES}local line\n`);
  await writeWork(p, 'y.txt', 'y local\n');
  await fx.pushTeamChange({ 'notes.md': buf(`${NOTES}team line\n`), 'a:b.txt': buf('ab\n') });
  await fx.rounds(16);   // 40 s: the quiet period, the capture and a governed window
}

/** y.txt as LA_C (this peer's last landed live code, or the team's) holds it. */
async function publishedY(p: PeerFixture): Promise<string | null> {
  return blobText(p, await treeOf(p, p.core.view!.laC), 'y.txt');
}

test('final review FB-6: on Windows a publish whose OUT git cannot build (a D9 concat over a TIP holding the root drive-prefix name a:b.txt) pauses visibly: every path of the ready pair, the clean y.txt too, is in not_converged as not_applicable{guard: unmaterializable}; once the name leaves TIP the pair publishes and the list clears', {
  skip: process.platform !== 'win32' ? 'git refuses a root drive-prefix name in an index only on Windows (the POSIX twin below)' : false,
}, async () => {
  await withEngines('loop-carry-publish', { n: 1, files: PUB_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editsAgainstColonTip(fx, p);
    assert.equal(p.core.cs.ready().some((r) => r.paths.includes('y.txt')), true, 'the change-set was captured');
    assert.equal(await publishedY(p), 'y0\n', 'nothing of it was published');
    const s = await p.engine.inspect();
    assert.deepEqual(s.notConvergedWhy?.['y.txt'], { cause: 'not_applicable', guard: 'unmaterializable' }, `the paused y.txt is visible (not_converged: ${JSON.stringify(s.notConvergedWhy)})`);
    assert.ok(s.notConverged.includes('y.txt'));
    assert.deepEqual(s.notConvergedWhy?.['notes.md'], { cause: 'not_applicable', guard: 'unmaterializable' });
    // The name leaves TIP: the next windows build OUT, the pair lands and nothing is listed for it.
    await fx.pushTeamChange({ 'a:b.txt': null });
    await fx.rounds(12);
    assert.equal(await publishedY(p), 'y local\n', 'the paused pair published');
    const s2 = await p.engine.inspect();
    assert.equal(s2.notConvergedWhy?.['y.txt'], undefined);
    assert.equal(s2.notConvergedWhy?.['notes.md'], undefined);
  });
});

test('final review FB-6 (POSIX twin): where git indexes a root drive-prefix name the same publish builds OUT over the TIP holding a:b.txt and lands: y.txt is never listed', {
  skip: process.platform === 'win32' ? 'git for Windows refuses a root drive-prefix name in an index (the Windows test above)' : false,
}, async () => {
  await withEngines('loop-carry-publish-posix', { n: 1, files: PUB_FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editsAgainstColonTip(fx, p);
    assert.equal(await publishedY(p), 'y local\n', 'the pair published with TIP\'s a:b.txt in OUT');
    assert.equal((await treeOf(p, p.core.view!.laC)).has('a:b.txt'), true);
    const s = await p.engine.inspect();
    assert.equal(s.notConvergedWhy?.['y.txt'], undefined);
    assert.deepEqual(s.notConvergedWhy?.['a:b.txt'], { cause: 'not_applicable', guard: 'unmaterializable' }, 'the carried name itself stays listed');
  });
});
