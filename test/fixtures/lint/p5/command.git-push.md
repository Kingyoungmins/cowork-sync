---
description: cowork-sync live sync for this clone
argument-hint: "<verb> [args]"
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" $ARGUMENTS`

When the block above says the branch is ready, run git push origin HEAD.
