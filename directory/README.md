# TokenBuild for Claude Code (directory edition)

**Build More. Use Less.** Claude Code re-sends the whole conversation on every turn, so every extra file read, search result and test log costs tokens again and again. This edition of TokenBuild teaches Claude habits that keep context small.

## Skills

| Skill | What it does |
| --- | --- |
| `rules` | Loaded by Claude when it starts work, reads or searches files, or runs tests: read line ranges, skip lockfiles and build output, trim long command output, stop retrying the same failing check, delegate broad searches |
| `/tokenbuild:handoff` | Claude writes a short note of the goal, plan, changed files and failing checks to `.tokenbuild/handoff.md`; `/clear` and continue from it |
| `/tokenbuild:full` | Explains what the full TokenBuild plugin adds and how to install it |

## What it runs, reads and sends

This edition contains Markdown instructions only. It runs no code, starts no servers, adds no hooks, and sends nothing anywhere. The handoff skill asks Claude to write one file, `.tokenbuild/handoff.md`, in your project.

## The full TokenBuild plugin

The full plugin does the work automatically with local tools: Loop Breaker, Fresh Start, Repo Memory, Output Shrinker, Waste Guard, a repo index and a savings dashboard. It needs a trial or plan. Install one edition, not both:

```
npx tokenbuild install
```
One line, in your terminal (not inside Claude Code). It adds the marketplace, installs the plugin and asks for your CLI key. Inside Claude Code instead, send these as two separate messages: `/plugin marketplace add lidarstore/tokenbuild-plugin`, then `/plugin install tokenbuild@tokenbuild`.

Privacy: [tokenbuild.ai/privacy](https://www.tokenbuild.ai/privacy.html) · Terms: [tokenbuild.ai/terms](https://www.tokenbuild.ai/terms.html) · support@tokenbuild.ai

## License

Proprietary. See [LICENSE](LICENSE). Copyright TokenBuild LLC.
