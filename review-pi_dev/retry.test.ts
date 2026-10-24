// Tests of retry.ts with a fake pi, model registry, providers and timers, without LLM
// requests: node --test review-pi_dev/retry.test.ts
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
type Run = (model: Model, context: unknown, options?: unknown) => AsyncIterable<Event>
interface Provider {
  id: string
  stream: Run
  streamSimple: Run
  [key: string]: unknown
}
type Handler = (event: unknown, ctx: unknown) => void
const ORIGINAL = Symbol.for('review-pi_dev.retry.original')
const NESTED = Symbol.for('review-pi_dev.retry.nested')
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
// A provider whose own streams fail with the given outcomes and then succeed.
function providerOf (id: string, outcomes: Event[][] = []): Provider & { calls: Call[] } {
  const calls: Call[] = []
  const run = (kind: string): Run => (model, context, options) => {
    calls.push({ kind, model, context, options })
    return streamOf(outcomes.shift() ?? succeeded())
  }
  return {
    id,
    name: id,
    auth: { apiKey: {} },
    getModels: () => [],
    calls,
    stream: run('stream'),
    streamSimple: run('streamSimple')
  }
}
// Pi with a registry without overlays, which serves a native provider as it is.
class FakePi {
  readonly handlers = new Map<string, Handler[]>()
  readonly registered: Provider[] = []
  readonly unregistered: string[] = []
  readonly notices: Notice[] = []
  readonly native = new Map<string, Provider>()
  readonly providers: Map<string, Provider>
  available: Model[] = []
  model: Model | undefined
  readonly events = {
    emit: (channel: string, data: unknown): void => {
      assert.equal(channel, 'review:retry')
      this.notices.push(data as Notice)
    }
  }

  constructor (...providers: Provider[]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]))
  }

  on (name: string, handler: Handler): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler])
  }

  registerProvider (provider: Provider): void {
    this.registered.push(provider)
    this.native.set(provider.id, provider)
  }

  unregisterProvider (id: string): void {
    this.unregistered.push(id)
    this.native.delete(id)
  }

  fire (name: string, event: unknown = { type: name }): void {
    const ctx = {
      model: this.model,
      modelRegistry: {
        getAvailable: () => this.available,
        getProvider: (id: string) => this.native.get(id) ?? this.providers.get(id),
        getRegisteredNativeProvider: (id: string) => this.native.get(id)
      }
    }
    for (const handler of this.handlers.get(name) ?? []) handler(event, ctx)
  }
}
const settings = (llmRetries?: unknown): Record<string, unknown> =>
  ({ llmRetries, retry: { enabled: false, provider: { maxRetries: 0 } } })
// Install the extension for a session whose current model belongs to the provider.
function started (provider: Provider, llmRetries?: unknown): FakePi {
  const pi = new FakePi(provider)
  pi.model = modelOf(provider.id)
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
  let finished = false
  const reading = (async () => {
    for await (const event of stream) events.push(event)
    finished = true
  })()
  for (let step = 0; !finished; step++) {
    if (step > 10000) throw new Error('the stream never ended')
    await tick()
    mock.timers.tick(1000)
  }
  await reading
  return events
}
const originalOf = (provider: Provider | undefined): unknown =>
  (provider as Record<symbol, unknown> | undefined)?.[ORIGINAL]
mock.timers.enable({ apis: ['setTimeout'] })
test('wraps the provider of the current model and keeps its fields', async () => {
  const provider = providerOf('omni', [failed('boom')])
  const pi = started(provider)
  assert.equal(pi.registered.length, 1)
  const [wrapper] = pi.registered
  assert.equal(wrapper.id, 'omni')
  assert.equal(wrapper.auth, provider.auth)
  assert.equal(wrapper.getModels, provider.getModels)
  assert.equal(originalOf(wrapper), provider)
  const model = modelOf('omni')
  const context = { messages: [] }
  const options = {
    apiKey: 'key',
    headers: { 'x-test': '1' },
    signal: new AbortController().signal
  }
  const events = await collect(wrapper.streamSimple(model, context, options))
  assert.deepEqual(events.map((event) => event.type),
    ['start', 'text_delta', 'text_delta', 'done'])
  assert.equal(provider.calls.length, 2)
  for (const call of provider.calls) {
    assert.equal(call.kind, 'streamSimple')
    assert.equal(call.model, model)
    assert.equal(call.context, context)
    assert.deepEqual(call.options, { ...options, [NESTED]: true })
  }
  assert.deepEqual(pi.notices,
    [{ error: 'boom', retry: 1, delay: 1, waited: 0, budget: 111 }])
})
test('retries the stream of the provider as well', async () => {
  const provider = providerOf('omni', [failed('boom')])
  const pi = started(provider)
  const model = modelOf('omni')
  const context = { messages: [] }
  const options = { apiKey: 'key', signal: new AbortController().signal }
  const events = await collect(pi.registered[0].stream(model, context, options))
  assert.equal(events.at(-1)?.type, 'done')
  assert.deepEqual(provider.calls.map((call) => call.kind), ['stream', 'stream'])
  for (const call of provider.calls) {
    assert.equal(call.model, model)
    assert.equal(call.context, context)
    assert.deepEqual(call.options, { ...options, [NESTED]: true })
  }
})
test('serves every api of a provider through its own streams', async () => {
  const outcomes = new Map<string, Event[][]>([
    ['anthropic-messages', [failed('a')]],
    ['openai-responses', [failed('b')]]
  ])
  const used: string[] = []
  const provider = providerOf('copilot')
  provider.streamSimple = (model) => {
    used.push(model.api)
    return streamOf(outcomes.get(model.api)?.shift() ?? succeeded())
  }
  const pi = started(provider)
  for (const api of outcomes.keys()) {
    const model = modelOf('copilot', api)
    const events = await collect(pi.registered[0].streamSimple(model, {}))
    assert.equal(events.at(-1)?.type, 'done')
  }
  assert.deepEqual(used, ['anthropic-messages', 'anthropic-messages', 'openai-responses',
    'openai-responses'])
  assert.equal(pi.registered.length, 1)
})
test('wraps the current provider and those with auth, keeping earlier wrappers', () => {
  const pi = new FakePi(...['a', 'b', 'c', 'd'].map((id) => providerOf(id)))
  pi.available = [modelOf('a')]
  pi.model = modelOf('c')
  install(pi as unknown as Pi, compat, settings())
  pi.fire('session_start')
  assert.deepEqual(pi.registered.map((provider) => provider.id), ['a', 'c'])
  pi.model = modelOf('b')
  for (const name of ['model_select', 'before_agent_start', 'turn_start',
    'session_before_compact', 'session_before_tree', 'session_start']) {
    pi.fire(name)
  }
  assert.deepEqual(pi.registered.map((provider) => provider.id), ['a', 'c', 'b'])
  assert.deepEqual(pi.unregistered, [])
})
test('every check point wraps a provider registered over the wrapper', () => {
  const pi = started(providerOf('omni'))
  const names = ['session_start', 'model_select', 'before_agent_start', 'turn_start',
    'session_before_compact', 'session_before_tree']
  for (const name of names) {
    const other = providerOf('omni')
    pi.native.set('omni', other)
    pi.fire(name)
    assert.equal(originalOf(pi.registered.at(-1)), other, name)
  }
  assert.equal(pi.registered.length, names.length + 1)
})
test('a wrapper reached through another wrapper does not retry again', async () => {
  const provider = providerOf('omni', [failed('boom')])
  const pi = started(provider)
  const [inner] = pi.registered
  const layered: Run[] = []
  const layer = (run: Run): Run => (model, context, options) => {
    layered.push(run)
    return run(model, context, options)
  }
  const other = {
    id: 'omni',
    stream: layer(inner.stream),
    streamSimple: layer(inner.streamSimple)
  }
  pi.native.set('omni', other)
  pi.fire('turn_start')
  const outer = pi.registered.at(-1)
  assert.equal(originalOf(outer), other)
  const events = await collect(outer?.streamSimple(modelOf('omni'), {}) ?? streamOf([]))
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal(provider.calls.length, 2)
  assert.equal(layered.length, 2)
  assert.equal(pi.notices.length, 1)
})
test('a copy of a wrapper made by another extension is wrapped as it is', async () => {
  const provider = providerOf('omni', [failed('boom')])
  const pi = started(provider)
  const [inner] = pi.registered
  let layered = 0
  const other = {
    ...inner,
    streamSimple: (model: Model, context: unknown, options?: unknown) => {
      layered++
      return inner.streamSimple(model, context, options)
    }
  }
  assert.equal(originalOf(other), undefined)
  pi.native.set('omni', other)
  pi.fire('turn_start')
  const outer = pi.registered.at(-1)
  assert.equal(originalOf(outer), other)
  const events = await collect(outer?.streamSimple(modelOf('omni'), {}) ?? streamOf([]))
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal(provider.calls.length, 2)
  assert.equal(layered, 2)
  assert.equal(pi.notices.length, 1)
})
test('a new load wraps the original provider, not an old wrapper', async () => {
  const provider = providerOf('omni', [failed('boom')])
  const first = started(provider)
  const second = new FakePi(provider)
  second.model = modelOf('omni')
  second.native.set('omni', first.registered[0])
  install(second as unknown as Pi, compat, settings())
  second.fire('session_start')
  const [wrapper] = second.registered
  assert.equal(originalOf(wrapper), provider)
  const events = await collect(wrapper.streamSimple(modelOf('omni'), {}))
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal(provider.calls.length, 2)
  assert.equal(first.notices.length, 0)
  assert.equal(second.notices.length, 1)
})
test('session_shutdown gives the providers back and silences late requests', async () => {
  const provider = providerOf('omni', [failed('boom')])
  const pi = started(provider)
  const [wrapper] = pi.registered
  pi.fire('session_shutdown')
  assert.deepEqual(pi.unregistered, ['omni'])
  pi.fire('before_agent_start')
  assert.equal(pi.registered.length, 1)
  const events = await collect(wrapper.streamSimple(modelOf('omni'), {}))
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal(provider.calls.length, 2)
  assert.equal(pi.notices.length, 0)
})
test('session_shutdown keeps a provider another extension registered', () => {
  const pi = started(providerOf('omni'))
  pi.native.set('omni', providerOf('omni'))
  pi.fire('session_shutdown')
  assert.deepEqual(pi.unregistered, [])
})
test('spends the default budget of 111 seconds on the sum of the delays', async () => {
  const provider = providerOf('omni', Array.from({ length: 40 }, () => failed('boom')))
  const pi = started(provider)
  const events = await collect(pi.registered[0].streamSimple(modelOf('omni'), {}))
  assert.deepEqual(pi.notices.map((notice) => notice.delay), [1, 1, 1, 2, 2, 2, 3, 3, 3,
    4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7, 7, 7, 7, 1, 1, 1, 2])
  assert.deepEqual(pi.notices.map((notice) => notice.retry),
    Array.from({ length: 28 }, (_, index) => index + 1))
  assert.equal(pi.notices.at(-1)?.waited, 108)
  assert.equal(provider.calls.length, 29)
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
    const provider = providerOf('omni', Array.from({ length: 10 }, () => failed('boom')))
    const pi = started(provider, budget)
    const events = await collect(pi.registered[0].streamSimple(modelOf('omni'), {}))
    assert.equal(pi.notices.length, retries)
    assert.equal(provider.calls.length, retries + 1)
    assert.equal(events.at(-1)?.type, 'error')
  }
})
test('passes overflows and cancellations on without retries', async () => {
  const cases: Array<[Event[], string]> = [
    [failed('overflow'), 'error'],
    [failed('stopped', 'aborted'), 'aborted']
  ]
  for (const [outcome, reason] of cases) {
    const provider = providerOf('omni', [outcome])
    const pi = started(provider)
    const events = await collect(pi.registered[0].streamSimple(modelOf('omni'), {}))
    assert.equal(provider.calls.length, 1)
    assert.equal(pi.notices.length, 0)
    assert.equal(events.at(-1)?.reason, reason)
  }
})
test('a cancellation ends the wait before the next attempt', async () => {
  const provider = providerOf('omni', [failed('boom'), failed('boom')])
  const pi = started(provider)
  const controller = new AbortController()
  const stream = pi.registered[0].streamSimple(modelOf('omni'), {},
    { signal: controller.signal })
  await tick()
  controller.abort()
  const events = await collect(stream)
  assert.equal(provider.calls.length, 1)
  assert.equal(pi.notices.length, 0)
  const last = events.at(-1)
  assert.equal(last?.reason, 'aborted')
  assert.equal(last?.error?.errorMessage, 'Request was aborted')
})
test('parallel requests keep their own budget and counters', async () => {
  const provider = providerOf('omni')
  const x = {}
  const y = {}
  const outcomes = new Map<unknown, Event[][]>([
    [x, [failed('x'), failed('x')]],
    [y, [failed('y')]]
  ])
  provider.streamSimple = (_model, context) =>
    streamOf(outcomes.get(context)?.shift() ?? succeeded())
  const pi = started(provider)
  const [wrapper] = pi.registered
  await Promise.all([
    collect(wrapper.streamSimple(modelOf('omni'), x)),
    collect(wrapper.streamSimple(modelOf('omni'), y))
  ])
  const counters = (error: string): number[][] => pi.notices
    .filter((notice) => notice.error === error)
    .map((notice) => [notice.retry, notice.waited])
  assert.deepEqual(counters('x'), [[1, 0], [2, 1]])
  assert.deepEqual(counters('y'), [[1, 0]])
})
test('the notice follows message_update of the failed attempt', async () => {
  const outcome = failed('boom')
  const pi = started(providerOf('omni', [outcome]))
  const stream = pi.registered[0].streamSimple(modelOf('omni'), {})
  await tick()
  assert.equal(pi.notices.length, 0)
  pi.fire('message_update', { assistantMessageEvent: outcome[1] })
  await tick()
  assert.equal(pi.notices.length, 1)
  const events = await collect(stream)
  assert.equal(events.at(-1)?.type, 'done')
})
test('works without listeners of review:retry, as without log.ts', async () => {
  const provider = providerOf('omni', [failed('boom')])
  const pi = started(provider)
  pi.events.emit = () => {}
  const events = await collect(pi.registered[0].streamSimple(modelOf('omni'), {}))
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal(provider.calls.length, 2)
})
test('llmRetries 0 turns the extension off and invalid settings fail', () => {
  const off = new FakePi()
  install(off as unknown as Pi, compat, { llmRetries: 0 })
  assert.equal(off.handlers.size, 0)
  for (const value of [-1, 1.5, '1.5', '', null, true]) {
    assert.throws(() => {
      install(new FakePi() as unknown as Pi, compat, settings(value))
    }, /llmRetries must be a non-negative integer/)
  }
  for (const retry of [undefined, { enabled: true },
    { enabled: false, provider: { maxRetries: 2 } }]) {
    assert.throws(() => {
      install(new FakePi() as unknown as Pi, compat, { llmRetries: 5, retry })
    }, /retry\.enabled: false/)
  }
})
