// Peer clones for the SIM harness (11-testing §3.3 setup steps 2 and 3):
// seed the remote's main branch, clone N peers with a Windows (autocrlf=true)
// or POSIX (autocrlf=false) profile, and optionally install the counting
// clean/smudge secret filter `secret` (11-testing §3.7 "secret filter"), which
// replaces exactly this run's canary `COWORK_CANARY_<run>` with a placeholder.
import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { GitCallOptions } from '../../src/git/flags.js';
import type { GitRunner } from '../../src/git/runner.js';
import { retryGit } from '../helpers/retryGit.js';
import type { BareRemote } from './remote.js';

const PLACEHOLDER = '@@SECRET@@';
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const SEED_IDENTITY = { name: 'Cowork Seed', email: 'seed@cowork.invalid' };
const SEED_WALL_MS = 1_700_000_000_000; // fixed commit date: same files -> same seed oid on every OS

/** The per-run canary (11-testing §2, §3.7). The run id must be a plain token. */
export function canary(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`canary: bad run id ${JSON.stringify(runId)}`);
  return `COWORK_CANARY_${runId}`;
}

/**
 * clonePeer's signature carries no run id, so one temp root = one run:
 * the run id is the first 12 hex chars of sha256(resolved root). Every peer
 * under the same root shares the canary; another root gets another one.
 */
function runIdForRoot(root: string): string {
  return createHash('sha256').update(resolve(root), 'utf8').digest('hex').slice(0, 12);
}

export interface PeerOptions { name: string; autocrlf: boolean; withFilter: boolean; }
export interface PeerClone { name: string; dir: string; filterCountFile: string; opts: PeerOptions; canary: string; }

/** Single-quote for the sh command line git uses for filter drivers; forward slashes work on every OS. */
function shq(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
}

async function must(git: GitRunner, args: string[], cwd: string, extra: Partial<GitCallOptions> = {}): Promise<string> {
  const r = await git.run(args, { class: 'local', cwd, ...extra });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8');
}

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null)) !== null;
}

/**
 * The filter driver script for one peer, with that peer's canary embedded: byte-preserving
 * replace of exactly the canary string (both values are ASCII, so the latin1 round trip is
 * exact), one count line per invocation. LF only.
 */
function filterJs(secret: string): string {
  return [
    "const fs = require('fs');",
    'const [mode, countFile, path] = process.argv.slice(2);',
    `const SECRET = ${JSON.stringify(secret)};`,
    `const PLACEHOLDER = ${JSON.stringify(PLACEHOLDER)};`,
    "const text = fs.readFileSync(0).toString('latin1');",
    "const out = mode === 'clean' ? text.split(SECRET).join(PLACEHOLDER) : text.split(PLACEHOLDER).join(SECRET);",
    "fs.appendFileSync(countFile, mode + ' ' + (path || '') + '\\n');",
    "process.stdout.write(Buffer.from(out, 'latin1'));",
    '',
  ].join('\n');
}

/**
 * Commits exactly `files` (POSIX relative paths -> bytes) as one commit and pushes
 * it to refs/heads/main. core.autocrlf is forced off in the seed repo, so the stored
 * bytes are exactly the given bytes (Git for Windows' system config defaults it on).
 */
export async function seedRemote(remote: BareRemote, root: string, git: GitRunner, files: Record<string, Buffer>): Promise<string> {
  const dir = join(root, 'seed');
  if (await exists(dir)) throw new Error(`seedRemote: ${dir} already exists`);
  await must(git, ['init', '-q', '-b', 'main', dir], root);
  await must(git, ['config', 'core.autocrlf', 'false'], dir);
  for (const rel of Object.keys(files).sort()) {
    const abs = join(dir, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, files[rel]!);
  }
  await must(git, ['add', '-A'], dir);
  await must(git, ['commit', '-q', '--allow-empty', '-m', 'seed'], dir, { identity: SEED_IDENTITY, wallMsForDates: SEED_WALL_MS });
  const oid = (await must(git, ['rev-parse', 'HEAD'], dir)).trim();
  // Retried while the remote's main is still what it was before the push (nothing landed).
  const before = (await remote.refs())['refs/heads/main'];
  await retryGit(() => git.run(['push', '-q', remote.url, 'HEAD:refs/heads/main'], { class: 'network', cwd: dir }), {
    attempts: 3,
    label: `seedRemote: git push ${remote.url} HEAD:refs/heads/main`,
    nothingLanded: async () => (await remote.refs())['refs/heads/main'] === before,
  });
  // The seed push is the first push of every run: if the post-receive hook did not log it, the
  // fixture hooks are not running and every oracle reading the remote log would pass vacuously.
  if (!(await remote.readRemoteLog()).some((e) => e.ref === 'refs/heads/main' && e.new === oid)) {
    throw new Error(`seedRemote: the bare remote's hooks are not running (the seed push to ${remote.dir} is not in remote-log.jsonl)`);
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return oid;
}

export async function clonePeer(remote: BareRemote, root: string, opts: PeerOptions, git: GitRunner): Promise<PeerClone> {
  if (!/^[A-Za-z0-9_-]+$/.test(opts.name)) throw new Error(`clonePeer: bad peer name ${JSON.stringify(opts.name)}`);
  const dir = join(root, opts.name);
  if (await exists(dir)) throw new Error(`clonePeer: ${dir} already exists`);
  const peerCanary = canary(runIdForRoot(root));
  const cloneArgs = ['clone', '-q', '--no-checkout', '-c', `core.autocrlf=${opts.autocrlf ? 'true' : 'false'}`, remote.url, dir];
  // A clone writes nothing to the remote. A failed attempt may leave a partial directory, so every attempt starts without one.
  await retryGit(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return git.run(cloneArgs, { class: 'network', cwd: root });
  }, { attempts: 3, label: `clonePeer: git clone into ${dir}` });

  const gitDir = join(dir, '.git');
  const filterCountFile = join(gitDir, 'cowork-filter-count.log');
  if (opts.withFilter) {
    const script = join(gitDir, 'cowork-secret-filter.js');
    const buf = Buffer.from(filterJs(peerCanary), 'utf8');
    if (buf.includes(0x0d)) throw new Error('filter script contains CR');
    await writeFile(script, buf);
    await must(git, ['config', 'filter.secret.clean', `node ${shq(script)} clean ${shq(filterCountFile)} %f`], dir);
    await must(git, ['config', 'filter.secret.smudge', `node ${shq(script)} smudge ${shq(filterCountFile)} %f`], dir);
  }
  // Populate the work tree only now, so the smudge filter (if any) runs on checkout.
  await must(git, ['checkout', '-q', 'main'], dir, opts.withFilter ? { filterDrivers: ['secret'] } : {});
  return { name: opts.name, dir, filterCountFile, opts: { ...opts }, canary: peerCanary };
}
