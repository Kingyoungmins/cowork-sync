import ts from 'typescript';

export interface LintFinding { rule: string; file: string; line: number; message: string; }

// Files allowed to do what a rule otherwise forbids (repo-relative, forward slashes).
const ALLOW: Readonly<Record<string, readonly string[]>> = {
  'L-GIT-SPAWN': ['src/git/runner.ts'],
  // src/cli/launch.ts: cowork start spawns the daemon in the background (v0.1.0-preview); it never spawns git.
  'L-PORTS': ['src/git/runner.ts', 'src/cli/launch.ts'],
  'L-CLOCK': ['src/ports/clock.ts'],
  'L-RANDOM': ['src/ports/random.ts'],
  'L-CRASHPOINTS': ['src/ports/crashpoint.ts'],
  // Empty in Plan 1. The IPC endpoint module (the only permitted `net` user, 11-testing §3.10
  // "net (outside IPC)") is added here by the plan that writes it.
  'L-NET': [],
  'L-TOKEN': ['src/entry/mcp.ts'],
  'L-FS-PORT': ['src/ports/fs.ts'],
  // ENG-09, ENG-58: every push argv is built in push.ts (pushSpec, buildPushArgv, deleteProbeRef).
  'L-PUSH-ARGV': ['src/git/push.ts'],
  // PRO-13, INV-ENG-AUTH: the mirror is only a fetched value and a lease (genesis mirror push ENG-51, recover ENG-22 step 5).
  'L-MIRROR': ['src/engine/refs.ts', 'src/engine/fetcher.ts', 'src/engine/publish.ts', 'src/engine/start.ts', 'src/engine/recover.ts'],
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
const MESSAGING_TOKEN = 'CLAUDE_CODE_MESSAGING_TOKEN';

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
function literalText(node: ts.Node): string | null {
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
function loadedModule(node: ts.Node): string | null {
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
    // L-TOKEN: the messaging token as an identifier (process.env.X, destructured or object key).
    if (ts.isIdentifier(node) && node.text === MESSAGING_TOKEN) {
      report('L-TOKEN', node, `${MESSAGING_TOKEN} referenced outside src/entry/mcp.ts`);
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
    // L-PERMISSION: permissionDecision "allow" / "ask".
    if ((ts.isPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node))
      && propName(node.name) === 'permissionDecision') {
      const values: (ts.Node | undefined)[] = ts.isPropertyAssignment(node) ? [node.initializer]
        : ts.isPropertyDeclaration(node) ? [node.type, node.initializer] : [node.type];
      if (values.some((v) => v !== undefined && containsLiteral(v, PERMISSION_FORBIDDEN))) {
        report('L-PERMISSION', node, `permissionDecision "allow"/"ask" is forbidden (only "deny" is emitted)`);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = node.left;
      const target = ts.isPropertyAccessExpression(l) ? l.name.text
        : ts.isElementAccessExpression(l) ? literalText(l.argumentExpression) : null;
      if (target === 'permissionDecision' && containsLiteral(node.right, PERMISSION_FORBIDDEN)) {
        report('L-PERMISSION', node, `permissionDecision "allow"/"ask" is forbidden (only "deny" is emitted)`);
      }
    }
    // String literals and templates: L-REFS, L-MERGE-OPTS, L-TOKEN, L-GIT-ATOMIC.
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
      if (lit.includes(MESSAGING_TOKEN)) report('L-TOKEN', node, `${MESSAGING_TOKEN} referenced outside src/entry/mcp.ts`);
      if (tokens.includes('--atomic')) report('L-GIT-ATOMIC', node, `--atomic is never used (glossary §26.2 item 1)`);
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
        if (sub === 'merge-file' && !argv.includes('--object-id')) {
          report('L-MERGE-OPTS', node, `merge-file without --object-id`);
        }
        if (sub === 'hash-object' && argv.includes('--stdin') && !argv.includes('--no-filters')
          && !argv.some((a) => a === '--path' || a.startsWith('--path='))) {
          report('L-HASH-STDIN', node, `hash-object --stdin without --path`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The rules that also bind test code (test/**). The other rules guard daemon code only. */
const TEST_RULES: ReadonlySet<string> = new Set(['L-PID-KILL']);

/** Lints a test file: only the rules in TEST_RULES. */
export function lintTestSource(file: string, text: string): LintFinding[] {
  return lintSource(file, text).filter((f) => TEST_RULES.has(f.rule));
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
