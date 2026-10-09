// Deletes one two-clone run's remote refs (Plan 2 Task 20; TST-16, ruling R-34; glossary §4; 11-testing §1.2
// REMOTE_DELETE_FORBIDDEN: only this separate cleanup script deletes test refs). Usage:
//
//   npm run real:cleanup -- --remote <url> --run <run_id> [--yes]
//
// It refuses (TEST_TARGET_REFUSED, before listing anything) a remote whose default branch lacks `.cowork-test-repo`,
// lists exactly the refs under refs/cowork-ci/<run_id>/ and refs/heads/ci/<run_id>/ (ls-remote patterns match ref-name
// tails, so every listed name is re-checked against the two prefixes), deletes them only with --yes, each with a
// `--force-with-lease=<ref>:<listed oid>` so a ref that moved since the listing stays, and refuses as a whole any request
// naming another ref (CLEANUP_REFUSED, before any git call). A URL git would read as an option (a leading '-') or one
// holding a line break, and a URL whose userinfo holds a password, are refused (TEST_TARGET_REFUSED{invalid_url |
// password_in_url}) before any git call; every git call gets the URL as given (a login user may be part of it), and
// every printed line has it through sanitizeUrl (no userinfo). Exit 0 listed or all deleted, 1 a refusal or a failed
// deletion, 2 a usage or internal error.
import { join } from 'node:path';
import { sanitizeUrl } from '../../src/daemon/run.js';
import { lsRemotePrefix } from '../../src/git/fetch.js';
import { checkRefName, runNetwork } from '../../src/git/netcall.js';
import { oid12, parseOid } from '../../src/git/oid.js';
import { parsePorcelain } from '../../src/git/push.js';
import type { GitRepo } from '../../src/git/repo.js';
import { makeTempRoot } from '../../test/helpers/tmp.js';
import { checkTestTarget, harnessRunner, isEntry, refuseBadUrl, sanitizeLine, scratchRepo, TwoCloneRefused, type CliIo } from './two-clone.js';

/** testNamespace's run id grammar (glossary §4): nothing that could widen a prefix. */
export const RUN_ID_RE = /^[0-9A-Za-z_-]{1,40}$/;

export const CLEANUP_USAGE = [
  'usage: npm run real:cleanup -- --remote <url> --run <run_id> [--yes]',
  '  Lists the remote refs of one two-clone run (refs/cowork-ci/<run_id>/* and refs/heads/ci/<run_id>/*); --yes deletes them.',
  '  The remote\'s default branch must hold .cowork-test-repo (else TEST_TARGET_REFUSED). No other ref is ever deleted.',
].join('\n');

export interface RunRef { ref: string; oid: string; }
export interface CleanupResult { listed: RunRef[]; deleted: string[]; failed: string[]; }

/** A deletion request naming a ref outside the run's two prefixes (or a bad run id): nothing is deleted. */
export class CleanupRefused extends Error {
  readonly code = 'CLEANUP_REFUSED';
  readonly refs: string[];
  constructor(refs: string[], why: string) {
    super(`CLEANUP_REFUSED ${why}: ${refs.join(', ')}`);
    this.name = 'CleanupRefused';
    this.refs = refs;
  }
}

/** The run's two ref directories: refs/cowork-ci/<run_id>/ and refs/heads/ci/<run_id>/. */
export function runRefPrefixes(runId: string): readonly [string, string] {
  if (!RUN_ID_RE.test(runId)) throw new CleanupRefused([], `invalid run id ${JSON.stringify(runId)}`);
  return [`refs/cowork-ci/${runId}/`, `refs/heads/ci/${runId}/`];
}

/** A valid ref name strictly inside one of the run's two ref directories. */
export function isRunRef(runId: string, ref: string): boolean {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId) || typeof ref !== 'string') return false;
  try {
    checkRefName('isRunRef', ref);
  } catch {
    return false;
  }
  return runRefPrefixes(runId).some((p) => ref.startsWith(p) && ref.length > p.length);
}

const byRef = (a: RunRef, b: RunRef): number => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

/**
 * One push deleting exactly `refs`, each leased on its listed oid: `push --porcelain --no-verify
 * --force-with-lease=<ref>:<oid>… -- <url> :<ref>…` (`url` as given). Any ref outside the run's prefixes, a ref named
 * twice or a bad run id refuses the whole request (CleanupRefused) before any git call; so does a URL starting with '-'
 * (TEST_TARGET_REFUSED).
 */
export async function deleteRunRefs(repo: GitRepo, url: string, runId: string, refs: readonly RunRef[]): Promise<{ deleted: string[]; failed: string[] }> {
  if (!RUN_ID_RE.test(runId)) throw new CleanupRefused(refs.map((r) => r.ref), `invalid run id ${JSON.stringify(runId)}`);
  const outside = refs.filter((r) => !isRunRef(runId, r.ref)).map((r) => r.ref);
  if (outside.length > 0) throw new CleanupRefused(outside, `not a ref of run ${runId}`);
  const names = refs.map((r) => r.ref);
  if (new Set(names).size !== names.length) throw new CleanupRefused(names, 'a ref named twice');
  if (refs.length === 0) return { deleted: [], failed: [] };
  refuseBadUrl(url);
  const argv = ['push', '--porcelain', '--no-verify', ...refs.map((r) => `--force-with-lease=${r.ref}:${parseOid(r.oid)}`), '--', url, ...refs.map((r) => `:${r.ref}`)];
  const res = await runNetwork(repo, argv);
  const st = parsePorcelain(res.stdout, names);
  return { deleted: names.filter((n) => st.get(n) === 'ok'), failed: names.filter((n) => st.get(n) !== 'ok') };
}

async function listRunRefs(repo: GitRepo, url: string, runId: string): Promise<RunRef[]> {
  const out: RunRef[] = [];
  for (const prefix of runRefPrefixes(runId)) {
    const r = await lsRemotePrefix(repo, url, prefix);
    if (!r.ok) throw new TwoCloneRefused('TEST_TARGET_REFUSED', { reason: 'unreachable', remote: sanitizeUrl(url) }, 'check the URL and your credentials, then run again');
    for (const [ref, oid] of r.values) if (isRunRef(runId, ref)) out.push({ ref, oid });
  }
  return out.sort(byRef);
}

/**
 * Lists the run's refs (TEST_TARGET_REFUSED first, as two-clone does) and, with `yes`, deletes them and lists again.
 * `url` reaches git as given; only its form without userinfo is printed.
 */
export async function cleanupRun(opts: { url: string; runId: string; yes: boolean; log: (line: string) => void; env?: Readonly<Record<string, string | undefined>> }): Promise<CleanupResult> {
  const say = (l: string): void => opts.log(sanitizeLine(l));
  const url = opts.url;
  refuseBadUrl(url);
  const shown = sanitizeUrl(url);
  runRefPrefixes(opts.runId);
  const tmp = await makeTempRoot('cleanup');
  try {
    const repo = await scratchRepo(join(tmp.root, 'scratch'), harnessRunner(join(tmp.root, 'empty-hooks'), opts.env));
    await checkTestTarget(repo, url);
    const listed = await listRunRefs(repo, url, opts.runId);
    say(`cleanup: ${listed.length} ref(s) of run ${opts.runId} on ${shown}`);
    for (const r of listed) say(`  ${oid12(parseOid(r.oid))} ${r.ref}`);
    if (!opts.yes || listed.length === 0) {
      if (listed.length > 0) say('cleanup: nothing deleted; run again with --yes to delete these refs');
      return { listed, deleted: [], failed: [] };
    }
    const res = await deleteRunRefs(repo, url, opts.runId, listed);
    // Deleted means gone from the remote now (a later listing), not only reported by the push.
    const still = new Set((await listRunRefs(repo, url, opts.runId)).map((r) => r.ref));
    const deleted = res.deleted.filter((r) => !still.has(r));
    const failed = listed.map((r) => r.ref).filter((r) => !deleted.includes(r));
    say(`cleanup: deleted ${deleted.length} of ${listed.length} ref(s)`);
    for (const r of failed) say(`  not deleted: ${r}`);
    return { listed, deleted, failed };
  } finally {
    await tmp.cleanup().catch(() => undefined);
  }
}

/** Exit 0 listed or all deleted, 1 a refusal or a failed deletion, 2 a usage or internal error. */
export async function cleanupMain(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: CliIo): Promise<number> {
  const p: CliIo = { out: (l) => io.out(sanitizeLine(l)), err: (l) => io.err(sanitizeLine(l)) };
  const usage = (why: string): number => {
    p.err(`cleanup: ${why}`);
    for (const l of CLEANUP_USAGE.split('\n')) p.err(l);
    return 2;
  };
  let url: string | null = null;
  let runId: string | null = null;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--yes') yes = true;
    else if (a === '--remote' || a === '--run') {
      const v = argv[++i];
      if (v === undefined) return usage(`${a} needs a value`);
      if (a === '--remote') url = v;
      else runId = v;
    } else return usage(`unknown argument ${a}`);
  }
  if (url === null || url.trim().length === 0 || runId === null) return usage('--remote and --run are required');
  if (!RUN_ID_RE.test(runId)) return usage(`--run takes one run id (letters, digits, _ and -, at most 40), got ${JSON.stringify(runId)}`);
  try {
    const r = await cleanupRun({ url: url.trim(), runId, yes, log: (l) => p.out(l), env });
    return r.failed.length === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof TwoCloneRefused) {
      p.out(`${e.code} ${JSON.stringify(e.params)}`);
      p.out(`next: ${e.next}`);
      return 1;
    }
    if (e instanceof CleanupRefused) {
      p.out(e.message);
      return 1;
    }
    p.err(`cleanup: internal error ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return 2;
  }
}

if (isEntry(import.meta.url)) {
  const io: CliIo = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };
  cleanupMain(process.argv.slice(2), process.env, io).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => { io.err(sanitizeLine(`cleanup: ${e instanceof Error ? e.message : String(e)}`)); process.exitCode = 2; },
  );
}
