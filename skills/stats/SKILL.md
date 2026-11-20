---
name: stats
description: "Show how many tokens TokenBuild has kept out of Claude's context in this repo, tool by tool."
disable-model-invocation: true
allowed-tools: Bash(node *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/tokenbuild.mjs" stats`

Show the user these numbers as they are, in a short code block, then one sentence on which tool saved the most.
