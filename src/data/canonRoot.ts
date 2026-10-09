// The canonical root form (glossary §24 default 12; 06 §3.4.1 step 3, CCI-07, SEC-21): one string per filesystem location,
// whatever its spelling. X-63: the one canonRoot of every plan — created by Plan 8a Task 7 at Plan 5's declared signature
// (verify pass V-12); Plan 5 Task 1 adds sameRoot, endpointRoot, findRepo and liveState here in place. Pure over the injected
// probe; a node-only leaf (imports only the RootProbe type and node:*). The `live` marker holds canonRoot(main worktree) + LF
// for Plans 5, 7 and 8b alike, and the viewer's room key is the same string (RoomSpec.canonicalRoot).
import { posix, win32 } from 'node:path';
import type { RootProbe } from '../ports/fs.js';

export type { RootProbe } from '../ports/fs.js';

/** p without trailing separators, a root (`/`, `C:\`, `\\server\share\`) excepted. */
function stripTrailing(p: string, path: typeof posix): string {
  const root = path.parse(p).root;
  let s = p;
  while (s.length > root.length && (s.endsWith('/') || (path === win32 && s.endsWith('\\')))) s = s.slice(0, -1);
  return s;
}

/**
 * realpathSync.native of the nearest existing ancestor + the remaining components; lower-case drive letter; '\' → '/'; NFC.
 * The path rules follow `platform` (win32: both separators, drive letters), not the running OS, so a fake probe can stand in
 * for another platform. The on-disk case is kept (no case folding: sameRoot compares with the DAT-34 case rule).
 */
export function canonRoot(p: string, probe: RootProbe, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix;
  let cur = stripTrailing(platform === 'win32' ? p.replace(/\//g, '\\') : p, path);
  const rest: string[] = [];
  while (!probe.exists(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  const base = probe.exists(cur) ? probe.realpathNative(cur) : cur;
  let out = rest.length === 0 ? base : path.join(base, ...rest);
  if (platform === 'win32') out = out.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  return out.normalize('NFC');
}
