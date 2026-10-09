// The one reader of git's text (ENG-46, ENG-58, glossary §27.2; lint L-CLASSIFY-TEXT keeps it out of the classifiers):
// the HTTP status of a push or fetch, from git's own transport report. Its result can only start the throttle
// fallback (make handling stricter); it never decides lease loss, transient, NONRETRYABLE or OFFLINE.

export type HttpThrottle = 'http_429' | 'http_5xx' | null;

/**
 * git's curl reports: `The requested URL returned error: <code>` and `RPC failed; HTTP <code> …`. A code is three digits
 * not followed by a fourth.
 */
const STATUS_RE = /(?:The requested URL returned error: |\bHTTP )(\d{3})(?!\d)/g;
/** A quoted span, e.g. the URL in `unable to access '<url>':`, is never read: a path could spell `HTTP 503`. */
const QUOTED_RE = /'[^']*'/g;

/**
 * 'http_429' when git reported HTTP 429, else 'http_5xx' when it reported any 500–599, else null. Only git's own lines
 * count: a `remote:` line is the host's (or a hook's) text, and quoted spans are skipped.
 */
export function readHttpThrottle(stderr: Buffer): HttpThrottle {
  let server = false;
  for (const raw of stderr.toString('utf8').split(/\r\n|\r|\n/)) {
    const line = raw.trimStart();
    if (line.startsWith('remote:')) continue;
    for (const m of line.replace(QUOTED_RE, "''").matchAll(STATUS_RE)) {
      const status = Number(m[1]);
      if (status === 429) return 'http_429';
      if (status >= 500 && status <= 599) server = true;
    }
  }
  return server ? 'http_5xx' : null;
}
