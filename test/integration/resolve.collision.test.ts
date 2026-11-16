// The collision verbs of /cowork resolve (Plan 3 Task 11; 03-data DAT-29, I-DAT-08 take, keep and variant, TC-HLD-10 "no bytes are
// lost in either branch"; 05-holds Table 4 `--publish`/`--discard` on INCOMING `collision`, U8 keep; glossary §24 default 5; rulings
// R3-10, R3-33, R3-67; D-09): peer 1 has an ignored .env holding a marker and a teammate's change-set adding .env and src/a.ts lands, so
// peer 1 holds a `collision` record (Task 6). `--publish` takes the team version after capturing the local file into a new local_only
// PATCH; `--discard` keeps the local file (`collision:keep`) until TIP drops .env or the disk equals TIP. makeCores({n: 2}); the
// change-set lands through the fixture's teammate writer (a cowork peer never publishes a new secret-like .env: NOT_ADMITTED).
// Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimes, writeFile } from 'node:fs/promises';
import { resolve, type ResolveResult } from '../../src/engine/resolve.js';
import { ABSENT } from '../../src/git/oid.js';
import type { HoldRecord } from '../../src/holds/record.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { remoteLive } from '../helpers/dataRecordsFixture.js';
import { blob, prepIt } from '../helpers/holdOpsFixture.js';
import { loop, onlyWithGuard, privateBlobs, withGuard } from '../helpers/incomingFixture.js';
import { buf, withCores } from '../helpers/publishHelpers.js';
import { HUMAN, joinOnBoard } from '../helpers/resolveFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const ENV = '.env';
const MARK = 'CWM_t11_1_b';
const LOCAL = `SECRET=${MARK}\n`;
const TEAM = 'SECRET=team\n';
const FILES: Record<string, Buffer> = { 'README.md': buf('# resolve collision\n'), '.gitignore': buf('.env\n'), 'src/b.ts': buf('export const b = 1;\n') };
const done = (code: string, id: string, created: string | null = null): ResolveResult => ({ kind: 'done', code, id, created });
const text = async (p: PeerFixture, path: string): Promise<string | null> => (await readWork(p, path))?.toString('utf8') ?? null;

/** Peer 1 with an ignored .env holding the marker; the teammate's CS adding .env and src/a.ts lands; peer 1's collision record. */
async function collided(fx: CoreFixture, path = ENV, local = LOCAL, quiet = false): Promise<{ q: PeerFixture; c: string }> {
  const q = fx.peers[1]!;
  await joinOnBoard(fx, q);
  await loop(q);
  fx.advance(10_000);
  if (quiet) {
    // Created inside the quiet period just before the add lands: the tick does not read it yet (its mtime is this instant).
    await writeFile(workPath(q, path), local);
    const t = q.clock.wallMs() / 1_000;
    await utimes(workPath(q, path), t, t);
  } else {
    await writeWork(q, path, local);
  }
  await fx.pushTeamChange({ [path]: buf(TEAM), 'src/a.ts': buf('export const a = 1;\n') });
  if (!quiet) fx.advance(10_000);
  const l = await loop(q);
  assert.ok(l.apply.written.includes('src/a.ts'), "the CS's other path applies");
  const c = onlyWithGuard(q, 'collision');
  assert.deepEqual([c.kind, c.paths], ['INCOMING', [path]]);
  assert.equal(await text(q, path), local, 'precondition: the local file is untouched');
  return { q, c: c.id };
}

/** The guard-less OFF_DISK PARKED capture of `path` (h0 ABSENT). */
function capturesOf(q: PeerFixture, path: string, c: string): HoldRecord[] {
  return q.core.holds.all().filter((r) => r.id !== c && r.paths.includes(path) && r.guards.length === 0 && 'h0' in r.blobs && r.blobs.h0[path] === ABSENT);
}

test('I-DAT-08 take: --publish captures peer 1\'s .env through the staged copy as a new local_only PATCH (h0 ABSENT, h1 = its bytes, OFF_DISK PARKED, displaced_by null), writes TIP\'s .env through writeLocal, and the collision record ends SUBSUMED at the next apply', T10, async () => {
  await withCores('rcol-take', { n: 2, files: FILES }, async (fx) => {
    const { q, c } = await collided(fx);
    const it = await prepIt(q, { forceFetch: true, holdPaths: [ENV] });
    const res = await resolve(q.core, it, c, 'publish', HUMAN);
    const [k] = capturesOf(q, ENV, c);
    assert.ok(k !== undefined, 'a capture record');
    assert.deepEqual(res, done('HOLD_SUBSUMED', c, k.id), 'created names the capture record');
    assert.deepEqual([k.kind, k.residence, k.state, k.displaced_by, k.local_only, k.origin], ['PATCH', 'OFF_DISK', 'PARKED', null, true, 'human']);
    assert.ok('h1' in k.blobs);
    assert.deepEqual([k.blobs.h0[ENV], k.blobs.h1[ENV]], [ABSENT, await blob(q, LOCAL)], 'h1 = its bytes (staged copy, route (b))');
    assert.equal(await text(q, ENV), TEAM, "TIP's .env written");
    assert.equal(q.core.holds.get(c)!.state, 'ACTIVE', 'the collision record waits for the next apply');
    // The next apply: A[.env] := TIP[.env] with no write (disk_equal, R3-33), and the collision record ends SUBSUMED.
    const from = fx.trace.events.length;
    fx.advance(10_000);
    const l = await loop(q);
    assert.equal((await prepIt(q)).A.get(ENV)?.oid, l.it.tipMap.get(ENV)?.oid, 'A[.env] := TIP[.env]');
    const aSet = fx.trace.events.slice(from).filter((e): e is Extract<TraceEvent, { kind: 'A_set' }> => e.kind === 'A_set' && e.path === ENV && e.peer === q.core.peerId);
    assert.deepEqual(aSet.map((e) => e.cause), ['disk_equal']);
    assert.equal(q.core.holds.get(c)!.state, 'SUBSUMED');
    assert.equal(q.core.holds.get(k.id)!.state, 'PARKED', 'the capture keeps the local bytes');
  });
});

test('a writer CAS failure during the take keeps the collision record and refuses HOLD_DISK_CHANGED', T10, async () => {
  await withCores('rcol-take-cas', { n: 2, files: FILES }, async (fx) => {
    const { q, c } = await collided(fx);
    const before = q.core.holds.get(c);
    const it = await prepIt(q, { forceFetch: true, holdPaths: [ENV] });
    q.fs.interpose('writeFileExclusive', '.new', async () => {
      await writeFile(workPath(q, ENV), 'SECRET=edited meanwhile\n');
    });
    assert.deepEqual(await resolve(q.core, it, c, 'publish', HUMAN), { kind: 'refused', code: 'HOLD_DISK_CHANGED', params: { hid: c } });
    assert.deepEqual(q.core.holds.get(c), before, 'the collision record is kept');
    assert.equal(await text(q, ENV), 'SECRET=edited meanwhile\n', 'the team version was not written');
    assert.deepEqual(capturesOf(q, ENV, c).map((k) => k.state), ['GONE'], 'the capture ended GONE (R3-67)');
  });
});

/** Loops with publish: .env stays the local file, never staged, no other record for it, no remote byte of it. */
async function keptLocal(fx: CoreFixture, q: PeerFixture, c: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    fx.advance(10_000);
    await loop(q, { publish: true });
    assert.equal(await text(q, ENV), LOCAL, 'never written');
    assert.equal((await privateBlobs(q))(ENV), ABSENT, 'the snapshot keeps skipping it (never in the private index)');
    assert.deepEqual(q.core.holds.all().filter((r) => r.id !== c && r.paths.includes(ENV)).map((r) => r.guards.map((g) => g.name)), [], 'no add and no K4 for .env');
  }
  assert.notEqual((await remoteLive(fx, q)).get(ENV), await blob(q, LOCAL), 'the local bytes never reach the remote');
}

test('05 U8 keep: --discard sets collision:keep in a new mirrored rev, never writes .env, the snapshot keeps skipping it, and the record ends SUBSUMED when TIP drops .env or DISK_EQ(.env, TIP[.env])', T10, async () => {
  for (const ending of ['tip_drops', 'disk_equal'] as const) {
    await withCores(`rcol-keep-${ending}`, { n: 2, files: FILES }, async (fx) => {
      const { q, c } = await collided(fx);
      // Its creation op (a board health stub) is drafted once the record is 60 s old (R3-29): it lands first.
      for (let i = 0; i < 7; i++) {
        fx.advance(10_000);
        await loop(q, { publish: true });
      }
      assert.equal((await prepIt(q, { forceFetch: true })).fold.holds[c]?.guards.map((g) => g.name).join(), 'collision', 'precondition: folded');
      const rev = q.core.holds.get(c)!.rev;
      const it = await prepIt(q, { forceFetch: true, holdPaths: [ENV] });
      assert.deepEqual(await resolve(q.core, it, c, 'discard', HUMAN), done('HOLD_ANSWERED', c));
      const r = q.core.holds.get(c)!;
      assert.deepEqual([r.state, r.rev, r.guards.map((g) => g.name)], ['ACTIVE', rev + 1, ['collision:keep']], 'collision:keep in a new rev');
      assert.deepEqual(q.core.outbox.pendingHold(c)?.guards.map((g) => g.name), ['collision:keep'], 'mirrored (a stub: .env is local_only)');
      assert.equal(await text(q, ENV), LOCAL);
      await keptLocal(fx, q, c, 3);
      if (ending === 'tip_drops') await fx.pushTeamChange({ [ENV]: null });
      else await writeWork(q, ENV, TEAM);   // the human copies the team version
      fx.advance(10_000);
      await loop(q);
      fx.advance(10_000);
      await loop(q);
      assert.equal(q.core.holds.get(c)!.state, 'SUBSUMED', ending);
      assert.equal(await text(q, ENV), ending === 'tip_drops' ? LOCAL : TEAM, 'never written by the daemon');
    });
  }
});

test('--publish after collision:keep still takes the team version', T10, async () => {
  await withCores('rcol-keep-take', { n: 2, files: FILES }, async (fx) => {
    const { q, c } = await collided(fx);
    const it = await prepIt(q, { forceFetch: true, holdPaths: [ENV] });
    assert.deepEqual(await resolve(q.core, it, c, 'discard', HUMAN), done('HOLD_ANSWERED', c));
    const it2 = await prepIt(q, { forceFetch: true, holdPaths: [ENV] });
    const res = await resolve(q.core, it2, c, 'publish', HUMAN);
    const [k] = capturesOf(q, ENV, c);
    assert.ok(k !== undefined);
    assert.deepEqual(res, done('HOLD_SUBSUMED', c, k.id));
    assert.equal(await text(q, ENV), TEAM);
    assert.ok('h1' in k.blobs && k.blobs.h1[ENV] === (await blob(q, LOCAL)));
  });
});

test('I-DAT-08 variant: an untracked, non-ignored notes.txt created inside the quiet period just before the add lands becomes a collision record and both verbs behave as above, with no bytes lost', T10, async () => {
  const NOTES = 'notes.txt';
  const local = `my notes ${MARK}\n`;
  for (const verb of ['publish', 'discard'] as const) {
    await withCores(`rcol-variant-${verb}`, { n: 2, files: FILES }, async (fx) => {
      const { q, c } = await collided(fx, NOTES, local, true);
      fx.advance(10_000);
      const it = await prepIt(q, { forceFetch: true, holdPaths: [NOTES] });
      const res = await resolve(q.core, it, c, verb, HUMAN);
      const caps = capturesOf(q, NOTES, c);
      if (verb === 'publish') {
        assert.equal(caps.length, 1);
        assert.deepEqual(res, done('HOLD_SUBSUMED', c, caps[0]!.id));
        assert.equal(await text(q, NOTES), TEAM);
      } else {
        assert.deepEqual(res, done('HOLD_ANSWERED', c));
        assert.deepEqual(caps, []);
        assert.equal(await text(q, NOTES), local);
      }
      // No bytes lost: the marker is on peer 1's disk, or in the capture record's h1.
      const onDisk = (await text(q, NOTES))?.includes(MARK) === true;
      const h1 = caps[0] !== undefined && 'h1' in caps[0].blobs ? caps[0].blobs.h1[NOTES] : undefined;
      const heldText = h1 === undefined || h1 === ABSENT ? '' : (await q.core.repo.readBlob(h1)).toString('utf8');
      assert.ok(onDisk || heldText.includes(MARK), `the marker survives (${verb})`);
      assert.equal(withGuard(q, 'collision').length, 1);
    });
  }
});
