---
name: handoff
description: "Write a short handoff note for this conversation so a fresh session can continue where you are for far fewer tokens."
disable-model-invocation: true
---
Write a handoff note to `.tokenbuild/handoff.md` in the project root (create the folder if needed). Keep it under about 1,500 tokens. Use these sections and only facts from this conversation:

- **Goal**: what the user wants, in one or two sentences.
- **Latest requests**: the user's last few asks, newest first.
- **Plan**: steps done and steps left.
- **Files changed**: paths only, one line each with what changed.
- **Checks**: which tests or builds pass or fail now, with the key error line.
- **Where it left off** and **Next**: the exact next step.

Then tell the user: the note is saved; type `/clear`, then say "Continue from .tokenbuild/handoff.md".
