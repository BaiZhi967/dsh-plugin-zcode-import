/**
 * Convert one ZCode conversation into a DeepSeek Harness session event log.
 *
 * ZCode stores a conversation as ordered `message` rows, each with ordered
 * `part` rows (`text`, `reasoning`, `tool`, `step-start`, `step-finish`,
 * `timeline`, `file`, `compaction`). DSH stores an append-only event log whose
 * model-visible events are `user/message`, `assistant/message`, `tool/call`
 * and `tool/result`, framed by `turn/*` and `step/*` markers.
 *
 * The conversion is intentionally lossless about readable content and
 * conservative about structure: every source message becomes exactly one
 * DSH step, and every ZCode `tool` part becomes a `tool/call` +
 * `tool/result` pair, so the imported conversation renders as a normal chat
 * transcript.
 */
import { randomUUID } from 'node:crypto'

/** Event types and envelope markers this converter emits (validated by DSH). */
const SURFACE_APPEND = { surfaceOp: 'append' }

/** Hard cap for one text block, so a pathological source value cannot bloat a log. */
const MAX_BLOCK_CHARS = 400_000

/** ZCode user messages injected by the runtime rather than typed by the human. */
const INJECTED_USER_KINDS = new Set([
  'todo_reminder',
  'background_notification',
  'subagent_notification',
  'system_reminder',
  'fork_notice',
])

function textOf(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function clamp(text) {
  if (text.length <= MAX_BLOCK_CHARS) return text
  return `${text.slice(0, MAX_BLOCK_CHARS)}\n\n…（内容过长，导入时已截断 ${text.length - MAX_BLOCK_CHARS} 字符）`
}

/** Normalize one ZCode `tool` part into the pair of DSH events it becomes. */
function toolCallOf(part, index) {
  const state = part.state ?? {}
  const name = typeof part.tool === 'string' && part.tool.length > 0 ? part.tool : 'tool'
  const callId = typeof part.callID === 'string' && part.callID.length > 0
    ? part.callID
    : `call_zcode_${index}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const status = typeof state.status === 'string' ? state.status : 'completed'
  const output = state.output !== undefined
    ? textOf(state.output)
    : status === 'completed' ? '' : `(${status})`
  return {
    callId,
    name,
    arguments: textOf(state.input ?? {}),
    result: clamp(output.length > 0 ? output : '(无输出)'),
    isError: status === 'error',
  }
}

/**
 * Split one ZCode message row into the DSH-shaped content it contributes.
 *
 * @returns `null` when the message carries nothing a reader should see, which
 * is how injected reminders and empty timeline markers are dropped.
 */
function messageOf(row) {
  const meta = row.meta ?? {}
  const role = meta.role
  const semantics = meta.semantics ?? {}
  const kind = semantics.kind
  const parts = Array.isArray(row.parts) ? row.parts : []

  if (role === 'user') {
    if (typeof kind === 'string' && INJECTED_USER_KINDS.has(kind)) return null
    if (semantics.origin === 'system') return null
    const content = []
    for (const part of parts) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        content.push({ type: 'text', text: clamp(part.text) })
      } else if (part?.type === 'file') {
        const label = part.filename ?? part.url ?? '附件'
        content.push({ type: 'text', text: `[附件] ${label}` })
      }
    }
    if (content.length === 0) return null
    return { kind: 'user', createdAt: meta.time?.created ?? row.timeCreated, content }
  }

  if (role !== 'assistant') return null
  if (kind === 'timeline_event') return null

  const content = []
  const toolCalls = []
  let order = 0
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      content.push({ type: 'text', text: clamp(part.text) })
    } else if (part?.type === 'reasoning' && typeof part.text === 'string' && part.text.length > 0) {
      content.push({ type: 'reasoning', text: clamp(part.text) })
    } else if (part?.type === 'tool') {
      const call = toolCallOf(part, `${row.id}_${order++}`)
      toolCalls.push(call)
      content.push({ type: 'tool-call', id: call.callId, name: call.name, arguments: call.arguments })
    }
  }
  if (content.length === 0) return null

  const providerId = meta.providerId ?? meta.modelSelection?.providerId
  const modelId = meta.modelId ?? meta.modelSelection?.modelId
  return {
    kind: 'assistant',
    createdAt: meta.time?.created ?? row.timeCreated,
    content,
    toolCalls,
    provider: typeof providerId === 'string' && providerId.length > 0 ? providerId : 'zcode',
    model: typeof modelId === 'string' && modelId.length > 0 ? modelId : 'unknown',
  }
}

/**
 * Build the complete DSH event list for one ZCode conversation.
 *
 * @param conversation - `{ meta, messages }`: the ZCode session row plus its
 *   ordered message/part rows as produced by `zcode-source.js`.
 * @param options - `title` for the imported session, `createdAt` fallback.
 * @returns `{ events, turns, steps }`; `events` is empty when nothing readable
 *   was found, in which case the caller must not create a session.
 */
export function convertConversation(conversation, options = {}) {
  const rows = Array.isArray(conversation?.messages) ? conversation.messages : []
  const title = typeof options.title === 'string' && options.title.trim().length > 0
    ? options.title.trim().slice(0, 200)
    : '（未命名会话）'

  const events = []
  let seq = 0
  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  let firstUserSeq
  let steps = 0

  const push = (type, data, extra, at) => {
    events.push({
      type,
      seq: seq++,
      time: Number.isSafeInteger(at) ? at : Date.now(),
      data,
      ...(extra ?? {}),
    })
  }

  const closeStep = (at) => {
    if (!stepOpen) return
    push('step/end', { turn, step }, undefined, at)
    stepOpen = false
  }
  const closeTurn = (at) => {
    closeStep(at)
    if (!turnOpen) return
    push('turn/end', { turn, reason: { kind: 'completed' } }, undefined, at)
    turnOpen = false
  }

  for (const row of rows) {
    const message = messageOf(row)
    if (message === null) continue
    const at = Number.isSafeInteger(message.createdAt) ? message.createdAt : Date.now()

    if (message.kind === 'user') {
      closeTurn(at)
      turn += 1
      step = 0
      push('turn/start', { turn }, undefined, at)
      turnOpen = true
      const userSeq = seq
      push(
        'user/message',
        { id: randomUUID(), role: 'user', content: message.content, source: { kind: 'user' } },
        SURFACE_APPEND,
        at,
      )
      if (firstUserSeq === undefined) {
        firstUserSeq = userSeq
        push('session/title', { title, messageSeqs: [userSeq], source: { kind: 'fallback' } }, undefined, at)
      }
      continue
    }

    if (!turnOpen) {
      turn += 1
      step = 0
      push('turn/start', { turn }, undefined, at)
      turnOpen = true
    }
    step += 1
    steps += 1
    push('step/start', { turn, step }, undefined, at)
    stepOpen = true
    push(
      'assistant/message',
      {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: message.content,
          source: { kind: 'model', provider: message.provider, model: message.model },
        },
        stream: [],
      },
      SURFACE_APPEND,
      at,
    )
    for (const call of message.toolCalls) {
      push('tool/call', { turn, step, callId: call.callId, name: call.name, arguments: call.arguments }, undefined, at)
      push(
        'tool/result',
        {
          turn,
          step,
          message: {
            id: randomUUID(),
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: call.callId,
                content: [{ type: 'text', text: call.result }],
                ...(call.isError ? { isError: true } : {}),
              },
            ],
            source: { kind: 'tool', callId: call.callId },
          },
        },
        SURFACE_APPEND,
        at,
      )
    }
    push('step/end', { turn, step }, undefined, at)
    stepOpen = false
  }

  closeTurn(Date.now())
  return { events, turns: turn, steps }
}

/**
 * Build the DSH session header for one imported ZCode conversation.
 *
 * `cwd` is what later binds the session to a workspace, so it must be the
 * ZCode session's own directory, spelled exactly as the user opened it.
 */
export function headerFor(session, sessionId) {
  return {
    version: 3,
    id: sessionId,
    createdAt: Number.isSafeInteger(session.time_created) ? session.time_created : Date.now(),
    cwd: session.directory,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
}

/** Fresh DSH session id for one imported conversation. */
export function newSessionId() {
  return `session-${randomUUID()}`
}
