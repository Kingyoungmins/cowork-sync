// The `view` verb's pure parts (Task 11): flags, output modes, the launch URL, and the CLI path checks (12 §3.2 items 1, 2 and 10,
// 10-product §2; R-V14, R-V54, R-V55; Review Focus 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { absolutize, isUncOrDevice } from '../../../src/viz/cli/paths.js';
import { launchUrl, outputMode, parseViewFlags, realCliEnv, runView, URL_RE } from '../../../src/viz/cli/view.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import { assertAllRendered, fakePluginRoot, findSystemGit, recordingEnv } from '../../helpers/vizCli.js';

const HANGUL = '\u{AE40}\u{CCA0}\u{C218}';   // a Hangul folder name
const REFUSE = { refuse: 'RF_UNKNOWN_FLAG' };

test('flags: --no-open, --demo, --demo=<file>, repeated --repo; anything else, --json and --demo with --repo → RF_UNKNOWN_FLAG', () => {
  assert.deepEqual(parseViewFlags([]), { noOpen: false, demo: null, repos: [] });
  assert.deepEqual(parseViewFlags(['--no-open']), { noOpen: true, demo: null, repos: [] });
  assert.deepEqual(parseViewFlags(['--demo']), { noOpen: false, demo: true, repos: [] });
  assert.deepEqual(parseViewFlags(['--demo=my demo.jsonl', '--no-open']), { noOpen: true, demo: 'my demo.jsonl', repos: [] });
  assert.deepEqual(parseViewFlags(['--repo', 'a', '--no-open', '--repo', `b ${HANGUL}`, '--repo', 'a']),
    { noOpen: true, demo: null, repos: ['a', `b ${HANGUL}`, 'a'] });

  for (const argv of [
    ['--json'], ['--json', '--demo'], ['--demo', '--repo', 'a'], ['--repo', 'a', '--demo=x.jsonl'], ['--demo', '--demo'], ['--demo=a', '--demo'],
    ['--no-open', '--no-open'], ['--repo'], ['--repo', ''], ['--repo', '--no-open'], ['--repo=a'], ['--demo='], ['--no-open=1'],
    ['--No-Open'], ['--help'], ['-h'], ['--version'], ['view'], ['x'], [''], ['--'], ['--stop'], ['--lang', 'ko'],
  ]) {
    assert.deepEqual(parseViewFlags(argv), REFUSE, JSON.stringify(argv));
  }
});

test('UX-01: an environment value that throws when read (the locale, the TTY check, the home folder, the cwd) ends in UI_INTERNAL_ERROR and exit 2, never a raw error', async () => {
  const t = await makeTempRoot('viz-env-throws');
  try {
    const { pluginRoot } = fakePluginRoot(t.root);
    for (const key of ['locale', 'isTTY', 'home', 'cwd'] as const) {
      // No CLAUDE_PLUGIN_DATA: the data directory is derived from the home folder, so `home` is read too.
      const rec = recordingEnv({ pluginRoot, cwd: t.root, home: t.root, env: {} });
      Object.defineProperty(rec.env, key, { get() { throw new Error(`boom at ${t.root}`); } });
      assert.equal(await runView(['--demo'], rec.env), 2, key);
      assert.deepEqual(rec.outs, [], key);
      assert.deepEqual(assertAllRendered(rec, { channel: 'terminal', lang: 'en', cmd: null }), ['UI_INTERNAL_ERROR'], key);
      assert.ok(!rec.errs.some((s) => s.includes('boom') || s.includes(t.root)), key);
    }
  } finally {
    await t.cleanup();
  }
});

test('realCliEnv reads nothing when it is built: every value that can throw is read inside runView', () => {
  const env = realCliEnv();
  for (const key of ['pluginRoot', 'cwd', 'isTTY', 'home', 'locale', 'uid']) {
    const d = Object.getOwnPropertyDescriptor(env, key);
    assert.ok(d !== undefined && typeof d.get === 'function', `${key} is read lazily`);
  }
});

test('output modes follow 10-product §2: a TTY stdout is tty; else CLAUDECODE present is slash, absent is pipe', () => {
  assert.equal(outputMode(true, {}), 'tty');
  assert.equal(outputMode(true, { CLAUDECODE: '1' }), 'tty');
  assert.equal(outputMode(false, { CLAUDECODE: '1' }), 'slash');
  assert.equal(outputMode(false, { CLAUDECODE: '' }), 'slash');
  assert.equal(outputMode(false, {}), 'pipe');
  assert.equal(outputMode(false, { CLAUDECODE: undefined }), 'pipe');
});

test('launchUrl builds the launch URL from the integer port and the hex token only, and URL_RE accepts nothing else', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(launchUrl(8080, hex), `http://127.0.0.1:8080/#k=${hex}`);
  assert.equal(launchUrl(65535, hex), `http://127.0.0.1:65535/#k=${hex}`);
  assert.equal(launchUrl(1, hex), `http://127.0.0.1:1/#k=${hex}`);
  for (const port of [0, -1, 65536, 99999, 8080.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(launchUrl(port, hex), null, String(port));
  for (const launch of ['ab'.repeat(31), 'ab'.repeat(33), 'AB'.repeat(32), `${'ab'.repeat(31)}a/`, `${'ab'.repeat(31)}\n`, '']) {
    assert.equal(launchUrl(8080, launch), null, launch);
  }
  assert.ok(URL_RE.test(`http://127.0.0.1:8080/#k=${hex}`));
  for (const bad of [
    `http://127.0.0.1:08080/#k=${hex}`, `http://127.0.0.1:8080/#k=${hex}\n`, `https://127.0.0.1:8080/#k=${hex}`, `http://localhost:8080/#k=${hex}`,
    `http://127.0.0.1:8080/x#k=${hex}`, `http://127.0.0.1:8080/#k=${hex}&x`, ` http://127.0.0.1:8080/#k=${hex}`,
  ]) {
    assert.ok(!URL_RE.test(bad), bad);
  }
});

test('paths are made absolute against the CLI cwd; \\\\server\\share, //host/x, \\\\.\\x, \\\\?\\C:\\x and /dev/x are refused with RF_VIZ_REPO_NOT_LIVE or RF_VIZ_DEMO_INVALID; spaces and Hangul pass', async () => {
  // cli/paths.ts is an import-free leaf (R-V54).
  const pathsTs = fileURLToPath(new URL('../../../src/viz/cli/paths.ts', import.meta.url));
  const info = ts.preProcessFile(readFileSync(pathsTs, 'utf8'), true, true);
  assert.deepEqual(info.importedFiles.map((f) => f.fileName), []);
  assert.deepEqual(info.referencedFiles, []);

  const refused = ['\\\\server\\share', '//host/x', '\\\\.\\x', '\\\\?\\C:\\x', '/dev/x', '\\/server/share', '/\\server\\share', '/dev'];
  for (const p of refused) {
    assert.equal(isUncOrDevice(p), true, p);
    assert.equal(absolutize(p, 'C:\\Users\\me', 'win32'), null, `win32 ${p}`);
    assert.equal(absolutize(p, '/home/me', 'linux'), null, `linux ${p}`);
  }
  for (const p of ['C:\\x', 'repo', '/home/me', '\\rooted', '/devices', 'dev/x']) assert.equal(isUncOrDevice(p), false, p);

  const winCwd = `C:\\Users\\${HANGUL}\\\u{ACF5} \u{BC31}`;
  assert.equal(absolutize('repo', winCwd, 'win32'), `${winCwd}\\repo`);
  assert.equal(absolutize(`sub dir/${HANGUL}`, winCwd, 'win32'), `${winCwd}\\sub dir\\${HANGUL}`);
  assert.equal(absolutize('..\\other dir', winCwd, 'win32'), `C:\\Users\\${HANGUL}\\other dir`);
  assert.equal(absolutize('D:/x/./y/../z/', winCwd, 'win32'), 'D:\\x\\z');
  assert.equal(absolutize('\\rooted\\x', winCwd, 'win32'), 'C:\\rooted\\x');
  assert.equal(absolutize('..\\..\\..\\..', winCwd, 'win32'), 'C:\\');
  assert.equal(absolutize('C:relative', winCwd, 'win32'), null);
  assert.equal(absolutize('', winCwd, 'win32'), null);
  assert.equal(absolutize('repo', '\\\\server\\share\\cwd', 'win32'), null);
  assert.equal(absolutize('repo', 'relative\\cwd', 'win32'), null);

  const posixCwd = `/home/${HANGUL}/\u{ACF5} \u{BC31}`;
  assert.equal(absolutize('repo', posixCwd, 'linux'), `${posixCwd}/repo`);
  assert.equal(absolutize(`./sub dir//${HANGUL}/`, posixCwd, 'darwin'), `${posixCwd}/sub dir/${HANGUL}`);
  assert.equal(absolutize('/abs/x/../y', posixCwd, 'linux'), '/abs/y');
  assert.equal(absolutize('../../../dev/null', '/home/me', 'linux'), null);
  assert.equal(absolutize('../../..', '/home/me', 'linux'), '/');
  assert.equal(absolutize('', posixCwd, 'linux'), null);
  assert.equal(absolutize('repo', 'relative/cwd', 'linux'), null);

  // The cwd decides only relative (and win32 rooted) inputs: an absolute path stands whatever the cwd, a UNC or /dev cwd included.
  assert.equal(absolutize('D:\\x\\y', '\\\\server\\share\\cwd', 'win32'), 'D:\\x\\y');
  assert.equal(absolutize('D:/x/../y', '\\\\?\\C:\\cwd', 'win32'), 'D:\\y');
  assert.equal(absolutize('C:\\abs', 'relative\\cwd', 'win32'), 'C:\\abs');
  assert.equal(absolutize('/abs/x', '/dev/shm', 'linux'), '/abs/x');
  assert.equal(absolutize('/abs/x', 'relative/cwd', 'darwin'), '/abs/x');
  for (const p of ['repo', '.\\repo', '..\\x', '\\rooted']) assert.equal(absolutize(p, '\\\\server\\share\\cwd', 'win32'), null, p);
  for (const p of ['repo', './repo', '../x']) assert.equal(absolutize(p, '/dev/shm', 'linux'), null, p);
  assert.equal(absolutize('/dev/x', '/home/me', 'linux'), null);

  // Through runView: the refusal codes, nothing spawned; spaces and Hangul reach the viewer absolute.
  const t = await makeTempRoot('viz-paths');
  try {
    const { pluginRoot } = fakePluginRoot(t.root);
    const base = { pluginRoot, cwd: t.root, home: t.root, env: { CLAUDE_PLUGIN_DATA: join(t.root, 'data') } };
    for (const [argv, code] of [
      [['--repo', '\\\\server\\share\\repo'], 'RF_VIZ_REPO_NOT_LIVE'], [['--repo', '//host/x'], 'RF_VIZ_REPO_NOT_LIVE'],
      [['--repo', '/dev/x'], 'RF_VIZ_REPO_NOT_LIVE'], [['--demo=\\\\.\\x'], 'RF_VIZ_DEMO_INVALID'], [['--demo=\\\\?\\C:\\x'], 'RF_VIZ_DEMO_INVALID'],
    ] as const) {
      const rec = recordingEnv(base);
      assert.equal(await runView(argv, rec.env), 1, argv.join(' '));
      assert.deepEqual(rec.spawned, []);
      assert.deepEqual(rec.outs, []);
      assert.deepEqual(assertAllRendered(rec, { channel: 'terminal', lang: 'en', cmd: null }), [code]);
      if (code === 'RF_VIZ_DEMO_INVALID') assert.match(rec.errs[0] ?? '', /first bad line: 0\)/);
    }

    const git = findSystemGit();
    assert.ok(git !== null, 'a git on PATH');
    const rel = `sub dir/${HANGUL}`;
    const rec = recordingEnv({ ...base, env: { ...base.env, PATH: join(git, '..') } });
    assert.equal(await runView(['--no-open', '--repo', rel, '--repo', join(t.root, 'other repo')], rec.env), 0, rec.errs.join('\n'));
    assert.equal(rec.spawned.length, 1);
    assert.deepEqual(rec.spawned[0]?.repos, [join(t.root, 'sub dir', HANGUL), join(t.root, 'other repo')]);
    assert.deepEqual(assertAllRendered(rec, { channel: 'terminal', lang: 'en', cmd: null }), ['UI_VIZ_URL']);
    const demo = recordingEnv(base);
    assert.equal(await runView(['--no-open', `--demo=${rel}.jsonl`], demo.env), 0, demo.errs.join('\n'));
    assert.equal(demo.spawned[0]?.demo, `${join(t.root, 'sub dir', HANGUL)}.jsonl`);
    assert.deepEqual(assertAllRendered(demo, { channel: 'terminal', lang: 'en', cmd: null }), ['UI_VIZ_URL']);
  } finally {
    await t.cleanup();
  }
});
