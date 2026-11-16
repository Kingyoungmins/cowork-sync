// Plan 5 Task 4: the static policy read and the install and refusal checks (R1-104, R1-111, R2-B12, R5-49; 06 §1.2, §3.2, §3.11.6 item 3; 09 §3.14 item 2,
// SEC-28, SEC-29; CCI-04, CCI-35 (3) client read) over a fake Fs (an in-memory file map behind FaultFs, which records every call) holding the files
// of test/fixtures/settings/ at the documented locations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInstallScope, checkSecondCheckout, checkWorktreeShape, hostFloorRefusal, staticPolicyCheck } from '../../src/claude/client/policy.js';
import type { PolicyHit } from '../../src/claude/wire/frames.js';
import type { Fs } from '../../src/ports/fs.js';
import { FaultFs } from '../sim/faultfs.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/settings/', import.meta.url));
const fixture = (rel: string): Buffer => readFileSync(join(FIXTURES, ...rel.split('/')));
/** A path key: either separator, compared as '/'. */
const key = (p: string): string => p.replace(/\\/g, '/');

/** An in-memory Fs over `files` (readFile, readdir, stat); every other call throws (the code under test makes none). */
function memFs(files: Record<string, Buffer>): Fs {
  const map = new Map(Object.entries(files).map(([p, b]) => [key(p), b]));
  const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT', errno: -2, syscall: 'open', path: p });
  const children = (p: string): string[] => {
    const prefix = `${key(p).replace(/\/$/, '')}/`;
    return [...new Set([...map.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0] as string))].sort();
  };
  const no = (op: string) => async (): Promise<never> => { throw new Error(`memFs: ${op} is not expected`); };
  return {
    readFile: async (p) => { const b = map.get(key(p)); if (b === undefined) throw enoent(p); return Buffer.from(b); },
    readdir: async (p) => { const c = children(p); if (c.length === 0) throw enoent(p); return c; },
    stat: async (p) => (map.has(key(p)) ? { size: map.get(key(p))!.length, mtimeMs: 0, isFile: true, isDirectory: false } : children(p).length > 0 ? { size: 0, mtimeMs: 0, isFile: false, isDirectory: true } : null),
    writeFile: no('writeFile'), rename: no('rename'), link: no('link'), unlink: no('unlink'), mkdirp: no('mkdirp'), rmrf: no('rmrf'), lstat: no('lstat'),
    writeFileExclusive: no('writeFileExclusive'), rmdir: no('rmdir'), appendFile: no('appendFile'), realpath: no('realpath'), freeBytes: no('freeBytes'), chmod: no('chmod'),
  };
}

const MANAGED: Record<string, string> = {
  linux: '/etc/claude-code', win32: 'C:\\Program Files\\ClaudeCode', darwin: '/Library/Application Support/ClaudeCode',
};

/** The fixture tree served at the platform's managed location, <home>/.claude and <repo>/.claude. */
function policyFiles(platform: 'linux' | 'win32' | 'darwin', home: string, repo: string): Record<string, Buffer> {
  const P = platform === 'win32' ? win32 : posix;
  const out: Record<string, Buffer> = {
    [P.join(MANAGED[platform]!, 'managed-settings.json')]: fixture('managed/managed-settings.json'),
    [P.join(home, '.claude', 'settings.json')]: fixture('user/settings.json'),
    [P.join(repo, '.claude', 'settings.json')]: fixture('project/settings.json'),
    [P.join(repo, '.claude', 'settings.local.json')]: fixture('project/settings.local.json'),
    // Not a documented location: never read.
    [P.join(repo, '.claude', 'managed-settings.json')]: Buffer.from('{"disableAllHooks": true}'),
  };
  for (const name of readdirSync(join(FIXTURES, 'managed', 'managed-settings.d'))) {
    if (statSync(join(FIXTURES, 'managed', 'managed-settings.d', name)).isFile()) {
      out[P.join(MANAGED[platform]!, 'managed-settings.d', name)] = fixture(`managed/managed-settings.d/${name}`);
    }
  }
  return out;
}

test('staticPolicyCheck reports each hit by setting name and file from the documented locations only', async () => {
  const home = '/home/me';
  const repo = '/repo';
  const fs = new FaultFs(memFs(policyFiles('linux', home, repo)));
  const hits = await staticPolicyCheck(repo, { fs, platform: 'linux', home, env: {} });
  const d = '/etc/claude-code/managed-settings.d';
  const want: PolicyHit[] = [
    { setting: 'disableAllHooks', file: '/etc/claude-code/managed-settings.json', scope: 'managed', value: 'true' },
    { setting: 'allowManagedHooksOnly', file: `${d}/10-x.json`, scope: 'managed', value: 'true' },
    { setting: 'strictKnownMarketplaces', file: `${d}/20-strict.json`, scope: 'managed', value: 'set' },
    { setting: 'statusLine', file: `${d}/30-statusline.json`, scope: 'managed', value: 'set' },
    { setting: 'enabledPlugins', file: '/home/me/.claude/settings.json', scope: 'user', value: 'false' },
    { setting: 'crossSessionInbound', file: '/repo/.claude/settings.json', scope: 'project', value: 'refuse' },
    { setting: 'deniedMcpServers', file: '/repo/.claude/settings.local.json', scope: 'local', value: 'set' },
  ];
  assert.deepEqual(hits, want, 'the unparseable 40-unparseable.json gives no hit and no throw; a user statusLine is no hit');
  const allowed = new Set(['/etc/claude-code/managed-settings.json', d, '/home/me/.claude/settings.json', '/repo/.claude/settings.json', '/repo/.claude/settings.local.json']);
  for (const c of fs.calls) {
    const p = key(c.slice(c.indexOf(' ') + 1));
    assert.ok(allowed.has(p) || key(p).startsWith(`${d}/`), `a read outside the documented locations: ${c}`);
  }

  for (const platform of ['win32', 'darwin'] as const) {
    const h = platform === 'win32' ? 'C:\\Users\\me' : '/Users/me';
    const r = platform === 'win32' ? 'C:\\repo' : '/repo';
    const pfs = new FaultFs(memFs(policyFiles(platform, h, r)));
    const ph = await staticPolicyCheck(r, { fs: pfs, platform, home: h, env: {} });
    const P = platform === 'win32' ? win32 : posix;
    assert.equal(ph[0]?.file, P.join(MANAGED[platform]!, 'managed-settings.json'), platform);
    assert.equal(ph.length, want.length, platform);
    assert.ok(pfs.calls.some((c) => c === `readFile ${P.join(MANAGED[platform]!, 'managed-settings.json')}`), `${platform} reads its own managed file`);
  }
  // Nothing anywhere: no hit.
  assert.deepEqual(await staticPolicyCheck(repo, { fs: memFs({}), platform: 'linux', home, env: {} }), []);
});

test('checkInstallScope, hostFloorRefusal, checkSecondCheckout and checkWorktreeShape return the 06 §1.2 codes', async () => {
  const home = join('/', 'home', 'me');
  const repo = join('/', 'repo');
  const enabled = fixture('scope/enabled.json');
  const at = (scope: 'user' | 'project' | 'local'): string =>
    (scope === 'user' ? join(home, '.claude', 'settings.json') : join(repo, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json'));
  assert.equal(await checkInstallScope(repo, { fs: memFs({ [at('project')]: enabled }), home, env: {}, platform: process.platform }), 'REFUSE_PROJECT_SCOPE');
  assert.equal(await checkInstallScope(repo, { fs: memFs({ [at('local')]: enabled }), home, env: {}, platform: process.platform }), 'REFUSE_PROJECT_SCOPE');
  assert.equal(await checkInstallScope(repo, { fs: memFs({ [at('user')]: enabled }), home, env: {}, platform: process.platform }), 'ok');
  assert.equal(await checkInstallScope(repo, { fs: memFs({ [at('user')]: enabled, [at('project')]: enabled }), home, env: {}, platform: process.platform }), 'ok');

  assert.deepEqual(hostFloorRefusal({ ccVersion: '2.1.269', nodeMajor: 22, fromTerminal: true }), { code: 'REFUSE_CC_VERSION', params: { have: '2.1.269', need: '2.1.270' } });
  assert.equal(hostFloorRefusal({ ccVersion: '2.1.270', nodeMajor: 22, fromTerminal: true }), null);
  assert.equal(hostFloorRefusal({ ccVersion: '2.2.0', nodeMajor: 22, fromTerminal: false }), null);
  assert.equal(hostFloorRefusal({ ccVersion: null, nodeMajor: 22, fromTerminal: false }), null);
  assert.deepEqual(hostFloorRefusal({ ccVersion: '2.1.270', nodeMajor: 18, fromTerminal: true }), { code: 'REFUSE_NODE_VERSION', params: { have: 18, need: 20 } });

  const r1 = join('/', 'r1', '.git');
  const files = (o: { marker?: boolean; head?: string } = {}): Record<string, Buffer> => ({
    [join('/', 'data', 'repos.json')]: Buffer.from(JSON.stringify(['/r1/.git'])),
    [join(r1, 'HEAD')]: Buffer.from(o.head ?? 'ref: refs/heads/main\n'),
    ...(o.marker === false ? {} : { [join(r1, 'cowork', 'live')]: Buffer.from('/r1\n') }),
  });
  const same = async (): Promise<string | null> => 'abc';
  const d = (f: Record<string, Buffer>, repoIdentity: (g: string) => Promise<string | null> = same) => ({ fs: memFs(f), dataDir: join('/', 'data'), repoIdentity });
  assert.deepEqual(await checkSecondCheckout('/r2', 'main', d(files())), { code: 'REFUSE_SECOND_CHECKOUT', params: { first: '/r1' } });
  assert.equal(await checkSecondCheckout('/r2', 'dev', d(files())), null, 'another branch');
  assert.equal(await checkSecondCheckout('/r2', 'main', d(files({ marker: false }))), null, 'the listed checkout is not live');
  assert.equal(await checkSecondCheckout('/r2', 'main', d(files(), async () => null)), null, 'no identity');
  assert.equal(await checkSecondCheckout('/r2', 'main', d(files(), async (g) => (key(g).startsWith('/r1') ? 'abc' : 'xyz'))), null, 'another repo');
  assert.equal(await checkSecondCheckout('/r1', 'main', d(files())), null, 'the same checkout');
  assert.equal(await checkSecondCheckout('/r2', 'main', d({})), null, 'no repos.json');

  assert.equal(checkWorktreeShape({ kind: 'file', root: '/r', commonGitdir: '/m/.git', submodule: false }), 'REFUSE_WORKTREE');
  assert.equal(checkWorktreeShape({ kind: 'file', root: '/r', commonGitdir: null, submodule: true }), 'REFUSE_WORKTREE');
  assert.equal(checkWorktreeShape({ kind: 'dir', root: '/r', gitdir: '/r/.git' }), 'ok');
});

test('the user settings layer is the Claude config directory\'s: CLAUDE_CONFIG_DIR when set and absolute, else <home>/.claude (P5-T4-3)', async () => {
  // staticPolicyCheck: the user-scope hits come from <CLAUDE_CONFIG_DIR>/settings.json, and <home>/.claude/settings.json is not read.
  const home = '/home/me';
  const repo = '/repo';
  const files = { ...policyFiles('linux', home, repo), '/cfg/settings.json': Buffer.from('{"disableAllHooks": true, "enabledPlugins": {"cowork-sync@test-market": false}}') };
  const fs = new FaultFs(memFs(files));
  const hits = await staticPolicyCheck(repo, { fs, platform: 'linux', home, env: { CLAUDE_CONFIG_DIR: '/cfg' } });
  assert.deepEqual(hits.filter((h) => h.scope === 'user'), [
    { setting: 'disableAllHooks', file: '/cfg/settings.json', scope: 'user', value: 'true' },
    { setting: 'enabledPlugins', file: '/cfg/settings.json', scope: 'user', value: 'false' },
  ]);
  assert.ok(!fs.calls.some((c) => key(c).endsWith('/home/me/.claude/settings.json')), 'the home settings are not the user layer when the variable is set');
  // A relative value is ignored: <home>/.claude/settings.json is the user layer again.
  const rel = await staticPolicyCheck(repo, { fs: memFs(files), platform: 'linux', home, env: { CLAUDE_CONFIG_DIR: 'cfg' } });
  assert.deepEqual(rel.filter((h) => h.scope === 'user').map((h) => h.file), ['/home/me/.claude/settings.json']);
  // win32: the variable name in any case, a drive path.
  const winFiles = { ...policyFiles('win32', 'C:\\Users\\me', 'C:\\repo'), 'D:\\cfg\\settings.json': Buffer.from('{"disableAllHooks": true}') };
  const win = await staticPolicyCheck('C:\\repo', { fs: memFs(winFiles), platform: 'win32', home: 'C:\\Users\\me', env: { claude_config_dir: 'D:\\cfg' } });
  assert.deepEqual(win.filter((h) => h.scope === 'user').map((h) => h.file), ['D:\\cfg\\settings.json']);

  // checkInstallScope: cowork-sync enabled in <CLAUDE_CONFIG_DIR>/settings.json is user scope ('ok'), even beside a project enable; enabled only in
  // <home>/.claude/settings.json while the variable is set, that file is not the user layer.
  const P = process.platform === 'win32' ? win32 : posix;
  const h = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me';
  const r = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const cfg = process.platform === 'win32' ? 'D:\\cfg' : '/cfg';
  const enabled = fixture('scope/enabled.json');
  const scope = (f: Record<string, Buffer>, env: Record<string, string>) => checkInstallScope(r, { fs: memFs(f), home: h, env, platform: process.platform });
  assert.equal(await scope({ [P.join(cfg, 'settings.json')]: enabled, [P.join(r, '.claude', 'settings.json')]: enabled }, { CLAUDE_CONFIG_DIR: cfg }), 'ok');
  assert.equal(await scope({ [P.join(h, '.claude', 'settings.json')]: enabled, [P.join(r, '.claude', 'settings.json')]: enabled }, { CLAUDE_CONFIG_DIR: cfg }),
    'REFUSE_PROJECT_SCOPE', 'the home settings are not the user layer when the variable is set');
  assert.equal(await scope({ [P.join(h, '.claude', 'settings.json')]: enabled, [P.join(r, '.claude', 'settings.json')]: enabled }, { CLAUDE_CONFIG_DIR: 'cfg' }),
    'ok', 'a relative value is ignored');
});
