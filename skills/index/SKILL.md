---
name: index
description: "Build or refresh TokenBuild's local index of this repo (symbols, files and imports) used by tb_map, tb_find and tb_pack."
disable-model-invocation: true
allowed-tools: Bash(node *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/tokenbuild.mjs" index`

Tell the user in one line how many files are indexed.
