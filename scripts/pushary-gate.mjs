#!/usr/bin/env node
// Pushary gate — VS Code `PreToolUse` agent hook.
//
// Routes risky terminal commands through your Pushary permission policy before
// they run. What HAPPENS to a matched command is decided by your dashboard
// policy (the same policy the @pushary/agent-hooks CLI uses for Claude Code), so
// behavior is consistent across agents.
//
// It honors, per tool ("Bash"): auto-approve, the four approval modes
// (push_only / push_first / notify_only / terminal_only), the timeout action
// (approve / deny / escalate), a live mode override, and the kill switch, all
// scoped to the VS Code chat session. Policy is cached in the temp dir for 5
// minutes with a stale-fallback, and requests retry.
//
// Self-contained: no dependencies, uses the global fetch (Node 18+).
//
// Contract (https://code.visualstudio.com/docs/agent-customization/hooks):
//   stdin  : { "hook_event_name": "PreToolUse", "tool_name": string,
//              "tool_input": object, "cwd": string, "session_id": string, ... }
//   stdout : { "continue": true }                                  (not our business)
//            { "hookSpecificOutput": { "hookEventName": "PreToolUse",
//                "permissionDecision": "allow" | "deny" | "ask",
//                "permissionDecisionReason"?: string } }
//
// `hookEventName` is redundant for VS Code but required by Claude Code, which
// can load this same plugin directory. Emitting it keeps one script valid for
// both.
//
// WHY THIS SCRIPT SELF-FILTERS: VS Code parses a hook's `matcher` but does not
// enforce it, so PreToolUse fires on EVERY tool call: reads, searches, edits.
// ../hooks/hooks.json therefore carries no matcher at all, because a matcher
// there would be inert and would only read as a guarantee it cannot make.
// RISKY_COMMAND below is the one and only gate, and the pass-through path must
// stay allocation-light and do no I/O, because it runs before every single tool
// the agent uses.
//
// Failure model: every handled path writes a decision and exits 0. Network and
// parse errors fall back to "ask" (VS Code's own prompt), so it never silently
// allows a risky command. A 55s hard guard guarantees output before the hook's
// 60s timeout fires.

import { createHash } from 'node:crypto'
import { homedir, hostname, tmpdir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = process.env.PUSHARY_BASE_URL?.trim() || process.env.PUSHARY_API_URL?.trim() || 'https://pushary.com'
const MCP_URL = `${BASE_URL}/api/mcp/mcp`
const POLICY_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_BLOCK_MS = 45_000 // longest we can wait inside VS Code's hook timeout
const WAIT_CHUNK_MS = 20_000 // per wait_for_answer long-poll
const POLL_GAP_MS = 1_500 // pause between polls after a transient error
const NET_TIMEOUT_MS = 27_000 // abort a single MCP request
const POLICY_TIMEOUT_MS = 10_000
const MODE_TIMEOUT_MS = 3_000
const HARD_GUARD_MS = 55_000 // force a graceful "ask" before the 60s hook timeout

// Which commands are worth a phone approval. This is the only place the set is
// defined; edit it here and nowhere else.
const RISKY_COMMAND =
  /\brm\b|\brmdir\b|\bunlink\b|\bmkfs|\bdd\b|\bshutdown\b|\breboot\b|\bpkill\b|\bkillall\b|\bsystemctl\b|--force\b|force-push|reset --hard|\brebase\b|\bdrop\b|\bDROP\b|\btruncate\b|\bTRUNCATE\b|delete from|DELETE FROM|\bdeploy\b|\bpublish\b|\brelease\b|\bmigrate\b/

// VS Code, Copilot CLI and Claude Code each name the terminal tool differently,
// and the name has changed across VS Code releases. Matching a normalized form
// of every spelling we have seen is what keeps the gate working after an upgrade
// renames the tool; an unknown name falls through to the fast pass-through,
// which is the safe direction (VS Code still shows its own prompt).
const TERMINAL_TOOLS = new Set([
  'runterminalcommand',
  'runinterminal',
  'runcommand',
  'terminalcommand',
  'executecommand',
  'runinterminalcommand',
  'bash',
  'shell',
  'terminal',
])

const normalizeToolName = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

// ── VS Code decisions ─────────────────────────────────────────────────────────
const PASS = { continue: true }
const decision = (permissionDecision, permissionDecisionReason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision,
    ...(permissionDecisionReason ? { permissionDecisionReason } : {}),
  },
})
const ALLOW = decision('allow')
const ask = (reason) => decision('ask', reason)
const deny = (reason) => decision('deny', reason)

let done = false
const respond = (result) => {
  if (done) return
  done = true
  process.stdout.write(JSON.stringify(result))
  process.exit(0)
}

// Always surfaced in VS Code's chat hooks output channel, so a silent
// fall-through to "ask" is explainable instead of a mystery.
const diag = (message) => {
  try {
    process.stderr.write(`[pushary-gate] ${message}\n`)
  } catch {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi)

const withRetry = async (fn, attempts) => {
  let lastError
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (i < attempts - 1) await sleep(300 * (i + 1))
    }
  }
  throw lastError
}

// A synchronous read of fd 0 survives launcher cases where the async stream
// yields nothing (seen with GUI-spawned hooks on Windows), so try it first and
// only stream as a fallback.
const readStdin = async () => {
  try {
    const sync = readFileSync(0, 'utf-8')
    if (sync && sync.trim()) return sync
  } catch {}
  try {
    let raw = ''
    process.stdin.setEncoding('utf-8')
    for await (const chunk of process.stdin) raw += chunk
    return raw
  } catch {
    return ''
  }
}

const getMachineId = () => createHash('sha256').update(hostname()).digest('hex').slice(0, 8)

// Env first. VS Code launched from Finder/Dock does not inherit a shell profile,
// so PUSHARY_API_KEY is frequently absent even when the user set it correctly.
// Fall back to the key the CLI installer embeds in the sibling .mcp.json, then
// to the key `pushary setup` writes to ~/.pushary/config.json.
// Deliberately looser than API_KEY_PATTERN in @pushary/contracts (which is hex
// only). This gate cannot import the workspace, so a strict copy here would
// silently stop finding the key the day the key alphabet widens, and the symptom
// would be "approvals stopped working" with no error. Matches the Cursor gate.
const KEY_SHAPE = /^pk_[a-z0-9]+\.[a-z0-9]+$/i

const resolveApiKey = () => {
  const fromEnv = process.env.PUSHARY_API_KEY?.trim()
  if (fromEnv) return fromEnv

  try {
    const mcpPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.mcp.json')
    const auth = JSON.parse(readFileSync(mcpPath, 'utf-8'))?.mcpServers?.pushary?.headers?.Authorization ?? ''
    const key = auth.replace(/^Bearer\s+/i, '').trim()
    if (KEY_SHAPE.test(key)) return key
  } catch {}

  try {
    const configPath = process.env.PUSHARY_CONFIG_FILE?.trim() || join(homedir(), '.pushary', 'config.json')
    const key = JSON.parse(readFileSync(configPath, 'utf-8'))?.apiKey
    if (typeof key === 'string' && key.trim()) return key.trim()
  } catch {}

  return undefined
}

// ── MCP transport (JSON or SSE) ───────────────────────────────────────────────
const parseMcpBody = (body, contentType) => {
  if (contentType && contentType.includes('text/event-stream')) {
    let last = null
    for (const frame of body.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim()
      if (!data) continue
      try {
        last = JSON.parse(data)
      } catch {}
    }
    if (!last) throw new Error('empty SSE response')
    return last
  }
  return JSON.parse(body)
}

const callTool = async (apiKey, name, args) => {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Pushary MCP ${response.status}`)
  const rpc = parseMcpBody(text, response.headers.get('content-type'))
  if (rpc.error) throw new Error(rpc.error.message || 'Pushary MCP error')
  const payload = rpc.result?.content?.[0]?.text
  if (!payload) throw new Error('empty Pushary response')
  return JSON.parse(payload)
}

const getJson = async (path, apiKey, timeoutMs) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`GET ${path} ${response.status}`)
  return response.json()
}

// ── Policy (mirrors @pushary/agent-hooks policy.ts) ───────────────────────────
const isPolicyConfig = (d) =>
  !!d && typeof d === 'object' && Array.isArray(d.policies) && typeof d.defaultTimeoutSeconds === 'number' && typeof d.defaultTimeoutAction === 'string'

const policyCacheFile = (apiKey) => join(tmpdir(), `pushary-policy-vscode-${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}.json`)

const getPolicy = async (apiKey) => {
  const path = policyCacheFile(apiKey)
  let stale = null
  if (existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, 'utf-8'))
      if (isPolicyConfig(cached)) {
        if (!cached._cachedAt || Date.now() - cached._cachedAt < POLICY_CACHE_TTL_MS) return cached
        stale = cached
      }
    } catch {}
  }
  try {
    const fresh = await withRetry(async () => {
      const raw = await getJson('/api/mcp/policy', apiKey, POLICY_TIMEOUT_MS)
      if (!isPolicyConfig(raw)) throw new Error('invalid policy')
      return raw
    }, 2)
    try {
      writeFileSync(path, JSON.stringify({ ...fresh, _cachedAt: Date.now() }), 'utf-8')
    } catch {}
    return fresh
  } catch (error) {
    if (stale) return stale
    throw error
  }
}

const resolvePolicy = (config, toolName, modeOverride) => {
  const base =
    config.policies.find((p) => p.tool === toolName) ??
    config.policies.find((p) => p.tool === '*') ??
    {
      tool: toolName,
      timeoutSeconds: config.defaultTimeoutSeconds,
      timeoutAction: config.defaultTimeoutAction,
      mode: config.defaultMode ?? 'push_first',
      pushFirstSeconds: config.defaultPushFirstSeconds ?? 20,
    }
  const effective = modeOverride ?? config.modeOverride
  return effective ? { ...base, mode: effective } : base
}

const APPROVAL_MODES = ['push_only', 'terminal_only', 'push_first', 'notify_only']
const fetchModeState = async (apiKey, sessionId) => {
  try {
    const path = sessionId ? `/api/mcp/mode?session=${encodeURIComponent(sessionId)}` : '/api/mcp/mode'
    const data = await getJson(path, apiKey, MODE_TIMEOUT_MS)
    const mode = data?.override?.mode
    return { mode: APPROVAL_MODES.includes(mode) ? mode : null, kill: data?.kill === true }
  } catch {
    return { mode: null, kill: false }
  }
}

// ── action body capture + redaction (inlined mirror of describe.ts, since this
// dependency-free hook cannot import the workspace) ───────────────────────────
const ACTION_BODY_MAX = 4000
const ACTION_BODY_TRUNCATION_MARKER = '\n… [truncated]'
// Two tiers, mirroring SECRET_REDACTION_RULES in @pushary/contracts. The precise
// rules only match real credential shapes, so they are safe on a line a human
// reads: a git SHA, a path and prose all survive. The high-entropy catch-all
// over-redacts by design and is therefore only ever applied to a full body dump.
//
// One combined list used to serve both, which meant the only text this gate
// scrubbed was the action body. The question and the notification body carried
// the raw command.
const REDACTION_RULES = [
  [/-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted key]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]'],
  [/\b[spr]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g, '[redacted]'],
  [/\bwhsec_[A-Za-z0-9]{16,}\b/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[redacted]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted]'],
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[redacted]'],
  [/\bxai-[A-Za-z0-9]{16,}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer [redacted]'],
  [/\bauthorization:\s*\S+/gi, 'authorization: [redacted]'],
  [/((?:secret|token|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
]
const HIGH_ENTROPY_RULE = [/[A-Za-z0-9+/]{40,}={0,2}/g, '[redacted]']
const redactSecrets = (text) => REDACTION_RULES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text)
const redactSecretsDeep = (text) => redactSecrets(text).replace(HIGH_ENTROPY_RULE[0], HIGH_ENTROPY_RULE[1])
const capActionBody = (text) =>
  text.length <= ACTION_BODY_MAX ? text : `${text.slice(0, ACTION_BODY_MAX - ACTION_BODY_TRUNCATION_MARKER.length)}${ACTION_BODY_TRUNCATION_MARKER}`
const deriveActionBody = (command) => capActionBody(redactSecretsDeep(command))

// VS Code's terminal tool has used more than one field name for the command, and
// a plain `tool_input` object is not guaranteed. Read the known spellings and
// treat anything else as "no command", which fast-passes.
export const extractCommand = (toolInput) => {
  if (!toolInput || typeof toolInput !== 'object') return ''
  for (const field of ['command', 'commandLine', 'command_line', 'cmd', 'script', 'input']) {
    const value = toolInput[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

// The single decision that keeps this hook cheap: does this tool call need the
// network at all? Exported so the test suite can assert the fast path directly.
export const shouldGate = (toolName, toolInput) => {
  if (typeof toolName !== 'string' || !TERMINAL_TOOLS.has(normalizeToolName(toolName))) return null
  const command = extractCommand(toolInput)
  if (!command || !RISKY_COMMAND.test(command)) return null
  return command
}

// ── network diagnosis ────────────────────────────────────────────────────────
//
// This gate is a dependency-free .mjs, so unlike the CLI it cannot install
// undici's EnvHttpProxyAgent and its fetch ignores HTTP_PROXY entirely. Node
// gained a native equivalent in 24 (NODE_USE_ENV_PROXY), but that is read at
// startup, so a script cannot switch it on for itself.
//
// The gate already fails safe: any error here hands the decision to the editor's
// own prompt. The cost is therefore not a blocked command, it is SILENCE. On a
// corporate network every approval quietly stops reaching the phone and the only
// trace is one stderr line nobody reads. So when a proxy is configured and the
// network call fails, say which of those two it is.
export const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

export const proxyConfigured = (env = process.env) =>
  PROXY_VARS.some(name => (env[name] ?? '').trim() !== '')

export const describeNetworkFailure = (error, env = process.env) => {
  const detail = error?.message ?? String(error)
  if (!proxyConfigured(env)) return detail
  const enabled = (env.NODE_USE_ENV_PROXY ?? '').trim() !== ''
  if (enabled) return detail
  return `${detail} (a proxy is set in HTTP_PROXY/HTTPS_PROXY and this hook cannot use it; on Node 24+ set NODE_USE_ENV_PROXY=1 in the editor's environment)`
}

// ── ask / wait ────────────────────────────────────────────────────────────────
// Redacted, not raw. This is the text a human reads on a lock screen and in
// Slack, and it used to be the command verbatim: `curl -H "Authorization:
// Bearer ..."` left the machine and landed in the question. The server scrubs
// this field too, but a credential should never travel to be scrubbed on
// arrival, and the notify body below was scrubbed nowhere at all.
const askArgs = (command, project, ident) => ({
  question: `Allow this command?\n\n${redactSecrets(command)}`,
  type: 'confirm',
  context: `VS Code agent wants to run this in ${project}`,
  agentName: ident.agentName,
  sessionId: ident.sessionId,
  machineId: ident.machineId,
  toolName: 'Bash',
  actionBody: deriveActionBody(command),
  wait: false,
})

const pollForAnswer = async (apiKey, correlationId, deadlineMs) => {
  while (Date.now() < deadlineMs) {
    const remaining = clamp(deadlineMs - Date.now(), 1_000, WAIT_CHUNK_MS)
    try {
      const answer = await callTool(apiKey, 'wait_for_answer', { correlationId, timeoutMs: remaining })
      if (answer?.answered) return answer
    } catch {
      if (Date.now() + POLL_GAP_MS >= deadlineMs) break
      await sleep(POLL_GAP_MS)
      continue
    }
    if (Date.now() + POLL_GAP_MS >= deadlineMs) break
    await sleep(POLL_GAP_MS)
  }
  return { answered: false }
}

const fromTimeoutAction = (action, deniedReason) =>
  action === 'approve' ? ALLOW : action === 'deny' ? deny(deniedReason) : ask()

const DENIED = 'The user denied this command via a Pushary push approval. Do not run it. Propose an alternative or ask how to proceed.'

// push_only: wait up to the policy timeout, then apply the timeout action.
const handlePushOnly = async (apiKey, command, project, ident, timeoutSeconds, timeoutAction) => {
  let asked
  try {
    asked = await withRetry(() => callTool(apiKey, 'ask_user', askArgs(command, project, ident)), 3)
  } catch {
    return fromTimeoutAction(timeoutAction, 'Push notification failed; denied per your Pushary policy.')
  }
  if (!asked?.correlationId) return ask()

  // Keyboard bypass: the user is at the keyboard, so VS Code's own prompt is the
  // faster channel.
  if (asked.suppressed) {
    await callTool(apiKey, 'cancel_question', { correlationId: asked.correlationId }).catch(() => {})
    return ask('You are at the keyboard, approve here.')
  }
  if (asked.noDevices) {
    return fromTimeoutAction(timeoutAction, 'No device connected to approve on; denied per your Pushary policy.')
  }

  const realMs = timeoutAction === 'wait' ? MAX_BLOCK_MS : Math.max(timeoutSeconds, 1) * 1000
  const cap = Math.min(realMs, MAX_BLOCK_MS)
  const answer = await pollForAnswer(apiKey, asked.correlationId, Date.now() + cap)
  if (answer.answered) {
    if (answer.value === 'defer') return ask()
    return answer.value === 'yes' ? ALLOW : deny(DENIED)
  }

  // If VS Code's hook limit cut us off before the configured timeout, hand off to
  // VS Code's own prompt rather than misapplying the policy's timeout action.
  if (cap >= realMs) return fromTimeoutAction(timeoutAction, 'No response within the approval timeout; denied per your Pushary policy.')
  return ask()
}

// push_first: race the push for a short window, then fall back to VS Code's prompt.
const handlePushFirst = async (apiKey, command, project, ident, pushFirstSeconds) => {
  let asked
  try {
    asked = await withRetry(() => callTool(apiKey, 'ask_user', askArgs(command, project, ident)), 3)
  } catch {
    return ask()
  }
  if (!asked?.correlationId) return ask()

  if (asked.suppressed) {
    await callTool(apiKey, 'cancel_question', { correlationId: asked.correlationId }).catch(() => {})
    return ask('You are at the keyboard, approve here.')
  }
  if (asked.noDevices) return ask('No device connected, approve here.')

  const cap = Math.min(Math.max(pushFirstSeconds, 1) * 1000, MAX_BLOCK_MS)
  const answer = await pollForAnswer(apiKey, asked.correlationId, Date.now() + cap)
  if (answer.answered) {
    if (answer.value === 'defer') return ask()
    return answer.value === 'yes' ? ALLOW : deny(DENIED)
  }
  return ask('Sent to your phone via Pushary, you can also approve here.')
}

// notify_only: fire an awareness notification, let VS Code's prompt decide.
const handleNotifyOnly = async (apiKey, command, project, ident) => {
  try {
    await callTool(apiKey, 'send_notification', {
      title: 'Agent needs approval',
      body: redactSecrets(command).slice(0, 180),
      agentName: ident.agentName,
      sessionId: ident.sessionId,
      machineId: ident.machineId,
    })
  } catch {}
  return ask()
}

const main = async () => {
  // Backstop: if anything hangs, return "ask" rather than letting the hook time
  // out and leave the agent with no decision at all. Scheduled here rather than
  // at module scope so importing this file for its helpers arms nothing.
  setTimeout(() => respond(ask()), HARD_GUARD_MS).unref()

  let input
  try {
    const raw = await readStdin()
    // No stdin at all is normal for a probe/dry run, and it is never a risky
    // command, so pass instead of dragging VS Code into a prompt.
    if (!raw.trim()) return respond(PASS)
    // Some launchers prepend a BOM or encoding prefix, which makes a bare
    // JSON.parse throw. The payload is always a JSON object, so parse from the
    // first "{".
    const jsonStart = raw.indexOf('{')
    input = JSON.parse(jsonStart > 0 ? raw.slice(jsonStart) : raw)
  } catch {
    diag('stdin was not valid JSON. Passing this tool call through to VS Code.')
    return respond(PASS)
  }

  // Fast path. This runs before every tool the agent uses, so it must stay free
  // of disk and network work.
  const command = shouldGate(input.tool_name, input.tool_input)
  if (!command) return respond(PASS)

  const apiKey = resolveApiKey()
  if (!apiKey) {
    diag('no API key found (PUSHARY_API_KEY, the plugin .mcp.json, or ~/.pushary/config.json). Run: npx @pushary/agent-hooks setup')
    return respond(
      ask('Pushary is not configured: run `npx @pushary/agent-hooks setup` (get a key at https://pushary.com) to route this approval to your phone.')
    )
  }

  const project = basename(input.cwd || process.cwd()) || 'workspace'
  const sessionId = typeof input.session_id === 'string' ? input.session_id : undefined
  const ident = { agentName: `VS Code - ${project}`, sessionId, machineId: getMachineId() }

  try {
    const [policy, modeState] = await Promise.all([getPolicy(apiKey), fetchModeState(apiKey, sessionId)])

    if (modeState.kill) return respond(deny('Stopped by user. This agent was halted from Pushary. Do not run this command.'))

    const tool = resolvePolicy(policy, 'Bash', modeState.mode)
    if (tool.timeoutSeconds === 0 && tool.timeoutAction === 'approve') return respond(ALLOW)

    switch (tool.mode) {
      case 'terminal_only':
        return respond(ask())
      case 'notify_only':
        return respond(await handleNotifyOnly(apiKey, command, project, ident))
      case 'push_only':
        return respond(await handlePushOnly(apiKey, command, project, ident, tool.timeoutSeconds, tool.timeoutAction))
      case 'push_first':
      default:
        return respond(await handlePushFirst(apiKey, command, project, ident, tool.pushFirstSeconds))
    }
  } catch (error) {
    diag(describeNetworkFailure(error))
    return respond(ask())
  }
}

// Importing this file for its testable helpers must not consume stdin or exit.
if (!process.env.PUSHARY_GATE_IMPORT) {
  main().catch((error) => {
    diag(`fatal: ${describeNetworkFailure(error)}`)
    respond(ask())
  })
}
