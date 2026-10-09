// The real-remote two-clone sync test and its cleanup (Plan 2 Task 20; TST-16; ruling R-34; glossary §4 test ref prefix
// `refs/cowork-ci/<run_id>/…` and branch `ci/<run_id>/<b>`; 11-testing §2 REAL-HOST mode). Of TC-TST-05 these tests check
// the refusal and that nothing is pushed: TEST_TARGET_REFUSED, and the remote's reference-transaction log gains no
// entry. They do not check its zero-network-call count: the marker check reads the default branch before refusing.
// Every test runs against file:// bare remotes under a temp root, an ssh transport shim onto one, or an https URL that
// git maps onto one by url.<file url>.insteadOf (no network); the
// manual run against the sandbox GitHub repository is the controller's. The rehearsal (genesis, join and the three
// scenarios on real clocks) takes minutes and runs only with COWORK_REAL_REHEARSAL=1. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refNames, testNamespace } from '../../src/engine/refs.js';
import { ABSENT } from '../../src/git/oid.js';
import type { GitRunner } from '../../src/git/runner.js';
import { CleanupRefused, cleanupMain, cleanupRun, deleteRunRefs, isRunRef } from '../../tools/real/cleanup.js';
import {
  checkTestTarget, ConvergeFatal, ffHistoryOf, k4LocalStageCheck, refuseBadUrl, scratchRepo, stopReason, storedFormMatches, TwoCloneFailed,
  TwoCloneInterrupted, TwoCloneRefused, twoCloneMain, twoCloneRun, waitConverged, type TwoCloneOptions, type TwoCloneReport,
} from '../../tools/real/two-clone.js';
import { seedRemote } from '../sim/peers.js';
import { createBareRemote, type BareRemote } from '../sim/remote.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const TWO_CLONE = fileURLToPath(new URL('../../tools/real/two-clone.ts', import.meta.url));
const runner = testRunner();
/** A URL holding a password: refused (TEST_TARGET_REFUSED{password_in_url}), it never reaches git. */
const TOKEN_URL = 'https://user:token@host/x';
/** A URL holding only a login user: it reaches git as given, and is printed without the user. */
const LOGIN_URL = 'https://user@host/x';
const MARKER = '.cowork-test-repo';
const SSH_USER = 'user';
const SSH_URL = `ssh://${SSH_USER}@sandbox.invalid/remote.git`;
const SSH_SHOWN = 'ssh://sandbox.invalid/remote.git';

interface Io { out(l: string): void; err(l: string): void; }
function capture(): { io: Io; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

/** No printed line carries a URL's userinfo: neither a password (`user:token`, `u:p@`) nor a login user (`user@`). */
function noUserinfo(lines: readonly string[]): void {
  for (const l of lines) {
    for (const bit of ['user:token', 'token@', 'user@', ':p@', 'u:@']) assert.ok(!l.includes(bit), `a printed line carries the userinfo (${bit}): ${l}`);
  }
}

/** The meta.pinned.url of a clone's local state commit (refs/cowork-local/<e>/state:meta). */
async function pinnedUrl(dir: string, runId: string): Promise<string> {
  const state = refNames(`ci/${runId}/main`, testNamespace(runId)).state;
  const meta = JSON.parse(await must(runner, ['cat-file', 'blob', `${state}:meta`], dir)) as { pinned: { url: string } };
  return meta.pinned.url;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function must(git: GitRunner, args: string[], cwd: string): Promise<string> {
  const r = await git.run(args, { class: 'local', cwd, identity: { name: 'T', email: 't@cowork.invalid' }, wallMsForDates: 1_700_000_000_000 });
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8').trim();
}

/** A remote seeded on main with `files` (Plan 1 seedRemote). */
async function remoteWith(root: string, files: Record<string, string>): Promise<{ remote: BareRemote; main: string }> {
  const remote = await createBareRemote(root, runner);
  const main = await seedRemote(remote, root, runner, Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v, 'utf8')])));
  return { remote, main };
}

/** Lands one commit holding `files` on refs/heads/<branch> of the remote (another branch than the default). */
async function pushBranch(remote: BareRemote, root: string, branch: string, files: Record<string, string>): Promise<string> {
  const dir = join(root, `branch-${branch.replace(/[^A-Za-z0-9]/g, '_')}`);
  await must(runner, ['init', '-q', '-b', 'x', dir], root);
  await must(runner, ['config', 'core.autocrlf', 'false'], dir);
  for (const [p, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), text);
  }
  await must(runner, ['add', '-A'], dir);
  await must(runner, ['commit', '-q', '-m', 'other'], dir);
  const r = await runner.run(['push', '-q', remote.url, `HEAD:refs/heads/${branch}`], { class: 'network', cwd: dir });
  assert.equal(r.code, 0, r.stderr.toString('utf8'));
  return must(runner, ['rev-parse', 'HEAD'], dir);
}

// An ssh transport onto the bare remotes under `base`: git runs it as GIT_SSH_COMMAND (variant simple, so git passes
// `<host> <command>`). It logs every call's arguments, refuses a host that lacks the URL's userinfo (so a call made with a
// sanitized URL fails) and serves `git-upload-pack '<path>'` / `git-receive-pack '<path>'` from `base`. `userinfo` is
// the login user it expects (`user`), or a `user:password` pair for a URL the harness must refuse before any call.
const SHIM_JS = [
  "import { appendFileSync, readFileSync } from 'node:fs';",
  "import { spawnSync } from 'node:child_process';",
  "import { dirname, join, resolve } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'const here = dirname(fileURLToPath(import.meta.url));',
  "const conf = JSON.parse(readFileSync(join(here, 'shim.json'), 'utf8'));",
  'const args = process.argv.slice(2);',
  "appendFileSync(join(here, 'calls.jsonl'), JSON.stringify(args) + '\\n');",
  "const host = args[args.length - 2] ?? '';",
  "const command = args[args.length - 1] ?? '';",
  "if (!host.startsWith(conf.userinfo + '@')) { process.stderr.write('shim: the host lacks the userinfo\\n'); process.exit(3); }",
  "const m = /^git[ -](upload-pack|receive-pack) '([^']*)'$/.exec(command);",
  "if (m === null) { process.stderr.write('shim: unexpected command\\n'); process.exit(4); }",
  "const r = spawnSync('git', [m[1], resolve(conf.base, m[2].replace(/^\\/+/, ''))], { stdio: 'inherit' });",
  'process.exit(r.status === null ? 5 : r.status);',
  '',
].join('\n');

async function sshShim(base: string, userinfo: string = SSH_USER): Promise<{ env: Record<string, string>; calls: () => Promise<string[][]>; cleanup: () => Promise<void> }> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'cowork-sshshim-')));
  await writeFile(join(dir, 'shim.mjs'), SHIM_JS);
  await writeFile(join(dir, 'shim.json'), JSON.stringify({ base, userinfo }));
  const q = (p: string): string => `'${p.replace(/\\/g, '/')}'`;
  return {
    env: { GIT_SSH_COMMAND: `${q(process.execPath)} ${q(join(dir, 'shim.mjs'))}`, GIT_SSH_VARIANT: 'simple' },
    calls: async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as string[]),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function report(over: Partial<TwoCloneReport> = {}): TwoCloneReport {
  return { runId: '01TESTRUN0000000000000000A', branch: 'ci/01TESTRUN0000000000000000A/main', scenarios: [{ name: 'different-files', ok: true, detail: 'ok' }], converged: true, ffHistory: true, pushes: 4, k4Records: 1, elapsedS: 1.5, ...over };
}

test('a remote whose default branch lacks .cowork-test-repo is refused with TEST_TARGET_REFUSED and zero pushes', async () => {
  const { root, cleanup } = await makeTempRoot('real-refuse');
  try {
    const { remote } = await remoteWith(root, { 'README.md': '# a user repository\n' });
    // The marker on a branch other than the default one does not count.
    await pushBranch(remote, root, 'sandbox', { [MARKER]: 'not the default branch\n' });
    const refsBefore = await remote.refs();
    const txBefore = (await remote.readRefTxLog()).length;

    // The library refuses before any push.
    const log: string[] = [];
    await assert.rejects(
      twoCloneRun({ url: remote.url, root: join(root, 'run'), timeoutMs: 60_000, log: (l) => log.push(l) }),
      (e: unknown) => e instanceof TwoCloneRefused && e.code === 'TEST_TARGET_REFUSED' && e.params['reason'] === 'no_marker',
    );

    // The CLI prints the code and exits 1.
    const cli = capture();
    const code = await twoCloneMain([], { ...process.env, COWORK_REAL_REMOTE: remote.url }, cli.io);
    assert.equal(code, 1, cli.lines.join('\n'));
    assert.ok(cli.lines.some((l) => l.startsWith('TEST_TARGET_REFUSED ')), cli.lines.join('\n'));

    // An unreachable remote is refused the same way (never a hang, never a prompt).
    const gone = capture();
    assert.equal(await twoCloneMain([], { ...process.env, COWORK_REAL_REMOTE: `${remote.url}-missing` }, gone.io), 1, gone.lines.join('\n'));
    assert.ok(gone.lines.some((l) => l.startsWith('TEST_TARGET_REFUSED ') && l.includes('unreachable')), gone.lines.join('\n'));

    // The cleanup refuses the same remote too, before listing or deleting anything.
    const cl = capture();
    assert.equal(await cleanupMain(['--remote', remote.url, '--run', 'RUN1', '--yes'], process.env, cl.io), 1, cl.lines.join('\n'));
    assert.ok(cl.lines.some((l) => l.startsWith('TEST_TARGET_REFUSED ')), cl.lines.join('\n'));

    // Zero pushes: no ref transaction reached the remote and its refs are unchanged.
    assert.equal((await remote.readRefTxLog()).length, txBefore, 'no ref update on the remote');
    assert.deepEqual(await remote.refs(), refsBefore);
  } finally {
    await cleanup();
  }
});

test('with COWORK_REAL_REMOTE unset the CLI prints usage and exits 0 without network', async () => {
  // PATH holds only an empty directory: a git process could not even be started, so exit 0 proves none was.
  const empty = await mkdtemp(join(tmpdir(), 'cowork-nopath-'));
  try {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(env)) if (/^(path|cowork_real_remote)$/i.test(k)) delete env[k];
    env['PATH'] = empty;
    for (const [args, extra] of [[[], {}], [['--keep', '--timeout-min', '3'], {}], [[], { COWORK_REAL_REMOTE: '  ' }]] as const) {
      // --no-warnings: Node 20 prints an ExperimentalWarning for --import loader hooks; nothing else may reach stderr.
      const r = spawnSync(process.execPath, ['--no-warnings', '--import', 'tsx', TWO_CLONE, ...args], { cwd: REPO, encoding: 'utf8', env: { ...env, ...extra } });
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /^usage: COWORK_REAL_REMOTE=<https url> npm run real:two-clone \[-- --timeout-min 15 --keep\]$/m);
      assert.equal(r.stderr, '');
    }
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('the rehearsal against a file:// remote holding .cowork-test-repo runs genesis, join and the three scenarios to convergence with ffHistory true and one K4 record', {
  skip: process.env['COWORK_REAL_REHEARSAL'] === '1' ? false : 'set COWORK_REAL_REHEARSAL=1 (real clocks, takes minutes)',
}, async () => {
  const { root, cleanup } = await makeTempRoot('real-rehearsal');
  try {
    const { remote, main } = await remoteWith(root, { [MARKER]: 'cowork-sync throwaway test repository\n', 'README.md': '# sandbox\n' });
    const txBefore = (await remote.readRefTxLog()).length;
    const log: string[] = [];
    const started = Date.now();
    const report: TwoCloneReport = await twoCloneRun({ url: remote.url, root: join(root, 'run'), timeoutMs: 12 * 60_000, log: (l) => log.push(l) });
    const why = `${JSON.stringify(report, null, 1)}\n${log.join('\n')}`;
    assert.match(report.runId, /^[0-9A-Z]{26}$/, why);
    assert.equal(report.branch, `ci/${report.runId}/main`, why);
    assert.deepEqual(report.scenarios.map((s) => [s.name, s.ok]), [['different-files', true], ['same-file-10-rows-apart', true], ['same-line', true]], why);
    assert.equal(report.converged, true, why);
    assert.equal(report.ffHistory, true, why);
    assert.equal(report.k4Records, 1, why);
    assert.ok(report.pushes >= 3, why);   // the branch create, genesis and at least one publish
    assert.ok(report.elapsedS > 0 && report.elapsedS <= (Date.now() - started) / 1_000 + 1, why);
    assert.ok(log.some((l) => l.includes(`npm run real:cleanup -- --remote ${remote.url} --run ${report.runId} --yes`)), why);

    // The remote: the default branch untouched, the run branch at its head, every ref update inside the run's namespace
    // or on its branch, and no deletion but the engine's own probe ref (INV-OID; the harness never deletes a remote ref).
    const refs = await remote.refs();
    assert.equal(refs['refs/heads/main'], main);
    assert.equal(refs[`refs/heads/ci/${report.runId}/main`], main);
    const prefix = `refs/cowork-ci/${report.runId}/`;
    const tx = (await remote.readRefTxLog()).slice(txBefore);
    assert.ok(tx.length > 0);
    for (const e of tx) {
      assert.ok(e.ref.startsWith(prefix) || e.ref === `refs/heads/ci/${report.runId}/main`, `ref update outside the run: ${e.ref}`);
      if (/^0+$/.test(e.new)) assert.ok(e.ref.startsWith(`${prefix}probe-`), `deleted ${e.ref}`);
    }
    assert.ok(Object.keys(refs).every((r) => !r.startsWith('refs/cowork/')), 'nothing in the release namespace');
  } finally {
    await cleanup();
  }
});

test('every report line passes through sanitizeUrl', async () => {
  // A URL holding a password (https://user:token@host/x) never runs: the CLI refuses it and prints it without the token.
  const never = async (): Promise<TwoCloneReport> => { throw new Error('the run must not start'); };
  const refused = capture();
  assert.equal(await twoCloneMain([], { COWORK_REAL_REMOTE: TOKEN_URL }, refused.io, never), 1, refused.lines.join('\n'));
  assert.ok(refused.lines.includes('TEST_TARGET_REFUSED {"reason":"password_in_url","remote":"https://host/x"}'), refused.lines.join('\n'));

  // A login user only: the run receives the URL as given (git needs it), and nothing printed (log lines, the report, an
  // error, the cleanup command) carries the userinfo, even when a log line or a detail echoes the raw URL.
  const fake = (detail: string) => async (opts: TwoCloneOptions): Promise<TwoCloneReport> => {
    assert.equal(opts.url, LOGIN_URL);
    opts.log(`git said: fatal: could not read from ${LOGIN_URL}`);
    return report({ scenarios: [{ name: 'different-files', ok: true, detail }], k4Records: 0 });
  };
  const ok = capture();
  assert.equal(await twoCloneMain([], { COWORK_REAL_REMOTE: LOGIN_URL }, ok.io, fake(`converged at ${LOGIN_URL}`)), 0, ok.lines.join('\n'));
  assert.ok(ok.lines.some((l) => l.includes('https://host/x')), ok.lines.join('\n'));
  assert.ok(ok.lines.some((l) => l === 'cleanup: npm run real:cleanup -- --remote https://host/x --run 01TESTRUN0000000000000000A --yes'), ok.lines.join('\n'));
  const boom = capture();
  const thrower = async (): Promise<TwoCloneReport> => { throw new Error(`boom at ${LOGIN_URL}`); };
  assert.equal(await twoCloneMain(['--timeout-min', '2'], { COWORK_REAL_REMOTE: LOGIN_URL }, boom.io, thrower), 2, boom.lines.join('\n'));
  noUserinfo([...refused.lines, ...ok.lines, ...boom.lines]);

  // The library: a login-user URL on a marker-less remote is refused; no log line or error message carries the user,
  // and the log shows the URL without it.
  const { root, cleanup } = await makeTempRoot('real-sanitize');
  try {
    const { remote } = await remoteWith(root, { 'README.md': '# no marker\n' });
    const withUser = remote.url.replace(/^file:\/\//, 'file://user@');
    const log: string[] = [];
    let message = '';
    await assert.rejects(twoCloneRun({ url: withUser, root: join(root, 'run'), timeoutMs: 60_000, log: (l) => log.push(l) }), (e: unknown) => {
      message = e instanceof Error ? `${e.message} ${JSON.stringify((e as TwoCloneRefused).params ?? {})}` : String(e);
      return e instanceof TwoCloneRefused && e.code === 'TEST_TARGET_REFUSED';
    });
    noUserinfo([...log, message]);
    assert.ok(log.some((l) => l.includes(remote.url)), log.join('\n'));
  } finally {
    await cleanup();
  }
});

test('cleanup lists and deletes only refs/cowork-ci/<run_id>/* and refs/heads/ci/<run_id>/*, and refuses any other ref', async () => {
  const RUN = '01TESTRUN1';
  const OTHER = '01TESTRUN2';
  const { root, cleanup } = await makeTempRoot('real-cleanup');
  try {
    const { remote, main } = await remoteWith(root, { [MARKER]: 'cowork-sync throwaway test repository\n' });
    const e = `ci%2F${RUN}%2Fmain`;
    const ofRun = [`refs/cowork-ci/${RUN}/${e}/board`, `refs/cowork-ci/${RUN}/${e}/code`, `refs/cowork-ci/${RUN}/${e}/displaced/0123456789ab`, `refs/heads/ci/${RUN}/main`];
    const others = [
      'refs/cowork/main/board', `refs/cowork-ci/${OTHER}/x/board`, `refs/heads/ci/${OTHER}/main`,
      `refs/cowork-ci/${RUN}x/x/board`, `refs/heads/ci/${RUN}x/main`, `refs/tags/refs/cowork-ci/${RUN}/decoy`, `refs/heads/feature/refs/heads/ci/${RUN}/main`,
    ];
    for (const ref of [...ofRun, ...others]) await must(runner, ['update-ref', ref, main], remote.dir);
    const before = await remote.refs();

    // The run-ref test itself.
    for (const ref of ofRun) assert.equal(isRunRef(RUN, ref), true, ref);
    for (const ref of [...others, 'refs/heads/main', `refs/cowork-ci/${RUN}/`, `refs/cowork-ci/${RUN}`, `refs/heads/ci/${RUN}`, `refs/cowork-ci/${RUN}/../x`]) assert.equal(isRunRef(RUN, ref), false, ref);
    for (const bad of ['', '*', 'a/b', '..', `${RUN} x`]) assert.equal(isRunRef(bad, `refs/cowork-ci/${bad}/x`), false, bad);

    // Without --yes: the run's refs are listed, nothing is deleted.
    const listLog: string[] = [];
    const listed = await cleanupRun({ url: remote.url, runId: RUN, yes: false, log: (l) => listLog.push(l) });
    assert.deepEqual(listed.listed.map((x) => x.ref), [...ofRun].sort(), listLog.join('\n'));
    assert.deepEqual(listed.deleted, []);
    assert.deepEqual(await remote.refs(), before);

    // A deletion request naming any other ref is refused as a whole before any git call.
    const repo = await scratchRepo(join(root, 'scratch'), runner);
    for (const foreign of ['refs/heads/main', `refs/cowork-ci/${OTHER}/x/board`, `refs/tags/refs/cowork-ci/${RUN}/decoy`]) {
      await assert.rejects(deleteRunRefs(repo, remote.url, RUN, [{ ref: ofRun[0]!, oid: main }, { ref: foreign, oid: main }]), (x: unknown) => x instanceof CleanupRefused && x.refs.includes(foreign), foreign);
    }
    await assert.rejects(deleteRunRefs(repo, remote.url, '*', [{ ref: 'refs/cowork-ci/*/x', oid: main }]), CleanupRefused);
    assert.deepEqual(await remote.refs(), before, 'a refused request deletes nothing');

    // The CLI: a bad run id is a usage error; without --yes it lists; with --yes it deletes exactly the run's refs.
    for (const bad of ['*', `${RUN}/x`, '']) {
      const s = capture();
      assert.equal(await cleanupMain(['--remote', remote.url, '--run', bad], process.env, s.io), 2, `${bad}: ${s.lines.join('\n')}`);
    }
    const dry = capture();
    assert.equal(await cleanupMain(['--remote', remote.url, '--run', RUN], process.env, dry.io), 0, dry.lines.join('\n'));
    for (const ref of ofRun) assert.ok(dry.lines.some((l) => l.endsWith(` ${ref}`)), `${ref} listed: ${dry.lines.join('\n')}`);
    assert.deepEqual(await remote.refs(), before);
    const del = capture();
    assert.equal(await cleanupMain(['--remote', remote.url, '--run', RUN, '--yes'], process.env, del.io), 0, del.lines.join('\n'));
    const after = await remote.refs();
    const expected = Object.fromEntries(Object.entries(before).filter(([ref]) => !ofRun.includes(ref)));
    assert.deepEqual(after, expected, 'exactly the run refs are gone');
    for (const tx of (await remote.readRefTxLog()).filter((t) => /^0+$/.test(t.new))) assert.ok(ofRun.includes(tx.ref), `deleted ${tx.ref}`);

    // Nothing left: a second run lists nothing and deletes nothing.
    const again = await cleanupRun({ url: remote.url, runId: RUN, yes: true, log: () => undefined });
    assert.deepEqual([again.listed, again.deleted, again.failed], [[], [], []]);
  } finally {
    await cleanup();
  }
});

test("a remote URL starting with '-' is refused with TEST_TARGET_REFUSED before any git call, by both CLIs and the library", async () => {
  // PATH holds only an empty directory: had any git call been tried, it would have failed as unreachable or internal.
  const empty = await mkdtemp(join(tmpdir(), 'cowork-nopath-'));
  const { root, cleanup } = await makeTempRoot('real-dashurl');
  try {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
    env['PATH'] = empty;
    const refusedInvalid = (e: unknown): boolean => e instanceof TwoCloneRefused && e.code === 'TEST_TARGET_REFUSED' && e.params['reason'] === 'invalid_url';
    for (const bad of ['--upload-pack=touch PWNED', '-oProxyCommand=calc', 'https://host/x\n--upload-pack=y']) {
      const never = async (): Promise<TwoCloneReport> => { throw new Error('the run must not start'); };
      const cli = capture();
      assert.equal(await twoCloneMain([], { ...env, COWORK_REAL_REMOTE: bad }, cli.io, never), 1, cli.lines.join('\n'));
      assert.ok(cli.lines.some((l) => l.startsWith('TEST_TARGET_REFUSED ') && l.includes('"invalid_url"')), cli.lines.join('\n'));
      assert.ok(cli.lines.some((l) => l.startsWith('next: ')), cli.lines.join('\n'));

      const cl = capture();
      assert.equal(await cleanupMain(['--remote', bad, '--run', 'RUN1', '--yes'], env, cl.io), 1, cl.lines.join('\n'));
      assert.ok(cl.lines.some((l) => l.startsWith('TEST_TARGET_REFUSED ') && l.includes('"invalid_url"')), cl.lines.join('\n'));

      const runRoot = join(root, 'run');
      await assert.rejects(twoCloneRun({ url: bad, root: runRoot, timeoutMs: 60_000, log: () => undefined, env }), refusedInvalid);
      assert.equal(await exists(join(runRoot, 'probe')), false, 'no scratch repository was created');
      await assert.rejects(cleanupRun({ url: bad, runId: 'RUN1', yes: true, log: () => undefined, env }), refusedInvalid);
    }
    const repo = await scratchRepo(join(root, 'scratch'), runner);
    await assert.rejects(checkTestTarget(repo, '--upload-pack=touch PWNED'), refusedInvalid);
  } finally {
    await cleanup();
    await rm(empty, { recursive: true, force: true });
  }
});

test('twoCloneRun talks to git with the raw remote URL while every line it prints has the URL sanitized', async () => {
  const { root, cleanup } = await makeTempRoot('real-rawurl');
  const shim = await sshShim(root);
  try {
    await remoteWith(root, { 'README.md': '# no marker\n' });
    const log: string[] = [];
    let refusal: TwoCloneRefused | null = null;
    // Reaching the marker check (no_marker, not unreachable) means every call carried the userinfo: the shim refuses
    // any host without it.
    await assert.rejects(twoCloneRun({ url: SSH_URL, root: join(root, 'run'), timeoutMs: 60_000, log: (l) => log.push(l), env: { ...process.env, ...shim.env } }), (e: unknown) => {
      if (!(e instanceof TwoCloneRefused)) return false;
      refusal = e;
      return e.code === 'TEST_TARGET_REFUSED' && e.params['reason'] === 'no_marker';
    });
    const calls = await shim.calls();
    assert.ok(calls.length >= 3, JSON.stringify(calls));   // ls-remote --symref, ls-remote, fetch
    for (const c of calls) assert.equal(c[c.length - 2], `${SSH_USER}@sandbox.invalid`, JSON.stringify(c));
    const r = refusal as TwoCloneRefused | null;
    assert.equal(r?.params['remote'], SSH_SHOWN);
    noUserinfo([...log, r?.message ?? '', JSON.stringify(r?.params ?? {})]);
    assert.ok(log.some((l) => l.includes(SSH_SHOWN)), log.join('\n'));
  } finally {
    await shim.cleanup();
    await cleanup();
  }
});

test('twoCloneMain passes its env on to the git runner, as cleanupMain does, and both print the remote URL sanitized', async () => {
  const RUN = '01TESTRUNENV';
  const { root, cleanup } = await makeTempRoot('real-env');
  const shim = await sshShim(root);
  try {
    const { remote, main } = await remoteWith(root, { 'README.md': '# no marker yet\n' });
    const env = { ...process.env, ...shim.env };
    // The two-clone CLI: only the env it was given holds the transport, so no_marker (not unreachable) proves it reached git.
    const cli = capture();
    assert.equal(await twoCloneMain(['--timeout-min', '1'], { ...env, COWORK_REAL_REMOTE: SSH_URL }, cli.io), 1, cli.lines.join('\n'));
    assert.ok(cli.lines.some((l) => l.startsWith('TEST_TARGET_REFUSED ') && l.includes('"no_marker"') && l.includes(SSH_SHOWN)), cli.lines.join('\n'));
    noUserinfo(cli.lines);
    const before = (await shim.calls()).length;
    assert.ok(before >= 3, `${before} calls`);

    // The cleanup CLI on a marked remote: lists and deletes the run's refs through the transport, printing the URL
    // without its userinfo, while every git call carried it.
    const marked = await pushBranch(remote, root, 'marked', { [MARKER]: 'cowork-sync throwaway test repository\n' });
    await must(runner, ['symbolic-ref', 'HEAD', 'refs/heads/marked'], remote.dir);
    const ofRun = [`refs/cowork-ci/${RUN}/x/board`, `refs/heads/ci/${RUN}/main`];
    for (const ref of ofRun) await must(runner, ['update-ref', ref, main], remote.dir);
    const dry = capture();
    assert.equal(await cleanupMain(['--remote', SSH_URL, '--run', RUN], env, dry.io), 0, dry.lines.join('\n'));
    assert.ok(dry.lines.some((l) => l.includes(`of run ${RUN} on ${SSH_SHOWN}`)), dry.lines.join('\n'));
    const del = capture();
    assert.equal(await cleanupMain(['--remote', SSH_URL, '--run', RUN, '--yes'], env, del.io), 0, del.lines.join('\n'));
    const refs = await remote.refs();
    for (const ref of ofRun) assert.equal(refs[ref], undefined, ref);
    assert.equal(refs['refs/heads/marked'], marked);
    noUserinfo([...dry.lines, ...del.lines]);
    const calls = await shim.calls();
    assert.ok(calls.length > before, JSON.stringify(calls));
    for (const c of calls) assert.equal(c[c.length - 2], `${SSH_USER}@sandbox.invalid`, JSON.stringify(c));
  } finally {
    await shim.cleanup();
    await cleanup();
  }
});

test('the target check reads the default branch from the HEAD symref, not a hard-coded main (a remote whose default branch is trunk)', async () => {
  const { root, cleanup } = await makeTempRoot('real-trunk');
  try {
    // Default branch trunk holds the marker and there is no main: accepted, on trunk.
    const r1 = join(root, 'r1');
    await mkdir(r1, { recursive: true });
    const one = await createBareRemote(r1, runner, 'trunk');
    const trunkHead = await pushBranch(one, r1, 'trunk', { [MARKER]: 'cowork-sync throwaway test repository\n' });
    const t = await checkTestTarget(await scratchRepo(join(root, 's1'), runner), one.url);
    assert.deepEqual(t, { defaultRef: 'refs/heads/trunk', head: trunkHead });

    // Default branch trunk without the marker, main with it: refused, naming trunk.
    const r2 = join(root, 'r2');
    await mkdir(r2, { recursive: true });
    const two = await createBareRemote(r2, runner, 'trunk');
    await pushBranch(two, r2, 'trunk', { 'README.md': '# a user repository\n' });
    await pushBranch(two, r2, 'main', { [MARKER]: 'not the default branch\n' });
    await assert.rejects(checkTestTarget(await scratchRepo(join(root, 's2'), runner), two.url), (e: unknown) =>
      e instanceof TwoCloneRefused && e.code === 'TEST_TARGET_REFUSED' && e.params['reason'] === 'no_marker' && e.params['default_branch'] === 'trunk');
  } finally {
    await cleanup();
  }
});

test('cleanup leases each deletion on its listed oid, refuses a ref named twice, and exits 1 when a deletion fails', async () => {
  const RUN = '01TESTRUNLEASE';
  const { root, cleanup } = await makeTempRoot('real-lease');
  try {
    const { remote, main } = await remoteWith(root, { [MARKER]: 'cowork-sync throwaway test repository\n' });
    const other = await pushBranch(remote, root, 'other', { 'x.txt': 'another commit\n' });
    const board = `refs/cowork-ci/${RUN}/x/board`;
    const code = `refs/cowork-ci/${RUN}/x/code`;
    const branch = `refs/heads/ci/${RUN}/main`;
    const plant = async (): Promise<void> => { for (const ref of [board, code, branch]) await must(runner, ['update-ref', ref, main], remote.dir); };
    await plant();
    const repo = await scratchRepo(join(root, 'scratch'), runner);
    const { listed } = await cleanupRun({ url: remote.url, runId: RUN, yes: false, log: () => undefined });
    assert.deepEqual(listed.map((r) => r.ref), [board, code, branch].sort());

    // A ref named twice refuses the whole request; nothing is deleted.
    await assert.rejects(deleteRunRefs(repo, remote.url, RUN, [listed[0]!, listed[0]!]), (e: unknown) => e instanceof CleanupRefused && /named twice/.test(e.message));
    assert.equal((await remote.refs())[board], main);

    // A ref that moved after the listing keeps its new value: its deletion is leased on the listed oid.
    await must(runner, ['update-ref', board, other], remote.dir);
    const res = await deleteRunRefs(repo, remote.url, RUN, listed);
    assert.deepEqual(res, { deleted: [branch, code].sort(), failed: [board] });
    const after = await remote.refs();
    assert.equal(after[board], other);
    assert.equal(after[code], undefined);
    assert.equal(after[branch], undefined);

    // A deletion the remote rejects: cleanupMain names it and exits 1.
    await plant();
    await remote.rejectNext(1, 'policy', `/${RUN}/`);
    const cli = capture();
    assert.equal(await cleanupMain(['--remote', remote.url, '--run', RUN, '--yes'], process.env, cli.io), 1, cli.lines.join('\n'));
    for (const ref of [board, code, branch]) assert.ok(cli.lines.includes(`  not deleted: ${ref}`), cli.lines.join('\n'));
    assert.equal((await remote.refs())[board], main);
  } finally {
    await cleanup();
  }
});

test('ffHistoryOf and the K4 LOCAL-stage check fail on planted inputs', async () => {
  const { root, cleanup } = await makeTempRoot('real-planted');
  try {
    const dir = join(root, 'chain');
    await must(runner, ['init', '-q', '-b', 'main', dir], root);
    const commit = async (msg: string, parent: string | null): Promise<string> => {
      const tree = await must(runner, ['mktree'], dir);
      return must(runner, ['commit-tree', tree, '-m', msg, ...(parent === null ? [] : ['-p', parent])], dir);
    };
    const c1 = await commit('c1', null);
    const c2 = await commit('c2', c1);
    const c3 = await commit('c3', c2);
    const x = await commit('x', null);
    const repo = await scratchRepo(dir, runner);
    const peer = (name: string, tips: string[]): { name: string; repo: typeof repo; tips: string[] } => ({ name, repo, tips });

    assert.equal((await ffHistoryOf([peer('A', [c1, c2, c2, c3]), peer('B', [c1, c3])])).ok, true);
    assert.equal((await ffHistoryOf([peer('A', [c1, c3]), peer('B', [c2])])).ok, true);
    for (const [why, peers] of [
      ['a rewind on one peer', [peer('A', [c1, c3, c2]), peer('B', [c3])]],
      ['an unrelated tip', [peer('A', [c1, x]), peer('B', [c1])]],
      ['two chains', [peer('A', [c1, c2]), peer('B', [x])]],
      ['a peer that fetched nothing', [peer('A', [c1]), peer('B', [])]],
      ['a malformed tip', [peer('A', [c1, 'not-an-oid']), peer('B', [c1])]],
    ] as const) {
      assert.equal((await ffHistoryOf(peers)).ok, false, why);
    }

    const blob = async (text: string): Promise<string> => {
      const r = await runner.run(['hash-object', '-w', '--stdin'], { class: 'local', cwd: dir, stdin: Buffer.from(text, 'utf8') });
      assert.equal(r.code, 0);
      return r.stdout.toString('utf8').trim();
    };
    const bOwn = await blob('row 24\nrow 25 edited on B\nrow 26\n');
    assert.equal(await k4LocalStageCheck(repo, 'B', bOwn), null);
    assert.match((await k4LocalStageCheck(repo, 'A', bOwn)) ?? '', /LOCAL stage/);
    assert.match((await k4LocalStageCheck(repo, 'B', await blob('row 25\n'))) ?? '', /LOCAL stage/);
    assert.match((await k4LocalStageCheck(repo, 'B', null)) ?? '', /LOCAL stage/);
    assert.match((await k4LocalStageCheck(repo, 'B', ABSENT)) ?? '', /LOCAL stage/);
    assert.match((await k4LocalStageCheck(repo, 'B', '1'.repeat(40))) ?? '', /LOCAL stage/);
  } finally {
    await cleanup();
  }
});

test('the disk check compares the stored form: exact bytes on the autocrlf=false peer, the checkout form only on the autocrlf=true peer', () => {
  const b = (s: string): Buffer => Buffer.from(s, 'latin1');
  // Peer A (core.autocrlf=false): the bytes on disk are the stored bytes; CRLF stays CRLF and LF stays LF.
  assert.equal(storedFormMatches(false, b('a\nb\n'), b('a\nb\n')), true);
  assert.equal(storedFormMatches(false, b('a\r\nb\r\n'), b('a\r\nb\r\n')), true);
  assert.equal(storedFormMatches(false, b('a\r\nb\r\n'), b('a\nb\n')), false);
  assert.equal(storedFormMatches(false, b('a\nb\n'), b('a\r\nb\r\n')), false);
  // Peer B (core.autocrlf=true): the stored bytes or their checkout form (every LF as CRLF), nothing looser.
  assert.equal(storedFormMatches(true, b('a\r\nb\r\n'), b('a\nb\n')), true);
  assert.equal(storedFormMatches(true, b('a\nb\n'), b('a\nb\n')), true);
  assert.equal(storedFormMatches(true, b('a\r\nb\n'), b('a\nb\n')), false);
  assert.equal(storedFormMatches(true, b('a\r\nc\r\n'), b('a\nb\n')), false);
  // Absent on disk and in the tree match; one without the other does not.
  for (const crlf of [false, true]) {
    assert.equal(storedFormMatches(crlf, null, null), true);
    assert.equal(storedFormMatches(crlf, null, b('a\n')), false);
    assert.equal(storedFormMatches(crlf, b('a\n'), null), false);
  }
});

test('a convergence wait retries a transient probe error, fails at once on a stopped loop or a status that cannot converge, and needs two quiet polls', async () => {
  const T1 = { T: 'a'.repeat(40), pushes: 3 };
  const T2 = { T: 'b'.repeat(40), pushes: 4 };
  type C = typeof T1;
  const seq = (items: ReadonlyArray<C | string | Error>): { probe: () => Promise<C | string>; count: () => number } => {
    let i = 0;
    return {
      probe: async () => {
        const x = items[Math.min(i++, items.length - 1)]!;
        if (x instanceof Error) throw x;
        return x;
      },
      count: () => i,
    };
  };
  const o = (over: Partial<{ deadline: number; signal: AbortSignal }> = {}): { deadline: number; pollMs: number; quietPolls: number; signal?: AbortSignal } => ({ deadline: Date.now() + 60_000, pollMs: 1, quietPolls: 2, ...over });

  // A transient error is retried; convergence needs the same tip and no push attempt for two more polls.
  const a = seq([new Error('EBUSY: resource busy or locked'), 'LA_B differs', T1, T1, T1]);
  assert.deepEqual(await waitConverged(a.probe, o()), T1);
  assert.equal(a.count(), 5);
  // A new tip or a push attempt during the quiet period restarts it.
  const b = seq([T1, T1, T2, T2, T2]);
  assert.deepEqual(await waitConverged(b.probe, o()), T2);
  assert.equal(b.count(), 5);
  const c = seq([T1, { ...T1, pushes: 4 }, { ...T1, pushes: 4 }, { ...T1, pushes: 4 }]);
  assert.deepEqual(await waitConverged(c.probe, o()), { ...T1, pushes: 4 });
  assert.equal(c.count(), 4);
  // A fatal condition fails at once with its reason, long before the deadline.
  const d = seq(['LA_B differs', new ConvergeFatal('B: the loop ended with Error: CAS lost')]);
  const t0 = Date.now();
  await assert.rejects(waitConverged(d.probe, o({ deadline: Date.now() + 600_000 })), (e: unknown) => e instanceof ConvergeFatal && /loop ended/.test(e.message));
  assert.equal(d.count(), 2);
  assert.ok(Date.now() - t0 < 5_000);
  // The deadline: the last reason, as a string.
  assert.equal(await waitConverged(seq(['A: a publish is pending']).probe, o({ deadline: Date.now() + 30 })), 'timeout: A: a publish is pending');
  // An interrupt ends the wait.
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(waitConverged(seq(['x']).probe, o({ signal: ac.signal })), TwoCloneInterrupted);

  // What can never converge without a human: a loop that ended, and these statuses.
  const st = (state: string, pause: string | null = null, code: string | null = null): { state: string; publish_pause: string | null; message_code: string | null; message_params: Record<string, unknown> } =>
    ({ state, publish_pause: pause, message_code: code, message_params: {} });
  assert.match(stopReason('A', null, { error: new Error('CAS lost') }) ?? '', /^A: .*loop.*CAS lost/);
  assert.match(stopReason('B', null, { error: undefined }) ?? '', /^B: .*loop/);
  for (const s of [st('incident', null, 'INCIDENT'), st('refused', null, 'START_HEAD_AHEAD'), st('down'), st('frozen', null, 'FROZEN'), st('paused', null, 'PAUSED'),
    st('degraded', 'NONRETRYABLE', 'NONRETRYABLE'), st('degraded', 'VERSION', 'VERSION_PAUSED'), st('offline', 'AUTH', 'OFFLINE')]) {
    assert.match(stopReason('A', s as never, null) ?? '', /^A: /, JSON.stringify(s));
  }
  for (const s of [st('ok'), st('degraded', null, 'NOT_CONVERGED'), st('offline', 'OFFLINE', 'OFFLINE'), st('ok', null, 'HOST_THROTTLED')]) {
    assert.equal(stopReason('A', s as never, null), null, JSON.stringify(s));
  }
});

test('a remote board rewritten during a scenario fails that scenario at once with the INCIDENT it causes, not at the deadline', async () => {
  const RUN = '01TESTRUNINCIDENT';
  const { root, cleanup } = await makeTempRoot('real-incident');
  try {
    const { remote, main } = await remoteWith(root, { [MARKER]: 'cowork-sync throwaway test repository\n' });
    const boardRef = refNames(`ci/${RUN}/main`, testNamespace(RUN)).remoteBoard;
    let rewritten: Promise<number> | null = null;
    let failedAt = 0;
    const log: string[] = [];
    const r = await twoCloneRun({
      url: remote.url, root: join(root, 'run'), timeoutMs: 180_000, runId: RUN,
      log: (l) => {
        log.push(l);
        // The board rewound to a commit that is no board commit: every engine's next fetch is an incident.
        if (rewritten === null && l.includes('scenario different-files')) rewritten = must(runner, ['update-ref', boardRef, main], remote.dir).then(() => Date.now());
        if (failedAt === 0 && l.includes('scenario different-files FAILED')) failedAt = Date.now();
      },
    });
    const why = `${JSON.stringify(r, null, 1)}\n${log.join('\n')}`;
    assert.ok(rewritten !== null && failedAt > 0, why);
    const at = await (rewritten as Promise<number>);
    assert.equal(r.converged, false, why);
    assert.equal(r.scenarios[0]?.ok, false, why);
    assert.match(r.scenarios[0]?.detail ?? '', /INCIDENT/, why);
    assert.deepEqual(r.scenarios.slice(1).map((s) => [s.name, s.ok, s.detail]), [
      ['same-file-10-rows-apart', false, 'not run: an earlier scenario failed'],
      ['same-line', false, 'not run: an earlier scenario failed'],
    ], why);
    // At once: a few loop periods and polls after the rewrite, far inside the 180 s deadline (a timeout detail reads
    // "timeout: …", so the INCIDENT detail above already rules the deadline out; this bounds the time on a loaded PC).
    assert.ok(failedAt - at < 90_000, `${failedAt - at} ms after the rewrite: ${why}`);
  } finally {
    await cleanup();
  }
});

test('an environmental failure after the target check is TwoCloneFailed with a next step, and the CLI exits 1 with it, never 2', async () => {
  const RUN = '01TESTRUNLEFT';
  const { root, cleanup } = await makeTempRoot('real-envfail');
  try {
    const { remote, main } = await remoteWith(root, { [MARKER]: 'cowork-sync throwaway test repository\n' });
    await must(runner, ['update-ref', `refs/cowork-ci/${RUN}/x/board`, main], remote.dir);
    const txBefore = (await remote.readRefTxLog()).length;
    await assert.rejects(twoCloneRun({ url: remote.url, root: join(root, 'run'), timeoutMs: 60_000, log: () => undefined, runId: RUN }), (e: unknown) =>
      e instanceof TwoCloneFailed && /not empty/.test(e.message) && e.next.includes(`--run ${RUN}`));
    assert.equal((await remote.readRefTxLog()).length, txBefore, 'nothing pushed');

    // A clone that fails after the run branch was pushed: TwoCloneFailed, and its next step names the cleanup.
    const RUN2 = '01TESTRUNCLONE';
    const runRoot = join(root, 'run2');
    await mkdir(join(runRoot, 'A'), { recursive: true });
    await writeFile(join(runRoot, 'A', 'in-the-way.txt'), 'x');
    await assert.rejects(twoCloneRun({ url: remote.url, root: runRoot, timeoutMs: 60_000, log: () => undefined, runId: RUN2 }), (e: unknown) =>
      e instanceof TwoCloneFailed && /git clone .* into A failed/.test(e.message) && e.next.includes(`npm run real:cleanup -- --remote ${remote.url} --run ${RUN2} --yes`));
    assert.ok((await remote.refs())[`refs/heads/ci/${RUN2}/main`] !== undefined, 'the run branch was pushed before the clone');

    const cli = capture();
    let runId = '';
    const failing = async (o: TwoCloneOptions): Promise<TwoCloneReport> => {
      runId = o.runId ?? '';
      throw new TwoCloneFailed(`git clone into A failed (exit 128) at ${LOGIN_URL}`, 'check the network, then run again');
    };
    assert.equal(await twoCloneMain([], { COWORK_REAL_REMOTE: LOGIN_URL }, cli.io, failing), 1, cli.lines.join('\n'));
    assert.match(runId, /^[0-9A-Z]{26}$/);
    assert.ok(cli.lines.some((l) => l.startsWith('two-clone: FAILED git clone into A failed (exit 128)')), cli.lines.join('\n'));
    assert.ok(cli.lines.includes('next: check the network, then run again'), cli.lines.join('\n'));
    assert.ok(cli.lines.includes(`cleanup: npm run real:cleanup -- --remote https://host/x --run ${runId} --yes`), cli.lines.join('\n'));
    noUserinfo(cli.lines);
  } finally {
    await cleanup();
  }
});

test('the CLI exits 0 on a passing run and 1 on a failing one, removes its temp root, and keeps it with --keep', async () => {
  const cases: Array<[Partial<TwoCloneReport>, string[], number]> = [[{}, [], 0], [{ converged: false }, [], 1], [{ ffHistory: false }, [], 1], [{}, ['--keep'], 0], [{ converged: false }, ['--keep'], 1]];
  for (const [over, argv, want] of cases) {
    let root = '';
    const run = async (o: TwoCloneOptions): Promise<TwoCloneReport> => {
      root = o.root;
      await writeFile(join(o.root, 'left-behind.txt'), 'x');
      return report({ ...over, runId: o.runId ?? 'none', branch: `ci/${o.runId ?? 'none'}/main` });
    };
    const c = capture();
    const label = `${JSON.stringify(over)} ${argv.join(' ')}: ${c.lines.join('\n')}`;
    assert.equal(await twoCloneMain(argv, { COWORK_REAL_REMOTE: 'https://host/x' }, c.io, run), want, label);
    assert.notEqual(root, '');
    const keep = argv.includes('--keep');
    assert.equal(await exists(join(root, 'left-behind.txt')), keep, label);
    if (keep) {
      assert.ok(c.lines.includes(`two-clone: kept ${root}`), c.lines.join('\n'));
      await rm(dirname(root), { recursive: true, force: true });
    }
  }
});

test('Ctrl+C stops the run, removes the temp root unless --keep, prints the cleanup command and exits 130', async () => {
  for (const keep of [false, true]) {
    const sig = new EventEmitter();
    let seen: TwoCloneOptions | null = null;
    const run = async (o: TwoCloneOptions): Promise<TwoCloneReport> => {
      seen = o;
      const signal = o.signal;
      if (signal === undefined) throw new Error('the run got no abort signal');
      sig.emit('SIGINT');
      if (!signal.aborted) await new Promise<void>((res) => signal.addEventListener('abort', () => res()));
      throw new TwoCloneInterrupted();
    };
    const c = capture();
    assert.equal(await twoCloneMain(keep ? ['--keep'] : [], { COWORK_REAL_REMOTE: LOGIN_URL }, c.io, run, sig), 130, c.lines.join('\n'));
    const o = seen as TwoCloneOptions | null;
    assert.ok(o !== null);
    assert.match(o.runId ?? '', /^[0-9A-Z]{26}$/);
    assert.ok(c.lines.includes(`cleanup: npm run real:cleanup -- --remote https://host/x --run ${o.runId} --yes`), c.lines.join('\n'));
    assert.equal(await exists(o.root), keep, c.lines.join('\n'));
    assert.equal(sig.listenerCount('SIGINT'), 0, 'the handler is removed');
    noUserinfo(c.lines);
    if (keep) await rm(dirname(o.root), { recursive: true, force: true });
  }
});

test('an interrupted run stops both loops with drain and releases both daemon locks; every git call of the run got the raw URL and no clone stores its userinfo', async () => {
  const { root, cleanup } = await makeTempRoot('real-interrupt');
  const shim = await sshShim(root);
  try {
    const { remote } = await remoteWith(root, { [MARKER]: 'cowork-sync throwaway test repository\n' });
    const env = { ...process.env, ...shim.env };
    // Interrupted during the target check: TwoCloneInterrupted, nothing pushed.
    const early = new AbortController();
    early.abort();
    const txBefore = (await remote.readRefTxLog()).length;
    await assert.rejects(twoCloneRun({ url: SSH_URL, root: join(root, 'early'), timeoutMs: 60_000, env, signal: early.signal, log: () => undefined }), TwoCloneInterrupted);
    assert.equal((await remote.readRefTxLog()).length, txBefore, 'nothing pushed');

    const RUN = '01TESTRUNINTERRUPT';
    const runRoot = join(root, 'run');
    const ac = new AbortController();
    let abortedAt = 0;
    const log: string[] = [];
    await assert.rejects(twoCloneRun({
      url: SSH_URL, root: runRoot, timeoutMs: 120_000, env, signal: ac.signal, runId: RUN,
      log: (l) => {
        log.push(l);
        if (abortedAt === 0 && l.includes('scenario different-files')) {
          abortedAt = Date.now();
          ac.abort();
        }
      },
    }), (e: unknown) => e instanceof TwoCloneInterrupted, log.join('\n'));
    assert.ok(abortedAt > 0 && Date.now() - abortedAt < 60_000, log.join('\n'));
    for (const name of ['A', 'B']) {
      const cowork = join(runRoot, name, '.git', 'cowork');
      const status = JSON.parse(await readFile(join(cowork, 'status.json'), 'utf8')) as { state: string };
      assert.equal(status.state, 'down', `${name}: the loop drained`);
      assert.equal(await exists(join(cowork, 'daemon.lock')), false, `${name}: daemon.lock released`);
      assert.equal(await must(runner, ['config', '--get', 'remote.origin.url'], join(runRoot, name)), SSH_SHOWN);
      assert.equal(await pinnedUrl(join(runRoot, name), RUN), SSH_SHOWN, `${name}: meta.pinned.url keeps no userinfo`);
    }
    const calls = await shim.calls();
    assert.ok(calls.length >= 6, JSON.stringify(calls));   // the target check, the branch push, two clones, the engines' calls
    for (const c of calls) assert.equal(c[c.length - 2], `${SSH_USER}@sandbox.invalid`, JSON.stringify(c));
    noUserinfo(log);
  } finally {
    await shim.cleanup();
    await cleanup();
  }
});

test('a remote URL holding a password (user:secret@) is refused with TEST_TARGET_REFUSED{password_in_url} before any git call, push or write, by both CLIs and the library', async () => {
  const PASSWORD_URLS = [
    'https://u:p@host/x', 'https://:p@host/x', 'https://u:@host/x', 'http://u:p@host:8080/x', 'ssh://u:p@sandbox.invalid/remote.git',
    'u:p@sandbox.invalid:remote.git',
  ];
  // A login user (scheme or scp form), no userinfo, an '@' that is no userinfo, an encoded ':' (part of a user name).
  const NO_PASSWORD = ['https://user@host/x', 'git@host:remote.git', 'ssh://git@host/remote.git', 'https://host/x', 'file:///C:/a@b/remote.git', 'C:/a@b/remote.git', 'https://u%3Ap@host/x'];
  const isPassword = (e: unknown): boolean => e instanceof TwoCloneRefused && e.code === 'TEST_TARGET_REFUSED' && e.params['reason'] === 'password_in_url';
  for (const u of PASSWORD_URLS) assert.throws(() => refuseBadUrl(u), isPassword, u);
  for (const u of NO_PASSWORD) assert.doesNotThrow(() => refuseBadUrl(u), u);

  // PATH holds only an empty directory: had any git call been tried, it would have failed as unreachable or internal.
  const empty = await mkdtemp(join(tmpdir(), 'cowork-nopath-'));
  const { root, cleanup } = await makeTempRoot('real-password');
  // A transport that would serve this very password: a call reaching it would show in its log.
  const shim = await sshShim(root, 'u:p');
  try {
    const noGit: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(noGit)) if (/^path$/i.test(k)) delete noGit[k];
    noGit['PATH'] = empty;
    const repo = await scratchRepo(join(root, 'scratch'), runner);
    for (const bad of PASSWORD_URLS) {
      // The run never starts and the CLI exits 1: the refusal comes before its temp root and the run.
      const never = async (): Promise<TwoCloneReport> => { throw new Error('the run must not start'); };
      const cli = capture();
      assert.equal(await twoCloneMain([], { ...noGit, COWORK_REAL_REMOTE: bad }, cli.io, never), 1, `${bad}: ${cli.lines.join('\n')}`);
      assert.ok(cli.lines.some((l) => l.startsWith('TEST_TARGET_REFUSED {"reason":"password_in_url"')), cli.lines.join('\n'));
      assert.ok(cli.lines.some((l) => l.startsWith('next: ') && l.includes('credential helper')), cli.lines.join('\n'));

      const cl = capture();
      assert.equal(await cleanupMain(['--remote', bad, '--run', 'RUN1', '--yes'], noGit, cl.io), 1, `${bad}: ${cl.lines.join('\n')}`);
      assert.ok(cl.lines.some((l) => l.startsWith('TEST_TARGET_REFUSED {"reason":"password_in_url"')), cl.lines.join('\n'));

      const runRoot = join(root, 'run');
      const said: string[] = [];
      let message = '';
      await assert.rejects(twoCloneRun({ url: bad, root: runRoot, timeoutMs: 60_000, log: (l) => said.push(l), env: noGit }), (e: unknown) => {
        message = e instanceof TwoCloneRefused ? `${e.message} ${e.next}` : String(e);
        return isPassword(e);
      }, bad);
      assert.equal(await exists(runRoot), false, `${bad}: nothing written`);
      await assert.rejects(cleanupRun({ url: bad, runId: 'RUN1', yes: true, log: (l) => said.push(l), env: noGit }), isPassword, bad);
      await assert.rejects(checkTestTarget(repo, bad), isPassword, bad);
      // The password (and any userinfo) appears nowhere: not in a printed line, a log line or the refusal.
      for (const l of [...cli.lines, ...cl.lines, ...said, message]) assert.ok(!l.includes('@'), `${bad}: ${l}`);
    }

    // A real remote holding the marker behind that transport: the library and the CLI refuse before any call, push or write.
    const pw = 'ssh://u:p@sandbox.invalid/remote.git';
    const { remote } = await remoteWith(root, { [MARKER]: 'cowork-sync throwaway test repository\n' });
    const txBefore = (await remote.readRefTxLog()).length;
    const refsBefore = await remote.refs();
    const env = { ...process.env, ...shim.env };
    const runRoot = join(root, 'shim-run');
    const ac = new AbortController();
    const log: string[] = [];
    // Were it not refused, the run would stop on its own Ctrl+C right after pushing the run branch.
    await assert.rejects(twoCloneRun({
      url: pw, root: runRoot, timeoutMs: 60_000, env, signal: ac.signal,
      log: (l) => { log.push(l); if (l.includes('created ci/')) ac.abort(); },
    }), isPassword, log.join('\n'));
    await assert.rejects(cleanupRun({ url: pw, runId: 'RUN1', yes: true, log: (l) => log.push(l), env }), isPassword);
    const sig = new EventEmitter();
    const lines: string[] = [];
    const io: Io = { out: (l) => { lines.push(l); if (l.includes('created ci/')) sig.emit('SIGINT'); }, err: (l) => lines.push(l) };
    assert.equal(await twoCloneMain(['--timeout-min', '1'], { ...env, COWORK_REAL_REMOTE: pw }, io, twoCloneRun, sig), 1, lines.join('\n'));
    assert.deepEqual(await shim.calls(), [], 'no git call reached the remote');
    assert.equal((await remote.readRefTxLog()).length, txBefore, 'nothing pushed');
    assert.deepEqual(await remote.refs(), refsBefore);
    assert.equal(await exists(runRoot), false, 'nothing written');
    assert.deepEqual(log, []);
    for (const l of lines) assert.ok(!l.includes('@'), l);
  } finally {
    await shim.cleanup();
    await cleanup();
    await rm(empty, { recursive: true, force: true });
  }
});

test("a remote URL with a login user and no password (https://user@host/x) reaches git and both engines; neither clone's meta.pinned.url nor any printed line holds the userinfo", async () => {
  // The CLI hands the URL to the run as given, for a login user in either form, and prints it without the user.
  for (const [given, shown] of [[LOGIN_URL, 'https://host/x'], ['git@host:remote.git', 'host:remote.git']] as const) {
    let got = '';
    const run = async (o: TwoCloneOptions): Promise<TwoCloneReport> => {
      got = o.url;
      return report({ runId: o.runId ?? 'none', branch: `ci/${o.runId ?? 'none'}/main` });
    };
    const c = capture();
    assert.equal(await twoCloneMain([], { COWORK_REAL_REMOTE: given }, c.io, run), 0, c.lines.join('\n'));
    assert.equal(got, given);
    assert.ok(c.lines.some((l) => l.startsWith(`cleanup: npm run real:cleanup -- --remote ${shown} --run `)), c.lines.join('\n'));
    noUserinfo(c.lines);
    for (const l of c.lines) assert.ok(!l.includes('git@'), l);
  }

  // The library: a real start (genesis, join, the loops) through https://user@sandbox.invalid/remote.git. git maps that
  // URL onto the bare remote by url.<file url>.insteadOf in a GIT_CONFIG_GLOBAL file (DAEMON_ENV passes it); the URL
  // without the user maps nowhere (sandbox.invalid never resolves), so every call that worked carried the login user.
  const RUN = '01TESTRUNLOGIN';
  const url = 'https://user@sandbox.invalid/remote.git';
  const shown = 'https://sandbox.invalid/remote.git';
  const { root, cleanup } = await makeTempRoot('real-login');
  try {
    const { remote } = await remoteWith(root, { [MARKER]: 'cowork-sync throwaway test repository\n' });
    const cfg = join(root, 'global.gitconfig');
    await writeFile(cfg, '');
    await must(runner, ['config', '--file', cfg, `url.${remote.url}.insteadOf`, url], root);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: cfg };
    const runRoot = join(root, 'run');
    const ac = new AbortController();
    const log: string[] = [];
    await assert.rejects(twoCloneRun({
      url, root: runRoot, timeoutMs: 120_000, env, signal: ac.signal, runId: RUN,
      log: (l) => { log.push(l); if (l.includes('scenario different-files')) ac.abort(); },
    }), (e: unknown) => e instanceof TwoCloneInterrupted, log.join('\n'));
    assert.ok(log.some((l) => l.includes(' started genesis ')) && log.some((l) => l.includes(' started join ')), log.join('\n'));
    assert.ok((await remote.refs())[`refs/heads/ci/${RUN}/main`] !== undefined, 'the run branch reached the remote');
    for (const name of ['A', 'B']) {
      const dir = join(runRoot, name);
      assert.equal(await pinnedUrl(dir, RUN), shown, `${name}: meta.pinned.url keeps no userinfo`);
      assert.equal(await must(runner, ['config', '--get', 'remote.origin.url'], dir), shown);
    }
    assert.ok(log.some((l) => l.includes(shown)), log.join('\n'));
    noUserinfo(log);
  } finally {
    await cleanup();
  }
});
