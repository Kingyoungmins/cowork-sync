// Lost state (01-engine §3.14 Lost state; ENG-54; 01-engine tests 22 and 36 part; ruling R-24): the state ref vanishes
// while the engine is live, and the rebuild decides A per path from the versions on TIP's first-parent chain (≤ 500
// commits) and the disk, never seeding A wholesale and never re-joining. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildBoardCommit, CODE_SUBJECT, type WriterId } from '../../src/board/boardCommit.js';
import { newEpoch, parseOpId } from '../../src/board/ids.js';
import { applyStep } from '../../src/engine/apply.js';
import { createEngineCore } from '../../src/engine/core.js';
import { publishStep } from '../../src/engine/publish.js';
import { LOST_STATE_MAX_COMMITS, restart } from '../../src/engine/restart.js';
import { startDispatch } from '../../src/engine/start.js';
import type { Oid } from '../../src/git/oid.js';
import { pushSpec, runPush } from '../../src/git/push.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import type { LogLevel, LogParam } from '../../src/ports/log.js';
import { gitCallsOf, readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, LogRecorder, prep, stateA, withCores, wrapGit } from '../helpers/publishHelpers.js';
import { gitIn, gitRemote, localCoworkRefs, pushSpawns, restartCore, startOk, withStart } from '../helpers/startFixture.js';
import { testRunner } from '../helpers/tmp.js';

const FILES: Record<string, Buffer> = {
  'README.md': buf('# lost state fixture\n'),
  'x.txt': buf('x v0\n'),
  'y.txt': buf('y v0\n'),
  'z.txt': buf('z v0\n'),
};

/** The k-th moved-aside broken state ref of the peer's branch: tmp/broken-state-ref-<e>-<k> (per branch, final review FC). */
function asideName(p: PeerFixture, k: number): string {
  return join(p.deps.paths.coworkDir, 'tmp', `broken-state-ref-${p.core.refs.e}-${k}`);
}

/** Every moved-aside broken state ref in the peer's tmp/ (any branch's: tmp/broken-state-ref-<e>-<k>), sorted. */
function brokenAside(p: PeerFixture): string[] {
  return readdirSync(join(p.deps.paths.coworkDir, 'tmp')).filter((n) => n.startsWith('broken-state-ref-')).sort();
}

async function deleteStateRef(p: PeerFixture): Promise<void> {
  await gitIn(p, ['update-ref', '-d', p.core.refs.state]);
  assert.equal(await p.core.repo.readRef(p.core.refs.state), null);
}

async function tipMap(p: PeerFixture): Promise<Map<string, Oid>> {
  const live = (await p.core.repo.readCommit(p.core.view!.laC)).tree;
  return new Map([...(await p.core.repo.readTreeMap(live))].map(([k, v]) => [k, v.oid]));
}

async function blob(p: PeerFixture, text: string): Promise<Oid> {
  return p.core.repo.hashBytes(buf(text), false);
}

/** A commit chain on top of `from` built by one git fast-import in the peer's clone: each commit's message and file sets. */
async function fastImport(p: PeerFixture, from: Oid, commits: ReadonlyArray<{ message: string; files: Record<string, string> }>): Promise<Oid> {
  const data = (s: string): string => `data ${Buffer.byteLength(s, 'utf8')}\n${s}\n`;
  const stream: string[] = [];
  commits.forEach((c, i) => {
    const k = i + 1;
    stream.push(`commit refs/heads/chain\nmark :${k}\ncommitter Team <team@cowork.invalid> ${1_700_000_000 + k} +0000\n${data(c.message)}`);
    stream.push(k === 1 ? `from ${from}\n` : `from :${k - 1}\n`);
    for (const [path, text] of Object.entries(c.files)) stream.push(`M 100644 inline ${path}\n${data(text)}`);
    stream.push('\n');
  });
  const r = await testRunner().run(['fast-import', '--quiet', '--force'], { class: 'refupdate', cwd: p.deps.paths.workTree, stdin: Buffer.from(stream.join(''), 'utf8') });
  assert.equal(r.code, 0, r.stderr.toString('utf8'));
  return (await gitIn(p, ['rev-parse', 'refs/heads/chain'])) as Oid;
}

/** A teammate's board commit on T0 naming `tip` as live code, pushed with the leases of the current board and mirror. */
async function pushBoardOn(fx: CoreFixture, p: PeerFixture, tip: Oid): Promise<Oid> {
  const repo = p.core.repo;
  const T0 = p.core.view!.laB;
  const L0 = p.core.view!.laC;
  const writer: WriterId = { peer: 'd'.repeat(32), epoch: newEpoch(p.deps.ports.random), seq: 1 };
  const B1 = await buildBoardCommit(repo, { prevBoard: T0, liveCode: tip, writer, ops: [], cs: [], csPaths: new Map(), protocol: null, checkpoint: null });
  const pushed = await runPush(repo, fx.remote.url, [pushSpec(B1, p.core.refs.remoteBoard, T0), pushSpec(tip, p.core.refs.remoteCode, L0)], []);
  assert.equal(pushed.statuses.get(p.core.refs.remoteBoard), 'ok');
  return B1;
}

test('deleting the state ref while live rebuilds per path: matched paths take the newest matching version, unmatched LIVE paths become masked restart records, a new epoch, LOST_STATE, no re-join', async () => {
  await withCores('lost-state', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    // x.txt: v1 applied, then v2 published but not applied (the disk holds the older team version v1).
    await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    fx.advance(10_000);
    await applyStep(p.core, await prep(p));
    assert.equal((await readWork(p, 'x.txt'))?.toString('utf8'), 'x v1\n');
    const { board: T } = await fx.pushTeamChange({ 'x.txt': buf('x v2\n') });
    // y.txt: a local edit no version on the chain matches.
    await writeWork(p, 'y.txt', 'y local edit\n');
    const oldEpoch = p.core.view!.meta.epoch;
    const log = new LogRecorder();
    p.deps.log = log;

    await deleteStateRef(p);
    const r = await restart(p.core);
    assert.ok(r.lostState !== null);
    assert.equal(r.lostState.mode, 'lost_state');
    const view = p.core.view!;
    assert.equal(view.laB, T, 'LA_B := T');
    const tip = await tipMap(p);
    assert.equal(tip.get('x.txt'), await blob(p, 'x v2\n'), 'LA_C := TIP');
    const A = await stateA(p);
    assert.equal(A.get('x.txt')?.oid, await blob(p, 'x v1\n'), 'x.txt: the newest matching version, not TIP');
    assert.equal(A.get('z.txt')?.oid, tip.get('z.txt'), 'z.txt: TIP matches');
    assert.equal(A.get('y.txt')?.oid, tip.get('y.txt'), 'y.txt: unmatched, A := TIP[p] only with a record');
    const recs = p.core.holds.nonTerminal().filter((h) => h.guards.some((g) => g.name === 'restart'));
    assert.equal(recs.length, 1);
    const rec = recs[0]!;
    assert.deepEqual([rec.kind, rec.residence, rec.state, rec.paths], ['PATCH', 'ON_DISK', 'ACTIVE', ['y.txt']]);
    assert.ok('h1' in rec.blobs && rec.blobs.h1['y.txt'] === await blob(p, 'y local edit\n'), 'the record holds the disk bytes');
    assert.ok(p.core.holds.maskingRecords().some((h) => h.id === rec.id), 'masked');
    assert.deepEqual(r.lostState.records, [rec.id]);
    assert.ok(r.lostState.paths.includes('y.txt'));
    assert.notEqual(view.meta.epoch, oldEpoch, 'a new epoch');
    const lost = log.lines.filter((l) => l.code === 'LOST_STATE');
    assert.equal(lost.length, 1, 'LOST_STATE is emitted');
    assert.equal(lost[0]!.params['mode'], 'lost_state');
    assert.equal(lost[0]!.params['record_ids'], rec.id, 'LOST_STATE names the restart record ids');
    assert.equal(lost[0]!.params['record_paths'], 'y.txt', 'and their paths');
    // No re-join (the join procedure never runs); only the new epoch's join board op is queued (final review FC-7).
    assert.deepEqual(p.core.outbox.drafts().map((d) => d.type), ['join'], 'only the join op of the new epoch is queued');
    assert.equal((await readWork(p, 'y.txt'))?.toString('utf8'), 'y local edit\n', 'the local bytes stay on disk');
    // The rebuilt state is a working state: the next apply writes x v2 and y.txt is never overwritten.
    fx.advance(10_000);
    const it = await prep(p);
    await applyStep(p.core, it);
    assert.equal((await readWork(p, 'x.txt'))?.toString('utf8'), 'x v2\n');
    assert.equal((await readWork(p, 'y.txt'))?.toString('utf8'), 'y local edit\n');
  });
});

test('a QUARANTINED and a SAVE_ONLY local edit are reseeded without a record and an UNMANAGED path is never read', async () => {
  const files = {
    ...FILES,
    'CLAUDE.md': buf('# rules\n'),
    '.gitignore': buf('*.log\n'),
    '.gitattributes': buf('gen/** linguist-generated\n'),
    'gen/out.txt': buf('generated v0\n'),
  };
  await withCores('lost-state-classes', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, 'CLAUDE.md', '# rules, edited locally\n');
    await writeWork(p, '.gitignore', '*.log\n*.tmp\n');
    await writeWork(p, 'gen/out.txt', 'generated locally\n');
    const from = p.fs.calls.length;
    await deleteStateRef(p);
    const r = await restart(p.core);
    assert.ok(r.lostState !== null);
    assert.deepEqual(r.lostState.records, [], 'no record for QUARANTINED, SAVE_ONLY or UNMANAGED paths');
    const A = await stateA(p);
    const tip = await tipMap(p);
    for (const path of ['CLAUDE.md', '.gitignore', 'gen/out.txt']) assert.equal(A.get(path)?.oid, tip.get(path), `${path}: A := TIP[p]`);
    const genAbs = workPath(p, 'gen/out.txt');
    assert.deepEqual(p.fs.calls.slice(from).filter((c) => c === `readFile ${genAbs}`), [], 'the UNMANAGED path is never read');
    assert.equal((await readWork(p, 'CLAUDE.md'))?.toString('utf8'), '# rules, edited locally\n', 'kept on disk under its path-class mask');
  });
});

test('a QUARANTINED and a SAVE_ONLY path whose disk matches an older version on the chain take that version, with no record (the match branch)', async () => {
  const files = { ...FILES, 'CLAUDE.md': buf('# rules v0\n'), '.gitignore': buf('*.log\n') };
  await withCores('lost-state-classes-match', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    // The team changes both after this peer's base; the disk keeps v0 (never applied: QUARANTINED is never written live,
    // and no apply runs before the state is lost).
    await fx.pushTeamChange({ 'CLAUDE.md': buf('# rules v1\n'), '.gitignore': buf('*.log\n*.bak\n') });
    await deleteStateRef(p);
    const r = await restart(p.core);
    assert.ok(r.lostState !== null);
    assert.deepEqual(r.lostState.records, [], 'no record');
    const A = await stateA(p);
    const tip = await tipMap(p);
    assert.equal(tip.get('CLAUDE.md'), await blob(p, '# rules v1\n'));
    assert.equal(A.get('CLAUDE.md')?.oid, await blob(p, '# rules v0\n'), 'QUARANTINED: the newest version the disk matches, not TIP');
    assert.equal(A.get('.gitignore')?.oid, await blob(p, '*.log\n'), 'SAVE_ONLY: the newest version the disk matches, not TIP');
    assert.ok(r.lostState.paths.includes('CLAUDE.md') && r.lostState.paths.includes('.gitignore'), 'both were decided on the chain');
  });
});

test('the rebuild reads at most 500 first-parent commits', async () => {
  await withCores('lost-state-500', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const L0 = p.core.view!.laC;
    // 501 live commits on L0: commit 1 sets w.txt = w1, commit 2 sets v.txt = v1 and w.txt = w2, commit 3 sets v.txt
    // = v2, commits 4..501 touch filler.txt. TIP = commit 501: v1 is the version at the 500th first-parent commit
    // (counting TIP as the first), w1 only at the 501st.
    const K = LOST_STATE_MAX_COMMITS + 1;
    const commits = Array.from({ length: K }, (_, i) => {
      const k = i + 1;
      const files: Record<string, string> = k === 1 ? { 'w.txt': 'w1\n' } : k === 2 ? { 'v.txt': 'v1\n', 'w.txt': 'w2\n' } : k === 3 ? { 'v.txt': 'v2\n' } : { 'filler.txt': `filler ${k}\n` };
      return { message: CODE_SUBJECT, files };
    });
    const tip = await fastImport(p, L0, commits);
    await pushBoardOn(fx, p, tip);

    await writeWork(p, 'v.txt', 'v1\n');
    await writeWork(p, 'w.txt', 'w1\n');
    await deleteStateRef(p);
    const calls = gitCallsOf(p).length;
    const rep = await restart(p.core);
    assert.ok(rep.lostState !== null);
    const A = await stateA(p);
    assert.equal(A.get('v.txt')?.oid, await blob(p, 'v1\n'), 'v1, the version at the 500th commit, matches');
    assert.equal(A.get('w.txt')?.oid, await blob(p, 'w2\n'), 'w1 lies beyond 500 commits: A := TIP[w.txt]');
    const recs = p.core.holds.nonTerminal().filter((h) => h.guards.some((g) => g.name === 'restart'));
    assert.deepEqual(recs.map((h) => h.paths), [['w.txt']], 'the unmatched w.txt is held by a restart record');
    // The version walk of the rebuild is bounded.
    const walks = gitCallsOf(p).slice(calls).filter((c) => c.args.includes('--first-parent') && c.args.includes('--raw'));
    assert.ok(walks.length > 0);
    for (const w of walks) {
      const max = w.args.find((a) => a.startsWith('--max-count='));
      assert.ok(max !== undefined && Number(max.slice('--max-count='.length)) <= LOST_STATE_MAX_COMMITS, `bounded walk: ${w.args.join(' ')}`);
    }
  });
});

test('cs_human_next after a rebuild is 1 + the highest own human change-set on the chain; an oversized trailer number is ignored, never collapsing it', async () => {
  await withCores('lost-state-cs-next', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const self = p.core.peerId;
    const message = `${CODE_SUBJECT}\n\nCowork-CS: ${self}/human/5 closed seq=0 origin=human checks=skipped paths=1\nCowork-CS: ${self}/human/123456789012345678901234567890 closed seq=0 origin=human checks=skipped paths=1\n`;
    const tip = await fastImport(p, p.core.view!.laC, [{ message, files: { 'z.txt': 'z v1\n' } }]);
    await pushBoardOn(fx, p, tip);
    await deleteStateRef(p);
    const r = await restart(p.core);
    assert.ok(r.lostState !== null);
    assert.equal(p.core.view!.meta.cs_human_next, 6, 'n = 5 found; the unparsable 30-digit n is ignored');
  });
});

test('the LOST_STATE line names the restart record ids and paths within the glossary §19 caps', async () => {
  const names = Array.from({ length: 24 }, (_, i) => `deep/${'n'.repeat(60)}-${String(i).padStart(2, '0')}.txt`);
  const files: Record<string, Buffer> = { ...FILES };
  for (const n of names) files[n] = buf(`${n} v0\n`);
  await withCores('lost-state-log-cap', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    for (const n of names) await writeWork(p, n, `${n} edited locally\n`);
    const log = new LogRecorder();
    p.deps.log = log;
    await deleteStateRef(p);
    const r = await restart(p.core);
    assert.equal(r.lostState?.records.length, names.length, 'one record per unmatched path');
    const line = log.lines.find((l) => l.code === 'LOST_STATE');
    assert.ok(line !== undefined);
    assert.equal(line.params['records'], names.length);
    const ids = String(line.params['record_ids']);
    const paths = String(line.params['record_paths']);
    assert.ok(ids.length <= 1_050 && paths.length <= 1_050, 'each list within the 1,050-character cap');
    assert.ok(Number(line.params['record_paths_omitted']) > 0, 'the paths that did not fit are counted');
    assert.equal(ids.split(',').length + Number(line.params['record_ids_omitted']), names.length);
    assert.equal(paths.split(',').length + Number(line.params['record_paths_omitted']), names.length);
    for (const shown of paths.split(',')) assert.ok([...shown].length <= 80, `a path placeholder is at most 80 characters: ${shown}`);
  });
});

test('a broken loose state ref (garbage after a power cut) is told from an absent one by show-ref --exists, moved aside to tmp/broken-state-ref-<k> (never just deleted; removed only once the new state is committed) and rebuilt as lost state, never joined', async () => {
  await withCores('lost-state-broken-ref', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const loose = join(p.deps.paths.gitDir, ...p.core.refs.state.split('/'));
    await writeFile(loose, 'garbage\n');
    assert.equal(await p.core.repo.readRef(p.core.refs.state), null, 'for-each-ref reads a broken ref as absent');
    const log = new LogRecorder();
    p.deps.log = log;
    await restartCore(p);
    assert.equal(p.core.view, null);
    const spawns = pushSpawns(gitCallsOf(p));
    const r = await startOk(p, 'restart');
    assert.ok(r.restart?.lostState !== null && r.restart?.lostState?.mode === 'lost_state', JSON.stringify(r));
    const view = await p.core.state.read();
    assert.ok(view !== null, 'a usable state again');
    // Never joined (no join procedure); only the new epoch's join board op is queued (final review FC-7).
    assert.deepEqual(p.core.outbox.drafts().map((d) => d.type), ['join'], 'no join procedure, only the join op of the new epoch');
    const aside = asideName(p, 0);
    const at = (code: string): number => log.lines.findIndex((l) => l.code === code && (code === 'LOST_STATE' || l.params['file'] === aside));
    assert.ok(at('STATE_REF_BROKEN_MOVED') >= 0, 'the broken ref was moved aside first (STATE_REF_BROKEN_MOVED), never just deleted');
    assert.ok(at('LOST_STATE') > at('STATE_REF_BROKEN_MOVED'), 'the new state was committed (LOST_STATE)');
    assert.ok(at('STATE_REF_BROKEN_LEFTOVER_REMOVED') > at('LOST_STATE'), 'the leftover is removed only after the new state is committed');
    assert.equal(existsSync(aside), false, 'no tmp/broken-state-ref-* is left');
    assert.equal(pushSpawns(gitCallsOf(p)), spawns, 'no push at all: no genesis, no probe');
    assert.deepEqual(fx.trace.ofKind('push').filter((e) => e.peer === p.core.peerId && e.purpose === 'probe'), [], 'no probe attempt');
  });
});

test('a lost state while HEAD is on another branch refuses START_HEAD_STATE{op} and writes nothing; back on the branch it rebuilds', async () => {
  await withCores('lost-state-head', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await gitIn(p, ['checkout', '-q', '-b', 'elsewhere']);
    await deleteStateRef(p);
    const refs = await localCoworkRefs(p);
    const spawns = gitCallsOf(p).filter((c) => c.args[0] === 'fetch' || c.args[0] === 'push').length;
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_HEAD_STATE', params: { op: 'other_branch' } });
    assert.deepEqual(await localCoworkRefs(p), refs, 'no ref written');
    assert.equal(await p.core.repo.readRef(p.core.refs.state), null, 'no state');
    assert.equal(gitCallsOf(p).filter((c) => c.args[0] === 'fetch' || c.args[0] === 'push').length, spawns, 'no fetch, no push');
    await gitIn(p, ['checkout', '-q', 'main']);
    const ok = await startDispatch(p.core, { publishLocal: null });
    assert.ok(ok.ok && ok.mode === 'restart' && ok.restart?.lostState?.mode === 'lost_state', JSON.stringify(ok));
    assert.equal(p.core.view!.meta.expected_epoch.symref, 'refs/heads/main', 'the rebuilt epoch is the branch\'s');
  });
});

/** tmp/broken-state-ref-* files (any naming generation). */
function brokenAsides(p: PeerFixture): string[] {
  return readdirSync(join(p.deps.paths.coworkDir, 'tmp')).filter((n) => n.startsWith('broken-state-ref-')).sort();
}

test('final review FB-6: on Windows a lost state whose TIP holds a root drive-prefix name (a:b.txt, which no index can hold) refuses START_REPO_SHAPE{reason: path_not_indexable} and writes no state, never a GitCommandError respawn loop (deleted and broken state ref: the moved-aside ref is put back); once the name leaves TIP the same start rebuilds', {
  skip: process.platform !== 'win32' ? 'git refuses a root drive-prefix name in an index only on Windows (the POSIX twin below)' : false,
}, async () => {
  await withCores('lost-state-fb6-colon', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ 'a:b.txt': buf('ab\n'), 'x.txt': buf('x v1\n') });
    // A deleted state ref while live.
    await deleteStateRef(p);
    const refused = { ok: false, code: 'START_REPO_SHAPE', params: { reason: 'path_not_indexable' } };
    assert.deepEqual(await startDispatch(p.core, { publishLocal: null }), refused);
    assert.equal(await p.core.repo.readRef(p.core.refs.state), null, 'no state written');
    assert.deepEqual(p.core.holds.nonTerminal().filter((h) => h.guards.some((g) => g.name === 'restart')), [], 'no restart record');
    // A broken loose state ref at a fresh start: moved aside for the rebuild, put back by the refusal.
    const loose = join(p.deps.paths.gitDir, ...p.core.refs.state.split('/'));
    await mkdir(dirname(loose), { recursive: true });   // the ref's deletion pruned its directory
    await writeFile(loose, 'garbage\n');
    await restartCore(p);
    assert.deepEqual(await startDispatch(p.core, { publishLocal: null }), refused);
    assert.equal(readFileSync(loose, 'utf8'), 'garbage\n', 'the broken ref is back where it was');
    assert.deepEqual(brokenAsides(p), [], 'nothing left aside');
    // The name leaves TIP: the same start rebuilds the lost state.
    await fx.pushTeamChange({ 'a:b.txt': null });
    await restartCore(p);
    const ok = await startDispatch(p.core, { publishLocal: null });
    assert.ok(ok.ok && ok.mode === 'restart' && ok.restart?.lostState?.mode === 'lost_state', JSON.stringify(ok));
  });
});

test('final review FB-6 (POSIX twin): where git indexes a root drive-prefix name, a lost state whose TIP holds a:b.txt rebuilds: A takes TIP\'s entry, the carried name is never read or written and gets no restart record', {
  skip: process.platform === 'win32' ? 'git for Windows refuses a root drive-prefix name in an index (the Windows test above)' : false,
}, async () => {
  await withCores('lost-state-fb6-colon-posix', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await fx.pushTeamChange({ 'a:b.txt': buf('ab\n'), 'x.txt': buf('x v1\n') });
    await deleteStateRef(p);
    const ok = await startDispatch(p.core, { publishLocal: null });
    assert.ok(ok.ok && ok.mode === 'restart' && ok.restart?.lostState?.mode === 'lost_state', JSON.stringify(ok));
    assert.equal((await stateA(p)).get('a:b.txt')?.oid, await blob(p, 'ab\n'), 'A takes TIP\'s entry');
    assert.equal(await readWork(p, 'a:b.txt'), null, 'never written');
    assert.deepEqual(p.core.holds.nonTerminal().filter((h) => h.paths.includes('a:b.txt')), [], 'no record');
  });
});

test('a lost state with an unreachable remote refuses START_REMOTE{reason: unreachable} and writes nothing (a broken ref stays where it is)', async () => {
  await withCores('lost-state-offline', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const loose = join(p.deps.paths.gitDir, ...p.core.refs.state.split('/'));
    await writeFile(loose, 'garbage\n');
    await restartCore(p);
    const url = p.deps.url;
    p.deps.url = `${url}-missing`;
    const refs = await localCoworkRefs(p);
    const r = await startDispatch(p.core, { publishLocal: null });
    p.deps.url = url;
    assert.deepEqual(r, { ok: false, code: 'START_REMOTE', params: { reason: 'unreachable' } });
    assert.equal(readFileSync(loose, 'utf8'), 'garbage\n', 'the broken ref is untouched');
    assert.deepEqual(brokenAside(p), [], 'nothing moved aside');
    assert.deepEqual(await localCoworkRefs(p), refs, 'no ref written');
    // Online again: the same start rebuilds (never a join).
    await restartCore(p);
    await startOk(p, 'restart');
    assert.ok((await p.core.state.read()) !== null);
  });
});

test('a deleted (not broken) state ref while live with an unreachable remote refuses START_REMOTE{reason: unreachable} and writes nothing; online again the same start rebuilds', async () => {
  await withCores('lost-state-deleted-offline', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await deleteStateRef(p);
    const refs = await localCoworkRefs(p);
    const url = p.deps.url;
    p.deps.url = `${url}-missing`;
    let r;
    try {
      r = await startDispatch(p.core, { publishLocal: null });
    } finally {
      p.deps.url = url;
    }
    assert.deepEqual(r, { ok: false, code: 'START_REMOTE', params: { reason: 'unreachable' } });
    assert.equal(await p.core.repo.readRef(p.core.refs.state), null, 'no state written');
    assert.deepEqual(await localCoworkRefs(p), refs, 'no ref written');
    assert.deepEqual(p.core.holds.nonTerminal().filter((h) => h.guards.some((g) => g.name === 'restart')), [], 'no restart record');
    const ok = await startDispatch(p.core, { publishLocal: null });
    assert.ok(ok.ok && ok.mode === 'restart' && ok.restart?.lostState?.mode === 'lost_state', JSON.stringify(ok));
  });
});

test('a broken state ref moved aside is put back on ANY throw after the move (finally), not only on a refusal: an injected failure of the rebuild\'s fetch leaves the ref where it was', async () => {
  await withCores('lost-state-broken-throw', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const loose = join(p.deps.paths.gitDir, ...p.core.refs.state.split('/'));
    await writeFile(loose, 'garbage\n');
    const log = new LogRecorder();
    p.deps.log = log;
    await restartCore(p);
    const injected = new Error('injected: the fetch process could not be started');
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'fetch') throw injected;
      return inner(args, opts);
    });
    try {
      await assert.rejects(startDispatch(p.core, { publishLocal: null }), (e: unknown) => e === injected);
    } finally {
      restore();
    }
    assert.ok(log.lines.some((l) => l.code === 'STATE_REF_BROKEN_MOVED'), 'the ref had been moved aside');
    assert.equal(existsSync(loose) ? readFileSync(loose, 'utf8') : null, 'garbage\n', 'the broken ref is back where it was');
    assert.deepEqual(brokenAside(p), [], 'nothing left aside');
    assert.ok(log.lines.some((l) => l.code === 'STATE_REF_BROKEN_RESTORED'), 'STATE_REF_BROKEN_RESTORED');
    // The next start sees the lost state again and rebuilds (never a join).
    await restartCore(p);
    const r = await startOk(p, 'restart');
    assert.equal(r.restart?.lostState?.mode, 'lost_state');
  });
});

test('a lost state whose remote board is malformed refuses START_REMOTE{reason: board_malformed} and writes no state', async () => {
  await withCores('lost-state-malformed', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const empty = await gitRemote(fx, ['mktree']);
    const bad = (await testRunner().run(['commit-tree', empty, '-m', 'not a board commit'], {
      class: 'refupdate', cwd: fx.remote.dir, identity: { name: 'Other', email: 'other@cowork.invalid' },
    })).stdout.toString('utf8').trim();
    await gitRemote(fx, ['update-ref', p.core.refs.remoteBoard, bad]);
    await deleteStateRef(p);
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.deepEqual(r, { ok: false, code: 'START_REMOTE', params: { reason: 'board_malformed' } });
    assert.equal(await p.core.repo.readRef(p.core.refs.state), null, 'no state written');
  });
});

// ---- fix round 3 ----

/** A LogRecorder whose write throws `err` for one code (after recording it). */
class FailingLog extends LogRecorder {
  constructor(private readonly code: string, private readonly err: Error) {
    super();
  }
  override write(level: LogLevel, code: string, params?: Readonly<Record<string, LogParam>>): void {
    super.write(level, code, params);
    if (code === this.code) throw this.err;
  }
}

test('a broken state ref moved aside is put back by the move itself on any throw after its rename (its log line fails), and the post-move show-ref check runs in the caller\'s try once the aside name is known (an injected show-ref failure): the loose ref is back in place both times and the next start rebuilds the lost state', async () => {
  for (const how of ['show-ref', 'log'] as const) {
    await withCores(`lost-state-move-${how}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const loose = join(p.deps.paths.gitDir, ...p.core.refs.state.split('/'));
      const aside0 = asideName(p, 0);
      await writeFile(loose, 'garbage\n');
      const injected = new Error(`injected: ${how} failed after the move`);
      const log = how === 'log' ? new FailingLog('STATE_REF_BROKEN_MOVED', injected) : new LogRecorder();
      p.deps.log = log;
      await restartCore(p);
      let thrown = false;
      // show-ref: the one show-ref that runs while the loose file is aside (the earlier ones ran before the move).
      const restore = wrapGit(p, async (args, opts, inner) => {
        if (how === 'show-ref' && args[0] === 'show-ref' && !thrown && existsSync(aside0)) {
          thrown = true;
          throw injected;
        }
        return inner(args, opts);
      });
      try {
        await assert.rejects(startDispatch(p.core, { publishLocal: null }), (e: unknown) => e === injected, how);
      } finally {
        restore();
      }
      if (how === 'show-ref') assert.ok(thrown, 'the post-move show-ref is the call that failed');
      assert.ok(log.lines.some((l) => l.code === 'STATE_REF_BROKEN_MOVED'), `${how}: the ref had been moved aside`);
      assert.equal(existsSync(loose) ? readFileSync(loose, 'utf8') : null, 'garbage\n', `${how}: the loose ref is back in place`);
      assert.deepEqual(brokenAside(p), [], `${how}: nothing left aside`);
      assert.ok(log.lines.some((l) => l.code === 'STATE_REF_BROKEN_RESTORED'), `${how}: STATE_REF_BROKEN_RESTORED`);
      // The next start sees the lost state again and rebuilds it (never a join).
      p.deps.log = new LogRecorder();
      await restartCore(p);
      const r = await startOk(p, 'restart');
      assert.equal(r.restart?.lostState?.mode, 'lost_state', how);
      assert.ok((await p.core.state.read()) !== null, `${how}: a usable state`);
    });
  }
});

test('a crash (KilledAt) between moving a broken state ref aside and creating the new state leaves tmp/broken-state-ref-<k>, which means a state existed: the next start takes the lost-state rebuild (never JOIN, never START_PREVIEW) and removes the leftover only once the new state is committed; a leftover next to a usable state goes at that restart', async () => {
  // join: no local work (the old dispatch joined); preview: a local edit and the real crashpoint registry.cas inside the
  // rebuild (the old dispatch refused START_PREVIEW).
  for (const leg of ['preview', 'join'] as const) {
    await withCores(`lost-state-aside-crash-${leg}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const loose = join(p.deps.paths.gitDir, ...p.core.refs.state.split('/'));
      const aside0 = asideName(p, 0);
      if (leg === 'preview') await writeWork(p, 'y.txt', 'y local edit\n');
      await writeFile(loose, 'garbage\n');
      await restartCore(p);
      const point = leg === 'join' ? 'rebuild.fetch' : 'registry.cas';
      let restore = (): void => undefined;
      if (leg === 'join') {
        restore = wrapGit(p, async (args, opts, inner) => {
          if (args[0] === 'fetch' && existsSync(aside0)) throw new KilledAt(point);
          return inner(args, opts);
        });
      } else {
        setCrashHandler((name) => {
          if (name === point) throw new KilledAt(name);
        });
      }
      try {
        await assert.rejects(startDispatch(p.core, { publishLocal: null }), (e: unknown) => e instanceof KilledAt && e.point === point, `${leg}: killed at ${point}`);
      } finally {
        restore();
        setCrashHandler(null);
      }
      // The dead process left the ref aside and no state.
      assert.equal(existsSync(loose), false, `${leg}: no loose state ref`);
      assert.equal(await p.core.repo.readRef(p.core.refs.state), null, `${leg}: no state`);
      assert.equal(readFileSync(aside0, 'utf8'), 'garbage\n', `${leg}: the moved-aside bytes are intact`);

      const log = new LogRecorder();
      p.deps.log = log;
      await restartCore(p);
      const spawns = pushSpawns(gitCallsOf(p));
      const r = await startDispatch(p.core, { publishLocal: null });
      assert.ok(r.ok && r.mode === 'restart' && r.restart?.lostState?.mode === 'lost_state', `${leg}: ${JSON.stringify(r)}`);
      assert.ok((await p.core.state.read()) !== null, `${leg}: a usable state`);
      // Never joined: only the new epoch's join board op is queued (final review FC-7).
      assert.deepEqual(p.core.outbox.drafts().map((d) => d.type), ['join'], `${leg}: no join procedure, only the join op of the new epoch`);
      assert.equal(pushSpawns(gitCallsOf(p)), spawns, `${leg}: no push (no genesis, no join)`);
      if (leg === 'preview') {
        const recs = p.core.holds.nonTerminal().filter((h) => h.guards.some((g) => g.name === 'restart') && h.paths.includes('y.txt'));
        assert.equal(recs.length, 1, 'the local edit is held by one restart record');
        assert.equal((await readWork(p, 'y.txt'))?.toString('utf8'), 'y local edit\n', 'the local bytes stay on disk');
      }
      const lost = log.lines.findIndex((l) => l.code === 'LOST_STATE');
      const removed = log.lines.findIndex((l) => l.code === 'STATE_REF_BROKEN_LEFTOVER_REMOVED' && l.params['file'] === aside0);
      assert.ok(lost >= 0 && removed > lost, `${leg}: the leftover is removed after the new state is committed`);
      assert.deepEqual(brokenAside(p), [], `${leg}: no leftover`);

      if (leg === 'join') {
        // A leftover next to a usable state (a crash after the commit, before the removal): the restart removes it.
        const stray = asideName(p, 7);
        await writeFile(stray, 'garbage\n');
        await restartCore(p);
        const again = await startOk(p, 'restart');
        assert.equal(again.restart?.lostState, null, 'a usable state: an ordinary restart');
        assert.deepEqual(brokenAside(p), [], 'the leftover next to a usable state is removed');
      }
    });
  }
});

test('final review FC-7: a lost-state rebuild queues the join op of its new epoch (ENG-54\'s "never re-join" is the join procedure, not the board op), so its next publish carries the join first and every later op of this peer folds on a teammate', async () => {
  await withCores('lost-fc7-join', { n: 2, files: FILES }, async (fx) => {
    const [p, q] = [fx.peers[0]!, fx.peers[1]!];
    const oldEpoch = p.core.view!.meta.epoch;
    await deleteStateRef(p);
    await restart(p.core);
    const epoch = p.core.view!.meta.epoch;
    assert.notEqual(epoch, oldEpoch, 'a new epoch');
    const queued = p.core.outbox.drafts().map((d) => d.type);
    // A later board op of this peer under the new epoch (an EPOCH freeze event).
    p.core.outbox.add({ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'FREEZE_EPOCH' });
    for (let i = 0; i < 6 && p.core.outbox.size > 0; i++) {
      fx.advance(6_000);
      await publishStep(p.core, await prep(p));
    }
    assert.equal(p.core.outbox.size, 0, 'the ops landed');
    // The teammate's fold: this peer's recorded epoch is the new one, and its event op was accepted.
    fx.advance(6_000);
    const it = await prep(q);
    const rec = it.fold.peers[p.core.peerId];
    assert.equal(rec?.epoch, epoch, `the teammate's fold records the new epoch (recorded: ${String(rec?.epoch)}, old: ${oldEpoch})`);
    assert.ok(
      Object.values(it.fold.events).some((e) => e.kind === 'freeze' && parseOpId(e.op_id)?.peer === p.core.peerId && parseOpId(e.op_id)?.epoch === epoch),
      'the later event op of the new epoch folded on the teammate',
    );
    assert.deepEqual(queued, ['join'], 'the rebuild queued exactly the join op');
  });
});

test('final review FC round 2 (R-01 after a lost state, pinned): the rebuild leaves no local delta for a re-formed open CS: every path where A differs from S_disk is held by a masked restart record (ENG-54), the open CS of the lost state is not carried over, the next ticks observe nothing, and a later edit opens the human CS as usual', async () => {
  await withCores('lost-state-r01', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    // x.txt: v1 applied, v2 published but not applied (the disk holds the older team version v1).
    await fx.pushTeamChange({ 'x.txt': buf('x v1\n') });
    fx.advance(10_000);
    await applyStep(p.core, await prep(p));
    await fx.pushTeamChange({ 'x.txt': buf('x v2\n') });
    // y.txt: a local edit that only the open human CS holds (an open CS is never journaled, R-01).
    await writeWork(p, 'y.txt', 'y local edit\n');
    fx.advance(1_000);
    await prep(p);
    assert.deepEqual([...p.core.cs.openPaths()], ['y.txt'], 'the open human CS holds y.txt');

    await deleteStateRef(p);
    const r = await restart(p.core);
    assert.equal(r.lostState?.mode, 'lost_state');
    const view = p.core.view!;
    const A = await stateA(p);
    const S = await p.core.repo.readTreeMap(view.snap);
    const delta = [...new Set([...A.keys(), ...S.keys()])].filter((q) => A.get(q)?.oid !== S.get(q)?.oid).sort();
    assert.deepEqual(delta, ['y.txt'], 'diff(A, S_disk) after the rebuild is the unmatched local edit only (x.txt took its matching version)');
    const masked = new Set(p.core.holds.maskingRecords().filter((h) => h.guards.some((g) => g.name === 'restart')).flatMap((h) => h.paths));
    for (const q of delta) assert.ok(masked.has(q), `${q}: held by a masked restart record, so a re-formed CS could publish nothing of it`);
    assert.deepEqual([...p.core.cs.openPaths()], [], 'the open CS of the lost state is not carried over');
    for (let i = 0; i < 2; i++) {
      fx.advance(1_000);
      const it = await prep(p);
      assert.deepEqual([...it.tick!.changed], [], `tick ${i}: the rebuild's own snapshot already holds the disk, nothing is observed`);
    }
    assert.deepEqual([...p.core.cs.openPaths()], [], 'no CS opened');
    await writeWork(p, 'z.txt', 'z local edit\n');
    fx.advance(1_000);
    await prep(p);
    assert.deepEqual([...p.core.cs.openPaths()], ['z.txt'], 'a later edit opens the human CS as usual');
  });
});

test('final review FC minor: a moved-aside broken state ref belongs to its branch (tmp/broken-state-ref-<e>-<k>): another branch\'s leftover neither sends this branch\'s start to the lost-state rebuild nor is removed by it', async () => {
  await withStart('lost-state-aside-branch', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    // Branch 'feature' of this clone: its broken state ref is moved aside, and the process dies before the new state.
    await gitIn(p, ['checkout', '-q', '-b', 'feature']);
    const feature = await createEngineCore({ ...p.deps, branch: 'feature' });
    const loose = join(p.deps.paths.gitDir, ...feature.refs.state.split('/'));
    await mkdir(dirname(loose), { recursive: true });
    await writeFile(loose, 'garbage\n');
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'fetch' && brokenAside(p).length > 0) throw new KilledAt('rebuild.fetch');
      return inner(args, opts);
    });
    try {
      await assert.rejects(startDispatch(feature, { publishLocal: null }), (e: unknown) => e instanceof KilledAt, 'feature: killed after the move aside');
    } finally {
      restore();
    }
    const left = brokenAside(p);
    assert.equal(left.length, 1, `the feature branch left its broken ref aside: ${left.join(',')}`);
    // Branch main of the same clone never had a state: its start is a genesis, and the other branch's leftover stays.
    await gitIn(p, ['checkout', '-q', 'main']);
    const r = await startDispatch(p.core, { publishLocal: null });
    assert.ok(r.ok && r.mode === 'genesis', `main: a genesis, never the lost-state path of another branch: ${JSON.stringify(r)}`);
    assert.deepEqual(brokenAside(p), left, 'the other branch\'s leftover is not removed');
  });
});

test('final review FC minor: brokenStateLeftovers fails closed: a tmp/ listing that fails (EACCES) stops the start of a clone with no state ref (an error), never a genesis or join that could stand in for a state that existed', async () => {
  await withStart('lost-state-aside-readdir', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const tmp = join(p.deps.paths.coworkDir, 'tmp');
    const orig = p.fs.readdir.bind(p.fs);
    Reflect.set(p.fs, 'readdir', async (dir: string): Promise<string[]> => {
      if (dir === tmp) throw Object.assign(new Error(`EACCES: permission denied, scandir '${dir}'`), { code: 'EACCES' });
      return orig(dir);
    });
    const refs = await localCoworkRefs(p);
    try {
      await assert.rejects(startDispatch(p.core, { publishLocal: null }), (e: unknown) => (e as { code?: unknown }).code === 'EACCES', 'the failed listing is an error');
    } finally {
      Reflect.deleteProperty(p.fs, 'readdir');
    }
    assert.deepEqual(await localCoworkRefs(p), refs, 'nothing written');
    assert.equal(await p.core.repo.readRef(p.core.refs.state), null, 'no state');
  });
});

test('final review FC minor: a lost state checks the repo identity before it re-pins: a state ref deleted while live compares the remote branch with the pinned roots, a broken one with HEAD\'s roots; another repository on the remote refuses START_REPO_IDENTITY and writes no state', async () => {
  for (const how of ['deleted', 'broken'] as const) {
    await withCores(`lost-state-identity-${how}`, { n: 1, files: FILES }, async (fx) => {
      const p = fx.peers[0]!;
      const loose = join(p.deps.paths.gitDir, ...p.core.refs.state.split('/'));
      // The remote's branch now names another repository.
      const empty = await gitRemote(fx, ['mktree']);
      const foreign = (await testRunner().run(['commit-tree', empty, '-m', 'another repository'], {
        class: 'refupdate', cwd: fx.remote.dir, identity: { name: 'Other', email: 'other@cowork.invalid' },
      })).stdout.toString('utf8').trim();
      await gitRemote(fx, ['update-ref', 'refs/heads/main', foreign]);
      if (how === 'deleted') {
        await deleteStateRef(p);
      } else {
        await writeFile(loose, 'garbage\n');
        await restartCore(p);
      }
      const r = await startDispatch(p.core, { publishLocal: null });
      assert.deepEqual(r, { ok: false, code: 'START_REPO_IDENTITY', params: {} }, how);
      assert.equal(await p.core.repo.readRef(p.core.refs.state), null, `${how}: no state written`);
      if (how === 'broken') assert.equal(readFileSync(loose, 'utf8'), 'garbage\n', 'broken: the ref is back where it was');
      assert.deepEqual(brokenAside(p), [], `${how}: nothing left aside`);
    });
  }
});
