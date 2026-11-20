---
name: audit
description: "Free waste audit: price the token waste in your recent Claude Code sessions and show where it came from."
disable-model-invocation: true
allowed-tools: Bash(node *)
argument-hint: "[--days 30]"
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/tokenbuild.mjs" audit $ARGUMENTS`

Summarize the audit for the user in a few lines: the total, the top three sources of waste, and which TokenBuild tool addresses each.
