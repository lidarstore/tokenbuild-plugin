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
| Loop Breaker | Same failure three times, or Claude undoing its own edit: Claude is told what was tried and to change approach |
| Fresh Start | Past ~120K tokens, a handoff note is saved; `/clear` and the new session starts from it at about 2K tokens |
| Repo Memory | Learns which files tasks change and which change together; points similar tasks at them |
| Output Shrinker | `tokenbuild run npm test`: errors and summary only, same exit code, full log saved |
| Waste Guard | Blocks lockfiles, build output, huge whole-file reads and unchanged re-reads |
| Repo index | `tb_map`, `tb_find`, `tb_pack`: exact files and lines under a token budget |
| Scout agent | `tokenbuild:scout` does searches and log reading on a cheaper model (Haiku) |
| Auto-format | Your project's own formatter runs on edited files once per turn |
| Local Boost | Optional: a free local model (Ollama, this machine only) reads big files for Claude |

Commands: `/tokenbuild:setup`, `/tokenbuild:stats`, `/tokenbuild:audit` (free), `/tokenbuild:handoff`, `/tokenbuild:boost on|off`, `/tokenbuild:index`.

## What it runs, reads and sends

Your source code, file contents and prompts never leave your machine. TokenBuild never asks for or uses your Claude login.

- **Runs on your machine:** Node.js scripts in this plugin, started by Claude Code hooks (before and after tool calls, when you send a prompt, at the end of a turn, at session start and before compacting) and by a local MCP server. Each hook prints at most a short note into Claude's context, such as "this check failed the same way 3 times".
- **Runs commands only when asked:** `tokenbuild run <command>` runs the command Claude or you give it. At the end of a turn, auto-format runs the formatter your project already configures (Prettier, Ruff, gofmt and similar) on files Claude edited; set `"format": false` in `.tokenbuild/config.json` to turn it off.
- **Reads locally:** your project's files (to build the index), and Claude Code's own session logs in `~/.claude/projects` (for the audit, loop checks and handoff notes).
- **Writes locally:** `.tokenbuild/` in each project (index, memory, logs, handoff notes, savings ledger; it ignores itself in git), and `~/.tokenbuild/` (your CLI key, if you use `login`, and a cached plan status).
- **Sends to app.tokenbuild.ai:** your CLI key, to confirm your plan (at most twice a day, and when you run setup, `login` or `init`). Only when you run `tokenbuild sync`: daily counts per tool (no code, no file names) and, on Team plans, the paths of files edited together and how often, so teammates' Repo Memory can use them.
- **Talks to localhost only:** Local Boost calls Ollama on this machine and refuses any other host.

Privacy policy: [tokenbuild.ai/privacy](https://www.tokenbuild.ai/privacy.html). Terms: [tokenbuild.ai/terms](https://www.tokenbuild.ai/terms.html).

## Requirements

Claude Code and Node.js 20 or later. The paid tools need an active TokenBuild trial or plan; without one they step aside and never break Claude Code.

## License

Proprietary. See [LICENSE](LICENSE). Copyright TokenBuild LLC.

[tokenbuild.ai](https://www.tokenbuild.ai) · [FAQ](https://www.tokenbuild.ai/faq.html) · support@tokenbuild.ai
