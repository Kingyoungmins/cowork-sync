// The URL fragment (12 §3.8 "Filters", §3.10.2 "Redemption"; R-V22): the single-use launch token `#k=<64 hex>` and the
// optional filter mirror `#room=r…&peer=<handle>&desk=<ordinal>`. Every value is matched by a fixed regex; nothing is decoded,
// and nothing is ever read as a path or used as an object key. Pure and DOM-free (R-V33).

const LAUNCH_RE = /^#k=([0-9a-f]{64})$/;
const ROOM_RE = /^r[0-9A-HJKMNP-TV-Z]{8}$/;
const PEER_RE = /^[0-9a-f]{6,32}$/;
const DESK_RE = /^(0|[1-9][0-9]{0,4})$/;

export interface FilterFragment { room: string | null; peer: string | null; desk: number | null; }

/** ^#k=([0-9a-f]{64})$ → the token, else null. */
export function takeLaunchToken(hash: string): string | null {
  const m = LAUNCH_RE.exec(hash);
  return m === null ? null : m[1]!;
}

/**
 * 12 §3.10.2: the page removes a launch fragment at once, before any request (`clear` is history.replaceState(null, '', '/')
 * in the page), then returns the token (null when malformed). A fragment that is not a launch fragment (a filter mirror after a
 * reload) is left alone.
 */
export function consumeLaunchToken(loc: { hash: string; clear(): void }): string | null {
  const hash = loc.hash;
  if (!hash.startsWith('#k=')) return null;
  loc.clear();
  return takeLaunchToken(hash);
}

/** Fixed regexes only, never a path: room ^r[0-9A-HJKMNP-TV-Z]{8}$, peer ^[0-9a-f]{6,32}$ (R-V22), desk ^(0|[1-9][0-9]{0,4})$; the
 *  first occurrence of a key wins; an invalid value or an unknown key is ignored. */
export function parseFilterFragment(hash: string): FilterFragment {
  const out: FilterFragment = { room: null, peer: null, desk: null };
  if (!hash.startsWith('#')) return out;
  const seen = new Set<string>();
  for (const part of hash.slice(1).split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq), value = part.slice(eq + 1);
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === 'room' && ROOM_RE.test(value)) out.room = value;
    else if (key === 'peer' && PEER_RE.test(value)) out.peer = value;
    else if (key === 'desk' && DESK_RE.test(value)) out.desk = Number(value);
  }
  return out;
}

/** '#room=…&peer=…&desk=…' with only the valid, non-null values ('' when none). */
export function formatFilterFragment(f: FilterFragment): string {
  const parts: string[] = [];
  if (f.room !== null && ROOM_RE.test(f.room)) parts.push(`room=${f.room}`);
  if (f.peer !== null && PEER_RE.test(f.peer)) parts.push(`peer=${f.peer}`);
  if (f.desk !== null && Number.isSafeInteger(f.desk) && DESK_RE.test(String(f.desk))) parts.push(`desk=${f.desk}`);
  return parts.length === 0 ? '' : `#${parts.join('&')}`;
}
