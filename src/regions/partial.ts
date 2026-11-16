// The C# partial-type grep (04-regions §3.12, §6 row "Partial-type grep fails/times out"; REG-17; rulings R4-44, R4-45): which
// files of the private index declare a partial part of a type, found by one `git grep --cached` under GIT_INDEX_FILE within
// BUDGETS.partialGrepMs. It reads only the index and the blobs it names (glossary §26.1 W6) and writes nothing. A failure or a
// timeout is {failed: true, files: []}: TableCache keeps no index of partial declarations, so the fallback is groupNameHit's
// hunk.fileDeclaresPartial — every hunk of a file whose post bytes declare a partial part touches a claim on that type (P2).
import { GitCommandError } from '../git/repo.js';
import type { PartialTypeInfo } from './groupName.js';
import type { RegionService } from './service.js';

/** A C# identifier as this daemon's own table spells a type's simple name; anything else never enters the argv. */
const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const NUL = 0x00;
const LF = 0x0a;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;

/** The grep's ERE: the spec's trailing \b spelled ([^[:alnum:]_]|$) (a GNU extension some platforms' regex libraries lack; the matches are the same). */
const grepPattern = (name: string): string => `partial[[:space:]]+(class|struct|record|interface)[[:space:]]+${name}([^[:alnum:]_]|$)`;

/** The same pattern as a JavaScript regex, line by line as git matches (LC_ALL=C: [[:space:]] is ASCII space, tab, VT, FF and CR within a row,
 *  [[:alnum:]] ASCII letters and digits); the name is matched literally. */
const lineRegex = (name: string): RegExp =>
  new RegExp(`partial[ \\t\\v\\f\\r]+(?:class|struct|record|interface)[ \\t\\v\\f\\r]+${name.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')}(?:[^A-Za-z0-9_\\n]|$)`, 'm');

/** git grep -z -n --text --no-color -E -e '<pattern>' --cached on the private index through GitRepo.run
 *  (GIT_INDEX_FILE = the private index; no RunOpts.config — core.quotepath=off is one of the runner's forced -c pairs, R4-44), deadline 100 ms; a failure or a timeout →
 *  {failed: true, files: []}: every hunk of a file whose post bytes declaresPartial touches, through groupNameHit's hunk.fileDeclaresPartial (R4-45).
 *  The pattern rides behind -e: git refuses an option (--cached) after the first non-option argument, so the argv the spec spells (`-E <pattern> --cached`) exits 128.
 *  --text: without it git prints a match in a file it deems binary (a NUL in the first 8,000 bytes, or a -diff/binary attribute — WinForms' partial
 *  Form1.Designer.cs is often -diff yet a class-4 text file with a table) as a NUL-free "Binary file <path> matches" line, which no parse can tell from a
 *  path holding LF; with it every match is a record, and a matching binary blob only adds a path (P2).
 *  A failure is a refused name, an expired deadline (the AbortSignal fires through the Clock port: s.deps.clock), an exit other than 0 (matches) or 1 (none), an
 *  aborted or killed run, any byte on stderr (git grep reports an index entry whose blob is missing — "unable to read", W6 — on stderr only and keeps its
 *  exit status, so stderr's presence, never its text, is the signal), or stdout outside the record grammar. Paths come back verbatim from the -z records,
 *  parsed NUL-first (path NUL line NUL text LF: a path can hold LF, never NUL; a row's text can hold NUL, never LF), sorted by code unit and deduplicated. */
export async function partialTypeFiles(s: RegionService, simpleName: string): Promise<PartialTypeInfo> {
  const failed: PartialTypeInfo = { simpleName, files: [], failed: true };
  if (!IDENTIFIER.test(simpleName)) return failed;
  const deadline = s.deps.budgets.deadline('partial_grep');
  if (deadline.expired()) return failed;
  const abort = new AbortController();
  let finished = false;
  void (async () => {
    while (!finished && !deadline.expired()) await s.deps.clock.sleep(Math.max(1, deadline.remainingMs()));
    if (!finished) abort.abort();
  })();
  try {
    const r = await s.deps.repo.run(['grep', '-z', '-n', '--text', '--no-color', '-E', '-e', grepPattern(simpleName), '--cached'], {
      indexFile: s.deps.privateIndex, abort: abort.signal, okCodes: [0, 1],
    });
    if (r.aborted || r.killedByWatchdog || r.stderr.length > 0 || abort.signal.aborted || deadline.expired()) return failed;
    const files = r.code === 0 ? pathsOf(r.stdout) : [];
    return files === null ? failed : { simpleName, files, failed: false };
  } catch (e) {
    if (e instanceof GitCommandError) return failed;
    throw e;
  } finally {
    finished = true;
  }
}

/** The path of every -z -n --text record, verbatim, deduplicated and sorted by code unit; null when stdout is not a sequence of records.
 *  Parsed NUL-first: the path is the bytes up to the record's first NUL (it may hold LF), then one or more ASCII digits and a NUL, then the
 *  row's text up to its LF (it may hold NUL; git ends every printed row with LF). Anything else — an empty path, a NUL-free line, a line
 *  number that is not digits, a record cut before its LF — is null: the grep is then a failure, never a partial list. */
function pathsOf(out: Buffer): string[] | null {
  const paths = new Set<string>();
  let at = 0;
  while (at < out.length) {
    const nul = out.indexOf(NUL, at);
    if (nul <= at) return null;
    let end = nul + 1;
    for (let b = out[end]; b !== undefined && b >= DIGIT_0 && b <= DIGIT_9; b = out[end]) end++;
    if (end === nul + 1 || out[end] !== NUL) return null;
    const lf = out.indexOf(LF, end + 1);
    if (lf < 0) return null;
    paths.add(out.toString('utf8', at, nul));
    at = lf + 1;
  }
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The grep's pattern over one file's post bytes: a file-level boolean that can only add a conflict and supplies no range (REG-03). */
export function declaresPartial(bytes: Buffer, simpleName: string): boolean {
  return lineRegex(simpleName).test(bytes.toString('utf8'));
}
