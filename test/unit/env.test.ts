import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDaemonEnv, FORCED_ENV } from '../../src/git/env.js';

test('FORCED_ENV is exactly the glossary §18 set and is frozen', () => {
  assert.deepEqual({ ...FORCED_ENV }, {
    LC_ALL: 'C',
    LANGUAGE: '',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
  });
  assert.ok(Object.isFrozen(FORCED_ENV));
});

// A Windows-shaped environment, written literally so the test runs the same on every OS.
const WIN_SOURCE: Record<string, string | undefined> = {
  Path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  USERPROFILE: 'C:\\Users\\홍길동',
  TEMP: 'C:\\Users\\홍길동\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\홍길동\\AppData\\Local\\Temp',
  APPDATA: 'C:\\Users\\홍길동\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\홍길동\\AppData\\Local',
  ProgramData: 'C:\\ProgramData',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Users\\홍길동',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  windir: 'C:\\Windows',
  SystemDrive: 'C:',
  COMPUTERNAME: 'DESKTOP-DEMO',
  USERNAME: '홍길동',
  OS: 'Windows_NT',
  GCM_PROVIDER: 'github',
  GCM_INTERACTIVE: 'always',
  HTTPS_PROXY: 'http://proxy.corp.example:8080',
  JAVA_HOME: 'C:\\jdk-21',
  CLAUDE_CODE_MESSAGING_TOKEN: 'tok-secret',
  CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\claude-inbox',
  CLAUDE_PROJECT_DIR: 'C:\\r',
  ELECTRON_RUN_AS_NODE: '1',
  VSCODE_PID: '4242',
  NODE_OPTIONS: '--inspect',
  GIT_DIR: 'C:\\elsewhere\\.git',
  GIT_INDEX_FILE: 'C:\\elsewhere\\index',
  GIT_ASKPASS: 'C:\\askpass.exe',
  SSH_ASKPASS: 'C:\\askpass.exe',
  GIT_TRACE2_EVENT: 'C:\\trace.json',
  GIT_CONFIG_PARAMETERS: "'core.hookspath'='C:\\evil'",
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: 'C:\\evil',
  GIT_AUTHOR_EMAIL: 'real.person@corp.example',
  GIT_COMMITTER_NAME: 'Real Person',
  GIT_EDITOR: 'code --wait',
  GIT_EXEC_PATH: 'C:\\evil\\libexec',
  '=C:': 'C:\\r',
  UNSET: undefined,
};

test('Windows-shaped source: allowlist by any case, source spelling kept, never-list dropped, forced on top', () => {
  const out = buildDaemonEnv(WIN_SOURCE, ['JAVA_HOME', 'GIT_DIR', 'claude_code_messaging_token', '=C:']);
  assert.deepEqual(out, {
    APPDATA: 'C:\\Users\\홍길동\\AppData\\Roaming',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    GCM_INTERACTIVE: 'never',
    GCM_PROVIDER: 'github',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\홍길동',
    HTTPS_PROXY: 'http://proxy.corp.example:8080',
    JAVA_HOME: 'C:\\jdk-21',
    LANGUAGE: '',
    LC_ALL: 'C',
    LOCALAPPDATA: 'C:\\Users\\홍길동\\AppData\\Local',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    Path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
    ProgramData: 'C:\\ProgramData',
    ProgramFiles: 'C:\\Program Files',
    SSH_ASKPASS_REQUIRE: 'never',
    SystemDrive: 'C:',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Users\\홍길동\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\홍길동\\AppData\\Local\\Temp',
    USERPROFILE: 'C:\\Users\\홍길동',
    windir: 'C:\\Windows',
  });
});

test('POSIX-shaped source: LC_*, XDG_*, proxies in both cases, ssh and git config transport survive', () => {
  const out = buildDaemonEnv(
    {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/hong',
      TMPDIR: '/tmp',
      LANG: 'ko_KR.UTF-8',
      LC_CTYPE: 'ko_KR.UTF-8',
      LC_ALL: 'ko_KR.UTF-8',
      LANGUAGE: 'ko',
      XDG_CONFIG_HOME: '/home/hong/.config',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.sock',
      SSH_AGENT_PID: '999',
      http_proxy: 'http://proxy:3128',
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost',
      ALL_PROXY: 'socks5://proxy:1080',
      GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work',
      GIT_CONFIG_GLOBAL: '/home/hong/.gitconfig-work',
      GIT_CONFIG_NOSYSTEM: '1',
      gcm_interactive: 'always',
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
      EDITOR: 'vim',
      USER: 'hong',
      GIT_WORK_TREE: '/elsewhere',
      GIT_NAMESPACE: 'ns',
      GIT_COMMON_DIR: '/elsewhere/.git',
      GIT_OBJECT_DIRECTORY: '/elsewhere/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/alt',
      GIT_EXTERNAL_DIFF: '/bin/evil-diff',
      NODE_PATH: '/opt/node_modules',
      GIT_TRACE: '1',
      GIT_TRACE_PACKET: '1',
      GIT_AUTHOR_NAME: 'Hong',
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00+09:00',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00+09:00',
    },
    [],
  );
  assert.deepEqual(out, {
    ALL_PROXY: 'socks5://proxy:1080',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_GLOBAL: '/home/hong/.gitconfig-work',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work',
    GIT_TERMINAL_PROMPT: '0',
    HOME: '/home/hong',
    HTTPS_PROXY: 'http://proxy:3128',
    LANG: 'ko_KR.UTF-8',
    LANGUAGE: '',
    LC_ALL: 'C',
    LC_CTYPE: 'ko_KR.UTF-8',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SSH_AGENT_PID: '999',
    SSH_ASKPASS_REQUIRE: 'never',
    SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.sock',
    TMPDIR: '/tmp',
    XDG_CONFIG_HOME: '/home/hong/.config',
    XDG_RUNTIME_DIR: '/run/user/1000',
    http_proxy: 'http://proxy:3128',
    no_proxy: 'localhost',
  });
});

test('09-security §7 item 2: session secrets and git redirections never survive, even when passed through', () => {
  const names = ['GIT_INDEX_FILE', 'GIT_DIR', 'CLAUDE_CODE_MESSAGING_TOKEN', 'NODE_OPTIONS', 'GIT_ASKPASS'];
  const source: Record<string, string> = { HTTPS_PROXY: 'http://p:1', SSH_AUTH_SOCK: '/tmp/agent' };
  for (const n of names) source[n] = 'x';
  const out = buildDaemonEnv(source, names);
  for (const n of names) assert.equal(out[n], undefined, n);
  assert.equal(out.HTTPS_PROXY, 'http://p:1');
  assert.equal(out.SSH_AUTH_SOCK, '/tmp/agent');
});

const NEVER_SAMPLES = [
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CONFIG_DIR',
  'ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK', 'NODE_OPTIONS', 'NODE_PATH', 'SSH_ASKPASS', 'GIT_ASKPASS',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_12', 'GIT_EXEC_PATH', 'GIT_TRACE', 'GIT_TRACE2_EVENT', 'GIT_TRACE_PACKET',
  'GIT_EXTERNAL_DIFF', 'GIT_EDITOR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
  // Final review: attribute source, replace refs, shallow file and the legacy config-file override.
  'GIT_ATTR_SOURCE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_SHALLOW_FILE', 'GIT_CONFIG',
  // Ruling P2-GRAFTS: the runner sets its own GIT_GRAFT_FILE (a path that never exists); a passed one would win.
  'GIT_GRAFT_FILE',
];

test('every never-list name is dropped in any case, even when passed through', () => {
  for (const name of NEVER_SAMPLES) {
    for (const spelled of [name, name.toLowerCase()]) {
      const out = buildDaemonEnv({ [spelled]: 'x', PATH: '/bin' }, [name, name.toLowerCase()]);
      const leaked = Object.keys(out).filter((k) => k.toUpperCase() === name);
      assert.deepEqual(leaked, [], spelled);
      assert.equal(out.PATH, '/bin');
    }
  }
});

const ALLOW_SAMPLES = [
  'PATH', 'Path', 'SystemRoot', 'ComSpec', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'TMPDIR', 'LANG',
  'LC_CTYPE', 'LC_MESSAGES', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramData', 'ProgramFiles',
  'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'WINDIR', 'windir', 'SYSTEMDRIVE', 'SystemDrive',
  'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  'GCM_PROVIDER', 'GCM_CREDENTIAL_STORE', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
  'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
];

test('every allowlisted name survives without passthrough, spelled as in the source', () => {
  for (const name of ALLOW_SAMPLES) {
    const out = buildDaemonEnv({ [name]: 'v' }, []);
    assert.equal(out[name], 'v', name);
  }
});

test('names outside the allowlist need passthrough (matched in any case)', () => {
  const source = { SHELL: '/bin/zsh', TERM: 'xterm', USER: 'hong', USERNAME: '홍길동', EDITOR: 'vim', 'ProgramFiles(x86)': 'C:\\x86', SECRET_FILTER_KEY_FILE: '/k' };
  const none = buildDaemonEnv(source, []);
  for (const k of Object.keys(source)) assert.equal(none[k], undefined, k);
  const some = buildDaemonEnv(source, ['secret_filter_key_file', 'USERNAME']);
  assert.equal(some.SECRET_FILTER_KEY_FILE, '/k');
  assert.equal(some.USERNAME, '홍길동');
  assert.equal(some.SHELL, undefined);
});

test('forced values replace every case variant of the same name', () => {
  const source = {
    LC_ALL: 'ko_KR.UTF-8',
    lc_all: 'x',
    LANGUAGE: 'ko',
    GCM_INTERACTIVE: 'always',
    gcm_interactive: 'always',
    GIT_TERMINAL_PROMPT: '1',
    Git_Optional_Locks: '1',
    SSH_ASKPASS_REQUIRE: 'force',
  };
  const out = buildDaemonEnv(source, Object.keys(source));
  assert.deepEqual(out, { ...FORCED_ENV });
});

test('undefined values, NUL bytes and names containing "=" are skipped', () => {
  const out = buildDaemonEnv({ PATH: '/bin\0/evil', HOME: undefined, '=C:': 'C:\\r', TMP: '/tmp' }, ['=C:']);
  assert.deepEqual(out, { ...FORCED_ENV, TMP: '/tmp' });
});

test('output keys are sorted by code unit and independent of source order', () => {
  const entries = Object.entries(WIN_SOURCE);
  const a = buildDaemonEnv(Object.fromEntries(entries), ['JAVA_HOME']);
  const b = buildDaemonEnv(Object.fromEntries(entries.slice().reverse()), ['JAVA_HOME']);
  assert.deepEqual(Object.keys(a), Object.keys(a).slice().sort());
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('buildDaemonEnv does not mutate its inputs', () => {
  const source = Object.freeze({ PATH: '/bin', GIT_DIR: '/x' });
  const passthrough = Object.freeze(['GIT_DIR']) as unknown as string[];
  buildDaemonEnv(source, passthrough);
  assert.deepEqual(source, { PATH: '/bin', GIT_DIR: '/x' });
  assert.deepEqual(passthrough, ['GIT_DIR']);
});
