# TokenBuild

**Build More. Use Less.** TokenBuild cuts Claude Code token use with tools that run on your machine, and shows you what you saved.

## Install the Claude Code plugin

In Claude Code:

```
/plugin install tokenbuild --marketplace lidarstore/tokenbuild-plugin
```

On Claude Code older than 2.1.275, use two steps: `/plugin marketplace add lidarstore/tokenbuild-plugin`, then `/plugin install tokenbuild@tokenbuild`.

When asked, paste your CLI key from [app.tokenbuild.ai/billing](https://app.tokenbuild.ai/billing) (needs a trial or plan). Claude Code keeps it in your system's secure storage; change it later with `/plugin configure tokenbuild@tokenbuild`. Then run `/tokenbuild:setup` to check everything is on.

Prefer a terminal? `npx tokenbuild login <key>` once, then `npx tokenbuild init` in each project. The free audit needs no account: `npx tokenbuild audit`.

## What you get

| Tool | What it does |
| --- | --- |
| Context Ledger | Knows what's already in Claude's context: an unchanged re-read is answered from context, a changed one with only the changed lines |
| Verify Loop | After each edit, runs only the tests that edit can affect (import graph), in the background; one line back: pass, or the failing assertion |
| Task Brief | With each prompt: likely files with line numbers, the check to run, past failures fixed there; a vague prompt gets one question first |
| Next-Read | Learns which files you open after which, and gives Claude their outlines up front |
| Fingerprints | Remembers which files fixed each error; the next time it appears, Claude is pointed there (Team: shared as hashes and paths) |
| Task State | A live plan, files, checks, verified facts and open questions; new sessions and subagents resume from it, parallel agents claim items (`tb_task`) |
| Real Meter | Exact tokens and cost per task from Claude Code's own usage records, not estimates (`tokenbuild meter`) |
| Context Profiler | What fills the context window now, and how much is dead weight (`tokenbuild profile`, `tb_profile`) |
| Proof | ~10% of sessions run with one feature off; `tokenbuild proof` shows each feature's measured effect. Opt out: `"holdout": 0` |
| Anchor Edits | `tb_edit`: change lines Claude has read by line range, without writing the old text out again (output tokens cost the most) |
| Codemod Mode | `tb_apply`: one find/replace across many files; suggested when Claude repeats the same edit |
| Narration Meter | Tracks how much of Claude's writing is recap and asks for less when it's high |
| Edit Preflight | Syntax-checks an edit before it lands (JS, TS, JSON, Python); a broken edit is bounced back with the exact error |
| Local Docs Oracle | `tb_docs`: library declarations and docs at the installed version, from node_modules, Python or Go |
| Exploration Memo | `tb_memo`: saved answers about the repo, returned only while the files they rest on are unchanged |
| Permission Learner | Commands you approve every time become allow rules (`tokenbuild permissions --apply`) |
| Cache Keeper | After a long break on a big conversation, offers a fresh start before the expired prompt cache is rebuilt; counts cache rebuilds |
| Tool Diet | Measures each MCP server's tool definitions (sent every turn) against how often you use it (`tokenbuild diet`) |
| CLAUDE.md Compiler | Moves folder-only sections of CLAUDE.md into that folder, where Claude Code loads them on demand (`tokenbuild claudemd`) |
| Context GC | When most of a big conversation is dead weight, saves a clean note to restart from |
| Budget Forecast | Similar past tasks' median cost in the brief; a warning past twice that |
| Loop Breaker | Same failure three times, or Claude undoing its own edit: Claude is told what was tried and to change approach |
| Fresh Start | Past ~120K tokens, a handoff note is saved; `/clear` and the new session starts from it at about 2K tokens |
| Repo Memory | Learns which files tasks change and which change together; points similar tasks at them |
| Output Shrinker | `tokenbuild run npm test`: errors and summary only, same exit code, full log saved |
| Waste Guard | Blocks lockfiles, build output, huge whole-file reads and unchanged re-reads |
| Repo index | `tb_map`, `tb_find`, `tb_pack`, `tb_brief`: exact files and lines under a token budget |
| Scout agent | `tokenbuild:scout` does searches and log reading on a cheaper model (Haiku) |
| Auto-format | Your project's own formatter runs on edited files once per turn |
| Local Boost | Optional: a free local model (Ollama, this machine only) reads big files for Claude |

Commands: `/tokenbuild:setup`, `/tokenbuild:stats`, `/tokenbuild:audit` (free), `/tokenbuild:handoff`, `/tokenbuild:boost on|off`, `/tokenbuild:index`.

## What it runs, reads and sends

Your source code, file contents and prompts never leave your machine. TokenBuild never asks for or uses your Claude login.

- **Runs on your machine:** Node.js scripts in this plugin, started by Claude Code hooks (before and after tool calls, when you send a prompt, at the end of a turn, at session start and before compacting) and by a local MCP server. Each hook prints at most a short note into Claude's context, such as "this check failed the same way 3 times".
- **Runs your tests after edits:** the Verify Loop runs your project's own test runner (node --test, Vitest, Jest, pytest or go test, detected from your config) on the test files an edit can affect, in the background, with a 2-minute limit. Set `"verify": false` in `.tokenbuild/config.json` to turn it off, or set `"verify"` to your own command with `{files}`.
- **Reads Claude Code's session transcript locally** for the Real Meter, Context Profiler, Narration Meter, Cache Keeper and Exploration Memo. Usage counts go to your dashboard as totals; transcript text never leaves your machine.
- **Control groups:** about 10% of sessions run with one feature off so its effect can be measured. Set `"holdout": 0` in `.tokenbuild/config.json` to opt out.
- **Runs local tools you ask for:** `tokenbuild diet` starts your configured stdio MCP servers once to measure their tool lists; `tb_docs` for Python imports the module to read its docstring; Edit Preflight runs `node --check` or Python's parser on the edited file.
- **Runs commands only when asked:** `tokenbuild run <command>` runs the command Claude or you give it. At the end of a turn, auto-format runs the formatter your project already configures (Prettier, Ruff, gofmt and similar) on files Claude edited; set `"format": false` in `.tokenbuild/config.json` to turn it off.
- **Reads locally:** your project's files (to build the index), and Claude Code's own session logs in `~/.claude/projects` (for the audit, loop checks and handoff notes).
- **Writes locally:** `.tokenbuild/` in each project (index, memory, logs, handoff notes, savings ledger; it ignores itself in git), and `~/.tokenbuild/` (your CLI key, if you use `login`, and a cached plan status).
- **Sends to app.tokenbuild.ai:** your CLI key, to confirm your plan (at most twice a day, and when you run setup, `login` or `init`). Only when you run `tokenbuild sync`: daily counts per tool (no code, no file names) and, on Team plans, the paths of files edited together and how often, and error fingerprints (a one-way hash of a normalized error line) with the paths of the files that fixed them, so teammates' Repo Memory and Fingerprints can use them. Error text never leaves your machine.
- **Talks to localhost only:** Local Boost calls Ollama on this machine and refuses any other host.

Privacy policy: [tokenbuild.ai/privacy](https://www.tokenbuild.ai/privacy.html). Terms: [tokenbuild.ai/terms](https://www.tokenbuild.ai/terms.html).

## Requirements

Claude Code and Node.js 20 or later. The paid tools need an active TokenBuild trial or plan; without one they step aside and never break Claude Code.

## License

Proprietary. See [LICENSE](LICENSE). Copyright TokenBuild LLC.

[tokenbuild.ai](https://www.tokenbuild.ai) · [FAQ](https://www.tokenbuild.ai/faq.html) · support@tokenbuild.ai
