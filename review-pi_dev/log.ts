// Pi extension for CI logs: print the session progress to stderr as plain text with
// basic ANSI colors, line by line while the model and the tools produce it.
// Types below describe only the event fields used here, so no pi package is imported.
declare const process: {
  stderr: {
    write: (text: string) => boolean
  }
}
interface Block {
  type: string
  text?: string
  mimeType?: string
}
interface Message {
  role: string
  content?: string | Block[]
  customType?: string
  display?: boolean
  stopReason?: string
  errorMessage?: string
}
interface MessageEvent {
  message: Message
}
interface UpdateEvent {
  assistantMessageEvent: {
    type: string
    contentIndex: number
    delta?: string
    content?: string
  }
}
interface ToolResult {
  content?: Block[]
  details?: {
    diff?: unknown
    truncation?: {
      totalLines?: number
    }
  }
}
interface ToolStartEvent {
  toolCallId: string
  toolName: string
  args?: unknown
}
interface ToolUpdateEvent {
  toolCallId: string
  toolName: string
  partialResult?: ToolResult
}
interface ToolEndEvent {
  toolCallId: string
  toolName: string
  result?: ToolResult
  isError: boolean
}
interface CompactEvent {
  reason: string
  compactionEntry: {
    summary: string
    tokensBefore: number
  }
}
interface CompactFailedEvent {
  reason: string
  errorMessage?: string
}
interface RetryEvent {
  error: string
  retry: number
  delay: number
  waited: number
  budget: number
}
interface Api {
  on: <T>(name: string, handler: (event: T) => void) => void
  events: {
    on: (channel: string, handler: (data: unknown) => void) => unknown
  }
}
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const CYAN = '\x1b[36m'
// A model line without a line break is cut at the last space once it grows longer than
// this, so a long paragraph still shows progress in the log.
const SOFT_LIMIT = 400
// Longest start of a new bash snapshot searched in the printed text once the output
// exceeds the bash limits and the snapshot becomes a sliding tail.
const ANCHOR_LENGTH = 200
// Every line gets its own color codes, because log viewers reset styles per line.
function print (lines: string[], style = ''): void {
  let out = ''
  for (const line of lines) {
    out += style === '' || line === '' ? `${line}\n` : `${style}${line}${RESET}\n`
  }
  if (out !== '') process.stderr.write(out)
}
function textOf (content: string | Block[] | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((block) => {
    if (block.type === 'text') return block.text ?? ''
    if (block.type === 'image') return `[image ${block.mimeType ?? ''}]`
    return ''
  }).join('\n')
}
function dropCarriageReturn (line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}
// Collect text chunks and print every completed line at once. Only model text is cut at
// spaces, tool output keeps its lines intact.
class LineStream {
  private buffer = ''
  private readonly style: string
  private readonly soft: boolean
  constructor (style = '', soft = true) {
    this.style = style
    this.soft = soft
  }

  push (chunk: string): void {
    const lines = (this.buffer + chunk).split('\n')
    this.buffer = lines.pop() ?? ''
    if (this.soft && this.buffer.length > SOFT_LIMIT) {
      const cut = this.buffer.lastIndexOf(' ')
      if (cut > 0) {
        lines.push(this.buffer.slice(0, cut))
        this.buffer = this.buffer.slice(cut + 1)
      }
    }
    print(lines.map(dropCarriageReturn), this.style)
  }

  flush (): void {
    if (this.buffer !== '') print([dropCarriageReturn(this.buffer)], this.style)
    this.buffer = ''
  }

  // Print complete lines and replace the not yet printed open line.
  reset (lines: string[], open: string): void {
    print(lines.map(dropCarriageReturn), this.style)
    this.buffer = open
  }
}
// Output of one tool call: bash sends growing snapshots of its output, so only the part
// after the already printed text goes to the log.
class ToolOutput {
  private readonly stream = new LineStream('', false)
  private printed = ''
  private emitted = 0
  readonly name: string
  readonly started = Date.now()
  constructor (name: string) {
    this.name = name
  }

  // A truncated bash snapshot keeps only the output tail without its final line break,
  // so it is matched by line numbers: the tail ends with line totalLines, which may be
  // still open. Other snapshots are matched by text.
  snapshot (text: string, totalLines?: number): void {
    if (totalLines === undefined) {
      const overlap = this.overlap(text)
      if (overlap < 0) this.skip(text)
      else this.stream.push(text.slice(overlap))
      this.emitted = text.split('\n').length - 1
    } else {
      const lines = text.split('\n')
      const first = totalLines - lines.length + 1
      if (first > this.emitted + 1) {
        print([`[… ${first - this.emitted - 1} lines of output skipped …]`], DIM)
      }
      const from = Math.max(this.emitted + 1, first)
      const open = totalLines > this.emitted ? lines[lines.length - 1] : ''
      this.stream.reset(lines.slice(from - first, lines.length - 1), open)
      this.emitted = Math.max(this.emitted, totalLines - 1)
    }
    this.printed = text
  }

  private skip (text: string): void {
    this.stream.flush()
    print(['[… earlier output skipped …]'], DIM)
    this.stream.push(text)
  }

  // Length of the printed tail the new snapshot starts with, or -1 when the snapshot
  // slid past everything printed before.
  private overlap (text: string): number {
    if (text.startsWith(this.printed)) return this.printed.length
    const head = text.slice(0, ANCHOR_LENGTH).split('\n')[0]
    let found = this.printed.indexOf(head)
    while (found >= 0) {
      if (text.startsWith(this.printed.slice(found))) return this.printed.length - found
      found = this.printed.indexOf(head, found + 1)
    }
    return -1
  }

  finish (isError: boolean): void {
    this.stream.flush()
    const seconds = ((Date.now() - this.started) / 1000).toFixed(1)
    if (isError) {
      print([`✗ ${this.name} failed after ${seconds}s`], RED)
    } else {
      print([`✓ ${this.name} done in ${seconds}s`], GREEN)
    }
  }
}
function formatValue (key: string, value: unknown): string[] {
  if (typeof value === 'string') {
    if (!value.includes('\n')) return [`  ${key}: ${value}`]
    return [`  ${key}: |`, ...value.split('\n').map((line) => `    ${line}`)]
  }
  return [`  ${key}: ${JSON.stringify(value) ?? 'undefined'}`]
}
// Bash shows its command like the TUI, edit only its path because its diff comes with
// the result, other tools show every argument on its own line.
function printCall (name: string, args: unknown): void {
  const fields: Record<string, unknown> =
    typeof args === 'object' && args !== null ? { ...args } : {}
  const { command, timeout: limit } = fields
  if (name === 'bash' && typeof command === 'string') {
    const timeout = typeof limit === 'number' ? ` (timeout ${limit}s)` : ''
    const lines = `${command}${timeout}`.split('\n')
    print([`$ ${lines[0]}`], BOLD + YELLOW)
    print(lines.slice(1).map((line) => `  ${line}`), YELLOW)
    return
  }
  if (name === 'edit') {
    print([`● edit ${String(fields.path)}`], BOLD + YELLOW)
    return
  }
  print([`● ${name}`], BOLD + YELLOW)
  for (const [key, value] of Object.entries(fields)) print(formatValue(key, value), DIM)
}
function printDiff (diff: string): void {
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) print([line], GREEN)
    else if (line.startsWith('-')) print([line], RED)
    else print([line], DIM)
  }
}
export default function (pi: Api): void {
  let stream: LineStream | undefined
  let streamKey = ''
  let received = ''
  const tools = new Map<string, ToolOutput>()
  const closeStream = (): void => {
    stream?.flush()
    stream = undefined
    streamKey = ''
  }
  // Open the stream of an assistant content block, printing its header once.
  const openStream = (kind: string, index: number): LineStream => {
    const key = `${kind}:${index}`
    if (stream !== undefined && streamKey === key) return stream
    closeStream()
    print([kind === 'thinking' ? '--- thinking' : '--- assistant'], BOLD + BLUE)
    stream = new LineStream(kind === 'thinking' ? DIM : '')
    streamKey = key
    received = ''
    return stream
  }
  const toolOf = (id: string, name: string): ToolOutput => {
    let tool = tools.get(id)
    if (tool === undefined) {
      tool = new ToolOutput(name)
      tools.set(id, tool)
    }
    return tool
  }
  pi.on<MessageEvent>('message_start', (event) => {
    const message = event.message
    if (message.role === 'user') {
      print(['>>> user'], BOLD + CYAN)
      print(textOf(message.content).split('\n'), CYAN)
    } else if (message.role === 'custom' && message.display === true) {
      print([`--- ${message.customType ?? 'custom'}`], BOLD + BLUE)
      print(textOf(message.content).split('\n'), DIM)
    }
  })
  pi.on<UpdateEvent>('message_update', (event) => {
    const update = event.assistantMessageEvent
    const kind = update.type.split('_')[0]
    if (kind !== 'thinking' && kind !== 'text') return
    const target = openStream(kind, update.contentIndex)
    if (update.type.endsWith('_end')) {
      // The end event carries the whole block, print the part never sent as deltas.
      const content = update.content ?? ''
      if (content.startsWith(received)) target.push(content.slice(received.length))
      closeStream()
    } else {
      const delta = update.delta ?? ''
      received += delta
      target.push(delta)
    }
  })
  pi.on<MessageEvent>('message_end', (event) => {
    const message = event.message
    if (message.role !== 'assistant') return
    closeStream()
    const reason = message.stopReason ?? ''
    if (reason === 'error' || reason === 'aborted') {
      print([`✗ request ${reason}: ${message.errorMessage ?? 'no details'}`], BOLD + RED)
    } else if (reason === 'length') {
      print(['✗ response stopped at the output token limit'], BOLD + RED)
    }
  })
  // retry.ts reports a failed request after the events of its attempt are printed, so
  // the open line of the attempt ends before the notice and the next attempt starts
  // under its own header.
  pi.events.on('review:retry', (data) => {
    const event = data as RetryEvent
    closeStream()
    const retry = `retry ${event.retry} in ${event.delay}s`
    const elapsed = `elapsed ${event.waited}s of ${event.budget}s`
    print([`✗ request error: ${event.error}, ${retry}, ${elapsed}`], BOLD + RED)
  })
  pi.on<ToolStartEvent>('tool_execution_start', (event) => {
    closeStream()
    toolOf(event.toolCallId, event.toolName)
    printCall(event.toolName, event.args)
  })
  pi.on<ToolUpdateEvent>('tool_execution_update', (event) => {
    const content = event.partialResult?.content
    if (content !== undefined) {
      const total = event.partialResult?.details?.truncation?.totalLines
      toolOf(event.toolCallId, event.toolName).snapshot(textOf(content), total)
    }
  })
  pi.on<ToolEndEvent>('tool_execution_end', (event) => {
    const tool = toolOf(event.toolCallId, event.toolName)
    tools.delete(event.toolCallId)
    const diff = event.result?.details?.diff
    if (typeof diff === 'string' && !event.isError) printDiff(diff)
    else tool.snapshot(textOf(event.result?.content))
    tool.finish(event.isError)
  })
  pi.on<CompactEvent>('session_compact', (event) => {
    closeStream()
    const entry = event.compactionEntry
    print([`--- compaction (${event.reason}, ${entry.tokensBefore} tokens before)`],
      BOLD + YELLOW)
    print(entry.summary.split('\n'), DIM)
  })
  pi.on<CompactFailedEvent>('session_compact_failed', (event) => {
    closeStream()
    const details = event.errorMessage ?? 'no details'
    print([`✗ compaction failed (${event.reason}): ${details}`], BOLD + RED)
  })
}
