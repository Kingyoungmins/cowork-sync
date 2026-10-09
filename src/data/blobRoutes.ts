// Blob routes (b) and (c) of 03-data §3.1 and the DAT-07 new-path hash (DAT-01, DAT-07; glossary §26.1 W1, W6).
// Route (b) hashes a staged copy (never the user's working file) under its repository path, so the
// EPOCH_BASE attributes and the team's required filters apply exactly as for p; it runs at the repository
// root (glossary §25 F12) and never with a work tree (ENG-08). Route (c) hashes bytes that are already
// stored form (canon, concat and restore output; metadata blobs) with --no-filters. `write` is false at
// detection ticks (ids only) and true only at ready-pair capture, publish, apply and hold-record creation.
import { OidError, parseOid, type Oid } from '../git/oid.js';
import type { GitRepo, RunOpts } from '../git/repo.js';

export interface FilterFailure { readonly failed: 'filter'; readonly path: string; }

export function isFilterFailure(x: unknown): x is FilterFailure {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as { failed?: unknown; path?: unknown };
  return r.failed === 'filter' && typeof r.path === 'string';
}

function checkPath(path: string): void {
  if (path.length === 0 || path.startsWith('/') || path.endsWith('/') || /[\0\r\n\\]/.test(path)) {
    throw new Error(`invalid repository path ${JSON.stringify(path)}`);
  }
}

async function hashPath(repo: GitRepo, path: string, stageFile: string, write: boolean, extra: RunOpts): Promise<Oid | FilterFailure> {
  checkPath(path);
  if (stageFile.length === 0 || /[\0\r\n]/.test(stageFile)) throw new Error(`invalid stage file ${JSON.stringify(stageFile)}`);
  const args = ['hash-object', ...(write ? ['-w'] : []), `--path=${path}`, '--', stageFile];
  // rc 128 is git's die(): with filter.<d>.required=true a failing clean filter dies before any object is written.
  const r = await repo.run(args, { class: 'attr', ...extra, okCodes: [0, 128] });
  if (r.code === 128) return { failed: 'filter', path };
  try {
    return parseOid(r.stdout.toString('utf8'));
  } catch {
    throw new OidError(`git hash-object printed no object id (exit ${r.code})`);
  }
}

/** Route (b): hash-object [-w] --path=<path> <stageFile>, cwd = repo root, attr.tree + required filters; rc 128 → FilterFailure (nothing stored). */
export function hashRouteB(repo: GitRepo, path: string, stageFile: string, write: boolean): Promise<Oid | FilterFailure> {
  return hashPath(repo, path, stageFile, write, {});
}

/** Route (c): stored-form bytes (canon and concat output): hash-object [-w] --stdin --no-filters. */
export function hashRouteC(repo: GitRepo, bytes: Buffer, write: boolean): Promise<Oid> {
  return repo.hashBytes(bytes, write);
}

/** DAT-07: a new path in a call of its own, route (b) with -c core.autocrlf=input (EPOCH_BASE text/eol attributes still decide). */
export function hashNewPath(repo: GitRepo, path: string, stageFile: string, write: boolean): Promise<Oid | FilterFailure> {
  return hashPath(repo, path, stageFile, write, { config: { 'core.autocrlf': 'input' } });
}
