---
name: sum-writer
description: Compute a sum of integers and write only the total to result.txt in the workspace root.
---

# Sum Writer

When asked to record a sum:
1. Compute the total (e.g. `awk '{s+=$1} END{print s}' data/numbers.txt`).
2. Use the shell (`exec_command`) to write the number into `result.txt` in the workspace root, e.g. `printf '%s' 59 > result.txt`.
3. The file must contain ONLY the integer — no extra text or trailing newline.
