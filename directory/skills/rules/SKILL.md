---
name: rules
description: "TokenBuild's token-saving way of working in Claude Code. Use when starting work in a codebase, before reading or searching files, and before running tests, builds, installs or linters."
---
Every token in the conversation is re-sent on every turn, so keep context small:

1. **Read narrowly.** For files over ~300 lines, Read only the line range you need (offset/limit). Don't re-read a file you already read unless it changed.
2. **Search narrowly.** Point Grep and Glob at source folders. Never search or read `node_modules`, `dist`, `build`, `.git`, or lockfiles such as `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`.
3. **Trim command output.** Tests, builds, installs and linters print thousands of lines. Run them so you see the end and the errors, for example `npm test 2>&1 | tail -n 80`. Look further up only if the failure isn't visible.
4. **Break loops.** If the same check fails with the same error twice, stop editing. State what you tried, find the root cause, or ask the user, instead of retrying small variations. Don't undo and redo your own change.
5. **Delegate digging.** Hand broad searches and long-log reading to a subagent and ask it for file:line answers, not code dumps.
6. **Start fresh when it's long.** When the conversation is very long, suggest `/tokenbuild:handoff`, then `/clear`.
