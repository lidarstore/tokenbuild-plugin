---
name: rules
description: "TokenBuild's token-saving way of working. Use before running tests, builds, installs or linters, and when starting to explore or search this codebase."
---
- Run tests, builds, installs and linters as `tokenbuild run <command>` (for example `tokenbuild run npm test`). Same command and exit code; you get the errors and the summary, and the full log is saved.
- Start a task with the tb_pack tool (or tb_map); use tb_find before Grep or Glob.
- Read line ranges (offset/limit) of large files. Don't re-read files that haven't changed.
- Hand searches and log reading to the tokenbuild:scout agent; it runs on a cheaper model.
- If TokenBuild says a check failed the same way several times, stop and find the root cause instead of retrying.
