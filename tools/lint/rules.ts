import { posix } from 'node:path';
import ts from 'typescript';
import { p5SourceRules } from './p5rules.js';

// Plan 5 Task 2: the Plan 5 rule bodies live in p5rules.ts; lintSource runs its source part, lint.ts its file scans and import-graph walk.
export {
  expectedHooksJson, HOOK_THIN_ROOTS, lintCommandFile, lintDistLoader, lintDistPermission, lintHooksJson, lintHookThin, lintMcpSchema,
  MCP_DESCRIPTION_SENTENCE, walkHookThin,
} from './p5rules.js';

export interface LintFinding { rule: string; file: string; line: number; message: string; }

// Files allowed to do what a rule otherwise forbids (repo-relative, forward slashes).
const ALLOW: Readonly<Record<string, readonly string[]>> = {
  'L-GIT-SPAWN': ['src/git/runner.ts'],
  // src/cli/launch.ts: cowork start spawns the daemon in the background (v0.1.0-preview); it never spawns git.
  // Plan 5 (R5-03, A1-9): spawnDaemon() and the SEC fixed-argv ACL runner.
  'L-PORTS': ['src/git/runner.ts', 'src/cli/launch.ts', 'src/claude/client/spawn.ts', 'src/sec/winAcl.ts'],
  'L-CLOCK': ['src/ports/clock.ts'],
  'L-RANDOM': ['src/ports/random.ts'],
  'L-CRASHPOINTS': ['src/ports/crashpoint.ts'],
  // The local IPC port and the inbox poster (11-testing §3.10 "net (outside IPC)"; Plan 5 A1-9).
  'L-NET': ['src/ports/ipc.ts', 'src/ports/inbox.ts'],
  // Plan 5 A1-9 (INV-TOKEN, CCI-49): the MCP server's doorbell is the one reader of the messaging token.
  'L-TOKEN': ['src/claude/client/mcp/doorbell.ts'],
  // Plan 5 R5-03, CCI-51 (Task 2): spawnDaemon() is the one daemon spawn.
  'L-SPAWN': ['src/claude/client/spawn.ts'],
  // Plan 5 R5-03: the dependency-free hook loader (bundled alone as dist/hook.js) reads its markers with node:fs.
  'L-FS-PORT': ['src/ports/fs.ts', 'src/entry/hook.ts'],
  // ENG-09, ENG-58: every push argv is built in push.ts (pushSpec, buildPushArgv, deleteProbeRef).
  'L-PUSH-ARGV': ['src/git/push.ts'],
  // PRO-13, INV-ENG-AUTH: the mirror is only a fetched value and a lease (genesis mirror push ENG-51, recover ENG-22 step 5).
  'L-MIRROR': ['src/engine/refs.ts', 'src/engine/fetcher.ts', 'src/engine/publish.ts', 'src/engine/start.ts', 'src/engine/recover.ts'],
  // REG-01, INV-REG-COORD: the one line-table helper that converts tree-sitter results to rows (Plan 4).
  'L-OFFSETS': ['src/regions/worker/lineTable.ts'],
};

// L-OBJ-WRITE (glossary §26.1 W6; an approximation, 01-engine test 47 is the check): the files allowed to build an
// argv of each object-writing subcommand. hash-object only in the blob routes; add only in the snapshot and DISK_EQ.
const OBJ_WRITE_FILES: Readonly<Record<string, readonly string[]>> = {
  'hash-object': ['src/git/repo.ts', 'src/data/blobRoutes.ts'],
  add: ['src/engine/snapshot.ts', 'src/engine/diskEq.ts'],
};
/** L-CLASSIFY-TEXT (ENG-58, glossary §26.2 item 2): the push-outcome classifiers, where no text may be read. */
const CLASSIFY_FILES: ReadonlySet<string> = new Set(['src/git/classify.ts', 'src/engine/pushResult.ts']);
const TEXT_NAMES: ReadonlySet<string> = new Set(['stderr', 'stderrText', 'message']);
const MIRROR_NAMES: ReadonlySet<string> = new Set(['localCode', 'remoteCode']);

const SPAWN_FNS: ReadonlySet<string> = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const CHILD_PROCESS: ReadonlySet<string> = new Set(['child_process', 'node:child_process']);
const NET_MODULES: ReadonlySet<string> = new Set(['http', 'https', 'http2', 'tls', 'net', 'dgram', 'dns']);
const FS_MODULES: ReadonlySet<string> = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const FORBIDDEN_SUBCOMMANDS: ReadonlySet<string> = new Set(['checkout', 'checkout-index', 'switch', 'restore', 'stash', 'apply', 'gc']);
const SET_LIKE: ReadonlySet<string> = new Set(['Set', 'Map', 'WeakSet', 'WeakMap']);

function normalizeFile(file: string): string {
  return file.split('\\').join('/');
}

function allowed(rule: string, file: string): boolean {
  return (ALLOW[rule] ?? []).includes(file);
}

/**
 * Text of a string literal or a no-substitution template; for a template expression, its literal
 * parts joined with "${}" in place of each substitution (so `+${oid}:refs/x` reads "+${}:refs/x").
 */
export function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => '${}' + s.literal.text).join('');
  return null;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function propName(name: ts.PropertyName | ts.MemberName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

/** The property a destructuring element reads: `{ p }`, `{ p: x }` or `{ 'p': x }`; null for nested patterns. */
function boundProperty(b: ts.BindingElement): string | null {
  const n = b.propertyName ?? b.name;
  return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;
}

/**
 * The module a node loads, for the five load forms: `import … from 'm'`, `export … from 'm'`,
 * `import x = require('m')`, `require('m')` and `import('m')`. Null for anything else.
 */
export function loadedModule(node: ts.Node): string | null {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
    && ts.isStringLiteralLike(node.moduleReference.expression)) {
    return node.moduleReference.expression.text;
  }
  if (ts.isCallExpression(node)) {
    const arg0 = node.arguments[0];
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
    const isDynImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    if ((isRequire || isDynImport) && arg0 !== undefined && ts.isStringLiteralLike(arg0)) return arg0.text;
  }
  return null;
}

/** `net`, `node:net`, `dns/promises`, `node:dns/promises`, … */
function isNetModule(spec: string): boolean {
  const bare = spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
  return NET_MODULES.has(bare.split('/')[0] ?? '');
}

function containsLiteral(node: ts.Node, values: ReadonlySet<string>): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    const t = literalText(n);
    if (t !== null && values.has(t)) { hit = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/**
 * A git argv array: an array literal whose first element is a string literal (the subcommand),
 * that is not the argument of `new Set(...)` / `new Map(...)` (command-class tables are not argv).
 */
function argvOf(node: ts.ArrayLiteralExpression): string[] | null {
  const first = node.elements[0];
  if (first === undefined || literalText(first) === null || ts.isTemplateExpression(first)) return null;
  let p: ts.Node = node.parent;
  while (ts.isAsExpression(p) || ts.isParenthesizedExpression(p) || ts.isSatisfiesExpression(p)) p = p.parent;
  if (ts.isNewExpression(p) && ts.isIdentifier(p.expression) && SET_LIKE.has(p.expression.text)) return null;
  return node.elements.map((e) => literalText(e) ?? '');
}

function insideFetchArgv(node: ts.Node): boolean {
  const arr = node.parent;
  if (arr === undefined || !ts.isArrayLiteralExpression(arr)) return false;
  const argv = argvOf(arr);
  return argv !== null && argv[0] === 'fetch';
}

/** `-u`, `-m`, `-um`, ... but not a long option. */
function shortFlagGroupHas(a: string, letters: string): boolean {
  return /^-[A-Za-z]+$/.test(a) && [...a.slice(1)].some((ch) => letters.includes(ch));
}

/** L-GIT-FORBIDDEN (ENG-58, 11-testing §3.10): the message for a forbidden git argv, else null. */
function forbiddenGit(argv: readonly string[]): string | null {
  const sub = argv[0] ?? '';
  const rest = argv.slice(1);
  if (FORBIDDEN_SUBCOMMANDS.has(sub)) return `git ${sub} is forbidden in daemon code`;
  if (sub === 'read-tree' && rest.some((a) => shortFlagGroupHas(a, 'um'))) return `read-tree -u / -m is forbidden`;
  if (sub === 'reset' && rest.includes('--hard')) return `reset --hard is forbidden`;
  if (sub === 'add' && rest.some((a) => a === '-A' || a === '--all' || a === '.')) return `add -A / --all / . is forbidden`;
  if (sub === 'update-index' && rest.includes('--refresh') && rest.includes('-q')) return `update-index --refresh never carries -q (ENG-58)`;
  return null;
}

const PERMISSION_FORBIDDEN: ReadonlySet<string> = new Set(['allow', 'ask']);

// L-HOLD-STORES (05-holds HLD-12, HLD-18; 11-testing §3.10; 05 U2 rev 2.5; glossary §29.3; X-09, F-P3-6; Plan 3 Task 8).
/** Holding stores other than the one registry (HLD-01, HLD-12). */
const HOLD_STORE_NAMES: readonly string[] = ['refs/cowork-held/', 'refs/worktree/cowork/', 'cowork/quarantine/', 'cowork/conflicts/'];
/** The one module allowed to compute and apply -U0 hunks, and its two functions that may call diff / merge-file (HLD-18). */
const REVERT_FILE = 'src/holds/revert.ts';
const REVERT_FNS: ReadonlySet<string> = new Set(['revertDetector', 'taintOnlyH1']);
/** The one `merge-file --ours` caller (Algorithm REV step 4(c), Task 17): the function revertInverse in this file. */
const REVERT_CS_FILE = 'src/holds/revertCs.ts';
const OURS_FN = 'revertInverse';
/**
 * Ruling G1-FILEFORM (audit #1 #2): the one merge-file executor, runMergeFile. Every call site keeps writing the `merge-file -p --object-id`
 * argv (L-MERGE-OPTS and the --ours rule above hold there); this file runs that call in the file form over the objects' stored bytes, so
 * its own argv has no --object-id. It passes the caller's flag words through without naming them (--ours stays revertInverse's alone).
 */
const MERGE_FILE_EXECUTOR = 'src/git/merge.ts';
const U0_TOKENS: ReadonlySet<string> = new Set(['-U0', '--unified=0']);
const FORBIDDEN_HOLD_KINDS: ReadonlySet<string> = new Set(['SNAPSHOT', 'TRANSFORM']);

/** The names of every named function around a node: declarations, methods, named function expressions and `const f = () => …`. */
function enclosingFunctions(node: ts.Node): string[] {
  const out: string[] = [];
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isMethodDeclaration(p)) && p.name !== undefined) {
      const n = propName(p.name);
      if (n !== null) out.push(n);
    }
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) {
      out.push(p.parent.name.text);
    }
  }
  return out;
}

/** L-HOLD-STORES for one string literal (or template) of a src/ file: the message, else null. */
function holdStoreLiteral(lit: string, node: ts.Node, file: string): string | null {
  if (HOLD_STORE_NAMES.some((n) => lit.includes(n))) return `a holding store other than the registry (HLD-01, HLD-12): ${JSON.stringify(lit)}`;
  const tokens = lit.split(/\s+/);
  if (file !== REVERT_FILE && tokens.some((t) => U0_TOKENS.has(t))) return `-U0 hunks only in src/holds/revert.ts (taintOnlyH1 is the single applier, HLD-18, 05 U2)`;
  if (tokens.includes('--union') || tokens.includes('--theirs')) return `merge-file --union / --theirs is never used (HLD-12, glossary §9)`;
  if (tokens.includes('--ours') && !(file === REVERT_CS_FILE && enclosingFunctions(node).includes(OURS_FN))) {
    return `merge-file --ours only inside revertInverse() in ${REVERT_CS_FILE} (glossary §29.3, X-09)`;
  }
  if (lit.includes('state=wip')) return `no time-capped WIP publishing: state=wip (HLD-12)`;
  if (FORBIDDEN_HOLD_KINDS.has(lit)) return `no ${lit} hold kind (HLD-12; FREEZE reasons replace SNAPSHOT)`;
  return null;
}

/** `process.kill`, `process['kill']` or `<x>.process.kill` (e.g. globalThis.process.kill). */
function isProcessKill(callee: ts.Expression): boolean {
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
    : ts.isElementAccessExpression(callee) ? literalText(callee.argumentExpression) : null;
  if (name !== 'kill') return false;
  const obj = (callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
  return (ts.isIdentifier(obj) && obj.text === 'process') || (ts.isPropertyAccessExpression(obj) && obj.name.text === 'process');
}

/**
 * L-PID-KILL (final review, exit-1 flake): the message for a `process.kill(pid, signal)` that sends a signal, else null.
 * A pid is only a number: once its process has exited and been reaped (Node closes its handle), the OS may give it to
 * an unrelated process, which the signal then ends (TerminateProcess(h, 1) on Windows). Allowed: the signal-0 liveness
 * probe, and the runner's POSIX group kill `process.kill(-pid, …)` in src/git/runner.ts, which runs in the same tick as
 * the runner's `exited` check, before Node can reap the group leader, and (Plan 8a merge) the viewer CLI's POSIX group
 * kill `process.kill(-pgid, …)` in src/viz/cli/spawn.ts (12 §3.2 item 3, VIZ-02: the detached viewer leads its group,
 * which a member keeps alive after the leader exits). Handle-based ChildProcess.kill is not matched.
 */
const GROUP_KILL_FILES: ReadonlySet<string> = new Set(['src/git/runner.ts', 'src/viz/cli/spawn.ts']);

function pidKill(node: ts.CallExpression, file: string): string | null {
  if (!isProcessKill(node.expression)) return null;
  const sig = node.arguments[1];
  if (sig !== undefined && ts.isNumericLiteral(sig) && sig.text === '0') return null;
  const target = node.arguments[0];
  if (GROUP_KILL_FILES.has(file) && target !== undefined && ts.isPrefixUnaryExpression(target)
    && target.operator === ts.SyntaxKind.MinusToken) return null;
  return `process.kill(pid, <signal>) may hit a reused pid: signal only through a held ChildProcess handle, `
    + `or let the process exit on its own (signal 0 probes are allowed)`;
}

export function lintSource(file: string, text: string): LintFinding[] {
  const f = normalizeFile(file);
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: LintFinding[] = [];
  const report = (rule: string, node: ts.Node, message: string): void => {
    if (allowed(rule, f)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    out.push({ rule, file: f, line, message });
  };

  const visit = (node: ts.Node): void => {
    // L-PORTS / L-NET: module loads (import, export-from, import-equals, require, dynamic import).
    const mod = loadedModule(node);
    if (mod !== null) {
      if (CHILD_PROCESS.has(mod)) report('L-PORTS', node, `child_process loaded outside src/git/runner.ts`);
      if (isNetModule(mod)) report('L-NET', node, `network module "${mod}" loaded (no network egress, INV-EGRESS)`);
      if (f.startsWith('src/') && FS_MODULES.has(mod)) report('L-FS-PORT', node, `"${mod}" loaded outside src/ports/fs.ts (use the Fs port)`);
    }
    if (ts.isCallExpression(node)) {
      const arg0 = node.arguments[0];
      const name = calleeName(node.expression);
      // L-GIT-SPAWN: spawn('git', ...) / exec('git ...').
      if (name !== null && SPAWN_FNS.has(name) && arg0 !== undefined) {
        const t = literalText(arg0);
        if (t !== null && (t === 'git' || t.startsWith('git ') || /(^|[\\/])git(\.exe)?$/i.test(t))) {
          report('L-GIT-SPAWN', node, `git spawned outside createGitRunner().run()`);
        }
      }
      // L-CLOCK: Date.now() / performance.now().
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'now'
        && ts.isIdentifier(node.expression.expression)
        && (node.expression.expression.text === 'Date' || node.expression.expression.text === 'performance')) {
        report('L-CLOCK', node, `${node.expression.expression.text}.now() outside the Clock port`);
      }
      // L-CRASHPOINTS: crashpoint() must name its point with a string literal.
      if (name === 'crashpoint' && (arg0 === undefined || !ts.isStringLiteral(arg0))) {
        report('L-CRASHPOINTS', node, `crashpoint() argument must be a string literal`);
      }
      // L-PID-KILL: a signal sent to a bare pid.
      const killed = pidKill(node, f);
      if (killed !== null) report('L-PID-KILL', node, killed);
    }
    // L-CLOCK: new Date(...).
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
      report('L-CLOCK', node, `new Date() outside the Clock port`);
    }
    // L-RANDOM: Math.random, randomBytes, randomUUID (any reference).
    if (ts.isPropertyAccessExpression(node)) {
      const n = node.name.text;
      if (n === 'random' && ts.isIdentifier(node.expression) && node.expression.text === 'Math') {
        report('L-RANDOM', node, `Math.random outside the Random port`);
      }
      if (n === 'randomBytes' || n === 'randomUUID') report('L-RANDOM', node, `${n} outside the Random port`);
    }
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (imported === 'randomBytes' || imported === 'randomUUID') report('L-RANDOM', node, `${imported} imported outside the Random port`);
    }
    // L-CLASSIFY-TEXT: any identifier stderr / stderrText / message (or o['message']) in the classifiers.
    if (CLASSIFY_FILES.has(f)) {
      const name = ts.isIdentifier(node) ? node.text
        : ts.isElementAccessExpression(node) ? literalText(node.argumentExpression) : null;
      if (name !== null && TEXT_NAMES.has(name)) {
        report('L-CLASSIFY-TEXT', node, `"${name}" in a push-outcome classifier: outcomes come from observation, never text (glossary §26.2 item 2)`);
      }
    }
    // L-MIRROR: reading the mirror's ref names (.localCode / .remoteCode, ['…'] or a destructured binding).
    const mirror = ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) ? literalText(node.argumentExpression)
        : ts.isBindingElement(node) ? boundProperty(node) : null;
    if (mirror !== null && MIRROR_NAMES.has(mirror)) {
      report('L-MIRROR', node, `.${mirror}: the mirror is never a decision input, only a fetched value and a lease (PRO-13)`);
    }
    // L-PERMISSION: permissionDecision "allow" / "ask" (Plan 1's form, outside src/; in src/** Plan 5's widened form in p5rules.ts flags every
    // mention, whatever the value).
    if (!f.startsWith('src/') && (ts.isPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node))
      && propName(node.name) === 'permissionDecision') {
      const values: (ts.Node | undefined)[] = ts.isPropertyAssignment(node) ? [node.initializer]
        : ts.isPropertyDeclaration(node) ? [node.type, node.initializer] : [node.type];
      if (values.some((v) => v !== undefined && containsLiteral(v, PERMISSION_FORBIDDEN))) {
        report('L-PERMISSION', node, `permissionDecision "allow"/"ask" is forbidden (only "deny" is emitted)`);
      }
    }
    if (!f.startsWith('src/') && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = node.left;
      const target = ts.isPropertyAccessExpression(l) ? l.name.text
        : ts.isElementAccessExpression(l) ? literalText(l.argumentExpression) : null;
      if (target === 'permissionDecision' && containsLiteral(node.right, PERMISSION_FORBIDDEN)) {
        report('L-PERMISSION', node, `permissionDecision "allow"/"ask" is forbidden (only "deny" is emitted)`);
      }
    }
    // String literals and templates: L-REFS, L-MERGE-OPTS, L-GIT-ATOMIC (L-TOKEN: p5rules.ts).
    const lit = literalText(node);
    if (lit !== null) {
      if (lit.includes('refs/worktree/')) report('L-REFS', node, `refs/worktree/ is never used (common namespace only)`);
      if (lit === '--force') report('L-REFS', node, `--force is forbidden (use --force-with-lease)`);
      if (lit.startsWith('+') && lit.includes('refs/') && !insideFetchArgv(node)) {
        report('L-REFS', node, `"+" (forced) refspec is forbidden outside a fetch argv`);
      }
      if (lit.startsWith(':refs/') && !lit.startsWith(':refs/cowork/probe-') && !lit.startsWith(':refs/heads/cowork/probe-')) {
        report('L-REFS', node, `deletion refspec other than the probe ref`);
      }
      const tokens = lit.split(/\s+/);
      if (tokens.some((t) => t.startsWith('-X') || t.startsWith('--strategy-option'))
        || tokens.includes('--union') || lit.includes('merge=union')) {
        report('L-MERGE-OPTS', node, `-X / --strategy-option / --union / merge=union are forbidden (glossary §18)`);
      }
      if (tokens.includes('--atomic')) report('L-GIT-ATOMIC', node, `--atomic is never used (glossary §26.2 item 1)`);
      if (f.startsWith('src/')) {
        const held = holdStoreLiteral(lit, node, f);
        if (held !== null) report('L-HOLD-STORES', node, held);
      }
    }
    // L-HOLD-STORES (HLD-18): in src/holds/revert.ts a diff or merge-file call only inside revertDetector and taintOnlyH1.
    if (f === REVERT_FILE && !enclosingFunctions(node).some((n) => REVERT_FNS.has(n))) {
      const argv = ts.isArrayLiteralExpression(node) ? argvOf(node) : null;
      const sub = argv?.[0];
      if (sub === 'diff' || sub === 'merge-file') report('L-HOLD-STORES', node, `git ${sub} in ${REVERT_FILE} outside revertDetector and taintOnlyH1 (HLD-18)`);
      if (ts.isCallExpression(node) && calleeName(node.expression) === 'mergeFile') report('L-HOLD-STORES', node, `mergeFile in ${REVERT_FILE} outside revertDetector and taintOnlyH1 (HLD-18)`);
    }
    // Argv-shaped arrays: L-MERGE-BASE, L-MERGE-OPTS (merge-file), L-HASH-STDIN.
    if (ts.isArrayLiteralExpression(node)) {
      const argv = argvOf(node);
      if (argv !== null) {
        const sub = argv[0];
        const forbidden = forbiddenGit(argv);
        if (forbidden !== null) report('L-GIT-FORBIDDEN', node, forbidden);
        const objWrite = sub !== undefined && Object.hasOwn(OBJ_WRITE_FILES, sub) ? OBJ_WRITE_FILES[sub] : undefined;
        if (objWrite !== undefined && !objWrite.includes(f)) {
          report('L-OBJ-WRITE', node, `git ${sub} argv outside ${objWrite.join(', ')} (objects only for captures, publishes, applies and hold records)`);
        }
        if (sub === 'push') report('L-PUSH-ARGV', node, `git push argv outside src/git/push.ts (refspecs come only from pushSpec, ENG-09)`);
        if (sub === 'merge-base') report('L-MERGE-BASE', node, `git merge-base is forbidden (explicit bases only)`);
        if (sub === 'merge-tree' && !argv.some((a) => a === '--merge-base' || a.startsWith('--merge-base='))) {
          report('L-MERGE-BASE', node, `merge-tree without --merge-base`);
        }
        if (sub === 'merge-file' && !argv.includes('--object-id') && f !== MERGE_FILE_EXECUTOR) {
          report('L-MERGE-OPTS', node, `merge-file without --object-id`);
        }
        if (sub === 'hash-object' && argv.includes('--stdin') && !argv.includes('--no-filters')
          && !argv.some((a) => a === '--path' || a.startsWith('--path='))) {
          report('L-HASH-STDIN', node, `hash-object --stdin without --path`);
        }
      }
    }
    // Plan 4's six rules (appended below).
    regionRules(f, node, report);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  p5SourceRules(f, sf, report);
  return out;
}

/** The rules that also bind test code (test/**). The other rules guard daemon code only. Plan 5: L-TOKEN (R5-03, "test files included"). */
const TEST_RULES: ReadonlySet<string> = new Set(['L-PID-KILL', 'L-TOKEN']);
/** The rules that bind tooling code (tools/**): L-TOKEN (Plan 5 Task 2). */
const TOOL_RULES: ReadonlySet<string> = new Set(['L-TOKEN']);

/** Lints a test file: only the rules in TEST_RULES. */
export function lintTestSource(file: string, text: string): LintFinding[] {
  return lintSource(file, text).filter((f) => TEST_RULES.has(f.rule));
}

/** Lints a tooling file (tools/**, and a test/** script that is not TypeScript): only the rules in TOOL_RULES. */
export function lintToolSource(file: string, text: string): LintFinding[] {
  return lintSource(file, text).filter((f) => TOOL_RULES.has(f.rule));
}

export function lintCrashpoints(callSites: string[], catalogue: string[]): LintFinding[] {
  const known = new Set(catalogue);
  const out: LintFinding[] = [];
  for (const name of [...new Set(callSites)].sort()) {
    if (!known.has(name)) {
      out.push({ rule: 'L-CRASHPOINTS', file: 'test/crashpoints.json', line: 1, message: `crashpoint "${name}" is called but not in test/crashpoints.json` });
    }
  }
  return out;
}

// ---- Plan 4 (regions and claims): L-REGION-DEPS, L-REGION-WRITE, L-OFFSETS, L-UTF8-WRITE, L-ONE-MAPPER, L-CLAIMFREE-HOLDS ----
// Scopes (repo-relative, forward slashes): the module-load clauses read relative specifiers resolved against the file
// (`'../../git/repo.js'` from src/regions/worker/x.ts names src/git/repo); a type-only import counts like a value import
// (ruling PF-12) except for the one type-only import L-CLAIMFREE-HOLDS admits.

/** The repo-relative module (extension dropped) a relative specifier names from `file`; null for a package or built-in. */
function relativeTarget(file: string, spec: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  return posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.(?:[cm]?js|[cm]?ts)$/, '');
}

/** `dir/` itself or anything under it (`dir` given without its trailing slash). */
function under(target: string, dir: string): boolean {
  return target === dir || target.startsWith(`${dir}/`);
}

const WORKER_THREADS: ReadonlySet<string> = new Set(['worker_threads', 'node:worker_threads']);
/** R4-12: the two files that may import node:worker_threads. */
const WORKER_THREADS_FILES: ReadonlySet<string> = new Set(['src/regions/pool.ts', 'src/entry/worker.ts']);
/** REG-02, REG-35: GitRepo and Plan 2 writers the region and claim modules never call (object, tree, commit, ref and index writes). */
const REGION_WRITE_CALLS: ReadonlySet<string> = new Set([
  'writeTreeMap', 'editTree', 'mktree', 'commitTree', 'casRef', 'deleteLocalRef', 'editIndex', 'readTreeIntoIndex', 'writeTree', 'mergeTree',
]);
/** Object-hashing calls and the index of their `write` argument, which must be the literal `false`. */
const HASH_WRITE_ARG: ReadonlyMap<string, number> = new Map([['hashBytes', 1], ['hashRouteC', 2], ['hashRouteB', 3]]);
/** The read-only git subcommands a region or claim module may run (hash-object only without -w). */
const REGION_GIT_READS: ReadonlySet<string> = new Set(['grep', 'ls-tree', 'cat-file', 'check-attr', 'hash-object']);
/** R4-02: src/regions sits before these directories and imports none of them. */
const AFTER_REGIONS: readonly string[] = ['src/board', 'src/holds', 'src/claims', 'src/engine'];
/** L-OFFSETS: tree-sitter byte/UTF-16 offsets. */
const OFFSET_NAMES: ReadonlySet<string> = new Set(['startIndex', 'endIndex']);
const POSITION_NAMES: ReadonlySet<string> = new Set(['startPosition', 'endPosition']);
/** L-CLAIMFREE-HOLDS: the one type-only import src/holds/ports.ts may take from src/regions/editCheck.ts. */
const EDIT_CHECK_TYPES: ReadonlySet<string> = new Set(['EditCheckEntry', 'EditCheckReason']);

/** The last identifier of a call receiver (`this.deps.log` → log, `getLog()` → getLog), null when it has none. */
function lastIdentifier(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isCallExpression(e)) return lastIdentifier(e.expression);
  if (ts.isElementAccessExpression(e)) return literalText(e.argumentExpression);
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) return lastIdentifier(e.expression);
  return null;
}

/** A string literal or template (with or without substitutions). */
function isStringy(node: ts.Node | undefined): boolean {
  return node !== undefined && (literalText(node) !== null || ts.isTemplateExpression(node));
}

/** True when an import is the type-only `import type { EditCheckEntry | EditCheckReason … }` form. */
function isEditCheckTypeImport(node: ts.Node): boolean {
  if (!ts.isImportDeclaration(node) || node.importClause === undefined || !node.importClause.isTypeOnly) return false;
  const c = node.importClause;
  if (c.name !== undefined || c.namedBindings === undefined || !ts.isNamedImports(c.namedBindings)) return false;
  return c.namedBindings.elements.every((s) => EDIT_CHECK_TYPES.has((s.propertyName ?? s.name).text));
}

/** The six Plan 4 rules for one node of `f` (11-testing §3.10, 04 §3.2; the lint table of Plan 4's §Interfaces). */
function regionRules(f: string, node: ts.Node, report: (rule: string, node: ts.Node, message: string) => void): void {
  if (!f.startsWith('src/')) return;
  const inRegions = f.startsWith('src/regions/');
  const inClaims = f.startsWith('src/claims/');
  const inWorker = f.startsWith('src/regions/worker/');
  const regionOrClaim = inRegions || inClaims;

  const mod = loadedModule(node);
  if (mod !== null) {
    const target = relativeTarget(f, mod);
    // L-REGION-DEPS (R4-09, R4-12, 11 L-PORTS region row).
    if ((mod === 'web-tree-sitter' || mod.startsWith('web-tree-sitter/')) && !inWorker) {
      report('L-REGION-DEPS', node, `web-tree-sitter imported outside src/regions/worker/ (R4-09)`);
    }
    if (WORKER_THREADS.has(mod) && !WORKER_THREADS_FILES.has(f)) {
      report('L-REGION-DEPS', node, `node:worker_threads imported outside src/regions/pool.ts and src/entry/worker.ts (R4-12)`);
    }
    if (inWorker && (FS_MODULES.has(mod) || CHILD_PROCESS.has(mod)
      || (target !== null && (under(target, 'src/git') || target === 'src/ports/fs')))) {
      report('L-REGION-DEPS', node, `"${mod}" imported by a region worker module: workers take bytes, never files or git (R4-12)`);
    }
    if (target === 'src/regions/worker/inline') {
      report('L-REGION-DEPS', node, `inlineWorkers imported under src/: it binds unit tests and SIM only (R4-13)`);
    }
    // L-REGION-WRITE: the import direction (R4-02).
    if (inRegions && target !== null && AFTER_REGIONS.some((d) => under(target, d))) {
      report('L-REGION-WRITE', node, `src/regions imports "${mod}": regions never import src/board, src/holds, src/claims or src/engine (R4-02)`);
    }
    // L-ONE-MAPPER (R4-17): no region consumer reads Plan 2's linediff; since Task 5 the same holds for src/holds/mask.ts (R4-83).
    if (regionOrClaim || f === 'src/holds/mask.ts') {
      const namesMatchedRows = ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined
        && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.some((s) => (s.propertyName ?? s.name).text === 'matchedRows');
      if (target === 'src/data/linediff' || namesMatchedRows) {
        report('L-ONE-MAPPER', node, `src/data/linediff (matchedRows) in a region consumer: FoldMapper/1 is the one line mapper (REG-07)`);
      }
    }
    // L-CLAIMFREE-HOLDS (HLD-06).
    if (f.startsWith('src/holds/') && target !== null) {
      if (under(target, 'src/claims')) {
        report('L-CLAIMFREE-HOLDS', node, `src/holds imports "${mod}": holds read no claim state (HLD-06)`);
      } else if (under(target, 'src/regions')) {
        const admitted = (f === 'src/holds/mask.ts' && target === 'src/regions/mapper')
          || (f === 'src/holds/ports.ts' && target === 'src/regions/editCheck' && isEditCheckTypeImport(node));
        if (!admitted) {
          report('L-CLAIMFREE-HOLDS', node, `src/holds imports "${mod}": only mask.ts → regions/mapper and ports.ts' type-only editCheck import (HLD-06)`);
        }
      }
    }
  }

  // L-OFFSETS (REG-01, INV-REG-COORD): rows only; the one line-table helper is allowed (ALLOW).
  if (ts.isIdentifier(node) && OFFSET_NAMES.has(node.text)) {
    report('L-OFFSETS', node, `${node.text}: tree-sitter offsets only in src/regions/worker/lineTable.ts (REG-01)`);
  }
  if (ts.isElementAccessExpression(node)) {
    const key = literalText(node.argumentExpression);
    if (key !== null && OFFSET_NAMES.has(key)) report('L-OFFSETS', node, `${key}: tree-sitter offsets only in src/regions/worker/lineTable.ts (REG-01)`);
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'column' && ts.isPropertyAccessExpression(node.expression)
    && POSITION_NAMES.has(node.expression.name.text)) {
    report('L-OFFSETS', node, `${node.expression.name.text}.column: tree-sitter positions are read as rows only (REG-01)`);
  }

  if (!regionOrClaim) return;

  // L-UTF8-WRITE (04 §3.2 item 3; R4-83): text is decoded read-only and never encoded.
  if (ts.isIdentifier(node) && node.text === 'TextEncoder') {
    report('L-UTF8-WRITE', node, `TextEncoder in a region or claim module: text is never encoded (04 §3.2)`);
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const callee = node.expression;
    if (callee.name.text === 'from' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Buffer'
      && (isStringy(node.arguments[0]) || isStringy(node.arguments[1]))) {
      report('L-UTF8-WRITE', node, `Buffer.from(<string>) in a region or claim module: text is never encoded (04 §3.2)`);
    }
    if (callee.name.text === 'write' && isStringy(node.arguments[0])) {
      const receiver = lastIdentifier(callee.expression);
      if (receiver === null || (receiver !== 'log' && !receiver.endsWith('Log'))) {
        report('L-UTF8-WRITE', node, `.write(<string>) in a region or claim module: text is never encoded (04 §3.2; Log writes are exempt, R4-83)`);
      }
    }
  }

  if (ts.isCallExpression(node)) {
    const name = calleeName(node.expression);
    // L-REGION-WRITE (REG-02, REG-35, R4-40).
    if (name !== null && REGION_WRITE_CALLS.has(name)) {
      report('L-REGION-WRITE', node, `${name}() in a region or claim module: they write no object, tree, commit, ref or index entry (REG-02)`);
    }
    const writeArg = name === null ? undefined : HASH_WRITE_ARG.get(name);
    if (writeArg !== undefined && node.arguments[writeArg]?.kind !== ts.SyntaxKind.FalseKeyword) {
      report('L-REGION-WRITE', node, `${name}() without a literal false write argument in a region or claim module (REG-02)`);
    }
    if (name === 'mergeFile' && f !== 'src/claims/editCheckPort.ts') {
      report('L-REGION-WRITE', node, `mergeFile() outside src/claims/editCheckPort.ts (R4-40)`);
    }
    const arg0 = node.arguments[0];
    if (name === 'run' && arg0 !== undefined && ts.isArrayLiteralExpression(arg0)) {
      const argv = argvOf(arg0);
      const sub = argv?.[0];
      if (argv !== null && sub !== undefined && (!REGION_GIT_READS.has(sub) || (sub === 'hash-object' && argv.includes('-w')))) {
        report('L-REGION-WRITE', node, `git ${sub} in a region or claim module: only grep, ls-tree, cat-file, check-attr and hash-object without -w (REG-02)`);
      }
    }
  }
  // L-ONE-MAPPER: no git diff output feeds a region consumer (REG-07).
  if (ts.isArrayLiteralExpression(node)) {
    const argv = argvOf(node);
    const sub = argv?.[0];
    if (argv !== null && (sub === 'diff' || sub === 'diff-tree'
      || (sub === 'log' && argv.some((a) => a === '-p' || a === '-u' || a === '--patch')))) {
      report('L-ONE-MAPPER', node, `git ${sub} output in a region consumer: FoldMapper/1 is the one line mapper (REG-07)`);
    }
  }
}
