// src/entry/hook.ts — the loader, dist/hook.js (06 §3.4.1 steps 1–9 and its last paragraph; CCI-06…CCI-08, CCI-45, CCI-54; A4-1, A4-2, A4-11,
// A4-13; R5-38, R5-40). Bundled alone (≤ 150 lines, node:* only: L-LOADER); ./core.js is a run-time import (A2-1). The build defines the three
// loader texts, the test-build flag and the version V (A2-2, P5-EB-11). Its private copies (A4-2, P5-EC-7) are kept equal to the shared modules by
// test/integration/loader.parity.test.ts: canonRoot/findRepo/liveState (src/data/canonRoot.ts), resolveDataDir/pluginIdOf (src/data/pluginDataDir.ts,
// X-61), readUserJson's language (src/claude/wire/pluginData.ts), loaderLang (X-53), seatKeyOf, normArgs (X-60), the nonce test, evidenceFor and
// evidenceTag (src/claude/wire/hookInput.ts) and the flat canonical line (src/claude/wire/ndjson.ts). Every path ends in process.exit (P5-EC-3 (c)).
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __COWORK_LOADER_TEXTS__: {
  readonly G4: Readonly<Record<'en' | 'ko', string>>;
  readonly PAUSED: Readonly<Record<'en' | 'ko', string>>;
  readonly HOOK_LOAD_FAIL: Readonly<Record<'en' | 'ko', string>>;
};
declare const __COWORK_TEST_BUILD__: boolean | undefined;
declare const __COWORK_VERSION__: string;

// (1) The start time (A4-3: core's deadline counts from it) and the fail-closed handlers: a gating event (A4-1: argv[2] === 'PreToolUse') takes the
// G4 text and exit 2, any other event exits 0 silently; exit 1 never. M08 (11 §3.9, test builds only) fails open. Every exit first appends the
// pending evidence line of step 4 that nothing delivered (only exit-0 events ever have one).
const startNs = process.hrtime.bigint();
const env = process.env;
const event = process.argv[2];
const gating = event === 'PreToolUse';
const win = process.platform === 'win32';
const P = win ? win32 : posix;
let lang: 'en' | 'ko' = 'en';
let evidence: { file: string; line: string } | null = null;
const tryOr = <T>(f: () => T, otherwise: T): T => {
  try {
    return f();
  } catch {
    return otherwise;
  }
};
const exit = (code: number, stdout = '', stderr = ''): never => {
  const e = evidence;
  if (e !== null) tryOr(() => mkdirSync(P.dirname(e.file), { recursive: true, mode: 0o700 }), undefined);
  if (e !== null) tryOr(() => appendFileSync(e.file, e.line, { mode: 0o600 }), undefined);
  if (stdout !== '') tryOr(() => writeSync(1, stdout), 0);
  if (stderr !== '') tryOr(() => writeSync(2, stderr), 0);
  return process.exit(code);
};
const fail = (): never => (gating && !((typeof __COWORK_TEST_BUILD__ === 'undefined' || __COWORK_TEST_BUILD__) && env['COWORK_TEST_MUTANT'] === 'M08') ? exit(2, '', __COWORK_LOADER_TEXTS__.G4[lang]) : exit(0));
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

// (1a, A4-13) Before stdin: the plugin data directory (resolveDataDir with CLAUDE_PLUGIN_ROOT or this bundle's dist/..; fail closed, SEC-20) and L_c
// from user.json's language, else the OS locale (loaderLang), so a malformed stdin already renders in L_c.
const absolute = (p: string | undefined): p is string => p !== undefined && p !== '' && !/^[\\/]{2}/.test(p) && p !== '/dev' && !p.startsWith('/dev/')
  && (win ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/'));
const pluginId = (root: string): string | null => {
  const c = root.split(/[\\/]+/).filter((x) => x !== '').slice(-5);
  const ok = /^(?:[\\/]|[A-Za-z]:[\\/])/.test(root) && c.length === 5 && c[0] === 'plugins' && c[1] === 'cache' && !c.slice(2).some((x) => x === '.' || x === '..');
  return ok ? `${c[3]}-${c[2]}`.replace(/[^A-Za-z0-9_-]/gu, '-') : null;
};
// withoutTrailingSeparator of a path.normalize result, which ends in at most one separator: drop it unless it is the root's ('/', 'C:\').
const trimSep = (p: string): string => (p.length > (win && /^[A-Za-z]:[\\/]/.test(p) ? 3 : 1) && (p.endsWith('/') || (win && p.endsWith('\\'))) ? p.slice(0, -1) : p);
const pluginRoot = env['CLAUDE_PLUGIN_ROOT'] || P.dirname(P.dirname(fileURLToPath(import.meta.url)));
const given = env['CLAUDE_PLUGIN_DATA'];
const id = pluginId(pluginRoot);
const config = env['CLAUDE_CONFIG_DIR'];
const rawDir = given ? (absolute(given) ? given : null) : id === null ? null : P.join(absolute(config) ? config : P.join(homedir(), '.claude'), 'plugins', 'data', id);
const normDir = rawDir === null ? null : trimSep(P.normalize(rawDir));
const dataDir = normDir !== null && absolute(normDir) ? normDir : null;
const userLanguage = dataDir === null ? null : tryOr(() => JSON.parse(readFileSync(P.join(dataDir, 'user.json'), 'utf8').replace(/^\u{FEFF}/u, ''))?.language, null);
const osLocale: string | null = tryOr(() => Intl.DateTimeFormat().resolvedOptions().locale, null);
lang = ['en', 'ko', 'zh-CN', 'ja', 'fr', 'es'].includes(userLanguage) ? (userLanguage === 'ko' ? 'ko' : 'en') : osLocale !== null && /^ko(?:$|[-_.@])/i.test(osLocale) ? 'ko' : 'en';

// The canonical root form and the walk to `.git` (synchronous node:fs; realRootProbe's exists/isDir/readText).
const exists = (p: string): boolean => tryOr(() => lstatSync(p, { throwIfNoEntry: false }) !== undefined, false);
const isDir = (p: string): boolean => tryOr(() => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true, false);
const text = (p: string): string | null => tryOr(() => readFileSync(p, 'utf8'), null);
const firstLine = (s: string | null): string => (s ?? '').split(/\r?\n/)[0] ?? '';
// p without trailing separators, a root ('/', 'C:\', '\\server\share\') excepted: the root, then the rest with its trailing separators cut.
const strip = (p: string): string => P.parse(p).root + p.slice(P.parse(p).root.length).replace(win ? /[\\/]+$/ : /\/+$/, '');
// realpath of the nearest ancestor that lstat finds and realpath resolves, then `rest` verbatim; a dangling or looping link (realpath ENOENT, ENOTDIR,
// ELOOP) counts as a missing component (P5-T4-1); any other realpath error throws (the step-1 mapping).
const real = (cur: string, rest: string[]): string => {
  try {
    if (exists(cur)) return rest.length === 0 ? realpathSync.native(cur) : P.join(realpathSync.native(cur), ...rest);
  } catch (e) {
    if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes((e as { code?: unknown } | null)?.code as string)) throw e;
  }
  return P.dirname(cur) === cur ? (rest.length === 0 ? cur : P.join(cur, ...rest)) : real(P.dirname(cur), [P.basename(cur), ...rest]);
};
const canon = (p: string): string => {
  const out = real(strip(win ? p.replace(/\//g, '\\') : p), []);
  return (win ? out.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`) : out).normalize('NFC');
};
// A `.git` file is never live (A4-2): WT_NOTE when its common gitdir is live, WT_SUBMODULE for a submodule of a live superproject — a gitdir under
// <super gitdir>/modules/, the first `modules` component whose parent holds a HEAD file (a folder merely named `modules` is not one).
const worktreeNote = (dir: string, dotgit: string): string | null => {
  const m = /^gitdir:[ \t]*(.*?)[ \t]*$/.exec(firstLine(text(dotgit)));
  const gitdir = m === null || m[1] === '' ? null : P.resolve(dir, m[1] as string);
  if (gitdir === null || !exists(gitdir)) return null;
  const parts = gitdir.split(/[\\/]+/);
  const above = (i: number): string => P.resolve(gitdir, ...parts.slice(i).map(() => '..'));   // the directory holding parts[i]
  const sub = parts.findIndex((c, i) => i > 0 && c === 'modules' && exists(P.join(above(i), 'HEAD')));
  const commondir = firstLine(text(P.join(gitdir, 'commondir'))).trim();
  const common = sub > 0 ? above(sub) : commondir === '' ? gitdir : P.resolve(gitdir, commondir);
  return exists(P.join(common, 'cowork', 'live')) ? (sub > 0 ? 'WT_SUBMODULE' : 'WT_NOTE') : null;
};
const findRepo = (start: string): { root: string; gitdir: string } | { note: string | null } | null => {
  for (let dir = strip(win ? start.replace(/\//g, '\\') : start); ; dir = P.dirname(dir)) {
    const dotgit = P.join(dir, '.git');
    if (exists(dotgit)) return isDir(dotgit) ? { root: canon(dir), gitdir: canon(dotgit) } : { note: worktreeNote(dir, dotgit) };
    if (P.dirname(dir) === dir) return null;
  }
};

// SEC-25 as ruled by X-60: the words of command_args as a POSIX shell splits them (blanks separate; '…' literal; "…" keeps backslash escapes of
// $ ` " \ and newline only; an unquoted backslash escapes the next character, backslash-newline joins lines; an unquoted # at a word start begins a
// comment; an unterminated quote runs to the end), one regex token at a time.
const TOKEN = /[ \t\n]|\\\n|#[^\n]*|'([^']*)'?|"((?:\\[\s\S]|[^"\\])*)"?|\\([\s\S])|[\s\S]/g;
const shellWords = (s: string): string[] => {
  const words: string[] = [];
  let cur: string | null = null;   // the word being built; null between words
  for (let m = TOKEN.exec(s); m !== null; m = TOKEN.exec(s)) {
    const t = m[0];
    if (t === ' ' || t === '\t' || t === '\n') {
      if (cur !== null) words.push(cur);
      cur = null;
    } else if (t[0] === '#' && cur !== null) {
      cur += '#';   // inside a word a # is literal: scan on right after it
      TOKEN.lastIndex = m.index + 1;
    } else if (t !== '\\\n' && t[0] !== '#') {
      cur = (cur ?? '') + (m[1] ?? (m[2] === undefined ? (m[3] ?? t) : m[2].replace(/\\([$`"\\\n])/g, (_x, c: string) => (c === '\n' ? '' : c))));
    }
  }
  return cur === null ? words : [...words, cur];
};
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const flatLine = (o: Record<string, string | boolean>): string => `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k])}`).join(',')}}`;

const run = async (): Promise<never> => {
  // (2) stdin, read fully and parsed (a failure is the step-1 mapping).
  const json = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof json?.cwd !== 'string') throw new TypeError('hook input: cwd');
  // (3) The target (an edit-class PreToolUse's file_path|notebook_path against cwd, else cwd), its canonical root form, the walk to `.git`.
  const edit = gating && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(json.tool_name);
  const file = edit ? (typeof json.tool_input?.file_path === 'string' ? json.tool_input.file_path : json.tool_input?.notebook_path) : undefined;
  const repo = findRepo(canon(typeof file === 'string' ? P.resolve(json.cwd, file) : json.cwd));
  const context = (s: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: s } });
  if (repo === null) return exit(0);
  if ('note' in repo) return exit(0, repo.note !== null && (edit || event === 'SessionStart' || event === 'SubagentStart') ? context(`[cowork-sync] ${repo.note}`) : '');
  // liveState: live iff <gitdir>/cowork/live names this root (sameRoot: case-insensitive on win32 and darwin); paused iff <gitdir>/cowork/paused too.
  const marker = text(`${repo.gitdir}/cowork/live`);
  const fold = (s: string): string => (win || process.platform === 'darwin' ? s.toLowerCase() : s);
  const state = marker === null || fold(firstLine(marker)) !== fold(repo.root) ? 'nonlive' : exists(`${repo.gitdir}/cowork/paused`) ? 'paused' : 'live';
  // (4) UserPromptExpansion of /cowork (R5-38): the pause/resume markers (without core.js) and, for an acting verb without a cws- nonce, the evidence record.
  let record: { args_sha256: string; mono_ns: string; prompt_id: string; seat_key: string; used: false; verb: string } | null = null;
  if (event === 'UserPromptExpansion' && json.expansion_type === 'slash_command' && ['cowork', 'cowork-sync:cowork'].includes(json.command_name)) {
    const words = shellWords(typeof json.command_args === 'string' ? json.command_args : '');
    const verb = words[0] ?? '';
    const paused = `${repo.gitdir}/cowork/paused`;
    if (verb === 'pause') tryOr(() => mkdirSync(P.dirname(paused), { recursive: true }), undefined);
    if (verb === 'pause') tryOr(() => writeFileSync(paused, '', { flag: 'wx' }), undefined);
    if (verb === 'resume') tryOr(() => unlinkSync(paused), undefined);
    const acting = ['start', 'stop', 'pause', 'resume', 'save', 'done', 'resolve', 'review', 'revert', 'release', 'recover', 'uninstall'].includes(verb);
    if (typeof json.prompt_id === 'string' && acting && !(typeof json.prompt === 'string' && /cws-[0-9a-f]{16}/.test(json.prompt))) {
      const socket = env['CLAUDE_CODE_MESSAGING_SOCKET'];
      const argsSha256 = sha256(words.slice(1).map((w) => JSON.stringify(w.replace(/\s+/g, ' '))).join(' '));
      record = { args_sha256: argsSha256, mono_ns: String(startNs), prompt_id: json.prompt_id, seat_key: socket ? sha256(socket) : String(process.ppid), used: false, verb };
      const key = dataDir === null ? null : tryOr(() => readFileSync(P.join(dataDir, 'ipc.key')), null);
      const tag: Record<string, string> = key !== null && key.length === 32 ? { tag: createHmac('sha256', key).update('evidence' + flatLine(record)).digest('hex') } : {};
      evidence = { file: `${repo.gitdir}/cowork/tmp/evidence.jsonl`, line: flatLine({ ...record, ...tag }) + '\n' };
    }
  }
  // (5) Not live, (6) paused: no IPC; the paused repo's SessionStart and UserPromptSubmit carry the PAUSED line.
  if (state !== 'live') return exit(0, state === 'paused' && (event === 'SessionStart' || event === 'UserPromptSubmit') ? context(__COWORK_LOADER_TEXTS__.PAUSED[lang]) : '');
  // (7)–(8) core.js at run time (A2-1); a load failure is T-HOOK_LOAD_FAIL {v} = V for a gating event. (9) core (06 §3.4.2).
  const core = await import('./core.js').catch(() => null);
  if (core === null) return gating ? exit(2, '', __COWORK_LOADER_TEXTS__.HOOK_LOAD_FAIL[lang].replace('{v}', __COWORK_VERSION__)) : exit(0);
  const coreEnv = { env, ppid: process.ppid, pluginRoot, startNs, platform: process.platform, home: homedir(), osLocale };
  const outcome = await core.main(event as Parameters<typeof core.main>[0], json, { root: repo.root, gitdir: repo.gitdir }, record, coreEnv);
  if (outcome.evidenceDelivered) evidence = null;
  return exit(outcome.exit);
};

if (event === '--version') process.stdout.write('cowork-sync hook ' + __COWORK_VERSION__ + '\n');
else if (event !== undefined) void run().catch(fail);
