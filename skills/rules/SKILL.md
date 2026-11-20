---
name: rules
description: "TokenBuild's token-saving way of working. Use before running tests, builds, installs or linters, and when starting to explore or search this codebase."
---
- Run tests, builds, installs and linters as `tokenbuild run <command>` (for example `tokenbuild run npm test`). Same command and exit code; you get the errors and the summary, and the full log is saved.
- Start from the TokenBuild brief that arrives with each prompt (or call tb_brief / tb_pack); use tb_find before Grep or Glob.
- Read line ranges (offset/limit) of large files. If TokenBuild says lines are already in your context, or sends only the changed lines, use that instead of re-reading.
- After an edit, TokenBuild runs only the tests that change can affect and reports one line. Don't run the full suite to check a change; use tb_verify for a specific file.
- For parallel agents or a new session, read tb_task; claim a plan item before working on it and mark it done after.
- For a multi-line change to lines you've already read, use tb_edit (line range + new text; no old text to write out). For the same change across many files, use tb_apply.
- For how a library function works, use tb_docs (the installed version) instead of guessing or searching the web.
- Before exploring how something in this repo works, try tb_memo get; after working it out, tb_memo save the answer with the files it rests on.
- Keep replies short: don't restate tool results or recap what you just did.
- Hand searches and log reading to the tokenbuild:scout agent; it runs on a cheaper model.
- If TokenBuild says a check failed the same way several times, stop and find the root cause instead of retrying.
