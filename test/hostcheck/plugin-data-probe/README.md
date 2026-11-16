# Host check: the plugin data directory (Plan 5 Task 4, A4-10, R5-47)

A throwaway plugin whose one SessionStart hook records, as the hook process sees them, `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`
(paths only). It pins the rule of `src/data/pluginDataDir.ts` (`pluginIdOf`: the derived data directory is named `<plugin>-<marketplace>`,
A1-12) and tells whether a hook sees `CLAUDE_PLUGIN_DATA` set. It is not a CI test and nothing here installs or runs it: installing it
changes the live Claude Code configuration of the machine, so the run waits for the owner (ruling P5-EC-8; the interim evidence is in the
Plan 5 ledger).

## Files

| File | Role |
|---|---|
| `.claude-plugin/plugin.json` | the plugin manifest (`name: plugin-data-probe`) |
| `hooks/hooks.json` | one SessionStart command hook in exec form: `node ${CLAUDE_PLUGIN_ROOT}/probe.mjs` |
| `probe.mjs` | writes `{"root": <CLAUDE_PLUGIN_ROOT or null>, "data": <CLAUDE_PLUGIN_DATA or null>}` to `<os tmpdir>/cowork-plugin-data-probe.json` |

## Run (owner, once, Claude Code ≥ 2.1.270 on Windows)

1. Make a local marketplace named `test-market`: a folder (say `C:\probe-market`) holding a copy of this directory as
   `plugin-data-probe\` and a file `.claude-plugin\marketplace.json`:

   ```json
   {"name": "test-market", "owner": {"name": "owner"}, "plugins": [{"name": "plugin-data-probe", "source": "./plugin-data-probe"}]}
   ```

2. In Claude Code: `/plugin marketplace add C:\probe-market`, then `/plugin install plugin-data-probe@test-market` (user scope), and start a
   new session in any folder (`claude`), so SessionStart fires once. Quit it.
3. Read `%TEMP%\cowork-plugin-data-probe.json` and list `%USERPROFILE%\.claude\plugins\data\`.
4. Uninstall: `/plugin uninstall plugin-data-probe@test-market`, `/plugin marketplace remove test-market`; delete the temp file.

## Record in the Plan 5 ledger

- the Claude Code version (`claude --version`);
- `root` exactly as written (expected shape `…\.claude\plugins\cache\test-market\plugin-data-probe\0.0.1`);
- `data` exactly as written, or `null`;
- the directory Claude Code created under `%USERPROFILE%\.claude\plugins\data\` (if any);
- the check: `pluginIdOf(root)` (expected `plugin-data-probe-test-market`) equals the basename of `data` when it is set, else the
  created directory's name. A mismatch amends A1-12 by a ledger ruling (one path rule in `src/data/pluginDataDir.ts` and the loader copy).
