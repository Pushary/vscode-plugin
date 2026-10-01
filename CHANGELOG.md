# Changelog

## 0.2.4

- Stop the gated action when a question is missing after withdrawal, instead of treating it as a timeout that can approve the action.

## 0.2.3

- Approval text never hides part of a command. The value after a credential name is hidden only up to the first space, quote or piece of shell syntax, so `echo "password=" && rm -rf ~` and `eval TOKEN="x; rm -rf ~"` both show the `rm`. A private key block is hidden only when it holds nothing but the key.
- Updates hands an approval back to VS Code promptly. The gate no longer waits for a phone answer that Updates never asks for, and it withdraws the phone question before VS Code asks. An answer that arrives in that moment still counts.
- With no phone or other notification channel connected, VS Code's prompt says "No device connected, approve here." instead of naming a delivery mode.
- Approval questions carry the repository and the tool name the gate judged, so routing and repository rules apply to the question as they did to the gate. A file edit is asked about with its full path, so path rules and routing match it. A path longer than 80 characters falls back to the file type instead of making the question fail.

## 0.2.2

- Classify local reads, searches, diagnostics, and terminal/task output inspection as reads under the shared policy.
- Let known read-only tools proceed when no verdict is available; keep the native prompt for other tools.

## 0.2.0

The gate stopped carrying its own copy of the policy engine, and two defects went
with it.

It matched rules on tool NAME alone, so every argument rule was invisible: a
`Bash(rm:*)` deny you had written did nothing here, and `rm -rf` was auto-approved
by a broad `Bash` allow. The same bug was found and fixed in the Cursor gate in
its 0.1.1; this copy still had it. It also had no safe read-only allowlist, so
`git status` reached your phone.

Its mode fetch read an unreachable server as "not halted", which is not the same
thing as "we could not ask". A remote stop that could not be fetched looked like
a clean bill of health.

The gate now asks the server, which runs the same engine as every other client
over the same state, and which distinguishes state it could not establish from
state that says no.

- Argument rules apply, with the same precedence every other agent uses.
- The destructive ceiling applies: a command the classifier flags can no longer
  be auto-approved through a broad rule.
- A policy change takes effect immediately; the on-disk policy cache is gone.
- An unreachable Pushary hands the command to VS Code's own prompt. Nothing is
  ever denied because we could not reach the server.

## 0.1.0

First release.

- `PreToolUse` permission gate for the VS Code agent, routing risky terminal commands to phone approval through your Pushary policy.
- Self-filtering gate script, because VS Code parses but does not enforce a hook `matcher`. Non-matching tool calls return without touching disk or network.
- MCP server wiring for `send_notification`, `ask_user`, `wait_for_answer`, and `cancel_question`.
- Pushary skill and the `/pushary-test` and `/notify-when-done` commands.
- API key resolution from `PUSHARY_API_KEY`, the plugin `.mcp.json`, or `~/.pushary/config.json`, so the plugin works when VS Code is launched from the Dock without a shell profile.
