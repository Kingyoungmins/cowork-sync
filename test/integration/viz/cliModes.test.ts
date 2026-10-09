// `cli.js view` per output mode, its refusals and its output discipline (Task 11; 12 §1.2, §3.2 items 1 and 10, §3.10.9; VIZ-02, VIZ-04
// in its 8a subset; 10-product §2, §3.4, UX-01; R-V11, R-V14, R-V54).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { render, type RenderChannel } from '../../../src/i18n/render.js';
import type { Fs } from '../../../src/ports/fs.js';
import { PLUGIN_VERSION } from '../../../src/version.js';
import { realOwnerProbe, type OwnerProbe } from '../../../src/viz/cli/ownerProbe.js';
import { READY_REFUSE_CODES, type ReadyLine } from '../../../src/viz/cli/spawn.js';
import { runView, URL_RE, type CliEnv } from '../../../src/viz/cli/view.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import {
  assertAllRendered, fakePluginRoot, findSystemGit, hostFs, PROBE_LAUNCH, PROBE_PORT, recordingEnv, renderedCode, type Recording,
} from '../../helpers/vizCli.js';

const LAUNCH_URL = `http://127.0.0.1:${PROBE_PORT}/#k=${PROBE_LAUNCH}`;
const URL_ANY = /http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#k=[0-9a-f]{64}/g;
const HEX64 = /[0-9a-f]{64}/;
const NEXT: Readonly<Record<string, string>> = {
  RF_VIZ_BIND_FAILED: '/cowork doctor', RF_VIZ_START_FAILED: '/cowork doctor', RF_VIZ_NO_ROOMS: '/cowork start', RF_VIZ_REPO_NOT_LIVE: '/cowork start',
  RF_VIZ_DEMO_INVALID: '(none: fix the demo file)', START_TOOL_VERSION: '/cowork doctor', RF_UNKNOWN_FLAG: '(none: run view with only those flags)',
};

interface Fixture { root: string; pluginRoot: string; cli: string; dataDir: string; cleanup(): Promise<void>; }
async function fixture(label: string): Promise<Fixture> {
  const t = await makeTempRoot(label);
  const { pluginRoot } = fakePluginRoot(t.root);
  return { root: t.root, pluginRoot, cli: join(pluginRoot, 'dist', 'cli.js'), dataDir: join(t.root, 'data'), cleanup: t.cleanup };
}

/**
 * One runView call over a recording env; returns the recording, the exit code and the codes it printed (UX-01 oracle checked). With
 * `tokenFree` (a name for the message), the output is first scanned for a 64-hex token, before the oracle or any other check reads it:
 * the scan is then the check that fails when a token is printed (VIZ-04), whatever the rest of the output looks like.
 */
async function view(f: Fixture, argv: string[], o: {
  isTTY?: boolean; env?: Record<string, string>; ready?: ReadyLine | (() => Promise<ReadyLine>); opens?: boolean; over?: Partial<CliEnv>; cmd?: string | null;
  tokenFree?: string;
} = {}): Promise<{ rec: Recording; code: number; codes: string[] }> {
  const env = o.env ?? { CLAUDE_PLUGIN_DATA: f.dataDir };
  const rec = recordingEnv({ pluginRoot: f.pluginRoot, cwd: f.root, home: f.root, env, isTTY: o.isTTY ?? true, ...o.over }, o.ready, o.opens ?? true);
  const code = await runView(argv, rec.env);
  if (o.tokenFree !== undefined) {
    const leaked = [...rec.outs, ...rec.errs].filter((s) => HEX64.test(s));
    assert.deepEqual(leaked, [], `a 64-hex token in the ${o.tokenFree} output`);
  }
  const channel: RenderChannel = rec.env.isTTY || env.CLAUDECODE === undefined ? 'terminal' : 'slash';
  const codes = assertAllRendered(rec, { channel, lang: 'en', cmd: o.cmd ?? null });
  return { rec, code, codes };
}

test('T-VIZ-cli-modes (8a): pipe and slash start nothing and print UI_VIZ_TERMINAL_ONLY with the terminal command; tty opens and prints UI_VIZ_OPENED; tty --no-open and a simulated open failure print UI_VIZ_URL; a 64-hex token appears only in those two tty outputs', async () => {
  const f = await fixture('viz-modes');
  try {
    // pipe (no CLAUDECODE) and slash (CLAUDECODE=1 with a non-TTY stdout): nothing started, nothing created, the terminal command; no
    // 64-hex token in the output (scanned first, by view()).
    for (const [mode, env] of [['pipe', { CLAUDE_PLUGIN_DATA: f.dataDir }], ['slash', { CLAUDE_PLUGIN_DATA: f.dataDir, CLAUDECODE: '1' }]] as const) {
      for (const [argv, cmd] of [
        [['--demo'], `node "${f.cli}" view --demo`],
        [['--no-open', '--demo'], `node "${f.cli}" view --no-open --demo`],
        [['--repo', 'rel dir', '--repo', join(f.root, 'abs')], `node "${f.cli}" view --repo "${join(f.root, 'rel dir')}" --repo "${join(f.root, 'abs')}"`],
        [['--demo=x.jsonl'], `node "${f.cli}" view --demo="${join(f.root, 'x.jsonl')}"`],
      ] as const) {
        const r = await view(f, [...argv], { isTTY: false, env, cmd, tokenFree: `${mode} ${argv.join(' ')}` });
        assert.equal(r.code, 0, `${mode} ${argv.join(' ')}`);
        assert.deepEqual(r.codes, ['UI_VIZ_TERMINAL_ONLY']);
        assert.equal(r.rec.outs[0], render('UI_VIZ_TERMINAL_ONLY', { cmd }, mode === 'slash' ? 'slash' : 'terminal', 'en'));
        assert.deepEqual(r.rec.spawned, []);
        assert.deepEqual(r.rec.opened, []);
      }
    }
    assert.equal(existsSync(f.dataDir), false, 'pipe and slash never touch the data directory');

    // tty: opens and says so; the URL never printed (no 64-hex token, scanned first).
    const opened = await view(f, ['--demo'], { tokenFree: 'tty open' });
    assert.equal(opened.code, 0);
    assert.deepEqual(opened.codes, ['UI_VIZ_OPENED']);
    assert.deepEqual(opened.rec.opened.map((o) => o.url), [LAUNCH_URL]);
    assert.equal(opened.rec.spawned.length, 1);
    // tty --no-open and a failed open: the URL, exactly once.
    const noOpen = await view(f, ['--no-open', '--demo']);
    const failed = await view(f, ['--demo'], { opens: false });
    for (const [name, r] of [['tty --no-open', noOpen], ['tty open failure', failed]] as const) {
      assert.equal(r.code, 0, name);
      assert.deepEqual(r.codes, ['UI_VIZ_URL'], name);
      assert.equal(r.rec.outs[0], render('UI_VIZ_URL', { url: LAUNCH_URL }, 'terminal', 'en'));
      assert.equal(r.rec.outs.join('\n').match(URL_ANY)?.length, 1, name);
      assert.ok(URL_RE.test(r.rec.outs.join('\n').match(URL_ANY)?.[0] ?? ''));
    }
    assert.deepEqual(noOpen.rec.opened, []);
    assert.equal(failed.rec.opened.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('the UX-01 oracle refuses every string that is not a render() result (negative self-test)', () => {
  const rec = (outs: string[], errs: string[] = []): Recording => ({ env: undefined as unknown as CliEnv, outs, errs, spawned: [], opened: [] });
  const o = { channel: 'terminal' as const, lang: 'en' as const, cmd: 'node "/p/dist/cli.js" view --demo' };
  const opened = render('UI_VIZ_OPENED', {}, 'terminal', 'en');
  const terminalOnly = render('UI_VIZ_TERMINAL_ONLY', { cmd: o.cmd }, 'terminal', 'en');
  assert.deepEqual(assertAllRendered(rec([opened, terminalOnly]), o), ['UI_VIZ_OPENED', 'UI_VIZ_TERMINAL_ONLY']);
  for (const s of [
    'raw text', `${opened} `, `${opened}\n`, opened.toUpperCase(), opened.slice(1), `Error: boom\n    at runView (view.ts:1:1)`, '',
    render('UI_VIZ_TERMINAL_ONLY', { cmd: 'node "/q/dist/cli.js" view' }, 'terminal', 'en'),   // another command than the one printed
    render('RF_VIZ_DEMO_INVALID', { n: 3 }, 'terminal', 'en').replace('[RF_VIZ_DEMO_INVALID]', '[RF_VIZ_NO_ROOMS]'),
  ]) {
    assert.throws(() => assertAllRendered(rec([s]), o), /not a render\(\) result/, JSON.stringify(s));
    assert.throws(() => assertAllRendered(rec([opened], [s]), o), /not a render\(\) result/, JSON.stringify(s));
    assert.equal(renderedCode(s, o), null, JSON.stringify(s));
  }
});

test('the ready line\'s line number reaches the RF_VIZ_DEMO_INVALID message', async () => {
  const f = await fixture('viz-demo-line');
  try {
    for (const n of [0, 7, 999]) {
      const r = await view(f, ['--demo'], { ready: { refuse: 'RF_VIZ_DEMO_INVALID', line: n } });
      assert.equal(r.code, 1);
      assert.deepEqual(r.rec.errs, [render('RF_VIZ_DEMO_INVALID', { n }, 'terminal', 'en')]);
      assert.match(r.rec.errs[0] as string, new RegExp(`\\(first bad line: ${n}\\) \\[RF_VIZ_DEMO_INVALID\\]`));
    }
    // Without a line on the ready line: '?', never a number the viewer did not send.
    const none = await view(f, ['--demo'], { ready: { refuse: 'RF_VIZ_DEMO_INVALID' } });
    assert.match(none.rec.errs[0] as string, /\(first bad line: \?\)/);
  } finally {
    await f.cleanup();
  }
});

test('slash mode renders on the slash channel (its 4,000-character cap applies), pipe mode on the terminal channel', async () => {
  const f = await fixture('viz-slash-channel');
  try {
    // A command over the slash cap: the two channels render it differently, so the output shows which one was used.
    const long = join(f.root, 'x'.repeat(4_100));
    const cmd = `node "${f.cli}" view --repo "${long}"`;
    const slash = render('UI_VIZ_TERMINAL_ONLY', { cmd }, 'slash', 'en');
    const terminal = render('UI_VIZ_TERMINAL_ONLY', { cmd }, 'terminal', 'en');
    assert.notEqual(slash, terminal);
    const s = await view(f, ['--repo', long], { isTTY: false, env: { CLAUDE_PLUGIN_DATA: f.dataDir, CLAUDECODE: '1' }, cmd });
    assert.deepEqual(s.rec.outs, [slash]);
    const p = await view(f, ['--repo', long], { isTTY: false, cmd });
    assert.deepEqual(p.rec.outs, [terminal]);
  } finally {
    await f.cleanup();
  }
});

/** dist/cli.js of the fake plugin root for the quoting test: writes its argv as JSON to COWORK_ARGV_OUT. */
const ARGV_WRITER = "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.COWORK_ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n";
const RUN_THERE = 'Run there: ';
const WIN_ROOT = process.env.SystemRoot ?? 'C:\\Windows';

/** A POSIX sh: /bin/sh, or on Windows the sh.exe of the Git for Windows that provides git. */
function posixSh(): string | null {
  if (process.platform !== 'win32') return existsSync('/bin/sh') ? '/bin/sh' : null;
  const git = findSystemGit();
  for (let d = git === null ? null : dirname(git), i = 0; d !== null && i < 3; d = dirname(d), i += 1) {
    for (const sh of [join(d, 'bin', 'sh.exe'), join(d, 'usr', 'bin', 'sh.exe')]) if (existsSync(sh)) return sh;
  }
  return null;
}

/** The argv a shell gives `node <cli.js> …` for `line`, typed as the user would paste it; null when that shell is not on this host. */
function argvViaShell(shell: 'powershell' | 'cmd' | 'sh', line: string, dir: string): string[] | null {
  const out = join(dir, `argv-${shell}.json`);
  rmSync(out, { force: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.COWORK_ARGV_OUT = out;
  let r: ReturnType<typeof spawnSync>;
  if (shell === 'powershell') {
    const ps = win32.join(WIN_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(line, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true });
  } else if (shell === 'cmd') {
    r = spawnSync(win32.join(WIN_ROOT, 'System32', 'cmd.exe'), ['/d', '/s', '/c', `"${line}"`], { env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  } else {
    const sh = posixSh();
    if (sh === null) return null;
    const script = join(dir, 'line.sh');
    writeFileSync(script, `${line}\n`);
    r = spawnSync(sh, [script], { env: { ...env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' }, encoding: 'utf8' });
  }
  assert.equal(r.status, 0, `${shell}: ${String(r.stderr)}`);
  return JSON.parse(readFileSync(out, 'utf8')) as string[];
}

test('the printed terminal command is quoted for the shell it targets (PowerShell on Windows, POSIX sh elsewhere; cmd.exe reads the double-quoted form): each shell gives back the exact paths with spaces, quotes, $, backticks and %', async () => {
  const f = await fixture('viz-quote');
  try {
    writeFileSync(f.cli, ARGV_WRITER);
    const printed = async (platform: NodeJS.Platform, argv: string[]): Promise<string> => {
      const rec = recordingEnv({ pluginRoot: f.pluginRoot, cwd: f.root, home: f.root, env: { CLAUDE_PLUGIN_DATA: f.dataDir }, isTTY: false, platform });
      assert.equal(await runView(argv, rec.env), 0, rec.errs.join('\n'));
      const s = rec.outs[0] as string;
      return s.slice(s.indexOf(RUN_THERE) + RUN_THERE.length);
    };
    const repoArgs = (paths: readonly string[]): string[] => paths.flatMap((p) => ['--repo', p]);

    // POSIX sh (the target off Windows; on Windows Git's sh.exe reads a line printed for 'linux').
    // Each special character also alone in a path, so a quoting that misses one of them cannot hide behind another.
    const shPaths = ['/t/a b\'c"d$e`f%g!h', '/t/cost $HOME x', '/t/q `true` z', '/t/it\'s', '/t/plain dir', '/t/x\\y', `/t/${'\u{D55C}'} \u{AE00}`];
    const sh = argvViaShell('sh', await printed('linux', repoArgs(shPaths)), f.root);
    if (sh !== null) {
      assert.deepEqual(sh, ['view', ...repoArgs(shPaths)]);
      const demo = '/t/d $x`y\'z".jsonl';
      assert.deepEqual(argvViaShell('sh', await printed('linux', ['--no-open', `--demo=${demo}`]), f.root), ['view', '--no-open', `--demo=${demo}`]);
    }
    if (process.platform !== 'win32') return;

    // PowerShell (the target on Windows): single quotes wherever $, a backtick or a PowerShell quote character would act.
    const psPaths = [
      "C:\\t\\a b'c$d`e%PATH%f", 'C:\\t\\cost $HOME x', 'C:\\t\\a`tb', 'C:\\t\\x\u2019y$z', 'C:\\t\\it\u201Cs', 'C:\\t\\plain dir', "C:\\t\\a&b(c)'d",
      `C:\\t\\${'\u{D55C}'} dir`,
    ];
    assert.deepEqual(argvViaShell('powershell', await printed('win32', repoArgs(psPaths)), f.root), ['view', ...repoArgs(psPaths)]);
    const psDemo = 'C:\\t\\d $x`y.jsonl';
    assert.deepEqual(argvViaShell('powershell', await printed('win32', [`--demo=${psDemo}`]), f.root), ['view', `--demo=${psDemo}`]);
    // cmd.exe: the double-quoted words printed for paths PowerShell takes in double quotes read the same in cmd.exe (an undefined %NAME%
    // stays as typed).
    const cmdPaths = ["C:\\t\\a b&c(d)'x%COWORK_UNSET_NAME%y", `C:\\t\\${'\u{D55C}'} dir`];
    const cmdLine = await printed('win32', repoArgs(cmdPaths));
    assert.ok(!cmdLine.includes("'C:"), cmdLine);
    assert.deepEqual(argvViaShell('cmd', cmdLine, f.root), ['view', ...repoArgs(cmdPaths)]);
    // The --demo="…" form: one word with the quotes after the '=', read the same by cmd.exe and by PowerShell.
    const cmdDemo = `C:\\t\\d b&c(d)'x%COWORK_UNSET_NAME%y ${'\u{D55C}'}.jsonl`;
    const demoLine = await printed('win32', ['--no-open', `--demo=${cmdDemo}`]);
    assert.ok(demoLine.endsWith(` --demo="${cmdDemo}"`), demoLine);
    assert.deepEqual(argvViaShell('cmd', demoLine, f.root), ['view', '--no-open', `--demo=${cmdDemo}`]);
    assert.deepEqual(argvViaShell('powershell', demoLine, f.root), ['view', '--no-open', `--demo=${cmdDemo}`]);
  } finally {
    await f.cleanup();
  }
});

test('T-VIZ-lints (UX-01): every string runView passes to out() and err() is a render() result', async () => {
  const f = await fixture('viz-ux01');
  try {
    const git = findSystemGit();
    assert.ok(git !== null);
    const cases: Array<[string, Promise<{ code: number; codes: string[] }>, number, string[]]> = [];
    const add = (name: string, p: Promise<{ code: number; codes: string[] }>, code: number, codes: string[]): void => { cases.push([name, p, code, codes]); };
    const cmdDemo = `node "${f.cli}" view --demo`;
    add('pipe', view(f, ['--demo'], { isTTY: false, cmd: cmdDemo }), 0, ['UI_VIZ_TERMINAL_ONLY']);
    add('slash', view(f, ['--demo'], { isTTY: false, env: { CLAUDECODE: '1' }, cmd: cmdDemo }), 0, ['UI_VIZ_TERMINAL_ONLY']);
    add('pipe --json', view(f, ['--json'], { isTTY: false }), 1, ['RF_UNKNOWN_FLAG']);
    add('slash --json', view(f, ['--json'], { isTTY: false, env: { CLAUDECODE: '1' } }), 1, ['RF_UNKNOWN_FLAG']);
    add('tty unknown flag', view(f, ['--demo', '--repo', 'x']), 1, ['RF_UNKNOWN_FLAG']);
    add('tty open', view(f, ['--demo']), 0, ['UI_VIZ_OPENED']);
    add('tty --no-open', view(f, ['--demo', '--no-open']), 0, ['UI_VIZ_URL']);
    add('tty open failure', view(f, ['--demo'], { opens: false }), 0, ['UI_VIZ_URL']);
    add('UNC repo', view(f, ['--repo', '\\\\server\\share']), 1, ['RF_VIZ_REPO_NOT_LIVE']);
    add('device demo', view(f, ['--demo=\\\\.\\pipe\\x']), 1, ['RF_VIZ_DEMO_INVALID']);
    add('no data dir', view(f, ['--demo'], { env: {}, over: { home: 'relative home' } }), 1, ['RF_VIZ_START_FAILED']);
    const failing: OwnerProbe = { posix: async () => null, euid: () => null, windows: async () => null };
    add('data dir fails', view(f, ['--demo'], { over: { ownerProbe: failing } }), 1, ['RF_VIZ_START_FAILED']);
    add('no git', view(f, ['--repo', f.root], { env: { CLAUDE_PLUGIN_DATA: f.dataDir, PATH: join(f.root, 'empty') } }), 1, ['START_TOOL_VERSION']);
    add('repo with git', view(f, ['--no-open', '--repo', f.root], { env: { CLAUDE_PLUGIN_DATA: f.dataDir, PATH: join(git, '..') } }), 0, ['UI_VIZ_URL']);
    add('no viz.js', view(f, ['--demo'], { over: { pluginRoot: join(f.root, 'nowhere') } }), 1, ['RF_VIZ_START_FAILED']);
    for (const c of READY_REFUSE_CODES) {
      const ready: ReadyLine = c === 'RF_VIZ_DEMO_INVALID' ? { refuse: c, line: 9 } : { refuse: c };
      add(`ready ${c}`, view(f, ['--demo'], { ready }), 1, [c]);
    }
    add('ready foreign code', view(f, ['--demo'], { ready: { refuse: 'UI_VIZ_LINK_REUSED' } }), 1, ['RF_VIZ_START_FAILED']);
    add('ready bad port', view(f, ['--demo'], { ready: { port: 0, launch: PROBE_LAUNCH } }), 1, ['RF_VIZ_START_FAILED']);
    add('ready bad token', view(f, ['--demo'], { ready: { port: PROBE_PORT, launch: 'x'.repeat(64) } }), 1, ['RF_VIZ_START_FAILED']);
    add('internal error', view(f, ['--demo'], { ready: () => Promise.reject(new Error(`boom at ${f.root}`)) }), 2, ['UI_INTERNAL_ERROR']);
    for (const [name, p, code, codes] of cases) {
      const r = await p;
      assert.equal(r.code, code, name);
      assert.deepEqual(r.codes, codes, name);
    }
  } finally {
    await f.cleanup();
  }
});

test('refusals print in the 10-product §3.4 two-line format with the 12 §1.2 next line', async () => {
  const f = await fixture('viz-refusals');
  try {
    // [code, run, spawned]: the CLI's own refusals start nothing; a refusal on the ready line comes from the one spawned viewer.
    const paths: Array<[string, Promise<{ rec: Recording; code: number }>, number]> = [
      ['RF_UNKNOWN_FLAG', view(f, ['--json']), 0],
      ['RF_VIZ_REPO_NOT_LIVE', view(f, ['--repo', '//host/x']), 0],
      ['RF_VIZ_DEMO_INVALID', view(f, ['--demo=/dev/x']), 0],
      ['RF_VIZ_START_FAILED', view(f, ['--demo'], { over: { ownerProbe: { posix: async () => null, euid: () => null, windows: async () => null } } }), 0],
      ['START_TOOL_VERSION', view(f, ['--repo', f.root], { env: { CLAUDE_PLUGIN_DATA: f.dataDir, PATH: '' } }), 0],
      ...[...READY_REFUSE_CODES].map((c): [string, Promise<{ rec: Recording; code: number }>, number] =>
        [c, view(f, ['--demo'], { ready: c === 'RF_VIZ_DEMO_INVALID' ? { refuse: c, line: 4 } : { refuse: c } }), 1]),
    ];
    for (const [code, p, spawned] of paths) {
      const { rec, code: exit } = await p;
      assert.equal(exit, 1, code);
      assert.deepEqual(rec.outs, [], code);
      assert.equal(rec.errs.length, 1, code);
      const lines = (rec.errs[0] as string).split('\n');
      assert.equal(lines.length, 2, code);
      assert.match(lines[0] as string, new RegExp(`^cowork-sync: \\S.* \\[${code}\\]$`), code);
      assert.equal(lines[1], `next: ${NEXT[code]}`, code);
      assert.equal(rec.spawned.length, spawned, code);
    }
  } finally {
    await f.cleanup();
  }
});

/** Fs over hostFs that records every path read with readFile. */
function readSpy(reads: string[]): Fs {
  return { ...hostFs, readFile: (p: string) => { reads.push(p); return hostFs.readFile(p); } };
}

function icacls(args: string[]): void {
  const exe = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `icacls ${args.join(' ')}: ${r.stdout}${r.stderr}`);
}

test('T-VIZ-handshake: a data directory that fails SEC-20 → RF_VIZ_START_FAILED and nothing is spawned or read', async () => {
  const f = await fixture('viz-sec20');
  try {
    const refused = async (dataDir: string, probe: OwnerProbe): Promise<void> => {
      const reads: string[] = [];
      const r = await view(f, ['--demo'], { env: { CLAUDE_PLUGIN_DATA: dataDir }, over: { ownerProbe: probe, fs: readSpy(reads), uid: process.geteuid?.() ?? null } });
      assert.equal(r.code, 1, dataDir);
      assert.deepEqual(r.codes, ['RF_VIZ_START_FAILED'], dataDir);
      assert.deepEqual(r.rec.spawned, [], dataDir);
      assert.deepEqual(reads, [], dataDir);
    };
    if (process.platform === 'win32') {
      // An added Everyone ACE (by SID: works on any Windows display language), and a junction data directory.
      const wide = join(f.root, 'wide data');
      mkdirSync(wide);
      icacls([wide, '/grant', '*S-1-1-0:(R)']);
      await refused(wide, realOwnerProbe);
      const target = join(f.root, 'junction target');
      mkdirSync(target);
      const junction = join(f.root, 'junction data');
      symlinkSync(target, junction, 'junction');
      await refused(junction, realOwnerProbe);
      // A localized Windows passes because SIDs are compared: this host's own user-only directory, by the real probe.
      const ok = await view(f, ['--demo'], { env: { CLAUDE_PLUGIN_DATA: join(f.root, `ok data ${'\u{D55C}'}`) }, over: { ownerProbe: realOwnerProbe } });
      assert.deepEqual(ok.codes, ['UI_VIZ_OPENED']);
      assert.equal(ok.rec.spawned.length, 1);
    } else {
      // Mode 0755, and a foreign owner (the probe reports another uid: a test cannot chown).
      const open = join(f.root, 'open data');
      mkdirSync(open);
      chmodSync(open, 0o755);
      await refused(open, realOwnerProbe);
      const foreign = join(f.root, 'foreign data');
      mkdirSync(foreign, { mode: 0o700 });
      await refused(foreign, { ...realOwnerProbe, posix: async (p) => { const s = await realOwnerProbe.posix(p); return s && { ...s, uid: s.uid + 1 }; } });
      const target = join(f.root, 'link target');
      mkdirSync(target, { mode: 0o700 });
      const link = join(f.root, 'link data');
      symlinkSync(target, link);
      await refused(link, realOwnerProbe);
      // Named with a trailing separator, lstat would follow the link: the CLI checks the name without it.
      await refused(`${link}/`, realOwnerProbe);
      const ok = await view(f, ['--demo'], { env: { CLAUDE_PLUGIN_DATA: join(f.root, 'ok data') }, over: { ownerProbe: realOwnerProbe, uid: process.geteuid?.() ?? null } });
      assert.deepEqual(ok.codes, ['UI_VIZ_OPENED']);
    }
  } finally {
    await f.cleanup();
  }
});

test('cli.js view is dispatched; --version and the no-argument no-op are unchanged', async () => {
  const t = await makeTempRoot('viz-clijs');
  try {
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const dist = join(t.root, 'dist');
    const b = spawnSync(process.execPath, [join(repo, 'tools', 'build', 'build.mjs'), '--outdir', dist], { cwd: repo, encoding: 'utf8' });
    assert.equal(b.status, 0, `build failed:\n${b.stdout}\n${b.stderr}`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== 'CLAUDECODE') env[k] = v;
    const cli = (...argv: string[]) => spawnSync(process.execPath, [join(dist, 'cli.js'), ...argv], { cwd: t.root, env, encoding: 'utf8' });

    // view in pipe mode (stdout is a pipe, no CLAUDECODE): the terminal command, nothing started.
    const piped = cli('view', '--demo');
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal(piped.stdout, `${render('UI_VIZ_TERMINAL_ONLY', { cmd: `node "${join(dist, 'cli.js')}" view --demo` }, 'terminal', 'en')}\n`);
    assert.equal(piped.stderr, '');
    const slash = spawnSync(process.execPath, [join(dist, 'cli.js'), 'view'], { cwd: t.root, env: { ...env, CLAUDECODE: '1' }, encoding: 'utf8' });
    assert.equal(slash.status, 0);
    assert.equal(slash.stdout, `${render('UI_VIZ_TERMINAL_ONLY', { cmd: `node "${join(dist, 'cli.js')}" view` }, 'slash', 'en')}\n`);
    const json = cli('view', '--json');
    assert.equal(json.status, 1);
    assert.equal(json.stdout, '');
    assert.equal(json.stderr, `${render('RF_UNKNOWN_FLAG', {}, 'terminal', 'en')}\n`);

    // UX-01: a value the CLI reads from its own environment that throws (Intl, broken here by a preload) prints UI_INTERNAL_ERROR and
    // exits 2: never a stack trace.
    const preload = join(t.root, 'break-intl.mjs');
    writeFileSync(preload, "Intl.DateTimeFormat = function () { throw new Error('boom'); };\n");
    const broken = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(dist, 'cli.js'), 'view', '--demo'], { cwd: t.root, env, encoding: 'utf8' });
    assert.equal(broken.stderr, `${render('UI_INTERNAL_ERROR', {}, 'terminal', 'en')}\n`);
    assert.equal(broken.status, 2);
    assert.equal(broken.stdout, '');

    const version = cli('--version');
    assert.equal(version.status, 0);
    assert.equal(version.stdout, `cowork-sync cli ${PLUGIN_VERSION}\n`);
    const none = cli();
    assert.equal(none.status, 0);
    assert.equal(none.stdout, '');
    assert.equal(none.stderr, '');
  } finally {
    rmSync(join(t.root, 'dist'), { recursive: true, force: true });
    await t.cleanup();
  }
});
