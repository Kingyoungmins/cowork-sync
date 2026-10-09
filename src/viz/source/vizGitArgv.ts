// The viewer's git allowlist (12-visualizer VIZ-07; Global Constraints "Viewer git", S22; R-V09, R-V10, R-V31).
// One grammar, two users: VizGit checks every argv with it before spawning, and lint L-VIZ-GIT
// (tools/lint/vizRules.ts) checks the argv literals of src/viz/** with it statically. It is read by the
// lint as well as bundled, so this module imports nothing.

/** An array literal starting with one of these is a git argv for L-VIZ-GIT (other string tables are not). */
export const VIZ_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'cat-file', 'rev-parse', 'rev-list', 'for-each-ref', 'version', 'log', 'show', 'fetch', 'push', 'update-ref', 'gc', 'checkout',
]);

/** The same expression as OID_RE behind isOid in src/git/oid.ts (pinned equal by test/unit/viz/vizGitArgv.test.ts). */
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** <ref>: the fetched board ref of one branch. */
const REF_RE = /^refs\/cowork-remote\/[^\s]+\/board$/;
/** <n>: a decimal count with no sign and no leading zero. */
const N_RE = /^(0|[1-9][0-9]{0,9})$/;
const FOR_EACH_REF_FORMAT = '--format=%(objectname) %(refname)';
const REMOTE_NAMESPACE = 'refs/cowork-remote/';

/**
 * Exactly the Global Constraints forms, each with no extra argument:
 *   version
 *   rev-parse --verify -q <ref>
 *   for-each-ref --format=%(objectname) %(refname) refs/cowork-remote/
 *   rev-list --first-parent --count <oid>
 *   rev-list --first-parent [--skip=<n>] --max-count=<n> <oid>
 *   cat-file --batch-check
 *   cat-file --batch
 * where <ref> matches ^refs/cowork-remote/[^\s]+/board$, <oid> satisfies isOid and <n> ^(0|[1-9][0-9]{0,9})$.
 *
 * The static check passes `placeholder` for a value it cannot read: an element equal to it (or the value of a
 * `--skip=`/`--max-count=` element) matches a positional slot (<ref>, <oid>) or such a flag value (<n>) only,
 * never a subcommand or a flag name. Without a placeholder every element is an ordinary value.
 */
export function vizGitArgvOk(args: readonly string[], placeholder?: string): boolean {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return false;
  const stands = (v: string): boolean => placeholder !== undefined && v === placeholder;
  /** A fixed token: never matched by a placeholder. */
  const is = (i: number, token: string): boolean => args[i] === token && !stands(token);
  const slot = (i: number, re: RegExp): boolean => {
    const v = args[i];
    return v !== undefined && (stands(v) || re.test(v));
  };
  /** `--skip=<n>` / `--max-count=<n>`; the element as a whole is never the placeholder. */
  const counted = (i: number, flag: string): boolean => {
    const v = args[i];
    if (v === undefined || stands(v) || !v.startsWith(flag)) return false;
    const n = v.slice(flag.length);
    return stands(n) || N_RE.test(n);
  };
  switch (args.length > 0 && !stands(args[0] as string) ? args[0] : '') {
    case 'version':
      return args.length === 1;
    case 'rev-parse':
      return args.length === 4 && is(1, '--verify') && is(2, '-q') && slot(3, REF_RE);
    case 'for-each-ref':
      return args.length === 3 && is(1, FOR_EACH_REF_FORMAT) && is(2, REMOTE_NAMESPACE);
    case 'rev-list':
      if (!is(1, '--first-parent')) return false;
      if (args.length === 4) return (is(2, '--count') || counted(2, '--max-count=')) && slot(3, OID_RE);
      return args.length === 5 && counted(2, '--skip=') && counted(3, '--max-count=') && slot(4, OID_RE);
    case 'cat-file':
      return args.length === 2 && (is(1, '--batch-check') || is(1, '--batch'));
    default:
      return false;
  }
}
