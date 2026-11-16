// The widened hold registry (Plan 3 Task 1; 05-holds HLD-01…HLD-07, HLD-09, §2 age anchor; rulings R3-09…R3-14), on real
// clones. Notation (Task 1 notes): T9 is "1\n…9\n" at src/t9.txt; T9{2:two} replaces line 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { canonicalBytes, type Json } from '../../src/board/canonicalJson.js';
import { HUGE_BYTES, type ScopeClass } from '../../src/data/scope.js';
import { ensureAttrs, pathIsFiltered, prepareIteration } from '../../src/engine/core.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import type { MktreeEntry, TreeEntry, TreeMap } from '../../src/git/repo.js';
import { DECLINES_TO_HUMAN, offerNext, type OfferEvent } from '../../src/holds/offers.js';
import { HoldOperatorError, RebaseCache } from '../../src/holds/rebase.js';
import {
  GUARD_TABLE, guardName, makeGuard, parseRecord, serializeRecord, type BlobMap, type Guard, type HoldBlobs, type HoldKind, type HoldRecord,
} from '../../src/holds/record.js';
import { HoldRegistry, RegistryCasLostError, type HoldPatch, type InflightOp, type NewRecord, type RegistryDeps } from '../../src/holds/registry.js';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import { restart } from '../../src/engine/restart.js';
import type { Clock } from '../../src/ports/clock.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import type { Log, LogLevel, LogParam } from '../../src/ports/log.js';
import { seededRandom, ulid } from '../../src/ports/random.js';
import type { Trace, TraceEvent } from '../../src/ports/trace.js';
import { validId } from '../../src/sec/validators.js';
import { makeCores, writeWork } from '../helpers/coreFixture.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { gitIn, restartCore } from '../helpers/startFixture.js';
import { SIM_WALL_EPOCH_MS, VirtualClock } from '../sim/vclock.js';

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const PEER = '0123456789abcdef0123456789abcdef';
const P2 = 'fedcba9876543210fedcba9876543210';
const EPOCH = '00112233445566778899aabbccddeeff';
const P = 'src/t9.txt';
const T9 = '1\n2\n3\n4\n5\n6\n7\n8\n9\n';
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const GLOSSARY_9_KEYS = [
  'age_anchor', 'blobs', 'cs_ids', 'declines', 'displaced_by', 'guards', 'id', 'kind', 'local_only', 'offer', 'origin', 'owner', 'paths',
  'peer_authors', 'proto', 'residence', 'rev', 'state',
];

function t9(...edits: Array<[number, string]>): string {
  const rows = T9.split('\n').slice(0, 9);
  for (const [n, s] of edits) rows[n - 1] = s;
  return `${rows.join('\n')}\n`;
}

interface Ctx {
  f: RepoFixture; ref: string; clock: VirtualClock; events: TraceEvent[];
  logs: Array<{ level: LogLevel; code: string; params: Readonly<Record<string, LogParam>> }>;
  scope: Map<string, ScopeClass>; A: Map<string, TreeEntry>; rebase: RebaseCache;
  deps(seed?: string, clock?: Clock): RegistryDeps;
  reg(seed?: string, clock?: Clock): Promise<HoldRegistry>;
  blob(s: string | Buffer): Promise<Oid>;
  head(): Promise<Oid | null>;
  holdEvents(): Array<Extract<TraceEvent, { kind: 'hold' }>>;
}

async function withRegistry(label: string, fn: (c: Ctx) => Promise<void>): Promise<void> {
  const f = await makeRepoFixture(label);
  try {
    const ref = refNames('main', RELEASE_NAMESPACE).holds;
    const clock = new VirtualClock();
    const events: TraceEvent[] = [];
    const logs: Ctx['logs'] = [];
    const trace: Trace = { emit: (ev) => events.push(ev) };
    const log: Log = { write: (level, code, params) => logs.push({ level, code, params: params ?? {} }) };
    const scope = new Map<string, ScopeClass>();
    const A = new Map<string, TreeEntry>();
    const rebase = new RebaseCache(f.repo, () => true);
    const deps = (seed = 'registry', c: Clock = clock): RegistryDeps => ({
      repo: f.repo, ref, random: seededRandom(seed), clock: c, peer: PEER, trace, log,
      scopeOf: () => (p) => scope.get(p) ?? 'LIVE', A: () => A, rebase,
    });
    await fn({
      f, ref, clock, events, logs, scope, A, rebase, deps,
      reg: async (seed, c) => {
        const r = new HoldRegistry(deps(seed, c));
        await r.load();
        return r;
      },
      blob: (s) => f.repo.hashBytes(typeof s === 'string' ? Buffer.from(s, 'utf8') : s, true),
      head: () => f.repo.readRef(ref),
      holdEvents: () => events.filter((e): e is Extract<TraceEvent, { kind: 'hold' }> => e.kind === 'hold'),
    });
  } finally {
    setCrashHandler(null);
    await f.cleanup();
  }
}

/** A NewRecord: an ON_DISK ACTIVE `revert` PATCH over P unless overridden. */
function nr(o: Partial<NewRecord> & { blobs: HoldBlobs }): NewRecord {
  return { kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [P], guard: 'revert', origin: 'human', cs_ids: [], displaced_by: null, ...o };
}

const pair = (h0: OidOrAbsent, h1: OidOrAbsent, path = P): HoldBlobs => ({ h0: { [path]: h0 }, h1: { [path]: h1 } });
const names = (r: HoldRecord | undefined): string[] => (r?.guards ?? []).map((g) => g.name);

async function commitCount(c: Ctx): Promise<number> {
  const h = await c.head();
  return h === null ? 0 : (await c.f.repo.firstParents(h, null, 10_000)).length;
}

/** Writes a registry commit holding `records` (and the blobs they name) on top of the current head, then the caller loads. */
async function plant(c: Ctx, records: readonly HoldRecord[]): Promise<void> {
  const repo = c.f.repo;
  const head = await c.head();
  const existing = new Map<string, Oid>();
  if (head !== null) {
    for (const [path, e] of await repo.readTreeMap((await repo.readCommit(head)).tree)) if (path.startsWith('records/')) existing.set(path.slice(8, -5), e.oid);
  }
  // One hash-object call for every planted record (route (c) bytes from files: --no-filters).
  const dir = join(c.f.root, `plant-${records[0]?.id ?? 'none'}`);
  mkdirSync(dir, { recursive: true });
  const files = records.map((r) => {
    const file = join(dir, `${r.id}.json`);
    writeFileSync(file, serializeRecord(r));
    return file;
  });
  if (files.length > 0) {
    const LF = String.fromCharCode(10);
    const out = await repo.run(['hash-object', '-w', '--no-filters', '--stdin-paths'], { stdin: Buffer.from(`${files.join(LF)}${LF}`, 'utf8') });
    const oids = out.stdout.toString('utf8').split(LF).filter((l) => l.length > 0);
    assert.equal(oids.length, records.length);
    records.forEach((r, i) => existing.set(r.id, oids[i] as Oid));
  }
  const all = await repo.readBlobs([...existing.values()]);
  const named = new Set<string>();
  for (const b of all) for (const m of Object.values(parseRecord(b).blobs) as BlobMap[]) for (const o of Object.values(m)) if (o !== ABSENT) named.add(o);
  const recordEntries: MktreeEntry[] = [...existing.keys()].sort().map((id) => ({ name: `${id}.json`, mode: '100644', type: 'blob', oid: existing.get(id)! }));
  const blobEntries: MktreeEntry[] = [...named].sort().map((o) => ({ name: o, mode: '100644', type: 'blob', oid: o as Oid }));
  const root = await repo.mktree([
    { name: 'blobs', mode: '040000', type: 'tree', oid: await repo.mktree(blobEntries) },
    { name: 'records', mode: '040000', type: 'tree', oid: await repo.mktree(recordEntries) },
  ]);
  const commit = await repo.commitTree({ tree: root, parents: head === null ? [] : [head], subject: 'cowork-holds', trailers: [] });
  assert.equal(await repo.casRef(c.ref, commit, head, 'cowork-holds'), true);
}

/** A planted record (as a newer daemon could have written it): guards given verbatim. */
function planted(id: string, guards: Guard[], h0: Oid, h1: Oid, path = P): HoldRecord {
  return {
    id, rev: 1, owner: PEER, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none', declines: 0, displaced_by: null,
    paths: [path], blobs: pair(h0, h1, path), guards, origin: 'human', cs_ids: [], peer_authors: [], local_only: false,
    age_anchor: { since_rev: 1, anchor_wall_ms: SIM_WALL_EPOCH_MS, mono_accum_ms: 0 }, proto: 1,
  };
}

const FROB: Guard = { name: 'frobnicate', class: 'DECISION', owner: 'XYZ' };

// ---- offers (HLD-09; the registry half) ----------------------------------------------------------------------------------

test('a record carrying wake-scope is not promoted while that guard holds', T10, async () => {
  await withRegistry('reg-wake', async (c) => {
    const reg = await c.reg();
    const id = await reg.hold(nr({ blobs: pair(await c.blob(T9), await c.blob(t9([2, 'wake']))), guard: 'wake-scope', offer: 'pending_leftover' }));
    await reg.addGuard(id, 'revert');
    const r = reg.get(id)!;
    assert.equal(r.offer, 'pending_leftover');
    for (const ev of ['promote', 'handoff', 'k6_timer'] as const) {
      assert.equal(offerNext(r, ev), null, ev);
      const head = await c.head();
      assert.equal(await reg.offerEvent(id, ev), null, ev);
      assert.equal(await c.head(), head, 'an illegal event writes nothing');
    }
    await reg.releaseGuard(id, 'wake-scope');
    assert.equal(offerNext(reg.get(id)!, 'promote'), 'offered');
    assert.equal((await reg.offerEvent(id, 'promote'))!.offer, 'offered');
  });
});

test('offerEvent writes one rev per legal event and counts declines', T10, async () => {
  await withRegistry('reg-offer', async (c) => {
    const reg = await c.reg();
    const id = await reg.hold(nr({ blobs: pair(await c.blob(T9), await c.blob(t9([2, 'offer']))) }));
    const n0 = await commitCount(c);
    const seen: Array<[string, number, number]> = [];
    for (const ev of ['born_leftover', 'promote', 'declined'] as const) {
      const r = (await reg.offerEvent(id, ev))!;
      seen.push([r.offer, r.declines, r.rev]);
    }
    assert.deepEqual(seen, [['pending_leftover', 0, 2], ['offered', 0, 3], ['returned', 1, 4]]);
    assert.equal(await commitCount(c), n0 + 3, 'three commits');
    const head = await c.head();
    assert.equal(await reg.offerEvent(id, 'accepted'), null, 'accepted is illegal on returned');
    assert.equal(await c.head(), head);
    assert.equal(reg.get(id)!.rev, 4);
    assert.equal(DECLINES_TO_HUMAN, 2);
  });
});

test('an acknowledgment and the automatic re-attempt never touch the record', T10, async () => {
  const noAck: Equals<Extract<OfferEvent, 'acknowledged' | 'acknowledgment' | 're_attempt' | 'reattempt' | 'request_status'>, never> = true;
  assert.ok(noAck);
  await withRegistry('reg-ack', async (c) => {
    const reg = await c.reg();
    const id = await reg.hold(nr({ blobs: pair(await c.blob(T9), await c.blob(t9([2, 'ack']))), offer: 'pending_leftover' }));
    await reg.offerEvent(id, 'promote');
    const before = reg.get(id)!;
    const head = await c.head();
    c.clock.advance(30 * 60_000);
    assert.equal(reg.get(id)!.rev, before.rev);
    assert.equal(reg.get(id)!.offer, 'offered');
    assert.equal(await c.head(), head);
    assert.ok(reg.ageMs(reg.get(id)!) >= 30 * 60_000, 'only the in-memory age moves');
    // Runtime half: an acknowledgment or a re-attempt reaching offerEvent anyway (an untyped caller) is not an event of the
    // record: null, no rev, no commit; and the registry has no member that would write one.
    for (const ev of ['acknowledged', 'acknowledgment', 're_attempt', 'reattempt', 'request_status'] as unknown as OfferEvent[]) {
      assert.equal(offerNext(reg.get(id)!, ev), null, String(ev));
      assert.equal(await reg.offerEvent(id, ev), null, String(ev));
    }
    assert.deepEqual(reg.get(id), before);
    assert.equal(await c.head(), head);
    for (const m of ['acknowledge', 'acknowledged', 'reattempt', 'reAttempt', 'retry']) assert.equal(m in HoldRegistry.prototype, false, m);
  });
});

// ---- births -------------------------------------------------------------------------------------------------------------

const PIN_ROWS = new Set(['t0', 'unreadable', 'unstable', 'join', 'phantom', 'host-reject']);
const INCOMING_ROWS = new Set(['lock', 'unmaterializable', 'eol-form', 'local-only-conflict', 'collision', 'quarantine-review']);

test('hold() accepts every Table 3 guard with its fixed class and owner, and the INCOMING kind', T10, async () => {
  await withRegistry('reg-births', async (c) => {
    const reg = await c.reg();
    const first = await reg.hold(nr({ paths: ['src/first.txt'], blobs: pair(await c.blob('first 0\n'), await c.blob('first 1\n'), 'src/first.txt') }));
    for (const [i, row] of GUARD_TABLE.entries()) {
      const path = `src/g${i + 1}.txt`;
      const full = row.name === 'claim' ? 'claim:abcdefghij234567' : row.name === 'dependency' ? `dependency:${first}` : row.name;
      const kind: HoldKind = PIN_ROWS.has(row.name) ? 'PIN' : INCOMING_ROWS.has(row.name) ? 'INCOMING' : 'PATCH';
      const h0 = { [path]: await c.blob(`g${i + 1} base\n`) };
      const blobs: HoldBlobs = row.name === 'filter-failure' ? { h0, h1: {} } : { h0, h1: { [path]: await c.blob(`g${i + 1} held\n`) } };
      const id = await reg.hold(nr({ kind, paths: [path], blobs, guard: full }));
      const r = reg.get(id)!;
      assert.deepEqual(r.guards, [makeGuard(full)], row.name);
      assert.equal(r.kind, kind);
      assert.equal(r.residence, 'ON_DISK');
      assert.equal(r.state, 'ACTIVE');
    }
    assert.equal(reg.all().length, 27);
    const ff = reg.all().find((r) => names(r).includes('filter-failure'))!;
    assert.deepEqual((ff.blobs as { h1: BlobMap }).h1, {});
    assert.equal(ff.local_only, true, 'filter-failure is a local_only cause');
  });
});

test('hold() refuses an unknown name, a malformed argument, a guard-less ON_DISK birth and an INCOMING record outside ON_DISK ACTIVE', T10, async () => {
  await withRegistry('reg-refuse', async (c) => {
    const reg = await c.reg();
    await reg.hold(nr({ paths: ['src/x.txt'], blobs: pair(await c.blob('x0\n'), await c.blob('x1\n'), 'src/x.txt') }));
    const head = await c.head();
    const blobs = pair(await c.blob(T9), await c.blob(t9([2, 'refuse'])));
    const bad: NewRecord[] = [
      nr({ blobs, guard: 'frobnicate' }),
      nr({ blobs, guard: 'dependency:x' }),
      nr({ blobs, guard: 'dependency' }),
      nr({ blobs, guard: null }),
      nr({ blobs, guard: null, state: 'CONFLICTED' }),
      nr({ blobs, guard: null, residence: 'OFF_DISK', state: 'CONFLICTED' }),
      nr({ blobs, kind: 'INCOMING', guard: 'lock', residence: 'OFF_DISK', state: 'PARKED' }),
      nr({ blobs, kind: 'INCOMING', guard: 'lock', state: 'CONFLICTED' }),
      nr({ blobs, residence: 'OFF_DISK', state: 'ACTIVE' }),
      nr({ blobs, residence: 'ON_DISK', state: 'PARKED' }),
    ];
    for (const n of bad) {
      await assert.rejects(reg.hold(n), TypeError, JSON.stringify({ guard: n.guard, kind: n.kind, residence: n.residence, state: n.state }));
      assert.equal(await c.head(), head);
    }
    assert.equal(reg.all().length, 1);
  });
});

test('guard-less births are exactly the OFF_DISK PARKED ones', T10, async () => {
  await withRegistry('reg-guardless', async (c) => {
    const reg = await c.reg();
    const r = await reg.hold(nr({ blobs: pair(await c.blob(T9), await c.blob(t9([2, 'markers parent']))), guard: 'markers' }));
    const parked = { residence: 'OFF_DISK' as const, state: 'PARKED' as const, guard: null };
    const companion = await reg.hold(nr({ ...parked, blobs: pair(await c.blob(T9), await c.blob(t9([2, '<<<<<<< cowork:disk']))), companionOf: r }));
    const late = await reg.hold(nr({ ...parked, origin: 'daemon', blobs: pair(await c.blob(T9), await c.blob(t9([5, 'late'])), 'src/late.txt'), paths: ['src/late.txt'] }));
    const take = await reg.hold(nr({ ...parked, origin: 'daemon', blobs: pair(ABSENT, await c.blob('ignored local\n'), 'build/out.txt'), paths: ['build/out.txt'] }));
    const copy = await reg.hold(nr({ ...parked, origin: 'human', blobs: pair(await c.blob(T9), await c.blob(t9([7, 'foreign'])), 'src/copy.txt'), paths: ['src/copy.txt'] }));
    for (const id of [companion, late, take, copy]) {
      const x = reg.get(id)!;
      assert.deepEqual(x.guards, [], id);
      assert.deepEqual([x.residence, x.state], ['OFF_DISK', 'PARKED']);
    }
    assert.deepEqual(reg.local().companions, { [companion]: r });
    assert.equal(reg.get(companion)!.local_only, true, 'a marker companion is local_only');
    assert.equal(reg.get(late)!.local_only, false);
    // A companion is never attached to anything: the same call creates a second companion, and a guarded call with the
    // companion's kind, paths and held side does not attach to it.
    const again = await reg.hold(nr({ ...parked, blobs: reg.get(companion)!.blobs, companionOf: r }));
    assert.notEqual(again, companion);
    const guarded = await reg.holdOutcome(nr({ blobs: reg.get(companion)!.blobs, guard: 'revert' }));
    assert.equal(guarded.created, true);
    assert.notEqual(guarded.id, companion);
    assert.deepEqual(reg.get(companion)!.guards, []);
    // The guard-less exact dedupe of Plan 2 (the ring late write) is kept.
    assert.equal(await reg.hold(nr({ ...parked, origin: 'daemon', blobs: reg.get(late)!.blobs, paths: ['src/late.txt'] })), late);
  });
});

test('the pathless host-reject PIN is the only empty-path record', T10, async () => {
  await withRegistry('reg-pathless', async (c) => {
    const reg = await c.reg();
    const pin: NewRecord = { kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: [], blobs: { h0: {}, h1: {} }, guard: 'host-reject', origin: 'daemon', cs_ids: [], displaced_by: null };
    const id = await reg.hold(pin);
    assert.deepEqual(reg.get(id)!.paths, []);
    assert.equal(reg.get(id)!.local_only, false);
    const head = await c.head();
    await assert.rejects(reg.hold({ ...pin, guard: 'phantom' }), TypeError);
    await assert.rejects(reg.hold({ ...pin, kind: 'PATCH' }), TypeError);
    assert.equal(await c.head(), head);
    assert.equal(await reg.hold(pin), id, 'the same pathless PIN again is the same change');
  });
});

test('records round-trip every glossary §9 field', T10, async () => {
  await withRegistry('reg-roundtrip', async (c) => {
    const reg = await c.reg();
    const dep = ulid(seededRandom('dep'), c.clock);
    const stages: HoldBlobs = { s1: { [P]: await c.blob(T9) }, s2: { [P]: await c.blob(t9([2, 'mine'])) }, s3: { [P]: await c.blob(t9([2, 'theirs'])) } };
    const id = await reg.hold(nr({
      state: 'CONFLICTED', blobs: stages, guard: `dependency:${dep}`, offer: 'offered', displaced_by: `${P2}/${EPOCH}/7`,
      peer_authors: [P2], cs_ids: [`${PEER}/human/3`, `${P2}/human/9`],
    }));
    await reg.addGuard(id, 'revert');
    const r0 = await reg.transition(id, { declines: 1 });
    assert.deepEqual(names(r0), [`dependency:${dep}`, 'revert']);
    assert.equal(r0.offer, 'offered');
    assert.equal(r0.declines, 1);
    const fresh = await c.reg('fresh');
    const back = fresh.get(id)!;
    assert.deepEqual(back, r0);
    const head = (await c.head())!;
    const stored = await c.f.repo.readBlob((await c.f.repo.resolve(`${head}:records/${id}.json`))!);
    assert.ok(serializeRecord(back).equals(stored), 'byte-identical after load()');
    assert.deepEqual(Object.keys(JSON.parse(stored.toString('utf8')) as object).sort(), GLOSSARY_9_KEYS, 'exactly the glossary §9 keys');
  });
});

test('multi-path records keep per-path blob maps keyed exactly by their paths', T10, async () => {
  await withRegistry('reg-multipath', async (c) => {
    const reg = await c.reg('multi');
    const paths = ['src/a.txt', 'src/b.txt', 'src/new.txt'];
    const h0 = { 'src/a.txt': await c.blob('a0\n'), 'src/b.txt': await c.blob('b0\n'), 'src/new.txt': ABSENT };
    const h1 = { 'src/a.txt': await c.blob('a1\n'), 'src/b.txt': await c.blob('b1\n'), 'src/new.txt': await c.blob('new1\n') };
    const want = ulid(seededRandom('multi'), new VirtualClock());
    const id = await reg.hold(nr({ kind: 'PIN', paths: [...paths].reverse(), blobs: { h0, h1 }, guard: 'join' }));
    assert.equal(id, want, 'the id is the first ULID of the seeded Random');
    assert.ok(validId('ulid', id));
    const r = reg.get(id)!;
    assert.deepEqual(r.paths, paths);
    assert.deepEqual(Object.keys((r.blobs as { h0: BlobMap }).h0).sort(), paths);
    assert.deepEqual(Object.keys((r.blobs as { h1: BlobMap }).h1).sort(), paths);
    const head = (await c.head())!;
    const blobsTree = (await c.f.repo.run(['ls-tree', '--name-only', '-z', `${head}:blobs`])).stdout.toString('utf8').split(NUL).filter((x) => x.length > 0).sort();
    assert.deepEqual(blobsTree, [h0['src/a.txt'], h0['src/b.txt'], h1['src/a.txt'], h1['src/b.txt'], h1['src/new.txt']].sort(), 'blobs/ names only the non-ABSENT oids');
  });
});

// ---- transitions --------------------------------------------------------------------------------------------------------

test('transition() follows Table 1', T10, async () => {
  await withRegistry('reg-table1', async (c) => {
    const reg = await c.reg();
    const mk = async (tag: string, o: Partial<NewRecord> = {}): Promise<string> =>
      reg.hold(nr({ paths: [`src/${tag}.txt`], blobs: pair(await c.blob(`${tag} 0\n`), await c.blob(`${tag} 1\n`), `src/${tag}.txt`), ...o }));
    const a = await mk('a');
    assert.equal((await reg.transition(a, { state: 'CONFLICTED' })).state, 'CONFLICTED');
    const b = await mk('b');
    assert.deepEqual(pick(await reg.transition(b, { residence: 'OFF_DISK', state: 'PARKED' })), ['OFF_DISK', 'PARKED']);
    assert.deepEqual(pick(await reg.transition(b, { residence: 'ON_DISK', state: 'ACTIVE' })), ['ON_DISK', 'ACTIVE']);
    assert.deepEqual(pick(await reg.transition(a, { residence: 'OFF_DISK' })), ['OFF_DISK', 'CONFLICTED']);
    for (const state of ['SUBSUMED', 'GONE', 'RESOLVED_PUBLISH', 'RESOLVED_DISCARD'] as const) {
      const x = await mk(state.toLowerCase());
      assert.deepEqual(pick(await reg.transition(x, { state })), [null, state], 'the registry sets residence null');
    }
    const p = await mk('parked', { residence: 'OFF_DISK', state: 'PARKED' });
    assert.deepEqual(pick(await reg.transition(p, { state: 'GONE' })), [null, 'GONE']);
    const inc = await mk('inc', { kind: 'INCOMING', guard: 'lock' });
    const head = await c.head();
    const refused: Array<[string, Parameters<HoldRegistry['transition']>[1]]> = [
      [b, { residence: 'OFF_DISK' }],               // OFF_DISK ACTIVE
      [b, { state: 'PARKED' }],                    // ON_DISK PARKED
      [inc, { residence: 'OFF_DISK', state: 'PARKED' }],
      [inc, { state: 'CONFLICTED' }],
      [p, { state: 'SUBSUMED' }],                  // terminal
      [p, { guards: [] }],
    ];
    for (const [id, patch] of refused) {
      await assert.rejects(reg.transition(id, patch), TypeError, JSON.stringify(patch));
      assert.equal(await c.head(), head);
    }
  });
});

const pick = (r: HoldRecord): [HoldRecord['residence'], HoldRecord['state']] => [r.residence, r.state];

test('one change, one id: an equal H1 attaches the new guard', T10, async () => {
  await withRegistry('reg-equal', async (c) => {
    const reg = await c.reg();
    const X = await c.blob(t9([2, 'X']));
    // A is the record's base, so its current H1' is its stored h1 (HLD-07 compares with H1'; final review r2 D-1).
    c.A.set(P, { path: P, mode: '100644', oid: await c.blob(T9) });
    const id = await reg.hold(nr({ blobs: pair(await c.blob(T9), X) }));
    const n0 = await commitCount(c);
    const out = await reg.holdOutcome(nr({ blobs: pair(await c.blob(t9([9, 'other base'])), X), guard: 'join' }));
    assert.deepEqual(out, { id, created: false, attachedGuard: 'join', conflictedExisting: false });
    assert.equal(reg.get(id)!.rev, 2);
    assert.deepEqual(names(reg.get(id)), ['revert', 'join']);
    assert.equal(await commitCount(c), n0 + 1);
    const again = await reg.holdOutcome(nr({ blobs: pair(await c.blob(T9), X), guard: 'join' }));
    assert.deepEqual(again, { id, created: false, attachedGuard: null, conflictedExisting: false });
    assert.equal(await commitCount(c), n0 + 1, 'no commit');
    assert.equal(await reg.hold(nr({ blobs: pair(await c.blob(T9), X) })), id);
    // Final review r2 D-1: once A moved (H1' = T9{2:X, 8:eight}), an h1 equal to the STORED side made at the new A is another change
    // (it also drops A's row 8), so it is a new record; the record's own pair still attaches (the same REBASE at every A).
    const moved = await c.blob(t9([8, 'eight']));
    c.A.set(P, { path: P, mode: '100644', oid: moved });
    assert.equal(await reg.hold(nr({ blobs: pair(await c.blob(T9), X) })), id, 'the record\'s own pair attaches at any A');
    const stale = await reg.holdOutcome(nr({ blobs: pair(moved, X) }));
    assert.equal(stale.created, true, 'an equal stored h1 over the moved A is a new change');
    assert.notEqual(stale.id, id);
    assert.equal(reg.get(id)!.rev, 2, 'the record is unchanged');
  });
});

test('a REBASE-converging H1 attaches and a diverging one creates a record', T10, async () => {
  await withRegistry('reg-converge', async (c) => {
    const reg = await c.reg();
    const id = await reg.hold(nr({ blobs: pair(await c.blob(T9), await c.blob(t9([2, 'two']))) }));
    const a = await c.blob(t9([8, 'eight']));
    c.A.set(P, { path: P, mode: '100644', oid: a });
    assert.equal(await reg.hold(nr({ blobs: pair(a, await c.blob(t9([2, 'two'], [8, 'eight']))), guard: 'join' })), id);
    assert.deepEqual(names(reg.get(id)), ['revert', 'join']);
    const other = await reg.hold(nr({ blobs: pair(a, await c.blob(t9([2, 'TWO'], [8, 'eight']))) }));
    assert.notEqual(other, id);
  });
});

test('a different kind or path set never attaches', T10, async () => {
  await withRegistry('reg-kind-paths', async (c) => {
    const reg = await c.reg();
    const h0 = await c.blob(T9);
    const h1 = await c.blob(t9([2, 'kind']));
    const id = await reg.hold(nr({ blobs: pair(h0, h1) }));
    const pin = await reg.hold(nr({ kind: 'PIN', blobs: pair(h0, h1), guard: 'join' }));
    assert.notEqual(pin, id);
    const two = await reg.hold(nr({ paths: [P, 'src/q.txt'], blobs: { h0: { [P]: h0, 'src/q.txt': ABSENT }, h1: { [P]: h1, 'src/q.txt': ABSENT } } }));
    assert.notEqual(two, id);
    assert.deepEqual(names(reg.get(id)), ['revert']);
  });
});

test('an OFF_DISK record attached by an ON_DISK call moves back ON_DISK', T10, async () => {
  await withRegistry('reg-offdisk-attach', async (c) => {
    const reg = await c.reg();
    const h1 = await c.blob(t9([2, 'parked']));
    const id = await reg.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', blobs: pair(await c.blob(T9), h1) }));
    c.clock.advance(45_000);
    const n0 = await commitCount(c);
    const out = await reg.holdOutcome(nr({ blobs: pair(await c.blob(T9), h1), guard: 'join' }));
    assert.deepEqual(out, { id, created: false, attachedGuard: 'join', conflictedExisting: false });
    const r = reg.get(id)!;
    assert.deepEqual([r.residence, r.state, r.rev], ['ON_DISK', 'ACTIVE', 2]);
    assert.deepEqual(names(r), ['revert', 'join']);
    assert.equal(await commitCount(c), n0 + 1, 'one rev');
    assert.deepEqual(r.age_anchor, { since_rev: 2, anchor_wall_ms: c.clock.wallMs(), mono_accum_ms: 0 }, 'its age restarts');
    assert.equal(reg.ageMs(r), 0);
    // An OFF_DISK CONFLICTED record becomes ON_DISK CONFLICTED.
    const k = await reg.hold(nr({ residence: 'OFF_DISK', state: 'CONFLICTED', paths: ['src/k.txt'], blobs: pair(await c.blob('k0\n'), await c.blob('k1\n'), 'src/k.txt'), guard: 'conflict' }));
    await reg.hold(nr({ paths: ['src/k.txt'], blobs: pair(await c.blob('k0\n'), await c.blob('k1\n'), 'src/k.txt'), guard: 'revert' }));
    assert.deepEqual(pick(reg.get(k)!), ['ON_DISK', 'CONFLICTED']);
    assert.deepEqual(names(reg.get(k)), ['conflict', 'revert']);
  });
});

test('a K4 on a path set already held transitions the existing record', T10, async () => {
  await withRegistry('reg-k4', async (c) => {
    const reg = await c.reg();
    const F = 'src/f.py';
    const id = await reg.hold(nr({ paths: [F], blobs: pair(await c.blob('f0\n'), await c.blob('f mine\n'), F) }));
    const stages: HoldBlobs = { s1: { [F]: await c.blob('f0\n') }, s2: { [F]: await c.blob('f mine\n') }, s3: { [F]: await c.blob('f theirs\n') } };
    const n0 = await commitCount(c);
    const out = await reg.holdOutcome(nr({ paths: [F], state: 'CONFLICTED', blobs: stages, guard: 'conflict' }));
    assert.deepEqual(out, { id, created: false, attachedGuard: 'conflict', conflictedExisting: true });
    const r = reg.get(id)!;
    assert.deepEqual([r.residence, r.state], ['ON_DISK', 'CONFLICTED']);
    assert.deepEqual(r.blobs, stages);
    assert.deepEqual(names(r), ['revert', 'conflict']);
    assert.equal(await commitCount(c), n0 + 1);
    // The same K4 while the held record covers [f.py, g.py] (a second scenario, own paths): a new record.
    const F2 = 'lib/f.py';
    const G = 'lib/g.py';
    const wide = await reg.hold(nr({ paths: [F2, G], blobs: { h0: { [F2]: await c.blob('w0\n'), [G]: ABSENT }, h1: { [F2]: await c.blob('w1\n'), [G]: await c.blob('g1\n') } } }));
    const stages2: HoldBlobs = { s1: { [F2]: await c.blob('w0\n') }, s2: { [F2]: await c.blob('w1\n') }, s3: { [F2]: await c.blob('w theirs\n') } };
    const out2 = await reg.holdOutcome(nr({ paths: [F2], state: 'CONFLICTED', blobs: stages2, guard: 'conflict' }));
    assert.equal(out2.created, true);
    assert.notEqual(out2.id, wide);
    assert.equal(out2.conflictedExisting, false);
  });
});

test('a K4 never puts its stages on a target carrying markers: a TypeError in the K4 branch and in the converging conflict branch, nothing committed (EF4 E4-1, R3-EF4-7)', T10, async () => {
  await withRegistry('reg-k4-markers', async (c) => {
    const reg = await c.reg();
    const F = 'src/f.py';
    const f0 = await c.blob('f0\n');
    const theirs = await c.blob('f theirs\n');
    const refused = (e: unknown): boolean => e instanceof TypeError && /carries markers/.test(e.message);
    // The K4 branch (HLD-07 bullet 2): an ON_DISK record of the same path set that carries `markers` (05 §3.4 item 3: never refreshed from disk).
    const r = await reg.hold(nr({ paths: [F], blobs: pair(f0, await c.blob('f mine\n'), F), guard: 'markers' }));
    const before = reg.get(r)!;
    const n0 = await commitCount(c);
    const k4: HoldBlobs = { s1: { [F]: f0 }, s2: { [F]: await c.blob('<<<<<<< cowork:disk\nf disk\n=======\nf mine\n>>>>>>> cowork:held\n') }, s3: { [F]: theirs } };
    await assert.rejects(reg.holdOutcome(nr({ paths: [F], state: 'CONFLICTED', blobs: k4, guard: 'conflict', origin: 'daemon' })), refused);
    assert.deepEqual(reg.get(r), before, 'r unchanged');
    assert.equal(await commitCount(c), n0, 'nothing committed');
    // The converging conflict branch: an OFF_DISK record carrying `markers` whose held side the call's s2 equals.
    const G = 'src/g.py';
    const g0 = await c.blob('g0\n');
    const gMine = await c.blob('g mine\n');
    const q = await reg.hold(nr({ paths: [G], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(g0, gMine, G), guard: 'markers' }));
    const qBefore = reg.get(q)!;
    await assert.rejects(reg.holdOutcome(nr({ paths: [G], state: 'CONFLICTED', blobs: { s1: { [G]: g0 }, s2: { [G]: gMine }, s3: { [G]: theirs } }, guard: 'conflict', origin: 'daemon' })), refused);
    assert.deepEqual(reg.get(q), qBefore, 'q unchanged');
    assert.equal(await commitCount(c), n0 + 1, 'only q\'s own birth was committed');
    // The same K4 onto a record without `markers` attaches as before (HLD-07).
    const plain = await reg.hold(nr({ paths: ['src/h.py'], blobs: pair(f0, await c.blob('h mine\n'), 'src/h.py') }));
    const hk4: HoldBlobs = { s1: { 'src/h.py': f0 }, s2: { 'src/h.py': await c.blob('h disk\n') }, s3: { 'src/h.py': theirs } };
    assert.deepEqual(await reg.holdOutcome(nr({ paths: ['src/h.py'], state: 'CONFLICTED', blobs: hk4, guard: 'conflict', origin: 'daemon' })),
      { id: plain, created: false, attachedGuard: 'conflict', conflictedExisting: true });
  });
});

test('a stage call attached to an OFF_DISK record makes it ON_DISK CONFLICTED with the stages', T10, async () => {
  await withRegistry('reg-k4-offdisk', async (c) => {
    const reg = await c.reg();
    const F = 'src/f.py';
    const mine = await c.blob('f mine\n');
    const parked = await reg.hold(nr({ paths: [F], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(await c.blob('f0\n'), mine, F) }));
    const stages: HoldBlobs = { s1: { [F]: await c.blob('f0\n') }, s2: { [F]: mine }, s3: { [F]: await c.blob('f theirs\n') } };
    const n0 = await commitCount(c);
    // apply.ts's K4 shape: an equal held side (s2 == h1) attaches to the parked record instead of creating one (HLD-07) ...
    const out = await reg.holdOutcome(nr({ paths: [F], state: 'CONFLICTED', blobs: stages, guard: 'conflict', origin: 'daemon' }));
    assert.deepEqual(out, { id: parked, created: false, attachedGuard: 'conflict', conflictedExisting: true });
    const r = reg.get(parked)!;
    assert.deepEqual([r.residence, r.state], ['ON_DISK', 'CONFLICTED']);
    assert.deepEqual(r.blobs, stages);
    assert.deepEqual(names(r), ['revert', 'conflict']);
    assert.equal(await commitCount(c), n0 + 1, 'one rev');
    // ... so the apply's R-02 follow-up after its verified TIP write is a legal Table 1 move.
    assert.deepEqual(pick(await reg.transition(parked, { residence: 'OFF_DISK' })), ['OFF_DISK', 'CONFLICTED']);
    // A REBASE-converging (not equal) held side does the same.
    const conv = await reg.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', blobs: pair(await c.blob(T9), await c.blob(t9([2, 'two']))) }));
    const a = await c.blob(t9([8, 'eight']));
    c.A.set(P, { path: P, mode: '100644', oid: a });
    const s: HoldBlobs = { s1: { [P]: a }, s2: { [P]: await c.blob(t9([2, 'two'], [8, 'eight'])) }, s3: { [P]: await c.blob(t9([2, 'theirs'], [8, 'eight'])) } };
    assert.deepEqual(await reg.holdOutcome(nr({ state: 'CONFLICTED', blobs: s, guard: 'conflict', origin: 'daemon' })), { id: conv, created: false, attachedGuard: 'conflict', conflictedExisting: true });
    assert.deepEqual([reg.get(conv)!.residence, reg.get(conv)!.state, reg.get(conv)!.blobs], ['ON_DISK', 'CONFLICTED', s]);
    // A CONFLICTED call with an h0/h1 pair: CONFLICTED, the record's pair kept (A is the record's base: its H1' is its stored h1).
    const Q = 'src/q.txt';
    c.A.set(Q, { path: Q, mode: '100644', oid: await c.blob('q0\n') });
    const qBlobs = pair(await c.blob('q0\n'), await c.blob('q1\n'), Q);
    const q = await reg.hold(nr({ paths: [Q], residence: 'OFF_DISK', state: 'PARKED', blobs: qBlobs }));
    assert.deepEqual(await reg.holdOutcome(nr({ paths: [Q], state: 'CONFLICTED', blobs: pair(await c.blob('q other base\n'), await c.blob('q1\n'), Q), guard: 'conflict' })),
      { id: q, created: false, attachedGuard: 'conflict', conflictedExisting: true });
    assert.deepEqual([reg.get(q)!.residence, reg.get(q)!.state, reg.get(q)!.blobs], ['ON_DISK', 'CONFLICTED', qBlobs]);
  });
});

test('a REBASE operator error on one candidate skips that candidate', T10, async () => {
  await withRegistry('reg-skip-candidate', async (c) => {
    const reg = await c.reg();
    const h0 = await c.blob(T9);
    const y1 = await c.blob(t9([2, 'candidate one: its blob turns unreadable']));
    const y2 = await c.blob(t9([6, 'candidate two']));
    const r1 = await reg.hold(nr({ blobs: pair(h0, y1) }));
    c.clock.advance(1);   // a later ULID millisecond: r1 precedes r2 in ULID order, so the birth below meets r1 first
    const r2 = await reg.hold(nr({ blobs: pair(h0, y2) }));   // A[p] ABSENT: the whole-path rule says r1 does not converge
    assert.notEqual(r2, r1);
    assert.ok(r1 < r2, 'r1 is the first candidate in ULID order');
    c.A.set(P, { path: P, mode: '100644', oid: h0 });
    // r1's held blob becomes unreadable: its REBASE is an operator error (HoldOperatorError), not a conflict.
    const file = join(c.f.paths.gitDir, 'objects', y1.slice(0, 2), y1.slice(2));
    chmodSync(file, 0o644);
    writeFileSync(file, Buffer.from('this is not a zlib stream', 'utf8'));
    await assert.rejects(c.rebase.rebase(reg.get(r1)!, c.A), (e: unknown) => e instanceof HoldOperatorError && e.holdId === r1);
    // The birth skips r1 (first in ULID order) and attaches to r2, whose held side it equals.
    assert.deepEqual(await reg.holdOutcome(nr({ blobs: pair(h0, y2), guard: 'join' })), { id: r2, created: false, attachedGuard: 'join', conflictedExisting: false });
    assert.deepEqual(names(reg.get(r1)), ['revert']);
  });
  // With no other candidate the birth creates a record instead of failing; a crash (KilledAt) is never swallowed. (A cache whose
  // converges throws for one record: a new record re-trees blobs/, which git mktree refuses while a named object is corrupt.)
  await withRegistry('reg-skip-candidate-create', async (c) => {
    let failing = '';
    let thrown: Error = new Error('unset');
    class FailingCache extends RebaseCache {
      override converges(r: HoldRecord, A: TreeMap, h1: BlobMap): Promise<boolean> {
        return r.id === failing ? Promise.reject(thrown) : super.converges(r, A, h1);
      }
    }
    const reg = new HoldRegistry({ ...c.deps(), rebase: new FailingCache(c.f.repo, () => true) });
    await reg.load();
    const h0 = await c.blob(T9);
    const r1 = await reg.hold(nr({ blobs: pair(h0, await c.blob(t9([2, 'one']))) }));
    failing = r1;
    thrown = new HoldOperatorError('rebase', P, r1, 'planted');
    const out = await reg.holdOutcome(nr({ blobs: pair(h0, await c.blob(t9([6, 'other']))), guard: 'join' }));
    assert.equal(out.created, true);
    assert.notEqual(out.id, r1);
    thrown = new KilledAt('registry.cas');
    const head = await c.head();
    await assert.rejects(reg.holdOutcome(nr({ blobs: pair(h0, await c.blob(t9([4, 'third']))), guard: 'join' })), KilledAt);
    assert.equal(await c.head(), head);
  });
});

test('an attach keeps the union of the call\'s and the record\'s cs_ids', T10, async () => {
  await withRegistry('reg-cs-union', async (c) => {
    const reg = await c.reg();
    const X = await c.blob(t9([2, 'cs']));
    const cs = (peer: string, n: number): string => `${peer}/human/${n}`;
    const id = await reg.hold(nr({ blobs: pair(await c.blob(T9), X), cs_ids: [cs(PEER, 2)] }));
    const n0 = await commitCount(c);
    assert.deepEqual(await reg.holdOutcome(nr({ blobs: pair(await c.blob(T9), X), guard: 'join', cs_ids: [cs(P2, 5), cs(PEER, 2)] })),
      { id, created: false, attachedGuard: 'join', conflictedExisting: false });
    assert.deepEqual(reg.get(id)!.cs_ids, [cs(PEER, 2), cs(P2, 5)].sort());
    assert.equal(await commitCount(c), n0 + 1, 'one rev');
    // A new cs id alone is a change of the record (one rev); the same call again is none.
    assert.deepEqual(await reg.holdOutcome(nr({ blobs: pair(await c.blob(T9), X), guard: 'join', cs_ids: [cs(PEER, 7)] })),
      { id, created: false, attachedGuard: null, conflictedExisting: false });
    assert.deepEqual(reg.get(id)!.cs_ids, [cs(PEER, 2), cs(P2, 5), cs(PEER, 7)].sort());
    assert.equal(await commitCount(c), n0 + 2);
    await reg.holdOutcome(nr({ blobs: pair(await c.blob(T9), X), guard: 'join', cs_ids: [cs(PEER, 7)] }));
    assert.equal(await commitCount(c), n0 + 2, 'nothing new: no commit');
    // The K4 and the R-02 dedupe keep the union too.
    const F = 'src/f.py';
    const k = await reg.hold(nr({ paths: [F], blobs: pair(await c.blob('f0\n'), await c.blob('f mine\n'), F), cs_ids: [cs(PEER, 3)] }));
    const stages: HoldBlobs = { s1: { [F]: await c.blob('f0\n') }, s2: { [F]: await c.blob('f mine 2\n') }, s3: { [F]: await c.blob('f theirs\n') } };
    await reg.hold(nr({ paths: [F], state: 'CONFLICTED', blobs: stages, guard: 'conflict', cs_ids: [cs(PEER, 4)] }));
    assert.deepEqual(reg.get(k)!.cs_ids, [cs(PEER, 3), cs(PEER, 4)].sort());
    const newer: HoldBlobs = { s1: { [F]: await c.blob('f base 2\n') }, s2: stages.s2, s3: { [F]: await c.blob('f theirs 2\n') } };
    assert.equal(await reg.hold(nr({ paths: [F], state: 'CONFLICTED', blobs: newer, guard: 'conflict', cs_ids: [cs(P2, 1)] })), k);
    assert.deepEqual(reg.get(k)!.cs_ids, [cs(PEER, 3), cs(PEER, 4), cs(P2, 1)].sort());
  });
});

test('a LOCAL_ONLY path is not live only through another record (otherLocalOnly)', T10, async () => {
  await withRegistry('reg-other-local-only', async (c) => {
    const reg = await c.reg();
    const K = 'src/k.txt';
    // D5 row 9 reports K LOCAL_ONLY while some record makes it so.
    c.scope.set(K, 'LOCAL_ONLY');
    const y = await reg.hold(nr({ kind: 'PIN', paths: [K], blobs: pair(await c.blob('k0\n'), await c.blob('k pin\n'), K), guard: 'join' }));
    assert.equal(reg.get(y)!.local_only, false, 'alone: K is LOCAL_ONLY only through y itself (its own effect)');
    const x = await reg.hold(nr({ paths: [K], blobs: pair(await c.blob('k0\n'), await c.blob('k secret\n'), K), guard: 'secret-scan' }));
    assert.equal(reg.get(x)!.local_only, true, 'secret-scan');
    assert.equal((await reg.transition(y, { state: 'CONFLICTED' })).local_only, true, 'x, ON_DISK and local_only, covers K: not live');
    await reg.transition(x, { residence: 'OFF_DISK', state: 'PARKED' });
    assert.equal((await reg.transition(y, { residence: 'OFF_DISK' })).local_only, false, 'an OFF_DISK record does not count');
    await reg.transition(x, { residence: 'ON_DISK', state: 'ACTIVE' });
    assert.equal((await reg.transition(y, { residence: 'ON_DISK' })).local_only, true);
    await reg.transition(x, { state: 'GONE' });
    assert.equal((await reg.transition(y, { residence: 'OFF_DISK' })).local_only, false, 'a terminal record does not count');
  });
});

test('flushAgeAnchors emits a hold event for every rev whose local_only flips', T10, async () => {
  await withRegistry('reg-flush-trace', async (c) => {
    const reg = await c.reg();
    const a = await reg.hold(nr({ paths: ['src/a.txt'], blobs: pair(await c.blob('a0\n'), await c.blob('a1\n'), 'src/a.txt') }));
    const b = await reg.hold(nr({ paths: ['src/b.txt'], blobs: pair(await c.blob('b0\n'), await c.blob('b1\n'), 'src/b.txt') }));
    c.clock.advance(5_000);
    c.scope.set('src/b.txt', 'SAVE_ONLY');
    const ev0 = c.holdEvents().length;
    assert.equal(await reg.flushAgeAnchors(), 2);
    assert.equal(reg.get(b)!.local_only, true);
    assert.deepEqual(c.holdEvents().slice(ev0).map((e) => [e.id, e.rev, e.localOnly]), [[b, 2, true]], 'only b\'s rev flipped');
    c.clock.advance(5_000);
    c.scope.delete('src/b.txt');
    assert.equal(await reg.flushAgeAnchors(), 2);
    assert.deepEqual(c.holdEvents().slice(ev0 + 1).map((e) => [e.id, e.rev, e.localOnly]), [[b, 3, false]]);
    assert.equal(reg.get(a)!.rev, 3);
  });
});

test('records over paths named __proto__ and constructor round-trip and attach', T10, async () => {
  await withRegistry('reg-proto-paths', async (c) => {
    const reg = await c.reg();
    const PROTO = '__proto__';
    const CTOR = 'constructor';
    const h0: BlobMap = { [PROTO]: await c.blob('p0\n'), [CTOR]: ABSENT };
    const h1: BlobMap = { [PROTO]: await c.blob('p1\n'), [CTOR]: await c.blob('c1\n') };
    const id = await reg.hold(nr({ kind: 'PIN', paths: [CTOR, PROTO], blobs: { h0, h1 }, guard: 'join' }));
    const r = reg.get(id)!;
    assert.deepEqual(r.paths, [PROTO, CTOR]);
    assert.deepEqual(r.blobs, { h0, h1 });
    assert.ok(Object.prototype.hasOwnProperty.call((r.blobs as { h1: BlobMap }).h1, PROTO));
    assert.deepEqual((await c.reg('fresh')).get(id), r);
    assert.deepEqual(await reg.holdOutcome(nr({ kind: 'PIN', paths: [PROTO, CTOR], blobs: { h0, h1 }, guard: 'unstable' })),
      { id, created: false, attachedGuard: 'unstable', conflictedExisting: false });
    // A different held side under __proto__ is another change.
    const other = await reg.holdOutcome(nr({ kind: 'PIN', paths: [PROTO, CTOR], blobs: { h0, h1: { [PROTO]: await c.blob('p2\n'), [CTOR]: h1[CTOR]! } }, guard: 'join' }));
    assert.equal(other.created, true);
  });
});

test('R-02\'s stage dedupe is kept', T10, async () => {
  await withRegistry('reg-r02', async (c) => {
    const reg = await c.reg();
    const s2 = await c.blob(t9([2, 'local']));
    const k = await reg.hold(nr({ state: 'CONFLICTED', guard: 'conflict', blobs: { s1: { [P]: await c.blob(T9) }, s2: { [P]: s2 }, s3: { [P]: await c.blob(t9([2, 'tip one'])) } } }));
    const n0 = await commitCount(c);
    const newer: HoldBlobs = { s1: { [P]: await c.blob(t9([9, 'base two'])) }, s2: { [P]: s2 }, s3: { [P]: await c.blob(t9([2, 'tip two'])) } };
    assert.equal(await reg.hold(nr({ state: 'CONFLICTED', guard: 'conflict', blobs: newer })), k);
    assert.deepEqual(reg.get(k)!.blobs, newer, 's1/s3 replaced');
    assert.equal(reg.get(k)!.rev, 2);
    assert.equal(await commitCount(c), n0 + 1, 'in one rev');
  });
});

test('an ON_DISK stage call deduped onto an OFF_DISK CONFLICTED stage record moves it ON_DISK in the same rev', T10, async () => {
  await withRegistry('reg-r02-offdisk', async (c) => {
    const reg = await c.reg();
    const s2 = await c.blob(t9([2, 'local']));
    // The apply's K4 (ON_DISK CONFLICTED), then R-02's follow-up after its verified TIP write (OFF_DISK CONFLICTED).
    const k = await reg.hold(nr({ state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: { s1: { [P]: await c.blob(T9) }, s2: { [P]: s2 }, s3: { [P]: await c.blob(t9([2, 'tip one'])) } } }));
    assert.deepEqual(pick(await reg.transition(k, { residence: 'OFF_DISK' })), ['OFF_DISK', 'CONFLICTED']);
    c.clock.advance(30_000);
    // A later apply's K4 over the same path with the same s2 (R-02 dedupe): the record masks again during that write window.
    const n0 = await commitCount(c);
    const newer: HoldBlobs = { s1: { [P]: await c.blob(t9([9, 'base two'])) }, s2: { [P]: s2 }, s3: { [P]: await c.blob(t9([2, 'tip two'])) } };
    assert.deepEqual(await reg.holdOutcome(nr({ state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: newer })),
      { id: k, created: false, attachedGuard: null, conflictedExisting: false });
    const r = reg.get(k)!;
    assert.deepEqual([r.residence, r.state, r.rev, r.blobs], ['ON_DISK', 'CONFLICTED', 3, newer]);
    assert.equal(await commitCount(c), n0 + 1, 'one rev');
    assert.deepEqual(r.age_anchor, { since_rev: 3, anchor_wall_ms: c.clock.wallMs(), mono_accum_ms: 0 }, 'its age restarts');
    assert.ok(reg.maskingRecords().some((x) => x.id === k));
    // The follow-up after that apply's write is a legal Table 1 move again.
    assert.deepEqual(pick(await reg.transition(k, { residence: 'OFF_DISK' })), ['OFF_DISK', 'CONFLICTED']);
    // An OFF_DISK call with the same s2 keeps the residence (only an ON_DISK call brings it back).
    await reg.hold(nr({ residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: newer }));
    assert.equal(reg.get(k)!.residence, 'OFF_DISK');
  });
});

test('guards compose with AND', T10, async () => {
  await withRegistry('reg-and', async (c) => {
    const reg = await c.reg();
    const id = await reg.hold(nr({ blobs: pair(await c.blob(T9), await c.blob(t9([2, 'and']))) }));
    await reg.addGuard(id, 'join');
    const n0 = await commitCount(c);
    const one = await reg.releaseGuard(id, 'revert');
    assert.deepEqual(names(one), ['join']);
    assert.equal(await commitCount(c), n0 + 1);
    assert.ok(reg.maskingRecords().some((r) => r.id === id), 'still masking while a guard remains');
    assert.deepEqual(names(await reg.releaseGuard(id, 'join')), []);
    assert.ok(!reg.maskingRecords().some((r) => r.id === id));
    const head = await c.head();
    await assert.rejects(reg.releaseGuard(id, 'revert'), TypeError);
    await assert.rejects(reg.addGuard(id, 'frobnicate'), TypeError);
    assert.equal(await c.head(), head);
  });
});

test('U4 guard algebra with an unknown name', T10, async (t) => {
  await withRegistry('reg-u4', async (c) => {
    // fast-check (seed 4242, shrinking on failure), R3-73: 50 runs within a 60 s budget per CI leg; the full 200 (no budget) under
    // TEST_SIM_FULL=1, the nightly sim-exit job's `npm run test:sim` (R3-55). Each run plants its record (the Table 3 subset plus
    // frobnicate, which no API can add) as a one-commit registry on its own ref. The budget's interrupt only stops waiting for the
    // run in flight (fast-check races it), so every run is awaited before withRegistry removes the fixture.
    const full = process.env['TEST_SIM_FULL'] === '1';
    const numRuns = full ? 200 : 50;
    const inflight = new Set<Promise<void>>();
    const repo = c.f.repo;
    const all = GUARD_TABLE.map((r) => r.name).map((n) => (n === 'claim' ? 'claim:abcdefghij234567' : n === 'dependency' ? 'dependency:01ARZ3NDEKTSV4RRFFQ69G5FAV' : n));
    const op = fc.record({ add: fc.boolean(), name: fc.constantFrom(...all, 'frobnicate') });
    const h0 = await c.blob(T9);
    const h1 = await c.blob(t9([2, 'u4 held']));
    const blobsTree = await repo.mktree([h0, h1].sort().map((o): MktreeEntry => ({ name: o, mode: '100644', type: 'blob', oid: o })));
    let run = 0;
    let done = 0;
    const tracked = (body: () => Promise<void>): Promise<void> => {
      const p = body();
      const settled = p.then(() => undefined, () => undefined);
      inflight.add(settled);
      void settled.then(() => inflight.delete(settled));
      return p;
    };
    const property = fc.asyncProperty(fc.record({ initial: fc.subarray(all, { minLength: 1 }), ops: fc.array(op, { minLength: 1, maxLength: 3 }) }), (k) => tracked(async () => {
        const i = run++;
        const ref = `refs/cowork-local/u4-${i}/holds`;
        const id = ulid(seededRandom(`u4-${i}`), c.clock);
        const rec = planted(id, [...k.initial.map((g) => makeGuard(g)), FROB], h0, h1, `u4/${i}.txt`);
        const records = await repo.mktree([{ name: `${id}.json`, mode: '100644', type: 'blob', oid: await repo.hashBytes(serializeRecord(rec), true) }]);
        const root = await repo.mktree([{ name: 'blobs', mode: '040000', type: 'tree', oid: blobsTree }, { name: 'records', mode: '040000', type: 'tree', oid: records }]);
        assert.equal(await repo.casRef(ref, await repo.commitTree({ tree: root, parents: [], subject: 'cowork-holds', trailers: [] }), null, 'cowork-holds'), true);
        const reg = new HoldRegistry({ ...c.deps(`u4-${i}`), ref });
        await reg.load();
        const model = new Set<string>([...k.initial, 'frobnicate']);
        for (const o of k.ops) {
          if (o.add) {
            if (o.name === 'frobnicate') {
              await assert.rejects(reg.addGuard(id, o.name), TypeError);
            } else {
              await reg.addGuard(id, o.name);
              model.add(o.name);
            }
          } else if (o.name === 'frobnicate' || !model.has(o.name)) {
            await assert.rejects(reg.releaseGuard(id, o.name), TypeError, `release ${o.name}`);
          } else {
            await reg.releaseGuard(id, o.name);
            model.delete(o.name);
          }
          const r = reg.get(id)!;
          assert.deepEqual(new Set(names(r)), model);
          assert.equal(names(r).length, model.size, 'no duplicate guard');
          assert.ok(names(r).includes('frobnicate'));
          if (r.residence === 'ON_DISK' && r.guards.length > 0) assert.ok(reg.maskingRecords().some((x) => x.id === id));
        }
        done++;
      }));
    try {
      await fc.assert(property, { numRuns, seed: 4242, ...(full ? {} : { interruptAfterTimeLimit: 60_000, markInterruptAsFailure: false }) });
    } finally {
      // The run the budget interrupted may still be writing to the fixture: wait for it (its outcome no longer counts).
      await Promise.all([...inflight]);
    }
    assert.ok(done > 0);
    if (full) assert.equal(done, 200, 'TEST_SIM_FULL: every run');
    t.diagnostic(`U4: ${done} of ${numRuns} runs passed${full ? '' : ' within the 60 s budget'}`);
  });
});

test('a record carrying an unknown guard is never transitioned', T10, async () => {
  await withRegistry('reg-unknown', async (c) => {
    const id = ulid(seededRandom('unknown'), c.clock);
    await plant(c, [planted(id, [makeGuard('revert'), FROB], await c.blob(T9), await c.blob(t9([2, 'newer daemon'])))]);
    const reg = await c.reg();
    const head = await c.head();
    const patches: HoldPatch[] = [{ state: 'CONFLICTED' }, { residence: 'OFF_DISK', state: 'PARKED' }, { guards: [makeGuard('revert')] }, { offer: 'pending_leftover' }];
    for (const patch of patches) {
      await assert.rejects(reg.transition(id, patch), (e: unknown) => e instanceof TypeError && /frobnicate/.test(e.message), JSON.stringify(patch));
    }
    await assert.rejects(reg.offerEvent(id, 'born_leftover'), (e: unknown) => e instanceof TypeError && /frobnicate/.test(e.message));
    assert.equal(await c.head(), head);
    c.clock.advance(20_000);
    assert.equal(await reg.flushAgeAnchors(), 1);
    const r = reg.get(id)!;
    assert.equal(r.rev, 2);
    assert.equal(r.age_anchor.mono_accum_ms, 20_000);
    assert.deepEqual(r.guards, [makeGuard('revert'), FROB]);
  });
});

test('local_only is recomputed at every rev', T10, async () => {
  await withRegistry('reg-local-only', async (c) => {
    const reg = await c.reg();
    const env = await reg.hold(nr({ paths: ['.env'], blobs: pair(await c.blob('A=0\n'), await c.blob('A=1\n'), '.env'), local_only: false }));
    assert.equal(reg.get(env)!.local_only, true, 'NewRecord.local_only is ignored');
    const a = await reg.hold(nr({ paths: ['src/a.ts'], blobs: pair(await c.blob('a0\n'), await c.blob('a1\n'), 'src/a.ts'), local_only: true }));
    assert.equal(reg.get(a)!.local_only, false);
    const lo = (): boolean[] => c.holdEvents().filter((e) => e.id === a).map((e) => e.localOnly);
    assert.equal((await reg.addGuard(a, 'secret-scan')).local_only, true);
    assert.equal((await reg.releaseGuard(a, 'secret-scan')).local_only, false);
    assert.deepEqual(lo(), [false, true, false], 'each flip shows in that rev\'s hold event');
    const b = await reg.hold(nr({ paths: ['src/b.txt'], blobs: pair(await c.blob('b0\n'), await c.blob('b1\n'), 'src/b.txt') }));
    assert.equal(reg.get(b)!.local_only, false);
    c.scope.set('src/b.txt', 'SAVE_ONLY');
    const flipped = await reg.transition(b, { state: 'CONFLICTED' });
    assert.equal(flipped.local_only, true);
    assert.equal(c.holdEvents().at(-1)!.localOnly, true);
    // A marker companion is local_only at every rev.
    const parent = await reg.hold(nr({ paths: ['src/m.txt'], blobs: pair(await c.blob('m0\n'), await c.blob('m1\n'), 'src/m.txt'), guard: 'markers' }));
    const comp = await reg.hold(nr({ paths: ['src/m.txt'], residence: 'OFF_DISK', state: 'PARKED', guard: null, companionOf: parent, blobs: pair(await c.blob('m0\n'), await c.blob('<<<<<<< cowork:disk\n'), 'src/m.txt') }));
    assert.equal(reg.get(comp)!.local_only, true);
    assert.equal((await reg.transition(comp, { residence: 'ON_DISK', state: 'ACTIVE', guards: [makeGuard('markers')] })).local_only, true);
    assert.equal((await reg.transition(comp, { state: 'GONE' })).local_only, true);
  });
});

test('R3-EF4-24 (DAT-46 defence in depth): a record whose held side carries a restore-marker row is local_only (a content-free stub) at birth, never refused, and at every rev that gives it one; a marker row on a base or TIP side alone does not count', T10, async () => {
  await withRegistry('reg-marker-held', async (c) => {
    const reg = await c.reg();
    const Q = 'src/q.txt';
    const base = await c.blob('a\nb\n');
    const plain = await c.blob('a\nB\n');
    const marked = await c.blob('a\n<<<<<<< cowork:current\nb\n=======\nB\n>>>>>>> cowork:held 01HXYZ\n');
    const crlf = await c.blob('﻿a\r\n||||||| cowork:base\r\nb\r\n');   // CRLF, row 1's BOM ignored (hasRestoreMarkerRow)
    // Births: created, never refused, local_only.
    const r1 = await reg.hold(nr({ paths: [Q], blobs: pair(base, marked, Q) }));
    assert.equal(reg.get(r1)!.local_only, true, 'an h1 with a restore-marker row');
    const r2 = await reg.hold(nr({ paths: ['src/r.txt'], blobs: pair(base, crlf, 'src/r.txt'), guard: 'restart' }));
    assert.equal(reg.get(r2)!.local_only, true, 'CRLF rows, a BOM on row 1');
    const k4 = await reg.hold(nr({ paths: ['src/k.txt'], state: 'CONFLICTED', guard: 'conflict', blobs: { s1: { 'src/k.txt': base }, s2: { 'src/k.txt': marked }, s3: { 'src/k.txt': plain } } }));
    assert.equal(reg.get(k4)!.local_only, true, "a stage record's held side is s2");
    // A marker row on a base or TIP side only: not the held side.
    const b1 = await reg.hold(nr({ paths: ['src/b.txt'], blobs: pair(marked, plain, 'src/b.txt') }));
    assert.equal(reg.get(b1)!.local_only, false, 'h0 alone');
    const t1 = await reg.hold(nr({ paths: ['src/t.txt'], state: 'CONFLICTED', guard: 'conflict', blobs: { s1: { 'src/t.txt': base }, s2: { 'src/t.txt': plain }, s3: { 'src/t.txt': marked } } }));
    assert.equal(reg.get(t1)!.local_only, false, 's3 alone');
    // A held-side patch that brings the rows: that rev is local_only (and its hold event says so); one that drops them clears it.
    const p1 = await reg.hold(nr({ paths: ['src/p.txt'], blobs: pair(base, plain, 'src/p.txt') }));
    assert.equal(reg.get(p1)!.local_only, false);
    assert.equal((await reg.transition(p1, { blobs: pair(base, marked, 'src/p.txt') })).local_only, true);
    assert.equal(c.holdEvents().at(-1)!.localOnly, true);
    assert.equal((await reg.transition(p1, { blobs: pair(base, plain, 'src/p.txt') })).local_only, false);
    // commitMany: a creation and a patch.
    const m = await reg.commitMany([nr({ paths: ['src/m.txt'], blobs: pair(base, marked, 'src/m.txt') })], [{ id: b1, patch: { blobs: pair(base, crlf, 'src/b.txt') } }]);
    assert.deepEqual(m.records.map((r) => r.local_only), [true, true]);
    // A record an older build wrote (local_only false over a marker h1): its next rev, an age flush included, makes it local_only.
    const OLD = '01J9ZQ3V5W6X7Y8Z9A0B1C2D3E';
    const OLD2 = '01J9ZQ3V5W6X7Y8Z9A0B1C2D3F';
    await plant(c, [planted(OLD, [makeGuard('revert')], base, marked, 'src/o.txt'), planted(OLD2, [makeGuard('revert')], base, crlf, 'src/o2.txt')]);
    await reg.load();
    assert.equal(reg.get(OLD)!.local_only, false, 'load reads what was written');
    assert.equal((await reg.transition(OLD, { state: 'CONFLICTED' })).local_only, true);
    c.clock.advance(1_000);
    assert.ok((await reg.flushAgeAnchors()) >= 1);
    assert.equal(reg.get(OLD2)!.local_only, true, 'the age flush rev');
  });
});

test('RegistryDeps.scopeOf and A follow the current iteration', T10, async () => {
  const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
  const files: Record<string, Buffer> = {
    '.gitattributes': buf('gen/** cowork-sync=off\n'),
    'README.md': buf('# scope\n'),
    'gen/x.txt': buf('generated\n'),
    'src/t9.txt': buf(T9),
  };
  const fx = await makeCores('reg-scope-iteration', { n: 1, files });
  try {
    await fx.bootstrap();
    const p = fx.peers[0]!;
    const core = p.core;
    const repo = core.repo;
    const blob = (s: string): Promise<Oid> => repo.hashBytes(buf(s), true);
    const hold = async (path: string, h1: string, guard = 'revert'): Promise<HoldRecord> =>
      core.holds.get(await core.holds.hold(nr({ paths: [path], blobs: pair(ABSENT, await blob(h1), path), guard })))!;
    // Before any iteration: the start-time scope at EPOCH_BASE (attributes when requested, the team config, quarantine names).
    assert.equal((await hold('.github/workflows/ci.yml', 'ci 1\n')).local_only, true, 'a quarantined name needs no attribute');
    assert.equal((await hold('notes/new.txt', 'new\n')).local_only, true, 'a path nobody asked attributes for: fail closed (R3-71)');
    await ensureAttrs(core, core.view!.meta.EPOCH_BASE, ['notes/new2.txt']);
    assert.equal((await hold('notes/new2.txt', 'new 2\n')).local_only, false, 'requested first (the start.ts shape): LIVE');
    await ensureAttrs(core, core.view!.meta.EPOCH_BASE, ['gen/x.txt']);
    assert.equal((await hold('gen/x.txt', 'generated 2\n')).local_only, true, 'EPOCH_BASE attributes are read when requested');
    // After prepareIteration the registry reads that iteration's scope and A. big/huge.txt is SAVE_ONLY only through the
    // iteration's inputs (TIP's blob size; neither A nor the stat cache knows the path), so the start-time rule would say LIVE.
    const HUGE = 'big/huge.txt';
    await fx.pushTeamChange({ [HUGE]: Buffer.alloc(HUGE_BYTES, 0x61) });
    const r = await prepareIteration(core, 1, { materialize: false, forceFetch: true });
    assert.ok(r.ok);
    assert.equal(r.it.tipMap.has(HUGE), true);
    assert.equal(r.it.A.has(HUGE), false);
    assert.equal(r.it.scope(HUGE).cls, 'SAVE_ONLY');
    assert.equal((await hold(HUGE, 'a local huge-path edit\n')).local_only, true, 'the iteration\'s scope: SAVE_ONLY');
    assert.equal(r.it.scope('.claude/settings.json').cls, 'QUARANTINED');
    assert.equal((await hold('.claude/settings.json', '{}\n')).local_only, true);
    assert.equal(r.it.scope('src/t9.txt').cls, 'LIVE');
    // converges inside holdOutcome reads A of that iteration: A[src/t9.txt] = T9 (the bootstrap), so a record whose
    // pair is (T9{8:eight}, T9{2:two,8:eight}) converges with T9{2:two}.
    const id = await core.holds.hold(nr({ blobs: pair(await blob(t9([8, 'eight'])), await blob(t9([2, 'two'], [8, 'eight']))) }));
    assert.equal(r.it.A.get(P)?.oid, await blob(T9));
    const out = await core.holds.holdOutcome(nr({ blobs: pair(await blob(T9), await blob(t9([2, 'two']))), guard: 'join' }));
    assert.deepEqual(out, { id, created: false, attachedGuard: 'join', conflictedExisting: false });
  } finally {
    await fx.cleanup();
  }
});

test('local_only never fails open: a scope error or unrequested attributes give true (R3-71)', T10, async () => {
  // A planted scope error: one path's class throws, then scopeOf() itself throws.
  await withRegistry('reg-fail-closed', async (c) => {
    let mode: 'path' | 'ok' | 'factory' = 'path';
    const reg = new HoldRegistry({
      ...c.deps(),
      scopeOf: () => {
        if (mode === 'factory') throw new Error('planted: no scope yet');
        return (p) => {
          if (mode === 'path' && p === 'src/err.txt') throw new Error('planted: scope error');
          return 'LIVE';
        };
      },
    });
    await reg.load();
    const id = await reg.hold(nr({ paths: ['src/err.txt'], blobs: pair(await c.blob('e0\n'), await c.blob('e1\n'), 'src/err.txt') }));
    assert.equal(reg.get(id)!.local_only, true, 'a scope error: local_only');
    mode = 'ok';
    assert.equal((await reg.transition(id, { state: 'CONFLICTED' })).local_only, false, 'classified again: LIVE');
    mode = 'factory';
    assert.equal((await reg.transition(id, { residence: 'OFF_DISK' })).local_only, true, 'scopeOf() throwing: local_only');
  });
  // A real filter=crypt attribute whose path was never asked for: local_only until its attributes are requested.
  const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
  const fx = await makeCores('reg-fail-closed-core', { n: 1, files: { '.gitattributes': buf('*.enc filter=crypt\n'), 'src/t9.txt': buf(T9) } });
  try {
    await fx.bootstrap();
    const core = fx.peers[0]!.core;
    const epochBase = core.view!.meta.EPOCH_BASE;
    const blob = (s: string): Promise<Oid> => core.repo.hashBytes(buf(s), true);
    const ENC = 'secret/new.enc';
    const id = await core.holds.hold(nr({ paths: [ENC], blobs: pair(ABSENT, await blob('crypt 1\n'), ENC) }));
    assert.equal(core.holds.get(id)!.local_only, true, 'before any iteration, attributes never requested: fail closed');
    await ensureAttrs(core, epochBase, [ENC]);
    assert.equal(pathIsFiltered(core, ENC), true, 'the attribute is real: filter=crypt at EPOCH_BASE');
    assert.equal((await core.holds.transition(id, { state: 'CONFLICTED' })).local_only, false, 'requested: LIVE (D5 row 10)');
    const r = await prepareIteration(core, 1, { materialize: false, forceFetch: true });
    assert.ok(r.ok);
    const OTHER = 'secret/other.enc';
    const other = await core.holds.hold(nr({ paths: [OTHER], blobs: pair(ABSENT, await blob('crypt 2\n'), OTHER) }));
    assert.equal(core.holds.get(other)!.local_only, true, 'inside an iteration, attributes never requested: fail closed');
  } finally {
    await fx.cleanup();
  }
});

test('the start-time scope reads the attributes at the base the caller requested them (R3-71)', T10, async () => {
  // A hold-creating caller outside an iteration requests its paths' attributes at the epoch base of the state it builds (genesis:
  // HEAD, join: Hb, a lost-state rebuild or recover's re-anchor: the new live base), which need not be the attached view's
  // EPOCH_BASE nor the HEAD the core saw at creation: the registry classes the path with exactly those attributes.
  const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
  const fx = await makeCores('reg-scope-base', { n: 1, files: { '.gitattributes': buf('gen/** cowork-sync=off\n'), 'src/t9.txt': buf(T9) } });
  try {
    await fx.bootstrap();
    const core = fx.peers[0]!.core;
    const repo = core.repo;
    const E = core.view!.meta.EPOCH_BASE;
    const blob = (s: string): Promise<Oid> => repo.hashBytes(buf(s), true);
    // X: another base whose attributes do not turn gen/ off.
    const xTree = await repo.mktree([{ name: 'README.md', mode: '100644', type: 'blob', oid: await blob('# another base\n') }]);
    const X = await repo.commitTree({ tree: xTree, parents: [], subject: 'another base', trailers: [] });
    assert.notEqual(X, E);
    const G = 'gen/y.txt';
    await ensureAttrs(core, X, [G]);
    const id = await core.holds.hold(nr({ paths: [G], blobs: pair(ABSENT, await blob('y 1\n'), G) }));
    assert.equal(core.holds.get(id)!.local_only, false, 'requested at X: classed by X\'s attributes (LIVE), not failed closed');
    await ensureAttrs(core, E, [G]);
    assert.equal((await core.holds.transition(id, { state: 'CONFLICTED' })).local_only, true, 'requested at EPOCH_BASE: cowork-sync=off there');
  } finally {
    await fx.cleanup();
  }
});

test('a later rev keeps local_only for a record path outside A ∪ TIP ∪ the tick: the iteration, restart and the lost-state rebuild request every record path (R3-71)', T10, async () => {
  // Each of the three resets the attribute map; a record path none of A, TIP or the tick names (here a new file that is no longer
  // on disk) must be requested again, or the record's next rev fails closed to local_only true.
  const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
  const fx = await makeCores('reg-record-attrs', { n: 1, files: { 'src/t9.txt': buf(T9) } });
  try {
    await fx.bootstrap();
    const p = fx.peers[0]!;
    const NEW = 'notes/new.txt';
    await ensureAttrs(p.core, p.core.view!.meta.EPOCH_BASE, [NEW]);
    const id = await p.core.holds.hold(nr({ paths: [NEW], blobs: pair(ABSENT, await p.core.repo.hashBytes(buf('new 1\n'), true), NEW) }));
    assert.equal(p.core.holds.get(id)!.local_only, false, 'requested at EPOCH_BASE: LIVE');
    // The iteration.
    const r = await prepareIteration(p.core, 1, { materialize: false, forceFetch: true });
    assert.ok(r.ok);
    assert.equal(r.it.A.has(NEW) || r.it.tipMap.has(NEW) || [...(r.it.tick?.changed ?? [])].includes(NEW), false, 'outside A ∪ TIP ∪ the tick');
    assert.equal((await p.core.holds.transition(id, { state: 'CONFLICTED' })).local_only, false, 'iteration: the transition');
    fx.advance(5_000);
    assert.equal(await p.core.holds.flushAgeAnchors(), 1);
    assert.equal(p.core.holds.get(id)!.local_only, false, 'iteration: flushAgeAnchors');
    // A restart: a fresh core, before its first iteration (the start-time scope).
    await restartCore(p);
    assert.equal((await restart(p.core)).lostState, null);
    fx.advance(5_000);
    assert.equal(await p.core.holds.flushAgeAnchors(), 1);
    assert.equal(p.core.holds.get(id)!.local_only, false, 'restart: flushAgeAnchors');
    // A lost-state rebuild: a fresh core again, the rebuild's own epoch base.
    await restartCore(p);
    await gitIn(p, ['update-ref', '-d', p.core.refs.state]);
    assert.ok((await restart(p.core)).lostState !== null);
    fx.advance(5_000);
    assert.equal(await p.core.holds.flushAgeAnchors(), 1);
    assert.equal(p.core.holds.get(id)!.local_only, false, 'lost-state rebuild: flushAgeAnchors');
  } finally {
    await fx.cleanup();
  }
});

test('the writer\'s late-write callback requests its path\'s attributes before the hold (R3-71, requestAttrs)', T10, async () => {
  // After a restart only A's paths are requested; a local write over an untracked file rings its .old, a late write lands in it,
  // and the sweep's ring PATCH over that path is classed (LIVE), not failed closed.
  const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
  const fx = await makeCores('reg-late-write-attrs', { n: 1, files: { 'src/t9.txt': buf(T9) } });
  try {
    await fx.bootstrap();
    const p = fx.peers[0]!;
    await restartCore(p);
    await restart(p.core);
    const L = 'notes/late.txt';
    await writeWork(p, L, 'untracked\n');
    const tmp = join(p.deps.paths.coworkDir, 'tmp');
    const before = new Set(readdirSync(tmp));
    const target = await p.core.repo.hashBytes(buf('written by the daemon\n'), true);
    assert.deepEqual(await p.core.writer.writeLocal(L, await p.core.repo.hashBytes(buf('untracked\n'), true), target, 'resolve'), { kind: 'WRITTEN' });
    const olds = readdirSync(tmp).filter((n) => n.endsWith('.old') && !before.has(n));
    assert.equal(olds.length, 1, 'the write rang one .old');
    writeFileSync(join(tmp, olds[0]!), 'untracked, then a late write through an old handle\n');
    fx.advance(3_000);
    await p.core.writer.sweepRing();
    const recs = p.core.holds.nonTerminal().filter((r) => r.paths.includes(L));
    assert.deepEqual(recs.map((r) => [r.kind, r.residence, r.state, r.guards.length]), [['PATCH', 'OFF_DISK', 'PARKED', 0]], 'the ring PATCH');
    assert.equal(recs[0]!.local_only, false, 'its attributes were requested first: LIVE');
  } finally {
    await fx.cleanup();
  }
});

// ---- chain, batch, local.json, age --------------------------------------------------------------------------------------

test('commitMany writes several creations and transitions as one registry commit', T10, async () => {
  await withRegistry('reg-commit-many', async (c) => {
    const reg = await c.reg();
    const a = await reg.hold(nr({ paths: ['src/a.txt'], blobs: pair(await c.blob('a0\n'), await c.blob('a1\n'), 'src/a.txt') }));
    const b = await reg.hold(nr({ paths: ['src/b.txt'], blobs: pair(await c.blob('b0\n'), await c.blob('b1\n'), 'src/b.txt') }));
    const old = (await c.head())!;
    const hits: string[] = [];
    setCrashHandler((name) => hits.push(name));
    const ev0 = c.holdEvents().length;
    const res = await reg.commitMany(
      [
        nr({ paths: ['src/c.txt'], blobs: pair(await c.blob('c0\n'), await c.blob('c1\n'), 'src/c.txt') }),
        nr({ paths: ['src/d.txt'], residence: 'OFF_DISK', state: 'PARKED', guard: null, blobs: pair(await c.blob('d0\n'), await c.blob('d1\n'), 'src/d.txt') }),
      ],
      [{ id: a, patch: { residence: 'OFF_DISK', state: 'PARKED' } }, { id: b, patch: { state: 'CONFLICTED' } }],
    );
    const head = (await c.head())!;
    assert.deepEqual((await c.f.repo.readCommit(head)).parents, [old], 'one commit on top of the old head');
    assert.deepEqual(hits, ['registry.cas', 'registry.cas']);
    assert.equal(res.created.length, 2);
    assert.deepEqual(res.records.map((r) => r.id), [...res.created, a, b]);
    assert.equal(c.holdEvents().length - ev0, 4);
    assert.deepEqual(pick(reg.get(a)!), ['OFF_DISK', 'PARKED']);
    assert.equal(reg.get(b)!.state, 'CONFLICTED');
    // A refused entry writes nothing at all.
    await assert.rejects(reg.commitMany([nr({ paths: ['src/e.txt'], blobs: pair(await c.blob('e0\n'), await c.blob('e1\n'), 'src/e.txt') })], [{ id: b, patch: { residence: 'OFF_DISK', state: 'ACTIVE' } }]), TypeError);
    assert.equal(await c.head(), head);
    assert.equal(reg.all().length, 4);
  });
});

test('commitMany checks every patch as transition() does and keeps one change, one id', T10, async () => {
  await withRegistry('reg-commit-many-checks', async (c) => {
    const reg = await c.reg();
    const A0 = 'src/a.txt';
    const a0 = await c.blob('a0\n');
    const a1 = await c.blob('a1\n');
    const a = await reg.hold(nr({ paths: [A0], blobs: pair(a0, a1, A0) }));
    const head = await c.head();
    // A guard outside Table 3, or a Table 3 name with another class or owner, would freeze the record for good (HLD-05).
    const bad: HoldPatch[] = [
      { guards: [makeGuard('revert'), FROB] },
      { guards: [{ name: 'revert', class: 'PREDICATE', owner: 'HLD' }] },
      { guards: [{ name: 'join', class: 'DECISION', owner: 'XYZ' }] },
      { guards: [{ name: 'dependency:x', class: 'PREDICATE', owner: 'HLD' }] },
    ];
    for (const patch of bad) {
      await assert.rejects(reg.transition(a, patch), TypeError, `transition ${JSON.stringify(patch)}`);
      await assert.rejects(reg.commitMany([], [{ id: a, patch }]), TypeError, `commitMany ${JSON.stringify(patch)}`);
      assert.equal(await c.head(), head);
    }
    assert.deepEqual(names(reg.get(a)), ['revert']);
    // HLD-07: a creation that is an existing record's change, or another creation's in the same batch, is refused (the caller
    // uses hold(), which attaches); nothing is written. A is a's base, so a's H1' is its stored h1 (final review r2 D-1).
    c.A.set(A0, { path: A0, mode: '100644', oid: a0 });
    const other = (tag: string): NewRecord => nr({ paths: [`src/${tag}.txt`], blobs: pair(ABSENT, a1, `src/${tag}.txt`) });
    const dupes: Array<[string, NewRecord[]]> = [
      ['equal held side', [nr({ paths: [A0], blobs: pair(await c.blob('another base\n'), a1, A0), guard: 'join' })]],
      ['a stage call on a held path set (K4)', [nr({ paths: [A0], state: 'CONFLICTED', blobs: { s1: { [A0]: a0 }, s2: { [A0]: await c.blob('a mine\n') }, s3: { [A0]: await c.blob('a theirs\n') } }, guard: 'conflict' })]],
      ['two equal creations in one batch', [other('n1'), nr({ ...other('n1'), guard: 'join' })]],
      ['a guard-less exact twin', [nr({ ...other('n2'), residence: 'OFF_DISK', state: 'PARKED', guard: null }), nr({ ...other('n2'), residence: 'OFF_DISK', state: 'PARKED', guard: null })]],
    ];
    for (const [what, creates] of dupes) {
      await assert.rejects(reg.commitMany(creates, []), (e: unknown) => e instanceof TypeError && /one change, one id/.test(e.message), what);
      assert.equal(await c.head(), head, what);
    }
    // A REBASE-converging creation is refused too.
    c.A.set(P, { path: P, mode: '100644', oid: await c.blob(t9([8, 'eight'])) });
    const conv = await reg.hold(nr({ blobs: pair(await c.blob(T9), await c.blob(t9([2, 'two']))) }));
    const head2 = await c.head();
    await assert.rejects(reg.commitMany([nr({ blobs: pair(c.A.get(P)!.oid, await c.blob(t9([2, 'two'], [8, 'eight']))), guard: 'join' })], []),
      (e: unknown) => e instanceof TypeError && e.message.includes(conv));
    assert.equal(await c.head(), head2);
    // Marker companions are never duplicates: two companions of one parent with equal bytes are two records.
    const comp = nr({ paths: [A0], residence: 'OFF_DISK', state: 'PARKED', guard: null, companionOf: a, blobs: pair(a0, await c.blob('<<<<<<< cowork:disk\n'), A0) });
    const res = await reg.commitMany([comp, comp], []);
    assert.equal(new Set(res.created).size, 2);
  });
});

test('commitMany\'s one change, one id check reads the records as the batch\'s own patches leave them', T10, async () => {
  await withRegistry('reg-commit-many-post-patch', async (c) => {
    const reg = await c.reg();
    const A0 = 'src/a.txt';
    const B0 = 'src/b.txt';
    const a1 = await c.blob('a1\n');
    const a = await reg.hold(nr({ paths: [A0], blobs: pair(await c.blob('a0\n'), a1, A0) }));
    const b = await reg.hold(nr({ paths: [B0], blobs: pair(await c.blob('b0\n'), await c.blob('b1\n'), B0) }));
    // a ends in this batch (GONE): a creation holding a's former held side is a new change, not a's.
    const res = await reg.commitMany([nr({ paths: [A0], blobs: pair(await c.blob('a base 2\n'), a1, A0), guard: 'join' })], [{ id: a, patch: { state: 'GONE' } }]);
    assert.equal(res.created.length, 1);
    assert.notEqual(res.created[0], a);
    assert.equal(reg.get(a)!.state, 'GONE');
    // b's held side becomes Y in this batch: a creation holding Y over b's paths is b's change (refused; nothing written). A is b's
    // base, so b's H1' is the batch's Y (HLD-07 compares with H1'; final review r2 D-1).
    c.A.set(B0, { path: B0, mode: '100644', oid: await c.blob('b0\n') });
    const Y = await c.blob('b held by the batch\n');
    const head = await c.head();
    await assert.rejects(
      reg.commitMany([nr({ paths: [B0], blobs: pair(await c.blob('b other base\n'), Y, B0), guard: 'join' })], [{ id: b, patch: { blobs: pair(await c.blob('b0\n'), Y, B0) } }]),
      (e: unknown) => e instanceof TypeError && /one change, one id/.test(e.message) && e.message.includes(b),
    );
    assert.equal(await c.head(), head);
    assert.deepEqual(reg.get(b)!.blobs, pair(await c.blob('b0\n'), await c.blob('b1\n'), B0), 'b unchanged');
  });
});

test('local.json keeps companions, explicit, rejected and inflight across load()', T10, async () => {
  await withRegistry('reg-local-json', async (c) => {
    const reg = await c.reg();
    const base = await reg.hold(nr({ blobs: pair(await c.blob(T9), await c.blob(t9([2, 'base']))), guard: 'markers' }));
    const plan2Tree = (await c.f.repo.readCommit((await c.head())!)).tree;
    assert.equal(await c.f.repo.resolve(`${plan2Tree}:local.json`), null, 'nothing to keep: no local.json');
    assert.deepEqual(reg.local(), { companions: {}, explicit: [], rejected: {}, inflight: {}, keepSyncing: [], copies: {} });
    const comp = await reg.hold(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, companionOf: base, blobs: pair(await c.blob(T9), await c.blob(t9([2, 'comp']))) }));
    const a = await reg.hold(nr({ paths: ['src/a.txt'], blobs: pair(await c.blob('a0\n'), await c.blob('a1\n'), 'src/a.txt') }));
    const b = await reg.hold(nr({ paths: ['src/b.txt'], blobs: pair(await c.blob('b0\n'), await c.blob('b1\n'), 'src/b.txt') }));
    const cc = await reg.hold(nr({ paths: ['src/c.txt'], blobs: pair(await c.blob('c0\n'), await c.blob('c1\n'), 'src/c.txt') }));
    const revs = (): number[] => reg.all().map((r) => r.rev);
    const before = revs();
    const n0 = await commitCount(c);
    await reg.markExplicit(a);
    await reg.markMirrorRejected(b, 'k1', 'validator');
    const park: InflightOp = { op: 'park', entries: [{ path: 'src/c.txt', expected: await c.blob('c1\n'), target: await c.blob('c0\n') }], final: { residence: 'OFF_DISK', state: 'PARKED' }, explicit: false };
    await reg.commitMany([], [], { setInflight: { [cc]: park } });
    const mid = reg.local();
    assert.deepEqual(mid.rejected, { [b]: { key: 'k1', reason: 'validator' } });
    await reg.clearMirrorRejected(b);
    assert.equal(await commitCount(c), n0 + 4, 'one commit each');
    assert.deepEqual(revs(), before, 'no record rev change');
    const want = { companions: { [comp]: base }, explicit: [a], rejected: {}, inflight: { [cc]: park }, keepSyncing: [], copies: {} };
    assert.deepEqual(reg.local(), want);
    const fresh = await c.reg('fresh');
    assert.deepEqual(fresh.local(), want);
    const tree = (await c.f.repo.readCommit((await c.head())!)).tree;
    const ls = (await c.f.repo.run(['ls-tree', '-z', tree])).stdout.toString('utf8').split(NUL).filter((x) => x.length > 0).map((x) => x.slice(x.indexOf(TAB) + 1));
    assert.deepEqual(ls, ['blobs', 'local.json', 'records'], 'at the tree root next to records/ and blobs/');
    const bytes = await c.f.repo.readBlob((await c.f.repo.resolve(`${tree}:local.json`))!);
    assert.ok(canonicalBytes(JSON.parse(bytes.toString('utf8')) as Json).equals(bytes), 'canonical JSON');
    // A Plan 2 registry tree without local.json loads with an empty local().
    const plan2 = await c.f.repo.commitTree({ tree: plan2Tree, parents: [], subject: 'cowork-holds', trailers: [] });
    const ref2 = 'refs/cowork-local/plan2/holds';
    assert.equal(await c.f.repo.casRef(ref2, plan2, null, 'cowork-holds'), true);
    const old = new HoldRegistry({ ...c.deps('plan2'), ref: ref2 });
    await old.load();
    assert.deepEqual(old.local(), { companions: {}, explicit: [], rejected: {}, inflight: {}, keepSyncing: [], copies: {} });
    assert.equal(old.all().length, 1);
  });
});

test('final review r2 A-2: a settle copy is marked in local.json settleCopies by its birth commit, the mark survives load(), and the emptied map leaves local.json', T10, async () => {
  await withRegistry('reg-settle-copies', async (c) => {
    const reg = await c.reg();
    const parent = await reg.hold(nr({ blobs: pair(await c.blob(T9), await c.blob(t9([2, 'parent']))) }));
    const copyOf = async (): Promise<NewRecord> => nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, settleCopyOf: parent, blobs: pair(await c.blob(T9), await c.blob(t9([2, 'parent']))) });
    const n0 = await commitCount(c);
    const copy = await reg.hold(await copyOf());
    assert.equal(await commitCount(c), n0 + 1, 'the record and its mark in one commit');
    assert.deepEqual(reg.local().settleCopies, { [copy]: parent });
    assert.deepEqual([reg.isSettleCopy(copy), reg.isSettleCopy(parent)], [true, false]);
    const fresh = await c.reg('fresh');
    assert.deepEqual(fresh.local().settleCopies, { [copy]: parent }, 'durable across load()');
    // A repeat of the settlement attaches to the first copy (HLD-07's guard-less dedupe) and keeps the one mark.
    const again = await fresh.holdOutcome(await copyOf());
    assert.deepEqual([again.id, again.created, fresh.local().settleCopies], [copy, false, { [copy]: parent }]);
    await assert.rejects(fresh.commitMany([await copyOf()], []), (e: unknown) => e instanceof TypeError && /settle copy/.test(e.message));
    await assert.rejects(fresh.hold({ ...(await copyOf()), settleCopyOf: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }), (e: unknown) => e instanceof TypeError && /settleCopyOf/.test(e.message));
    await fresh.markExplicit(parent);   // something else for local.json to keep
    await fresh.commitMany([], [], { clearSettleCopies: [copy] });
    assert.deepEqual(fresh.local(), { companions: {}, explicit: [parent], rejected: {}, inflight: {}, keepSyncing: [], copies: {} }, 'an emptied map is dropped (one shape with a registry that never copied)');
    assert.equal(fresh.isSettleCopy(copy), false);
    const tree = (await c.f.repo.readCommit((await c.head())!)).tree;
    const bytes = await c.f.repo.readBlob((await c.f.repo.resolve(`${tree}:local.json`))!);
    assert.equal(Object.hasOwn(JSON.parse(bytes.toString('utf8')) as object, 'settleCopies'), false, 'local.json leaves the empty key out');
    assert.equal('settleCopies' in (await c.reg('again')).local(), false);
  });
});

test('E16-E: a restore\'s writes are kept in local.json `restored` (durable across load(), their written blobs under blobs/) until the commit that moves the record off the disk or ends it; an unknown record is refused', T10, async () => {
  await withRegistry('reg-restored', async (c) => {
    const reg = await c.reg();
    const written = await c.blob(t9([2, 'restored'], [5, 'cowork:disk']));
    const snap = await c.blob(T9);
    const id = await reg.hold(nr({ blobs: pair(snap, await c.blob(t9([2, 'restored']))) }));
    const other = await reg.hold(nr({ paths: ['src/o.txt'], blobs: pair(snap, await c.blob(t9([3, 'other'])), 'src/o.txt') }));
    const ws = [{ path: P, written, snap }];
    await assert.rejects(reg.commitMany([], [], { setRestored: { '01ARZ3NDEKTSV4RRFFQ69G5FAV': ws } }), (e: unknown) => e instanceof TypeError && /restored names unknown record/.test(e.message));
    await reg.commitMany([], [], { setRestored: { [id]: ws, [other]: [{ path: 'src/o.txt', written: ABSENT, snap }] } });
    assert.deepEqual(reg.local().restored, { [id]: ws, [other]: [{ path: 'src/o.txt', written: ABSENT, snap }] });
    const blobsOf = async (): Promise<string[]> => (await c.f.repo.run(['ls-tree', '--name-only', '-z', `${(await c.head())!}:blobs`])).stdout.toString('utf8').split(NUL).filter((x) => x.length > 0);
    assert.ok((await blobsOf()).includes(written), 'blobs/ names the written blob (gc keeps it: R3-EF4-13 judges a later delta from it)');
    const fresh = await c.reg('fresh');
    assert.deepEqual(fresh.local().restored, reg.local().restored, 'durable across load()');
    // An ON_DISK transition keeps the entry; moving the record off the disk drops it in that same commit.
    await fresh.transition(id, { state: 'CONFLICTED' });
    assert.deepEqual(Object.keys(fresh.local().restored ?? {}).sort(), [id, other].sort());
    await fresh.transition(id, { residence: 'OFF_DISK', state: 'PARKED' });
    assert.deepEqual(fresh.local().restored, { [other]: [{ path: 'src/o.txt', written: ABSENT, snap }] }, 'off the disk: no restore write to re-seed');
    assert.equal((await blobsOf()).includes(written), false, 'blobs/ no longer names the written blob');
    // An ended record drops its entry too; the emptied map leaves local.json (one shape with a registry that never restored).
    await fresh.transition(other, { state: 'GONE' });
    assert.equal('restored' in fresh.local(), false);
    assert.equal('restored' in (await c.reg('again')).local(), false);
  });
});

test('R3-EF4-30: local.json `restored` keeps one entry per path, the newest write wins — a restore\'s setRestored removes its paths from every other id\'s list and drops an id whose list empties, in the same commit (the next load() parses it)', T10, async () => {
  await withRegistry('reg-restored-newest', async (c) => {
    const reg = await c.reg();
    const O = 'src/o.txt';
    const snap = await c.blob(T9);
    const two = await reg.hold(nr({ paths: [P, O], blobs: { h0: { [P]: snap, [O]: snap }, h1: { [P]: await c.blob(t9([2, 'two p'])), [O]: await c.blob(t9([2, 'two o'])) } } }));
    const onP = await reg.hold(nr({ blobs: pair(snap, await c.blob(t9([3, 'three p']))) }));
    const onO = await reg.hold(nr({ paths: [O], blobs: pair(snap, await c.blob(t9([4, 'four o'])), O) }));
    const w = async (s: string): Promise<Oid> => c.blob(t9([5, s]));
    const first = [{ path: P, written: await w('first p'), snap }, { path: O, written: await w('first o'), snap }];
    await reg.commitMany([], [], { setRestored: { [two]: first } });
    // A later restore of P alone: P leaves `two`'s list, O stays there.
    const atP = [{ path: P, written: await w('second p'), snap }];
    await reg.commitMany([], [], { setRestored: { [onP]: atP } });
    assert.deepEqual(reg.local().restored, { [two]: [first[1]], [onP]: atP });
    // A later restore of O: `two`'s list empties, so `two` leaves the map.
    const atO = [{ path: O, written: await w('third o'), snap }];
    await reg.commitMany([], [], { setRestored: { [onO]: atO } });
    assert.deepEqual(reg.local().restored, { [onP]: atP, [onO]: atO });
    assert.deepEqual((await c.reg('fresh')).local().restored, reg.local().restored, 'the next load() parses it (no emptied list)');
    // The same record restored again replaces its own list; nothing else changes.
    const again = [{ path: P, written: await w('fourth p'), snap }];
    await reg.commitMany([], [], { setRestored: { [onP]: again } });
    assert.deepEqual(reg.local().restored, { [onP]: again, [onO]: atO });
  });
});

test('final review r3 A3-1: a settle copy never attaches to the record it settles nor to any ON_DISK twin; a repeat attaches to the OFF_DISK copy made first', T10, async () => {
  await withRegistry('reg-settle-not-self', async (c) => {
    const reg = await c.reg();
    const t = await c.blob(T9);
    const da = await c.blob(t9([2, 'removed by the park']));
    // A guard-less ON_DISK PATCH holding Da (its guards released as --publish does, R3-17): HLD-07's guard-less twin of any birth h1 = Da.
    const parent = await reg.hold(nr({ blobs: pair(t, da) }));
    await reg.transition(parent, { guards: [] });
    const pin = await reg.hold(nr({ kind: 'PIN', guard: 'join', blobs: pair(t, t) }));
    // Any other guard-less birth keeps Plan 2's exact dedupe, ON_DISK twins included.
    const plain = await reg.holdOutcome(nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, blobs: pair(t, da) }));
    assert.deepEqual([plain.id, plain.created], [parent, false]);
    const copyOf = (of: string): NewRecord => nr({ residence: 'OFF_DISK', state: 'PARKED', guard: null, settleCopyOf: of, blobs: pair(t, da) });
    const first = await reg.holdOutcome(copyOf(pin));
    assert.deepEqual([first.created, first.id === parent], [true, false], 'the ON_DISK twin is skipped: a new copy');
    const own = await reg.holdOutcome(copyOf(parent));
    assert.deepEqual([own.id, own.created], [first.id, false], 'never its own parent: the OFF_DISK copy is the match');
    const again = await reg.holdOutcome(copyOf(pin));
    assert.deepEqual([again.id, again.created], [first.id, false], 'a repeat attaches to the first copy');
    assert.deepEqual(reg.local().settleCopies, { [first.id]: pin }, 'one copy, one mark');
    assert.deepEqual([reg.get(parent)!.residence, reg.get(parent)!.rev], ['ON_DISK', 2], 'the parent is untouched');
  });
});

test('final review r3 A3-4: a settle copy carrying `revert` never attaches to its ON_DISK revert parent by the converging rule; its repeat attaches to the first copy', T10, async () => {
  await withRegistry('reg-settle-revert', async (c) => {
    const reg = await c.reg();
    const t = await c.blob(T9);
    const da = await c.blob(t9([5, 'a teammate line removed']));
    const parent = await reg.hold(nr({ state: 'CONFLICTED', blobs: pair(t, da) }));   // ON_DISK, guard revert, h1 = Da
    const copyOf = (): NewRecord => nr({ residence: 'OFF_DISK', state: 'PARKED', guard: 'revert', settleCopyOf: parent, blobs: pair(t, da) });
    const first = await reg.holdOutcome(copyOf());
    assert.deepEqual([first.created, first.id === parent], [true, false], 'a new copy, not the parent');
    assert.deepEqual([names(reg.get(first.id)), reg.get(first.id)!.residence, reg.get(first.id)!.state], [['revert'], 'OFF_DISK', 'PARKED']);
    const again = await reg.holdOutcome(copyOf());
    assert.deepEqual([again.id, again.created, again.attachedGuard], [first.id, false, null], 'a repeat attaches to the first copy');
    assert.equal(reg.get(first.id)!.rev, 1, 'with nothing to change');
    assert.deepEqual(reg.local().settleCopies, { [first.id]: parent });
  });
});

test("final review r3 A3-3: a park's in-flight entry carries its whole decision across load(); `whole` on another op or not a boolean is refused; an entry without it still loads", T10, async () => {
  await withRegistry('reg-inflight-whole', async (c) => {
    const reg = await c.reg();
    const held = await c.blob(t9([2, 'whole']));
    const id = await reg.hold(nr({ blobs: pair(await c.blob(T9), held) }));
    const older: InflightOp = { op: 'park', entries: [{ path: P, expected: held, target: await c.blob(T9) }], final: { residence: 'OFF_DISK', state: 'PARKED' }, explicit: false };
    for (const whole of [true, false]) {
      const op: InflightOp = { ...older, whole };
      await reg.commitMany([], [], { setInflight: { [id]: op } });
      assert.deepEqual((await c.reg(`fresh-${whole}`)).local().inflight, { [id]: op }, `whole: ${whole} survives load()`);
    }
    const bad = (op: unknown): Promise<unknown> => reg.commitMany([], [], { setInflight: { [id]: op as InflightOp } });
    await assert.rejects(bad({ ...older, op: 'restore', whole: true }), (e: unknown) => e instanceof TypeError && /\.whole/.test(e.message), 'only a park carries it');
    await assert.rejects(bad({ ...older, whole: 'yes' }), (e: unknown) => e instanceof TypeError && /\.whole/.test(e.message), 'a boolean');
    await reg.commitMany([], [], { setInflight: { [id]: older } });
    assert.deepEqual((await c.reg('fresh-older')).local().inflight, { [id]: older }, 'an entry written before the field');
  });
});

test('every registry transition is a new commit and the ref moves only by CAS with a reflog', T10, async () => {
  await withRegistry('reg-chain', async (c) => {
    const reg = await c.reg();
    const id = await reg.hold(nr({ blobs: pair(await c.blob(T9), await c.blob(t9([2, 'chain']))) }));
    await reg.transition(id, { state: 'CONFLICTED' });
    await reg.commitMany([nr({ paths: ['src/z.txt'], blobs: pair(await c.blob('z0\n'), await c.blob('z1\n'), 'src/z.txt') })], []);
    c.clock.advance(5_000);
    assert.equal(await reg.flushAgeAnchors(), 2);
    await reg.markExplicit(id);
    assert.equal(await commitCount(c), 5);
    const reflog = (await c.f.repo.run(['reflog', 'show', '--format=%H %gs', c.ref])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
    assert.equal(reflog.length, 5);
    assert.ok(reflog.every((l) => l.endsWith(' cowork-holds')));
    assert.deepEqual(await c.f.repo.listRefs('refs/worktree/'), []);
    // A CAS lost to a planted second writer.
    const other = await c.reg('other');
    await other.hold(nr({ paths: ['src/w.txt'], blobs: pair(await c.blob('w0\n'), await c.blob('w1\n'), 'src/w.txt') }));
    await assert.rejects(reg.transition(id, { state: 'CONFLICTED' }), RegistryCasLostError);
    assert.equal(c.logs.at(-1)!.level, 'security');
  });
});

test('every blob any rev named survives git gc --prune=now', T10, async () => {
  await withRegistry('reg-gc', async (c) => {
    const reg = await c.reg();
    const h0 = await c.blob('gc base only\n');
    const named: Oid[] = [await c.blob('gc held 0\n')];
    const id = await reg.hold(nr({ paths: ['gc/x.txt'], blobs: pair(h0, named[0]!, 'gc/x.txt') }));
    for (let i = 1; i <= 5; i++) {
      named.push(await c.blob(`gc held ${i}\n`));
      await reg.transition(id, { blobs: pair(h0, named[i]!, 'gc/x.txt') });
    }
    const chain = await c.f.repo.firstParents((await c.head())!, null, 100);
    const recordBlobs: Oid[] = [];
    for (const commit of chain) recordBlobs.push((await c.f.repo.resolve(`${commit}:records/${id}.json`))!);
    const env = { ...process.env, LC_ALL: 'C' };
    const gc = spawnSync('git', ['gc', '--prune=now', '--quiet'], { cwd: c.f.paths.workTree, encoding: 'utf8', env });
    assert.equal(gc.status, 0, gc.stderr);
    for (const o of [h0, ...named, ...recordBlobs]) {
      assert.equal(spawnSync('git', ['cat-file', '-e', o], { cwd: c.f.paths.workTree, env }).status, 0, `${o} survives gc`);
    }
    assert.equal(recordBlobs.length, 6);
  });
});

test('ageMs is max(Δwall, mono_accum + Δmono) and restarts on (re)entering ON_DISK', T10, async () => {
  await withRegistry('reg-age', async (c) => {
    const clock = new VirtualClock({ startMono: 0 });
    const W = clock.wallMs();
    const reg = await c.reg('age', clock);
    const id = await reg.hold(nr({ blobs: pair(await c.blob(T9), await c.blob(t9([2, 'age']))) }));
    assert.equal(reg.get(id)!.age_anchor.anchor_wall_ms, W);
    clock.advance(30_000);
    assert.equal(reg.ageMs(reg.get(id)!), 30_000);
    clock.advance(10_000);
    const t = await reg.transition(id, { state: 'CONFLICTED' });
    assert.deepEqual(t.age_anchor, { since_rev: 1, anchor_wall_ms: W, mono_accum_ms: 40_000 });
    // A restart: a new registry with wall W + 60 s and mono 0.
    const later = new VirtualClock({ wallOffsetMs: 60_000, startMono: 0 });
    const back = await c.reg('age2', later);
    assert.equal(back.ageMs(back.get(id)!), 60_000);
    const skewed = new VirtualClock({ wallOffsetMs: -3_600_000, startMono: 0 });
    const behind = await c.reg('age3', skewed);
    assert.equal(behind.ageMs(behind.get(id)!), 40_000, 'INV-CLOCK: a wall clock moved back never lowers the age below the persisted Δmono');
    // OFF_DISK → ON_DISK at rev n restarts the age.
    later.advance(5_000);
    await back.transition(id, { residence: 'OFF_DISK' });
    later.advance(7_000);
    const on = await back.transition(id, { residence: 'ON_DISK' });
    assert.deepEqual(on.age_anchor, { since_rev: on.rev, anchor_wall_ms: later.wallMs(), mono_accum_ms: 0 });
    assert.equal(back.ageMs(on), 0);
  });
});

test('flushAgeAnchors re-persists accumulated Δmono in one commit', T10, async () => {
  await withRegistry('reg-flush', async (c) => {
    const reg = await c.reg();
    const a = await reg.hold(nr({ paths: ['src/a.txt'], blobs: pair(await c.blob('a0\n'), await c.blob('a1\n'), 'src/a.txt') }));
    const b = await reg.hold(nr({ paths: ['src/b.txt'], blobs: pair(await c.blob('b0\n'), await c.blob('b1\n'), 'src/b.txt') }));
    const t = await reg.hold(nr({ paths: ['src/t.txt'], blobs: pair(await c.blob('t0\n'), await c.blob('t1\n'), 'src/t.txt') }));
    await reg.transition(t, { state: 'GONE' });
    c.clock.advance(50_000);
    const n0 = await commitCount(c);
    const ev0 = c.events.length;
    assert.equal(await reg.flushAgeAnchors(), 2);
    assert.equal(await commitCount(c), n0 + 1);
    for (const id of [a, b]) {
      assert.equal(reg.get(id)!.rev, 2);
      assert.equal(reg.get(id)!.age_anchor.mono_accum_ms, 50_000);
    }
    assert.equal(reg.get(t)!.rev, 2, 'a terminal record is not re-persisted');
    assert.equal(c.events.length, ev0, 'an age flush is no transition: no hold event');
    assert.equal(await reg.flushAgeAnchors(), 0);
    assert.equal(await commitCount(c), n0 + 1, 'nothing written');
  });
});

test('every creation and transition emits the widened hold trace event', T10, async () => {
  await withRegistry('reg-trace', async (c) => {
    const reg = await c.reg();
    const id = await reg.hold(nr({ kind: 'INCOMING', guard: 'lock', paths: ['src/in.txt'], blobs: pair(await c.blob('in0\n'), await c.blob('in1\n'), 'src/in.txt') }));
    assert.deepEqual(c.holdEvents().at(-1), {
      kind: 'hold', peer: PEER, id, holdKind: 'INCOMING', guard: 'lock', guards: ['lock'], paths: ['src/in.txt'], residence: 'ON_DISK', state: 'ACTIVE', rev: 1, localOnly: false,
    });
    await reg.addGuard(id, 'collision');
    assert.deepEqual(c.holdEvents().at(-1)!.guards, ['lock', 'collision']);
    await reg.releaseGuard(id, 'lock');
    await reg.releaseGuard(id, 'collision');
    assert.equal(c.holdEvents().at(-1)!.guard, '', 'the first guard, or \'\'');
    await reg.transition(id, { state: 'SUBSUMED' });
    assert.deepEqual(c.holdEvents().at(-1), {
      kind: 'hold', peer: PEER, id, holdKind: 'INCOMING', guard: '', guards: [], paths: ['src/in.txt'], residence: null, state: 'SUBSUMED', rev: 5, localOnly: false,
    });
    assert.equal(c.holdEvents().filter((e) => e.id === id).length, 5);
  });
});

test('Plan 2 hold call sites keep working with the widened registry', T10, async () => {
  // The exact NewRecord shapes of Plan 2's call sites (apply.ts and publish.ts K4, core.ts onPhantom and onLateWrite,
  // publish.ts enterNonretryable, restart.ts restartRecord, start.ts pinLocalWork, the eol-bom record), each still passing its
  // own local_only, which the registry now ignores and recomputes (R3-12). End to end they run in apply.test.ts,
  // apply.bomcrlf.test.ts, publish.test.ts, publish.race.test.ts, publish.rejections.test.ts, writer.test.ts, diskEq.test.ts,
  // restart.test.ts and start.test.ts.
  await withRegistry('reg-plan2-sites', async (c) => {
    const reg = await c.reg();
    const b = async (s: string): Promise<Oid> => c.blob(s);
    const stages = async (p: string): Promise<HoldBlobs> => ({ s1: { [p]: await b(`${p} base\n`) }, s2: { [p]: await b(`${p} local\n`) }, s3: { [p]: await b(`${p} tip\n`) } });
    const daemon = { origin: 'daemon', cs_ids: [] as string[], displaced_by: null };
    const k4Apply = await reg.hold({ kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: ['src/k.txt'], blobs: await stages('src/k.txt'), guard: 'conflict', ...daemon, cs_ids: [`${PEER}/human/2`], local_only: true });
    assert.equal(reg.get(k4Apply)!.local_only, false, 'a LIVE path: recomputed, not the passed value');
    assert.deepEqual(pick(await reg.transition(k4Apply, { residence: 'OFF_DISK' })), ['OFF_DISK', 'CONFLICTED'], 'R-02: OFF_DISK after the verified TIP write');
    const k4Publish = await reg.hold({ kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: ['.env'], blobs: await stages('.env'), guard: 'conflict', ...daemon, local_only: false });
    assert.equal(reg.get(k4Publish)!.local_only, true, 'a secret-like path: local_only whatever the caller passed');
    const phantom = await reg.hold({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/ph.txt'], blobs: pair(await b('ph a\n'), await b('ph target\n'), 'src/ph.txt'), guard: 'phantom', ...daemon, local_only: false });
    const late = await reg.hold({ kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: ['src/late.txt'], blobs: pair(await b('late s\n'), await b('late bytes\n'), 'src/late.txt'), guard: null, ...daemon, local_only: false });
    const reject = await reg.hold({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/r.txt'], blobs: pair(await b('r a\n'), await b('r p\n'), 'src/r.txt'), guard: 'host-reject', ...daemon, cs_ids: [`${PEER}/human/4`], local_only: false });
    const pathless = await reg.hold({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: [], blobs: { h0: {}, h1: {} }, guard: 'host-reject', ...daemon, local_only: false });
    const restart = await reg.hold({ kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/rs.txt'], blobs: pair(ABSENT, await b('rs held\n'), 'src/rs.txt'), guard: 'restart', ...daemon, local_only: false });
    const join = await reg.hold({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['new.txt', 'src/j.txt'], blobs: { h0: { 'new.txt': ABSENT, 'src/j.txt': await b('j a\n') }, h1: { 'new.txt': await b('new\n'), 'src/j.txt': await b('j local\n') } }, guard: 'join', origin: 'human', cs_ids: [], displaced_by: null, local_only: false });
    const eol = await reg.hold({ kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['settings.ini'], blobs: pair(await b('key=0\n'), await b('key=1\r\n'), 'settings.ini'), guard: 'eol-bom', origin: 'human', cs_ids: [], displaced_by: null, local_only: false });
    const want: Array<[string, string | null]> = [[phantom, 'phantom'], [late, null], [reject, 'host-reject'], [pathless, 'host-reject'], [restart, 'restart'], [join, 'join'], [eol, 'eol-bom']];
    for (const [id, g] of want) {
      const r = reg.get(id)!;
      assert.deepEqual(r.guards, g === null ? [] : [makeGuard(g)], g ?? 'late write');
      assert.equal(r.local_only, false);
    }
    assert.equal(new Set([k4Apply, k4Publish, ...want.map(([id]) => id)]).size, 9, 'nine distinct records');
    assert.deepEqual(reg.maskingRecords().map((r) => r.id).sort(), [k4Apply, k4Publish, phantom, reject, pathless, restart, join, eol].sort());
  });
});

// ---- queries ------------------------------------------------------------------------------------------------------------

function isDeeplyFrozen(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return true;
  return Object.isFrozen(v) && Object.values(v as Record<string, unknown>).every(isDeeplyFrozen);
}

test('byPath, companionsOf, isCompanion, local and head', T10, async () => {
  await withRegistry('reg-queries', async (c) => {
    const reg = await c.reg();
    const A = 'src/a.txt';
    const r1 = await reg.hold(nr({ paths: [A], blobs: pair(await c.blob('a0\n'), await c.blob('a1\n'), A), guard: 'markers' }));
    const r2 = await reg.hold(nr({ kind: 'PIN', paths: [A, 'src/b.txt'], blobs: { h0: { [A]: ABSENT, 'src/b.txt': ABSENT }, h1: { [A]: await c.blob('a2\n'), 'src/b.txt': await c.blob('b2\n') } }, guard: 'join' }));
    const r3 = await reg.hold(nr({ paths: [A], blobs: pair(await c.blob('a0\n'), await c.blob('a3\n'), A) }));
    const comp = await reg.hold(nr({ paths: [A], residence: 'OFF_DISK', state: 'PARKED', guard: null, companionOf: r1, blobs: pair(await c.blob('a0\n'), await c.blob('a marks\n'), A) }));
    await reg.transition(r3, { state: 'GONE' });
    assert.deepEqual(reg.byPath(A).map((r) => r.id), [r1, r2, comp].sort(), 'non-terminal records naming the path, ULID order');
    assert.deepEqual(reg.byPath('src/b.txt').map((r) => r.id), [r2]);
    assert.deepEqual(reg.byPath('src/none.txt'), []);
    assert.deepEqual(reg.companionsOf(r1).map((r) => r.id), [comp]);
    assert.deepEqual(reg.companionsOf(r2), []);
    assert.equal(reg.isCompanion(comp), true);
    for (const id of [r1, r2, r3]) assert.equal(reg.isCompanion(id), false);
    assert.equal(reg.head(), await c.head());
    for (const r of [...reg.byPath(A), ...reg.companionsOf(r1)]) assert.ok(isDeeplyFrozen(r), r.id);
    assert.ok(isDeeplyFrozen(reg.local()));
  });
});

test('the save-view facts come from registry queries', T10, async () => {
  await withRegistry('reg-save-view', async (c) => {
    const reg = await c.reg();
    const on = await reg.hold(nr({ paths: ['src/on.txt'], blobs: pair(await c.blob('on0\n'), await c.blob('on1\n'), 'src/on.txt'), guard: 'join', kind: 'PIN' }));
    const off = await reg.hold(nr({ paths: ['src/off.txt'], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(await c.blob('off0\n'), await c.blob('off1\n'), 'src/off.txt') }));
    const gone = await reg.hold(nr({ paths: ['src/gone.txt'], blobs: pair(await c.blob('g0\n'), await c.blob('g1\n'), 'src/gone.txt') }));
    await reg.transition(gone, { state: 'GONE' });
    const head = await c.head();
    const facts = (residence: 'ON_DISK' | 'OFF_DISK'): Array<{ id: string; kind: string; paths: string[]; guards: string[]; origin: string }> =>
      reg.nonTerminal().filter((r) => r.residence === residence).map((r) => ({ id: r.id, kind: r.kind, paths: [...r.paths], guards: r.guards.map(guardName), origin: r.origin }));
    assert.deepEqual(facts('ON_DISK'), [{ id: on, kind: 'PIN', paths: ['src/on.txt'], guards: ['join'], origin: 'human' }]);
    assert.deepEqual(facts('OFF_DISK'), [{ id: off, kind: 'PATCH', paths: ['src/off.txt'], guards: ['revert'], origin: 'human' }]);
    reg.all(); reg.byPath('src/on.txt'); reg.local(); reg.head(); reg.maskingRecords(); reg.companionsOf(on); reg.isCompanion(on); reg.ageMs(reg.get(on)!);
    assert.equal(await c.head(), head, 'no query writes a commit');
  });
});
