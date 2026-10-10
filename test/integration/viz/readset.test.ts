// Plan 8a Task 15: the viewer's read set end to end (12 §3.3.2, §7 T-VIZ-readset; VIZ-06, VIZ-07, INV-VIZ-NOCONTENT; R-V05,
// R-V09, R-V69). Three real clones (status ok, paused, incident), each with a filtered secret file in its worktree, a staged
// plaintext copy under <gitdir>/cowork/tmp/stage/, files under prov/, cs/ and log/, and a refs/cowork-local/<e>/holds commit
// holding a canary; the data directory holds an ipc.key and a user.json and a Claude settings file sits beside it. Every git
// call the viewer makes is recorded: its argv is one of READ_SET's forms with the transport-disabling flags, no argument names
// refs/cowork-local/, and its cat-file input names only READ_SET's objects of board commits; no cat-file process serves two
// batches; the Fs port and the BoundedReader see none of the planted paths; and the canary is in no response, log line or
// stream payload. Task 20 adds the claim-input rows (one row each in READ_SET).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { READ_BATCH_MAX } from '../../../src/board/batchRead.js';
import { buildGitInvocation, type GitCallOptions } from '../../../src/git/flags.js';
import { isOid, parseOid, type Oid } from '../../../src/git/oid.js';
import type { GitResult, GitRunner } from '../../../src/git/runner.js';
import { VIZ_GIT_CONFIG, VIZ_GIT_ENV, vizGitRunner } from '../../../src/viz/source/vizGit.js';
import type { ViewerDeps } from '../../../src/viz/main.js';
import type { BoundedReader } from '../../../src/viz/source/boundedRead.js';
import { realBoundedReader } from '../../../src/viz/source/boundedRead.js';
import { VirtualClock } from '../../sim/vclock.js';
import { spyFs, type FsCall } from '../../helpers/vizFs.js';
import { openStream } from '../../helpers/vizHttp.js';
import { pubs, writeStatus } from '../../helpers/vizStore.js';
import { apiGet, gitRoomsFixture, logLines, startTestViewer, viewerTemp, worldOf, type RoomsFixture } from '../../helpers/vizViewer.js';
import { hashRaw, mktree } from '../../helpers/vizBatchRead.js';
import { FIXTURE_IDENTITY } from '../../helpers/repoFixture.js';

/**
 * The viewer's read set (12 §3.3.2 as amended by R-V05, R-V09, R-V10, R-V31, R-V69), one row per allowed form:
 *  - argv: every git argv the viewer may run (REF: a refs/cowork-remote/<e>/board ref, OID: an object id, N: a decimal count);
 *  - catFile: every object name a cat-file stdin may carry, as a suffix of a board commit's oid (the batched readers' names;
 *    `--batch` then reads the objects those names resolved to).
 * Task 20 (owner choice of 2026-10-08) adds the claim-input rows: `<commit>:<path>`, the base_blob oids, merge-base --is-ancestor.
 */
const READ_SET = {
  argv: [
    ['version'],
    ['rev-parse', '--verify', '-q', 'REF'],
    ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/cowork-remote/'],
    ['rev-list', '--first-parent', '--count', 'OID'],
    ['rev-list', '--first-parent', '--max-count=N', 'OID'],
    ['rev-list', '--first-parent', '--skip=N', '--max-count=N', 'OID'],
    ['cat-file', '--batch-check'],
    ['cat-file', '--batch'],
  ],
  catFile: [
    { suffix: '', what: 'the board commit' },
    { suffix: '^{tree}', what: 'its tree (an absent entry told from a missing object, R-V69)' },
    { suffix: ':ops.jsonl', what: 'ops.jsonl' },
    { suffix: ':protocol.json', what: 'protocol.json' },
    { suffix: ':held', what: 'the held/ tree (entry names only)' },
    { suffix: ':checkpoint', what: 'the checkpoint/ tree (R-V69)' },
    { suffix: ':checkpoint/state.json', what: 'checkpoint/state.json' },
    { suffix: '^1', what: 'the live commit of height 0' },
    { suffix: '^2', what: 'the live commit' },
  ],
} as const;

function argvForm(args: readonly string[]): readonly string[] | null {
  const token = (want: string, got: string): boolean => {
    if (want === 'REF') return /^refs\/cowork-remote\/[^\s]+\/board$/.test(got);
    if (want === 'OID') return isOid(got);
    if (want.endsWith('=N')) return got.startsWith(want.slice(0, -1)) && /^(0|[1-9][0-9]{0,9})$/.test(got.slice(want.length - 1));
    return want === got;
  };
  return READ_SET.argv.find((row) => row.length === args.length && row.every((w, i) => token(w, args[i]!))) ?? null;
}

const CANARY = 'COWORK_CANARY_READSET_3c7d';

interface Recorded { args: string[]; opts: GitCallOptions; stdin: string; stdout: string; env: Record<string, string>; dataDir: string; }

let f: RoomsFixture;
let planted: string[];
let localObjects: string[];
before(async () => {
  f = await gitRoomsFixture('viz-readset', 3);
  planted = [];
  localObjects = [];
  for (const [i, c] of f.clones.entries()) {
    await c.writer.commitMany(pubs(20 + 5 * i, `r${i}`));
    const g = c.paths.gitDir;
    const states = [{ state: 'ok' }, { state: 'paused', freeze_reasons: ['PAUSED'] }, { state: 'incident' }][i]!;
    writeStatus(g, states);
    // A filtered secret file in the worktree, a staged plaintext copy, prov/, cs/ and log/ files: never read.
    writeFileSync(join(c.dir, 'secret.env'), `TOKEN=${CANARY}\n`);
    writeFileSync(join(c.dir, '.gitattributes'), 'secret.env filter=secret\n');
    for (const rel of ['tmp/stage/0001', 'prov/p.json', 'cs/c.json', 'log/security.jsonl']) {
      const p = join(g, 'cowork', ...rel.split('/'));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${CANARY}\n`);
      planted.push(p);
    }
    // A local registry commit (refs/cowork-local/<e>/holds) holding the canary: never read.
    const fx = { repo: c.repo } as Parameters<typeof hashRaw>[0];
    const blob = await hashRaw(fx, 'blob', Buffer.from(`${CANARY}\n`, 'utf8'));
    const tree = await mktree(fx, [['100644', 'hold.json', blob]]);
    // An explicit identity: a host without a global git user.name/user.email (the hosted CI images) cannot commit without one.
    const commit = parseOid((await c.repo.run(['commit-tree', tree], { stdin: Buffer.from('holds\n'), identity: FIXTURE_IDENTITY })).stdout.toString('utf8').trim());
    await c.repo.run(['update-ref', 'refs/cowork-local/main/holds', commit]);
    localObjects.push(blob, tree, commit);
    planted.push(join(c.dir, 'secret.env'), join(c.dir, 'README.md'), join(c.dir, 'src'));
  }
});
after(async () => { await f.cleanup(); });

/** Every name a cat-file stdin may carry for the clones' board chains (READ_SET.catFile), and the oids they resolve to. */
async function allowedObjects(): Promise<{ names: Set<string>; oids: Set<string>; chains: Set<string> }> {
  const names = new Set<string>();
  const oids = new Set<string>();
  const chains = new Set<string>();
  for (const c of f.clones) {
    const list = (await c.repo.run(['rev-list', '--first-parent', c.writer.ref])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
    const these = list.flatMap((oid) => READ_SET.catFile.map((r) => `${oid}${r.suffix}`));
    for (const o of list) chains.add(o);
    for (const n of these) names.add(n);
    const r = await c.repo.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${these.join('\n')}\n`, 'utf8') });
    for (const line of r.stdout.toString('utf8').split('\n')) {
      const oid = line.split(' ')[0] ?? '';
      if (isOid(oid)) oids.add(oid);
    }
  }
  return { names, oids, chains };
}

test('T-VIZ-readset: every git argv matches the allowlist with the transport-disabling flags; no argument names refs/cowork-local/; cat-file input names only board commits, <oid>:ops.jsonl, <oid>:protocol.json, <oid>:held, <oid>:checkpoint/state.json and live commit objects; no cat-file process serves two batches; Fs and BoundedReader spies see no open under tmp/, log/ of a clone, prov/, cs/, any worktree, ipc.key, user.json or a Claude settings file', { timeout: 120_000 }, async () => {
  const root = viewerTemp('readset');
  const dataDir = join(root, 'data dir');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const n of ['ipc.key', 'user.json']) {
    writeFileSync(join(dataDir, n), `${CANARY}\n`);
    planted.push(join(dataDir, n));
  }
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), `{"x":"${CANARY}"}\n`);
  planted.push(join(root, '.claude'));

  const calls: Recorded[] = [];
  const fsCalls: FsCall[] = [];
  const reads: string[] = [];
  const reader: BoundedReader = { read: (p, max) => { reads.push(p); return realBoundedReader.read(p, max); } };
  const gitRunner: NonNullable<ViewerDeps['gitRunner']> = (o): GitRunner => {
    const inner = vizGitRunner(o);
    return {
      async run(args: string[], opts: GitCallOptions): Promise<GitResult> {
        const r = await inner.run(args, opts);
        calls.push({ args: [...args], opts, stdin: opts.stdin?.toString('utf8') ?? '', stdout: r.stdout.toString('utf8'), env: o.env, dataDir: o.dataDir });
        return r;
      },
    };
  };
  const clock = new VirtualClock();
  const v = await startTestViewer({ repos: f.clones.map((c) => c.dir), dataDir }, { clock, fs: spyFs(fsCalls), reader, gitRunner });
  const served: string[] = [];
  try {
    const s = await v.session();
    const st = await openStream(v.port, { 'x-cowork-session': s });
    const world = await worldOf(v.port, s);
    served.push(JSON.stringify(world));
    assert.deepEqual(world.rooms.map((r) => r.label), ['p1', 'p2', 'p3']);
    for (const r of world.rooms) served.push((await apiGet(v.port, s, `/api/v1/rooms/${r.room_id}/timeline?from=0&to=${r.window.h1}`)).body.toString('utf8'));
    // Live: new commits in every room, polled.
    for (const c of f.clones) await c.writer.commitMany(pubs(3, 'live'));
    for (let i = 0; i < 4; i++) {
      clock.advance(2_500);
      await new Promise((r) => setTimeout(r, 2_700));
    }
    served.push(...st.messages().map((m) => JSON.stringify(m.data)));
    st.close();
  } finally {
    await v.stop('VIZ_EXIT_SIGNAL');
  }

  // Git: the allowlist, the flags and the environment, and nothing of refs/cowork-local/.
  assert.ok(calls.some((c) => c.args[0] === 'cat-file') && calls.some((c) => c.args[0] === 'rev-parse'), 'the viewer ran git');
  const gitDirs = new Set(f.clones.map((c) => c.paths.gitDir));
  for (const c of calls) {
    assert.ok(argvForm(c.args) !== null, `argv ${JSON.stringify(c.args)} is in READ_SET`);
    assert.equal(c.opts.class, 'local');
    assert.equal(c.opts.cwd, dataDir);
    assert.deepEqual(c.opts.config, VIZ_GIT_CONFIG);
    assert.ok(c.args[0] === 'version' ? c.opts.gitDir === dataDir : gitDirs.has(c.opts.gitDir!), `--git-dir ${c.opts.gitDir}`);
    const inv = buildGitInvocation(c.args, c.opts, { hooksPath: join(c.dataDir, 'viz-no-hooks'), platform: process.platform, daemonEnv: { ...c.env, ...VIZ_GIT_ENV }, testBuild: false });
    for (const p of ['protocol.allow=never', 'protocol.file.allow=never', 'protocol.git.allow=never', 'protocol.http.allow=never', 'protocol.https.allow=never', 'protocol.ssh.allow=never', 'protocol.ext.allow=never']) {
      assert.ok(inv.argv.includes(p), `${c.args.join(' ')}: -c ${p}`);
    }
    assert.equal(inv.env['GIT_NO_LAZY_FETCH'], '1');
    assert.equal(inv.env['GIT_OPTIONAL_LOCKS'], '0');
    for (const text of [...c.args, c.stdin]) assert.ok(!text.includes('refs/cowork-local/'), `${c.args.join(' ')} names refs/cowork-local/`);
  }

  // cat-file: only READ_SET names of board chain commits; --batch only the objects the --batch-check before it resolved; one batch
  // per process (≤ READ_BATCH_MAX board commits).
  const { names, oids, chains } = await allowedObjects();
  // A room's git children run one at a time (12 §3.9.2), so its calls, in order, pair each --batch with the --batch-check before it.
  const lastCheck = new Map<string, Recorded>();
  for (const c of calls.filter((x) => x.args[0] === 'cat-file')) {
    const lines = c.stdin.split('\n').filter((l) => l.length > 0);
    assert.ok(lines.length > 0);
    for (const l of lines) assert.ok(!localObjects.includes(l.slice(0, 40)), `the local registry object ${l}`);
    if (c.args[1] === '--batch-check') {
      for (const l of lines) assert.ok(names.has(l), `--batch-check names ${l}`);
      const commits = new Set(lines.map((l) => l.replace(/[:^].*$/, '')).filter((o) => chains.has(o)));
      assert.ok(commits.size <= READ_BATCH_MAX, 'one batch per process');
      lastCheck.set(c.opts.gitDir!, c);
    } else {
      const check = lastCheck.get(c.opts.gitDir!);
      assert.ok(check !== undefined, 'a --batch follows its --batch-check');
      lastCheck.delete(c.opts.gitDir!);
      const resolved = new Set(check.stdout.split('\n').map((l) => l.split(' ')[0]!).filter((o) => isOid(o)));
      for (const l of lines) {
        assert.ok(oids.has(l), `--batch reads ${l}, an object of READ_SET`);
        assert.ok(resolved.has(l as Oid), `--batch reads ${l}, resolved by the --batch-check before it`);
      }
    }
  }

  // Files: no Fs call or bounded read under a planted path, a worktree's files or the Claude settings.
  const under = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir}/`) || p.startsWith(`${dir}\\`);
  const fsPaths = [...fsCalls.flatMap((c) => c.paths), ...reads];
  for (const p of fsPaths) {
    for (const bad of planted) assert.ok(!under(p, bad), `the viewer touched ${p}`);
    for (const c of f.clones) assert.ok(!under(p, c.dir) || under(p, c.paths.gitDir), `a worktree file ${p}`);
  }
  assert.ok(reads.some((p) => p.endsWith('status.json')), 'status.json is read (bounded)');

  // The canary: in no response, stream payload or log line.
  for (const t of [...served, ...logLines(dataDir)]) assert.ok(!t.includes(CANARY), t.slice(0, 200));
});
