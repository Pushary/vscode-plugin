# Security

## Reporting a vulnerability

Email **security@pushary.com** with details and reproduction steps. Please do not open a public
issue for security reports. We aim to acknowledge within 72 hours.

## What this plugin sends

The plugin connects VS Code to the Pushary MCP server at `https://pushary.com/api/mcp/mcp` using
your API key. The key is read at runtime from the `PUSHARY_API_KEY` environment variable, the
plugin's `.mcp.json` (written by the CLI installer), or `~/.pushary/config.json`. No key is
committed to this repository.

The permission gate (`scripts/pushary-gate.mjs`) sends nothing for the overwhelming majority of
tool calls. It only contacts Pushary when the tool is a terminal tool **and** the command matches
`RISKY_COMMAND` in the script. For such a command it sends, over HTTPS to Pushary:

- the command text, with common secret shapes (API keys, bearer tokens, `password=`, long base64
  runs) redacted first,
- the basename of the working directory (for example `my-repo`, not the full path),
- an agent label (`VS Code - <project>`),
- the VS Code chat session id, so the dashboard kill switch and per-session mode can target this
  session,
- a machine id, which is the first 8 hex characters of a SHA-256 of your hostname and never the
  hostname itself.

It also fetches your permission policy and mode from `pushary.com`. The policy is cached in the
system temp directory for 5 minutes. The gate contacts no host other than `pushary.com`, has no
third-party dependencies, and writes only that policy cache to disk. The full source is in this
repository, so read it before installing.

## Failure behavior

Unlike the Cursor plugin, VS Code hooks have no `failClosed` option, so the gate cannot ask VS
Code to block a command on its behalf. It is built so that every handled failure degrades to
`permissionDecision: "ask"`, which forces VS Code's own approval prompt instead of allowing the
command:

- no API key, unreachable network, invalid policy, or an unparseable response: `ask`
- no answer from your phone within the window: `ask`, unless your policy's timeout action is
  explicitly `deny`
- kill switch active in your dashboard: `deny`
- anything that hangs: a 55 second guard emits `ask` before the 60 second hook timeout

The one case the gate cannot cover is a catastrophic crash before it produces any output, for
example Node.js missing from PATH. VS Code treats a non-zero exit with no decision as a
non-blocking warning and continues, at which point your normal VS Code terminal approval settings
apply. If you have auto-approve enabled for terminal commands in VS Code, that command would run
without a Pushary approval. Keep VS Code's own terminal approval on if that matters to you.

## Hook execution model

Hooks execute shell commands with the same permissions as VS Code. This one runs
`node scripts/pushary-gate.mjs` on every agent tool call. Review the script before installing, and
treat any plugin that registers hooks the same way.
