/**
 * The CI monitoring loop: poll one target, emit status transitions, back off on
 * failures, and settle on the terminal state. Clock, sleep, and client are
 * injectable so the loop is testable without network or real time.
 *
 * The loop's *job* succeeds whenever CI reaches a terminal state — even a
 * failing CI verdict; only a monitor fault (auth, 404, repeated network
 * errors) rejects.
 */

import { diffSnapshots, failedUnits, stripAnsi, truncateTail, type CiSnapshot } from './ci-status.ts'
import type { CiClient } from './ci-client.ts'
import type { CiTarget } from './ci-target.ts'

/** How much log the final report carries. */
export type LogTailPolicy = 'failure' | 'always' | 'none'

/** Where the loop writes: model-visible status, UI-only narration, errors. */
export interface CiSink {
  /** Status transitions — appended to the model-visible channel. */
  status(line: string): void
  /** Narration that only the UI shows (job log channel). */
  narrate(line: string): void
  /** Monitoring problems (job stderr channel). */
  error(line: string): void
  /** The live progress line. */
  progress(line: string): void
}

export interface CiMonitorOptions {
  target: CiTarget
  client: CiClient
  sink: CiSink
  /** Base polling interval in milliseconds. */
  intervalMs: number
  /** Cancels the loop; the monitor rejects with an AbortError. */
  signal?: AbortSignal
  /** Injectable sleep (default: real timer that rejects on abort). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Injectable wall clock (default: Date.now). */
  now?: () => number
  /** Consecutive poll failures that fail the monitor instead of backing off. */
  maxConsecutiveFailures?: number
  /** Log tail policy at the terminal state (default `failure`). */
  logTail?: LogTailPolicy
  /** Per-unit log tail line cap. */
  maxLogLines?: number
  /** Per-unit log tail byte cap. */
  maxLogBytes?: number
}

/** Result of a monitor that reached the subject's terminal state. */
export interface CiMonitorResult {
  snapshot: CiSnapshot
  /** Successful polls. */
  polls: number
  /** Polls that threw (including the ones that were retried). */
  failures: number
  /** Milliseconds from the first poll to settlement. */
  elapsedMs: number
  /** The status lines emitted, in order. */
  timeline: string[]
  /** Truncated log tail when the policy asked for it and logs were readable. */
  logTail?: string
  /** Which units the log tail covers. */
  logSource?: string
}

/** Thrown when the monitor is cancelled. */
export class CiAbortedError extends Error {
  constructor() {
    super('github_ci_watch: 监控已中止')
    this.name = 'AbortError'
  }
}

/** Backoff for consecutive failures: 5s, 10s, ... capped at 60s. */
export function backoffMs(failures: number): number {
  if (failures <= 1) return 5000
  return Math.min(60000, 5000 * 2 ** (failures - 1))
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new CiAbortedError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new CiAbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface CollectedLogs {
  logTail?: string
  logSource?: string
}

/**
 * Best-effort log tail for the terminal report. A failing log fetch is a
 * warning, never a monitor failure: the CI verdict is already known.
 */
async function collectTerminalLogs(options: {
  target: CiTarget
  client: CiClient
  snapshot: CiSnapshot
  policy: LogTailPolicy
  maxLogLines: number
  maxLogBytes: number
  signal?: AbortSignal
  sink: CiSink
}): Promise<CollectedLogs> {
  const { target, client, snapshot, policy, maxLogLines, maxLogBytes, sink } = options
  if (policy === 'none') return {}
  const signal = options.signal
  try {
    if (target.kind !== 'run') {
      const raw = await client.fetchCheckOutput(target, signal)
      if (raw.trim().length === 0) return {}
      const truncated = truncateTail(stripAnsi(raw), maxLogLines, maxLogBytes)
      return {
        logTail: truncated.truncated ? `${truncated.text}\n…（已截断：原文 ${truncated.totalLines} 行）` : truncated.text,
        logSource: `${target.kind} 输出`,
      }
    }
    const candidates = (policy === 'always' ? snapshot.units : failedUnits(snapshot)).filter(
      (unit) => unit.id !== null,
    )
    if (candidates.length === 0) return {}
    const blocks: string[] = []
    for (const unit of candidates) {
      const id = unit.id as number
      sink.narrate(`抓取单元 "${unit.name}" 的日志尾部…`)
      try {
        const raw = await client.fetchJobLog(target, id, signal)
        const truncated = truncateTail(stripAnsi(raw), maxLogLines, maxLogBytes)
        const marker = truncated.truncated ? `（已截断：原文 ${truncated.totalLines} 行）` : ''
        blocks.push(`--- ${unit.name} (job ${id}) ${marker}\n${truncated.text}`)
      } catch (error) {
        sink.error(`日志抓取失败（单元 "${unit.name}"）: ${errorMessage(error)}`)
      }
    }
    if (blocks.length === 0) return {}
    return { logTail: blocks.join('\n'), logSource: candidates.map((unit) => unit.name).join(', ') }
  } catch (error) {
    sink.error(`日志抓取失败: ${errorMessage(error)}`)
    return {}
  }
}

/**
 * Poll until the target reaches its terminal state, reporting every change
 * through the sink. Rejects on cancellation or on too many consecutive
 * failures; a CI failure conclusion is a *successful* monitor run.
 */
export async function monitorCi(options: CiMonitorOptions): Promise<CiMonitorResult> {
  const { target, client, sink, intervalMs } = options
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5
  const policy: LogTailPolicy = options.logTail ?? 'failure'
  const maxLogLines = options.maxLogLines ?? 200
  const maxLogBytes = options.maxLogBytes ?? 65536
  const startedAt = now()
  const timeline: string[] = []
  let previous: CiSnapshot | undefined
  let polls = 0
  let failures = 0

  const throwIfAborted = (): void => {
    if (options.signal?.aborted === true) throw new CiAbortedError()
  }

  for (;;) {
    throwIfAborted()
    let snapshot: CiSnapshot
    try {
      const payload = await client.fetchSnapshot(target, options.signal)
      snapshot = payload
      polls += 1
      if (failures > 0) {
        const recovered = `轮询恢复（此前连续失败 ${failures} 次）`
        sink.status(recovered)
        timeline.push(recovered)
        failures = 0
      }
    } catch (error) {
      if (error instanceof CiAbortedError || options.signal?.aborted === true) throw new CiAbortedError()
      failures += 1
      const message = errorMessage(error)
      sink.error(`轮询失败 (${failures}/${maxConsecutiveFailures}): ${message}`)
      if (failures >= maxConsecutiveFailures) {
        throw new Error(`监控失败: 连续 ${failures} 次轮询出错，最后错误: ${message}`)
      }
      await sleep(backoffMs(failures), options.signal)
      continue
    }

    const lines = diffSnapshots(previous, snapshot)
    for (const line of lines) {
      sink.status(line)
      timeline.push(line)
    }
    previous = snapshot
    sink.progress(
      `${target.kind} ${target.repo}#${target.runId ?? target.checkSuiteId ?? target.checkRunId}: ${snapshot.status}${
        snapshot.conclusion !== null ? ` (${snapshot.conclusion})` : ''
      } · 第 ${polls} 次轮询`,
    )
    if (snapshot.terminal) {
      const logs = await collectTerminalLogs({
        target,
        client,
        snapshot,
        policy,
        maxLogLines,
        maxLogBytes,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        sink,
      })
      return {
        snapshot,
        polls,
        failures,
        elapsedMs: now() - startedAt,
        timeline,
        ...logs,
      }
    }
    await sleep(intervalMs, options.signal)
  }
}
