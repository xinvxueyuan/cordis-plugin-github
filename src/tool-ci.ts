/**
 * The `github_ci_watch` tool: one long-lived CI watch with two modes.
 *
 * - `foreground` (default) waits for the terminal state inside the call and
 *   returns the final report; on timeout the still-running job is handed back
 *   as a promoted handle (its id) instead of being killed.
 * - `background` registers the watch as a `ci` job and returns the job id
 *   immediately. The model reads it with the built-in `job_output` /
 *   `job_list` and stops it with `job_kill`; the existing job machinery
 *   reports the terminal state in a later round.
 *
 * Either way the *job* completes when the CI reaches any terminal state, even
 * a failing one; only a monitoring fault (auth, 404, repeated network errors)
 * fails the job.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JobHandle, JobHooks, JobId, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import { parseCiTarget, describeTarget, type CiTarget } from './ci-target.ts'
import { createCiClient, type CiClient } from './ci-client.ts'
import { monitorCi, type CiMonitorResult, type LogTailPolicy } from './ci-poller.ts'
import { failedUnits, type CiUnit } from './ci-status.ts'
import type { GithubConfig } from './config.ts'
import type { JsonValue } from './types.ts'
import { CI_JOB_KIND } from './jobs-seam.ts'

/** Hard cap for a foreground wait, independent of configuration. */
const FOREGROUND_TIMEOUT_CAP = 600000
/** Polling faster than this is refused (rate-limit protection). */
const MIN_INTERVAL_MS = 5000

/** The registry fences access by session id; `exec.agent.id` is a plain string. */
type Caller = Parameters<JobRegistry['list']>[0]

export interface CiReport {
  target: string
  status: string
  conclusion: string | null
  failedUnits: CiUnit[]
  polls: number
  elapsedMs: number
  logTail?: string
  logSource?: string
}

export interface CiWatchArgs {
  repo?: string
  run_url?: string
  run_id?: number
  check_suite_id?: number
  check_run_id?: number
  mode?: 'foreground' | 'background'
  timeout_ms?: number
  interval_ms?: number
  log_tail?: LogTailPolicy
  max_log_lines?: number
  host?: string
}

/** Test seam: inject the client factory / monitor instead of real I/O. */
export interface CiToolDeps {
  createClient?: (config: GithubConfig) => CiClient
  monitor?: typeof monitorCi
}

interface WatchPlan {
  target: CiTarget
  client: CiClient
  intervalMs: number
  label: string
  owner: Caller
  logTail: LogTailPolicy
  maxLogLines: number
  maxLogBytes: number
}

/** Terminal state of one registered watch, for the waiting caller. */
type WatchOutcome = { ok: true; result: CiMonitorResult } | { ok: false; error: string }

interface StartedWatch {
  id: JobId
  outcome: Promise<WatchOutcome>
}

function buildReport(target: CiTarget, result: CiMonitorResult): CiReport {
  return {
    target: describeTarget(target),
    status: result.snapshot.status,
    conclusion: result.snapshot.conclusion,
    failedUnits: failedUnits(result.snapshot),
    polls: result.polls,
    elapsedMs: result.elapsedMs,
    ...(result.logTail !== undefined ? { logTail: result.logTail } : {}),
    ...(result.logSource !== undefined ? { logSource: result.logSource } : {}),
  }
}

export function renderReport(report: CiReport): string {
  const headline = `${report.target}: ${report.status}${report.conclusion !== null ? ` (${report.conclusion})` : ''}`
  const lines = [headline]
  if (report.failedUnits.length > 0) {
    lines.push(`失败单元 (${report.failedUnits.length}):`)
    for (const unit of report.failedUnits) {
      lines.push(`  - ${unit.name}: ${unit.conclusion}${unit.id !== null ? ` (job ${unit.id})` : ''}`)
    }
  } else {
    lines.push('失败单元: 无')
  }
  lines.push(`轮询 ${report.polls} 次，用时 ${report.elapsedMs}ms`)
  if (report.logTail !== undefined) {
    lines.push(`日志尾部（${report.logSource ?? '未标注来源'}）:`)
    lines.push(report.logTail)
  }
  return lines.join('\n')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the watch as a `ci` job. The loop starts inside the starter; the
 * job settles `completed` for *any* CI conclusion and only fails when the
 * monitor itself broke.
 */
function startWatch(registry: JobRegistry, plan: WatchPlan, runMonitor: typeof monitorCi): StartedWatch {
  let settle: ((outcome: WatchOutcome) => void) | undefined
  const outcome = new Promise<WatchOutcome>((resolve) => {
    settle = resolve
  })
  const id = registry.start({
    kind: CI_JOB_KIND,
    label: plan.label,
    ...(plan.owner !== undefined ? { owner: plan.owner } : {}),
    run: (job: JobHandle): JobHooks => {
      const watcher = new AbortController()
      const sink = {
        status: (line: string): void => job.append(`${line}\n`),
        narrate: (line: string): void => job.append(`${line}\n`, { channel: 'log' }),
        error: (line: string): void => job.append(`${line}\n`, { channel: 'stderr' }),
        progress: (line: string): void => job.updateProgress(line),
      }
      const done = (async (): Promise<JobOutcome> => {
        try {
          const result = await runMonitor({
            target: plan.target,
            client: plan.client,
            sink,
            intervalMs: plan.intervalMs,
            signal: watcher.signal,
            logTail: plan.logTail,
            maxLogLines: plan.maxLogLines,
            maxLogBytes: plan.maxLogBytes,
          })
          const report = buildReport(plan.target, result)
          const summary = `${report.status}${report.conclusion !== null ? ` (${report.conclusion})` : ''}`
          // The ring carries the timeline plus one closing line; the full report
          // travels in `result`, so a settled job's first read shows it once.
          job.append(`监控结束: ${summary}\n`)
          settle?.({ ok: true, result })
          return {
            status: 'completed',
            detail: summary,
            result: renderReport(report),
          }
        } catch (error) {
          if (watcher.signal.aborted) {
            settle?.({ ok: false, error: 'github_ci_watch: 监控已停止' })
            return { status: 'killed', detail: '监控已停止' }
          }
          const message = errorText(error)
          settle?.({ ok: false, error: message })
          return { status: 'failed', detail: message }
        }
      })()
      return {
        done,
        cancel: (): void => {
          watcher.abort()
        },
      }
    },
  })
  return { id, outcome }
}

function clampTimeout(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`github_ci_watch: timeout_ms 必须是正数，收到 ${JSON.stringify(requested)}`)
  }
  return Math.min(FOREGROUND_TIMEOUT_CAP, Math.floor(value))
}

function clampInterval(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`github_ci_watch: interval_ms 必须是正数，收到 ${JSON.stringify(requested)}`)
  }
  return Math.max(MIN_INTERVAL_MS, Math.floor(value))
}

function clampLines(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`github_ci_watch: max_log_lines 必须是正数，收到 ${JSON.stringify(requested)}`)
  }
  return Math.floor(value)
}

function logPolicy(requested: LogTailPolicy | undefined): LogTailPolicy {
  if (requested === undefined) return 'failure'
  if (requested !== 'failure' && requested !== 'always' && requested !== 'none') {
    throw new Error(`github_ci_watch: log_tail 只能是 failure / always / none，收到 ${JSON.stringify(requested)}`)
  }
  return requested
}

const DESCRIPTION =
  '监控一次 GitHub CI（Actions run / check suite / check run），长生命周期、可持续数分钟到数小时。' +
  'mode=foreground（默认）：在调用内阻塞等待，CI 到终态即返回最终报告（conclusion + 失败单元清单 + 按 log_tail 抓取的日志尾部）；' +
  '超过 timeout_ms 仍在跑则返回 promoted 句柄（job id），监控继续在后台运行。' +
  'mode=background：立即返回作业句柄（形如 ci-N），之后用内置 job_output 读状态时间线与最终报告、job_list 列出、job_kill 停止；' +
  '终态会在后续轮次由既有作业机制自动回报。' +
  '状态约定：CI 自身成功或失败都使作业结算为 completed（CI 结论写在 detail/result 里）；' +
  '只有监控自身故障（鉴权失败、404、连续网络失败）才结算为 failed；日志抓取失败只记 stderr，不影响结算。'

/** The CI watch tool; `jobs` is undefined in a foreground-only assembly. */
export function defineCiTool(config: GithubConfig, jobs: JobRegistry | undefined, deps: CiToolDeps = {}) {
  const makeClient = deps.createClient ?? createCiClient
  const runMonitor = deps.monitor ?? monitorCi
  return defineTool({
    name: 'github_ci_watch',
    description: DESCRIPTION,
    parameters: {
      repo: { type: 'string', description: '目标仓库 "owner/name"（与 run_url 二选一）' },
      run_url: {
        type: 'string',
        description:
          'Actions run 链接，如 https://github.com/owner/repo/actions/runs/123（可带 /job/<job_id>）；从 URL 推导仓库',
      },
      run_id: { type: 'integer', description: 'Actions run id（配合 repo 使用）' },
      check_suite_id: { type: 'integer', description: 'check suite id（配合 repo 使用）' },
      check_run_id: { type: 'integer', description: 'check run id（配合 repo 使用）' },
      mode: {
        type: 'string',
        enum: ['foreground', 'background'],
        default: 'foreground',
        description: 'foreground=阻塞等待终态（默认）；background=立即返回作业句柄',
      },
      timeout_ms: {
        type: 'integer',
        description: `仅前台：等待终态的上限毫秒数（默认取插件配置 ciWaitMs，硬上限 ${FOREGROUND_TIMEOUT_CAP}）；超时返回 promoted 句柄且监控继续`,
      },
      interval_ms: {
        type: 'integer',
        description: `轮询间隔毫秒数（默认取插件配置 ciIntervalMs，下限 ${MIN_INTERVAL_MS}）`,
      },
      log_tail: {
        type: 'string',
        enum: ['failure', 'always', 'none'],
        default: 'failure',
        description: '终态抓取哪些日志尾部：failure=仅失败单元（默认）；always=所有单元；none=不抓',
      },
      max_log_lines: {
        type: 'integer',
        description: '每个单元日志尾部的最大行数（默认取插件配置 ciMaxLogLines，字节上限取 ciMaxLogBytes）',
      },
      host: { type: 'string', description: '覆盖 API 主机（企业版 GitHub）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: FOREGROUND_TIMEOUT_CAP + 30000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `watch CI ${args.run_url ?? args.run_id ?? args.check_run_id ?? args.check_suite_id ?? ''}`.trim(),
      kind: 'fetch',
      rawInput: args.repo,
    }),
    async execute(args: CiWatchArgs, exec) {
      const target = parseCiTarget(args)
      const plan: WatchPlan = {
        target,
        client: makeClient(config),
        intervalMs: clampInterval(args.interval_ms, config.ciIntervalMs),
        label: describeTarget(target),
        owner: exec.agent?.id as Caller,
        logTail: logPolicy(args.log_tail),
        maxLogLines: clampLines(args.max_log_lines, config.ciMaxLogLines),
        maxLogBytes: config.ciMaxLogBytes,
      }
      const mode = args.mode ?? 'foreground'
      // Validated before the assembly branches, so an invalid `timeout_ms` is
      // rejected identically with and without a job registry. `timeout_ms` only
      // *waits* in the registry assembly; the inline path is bounded by the
      // tool-level deadline instead.
      const timeoutMs = clampTimeout(args.timeout_ms, config.ciWaitMs)

      const foregroundValue = (report: CiReport): Record<string, JsonValue> => ({
        mode: 'foreground',
        jobId: null,
        report: renderReport(report),
        target: report.target,
        status: report.status,
        conclusion: report.conclusion,
        failedUnits: report.failedUnits,
        polls: report.polls,
        elapsedMs: report.elapsedMs,
        logTail: report.logTail ?? null,
        logSource: report.logSource ?? null,
      })

      if (mode === 'background') {
        if (jobs === undefined) {
          throw new Error(
            'github_ci_watch: 当前装配没有作业注册表（ctx.jobs 未加载），mode=background 不可用；' +
              '请改用 mode=foreground，或在组合里加载 @deepseek-ai/dsh-jobs + @deepseek-ai/dsh-tool-jobs',
          )
        }
        const started = startWatch(jobs, plan, runMonitor)
        const value: Record<string, JsonValue> = {
          mode: 'background',
          jobId: started.id,
          target: plan.label,
          hint: `监控已在后台运行；用 job_output 读取 ${started.id} 的状态时间线与最终报告，job_kill 停止`,
        }
        return value
      }

      if (jobs === undefined) {
        const result = await runMonitor({
          target,
          client: plan.client,
          sink: {
            status: (): void => {},
            narrate: (): void => {},
            error: (): void => {},
            progress: (): void => {},
          },
          intervalMs: plan.intervalMs,
          signal: exec.signal,
          logTail: plan.logTail,
          maxLogLines: plan.maxLogLines,
          maxLogBytes: plan.maxLogBytes,
        })
        return foregroundValue(buildReport(target, result))
      }

      const started = startWatch(jobs, plan, runMonitor)
      let view: Awaited<ReturnType<JobRegistry['wait']>>
      try {
        view = await jobs.wait(started.id, timeoutMs, plan.owner, exec.signal)
      } catch {
        jobs.kill(started.id, plan.owner, 'tool call aborted')
        await jobs.wait(started.id, timeoutMs, plan.owner)
        jobs.remove(started.id, plan.owner)
        throw new Error('github_ci_watch: 工具调用已中止，监控已停止')
      }
      if (view.status === 'running' || view.status === 'stopping') {
        const read = jobs.read(started.id, plan.owner)
        const output = read.chunks.map((chunk) => chunk.text).join('')
        const value: Record<string, JsonValue> = {
          mode: 'promoted',
          jobId: started.id,
          target: plan.label,
          timeoutMs,
          output,
          hint: `超过 ${timeoutMs}ms 仍在运行；监控继续，用 job_output 读 ${started.id}，终态会自动回报`,
        }
        return value
      }
      jobs.remove(started.id, plan.owner)
      const outcome = await started.outcome
      if (!outcome.ok) throw new Error(outcome.error)
      return foregroundValue(buildReport(target, outcome.result))
    },
  })
}
