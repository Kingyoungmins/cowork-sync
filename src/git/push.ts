// Pushes (ENG-09, ENG-43, INV-OID, glossary §26.2 items 1-2). pushSpec is the only refspec builder, buildPushArgv
// the only push argv (lint L-PUSH-ARGV: no other file starts an argv with `push`), deleteProbeRef the only remote
// deletion. Every push is `--porcelain --no-verify` with one `--force-with-lease` per ref; never `--atomic`, never
// `--force`, never a `+` refspec. The outcome is the exit code and the porcelain status of each ref; stderr is kept
// only for readHttpThrottle and the doctor record (no branch here reads it).
import { checkRefName, checkUrl, runNetwork } from './netcall.js';
import { ABSENT, parseOid, type Oid, type OidOrAbsent } from './oid.js';
import type { GitRepo } from './repo.js';

/** 'none' = no porcelain line for that ref (a transport failure, a kill, `fatal error in commit_refs`, glossary §25 F11). */
export type PushRefStatus = 'ok' | 'rejected' | 'none';
export interface PushSpec { readonly ref: string; readonly newOid: Oid; readonly lease: OidOrAbsent; }
export interface PushOutcomeRaw {
  code: number; killedByWatchdog: boolean; durationMs: number;
  /** per spec ref */
  statuses: ReadonlyMap<string, PushRefStatus>;
  /** only for readHttpThrottle and the doctor record */
  stderr: Buffer;
  argv: readonly string[];
}

/** Porcelain flags of an updated ref: fast-forward, forced update, new ref, up to date, deleted (deleteProbeRef). */
const OK_FLAGS: ReadonlySet<string> = new Set([' ', '+', '*', '=', '-']);

/**
 * A push destination: a plain git refname under refs/ (checkRefName, which already refuses ':') with no '+' anywhere,
 * so no forced or deletion refspec can be spelled. Board refs are enc(b)-encoded and never contain one; Plan 7's save
 * push to refs/heads/<b> builds its own refspec (controller ruling).
 */
function checkPushRef(ref: string, what: string): void {
  checkRefName(what, ref);
  if (ref.includes('+')) throw new Error(`${what}: invalid push ref ${JSON.stringify(ref)} (a '+')`);
}

/** The only refspec builder (ENG-09): newOid re-validated by parseOid, the lease an Oid or ABSENT; anything else throws. */
export function pushSpec(newOid: Oid, ref: string, lease: OidOrAbsent): PushSpec {
  const oid = parseOid(newOid);
  const l: OidOrAbsent = lease === ABSENT ? ABSENT : parseOid(lease);
  checkPushRef(ref, 'pushSpec');
  return Object.freeze({ ref, newOid: oid, lease: l });
}

/**
 * ['push','--porcelain','--no-verify', ('-o', opt)…, '--force-with-lease=<ref>:<lease|>'…, url, '<newOid>:<ref>'…]; never
 * --atomic, --force or '+'. Every spec is re-validated through pushSpec (a hand-built object cannot bypass it); no spec,
 * a ref named twice, an option-like url or a push option with a line break throws before any git call.
 */
export function buildPushArgv(url: string, specs: readonly PushSpec[], pushOptions: readonly string[]): string[] {
  checkUrl('push', url);
  if (specs.length === 0) throw new Error('buildPushArgv: no refspec (git would push its default refspecs)');
  const checked = specs.map((s) => pushSpec(s.newOid, s.ref, s.lease));
  const seen = new Set<string>();
  for (const s of checked) {
    if (seen.has(s.ref)) throw new Error(`buildPushArgv: ref ${s.ref} named twice`);
    seen.add(s.ref);
  }
  const argv = ['push', '--porcelain', '--no-verify'];
  for (const o of pushOptions) {
    if (typeof o !== 'string' || o.length === 0 || /[\0\r\n]/.test(o)) throw new Error(`buildPushArgv: invalid push option ${JSON.stringify(o)}`);
    argv.push('-o', o);
  }
  for (const s of checked) argv.push(`--force-with-lease=${s.ref}:${s.lease === ABSENT ? '' : s.lease}`);
  argv.push(url);
  for (const s of checked) argv.push(`${s.newOid}:${s.ref}`);
  return argv;
}

/**
 * `<flag>\t<from>:<to>\t<summary>` lines of `git push --porcelain`: '!' → rejected; ' ', '*', '+', '=' (and '-', a deleted
 * ref) → ok; any other flag on a per-ref line is a status other than ok → rejected; no line → 'none'. The destination is
 * after the last ':' (a ref cannot contain one); the summary is never read. Only `refs` are reported, each once.
 */
export function parsePorcelain(stdout: Buffer, refs: readonly string[]): Map<string, PushRefStatus> {
  const out = new Map<string, PushRefStatus>(refs.map((r) => [r, 'none']));
  const seen = new Set<string>();
  for (const raw of stdout.toString('utf8').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length < 3 || line.charAt(1) !== '\t') continue;
    const spec = line.slice(2).split('\t')[0] ?? '';
    const colon = spec.lastIndexOf(':');
    if (colon < 0) continue;
    const to = spec.slice(colon + 1);
    if (!out.has(to) || seen.has(to)) continue;
    seen.add(to);
    out.set(to, OK_FLAGS.has(line.charAt(0)) ? 'ok' : 'rejected');
  }
  return out;
}

/** One push through runNetwork (class 'network', push watchdog 90 s; never throws on the exit code, a crash code is status-less). */
async function pushWith(repo: GitRepo, argv: readonly string[], refs: readonly string[]): Promise<PushOutcomeRaw> {
  const r = await runNetwork(repo, argv);
  return {
    code: r.code,
    killedByWatchdog: r.killedByWatchdog,
    durationMs: r.durationMs,
    statuses: parsePorcelain(r.stdout, refs),
    stderr: r.stderr,
    argv: Object.freeze([...argv]),
  };
}

/** One push of buildPushArgv's argv, class 'network' (push watchdog 90 s). Never throws on the exit code. */
export function runPush(repo: GitRepo, url: string, specs: readonly PushSpec[], pushOptions: readonly string[]): Promise<PushOutcomeRaw> {
  const argv = buildPushArgv(url, specs, pushOptions);
  return pushWith(repo, argv, specs.map((s) => s.ref));
}

/**
 * The only remote deletion (INV-OID): `--force-with-lease=<ref>:<lease> :<ref>`. Throws before spawning unless ref ===
 * allowed and the last path segment of allowed starts with 'probe-' (the caller passes RefNames.probe(own peer_id)).
 */
export function deleteProbeRef(repo: GitRepo, url: string, ref: string, allowed: string, lease: Oid): Promise<PushOutcomeRaw> {
  checkPushRef(allowed, 'deleteProbeRef');
  const segment = allowed.slice(allowed.lastIndexOf('/') + 1);
  if (!segment.startsWith('probe-') || segment.length === 'probe-'.length) {
    throw new Error(`deleteProbeRef: ${JSON.stringify(allowed)} is not a probe ref`);
  }
  if (ref !== allowed) throw new Error(`deleteProbeRef: ${JSON.stringify(ref)} is not the allowed probe ref ${JSON.stringify(allowed)}`);
  const expect = parseOid(lease);
  checkUrl('push', url);
  const argv = ['push', '--porcelain', '--no-verify', `--force-with-lease=${ref}:${expect}`, url, `:${ref}`];
  return pushWith(repo, argv, [ref]);
}
