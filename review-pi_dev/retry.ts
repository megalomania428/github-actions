// Pi extension for CI runs: retry every failed LLM request of the providers configured
// in models.json, except cancellations and context overflows, which pi handles itself.
// The "llmRetries" setting is the budget in seconds for the sum of the delays between
// attempts, 111 by default. As in go-lib-ci, the delay starts at 1 second, grows by 1
// second every 3 retries up to 7 seconds, stays there for 3 more retries and starts
// over. Events of an attempt reach the agent live: only the first "start" is passed on
// and the error of a failed attempt is not, so the next attempt replaces the partial
// message. Pi modules are imported by name at runtime, so the linters need no pi
// packages and the types below describe only the fields used here.
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
type StreamSimple = (model: Model, context: unknown, options?: Options) => Stream
interface BuiltinModel {
  id: string
  api: string
}
interface Compat {
  getApiProvider: (api: string) => { streamSimple: StreamSimple } | undefined
  createAssistantMessageEventStream: () => Stream
  isContextOverflow: (message: Message, contextWindow?: number) => boolean
  getModels: (provider: string) => BuiltinModel[]
}
interface ProviderConfig {
  api?: unknown
  models?: Array<{ id?: unknown, api?: unknown }>
}
interface PiRetry {
  enabled?: unknown
  provider?: {
    maxRetries?: unknown
  }
}
interface UpdateEvent {
  assistantMessageEvent: object
}
interface Registration {
  api: string
  streamSimple: StreamSimple
}
interface Api {
  on: <T>(name: string, handler: (event: T) => void) => void
  registerProvider: (name: string, config: Registration) => void
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
// The stream of a provider is replaced for one api, so all its models must use it,
// including the built-in models of pi a provider with a built-in name keeps.
function apiOf (name: string, config: ProviderConfig, builtins: BuiltinModel[]): string {
  const apis = new Set<unknown>(config.api === undefined ? [] : [config.api])
  for (const model of config.models ?? []) apis.add(model.api ?? config.api)
  const [api] = apis
  if (apis.size !== 1 || typeof api !== 'string') {
    throw new Error(`provider "${name}" in models.json needs one api for all its models`)
  }
  const ids = new Set((config.models ?? []).map((model) => model.id))
  const other = builtins.find((model) => !ids.has(model.id) && model.api !== api)
  if (other !== undefined) {
    throw new Error(`provider "${name}" in models.json keeps built-in model ` +
      `"${other.id}" with api "${other.api}" instead of "${api}"`)
  }
  return api
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
// Shared state of all requests: the retry budget and the assistant events already
// handled by the extensions loaded before this one, log.ts among them.
class Retries {
  readonly pi: Api
  readonly compat: Compat
  readonly budget: number
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

  wrap (base: StreamSimple): StreamSimple {
    return (model, context, options) =>
      new RetryingRequest(this, base, model, context, options).start()
  }
}
// One LLM request: its attempts reach the agent through a single stream.
class RetryingRequest {
  private readonly retries: Retries
  private readonly base: StreamSimple
  private readonly model: Model
  private readonly context: unknown
  private readonly options: Options | undefined
  private readonly stream: Stream
  private started = false
  private last: object | undefined
  constructor (retries: Retries, base: StreamSimple, model: Model, context: unknown,
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
      this.retries.pi.events.emit('review:retry', {
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
      for await (const event of this.base(this.model, this.context, this.options)) {
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
export default async function (pi: Api): Promise<void> {
  const compat = await import(COMPAT) as Compat
  const { getAgentDir } = await import(AGENT) as { getAgentDir: () => string }
  const { readFileSync } = await import(FS) as {
    readFileSync: (path: string, encoding: 'utf8') => string
  }
  const { join } = await import(PATH) as { join: (...parts: string[]) => string }
  const read = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(getAgentDir(), name), 'utf8')) as Record<string, unknown>
  const settings = read('settings.json')
  const budget = budgetOf(settings.llmRetries)
  if (budget === 0) return
  checkPiRetries(settings.retry)
  const retries = new Retries(pi, compat, budget)
  pi.on<UpdateEvent>('message_update', (event) => {
    retries.handle(event.assistantMessageEvent)
  })
  const providers = read('models.json').providers
  if (typeof providers !== 'object' || providers === null ||
    Object.keys(providers).length === 0) {
    throw new Error('models.json has no providers to retry')
  }
  const configs = providers as Record<string, ProviderConfig>
  for (const [name, config] of Object.entries(configs)) {
    const api = apiOf(name, config, compat.getModels(name))
    const base = compat.getApiProvider(api)
    if (base === undefined) {
      throw new Error(`provider "${name}" in models.json has unknown api "${api}"`)
    }
    pi.registerProvider(name, { api, streamSimple: retries.wrap(base.streamSimple) })
  }
}
