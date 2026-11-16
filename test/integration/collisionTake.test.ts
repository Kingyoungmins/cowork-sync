// The collision take (Plan 3 Task 5; 03-data DAT-29 operator, 05-holds Table 4 `--publish` on INCOMING `collision`; D-24, D-26;
// Review Focus 2; ruling R3-67): the local file is captured first (route (b) -w of a staged copy, a guard-less OFF_DISK PARKED
// PATCH with h0 ABSENT, local_only by HLD-03) and only then is the team version written through writeLocal; a take that does not
// write ends its capture GONE and keeps the collision record. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { collisionTake } from '../../src/engine/holdOps.js';
import { ABSENT } from '../../src/git/oid.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { readWork, workPath, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, pair, prepIt, withPeers } from '../helpers/holdOpsFixture.js';
import { T9 } from '../helpers/maskFixture.js';
import { buf } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const ENV = '.env';
const FILES: Record<string, Buffer> = { 'README.md': buf('# take\n'), '.gitignore': buf('.env\n'), 'src/t9.txt': buf(T9) };
const L = 'SECRET=local\n';
const T = 'SECRET=team\n';

/** An ignored local .env, the teammate's .env on TIP, and the INCOMING collision record over it (Task 6 creates it in the loop). */
async function collision(fx: Parameters<Parameters<typeof withPeers>[2]>[0], p: PeerFixture): Promise<{ c: string; tipBlob: string }> {
  await writeWork(p, ENV, L);
  await fx.pushTeamChange({ [ENV]: buf(T) });
  const it = await prepIt(p, { forceFetch: true });
  const tipBlob = it.tipMap.get(ENV)!.oid;
  const c = await p.core.holds.hold(nr({ kind: 'INCOMING', paths: [ENV], guard: 'collision', origin: 'daemon', blobs: pair(ABSENT, tipBlob, ENV) }));
  return { c, tipBlob };
}

const captures = (p: PeerFixture, c: string): HoldRecord[] => p.core.holds.all().filter((h) => h.id !== c && h.paths.includes(ENV));

test('collisionTake captures the local file before writing the team version', T10, async () => {
  await withPeers('take-ok', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const { c } = await collision(fx, p);
    const cBefore = p.core.holds.get(c)!;
    const it = await prepIt(p, { materialize: true });
    let atWrite: HoldRecord[] | null = null;
    p.fs.interpose('writeFileExclusive', '.new', async () => {
      atWrite = captures(p, c);
    });
    assert.equal(await collisionTake(p.core, it, c), 'WRITTEN');
    assert.ok(atWrite !== null && (atWrite as HoldRecord[]).length === 1, 'the capture was committed before the writer touched anything');
    const [k] = captures(p, c);
    assert.ok(k !== undefined && 'h1' in k.blobs);
    assert.deepEqual([k.kind, k.residence, k.state, k.guards.length, k.local_only, k.origin, k.displaced_by], ['PATCH', 'OFF_DISK', 'PARKED', 0, true, 'human', null]);
    assert.equal(k.blobs.h0[ENV], ABSENT);
    assert.equal(k.blobs.h1[ENV], await blob(p, L), "h1 = L's clean blob");
    assert.deepEqual(await readWork(p, ENV), buf(T), 'the team version is on disk');
    assert.deepEqual(p.core.holds.get(c), cBefore, 'c is unchanged (it ends at the next apply, R3-33)');
  });
});

test('a collision take whose disk changed keeps the collision record and ends the capture GONE', T10, async () => {
  for (const failure of ['HOLD_DISK_CHANGED', 'LOCKED'] as const) {
    await withPeers(`take-${failure}`, { files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const { c } = await collision(fx, p);
      const cBefore = p.core.holds.get(c)!;
      const it = await prepIt(p, { materialize: true });
      let release: (() => void) | null = null;
      // Between the capture read and the writer's pre-image check.
      p.fs.interpose('writeFileExclusive', '.new', async () => {
        if (failure === 'LOCKED') release = p.fs.holdLock(workPath(p, ENV), 'share-none');
        else await writeFile(workPath(p, ENV), 'SECRET=rewritten\n');
      });
      const out = await collisionTake(p.core, it, c);
      (release as (() => void) | null)?.();
      assert.equal(out, failure);
      const [k] = captures(p, c);
      assert.equal(k?.state, 'GONE', 'the capture ends GONE (R3-67)');
      assert.deepEqual(p.core.holds.get(c), cBefore, 'c unchanged');
      assert.deepEqual(await readWork(p, ENV), buf(failure === 'LOCKED' ? L : 'SECRET=rewritten\n'), 'the team version was not written');
    });
  }
});
