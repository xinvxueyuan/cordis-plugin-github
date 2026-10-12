/**
 * CI payload normalization and state diffing. Pure functions over the JSON the
 * GitHub API returns — the poller turns snapshots into model-visible lines.
 */

/** One job (or check run) inside a monitored CI subject. */
export type CiUnit = {
  id: number | null
  name: string
  status: string
  conclusion: string | null
}

/** Normalized state of the monitored CI subject at one poll. */
export interface CiSnapshot {
  /** `queued` / `in_progress` / `completed` (or the check-run equivalent). */
  status: string
  conclusion: string | null
  units: CiUnit[]
  /** True once the subject reached its terminal state. */
  terminal: boolean
}

/** Conclusions that count as a failed unit in the final report. */
const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readUnit(value: unknown, fallbackName: string): CiUnit | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const name = readString(record, 'name') ?? fallbackName
  const status = readString(record, 'status') ?? 'unknown'
  const conclusion = readString(record, 'conclusion') ?? null
  const id = readNumber(record, 'id') ?? null
  return { name, status, conclusion, id }
}

/** Normalize one Actions run plus its jobs payload into a snapshot. */
export function snapshotFromRun(run: unknown, jobs: unknown): CiSnapshot {
  const runRecord = asRecord(run)
  if (runRecord === undefined) {
    throw new Error('github_ci_watch: GitHub 返回的 run 载荷不是对象，无法归一化')
  }
  const status = readString(runRecord, 'status') ?? 'unknown'
  const conclusion = readString(runRecord, 'conclusion') ?? null
  const jobsRecord = asRecord(jobs)
  const rawJobs = jobsRecord !== undefined && Array.isArray(jobsRecord.jobs) ? jobsRecord.jobs : []
  const units: CiUnit[] = []
  rawJobs.forEach((entry, index) => {
    const unit = readUnit(entry, `job ${index + 1}`)
    if (unit !== undefined) units.push(unit)
  })
  return { status, conclusion, units, terminal: status === 'completed' }
}

/** Units that did not conclude successfully. */
export function failedUnits(snapshot: CiSnapshot): CiUnit[] {
  return snapshot.units.filter((unit) => unit.conclusion !== null && FAILURE_CONCLUSIONS.has(unit.conclusion))
}

/**
 * Status lines describing what changed since `previous`. The first call
 * describes the whole current state; later calls only report transitions.
 */
export function diffSnapshots(previous: CiSnapshot | undefined, next: CiSnapshot): string[] {
  const lines: string[] = []
  if (previous === undefined) {
    lines.push(`状态: ${next.status}`)
    for (const unit of next.units) {
      lines.push(`单元 "${unit.name}": ${unit.status}${unit.conclusion !== null ? ` (${unit.conclusion})` : ''}`)
    }
  } else {
    if (previous.status !== next.status) lines.push(`状态: ${previous.status} → ${next.status}`)
    const before = new Map(previous.units.map((unit) => [unit.name, unit]))
    for (const unit of next.units) {
      const prior = before.get(unit.name)
      if (prior === undefined) {
        lines.push(`单元 "${unit.name}": 出现 ${unit.status}${unit.conclusion !== null ? ` (${unit.conclusion})` : ''}`)
        continue
      }
      if (prior.status !== unit.status || prior.conclusion !== unit.conclusion) {
        lines.push(
          `单元 "${unit.name}": ${prior.status}${prior.conclusion !== null ? ` (${prior.conclusion})` : ''} → ${unit.status}${unit.conclusion !== null ? ` (${unit.conclusion})` : ''}`,
        )
      }
    }
    for (const unit of previous.units) {
      if (!next.units.some((candidate) => candidate.name === unit.name)) {
        lines.push(`单元 "${unit.name}": 消失`)
      }
    }
  }
  if (next.terminal && (previous === undefined || !previous.terminal)) {
    lines.push(`终态: ${next.status}${next.conclusion !== null ? ` (${next.conclusion})` : ''}`)
  }
  return lines
}

/** Normalize one check suite plus its check runs into a snapshot. */
export function snapshotFromCheckSuite(suite: unknown, checkRuns: unknown): CiSnapshot {
  const suiteRecord = asRecord(suite)
  if (suiteRecord === undefined) {
    throw new Error('github_ci_watch: GitHub 返回的 check suite 载荷不是对象，无法归一化')
  }
  const runsRecord = asRecord(checkRuns)
  const rawRuns = runsRecord !== undefined && Array.isArray(runsRecord.check_runs) ? runsRecord.check_runs : []
  const units: CiUnit[] = []
  rawRuns.forEach((entry, index) => {
    const unit = readUnit(entry, `check run ${index + 1}`)
    if (unit !== undefined) units.push(unit)
  })
  const status = readString(suiteRecord, 'status') ?? 'unknown'
  const conclusion = readString(suiteRecord, 'conclusion') ?? null
  return { status, conclusion, units, terminal: status === 'completed' }
}

/** Normalize one check run into a snapshot; the check run is its own unit. */
export function snapshotFromCheckRun(checkRun: unknown): CiSnapshot {
  const record = asRecord(checkRun)
  if (record === undefined) {
    throw new Error('github_ci_watch: GitHub 返回的 check run 载荷不是对象，无法归一化')
  }
  const status = readString(record, 'status') ?? 'unknown'
  const conclusion = readString(record, 'conclusion') ?? null
  const unit = readUnit(record, 'check run')
  return { status, conclusion, units: unit !== undefined ? [unit] : [], terminal: status === 'completed' }
}

/** Strip terminal escape sequences — Actions logs are ANSI-colored. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
}

/** Result of tail-truncating a log body. */
export interface TailTruncation {
  text: string
  truncated: boolean
  totalLines: number
  keptLines: number
  droppedBytes: number
}

/**
 * Keep the tail of a log: at most `maxLines` trailing lines and at most
 * `maxBytes` UTF-8 bytes. Truncation drops from the front, never the tail.
 */
export function truncateTail(text: string, maxLines: number, maxBytes: number): TailTruncation {
  const normalized = text.replace(/\r\n/g, '\n')
  const all = normalized.split('\n')
  const totalBytes = Buffer.byteLength(normalized, 'utf8')
  const lineLimit = Math.max(1, Math.floor(maxLines))
  const byteLimit = Math.max(1, Math.floor(maxBytes))
  const startLine = Math.max(0, all.length - lineLimit)
  let body = all.slice(startLine).join('\n')
  let truncated = startLine > 0
  if (Buffer.byteLength(body, 'utf8') > byteLimit) {
    const chars = [...body]
    let start = 0
    let bytes = Buffer.byteLength(body, 'utf8')
    while (bytes > byteLimit && start < chars.length) {
      bytes -= Buffer.byteLength(chars[start], 'utf8')
      start += 1
    }
    body = chars.slice(start).join('')
    truncated = true
  }
  return {
    text: body.replace(/^\n+/, ''),
    truncated,
    totalLines: all.length,
    keptLines: all.length - startLine,
    droppedBytes: Math.max(0, totalBytes - Buffer.byteLength(body, 'utf8')),
  }
}
