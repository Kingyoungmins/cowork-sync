// test/integration/claude.txn.resolve.test.ts — the LAST COMMIT of F2 t8b-engine (F2 #108, ruling R-T8B-6): /cowork resolve
// during an open Bash|PowerShell|Monitor TXN is refused {kind:'locked', paths:[], reason:'txn'} ("a Claude shell command is
// running"), not LOCKED ['.git/index.lock']; the verb writes nothing; the CLI line says to wait for the Claude shell command;
// after the close the verb goes through. Verbs that write nothing (--park of an already-PARKED record, --handoff's refusal)
// still answer during the TXN, exactly as with the 0b gate's index.lock cell of daemon.resolve.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLine } from '../../src/daemon/run.js';
import type { ResolveResult } from '../../src/engine/resolve.js';
import { readWork, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { withEngines } from '../helpers/engineFixture.js';
import { blob, nr, pair, prepIt } from '../helpers/holdOpsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { HUMAN } from '../helpers/resolveFixture.js';
import { daemonRig, txnOf } from '../helpers/claudeRig.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };
const done = (code: string, id: string, created: string | null = null): ResolveResult => ({ kind: 'done', code, id, created });
const FILES: Record<string, Buffer> = { ...Object.fromEntries(['a', 'b'].map((x) => [`src/${x}.txt`, buf(T9)])) };

/** An ON_DISK revert PATCH over `path` (disk t9{2:two,6:six}, held line 2), made on the peer's live core. */
async function revertOn(p: PeerFixture, path: string): Promise<string> {
  await writeWork(p, path, t9([2, 'two'], [6, 'six']));
  const it = await prepIt(p, { materialize: false });
  return p.core.holds.hold(nr({ paths: [path], guard: 'revert', origin: 'human', blobs: pair(it.A.get(path)!.oid, await blob(p, t9([2, 'two'])), path) }));
}

/** An OFF_DISK PARKED record over `path` (--park writes nothing). */
async function parkedOn(p: PeerFixture, path: string): Promise<string> {
  const it = await prepIt(p, { materialize: false });
  return p.core.holds.hold(nr({ paths: [path], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(it.A.get(path)!.oid, await blob(p, t9([2, 'two'])), path) }));
}

/** The registry head, the record, the disk of `path` and the outbox: what a gated verb must leave as it was. */
async function untouched(p: PeerFixture, id: string, path: string): Promise<unknown> {
  return { head: p.core.holds.head(), rec: p.core.holds.get(id), disk: (await readWork(p, path))?.toString('utf8'), outbox: JSON.stringify(p.core.outbox.toJson()) };
}

test('resolve during an open TXN refuses as the TXN (locked, reason txn), writes nothing, and goes through after the close (F2 #108)', T10, async () => {
  const rig = daemonRig();
  await withEngines('dres-txn', { n: 1, files: FILES, engineDeps: () => ({ claude: rig.defer }) }, async (fx) => {
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const id = await revertOn(p, 'src/a.txt');
    const off = await parkedOn(p, 'src/b.txt');
    rig.leases.openTxn(txnOf('tx1'));
    const before = await untouched(p, id, 'src/a.txt');
    const res = await p.engine.resolve(id, 'park', HUMAN);
    assert.deepEqual(res, { kind: 'locked', paths: [], reason: 'txn' });
    assert.deepEqual(await untouched(p, id, 'src/a.txt'), before, 'nothing written: registry, record, disk, outbox');
    // Verbs that write nothing answer during the TXN, exactly as with the 0b gate (daemon.resolve.test.ts:152-153).
    assert.deepEqual(await p.engine.resolve(off, 'park', HUMAN), done('HOLD_PARKED', off));
    assert.deepEqual(await p.engine.resolve(id, 'handoff', HUMAN), { kind: 'refused', code: 'HOLD_NOT_OFFERABLE', params: { hid: id } });
    // The CLI line names the Claude shell command to wait for, not the git command.
    const { line } = resolveLine(res, id, 'cowork resolve <id> --park');
    assert.ok(line.includes('Claude shell command'), line);
    assert.ok(!line.includes('git command'), line);
    // After the close the verb goes through.
    rig.leases.release('tx1', 'post');
    fx.advance(2_500);
    assert.deepEqual(await p.engine.resolve(id, 'park', HUMAN), done('HOLD_PARKED', id));
    assert.equal((await readWork(p, 'src/a.txt'))?.toString('utf8'), t9([6, 'six']));
  });
});
