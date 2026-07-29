<p align="center">
  <img src="assets/logo.png" alt="Pushary" width="72" height="72" />
</p>

<h1 align="center">Pushary for VS Code</h1>

<p align="center">A control panel for your AI agent. Get a push when work finishes, answer the agent from your phone, and approve risky commands before they run.</p>

---

## What it is

Pushary connects the VS Code agent to your phone. When the agent finishes a task, needs a decision, or is about to run something risky, it reaches you with a push notification. You answer from the lock screen and the agent keeps going. It works even when you have stepped away from your computer.

## What it does

There are three things.

1. Notify. The agent sends a push when a long task finishes, or when a build, test, or deploy fails. The push can include what changed, the error, and suggested next steps.

2. Ask. The agent asks you questions through push: yes or no, multiple choice, or free text. It waits for your answer. When Pushary is connected, the agent sends its questions to your phone instead of waiting in the chat panel.

3. Gate. Risky terminal commands (like rm, force push, history rewrites, database drops, deploys, and systemctl) are checked before they run. What happens is set by your Pushary dashboard policy: auto approve trusted commands, push to your phone for approval, or just notify. If you do not answer in time, it falls back to VS Code's own approval prompt, so nothing dangerous runs silently.

## Requirements

- VS Code with agent plugins enabled (`chat.plugins.enabled`). This setting can be managed by your organization.
- Node.js 20 or newer on your PATH. The gate runs as a `node` subprocess.
- A Pushary API key from https://pushary.com.

## Install

### Option 1: CLI (recommended)

This installs the plugin, registers it with VS Code, and links your API key. It also sets up Claude Code, Codex, Cursor, and Hermes if you use them.

```bash
npx @pushary/agent-hooks@latest setup
```

To configure only VS Code:

```bash
npx @pushary/agent-hooks@latest setup --agents vscode
```

### Option 2: Install from source

Run **Chat: Install Plugin From Source** from the Command Palette and enter:

```
https://github.com/Pushary/vscode-plugin
```

Then set your API key (see below).

### Option 3: Point VS Code at a local folder

Clone this repository, then add the absolute path to your VS Code `settings.json`:

```json
{
  "chat.pluginLocations": {
    "/absolute/path/to/vscode-plugin": true
  }
}
```

However you install it, Pushary talks to the same server, so the plugin and the CLI give you the same setup.

## Set your API key

The plugin reads your key from the `PUSHARY_API_KEY` environment variable, falling back to the key `pushary setup` writes to `~/.pushary/config.json`.

```bash
echo 'export PUSHARY_API_KEY="pk_xxx.sk_xxx"' >> ~/.zshrc
source ~/.zshrc
```

macOS and Windows do not pass your shell profile to apps launched from the Dock, Finder, or the Start menu, so an `export` in `.zshrc` is often invisible to VS Code. The `~/.pushary/config.json` fallback exists for exactly this case, which is why the CLI install is the recommended path.

Install the Pushary app on your phone (or turn on web push) so the agent can reach you.

## What is in the plugin

| Part | File | What it does |
|------|------|--------------|
| MCP server | `.mcp.json` | Connects VS Code to the Pushary tools: `send_notification`, `ask_user`, `wait_for_answer`, `cancel_question` |
| Skill | `skills/pushary/SKILL.md` | Full tool reference: parameters, examples, return values, and the proactive-use guidance |
| Hook | `hooks/hooks.json` and `scripts/pushary-gate.mjs` | Sends risky commands to your phone for approval |
| Commands | `commands/` | `/pushary-test` and `/notify-when-done` |

## How the gate decides

There are two layers.

1. `RISKY_COMMAND` in `scripts/pushary-gate.mjs` decides which commands get checked at all. Everything else passes straight through with no disk or network access.

2. Your Pushary dashboard policy decides what happens to a checked command, per tool: auto approve, the approval mode (push and wait, push then prompt, notify only, or prompt only), the timeout action, a live mode override, and the kill switch. This is the same policy your other Pushary agents use, so behavior stays the same across agents.

### Why the filtering lives in the script

VS Code parses a hook's `matcher` but does not enforce it, so `PreToolUse` fires on every tool call the agent makes, including reads and searches. The `matcher` in `hooks/hooks.json` is therefore documentation (and is enforced by Claude Code, which can load this same directory). The real gate is `RISKY_COMMAND` in the script. If you want to change which commands need approval, edit the regex in the script and keep the matcher in sync.

## Failure behavior

Every path returns a decision. Network errors, a missing API key, and unparseable input all fall back to `ask`, which hands the decision to VS Code's own approval prompt rather than allowing the command unapproved. A 55 second guard guarantees output before the hook's 60 second timeout.

## Cross-tool compatibility

This repository uses the `.claude-plugin/plugin.json` layout, which VS Code, GitHub Copilot CLI, and Claude Code all read. That is also what makes `${CLAUDE_PLUGIN_ROOT}` available in `hooks/hooks.json`, which the Copilot-format layout does not define.

If you already run Pushary in Claude Code through `npx @pushary/agent-hooks setup`, do not also install this directory as a Claude Code plugin. Both would gate the same command and you would get two pushes.

## Development

`skills/pushary/SKILL.md` mirrors the Pushary skill that ships with `@pushary/agent-hooks`. Keep the two the same.

Test the gate without VS Code:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"runTerminalCommand","tool_input":{"command":"rm -rf build"},"cwd":"/tmp"}' \
  | node scripts/pushary-gate.mjs
```

## Security

This repository has no secrets. Your key is read at runtime from `PUSHARY_API_KEY`, the plugin `.mcp.json`, or `~/.pushary/config.json`. The gate script has no dependencies and only talks to pushary.com. Command text is redacted for common secret shapes before it is sent. Read `scripts/pushary-gate.mjs` to see exactly what it sends. See `SECURITY.md` for details.

## License

MIT. See `LICENSE`.
