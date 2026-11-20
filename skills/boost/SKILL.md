---
name: boost
description: "Turn Local Boost on or off: a free local model (Ollama) reads big files and logs for Claude."
disable-model-invocation: true
allowed-tools: Bash(node *)
argument-hint: "[on|off]"
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/tokenbuild.mjs" boost $ARGUMENTS`

Relay the result to the user in one or two lines. If Ollama isn't running or no model is installed, give the exact install step from the output.
