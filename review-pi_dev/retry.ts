// Pi extension: retry every failed LLM request of the provider of the current model and
// of the providers with configured auth, except cancellations and context overflows,
// which pi handles itself. The "llmRetries" setting is the budget in seconds for the
// sum of the delays between the attempts of one request, 111 by default, and 0 turns
// the extension off. As in go-lib-ci, the delay starts at 1 second, grows by 1 second
// every 3 retries up to 7 seconds, stays there for 3 more retries and starts over. A
// wrapper is the provider pi built from its catalog, models.json and other extensions,
// registered again as a native provider with only its streams replaced, so its auth,
// OAuth, models and the streams of every api stay as they are. Events of an attempt
// reach the agent live: only the first "start" is passed on and the error of a failed
// attempt is not, so the next attempt replaces the partial message. Pi modules are
// imported by name at runtime, so the linters need no pi packages and the types below
// describe only the fields used here.
// cspell:ignore earendil
declare function setTimeout (handler: () => void, ms: number): unknown
declare function clearTimeout (id: unknown): void
interface Signal {
  aborted: boolean
  addEventListener: (type: 'abort', listener: () => void) => void
  removeEventListener: (type: 'abort', listener: () => void) => void
}
interface Model {
  id: string
  api: string
  provider: string
  contextWindow?: number
}
interface Options {
  signal?: Signal
  [NESTED]?: boolean
}
interface Message {
  role: 'assistant'
  content: unknown[]
  api: string
  provider: string
  model: string
  usage: unknown
  stopReason: string
  errorMessage?: string
  timestamp: number
}
interface StreamEvent {
  type: string
  reason?: string
  error?: Message
}
interface Stream extends AsyncIterable<StreamEvent> {
  push: (event: StreamEvent) => void
}
type StreamFunction = (model: Model, context: unknown, options?: Options) => Stream
interface Compat {
  createAssistantMessageEventStream: () => Stream
  isContextOverflow: (message: Message, contextWindow?: number) => boolean
}
interface Provider {
  readonly id: string
  stream: StreamFunction
  streamSimple: StreamFunction
}
interface Registry {
  getAvailable: () => Model[]
  getProvider: (id: string) => Provider | undefined
  getRegisteredNativeProvider: (id: string) => Provider | undefined
}
interface Context {
  model: Model | undefined
  modelRegistry: Registry
}
interface PiRetry {
  enabled?: unknown
  provider?: {
    maxRetries?: unknown
  }
}
type Settings = Record<string, unknown>
interface UpdateEvent {
  assistantMessageEvent: object
}
interface Api {
  on: <T>(name: string, handler: (event: T, ctx: Context) => void) => void
  registerProvider: (provider: Provider) => void
  unregisterProvider: (name: string) => void
  events: {
    emit: (channel: string, data: unknown) => void
  }
}
// Module names are kept in constants, so TypeScript does not look for their types.
const COMPAT = '@earendil-works/pi-ai/compat'
const AGENT = '@earendil-works/pi-coding-agent'
const FS = 'node:fs'
const PATH = 'node:path'
const DEFAULT_BUDGET = 111
// Backoff of go-lib-ci in seconds.
const INITIAL_DELAY = 1
const DELAY_STEP = 1
const STEP_RETRIES = 3
const MAX_DELAY = 7
// Events after which pi may send a request through a provider not wrapped yet: no event
// tells about providers registered later, so the wrappers are checked before requests.
const COVER_EVENTS = ['session_start', 'model_select', 'before_agent_start', 'turn_start',
  'session_before_compact', 'session_before_tree']
// The key is the same for every load of this module, so after /reload a wrapper left by
// an earlier load still leads to the provider it wraps and is never wrapped again.
const ORIGINAL: unique symbol = Symbol.for('review-pi_dev.retry.original')
// A wrapper marks the options of its attempts, so a wrapper it reaches through a provider
// another extension registered over a wrapper passes the request on without retries, as
// long as that provider passes the options on, as they are or copied by spread, instead
// of building them from named fields.
const NESTED: unique symbol = Symbol.for('review-pi_dev.retry.nested')
interface Wrapper extends Provider {
  [ORIGINAL]: Provider
}
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
// Resolve after the delay or once the request is aborted.
async function sleep (ms: number, signal?: Signal): Promise<void> {
  return await new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done)
  })
}
// The setting is a string from the "env<NAME>" placeholder or a number from JSON.
function budgetOf (value: unknown): number {
  if (value === undefined) return DEFAULT_BUDGET
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || !/^\d+$/.test(text) ||
    !Number.isSafeInteger(Number(text))) {
    const shown = String(JSON.stringify(value))
    throw new Error(`llmRetries must be a non-negative integer, got ${shown}`)
  }
  return Number(text)
}
// Delay in seconds before the retry with the given number, counted from 1: the delay
// grows by DELAY_STEP every STEP_RETRIES retries up to MAX_DELAY, stays there for one
// more block of retries and then starts over from INITIAL_DELAY.
function delayOf (retry: number): number {
  const cycle = (Math.floor(MAX_DELAY / DELAY_STEP) + 1) * STEP_RETRIES
  const block = Math.floor(((retry - 1) % cycle) / STEP_RETRIES)
  return Math.min(block * DELAY_STEP + INITIAL_DELAY, MAX_DELAY)
}
// Retries of pi itself would multiply the attempts made here.
function checkPiRetries (value: unknown): void {
  const retry = (typeof value === 'object' && value !== null ? value : {}) as PiRetry
  const limit = retry.provider?.maxRetries
  const multiplied = limit !== undefined && !(typeof limit === 'number' && limit <= 0)
  if (retry.enabled !== false || multiplied) {
    throw new Error('llmRetries needs retry.enabled: false and ' +
      'retry.provider.maxRetries unset or not above 0 in settings.json')
  }
}
// The provider a wrapper of any load of this module wraps.
function originalOf (provider: Provider | undefined): Provider | undefined {
  return (provider as Partial<Wrapper> | undefined)?.[ORIGINAL]
}
// Shared state of all requests of one load of the extension: the retry budget, the
// wrappers it registered and the assistant events already handled by the extensions
// loaded before this one, log.ts among them.
class Retries {
  readonly compat: Compat
  readonly budget: number
  private readonly pi: Api
  private active = true
  private readonly wrappers = new Map<string, Provider>()
  private readonly handled = new WeakSet<object>()
  private readonly waiters = new Map<object, () => void>()
  constructor (pi: Api, compat: Compat, budget: number) {
    this.pi = pi
    this.compat = compat
    this.budget = budget
  }

  // Extensions get message events one after another, so once this handler sees an
  // event, the handlers of the extensions loaded earlier are done with it.
  handle (event: object): void {
    this.handled.add(event)
    this.waiters.get(event)?.()
    this.waiters.delete(event)
  }

  // Wait until the event is handled or the timer ends: streams outside the agent loop,
  // like compaction, never become message events.
  async settle (event: object | undefined, timer: Promise<void>): Promise<void> {
    if (event === undefined || this.handled.has(event)) return
    const handled = new Promise<void>((resolve) => this.waiters.set(event, resolve))
    await Promise.race([handled, timer])
    this.waiters.delete(event)
  }

  // The pi of an ended session is stale, so requests finishing later stay silent.
  notify (data: object): void {
    if (this.active) this.pi.events.emit('review:retry', data)
  }

  // Wrap the provider of the current model and every provider with configured auth,
  // unless its native provider is a wrapper of this load already. Wrappers of other
  // providers stay registered when the current model changes.
  cover (ctx: Context): void {
    if (!this.active) return
    const registry = ctx.modelRegistry
    const ids = new Set(registry.getAvailable().map((model) => model.provider))
    const current = ctx.model
    if (current !== undefined) ids.add(current.provider)
    for (const id of ids) {
      const native = registry.getRegisteredNativeProvider(id)
      if (native !== undefined && native === this.wrappers.get(id)) continue
      const original = originalOf(native) ?? registry.getProvider(id)
      if (original === undefined) continue
      const wrapper = {
        ...original,
        stream: this.wrap((model, context, options) =>
          original.stream(model, context, options)),
        streamSimple: this.wrap((model, context, options) =>
          original.streamSimple(model, context, options))
      }
      // A copy of the wrapper made by another extension must not lead past its streams.
      Object.defineProperty(wrapper, ORIGINAL, { value: original })
      this.wrappers.set(id, wrapper)
      this.pi.registerProvider(wrapper)
    }
  }

  // Give the providers back when the session ends: after /reload the registry is the
  // same, but the pi of this load is stale. A provider registered over a wrapper since
  // belongs to another extension and stays.
  release (ctx: Context): void {
    this.active = false
    for (const [id, wrapper] of this.wrappers) {
      if (ctx.modelRegistry.getRegisteredNativeProvider(id) === wrapper) {
        this.pi.unregisterProvider(id)
      }
    }
    this.wrappers.clear()
  }

  wrap (base: StreamFunction): StreamFunction {
    return (model, context, options) => options?.[NESTED] === true
      ? base(model, context, options)
      : new RetryingRequest(this, base, model, context, options).start()
  }
}
// One LLM request: its attempts reach the agent through a single stream.
class RetryingRequest {
  private readonly retries: Retries
  private readonly base: StreamFunction
  private readonly model: Model
  private readonly context: unknown
  private readonly options: Options | undefined
  private readonly stream: Stream
  private started = false
  private last: object | undefined
  constructor (retries: Retries, base: StreamFunction, model: Model, context: unknown,
    options: Options | undefined) {
    this.retries = retries
    this.base = base
    this.model = model
    this.context = context
    this.options = options
    this.stream = retries.compat.createAssistantMessageEventStream()
  }

  start (): Stream {
    void this.run().catch((error: unknown) => { this.finish(this.failure(error)) })
    return this.stream
  }

  private async run (): Promise<void> {
    let waited = 0
    for (let retry = 1; ; retry++) {
      const failure = await this.attempt()
      if (failure === undefined) return
      const delay = delayOf(retry)
      // Stop once the next delay would push the sum of the delays past the budget.
      if (waited + delay > this.retries.budget || !this.retryable(failure)) {
        this.finish(failure)
        return
      }
      const timer = sleep(delay * 1000, this.options?.signal)
      // The notice must follow the events of the failed attempt in the log.
      await this.retries.settle(this.last, timer)
      if (this.aborted()) {
        this.finish(this.abort(failure))
        return
      }
      this.retries.notify({
        error: failure.errorMessage ?? 'no details',
        retry,
        delay,
        waited,
        budget: this.retries.budget
      })
      await timer
      if (this.aborted()) {
        this.finish(this.abort(failure))
        return
      }
      waited += delay
    }
  }

  // Pass the events of one attempt on and return its failure, or undefined when it
  // succeeded. Only the first start reaches the agent, so a later attempt replaces the
  // partial message instead of adding another one.
  private async attempt (): Promise<Message | undefined> {
    try {
      const options = { ...this.options, [NESTED]: true }
      for await (const event of this.base(this.model, this.context, options)) {
        if (event.type === 'error') return event.error ?? this.failure('no details')
        if (event.type === 'start') {
          if (this.started) continue
          this.started = true
        } else if (event.type !== 'done') {
          this.last = event
        }
        this.stream.push(event)
        if (event.type === 'done') return undefined
      }
    } catch (error) {
      return this.failure(error)
    }
    return this.failure('stream ended without a result')
  }

  private aborted (): boolean {
    return this.options?.signal?.aborted === true
  }

  private retryable (failure: Message): boolean {
    if (this.aborted() || failure.stopReason === 'aborted') return false
    return !this.retries.compat.isContextOverflow(failure, this.model.contextWindow)
  }

  private abort (failure: Message): Message {
    return { ...failure, stopReason: 'aborted', errorMessage: 'Request was aborted' }
  }

  // Error message for a stream that threw instead of reporting its error.
  private failure (error: unknown): Message {
    return {
      role: 'assistant',
      content: [],
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      usage: ZERO_USAGE,
      stopReason: this.aborted() ? 'aborted' : 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now()
    }
  }

  private finish (failure: Message): void {
    const reason = failure.stopReason === 'aborted' ? 'aborted' : 'error'
    this.stream.push({ type: 'error', reason, error: failure })
  }
}
// Check the settings and subscribe to the events; kept apart from the imports for tests.
export function install (pi: Api, compat: Compat, settings: Settings): void {
  const budget = budgetOf(settings.llmRetries)
  if (budget === 0) return
  checkPiRetries(settings.retry)
  const retries = new Retries(pi, compat, budget)
  pi.on<UpdateEvent>('message_update', (event) => {
    retries.handle(event.assistantMessageEvent)
  })
  for (const name of COVER_EVENTS) {
    pi.on<unknown>(name, (_event, ctx) => { retries.cover(ctx) })
  }
  pi.on<unknown>('session_shutdown', (_event, ctx) => { retries.release(ctx) })
}
export default async function (pi: Api): Promise<void> {
  const compat = await import(COMPAT) as Compat
  const { getAgentDir } = await import(AGENT) as { getAgentDir: () => string }
  const { readFileSync } = await import(FS) as {
    readFileSync: (path: string, encoding: 'utf8') => string
  }
  const { join } = await import(PATH) as { join: (...parts: string[]) => string }
  const text = readFileSync(join(getAgentDir(), 'settings.json'), 'utf8')
  install(pi, compat, JSON.parse(text) as Settings)
}
