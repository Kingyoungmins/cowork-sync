// The `holds` profile end to end (Plan 3 Task 13; 11-testing §3.3, TST-02, TST-03, TC-TST-01; rulings R3-47, R3-55, R3-58): the smoke
// seed through Plan 2's six exit oracles, and determinism of two runs of one seed. Real git against file:// bare remotes. A failed run
// keeps its temp root and artifacts (okOrFail names them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { TraceEvent } from '../../src/ports/trace.js';
import { testRunner } from '../helpers/tmp.js';
import { enginePlatformOf } from '../sim/engineAdapter.js';
import { HOLDS_EDIT_KINDS, HOLDS_FAULT_KINDS, HOLDS_PEER_PROFILE, holdsSetup, PROFILES } from '../sim/generators.js';
import { DEFAULT_QUIESCENCE, holdTimersSettled, runSim, type Oracle, type SimContext, type SimResult } from '../sim/harness.js';
import { readRegistry } from '../sim/holdsView.js';
import { exitOracles } from '../sim/oracles.js';

function okOrFail(r: SimResult): void {
  assert.ok(r.ok, `run failed: ${JSON.stringify(r.failure)}; artifacts kept in ${String(r.artifactsDir)}; op-log tail ${JSON.stringify(r.opLog.slice(-8))}`);
}

/** Captures the run's SimContext and computes `at(ctx)` at quiescence, while the temp root still exists. */
function capture<T>(at: (ctx: SimContext) => Promise<T>): Oracle & { ctx: SimContext | null; value: T | null } {
  const o: Oracle & { ctx: SimContext | null; value: T | null } = {
    name: 'CAPTURE', ctx: null, value: null,
    async atQuiescence(ctx) {
      o.ctx = ctx;
      o.value = await at(ctx);
      return null;
    },
  };
  return o;
}

/** What the harness and the engine adapter log besides the generated ops. */
const HARNESS_KINDS: ReadonlySet<string> = new Set(['step', 'round', 'start', 'start_refused', 'killed', 'crash_armed', 'crash_disarmed', 'heal']);
const CATALOGUE: ReadonlySet<string> = new Set<string>([...HOLDS_EDIT_KINDS, ...HOLDS_FAULT_KINDS]);

test('holdsSetup(\'holds-smoke-0\') runs 3 peers (p1 core.autocrlf=true, p2 EngineDeps.platform win32), 60 steps with crash rate 0.02, reaches quiescence (K = 20 then 40 loops) and passes Plan 2\'s six exit oracles; its op-log names only holds catalogue kinds; the test prints its wall time, and the implementer records in the ledger that time and the wall time of a `TEST_SIM_FULL=1` 20-seed `holdsSetup` loop (`holds-time-0…19`) on their OS (the per-OS PR-leg p50/p95 that sizes the exit shards is Task 16\'s, R3-58)', { timeout: 40 * 60_000 }, async (t) => {
  const s = holdsSetup('holds-smoke-0');
  assert.deepEqual(s.tuple, { seed: 'holds-smoke-0', peers: 3, ops: PROFILES.holds.steps });
  assert.equal(s.tuple.ops, 60);
  assert.deepEqual(s.options.crash, { rate: 0.02 });
  assert.deepEqual(s.options.quiescence, DEFAULT_QUIESCENCE);
  assert.deepEqual([DEFAULT_QUIESCENCE.k, DEFAULT_QUIESCENCE.extraLoops], [20, 40]);
  assert.equal(s.options.peerProfile, HOLDS_PEER_PROFILE);
  assert.equal(s.options.settled, holdTimersSettled);
  const shape = capture(async (ctx) => {
    const git = testRunner();
    const autocrlf = await Promise.all(ctx.peers.map(async (p) => (await git.run(['config', '--get', 'core.autocrlf'], { class: 'local', cwd: p.dir })).stdout.toString('utf8').trim()));
    return { autocrlf, platforms: ctx.engines.map((e) => enginePlatformOf(e)) };
  });
  const started = performance.now();
  const r = await runSim(s.tuple, s.factory, [...exitOracles(), shape], s.options);
  const wallMs = Math.round(performance.now() - started);
  t.diagnostic(`holds-smoke-0 wall time ${wallMs} ms (${process.platform}, node ${process.version})`);
  okOrFail(r);
  assert.ok(r.quiescence?.reached, 'T* reached');
  assert.equal(r.quiescence?.pushAttemptsInExtra, 0);
  assert.deepEqual(shape.value?.autocrlf, ['false', 'true', 'false']);
  assert.deepEqual(shape.value?.platforms, [process.platform, process.platform, 'win32']);
  const kinds = new Set(r.opLog.map((e) => e.kind));
  for (const k of kinds) assert.ok(CATALOGUE.has(k) || HARNESS_KINDS.has(k), `op-log kind ${k} is a holds catalogue kind`);
  assert.ok([...kinds].filter((k) => CATALOGUE.has(k)).length >= 10, `the run drew the catalogue: ${[...kinds].join(', ')}`);
});

/** R3-55: the multi-seed form runs only under `npm run test:sim` (TEST_SIM_FULL=1). */
const FULL = process.env['TEST_SIM_FULL'] === '1';

test('TEST_SIM_FULL=1: the 20-seed holdsSetup loop holds-time-0…19 passes Plan 2\'s six exit oracles and prints its wall time (R3-58: the local timing the ledger records; Task 16 sizes the shards)', { skip: FULL ? false : 'TEST_SIM_FULL=1 only (R3-55)', timeout: 8 * 60 * 60_000 }, async (t) => {
  const started = performance.now();
  const per: number[] = [];
  const failed: string[] = [];
  for (let k = 0; k < 20; k++) {
    const s = holdsSetup(`holds-time-${k}`);
    const t0 = performance.now();
    // every seed runs (the timing needs all 20); the failures are reported together below — an oracle failure and a thrown engine
    // error alike (fix round 1: runSim throws when an engine throws, which ended the first loop at holds-time-4 with no timing)
    try {
      const r = await runSim(s.tuple, s.factory, exitOracles(), s.options);
      if (!r.ok) failed.push(`holds-time-${k}: ${JSON.stringify(r.failure)} (artifacts ${String(r.artifactsDir)})`);
    } catch (e) {
      failed.push(`holds-time-${k}: threw ${e instanceof Error ? e.message : String(e)}`);
    }
    per.push(Math.round(performance.now() - t0));
  }
  const sorted = [...per].sort((a, b) => a - b);
  t.diagnostic(`holds-time-0…19 wall time ${Math.round(performance.now() - started)} ms; per seed p50 ${sorted[9]} ms, p95 ${sorted[18]} ms, max ${sorted[19]} ms (${process.platform}, node ${process.version})`);
  assert.deepEqual(failed, [], `${failed.length} of 20 seeds failed:\n${failed.join('\n')}`);
});

// ---- determinism (T-08, TST-03, TC-TST-01) ------------------------------------------------------------------------------

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Every run-specific path (remote URL, remote dir, temp root; both slash forms, raw and as JSON string content) masked. */
function masker(ctx: SimContext): (text: string) => string {
  const slash = (p: string): string => p.split('\\').join('/');
  const esc = (p: string): string => JSON.stringify(p).slice(1, -1);
  const masks: Array<[string, string]> = [];
  for (const [s, mask] of [[ctx.remote.url, '<remote>'], [ctx.remote.dir, '<remote>'], [slash(ctx.remote.dir), '<remote>'], [ctx.root, '<root>'], [slash(ctx.root), '<root>']] as const) {
    masks.push([esc(s), mask], [s, mask]);
  }
  return (text) => masks.reduce((t, [s, mask]) => t.split(s).join(mask), text);
}

function batchObjects(out: Buffer): Buffer[] {
  const objs: Buffer[] = [];
  let at = 0;
  while (at < out.length) {
    const nl = out.indexOf(0x0a, at);
    const m = /^[0-9a-f]+ \w+ (\d+)$/.exec(out.subarray(at, nl).toString('utf8'));
    if (m === null) throw new Error(`cat-file --batch: ${out.subarray(at, nl).toString('utf8')}`);
    const size = Number(m[1]);
    objs.push(out.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return objs;
}

function rawTreeEntries(tree: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const out: Array<{ mode: string; name: string; oid: string }> = [];
  let at = 0;
  while (at < tree.length) {
    const sp = tree.indexOf(0x20, at);
    const nul = tree.indexOf(0x00, sp);
    out.push({ mode: tree.subarray(at, sp).toString('utf8'), name: tree.subarray(sp + 1, nul).toString('utf8'), oid: tree.subarray(nul + 1, nul + 21).toString('hex') });
    at = nul + 21;
  }
  return out;
}

/** Ruling R-SIM-02 (Plan 2): every state commit named by its content, meta.json with the run's paths masked. */
async function stateContents(ctx: SimContext, mask: (text: string) => string): Promise<Map<string, string>> {
  const byPeer = new Map<string, Set<string>>();
  for (const e of ctx.trace.ofKind('state')) {
    const name = ctx.trace.names.get(e.peer)!;
    if (!byPeer.has(name)) byPeer.set(name, new Set());
    for (const oid of [e.prev, e.next]) if (oid !== null) byPeer.get(name)!.add(oid);
  }
  const out = new Map<string, string>();
  const git = testRunner();
  for (const [name, set] of byPeer) {
    const oids = [...set];
    const dir = ctx.peers.find((p) => p.name === name)!.dir;
    const r = await git.run(['cat-file', '--batch'], { class: 'local', cwd: dir, stdin: Buffer.from(oids.flatMap((o) => [o, `${o}^{tree}`, `${o}:meta`]).join('\n') + '\n', 'utf8') });
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    const objs = batchObjects(r.stdout);
    oids.forEach((oid, i) => {
      const meta = sha256(mask(objs[3 * i + 2]!.toString('utf8')));
      const entries = rawTreeEntries(objs[3 * i + 1]!).map((e) => `${e.mode} ${e.name} ${e.name === 'meta' ? `masked:${meta}` : e.oid}`);
      out.set(oid, `state:${sha256(objs[3 * i]!.toString('utf8').replace(/^tree [0-9a-f]+\n/, `tree {${entries.join('; ')}}\n`))}`);
    });
  }
  return out;
}

/** The contract fields of the Plan 3 trace events (src/ports/trace.ts; no duration, no wall time). */
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  hold: ['kind', 'peer', 'id', 'holdKind', 'guard', 'guards', 'paths', 'residence', 'state', 'rev', 'localOnly'],
  apply: ['kind', 'peer', 'tip', 'written', 'deferred', 'groups', 'notApplicable', 'mDisk'],
  mask: ['kind', 'peer', 'sDisk', 'aTree', 'registry', 'partial', 'withheld', 'conflicted'],
  compose: ['kind', 'peer', 'tip', 'aTree', 'registry', 'pTree', 'pairs', 'groups', 'withheldWhole'],
  mirror: ['kind', 'peer', 'bnew', 'holds'],
  discard: ['kind', 'peer', 'id', 'rev', 'held'],
  repair: ['kind', 'peer', 'path', 'from', 'to'],
  form_violation: ['kind', 'peer', 'path', 'commit'],
  edit_check: ['kind', 'peer', 'cs', 'verdict'],
  mass: ['kind', 'peer', 'entered', 'paths'],
};
const NESTED: ReadonlyArray<[string, string, readonly string[]]> = [
  ['apply', 'groups', ['paths', 'outcome', 'reason']],
  ['apply', 'notApplicable', ['path', 'reason']],
  ['compose', 'pairs', ['csId', 'R', 'A', 'order', 'paths']],
  ['compose', 'groups', ['key', 'csIds', 'paths', 'pins', 'ready']],
  ['compose', 'withheldWhole', ['key', 'paths']],
  ['mirror', 'holds', ['id', 'rev', 'localOnly', 'held']],
  ['discard', 'held', ['path', 'blob']],
];
const keys = (o: object): string[] => Object.keys(o).sort();

function checkFields(events: readonly TraceEvent[]): Set<string> {
  const seen = new Set<string>();
  for (const e of events) {
    const want = FIELDS[e.kind];
    if (want === undefined) continue;
    seen.add(e.kind);
    assert.deepEqual(keys(e), [...want].sort(), `${e.kind} event fields`);
    for (const [kind, field, sub] of NESTED) {
      if (e.kind !== kind) continue;
      for (const x of (e as unknown as Record<string, object[]>)[field]!) assert.deepEqual(keys(x), [...sub].sort(), `${kind}.${field}[] fields`);
    }
  }
  return seen;
}

test('the same holds seed run twice in different temp roots gives identical op-logs, identical trace events (remote URL normalised), identical remote ref oids and identical refs/cowork-local/<e>/holds oids on every peer; every hold, apply, mask, compose, mirror, discard, repair, form_violation, edit_check and mass event has exactly its contract fields (no duration, no wall time)', { timeout: 40 * 60_000 }, async () => {
  const SEED = 'holds-det-0';
  const run = async (): Promise<{ r: SimResult; ctx: SimContext; trace: string; holds: string[] }> => {
    const s = holdsSetup(SEED, { steps: 36 });
    const cap = capture(async (ctx) => {
      const mask = masker(ctx);
      const states = await stateContents(ctx, mask);
      const named = (oid: string | null): string | null => (oid === null ? null : states.get(oid)!);
      const events = ctx.trace.events.map((e) => (e.kind === 'state' ? { ...e, prev: named(e.prev), next: named(e.next) } : e));
      const holds = await Promise.all(ctx.peers.map(async (p) => `${p.name} ${(await readRegistry(testRunner(), p.dir, 'main')).head ?? '-'}`));
      return { trace: mask(JSON.stringify(events)), holds };
    });
    const r = await runSim(s.tuple, s.factory, [cap], s.options);
    okOrFail(r);
    return { r, ctx: cap.ctx!, trace: cap.value!.trace, holds: cap.value!.holds };
  };
  const a = await run();
  const b = await run();
  assert.notEqual(a.ctx.root, b.ctx.root, 'two temp roots');
  assert.deepEqual(b.r.opLog, a.r.opLog);
  assert.deepEqual(b.r.remoteRefs, a.r.remoteRefs);
  assert.deepEqual(b.holds, a.holds, 'every peer\'s registry head');
  assert.ok(a.holds.some((h) => !h.endsWith(' -')), 'a registry was written');
  assert.equal(b.trace, a.trace);
  // Not vacuous, and the Plan 3 events carry exactly their contract fields.
  const seen = checkFields(a.ctx.trace.events);
  for (const k of ['hold', 'apply', 'mask', 'compose', 'mirror']) assert.ok(seen.has(k), `a ${k} event was emitted (${[...seen].join(', ')})`);
  assert.ok(a.r.opLog.some((e) => CATALOGUE.has(e.kind) && e.kind !== 'resume'), 'catalogue ops ran');
});
