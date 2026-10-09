// Harness self-test engine. Each step appends "<peer>:<step>" to notes.txt on top of the freshly
// fetched refs/cowork/main/code (or main before the first publish), commits it with plumbing
// (no worktree, so autocrlf peers produce the same blobs), reaches the yield point
// 'naive.beforePush' (where a SIM test may interleave another peer, 11-testing §3.3 Run 2) and
// pushes it with a lease.
// A rejected leased push is retried within the same step. The engine re-fetches and compares the
// remote tip with its lease: an unchanged tip means nothing landed (a transient rejection), so the
// same push is retried up to TRANSIENT_RETRIES more times; a moved tip means the lease was lost, so
// the commit is rebuilt once on the new tip and pushed again. Every retry first awaits the yield
// point 'naive.retry'. The retry path draws no randomness, so without a rejection the op-log is
// exactly that of a single push.
// forcePush: true is the mutant: it never re-fetches after its first step, builds on its own stale
// view and pushes a "+" refspec once, without retries, so a teammate's commit is overwritten and
// INV-FF must fail.
import type { GitCallOptions, GitClass } from '../../src/git/flags.js';
import { retryGit } from '../helpers/retryGit.js';
import type { EngineFactory, SimContext, SimEngine } from './harness.js';
import type { PeerClone } from './peers.js';

const CODE_REF = 'refs/cowork/main/code';
const VIEW_CODE = 'refs/cowork-remote/main/code';
const VIEW_BRANCH = 'refs/cowork-remote/main/branch';
const NOTES = 'notes.txt';
/** Extra attempts of the same leased push while the remote tip still equals the lease. */
const TRANSIENT_RETRIES = 2;

class GitStepError extends Error {}

async function git(
  ctx: SimContext, peer: PeerClone, cls: GitClass, args: string[], extra: Partial<GitCallOptions> = {},
): Promise<{ code: number; out: Buffer; err: Buffer }> {
  const r = await ctx.git.run(args, { class: cls, cwd: peer.dir, ...extra });
  return { code: r.code, out: r.stdout, err: r.stderr };
}

/** Exit code plus git's own output for a failed push, on one line, with run-specific paths masked so op-logs stay comparable. */
function pushFailure(ctx: SimContext, r: { code: number; out: Buffer; err: Buffer }): string {
  let text = `${r.out.toString('utf8')} ${r.err.toString('utf8')}`.replace(/\s+/g, ' ').trim();
  const slash = (p: string): string => p.split('\\').join('/');
  for (const [s, mask] of [[ctx.remote.url, '<remote>'], [ctx.remote.dir, '<remote>'], [slash(ctx.remote.dir), '<remote>'], [ctx.root, '<root>'], [slash(ctx.root), '<root>']] as const) {
    text = text.split(s).join(mask);
  }
  return `code=${r.code} ${text}`;
}

async function gitOk(
  ctx: SimContext, peer: PeerClone, cls: GitClass, args: string[], extra: Partial<GitCallOptions> = {},
): Promise<string> {
  const r = await ctx.git.run(args, { class: cls, cwd: peer.dir, ...extra });
  if (r.code !== 0) throw new GitStepError(`${peer.name}: git ${args[0]} exited ${r.code}: ${r.stderr.toString('utf8').trim()}`);
  return r.stdout.toString('utf8').trim();
}

/** Resolves a local ref to an oid, or null when it does not exist. */
async function resolve(ctx: SimContext, peer: PeerClone, ref: string): Promise<string | null> {
  const r = await git(ctx, peer, 'local', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.out.toString('utf8').trim() : null;
}

/**
 * The glob refspec also works before the first publish, when refs/cowork/main/code does not exist
 * yet. A fetch writes nothing to the remote, so retryGit may simply run it again.
 */
async function fetchViews(ctx: SimContext, peer: PeerClone): Promise<void> {
  const args = ['fetch', '--no-tags', ctx.remote.url, `+refs/heads/main:${VIEW_BRANCH}`, '+refs/cowork/*:refs/cowork-remote/*'];
  await retryGit(() => ctx.git.run(args, { class: 'network', cwd: peer.dir }), { attempts: 3, label: `${peer.name}: git fetch` });
}

/** Tree of `base` with notes.txt replaced by `blob`. */
async function treeWithNotes(ctx: SimContext, peer: PeerClone, base: string, blob: string): Promise<string> {
  const listing = await git(ctx, peer, 'local', ['ls-tree', '-z', base]);
  if (listing.code !== 0) throw new GitStepError(`${peer.name}: ls-tree ${base} failed`);
  const entries = listing.out.toString('utf8').split('\0').filter((e) => e !== '' && !e.endsWith(`\t${NOTES}`));
  entries.push(`100644 blob ${blob}\t${NOTES}`);
  return gitOk(ctx, peer, 'local', ['mktree', '-z'], { stdin: Buffer.from(entries.join('\0') + '\0', 'utf8') });
}

function currentStep(ctx: SimContext): number {
  const last = ctx.opLog[ctx.opLog.length - 1];
  if (last === undefined) throw new Error('naiveEngine: step() called before the harness logged the step');
  return last.step;
}

class NaiveEngine implements SimEngine {
  constructor(readonly peer: PeerClone, private readonly forcePush: boolean) {}

  async step(ctx: SimContext): Promise<void> {
    const peer = this.peer;
    const step = currentStep(ctx);
    const clock = ctx.clocks.get(peer.name);
    if (clock === undefined) throw new Error(`naiveEngine: no clock for ${peer.name}`);
    if (!this.forcePush || (await resolve(ctx, peer, VIEW_BRANCH)) === null) await fetchViews(ctx, peer);

    // Identity and date are always explicit: the date is this peer's virtual wall clock, never real
    // time. Peer clocks move only between steps, so a rebuilt commit gets the same date.
    const wall = clock.wallMs();
    const who: Partial<GitCallOptions> = { identity: { name: peer.name, email: `${peer.name}@cowork.invalid` }, wallMsForDates: wall };
    let leased = await resolve(ctx, peer, VIEW_CODE);
    let commit = await this.commitOn(ctx, step, leased, wall, who);

    await ctx.scheduler.yieldPoint('naive.beforePush');

    if (this.forcePush) {
      await this.pushOnce(ctx, step, commit, [ctx.remote.url, `+${commit}:${CODE_REF}`], who);
      return;
    }
    let transientLeft = TRANSIENT_RETRIES;
    let rebuilt = false;
    for (;;) {
      const lease = `--force-with-lease=${CODE_REF}:${leased ?? ''}`;
      if (await this.pushOnce(ctx, step, commit, [lease, ctx.remote.url, `${commit}:${CODE_REF}`], who)) return;
      await fetchViews(ctx, peer);
      const tip = await resolve(ctx, peer, VIEW_CODE);
      if (tip === leased) {
        // Nothing landed: retry the same push. A push that landed despite a non-zero exit shows up
        // as a moved tip instead, and the rebuilt commit stacks on it as a fast-forward.
        if (transientLeft === 0) return;
        transientLeft--;
      } else {
        // Lease lost: a teammate published first. Rebuild once on the new tip.
        if (rebuilt) return;
        rebuilt = true;
        leased = tip;
        commit = await this.commitOn(ctx, step, leased, wall, who);
      }
      await ctx.scheduler.yieldPoint('naive.retry');
    }
  }

  /** Commits notes.txt + "<peer>:<step>" on top of `leased` (or main before the first publish) and logs `commit <oid> wall=<ms>`. */
  private async commitOn(ctx: SimContext, step: number, leased: string | null, wall: number, who: Partial<GitCallOptions>): Promise<string> {
    const peer = this.peer;
    const base = leased ?? (await resolve(ctx, peer, VIEW_BRANCH));
    if (base === null) throw new GitStepError(`${peer.name}: no base commit after fetch`);
    const old = await git(ctx, peer, 'local', ['cat-file', 'blob', `${base}:${NOTES}`]);
    const content = Buffer.concat([old.code === 0 ? old.out : Buffer.alloc(0), Buffer.from(`${peer.name}:${step}\n`, 'utf8')]);
    const blob = await gitOk(ctx, peer, 'local', ['hash-object', '-w', '--no-filters', '--stdin'], { stdin: content });
    const tree = await treeWithNotes(ctx, peer, base, blob);
    const commit = await gitOk(ctx, peer, 'refupdate', ['commit-tree', tree, '-p', base, '-m', `naive ${peer.name}:${step}`], who);
    ctx.opLog.push({ step, peer: peer.name, kind: 'commit', detail: `${commit} wall=${wall}` });
    return commit;
  }

  /** One push attempt, logged as `ok <oid>` or `rejected <oid> code=<n> <git output>`; true when it landed. */
  private async pushOnce(ctx: SimContext, step: number, commit: string, args: string[], who: Partial<GitCallOptions>): Promise<boolean> {
    const pushed = await git(ctx, this.peer, 'network', ['push', '--porcelain', ...args]);
    if (pushed.code === 0) await gitOk(ctx, this.peer, 'refupdate', ['update-ref', VIEW_CODE, commit], who);
    ctx.opLog.push({ step, peer: this.peer.name, kind: 'push', detail: pushed.code === 0 ? `ok ${commit}` : `rejected ${commit} ${pushFailure(ctx, pushed)}` });
    return pushed.code === 0;
  }
}

export function naiveEngine(opts?: { forcePush?: boolean }): EngineFactory {
  const forcePush = opts?.forcePush === true;
  return (_ctx: SimContext, peer: PeerClone): SimEngine => new NaiveEngine(peer, forcePush);
}
