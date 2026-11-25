import type { EngineInterface as Engine, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

const SNAPSHOT_VERSION = 1
const TERMINAL_KEY = /^[A-Za-z0-9_-]+$/
const REQUEST_ID = /^r-[A-Za-z0-9_-]{1,64}$/
const SAFE_CHOICE = /^[A-Za-z0-9._[\]-]{1,64}$/
const POLL_MS = 1000
const REQUEST_TTL_MS = 60000
const IDENTITY_SETTLE_MS = 1000
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const HANDLED = { plugin: 'herdr-bridge', key: 'lastRequestId' } as const
const STARTED = { plugin: 'herdr-bridge', key: 'startedAt' } as const

type Field = 'model' | 'effort'
type LastRequest = { id: string; ok: boolean | null; error: string | null }
type Snapshot = {
  version: number
  terminal: string
  sessionId?: string
  cwd?: string
  model?: string
  effort?: string
  permissionMode?: string
  context?: { tokens?: number; window?: number; percent?: number }
  rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[]
  choices: { model: string[]; effort: string[] }
  lastRequest?: LastRequest
  ended?: boolean
  updatedAt?: number
}

let snapshotPath: string | null = null
let requestPath: string | null = null
let snapshot: Snapshot | null = null
let isWriting = false
let isDirty = false
let isPolling = false

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function usagePatch(usage: { context: SessionContextUsage; rateLimits: readonly SessionRateLimit[] }): Partial<Snapshot> {
  return {
    context: { tokens: finite(usage.context.tokens), window: finite(usage.context.window), percent: finite(usage.context.percent) },
    rateLimits: usage.rateLimits
      .filter((w) => typeof w.kind === 'string' && finite(w.percentUsed) !== undefined)
      .map((w) => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : undefined })),
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}

async function publish($: Engine, patch: Partial<Snapshot>) {
  if (!snapshot || !snapshotPath) return
  Object.assign(snapshot, patch)
  isDirty = true
  if (isWriting) return
  isWriting = true
  try {
    while (isDirty && snapshot && snapshotPath) {
      isDirty = false
      snapshot.updatedAt = await $.clock.now()
      await $.fs.write(snapshotPath, JSON.stringify(snapshot)).catch(() => undefined)
    }
  } finally {
    isWriting = false
  }
}

async function identity($: Engine): Promise<Partial<Snapshot>> {
  const [sessionId, model] = await Promise.all([
    $.session.id().catch(() => undefined),
    $.session.model().catch(() => undefined),
  ])
  return { sessionId, model }
}

async function modelChoices($: Engine): Promise<string[]> {
  const rows = await $.config.list().catch(() => [])
  const row = rows.find((r) => r.key === 'model' && r.kind === 'choice')
  return (row?.options ?? []).filter((option) => SAFE_CHOICE.test(option))
}

async function refreshIdentity($: Engine) {
  if (snapshot) await publish($, await identity($))
}

async function refreshConversation($: Engine) {
  if (!snapshot) return
  const usage = await $.session.usage().catch(() => null)
  await publish($, { ...(await identity($)), ...(usage ? usagePatch(usage) : { context: undefined, rateLimits: undefined }), effort: undefined })
}

async function rejectRequest($: Engine, request: Record<string, unknown>): Promise<string | null> {
  if (request.version !== 1) return 'Unsupported request version.'
  const sessionId = await $.session.id().catch(() => undefined)
  if (!sessionId || request.sessionId !== sessionId) return 'The request is for a different Claude session.'
  if (request.field !== 'model' && request.field !== 'effort') return 'Only Model and Effort can be changed.'
  const choices = snapshot?.choices[request.field] ?? []
  if (typeof request.value !== 'string' || !choices.includes(request.value)) return `That ${request.field} is not offered by this Claude session.`
  const now = await $.clock.now()
  if (typeof request.createdAt !== 'number' || Math.abs(now - request.createdAt) > REQUEST_TTL_MS) return 'The request expired before Claude read it.'
  return null
}

async function poll($: Engine) {
  if (isPolling || !snapshot || !requestPath) return
  isPolling = true
  try {
    let text: string
    try {
      text = await $.fs.read(requestPath)
    } catch {
      return
    }
    let request: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      request = parsed as Record<string, unknown>
    } catch {
      return
    }
    const id = request.id
    if (typeof id !== 'string' || !REQUEST_ID.test(id)) return
    const handled = await $.state.get(HANDLED)
    if (handled.value === id) return
    // A request written before this Claude process started belongs to an earlier one; never replay it.
    const started = await $.state.get(STARTED)
    if (typeof request.createdAt === 'number' && started.value !== undefined && request.createdAt < started.value) return
    // Marked before the command runs: a hot reload keeps a queued command alive, so the new copy must not run it again.
    await $.state.set(HANDLED, id)
    const rejection = await rejectRequest($, request)
    if (rejection) {
      await publish($, { lastRequest: { id, ok: false, error: rejection } })
      return
    }
    const field = request.field as Field
    const value = request.value as string
    await publish($, { lastRequest: { id, ok: null, error: null } })
    try {
      await $.command.run({ command: field, args: value })
    } catch (error) {
      await publish($, { lastRequest: { id, ok: false, error: `Claude did not run /${field}: ${errorText(error)}` } })
      return
    }
    const patch: Partial<Snapshot> = { ...(await identity($)), lastRequest: { id, ok: true, error: null } }
    if (field === 'effort') patch.effort = value
    await publish($, patch)
  } finally {
    isPolling = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    snapshot = null
    snapshotPath = null
    requestPath = null
    const terminal = await $.env.get('HC_TERMINAL_ID')
    if (!terminal || !TERMINAL_KEY.test(terminal)) return result
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return result
    const dir = `${home.replace(/[\\/]+$/, '')}/.claude/herdr-bridge`
    const started = await $.state.get(STARTED)
    if (started.value === undefined) await $.state.set(STARTED, await $.clock.now())
    snapshotPath = `${dir}/${terminal}.json`
    requestPath = `${dir}/${terminal}.request.json`
    snapshot = {
      version: SNAPSHOT_VERSION,
      terminal,
      cwd: await $.session.cwd().catch(() => result.cwd),
      choices: { model: await modelChoices($), effort: [...EFFORT_LEVELS] },
    }
    const usage = await $.session.usage().catch(() => null)
    await publish($, { ...(await identity($)), ...(usage ? usagePatch(usage) : {}) })
    $.clock.every(POLL_MS, () => poll($))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (snapshot) await publish($, { ...usagePatch(e), ...(await identity($)) })
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (snapshot && e.agentId === undefined) {
      await publish($, { ...(await identity($)), effort: typeof e.effort === 'string' ? e.effort : undefined })
    }
    return yield* next(e)
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    await refreshIdentity($)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const level = e.args.trim()
    if (snapshot && EFFORT_LEVELS.includes(level)) await publish($, { effort: level })
    return result
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (snapshot && typeof e.permission_mode === 'string' && e.permission_mode !== snapshot.permissionMode) {
      await publish($, { permissionMode: e.permission_mode })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    if (snapshot && typeof e.permission_mode === 'string' && e.permission_mode !== snapshot.permissionMode) {
      await publish($, { permissionMode: e.permission_mode })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (!snapshot) return result
    // A /clear or /resume keeps the process under another session id; any other end leaves the file behind, so mark it.
    if (e.reason === 'clear' || e.reason === 'resume') $.clock.after(IDENTITY_SETTLE_MS, () => refreshConversation($))
    else await publish($, { ended: true })
    return result
  })
}
