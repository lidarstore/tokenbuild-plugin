# TokenBuild for Claude Code

**Build More. Use Less.** TokenBuild cuts Claude Code token use with tools that run on your machine, and shows you what you saved.

## Install

In Claude Code:

```
/plugin install tokenbuild --marketplace lidarstore/tokenbuild-plugin
```

On Claude Code older than 2.1.275, use two steps:

```
/plugin marketplace add lidarstore/tokenbuild-plugin
/plugin install tokenbuild@tokenbuild
```

When asked, paste your CLI key from [app.tokenbuild.ai/billing](https://app.tokenbuild.ai/billing). It is kept in your system's secure storage. Then run `/tokenbuild:setup` to check everything is on.

## What you get

| | |
| --- | --- |
| Loop Breaker | Stops Claude retrying the same failing check or undoing its own edits |
| Fresh Start | Past ~120K tokens, saves a handoff note; `/clear` and carry on from about 2K |
| Repo Memory | Learns which files tasks change, so similar tasks start in the right place |
| Output Shrinker | `tokenbuild run npm test`: errors and summary only, full log saved |
| Waste Guard | Blocks lockfiles, build output and unchanged re-reads |
| Repo index | `tb_map`, `tb_find`, `tb_pack`: exact files and lines under a token budget |
| Scout agent | Searches and log reading on a cheaper model |
| Savings | `/tokenbuild:stats` shows tokens kept out of context, tool by tool |

Commands: `/tokenbuild:setup`, `/tokenbuild:stats`, `/tokenbuild:audit` (free), `/tokenbuild:handoff`, `/tokenbuild:boost on|off`, `/tokenbuild:index`.

Your code never leaves your machine. TokenBuild never asks for your Claude login. Needs Node 20+.

[tokenbuild.ai](https://www.tokenbuild.ai) · [FAQ](https://www.tokenbuild.ai/faq.html) · [Privacy](https://www.tokenbuild.ai/privacy.html) · support@tokenbuild.ai
