import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = 'C:\\Users\\dev'
const SNAPSHOT = 't3t.json'
const REQUEST = 't3t.request.json'
const slashes = (path: string) => path.replace(/\\/g, '/')
const base = (path: string) => slashes(path).split('/').pop() ?? path
const NOW = 1_794_553_568_218

type World = {
  files: Map<string, string>
  runs: { command: string; args: string }[]
  live: { sessionId: string; model: string }
  snapshot: () => Record<string, any>
}

function world(on: On, env: Record<string, string> = { HC_TERMINAL_ID: 't3t', USERPROFILE: HOME }): World {
  const files = new Map<string, string>()
  const runs: { command: string; args: string }[] = []
  const live = { sessionId: 'sid-1', model: 'claude-opus-5-5' }
  mock.env(on, env)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: live.sessionId }))
  on('session.model', () => ({ value: live.model }))
  on('session.cwd', () => ({ value: 'C:\\code\\x' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { tokens: 113000, window: 1000000, percent: 11 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 14, resetsAt: '2026-11-13T08:00:00.000Z' }],
    },
  }))
  on('config.list', () => ({
    value: [
      { key: 'theme', label: 'Theme', kind: 'choice', options: ['dark'], value: 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
      { key: 'model', label: 'Model', kind: 'choice', options: ['opus', 'sonnet', 'opus[1m]', 'bad value; /x'], value: 'opus', provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
    ],
  }))
  on('fs.write', (_, e) => {
    expect(slashes(e.path)).toBe(`${slashes(HOME)}/.claude/herdr-bridge/${base(e.path)}`)
    files.set(base(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(base(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('command.run', (_, e) => {
    runs.push({ command: e.command, args: e.args })
    if (e.command === 'model') live.model = `claude-${e.args}-5-5`
    return {}
  })
  return { files, runs, live, snapshot: () => JSON.parse(files.get(SNAPSHOT) ?? 'null') }
}

function request(files: Map<string, string>, fields: Record<string, unknown>) {
  files.set(REQUEST, JSON.stringify({ version: 1, id: 'r-abc', sessionId: 'sid-1', field: 'model', value: 'sonnet', createdAt: NOW, ...fields }))
}

test('outside Herdr nothing is written and no request is read', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, { USERPROFILE: HOME })
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  w.files.set(REQUEST, '{}')
  await clock.advance(3000)
  expect(w.files.size).toBe(1)
  expect(w.runs.length).toBe(0)
})

test('a malformed terminal id disables the bridge', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on, { HC_TERMINAL_ID: '../t3t', USERPROFILE: HOME })
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  expect(w.files.size).toBe(0)
})

test('session.start publishes identity, usage and safe choices', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  const s = w.snapshot()
  expect(s).toMatchObject({
    version: 1,
    terminal: 't3t',
    sessionId: 'sid-1',
    cwd: 'C:\\code\\x',
    model: 'claude-opus-5-5',
    context: { tokens: 113000, window: 1000000, percent: 11 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 14, resetsAt: '2026-11-13T08:00:00.000Z' }],
    choices: { model: ['opus', 'sonnet', 'opus[1m]'], effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
    updatedAt: NOW,
  })
  expect('effort' in s).toBe(false)
})

test('session.measure refreshes context and rate limits and omits what is missing', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context', 'rateLimits'] })
  const s = w.snapshot()
  expect(s.context).toEqual({ window: 200000 })
  expect(s.rateLimits).toEqual([])
})

test('a valid request runs exactly one slash command and is confirmed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  request(w.files, {})
  await clock.advance(1000)
  await clock.advance(3000)
  expect(w.runs).toEqual([{ command: 'model', args: 'sonnet' }])
  expect(w.snapshot().lastRequest).toEqual({ id: 'r-abc', ok: true, error: null })
  expect(w.snapshot().model).toBe('claude-sonnet-5-5')
})

test('an effort request publishes the applied level', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  request(w.files, { field: 'effort', value: 'low' })
  await clock.advance(1000)
  expect(w.runs).toEqual([{ command: 'effort', args: 'low' }])
  expect(w.snapshot().effort).toBe('low')
})

test('invalid requests are rejected with a reason and run nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ id: 'r-1', sessionId: 'other' }, /different Claude session/],
    [{ id: 'r-2', field: 'permissions', value: 'auto' }, /Only Model and Effort/],
    [{ id: 'r-3', value: 'bad value; /x' }, /not offered/],
    [{ id: 'r-4', field: 'effort', value: 'ultra' }, /not offered/],
    [{ id: 'r-5', createdAt: NOW + 120000 }, /expired/],
    [{ id: 'r-6', version: 2 }, /version/],
  ]
  for (const [fields, reason] of cases) {
    request(w.files, fields)
    await clock.advance(1000)
    const last = w.snapshot().lastRequest
    expect(last.id).toBe(fields.id)
    expect(last.ok).toBe(false)
    expect(last.error).toMatch(reason)
  }
  expect(w.runs.length).toBe(0)
})

test('a handled request id never runs twice, even across a reload', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  request(w.files, {})
  await clock.advance(1000)
  await clock.advance(5000)
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  expect(w.runs.length).toBe(1)
})

test('requests without a well-formed id are ignored silently', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  for (const text of ['', 'not json', '[]', JSON.stringify({ id: 'x y', field: 'model', value: 'sonnet' })]) {
    w.files.set(REQUEST, text)
    await clock.advance(1000)
  }
  expect(w.runs.length).toBe(0)
  expect('lastRequest' in w.snapshot()).toBe(false)
})

test('typed /effort and permission mode reach the snapshot', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on)
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'effort', args: 'xhigh', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(w.snapshot().effort).toBe('xhigh')
  await $.classic.UserPromptSubmit({ prompt: 'hi', permission_mode: 'plan' })
  expect(w.snapshot().permissionMode).toBe('plan')
})

test('a /resume republishes the new session id and usage and forgets the old effort', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'effort', args: 'low', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await $.session.measure({ context: { tokens: 900000, window: 1000000, percent: 90 }, rateLimits: [], changed: ['context'] })
  w.live.sessionId = 'sid-2'
  await $.session.end({ reason: 'resume', sessionId: 'sid-1', resume: { id: 'sid-1' } })
  await clock.advance(1000)
  const s = w.snapshot()
  expect(s.sessionId).toBe('sid-2')
  expect(s.context.percent).toBe(11)
  expect('effort' in s).toBe(false)
  expect('ended' in s).toBe(false)
})

test('exiting Claude marks the snapshot ended', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sid-1', resume: { id: 'sid-1' } })
  expect(w.snapshot().ended).toBe(true)
})

test('a request written before this Claude process started is never replayed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: 'C:\\code\\x', surface: 'terminal', isInteractive: true })
  request(w.files, { createdAt: NOW - 5000 })
  await clock.advance(1000)
  expect(w.runs.length).toBe(0)
  expect('lastRequest' in w.snapshot()).toBe(false)
})
