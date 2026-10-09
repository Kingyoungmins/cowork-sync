// Fetch of the three explicit glossary §4 refspecs (ENG-02, ENG-18, 01-engine §3.6). Task 8 seeds the spec type that
// RefNames.fetchSpecs carries; Task 12 adds fetchRefs and lsRemote.
//
// The fetch names the pinned URL (never a remote name, so no configured remote.<name>.fetch applies) and explicit
// `+<remote>:<local>` refspecs into refs/cowork-remote/ only; the runner adds --no-write-fetch-head
// --no-auto-maintenance --no-tags and, for every fetch, core.logAllRefUpdates=always, so the engine writes no
// FETCH_HEAD, ORIG_HEAD, refs/remotes/* or refs/heads/* and every fetched ref gets a reflog. A fetch whose explicit
// source is missing fails as a whole, so a failed fetch is followed by one ls-remote of the same refs and, if the
// remote answered, a re-fetch of the present ones only — except after a watchdog kill or an abort, which end the call
// at once (a blackholed remote would cost another 45 s). Outcomes come from exit codes, the `--porcelain` per-ref lines
// and the refs read back; stderr is kept only for readHttpThrottle.
//
// Local or network (ruling P2-FETCHLOCAL): a failed re-fetch is a LOCAL failure only when git reached the local
// ref-update stage, which `fetch --porcelain` shows as one `<flag> <old> <new> <local ref>` line per destination it
// got to (a stale `refs/cowork-remote/…lock` prints `!` lines and exits 1). A transport failure dies before that
// stage (exit 128, no line), so it is a network failure: backoff and OFFLINE, even though ls-remote answered.
import { checkRefName, checkUrl, runNetwork } from './netcall.js';
import { ABSENT, isOid, type Oid, type OidOrAbsent } from './oid.js';
import type { GitRepo } from './repo.js';
import type { GitResult } from './runner.js';

/** One explicit refspec, fetched as `+<remote>:<local>`: the '+' belongs to the fetch argv only (L-REFS). */
export interface FetchSpec { remote: string; local: string; }

export interface FetchResult {
  /** fetch rc 0, or ls-remote answered after a failed fetch (and the re-fetch of the present refs, if any, succeeded) */
  ok: boolean;
  /**
   * Ruling P2-FETCHLOCAL: the remote answered (fetch rc 0, or ls-remote rc 0 and the re-fetch, if one ran, either
   * succeeded or failed at the local ref-update stage) and no call was killed by the watchdog or aborted. ok false
   * with remoteAnswered true is a LOCAL failure (e.g. a stale refs/cowork-remote lock): never OFFLINE and never the
   * network backoff. A re-fetch that failed on the transport after ls-remote answered is a network failure.
   */
  remoteAnswered: boolean;
  /**
   * per remote ref, read back from the local refs; ABSENT when ls-remote shows it missing. When ok is false these are
   * the local refs as they stand (the last fetched values; ABSENT where no local copy exists).
   */
  values: ReadonlyMap<string, OidOrAbsent>;
  /** the first fetch's exit code, watchdog kill of any call, and the summed duration of every call */
  code: number; killedByWatchdog: boolean; durationMs: number;
  /** every call's stderr, only for readHttpThrottle */
  stderr: Buffer;
}

/** The only destination namespace of a fetch: the fetched values (glossary §4, INV-ENG-USER). */
const LOCAL_PREFIX = 'refs/cowork-remote/';

function checkSpecs(specs: readonly FetchSpec[]): void {
  if (specs.length === 0) throw new Error('fetchRefs: no refspec');
  const remotes = new Set<string>();
  const locals = new Set<string>();
  for (const s of specs) {
    checkRefName('fetchRefs', s.remote);
    checkRefName('fetchRefs', s.local);
    if (!s.local.startsWith(LOCAL_PREFIX)) throw new Error(`fetchRefs: destination ${JSON.stringify(s.local)} is outside ${LOCAL_PREFIX}`);
    if (remotes.has(s.remote) || locals.has(s.local)) throw new Error(`fetchRefs: ${s.remote} or ${s.local} named twice`);
    remotes.add(s.remote);
    locals.add(s.local);
  }
}

const fetchArgv = (url: string, specs: readonly FetchSpec[]): string[] => ['fetch', '--porcelain', url, ...specs.map((s) => `+${s.remote}:${s.local}`)];

const PORCELAIN_LINE = /^(.) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/;

/**
 * Whether a fetch got as far as updating local refs: its `--porcelain` stdout holds at least one per-ref line
 * (`<flag> <old> <new> <local ref>`) naming one of its destinations. git prints those lines only after the transfer,
 * while it updates refs; a transport failure dies before, with no line.
 */
function reachedRefUpdate(r: GitResult, specs: readonly FetchSpec[]): boolean {
  const locals = new Set(specs.map((s) => s.local));
  return r.stdout.toString('utf8').split('\n').some((line) => {
    const m = PORCELAIN_LINE.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
    return m !== null && locals.has(m[4]!);
  });
}

/** A network call that ended without an answer and must not be followed by another (a blackholed remote, an abandon()). */
const cutOff = (r: GitResult): boolean => r.killedByWatchdog || r.aborted;

/** The local refs among `locals` that exist, by exact name (one for-each-ref). */
async function readLocal(repo: GitRepo, locals: readonly string[]): Promise<Map<string, Oid>> {
  const r = await repo.run(['for-each-ref', '--format=%(objectname) %(refname)', ...locals]);
  const wanted = new Set(locals);
  const out = new Map<string, Oid>();
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const sp = line.indexOf(' ');
    if (sp <= 0) continue;
    const name = line.slice(sp + 1);
    const oid = line.slice(0, sp);
    if (wanted.has(name) && isOid(oid)) out.set(name, oid);
  }
  return out;
}

/**
 * The `<oid>\t<ref>` lines of an ls-remote answer whose ref `keep` accepts and whose oid is an object id (the first line
 * of a ref wins). ls-remote patterns match ref-name tails, so the caller's `keep` decides which names count.
 */
function parseLsRemote(stdout: Buffer, keep: (ref: string) => boolean): Map<string, Oid> {
  const values = new Map<string, Oid>();
  for (const raw of stdout.toString('utf8').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const name = line.slice(tab + 1);
    const oid = line.slice(0, tab);
    if (keep(name) && !values.has(name) && isOid(oid)) values.set(name, oid);
  }
  return values;
}

async function lsRemoteRaw(repo: GitRepo, url: string, refs: readonly string[], abort?: AbortSignal): Promise<{ ok: boolean; values: Map<string, Oid>; r: GitResult }> {
  checkUrl('lsRemote', url);
  if (refs.length === 0) throw new Error('lsRemote: no ref');
  for (const ref of refs) checkRefName('lsRemote', ref);
  const r = await runNetwork(repo, ['ls-remote', url, ...refs], abort);
  if (r.code !== 0 || cutOff(r)) return { ok: false, values: new Map(), r };
  // Only exact names count.
  const wanted = new Set(refs);
  return { ok: true, values: parseLsRemote(r.stdout, (name) => wanted.has(name)), r };
}

/** `ls-remote <url> <ref>…` (class 'network'); ok iff it exited 0; values by exact ref name. */
export async function lsRemote(repo: GitRepo, url: string, refs: readonly string[]): Promise<{ ok: boolean; values: Map<string, Oid> }> {
  const { ok, values } = await lsRemoteRaw(repo, url, refs);
  return { ok, values };
}

/**
 * `ls-remote <url> <prefix>*` (class 'network'): every remote ref whose full name starts with `prefix` (a ref directory
 * ending in '/'), at any depth (git matches the pattern as a glob whose `*` also matches '/'), with its oid. The names
 * are the remote's: not validated here beyond the prefix (the caller validates them before any local use). ok iff it
 * exited 0.
 */
export async function lsRemotePrefix(repo: GitRepo, url: string, prefix: string): Promise<{ ok: boolean; values: Map<string, Oid> }> {
  checkUrl('lsRemotePrefix', url);
  if (!prefix.endsWith('/')) throw new Error(`lsRemotePrefix: ${JSON.stringify(prefix)} is no ref directory`);
  checkRefName('lsRemotePrefix', prefix.slice(0, -1));
  const r = await runNetwork(repo, ['ls-remote', url, `${prefix}*`]);
  if (r.code !== 0 || cutOff(r)) return { ok: false, values: new Map() };
  return { ok: true, values: parseLsRemote(r.stdout, (name) => name.startsWith(prefix) && name.length > prefix.length) };
}

/**
 * fetch --porcelain <url> +<remote>:<local>… (network class; -c core.logAllRefUpdates=always); on failure one lsRemote
 * of the same refs and, if it answered, a re-fetch of the present ones only. A watchdog kill or an abort (ruling
 * P2-ABORT: `abort` reaches every network call) ends it at once: a network failure, nothing answered. A re-fetch that
 * fails before the local ref update (a transport failure) is a network failure too: remoteAnswered false. The local
 * refs are read back in every case (a local call, never aborted).
 */
export async function fetchRefs(repo: GitRepo, url: string, specs: readonly FetchSpec[], abort?: AbortSignal): Promise<FetchResult> {
  checkUrl('fetchRefs', url);
  checkSpecs(specs);
  const first = await runNetwork(repo, fetchArgv(url, specs), abort);
  const calls: GitResult[] = [first];
  let ok = first.code === 0 && !cutOff(first);
  let answered = ok;
  let missing: ReadonlySet<string> = new Set();
  if (!ok && !cutOff(first)) {
    const ls = await lsRemoteRaw(repo, url, specs.map((s) => s.remote), abort);
    calls.push(ls.r);
    if (ls.ok) {
      answered = true;
      missing = new Set(specs.filter((s) => !ls.values.has(s.remote)).map((s) => s.remote));
      const present = specs.filter((s) => ls.values.has(s.remote));
      if (present.length === 0) {
        ok = true;
      } else {
        const again = await runNetwork(repo, fetchArgv(url, present), abort);
        calls.push(again);
        ok = again.code === 0 && !cutOff(again);
        // A re-fetch that hung (or was aborted) after ls-remote answered, or that failed before git updated any local
        // ref (the remote went away between the calls), is no local failure: the remote did not answer it.
        if (cutOff(again) || (!ok && !reachedRefUpdate(again, present))) answered = false;
      }
    }
  }
  const local = await readLocal(repo, specs.map((s) => s.local));
  const values = new Map<string, OidOrAbsent>();
  for (const s of specs) values.set(s.remote, missing.has(s.remote) ? ABSENT : (local.get(s.local) ?? ABSENT));
  return {
    ok,
    remoteAnswered: answered,
    values,
    code: first.code,
    killedByWatchdog: calls.some((c) => c.killedByWatchdog),
    durationMs: calls.reduce((n, c) => n + c.durationMs, 0),
    stderr: Buffer.concat(calls.map((c) => c.stderr)),
  };
}
