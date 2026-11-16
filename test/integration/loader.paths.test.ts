// Plan 5 Task 4: the target repo (R1-203…R1-205, R2-A3, CCI-07, A4-2; 06 test 1, 06 test 23 `claude -w` half, TC-CCI-02, TC-CCI-16 loader half): the
// `.git`-file notes (WT_NOTE, WT_SUBMODULE) and the edit path deciding the repo under any spelling of a live root. Real git repos, the bundled loader.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonRoot, findRepo } from '../../src/data/canonRoot.js';
import { realRootProbe } from '../../src/ports/fs.js';
import { fakeDaemon, type FakeDaemon } from '../helpers/fakeDaemon.js';
import { buildDist, hookJson, loaderRepo, preToolJson, runLoader, type LoaderRepo } from '../helpers/loaderRun.js';
import { testRunner } from '../helpers/tmp.js';

const IDENTITY = { name: 'Loader Paths', email: 'paths@cowork.invalid' };
let dist = '';
const repos: LoaderRepo[] = [];
const daemons: FakeDaemon[] = [];
before(async () => {
  const holder = await loaderRepo({ label: 'loader-paths-build' });
  repos.push(holder);
  dist = buildDist(join(holder.base, 'build'));
});
after(async () => {
  for (const d of daemons) await d.close();
  for (const r of repos) await r.cleanup();
});

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await testRunner().run(args, { class: 'local', cwd, identity: IDENTITY });
  assert.equal(res.code, 0, `git ${args.join(' ')}: ${res.stderr.toString('utf8')}`);
  return res.stdout.toString('utf8');
}

async function liveRepo(label: string): Promise<{ r: LoaderRepo; d: FakeDaemon }> {
  const r = await loaderRepo({ label, live: true });
  repos.push(r);
  const d = await fakeDaemon(r.endpoint as string, r.key as Buffer);
  daemons.push(d);
  return { r, d };
}

/** Roots to try for a cwd outside every repo: unused drive letters on win32, '/' elsewhere. */
const PLATFORM_ROOTS: string[] = process.platform === 'win32' ? [...'QRSTUVWXYZ'].reverse().map((l) => `${l}:\\`) : ['/'];

const note = (event: string, code: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: `[cowork-sync] ${code}` } });

test('a .git file: WT_NOTE (WT_SUBMODULE under modules/) only on SessionStart, edit-class PreToolUse and SubagentStart when the common gitdir is live', async () => {
  const { r, d } = await liveRepo('loader-paths-wt');
  mkdirSync(join(r.dir, 'src'), { recursive: true });
  writeFileSync(join(r.dir, 'src', 'a.ts'), 'export const a = 1;\n');
  await git(r.dir, ['add', '-A']);
  await git(r.dir, ['commit', '-q', '-m', 'init']);
  const wt = join(r.base, 'wt');
  await git(r.dir, ['worktree', 'add', '-q', '-b', 'wt', wt]);
  const sub = join(r.dir, 'sub');
  mkdirSync(join(r.gitdir, 'modules'), { recursive: true });
  await git(r.dir, ['init', '-q', `--separate-git-dir=${join(r.gitdir, 'modules', 'sub')}`, sub]);
  assert.ok(existsSync(join(wt, '.git')) && existsSync(join(sub, '.git')), 'both checkouts have a .git file');

  const run = (event: string, json: Record<string, unknown>, cwd: string) => runLoader(event, json, { dist, cwd, env: r.env });
  for (const live of [true, false]) {
    r.setLive(live);
    const ss = await run('SessionStart', hookJson('SessionStart', wt), wt);
    assert.deepEqual([ss.exit, ss.stdout, ss.stderr], [0, live ? note('SessionStart', 'WT_NOTE') : '', ''], `live=${live} SessionStart`);
    const edit = await run('PreToolUse', preToolJson('Edit', wt, { filePath: join(wt, 'src', 'a.ts') }), wt);
    assert.deepEqual([edit.exit, edit.stdout, edit.stderr], [0, live ? note('PreToolUse', 'WT_NOTE') : '', ''], `live=${live} PreToolUse Edit: not gated`);
    const sa = await run('SubagentStart', hookJson('SubagentStart', wt), wt);
    assert.deepEqual([sa.exit, sa.stdout], [0, live ? note('SubagentStart', 'WT_NOTE') : ''], `live=${live} SubagentStart in the worktree (A4-2)`);
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
      const q = await run(event, hookJson(event, wt), wt);
      assert.deepEqual([q.exit, q.stdout, q.stderr], [0, '', ''], `live=${live} ${event}`);
    }
    const sm = await run('SessionStart', hookJson('SessionStart', sub), sub);
    assert.deepEqual([sm.exit, sm.stdout, sm.stderr], [0, live ? note('SessionStart', 'WT_SUBMODULE') : '', ''], `live=${live} a submodule checkout`);
  }
  assert.equal(d.connections(), 0, 'a .git file is never live: no IPC');
});

test('a repo under a folder named modules: its linked worktree still gets WT_NOTE and its submodule WT_SUBMODULE (the submodule shape decides, not the name)', async () => {
  const r = await loaderRepo({ label: 'loader-paths-modules', live: true, under: 'modules' });
  repos.push(r);
  const d = await fakeDaemon(r.endpoint as string, r.key as Buffer);
  daemons.push(d);
  assert.ok(r.gitdir.split(/[\\/]/).includes('modules'), `the repo's gitdir path holds a modules folder: ${r.gitdir}`);
  writeFileSync(join(r.dir, 'a.ts'), 'export const a = 1;\n');
  await git(r.dir, ['add', '-A']);
  await git(r.dir, ['commit', '-q', '-m', 'init']);
  const wt = join(r.base, 'wt');
  await git(r.dir, ['worktree', 'add', '-q', '-b', 'wt', wt]);
  // A submodule-shaped checkout: its gitdir is <gitdir>/modules/sub, behind the decoy `modules` folder (whose parent holds no HEAD).
  const sub = join(r.dir, 'sub');
  mkdirSync(join(r.gitdir, 'modules'), { recursive: true });
  await git(r.dir, ['init', '-q', `--separate-git-dir=${join(r.gitdir, 'modules', 'sub')}`, sub]);
  const run = (event: string, json: Record<string, unknown>, cwd: string) => runLoader(event, json, { dist, cwd, env: r.env });
  for (const live of [true, false]) {
    r.setLive(live);
    const ss = await run('SessionStart', hookJson('SessionStart', wt), wt);
    assert.deepEqual([ss.exit, ss.stdout, ss.stderr], [0, live ? note('SessionStart', 'WT_NOTE') : '', ''], `live=${live} SessionStart in the worktree`);
    const edit = await run('PreToolUse', preToolJson('Edit', wt, { filePath: join(wt, 'a.ts') }), wt);
    assert.deepEqual([edit.exit, edit.stdout, edit.stderr], [0, live ? note('PreToolUse', 'WT_NOTE') : '', ''], `live=${live} PreToolUse Edit in the worktree`);
    const sm = await run('SessionStart', hookJson('SessionStart', sub), sub);
    assert.deepEqual([sm.exit, sm.stdout, sm.stderr], [0, live ? note('SessionStart', 'WT_SUBMODULE') : '', ''], `live=${live} the submodule checkout`);
  }
  assert.equal(d.connections(), 0, 'a .git file is never live: no IPC');
});

/** The 8.3 short spelling of an existing directory (Scripting.FileSystemObject's ShortPath; the path reaches PowerShell through its environment, the
 *  answer comes back as UTF-8), or null when the volume gives none (8.3 names off: the long path comes back). */
function shortName(p: string): string | null {
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:COWORK_SHORT_PATH).ShortPath';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, COWORK_SHORT_PATH: p },
  }).trim();
  return out === '' || out.toLowerCase() === p.toLowerCase() ? null : out;
}

test('the edit path decides the repo, and any spelling of a live root is live', async (t) => {
  const a = await liveRepo('loader-paths-a');
  const b = await liveRepo('loader-paths-b');
  mkdirSync(join(b.r.dir, 'src'), { recursive: true });
  writeFileSync(join(b.r.dir, 'src', 'a.ts'), 'x\n');
  const edit = async (cwd: string, filePath: string, tool = 'Edit'): Promise<{ root: string | null; path: string | null; exit: number | null }> => {
    const before = b.d.frames().length;
    const res = await runLoader('PreToolUse', preToolJson(tool, cwd, { filePath }), { dist, cwd, env: b.r.env });
    const hook = b.d.frames().slice(before).find((f) => f.frame['t'] === 'hook')?.frame;
    return { root: (hook?.['h'] as { repo_root?: string } | undefined)?.repo_root ?? null, path: (hook?.['payload'] as { path?: string } | undefined)?.path ?? null, exit: res.exit };
  };
  const t1 = await edit(a.r.dir, join(b.r.dir, 'src', 'a.ts'));
  assert.equal(t1.root, b.r.root, 'cwd in A, file_path in B: the frame reaches the daemon of B');
  assert.equal(a.d.connections(), 0, 'the daemon of A sees no connection');
  const t2 = await edit(b.r.dir, join('src', 'a.ts'));
  assert.equal(t2.path, 'src/a.ts', 'a relative file_path resolves against cwd');

  await t.test('win32: every letter lower-cased, and the 8.3 spelling', { skip: process.platform === 'win32' ? false : 'win32 spellings (this runner is not win32)' }, async (st) => {
    const lower = join(b.r.dir, 'src', 'a.ts').toLowerCase();
    const t3 = await edit(b.r.dir, lower);
    assert.equal(t3.root, b.r.root, 'every letter lower-cased: live, and h.repo_root is the canonical root');
    assert.equal(t3.root, canonRoot(b.r.dir, realRootProbe, 'win32'));
    const short = shortName(b.r.dir);
    if (short === null) {
      st.skip('8.3 names are off on this volume (Scripting.FileSystemObject ShortPath returned the long path)');
      return;
    }
    const t4 = await edit(b.r.dir, join(short, 'src', 'a.ts'));
    assert.equal(t4.root, b.r.root, `the 8.3 spelling ${short} is live`);
    st.diagnostic(`8.3 spelling ran: ${short}`);
  });
  await t.test('darwin: an NFD spelling of the temp root', { skip: process.platform === 'darwin' ? false : 'NFD spellings resolve only on macOS file systems (this runner is not darwin)' }, async () => {
    const nfd = join(b.r.dir, 'src', 'a.ts').normalize('NFD');
    assert.notEqual(nfd, join(b.r.dir, 'src', 'a.ts'), 'the temp root has a decomposable character');
    assert.equal((await edit(b.r.dir, nfd)).root, b.r.root, 'an NFD spelling of the temp root is live');
  });
  const t5 = await edit(b.r.dir, join(b.r.dir, 'src', 'new', 'dir', 'x.ts'), 'Write');
  assert.equal(t5.root, b.r.root, 'a Write whose directories do not exist yet');
  assert.equal(t5.path, 'src/new/dir/x.ts');

  // A cwd with no .git up to the filesystem root: exit 0, nothing printed. The hook input's cwd is a path on a root that holds no .git (on win32 a
  // drive letter with no volume; this PC's %TEMP% lies under a .git, AppData\Local), whatever the hook process's own working directory.
  const noRepoRoot = PLATFORM_ROOTS.find((r) => !existsSync(join(r, '.git')) && (process.platform !== 'win32' || !existsSync(r))) ?? null;
  assert.ok(noRepoRoot !== null, 'a root without .git');
  const outside = join(noRepoRoot, 'cowork-no-repo', 'a');
  assert.equal(findRepo(canonRoot(outside, realRootProbe, process.platform), realRootProbe, process.platform), null, 'the shared walk finds no .git');
  for (const event of ['SessionStart', 'PreToolUse']) {
    const json = event === 'PreToolUse' ? preToolJson('Bash', outside) : hookJson(event, outside);
    const res = await runLoader(event, json, { dist, cwd: b.r.base, env: b.r.env });
    assert.deepEqual([res.exit, res.stdout, res.stderr], [0, '', ''], event);
  }
});
