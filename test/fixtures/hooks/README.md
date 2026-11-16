# Host hook inputs (Plan 5 Task 1)

One plain host-shaped JSON object per hook event (and per gating variant), as Claude Code writes it to a hook's stdin. No spike 02
recording is in the repository (`spikes/02-claude-host/` keeps only its README and scripts), so each fixture is shaped after the spec
and the field names the spike scripts read (controller ruling P5-PF-7). Task 4's host check (R5-47) and Plan 7's nightly replace a field
spelling here if a real recording differs. `buildPayload`'s privacy test plants a canary in every free-text field of these inputs.

Common fields of every fixture: `session_id`, `transcript_path`, `cwd` (spike 02 `hook_env.js`, `hook_rec.js`: `ev.session_id`,
`ev.hook_event_name`, `ev.prompt_id`), `hook_event_name`, and `permission_mode` (06 §3.4.3 header field) where the event has one.

| Fixture | Source of its event-specific fields |
|---|---|
| `SessionStart.json` | `source` — glossary §13 matcher values; spike 02 `hook_env.js` (`ev.source`) |
| `UserPromptSubmit.json` | `prompt_id`, `prompt` — spike 02 `ups_q7.js` (`ev.prompt`), glossary §25 F2 |
| `UserPromptExpansion.json` | `expansion_type: "slash_command"`, `command_name`, `command_args`, `command_source` — spike 02 README q7c, `hook_rec.js`; glossary §25 F5; 09 §3.13 step 1 |
| `PreToolUse.Edit.json`, `PreToolUse.MultiEdit.json`, `PreToolUse.NotebookEdit.json` | `tool_name`, `tool_use_id`, `tool_input` edit fields (`file_path`/`notebook_path`, `old_string`, `new_string`, `replace_all`, `edits[]`, `cell_id`, `new_source`, `cell_type`, `edit_mode`) — 06 §3.4.1 step 3, §3.4.3; spike 02 `hook_q10.js` (`ev.tool_input.file_path`) |
| `PreToolUse.Bash.json` | `tool_input.command`, `run_in_background` — 06 §3.4.3; spike 02 `hook_rec.js` (`ev.tool_input.command`) |
| `PostToolUse.Edit.json`, `PostToolUse.Bash.json` | `tool_response` (Bash `stdout`/`stderr`) — 06 §3.4.3 (`exit_status` only when exposed: absent here) |
| `PostToolUse.Read.json` | `tool_input.offset`/`limit`, `tool_response.file.numLines` — A1-8 `HOST_FIELDS.readSize`; 06 §3.4.3 `read{…}` |
| `PostToolUseFailure.json`, `PermissionDenied.json` | `tool_name`, `tool_use_id`, `tool_input` — 06 §3.4.3; `error` text (never forwarded) |
| `PostToolBatch.json` | `tool_use_ids[]` — 06 §3.4.3 (field name assumed equal to the payload's) |
| `Stop.json`, `SubagentStop.json` | `stop_hook_active`, `last_assistant_message`, `background_tasks_running` — A1-8 `HOST_FIELDS`; 06 §3.4.3, §3.15, §8 Q7 (SubagentStop omits `background_tasks_running`: the default 0) |
| `StopFailure.json`, `SessionEnd.json` | `reason` — 06 §3.4.3 `reason?` |
| `SubagentStart.json` | `agent_id`, `agent_type` — 06 §3.4.3, §3.10 |
| `Notification.json` | `notification_type`, `message` — A1-8 `HOST_FIELDS.notificationType`; glossary §13 matcher values |
