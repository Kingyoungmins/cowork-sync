# Settings files (Plan 5 Task 4)

Claude Code settings for the static policy read and the install-scope check (06 §3.2, §3.11.6 item 3; 09 §3.14 item 2; SEC-28, SEC-29; R5-49).
`test/unit/claude.policy.test.ts` serves them from an in-memory Fs at the documented locations; `test/unit/claude.hookCore.test.ts` copies
the user, project and local files into a temp home and repo.

| File | Served as | Setting |
|---|---|---|
| `managed/managed-settings.json` | the platform's managed-settings.json | `disableAllHooks: true` |
| `managed/managed-settings.d/10-x.json` | `managed-settings.d/10-x.json` | `allowManagedHooksOnly: true` |
| `managed/managed-settings.d/20-strict.json` | `managed-settings.d/20-strict.json` | `strictKnownMarketplaces: []` (a strict marketplace key) |
| `managed/managed-settings.d/30-statusline.json` | `managed-settings.d/30-statusline.json` | a managed `statusLine` |
| `managed/managed-settings.d/40-unparseable.json` | `managed-settings.d/40-unparseable.json` | not JSON: no hit, no throw |
| `user/settings.json` | `<home>/.claude/settings.json` | `enabledPlugins` disabling `cowork-sync@test-market` (a user `statusLine` is no hit) |
| `project/settings.json` | `<repo>/.claude/settings.json` | `crossSessionInbound: "refuse"` |
| `project/settings.local.json` | `<repo>/.claude/settings.local.json` | `deniedMcpServers` naming `cowork` |
| `scope/enabled.json` | user, project or local settings | `enabledPlugins` enabling `cowork-sync@test-market` (install scope) |
