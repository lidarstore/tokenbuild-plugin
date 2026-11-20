---
name: handoff
description: "Save a handoff note for this conversation, so a fresh session can pick up where you are for far fewer tokens."
disable-model-invocation: true
allowed-tools: Bash(node *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/tokenbuild.mjs" handoff`

Tell the user the note is saved and that typing /clear now starts a fresh session from it.
