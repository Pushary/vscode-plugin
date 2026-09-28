#!/usr/bin/env node
// Pushary VS Code hooks: server policy, fenced phone approvals, and lifecycle telemetry.
// Dependency-free for marketplace installs. Regenerate agent-hooks/data after edits.

import { createHash, randomUUID } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = process.env.PUSHARY_BASE_URL?.trim() || process.env.PUSHARY_API_URL?.trim() || 'https://pushary.com'
const MCP_URL = `${BASE_URL}/api/mcp/mcp`
const MAX_BLOCK_MS = 45_000 // longest we can wait inside VS Code's hook timeout
const WAIT_CHUNK_MS = 20_000 // per wait_for_answer long-poll
const POLL_GAP_MS = 1_500 // pause between polls after a transient error
const NET_TIMEOUT_MS = 27_000 // abort a single MCP request
const WITHDRAW_TIMEOUT_MS = 4_000
const HARD_GUARD_MS = 55_000 // force a graceful "ask" before the 60s hook timeout

// Which commands are worth a phone approval. This is the only place the set is
// defined; edit it here and nowhere else.
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

const READ_ONLY_TOOLS = new Set([
  'readfile', 'viewimage', 'listdir', 'listdirectory', 'filesearch', 'findfiles', 'grepsearch', 'findtextinfiles',
  'semanticsearch', 'searchcodebase', 'searchworkspacesymbols', 'geterrors', 'getchangedfiles', 'readprojectstructure',
  'getnotebooksummary', 'readnotebookcelloutput', 'testsearch', 'findtestfiles', 'testfailure', 'getvscodeapi',
  'getterminaloutput', 'gettaskoutput', 'terminalselection', 'terminallastcommand',
])

export const isReadOnlyTool = (toolName) =>
  typeof toolName === 'string' && READ_ONLY_TOOLS.has(normalizeToolName(toolName.replace(/^copilot_/, '')))

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
const unresolved = (toolName, reason) => (isReadOnlyTool(toolName) ? PASS : ask(reason))

let activeQuestion
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

const callTool = async (apiKey, name, args, timeoutMs = NET_TIMEOUT_MS) => {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Pushary MCP ${response.status}`)
  const rpc = parseMcpBody(text, response.headers.get('content-type'))
  if (rpc.error) throw new Error(rpc.error.message || 'Pushary MCP error')
  const payload = rpc.result?.content?.[0]?.text
  if (!payload) throw new Error('empty Pushary response')
  return JSON.parse(payload)
}

// ── The verdict ─────────────────────────────────────────────────────────────
// Asked for, not worked out here.
//
// The copy this replaces matched on tool NAME alone: it looked for a rule whose
// `tool` equalled "Bash", so every argument-scoped rule a user had written --
// `Bash(rm:*)`, `Bash(git push)` -- was skipped entirely and the broad rule or
// the default applied instead. A deny written to stop `rm -rf` did nothing here
// while it worked in Claude Code and Cursor, and it never gained
// `isSafeReadOnlyCommand` either, so `git status` reached the phone.
//
// Its mode fetch also read an unreachable server as `kill: false`, which is not
// "you are not halted" but "we could not ask". A remote stop nobody could fetch
// looked like a clean bill of health.
//
// The server now answers with the same `resolveGate` the CLI runs, over the same
// state, and it distinguishes state it could not establish from state that says
// no. This asks it.

const GATE_TIMEOUT_MS = 5000

/**
 * The verdict for one command, or null if we could not get one.
 *
 * Null is not a denial and not an approval: every failure hands the call back to
 * VS Code's own prompt, exactly as if this gate were not installed.
 *
 * Uses the VS Code policy profile and the same repository identity carried
 * by the later question. Tool aliases and targets are canonicalized server-side.
 */
const decide = async (apiKey, command, cwd, sessionId, ident = {}) => {
  try {
    const response = await fetch(`${BASE_URL}/api/agent/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        v: 1,
        source: 'vscode',
        toolName: ident.toolName ?? 'Bash',
        toolInputs: ident.toolInputs ?? [{ command }],
        repoKey: deriveRepoKey(cwd),
        cwd,
        sessionId,
      }),
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const verdict = await response.json()
    return verdict && typeof verdict.kind === 'string' ? verdict : null
  } catch {
    return null
  }
}

const REPO_KEY_MAX_LENGTH = 200
const MAX_PARENT_WALK = 64

const normalizeRepoRemote = (remoteUrl) => {
  const raw = (remoteUrl || '').trim()
  if (!raw) return undefined
  let hostAndPath
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):(.+)$/.exec(raw)
  if (scp) {
    hostAndPath = `${scp[1]}/${scp[2]}`
  } else {
    const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.+)$/.exec(raw)
    if (!url || /^file:/i.test(raw)) return undefined
    hostAndPath = url[1]
  }
  const slash = hostAndPath.indexOf('/')
  if (slash <= 0) return undefined
  const at = hostAndPath.slice(0, slash).lastIndexOf('@')
  // Credentials must never survive: a remote can carry a token and this value is
  // sent to the server and persisted.
  const host = (at === -1 ? hostAndPath.slice(0, slash) : hostAndPath.slice(at + 1, slash)).replace(/:\d+$/, '')
  const path = hostAndPath.slice(slash + 1).split('/').filter(Boolean).join('/')
  if (!host || !path) return undefined
  return `${host}/${path}`.replace(/\.git$/i, '').toLowerCase().slice(0, REPO_KEY_MAX_LENGTH)
}

const findGitDir = (startDir) => {
  let current = startDir
  for (let depth = 0; depth < MAX_PARENT_WALK; depth += 1) {
    const candidate = join(current, '.git')
    try {
      if (existsSync(candidate)) {
        const pointer = readFileSync(candidate, 'utf-8').trim()
        // A directory read throws EISDIR, which is the ordinary-clone case.
        if (pointer.startsWith('gitdir:')) {
          const target = pointer.slice('gitdir:'.length).trim()
          return target.startsWith('/') ? target : join(current, target)
        }
      }
    } catch (error) {
      if (error?.code === 'EISDIR') return candidate
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

const deriveRepoKey = (cwd) => {
  const override = process.env.PUSHARY_REPO_KEY
  if (typeof override === 'string') {
    const trimmed = override.trim()
    if (trimmed.toLowerCase() === 'off') return undefined
    if (trimmed) return trimmed.toLowerCase()
  }
  const dir = cwd || process.cwd()
  try {
    const gitDir = findGitDir(dir)
    if (gitDir) {
      // A worktree's config lives in the main git directory.
      const wt = gitDir.replace(/\\/g, '/').indexOf('/worktrees/')
      const configPath = wt === -1 ? join(gitDir, 'config') : join(gitDir.slice(0, wt), 'config')
      if (existsSync(configPath)) {
        let inOrigin = false
        for (const rawLine of readFileSync(configPath, 'utf-8').split('\n')) {
          const line = rawLine.trim()
          if (line.startsWith('[')) { inOrigin = /^\[remote "origin"\]/.test(line); continue }
          if (!inOrigin) continue
          const url = /^url\s*=\s*(.+)$/.exec(line)
          if (url) {
            const normalized = normalizeRepoRemote(url[1].trim())
            if (normalized) return normalized
          }
        }
      }
      const root = gitDir.endsWith('.git') ? dirname(gitDir) : dir
      return `local/${basename(root).toLowerCase()}`.slice(0, REPO_KEY_MAX_LENGTH)
    }
    return `local/${basename(dir).toLowerCase()}`.slice(0, REPO_KEY_MAX_LENGTH)
  } catch {
    return undefined
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
  [/-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----(?:\r?\n|(?:\\r)?\\n)?(?:(?:Proc-Type|DEK-Info): [A-Za-z0-9,-]+(?:\r?\n|(?:\\r)?\\n))*(?:[A-Za-z0-9+/=\r\n]|\\[rn])*?-----END[A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted key]'],
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
  [/\bauthorization:\s*(?:[A-Za-z0-9_\-./+=:@%^!#]|\\[^\s'"])+/gi, 'authorization: [redacted]'],
  [/((?:secret|token|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)["']?(?:[ \t]*:[ \t]*|[ \t]+=[ \t]*|=))(?:(")(?:[A-Za-z0-9_\-./+=:@%^!#]|\\[^\s'"])*"|(')[A-Za-z0-9_\-./+=:@%^!#\\]*'|(["']?)(?:[A-Za-z0-9_\-./+=:@%^!#]|\\[^\s'"])+)/gi, '$1$2$3$4[redacted]$2$3'],
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

// Every named tool reaches policy, as it does through the native bridge. A local
// allowlist would silently bypass new tools and user-authored standing denials.
export const shouldGate = (toolName, toolInput) => {
  if (typeof toolName !== 'string' || !toolName.trim() || toolName.startsWith('mcp__pushary__') || toolName.startsWith('mcp_pushary_')) return null
  if (TERMINAL_TOOLS.has(normalizeToolName(toolName))) {
    const command = extractCommand(toolInput)
    if (command) return command
  }
  return `${toolName}: ${JSON.stringify(toolInput ?? {})}`
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
// ask_user accepts a target of at most 80 characters (TOOL_TARGET_MAX_LENGTH in
// @pushary/contracts). A longer one fails the whole ask.
const TOOL_TARGET_MAX = 80

// A file change is routed and matched by its path, so the ask carries the path the
// gate judged, resolved against cwd the way the server resolves it. A path too long
// for ask_user is left out and the server's own target is used instead.
const filePathTarget = (path, cwd) => {
  if (typeof path !== 'string' || !path) return undefined
  const full = cwd && !isAbsolute(path) ? resolve(cwd, path) : path
  return full.length <= TOOL_TARGET_MAX ? full : undefined
}

// ask_user takes toolPath as an absolute POSIX path of at most 4096 characters and
// rejects the whole ask for anything else.
const TOOL_PATH_MAX = 4096

// The exact path, so routing and path rules still match a file whose path is too
// long for toolTarget. Sent only when it is an absolute POSIX path: a relative path
// with no absolute cwd, or a Windows path, is left out rather than failing the ask.
const filePathForAsk = (path, cwd) => {
  if (typeof path !== 'string' || !path) return undefined
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\')) return undefined
  const full = path.startsWith('/') ? path
    : typeof cwd === 'string' && cwd.startsWith('/') ? posix.resolve(cwd, path) : undefined
  return full && full.length <= TOOL_PATH_MAX ? full : undefined
}

// The canonical tool and target from a gate verdict, taken by name. Anything else a
// server adds to questionContext must never overwrite what this gate asks with.
const canonicalQuestion = (context) => ({
  toolName: typeof context?.toolName === 'string' && context.toolName ? context.toolName : undefined,
  toolTarget: typeof context?.toolTarget === 'string' && context.toolTarget ? context.toolTarget : undefined,
})

// ask_user caps scopePath at SCOPE_PATH_MAX_LENGTH and blocker at
// DECISION_LINE_MAX. The server derives a cwd-relative scope path that can be
// longer than 200, so an over-length value must be DROPPED rather than sent:
// ask_user rejects the whole call, this gate cannot parse the error, and the
// action fails closed. Dropping costs only the widening on approval.
const SCOPE_PATH_MAX = 200
const BLOCKER_MAX = 500

const withinCap = (value, cap) =>
  typeof value === 'string' && value && value.length <= cap ? value : undefined

/** The scope breach behind an ask, when the verdict says the ask exists for one. */
const scopeFromVerdict = (verdict) => ({
  scopePath: withinCap(verdict?.scopePath, SCOPE_PATH_MAX),
  scopeReason: withinCap(verdict?.scopeReason, BLOCKER_MAX),
})

// The tools the server targets by file (FILE_TARGET_TOOLS in @pushary/contracts).
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

// The same fields the server reads a VS Code file tool's path from.
const extractFilePath = (toolInput) => {
  if (!toolInput || typeof toolInput !== 'object') return undefined
  const path = toolInput.file_path ?? toolInput.filePath ?? toolInput.path
  return typeof path === 'string' && path ? path : undefined
}

const askArgs = (command, project, ident) => ({
  question: `Allow this action?\n\n${redactSecrets(command)}`,
  type: 'confirm',
  context: `VS Code agent wants to run this in ${project}`,
  agentName: ident.agentName,
  sessionId: ident.sessionId,
  machineId: ident.machineId,
  repoKey: ident.repoKey,
  toolName: ident.toolName ?? 'Bash',
  toolTarget: ident.toolTarget,
  ...(ident.toolPath ? { toolPath: ident.toolPath } : {}),
  // Carried from the verdict. Without scopePath the server cannot widen the
  // ratified contract when the user approves, so every further file in the same
  // area asks again; without the blocker the card never says that a boundary the
  // user personally agreed to is the reason for asking.
  ...(ident.scopePath ? { scopePath: ident.scopePath } : {}),
  ...(ident.scopeReason ? { blocker: ident.scopeReason } : {}),
  actionBody: deriveActionBody(command),
  wait: false,
  waitEndsAt: new Date(Date.now() + MAX_BLOCK_MS).toISOString(),
})

const pollForAnswer = async (apiKey, correlationId, deadlineMs) => {
  while (Date.now() < deadlineMs) {
    const remaining = clamp(deadlineMs - Date.now(), 1_000, WAIT_CHUNK_MS)
    try {
      const answer = await callTool(apiKey, 'wait_for_answer', { correlationId, timeoutMs: remaining })
      if (answer?.error) return STOPPED
      if (answer?.answered || stopped(answer) || (answer?.status && answer.status !== 'pending')) return answer
    } catch {
      return { answered: false, handoffAction: 'stop' }
    }
    await sleep(Math.min(POLL_GAP_MS, Math.max(0, deadlineMs - Date.now())))
  }
  return { answered: false }
}

const fromTimeoutAction = (action, deniedReason) =>
  action === 'approve' ? ALLOW : action === 'deny' ? deny(deniedReason) : ask()

const DENIED = 'The user denied this command via a Pushary push approval. Do not run it. Propose an alternative or ask how to proceed.'

const fromAnswer = (answer) => {
  activeQuestion = undefined
  if (answer.value === 'defer') return ask()
  return answer.value === 'yes' ? ALLOW : deny(DENIED)
}

const stopped = (result) => result?.handoffAction === 'stop'
  || ['cancelled', 'unavailable', 'stopped', 'missing'].includes(result?.status)
const STOPPED = { answered: false, handoffAction: 'stop' }
const STOP_REASON = 'This approval was cancelled or its state could not be verified. Do not run the action; wait for a new user instruction.'

const withdrawQuestion = async (apiKey, correlationId) => {
  try {
    const cancelled = await callTool(apiKey, 'cancel_question', { correlationId }, WITHDRAW_TIMEOUT_MS)
    if (stopped(cancelled)) return STOPPED
    if (cancelled?.cancelled === true) return { answered: false }
    const answer = await callTool(apiKey, 'wait_for_answer', { correlationId, timeoutMs: 1_000 }, WITHDRAW_TIMEOUT_MS)
    if (answer?.answered) return answer
    return ['expired', 'missing'].includes(answer?.status) ? { answered: false } : STOPPED
  } catch {
    return STOPPED
  } finally {
    activeQuestion = undefined
  }
}

const handedOff = (asked) => asked.suppressed || asked.status === 'terminal' || asked.status === 'notified'
  || asked.handoffAction === 'cancel_then_ask_in_current_client'

const handoffMessage = (asked) =>
  asked.suppressed ? 'You are at the keyboard, continue with the agent’s permissions.' : 'Continue with the agent’s permissions.'

// push_only: wait up to the policy timeout, then apply the timeout action.
const handlePushOnly = async (apiKey, command, project, ident, timeoutSeconds, timeoutAction) => {
  let asked
  const args = { ...askArgs(command, project, ident), requestId: randomUUID() }
  try {
    asked = await withRetry(() => callTool(apiKey, 'ask_user', args), 3)
  } catch {
    return deny('Pushary could not create a verifiable approval. Retry the action.')
  }
  if (stopped(asked)) return deny(STOP_REASON)
  if (asked?.answered) return fromAnswer(asked)
  if (!asked?.correlationId) return deny('Pushary did not return a verifiable approval.')
  activeQuestion = { apiKey, correlationId: asked.correlationId }

  // No device first. The server checks for a channel before any quiet mode, and
  // that reply carries the same handoffAction as a quiet handoff.
  if (asked.noDevices) {
    const late = await withdrawQuestion(apiKey, asked.correlationId)
    if (stopped(late)) return deny(STOP_REASON)
    if (late.answered) return fromAnswer(late)
    return ask('No device connected, approve here.')
  }
  // Keyboard bypass: the user is at the keyboard, so VS Code's own prompt is the
  // faster channel.
  if (handedOff(asked)) {
    const late = await withdrawQuestion(apiKey, asked.correlationId)
    if (stopped(late)) return deny(STOP_REASON)
    if (late.answered) return fromAnswer(late)
    return ask(handoffMessage(asked))
  }

  const realMs = timeoutAction === 'wait' ? MAX_BLOCK_MS : Math.max(timeoutSeconds, 1) * 1000
  const cap = Math.min(realMs, MAX_BLOCK_MS)
  const deadline = Date.now() + cap
  const answer = await pollForAnswer(apiKey, asked.correlationId, deadline)
  if (stopped(answer)) {
    await withdrawQuestion(apiKey, asked.correlationId)
    return deny(STOP_REASON)
  }
  if (answer.answered) return fromAnswer(answer)

  const late = await withdrawQuestion(apiKey, asked.correlationId)
  if (stopped(late)) return deny(STOP_REASON)
  if (late.answered) return fromAnswer(late)

  // If VS Code's hook limit cut us off before the configured timeout, hand off to
  // VS Code's own prompt rather than misapplying the policy's timeout action.
  if (cap >= realMs && Date.now() >= deadline) return fromTimeoutAction(timeoutAction, 'No response within the approval timeout; denied per your Pushary policy.')
  return ask()
}

// push_first: race the push for a short window, then fall back to VS Code's prompt.
const handlePushFirst = async (apiKey, command, project, ident, pushFirstSeconds) => {
  let asked
  const args = { ...askArgs(command, project, ident), requestId: randomUUID() }
  try {
    asked = await withRetry(() => callTool(apiKey, 'ask_user', args), 3)
  } catch {
    return deny('Pushary could not create a verifiable approval. Retry the action.')
  }
  if (stopped(asked)) return deny(STOP_REASON)
  if (asked?.answered) return fromAnswer(asked)
  if (!asked?.correlationId) return deny('Pushary did not return a verifiable approval.')
  activeQuestion = { apiKey, correlationId: asked.correlationId }

  if (asked.noDevices) {
    const late = await withdrawQuestion(apiKey, asked.correlationId)
    if (stopped(late)) return deny(STOP_REASON)
    if (late.answered) return fromAnswer(late)
    return ask('No device connected, approve here.')
  }
  if (handedOff(asked)) {
    const late = await withdrawQuestion(apiKey, asked.correlationId)
    if (stopped(late)) return deny(STOP_REASON)
    if (late.answered) return fromAnswer(late)
    return ask(handoffMessage(asked))
  }

  const cap = Math.min(Math.max(pushFirstSeconds, 1) * 1000, MAX_BLOCK_MS)
  const deadline = Date.now() + cap
  const answer = await pollForAnswer(apiKey, asked.correlationId, deadline)
  if (stopped(answer)) {
    await withdrawQuestion(apiKey, asked.correlationId)
    return deny(STOP_REASON)
  }
  if (answer.answered) return fromAnswer(answer)

  const late = await withdrawQuestion(apiKey, asked.correlationId)
  if (stopped(late)) return deny(STOP_REASON)
  if (late.answered) return fromAnswer(late)
  return ask('No answer from your phone in time, so the request was withdrawn there. Approve here.')
}

export { handlePushOnly, handlePushFirst, withdrawQuestion }

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

const TELEMETRY_EVENTS = ["PostToolUse", "Stop", "SessionStart", "UserPromptSubmit", "PreCompact", "SubagentStart", "SubagentStop"]

const reportTelemetry = async (input, source) => {
  const apiKey = resolveApiKey()
  if (!apiKey) return
  const sentAt = new Date().toISOString()
  const payload = JSON.stringify(input, (_key, value) => typeof value === 'string' ? redactSecretsDeep(value) : value)
  if (Buffer.byteLength(payload) > 262144) return
  const hash = value => createHash('sha256').update(value).digest('hex')
  const sessionId = input.session_id ?? input.sessionId ?? input.conversation_id ?? ''
  const hookId = hash([source, sessionId, input.hook_event_name, sentAt, hash(payload)].join('|')).slice(0, 32)
  try {
    await fetch(`${BASE_URL}/api/agent/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ v: 1, machineId: getMachineId(), app: { platform: 'cli', version: 'editor-plugin' },
        envelopes: [{ wire: 1, hookId, source, event: input.hook_event_name, sentAt,
          cwd: input.cwd, repoKey: deriveRepoKey(input.cwd), payload }] }),
      signal: AbortSignal.timeout(5000),
    })
  } catch { /* Telemetry never blocks an agent. */ }
}

const main = async () => {
  // Backstop: if anything hangs, return "ask" rather than letting the hook time
  // out and leave the agent with no decision at all. Scheduled here rather than
  // at module scope so importing this file for its helpers arms nothing.
  setTimeout(async () => {
    if (!activeQuestion) return respond(deny('Pushary could not finish approval safely. Retry the action.'))
    const late = await withdrawQuestion(activeQuestion.apiKey, activeQuestion.correlationId)
    respond(late.answered ? fromAnswer(late) : deny('Pushary approval expired or could not be withdrawn safely. Retry the action.'))
  }, HARD_GUARD_MS - 5_000).unref()

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

  input.hook_event_name ??= input.hookEventName
  if (TELEMETRY_EVENTS.includes(input.hook_event_name)) {
    await reportTelemetry(input, 'vscode')
    return respond({})
  }

  // Fast path. This runs before every tool the agent uses, so it must stay free
  // of disk and network work.
  const command = shouldGate(input.tool_name, input.tool_input)
  if (!command) return respond(PASS)

  const apiKey = resolveApiKey()
  if (!apiKey) {
    diag('no API key found (PUSHARY_API_KEY, the plugin .mcp.json, or ~/.pushary/config.json). Run: npx @pushary/agent-hooks@latest setup')
    return respond(
      unresolved(input.tool_name, 'Pushary is not configured: run `npx @pushary/agent-hooks@latest setup` (get a key at https://pushary.com) to route this approval to your phone.')
    )
  }

  const project = basename(input.cwd || process.cwd()) || 'workspace'
  const sessionId = typeof (input.session_id ?? input.sessionId) === 'string' ? (input.session_id ?? input.sessionId) : undefined
  const ident = { agentName: `VS Code - ${project}`, sessionId, machineId: getMachineId(), toolName: input.tool_name, toolInputs: [input.tool_input ?? {}], repoKey: deriveRepoKey(input.cwd) }

  try {
    const verdict = await decide(apiKey, command, input.cwd, sessionId, ident)

    // No verdict, or one that says nothing: VS Code's own prompt decides, exactly
    // as if this gate were not installed. Never a forced denial on an outage.
    if (!verdict || verdict.kind === 'no_opinion') return respond(unresolved(input.tool_name))
    if (verdict.kind === 'kill') return respond(deny(verdict.reason))
    if (verdict.kind === 'allow') return respond(ALLOW)
    if (verdict.kind === 'deny') return respond(deny(verdict.reason))
    if (verdict.kind !== 'ask') return respond(ask())

    // Reuse the server's canonical tool and target so asking resolves the same rules
    // as the gate, taken by name so nothing else in questionContext can overwrite this
    // gate's identity. A file change keeps its own path: the server's target for a
    // file is only its extension, which loses what routing and path rules match on.
    const canonical = canonicalQuestion(verdict.questionContext)
    if (canonical.toolName) ident.toolName = canonical.toolName
    const ownFile = FILE_TOOLS.has(ident.toolName) ? extractFilePath(input.tool_input) : undefined
    ident.toolTarget = filePathTarget(ownFile, input.cwd) ?? canonical.toolTarget
    ident.toolPath = filePathForAsk(ownFile, input.cwd)
    Object.assign(ident, scopeFromVerdict(verdict))
    const tool = verdict.policy

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
    return respond(unresolved(input.tool_name))
  }
}

// Importing this file for its testable helpers must not consume stdin or exit.
if (!process.env.PUSHARY_GATE_IMPORT) {
  main().catch((error) => {
    diag(`fatal: ${describeNetworkFailure(error)}`)
    respond(ask())
  })
}
