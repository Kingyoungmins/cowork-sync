// 05 F7, registry part (Plan 3 Task 1; HLD-01, A4): a kill at either registry.cas call site of a commitMany leaves the old or
// the new registry, never a partial record set and never a duplicated id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import type { Oid } from '../../src/git/oid.js';
import type { TreeEntry } from '../../src/git/repo.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { HoldRegistry, type NewRecord, type RegistryDeps } from '../../src/holds/registry.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { nullLog } from '../../src/ports/log.js';
import { seededRandom } from '../../src/ports/random.js';
import { noTrace } from '../../src/ports/trace.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';
import { VirtualClock } from '../sim/vclock.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const PEER = '0123456789abcdef0123456789abcdef';

/** id, rev, residence and state of every record, in id order. */
const shape = (rs: readonly HoldRecord[]): string[] => rs.map((r) => `${r.id} ${r.rev} ${String(r.residence)} ${r.state}`);

test('crashpoint registry.cas around a commitMany leaves the old or the new registry', T10, async () => {
  const f = await makeRepoFixture('registry-crash');
  try {
    const ref = refNames('main', RELEASE_NAMESPACE).holds;
    const clock = new VirtualClock();
    const rebase = new RebaseCache(f.repo, () => true);
    const deps = (seed: string): RegistryDeps => ({
      repo: f.repo, ref, random: seededRandom(seed), clock, peer: PEER, trace: noTrace, log: nullLog,
      scopeOf: () => () => 'LIVE', A: () => new Map<string, TreeEntry>(), rebase,
    });
    const blob = (s: string): Promise<Oid> => f.repo.hashBytes(Buffer.from(s, 'utf8'), true);
    const rec = async (path: string, tag: string, o: Partial<NewRecord> = {}): Promise<NewRecord> => ({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [path], blobs: { h0: { [path]: await blob(`${tag} 0\n`) }, h1: { [path]: await blob(`${tag} 1\n`) } },
      guard: 'revert', origin: 'human', cs_ids: [], displaced_by: null, ...o,
    });

    for (const killAt of [1, 2] as const) {
      const prefix = `k${killAt}`;
      const reg = new HoldRegistry(deps(`${prefix}-main`));
      await reg.load();
      const a = await reg.hold(await rec(`${prefix}/a.txt`, `${prefix}a`));
      const b = await reg.hold(await rec(`${prefix}/b.txt`, `${prefix}b`));
      const oldShape = shape((await fresh()).all());
      const creates = [await rec(`${prefix}/c.txt`, `${prefix}c`), await rec(`${prefix}/d.txt`, `${prefix}d`, { residence: 'OFF_DISK', state: 'PARKED', guard: null })];
      const patches = [{ id: a, patch: { residence: 'OFF_DISK' as const, state: 'PARKED' as const } }, { id: b, patch: { state: 'CONFLICTED' as const } }];
      const hits: string[] = [];
      setCrashHandler((name) => {
        hits.push(name);
        if (hits.length === killAt) throw new KilledAt(name);
      });
      await assert.rejects(reg.commitMany(creates, patches), KilledAt);
      setCrashHandler(null);
      assert.deepEqual(hits, killAt === 1 ? ['registry.cas'] : ['registry.cas', 'registry.cas']);
      const after = (await fresh()).all();
      const ids = after.map((r) => r.id);
      assert.equal(new Set(ids).size, ids.length, 'never a duplicated id');
      if (killAt === 1) {
        assert.deepEqual(shape(after), oldShape, 'killed before the CAS: the old registry');
      } else {
        assert.equal(after.length, oldShape.length + 2, 'killed after the CAS: the new registry, both creations');
        const byId = new Map(after.map((r) => [r.id, r] as const));
        assert.deepEqual([byId.get(a)!.residence, byId.get(a)!.state], ['OFF_DISK', 'PARKED']);
        assert.equal(byId.get(b)!.state, 'CONFLICTED');
        assert.equal(after.filter((r) => r.paths[0]!.startsWith(`${prefix}/`)).length, 4);
      }
    }

    async function fresh(): Promise<HoldRegistry> {
      const r = new HoldRegistry(deps(`fresh-${clock.monoMs()}`));
      await r.load();
      return r;
    }
  } finally {
    setCrashHandler(null);
    await f.cleanup();
  }
});
