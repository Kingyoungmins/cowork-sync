// The engine and CLI entries of /cowork resolve (Plan 3 Task 11; rulings R3-02, R-26, R-28; Plan 2 Task 17 carry; F-HLD-1 engine part):
// Engine.resolve queued between iterations with a fresh fetch first; `node dist/daemon.js resolve` under daemon.lock with restart()
// first, its exit codes and one printed line per outcome; parseDaemonArgs; EngineFixture.resolve, the SIM's entry. runDaemon runs in
// process on the real ports with a capturing DaemonIo. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DAEMON_USAGE, parseDaemonArgs, resolveLine, runDaemon, type DaemonArgs, type DaemonIo } from '../../src/daemon/run.js';
import { IN_TREE_DAEMON } from '../helpers/regionDeps.js';
import { park } from '../../src/engine/holdOps.js';
import { FETCH_OWED_NEXT, resolve, type ResolveResult, type ResolveVerb } from '../../src/engine/resolve.js';
import { NEXT_COMMAND, type ResolveRefusal } from '../../src/holds/codes.js';
import { parseRecord, type HoldRecord } from '../../src/holds/record.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { realFs } from '../../src/ports/fs.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { readWork, workPath, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { lockOf, withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { blob, nr, pair, prepIt, stages } from '../helpers/holdOpsFixture.js';
import { binary, T9, t9 } from '../helpers/maskFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { HUMAN } from '../helpers/resolveFixture.js';
import { gitIn } from '../helpers/startFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const VERB_ROWS = ['publish', 'discard', 'park', 'restore', 'handoff'] as const;
const FILES: Record<string, Buffer> = {
  'README.md': buf('# daemon resolve\n'), 'img.bin': binary(0),
  ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((x) => [`src/${x}.txt`, buf(T9)])),
  ...Object.fromEntries(VERB_ROWS.flatMap((v) => [[`e/${v}.txt`, buf(T9)], [`c/${v}.txt`, buf(T9)]])),
};
const done = (code: string, id: string, created: string | null = null): ResolveResult => ({ kind: 'done', code, id, created });

function daemonEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy|git_ssh_command|git_ssh|git_ssh_variant)$/i.test(k)) delete env[k];
  return env;
}
function session(): { io: DaemonIo; lines: string[] } {
  const out: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => out.push(l), onStop: () => undefined }, lines: out };
}
function resolveArgs(dir: string, id: string, verb: Exclude<ResolveVerb, 'handoff'>): DaemonArgs {
  return { cmd: 'resolve', repo: dir, branch: 'main', publish: null, name: null, remote: null, confirm: null, id, verb, dataDir: null, pluginRoot: null, spawned: false };
}
async function runResolve(dir: string, id: string, verb: Exclude<ResolveVerb, 'handoff'>): Promise<{ code: number; lines: string[] }> {
  const s = session();
  const code = await runDaemon(resolveArgs(dir, id, verb), daemonEnv(), s.io, IN_TREE_DAEMON);
  return { code, lines: s.lines };
}

/** An ON_DISK revert PATCH over `path` (disk T9{2:two,6:six}, held line 2), made on the peer's live core. */
async function revertOn(p: PeerFixture, path: string, o: { guard?: string } = {}): Promise<string> {
  await writeWork(p, path, t9([2, 'two'], [6, 'six']));
  const it = await prepIt(p, { materialize: false });
  return p.core.holds.hold(nr({ paths: [path], guard: o.guard ?? 'revert', origin: o.guard === undefined ? 'human' : 'daemon', blobs: pair(it.A.get(path)!.oid, await blob(p, t9([2, 'two'])), path) }));
}

/**
 * `daemon.js` runs on the real clock, while the fixture's virtual clocks run ahead of it (coreFixture's WALL_MARGIN_MS), so a file writeWork wrote
 * has an mtime in the daemon's future: its first tick would not read it (a quiet path, refused HOLD_DISK_CHANGED). The files a CLI
 * test resolves are given a real past mtime first, as an edit made before the command was typed has.
 */
async function settled(p: PeerFixture, ...paths: string[]): Promise<void> {
  const t = (Date.now() - 10_000) / 1_000;
  for (const path of paths) await utimes(workPath(p, path), t, t);
}

/** A record as the registry ref holds it now (read test-side from the ref's commit, whatever core is alive). */
async function storedRecord(p: PeerFixture, id: string): Promise<{ rec: HoldRecord | null; inflight: Record<string, { op: string }> }> {
  const repo = p.core.repo;
  const head = await repo.readRef(p.core.refs.holds);
  if (head === null) return { rec: null, inflight: {} };
  const leaves = await repo.readTreeMap((await repo.readCommit(head)).tree);
  const r = leaves.get(`records/${id}.json`);
  const l = leaves.get('local.json');
  return {
    rec: r === undefined ? null : parseRecord(await repo.readBlob(r.oid)),
    inflight: l === undefined ? {} : (JSON.parse((await repo.readBlob(l.oid)).toString('utf8')) as { inflight: Record<string, { op: string }> }).inflight,
  };
}

test('Engine.resolve never overlaps iterate(): called during an iteration it starts after it, fetches fresh first and returns the ResolveResult', T10, async () => {
  await withEngines('dres-engine', { n: 1, files: FILES }, async (fx) => {
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const id = await revertOn(p, 'src/a.txt');
    const order: string[] = [];
    const fetcher = p.core.fetcher;
    const fetch = fetcher.fetch.bind(fetcher);
    fetcher.fetch = (force) => {
      order.push(`fetch:${String(force)}`);
      return fetch(force);
    };
    try {
      fx.advance(2_500);
      const iter = p.engine.iterate().then((r) => {
        order.push('iterate-done');
        return r;
      });
      const res = p.engine.resolve(id, 'park', HUMAN).then((r) => {
        order.push('resolve-done');
        return r;
      });
      order.push('both-called');
      await iter;
      assert.deepEqual(await res, done('HOLD_PARKED', id), 'the ResolveResult');
    } finally {
      fetcher.fetch = fetch;
    }
    const at = (x: string): number => order.indexOf(x);
    assert.ok(at('both-called') < at('iterate-done'), `resolve was called during the iteration: ${order.join(' ')}`);
    assert.equal(order.filter((x) => x.startsWith('fetch')).length, 2, order.join(' '));
    assert.ok(at('iterate-done') < order.lastIndexOf('fetch:true') && order.lastIndexOf('fetch:true') < at('resolve-done'), `it starts after the iteration and fetches fresh first: ${order.join(' ')}`);
    assert.equal((await readWork(p, 'src/a.txt'))?.toString('utf8'), t9([6, 'six']));
    assert.equal(p.core.holds.get(id)!.residence, 'OFF_DISK');
  });
});

/** An OFF_DISK PARKED revert PATCH over `path` (its --park writes nothing: done HOLD_PARKED). */
async function parkedOn(p: PeerFixture, path: string): Promise<string> {
  const it = await prepIt(p, { materialize: false });
  return p.core.holds.hold(nr({ paths: [path], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(it.A.get(path)!.oid, await blob(p, t9([2, 'two'])), path) }));
}

/** The registry head, the record, the disk of `path` and the outbox: what a gated verb must leave as it was. */
async function untouched(p: PeerFixture, id: string, path: string): Promise<unknown> {
  return { head: p.core.holds.head(), rec: p.core.holds.get(id), disk: (await readWork(p, path))?.toString('utf8'), outbox: JSON.stringify(p.core.outbox.toJson()) };
}

test('Engine.resolve follows the loop\'s 0b gate: with .git/index.lock present a verb that writes returns locked [.git/index.lock] and writes nothing, a verb that writes nothing still answers, and the same verb goes through once the lock is gone', T10, async () => {
  await withEngines('dres-index-lock', { n: 1, files: FILES }, async (fx) => {
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const id = await revertOn(p, 'src/a.txt');
    const off = await parkedOn(p, 'src/b.txt');
    fx.advance(2_500);
    const lockFile = join(p.deps.paths.gitDir, 'index.lock');
    await writeFile(lockFile, '');
    try {
      const before = await untouched(p, id, 'src/a.txt');
      assert.deepEqual(await p.engine.resolve(id, 'park', HUMAN), { kind: 'locked', paths: ['.git/index.lock'] });
      assert.deepEqual(await untouched(p, id, 'src/a.txt'), before, 'nothing written: registry, record, disk, outbox');
      // Verbs that write nothing answer: --park of an OFF_DISK record, a Table 4 refusal.
      assert.deepEqual(await p.engine.resolve(off, 'park', HUMAN), done('HOLD_PARKED', off));
      assert.deepEqual(await p.engine.resolve(id, 'handoff', HUMAN), { kind: 'refused', code: 'HOLD_NOT_OFFERABLE', params: { hid: id } });
    } finally {
      await realFs.unlink(lockFile);
    }
    fx.advance(2_500);
    assert.deepEqual(await p.engine.resolve(id, 'park', HUMAN), done('HOLD_PARKED', id));
    assert.equal((await readWork(p, 'src/a.txt'))?.toString('utf8'), t9([6, 'six']));
  });
});

test('Engine.resolve follows the loop\'s 0c gate: under FREEZE(EPOCH) (a git operation in progress) a verb that writes is refused HOLD_FROZEN with nothing written, the freeze is set as an iteration sets it, a verb that writes nothing still answers, and the verb goes through once the operation ends', T10, async () => {
  await withEngines('dres-epoch', { n: 1, files: FILES }, async (fx) => {
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const id = await revertOn(p, 'src/a.txt');
    const off = await parkedOn(p, 'src/b.txt');
    fx.advance(2_500);
    const marker = join(p.deps.paths.gitDir, 'MERGE_HEAD');
    await writeFile(marker, `${p.core.view!.meta.expected_epoch.head}\n`);
    try {
      const before = await untouched(p, id, 'src/a.txt');
      assert.deepEqual(await p.engine.resolve(id, 'discard', HUMAN), { kind: 'refused', code: 'HOLD_FROZEN', params: { hid: id } });
      assert.ok(p.core.view!.meta.freeze_reasons.includes('EPOCH'), 'FREEZE(EPOCH) set, as the loop\'s 0c sets it');
      const after = await untouched(p, id, 'src/a.txt') as { outbox: string };
      assert.deepEqual({ ...(after as object), outbox: null }, { ...(before as object), outbox: null }, 'nothing written: registry, record, disk');
      assert.ok(after.outbox.includes('"freeze"'), 'only the board-only freeze event is queued');
      assert.deepEqual(await p.engine.resolve(off, 'park', HUMAN), done('HOLD_PARKED', off));
    } finally {
      await realFs.unlink(marker);
    }
    fx.advance(2_500);
    assert.deepEqual(await p.engine.resolve(id, 'discard', HUMAN), done('RESOLVED_DISCARD', id));
    assert.equal(p.core.view!.meta.freeze_reasons.includes('EPOCH'), false, 'lifted once the operation ended');
    assert.equal((await readWork(p, 'src/a.txt'))?.toString('utf8'), t9([6, 'six']));
  });
});

test('Engine.resolve decides only on a fresh fold: when its forced fetch fails it refuses with the loop\'s FETCH_OWED and writes nothing; once a fetch succeeds the verb goes through', T10, async () => {
  await withEngines('dres-fetch', { n: 1, files: FILES }, async (fx) => {
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const id = await revertOn(p, 'src/a.txt');
    // A team change and a stale lock on the local board ref: the remote answers, the local ref update fails (P2-FETCHLOCAL).
    await fx.pushTeamChange({ 'team.txt': buf('t\n') });
    fx.advance(2_500);
    const refLock = `${join(p.deps.paths.gitDir, ...p.core.refs.localBoard.split('/'))}.lock`;
    await mkdir(dirname(refLock), { recursive: true });
    await writeFile(refLock, '');
    try {
      const before = await untouched(p, id, 'src/a.txt');
      assert.deepEqual(await p.engine.resolve(id, 'park', HUMAN), { kind: 'refused', code: 'FETCH_OWED', params: { hid: id, local: true } });
      assert.deepEqual(await untouched(p, id, 'src/a.txt'), before, 'nothing written on the stale fold');
    } finally {
      await realFs.unlink(refLock);
    }
    fx.advance(2_500);
    assert.deepEqual(await p.engine.resolve(id, 'park', HUMAN), done('HOLD_PARKED', id));
  });
});

test('node dist/daemon.js resolve exits 0 for done and HOLD_ALREADY_RESOLVED, 1 for a refusal or a lock with one line naming the code and its next command, 2 for an internal error, and refuses while a live daemon holds daemon.lock', T10, async () => {
  await withEngines('dres-cli', { n: 1, files: FILES }, async (fx) => {
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const dir = p.deps.paths.workTree;
    const parkId = await revertOn(p, 'src/a.txt');
    const discardId = await revertOn(p, 'src/b.txt');
    const eolId = await revertOn(p, 'src/c.txt', { guard: 'eol-bom' });
    const lockedId = await revertOn(p, 'src/d.txt');
    await settled(p, 'src/a.txt', 'src/b.txt', 'src/c.txt', 'src/d.txt');
    // A live daemon (the fixture's) holds daemon.lock: refused, nothing written.
    const busy = await runResolve(dir, parkId, 'park');
    assert.equal(busy.code, 1);
    assert.ok(busy.lines.some((l) => l.startsWith('DAEMON_ALREADY_RUNNING')), busy.lines.join('\n'));
    assert.equal((await readWork(p, 'src/a.txt'))?.toString('utf8'), t9([2, 'two'], [6, 'six']));
    await lockOf(p).release();

    // done → exit 0, one line with the result code.
    const parked = await runResolve(dir, parkId, 'park');
    assert.equal(parked.code, 0, parked.lines.join('\n'));
    assert.deepEqual(parked.lines, [`HOLD_PARKED ${JSON.stringify({ hid: parkId, created: null })}`]);
    assert.equal((await readWork(p, 'src/a.txt'))?.toString('utf8'), t9([6, 'six']));
    // HOLD_ALREADY_RESOLVED is a done (exit 0).
    assert.equal((await runResolve(dir, discardId, 'discard')).code, 0);
    const again = await runResolve(dir, discardId, 'discard');
    assert.equal(again.code, 0, again.lines.join('\n'));
    assert.deepEqual(again.lines, [`HOLD_ALREADY_RESOLVED ${JSON.stringify({ hid: discardId, created: null })}`]);
    // A refusal → exit 1, one line: the code, its params and its 05 §1 next command.
    const refused = await runResolve(dir, eolId, 'publish');
    assert.equal(refused.code, 1);
    assert.deepEqual(refused.lines, [`HOLD_GUARDS_REMAIN ${JSON.stringify({ hid: eolId, guards: ['eol-bom'] })} next: ${NEXT_COMMAND.HOLD_GUARDS_REMAIN}`]);
    const nobody = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const notOwner = await runResolve(dir, nobody, 'restore');
    assert.equal(notOwner.code, 1);
    assert.deepEqual(notOwner.lines, [`HOLD_NOT_OWNER ${JSON.stringify({ hid: nobody })} next: ${NEXT_COMMAND.HOLD_NOT_OWNER.replace('<id>', nobody)}`]);
    // A lock (a holder refusing the rename, as share-read does) → exit 1, one line naming LOCKED and the next command.
    const target = workPath(p, 'src/d.txt');
    const rename = realFs.rename;
    const unlink = realFs.unlink;
    const busyErr = (p2: string): Error => Object.assign(new Error(`EPERM: operation not permitted '${p2}'`), { code: 'EPERM' });
    realFs.rename = async (from, to) => (from === target || to === target ? Promise.reject(busyErr(from)) : rename(from, to));
    realFs.unlink = async (p2) => (p2 === target ? Promise.reject(busyErr(p2)) : unlink(p2));
    let lockedRun: { code: number; lines: string[] };
    try {
      lockedRun = await runResolve(dir, lockedId, 'park');
    } finally {
      realFs.rename = rename;
      realFs.unlink = unlink;
    }
    assert.equal(lockedRun.code, 1, lockedRun.lines.join('\n'));
    assert.equal(lockedRun.lines.length, 1, lockedRun.lines.join('\n'));
    assert.match(lockedRun.lines[0]!, new RegExp(`^LOCKED \\{"hid":"${lockedId}","paths":\\["src/d.txt"\\]\\} next: .*${NEXT_COMMAND.HOLD_DISK_CHANGED}`));
    assert.equal((await readWork(p, 'src/d.txt'))?.toString('utf8'), t9([2, 'two'], [6, 'six']), 'nothing written');
    // An internal error (a registry ref that is not a cowork-holds commit) → exit 2.
    await gitIn(p, ['update-ref', p.core.refs.holds, 'HEAD']);
    const broken = await runResolve(dir, parkId, 'restore');
    assert.equal(broken.code, 2, broken.lines.join('\n'));
    assert.ok(broken.lines.some((l) => l.startsWith('DAEMON_INTERNAL_ERROR')), broken.lines.join('\n'));
    assert.equal(existsSync(join(p.deps.paths.coworkDir, 'daemon.lock')), false, 'every run released the lock it took');
  });
});

test('daemon.js resolve prints every refusal it can reach as one line with its registered 05 §1 next command — none where the table shows "—" — and the 0b/0c/fetch gates with theirs', T10, async () => {
  await withEngines('dres-cli-next', { n: 1, files: FILES }, async (fx) => {
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const dir = p.deps.paths.workTree;
    const it0 = await prepIt(p, { materialize: false });
    // HOLD_NOT_PARKABLE (an INCOMING record): 05 §1 shows no next command ("—"), so the line has none.
    const incoming = await p.core.holds.hold(nr({ kind: 'INCOMING', guard: 'lock', origin: 'daemon', paths: ['src/f.txt'], blobs: pair(it0.A.get('src/f.txt')!.oid, await blob(p, t9([7, 'tip'])), 'src/f.txt') }));
    // HOLD_RESTORE_CONFLICT (a binary K4 whose disk is neither its base nor A).
    await writeWork(p, 'img.bin', binary(2));
    const b0 = it0.A.get('img.bin')!.oid;
    const bin = await p.core.holds.hold(nr({ paths: ['img.bin'], residence: 'OFF_DISK', state: 'CONFLICTED', guard: 'conflict', origin: 'daemon', blobs: stages(b0, await blob(p, binary(1)), b0, 'img.bin') }));
    const gated = await revertOn(p, 'src/a.txt');
    // HOLD_DISK_CHANGED: a file saved "now" in the daemon's clock (its mtime not settled) is not read by its first tick.
    const quiet = await revertOn(p, 'src/b.txt');
    await settled(p, 'src/a.txt', 'img.bin');
    await lockOf(p).release();
    const run = async (id: string, verb: Exclude<ResolveVerb, 'handoff'>): Promise<{ code: number; lines: string[] }> => runResolve(dir, id, verb);

    const np = await run(incoming, 'park');
    assert.deepEqual([np.code, np.lines], [1, [`HOLD_NOT_PARKABLE ${JSON.stringify({ hid: incoming })}`]]);
    const rc = await run(bin, 'restore');
    assert.deepEqual([rc.code, rc.lines], [1, [`HOLD_RESTORE_CONFLICT ${JSON.stringify({ hid: bin })} next: ${NEXT_COMMAND.HOLD_RESTORE_CONFLICT.replace('<id>', bin)}`]]);
    const dc = await run(quiet, 'park');
    assert.deepEqual([dc.code, dc.lines], [1, [`HOLD_DISK_CHANGED ${JSON.stringify({ hid: quiet })} next: ${NEXT_COMMAND.HOLD_DISK_CHANGED}`]]);
    // 0c: a git operation in progress (MERGE_HEAD): HOLD_FROZEN with its next command.
    const marker = join(p.deps.paths.gitDir, 'MERGE_HEAD');
    await writeFile(marker, `${p.core.view!.meta.expected_epoch.head}\n`);
    let fr: { code: number; lines: string[] };
    try {
      fr = await run(gated, 'park');
    } finally {
      await realFs.unlink(marker);
    }
    assert.deepEqual([fr.code, fr.lines], [1, [`HOLD_FROZEN ${JSON.stringify({ hid: gated })} next: ${NEXT_COMMAND.HOLD_FROZEN}`]]);
    // 0b: git's index.lock: LOCKED naming it, "repeat the command" once the git command ends.
    const indexLock = join(p.deps.paths.gitDir, 'index.lock');
    await writeFile(indexLock, '');
    let il: { code: number; lines: string[] };
    try {
      il = await run(gated, 'park');
    } finally {
      await realFs.unlink(indexLock);
    }
    assert.equal(il.code, 1, il.lines.join('\n'));
    assert.equal(il.lines.length, 1, il.lines.join('\n'));
    assert.match(il.lines[0]!, new RegExp(`^LOCKED \\{"hid":"${gated}","paths":\\[".git/index.lock"\\]\\} next: wait for the git command to finish, then ${NEXT_COMMAND.HOLD_DISK_CHANGED}: node dist/daemon\\.js resolve --repo .+ --branch main --id ${gated} --park$`));
    // The forced fetch fails (the remote is away; a one-shot run has no other fetch, and restart clears a stale cowork ref lock, so the
    // network form is the one a terminal meets): FETCH_OWED with its next command.
    const away = `${fx.remote.dir}.away`;
    await rename(fx.remote.dir, away);
    let fo: { code: number; lines: string[] };
    try {
      fo = await run(gated, 'park');
    } finally {
      await rename(away, fx.remote.dir);
    }
    assert.deepEqual([fo.code, fo.lines], [1, [`FETCH_OWED ${JSON.stringify({ hid: gated, local: false })} next: ${FETCH_OWED_NEXT}`]]);
    assert.equal((await readWork(p, 'src/a.txt'))?.toString('utf8'), t9([2, 'two'], [6, 'six']), 'nothing written by the gated runs');
    const ok = await run(gated, 'park');
    assert.deepEqual([ok.code, ok.lines], [0, [`HOLD_PARKED ${JSON.stringify({ hid: gated, created: null })}`]]);
  });
});

test('resolveLine prints each ResolveResult as daemon.js resolve does: every 05 §1 refusal with its registered next command (none for "—"), FETCH_OWED, both LOCKED forms and a done', T10, () => {
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const again = `node dist/daemon.js resolve --repo r --branch b --id ${id} --park`;
  const refusals: ResolveRefusal[] = ['HOLD_NOT_OWNER', 'HOLD_GUARDS_REMAIN', 'HOLD_NOT_OFFERABLE', 'HOLD_NOT_PARKABLE', 'HOLD_RESTORE_CONFLICT', 'HOLD_DISK_CHANGED', 'HOLD_FROZEN'];
  for (const code of refusals) {
    const next = NEXT_COMMAND[code];
    assert.deepEqual(resolveLine({ kind: 'refused', code, params: { hid: id } }, id, again),
      { exit: 1, line: `${code} ${JSON.stringify({ hid: id })}${next === '\u{2014}' ? '' : ` next: ${next.replace('<id>', id)}`}` }, code);
  }
  assert.equal(resolveLine({ kind: 'refused', code: 'HOLD_NOT_PARKABLE', params: { hid: id } }, id, again).line.includes('next'), false, '"—" prints no next command');
  assert.deepEqual(resolveLine({ kind: 'refused', code: 'FETCH_OWED', params: { hid: id, local: false } }, id, again),
    { exit: 1, line: `FETCH_OWED ${JSON.stringify({ hid: id, local: false })} next: ${FETCH_OWED_NEXT}` });
  assert.deepEqual(resolveLine({ kind: 'locked', paths: ['src/a.txt'] }, id, again),
    { exit: 1, line: `LOCKED ${JSON.stringify({ hid: id, paths: ['src/a.txt'] })} next: close the program holding the file, then repeat the command: ${again}` });
  assert.deepEqual(resolveLine({ kind: 'locked', paths: ['.git/index.lock'] }, id, again),
    { exit: 1, line: `LOCKED ${JSON.stringify({ hid: id, paths: ['.git/index.lock'] })} next: wait for the git command to finish, then repeat the command: ${again}` });
  assert.deepEqual(resolveLine({ kind: 'done', code: 'HOLD_ALREADY_RESOLVED', id, created: null }, id, again),
    { exit: 0, line: `HOLD_ALREADY_RESOLVED ${JSON.stringify({ hid: id, created: null })}` });
  assert.throws(() => resolveLine({ kind: 'claude_refused', reason: 'binary' }, id, again), /claude_refused/);
});

/** Throws KilledAt at the first hit of `point` while fn runs. */
async function killedAt<T>(point: string, fn: () => Promise<T>): Promise<void> {
  setCrashHandler((name) => {
    if (name === point) throw new KilledAt(name);
  });
  try {
    await assert.rejects(fn(), (e: unknown) => e instanceof KilledAt);
  } finally {
    setCrashHandler(null);
  }
}

test('daemon.js resolve holds daemon.lock for its whole run and runs restart() before writing', T10, async () => {
  await withEngines('dres-restart', { n: 1, files: FILES }, async (fx: EngineFixture) => {
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    const dir = p.deps.paths.workTree;
    const id = await revertOn(p, 'src/e.txt');
    await settled(p, 'src/e.txt');
    // A clone killed inside a PARK: the writer's local intent kept, inflight[r] set, the disk at the park target.
    const it = await prepIt(p, { holdPaths: ['src/e.txt'] });
    await killedAt('apply.group.phase2', () => park(p.core, it, id, { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false }));
    assert.equal((await readWork(p, 'src/e.txt'))?.toString('utf8'), t9([6, 'six']), 'the disk is at the park target');
    assert.equal((await p.core.state.read())!.intent.kind, 'local', 'the local intent is kept');
    assert.equal((await storedRecord(p, id)).inflight[id]?.op, 'park');
    // The dead daemon left its lock behind under a dead pid (R-26: replaced).
    await lockOf(p).release();
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    await writeFile(join(p.deps.paths.coworkDir, 'daemon.lock'), `${JSON.stringify({ pid: dead, plugin_version: PLUGIN_VERSION, instance: 'dead-daemon', started: null })}\n`);
    // At the RESTORE's first write: the restart already completed the PARK and resolved the kept intent; a daemon started now refuses.
    const writeNew = realFs.writeFileExclusive;
    type Seen = { rec: HoldRecord | null; inflight: string | null; intentOrigin: string | null; concurrent: { code: number; lines: string[] } };
    const box: { seen: Seen | null } = { seen: null };
    realFs.writeFileExclusive = async (file, data) => {
      if (box.seen === null && file.endsWith('.new')) {
        const s = await storedRecord(p, id);
        const intent = (await p.core.state.read())!.intent;
        const run = session();
        const code = await runDaemon({ cmd: 'run', repo: dir, branch: 'main', publish: null, name: null, remote: null, confirm: null, id: null, verb: null, dataDir: null, pluginRoot: null, spawned: false }, daemonEnv(), run.io, IN_TREE_DAEMON);
        box.seen = { rec: s.rec, inflight: s.inflight[id]?.op ?? null, intentOrigin: intent.kind === 'local' ? intent.origin : null, concurrent: { code, lines: run.lines } };
      }
      return writeNew(file, data);
    };
    let out: { code: number; lines: string[] };
    try {
      out = await runResolve(dir, id, 'restore');
    } finally {
      realFs.writeFileExclusive = writeNew;
    }
    assert.equal(out.code, 0, out.lines.join('\n'));
    assert.deepEqual(out.lines, [`HOLD_RESTORED ${JSON.stringify({ hid: id, created: null })}`]);
    const at = box.seen;
    assert.ok(at !== null, 'the RESTORE wrote');
    assert.deepEqual([at.rec?.residence, at.rec?.state], ['OFF_DISK', 'PARKED'], 'settleHoldOps completed the PARK first');
    assert.equal(at.inflight, 'restore', "the RESTORE's own inflight entry (the park's was cleared)");
    assert.equal(at.intentOrigin, `restore:${id}`, "the kept park intent was resolved first: the journaled intent is the RESTORE's");
    assert.equal(at.concurrent.code, 1, at.concurrent.lines.join('\n'));
    assert.ok(at.concurrent.lines.some((l) => l.startsWith('DAEMON_ALREADY_RUNNING')), 'a daemon started during the resolve refuses on the held lock');
    assert.equal((await readWork(p, 'src/e.txt'))?.toString('utf8'), t9([2, 'two'], [6, 'six']), 'the RESTORE wrote the held version back');
    const after = await storedRecord(p, id);
    assert.deepEqual([after.rec?.residence, after.rec?.state, after.inflight], ['ON_DISK', 'ACTIVE', {}]);
    assert.equal(existsSync(join(p.deps.paths.coworkDir, 'daemon.lock')), false, 'the lock released at the end');
  });
});

test('parseDaemonArgs accepts exactly one of --publish, --discard, --park, --restore with a ULID --id; --handoff, two verbs or a missing --id are usage errors with exit 2, and the usage text lists resolve', T10, () => {
  const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  for (const verb of ['publish', 'discard', 'park', 'restore'] as const) {
    assert.deepEqual(parseDaemonArgs(['resolve', '--repo', 'r', '--branch', 'main', '--id', ID, `--${verb}`]),
      { cmd: 'resolve', repo: 'r', branch: 'main', publish: null, name: null, remote: null, confirm: null, id: ID, verb, dataDir: null, pluginRoot: null, spawned: false });
  }
  assert.deepEqual(parseDaemonArgs(['resolve', '--restore', `--id=${ID}`, '--branch=b', '--repo', 'r', '--remote', 'up']),
    { cmd: 'resolve', repo: 'r', branch: 'b', publish: null, name: null, remote: 'up', confirm: null, id: ID, verb: 'restore', dataDir: null, pluginRoot: null, spawned: false });
  const bad: string[][] = [
    ['resolve', '--repo', 'r', '--branch', 'b', '--id', ID, '--handoff'],
    ['resolve', '--repo', 'r', '--branch', 'b', '--id', ID],
    ['resolve', '--repo', 'r', '--branch', 'b', '--id', ID, '--park', '--restore'],
    ['resolve', '--repo', 'r', '--branch', 'b', '--id', ID, '--park', '--park'],
    ['resolve', '--repo', 'r', '--branch', 'b', '--park'],
    ['resolve', '--repo', 'r', '--branch', 'b', '--id', 'not-a-ulid', '--park'],
    ['resolve', '--repo', 'r', '--branch', 'b', '--id', ID, '--publish=all'],
    ['run', '--repo', 'r', '--branch', 'b', '--id', ID],
    ['run', '--repo', 'r', '--branch', 'b', '--park'],
  ];
  for (const argv of bad) {
    const r = parseDaemonArgs(argv);
    assert.ok('usage' in r && r.exitCode === 2, JSON.stringify(argv));
    assert.ok('usage' in r && r.usage.includes('daemon.js resolve'), 'the usage lists resolve');
  }
  assert.match(DAEMON_USAGE, /node dist\/daemon\.js resolve --repo <path> --branch <b> --id <hold_id> --publish\|--discard\|--park\|--restore/);
  assert.equal((parseDaemonArgs(['run', '--repo', 'r', '--branch', 'b']) as DaemonArgs).verb, null);
});

test('EngineFixture.resolve(peer, id, verb) gives the same Table 4 outcomes through Engine.resolve as resolve(core, it, …) for one record per verb', T10, async () => {
  await withEngines('dres-fixture', { n: 1, files: FILES }, async (fx) => {
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    /** One record per verb: an ON_DISK revert PATCH, except --restore's, which is PARKED (Table 4 "OFF_DISK records"). */
    const make = async (path: string, verb: ResolveVerb): Promise<string> => {
      if (verb !== 'restore') return revertOn(p, path);
      const it = await prepIt(p, { materialize: false });
      return p.core.holds.hold(nr({ paths: [path], residence: 'OFF_DISK', state: 'PARKED', blobs: pair(it.A.get(path)!.oid, await blob(p, t9([2, 'two'])), path) }));
    };
    const outcome = async (r: ResolveResult, id: string, path: string): Promise<unknown> => {
      const rec = p.core.holds.get(id)!;
      return {
        result: r.kind === 'done' ? { kind: r.kind, code: r.code, created: r.created } : r.kind === 'refused' ? { kind: r.kind, code: r.code } : r,
        record: [rec.residence, rec.state, rec.offer, rec.guards.map((g) => g.name)],
        disk: (await readWork(p, path))?.toString('utf8'),
      };
    };
    for (const verb of VERB_ROWS) {
      const viaEngine = await make(`e/${verb}.txt`, verb);
      const viaCore = await make(`c/${verb}.txt`, verb);
      const e = await fx.resolve(0, viaEngine, verb);
      const it = await prepIt(p, { forceFetch: true, holdPaths: [`c/${verb}.txt`] });
      const c = await resolve(p.core, it, viaCore, verb, HUMAN);
      assert.deepEqual(await outcome(e, viaEngine, `e/${verb}.txt`), await outcome(c, viaCore, `c/${verb}.txt`), verb);
    }
    assert.equal((await readWork(p, 'e/park.txt'))?.toString('utf8'), t9([6, 'six']), 'a real write through the engine');
    assert.equal((await readWork(p, 'e/restore.txt'))?.toString('utf8'), t9([2, 'two']));
  });
});
