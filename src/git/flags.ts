import type { Buffer } from 'node:buffer';
import { isAbsolute, posix, win32 } from 'node:path';
import { FORCED_ENV, isNeverName } from './env.js';

export type GitClass = 'local' | 'network' | 'attr' | 'refupdate';

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitCallOptions {
  class: GitClass;
  cwd: string;
  /** Each gets -c filter.<d>.required=true; lfs is always added. */
  filterDrivers?: string[];
  /** -c attr.tree=<oid> (attribute-reading commands). */
  attrTree?: string;
  /** -c core.fsmonitor=true|false (default false). */
  fsmonitor?: boolean;
  /** Live/board commits: GIT_AUTHOR_NAME/EMAIL, GIT_COMMITTER_NAME/EMAIL and TZ=UTC0 so the offset is +0000. */
  identity?: GitIdentity;
  /** Test builds only: GIT_AUTHOR_DATE/GIT_COMMITTER_DATE. Ignored when base.testBuild is false. */
  wallMsForDates?: number;
  /** GIT_INDEX_FILE for private indexes. */
  indexFile?: string;
  /** When set, piped to git by the runner; otherwise stdin is ignored. Not used by this builder. */
  stdin?: Buffer;
  /** Never overrides FORCED_ENV. */
  extraEnv?: Record<string, string>;
  /** --git-dir=<abs>; a relative path throws before spawning (ENG-08). */
  gitDir?: string;
  /** --work-tree=<abs>; a relative path throws before spawning (ENG-08). */
  workTree?: string;
  /** Extra -c key=value pairs after the forced list; a key the builder forces throws. */
  config?: Readonly<Record<string, string>>;
  /** GIT_LITERAL_PATHSPECS=1: pathspec arguments are literal paths. */
  literalPathspecs?: boolean;
  /**
   * Ruling P2-ABORT: when it fires, the runner kills the process tree exactly like a watchdog kill and the call resolves
   * with GitResult.aborted = true (never for the never-killed ref-updating plumbing). Not part of the argv or env.
   */
  abort?: AbortSignal;
}

export interface GitInvocation {
  /** Arguments after the git executable. */
  argv: string[];
  /** The complete environment of the git process. */
  env: Record<string, string>;
}

export interface GitBase {
  hooksPath: string;
  platform: NodeJS.Platform;
  daemonEnv: Record<string, string>;
  testBuild: boolean;
  /**
   * The user's core.sshCommand, resolved once by the caller (start path) with `git config --get core.sshCommand`.
   * Effective ssh command precedence (09-security §2): daemonEnv.GIT_SSH_COMMAND > sshCommand > GIT_SSH (+variant) > 'ssh'.
   * '' or whitespace means not configured.
   */
  sshCommand?: string;
}

/**
 * First argv elements of every git call (Plan 1 ledger carry): refs/replace/* never changes what a
 * cowork git call reads. Placed before --git-dir, --work-tree and every -c.
 */
export const GLOBAL_PREFIX: readonly string[] = Object.freeze(['--no-replace-objects']);

/**
 * Ruling P2-GRAFTS: `.git/info/grafts` is honoured even under --no-replace-objects and would give this peer other
 * first-parent chains than its teammates. Every git call reads grafts from this file under the (absolute, empty)
 * hooks directory instead, which never exists; GIT_GRAFT_FILE is on the never-list, so nothing else can set it.
 * Joined with '/' on every platform (git accepts it on Windows), so the environment does not depend on the host OS.
 */
function noGraftsFile(hooksPath: string): string {
  return `${hooksPath}/.no-grafts`;
}

/** Glossary §18: on every merge-tree / merge-file; never -X options. */
export const MERGE_FLAGS: readonly string[] = Object.freeze([
  '-c', 'merge.renormalize=false',
  '-c', 'merge.renames=true',
  '-c', 'merge.directoryRenames=false',
]);

/** Glossary §18 / 09-security §2: commands that get --no-ext-diff --no-textconv. */
export const DIFF_FAMILY: ReadonlySet<string> = new Set(['diff', 'diff-tree', 'diff-index', 'diff-files', 'log', 'show', 'blame']);

const CLASSES: ReadonlySet<string> = new Set(['local', 'network', 'attr', 'refupdate']);
const MERGE_COMMANDS: ReadonlySet<string> = new Set(['merge-tree', 'merge-file']);
const DIFF_FLAGS: readonly string[] = ['--no-ext-diff', '--no-textconv'];
const FETCH_FLAGS: readonly string[] = ['--no-write-fetch-head', '--no-auto-maintenance', '--no-tags', '--no-recurse-submodules'];
const SSH_BATCH_OPTIONS = '-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3';
const PLINK_BATCH_OPTION = '-batch';
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FORCED_UPPER: ReadonlySet<string> = new Set(Object.keys(FORCED_ENV).map((k) => k.toUpperCase()));

function fail(message: string): never {
  throw new Error(`buildGitInvocation: ${message}`);
}

function checkConfigValue(what: string, value: string): void {
  if (value.length === 0 || /[\0\r\n]/.test(value)) fail(`invalid ${what} ${JSON.stringify(value)}`);
}

const FORCED_KEYS: ReadonlySet<string> = new Set([
  'core.hookspath', 'core.fsmonitor', 'core.quotepath', 'core.safecrlf', 'core.splitindex', 'commit.gpgsign', 'tag.gpgsign', 'gc.auto', 'maintenance.auto',
  'fetch.fsckobjects', 'transfer.fsckobjects', 'protocol.ext.allow', 'core.askpass', 'submodule.recurse', 'core.longpaths',
  'attr.tree', 'core.logallrefupdates', 'core.fsync', 'core.fsyncmethod', 'http.lowspeedlimit', 'http.lowspeedtime',
  'i18n.commitencoding', 'i18n.logoutputencoding', 'push.pushoption', 'push.gpgsign', 'push.followtags', 'push.recursesubmodules',
  ...MERGE_FLAGS.filter((_, i) => i % 2 === 1).map((kv) => kv.slice(0, kv.indexOf('=')).toLowerCase()),
]);

/** A key the builder sets itself (any class), including every filter.<driver>.required. */
function isForcedKey(key: string): boolean {
  const k = key.toLowerCase();
  return FORCED_KEYS.has(k) || (k.startsWith('filter.') && k.endsWith('.required'));
}

function checkAbsolute(what: string, value: string): void {
  checkConfigValue(what, value);
  if (!isAbsolute(value)) fail(`${what} must be absolute, got ${JSON.stringify(value)}`);
}

function checkDriverName(d: string): void {
  // -c splits at the first '=', so a driver name may not contain one.
  if (d.length === 0 || /[=\s\0]/.test(d)) fail(`invalid filter driver name ${JSON.stringify(d)}`);
}

function checkIdentField(what: string, value: string): void {
  if (value.trim().length === 0 || /[\0\r\n<>]/.test(value)) fail(`invalid identity ${what} ${JSON.stringify(value)}`);
}

/** Sets name=value after removing every other case variant of name. */
function setEnv(env: Record<string, string>, name: string, value: string): void {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k !== name && k.toUpperCase() === upper) delete env[k];
  }
  env[name] = value;
}

/** Removes every case variant of name whose value is empty or whitespace only. */
function dropBlank(env: Record<string, string>, name: string): void {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper && (env[k] ?? '').trim() === '') delete env[k];
  }
}

function getEnv(env: Record<string, string>, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper) return env[k];
  }
  return undefined;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** First word of a shell command line, honouring single and double quotes. */
function firstWord(cmd: string): string {
  let i = 0;
  while (i < cmd.length && /\s/.test(cmd.charAt(i))) i++;
  let word = '';
  let quote = '';
  for (; i < cmd.length; i++) {
    const ch = cmd.charAt(i);
    if (quote !== '') {
      if (ch === quote) quote = '';
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) break;
    word += ch;
  }
  return word;
}

function programBase(program: string): string {
  const parts = program.split(/[\\/]/);
  return (parts[parts.length - 1] ?? '').toLowerCase().replace(/\.exe$/, '');
}

type SshVariant = 'ssh' | 'plink' | 'simple' | 'unknown';

function sshVariant(setting: string | undefined, program: string): SshVariant {
  const v = (setting ?? '').trim().toLowerCase();
  if (v === 'ssh') return 'ssh';
  if (v === 'plink' || v === 'putty' || v === 'tortoiseplink') return 'plink';
  if (v === 'simple') return 'simple';
  const b = programBase(program);
  if (b === 'ssh') return 'ssh';
  if (b === 'plink' || b === 'tortoiseplink') return 'plink';
  return 'unknown';
}

function isSet(v: string | undefined): v is string {
  return v !== undefined && v.trim() !== '';
}

/**
 * 09-security §2 / §3.4 item 5: the effective ssh command is the first that is set of
 * GIT_SSH_COMMAND (env), core.sshCommand (configCommand), GIT_SSH (+ GIT_SSH_VARIANT), 'ssh';
 * the glossary §18 BatchMode options are appended to it (-batch for plink variants), never
 * replacing it. Returns null when nothing is appended (simple or unrecognised program): the env
 * is then left without a GIT_SSH_COMMAND of ours, git resolves the user's command itself and the
 * watchdog bounds the call.
 */
function batchSshCommand(env: Record<string, string>, configCommand: string | undefined): string | null {
  const command = getEnv(env, 'GIT_SSH_COMMAND');
  const program = getEnv(env, 'GIT_SSH');
  let line: string;
  let prog: string;
  if (isSet(command)) {
    line = command.replace(/\s+$/, '');
    prog = firstWord(command);
  } else if (isSet(configCommand)) {
    line = configCommand.replace(/\s+$/, '');
    prog = firstWord(configCommand);
  } else if (isSet(program)) {
    line = shQuote(program);
    prog = program;
  } else {
    line = 'ssh';
    prog = 'ssh';
  }
  const variant = sshVariant(getEnv(env, 'GIT_SSH_VARIANT'), prog);
  if (variant === 'ssh') return `${line} ${SSH_BATCH_OPTIONS}`;
  if (variant === 'plink') return `${line} ${PLINK_BATCH_OPTION}`;
  return null;
}

function buildEnv(opts: GitCallOptions, base: GitBase): Record<string, string> {
  // The never-list holds even when daemonEnv was not built by buildDaemonEnv (09-security §3.4 item 4);
  // runner-owned names below (GIT_INDEX_FILE, GIT_AUTHOR_*, ...) are set after this filter.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base.daemonEnv)) {
    if (!isNeverName(name)) env[name] = value;
  }
  if (opts.extraEnv !== undefined) {
    for (const name of Object.keys(opts.extraEnv).sort()) {
      const value = opts.extraEnv[name];
      if (value === undefined || FORCED_UPPER.has(name.toUpperCase()) || isNeverName(name)) continue;
      setEnv(env, name, value);
    }
  }
  if (opts.indexFile !== undefined) {
    checkAbsolute('indexFile', opts.indexFile);
    setEnv(env, 'GIT_INDEX_FILE', opts.indexFile);
  }
  if (opts.literalPathspecs === true) setEnv(env, 'GIT_LITERAL_PATHSPECS', '1');
  setEnv(env, 'GIT_GRAFT_FILE', noGraftsFile(base.hooksPath));
  if (opts.identity !== undefined) {
    checkIdentField('name', opts.identity.name);
    checkIdentField('email', opts.identity.email);
    setEnv(env, 'GIT_AUTHOR_NAME', opts.identity.name);
    setEnv(env, 'GIT_AUTHOR_EMAIL', opts.identity.email);
    setEnv(env, 'GIT_COMMITTER_NAME', opts.identity.name);
    setEnv(env, 'GIT_COMMITTER_EMAIL', opts.identity.email);
    // SEC-03: +0000 on every live/board commit without setting dates in release builds.
    setEnv(env, 'TZ', 'UTC0');
  }
  if (base.testBuild && opts.wallMsForDates !== undefined) {
    const ms = opts.wallMsForDates;
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`buildGitInvocation: invalid wallMsForDates ${String(ms)}`);
    }
    const date = `@${Math.floor(ms / 1000)} +0000`;
    setEnv(env, 'GIT_AUTHOR_DATE', date);
    setEnv(env, 'GIT_COMMITTER_DATE', date);
  }
  if (opts.class === 'network') {
    // A blank GIT_SSH_COMMAND/GIT_SSH is "unset" (09 §2); git would run it as an empty command instead.
    dropBlank(env, 'GIT_SSH_COMMAND');
    dropBlank(env, 'GIT_SSH');
    const ssh = batchSshCommand(env, base.sshCommand);
    if (ssh !== null) setEnv(env, 'GIT_SSH_COMMAND', ssh);
  }
  for (const [name, value] of Object.entries(FORCED_ENV)) setEnv(env, name, value);
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(env).sort()) {
    const v = env[k];
    if (v !== undefined) sorted[k] = v;
  }
  return sorted;
}

/**
 * Glossary §18: the argv (after the git executable) and the complete environment for one git call.
 * args[0] must be the subcommand; every -c override is placed before it.
 */
export function buildGitInvocation(args: string[], opts: GitCallOptions, base: GitBase): GitInvocation {
  const sub = args[0];
  if (sub === undefined || sub.length === 0 || sub.startsWith('-')) {
    fail(`args[0] must be a git subcommand, got ${JSON.stringify(sub)}`);
  }
  if (!CLASSES.has(opts.class)) fail(`unknown class ${JSON.stringify(opts.class)}`);
  checkConfigValue('hooksPath', base.hooksPath);
  // Absolute for base.platform (not the host), so a relative GIT_GRAFT_FILE can never name a file in the work tree.
  if (!(base.platform === 'win32' ? win32 : posix).isAbsolute(base.hooksPath)) fail(`hooksPath must be absolute, got ${JSON.stringify(base.hooksPath)}`);
  if (base.sshCommand !== undefined && /[\0\r\n]/.test(base.sshCommand)) {
    fail(`invalid sshCommand ${JSON.stringify(base.sshCommand)}`);
  }

  if (opts.gitDir !== undefined) checkAbsolute('gitDir', opts.gitDir);
  if (opts.workTree !== undefined) checkAbsolute('workTree', opts.workTree);

  const pre: string[] = [...GLOBAL_PREFIX];
  if (opts.gitDir !== undefined) pre.push(`--git-dir=${opts.gitDir}`);
  if (opts.workTree !== undefined) pre.push(`--work-tree=${opts.workTree}`);
  const c = (kv: string): void => {
    pre.push('-c', kv);
  };
  c(`core.hooksPath=${base.hooksPath}`);
  c(`core.fsmonitor=${opts.fsmonitor === true ? 'true' : 'false'}`);
  c('core.quotepath=off');
  // Ruling P2-SAFECRLF: a user's core.safecrlf=true makes hash-object -w / add die (rc 128) on a CRLF<->LF
  // conversion, which route (b) would read as a filter failure; canon's tripwire is the guard instead.
  c('core.safecrlf=false');
  // Ruling P2-SPLITINDEX: a user's core.splitIndex=true would make every private- and scratch-index call write
  // sharedindex.* files into the user's gitdir.
  c('core.splitIndex=false');
  c('commit.gpgSign=false');
  c('tag.gpgSign=false');
  c('gc.auto=0');
  c('maintenance.auto=false');
  c('fetch.fsckObjects=true');
  c('transfer.fsckObjects=true');
  c('protocol.ext.allow=never');
  c('core.askPass=');
  c('submodule.recurse=false');
  // A user's i18n.commitEncoding would put an `encoding` header on every board and live commit, which other
  // peers then read differently; i18n.logOutputEncoding would re-encode what log and rev-list print and grep.
  c('i18n.commitEncoding=UTF-8');
  c('i18n.logOutputEncoding=UTF-8');
  if (base.platform === 'win32') c('core.longpaths=true');

  const drivers = new Set<string>(['lfs']);
  for (const d of opts.filterDrivers ?? []) {
    checkDriverName(d);
    drivers.add(d);
  }
  for (const d of [...drivers].sort()) c(`filter.${d}.required=true`);

  if (opts.attrTree !== undefined) {
    if (!OID.test(opts.attrTree)) fail(`attrTree must be a 40- or 64-hex oid, got ${JSON.stringify(opts.attrTree)}`);
    c(`attr.tree=${opts.attrTree}`);
  }
  if (opts.class === 'refupdate') {
    c('core.logAllRefUpdates=always');
    c('core.fsync=committed,reference,index');
    c('core.fsyncMethod=batch');
  } else if (sub === 'fetch') {
    // ENG-02: a fetch updates refs/cowork-remote/*, which get reflogs only under `always` (git's default `true`
    // covers refs/heads, refs/remotes and refs/notes only). The key is forced, so `config` cannot carry it.
    c('core.logAllRefUpdates=always');
  }
  if (sub === 'push') {
    // Ruling P2-PUSHCFG: the user's push.* config never reaches a cowork push. A configured push.pushOption (which
    // a host without push options refuses) or push.gpgSign=true (no key, no push-cert support) would stop every
    // publish for good, and push.followTags=true would write the user's tags to the remote. An empty
    // push.pushOption clears the configured list; an explicit -o still wins. push.recurseSubmodules=check would
    // refuse every publish whose live tree holds a gitlink commit missing on the submodule's remote, and on-demand
    // would push the user's submodules: forced to no. (The forced submodule.recurse=false happens to override it
    // today, because push reads whichever of the two keys comes last and -c comes last; git's documentation says
    // push.recurseSubmodules wins when set, so the key is forced on its own.)
    c('push.pushOption=');
    c('push.gpgSign=false');
    c('push.followTags=false');
    c('push.recurseSubmodules=no');
  }
  if (opts.class === 'network') {
    c('http.lowSpeedLimit=1000');
    c('http.lowSpeedTime=10');
  }
  if (opts.config !== undefined) {
    for (const key of Object.keys(opts.config).sort()) {
      const value = opts.config[key] as string;
      if (key.length === 0 || /[=\s\0]/.test(key) || !key.includes('.')) fail(`invalid config key ${JSON.stringify(key)}`);
      if (/[\0\r\n]/.test(value)) fail(`invalid config value for ${key}`);
      if (isForcedKey(key)) fail(`config key ${JSON.stringify(key)} is forced by the runner`);
      pre.push('-c', `${key}=${value}`);
    }
  }
  if (MERGE_COMMANDS.has(sub)) pre.push(...MERGE_FLAGS);

  const post: string[] = [];
  if (DIFF_FAMILY.has(sub)) post.push(...DIFF_FLAGS);
  if (sub === 'fetch') post.push(...FETCH_FLAGS);

  return {
    argv: [...pre, sub, ...post, ...args.slice(1)],
    env: buildEnv(opts, base),
  };
}
