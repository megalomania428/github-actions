// Tests of retry.ts with a fake pi, model runtime and timers, without LLM requests:
// node --test review-pi_dev/retry.test.ts
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { install } from './retry.ts'
type Pi = Parameters<typeof install>[0]
type Compat = Parameters<typeof install>[1]
interface Failure {
  role: 'assistant'
  stopReason: string
  errorMessage: string
}
interface Event {
  type: string
  reason?: string
  delta?: string
  error?: Failure
}
interface Model {
  id: string
  api: string
  provider: string
  contextWindow?: number
}
interface Notice {
  error: string
  retry: number
  delay: number
  waited: number
  budget: number
}
interface Call {
  kind: string
  model: Model
  context: unknown
  options: unknown
}
type Handler = (event: unknown, ctx: unknown) => void
// Another copy of the module, as a load after /reload imports it anew, kept in a
// constant, so TypeScript does not look for it.
const COPY = './retry.ts?copy'
const terminal = (event: Event): boolean =>
  event.type === 'done' || event.type === 'error'
// Stream that ends after its terminal event, like the event streams of pi.
class FakeStream implements AsyncIterable<Event> {
  private readonly queue: Event[] = []
  private wake: (() => void) | undefined
  private closed = false
  push (event: Event): void {
    if (this.closed) return
    this.closed = terminal(event)
    this.queue.push(event)
    this.wake?.()
    this.wake = undefined
  }

  async * [Symbol.asyncIterator] (): AsyncGenerator<Event> {
    for (;;) {
      const event = this.queue.shift()
      if (event === undefined) {
        await new Promise<void>((resolve) => { this.wake = resolve })
        continue
      }
      yield event
      if (terminal(event)) return
    }
  }
}
const compat = {
  createAssistantMessageEventStream: () => new FakeStream(),
  isContextOverflow: (message: Failure) => message.errorMessage === 'overflow'
} as unknown as Compat
const failed = (errorMessage: string, stopReason = 'error'): Event[] => [
  { type: 'start' },
  { type: 'text_delta', delta: errorMessage },
  {
    type: 'error',
    reason: stopReason === 'aborted' ? 'aborted' : 'error',
    error: { role: 'assistant', stopReason, errorMessage }
  }
]
// A request that fails before it is sent, as an unknown provider in pi does.
const rejected = (errorMessage: string): Event[] => [{
  type: 'error',
  reason: 'error',
  error: { role: 'assistant', stopReason: 'error', errorMessage }
}]
const succeeded = (): Event[] => [
  { type: 'start' },
  { type: 'text_delta', delta: 'answer' },
  { type: 'done', reason: 'stop' }
]
function streamOf (events: Event[]): FakeStream {
  const stream = new FakeStream()
  for (const event of events) stream.push(event)
  return stream
}
const modelOf = (provider: string, api = 'openai-completions'): Model =>
  ({ id: `${provider}-${api}`, api, provider, contextWindow: 1000 })
// Model runtime with its methods on the prototype, as ModelRuntime of pi has them: its
// streams fail with the given outcomes and then succeed, and complete goes through this.
class FakeRuntime {
  readonly calls: Call[] = []
  readonly outcomes: Event[][]
  constructor (outcomes: Event[][] = []) {
    this.outcomes = outcomes
  }

  stream (model: Model, context: unknown, options?: unknown): FakeStream {
    return this.run('stream', model, context, options)
  }

  streamSimple (model: Model, context: unknown, options?: unknown): FakeStream {
    return this.run('streamSimple', model, context, options)
  }

  complete (model: Model, context: unknown, options?: unknown): FakeStream {
    return this.stream(model, context, options)
  }

  private run (kind: string, model: Model, context: unknown,
    options: unknown): FakeStream {
    this.calls.push({ kind, model, context, options })
    return streamOf(this.outcomes.shift() ?? succeeded())
  }
}
// Pi of one load of the extension, whose model registry holds the runtime.
class FakePi {
  readonly handlers = new Map<string, Handler[]>()
  readonly notices: Notice[] = []
  registry: object
  stale = false
  readonly events = {
    emit: (channel: string, data: unknown): void => {
      if (this.stale) throw new Error('This extension ctx is stale')
      assert.equal(channel, 'review:retry')
      this.notices.push(data as Notice)
    }
  }

  constructor (runtime: unknown) {
    this.registry = { runtime }
  }

  on (name: string, handler: Handler): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler])
  }

  fire (name: string, event: unknown = { type: name }): void {
    const ctx = { modelRegistry: this.registry }
    for (const handler of this.handlers.get(name) ?? []) handler(event, ctx)
  }
}
const settings = (llmRetries?: unknown): Record<string, unknown> =>
  ({ llmRetries, retry: { enabled: false, provider: { maxRetries: 0 } } })
// Install the extension for a session that uses the runtime.
function started (runtime: FakeRuntime, llmRetries?: unknown): FakePi {
  const pi = new FakePi(runtime)
  install(pi as unknown as Pi, compat, settings(llmRetries))
  pi.fire('session_start')
  return pi
}
const tick = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
}
// Read the stream to its end, moving the fake clock on while it waits.
async function collect (stream: AsyncIterable<Event>): Promise<Event[]> {
  const events: Event[] = []
  const reading = (async () => {
    for await (const event of stream) events.push(event)
    return true
  })()
  for (let step = 0; !await Promise.race([reading, tick().then(() => false)]); step++) {
    if (step > 10000) throw new Error('the stream never ended')
    mock.timers.tick(1000)
  }
  return events
}
const ask = async (runtime: FakeRuntime, context: unknown = {}): Promise<Event[]> =>
  await collect(runtime.streamSimple(modelOf('omni'), context))
mock.timers.enable({ apis: ['setTimeout'] })
test('retries streamSimple of the runtime with the arguments as they are', async () => {
  const runtime = new FakeRuntime([failed('boom')])
  const pi = started(runtime)
  const model = modelOf('codex', 'openai-codex-responses')
  const context = { messages: [] }
  const options = {
    apiKey: 'key',
    headers: { 'x-test': '1' },
    signal: new AbortController().signal
  }
  const events = await collect(runtime.streamSimple(model, context, options))
  assert.deepEqual(events.map((event) => event.type),
    ['start', 'text_delta', 'text_delta', 'done'])
  assert.equal(runtime.calls.length, 2)
  for (const call of runtime.calls) {
    assert.equal(call.kind, 'streamSimple')
    assert.equal(call.model, model)
    assert.equal(call.context, context)
    assert.equal(call.options, options)
  }
  assert.deepEqual(pi.notices,
    [{ error: 'boom', retry: 1, delay: 1, waited: 0, budget: 111 }])
})
test('retries stream of the runtime and the methods calling it', async () => {
  const runtime = new FakeRuntime([failed('a'), succeeded(), failed('b')])
  const pi = started(runtime)
  const options = { apiKey: 'key' }
  assert.equal((await collect(runtime.stream(modelOf('omni'), {}, options))).at(-1)?.type,
    'done')
  assert.equal((await collect(runtime.complete(modelOf('omni'), {}))).at(-1)?.type,
    'done')
  assert.deepEqual(runtime.calls.map((call) => call.kind),
    ['stream', 'stream', 'stream', 'stream'])
  assert.equal(runtime.calls[0].options, options)
  assert.deepEqual(pi.notices.map((notice) => notice.error), ['a', 'b'])
})
test('retries a request that fails before it is sent', async () => {
  const runtime = new FakeRuntime([rejected('Unknown provider: omni')])
  const pi = started(runtime)
  const events = await ask(runtime)
  assert.deepEqual(events.map((event) => event.type), ['start', 'text_delta', 'done'])
  assert.equal(runtime.calls.length, 2)
  assert.deepEqual(pi.notices.map((notice) => notice.error), ['Unknown provider: omni'])
})
test('a load without session_start leaves the runtime alone', () => {
  const runtime = new FakeRuntime()
  install(new FakePi(runtime) as unknown as Pi, compat, settings())
  assert.equal(Object.hasOwn(runtime, 'stream'), false)
  assert.equal(Object.hasOwn(runtime, 'streamSimple'), false)
})
test('later loads join the interception of the runtime instead of repeating it',
  async () => {
    const runtime = new FakeRuntime(Array.from({ length: 10 }, () => failed('boom')))
    const first = started(runtime, 3)
    const { stream, streamSimple } = runtime
    assert.equal(Object.hasOwn(runtime, 'streamSimple'), true)
    const second = started(runtime, 3)
    second.fire('session_start')
    assert.equal(runtime.stream, stream)
    assert.equal(runtime.streamSimple, streamSimple)
    assert.equal((await ask(runtime)).at(-1)?.type, 'error')
    assert.equal(runtime.calls.length, 4)
    assert.equal(first.notices.length, 0)
    assert.equal(second.notices.length, 3)
  })
test('a load of another copy of the module joins the same interception', async () => {
  const copy = await import(COPY) as { install: typeof install }
  const runtime = new FakeRuntime([failed('a'), succeeded(), failed('b')])
  const first = started(runtime)
  const { streamSimple } = runtime
  const second = new FakePi(runtime)
  copy.install(second as unknown as Pi, compat, settings())
  second.fire('session_start')
  assert.equal(runtime.streamSimple, streamSimple)
  assert.equal((await ask(runtime)).at(-1)?.type, 'done')
  second.fire('session_shutdown')
  assert.equal((await ask(runtime)).at(-1)?.type, 'done')
  assert.equal(runtime.calls.length, 4)
  assert.deepEqual(second.notices.map((notice) => notice.error), ['a'])
  assert.deepEqual(first.notices.map((notice) => notice.error), ['b'])
})
test('session_shutdown hands the requests to the previous active load', async () => {
  const runtime = new FakeRuntime([failed('a'), succeeded(), failed('b'), failed('c')])
  const first = started(runtime)
  const second = started(runtime)
  second.fire('session_shutdown')
  assert.equal((await ask(runtime)).at(-1)?.type, 'done')
  assert.deepEqual(first.notices.map((notice) => notice.error), ['a'])
  first.fire('session_shutdown')
  const events = await ask(runtime)
  assert.equal(events.at(-1)?.type, 'error')
  assert.equal(events.at(-1)?.error?.errorMessage, 'b')
  assert.equal(runtime.calls.length, 3)
  assert.equal(second.notices.length, 0)
  assert.equal(first.notices.length, 1)
  const third = started(runtime)
  assert.equal((await ask(runtime)).at(-1)?.type, 'done')
  assert.deepEqual(third.notices.map((notice) => notice.error), ['c'])
})
test('a request keeps its load when the session ends during the request', async () => {
  const outcome = failed('a')
  const runtime = new FakeRuntime([outcome, failed('b')])
  const first = started(runtime)
  const second = started(runtime)
  const stream = runtime.streamSimple(modelOf('omni'), {})
  await tick()
  second.fire('message_update', { assistantMessageEvent: outcome[1] })
  await tick()
  assert.equal(second.notices.length, 1)
  second.fire('session_shutdown')
  assert.equal((await collect(stream)).at(-1)?.type, 'done')
  assert.equal(runtime.calls.length, 3)
  assert.equal(second.notices.length, 1)
  assert.equal(first.notices.length, 0)
})
test('a load whose pi went stale leaves the requests to the previous one', async () => {
  const runtime = new FakeRuntime([failed('a'), succeeded(), failed('c')])
  const first = started(runtime)
  const second = started(runtime)
  second.stale = true
  assert.equal((await ask(runtime)).at(-1)?.type, 'done')
  assert.equal(runtime.calls.length, 2)
  assert.equal(first.notices.length, 0)
  assert.equal((await ask(runtime)).at(-1)?.type, 'done')
  assert.deepEqual(first.notices.map((notice) => notice.error), ['c'])
})
test('session_start fails without a runtime with streams in the model registry', () => {
  for (const registry of [{}, { runtime: null }, { runtime: { stream: () => {} } }]) {
    const pi = new FakePi(undefined)
    pi.registry = registry
    install(pi as unknown as Pi, compat, settings())
    assert.throws(() => { pi.fire('session_start') }, /no runtime with stream/)
  }
})
test('spends the default budget of 111 seconds on the sum of the delays', async () => {
  const runtime = new FakeRuntime(Array.from({ length: 40 }, () => failed('boom')))
  const pi = started(runtime)
  const events = await ask(runtime)
  assert.deepEqual(pi.notices.map((notice) => notice.delay), [1, 1, 1, 2, 2, 2, 3, 3, 3,
    4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7, 7, 7, 7, 1, 1, 1, 2])
  assert.deepEqual(pi.notices.map((notice) => notice.retry),
    Array.from({ length: 28 }, (_, index) => index + 1))
  assert.equal(pi.notices.at(-1)?.waited, 108)
  assert.equal(runtime.calls.length, 29)
  assert.equal(events.filter((event) => event.type === 'start').length, 1)
  assert.equal(events.filter(terminal).length, 1)
  const last = events.at(-1)
  assert.equal(last?.type, 'error')
  assert.equal(last?.reason, 'error')
  assert.equal(last?.error?.errorMessage, 'boom')
})
test('stops before a delay that would pass the budget', async () => {
  const cases: Array<[unknown, number]> = [[3, 3], ['4', 3], [5, 4]]
  for (const [budget, retries] of cases) {
    const runtime = new FakeRuntime(Array.from({ length: 10 }, () => failed('boom')))
    const pi = started(runtime, budget)
    const events = await ask(runtime)
    assert.equal(pi.notices.length, retries)
    assert.equal(runtime.calls.length, retries + 1)
    assert.equal(events.at(-1)?.type, 'error')
  }
})
test('passes overflows and cancellations on without retries', async () => {
  const cases: Array<[Event[], string]> = [
    [failed('overflow'), 'error'],
    [failed('stopped', 'aborted'), 'aborted']
  ]
  for (const [outcome, reason] of cases) {
    const runtime = new FakeRuntime([outcome])
    const pi = started(runtime)
    const events = await ask(runtime)
    assert.equal(runtime.calls.length, 1)
    assert.equal(pi.notices.length, 0)
    assert.equal(events.at(-1)?.reason, reason)
  }
})
test('a cancellation ends the wait before the next attempt', async () => {
  const runtime = new FakeRuntime([failed('boom'), failed('boom')])
  const pi = started(runtime)
  const controller = new AbortController()
  const stream = runtime.streamSimple(modelOf('omni'), {}, { signal: controller.signal })
  await tick()
  controller.abort()
  const events = await collect(stream)
  assert.equal(runtime.calls.length, 1)
  assert.equal(pi.notices.length, 0)
  const last = events.at(-1)
  assert.equal(last?.reason, 'aborted')
  assert.equal(last?.error?.errorMessage, 'Request was aborted')
})
test('parallel requests keep their own budget and counters', async () => {
  const runtime = new FakeRuntime()
  const x = {}
  const y = {}
  const outcomes = new Map<unknown, Event[][]>([
    [x, [failed('x'), failed('x')]],
    [y, [failed('y')]]
  ])
  runtime.streamSimple = (_model, context) =>
    streamOf(outcomes.get(context)?.shift() ?? succeeded())
  const pi = started(runtime)
  await Promise.all([ask(runtime, x), ask(runtime, y)])
  const counters = (error: string): number[][] => pi.notices
    .filter((notice) => notice.error === error)
    .map((notice) => [notice.retry, notice.waited])
  assert.deepEqual(counters('x'), [[1, 0], [2, 1]])
  assert.deepEqual(counters('y'), [[1, 0]])
})
test('the notice follows message_update of the failed attempt', async () => {
  const outcome = failed('boom')
  const runtime = new FakeRuntime([outcome])
  const pi = started(runtime)
  const stream = runtime.streamSimple(modelOf('omni'), {})
  await tick()
  assert.equal(pi.notices.length, 0)
  pi.fire('message_update', { assistantMessageEvent: outcome[1] })
  await tick()
  assert.equal(pi.notices.length, 1)
  const events = await collect(stream)
  assert.equal(events.at(-1)?.type, 'done')
})
test('works without listeners of review:retry, as without log.ts', async () => {
  const runtime = new FakeRuntime([failed('boom')])
  const pi = started(runtime)
  pi.events.emit = () => {}
  assert.equal((await ask(runtime)).at(-1)?.type, 'done')
  assert.equal(runtime.calls.length, 2)
})
test('llmRetries 0 turns the extension off and invalid settings fail', () => {
  const off = new FakePi(new FakeRuntime())
  install(off as unknown as Pi, compat, { llmRetries: 0 })
  assert.equal(off.handlers.size, 0)
  for (const value of [-1, 1.5, '1.5', '', null, true]) {
    assert.throws(() => {
      install(new FakePi(new FakeRuntime()) as unknown as Pi, compat, settings(value))
    }, /llmRetries must be a non-negative integer/)
  }
  for (const retry of [undefined, { enabled: true },
    { enabled: false, provider: { maxRetries: 2 } }]) {
    assert.throws(() => {
      install(new FakePi(new FakeRuntime()) as unknown as Pi, compat,
        { llmRetries: 5, retry })
    }, /retry\.enabled: false/)
  }
})
