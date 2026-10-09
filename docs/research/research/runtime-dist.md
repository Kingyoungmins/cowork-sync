# cowork-sync: runtime and packaging research (2026-10-01)

Sources are numbered and listed at the end. Version anchors: the Claude Code CHANGELOG head is **2.1.286** [10]. The local test PC runs CC **2.1.270** (npm install) on Windows 11 Pro build 26200, with Python 3.12.10, Node 24.21.0 and Git 2.55.0.

## 1. What shipped plugins use

**OBSERVED IN SOURCE.** I took a shallow clone of `anthropics/claude-plugins-official` at commit `ab024cd` (2026-09-30) [1].
- The marketplace has **315 entries**: 164 `url`, 98 `git-subdir` and 53 in-repo. Most entries are skills or remote HTTP MCP servers.
- In-repo stdio MCP servers (14 in `external_plugins`):
  - **bun** ×4: discord, telegram, imessage and fakechat, which are all channels.
  - **npx** ×2: playwright and firebase.
  - **uvx** ×1: serena.
  - php ×1 and docker ×1.
  - The other 5 are remote `http`.
- In-repo hooks (7 plugins):
  - bash/sh scripts.
  - `python3`: hookify calls it directly; security-guidance and claude-security go through sh shims.
  - One TypeScript "function hooks" module (code-modernization). It is early access and gated by `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. It does not appear in the docs index, so it is not usable for v1.
- Plugins already work around these Windows problems:
  - `sg-python.sh` [2] documents three. The Microsoft Store `python3` stub "exits 49 silently in non-TTY". Git Bash passes `/c/...` paths that break `python.exe` (#2043), which it fixes with `cygpath -w`. It also needs `PYTHONUTF8=1` because of cp1252.
  - superpowers 6.4.1 ships a polyglot `run-hook.cmd` that searches for `bash.exe` [3].
  - claude-mem, a popular plugin with a daemon, uses **node** for hooks and MCP, plus a **Bun** worker it installs itself, reached over HTTP. Its hooks are long bash one-liners that patch nvm and Homebrew directories into PATH [4]. Its Windows daemon issue #2659 (stale PID file, the npm bun shim found first on PATH, the worker exiting after init) was closed "not planned" [5].
- **DOCUMENTED** dependency handling [6]:
  - When Claude Code copies a plugin into the cache, it runs `npm ci --ignore-scripts` or `bun install --frozen-lockfile --ignore-scripts`, but only if both `package.json` and a lockfile are present.
  - The install has a **60 s timeout** and uses the package manager on the user's PATH.
  - Yarn and pnpm are skipped, and Python dependencies are never installed.

## 2. Which runtimes are guaranteed

**DOCUMENTED**
- The native installer has no prerequisites. The npm package needs Node 22+ (from v2.1.198), but "The installed `claude` binary does not itself invoke Node" [7]. **Node is not guaranteed.**
- Python is never mentioned as a requirement, so **Python is not guaranteed**. Git for Windows is optional. Without Git Bash, shell-form hooks run in PowerShell [7][8].
- The built-in Node that MCPB relies on ships with **Claude Desktop** ("Node.js ships with Claude for macOS and Windows"), not with the Claude Code CLI [9].

**OBSERVED (local)**
- `claude.exe` is a 227 MB Bun-compiled binary. With `BUN_BE_BUN=1` it still prints the Claude version, so the embedded Bun runtime is not exposed to plugins.
- On PATH, `python3` resolves to the WindowsApps Store stub.

**INFERRED.** Git is the only runtime our users are guaranteed to have, because the transport needs it.

## 3. Hook mechanics that change the latency question

**DOCUMENTED** [8][10]
- **Handler types:** `command`, `http` (2.1.63), `mcp_tool` (2.1.118), `prompt` and `agent`. All matching hooks run in parallel.
- **Timeouts:** the default is 600 s and `UserPromptSubmit` gets 30 s. **`SessionEnd` hooks share a 1.5 s budget**, which can be raised to at most 60 s.
- **Exec form `args` (2.1.139):** runs without a shell. On Windows, `command` must be a real `.exe`, and `.cmd` shims fail. The docs prescribe `"command": "node", "args": [...]` as the cross-platform pattern.
- **`if` field (2.1.85):** skips spawning a handler that won't match. `async` and `asyncRewake` run hooks in the background.
- **`mcp_tool` hooks:**
  - Fields are `server: "plugin:<plugin>:<server>"`, `tool`, and `input` with `${tool_input.file_path}` substitution.
  - The tool's text result is parsed the same way as command stdout, so `hookSpecificOutput` with `permissionDecision` is honored.
  - If the result has `isError` or the server isn't connected, the hook produces a **non-blocking error, so it fails open**.
  - These hooks are **skipped for `SessionStart` at launch and for `Setup`**.
- **`http` hooks:**
  - Environment interpolation applies only to `headers`, via `allowedEnvVars`.
  - A connection failure is non-blocking. The only way to deny is a 2xx response with a JSON body.
  - Managed settings can restrict them with `allowedHttpHookUrls`.
- `additionalContext` is capped at **10,000 chars**.

**OBSERVED (local).** Process spawn cost: Defender real-time protection on, Smart App Control off, 2 warmups then N=25, timed from a Python parent with JSON on stdin.

| Command | p50 |
|---|---|
| `hostname.exe` (stands in for a static binary) | 5.9 ms |
| `git --version` | 9.0 ms |
| `python -I -S -c pass` | 11.6 ms |
| Python hook (imports json, ast, socket; reads stdin) | 33.3 ms |
| `node -e 0` | 28.1 ms |
| Node hook (net, stdin JSON) | 31.5 ms |
| Git Bash `-c true` | 17.9 ms |
| Git Bash → python (shell form) | 38.0 ms |
| `powershell -NoProfile` | 88.4 ms |

Connect plus request plus response, from Python: **loopback TCP 0.10 ms, named pipe 0.04 ms**. IPC is about 100× cheaper than any process spawn.

**UNKNOWN**
- The first, cold run of a newly downloaded exe while Defender scans it. Test: time the first launch after download.
- The end-to-end overhead of an `mcp_tool` hook. Test: `claude --debug` hook timings.

**INFERRED.** An HTTP hook's `url` appears to be fixed text, which means a fixed port. That invites collisions and multi-user clashes, so `mcp_tool` is the better hot path.

## 4. Option comparison

| | (a) Python stdlib-only | (b) Node, single bundled JS | (c) Static binary (Go/Rust/Bun/Deno) |
|---|---|---|---|
| Install friction | Python ≥3.8 not guaranteed. Windows has the Store-stub trap; macOS CLT gives 3.9 [2]. `uvx` could auto-download Python [31], but uv itself must be installed. | Node not guaranteed. With an esbuild bundle and no lockfile, nothing to `npm install`. | Must be downloaded per OS on first run. Bun targets windows/linux/darwin × x64/arm64, plus musl [15]. Breaks behind proxies and when offline. |
| Hook spawn on Windows | about 33 ms | about 31 ms | about 6–9 ms |
| File watching | Nothing in the stdlib; watchdog is third-party. Alternatives: polling, ctypes `ReadDirectoryChangesW`, or git fsmonitor. | `fs.watch` recursive on Windows and macOS; on Linux since **v19.1.0** [13] | Go fsnotify has **no recursive watch** (roadmap #18) [16]. Rust `notify` supports recursive. |
| Detached daemon | `DETACHED_PROCESS`, `CREATE_BREAKAWAY_FROM_JOB`, `close_fds` (no handles inherited) [12] | Windows `detached: true` "will have its own console window"; use `windowsHide` [14b]. Node exposes no job-breakaway flag (INFERRED from the option list). | Full control |
| IPC | No `AF_UNIX` on Windows (OBSERVED, 3.12). `multiprocessing.connection` named pipes with HMAC `authkey` [23]. | `net` gives one API for Windows pipes and Unix sockets [14] | Native |
| MCP | No SDK without pip, so JSON-RPC must be written by hand | Official SDK; the channels examples are in TypeScript [25] | Varies by language |
| Antivirus, SmartScreen, Smart App Control | `python.exe` is signed (OBSERVED) | `node.exe` is signed by the OpenJS Foundation (OBSERVED) | Smart App Control blocks unsigned apps: "sign your app with a valid certificate" [17]. Go binaries draw antivirus false positives [18]. Bun binaries are large. |
| Contributors | The team's language, and `ast` gives exact Python function ranges | The common language for MCP and plugins | Needs a toolchain, release CI and signing certificates |

**Change detection that works in any runtime (DOCUMENTED).** Git's built-in fsmonitor daemon runs on Windows and macOS (since 2.36), and on **Linux since Git 2.55.0 (2026-06-29)** using inotify [19][20]. `git -c core.fsmonitor=true status` therefore watches files in any runtime and respects `.gitignore`.

**Function boundaries in Node (OBSERVED on npm, INFERRED for fit).** The `tree-sitter-python` 0.25.0, `tree-sitter-javascript` 0.25.0 and `tree-sitter-c-sharp` 0.23.5 packages ship `.wasm` grammars [32]. Together with `web-tree-sitter` 0.27.0 they could give exact function ranges for all three languages.
- **UNKNOWN:** whether the c-sharp grammar's ABI works with web-tree-sitter 0.27. Test: load each grammar and parse a sample file.
- Fallback: spawn `python -c` with `ast` when Python is present, or claim a line range.

## 5. IPC security and daemon lifecycle

**DOCUMENTED**
- The default named-pipe security descriptor gives full control to LocalSystem, administrators and the creator owner, and **read access to Everyone and the anonymous account**. Adding the logon SID to the DACL blocks remote and cross-session clients [21].
- Windows has supported `AF_UNIX` (`SOCK_STREAM`) since build 17063 [22]. Node still uses named pipes for path-based IPC on Windows [14].
- CPython creates its pipes with `FILE_FLAG_FIRST_PIPE_INSTANCE` and NULL security attributes, so they get the default DACL [23].

**OBSERVED IN ISSUES**
- #43123 (≥2.1.87): a background process that inherits a hook's stdout or stdin hangs the session [28].
- #96945 (open; 2.1.281, Windows 11): after a hook timeout, Claude Code kills the hook's process tree but keeps waiting for EOF on stdout. An orphan holding that pipe kept a 5 s-timeout hook running 43 s, and in real use **1.6–6.5 h** [29].

**UNKNOWN: does a detached daemon survive when `claude` exits on Windows?** #96945 mentions a "grandchild whose parent already exited, so a tree kill can't reach it". That suggests Claude Code kills by walking the process tree rather than through a Job Object (INFERRED). Test: spawn with `stdio: 'ignore', detached, windowsHide`, quit claude, then check `tasklist`.

**Pushing events into Claude**
- **Channels** are a research preview. A custom channel needs `--dangerously-load-development-channels` or a place on the allowlist. Team and Enterprise orgs must set `channelsEnabled`. They are not available on Bedrock, Vertex or Foundry [24][25]. **Not an option for v1.**
- **Plugin monitors** (2.1.105, experimental) turn each stdout line into a notification. Limits [6][26][27]:
  - interactive sessions only;
  - not available on Bedrock, Vertex or Foundry, or when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set;
  - not loaded for project-scope plugins;
  - a plugin update needs a session restart.
- **UNKNOWN:** the components page says a monitor runs "for the whole session". The Monitor tool page says every watch has a **5 min default, 30 min maximum** deadline. Test: run a plugin monitor that prints once a minute for 35 minutes.
- **Pull-based context always works:** `additionalContext` on PreToolUse, PostToolUse and UserPromptSubmit.

## 6. Recommendation

**Primary stack: TypeScript, bundled by esbuild into single-file JS for Node ≥20, with `dist/` committed and no runtime dependencies.** Three entry points:
- `mcp.js`: stdio MCP server, one per session. It answers the `mcp_tool` hook calls and starts or attaches to the daemon.
- `daemon.js`: one per user and repo. It runs the git sync loop, holds the board, and serves IPC.
- `hook.js`: used only for SessionStart.

Neither runtime is guaranteed, so the choice comes down to ecosystem fit, and Node wins there:
- the docs prescribe the exec-form `node` pattern;
- the MCP SDK and channels examples are TypeScript;
- most official stdio servers use node, bun or npx;
- recursive `fs.watch` works on all three OSes;
- one `net` API covers both pipes and Unix sockets.

**Delivery fallback:** the same source built with `bun build --compile` per OS, published in GitHub Releases with a pinned SHA-256, and downloaded only when `node` is missing. Being unsigned, it only helps when Node is missing and Smart App Control is off [17][18].

**Stack fallback, if the team rejects JavaScript:** Python ≥3.9, stdlib only:
- MCP JSON-RPC written by hand;
- `multiprocessing.connection` with `authkey` for IPC;
- git fsmonitor for change detection;
- interpreter discovery modelled on `sg-python.sh`, but run in exec form.

## Implications for cowork-sync

- **The hot path is `mcp_tool` hooks (≥2.1.118)** on PreToolUse `Edit|Write|MultiEdit|NotebookEdit`, PostToolUse, UserPromptSubmit and Stop. Per-edit latency is then IPC cost (under 1 ms) instead of a 30 ms spawn. Set `minimumVersion` guidance to 2.1.139 or later, because exec form needs it.
- **`mcp_tool` fails open.** If the server is disconnected, an edit goes ahead without a claim. Record unclaimed edits in PostToolUse and reconcile them. Verify once that a PreToolUse `deny` returned through `mcp_tool` is actually enforced, since the design depends on it.
- **SessionStart is the only required command hook**, because `mcp_tool` is skipped there. Use exec form `node` + `args` only, never shell form, which on Windows routes through Git Bash or PowerShell.
- **Release claims when the MCP server's stdin closes (EOF), not in SessionEnd.** SessionEnd has a 1.5 s budget and can be killed.
- **The daemon must never inherit hook or MCP stdio** (#43123, #96945). Spawn it with `stdio: 'ignore'`, `detached` and `windowsHide`, and test that it survives `claude` exiting.
- **Use the pipe or socket bind as the single-instance lock.** On Windows that is `FILE_FLAG_FIRST_PIPE_INSTANCE`; on Unix, EADDRINUSE plus a connect probe before unlinking a stale socket. Do not trust PID files (claude-mem #2659).
- **Authenticate every IPC request** with a token stored in `${CLAUDE_PLUGIN_DATA}` with user-only permissions, because the default pipe DACL grants Everyone read. Name the endpoint from a hash of user and repo root.
- **Keep nothing in `${CLAUDE_PLUGIN_ROOT}`.** It changes on every version, and old versions are swept 14 days after they are orphaned. The daemon should re-exec when the MCP handshake reports a newer version.
- **Avoid HTTP hooks:** a fixed port, `allowedHttpHookUrls` policy blocks, and failing open.
- **Use git fsmonitor (`-c core.fsmonitor=true`) for change detection**, with `fs.watch` only as a hint. This respects `.gitignore` and avoids Linux inotify limits in our own code.
- **Install at user scope from the marketplace, not project scope.** At project scope, monitors don't load, MCPB bundles are skipped, and every MCP server needs approval.
- **Don't rely on a top-level `bin/` for the human `live` CLI.** It is only on the Bash tool's PATH, and it blocks installation on claude.ai and Cowork. Ship `npx cowork-sync live …` or a slash command instead.
- **Real-time warnings in v1:** pull them through `additionalContext`, push them through a plugin monitor where available, and keep channels behind a feature flag.
- **Expect PATH problems** (nvm, volta, Store stubs). Resolve `node` once at SessionStart, cache its absolute path in `CLAUDE_PLUGIN_DATA`, and show a clear `systemMessage` if it is missing.
- **Ship no lockfile**, so Claude Code's automatic `npm ci` never runs and its 60 s timeout never applies.

## Sources
[1] https://github.com/anthropics/claude-plugins-official · [2] https://github.com/anthropics/claude-plugins-official/blob/main/plugins/security-guidance/hooks/sg-python.sh · [3] https://github.com/obra/superpowers · [4] https://github.com/thedotmack/claude-mem/blob/main/plugin/hooks/hooks.json · [5] https://github.com/thedotmack/claude-mem/issues/2659 · [6] https://code.claude.com/docs/en/plugins/loading · [7] https://code.claude.com/docs/en/setup · [8] https://code.claude.com/docs/en/hooks · [9] https://github.com/modelcontextprotocol/mcpb · [10] https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md · [11] https://code.claude.com/docs/en/plugins/manifest-reference · [12] https://docs.python.org/3/library/subprocess.html · [13] https://nodejs.org/api/fs.html#fswatchfilename-options-listener · [14] https://nodejs.org/api/net.html#identifying-paths-for-ipc-connections · [14b] https://nodejs.org/api/child_process.html#optionsdetached · [15] https://bun.com/docs/bundler/executables · [16] https://github.com/fsnotify/fsnotify · [17] https://support.microsoft.com/en-us/windows/smart-app-control-frequently-asked-questions-285ea03d-fa88-4d56-882e-6698afdb7003 · [18] https://go.dev/doc/faq#virus · [19] https://git-scm.com/docs/git-fsmonitor--daemon · [20] https://about.gitlab.com/blog/whats-new-in-git-2-55-0/ · [21] https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights · [22] https://devblogs.microsoft.com/commandline/af_unix-comes-to-windows/ · [23] https://github.com/python/cpython/blob/main/Lib/multiprocessing/connection.py · [24] https://code.claude.com/docs/en/channels · [25] https://code.claude.com/docs/en/channels-reference · [26] https://code.claude.com/docs/en/plugins/components · [27] https://code.claude.com/docs/en/tools-reference#monitor-tool · [28] https://github.com/anthropics/claude-code/issues/43123 · [29] https://github.com/anthropics/claude-code/issues/96945 · [30] https://code.claude.com/docs/en/mcp · [31] https://docs.astral.sh/uv/guides/install-python/ · [32] https://www.npmjs.com/package/tree-sitter-c-sharp (also tree-sitter-python, tree-sitter-javascript, web-tree-sitter)

Local benchmark scripts: `<scratchpad>\spawnbench.py` and `...\scratchpad\ipcbench.py`