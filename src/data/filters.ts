// Algorithm D3 (03-data §3.4, DAT-15): the filter drivers in force at EPOCH_BASE and a fingerprint of
// each driver's configuration. Every daemon git call then carries -c filter.<d>.required=true for them.
import { createHash } from 'node:crypto';
import type { Oid } from '../git/oid.js';
import type { GitRepo } from '../git/repo.js';
import type { Fs } from '../ports/fs.js';
import { personalAttributeFiles } from './attrs.js';

export interface FilterSet {
  /** Sorted by code unit. */
  drivers: string[];
  /** sha256 hex of `clean\0smudge\0process\0required` per driver (no paths, no user names). */
  fingerprint: Record<string, string>;
  /**
   * Set (to the number of distinct drivers found) when more than MAX_DRIVERS were discovered: `drivers` then
   * holds only the first MAX_DRIVERS and the engine must fail closed (every path under a filter attribute is a
   * `filter_failure` exclusion, nothing filtered is published) and surface the reason. null otherwise.
   */
  overCap: number | null;
}

/** Each driver is one `-c filter.<d>.required=true` pair on every git call; a committed file must not overflow argv. */
export const MAX_DRIVERS = 64;
/** A longer name counts as over the cap (it is never returned): 600-character names would overflow the Windows command line. */
export const MAX_DRIVER_NAME_BYTES = 128;
/** Budget for the summed `-c filter.<d>.required=true` pairs of all returned drivers (name bytes + 24 per pair). */
export const MAX_DRIVER_ARGV_BYTES = 8192;
const PAIR_OVERHEAD = '-c '.length + 'filter.'.length + '.required=true'.length;

/** The names flags.ts accepts (`checkDriverName`): non-empty, no '=', no whitespace, no NUL. */
function validDriverName(d: string): boolean {
  return d.length > 0 && !/[=\s\0]/.test(d);
}

/** `filter=<name>` tokens of an attributes file; comment lines are skipped. */
function driversNamedIn(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    for (const token of line.split(/\s+/)) {
      if (token.startsWith('filter=')) {
        const name = token.slice('filter='.length);
        if (validDriverName(name)) out.push(name);
      }
    }
  }
  return out;
}

/**
 * Effective `filter.<d>.{clean,smudge,process,required}` values from the config files; the last value wins.
 * Command-scope values are dropped: the runner's own forced `-c filter.<d>.required=true` would otherwise
 * change the fingerprint with the driver set (a spurious FREEZE(CONFIG)). Record layout of
 * `config -z --show-scope`: `scope NUL key NL value NUL`.
 */
async function driverSettings(repo: GitRepo): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  const r = await repo.run(['config', '-z', '--show-scope', '--get-regexp', '^filter\\.'], { okCodes: [0, 1] });
  if (r.code !== 0) return out;
  const fields = r.stdout.toString('utf8').split('\0');
  // Records come as `scope`, then `key NL value` (a key without a value has no NL: `key`), each NUL-terminated.
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i] ?? '';
    const record = fields[i + 1] ?? '';
    if (scope === 'command') continue;
    const nl = record.indexOf('\n');
    const key = nl < 0 ? record : record.slice(0, nl);
    const value = nl < 0 ? 'true' : record.slice(nl + 1);
    const last = key.lastIndexOf('.');
    if (!key.startsWith('filter.') || last <= 'filter.'.length - 1) continue;
    const name = key.slice('filter.'.length, last);
    const variable = key.slice(last + 1).toLowerCase();
    let m = out.get(name);
    if (m === undefined) {
      m = new Map();
      out.set(name, m);
    }
    m.set(variable, value);
  }
  return out;
}

export async function discoverFilters(repo: GitRepo, fs: Fs, epochBase: Oid): Promise<FilterSet> {
  const names = new Set<string>();

  // 1. check-attr over the paths of EPOCH_BASE, under attr.tree=<EPOCH_BASE> (personal files still apply)
  const tree = await repo.readTreeMap(epochBase);
  const paths = [...tree.keys()];
  if (paths.length > 0) {
    const stdin = Buffer.from(paths.map((p) => `${p}\0`).join(''), 'utf8');
    const r = await repo.run(['check-attr', '-z', '--stdin', 'filter'], { class: 'attr', attrTree: epochBase, stdin });
    const fields = r.stdout.toString('utf8').split('\0');
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const value = fields[i + 2] ?? '';
      if (value !== 'set' && value !== 'unset' && value !== 'unspecified' && validDriverName(value)) names.add(value);
    }
  }

  // (a 120000 entry is read too: under -c attr.tree git reads a symlinked .gitattributes blob as attribute text)
  // ... plus every driver any .gitattributes of EPOCH_BASE names, even when no tracked path matches it today:
  // a new file matching that rule must still be hashed under filter.<d>.required=true (stricter, never looser)
  const attrFiles = [...tree.values()].filter((e) => e.mode !== '160000' && (e.path === '.gitattributes' || e.path.endsWith('/.gitattributes')));
  for (const blob of await repo.readBlobs(attrFiles.map((e) => e.oid))) {
    for (const d of driversNamedIn(blob.toString('utf8'))) names.add(d);
  }

  // ... plus every driver the personal attribute files name
  for (const file of await personalAttributeFiles(repo)) {
    if ((await fs.stat(file)) === null) continue;
    for (const d of driversNamedIn((await fs.readFile(file)).toString('utf8'))) names.add(d);
  }

  const settings = await driverSettings(repo);
  const all = [...names].sort();
  const drivers: string[] = [];
  let argvBytes = 0;
  for (const d of all) {
    const size = Buffer.byteLength(d, 'utf8');
    if (size > MAX_DRIVER_NAME_BYTES || drivers.length >= MAX_DRIVERS || argvBytes + size + PAIR_OVERHEAD > MAX_DRIVER_ARGV_BYTES) continue;
    drivers.push(d);
    argvBytes += size + PAIR_OVERHEAD;
  }
  const overCap = drivers.length < all.length ? all.length : null;
  const fingerprint: Record<string, string> = {};
  for (const d of drivers) {
    const s = settings.get(d);
    const v = (k: string): string => s?.get(k) ?? '';
    fingerprint[d] = createHash('sha256').update(`${v('clean')}\0${v('smudge')}\0${v('process')}\0${v('required')}`, 'utf8').digest('hex');
  }
  return { drivers, fingerprint, overCap };
}
