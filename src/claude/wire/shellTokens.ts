// src/claude/wire/shellTokens.ts — CCI-28 (Task 1: tokenize; Task 10: classify, writesFiles). The advisory shell gate's tokenizer: pure,
// best effort (it never runs or expands anything), and conservative where a shell would differ (parentheses split segments).
import type { ShellTool } from './frames.js';

export interface ShellSegment { argv: string[]; redirects: Array<{ op: '>' | '>>'; target: string }>; cwd: string | null; gitC: string | null; }

type Sep = ';' | '\n' | '&&' | '||' | '|' | '&' | '(' | ')' | 'end';
type Token =
  | { kind: 'word'; text: string }
  | { kind: 'sep'; sep: Sep }
  | { kind: 'redir'; op: '>' | '>>'; target: string }
  | { kind: 'skip' };   // an input redirection or a descriptor duplication: no file is written

const BLANK = (c: string): boolean => c === ' ' || c === '\t' || c === '\r';
const ENDS_WORD = (c: string): boolean => BLANK(c) || c === '\n' || ';&|()<>'.includes(c);

/** A PowerShell here-string starting at i (`@'` or `@"`, then only blanks to the end of the line): its content (the lines after the header up
 *  to the first line starting `'@` / `"@`, quotes inside being content) and the index after the terminator; an unterminated one runs to the
 *  end of the input (PowerShell refuses to parse it, so nothing after it runs). null when i starts no here-string. */
function readHereString(s: string, i: number): { text: string; end: number } | null {
  const q = s[i + 1];
  if (s[i] !== '@' || (q !== "'" && q !== '"')) return null;
  let h = i + 2;
  while (h < s.length && BLANK(s[h] as string)) h++;
  if (s[h] !== '\n') return null;
  const close = s.indexOf(`\n${q}@`, h);
  const body = s.slice(h + 1, close < 0 ? s.length : close);
  return { text: body.endsWith('\r') ? body.slice(0, -1) : body, end: close < 0 ? s.length : close + 3 };
}

/** One word starting at i (quotes per shell): the text and the index after it. */
function readWord(s: string, i: number, ps: boolean): { text: string; end: number } {
  let text = '';
  if (ps) {
    const here = readHereString(s, i);
    if (here !== null) {
      text = here.text;
      i = here.end;
    }
  }
  while (i < s.length && !ENDS_WORD(s[i] as string)) {
    const c = s[i] as string;
    if (!ps && c === '\\') {
      if (s[i + 1] === '\n') { i += 2; continue; }   // line continuation
      if (i + 1 < s.length) text += s[i + 1];
      i += 2;
      continue;
    }
    if (ps && c === '`') {
      if (i + 1 < s.length) text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") {
      i++;
      for (; i < s.length; i++) {
        if (s[i] === "'") {
          if (ps && s[i + 1] === "'") { text += "'"; i++; continue; }   // '' is one quote in PowerShell
          break;
        }
        text += s[i];
      }
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      for (; i < s.length && s[i] !== '"'; i++) {
        const d = s[i] as string;
        if (!ps && d === '\\' && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1] as string)) {
          i++;
          if (s[i] !== '\n') text += s[i];
        } else if (ps && d === '`' && i + 1 < s.length) {
          i++;
          const e = s[i] as string;
          text += e === 'n' ? '\n' : e === 't' ? '\t' : e === '0' ? '' : e;
        } else {
          text += d;
        }
      }
      i++;
      continue;
    }
    text += c;
    i++;
  }
  return { text, end: i };
}

interface HereDoc { delim: string; tabs: boolean }

/** Skips the bodies of the pending here-documents, in order, from i (the start of the line after the command line): each runs through the
 *  first line equal to its delimiter (leading tabs removed for <<-, a trailing \r ignored); an unterminated one runs to the end, as in Bash. */
function skipHereDocs(s: string, i: number, pending: readonly HereDoc[]): number {
  for (const h of pending) {
    while (i < s.length) {
      const nl = s.indexOf('\n', i);
      let line = s.slice(i, nl < 0 ? s.length : nl);
      i = nl < 0 ? s.length : nl + 1;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (h.tabs) line = line.replace(/^\t+/, '');
      if (line === h.delim) break;
    }
  }
  return i;
}

function lex(s: string, ps: boolean): Token[] {
  const out: Token[] = [];
  const hereDocs: HereDoc[] = [];   // bodies pending until the next unquoted newline (Bash, Monitor)
  let depth = 0;                    // open parentheses
  let arith = -1;                   // the depth an arithmetic (( … )) opened at, else -1: a << inside it is a shift, not a here-document
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (BLANK(c)) { i++; continue; }
    if (c === '#') {   // a comment runs to the end of the line
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      out.push({ kind: 'sep', sep: c });
      i = skipHereDocs(s, i + 1, hereDocs);
      hereDocs.length = 0;
      continue;
    }
    if (c === '(') {
      if (arith < 0 && s[i + 1] === '(') arith = depth;
      depth++;
    } else if (c === ')') {
      if (depth > 0) depth--;
      if (arith >= 0 && depth <= arith) arith = -1;
    }
    if (c === ';' || c === '(' || c === ')') { out.push({ kind: 'sep', sep: c }); i++; continue; }
    if (c === '|') {
      if (s[i + 1] === '|') { out.push({ kind: 'sep', sep: '||' }); i += 2; } else { out.push({ kind: 'sep', sep: '|' }); i++; }
      continue;
    }
    if (c === '&' && s[i + 1] === '&') { out.push({ kind: 'sep', sep: '&&' }); i += 2; continue; }
    // A redirection: an optional descriptor prefix (digits, Bash's &, PowerShell's *), then > >> >| or < forms.
    let j = i;
    if (c === '&' || c === '*') j = i + 1;
    else while (j < s.length && s[j]! >= '0' && s[j]! <= '9') j++;
    if (s[j] === '>' || (s[j] === '<' && (j === i || c !== '&'))) {
      if (c === '*' && !ps) { /* a glob word, not a prefix */ } else if (!ps && arith < 0 && s[j] === '<' && s[j + 1] === '<' && s[j + 2] !== '<') {
        // A here-document (<< or <<-, not the <<< here-string): the delimiter word (quotes removed) is read now and the body is skipped
        // at the next newline, so its lines are never commands; the rest of this line (a redirect, a pipe, a chain) stays the command's.
        let k = j + 2;
        const tabs = s[k] === '-';
        if (tabs) k++;
        while (k < s.length && BLANK(s[k] as string)) k++;
        const delim = readWord(s, k, ps);
        if (delim.end > k) hereDocs.push({ delim: delim.text, tabs });
        out.push({ kind: 'skip' });
        i = delim.end;
        continue;
      } else {
        const input = s[j] === '<';
        let k = j + 1;
        let append = false;
        if (!input && s[k] === '>') { append = true; k++; } else if (!input && s[k] === '|') k++;
        while (input && (s[k] === '<')) k++;
        if (s[k] === '&') {   // a descriptor duplication (2>&1, >&2, <&0): no file
          k++;
          while (k < s.length && /[0-9-]/.test(s[k] as string)) k++;
          out.push({ kind: 'skip' });
          i = k;
          continue;
        }
        while (k < s.length && BLANK(s[k] as string)) k++;
        const target = readWord(s, k, ps);
        out.push(input ? { kind: 'skip' } : { kind: 'redir', op: append ? '>>' : '>', target: target.text });
        i = target.end;
        continue;
      }
    }
    if (c === '&') { out.push({ kind: 'sep', sep: '&' }); i++; continue; }
    const w = readWord(s, i, ps);
    if (w.end === i) { i++; continue; }   // a lone operator character readWord stops at (unreachable for the forms above)
    out.push({ kind: 'word', text: w.text });
    i = w.end;
  }
  return out;
}

/** PowerShell's common aliases and cmdlet names (any case) → the cmdlet name. */
const PS_NAMES: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  const add = (cmdlet: string, ...aliases: string[]): void => {
    for (const a of [cmdlet, ...aliases]) m.set(a.toLowerCase(), cmdlet);
  };
  add('Set-Content', 'sc');
  add('Add-Content', 'ac');
  add('Clear-Content', 'clc');
  add('Get-Content', 'gc', 'cat', 'type');
  add('Remove-Item', 'ri', 'rm', 'rmdir', 'del', 'erase', 'rd');
  add('Copy-Item', 'cp', 'copy', 'cpi');
  add('Move-Item', 'mv', 'move', 'mi');
  add('New-Item', 'ni', 'md', 'mkdir');
  add('Rename-Item', 'ren', 'rni');
  add('Write-Output', 'echo', 'write');
  add('Get-ChildItem', 'ls', 'dir', 'gci');
  add('Set-Location', 'cd', 'sl', 'chdir');
  add('Tee-Object', 'tee');
  add('Out-File');
  add('Set-Item', 'si');
  add('Set-ItemProperty', 'sp');
  add('Get-Item', 'gi');
  add('Invoke-WebRequest', 'iwr', 'curl', 'wget');
  return m;
})();

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const isAbsoluteDir = (d: string): boolean => /^(?:[/\\~]|[A-Za-z]:)/.test(d);
const compose = (base: string | null, dir: string): string => (base === null || isAbsoluteDir(dir) ? dir : `${base}/${dir}`);

/** Split on ; && || | & ( ) and newlines; strip a leading `cd <dir> &&` (the dir applies to the && chain it starts, which a ; newline || or &
 *  ends) and environment-variable prefixes (Bash, Monitor); honour `git -C <dir>` (consumed, composed into gitC); normalize PowerShell aliases.
 *  A here-document's body (Bash, Monitor: << and <<-, outside an arithmetic (( … ))) is skipped and a PowerShell here-string (@'…'@, @"…"@)
 *  is one word: file content written through them is never read as commands. */
export function tokenize(command: string, tool: ShellTool): ShellSegment[] {
  const ps = tool === 'PowerShell';
  const out: ShellSegment[] = [];
  let argv: string[] = [];
  let redirects: ShellSegment['redirects'] = [];
  let chainCwd: string | null = null;
  const finish = (sep: Sep): void => {
    if (!ps) while (argv.length > 0 && ASSIGNMENT.test(argv[0] as string)) argv.shift();
    if (ps && argv.length > 0) argv[0] = PS_NAMES.get((argv[0] as string).toLowerCase()) ?? (argv[0] as string);
    const isCd = argv.length === 2 && redirects.length === 0 && (ps ? argv[0] === 'Set-Location' : argv[0] === 'cd');
    if (isCd) {
      chainCwd = sep === '&&' ? compose(chainCwd, argv[1] as string) : null;
    } else if (argv.length > 0 || redirects.length > 0) {
      let gitC: string | null = null;
      if (argv.length > 0 && /^git(?:\.exe)?$/i.test(argv[0] as string)) {
        const kept = [argv[0] as string];
        let k = 1;
        for (; k < argv.length; k++) {
          const a = argv[k] as string;
          if (a === '-C' && k + 1 < argv.length) { gitC = compose(gitC, argv[++k] as string); continue; }
          if (!a.startsWith('-')) break;
          kept.push(a);
          if (a === '-c' && k + 1 < argv.length) kept.push(argv[++k] as string);
        }
        argv = [...kept, ...argv.slice(k)];
      }
      out.push({ argv, redirects, cwd: chainCwd, gitC });
    }
    if (sep !== '&&' && sep !== '|') chainCwd = null;
    argv = [];
    redirects = [];
  };
  for (const t of lex(command, ps)) {
    if (t.kind === 'word') argv.push(t.text);
    else if (t.kind === 'redir') redirects.push({ op: t.op, target: t.target });
    else if (t.kind === 'sep') finish(t.sep);
  }
  finish('end');
  return out;
}

export type ShellHit =
  | { cls: 'git'; verb: string } | { cls: 'formatter'; tool: string } | { cls: 'inplace'; targets: string[] }
  | { cls: 'cowork_cli'; why: 'acting_verb' | 'state_path' | 'ipc_key' } | { cls: 'worktree' };

/** Classes (a)–(e) of 06 §3.9; (c) lists the literal targets (the daemon checks them against the claim view); read-only CLI verbs and
 *  `cat .git/cowork/status.json` are no hit. Class (d)'s cowork-CLI token table (`SHELL_COWORK_CLI`, Task 10) admits named exception rows
 *  `{cli, hint}`; Plan 8b adds `{cli: 'view', hint: '/cowork view'}` as an 8b edit with the Plan 5 reviewer. */
export function classify(segs: readonly ShellSegment[], ctx: { gitdir: string; root: string; dataDir: string; platform: NodeJS.Platform }): ShellHit[] {
  void segs;
  void ctx;
  throw new Error('Plan 5 Task 10');
}

/** 06 §3.9 last paragraph: class (b), or any class (c) writer or redirection whatever its target (the wake-turn rule, R5-05). */
export function writesFiles(segs: readonly ShellSegment[]): boolean {
  void segs;
  throw new Error('Plan 5 Task 10');
}
