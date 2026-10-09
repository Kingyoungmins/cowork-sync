// Bare-remote fixture with server-side hooks (11-testing §3.3 setup step 1).
// Hooks are LF-only node scripts behind a two-line sh shim, so they run with
// Git for Windows' sh as well as on macOS/Linux (Review Focus 3).
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GitRunner } from '../../src/git/runner.js';

export type RejectKind = 'transient-failed' | 'commit_refs' | 'policy';
export interface RemoteLogEntry { ref: string; old: string; new: string; }
export interface RefTxEntry { state: string; old: string; new: string; ref: string; }
export interface BareRemote {
  dir: string;
  url: string;
  rejectNext(n: number, kind: RejectKind, refSubstring?: string): Promise<void>;
  clearRejects(): Promise<void>;
  readRemoteLog(): Promise<RemoteLogEntry[]>;
  readRefTxLog(): Promise<RefTxEntry[]>;
  refs(): Promise<Record<string, string>>;
}

const SHIM = '#!/bin/sh\nexec node "$0.js" "$@"\n';

function readStdinJs(): string {
  return [
    "const fs = require('fs');",
    'function stdinLines() {',
    "  const text = fs.readFileSync(0, 'utf8');",
    "  return text.split('\\n').filter((l) => l.length > 0).map((l) => {",
    "    const [oldOid, newOid, ref] = l.split(' ');",
    '    return { old: oldOid, new: newOid, ref };',
    '  });',
    '}',
  ].join('\n');
}

function preReceiveJs(controlFile: string): string {
  return [
    readStdinJs(),
    `const control = ${JSON.stringify(controlFile)};`,
    'const updates = stdinLines();',
    'let c = null;',
    "try { c = JSON.parse(fs.readFileSync(control, 'utf8')); } catch { c = null; }",
    'if (c && c.count > 0 && updates.some((u) => u.ref.includes(c.refSubstring))) {',
    '  c.count -= 1;',
    "  fs.writeFileSync(control + '.tmp', JSON.stringify(c));",
    "  fs.renameSync(control + '.tmp', control);",
    "  if (c.kind === 'policy') process.stderr.write('policy: blocked\\n');",
    "  if (c.kind === 'commit_refs') process.stderr.write('fatal error in commit_refs\\n');",
    '  process.exit(1);',
    '}',
    'process.exit(0);',
    '',
  ].join('\n');
}

function postReceiveJs(logFile: string): string {
  return [
    readStdinJs(),
    `const log = ${JSON.stringify(logFile)};`,
    'const lines = stdinLines().map((u) => JSON.stringify({ ref: u.ref, old: u.old, new: u.new }) + "\\n").join("");',
    'if (lines.length > 0) fs.appendFileSync(log, lines);',
    '',
  ].join('\n');
}

function refTxJs(logFile: string): string {
  return [
    readStdinJs(),
    `const log = ${JSON.stringify(logFile)};`,
    'const state = process.argv[2];',
    'const updates = stdinLines();',
    "if (state === 'committed') {",
    '  const lines = updates.map((u) => JSON.stringify({ state, old: u.old, new: u.new, ref: u.ref }) + "\\n").join("");',
    '  if (lines.length > 0) fs.appendFileSync(log, lines);',
    '}',
    '',
  ].join('\n');
}

async function writeLf(path: string, text: string, mode: number): Promise<void> {
  // Built from LF-only literals; assert so a CRLF can never sneak in (Review Focus 3).
  const buf = Buffer.from(text, 'utf8');
  if (buf.includes(0x0d)) throw new Error(`hook ${path} contains CR`);
  await writeFile(path, buf, { mode });
}

async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as T);
}

const ASCII = /^[\x20-\x7e]*$/;

/**
 * Where the bare repository really lives. Normally `<root>/remote.git`. On macOS, git's
 * receive-pack ignores the repository's own config (our `core.hooksPath` pin) when a push names a
 * repository path containing non-ASCII characters, so a user-global `core.hooksPath` silently turns
 * the fixture hooks off (measured on macos-latest, git 2.55: CI run 37404426420 and the hooksPath
 * matrix diagnostic; ASCII paths honour the pin). There the repository is created at an ASCII path
 * and `<root>/remote.git` is a symlink to it, so the layout stays the same.
 */
function bareRepoHome(root: string): string {
  const inRoot = join(root, 'remote.git');
  if (process.platform !== 'darwin' || ASCII.test(inRoot)) return inRoot;
  const parent = ASCII.test(dirname(root)) ? dirname(root) : realpathSync.native(tmpdir());
  return join(parent, `remote-${createHash('sha256').update(root).digest('hex').slice(0, 12)}.git`);
}

export async function createBareRemote(root: string, git: GitRunner, defaultBranch = 'main'): Promise<BareRemote> {
  const layoutDir = join(root, 'remote.git');
  if (await lstat(layoutDir).catch(() => null)) throw new Error(`createBareRemote: ${layoutDir} already exists`);
  const dir = bareRepoHome(root);
  if (dir !== layoutDir && (await lstat(dir).catch(() => null))) throw new Error(`createBareRemote: ${dir} already exists`);
  const controlFile = join(root, 'remote-control.json');
  const remoteLog = join(root, 'remote-log.jsonl');
  const refTxLog = join(root, 'reftx-log.jsonl');

  const init = await git.run(['init', '-q', '--bare', '-b', defaultBranch, dir], { class: 'local', cwd: root });
  if (init.code !== 0) throw new Error(`git init --bare failed: ${init.stderr.toString('utf8')}`);

  const hooks = join(dir, 'hooks');
  await rm(hooks, { recursive: true, force: true }); // drop git's *.sample files
  await mkdir(hooks, { recursive: true });
  for (const [name, js] of [
    ['pre-receive', preReceiveJs(controlFile)],
    ['post-receive', postReceiveJs(remoteLog)],
    ['reference-transaction', refTxJs(refTxLog)],
  ] as const) {
    await writeLf(join(hooks, name), SHIM, 0o755);
    await writeLf(join(hooks, `${name}.js`), js, 0o644);
  }
  // Pin the hooks directory in the remote's own config so a user-global
  // core.hooksPath cannot redirect the server side away from the fixture hooks.
  const pin = await git.run(['config', 'core.hooksPath', hooks.replace(/\\/g, '/')], { class: 'local', cwd: dir });
  if (pin.code !== 0) throw new Error(`git config core.hooksPath failed: ${pin.stderr.toString('utf8')}`);
  if (dir !== layoutDir) await symlink(dir, layoutDir, 'dir');

  const url = pathToFileURL(dir).href;

  return {
    dir,
    url,
    async rejectNext(n, kind, refSubstring = '') {
      const tmp = `${controlFile}.tmp`;
      await writeFile(tmp, Buffer.from(JSON.stringify({ count: n, kind, refSubstring }), 'utf8'));
      await rename(tmp, controlFile);
    },
    async clearRejects() {
      await rm(controlFile, { force: true });
    },
    readRemoteLog: () => readJsonl<RemoteLogEntry>(remoteLog),
    readRefTxLog: () => readJsonl<RefTxEntry>(refTxLog),
    async refs() {
      const r = await git.run(['for-each-ref', '--format=%(refname) %(objectname)'], { class: 'local', cwd: dir });
      if (r.code !== 0) throw new Error(`for-each-ref failed: ${r.stderr.toString('utf8')}`);
      const out: Record<string, string> = {};
      const pairs = r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => {
        const sp = l.lastIndexOf(' ');
        return [l.slice(0, sp), l.slice(sp + 1)] as const;
      });
      pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [ref, oid] of pairs) out[ref] = oid;
      return out;
    },
  };
}
