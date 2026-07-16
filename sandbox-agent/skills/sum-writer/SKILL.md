---
name: sum-writer
description: How to write a computed sum into result.txt in the sandbox workspace.
---

# Sum Writer

When asked to record a sum:
1. Compute the total.
2. Use the shell (exec_command) to write the number into `result.txt` in the workspace root, e.g. `printf '%s' 59 > result.txt`.
3. The file must contain ONLY the integer, no extra text.
