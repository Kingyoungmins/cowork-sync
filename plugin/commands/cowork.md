---
description: cowork-sync live sync for this clone - start, status, stop, view or help
argument-hint: "start [--branch <b>] [--publish=all|none] | status | stop | view | help"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js":*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" $ARGUMENTS 2>&1`

Show the cowork-sync output above to the user exactly as printed, in a plain code block, and nothing else. Do not run any command, and do not add explanations or advice of your own.
