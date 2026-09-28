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

2. Ask. The agent asks you questions through push: yes or no, multiple choice, or free text. It waits for your answer. The bundled skill guides the agent to use Pushary for questions. Native VS Code question dialogs are not automatically intercepted.

3. Gate. Every named tool reaches your Pushary policy before execution, including terminal commands, file edits, patches, and MCP calls. Standing rules are evaluated before safe-command handling. The policy can approve, deny, or ask; cancellation stops the action. Pushary’s own MCP tools are exempt so answering cannot deadlock.

## Requirements

- VS Code with agent plugins enabled (`chat.plugins.enabled`). This setting can be managed by your organization.
- Node.js 20 or newer on your PATH. The gate runs as a `node` subprocess.
- A Pushary API key from https://pushary.com.

## Install

### Option 1: CLI (recommended)

This installs the plugin, registers it with VS Code, and links your API key. It also sets up Claude Code, Codex, Cursor, and Hermes if you use them.

```bash
npx pushary@latest setup
```

To configure only VS Code:

```bash
npx pushary@latest setup --agents vscode
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

The source plugin and CLI installer use the same decision service. The Mac app can install a native bridge that also carries queued messages back through supported hook responses.

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
| Hook | `hooks/hooks.json` and `scripts/pushary-gate.mjs` | Evaluates tool approvals and reports session/tool activity |
| Commands | `commands/` | `/pushary-test` and `/notify-when-done` |

## How the gate decides

VS Code currently ignores hook matchers, so the script sends every named tool to policy evaluation. Host aliases such as `run_in_terminal`, `create_file`, and `apply_patch` are normalized by the shared service; third-party `mcp_` IDs are retained because their server boundaries cannot safely be reconstructed from underscores.

Lifecycle hooks report session starts, turn completion, tool results, compaction, and subagent activity. Timeout approval requires the configured wait to have elapsed; cancellation or unverifiable withdrawal denies the action. Stable and Insiders registrations are supported locally. Remote hosts and additional profiles require their own installation.

## Failure behavior

Known read-only tools proceed when a missing API key or unavailable verdict prevents policy evaluation. Other tools fall back to `ask`, which hands the decision to VS Code's own approval prompt. A 55 second guard guarantees output before the hook's 60 second timeout.

## Cross-tool compatibility

This repository uses the `.claude-plugin/plugin.json` layout, which VS Code, GitHub Copilot CLI, and Claude Code all detect. That is also what makes `${CLAUDE_PLUGIN_ROOT}` available in `hooks/hooks.json`, which the Copilot-format layout does not define.

The layout is portable; this plugin is not meant to be. `hooks/hooks.json` uses VS Code's flat hook form, and the gate speaks VS Code's tool names, so treat this as a VS Code plugin that happens to sit in a portable folder shape.

Claude Code users are served by `npx pushary@latest setup --agents claude_code`, which installs a hook built for Claude Code's own tool names and matcher format. Do not install this directory as a Claude Code plugin as well: at best it duplicates the MCP server, and the two installs would fight over the same approvals.

## Development

`skills/pushary/SKILL.md` mirrors the Pushary skill that ships with the Pushary CLI (`pushary` on npm). Keep the two the same.

Test the gate without VS Code:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"runTerminalCommand","tool_input":{"command":"rm -rf build"},"cwd":"/tmp"}' \
  | node scripts/pushary-gate.mjs
```

## Security

This repository has no secrets. Your key is read at runtime from `PUSHARY_API_KEY`, the plugin `.mcp.json`, or `~/.pushary/config.json`. The gate script has no dependencies and only talks to pushary.com. Command text is redacted for common secret shapes before it is sent. Read `scripts/pushary-gate.mjs` to see exactly what it sends. See `SECURITY.md` for details.

## License

MIT. See `LICENSE`.
