---
name: pushary-test
description: Send a test Pushary push notification to confirm notifications are working.
---

Send a test push notification with the Pushary `send_notification` tool so the user can confirm delivery on their phone.

Call `send_notification` with:
- `title`: "Pushary test"
- `body`: "If you can read this on your phone, Pushary is working."
- `agentName`: `"VS Code - {project}"` (use the current project folder name)

Then tell the user it was sent and to check their device. If the call fails, report the error and remind them to set the `PUSHARY_API_KEY` environment variable and sign in at https://pushary.com.
