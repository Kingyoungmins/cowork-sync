// Attribute source (03-data §3.3, DAT-13): every attribute read runs under -c attr.tree=<EPOCH_BASE>,
// so a peer's working-tree .gitattributes edit never changes a decision. Personal attribute files
// ($GIT_DIR/info/attributes, core.attributesFile) still apply with attr.tree set; they can only narrow
// this peer's own decisions, and the cache is dropped when either file changes.
import { join } from 'node:path';
import type { Oid } from '../git/oid.js';
import type { GitRepo } from '../git/repo.js';
import type { Fs } from '../ports/fs.js';

export interface PathAttrs {
  filter: string | null;
  merge: string | null;
  text: 'set' | 'unset' | 'auto' | null;
  binary: boolean;
  eol: string | null;
  generated: boolean;
  coworkOff: boolean;
}

export interface AttrSnapshot {
  readonly epochBase: Oid;
  get(path: string): PathAttrs;
}

const ATTR_NAMES = ['filter', 'merge', 'text', 'binary', 'eol', 'linguist-generated', 'cowork-sync'] as const;
const NO_VALUE: ReadonlySet<string> = new Set(['set', 'unset', 'unspecified']);

/**
 * The personal attribute files of this clone: info/attributes and the global file git itself reads
 * (`git var GIT_ATTR_GLOBAL`: core.attributesFile, else $XDG_CONFIG_HOME/git/attributes, else ~/.config/git/attributes).
 */
export async function personalAttributeFiles(repo: GitRepo): Promise<string[]> {
  const files = [join(repo.paths.gitDir, 'info', 'attributes')];
  const r = await repo.run(['var', 'GIT_ATTR_GLOBAL'], { okCodes: [0, 1, 128] });
  const global = r.code === 0 ? r.stdout.toString('utf8').replace(/\r?\n$/, '') : '';
  if (global.length > 0) files.push(global);
  return files;
}

function stringValue(v: string): string | null {
  return NO_VALUE.has(v) ? null : v;
}

function toPathAttrs(v: ReadonlyMap<string, string>): PathAttrs {
  const get = (name: string): string => v.get(name) ?? 'unspecified';
  const merge = get('merge');
  const text = get('text');
  const generated = get('linguist-generated');
  return Object.freeze({
    filter: stringValue(get('filter')),
    merge: merge === 'set' ? 'text' : merge === 'unset' ? 'binary' : stringValue(merge),
    text: text === 'set' || text === 'unset' || text === 'auto' ? text : null,
    binary: get('binary') === 'set',
    eol: stringValue(get('eol')),
    generated: generated === 'set' || generated === 'true',
    coworkOff: get('cowork-sync') === 'off',
  });
}

/**
 * `check-attr -z --stdin filter merge text binary eol linguist-generated cowork-sync` under
 * `-c attr.tree=<epochBase>`; cached per (epochBase, path); the cache is dropped when the stat of
 * `$GIT_DIR/info/attributes` or of core.attributesFile changes, or on `invalidate()`.
 */
export class AttrCache {
  private readonly repo: GitRepo;
  private readonly fs: Fs;
  private readonly cache = new Map<string, PathAttrs>();
  private cachedBase: Oid | null = null;
  private signature: string | null = null;
  private files: string[] | null = null;
  private generation = 0;

  constructor(repo: GitRepo, fs: Fs) {
    this.repo = repo;
    this.fs = fs;
  }

  invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.cachedBase = null;
    this.signature = null;
    this.files = null;
  }

  private async currentSignature(): Promise<string> {
    this.files ??= await personalAttributeFiles(this.repo);
    const parts: string[] = [];
    for (const file of this.files) {
      const st = await this.fs.stat(file);
      parts.push(st === null ? `${file}|absent` : `${file}|${st.size}|${st.mtimeMs}`);
    }
    return parts.join('\n');
  }

  async snapshot(epochBase: Oid, paths: Iterable<string>): Promise<AttrSnapshot> {
    const sig = await this.currentSignature();
    if (this.cachedBase !== epochBase || this.signature !== sig) {
      this.generation++;
      this.cache.clear();
      this.cachedBase = epochBase;
      this.signature = sig;
    }
    const wanted = [...new Set(paths)];
    const missing = wanted.filter((p) => !this.cache.has(p));
    const fetched = new Map<string, PathAttrs>();
    if (missing.length > 0) {
      const generation = this.generation;
      const stdin = Buffer.from(missing.map((p) => `${p}\0`).join(''), 'utf8');
      const r = await this.repo.run(['check-attr', '-z', '--stdin', ...ATTR_NAMES], { class: 'attr', attrTree: epochBase, stdin });
      const fields = r.stdout.toString('utf8').split('\0');
      const byPath = new Map<string, Map<string, string>>();
      for (let i = 0; i + 2 < fields.length; i += 3) {
        const path = fields[i] ?? '';
        let m = byPath.get(path);
        if (m === undefined) {
          m = new Map();
          byPath.set(path, m);
        }
        m.set(fields[i + 1] ?? '', fields[i + 2] ?? '');
      }
      for (const p of missing) {
        const v = byPath.get(p);
        if (v === undefined) throw new Error(`check-attr: no answer for ${JSON.stringify(p)}`);
        fetched.set(p, toPathAttrs(v));
      }
      // A concurrent invalidation (or another EPOCH_BASE) makes these answers stale for the cache, not for this call.
      if (generation === this.generation) for (const [p, a] of fetched) this.cache.set(p, a);
    }
    const own = new Map<string, PathAttrs>();
    for (const p of wanted) {
      const a = fetched.get(p) ?? this.cache.get(p);
      if (a !== undefined) own.set(p, a);
    }
    return {
      epochBase,
      get(path: string): PathAttrs {
        const a = own.get(path);
        if (a === undefined) throw new Error(`AttrSnapshot: attributes of ${JSON.stringify(path)} were not requested`);
        return a;
      },
    };
  }
}
