// src/cli/realEnv.ts
import { dirname, join as join4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/engine/daemonFiles.ts
import { join } from "node:path";

// src/ports/clock.ts
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
var realClock = {
  monoMs: () => performance.now(),
  wallMs: () => Date.now(),
  sleep: async (ms) => {
    await delay(Math.max(0, ms));
  }
};
function machineMonoMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1e3;
}

// src/engine/daemonFiles.ts
var DAEMON_LOCK_FILE = "daemon.lock";
var STATUS_FILE = "status.json";
var STOP_REQUEST_FILE = "stop-request";
var DAEMON_LOG_FILE = join("log", "daemon-0.jsonl");
function parseLockHolder(buf) {
  try {
    const v = JSON.parse(buf.toString("utf8"));
    const pid = v["pid"];
    const started = v["started"];
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && typeof v["plugin_version"] === "string" && typeof v["instance"] === "string") {
      return { pid, plugin_version: v["plugin_version"], instance: v["instance"], started: typeof started === "number" && Number.isFinite(started) ? started : null };
    }
  } catch {
  }
  return null;
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return typeof e === "object" && e !== null && e.code === "EPERM";
  }
}
function holderLive(h, alive = processAlive, nowMachineMono = machineMonoMs()) {
  if (h.started !== null && h.started > nowMachineMono) return false;
  return alive(h.pid);
}

// src/git/env.ts
var FORCED_ENV = Object.freeze({
  LC_ALL: "C",
  LANGUAGE: "",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  SSH_ASKPASS_REQUIRE: "never",
  GIT_OPTIONAL_LOCKS: "0"
});
var BASE_ALLOW_NAMES = ["PATH", "SYSTEMROOT", "COMSPEC", "USERPROFILE", "HOME", "TEMP", "TMP", "TMPDIR", "LANG"];
var BASE_ALLOW_PREFIXES = ["LC_"];
var TRANSPORT_ALLOW_NAMES = [
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "HOMEDRIVE",
  "HOMEPATH",
  "PATHEXT",
  "WINDIR",
  "SYSTEMDRIVE",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_SSH_VARIANT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM"
];
var TRANSPORT_ALLOW_PREFIXES = ["XDG_", "GCM_"];
var NEVER_NAMES = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "SSH_ASKPASS",
  "GIT_ASKPASS",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_EDITOR",
  "GIT_ATTR_SOURCE",
  "GIT_REPLACE_REF_BASE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_SHALLOW_FILE",
  "GIT_CONFIG",
  // Ruling P2-GRAFTS: buildGitInvocation sets its own GIT_GRAFT_FILE (a path that never exists).
  "GIT_GRAFT_FILE"
];
var NEVER_PREFIXES = [
  "CLAUDE_",
  "ELECTRON_",
  "VSCODE_",
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
  "GIT_TRACE",
  "GIT_AUTHOR_",
  "GIT_COMMITTER_"
];
var ALLOW_NAMES = /* @__PURE__ */ new Set([...BASE_ALLOW_NAMES, ...TRANSPORT_ALLOW_NAMES]);
var ALLOW_PREFIXES = [...BASE_ALLOW_PREFIXES, ...TRANSPORT_ALLOW_PREFIXES];
var NEVER = new Set(NEVER_NAMES);
var FORCED_UPPER = new Set(Object.keys(FORCED_ENV).map((k) => k.toUpperCase()));
function isNever(upper) {
  return NEVER.has(upper) || NEVER_PREFIXES.some((p) => upper.startsWith(p));
}
function isNeverName(name) {
  return isNever(name.toUpperCase());
}
function isAllowlisted(upper) {
  return ALLOW_NAMES.has(upper) || ALLOW_PREFIXES.some((p) => upper.startsWith(p));
}
function isUsableName(name) {
  return name.length > 0 && !name.includes("=") && !name.includes("\0");
}
function sortedCopy(env) {
  const out = {};
  for (const k of Object.keys(env).sort()) {
    const v = env[k];
    if (v !== void 0) out[k] = v;
  }
  return out;
}
function buildDaemonEnv(source, passthrough) {
  const passUpper = new Set(passthrough.map((n) => n.toUpperCase()));
  const out = {};
  for (const name of Object.keys(source)) {
    const value2 = source[name];
    if (value2 === void 0 || value2.includes("\0") || !isUsableName(name)) continue;
    const upper = name.toUpperCase();
    if (isNever(upper) || FORCED_UPPER.has(upper)) continue;
    if (!isAllowlisted(upper) && !passUpper.has(upper)) continue;
    out[name] = value2;
  }
  for (const [name, value2] of Object.entries(FORCED_ENV)) out[name] = value2;
  return sortedCopy(out);
}

// src/git/runner.ts
import { spawn, spawnSync } from "node:child_process";
import { win32 as win322 } from "node:path";

// src/git/flags.ts
import { isAbsolute, posix, win32 } from "node:path";
var GLOBAL_PREFIX = Object.freeze(["--no-replace-objects"]);
function noGraftsFile(hooksPath) {
  return `${hooksPath}/.no-grafts`;
}
var MERGE_FLAGS = Object.freeze([
  "-c",
  "merge.renormalize=false",
  "-c",
  "merge.renames=true",
  "-c",
  "merge.directoryRenames=false"
]);
var DIFF_FAMILY = /* @__PURE__ */ new Set(["diff", "diff-tree", "diff-index", "diff-files", "log", "show", "blame"]);
var CLASSES = /* @__PURE__ */ new Set(["local", "network", "attr", "refupdate"]);
var MERGE_COMMANDS = /* @__PURE__ */ new Set(["merge-tree", "merge-file"]);
var DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"];
var FETCH_FLAGS = ["--no-write-fetch-head", "--no-auto-maintenance", "--no-tags", "--no-recurse-submodules"];
var SSH_BATCH_OPTIONS = "-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3";
var PLINK_BATCH_OPTION = "-batch";
var OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var FORCED_UPPER2 = new Set(Object.keys(FORCED_ENV).map((k) => k.toUpperCase()));
function fail(message) {
  throw new Error(`buildGitInvocation: ${message}`);
}
function checkConfigValue(what, value2) {
  if (value2.length === 0 || /[\0\r\n]/.test(value2)) fail(`invalid ${what} ${JSON.stringify(value2)}`);
}
var FORCED_KEYS = /* @__PURE__ */ new Set([
  "core.hookspath",
  "core.fsmonitor",
  "core.quotepath",
  "core.safecrlf",
  "core.splitindex",
  "commit.gpgsign",
  "tag.gpgsign",
  "gc.auto",
  "maintenance.auto",
  "fetch.fsckobjects",
  "transfer.fsckobjects",
  "protocol.ext.allow",
  "core.askpass",
  "submodule.recurse",
  "core.longpaths",
  "attr.tree",
  "core.logallrefupdates",
  "core.fsync",
  "core.fsyncmethod",
  "http.lowspeedlimit",
  "http.lowspeedtime",
  "i18n.commitencoding",
  "i18n.logoutputencoding",
  "push.pushoption",
  "push.gpgsign",
  "push.followtags",
  "push.recursesubmodules",
  ...MERGE_FLAGS.filter((_, i) => i % 2 === 1).map((kv) => kv.slice(0, kv.indexOf("=")).toLowerCase())
]);
function isForcedKey(key) {
  const k = key.toLowerCase();
  return FORCED_KEYS.has(k) || k.startsWith("filter.") && k.endsWith(".required");
}
function checkAbsolute(what, value2) {
  checkConfigValue(what, value2);
  if (!isAbsolute(value2)) fail(`${what} must be absolute, got ${JSON.stringify(value2)}`);
}
function checkDriverName(d) {
  if (d.length === 0 || /[=\s\0]/.test(d)) fail(`invalid filter driver name ${JSON.stringify(d)}`);
}
function checkIdentField(what, value2) {
  if (value2.trim().length === 0 || /[\0\r\n<>]/.test(value2)) fail(`invalid identity ${what} ${JSON.stringify(value2)}`);
}
function setEnv(env, name, value2) {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k !== name && k.toUpperCase() === upper) delete env[k];
  }
  env[name] = value2;
}
function dropBlank(env, name) {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper && (env[k] ?? "").trim() === "") delete env[k];
  }
}
function getEnv(env, name) {
  const exact = env[name];
  if (exact !== void 0) return exact;
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper) return env[k];
  }
  return void 0;
}
function shQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function firstWord(cmd) {
  let i = 0;
  while (i < cmd.length && /\s/.test(cmd.charAt(i))) i++;
  let word = "";
  let quote = "";
  for (; i < cmd.length; i++) {
    const ch = cmd.charAt(i);
    if (quote !== "") {
      if (ch === quote) quote = "";
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
function programBase(program) {
  const parts = program.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase().replace(/\.exe$/, "");
}
function sshVariant(setting, program) {
  const v = (setting ?? "").trim().toLowerCase();
  if (v === "ssh") return "ssh";
  if (v === "plink" || v === "putty" || v === "tortoiseplink") return "plink";
  if (v === "simple") return "simple";
  const b = programBase(program);
  if (b === "ssh") return "ssh";
  if (b === "plink" || b === "tortoiseplink") return "plink";
  return "unknown";
}
function isSet(v) {
  return v !== void 0 && v.trim() !== "";
}
function batchSshCommand(env, configCommand) {
  const command = getEnv(env, "GIT_SSH_COMMAND");
  const program = getEnv(env, "GIT_SSH");
  let line;
  let prog;
  if (isSet(command)) {
    line = command.replace(/\s+$/, "");
    prog = firstWord(command);
  } else if (isSet(configCommand)) {
    line = configCommand.replace(/\s+$/, "");
    prog = firstWord(configCommand);
  } else if (isSet(program)) {
    line = shQuote(program);
    prog = program;
  } else {
    line = "ssh";
    prog = "ssh";
  }
  const variant = sshVariant(getEnv(env, "GIT_SSH_VARIANT"), prog);
  if (variant === "ssh") return `${line} ${SSH_BATCH_OPTIONS}`;
  if (variant === "plink") return `${line} ${PLINK_BATCH_OPTION}`;
  return null;
}
function buildEnv(opts, base) {
  const env = {};
  for (const [name, value2] of Object.entries(base.daemonEnv)) {
    if (!isNeverName(name)) env[name] = value2;
  }
  if (opts.extraEnv !== void 0) {
    for (const name of Object.keys(opts.extraEnv).sort()) {
      const value2 = opts.extraEnv[name];
      if (value2 === void 0 || FORCED_UPPER2.has(name.toUpperCase()) || isNeverName(name)) continue;
      setEnv(env, name, value2);
    }
  }
  if (opts.indexFile !== void 0) {
    checkAbsolute("indexFile", opts.indexFile);
    setEnv(env, "GIT_INDEX_FILE", opts.indexFile);
  }
  if (opts.literalPathspecs === true) setEnv(env, "GIT_LITERAL_PATHSPECS", "1");
  setEnv(env, "GIT_GRAFT_FILE", noGraftsFile(base.hooksPath));
  if (opts.identity !== void 0) {
    checkIdentField("name", opts.identity.name);
    checkIdentField("email", opts.identity.email);
    setEnv(env, "GIT_AUTHOR_NAME", opts.identity.name);
    setEnv(env, "GIT_AUTHOR_EMAIL", opts.identity.email);
    setEnv(env, "GIT_COMMITTER_NAME", opts.identity.name);
    setEnv(env, "GIT_COMMITTER_EMAIL", opts.identity.email);
    setEnv(env, "TZ", "UTC0");
  }
  if (base.testBuild && opts.wallMsForDates !== void 0) {
    const ms = opts.wallMsForDates;
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`buildGitInvocation: invalid wallMsForDates ${String(ms)}`);
    }
    const date = `@${Math.floor(ms / 1e3)} +0000`;
    setEnv(env, "GIT_AUTHOR_DATE", date);
    setEnv(env, "GIT_COMMITTER_DATE", date);
  }
  if (opts.class === "network") {
    dropBlank(env, "GIT_SSH_COMMAND");
    dropBlank(env, "GIT_SSH");
    const ssh = batchSshCommand(env, base.sshCommand);
    if (ssh !== null) setEnv(env, "GIT_SSH_COMMAND", ssh);
  }
  for (const [name, value2] of Object.entries(FORCED_ENV)) setEnv(env, name, value2);
  const sorted = {};
  for (const k of Object.keys(env).sort()) {
    const v = env[k];
    if (v !== void 0) sorted[k] = v;
  }
  return sorted;
}
function buildGitInvocation(args, opts, base) {
  const sub = args[0];
  if (sub === void 0 || sub.length === 0 || sub.startsWith("-")) {
    fail(`args[0] must be a git subcommand, got ${JSON.stringify(sub)}`);
  }
  if (!CLASSES.has(opts.class)) fail(`unknown class ${JSON.stringify(opts.class)}`);
  checkConfigValue("hooksPath", base.hooksPath);
  if (!(base.platform === "win32" ? win32 : posix).isAbsolute(base.hooksPath)) fail(`hooksPath must be absolute, got ${JSON.stringify(base.hooksPath)}`);
  if (base.sshCommand !== void 0 && /[\0\r\n]/.test(base.sshCommand)) {
    fail(`invalid sshCommand ${JSON.stringify(base.sshCommand)}`);
  }
  if (opts.gitDir !== void 0) checkAbsolute("gitDir", opts.gitDir);
  if (opts.workTree !== void 0) checkAbsolute("workTree", opts.workTree);
  const pre = [...GLOBAL_PREFIX];
  if (opts.gitDir !== void 0) pre.push(`--git-dir=${opts.gitDir}`);
  if (opts.workTree !== void 0) pre.push(`--work-tree=${opts.workTree}`);
  const c = (kv) => {
    pre.push("-c", kv);
  };
  c(`core.hooksPath=${base.hooksPath}`);
  c(`core.fsmonitor=${opts.fsmonitor === true ? "true" : "false"}`);
  c("core.quotepath=off");
  c("core.safecrlf=false");
  c("core.splitIndex=false");
  c("commit.gpgSign=false");
  c("tag.gpgSign=false");
  c("gc.auto=0");
  c("maintenance.auto=false");
  c("fetch.fsckObjects=true");
  c("transfer.fsckObjects=true");
  c("protocol.ext.allow=never");
  c("core.askPass=");
  c("submodule.recurse=false");
  c("i18n.commitEncoding=UTF-8");
  c("i18n.logOutputEncoding=UTF-8");
  if (base.platform === "win32") c("core.longpaths=true");
  const drivers = /* @__PURE__ */ new Set(["lfs"]);
  for (const d of opts.filterDrivers ?? []) {
    checkDriverName(d);
    drivers.add(d);
  }
  for (const d of [...drivers].sort()) c(`filter.${d}.required=true`);
  if (opts.attrTree !== void 0) {
    if (!OID.test(opts.attrTree)) fail(`attrTree must be a 40- or 64-hex oid, got ${JSON.stringify(opts.attrTree)}`);
    c(`attr.tree=${opts.attrTree}`);
  }
  if (opts.class === "refupdate") {
    c("core.logAllRefUpdates=always");
    c("core.fsync=committed,reference,index");
    c("core.fsyncMethod=batch");
  } else if (sub === "fetch") {
    c("core.logAllRefUpdates=always");
  }
  if (sub === "push") {
    c("push.pushOption=");
    c("push.gpgSign=false");
    c("push.followTags=false");
    c("push.recurseSubmodules=no");
  }
  if (opts.class === "network") {
    c("http.lowSpeedLimit=1000");
    c("http.lowSpeedTime=10");
  }
  if (opts.config !== void 0) {
    for (const key of Object.keys(opts.config).sort()) {
      const value2 = opts.config[key];
      if (key.length === 0 || /[=\s\0]/.test(key) || !key.includes(".")) fail(`invalid config key ${JSON.stringify(key)}`);
      if (/[\0\r\n]/.test(value2)) fail(`invalid config value for ${key}`);
      if (isForcedKey(key)) fail(`config key ${JSON.stringify(key)} is forced by the runner`);
      pre.push("-c", `${key}=${value2}`);
    }
  }
  if (MERGE_COMMANDS.has(sub)) pre.push(...MERGE_FLAGS);
  const post = [];
  if (DIFF_FAMILY.has(sub)) post.push(...DIFF_FLAGS);
  if (sub === "fetch") post.push(...FETCH_FLAGS);
  return {
    argv: [...pre, sub, ...post, ...args.slice(1)],
    env: buildEnv(opts, base)
  };
}

// src/git/runner.ts
var WATCHDOG = { fetch: 45e3, push: 9e4, readHash: 12e4 };
var NEVER_KILLED = /* @__PURE__ */ new Set(["update-ref", "update-index", "commit-tree", "read-tree"]);
var CLOSE_GRACE_MS = 5e3;
var DRAIN_TURNS_MAX = 64;
function subcommandOf(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-c" || a === "-C") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return void 0;
}
function watchdogMs(args, cls) {
  const sub = subcommandOf(args);
  if (sub === void 0 || NEVER_KILLED.has(sub)) return null;
  if (sub === "push") return WATCHDOG.push;
  if (sub === "fetch") return WATCHDOG.fetch;
  if (cls === "network") return WATCHDOG.fetch;
  if (sub === "add" || sub === "hash-object") return WATCHDOG.readHash;
  if (sub === "cat-file" && args.includes("--filters")) return WATCHDOG.readHash;
  return null;
}
function systemRootOf(env) {
  let root = null;
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() !== "SYSTEMROOT") continue;
    if (!/^[A-Za-z]:[\\/]/.test(v) || !win322.isAbsolute(v) || root !== null && v !== root) return null;
    root = v;
  }
  return root;
}
var TASKKILL_TIMEOUT_MS = 1e4;
function killTree(child, deps, systemRoot2) {
  const pid = child.pid;
  if (pid === void 0 || child.exitCode !== null || child.signalCode !== null) return;
  const killGit = () => {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  };
  if (process.platform === "win32") {
    const testCmd = deps.winKillCommand?.(pid);
    if (testCmd === void 0 && systemRoot2 === null) {
      killGit();
      return;
    }
    const cmd = testCmd ?? { file: win322.join(systemRoot2, "System32", "taskkill.exe"), args: ["/PID", String(pid), "/T", "/F"] };
    const r = spawnSync(cmd.file, cmd.args, {
      ...systemRoot2 !== null ? { cwd: systemRoot2 } : {},
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      timeout: TASKKILL_TIMEOUT_MS
    });
    if (r.error !== void 0 || r.status !== 0) killGit();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }
}
function createGitRunner(deps) {
  const platform = deps.platform ?? process.platform;
  const gitPath = deps.gitPath ?? "git";
  const systemRoot2 = systemRootOf(deps.daemonEnv);
  const base = {
    hooksPath: deps.hooksPath,
    platform,
    daemonEnv: deps.daemonEnv,
    testBuild: deps.testBuild ?? false,
    ...deps.sshCommand !== void 0 ? { sshCommand: deps.sshCommand } : {}
  };
  return {
    run(args, opts) {
      const inv = buildGitInvocation(args, opts, base);
      const sub = subcommandOf(args);
      const neverKilled = sub !== void 0 && NEVER_KILLED.has(sub);
      const limit = neverKilled ? null : deps.watchdogOverrideMs ?? watchdogMs(args, opts.class);
      const signal = neverKilled ? void 0 : opts.abort;
      const started = deps.clock.monoMs();
      return new Promise((resolve2) => {
        const out = [];
        const err = [];
        let killed = false;
        let aborted = false;
        let settled = false;
        let exited = false;
        let child;
        let timer;
        let grace;
        const onAbort = () => {
          if (settled || exited || child === void 0) return;
          aborted = true;
          killTree(child, deps, systemRoot2);
        };
        const finish = (code, extraErr) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (grace) clearTimeout(grace);
          signal?.removeEventListener("abort", onAbort);
          if (extraErr !== void 0) err.push(Buffer.from(extraErr, "utf8"));
          resolve2({
            code,
            stdout: Buffer.concat(out),
            stderr: Buffer.concat(err),
            killedByWatchdog: killed,
            aborted,
            durationMs: deps.clock.monoMs() - started
          });
        };
        if (signal?.aborted === true) {
          aborted = true;
          finish(-1);
          return;
        }
        let proc;
        try {
          proc = spawn(gitPath, inv.argv, {
            cwd: opts.cwd,
            env: inv.env,
            stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
            windowsHide: true,
            // POSIX: own process group, so kill(-pid) reaches grandchildren.
            detached: process.platform !== "win32"
          });
        } catch (e) {
          finish(-1, `spawn failed: ${e.message}`);
          return;
        }
        child = proc;
        let chunks = 0;
        proc.stdout.on("data", (b) => {
          chunks++;
          out.push(b);
        });
        proc.stderr.on("data", (b) => {
          chunks++;
          err.push(b);
        });
        proc.on("error", (e) => finish(-1, `spawn failed: ${e.message}`));
        let exitCode = null;
        const drain = (seen, turns) => {
          setImmediate(() => {
            if (settled) return;
            if (chunks !== seen && turns < DRAIN_TURNS_MAX) {
              drain(chunks, turns + 1);
              return;
            }
            proc.stdout?.destroy();
            proc.stderr?.destroy();
            finish(exitCode ?? -1);
          });
        };
        proc.on("exit", (code) => {
          exited = true;
          exitCode = code;
          grace = setTimeout(() => drain(chunks, 0), CLOSE_GRACE_MS);
        });
        proc.on("close", (code) => finish(code ?? exitCode ?? -1));
        if (opts.stdin && proc.stdin) {
          proc.stdin.on("error", () => {
          });
          proc.stdin.end(opts.stdin);
        }
        if (limit !== null) {
          timer = setTimeout(() => {
            if (exited) return;
            killed = true;
            killTree(proc, deps, systemRoot2);
          }, limit);
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  };
}

// src/ports/fs.ts
import { lstatSync, promises as fsp, readFileSync, realpathSync } from "node:fs";
function hasCode(e, code) {
  return typeof e === "object" && e !== null && e.code === code;
}
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
var realFs = {
  // One open + whole-file read + close. On Windows libuv opens with share-all
  // (read|write|delete), so an editor's save is never blocked by a held handle
  // beyond this single call (glossary §26.1 W1, W3).
  async readFile(p) {
    return fsp.readFile(p);
  },
  async writeFile(p, data) {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(`Fs.writeFile requires a Buffer (got ${typeof data}) for ${p}`);
    }
    await fsp.writeFile(p, data);
  },
  async rename(from, to) {
    await fsp.rename(from, to);
  },
  async link(existing, newPath) {
    await fsp.link(existing, newPath);
  },
  async unlink(p) {
    await fsp.unlink(p);
  },
  async stat(p) {
    try {
      const s = await fsp.stat(p);
      return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (e) {
      if (hasCode(e, "ENOENT")) return null;
      throw e;
    }
  },
  async mkdirp(p, mode) {
    await fsp.mkdir(p, mode === void 0 ? { recursive: true } : { recursive: true, mode });
  },
  async lstat(p) {
    try {
      const s = await fsp.lstat(p, { bigint: true });
      return {
        size: Number(s.size),
        mtimeNs: s.mtimeNs,
        ino: s.ino,
        dev: s.dev,
        mode: Number(s.mode),
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink()
      };
    } catch (e) {
      if (hasCode(e, "ENOENT") || hasCode(e, "ENOTDIR")) return null;
      throw e;
    }
  },
  async writeFileExclusive(p, data) {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(`Fs.writeFileExclusive requires a Buffer (got ${typeof data}) for ${p}`);
    }
    const h = await fsp.open(p, "wx");
    try {
      await h.writeFile(data);
      await h.sync();
    } finally {
      await h.close();
    }
  },
  async rmdir(p) {
    await fsp.rmdir(p);
  },
  async appendFile(p, data) {
    if (!Buffer.isBuffer(data)) {
      throw new TypeError(`Fs.appendFile requires a Buffer (got ${typeof data}) for ${p}`);
    }
    await fsp.appendFile(p, data);
  },
  async realpath(p) {
    return fsp.realpath(p);
  },
  async freeBytes(dir) {
    try {
      const s = await fsp.statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch (e) {
      if (typeof e === "object" && e !== null && e.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
        return null;
      }
      throw e;
    }
  },
  async chmod(p, mode) {
    await fsp.chmod(p, mode);
  },
  async readdir(p) {
    const names = await fsp.readdir(p);
    return names.sort(byCodeUnit);
  },
  async rmrf(p) {
    await fsp.rm(p, { recursive: true, force: true, maxRetries: 3 });
  }
};

// src/cli/launch.ts
import { spawn as spawn2 } from "node:child_process";
var STARTED_RE = /^started (genesis|join|restart) on .+ as peer [0-9a-f]+$/;
var MAX_OUTPUT_BYTES = 64 * 1024;
function launchDaemon(l) {
  return launchDaemonWith(l, spawn2);
}
function launchDaemonWith(l, spawnFn) {
  return new Promise((resolve2) => {
    let child;
    try {
      child = spawnFn(l.execPath, [l.daemonJs, ...l.argv], {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: l.cwd,
        env: { ...l.env }
      });
    } catch (e) {
      resolve2({ kind: "spawn_failed", why: e instanceof Error ? e.message : String(e) });
      return;
    }
    const lines = [];
    const partial = { out: "", err: "" };
    let size = 0;
    let settled = false;
    const finish = (o) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve2(o);
    };
    const flush = () => {
      for (const k of ["out", "err"]) {
        if (partial[k].length > 0) lines.push(partial[k].replace(/\r$/, ""));
        partial[k] = "";
      }
    };
    const onData = (k) => (d) => {
      size += d.length;
      if (size > MAX_OUTPUT_BYTES) return;
      partial[k] += d.toString("utf8");
      let nl = partial[k].indexOf("\n");
      while (nl >= 0) {
        const line = partial[k].slice(0, nl).replace(/\r$/, "");
        partial[k] = partial[k].slice(nl + 1);
        lines.push(line);
        const m = k === "out" ? STARTED_RE.exec(line) : null;
        if (m !== null) {
          finish({ kind: "started", mode: m[1], lines: [...lines] });
          return;
        }
        nl = partial[k].indexOf("\n");
      }
    };
    const timer = setTimeout(() => {
      flush();
      finish({ kind: "timeout", lines: [...lines] });
    }, l.timeoutMs);
    child.on("error", (e) => finish({ kind: "spawn_failed", why: e.message }));
    child.stdout?.on("data", onData("out"));
    child.stderr?.on("data", onData("err"));
    child.on("close", (code) => {
      flush();
      finish({ kind: "exited", code, lines: [...lines] });
    });
  });
}

// src/cli/verbs.ts
import { join as join3 } from "node:path";

// src/text/sanitize.ts
var LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
var LINE_BREAK = /\r\n|[\r\n\u{85}\u{2028}\u{2029}]/gu;
var STRIPPED = /(?!\n)[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u{E0000}-\u{E007F}]/gu;
var ESCAPE_INTRODUCER = /[\u{1B}\u{90}\u{98}\u{9B}\u{9D}\u{9E}\u{9F}]/u;
var COMMAND_TOKENS = /^(?:\s*\/\S*)+\s*/u;
var BARE_SCHEMES = "javascript|vbscript|data|blob|file|mailto";
var URL_BARE = new RegExp(String.raw`(?<![A-Za-z0-9])(?:${BARE_SCHEMES}):\S*`, "giu");
var URL_SCHEME = /(?<![A-Za-z0-9+.-])[A-Za-z0-9+.-]*:\/\/\S*/gu;
var DASH_RUN = /[-\u{2010}-\u{2015}\u{2212}\u{FE58}\u{FE63}\u{FF0D}]{3,}/gu;
var LINK_REMOVED = "[link removed]";
var FULLWIDTH_LT = "＜";
var FULLWIDTH_GT = "＞";
var EM_DASH = "—";
var ESC = 27;
var BEL = 7;
var C1_ST = 156;
function skipCsi(s, j) {
  while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 63) j++;
  while (j < s.length && s.charCodeAt(j) >= 32 && s.charCodeAt(j) <= 47) j++;
  if (j < s.length && s.charCodeAt(j) >= 64 && s.charCodeAt(j) <= 126) j++;
  return j;
}
function skipString(s, j) {
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === BEL || c === C1_ST) return j + 1;
    if (c === ESC) return s.charCodeAt(j + 1) === 92 ? j + 2 : j;
    j++;
  }
  return j;
}
function stripEscapes(s) {
  if (!ESCAPE_INTRODUCER.test(s)) return s;
  const parts = [];
  let start2 = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let next = -1;
    if (c === ESC) {
      const d = s.charCodeAt(i + 1);
      if (d === 91) next = skipCsi(s, i + 2);
      else if (d === 93 || d === 80 || d === 88 || d === 94 || d === 95) next = skipString(s, i + 2);
      else {
        let j = i + 1;
        while (j < s.length && s.charCodeAt(j) >= 32 && s.charCodeAt(j) <= 47) j++;
        next = j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 126 ? j + 1 : i + 1;
      }
    } else if (c === 155) next = skipCsi(s, i + 1);
    else if (c === 157 || c === 144 || c === 152 || c === 158 || c === 159) next = skipString(s, i + 1);
    if (next < 0) {
      i++;
      continue;
    }
    parts.push(s.slice(start2, i));
    i = next;
    start2 = next;
  }
  parts.push(s.slice(start2));
  return parts.join("");
}
function sanitize(text, channel) {
  let s = stripEscapes(text.replace(LONE_SURROGATE, ""));
  s = s.replace(LINE_BREAK, "\n").replace(STRIPPED, "").normalize("NFC");
  const sep = channel === "claude" ? "\n" : channel === "notification" || channel === "viz" ? " " : "";
  s = s.split("\n").map((line) => line.replace(COMMAND_TOKENS, "")).join(sep);
  s = s.normalize("NFC");
  s = s.replace(/</g, FULLWIDTH_LT).replace(/>/g, FULLWIDTH_GT);
  s = s.replace(URL_BARE, LINK_REMOVED).replace(URL_SCHEME, LINK_REMOVED);
  if (channel === "notification" || channel === "viz") s = s.replace(DASH_RUN, EM_DASH);
  return s;
}
var VIZ_CAPS = Object.freeze({
  name: 20,
  label: 80,
  path: 80,
  note: 280,
  branch: 80,
  room: 40,
  card: 400,
  tooltip: 200,
  plaque: 16,
  caption: 120,
  version: 20
});
var NAME_RAW_MAX = 64;
var VIZ_RAW_UNITS = Object.freeze(
  Object.fromEntries(Object.keys(VIZ_CAPS).map((k) => [k, k === "name" ? NAME_RAW_MAX : 4 * VIZ_CAPS[k]]))
);
var MARKS_PER_GRAPHEME_MAX = 4;
var MIDDLE = /* @__PURE__ */ new Set(["path", "plaque", "label"]);
var BARE_SCHEME_START = new RegExp(String.raw`^(?:${BARE_SCHEMES}):`, "iu");
var ELLIPSIS = "…";
var SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
var MARK = new RegExp("\\p{M}", "u");
function trimMarksOnce(text) {
  let changed = false;
  const parts = [];
  for (const { segment } of SEGMENTER.segment(text)) {
    if (segment.length <= MARKS_PER_GRAPHEME_MAX) {
      parts.push(segment);
      continue;
    }
    let marks = 0;
    let kept = "";
    for (const cp of segment) {
      if (MARK.test(cp) && ++marks > MARKS_PER_GRAPHEME_MAX) {
        changed = true;
        continue;
      }
      kept += cp;
    }
    parts.push(kept);
  }
  return changed ? parts.join("") : null;
}
function trimMarks(text) {
  if (!MARK.test(text)) return text;
  let t = text;
  for (let next = trimMarksOnce(t); next !== null; next = trimMarksOnce(t)) t = next;
  return t;
}
function fit(gs, from, step, maxG, maxU) {
  let n = 0;
  let units = 0;
  for (let i = from; i >= 0 && i < gs.length && n < maxG; i += step) {
    const len = gs[i].length;
    if (units + len > maxU) break;
    units += len;
    n += 1;
  }
  return { n, units };
}
function cap(text, kind) {
  const maxG = VIZ_CAPS[kind];
  const maxU = VIZ_RAW_UNITS[kind];
  const t = trimMarks(text);
  if (t.length <= maxG) return t;
  const gs = Array.from(SEGMENTER.segment(t), (x) => x.segment);
  if (gs.length <= maxG && t.length <= maxU) return t;
  const contentG = maxG - 1;
  const contentU = maxU - 1;
  if (!MIDDLE.has(kind)) return gs.slice(0, fit(gs, 0, 1, contentG, contentU).n).join("") + ELLIPSIS;
  const front = fit(gs, 0, 1, Math.floor(contentG / 2), Math.floor(contentU / 2));
  const back = fit(gs, gs.length - 1, -1, contentG - front.n, contentU - front.units);
  let from = gs.length - back.n;
  while (from < gs.length && BARE_SCHEME_START.test(gs.slice(from).join(""))) from += 1;
  return gs.slice(0, front.n).join("") + ELLIPSIS + gs.slice(from).join("");
}

// src/i18n/render.ts
var LANGS = Object.freeze(["en", "ko", "zh-CN", "ja", "fr", "es"]);
var CHANNEL_CAPS = Object.freeze({
  terminal: null,
  slash: 4e3,
  systemMessage: 1050,
  notification: 120,
  json: null,
  log: null,
  viz: 400
});
var SANITIZE_CHANNEL = {
  terminal: "terminal",
  slash: "terminal",
  systemMessage: "terminal",
  notification: "notification",
  json: "terminal",
  log: "log",
  viz: "viz"
};
var TEXT_CAP = {
  name: "name",
  path: "path",
  label: "label",
  id: "label",
  note: "note",
  text: "card"
};
var PARAM_TYPES = /* @__PURE__ */ new Set(["name", "path", "label", "id", "n", "dur", "cmd", "reason", "note", "code", "text", "url"]);
var CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;
var LAUNCH_URL_RE = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#k=[0-9a-f]{64}$/;
var PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;
var CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
var LINK_REMOVED2 = "[link removed]";
var UNKNOWN = "?";
var SEGMENTER2 = new Intl.Segmenter("en", { granularity: "grapheme" });
var registry = /* @__PURE__ */ new Map();
var reasonRegistry = /* @__PURE__ */ new Set();
var own = (o, key) => Object.prototype.hasOwnProperty.call(o, key) ? o[key] : void 0;
function validEntry(e) {
  if (typeof e !== "object" || e === null || typeof e.text !== "string") return false;
  const entry = e;
  if (entry.params !== void 0 && (typeof entry.params !== "object" || entry.params === null || !Object.values(entry.params).every((t) => typeof t === "string" && PARAM_TYPES.has(t)))) return false;
  if (entry.plural !== void 0 && typeof entry.plural !== "string") return false;
  if (entry.forms !== void 0 && (typeof entry.forms !== "object" || entry.forms === null || !Object.values(entry.forms).every((f) => typeof f === "string"))) return false;
  return true;
}
function entryKey(e) {
  const sortedPairs = (o) => o === void 0 ? null : Object.entries(o).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return JSON.stringify([e.text, sortedPairs(e.params), e.plural ?? null, sortedPairs(e.forms)]);
}
function copyEntry(e) {
  const c = { text: e.text };
  if (e.params !== void 0) c.params = Object.freeze({ ...e.params });
  if (e.plural !== void 0) c.plural = e.plural;
  if (e.forms !== void 0) c.forms = Object.freeze({ ...e.forms });
  return Object.freeze(c);
}
function registerCatalog(lang, entries) {
  if (!LANGS.includes(lang)) throw new Error(`registerCatalog: unknown language ${String(lang)}`);
  const current = registry.get(lang) ?? /* @__PURE__ */ new Map();
  const add = /* @__PURE__ */ new Map();
  for (const code of Object.keys(entries)) {
    const e = own(entries, code);
    if (!CODE_RE.test(code) || !validEntry(e)) throw new Error(`registerCatalog: ${lang} ${code} is not a code with a catalog entry`);
    const prev = current.get(code) ?? add.get(code);
    if (prev !== void 0 && entryKey(prev) !== entryKey(e)) throw new Error(`registerCatalog: ${lang} ${code} is already registered with another entry`);
    if (prev === void 0) add.set(code, copyEntry(e));
  }
  for (const [code, e] of add) current.set(code, e);
  registry.set(lang, current);
}
var numberFormats = /* @__PURE__ */ new Map();
var pluralRules = /* @__PURE__ */ new Map();
function numberFormat(lang) {
  let f = numberFormats.get(lang);
  if (f === void 0) {
    f = new Intl.NumberFormat(lang);
    numberFormats.set(lang, f);
  }
  return f;
}
function plurals(lang) {
  let p = pluralRules.get(lang);
  if (p === void 0) {
    p = new Intl.PluralRules(lang);
    pluralRules.set(lang, p);
  }
  return p;
}
var isNumber = (v) => typeof v === "number" && Number.isFinite(v);
function templateOf(found, params) {
  const { e } = found;
  if (e.plural === void 0 || e.forms === void 0) return e.text;
  const v = own(params, e.plural);
  if (!isNumber(v)) return e.text;
  const form = own(e.forms, plurals(found.lang).select(v)) ?? own(e.forms, "other");
  return typeof form === "string" ? form : e.text;
}
function duration(ctx, ms) {
  const s = Math.round(ms / 1e3);
  const m = Math.round(ms / 6e4);
  const [code, n] = s < 60 ? ["UI_DUR_S", s] : m < 60 ? ["UI_DUR_MIN", m] : ["UI_DUR_H", Math.round(ms / 36e5)];
  const found = ctx.look(ctx.lang, code);
  return found === null ? UNKNOWN : fill(ctx, found, { n }, 1);
}
function value(ctx, e, params, name, depth) {
  const type = e.params === void 0 ? void 0 : own(e.params, name);
  const v = own(params, name);
  switch (type) {
    case "n":
      return isNumber(v) ? numberFormat(ctx.lang).format(v) : UNKNOWN;
    case "dur":
      return isNumber(v) && v >= 0 ? duration(ctx, v) : UNKNOWN;
    case "reason": {
      if (depth > 0 || typeof v !== "string" || !ctx.reasons.has(v)) return UNKNOWN;
      const nested = ctx.look(ctx.lang, v);
      return nested === null ? UNKNOWN : fill(ctx, nested, params, depth + 1);
    }
    case "url":
      return ctx.channel === "terminal" && typeof v === "string" && LAUNCH_URL_RE.test(v) ? v : LINK_REMOVED2;
    case "cmd":
      return typeof v === "string" ? v.replace(CONTROL_OR_FORMAT, "") : UNKNOWN;
    case "code":
      return typeof v === "string" && CODE_RE.test(v) ? v : UNKNOWN;
    case "name":
    case "path":
    case "label":
    case "id":
    case "note":
    case "text":
      if (typeof v !== "string" && !isNumber(v)) return UNKNOWN;
      return cap(sanitize(String(v), SANITIZE_CHANNEL[ctx.channel]), TEXT_CAP[type]);
    default:
      return UNKNOWN;
  }
}
function fill(ctx, found, params, depth) {
  return templateOf(found, params).replace(PLACEHOLDER, (_m, name) => value(ctx, found.e, params, name, depth));
}
function internalError(ctx) {
  const found = ctx.look(ctx.lang, "UI_INTERNAL_ERROR");
  return found === null ? UNKNOWN : fill(ctx, found, {}, 1);
}
var graphemeCount = (s) => {
  let n = 0;
  for (const _ of SEGMENTER2.segment(s)) n += 1;
  return n;
};
function run(look, reasons, code, params, channel, lang) {
  const ctx = { look, reasons, channel, lang };
  const found = look(lang, code);
  const out = found === null ? internalError(ctx) : fill(ctx, found, params, 0);
  if (channel === "viz") return cap(out, "card");
  const max = CHANNEL_CAPS[channel];
  if (max === null || graphemeCount(out) <= max) return out;
  const tooLong = look(lang, "UI_TEXT_TOO_LONG");
  return tooLong === null ? internalError(ctx) : fill(ctx, tooLong, { code }, 1);
}
function registeredLookup(lang, code) {
  if (!CODE_RE.test(code)) return null;
  const e = registry.get(lang)?.get(code);
  if (e !== void 0) return { e, lang };
  const en = registry.get("en")?.get(code);
  return en === void 0 ? null : { e: en, lang: "en" };
}
function render(code, params, channel, lang) {
  return run(registeredLookup, reasonRegistry, code, params, channel, lang);
}

// src/version.ts
var PLUGIN_VERSION = "0.1.0-preview";

// src/viz/cli/view.ts
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix as posix6, win32 as win328 } from "node:path";
import { fileURLToPath } from "node:url";

// src/data/pluginDataDir.ts
import { posix as posix2, win32 as win323 } from "node:path";
var pathOf = (platform) => platform === "win32" ? win323 : posix2;
function isUncOrDevice(p) {
  const sep = (c) => c === "/" || c === "\\";
  if (p.length >= 2 && sep(p[0]) && sep(p[1])) return true;
  return p === "/dev" || p.startsWith("/dev/");
}
function envValue(env, name, platform) {
  if (env[name] !== void 0 || platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === void 0 ? void 0 : env[key];
}
function absolutePath(p, platform) {
  if (p === "" || isUncOrDevice(p)) return false;
  return platform === "win32" ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith("/");
}
function pluginDataDir(env, home, platform) {
  const P = pathOf(platform);
  const config = envValue(env, "CLAUDE_CONFIG_DIR", platform);
  const base = config !== void 0 && absolutePath(config, platform) ? config : P.join(home, ".claude");
  return P.join(base, "plugins", "data", "cowork-sync");
}
function withoutTrailingSeparator(p, platform) {
  const min = platform === "win32" && /^[A-Za-z]:[\\/]/.test(p) ? 3 : 1;
  let end = p.length;
  while (end > min && (p[end - 1] === "/" || platform === "win32" && p[end - 1] === "\\")) end -= 1;
  return p.slice(0, end);
}
function canonicalDir(p, platform) {
  return withoutTrailingSeparator(pathOf(platform).normalize(p), platform);
}
function resolveDataDir(env, home, platform) {
  const given = envValue(env, "CLAUDE_PLUGIN_DATA", platform);
  if (given !== void 0 && given !== "" && !absolutePath(given, platform)) return null;
  const dir = canonicalDir(given !== void 0 && given !== "" ? given : pluginDataDir(env, home, platform), platform);
  return absolutePath(dir, platform) ? dir : null;
}

// src/sec/sddl.ts
var BUILTIN_ADMINISTRATORS = "S-1-5-32-544";
var LOCAL_SYSTEM = "S-1-5-18";
var ALLOWED_SYSTEM_SIDS = [LOCAL_SYSTEM, BUILTIN_ADMINISTRATORS];
var SID_RE = /^S-1-[0-9]+(?:-[0-9]+)+$/;
var ALIAS_RE = /^[A-Z]{2}$/;
var ALIASES = {
  SY: LOCAL_SYSTEM,
  BA: BUILTIN_ADMINISTRATORS,
  WD: "S-1-1-0",
  AU: "S-1-5-11",
  BU: "S-1-5-32-545",
  BG: "S-1-5-32-546",
  IU: "S-1-5-4",
  NU: "S-1-5-2",
  AN: "S-1-5-7",
  LS: "S-1-5-19",
  NS: "S-1-5-20",
  CO: "S-1-3-0",
  CG: "S-1-3-1",
  OW: "S-1-3-4"
};
var CREATOR_OWNER = "S-1-3-0";
var OWNER_RIGHTS = "S-1-3-4";
var ACE_FLAG_RE = /^(?:CI|OI|NP|IO|ID|SA|FA|TP|CR)*$/;
var RIGHTS_RE = /^(?:0[xX][0-9A-Fa-f]+|[0-9]+|(?:[A-Z]{2})+)$/;
var SID_TOKEN_RE = /^(?:S-1-[0-9]+(?:-[0-9]+)+|[A-Z]{2})/;
var ACL_FLAGS_RE = /^(?:NO_ACCESS_CONTROL|AI|AR|P)*/;
function sidOf(token) {
  if (SID_RE.test(token)) return token;
  if (ALIAS_RE.test(token)) return ALIASES[token] ?? token;
  return null;
}
function sections(sddl) {
  const out = {};
  const seen = /* @__PURE__ */ new Set();
  let i = 0;
  while (i < sddl.length) {
    const tag = sddl[i];
    if (!"OGDS".includes(tag) || sddl[i + 1] !== ":" || seen.has(tag)) return null;
    seen.add(tag);
    i += 2;
    if (tag === "O" || tag === "G") {
      const m = SID_TOKEN_RE.exec(sddl.slice(i));
      if (m === null) return null;
      if (tag === "O") out.owner = m[0];
      else out.group = m[0];
      i += m[0].length;
      continue;
    }
    const flags = ACL_FLAGS_RE.exec(sddl.slice(i))[0];
    i += flags.length;
    const aces = [];
    while (sddl[i] === "(") {
      let depth = 0;
      let j = i;
      for (; j < sddl.length; j += 1) {
        if (sddl[j] === "(") depth += 1;
        else if (sddl[j] === ")" && --depth === 0) break;
      }
      if (j >= sddl.length) return null;
      aces.push(sddl.slice(i + 1, j));
      i = j + 1;
    }
    if (tag === "D") out.dacl = { flags, aces };
    else out.sacl = { flags, aces };
  }
  return out;
}
function parseSddlAces(sddl) {
  const s = sections(sddl);
  if (s === null || s.dacl === void 0 || s.dacl.flags.includes("NO_ACCESS_CONTROL")) return null;
  const owner = s.owner === void 0 ? null : sidOf(s.owner);
  if (s.group !== void 0 && sidOf(s.group) === null) return null;
  const aces = s.dacl.aces;
  const allow = [];
  const allowInherited = [];
  const deny = [];
  for (const ace of aces) {
    const f = ace.split(";");
    if (f.length !== 6) return null;
    const [type, aceFlags, rights, objectGuid, inheritGuid, sidToken] = f;
    if (type !== "A" && type !== "D") return null;
    if (!ACE_FLAG_RE.test(aceFlags) || aceFlags.length % 2 !== 0 || !RIGHTS_RE.test(rights) || objectGuid !== "" || inheritGuid !== "") return null;
    const sid = sidOf(sidToken);
    if (sid === null) return null;
    if (type === "D") {
      deny.push(sid);
      continue;
    }
    const flags = aceFlags.match(/../g) ?? [];
    const inheritOnly = flags.includes("IO");
    allow.push(inheritOnly && sid === CREATOR_OWNER ? "CO" : inheritOnly && sid === OWNER_RIGHTS ? "OW" : sid);
    allowInherited.push(flags.includes("ID"));
  }
  return { owner, allow, deny, allowInherited };
}
function asUser(sid, user) {
  const rid = user.slice(user.lastIndexOf("-") + 1);
  return sid === "LA" && rid === "500" || sid === "LG" && rid === "501" ? user : sid;
}
function ownerOk(owner, user) {
  const o = asUser(owner, user);
  return o === user || o === BUILTIN_ADMINISTRATORS;
}
var admittedSids = (user) => /* @__PURE__ */ new Set([user, ...ALLOWED_SYSTEM_SIDS, "CO", "OW"]);
function sddlUserOnly(s, userSid2) {
  const user = userSid2.toUpperCase();
  if (!ownerOk(s.owner, user)) return false;
  const allow = s.allow.map((sid) => asUser(sid, user));
  if (!allow.includes(user)) return false;
  const admitted = admittedSids(user);
  return allow.every((sid) => sid !== null && admitted.has(sid));
}

// src/viz/cli/dataDir.ts
var refuse = (why) => ({ ok: false, why });
async function verifyDataDir(dirName, o) {
  try {
    const dir = withoutTrailingSeparator(dirName, o.platform);
    let st = await o.fs.lstat(dir);
    let created = false;
    if (st === null) {
      if (!o.create) return refuse("not_dir");
      await o.fs.mkdirp(dir, 448);
      st = await o.fs.lstat(dir);
      if (st === null) return refuse("probe_failed");
      created = true;
    }
    if (st.isSymbolicLink) return refuse("symlink");
    if (!st.isDirectory) return refuse("not_dir");
    if (o.platform === "win32") {
      const first = st;
      const protectDir = o.create ? o.probe.protectDir?.bind(o.probe) : void 0;
      const guarded = async (run2) => {
        const before = await changedSince(o.fs, dir, first);
        if (before !== null) return before;
        await run2(dir);
        return changedSince(o.fs, dir, first);
      };
      if (created && protectDir !== void 0) {
        const moved = await guarded(protectDir);
        if (moved !== null) return moved;
      }
      let r = await windowsVerdict(dir, o.probe);
      if (r.repairable && protectDir !== void 0) {
        if (!await onlyViewerFiles(o.fs, dir, o.platform)) return r.verdict;
        const moved = await guarded(protectDir);
        if (moved !== null) return moved;
        if (!await onlyViewerFiles(o.fs, dir, o.platform)) return r.verdict;
        r = await windowsVerdict(dir, o.probe);
      }
      if (!r.verdict.ok) return r.verdict;
      return await changedSince(o.fs, dir, first) ?? r.verdict;
    }
    const p = await o.probe.posix(dir);
    if (p === null) return refuse("probe_failed");
    if (p.isSymlink) return refuse("symlink");
    if (!p.isDir) return refuse("not_dir");
    const euid = o.probe.euid();
    if (euid === null) return refuse("probe_failed");
    if (p.uid !== euid) return refuse("owner");
    return (p.mode & 63) === 0 ? { ok: true } : refuse("mode");
  } catch {
    return refuse("probe_failed");
  }
}
async function changedSince(fs, dir, first) {
  const now = await fs.lstat(dir);
  if (now === null) return refuse("not_dir");
  if (now.isSymbolicLink) return refuse("symlink");
  if (!now.isDirectory) return refuse("not_dir");
  return now.dev === first.dev && now.ino === first.ino ? null : refuse("probe_failed");
}
var LOG_DIR = "log";
var PROBE_RECORD = "probe.json";
var isJsonl = (name) => name.endsWith(".jsonl");
async function onlyViewerFiles(fs, dir, platform) {
  const P = pathOf(platform);
  const regularFile = async (p) => {
    const s = await fs.lstat(p);
    return s !== null && s.isFile && !s.isSymbolicLink;
  };
  for (const name of await fs.readdir(dir)) {
    const p = P.join(dir, name);
    if (name === LOG_DIR) {
      const s = await fs.lstat(p);
      if (s === null || s.isSymbolicLink || !s.isDirectory) return false;
      for (const inner of await fs.readdir(p)) {
        if (!isJsonl(inner) || !await regularFile(P.join(p, inner))) return false;
      }
      continue;
    }
    if (!(isJsonl(name) || name === PROBE_RECORD) || !await regularFile(p)) return false;
  }
  return true;
}
async function windowsVerdict(dir, probe) {
  const fail2 = (why, repairable = false) => ({ verdict: refuse(why), repairable });
  const acl = await probe.windows(dir);
  if (acl === null) return fail2("probe_failed");
  const s = parseSddlAces(acl.sddl);
  if (s === null) return fail2("acl");
  const user = acl.userSid.toUpperCase();
  if (!ownerOk(s.owner, user)) return fail2("owner");
  if (sddlUserOnly(s, user)) return { verdict: { ok: true }, repairable: false };
  const admitted = admittedSids(user);
  const explicitAdmitted = s.allow.every((sid, i) => s.allowInherited[i] === true || admitted.has(asUser(sid, user) ?? ""));
  return fail2("acl", explicitAdmitted && s.allowInherited.includes(true));
}

// src/viz/cli/opener.ts
import { spawn as spawn3 } from "node:child_process";
import { posix as posix4, win32 as win325 } from "node:path";

// src/viz/cli/paths.ts
var SEPARATORS = "\\/";
var WIN_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
var WIN_DRIVE = /^[A-Za-z]:/;
function isUncOrDevice2(p) {
  if (p.length >= 2 && SEPARATORS.includes(p[0]) && SEPARATORS.includes(p[1])) return true;
  return p === "/dev" || p.startsWith("/dev/");
}
function resolveSegments(segments) {
  const out = [];
  for (const s of segments) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out;
}
function usableCwd(cwd, win) {
  return !isUncOrDevice2(cwd) && (win ? WIN_DRIVE_ABSOLUTE.test(cwd) : cwd.startsWith("/"));
}
function absolutizeWin32(p, cwd) {
  const path = p.split("/").join("\\");
  const base = cwd.split("/").join("\\");
  let joined;
  if (WIN_DRIVE_ABSOLUTE.test(path)) joined = path;
  else if (WIN_DRIVE.test(path)) return null;
  else if (!usableCwd(base, true)) return null;
  else if (path.startsWith("\\")) joined = base.slice(0, 2) + path;
  else joined = `${base}\\${path}`;
  const drive = joined.slice(0, 2);
  return `${drive}\\${resolveSegments(joined.slice(3).split("\\")).join("\\")}`;
}
function absolutizePosix(p, cwd) {
  if (!p.startsWith("/") && !usableCwd(cwd, false)) return null;
  const joined = p.startsWith("/") ? p : `${cwd}/${p}`;
  return `/${resolveSegments(joined.split("/")).join("/")}`;
}
function absolutize(p, cwd, platform) {
  if (p === "" || p.includes("\0") || isUncOrDevice2(p)) return null;
  const abs = platform === "win32" ? absolutizeWin32(p, cwd) : absolutizePosix(p, cwd);
  return abs === null || isUncOrDevice2(abs) ? null : abs;
}

// src/viz/cli/pathTrust.ts
import { posix as posix3, win32 as win324 } from "node:path";
var pathOf2 = (platform) => platform === "win32" ? win324 : posix3;
var foldsCase = (platform) => platform === "win32" || platform === "darwin";
async function realpathOrNull(fs, p) {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}
function inside(p, root, platform) {
  const { sep } = pathOf2(platform);
  const a = foldsCase(platform) ? p.toLowerCase() : p;
  const r = foldsCase(platform) ? root.toLowerCase() : root;
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}
var insideAny = (p, roots, platform) => roots.some((r) => inside(p, r, platform));
var trustCaches = /* @__PURE__ */ new WeakMap();
function withTrustCache(fs) {
  const own2 = {
    readFile: (p) => fs.readFile(p),
    writeFile: (p, data) => fs.writeFile(p, data),
    rename: (from, to) => fs.rename(from, to),
    link: (existing, newPath) => fs.link(existing, newPath),
    unlink: (p) => fs.unlink(p),
    stat: (p) => fs.stat(p),
    mkdirp: (p, mode) => mode === void 0 ? fs.mkdirp(p) : fs.mkdirp(p, mode),
    readdir: (p) => fs.readdir(p),
    rmrf: (p) => fs.rmrf(p),
    lstat: (p) => fs.lstat(p),
    writeFileExclusive: (p, data) => fs.writeFileExclusive(p, data),
    rmdir: (p) => fs.rmdir(p),
    appendFile: (p, data) => fs.appendFile(p, data),
    realpath: (p) => fs.realpath(p),
    freeBytes: (dir) => fs.freeBytes(dir),
    chmod: (p, mode) => fs.chmod(p, mode)
  };
  trustCaches.set(own2, /* @__PURE__ */ new Map());
  return own2;
}
async function cached(fs, key, compute) {
  const cache = trustCaches.get(fs);
  if (cache === void 0) return compute();
  let p = cache.get(key);
  if (p === void 0) {
    p = compute();
    cache.set(key, p);
  }
  return [...await p];
}
function excludedRoots(cwd, repos, fs, platform, home = null) {
  return cached(fs, JSON.stringify(["roots", platform, cwd, repos, home]), async () => {
    const P = pathOf2(platform);
    const out = [];
    const add = (real) => {
      if (real !== null && !out.includes(real)) out.push(real);
    };
    const homes = [];
    if (home !== null && home !== "" && P.isAbsolute(home)) {
      homes.push(P.normalize(home));
      const real = await realpathOrNull(fs, home);
      if (real !== null) homes.push(real);
    }
    const homeOrAbove = (dir) => homes.some((h) => inside(h, dir, platform));
    for (let dir = cwd; P.isAbsolute(dir) && !homeOrAbove(dir); ) {
      let hasGit = false;
      try {
        hasGit = await fs.lstat(P.join(dir, ".git")) !== null;
      } catch {
        hasGit = false;
      }
      if (hasGit) {
        const real = await realpathOrNull(fs, dir);
        if (real !== null && !homeOrAbove(real)) add(real);
      }
      const parent = P.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const r of repos) add(await realpathOrNull(fs, r));
    return out;
  });
}
function absoluteEntry(entry, platform) {
  if (entry === "" || entry === "." || isUncOrDevice2(entry)) return false;
  return platform === "win32" ? /^[A-Za-z]:[\\/]/.test(entry) : entry.startsWith("/");
}
function filterPath(env, excluded, platform, fs) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const value2 = key === void 0 ? void 0 : env[key];
  if (value2 === void 0 || value2 === "") return Promise.resolve([]);
  return cached(fs, JSON.stringify(["path", platform, excluded, value2]), async () => {
    const P = pathOf2(platform);
    const kept = [];
    for (const entry of value2.split(platform === "win32" ? ";" : ":")) {
      if (!absoluteEntry(entry, platform)) continue;
      const normalized = P.normalize(entry);
      const real = await realpathOrNull(fs, normalized);
      if (real === null || insideAny(real, excluded, platform)) continue;
      kept.push(normalized);
    }
    return kept;
  });
}
async function trustedExe(candidate, excluded, o) {
  const real = await realpathOrNull(o.fs, candidate);
  if (real === null || insideAny(real, excluded, o.platform)) return null;
  try {
    const st = await o.fs.lstat(real);
    if (st === null || !st.isFile) return null;
    if (o.platform === "win32") return real;
    const p = await o.probe.posix(real);
    if (p === null || p.isSymlink || p.isDir) return null;
    if (p.uid !== 0 && (o.euid === null || p.uid !== o.euid)) return null;
    if ((p.mode & 18) !== 0 || (p.mode & 73) === 0) return null;
    return real;
  } catch {
    return null;
  }
}
function withPath(childEnv, source, entries, platform) {
  const env = { ...childEnv };
  const isPath = (k) => k.toUpperCase() === "PATH";
  const key = Object.keys(env).find(isPath) ?? Object.keys(source).find(isPath) ?? "PATH";
  for (const k of Object.keys(env)) if (isPath(k) && k !== key) delete env[k];
  env[key] = entries.join(platform === "win32" ? ";" : ":");
  return env;
}
async function resolveGitPath(env, excluded, o) {
  const P = pathOf2(o.platform);
  const name = o.platform === "win32" ? "git.exe" : "git";
  for (const dir of await filterPath(env, excluded, o.platform, o.fs)) {
    const git = await trustedExe(P.join(dir, name), excluded, o);
    if (git !== null) return git;
  }
  return null;
}

// src/viz/cli/opener.ts
var LAUNCH_URL_RE2 = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#k=[0-9a-f]{64}$/;
var OPEN_TIMEOUT_MS = 5e3;
var LINUX_OPENERS = [
  { exe: "/usr/bin/xdg-open", argv: [] },
  { exe: "/usr/local/bin/xdg-open", argv: [] },
  { exe: "/bin/xdg-open", argv: [] },
  { exe: "/usr/bin/gio", argv: ["open"] }
];
var DISPLAY_SET = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"];
function envValue2(env, name, platform) {
  if (env[name] !== void 0 || platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === void 0 ? void 0 : env[key];
}
function openerEnv(ctx, filtered) {
  const env = { ...ctx.builderEnv };
  for (const name of DISPLAY_SET) {
    const v = ctx.env[name];
    if (v !== void 0 && v !== "") env[name] = v;
  }
  return withPath(env, ctx.env, filtered, ctx.platform);
}
async function planOpener(url, ctx) {
  if (!LAUNCH_URL_RE2.test(url)) return null;
  const excluded = await excludedRoots(ctx.cwd, ctx.repos, ctx.fs, ctx.platform, ctx.home ?? null);
  const trust = { fs: ctx.fs, probe: ctx.ownerProbe, platform: ctx.platform, euid: ctx.uid };
  const filtered = await filterPath(ctx.env, excluded, ctx.platform, ctx.fs);
  const plan = (exe, pre) => ({ exe, argv: [...pre, url], env: openerEnv(ctx, filtered) });
  if (ctx.platform === "win32") {
    const root = envValue2(ctx.env, "SYSTEMROOT", "win32");
    if (root === void 0 || !/^[A-Za-z]:[\\/]/.test(root) || isUncOrDevice2(root)) return null;
    const dir = await ctx.fs.stat(root).catch(() => null);
    if (dir === null || !dir.isDirectory) return null;
    const exe = await trustedExe(win325.join(root, "explorer.exe"), excluded, trust);
    return exe === null ? null : plan(exe, []);
  }
  if (ctx.platform === "darwin") {
    const exe = await trustedExe("/usr/bin/open", excluded, trust);
    return exe === null ? null : plan(exe, []);
  }
  if ((ctx.env.DISPLAY ?? "") === "" && (ctx.env.WAYLAND_DISPLAY ?? "") === "") return null;
  for (const c of LINUX_OPENERS) {
    if (await ctx.fs.lstat(c.exe).catch(() => "unreadable") === null) continue;
    const exe = await trustedExe(c.exe, excluded, trust);
    return exe === null ? null : plan(exe, c.argv);
  }
  for (const dir of filtered) {
    const exe = await trustedExe(posix4.join(dir, "xdg-open"), excluded, trust);
    if (exe !== null) return plan(exe, []);
  }
  return null;
}
function openUrl(url, ctx) {
  return openUrlWith(url, ctx, spawn3);
}
async function openUrlWith(url, ctx, spawnFn) {
  const p = await planOpener(url, ctx);
  if (p === null || !LAUNCH_URL_RE2.test(url) || p.argv[p.argv.length - 1] !== url) return false;
  return new Promise((resolve2) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve2(ok);
    };
    const timer = setTimeout(() => done(true), OPEN_TIMEOUT_MS);
    try {
      const child = spawnFn(p.exe, p.argv, { shell: false, detached: true, windowsHide: true, stdio: "ignore", cwd: ctx.dataDir, env: p.env });
      child.unref();
      child.on("error", () => done(false));
      child.on("exit", (code) => done(ctx.platform === "win32" || code === 0));
    } catch {
      done(false);
    }
  });
}

// src/viz/cli/ownerProbe.ts
import { spawn as spawn4 } from "node:child_process";
import { lstat } from "node:fs/promises";
import { win32 as win326 } from "node:path";
var RUN_TIMEOUT_MS = 1e4;
var RUN_MAX_BYTES = 64 * 1024;
var SID = "S-1-[0-9]+(?:-[0-9]+)+";
var WHOAMI_LINE_RE = new RegExp(`^"[^"]*","(${SID})"\\r?\\n?$`);
var WINDOWS_ACL_COMMAND = "$ErrorActionPreference = 'Stop'; $a = Get-Acl -LiteralPath $env:COWORK_ACL_PATH; Write-Output $a.Sddl";
function systemRoot() {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "SYSTEMROOT");
  const v = key === void 0 ? void 0 : process.env[key];
  return v !== void 0 && /^[A-Za-z]:[\\/]/.test(v) && !isUncOrDevice2(v) ? v : null;
}
function runSystem32(root, exe, args, extra = {}) {
  const system32 = win326.join(root, "System32");
  return new Promise((resolve2) => {
    let settled = false;
    const chunks = [];
    let size = 0;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve2(r);
    };
    let child;
    try {
      child = spawn4(win326.join(system32, ...exe), [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        cwd: system32,
        env: { SystemRoot: root, ...extra }
      });
    } catch {
      resolve2(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, RUN_TIMEOUT_MS);
    child.on("error", () => done(null));
    child.stdout?.on("data", (d) => {
      size += d.length;
      if (size > RUN_MAX_BYTES) {
        child.kill();
        done(null);
        return;
      }
      chunks.push(d);
    });
    child.on("close", (code) => done({ code, out: Buffer.concat(chunks).toString("utf8") }));
  });
}
async function userSid(root) {
  const r = await runSystem32(root, ["whoami.exe"], ["/user", "/fo", "csv", "/nh"]);
  if (r === null || r.code !== 0) return null;
  return WHOAMI_LINE_RE.exec(r.out)?.[1] ?? null;
}
async function windowsAcl(dir) {
  const root = systemRoot();
  if (root === null) return null;
  const [sid, acl] = await Promise.all([
    userSid(root),
    runSystem32(root, ["WindowsPowerShell", "v1.0", "powershell.exe"], ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_COMMAND], { COWORK_ACL_PATH: dir })
  ]);
  if (sid === null || acl === null || acl.code !== 0) return null;
  const lines = acl.out.split(/\r?\n/).filter((l) => l !== "");
  return lines.length === 1 && lines[0].trim() === lines[0] ? { sddl: lines[0], userSid: sid } : null;
}
async function windowsProtect(dir) {
  const root = systemRoot();
  if (root === null || !/^[A-Za-z]:[\\/]/.test(dir) || isUncOrDevice2(dir)) return false;
  const sid = await userSid(root);
  if (sid === null) return false;
  const r = await runSystem32(root, ["icacls.exe"], [
    dir,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
    "/L"
  ]);
  return r !== null && r.code === 0;
}
var realOwnerProbe = {
  async posix(path) {
    try {
      const s = await lstat(path);
      return { uid: s.uid, mode: s.mode, isDir: s.isDirectory(), isSymlink: s.isSymbolicLink() };
    } catch {
      return null;
    }
  },
  euid: () => typeof process.geteuid === "function" ? process.geteuid() : null,
  windows: windowsAcl,
  protectDir: windowsProtect
};

// src/viz/cli/spawn.ts
import { spawn as spawn5, spawnSync as spawnSync2 } from "node:child_process";
import { closeSync, constants, lstatSync as lstatSync2, mkdirSync, openSync } from "node:fs";
import { posix as posix5, win32 as win327 } from "node:path";
var READY_TIMEOUT_MS = 5e3;
var READY_MAX_BYTES = 512;
var READY_REFUSE_CODES = /* @__PURE__ */ new Set([
  "RF_VIZ_START_FAILED",
  "RF_VIZ_BIND_FAILED",
  "RF_VIZ_NO_ROOMS",
  "RF_VIZ_REPO_NOT_LIVE",
  "RF_VIZ_DEMO_INVALID",
  "START_TOOL_VERSION"
]);
var START_FAILED = Object.freeze({ refuse: "RF_VIZ_START_FAILED" });
var LAUNCH_RE = /^[0-9a-f]{64}$/;
var TASKKILL_TIMEOUT_MS2 = 1e4;
var isPort = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 65535;
var sameKeys = (o, keys) => {
  const own2 = Object.keys(o);
  return own2.length === keys.length && keys.every((k) => own2.includes(k));
};
function parseReadyLine(buf) {
  if (buf.length === 0 || buf.length > READY_MAX_BYTES || buf.indexOf(10) !== buf.length - 1) return null;
  let text;
  let o;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, buf.length - 1));
    if (text.trim() !== text) return null;
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const r = o;
  if (r.v !== 1) return null;
  if (sameKeys(r, ["v", "port", "launch"])) {
    return isPort(r.port) && typeof r.launch === "string" && LAUNCH_RE.test(r.launch) ? { port: r.port, launch: r.launch } : null;
  }
  if (typeof r.refuse !== "string" || !READY_REFUSE_CODES.has(r.refuse)) return null;
  if (sameKeys(r, ["v", "refuse"])) return { refuse: r.refuse };
  if (sameKeys(r, ["v", "refuse", "line"]) && r.refuse === "RF_VIZ_DEMO_INVALID" && Number.isSafeInteger(r.line) && r.line >= 0) {
    return { refuse: r.refuse, line: r.line };
  }
  return null;
}
var VIEWER_MAX_OLD_SPACE_MB = 150;
var VIEWER_OLD_SPACE_ROOM_MB = 16;
var VIEWER_OLD_SPACE_BASE_ROOMS = 8;
var VIEWER_ROOMS_MAX = 32;
function viewerOldSpaceMb(rooms) {
  const n = Math.min(Math.max(0, Math.floor(rooms)), VIEWER_ROOMS_MAX);
  return VIEWER_MAX_OLD_SPACE_MB + VIEWER_OLD_SPACE_ROOM_MB * Math.max(0, n - VIEWER_OLD_SPACE_BASE_ROOMS);
}
function roomsAtSpawn(a) {
  if (a.repos.length > 0) return a.repos.length;
  return typeof a.demo === "string" ? VIEWER_ROOMS_MAX : 0;
}
function viewerArgv(a) {
  const argv2 = [`--max-old-space-size=${viewerOldSpaceMb(roomsAtSpawn(a))}`, a.vizJs, "serve", "--data-dir", a.dataDir, "--lang", a.lang, "--sha256", a.sha256];
  if (a.repos.length > 0) {
    if (a.git === null || a.git === "") throw new Error("viewerArgv: --repo needs the resolved --git (R-V13)");
    argv2.push("--git", a.git);
    for (const p of a.repos) argv2.push("--repo", p);
  } else if (a.demo === true) {
    argv2.push("--demo");
  } else if (typeof a.demo === "string") {
    argv2.push(`--demo=${a.demo}`);
  }
  return argv2;
}
var VIEWER_STDERR_FILE = "viz-stderr.txt";
var VIEWER_STDERR_MAX_BYTES = 1048576;
var STDERR_DIR = "log";
function openViewerStderr(dataDir, platform) {
  const p = platform === "win32" ? win327 : posix5;
  const dir = p.join(dataDir, STDERR_DIR);
  const file = p.join(dir, VIEWER_STDERR_FILE);
  try {
    try {
      mkdirSync(dir, { mode: 448 });
    } catch (e) {
      if (e.code !== "EEXIST") return null;
    }
    const l = lstatSync2(file, { throwIfNoEntry: false });
    if (l !== void 0 && !l.isFile()) return null;
    const big = l !== void 0 && l.size > VIEWER_STDERR_MAX_BYTES;
    const nofollow = constants.O_NOFOLLOW ?? 0;
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | (big ? constants.O_TRUNC : constants.O_APPEND) | nofollow, 384);
    return {
      fd,
      close: () => {
        try {
          closeSync(fd);
        } catch {
        }
      }
    };
  } catch {
    return null;
  }
}
function spawnViewer(a) {
  return spawnViewerWith(a, { spawn: spawn5, killTree: killTree2, stderr: openViewerStderr });
}
function spawnViewerWith(a, d) {
  return new Promise((resolve2) => {
    let child;
    let argv2;
    try {
      argv2 = viewerArgv(a);
    } catch {
      resolve2(START_FAILED);
      return;
    }
    const err = d.stderr?.(a.dataDir, a.platform) ?? null;
    try {
      child = d.spawn(a.execPath, argv2, {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", err === null ? "ignore" : err.fd],
        env: a.env,
        cwd: a.dataDir
      });
    } catch {
      resolve2(START_FAILED);
      return;
    } finally {
      err?.close();
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    let exited = false;
    let ended = false;
    const finish = (line) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stdout?.destroy();
      child.unref();
      if (line !== null) {
        resolve2(line);
        return;
      }
      const pid = child.pid;
      const running = !exited && child.exitCode === null && child.signalCode === null;
      const kill = pid !== void 0 && (a.platform !== "win32" || running);
      void (kill ? d.killTree(child, a.platform, a.systemRoot) : Promise.resolve()).then(() => resolve2(START_FAILED));
    };
    const judge = () => finish(parseReadyLine(Buffer.concat(chunks)));
    const timer = setTimeout(() => finish(null), READY_TIMEOUT_MS);
    child.on("error", () => finish(null));
    child.on("exit", () => {
      exited = true;
      if (ended) judge();
    });
    child.stdout?.on("data", (d2) => {
      chunks.push(d2);
      size += d2.length;
      if (size > READY_MAX_BYTES) {
        finish(null);
        return;
      }
      const buf = Buffer.concat(chunks);
      if (buf.includes(10)) finish(parseReadyLine(buf));
    });
    child.stdout?.on("end", () => {
      ended = true;
      if (exited) judge();
    });
  });
}
var KILL_GRACE_MS = 2e3;
var KILL_POLL_MS = 50;
function killTree2(child, platform, systemRoot2) {
  return killTreeWith(child, platform, systemRoot2, { killGroup: (pgid, signal) => {
    process.kill(-pgid, signal);
  } });
}
async function killTreeWith(child, platform, systemRoot2, d) {
  const pid = child.pid;
  if (pid === void 0 || !Number.isSafeInteger(pid) || pid <= 0) return;
  const signalGroup = (signal) => {
    try {
      d.killGroup(pid, signal);
      return true;
    } catch (e) {
      return signal === 0 && e.code === "EPERM";
    }
  };
  if (platform !== "win32") {
    if (!signalGroup("SIGTERM")) return;
    for (let waited = 0; waited < KILL_GRACE_MS; waited += KILL_POLL_MS) {
      await new Promise((r) => {
        setTimeout(r, KILL_POLL_MS);
      });
      if (!signalGroup(0)) return;
    }
    signalGroup("SIGKILL");
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const killOne = () => {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  };
  if (systemRoot2 === null || !/^[A-Za-z]:[\\/]/.test(systemRoot2) || isUncOrDevice2(systemRoot2)) {
    killOne();
    return;
  }
  const exe = win327.join(systemRoot2, "System32", "taskkill.exe");
  let ok = false;
  try {
    const r = spawnSync2(exe, ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      cwd: systemRoot2,
      env: { SystemRoot: systemRoot2 },
      timeout: TASKKILL_TIMEOUT_MS2
    });
    ok = r.error === void 0 && r.status === 0;
  } catch {
    ok = false;
  }
  if (!ok) killOne();
}

// src/viz/cli/strings.ts
var EN_VIZ_CLI = {
  UI_VIZ_OPENED: { text: "Opened the read-only viewer in your browser. It stops 10 minutes after you close the tab." },
  UI_VIZ_URL: { text: "Open this link in your browser (it works once, within 2 minutes): {url}", params: { url: "url" } },
  UI_VIZ_OPEN_FAILED: { text: "Could not open a browser from here. To open the read-only viewer, run in a terminal: {cmd}", params: { cmd: "cmd" } },
  UI_VIZ_TERMINAL_ONLY: { text: "The read-only viewer opens only from a terminal. Run there: {cmd}", params: { cmd: "cmd" } },
  RF_VIZ_START_FAILED: {
    text: "cowork-sync: the viewer did not start (no ready report within 5 seconds, or its data folder failed the owner check) [RF_VIZ_START_FAILED]\nnext: /cowork doctor"
  },
  RF_VIZ_BIND_FAILED: { text: "cowork-sync: the viewer could not listen on 127.0.0.1 [RF_VIZ_BIND_FAILED]\nnext: /cowork doctor" },
  RF_VIZ_NO_ROOMS: {
    text: "cowork-sync: no room to show; pass --repo with the folder of a repository where cowork-sync runs, or --demo for demo data [RF_VIZ_NO_ROOMS]\nnext: /cowork start"
  },
  RF_VIZ_REPO_NOT_LIVE: {
    text: "cowork-sync: that folder is not a main worktree with a fetched cowork-sync board [RF_VIZ_REPO_NOT_LIVE]\nnext: /cowork start"
  },
  RF_VIZ_DEMO_INVALID: {
    text: "cowork-sync: the demo file is not a valid cowork-viz-demo/1 log (first bad line: {n}) [RF_VIZ_DEMO_INVALID]\nnext: (none: fix the demo file)",
    params: { n: "n" }
  },
  RF_UNKNOWN_FLAG: {
    text: "cowork-sync: unknown flag; view takes --no-open and either --demo, --demo=FILE or --repo FOLDER (repeatable) [RF_UNKNOWN_FLAG]\nnext: (none: run view with only those flags)"
  },
  START_TOOL_VERSION: {
    text: "cowork-sync: git 2.43 or newer is needed, installed outside your repositories [START_TOOL_VERSION]\nnext: /cowork doctor"
  },
  UI_INTERNAL_ERROR: {
    text: "cowork-sync: internal error; nothing was changed. To collect a report, run /cowork doctor --bundle with a folder outside this repository."
  }
};

// src/viz/cli/view.ts
function outputMode(isTTY, env) {
  if (isTTY) return "tty";
  return env.CLAUDECODE !== void 0 ? "slash" : "pipe";
}
var UNKNOWN_FLAG = Object.freeze({ refuse: "RF_UNKNOWN_FLAG" });
function parseViewFlags(argv2) {
  let noOpen = false;
  let demo = null;
  const repos = [];
  for (let i = 0; i < argv2.length; i += 1) {
    const a = argv2[i];
    if (a === "--no-open") {
      if (noOpen) return UNKNOWN_FLAG;
      noOpen = true;
    } else if (a === "--demo" || a.startsWith("--demo=")) {
      const file = a === "--demo" ? true : a.slice("--demo=".length);
      if (demo !== null || file === "") return UNKNOWN_FLAG;
      demo = file;
    } else if (a === "--repo") {
      const p = argv2[i + 1];
      if (p === void 0 || p === "" || p.startsWith("--")) return UNKNOWN_FLAG;
      repos.push(p);
      i += 1;
    } else {
      return UNKNOWN_FLAG;
    }
  }
  if (demo !== null && repos.length > 0) return UNKNOWN_FLAG;
  return { noOpen, demo, repos };
}
function langOf(locale) {
  const [language = "", second = ""] = locale.split(/[-_]/);
  switch (language.toLowerCase()) {
    case "ko":
      return "ko";
    case "ja":
      return "ja";
    case "fr":
      return "fr";
    case "es":
      return "es";
    case "zh":
      if (/^[A-Za-z]{4}$/.test(second)) return second.toLowerCase() === "hans" ? "zh-CN" : "en";
      return second.toUpperCase() === "CN" || second.toUpperCase() === "SG" ? "zh-CN" : "en";
    default:
      return "en";
  }
}
var URL_RE = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#k=[0-9a-f]{64}$/;
var LAUNCH_RE2 = /^[0-9a-f]{64}$/;
function launchUrl(port, launch) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || typeof launch !== "string" || !LAUNCH_RE2.test(launch)) return null;
  const url = `http://127.0.0.1:${port}/#k=${launch}`;
  return URL_RE.test(url) ? url : null;
}
var pathOf3 = (platform) => platform === "win32" ? win328 : posix6;
var terminalShell = (platform) => platform === "win32" ? "powershell" : "sh";
var SH_DQ_SPECIAL = /["$`\\!]/;
var PS_DQ_SPECIAL = /[$`"“”„]/;
var PS_SQ = /['‘’‚‛]/g;
function shellWord(s, shell) {
  if (shell === "sh") return SH_DQ_SPECIAL.test(s) ? `'${s.split("'").join("'\\''")}'` : `"${s}"`;
  return PS_DQ_SPECIAL.test(s) ? `'${s.replace(PS_SQ, (q) => q + q)}'` : `"${s}"`;
}
function terminalCommand(env, flags) {
  const shell = terminalShell(env.platform);
  const q = (s) => shellWord(s, shell);
  const abs = (p) => absolutize(p, env.cwd, env.platform) ?? p;
  const words = ["node", q(pathOf3(env.platform).join(env.pluginRoot, "dist", "cli.js")), "view"];
  if (flags.noOpen) words.push("--no-open");
  if (flags.demo === true) words.push("--demo");
  else if (typeof flags.demo === "string") words.push(`--demo=${q(abs(flags.demo))}`);
  for (const r of flags.repos) words.push("--repo", q(abs(r)));
  return words.join(" ");
}
async function systemRootOf2(env) {
  if (env.platform !== "win32") return null;
  const key = Object.keys(env.env).find((k) => k.toUpperCase() === "SYSTEMROOT");
  const root = key === void 0 ? void 0 : env.env[key];
  if (root === void 0 || !/^[A-Za-z]:[\\/]/.test(root) || isUncOrDevice2(root)) return null;
  const st = await env.fs.stat(root).catch(() => null);
  return st !== null && st.isDirectory ? root : null;
}
async function viewTty(flags, env, lang, say, refuse2) {
  const dataDir = resolveDataDir(env.env, env.home, env.platform);
  if (dataDir === null) return refuse2("RF_VIZ_START_FAILED");
  const verdict = await verifyDataDir(dataDir, { fs: env.fs, probe: env.ownerProbe, platform: env.platform, create: true });
  if (!verdict.ok) return refuse2("RF_VIZ_START_FAILED");
  const repos = [];
  for (const r of flags.repos) {
    const abs = absolutize(r, env.cwd, env.platform);
    if (abs === null) return refuse2("RF_VIZ_REPO_NOT_LIVE");
    repos.push(abs);
  }
  let demo = flags.demo;
  if (typeof demo === "string") {
    const abs = absolutize(demo, env.cwd, env.platform);
    if (abs === null) return refuse2("RF_VIZ_DEMO_INVALID", { n: 0 });
    demo = abs;
  }
  const fs = withTrustCache(env.fs);
  const excluded = await excludedRoots(env.cwd, repos, fs, env.platform, env.home);
  let git = null;
  if (repos.length > 0) {
    git = await resolveGitPath(env.env, excluded, { fs, probe: env.ownerProbe, platform: env.platform, euid: env.uid });
    if (git === null) return refuse2("START_TOOL_VERSION");
  }
  const vizJs = pathOf3(env.platform).join(env.pluginRoot, "dist", "viz.js");
  let sha256;
  try {
    sha256 = createHash("sha256").update(await env.fs.readFile(vizJs)).digest("hex");
  } catch {
    return refuse2("RF_VIZ_START_FAILED");
  }
  const builderEnv = buildDaemonEnv({ ...env.env }, []);
  const viewerEnv = withPath(builderEnv, env.env, await filterPath(env.env, excluded, env.platform, fs), env.platform);
  const ready = await env.spawnViewer({
    execPath: env.execPath,
    vizJs,
    dataDir,
    lang,
    sha256,
    repos,
    demo,
    git,
    env: viewerEnv,
    platform: env.platform,
    systemRoot: await systemRootOf2(env)
  });
  if ("refuse" in ready) {
    if (!READY_REFUSE_CODES.has(ready.refuse)) return refuse2("RF_VIZ_START_FAILED");
    return refuse2(ready.refuse, ready.refuse === "RF_VIZ_DEMO_INVALID" ? { n: ready.line ?? null } : {});
  }
  const url = launchUrl(ready.port, ready.launch);
  if (url === null) return refuse2("RF_VIZ_START_FAILED");
  if (!flags.noOpen) {
    const ctx = {
      platform: env.platform,
      env: env.env,
      builderEnv,
      dataDir,
      cwd: env.cwd,
      repos,
      fs,
      uid: env.uid,
      ownerProbe: env.ownerProbe,
      home: env.home
    };
    if (await env.openUrl(url, ctx).catch(() => false)) {
      say("UI_VIZ_OPENED");
      return 0;
    }
  }
  say("UI_VIZ_URL", { url });
  return 0;
}
async function runView(argv2, env) {
  let channel = "terminal";
  let lang = "en";
  try {
    registerCatalog("en", EN_VIZ_CLI);
    const mode = outputMode(env.isTTY, env.env);
    channel = mode === "slash" ? "slash" : "terminal";
    lang = langOf(env.locale);
    const [c, l] = [channel, lang];
    const say = (code, p = {}) => env.out(render(code, p, c, l));
    const refuse2 = (code, p = {}) => {
      env.err(render(code, p, c, l));
      return 1;
    };
    const flags = parseViewFlags(argv2);
    if ("refuse" in flags) return refuse2(flags.refuse);
    if (mode !== "tty") {
      say("UI_VIZ_TERMINAL_ONLY", { cmd: terminalCommand(env, flags) });
      return 0;
    }
    return await viewTty(flags, env, lang, say, refuse2);
  } catch {
    try {
      env.err(render("UI_INTERNAL_ERROR", {}, channel, lang));
    } catch {
    }
    return 2;
  }
}
function once(f) {
  let done = false;
  let v;
  return () => {
    if (!done) {
      v = f();
      done = true;
    }
    return v;
  };
}
function realCliEnv() {
  const P = pathOf3(process.platform);
  const pluginRoot = once(() => P.dirname(P.dirname(fileURLToPath(import.meta.url))));
  const cwd = once(() => process.cwd());
  const isTTY = once(() => process.stdout.isTTY === true);
  const home = once(() => homedir());
  const locale = once(() => Intl.DateTimeFormat().resolvedOptions().locale);
  const uid = once(() => typeof process.geteuid === "function" ? process.geteuid() : null);
  return {
    get pluginRoot() {
      return pluginRoot();
    },
    get cwd() {
      return cwd();
    },
    env: process.env,
    platform: process.platform,
    get isTTY() {
      return isTTY();
    },
    get home() {
      return home();
    },
    get locale() {
      return locale();
    },
    execPath: process.execPath,
    get uid() {
      return uid();
    },
    out: (s) => {
      process.stdout.write(`${s}
`);
    },
    err: (s) => {
      process.stderr.write(`${s}
`);
    },
    fs: realFs,
    clock: realClock,
    ownerProbe: realOwnerProbe,
    spawnViewer,
    openUrl
  };
}

// src/git/enc.ts
import { Buffer as Buffer2 } from "node:buffer";
var ENC_MAX_BYTES = 150;
var EncTooLongError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "EncTooLongError";
  }
};
var LONE_SURROGATE2 = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function isUnreservedByte(b) {
  return b >= 48 && b <= 57 || // 0-9
  b >= 65 && b <= 90 || // A-Z
  b >= 97 && b <= 122 || // a-z
  b === 95 || // _
  b === 45;
}
function enc(branch) {
  if (branch.length === 0) {
    throw new Error("enc: the branch name is empty");
  }
  if (LONE_SURROGATE2.test(branch)) {
    throw new Error("enc: the branch name contains a lone UTF-16 surrogate");
  }
  let out = "";
  for (const b of Buffer2.from(branch, "utf8")) {
    out += isUnreservedByte(b) ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0");
    if (out.length > ENC_MAX_BYTES) {
      throw new EncTooLongError(`enc: the encoded branch name exceeds ${ENC_MAX_BYTES} bytes`);
    }
  }
  return out;
}

// src/git/oid.ts
var OidError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "OidError";
  }
};
var OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function parseOid(s) {
  const t = typeof s === "string" && s.endsWith("\n") ? s.slice(0, -1) : s;
  if (typeof t !== "string" || !OID_RE.test(t)) {
    const shown = typeof t === "string" ? JSON.stringify(t.length > 80 ? `${t.slice(0, 80)}...` : t) : typeof t;
    throw new OidError(`not an object id: ${shown}`);
  }
  return t;
}
function isOid(x) {
  return typeof x === "string" && OID_RE.test(x);
}
function oid12(o) {
  return o.slice(0, 12);
}

// src/sec/validators.ts
var HEX128 = /^[0-9a-f]{32}$/;
var SEQ = /^[1-9][0-9]*$/;
var ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
function validOpId(s) {
  const parts = s.split("/");
  return parts.length === 3 && HEX128.test(parts[0] ?? "") && HEX128.test(parts[1] ?? "") && SEQ.test(parts[2] ?? "");
}
function validCsId(s) {
  const parts = s.split("/");
  if (parts.length === 2) return HEX128.test(parts[0] ?? "") && SEQ.test(parts[1] ?? "");
  if (parts.length === 3) return HEX128.test(parts[0] ?? "") && parts[1] === "human" && SEQ.test(parts[2] ?? "");
  return false;
}
function validId(kind, s) {
  if (typeof s !== "string") return false;
  switch (kind) {
    case "op":
      return validOpId(s);
    case "ulid":
      return ULID.test(s);
    case "cs":
      return validCsId(s);
    case "hex128":
      return HEX128.test(s);
  }
}
var NAME = /^[\p{L}\p{M}\p{N}_ .'-]{1,64}$/u;
function validName(s) {
  return typeof s === "string" && NAME.test(s);
}

// src/engine/refs.ts
var RELEASE_NAMESPACE = Object.freeze({ remotePrefix: "refs/cowork/" });
var TEST_PREFIX_RE = /^refs\/cowork-ci\/[0-9A-Za-z_-]{1,40}\/$/;
function validBranch(b) {
  if (typeof b !== "string" || b.length === 0 || b === "@") return false;
  if (/[\0-\x20\x7f~^:?*[\\]/.test(b) || b.includes("..") || b.includes("@{") || b.includes("//")) return false;
  if (b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".")) return false;
  return b.split("/").every((c) => !c.startsWith(".") && !c.endsWith(".lock"));
}
function counter(what, n) {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${what}: n must be a safe integer >= 1, got ${String(n)}`);
  return n;
}
function refNames(branch, ns) {
  const prefix = ns.remotePrefix;
  if (prefix !== RELEASE_NAMESPACE.remotePrefix && !TEST_PREFIX_RE.test(prefix)) {
    throw new Error(`refNames: not a cowork namespace ${JSON.stringify(prefix)}`);
  }
  const e = enc(branch);
  if (!validBranch(branch)) throw new Error(`refNames: invalid branch name ${JSON.stringify(branch)}`);
  const remoteBoard = `${prefix}${e}/board`;
  const remoteCode = `${prefix}${e}/code`;
  const remoteBranch = `refs/heads/${branch}`;
  const localBoard = `refs/cowork-remote/${e}/board`;
  const localCode = `refs/cowork-remote/${e}/code`;
  const localBranch = `refs/cowork-remote/${e}/branch`;
  const local = `refs/cowork-local/${e}/`;
  const displacedPrefix = `${prefix}${e}/displaced/`;
  const fetchSpecs = Object.freeze([
    Object.freeze({ remote: remoteBoard, local: localBoard }),
    Object.freeze({ remote: remoteCode, local: localCode }),
    Object.freeze({ remote: remoteBranch, local: localBranch })
  ]);
  return Object.freeze({
    branch,
    e,
    remoteBoard,
    remoteCode,
    remoteBranch,
    localBoard,
    localCode,
    localBranch,
    state: `${local}state`,
    holds: `${local}holds`,
    displacedPrefix,
    displaced: (o) => `${displacedPrefix}${oid12(parseOid(o))}`,
    incident: (n) => `${local}incident-${counter("incident", n)}`,
    incidentOwn: (n) => `${local}incident-${counter("incidentOwn", n)}-own`,
    probe: (peer) => {
      if (!validId("hex128", peer)) throw new Error(`probe: not a peer id ${JSON.stringify(peer)}`);
      return `${prefix}probe-${peer}`;
    },
    fetchSpecs
  });
}

// src/cli/args.ts
var VERBS = Object.freeze(["start", "stop", "status", "view", "help"]);
var START_OPTIONS = /* @__PURE__ */ new Set(["branch", "publish", "remote", "name"]);
function branchOk(branch) {
  try {
    refNames(branch, RELEASE_NAMESPACE);
    return true;
  } catch (e) {
    return e instanceof EncTooLongError;
  }
}
function parseCoworkArgs(argv2) {
  const verb = argv2[0];
  if (verb === void 0 || verb === "help" || verb === "-h" || verb === "--help") {
    return argv2.length <= 1 ? { verb: "help" } : { usage: "help takes no options" };
  }
  if (verb === "stop" || verb === "status") {
    if (argv2.includes("--help") || argv2.includes("-h")) return { verb: "help" };
    return argv2.length === 1 ? { verb } : { usage: `${verb} takes no options` };
  }
  if (verb !== "start") return { usage: `unknown command ${JSON.stringify(verb)}` };
  const opts = /* @__PURE__ */ new Map();
  for (let i = 1; i < argv2.length; i++) {
    const a = argv2[i];
    if (a === "--help" || a === "-h") return { verb: "help" };
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(a);
    if (m === null) return { usage: `unexpected argument ${JSON.stringify(a)}` };
    const key = m[1];
    let value2 = m[2];
    if (!START_OPTIONS.has(key)) return { usage: `--${key} is not an option of start` };
    if (value2 === void 0) {
      const next = argv2[i + 1];
      if (next === void 0 || next.startsWith("--")) return { usage: `--${key} needs a value` };
      value2 = next;
      i++;
    }
    if (opts.has(key)) return { usage: `--${key} given twice` };
    if (value2.length === 0 || /[\0\r\n]/.test(value2)) return { usage: `--${key} needs a value` };
    opts.set(key, value2);
  }
  const branch = opts.get("branch") ?? null;
  if (branch !== null && !branchOk(branch)) return { usage: "--branch: not a branch name git accepts" };
  const publish = opts.get("publish") ?? null;
  if (publish !== null && publish !== "all" && publish !== "none") return { usage: "--publish is all or none" };
  const name = opts.get("name") ?? null;
  if (name !== null && !validName(name)) return { usage: "--name: letters, digits, spaces and _ . ' - only, at most 64" };
  const remote = opts.get("remote") ?? null;
  if (remote !== null && remote.startsWith("-")) return { usage: "--remote: not a remote name" };
  return { verb: "start", branch, publish, remote, name };
}
function daemonRunArgv(repo, branch, o) {
  const argv2 = ["run", "--repo", repo, "--branch", branch];
  if (o.publish !== null) argv2.push(`--publish=${o.publish}`);
  if (o.remote !== null) argv2.push("--remote", o.remote);
  if (o.name !== null) argv2.push("--name", o.name);
  return argv2;
}

// src/cli/clone.ts
import { join as join2, resolve } from "node:path";

// src/ports/random.ts
var ULID_TIME_MAX = 2 ** 48 - 1;

// src/board/canonicalJson.ts
var MAX_JSON_DEPTH = 64;
function isPlainObject(v) {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function write(v, out, open, depth) {
  if (v === null) {
    out.push("null");
    return;
  }
  switch (typeof v) {
    case "boolean":
      out.push(v ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(v)) throw new RangeError(`canonicalJson: non-finite number ${String(v)}`);
      out.push(JSON.stringify(v));
      return;
    case "string":
      out.push(JSON.stringify(v));
      return;
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: ${typeof v} is not JSON`);
  }
  const o = v;
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`canonicalJson: nesting deeper than ${MAX_JSON_DEPTH}`);
  if (open.has(o)) throw new TypeError("canonicalJson: cyclic value");
  open.add(o);
  if (Array.isArray(o)) {
    const arr = o;
    out.push("[");
    for (let i = 0; i < arr.length; i++) {
      if (!(i in arr)) throw new TypeError(`canonicalJson: sparse array hole at index ${i}`);
      if (i > 0) out.push(",");
      write(arr[i], out, open, depth + 1);
    }
    out.push("]");
  } else {
    if (!isPlainObject(o)) throw new TypeError(`canonicalJson: ${o.constructor?.name ?? "object"} is not a plain object`);
    const rec = o;
    const keys = Object.keys(rec).filter((k) => rec[k] !== void 0).sort();
    out.push("{");
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (i > 0) out.push(",");
      out.push(JSON.stringify(k), ":");
      write(rec[k], out, open, depth + 1);
    }
    out.push("}");
  }
  open.delete(o);
}
function canonicalJson(v) {
  const out = [];
  write(v, out, /* @__PURE__ */ new Set(), 1);
  return out.join("");
}
function canonicalBytes(v) {
  return Buffer.from(canonicalJson(v), "utf8");
}

// src/board/ops.ts
var REASON_CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;

// src/board/boardCommit.ts
var CS_PATHS_MAX = 256;
var CS_PATHS_MAX_BYTES = CS_PATHS_MAX * 4096 + CS_PATHS_MAX - 1;
var UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// src/board/fold.ts
var EVENT_KINDS = /* @__PURE__ */ new Set(["K1", "K2", "K3", "K4", "K5", "K6", "K7", "breach", "freeze", "unfreeze", "incident", "nonretryable", "health"]);
var CID_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
var isInt = (x, min) => typeof x === "number" && Number.isSafeInteger(x) && x >= min;
function countRecords(s) {
  let ended = 0;
  for (const seat of Object.values(s.seats)) if (seat.status === "ended") ended++;
  return Object.keys(s.claims).length + Object.keys(s.requests).length + Object.keys(s.holds).length + Object.keys(s.events).length + Object.keys(s.notes).length + ended;
}
function serializeFold(s) {
  return canonicalBytes(s);
}
var STATE_KEYS = ["caps", "claims", "events", "height", "holds", "last_save", "notes", "peers", "proto", "record_count", "requests", "seats", "teamRegionSpec", "v"];
var PEER_KEYS = ["coauthor_optin", "config_fingerprint", "display", "epoch", "last_height", "last_seq", "plugin_sha", "plugin_version", "regionSpec", "retired_epochs", "status"];
var CAPS_KEYS = ["custom_refs", "delete", "lease", "push_options", "two_parent_ok"];
var EVENT_KEYS = ["height", "kind", "op_id", "reason_code", "refs"];
var SAVE_KEYS = ["chain_base", "height", "save_commit", "saved_live"];
var PEER_STATUS = /* @__PURE__ */ new Set(["active", "left", "absent"]);
function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function keysAre(o, keys) {
  const k = Object.keys(o).sort();
  return k.length === keys.length && k.every((x, i) => x === keys[i]);
}
var isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
function toPeer(v) {
  if (!isObj(v) || !keysAre(v, PEER_KEYS)) return null;
  const { epoch, status: status2, retired_epochs: retired, display, plugin_version: pv, plugin_sha: ps, regionSpec, config_fingerprint: cf, coauthor_optin: co, last_seq: ls, last_height: lh } = v;
  if (typeof epoch !== "string" || !validId("hex128", epoch) || typeof status2 !== "string" || !PEER_STATUS.has(status2)) return null;
  if (!isStrArray(retired) || !retired.every((e) => validId("hex128", e))) return null;
  if (typeof display !== "string" || typeof pv !== "string" || typeof ps !== "string" || typeof regionSpec !== "string") return null;
  if (co !== false && typeof co !== "string") return null;
  if (!isInt(ls, 0) || !isInt(lh, -1)) return null;
  return {
    epoch,
    status: status2,
    retired_epochs: retired,
    display,
    plugin_version: pv,
    plugin_sha: ps,
    regionSpec,
    config_fingerprint: cf,
    coauthor_optin: co,
    last_seq: ls,
    last_height: lh
  };
}
function toSeat(v) {
  if (!isObj(v) || typeof v["permission_mode"] !== "string") return null;
  if (v["status"] === "live" && keysAre(v, ["permission_mode", "status"])) return { status: "live", permission_mode: v["permission_mode"] };
  if (v["status"] === "ended" && keysAre(v, ["ended_height", "permission_mode", "status"]) && isInt(v["ended_height"], 0)) {
    return { status: "ended", permission_mode: v["permission_mode"], ended_height: v["ended_height"] };
  }
  return null;
}
function toEvent(v) {
  if (!isObj(v) || !keysAre(v, EVENT_KEYS)) return null;
  const { kind, refs, reason_code: rc, op_id: opId, height } = v;
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind) || !isStrArray(refs)) return null;
  if (typeof rc !== "string" || !REASON_CODE_RE.test(rc) || typeof opId !== "string" || !validId("op", opId) || !isInt(height, 0)) return null;
  return { kind, refs, reason_code: rc, op_id: opId, height };
}
function toRecord(v, keyOk, conv) {
  if (!isObj(v)) return null;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (!keyOk(k)) return null;
    const t = conv(x);
    if (t === null) return null;
    out[k] = t;
  }
  return out;
}
var seatKeyOk = (k) => {
  const parts = k.split("/");
  return parts.length === 3 && parts.every((p) => validId("hex128", p));
};
function toFoldState(v) {
  if (!isObj(v) || !keysAre(v, STATE_KEYS)) return null;
  if (v["v"] !== 1 || !isInt(v["height"], -1) || !isInt(v["proto"], 0) || typeof v["teamRegionSpec"] !== "string" || !isInt(v["record_count"], 0)) return null;
  const capsV = v["caps"];
  let caps = null;
  if (capsV !== null) {
    if (!isObj(capsV) || !keysAre(capsV, CAPS_KEYS) || !CAPS_KEYS.every((k) => typeof capsV[k] === "boolean")) return null;
    caps = { custom_refs: capsV["custom_refs"], lease: capsV["lease"], delete: capsV["delete"], push_options: capsV["push_options"], two_parent_ok: capsV["two_parent_ok"] };
  }
  const saveV = v["last_save"];
  let lastSave = null;
  if (saveV !== null) {
    if (!isObj(saveV) || !keysAre(saveV, SAVE_KEYS) || !isOid(saveV["save_commit"]) || !isOid(saveV["saved_live"]) || !isOid(saveV["chain_base"]) || !isInt(saveV["height"], 0)) return null;
    lastSave = { save_commit: saveV["save_commit"], saved_live: saveV["saved_live"], chain_base: saveV["chain_base"], height: saveV["height"] };
  }
  const peers = toRecord(v["peers"], (k) => validId("hex128", k), toPeer);
  const seats = toRecord(v["seats"], seatKeyOk, toSeat);
  const events = toRecord(v["events"], (k) => CID_RE.test(k), toEvent);
  const opaque = (x) => isObj(x) ? x : null;
  const claims = opaque(v["claims"]);
  const requests = opaque(v["requests"]);
  const holds = opaque(v["holds"]);
  const notes = opaque(v["notes"]);
  if (peers === null || seats === null || events === null || claims === null || requests === null || holds === null || notes === null) return null;
  const s = {
    v: 1,
    height: v["height"],
    proto: v["proto"],
    teamRegionSpec: v["teamRegionSpec"],
    caps,
    peers,
    seats,
    claims,
    requests,
    holds,
    notes,
    events,
    last_save: lastSave,
    record_count: v["record_count"]
  };
  return countRecords(s) === s.record_count && !datedAbove(s) ? s : null;
}
function datedAbove(s) {
  const h = s.height;
  if (s.last_save !== null && s.last_save.height > h) return true;
  if (Object.values(s.events).some((e) => e.height > h)) return true;
  if (Object.values(s.seats).some((x) => x.ended_height !== void 0 && x.ended_height > h)) return true;
  return Object.values(s.peers).some((p) => p.last_height > h);
}
function parseFold(buf) {
  try {
    const s = toFoldState(JSON.parse(buf.toString("utf8")));
    return s !== null && serializeFold(s).equals(buf) ? s : null;
  } catch {
    return null;
  }
}
function liveSet(s) {
  return Object.keys(s.peers).filter((p) => s.peers[p].status === "active").sort();
}
var READ_CACHE_MAX_BYTES = 16 * 1048576;

// src/cli/statusText.ts
var isObj2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isStr = (v) => typeof v === "string";
var isMs = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
var count = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
function parseStatusJson(buf) {
  let v;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf));
  } catch {
    return null;
  }
  if (!isObj2(v) || v["v"] !== 1) return null;
  const { state, branch, peer_id: peer, freeze_reasons: fr, publish_pause: pp, heartbeat_mono_ms: hb, loop_period_ms: lp } = v;
  const { last_fetch_age_ms: lf, last_push_age_ms: lpush, pending, message_code: mc, message_params: mp } = v;
  if (!isStr(state) || !isStr(branch) || !isStr(peer) || !Array.isArray(fr) || !fr.every(isStr) || !(pp === null || isStr(pp))) return null;
  if (!isMs(hb) || !isMs(lp) || lp === 0 || !(lf === null || isMs(lf)) || !(lpush === null || isMs(lpush)) || !isObj2(pending)) return null;
  const nc = pending["not_converged"];
  return {
    state,
    branch,
    peer_id: peer,
    freeze_reasons: [...fr],
    publish_pause: pp,
    heartbeat_mono_ms: hb,
    loop_period_ms: lp,
    last_fetch_age_ms: lf,
    last_push_age_ms: lpush,
    pending: {
      cs_ready: count(pending["cs_ready"]),
      cs_open: count(pending["cs_open"]),
      holds_active: count(pending["holds_active"]),
      incoming: count(pending["incoming"]),
      not_converged: Array.isArray(nc) ? nc.filter(isStr) : []
    },
    message_code: isStr(mc) ? mc : null,
    message_params: isObj2(mp) ? mp : {}
  };
}
function ageText(ms) {
  const s = Math.max(0, Math.floor(ms / 1e3));
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}
function statusStale(s, nowMachineMono) {
  return nowMachineMono - s.heartbeat_mono_ms > 3 * s.loop_period_ms || s.heartbeat_mono_ms > nowMachineMono + s.loop_period_ms;
}
var MAX_PATHS = 5;
var MAX_MESSAGE = 300;
function notConvergedText(s) {
  const paths = s.pending.not_converged;
  const mp = s.message_params;
  const causes = s.message_code === "NOT_CONVERGED" && Array.isArray(mp["causes"]) && Array.isArray(mp["paths"]) && mp["paths"].length === mp["causes"].length ? { paths: mp["paths"], causes: mp["causes"] } : null;
  const one = (p) => {
    const i = causes === null ? -1 : causes.paths.indexOf(p);
    const c = i < 0 ? null : causes.causes[i];
    if (!isObj2(c) || !isStr(c["cause"])) return p;
    const q = [c["guard"], c["reason"], c["check"]].find(isStr);
    return `${p} (${c["cause"]}${q === void 0 ? "" : `: ${q}`})`;
  };
  const shown = paths.slice(0, MAX_PATHS).map(one).join(", ");
  return paths.length > MAX_PATHS ? `${shown} and ${paths.length - MAX_PATHS} more` : shown;
}
function messageText(s) {
  if (s.message_code === null || s.message_code === "NOT_CONVERGED") return null;
  const params = Object.keys(s.message_params).length === 0 ? "" : ` ${JSON.stringify(s.message_params)}`;
  const text = `${s.message_code}${params}`;
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 3)}...` : text;
}
function statusSummary(i) {
  const lines = [];
  const s = i.status === "unreadable" ? null : i.status;
  if (!i.live && i.status === null) return { lines: [{ code: "UI_COWORK_STATUS_NEVER", params: { c: i.c } }], healthy: false };
  let healthy = false;
  if (!i.live) {
    lines.push({ code: "UI_COWORK_STATUS_DOWN", params: { branch: s?.branch ?? "?", state: s?.state ?? "?", c: i.c } });
  } else if (s === null) {
    lines.push({ code: "UI_COWORK_STATUS_STARTING", params: {} });
  } else if (statusStale(s, i.nowMachineMono)) {
    lines.push({ code: "UI_COWORK_STATUS_STALE", params: { age: ageText(i.nowMachineMono - s.heartbeat_mono_ms), state: s.state } });
  } else {
    lines.push({ code: "UI_COWORK_STATUS_RUNNING", params: { branch: s.branch, peer: s.peer_id.slice(0, 8), state: s.state } });
    healthy = s.state === "ok";
  }
  if (i.status === "unreadable") lines.push({ code: "UI_COWORK_STATUS_UNREADABLE", params: { path: i.files.status } });
  if (s !== null) {
    if (i.peers !== null && i.peers.length > 0) lines.push({ code: "UI_COWORK_STATUS_PEERS", params: { peers: i.peers.join(", ") } });
    const since = Math.max(0, i.nowMachineMono - s.heartbeat_mono_ms);
    const ago = (ms, none) => ms === null ? none : `${ageText(ms + since)} ago`;
    lines.push({ code: "UI_COWORK_STATUS_PUSH", params: { age: ago(s.last_push_age_ms, "none since the daemon started") } });
    lines.push({ code: "UI_COWORK_STATUS_FETCH", params: { age: ago(s.last_fetch_age_ms, "none since the daemon started") } });
    const p = s.pending;
    lines.push({ code: "UI_COWORK_STATUS_PENDING", params: { ready: p.cs_ready, open: p.cs_open, incoming: p.incoming, holds: p.holds_active } });
    if (s.freeze_reasons.length > 0) lines.push({ code: "UI_COWORK_STATUS_FROZEN", params: { reasons: s.freeze_reasons.join(", ") } });
    if (s.publish_pause !== null) lines.push({ code: "UI_COWORK_STATUS_PAUSE", params: { pause: s.publish_pause } });
    if (p.not_converged.length > 0) lines.push({ code: "UI_COWORK_STATUS_NOT_CONVERGED", params: { paths: notConvergedText(s) } });
    const m = messageText(s);
    if (m !== null) lines.push({ code: "UI_COWORK_STATUS_MESSAGE", params: { message: m } });
  }
  lines.push({ code: "UI_COWORK_STATUS_FILES", params: { status: i.files.status, log: i.files.log } });
  return { lines, healthy };
}

// src/cli/clone.ts
async function gitText(git, cwd, args) {
  const r = await git.run(args, { class: "local", cwd });
  return r.code === 0 ? r.stdout.toString("utf8").trim() : null;
}
async function findClone(git, cwd) {
  const top = await gitText(git, cwd, ["rev-parse", "--show-toplevel"]);
  if (top === null || top.length === 0) return null;
  const abs = resolve(top);
  return { top: abs, coworkDir: join2(abs, ".git", "cowork") };
}
function currentBranch(git, top) {
  return gitText(git, top, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}
async function remoteNames(git, top) {
  const out = await gitText(git, top, ["remote"]);
  return out === null ? [] : out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}
async function readLockHolder(fs, coworkDir) {
  try {
    return parseLockHolder(await fs.readFile(join2(coworkDir, DAEMON_LOCK_FILE)));
  } catch {
    return null;
  }
}
async function readStatusFile(fs, coworkDir) {
  let buf;
  try {
    buf = await fs.readFile(join2(coworkDir, STATUS_FILE));
  } catch (e) {
    return typeof e === "object" && e !== null && e.code === "ENOENT" ? null : "unreadable";
  }
  return parseStatusJson(buf) ?? "unreadable";
}
async function activePeers(git, top, branch, self) {
  let state;
  try {
    state = refNames(branch, RELEASE_NAMESPACE).state;
  } catch {
    return null;
  }
  const r = await git.run(["cat-file", "blob", `${state}:journal/keep/fold/state.json`], { class: "local", cwd: top });
  if (r.code !== 0) return null;
  const fold = parseFold(r.stdout);
  if (fold === null) return null;
  return liveSet(fold).map((p) => `${fold.peers[p].display}${p === self ? " (this clone)" : ""}`);
}

// src/cli/strings.ts
var EN_COWORK_CLI = {
  UI_COWORK_HELP: {
    text: "cowork-sync {version}: live sync of one git branch between clones, through the git remote.\n  {c} start [--branch <b>] [--publish=all|none]  start sync in this clone; the daemon keeps running in the background\n  {c} status                                     show the sync state of this clone\n  {c} stop                                       stop the daemon; your files stay as they are\n  {c} view [--no-open] [--demo]                  open the read-only viewer (from a terminal)\n  {c} help                                       this list\nstart also takes --remote <name> and --name <display name>.",
    params: { version: "cmd", c: "cmd" }
  },
  UI_COWORK_STARTED: {
    text: "cowork-sync: sync started on {branch} ({mode}); the daemon keeps running in the background.\nnext: {c} status",
    params: { branch: "cmd", mode: "cmd", c: "cmd" }
  },
  UI_COWORK_STARTING: {
    text: "cowork-sync: the daemon has not reported its start after {secs} s; it keeps trying in the background.\nnext: {c} status",
    params: { secs: "n", c: "cmd" }
  },
  UI_COWORK_ALREADY_RUNNING: { text: "cowork-sync: sync already runs in this clone." },
  /** Printed before the daemon's own refusal (its code line and its next line, relayed). */
  UI_COWORK_DAEMON_REFUSED: { text: "cowork-sync: the daemon did not start; it said:" },
  UI_COWORK_STOPPED: { text: "cowork-sync: sync stopped; your files stay as they are.\nnext: {c} start", params: { c: "cmd" } },
  UI_COWORK_NOT_RUNNING: { text: "cowork-sync: sync is not running in this clone.\nnext: {c} start", params: { c: "cmd" } },
  UI_COWORK_STOP_PENDING: {
    text: "cowork-sync: stop requested; the daemon is still finishing its current step after {secs} s.\nnext: {c} status",
    params: { secs: "n", c: "cmd" }
  },
  RF_COWORK_NOT_A_REPO: {
    text: "cowork-sync: this folder is not inside a git work tree [RF_COWORK_NOT_A_REPO]\nnext: open your clone of the repository, then: {c} {verb}",
    params: { c: "cmd", verb: "cmd" }
  },
  RF_COWORK_NO_REMOTE: {
    text: "cowork-sync: this repository has no git remote, and cowork-sync syncs through one [RF_COWORK_NO_REMOTE]\nnext: git remote add origin <url> and push your branch, then: {c} start",
    params: { c: "cmd" }
  },
  RF_COWORK_NO_BRANCH: {
    text: "cowork-sync: HEAD is not on a branch [RF_COWORK_NO_BRANCH]\nnext: git switch <branch>, then: {c} start",
    params: { c: "cmd" }
  },
  RF_COWORK_USAGE: { text: "cowork-sync: {why} [RF_COWORK_USAGE]\nnext: {c} help", params: { why: "cmd", c: "cmd" } },
  RF_COWORK_START_FAILED: {
    text: "cowork-sync: the daemon could not be started ({why}) [RF_COWORK_START_FAILED]\nnext: check that {daemon} exists, then: {c} start",
    params: { why: "cmd", daemon: "cmd", c: "cmd" }
  },
  UI_COWORK_STATUS_RUNNING: {
    text: "cowork-sync: running on {branch} as peer {peer} (state: {state})",
    params: { branch: "cmd", peer: "cmd", state: "cmd" }
  },
  UI_COWORK_STATUS_STARTING: { text: "cowork-sync: the daemon is running but has not written its status yet" },
  UI_COWORK_STATUS_STALE: {
    text: "cowork-sync: the daemon holds the lock, but its status is {age} old (state: {state}); it may be stuck",
    params: { age: "cmd", state: "cmd" }
  },
  UI_COWORK_STATUS_DOWN: {
    text: "cowork-sync: not running in this clone (last state on {branch}: {state})\nnext: {c} start",
    params: { branch: "cmd", state: "cmd", c: "cmd" }
  },
  UI_COWORK_STATUS_NEVER: { text: "cowork-sync: sync has not run in this clone yet.\nnext: {c} start", params: { c: "cmd" } },
  UI_COWORK_STATUS_UNREADABLE: { text: "  status.json: unreadable ({path})", params: { path: "cmd" } },
  UI_COWORK_STATUS_PEERS: { text: "  peers:         {peers}", params: { peers: "cmd" } },
  UI_COWORK_STATUS_PUSH: { text: "  last publish:  {age}", params: { age: "cmd" } },
  UI_COWORK_STATUS_FETCH: { text: "  last fetch:    {age}", params: { age: "cmd" } },
  UI_COWORK_STATUS_PENDING: {
    text: "  waiting:       {ready} ready to publish, {open} open, {incoming} incoming, {holds} held",
    params: { ready: "n", open: "n", incoming: "n", holds: "n" }
  },
  UI_COWORK_STATUS_FROZEN: { text: "  frozen:        {reasons}", params: { reasons: "cmd" } },
  UI_COWORK_STATUS_PAUSE: { text: "  publish pause: {pause}", params: { pause: "cmd" } },
  UI_COWORK_STATUS_NOT_CONVERGED: { text: "  not converged: {paths}", params: { paths: "cmd" } },
  UI_COWORK_STATUS_MESSAGE: { text: "  message:       {message}", params: { message: "cmd" } },
  UI_COWORK_STATUS_FILES: { text: "  files:         {status} and {log}", params: { status: "cmd", log: "cmd" } },
  UI_COWORK_INTERNAL_ERROR: { text: "cowork-sync: internal error ({what}); nothing was changed.", params: { what: "cmd" } }
};

// src/cli/verbs.ts
var START_TIMEOUT_MS = 9e4;
var STOP_TIMEOUT_MS = 1e5;
var STOP_POLL_MS = 250;
var CONTROL_OR_FORMAT2 = /[\p{Cc}\p{Cf}]/gu;
var SLASH_COMMAND = "/cowork-sync:cowork";
function commandPrefix(slash, pluginRoot, platform) {
  if (slash) return SLASH_COMMAND;
  const sep = platform === "win32" ? "\\" : "/";
  const root = pluginRoot.endsWith(sep) ? pluginRoot.slice(0, -1) : pluginRoot;
  return `node ${shellWord(`${root}${sep}dist${sep}cli.js`, terminalShell(platform))}`;
}
function relayDaemonLine(line, c, branchArg, daemonCmd) {
  const word = String.raw`(?:"[^"]*"|'(?:[^']|'\\'')*'|<[^>]*>|\S+)`;
  const run2 = new RegExp(String.raw`node dist/daemon\.js run --repo ${word} --branch ${word}`, "g");
  return line.replace(CONTROL_OR_FORMAT2, "").replace(run2, `${c} start${branchArg === null ? "" : ` --branch ${branchArg}`}`).replace(/node dist\/daemon\.js\b/g, daemonCmd);
}
async function runCowork(argv2, env) {
  let channel = "terminal";
  let slash = false;
  try {
    registerCatalog("en", EN_COWORK_CLI);
    const mode = outputMode(env.isTTY, env.env);
    if (argv2.length === 0 && mode === "pipe") return 0;
    slash = mode === "slash";
    channel = slash ? "slash" : "terminal";
    const ch = channel;
    const o = {
      c: commandPrefix(slash, env.pluginRoot, env.platform),
      channel: ch,
      say: (code2, p = {}) => env.out(render(code2, p, ch, "en")),
      refuse: (code2, p = {}) => {
        (slash ? env.out : env.err)(render(code2, p, ch, "en"));
        return 1;
      },
      raw: (line, toErr) => (toErr && !slash ? env.err : env.out)(line)
    };
    const code = await dispatch(argv2, env, o);
    return slash ? 0 : code;
  } catch (e) {
    try {
      (slash ? env.out : env.err)(render("UI_COWORK_INTERNAL_ERROR", { what: e instanceof Error ? e.name : "unknown" }, channel, "en"));
    } catch {
    }
    return slash ? 0 : 2;
  }
}
async function dispatch(argv2, env, o) {
  const cmd = parseCoworkArgs(argv2);
  if ("usage" in cmd) {
    o.refuse("RF_COWORK_USAGE", { why: cmd.usage, c: o.c });
    return 2;
  }
  switch (cmd.verb) {
    case "help": {
      const text = render("UI_COWORK_HELP", { version: PLUGIN_VERSION, c: o.c }, "terminal", "en");
      if (argv2.length === 0) env.err(text);
      else env.out(text);
      return 0;
    }
    case "start":
      return start(cmd, env, o);
    case "stop":
      return stop(env, o);
    case "status":
      return status(env, o);
  }
}
async function clone(env, o, verb) {
  const c = await findClone(env.git, env.cwd);
  return c ?? o.refuse("RF_COWORK_NOT_A_REPO", { c: o.c, verb });
}
async function start(opts, env, o) {
  const cl = await clone(env, o, "start");
  if (typeof cl === "number") return cl;
  if ((await remoteNames(env.git, cl.top)).length === 0) return o.refuse("RF_COWORK_NO_REMOTE", { c: o.c });
  const branch = opts.branch ?? await currentBranch(env.git, cl.top);
  if (branch === null) return o.refuse("RF_COWORK_NO_BRANCH", { c: o.c });
  const holder = await readLockHolder(env.fs, cl.coworkDir);
  if (holder !== null && holderLive(holder, env.alive, env.machineMono())) {
    o.say("UI_COWORK_ALREADY_RUNNING");
    await printStatus(env, o, cl, true);
    return 0;
  }
  const sep = env.platform === "win32" ? "\\" : "/";
  const daemonJs = `${env.pluginRoot}${sep}dist${sep}daemon.js`;
  const shell = terminalShell(env.platform);
  const outcome = await env.launchDaemon({
    execPath: env.execPath,
    daemonJs,
    argv: daemonRunArgv(cl.top, branch, opts),
    cwd: cl.top,
    env: env.env,
    timeoutMs: env.startTimeoutMs
  });
  switch (outcome.kind) {
    case "started":
      o.say("UI_COWORK_STARTED", { branch, mode: outcome.mode, c: o.c });
      return 0;
    case "timeout":
      o.say("UI_COWORK_STARTING", { secs: Math.round(env.startTimeoutMs / 1e3), c: o.c });
      return 0;
    case "spawn_failed":
      return o.refuse("RF_COWORK_START_FAILED", { why: outcome.why, daemon: daemonJs, c: o.c });
    case "exited": {
      if (outcome.lines.length === 0) {
        return o.refuse("RF_COWORK_START_FAILED", { why: `the daemon exited with code ${String(outcome.code)} and printed nothing`, daemon: daemonJs, c: o.c });
      }
      const branchArg = opts.branch === null ? null : shellWord(opts.branch, shell);
      const daemonCmd = `node ${shellWord(daemonJs, shell)}`;
      o.raw(render("UI_COWORK_DAEMON_REFUSED", {}, o.channel, "en"), true);
      for (const line of outcome.lines) o.raw(relayDaemonLine(line, o.c, branchArg, daemonCmd), true);
      return outcome.code === 1 ? 1 : 2;
    }
  }
}
async function stop(env, o) {
  const cl = await clone(env, o, "stop");
  if (typeof cl === "number") return cl;
  const holder = await readLockHolder(env.fs, cl.coworkDir);
  if (holder === null || !holderLive(holder, env.alive, env.machineMono())) {
    o.say("UI_COWORK_NOT_RUNNING", { c: o.c });
    return 0;
  }
  const request = join3(cl.coworkDir, STOP_REQUEST_FILE);
  const body = Buffer.from(`${holder.instance}
`, "utf8");
  const until = env.clock.monoMs() + env.stopTimeoutMs;
  await env.fs.writeFile(request, body);
  for (; ; ) {
    await env.clock.sleep(env.stopPollMs);
    const now = await readLockHolder(env.fs, cl.coworkDir);
    if (now === null || now.instance !== holder.instance || !holderLive(now, env.alive, env.machineMono())) {
      o.say("UI_COWORK_STOPPED", { c: o.c });
      return 0;
    }
    if (env.clock.monoMs() >= until) {
      o.say("UI_COWORK_STOP_PENDING", { secs: Math.round(env.stopTimeoutMs / 1e3), c: o.c });
      return 1;
    }
    if (await env.fs.lstat(request) === null) await env.fs.writeFile(request, body);
  }
}
async function status(env, o) {
  const cl = await clone(env, o, "status");
  if (typeof cl === "number") return cl;
  const holder = await readLockHolder(env.fs, cl.coworkDir);
  const live = holder !== null && holderLive(holder, env.alive, env.machineMono());
  return await printStatus(env, o, cl, live) ? 0 : 1;
}
async function printStatus(env, o, cl, live) {
  const st = await readStatusFile(env.fs, cl.coworkDir);
  const peers = st !== null && st !== "unreadable" ? await activePeers(env.git, cl.top, st.branch, st.peer_id).catch(() => null) : null;
  const sum = statusSummary({
    live,
    status: st,
    nowMachineMono: env.machineMono(),
    peers,
    files: { status: join3(cl.coworkDir, STATUS_FILE), log: join3(cl.coworkDir, DAEMON_LOG_FILE) },
    c: o.c
  });
  for (const l of sum.lines) o.say(l.code, l.params);
  return sum.healthy;
}

// src/cli/realEnv.ts
function realCoworkEnv() {
  const pluginRoot = dirname(dirname(fileURLToPath2(import.meta.url)));
  const git = createGitRunner({ clock: realClock, hooksPath: join4(pluginRoot, "empty-hooks"), daemonEnv: buildDaemonEnv({ ...process.env }, []) });
  return {
    pluginRoot,
    cwd: process.cwd(),
    env: process.env,
    platform: process.platform,
    isTTY: process.stdout.isTTY === true,
    execPath: process.execPath,
    out: (s) => {
      process.stdout.write(`${s}
`);
    },
    err: (s) => {
      process.stderr.write(`${s}
`);
    },
    fs: realFs,
    clock: realClock,
    git,
    launchDaemon,
    alive: processAlive,
    machineMono: machineMonoMs,
    startTimeoutMs: START_TIMEOUT_MS,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    stopPollMs: STOP_POLL_MS
  };
}

// src/entry/cli.ts
var argv = process.argv.slice(2);
if (argv[0] === "view") {
  process.exitCode = await runView(argv.slice(1), realCliEnv());
} else if (argv.includes("--version")) {
  process.stdout.write(`cowork-sync cli ${PLUGIN_VERSION}
`);
} else {
  process.exitCode = await runCowork(argv, realCoworkEnv());
}
