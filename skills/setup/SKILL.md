---
name: setup
description: "Check that TokenBuild is ready in this project: your plan, which tools are on, and the one thing to do next."
disable-model-invocation: true
allowed-tools: Bash(node *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/tokenbuild.mjs" doctor --plugin`

Tell the user the result in a few short lines, keeping each ✓/✗ line. If there is a Next step, give it exactly. Never ask the user to paste their CLI key into this chat; it belongs in a terminal or the plugin's settings.
