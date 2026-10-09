// Typed object ids (ENG-09). A value of type Oid has passed parseOid; a refspec, update-ref or
// commit-tree argument is never a bare string.
declare const OID_BRAND: unique symbol;
export type Oid = string & { readonly [OID_BRAND]: true };

/** JSON form of an absent side, record side or lease. */
export const ABSENT = 'ABSENT' as const;
export type Absent = typeof ABSENT;
export type OidOrAbsent = Oid | Absent;

export class OidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidError';
  }
}

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Strips one trailing LF (git's stdout), then accepts only 40 or 64 lowercase hex characters. */
export function parseOid(s: string): Oid {
  const t = typeof s === 'string' && s.endsWith('\n') ? s.slice(0, -1) : s;
  if (typeof t !== 'string' || !OID_RE.test(t)) {
    const shown = typeof t === 'string' ? JSON.stringify(t.length > 80 ? `${t.slice(0, 80)}...` : t) : typeof t;
    throw new OidError(`not an object id: ${shown}`);
  }
  return t as Oid;
}

export function isOid(x: unknown): x is Oid {
  return typeof x === 'string' && OID_RE.test(x);
}

/** First 12 hex characters, for logs and traces. */
export function oid12(o: Oid): string {
  return o.slice(0, 12);
}
