// URL userinfo redaction (09-security: a credential never reaches a log, status, report or the pinned meta; rulings
// R-26, R-34; the Task 17 ruling: the remote URL's userinfo, https and scp form, is stripped before meta.pinned.url and
// every output). The daemon's network calls keep the URL the user configured (an ssh user such as `git@` is part of
// how the host is reached); only what is stored or shown loses the userinfo. One exception, by name (Task 17 fix round
// 2): a printed line may keep an exact url.<base>.insteadOf key whose base carries at most an scp-form user name, so the
// printed command names the rule that exists (sanitizeText's `keep`); scheme userinfo (a password or token) never.

/** `scheme://userinfo@` (https, ssh, git, …) up to the host. */
const SCHEME_USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/;
/** A `scheme://` prefix. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** git's scp-like form `user@host:path` (no scheme, no slash before the colon). */
const SCP_USERINFO = /^[^/@:\s]+@([^/:\s]+:)/;
/** Scheme userinfo anywhere in a text. */
const SCHEME_USERINFO_IN_TEXT = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s"']*@/;

/** Drops userinfo from a URL: `scheme://user:pass@host/…` → `scheme://host/…`; scp-like `user@host:path` → `host:path`. */
export function sanitizeUrl(url: string): string {
  const scheme = SCHEME_USERINFO.exec(url);
  if (scheme !== null) return scheme[1]! + url.slice(scheme[0].length);
  const scp = SCP_USERINFO.exec(url);
  if (scp !== null) return url.slice(url.indexOf('@') + 1);
  return url;
}

/**
 * The userinfo a URL carries: 'none'; 'scp_user' for git's scp-like `user@host:path`, whose user part is a name (it
 * cannot hold a password); 'secret' for any other userinfo — every `scheme://…@` (a password or a token such as
 * `https://TOKEN@host/`) and any other form with an '@' before the host.
 */
export function userinfoKind(url: string): 'none' | 'scp_user' | 'secret' {
  if (SCHEME.test(url)) return SCHEME_USERINFO.test(url) ? 'secret' : 'none';
  if (!url.includes('@')) return 'none';
  return SCP_USERINFO.test(url) ? 'scp_user' : 'secret';
}

/** Redacts the userinfo of every URL in one segment of a line (see sanitizeText). */
function redactSegment(s: string): string {
  return s
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#\s"']*@/g, '$1')
    .replace(/(^|[\s"'=(<,])[^\s"'=(<,/@:]+@([^\s"'/:@]+:)/g, '$1$2');
}

/** A word boundary around a kept word: the line's ends, whitespace or a quote (as printed in JSON or a shell command). */
const KEEP_BEFORE = /[\s"']/;
const KEEP_AFTER = /[\s"',)]/;

/**
 * Every URL inside a line of text loses its userinfo: each `scheme://userinfo@`, and each scp-like `user@host:` word
 * (a word starts the line or follows whitespace, a quote, `=`, `(`, `<` or `,`). Over-redaction (an e-mail address
 * followed by a colon) is accepted; a printed line never keeps a credential. `keep`: exact words left as they are where
 * they stand as a whole word (bounded by the line's ends, whitespace or a quote) — an entry holding scheme userinfo is
 * ignored, so a credential is never kept.
 */
export function sanitizeText(line: string, keep: readonly string[] = []): string {
  const kept = keep.filter((k) => k.length > 0 && !SCHEME_USERINFO_IN_TEXT.test(k)).sort((a, b) => b.length - a.length);
  if (kept.length === 0) return redactSegment(line);
  let out = '';
  let from = 0;
  for (let i = 0; i < line.length; i++) {
    const k = kept.find((w) => line.startsWith(w, i) && (i === 0 || KEEP_BEFORE.test(line[i - 1]!))
      && (i + w.length === line.length || KEEP_AFTER.test(line[i + w.length]!)));
    if (k === undefined) continue;
    out += redactSegment(line.slice(from, i)) + k;
    i += k.length - 1;
    from = i + 1;
  }
  return out + redactSegment(line.slice(from));
}
