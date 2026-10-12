/**
 * GitHub side of CI monitoring: wraps the plugin's normalized backend so the
 * poller stays transport-agnostic (gh CLI first, native HTTP fallback). The
 * client returns normalized snapshots and raw log text; every payload rule
 * lives in the pure `ci-status` module.
 */

import { githubCall } from './backend.ts'
import type { GithubConfig } from './config.ts'
import type { CiTarget } from './ci-target.ts'
import { snapshotFromCheckRun, snapshotFromCheckSuite, snapshotFromRun, type CiSnapshot } from './ci-status.ts'

/** The CI-facing calls the poller depends on; tests inject a fake. */
export interface CiClient {
  /** One poll of the target, normalized. */
  fetchSnapshot(target: CiTarget, signal?: AbortSignal): Promise<CiSnapshot>
  /** Raw log text of one Actions job (run targets only). */
  fetchJobLog(target: CiTarget, jobId: number, signal?: AbortSignal): Promise<string>
  /** Human-readable check output: annotations plus `output.summary|text`. */
  fetchCheckOutput(target: CiTarget, signal?: AbortSignal): Promise<string>
}

function requireId(value: number | undefined, what: string): number {
  if (value === undefined) throw new Error(`github_ci_watch: 目标缺少 ${what}，无法调用 GitHub API`)
  return value
}

function valueText(value: Record<string, unknown>, key: string): string {
  const raw = value[key]
  return typeof raw === 'string' ? raw : ''
}

/** Annotations as `[level] path:line — message` lines, best effort. */
function renderAnnotations(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const list = (payload as { annotations?: unknown }).annotations
  if (!Array.isArray(list)) return ''
  const lines: string[] = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path : ''
    const line = typeof record.start_line === 'number' ? `:${record.start_line}` : ''
    const level = typeof record.annotation_level === 'string' ? record.annotation_level : 'notice'
    const message = typeof record.message === 'string' ? record.message : ''
    lines.push(`[${level}] ${path}${line} — ${message}`)
  }
  return lines.join('\n')
}

export function createCiClient(config: GithubConfig): CiClient {
  const call = (endpoint: string, target: CiTarget, signal: AbortSignal | undefined) =>
    githubCall(config, {
      endpoint,
      method: 'GET',
      ...(target.host !== undefined ? { host: target.host } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })

  return {
    async fetchSnapshot(target: CiTarget, signal?: AbortSignal): Promise<CiSnapshot> {
      if (target.kind === 'run') {
        const runId = requireId(target.runId, 'run id')
        const run = await call(`repos/${target.repo}/actions/runs/${runId}`, target, signal)
        const jobs = await githubCall(config, {
          endpoint: `repos/${target.repo}/actions/runs/${runId}/jobs`,
          method: 'GET',
          query: { per_page: 100 },
          ...(target.host !== undefined ? { host: target.host } : {}),
          ...(signal !== undefined ? { signal } : {}),
        })
        return snapshotFromRun(run.value, jobs.value)
      }
      if (target.kind === 'check_suite') {
        const suiteId = requireId(target.checkSuiteId, 'check suite id')
        const suite = await call(`repos/${target.repo}/check-suites/${suiteId}`, target, signal)
        const runs = await githubCall(config, {
          endpoint: `repos/${target.repo}/check-suites/${suiteId}/check-runs`,
          method: 'GET',
          query: { per_page: 100 },
          ...(target.host !== undefined ? { host: target.host } : {}),
          ...(signal !== undefined ? { signal } : {}),
        })
        return snapshotFromCheckSuite(suite.value, runs.value)
      }
      const runId = requireId(target.checkRunId, 'check run id')
      const checkRun = await call(`repos/${target.repo}/check-runs/${runId}`, target, signal)
      return snapshotFromCheckRun(checkRun.value)
    },

    async fetchJobLog(target: CiTarget, jobId: number, signal?: AbortSignal): Promise<string> {
      const response = await githubCall(config, {
        endpoint: `repos/${target.repo}/actions/jobs/${jobId}/logs`,
        method: 'GET',
        raw: true,
        // Actions logs carry ANSI color codes; `gh api` refuses those by default.
        allowEscapeSequences: true,
        ...(target.host !== undefined ? { host: target.host } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      return response.rawText ?? ''
    },

    async fetchCheckOutput(target: CiTarget, signal?: AbortSignal): Promise<string> {
      const runId = requireId(target.checkRunId, 'check run id')
      const checkRun = await call(`repos/${target.repo}/check-runs/${runId}`, target, signal)
      const annotations = await call(`repos/${target.repo}/check-runs/${runId}/annotations`, target, signal)
      const value =
        checkRun.value !== null && typeof checkRun.value === 'object' && !Array.isArray(checkRun.value)
          ? (checkRun.value as Record<string, unknown>)
          : {}
      const output =
        value.output !== null && typeof value.output === 'object' && !Array.isArray(value.output)
          ? (value.output as Record<string, unknown>)
          : {}
      return [
        valueText(output, 'title'),
        valueText(output, 'summary'),
        valueText(output, 'text'),
        renderAnnotations(annotations.value),
      ]
        .filter((part) => part.trim().length > 0)
        .join('\n')
    },
  }
}
