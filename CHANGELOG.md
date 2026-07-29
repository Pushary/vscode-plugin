# Changelog

## 0.1.0

First release.

- `PreToolUse` permission gate for the VS Code agent, routing risky terminal commands to phone approval through your Pushary policy.
- Self-filtering gate script, because VS Code parses but does not enforce a hook `matcher`. Non-matching tool calls return without touching disk or network.
- MCP server wiring for `send_notification`, `ask_user`, `wait_for_answer`, and `cancel_question`.
- Pushary skill and the `/pushary-test` and `/notify-when-done` commands.
- API key resolution from `PUSHARY_API_KEY`, the plugin `.mcp.json`, or `~/.pushary/config.json`, so the plugin works when VS Code is launched from the Dock without a shell profile.
