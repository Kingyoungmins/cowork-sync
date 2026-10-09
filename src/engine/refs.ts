// The refs of glossary §4 for one live branch (ENG-02): the remote board, code and displaced refs in the
// active namespace, the probe ref, the fetched values and the local state, holds and incident refs, and the
// three explicit fetch refspecs. Only the remote prefix depends on the namespace (release `refs/cowork/`, test
// builds `refs/cowork-ci/<run_id>/`); local refs are always in the common `refs/cowork-remote/` and
// `refs/cowork-local/` namespaces, never `refs/worktree/*`.
import type { PeerId } from '../board/ids.js';
import { enc } from '../git/enc.js';
import type { FetchSpec } from '../git/fetch.js';
import { oid12, parseOid, type Oid } from '../git/oid.js';
import { validId } from '../sec/validators.js';

export interface RefNamespace { readonly remotePrefix: string; }    // 'refs/cowork/' or (test builds) 'refs/cowork-ci/<run_id>/'

export const RELEASE_NAMESPACE: RefNamespace = Object.freeze({ remotePrefix: 'refs/cowork/' });

const RUN_ID_RE = /^[0-9A-Za-z_-]{1,40}$/;
const TEST_PREFIX_RE = /^refs\/cowork-ci\/[0-9A-Za-z_-]{1,40}\/$/;

/** The test-build namespace `refs/cowork-ci/<runId>/` (glossary §4, ruling R-34); runId /^[0-9A-Za-z_-]{1,40}$/. */
export function testNamespace(runId: string): RefNamespace {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error(`testNamespace: invalid run id ${JSON.stringify(runId)}`);
  return Object.freeze({ remotePrefix: `refs/cowork-ci/${runId}/` });
}

export interface RefNames {
  readonly branch: string; readonly e: string;
  readonly remoteBoard: string; readonly remoteCode: string; readonly remoteBranch: string;   // <prefix><e>/board, <prefix><e>/code, refs/heads/<b>
  readonly localBoard: string; readonly localCode: string; readonly localBranch: string;     // refs/cowork-remote/<e>/{board,code,branch}
  readonly state: string; readonly holds: string;                                            // refs/cowork-local/<e>/{state,holds}
  readonly displacedPrefix: string;                                                          // <prefix><e>/displaced/
  displaced(o: Oid): string;
  incident(n: number): string; incidentOwn(n: number): string;
  probe(peer: PeerId): string;                                                               // <prefix>probe-<peer>
  readonly fetchSpecs: readonly FetchSpec[];                                                 // the three glossary §4 refspecs
}

/**
 * A name git can carry under refs/heads/ (git check-ref-format's rules): no control character, space,
 * `~ ^ : ? * [ \`, no `..`, `@{`, `//`, no component starting with `.` or ending with `.lock`, not starting
 * with `-` or `/`, not ending with `/` or `.`. The branch comes from the clone's symbolic HEAD, so this only
 * refuses what git itself would.
 */
function validBranch(b: string): boolean {
  if (typeof b !== 'string' || b.length === 0 || b === '@') return false;
  if (/[\0-\x20\x7f~^:?*[\\]/.test(b) || b.includes('..') || b.includes('@{') || b.includes('//')) return false;
  if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.')) return false;
  return b.split('/').every((c) => !c.startsWith('.') && !c.endsWith('.lock'));
}

function counter(what: string, n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${what}: n must be a safe integer >= 1, got ${String(n)}`);
  return n;
}

/** The glossary §4 refs of branch b in namespace ns; enc(b) beyond 150 bytes throws EncTooLongError. */
export function refNames(branch: string, ns: RefNamespace): RefNames {
  const prefix = ns.remotePrefix;
  if (prefix !== RELEASE_NAMESPACE.remotePrefix && !TEST_PREFIX_RE.test(prefix)) {
    throw new Error(`refNames: not a cowork namespace ${JSON.stringify(prefix)}`);
  }
  const e = enc(branch);
  if (!validBranch(branch)) throw new Error(`refNames: invalid branch name ${JSON.stringify(branch)}`);
  const remoteBoard = `${prefix}${e}/board`;
  const remoteCode = `${prefix}${e}/code`;
  const remoteBranch = `refs/heads/${branch}`;
  const localBoard = `refs/cowork-remote/${e}/board`;
  const localCode = `refs/cowork-remote/${e}/code`;
  const localBranch = `refs/cowork-remote/${e}/branch`;
  const local = `refs/cowork-local/${e}/`;
  const displacedPrefix = `${prefix}${e}/displaced/`;
  const fetchSpecs: readonly FetchSpec[] = Object.freeze([
    Object.freeze({ remote: remoteBoard, local: localBoard }),
    Object.freeze({ remote: remoteCode, local: localCode }),
    Object.freeze({ remote: remoteBranch, local: localBranch }),
  ]);
  return Object.freeze({
    branch, e,
    remoteBoard, remoteCode, remoteBranch,
    localBoard, localCode, localBranch,
    state: `${local}state`, holds: `${local}holds`,
    displacedPrefix,
    displaced: (o: Oid): string => `${displacedPrefix}${oid12(parseOid(o))}`,
    incident: (n: number): string => `${local}incident-${counter('incident', n)}`,
    incidentOwn: (n: number): string => `${local}incident-${counter('incidentOwn', n)}-own`,
    probe: (peer: PeerId): string => {
      if (!validId('hex128', peer)) throw new Error(`probe: not a peer id ${JSON.stringify(peer)}`);
      return `${prefix}probe-${peer}`;
    },
    fetchSpecs,
  });
}
