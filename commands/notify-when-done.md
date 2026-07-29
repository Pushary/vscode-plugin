---
name: notify-when-done
description: Send a Pushary push summarizing what changed when the current task finishes.
---

When you finish the current task, send a Pushary push notification so the user knows it's done, even if they have stepped away from the editor.

Call `send_notification` with:
- `title`: a short summary (under 60 chars) of what was completed
- `body`: one line on the outcome (under 200 chars)
- `agentName`: `"VS Code - {project}"`
- `context`: `{ type: "task_complete", summary, filesChanged, nextSteps }`

Send a single notification for the task. If the task fails instead, send `context.type: "error"` with `errorMessage` and the file where it failed.
