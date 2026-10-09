// Final review fix group FA, end to end: board content that a writer-access teammate or a foreign tool can push and that
// git (fsck included) accepts, read by real EngineCores over a file:// remote (withCores + forceRemote + poll). Before
// the fixes each scenario crashed every peer's iteration (the daemon's respawn loop ends in exit 2 on every peer, with
// no INCIDENT and nothing for /cowork recover to act on) or raised a false incident. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_SUBJECT, boardTrailers } from '../../src/board/boardCommit.js';
import type { Oid } from '../../src/git/oid.js';
import type { MktreeEntry } from '../../src/git/repo.js';
import type { PeerFixture } from '../helpers/coreFixture.js';
import { boardOn, catchUp, forceRemote, inIncident, liveOf, poll, testWriter } from '../helpers/incidentFixture.js';
import { buf, editAndCapture, withCores } from '../helpers/publishHelpers.js';

const FILES: Record<string, Buffer> = {
  'README.md': buf('# hostile board fixture\n'),
  'x.txt': buf('x v0\n'),
  'y.txt': buf('y v0\n'),
};

/** Past the governor window after a fetch moved its anchor (G_eff = 5 s at budget 12; 10 s before any fold of the run). */
const PAST_WINDOW_MS = 11_000;

/** A copy of commit `c` with its header lines rewritten, written as is (`hash-object -t commit -w --literally`). */
async function rewriteHeader(p: PeerFixture, c: Oid, edit: (header: string[]) => string[]): Promise<Oid> {
  const raw = (await p.core.repo.run(['cat-file', 'commit', c])).stdout.toString('utf8');
  const split = raw.indexOf('\n\n');
  const header = edit(raw.slice(0, split).split('\n')).join('\n');
  const r = await p.core.repo.run(['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { stdin: Buffer.from(`${header}\n\n${raw.slice(split + 2)}`, 'utf8') });
  return r.stdout.toString('utf8').trim() as Oid;
}

/** git's own reading of a commit's tree and parents. */
async function gitHeader(p: PeerFixture, c: Oid): Promise<string> {
  return (await p.core.repo.run(['log', '-1', '--format=%T %P', c])).stdout.toString('utf8').trim();
}

test('FA-1: board commits whose headers carry upper-case hex, a parent after the committer line or a tree after it fold on every peer like the honest commit git reads: no crash, no incident', async () => {
  await withCores('hostile-header', { n: 2, files: FILES }, async (fx) => {
    const p1 = fx.peers[0]!;
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    for (const p of fx.peers) await catchUp(fx, p);
    const live = await liveOf(p1, B1);
    const L0 = await liveOf(p1, (await p1.core.repo.readCommit(B1)).parents[0]!);
    const missing = '0123456789abcdef'.repeat(4).slice(0, B1.length);
    const variants: Array<[string, (h: string[]) => string[]]> = [
      ['upper-case hex in the tree and parent lines', (h) => h.map((l) => (/^(tree|parent) /.test(l) ? l.replace(/[0-9a-f]+$/, (x) => x.toUpperCase()) : l))],
      // An existing commit as a late parent: read as the last parent it would be a live code commit that jumps (a false code_not_ff).
      ['a parent header naming an existing commit after the committer line', (h) => [...h, `parent ${L0}`]],
      // A missing object as a late parent: rev-list on it dies with `bad object` (a GitCommandError crash).
      ['a parent header naming a missing object after the committer line', (h) => [...h, `parent ${missing}`]],
      // A missing tree as the last tree line: every board entry would read as absent.
      ['a tree header naming a missing object after the committer line', (h) => [...h, `tree ${missing}`]],
    ];
    let prev = B1;
    for (const [what, edit] of variants) {
      const honest = await boardOn(p1, prev, live);
      const hostile = await rewriteHeader(p1, honest, edit);
      assert.notEqual(hostile, honest);
      assert.equal(await gitHeader(p1, hostile), await gitHeader(p1, honest), `${what}: git reads the honest tree and parents`);
      await forceRemote(fx, p1, p1.core.refs.remoteBoard, hostile);
      for (const p of fx.peers) {
        // One iteration with a fresh fetch: it must not throw and must raise no incident (a board-only commit leaves
        // LA_B where it is, ENG-36, so only the fetched tip and the verdict are compared).
        fx.advance(10_000);
        const r = await poll(p);
        assert.equal(r.incident, false, `${what}: ${p.name} raised ${r.why ?? ''}`);
        assert.equal(r.it?.T, hostile, `${what}: ${p.name} folded the hostile tip`);
        // Read from git's (first) tree: protocol.json proto 1, so no VERSION pause either.
        assert.deepEqual(r.it?.version, { proto: false, regionSpec: false, checkpointMismatch: false }, `${what}: ${p.name}`);
        assert.ok(!inIncident(p), `${what}: ${p.name}`);
      }
      prev = hostile;
    }
  });
});

test('FA-2: a board commit whose tree has no checkpoint/ raises INCIDENT(board_shape) on every peer, also on a peer with local work to publish, and no iteration throws', async () => {
  await withCores('hostile-nocheckpoint', { n: 2, files: FILES }, async (fx) => {
    const [p1, p2] = [fx.peers[0]!, fx.peers[1]!];
    const { board: B1 } = await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    for (const p of fx.peers) await catchUp(fx, p);
    // p2 has a ready pair to publish: before the fix its next publish on T crashed in buildBoardCommit.
    await editAndCapture(fx, p2, { 'y.txt': 'y local\n' });
    const repo = p1.core.repo;
    const top = (await repo.run(['ls-tree', '-z', B1])).stdout.toString('utf8').split('\0').filter((r) => r.length > 0);
    const entries: MktreeEntry[] = top.map((rec) => {
      const tab = rec.indexOf('\t');
      const [mode, type, oid] = rec.slice(0, tab).split(' ');
      return { name: rec.slice(tab + 1), mode: mode as MktreeEntry['mode'], type: type as MktreeEntry['type'], oid: oid as Oid };
    }).filter((e) => e.name !== 'checkpoint');
    assert.deepEqual(entries.map((e) => e.name).sort(), ['ops.jsonl', 'protocol.json']);
    const T = await repo.commitTree({ tree: await repo.mktree(entries), parents: [B1, await liveOf(p1, B1)], subject: BOARD_SUBJECT, trailers: boardTrailers(testWriter('board'), [], new Map()) });
    await forceRemote(fx, p1, p1.core.refs.remoteBoard, T);
    // p2 first: the peer with local work is the one whose publish crashed before the fix.
    for (const p of [p2, p1]) {
      let polls = 0;
      while (!inIncident(p) && polls < 3) {
        polls += 1;
        const r = await poll(p);
        if (r.incident) assert.equal(r.why, 'board_shape', p.name);
        fx.advance(PAST_WINDOW_MS);
      }
      assert.ok(inIncident(p), `${p.name} is in INCIDENT`);
      assert.deepEqual(p.core.view!.meta.incident?.observed_board, T, p.name);
    }
  });
});
