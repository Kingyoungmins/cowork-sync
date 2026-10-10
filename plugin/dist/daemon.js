// src/daemon/run.ts
import { createHash as createHash6 } from "node:crypto";
import { join as join14, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// src/engine/deps.ts
import { createHash } from "node:crypto";
var humanOnlyAttribution = Object.freeze({
  removalAttributed: (_path) => false,
  shrinkAttributed: (_path) => true
});
function regionSpecId(parts) {
  for (const p of parts) {
    if (typeof p !== "string" || p.includes("\n")) throw new TypeError(`regionSpecId: invalid part ${JSON.stringify(p)}`);
  }
  return createHash("sha256").update(Buffer.from([...parts].sort().join("\n"), "utf8")).digest("hex");
}
var PLAN2_REGION_SPEC = regionSpecId(["FoldMapper/1", "extent-convention/1", "label-convention/1"]);

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
var processStart = null;
function processStartMonoMs() {
  processStart ??= Math.round(machineMonoMs() - process.uptime() * 1e3);
  return processStart;
}
var SUSPEND_GAP_THRESHOLD_MS = 5e3;
function anchorNow(clock) {
  return Object.freeze({ mono: clock.monoMs(), wall: clock.wallMs() });
}
function elapsedMono(clock, a) {
  return Math.max(0, clock.monoMs() - a.mono);
}
function suspendGapMs(clock, a) {
  return clock.wallMs() - a.wall - (clock.monoMs() - a.mono);
}

// src/engine/daemonFiles.ts
var DAEMON_LOCK_FILE = "daemon.lock";
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

// src/engine/loop.ts
import { join as join13 } from "node:path";

// src/git/oid.ts
var ABSENT = "ABSENT";
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
var MAX_PATH_BYTES = 4096;
var LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
function validPathSyntax(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0") || p.includes("\\") || p.includes(":") || p.startsWith("/")) return false;
  if (LONE_SURROGATE.test(p)) return false;
  if (Buffer.byteLength(p, "utf8") > MAX_PATH_BYTES) return false;
  if (p.normalize("NFC") !== p) return false;
  for (const component of p.split("/")) {
    if (component.length === 0 || component === "..") return false;
  }
  return true;
}
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

// src/board/boardCommit.ts
import { deflateSync, inflateSync } from "node:zlib";

// src/git/trailers.ts
var SKIP_SUBJECT_PREFIX = "[skip ci] ***NO_CI***";
var KEY_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
var TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*):(?: (.*))?$/;
function checkField(what, s) {
  if (/[\r\n\0]/.test(s)) throw new Error(`formatMessage: CR, LF or NUL inside ${what}`);
}
function formatMessage(subject, trailers) {
  checkField("subject", subject);
  const lines = [subject];
  if (trailers.length > 0) {
    lines.push("");
    for (const t of trailers) {
      checkField("key", t.key);
      checkField("value", t.value);
      if (!KEY_RE.test(t.key)) throw new Error(`formatMessage: invalid trailer key ${JSON.stringify(t.key)}`);
      lines.push(`${t.key}: ${t.value}`);
    }
  }
  return Buffer.from(`${lines.join("\n")}
`, "utf8");
}
function parseMessage(raw) {
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const subject = lines[0] ?? "";
  let start = lines.length;
  while (start > 0 && lines[start - 1] !== "") start--;
  const trailers = [];
  if (start > 0) {
    for (const line of lines.slice(start)) {
      const m = TRAILER_LINE.exec(line);
      if (m !== null) trailers.push({ key: m[1], value: m[2] ?? "" });
    }
  }
  return { subject, trailers };
}

// src/git/repo.ts
var GitCommandError = class extends Error {
  argv;
  code;
  stderrText;
  constructor(argv2, code, stderr) {
    const text2 = stderr.toString("utf8").trim();
    super(`git ${argv2.slice(0, 3).join(" ")} failed with exit code ${code}${text2.length > 0 ? `: ${text2.slice(0, 300)}` : ""}`);
    this.name = "GitCommandError";
    this.argv = [...argv2];
    this.code = code;
    this.stderrText = text2;
  }
};
var TREE_CACHE_SIZE = 64;
var FILE_MODES = /* @__PURE__ */ new Set(["100644", "100755", "120000", "160000"]);
var LOCAL_REF_PREFIXES = ["refs/cowork-local/", "refs/cowork-remote/"];
function checkRefName(what, ref) {
  if (typeof ref !== "string" || !ref.startsWith("refs/") || ref.length <= "refs/".length || ref.endsWith("/") || ref.endsWith(".") || ref.includes("..") || ref.includes("//") || ref.includes("@{") || /[\0-\x20\x7f~^:?*[\\]/.test(ref) || ref.split("/").some((c) => c.startsWith(".") || c.endsWith(".lock"))) {
    throw new Error(`${what}: invalid ref ${JSON.stringify(ref)}`);
  }
}
function checkTreePath(p) {
  if (p.length === 0 || p.includes("\0") || p.startsWith("/") || p.endsWith("/")) throw new Error(`invalid tree path ${JSON.stringify(p)}`);
}
function parseBatch(out, expected) {
  const items = [];
  let pos = 0;
  while (items.length < expected) {
    const nl = out.indexOf(10, pos);
    if (nl < 0) throw new Error("cat-file --batch: truncated output");
    const header = out.toString("utf8", pos, nl);
    const parts = header.split(" ");
    if (parts[1] === "missing" || parts.length !== 3) throw new Error(`cat-file --batch: object missing or malformed header ${JSON.stringify(header)}`);
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`cat-file --batch: bad size in ${JSON.stringify(header)}`);
    const start = nl + 1;
    if (start + size > out.length) throw new Error("cat-file --batch: truncated content");
    items.push(out.subarray(start, start + size));
    pos = start + size + 1;
  }
  return items;
}
function splitFilteredBatch(out, oids) {
  const text2 = out.toString("latin1");
  const wanted = new Set(oids);
  const bounds = [];
  for (const m of text2.matchAll(/\n([0-9a-f]{40}|[0-9a-f]{64}) blob [0-9]+(?=\n)/g)) {
    if (wanted.has(m[1])) bounds.push(m.index);
  }
  if (bounds.length !== oids.length - 1 || text2.length === 0 || text2[text2.length - 1] !== "\n") return null;
  const items = [];
  let pos = 0;
  for (let i = 0; i < oids.length; i++) {
    const nl = text2.indexOf("\n", pos);
    if (nl < 0 || !new RegExp(`^${oids[i]} blob [0-9]+$`).test(text2.slice(pos, nl))) return null;
    const end = i < oids.length - 1 ? bounds[i] : text2.length - 1;
    if (end < nl + 1) return null;
    items.push(out.subarray(nl + 1, end));
    pos = end + 1;
  }
  return items;
}
function headerOid(o, line, prefixLength, hexLength) {
  const hex2 = line.slice(prefixLength);
  if (hex2.length !== hexLength || !/^[0-9a-fA-F]+$/.test(hex2)) throw new OidError(`commit ${o}: malformed header line ${JSON.stringify(line.slice(0, 80))}`);
  return parseOid(Buffer.from(hex2.toLowerCase(), "latin1").toString("latin1"));
}
function parseCommitObject(o, raw) {
  const split = raw.indexOf("\n\n");
  const header = split < 0 ? raw : raw.slice(0, split);
  const message = split < 0 ? "" : raw.slice(split + 2);
  const lines = header.split("\n");
  const first = lines[0] ?? "";
  if (!first.startsWith("tree ")) throw new Error(`commit ${o} has no tree line`);
  const tree2 = headerOid(o, first, "tree ".length, o.length);
  const parents = [];
  for (let i = 1; i < lines.length && lines[i].startsWith("parent "); i++) parents.push(headerOid(o, lines[i], "parent ".length, o.length));
  const { subject, trailers } = parseMessage(message);
  return { oid: o, tree: tree2, parents, subject, trailers };
}
var GitRepo = class {
  paths;
  runner;
  ctx;
  trees = /* @__PURE__ */ new Map();
  emptyTreeOid;
  constructor(runner, paths, ctx) {
    this.runner = runner;
    this.paths = paths;
    this.ctx = ctx;
  }
  /** The runner call with the repo defaults; never throws on the exit code. */
  exec(args, opts = {}) {
    const c = this.ctx();
    const base = {
      class: "local",
      cwd: this.paths.workTree,
      gitDir: this.paths.gitDir,
      filterDrivers: [...c.filterDrivers],
      ...c.attrTree !== null ? { attrTree: c.attrTree } : {}
    };
    return this.runner.run(args, { ...base, ...opts });
  }
  /** class 'local' and cwd = workTree unless given; filterDrivers and attrTree from ctx() unless given; rc not in okCodes (default [0]) throws GitCommandError. */
  async run(args, opts = {}) {
    const { okCodes, ...rest } = opts;
    const r = await this.exec(args, rest);
    if (!(okCodes ?? [0]).includes(r.code)) throw new GitCommandError(args, r.code, r.stderr);
    return r;
  }
  /** An oid printed by git: anything else (empty stdout after exit 128, garbage) is an OidError (ENG-09). */
  oidFrom(r, args) {
    try {
      return parseOid(r.stdout.toString("utf8"));
    } catch {
      throw new OidError(`git ${args.slice(0, 2).join(" ")} printed no object id (exit ${r.code})`);
    }
  }
  async resolve(rev) {
    if (rev.startsWith("-") || /[\0\r\n]/.test(rev)) throw new Error(`invalid revision ${JSON.stringify(rev)}`);
    const r = await this.run(["rev-parse", "--verify", "--quiet", rev], { okCodes: [0, 1] });
    return r.code === 0 ? parseOid(r.stdout.toString("utf8")) : null;
  }
  /** o exists and IS that type (`cat-file -t`, no peeling: a commit is not a 'tree'). */
  async hasObject(o, type) {
    parseOid(o);
    const r = await this.run(["cat-file", "-t", o], { okCodes: [0, 1, 128] });
    return r.code === 0 && r.stdout.toString("utf8").trim() === type;
  }
  async emptyTree() {
    if (this.emptyTreeOid === void 0) {
      const r = await this.run(["hash-object", "-t", "tree", "--stdin", "--no-filters"], { stdin: Buffer.alloc(0) });
      this.emptyTreeOid = this.oidFrom(r, ["hash-object"]);
    }
    return this.emptyTreeOid;
  }
  /** Route (c): hash-object [-w] --stdin --no-filters. */
  async hashBytes(bytes, write2) {
    const args = ["hash-object", ...write2 ? ["-w"] : [], "--stdin", "--no-filters"];
    const r = await this.exec(args, { stdin: bytes });
    return this.oidFrom(r, args);
  }
  async readBlob(o) {
    parseOid(o);
    return (await this.run(["cat-file", "blob", o])).stdout;
  }
  async readBlobs(oids) {
    if (oids.length === 0) return [];
    for (const o of oids) parseOid(o);
    const r = await this.run(["cat-file", "--batch"], { stdin: Buffer.from(`${oids.join("\n")}
`, "utf8") });
    return parseBatch(r.stdout, oids.length);
  }
  /**
   * One `cat-file --batch --filters` call for the whole group (ruling R-36); cwd = the repo root, attr.tree and drivers
   * from the context. The batch headers carry the UNFILTERED size while the content is filtered (eol conversion, smudge),
   * so the output is split at the requested objects' headers (splitFilteredBatch); when content mimics such a header the
   * split is ambiguous and each item is smudged by its own exact `cat-file --filters --path=<p> <oid>` instead.
   */
  async smudgeBlobs(items) {
    if (items.length === 0) return [];
    const lines = items.map((it) => {
      parseOid(it.oid);
      if (it.path.length === 0 || /[\0\r\n]/.test(it.path)) throw new Error(`invalid path for smudge ${JSON.stringify(it.path)}`);
      return `${it.oid} ${it.path}`;
    });
    const r = await this.run(["cat-file", "--batch", "--filters"], { class: "attr", stdin: Buffer.from(`${lines.join("\n")}
`, "utf8") });
    const split = splitFilteredBatch(r.stdout, items.map((it) => it.oid));
    if (split !== null) return split;
    const out = [];
    for (const it of items) out.push((await this.run(["cat-file", "--filters", `--path=${it.path}`, it.oid], { class: "attr" })).stdout);
    return out;
  }
  async blobSizes(oids) {
    if (oids.length === 0) return [];
    for (const o of oids) parseOid(o);
    const r = await this.run(["cat-file", "--batch-check"], { stdin: Buffer.from(`${oids.join("\n")}
`, "utf8") });
    const lines = r.stdout.toString("utf8").split("\n");
    return oids.map((_, i) => {
      const parts = (lines[i] ?? "").split(" ");
      if (parts.length !== 3 || parts[1] === "missing") throw new Error(`cat-file --batch-check: object missing (${oids[i]})`);
      return Number(parts[2]);
    });
  }
  /** ls-tree -r -z --full-tree; an LRU cache of 64 trees by oid. */
  async readTreeMap(tree2) {
    parseOid(tree2);
    const hit = this.trees.get(tree2);
    if (hit !== void 0) {
      this.trees.delete(tree2);
      this.trees.set(tree2, hit);
      return hit;
    }
    const r = await this.run(["ls-tree", "-r", "-z", "--full-tree", tree2]);
    const map = /* @__PURE__ */ new Map();
    for (const rec of r.stdout.toString("utf8").split("\0")) {
      if (rec.length === 0) continue;
      const tab = rec.indexOf("	");
      const meta = rec.slice(0, tab).split(" ");
      const mode = meta[0] ?? "";
      const type = meta[1] ?? "";
      if (tab < 0 || meta.length !== 3 || !FILE_MODES.has(mode) || type !== "blob" && type !== "commit") {
        throw new Error(`ls-tree: unexpected record ${JSON.stringify(rec.slice(0, 120))}`);
      }
      const path = rec.slice(tab + 1);
      map.set(path, { path, mode, oid: parseOid(meta[2] ?? "") });
    }
    this.trees.set(tree2, map);
    if (this.trees.size > TREE_CACHE_SIZE) {
      const oldest = this.trees.keys().next();
      if (oldest.done !== true) this.trees.delete(oldest.value);
    }
    return map;
  }
  /** Code trees: a fresh scratch index, update-index -z --index-info, write-tree (ENG-10 operations 3 and 1). */
  async writeTreeMap(entries, scratchIndex) {
    await this.run(["read-tree", "--empty"], { class: "refupdate", indexFile: scratchIndex });
    await this.editIndex(scratchIndex, [...entries.values()].map((e) => ({ path: e.path, mode: e.mode, oid: e.oid })));
    return this.writeTree(scratchIndex);
  }
  /** read-tree of base into the scratch index, the edits, write-tree. */
  async editTree(base, edits, scratchIndex) {
    await this.readTreeIntoIndex(scratchIndex, base);
    await this.editIndex(scratchIndex, edits);
    return this.writeTree(scratchIndex);
  }
  /** Metadata trees only (ruling R-15). */
  async mktree(entries) {
    const parts = entries.map((e) => {
      parseOid(e.oid);
      if (e.name.length === 0 || /[\0/]/.test(e.name)) throw new Error(`invalid tree entry name ${JSON.stringify(e.name)}`);
      return `${e.mode} ${e.type} ${e.oid}	${e.name}\0`;
    });
    const args = ["mktree", "-z"];
    const r = await this.exec(args, { stdin: Buffer.from(parts.join(""), "utf8") });
    return this.oidFrom(r, args);
  }
  /**
   * commit-tree with the context identity (+0000), the context date in test builds, never signed (ENG-12).
   * `identity` replaces the context identity (only mergeTree's parentless wrapper commits, ruling R-30).
   */
  async commitTree(c, identity) {
    const message = formatMessage(c.subject, c.trailers);
    const args = ["commit-tree", parseOid(c.tree)];
    for (const p of c.parents) args.push("-p", parseOid(p));
    const ctx = this.ctx();
    const r = await this.exec(args, { class: "refupdate", identity: identity ?? ctx.identity, wallMsForDates: ctx.wallMs(), stdin: message });
    return this.oidFrom(r, args);
  }
  async readCommit(o) {
    parseOid(o);
    return parseCommitObject(o, (await this.run(["cat-file", "commit", o])).stdout.toString("utf8"));
  }
  /** The exact ref (never a rev-parse rule match); null when absent. */
  async readRef(ref) {
    if (!ref.startsWith("refs/")) return this.resolve(ref);
    checkRefName("readRef", ref);
    const r = await this.run(["for-each-ref", "--format=%(objectname) %(refname)", ref]);
    for (const line of r.stdout.toString("utf8").split("\n")) {
      const sp = line.indexOf(" ");
      if (sp > 0 && line.slice(sp + 1) === ref) return parseOid(line.slice(0, sp));
    }
    return null;
  }
  /** Every ref under prefix, sorted by ref name. */
  async listRefs(prefix) {
    if (!prefix.startsWith("refs/")) throw new Error(`invalid ref prefix ${JSON.stringify(prefix)}`);
    const r = await this.run(["for-each-ref", "--format=%(objectname) %(refname)", prefix.replace(/\/+$/, "")]);
    const out = [];
    for (const line of r.stdout.toString("utf8").split("\n")) {
      const sp = line.indexOf(" ");
      if (sp <= 0) continue;
      const ref = line.slice(sp + 1);
      if (ref.startsWith(prefix)) out.push({ ref, oid: parseOid(line.slice(0, sp)) });
    }
    return out;
  }
  /**
   * update-ref --create-reflog -m <reason> <ref> <next> <prev|zero oid> (class refupdate). Returns false
   * iff a re-read after a failure shows the ref is not at prev: the outcome decides, never git's text.
   */
  async casRef(ref, next, prev, reason) {
    checkRefName("casRef", ref);
    if (reason.length === 0 || /[\0\r\n]/.test(reason)) throw new Error("casRef: invalid reflog reason");
    parseOid(next);
    if (prev !== null) parseOid(prev);
    if (!await this.hasObject(next, "commit")) throw new Error(`casRef: ${next} is not an existing commit`);
    const old = prev ?? "0".repeat(next.length);
    const args = ["update-ref", "--create-reflog", "-m", reason, ref, next, old];
    const r = await this.exec(args, { class: "refupdate", identity: this.ctx().identity });
    if (r.code === 0) return true;
    if (await this.readRef(ref) !== prev) return false;
    throw new GitCommandError(args, r.code, r.stderr);
  }
  /** Deletes a refs/cowork-local/* or refs/cowork-remote/* ref iff it still is at prev. */
  async deleteLocalRef(ref, prev) {
    checkRefName("deleteLocalRef", ref);
    if (!LOCAL_REF_PREFIXES.some((p) => ref.startsWith(p))) throw new Error(`deleteLocalRef: ${ref} is not a cowork ref`);
    parseOid(prev);
    const args = ["update-ref", "-d", ref, prev];
    const r = await this.exec(args, { class: "refupdate", identity: this.ctx().identity });
    if (r.code === 0) return true;
    if (await this.readRef(ref) !== prev) return false;
    throw new GitCommandError(args, r.code, r.stderr);
  }
  /** rev-list --first-parent <tip> [^stop], newest first, at most max. */
  async firstParents(tip, stop, max) {
    parseOid(tip);
    if (stop !== null) parseOid(stop);
    if (!(max > 0)) return [];
    const args = ["rev-list", "--first-parent", `--max-count=${Math.floor(max)}`, tip];
    if (stop !== null) args.push(`^${stop}`);
    const r = await this.run(args);
    return r.stdout.toString("utf8").split("\n").filter((l) => l.length > 0).map((l) => parseOid(l));
  }
  async firstParentCount(tip) {
    parseOid(tip);
    const r = await this.run(["rev-list", "--first-parent", "--count", tip]);
    return Number(r.stdout.toString("utf8").trim());
  }
  /** Plain reachability: a is b or an ancestor of b through any parent. `rev-list b..a` is empty; never merge-base. */
  async isAncestor(a, b) {
    parseOid(a);
    parseOid(b);
    if (a === b) return true;
    const r = await this.run(["rev-list", "--max-count=1", `${b}..${a}`]);
    return r.stdout.toString("utf8").trim().length === 0;
  }
  /** The newest commit on tip's first-parent chain with a `<key>: ` line: one rev-list call, cost independent of chain length. */
  async newestWithTrailer(tip, key) {
    parseOid(tip);
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(key)) throw new Error(`invalid trailer key ${JSON.stringify(key)}`);
    const r = await this.run(["rev-list", "--first-parent", "--max-count=1", `--grep=^${key}: `, tip]);
    const line = r.stdout.toString("utf8").trim();
    return line.length === 0 ? null : parseOid(line);
  }
  /** read-tree <tree> into the index file; never -u or -m (class refupdate). */
  async readTreeIntoIndex(indexFile, tree2) {
    parseOid(tree2);
    await this.run(["read-tree", tree2], { class: "refupdate", indexFile });
  }
  async writeTree(indexFile) {
    const args = ["write-tree"];
    const r = await this.exec(args, { indexFile });
    return this.oidFrom(r, args);
  }
  /** update-index --add --replace -z --index-info: whole-path replacement; `remove` writes mode 0. */
  async editIndex(indexFile, edits) {
    if (edits.length === 0) return;
    let zero;
    const lines = [];
    for (const e of edits) {
      checkTreePath(e.path);
      if ("remove" in e) {
        zero ??= "0".repeat((await this.emptyTree()).length);
        lines.push(`0 ${zero}	${e.path}\0`);
      } else {
        if (!FILE_MODES.has(e.mode)) throw new Error(`invalid file mode ${String(e.mode)}`);
        lines.push(`${e.mode} ${parseOid(e.oid)}	${e.path}\0`);
      }
    }
    await this.run(["update-index", "--add", "--replace", "-z", "--index-info"], {
      class: "refupdate",
      indexFile,
      stdin: Buffer.from(lines.join(""), "utf8")
    });
  }
  /** ls-files -s -z, stage 0 only, sorted by path as git lists them. */
  async listIndex(indexFile) {
    const r = await this.run(["ls-files", "-s", "-z"], { indexFile });
    const out = /* @__PURE__ */ new Map();
    for (const rec of r.stdout.toString("utf8").split("\0")) {
      if (rec.length === 0) continue;
      const tab = rec.indexOf("	");
      const meta = rec.slice(0, tab).split(" ");
      if (tab < 0 || meta.length !== 3) throw new Error(`ls-files: unexpected record ${JSON.stringify(rec.slice(0, 120))}`);
      if (meta[2] !== "0") continue;
      const mode = meta[0] ?? "";
      if (!FILE_MODES.has(mode)) throw new Error(`ls-files: unexpected mode ${mode}`);
      const oid2 = meta[1] ?? "";
      if (!isOid(oid2)) throw new OidError(`ls-files: bad oid ${JSON.stringify(oid2)}`);
      const path = rec.slice(tab + 1);
      out.set(path, { path, mode, oid: oid2 });
    }
    return out;
  }
  async configGet(key) {
    const r = await this.run(["config", "--get", key], { okCodes: [0, 1] });
    return r.code === 0 ? r.stdout.toString("utf8").replace(/\n$/, "") : null;
  }
  async configGetRegexp(regex) {
    const r = await this.run(["config", "-z", "--get-regexp", regex], { okCodes: [0, 1] });
    if (r.code !== 0) return [];
    const out = [];
    for (const rec of r.stdout.toString("utf8").split("\0")) {
      if (rec.length === 0) continue;
      const nl = rec.indexOf("\n");
      out.push(nl < 0 ? { key: rec, value: "" } : { key: rec.slice(0, nl), value: rec.slice(nl + 1) });
    }
    return out;
  }
};

// src/board/ids.ts
import { createHash as createHash3 } from "node:crypto";

// src/ports/random.ts
import { createHash as createHash2, randomBytes } from "node:crypto";
function checkCount(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Random.bytes: n must be an integer >= 0, got ${n}`);
}
var realRandom = {
  bytes(n) {
    checkCount(n);
    return new Uint8Array(randomBytes(n));
  }
};
function randomHex(r, nBytes) {
  return Buffer.from(r.bytes(nBytes)).toString("hex");
}
var CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
var ULID_TIME_MAX = 2 ** 48 - 1;
function ulid(r, clock) {
  const ms = Math.floor(clock.wallMs());
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > ULID_TIME_MAX) throw new RangeError(`ulid: wall time out of range: ${ms}`);
  let time = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = r.bytes(10);
  let rand = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = acc << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += CROCKFORD[acc >>> bits & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return time + rand;
}

// src/board/ids.ts
function formatOpId(id) {
  if (!Number.isSafeInteger(id.seq) || id.seq < 1) throw new RangeError(`formatOpId: seq must be a safe integer >= 1, got ${String(id.seq)}`);
  const s = `${id.peer}/${id.epoch}/${id.seq}`;
  if (!validId("op", s)) throw new RangeError(`formatOpId: not an op id ${JSON.stringify(s)}`);
  return s;
}
function parseOpId(s) {
  if (!validId("op", s)) return null;
  const [peer, epoch, seqText] = s.split("/");
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq) || String(seq) !== seqText) return null;
  return { peer, epoch, seq };
}
function newPeerId(r) {
  return randomHex(r, 16);
}
function newEpoch(r) {
  return randomHex(r, 16);
}
var CROCKFORD2 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function base32c(bytes) {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = acc << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD2[acc >>> bits & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD2[acc << 5 - bits & 31];
  return out;
}
function H(x, y) {
  const digest = createHash3("sha256").update(Buffer.concat([Buffer.from(x, "utf8"), Buffer.from([0]), Buffer.from(y, "utf8")])).digest();
  return base32c(digest).slice(0, 8);
}

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
    const keys3 = Object.keys(rec).filter((k) => rec[k] !== void 0).sort();
    out.push("{");
    for (let i = 0; i < keys3.length; i++) {
      const k = keys3[i];
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
var OP_TYPES = /* @__PURE__ */ new Set([
  "join",
  "leave",
  "caps",
  "seat_start",
  "seat_end",
  "claim",
  "release",
  "request",
  "request_status",
  "answer",
  "note",
  "presume_absent",
  "hold",
  "event",
  "save"
]);
var PLAN2_FOLDED_TYPES = /* @__PURE__ */ new Set(["join", "leave", "caps", "seat_start", "seat_end", "event", "save"]);
var OPS_MAX_LINES = 1e3;
var OPS_MAX_BYTES = 65536;
var OP_MAX_LINE_BYTES = 16384;
var REASON_CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;
var BoardCapError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BoardCapError";
  }
};
var EVENT_KINDS = /* @__PURE__ */ new Set(["K1", "K2", "K3", "K4", "K5", "K6", "K7", "breach", "freeze", "unfreeze", "incident", "nonretryable", "health"]);
var CID_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
function isObj(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
var isStr = (v) => typeof v === "string";
var isBool = (v) => typeof v === "boolean";
var isStrArray = (v) => Array.isArray(v) && v.every(isStr);
function fingerprint(v) {
  if (!isObj(v) || !isObj(v["filters"])) return null;
  const filters = v["filters"];
  if (!Object.values(filters).every(isStr)) return null;
  const { autocrlf, eol_attrs: eolAttrs, git } = v;
  if (!isStr(autocrlf) || !isStr(eolAttrs) || !isStr(git)) return null;
  return { filters: Object.fromEntries(Object.entries(filters)), autocrlf, eol_attrs: eolAttrs, git };
}
function typed(id, type, v) {
  switch (type) {
    case "join": {
      const { display, plugin_version: pv, plugin_sha: ps, proto, regionSpec, coauthor_optin: co } = v;
      const cf = fingerprint(v["config_fingerprint"]);
      if (!isStr(display) || !isStr(pv) || !isStr(ps) || !isStr(regionSpec) || cf === null) return null;
      if (typeof proto !== "number" || !Number.isSafeInteger(proto) || proto < 0) return null;
      if (co !== false && !isStr(co)) return null;
      return { id, type, display, plugin_version: pv, plugin_sha: ps, proto, regionSpec, config_fingerprint: cf, coauthor_optin: co };
    }
    case "leave":
      return { id, type };
    case "caps": {
      const { custom_refs: cr, lease, delete: del, push_options: po, two_parent_ok: tp } = v;
      if (!isBool(cr) || !isBool(lease) || !isBool(del) || !isBool(po) || !isBool(tp)) return null;
      return { id, type, custom_refs: cr, lease, delete: del, push_options: po, two_parent_ok: tp };
    }
    case "seat_start":
    case "seat_end": {
      const { seat_id: seat, permission_mode: mode } = v;
      if (!isStr(seat) || !validId("hex128", seat) || !isStr(mode)) return null;
      return { id, type, seat_id: seat, permission_mode: mode };
    }
    case "event": {
      const { cid, kind, refs, reason_code: rc } = v;
      if (!isStr(cid) || !CID_RE.test(cid) || !isStr(kind) || !EVENT_KINDS.has(kind) || !isStrArray(refs)) return null;
      if (!isStr(rc) || !REASON_CODE_RE.test(rc)) return null;
      return { id, type, cid, kind, refs: [...refs], reason_code: rc };
    }
    case "save": {
      const { save_commit: sc, saved_live: sl, chain_base: cb, released_claim_ids: rel } = v;
      if (!isOid(sc) || !isOid(sl) || !isOid(cb) || !isStrArray(rel)) return null;
      return { id, type, save_commit: sc, saved_live: sl, chain_base: cb, released_claim_ids: [...rel] };
    }
    default:
      return opaque(type, v);
  }
}
function opaque(type, v) {
  const required = type === "claim" || type === "request" ? "path" : type === "hold" ? "paths" : null;
  if (required !== null && !(required in v)) return null;
  if ("path" in v && !(isStr(v["path"]) && validPathSyntax(v["path"]))) return null;
  if ("paths" in v && !(isStrArray(v["paths"]) && v["paths"].every(validPathSyntax))) return null;
  if ("cs_id" in v && !(isStr(v["cs_id"]) && validId("cs", v["cs_id"]))) return null;
  if ("cs_ids" in v && !(isStrArray(v["cs_ids"]) && v["cs_ids"].every((s) => validId("cs", s)))) return null;
  for (const k of ["hold_id", "req_id"]) {
    if (k in v && !(isStr(v[k]) && validId("ulid", v[k]))) return null;
  }
  if ("reason_code" in v && !(isStr(v["reason_code"]) && REASON_CODE_RE.test(v["reason_code"]))) return null;
  return v;
}
function nestedDeeperThan(v, max) {
  const values = [v];
  const depths = [1];
  while (values.length > 0) {
    const x = values.pop();
    const d = depths.pop();
    if (typeof x !== "object" || x === null) continue;
    if (d > max) return true;
    for (const child of Array.isArray(x) ? x : Object.values(x)) {
      if (typeof child === "object" && child !== null) {
        values.push(child);
        depths.push(d + 1);
      }
    }
  }
  return false;
}
function parseOpLine(line) {
  try {
    if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > OP_MAX_LINE_BYTES) return null;
    const v = JSON.parse(line);
    if (nestedDeeperThan(v, MAX_JSON_DEPTH) || !isObj(v)) return null;
    const { id, type } = v;
    if (!isStr(id) || parseOpId(id) === null || !isStr(type) || !OP_TYPES.has(type)) return null;
    const op = typed(id, type, v);
    if (op === null) return null;
    canonicalJson(op);
    return op;
  } catch {
    return null;
  }
}
function serializeOps(ops) {
  if (ops.length > OPS_MAX_LINES) throw new BoardCapError(`ops.jsonl: ${ops.length} ops > ${OPS_MAX_LINES}`);
  const parts = [];
  let total = 0;
  let prevSeq = 0;
  ops.forEach((op, i) => {
    const line = canonicalJson(op);
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > OP_MAX_LINE_BYTES) throw new BoardCapError(`ops.jsonl line ${i + 1}: ${bytes} bytes > ${OP_MAX_LINE_BYTES}`);
    if (parseOpLine(line) === null) throw new Error(`serializeOps: op ${i + 1} (${String(op.type)}) fails the op schema`);
    const seq = parseOpId(op.id).seq;
    if (seq <= prevSeq) throw new Error(`serializeOps: op ${i + 1} seq ${seq} does not increase (previous ${prevSeq})`);
    prevSeq = seq;
    total += bytes + 1;
    if (total > OPS_MAX_BYTES) throw new BoardCapError(`ops.jsonl: more than ${OPS_MAX_BYTES} bytes at op ${i + 1}`);
    parts.push(Buffer.from(`${line}
`, "utf8"));
  });
  return Buffer.concat(parts);
}
function eventCid(opId, kind) {
  return H(opId, kind);
}

// src/board/protocol.ts
var PROTO = 1;
var FALLBACK = { budget: 6, G_s: 10, S_s: 3 };
function genesisProtocol(budget, regionSpec) {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new RangeError(`genesisProtocol: budget must be a positive integer, got ${String(budget)}`);
  return { proto: PROTO, regionSpec, budget, G_s: Math.ceil(6e4 / budget) / 1e3, S_s: Math.ceil(18e3 / budget) / 1e3 };
}
function serializeProtocol(p) {
  return canonicalBytes({ proto: p.proto, regionSpec: p.regionSpec, budget: p.budget, G_s: p.G_s, S_s: p.S_s });
}
var positive = (v, fallback) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
function readProtocol(buf) {
  let v = null;
  if (buf !== null) {
    try {
      v = JSON.parse(buf.toString("utf8"));
    } catch {
      v = null;
    }
  }
  const o = typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  const proto = o["proto"];
  return {
    proto: typeof proto === "number" && Number.isSafeInteger(proto) && proto >= 0 ? proto : 0,
    regionSpec: typeof o["regionSpec"] === "string" ? o["regionSpec"] : "",
    budget: positive(o["budget"], FALLBACK.budget),
    G_s: positive(o["G_s"], FALLBACK.G_s),
    S_s: positive(o["S_s"], FALLBACK.S_s)
  };
}

// src/board/boardCommit.ts
var BOARD_SUBJECT = "[skip ci] ***NO_CI*** cowork board";
var CODE_SUBJECT = "[skip ci] ***NO_CI*** cowork live";
var STATE_SUBJECT = "cowork-state";
var BOARD_TREE_MAX_BYTES = 5e6;
var BOARD_COMMIT_OBJECT_MAX_BYTES = 1048576;
var BOARD_ROOT_TREE_MAX_BYTES = 4096;
var BATCH_READ_MAX_BYTES = 33554432;
var BoardMalformedError = class extends Error {
  reason;
  constructor(reason, message) {
    super(message);
    this.name = "BoardMalformedError";
    this.reason = reason;
  }
};
var RemoteContentError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "RemoteContentError";
  }
};
var SKIP_CHECKS = "skip-checks";
var PROTO_KEY = "Cowork-Proto";
var WRITER_KEY = "Cowork-Writer";
var SEAT_KEY = "Cowork-Seat";
var CS_KEY = "Cowork-CS";
var CS_PATHS_KEY = "Cowork-CS-Paths";
var BASE_KEY = "Cowork-Base";
var HUMAN = "human";
var OPS_FILE = "ops.jsonl";
var PROTOCOL_FILE = "protocol.json";
var CHECKPOINT_DIR = "checkpoint";
var STATE_FILE = "state.json";
var HELD_DIR = "held";
var CS_PATHS_MAX = 256;
var CS_PATHS_MAX_BYTES = CS_PATHS_MAX * 4096 + CS_PATHS_MAX - 1;
var CS_STATES = /* @__PURE__ */ new Set(["closed", "checkpoint"]);
var CS_ORIGINS = /* @__PURE__ */ new Set(["prompt", "wake", "human"]);
var CS_CHECKS = /* @__PURE__ */ new Set(["pass", "fail", "skipped"]);
var COUNT_RE = /^(?:0|[1-9][0-9]*)$/;
var ENTRY_MODES = /* @__PURE__ */ new Set(["100644", "100755", "120000", "160000", "040000"]);
function formatWriter(w) {
  return formatOpId(w);
}
function parseWriter(s) {
  return parseOpId(s);
}
var isCount = (n) => Number.isSafeInteger(n) && n >= 0;
function parseCount(s) {
  if (!COUNT_RE.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
function formatCs(c) {
  if (!validId("cs", c.csId) || !CS_STATES.has(c.state) || !CS_ORIGINS.has(c.origin) || !CS_CHECKS.has(c.checks) || !isCount(c.seq) || !isCount(c.paths)) {
    throw new Error(`${CS_KEY}: invalid change-set trailer ${JSON.stringify(c)}`);
  }
  return `${c.csId} state=${c.state} seq=${c.seq} origin=${c.origin} checks=${c.checks} paths=${c.paths}`;
}
function parseCs(value) {
  const t = value.split(" ");
  if (t.length !== 6) return null;
  const field2 = (i, key) => t[i].startsWith(`${key}=`) ? t[i].slice(key.length + 1) : null;
  const csId = t[0];
  const state = field2(1, "state");
  const seq = field2(2, "seq");
  const origin = field2(3, "origin");
  const checks = field2(4, "checks");
  const paths = field2(5, "paths");
  if (!validId("cs", csId) || state === null || !CS_STATES.has(state) || origin === null || !CS_ORIGINS.has(origin) || checks === null || !CS_CHECKS.has(checks)) return null;
  const seqN = seq === null ? null : parseCount(seq);
  const pathsN = paths === null ? null : parseCount(paths);
  if (seqN === null || pathsN === null) return null;
  return { csId, state, seq: seqN, origin, checks, paths: pathsN };
}
var byUtf8 = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
function encodeCsPaths(paths) {
  const unique = [...new Set(paths)];
  if (unique.length > CS_PATHS_MAX) throw new RangeError(`${CS_PATHS_KEY}: ${unique.length} paths > ${CS_PATHS_MAX}`);
  for (const p of unique) {
    if (!validPathSyntax(p)) throw new Error(`${CS_PATHS_KEY}: invalid path ${JSON.stringify(p)}`);
  }
  unique.sort(byUtf8);
  return deflateSync(Buffer.from(unique.join("\0"), "utf8")).toString("base64url");
}
function decodeCsPaths(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  let raw;
  try {
    raw = inflateSync(Buffer.from(s, "base64url"), { maxOutputLength: CS_PATHS_MAX_BYTES });
  } catch {
    return null;
  }
  const text2 = raw.toString("utf8");
  if (!Buffer.from(text2, "utf8").equals(raw)) return null;
  if (text2.length === 0) return [];
  const paths = text2.split("\0");
  if (paths.length > CS_PATHS_MAX || !paths.every((p) => validPathSyntax(p)) || new Set(paths).size !== paths.length) return null;
  return paths;
}
function parseCsTrailers(trailers) {
  const cs = [];
  const counts = /* @__PURE__ */ new Map();
  for (const t of trailers) {
    if (t.key !== CS_KEY) continue;
    const c = parseCs(t.value);
    if (c === null || counts.has(c.csId)) continue;
    cs.push(c);
    counts.set(c.csId, c.paths);
  }
  const paths = /* @__PURE__ */ new Map();
  for (const t of trailers) {
    if (t.key !== CS_PATHS_KEY) continue;
    const sp = t.value.indexOf(" ");
    if (sp <= 0) continue;
    const csId = t.value.slice(0, sp);
    const n = counts.get(csId);
    if (n === void 0 || paths.has(csId)) continue;
    const list = decodeCsPaths(t.value.slice(sp + 1));
    if (list !== null && list.length === n) paths.set(csId, list);
  }
  return { cs, paths };
}
function headTrailers(w) {
  return [{ key: SKIP_CHECKS, value: "true" }, { key: PROTO_KEY, value: String(PROTO) }, { key: WRITER_KEY, value: formatWriter(w) }];
}
function csTrailers(cs, csPaths) {
  const lines = [];
  const pathLines = [];
  const seen = /* @__PURE__ */ new Set();
  for (const c of cs) {
    if (seen.has(c.csId)) throw new Error(`${CS_KEY}: change-set ${c.csId} listed twice`);
    seen.add(c.csId);
    lines.push({ key: CS_KEY, value: formatCs(c) });
    const list = csPaths.get(c.csId);
    if (list === void 0) {
      if (c.paths <= CS_PATHS_MAX) throw new Error(`${CS_PATHS_KEY}: no path list for ${c.csId} (paths=${c.paths} <= ${CS_PATHS_MAX})`);
      continue;
    }
    const n = new Set(list).size;
    if (n !== c.paths) throw new Error(`${CS_KEY}: ${c.csId} has paths=${c.paths} but ${n} paths are listed`);
    if (n <= CS_PATHS_MAX) pathLines.push({ key: CS_PATHS_KEY, value: `${c.csId} ${encodeCsPaths(list)}` });
  }
  return [...lines, ...pathLines];
}
function liveCommitTrailers(writer, seats, cs, csPaths, base) {
  const out = headTrailers(writer);
  for (const seat of [...new Set(seats)].sort()) {
    if (seat !== HUMAN && !validId("hex128", seat)) throw new Error(`${SEAT_KEY}: not a seat id ${JSON.stringify(seat)}`);
    out.push({ key: SEAT_KEY, value: seat });
  }
  out.push(...csTrailers(cs, csPaths));
  if (base !== null) out.push({ key: BASE_KEY, value: parseOid(base) });
  return out;
}
function boardTrailers(writer, cs, csPaths) {
  return [...headTrailers(writer), ...csTrailers(cs, csPaths)];
}
async function topEntries(repo, treeish) {
  const out = /* @__PURE__ */ new Map();
  const r = await repo.run(["ls-tree", "-z", parseOid(treeish)]);
  for (const rec of r.stdout.toString("utf8").split("\0")) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf("	");
    const meta = tab < 0 ? [] : rec.slice(0, tab).split(" ");
    const [mode = "", type = "", oid2 = ""] = meta;
    if (meta.length !== 3 || !ENTRY_MODES.has(mode) || type !== "blob" && type !== "tree" && type !== "commit") {
      throw new Error(`ls-tree: unexpected record ${JSON.stringify(rec.slice(0, 120))}`);
    }
    const name = rec.slice(tab + 1);
    out.set(name, { name, mode, type, oid: parseOid(oid2) });
  }
  return out;
}
async function checkpointEntry(repo, state) {
  const blob2 = await repo.hashBytes(state, true);
  const tree2 = await repo.mktree([{ name: STATE_FILE, mode: "100644", type: "blob", oid: blob2 }]);
  return { name: CHECKPOINT_DIR, mode: "040000", type: "tree", oid: tree2 };
}
async function buildBoardCommit(repo, b) {
  const trailers = boardTrailers(b.writer, b.cs, b.csPaths);
  for (const op of b.ops) {
    const id = parseOpId(op.id);
    if (id === null || id.peer !== b.writer.peer || id.epoch !== b.writer.epoch || id.seq >= b.writer.seq) {
      throw new Error(`buildBoardCommit: op ${JSON.stringify(op.id)} is not an op of writer ${formatWriter(b.writer)} below its seq`);
    }
  }
  const entries = [{ name: OPS_FILE, mode: "100644", type: "blob", oid: await repo.hashBytes(serializeOps(b.ops), true) }];
  if (b.prevBoard === null) {
    if (b.protocol === null) throw new Error("buildBoardCommit: B0 needs protocol.json (PRO-07)");
    if (b.checkpoint === null) throw new Error("buildBoardCommit: B0 needs the height-0 checkpoint/state.json (PRO-07)");
    entries.push({ name: PROTOCOL_FILE, mode: "100644", type: "blob", oid: await repo.hashBytes(serializeProtocol(b.protocol), true) });
    entries.push(await checkpointEntry(repo, b.checkpoint));
  } else {
    if (b.protocol !== null) throw new Error("buildBoardCommit: protocol.json is written only at genesis and carried after it (PRO-04)");
    const prev = await topEntries(repo, b.prevBoard);
    const protocol = prev.get(PROTOCOL_FILE);
    if (protocol === void 0 || protocol.type !== "blob") throw new BoardMalformedError("entry_missing", `buildBoardCommit: previous board ${b.prevBoard} has no protocol.json to carry`);
    entries.push(protocol);
    if (b.checkpoint !== null) {
      entries.push(await checkpointEntry(repo, b.checkpoint));
    } else {
      const ck = prev.get(CHECKPOINT_DIR);
      if (ck === void 0 || ck.type !== "tree") throw new BoardMalformedError("entry_missing", `buildBoardCommit: previous board ${b.prevBoard} has no checkpoint/ to carry`);
      entries.push(ck);
    }
    const held = prev.get(HELD_DIR);
    if (held !== void 0 && held.type === "tree") entries.push(held);
  }
  const tree2 = await repo.mktree(entries);
  const over = capViolation(await boardEntries(repo, tree2));
  if (over !== null && over.reason === "entry_missing") throw new BoardMalformedError(over.reason, `buildBoardCommit: previous board ${b.prevBoard ?? "(none)"} carries ${over.detail}`);
  if (over !== null) throw new BoardCapError(`buildBoardCommit: the board tree would have ${over.detail}`);
  const parents = b.prevBoard === null ? [b.liveCode] : [b.prevBoard, b.liveCode];
  const commit = await repo.commitTree({ tree: tree2, parents, subject: BOARD_SUBJECT, trailers });
  const size = await objectSize(repo, commit);
  if (size > BOARD_COMMIT_OBJECT_MAX_BYTES) {
    throw new BoardCapError(`buildBoardCommit: the board commit object would be ${size} bytes > ${BOARD_COMMIT_OBJECT_MAX_BYTES}`);
  }
  return commit;
}
async function objectSize(repo, o) {
  const text2 = (await repo.run(["cat-file", "-s", parseOid(o)])).stdout.toString("utf8").trim();
  const size = Number(text2);
  if (!/^[0-9]+$/.test(text2) || !Number.isSafeInteger(size)) throw new Error(`cat-file -s: unexpected output ${JSON.stringify(text2.slice(0, 40))}`);
  return size;
}
var TYPE_SIZE_CHECK = "--batch-check=%(objecttype) %(objectsize)";
async function objectTypesAndSizes(repo, oids) {
  const names = oids.map((o) => parseOid(o));
  const out = (await repo.run(["cat-file", TYPE_SIZE_CHECK], { stdin: Buffer.from(`${names.join("\n")}
`, "utf8") })).stdout.toString("utf8");
  const lines = out.split("\n");
  if (lines.length !== names.length + 1 || lines[names.length] !== "") {
    throw new Error(`cat-file --batch-check: ${lines.length - 1} records for ${names.length} objects`);
  }
  return names.map((name, i) => {
    const line = lines[i];
    const parts = line.split(" ");
    if (parts.length === 2 && parts[0] === name && parts[1] === "missing") return null;
    const [type = "", sizeText = ""] = parts;
    const size = Number(sizeText);
    if (parts.length !== 2 || !/^[a-z]+$/.test(type) || !/^[0-9]+$/.test(sizeText) || !Number.isSafeInteger(size)) {
      throw new Error(`cat-file --batch-check: unexpected record ${JSON.stringify(line.slice(0, 120))}`);
    }
    return { type, size };
  });
}
function isAbsentRecord(parts) {
  return parts.length === 2 && parts[0].length > 0 && /^[a-z]+$/.test(parts[1]);
}
function batchObjects(out, expected) {
  const items = [];
  let pos = 0;
  while (items.length < expected) {
    const nl = out.indexOf(10, pos);
    if (nl < 0) throw new Error("cat-file --batch: truncated output");
    const parts = out.toString("utf8", pos, nl).split(" ");
    pos = nl + 1;
    if (isAbsentRecord(parts)) {
      items.push(null);
      continue;
    }
    const size = Number(parts[2]);
    if (parts.length !== 3 || !Number.isSafeInteger(size) || size < 0 || pos + size > out.length) {
      throw new Error(`cat-file --batch: malformed header ${JSON.stringify(parts.join(" ").slice(0, 120))}`);
    }
    items.push({ type: parts[1], body: out.subarray(pos, pos + size) });
    pos += size + 1;
  }
  return items;
}
function subtreeNames(raw, hashBytes) {
  const names = [];
  let pos = 0;
  while (pos < raw.length) {
    const sp = raw.indexOf(32, pos);
    const nul = sp < 0 ? -1 : raw.indexOf(0, sp + 1);
    if (nul < 0 || nul + 1 + hashBytes > raw.length) throw new Error("readBoardCommit: malformed tree object");
    if (raw.toString("latin1", pos, sp) === "40000") names.push(raw.toString("utf8", sp + 1, nul));
    pos = nul + 1 + hashBytes;
  }
  return names;
}
function batchCheck(out, expected) {
  const lines = out.toString("utf8").split("\n");
  const items = [];
  for (let i = 0; i < expected; i++) {
    const line = lines[i];
    if (line === void 0 || i + 1 >= lines.length) throw new Error("cat-file --batch-check: truncated output");
    const parts = line.split(" ");
    if (isAbsentRecord(parts)) {
      items.push(null);
      continue;
    }
    const size = Number(parts[2]);
    if (parts.length !== 3 || !isOid(parts[0]) || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`cat-file --batch-check: malformed record ${JSON.stringify(line.slice(0, 120))}`);
    }
    items.push({ oid: parts[0], type: parts[1], size });
  }
  return items;
}
async function boardEntriesOf(repo, trees) {
  const names = trees.flatMap((tree2) => [`${tree2}`, `${tree2}:${OPS_FILE}`, `${tree2}:${PROTOCOL_FILE}`, `${tree2}:${CHECKPOINT_DIR}/${STATE_FILE}`, `${tree2}:${HELD_DIR}`]);
  const checked = await repo.run(["cat-file", "--batch-check"], { stdin: Buffer.from(`${names.join("\n")}
`, "utf8") });
  const ofType = (e, type) => e !== null && e !== void 0 && e.type === type ? e : null;
  const all = batchCheck(checked.stdout, names.length);
  return trees.map((_, i) => {
    const [root, ops, protocol, checkpoint, held] = all.slice(5 * i, 5 * i + 5);
    return { root: ofType(root, "tree"), ops: ofType(ops, "blob"), protocol: ofType(protocol, "blob"), checkpoint: ofType(checkpoint, "blob"), held: ofType(held, "tree") };
  });
}
async function boardEntries(repo, tree2) {
  return (await boardEntriesOf(repo, [tree2]))[0];
}
function capViolation(e) {
  const root = e.root?.size ?? 0;
  if (root > BOARD_ROOT_TREE_MAX_BYTES) return { reason: "board_too_large", detail: `a root tree object of ${root} bytes > ${BOARD_ROOT_TREE_MAX_BYTES}` };
  if (e.ops !== null && e.ops.size > OPS_MAX_BYTES) return { reason: "ops_too_large", detail: `an ops.jsonl of ${e.ops.size} bytes > ${OPS_MAX_BYTES}` };
  const files = (e.ops?.size ?? 0) + (e.protocol?.size ?? 0) + (e.checkpoint?.size ?? 0);
  const held = e.held?.size ?? 0;
  if (files > BOARD_TREE_MAX_BYTES || held > BOARD_TREE_MAX_BYTES) {
    return { reason: "board_too_large", detail: `more than the ${BOARD_TREE_MAX_BYTES}-byte board tree cap (files ${files}, held/ ${held})` };
  }
  if (e.checkpoint === null) return { reason: "entry_missing", detail: "no checkpoint/state.json blob (PRO-02)" };
  return null;
}
var UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeLine(bytes) {
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    return "";
  }
}
function opsLinesOf(buf) {
  const lines = [];
  if (buf === null) return lines;
  let pos = 0;
  while (lines.length < OPS_MAX_LINES && pos < buf.length) {
    const lf = buf.indexOf(10, pos);
    const end = lf < 0 ? buf.length : lf;
    lines.push(decodeLine(buf.subarray(pos, end)));
    pos = end + 1;
  }
  return lines;
}
function ownAscii(s) {
  return Buffer.from(s, "latin1").toString("latin1");
}
function ownWriter(w) {
  return w === null ? null : { peer: ownAscii(w.peer), epoch: ownAscii(w.epoch), seq: w.seq };
}
async function readBoardCommit(repo, oid2, opts = {}) {
  const object = (await objectTypesAndSizes(repo, [oid2]))[0] ?? null;
  if (object === null) throw new Error(`readBoardCommit: ${oid2} is missing`);
  if (object.type !== "commit") {
    throw new BoardMalformedError("not_commit", `readBoardCommit: ${oid2} is a ${object.type}, not a commit (a board ref names a commit; a tag is never peeled)`);
  }
  if (object.size > BOARD_COMMIT_OBJECT_MAX_BYTES) {
    throw new BoardMalformedError("commit_too_large", `readBoardCommit: ${oid2} is a ${object.size}-byte commit object > ${BOARD_COMMIT_OBJECT_MAX_BYTES}`);
  }
  const info = await repo.readCommit(oid2);
  const last = info.parents[info.parents.length - 1];
  if (last === void 0) throw new BoardMalformedError("no_parent", `readBoardCommit: ${oid2} has no parent, so it is not a board commit`);
  const found = await boardEntries(repo, info.tree);
  const over = capViolation(found);
  if (over !== null) throw new BoardMalformedError(over.reason, `readBoardCommit: ${oid2} has ${over.detail}`);
  const ops = found.ops;
  const protocol = found.protocol;
  const checkpoint = opts.checkpoint === false ? null : found.checkpoint;
  const held = opts.held === false ? null : found.held;
  const present = [ops, protocol, checkpoint, held].filter((e) => e !== null);
  const bodies = /* @__PURE__ */ new Map();
  if (present.length > 0) {
    const r = await repo.run(["cat-file", "--batch"], { stdin: Buffer.from(`${present.map((e) => e.oid).join("\n")}
`, "utf8") });
    batchObjects(r.stdout, present.length).forEach((o, i) => {
      const e = present[i];
      if (o === null || o.type !== e.type || o.body.length !== e.size) throw new Error(`readBoardCommit: cat-file --batch disagrees with --batch-check on ${e.oid}`);
      bodies.set(e, o.body);
    });
  }
  const body = (e) => e === null ? null : bodies.get(e) ?? null;
  const heldBody = body(held);
  const checkpointBody = body(checkpoint);
  const writers = info.trailers.filter((t) => t.key === WRITER_KEY);
  return {
    oid: oid2,
    parents: [...info.parents],
    firstParent: info.parents.length >= 2 ? info.parents[0] : null,
    liveCode: last,
    writer: writers.length === 1 ? ownWriter(parseWriter(writers[0].value)) : null,
    cs: parseCsTrailers(info.trailers).cs.map((c) => ({ ...c, csId: ownAscii(c.csId) })),
    protocol: readProtocol(body(protocol)),
    opsLines: opsLinesOf(body(ops)),
    checkpoint: checkpointBody === null ? null : Buffer.from(checkpointBody),
    heldIds: heldBody === null ? [] : subtreeNames(heldBody, oid2.length / 2)
  };
}
function shapeRecord(c) {
  const trailers = [];
  let skip = false;
  let proto = false;
  let bases = 0;
  for (const t of c.trailers) {
    if (t.key === SKIP_CHECKS && !skip) {
      skip = true;
      trailers.push({ key: SKIP_CHECKS, value: "" });
    } else if (t.key === PROTO_KEY && !proto) {
      proto = true;
      trailers.push({ key: PROTO_KEY, value: "" });
    } else if (t.key === BASE_KEY && bases < 2) {
      bases += 1;
      trailers.push({ key: BASE_KEY, value: isOid(t.value) ? ownAscii(t.value) : "" });
    }
  }
  const p = c.parents;
  const parents = p.length <= 3 ? [...p] : [p[0], p[1], p[p.length - 1]];
  return { oid: c.oid, tree: c.tree, parents, subject: c.subject.startsWith(SKIP_SUBJECT_PREFIX) ? SKIP_SUBJECT_PREFIX : "", trailers };
}
async function readCommitsChecked(repo, oids) {
  if (oids.length === 0) return [];
  const infos = await objectTypesAndSizes(repo, oids);
  const refused = infos.map((info, i) => {
    if (info === null) throw new Error(`readCommitsChecked: ${oids[i]} is missing`);
    return info.type !== "commit" ? "not_commit" : info.size > BOARD_COMMIT_OBJECT_MAX_BYTES ? "commit_too_large" : null;
  });
  const chunks = [];
  const queued = /* @__PURE__ */ new Set();
  oids.forEach((oid2, i) => {
    if (refused[i] !== null || queued.has(oid2)) return;
    queued.add(oid2);
    const size = infos[i].size;
    const last = chunks[chunks.length - 1];
    if (last !== void 0 && last.bytes + size <= BATCH_READ_MAX_BYTES) {
      last.oids.push(oid2);
      last.bytes += size;
    } else {
      chunks.push({ oids: [oid2], bytes: size });
    }
  });
  const read = /* @__PURE__ */ new Map();
  for (const chunk of chunks) {
    const r = await repo.run(["cat-file", "--batch"], { stdin: Buffer.from(`${chunk.oids.join("\n")}
`, "utf8") });
    batchObjects(r.stdout, chunk.oids.length).forEach((o, k) => {
      const oid2 = chunk.oids[k];
      if (o === null || o.type !== "commit" || o.body.length > BOARD_COMMIT_OBJECT_MAX_BYTES) {
        throw new Error(`readCommitsChecked: cat-file --batch disagrees with --batch-check on ${oid2}`);
      }
      read.set(oid2, shapeRecord(parseCommitObject(oid2, o.body.toString("utf8"))));
    });
  }
  return oids.map((oid2, i) => {
    const why = refused[i] ?? null;
    if (why !== null) return { commit: null, refused: why };
    const commit = read.get(oid2);
    if (commit === void 0) throw new Error(`readCommitsChecked: ${oid2} was not read`);
    return { commit, refused: null };
  });
}
async function checkBoardCommits(repo, oids) {
  const out = (await readCommitsChecked(repo, oids)).map((c) => c.commit === null ? { commit: null, refused: c.refused } : { commit: c.commit, refused: c.commit.parents.length === 0 ? "no_parent" : null });
  const pending = out.filter((c) => c.commit !== null && c.refused === null);
  if (pending.length > 0) {
    (await boardEntriesOf(repo, pending.map((c) => c.commit.tree))).forEach((e, k) => {
      const over = capViolation(e);
      if (over !== null) pending[k].refused = over.reason;
    });
  }
  return out;
}
function hasMarkers(c) {
  return c.subject.startsWith(SKIP_SUBJECT_PREFIX) && c.trailers.some((t) => t.key === SKIP_CHECKS) && c.trailers.some((t) => t.key === PROTO_KEY);
}
function boardShapeOk(c, expectedPrev) {
  if (!hasMarkers(c)) return false;
  if (expectedPrev === null) return c.parents.length === 1;
  return c.parents.length === 2 && c.parents[0] === expectedPrev;
}
function liveShape(c, expectedPrev) {
  if (!hasMarkers(c)) return null;
  const bases = c.trailers.filter((t) => t.key === BASE_KEY).map((t) => t.value);
  if (expectedPrev === null) return c.parents.length === 0 && bases.length === 1 && isOid(bases[0]) ? "genesis" : null;
  if (c.parents[0] !== expectedPrev) return null;
  if (c.parents.length === 1) return bases.length === 0 ? "ordinary" : null;
  if (c.parents.length === 2) return bases.length === 1 && bases[0] === c.parents[1] ? "base_move" : null;
  return null;
}

// src/board/fold.ts
var CHECKPOINT_EVERY = 256;
var COMPACT_AGE = 512;
var K_EVICT = 200;
var CONFLICT_KINDS = /* @__PURE__ */ new Set(["K1", "K2", "K3", "K4", "K5", "K6", "K7", "breach"]);
var EVENT_KINDS2 = /* @__PURE__ */ new Set(["K1", "K2", "K3", "K4", "K5", "K6", "K7", "breach", "freeze", "unfreeze", "incident", "nonretryable", "health"]);
var OP_TYPES2 = /* @__PURE__ */ new Set([
  "join",
  "leave",
  "caps",
  "seat_start",
  "seat_end",
  "claim",
  "release",
  "request",
  "request_status",
  "answer",
  "note",
  "presume_absent",
  "hold",
  "event",
  "save"
]);
var HOST_THROTTLED = "HOST_THROTTLED";
var CID_RE2 = /^[0-9A-HJKMNP-TV-Z]{8}$/;
var has = (o, k) => Object.hasOwn(o, k);
var isInt = (x, min) => typeof x === "number" && Number.isSafeInteger(x) && x >= min;
function peerOf(s, peer) {
  return has(s.peers, peer) ? s.peers[peer] : void 0;
}
function initialFoldState(protocol) {
  return {
    v: 1,
    height: -1,
    proto: isInt(protocol.proto, 0) ? protocol.proto : 0,
    teamRegionSpec: protocol.regionSpec,
    caps: null,
    peers: {},
    seats: {},
    claims: {},
    requests: {},
    holds: {},
    notes: {},
    events: {},
    last_save: null,
    record_count: 0
  };
}
function validWriter(w) {
  if (w === null || typeof w !== "object") return null;
  return validId("hex128", w.peer) && validId("hex128", w.epoch) && isInt(w.seq, 1) ? w : null;
}
function genericOk(s, w, id, prevSeq, type) {
  if (id.peer !== w.peer || id.epoch !== w.epoch) return false;
  if (id.seq >= w.seq || id.seq <= prevSeq) return false;
  const rec = peerOf(s, w.peer);
  if (rec !== void 0) {
    if (rec.retired_epochs.includes(w.epoch)) return false;
    if (rec.epoch === w.epoch && id.seq <= rec.last_seq) return false;
  }
  return type === "join" || rec !== void 0 && rec.epoch === w.epoch && rec.status === "active";
}
function endSeats(s, peer, epoch, h) {
  const prefix = `${peer}/${epoch}/`;
  for (const [key, seat] of Object.entries(s.seats)) {
    if (key.startsWith(prefix) && seat.status === "live") s.seats[key] = { status: "ended", permission_mode: seat.permission_mode, ended_height: h };
  }
}
function applyJoin(s, w, op, seq, h) {
  const cf = op.config_fingerprint;
  const fields = {
    display: op.display,
    plugin_version: op.plugin_version,
    plugin_sha: op.plugin_sha,
    regionSpec: op.regionSpec,
    config_fingerprint: { filters: Object.fromEntries(Object.entries(cf.filters)), autocrlf: cf.autocrlf, eol_attrs: cf.eol_attrs, git: cf.git },
    coauthor_optin: op.coauthor_optin
  };
  const rec = peerOf(s, w.peer);
  if (rec === void 0) {
    s.peers[w.peer] = { epoch: w.epoch, status: "active", retired_epochs: [], ...fields, last_seq: seq, last_height: -1 };
    return;
  }
  if (rec.epoch !== w.epoch) {
    rec.retired_epochs.push(rec.epoch);
    endSeats(s, w.peer, rec.epoch, h);
    rec.epoch = w.epoch;
    rec.last_seq = seq;
  }
  rec.status = "active";
  Object.assign(rec, fields);
}
function applyOp(s, w, op, seq, h) {
  switch (op.type) {
    case "join":
      applyJoin(s, w, op, seq, h);
      return true;
    case "leave": {
      peerOf(s, w.peer).status = "left";
      endSeats(s, w.peer, w.epoch, h);
      return true;
    }
    case "seat_start": {
      const key = `${w.peer}/${w.epoch}/${op.seat_id}`;
      if (has(s.seats, key) && s.seats[key].status === "live") return false;
      s.seats[key] = { status: "live", permission_mode: op.permission_mode };
      return true;
    }
    case "seat_end": {
      const key = `${w.peer}/${w.epoch}/${op.seat_id}`;
      const cur = has(s.seats, key) ? s.seats[key] : void 0;
      if (cur === void 0 || cur.status !== "live") return false;
      s.seats[key] = { status: "ended", permission_mode: cur.permission_mode, ended_height: h };
      return true;
    }
    case "event": {
      if (CONFLICT_KINDS.has(op.kind) && has(s.events, op.cid)) return false;
      s.events[op.cid] = { kind: op.kind, refs: [...op.refs], reason_code: op.reason_code, op_id: op.id, height: h };
      return true;
    }
    case "caps":
      s.caps = { custom_refs: op.custom_refs, lease: op.lease, delete: op.delete, push_options: op.push_options, two_parent_ok: op.two_parent_ok };
      return true;
    case "save":
      s.last_save = { save_commit: op.save_commit, saved_live: op.saved_live, chain_base: op.chain_base, height: h };
      return true;
    default:
      return true;
  }
}
function malformedRejection(line) {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const id = v["id"];
  const type = v["type"];
  if (typeof id !== "string" || parseOpId(id) === null) return null;
  return { opId: id, type: typeof type === "string" && OP_TYPES2.has(type) ? type : "unknown", reason: "type" };
}
function reevaluateTeamRegionSpec(s) {
  const r = rankedSet(s);
  if (r.length === 0) return;
  const x = s.peers[r[0]].regionSpec;
  if (x !== s.teamRegionSpec && r.every((p) => s.peers[p].regionSpec === x)) s.teamRegionSpec = x;
}
function compact(s, h) {
  const limit = h - COMPACT_AGE;
  for (const [cid, e] of Object.entries(s.events)) {
    if (e.height <= limit) delete s.events[cid];
  }
  for (const [key, seat] of Object.entries(s.seats)) {
    if (seat.status === "ended" && seat.ended_height !== void 0 && seat.ended_height <= limit) delete s.seats[key];
  }
}
function countRecords(s) {
  let ended = 0;
  for (const seat of Object.values(s.seats)) if (seat.status === "ended") ended++;
  return Object.keys(s.claims).length + Object.keys(s.requests).length + Object.keys(s.holds).length + Object.keys(s.events).length + Object.keys(s.notes).length + ended;
}
function foldCommit(prev, c, self) {
  const s = structuredClone(prev);
  const h = prev.height + 1;
  s.height = h;
  const ownRejections = [];
  const landedOwnOpIds = [];
  const opVerdicts = c.opsLines.map((_, line) => ({ line, opId: null, type: "unknown", verdict: "rejected", reason: "generic" }));
  const proto = isInt(c.protocol.proto, 0) ? c.protocol.proto : 0;
  s.proto = proto;
  const w = validWriter(c.writer);
  if (w !== null) {
    const own = w.peer === self;
    let prevSeq = 0;
    let bytes = 0;
    const n = Math.min(c.opsLines.length, OPS_MAX_LINES);
    for (let i = 0; i < n; i++) {
      const line = c.opsLines[i];
      bytes += Buffer.byteLength(line, "utf8") + 1;
      if (bytes > OPS_MAX_BYTES) break;
      const op = parseOpLine(line);
      if (op === null) {
        opVerdicts[i] = { line: i, opId: null, type: "unknown", verdict: "rejected", reason: "malformed" };
        const r = own ? malformedRejection(line) : null;
        if (r !== null) ownRejections.push(r);
        continue;
      }
      const id = parseOpId(op.id);
      if (id === null) {
        opVerdicts[i] = { line: i, opId: null, type: "unknown", verdict: "rejected", reason: "malformed" };
        continue;
      }
      const ok = genericOk(s, w, id, prevSeq, op.type);
      if (id.peer === w.peer && id.epoch === w.epoch && id.seq > prevSeq) prevSeq = id.seq;
      if (!ok) {
        opVerdicts[i] = { line: i, opId: op.id, type: op.type, verdict: "rejected", reason: "generic" };
        if (own) ownRejections.push({ opId: op.id, type: op.type, reason: "generic" });
        continue;
      }
      if (!applyOp(s, w, op, id.seq, h)) {
        opVerdicts[i] = { line: i, opId: op.id, type: op.type, verdict: "rejected", reason: "type" };
        if (own) ownRejections.push({ opId: op.id, type: op.type, reason: "type" });
        continue;
      }
      opVerdicts[i] = { line: i, opId: op.id, type: op.type, verdict: PLAN2_FOLDED_TYPES.has(op.type) ? "effective" : "unfolded" };
      if (own) landedOwnOpIds.push(op.id);
    }
    const rec = peerOf(s, w.peer);
    if (rec !== void 0) {
      rec.last_height = h;
      if (rec.epoch === w.epoch) rec.last_seq = Math.max(rec.last_seq, w.seq);
    }
  }
  reevaluateTeamRegionSpec(s);
  if (h % CHECKPOINT_EVERY === 0) compact(s, h);
  s.record_count = countRecords(s);
  return { state: s, ownRejections, landedOwnOpIds, protoMismatch: proto !== PROTO, opVerdicts };
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
function isObj2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function keysAre(o, keys3) {
  const k = Object.keys(o).sort();
  return k.length === keys3.length && k.every((x, i) => x === keys3[i]);
}
var isStrArray2 = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
function toPeer(v) {
  if (!isObj2(v) || !keysAre(v, PEER_KEYS)) return null;
  const { epoch, status, retired_epochs: retired, display, plugin_version: pv, plugin_sha: ps, regionSpec, config_fingerprint: cf, coauthor_optin: co, last_seq: ls, last_height: lh } = v;
  if (typeof epoch !== "string" || !validId("hex128", epoch) || typeof status !== "string" || !PEER_STATUS.has(status)) return null;
  if (!isStrArray2(retired) || !retired.every((e) => validId("hex128", e))) return null;
  if (typeof display !== "string" || typeof pv !== "string" || typeof ps !== "string" || typeof regionSpec !== "string") return null;
  if (co !== false && typeof co !== "string") return null;
  if (!isInt(ls, 0) || !isInt(lh, -1)) return null;
  return {
    epoch,
    status,
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
  if (!isObj2(v) || typeof v["permission_mode"] !== "string") return null;
  if (v["status"] === "live" && keysAre(v, ["permission_mode", "status"])) return { status: "live", permission_mode: v["permission_mode"] };
  if (v["status"] === "ended" && keysAre(v, ["ended_height", "permission_mode", "status"]) && isInt(v["ended_height"], 0)) {
    return { status: "ended", permission_mode: v["permission_mode"], ended_height: v["ended_height"] };
  }
  return null;
}
function toEvent(v) {
  if (!isObj2(v) || !keysAre(v, EVENT_KEYS)) return null;
  const { kind, refs, reason_code: rc, op_id: opId, height } = v;
  if (typeof kind !== "string" || !EVENT_KINDS2.has(kind) || !isStrArray2(refs)) return null;
  if (typeof rc !== "string" || !REASON_CODE_RE.test(rc) || typeof opId !== "string" || !validId("op", opId) || !isInt(height, 0)) return null;
  return { kind, refs, reason_code: rc, op_id: opId, height };
}
function toRecord(v, keyOk, conv) {
  if (!isObj2(v)) return null;
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
  if (!isObj2(v) || !keysAre(v, STATE_KEYS)) return null;
  if (v["v"] !== 1 || !isInt(v["height"], -1) || !isInt(v["proto"], 0) || typeof v["teamRegionSpec"] !== "string" || !isInt(v["record_count"], 0)) return null;
  const capsV = v["caps"];
  let caps = null;
  if (capsV !== null) {
    if (!isObj2(capsV) || !keysAre(capsV, CAPS_KEYS) || !CAPS_KEYS.every((k) => typeof capsV[k] === "boolean")) return null;
    caps = { custom_refs: capsV["custom_refs"], lease: capsV["lease"], delete: capsV["delete"], push_options: capsV["push_options"], two_parent_ok: capsV["two_parent_ok"] };
  }
  const saveV = v["last_save"];
  let lastSave = null;
  if (saveV !== null) {
    if (!isObj2(saveV) || !keysAre(saveV, SAVE_KEYS) || !isOid(saveV["save_commit"]) || !isOid(saveV["saved_live"]) || !isOid(saveV["chain_base"]) || !isInt(saveV["height"], 0)) return null;
    lastSave = { save_commit: saveV["save_commit"], saved_live: saveV["saved_live"], chain_base: saveV["chain_base"], height: saveV["height"] };
  }
  const peers = toRecord(v["peers"], (k) => validId("hex128", k), toPeer);
  const seats = toRecord(v["seats"], seatKeyOk, toSeat);
  const events = toRecord(v["events"], (k) => CID_RE2.test(k), toEvent);
  const opaque2 = (x) => isObj2(x) ? x : null;
  const claims = opaque2(v["claims"]);
  const requests = opaque2(v["requests"]);
  const holds = opaque2(v["holds"]);
  const notes = opaque2(v["notes"]);
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
function rankedSet(s) {
  return liveSet(s).filter((p) => s.height - s.peers[p].last_height < K_EVICT);
}
function governorRank(s, self) {
  const r = rankedSet(s);
  if (!r.includes(self)) return 1;
  const mine = s.peers[self].last_height;
  let before = 0;
  for (const p of r) {
    const lh = s.peers[p].last_height;
    if (lh < mine || lh === mine && p < self) before++;
  }
  return 1 + before;
}
var isThrottle = (e) => e.kind === "health" && e.reason_code === HOST_THROTTLED;
function recentThrottleEvent(s, heights) {
  return Object.values(s.events).some((e) => isThrottle(e) && s.height - e.height < heights);
}
var READ_AHEAD = 8;
var READ_CACHE_MAX_BYTES = 16 * 1048576;
function readCost(c) {
  let n = 1024 + 2 * c.protocol.regionSpec.length + (c.checkpoint?.length ?? 0);
  n += 128 * c.parents.length + 256 * c.cs.length + 128 * c.heldIds.length;
  for (const line of c.opsLines) n += 64 + 2 * line.length;
  return n;
}
var ReadCache = class {
  entries = /* @__PURE__ */ new Map();
  bytes = 0;
  /** The cached commit, when it was read with its checkpoint or none is needed. */
  get(oid2, withCheckpoint) {
    const hit = this.entries.get(oid2);
    if (hit === void 0 || withCheckpoint && hit.c.checkpoint === null) return void 0;
    this.entries.delete(oid2);
    this.entries.set(oid2, hit);
    return hit.c;
  }
  put(c) {
    const old = this.entries.get(c.oid);
    if (old !== void 0) {
      this.entries.delete(c.oid);
      this.bytes -= old.cost;
    }
    const cost = readCost(c);
    if (cost > READ_CACHE_MAX_BYTES) return;
    this.entries.set(c.oid, { c, cost });
    this.bytes += cost;
    for (const [oid2, e] of this.entries) {
      if (this.bytes <= READ_CACHE_MAX_BYTES) break;
      this.entries.delete(oid2);
      this.bytes -= e.cost;
    }
  }
};
function reportOf(r) {
  const h = r.state.height;
  const throttle = Object.values(r.state.events).filter((e) => e.height === h && isThrottle(e)).length;
  return { ownRejections: r.ownRejections, landedOwnOpIds: r.landedOwnOpIds, throttle };
}
function matches(c, s) {
  return c.checkpoint !== null && serializeFold(s).equals(c.checkpoint);
}
function restoredVerified(r) {
  const v = r?.verified;
  if (v === null || v === void 0 || typeof v !== "object") return null;
  return isOid(v.board) && isInt(v.height, 0) && v.height % CHECKPOINT_EVERY === 0 ? { board: v.board, height: v.height, state: null } : null;
}
var Folder = class {
  repo;
  self;
  /** The checkpoint this Folder most recently byte-verified (PRO-28): the refold base when it is on the chain. */
  verified;
  /** A checkpoint mismatch that survived one refold (R-13); cleared when a later checkpoint matches. */
  mismatch;
  /** The last tip whose height this Folder counted (heightOf). */
  known = null;
  constructor(repo, self, restored) {
    this.repo = repo;
    this.self = self;
    this.verified = restoredVerified(restored);
    this.mismatch = restored?.checkpointMismatch === true;
  }
  /** The verification to persist with the fold state (P2-FOLDPERSIST). */
  verification() {
    const v = this.verified;
    return { verified: v === null ? null : { board: v.board, height: v.height }, checkpointMismatch: this.mismatch };
  }
  async foldTo(tip, from, ownRegionSpec) {
    const cache = new ReadCache();
    const H2 = await this.heightOf(tip);
    const plan = (from === null ? null : await this.continueFrom(tip, H2, from)) ?? await this.startFromCheckpoint(tip, H2, cache);
    let state = plan.state;
    const start = plan.state.height;
    const reports = /* @__PURE__ */ new Map();
    const newCommits = [];
    let newest = null;
    for await (const c of this.readSeq(plan.oids, start + 1, cache)) {
      const r = foldCommit(state, c, this.self);
      state = r.state;
      reports.set(state.height, reportOf(r));
      if (state.height % CHECKPOINT_EVERY === 0) state = await this.verify(c, state, start, reports, cache);
      newCommits.push({ oid: c.oid, firstParent: c.firstParent, liveCode: c.liveCode });
      newest = c.protocol;
    }
    const last = newCommits[newCommits.length - 1];
    if (last !== void 0 && newest !== null) last.protocol = newest;
    const ownRejections = [];
    const landedOwnOpIds = [];
    let throttleEventsFolded = 0;
    for (const h of [...reports.keys()].sort((a, b) => a - b)) {
      const r = reports.get(h);
      ownRejections.push(...r.ownRejections);
      landedOwnOpIds.push(...r.landedOwnOpIds);
      throttleEventsFolded += r.throttle;
    }
    return {
      board: tip,
      state,
      newCommits,
      ownRejections,
      landedOwnOpIds,
      version: { proto: state.proto !== PROTO, regionSpec: ownRegionSpec !== state.teamRegionSpec, checkpointMismatch: this.mismatch },
      throttleEventsFolded
    };
  }
  /**
   * The height H of a board tip: B0's only parent is the parentless L0, so the first-parent chain of a tip at
   * height H has H + 2 commits. A commit's chain never changes, so the last tip's height is remembered and an
   * unchanged tip (the idle loop) costs no git call.
   */
  async heightOf(tip) {
    if (this.known !== null && this.known.tip === tip) return this.known.height;
    const H2 = await this.repo.firstParentCount(tip) - 2;
    if (!(H2 >= 0)) throw new RemoteContentError(`Folder: ${tip} is not a board commit`);
    this.known = { tip, height: H2 };
    return H2;
  }
  /**
   * PRO-25: the commits after from.board up to tip (height H), when from.board is the commit at from.state's
   * height on tip's first-parent chain (the tip itself, with nothing to fold, when that height is H); else null
   * (discard `from`). Only the tip's own chain is listed, so an unknown, unrelated or off-chain from.board never
   * reaches git.
   */
  async continueFrom(tip, H2, from) {
    const h0 = from.state.height;
    if (!Number.isSafeInteger(h0) || h0 < 0 || h0 > H2) return null;
    if (h0 === H2) return from.board === tip ? { state: from.state, oids: [] } : null;
    const n = H2 - h0;
    const chain = await this.repo.firstParents(tip, null, n + 1);
    if (chain.length !== n + 1 || chain[n] !== from.board) return null;
    return { state: from.state, oids: chain.slice(0, n).reverse() };
  }
  /**
   * PRO-29: the newest checkpoint at or below the tip that parses at its own height, trusted (glossary §24
   * default 9) and not marked verified (P2-REFOLD). At height 0 the fold of B0 from the empty state is
   * compared with B0's checkpoint instead: a match verifies B0 (same reads); otherwise the fold starts at genesis.
   */
  async startFromCheckpoint(tip, H2, cache) {
    for (let c = H2 - H2 % CHECKPOINT_EVERY; c >= 0; c -= CHECKPOINT_EVERY) {
      const chain = (await this.repo.firstParents(tip, null, H2 - c + 1)).reverse();
      if (chain.length !== H2 - c + 1) throw new RemoteContentError(`Folder: the first-parent chain of ${tip} is shorter than its count`);
      const ck = await this.read(chain[0], true, cache);
      if (c === 0) {
        if (ck.firstParent !== null) break;
        const s0 = foldCommit(initialFoldState(ck.protocol), ck, this.self).state;
        if (!matches(ck, s0)) break;
        this.markVerified(ck.oid, 0, s0);
        return { state: s0, oids: chain.slice(1) };
      }
      const s = ck.checkpoint === null ? null : parseFold(ck.checkpoint);
      if (s !== null && s.height === c) return { state: s, oids: chain.slice(1) };
    }
    return this.fromGenesis(tip, H2, cache);
  }
  async fromGenesis(at, h, cache) {
    const chain = (await this.repo.firstParents(at, null, h + 1)).reverse();
    const b0 = chain.length === h + 1 ? await this.read(chain[0], true, cache) : null;
    if (b0 === null || b0.firstParent !== null) throw new RemoteContentError(`Folder: the first-parent chain of ${at} does not start at a genesis board commit`);
    return { state: initialFoldState(b0.protocol), oids: chain };
  }
  /**
   * PRO-28 at a checkpoint height h: match → verified, flag cleared; mismatch → one refold (P2-REFOLD), whose
   * state and reports replace the incremental ones; still different → checkpointMismatch (R-13). A checkpoint
   * below h that the refold byte-matches on its way is verified too (B0 first, when it starts at genesis).
   * `start` is the height this call started folding from (its reports cover start + 1..h).
   */
  async verify(c, state, start, reports, cache) {
    const h = state.height;
    if (matches(c, state)) {
      this.markVerified(c.oid, h, state);
      this.mismatch = false;
      return state;
    }
    const base = await this.refoldBase(c.oid, h, start, cache);
    let s = base.state;
    for await (const x of this.readSeq(base.oids, base.state.height + 1, cache)) {
      const r = foldCommit(s, x, this.self);
      s = r.state;
      if (reports.has(s.height)) reports.set(s.height, reportOf(r));
      if (s.height < h && s.height % CHECKPOINT_EVERY === 0 && matches(x, s)) this.markVerified(x.oid, s.height, s);
    }
    if (matches(c, s)) {
      this.markVerified(c.oid, h, s);
      this.mismatch = false;
    } else {
      this.mismatch = true;
    }
    return s;
  }
  /**
   * Records a byte-verified checkpoint. Its state is a private copy: the state a call returns (or folds on
   * from) is the caller's, and a caller that edits it must not change a later refold's base.
   */
  markVerified(board, height, state) {
    this.verified = { board, height, state: structuredClone(state) };
  }
  /**
   * P2-REFOLD: the newest checkpoint this Folder byte-verified, when it lies below h and at or below `start`
   * (so the refold recomputes every report this call produced: one at h itself would fold nothing, one above
   * `start` would keep the reports between `start` and it) and it is the commit at its height on the
   * first-parent chain of `at` (height h); else genesis. Never a checkpoint the board merely carries: a wrong
   * but self-consistent lineage would match its own later checkpoints. A restored checkpoint's state is read
   * back from its commit (the bytes this Folder matched before the restart).
   */
  async refoldBase(at, h, start, cache) {
    const v = this.verified;
    if (v !== null && v.height < h && v.height <= start) {
      const n = h - v.height;
      const chain = await this.repo.firstParents(at, null, n + 1);
      if (chain.length === n + 1 && chain[n] === v.board) {
        v.state ??= await this.checkpointState(v.board, v.height, cache);
        if (v.state !== null) return { state: v.state, oids: chain.slice(0, n).reverse() };
      }
    }
    return this.fromGenesis(at, h, cache);
  }
  /** The checkpoint/state.json of `board` when it parses at `height`, else null. */
  async checkpointState(board, height, cache) {
    const ck = await this.read(board, true, cache);
    const s = ck.checkpoint === null ? null : parseFold(ck.checkpoint);
    return s !== null && s.height === height ? s : null;
  }
  /**
   * One board commit, from the call's cache or read (readBoardCommit's errors propagate typed). checkpoint/state.json is
   * read only when the caller compares or parses it (a checkpoint height, the starting checkpoint); held/ never (Plan 2
   * reads no held/ subtree). Every size and type check still runs on both.
   */
  async read(oid2, withCheckpoint, cache) {
    const hit = cache.get(oid2, withCheckpoint);
    if (hit !== void 0) return hit;
    const c = await readBoardCommit(this.repo, oid2, { checkpoint: withCheckpoint, held: false });
    cache.put(c);
    return c;
  }
  /**
   * The commits of `oids` in order, `oids[i]` at height firstHeight + i (its checkpoint read when that height is a
   * checkpoint height), read at most READ_AHEAD ahead of the one handed out: memory is bounded by the read-ahead, not
   * by the range (final review FA-3). A read that fails throws when its turn comes, so the earliest failing commit's
   * error is the one that propagates.
   */
  async *readSeq(oids, firstHeight, cache) {
    const ahead = [];
    let next = 0;
    const fill = () => {
      while (ahead.length < READ_AHEAD && next < oids.length) {
        const i = next++;
        const p = this.read(oids[i], (firstHeight + i) % CHECKPOINT_EVERY === 0, cache);
        p.catch(() => void 0);
        ahead.push(p);
      }
    };
    fill();
    while (ahead.length > 0) {
      const c = await ahead.shift();
      fill();
      yield c;
    }
  }
};

// src/holds/record.ts
var PLAN2_GUARD_CLASS = Object.freeze({
  conflict: "DECISION",
  restart: "DECISION",
  phantom: "DECISION",
  "host-reject": "DECISION",
  "eol-bom": "PREDICATE",
  join: "DECISION"
});
var WHOLE_PATH_GUARDS = Object.freeze(/* @__PURE__ */ new Set(["eol-bom", "generated?", "portability", "markers"]));
var TERMINAL_STATES = Object.freeze(/* @__PURE__ */ new Set(["SUBSUMED", "GONE", "RESOLVED_PUBLISH", "RESOLVED_DISCARD"]));
function isTerminal(r) {
  return TERMINAL_STATES.has(r.state);
}
function guardName(g) {
  const colon = g.name.indexOf(":");
  return colon < 0 ? g.name : g.name.slice(0, colon);
}
var RecordFormatError = class extends TypeError {
  constructor(what) {
    super(`hold record: ${what}`);
    this.name = "RecordFormatError";
  }
};
function check(ok, what) {
  if (!ok) throw new RecordFormatError(what);
}
function isObj3(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function exactKeys(v, want, what) {
  check(isObj3(v), `${what} is not an object`);
  const o = v;
  const have = Object.keys(o).sort();
  const w = [...want].sort();
  check(have.length === w.length && have.every((k, i) => k === w[i]), `${what} has keys [${have.join(", ")}]`);
  return o;
}
var int = (v, min) => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
var CONTROL = /[\x00-\x1f\x7f]/;
var KINDS = /* @__PURE__ */ new Set(["PATCH", "PIN", "INCOMING"]);
var STATES = /* @__PURE__ */ new Set(["ACTIVE", "CONFLICTED", "PARKED", "SUBSUMED", "GONE", "RESOLVED_PUBLISH", "RESOLVED_DISCARD"]);
var OFFERS = /* @__PURE__ */ new Set(["none", "pending_leftover", "offered", "accepted", "returned"]);
var RESIDENCE_STATES = {
  ON_DISK: /* @__PURE__ */ new Set(["ACTIVE", "CONFLICTED"]),
  OFF_DISK: /* @__PURE__ */ new Set(["PARKED", "CONFLICTED"])
};
var RECORD_KEYS = [
  "id",
  "rev",
  "owner",
  "kind",
  "residence",
  "state",
  "offer",
  "declines",
  "displaced_by",
  "paths",
  "blobs",
  "guards",
  "origin",
  "cs_ids",
  "peer_authors",
  "local_only",
  "age_anchor",
  "proto"
];
var MAX_TEXT = 256;
function text(v, what) {
  check(typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT && !CONTROL.test(v), `${what} must be a non-empty string without control characters`);
  return v;
}
function checkBlobMap(v, paths, what, mayOmit) {
  check(isObj3(v), `${what} is not an object`);
  const m = v;
  const want = new Set(paths);
  for (const [p, o] of Object.entries(m)) {
    check(want.has(p), `${what} names ${JSON.stringify(p)}, which is not a path of the record`);
    check(o === ABSENT || isOid(o), `${what}[${JSON.stringify(p)}] must be an object id or ABSENT`);
  }
  if (!mayOmit) check(Object.keys(m).length === paths.length, `${what} does not name every path of the record`);
}
function checkRecord(v) {
  const o = exactKeys(v, RECORD_KEYS, "record");
  check(typeof o["id"] === "string" && validId("ulid", o["id"]), "id must be a ULID");
  check(int(o["rev"], 1), "rev must be a safe integer >= 1");
  check(typeof o["owner"] === "string" && validId("hex128", o["owner"]), "owner must be a peer id");
  check(typeof o["kind"] === "string" && KINDS.has(o["kind"]), "kind must be PATCH, PIN or INCOMING");
  check(typeof o["state"] === "string" && STATES.has(o["state"]), "unknown state");
  const state = o["state"];
  const residence = o["residence"];
  if (TERMINAL_STATES.has(state)) {
    check(residence === null, `a terminal record (${state}) has no residence`);
  } else {
    check(residence === "ON_DISK" || residence === "OFF_DISK", `a ${state} record needs residence ON_DISK or OFF_DISK`);
    check(RESIDENCE_STATES[residence].has(state), `${String(residence)} ${state} is not a residence × state of Table 1`);
    check(o["kind"] !== "INCOMING" || residence === "ON_DISK" && state === "ACTIVE", "an INCOMING record is ON_DISK ACTIVE or terminal");
  }
  check(typeof o["offer"] === "string" && OFFERS.has(o["offer"]), "unknown offer");
  check(int(o["declines"], 0), "declines must be a safe integer >= 0");
  check(o["displaced_by"] === null || typeof o["displaced_by"] === "string" && validId("op", o["displaced_by"]), "displaced_by must be an op id or null");
  check(Array.isArray(o["guards"]), "guards is not an array");
  const guards = o["guards"];
  for (const g of guards) {
    const go = exactKeys(g, ["name", "class", "owner"], "guard");
    text(go["name"], "guard name");
    check(go["class"] === "PREDICATE" || go["class"] === "DECISION", "guard class must be PREDICATE or DECISION");
    text(go["owner"], "guard owner");
  }
  const filterFailure = guards.some((g) => guardName(g) === "filter-failure");
  const blobs = o["blobs"];
  check(isObj3(blobs), "blobs is not an object");
  check(Array.isArray(o["paths"]), "paths is not an array");
  const paths = o["paths"];
  const pathlessHostReject = o["kind"] === "PIN" && "h0" in blobs && guards.some((g) => guardName(g) === "host-reject");
  check(paths.length > 0 || pathlessHostReject, "paths is empty");
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    check(typeof p === "string" && validPathSyntax(p), `paths[${i}] is not a valid path`);
    check(i === 0 || paths[i - 1] < p, "paths must be sorted and unique");
  }
  const ps = paths;
  if ("h0" in blobs) {
    const b = exactKeys(blobs, ["h0", "h1"], "blobs");
    checkBlobMap(b["h0"], ps, "blobs.h0", false);
    checkBlobMap(b["h1"], ps, "blobs.h1", filterFailure);
  } else {
    const b = exactKeys(blobs, ["s1", "s2", "s3"], "blobs");
    for (const s of ["s1", "s2", "s3"]) checkBlobMap(b[s], ps, `blobs.${s}`, false);
  }
  text(o["origin"], "origin");
  check(Array.isArray(o["cs_ids"]) && o["cs_ids"].every((x) => typeof x === "string" && validId("cs", x)), "cs_ids must be change-set ids");
  check(Array.isArray(o["peer_authors"]) && o["peer_authors"].every((x) => typeof x === "string" && validId("hex128", x)), "peer_authors must be peer ids");
  check(typeof o["local_only"] === "boolean", "local_only must be a boolean");
  const a = exactKeys(o["age_anchor"], ["since_rev", "anchor_wall_ms", "mono_accum_ms"], "age_anchor");
  check(int(a["since_rev"], 1) && a["since_rev"] <= o["rev"], "age_anchor.since_rev must be in 1..rev");
  check(int(a["anchor_wall_ms"], 0) && int(a["mono_accum_ms"], 0), "age_anchor times must be safe integers >= 0");
  check(o["proto"] === 1, "proto must be 1");
  return v;
}
function serializeRecord(r) {
  checkRecord(r);
  return canonicalBytes(r);
}
function parseRecord(buf) {
  let v;
  try {
    v = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new RecordFormatError("not JSON");
  }
  const r = checkRecord(v);
  check(canonicalBytes(v).equals(buf), "not canonical JSON");
  return r;
}

// src/holds/mask.ts
var RANK = { local_only: 0, whole_path_guard: 1, pin: 2, conflicted: 3, patch: 4 };
var PATH_CLASSES = /* @__PURE__ */ new Set(["QUARANTINED", "SAVE_ONLY", "UNMANAGED"]);
function recordReason(r) {
  if (isTerminal(r)) return null;
  if (r.residence === "ON_DISK") {
    if (r.local_only) return "local_only";
    if (r.guards.some((g) => WHOLE_PATH_GUARDS.has(guardName(g)))) return "whole_path_guard";
    if (r.kind === "PIN" && r.guards.length > 0) return "pin";
    if (r.state === "CONFLICTED") return "conflicted";
    if (r.kind === "PATCH" && r.state === "ACTIVE" && r.guards.length > 0) return "patch";
    return null;
  }
  return r.guards.some((g) => guardName(g) === "claim-breach") ? "conflicted" : null;
}
function recordIndex(records) {
  const idx = /* @__PURE__ */ new Map();
  for (const r of records) {
    const reason = recordReason(r);
    if (reason === null) continue;
    for (const p of r.paths) {
      const had = idx.get(p);
      if (had === void 0 || RANK[reason] < RANK[had]) idx.set(p, reason);
    }
  }
  return idx;
}
function maskReason(path, inp) {
  if (PATH_CLASSES.has(inp.scope(path))) return "path_class";
  return recordIndex(inp.records).get(path) ?? null;
}
function maskEntries(X, inp) {
  const idx = recordIndex(inp.records);
  const masked = (p) => PATH_CLASSES.has(inp.scope(p)) || idx.has(p);
  const out = /* @__PURE__ */ new Map();
  for (const [p, e] of X) {
    if (!masked(p)) {
      out.set(p, e);
      continue;
    }
    const a = inp.A.get(p);
    if (a !== void 0) out.set(p, a);
  }
  for (const [p, a] of inp.A) {
    if (!X.has(p) && masked(p)) out.set(p, a);
  }
  return out;
}

// src/ports/crashpoint.ts
var KilledAt = class extends Error {
  point;
  constructor(point) {
    super(`killed at crashpoint ${point}`);
    this.name = "KilledAt";
    this.point = point;
  }
};
var handler = null;
function crashpoint(name) {
  if (handler !== null) handler(name);
}

// src/ports/fs.ts
import { lstatSync, promises as fsp, readFileSync, realpathSync } from "node:fs";
function errnoCode(e) {
  const c = typeof e === "object" && e !== null ? e.code : void 0;
  return typeof c === "string" ? c : void 0;
}
function sameStat(a, b) {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ino === b.ino && a.dev === b.dev && a.mode === b.mode;
}
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

// src/ports/lease.ts
var alwaysLeased = { idleMs: () => 0 };
var LEASE_STOP_SYNC_MS = 12e4;
var LEASE_EXIT_MS = 6e5;

// src/engine/apply.ts
import { join as join8 } from "node:path";

// src/git/merge.ts
var MergeFailedError = class extends Error {
  code;
  constructor(code, detail) {
    super(`git merge-tree failed with exit code ${code}${detail.length > 0 ? `: ${detail.slice(0, 300)}` : ""}`);
    this.name = "MergeFailedError";
    this.code = code;
  }
};
var WRAP_IDENTITY = { name: "cowork", email: "merge@cowork.invalid" };
async function wrap(repo, tree2) {
  return repo.commitTree({ tree: tree2, parents: [], subject: "cowork-merge", trailers: [] }, WRAP_IDENTITY);
}
async function mergeTree(repo, base, ours, theirs) {
  parseOid(base);
  parseOid(ours);
  parseOid(theirs);
  const baseCommit = await wrap(repo, base);
  const oursCommit = await wrap(repo, ours);
  const theirsCommit = await wrap(repo, theirs);
  let stdout;
  let code;
  try {
    const r = await repo.run(
      ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", `--merge-base=${baseCommit}`, oursCommit, theirsCommit],
      { class: "attr", okCodes: [0, 1] }
    );
    stdout = r.stdout;
    code = r.code;
  } catch (e) {
    if (e instanceof GitCommandError) throw new MergeFailedError(e.code, e.stderrText);
    throw e;
  }
  const tokens = stdout.toString("utf8").split("\0");
  const tree2 = parseOid(tokens[0] ?? "");
  const conflicted = /* @__PURE__ */ new Set();
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length === 0) break;
    conflicted.add(t);
  }
  return { rc: code === 0 ? 0 : 1, tree: tree2, conflicted: [...conflicted].sort() };
}
var emptyBlobs = /* @__PURE__ */ new WeakMap();
function emptyBlob(repo) {
  let p = emptyBlobs.get(repo);
  if (p === void 0) {
    p = repo.hashBytes(Buffer.alloc(0), true);
    emptyBlobs.set(repo, p);
    p.catch(() => emptyBlobs.delete(repo));
  }
  return p;
}
async function mergeFile(repo, current, base, other, opts = {}) {
  const sides = [];
  for (const s of [current, base, other]) sides.push(s === ABSENT ? await emptyBlob(repo) : parseOid(s));
  const args = ["merge-file", "-p", "--object-id"];
  if (opts.diff3 === true) args.push("--diff3");
  if (opts.markerSize !== void 0) {
    if (!Number.isInteger(opts.markerSize) || opts.markerSize < 1) throw new RangeError(`invalid marker size ${String(opts.markerSize)}`);
    args.push(`--marker-size=${opts.markerSize}`);
  }
  if (opts.labels !== void 0) {
    for (const l of opts.labels) {
      if (/[\0\r\n]/.test(l)) throw new Error("invalid merge-file label");
      args.push("-L", l);
    }
  }
  args.push(...sides);
  const r = await repo.run(args, { okCodes: Array.from({ length: 256 }, (_, i) => i).concat(-1) });
  const rc = r.code >= 0 && r.code <= 127 ? r.code : -1;
  return { rc, out: r.stdout };
}

// src/data/blobRoutes.ts
function isFilterFailure(x) {
  if (typeof x !== "object" || x === null) return false;
  const r = x;
  return r.failed === "filter" && typeof r.path === "string";
}
function checkPath(path) {
  if (path.length === 0 || path.startsWith("/") || path.endsWith("/") || /[\0\r\n\\]/.test(path)) {
    throw new Error(`invalid repository path ${JSON.stringify(path)}`);
  }
}
async function hashPath(repo, path, stageFile, write2, extra) {
  checkPath(path);
  if (stageFile.length === 0 || /[\0\r\n]/.test(stageFile)) throw new Error(`invalid stage file ${JSON.stringify(stageFile)}`);
  const args = ["hash-object", ...write2 ? ["-w"] : [], `--path=${path}`, "--", stageFile];
  const r = await repo.run(args, { class: "attr", ...extra, okCodes: [0, 128] });
  if (r.code === 128) return { failed: "filter", path };
  try {
    return parseOid(r.stdout.toString("utf8"));
  } catch {
    throw new OidError(`git hash-object printed no object id (exit ${r.code})`);
  }
}
function hashRouteB(repo, path, stageFile, write2) {
  return hashPath(repo, path, stageFile, write2, {});
}
function hashRouteC(repo, bytes, write2) {
  return repo.hashBytes(bytes, write2);
}
function hashNewPath(repo, path, stageFile, write2) {
  return hashPath(repo, path, stageFile, write2, { config: { "core.autocrlf": "input" } });
}

// src/data/rows.ts
var BOM = Buffer.from([239, 187, 191]);
var LF = 10;
var CR = 13;
var BINARY_SNIFF_BYTES = 8e3;
function rows(blob2) {
  const out = [];
  let start = 0;
  for (; ; ) {
    const nl = blob2.indexOf(LF, start);
    if (nl < 0) break;
    out.push(blob2.subarray(start, nl + 1));
    start = nl + 1;
  }
  if (start < blob2.length) out.push(blob2.subarray(start));
  return out;
}
function hasBom(blob2) {
  return blob2.length >= 3 && blob2[0] === 239 && blob2[1] === 187 && blob2[2] === 191;
}
function form(blob2) {
  let crlf = 0;
  let lf = 0;
  for (let i = blob2.indexOf(LF); i >= 0; i = blob2.indexOf(LF, i + 1)) {
    if (i > 0 && blob2[i - 1] === CR) crlf++;
    else lf++;
  }
  const eol = crlf === 0 && lf === 0 ? "NONE" : crlf > 0 && lf > 0 ? "MIXED" : crlf > 0 ? "CRLF" : "LF";
  return { bom: hasBom(blob2), eol };
}
function isBinaryBytes(blob2) {
  return blob2.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}
function stripEnding(row) {
  const n = row.length;
  if (n > 0 && row[n - 1] === LF) return row.subarray(0, n >= 2 && row[n - 2] === CR ? n - 2 : n - 1);
  return row;
}
function markerForm(row, first) {
  let r = first && hasBom(row) ? row.subarray(3) : row;
  if (r.length > 0 && r[r.length - 1] === LF) r = r.subarray(0, r.length - 1);
  if (r.length > 0 && r[r.length - 1] === CR) r = r.subarray(0, r.length - 1);
  return r.toString("latin1");
}
var CONFLICT_MARKER = /^(?:<{7} |={7}$|>{7} |\|{7} )/;
function conflictMarkerRows(blob2) {
  const out = /* @__PURE__ */ new Set();
  let first = true;
  for (const row of rows(blob2)) {
    const s = markerForm(row, first);
    first = false;
    if (CONFLICT_MARKER.test(s)) out.add(s);
  }
  return out;
}

// src/data/linediff.ts
function matchedRows(a, b) {
  const ids = /* @__PURE__ */ new Map();
  const intern = (row) => {
    const key = stripEnding(row).toString("latin1");
    let id = ids.get(key);
    if (id === void 0) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  };
  const A = Int32Array.from(a, intern);
  const B = Int32Array.from(b, intern);
  const out = [];
  diffRange(A, B, 0, A.length, 0, B.length, out);
  return out;
}
function diffRange(A, B, aLo, aHi, bLo, bHi, out) {
  while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) {
    out.push([aLo, bLo]);
    aLo++;
    bLo++;
  }
  let sa = aHi;
  let sb = bHi;
  while (sa > aLo && sb > bLo && A[sa - 1] === B[sb - 1]) {
    sa--;
    sb--;
  }
  if (aLo < sa && bLo < sb) {
    const split = bisect(A, B, aLo, sa, bLo, sb);
    if (split !== null) {
      const [x, y] = split;
      if (x === aLo && y === bLo || x === sa && y === sb) throw new Error("matchedRows: degenerate split");
      diffRange(A, B, aLo, x, bLo, y, out);
      diffRange(A, B, x, sa, y, sb, out);
    }
  }
  for (let k = 0; k < aHi - sa; k++) out.push([sa + k, sb + k]);
}
function bisect(A, B, aLo, aHi, bLo, bHi) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD;
  const len = 2 * maxD;
  const v1 = new Int32Array(len).fill(-1);
  const v2 = new Int32Array(len).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = off + k1;
      let x1 = k1 === -d || k1 !== d && v1[k1o - 1] < v1[k1o + 1] ? v1[k1o + 1] : v1[k1o - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && A[aLo + x1] === B[bLo + y1]) {
        x1++;
        y1++;
      }
      v1[k1o] = x1;
      if (x1 > n) {
        k1end += 2;
      } else if (y1 > m) {
        k1start += 2;
      } else if (front) {
        const k2o = off + delta - k1;
        if (k2o >= 0 && k2o < len && v2[k2o] !== -1) {
          if (x1 >= n - v2[k2o]) return [aLo + x1, bLo + y1];
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = off + k2;
      let x2 = k2 === -d || k2 !== d && v2[k2o - 1] < v2[k2o + 1] ? v2[k2o + 1] : v2[k2o - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && A[aLo + n - x2 - 1] === B[bLo + m - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2o] = x2;
      if (x2 > n) {
        k2end += 2;
      } else if (y2 > m) {
        k2start += 2;
      } else if (!front) {
        const k1o = off + delta - k2;
        if (k1o >= 0 && k1o < len && v1[k1o] !== -1) {
          const x1 = v1[k1o];
          const y1 = x1 - (k1o - off);
          if (x1 >= n - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }
  return null;
}

// src/data/canon.ts
var LF2 = 10;
var CR2 = 13;
function refuse() {
  return { ok: false, refuse: "eol-bom" };
}
function canon(next, ref, skip) {
  if (ref === null || skip || isBinaryBytes(ref) || isBinaryBytes(next)) return { ok: true, out: next };
  const refForm = form(ref);
  let body = next;
  if (refForm.bom && !hasBom(next)) body = Buffer.concat([BOM, next]);
  else if (!refForm.bom && hasBom(next)) body = next.subarray(3);
  let out;
  switch (refForm.eol) {
    case "LF":
      out = toLf(body);
      break;
    case "CRLF":
      out = toCrlf(body);
      break;
    case "NONE":
      out = body;
      break;
    case "MIXED":
      if (!matchedEndingsKept(ref, body)) return refuse();
      out = body;
      break;
  }
  if (!sameRowContents(next, out)) return refuse();
  return { ok: true, out };
}
function toLf(x) {
  let pairs = 0;
  for (let i = x.indexOf(LF2); i >= 0; i = x.indexOf(LF2, i + 1)) if (i > 0 && x[i - 1] === CR2) pairs++;
  if (pairs === 0) return x;
  const out = Buffer.allocUnsafe(x.length - pairs);
  let o = 0;
  let start = 0;
  for (let i = x.indexOf(LF2); i >= 0; i = x.indexOf(LF2, i + 1)) {
    if (i > 0 && x[i - 1] === CR2) {
      o += x.copy(out, o, start, i - 1);
      out[o++] = LF2;
      start = i + 1;
    }
  }
  x.copy(out, o, start);
  return out;
}
function toCrlf(x) {
  let bare2 = 0;
  for (let i = x.indexOf(LF2); i >= 0; i = x.indexOf(LF2, i + 1)) if (i === 0 || x[i - 1] !== CR2) bare2++;
  if (bare2 === 0) return x;
  const out = Buffer.allocUnsafe(x.length + bare2);
  let o = 0;
  let start = 0;
  for (let i = x.indexOf(LF2); i >= 0; i = x.indexOf(LF2, i + 1)) {
    if (i === 0 || x[i - 1] !== CR2) {
      o += x.copy(out, o, start, i);
      out[o++] = CR2;
      out[o++] = LF2;
      start = i + 1;
    }
  }
  x.copy(out, o, start);
  return out;
}
function endingOf(row) {
  const n = row.length;
  if (n === 0 || row[n - 1] !== LF2) return "";
  return n >= 2 && row[n - 2] === CR2 ? "CRLF" : "LF";
}
function matchedEndingsKept(ref, body) {
  const ra = rows(ref);
  const rb = rows(body);
  for (const [i, j] of matchedRows(ra, rb)) {
    const ea = endingOf(ra[i]);
    const eb = endingOf(rb[j]);
    if (ea !== eb && ea !== "" && eb !== "") return false;
  }
  return true;
}
function sameRowContents(x, y) {
  const rx = rows(hasBom(x) ? x.subarray(3) : x);
  const ry = rows(hasBom(y) ? y.subarray(3) : y);
  if (rx.length !== ry.length) return false;
  for (let i = 0; i < rx.length; i++) {
    if (!stripEnding(rx[i]).equals(stripEnding(ry[i]))) return false;
  }
  return true;
}

// src/data/conflict.ts
var LF3 = 10;
var CR3 = 13;
var MIN_MARKER_SIZE = 32;
var MARKER_CHARS = /* @__PURE__ */ new Set([60, 124, 61, 62]);
var SEPARATOR_NEED = 0;
function concatMarkerSize(stages) {
  let longest = 0;
  for (const s of stages) {
    let first = true;
    for (const row of rows(s)) {
      const r = first && hasBom(row) ? row.subarray(3) : row;
      first = false;
      const c = r[0];
      if (c === void 0 || !MARKER_CHARS.has(c)) continue;
      let n = 1;
      while (n < r.length && r[n] === c) n++;
      if (n > longest) longest = n;
    }
  }
  return Math.max(MIN_MARKER_SIZE, longest + 1);
}
async function conflict(ctx, path, s1, s2, s3, unit) {
  if (ctx.localOnly(path)) return { kind: "DEFER", reason: "local_only_conflict" };
  const takeTip = () => ({ kind: "TAKE_TIP", entry: s3, stages: { s1, s2, s3 } });
  if (unit !== "content" || s1 === ABSENT || s2 === ABSENT || s3 === ABSENT || !ctx.isText(path)) return takeTip();
  const [base, local, tip] = await ctx.repo.readBlobs([s1, s2, s3]);
  if (isBinaryBytes(base) || isBinaryBytes(local) || isBinaryBytes(tip)) return takeTip();
  const m = concatMarkerSize([base, local, tip]);
  const merged = await mergeFile(ctx.repo, s3, s1, s2, { diff3: true, markerSize: m });
  if (merged.rc <= 0) return takeTip();
  const parsed = parseMerge(merged.out, m, local, tip);
  if (parsed === null || parsed.regions.length === 0) return takeTip();
  const stages = [base, local, tip];
  if (parsed.regions.every((r) => r.b.length === 0 && containsRun(keys(r.t, r.atStart), keys(r.l, r.atStart)))) {
    const out = assemble(parsed, (r) => Buffer.concat(r.t));
    if (out.equals(tip)) return { kind: "CONCAT", blob: s3 };
    return await finish(ctx, path, out, stages) ?? takeTip();
  }
  if (ctx.insertionMerge(path) && ctx.concatAllowed && parsed.regions.every(concatQualifies)) {
    const out = assemble(parsed, (r) => concatBlock(r, base));
    const done = await finish(ctx, path, out, stages);
    if (done !== null) return done;
  }
  return takeTip();
}
function bare(row) {
  let r = row;
  if (r.length > 0 && r[r.length - 1] === LF3) r = r.subarray(0, r.length - 1);
  if (r.length > 0 && r[r.length - 1] === CR3) r = r.subarray(0, r.length - 1);
  return r.toString("latin1");
}
function markerKind(row, m) {
  const c = row[0];
  if (c === void 0 || !MARKER_CHARS.has(c)) return null;
  const s = bare(row);
  const labelled = (ch) => {
    const run = ch.repeat(m);
    return s === run || s.startsWith(`${run} `);
  };
  if (labelled("<")) return "open";
  if (labelled("|")) return "base";
  if (s === "=".repeat(m)) return "sep";
  if (labelled(">")) return "close";
  return null;
}
function parseMerge(out, m, local, tip) {
  const pieces = [];
  const regions = [];
  let state = "out";
  let cur = null;
  let before = null;
  for (const row of rows(out)) {
    const kind = markerKind(row, m);
    if (state === "out") {
      if (kind === "open") {
        cur = { t: [], b: [], l: [], atStart: pieces.length === 0, before };
        state = "t";
      } else if (kind !== null) {
        return null;
      } else {
        pieces.push(row);
        before = row;
      }
    } else if (state === "t") {
      if (kind === "base") state = "b";
      else if (kind === null) cur.t.push(row);
      else return null;
    } else if (state === "b") {
      if (kind === "sep") state = "l";
      else if (kind === null) cur.b.push(row);
      else return null;
    } else {
      if (kind === "close") {
        pieces.push(cur);
        regions.push(cur);
        cur = null;
        state = "out";
      } else if (kind === null) {
        cur.l.push(row);
      } else {
        return null;
      }
    }
  }
  if (state !== "out") return null;
  const last = pieces[pieces.length - 1];
  if (last !== void 0 && !Buffer.isBuffer(last)) {
    if (!endsWithLf(tip)) unterminateLast(last.t);
    if (!endsWithLf(local)) unterminateLast(last.l);
  }
  return { pieces, regions };
}
function endsWithLf(b) {
  return b.length > 0 && b[b.length - 1] === LF3;
}
function unterminateLast(block) {
  const i = block.length - 1;
  if (i >= 0) block[i] = stripEnding(block[i]);
}
function keys(block, atStart) {
  return block.map((r, i) => stripEnding(i === 0 && atStart && hasBom(r) ? r.subarray(3) : r).toString("latin1"));
}
function containsRun(hay, needle) {
  if (needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let j = 0;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}
var BLANK = /^[\t\n\v\f\r ]*$/;
function concatQualifies(r) {
  if (r.b.length !== 0 || r.t.length === 0 || r.l.length === 0) return false;
  const inT = new Set(keys(r.t, r.atStart).filter((k) => !BLANK.test(k)));
  return !keys(r.l, r.atStart).some((k) => !BLANK.test(k) && inT.has(k));
}
function endingOf2(row) {
  if (row === null || !endsWithLf(row)) return null;
  return row.length >= 2 && row[row.length - 2] === CR3 ? Buffer.from([CR3, LF3]) : Buffer.from([LF3]);
}
function concatBlock(r, base) {
  const eol = endingOf2(r.before) ?? (form(base).eol === "CRLF" ? Buffer.from([CR3, LF3]) : Buffer.from([LF3]));
  const parts = [...r.t];
  const lastT = r.t[r.t.length - 1];
  if (!endsWithLf(lastT)) parts.push(eol);
  const trailing = countBlank([...r.t].reverse());
  const leading = countBlank(r.l);
  for (let i = Math.max(0, SEPARATOR_NEED - (trailing + leading)); i > 0; i--) parts.push(eol);
  parts.push(...r.l);
  return Buffer.concat(parts);
}
function countBlank(block) {
  let n = 0;
  while (n < block.length && BLANK.test(stripEnding(block[n]).toString("latin1"))) n++;
  return n;
}
function assemble(p, replace) {
  return Buffer.concat(p.pieces.map((x) => Buffer.isBuffer(x) ? x : replace(x)));
}
async function finish(ctx, path, out, stages) {
  const c = canon(out, await ctx.ref(path), false);
  if (!c.ok) return null;
  const result = c.out;
  if (stages.every(isUtf8) && !isUtf8(result)) return null;
  const known = new Set(stages.flatMap((s) => keys(rows(s), true)));
  if (keys(rows(result), true).some((k) => !BLANK.test(k) && !known.has(k))) return null;
  const sides = /* @__PURE__ */ new Set([...conflictMarkerRows(stages[1]), ...conflictMarkerRows(stages[2])]);
  for (const mk of conflictMarkerRows(result)) if (!sides.has(mk)) return null;
  return { kind: "CONCAT", blob: await hashRouteC(ctx.repo, result, ctx.write) };
}
function isUtf8(b) {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

// src/data/scope.ts
var HUGE_BYTES = 52428800;
var QUARANTINE_PATTERNS = Object.freeze([
  ".claude/**",
  ".mcp.json",
  "CLAUDE.md",
  "AGENTS.md",
  ".husky/**",
  ".githooks/**",
  ".gitattributes",
  ".gitmodules",
  ".lfsconfig",
  ".cowork/**",
  ".github/workflows/**",
  ".gitlab-ci.yml",
  "azure-pipelines*.yml",
  "bitbucket-pipelines.yml",
  ".vscode/settings.json",
  ".vscode/tasks.json",
  ".vscode/launch.json",
  ".devcontainer/**",
  ".envrc"
]);
var TEMP_PATTERNS = Object.freeze([
  "*.swp",
  "*.swo",
  "4913",
  "#*#",
  ".#*",
  "*~",
  "*.orig",
  "*___jb_tmp___",
  "*___jb_old___",
  "~$*",
  "~*.tmp",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".vs/**"
]);
var SECRET_LIKE_PATTERNS = Object.freeze([
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "*.keystore",
  "*credentials*",
  "secrets.*",
  "*.kdbx",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "*.tfstate*",
  "appsettings.*.json",
  "local.settings.json"
]);
var globCache = /* @__PURE__ */ new Map();
function compileGlob(glob) {
  const hit = globCache.get(glob);
  if (hit !== void 0) return hit;
  const toks = [];
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      let j = i + 1;
      while (glob.charAt(j) === "*") j++;
      const isStar2 = j - i >= 2;
      const segStart = i === 0 || glob.charAt(i - 1) === "/";
      const segEnd = j >= glob.length || glob.charAt(j) === "/";
      if (isStar2 && segStart && segEnd) {
        if (j >= glob.length) {
          toks.push({ k: "all" });
        } else {
          toks.push({ k: "dirs" });
          j++;
        }
      } else if (toks[toks.length - 1]?.k !== "star") {
        toks.push({ k: "star" });
      }
      i = j - 1;
    } else if (ch === "?") {
      toks.push({ k: "one" });
    } else if (ch === "[") {
      const negated = glob.charAt(i + 1) === "!" || glob.charAt(i + 1) === "^";
      const close = glob.indexOf("]", i + (negated ? 3 : 2));
      if (close < 0) throw new Error(`invalid glob ${JSON.stringify(glob)}: unterminated bracket class`);
      const body = glob.slice(i + (negated ? 2 : 1), close);
      if (body.includes("[:")) throw new Error(`invalid glob ${JSON.stringify(glob)}: POSIX character classes are not supported`);
      const ranges = [];
      for (let k = 0; k < body.length; k++) {
        const lo = body.charCodeAt(k);
        if (body.charAt(k + 1) === "-" && k + 2 < body.length) {
          const hi = body.charCodeAt(k + 2);
          if (hi < lo) throw new Error(`invalid glob ${JSON.stringify(glob)}: range out of order`);
          ranges.push([lo, hi]);
          k += 2;
        } else {
          ranges.push([lo, lo]);
        }
      }
      toks.push({ k: "cls", neg: negated, ranges });
      i = close;
    } else if (ch === "\\" && i + 1 < glob.length) {
      i++;
      toks.push({ k: "lit", c: glob.charAt(i) });
    } else {
      toks.push({ k: "lit", c: ch });
    }
  }
  globCache.set(glob, toks);
  return toks;
}
function litEq(c, want, ci) {
  return c === want || ci && (c.toLowerCase() === want.toLowerCase() || c.toUpperCase() === want.toUpperCase());
}
function inClass(t, c, ci) {
  const hit = (x) => {
    if (x.length !== 1) return false;
    const u = x.charCodeAt(0);
    return t.ranges.some(([lo, hi]) => u >= lo && u <= hi);
  };
  const found = hit(c) || ci && (hit(c.toLowerCase()) || hit(c.toUpperCase()));
  return found !== t.neg;
}
function globMatch(toks, s, ci) {
  const m = toks.length;
  let cur = new Uint8Array(m + 1);
  let next = new Uint8Array(m + 1);
  const close = (set) => {
    let any = false;
    for (let i = 0; i <= m; i++) {
      if (set[i] === 0) continue;
      any = true;
      const t = toks[i];
      if (t !== void 0 && (t.k === "star" || t.k === "all" || t.k === "dirs")) set[i + 1] = 1;
    }
    return any;
  };
  cur[0] = 1;
  close(cur);
  for (let x = 0; x < s.length; x++) {
    const c = s.charAt(x);
    next.fill(0);
    for (let i = 0; i < m; i++) {
      if (cur[i] === 0) continue;
      const t = toks[i];
      switch (t.k) {
        case "lit":
          if (litEq(c, t.c, ci)) next[i + 1] = 1;
          break;
        case "one":
          if (c !== "/") next[i + 1] = 1;
          break;
        case "cls":
          if (c !== "/" && inClass(t, c, ci)) next[i + 1] = 1;
          break;
        case "star":
          if (c !== "/") next[i] = 1;
          break;
        case "all":
          next[i] = 1;
          break;
        case "dirs":
          next[i] = 1;
          if (c === "/") next[i + 1] = 1;
          break;
      }
    }
    if (!close(next)) return false;
    [cur, next] = [next, cur];
  }
  return cur[m] === 1;
}
function validGlob(pattern) {
  const glob = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  const body = glob.startsWith("/") ? glob.slice(1) : glob;
  if (body.length === 0) return true;
  try {
    compileGlob(body);
    return true;
  } catch {
    return false;
  }
}
function matchOne(pattern, path, caseInsensitive) {
  const anchored = pattern.includes("/");
  const glob = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  if (glob.length === 0) return false;
  const subject = anchored ? path : path.slice(path.lastIndexOf("/") + 1);
  return globMatch(compileGlob(glob), subject, caseInsensitive);
}
function wildmatch(pattern, path, caseInsensitive = false) {
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1);
    let slash = path.indexOf("/");
    while (slash >= 0) {
      if (matchOne(dir, path.slice(0, slash), caseInsensitive)) return true;
      slash = path.indexOf("/", slash + 1);
    }
    return false;
  }
  return matchOne(pattern, path, caseInsensitive);
}
function matchesAny(patterns, path, caseInsensitive = false) {
  return patterns.some((p) => wildmatch(p, path, caseInsensitive));
}
function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}
function isTemp(path) {
  return TEMP_PATTERNS.some((p) => wildmatch(p, path, true) || p.includes("/") && wildmatch(`**/${p}`, path, true));
}
function isSecretLike(path) {
  return matchesAny(SECRET_LIKE_PATTERNS, path, true);
}
function isQuarantined(path, hooksPathDir) {
  if (matchesAny(QUARANTINE_PATTERNS, path, true)) return true;
  if (hooksPathDir !== null && hooksPathDir.length > 0) {
    const dir = hooksPathDir.replace(/\/+$/, "").toLowerCase();
    const lower = path.toLowerCase();
    if (dir.length > 0 && (lower === dir || lower.startsWith(`${dir}/`))) return true;
  }
  return false;
}
var FORBIDDEN_CHARS = /[<>:"|?*\\\u0000-\u001f]/;
var RESERVED = /* @__PURE__ */ new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].flatMap((d) => [`COM${d}`, `LPT${d}`])
]);
var HFS_IGNORABLE = /[\u{200c}-\u{200f}\u{202a}-\u{202e}\u{206a}-\u{206f}\u{feff}]/gu;
function isDotGitAlias(component) {
  if (component.includes(":")) return true;
  const k = component.replace(HFS_IGNORABLE, "").toUpperCase().toLowerCase().replace(/[. ]+$/, "");
  return k === ".git" || /^git~[0-9]+$/.test(k);
}
function componentOk(c) {
  if (c.length === 0 || c === "." || c === "..") return false;
  if (isDotGitAlias(c)) return false;
  if (FORBIDDEN_CHARS.test(c)) return false;
  if (c.endsWith(".") || c.endsWith(" ")) return false;
  const dot = c.indexOf(".");
  const stem = (dot < 0 ? c : c.slice(0, dot)).replace(/ +$/, "").toUpperCase();
  if (RESERVED.has(stem)) return false;
  return Buffer.byteLength(c, "utf8") <= 255;
}
var collisionKey = (x) => x.normalize("NFC").toUpperCase().toLowerCase();
function nameAndPrefixes(path) {
  const out = [];
  let slash = path.indexOf("/");
  while (slash >= 0) {
    out.push(path.slice(0, slash));
    slash = path.indexOf("/", slash + 1);
  }
  out.push(path);
  return out;
}
function portable(path, others) {
  if (path !== path.normalize("NFC")) return { ok: false, rule: 1 };
  if (!path.split("/").every(componentOk)) return { ok: false, rule: 2 };
  if (path.length > 200) return { ok: false, rule: 3 };
  const mine = nameAndPrefixes(path);
  const keys3 = /* @__PURE__ */ new Map();
  for (const x of mine) keys3.set(collisionKey(x), x);
  for (const other of others) {
    for (const y of nameAndPrefixes(other)) {
      const mineWithKey = keys3.get(collisionKey(y));
      if (mineWithKey !== void 0 && mineWithKey !== y) return { ok: false, rule: 4 };
    }
  }
  return { ok: true };
}
var LIVE_SCOPE = { cls: "LIVE", reason: null };
var scope = (cls, reason) => ({ cls, reason });
function scopeOfTracked(path, mode, size, inp) {
  if (isQuarantined(path, inp.hooksPathDir)) return scope("QUARANTINED", "quarantine");
  if (!validPathSyntax(path)) return scope("UNMANAGED", "portability");
  if (mode === "160000") return scope("UNMANAGED", "submodule");
  if (mode === "120000") return scope("UNMANAGED", "symlink");
  const a = inp.attrs.get(path);
  if (a.filter === "lfs") return scope("UNMANAGED", "lfs");
  if (a.generated || a.coworkOff) return scope("UNMANAGED", "generated");
  if (matchesAny(inp.config.sync.exclude, path)) return scope("UNMANAGED", "excluded-by-config");
  if (basename(path) === ".gitignore") return scope("SAVE_ONLY", "save-only");
  if (a.merge !== null && inp.mergeDrivers.has(a.merge)) return scope("SAVE_ONLY", "merge-driver");
  if (size >= HUGE_BYTES) return scope("SAVE_ONLY", "huge");
  if (inp.localOnlyPaths.has(path)) return scope("LOCAL_ONLY", "secret-like");
  return LIVE_SCOPE;
}
function admitNew(entry, lstatSize, isSymlink, others, inp) {
  const no = (reason) => scope("NOT_ADMITTED", reason);
  if (entry.endsWith("/") || entry.startsWith(".claude/worktrees/")) return no("nested-repo");
  if (isTemp(entry)) return no("temp");
  if (isSecretLike(entry) && !inp.config.sync.allowSecretLike.includes(entry)) return no("secret-like");
  if (isSymlink || isQuarantined(entry, inp.hooksPathDir)) return no("quarantine");
  const a = inp.attrs.get(entry);
  if (a.filter === "lfs") return no("lfs");
  if (a.generated || a.coworkOff) return no("generated");
  if (matchesAny(inp.config.sync.exclude, entry)) return no("excluded-by-config");
  if (inp.config.sync.include.length > 0 && !matchesAny(inp.config.sync.include, entry)) return no("not-included");
  if (basename(entry) === ".gitignore") return no("save-only");
  if (a.merge !== null && inp.mergeDrivers.has(a.merge)) return no("merge-driver");
  if (!portable(entry, others).ok) return no("portability");
  if (lstatSize > inp.config.sync.maxNewFileBytes) return no("too-large");
  return LIVE_SCOPE;
}

// src/holds/groups.ts
function writeGroups(incoming2, applicable, deferred) {
  const universe = /* @__PURE__ */ new Set([...applicable, ...deferred.keys()]);
  const parent = /* @__PURE__ */ new Map();
  for (const p of universe) parent.set(p, p);
  const find = (p) => {
    let root = p;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = p;
    while (cur !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const cs of incoming2) {
    let first = null;
    for (const p of cs.paths) {
      if (!universe.has(p)) continue;
      if (first === null) first = p;
      else union(first, p);
    }
  }
  const components = /* @__PURE__ */ new Map();
  for (const p of universe) {
    const root = find(p);
    const members2 = components.get(root);
    if (members2 === void 0) components.set(root, [p]);
    else members2.push(p);
  }
  const ordered = [...components.values()].map((g) => g.sort()).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const result = { groups: [], deferred: [] };
  for (const group of ordered) {
    if (!group.some((p) => deferred.has(p))) {
      result.groups.push(group);
      continue;
    }
    const byReason = /* @__PURE__ */ new Map();
    for (const p of group) {
      const reason = deferred.get(p) ?? "closure";
      const paths = byReason.get(reason);
      if (paths === void 0) byReason.set(reason, [p]);
      else paths.push(p);
    }
    for (const [reason, paths] of byReason) result.deferred.push({ paths, reason });
  }
  return result;
}

// src/engine/core.ts
import { join as join7, isAbsolute, relative, sep } from "node:path";

// src/board/governor.ts
var NORMAL_LOCAL = Object.freeze({ B: 24, G_ms: 2500, S_ms: 750 });
var FALLBACK_LOCAL = Object.freeze({ B: 6, G_ms: 1e4, S_ms: 3e3 });
var FALLBACK_MS = 18e5;
var EVENT_SPACING_MS = 9e5;
var G_CAP_MS = 6e4;
var WINDOW_MS = 6e4;
var SLOW_PUSH_MS = 1e4;
var RESTART_EVENT_HEIGHTS = 180;
var NET_BACKOFF_MIN_MS = 3e4;
var NET_BACKOFF_MAX_MS = 3e5;
var SIGNALS = /* @__PURE__ */ new Set(["http_429", "http_5xx", "slow_push", "rejection_streak"]);
var PARAM_FALLBACK = { budget: 6, G_s: 10, S_s: 3 };
var positive2 = (v, fallback) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
function sanitize(p) {
  return { budget: positive2(p?.budget, PARAM_FALLBACK.budget), G_s: positive2(p?.G_s, PARAM_FALLBACK.G_s), S_s: positive2(p?.S_s, PARAM_FALLBACK.S_s) };
}
var toMs = (s) => Math.ceil(Math.round(s * 1e6) / 1e3);
var Governor = class {
  clock;
  params;
  /** The observed board tip; undefined until the first observation of this run. */
  anchorTip = void 0;
  /** anchorTip when the own last attempt started (its lease as this governor saw it); undefined before any attempt. */
  tipAtAttemptStart = void 0;
  /** When anchorTip was observed (fetch completion) or the own ok was received. */
  anchor = null;
  landings = [];
  attempts = [];
  lastAttempt = null;
  inFlight = false;
  /** PRO-44 throttle level. */
  k = 0;
  /** Tip changes by others while allowed work was pending, since the own last attempt or since pending became true. */
  preempted = 0;
  /** The tip of the latest counted pre-emption, so an own commit first seen by a fetch can be taken back. */
  preemptTip = void 0;
  /** Allowed pending work as of the last onFetch / mayAttempt. */
  pending = false;
  /** Consecutive transient rejections paced by the ENG-44 backoff, and when the last one ended. */
  backoffLevel = 0;
  backoffFrom = null;
  /** The own last throttle signal (onSignal or restore); kept after its 30 min to name an own folded event's cause. */
  lastSignal = null;
  /** The last fold of a HOST_THROTTLED event written by this peer, and by a teammate. */
  lastFoldedOwn = null;
  lastFoldedTeam = null;
  /** The last HOST_THROTTLED event this daemon queued, or folded from any writer (the 15-min spacing, P2-R18). */
  lastEvent = null;
  constructor(clock, params) {
    this.clock = clock;
    this.params = sanitize(params);
  }
  /** The tip's protocol.json; a missing or malformed field reads as budget 6 / G_s 10 / S_s 3 (stricter). */
  setParams(params) {
    this.params = sanitize(params);
  }
  /**
   * A fetch completed with board tip T: anchor := now when T changed; `revealed` new first-parent commits are
   * observed landings unless firstOfRun (history, 02-protocol §2); a tip change by another writer while
   * `pending` counts one pre-emption (not on the first observation of the run).
   */
  onFetch(tip, revealed, firstOfRun, pending) {
    if (!Number.isSafeInteger(revealed) || revealed < 0) throw new RangeError(`governor: revealed must be a count, got ${String(revealed)}`);
    this.notePending(pending);
    const now = anchorNow(this.clock);
    if (!firstOfRun && revealed > 0) this.landings.push({ at: now, n: revealed });
    if (tip !== this.anchorTip) {
      const seenBefore = this.anchorTip !== void 0;
      this.anchorTip = tip;
      this.anchor = now;
      if (seenBefore && !firstOfRun && pending && tip !== null) {
        this.preempted += 1;
        this.preemptTip = tip;
      }
    }
    this.prune();
  }
  /**
   * The own push landed (board ok, or an ambiguous push resolved as landed; also the restart's push-intent
   * resolution). Three cases, by what this governor has observed:
   * - the tip is still the one seen when the attempt started (a direct ok, no fetch since): anchor_tip :=
   *   Bnew, anchor := now and one observed landing;
   * - a fetch already revealed Bnew as the tip: that fetch counted the landing; anchor := now (the ok's
   *   receipt) and a pre-emption it counted for Bnew is taken back (it was this peer's own commit);
   * - a fetch already revealed a newer tip above Bnew: nothing — that fetch counted Bnew among `revealed`
   *   and its one tip change; moving anchor_tip back to Bnew would make the next fetch of the same tip a
   *   second tip change (a second pre-emption, a second anchor move) and count Bnew twice.
   */
  onOwnOk(bnew) {
    if (this.anchorTip === bnew) {
      if (this.preemptTip === bnew && this.preempted > 0) this.preempted -= 1;
      this.preemptTip = void 0;
      this.anchor = anchorNow(this.clock);
    } else if (this.anchorTip === this.tipAtAttemptStart) {
      const now = anchorNow(this.clock);
      this.anchorTip = bnew;
      this.landings.push({ at: now, n: 1 });
      this.anchor = now;
    }
    this.prune();
  }
  /** One attempt starts: counted for the cap (PRO-41), the own spacing runs from here, the pre-emption count restarts. */
  onAttemptStart() {
    if (this.inFlight) throw new Error("governor: an attempt is already in flight");
    const now = anchorNow(this.clock);
    this.attempts.push(now);
    this.lastAttempt = now;
    this.inFlight = true;
    this.tipAtAttemptStart = this.anchorTip;
    this.preempted = 0;
    this.preemptTip = void 0;
    this.prune();
  }
  /**
   * PRO-44: an attempt that took > 10 s, was killed, returned no per-ref status or was a transient rejection
   * raises k by one (until G_eff reaches 60 s); any other lowers it by one. A transient rejection, or a
   * failure without a per-ref status line (hadRefStatus false and not landed: a transport failure or a
   * watchdog kill), arms one backoff of 30 s doubling to 5 min (ENG-44 / R-20 for transients, ENG-19's
   * network backoff for the others, ruling P2-NETBACKOFF); a landing or a lease loss (a per-ref status, not
   * transient) resets it, as PRO-54 resets the streak. The attempt is no longer in flight as soon as this is
   * called, also when the input is refused (TypeError / RangeError, nothing else changes): a refused end
   * never wedges the governor.
   */
  onAttemptEnd(e) {
    if (!this.inFlight) throw new Error("governor: no attempt in flight");
    this.inFlight = false;
    if (typeof e !== "object" || e === null) throw new TypeError("governor: onAttemptEnd needs an AttemptEnd");
    if (typeof e.durationMs !== "number" || !(e.durationMs >= 0)) throw new RangeError(`governor: durationMs must be >= 0, got ${String(e.durationMs)}`);
    if (e.durationMs > SLOW_PUSH_MS || e.killed || !e.hadRefStatus || e.transient) {
      if (this.effective().Gbase_ms * 2 ** this.k < G_CAP_MS) this.k += 1;
    } else {
      this.k = Math.max(0, this.k - 1);
    }
    if (e.transient || !e.hadRefStatus && !e.landed) {
      this.backoffLevel += 1;
      this.backoffFrom = anchorNow(this.clock);
    } else {
      this.backoffLevel = 0;
      this.backoffFrom = null;
    }
  }
  /**
   * A throttle signal (PRO-55): last_signal := now, so the very next decision is in fallback. postEvent when
   * the signal came from a push, or from a fetch with other pending work, and no HOST_THROTTLED event was
   * folded (from any writer, a teammate's included) or queued by this daemon within 15 min (ruling P2-R18,
   * 02-protocol §3.8 "folded, or put in its outbox, by this daemon"). Posting is the caller's: it queues the
   * event and calls onEventQueued.
   */
  onSignal(s, fromPush, otherPending) {
    if (!SIGNALS.has(s)) throw new TypeError(`governor: unknown throttle signal ${JSON.stringify(s)}`);
    this.lastSignal = { at: anchorNow(this.clock), signal: s };
    const spaced = this.ago(this.lastEvent) >= EVENT_SPACING_MS;
    return { postEvent: (fromPush || otherPending) && spaced };
  }
  /**
   * A HOST_THROTTLED health event was folded: fallback for 30 min of this peer's Δmono, and the 15-min
   * event spacing restarts whoever wrote it (P2-R18), so a follower never posts its own on top. `own` (the
   * event's writer is this peer) only decides what fallbackSource reports.
   */
  onThrottleEventFolded(own) {
    const now = anchorNow(this.clock);
    if (own) this.lastFoldedOwn = now;
    else this.lastFoldedTeam = now;
    this.lastEvent = now;
  }
  /** This peer put a HOST_THROTTLED event in its outbox. */
  onEventQueued() {
    this.lastEvent = anchorNow(this.clock);
  }
  mode() {
    return this.fallbackLeftMs() > 0 ? "fallback" : "normal";
  }
  /** PRO-04 stricter-of: B_eff = min(B_local, budget), G_base = max(G_local, G_s, 60 s / B_eff), S_eff = max(S_local, S_s), G_eff = min(60 s, G_base · 2^k). */
  effective() {
    const local = this.mode() === "normal" ? NORMAL_LOCAL : FALLBACK_LOCAL;
    const B = Math.min(local.B, this.params.budget);
    const S_ms = Math.max(local.S_ms, toMs(this.params.S_s));
    const Gbase_ms = Math.max(local.G_ms, toMs(this.params.G_s), Math.ceil(WINDOW_MS / B));
    const G_ms = Math.min(G_CAP_MS, Gbase_ms * 2 ** this.k);
    return { B, Gbase_ms, S_ms, G_ms, k: this.k };
  }
  /**
   * PRO-40: allowed pending work, no attempt in flight, fewer than B_eff own attempts and fewer than B_eff
   * observed landings in the last 60 s (the cap and the sliding guard; aging never bypasses either), and —
   * unless exempt — Δ since the anchor ≥ wait(self) (G_eff + (rank − 1)·S_eff, or G_base once aged by two
   * pre-emptions), Δ since the own last attempt ≥ G_eff and the transient backoff over (R-20). There is no
   * window before the first observation of a tip. exempt (R-21: genesis probe and push, human recover)
   * skips the window, the G_eff spacing and the transient backoff, never the cap or the guard. A false
   * pending or stateAllows restarts the pre-emption count ("since pending became true").
   */
  mayAttempt(rank, pending, stateAllows, exempt) {
    checkRank(rank);
    const allowed = pending && stateAllows;
    this.notePending(allowed);
    if (!allowed || this.inFlight) return false;
    return this.waitMs(rank, exempt === true) === 0;
  }
  /** Δmono until mayAttempt(rank, …) could be true with nothing else changing; Infinity when nothing is pending, an attempt is in flight or no tip was observed yet. */
  msUntilWindow(rank) {
    checkRank(rank);
    if (!this.pending || this.inFlight) return Infinity;
    return this.waitMs(rank, false);
  }
  /** Δmono left in fallback (the latest of the own signal's and the folded events' 30 min); 0 in normal mode. */
  fallbackLeftMs() {
    return Math.max(
      0,
      FALLBACK_MS - this.ago(this.lastSignal?.at ?? null),
      FALLBACK_MS - this.ago(this.lastFoldedOwn),
      FALLBACK_MS - this.ago(this.lastFoldedTeam)
    );
  }
  /**
   * Who holds this peer in fallback, own causes first: the own signal while its 30 min hold; else, while a
   * folded event of this peer's own holds, the own signal that led to it (its kind, past its own 30 min);
   * else 'team' while a teammate's folded event holds; else null. An own folded event with no own signal
   * known to this run (a restart whose meta.throttle was null) has no ThrottleSignal to name and is never
   * reported as the team's: null although the mode is fallback (a contract gap: the type has no 'own').
   */
  fallbackSource() {
    if (this.lastSignal !== null && this.ago(this.lastSignal.at) < FALLBACK_MS) return this.lastSignal.signal;
    if (this.lastSignal !== null && this.ago(this.lastFoldedOwn) < FALLBACK_MS) return this.lastSignal.signal;
    if (this.ago(this.lastFoldedTeam) < FALLBACK_MS) return "team";
    return null;
  }
  /** Own attempts started in the last 60 s Δmono. */
  attemptsInWindow() {
    return this.attempts.filter((a) => this.ago(a) < WINDOW_MS).length;
  }
  /** meta.throttle (ENG-05): the own fallback's signal while it holds, without a timestamp; a followed team event is not persisted. */
  toMeta() {
    if (this.lastSignal === null || this.ago(this.lastSignal.at) >= FALLBACK_MS) return null;
    return { signal: this.lastSignal.signal };
  }
  /** Daemon start (R-17): a persisted own fallback restarts for a full 30 min from now; null restores nothing. */
  restore(m) {
    if (m === null) return;
    if (typeof m !== "object" || !SIGNALS.has(m.signal)) throw new TypeError(`governor: meta.throttle ${JSON.stringify(m)} is not a throttle signal`);
    this.lastSignal = { at: anchorNow(this.clock), signal: m.signal };
  }
  ago(a) {
    return a === null ? Infinity : elapsedMono(this.clock, a);
  }
  notePending(p) {
    this.pending = p;
    if (!p) {
      this.preempted = 0;
      this.preemptTip = void 0;
    }
  }
  /** Δmono until every condition of mayAttempt holds (each, once true, stays true while nothing happens). */
  waitMs(rank, exempt) {
    const eff = this.effective();
    let w = Math.max(this.windowWait(this.attempts.map((at) => ({ at, n: 1 })), eff.B), this.windowWait(this.landings, eff.B));
    if (!exempt) {
      if (this.anchor === null) return Infinity;
      const wait = this.preempted >= 2 ? eff.Gbase_ms : eff.G_ms + (rank - 1) * eff.S_ms;
      w = Math.max(w, wait - this.ago(this.anchor));
      if (this.lastAttempt !== null) w = Math.max(w, eff.G_ms - this.ago(this.lastAttempt));
      if (this.backoffLevel > 0 && this.backoffFrom !== null) {
        const backoff = Math.min(NET_BACKOFF_MAX_MS, NET_BACKOFF_MIN_MS * 2 ** (this.backoffLevel - 1));
        w = Math.max(w, backoff - this.ago(this.backoffFrom));
      }
    }
    return Math.max(0, w);
  }
  /** Δmono until fewer than B events (oldest first) remain in the last 60 s; 0 when already so. */
  windowWait(items, B) {
    const live = items.filter((x) => this.ago(x.at) < WINDOW_MS);
    const total = live.reduce((s, x) => s + x.n, 0);
    if (total < B) return 0;
    const mustAge = total - (Math.ceil(B) - 1);
    let aged = 0;
    for (const x of live) {
      aged += x.n;
      if (aged >= mustAge) return WINDOW_MS - this.ago(x.at);
    }
    return Infinity;
  }
  /** Drops attempts and landings older than the 60 s window (they never count again: Δmono only grows). */
  prune() {
    this.attempts = this.attempts.filter((a) => this.ago(a) < WINDOW_MS);
    this.landings = this.landings.filter((x) => this.ago(x.at) < WINDOW_MS);
  }
};
function checkRank(rank) {
  if (!Number.isSafeInteger(rank) || rank < 1) throw new RangeError(`governor: rank must be an integer >= 1, got ${String(rank)}`);
}

// src/board/outbox.ts
var OWN_ID_CID_KINDS = /* @__PURE__ */ new Set(["freeze", "unfreeze", "incident", "nonretryable", "health"]);
var FROZEN_TYPES = /* @__PURE__ */ new Set(["answer", "request_status", "release", "seat_end", "leave", "hold"]);
var FROZEN_EVENT_KINDS = /* @__PURE__ */ new Set(["freeze", "unfreeze", "health"]);
var VERSION_TYPES = /* @__PURE__ */ new Set(["join", "leave", "seat_end", "release", "request_status", "hold"]);
var VERSION_ANSWER_VERBS = /* @__PURE__ */ new Set(["decline", "later", "release"]);
var field = (d, k) => d[k];
function allowedInState(d, state) {
  const type = field(d, "type");
  switch (state) {
    case "ok":
      return true;
    case "frozen":
      if (type === "event") return FROZEN_EVENT_KINDS.has(String(field(d, "kind")));
      return FROZEN_TYPES.has(String(type));
    case "version_board_only":
      if (type === "answer") return VERSION_ANSWER_VERBS.has(String(field(d, "verb")));
      return VERSION_TYPES.has(String(type));
    case "incident":
    case "config_net":
    case "offline":
    case "nonretryable":
    case "version_proto":
      return false;
    default:
      throw new RangeError(`allowedInState: unknown push state ${JSON.stringify(state)}`);
  }
}
var PUSH_STATES = /* @__PURE__ */ new Set(["ok", "frozen", "incident", "config_net", "offline", "nonretryable", "version_proto", "version_board_only"]);
function allowedInAll(d, states) {
  checkStates(states);
  return states.every((s) => allowedInState(d, s));
}
function checkStates(states) {
  if (!Array.isArray(states)) throw new TypeError("outbox: states must be an array of push states");
  for (const s of states) {
    if (!PUSH_STATES.has(s)) throw new RangeError(`outbox: unknown push state ${JSON.stringify(s)}`);
  }
}
function materialize(draft, id) {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) throw new TypeError("outbox: a draft must be an object");
  const o = { ...draft, id };
  if (o["type"] === "event" && OWN_ID_CID_KINDS.has(String(o["kind"]))) o["cid"] = eventCid(id, o["kind"]);
  let op = null;
  try {
    op = parseOpLine(canonicalJson(o));
  } catch {
    op = null;
  }
  if (op === null) throw new TypeError(`outbox: a ${String(o["type"])} draft does not form a valid op line`);
  return op;
}
var lineBytes = (op) => Buffer.byteLength(canonicalJson(op), "utf8") + 1;
var widestId = (self) => formatOpId({ peer: self.peer, epoch: self.epoch, seq: Number.MAX_SAFE_INTEGER });
var PROBE_SELF = { peer: "0".repeat(32), epoch: "0".repeat(32) };
function seqOf(op) {
  const id = parseOpId(op.id);
  if (id === null) throw new TypeError(`outbox: op id ${JSON.stringify(op.id)} is not an op id`);
  return id.seq;
}
function isOwn(op, self) {
  const id = parseOpId(op.id);
  return id !== null && id.peer === self.peer && id.epoch === self.epoch;
}
function capOf(v, cap) {
  if (typeof v !== "number" || Number.isNaN(v)) throw new RangeError(`outbox: room must be a number, got ${String(v)}`);
  return Math.max(0, Math.min(v, cap));
}
var Outbox = class _Outbox {
  /** Allocated entries (op !== null) by increasing seq, then unallocated ones in insertion order. */
  entries;
  /** Takes the entries as persisted (or built by a caller); each is validated like fromJson validates. */
  constructor(entries) {
    this.entries = normalize((entries ?? []).map(checkEntry));
  }
  /** Queues a draft; it gets its seq on first placement. TypeError when it cannot form a valid op line. */
  add(draft) {
    materialize(draft, widestId(PROBE_SELF));
    this.entries.push({ draft: copyOf(draft), op: null });
  }
  /**
   * Allowed ops (PRO-45) in seq order within the caps; allocates seqs on first placement (event drafts get
   * cid = eventCid(id, kind)). The room is clamped to the ops.jsonl caps (1,000 ops, 64 KiB, PRO-03); the
   * first allowed op that does not fit ends the take, so later ops never jump ahead (oldest seq first,
   * PRO-06), and an op left out is not allocated a seq. `states` are every active push state; an op leaves
   * only if each allows it (allowedInAll; `[]` is ok). Ops not allowed stay, unallocated ones without a
   * seq. An op allocated under another (peer, epoch) can never fold valid for this writer (PRO-16); it is
   * placed again as a fresh draft.
   */
  take(states, self, alloc, room) {
    checkStates(states);
    const maxOps = capOf(room.maxOps, OPS_MAX_LINES);
    const maxBytes = capOf(room.maxBytes, OPS_MAX_BYTES);
    if (this.entries.some((e) => e.op !== null && !isOwn(e.op, self))) {
      this.entries = normalize(this.entries.map((e) => e.op !== null && !isOwn(e.op, self) ? { draft: e.draft, op: null } : e));
    }
    const widest = widestId(self);
    let floor = this.maxOwnSeq(self);
    const out = [];
    let bytes = 0;
    try {
      for (const e of this.entries) {
        if (!allowedInAll(e.draft, states)) continue;
        if (out.length >= maxOps) break;
        const size = e.op !== null ? lineBytes(e.op) : lineBytes(materialize(e.draft, widest));
        if (bytes + size > maxBytes) break;
        if (e.op === null) {
          e.op = mint(e.draft, alloc, self, floor);
          floor = seqOf(e.op);
        }
        bytes += lineBytes(e.op);
        out.push(e.op);
      }
    } finally {
      this.entries = normalize(this.entries);
    }
    return out;
  }
  /**
   * After an own intent with writer seq w landed: drop its ops; renumber every op with seq < w that was not
   * in it (order kept; cids recomputed) — the fold's last_seq of this epoch is now ≥ w, so those ids would
   * fold as no-ops (PRO-09).
   */
  landed(intentOpIds, writerSeq, alloc, self) {
    const floor = Math.max(this.maxOwnSeq(self), writerSeq);
    this.entries = this.entries.filter((e) => e.op === null || !intentOpIds.has(e.op.id));
    this.renumber((op) => seqOf(op) < writerSeq, alloc, self, floor);
  }
  /** PRO-09's second rule: at intent build, every op whose seq is ≤ the folded last_seq of its own epoch gets a new seq (order kept). */
  renumberAtOrBelow(lastSeq, alloc, self) {
    this.renumber((op) => seqOf(op) <= lastSeq, alloc, self, Math.max(this.maxOwnSeq(self), lastSeq));
  }
  /** Removes every entry whose draft matches (e.g. an unpublished HOST_THROTTLED event once the mode is normal, PRO-55); returns the count. */
  drop(pred) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !pred(e.draft));
    return before - this.entries.length;
  }
  /** Some queued op may leave while every state in `states` holds (PRO-42's "allowed outbox ops"; `[]` is ok). */
  pendingAllowed(states) {
    checkStates(states);
    return this.entries.some((e) => allowedInAll(e.draft, states));
  }
  get size() {
    return this.entries.length;
  }
  /**
   * Copies of every entry's draft, in outbox order (allocated ones first, by seq). A new Outbox of these drafts with no
   * op is the same queue with every seq released: a re-anchor rebuilds the outbox under its new epoch this way (PRO-25).
   */
  drafts() {
    return this.entries.map((e) => copyOf(e.draft));
  }
  /** meta.outbox: `{ entries: [{ draft, op }] }` in outbox order (ruling R-14). */
  toJson() {
    return { entries: this.entries.map((e) => ({ draft: e.draft, op: e.op })) };
  }
  /** The inverse of toJson. Anything malformed throws TypeError: a dropped entry would be a lost op. */
  static fromJson(j) {
    if (typeof j !== "object" || j === null || Array.isArray(j)) throw new TypeError("outbox: meta.outbox must be an object");
    const list = j["entries"];
    if (!Array.isArray(list)) throw new TypeError("outbox: meta.outbox.entries must be an array");
    return new _Outbox(
      list.map((x) => {
        if (typeof x !== "object" || x === null || Array.isArray(x)) throw new TypeError("outbox: an entry must be an object");
        return { draft: x["draft"], op: x["op"] ?? null };
      })
    );
  }
  /**
   * The highest seq this outbox holds under self's (peer, epoch); 0 when none. The publish's seq allocator starts above
   * it as well as above meta.seq_next, so an allocation the state never persisted can never make a writer seq ≤ an op
   * seq (PRO-09; Task 14 round 1).
   */
  maxOwnSeq(self) {
    return this.entries.reduce((m, e) => e.op !== null && isOwn(e.op, self) ? Math.max(m, seqOf(e.op)) : m, 0);
  }
  /**
   * New seqs, in their current order, for the allocated ops matching `pred`; they move after the other
   * allocated ones. Every new seq must rise above `floor` (the landed writer seq or the folded last_seq, and
   * every seq held): a lower one would fold as a no-op again or reuse an id.
   */
  renumber(pred, alloc, self, floor) {
    const moving = this.entries.filter((e) => e.op !== null && pred(e.op));
    if (moving.length === 0) return;
    const movingSet = new Set(moving);
    const allocated = this.entries.filter((e) => e.op !== null && !movingSet.has(e));
    const rest = this.entries.filter((e) => e.op === null);
    let f = floor;
    const renumbered = moving.map((e) => {
      const op = mint(e.draft, alloc, self, f);
      f = seqOf(op);
      return { draft: e.draft, op };
    });
    this.entries = [...allocated, ...renumbered, ...rest];
  }
};
function mint(draft, alloc, self, floor) {
  const seq = alloc.next();
  if (!Number.isSafeInteger(seq) || seq <= floor) throw new RangeError(`outbox: allocated seq ${String(seq)} does not rise above ${floor}`);
  return materialize(draft, formatOpId({ peer: self.peer, epoch: self.epoch, seq }));
}
var copyOf = (d) => JSON.parse(canonicalJson(d));
function checkEntry(e) {
  if (typeof e !== "object" || e === null) throw new TypeError("outbox: an entry must be an object");
  const { op } = e;
  materialize(e.draft, widestId(PROBE_SELF));
  const draft = copyOf(e.draft);
  if (op === null) return { draft, op: null };
  if (typeof op !== "object" || Array.isArray(op) || typeof op.id !== "string" || parseOpId(op.id) === null) {
    throw new TypeError("outbox: an allocated entry needs an op with an op id");
  }
  const expected = materialize(draft, op.id);
  if (canonicalJson(expected) !== canonicalJson(op)) {
    throw new TypeError(`outbox: op ${op.id} does not match its draft`);
  }
  return { draft, op: expected };
}
function normalize(entries) {
  const allocated = entries.filter((e) => e.op !== null);
  const ids = new Set(allocated.map((e) => e.op.id));
  if (ids.size !== allocated.length) throw new TypeError("outbox: one op id is held by two entries");
  allocated.sort((a, b) => seqOf(a.op) - seqOf(b.op));
  return [...allocated, ...entries.filter((e) => e.op === null)];
}

// src/data/attrs.ts
import { join as join2 } from "node:path";
var ATTR_NAMES = ["filter", "merge", "text", "binary", "eol", "linguist-generated", "cowork-sync"];
var NO_VALUE = /* @__PURE__ */ new Set(["set", "unset", "unspecified"]);
async function personalAttributeFiles(repo) {
  const files = [join2(repo.paths.gitDir, "info", "attributes")];
  const r = await repo.run(["var", "GIT_ATTR_GLOBAL"], { okCodes: [0, 1, 128] });
  const global = r.code === 0 ? r.stdout.toString("utf8").replace(/\r?\n$/, "") : "";
  if (global.length > 0) files.push(global);
  return files;
}
function stringValue(v) {
  return NO_VALUE.has(v) ? null : v;
}
function toPathAttrs(v) {
  const get = (name) => v.get(name) ?? "unspecified";
  const merge = get("merge");
  const text2 = get("text");
  const generated = get("linguist-generated");
  return Object.freeze({
    filter: stringValue(get("filter")),
    merge: merge === "set" ? "text" : merge === "unset" ? "binary" : stringValue(merge),
    text: text2 === "set" || text2 === "unset" || text2 === "auto" ? text2 : null,
    binary: get("binary") === "set",
    eol: stringValue(get("eol")),
    generated: generated === "set" || generated === "true",
    coworkOff: get("cowork-sync") === "off"
  });
}
var AttrCache = class {
  repo;
  fs;
  cache = /* @__PURE__ */ new Map();
  cachedBase = null;
  signature = null;
  files = null;
  generation = 0;
  constructor(repo, fs) {
    this.repo = repo;
    this.fs = fs;
  }
  invalidate() {
    this.generation++;
    this.cache.clear();
    this.cachedBase = null;
    this.signature = null;
    this.files = null;
  }
  async currentSignature() {
    this.files ??= await personalAttributeFiles(this.repo);
    const parts = [];
    for (const file of this.files) {
      const st = await this.fs.stat(file);
      parts.push(st === null ? `${file}|absent` : `${file}|${st.size}|${st.mtimeMs}`);
    }
    return parts.join("\n");
  }
  async snapshot(epochBase, paths) {
    const sig = await this.currentSignature();
    if (this.cachedBase !== epochBase || this.signature !== sig) {
      this.generation++;
      this.cache.clear();
      this.cachedBase = epochBase;
      this.signature = sig;
    }
    const wanted = [...new Set(paths)];
    const missing = wanted.filter((p) => !this.cache.has(p));
    const fetched = /* @__PURE__ */ new Map();
    if (missing.length > 0) {
      const generation = this.generation;
      const stdin = Buffer.from(missing.map((p) => `${p}\0`).join(""), "utf8");
      const r = await this.repo.run(["check-attr", "-z", "--stdin", ...ATTR_NAMES], { class: "attr", attrTree: epochBase, stdin });
      const fields = r.stdout.toString("utf8").split("\0");
      const byPath = /* @__PURE__ */ new Map();
      for (let i = 0; i + 2 < fields.length; i += 3) {
        const path = fields[i] ?? "";
        let m = byPath.get(path);
        if (m === void 0) {
          m = /* @__PURE__ */ new Map();
          byPath.set(path, m);
        }
        m.set(fields[i + 1] ?? "", fields[i + 2] ?? "");
      }
      for (const p of missing) {
        const v = byPath.get(p);
        if (v === void 0) throw new Error(`check-attr: no answer for ${JSON.stringify(p)}`);
        fetched.set(p, toPathAttrs(v));
      }
      if (generation === this.generation) for (const [p, a] of fetched) this.cache.set(p, a);
    }
    const own = /* @__PURE__ */ new Map();
    for (const p of wanted) {
      const a = fetched.get(p) ?? this.cache.get(p);
      if (a !== void 0) own.set(p, a);
    }
    return {
      epochBase,
      get(path) {
        const a = own.get(path);
        if (a === void 0) throw new Error(`AttrSnapshot: attributes of ${JSON.stringify(path)} were not requested`);
        return a;
      }
    };
  }
};

// src/data/config.ts
var DEFAULT_INSERTION_MERGE = Object.freeze(["CHANGELOG*", "HISTORY*", "NEWS*", "*.md", "*.txt"]);
var MAX_NEW_FILE_BYTES = 1048576;
function defaults() {
  return {
    sync: { include: [], exclude: [], allowSecretLike: [], maxNewFileBytes: MAX_NEW_FILE_BYTES },
    merge: { insertionMerge: [...DEFAULT_INSERTION_MERGE] },
    host: { pushBudgetPerMin: void 0 }
  };
}
var DEFAULT_TEAM_CONFIG = defaults();
var CONFIG_PATH = ".cowork/config.json";
function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function stringArray(x) {
  if (!Array.isArray(x)) return null;
  const out = [];
  for (const e of x) {
    if (typeof e !== "string") return null;
    out.push(e);
  }
  return out;
}
async function readTeamConfig(repo, epochBase) {
  const config = defaults();
  let reason = null;
  const blob2 = await repo.resolve(`${epochBase}:${CONFIG_PATH}`);
  if (blob2 === null || !await repo.hasObject(blob2, "blob")) return { config, invalid: false, reason: null };
  const bytes = await repo.readBlob(blob2);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return { config, invalid: true, reason: "not a UTF-8 JSON object" };
  }
  if (!isRecord(parsed)) return { config, invalid: true, reason: "not a UTF-8 JSON object" };
  const sync = parsed["sync"];
  if (isRecord(sync)) {
    const include = stringArray(sync["include"]);
    if (include !== null) config.sync.include = include;
    const exclude = stringArray(sync["exclude"]);
    if (exclude !== null) config.sync.exclude = exclude;
    const allow = stringArray(sync["allowSecretLike"]);
    if (allow !== null) {
      config.sync.allowSecretLike = allow.filter((e) => validPathSyntax(e));
      const dropped = allow.filter((e) => !validPathSyntax(e));
      if (dropped.length > 0) reason = `ignored sync.allowSecretLike entries: ${JSON.stringify(dropped)}`;
    }
    const max = sync["maxNewFileBytes"];
    if (typeof max === "number" && Number.isInteger(max) && max >= 0) config.sync.maxNewFileBytes = Math.min(max, MAX_NEW_FILE_BYTES);
  }
  const merge = parsed["merge"];
  if (isRecord(merge)) {
    const ins = stringArray(merge["insertionMerge"]);
    if (ins !== null) config.merge.insertionMerge = ins;
  }
  const globFields = [
    ["sync.include", config.sync.include],
    ["sync.exclude", config.sync.exclude],
    ["merge.insertionMerge", config.merge.insertionMerge]
  ];
  for (const [field2, globs] of globFields) {
    const bad = globs.find((g) => !validGlob(g));
    if (bad !== void 0) return { config: defaults(), invalid: true, reason: `invalid glob in ${field2}: ${JSON.stringify(bad)}` };
  }
  const host = parsed["host"];
  if (isRecord(host) && "pushBudgetPerMin" in host) config.host.pushBudgetPerMin = host["pushBudgetPerMin"];
  return { config, invalid: false, reason };
}
function genesisBudget(cfg) {
  const v = cfg.host.pushBudgetPerMin;
  return typeof v === "number" && Number.isInteger(v) && v >= 6 && v <= 24 ? v : 12;
}

// src/data/filters.ts
import { createHash as createHash4 } from "node:crypto";
var MAX_DRIVERS = 64;
var MAX_DRIVER_NAME_BYTES = 128;
var MAX_DRIVER_ARGV_BYTES = 8192;
var PAIR_OVERHEAD = "-c ".length + "filter.".length + ".required=true".length;
function validDriverName(d) {
  return d.length > 0 && !/[=\s\0]/.test(d);
}
function driversNamedIn(text2) {
  const out = [];
  for (const raw of text2.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    for (const token of line.split(/\s+/)) {
      if (token.startsWith("filter=")) {
        const name = token.slice("filter=".length);
        if (validDriverName(name)) out.push(name);
      }
    }
  }
  return out;
}
async function driverSettings(repo) {
  const out = /* @__PURE__ */ new Map();
  const r = await repo.run(["config", "-z", "--show-scope", "--get-regexp", "^filter\\."], { okCodes: [0, 1] });
  if (r.code !== 0) return out;
  const fields = r.stdout.toString("utf8").split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope2 = fields[i] ?? "";
    const record = fields[i + 1] ?? "";
    if (scope2 === "command") continue;
    const nl = record.indexOf("\n");
    const key = nl < 0 ? record : record.slice(0, nl);
    const value = nl < 0 ? "true" : record.slice(nl + 1);
    const last = key.lastIndexOf(".");
    if (!key.startsWith("filter.") || last <= "filter.".length - 1) continue;
    const name = key.slice("filter.".length, last);
    const variable = key.slice(last + 1).toLowerCase();
    let m = out.get(name);
    if (m === void 0) {
      m = /* @__PURE__ */ new Map();
      out.set(name, m);
    }
    m.set(variable, value);
  }
  return out;
}
async function discoverFilters(repo, fs, epochBase) {
  const names = /* @__PURE__ */ new Set();
  const tree2 = await repo.readTreeMap(epochBase);
  const paths = [...tree2.keys()];
  if (paths.length > 0) {
    const stdin = Buffer.from(paths.map((p) => `${p}\0`).join(""), "utf8");
    const r = await repo.run(["check-attr", "-z", "--stdin", "filter"], { class: "attr", attrTree: epochBase, stdin });
    const fields = r.stdout.toString("utf8").split("\0");
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const value = fields[i + 2] ?? "";
      if (value !== "set" && value !== "unset" && value !== "unspecified" && validDriverName(value)) names.add(value);
    }
  }
  const attrFiles = [...tree2.values()].filter((e) => e.mode !== "160000" && (e.path === ".gitattributes" || e.path.endsWith("/.gitattributes")));
  for (const blob2 of await repo.readBlobs(attrFiles.map((e) => e.oid))) {
    for (const d of driversNamedIn(blob2.toString("utf8"))) names.add(d);
  }
  for (const file of await personalAttributeFiles(repo)) {
    if (await fs.stat(file) === null) continue;
    for (const d of driversNamedIn((await fs.readFile(file)).toString("utf8"))) names.add(d);
  }
  const settings = await driverSettings(repo);
  const all = [...names].sort();
  const drivers = [];
  let argvBytes = 0;
  for (const d of all) {
    const size = Buffer.byteLength(d, "utf8");
    if (size > MAX_DRIVER_NAME_BYTES || drivers.length >= MAX_DRIVERS || argvBytes + size + PAIR_OVERHEAD > MAX_DRIVER_ARGV_BYTES) continue;
    drivers.push(d);
    argvBytes += size + PAIR_OVERHEAD;
  }
  const overCap = drivers.length < all.length ? all.length : null;
  const fingerprint2 = {};
  for (const d of drivers) {
    const s = settings.get(d);
    const v = (k) => s?.get(k) ?? "";
    fingerprint2[d] = createHash4("sha256").update(`${v("clean")}\0${v("smudge")}\0${v("process")}\0${v("required")}`, "utf8").digest("hex");
  }
  return { drivers, fingerprint: fingerprint2, overCap };
}

// src/holds/changesets.ts
import { Buffer as Buffer2 } from "node:buffer";

// src/git/scratchIndex.ts
function isGoneError(e) {
  const code = typeof e === "object" && e !== null ? e.code : void 0;
  return code === "ENOENT" || code === "ENOTDIR";
}
var ScratchResetError = class extends Error {
  file;
  code;
  constructor(file, cause) {
    const code = typeof cause === "object" && cause !== null ? cause.code : void 0;
    super(`the scratch index ${file} could not be reset (${code ?? "unknown"})`);
    this.name = "ScratchResetError";
    this.file = file;
    this.code = typeof code === "string" ? code : void 0;
  }
};
async function resetScratchIndex(fs, indexFile) {
  for (const f of [indexFile, `${indexFile}.lock`]) {
    try {
      await fs.unlink(f);
    } catch (e) {
      if (!isGoneError(e)) throw new ScratchResetError(f, e);
    }
  }
}

// src/holds/changesets.ts
var HUMAN_CS_QUIET_MS = 2e4;
var ReadyBaseMismatchError = class extends Error {
  path;
  constructor(path) {
    super(`ready pair base A_cap differs from A on ${JSON.stringify(path)}`);
    this.name = "ReadyBaseMismatchError";
    this.path = path;
  }
};
function readyKey(csId) {
  if (!validId("cs", csId)) throw new TypeError(`readyKey: not a change-set id ${JSON.stringify(csId)}`);
  return Buffer2.from(csId, "utf8").toString("base64url");
}
var FILE_MODES2 = /* @__PURE__ */ new Set(["100644", "100755"]);
function same(a, b) {
  return a === null ? b === null : b !== null && a.oid === b.oid && a.mode === b.mode;
}
function byOrder(a, b) {
  return a.order - b.order || (a.csId < b.csId ? -1 : a.csId > b.csId ? 1 : 0);
}
async function rebaseEntry(repo, path, aNew, acap, r) {
  if (same(r, acap)) return aNew;
  if (same(r, aNew)) return r;
  if (acap === null || aNew === null || r === null) return void 0;
  let mode;
  if (r.mode === acap.mode) mode = aNew.mode;
  else if (aNew.mode === acap.mode || aNew.mode === r.mode) mode = r.mode;
  else return void 0;
  if (r.oid === aNew.oid) return { path, mode, oid: r.oid };
  if (r.oid === acap.oid) return { path, mode, oid: aNew.oid };
  if (aNew.oid === acap.oid) return { path, mode, oid: r.oid };
  if (![acap.mode, aNew.mode, r.mode].every((m2) => FILE_MODES2.has(m2))) return void 0;
  const m = await mergeFile(repo, aNew.oid, acap.oid, r.oid);
  if (m.rc !== 0) return void 0;
  return { path, mode, oid: await repo.hashBytes(m.out, true) };
}
var STRENGTH = { keep: 0, withdraw: 1, cancel: 2 };
function decideConflict(ch, r) {
  if (ch.written !== "clean" && ch.written !== "concat") return "cancel";
  if (!same(ch.sDiskBefore, r)) return "withdraw";
  if (ch.writtenEntry !== null) return { entry: ch.writtenEntry };
  return ch.aNew === null ? { entry: null } : "withdraw";
}
function groupVerdicts(plans) {
  const parent = plans.map((_, i) => i);
  const find = (i) => {
    let x = i;
    while (parent[x] !== x) x = parent[x];
    for (let y = i; parent[y] !== x; ) {
      const up = parent[y];
      parent[y] = x;
      y = up;
    }
    return x;
  };
  const owner = /* @__PURE__ */ new Map();
  plans.forEach((plan, i) => {
    for (const p of plan.pair.paths) {
      const j = owner.get(p);
      if (j === void 0) owner.set(p, i);
      else parent[find(i)] = find(j);
    }
  });
  const strongest = /* @__PURE__ */ new Map();
  plans.forEach((plan, i) => {
    const root = find(i);
    const v = strongest.get(root) ?? "keep";
    strongest.set(root, STRENGTH[plan.verdict] > STRENGTH[v] ? plan.verdict : v);
  });
  return plans.map((_, i) => strongest.get(find(i)));
}
async function planRebase(repo, pair, byPath) {
  const plan = { pair, verdict: "keep", rEdits: [], aEdits: [], paths: pair.paths };
  const touched = pair.paths.filter((p) => byPath.has(p));
  if (touched.length === 0) return plan;
  const R = await repo.readTreeMap(pair.R);
  const Acap = await repo.readTreeMap(pair.A);
  const rKeys = new Set(R.keys());
  const aKeys = new Set(Acap.keys());
  for (const p of touched) {
    const ch = byPath.get(p);
    const acap = Acap.get(p) ?? null;
    const r = R.get(p) ?? null;
    if (same(acap, ch.aNew) && ch.written !== "take_tip") continue;
    let next = await rebaseEntry(repo, p, ch.aNew, acap, r);
    if (next === void 0) {
      const d = decideConflict(ch, r);
      if (typeof d === "string") {
        if (STRENGTH[d] > STRENGTH[plan.verdict]) plan.verdict = d;
        if (d === "cancel") break;
        continue;
      }
      next = d.entry;
    }
    if (plan.verdict !== "keep") continue;
    if (next !== null) {
      plan.rEdits.push({ path: p, mode: next.mode, oid: next.oid });
      rKeys.add(p);
    } else if (rKeys.delete(p)) {
      plan.rEdits.push({ path: p, remove: true });
    }
    if (ch.aNew !== null) {
      plan.aEdits.push({ path: p, mode: ch.aNew.mode, oid: ch.aNew.oid });
      aKeys.add(p);
    } else if (aKeys.delete(p)) {
      plan.aEdits.push({ path: p, remove: true });
    }
  }
  if (plan.verdict !== "keep" || plan.rEdits.length === 0 && plan.aEdits.length === 0) return plan;
  plan.paths = [.../* @__PURE__ */ new Set([...rKeys, ...aKeys])].sort();
  if (plan.paths.length === 0) plan.verdict = "withdraw";
  return plan;
}
var ChangeSets = class {
  peer;
  clock;
  /** The Fs port for the capture's scratch-index reset (P2-SCRATCHLOCK); absent in unit uses without an engine. */
  fs;
  nextN = 1;
  open = null;
  /** Paths of withdrawn or cancelled captures with no open member to carry them: re-captured at the next snapshot (HLD-41). */
  pending = /* @__PURE__ */ new Set();
  pairs = [];
  constructor(peer, clock, fs) {
    if (!validId("hex128", peer)) throw new TypeError(`ChangeSets: not a peer id ${JSON.stringify(peer)}`);
    this.peer = peer;
    this.clock = clock;
    this.fs = fs ?? null;
  }
  /** The journal's ready pairs and meta.cs_human_next; the open CS re-forms through observe(). n never reuses a journaled order. */
  restore(ready, nextN) {
    if (!Number.isSafeInteger(nextN) || nextN < 1) throw new RangeError(`ChangeSets.restore: nextN must be a safe integer >= 1, got ${String(nextN)}`);
    this.pairs = ready.map((p) => ({ ...p, paths: [...p.paths] })).sort(byOrder);
    this.nextN = Math.max(nextN, ...this.pairs.map((p) => p.order + 1));
    this.open = null;
    this.pending.clear();
  }
  /** HLD-35: open or extend the human CS with the changed paths; restart its 20 s quiet timer. */
  observe(changed) {
    let any = false;
    for (const p of changed) {
      this.open ??= { paths: /* @__PURE__ */ new Set(), lastChangeMono: 0, done: false };
      this.open.paths.add(p);
      any = true;
    }
    if (any) this.open.lastChangeMono = this.clock.monoMs();
    this.absorbPending();
  }
  /** /cowork done: the open CS closes at the next iteration. */
  done() {
    if (this.open !== null) this.open.done = true;
  }
  /** 20 s Δmono quiet, done(), or a pending recapture. */
  closeDue() {
    return this.openDue() || this.pending.size > 0;
  }
  /**
   * HLD-40 at the close (the iteration materialized): R[p] = S_disk[p], A_cap[p] = A[p] over the closing CS's paths plus
   * pending recaptures, sparse trees by writeTreeMap; cs_id `<peer>/human/<n>`, n then increments. A path absent from
   * both trees is not a path of the pair (a sparse tree cannot say "absent"), so the newest capture of such a path — a
   * file created and then deleted before it was published — is expressed by every older ready pair dropping it from R
   * and A_cap (a pair left with no path leaves the journal): the creation is never published (Task 19 ruling, HLD-42's
   * "the newest capture wins"; A lacks p, so A_cap[p] is absent as well and P[p] = A[p] = absent).
   * `kept`: the cs_ids a kept push intent names (Task 19 ruling, fix round 3). Such a pair is never shrunk: the push may
   * have landed, and its ok update reads A_cap from the pair (A[p] := C[p] only where the pair still lists p), so a
   * shrunk pair would leave A behind TIP and the next apply would write the deleted file back. Its vanished path waits
   * in `pending` instead and re-closes at the next capture after the intent resolved: landed, A has p and the disk
   * lacks it, so a deletion pair is captured; not landed, the pair is no longer kept and drops p.
   * Returns null when nothing changed in the journal (nothing due, or only paths absent everywhere that no unkept pair
   * covers); otherwise `pair` is the new ready pair, or null when the close only shrank older pairs, and the caller
   * journals ready() with `nextN` (unchanged when no pair was captured: no n is consumed).
   */
  async capture(repo, sDisk, A, scratchIndex, kept = /* @__PURE__ */ new Set()) {
    const closing = this.openDue();
    if (!closing && this.pending.size === 0) return null;
    const paths = new Set(this.pending);
    if (closing) for (const p of this.open.paths) paths.add(p);
    const R = /* @__PURE__ */ new Map();
    const Acap = /* @__PURE__ */ new Map();
    const vanished = /* @__PURE__ */ new Set();
    for (const p of [...paths].sort()) {
      const r = sDisk.get(p);
      const a = A.get(p);
      if (r !== void 0) R.set(p, { path: p, mode: r.mode, oid: r.oid });
      if (a !== void 0) Acap.set(p, { path: p, mode: a.mode, oid: a.oid });
      if (r === void 0 && a === void 0) vanished.add(p);
    }
    const pairPaths = [.../* @__PURE__ */ new Set([...R.keys(), ...Acap.keys()])].sort();
    let pair = null;
    if (pairPaths.length > 0) {
      const n = this.nextN;
      const csId = `${this.peer}/human/${n}`;
      readyKey(csId);
      await this.resetScratch(scratchIndex);
      const rTree = await repo.writeTreeMap(R, scratchIndex);
      await this.resetScratch(scratchIndex);
      const aTree = await repo.writeTreeMap(Acap, scratchIndex);
      pair = { csId, R: rTree, A: aTree, paths: pairPaths, order: n };
    }
    const { pairs: shrunk, deferred } = await this.withoutVanished(repo, vanished, kept, scratchIndex);
    if (closing) this.open = null;
    this.pending.clear();
    for (const p of deferred) this.pending.add(p);
    if (shrunk !== null) this.pairs = shrunk;
    if (pair === null) return shrunk === null ? null : { pair: null, nextN: this.nextN };
    this.nextN = pair.order + 1;
    this.pairs.push(pair);
    this.pairs.sort(byOrder);
    return { pair: { ...pair, paths: [...pair.paths] }, nextN: this.nextN };
  }
  /**
   * The ready pairs after dropping `vanished` (closing paths absent from S_disk and A) from every pair covering one: its
   * R and A_cap lose the path (only the trees that hold it are rewritten), a pair left with no path leaves. A pair in
   * `kept` (named by a kept push intent) is left whole and its vanished paths are returned as `deferred`. `pairs` is null
   * when no unkept pair covers a vanished path. Builds trees only; the caller replaces `pairs` and fills `pending`.
   */
  async withoutVanished(repo, vanished, kept, scratchIndex) {
    const deferred = /* @__PURE__ */ new Set();
    if (vanished.size === 0) return { pairs: null, deferred };
    let changed = false;
    const out = [];
    for (const pair of this.pairs) {
      const gone = pair.paths.filter((p) => vanished.has(p));
      if (gone.length === 0) {
        out.push(pair);
        continue;
      }
      if (kept.has(pair.csId)) {
        for (const p of gone) deferred.add(p);
        out.push(pair);
        continue;
      }
      changed = true;
      const rest = pair.paths.filter((p) => !vanished.has(p));
      if (rest.length === 0) continue;
      const drop = async (tree2) => {
        const held = await repo.readTreeMap(tree2);
        const edits = gone.filter((p) => held.has(p)).map((p) => ({ path: p, remove: true }));
        if (edits.length === 0) return tree2;
        await this.resetScratch(scratchIndex);
        return repo.editTree(tree2, edits, scratchIndex);
      };
      out.push({ csId: pair.csId, R: await drop(pair.R), A: await drop(pair.A), paths: rest, order: pair.order });
    }
    return { pairs: changed ? out : null, deferred };
  }
  /**
   * R-01 at a restart (final review FD, Task 19 round-3 residual). `pending` and the open CS are not journaled, so the
   * close that would have dropped a created-then-deleted path from its ready pair (a path `vanished`: absent from A and
   * from the disk) is lost with the process; the restart makes it here, as capture() would: every pair `kept` (named by
   * a kept push intent) does not name drops the path (R and A_cap lose it, a pair left with no path leaves), and a kept
   * pair's path waits in `pending` again, to re-close after the intent resolved. True when the pairs changed: the caller
   * journals ready() (cs_human_next is unchanged: no pair is captured).
   */
  async dropVanished(repo, vanished, kept, scratchIndex) {
    const { pairs, deferred } = await this.withoutVanished(repo, vanished, kept, scratchIndex);
    for (const p of deferred) this.pending.add(p);
    this.absorbPending();
    if (pairs === null) return false;
    this.pairs = pairs;
    return true;
  }
  /** P2-SCRATCHLOCK before a read-tree into the capture's scratch index (no Fs port in unit uses without an engine). */
  async resetScratch(scratchIndex) {
    if (this.fs !== null) await resetScratchIndex(this.fs, scratchIndex);
  }
  /**
   * HLD-41 at a state update that changed A: for every ready pair with a changed path, R[p] := merge-file(A_new, A_cap, R)
   * and A_cap[p] := A_new. A conflict on p is decided by what the update did to p (decideConflict): a clean or concat write
   * with S_disk[p] == R[p] before the apply sets R[p] := the written entry and the pair stays ready; a clean or concat write
   * after a later file effect on p withdraws the capture (no message); take_tip, or A changed without a write, cancels it
   * (CS_READY_CANCELLED). A pair left with no path (R and A_cap both lost every entry) is withdrawn, never dropped
   * silently. Withdrawal and cancellation apply to the whole publication group (HLD-38: the ready pairs connected through
   * shared paths), cancellation winning when both occur; only kept groups get rebased trees. Withdrawn and cancelled paths
   * are re-captured at the close of an open CS that shares a path with them, else at the next snapshot (every member is closed).
   */
  async rebase(repo, changes, scratchIndex) {
    const byPath = /* @__PURE__ */ new Map();
    for (const ch of changes) if (!same(ch.aOld, ch.aNew) || ch.written === "take_tip") byPath.set(ch.path, ch);
    const plans = [];
    for (const pair of this.pairs) plans.push(await planRebase(repo, pair, byPath));
    const verdicts = groupVerdicts(plans);
    const kept = [];
    const cancelled = [];
    const recapture = /* @__PURE__ */ new Set();
    for (const [i, plan] of plans.entries()) {
      const { pair } = plan;
      const verdict = verdicts[i];
      if (verdict !== "keep") {
        for (const p of pair.paths) recapture.add(p);
        if (verdict === "cancel") cancelled.push(pair.csId);
        continue;
      }
      if (plan.rEdits.length === 0 && plan.aEdits.length === 0) {
        kept.push(pair);
        continue;
      }
      const rTree = plan.rEdits.length > 0 ? await repo.editTree(pair.R, plan.rEdits, scratchIndex) : pair.R;
      const aTree = plan.aEdits.length > 0 ? await repo.editTree(pair.A, plan.aEdits, scratchIndex) : pair.A;
      kept.push({ csId: pair.csId, R: rTree, A: aTree, paths: plan.paths, order: pair.order });
    }
    this.pairs = kept;
    for (const p of recapture) this.pending.add(p);
    this.absorbPending();
    return { ready: kept.map((p) => ({ ...p, paths: [...p.paths] })), cancelled, recapture };
  }
  /**
   * P (HLD-42): MASK(R) of the newest ready pair covering p, A[p] elsewhere; A_cap[p] ≠ A[p] → ReadyBaseMismatchError
   * (ENG-39). 01-engine §3.12 step 1 (ruling P2-PIN): a ready pair sharing any path with `pinnedPaths` (non-terminal
   * ON_DISK PINs: join, phantom, host-reject) is skipped whole and stays journaled. csIds lists every included pair in
   * capture order, also one whose paths a newer pair covers (its edits are in the newer R), so published() clears it;
   * csPaths maps each to its paths (Cowork-CS-Paths).
   */
  async composeP(repo, A, mask, pinnedPaths2) {
    const X = new Map(A);
    const csIds = [];
    const csPaths = /* @__PURE__ */ new Map();
    for (const pair of this.pairs) {
      if (pair.paths.some((p) => pinnedPaths2.has(p))) continue;
      const R = await repo.readTreeMap(pair.R);
      const Acap = await repo.readTreeMap(pair.A);
      for (const p of pair.paths) if (!same(Acap.get(p) ?? null, A.get(p) ?? null)) throw new ReadyBaseMismatchError(p);
      for (const p of pair.paths) {
        const r = R.get(p);
        if (r !== void 0) X.set(p, r);
        else X.delete(p);
      }
      csIds.push(pair.csId);
      csPaths.set(pair.csId, [...pair.paths]);
    }
    return { P: mask(X), csIds, csPaths };
  }
  /** The pairs of a landed publish (or of OUT == tree(TIP) with no ops, R-02) leave the journal. */
  published(csIds) {
    const gone = new Set(csIds);
    this.pairs = this.pairs.filter((p) => !gone.has(p.csId));
  }
  /** Capture order, oldest first. */
  ready() {
    return this.pairs.map((p) => ({ ...p, paths: [...p.paths] }));
  }
  /** open: the open human CS, plus one for paths waiting for a recapture; ready: the journaled pairs. */
  counts() {
    return { open: (this.open !== null ? 1 : 0) + (this.pending.size > 0 ? 1 : 0), ready: this.pairs.length };
  }
  /** Local deltas in no ready pair: the open CS's paths and the paths waiting for a recapture. */
  openPaths() {
    return /* @__PURE__ */ new Set([...this.open?.paths ?? [], ...this.pending]);
  }
  openDue() {
    return this.open !== null && (this.open.done || this.clock.monoMs() - this.open.lastChangeMono >= HUMAN_CS_QUIET_MS);
  }
  /** Paths waiting for a recapture that the open CS shares go with the open CS: they are re-captured at its close. */
  absorbPending() {
    if (this.open === null || this.pending.size === 0) return;
    if (![...this.pending].some((p) => this.open.paths.has(p))) return;
    for (const p of this.pending) this.open.paths.add(p);
    this.pending.clear();
  }
};

// src/holds/registry.ts
var RegistryCasLostError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryCasLostError";
  }
};
var HOLDS_SUBJECT = "cowork-holds";
var CAS_LOST_CODE = "HOLDS_CAS_LOST";
var GUARD_OWNER = { conflict: "DAT", "eol-bom": "DAT", restart: "ENG", phantom: "ENG", "host-reject": "ENG", join: "LIF" };
var RECORDS = "records/";
var BLOBS = "blobs/";
var RECORD_SUFFIX = ".json";
function sameMap(a, b) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}
function sameGuardNames(a, b) {
  const na = a.map((g) => g.name).sort();
  const nb = b.map((g) => g.name).sort();
  return na.length === nb.length && na.every((n, i) => n === nb[i]);
}
function blobOids(r) {
  const out = [];
  for (const m of Object.values(r.blobs)) for (const o of Object.values(m)) if (o !== ABSENT) out.push(o);
  return out;
}
function deepFreeze(v) {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}
function storedRecord(buf) {
  return deepFreeze(parseRecord(buf));
}
var HoldRegistry = class {
  d;
  cur = null;
  /** Per record: the monoMs from which this run's Δmono is not yet in age_anchor.mono_accum_ms (05-holds §2). */
  monoFrom = /* @__PURE__ */ new Map();
  /** The tail of the in-process queue: load(), hold() and transition() run one at a time, so two overlapping calls never race one CAS. */
  tail = Promise.resolve();
  constructor(d) {
    this.d = d;
  }
  /** Runs `fn` after every earlier queued call settled (a failure does not stop the queue). */
  serial(fn) {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => void 0);
    return run;
  }
  /** Re-attach (HLD-01): read the ref; an absent ref is an empty registry. A malformed registry throws. */
  load() {
    return this.serial(() => this.loadNow());
  }
  async loadNow() {
    const { repo, ref, clock } = this.d;
    const head = await repo.readRef(ref);
    const records = /* @__PURE__ */ new Map();
    const recordOids = /* @__PURE__ */ new Map();
    if (head !== null) {
      const bad = (what) => new Error(`hold registry ${ref} at ${head}: ${what}`);
      const info = await repo.readCommit(head);
      if (info.subject !== HOLDS_SUBJECT || info.trailers.length !== 0 || info.parents.length > 1) throw bad("not a cowork-holds commit");
      const leaves = await repo.readTreeMap(info.tree);
      const blobNames = /* @__PURE__ */ new Set();
      for (const [path, e] of leaves) {
        if (e.mode !== "100644") throw bad(`${path} is not a blob`);
        if (path.startsWith(RECORDS) && path.endsWith(RECORD_SUFFIX) && !path.slice(RECORDS.length).includes("/")) {
          recordOids.set(path.slice(RECORDS.length, -RECORD_SUFFIX.length), e.oid);
        } else if (path.startsWith(BLOBS) && path.slice(BLOBS.length) === e.oid) {
          blobNames.add(e.oid);
        } else {
          throw bad(`unexpected entry ${JSON.stringify(path)}`);
        }
      }
      const ids = [...recordOids.keys()];
      const bufs = await repo.readBlobs(ids.map((id) => recordOids.get(id)));
      ids.forEach((id, i) => {
        const r = storedRecord(bufs[i]);
        if (r.id !== id) throw bad(`records/${id}.json holds record ${r.id}`);
        records.set(id, r);
      });
      const named = new Set([...records.values()].flatMap(blobOids));
      if (named.size !== blobNames.size || [...named].some((o) => !blobNames.has(o))) throw bad("blobs/ does not match the blobs the records name");
    }
    this.cur = { head, records, recordOids };
    this.monoFrom.clear();
    const now = clock.monoMs();
    for (const id of records.keys()) this.monoFrom.set(id, now);
  }
  /** Every record, newest rev, in id (ULID) order. Records are deeply frozen stored copies (never a caller's object). */
  all() {
    return [...this.snapshot().records.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  nonTerminal() {
    return this.all().filter((r) => !isTerminal(r));
  }
  get(id) {
    return this.snapshot().records.get(id);
  }
  /**
   * HLD-05 hold(). Dedupe among non-terminal records: an h0/h1 record dedupes on kind + guard + paths + h1; a stage
   * record (s1/s2/s3) dedupes on kind + guard + paths + s2 ONLY, and its s1/s3 are then updated to the newer call's
   * stages by transition() (R-02). A dedupe returns the existing id; otherwise one registry commit with a new ULID
   * record at rev 1; crashpoint('registry.cas') immediately before and after the CAS. Queued behind earlier calls.
   */
  hold(n) {
    return this.serial(() => this.holdNow(n));
  }
  async holdNow(n) {
    const snap = this.snapshot();
    const { clock, peer } = this.d;
    if (n.kind !== "PATCH" && n.kind !== "PIN") throw new TypeError(`hold: kind ${String(n.kind)} is not PATCH or PIN`);
    if (n.guard !== null && !Object.prototype.hasOwnProperty.call(PLAN2_GUARD_CLASS, n.guard)) throw new TypeError(`hold: ${String(n.guard)} is not a Plan 2 guard`);
    const guards = n.guard === null ? [] : [{ name: n.guard, class: PLAN2_GUARD_CLASS[n.guard], owner: GUARD_OWNER[n.guard] }];
    const paths = [...new Set(n.paths)].sort();
    for (const r of snap.records.values()) {
      if (isTerminal(r) || r.kind !== n.kind || !sameGuardNames(r.guards, guards)) continue;
      if (r.paths.length !== paths.length || r.paths.some((p, i) => p !== paths[i])) continue;
      if ("h1" in r.blobs && "h1" in n.blobs) {
        if (sameMap(r.blobs.h1, n.blobs.h1)) return r.id;
      } else if ("s2" in r.blobs && "s2" in n.blobs) {
        if (!sameMap(r.blobs.s2, n.blobs.s2)) continue;
        if (!sameMap(r.blobs.s1, n.blobs.s1) || !sameMap(r.blobs.s3, n.blobs.s3)) await this.transitionNow(r.id, { blobs: n.blobs });
        return r.id;
      }
    }
    const id = ulid(this.d.random, clock);
    if (snap.records.has(id)) throw new Error(`hold: ULID ${id} is already a record id`);
    const record = {
      id,
      rev: 1,
      owner: peer,
      kind: n.kind,
      residence: n.residence,
      state: n.state,
      offer: "none",
      declines: 0,
      displaced_by: n.displaced_by,
      paths,
      blobs: n.blobs,
      guards,
      origin: n.origin,
      cs_ids: [...n.cs_ids],
      peer_authors: [],
      local_only: n.local_only,
      age_anchor: { since_rev: 1, anchor_wall_ms: Math.floor(clock.wallMs()), mono_accum_ms: 0 },
      proto: 1
    };
    await this.write(snap, record);
    this.monoFrom.set(id, clock.monoMs());
    this.d.trace.emit({ kind: "hold", peer, id, holdKind: n.kind, guard: guards.map((g) => g.name).join(","), paths, residence: n.residence });
    return id;
  }
  /** A new rev of a non-terminal record, one registry commit; the result must still be a valid record (Table 1). Queued behind earlier calls. */
  transition(id, patch) {
    return this.serial(() => this.transitionNow(id, patch));
  }
  /** transition() inside the queue (hold()'s stage update calls it directly: queuing it again would wait for itself). */
  async transitionNow(id, patch) {
    const snap = this.snapshot();
    const { clock, peer } = this.d;
    const prev = snap.records.get(id);
    if (prev === void 0) throw new Error(`transition: unknown hold record ${JSON.stringify(id)}`);
    if (isTerminal(prev)) throw new Error(`transition: hold record ${id} is terminal (${prev.state})`);
    const rev = prev.rev + 1;
    const now = clock.monoMs();
    const from = this.monoFrom.get(id) ?? now;
    const elapsed = Math.max(0, Math.floor(now - from));
    const residence = patch.residence !== void 0 ? patch.residence : prev.residence;
    const ageStarts = residence === "ON_DISK" && prev.residence !== "ON_DISK";
    const next = {
      ...prev,
      ...patch.residence !== void 0 ? { residence: patch.residence } : {},
      ...patch.state !== void 0 ? { state: patch.state } : {},
      ...patch.blobs !== void 0 ? { blobs: patch.blobs } : {},
      ...patch.guards !== void 0 ? { guards: patch.guards.map((g) => ({ ...g })) } : {},
      rev,
      age_anchor: ageStarts ? { since_rev: rev, anchor_wall_ms: Math.floor(clock.wallMs()), mono_accum_ms: 0 } : { ...prev.age_anchor, mono_accum_ms: prev.age_anchor.mono_accum_ms + elapsed }
    };
    const stored = await this.write(snap, next);
    this.monoFrom.set(id, ageStarts ? now : from + elapsed);
    if (residence !== null && residence !== prev.residence) {
      this.d.trace.emit({ kind: "hold", peer, id, holdKind: stored.kind === "PIN" ? "PIN" : "PATCH", guard: stored.guards.map((g) => g.name).join(","), paths: [...stored.paths], residence });
    }
    return stored;
  }
  /** Non-terminal records that MASK reads (ON_DISK with guards or local_only, CONFLICTED); maskEntries applies the steps. */
  maskingRecords() {
    return this.nonTerminal().filter((r) => r.residence === "ON_DISK" && (r.guards.length > 0 || r.local_only) || r.state === "CONFLICTED" || r.guards.some((g) => guardName(g) === "claim-breach"));
  }
  snapshot() {
    if (this.cur === null) throw new Error("HoldRegistry: load() first (HLD-01 re-attach)");
    return this.cur;
  }
  /**
   * One registry commit holding every record with `record` replacing its id's entry; memory changes only after the CAS.
   * Memory keeps the record parsed back from its canonical bytes, deeply frozen (returned), never the caller's objects:
   * a caller mutating its blob maps later cannot make memory differ from the stored bytes (the next tree's blobs/).
   */
  async write(snap, record) {
    const { repo, ref, log } = this.d;
    const buf = serializeRecord(record);
    const stored = storedRecord(buf);
    const own = [...new Set(blobOids(stored))];
    if (own.length > 0) {
      const r = await repo.run(["cat-file", "--batch-check"], { stdin: Buffer.from(`${own.join("\n")}
`, "utf8") });
      const lines = r.stdout.toString("utf8").split("\n");
      own.forEach((o, i) => {
        const parts = (lines[i] ?? "").split(" ");
        if (parts.length !== 3 || parts[0] !== o || parts[1] !== "blob") throw new Error(`hold record ${stored.id}: ${o} is not a blob in the object store`);
      });
    }
    const records = new Map(snap.records);
    records.set(stored.id, stored);
    const recordOids = new Map(snap.recordOids);
    recordOids.set(stored.id, await repo.hashBytes(buf, true));
    const recordEntries = [...recordOids.keys()].sort().map((id) => ({ name: `${id}${RECORD_SUFFIX}`, mode: "100644", type: "blob", oid: recordOids.get(id) }));
    const named = [...new Set([...records.values()].flatMap(blobOids))].sort();
    const blobEntries = named.map((o) => ({ name: o, mode: "100644", type: "blob", oid: parseOid(o) }));
    const root = await repo.mktree([
      { name: "blobs", mode: "040000", type: "tree", oid: await repo.mktree(blobEntries) },
      { name: "records", mode: "040000", type: "tree", oid: await repo.mktree(recordEntries) }
    ]);
    const commit = await repo.commitTree({ tree: root, parents: snap.head === null ? [] : [snap.head], subject: HOLDS_SUBJECT, trailers: [] });
    crashpoint("registry.cas");
    const ok = await repo.casRef(ref, commit, snap.head, HOLDS_SUBJECT);
    if (!ok) {
      log.write("security", CAS_LOST_CODE, { ref, expected: snap.head, commit });
      throw new RegistryCasLostError(`${ref} is no longer at ${snap.head ?? "(absent)"}: a second writer`);
    }
    crashpoint("registry.cas");
    this.cur = { head: commit, records, recordOids };
    return stored;
  }
};

// src/engine/diskEq.ts
import { join as join4 } from "node:path";

// src/engine/stagedRead.ts
import { join as join3 } from "node:path";
function codeOf(e) {
  const code = typeof e === "object" && e !== null ? e.code : void 0;
  return typeof code === "string" && code.length > 0 ? code : "EIO";
}
function isGone(code) {
  return code === "ENOENT" || code === "ENOTDIR";
}
async function stagedRead(fs, abs) {
  let before;
  try {
    before = await fs.lstat(abs);
  } catch (e) {
    return { kind: "unreadable", code: codeOf(e) };
  }
  if (before === null) return { kind: "missing" };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!before.isFile) return { kind: "unreadable", code: before.isDirectory ? "EISDIR" : "ELOOP" };
    let bytes;
    try {
      bytes = await fs.readFile(abs);
    } catch (e) {
      const code = codeOf(e);
      return isGone(code) ? { kind: "missing" } : { kind: "unreadable", code };
    }
    let after;
    try {
      after = await fs.lstat(abs);
    } catch (e) {
      return { kind: "unreadable", code: codeOf(e) };
    }
    if (after === null) return { kind: "missing" };
    if (sameStat(before, after) && bytes.length === after.size) return { kind: "ok", bytes, stat: after };
    before = after;
  }
  return { kind: "unstable" };
}
function checkPath2(path) {
  if (!stageable(path)) throw new Error(`stage: invalid repository path ${JSON.stringify(path)}`);
  return path.split("/");
}
function stageable(path) {
  return validPathSyntax(path) && !path.includes("�") && !path.split("/").some(isDotGitAlias);
}
var StageDir = class {
  root;
  fs;
  constructor(fs, root) {
    this.fs = fs;
    this.root = root;
  }
  abs(path) {
    return join3(this.root, ...checkPath2(path));
  }
  /**
   * Writes the stage copy of path and returns its absolute file. validPathSyntax; every existing component under the
   * root is lstat-checked and a symlink (or junction) is refused, so a write never lands outside the root; a stale
   * file where a directory is now needed (or a stale directory where the copy goes) is replaced.
   */
  async write(path, bytes) {
    const parts = checkPath2(path);
    await this.ensureRoot();
    let dir = this.root;
    for (const c of parts.slice(0, -1)) {
      dir = join3(dir, c);
      const st2 = await this.fs.lstat(dir);
      if (st2 !== null && st2.isSymbolicLink) throw new Error(`stage: refusing a symlinked component ${JSON.stringify(dir)}`);
      if (st2 !== null && !st2.isDirectory) await this.fs.unlink(dir);
      if (st2 === null || !st2.isDirectory) await this.fs.mkdirp(dir, 448);
    }
    const file = join3(dir, parts[parts.length - 1]);
    const st = await this.fs.lstat(file);
    if (st !== null && st.isSymbolicLink) throw new Error(`stage: refusing a symlinked stage copy ${JSON.stringify(file)}`);
    if (st !== null && st.isDirectory) await this.fs.rmrf(file);
    await this.fs.writeFile(file, bytes);
    return file;
  }
  /** Deletes the stage copy (absent is fine); a link is removed, never followed. */
  async remove(path) {
    const file = this.abs(path);
    const st = await this.fs.lstat(file);
    if (st === null || st.isDirectory) return;
    try {
      await this.fs.unlink(file);
    } catch (e) {
      if (!isGone(codeOf(e))) throw e;
    }
  }
  /** Deletes every stage copy (restart, reseed). */
  async clear() {
    await this.fs.rmrf(this.root);
    await this.fs.mkdirp(this.root, 448);
  }
  async ensureRoot() {
    const st = await this.fs.lstat(this.root);
    if (st === null) {
      await this.fs.mkdirp(this.root, 448);
      return;
    }
    if (!st.isDirectory || st.isSymbolicLink) throw new Error(`stage: root ${JSON.stringify(this.root)} is not a directory`);
  }
};

// src/engine/diskEq.ts
var STAGE_TREE_CONFIG = Object.freeze({ "core.fileMode": "false" });
var EQUAL = Object.freeze({ equal: true });
var notEqual = (reason) => ({ equal: false, reason });
var NO_DRIVER = /* @__PURE__ */ new Set(["set", "unset", "unspecified"]);
function sameEntry(a, b) {
  return a.oid === b.oid && a.mode === b.mode;
}
function isGoneError2(e) {
  const code = typeof e === "object" && e !== null ? e.code : void 0;
  return code === "ENOENT" || code === "ENOTDIR";
}
var DiskEq = class {
  d;
  constructor(d) {
    this.d = d;
  }
  workFile(path) {
    return join4(this.d.repo.paths.workTree, ...path.split("/"));
  }
  /**
   * Every entry point refuses first, before any look at the disk: a carried path (P2-CARRY: not stageable, a dotgit
   * alias on every platform, or in the snapshot's carry set) is 'carried'; a filtered path whose driver is over the
   * cap or outside the discovered set (P2-SNAPFILTERS: git would run it without filter.<d>.required=true, and a
   * failing clean filter would let route (b) -w store the raw bytes) is 'filter_failure'. The driver is read with one
   * `check-attr` under the context's attr.tree, only for a path isFiltered names; never cached (a personal attributes
   * file can change it). Public for the writer's creation check (final review minor: a create is refused like a modify).
   */
  async refusal(path) {
    if (!stageable(path) || this.d.isCarried(path)) return "carried";
    if (!this.d.isFiltered(path)) return null;
    const f = this.d.filters;
    if (f.overCap !== null) return "filter_failure";
    let driver;
    try {
      const r = await this.d.repo.run(["check-attr", "-z", "--stdin", "filter"], { class: "attr", stdin: Buffer.concat([Buffer.from(path, "utf8"), Buffer.from([0])]) });
      const v = r.stdout.toString("utf8").split(String.fromCharCode(0))[2] ?? "unspecified";
      driver = NO_DRIVER.has(v) ? null : v;
    } catch (e) {
      if (e instanceof GitCommandError) return "filter_failure";
      throw e;
    }
    return driver === null || f.drivers.includes(driver) ? null : "filter_failure";
  }
  /**
   * ABSENT ⇔ ENOENT; clean stat-cache fast path when x equals sRaw; else one staged read + cmp.index cacheinfo, --work-tree=<tmp/stage> update-index --refresh, diff-files -z (unfiltered) or a route (b) id (filtered). No object. Mutant M18: hash-object --path of the copy compared with x for every path.
   * Refusals first (see refusal): 'carried' or 'filter_failure', without a look at the disk.
   */
  async eq(path, x, sRaw) {
    const refused = await this.refusal(path);
    if (refused !== null) return notEqual(refused);
    if (await this.beneathLink(path)) return notEqual("unreadable");
    const file = this.workFile(path);
    if (x === ABSENT) return this.absentEq(file);
    const ce = this.d.statCache.get(path);
    if (sRaw !== null && sameEntry(x, sRaw) && ce !== void 0 && ce.state === "clean" && ce.stat !== null && ce.missingSinceMono === void 0 && ce.shrink === void 0) {
      let st;
      try {
        st = await this.d.fs.lstat(file);
      } catch {
        return notEqual("unreadable");
      }
      if (st !== null && sameStat(st, ce.stat)) return EQUAL;
    }
    return this.compareRead(path, file, x);
  }
  /** Variant (3): the bytes of `file` (a ring .old) compared as if they were at p (p's attributes and index context). */
  async eqFile(path, file, x) {
    const refused = await this.refusal(path);
    if (refused !== null) return notEqual(refused);
    if (x === ABSENT) return this.absentEq(file);
    return this.compareRead(path, file, x);
  }
  /** MANY CANDIDATES: one staged read, raw blob r written (route (a) into addIndex, or route (b) -w); first c with canon(r, c) == c (unfiltered) or r == c (filtered); ABSENT matches ENOENT. A refusal (see refusal) reads and writes nothing. */
  async manyCandidates(path, candidates, file) {
    const refused = await this.refusal(path);
    if (refused !== null) return { match: null, raw: null, read: refused };
    if (file === void 0 && await this.beneathLink(path)) return { match: null, raw: null, read: "unreadable" };
    const src = file ?? this.workFile(path);
    const r = await stagedRead(this.d.fs, src);
    if (r.kind === "missing") return { match: candidates.includes(ABSENT) ? ABSENT : null, raw: null, read: "missing" };
    if (r.kind !== "ok") return { match: null, raw: null, read: r.kind };
    return this.withCopy(path, r.bytes, async (copy) => {
      const filtered = this.d.isFiltered(path);
      let raw;
      if (filtered) {
        const h = await hashRouteB(this.d.repo, path, copy, true);
        raw = isFilterFailure(h) ? null : h;
      } else {
        raw = await this.addRaw(path);
      }
      if (raw === null) return { match: null, raw: null, read: "ok" };
      const files = candidates.filter((c) => c !== ABSENT && (c.mode === "100644" || c.mode === "100755"));
      if (filtered) return { match: files.find((c) => c.oid === raw) ?? null, raw, read: "ok" };
      if (files.length === 0) return { match: null, raw, read: "ok" };
      const blobs = await this.d.repo.readBlobs([raw, ...files.map((c) => c.oid)]);
      const rBytes = blobs[0];
      const skip = !this.d.isText(path);
      for (let i = 0; i < files.length; i++) {
        const cBytes = blobs[i + 1];
        const res = canon(rBytes, cBytes, skip);
        if (res.ok && res.out.equals(cBytes)) return { match: files[i], raw, read: "ok" };
      }
      return { match: null, raw, read: "ok" };
    });
  }
  /**
   * Final review FB-7 (the read side of P2-NOFOLLOW): an existing ancestor of p below the work-tree root is a symlink, a
   * junction or not a directory (or cannot be lstat'd: fail closed). Such a p is never read: a read would resolve the
   * link and compare (or store) bytes from outside the work tree. A missing ancestor ends the walk (p is absent).
   */
  async beneathLink(path) {
    let dir = this.d.repo.paths.workTree;
    for (const c of path.split("/").slice(0, -1)) {
      dir = join4(dir, c);
      let st;
      try {
        st = await this.d.fs.lstat(dir);
      } catch {
        return true;
      }
      if (st === null) return false;
      if (st.isSymbolicLink || !st.isDirectory) return true;
    }
    return false;
  }
  async absentEq(file) {
    try {
      return await this.d.fs.lstat(file) === null ? EQUAL : notEqual("differs");
    } catch {
      return notEqual("unreadable");
    }
  }
  async compareRead(path, file, x) {
    const r = await stagedRead(this.d.fs, file);
    if (r.kind === "missing") return notEqual("differs");
    if (r.kind === "unstable") return notEqual("unstable");
    if (r.kind === "unreadable") return notEqual("unreadable");
    return this.withCopy(path, r.bytes, async (copy) => {
      try {
        if (this.d.mutants.has("M18") || this.d.isFiltered(path)) {
          const id = await hashRouteB(this.d.repo, path, copy, false);
          if (isFilterFailure(id)) return notEqual("error");
          return id === x.oid ? EQUAL : notEqual("differs");
        }
        return await this.refreshCompare(path, x) ? EQUAL : notEqual("differs");
      } catch {
        return notEqual("error");
      }
    });
  }
  /** tmp/cmp.index holding only X (p's index context); refresh against the stage tree; diff-files -z decides. */
  async refreshCompare(path, x) {
    const indexFile = this.d.cmpIndex;
    await resetScratchIndex(this.d.fs, indexFile);
    await this.d.repo.editIndex(indexFile, [{ path, mode: x.mode, oid: x.oid }]);
    const opts = { indexFile, workTree: this.d.stage.root, config: STAGE_TREE_CONFIG };
    await this.d.repo.run(["update-index", "--refresh"], { ...opts, okCodes: [0, 1] });
    const diff = await this.d.repo.run(["diff-files", "-z", "--name-only"], opts);
    return !diff.stdout.toString("utf8").split("\0").includes(path);
  }
  /**
   * Route (a) into the empty scratch index addIndex: the raw blob git stores for the stage copy (an apply/hold step
   * only). `-f`: in the emptied index p is untracked, so the user's ignore rules (info/exclude, core.excludesFile, a
   * staged .gitignore copy) would otherwise refuse a tracked path with rc 1; the pathspec stays literal.
   */
  async addRaw(path) {
    const indexFile = this.d.addIndex;
    await resetScratchIndex(this.d.fs, indexFile);
    await this.d.repo.run(["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      class: "refupdate",
      indexFile,
      workTree: this.d.stage.root,
      literalPathspecs: true,
      config: STAGE_TREE_CONFIG,
      stdin: Buffer.from(`${path}\0`, "utf8")
    });
    return (await this.d.repo.listIndex(indexFile)).get(path)?.oid ?? null;
  }
  /**
   * Writes the stage copy of path for one comparison, then deletes it, unless the snapshot keeps a dirty copy of p:
   * that copy's bytes (whose id the tick computed and which a materialize must store) are put back as they were.
   */
  async withCopy(path, bytes, fn) {
    let saved = null;
    if (this.d.statCache.get(path)?.state === "dirty") {
      try {
        saved = await this.d.fs.readFile(this.d.stage.abs(path));
      } catch (e) {
        if (!isGoneError2(e)) throw e;
      }
    }
    const copy = await this.d.stage.write(path, bytes);
    try {
      return await fn(copy);
    } finally {
      if (saved !== null) await this.d.stage.write(path, saved);
      else await this.d.stage.remove(path);
    }
  }
};

// src/engine/errors.ts
function isRemoteContentError(e) {
  return e instanceof BoardMalformedError || e instanceof RemoteContentError;
}

// src/git/netcall.ts
var OUTCOME_CODES = Object.freeze(Array.from({ length: 257 }, (_, i) => i - 1));
async function runNetwork(repo, argv2, abort) {
  try {
    return await repo.run([...argv2], { class: "network", okCodes: OUTCOME_CODES, ...abort !== void 0 ? { abort } : {} });
  } catch (e) {
    if (!(e instanceof GitCommandError)) throw e;
    return { code: e.code, stdout: Buffer.alloc(0), stderr: Buffer.from(e.stderrText, "utf8"), killedByWatchdog: false, aborted: false, durationMs: 0 };
  }
}
function checkUrl(what, url) {
  if (typeof url !== "string" || url.length === 0 || url.startsWith("-") || /[\0\r\n]/.test(url)) {
    throw new Error(`${what}: invalid url ${JSON.stringify(url)}`);
  }
}

// src/git/fetch.ts
var LOCAL_PREFIX = "refs/cowork-remote/";
function checkSpecs(specs) {
  if (specs.length === 0) throw new Error("fetchRefs: no refspec");
  const remotes = /* @__PURE__ */ new Set();
  const locals = /* @__PURE__ */ new Set();
  for (const s of specs) {
    checkRefName("fetchRefs", s.remote);
    checkRefName("fetchRefs", s.local);
    if (!s.local.startsWith(LOCAL_PREFIX)) throw new Error(`fetchRefs: destination ${JSON.stringify(s.local)} is outside ${LOCAL_PREFIX}`);
    if (remotes.has(s.remote) || locals.has(s.local)) throw new Error(`fetchRefs: ${s.remote} or ${s.local} named twice`);
    remotes.add(s.remote);
    locals.add(s.local);
  }
}
var fetchArgv = (url, specs) => ["fetch", "--porcelain", url, ...specs.map((s) => `+${s.remote}:${s.local}`)];
var PORCELAIN_LINE = /^(.) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/;
function reachedRefUpdate(r, specs) {
  const locals = new Set(specs.map((s) => s.local));
  return r.stdout.toString("utf8").split("\n").some((line) => {
    const m = PORCELAIN_LINE.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
    return m !== null && locals.has(m[4]);
  });
}
var cutOff = (r) => r.killedByWatchdog || r.aborted;
async function readLocal(repo, locals) {
  const r = await repo.run(["for-each-ref", "--format=%(objectname) %(refname)", ...locals]);
  const wanted = new Set(locals);
  const out = /* @__PURE__ */ new Map();
  for (const line of r.stdout.toString("utf8").split("\n")) {
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const name = line.slice(sp + 1);
    const oid2 = line.slice(0, sp);
    if (wanted.has(name) && isOid(oid2)) out.set(name, oid2);
  }
  return out;
}
function parseLsRemote(stdout, keep) {
  const values = /* @__PURE__ */ new Map();
  for (const raw of stdout.toString("utf8").split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const tab = line.indexOf("	");
    if (tab <= 0) continue;
    const name = line.slice(tab + 1);
    const oid2 = line.slice(0, tab);
    if (keep(name) && !values.has(name) && isOid(oid2)) values.set(name, oid2);
  }
  return values;
}
async function lsRemoteRaw(repo, url, refs, abort) {
  checkUrl("lsRemote", url);
  if (refs.length === 0) throw new Error("lsRemote: no ref");
  for (const ref of refs) checkRefName("lsRemote", ref);
  const r = await runNetwork(repo, ["ls-remote", url, ...refs], abort);
  if (r.code !== 0 || cutOff(r)) return { ok: false, values: /* @__PURE__ */ new Map(), r };
  const wanted = new Set(refs);
  return { ok: true, values: parseLsRemote(r.stdout, (name) => wanted.has(name)), r };
}
async function lsRemote(repo, url, refs) {
  const { ok, values } = await lsRemoteRaw(repo, url, refs);
  return { ok, values };
}
async function lsRemotePrefix(repo, url, prefix) {
  checkUrl("lsRemotePrefix", url);
  if (!prefix.endsWith("/")) throw new Error(`lsRemotePrefix: ${JSON.stringify(prefix)} is no ref directory`);
  checkRefName("lsRemotePrefix", prefix.slice(0, -1));
  const r = await runNetwork(repo, ["ls-remote", url, `${prefix}*`]);
  if (r.code !== 0 || cutOff(r)) return { ok: false, values: /* @__PURE__ */ new Map() };
  return { ok: true, values: parseLsRemote(r.stdout, (name) => name.startsWith(prefix) && name.length > prefix.length) };
}
async function fetchRefs(repo, url, specs, abort) {
  checkUrl("fetchRefs", url);
  checkSpecs(specs);
  const first = await runNetwork(repo, fetchArgv(url, specs), abort);
  const calls = [first];
  let ok = first.code === 0 && !cutOff(first);
  let answered = ok;
  let missing = /* @__PURE__ */ new Set();
  if (!ok && !cutOff(first)) {
    const ls = await lsRemoteRaw(repo, url, specs.map((s) => s.remote), abort);
    calls.push(ls.r);
    if (ls.ok) {
      answered = true;
      missing = new Set(specs.filter((s) => !ls.values.has(s.remote)).map((s) => s.remote));
      const present = specs.filter((s) => ls.values.has(s.remote));
      if (present.length === 0) {
        ok = true;
      } else {
        const again = await runNetwork(repo, fetchArgv(url, present), abort);
        calls.push(again);
        ok = again.code === 0 && !cutOff(again);
        if (cutOff(again) || !ok && !reachedRefUpdate(again, present)) answered = false;
      }
    }
  }
  const local = await readLocal(repo, specs.map((s) => s.local));
  const values = /* @__PURE__ */ new Map();
  for (const s of specs) values.set(s.remote, missing.has(s.remote) ? ABSENT : local.get(s.local) ?? ABSENT);
  return {
    ok,
    remoteAnswered: answered,
    values,
    code: first.code,
    killedByWatchdog: calls.some((c) => c.killedByWatchdog),
    durationMs: calls.reduce((n, c) => n + c.durationMs, 0),
    stderr: Buffer.concat(calls.map((c) => c.stderr))
  };
}

// src/git/httpStatus.ts
var STATUS_RE = /(?:The requested URL returned error: |\bHTTP )(\d{3})(?!\d)/g;
var QUOTED_RE = /'[^']*'/g;
function readHttpThrottle(stderr) {
  let server = false;
  for (const raw of stderr.toString("utf8").split(/\r\n|\r|\n/)) {
    const line = raw.trimStart();
    if (line.startsWith("remote:")) continue;
    for (const m of line.replace(QUOTED_RE, "''").matchAll(STATUS_RE)) {
      const status = Number(m[1]);
      if (status === 429) return "http_429";
      if (status >= 500 && status <= 599) server = true;
    }
  }
  return server ? "http_5xx" : null;
}

// src/engine/fetcher.ts
var FETCH_SPACING_MS = 2500;
var OFFLINE_AFTER_MS = 3e4;
var hex = (v) => v === ABSENT ? null : v;
var Fetcher = class {
  repo;
  url;
  refs;
  clock;
  trace;
  peer;
  impl;
  /** Told of every completed fetch (never a deferred view, an abandoned attempt or a throw): the Engine's observer. */
  onFetched;
  /** Construction (daemon start): the offline clock's origin until the remote first answers. */
  createdMono;
  lastStart = null;
  lastSuccess = null;
  /** The last completion at which the remote answered (ok or a local failure): the offline clock. */
  lastAnswered = null;
  failures = 0;
  backoffUntil = null;
  sawOk = false;
  forceNext = false;
  lastView = null;
  flight = null;
  /** onFetched (Task 17 fix round 1, an addition to the contract's parameters): the Engine's hook on completed fetches. */
  constructor(d) {
    this.repo = d.repo;
    this.url = d.url;
    this.refs = d.refs;
    this.clock = d.clock;
    this.trace = d.trace;
    this.peer = d.peer;
    this.impl = d.impl ?? fetchRefs;
    this.onFetched = d.onFetched ?? null;
    this.createdMono = d.clock.monoMs();
  }
  /**
   * Single flight: during an in-flight fetch, await it; else, if ≥ 2.5 s since the previous start, fetch. Never sleeps
   * (P2-NOSLEEP): inside the spacing or a backoff it returns the last view at once with `deferred: true` (the iteration
   * continues with snapshots and captures, ENG-19); force skips the spacing (never the backoff, never the single flight).
   */
  fetch(force = false) {
    if (this.flight !== null) return this.flight.promise;
    const now = this.clock.monoMs();
    const forced = force || this.forceNext;
    if (this.backoffUntil !== null && now < this.backoffUntil) return Promise.resolve(this.deferredView());
    if (!forced && this.lastStart !== null && now < this.lastStart + FETCH_SPACING_MS) return Promise.resolve(this.deferredView());
    return this.launch();
  }
  /**
   * The human-typed /cowork recover's fetch (01-engine §3.7 Recover step 1: "unless a fetch succeeds now"): it skips the
   * spacing AND the network backoff, never the single flight (a fetch in flight is awaited). Its outcome feeds the backoff
   * and the offline clock like any fetch: a success ends the backoff, a failure extends it.
   */
  fetchNow() {
    if (this.flight !== null) return this.flight.promise;
    return this.launch();
  }
  launch() {
    this.forceNext = false;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const flight2 = { promise, resolve, reject, controller: new AbortController(), abandoned: false };
    this.flight = flight2;
    void this.fly(flight2);
    return promise;
  }
  lastSuccessMono() {
    return this.lastSuccess;
  }
  /** OFFLINE: no answer of the remote for > 30 s of Δmono (a local failure is an answer, P2-FETCHLOCAL). */
  offline() {
    const offlineForMs = Math.max(0, this.clock.monoMs() - (this.lastAnswered ?? this.createdMono));
    return { offline: offlineForMs > OFFLINE_AFTER_MS, offlineForMs };
  }
  /** The earliest start of an unforced fetch: the spacing after the previous start, or the backoff after a network failure. */
  nextAllowedMono() {
    const spaced = this.lastStart === null ? this.createdMono : this.lastStart + FETCH_SPACING_MS;
    return this.backoffUntil === null ? spaced : Math.max(spaced, this.backoffUntil);
  }
  inFlight() {
    return this.flight !== null;
  }
  /**
   * Suspend gap: the in-flight fetch is ABORTED (process tree killed via GitCallOptions.abort) and its result discarded;
   * the next fetch starts only after the aborted process exited (O-FETCH: never two fetches at once). With nothing in
   * flight, the next fetch is forced.
   */
  abandon() {
    const f = this.flight;
    if (f === null) {
      this.forceNext = true;
      return;
    }
    f.abandoned = true;
    f.controller.abort();
  }
  /** Runs attempts until one is not abandoned; an abandoned attempt is waited for (its process exits) before the next. */
  async fly(flight2) {
    for (; ; ) {
      this.lastStart = this.clock.monoMs();
      let result;
      try {
        result = await this.impl(this.repo, this.url, this.refs.fetchSpecs, flight2.controller.signal);
      } catch (e) {
        if (flight2.abandoned) {
          this.restart(flight2);
          continue;
        }
        this.flight = null;
        flight2.reject(e);
        return;
      }
      if (flight2.abandoned) {
        this.restart(flight2);
        continue;
      }
      this.flight = null;
      flight2.resolve(this.complete(result));
      return;
    }
  }
  /** The waiters of an abandoned attempt get a forced one (the spacing is skipped; it ran outside any backoff). */
  restart(flight2) {
    flight2.abandoned = false;
    flight2.controller = new AbortController();
  }
  deferredView() {
    const last = this.lastView;
    if (last === null) {
      return {
        ok: false,
        board: ABSENT,
        code: ABSENT,
        branch: ABSENT,
        completedMono: this.createdMono,
        httpThrottle: null,
        killedByWatchdog: false,
        firstOfRun: false,
        deferred: true,
        localFailure: false
      };
    }
    return { ...last, firstOfRun: false, deferred: true };
  }
  complete(result) {
    const now = this.clock.monoMs();
    const answered = result.ok || result.remoteAnswered;
    if (answered) {
      this.lastAnswered = now;
      this.failures = 0;
      this.backoffUntil = null;
    } else {
      this.failures += 1;
      this.backoffUntil = now + Math.min(NET_BACKOFF_MIN_MS * 2 ** (this.failures - 1), NET_BACKOFF_MAX_MS);
    }
    if (result.ok) this.lastSuccess = now;
    const firstOfRun = result.ok && !this.sawOk;
    if (result.ok) this.sawOk = true;
    const value = (ref) => result.values.get(ref) ?? ABSENT;
    const view = {
      ok: result.ok,
      board: value(this.refs.remoteBoard),
      code: value(this.refs.remoteCode),
      branch: value(this.refs.remoteBranch),
      completedMono: now,
      httpThrottle: readHttpThrottle(result.stderr),
      killedByWatchdog: result.killedByWatchdog,
      firstOfRun,
      deferred: false,
      localFailure: !result.ok && answered
    };
    this.lastView = view;
    this.trace.emit({ kind: "fetch", peer: this.peer, ok: view.ok, board: hex(view.board), code: hex(view.code), branch: hex(view.branch) });
    this.onFetched?.(view);
    return view;
  }
};

// src/engine/incident.ts
var BASE_KEY2 = "Cowork-Base";
var lastVerified = /* @__PURE__ */ new WeakMap();
async function firstParentRange(repo, old, next) {
  parseOid(old);
  parseOid(next);
  if (old === next) return [];
  const r = await repo.run(["rev-list", "--first-parent", "--no-commit-header", "--format=%H %P", next, `^${old}`]);
  const range = [];
  let oldestParent;
  for (const line of r.stdout.toString("utf8").split("\n")) {
    const words = line.split(" ").filter((w) => w.length > 0);
    if (words.length === 0) continue;
    range.push(parseOid(words[0]));
    oldestParent = words[1];
  }
  if (range.length === 0 || range[0] !== next) return null;
  return oldestParent === old ? range : null;
}
async function fpOk(repo, old, next) {
  return await firstParentRange(repo, old, next) !== null;
}
async function incidentCheck(repo, laB, laC, T, mutants) {
  if (mutants.has("M07")) return { ok: true };
  parseOid(laB);
  parseOid(laC);
  if (T === ABSENT) return { ok: false, why: "board_missing", observedBoard: null, observedCode: null };
  if (parseOid(T) === laB) return { ok: true };
  const last = lastVerified.get(repo);
  if (last !== void 0 && last.laB === laB && last.laC === laC && last.T === T) return { ok: true };
  const verdict = await check2(repo, laB, laC, T);
  if (verdict.ok) lastVerified.set(repo, { laB, laC, T });
  return verdict;
}
async function check2(repo, laB, laC, T) {
  const fail3 = (why, observedCode) => ({ ok: false, why, observedBoard: T, observedCode });
  const [t, b] = await checkBoardCommits(repo, [T, laB]);
  if (t.commit === null || t.refused !== null) return fail3("board_shape", null);
  if (b.commit === null || b.refused !== null) throw new Error(`incidentCheck: LA_B ${laB} is not a readable board commit (${b.refused ?? "unknown"})`);
  const tip = lastParent(t.commit.parents);
  const range = await firstParentRange(repo, laB, T);
  if (range === null) return fail3("board_not_ff", tip);
  if (!await fpOk(repo, laC, tip)) return fail3("code_not_ff", tip);
  const chain = [...range].reverse();
  const below = chain.slice(0, -1);
  const boards = [...below.length > 0 ? await checkBoardCommits(repo, below) : [], t];
  let bad = chain.length;
  let prevBoard = laB;
  for (let i = 0; i < chain.length; i++) {
    const c = boards[i];
    if (c.commit === null || c.refused !== null || !boardShapeOk(c.commit, prevBoard)) {
      bad = i;
      break;
    }
    prevBoard = chain[i];
  }
  const steps = [];
  let prevLive = lastParent(b.commit.parents);
  for (let i = 0; i < bad; i++) {
    const live = lastParent(boards[i].commit.parents);
    steps.push({ prev: prevLive, live });
    prevLive = live;
  }
  const toRead = [...new Set(steps.filter((s) => s.live !== s.prev).map((s) => s.live))];
  const lives = new Map(toRead.map((o, k) => [o, k]));
  const read = await readCommitsChecked(repo, toRead);
  for (const s of steps) {
    if (s.live === s.prev) continue;
    const c = read[lives.get(s.live)];
    if (c.commit === null || liveShape(c.commit, s.prev) === null) return fail3("live_shape", tip);
  }
  return bad < chain.length ? fail3("board_shape", tip) : { ok: true };
}
function lastParent(parents) {
  const p = parents[parents.length - 1];
  if (p === void 0) throw new Error("incidentCheck: a board commit without parents passed the check");
  return p;
}
var lastBase = /* @__PURE__ */ new WeakMap();
var BASE_LINE = new RegExp(`^${BASE_KEY2}: `, "m");
function baseRecords(stdout) {
  return stdout.toString("utf8").split("\0").slice(1).map((record) => {
    const nl1 = record.indexOf("\n");
    const nl2 = nl1 < 0 ? -1 : record.indexOf("\n", nl1 + 1);
    if (nl2 < 0) throw new Error(`liveBase: unexpected rev-list output ${JSON.stringify(record.slice(0, 120))}`);
    const parents = record.slice(nl1 + 1, nl2).split(" ").filter((p) => p.length > 0).map((p) => parseOid(p));
    return { oid: parseOid(record.slice(0, nl1)), parents, body: record.slice(nl2 + 1) };
  });
}
function baseOf(r) {
  if (!BASE_LINE.test(r.body)) return null;
  const bases = parseMessage(r.body).trailers.filter((t) => t.key === BASE_KEY2);
  if (bases.length === 0) return null;
  if (bases.length !== 1) throw new RemoteContentError(`liveBase: ${r.oid} carries ${bases.length} ${BASE_KEY2} trailers`);
  const value = bases[0].value;
  if (!isOid(value)) throw new RemoteContentError(`liveBase: ${r.oid} carries a ${BASE_KEY2} trailer that is no oid`);
  const base = parseOid(value);
  if (!(r.parents.length === 0 || r.parents.length === 2 && r.parents[1] === base)) {
    throw new RemoteContentError(`liveBase: ${r.oid} is neither a genesis nor a base move`);
  }
  return { base, introducedBy: r.oid };
}
async function fullWalk(repo, L) {
  const r = await repo.run(["rev-list", "--first-parent", "--no-commit-header", `--grep=^${BASE_KEY2}: `, "--format=%x00%H%n%P%n%B", L]);
  for (const record of baseRecords(r.stdout)) {
    const found = baseOf(record);
    if (found !== null) return found;
  }
  throw new RemoteContentError(`liveBase: no ${BASE_KEY2} trailer on the first-parent chain of ${L}`);
}
async function sinceLast(repo, L, last) {
  const r = await repo.run(["rev-list", "--first-parent", "--no-commit-header", "--format=%x00%H%n%P%n%B", L, `^${last.tip}`], { okCodes: [0, 128] });
  if (r.code === 128) return null;
  const records = baseRecords(r.stdout);
  const oldest = records[records.length - 1];
  if (oldest === void 0 || records[0].oid !== L || oldest.parents[0] !== last.tip) return null;
  for (const record of records) {
    const found = baseOf(record);
    if (found !== null) return found;
  }
  return { base: last.base, introducedBy: last.introducedBy };
}
async function liveBase(repo, L) {
  parseOid(L);
  const last = lastBase.get(repo);
  if (last !== void 0 && last.tip === L) return { base: last.base, introducedBy: last.introducedBy };
  const found = (last !== void 0 ? await sinceLast(repo, L, last) : null) ?? await fullWalk(repo, L);
  lastBase.set(repo, { tip: L, base: found.base, introducedBy: found.introducedBy });
  return { base: found.base, introducedBy: found.introducedBy };
}

// src/git/enc.ts
import { Buffer as Buffer3 } from "node:buffer";
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
  for (const b of Buffer3.from(branch, "utf8")) {
    out += isUnreservedByte(b) ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0");
    if (out.length > ENC_MAX_BYTES) {
      throw new EncTooLongError(`enc: the encoded branch name exceeds ${ENC_MAX_BYTES} bytes`);
    }
  }
  return out;
}

// src/engine/meta.ts
var MetaTooNewError = class extends Error {
  /** The newer meta.json's `v` (START_STATE_NEWER{meta_v}); null when the caller did not read one. */
  metaV;
  constructor(message, metaV = null) {
    super(message);
    this.name = "MetaTooNewError";
    this.metaV = metaV;
  }
};
var META_V = 1;
var DISPLACED_CAP = 3;
var FREEZE_REASONS = new Set(Object.keys({ EPOCH: 1, MASS: 1, PAUSED: 1, INCIDENT: 1, CONFIG: 1, NOHOOKS: 1 }));
var CONFIG_DETAILS = new Set(Object.keys({ url: 1, identity: 1, filter: 1, public: 1 }));
var THROTTLE_SIGNALS = new Set(Object.keys({ http_429: 1, http_5xx: 1, slow_push: 1, rejection_streak: 1 }));
var DEFER_REASONS = new Set(Object.keys({
  fence: 1,
  read_lease: 1,
  txn: 1,
  unreadable: 1,
  unstable: 1,
  conflicted_leased: 1,
  eol_form: 1,
  local_only_conflict: 1,
  disk_low: 1,
  locked: 1,
  mismatch: 1,
  race: 1,
  closure: 1,
  filter_failure: 1,
  collision: 1,
  unmaterializable: 1,
  quarantine: 1
}));
var META_KEYS = [
  "v",
  "proto",
  "peer_id",
  "epoch",
  "seq_next",
  "branch",
  "enc",
  "pinned",
  "H_adopt",
  "EPOCH_BASE",
  "expected_epoch",
  "freeze_reasons",
  "config_detail",
  "incident",
  "nonretryable",
  "rejections",
  "throttle",
  "pending",
  "displaced",
  "fold_board",
  "fold_verified",
  "checkpoint_mismatch",
  "outbox",
  "cs_human_next",
  "incident_next"
];
var MetaFormatError = class extends Error {
  constructor(what) {
    super(`meta.json: ${what}`);
    this.name = "MetaFormatError";
  }
};
function isObj4(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function obj(v, keys3, what) {
  if (!isObj4(v)) throw new MetaFormatError(`${what} is not an object`);
  const have = Object.keys(v).sort();
  const want = [...keys3].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
    throw new MetaFormatError(`${what} has keys [${have.join(", ")}], expected [${want.join(", ")}]`);
  }
  return v;
}
function int2(v, min, what) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) throw new MetaFormatError(`${what} must be a safe integer >= ${min}`);
}
function oid(v, what) {
  if (!isOid(v)) throw new MetaFormatError(`${what} must be an object id`);
}
function oidOrNull(v, what) {
  if (v !== null) oid(v, what);
}
function str(v, what, nonEmpty = false) {
  if (typeof v !== "string" || nonEmpty && v.length === 0) throw new MetaFormatError(`${what} must be a${nonEmpty ? " non-empty" : ""} string`);
}
function members(v, allowed, what, max = Infinity) {
  if (!Array.isArray(v) || v.length > max) throw new MetaFormatError(`${what} must be an array${max < Infinity ? ` of at most ${max}` : ""}`);
  if (!v.every(allowed)) throw new MetaFormatError(`${what} has an invalid member`);
  if (new Set(v).size !== v.length) throw new MetaFormatError(`${what} has a duplicate member`);
}
function checkV1(m) {
  obj(m, META_KEYS, "meta");
  if (m["proto"] !== 1) throw new MetaFormatError("proto must be 1");
  if (typeof m["peer_id"] !== "string" || !validId("hex128", m["peer_id"])) throw new MetaFormatError("peer_id must be 32 lowercase hex");
  if (typeof m["epoch"] !== "string" || !validId("hex128", m["epoch"])) throw new MetaFormatError("epoch must be 32 lowercase hex");
  int2(m["seq_next"], 1, "seq_next");
  str(m["branch"], "branch", true);
  str(m["enc"], "enc", true);
  let e;
  try {
    e = enc(m["branch"]);
  } catch {
    throw new MetaFormatError("branch cannot be encoded");
  }
  if (m["enc"] !== e) throw new MetaFormatError("enc is not enc(branch)");
  const pinned = obj(m["pinned"], ["url", "identity"], "pinned");
  str(pinned["url"], "pinned.url", true);
  members(pinned["identity"], isOid, "pinned.identity");
  oid(m["H_adopt"], "H_adopt");
  oid(m["EPOCH_BASE"], "EPOCH_BASE");
  const ee = obj(m["expected_epoch"], ["symref", "head", "stash"], "expected_epoch");
  str(ee["symref"], "expected_epoch.symref");
  oid(ee["head"], "expected_epoch.head");
  oidOrNull(ee["stash"], "expected_epoch.stash");
  members(m["freeze_reasons"], (x) => typeof x === "string" && FREEZE_REASONS.has(x), "freeze_reasons");
  members(m["config_detail"], (x) => typeof x === "string" && CONFIG_DETAILS.has(x), "config_detail");
  if (m["incident"] !== null) {
    const inc = obj(m["incident"], ["n", "observed_board", "observed_code"], "incident");
    int2(inc["n"], 1, "incident.n");
    oidOrNull(inc["observed_board"], "incident.observed_board");
    oidOrNull(inc["observed_code"], "incident.observed_code");
  }
  if (m["nonretryable"] !== null) {
    const nr = obj(m["nonretryable"], ["lease", "hold_id"], "nonretryable");
    oid(nr["lease"], "nonretryable.lease");
    if (typeof nr["hold_id"] !== "string" || !validId("ulid", nr["hold_id"])) throw new MetaFormatError("nonretryable.hold_id must be a ULID");
  }
  if (m["rejections"] !== null) {
    const rj = obj(m["rejections"], ["lease", "n"], "rejections");
    oid(rj["lease"], "rejections.lease");
    int2(rj["n"], 1, "rejections.n");
  }
  if (m["throttle"] !== null) {
    const th = obj(m["throttle"], ["signal"], "throttle");
    if (typeof th["signal"] !== "string" || !THROTTLE_SIGNALS.has(th["signal"])) throw new MetaFormatError("throttle.signal is not a throttle signal");
  }
  const pending = m["pending"];
  if (!isObj4(pending)) throw new MetaFormatError("pending is not an object");
  for (const [p, reason] of Object.entries(pending)) {
    if (!validPathSyntax(p)) throw new MetaFormatError(`pending path ${JSON.stringify(p)} is not a valid path`);
    if (typeof reason !== "string" || !DEFER_REASONS.has(reason)) throw new MetaFormatError(`pending reason of ${JSON.stringify(p)} is not a defer reason`);
  }
  members(m["displaced"], (x) => typeof x === "string" && /^[0-9a-f]{12}$/.test(x), "displaced", DISPLACED_CAP);
  oidOrNull(m["fold_board"], "fold_board");
  if (m["fold_verified"] !== null) {
    const fv = obj(m["fold_verified"], ["board", "height"], "fold_verified");
    oid(fv["board"], "fold_verified.board");
    int2(fv["height"], 0, "fold_verified.height");
  }
  if (typeof m["checkpoint_mismatch"] !== "boolean") throw new MetaFormatError("checkpoint_mismatch must be a boolean");
  int2(m["cs_human_next"], 1, "cs_human_next");
  int2(m["incident_next"], 1, "incident_next");
}
function parseMeta(buf) {
  let v;
  try {
    v = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new MetaFormatError("not JSON");
  }
  if (!isObj4(v)) throw new MetaFormatError("not an object");
  const ver = v["v"];
  if (typeof ver === "number" && Number.isSafeInteger(ver) && ver > META_V) {
    throw new MetaTooNewError(`meta.json: meta_v ${ver} is newer than ${META_V}`, ver);
  }
  if (ver !== META_V) throw new MetaFormatError(`v must be ${META_V}`);
  checkV1(v);
  let canonical;
  try {
    canonical = canonicalBytes(v);
  } catch {
    throw new MetaFormatError("not serializable as canonical JSON");
  }
  if (!canonical.equals(buf)) throw new MetaFormatError("bytes are not canonical JSON");
  return v;
}
function serializeMeta(m) {
  const buf = canonicalBytes(m);
  parseMeta(buf);
  return buf;
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

// src/engine/snapshot.ts
import { join as join5 } from "node:path";

// src/engine/treeDiff.ts
function sameTreeEntry(a, b) {
  return a === void 0 ? b === void 0 : b !== void 0 && a.oid === b.oid && a.mode === b.mode;
}
var isRegularEntry = (e) => e !== void 0 && (e.mode === "100644" || e.mode === "100755");
function diffPaths(x, y) {
  const out = [];
  for (const [p, e] of x) if (!sameTreeEntry(e, y.get(p))) out.push(p);
  for (const p of y.keys()) if (!x.has(p)) out.push(p);
  return out.sort();
}

// src/engine/treeEdit.ts
var INDEX_ONLY = Object.freeze({ "core.protectNTFS": "false", "core.untrackedCache": "false" });
var PATHSPEC_BYTES_MAX = 16384;
var IndexRefusedPathError = class extends GitCommandError {
  paths;
  constructor(argv2, code, stderr, paths) {
    super(argv2, code, stderr);
    this.name = "IndexRefusedPathError";
    this.paths = [...paths].sort();
    this.message = `git refused to index ${this.paths.length} path(s): ${this.paths.slice(0, 5).map((p) => JSON.stringify(p)).join(", ")}`;
  }
};
function hasDrivePrefix(path) {
  const b = Buffer.from(path, "utf8");
  if (b.length < 2 || b[0] === 0) return false;
  if ((b[0] & 128) === 0) return b[1] === 58;
  let i = 1;
  while (i < 4 && i < b.length && (b[i] & 128) !== 0) i++;
  return b[i] === 58;
}
function editsBetween(from, to) {
  return diffPaths(from, to).map((p) => {
    const e = to.get(p);
    return e === void 0 ? { path: p, remove: true } : { path: p, mode: e.mode, oid: e.oid };
  });
}
async function verifyIndexEdits(repo, index, edits, config, argv2) {
  if (edits.length === 0) return;
  const want = /* @__PURE__ */ new Map();
  for (const e of edits) want.set(e.path, e);
  const paths = [...want.keys()];
  const specBytes = paths.reduce((n, p) => n + Buffer.byteLength(p, "utf8") + 1, 0);
  const whole = ["ls-files", "-s", "-z"];
  let r;
  if (specBytes <= PATHSPEC_BYTES_MAX && !paths.some(hasDrivePrefix)) {
    r = await repo.run([...whole, "--", ...paths], { indexFile: index, config, literalPathspecs: true, okCodes: [0, 128] });
    if (r.code !== 0) r = null;
  }
  r ??= await repo.run(whole, { indexFile: index, config });
  const have = /* @__PURE__ */ new Map();
  for (const rec of r.stdout.toString("utf8").split("\0")) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf("	");
    const meta = tab < 0 ? [] : rec.slice(0, tab).split(" ");
    if (meta.length !== 3) throw new Error(`ls-files: unexpected record ${JSON.stringify(rec.slice(0, 120))}`);
    if (meta[2] !== "0") continue;
    const p = rec.slice(tab + 1);
    if (want.has(p)) have.set(p, { mode: meta[0], oid: meta[1] });
  }
  const missed = [];
  for (const [p, e] of want) {
    const h = have.get(p);
    if ("remove" in e ? h !== void 0 : h === void 0 || h.mode !== e.mode || h.oid !== e.oid) missed.push(p);
  }
  if (missed.length > 0) throw new IndexRefusedPathError(argv2, 0, Buffer.alloc(0), missed);
}
async function readTreeIndexOnly(repo, tree2, index, config = INDEX_ONLY) {
  try {
    await repo.run(["read-tree", parseOid(tree2)], { class: "refupdate", indexFile: index, config });
  } catch (e) {
    if (!(e instanceof GitCommandError) || e instanceof IndexRefusedPathError) throw e;
    const refused = await refusedRootNames(repo, tree2).catch(() => []);
    if (refused.length === 0) throw e;
    throw new IndexRefusedPathError(e.argv, e.code, Buffer.from(e.stderrText, "utf8"), refused);
  }
}
async function refusedRootNames(repo, tree2) {
  const r = await repo.run(["ls-tree", "-z", parseOid(tree2)]);
  const out = [];
  for (const rec of r.stdout.toString("utf8").split("\0")) {
    const tab = rec.indexOf("	");
    if (tab < 0) continue;
    const name = rec.slice(tab + 1);
    if (hasDrivePrefix(name)) out.push(name);
  }
  return out;
}
async function editIndexOnly(repo, index, edits, oidLength) {
  if (edits.length === 0) return;
  const zero = "0".repeat(oidLength);
  const lines = edits.map((e) => "remove" in e ? `0 ${zero}	${e.path}\0` : `${e.mode} ${parseOid(e.oid)}	${e.path}\0`).join("");
  const argv2 = ["update-index", "--add", "--replace", "-z", "--index-info"];
  await repo.run(argv2, { class: "refupdate", indexFile: index, config: INDEX_ONLY, stdin: Buffer.from(lines, "utf8") });
  await verifyIndexEdits(repo, index, edits, INDEX_ONLY, argv2);
}
async function editTreeIndexOnly(repo, fs, base, edits, index) {
  if (edits.length === 0) return base;
  await resetScratchIndex(fs, index);
  await readTreeIndexOnly(repo, base, index);
  await editIndexOnly(repo, index, edits, base.length);
  const r = await repo.run(["write-tree"], { indexFile: index, config: INDEX_ONLY });
  return parseOid(r.stdout.toString("utf8"));
}

// src/engine/snapshot.ts
var QUIET_MS = 300;
var DELETE_CONFIRM_MS = 1e3;
var SHRINK_RATIO = 0.5;
var SHRINK_STABLE_MS = 1e3;
var UNTRACKED_RESCAN_MS = 3e4;
var SPECIAL = /* @__PURE__ */ new Set(["160000", "120000"]);
var FILE_MODES3 = /* @__PURE__ */ new Set(["100644", "100755", "120000", "160000"]);
var NO_OTHERS = /* @__PURE__ */ new Set();
var PRIVATE_INDEX_CONFIG = Object.freeze({ "core.untrackedCache": "false" });
var INDEX_ONLY_CONFIG = Object.freeze({ "core.untrackedCache": "false", "core.protectNTFS": "false" });
function tryGet(a, p) {
  try {
    return a.get(p);
  } catch {
    return void 0;
  }
}
function sameDirty(a, b) {
  if (a === void 0 || b === void 0) return a === b;
  return a.kind === b.kind && a.mode === b.mode && a.id === b.id;
}
function parentDirs(path, out) {
  out.add("");
  const bare2 = path.endsWith("/") ? path.slice(0, -1) : path;
  let slash = bare2.indexOf("/");
  while (slash >= 0) {
    out.add(bare2.slice(0, slash));
    slash = bare2.indexOf("/", slash + 1);
  }
}
function sameOrBothNull(a, b) {
  return a === null || b === null ? a === b : sameStat(a, b);
}
function diskMode(st, entry, fileMode) {
  if (!fileMode) return entry?.mode ?? "100644";
  return (st.mode & 64) !== 0 ? "100755" : "100644";
}
function gitBool(v, dflt) {
  if (v === void 0) return dflt;
  const s = v.trim().toLowerCase();
  if (s === "" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "no" || s === "off") return false;
  return /^-?\d+$/.test(s) ? Number(s) !== 0 : dflt;
}
function caseCollisions(paths) {
  const fold = (x) => x.normalize("NFC").toUpperCase().toLowerCase();
  const add = (m, spelling) => {
    const k = fold(spelling);
    let s = m.get(k);
    if (s === void 0) m.set(k, s = /* @__PURE__ */ new Set());
    s.add(spelling);
  };
  const otherSpelling = (m, spelling) => {
    for (const s of m.get(fold(spelling)) ?? []) if (s !== spelling) return true;
    return false;
  };
  const files = /* @__PURE__ */ new Map();
  const dirs = /* @__PURE__ */ new Map();
  for (const p of paths) {
    add(files, p);
    for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) add(dirs, p.slice(0, i));
  }
  const out = /* @__PURE__ */ new Set();
  for (const p of paths) {
    let hit = otherSpelling(files, p) || otherSpelling(dirs, p);
    for (let i = p.indexOf("/"); !hit && i >= 0; i = p.indexOf("/", i + 1)) hit = otherSpelling(files, p.slice(0, i));
    if (hit) out.add(p);
  }
  return out;
}
function carriedAlone(path, windows) {
  if (!stageable(path)) return true;
  if (!windows) return false;
  const r = portable(path, NO_OTHERS);
  return !r.ok && r.rule !== 3;
}
function requireATree(inp) {
  parseOid(inp.aTree);
}
function rawIndexLine(mode, oid2, path) {
  return Buffer.concat([Buffer.from(`${mode} ${oid2}	`, "utf8"), path, Buffer.from([0])]);
}
function rawEntries(out, form2, keys3) {
  const res = [];
  for (let pos = 0; pos < out.length; ) {
    const end = out.indexOf(0, pos);
    const rec = out.subarray(pos, end < 0 ? out.length : end);
    pos = end < 0 ? out.length : end + 1;
    if (rec.length === 0) continue;
    const tab = rec.indexOf(9);
    const meta = (tab < 0 ? "" : rec.toString("latin1", 0, tab)).split(" ");
    const mode = meta[0] ?? "";
    const oid2 = form2 === "index" ? meta[1] : meta[2];
    if (tab < 0 || meta.length !== 3 || !FILE_MODES3.has(mode) || !isOid(oid2)) throw new Error(`${form2 === "index" ? "ls-files" : "ls-tree"}: unexpected record`);
    if (form2 === "index" && meta[2] !== "0") continue;
    const raw = Buffer.from(rec.subarray(tab + 1));
    const key = raw.toString("utf8");
    if (keys3.has(key)) res.push({ key, raw, mode, oid: oid2 });
  }
  return res;
}
var Snapshotter = class {
  d;
  attrs;
  dirty = /* @__PURE__ */ new Map();
  /** Future-mtime paths waiting for QUIET_MS of unchanged stat (Δmono). */
  future = /* @__PURE__ */ new Map();
  index = null;
  listing = null;
  detectKey = null;
  lastMat = null;
  /** core.fileMode (never on Windows) and core.ignorecase, read once. */
  info = null;
  /** The P2-CARRY set, recomputed when the private index map or A is a new object. */
  carry = null;
  /** tipCollisions' last answer, per TIP map object. */
  tipColl = null;
  constructor(d) {
    this.d = d;
    this.attrs = new AttrCache(d.repo, d.fs);
  }
  last() {
    return this.lastMat;
  }
  /**
   * Task 9 addition (P2-CARRY for DiskEqDeps.isCarried): p is in the carry set of the last tick or materialize, or
   * carried by its name alone (not stageable, a dotgit alias, not creatable on this OS). Before the first tick only
   * the name causes are known: a case collision needs A ∪ the private index.
   */
  isCarried(path) {
    return (this.carry?.set.has(path) ?? false) || carriedAlone(path, this.windows());
  }
  /**
   * Final review (ledger Task 13:234): on a case-insensitive volume (core.ignorecase), the paths of `tip` that share one
   * disk entry with another spelling inside `tip` itself (Foo + foo from a teammate on a case-sensitive OS, or an NFC
   * pair): no write can give each its own file (the second create fails EEXIST), so the apply treats them as not
   * applicable 'unmaterializable' instead of deferring their whole change-set race forever. TIP-internal only: A ∪ TIP
   * would wedge every case-only rename (README.md → readme.md). Memoized per map object.
   */
  async tipCollisions(tip) {
    if (this.tipColl !== null && this.tipColl.tip === tip) return this.tipColl.set;
    const set = (await this.fsInfo()).ignoreCase ? caseCollisions(new Set(tip.keys())) : NO_OTHERS;
    this.tipColl = { tip, set };
    return set;
  }
  /** After a verified write (round trip): p's disk bytes are `id`, and its stat is `stat`. */
  markClean(path, stat, id) {
    this.d.statCache.set(path, { stat, id, state: "clean" });
    this.dirty.delete(path);
    this.future.delete(path);
  }
  /** read-tree into the private index; stat cache and stage dir emptied. */
  async reseed(tree2) {
    await this.readTreeInto(this.d.privateIndex, tree2);
    this.d.statCache.clear();
    await this.d.stage.clear();
    this.dirty.clear();
    this.future.clear();
    this.index = null;
    this.listing = null;
    this.detectKey = null;
    this.lastMat = null;
    this.carry = null;
  }
  /** Steps 1–6: a detection tick; writes no object (route (a) does not run; routes (b)/(c) without -w). */
  async tick(inp) {
    requireATree(inp);
    const { fs, statCache } = this.d;
    const now = this.d.clock.monoMs();
    const wall = this.d.clock.wallMs();
    const before = new Map(this.dirty);
    const excluded = /* @__PURE__ */ new Map();
    const notAdmitted = /* @__PURE__ */ new Map();
    let failed = false;
    let publishBlocked = false;
    const index = await this.loadIndex();
    const info = await this.fsInfo();
    const carried = this.carriedPaths(index, inp.A, info);
    for (const p of carried) if (this.dirty.has(p) || statCache.get(p) !== void 0) await this.forget(p);
    const listed = await this.untracked(index, now, carried);
    if (listed === null) failed = true;
    const untracked = (listed ?? this.listing?.entries ?? []).filter((p) => !index.has(p));
    const untrackedSet = new Set(untracked);
    const dirs = /* @__PURE__ */ new Map();
    const trackedCands = [];
    for (const [p, entry] of index) {
      if (inp.skip.has(p) || carried.has(p)) continue;
      let st;
      try {
        st = await fs.lstat(this.workFile(p));
      } catch {
        this.endAbsence(p);
        excluded.set(p, "unreadable");
        continue;
      }
      if (st !== null && st.isDirectory) st = null;
      if (st !== null) this.endAbsence(p);
      if (this.unchanged(p, st)) continue;
      if (await this.beneathLink(p, dirs)) {
        this.endAbsence(p);
        excluded.set(p, "unreadable");
        continue;
      }
      trackedCands.push({ path: p, entry, st });
    }
    const newCands = [];
    for (const p of untracked) {
      if (inp.skip.has(p) || carried.has(p)) continue;
      if (p.endsWith("/")) {
        newCands.push({ path: p, st: null });
        continue;
      }
      if (!stageable(p)) {
        notAdmitted.set(p, "portability");
        if (this.dirty.has(p)) await this.forget(p);
        continue;
      }
      if (await this.beneathLink(p, dirs)) {
        if (this.dirty.get(p)?.kind === "new") await this.drop(p);
        excluded.set(p, "unreadable");
        continue;
      }
      let st;
      try {
        st = await fs.lstat(this.workFile(p));
      } catch {
        excluded.set(p, "unreadable");
        continue;
      }
      if (st === null) {
        if (this.dirty.get(p)?.kind === "new") await this.drop(p);
        continue;
      }
      newCands.push({ path: p, st });
    }
    for (const [p, de] of [...this.dirty]) {
      if (de.kind === "new" && !index.has(p) && !untrackedSet.has(p)) await this.drop(p);
    }
    const attrOf = await this.attrLookup(inp, [...trackedCands.map((c) => c.path), ...newCands.filter((c) => !c.path.endsWith("/")).map((c) => c.path)]);
    const scope2 = { ...inp.scope, attrs: { epochBase: inp.epochBase, get: attrOf } };
    const removed = new Set([...this.dirty].filter(([, de]) => de.kind === "remove").map(([p]) => p));
    const others = /* @__PURE__ */ new Set([...[...index.keys()].filter((p) => !removed.has(p)), ...untracked]);
    const toRead = [];
    for (const c of trackedCands) {
      const sc = scopeOfTracked(c.path, c.entry.mode, c.st?.size ?? 0, scope2);
      if (sc.cls === "UNMANAGED") continue;
      if (this.filterRefused(attrOf(c.path))) {
        excluded.set(c.path, "filter_failure");
        publishBlocked = true;
        continue;
      }
      if (c.st === null) {
        await this.missing(c.path, c.entry, now, excluded);
        continue;
      }
      if (this.quiet(c.path, c.st, now, wall)) {
        excluded.set(c.path, "quiet");
        continue;
      }
      toRead.push({ path: c.path, entry: c.entry, st: c.st });
    }
    for (const c of newCands) {
      const sc = admitNew(c.path, c.st?.size ?? 0, c.st?.isSymbolicLink ?? false, others, scope2);
      if (sc.cls !== "LIVE") {
        notAdmitted.set(c.path, sc.reason ?? "quarantine");
        if (this.dirty.get(c.path)?.kind === "new") await this.drop(c.path);
        continue;
      }
      const st = c.st;
      if (this.unchanged(c.path, st)) continue;
      if (this.quiet(c.path, st, now, wall)) {
        excluded.set(c.path, "quiet");
        continue;
      }
      if (this.filterRefused(attrOf(c.path))) {
        excluded.set(c.path, "filter_failure");
        publishBlocked = true;
        continue;
      }
      toRead.push({ path: c.path, entry: null, st });
    }
    const ok = [];
    for (const c of toRead) {
      const r = await stagedRead(fs, this.workFile(c.path));
      if (r.kind === "ok") {
        ok.push({ ...c, bytes: r.bytes, stat: r.stat, filtered: attrOf(c.path).filter !== null, mode: diskMode(r.stat, c.entry, info.fileMode) });
      } else if (r.kind === "missing") {
        if (c.entry !== null) await this.missing(c.path, c.entry, now, excluded);
      } else {
        excluded.set(c.path, r.kind);
      }
    }
    const refSizes = await this.referenceSizes(ok);
    const staged = [];
    for (const c of ok) {
      if (this.shrinkHeld(c, refSizes.get(c.path) ?? null, now)) {
        excluded.set(c.path, "shrink");
        continue;
      }
      await this.d.stage.write(c.path, c.bytes);
      staged.push(c);
    }
    const U = staged.filter((c) => c.entry !== null && !c.filtered);
    const F = staged.filter((c) => c.entry !== null && c.filtered);
    const N = staged.filter((c) => c.entry === null);
    if (U.length > 0) {
      const differ = await this.differing(U.map((c) => c.entry), inp);
      if (differ === null) {
        failed = true;
      } else {
        for (const c of U) {
          const e = c.entry;
          if (!differ.has(c.path)) {
            if (c.mode === e.mode) await this.clean(c);
            else this.markDirty(c, { kind: "modify", mode: c.mode, id: e.oid });
            continue;
          }
          const id = await hashRouteB(this.d.repo, c.path, this.d.stage.abs(c.path), false);
          if (isFilterFailure(id)) {
            excluded.set(c.path, "unreadable");
            await this.discardCopy(c.path);
            continue;
          }
          this.markDirty(c, { kind: "modify", mode: c.mode, id });
        }
      }
    }
    for (const c of F) {
      const id = await hashRouteB(this.d.repo, c.path, this.d.stage.abs(c.path), false);
      if (isFilterFailure(id)) {
        excluded.set(c.path, "filter_failure");
        publishBlocked = true;
        await this.discardCopy(c.path);
        continue;
      }
      const e = c.entry;
      if (id === e.oid && c.mode === e.mode) await this.clean(c);
      else this.markDirty(c, { kind: "modify", mode: c.mode, id });
    }
    for (const c of N) {
      const id = await hashNewPath(this.d.repo, c.path, this.d.stage.abs(c.path), false);
      if (isFilterFailure(id)) {
        excluded.set(c.path, c.filtered ? "filter_failure" : "unreadable");
        if (c.filtered) publishBlocked = true;
        await this.discardCopy(c.path);
        continue;
      }
      this.markDirty(c, { kind: "new", mode: c.mode, id });
    }
    for (const [p] of [...statCache.entries()]) {
      if (!index.has(p) && !untrackedSet.has(p) && !this.dirty.has(p)) statCache.delete(p);
    }
    for (const p of [...this.future.keys()]) if (!index.has(p) && !untrackedSet.has(p)) this.future.delete(p);
    const changed = /* @__PURE__ */ new Set();
    for (const p of /* @__PURE__ */ new Set([...before.keys(), ...this.dirty.keys()])) {
      if (!sameDirty(before.get(p), this.dirty.get(p))) changed.add(p);
    }
    return { dirty: new Map(this.dirty), changed, excluded, notAdmitted, failed, publishBlocked, carried: new Set(carried) };
  }
  /** Steps 7–9: route (a) add --ignore-errors --pathspec-from-file=- --pathspec-file-nul of dirty unfiltered copies (--work-tree=<tmp/stage>, literal pathspecs), route (b) -w + --cacheinfo for filtered ones, removals, 160000/120000 forced to A, crashpoint('snapshot.index_written'), write-tree → S_raw, canon in tmp/canon.index → S_disk. `only` = a record's paths (occasion (c)). */
  async materialize(inp, only) {
    requireATree(inp);
    const { repo, stage, privateIndex } = this.d;
    const index = await this.loadIndex();
    const carried = this.carriedPaths(index, inp.A, await this.fsInfo());
    const targets = [...this.dirty].filter(([p]) => (only === void 0 || only.has(p)) && !carried.has(p));
    const attrOf = await this.attrLookup(inp, targets.filter(([, de]) => de.kind !== "remove").map(([p]) => p));
    const failedPaths = /* @__PURE__ */ new Map();
    let publishBlocked = false;
    const edits = [];
    const done = /* @__PURE__ */ new Map();
    const routeA = [];
    for (const [p, de] of targets) {
      if (de.kind === "remove") {
        edits.push({ path: p, remove: true });
        done.set(p, null);
        continue;
      }
      if (await this.d.fs.lstat(stage.abs(p)) === null) {
        failedPaths.set(p, "unreadable");
        await this.drop(p);
        continue;
      }
      const filtered = attrOf(p).filter !== null;
      if (de.kind === "modify" && !filtered) {
        routeA.push(p);
        continue;
      }
      const h = de.kind === "new" ? await hashNewPath(repo, p, stage.abs(p), true) : await hashRouteB(repo, p, stage.abs(p), true);
      if (isFilterFailure(h)) {
        failedPaths.set(p, filtered ? "filter_failure" : "unreadable");
        if (filtered) publishBlocked = true;
        continue;
      }
      edits.push({ path: p, mode: de.mode, oid: h });
      done.set(p, h);
    }
    if (routeA.length > 0) {
      const r = await repo.run(["add", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        class: "refupdate",
        indexFile: privateIndex,
        workTree: stage.root,
        literalPathspecs: true,
        attrTree: inp.epochBase,
        config: { ...STAGE_TREE_CONFIG, ...PRIVATE_INDEX_CONFIG },
        stdin: Buffer.from(routeA.map((p) => `${p}\0`).join(""), "utf8"),
        okCodes: [0, 1]
      });
      const after = await this.lsIndex(privateIndex);
      const stuck = r.code === 1 ? await this.differing(routeA.flatMap((p) => {
        const e = after.get(p);
        return e === void 0 ? [] : [e];
      }), inp) : /* @__PURE__ */ new Set();
      for (const p of routeA) {
        const e = after.get(p);
        if (e === void 0 || stuck === null || stuck.has(p)) {
          failedPaths.set(p, "unreadable");
          continue;
        }
        done.set(p, e.oid);
        const mode = this.dirty.get(p)?.mode ?? e.mode;
        if (mode !== e.mode) edits.push({ path: p, mode, oid: e.oid });
      }
    }
    const forced = /* @__PURE__ */ new Set();
    for (const [p, e] of inp.A) if (SPECIAL.has(e.mode)) forced.add(p);
    for (const [p, e] of index) if (SPECIAL.has(e.mode)) forced.add(p);
    for (const p of carried) forced.add(p);
    const fffd = /* @__PURE__ */ new Set();
    for (const p of forced) {
      if (p.includes("�")) {
        fffd.add(p);
        continue;
      }
      const a = inp.A.get(p);
      const cur = index.get(p);
      if (a === void 0) {
        if (cur !== void 0) edits.push({ path: p, remove: true });
      } else if (cur === void 0 || cur.oid !== a.oid || cur.mode !== a.mode) {
        edits.push({ path: p, mode: a.mode, oid: a.oid });
      }
    }
    const rawEdits = fffd.size > 0 ? await this.rawCarryEdits(fffd, inp) : [];
    await this.editIndexFile(privateIndex, edits, inp.epochBase.length, rawEdits);
    this.index = null;
    crashpoint("snapshot.index_written");
    const sRaw = await this.writeTreeOf(privateIndex);
    const sRawMap = await repo.readTreeMap(sRaw);
    const { sDisk, sDiskMap, canonRefused } = await this.canonTree(inp, sRaw, sRawMap, carried);
    for (const [p, oid2] of done) {
      this.dirty.delete(p);
      if (oid2 === null) {
        this.d.statCache.delete(p);
        continue;
      }
      const ce = this.d.statCache.get(p);
      this.d.statCache.set(p, { stat: ce?.stat ?? null, id: sRawMap.get(p)?.oid ?? oid2, state: "clean" });
      await stage.remove(p);
    }
    const m = { sRaw, sDisk, sRawMap, sDiskMap, canonRefused, excluded: failedPaths, publishBlocked };
    this.lastMat = m;
    return m;
  }
  // ---- internals -------------------------------------------------------------------------------
  /**
   * Final review FB-7: true when an existing ancestor of p below the work-tree root is a symlink, a junction or not a
   * directory, or cannot be lstat'd (fail closed); a missing ancestor ends the walk (p is simply absent). `dirs` memoizes
   * each directory's state for one tick.
   */
  async beneathLink(path, dirs) {
    const parts = path.split("/");
    let rel = "";
    for (const c of parts.slice(0, -1)) {
      rel = rel === "" ? c : `${rel}/${c}`;
      let state = dirs.get(rel);
      if (state === void 0) {
        try {
          const st = await this.d.fs.lstat(this.workFile(rel));
          state = st === null ? "missing" : st.isSymbolicLink || !st.isDirectory ? "link" : "dir";
        } catch {
          state = "link";
        }
        dirs.set(rel, state);
      }
      if (state === "link") return true;
      if (state === "missing") return false;
    }
    return false;
  }
  workFile(path) {
    return join5(this.d.repo.paths.workTree, ...path.split("/"));
  }
  /** The private index (S_raw entries), reloaded only when the index file's lstat changed. */
  async loadIndex() {
    let st;
    try {
      st = await this.d.fs.lstat(this.d.privateIndex);
    } catch {
      st = null;
    }
    if (this.index !== null && sameOrBothNull(this.index.stat, st)) return this.index.map;
    const map = await this.lsIndex(this.d.privateIndex);
    this.index = { stat: st, map };
    this.listing = null;
    return map;
  }
  // Index-only plumbing with INDEX_ONLY_CONFIG (R-38; protectNTFS, see its comment). GitRepo's listIndex, editIndex,
  // writeTree and readTreeIntoIndex take no per-call config, so the snapshot runs the same commands itself.
  /** ls-files -s -z, stage 0 only. */
  async lsIndex(indexFile) {
    const r = await this.d.repo.run(["ls-files", "-s", "-z"], { indexFile, config: INDEX_ONLY_CONFIG });
    const out = /* @__PURE__ */ new Map();
    for (const rec of r.stdout.toString("utf8").split("\0")) {
      if (rec.length === 0) continue;
      const tab = rec.indexOf("	");
      const [mode, oid2, stage, extra] = tab < 0 ? [] : rec.slice(0, tab).split(" ");
      if (mode === void 0 || !FILE_MODES3.has(mode) || !isOid(oid2) || stage === void 0 || extra !== void 0) {
        throw new Error(`ls-files: unexpected record ${JSON.stringify(rec.slice(0, 120))}`);
      }
      if (stage !== "0") continue;
      const path = rec.slice(tab + 1);
      out.set(path, { path, mode, oid: oid2 });
    }
    return out;
  }
  /**
   * update-index --add --replace -z --index-info: whole-path replacement; a removal is mode 0 with a zero oid of
   * `oidLength` hex digits. `raw`: further lines already encoded (rawIndexLine), for path bytes that are not UTF-8.
   * Final review FB-6: every `edits` entry is read back (an "ignored" path exits 0): IndexRefusedPathError otherwise.
   */
  async editIndexFile(indexFile, edits, oidLength, raw = []) {
    if (edits.length === 0 && raw.length === 0) return;
    const zero = "0".repeat(oidLength);
    const lines = edits.map((e) => "remove" in e ? rawIndexLine("0", zero, Buffer.from(e.path, "utf8")) : rawIndexLine(e.mode, parseOid(e.oid), Buffer.from(e.path, "utf8")));
    const argv2 = ["update-index", "--add", "--replace", "-z", "--index-info"];
    await this.d.repo.run(argv2, { class: "refupdate", indexFile, config: INDEX_ONLY_CONFIG, stdin: Buffer.concat([...lines, ...raw]) });
    await verifyIndexEdits(this.d.repo, indexFile, edits, INDEX_ONLY_CONFIG, argv2);
  }
  /**
   * P2-CARRY for names holding U+FFFD: index lines, by raw path bytes, that give each such key exactly A's raw entries,
   * read from A's tree object (`ls-tree -r -z <inp.aTree>`, ruling P2-ATREE).
   */
  async rawCarryEdits(keys3, inp) {
    const { repo, privateIndex } = this.d;
    const cur = rawEntries((await repo.run(["ls-files", "-s", "-z"], { indexFile: privateIndex, config: INDEX_ONLY_CONFIG })).stdout, "index", keys3);
    const want = rawEntries((await repo.run(["ls-tree", "-r", "-z", "--full-tree", parseOid(inp.aTree)])).stdout, "tree", keys3);
    const id = (e) => e.raw.toString("latin1");
    const wanted = new Set(want.map(id));
    const have = new Map(cur.map((e) => [id(e), e]));
    const zero = "0".repeat(inp.epochBase.length);
    const out = [];
    for (const e of cur) if (!wanted.has(id(e))) out.push(rawIndexLine("0", zero, e.raw));
    for (const e of want) {
      const h = have.get(id(e));
      if (h === void 0 || h.mode !== e.mode || h.oid !== e.oid) out.push(rawIndexLine(e.mode, e.oid, e.raw));
    }
    return out;
  }
  async writeTreeOf(indexFile) {
    const r = await this.d.repo.run(["write-tree"], { indexFile, config: INDEX_ONLY_CONFIG });
    return parseOid(r.stdout.toString("utf8"));
  }
  /** Final review FB-6: a tree whose root holds a name git refuses in any index is an IndexRefusedPathError naming it. */
  async readTreeInto(indexFile, tree2) {
    await readTreeIndexOnly(this.d.repo, tree2, indexFile, INDEX_ONLY_CONFIG);
  }
  /** core.fileMode (git's default true; never trusted on Windows, whose lstat has no exec bit) and core.ignorecase. */
  async fsInfo() {
    if (this.info !== null) return this.info;
    const rows2 = await this.d.repo.configGetRegexp("^core\\.(filemode|ignorecase)$");
    const last = (key) => {
      let v;
      for (const r of rows2) if (r.key === key) v = r.value;
      return v;
    };
    this.info = { fileMode: !this.windows() && gitBool(last("core.filemode"), true), ignoreCase: gitBool(last("core.ignorecase"), false) };
    return this.info;
  }
  windows() {
    return (this.d.platform ?? process.platform) === "win32";
  }
  /** P2-CARRY over A ∪ the private index; recomputed only when either map is a new object. */
  carriedPaths(index, A, info) {
    const c = this.carry;
    if (c !== null && c.index === index && c.A === A) return c.set;
    const all = /* @__PURE__ */ new Set([...index.keys(), ...A.keys()]);
    const windows = this.windows();
    const set = /* @__PURE__ */ new Set();
    for (const p of all) if (carriedAlone(p, windows)) set.add(p);
    if (info.ignoreCase) for (const p of caseCollisions(all)) set.add(p);
    this.carry = { index, A, set };
    return set;
  }
  /** A path that became carried leaves the dirty set and the stat cache; a stage copy exists only if it was dirty. */
  async forget(path) {
    const hadCopy = this.dirty.has(path);
    this.dirty.delete(path);
    this.future.delete(path);
    this.d.statCache.delete(path);
    if (hadCopy && stageable(path)) await this.d.stage.remove(path);
  }
  /**
   * Glossary §20: a removal confirms on two consecutive absences. Any observation that is not "absent" (the path is
   * present, or its lstat failed) ends the streak. An entry with no stat exists only to hold the streak (the first
   * absence after a start or reseed, when nothing was cached): it goes with it. Kept as `{stat: null, clean}`, it
   * would read as "unchanged" at every later absence and the deletion would never be staged.
   */
  endAbsence(path) {
    const ce = this.d.statCache.get(path);
    if (ce === void 0 || ce.missingSinceMono === void 0) return;
    if (ce.stat === null) {
      this.d.statCache.delete(path);
      return;
    }
    this.d.statCache.set(path, { stat: ce.stat, id: ce.id, state: ce.state, ...ce.shrink !== void 0 ? { shrink: ce.shrink } : {} });
  }
  /**
   * ls-files -o --exclude-standard -z on the private index (DAT-24), rerun only when a watched directory's lstat
   * changed or after UNTRACKED_RESCAN_MS; null when the listing failed (the snapshot fails). The directories of
   * carried paths and of listed paths that are not stageable are never watched (never looked at: `GIT~1` is `.git` on
   * Windows, `con/` a device); a file created in a directory holding only such paths is found by the backstop.
   */
  async untracked(index, now, carried) {
    const L = this.listing;
    if (L !== null && now - L.mono < UNTRACKED_RESCAN_MS && await this.dirsUnchanged(L.dirs)) return L.entries;
    const watch = /* @__PURE__ */ new Set([""]);
    for (const p of index.keys()) if (!carried.has(p)) parentDirs(p, watch);
    for (const p of L?.entries ?? []) if (stageable(p.endsWith("/") ? p.slice(0, -1) : p)) parentDirs(p, watch);
    const dirs = /* @__PURE__ */ new Map();
    for (const d of watch) dirs.set(d, await this.dirStat(d));
    let out;
    try {
      const r = await this.d.repo.run(["ls-files", "-o", "--exclude-standard", "-z"], {
        indexFile: this.d.privateIndex,
        config: PRIVATE_INDEX_CONFIG
      });
      out = r.stdout.toString("utf8");
    } catch (e) {
      if (e instanceof GitCommandError) return null;
      throw e;
    }
    const entries = out.split("\0").filter((s) => s.length > 0);
    const more = /* @__PURE__ */ new Set();
    for (const p of entries) if (stageable(p.endsWith("/") ? p.slice(0, -1) : p)) parentDirs(p, more);
    for (const d of more) if (!dirs.has(d)) dirs.set(d, await this.dirStat(d));
    this.listing = { entries, dirs, mono: now };
    return entries;
  }
  async dirStat(dir) {
    try {
      return await this.d.fs.lstat(dir === "" ? this.d.repo.paths.workTree : this.workFile(dir));
    } catch {
      return null;
    }
  }
  async dirsUnchanged(dirs) {
    for (const [d, st] of dirs) {
      if (!sameOrBothNull(st, await this.dirStat(d))) return false;
    }
    return true;
  }
  /** The caller's attributes where it has them (EPOCH_BASE), the snapshot's own cache for the rest (new paths). */
  async attrLookup(inp, paths) {
    const caller = inp.scope.attrs.epochBase === inp.epochBase ? inp.scope.attrs : null;
    const miss = paths.filter((p) => caller === null || tryGet(caller, p) === void 0);
    const own = miss.length > 0 ? await this.attrs.snapshot(inp.epochBase, miss) : null;
    return (p) => {
      const hit = caller === null ? void 0 : tryGet(caller, p);
      if (hit !== void 0) return hit;
      if (own !== null) return own.get(p);
      return inp.scope.attrs.get(p);
    };
  }
  /**
   * Ruling P2-DRIVERCAP / P2-SNAPFILTERS (fail closed): a path under a filter attribute while the driver set is over
   * its cap, or naming a driver outside it (git would run it without required=true), is never read or hashed.
   */
  filterRefused(a) {
    if (a.filter === null) return false;
    const f = this.d.filters;
    return f.overCap !== null || !f.drivers.includes(a.filter);
  }
  /** The stat equals the cached one and no deletion or shrink confirmation is pending: not a candidate. */
  unchanged(path, st) {
    const ce = this.d.statCache.get(path);
    if (ce === void 0 || ce.missingSinceMono !== void 0 || ce.shrink !== void 0) return false;
    return sameOrBothNull(ce.stat, st);
  }
  /** Step 2: mtime < QUIET_MS old (this PC's wall clock), or a future mtime whose stat has not been stable for QUIET_MS Δmono. */
  quiet(path, st, now, wall) {
    const mtimeMs = Number(st.mtimeNs / 1000000n);
    if (mtimeMs > wall) {
      const f = this.future.get(path);
      if (f === void 0 || !sameStat(f.stat, st)) {
        this.future.set(path, { stat: st, firstMono: now });
        return true;
      }
      if (now - f.firstMono < QUIET_MS) return true;
      this.future.delete(path);
      return false;
    }
    this.future.delete(path);
    return wall - mtimeMs < QUIET_MS;
  }
  /** Step 3: a removal only when also missing ≥ DELETE_CONFIRM_MS earlier (Δmono) or hook-attributed. */
  async missing(path, entry, now, excluded) {
    const ce = this.d.statCache.get(path);
    const since = ce?.missingSinceMono;
    const attributed = this.d.attribution.removalAttributed(path);
    if (!attributed && (since === void 0 || now - since < DELETE_CONFIRM_MS)) {
      if (since === void 0) {
        const base = ce ?? { stat: null, id: entry.oid, state: "clean" };
        this.d.statCache.set(path, { stat: base.stat, id: base.id, state: base.state, missingSinceMono: now });
      }
      excluded.set(path, "deletion_pending");
      return;
    }
    this.d.statCache.set(path, { stat: null, id: null, state: "dirty" });
    this.dirty.set(path, { kind: "remove", mode: entry.mode, id: null });
    await this.d.stage.remove(path);
  }
  /** The size a shrink is measured against: the last staged stat, else (first read after a start) S_raw[p]'s blob size. */
  async referenceSizes(ok) {
    const out = /* @__PURE__ */ new Map();
    const need = [];
    for (const c of ok) {
      const st = this.d.statCache.get(c.path)?.stat ?? null;
      if (st !== null) out.set(c.path, st.size);
      else if (c.entry !== null) need.push(c);
    }
    if (need.length > 0) {
      const sizes = await this.d.repo.blobSizes(need.map((c) => c.entry.oid));
      need.forEach((c, i) => out.set(c.path, sizes[i]));
    }
    return out;
  }
  /** Step 6 (ruling R-25): true while a > 50 % or to-0 shrink is not yet confirmed by a second tick ≥ 1 s later with the same stat and attribution. */
  shrinkHeld(c, refSize, now) {
    const size = c.bytes.length;
    if (refSize === null || refSize === 0 || size !== 0 && size >= refSize * SHRINK_RATIO) return false;
    const ce = this.d.statCache.get(c.path);
    const sh = ce?.shrink;
    if (sh !== void 0 && sameStat(sh.stat, c.stat)) {
      if (now - sh.firstMono >= SHRINK_STABLE_MS && this.d.attribution.shrinkAttributed(c.path)) return false;
      this.d.statCache.set(c.path, { ...ce, shrink: { stat: sh.stat, firstMono: sh.firstMono, ticks: sh.ticks + 1 } });
      return true;
    }
    const base = ce ?? { stat: null, id: c.entry?.oid ?? null, state: "clean" };
    this.d.statCache.set(c.path, { stat: base.stat, id: base.id, state: base.state, shrink: { stat: c.stat, firstMono: now, ticks: 1 } });
    return true;
  }
  /**
   * The U comparison of step 5 (and the rc-1 check of step 7): a scratch index tmp/detect.index holding the given
   * entries, a stage-tree `update-index --refresh` (no -q; rc 0 or 1 both normal, never read as the result), then
   * `diff-files -z --name-only` on the same index: a listed path differs. null on any other failure.
   */
  async differing(entries, inp) {
    const indexFile = this.d.scratch.detect;
    const key = JSON.stringify([inp.epochBase, ...entries.map((e) => [e.path, e.mode, e.oid])]);
    try {
      if (key !== this.detectKey || await this.d.fs.lstat(indexFile) === null) {
        this.detectKey = null;
        await resetScratchIndex(this.d.fs, indexFile);
        await this.d.repo.editIndex(indexFile, entries.map((e) => ({ path: e.path, mode: e.mode, oid: e.oid })));
        this.detectKey = key;
      }
      const opts = { indexFile, workTree: this.d.stage.root, attrTree: inp.epochBase, config: STAGE_TREE_CONFIG };
      await this.d.repo.run(["update-index", "--refresh"], { ...opts, okCodes: [0, 1] });
      const diff = await this.d.repo.run(["diff-files", "-z", "--name-only"], opts);
      return new Set(diff.stdout.toString("utf8").split("\0").filter((s) => s.length > 0));
    } catch (e) {
      if (e instanceof GitCommandError) {
        this.detectKey = null;
        return null;
      }
      throw e;
    }
  }
  async clean(c) {
    this.d.statCache.set(c.path, { stat: c.stat, id: c.entry.oid, state: "clean" });
    this.dirty.delete(c.path);
    await this.d.stage.remove(c.path);
  }
  markDirty(c, de) {
    this.d.statCache.set(c.path, { stat: c.stat, id: de.id, state: "dirty" });
    this.dirty.set(c.path, de);
  }
  /**
   * A read whose bytes cannot be hashed this tick: its stage copy goes. A path that was dirty had its earlier copy
   * overwritten by this read, so it leaves the dirty set and the stat cache (the next tick reads it from scratch); it
   * is excluded this loop either way.
   */
  async discardCopy(path) {
    if (this.dirty.has(path)) {
      await this.drop(path);
      return;
    }
    await this.d.stage.remove(path);
  }
  async drop(path) {
    this.dirty.delete(path);
    this.d.statCache.delete(path);
    await this.d.stage.remove(path);
  }
  /**
   * Step 9: S_disk = canon(S_raw) for p ∈ diff(A, S_raw) with ref(p) = A[p], else EPOCH_BASE[p], else none; built in
   * tmp/canon.index. A carried path is never canon'd: S_raw already holds A's entry for it, and a U+FFFD name written
   * back by its decoded string would name another path.
   */
  async canonTree(inp, sRaw, sRawMap, carried) {
    const { repo } = this.d;
    const canonRefused = /* @__PURE__ */ new Set();
    const regular = (e) => e !== void 0 && (e.mode === "100644" || e.mode === "100755");
    const diff = [...sRawMap.values()].filter((e) => regular(e) && !carried.has(e.path) && inp.A.get(e.path)?.oid !== e.oid);
    let epochMap = null;
    const pairs = [];
    for (const e of diff) {
      let ref = inp.A.get(e.path);
      if (ref === void 0) {
        epochMap ??= await repo.readTreeMap(inp.epochBase);
        ref = epochMap.get(e.path);
      }
      if (regular(ref)) pairs.push({ e, ref });
    }
    const attrOf = await this.attrLookup(inp, pairs.map((x) => x.e.path));
    const todo = pairs.filter(({ e }) => {
      const a = attrOf(e.path);
      return a.filter === null && !a.binary && a.text !== "unset";
    });
    const edits = [];
    if (todo.length > 0) {
      const blobs = await repo.readBlobs(todo.flatMap(({ e, ref }) => [e.oid, ref.oid]));
      for (let i = 0; i < todo.length; i++) {
        const { e } = todo[i];
        const next = blobs[2 * i];
        const res = canon(next, blobs[2 * i + 1], false);
        if (!res.ok) {
          canonRefused.add(e.path);
          continue;
        }
        if (!res.out.equals(next)) edits.push({ path: e.path, mode: e.mode, oid: await hashRouteC(repo, res.out, true) });
      }
    }
    if (edits.length === 0) return { sDisk: sRaw, sDiskMap: sRawMap, canonRefused };
    const canonIndex = this.d.scratch.canon;
    await resetScratchIndex(this.d.fs, canonIndex);
    await this.readTreeInto(canonIndex, sRaw);
    await this.editIndexFile(canonIndex, edits, sRaw.length);
    const sDisk = await this.writeTreeOf(canonIndex);
    return { sDisk, sDiskMap: await repo.readTreeMap(sDisk), canonRefused };
  }
};

// src/engine/state.ts
var StateCasLostError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "StateCasLostError";
  }
};
var LostStateError = class extends Error {
  /** The unusable commit the state ref names, which StateStore.rebuild replaces by CAS (ruling P2-REBUILD); null when the ref value itself could not be read. */
  stateOid;
  constructor(stateOid, message, options) {
    super(message, options);
    this.name = "LostStateError";
    this.stateOid = stateOid;
  }
};
var NUL = String.fromCharCode(0);
var TREE_MODE = "040000";
var BLOB_MODE = "100644";
var JOURNAL_TREES = new Set(Object.keys({ M: 1, S: 1, TIP: 1, P: 1 }));
var FOLD_NAME = "fold";
var FOLD_FILE = "state.json";
var KEEP_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
var HUMAN_CS = /^[0-9a-f]{32}\/human\/([1-9][0-9]*)$/;
var StateFormatError = class extends TypeError {
  constructor(what) {
    super(`state: ${what}`);
    this.name = "StateFormatError";
  }
};
function isObj5(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function keys2(v, want, what) {
  if (!isObj5(v)) throw new StateFormatError(`${what} is not an object`);
  const have = Object.keys(v).sort();
  const w = [...want].sort();
  if (have.length !== w.length || have.some((k, i) => k !== w[i])) throw new StateFormatError(`${what} has keys [${have.join(", ")}]`);
  return v;
}
function check3(ok, what) {
  if (!ok) throw new StateFormatError(what);
}
var int3 = (v, min) => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
var oidOrAbsent = (v) => v === ABSENT || isOid(v);
var array = (v, what) => {
  if (!Array.isArray(v)) throw new StateFormatError(`${what} is not an array`);
  return v;
};
function checkIntent(v) {
  const kind = isObj5(v) ? v["kind"] : void 0;
  switch (kind) {
    case "none":
      keys2(v, ["kind"], "intent");
      break;
    case "apply": {
      const o = keys2(v, ["kind", "tip", "board", "groups"], "apply intent");
      check3(isOid(o["tip"]) && isOid(o["board"]), "apply intent tip/board must be object ids");
      for (const g of array(o["groups"], "apply intent groups")) {
        const go = keys2(g, ["n", "entries"], "apply group");
        check3(int3(go["n"], 0), "apply group n must be a safe integer >= 0");
        for (const e of array(go["entries"], "apply group entries")) {
          const eo = keys2(e, ["path", "kind", "slot"], "apply entry");
          check3(typeof eo["path"] === "string" && validPathSyntax(eo["path"]), "apply entry path is not a valid path");
          check3(eo["kind"] === "create" || eo["kind"] === "modify" || eo["kind"] === "delete", "apply entry kind");
          check3(int3(eo["slot"], 0), "apply entry slot must be a safe integer >= 0");
        }
      }
      break;
    }
    case "local": {
      const o = keys2(v, ["kind", "origin", "entries"], "local intent");
      check3(typeof o["origin"] === "string" && o["origin"].length > 0, "local intent origin must be a non-empty string");
      for (const e of array(o["entries"], "local intent entries")) {
        const eo = keys2(e, ["path", "expected", "target", "slot"], "local entry");
        check3(typeof eo["path"] === "string" && validPathSyntax(eo["path"]), "local entry path is not a valid path");
        check3(oidOrAbsent(eo["expected"]), "local entry expected must be an object id or ABSENT");
        check3(eo["target"] === "DELETE" || isOid(eo["target"]), "local entry target must be an object id or DELETE");
        check3(int3(eo["slot"], 0), "local entry slot must be a safe integer >= 0");
      }
      break;
    }
    case "push": {
      const o = keys2(v, ["kind", "bnew", "c", "lease_board", "lease_code", "cs_ids", "writer_seq", "op_ids"], "push intent");
      check3(isOid(o["bnew"]) && (o["c"] === null || isOid(o["c"])), "push intent bnew/c must be object ids");
      check3(oidOrAbsent(o["lease_board"]) && oidOrAbsent(o["lease_code"]), "push intent leases must be object ids or ABSENT");
      check3(array(o["cs_ids"], "push intent cs_ids").every((x) => typeof x === "string" && validId("cs", x)), "push intent cs_ids must be change-set ids");
      check3(int3(o["writer_seq"], 1), "push intent writer_seq must be a safe integer >= 1");
      check3(array(o["op_ids"], "push intent op_ids").every((x) => typeof x === "string" && validId("op", x)), "push intent op_ids must be op ids");
      break;
    }
    default:
      throw new StateFormatError(`unknown intent kind ${JSON.stringify(kind)}`);
  }
  return v;
}
function parseIntent(buf) {
  let v;
  try {
    v = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new StateFormatError("intent.json is not JSON");
  }
  const intent = checkIntent(v);
  check3(canonicalBytes(v).equals(buf), "intent.json is not canonical JSON");
  return intent;
}
function serializeIntent(i) {
  const buf = canonicalBytes(i);
  parseIntent(buf);
  return buf;
}
function humanOrder(csId) {
  const m = HUMAN_CS.exec(csId);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}
function csIdOfKey(k) {
  check3(/^[A-Za-z0-9_-]+$/.test(k), `ready key ${JSON.stringify(k)} is not base64url`);
  const csId = Buffer.from(k, "base64url").toString("utf8");
  check3(validId("cs", csId) && readyKey(csId) === k, `ready key ${JSON.stringify(k)} does not name a change-set id`);
  return csId;
}
async function lsTree(repo, tree2) {
  const r = await repo.run(["ls-tree", "-z", parseOid(tree2)]);
  const out = /* @__PURE__ */ new Map();
  for (const rec of r.stdout.toString("utf8").split(NUL)) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf("	");
    const meta = rec.slice(0, tab).split(" ");
    check3(tab > 0 && meta.length === 3, `ls-tree record ${JSON.stringify(rec.slice(0, 120))}`);
    out.set(rec.slice(tab + 1), { mode: meta[0], type: meta[1], oid: parseOid(meta[2]) });
  }
  return out;
}
function isTree(e) {
  return e.type === "tree" && e.mode === TREE_MODE;
}
function isBlob(e) {
  return e.type === "blob" && e.mode === BLOB_MODE;
}
function exact(entries, want, what) {
  const names = Object.keys(want);
  check3(entries.size === names.length && names.every((n) => entries.has(n)), `${what} has entries [${[...entries.keys()].join(", ")}]`);
  const out = {};
  for (const n of names) {
    const e = entries.get(n);
    check3(want[n] === "tree" ? isTree(e) : isBlob(e), `${what}/${n} is not a ${want[n]}`);
    out[n] = e;
  }
  return out;
}
async function checkObjects(repo, items) {
  if (items.length === 0) return;
  const r = await repo.run(["cat-file", "--batch-check"], { stdin: Buffer.from(`${items.map(([o]) => o).join("\n")}
`, "utf8") });
  const lines = r.stdout.toString("utf8").split("\n");
  items.forEach(([o, type], i) => {
    const parts = (lines[i] ?? "").split(" ");
    check3(parts.length === 3 && parts[0] === o && parts[1] === type, `${type} ${o} is missing`);
  });
}
var tree = (name, oid2) => ({ name, mode: TREE_MODE, type: "tree", oid: oid2 });
var blob = (name, oid2) => ({ name, mode: BLOB_MODE, type: "blob", oid: oid2 });
function initial(init) {
  return {
    laC: init.laC,
    laB: init.laB,
    base: init.base,
    snap: init.snap,
    meta: init.meta,
    intent: { kind: "none" },
    t: /* @__PURE__ */ new Map(),
    ready: init.ready ?? [],
    keep: /* @__PURE__ */ new Map(),
    fold: init.fold ?? null
  };
}
var StateStore = class {
  d;
  constructor(d) {
    this.d = d;
  }
  /**
   * null = no ref; MetaTooNewError when the state's meta blob comes from a newer plugin (checked first, LIF-37);
   * LostStateError when the state names a missing or unparsable object (stateOid = the ref's value) or when git
   * cannot read the ref value itself (stateOid = null).
   */
  async read() {
    let commit;
    try {
      commit = await this.d.repo.readRef(this.d.refs.state);
    } catch (e) {
      if (e instanceof GitCommandError && e.code >= 0) {
        throw new LostStateError(null, `${this.d.refs.state}: the ref value cannot be read: ${e.message}`, { cause: e });
      }
      throw e;
    }
    if (commit === null) return null;
    try {
      return await this.load(commit);
    } catch (e) {
      if (e instanceof MetaTooNewError) throw e;
      if (e instanceof GitCommandError && e.code < 0) throw e;
      throw new LostStateError(commit, `${this.d.refs.state} at ${commit}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
  create(init) {
    return this.write(null, initial(init));
  }
  /** ENG-54 lost-state rebuild over an existing but unusable state ref: one CAS from `unusable` (LostStateError.stateOid) to the new commit (ruling P2-REBUILD); never used for a MetaTooNewError state. */
  rebuild(unusable, init) {
    return this.write(parseOid(unusable), initial(init));
  }
  /** Commit [laC, laB], tree {base, snap, meta, journal/{intent.json, t/, ready/<k>/{R,A}, keep/}} built bottom-up with one mktree per directory level
   *  (journal/ready/<k>, journal/ready, journal/t, journal/keep/fold, journal/keep, journal, root; existing trees and blobs referenced by oid; never
   *  read-tree --prefix; R-15), subject 'cowork-state', one CAS update-ref --create-reflog; trace 'state'. */
  commit(prev, t) {
    return this.write(prev.commit, {
      laC: t.laC ?? prev.laC,
      laB: t.laB ?? prev.laB,
      base: t.base ?? prev.base,
      snap: t.snap ?? prev.snap,
      meta: t.meta ?? prev.meta,
      intent: t.intent ?? prev.intent,
      t: t.t ?? prev.t,
      ready: t.ready ?? prev.ready,
      keep: t.keep ?? prev.keep,
      fold: t.fold ?? prev.fold
    });
  }
  async load(commit) {
    const repo = this.d.repo;
    const info = await repo.readCommit(commit);
    const rootEntries = await lsTree(repo, info.tree);
    const metaEntry = rootEntries.get("meta");
    check3(metaEntry !== void 0 && isBlob(metaEntry), "the state tree has no meta blob");
    const meta = parseMeta(await repo.readBlob(metaEntry.oid));
    check3(info.subject === STATE_SUBJECT && info.trailers.length === 0, "the state commit is not a cowork-state commit");
    check3(info.parents.length === 2, `the state commit has ${info.parents.length} parents`);
    const [laC, laB] = info.parents;
    const root = exact(rootEntries, { base: "tree", snap: "tree", meta: "blob", journal: "tree" }, "state tree");
    const journal = exact(await lsTree(repo, root.journal.oid), { "intent.json": "blob", t: "tree", ready: "tree", keep: "tree" }, "journal");
    const intent = parseIntent(await repo.readBlob(journal["intent.json"].oid));
    const t = /* @__PURE__ */ new Map();
    for (const [name, e] of await lsTree(repo, journal.t.oid)) {
      check3(JOURNAL_TREES.has(name) && isTree(e), `journal/t/${name} is not one of the trees M, S, TIP, P`);
      t.set(name, e.oid);
    }
    const ready = [];
    for (const [k, e] of await lsTree(repo, journal.ready.oid)) {
      check3(isTree(e), `journal/ready/${k} is not a tree`);
      const csId = csIdOfKey(k);
      const order = humanOrder(csId);
      check3(order !== null, `journal/ready/${k} is not a human change-set`);
      const pair = exact(await lsTree(repo, e.oid), { R: "tree", A: "tree" }, `journal/ready/${k}`);
      ready.push({ csId, R: pair.R.oid, A: pair.A.oid, paths: await this.pairPaths(pair.R.oid, pair.A.oid), order });
    }
    const keep = /* @__PURE__ */ new Map();
    let fold = null;
    for (const [name, e] of await lsTree(repo, journal.keep.oid)) {
      check3(isTree(e), `journal/keep/${name} is not a tree`);
      if (name === FOLD_NAME) {
        const f = exact(await lsTree(repo, e.oid), { [FOLD_FILE]: "blob" }, "journal/keep/fold");
        fold = parseFold(await repo.readBlob(f[FOLD_FILE].oid));
        check3(fold !== null, "journal/keep/fold/state.json is not a fold state");
      } else {
        check3(KEEP_NAME.test(name), `journal/keep/${name} is not a keep name`);
        keep.set(name, e.oid);
      }
    }
    await checkObjects(repo, [
      [laC, "commit"],
      [laB, "commit"],
      [root.base.oid, "tree"],
      [root.snap.oid, "tree"],
      ...[...t.values()].map((o) => [o, "tree"]),
      ...[...keep.values()].map((o) => [o, "tree"]),
      ...ready.flatMap((p) => [[p.R, "tree"], [p.A, "tree"]])
    ]);
    return { commit, laC, laB, base: root.base.oid, snap: root.snap.oid, meta, intent, t, ready: sortReady(ready), keep, fold };
  }
  /** The union of R's and A's paths: the CS paths as the journal records them (R-01). */
  async pairPaths(R, A) {
    const r = await this.d.repo.readTreeMap(R);
    const a = await this.d.repo.readTreeMap(A);
    return [.../* @__PURE__ */ new Set([...r.keys(), ...a.keys()])].sort();
  }
  async write(prevCommit, s) {
    const repo = this.d.repo;
    for (const o of [s.laC, s.laB, s.base, s.snap]) parseOid(o);
    check3(s.laC !== s.laB, "LA_C and LA_B are the same commit");
    const metaBuf = serializeMeta(s.meta);
    const intentBuf = serializeIntent(s.intent);
    for (const [name, o] of s.t) {
      check3(JOURNAL_TREES.has(name), `journal/t/${String(name)} is not one of the trees M, S, TIP, P`);
      parseOid(o);
    }
    for (const [name, o] of s.keep) {
      check3(KEEP_NAME.test(name) && name !== FOLD_NAME, `${JSON.stringify(name)} is not a keep name`);
      parseOid(o);
    }
    const seenKeys = /* @__PURE__ */ new Set();
    for (const p of s.ready) {
      const order = humanOrder(p.csId);
      check3(order !== null, `ready pair ${JSON.stringify(p.csId)} is not a human change-set`);
      check3(p.order === order, `ready pair ${p.csId} has order ${p.order}, its cs_id says ${String(order)}`);
      const k = readyKey(p.csId);
      check3(!seenKeys.has(k), `ready pair ${p.csId} is listed twice`);
      seenKeys.add(k);
      parseOid(p.R);
      parseOid(p.A);
    }
    let foldBuf = null;
    if (s.fold !== null) {
      foldBuf = serializeFold(s.fold);
      check3(parseFold(foldBuf) !== null, "the fold state does not serialize to a readable fold state");
    }
    const ready = [];
    const readyEntries = [];
    for (const p of s.ready) {
      ready.push({ csId: p.csId, R: p.R, A: p.A, paths: await this.pairPaths(p.R, p.A), order: p.order });
      readyEntries.push(tree(readyKey(p.csId), await repo.mktree([tree("R", p.R), tree("A", p.A)])));
    }
    const readyTree = await repo.mktree(readyEntries);
    const tTree = await repo.mktree([...s.t].map(([name, o]) => tree(name, o)));
    const keepEntries = [...s.keep].map(([name, o]) => tree(name, o));
    if (foldBuf !== null) {
      keepEntries.push(tree(FOLD_NAME, await repo.mktree([blob(FOLD_FILE, await repo.hashBytes(foldBuf, true))])));
    }
    const keepTree = await repo.mktree(keepEntries);
    const journal = await repo.mktree([
      blob("intent.json", await repo.hashBytes(intentBuf, true)),
      tree("t", tTree),
      tree("ready", readyTree),
      tree("keep", keepTree)
    ]);
    const root = await repo.mktree([tree("base", s.base), tree("snap", s.snap), blob("meta", await repo.hashBytes(metaBuf, true)), tree("journal", journal)]);
    const commit = await repo.commitTree({ tree: root, parents: [s.laC, s.laB], subject: STATE_SUBJECT, trailers: [] });
    if (!await repo.casRef(this.d.refs.state, commit, prevCommit, STATE_SUBJECT)) {
      throw new StateCasLostError(`${this.d.refs.state} is no longer at ${prevCommit ?? "(absent)"}: a second writer`);
    }
    this.d.trace.emit({ kind: "state", peer: this.d.peer(), prev: prevCommit, next: commit, laC: s.laC, laB: s.laB, base: s.base });
    return {
      commit,
      laC: s.laC,
      laB: s.laB,
      base: s.base,
      snap: s.snap,
      meta: s.meta,
      intent: s.intent,
      t: new Map(s.t),
      ready: sortReady(ready),
      keep: new Map(s.keep),
      fold: s.fold
    };
  }
};
function sortReady(pairs) {
  return pairs.sort((a, b) => a.order - b.order || (a.csId < b.csId ? -1 : a.csId > b.csId ? 1 : 0));
}

// src/engine/statCache.ts
var StatCache = class {
  map = /* @__PURE__ */ new Map();
  get(path) {
    return this.map.get(path);
  }
  set(path, e) {
    this.map.set(path, e);
  }
  delete(path) {
    this.map.delete(path);
  }
  clear() {
    this.map.clear();
  }
  entries() {
    return this.map.entries();
  }
  get size() {
    return this.map.size;
  }
};

// src/engine/writer.ts
import { dirname, join as join6 } from "node:path";
var RING_KEEP_MS = 2e3;
var MAX_REMERGE = 3;
var PATH_BUSY_WAIT_MS = 250;
async function orphanAside(fs, random, clock, tmpDir, ext) {
  for (; ; ) {
    const name = join6(tmpDir, `orphan-${ulid(random, clock)}.${ext}`);
    if (await fs.lstat(name) === null) return name;
  }
}
var LOCAL_INTENT_KEEP = "local-intent";
function localIntentKeep(intent) {
  if (intent.kind !== "local") return [];
  const oids = /* @__PURE__ */ new Set();
  for (const e of intent.entries) {
    if (e.expected !== ABSENT) oids.add(e.expected);
    if (e.target !== "DELETE") oids.add(e.target);
  }
  return [...oids].sort().map((oid2) => ({ name: oid2, mode: "100644", type: "blob", oid: oid2 }));
}
function narrowToStranded(intent, results) {
  const stranded = new Set(results.filter((r) => r.stranded).map((r) => r.n));
  if (intent.kind === "apply") {
    const groups = intent.groups.filter((g) => stranded.has(g.n));
    return groups.length === 0 ? { kind: "none" } : { ...intent, groups };
  }
  if (intent.kind === "local") return stranded.has(0) ? intent : { kind: "none" };
  return intent;
}
function narrowLocal(intent, paths) {
  let changed = false;
  const entries = [];
  for (const e of intent.entries) {
    if (!paths.has(e.path)) {
      changed = true;
    } else if (e.target === "DELETE" && e.expected !== ABSENT) {
      entries.push({ ...e, target: e.expected });
      changed = true;
    } else {
      entries.push(e);
    }
  }
  if (entries.length === 0) return { kind: "none" };
  return changed ? { ...intent, entries } : intent;
}
var FREE_SPACE_MARGIN_BYTES = 268435456;
var LOCKED_CODES = /* @__PURE__ */ new Set(["EBUSY", "EPERM", "EACCES"]);
var UNMATERIALIZABLE_CODES = /* @__PURE__ */ new Set(["ENAMETOOLONG", "EINVAL", "ENOTDIR"]);
var NO_LINK_CODES = /* @__PURE__ */ new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);
var LOCAL_PREFIX2 = "L";
var PROBE_BASE = "~cowork-link-probe";
var PROBE_NAMES = 16;
function codeOf2(e) {
  const code = typeof e === "object" && e !== null ? e.code : void 0;
  return typeof code === "string" ? code : void 0;
}
function syscallOf(e) {
  const s = typeof e === "object" && e !== null ? e.syscall : void 0;
  return typeof s === "string" ? s : void 0;
}
function isGone2(e) {
  const c = codeOf2(e);
  return c === "ENOENT" || c === "ENOTDIR";
}
function operational(e) {
  return codeOf2(e) !== void 0 || e instanceof GitCommandError;
}
function errorCode(e) {
  if (e instanceof GitCommandError) return `git:${e.code}`;
  return codeOf2(e) ?? (e instanceof Error ? e.name : "unknown");
}
function isRegular(t) {
  return t === null || t === ABSENT || t.mode === "100644" || t.mode === "100755";
}
var DeferGroup = class extends Error {
  reason;
  /** writeLocal: the disk blob a failed pre-image check found (MISMATCH). */
  found;
  /** writeLocal: a P2 name error (ENAMETOOLONG, EINVAL) is DEFERRED(unmaterializable), not a COLLISION. */
  unmaterializable;
  constructor(reason, o = {}) {
    super(`write group deferred: ${reason}`);
    this.name = "DeferGroup";
    this.reason = reason;
    this.found = o.found;
    this.unmaterializable = o.unmaterializable ?? false;
  }
};
function flight() {
  let finish2;
  const done = new Promise((r) => {
    finish2 = r;
  });
  return { window: false, done, finish: finish2 };
}
function checkEntry2(e) {
  const ok = Number.isSafeInteger(e.slot) && e.slot >= 0 && (e.kind === "create" && e.target !== null || e.kind === "modify" && e.target !== null && e.sRaw !== null || e.kind === "delete" && e.target === null && e.sRaw !== null);
  if (!ok) throw new TypeError(`writer: inconsistent write entry ${JSON.stringify({ path: e.path, kind: e.kind, slot: e.slot })}`);
}
var Writer = class {
  d;
  ring = [];
  stranded = [];
  /** .old files rollbackIntent left for the restart, with their paths: a later move aside of that name logs its path (it is kept, never ringed). */
  leftover = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  /** Paths of the last deferred apply groups not written since (pathState 'pending'). */
  pendingPaths = /* @__PURE__ */ new Set();
  tail = Promise.resolve();
  execBitsP = null;
  /** P2-RINGNAMES: local writes take their tmp/L.<slot>.* slots from this counter (journaled in the local intent). */
  localSlotNext = 0;
  /** Suffixes of ring names (tmp/ring-<k>.<ext>, in memory only); orphan names are ULIDs (orphanAside). */
  asideNext = 0;
  random;
  /**
   * P2-STRANDED: the last local intent this writer journaled is still journaled, narrowed to its stranded entries
   * (P2-NARROW), because its group left a stranded restore; the sweep (or local write) that empties the stranded list
   * journals {kind: 'none'}. A later applyGroups
   * or rollbackIntent call means the caller owns the journal slot again: the flag drops, so the writer never clears
   * an intent it did not journal.
   */
  localHeld = false;
  constructor(d) {
    this.d = d;
    this.random = d.random ?? realRandom;
  }
  /** Ruling P2-NARROW: the module function narrowToStranded (the contract names it Writer.narrowToStranded). */
  static narrowToStranded(intent, results) {
    return narrowToStranded(intent, results);
  }
  /** Whether the volume tracks the exec bit (core.fileMode true, never on Windows), read once (P2-EXECBIT). */
  execBits() {
    this.execBitsP ??= (async () => {
      if (process.platform === "win32") return false;
      const r = await this.d.repo.run(["config", "--type=bool", "--get", "core.filemode"], { okCodes: [0, 1] });
      return r.code !== 0 || r.stdout.toString("utf8").trim() !== "false";
    })();
    return this.execBitsP;
  }
  /**
   * P2-EXECBIT under the user's umask (final review minor, ledger Task 10:207): a file the writer just created exclusively
   * has 0o666 & ~umask; its exec bits become its read bits (umask 022 → 0o755, 077 → 0o700, 002 → 0o775), as git's
   * checkout of a 100755 entry (0o777 & ~umask) gives — never a fixed 0o755 that would widen a private umask.
   */
  async setExec(file) {
    const st = await this.d.fs.lstat(file);
    if (st === null) return;
    const perm = st.mode & 511;
    await this.d.fs.chmod(file, perm | (perm & 292) >> 2);
  }
  /** One writer operation at a time (an apply, a local write, a sweep, a rollback); pathState never waits for it. */
  serial(fn) {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => void 0, () => void 0);
    return run;
  }
  workFile(path) {
    return join6(this.d.workTree, ...path.split("/"));
  }
  names(prefix, slot) {
    const base = join6(this.d.tmpDir, `${prefix}.${slot}`);
    return { new: `${base}.new`, old: `${base}.old`, redo: `${base}.redo` };
  }
  carried(path) {
    return !stageable(path) || this.d.snapshot.isCarried(path);
  }
  async lstatQuiet(p) {
    try {
      return await this.d.fs.lstat(p);
    } catch {
      return null;
    }
  }
  async unlinkQuiet(p) {
    try {
      await this.d.fs.unlink(p);
    } catch (e) {
      if (!isGone2(e)) throw e;
    }
  }
  /** A .old compared with its baseline: every lstat field, but in copy mode (size, mtime_ns) only (P2-COPYSTAT). */
  oldStatEq(a, b) {
    return this.d.mode === "copy" ? a.size === b.size && a.mtimeNs === b.mtimeNs : sameStat(a, b);
  }
  /**
   * P2-NOFOLLOW: every existing ancestor of p below the work-tree root is a real directory (not a symlink, a junction
   * or a file). A missing ancestor ends the walk: mkdir -p creates real directories from there.
   */
  async ancestorsSafe(path) {
    const parts = path.split("/");
    let dir = this.d.workTree;
    for (const c of parts.slice(0, -1)) {
      dir = join6(dir, c);
      let st;
      try {
        st = await this.d.fs.lstat(dir);
      } catch {
        return false;
      }
      if (st === null) return true;
      if (st.isSymbolicLink || !st.isDirectory) return false;
    }
    return true;
  }
  /**
   * A group the writer must not touch at all (deferred 'unmaterializable' before P0): a carried or dotgit-alias path
   * (never looked at), a symlink or gitlink entry, or a path beneath a symlink, a junction or a file (P2-NOFOLLOW).
   */
  async refused(run) {
    if (run.paths.some((p) => this.carried(p.e.path))) return true;
    if (run.paths.some((p) => !isRegular(p.e.target) || !isRegular(p.e.sRaw) || !isRegular(p.e.sDisk) || !isRegular(p.pre))) return true;
    for (const p of run.paths) if (!await this.ancestorsSafe(p.e.path)) return true;
    return false;
  }
  /**
   * Groups of one journaled apply intent (the caller journaled J and called crashpoint('apply.intent')), in order.
   * A deferred group never blocks the others, and a group's failure never discards the results of the groups before
   * it (P2-BESTEFFORT-ROLLBACK): only a programming error or a callback's error is thrown. Neither A nor the state is
   * the writer's: the caller's ENG-36 update follows. A KilledAt from a crashpoint propagates with the disk as it is
   * (rollbackIntent after the restart).
   */
  async applyGroups(groups, remerge) {
    const seen = /* @__PURE__ */ new Set();
    const names = /* @__PURE__ */ new Set();
    for (const g of groups) {
      for (const e of g.entries) {
        checkEntry2(e);
        if (seen.has(e.path)) throw new TypeError(`writer: ${JSON.stringify(e.path)} is in two write entries`);
        seen.add(e.path);
        const k = `${g.n}.${e.slot}`;
        if (names.has(k)) throw new TypeError(`writer: two entries share the temp name ${k}`);
        names.add(k);
      }
    }
    return this.serial(async () => {
      this.localHeld = false;
      await this.restoreStranded(false);
      if (this.stranded.length > 0) this.d.log.write("error", "WRITE_APPLY_WHILE_STRANDED", { stranded: this.stranded.length });
      const flights = groups.map(() => flight());
      groups.forEach((g, i) => {
        for (const e of g.entries) this.inflight.set(e.path, flights[i]);
      });
      const results = [];
      try {
        for (const [i, g] of groups.entries()) {
          if (i > 0) crashpoint("apply.between_groups");
          const run = {
            n: g.n,
            local: false,
            paths: g.entries.map((e) => this.pathRun(e, this.names(String(g.n), e.slot), e.kind === "create" ? null : e.sRaw, e.target))
          };
          const out = await this.runGroup(run, remerge, flights[i]);
          if (out.ok) {
            for (const e of g.entries) this.pendingPaths.delete(e.path);
            results.push({ n: g.n, outcome: "written", reason: null, written: out.written, deleted: out.deleted, phantoms: out.phantoms, stranded: false });
          } else {
            for (const e of g.entries) this.pendingPaths.add(e.path);
            this.d.log.write("info", "WRITE_GROUP_DEFERRED", { n: g.n, reason: out.defer.reason, paths: g.entries.length, stranded: out.stranded });
            results.push({ n: g.n, outcome: "deferred", reason: out.defer.reason, written: [], deleted: [], phantoms: [], stranded: out.stranded });
          }
        }
      } finally {
        groups.forEach((g, i) => this.land(g.entries.map((e) => e.path), flights[i]));
      }
      return results;
    });
  }
  /**
   * Final review FB-1: every temp name (.new, .old, .redo) of the groups is freed BEFORE the caller journals their
   * intent, so rollbackIntent's precondition holds — a file at an intent's .old name after a restart was renamed there
   * by that intent, never a ring .old of an earlier group whose unlink failed or a leftover of an earlier run (whose
   * bytes would otherwise be recorded against, or relinked at, another path). A holder is moved as freeName moves it
   * (a ring entry to tmp/ring-<k>, anything else to a never-reused orphan name, an orphan .old kept); false, with
   * nothing journaled by the caller, when a holder refuses the move (locked) or the move fails.
   */
  reserve(groups) {
    return this.serial(() => this.freeNames(groups.flatMap((g) => g.entries.map((e) => this.names(String(g.n), e.slot)))));
  }
  /** freeName for every name of `files`; false (logged WRITE_RESERVE_FAILED) when a holder cannot be moved. */
  async freeNames(files) {
    try {
      for (const f of files) for (const name of [f.new, f.old, f.redo]) await this.freeName(name);
      return true;
    } catch (e) {
      if (e instanceof KilledAt || !(e instanceof DeferGroup || operational(e))) throw e;
      this.d.log.write("warn", "WRITE_RESERVE_FAILED", { code: e instanceof DeferGroup ? e.reason : errorCode(e) });
      return false;
    }
  }
  pathRun(e, files, pre, target) {
    return {
      e,
      abs: this.workFile(e.path),
      files,
      pre,
      target,
      bytes: null,
      newWritten: false,
      renamed: false,
      oldStat: null,
      oldEntry: null,
      linked: false,
      linkStat: null,
      createdDirs: []
    };
  }
  /** The group's flight ends: waiting gate queries get their answer. */
  land(paths, f) {
    for (const p of paths) if (this.inflight.get(p) === f) this.inflight.delete(p);
    f.finish();
  }
  /**
   * P0–P2 with a best-effort ROLLBACK on any failure (reported as a deferral: an fs condition or a failed git process
   * never throws), then the ring, then RT. A KilledAt is never rolled back here (a kill leaves the disk as it is).
   */
  async runGroup(run, remerge, f) {
    try {
      if (await this.refused(run)) return { ok: false, defer: new DeferGroup("unmaterializable"), stranded: false };
      let failed = false;
      let failure;
      try {
        await this.prepare(run);
        f.window = true;
        await this.phase1(run, remerge);
        crashpoint("apply.group.phase1");
        await this.d.scheduler.yieldPoint("apply.beforePhase2");
        await this.phase2(run);
      } catch (e) {
        if (e instanceof KilledAt) throw e;
        failed = true;
        failure = e;
      }
      if (failed) {
        const defer = failure instanceof DeferGroup ? failure : asDefer(failure);
        const rb = await this.rollback(run);
        if (rb.failed > 0) this.d.log.write("error", "WRITE_ROLLBACK_PARTIAL", { n: run.n, failed: rb.failed, stranded: rb.stranded });
        if (defer === null) throw failure;
        if (!(failure instanceof DeferGroup)) this.d.log.write("error", "WRITE_GROUP_ERROR", { n: run.n, code: errorCode(failure), reason: defer.reason });
        return { ok: false, defer, stranded: rb.stranded > 0 };
      }
      for (const p of run.paths) if (p.renamed) await this.toRing(p);
      await this.dropNews(run);
      const rt = await this.roundTrip(run);
      crashpoint("apply.group.phase2");
      return { ok: true, ...rt };
    } finally {
      f.window = false;
      this.land(run.paths.map((p) => p.e.path), f);
    }
  }
  // ---- P0 ----
  async prepare(run) {
    const writes = run.paths.filter((p) => p.target !== null);
    if (writes.length === 0) return;
    const bufs = await this.smudge(writes.map((p) => ({ oid: p.target.oid, path: p.e.path })));
    for (const [i, p] of writes.entries()) await this.writeNew(p, bufs[i]);
  }
  /** One `cat-file --batch --filters` call (R-36); a refusing smudge filter (required=true) defers filter_failure. */
  async smudge(items) {
    try {
      return await this.d.repo.smudgeBlobs(items);
    } catch (e) {
      if (e instanceof GitCommandError) throw new DeferGroup("filter_failure");
      throw e;
    }
  }
  /**
   * tmp/…new by an exclusive create — one write and an fsync before it can be linked into place — then the exec bit
   * from the target's mode (a fresh file never has it: 100644 needs nothing). This run's own earlier .new (a
   * re-merge retarget) is replaced; a holder from an earlier run is moved aside (freeName), never written through.
   */
  async writeNew(p, bytes) {
    p.bytes = bytes;
    try {
      if (p.newWritten) {
        await this.unlinkQuiet(p.files.new);
        p.newWritten = false;
      } else {
        await this.freeName(p.files.new);
      }
      try {
        await this.d.fs.writeFileExclusive(p.files.new, bytes);
      } catch (e) {
        if (codeOf2(e) !== "EEXIST" && syscallOf(e) !== "open") p.newWritten = true;
        throw e;
      }
      p.newWritten = true;
      if (p.target?.mode === "100755" && await this.execBits()) await this.setExec(p.files.new);
    } catch (e) {
      if (codeOf2(e) === "ENOSPC") throw new DeferGroup("disk_low");
      throw e;
    }
  }
  // ---- P1 ----
  async phase1(run, remerge) {
    for (const p of run.paths) {
      if (p.pre === null) await this.checkCreate(p);
      else await this.checkPreimage(run, p, remerge);
    }
  }
  /**
   * Creations only into ENOENT: anything at p (untracked, ignored, a directory, a case variant) defers race, untouched.
   * First DISK_EQ's refusals, as for a modify (final review minor): a filtered path whose driver is over the cap or
   * undiscovered (P2-DRIVERCAP / P2-SNAPFILTERS) defers filter_failure — its P0 smudge ran without required=true and
   * may be the stored form — and a carried path unmaterializable.
   */
  async checkCreate(p) {
    const refused = await this.d.diskEq.refusal(p.e.path);
    if (refused !== null) throw new DeferGroup(deferFor(refused));
    let st;
    try {
      st = await this.d.fs.lstat(p.abs);
    } catch {
      throw new DeferGroup("unreadable");
    }
    if (st !== null) throw new DeferGroup("race");
  }
  /**
   * DISK_EQ(p, pre) bracketed by two equal lstats (st0 is the stat the comparison validated), then the rename to .old.
   * Not equal: the current bytes are re-snapshotted (raw blob r, a stage copy only) — still the pre-image under canon →
   * check again against r; else (apply) found := canon(r, S_disk[p]) and the caller's re-merge of M_disk[p] becomes
   * the target, ≤ MAX_REMERGE times; (local) MISMATCH(r).
   */
  async checkPreimage(run, p, remerge) {
    let pre = p.pre;
    let fast = run.local ? null : p.e.sRaw;
    for (let failures = 0; ; failures++) {
      if (pre === ABSENT) {
        if (await this.lstatQuiet(p.abs) === null) return;
      } else {
        const st1 = await this.lstatQuiet(p.abs);
        const r = await this.d.diskEq.eq(p.e.path, pre, fast);
        const st0 = await this.lstatQuiet(p.abs);
        if (r.equal && st1 !== null && st0 !== null && sameStat(st1, st0)) {
          p.oldEntry = pre;
          await this.renameToOld(p, st0);
          return;
        }
        if (!r.equal && r.reason !== "differs") throw new DeferGroup(deferFor(r.reason));
      }
      fast = null;
      const m = await this.d.diskEq.manyCandidates(p.e.path, pre === ABSENT ? [] : [pre]);
      if (m.read === "missing") throw new DeferGroup("mismatch", { found: ABSENT });
      if (m.read !== "ok") throw new DeferGroup(deferFor(m.read));
      if (m.raw === null) throw new DeferGroup("filter_failure");
      const rawEntry = { path: p.e.path, mode: pre === ABSENT ? "100644" : pre.mode, oid: m.raw };
      if (m.match === null) {
        if (run.local || remerge === null) throw new DeferGroup("mismatch", { found: m.raw });
        if (failures >= MAX_REMERGE || p.e.kind === "delete" || p.e.sDisk === null) throw new DeferGroup("mismatch");
        const merged = await remerge(p.e, await this.found(p.e, m.raw));
        if (merged === null) throw new DeferGroup("mismatch");
        await this.retarget(p, merged);
      } else if (failures >= MAX_REMERGE) {
        throw new DeferGroup("mismatch");
      }
      pre = rawEntry;
    }
  }
  /**
   * found := canon(r, ref = S_disk[p]) in stored form (route (c) -w); r itself when canon refuses, and r as it is for a
   * filtered or non-text path (D1 step 1: canon applies only to text, unfiltered paths).
   */
  async found(e, raw) {
    const sDisk = e.sDisk;
    if (this.d.isFiltered(e.path) || !this.d.isText(e.path)) return { path: e.path, mode: sDisk.mode, oid: raw };
    const [rBytes, refBytes] = await this.d.repo.readBlobs([raw, sDisk.oid]);
    const c = canon(rBytes, refBytes, false);
    const oid2 = c.ok && !c.out.equals(rBytes) ? await this.d.repo.hashBytes(c.out, true) : raw;
    return { path: e.path, mode: sDisk.mode, oid: oid2 };
  }
  /** The re-merge becomes what P2 writes: its bytes by one more smudge call (this path only). */
  async retarget(p, merged) {
    const target = { path: p.e.path, mode: merged.mode, oid: merged.oid };
    const [bytes] = await this.smudge([{ oid: target.oid, path: p.e.path }]);
    p.target = target;
    await this.writeNew(p, bytes);
  }
  /** rename p → .old (a free name), then lstat(.old) must be st0 (size, mtime_ns, file id, mode; copy mode: size and mtime_ns). */
  async renameToOld(p, st0) {
    await this.freeName(p.files.old);
    try {
      await this.d.fs.rename(p.abs, p.files.old);
    } catch (e) {
      const c = codeOf2(e);
      if (c !== void 0 && LOCKED_CODES.has(c)) throw new DeferGroup("locked");
      if (isGone2(e)) throw new DeferGroup("mismatch");
      throw e;
    }
    p.renamed = true;
    const so = await this.lstatQuiet(p.files.old);
    p.oldStat = so;
    if (so === null || !this.oldStatEq(so, st0)) throw new DeferGroup("mismatch");
  }
  /**
   * A writer name must be free before a rename or an exclusive create targets it. A holder is never deleted or
   * written through: it is renamed to a free moved-aside name in tmp/ and tracked there — a ring entry keeps its
   * path, baseline and 2 s window under a ring name (P2-RINGNAMES); a stranded .old keeps its restore under a
   * never-reused orphan name with a WRITE_TMP_ORPHAN{file, path} line naming its known path (never a ring name: after
   * a crash a ring name ages out, and this is the only copy of a file whose restore never completed); anything else is
   * an orphan of an earlier run under an orphan name (P2-ORPHANS, P2-ORPHANNAMES): a .new or .redo is ringed from now
   * (deleted once unchanged for 2 s), a .old is only moved and logged — never ringed or deleted (P2-STRANDED: whether
   * or not rollbackIntent reported its path, it can be the only copy of a file whose restore never completed; the
   * restart's many-candidates step or a human resolves it). A holder that refuses the move defers the group locked.
   */
  async freeName(file) {
    if (await this.d.fs.lstat(file) === null) return;
    const ring = this.ring.find((r) => r.file === file);
    const stranded = this.stranded.find((s) => s.old === file);
    const ext = file.slice(file.lastIndexOf(".") + 1);
    const aside = ring !== void 0 ? await this.ringName(ext) : await orphanAside(this.d.fs, this.random, this.d.clock, this.d.tmpDir, ext);
    try {
      await this.d.fs.rename(file, aside);
    } catch (e) {
      if (isGone2(e)) return;
      const c = codeOf2(e);
      if (c !== void 0 && LOCKED_CODES.has(c)) throw new DeferGroup("locked");
      throw e;
    }
    if (ring !== void 0) {
      ring.file = aside;
    } else if (stranded !== void 0) {
      stranded.old = aside;
      this.d.log.write("warn", "WRITE_TMP_ORPHAN", { file: aside, path: stranded.path, kept: true });
    } else {
      const path = this.leftover.get(file) ?? null;
      this.leftover.delete(file);
      const kept = ext === "old";
      if (!kept) this.ring.push({ path: null, file: aside, stat: await this.baseline(aside), sinceMono: this.d.clock.monoMs() });
      this.d.log.write("warn", "WRITE_TMP_ORPHAN", { file: aside, path, kept });
    }
  }
  /** A free tmp/ring-<k>.<ext> name (a ring entry's, tracked in memory). */
  async ringName(ext) {
    for (; ; ) {
      const name = join6(this.d.tmpDir, `ring-${this.asideNext++}.${ext}`);
      if (await this.d.fs.lstat(name) === null) return name;
    }
  }
  /** A ring baseline: the file's lstat, or null (no baseline: the sweep reads it as changed) when lstat fails. */
  async baseline(file) {
    try {
      return await this.d.fs.lstat(file);
    } catch {
      return null;
    }
  }
  // ---- P2 ----
  async phase2(run) {
    const writes = run.paths.filter((p) => p.target !== null);
    for (const [i, p] of writes.entries()) {
      if (i > 0) crashpoint("apply.group.mid");
      await this.place(p);
    }
    for (const p of run.paths) if (p.target === null && p.renamed) await this.removeEmptyParents(p.abs);
  }
  /**
   * link .new → p (or the copy fallback's exclusive create); p's stat is taken at once, so a failure after it still
   * finds p as the writer's own. The .new is then dropped; a failing unlink is not fatal (the bytes are at p) and is
   * retried after the group.
   */
  async place(p) {
    const target = p.target;
    try {
      await this.mkdirParents(p);
      if (this.d.mode === "link") {
        await this.d.fs.link(p.files.new, p.abs);
        p.linked = true;
        p.linkStat = await this.lstatQuiet(p.abs);
      } else {
        try {
          await this.d.fs.writeFileExclusive(p.abs, p.bytes);
        } catch (e) {
          if (codeOf2(e) !== "EEXIST" && syscallOf(e) !== "open") {
            const st = await this.lstatQuiet(p.abs);
            if (st !== null) {
              p.linked = true;
              p.linkStat = st;
            }
          }
          throw e;
        }
        p.linked = true;
        p.linkStat = await this.lstatQuiet(p.abs);
        if (target.mode === "100755" && await this.execBits()) {
          await this.setExec(p.abs);
          p.linkStat = await this.lstatQuiet(p.abs);
        }
      }
    } catch (e) {
      throw p2Defer(e);
    }
    await this.dropNew(p);
  }
  async dropNew(p) {
    if (!p.newWritten) return;
    try {
      await this.unlinkQuiet(p.files.new);
      p.newWritten = false;
    } catch (e) {
      this.d.log.write("warn", "WRITE_NEW_LEFT", { path: p.e.path, code: errorCode(e) });
    }
  }
  /** After a written group: a .new whose unlink failed in P2 is tried once more (a later freeName moves it aside). */
  async dropNews(run) {
    for (const p of run.paths) await this.dropNew(p);
  }
  /** mkdir -p of p's parent, recording every directory it creates (the rollback removes them again). */
  async mkdirParents(p) {
    const missing = [];
    for (let dir = dirname(p.abs); dir.length > this.d.workTree.length && dir.startsWith(this.d.workTree); dir = dirname(dir)) {
      if (await this.d.fs.lstat(dir) !== null) break;
      missing.push(dir);
    }
    if (missing.length === 0) return;
    await this.d.fs.mkdirp(dirname(p.abs));
    p.createdDirs.push(...missing);
  }
  /** Non-recursive rmdir of p's emptied parents up to (never including) the work-tree root. */
  async removeEmptyParents(abs) {
    for (let dir = dirname(abs); dir.length > this.d.workTree.length && dir.startsWith(this.d.workTree); dir = dirname(dir)) {
      if (!await this.rmdirReal(dir)) return;
    }
  }
  /** Non-recursive rmdir of a real directory only (P2-NOFOLLOW: never a symlink or a junction); false when nothing was removed. */
  async rmdirReal(dir) {
    try {
      const st = await this.d.fs.lstat(dir);
      if (st === null || st.isSymbolicLink || !st.isDirectory) return false;
      await this.d.fs.rmdir(dir);
      return true;
    } catch {
      return false;
    }
  }
  // ---- RT ----
  /**
   * ENG-34 per path. Apply: the private-index entry := the written target (`--index-info`), then DISK_EQ(p, target)
   * through a staged read; equal → the stat cache takes the post-write lstat as clean; not equal → MANY CANDIDATES:
   * a canon match puts the raw blob in the private index, no match is a PHANTOM. A deletion is force-removed from the
   * private index. A local write (ENG-37) is a local edit the next snapshot must pick up: the private index and the
   * stat cache are left alone, only the phantom check runs. A path that cannot be read back right now (unstable,
   * unreadable) or whose round trip meets an fs or git error gets no verdict and is not marked clean.
   */
  async roundTrip(run) {
    const written = [];
    const deleted = [];
    const phantoms = [];
    for (const p of run.paths) {
      const path = p.e.path;
      if (p.target === null) {
        if (!run.local) {
          try {
            await this.d.repo.editIndex(this.d.privateIndex, [{ path, remove: true }]);
            if (await this.lstatQuiet(p.abs) === null) this.d.statCache.delete(path);
          } catch (e) {
            this.rtError(path, e);
          }
        }
        deleted.push(path);
        continue;
      }
      const target = p.target;
      let phantom = false;
      try {
        phantom = await this.isPhantom(run, p, target);
      } catch (e) {
        this.rtError(path, e);
      }
      if (phantom) {
        phantoms.push(path);
        this.d.log.write("warn", "PHANTOM", { path });
        await this.d.onPhantom(path, target);
      } else {
        written.push(target);
      }
    }
    return { written, deleted, phantoms };
  }
  /** RT of one written path: true only when its bytes were read back and match no candidate (a PHANTOM). */
  async isPhantom(run, p, target) {
    const path = p.e.path;
    if (!run.local) await this.d.repo.editIndex(this.d.privateIndex, [{ path, mode: target.mode, oid: target.oid }]);
    const st1 = await this.lstatQuiet(p.abs);
    const r = await this.d.diskEq.eq(path, target, null);
    const st2 = await this.lstatQuiet(p.abs);
    if (r.equal) {
      if (!run.local && st1 !== null && st2 !== null && sameStat(st1, st2)) this.d.snapshot.markClean(path, st2, target.oid);
      return false;
    }
    if (r.reason !== "differs") return false;
    const st3 = await this.lstatQuiet(p.abs);
    const m = await this.d.diskEq.manyCandidates(path, [target]);
    const st4 = await this.lstatQuiet(p.abs);
    if (m.read === "ok" && m.match !== null && m.raw !== null) {
      if (!run.local) {
        await this.d.repo.editIndex(this.d.privateIndex, [{ path, mode: target.mode, oid: m.raw }]);
        if (st3 !== null && st4 !== null && sameStat(st3, st4)) this.d.snapshot.markClean(path, st4, m.raw);
      }
      return false;
    }
    return m.read === "ok";
  }
  /** An RT step's fs or git error: logged, the path stays unverified. Anything else (a programming error) is thrown. */
  rtError(path, e) {
    if (e instanceof KilledAt || !operational(e)) throw e;
    this.d.log.write("error", "WRITE_RT_ERROR", { path, code: errorCode(e) });
  }
  // ---- ROLLBACK ----
  /**
   * ROLLBACK(g), best effort per path (P2-BESTEFFORT-ROLLBACK): a failing step never stops the others and nothing is
   * thrown; the count of failed steps is returned. Every .new goes first (in copy mode its space comes back before
   * the restores). A linked path whose stat is still the post-link stat goes to .redo and its .old comes back
   * (link-no-replace, or an exclusive create from the .old bytes in copy mode); when a holder refuses the move to
   * .redo, p stays as written and its .old (S_raw bytes, already in git) goes to the ring; a linked path someone wrote
   * since stays as written and its .old goes to the ring; every path renamed but not linked gets its .old back; a
   * created path is removed if still ours; every .redo and every directory the group created goes (never a symlink or
   * a junction). A .old that cannot be put back (p absent) stays at its intent name, is retried by every later writer
   * operation and is counted in `stranded` (the group reports it: P2-STRANDED).
   */
  async rollback(run) {
    let failed = 0;
    let stranded = 0;
    const step = async (what, path, fn) => {
      try {
        await fn();
        return true;
      } catch (e) {
        if (e instanceof KilledAt) throw e;
        failed++;
        this.d.log.write("error", "WRITE_ROLLBACK_STEP", { step: what, path, code: errorCode(e) });
        return false;
      }
    };
    for (const p of run.paths) {
      if (p.newWritten && await step("unlink_new", p.e.path, () => this.unlinkQuiet(p.files.new))) p.newWritten = false;
    }
    for (const p of run.paths) {
      const path = p.e.path;
      if (p.linked) {
        const now = await this.lstatQuiet(p.abs);
        const ours = now !== null && p.linkStat !== null && sameStat(now, p.linkStat);
        if (!p.renamed) {
          if (ours) await step("remove_created", path, () => this.unlinkQuiet(p.abs));
        } else if (!ours) {
          await this.toRing(p);
        } else {
          const moved = await step("to_redo", path, async () => {
            await this.freeName(p.files.redo);
            await this.d.fs.rename(p.abs, p.files.redo);
          });
          if (!moved) {
            await this.toRing(p);
          } else if (!await this.restoreOld(p)) {
            failed++;
            stranded++;
          }
          await step("unlink_redo", path, () => this.unlinkQuiet(p.files.redo));
        }
      } else if (p.renamed) {
        if (!await this.restoreOld(p)) {
          failed++;
          stranded++;
        }
      }
      for (const dir of p.createdDirs) if (!await this.rmdirReal(dir)) break;
    }
    return { failed, stranded };
  }
  /** The .old back at p; someone created p meanwhile → the .old goes to the ring; a failed restore → stranded (retried). false only for a failure. */
  async restoreOld(p) {
    const r = await this.relink(p.e.path, p.files.old, p.abs);
    if (r.kind === "exists") {
      await this.toRing(p);
    } else if (r.kind === "failed") {
      this.stranded.push({ path: p.e.path, abs: p.abs, old: p.files.old, reason: r.reason, pre: p.oldEntry });
      this.d.log.write("error", "WRITE_OLD_STRANDED", { path: p.e.path, reason: r.reason });
    }
    return r.kind !== "failed";
  }
  /**
   * Puts `old` back at abs without replacing anything (a hard link, or in copy mode an exclusive create from its
   * bytes), then drops `old`: 'ok'. 'exists': something is at abs (nothing changed). 'failed': abs is beneath a
   * symlink or junction (P2-NOFOLLOW: unmaterializable), or the restore failed (ENOSPC: disk_low, else locked); the
   * partial file of a failed exclusive create is removed and `old` stays.
   */
  async relink(path, old, abs) {
    try {
      if (!await this.ancestorsSafe(path)) return { kind: "failed", reason: "unmaterializable" };
      if (await this.d.fs.lstat(dirname(abs)) === null) await this.d.fs.mkdirp(dirname(abs));
      if (this.d.mode === "link") {
        await this.d.fs.link(old, abs);
      } else {
        const st = await this.d.fs.lstat(old);
        const bytes = await this.d.fs.readFile(old);
        try {
          await this.d.fs.writeFileExclusive(abs, bytes);
        } catch (e) {
          if (codeOf2(e) !== "EEXIST" && syscallOf(e) !== "open") await this.unlinkQuiet(abs);
          throw e;
        }
        if (st !== null && (st.mode & 64) !== 0 && await this.execBits()) await this.d.fs.chmod(abs, st.mode & 511);
      }
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      if (codeOf2(e) === "EEXIST") return { kind: "exists" };
      this.d.log.write("error", "WRITE_RELINK_FAILED", { path, code: errorCode(e) });
      return { kind: "failed", reason: codeOf2(e) === "ENOSPC" ? "disk_low" : "locked" };
    }
    try {
      await this.unlinkQuiet(old);
    } catch (e) {
      this.d.log.write("warn", "WRITE_OLD_LEFT", { path, code: errorCode(e) });
    }
    return { kind: "ok" };
  }
  /**
   * Final review FB-3: a stranded p whose .old vanished, back from the blob the .old held (one smudge, an exclusive create
   * of p, the exec bit from its mode): 'ok' (WRITE_OLD_RESTORED_FROM_BLOB); 'exists' when something is at p by now (it
   * is left as it is; p is not absent any more); 'failed' — no blob is known, p is beneath a symlink or junction
   * (unmaterializable), the smudge failed (filter_failure), ENOSPC (disk_low) or any other fs error (locked) — keeps the
   * entry stranded.
   */
  async restoreFromBlob(s) {
    if (s.pre === null) return { kind: "failed", reason: s.reason };
    try {
      if (!await this.ancestorsSafe(s.path)) return { kind: "failed", reason: "unmaterializable" };
      const [bytes] = await this.d.repo.smudgeBlobs([{ oid: s.pre.oid, path: s.path }]);
      if (await this.d.fs.lstat(dirname(s.abs)) === null) await this.d.fs.mkdirp(dirname(s.abs));
      try {
        await this.d.fs.writeFileExclusive(s.abs, bytes);
      } catch (e) {
        if (codeOf2(e) !== "EEXIST" && syscallOf(e) !== "open") await this.unlinkQuiet(s.abs);
        throw e;
      }
      if (s.pre.mode === "100755" && await this.execBits()) await this.setExec(s.abs);
    } catch (e) {
      if (e instanceof KilledAt || !operational(e)) throw e;
      if (codeOf2(e) === "EEXIST") return { kind: "exists" };
      this.d.log.write("error", "WRITE_OLD_BLOB_RESTORE_FAILED", { path: s.path, code: errorCode(e) });
      return { kind: "failed", reason: e instanceof GitCommandError ? "filter_failure" : codeOf2(e) === "ENOSPC" ? "disk_low" : "locked" };
    }
    this.d.log.write("warn", "WRITE_OLD_RESTORED_FROM_BLOB", { path: s.path });
    return { kind: "ok" };
  }
  /** The path's .old into the ring, with its post-rename stat, else a fresh lstat (none if it is gone; no baseline if lstat fails). */
  async toRing(p) {
    let stat = p.oldStat;
    if (stat === null) {
      try {
        stat = await this.d.fs.lstat(p.files.old);
        if (stat === null) return;
      } catch {
        stat = null;
      }
    }
    this.ring.push({ path: p.e.path, file: p.files.old, stat, sinceMono: this.d.clock.monoMs() });
  }
  /**
   * Every stranded .old: back at p when possible; when something is at p by now, the .old goes to the ring. `clear`
   * (sweepRing and writeLocal, where the journal slot is still the writer's): once the list is empty, a local intent
   * kept for it is cleared by journaling {kind: 'none'} (P2-STRANDED). applyGroups never clears: the caller's apply
   * intent is journaled by then.
   */
  async restoreStranded(clear) {
    if (this.stranded.length > 0) {
      const left = [];
      for (const s of this.stranded) {
        let st;
        try {
          st = await this.d.fs.lstat(s.old);
        } catch {
          left.push(s);
          continue;
        }
        if (st === null) {
          const r2 = await this.restoreFromBlob(s);
          if (r2.kind === "failed") {
            s.reason = r2.reason;
            left.push(s);
          }
          continue;
        }
        const r = await this.relink(s.path, s.old, s.abs);
        if (r.kind === "exists") {
          this.ring.push({ path: s.path, file: s.old, stat: st, sinceMono: this.d.clock.monoMs() });
        } else if (r.kind === "failed") {
          s.reason = r.reason;
          left.push(s);
        } else {
          this.d.log.write("info", "WRITE_OLD_RESTORED", { path: s.path });
        }
      }
      this.stranded = left;
    }
    if (clear && this.localHeld && this.stranded.length === 0) {
      await this.d.journal({ kind: "none" });
      this.localHeld = false;
      this.d.log.write("info", "WRITE_LOCAL_INTENT_CLEARED", {});
    }
  }
  /**
   * P2-STRANDED: the paths whose rollback restore is still stranded (p absent, its .old kept at its intent name). While
   * this is non-empty the caller journals no new intent (no apply, no push, no other local write); once it is empty
   * after a sweepRing(), the caller clears the narrowed apply intent it kept for GroupResult.stranded
   * (narrowToStranded, P2-NARROW; a kept local intent is narrowed and cleared by the writer itself).
   */
  strandedPaths() {
    return this.stranded.map((s) => s.path);
  }
  /**
   * Final review FD: the stranded restores with the file holding each one's bytes now (copies). p stays absent until a
   * sweep relinks that file (or, when it vanished, restores `pre`: FB-3), so a lost-state rebuild or a recover re-anchor
   * reads p's bytes there (01-engine §3.3 DISK_EQ form (3)) instead of leaving p undecided (ENG-54).
   */
  strandedRestores() {
    return this.stranded.map((s) => ({ path: s.path, old: s.old, pre: s.pre }));
  }
  // ---- ring ----
  /** .old ≥ RING_KEEP_MS Δmono: stat-compare with its baseline; a late write → onLateWrite (staged read, stage copy); delete. Stranded restores are retried first (P2-STRANDED: see strandedPaths). */
  sweepRing() {
    return this.serial(async () => {
      await this.restoreStranded(true);
      const now = this.d.clock.monoMs();
      const keep = [];
      for (const r of this.ring) {
        if (now - r.sinceMono < RING_KEEP_MS || !await this.resolveRing(r)) keep.push(r);
      }
      this.ring = keep;
    });
  }
  /**
   * true when the entry is done: the file deleted (after onLateWrite for a late write), gone, or — an orphan .new or
   * .redo (path null; an orphan .old is never ringed) that changed — kept on disk as it is (no record could name its
   * bytes); false to retry later.
   */
  async resolveRing(r) {
    let st;
    try {
      st = await this.d.fs.lstat(r.file);
    } catch {
      return false;
    }
    if (st === null) return true;
    if (r.stat === null || !this.oldStatEq(st, r.stat)) {
      if (r.path === null) {
        this.d.log.write("warn", "RING_ORPHAN_CHANGED", { file: r.file });
        return true;
      }
      const read = await stagedRead(this.d.fs, r.file);
      if (read.kind === "missing") return true;
      if (read.kind !== "ok") return false;
      const path = r.path;
      await this.withStageCopy(path, read.bytes, (copy) => this.d.onLateWrite(path, copy));
      this.d.log.write("warn", "RING_LATE_WRITE", { path });
    }
    try {
      await this.d.fs.unlink(r.file);
    } catch (e) {
      return isGone2(e);
    }
    return true;
  }
  /** The stage copy of path for one call; a dirty copy the snapshot keeps for p is put back as it was. */
  async withStageCopy(path, bytes, fn) {
    let saved = null;
    if (this.d.statCache.get(path)?.state === "dirty") {
      try {
        saved = await this.d.fs.readFile(this.d.stage.abs(path));
      } catch (e) {
        if (!isGone2(e)) throw e;
      }
    }
    const copy = await this.d.stage.write(path, bytes);
    try {
      await fn(copy);
    } finally {
      if (saved !== null) await this.d.stage.write(path, saved);
      else await this.d.stage.remove(path);
    }
  }
  // ---- writeLocal ----
  writeLocal(path, expected, target, origin, humanEvidence) {
    return this.writeLocalGroup([{ path, expected, target }], origin, humanEvidence);
  }
  /**
   * ENG-37: the same writer for a local-origin write, all or none. FROZEN while a FREEZE reason is set unless the
   * request carries human evidence; a carried path is DEFERRED(unmaterializable) before anything is looked at; free
   * space ≥ 2 × bytes + 256 MB else DEFERRED(disk_low). Then a local intent is journaled, the group runs with the
   * pre-image DISK_EQ(path, expected) (ABSENT: ENOENT; something there → COLLISION) and no re-merge (MISMATCH(found)),
   * and the intent is cleared. Never changes A, LA_C or LA_B (or the private index: the next snapshot sees the edit).
   * P2-STRANDED: when the group's rollback strands a restore, the local intent stays journaled (the only durable name
   * of that .old), narrowed to its stranded entries (P2-NARROW: a restart never rolls back an entry this rollback
   * already undid; a stranded delete is kept as a restore, target := expected, P2-NARROW-DELETE), and the sweep that
   * restores p clears it; while any restore is stranded a local write journals nothing and is DEFERRED with the
   * stranded restore's reason.
   */
  async writeLocalGroup(entries, origin, humanEvidence = false) {
    if (entries.length === 0) throw new TypeError("writer: writeLocalGroup needs at least one entry");
    if (new Set(entries.map((e) => e.path)).size !== entries.length) throw new TypeError("writer: a path appears twice in one local group");
    if (this.d.frozen() && !humanEvidence) return { kind: "FROZEN" };
    if (entries.some((e) => this.carried(e.path))) return { kind: "DEFERRED", reason: "unmaterializable" };
    const targets = entries.flatMap((e) => e.target === "DELETE" ? [] : [e.target]);
    for (const t of targets) {
      if (!await this.d.repo.hasObject(t, "blob")) throw new Error(`writer: writeLocal target ${t} is not a blob (ENG-09)`);
    }
    const bytes = (await this.d.repo.blobSizes(targets)).reduce((a, b) => a + b, 0);
    const free = await this.d.fs.freeBytes(this.d.workTree);
    if (free !== null && free < 2 * bytes + FREE_SPACE_MARGIN_BYTES) return { kind: "DEFERRED", reason: "disk_low" };
    return this.serial(() => this.runLocal(entries, origin));
  }
  async runLocal(entries, origin) {
    await this.restoreStranded(true);
    const waiting = this.stranded[0];
    if (waiting !== void 0) {
      this.d.log.write("warn", "WRITE_LOCAL_STRANDED_WAIT", { stranded: this.stranded.length, reason: waiting.reason });
      return { kind: "DEFERRED", reason: waiting.reason };
    }
    const index = await this.d.repo.listIndex(this.d.privateIndex);
    if (entries.some((x) => !isRegular(index.get(x.path) ?? null))) return { kind: "DEFERRED", reason: "unmaterializable" };
    const slots = entries.map(() => this.localSlotNext++);
    const paths = entries.map((x, i) => {
      const slot = slots[i];
      const cur = index.get(x.path)?.mode;
      const mode = cur === "100755" ? "100755" : "100644";
      const kind = x.target === "DELETE" ? "delete" : x.expected === ABSENT ? "create" : "modify";
      const target = x.target === "DELETE" ? null : { path: x.path, mode, oid: x.target };
      const pre = kind === "create" ? null : x.expected === ABSENT ? ABSENT : { path: x.path, mode, oid: x.expected };
      const e = { path: x.path, kind, slot, target, sRaw: null, sDisk: null };
      return this.pathRun(e, this.names(LOCAL_PREFIX2, slot), pre, target);
    });
    const intent = { kind: "local", origin, entries: entries.map((x, i) => ({ path: x.path, expected: x.expected, target: x.target, slot: slots[i] })) };
    if (!await this.freeNames(paths.map((p) => p.files))) return { kind: "LOCKED" };
    await this.d.journal(intent);
    const f = flight();
    for (const p of paths) this.inflight.set(p.e.path, f);
    const out = await this.runGroup({ n: 0, paths, local: true }, null, f);
    if (this.stranded.length > 0) {
      const kept = narrowLocal(intent, new Set(this.stranded.map((s) => s.path)));
      if (kept.kind === "local" && kept !== intent) await this.d.journal(kept);
      this.localHeld = true;
      this.d.log.write("error", "WRITE_LOCAL_INTENT_KEPT", { origin, stranded: this.stranded.length, entries: kept.kind === "local" ? kept.entries.length : 0 });
    } else {
      await this.d.journal({ kind: "none" });
    }
    if (out.ok) return out.phantoms.length > 0 ? { kind: "PHANTOM" } : { kind: "WRITTEN" };
    const d = out.defer;
    if (d.reason === "locked") return { kind: "LOCKED" };
    if (d.reason === "race") return d.unmaterializable ? { kind: "DEFERRED", reason: "unmaterializable" } : { kind: "COLLISION" };
    if (d.reason === "mismatch" && d.found !== void 0) return { kind: "MISMATCH", found: d.found };
    return { kind: "DEFERRED", reason: d.reason };
  }
  // ---- restart ----
  /**
   * ENG-53 step 4 (writer rollback of a journaled apply or local intent), best effort per path: a failing step is
   * logged and its .old reported, nothing is thrown. Per path, "linked" is DISK_EQ(p, target) (targets: M_disk[p] or
   * newBlob; null = a deletion, linked when p is absent while its .old exists). A group whose paths are all linked is
   * complete; any other group is rolled back completely: a linked modify goes to .redo and its .old is linked back,
   * an absent p gets its .old back, a linked create is removed, anything else at p stays. Every .new and .redo of the
   * intent is deleted; the .old files that remain (complete groups, beside a path that stayed, or a restore that
   * failed) are reported for the restart's many-candidates step and leave the ring. Carried paths are never looked at;
   * a path beneath a symlink or junction (P2-NOFOLLOW) is never touched. The intent is the caller's from here: a local
   * intent this writer kept (P2-STRANDED) is never cleared by the writer afterwards. A kept local intent holds a
   * stranded delete as a restore (target := expected, P2-NARROW-DELETE): with p absent it is an unlinked modify, so
   * its group is rolled back and the .old relinked; with p back at expected it is linked; anything else at p stays
   * and the .old is reported.
   */
  rollbackIntent(intent, targets) {
    return this.serial(async () => {
      this.localHeld = false;
      const report2 = { complete: [], rolledBack: [], leftoverOld: [] };
      const groups = intent.kind === "apply" ? intent.groups.map((g) => ({ n: g.n, items: g.entries.map((e) => ({ path: e.path, kind: e.kind, noop: false, files: this.names(String(g.n), e.slot) })) })) : intent.kind === "local" ? [{ n: 0, items: intent.entries.map((e) => ({
        path: e.path,
        kind: e.target === "DELETE" ? "delete" : e.expected === ABSENT ? "create" : "modify",
        noop: e.target === "DELETE" && e.expected === ABSENT,
        files: this.names(LOCAL_PREFIX2, e.slot)
      })) }] : [];
      const leave = (it) => {
        report2.leftoverOld.push({ path: it.path, file: it.files.old });
      };
      const fail3 = (what, path, e) => {
        if (e instanceof KilledAt) throw e;
        this.d.log.write("error", "ROLLBACK_INTENT_STEP", { step: what, path, code: errorCode(e) });
      };
      for (const g of groups) {
        const state = [];
        for (const it of g.items) {
          const abs = this.workFile(it.path);
          if (this.carried(it.path)) {
            state.push({ it, abs, linked: false, old: false, skip: true });
            continue;
          }
          const old = await this.lstatQuiet(it.files.old) !== null;
          if (!await this.ancestorsSafe(it.path)) {
            state.push({ it, abs, linked: false, old, skip: true });
            continue;
          }
          let linked = false;
          try {
            if (it.kind === "delete") {
              linked = await this.lstatQuiet(abs) === null && (old || it.noop);
            } else {
              const t = targets.get(it.path) ?? null;
              linked = t !== null && (await this.d.diskEq.eq(it.path, t, null)).equal;
            }
          } catch (e) {
            fail3("look", it.path, e);
          }
          state.push({ it, abs, linked, old, skip: false });
        }
        if (state.every((s) => s.linked)) {
          report2.complete.push(g.n);
          for (const s of state) if (s.old) leave(s.it);
        } else {
          report2.rolledBack.push(g.n);
          for (const s of state) {
            if (s.skip) {
              if (s.old) leave(s.it);
              continue;
            }
            try {
              if (s.it.kind === "create") {
                if (s.linked) await this.unlinkQuiet(s.abs);
                continue;
              }
              if (!s.old) continue;
              let back = false;
              if (await this.lstatQuiet(s.abs) === null) {
                back = (await this.relink(s.it.path, s.it.files.old, s.abs)).kind === "ok";
              } else if (s.linked && s.it.kind === "modify") {
                await this.unlinkQuiet(s.it.files.redo);
                let moved = false;
                try {
                  await this.d.fs.rename(s.abs, s.it.files.redo);
                  moved = true;
                } catch (e) {
                  fail3("to_redo", s.it.path, e);
                }
                if (moved) back = (await this.relink(s.it.path, s.it.files.old, s.abs)).kind === "ok";
              }
              if (!back) leave(s.it);
            } catch (e) {
              fail3("restore", s.it.path, e);
              if (await this.lstatQuiet(s.it.files.old) !== null) leave(s.it);
            }
          }
        }
        for (const s of state) {
          for (const f of [s.it.files.new, s.it.files.redo]) {
            try {
              await this.unlinkQuiet(f);
            } catch (e) {
              fail3("unlink_tmp", s.it.path, e);
            }
          }
        }
      }
      const handed = new Set(report2.leftoverOld.map((l) => l.file));
      for (const l of report2.leftoverOld) this.leftover.set(l.file, l.path);
      this.ring = this.ring.filter((r) => !handed.has(r.file));
      this.stranded = this.stranded.filter((s) => !handed.has(s.old));
      return report2;
    });
  }
  // ---- gate query ----
  /**
   * ENG-38, from memory: 'applying' while p's group of the running call has not reached P1 (nothing of it moved);
   * from P1 to the end of RT the answer waits for the group, at most PATH_BUSY_WAIT_MS, then 'busy' (G1 PATH_BUSY);
   * 'pending' for a path of a deferred apply group not written since; otherwise 'idle'.
   */
  async pathState(path) {
    const f = this.inflight.get(path);
    if (f !== void 0) {
      if (!f.window) return "applying";
      const busy = await Promise.race([f.done.then(() => false), this.d.clock.sleep(PATH_BUSY_WAIT_MS).then(() => true)]);
      if (busy) return "busy";
    }
    return this.pendingPaths.has(path) ? "pending" : "idle";
  }
  /**
   * Whether a hard link works from tmpDir into the work tree (glossary §26.2 item 7): 'link', else the copy fallback —
   * also for a gitdir on another volume than the work tree (EXDEV). The probe links tmp/link-probe.a to a free name at
   * the work-tree root that D6 never admits (`~cowork-link-probe[-<k>].tmp`) and removes both. A name held by anything
   * but this probe's own crash leftover (a second link of tmp/link-probe.a) is never touched.
   */
  static async probeMode(fs, tmpDir, workTree) {
    const a = join6(tmpDir, "link-probe.a");
    const quiet = async (p) => {
      try {
        await fs.unlink(p);
      } catch {
      }
    };
    const names = Array.from({ length: PROBE_NAMES }, (_, k) => join6(workTree, k === 0 ? `${PROBE_BASE}.tmp` : `${PROBE_BASE}-${k}.tmp`));
    const sa = await fs.lstat(a);
    if (sa !== null && sa.isFile && sa.ino !== 0n) {
      for (const n of names) {
        const sn = await fs.lstat(n);
        if (sn !== null && sn.isFile && sn.ino === sa.ino && sn.dev === sa.dev) await quiet(n);
      }
    }
    try {
      await fs.unlink(a);
    } catch (e) {
      if (!isGone2(e)) throw e;
    }
    let b = null;
    for (const n of names) {
      if (await fs.lstat(n) === null) {
        b = n;
        break;
      }
    }
    if (b === null) throw new Error(`writer: no free link-probe name in ${workTree}`);
    await fs.writeFile(a, Buffer.from("cowork link probe\n", "utf8"));
    let linked = false;
    try {
      await fs.link(a, b);
      linked = true;
      return "link";
    } catch (e) {
      const c = codeOf2(e);
      if (c !== void 0 && NO_LINK_CODES.has(c)) return "copy";
      throw e;
    } finally {
      if (linked) await quiet(b);
      await quiet(a);
    }
  }
};
function deferFor(reason) {
  switch (reason) {
    case "unstable":
      return "unstable";
    case "carried":
      return "unmaterializable";
    case "filter_failure":
      return "filter_failure";
    default:
      return "unreadable";
  }
}
function p2Defer(e) {
  if (e instanceof KilledAt || e instanceof DeferGroup) return e;
  const c = codeOf2(e);
  if (c === "EEXIST") return new DeferGroup("race");
  if (c !== void 0 && UNMATERIALIZABLE_CODES.has(c)) return new DeferGroup("race", { unmaterializable: true });
  if (c !== void 0 && LOCKED_CODES.has(c)) return new DeferGroup("locked");
  if (c === "ENOSPC") return new DeferGroup("disk_low");
  return e;
}
function asDefer(e) {
  const c = codeOf2(e);
  if (c === "ENOSPC") return new DeferGroup("disk_low");
  if (e instanceof GitCommandError) return new DeferGroup("unreadable");
  if (c !== void 0) return new DeferGroup("locked");
  return null;
}

// src/engine/core.ts
var internals = /* @__PURE__ */ new WeakMap();
function inner(core) {
  const i = internals.get(core);
  if (i === void 0) throw new Error("engine core: not built by createEngineCore");
  return i;
}
var PEER_FILE = "peer";
var NO_PATHS = Object.freeze(/* @__PURE__ */ new Set());
var SPECIAL2 = /* @__PURE__ */ new Set(["120000", "160000"]);
var TIP_MEMO = 64;
function codeOf3(e) {
  const c = typeof e === "object" && e !== null ? e.code : void 0;
  return typeof c === "string" ? c : void 0;
}
var sameEntry2 = sameTreeEntry;
async function resolvePeerId(deps, view) {
  const fs = deps.ports.fs;
  const file = join7(deps.paths.coworkDir, PEER_FILE);
  const read = async () => {
    try {
      const s = (await fs.readFile(file)).toString("utf8").trim();
      return validId("hex128", s) ? s : null;
    } catch (e) {
      if (codeOf3(e) === "ENOENT") return null;
      throw e;
    }
  };
  const onFile = await read();
  const id = view?.meta.peer_id ?? onFile ?? newPeerId(deps.ports.random);
  if (onFile === null) {
    try {
      await fs.writeFileExclusive(file, Buffer.from(`${id}
`, "utf8"));
    } catch (e) {
      if (codeOf3(e) !== "EEXIST") throw e;
      if (view === null) return await read() ?? id;
    }
  }
  return id;
}
function filteredBy(int4, filters, p) {
  const a = int4.attrMap.get(p);
  if (a !== void 0) return a.filter !== null;
  return filters.drivers.length > 0 || filters.overCap !== null;
}
function textBy(int4, p) {
  const a = int4.attrMap.get(p);
  return a === void 0 || a.filter === null && !a.binary && a.text !== "unset" && a.merge !== "binary";
}
function pathIsFiltered(core, p) {
  return filteredBy(inner(core), core.filters, p);
}
function pathIsText(core, p) {
  return textBy(inner(core), p);
}
function hooksDir(workTree, value) {
  if (value === null) return null;
  const v = value.trim();
  if (v.length === 0) return null;
  const rel = isAbsolute(v) ? relative(workTree, v) : v;
  if (rel.length === 0 || isAbsolute(rel)) return null;
  const parts = rel.split(sep).join("/").split("/").filter((c) => c.length > 0 && c !== ".");
  if (parts.length === 0 || parts.includes("..")) return null;
  return parts.join("/");
}
async function createEngineCore(deps, hooks = {}) {
  if (!validName(deps.display)) throw new Error(`createEngineCore: display ${JSON.stringify(deps.display)} is not a valid name`);
  const { ports, paths } = deps;
  const { fs, clock } = ports;
  const tmpDir = join7(paths.coworkDir, "tmp");
  await fs.mkdirp(paths.coworkDir);
  await fs.mkdirp(tmpDir, 448);
  await fs.mkdirp(join7(tmpDir, "stage"), 448);
  await fs.mkdirp(join7(paths.coworkDir, "empty-hooks"), 448);
  const refs = refNames(deps.branch, deps.namespace);
  let core = null;
  let peerId = "";
  let headAtCreate = null;
  let drivers = [];
  const ctx = () => ({
    attrTree: core?.view?.meta.EPOCH_BASE ?? headAtCreate,
    filterDrivers: core?.filters.drivers ?? drivers,
    identity: { name: deps.display, email: `${peerId}@cowork.invalid` },
    wallMs: () => clock.wallMs()
  });
  const repo = new GitRepo(ports.git, paths, ctx);
  const state = new StateStore({ repo, refs, trace: deps.trace, peer: () => peerId });
  let view = null;
  try {
    view = await state.read();
  } catch (e) {
    if (!(e instanceof LostStateError) && !(e instanceof MetaTooNewError)) throw e;
  }
  peerId = await resolvePeerId(deps, view);
  headAtCreate = await repo.resolve("HEAD");
  const epochBase = view?.meta.EPOCH_BASE ?? headAtCreate;
  const filters = epochBase === null ? { drivers: [], fingerprint: {}, overCap: null } : await discoverFilters(repo, fs, epochBase);
  drivers = filters.drivers;
  const config = epochBase === null ? DEFAULT_TEAM_CONFIG : (await readTeamConfig(repo, epochBase)).config;
  const mergeDrivers = /* @__PURE__ */ new Set();
  for (const { key } of await repo.configGetRegexp("^merge\\..+\\.driver$")) {
    const name = key.slice("merge.".length, key.length - ".driver".length);
    if (name.length > 0) mergeDrivers.add(name);
  }
  const hooksPathDir = hooksDir(paths.workTree, await repo.configGet("core.hooksPath"));
  const int4 = {
    headAtCreate,
    mergeDrivers,
    hooksPathDir,
    aTree: null,
    aMap: null,
    attrBase: null,
    attrMap: /* @__PURE__ */ new Map(),
    fold: view !== null && view.fold !== null && view.meta.fold_board !== null ? { board: view.meta.fold_board, state: view.fold } : null,
    lastCheckedT: null,
    observedTip: void 0,
    paramsBoard: null,
    tipOf: /* @__PURE__ */ new Map(),
    naBlocked: NO_PATHS,
    keptApplyIntent: false,
    boardOnlyFirstPublish: false
  };
  const scratch = (name) => join7(tmpDir, `${name}.index`);
  const privateIndex = join7(paths.coworkDir, `${refs.e}.index`);
  const stage = new StageDir(fs, join7(tmpDir, "stage"));
  const statCache = new StatCache();
  const attrs = new AttrCache(repo, fs);
  const isFiltered = (p) => filteredBy(int4, filters, p);
  const isText = (p) => textBy(int4, p);
  const snapshot = new Snapshotter({
    repo,
    fs,
    clock,
    trace: deps.trace,
    peer: peerId,
    privateIndex,
    scratch: { detect: scratch("detect"), canon: scratch("canon") },
    stage,
    statCache,
    attribution: deps.attribution,
    filters,
    platform: deps.platform
  });
  const diskEq = new DiskEq({
    repo,
    fs,
    stage,
    statCache,
    cmpIndex: scratch("cmp"),
    addIndex: scratch("add"),
    isFiltered,
    isText,
    mutants: deps.testMutants,
    filters,
    isCarried: (p) => snapshot.isCarried(p)
  });
  const holds = new HoldRegistry({ repo, ref: refs.holds, random: ports.random, clock, peer: peerId, trace: deps.trace, log: deps.log });
  await holds.load();
  const mode = await Writer.probeMode(fs, tmpDir, paths.workTree);
  const live = (p) => {
    try {
      return currentScope(int4, p).cls === "LIVE";
    } catch {
      return false;
    }
  };
  const writer = new Writer({
    repo,
    fs,
    clock,
    scheduler: ports.scheduler,
    trace: deps.trace,
    log: deps.log,
    peer: peerId,
    workTree: paths.workTree,
    tmpDir,
    privateIndex,
    stage,
    statCache,
    diskEq,
    snapshot,
    mode,
    isFiltered,
    isText,
    random: ports.random,
    // P2-ORPHANNAMES: tmp/orphan-<ulid> names from the Random port (deterministic in SIM)
    journal: async (intent) => {
      const c = core;
      if (c.view === null) throw new Error("writer journal: no state");
      const keep = new Map(c.view.keep);
      if (intent.kind === "local") keep.set(LOCAL_INTENT_KEEP, await repo.mktree(localIntentKeep(intent)));
      else keep.delete(LOCAL_INTENT_KEEP);
      await c.commit({ intent, keep });
    },
    frozen: () => (core?.view?.meta.freeze_reasons.length ?? 0) > 0,
    onPhantom: async (path, target) => {
      const a = int4.aMap?.get(path);
      await holds.hold({
        kind: "PIN",
        residence: "ON_DISK",
        state: "ACTIVE",
        paths: [path],
        blobs: { h0: { [path]: a?.oid ?? ABSENT }, h1: { [path]: target.oid } },
        guard: "phantom",
        origin: "daemon",
        cs_ids: [],
        displaced_by: null,
        local_only: !live(path)
      });
    },
    onLateWrite: async (path, stageCopy) => {
      const h1 = await hashRouteB(repo, path, stageCopy, true);
      if (isFilterFailure(h1)) throw new Error(`late write into the .old of ${path}: its clean filter refused the bytes (kept in the ring)`);
      const c = core;
      const sDisk = c.view === null ? void 0 : (await repo.readTreeMap(c.view.snap)).get(path);
      await holds.hold({
        kind: "PATCH",
        residence: "OFF_DISK",
        state: "PARKED",
        paths: [path],
        blobs: { h0: { [path]: sDisk?.oid ?? ABSENT }, h1: { [path]: h1 } },
        guard: null,
        origin: "daemon",
        cs_ids: [],
        displaced_by: null,
        local_only: !live(path)
      });
    }
  });
  const fetcher = new Fetcher({ repo, url: deps.url, refs, clock, trace: deps.trace, peer: peerId, ...hooks.onFetched !== void 0 ? { onFetched: hooks.onFetched } : {} });
  const governor = new Governor(clock, readProtocol(null));
  if (view !== null) governor.restore(view.meta.throttle);
  const folder = new Folder(repo, peerId, view === null ? null : { verified: view.meta.fold_verified, checkpointMismatch: view.meta.checkpoint_mismatch });
  const cs = new ChangeSets(peerId, clock, fs);
  if (view !== null) cs.restore(view.ready, view.meta.cs_human_next);
  const outbox = view === null ? new Outbox() : Outbox.fromJson(view.meta.outbox);
  const built = {
    deps,
    peerId,
    repo,
    refs,
    state,
    holds,
    cs,
    snapshot,
    diskEq,
    writer,
    fetcher,
    governor,
    folder,
    attrs,
    stage,
    statCache,
    view,
    outbox,
    filters,
    config,
    caps: view?.fold?.caps ?? null,
    lastApplyMono: null,
    lastPushMono: null,
    pushAttempts: 0,
    path: (rel) => join7(paths.coworkDir, ...rel.split("/")),
    scratch,
    async commit(t) {
      const prev = built.view;
      if (prev === null) throw new Error("engine core: commit before a state exists");
      built.view = await state.commit(prev, t);
      if (t.laB !== void 0) int4.lastCheckedT = t.laB;
      return built.view;
    },
    identity: () => ({ name: deps.display, email: `${peerId}@cowork.invalid` })
  };
  core = built;
  internals.set(built, int4);
  return built;
}
function attachState(core, view) {
  const int4 = inner(core);
  core.view = view;
  int4.fold = view.fold !== null && view.meta.fold_board !== null ? { board: view.meta.fold_board, state: view.fold } : null;
  int4.aTree = null;
  int4.aMap = null;
  int4.lastCheckedT = null;
  int4.naBlocked = NO_PATHS;
  int4.keptApplyIntent = false;
  int4.boardOnlyFirstPublish = false;
  core.cs.restore(view.ready, view.meta.cs_human_next);
  core.outbox = Outbox.fromJson(view.meta.outbox);
  core.caps = view.fold?.caps ?? null;
}
async function joinDraft(core) {
  const { deps, repo } = core;
  return {
    type: "join",
    display: deps.display,
    plugin_version: deps.pluginVersion,
    plugin_sha: deps.pluginSha,
    proto: PROTO,
    regionSpec: deps.regionSpec,
    config_fingerprint: { filters: { ...core.filters.fingerprint }, autocrlf: await repo.configGet("core.autocrlf") ?? "", eol_attrs: "", git: "" },
    coauthor_optin: false
  };
}
async function currentA(core) {
  const int4 = inner(core);
  const view = core.view;
  if (view === null) throw new Error("engine core: no state");
  if (int4.aTree !== view.base || int4.aMap === null) {
    int4.aMap = await core.repo.readTreeMap(view.base);
    int4.aTree = view.base;
  }
  return { aTree: view.base, A: int4.aMap };
}
function setBoardOnlyFirstPublish(core, on) {
  inner(core).boardOnlyFirstPublish = on;
}
function boardOnlyFirstPublish(core) {
  return inner(core).boardOnlyFirstPublish;
}
function markApplyIntentKept(core, kept) {
  inner(core).keptApplyIntent = kept;
}
function applyIntentKept(core) {
  return inner(core).keptApplyIntent;
}
function setCurrentA(core, tree2, map) {
  const int4 = inner(core);
  int4.aTree = tree2;
  int4.aMap = map;
}
async function ensureAttrs(core, epochBase, paths) {
  const int4 = inner(core);
  if (int4.attrBase !== epochBase) {
    int4.attrMap = /* @__PURE__ */ new Map();
    int4.attrBase = epochBase;
  }
  const missing = [...new Set(paths)].filter((p) => !int4.attrMap.has(p) && validPathSyntax(p));
  if (missing.length === 0) return;
  const snap = await core.attrs.snapshot(epochBase, missing);
  for (const p of missing) int4.attrMap.set(p, snap.get(p));
}
function attrView(int4, epochBase) {
  return {
    epochBase,
    get(path) {
      const a = int4.attrBase === epochBase ? int4.attrMap.get(path) : void 0;
      if (a === void 0) throw new Error(`attributes of ${JSON.stringify(path)} were not requested this iteration`);
      return a;
    }
  };
}
var lastScopes = /* @__PURE__ */ new WeakMap();
function currentScope(int4, p) {
  const f = lastScopes.get(int4);
  if (f === void 0) throw new Error("no iteration prepared yet");
  return f(p);
}
function scopeFunction(core, inp, A, TIP, tipSizes) {
  const memo = /* @__PURE__ */ new Map();
  return (p) => {
    const hit = memo.get(p);
    if (hit !== void 0) return hit;
    const a = A.get(p);
    const t = TIP.get(p);
    let mode = t?.mode ?? a?.mode ?? "100644";
    if (a !== void 0 && SPECIAL2.has(a.mode) && (t === void 0 || !SPECIAL2.has(t.mode))) mode = a.mode;
    const size = Math.max(core.statCache.get(p)?.stat?.size ?? 0, tipSizes.get(p) ?? 0);
    const s = scopeOfTracked(p, mode, size, inp);
    memo.set(p, s);
    return s;
  };
}
function editable(p) {
  return validPathSyntax(p) && !p.includes("�");
}
async function ancestorsSafe(core, path) {
  const fs = core.deps.ports.fs;
  let dir = core.deps.paths.workTree;
  for (const c of path.split("/").slice(0, -1)) {
    dir = join7(dir, c);
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      return false;
    }
    if (st === null) return true;
    if (st.isSymbolicLink || !st.isDirectory) return false;
  }
  return true;
}
async function unmaterializableHere(core, it, p) {
  if (!stageable(p) || it.tick?.carried.has(p) === true || core.snapshot.isCarried(p) || !editable(p)) return true;
  if ((await core.snapshot.tipCollisions(it.tipMap)).has(p)) return true;
  if (core.deps.platform === "win32") {
    const r = portable(p, /* @__PURE__ */ new Set());
    if (!r.ok && r.rule !== 3) return true;
  }
  return !await ancestorsSafe(core, p);
}
var NOT_APPLICABLE_REASONS = /* @__PURE__ */ new Set(["collision", "unmaterializable", "quarantine"]);
async function notApplicableStill(core, it) {
  const out = /* @__PURE__ */ new Set();
  const view = core.view;
  if (view === null) return out;
  const rows2 = Object.entries(view.meta.pending).filter(([p, why]) => NOT_APPLICABLE_REASONS.has(why) && !sameEntry2(it.A.get(p), it.tipMap.get(p)));
  if (rows2.length === 0) return out;
  await ensureAttrs(core, it.epochBase, rows2.map(([p]) => p));
  const lastS = core.snapshot.last()?.sDiskMap;
  for (const [p, why] of rows2) {
    let still;
    if (why === "quarantine") {
      still = it.scope(p).cls === "QUARANTINED";
    } else if (why === "collision") {
      let st;
      try {
        st = await core.deps.ports.fs.lstat(join7(core.deps.paths.workTree, ...p.split("/")));
      } catch {
        st = null;
      }
      still = st !== null && it.tick?.dirty.has(p) !== true && lastS?.has(p) !== true;
    } else {
      still = await unmaterializableHere(core, it, p);
    }
    if (still) out.add(p);
  }
  return out;
}
function phantomPaths(core) {
  const out = /* @__PURE__ */ new Set();
  for (const r of core.holds.nonTerminal()) {
    if (r.kind === "PIN" && r.residence === "ON_DISK" && !isTerminal(r) && r.guards.some((g) => guardName(g) === "phantom")) {
      for (const p of r.paths) out.add(p);
    }
  }
  return out;
}
function applicableDifference(core, it) {
  if (it.A === it.tipMap) return false;
  const phantoms = phantomPaths(core);
  const blocked = inner(core).naBlocked;
  const differs = (p) => {
    if (sameEntry2(it.A.get(p), it.tipMap.get(p))) return false;
    if (it.tick?.carried.has(p) === true || core.snapshot.isCarried(p) || phantoms.has(p) || blocked.has(p)) return false;
    return true;
  };
  for (const p of it.A.keys()) if (differs(p)) return true;
  for (const p of it.tipMap.keys()) if (!it.A.has(p) && differs(p)) return true;
  return false;
}
function tickSkip(core) {
  const stranded = core.writer.strandedPaths();
  return stranded.length === 0 ? NO_PATHS : new Set(stranded);
}
function captureDue(core) {
  return core.writer.strandedPaths().length === 0 && core.cs.closeDue();
}
function tickInputOf(core, it) {
  const int4 = inner(core);
  if (int4.aTree === null || int4.aMap !== it.A) throw new Error("tickInputOf: the iteration's A is not the current A map");
  return { A: it.A, aTree: int4.aTree, epochBase: it.epochBase, scope: it.scopeInputs, skip: tickSkip(core) };
}
async function liveCodeOf(core, T, known) {
  const int4 = inner(core);
  const hit = int4.tipOf.get(T);
  if (hit !== void 0) return hit;
  let tip = known;
  if (tip === void 0) {
    const b = await core.repo.readCommit(T);
    tip = b.parents[b.parents.length - 1];
    if (tip === void 0) throw new RemoteContentError(`liveCodeOf: ${T} has no parent`);
  }
  const tree2 = (await core.repo.readCommit(tip)).tree;
  const v = { tip, tree: tree2 };
  int4.tipOf.set(T, v);
  if (int4.tipOf.size > TIP_MEMO) int4.tipOf.delete(int4.tipOf.keys().next().value);
  return v;
}
function foldPatch(core) {
  const f = inner(core).fold;
  if (f === null) return null;
  const v = core.folder.verification();
  return { fold: f.state, meta: { fold_board: f.board, fold_verified: v.verified, checkpoint_mismatch: v.checkpointMismatch } };
}
async function observeFetch(core, view, pending, known) {
  if (view.deferred) return;
  const int4 = inner(core);
  const tip = view.ok ? view.board === ABSENT ? null : view.board : int4.observedTip ?? null;
  let revealed = 0;
  const prev = int4.observedTip;
  if (known !== void 0 && prev === known.from) {
    revealed = tip === prev ? 0 : known.revealed;
  } else if (tip !== null && prev !== void 0 && prev !== null && prev !== tip) {
    try {
      revealed = (await core.repo.firstParents(tip, prev, 1e4)).length;
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      revealed = 0;
    }
  }
  core.governor.onFetch(tip, revealed, view.firstOfRun, pending);
  if (view.ok) int4.observedTip = tip;
}
function observeOwnLanding(core, bnew, lease) {
  const int4 = inner(core);
  core.governor.onOwnOk(bnew);
  if (int4.observedTip === void 0 || int4.observedTip === (lease === ABSENT ? null : lease)) int4.observedTip = bnew;
}
function pushStatesOf(core, version) {
  const view = core.view;
  if (view === null) return [];
  const meta = view.meta;
  const out = [];
  const fr = meta.freeze_reasons;
  if (fr.includes("INCIDENT")) out.push("incident");
  else if (fr.includes("CONFIG") && (meta.config_detail.includes("url") || meta.config_detail.includes("public"))) out.push("config_net");
  else if (fr.length > 0) out.push("frozen");
  if (core.fetcher.offline().offline) out.push("offline");
  if (meta.nonretryable !== null) out.push("nonretryable");
  if (version.proto) out.push("version_proto");
  else if (version.regionSpec || version.checkpointMismatch) out.push("version_board_only");
  return out;
}
function newlyFoldedThrottleEvents(state, prevHeight, self) {
  const out = [];
  for (const e of Object.values(state.events)) {
    if (e.kind !== "health" || e.reason_code !== "HOST_THROTTLED") continue;
    const fresh = prevHeight === null ? state.height - e.height < RESTART_EVENT_HEIGHTS : e.height > prevHeight;
    if (fresh) out.push({ height: e.height, own: parseOpId(e.op_id)?.peer === self });
  }
  return out;
}
var PIN_GUARDS = /* @__PURE__ */ new Set(["join", "phantom", "host-reject"]);
function pinnedPaths(core) {
  const out = /* @__PURE__ */ new Set();
  for (const r of core.holds.nonTerminal()) {
    if (r.kind !== "PIN" || r.residence !== "ON_DISK" || isTerminal(r)) continue;
    if (!r.guards.some((g) => PIN_GUARDS.has(guardName(g)))) continue;
    for (const p of r.paths) out.add(p);
  }
  return out;
}
function allowedPending(core, states) {
  if (core.outbox.pendingAllowed(states)) return true;
  if (states.length !== 0) return false;
  const ready = core.cs.ready();
  if (ready.length === 0) return false;
  const pinned = pinnedPaths(core);
  return ready.some((pair) => !pair.paths.some((p) => pinned.has(p)));
}
async function prepareIteration(core, n, o) {
  const int4 = inner(core);
  const start = anchorNow(core.deps.ports.clock);
  if (core.view === null) return { ok: false, why: "no_state" };
  const repo = core.repo;
  const fetchFoldOnly = o.fetchFoldOnly === true;
  if (!fetchFoldOnly) {
    try {
      await core.writer.sweepRing();
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      core.deps.log.write("error", "RING_SWEEP_FAILED", { code: e instanceof Error ? e.name : "unknown" });
    }
    if (int4.keptApplyIntent && core.writer.strandedPaths().length === 0) {
      if (core.view.intent.kind === "apply") await core.commit({ intent: { kind: "none" }, t: /* @__PURE__ */ new Map() });
      int4.keptApplyIntent = false;
      core.deps.log.write("info", "APPLY_INTENT_CLEARED", {});
    }
  }
  const view = core.view;
  const fetched = await core.fetcher.fetch(o.forceFetch);
  const T = fetched.ok && !fetched.deferred ? fetched.board : int4.lastCheckedT ?? view.laB;
  const incident = async (verdict2) => {
    await observeFetch(core, fetched, false);
    return { ok: false, why: "incident", verdict: verdict2, T };
  };
  let verdict;
  try {
    verdict = await incidentCheck(repo, view.laB, view.laC, T, core.deps.testMutants);
  } catch (e) {
    if (!isRemoteContentError(e)) throw e;
    verdict = { ok: false, why: "board_shape", observedBoard: T === ABSENT ? null : T, observedCode: null };
  }
  if (!verdict.ok) return incident(verdict);
  const board = T;
  const prevHeight = int4.fold?.state.height ?? null;
  const prevBoard = int4.fold?.board ?? null;
  let outcome;
  let params = null;
  let live;
  try {
    outcome = await core.folder.foldTo(board, int4.fold, core.deps.regionSpec);
    if (int4.paramsBoard !== board) params = outcome.newCommits[outcome.newCommits.length - 1]?.protocol ?? (await readBoardCommit(repo, board)).protocol;
    live = await liveCodeOf(core, board, outcome.newCommits.find((c) => c.oid === board)?.liveCode);
  } catch (e) {
    if (!isRemoteContentError(e)) throw e;
    return incident({ ok: false, why: "board_shape", observedBoard: board, observedCode: null });
  }
  int4.fold = { board, state: outcome.state };
  int4.lastCheckedT = board;
  core.caps = outcome.state.caps;
  if (params !== null) {
    core.governor.setParams(params);
    int4.paramsBoard = board;
  }
  for (const e of newlyFoldedThrottleEvents(outcome.state, prevHeight, core.peerId)) core.governor.onThrottleEventFolded(e.own);
  if (fetched.firstOfRun && !fetched.deferred && recentThrottleEvent(outcome.state, RESTART_EVENT_HEIGHTS)) {
    core.governor.onThrottleEventFolded(newlyFoldedThrottleEvents(outcome.state, null, core.peerId).some((e) => e.own));
  }
  const pushStates = pushStatesOf(core, outcome.version);
  await observeFetch(
    core,
    fetched,
    allowedPending(core, pushStates),
    prevBoard !== null && fetched.ok && fetched.board === board && (outcome.newCommits[0]?.firstParent ?? board) === prevBoard ? { from: prevBoard, revealed: outcome.newCommits.length } : void 0
  );
  const { tip, tree: tipTree } = live;
  const tipMap = await repo.readTreeMap(tipTree);
  const { aTree, A } = await currentA(core);
  const epochBase = view.meta.EPOCH_BASE;
  int4.attrMap = /* @__PURE__ */ new Map();
  int4.attrBase = epochBase;
  await ensureAttrs(core, epochBase, aTree === tipTree ? A.keys() : [...A.keys(), ...tipMap.keys()]);
  const changedTip = [];
  if (aTree !== tipTree) {
    for (const [p, e] of tipMap) if (!sameEntry2(A.get(p), e)) changedTip.push({ path: p, oid: e.oid });
  }
  const sizes = await repo.blobSizes(changedTip.map((c) => c.oid));
  const tipSizes = new Map(changedTip.map((c, i) => [c.path, sizes[i] ?? 0]));
  const scopeInputs = {
    attrs: attrView(int4, epochBase),
    config: core.config,
    mergeDrivers: int4.mergeDrivers,
    localOnlyPaths: NO_PATHS,
    hooksPathDir: int4.hooksPathDir
  };
  const scope2 = scopeFunction(core, scopeInputs, A, tipMap, tipSizes);
  lastScopes.set(int4, scope2);
  if (fetchFoldOnly) {
    const it2 = {
      n,
      start,
      fetched,
      T: board,
      tip,
      tipMap,
      A,
      fold: outcome.state,
      version: outcome.version,
      epochBase,
      scopeInputs,
      scope: scope2,
      tick: null,
      mat: null,
      freeze: [...view.meta.freeze_reasons],
      pushStates,
      leaseIdleMs: core.deps.lease.idleMs()
    };
    return { ok: true, it: it2 };
  }
  const tickInput = { A, aTree, epochBase, scope: scopeInputs, skip: tickSkip(core) };
  const tick = await core.snapshot.tick(tickInput);
  if (tick.failed) return { ok: false, why: "snapshot_failed" };
  await ensureAttrs(core, epochBase, tick.changed);
  core.cs.observe([...tick.changed].filter((p) => scope2(p).cls === "LIVE"));
  const it = {
    n,
    start,
    fetched,
    T: board,
    tip,
    tipMap,
    A,
    fold: outcome.state,
    version: outcome.version,
    epochBase,
    scopeInputs,
    scope: scope2,
    tick,
    mat: null,
    freeze: [...view.meta.freeze_reasons],
    pushStates,
    leaseIdleMs: core.deps.lease.idleMs()
  };
  int4.naBlocked = await notApplicableStill(core, it);
  const applyAdmitted = it.freeze.length === 0 && it.leaseIdleMs < LEASE_STOP_SYNC_MS && core.writer.strandedPaths().length === 0 && (core.lastApplyMono === null || core.deps.ports.clock.monoMs() - core.lastApplyMono >= APPLY_COALESCE_MS) && applicableDifference(core, it);
  const materialize2 = o.materialize === true || o.materialize === "auto" && (captureDue(core) || applyAdmitted);
  if (materialize2) {
    it.mat = await core.snapshot.materialize(tickInput);
    await ensureAttrs(core, epochBase, it.mat.sDiskMap.keys());
  }
  return { ok: true, it };
}

// src/engine/apply.ts
var APPLY_COALESCE_MS = 1e4;
var FREE_SPACE_MARGIN_BYTES2 = 268435456;
var SPECIAL3 = /* @__PURE__ */ new Set(["120000", "160000"]);
var MAX_INCOMING = 1e5;
function applyNeeded(core, it) {
  if (core.deps.testMutants.has("M17")) return core.view !== null && it.tip !== core.view.laC;
  return applicableDifference(core, it);
}
function emptyReport(skipped) {
  return { ran: false, skipped, written: [], deleted: [], deferred: /* @__PURE__ */ new Map(), notApplicable: /* @__PURE__ */ new Map(), records: [], cancelled: [] };
}
function deferFor2(e) {
  switch (e) {
    case "unreadable":
      return "unreadable";
    case "filter_failure":
      return "filter_failure";
    default:
      return "unstable";
  }
}
function isSpecial(e) {
  return e !== void 0 && SPECIAL3.has(e.mode);
}
function pendingOf(rows2, A, TIP) {
  const pending = /* @__PURE__ */ new Map();
  for (const [p, why] of rows2) {
    if (sameEntry2(A.get(p), TIP.get(p))) continue;
    if (stageable(p)) pending.set(p, why);
  }
  return Object.fromEntries(pending);
}
function samePending(a, b) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && b[k] === a[k]);
}
function onDiskConflictRecords(core, p) {
  return core.holds.nonTerminal().filter((r) => r.kind === "PATCH" && r.state === "CONFLICTED" && r.residence === "ON_DISK" && !isTerminal(r) && r.guards.some((g) => guardName(g) === "conflict") && r.paths.length === 1 && r.paths[0] === p).map((r) => r.id).sort();
}
function sameReady(a, b) {
  return a.length === b.length && a.every((x, i) => x.csId === b[i].csId && x.R === b[i].R && x.A === b[i].A);
}
async function incomingChangeSets(repo, laC, tip) {
  if (laC === tip) return [];
  const r = await repo.run(["rev-list", "--first-parent", "--no-commit-header", `--max-count=${MAX_INCOMING}`, "--format=%x00%H%n%P%n%B", tip, `^${laC}`]);
  const out = [];
  for (const record of r.stdout.toString("utf8").split("\0").slice(1)) {
    const nl1 = record.indexOf("\n");
    const nl2 = nl1 < 0 ? -1 : record.indexOf("\n", nl1 + 1);
    if (nl2 < 0) throw new Error(`apply: unexpected rev-list record ${JSON.stringify(record.slice(0, 120))}`);
    const commit = parseOid(record.slice(0, nl1));
    const parent = record.slice(nl1 + 1, nl2).split(" ").filter((x) => x.length > 0)[0] ?? null;
    const { cs, paths } = parseCsTrailers(parseMessage(record.slice(nl2 + 1)).trailers);
    let diff = null;
    const whole = async () => diff ??= await changedPaths(repo, parent === null ? null : parseOid(parent), commit);
    if (cs.length === 0) {
      out.push({ commit, csId: `commit:${commit}`, paths: await whole() });
      continue;
    }
    for (const c of cs) out.push({ commit, csId: c.csId, paths: paths.get(c.csId) ?? await whole() });
  }
  return out;
}
async function changedPaths(repo, parent, commit) {
  const args = parent === null ? ["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", "--root", commit] : ["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", parent, commit];
  return (await repo.run(args)).stdout.toString("utf8").split("\0").filter((s) => s.length > 0);
}
async function applyStep(core, it) {
  const view0 = core.view;
  if (view0 === null) throw new Error("applyStep: no state");
  if (it.T === ABSENT) throw new Error("applyStep: no board tip (the incident branch never applies)");
  const T = it.T;
  const { clock, fs } = core.deps.ports;
  const { repo, deps } = core;
  const peer = core.peerId;
  if (view0.intent.kind === "push") return emptyReport("push_intent_pending");
  if (it.freeze.length > 0) return emptyReport("frozen");
  if (it.leaseIdleMs >= LEASE_STOP_SYNC_MS) return emptyReport("lease");
  if (it.tick === null || it.tick.failed) return emptyReport("snapshot_failed");
  if (!applyNeeded(core, it)) return emptyReport("nothing");
  if (core.writer.strandedPaths().length > 0) return emptyReport("stranded");
  const now = clock.monoMs();
  if (core.lastApplyMono !== null && now - core.lastApplyMono < APPLY_COALESCE_MS) return emptyReport("coalesced");
  core.lastApplyMono = now;
  if (it.mat === null) {
    it.mat = await core.snapshot.materialize(tickInputOf(core, it));
    await ensureAttrs(core, it.epochBase, it.mat.sDiskMap.keys());
  }
  const mat = it.mat;
  const { aTree } = await currentA(core);
  const A = it.A;
  const S = mat.sDiskMap;
  const TIP = it.tipMap;
  const { tree: tipTree } = await liveCodeOf(core, T);
  let merged;
  try {
    merged = await mergeTree(repo, aTree, mat.sDisk, tipTree);
  } catch (e) {
    if (!(e instanceof MergeFailedError)) throw e;
    deps.log.write("error", "APPLY_MERGE_FAILED", { code: e.code });
    return emptyReport("merge_failed");
  }
  deps.trace.emit({
    kind: "merge",
    peer,
    use: "apply",
    base: aTree,
    ours: mat.sDisk,
    theirs: tipTree,
    aTree,
    laC: view0.laC,
    laB: view0.laB,
    tip: it.tip,
    t: T,
    rc: merged.rc
  });
  const R = await repo.readTreeMap(merged.tree);
  const M = new Map(R);
  const all = /* @__PURE__ */ new Set([...A.keys(), ...S.keys(), ...TIP.keys(), ...R.keys()]);
  const how = /* @__PURE__ */ new Map();
  const takeTip = /* @__PURE__ */ new Map();
  const deferred = /* @__PURE__ */ new Map();
  const notApplicable = /* @__PURE__ */ new Map();
  const replace = (p, e) => {
    if (e === void 0) M.delete(p);
    else M.set(p, { path: p, mode: e.mode, oid: e.oid });
  };
  const carriedTo = /* @__PURE__ */ new Set();
  const sources = [];
  for (const p of all) {
    if (!editable(p)) continue;
    const a = A.get(p);
    const o = S.get(p);
    const t = TIP.get(p);
    const res = R.get(p);
    if (sameEntry2(o, a) && !sameEntry2(res, t)) {
      replace(p, t);
      carriedTo.add(p);
    } else if (o !== void 0 && !sameEntry2(o, a) && t === void 0 && res === void 0) {
      sources.push(p);
    }
  }
  const fold = it.fold;
  const concatAllowed = liveSet(fold).every((p) => fold.peers[p]?.regionSpec === deps.regionSpec);
  let epochMap = null;
  const ctx = {
    repo,
    isText: (p) => pathIsText(core, p),
    insertionMerge: (p) => core.config.merge.insertionMerge.some((g) => wildmatch(g, p)),
    concatAllowed,
    localOnly: () => false,
    ref: async (p) => {
      let e = A.get(p);
      if (e === void 0) {
        epochMap ??= await repo.readTreeMap((await repo.readCommit(it.epochBase)).tree);
        e = epochMap.get(p);
      }
      return e === void 0 || !isRegularEntry(e) ? null : repo.readBlob(e.oid);
    },
    write: true
  };
  const route = async (p, v) => {
    if (v.kind === "CONCAT") {
      const mode = S.get(p)?.mode ?? TIP.get(p)?.mode ?? "100644";
      M.set(p, { path: p, mode, oid: v.blob });
      how.set(p, "concat");
    } else if (v.kind === "TAKE_TIP") {
      replace(p, v.entry === ABSENT ? void 0 : TIP.get(p));
      takeTip.set(p, v.stages);
      how.set(p, "take_tip");
    } else {
      replace(p, S.get(p));
      deferred.set(p, v.reason);
    }
  };
  await ensureAttrs(core, it.epochBase, all);
  const quarantined = (p) => editable(p) && it.scope(p).cls === "QUARANTINED";
  const keepLocal = (p) => {
    replace(p, S.get(p));
    notApplicable.set(p, "quarantine");
  };
  for (const p of sources) {
    if (quarantined(p)) {
      keepLocal(p);
      continue;
    }
    await route(p, await conflict(ctx, p, A.get(p)?.oid ?? ABSENT, S.get(p).oid, ABSENT, "other"));
  }
  const handled = /* @__PURE__ */ new Set([...carriedTo, ...sources]);
  for (const p of merged.conflicted) {
    if (handled.has(p)) continue;
    if (!editable(p)) {
      notApplicable.set(p, "unmaterializable");
      continue;
    }
    if (quarantined(p)) {
      keepLocal(p);
      continue;
    }
    const a = A.get(p);
    const o = S.get(p);
    const t = TIP.get(p);
    const content = isRegularEntry(a) && isRegularEntry(o) && isRegularEntry(t) && a.mode === o.mode && o.mode === t.mode;
    const unit = content ? "content" : "other";
    await route(p, await conflict(ctx, p, a?.oid ?? ABSENT, o?.oid ?? ABSENT, t?.oid ?? ABSENT, unit));
  }
  const underFile = /* @__PURE__ */ new Set();
  for (const p of [...M.keys()].sort()) {
    const o = S.get(p);
    if (!editable(p) || takeTip.has(p) || deferred.has(p) || notApplicable.has(p) || o === void 0 || sameEntry2(o, A.get(p)) || TIP.has(p)) continue;
    const parts = p.split("/");
    if (!parts.slice(1).some((_, i) => M.has(parts.slice(0, i + 1).join("/")))) continue;
    replace(p, void 0);
    takeTip.set(p, { s1: A.get(p)?.oid ?? ABSENT, s2: o.oid, s3: ABSENT });
    how.set(p, "take_tip");
    underFile.add(p);
  }
  const mIndex = core.scratch("a");
  const mEdits = [];
  for (const p of /* @__PURE__ */ new Set([...R.keys(), ...M.keys()])) {
    const before = R.get(p);
    const after = M.get(p);
    if (sameEntry2(before, after)) continue;
    mEdits.push(after === void 0 ? { path: p, remove: true } : { path: p, mode: after.mode, oid: after.oid });
  }
  let mTree;
  let mRefused = /* @__PURE__ */ new Set();
  try {
    mTree = await editTreeIndexOnly(repo, fs, merged.tree, mEdits, mIndex);
  } catch (e) {
    if (!(e instanceof IndexRefusedPathError)) throw e;
    mTree = merged.tree;
    mRefused = new Set(mEdits.map((x) => x.path));
    deps.log.write("warn", "APPLY_TREE_REFUSED", { refused: e.paths.length, deferred: mRefused.size });
  }
  const unmanaged = /* @__PURE__ */ new Set();
  const isUnmanaged = (p) => !quarantined(p) && (isSpecial(A.get(p)) || isSpecial(S.get(p)) || isSpecial(TIP.get(p)) || isSpecial(M.get(p)) || it.scope(p).cls === "UNMANAGED");
  const changed = [...all].filter((p) => !sameEntry2(A.get(p), TIP.get(p)));
  const W = [...all].filter((p) => !sameEntry2(S.get(p), M.get(p))).sort();
  for (const p of [...changed, ...W]) if (editable(p) && isUnmanaged(p)) unmanaged.add(p);
  const carriedHere = (p) => !stageable(p) || it.tick.carried.has(p) || core.snapshot.isCarried(p);
  const tipCollide = await core.snapshot.tipCollisions(TIP);
  for (const p of W) {
    if (unmanaged.has(p) || notApplicable.has(p)) continue;
    if (quarantined(p)) {
      notApplicable.set(p, "quarantine");
      continue;
    }
    if (tipCollide.has(p) || await unmaterializableHere(core, it, p)) {
      notApplicable.set(p, "unmaterializable");
      continue;
    }
    if (S.get(p) === void 0 && A.get(p) === void 0) {
      let st;
      try {
        st = await fs.lstat(join8(deps.paths.workTree, ...p.split("/")));
      } catch {
        deferred.set(p, "unreadable");
        continue;
      }
      if (st !== null) {
        notApplicable.set(p, "collision");
        continue;
      }
    }
    if (mRefused.has(p)) deferred.set(p, "unmaterializable");
  }
  for (const ex of [it.tick.excluded, mat.excluded]) {
    for (const [p, e] of ex) if (!notApplicable.has(p) && !deferred.has(p)) deferred.set(p, deferFor2(e));
  }
  const toWrite = W.filter((p) => !unmanaged.has(p) && !notApplicable.has(p));
  const applicable = new Set(toWrite.filter((p) => !deferred.has(p)));
  const relevant = /* @__PURE__ */ new Set([...toWrite, ...changed]);
  const deferInGroups = new Map([...deferred].filter(([p]) => relevant.has(p)));
  const incoming2 = await incomingChangeSets(repo, view0.laC, it.tip);
  const wg = writeGroups(incoming2, applicable, deferInGroups);
  for (const d of wg.deferred) for (const p of d.paths) deferred.set(p, d.reason);
  const sRaw = mat.sRawMap;
  const groups = wg.groups.map((paths, n) => ({
    n,
    entries: paths.map((p, slot) => {
      const s = S.get(p);
      const m = M.get(p);
      const kind = s === void 0 ? "create" : m === void 0 ? "delete" : "modify";
      return { path: p, kind, slot, target: m ?? null, sRaw: sRaw.get(p) ?? null, sDisk: s ?? null };
    })
  }));
  const targets = groups.flatMap((g) => g.entries).flatMap((e) => e.target === null ? [] : [e.target.oid]);
  const bytes = (await repo.blobSizes(targets)).reduce((x, y) => x + y, 0);
  const free = await fs.freeBytes(deps.paths.workTree);
  if (free !== null && free < 2 * bytes + FREE_SPACE_MARGIN_BYTES2) {
    const r = emptyReport("disk_low");
    for (const p of [...toWrite, ...deferInGroups.keys()]) r.deferred.set(p, "disk_low");
    for (const [p, why] of notApplicable) r.notApplicable.set(p, why);
    const pending2 = pendingOf([...r.deferred, ...r.notApplicable], A, TIP);
    if (!samePending(pending2, core.view.meta.pending)) await core.commit({ meta: { ...core.view.meta, pending: pending2 } });
    deps.log.write("warn", "DEFERRED", { reason: "disk_low", paths: r.deferred.size });
    return r;
  }
  if (groups.length > 0 && !await core.writer.reserve(groups)) {
    const r = emptyReport("locked");
    for (const p of toWrite) r.deferred.set(p, "locked");
    for (const [p, why] of notApplicable) r.notApplicable.set(p, why);
    deps.log.write("warn", "DEFERRED", { reason: "locked", paths: r.deferred.size });
    return r;
  }
  const writing = new Set(groups.flatMap((g) => g.entries.map((e) => e.path)));
  const recordOf = /* @__PURE__ */ new Map();
  const readyCs = core.cs.ready();
  for (const [p, stages] of [...takeTip].sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0)) {
    if (!writing.has(p)) continue;
    const id = await core.holds.hold({
      kind: "PATCH",
      residence: "ON_DISK",
      state: "CONFLICTED",
      paths: [p],
      blobs: { s1: { [p]: stages.s1 }, s2: { [p]: stages.s2 }, s3: { [p]: stages.s3 } },
      guard: "conflict",
      origin: "daemon",
      cs_ids: readyCs.filter((r) => r.paths.includes(p)).map((r) => r.csId),
      displaced_by: null,
      local_only: it.scope(p).cls !== "LIVE"
    });
    recordOf.set(p, id);
  }
  let intent = { kind: "none" };
  let jTrees = /* @__PURE__ */ new Map();
  let results = [];
  if (groups.length > 0) {
    intent = { kind: "apply", tip: it.tip, board: T, groups: groups.map((g) => ({ n: g.n, entries: g.entries.map((e) => ({ path: e.path, kind: e.kind, slot: e.slot })) })) };
    jTrees = /* @__PURE__ */ new Map([["M", mTree], ["S", mat.sDisk], ["TIP", tipTree]]);
    await core.commit({ intent, t: jTrees });
    crashpoint("apply.intent");
    const remerge = async (entry, found) => {
      if (entry.sDisk === null || entry.target === null) return null;
      const m = await mergeFile(repo, found.oid, entry.sDisk.oid, entry.target.oid);
      if (m.rc !== 0) return null;
      return { path: entry.path, mode: entry.target.mode, oid: await repo.hashBytes(m.out, true) };
    };
    try {
      results = await core.writer.applyGroups(groups, remerge);
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      try {
        await core.writer.rollbackIntent(intent, new Map(groups.flatMap((g) => g.entries.map((x) => [x.path, x.target]))));
      } catch (e2) {
        if (e2 instanceof KilledAt) throw e2;
        deps.log.write("error", "APPLY_ROLLBACK_FAILED", { code: e2 instanceof Error ? e2.name : "unknown" });
      }
      throw e;
    }
  }
  const written = /* @__PURE__ */ new Map();
  const deleted = /* @__PURE__ */ new Set();
  const phantoms = /* @__PURE__ */ new Set();
  const byN = new Map(groups.map((g) => [g.n, g]));
  for (const res of results) {
    if (res.outcome === "written") {
      for (const e of res.written) written.set(e.path, e);
      for (const p of res.deleted) deleted.add(p);
      for (const p of res.phantoms) phantoms.add(p);
    } else {
      for (const e of byN.get(res.n)?.entries ?? []) deferred.set(e.path, res.reason ?? "race");
    }
  }
  for (const p of [...recordOf.keys()].sort()) {
    if (!written.has(p) && !deleted.has(p)) continue;
    for (const id of onDiskConflictRecords(core, p)) await core.holds.transition(id, { residence: "OFF_DISK" });
  }
  const phantomHeld = phantomPaths(core);
  const aEdits = [];
  const indexEdits = [];
  const aSet = [];
  const changes = [];
  for (const p of changed.sort()) {
    if (!editable(p)) continue;
    const a = A.get(p);
    const t = TIP.get(p);
    let cause = null;
    let w = "none";
    if (unmanaged.has(p)) {
      cause = "unmanaged_follow";
      indexEdits.push(t === void 0 ? { path: p, remove: true } : { path: p, mode: t.mode, oid: t.oid });
    } else if (notApplicable.has(p) || deferred.has(p) || phantoms.has(p) || phantomHeld.has(p) || carriedHere(p)) {
      cause = null;
    } else if (written.has(p) || deleted.has(p)) {
      cause = "write_verified";
      w = how.get(p) ?? "clean";
    } else if (sameEntry2(S.get(p), M.get(p))) {
      cause = "disk_equal";
    }
    if (cause === null) continue;
    aEdits.push(t === void 0 ? { path: p, remove: true } : { path: p, mode: t.mode, oid: t.oid });
    aSet.push({ path: p, blob: t?.oid ?? null, cause });
    changes.push({
      path: p,
      aOld: a ?? null,
      aNew: t ?? null,
      written: w,
      sDiskBefore: S.get(p) ?? null,
      writtenEntry: w === "clean" || w === "concat" ? written.get(p) ?? null : null
    });
  }
  for (const p of [...underFile].sort()) {
    if (!deleted.has(p) || changed.includes(p)) continue;
    const a = A.get(p) ?? null;
    changes.push({ path: p, aOld: a, aNew: a, written: "take_tip", sDiskBefore: S.get(p) ?? null, writtenEntry: null });
  }
  const newATree = await editTreeIndexOnly(repo, fs, aTree, aEdits, core.scratch("a"));
  const privateIndex = join8(deps.paths.coworkDir, `${core.refs.e}.index`);
  await editIndexOnly(repo, privateIndex, indexEdits, aTree.length);
  const prevView = core.view;
  await resetScratchIndex(fs, core.scratch("r"));
  const rebase = await core.cs.rebase(repo, deps.testMutants.has("M20") ? [] : changes, core.scratch("r"));
  const newA = await repo.readTreeMap(newATree);
  const reportDeferred = /* @__PURE__ */ new Map();
  for (const [p, why] of [...deferred, ...notApplicable]) {
    if (!sameEntry2(newA.get(p), TIP.get(p))) reportDeferred.set(p, why);
  }
  const pending = pendingOf(reportDeferred, newA, TIP);
  const fp = foldPatch(core);
  const meta = {
    ...prevView.meta,
    pending,
    throttle: core.governor.toMeta(),
    outbox: core.outbox.toJson(),
    ...fp !== null ? fp.meta : {}
  };
  const writtenPaths = [...written.keys()].sort();
  const deletedPaths = [...deleted].sort();
  const kept = narrowToStranded(intent, results);
  const noop = groups.length === 0 && newATree === prevView.base && it.tip === prevView.laC && T === prevView.laB && samePending(pending, prevView.meta.pending) && sameReady(rebase.ready, prevView.ready) && (fp === null || fp.meta.fold_board === prevView.meta.fold_board);
  if (!noop) {
    try {
      await core.commit({
        base: newATree,
        laC: it.tip,
        laB: T,
        snap: mat.sDisk,
        meta,
        intent: kept,
        t: kept.kind === "none" ? /* @__PURE__ */ new Map() : jTrees,
        ready: rebase.ready,
        ...fp !== null ? { fold: fp.fold } : {}
      });
    } catch (e) {
      if (!(e instanceof StateCasLostError) && !(e instanceof KilledAt)) core.cs.restore(prevView.ready, prevView.meta.cs_human_next);
      throw e;
    }
  }
  deps.trace.emit({ kind: "apply", peer, tip: it.tip, written: [...writtenPaths, ...deletedPaths].sort(), deferred: [...reportDeferred.keys()].sort() });
  for (const s of aSet) deps.trace.emit({ kind: "A_set", peer, path: s.path, blob: s.blob, cause: s.cause });
  if (!noop) crashpoint("apply.state");
  if (!noop) markApplyIntentKept(core, kept.kind !== "none");
  setCurrentA(core, newATree, newA);
  it.A = newA;
  const remerged = [...written].filter(([p, e]) => !sameEntry2(e, M.get(p))).map(([p]) => p);
  const liveRemerged = remerged.filter((p) => it.scope(p).cls === "LIVE");
  if (liveRemerged.length > 0) core.cs.observe(liveRemerged);
  if (reportDeferred.size > 0) deps.log.write("info", "DEFERRED", { paths: reportDeferred.size });
  for (const csId of rebase.cancelled) deps.log.write("info", "CS_READY_CANCELLED", { cs_id: csId });
  for (const p of phantoms) deps.log.write("warn", "PHANTOM", { path: p });
  return {
    ran: true,
    skipped: null,
    written: writtenPaths,
    deleted: deletedPaths,
    deferred: new Map([...reportDeferred].filter(([p]) => !notApplicable.has(p))),
    notApplicable,
    records: [...recordOf.values()],
    cancelled: rebase.cancelled
  };
}

// src/engine/assertions.ts
var SPECIAL4 = /* @__PURE__ */ new Set(["120000", "160000"]);
var PATH_CLASSES2 = /* @__PURE__ */ new Set(["QUARANTINED", "SAVE_ONLY", "UNMANAGED"]);
var OUTGOING_GUARDED = /* @__PURE__ */ new Set(["QUARANTINED", "SAVE_ONLY"]);
var fail = (letter, path) => ({ ok: false, letter, path });
function heldPathInP(A, P, masked, scope2) {
  const pDiff = diffPaths(A, P);
  for (const p of pDiff) if (masked(p)) return { letter: "i", path: p };
  for (const p of pDiff) if (PATH_CLASSES2.has(scope2(p))) return { letter: "INV-MASK", path: p };
  return null;
}
async function markerRows(inp, e) {
  return isRegularEntry(e) ? conflictMarkerRows(await inp.readBlob(e.oid)) : /* @__PURE__ */ new Set();
}
async function prePushAsserts(inp) {
  const { A, P, tipMap: TIP, out: OUT } = inp;
  const parents = inp.bnewParents;
  if (inp.T === ABSENT || parents.length !== 2 || parents[0] !== inp.T || parents[1] !== inp.liveCode) return fail("a", null);
  if (inp.cParents === null ? inp.liveCode !== inp.tip : inp.cParents.length !== 1 || inp.cParents[0] !== inp.tip || inp.liveCode === inp.tip) {
    return fail("a", null);
  }
  if (!isOid(inp.outTree) || TIP.size > 0 && (inp.outTree === inp.emptyTree || OUT.size === 0)) return fail("d", null);
  const outDiff = diffPaths(TIP, OUT);
  const pDiff = diffPaths(A, P);
  const pChanged = new Set(pDiff);
  if (pDiff.length > 0) {
    for (const p of outDiff) if (!pChanged.has(p)) return fail("b", p);
  }
  for (const p of outDiff) if (!pChanged.has(p)) return fail("c", p);
  for (const p of outDiff) {
    const rows2 = await markerRows(inp, OUT.get(p));
    if (rows2.size === 0) continue;
    const known = /* @__PURE__ */ new Set([...await markerRows(inp, P.get(p)), ...await markerRows(inp, TIP.get(p))]);
    for (const r of rows2) if (!known.has(r)) return fail("e", p);
  }
  for (const p of outDiff) {
    const o = OUT.get(p);
    const t = TIP.get(p);
    if (o !== void 0 && SPECIAL4.has(o.mode) || t !== void 0 && SPECIAL4.has(t.mode)) return fail("g", p);
  }
  for (const p of outDiff) if (OUTGOING_GUARDED.has(inp.scope(p))) return fail("h", p);
  const held = heldPathInP(A, P, inp.masked, inp.scope);
  if (held !== null) return fail(held.letter, held.path);
  if (inp.heldEntriesAdded !== 0) return fail("j", null);
  return { ok: true };
}

// src/engine/epoch.ts
import { join as join10 } from "node:path";

// src/engine/restart.ts
import { isAbsolute as isAbsolute2, join as join9, relative as relative2, sep as sep2 } from "node:path";

// src/sec/redact.ts
var SCHEME_USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/;
var SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
var SCP_USERINFO = /^[^/@:\s]+@([^/:\s]+:)/;
var SCHEME_USERINFO_IN_TEXT = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s"']*@/;
function sanitizeUrl(url) {
  const scheme = SCHEME_USERINFO.exec(url);
  if (scheme !== null) return scheme[1] + url.slice(scheme[0].length);
  const scp = SCP_USERINFO.exec(url);
  if (scp !== null) return url.slice(url.indexOf("@") + 1);
  return url;
}
function userinfoKind(url) {
  if (SCHEME.test(url)) return SCHEME_USERINFO.test(url) ? "secret" : "none";
  if (!url.includes("@")) return "none";
  return SCP_USERINFO.test(url) ? "scp_user" : "secret";
}
function redactSegment(s) {
  return s.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#\s"']*@/g, "$1").replace(/(^|[\s"'=(<,])[^\s"'=(<,/@:]+@([^\s"'/:@]+:)/g, "$1$2");
}
var KEEP_BEFORE = /[\s"']/;
var KEEP_AFTER = /[\s"',)]/;
function sanitizeText(line, keep = []) {
  const kept = keep.filter((k) => k.length > 0 && !SCHEME_USERINFO_IN_TEXT.test(k)).sort((a, b) => b.length - a.length);
  if (kept.length === 0) return redactSegment(line);
  let out = "";
  let from = 0;
  for (let i = 0; i < line.length; i++) {
    const k = kept.find((w) => line.startsWith(w, i) && (i === 0 || KEEP_BEFORE.test(line[i - 1])) && (i + w.length === line.length || KEEP_AFTER.test(line[i + w.length])));
    if (k === void 0) continue;
    out += redactSegment(line.slice(from, i)) + k;
    i += k.length - 1;
    from = i + 1;
  }
  return out + redactSegment(line.slice(from));
}

// src/git/push.ts
var OK_FLAGS = /* @__PURE__ */ new Set([" ", "+", "*", "=", "-"]);
function checkPushRef(ref, what) {
  checkRefName(what, ref);
  if (ref.includes("+")) throw new Error(`${what}: invalid push ref ${JSON.stringify(ref)} (a '+')`);
}
function pushSpec(newOid, ref, lease) {
  const oid2 = parseOid(newOid);
  const l = lease === ABSENT ? ABSENT : parseOid(lease);
  checkPushRef(ref, "pushSpec");
  return Object.freeze({ ref, newOid: oid2, lease: l });
}
function buildPushArgv(url, specs, pushOptions) {
  checkUrl("push", url);
  if (specs.length === 0) throw new Error("buildPushArgv: no refspec (git would push its default refspecs)");
  const checked = specs.map((s) => pushSpec(s.newOid, s.ref, s.lease));
  const seen = /* @__PURE__ */ new Set();
  for (const s of checked) {
    if (seen.has(s.ref)) throw new Error(`buildPushArgv: ref ${s.ref} named twice`);
    seen.add(s.ref);
  }
  const argv2 = ["push", "--porcelain", "--no-verify"];
  for (const o of pushOptions) {
    if (typeof o !== "string" || o.length === 0 || /[\0\r\n]/.test(o)) throw new Error(`buildPushArgv: invalid push option ${JSON.stringify(o)}`);
    argv2.push("-o", o);
  }
  for (const s of checked) argv2.push(`--force-with-lease=${s.ref}:${s.lease === ABSENT ? "" : s.lease}`);
  argv2.push(url);
  for (const s of checked) argv2.push(`${s.newOid}:${s.ref}`);
  return argv2;
}
function parsePorcelain(stdout, refs) {
  const out = new Map(refs.map((r) => [r, "none"]));
  const seen = /* @__PURE__ */ new Set();
  for (const raw of stdout.toString("utf8").split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length < 3 || line.charAt(1) !== "	") continue;
    const spec = line.slice(2).split("	")[0] ?? "";
    const colon = spec.lastIndexOf(":");
    if (colon < 0) continue;
    const to = spec.slice(colon + 1);
    if (!out.has(to) || seen.has(to)) continue;
    seen.add(to);
    out.set(to, OK_FLAGS.has(line.charAt(0)) ? "ok" : "rejected");
  }
  return out;
}
async function pushWith(repo, argv2, refs) {
  const r = await runNetwork(repo, argv2);
  return {
    code: r.code,
    killedByWatchdog: r.killedByWatchdog,
    durationMs: r.durationMs,
    statuses: parsePorcelain(r.stdout, refs),
    stderr: r.stderr,
    argv: Object.freeze([...argv2])
  };
}
function runPush(repo, url, specs, pushOptions) {
  const argv2 = buildPushArgv(url, specs, pushOptions);
  return pushWith(repo, argv2, specs.map((s) => s.ref));
}
function deleteProbeRef(repo, url, ref, allowed, lease) {
  checkPushRef(allowed, "deleteProbeRef");
  const segment = allowed.slice(allowed.lastIndexOf("/") + 1);
  if (!segment.startsWith("probe-") || segment.length === "probe-".length) {
    throw new Error(`deleteProbeRef: ${JSON.stringify(allowed)} is not a probe ref`);
  }
  if (ref !== allowed) throw new Error(`deleteProbeRef: ${JSON.stringify(ref)} is not the allowed probe ref ${JSON.stringify(allowed)}`);
  const expect = parseOid(lease);
  checkUrl("push", url);
  const argv2 = ["push", "--porcelain", "--no-verify", `--force-with-lease=${ref}:${expect}`, url, `:${ref}`];
  return pushWith(repo, argv2, [ref]);
}

// src/git/classify.ts
var NONRETRYABLE_STREAK = 3;
function classifyPush(o) {
  if (typeof o.refMovedSinceLease !== "boolean" || typeof o.ourOpIdsPresent !== "boolean") {
    throw new TypeError("classifyPush: refMovedSinceLease and ourOpIdsPresent must be booleans");
  }
  if (!Number.isSafeInteger(o.previousStreak) || o.previousStreak < 0) {
    throw new RangeError(`classifyPush: previousStreak must be a non-negative integer, got ${String(o.previousStreak)}`);
  }
  if (o.ourOpIdsPresent) {
    return { outcome: "landed", streak: 0 };
  }
  if (o.refMovedSinceLease) {
    return { outcome: "lease_lost", streak: 0 };
  }
  const streak = o.previousStreak + 1;
  return { outcome: streak >= NONRETRYABLE_STREAK ? "nonretryable" : "transient", streak };
}

// src/engine/pushResult.ts
var STATUSES = /* @__PURE__ */ new Set(["ok", "rejected", "none"]);
function checkBoard(what, v) {
  if (v !== ABSENT && !isOid(v)) throw new TypeError(`classifyPublish: ${what} must be an oid or ABSENT, got ${JSON.stringify(v)}`);
}
function classifyPublish(o) {
  if (!STATUSES.has(o.boardStatus)) throw new TypeError(`classifyPublish: unknown board status ${JSON.stringify(o.boardStatus)}`);
  checkBoard("refetchedBoard", o.refetchedBoard);
  checkBoard("lease", o.lease);
  if (typeof o.ourWriterOnChain !== "boolean") throw new TypeError("classifyPublish: ourWriterOnChain must be a boolean");
  if (!Number.isSafeInteger(o.previousStreak) || o.previousStreak < 0) {
    throw new RangeError(`classifyPublish: previousStreak must be a non-negative integer, got ${String(o.previousStreak)}`);
  }
  const moved = o.refetchedBoard !== o.lease;
  const landed = o.boardStatus === "ok" || o.ourWriterOnChain;
  if (!landed && !moved && o.boardStatus === "none") return { outcome: "network", streak: o.previousStreak };
  return classifyPush({ refMovedSinceLease: moved, ourOpIdsPresent: landed, previousStreak: o.previousStreak });
}

// src/engine/publish.ts
var HOST_THROTTLED2 = "HOST_THROTTLED";
var CHAIN_WALK_MAX = 1e4;
var HOST_TEXT_MAX = 2e3;
function report(outcome, why, extra) {
  return { attempted: false, outcome, why, bnew: null, c: null, records: [], assert: null, ...extra };
}
async function chainAfter(repo, tip, stop) {
  try {
    return await repo.firstParents(tip, stop === ABSENT ? null : stop, CHAIN_WALK_MAX);
  } catch (e) {
    if (e instanceof GitCommandError || e instanceof OidError) return null;
    throw e;
  }
}
async function bnewOnChain(repo, tip, lease, bnew) {
  if (tip === ABSENT) return false;
  if (tip === bnew) return true;
  if (tip === lease) return false;
  const chain = await chainAfter(repo, tip, lease);
  return chain === null ? null : chain.includes(bnew);
}
var isThrottleDraft = (d) => {
  const o = d;
  return o["type"] === "event" && o["kind"] === "health" && o["reason_code"] === HOST_THROTTLED2;
};
function signal(core, s, fromPush, otherPending) {
  const { postEvent } = core.governor.onSignal(s, fromPush, otherPending);
  if (!postEvent) return;
  core.outbox.add({ type: "event", cid: "", kind: "health", refs: [], reason_code: HOST_THROTTLED2 });
  core.governor.onEventQueued();
  core.deps.log.write("warn", HOST_THROTTLED2, { signal: s, queued: true });
}
function fetchSignal(core, view, otherPending) {
  if (view.deferred || view.httpThrottle === null) return;
  signal(core, view.httpThrottle, false, otherPending);
}
function handOverThrottle(core, view, states) {
  if (view !== null) fetchSignal(core, view, pendingCheap(core, states));
}
function pendingCheap(core, states) {
  if (core.outbox.pendingAllowed(states)) return true;
  if (states.length !== 0) return false;
  const pinned = pinnedPaths(core);
  return core.cs.ready().some((pair) => !pair.paths.some((p) => pinned.has(p)));
}
function metaNow(core, over = {}) {
  const view = core.view;
  const fp = foldPatch(core);
  return { ...view.meta, throttle: core.governor.toMeta(), outbox: core.outbox.toJson(), ...fp !== null ? fp.meta : {}, ...over };
}
async function commitWith(core, t, ready) {
  const prev = core.view;
  const fp = foldPatch(core);
  try {
    await core.commit({ ...t, ...ready !== null ? { ready } : {}, ...fp !== null ? { fold: fp.fold } : {} });
  } catch (e) {
    if (ready !== null && !(e instanceof StateCasLostError) && !(e instanceof KilledAt)) core.cs.restore(prev.ready, prev.meta.cs_human_next);
    throw e;
  }
}
async function dropPublished(core, csIds) {
  if (csIds.length === 0) return;
  core.cs.published(csIds);
  await commitWith(core, { meta: metaNow(core) }, core.cs.ready());
}
async function compose(core, it) {
  const records = core.holds.maskingRecords();
  await ensureAttrs(core, it.epochBase, [...core.cs.ready().flatMap((r) => r.paths), ...records.flatMap((r) => r.paths)]);
  const inp = { A: it.A, scope: (p) => it.scope(p).cls, records };
  const c = await core.cs.composeP(core.repo, it.A, (X) => maskEntries(X, inp), pinnedPaths(core));
  const masked = (p) => {
    const r = maskReason(p, inp);
    return r !== null && r !== "path_class";
  };
  return { ...c, masked };
}
async function buildOut(core, it, comp, aTree, pTree, tipTree) {
  const { repo, deps } = core;
  const view = core.view;
  const A = it.A;
  const P = comp.P;
  const TIP = it.tipMap;
  const merged = await mergeTree(repo, aTree, pTree, tipTree);
  deps.trace.emit({
    kind: "merge",
    peer: core.peerId,
    use: "publish",
    base: aTree,
    ours: pTree,
    theirs: tipTree,
    aTree,
    laC: view.laC,
    laB: view.laB,
    tip: it.tip,
    t: it.T,
    rc: merged.rc
  });
  const R = await repo.readTreeMap(merged.tree);
  const OUT = new Map(R);
  const replaced = /* @__PURE__ */ new Map();
  const replace = (p, e) => {
    if (e === void 0) OUT.delete(p);
    else OUT.set(p, { path: p, mode: e.mode, oid: e.oid });
    replaced.set(p, e === void 0 ? null : { path: p, mode: e.mode, oid: e.oid });
  };
  const all = /* @__PURE__ */ new Set([...A.keys(), ...P.keys(), ...TIP.keys(), ...R.keys()]);
  const carried = /* @__PURE__ */ new Set();
  const sources = [];
  for (const p of [...all].sort()) {
    if (!editable(p)) continue;
    const a = A.get(p);
    const o = P.get(p);
    const t = TIP.get(p);
    const res = R.get(p);
    if (sameEntry2(o, a) && !sameEntry2(res, t)) {
      replace(p, t);
      carried.add(p);
    } else if (o !== void 0 && !sameEntry2(o, a) && t === void 0 && res === void 0) {
      sources.push(p);
    }
  }
  const fold = it.fold;
  let epochMap = null;
  const ctx = {
    repo,
    isText: (p) => pathIsText(core, p),
    insertionMerge: (p) => core.config.merge.insertionMerge.some((g) => wildmatch(g, p)),
    concatAllowed: liveSet(fold).every((p) => fold.peers[p]?.regionSpec === deps.regionSpec),
    localOnly: () => false,
    ref: async (p) => {
      let e = A.get(p);
      if (e === void 0) {
        epochMap ??= await repo.readTreeMap((await repo.readCommit(it.epochBase)).tree);
        e = epochMap.get(p);
      }
      return e === void 0 || !isRegularEntry(e) ? null : repo.readBlob(e.oid);
    },
    write: true
  };
  const takeTip = /* @__PURE__ */ new Map();
  const route = (p, v) => {
    if (v.kind === "CONCAT") {
      replace(p, { path: p, mode: P.get(p)?.mode ?? TIP.get(p)?.mode ?? "100644", oid: v.blob });
    } else if (v.kind === "TAKE_TIP") {
      replace(p, v.entry === ABSENT ? void 0 : TIP.get(p));
      takeTip.set(p, v.stages);
    } else {
      replace(p, TIP.get(p));
    }
  };
  for (const p of sources) route(p, await conflict(ctx, p, A.get(p)?.oid ?? ABSENT, P.get(p).oid, ABSENT, "other"));
  const handled = /* @__PURE__ */ new Set([...carried, ...sources]);
  for (const p of merged.conflicted) {
    if (handled.has(p)) continue;
    const a = A.get(p);
    const o = P.get(p);
    const t = TIP.get(p);
    const content = isRegularEntry(a) && isRegularEntry(o) && isRegularEntry(t) && a.mode === o.mode && o.mode === t.mode;
    const unit = content ? "content" : "other";
    route(p, await conflict(ctx, p, a?.oid ?? ABSENT, o?.oid ?? ABSENT, t?.oid ?? ABSENT, unit));
  }
  const underFile = [];
  for (const p of [...OUT.keys()].sort()) {
    const o = P.get(p);
    if (!editable(p) || takeTip.has(p) || o === void 0 || sameEntry2(o, A.get(p)) || TIP.has(p)) continue;
    const parts = p.split("/");
    if (!parts.slice(1).some((_, i) => OUT.has(parts.slice(0, i + 1).join("/")))) continue;
    replace(p, void 0);
    takeTip.set(p, { s1: A.get(p)?.oid ?? ABSENT, s2: o.oid, s3: ABSENT });
    underFile.push(p);
  }
  const records = [];
  for (const [p, stages] of [...takeTip].sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0)) {
    records.push(await core.holds.hold({
      kind: "PATCH",
      residence: "ON_DISK",
      state: "CONFLICTED",
      paths: [p],
      blobs: { s1: { [p]: stages.s1 }, s2: { [p]: stages.s2 }, s3: { [p]: stages.s3 } },
      guard: "conflict",
      origin: "daemon",
      cs_ids: comp.csIds.filter((id) => comp.csPaths.get(id)?.includes(p) === true),
      displaced_by: null,
      local_only: it.scope(p).cls !== "LIVE"
    }));
  }
  const outTree = await editTreeIndexOnly(repo, deps.ports.fs, merged.tree, editsBetween(R, OUT), core.scratch("out"));
  return {
    outTree,
    out: outTree === merged.tree ? R : await repo.readTreeMap(outTree),
    conflicted: [.../* @__PURE__ */ new Set([...merged.conflicted, ...sources, ...underFile])].sort(),
    replaced: [...replaced].sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0).map(([path, e]) => ({ path, blob: e === null ? null : e.oid })),
    records
  };
}
async function governedPush(core, purpose, body, exempt, rank, classify, opts) {
  const { deps, governor } = core;
  const clock = deps.ports.clock;
  const pushOptions = opts?.pushOptions ?? (core.caps?.push_options === true ? ["ci.skip"] : []);
  const bnew = "specs" in body ? body.specs.find((s) => s.ref === core.refs.remoteBoard)?.newOid ?? null : null;
  if ("specs" in body) buildPushArgv(deps.url, body.specs, pushOptions);
  else if (body.deleteProbe.ref !== core.refs.probe(core.peerId)) throw new Error(`governedPush: ${JSON.stringify(body.deleteProbe.ref)} is not this peer's probe ref`);
  if (!governor.mayAttempt(rank, true, true, exempt)) {
    deps.trace.emit({ kind: "push", peer: core.peerId, purpose, argv: [], bnew, outcome: "denied" });
    return "denied";
  }
  governor.onAttemptStart();
  core.pushAttempts += 1;
  core.lastPushMono = clock.monoMs();
  const start = anchorNow(clock);
  let raw = null;
  let cls = null;
  let durationMs = 0;
  try {
    raw = "specs" in body ? await runPush(core.repo, deps.url, body.specs, pushOptions) : await deleteProbeRef(core.repo, deps.url, body.deleteProbe.ref, core.refs.probe(core.peerId), body.deleteProbe.lease);
    durationMs = elapsedMono(clock, start);
    if (durationMs > SLOW_PUSH_MS || raw.killedByWatchdog) signal(core, "slow_push", true, true);
    const http = readHttpThrottle(raw.stderr);
    if (http !== null) signal(core, http, true, true);
    cls = await classify(raw);
  } finally {
    const statuses = raw === null ? [] : [...raw.statuses.values()];
    governor.onAttemptEnd({
      durationMs: raw === null ? elapsedMono(clock, start) : durationMs,
      killed: raw?.killedByWatchdog ?? false,
      hadRefStatus: statuses.some((s) => s !== "none") || cls?.outcome === "ok",
      transient: cls?.transient ?? false,
      landed: cls?.landed ?? false
    });
  }
  deps.trace.emit({ kind: "push", peer: core.peerId, purpose, argv: raw.argv, bnew, outcome: cls.outcome });
  return { raw, cls };
}
var SCRATCH_RESET_LOG_MS = 6e5;
var scratchResetLogged = /* @__PURE__ */ new WeakMap();
async function okUpdatePlan(core, intent, P) {
  const { repo, deps } = core;
  try {
    for (const k of ["r", "a"]) await resetScratchIndex(deps.ports.fs, core.scratch(k));
    const { aTree, A } = await currentA(core);
    const C = intent.c === null ? null : await repo.readTreeMap((await repo.readCommit(intent.c)).tree);
    const included = new Set(intent.cs_ids);
    const acap = /* @__PURE__ */ new Map();
    for (const pair of core.cs.ready()) {
      if (!included.has(pair.csId)) continue;
      const m = await repo.readTreeMap(pair.A);
      for (const p of pair.paths) acap.set(p, m.get(p));
    }
    const edits = [];
    const changes = [];
    if (C !== null) {
      for (const p of diffPaths(A, P)) {
        const c = C.get(p);
        const a = A.get(p);
        if (!sameEntry2(c, P.get(p))) continue;
        if (!acap.has(p) || !sameEntry2(acap.get(p), a)) continue;
        edits.push(c === void 0 ? { path: p, remove: true } : { path: p, mode: c.mode, oid: c.oid });
        changes.push({ path: p, aOld: a ?? null, aNew: c ?? null, written: "none", sDiskBefore: null, writtenEntry: null });
      }
    }
    const newATree = await editTreeIndexOnly(repo, deps.ports.fs, aTree, edits, core.scratch("a"));
    const newA = edits.length === 0 ? A : await repo.readTreeMap(newATree);
    scratchResetLogged.delete(core);
    return { newATree, newA, changes };
  } catch (e) {
    if (!(e instanceof ScratchResetError)) throw e;
    const last = scratchResetLogged.get(core);
    const now = deps.ports.clock.monoMs();
    if (last === void 0 || now - last >= SCRATCH_RESET_LOG_MS) {
      scratchResetLogged.set(core, now);
      deps.log.write("error", "SCRATCH_RESET_FAILED", { file: e.file, code: e.code ?? "unknown", step: "push_ok" });
    }
    throw e;
  }
}
async function okUpdateApply(core, intent, plan) {
  const view = core.view;
  const { repo, deps } = core;
  core.cs.published(intent.cs_ids);
  setBoardOnlyFirstPublish(core, false);
  const rebase = await core.cs.rebase(repo, plan.changes, core.scratch("r"));
  const self = { peer: core.peerId, epoch: view.meta.epoch };
  let next = Math.max(view.meta.seq_next, intent.writer_seq + 1, core.outbox.maxOwnSeq(self) + 1);
  const alloc = { next: () => next++ };
  core.outbox.landed(new Set(intent.op_ids), intent.writer_seq, alloc, self);
  await commitWith(core, {
    laC: intent.c ?? view.laC,
    laB: intent.bnew,
    base: plan.newATree,
    meta: metaNow(core, { seq_next: next, rejections: null }),
    intent: { kind: "none" },
    t: /* @__PURE__ */ new Map()
  }, rebase.ready);
  for (const ch of plan.changes) deps.trace.emit({ kind: "A_set", peer: core.peerId, path: ch.path, blob: ch.aNew?.oid ?? null, cause: "push_confirmed" });
  setCurrentA(core, plan.newATree, plan.newA);
  for (const csId of rebase.cancelled) deps.log.write("info", "CS_READY_CANCELLED", { cs_id: csId });
}
async function okUpdateOrKeep(core, intent, P) {
  if (core.view === null) throw new Error("applyPushOk: no state");
  let plan;
  try {
    plan = await okUpdatePlan(core, intent, P);
  } catch (e) {
    if (e instanceof ScratchResetError) return false;
    throw e;
  }
  await okUpdateApply(core, intent, plan);
  return true;
}
function classifyByText(stderr, previousStreak) {
  const text2 = stderr.toString("utf8");
  if (/cannot lock ref|stale info/.test(text2)) return { outcome: "lease_lost", streak: 0 };
  if (/failed|rejected|declined/.test(text2)) {
    const streak = previousStreak + 1;
    return { outcome: streak >= 3 ? "nonretryable" : "transient", streak };
  }
  return { outcome: "network", streak: previousStreak };
}
async function classifyAttempt(core, raw, T, bnew, previousStreak) {
  const boardStatus = raw.statuses.get(core.refs.remoteBoard) ?? "none";
  if (boardStatus === "ok") return { outcome: "landed", streak: 0, observed: true };
  const view = await core.fetcher.fetch(true);
  await observeFetch(core, view, true);
  fetchSignal(core, view, true);
  if (view.deferred || !view.ok) return { outcome: "network", streak: previousStreak, observed: false };
  if (core.deps.testMutants.has("M12")) return { ...classifyByText(raw.stderr, previousStreak), observed: true };
  const onChain2 = await bnewOnChain(core.repo, view.board, T, bnew);
  if (onChain2 === null) return { outcome: "network", streak: previousStreak, observed: false };
  return { ...classifyPublish({ boardStatus, refetchedBoard: view.board, lease: T, ourWriterOnChain: onChain2, previousStreak }), observed: true };
}
async function resolvePushIntent(core, it) {
  const view = core.view;
  if (view.intent.kind !== "push") throw new Error("resolvePushIntent: no push intent");
  const intent = view.intent;
  if (it.fetched === null || it.fetched.deferred || !it.fetched.ok) return report("skipped", "intent_unresolved");
  const onChain2 = await bnewOnChain(core.repo, it.T, intent.lease_board, intent.bnew);
  if (onChain2 === null) return report("skipped", "intent_unresolved");
  if (onChain2) {
    const pTree = view.t.get("P");
    const P = pTree === void 0 ? (await currentA(core)).A : await core.repo.readTreeMap(pTree);
    if (!await okUpdateOrKeep(core, intent, P)) return report("skipped", "intent_unresolved");
    observeOwnLanding(core, intent.bnew, intent.lease_board);
    it.A = (await currentA(core)).A;
    return report("landed", "resolved", { bnew: intent.bnew, c: intent.c });
  }
  await commitWith(core, { intent: { kind: "none" }, t: /* @__PURE__ */ new Map(), meta: metaNow(core) }, null);
  return report("skipped", "resolved");
}
var HOST_INVISIBLE = /* @__PURE__ */ new Set([
  1564,
  8206,
  8207,
  8234,
  8235,
  8236,
  8237,
  8238,
  8294,
  8295,
  8296,
  8297,
  8232,
  8233,
  8203,
  65279
]);
var hostControl = (cp) => cp < 32 && cp !== 9 || cp >= 127 && cp <= 159 || HOST_INVISIBLE.has(cp);
function hostText(stderr) {
  let out = "";
  let n = 0;
  for (const ch of stderr.toString("utf8").replace(/\r\n|\n|\r/g, " ")) {
    if (n === HOST_TEXT_MAX) break;
    if (hostControl(ch.codePointAt(0))) continue;
    out += ch;
    n += 1;
  }
  return out;
}
var treeRefused = /* @__PURE__ */ new WeakMap();
function publishTreeRefused(core) {
  return treeRefused.get(core) ?? null;
}
function isBuildFailure(e) {
  return e instanceof GitCommandError || e instanceof OidError || e instanceof MergeFailedError || e instanceof BoardCapError || e instanceof BoardMalformedError || e instanceof ScratchResetError;
}
async function publishStep(core, it) {
  const view0 = core.view;
  if (view0 === null) throw new Error("publishStep: no state");
  const { repo, deps, governor } = core;
  const states = it.pushStates;
  handOverThrottle(core, it.fetched, states);
  if (governor.mode() === "normal") core.outbox.drop(isThrottleDraft);
  if (it.fetched !== null && !it.fetched.ok) return report("skipped", "fetch_failed");
  if (it.T === ABSENT) return report("skipped", "no_board");
  const T = it.T;
  if (view0.intent.kind === "push") return resolvePushIntent(core, it);
  if (view0.intent.kind !== "none") return report("skipped", "intent");
  if (core.writer.strandedPaths().length > 0) return report("skipped", "stranded");
  if (it.tick?.failed === true || it.tick === null && states.length === 0) return report("skipped", "snapshot_failed");
  if (it.tick?.publishBlocked === true || it.mat?.publishBlocked === true) return report("skipped", "filter_failure");
  const codeAllowed = states.length === 0 && !boardOnlyFirstPublish(core);
  let comp = null;
  if (codeAllowed && core.cs.ready().length > 0) {
    try {
      comp = await compose(core, it);
    } catch (e) {
      if (!(e instanceof ReadyBaseMismatchError)) throw e;
      deps.log.write("error", "NOT_CONVERGED", { cause: "publish_assert", check: "a_cap", path: e.path });
      return report("aborted", "ready_base_mismatch", { assert: { check: "a_cap", path: e.path } });
    }
    await ensureAttrs(core, it.epochBase, diffPaths(it.A, comp.P));
    const held = heldPathInP(it.A, comp.P, comp.masked, (p) => it.scope(p).cls);
    if (held !== null) return assertFailed(core, held.letter, held.path, []);
  }
  const P = comp?.P ?? it.A;
  const code = comp !== null && diffPaths(it.A, P).length > 0;
  const opsAllowed = core.outbox.pendingAllowed(states);
  if (!code && !opsAllowed) {
    if (comp !== null) await dropPublished(core, comp.csIds);
    const blocked = states.length > 0 && (core.cs.ready().length > 0 || core.outbox.size > 0);
    return report(blocked ? "skipped" : "nothing", blocked ? "state" : null);
  }
  const rank = governorRank(it.fold, core.peerId);
  if (!governor.mayAttempt(rank, true, true)) return report("skipped", "window");
  const outboxBefore = core.outbox.toJson();
  let j = null;
  try {
    j = await buildAndJournal(core, it, comp, code, P, T);
  } finally {
    if (j === null || !("intent" in j)) core.outbox = Outbox.fromJson(outboxBefore);
  }
  if (!("intent" in j)) return j;
  crashpoint("publish.out_built");
  deps.trace.emit({
    kind: "publish",
    peer: core.peerId,
    t: T,
    tip: it.tip,
    aTree: j.aTree,
    pTree: j.pTree,
    outTree: j.outTree,
    c: j.c,
    bnew: j.bnew,
    conflicted: j.conflicted,
    replaced: j.replaced
  });
  await deps.ports.scheduler.yieldPoint("publish.beforePush");
  return push(core, it, comp, P, T, rank, j);
}
async function buildAndJournal(core, it, comp, code, P, T) {
  const { repo, deps } = core;
  const states = it.pushStates;
  const csIds = comp?.csIds ?? [];
  let records = [];
  let built;
  try {
    const { aTree } = await currentA(core);
    const { tree: tipTree } = await liveCodeOf(core, T);
    let pTree2 = aTree;
    let outTree2 = tipTree;
    let out2 = it.tipMap;
    let conflicted = [];
    let replaced = [];
    if (code && comp !== null) {
      pTree2 = await editTreeIndexOnly(repo, deps.ports.fs, aTree, editsBetween(it.A, P), core.scratch("p"));
      if (deps.testMutants.has("M06")) {
        it.mat ??= await core.snapshot.materialize(tickInputOf(core, it));
        outTree2 = it.mat.sDisk;
        out2 = it.mat.sDiskMap;
      } else {
        const m = await buildOut(core, it, comp, aTree, pTree2, tipTree);
        ({ outTree: outTree2, out: out2, conflicted, replaced } = m);
        records = m.records;
        treeRefused.delete(core);
      }
    }
    if (boardOnlyFirstPublish(core) && outTree2 !== tipTree) {
      deps.log.write("error", "NOT_CONVERGED", { cause: "publish_assert", check: "join_first_publish" });
      return report("aborted", "join_first_publish", { records, assert: { check: "join_first_publish", path: null } });
    }
    if (outTree2 === tipTree && !core.outbox.pendingAllowed(states)) {
      await dropPublished(core, csIds);
      return report("nothing", null, { records });
    }
    const meta = core.view.meta;
    const self = { peer: core.peerId, epoch: meta.epoch };
    const rec = it.fold.peers[core.peerId];
    const lastSeq = rec !== void 0 && rec.epoch === meta.epoch ? rec.last_seq : 0;
    let next = Math.max(meta.seq_next, lastSeq + 1, core.outbox.maxOwnSeq(self) + 1);
    const alloc = { next: () => next++ };
    core.outbox.renumberAtOrBelow(lastSeq, alloc, self);
    const ops2 = core.outbox.take(states, self, alloc, { maxOps: OPS_MAX_LINES, maxBytes: OPS_MAX_BYTES });
    const writer2 = { peer: core.peerId, epoch: meta.epoch, seq: alloc.next() };
    let c2 = null;
    let cs = [];
    let csPaths = /* @__PURE__ */ new Map();
    if (outTree2 !== tipTree) {
      if (comp === null) throw new Error("publishStep: a code tree without a composition");
      cs = csIds.map((csId) => ({ csId, state: "closed", seq: 0, origin: "human", checks: "skipped", paths: comp.csPaths.get(csId)?.length ?? 0 }));
      csPaths = new Map(csIds.map((id) => [id, comp.csPaths.get(id) ?? []]));
      c2 = await repo.commitTree({ tree: outTree2, parents: [it.tip], subject: CODE_SUBJECT, trailers: liveCommitTrailers(writer2, ["human"], cs, csPaths, null) });
    }
    const liveCode = c2 ?? it.tip;
    let checkpoint = null;
    if ((it.fold.height + 1) % CHECKPOINT_EVERY === 0) {
      const draft = {
        liveCode,
        writer: writer2,
        cs,
        protocol: (await readBoardCommit(repo, T)).protocol,
        checkpoint: null,
        heldIds: [],
        opsLines: serializeOps(ops2).toString("utf8").split("\n").filter((l) => l.length > 0)
      };
      checkpoint = serializeFold(foldCommit(it.fold, draft, core.peerId).state);
    }
    const bnew2 = await buildBoardCommit(repo, { prevBoard: T, liveCode, writer: writer2, ops: ops2, cs, csPaths, protocol: null, checkpoint });
    built = { aTree, pTree: pTree2, outTree: outTree2, out: out2, c: c2, bnew: bnew2, writer: writer2, ops: ops2, seqNext: next, conflicted, replaced };
  } catch (e) {
    if (!isBuildFailure(e)) throw e;
    if (e instanceof IndexRefusedPathError) {
      if (!treeRefused.has(core)) deps.log.write("warn", "PUBLISH_TREE_REFUSED", { refused: e.paths.length });
      treeRefused.set(core, e.paths);
      return report("aborted", "path_not_indexable", { records });
    }
    deps.log.write("error", "PUBLISH_BUILD_FAILED", { code: e instanceof GitCommandError ? e.code : -1, kind: e instanceof Error ? e.name : "unknown" });
    return report("aborted", "build_failed", { records });
  }
  const { pTree, outTree, out, c, bnew, writer, ops, seqNext } = built;
  if (!await repo.hasObject(bnew, "commit") || c !== null && !await repo.hasObject(c, "commit")) {
    return assertFailed(core, "d", null, records);
  }
  await ensureAttrs(core, it.epochBase, [...diffPaths(it.tipMap, out), ...diffPaths(it.A, P)]);
  const asserted = await prePushAsserts({
    T,
    tip: it.tip,
    tipMap: it.tipMap,
    A: it.A,
    P,
    out,
    outTree,
    emptyTree: await repo.emptyTree(),
    bnewParents: (await repo.readCommit(bnew)).parents,
    liveCode: c ?? it.tip,
    cParents: c === null ? null : (await repo.readCommit(c)).parents,
    scope: (p) => it.scope(p).cls,
    masked: comp?.masked ?? (() => false),
    heldEntriesAdded: 0,
    readBlob: (o) => repo.readBlob(o)
  });
  if (!asserted.ok) return assertFailed(core, asserted.letter, asserted.path, records);
  const mirror = it.fetched?.code ?? ABSENT;
  let withMirror = mirror === ABSENT;
  if (!withMirror) {
    try {
      withMirror = await repo.isAncestor(mirror, it.tip);
    } catch (e) {
      if (!(e instanceof GitCommandError)) throw e;
      withMirror = false;
    }
  }
  const intent = {
    kind: "push",
    bnew,
    c,
    lease_board: T,
    lease_code: mirror,
    cs_ids: [...csIds],
    writer_seq: writer.seq,
    op_ids: ops.map((o) => o.id)
  };
  await commitWith(core, { intent, t: /* @__PURE__ */ new Map([["P", pTree]]), meta: metaNow(core, { seq_next: seqNext }) }, null);
  return { intent, aTree: built.aTree, pTree, outTree, c, bnew, records, conflicted: built.conflicted, replaced: built.replaced, withMirror, mirror };
}
async function push(core, it, comp, P, T, rank, j) {
  const { deps } = core;
  const { intent, c, bnew, records, withMirror, mirror } = j;
  const specs = [pushSpec(bnew, core.refs.remoteBoard, T)];
  if (withMirror) specs.push(pushSpec(it.tip, core.refs.remoteCode, mirror));
  const previousStreak = core.view.meta.rejections !== null && core.view.meta.rejections.lease === T ? core.view.meta.rejections.n : 0;
  let detail = null;
  const pushed = await governedPush(core, c === null ? "board_only" : "publish", { specs }, false, rank, async (raw) => {
    crashpoint("publish.sent");
    detail = await classifyAttempt(core, raw, T, bnew, previousStreak);
    const d2 = detail;
    return { outcome: d2.outcome, transient: d2.outcome === "transient" || d2.outcome === "nonretryable", landed: d2.outcome === "landed" };
  });
  const base = { attempted: pushed !== "denied", bnew, c, records, assert: null };
  if (pushed === "denied" || detail === null) {
    await commitWith(core, { intent: { kind: "none" }, t: /* @__PURE__ */ new Map(), meta: metaNow(core) }, null);
    return { ...base, outcome: "skipped", why: "window" };
  }
  const d = detail;
  switch (d.outcome) {
    case "landed": {
      crashpoint("publish.landed");
      if (!await okUpdateOrKeep(core, intent, P)) {
        return { ...base, outcome: "skipped", why: "intent_unresolved" };
      }
      observeOwnLanding(core, bnew, T);
      it.A = (await currentA(core)).A;
      return { ...base, outcome: "landed", why: null };
    }
    case "lease_lost":
      await commitWith(core, { intent: { kind: "none" }, t: /* @__PURE__ */ new Map(), meta: metaNow(core, { rejections: null }) }, null);
      return { ...base, outcome: "lease_lost", why: null };
    case "transient":
      if (d.streak === 2) signal(core, "rejection_streak", true, true);
      await commitWith(core, { intent: { kind: "none" }, t: /* @__PURE__ */ new Map(), meta: metaNow(core, { rejections: { lease: T, n: d.streak } }) }, null);
      deps.log.write("warn", "PUSH_REJECTED", { lease: T, streak: d.streak });
      return { ...base, outcome: "transient", why: null };
    case "nonretryable": {
      const holdId = await enterNonretryable(core, it, intent, comp, P, T, pushed.raw.stderr);
      return { ...base, outcome: "nonretryable", why: null, records: [...records, holdId] };
    }
    case "network":
      if (d.observed) {
        await commitWith(core, { intent: { kind: "none" }, t: /* @__PURE__ */ new Map(), meta: metaNow(core) }, null);
      }
      return { ...base, outcome: "network", why: d.observed ? null : "unobserved" };
    default:
      throw new Error(`publishStep: unexpected outcome ${String(d.outcome)}`);
  }
}
function assertFailed(core, letter, path, records) {
  core.deps.log.write("error", "NOT_CONVERGED", { cause: "publish_assert", check: letter, path });
  return report("aborted", `publish_assert:${letter}`, { records, assert: { check: letter, path } });
}
async function enterNonretryable(core, it, intent, comp, P, T, stderr) {
  const paths = [...new Set(intent.cs_ids.flatMap((id) => comp?.csPaths.get(id) ?? []))].sort();
  await ensureAttrs(core, it.epochBase, paths);
  const h0 = Object.fromEntries(paths.map((p) => [p, it.A.get(p)?.oid ?? ABSENT]));
  const h1 = Object.fromEntries(paths.map((p) => [p, P.get(p)?.oid ?? ABSENT]));
  const holdId = await core.holds.hold({
    kind: "PIN",
    residence: "ON_DISK",
    state: "ACTIVE",
    paths,
    blobs: { h0, h1 },
    guard: "host-reject",
    origin: "daemon",
    cs_ids: paths.length > 0 ? [...intent.cs_ids] : [],
    displaced_by: null,
    local_only: paths.some((p) => it.scope(p).cls !== "LIVE")
  });
  await commitWith(core, {
    intent: { kind: "none" },
    t: /* @__PURE__ */ new Map(),
    meta: metaNow(core, { rejections: { lease: T, n: 3 }, nonretryable: { lease: T, hold_id: holdId } })
  }, null);
  core.deps.log.write("error", "NONRETRYABLE", { hold_id: holdId, lease: T, host_said: sanitizeText(hostText(stderr)) });
  return holdId;
}

// src/engine/restart.ts
var LOST_STATE_MAX_COMMITS = 500;
var StartRefused = class extends Error {
  code;
  params;
  constructor(code, params) {
    super(`restart refused: ${code} ${JSON.stringify(params)}`);
    this.name = "StartRefused";
    this.code = code;
    this.params = params;
  }
};
var ANY_CODE = Object.freeze(Array.from({ length: 256 }, (_, i) => i));
var DAEMON_LOG_DIR = "log";
var DAEMON_LOG_RE = /^daemon-([0-9]+)\.jsonl$/;
var RESTART_MARK = "tmp/restart-mark";
var PACKED_REFS_STALE_MS = 3e4;
var RESTART_PENDING = "race";
var OP_MARKERS = Object.freeze(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer"]);
var LIST_TEXT_MAX = 1050;
var PATH_TEXT_MAX = 80;
var ZERO_RE = /^0+$/;
function codeOf4(e) {
  const c = typeof e === "object" && e !== null ? e.code : void 0;
  return typeof c === "string" ? c : void 0;
}
var sameAs = (x, e) => x !== null && (x === ABSENT ? e === void 0 : e !== void 0 && x.oid === e.oid && x.mode === e.mode);
async function scopeInputsFor(core, epochBase, paths) {
  const repo = core.repo;
  const asked = [...new Set(paths)].filter((p) => validPathSyntax(p));
  await ensureAttrs(core, epochBase, asked);
  const attrs = await core.attrs.snapshot(epochBase, asked);
  const mergeDrivers = /* @__PURE__ */ new Set();
  for (const { key } of await repo.configGetRegexp("^merge\\..+\\.driver$")) {
    const name = key.slice("merge.".length, key.length - ".driver".length);
    if (name.length > 0) mergeDrivers.add(name);
  }
  const hooksPathDir = hooksDir(core.deps.paths.workTree, await repo.configGet("core.hooksPath"));
  const config = (await readTeamConfig(repo, epochBase)).config;
  return { attrs, config, mergeDrivers, localOnlyPaths: /* @__PURE__ */ new Set(), hooksPathDir };
}
function scopeOfEntry(core, inp, p, mode) {
  return scopeOfTracked(p, mode, core.statCache.get(p)?.stat?.size ?? 0, inp);
}
async function tickOutside(core, A, aTree, epochBase, extraPaths = []) {
  const scope2 = await scopeInputsFor(core, epochBase, [...A.keys(), ...extraPaths]);
  const inp = { A, aTree, epochBase, scope: scope2, skip: tickSkip(core) };
  return { inp, tick: await core.snapshot.tick(inp) };
}
async function rootsOf(repo, commit) {
  const r = await repo.run(["rev-list", "--max-parents=0", parseOid(commit)]);
  return r.stdout.toString("utf8").split("\n").filter((l) => l.length > 0).map((l) => parseOid(l)).sort();
}
async function epochNow(repo) {
  const head = await repo.resolve("HEAD");
  if (head === null) throw new Error("start: HEAD names no commit");
  const sym = await repo.run(["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] });
  return { symref: sym.code === 0 ? sym.stdout.toString("utf8").trim() : "", head, stash: await repo.readRef("refs/stash") };
}
async function headCheck(core) {
  const { repo, deps } = core;
  const sym = await repo.run(["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] });
  const symref = sym.code === 0 ? sym.stdout.toString("utf8").trim() : "";
  if (symref !== core.refs.remoteBranch) return { ok: false, op: symref === "" ? "detached" : "other_branch" };
  for (const m of OP_MARKERS) {
    if (await deps.ports.fs.lstat(join9(deps.paths.gitDir, m)) !== null) return { ok: false, op: m };
  }
  const head = await repo.resolve("HEAD");
  if (head === null) return { ok: false, op: "unborn" };
  return { ok: true, head };
}
async function stateRefState(core) {
  const r = await core.repo.run(["show-ref", "--exists", core.refs.state], { okCodes: ANY_CODE });
  return r.code === 0 ? "present" : r.code === 2 ? "absent" : "broken";
}
function brokenAsidePrefix(core) {
  return `broken-state-ref-${core.refs.e}-`;
}
function isBrokenAside(core, name) {
  const prefix = brokenAsidePrefix(core);
  return name.startsWith(prefix) && /^[0-9]+$/.test(name.slice(prefix.length));
}
async function brokenStateLeftovers(core) {
  const tmp = core.path("tmp");
  let names;
  try {
    names = [...await core.deps.ports.fs.readdir(tmp)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  } catch (e) {
    if (codeOf4(e) === "ENOENT") return [];
    throw e;
  }
  return names.filter((n) => isBrokenAside(core, n)).map((n) => join9(tmp, n));
}
async function removeBrokenStateLeftovers(core) {
  for (const f of await brokenStateLeftovers(core)) {
    if (await unlinkQuiet(core, f, "broken_state_ref")) core.deps.log.write("info", "STATE_REF_BROKEN_LEFTOVER_REMOVED", { ref: core.refs.state, file: f });
  }
}
async function lstatQuiet(core, p) {
  try {
    return await core.deps.ports.fs.lstat(p);
  } catch {
    return null;
  }
}
async function olderFile(core, p, mark) {
  const st = await lstatQuiet(core, p);
  return st !== null && !st.isDirectory && st.mtimeNs < mark;
}
async function unlinkQuiet(core, p, what) {
  try {
    await core.deps.ports.fs.unlink(p);
    return true;
  } catch (e) {
    const c = codeOf4(e);
    if (c === "ENOENT" || c === "ENOTDIR") return true;
    core.deps.log.write("warn", "RESTART_LEFTOVER_KEPT", { what, code: c ?? "unknown" });
    return false;
  }
}
async function readdirQuiet(core, dir) {
  try {
    return [...await core.deps.ports.fs.readdir(dir)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  } catch {
    return [];
  }
}
async function lockFilesUnder(core, dir) {
  const out = [];
  for (const name of await readdirQuiet(core, dir)) {
    const p = join9(dir, name);
    const st = await lstatQuiet(core, p);
    if (st === null || st.isSymbolicLink) continue;
    if (st.isDirectory) out.push(...await lockFilesUnder(core, p));
    else if (name.endsWith(".lock")) out.push(p);
  }
  return out;
}
async function restartMark(core) {
  const f = core.path(RESTART_MARK);
  await core.deps.ports.fs.writeFile(f, Buffer.from("cowork restart\n", "utf8"));
  const st = await core.deps.ports.fs.lstat(f);
  if (st === null) throw new Error("restart: the restart marker vanished");
  return st.mtimeNs;
}
async function removeOwnLocks(core) {
  const { gitDir, coworkDir } = core.deps.paths;
  const e = core.refs.e;
  const files = [
    ...await lockFilesUnder(core, join9(gitDir, "refs", "cowork-local", e)),
    ...await lockFilesUnder(core, join9(gitDir, "refs", "cowork-remote")),
    join9(coworkDir, `${e}.index.lock`)
  ];
  const tmp = join9(coworkDir, "tmp");
  for (const name of await readdirQuiet(core, tmp)) {
    if (name.endsWith(".index") || name.endsWith(".index.lock")) files.push(join9(tmp, name));
  }
  for (const f of files) {
    const st = await lstatQuiet(core, f);
    if (st !== null && !st.isDirectory) await unlinkQuiet(core, f, "own_leftover");
  }
}
async function removeOwnLeftovers(core, mark) {
  const { gitDir, coworkDir } = core.deps.paths;
  await removeOwnLocks(core);
  const tmp = join9(coworkDir, "tmp");
  for (const name of await readdirQuiet(core, tmp)) {
    if (!name.endsWith(".new")) continue;
    const f = join9(tmp, name);
    const st = await lstatQuiet(core, f);
    if (st !== null && !st.isDirectory) await unlinkQuiet(core, f, "own_leftover");
  }
  const packed = await lstatQuiet(core, join9(gitDir, "packed-refs.lock"));
  if (packed !== null && !packed.isDirectory) {
    const ageMs = Number((mark - packed.mtimeNs) / 1000000n);
    if (ageMs >= PACKED_REFS_STALE_MS) core.deps.log.write("warn", "PACKED_REFS_LOCK_STALE", { age_s: Math.floor(ageMs / 1e3) });
  }
  await core.stage.clear();
}
function coworkRelative(core, file) {
  const dir = core.deps.paths.coworkDir;
  const rel = isAbsolute2(file) ? relative2(dir, file) : file;
  const norm = rel.split(sep2).join("/");
  if (norm.length === 0 || norm.startsWith("../") || norm === ".." || isAbsolute2(norm)) return null;
  return norm;
}
async function orphanPaths(core) {
  const all = /* @__PURE__ */ new Map();
  const ambiguous = /* @__PURE__ */ new Set();
  const dir = core.path(DAEMON_LOG_DIR);
  const logs = (await readdirQuiet(core, dir)).map((n) => ({ n, m: DAEMON_LOG_RE.exec(n) })).filter((x) => x.m !== null).map(({ n, m }) => ({ n, k: Number(m[1]) })).sort((a, b) => a.k !== b.k ? a.k - b.k : a.n < b.n ? -1 : a.n > b.n ? 1 : 0).map(({ n }) => n);
  for (const name of logs) {
    let text2;
    try {
      text2 = (await core.deps.ports.fs.readFile(join9(dir, name))).toString("utf8");
    } catch {
      continue;
    }
    const mine = /* @__PURE__ */ new Map();
    for (const line of text2.split("\n")) {
      if (!line.includes("WRITE_TMP_ORPHAN")) continue;
      try {
        const o = JSON.parse(line);
        if (o.code !== "WRITE_TMP_ORPHAN" || typeof o.params?.file !== "string") continue;
        const key = coworkRelative(core, o.params.file);
        if (key !== null) mine.set(key, typeof o.params.path === "string" ? o.params.path : null);
      } catch {
      }
    }
    for (const [k, p] of mine) {
      if (all.has(k) && all.get(k) !== p) ambiguous.add(k);
      all.set(k, p);
    }
  }
  const out = /* @__PURE__ */ new Map();
  for (const [k, p] of all) if (p !== null && !ambiguous.has(k)) out.set(k, p);
  return out;
}
async function freeTmpName(core, prefix, ext) {
  for (let k = 0; ; k++) {
    const f = core.path(`tmp/${prefix}${k}${ext}`);
    if (await lstatQuiet(core, f) === null) return f;
  }
}
async function keepAsOrphan(core, file, path, why) {
  const { fs, random, clock } = core.deps.ports;
  let aside;
  try {
    aside = await orphanAside(fs, random, clock, core.path("tmp"), "old");
    await fs.rename(file, aside);
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    core.deps.log.write("warn", "RESTART_OLD_KEPT", { path, read: why, code: codeOf4(e) ?? "unknown" });
    return file;
  }
  core.deps.log.write("warn", "WRITE_TMP_ORPHAN", { file: aside, path, kept: true });
  return aside;
}
async function restartRecord(core, path, base, held, live) {
  return core.holds.hold({
    kind: "PATCH",
    residence: "ON_DISK",
    state: "ACTIVE",
    paths: [path],
    blobs: { h0: { [path]: base?.oid ?? ABSENT }, h1: { [path]: held } },
    guard: "restart",
    origin: "daemon",
    cs_ids: [],
    displaced_by: null,
    local_only: !live
  });
}
async function restart(core) {
  const report2 = { intent: "none", rolledBackGroups: [], restartRecords: [], pushResolved: null, lostState: null };
  let view = null;
  let lost = false;
  try {
    view = await core.state.read();
  } catch (e) {
    if (!(e instanceof LostStateError)) throw e;
    lost = true;
  }
  let broken = false;
  if (view === null && !lost) {
    const st = await stateRefState(core);
    if (core.view === null && st === "absent" && (await brokenStateLeftovers(core)).length === 0) {
      throw new Error("restart: no state ref (the start dispatches GENESIS or JOIN)");
    }
    broken = st === "broken";
    lost = true;
  }
  if (lost) {
    const h = await headCheck(core);
    if (!h.ok) throw new StartRefused("START_HEAD_STATE", { op: h.op });
  }
  const mark = await restartMark(core);
  try {
    await removeOwnLeftovers(core, mark);
    if (lost) {
      report2.lostState = await rebuildLostState(core, broken);
      report2.restartRecords = [...report2.lostState.records];
      return report2;
    }
    const v = view;
    attachState(core, v);
    report2.intent = v.intent.kind;
    await removeBrokenStateLeftovers(core);
    const privateIndex = join9(core.deps.paths.coworkDir, `${core.refs.e}.index`);
    let indexOk = await lstatQuiet(core, privateIndex) !== null;
    if (indexOk) {
      try {
        await core.repo.listIndex(privateIndex);
      } catch (e) {
        if (e instanceof KilledAt) throw e;
        indexOk = false;
      }
    }
    if (!indexOk) {
      await unlinkQuiet(core, privateIndex, "private_index");
      await core.snapshot.reseed(v.snap);
      core.deps.log.write("warn", "PRIVATE_INDEX_RESEEDED", { snap: v.snap });
    }
    const { aTree, A } = await currentA(core);
    const { tick } = await tickOutside(core, A, aTree, v.meta.EPOCH_BASE);
    if (tick.failed) throw new Error("restart: the detection tick failed (a refresh or diff-files error on the private index)");
    let handled = /* @__PURE__ */ new Set();
    if (v.intent.kind === "apply" || v.intent.kind === "local") {
      handled = await resolveWriteIntent(core, v, report2);
    } else if (v.intent.kind === "push") {
      const prepared = await prepareIteration(core, 0, { materialize: false, forceFetch: true });
      if (prepared.ok && core.view?.intent.kind === "push") {
        const r = await resolvePushIntent(core, prepared.it);
        report2.pushResolved = r.outcome === "landed" ? "landed" : r.why === "resolved" ? "discarded" : null;
      }
    }
    await resolveTmpLeftovers(core, mark, report2, handled);
    await core.snapshot.reseed(core.view.snap);
    await reformOpenCs(core);
    return report2;
  } finally {
    await unlinkQuiet(core, core.path(RESTART_MARK), "restart_mark");
  }
}
async function reformOpenCs(core) {
  const { A } = await currentA(core);
  const snap = await core.repo.readTreeMap(core.view.snap);
  await dropVanishedReady(core, A, snap);
  const view = core.view;
  const ready = new Set(core.cs.ready().flatMap((r) => r.paths));
  const candidates = [];
  for (const p of [.../* @__PURE__ */ new Set([...A.keys(), ...snap.keys()])].sort()) {
    if (ready.has(p)) continue;
    const a = A.get(p);
    const s = snap.get(p);
    if (sameEntry2(a, s)) continue;
    candidates.push({ path: p, entry: a ?? s });
  }
  if (candidates.length === 0) return;
  const inp = await scopeInputsFor(core, view.meta.EPOCH_BASE, candidates.map((c) => c.path));
  const sized = candidates.map((c) => ({ path: c.path, e: snap.get(c.path) ?? c.entry })).filter((x) => x.e.mode !== "160000");
  const sizes = await core.repo.blobSizes(sized.map((x) => x.e.oid));
  const size = new Map(sized.map((x, i) => [x.path, sizes[i] ?? 0]));
  const live = candidates.filter((c) => scopeOfTracked(c.path, c.entry.mode, size.get(c.path) ?? 0, inp).cls === "LIVE").map((c) => c.path);
  if (live.length > 0) core.cs.observe(live);
}
async function dropVanishedReady(core, A, snap) {
  const view = core.view;
  const kept = view.intent.kind === "push" ? new Set(view.intent.cs_ids) : /* @__PURE__ */ new Set();
  const created = /* @__PURE__ */ new Map();
  const inKept = /* @__PURE__ */ new Set();
  for (const pair of core.cs.ready()) {
    const paths = pair.paths.filter((p) => !A.has(p));
    if (paths.length === 0) continue;
    const R = await core.repo.readTreeMap(pair.R);
    for (const p of paths) {
      const e = R.get(p);
      if (e === void 0) continue;
      if (!created.has(p)) created.set(p, e);
      if (kept.has(pair.csId)) inKept.add(p);
    }
  }
  const gone = [];
  for (const p of [...created.keys()].sort()) {
    if (inKept.has(p) && snap.has(p)) continue;
    let st;
    try {
      st = await core.deps.ports.fs.lstat(join9(core.deps.paths.workTree, ...p.split("/")));
    } catch {
      continue;
    }
    if (st === null) gone.push(p);
  }
  if (gone.length === 0) return;
  const inp = await scopeInputsFor(core, view.meta.EPOCH_BASE, gone);
  const sized = gone.map((p) => created.get(p)).filter((e) => e.mode !== "160000");
  const sizes = await core.repo.blobSizes(sized.map((e) => e.oid));
  const size = new Map(sized.map((e, i) => [e.path, sizes[i] ?? 0]));
  const vanished = new Set(gone.filter((p) => scopeOfTracked(p, created.get(p).mode, size.get(p) ?? 0, inp).cls === "LIVE"));
  if (vanished.size === 0) return;
  if (!await core.cs.dropVanished(core.repo, vanished, kept, core.scratch("r"))) return;
  await core.commit({ ready: core.cs.ready() });
  core.deps.log.write("warn", "RESTART_READY_VANISHED", { paths: vanished.size });
}
async function rebuildLostState(core, broken) {
  const report2 = await rebuildLostStateOnce(core, broken);
  await removeBrokenStateLeftovers(core);
  return report2;
}
async function rebuildLostStateOnce(core, broken) {
  const { repo, deps } = core;
  let aside = null;
  try {
    if (broken) {
      const probe = await lsRemote(repo, deps.url, [core.refs.remoteBoard]);
      if (!probe.ok) throw new StartRefused("START_REMOTE", { reason: "unreachable" });
      aside = await moveBrokenStateRef(core);
      await assertNotBroken(core);
    }
    const f = await fetchRefs(repo, deps.url, core.refs.fetchSpecs);
    if (!f.ok) throw new StartRefused("START_REMOTE", { reason: f.remoteAnswered ? "local_ref_update" : "unreachable" });
    const branch = f.values.get(core.refs.remoteBranch) ?? ABSENT;
    if (branch !== ABSENT && !await sameRepository(core, branch)) throw new StartRefused("START_REPO_IDENTITY", {});
    const T = f.values.get(core.refs.remoteBoard) ?? ABSENT;
    if (T === ABSENT) throw new StartRefused("GENESIS_BOARD_MISSING", { branch: deps.branch });
    try {
      await readBoardCommit(repo, T);
      const { tip } = await liveCodeOf(core, T);
      await liveBase(repo, tip);
    } catch (e) {
      if (isRemoteContentError(e)) throw new StartRefused("START_REMOTE", { reason: "board_malformed" });
      throw e;
    }
    return await lostStateRebuild(core, T, "lost_state");
  } catch (e) {
    if (aside !== null && !(e instanceof KilledAt)) await restoreBrokenStateRef(core, aside);
    if (e instanceof IndexRefusedPathError) throw new StartRefused("START_REPO_SHAPE", { reason: "path_not_indexable" });
    throw e;
  }
}
function modeFor(path, A, index) {
  const m = index.get(path)?.mode ?? A.get(path)?.mode;
  return m === "100755" ? "100755" : "100644";
}
async function resolveWriteIntent(core, v, report2) {
  const { repo, deps } = core;
  const intent = v.intent;
  const { aTree, A } = await currentA(core);
  const privateIndex = join9(deps.paths.coworkDir, `${core.refs.e}.index`);
  const index = await repo.listIndex(privateIndex);
  const live = await liveScopes(core, v.meta.EPOCH_BASE, A, intent.kind === "apply" ? intent.groups.flatMap((g) => g.entries.map((e) => e.path)) : intent.entries.map((e) => e.path));
  const M = intent.kind === "apply" ? await repo.readTreeMap(must(v.t.get("M"), "t/M")) : null;
  const S = intent.kind === "apply" ? await repo.readTreeMap(must(v.t.get("S"), "t/S")) : null;
  const TIP = intent.kind === "apply" ? await repo.readTreeMap(must(v.t.get("TIP"), "t/TIP")) : null;
  const targets = /* @__PURE__ */ new Map();
  const pre = /* @__PURE__ */ new Map();
  const groupOf = /* @__PURE__ */ new Map();
  if (intent.kind === "apply") {
    for (const g of intent.groups) {
      for (const e of g.entries) {
        targets.set(e.path, M.get(e.path) ?? null);
        pre.set(e.path, S.get(e.path) ?? ABSENT);
        groupOf.set(e.path, g.n);
      }
    }
  } else {
    for (const e of intent.entries) {
      const mode = modeFor(e.path, A, index);
      targets.set(e.path, e.target === "DELETE" ? null : { path: e.path, mode, oid: e.target });
      pre.set(e.path, e.expected === ABSENT ? ABSENT : { path: e.path, mode, oid: e.expected });
      groupOf.set(e.path, 0);
    }
  }
  const rb = await core.writer.rollbackIntent(intent, targets);
  report2.rolledBackGroups = [...rb.rolledBack];
  const complete = new Set(rb.complete);
  const decisions = [];
  for (const path of [...targets.keys()].sort()) {
    if (!stageable(path) || core.snapshot.isCarried(path)) continue;
    const target = targets.get(path) ?? null;
    const p0 = pre.get(path) ?? ABSENT;
    const mc = await core.diskEq.manyCandidates(path, [target ?? ABSENT, p0]);
    const matchesTarget = mc.match !== null && (target === null ? mc.match === ABSENT : mc.match !== ABSENT && mc.match.oid === target.oid);
    const matchesPre = mc.match !== null && !matchesTarget && (p0 === ABSENT ? mc.match === ABSENT : mc.match !== ABSENT && mc.match.oid === p0.oid);
    decisions.push({ path, mc, matchesTarget, matchesPre });
  }
  const diskDecided = new Set(decisions.filter((d) => d.matchesTarget || d.matchesPre).map((d) => d.path));
  const recorded = /* @__PURE__ */ new Set();
  const handled = /* @__PURE__ */ new Set();
  for (const { path, file } of rb.leftoverOld) {
    const absent = await lstatQuiet(core, join9(deps.paths.workTree, ...path.split("/"))) === null;
    const strandedHere = absent && !complete.has(groupOf.get(path) ?? -1);
    const mc = await core.diskEq.manyCandidates(path, [pre.get(path) ?? ABSENT], file);
    if (mc.read === "missing") continue;
    if (mc.match !== null && !strandedHere && diskDecided.has(path)) {
      await unlinkQuiet(core, file, "old_matched");
      continue;
    }
    if (mc.read === "ok" && mc.raw !== null) {
      const id = await restartRecord(core, path, A.get(path), mc.raw, live(path));
      report2.restartRecords.push(id);
      recorded.add(path);
      await unlinkQuiet(core, file, "old_recorded");
    } else {
      handled.add(await keepAsOrphan(core, file, path, mc.raw === null && mc.read === "ok" ? "filter_failure" : mc.read));
    }
  }
  const aEdits = [];
  const changes = [];
  const aSet = [];
  const pending = new Map(Object.entries(v.meta.pending));
  for (const { path, mc, matchesTarget, matchesPre } of decisions) {
    if (intent.kind === "apply") {
      if (matchesTarget) {
        const t = TIP.get(path);
        const a = A.get(path);
        aEdits.push(t === void 0 ? { path, remove: true } : { path, mode: t.mode, oid: t.oid });
        aSet.push({ path, blob: t?.oid ?? null });
        const recs = onDiskConflictRecords(core, path);
        changes.push({
          path,
          aOld: a ?? null,
          aNew: t ?? null,
          written: recs.length > 0 ? "take_tip" : "clean",
          sDiskBefore: S.get(path) ?? null,
          writtenEntry: recs.length > 0 ? null : M.get(path) ?? null
        });
        for (const id of recs) await core.holds.transition(id, { residence: "OFF_DISK" });
        pending.delete(path);
        continue;
      }
      pending.set(path, RESTART_PENDING);
    }
    if (matchesTarget || matchesPre || recorded.has(path)) continue;
    if (mc.read === "ok" && mc.raw !== null || mc.read === "missing") {
      const id = await restartRecord(core, path, A.get(path), mc.read === "missing" ? ABSENT : mc.raw, live(path));
      report2.restartRecords.push(id);
    } else {
      deps.log.write("warn", "RESTART_PATH_UNDECIDED", { path, read: mc.read === "ok" ? "filter_failure" : mc.read });
      if (intent.kind === "apply") pending.set(path, "unreadable");
    }
  }
  const rebase = await core.cs.rebase(repo, changes, core.scratch("r"));
  const newATree = await editTreeIndexOnly(repo, deps.ports.fs, aTree, aEdits, core.scratch("a"));
  const newA = newATree === aTree ? A : await repo.readTreeMap(newATree);
  const keep = new Map(v.keep);
  keep.delete(LOCAL_INTENT_KEEP);
  const fp = foldPatch(core);
  const meta = { ...v.meta, pending: Object.fromEntries(pending), ...fp !== null ? fp.meta : {} };
  await core.commit({
    ...intent.kind === "apply" ? { laC: intent.tip, laB: intent.board, snap: must(v.t.get("S"), "t/S") } : {},
    base: newATree,
    meta,
    intent: { kind: "none" },
    t: /* @__PURE__ */ new Map(),
    keep,
    ready: rebase.ready,
    ...fp !== null ? { fold: fp.fold } : {}
  });
  setCurrentA(core, newATree, newA);
  for (const s of aSet) deps.trace.emit({ kind: "A_set", peer: core.peerId, path: s.path, blob: s.blob, cause: "restart_decision" });
  for (const csId of rebase.cancelled) deps.log.write("info", "CS_READY_CANCELLED", { cs_id: csId });
  if (report2.restartRecords.length > 0) deps.log.write("warn", "RESTART_RECORDS", { n: report2.restartRecords.length });
  return handled;
}
function must(o, what) {
  if (o === void 0) throw new Error(`restart: the journaled intent has no ${what}`);
  return o;
}
async function liveScopes(core, epochBase, A, paths) {
  const inp = await scopeInputsFor(core, epochBase, paths);
  return (p) => {
    try {
      return scopeOfEntry(core, inp, p, A.get(p)?.mode ?? "100644").cls === "LIVE";
    } catch {
      return true;
    }
  };
}
async function resolveTmpLeftovers(core, mark, report2, handled) {
  const tmp = core.path("tmp");
  const names = (await readdirQuiet(core, tmp)).filter((n) => (n.endsWith(".old") || n.endsWith(".redo") || n.endsWith(".new")) && !handled.has(join9(tmp, n)));
  if (names.length === 0) return;
  const view = core.view;
  const known = await orphanPaths(core);
  const snap = await core.repo.readTreeMap(view.snap);
  const { A } = await currentA(core);
  const ringMark = mark - BigInt(RING_KEEP_MS) * 1000000n;
  for (const name of names) {
    const file = join9(tmp, name);
    if (!name.endsWith(".old")) {
      await unlinkQuiet(core, file, "tmp_leftover");
      continue;
    }
    if (name.startsWith("ring-")) {
      if (await olderFile(core, file, ringMark)) await unlinkQuiet(core, file, "ring_expired");
      else core.deps.log.write("warn", "RESTART_RING_KEPT", { file });
      continue;
    }
    const path = known.get(`tmp/${name}`);
    if (path === void 0 || !stageable(path)) {
      core.deps.log.write("warn", "RESTART_ORPHAN_KEPT", { file, why: "unknown_path" });
      continue;
    }
    const mc = await core.diskEq.manyCandidates(path, [snap.get(path) ?? ABSENT], file);
    if (mc.read === "missing") continue;
    const onDisk = await lstatQuiet(core, join9(core.deps.paths.workTree, ...path.split("/"))) !== null;
    if (mc.match !== null && onDisk) {
      await unlinkQuiet(core, file, "orphan_matched");
    } else if (mc.read === "ok" && mc.raw !== null) {
      const live = await liveScopes(core, view.meta.EPOCH_BASE, A, [path]);
      report2.restartRecords.push(await restartRecord(core, path, A.get(path), mc.raw, live(path)));
      await unlinkQuiet(core, file, "orphan_recorded");
    } else {
      core.deps.log.write("warn", "RESTART_ORPHAN_KEPT", { file, read: mc.read === "ok" ? "filter_failure" : mc.read });
    }
  }
}
async function versionsOf(repo, tip, stop, need, TIP) {
  const out = /* @__PURE__ */ new Map();
  for (const p of need) out.set(p, [TIP.get(p) ?? ABSENT]);
  if (need.size === 0 || tip === stop) return out;
  const r = await repo.run([
    "log",
    "--no-show-signature",
    "--no-color",
    "--first-parent",
    "--diff-merges=first-parent",
    "--raw",
    "-z",
    "--no-renames",
    "--no-abbrev",
    "--format=%x00%H",
    `--max-count=${LOST_STATE_MAX_COMMITS - 1}`,
    parseOid(tip),
    `^${parseOid(stop)}`
  ]);
  const tokens = r.stdout.toString("utf8").split("\0");
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    const head = t.startsWith("\n") ? t.slice(1) : t;
    if (head.startsWith(":")) {
      const path = tokens[i + 1] ?? "";
      i += 2;
      const f = head.slice(1).split(" ");
      const [oldMode, , oldOid] = f;
      if (f.length < 5 || oldMode === void 0 || oldOid === void 0) continue;
      const list = out.get(path);
      if (list === void 0) continue;
      const v = ZERO_RE.test(oldMode) ? ABSENT : { path, mode: oldMode, oid: parseOid(oldOid) };
      const dup = list.some((x) => x === ABSENT ? v === ABSENT : v !== ABSENT && x.oid === v.oid && x.mode === v.mode);
      if (!dup) list.push(v);
      continue;
    }
    i += 1;
  }
  return out;
}
async function maxOwnCsN(core, tip) {
  const re = new RegExp(`^Cowork-CS: ${core.peerId}/human/([1-9][0-9]*) `, "gm");
  let max = 0;
  const take = (digits) => {
    const n = Number(digits);
    if (Number.isSafeInteger(n)) max = Math.max(max, n);
  };
  const r = await core.repo.run(["log", "--no-show-signature", "--no-color", "--first-parent", "--format=%B", `--max-count=${LOST_STATE_MAX_COMMITS}`, parseOid(tip)]);
  for (const m of r.stdout.toString("utf8").matchAll(re)) take(m[1]);
  for (const rec of core.holds.all()) {
    for (const id of rec.cs_ids) {
      const m = /^[0-9a-f]{32}\/human\/([1-9][0-9]*)$/.exec(id);
      if (m !== null && id.startsWith(`${core.peerId}/`)) take(m[1]);
    }
  }
  return max;
}
async function maxIncidentN(core) {
  let max = 0;
  const prefix = `refs/cowork-local/${core.refs.e}/`;
  for (const { ref } of await core.repo.listRefs(prefix)) {
    const m = /^incident-([1-9][0-9]*)(-own)?$/.exec(ref.slice(prefix.length));
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return max;
}
function pathText(p) {
  const cps = [...p];
  if (cps.length <= PATH_TEXT_MAX) return p;
  const keep = PATH_TEXT_MAX - 1;
  const head = Math.ceil(keep / 2);
  return `${cps.slice(0, head).join("")}…${cps.slice(cps.length - (keep - head)).join("")}`;
}
function boundedList(items) {
  let text2 = "";
  let n = 0;
  for (const it of items) {
    const next = text2.length === 0 ? it : `${text2},${it}`;
    if (next.length > LIST_TEXT_MAX) break;
    text2 = next;
    n += 1;
  }
  return { text: text2, omitted: items.length - n };
}
async function sameRepository(core, branch) {
  const roots = await rootsOf(core.repo, branch);
  const pinned = core.view?.meta.pinned.identity ?? null;
  if (pinned !== null) {
    const want = [...pinned].sort();
    return roots.length === want.length && roots.every((r, i) => r === want[i]);
  }
  const head = await core.repo.resolve("HEAD");
  if (head === null) return true;
  const mine = new Set(await rootsOf(core.repo, head));
  return roots.some((r) => mine.has(r));
}
function blobMode(e) {
  return e?.mode === "100755" ? "100755" : "100644";
}
async function strandedCandidates(core, s, candidates) {
  const files = candidates.filter((c) => c !== ABSENT && (c.mode === "100644" || c.mode === "100755"));
  const mc = await core.diskEq.manyCandidates(s.path, files, s.old);
  if (mc.read === "ok" && mc.raw !== null) return { match: mc.match === ABSENT ? null : mc.match, held: mc.raw };
  if (s.pre === null) throw new Error(`lostStateRebuild: the stranded restore of ${JSON.stringify(s.path)} names no pre-image blob (programming error)`);
  return { match: await preMatch(core, s.path, s.pre, files), held: s.pre.oid };
}
async function preMatch(core, path, pre, files) {
  if (files.length === 0) return null;
  if (pathIsFiltered(core, path)) return files.find((c) => c.oid === pre.oid) ?? null;
  const blobs = await core.repo.readBlobs([pre.oid, ...files.map((c) => c.oid)]);
  const preBytes = blobs[0];
  const skip = !pathIsText(core, path);
  for (let i = 0; i < files.length; i++) {
    const cBytes = blobs[i + 1];
    const res = canon(preBytes, cBytes, skip);
    if (res.ok && res.out.equals(cBytes)) return files[i];
  }
  return null;
}
async function lostStateRebuild(core, T, mode, paths, metaOverrides) {
  if (paths !== void 0 && metaOverrides !== void 0) throw new Error("lostStateRebuild: metaOverrides apply to a whole rebuild only, not with `paths` (programming error)");
  const { repo, deps } = core;
  const { tip, tree: tipTree } = await liveCodeOf(core, T);
  const TIP = await repo.readTreeMap(tipTree);
  const lb = await liveBase(repo, tip);
  const epochBase = lb.base;
  const perPath = paths !== void 0;
  if (!perPath) await core.snapshot.reseed(tipTree);
  const snapBase = perPath ? await currentA(core) : { aTree: tipTree, A: TIP };
  const { inp, tick } = await tickOutside(core, snapBase.A, snapBase.aTree, epochBase, TIP.keys());
  if (tick.failed) throw new Error("lost state: the snapshot failed; the rebuild runs again at the next start");
  const mat = await core.snapshot.materialize(inp);
  const S = mat.sDiskMap;
  const strandedOf = /* @__PURE__ */ new Map();
  for (const s of core.writer.strandedRestores()) {
    if (paths === void 0 || paths.has(s.path)) strandedOf.set(s.path, s);
  }
  const all = [...paths ?? /* @__PURE__ */ new Set([...TIP.keys(), ...S.keys(), ...strandedOf.keys()])].sort();
  const scope2 = await scopeInputsFor(core, epochBase, all);
  const clsOf = (p) => {
    const e = TIP.get(p) ?? S.get(p);
    return validPathSyntax(p) ? scopeOfEntry(core, scope2, p, e?.mode ?? "100644").cls : "UNMANAGED";
  };
  const unsettled = /* @__PURE__ */ new Set([...tick.excluded.keys(), ...mat.excluded.keys()]);
  const need = /* @__PURE__ */ new Set();
  for (const p of all) {
    const cls = clsOf(p);
    if (cls !== "LIVE" && cls !== "QUARANTINED" && cls !== "SAVE_ONLY") continue;
    if (!stageable(p) || core.snapshot.isCarried(p)) continue;
    if (!strandedOf.has(p) && !unsettled.has(p) && sameEntry2(S.get(p), TIP.get(p))) continue;
    need.add(p);
  }
  const versions = await versionsOf(repo, tip, lb.introducedBy, need, TIP);
  const decision = /* @__PURE__ */ new Map();
  const sEdits = /* @__PURE__ */ new Map();
  const records = [];
  const recordPaths = [];
  const decided = [];
  for (const p of all) {
    const t = TIP.get(p) ?? ABSENT;
    if (!need.has(p)) {
      decision.set(p, t);
      continue;
    }
    decided.push(p);
    const candidates = versions.get(p) ?? [t];
    const s = strandedOf.get(p);
    let match;
    let held;
    if (s === void 0) {
      const mc = await core.diskEq.manyCandidates(p, candidates);
      match = mc.match;
      held = mc.read === "ok" && mc.raw !== null ? mc.raw : mc.read === "missing" ? ABSENT : S.get(p)?.oid ?? ABSENT;
    } else {
      const sc = await strandedCandidates(core, s, candidates);
      match = sc.match ?? (t !== ABSENT && sc.held === t.oid ? t : null);
      held = sc.held;
      sEdits.set(p, match ?? { path: p, mode: blobMode(s.pre ?? (t === ABSENT ? null : t)), oid: held });
    }
    if (match !== null) {
      decision.set(p, match);
      continue;
    }
    decision.set(p, t);
    if (clsOf(p) !== "LIVE") continue;
    records.push(await restartRecord(core, p, TIP.get(p), held, true));
    recordPaths.push(p);
  }
  const toEdit = (e, p) => e === ABSENT ? { path: p, remove: true } : { path: p, mode: e.mode, oid: e.oid };
  const report2 = { mode, records, paths: decided };
  const fs = deps.ports.fs;
  if (perPath) {
    const { aTree } = await currentA(core);
    const newATree2 = await editTreeIndexOnly(repo, fs, aTree, [...decision].map(([p, e]) => toEdit(e, p)), core.scratch("a"));
    await core.commit({ base: newATree2 });
    setCurrentA(core, newATree2, await repo.readTreeMap(newATree2));
    await emitASet(core, all, newATree2, mode === "lost_state" ? "lost_state" : "recover_reanchor");
    return report2;
  }
  const newATree = await editTreeIndexOnly(repo, fs, tipTree, [...decision].filter(([p, e]) => !sameAs(e, TIP.get(p))).map(([p, e]) => toEdit(e, p)), core.scratch("a"));
  const sDisk = await editTreeIndexOnly(repo, fs, mat.sDisk, [...sEdits].map(([p, e]) => toEdit(e, p)), core.scratch("a"));
  const view = core.view;
  const ep = await epochNow(repo);
  const random = deps.ports.random;
  const overrides = metaOverrides ?? {};
  const joinOutbox = new Outbox([{ draft: await joinDraft(core), op: null }]).toJson();
  const keptWrite = view !== null && (view.intent.kind === "apply" || view.intent.kind === "local") ? view.intent : null;
  const keptMark = applyIntentKept(core);
  let next;
  if (mode === "re_anchor" && view !== null && await repo.readRef(core.refs.state) === view.commit) {
    const keptIntent = keptWrite === null ? { kind: "none" } : keptWrite.kind === "apply" ? { ...keptWrite, tip, board: T } : keptWrite;
    const keptT = keptWrite === null ? /* @__PURE__ */ new Map() : keptWrite.kind === "apply" ? new Map([...view.t, ["S", sDisk], ["TIP", newATree]]) : view.t;
    const { A } = await currentA(core);
    const newA = await repo.readTreeMap(newATree);
    const changes = [];
    for (const p of /* @__PURE__ */ new Set([...A.keys(), ...newA.keys()])) {
      if (!sameEntry2(A.get(p), newA.get(p))) changes.push({ path: p, aOld: A.get(p) ?? null, aNew: newA.get(p) ?? null, written: "none", sDiskBefore: null, writtenEntry: null });
    }
    const rebase = await core.cs.rebase(repo, changes, core.scratch("r"));
    const fp = foldPatch(core);
    const from = fp !== null && fp.meta.fold_board !== null ? { board: fp.meta.fold_board, state: fp.fold } : view.fold !== null && view.meta.fold_board !== null ? { board: view.meta.fold_board, state: view.fold } : null;
    const folded = await core.folder.foldTo(T, from, deps.regionSpec);
    const verification = core.folder.verification();
    next = await core.commit({
      laC: tip,
      laB: T,
      base: newATree,
      snap: sDisk,
      ready: rebase.ready,
      intent: keptIntent,
      t: keptT,
      meta: {
        ...view.meta,
        epoch: newEpoch(random),
        seq_next: 1,
        pending: {},
        outbox: joinOutbox,
        fold_board: T,
        fold_verified: verification.verified,
        checkpoint_mismatch: verification.checkpointMismatch,
        ...overrides
      },
      fold: folded.state
    });
  } else {
    const branch = await repo.readRef(core.refs.localBranch);
    const meta = {
      v: 1,
      proto: 1,
      peer_id: core.peerId,
      epoch: newEpoch(random),
      seq_next: 1,
      branch: deps.branch,
      enc: core.refs.e,
      pinned: { url: sanitizeUrl(deps.url), identity: await rootsOf(repo, branch ?? ep.head) },
      H_adopt: ep.head,
      EPOCH_BASE: epochBase,
      expected_epoch: ep,
      freeze_reasons: [],
      config_detail: [],
      incident: null,
      nonretryable: null,
      rejections: null,
      throttle: null,
      pending: {},
      displaced: [],
      fold_board: null,
      fold_verified: null,
      checkpoint_mismatch: false,
      outbox: joinOutbox,
      cs_human_next: await maxOwnCsN(core, tip) + 1,
      incident_next: await maxIncidentN(core) + 1,
      ...overrides
    };
    const init = { laC: tip, laB: T, base: newATree, snap: sDisk, meta };
    next = await writeLostState(core, init);
  }
  attachState(core, next);
  if (next.intent.kind === "apply" && keptWrite?.kind === "apply" && keptMark) markApplyIntentKept(core, true);
  await emitASet(core, all, newATree, mode === "lost_state" ? "lost_state" : "recover_reanchor");
  const ids = boundedList(records);
  const ps = boundedList(recordPaths.map(pathText));
  deps.log.write("warn", "LOST_STATE", {
    mode,
    records: records.length,
    paths: decided.length,
    record_ids: ids.text,
    record_ids_omitted: ids.omitted,
    record_paths: ps.text,
    record_paths_omitted: ps.omitted
  });
  return report2;
}
async function writeLostState(core, init) {
  let unusable = null;
  try {
    if (await core.state.read() !== null) throw new StateCasLostError(`${core.refs.state} holds a usable state again: a second writer`);
  } catch (e) {
    if (!(e instanceof LostStateError)) throw e;
    unusable = e.stateOid;
  }
  if (unusable !== null) return core.state.rebuild(unusable, init);
  if (await stateRefState(core) !== "broken") return core.state.create(init);
  const aside = await moveBrokenStateRef(core);
  try {
    await assertNotBroken(core);
    return await core.state.create(init);
  } catch (e) {
    if (!(e instanceof KilledAt)) await restoreBrokenStateRef(core, aside);
    throw e;
  }
}
async function moveBrokenStateRef(core) {
  const loose = join9(core.deps.paths.gitDir, ...core.refs.state.split("/"));
  const st = await lstatQuiet(core, loose);
  if (st === null || !st.isFile) {
    throw new GitCommandError(["show-ref", "--exists", core.refs.state], 1, Buffer.from("the broken state ref is not a loose ref file", "utf8"));
  }
  const aside = await freeTmpName(core, brokenAsidePrefix(core), "");
  await core.deps.ports.fs.rename(loose, aside);
  try {
    core.deps.log.write("security", "STATE_REF_BROKEN_MOVED", { ref: core.refs.state, file: aside });
  } catch (e) {
    if (!(e instanceof KilledAt)) await restoreBrokenStateRef(core, aside);
    throw e;
  }
  return aside;
}
async function assertNotBroken(core) {
  if (await stateRefState(core) === "broken") {
    throw new GitCommandError(["show-ref", "--exists", core.refs.state], 1, Buffer.from("the state ref is still broken after its loose file was moved aside", "utf8"));
  }
}
async function restoreBrokenStateRef(core, aside) {
  const loose = join9(core.deps.paths.gitDir, ...core.refs.state.split("/"));
  try {
    if (await lstatQuiet(core, loose) !== null || await stateRefState(core) === "present") {
      core.deps.log.write("error", "STATE_REF_BROKEN_KEPT_ASIDE", { ref: core.refs.state, file: aside, code: "state_present" });
      return;
    }
    await core.deps.ports.fs.rename(aside, loose);
    core.deps.log.write("security", "STATE_REF_BROKEN_RESTORED", { ref: core.refs.state, file: aside });
  } catch (e) {
    if (e instanceof KilledAt) throw e;
    core.deps.log.write("error", "STATE_REF_BROKEN_KEPT_ASIDE", { ref: core.refs.state, file: aside, code: codeOf4(e) ?? "unknown" });
  }
}
async function emitASet(core, paths, tree2, cause) {
  const A = await core.repo.readTreeMap(tree2);
  for (const p of paths) core.deps.trace.emit({ kind: "A_set", peer: core.peerId, path: p, blob: A.get(p)?.oid ?? null, cause });
}

// src/engine/epoch.ts
var OPERATION_MARKERS = OP_MARKERS;
var INDEX_LOCK_NOTICE_MS = 3e4;
var INDEX_LOCK = "index.lock";
async function look(fs, p) {
  try {
    const st = await fs.lstat(p);
    return st === null ? { present: false, mtimeNs: null } : { present: true, mtimeNs: st.mtimeNs };
  } catch {
    return { present: true, mtimeNs: null };
  }
}
async function observeEpoch(repo, fs) {
  const gitDir = repo.paths.gitDir;
  const sym = await repo.run(["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] });
  const symref = sym.code === 0 ? sym.stdout.toString("utf8").trim() : null;
  const head = await repo.resolve("HEAD");
  const stash = await repo.readRef("refs/stash");
  const markers = [];
  for (const m of OPERATION_MARKERS) if ((await look(fs, join10(gitDir, m))).present) markers.push(m);
  const indexLock = await look(fs, join10(gitDir, INDEX_LOCK));
  return { symref: symref === "" ? null : symref, head, stash, markers, indexLock };
}
function epochVerdict(o, expected) {
  const symref = o.symref ?? "";
  const ok = symref === expected.symref && o.head === expected.head && o.stash === expected.stash && o.markers.length === 0;
  return ok ? "E1" : "FREEZE";
}

// src/engine/recover.ts
import { createHash as createHash5 } from "node:crypto";
var DISPLACED_CAP2 = 3;
var CAP_WAIT_MS = 1e3;
var CAP_WAIT_MAX = 70;
var FP_WALK_MAX = 1e6;
var DISPLACED_FETCH_MAX = DISPLACED_CAP2 * 4;
var DISPLACED_SKIP_LOG_MAX = 16;
var DETECTION_TAIL = /^[0-9a-f]{12}$/;
var VCOPY_TAIL = /^([0-9a-f]{32})\/v-([1-9][0-9]{0,8})$/;
var memory = /* @__PURE__ */ new WeakMap();
var refuse2 = (code, params = {}) => ({ ok: false, code, params });
var offline = (reason, more = {}) => refuse2("RECOVER_OFFLINE", { reason, ...more });
var isIncident = (m) => m.freeze_reasons.includes("INCIDENT");
function incidentStatus(core) {
  const view = core.view;
  if (view === null || !isIncident(view.meta)) return null;
  const n = view.meta.incident?.n ?? view.meta.incident_next;
  const m = memory.get(core);
  if (m !== void 0 && m.n === n) return { n: m.n, why: m.why, displaced: m.displaced, ref: m.ref };
  return { n, why: null, displaced: view.meta.displaced.includes(oid12(view.laB)) ? "pushed" : "pending", ref: core.refs.displaced(view.laB) };
}
async function commitMeta(core, patch) {
  const view = core.view;
  const fp = foldPatch(core);
  await core.commit({ meta: { ...view.meta, ...fp !== null ? fp.meta : {}, ...patch }, ...fp !== null ? { fold: fp.fold } : {} });
}
async function keepLocalRef(core, ref, to, reason) {
  const repo = core.repo;
  checkRefName("keepLocalRef", ref);
  const exists = await repo.run(["cat-file", "-e", parseOid(to)], { okCodes: [0, 1, 128] });
  if (exists.code !== 0) {
    core.deps.log.write("warn", "INCIDENT_REF_SKIPPED", { ref, oid: to });
    return false;
  }
  const cur = await repo.readRef(ref);
  if (cur === to) return true;
  const args = ["update-ref", "--create-reflog", "-m", reason, ref, to, cur ?? "0".repeat(to.length)];
  const r = await repo.run(args, { class: "refupdate", identity: core.identity(), okCodes: [0, 1, 128] });
  if (r.code === 0) return true;
  if (await repo.readRef(ref) !== cur) throw new StateCasLostError(`${ref} changed under this daemon: a second writer`);
  throw new GitCommandError(args, r.code, r.stderr);
}
var WalkError = class extends Error {
  constructor(what, cause) {
    super(`recover: the first-parent walk ${what} failed`, { cause });
    this.name = "WalkError";
  }
};
async function onChain(core, old, next) {
  try {
    return await fpOk(core.repo, old, next);
  } catch (e) {
    if (e instanceof GitCommandError || e instanceof OidError) throw new WalkError(`${old}..${next}`, e);
    throw e;
  }
}
async function chainOf(core, tip) {
  try {
    return await core.repo.firstParents(tip, null, FP_WALK_MAX);
  } catch (e) {
    if (e instanceof GitCommandError || e instanceof OidError) throw new WalkError(tip, e);
    throw e;
  }
}
function localDisplacedRef(core, tail) {
  return `refs/cowork-remote/${core.refs.e}/displaced/${tail}`;
}
function refNameOk(ref) {
  try {
    checkRefName("displaced", ref);
    return true;
  } catch (e) {
    if (e instanceof Error) return false;
    throw e;
  }
}
function nameProblem(core, ref, tail, accepted) {
  if (!refNameOk(ref) || !refNameOk(localDisplacedRef(core, tail))) return "ref";
  if (!validPathSyntax(tail)) return "path";
  if (!portable(tail, accepted).ok) return "portable";
  if (!DETECTION_TAIL.test(tail) && !VCOPY_TAIL.test(tail)) return "shape";
  return null;
}
async function listDisplaced(core, logSkips) {
  const prefix = core.refs.displacedPrefix;
  const r = await lsRemotePrefix(core.repo, core.deps.url, prefix);
  if (!r.ok) return null;
  const accepted = /* @__PURE__ */ new Map();
  const tails = /* @__PURE__ */ new Set();
  let skipped = 0;
  for (const [ref, oid2] of [...r.values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const tail = ref.slice(prefix.length);
    const problem = nameProblem(core, ref, tail, tails);
    const reason = problem ?? (accepted.size >= DISPLACED_FETCH_MAX ? "cap" : null);
    if (reason !== null) {
      if (logSkips && skipped < DISPLACED_SKIP_LOG_MAX) core.deps.log.write("warn", "DISPLACED_REF_SKIPPED", { reason, ref: problem === "ref" || problem === "path" ? null : ref });
      skipped += 1;
      continue;
    }
    accepted.set(ref, oid2);
    tails.add(tail);
  }
  if (logSkips && skipped > DISPLACED_SKIP_LOG_MAX) {
    core.deps.log.write("warn", "DISPLACED_REF_SKIPPED", { reason: "more", ref: null, omitted: skipped - DISPLACED_SKIP_LOG_MAX });
  }
  return { all: r.values, accepted };
}
async function fetchDisplaced(core, accepted) {
  const out = /* @__PURE__ */ new Map();
  if (accepted.size === 0) return out;
  const prefix = core.refs.displacedPrefix;
  const specs = [...accepted.keys()].map((remote) => ({ remote, local: localDisplacedRef(core, remote.slice(prefix.length)) }));
  const f = await fetchRefs(core.repo, core.deps.url, specs);
  if (!f.ok) return null;
  for (const s of specs) {
    const v = f.values.get(s.remote);
    if (v !== void 0 && v !== ABSENT) out.set(s.remote, v);
  }
  return out;
}
async function dropLocalDisplaced(core) {
  let refs;
  try {
    refs = await core.repo.listRefs(localDisplacedRef(core, ""));
  } catch (e) {
    if (!(e instanceof GitCommandError)) throw e;
    core.deps.log.write("warn", "DISPLACED_LOCAL_DROP_FAILED", { ref: null, rc: e.code });
    return;
  }
  for (const { ref, oid: oid2 } of refs) {
    try {
      await core.repo.deleteLocalRef(ref, oid2);
    } catch (e) {
      if (!(e instanceof GitCommandError)) throw e;
      core.deps.log.write("warn", "DISPLACED_LOCAL_DROP_FAILED", { ref, rc: e.code });
    }
  }
}
async function classifyCopy(core, raw, ref, want) {
  const status = raw.statuses.get(ref) ?? "none";
  if (status === "ok") return { outcome: "landed", transient: false, landed: true };
  const ls = await lsRemote(core.repo, core.deps.url, [ref]);
  if (!ls.ok) return { outcome: "network", transient: false, landed: false };
  const now = ls.values.get(ref);
  if (now === want) return { outcome: "ok", transient: false, landed: true };
  if (now !== void 0) return { outcome: "lease_lost", transient: false, landed: false };
  return status === "rejected" ? { outcome: "transient", transient: true, landed: false } : { outcome: "network", transient: false, landed: false };
}
async function exemptPush(core, purpose, body, classify) {
  for (let i = 0; ; i++) {
    const r = await governedPush(core, purpose, body, true, 1, classify);
    if (r !== "denied") return r;
    if (i >= CAP_WAIT_MAX) return null;
    await core.deps.ports.clock.sleep(CAP_WAIT_MS);
  }
}
function pushFailure(push2, outcome) {
  const reason = outcome === "denied" ? "denied" : outcome === "lease_lost" ? "lease_lost" : outcome === "transient" || outcome === "nonretryable" ? "rejected" : "fetch";
  return offline(reason, { push: push2, outcome });
}
function keptLocal(listing, ref, laB) {
  const existing = listing.all.get(ref);
  return existing === void 0 && listing.all.size >= DISPLACED_CAP2 || existing !== void 0 && existing !== laB;
}
async function enterIncident(core, v, T) {
  const view = core.view;
  if (view === null) throw new Error("enterIncident: no state");
  const laB = view.laB;
  const ref = core.refs.displaced(laB);
  let mem = memory.get(core);
  if (!isIncident(view.meta) || view.meta.incident === null) {
    const n = view.meta.incident_next;
    if (T !== ABSENT) await keepLocalRef(core, core.refs.incident(n), T, "cowork: incident");
    await commitMeta(core, {
      freeze_reasons: [...view.meta.freeze_reasons.filter((r) => r !== "INCIDENT"), "INCIDENT"],
      incident: { n, observed_board: v.observedBoard, observed_code: v.observedCode },
      incident_next: n + 1,
      displaced: []
    });
    const listing = await listDisplaced(core, false);
    mem = { n, why: v.why, displaced: listing !== null && keptLocal(listing, ref, laB) ? "kept_local" : "pending", ref, laB };
    memory.set(core, mem);
    core.deps.trace.emit({ kind: "incident", peer: core.peerId, n, why: v.why, observedBoard: v.observedBoard });
    core.deps.log.write("warn", "INCIDENT", {
      n,
      why: v.why,
      old_board: view.laB,
      old_code: view.laC,
      new_board: v.observedBoard,
      new_code: v.observedCode,
      displaced: mem.displaced === "kept_local" ? "kept_local" : ref
    });
    if (mem.displaced === "kept_local") core.deps.log.write("warn", "INCIDENT_DISPLACED", { n, ref, state: "kept_local", displaced_refs: listing?.all.size ?? null });
  } else if (mem === void 0 || mem.n !== view.meta.incident.n) {
    mem = { n: view.meta.incident.n, why: v.why, displaced: view.meta.displaced.includes(oid12(laB)) ? "pushed" : "pending", ref, laB };
    memory.set(core, mem);
  }
  if (mem.displaced === "pending") await displacedCopy(core, mem);
}
async function displacedCopy(core, mem) {
  const view = core.view;
  const { laB, ref } = mem;
  const fold = foldPatch(core)?.fold ?? view.fold;
  const rank = fold === null ? 1 : governorRank(fold, core.peerId);
  if (!core.governor.mayAttempt(rank, true, true)) return;
  const listing = await listDisplaced(core, false);
  if (listing === null) return;
  if (keptLocal(listing, ref, laB)) {
    mem.displaced = "kept_local";
    core.deps.log.write("warn", "INCIDENT_DISPLACED", { n: mem.n, ref, state: "kept_local", displaced_refs: listing.all.size });
    return;
  }
  const r = await governedPush(core, "displaced", { specs: [pushSpec(laB, ref, ABSENT)] }, false, rank, (raw) => classifyCopy(core, raw, ref, laB));
  if (r === "denied") return;
  if (!r.cls.landed) {
    core.deps.log.write("warn", "INCIDENT_DISPLACED", { n: mem.n, ref, state: "retry", outcome: r.cls.outcome });
    return;
  }
  const key = oid12(laB);
  await commitMeta(core, { displaced: [...core.view.meta.displaced.filter((d) => d !== key), key].slice(-DISPLACED_CAP2) });
  mem.displaced = "pushed";
  core.deps.log.write("info", "INCIDENT_DISPLACED", { n: mem.n, ref, state: "pushed" });
}
async function afterClear(core, n, by) {
  memory.delete(core);
  core.deps.log.write("info", "UNFROZEN", { reason: "INCIDENT", n, by });
  await dropLocalDisplaced(core);
}
function clearedMeta(meta) {
  return { freeze_reasons: meta.freeze_reasons.filter((r) => r !== "INCIDENT"), incident: null, displaced: [] };
}
async function clearIncident(core, by) {
  const meta = core.view.meta;
  await commitMeta(core, clearedMeta(meta));
  await afterClear(core, meta.incident?.n ?? null, by);
}
async function clearIncidentIfHealed(core, it) {
  if (it.fetched === null || !it.fetched.ok || it.fetched.deferred) return false;
  const view = core.view;
  if (view === null || !isIncident(view.meta) && view.meta.incident === null) return false;
  await clearIncident(core, "healed");
  it.freeze = [...core.view.meta.freeze_reasons];
  it.pushStates = pushStatesOf(core, it.version);
  return true;
}
function previewOf(mode, laB, V, X, aTree, candidates, restartPaths, intent) {
  const shown = JSON.stringify({ mode, laB, V, X, A: aTree, candidates, restartPaths });
  const id = createHash5("sha256").update(shown, "utf8").digest("hex").slice(0, 6);
  return { mode, V, X, candidates, restartPaths, id, pushIntent: intent === null ? null : { bnew: intent.bnew, lease_board: intent.lease_board } };
}
function previewJson(p) {
  return {
    mode: p.mode,
    V: p.V,
    X: p.X,
    candidates: [...p.candidates],
    restartPaths: [...p.restartPaths],
    id: p.id,
    pushIntent: p.pushIntent === null ? null : { bnew: p.pushIntent.bnew, lease_board: p.pushIntent.lease_board }
  };
}
async function teamRecoveredAt(core, V, vCommit, laB, candidates, displaced) {
  if (V === ABSENT || !vCommit) return null;
  for (const c of candidates) if (c !== V && await onChain(core, V, c)) return null;
  const onV = new Set(await chainOf(core, V));
  const D = (await chainOf(core, laB)).find((o) => onV.has(o));
  if (D === void 0 || D === V || !displaced.has(D)) return null;
  let verdict;
  try {
    verdict = await incidentCheck(core.repo, D, (await liveCodeOf(core, D)).tip, V, core.deps.testMutants);
  } catch (e) {
    if (isRemoteContentError(e)) return null;
    if (e instanceof GitCommandError || e instanceof OidError) throw new WalkError(`${D}..${V}`, e);
    throw e;
  }
  return verdict.ok ? D : null;
}
async function xCheckFails(core, X) {
  const view = core.view;
  try {
    const verdict = await incidentCheck(core.repo, view.laB, view.laC, X, core.deps.testMutants);
    return verdict.ok ? null : verdict.why;
  } catch (e) {
    if (isRemoteContentError(e)) return "board_shape";
    if (e instanceof GitCommandError || e instanceof OidError) throw new WalkError(`${view.laB}..${X}`, e);
    throw e;
  }
}
async function containingAll(core, candidates) {
  for (const c of candidates) {
    let all = true;
    for (const o of candidates) {
      if (o !== c && !await onChain(core, o, c)) {
        all = false;
        break;
      }
    }
    if (all) return c;
  }
  return null;
}
async function reanchorPaths(core, V, D) {
  const repo = core.repo;
  const view = core.view;
  const [v, d, b] = [await liveCodeOf(core, V), await liveCodeOf(core, D), await liveCodeOf(core, view.laB)];
  const VT = await repo.readTreeMap(v.tree);
  const DT = await repo.readTreeMap(d.tree);
  const BT = await repo.readTreeMap(b.tree);
  const out = /* @__PURE__ */ new Set();
  for (const p of diffPaths(DT, BT)) if (!sameTreeEntry(BT.get(p), VT.get(p))) out.add(p);
  const { aTree, A } = await currentA(core);
  const { tick } = await tickOutside(core, A, aTree, view.meta.EPOCH_BASE);
  if (!tick.failed) {
    for (const [p, e] of tick.dirty) {
      const t = VT.get(p);
      if (e.kind === "remove" ? t !== void 0 : t?.oid !== e.id) out.add(p);
    }
  }
  const paths = [...out].filter((p) => validPathSyntax(p)).sort();
  if (paths.length === 0) return paths;
  const inp = await scopeInputsFor(core, (await liveBase(repo, v.tip)).base, paths);
  return paths.filter((p) => scopeOfEntry(core, inp, p, (BT.get(p) ?? VT.get(p) ?? A.get(p))?.mode ?? "100644").cls === "LIVE");
}
function nextVCopy(core, all) {
  const own = `${core.refs.displacedPrefix}${core.peerId}/v-`;
  let k = 0;
  for (const ref of all.keys()) {
    const m = ref.startsWith(own) ? VCOPY_TAIL.exec(ref.slice(core.refs.displacedPrefix.length)) : null;
    if (m !== null) k = Math.max(k, Number(m[2]));
  }
  return `${own}${k + 1}`;
}
async function planRecover(core, fetched, intent) {
  const repo = core.repo;
  const V = fetched.board;
  const listing = await listDisplaced(core, true);
  if (listing === null) return offline("fetch");
  const values = await fetchDisplaced(core, listing.accepted);
  if (values === null) return offline("fetch");
  const prefix = core.refs.displacedPrefix;
  const view = core.view;
  const displacedRefs = /* @__PURE__ */ new Map();
  for (const [ref, v] of values) {
    if (VCOPY_TAIL.test(ref.slice(prefix.length))) continue;
    if (!await repo.hasObject(v, "commit")) {
      core.deps.log.write("warn", "DISPLACED_REF_SKIPPED", { reason: "not_commit", ref });
      continue;
    }
    displacedRefs.set(ref, v);
  }
  const displaced = new Set(displacedRefs.values());
  const candidates = [.../* @__PURE__ */ new Set([view.laB, ...displaced])].sort();
  const vCommit = V !== ABSENT && await repo.hasObject(V, "commit");
  const { aTree } = await currentA(core);
  const D = await teamRecoveredAt(core, V, vCommit, view.laB, candidates, displaced);
  if (D !== null) {
    const h = await headCheck(core);
    if (!h.ok) return refuse2("RECOVER_HEAD_STATE", { op: h.op });
    return { preview: previewOf("reanchor", view.laB, V, null, aTree, candidates, await reanchorPaths(core, V, D), intent), mirror: fetched.code, vCopy: null };
  }
  const X = await containingAll(core, candidates);
  const displacedNames = [...displacedRefs.keys()].sort();
  if (X === null) return refuse2("RECOVER_AMBIGUOUS", { candidates, displaced: displacedNames });
  const why = await xCheckFails(core, X);
  if (why !== null) {
    const ref = displacedNames.find((r) => displacedRefs.get(r) === X) ?? null;
    return refuse2("RECOVER_AMBIGUOUS", { reason: "x_check", ref, why, X, candidates, displaced: displacedNames });
  }
  let vCopy = null;
  if (V !== ABSENT && !(vCommit && await onChain(core, V, X))) {
    if (![...listing.all.values()].includes(V)) {
      if (listing.all.size >= DISPLACED_CAP2) return refuse2("RECOVER_DISPLACED_FULL", { displaced: [...listing.accepted.keys()], count: listing.all.size, cap: DISPLACED_CAP2 });
      vCopy = nextVCopy(core, listing.all);
    }
  }
  return { preview: previewOf("restore", view.laB, V, X, aTree, candidates, [], intent), mirror: fetched.code, vCopy };
}
async function restore(core, p) {
  const { preview, mirror, vCopy } = p;
  const V = preview.V;
  const X = preview.X;
  if (vCopy !== null && V !== ABSENT) {
    const r2 = await exemptPush(core, "displaced", { specs: [pushSpec(V, vCopy, ABSENT)] }, (raw) => classifyCopy(core, raw, vCopy, V));
    if (r2 === null || !r2.cls.landed) return pushFailure("displaced", r2?.cls.outcome ?? "denied");
  }
  crashpoint("recover.displaced");
  const board = core.refs.remoteBoard;
  const live = (await liveCodeOf(core, X)).tip;
  const specs = [pushSpec(X, board, V), pushSpec(live, core.refs.remoteCode, mirror)];
  const r = await exemptPush(core, "recover", { specs }, async (raw) => {
    const status = raw.statuses.get(board) ?? "none";
    if (status === "ok") return { outcome: "landed", transient: false, landed: true };
    const view = await core.fetcher.fetchNow();
    await observeFetch(core, view, false);
    if (!view.ok) return { outcome: "network", transient: false, landed: false };
    if (view.board === X) return { outcome: "landed", transient: false, landed: true };
    if (view.board !== V) return { outcome: "lease_lost", transient: false, landed: false };
    return status === "rejected" ? { outcome: "transient", transient: true, landed: false } : { outcome: "network", transient: false, landed: false };
  });
  if (r === null || !r.cls.landed) return pushFailure("recover", r?.cls.outcome ?? "denied");
  observeOwnLanding(core, X, V);
  await clearIncident(core, "recover");
  return { ok: true, preview, done: true };
}
async function reanchor(core, p) {
  const view = core.view;
  const n = view.meta.incident?.n ?? view.meta.incident_next;
  await keepLocalRef(core, core.refs.incidentOwn(n), view.laB, "cowork: incident own");
  crashpoint("recover.reanchor");
  const outbox = new Outbox([
    { draft: await joinDraft(core), op: null },
    ...core.outbox.drafts().filter((d) => d.type !== "join").map((draft) => ({ draft, op: null }))
  ]);
  const report2 = await lostStateRebuild(core, p.preview.V, "re_anchor", void 0, { ...clearedMeta(view.meta), outbox: outbox.toJson() });
  await afterClear(core, n, "reanchor");
  core.deps.log.write("warn", "RECOVER_REANCHOR", { n, own: view.laB, board: p.preview.V, records: report2.records.length });
  return { ok: true, preview: p.preview, done: true };
}
async function incidentIteration(core, fetched) {
  const view = core.view;
  const fp = foldPatch(core);
  const from = fp !== null && fp.meta.fold_board !== null ? { board: fp.meta.fold_board, state: fp.fold } : view.fold !== null && view.meta.fold_board !== null ? { board: view.meta.fold_board, state: view.fold } : null;
  const folded = await core.folder.foldTo(view.laB, from, core.deps.regionSpec);
  const { tip, tree: tree2 } = await liveCodeOf(core, view.laB);
  const tipMap = await core.repo.readTreeMap(tree2);
  const { A } = await currentA(core);
  const epochBase = view.meta.EPOCH_BASE;
  const scopeInputs = await scopeInputsFor(core, epochBase, [...A.keys(), ...tipMap.keys()]);
  return {
    n: 0,
    start: anchorNow(core.deps.ports.clock),
    fetched,
    T: fetched.board,
    tip,
    tipMap,
    A,
    fold: folded.state,
    version: folded.version,
    epochBase,
    scopeInputs,
    scope: (path) => scopeOfEntry(core, scopeInputs, path, (A.get(path) ?? tipMap.get(path))?.mode ?? "100644"),
    tick: null,
    mat: null,
    freeze: [...view.meta.freeze_reasons],
    pushStates: pushStatesOf(core, folded.version),
    leaseIdleMs: core.deps.lease.idleMs()
  };
}
async function recover(core, confirm) {
  const view0 = core.view;
  if (view0 === null || !isIncident(view0.meta)) return refuse2("RECOVER_NOT_IN_INCIDENT");
  const fetched = await core.fetcher.fetchNow();
  await observeFetch(core, fetched, false);
  if (!fetched.ok) return offline("fetch");
  try {
    let intent = view0.intent.kind === "push" ? view0.intent : null;
    if (confirm !== null && intent !== null) {
      await resolvePushIntent(core, await incidentIteration(core, fetched));
      if (core.view.intent.kind === "push") return offline("push_intent_unresolved");
      intent = null;
    }
    const p = await planRecover(core, fetched, intent);
    if (!("vCopy" in p)) return p;
    if (confirm === null) return { ok: true, preview: p.preview, done: false };
    if (confirm !== p.preview.id) return refuse2("RECOVER_PREVIEW_STALE", { preview: previewJson(p.preview) });
    return await (p.preview.mode === "reanchor" ? reanchor(core, p) : restore(core, p));
  } catch (e) {
    if (e instanceof WalkError) return offline("walk");
    if (isRemoteContentError(e)) return refuse2("RECOVER_AMBIGUOUS", { reason: "remote_content", error: e.name });
    throw e;
  }
}

// src/engine/start.ts
import { join as joinPath } from "node:path";

// src/ports/trace.ts
var noTrace = { emit: () => {
} };

// src/engine/start.ts
var PROBE_SUBJECT = "[skip ci] ***NO_CI*** cowork probe";
var PROBE_TRIES = 3;
var PROBE_PUSH_OPTIONS = Object.freeze(["ci.skip"]);
var CAP_WAIT_MS2 = 1e3;
var CAP_WAIT_MAX2 = 70;
var RENAME_PROBE = "rename-probe";
var RENAME_PROBE_RE = /^~cowork-rename-probe(-[0-9]+)?\.tmp$/;
var RENAME_RETRIES = 3;
var RENAME_BACKOFF_MS = 100;
var ProbeUnreachable = class extends Error {
  constructor() {
    super("the probe ref could not be re-fetched");
    this.name = "ProbeUnreachable";
  }
};
var refuse3 = (code, params = {}) => ({ ok: false, code, params });
var short = (o) => o.slice(0, 8);
function codeOf5(e) {
  const c = typeof e === "object" && e !== null ? e.code : void 0;
  return typeof c === "string" ? c : void 0;
}
async function tmpOnWorkTreeVolume(core) {
  const { fs, clock } = core.deps.ports;
  const root = core.deps.paths.workTree;
  for (const name of await fs.readdir(root)) {
    if (RENAME_PROBE_RE.test(name)) await fs.unlink(joinPath(root, name)).catch(() => void 0);
  }
  let b = null;
  for (let k = 0; b === null; k++) {
    const n = joinPath(root, k === 0 ? `~cowork-${RENAME_PROBE}.tmp` : `~cowork-${RENAME_PROBE}-${k}.tmp`);
    if (await fs.lstat(n) === null) b = n;
  }
  const a = core.path(`tmp/${RENAME_PROBE}.a`);
  await fs.writeFile(a, Buffer.from("cowork rename probe\n", "utf8"));
  for (let i = 0; ; i++) {
    try {
      await fs.rename(a, b);
      break;
    } catch (e) {
      const c = codeOf5(e);
      if ((c === "EPERM" || c === "EBUSY") && i < RENAME_RETRIES) {
        await clock.sleep(RENAME_BACKOFF_MS);
        continue;
      }
      await fs.unlink(a).catch(() => void 0);
      if (c === "EXDEV") return false;
      throw e;
    }
  }
  await fs.unlink(b).catch(() => core.deps.log.write("warn", "START_PROBE_FILE_KEPT", { file: b }));
  return true;
}
async function remoteName(core) {
  for (const { key, value } of await core.repo.configGetRegexp("^remote\\..+\\.url$")) {
    if (value === core.deps.url) return key.slice("remote.".length, key.length - ".url".length);
  }
  return null;
}
function decodeEnc(e) {
  const bytes = [];
  for (let i = 0; i < e.length; i++) {
    const hex2 = e[i] === "%" ? e.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex2)) {
      bytes.push(parseInt(hex2, 16));
      i += 2;
    } else {
      bytes.push(e.charCodeAt(i) & 255);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
async function caseFoldClash(core) {
  const own = core.refs.e;
  const folded = own.toLowerCase();
  for (const ns of ["refs/cowork-local/", "refs/cowork-remote/"]) {
    for (const { ref } of await core.repo.listRefs(ns)) {
      const e = ref.slice(ns.length).split("/")[0] ?? "";
      if (e !== own && e.toLowerCase() === folded) return decodeEnc(e);
    }
  }
  return null;
}
async function startDispatch(core, opts) {
  const { deps } = core;
  if (!await tmpOnWorkTreeVolume(core)) return refuse3("START_REPO_SHAPE", { reason: "tmp_volume" });
  const clash = await caseFoldClash(core);
  if (clash !== null) return refuse3("START_BRANCH_NAME", { reason: "case_fold", other: clash });
  await removeOwnLocks(core);
  let present = false;
  let pinned = null;
  try {
    const v = await core.state.read();
    if (v !== null) {
      if (v.meta.branch !== deps.branch) return refuse3("START_BRANCH_NAME", { reason: "case_fold", other: v.meta.branch });
      present = true;
      pinned = v.meta.pinned.identity;
    }
  } catch (e) {
    if (e instanceof MetaTooNewError) return refuse3("START_STATE_NEWER", { meta_v: e.metaV, own_v: META_V });
    if (!(e instanceof LostStateError)) throw e;
    present = true;
  }
  if (!present && (core.view !== null || await stateRefState(core) === "broken" || (await brokenStateLeftovers(core)).length > 0)) present = true;
  const fetched = async () => {
    const f2 = await fetchRefs(core.repo, deps.url, core.refs.fetchSpecs);
    const at = (ref) => f2.values.get(ref) ?? ABSENT;
    return { ok: f2.ok, answered: f2.remoteAnswered, board: at(core.refs.remoteBoard), mirror: at(core.refs.remoteCode), branch: at(core.refs.remoteBranch) };
  };
  if (present) {
    if (pinned !== null) {
      const f2 = await fetched();
      if (f2.ok && f2.branch !== ABSENT) {
        const roots = await rootsOf(core.repo, f2.branch);
        const want = [...pinned].sort();
        if (roots.length !== want.length || roots.some((r, i) => r !== want[i])) return refuse3("START_REPO_IDENTITY");
      }
    }
    try {
      return { ok: true, mode: "restart", restart: await restart(core) };
    } catch (e) {
      if (e instanceof StartRefused) return refuse3(e.code, e.params);
      if (isRemoteContentError(e)) return refuse3("START_REMOTE", { reason: "board_malformed" });
      throw e;
    }
  }
  const f = await fetched();
  if (!f.ok) return refuse3("START_REMOTE", { reason: f.answered ? "local_ref_update" : "unreachable" });
  if (f.board === ABSENT) {
    if (f.mirror !== ABSENT) return refuse3("GENESIS_BOARD_MISSING", { branch: deps.branch });
    if (f.branch === ABSENT) return refuse3("START_BRANCH_NOT_ON_REMOTE", { remote: await remoteName(core), branch: deps.branch });
  }
  try {
    return f.board === ABSENT ? await genesis(core, f.branch, opts) : await join11(core, f.board, f.branch, opts);
  } catch (e) {
    if (!isRemoteContentError(e)) throw e;
    const mode = committed.get(core);
    if (mode !== void 0 && core.view !== null) {
      deps.log.write("warn", "START_REMOTE_AFTER_STATE", { mode, error: e.name });
      return { ok: true, mode, restart: null };
    }
    return refuse3("START_REMOTE", { reason: "board_malformed" });
  }
}
var committed = /* @__PURE__ */ new WeakMap();
async function headState(core) {
  const h = await headCheck(core);
  return h.ok ? h.head : refuse3("START_HEAD_STATE", { op: h.op });
}
function incoming(A, tipMap) {
  let n = 0;
  for (const [p, e] of tipMap) if (!sameEntry2(A.get(p), e)) n++;
  for (const p of A.keys()) if (!tipMap.has(p)) n++;
  return n;
}
function classifyLocal(core, A, scope2, changed, excluded, notAdmitted) {
  const live = (p) => {
    const e = A.get(p);
    if (e === void 0) return true;
    try {
      return scopeOfEntry(core, scope2, p, e.mode).cls === "LIVE";
    } catch {
      return false;
    }
  };
  const unsettled = /* @__PURE__ */ new Map();
  for (const [p, why] of excluded) if (!changed.has(p)) unsettled.set(p, why === "deletion_pending" ? "absent" : "unread");
  const M = [.../* @__PURE__ */ new Set([...changed, ...unsettled.keys()])].filter((p) => live(p)).sort();
  const unshared = notAdmitted + [...changed].filter((p) => !live(p)).length;
  return { M, unsettled: new Map([...unsettled].filter(([p]) => M.includes(p))), unshared };
}
async function previewOrRefuse(core, aTree, epochBase, tipMap) {
  try {
    return await previewLocalWork(core, aTree, epochBase, tipMap);
  } catch (e) {
    if (e instanceof IndexRefusedPathError) return refuse3("START_REPO_SHAPE", { reason: "path_not_indexable" });
    throw e;
  }
}
async function previewLocalWork(core, aTree, epochBase, tipMap) {
  const { repo, deps } = core;
  const fs = deps.ports.fs;
  const dir = core.path("tmp/preview");
  await fs.rmrf(dir);
  await fs.mkdirp(joinPath(dir, "stage"), 448);
  try {
    const stage = new StageDir(fs, joinPath(dir, "stage"));
    const snap = new Snapshotter({
      repo,
      fs,
      clock: deps.ports.clock,
      trace: noTrace,
      peer: core.peerId,
      privateIndex: joinPath(dir, "p.index"),
      scratch: { detect: joinPath(dir, "detect.index"), canon: joinPath(dir, "canon.index") },
      stage,
      statCache: new StatCache(),
      attribution: deps.attribution,
      filters: core.filters,
      platform: deps.platform
    });
    await snap.reseed(aTree);
    const A = await repo.readTreeMap(aTree);
    const scope2 = await scopeInputsFor(core, epochBase, [...A.keys(), ...tipMap.keys()]);
    const tick = await snap.tick({ A, aTree, epochBase, scope: scope2, skip: tickSkip(core) });
    if (tick.failed) throw new Error("start: the snapshot of the work tree failed (a refresh or diff-files error)");
    const changed = /* @__PURE__ */ new Set();
    const compare = [];
    for (const [p, de] of tick.dirty) {
      const a = A.get(p);
      if (de.kind !== "modify" || a === void 0) {
        changed.add(p);
        continue;
      }
      if (de.id === a.oid && de.mode === a.mode) continue;
      if (de.mode !== a.mode || !isRegularEntry(a) || pathIsFiltered(core, p) || !pathIsText(core, p)) {
        changed.add(p);
        continue;
      }
      compare.push({ path: p, ref: a });
    }
    if (compare.length > 0) {
      const refs = await repo.smudgeBlobs(compare.map(({ path, ref }) => ({ oid: ref.oid, path })));
      for (const [i, { path }] of compare.entries()) {
        let disk = null;
        try {
          disk = await fs.readFile(stage.abs(path));
        } catch {
          disk = null;
        }
        const ref = refs[i];
        const res = disk === null ? null : canon(disk, ref, false);
        if (res === null || !res.ok || !res.out.equals(ref)) changed.add(path);
      }
    }
    const c = classifyLocal(core, A, scope2, changed, tick.excluded, tick.notAdmitted.size);
    return { M: c.M, nIn: incoming(A, tipMap), unshared: c.unshared };
  } finally {
    try {
      await fs.rmrf(dir);
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      deps.log.write("warn", "PREVIEW_CLEANUP_FAILED", { dir, code: codeOf5(e) ?? "unknown" });
    }
  }
}
async function localWork(core, aTree, epochBase, tipMap) {
  const repo = core.repo;
  const A = await repo.readTreeMap(aTree);
  await core.snapshot.reseed(aTree);
  const { inp, tick } = await tickOutside(core, A, aTree, epochBase, tipMap.keys());
  if (tick.failed) throw new Error("start: the snapshot of the work tree failed (a refresh or diff-files error)");
  const mat = tick.dirty.size > 0 ? await core.snapshot.materialize(inp) : null;
  const S = mat?.sDiskMap ?? A;
  const changed = /* @__PURE__ */ new Set();
  for (const [p, e] of S) if (!sameEntry2(A.get(p), e)) changed.add(p);
  for (const p of A.keys()) if (!S.has(p)) changed.add(p);
  const excluded = new Map([...tick.excluded, ...mat?.excluded ?? /* @__PURE__ */ new Map()]);
  const c = classifyLocal(core, A, inp.scope, changed, excluded, tick.notAdmitted.size);
  return { M: c.M, nIn: incoming(A, tipMap), unshared: c.unshared, A, aTree, mat, unsettled: c.unsettled };
}
async function pinLocalWork(core, w) {
  const S = w.mat?.sDiskMap ?? w.A;
  const h0 = Object.fromEntries(w.M.map((p) => [p, w.A.get(p)?.oid ?? ABSENT]));
  const h1 = Object.fromEntries(w.M.map((p) => {
    const u = w.unsettled.get(p);
    return [p, u === "absent" ? ABSENT : S.get(p)?.oid ?? (u === "unread" ? w.A.get(p)?.oid ?? ABSENT : ABSENT)];
  }));
  return core.holds.hold({
    kind: "PIN",
    residence: "ON_DISK",
    state: "ACTIVE",
    paths: w.M,
    blobs: { h0, h1 },
    guard: "join",
    origin: "human",
    cs_ids: [],
    displaced_by: null,
    local_only: false
  });
}
var startCaptures = /* @__PURE__ */ new WeakSet();
function takeStartCapture(core) {
  return startCaptures.delete(core);
}
function captureLocalWork(core, M) {
  core.cs.observe(M);
  core.cs.done();
  startCaptures.add(core);
}
function previewRefusal(w) {
  return refuse3("START_PREVIEW", { n_in: w.nIn, m_out: w.M.length, unshared: w.unshared });
}
function emitStartASet(core, A, cause) {
  for (const [p, e] of [...A].sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0)) core.deps.trace.emit({ kind: "A_set", peer: core.peerId, path: p, blob: e.oid, cause });
}
async function governedExempt(core, purpose, body, classify, pushOptions) {
  for (let i = 0; ; i++) {
    const r = await governedPush(core, purpose, body, true, 1, classify, pushOptions !== void 0 ? { pushOptions } : void 0);
    if (r !== "denied") return r;
    if (i >= CAP_WAIT_MAX2) throw new Error(`start: the ${purpose} push stayed denied by the push cap`);
    await core.deps.ports.clock.sleep(CAP_WAIT_MS2);
  }
}
async function runProbe(core, hr) {
  const { repo, deps } = core;
  const q = core.refs.probe(core.peerId);
  const empty = await repo.mktree([]);
  const commit = (parents) => repo.commitTree({ tree: empty, parents, subject: PROBE_SUBJECT, trailers: [{ key: "skip-checks", value: "true" }] });
  const refetch = async () => {
    const r = await lsRemote(repo, deps.url, [q]);
    if (!r.ok) throw new ProbeUnreachable();
    return r.values.get(q) ?? ABSENT;
  };
  const attempt = async (body, goal, pushOptions) => {
    let seen = ABSENT;
    const r = await governedExempt(core, "probe", body, async () => {
      seen = await refetch();
      const landed = seen === goal;
      return { outcome: landed ? "landed" : "ok", transient: false, landed };
    }, pushOptions);
    return { status: r.raw.statuses.get(q) ?? "none", q: seen };
  };
  const caps = { custom_refs: false, lease: false, delete: false, push_options: false, two_parent_ok: false };
  let cur = await refetch();
  for (let i = 0; i < PROBE_TRIES && cur !== ABSENT; i++) {
    cur = (await attempt({ deleteProbe: { ref: q, lease: cur } }, ABSENT)).q;
  }
  const q1 = await commit([hr]);
  for (let i = 0; i < PROBE_TRIES && !caps.custom_refs; i++) {
    cur = (await attempt({ specs: [pushSpec(q1, q, ABSENT)] }, q1)).q;
    caps.custom_refs = cur === q1;
  }
  if (!caps.custom_refs) return caps;
  const q2 = await commit([q1, hr]);
  for (let i = 0; i < PROBE_TRIES; i++) {
    cur = (await attempt({ specs: [pushSpec(q2, q, q1)] }, q2)).q;
    if (cur !== q1) break;
  }
  caps.two_parent_ok = cur === q2;
  const before = cur;
  const x = caps.two_parent_ok ? q1 : hr;
  const q3 = await commit([q1]);
  const s3 = await attempt({ specs: [pushSpec(q3, q, x)] }, q3);
  cur = s3.q;
  caps.lease = s3.status !== "ok" && cur === before;
  if (cur !== ABSENT) {
    const q4 = await commit([cur]);
    cur = (await attempt({ specs: [pushSpec(q4, q, cur)] }, q4, PROBE_PUSH_OPTIONS)).q;
    caps.push_options = cur === q4;
  }
  for (let i = 0; i < PROBE_TRIES && !caps.delete; i++) {
    if (cur === ABSENT) {
      caps.delete = true;
      break;
    }
    cur = (await attempt({ deleteProbe: { ref: q, lease: cur } }, ABSENT)).q;
    caps.delete = cur === ABSENT;
  }
  deps.log.write("info", "HOST_PROBE", { custom_refs: caps.custom_refs, lease: caps.lease, delete: caps.delete, push_options: caps.push_options, two_parent_ok: caps.two_parent_ok });
  return caps;
}
async function genesis(core, hr, opts) {
  const { repo, deps } = core;
  const head = await headState(core);
  if (typeof head !== "string") return head;
  if (head !== hr) {
    return await repo.isAncestor(head, hr) ? refuse3("START_HEAD_BEHIND", { head8: short(head), base8: short(hr) }) : refuse3("START_HEAD_AHEAD", { c8: short(head) });
  }
  const hrTree = (await repo.readCommit(hr)).tree;
  const hrMap = await repo.readTreeMap(hrTree);
  const preview = await previewOrRefuse(core, hrTree, hr, hrMap);
  if ("ok" in preview) return preview;
  if (preview.M.length > 0 && opts.publishLocal === null) return previewRefusal(preview);
  const protocol = genesisProtocol(genesisBudget((await readTeamConfig(repo, hr)).config), deps.regionSpec);
  core.governor.setParams(protocol);
  let caps;
  try {
    caps = await runProbe(core, hr);
  } catch (e) {
    if (e instanceof ProbeUnreachable) return refuse3("START_REMOTE", { reason: "unreachable" });
    throw e;
  }
  if (!caps.custom_refs) return refuse3("START_REFUSED_CUSTOM_REFS");
  if (!caps.lease) return refuse3("START_REFUSED_NO_LEASE", { namespace: deps.namespace.remotePrefix });
  const work = await localWork(core, hrTree, hr, hrMap);
  if (work.M.length > 0 && opts.publishLocal === null) return previewRefusal(work);
  core.caps = caps;
  const epoch = newEpoch(deps.ports.random);
  const writer = { peer: core.peerId, epoch, seq: 3 };
  const L0 = await repo.commitTree({ tree: hrTree, parents: [], subject: CODE_SUBJECT, trailers: liveCommitTrailers(writer, [], [], /* @__PURE__ */ new Map(), hr) });
  const joinOp = { id: `${core.peerId}/${epoch}/1`, ...await joinDraft(core) };
  const capsOp = { id: `${core.peerId}/${epoch}/2`, type: "caps", ...caps };
  const ops = [joinOp, capsOp];
  const draft = {
    liveCode: L0,
    writer,
    cs: [],
    protocol,
    checkpoint: null,
    heldIds: [],
    opsLines: serializeOps(ops).toString("utf8").split("\n").filter((l) => l.length > 0)
  };
  const s0 = foldCommit(initialFoldState(protocol), draft, core.peerId).state;
  const B0 = await buildBoardCommit(repo, { prevBoard: null, liveCode: L0, writer, ops, cs: [], csPaths: /* @__PURE__ */ new Map(), protocol, checkpoint: serializeFold(s0) });
  await deps.ports.scheduler.yieldPoint("start.beforeGenesisPush");
  let observed = false;
  let observedBoard = ABSENT;
  let observedMirror = ABSENT;
  const specs = [pushSpec(B0, core.refs.remoteBoard, ABSENT), pushSpec(L0, core.refs.remoteCode, ABSENT)];
  await governedExempt(core, "genesis", { specs }, async (raw) => {
    if (raw.statuses.get(core.refs.remoteBoard) === "ok" && raw.statuses.get(core.refs.remoteCode) === "ok") {
      observed = true;
      observedBoard = B0;
      observedMirror = L0;
      return { outcome: "landed", transient: false, landed: true };
    }
    const f = await fetchRefs(repo, deps.url, core.refs.fetchSpecs);
    if (!f.ok) return { outcome: "network", transient: false, landed: false };
    observed = true;
    observedBoard = f.values.get(core.refs.remoteBoard) ?? ABSENT;
    observedMirror = f.values.get(core.refs.remoteCode) ?? ABSENT;
    const landed = observedBoard === B0 && observedMirror === L0;
    return { outcome: landed ? "landed" : "lease_lost", transient: false, landed };
  });
  if (!observed) {
    deps.log.write("warn", "GENESIS_PUSH_UNOBSERVED", {});
    return refuse3("START_REMOTE", { reason: "unreachable" });
  }
  if (observedBoard !== B0 || observedMirror !== L0) {
    if (observedBoard !== ABSENT && observedBoard !== B0) {
      deps.log.write("info", "GENESIS_LOST_RACE", { board: observedBoard });
      return join11(core, observedBoard, hr, opts);
    }
    deps.log.write("error", "GENESIS_PUSH_PARTIAL", { board: observedBoard === B0, mirror: observedMirror === L0 });
    return refuse3("START_REMOTE", { reason: "genesis_push_failed" });
  }
  observeOwnLanding(core, B0, ABSENT);
  if (work.M.length > 0 && opts.publishLocal === "none") await pinLocalWork(core, work);
  const ep = await epochNow(repo);
  const meta = {
    v: 1,
    proto: 1,
    peer_id: core.peerId,
    epoch,
    seq_next: writer.seq + 1,
    branch: deps.branch,
    enc: core.refs.e,
    pinned: { url: sanitizeUrl(deps.url), identity: await rootsOf(repo, hr) },
    H_adopt: ep.head,
    EPOCH_BASE: hr,
    expected_epoch: ep,
    freeze_reasons: [],
    config_detail: [],
    incident: null,
    nonretryable: null,
    rejections: null,
    throttle: core.governor.toMeta(),
    pending: {},
    displaced: [],
    fold_board: B0,
    fold_verified: null,
    checkpoint_mismatch: false,
    outbox: new Outbox().toJson(),
    cs_human_next: 1,
    incident_next: 1
  };
  const view = await core.state.create({ laC: L0, laB: B0, base: hrTree, snap: work.mat?.sDisk ?? hrTree, meta, fold: s0 });
  attachState(core, view);
  committed.set(core, "genesis");
  emitStartASet(core, hrMap, "genesis");
  if (work.M.length > 0 && opts.publishLocal === "all") captureLocalWork(core, work.M);
  return { ok: true, mode: "genesis", restart: null };
}
async function join11(core, T, hr, opts) {
  const { repo, deps } = core;
  if (hr === ABSENT) return refuse3("START_BRANCH_NOT_ON_REMOTE", { remote: await remoteName(core), branch: deps.branch });
  let folded;
  let tip;
  let tipTree;
  let tipMap;
  let lb;
  try {
    const board = await readBoardCommit(repo, T);
    if (board.protocol.proto !== PROTO) return refuse3("START_VERSION", { board_proto: board.protocol.proto, own_proto: PROTO });
    folded = await core.folder.foldTo(T, null, deps.regionSpec);
    ({ tip, tree: tipTree } = await liveCodeOf(core, T, board.liveCode));
    tipMap = await repo.readTreeMap(tipTree);
    lb = await liveBase(repo, tip);
  } catch (e) {
    if (isRemoteContentError(e)) return refuse3("START_REMOTE", { reason: "board_malformed" });
    throw e;
  }
  const head = await headState(core);
  if (typeof head !== "string") return head;
  if (head !== lb.base) {
    if (await repo.isAncestor(head, lb.base)) return refuse3("START_HEAD_BEHIND", { head8: short(head), base8: short(lb.base) });
    if (head === hr) return refuse3("START_HEAD_AHEAD", { c8: short(head), base_move: "unsupported" });
    return refuse3("START_HEAD_AHEAD", { c8: short(head) });
  }
  const headTree = (await repo.readCommit(head)).tree;
  const aTree = deps.testMutants.has("M05") ? tipTree : headTree;
  const preview = await previewOrRefuse(core, aTree, lb.base, tipMap);
  if ("ok" in preview) return preview;
  if (preview.M.length > 0 && opts.publishLocal === null) return previewRefusal(preview);
  const work = await localWork(core, aTree, lb.base, tipMap);
  if (work.M.length > 0 && opts.publishLocal === null) return previewRefusal(work);
  if (work.M.length > 0 && opts.publishLocal === "none") await pinLocalWork(core, work);
  const ep = await epochNow(repo);
  const outbox = new Outbox();
  outbox.add(await joinDraft(core));
  const v = core.folder.verification();
  const meta = {
    v: 1,
    proto: 1,
    peer_id: core.peerId,
    epoch: newEpoch(deps.ports.random),
    seq_next: 1,
    branch: deps.branch,
    enc: core.refs.e,
    pinned: { url: sanitizeUrl(deps.url), identity: await rootsOf(repo, hr) },
    H_adopt: ep.head,
    EPOCH_BASE: lb.base,
    expected_epoch: ep,
    freeze_reasons: [],
    config_detail: [],
    incident: null,
    nonretryable: null,
    rejections: null,
    throttle: core.governor.toMeta(),
    pending: {},
    displaced: [],
    fold_board: T,
    fold_verified: v.verified,
    checkpoint_mismatch: v.checkpointMismatch,
    outbox: outbox.toJson(),
    cs_human_next: 1,
    incident_next: 1
  };
  const view = await core.state.create({ laC: lb.introducedBy, laB: T, base: aTree, snap: work.mat?.sDisk ?? aTree, meta, fold: folded.state });
  attachState(core, view);
  committed.set(core, "join");
  emitStartASet(core, work.A, "join");
  if (work.M.length === 0 || opts.publishLocal !== "all") setBoardOnlyFirstPublish(core, true);
  const prepared = await prepareIteration(core, 0, { materialize: false, forceFetch: true });
  if (prepared.ok) {
    const it = prepared.it;
    const r = await applyStep(core, it);
    const now = core.view;
    if (!r.ran && r.skipped === "nothing" && (now.laC !== it.tip || now.laB !== it.T) && it.T !== ABSENT) {
      const fp = foldPatch(core);
      await core.commit({ laC: it.tip, laB: it.T, ...fp !== null ? { meta: { ...now.meta, ...fp.meta }, fold: fp.fold } : {} });
    }
  } else {
    deps.log.write("warn", "JOIN_FIRST_APPLY_DEFERRED", { why: prepared.why });
  }
  crashpoint("join.first_apply");
  if (work.M.length > 0 && opts.publishLocal === "all") captureLocalWork(core, work.M);
  return { ok: true, mode: "join", restart: null };
}

// src/engine/status.ts
import { join as join12 } from "node:path";
var byCodeUnit2 = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function publishPauseOf(i) {
  return i.offline !== null ? i.offline.label : i.nonretryable !== null ? "NONRETRYABLE" : i.version !== null ? "VERSION" : null;
}
function blockedPublishReason(freeze, pause) {
  if (freeze.includes("INCIDENT")) return "INCIDENT";
  return freeze.find((r) => r !== "PAUSED") ?? (freeze.includes("PAUSED") ? "PAUSED" : pause);
}
function whyJson(w) {
  const out = { cause: w.cause };
  if ("guard" in w && w.guard !== void 0) out["guard"] = w.guard;
  if ("reason" in w) out["reason"] = w.reason;
  if ("check" in w) out["check"] = w.check;
  return out;
}
function stateOf(i, notConverged) {
  if (i.down !== null) return { state: "down", code: i.down.code, params: {} };
  if (i.refused !== null) return { state: "refused", code: i.refused.code, params: { ...i.refused.params } };
  if (i.freeze.includes("INCIDENT")) return { state: "incident", code: "INCIDENT", params: { ...i.incident ?? {} } };
  if (i.freeze.some((r) => r !== "PAUSED")) return { state: "frozen", code: "FROZEN", params: { reasons: [...i.freeze] } };
  if (i.freeze.length > 0) return { state: "paused", code: "PAUSED", params: {} };
  if (i.offline !== null) {
    return { state: "offline", code: "OFFLINE", params: { label: i.offline.label, explanation: i.offline.explanation, offline_for_s: i.offline.offlineForS } };
  }
  if (i.nonretryable !== null) return { state: "degraded", code: "NONRETRYABLE", params: { hold_id: i.nonretryable.holdId } };
  if (i.version !== null) return { state: "degraded", code: "VERSION_PAUSED", params: { form: i.version.form, cause: i.version.cause } };
  const explicit = i.notConvergedCause ?? null;
  if (notConverged.length > 0 || explicit !== null) {
    const whys = notConverged.map((p) => i.notConvergedCauses?.get(p) ?? { cause: "not_applicable" });
    const head = explicit !== null ? { cause: explicit } : whyJson(whys[0]);
    return { state: "degraded", code: "NOT_CONVERGED", params: { ...head, paths: [...notConverged], causes: whys.map(whyJson) } };
  }
  if (i.pendingOlderThan60s) {
    const d = i.deferred ?? null;
    return { state: "degraded", code: "DEFERRED", params: d === null ? {} : { reason: d.reason, paths: [...d.paths].sort(byCodeUnit2) } };
  }
  if (i.branchRewritten !== null) return { state: "ok", code: "BRANCH_REWRITTEN", params: { hb: i.branchRewritten.hb, hr: i.branchRewritten.hr } };
  if (i.throttle !== null) {
    const t = i.throttle;
    return { state: "ok", code: "HOST_THROTTLED", params: { source: t.source, until_min: t.untilMin, budget: t.budget, fallback_left_s: t.fallbackLeftS, signal: t.signal } };
  }
  if (i.lastEvent !== null) return { state: "ok", code: i.lastEvent.code, params: { ...i.lastEvent.params } };
  return { state: "ok", code: null, params: {} };
}
function computeStatus(i) {
  const notConverged = [...new Set(i.notConverged)].sort(byCodeUnit2);
  const pause = publishPauseOf(i);
  const s = stateOf(i, notConverged);
  return {
    v: 1,
    state: s.state,
    freeze_reasons: [...i.freeze],
    publish_pause: pause,
    branch: i.branch,
    peer_id: i.peerId,
    plugin_version: i.pluginVersion,
    heartbeat_mono_ms: i.heartbeatMs,
    loop_period_ms: i.loopPeriodMs,
    last_fetch_age_ms: i.lastFetchAgeMs,
    last_push_age_ms: i.lastPushAgeMs,
    pending: {
      cs_ready: i.counts.csReady,
      cs_open: i.counts.csOpen,
      holds_active: i.counts.holdsActive,
      holds_local_only: i.counts.holdsLocalOnly,
      incoming: i.counts.incoming,
      not_converged: notConverged
    },
    claims_held: 0,
    requests_in: 0,
    requests_out: 0,
    // claims and requests are Plans 4 and 6
    adopt: { state: "current", reasons: [] },
    // adopt is Plan 7 (LIF-31)
    message_code: s.code,
    message_params: s.params
  };
}
var RETRIES = 3;
var RETRY_MS = 50;
var RETRYABLE = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EBUSY"]);
var StatusWriter = class {
  fs;
  file;
  tmp;
  clock;
  /** Writes are queued: one status write at a time, in call order. */
  tail = Promise.resolve();
  constructor(fs, file, tmpDir, clock) {
    this.fs = fs;
    this.file = file;
    this.tmp = join12(tmpDir, "status.json.tmp");
    this.clock = clock;
  }
  /** temp + rename; EPERM/EACCES/EBUSY retry 3 × 50 ms, then skip (false). Any other error propagates (the temp file removed). */
  write(s) {
    const run = this.tail.then(() => this.writeNow(s));
    this.tail = run.catch(() => void 0);
    return run;
  }
  async writeNow(s) {
    const bytes = Buffer.from(`${JSON.stringify(s)}
`, "utf8");
    for (let attempt = 0; ; attempt++) {
      try {
        await this.fs.writeFile(this.tmp, bytes);
        await this.fs.rename(this.tmp, this.file);
        return true;
      } catch (e) {
        const retryable = RETRYABLE.has(errnoCode(e) ?? "");
        if (!retryable || attempt >= RETRIES) {
          await this.fs.unlink(this.tmp).catch(() => void 0);
          if (retryable) return false;
          throw e;
        }
        await this.clock.sleep(RETRY_MS);
      }
    }
  }
};

// src/engine/loop.ts
var LOOP_ACTIVE_MS = 2500;
var LOOP_IDLE_MS = 1e4;
var SUSPEND_LOOP_FACTOR = 3;
var heldLocks = /* @__PURE__ */ new Map();
function staleHolder(h, coworkDir, alive) {
  if (h.started !== null && h.started > machineMonoMs()) return true;
  if (h.pid === process.pid) return heldLocks.get(coworkDir) !== h.instance || h.started !== processStartMonoMs();
  return !alive(h.pid);
}
var NO_HOLDER_STALE_MS = 1e4;
async function noHolderStale(fs, coworkDir, file) {
  const probe = join13(coworkDir, `${DAEMON_LOCK_FILE}.probe-${process.pid}`);
  try {
    await fs.writeFile(probe, Buffer.from("cowork daemon.lock age probe\n", "utf8"));
    const now = await fs.lstat(probe);
    const lock = await fs.lstat(file);
    if (now === null) return false;
    if (lock === null) return true;
    return now.mtimeNs - lock.mtimeNs >= BigInt(NO_HOLDER_STALE_MS) * 1000000n;
  } finally {
    await fs.unlink(probe).catch(() => void 0);
  }
}
var DaemonLock = class _DaemonLock {
  file;
  holder;
  fs;
  coworkDir;
  released = false;
  constructor(fs, coworkDir, holder) {
    this.fs = fs;
    this.coworkDir = coworkDir;
    this.file = join13(coworkDir, DAEMON_LOCK_FILE);
    this.holder = holder;
  }
  static async acquire(fs, coworkDir, who, alive = processAlive) {
    await fs.mkdirp(coworkDir);
    const holder = { pid: process.pid, plugin_version: who.pluginVersion, instance: who.instance, started: processStartMonoMs() };
    const file = join13(coworkDir, DAEMON_LOCK_FILE);
    const bytes = Buffer.from(`${JSON.stringify(holder)}
`, "utf8");
    let seen = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFileExclusive(file, bytes);
        heldLocks.set(coworkDir, holder.instance);
        return new _DaemonLock(fs, coworkDir, holder);
      } catch (e) {
        if (errnoCode(e) !== "EEXIST") throw e;
      }
      let buf;
      try {
        buf = await fs.readFile(file);
      } catch (e) {
        if (errnoCode(e) === "ENOENT") continue;
        throw e;
      }
      seen = parseLockHolder(buf);
      if (seen !== null && !staleHolder(seen, coworkDir, alive)) return { held: seen };
      if (seen === null && !await noHolderStale(fs, coworkDir, file)) return { held: null };
      if (attempt > 0) break;
      try {
        await fs.unlink(file);
      } catch (e) {
        if (errnoCode(e) !== "ENOENT") throw e;
      }
    }
    return { held: seen };
  }
  /** The holding process died (a crash, or a SIM kill): forget this process's in-memory hold and leave the file behind,
   *  as a dead process would. The next acquire then sees a stale lock (staleHolder) and takes it over. Idempotent. */
  abandon() {
    if (this.released) return;
    this.released = true;
    if (heldLocks.get(this.coworkDir) === this.holder.instance) heldLocks.delete(this.coworkDir);
  }
  /** Removes the file when it still names this holder; idempotent. */
  async release() {
    if (this.released) return;
    this.released = true;
    if (heldLocks.get(this.coworkDir) === this.holder.instance) heldLocks.delete(this.coworkDir);
    let cur = null;
    try {
      cur = parseLockHolder(await this.fs.readFile(this.file));
    } catch (e) {
      if (errnoCode(e) === "ENOENT") return;
      throw e;
    }
    if (cur !== null && cur.instance === this.holder.instance && cur.pid === this.holder.pid) await this.fs.unlink(this.file);
  }
};
async function daemonLockHeld(fs, coworkDir) {
  const instance = heldLocks.get(coworkDir);
  if (instance === void 0) return false;
  try {
    const h = parseLockHolder(await fs.readFile(join13(coworkDir, DAEMON_LOCK_FILE)));
    return h !== null && h.instance === instance && h.pid === process.pid && h.started === processStartMonoMs();
  } catch {
    return false;
  }
}
var INTENT_UNRESOLVED_MS = 6e4;
var INTENT_LOG_EVERY_MS = 6e5;
var PENDING_OLD_MS = 6e4;
var FETCH_OWED_MS = 6e4;
var NOT_APPLICABLE = /* @__PURE__ */ new Set(["collision", "unmaterializable", "quarantine"]);
var NOT_APPLICABLE_GUARD = { collision: "collision", unmaterializable: "unmaterializable", quarantine: "quarantine-review" };
var WAITING_GUARDS = /* @__PURE__ */ new Set(["restart", "phantom", "host-reject", "join"]);
var NO_VERSION = { proto: false, regionSpec: false, checkpointMismatch: false };
var OFFLINE_EXPLANATION = "network-or-auth";
function logParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) out[k] = v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : JSON.stringify(v);
  return out;
}
var hex8 = (oid2) => oid2.slice(0, 8);
var Engine = class _Engine {
  peerId;
  core;
  status;
  /** This Engine's creation (the daemon start): offline_for_s counts from here until a fetch succeeds. */
  createdMono;
  /** The queue every operation runs in: one at a time, in call order. */
  tail = Promise.resolve();
  n = 0;
  started = false;
  drainedFlag = false;
  refused = null;
  down = null;
  lastEvent = null;
  lastStatus = null;
  /**
   * 0a: the START of the previous iteration (the suspend gap Δwall − Δmono counts from it), its END and the period the
   * loop used after it (Δmono > SUSPEND_LOOP_FACTOR × period counts from the end).
   */
  prevStart = null;
  prevEnd = null;
  period = LOOP_ACTIVE_MS;
  /**
   * The fetch owed since a suspend (LIF-39), until one succeeds: `sinceMono` the suspend that made it owed; `force` until
   * the first forced fetch after it has completed — a failed one (a network failure, or a LOCAL one, P2-FETCHLOCAL) is
   * followed by the normal schedule (the spacing, the loop period and any network backoff), never by a forced fetch
   * every iteration; `logged` its one NOT_CONVERGED{fetch_owed} log line once it is FETCH_OWED_MS old.
   */
  owed = null;
  freshRequested = false;
  wake = null;
  /** The completed (non-deferred) fetches of the current operation, told by the Fetcher's hook (Engine.create). */
  views = [];
  indexLock = null;
  lastVersion = null;
  lastCarried = /* @__PURE__ */ new Set();
  lastFilterFailures = /* @__PURE__ */ new Set();
  /** ENG-28: the INV-MASK violation of the last iteration that checked S_pub (null once one passes). */
  maskViolation = null;
  /**
   * Final review FC-2 (ENG-41, 01-engine §2 NOT_CONVERGED{cause: publish_assert, check}): the check that aborted the last
   * publishStep (PublishReport.assert); kept while publishes are skipped, cleared by a publishStep that got past every
   * check (landed, nothing, lease_lost, transient, nonretryable, network).
   */
  publishAssert = null;
  /** Final review FC-4: this iteration's publishStep report (null when the iteration never reached publishStep). */
  lastPublish = null;
  branch = null;
  pendingSince = /* @__PURE__ */ new Map();
  deferredApplies = /* @__PURE__ */ new Map();
  intentSince = null;
  intentLogged = null;
  wasOffline = false;
  wasVersion = false;
  constructor(core) {
    this.core = core;
    this.peerId = core.peerId;
    const { coworkDir } = core.deps.paths;
    this.status = new StatusWriter(core.deps.ports.fs, join13(coworkDir, "status.json"), join13(coworkDir, "tmp"), core.deps.ports.clock);
    this.createdMono = core.deps.ports.clock.monoMs();
  }
  /**
   * Every completed fetch of this clone (the iteration's own, publish's classify fetch, recover's) reaches the Engine
   * through the hook it gives the Fetcher at construction (no method of the core is replaced): the report's `fetched`,
   * the suspend rule's "a fetch succeeded" and the throttle hand-over read them.
   */
  static async create(deps) {
    let engine = null;
    const core = await createEngineCore(deps, {
      onFetched: (v) => {
        engine?.views.push(v);
      }
    });
    engine = new _Engine(core);
    return engine;
  }
  get drained() {
    return this.drainedFlag;
  }
  /** runLoop's hook: an out-of-cycle request starts an iteration at once (at most one in flight). */
  setWake(f) {
    this.wake = f;
  }
  exclusive(fn) {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => void 0);
    return run;
  }
  /** Restart, recover and resume run only while daemon.lock is held (R-26; Task 15 carry). */
  async assertLock(what) {
    const { fs } = this.core.deps.ports;
    if (!await daemonLockHeld(fs, this.core.deps.paths.coworkDir)) {
      throw new Error(`Engine.${what}: daemon.lock is not held by this process (restart, recover and resume run only under it)`);
    }
  }
  event(level, code, params) {
    this.lastEvent = { code, params };
    this.core.deps.log.write(level, code, logParams(params));
  }
  /** Table 3.3-A (startDispatch, R-23) under daemon.lock; a StartRefused escaping a direct restart() maps to the same refusal. */
  start(opts) {
    return this.exclusive(async () => {
      await this.assertLock("start");
      let r;
      try {
        r = await startDispatch(this.core, opts);
      } catch (e) {
        if (!(e instanceof StartRefused)) throw e;
        r = { ok: false, code: e.code, params: e.params };
      }
      if (r.ok) {
        this.started = true;
        this.refused = null;
        this.prevStart = null;
        this.prevEnd = null;
        this.core.deps.log.write("info", "STARTED", { mode: r.mode });
        const lost = r.restart?.lostState ?? null;
        if (lost !== null) this.event("warn", "LOST_STATE", { mode: lost.mode, records: lost.records.length, paths: lost.paths.length });
        if (takeStartCapture(this.core)) await this.captureAtStart();
      } else {
        this.refused = { code: r.code, params: r.params };
        this.core.deps.log.write("warn", r.code, logParams(r.params));
      }
      await this.writeStatus();
      return r;
    });
  }
  iterate() {
    return this.exclusive(() => this.iterateNow());
  }
  /** /cowork done: the open human change-set closes at the next iteration (HLD-35), which starts at once. */
  done() {
    this.core.cs.done();
    this.wake?.();
  }
  /**
   * Out-of-cycle request (a): the next iteration starts at once. A request that arrives while a fetch is in flight waits
   * for that fetch instead of starting another (01-engine §3.5): the next iteration decides on its answer. Otherwise the
   * next iteration fetches at once, inside the 2.5 s spacing. Never two fetches at once.
   */
  requestFreshFetch() {
    if (!this.core.fetcher.inFlight()) this.freshRequested = true;
    this.wake?.();
  }
  /** The human-typed recover as a request inside the running daemon (queued behind the iteration in flight) or in a `daemon.js recover` process; daemon.lock held either way. */
  recover(confirm) {
    return this.exclusive(async () => {
      await this.assertLock("recover");
      this.views = [];
      const r = await recover(this.core, confirm);
      if (r.ok && r.done) this.event("info", "RECOVERED", { mode: r.preview.mode });
      await this.writeStatus();
      return r;
    });
  }
  /**
   * R-28: meta.nonretryable and the rejection streak cleared by one state CAS; false when there is nothing to clear.
   * Final review FC-5 (05-holds: host-reject is "lifted by human /cowork resume (the publish is retried)", ENG-45): the
   * host-reject PIN that meta.nonretryable names ends first (RESOLVED_PUBLISH, guard kept so a pathless record stays
   * valid), so P2-PIN no longer holds its change-sets back and the next iterations retry the rejected publish; before
   * the CAS, so a crash between the two leaves the pause (the next resume clears it), never a PIN nothing lifts.
   */
  resumeAfterNonretryable() {
    return this.exclusive(async () => {
      await this.assertLock("resumeAfterNonretryable");
      const view = this.core.view;
      if (view === null || view.meta.nonretryable === null && view.meta.rejections === null) return false;
      const holdId = view.meta.nonretryable?.hold_id ?? null;
      const pin = holdId === null ? void 0 : this.core.holds.get(holdId);
      if (pin !== void 0 && !isTerminal(pin) && pin.guards.some((g) => guardName(g) === "host-reject")) {
        await this.core.holds.transition(pin.id, { state: "RESOLVED_PUBLISH", residence: null });
      }
      if (view.meta.nonretryable !== null) this.core.outbox.add({ type: "event", cid: "", kind: "nonretryable", refs: [], reason_code: "NONRETRYABLE" });
      const fp = foldPatch(this.core);
      await this.core.commit({
        meta: { ...view.meta, ...fp?.meta ?? {}, nonretryable: null, rejections: null, outbox: this.core.outbox.toJson() },
        ...fp !== null ? { fold: fp.fold } : {}
      });
      this.core.deps.log.write("info", "RESUMED", { hold_id: view.meta.nonretryable?.hold_id ?? null });
      return true;
    });
  }
  /** The last status.json and what the SIM oracles read. */
  async inspect() {
    const view = this.core.view;
    if (view === null) throw new Error("Engine.inspect: no state (start first)");
    const inputs = this.statusInputs();
    const status = computeStatus(inputs);
    return {
      peerId: this.peerId,
      laC: view.laC,
      laB: view.laB,
      aTree: view.base,
      snapTree: view.snap,
      epochBase: view.meta.EPOCH_BASE,
      freeze: [...view.meta.freeze_reasons],
      publishPause: status.publish_pause,
      pending: { ...view.meta.pending },
      notConverged: [...status.pending.not_converged],
      holds: [...this.core.holds.all()],
      ready: [...this.core.cs.ready()],
      pushAttempts: this.core.pushAttempts,
      status,
      notConvergedWhy: Object.fromEntries(inputs.notConvergedCauses ?? [])
    };
  }
  /** ENG-55 / CCI-50: finish the operation in flight, write status.json `down` (IDLE_NO_SESSION or no code); no iteration after it. */
  drain(downCode) {
    return this.exclusive(async () => {
      if (this.drainedFlag) return;
      this.drainedFlag = true;
      this.down = { code: downCode };
      this.core.deps.log.write("info", "DRAINED", { code: downCode });
      await this.writeStatus();
    });
  }
  // ---- one iteration ----------------------------------------------------------------------------------------------
  async iterateNow() {
    const core = this.core;
    const { deps } = core;
    const clock = deps.ports.clock;
    const startAnchor = anchorNow(clock);
    const n = ++this.n;
    if (this.drainedFlag) return this.report(n, false, null, false, false, false);
    if (!this.started || core.view === null) throw new Error("Engine.iterate: start() has not succeeded");
    const pushesBefore = core.pushAttempts;
    this.views = [];
    this.lastPublish = null;
    const prevStart = this.prevStart;
    this.prevStart = startAnchor;
    if (prevStart !== null && this.prevEnd !== null) {
      const gap = suspendGapMs(clock, prevStart);
      const dMono = elapsedMono(clock, this.prevEnd);
      if (gap > SUSPEND_GAP_THRESHOLD_MS || dMono > SUSPEND_LOOP_FACTOR * this.period) {
        core.fetcher.abandon();
        this.owed = { sinceMono: this.owed?.sinceMono ?? clock.monoMs(), force: true, logged: this.owed?.logged ?? false };
        deps.log.write("info", "SUSPEND_GAP", { gap_ms: Math.round(gap), mono_ms: Math.round(dMono) });
      }
    }
    const force = this.owed?.force === true || this.freshRequested;
    this.freshRequested = false;
    const obs = await observeEpoch(core.repo, deps.ports.fs);
    const lockOnly = this.trackIndexLock(obs, clock.monoMs());
    const epochFrozen = epochVerdict(obs, core.view.meta.expected_epoch) === "FREEZE";
    await this.setEpochFreeze(epochFrozen, obs);
    const leaseStopped = deps.lease.idleMs() >= LEASE_STOP_SYNC_MS;
    const fetchFoldOnly = lockOnly || epochFrozen;
    const captureAllowed = !fetchFoldOnly && !leaseStopped;
    const prepared = await prepareIteration(core, n, { materialize: captureAllowed ? "auto" : false, forceFetch: force, fetchFoldOnly });
    if (this.views.some((v) => v.ok)) {
      this.owed = null;
    } else if (this.owed?.force === true && this.views.length > 0) {
      this.owed.force = false;
      deps.log.write("warn", "FETCH_OWED", { local: this.views.some((v) => v.localFailure) });
    }
    let apply = null;
    let landed = false;
    let applyPending = false;
    if (!prepared.ok) {
      handOverThrottle(core, this.views[0] ?? null, pushStatesOf(core, this.lastVersion ?? NO_VERSION));
      if (prepared.why === "incident") {
        await enterIncident(core, prepared.verdict, prepared.T);
      } else {
        deps.log.write("error", "ITERATION_SKIPPED", { why: prepared.why });
      }
    } else {
      const it = prepared.it;
      if (await clearIncidentIfHealed(core, it)) this.event("info", "UNFROZEN", { reasons: ["INCIDENT"] });
      this.lastVersion = it.version;
      if (it.tick !== null) {
        const tipOnly = it.A === it.tipMap ? [] : [...it.tipMap.keys()].filter((p) => !it.A.has(p) && core.snapshot.isCarried(p));
        this.lastCarried = tipOnly.length === 0 ? it.tick.carried : /* @__PURE__ */ new Set([...it.tick.carried, ...tipOnly]);
        this.lastFilterFailures = new Set([...it.tick.excluded].filter(([, why]) => why === "filter_failure").map(([p]) => p));
      }
      await this.classifyBranch(it);
      const fetchedNow = it.fetched !== null && !it.fetched.deferred ? it.fetched : null;
      if (lockOnly || epochFrozen && this.owed !== null) {
        handOverThrottle(core, fetchedNow, it.pushStates);
      } else if (epochFrozen) {
        const publish = this.notePublish(await publishStep(core, it));
        if (publish.outcome === "landed") landed = true;
      } else {
        let maskOk = true;
        if (captureAllowed && captureDue(core) && it.mat === null) {
          it.mat = await core.snapshot.materialize(tickInputOf(core, it));
          await ensureAttrs(core, it.epochBase, it.mat.sDiskMap.keys());
        }
        if (it.mat !== null) {
          await this.eolBomRecords(it, it.mat);
          const held = await this.sPubHolds(it, it.mat);
          this.maskViolation = held;
          if (held !== null) {
            maskOk = false;
            deps.log.write("error", "NOT_CONVERGED", { cause: "publish_assert", check: held.check, path: held.path });
          }
        }
        if (captureAllowed && maskOk && captureDue(core)) await this.capture(it);
        if (this.owed !== null) {
          handOverThrottle(core, fetchedNow, it.pushStates);
        } else {
          if (core.view.intent.kind === "push") {
            const r = await resolvePushIntent(core, it);
            if (r.outcome === "landed") landed = true;
            const discarded = r.outcome !== "landed" && r.why === "resolved";
            if (discarded && captureAllowed && maskOk && it.mat !== null && captureDue(core)) await this.capture(it);
          }
          apply = await applyStep(core, it);
          if (maskOk) {
            const publish = this.notePublish(await publishStep(core, it));
            if (publish.outcome === "landed") landed = true;
          } else {
            handOverThrottle(core, fetchedNow, it.pushStates);
          }
          if (apply.ran) this.countDeferrals();
        }
      }
      applyPending = applyNeeded(core, it);
    }
    return this.finish(n, pushesBefore, apply, landed, applyPending);
  }
  /** 7: the iteration's bookkeeping, events, status.json, trace and report; its end anchors the next Δmono check. */
  async finish(n, pushesBefore, apply, landed, applyPending) {
    const core = this.core;
    const view = core.view;
    const clock = core.deps.ports.clock;
    const now = clock.monoMs();
    if (view.intent.kind === "push") {
      this.intentSince ??= now;
      if (now - this.intentSince > INTENT_UNRESOLVED_MS && (this.intentLogged === null || now - this.intentLogged >= INTENT_LOG_EVERY_MS)) {
        this.intentLogged = now;
        core.deps.log.write("error", "NOT_CONVERGED", { cause: "push_unresolved", bnew: view.intent.bnew, held_s: Math.floor((now - this.intentSince) / 1e3) });
      }
    } else {
      this.intentSince = null;
      this.intentLogged = null;
    }
    if (this.owed !== null && !this.owed.logged && now - this.owed.sinceMono >= FETCH_OWED_MS) {
      this.owed.logged = true;
      core.deps.log.write("error", "NOT_CONVERGED", { cause: "fetch_owed", owed_s: Math.floor((now - this.owed.sinceMono) / 1e3) });
    }
    for (const p of Object.keys(view.meta.pending)) if (!this.pendingSince.has(p)) this.pendingSince.set(p, now);
    for (const p of [...this.pendingSince.keys()]) if (!Object.prototype.hasOwnProperty.call(view.meta.pending, p)) this.pendingSince.delete(p);
    const off = core.fetcher.offline();
    if (off.offline !== this.wasOffline) {
      this.wasOffline = off.offline;
      if (off.offline) core.deps.log.write("warn", "OFFLINE", { label: "OFFLINE", explanation: OFFLINE_EXPLANATION, offline_for_s: this.offlineForS() });
      else this.event("info", "ONLINE", {});
    }
    const v = this.lastVersion ?? NO_VERSION;
    const version = v.proto || v.regionSpec || v.checkpointMismatch;
    if (version !== this.wasVersion) {
      this.wasVersion = version;
      if (version) core.deps.log.write("warn", "VERSION_PAUSED", { form: v.proto ? "proto" : "regionSpec", cause: !v.proto && !v.regionSpec ? "checkpoint_mismatch" : null });
    }
    const active = this.activeNow(applyPending);
    this.period = active ? LOOP_ACTIVE_MS : LOOP_IDLE_MS;
    await this.writeStatus();
    const fetched = this.views.some((x) => x.ok);
    const applied = apply?.ran === true;
    const pushes = core.pushAttempts - pushesBefore;
    core.deps.trace.emit({ kind: "iteration", peer: core.peerId, n, fetched, applied, pushes });
    this.prevEnd = anchorNow(clock);
    return this.report(n, fetched, apply, landed, active, true, pushes);
  }
  report(n, fetched, apply, landed, active, live, pushes = 0) {
    const meta = this.core.view?.meta;
    return {
      n,
      fetched,
      applied: apply?.ran === true,
      pushAttempts: pushes,
      landed,
      frozen: (meta?.freeze_reasons.length ?? 0) > 0,
      incident: meta?.freeze_reasons.includes("INCIDENT") === true,
      active,
      nextDueMs: live ? this.nextDue(active) : LOOP_IDLE_MS
    };
  }
  /** Work pending (01-engine §3.5 period): an open or due change-set, ready pairs, outbox ops, an intent, pending paths, an apply to do, a stranded restore or a forced fetch still owed. */
  activeNow(applyPending) {
    const core = this.core;
    const view = core.view;
    const cs = core.cs.counts();
    return cs.open > 0 || cs.ready > 0 || core.outbox.size > 0 || view.intent.kind !== "none" || Object.keys(view.meta.pending).length > 0 || applyPending || core.writer.strandedPaths().length > 0 || this.owed?.force === true || this.indexLock !== null;
  }
  /**
   * This iteration's publishStep report (final review FC-2, FC-4): the iteration's report for nextDue, and the publish_assert
   * kept for status — set by a report carrying an aborting check, cleared by one that got past every check (landed,
   * nothing, lease_lost, transient, nonretryable, network), kept on a skip or another abort (the check did not run).
   */
  notePublish(r) {
    this.lastPublish = r;
    if (r.assert !== null) this.publishAssert = r.assert;
    else if (r.outcome !== "skipped" && r.outcome !== "aborted") this.publishAssert = null;
    return r;
  }
  /**
   * The loop period, or sooner when a governed window is what keeps pending publish work waiting: only after this
   * iteration's publishStep was skipped for the window or made an attempt (final review FC-4). Any other skip — no
   * publishStep (index.lock, FREEZE, an owed fetch, an INV-MASK abort), an aborting check, a filter failure, a stranded
   * restore — waits the period: the window opening changes nothing for it, and an earlier iteration would only spin.
   */
  nextDue(active) {
    const core = this.core;
    const period = active ? LOOP_ACTIVE_MS : LOOP_IDLE_MS;
    const lp = this.lastPublish;
    if (lp === null || !(lp.attempted || lp.outcome === "skipped" && lp.why === "window")) return period;
    const fold = foldPatch(core)?.fold ?? core.view?.fold ?? null;
    if (fold === null || core.cs.ready().length === 0 && core.outbox.size === 0) return period;
    const w = core.governor.msUntilWindow(governorRank(fold, core.peerId));
    return Number.isFinite(w) ? Math.max(0, Math.min(period, Math.ceil(w))) : period;
  }
  /** 0b (ENG-15, LIF-10): true while .git/index.lock exists; INDEX_LOCK_WAIT{age} once after it kept one mtime for 30 s (Δmono). */
  trackIndexLock(obs, nowMono) {
    if (!obs.indexLock.present) {
      if (this.indexLock !== null && this.lastEvent?.code === "INDEX_LOCK_WAIT") this.lastEvent = null;
      this.indexLock = null;
      return false;
    }
    const m = obs.indexLock.mtimeNs;
    if (this.indexLock === null || this.indexLock.mtimeNs !== m) {
      this.indexLock = { mtimeNs: m, sinceMono: nowMono, noticed: false };
    } else if (!this.indexLock.noticed && nowMono - this.indexLock.sinceMono >= INDEX_LOCK_NOTICE_MS) {
      this.indexLock.noticed = true;
      this.event("warn", "INDEX_LOCK_WAIT", { age: Math.floor((nowMono - this.indexLock.sinceMono) / 1e3) });
    }
    return true;
  }
  /** 0c (R-09): FREEZE(EPOCH) set or lifted by one state update, with one board-only freeze/unfreeze event queued (R-27). */
  async setEpochFreeze(frozen, obs) {
    const core = this.core;
    const view = core.view;
    if (view.meta.freeze_reasons.includes("EPOCH") === frozen) return;
    const reasons = frozen ? [...view.meta.freeze_reasons, "EPOCH"] : view.meta.freeze_reasons.filter((r) => r !== "EPOCH");
    core.outbox.add({ type: "event", cid: "", kind: frozen ? "freeze" : "unfreeze", refs: [], reason_code: frozen ? "FROZEN" : "UNFROZEN" });
    const fp = foldPatch(core);
    await core.commit({ meta: { ...view.meta, ...fp?.meta ?? {}, freeze_reasons: reasons, outbox: core.outbox.toJson() }, ...fp !== null ? { fold: fp.fold } : {} });
    if (frozen) {
      this.event("warn", "FROZEN", { reasons: ["EPOCH"], symref: obs.symref, head: obs.head, stash: obs.stash, markers: obs.markers.join(",") });
    } else {
      this.event("info", "UNFROZEN", { reasons: ["EPOCH"] });
    }
  }
  /** R-08: BRANCH_REWRITTEN when Hr is missing or Hb = live_base(TIP) is not an ancestor of Hr; otherwise Hr ≠ Hb is ignored. */
  async classifyBranch(it) {
    const f = it.fetched;
    if (f === null || f.deferred || !f.ok) return;
    const hr = f.branch;
    const key = `${it.tip} ${hr === ABSENT ? "" : hr}`;
    if (this.branch?.key === key) return;
    const core = this.core;
    let value = null;
    try {
      const hb = (await liveBase(core.repo, it.tip)).base;
      if (hr === ABSENT || !await core.repo.isAncestor(hb, hr)) value = { hb: hex8(hb), hr: hr === ABSENT ? "missing" : hex8(hr) };
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      return;
    }
    if (value !== null && (this.branch?.value ?? null) === null) core.deps.log.write("warn", "BRANCH_REWRITTEN", { hb: value.hb, hr: value.hr });
    this.branch = { key, value };
  }
  /**
   * R-07: a canon REFUSE(eol-bom) on a LIVE path holds it in one ON_DISK PATCH with the whole-path guard `eol-bom`
   * (masked, DAT-06; a newer refused version updates its h1); a later materialized snapshot in which the path passes
   * canon drops the guard and ends the record GONE (the refused bytes left the disk; no record piles up ACTIVE).
   */
  async eolBomRecords(it, mat) {
    const core = this.core;
    const records = core.holds.nonTerminal().filter((r) => r.kind === "PATCH" && r.paths.length === 1 && r.guards.some((g) => guardName(g) === "eol-bom"));
    const refused = [...mat.canonRefused];
    await ensureAttrs(core, it.epochBase, refused);
    for (const p of refused) {
      if (it.scope(p).cls !== "LIVE") continue;
      const blobs = { h0: { [p]: it.A.get(p)?.oid ?? ABSENT }, h1: { [p]: mat.sRawMap.get(p)?.oid ?? ABSENT } };
      const existing = records.find((r) => r.paths[0] === p);
      if (existing === void 0) {
        const id = await core.holds.hold({ kind: "PATCH", residence: "ON_DISK", state: "ACTIVE", paths: [p], blobs, guard: "eol-bom", origin: "daemon", cs_ids: [], displaced_by: null, local_only: false });
        core.deps.log.write("warn", "EOL_BOM_HELD", { path: p, hold_id: id });
      } else if ("h1" in existing.blobs && existing.blobs.h1[p] !== blobs.h1[p]) {
        await core.holds.transition(existing.id, { blobs });
      }
    }
    const unsettled = /* @__PURE__ */ new Set([...it.tick?.excluded.keys() ?? [], ...mat.excluded.keys()]);
    for (const r of records) {
      const p = r.paths[0];
      if (mat.canonRefused.has(p) || unsettled.has(p)) continue;
      await core.holds.transition(r.id, { guards: [], state: "GONE", residence: null });
      core.deps.log.write("info", "EOL_BOM_RELEASED", { path: p, hold_id: r.id, state: "GONE" });
    }
  }
  /** Step 4: S_pub := MASK(S_disk) with INV-MASK asserted (no held path differs from A); the violation, or null. */
  async sPubHolds(it, mat) {
    const core = this.core;
    const records = core.holds.maskingRecords();
    await ensureAttrs(core, it.epochBase, [...diffPaths(it.A, mat.sDiskMap), ...records.flatMap((r) => r.paths)]);
    const inp = { A: it.A, scope: (p) => it.scope(p).cls, records };
    const sPub = maskEntries(mat.sDiskMap, inp);
    const held = heldPathInP(it.A, sPub, (p) => {
      const r = maskReason(p, inp);
      return r !== null && r !== "path_class";
    }, (p) => it.scope(p).cls);
    return held === null ? null : { path: held.path, check: held.letter };
  }
  /**
   * R-22 'all' (final review FC-8): the local work M a genesis or join closed (start.ts captureLocalWork) is captured at
   * once, by step 4 like every capture — the R-07 eol-bom holds, S_pub := MASK(S_disk) with INV-MASK, the captureDue gate
   * — so its change-set holds what was on disk at the start, and an edit made after it waits its own quiet period. What
   * cannot run here (an incident or another failed prepare, an INV-MASK violation, a stranded restore, no lease) leaves
   * the CS closed for the loop's first capture.
   */
  async captureAtStart() {
    const core = this.core;
    if (!captureDue(core) || core.deps.lease.idleMs() >= LEASE_STOP_SYNC_MS) return;
    const prepared = await prepareIteration(core, 0, { materialize: true, forceFetch: true });
    if (!prepared.ok || prepared.it.mat === null) {
      core.deps.log.write("warn", "START_LOCAL_CAPTURE_DEFERRED", { why: prepared.ok ? "no_snapshot" : prepared.why });
      return;
    }
    const it = prepared.it;
    const mat = prepared.it.mat;
    await this.eolBomRecords(it, mat);
    const held = await this.sPubHolds(it, mat);
    this.maskViolation = held;
    if (held !== null) {
      core.deps.log.write("error", "NOT_CONVERGED", { cause: "publish_assert", check: held.check, path: held.path });
      return;
    }
    if (captureDue(core)) await this.capture(it);
  }
  /** HLD-40: the due human change-set captured from this iteration's S_disk and journaled (one state update). */
  async capture(it) {
    const core = this.core;
    if (it.mat === null) throw new Error("capture: the iteration materialized nothing");
    const prev = core.view;
    const kept = prev.intent.kind === "push" ? new Set(prev.intent.cs_ids) : /* @__PURE__ */ new Set();
    const cap = await core.cs.capture(core.repo, it.mat.sDiskMap, it.A, core.scratch("r"), kept);
    if (cap === null) return;
    const fp = foldPatch(core);
    try {
      await core.commit({ ready: core.cs.ready(), meta: { ...prev.meta, ...fp?.meta ?? {}, cs_human_next: cap.nextN }, ...fp !== null ? { fold: fp.fold } : {} });
    } catch (e) {
      if (!(e instanceof StateCasLostError) && !(e instanceof KilledAt)) core.cs.restore(prev.ready, prev.meta.cs_human_next);
      throw e;
    }
  }
  /** ENG-57: a deferral is listed once it outlived one apply (it was pending at two applies in a row). */
  countDeferrals() {
    const pending = this.core.view.meta.pending;
    for (const p of [...this.deferredApplies.keys()]) if (!Object.prototype.hasOwnProperty.call(pending, p)) this.deferredApplies.delete(p);
    for (const [p, why] of Object.entries(pending)) if (!NOT_APPLICABLE.has(why)) this.deferredApplies.set(p, (this.deferredApplies.get(p) ?? 0) + 1);
  }
  // ---- status.json -------------------------------------------------------------------------------------------------
  /**
   * not_converged with the cause of each path and its 01-engine §2 qualifier (NOT_CONVERGED, §3.16, ENG-28, ENG-57, R-03,
   * R-05, R-10, P2-CARRY, Task 14 carry). One cause per path, the first that applies: publish_assert (check: the letter),
   * phantom, push_unresolved, fetch_owed, not_applicable (guard: unmaterializable for a P2-CARRY path, filter-failure,
   * collision, unmaterializable or quarantine-review for a not-applicable incoming change), deferred (reason: the defer
   * reason), blocked_publish (guard: the DECISION record or P2-PIN that holds it; reason: `blockReason`, the FREEZE reason
   * or publish pause that keeps a ready pair).
   */
  notConverged(unresolved, fetchOwed, blockReason) {
    const core = this.core;
    const view = core.view;
    const out = /* @__PURE__ */ new Map();
    const add = (p, w) => {
      if (!out.has(p)) out.set(p, w);
    };
    if (this.maskViolation !== null) add(this.maskViolation.path, { cause: "publish_assert", check: this.maskViolation.check });
    const pa = this.publishAssert;
    if (pa !== null) {
      if (pa.path !== null) {
        add(pa.path, { cause: "publish_assert", check: pa.check });
      } else {
        const pinned2 = pinnedPaths(core);
        for (const pair of core.cs.ready()) {
          if (!pair.paths.some((p) => pinned2.has(p))) for (const p of pair.paths) add(p, { cause: "publish_assert", check: pa.check });
        }
      }
    }
    for (const p of phantomPaths(core)) add(p, { cause: "phantom" });
    const local = () => {
      for (const p of this.lastCarried) add(p, { cause: "not_applicable", guard: "unmaterializable" });
      for (const p of this.lastFilterFailures) add(p, { cause: "not_applicable", guard: "filter-failure" });
    };
    if (view === null) {
      local();
      return out;
    }
    const waiting = core.holds.nonTerminal().map((r) => ({ r, guard: r.guards.map((g) => guardName(g)).find((g) => WAITING_GUARDS.has(g) || g === "conflict" && r.residence === "ON_DISK") }));
    for (const { r, guard } of waiting) if (guard === "phantom") for (const p of r.paths) add(p, { cause: "phantom" });
    const intentCs = unresolved && view.intent.kind === "push" ? new Set(view.intent.cs_ids) : /* @__PURE__ */ new Set();
    for (const pair of core.cs.ready()) if (intentCs.has(pair.csId)) for (const p of pair.paths) add(p, { cause: "push_unresolved" });
    if (fetchOwed) for (const pair of core.cs.ready()) for (const p of pair.paths) add(p, { cause: "fetch_owed" });
    local();
    for (const [p, why] of Object.entries(view.meta.pending)) {
      if (NOT_APPLICABLE.has(why)) add(p, { cause: "not_applicable", guard: NOT_APPLICABLE_GUARD[why] ?? why });
      else if ((this.deferredApplies.get(p) ?? 0) >= 2) add(p, { cause: "deferred", reason: why });
    }
    const heldBy = /* @__PURE__ */ new Map();
    for (const { r, guard } of waiting) {
      if (guard === void 0) continue;
      for (const p of r.paths) {
        if (!heldBy.has(p)) heldBy.set(p, guard);
        add(p, { cause: "blocked_publish", guard });
      }
    }
    const states = pushStatesOf(core, this.lastVersion ?? NO_VERSION);
    const pinned = pinnedPaths(core);
    for (const pair of core.cs.ready()) {
      const pin = pair.paths.find((p) => pinned.has(p));
      const why = states.length > 0 ? { cause: "blocked_publish", reason: blockReason ?? states[0] } : pin !== void 0 ? { cause: "blocked_publish", guard: heldBy.get(pin) ?? "pin" } : null;
      if (why !== null) for (const p of pair.paths) add(p, why);
    }
    if (publishTreeRefused(core) !== null) {
      for (const pair of core.cs.ready()) {
        if (!pair.paths.some((p) => pinned.has(p))) for (const p of pair.paths) add(p, { cause: "not_applicable", guard: "unmaterializable" });
      }
    }
    return out;
  }
  /** offline_for_s (01-engine §2, glossary §25.2 item 4): whole seconds of local Δmono since the last successful fetch — the one source of the status param and the OFFLINE log line. */
  offlineForS() {
    const since = this.core.fetcher.lastSuccessMono() ?? this.createdMono;
    return Math.floor(Math.max(0, this.core.deps.ports.clock.monoMs() - since) / 1e3);
  }
  /** INCIDENT's params (01-engine §2; the names of the INCIDENT log line): n, why, old and observed oids, displaced ref or kept_local. */
  incidentParams() {
    const view = this.core.view;
    const st = incidentStatus(this.core);
    const inc = view.meta.incident;
    return {
      n: st?.n ?? inc?.n ?? null,
      why: st?.why ?? null,
      old_board: view.laB,
      old_code: view.laC,
      new_board: inc?.observed_board ?? null,
      new_code: inc?.observed_code ?? null,
      displaced: st === null ? null : st.displaced === "kept_local" ? "kept_local" : st.ref
    };
  }
  statusInputs() {
    const core = this.core;
    const { deps } = core;
    const now = deps.ports.clock.monoMs();
    const view = core.view;
    const meta = view?.meta ?? null;
    const off = core.fetcher.offline();
    const lastOk = core.fetcher.lastSuccessMono();
    const gov = core.governor;
    let throttle = null;
    if (gov.mode() === "fallback") {
      const src = gov.fallbackSource();
      const left = gov.fallbackLeftMs();
      throttle = { source: src === "team" ? "team" : "own", untilMin: Math.ceil(left / 6e4), budget: gov.effective().B, fallbackLeftS: Math.ceil(left / 1e3), signal: src };
    }
    const v = this.lastVersion;
    const version = v === null ? null : v.proto ? { form: "proto", cause: null } : v.regionSpec ? { form: "regionSpec", cause: null } : v.checkpointMismatch ? { form: "regionSpec", cause: "checkpoint_mismatch" } : null;
    const unresolved = this.intentSince !== null && now - this.intentSince > INTENT_UNRESOLVED_MS;
    const nonTerminal = core.holds.nonTerminal();
    const counts = core.cs.counts();
    const fetchOwed = this.owed !== null && now - this.owed.sinceMono >= FETCH_OWED_MS;
    const offline2 = off.offline ? { label: "OFFLINE", explanation: OFFLINE_EXPLANATION, offlineForS: this.offlineForS() } : null;
    const nonretryable = meta !== null && meta.nonretryable !== null ? { holdId: meta.nonretryable.hold_id } : null;
    const blockReason = blockedPublishReason(meta?.freeze_reasons ?? [], publishPauseOf({ offline: offline2, nonretryable, version }));
    const notConverged = this.notConverged(unresolved, fetchOwed, blockReason);
    const pending = meta?.pending ?? {};
    const old = [...this.pendingSince].filter(([p, t]) => now - t >= PENDING_OLD_MS && Object.prototype.hasOwnProperty.call(pending, p)).map(([p]) => p).sort();
    return {
      refused: this.refused,
      down: this.down,
      freeze: meta?.freeze_reasons ?? [],
      offline: offline2,
      nonretryable,
      version,
      notConverged: [...notConverged.keys()],
      notConvergedCauses: notConverged,
      pendingOlderThan60s: old.length > 0,
      deferred: old.length > 0 ? { reason: String(pending[old[0]]), paths: old } : null,
      // The owed fetch is the headline when both apply: a kept push intent is resolved only after a fetch succeeded. A
      // publish_assert that reached no path (a board-only publish, final review FC-2) still makes the state degraded.
      notConvergedCause: fetchOwed ? "fetch_owed" : unresolved ? "push_unresolved" : this.publishAssert !== null && ![...notConverged.values()].some((w) => w.cause === "publish_assert") ? "publish_assert" : null,
      incident: meta !== null && meta.freeze_reasons.includes("INCIDENT") ? this.incidentParams() : null,
      throttle,
      branchRewritten: this.branch?.value ?? null,
      lastEvent: this.lastEvent,
      counts: {
        csReady: counts.ready,
        csOpen: counts.open,
        holdsActive: nonTerminal.filter((r) => !r.local_only).length,
        holdsLocalOnly: nonTerminal.filter((r) => r.local_only).length,
        incoming: meta === null ? 0 : Object.keys(meta.pending).length
      },
      branch: deps.branch,
      peerId: core.peerId,
      pluginVersion: deps.pluginVersion,
      heartbeatMs: deps.heartbeatMs(),
      loopPeriodMs: this.period,
      lastFetchAgeMs: lastOk === null ? null : now - lastOk,
      lastPushAgeMs: core.lastPushMono === null ? null : now - core.lastPushMono
    };
  }
  /** status.json on every iteration and transition (ENG-56); a failing write never stops the engine. */
  async writeStatus() {
    const s = computeStatus(this.statusInputs());
    this.lastStatus = s;
    try {
      await this.status.write(s);
    } catch (e) {
      if (e instanceof KilledAt) throw e;
      this.core.deps.log.write("warn", "STATUS_WRITE_FAILED", { code: errnoCode(e) ?? "unknown" });
    }
  }
  /** The status last written (null before the first write). */
  lastStatusJson() {
    return this.lastStatus;
  }
};
function runLoop(engine, d) {
  let stopping = false;
  let ended = false;
  let gen = 0;
  let running = false;
  let wakeWanted = false;
  let current = Promise.resolve();
  let resolveFinished;
  let rejectFinished;
  const finished = new Promise((res, rej) => {
    resolveFinished = res;
    rejectFinished = rej;
  });
  finished.catch(() => void 0);
  const end = (e) => {
    if (ended) return;
    ended = true;
    engine.setWake(null);
    if (e === void 0) resolveFinished();
    else rejectFinished(e);
  };
  const schedule = (delayMs) => {
    const g = ++gen;
    d.scheduler.schedule(() => tick(g), d.clock.monoMs() + Math.max(0, delayMs));
  };
  const idleExit = async () => {
    if (d.lease.idleMs() < LEASE_EXIT_MS) return false;
    await engine.drain("IDLE_NO_SESSION");
    end();
    return true;
  };
  const tick = async (g) => {
    if (g !== gen || stopping || ended) return;
    running = true;
    const run = (async () => {
      try {
        if (await idleExit()) return;
        const rep = await engine.iterate();
        if (stopping || ended) return;
        if (await idleExit()) return;
        if (wakeWanted) {
          wakeWanted = false;
          schedule(0);
        } else {
          schedule(rep.nextDueMs);
        }
      } catch (e) {
        end(e);
      } finally {
        running = false;
      }
    })();
    current = run;
    await run;
  };
  engine.setWake(() => {
    if (ended || stopping) return;
    if (running) wakeWanted = true;
    else schedule(0);
  });
  schedule(0);
  return {
    finished,
    async stop() {
      if (!ended) {
        stopping = true;
        await current;
        if (!ended) {
          try {
            await engine.drain(null);
            end();
          } catch (e) {
            end(e);
          }
        }
      }
      await finished;
    }
  };
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
    const value = source[name];
    if (value === void 0 || value.includes("\0") || !isUsableName(name)) continue;
    const upper = name.toUpperCase();
    if (isNever(upper) || FORCED_UPPER.has(upper)) continue;
    if (!isAllowlisted(upper) && !passUpper.has(upper)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(FORCED_ENV)) out[name] = value;
  return sortedCopy(out);
}

// src/git/runner.ts
import { spawn, spawnSync } from "node:child_process";
import { win32 as win322 } from "node:path";

// src/git/flags.ts
import { isAbsolute as isAbsolute3, posix, win32 } from "node:path";
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
function fail2(message) {
  throw new Error(`buildGitInvocation: ${message}`);
}
function checkConfigValue(what, value) {
  if (value.length === 0 || /[\0\r\n]/.test(value)) fail2(`invalid ${what} ${JSON.stringify(value)}`);
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
function checkAbsolute(what, value) {
  checkConfigValue(what, value);
  if (!isAbsolute3(value)) fail2(`${what} must be absolute, got ${JSON.stringify(value)}`);
}
function checkDriverName(d) {
  if (d.length === 0 || /[=\s\0]/.test(d)) fail2(`invalid filter driver name ${JSON.stringify(d)}`);
}
function checkIdentField(what, value) {
  if (value.trim().length === 0 || /[\0\r\n<>]/.test(value)) fail2(`invalid identity ${what} ${JSON.stringify(value)}`);
}
function setEnv(env, name, value) {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k !== name && k.toUpperCase() === upper) delete env[k];
  }
  env[name] = value;
}
function dropBlank(env, name) {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper && (env[k] ?? "").trim() === "") delete env[k];
  }
}
function getEnv(env, name) {
  const exact2 = env[name];
  if (exact2 !== void 0) return exact2;
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
  let word2 = "";
  let quote = "";
  for (; i < cmd.length; i++) {
    const ch = cmd.charAt(i);
    if (quote !== "") {
      if (ch === quote) quote = "";
      else word2 += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) break;
    word2 += ch;
  }
  return word2;
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
  for (const [name, value] of Object.entries(base.daemonEnv)) {
    if (!isNeverName(name)) env[name] = value;
  }
  if (opts.extraEnv !== void 0) {
    for (const name of Object.keys(opts.extraEnv).sort()) {
      const value = opts.extraEnv[name];
      if (value === void 0 || FORCED_UPPER2.has(name.toUpperCase()) || isNeverName(name)) continue;
      setEnv(env, name, value);
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
  for (const [name, value] of Object.entries(FORCED_ENV)) setEnv(env, name, value);
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
    fail2(`args[0] must be a git subcommand, got ${JSON.stringify(sub)}`);
  }
  if (!CLASSES.has(opts.class)) fail2(`unknown class ${JSON.stringify(opts.class)}`);
  checkConfigValue("hooksPath", base.hooksPath);
  if (!(base.platform === "win32" ? win32 : posix).isAbsolute(base.hooksPath)) fail2(`hooksPath must be absolute, got ${JSON.stringify(base.hooksPath)}`);
  if (base.sshCommand !== void 0 && /[\0\r\n]/.test(base.sshCommand)) {
    fail2(`invalid sshCommand ${JSON.stringify(base.sshCommand)}`);
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
    if (!OID.test(opts.attrTree)) fail2(`attrTree must be a 40- or 64-hex oid, got ${JSON.stringify(opts.attrTree)}`);
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
      const value = opts.config[key];
      if (key.length === 0 || /[=\s\0]/.test(key) || !key.includes(".")) fail2(`invalid config key ${JSON.stringify(key)}`);
      if (/[\0\r\n]/.test(value)) fail2(`invalid config value for ${key}`);
      if (isForcedKey(key)) fail2(`config key ${JSON.stringify(key)} is forced by the runner`);
      pre.push("-c", `${key}=${value}`);
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
function killTree(child, deps, systemRoot) {
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
    if (testCmd === void 0 && systemRoot === null) {
      killGit();
      return;
    }
    const cmd = testCmd ?? { file: win322.join(systemRoot, "System32", "taskkill.exe"), args: ["/PID", String(pid), "/T", "/F"] };
    const r = spawnSync(cmd.file, cmd.args, {
      ...systemRoot !== null ? { cwd: systemRoot } : {},
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
  const systemRoot = systemRootOf(deps.daemonEnv);
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
      const signal2 = neverKilled ? void 0 : opts.abort;
      const started = deps.clock.monoMs();
      return new Promise((resolve) => {
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
          killTree(child, deps, systemRoot);
        };
        const finish2 = (code, extraErr) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (grace) clearTimeout(grace);
          signal2?.removeEventListener("abort", onAbort);
          if (extraErr !== void 0) err.push(Buffer.from(extraErr, "utf8"));
          resolve({
            code,
            stdout: Buffer.concat(out),
            stderr: Buffer.concat(err),
            killedByWatchdog: killed,
            aborted,
            durationMs: deps.clock.monoMs() - started
          });
        };
        if (signal2?.aborted === true) {
          aborted = true;
          finish2(-1);
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
          finish2(-1, `spawn failed: ${e.message}`);
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
        proc.on("error", (e) => finish2(-1, `spawn failed: ${e.message}`));
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
            finish2(exitCode ?? -1);
          });
        };
        proc.on("exit", (code) => {
          exited = true;
          exitCode = code;
          grace = setTimeout(() => drain(chunks, 0), CLOSE_GRACE_MS);
        });
        proc.on("close", (code) => finish2(code ?? exitCode ?? -1));
        if (opts.stdin && proc.stdin) {
          proc.stdin.on("error", () => {
          });
          proc.stdin.end(opts.stdin);
        }
        if (limit !== null) {
          timer = setTimeout(() => {
            if (exited) return;
            killed = true;
            killTree(proc, deps, systemRoot);
          }, limit);
        }
        signal2?.addEventListener("abort", onAbort, { once: true });
      });
    }
  };
}

// src/git/version.ts
var GIT_FLOOR = Object.freeze({ major: 2, minor: 43, patch: 0, raw: "2.43.0" });
var PREFIX = "git version ";
var NUMBERS = /^(\d+)\.(\d+)(?:\.(\d+))?/;
function parseGitVersion(stdout) {
  const firstLine = (stdout.replace(/^\uFEFF/, "").trimStart().split(/\r?\n/)[0] ?? "").trim();
  if (!firstLine.startsWith(PREFIX)) {
    throw new Error(`parseGitVersion: unexpected output ${JSON.stringify(firstLine.slice(0, 80))}`);
  }
  const raw = firstLine.slice(PREFIX.length).trim();
  const m = NUMBERS.exec(raw);
  if (m === null || m[1] === void 0 || m[2] === void 0) {
    throw new Error(`parseGitVersion: no version number in ${JSON.stringify(raw.slice(0, 80))}`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === void 0 ? 0 : Number(m[3]),
    raw
  };
}
function meetsFloor(v) {
  if (v.major !== GIT_FLOOR.major) return v.major > GIT_FLOOR.major;
  if (v.minor !== GIT_FLOOR.minor) return v.minor > GIT_FLOOR.minor;
  return v.patch >= GIT_FLOOR.patch;
}

// src/ports/log.ts
function fileLog(fs, clock, file) {
  let tail = Promise.resolve();
  return {
    flush: () => tail,
    write(level, code, params) {
      const line = Buffer.from(
        JSON.stringify({ t: clock.wallMs(), level, code, params: params ?? {} }) + "\n",
        "utf8"
      );
      tail = tail.then(() => fs.appendFile(file, line)).catch(() => {
      });
    }
  };
}

// src/ports/scheduler.ts
var MAX_TIMER_MS = 2147483647;
function realScheduler(clock) {
  return {
    schedule(task, atMono) {
      const arm = () => {
        const remaining = atMono - clock.monoMs();
        if (remaining <= 0) {
          void Promise.resolve().then(task);
          return;
        }
        setTimeout(arm, Math.min(Math.ceil(remaining), MAX_TIMER_MS));
      };
      setImmediate(arm);
    },
    yieldPoint() {
      return new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
  };
}

// src/version.ts
var PLUGIN_VERSION = "0.1.1-preview";

// src/daemon/run.ts
var DAEMON_USAGE = [
  "usage: node dist/daemon.js run --repo <path> --branch <b> [--publish=all|none] [--name <display>] [--remote <name>]",
  "       node dist/daemon.js recover --repo <path> --branch <b> [--confirm=<id>] [--remote <name>]",
  "       node dist/daemon.js resume --repo <path> --branch <b> [--remote <name>]",
  "       node dist/daemon.js --version"
].join("\n");
var ALLOWED = {
  run: /* @__PURE__ */ new Set(["repo", "branch", "publish", "name", "remote"]),
  recover: /* @__PURE__ */ new Set(["repo", "branch", "confirm", "remote", "name"]),
  resume: /* @__PURE__ */ new Set(["repo", "branch", "remote", "name"])
};
var COMMANDS = /* @__PURE__ */ new Set(["run", "recover", "resume"]);
function branchNameOk(branch) {
  try {
    refNames(branch, RELEASE_NAMESPACE);
    return true;
  } catch (e) {
    return e instanceof EncTooLongError;
  }
}
function parseDaemonArgs(argv2) {
  const bad = (why) => ({ usage: `${why}
${DAEMON_USAGE}`, exitCode: 2 });
  if (argv2.length === 0 || argv2.includes("--help") || argv2.includes("-h")) return { usage: DAEMON_USAGE, exitCode: 0 };
  const cmd = argv2[0];
  if (!COMMANDS.has(cmd)) return bad(`unknown command ${JSON.stringify(cmd)}`);
  const opts = /* @__PURE__ */ new Map();
  for (let i = 1; i < argv2.length; i++) {
    const a = argv2[i];
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(a);
    if (m === null) return bad(`unexpected argument ${JSON.stringify(a)}`);
    const key = m[1];
    let value = m[2];
    if (value === void 0) {
      const next = argv2[i + 1];
      if (next === void 0 || next.startsWith("--")) return bad(`--${key} needs a value`);
      value = next;
      i++;
    }
    if (!ALLOWED[cmd].has(key)) return bad(`--${key} is not an option of ${cmd}`);
    if (opts.has(key)) return bad(`--${key} given twice`);
    if (value.length === 0 || /[\0\r\n]/.test(value)) return bad(`--${key} needs a value`);
    opts.set(key, value);
  }
  const repo = opts.get("repo");
  const branch = opts.get("branch");
  if (repo === void 0 || branch === void 0) return bad("--repo and --branch are required");
  if (!branchNameOk(branch)) return bad("--branch: not a branch name git accepts");
  const publish = opts.get("publish") ?? null;
  if (publish !== null && publish !== "all" && publish !== "none") return bad("--publish is all or none");
  const name = opts.get("name") ?? null;
  if (name !== null && !validName(name)) return bad("--name: letters, digits, spaces and _ . ' - only, at most 64");
  const confirm = opts.get("confirm") ?? null;
  if (confirm !== null && !/^[0-9a-f]{6}$/.test(confirm)) return bad("--confirm takes the 6-hex preview id");
  return { cmd, repo, branch, publish, name, remote: opts.get("remote") ?? null, confirm };
}
var sanitizeUrl2 = sanitizeUrl;
async function resolveRemote(repo, branch, explicit) {
  const remotes = /* @__PURE__ */ new Set();
  for (const { key } of await repo.configGetRegexp("^remote\\..+\\.url$")) remotes.add(key.slice("remote.".length, key.length - ".url".length));
  const setting = async (key) => {
    const v = await repo.configGet(key);
    return v === null || v.trim().length === 0 ? null : v.trim();
  };
  const name = await setting(`branch.${branch}.pushRemote`) ?? await setting("remote.pushDefault") ?? await setting(`branch.${branch}.remote`) ?? explicit ?? (remotes.size === 1 ? [...remotes][0] : null);
  if (name === null) return { refuse: "START_REMOTE", params: { reason: "no_remote" } };
  if (!remotes.has(name) || name.startsWith("-")) return { refuse: "START_REMOTE", params: { reason: "no_remote", remote: name } };
  const getUrl = async (push2) => {
    const r = await repo.run(["remote", "get-url", ...push2 ? ["--push"] : [], name], { okCodes: [0, 1, 2, 128] });
    const u = r.stdout.toString("utf8").trim();
    return r.code === 0 && u.length > 0 ? u : null;
  };
  const urlF = await getUrl(false);
  const urlP = await getUrl(true);
  if (urlF === null || urlP === null) return { refuse: "START_REMOTE", params: { reason: "no_remote", remote: name } };
  if (urlF !== urlP) return { refuse: "SEC_REFUSE_REMOTE_SPLIT", params: { remote: name, fetch_url: sanitizeUrl2(urlF), push_url: sanitizeUrl2(urlP) } };
  const literal = await repo.configGet(`remote.${name}.url`) ?? urlP;
  for (const { origin, key, value } of await rewriteRules(repo)) {
    if (value.length > 0 && (urlP.startsWith(value) || literal.startsWith(value))) {
      const shown = ruleKey(key);
      return {
        refuse: "SEC_REFUSE_URL_REWRITE",
        params: { remote: name, key: shown.key, key_redacted: shown.redacted, file: origin, prefix: sanitizeUrl2(value), url: sanitizeUrl2(literal) }
      };
    }
  }
  return { name, url: urlP };
}
async function rewriteRules(repo) {
  const r = await repo.run(["config", "--show-origin", "-z", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"], { okCodes: [0, 1] });
  if (r.code !== 0) return [];
  const parts = r.stdout.toString("utf8").split("\0");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i];
    const rec = parts[i + 1];
    const nl = rec.indexOf("\n");
    const file = origin.startsWith("file:") ? resolvePath(repo.paths.workTree, origin.slice("file:".length)) : origin;
    out.push(nl < 0 ? { origin: file, key: rec, value: "" } : { origin: file, key: rec.slice(0, nl), value: rec.slice(nl + 1) });
  }
  return out;
}
function ruleKey(key) {
  const m = /^url\.(.*)\.(insteadof|pushinsteadof)$/is.exec(key);
  if (m === null) return { key: sanitizeText(key), redacted: true };
  const base = m[1];
  const kind = userinfoKind(base);
  if (kind !== "secret") return { key, redacted: false };
  const clean = sanitizeUrl2(base);
  return { key: `url.${clean.includes("@") ? clean.slice(clean.lastIndexOf("@") + 1) : clean}.${m[2]}`, redacted: true };
}
var RESPAWN_LIMIT = 5;
var RESPAWN_WINDOW_MS = 6e5;
var RESPAWN_BASE_MS = 2e3;
var RESPAWN_MAX_MS = 6e4;
var RespawnBudget = class {
  clock;
  limit;
  crashes = [];
  constructor(clock, limit = RESPAWN_LIMIT) {
    this.clock = clock;
    this.limit = limit;
  }
  /** Records a crash now: the delay before its respawn, or null when the window holds the limit already (exit). */
  crash() {
    const now = this.clock.monoMs();
    this.crashes = this.crashes.filter((t) => now - t < RESPAWN_WINDOW_MS);
    if (this.crashes.length >= this.limit) return null;
    this.crashes.push(now);
    return Math.min(RESPAWN_MAX_MS, RESPAWN_BASE_MS * 2 ** (this.crashes.length - 1));
  }
  /** Crashes inside the window (the respawn about to run included). */
  inWindow() {
    return this.crashes.length;
  }
};
var POSIX_BARE = /^[A-Za-z0-9_./:@+=,-]+$/;
var WIN_BARE = /^[A-Za-z][A-Za-z0-9_./:\\=+-]*$/;
var WIN_UNQUOTABLE = /["%!$`“”„]/;
var CONTROL2 = /[\u0000-\u001f\u007f-\u009f]/;
function shellQuote(s, platform = process.platform) {
  if (s.length === 0 || CONTROL2.test(s)) return null;
  if (platform === "win32") {
    if (WIN_BARE.test(s)) return s;
    if (WIN_UNQUOTABLE.test(s)) return null;
    return `"${s.replace(/\\+$/, (run) => run + run)}"`;
  }
  if (POSIX_BARE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function word(s, what, platform = process.platform) {
  return shellQuote(s, platform) ?? `<${what}>`;
}
async function pluginSha() {
  try {
    return createHash6("sha256").update(await realFs.readFile(fileURLToPath(import.meta.url))).digest("hex");
  } catch {
    return createHash6("sha256").update(`cowork-sync ${PLUGIN_VERSION}`, "utf8").digest("hex");
  }
}
async function runDaemon(args, env, io) {
  const p = { out: (l, keep) => io.out(sanitizeText(l, keep)), err: (l) => io.err(sanitizeText(l)) };
  try {
    return await daemonMain(args, env, io, p);
  } catch (e) {
    p.err(`DAEMON_INTERNAL_ERROR ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return 2;
  }
}
function refusal(p, code, params, next, keep = []) {
  p.out(`${code} ${JSON.stringify(params)}`, keep);
  p.out(`next: ${next}`, keep);
  return 1;
}
async function daemonMain(args, env, io, p) {
  const fs = realFs;
  const self = selfCommand(args);
  const again = `fix the condition above, then: ${self(args.cmd)}`;
  let workTree;
  try {
    workTree = await fs.realpath(args.repo);
  } catch (e) {
    if (errnoCode(e) === "ENOENT" || errnoCode(e) === "ENOTDIR") return refusal(p, "START_REPO_SHAPE", { reason: "no_repo" }, again);
    throw e;
  }
  const gitDir = join14(workTree, ".git");
  if ((await fs.lstat(gitDir))?.isDirectory !== true) return refusal(p, "START_REPO_SHAPE", { reason: "not_a_main_worktree" }, again);
  const paths = { workTree, gitDir, coworkDir: join14(gitDir, "cowork") };
  try {
    refNames(args.branch, RELEASE_NAMESPACE);
  } catch (e) {
    if (e instanceof EncTooLongError) {
      const params = { reason: "too_long", other: null };
      return refusal(p, "START_BRANCH_NAME", params, startRefusalNext("START_BRANCH_NAME", params, args, ""));
    }
    p.err(`--branch: not a branch name git accepts
${DAEMON_USAGE}`);
    return 2;
  }
  const daemonEnv = buildDaemonEnv({ ...env }, []);
  const hooksPath = join14(paths.coworkDir, "empty-hooks");
  const probe = createGitRunner({ clock: realClock, hooksPath, daemonEnv });
  const v = await probe.run(["version"], { class: "local", cwd: workTree });
  const version = v.code === 0 ? parseGitVersion(v.stdout.toString("utf8")) : null;
  if (version === null || !meetsFloor(version)) {
    return refusal(p, "START_TOOL_VERSION", { git: version?.raw ?? null, floor: GIT_FLOOR.raw }, `install git ${GIT_FLOOR.raw} or newer, then: ${self(args.cmd)}`);
  }
  const userRepo = (runner) => {
    const ctx = () => ({ attrTree: null, filterDrivers: [], identity: { name: "cowork", email: "daemon@cowork.invalid" }, wallMs: () => realClock.wallMs() });
    return new GitRepo(runner, paths, ctx);
  };
  const config = userRepo(probe);
  const remote = await resolveRemote(config, args.branch, args.remote);
  if ("refuse" in remote) {
    const key = remote.params["key"];
    const keep = remote.refuse === "SEC_REFUSE_URL_REWRITE" && remote.params["key_redacted"] === false && typeof key === "string" ? [key] : [];
    return refusal(p, remote.refuse, remote.params, remoteRefusalNext(remote.refuse, remote.params, args), keep);
  }
  const sshCommand = await config.configGet("core.sshCommand");
  const userName = await config.configGet("user.name");
  const display = args.name ?? (userName !== null && validName(userName.trim()) ? userName.trim() : "cowork peer");
  const lock = await DaemonLock.acquire(fs, paths.coworkDir, { pluginVersion: PLUGIN_VERSION, instance: randomHex(realRandom, 16) });
  if (!(lock instanceof DaemonLock)) {
    const pid = lock.held?.pid ?? null;
    const file = join14(paths.coworkDir, DAEMON_LOCK_FILE);
    return refusal(p, "DAEMON_ALREADY_RUNNING", { pid }, `stop the daemon running on this clone${pid === null ? "" : ` (pid ${pid})`} — or, if none runs, delete ${word(file, "lock file")} — then: ${self(args.cmd)}`);
  }
  let log = null;
  try {
    await fs.mkdirp(join14(paths.coworkDir, "log"));
    log = fileLog(fs, realClock, join14(paths.coworkDir, "log", "daemon-0.jsonl"));
    const runner = createGitRunner({ clock: realClock, hooksPath, daemonEnv, ...sshCommand !== null ? { sshCommand } : {}, testBuild: false });
    const deps = {
      ports: { clock: realClock, random: realRandom, scheduler: realScheduler(realClock), fs, git: runner },
      trace: noTrace,
      log,
      lease: alwaysLeased,
      attribution: humanOnlyAttribution,
      heartbeatMs: machineMonoMs,
      paths,
      branch: args.branch,
      namespace: RELEASE_NAMESPACE,
      url: remote.url,
      display,
      pluginVersion: PLUGIN_VERSION,
      pluginSha: await pluginSha(),
      regionSpec: PLAN2_REGION_SPEC,
      platform: process.platform,
      testBuild: false,
      testMutants: /* @__PURE__ */ new Set()
    };
    log.write("info", "DAEMON_START", { cmd: args.cmd, pid: process.pid, git: version.raw });
    switch (args.cmd) {
      case "run":
        return await runCommand(args, deps, log, io, p, self);
      case "recover":
        return await recoverCommand(args, deps, p, self);
      case "resume":
        return await resumeCommand(deps, p, self);
    }
    throw new Error(`daemonMain: unknown command ${JSON.stringify(args.cmd)}`);
  } finally {
    try {
      await lock.release();
    } catch (e) {
      const code = errnoCode(e) ?? (e instanceof Error ? e.name : "unknown");
      log?.write("error", "DAEMON_LOCK_RELEASE_FAILED", { code });
      p.err(`DAEMON_LOCK_RELEASE_FAILED ${code} (the next run replaces ${word(lock.file, "lock file")})`);
    }
    await log?.flush();
  }
}
function selfCommand(args, platform = process.platform) {
  return (cmd, extra = "") => `node dist/daemon.js ${cmd} --repo ${word(args.repo, "repo path", platform)} --branch ${word(args.branch, "branch", platform)}${extra}`;
}
function remoteRefusalNext(refuse4, params, args, platform = process.platform) {
  const self = selfCommand(args, platform);
  if (refuse4 === "START_REMOTE") {
    return `${self(args.cmd, " --remote <name>")}, or name the branch's remote first: git config ${word(`branch.${args.branch}.remote`, "branch.name.remote", platform)} <name>`;
  }
  if (refuse4 === "SEC_REFUSE_REMOTE_SPLIT") {
    return `make the fetch and push URLs of the remote ${word(String(params["remote"]), "remote", platform)} equal (git remote -v shows both), then: ${self(args.cmd)}`;
  }
  const file = word(String(params["file"]), "config file", platform);
  const key = params["key_redacted"] === false ? shellQuote(String(params["key"]), platform) : null;
  if (key !== null) return `remove the rewrite rule: git config --file ${file} --unset-all ${key} — then: ${self(args.cmd)}`;
  return `remove the rewrite rule ${String(params["key"])} (its URL's userinfo is not shown) from the file: git config --file ${file} --edit — then: ${self(args.cmd)}`;
}
function startRefusalNext(code, params, args, url, platform = process.platform) {
  const self = selfCommand(args, platform);
  const branch = word(args.branch, "branch", platform);
  const remote = sanitizeUrl2(url);
  switch (code) {
    case "START_PREVIEW":
      return `${self("run", " --publish=all")} to share the local work, or ${self("run", " --publish=none")} to hold it`;
    case "START_HEAD_STATE":
      return `git switch ${branch} and finish or abort any operation in progress, then: ${self(args.cmd)}`;
    case "START_HEAD_BEHIND":
      return `git pull --ff-only — then: ${self(args.cmd)}`;
    case "START_HEAD_AHEAD":
      return `git push your commits to ${branch} first (base moves arrive in a later plan), then: ${self(args.cmd)}`;
    case "START_REMOTE":
      switch (params["reason"]) {
        case "local_ref_update":
          return `the remote answered, but a ref under .git/refs/cowork-remote could not be updated (another git process, or a stale .lock file there): check git for-each-ref refs/cowork-remote/ — then: ${self(args.cmd)}`;
        case "board_malformed":
          return `the cowork board of ${branch} on ${remote} is not one this plugin can read; a teammate whose cowork runs on ${branch} can run: node dist/daemon.js recover --repo <their clone> --branch ${branch}; then: ${self(args.cmd)}`;
        case "genesis_push_failed":
          return `the remote ${remote} refused cowork's first push (the refs/cowork/ board and code refs): check that you may push there, then: ${self(args.cmd)}`;
        default:
          return `check the network and the remote ${remote}, then: ${self(args.cmd)}`;
      }
    case "START_BRANCH_NOT_ON_REMOTE": {
      const name = typeof params["remote"] === "string" ? word(params["remote"], "remote", platform) : "<remote>";
      return `git push -u ${name} ${branch} — then: ${self(args.cmd)}`;
    }
    case "GENESIS_BOARD_MISSING":
      return `the cowork board of ${branch} is gone while its code is still there: a teammate whose cowork has state for ${branch} runs: node dist/daemon.js recover --repo <their clone> --branch ${branch}; then: ${self(args.cmd)}`;
    case "START_VERSION":
    case "START_STATE_NEWER":
      return `update cowork-sync (the ${code === "START_VERSION" ? "board" : "state"} was written by a newer plugin), then: ${self(args.cmd)}`;
    case "START_REPO_IDENTITY":
      return `this clone now points at a different repository; fix the remote (git remote -v shows it), then: ${self(args.cmd)}`;
    case "START_REFUSED_CUSTOM_REFS":
      return `the host refuses cowork's refs/cowork/ refs: allow them on the host, or set host.fallbackNamespace: true in .cowork/config.json (it creates refs/heads/cowork/* branches visible to CI), then: ${self(args.cmd)}`;
    case "START_REFUSED_NO_LEASE":
      return `the host does not enforce git push --force-with-lease, so cowork cannot publish there safely; use a host that does, then: ${self(args.cmd)}`;
    case "START_BRANCH_NAME": {
      const why = params["reason"] === "case_fold" && typeof params["other"] === "string" ? `the branch ${word(params["other"], "other branch", platform)} of this clone has cowork refs under the same name but for case` : "its encoded name is longer than 150 bytes";
      return `use a different branch name (${why}): git branch -m <new name> — then: node dist/daemon.js ${args.cmd} --repo ${word(args.repo, "repo path", platform)} --branch <new name>`;
    }
    case "START_REPO_SHAPE":
      if (params["reason"] === "tmp_volume") {
        return `keep this clone's .git directory on the same volume as its work tree (no .git link or mount to another drive: cowork renames files between .git/cowork/tmp and the work tree), then: ${self(args.cmd)}`;
      }
      return `fix the condition above, then: ${self(args.cmd)}`;
    default:
      return `fix the condition above, then: ${self(args.cmd)}`;
  }
}
var STOP_POLL_MS = 500;
function watchStopRequest(deps, onRequest) {
  const fs = deps.ports.fs;
  const file = join14(deps.paths.coworkDir, STOP_REQUEST_FILE);
  let active = true;
  let busy = false;
  const timer = setInterval(() => {
    if (!active || busy) return;
    busy = true;
    fs.lstat(file).then((st) => {
      if (active && st !== null) onRequest();
    }, () => void 0).finally(() => {
      busy = false;
    });
  }, STOP_POLL_MS);
  timer.unref();
  return {
    async stop() {
      active = false;
      clearInterval(timer);
      await fs.unlink(file).catch(() => void 0);
    }
  };
}
async function runCommand(args, deps, log, io, p, self) {
  let stopRequested = false;
  let stopNow = null;
  let wakeSleep = null;
  const requestStop = () => {
    stopRequested = true;
    stopNow?.();
    wakeSleep?.();
  };
  io.onStop(requestStop);
  await deps.ports.fs.unlink(join14(deps.paths.coworkDir, STOP_REQUEST_FILE)).catch(() => void 0);
  const watcher = watchStopRequest(deps, requestStop);
  try {
    return await runIterations(args, deps, log, p, () => stopRequested, {
      setStopNow: (f) => {
        stopNow = f;
      },
      setWakeSleep: (f) => {
        wakeSleep = f;
      }
    });
  } finally {
    await watcher.stop();
  }
}
async function runIterations(args, deps, log, p, stopRequestedNow, hooks) {
  const budget = new RespawnBudget(deps.ports.clock);
  let last = null;
  for (; ; ) {
    try {
      const engine = await Engine.create(deps);
      last = engine;
      const r = await engine.start({ publishLocal: args.publish });
      if (!r.ok) return refusal(p, r.code, r.params, startRefusalNext(r.code, r.params, args, deps.url));
      p.out(`started ${r.mode} on ${args.branch} as peer ${engine.peerId}`);
      const handle = runLoop(engine, { scheduler: deps.ports.scheduler, clock: deps.ports.clock, lease: deps.lease });
      const stopNow = () => void handle.stop().catch(() => void 0);
      hooks.setStopNow(stopNow);
      if (stopRequestedNow()) stopNow();
      await handle.finished;
      hooks.setStopNow(null);
      p.out(engine.lastStatusJson()?.message_code === "IDLE_NO_SESSION" ? "stopped: no session for 10 min (IDLE_NO_SESSION)" : "stopped");
      return 0;
    } catch (e) {
      hooks.setStopNow(null);
      if (e instanceof StateCasLostError || e instanceof RegistryCasLostError) {
        log.write("security", "STATE_CAS_LOST", { error: e.name });
        p.err(`STATE_CAS_LOST another writer moved this clone's cowork state; this daemon exits`);
        return 2;
      }
      if (e instanceof KilledAt || stopRequestedNow()) throw e;
      const delay2 = budget.crash();
      if (delay2 === null) throw e;
      log.write("error", "DAEMON_RESPAWN", { error: e instanceof Error ? e.name : "unknown", in_window: budget.inWindow(), delay_ms: delay2 });
      p.err(`DAEMON_RESPAWN ${e instanceof Error ? e.name : "error"} (restart ${budget.inWindow()} of ${RESPAWN_LIMIT} within ${RESPAWN_WINDOW_MS / 6e4} min)`);
      await new Promise((resolve) => {
        hooks.setWakeSleep(resolve);
        void deps.ports.clock.sleep(delay2).then(resolve);
      });
      hooks.setWakeSleep(null);
      if (stopRequestedNow()) {
        await drainAfterCrash(last, log);
        return 0;
      }
    }
  }
}
async function drainAfterCrash(engine, log) {
  if (engine === null) return;
  try {
    await engine.drain(null);
  } catch (e) {
    log.write("error", "DAEMON_DRAIN_FAILED", { error: e instanceof Error ? e.name : "unknown" });
  }
}
async function recoverCommand(args, deps, p, self) {
  const engine = await Engine.create(deps);
  try {
    if (engine.core.view === null) return refusal(p, "RECOVER_NOT_IN_INCIDENT", {}, `nothing to recover: ${self("run")}`);
    const r = await engine.start({ publishLocal: null });
    if (!r.ok) return refusal(p, r.code, r.params, startRefusalNext(r.code, r.params, args, deps.url));
    const rec = await engine.recover(args.confirm);
    if (!rec.ok) return refusal(p, rec.code, rec.params, `fix the condition above, then: ${self("recover")}`);
    const pv = rec.preview;
    const v = pv.V === ABSENT ? "ABSENT" : pv.V;
    if (!rec.done) {
      p.out(`RECOVER_PREVIEW mode=${pv.mode} id=${pv.id} board=${v} target=${pv.X ?? "none"} candidates=${pv.candidates.length} restart_records=${pv.restartPaths.length}`);
      for (const path of pv.restartPaths.slice(0, 50)) p.out(`  restart record: ${path}`);
      if (args.confirm !== null) p.out("the preview changed since the id was shown: review it again");
      p.out(`next: ${self("recover", ` --confirm=${pv.id}`)}`);
      return 0;
    }
    p.out(`RECOVERED mode=${pv.mode} board=${v} target=${pv.X ?? "none"}`);
    p.out(`next: ${self("run")}`);
    return 0;
  } finally {
    await engine.drain(null);
  }
}
async function resumeCommand(deps, p, self) {
  const engine = await Engine.create(deps);
  try {
    const changed = await engine.resumeAfterNonretryable();
    p.out(changed ? "RESUMED the next run retries the rejected publish once" : "RESUME_NOTHING no NONRETRYABLE pause on this branch");
    p.out(`next: ${self("run")}`);
    return 0;
  } finally {
    await engine.drain(null);
  }
}

// src/entry/daemon.ts
process.stdout.on("error", () => void 0);
process.stderr.on("error", () => void 0);
var argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write(`cowork-sync daemon ${PLUGIN_VERSION}
`);
} else if (argv.length === 0) {
  process.stderr.write(`${DAEMON_USAGE}
`);
} else {
  const parsed = parseDaemonArgs(argv);
  if ("usage" in parsed) {
    (parsed.exitCode === 0 ? process.stdout : process.stderr).write(`${parsed.usage}
`);
    process.exitCode = parsed.exitCode;
  } else {
    const io = {
      out: (line) => process.stdout.write(`${line}
`),
      err: (line) => process.stderr.write(`${line}
`),
      onStop: (cb) => {
        process.once("SIGINT", cb);
        process.once("SIGTERM", cb);
      }
    };
    const exit = (code) => {
      process.exitCode = code;
      process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
    };
    runDaemon(parsed, process.env, io).then(exit, (e) => {
      process.stderr.write(`DAEMON_INTERNAL_ERROR ${e instanceof Error ? e.name : "unknown"}
`);
      exit(2);
    });
  }
}
