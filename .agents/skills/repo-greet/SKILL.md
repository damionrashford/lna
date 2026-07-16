---
name: repo-greet
description: Prints a greeting and the sandbox host info by running its bundled script.
---

# Repo Greet

A demonstration skill loaded from the `lna` repo's `.agents/skills/` folder.

When asked to greet or identify the environment:
1. Run `scripts/greet.sh` with `exec_command`.
2. Report its output verbatim.

The script prints a greeting plus `uname -a`, proving a skill can carry runnable code (not just text).
