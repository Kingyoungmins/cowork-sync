import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { buildDaemonEnv, FORCED_ENV } from '../../src/git/env.js';
import {
  buildGitInvocation,
  DIFF_FAMILY,
  GLOBAL_PREFIX,
  MERGE_FLAGS,
  type GitBase,
  type GitCallOptions,
  type GitInvocation,
} from '../../src/git/flags.js';

// Review Focus 1 shape: hooks path with a space and Hangul.
const HOOKS_POSIX = '/home/홍길동/My Repos/demo/.git/cowork/empty-hooks';
const HOOKS_WIN = 'C:\\Users\\홍길동\\My Repos\\demo\\.git\\cowork\\empty-hooks';
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const OID_A = '1111111111111111111111111111111111111111';
const OID_B = '2222222222222222222222222222222222222222';
const SSH_BATCH = '-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3';

const POSIX_ENV = buildDaemonEnv({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/hong', LANG: 'ko_KR.UTF-8' }, []);
/** Ruling P2-GRAFTS: every git call reads grafts from a file under the empty hooks directory, which never exists. */
const NO_GRAFTS_POSIX = `${HOOKS_POSIX}/.no-grafts`;
/** The environment of a git call built on POSIX_ENV: DAEMON_ENV plus the runner's GIT_GRAFT_FILE. */
const GIT_ENV: Readonly<Record<string, string>> = { ...POSIX_ENV, GIT_GRAFT_FILE: NO_GRAFTS_POSIX };

function base(over: Partial<GitBase> = {}): GitBase {
  return { hooksPath: HOOKS_POSIX, platform: 'linux', daemonEnv: POSIX_ENV, testBuild: false, ...over };
}

function local(over: Partial<GitCallOptions> = {}): GitCallOptions {
  return { class: 'local', cwd: '/home/홍길동/My Repos/demo', ...over };
}

/** `--no-replace-objects`, then the `-c` pairs every call carries (glossary §18), in builder order. */
function always(hooksPath: string): string[] {
  return [
    '--no-replace-objects',
    '-c', `core.hooksPath=${hooksPath}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.quotepath=off',
    '-c', 'core.safecrlf=false',
    '-c', 'core.splitIndex=false',
    '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'fetch.fsckObjects=true',
    '-c', 'transfer.fsckObjects=true',
    '-c', 'protocol.ext.allow=never',
    '-c', 'core.askPass=',
    '-c', 'submodule.recurse=false',
    '-c', 'i18n.commitEncoding=UTF-8',
    '-c', 'i18n.logOutputEncoding=UTF-8',
  ];
}
const LFS = ['-c', 'filter.lfs.required=true'];
const NETWORK = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=10'];
const FETCH_FLAGS = ['--no-write-fetch-head', '--no-auto-maintenance', '--no-tags', '--no-recurse-submodules'];
const REFUPDATE = ['-c', 'core.logAllRefUpdates=always', '-c', 'core.fsync=committed,reference,index', '-c', 'core.fsyncMethod=batch'];
/** ENG-02: a fetch updates refs/cowork-remote/*, which get reflogs only under core.logAllRefUpdates=always. */
const FETCH_REFLOG = ['-c', 'core.logAllRefUpdates=always'];
/** Ruling P2-PUSHCFG: a user's push.* config never reaches a cowork push (options, signing, tags, submodule recursion). */
const PUSH_CFG = ['-c', 'push.pushOption=', '-c', 'push.gpgSign=false', '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no'];

/** Every -c precedes the subcommand, no -c key repeats, no -X option, env keys sorted. */
function assertWellFormed(inv: GitInvocation, sub: string): void {
  assert.equal(inv.argv[0], '--no-replace-objects', 'argv[0]');
  let i = GLOBAL_PREFIX.length;
  while (inv.argv[i] === '-c') i += 2;
  assert.equal(inv.argv[i], sub, 'subcommand position');
  assert.ok(!inv.argv.slice(i + 1).includes('-c'), 'a -c after the subcommand would be a subcommand argument');
  const keys = inv.argv
    .slice(GLOBAL_PREFIX.length, i)
    .filter((_, k) => k % 2 === 1)
    .map((kv) => kv.slice(0, kv.indexOf('=')).toLowerCase());
  assert.equal(new Set(keys).size, keys.length, `duplicate -c key in ${JSON.stringify(keys)}`);
  assert.ok(!inv.argv.some((a) => a.startsWith('-X')), 'no -X merge options (glossary §18)');
  assert.deepEqual(Object.keys(inv.env), Object.keys(inv.env).slice().sort(), 'env keys sorted');
}

test('the daemon env used by these snapshots', () => {
  assert.deepEqual(POSIX_ENV, {
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    HOME: '/home/hong',
    LANG: 'ko_KR.UTF-8',
    LANGUAGE: '',
    LC_ALL: 'C',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SSH_ASKPASS_REQUIRE: 'never',
  });
});

test('snapshot: local status on linux', () => {
  const inv = buildGitInvocation(['status', '--porcelain=v2', '-z'], local(), base());
  assert.deepEqual(inv, {
    argv: [...always(HOOKS_POSIX), ...LFS, 'status', '--porcelain=v2', '-z'],
    env: GIT_ENV,
  });
  assertWellFormed(inv, 'status');
  // stdin and cwd are for the runner; they never change argv or env.
  assert.deepEqual(buildGitInvocation(['status', '--porcelain=v2', '-z'], local({ stdin: Buffer.from('x') }), base()), inv);
});

test('snapshot: core.longpaths=true is added on win32 only', () => {
  const args = ['status', '--porcelain=v2', '-z'];
  const win = buildGitInvocation(args, local({ cwd: 'C:\\Users\\홍길동\\My Repos\\demo' }), base({ platform: 'win32', hooksPath: HOOKS_WIN }));
  assert.deepEqual(win.argv, [...always(HOOKS_WIN), '-c', 'core.longpaths=true', ...LFS, ...args]);
  assertWellFormed(win, 'status');
  for (const platform of ['linux', 'darwin'] as const) {
    const other = buildGitInvocation(args, local(), base({ platform }));
    assert.ok(!other.argv.includes('core.longpaths=true'), platform);
  }
});

test('snapshot: network fetch adds lowSpeed, the four fetch flags and the BatchMode ssh command', () => {
  const inv = buildGitInvocation(
    ['fetch', 'file:///srv/remote.git', '+refs/cowork/main/board:refs/cowork-remote/main/board'],
    { class: 'network', cwd: '/r' },
    base(),
  );
  assert.deepEqual(inv, {
    argv: [
      ...always(HOOKS_POSIX), ...LFS, ...FETCH_REFLOG, ...NETWORK,
      'fetch', ...FETCH_FLAGS,
      'file:///srv/remote.git', '+refs/cowork/main/board:refs/cowork-remote/main/board',
    ],
    env: { ...GIT_ENV, GIT_SSH_COMMAND: `ssh ${SSH_BATCH}` },
  });
  assertWellFormed(inv, 'fetch');
});

test('fetch flags are added on every fetch, whatever the class (SEC-02)', () => {
  const inv = buildGitInvocation(['fetch', 'origin'], local(), base());
  assert.deepEqual(inv.argv, [...always(HOOKS_POSIX), ...LFS, ...FETCH_REFLOG, 'fetch', ...FETCH_FLAGS, 'origin']);
  assert.equal(inv.env.GIT_SSH_COMMAND, undefined, 'ssh command is network class only');
  assert.ok(!inv.argv.includes('http.lowSpeedLimit=1000'), 'lowSpeed is network class only');
});

test('every fetch carries core.logAllRefUpdates=always exactly once, whatever the class; push and ls-remote do not (ENG-02)', () => {
  for (const cls of ['local', 'network', 'attr', 'refupdate'] as const) {
    const inv = buildGitInvocation(['fetch', 'file:///srv/remote.git', '+refs/cowork/main/board:refs/cowork-remote/main/board'], { class: cls, cwd: '/r' }, base());
    const sub = inv.argv.indexOf('fetch');
    const pairs = inv.argv.slice(GLOBAL_PREFIX.length, sub).filter((_, k) => k % 2 === 1);
    assert.deepEqual(pairs.filter((kv) => kv.toLowerCase().startsWith('core.logallrefupdates=')), ['core.logAllRefUpdates=always'], cls);
    assertWellFormed(inv, 'fetch');
  }
  for (const args of [['push', '--porcelain', 'u', `${OID_A}:refs/x`], ['ls-remote', 'u', 'refs/x'], ['status']]) {
    for (const cls of ['local', 'network', 'attr'] as const) {
      const inv = buildGitInvocation(args, { class: cls, cwd: '/r' }, base());
      assert.ok(!inv.argv.includes('core.logAllRefUpdates=always'), `${cls} ${args[0]}`);
    }
  }
  assert.throws(() => buildGitInvocation(['fetch', 'u'], { class: 'network', cwd: '/r', config: { 'core.logAllRefUpdates': 'false' } }, base()), /forced/);
});

test('every push carries push.pushOption=, push.gpgSign=false, push.followTags=false and push.recurseSubmodules=no exactly once, whatever the class; config cannot override them (ruling P2-PUSHCFG)', () => {
  const pushPairs = (inv: GitInvocation): string[] => {
    const sub = inv.argv.indexOf('push');
    return inv.argv.slice(GLOBAL_PREFIX.length, sub).filter((_, k) => k % 2 === 1).filter((kv) => kv.toLowerCase().startsWith('push.'));
  };
  for (const cls of ['local', 'network', 'attr', 'refupdate'] as const) {
    const inv = buildGitInvocation(['push', '--porcelain', 'file:///srv/remote.git', `${OID_A}:refs/cowork/main/board`], { class: cls, cwd: '/r' }, base());
    assert.deepEqual(pushPairs(inv), ['push.pushOption=', 'push.gpgSign=false', 'push.followTags=false', 'push.recurseSubmodules=no'], cls);
    assertWellFormed(inv, 'push');
  }
  // Only pushes: a fetch, ls-remote or local command carries none of them.
  for (const args of [['fetch', 'u', '+refs/x:refs/cowork-remote/x'], ['ls-remote', 'u', 'refs/x'], ['status']]) {
    for (const cls of ['local', 'network'] as const) {
      const inv = buildGitInvocation(args, { class: cls, cwd: '/r' }, base());
      assert.ok(!inv.argv.some((a) => a.toLowerCase().startsWith('push.')), `${cls} ${args[0]}`);
    }
  }
  for (const key of ['push.pushOption', 'push.gpgSign', 'push.followTags', 'push.recurseSubmodules', 'PUSH.PUSHOPTION', 'Push.GpgSign', 'push.followtags', 'PUSH.RECURSESUBMODULES']) {
    assert.throws(() => buildGitInvocation(['push', 'u', `${OID_A}:refs/x`], { class: 'network', cwd: '/r', config: { [key]: 'x' } }, base()), /forced/, key);
    assert.throws(() => buildGitInvocation(['status'], local({ config: { [key]: 'x' } }), base()), /forced/, key);
  }
});

test('snapshot: network push and ls-remote get lowSpeed but no fetch flags', () => {
  const push = buildGitInvocation(
    ['push', '--porcelain', 'file:///srv/remote.git', `${OID_A}:refs/cowork/main/board`],
    { class: 'network', cwd: '/r' },
    base(),
  );
  assert.deepEqual(push.argv, [
    ...always(HOOKS_POSIX), ...LFS, ...PUSH_CFG, ...NETWORK,
    'push', '--porcelain', 'file:///srv/remote.git', `${OID_A}:refs/cowork/main/board`,
  ]);
  assertWellFormed(push, 'push');
  const ls = buildGitInvocation(['ls-remote', '--exit-code', 'file:///srv/remote.git', 'refs/heads/main'], { class: 'network', cwd: '/r' }, base());
  assert.deepEqual(ls.argv, [...always(HOOKS_POSIX), ...LFS, ...NETWORK, 'ls-remote', '--exit-code', 'file:///srv/remote.git', 'refs/heads/main']);
  assert.equal(ls.env.GIT_SSH_COMMAND, `ssh ${SSH_BATCH}`);
});

test('DIFF_FAMILY is exactly the glossary §18 / 09 §2 family', () => {
  assert.deepEqual([...DIFF_FAMILY].sort(), ['blame', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'log', 'show']);
});

test('snapshot: every diff-family command gets --no-ext-diff --no-textconv right after the subcommand', () => {
  for (const sub of DIFF_FAMILY) {
    const inv = buildGitInvocation([sub, '--', 'src/a.ts'], local(), base());
    assert.deepEqual(inv.argv, [...always(HOOKS_POSIX), ...LFS, sub, '--no-ext-diff', '--no-textconv', '--', 'src/a.ts'], sub);
    assertWellFormed(inv, sub);
  }
  for (const sub of ['cat-file', 'ls-files', 'rev-parse', 'merge-tree']) {
    const inv = buildGitInvocation([sub, 'x'], local(), base());
    assert.ok(!inv.argv.includes('--no-ext-diff'), sub);
  }
});

test('MERGE_FLAGS is the glossary §18 set, frozen', () => {
  assert.deepEqual([...MERGE_FLAGS], ['-c', 'merge.renormalize=false', '-c', 'merge.renames=true', '-c', 'merge.directoryRenames=false']);
  assert.ok(Object.isFrozen(MERGE_FLAGS));
});

test('snapshot: merge-tree (attr class) and merge-file carry MERGE_FLAGS before the subcommand', () => {
  const mt = buildGitInvocation(
    ['merge-tree', '--write-tree', '-z', `--merge-base=${OID_A}`, OID_B, OID_A],
    { class: 'attr', cwd: '/r', attrTree: TREE },
    base(),
  );
  assert.deepEqual(mt.argv, [
    ...always(HOOKS_POSIX), ...LFS, '-c', `attr.tree=${TREE}`, ...MERGE_FLAGS,
    'merge-tree', '--write-tree', '-z', `--merge-base=${OID_A}`, OID_B, OID_A,
  ]);
  assertWellFormed(mt, 'merge-tree');
  const mf = buildGitInvocation(['merge-file', '-p', '--object-id', OID_A, OID_B, OID_A], local(), base());
  assert.deepEqual(mf.argv, [...always(HOOKS_POSIX), ...LFS, ...MERGE_FLAGS, 'merge-file', '-p', '--object-id', OID_A, OID_B, OID_A]);
  assertWellFormed(mf, 'merge-file');
});

test('snapshot: refupdate class adds reflog and fsync flags; other classes do not', () => {
  const inv = buildGitInvocation(
    ['update-ref', '--create-reflog', 'refs/cowork-local/main/state', OID_B, OID_A],
    { class: 'refupdate', cwd: '/r' },
    base(),
  );
  assert.deepEqual(inv.argv, [
    ...always(HOOKS_POSIX), ...LFS, ...REFUPDATE,
    'update-ref', '--create-reflog', 'refs/cowork-local/main/state', OID_B, OID_A,
  ]);
  assertWellFormed(inv, 'update-ref');
  for (const cls of ['local', 'network', 'attr'] as const) {
    const other = buildGitInvocation(['update-ref', 'refs/x', OID_A], { class: cls, cwd: '/r' }, base());
    assert.ok(!other.argv.includes('core.fsyncMethod=batch'), cls);
  }
});

test('snapshot: attr add with filter drivers (sorted, de-duplicated, lfs always) and attr.tree', () => {
  const inv = buildGitInvocation(
    ['add', '--', 'src/settings.py'],
    { class: 'attr', cwd: '/r', attrTree: TREE, filterDrivers: ['secret', 'lfs', 'git-crypt', 'secret'] },
    base(),
  );
  assert.deepEqual(inv.argv, [
    ...always(HOOKS_POSIX),
    '-c', 'filter.git-crypt.required=true',
    '-c', 'filter.lfs.required=true',
    '-c', 'filter.secret.required=true',
    '-c', `attr.tree=${TREE}`,
    'add', '--', 'src/settings.py',
  ]);
  assertWellFormed(inv, 'add');
});

test('fsmonitor: true sets core.fsmonitor=true, default false', () => {
  const on = buildGitInvocation(['status'], local({ fsmonitor: true }), base());
  assert.deepEqual(on.argv.slice(1, 5), ['-c', `core.hooksPath=${HOOKS_POSIX}`, '-c', 'core.fsmonitor=true']);
  const off = buildGitInvocation(['status'], local({ fsmonitor: false }), base());
  assert.deepEqual(off.argv.slice(3, 5), ['-c', 'core.fsmonitor=false']);
});

test('identity sets author/committer and TZ=UTC0; dates only in test builds', () => {
  const identity = { name: 'peer-7f3a', email: '7f3a9c@cowork.invalid' };
  const idEnv = {
    GIT_AUTHOR_EMAIL: '7f3a9c@cowork.invalid',
    GIT_AUTHOR_NAME: 'peer-7f3a',
    GIT_COMMITTER_EMAIL: '7f3a9c@cowork.invalid',
    GIT_COMMITTER_NAME: 'peer-7f3a',
    TZ: 'UTC0',
  };
  const args = ['commit-tree', TREE, '-p', OID_A, '-m', 'board'];
  const release = buildGitInvocation(args, local({ identity, wallMsForDates: 1_700_000_000_999 }), base({ testBuild: false }));
  assert.deepEqual(release.env, { ...GIT_ENV, ...idEnv });
  assertWellFormed(release, 'commit-tree');
  const testBuild = buildGitInvocation(args, local({ identity, wallMsForDates: 1_700_000_000_999 }), base({ testBuild: true }));
  assert.deepEqual(testBuild.env, {
    ...GIT_ENV,
    ...idEnv,
    GIT_AUTHOR_DATE: '@1700000000 +0000',
    GIT_COMMITTER_DATE: '@1700000000 +0000',
  });
  const datesOnly = buildGitInvocation(args, local({ wallMsForDates: 0 }), base({ testBuild: true }));
  assert.deepEqual(datesOnly.env, { ...GIT_ENV, GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_DATE: '@0 +0000' });
  const none = buildGitInvocation(args, local(), base({ testBuild: true }));
  assert.deepEqual(none.env, GIT_ENV);
});

test('--no-replace-objects is argv[0] for every class', () => {
  const GD = '/home/홍길동/My Repos/demo/.git';
  for (const cls of ['local', 'network', 'attr', 'refupdate'] as const) {
    const plain = buildGitInvocation(['status'], { class: cls, cwd: '/r' }, base());
    assert.deepEqual(plain.argv.slice(0, 3), ['--no-replace-objects', '-c', `core.hooksPath=${HOOKS_POSIX}`], cls);
    assert.deepEqual([...GLOBAL_PREFIX], ['--no-replace-objects']);
    // Before --git-dir, --work-tree and every -c.
    const full = buildGitInvocation(
      ['merge-tree', '--write-tree'],
      { class: cls, cwd: '/r', gitDir: GD, workTree: '/home/홍길동/My Repos/demo', attrTree: TREE, config: { 'core.autocrlf': 'input' } },
      base(),
    );
    assert.equal(full.argv[0], '--no-replace-objects', cls);
    assert.equal(full.argv[1], `--git-dir=${GD}`, cls);
    assert.equal(full.argv[2], '--work-tree=/home/홍길동/My Repos/demo', cls);
    assert.equal(full.argv[3], '-c', cls);
    assert.equal(full.argv.indexOf('--no-replace-objects'), 0);
    assert.equal(full.argv.filter((a) => a === '--no-replace-objects').length, 1);
  }
  assert.equal('GIT_NO_REPLACE_OBJECTS' in buildGitInvocation(['status'], local(), base()).env, false);
});

test('core.safecrlf=false is forced for every class and config cannot override it (ruling P2-SAFECRLF)', () => {
  // A user's core.safecrlf=true makes hash-object -w / add die (rc 128) on a CRLF<->LF conversion,
  // which route (b) would read as a filter failure.
  const commands: string[][] = [['status'], ['hash-object', '-w', '--path=a.txt', '--', '/s/a.txt'], ['add', '--', 'a'], ['merge-file', '-p'], ['fetch', 'u']];
  for (const cls of ['local', 'network', 'attr', 'refupdate'] as const) {
    for (const args of commands) {
      const inv = buildGitInvocation(args, { class: cls, cwd: '/r', config: { 'core.autocrlf': 'input' } }, base());
      const sub = inv.argv.indexOf(args[0]!);
      const pairs = inv.argv.slice(GLOBAL_PREFIX.length, sub).filter((_, k) => k % 2 === 1);
      assert.equal(pairs.filter((kv) => kv.toLowerCase().startsWith('core.safecrlf=')).length, 1, `${cls} ${args[0]}`);
      assert.ok(pairs.includes('core.safecrlf=false'), `${cls} ${args[0]}`);
      assertWellFormed(inv, args[0]!);
    }
  }
  for (const key of ['core.safecrlf', 'core.safeCRLF', 'CORE.SAFECRLF']) {
    assert.throws(() => buildGitInvocation(['status'], local({ config: { [key]: 'true' } }), base()), /forced/, key);
  }
});

test('core.splitIndex=false is forced for every class and config cannot override it (ruling P2-SPLITINDEX)', () => {
  // A user's core.splitIndex=true would make every scratch- and private-index call (read-tree, update-index,
  // write-tree with GIT_INDEX_FILE) write shared index files into the user's gitdir.
  const commands: string[][] = [['read-tree', TREE], ['update-index', '--add', '--replace', '-z', '--index-info'], ['write-tree'], ['add', '--', 'a'], ['status']];
  for (const cls of ['local', 'network', 'attr', 'refupdate'] as const) {
    for (const args of commands) {
      const inv = buildGitInvocation(args, { class: cls, cwd: '/r', indexFile: '/r/.git/cowork/tmp/a.index', config: { 'core.protectNTFS': 'false' } }, base());
      const sub = inv.argv.indexOf(args[0]!);
      const pairs = inv.argv.slice(GLOBAL_PREFIX.length, sub).filter((_, k) => k % 2 === 1);
      assert.deepEqual(pairs.filter((kv) => kv.toLowerCase().startsWith('core.splitindex=')), ['core.splitIndex=false'], `${cls} ${args[0]}`);
      assertWellFormed(inv, args[0]!);
    }
  }
  for (const key of ['core.splitIndex', 'core.splitindex', 'CORE.SPLITINDEX']) {
    assert.throws(() => buildGitInvocation(['status'], local({ config: { [key]: 'true' } }), base()), /forced/, key);
  }
});

test('i18n.commitEncoding and i18n.logOutputEncoding are forced to UTF-8 for every class and config cannot override them', () => {
  // A user's i18n.commitEncoding would add an `encoding` header to every board and live commit; a user's
  // i18n.logOutputEncoding would re-encode what log and rev-list print and match (--grep).
  for (const cls of ['local', 'network', 'attr', 'refupdate'] as const) {
    for (const args of [['commit-tree', TREE], ['log', '-1'], ['rev-list', '--grep=^Cowork-Base: ', OID_A], ['status']]) {
      const inv = buildGitInvocation(args, { class: cls, cwd: '/r', identity: { name: 'p', email: 'p@cowork.invalid' } }, base());
      const sub = inv.argv.indexOf(args[0]!);
      const pairs = inv.argv.slice(GLOBAL_PREFIX.length, sub).filter((_, k) => k % 2 === 1);
      for (const key of ['i18n.commitencoding', 'i18n.logoutputencoding']) {
        assert.deepEqual(pairs.filter((kv) => kv.toLowerCase().startsWith(`${key}=`)), [`${key === 'i18n.commitencoding' ? 'i18n.commitEncoding' : 'i18n.logOutputEncoding'}=UTF-8`], `${cls} ${args[0]} ${key}`);
      }
      assertWellFormed(inv, args[0]!);
    }
  }
  for (const key of ['i18n.commitEncoding', 'i18n.commitencoding', 'I18N.COMMITENCODING', 'i18n.logOutputEncoding', 'i18n.LOGOUTPUTENCODING']) {
    assert.throws(() => buildGitInvocation(['status'], local({ config: { [key]: 'EUC-KR' } }), base()), /forced/, key);
  }
});

test('GIT_GRAFT_FILE is <hooksPath>/.no-grafts on every call and neither daemonEnv nor extraEnv can set it (ruling P2-GRAFTS)', () => {
  // .git/info/grafts is honoured despite --no-replace-objects and would give this peer other first-parent chains;
  // a graft file under the empty hooks directory never exists, so git reads no grafts.
  for (const cls of ['local', 'network', 'attr', 'refupdate'] as const) {
    for (const args of [['rev-list', '--first-parent', OID_A], ['merge-tree', '--write-tree', OID_A, OID_B], ['status']]) {
      const inv = buildGitInvocation(args, { class: cls, cwd: '/r', identity: { name: 'p', email: 'p@cowork.invalid' } }, base());
      assert.equal(inv.env.GIT_GRAFT_FILE, NO_GRAFTS_POSIX, `${cls} ${args[0]}`);
      assert.deepEqual(Object.keys(inv.env).filter((k) => k.toUpperCase() === 'GIT_GRAFT_FILE'), ['GIT_GRAFT_FILE'], `${cls} ${args[0]}`);
    }
  }
  // Joined with '/' whatever the platform: git accepts it on Windows, and the argv does not depend on the host OS.
  const win = buildGitInvocation(['status'], local({ cwd: 'C:\\r' }), base({ platform: 'win32', hooksPath: HOOKS_WIN }));
  assert.equal(win.env.GIT_GRAFT_FILE, `${HOOKS_WIN}/.no-grafts`);
  // A graft file passed in by daemonEnv or extraEnv, in any spelling, never reaches git.
  const daemonEnv = { ...POSIX_ENV, GIT_GRAFT_FILE: '/evil/grafts', Git_Graft_File: '/evil/grafts2' };
  const inv = buildGitInvocation(['status'], local({ extraEnv: { GIT_GRAFT_FILE: '/evil/grafts3', git_graft_file: '/evil/grafts4' } }), base({ daemonEnv }));
  assert.deepEqual(inv.env, GIT_ENV);
});

test('relative gitDir, workTree and indexFile throw before spawning', () => {
  assert.throws(() => buildGitInvocation(['status'], local({ gitDir: '.git' }), base()), /gitDir must be absolute/);
  assert.throws(() => buildGitInvocation(['status'], local({ gitDir: 'repo/.git' }), base()), /gitDir must be absolute/);
  assert.throws(() => buildGitInvocation(['status'], local({ workTree: '../demo' }), base()), /workTree must be absolute/);
  assert.throws(() => buildGitInvocation(['read-tree', TREE], local({ indexFile: 'tmp/index' }), base()), /indexFile must be absolute/);
  assert.throws(() => buildGitInvocation(['status'], local({ gitDir: '' }), base()));
  const ok = buildGitInvocation(['status'], local({ gitDir: '/g/.git', workTree: '/g', indexFile: '/g/.git/cowork/tmp/i' }), base());
  assert.equal(ok.env.GIT_INDEX_FILE, '/g/.git/cowork/tmp/i');
});

test('config adds -c pairs after the forced list and refuses a forced key', () => {
  const inv = buildGitInvocation(
    ['hash-object', '--stdin', '--no-filters'],
    local({ attrTree: TREE, config: { 'core.autocrlf': 'input', 'a.b': 'x y' } }),
    base(),
  );
  assert.deepEqual(inv.argv, [
    ...always(HOOKS_POSIX), ...LFS, '-c', `attr.tree=${TREE}`,
    '-c', 'a.b=x y', '-c', 'core.autocrlf=input',
    'hash-object', '--stdin', '--no-filters',
  ]);
  assertWellFormed(inv, 'hash-object');
  // After the forced list and before the merge flags.
  const mt = buildGitInvocation(['merge-tree', 'x'], local({ config: { 'x.y': 'z' } }), base());
  assert.deepEqual(mt.argv, [...always(HOOKS_POSIX), ...LFS, '-c', 'x.y=z', ...MERGE_FLAGS, 'merge-tree', 'x']);
  for (const key of [
    'core.hooksPath', 'CORE.FSMONITOR', 'commit.gpgSign', 'core.longpaths', 'attr.tree', 'merge.renormalize',
    'merge.renames', 'filter.lfs.required', 'filter.secret.required', 'core.logAllRefUpdates', 'http.lowSpeedLimit',
    'i18n.commitEncoding', 'i18n.logOutputEncoding', 'core.splitIndex',
  ]) {
    assert.throws(() => buildGitInvocation(['status'], local({ config: { [key]: 'x' } }), base()), /forced|invalid/, key);
  }
  for (const key of ['', 'nodot', 'a=b.c', 'a b.c']) {
    assert.throws(() => buildGitInvocation(['status'], local({ config: { [key]: 'x' } }), base()), /invalid config key/, JSON.stringify(key));
  }
  assert.throws(() => buildGitInvocation(['status'], local({ config: { 'a.b': 'x\ny' } }), base()), /invalid config value/);
});

test('literalPathspecs sets GIT_LITERAL_PATHSPECS=1', () => {
  assert.deepEqual(buildGitInvocation(['status'], local({ literalPathspecs: true }), base()).env, { ...GIT_ENV, GIT_LITERAL_PATHSPECS: '1' });
  assert.equal(buildGitInvocation(['status'], local({ literalPathspecs: false }), base()).env.GIT_LITERAL_PATHSPECS, undefined);
  assert.equal(buildGitInvocation(['status'], local(), base()).env.GIT_LITERAL_PATHSPECS, undefined);
});

test('indexFile sets GIT_INDEX_FILE', () => {
  const inv = buildGitInvocation(['read-tree', TREE], { class: 'refupdate', cwd: '/r', indexFile: '/r/.git/cowork/tmp/snap index' }, base());
  assert.deepEqual(inv.env, { ...GIT_ENV, GIT_INDEX_FILE: '/r/.git/cowork/tmp/snap index' });
});

test('extraEnv adds variables but never overrides FORCED_ENV (any case); explicit options beat it', () => {
  const inv = buildGitInvocation(
    ['status'],
    local({
      indexFile: '/b/index',
      extraEnv: {
        LC_ALL: 'ko_KR.UTF-8',
        lc_all: 'x',
        LANGUAGE: 'ko',
        GCM_INTERACTIVE: 'always',
        gcm_interactive: 'always',
        GIT_TERMINAL_PROMPT: '1',
        GIT_INDEX_FILE: '/a/index',
        HOME: '/tmp/h',
        FOO: 'bar',
      },
    }),
    base(),
  );
  // Check the forced keys first: assert.deepEqual narrows inv.env's static type afterwards.
  for (const [k, v] of Object.entries(FORCED_ENV)) assert.equal(inv.env[k], v, k);
  assert.deepEqual(inv.env, { ...GIT_ENV, FOO: 'bar', GIT_INDEX_FILE: '/b/index', HOME: '/tmp/h' });
});

test('ssh: the BatchMode options are appended to the effective ssh command, never replacing it', () => {
  const cases: Array<[source: Record<string, string>, expected: string | undefined]> = [
    [{}, `ssh ${SSH_BATCH}`],
    [{ GIT_SSH_COMMAND: 'ssh -i "/home/hong/My Keys/id_work"' }, `ssh -i "/home/hong/My Keys/id_work" ${SSH_BATCH}`],
    [{ GIT_SSH_COMMAND: '"C:/Program Files/OpenSSH/ssh.exe" -F nul' }, `"C:/Program Files/OpenSSH/ssh.exe" -F nul ${SSH_BATCH}`],
    [{ git_ssh_command: 'ssh -4' }, `ssh -4 ${SSH_BATCH}`],
    [{ GIT_SSH: 'C:\\Program Files\\PuTTY\\plink.exe' }, "'C:\\Program Files\\PuTTY\\plink.exe' -batch"],
    [{ GIT_SSH: '/opt/tortoise/TortoisePlink.exe' }, "'/opt/tortoise/TortoisePlink.exe' -batch"],
    [{ GIT_SSH: "/usr/bin/o'ssh", GIT_SSH_VARIANT: 'ssh' }, `'/usr/bin/o'\\''ssh' ${SSH_BATCH}`],
    [{ GIT_SSH_COMMAND: 'plink -load work' }, 'plink -load work -batch'],
    [{ GIT_SSH_COMMAND: 'my-wrapper', GIT_SSH_VARIANT: 'putty' }, 'my-wrapper -batch'],
    [{ GIT_SSH_COMMAND: 'my-wrapper --x' }, 'my-wrapper --x'],
    [{ GIT_SSH_COMMAND: 'ssh', GIT_SSH_VARIANT: 'simple' }, 'ssh'],
    [{ GIT_SSH: '/usr/local/bin/ssh-wrap' }, undefined],
  ];
  for (const [source, expected] of cases) {
    const daemonEnv = buildDaemonEnv({ PATH: '/bin', ...source }, []);
    const inv = buildGitInvocation(['ls-remote', 'git@github.com:team/repo.git'], { class: 'network', cwd: '/r' }, base({ daemonEnv }));
    assert.equal(inv.env.GIT_SSH_COMMAND, expected, JSON.stringify(source));
    const variants = Object.keys(inv.env).filter((k) => k.toUpperCase() === 'GIT_SSH_COMMAND');
    assert.ok(variants.length <= 1, `one spelling of GIT_SSH_COMMAND: ${JSON.stringify(variants)}`);
  }
});

test('ssh: effective command precedence GIT_SSH_COMMAND > core.sshCommand > GIT_SSH > ssh (09-security §2)', () => {
  // core.sshCommand values carrying an identity-file path with a space and Hangul (Review Focus 1 shape).
  const KEY_CMD = 'ssh -i "/home/홍길동/My Keys/id_work" -o IdentitiesOnly=yes';
  const WIN_KEY_CMD = '"C:/Program Files/OpenSSH/ssh.exe" -i "C:/Users/홍길동/.ssh/id_ed25519"';
  const PLINK = 'C:\\Program Files\\PuTTY\\plink.exe';
  const cases: Array<[label: string, source: Record<string, string>, sshCommand: string | undefined, expected: string | undefined]> = [
    // Level 1: GIT_SSH_COMMAND in the daemon env wins over core.sshCommand and GIT_SSH.
    ['L1 env command beats core.sshCommand and GIT_SSH', { GIT_SSH_COMMAND: 'ssh -4', GIT_SSH: PLINK }, KEY_CMD, `ssh -4 ${SSH_BATCH}`],
    ['L1 env plink command beats an ssh core.sshCommand', { GIT_SSH_COMMAND: 'plink -load work' }, KEY_CMD, 'plink -load work -batch'],
    // Level 2: core.sshCommand, kept verbatim with its key path, wins over GIT_SSH.
    ['L2 core.sshCommand key path, nothing in env', {}, KEY_CMD, `${KEY_CMD} ${SSH_BATCH}`],
    ['L2 core.sshCommand beats GIT_SSH', { GIT_SSH: PLINK }, KEY_CMD, `${KEY_CMD} ${SSH_BATCH}`],
    ['L2 core.sshCommand quoted Windows program and key path', {}, WIN_KEY_CMD, `${WIN_KEY_CMD} ${SSH_BATCH}`],
    ['L2 core.sshCommand trailing whitespace trimmed', {}, 'ssh -i ~/.ssh/work   ', `ssh -i ~/.ssh/work ${SSH_BATCH}`],
    ['L2 core.sshCommand plink key path gets -batch', {}, 'plink -i "C:/Users/홍길동/keys/work.ppk"', 'plink -i "C:/Users/홍길동/keys/work.ppk" -batch'],
    ['L2 core.sshCommand with GIT_SSH_VARIANT=tortoiseplink', { GIT_SSH_VARIANT: 'tortoiseplink' }, 'C:/tools/tp.exe -i k.ppk', 'C:/tools/tp.exe -i k.ppk -batch'],
    ['L2 blank env command falls through to core.sshCommand', { GIT_SSH_COMMAND: '   ' }, KEY_CMD, `${KEY_CMD} ${SSH_BATCH}`],
    // Nothing appended: GIT_SSH_COMMAND stays unset, so git applies core.sshCommand itself, unchanged.
    ['L2 core.sshCommand with GIT_SSH_VARIANT=simple', { GIT_SSH_VARIANT: 'simple' }, KEY_CMD, undefined],
    ['L2 core.sshCommand unrecognised wrapper', { GIT_SSH: PLINK }, '/opt/bin/ssh-wrap --profile work', undefined],
    // Level 3: GIT_SSH with its variant.
    ['L3 blank core.sshCommand falls through to GIT_SSH', { GIT_SSH: '/usr/bin/plink' }, '   ', "'/usr/bin/plink' -batch"],
    ['L3 GIT_SSH plink', { GIT_SSH: PLINK }, undefined, "'C:\\Program Files\\PuTTY\\plink.exe' -batch"],
    ['L3 GIT_SSH ssh basename', { GIT_SSH: '/usr/bin/ssh' }, undefined, `'/usr/bin/ssh' ${SSH_BATCH}`],
    ['L3 GIT_SSH with GIT_SSH_VARIANT=simple', { GIT_SSH: '/usr/bin/ssh', GIT_SSH_VARIANT: 'simple' }, undefined, undefined],
    // Level 4: plain ssh.
    ['L4 nothing anywhere', {}, undefined, `ssh ${SSH_BATCH}`],
    ['L4 empty core.sshCommand', {}, '', `ssh ${SSH_BATCH}`],
    ['L4 blank GIT_SSH_COMMAND and GIT_SSH', { GIT_SSH_COMMAND: '', GIT_SSH: ' ' }, undefined, `ssh ${SSH_BATCH}`],
    ['L4 blank everything, simple variant', { GIT_SSH_COMMAND: ' ', GIT_SSH_VARIANT: 'simple' }, ' ', undefined],
  ];
  for (const [label, source, sshCommand, expected] of cases) {
    const daemonEnv = buildDaemonEnv({ PATH: '/bin', ...source }, []);
    const inv = buildGitInvocation(['fetch', 'git@github.com:team/repo.git'], { class: 'network', cwd: '/r' }, base({ daemonEnv, sshCommand }));
    assert.equal(inv.env.GIT_SSH_COMMAND, expected, label);
    const sshKeys = Object.keys(inv.env).filter((k) => k.toUpperCase() === 'GIT_SSH_COMMAND' || k.toUpperCase() === 'GIT_SSH');
    for (const k of sshKeys) assert.notEqual((inv.env[k] ?? '').trim(), '', `${label}: blank ${k} left in env`);
    assert.ok(Object.keys(inv.env).filter((k) => k.toUpperCase() === 'GIT_SSH_COMMAND').length <= 1, label);
  }
});

test('ssh: local classes leave the user ssh command untouched and ignore core.sshCommand', () => {
  const daemonEnv = buildDaemonEnv({ PATH: '/bin', GIT_SSH_COMMAND: 'ssh -i k' }, []);
  const inv = buildGitInvocation(['status'], local(), base({ daemonEnv, sshCommand: 'ssh -i other' }));
  assert.equal(inv.env.GIT_SSH_COMMAND, 'ssh -i k');
  for (const cls of ['local', 'attr', 'refupdate'] as const) {
    const other = buildGitInvocation(['fetch', 'origin'], { class: cls, cwd: '/r' }, base({ sshCommand: 'ssh -i other' }));
    assert.equal(other.env.GIT_SSH_COMMAND, undefined, cls);
  }
});

test('Review Focus 4: the user git config and locale cannot leak into cowork git calls', () => {
  // A session that has a Korean locale and tries to inject config through the environment.
  const daemonEnv = buildDaemonEnv(
    {
      PATH: '/usr/bin',
      HOME: '/home/hong',
      LANG: 'ko_KR.UTF-8',
      LC_MESSAGES: 'ko_KR.UTF-8',
      LANGUAGE: 'ko',
      GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/evil' 'commit.gpgSign'='true'",
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: '/evil/fsmonitor-hook',
      GIT_CONFIG_KEY_1: 'url.https://evil.example/.insteadOf',
      GIT_CONFIG_VALUE_1: 'https://github.com/',
    },
    [],
  );
  const inv = buildGitInvocation(
    ['commit', '-q', '-m', 'live'],
    local({ identity: { name: 'peer-1', email: 'p1@cowork.invalid' } }),
    base({ daemonEnv }),
  );
  assertWellFormed(inv, 'commit');
  const pairs = inv.argv.slice(1, inv.argv.indexOf('commit')).filter((_, k) => k % 2 === 1);
  // The repository's own core.hooksPath, core.fsmonitor hook and commit.gpgSign=true lose to these -c values.
  assert.ok(pairs.includes(`core.hooksPath=${HOOKS_POSIX}`));
  assert.ok(pairs.includes('core.fsmonitor=false'));
  assert.ok(pairs.includes('commit.gpgSign=false'));
  assert.ok(pairs.includes('tag.gpgSign=false'));
  assert.ok(pairs.includes('core.quotepath=off'));
  // Output stays in English: LC_ALL=C overrides LANG/LC_MESSAGES, LANGUAGE is emptied.
  assert.equal(inv.env.LC_ALL, 'C');
  assert.equal(inv.env.LANGUAGE, '');
  assert.equal(inv.env.LANG, 'ko_KR.UTF-8');
  // Environment-injected config never reaches git.
  for (const k of Object.keys(inv.env)) {
    assert.ok(!k.toUpperCase().startsWith('GIT_CONFIG_'), k);
  }
  // The user's core.sshCommand (resolved by the caller) stays the effective ssh command; BatchMode is appended, not substituted.
  const net = buildGitInvocation(
    ['ls-remote', '--exit-code', 'git@github.com:team/repo.git', 'refs/heads/main'],
    { class: 'network', cwd: '/r' },
    base({ daemonEnv, sshCommand: 'ssh -i ~/.ssh/work' }),
  );
  assertWellFormed(net, 'ls-remote');
  assert.equal(net.env.GIT_SSH_COMMAND, `ssh -i ~/.ssh/work ${SSH_BATCH}`);
  assert.equal(net.env.LC_ALL, 'C');
  // url.*.insteadOf in the user's config files cannot be overridden by -c; it is refused at /cowork start (glossary §18, later plan).
});

test('invalid calls throw instead of building a wrong command line', () => {
  const bad: Array<[string[], GitCallOptions, GitBase]> = [
    [[], local(), base()],
    [['--version'], local(), base()],
    [['-C', '/x', 'status'], local(), base()],
    [[''], local(), base()],
    [['status'], local({ filterDrivers: ['a=b'] }), base()],
    [['status'], local({ filterDrivers: ['has space'] }), base()],
    [['status'], local({ filterDrivers: [''] }), base()],
    [['status'], local({ attrTree: 'HEAD' }), base()],
    [['status'], local({ attrTree: 'abc123' }), base()],
    [['status'], { class: 'bogus', cwd: '/r' } as unknown as GitCallOptions, base()],
    [['status'], local({ identity: { name: 'a\nb', email: 'x@cowork.invalid' } }), base()],
    [['status'], local({ identity: { name: 'p', email: '<x@cowork.invalid>' } }), base()],
    [['status'], local({ identity: { name: '', email: 'x@cowork.invalid' } }), base()],
    [['status'], local({ indexFile: '' }), base()],
    [['status'], local(), base({ hooksPath: '' })],
    [['status'], local(), base({ hooksPath: '/x\n/y' })],
    // A relative hooksPath would make GIT_GRAFT_FILE a path inside the work tree, which a teammate could create.
    [['status'], local(), base({ hooksPath: 'hooks' })],
    [['status'], local(), base({ hooksPath: '.git/cowork/empty-hooks' })],
    [['status'], local(), base({ platform: 'win32', hooksPath: 'C:hooks' })],
    [['status'], local(), base({ platform: 'win32', hooksPath: 'hooks\\empty' })],
    [['status'], local({ wallMsForDates: Number.NaN }), base({ testBuild: true })],
    [['status'], local({ wallMsForDates: -1 }), base({ testBuild: true })],
    [['status'], local(), base({ sshCommand: 'ssh -i k\nrm -rf ~' })],
    [['status'], local(), base({ sshCommand: 'ssh\r' })],
    [['status'], local(), base({ sshCommand: 'ssh\0-i k' })],
  ];
  for (const [args, opts, b] of bad) {
    assert.throws(() => buildGitInvocation(args, opts, b), Error, JSON.stringify({ args, opts }));
  }
  // A release build ignores wallMsForDates entirely, including bad values.
  assert.doesNotThrow(() => buildGitInvocation(['status'], local({ wallMsForDates: Number.NaN }), base({ testBuild: false })));
  assert.doesNotThrow(() => buildGitInvocation(['version'], local(), base()));
  // An empty core.sshCommand means "not configured".
  assert.doesNotThrow(() => buildGitInvocation(['ls-remote', 'origin'], { class: 'network', cwd: '/r' }, base({ sshCommand: '' })));
});

test('buildGitInvocation does not mutate its inputs', () => {
  const daemonEnv = Object.freeze({ ...POSIX_ENV });
  const args = Object.freeze(['fetch', 'origin']) as unknown as string[];
  const opts = Object.freeze(local({ class: 'network', filterDrivers: ['secret'] }));
  buildGitInvocation(args, opts, base({ daemonEnv }));
  assert.deepEqual(args, ['fetch', 'origin']);
  assert.deepEqual(daemonEnv, POSIX_ENV);
  assert.deepEqual(opts.filterDrivers, ['secret']);
});

// Final review #3: DAEMON_ENV is a plain record, so a caller can hand buildGitInvocation a raw
// process.env-shaped object. The never-list (09-security §3.4 item 4) is enforced here too, in any
// case and from extraEnv as well; runner-owned settings (indexFile, identity) still apply after it.
test('never-list names from daemonEnv or extraEnv never reach git, in any spelling', () => {
  const raw: Record<string, string> = {
    ...POSIX_ENV,
    CLAUDE_CODE_OAUTH_TOKEN: 'canary-token',
    NODE_OPTIONS: '--require /evil.js',
    git_dir: '/elsewhere/.git',
    GIT_CONFIG_PARAMETERS: "'core.pager'='evil'",
    GIT_TRACE: '1',
    Git_Author_Name: 'Mallory',
    git_graft_file: '/elsewhere/grafts',
  };
  const inv = buildGitInvocation(
    ['status'],
    local({
      indexFile: '/b/index',
      identity: { name: 'Hong', email: 'hong@cowork.invalid' },
      extraEnv: {
        GIT_DIR: '/x/.git',
        GIT_EXTERNAL_DIFF: 'evil',
        GIT_CONFIG_KEY_0: 'core.pager',
        GIT_CONFIG_VALUE_0: 'evil',
        vscode_ipc_hook: '/tmp/ipc',
        GIT_INDEX_FILE: '/a/index',
        GIT_GRAFT_FILE: '/x/grafts',
        FOO: 'bar',
      },
    }),
    base({ daemonEnv: raw }),
  );
  assert.deepEqual(inv.env, {
    ...GIT_ENV,
    FOO: 'bar',
    GIT_AUTHOR_EMAIL: 'hong@cowork.invalid',
    GIT_AUTHOR_NAME: 'Hong',
    GIT_COMMITTER_EMAIL: 'hong@cowork.invalid',
    GIT_COMMITTER_NAME: 'Hong',
    GIT_INDEX_FILE: '/b/index',
    TZ: 'UTC0',
  });
});
