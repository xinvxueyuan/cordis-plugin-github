/**
 * CI watch target resolution: tool arguments (ids or a GitHub run URL) become
 * one normalized target. Pure functions — no config, no network, no clock.
 */

export type CiTargetKind = 'run' | 'check_suite' | 'check_run'

/** One resolved CI subject to monitor. */
export interface CiTarget {
  kind: CiTargetKind
  /** `owner/name`, exactly as the API expects it. */
  repo: string
  /** Enterprise API host override (github.com leaves this undefined). */
  host?: string
  runId?: number
  jobId?: number
  checkSuiteId?: number
  checkRunId?: number
}

/** Raw tool arguments that may identify a target. */
export interface CiTargetInput {
  repo?: string
  run_url?: string
  run_id?: number
  check_suite_id?: number
  check_run_id?: number
  host?: string
}

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

function positiveId(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`github_ci_watch: ${name} 必须是正整数，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function parseRepo(repo: string): string {
  const trimmed = repo.trim().replace(/^\/+|\/+$/g, '')
  if (!REPO_PATTERN.test(trimmed)) {
    throw new Error(`github_ci_watch: repo 必须是 "owner/name" 形式，收到 ${JSON.stringify(repo)}`)
  }
  return trimmed
}

interface ParsedRunUrl {
  repo: string
  host?: string
  runId: number
  jobId?: number
}

function parseRunUrl(raw: string): ParsedRunUrl {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(`github_ci_watch: run_url 不是合法 URL: ${JSON.stringify(raw)}`)
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  for (const segment of segments) {
    if (segment === '..') throw new Error(`github_ci_watch: run_url 含非法路径段: ${JSON.stringify(raw)}`)
  }
  // <owner>/<repo>/actions/runs/<run_id>[/job/<job_id>]
  if (segments[2] !== 'actions' || segments[3] !== 'runs' || segments.length < 5) {
    throw new Error(
      `github_ci_watch: run_url 无法识别，期望 https://github.com/<owner>/<repo>/actions/runs/<id>（可带 /job/<job_id>）: ${JSON.stringify(raw)}`,
    )
  }
  const repo = parseRepo(`${segments[0]}/${segments[1]}`)
  const runId = positiveId(Number(segments[4]), 'run_url 中的 run id')
  let jobId: number | undefined
  if (segments.length > 5) {
    if (segments.length !== 7 || segments[5] !== 'job') {
      throw new Error(`github_ci_watch: run_url 尾部无法识别，仅支持可选的 /job/<job_id>: ${JSON.stringify(raw)}`)
    }
    jobId = positiveId(Number(segments[6]), 'run_url 中的 job id')
  }
  const host = url.hostname === 'github.com' ? undefined : url.hostname
  return { repo, host, runId, ...(jobId !== undefined ? { jobId } : {}) }
}

/**
 * Resolve one CI target from tool arguments. Ambiguous or incomplete input
 * throws with a message naming the offending combination.
 */
export function parseCiTarget(input: CiTargetInput): CiTarget {
  const explicitRepo = input.repo !== undefined ? parseRepo(input.repo) : undefined
  let fromUrl: ParsedRunUrl | undefined
  if (input.run_url !== undefined) {
    if (typeof input.run_url !== 'string' || input.run_url.trim().length === 0) {
      throw new Error('github_ci_watch: run_url 必须是非空字符串')
    }
    fromUrl = parseRunUrl(input.run_url)
  }

  if (explicitRepo !== undefined && fromUrl !== undefined && explicitRepo !== fromUrl.repo) {
    throw new Error(
      `github_ci_watch: repo (${explicitRepo}) 与 run_url 中的仓库 (${fromUrl.repo}) 不一致，请只保留一个`,
    )
  }
  const repo = explicitRepo ?? fromUrl?.repo
  const host = input.host ?? fromUrl?.host

  const runId = input.run_id !== undefined ? positiveId(input.run_id, 'run_id') : undefined
  if (runId !== undefined && fromUrl !== undefined) {
    throw new Error('github_ci_watch: run_id 与 run_url 同时给出，无法判断以哪个为准，请只保留一个')
  }
  const checkSuiteId = input.check_suite_id !== undefined ? positiveId(input.check_suite_id, 'check_suite_id') : undefined
  const checkRunId = input.check_run_id !== undefined ? positiveId(input.check_run_id, 'check_run_id') : undefined

  const selectors = [fromUrl !== undefined || runId !== undefined, checkSuiteId !== undefined, checkRunId !== undefined]
  if (selectors.filter(Boolean).length > 1) {
    throw new Error(
      'github_ci_watch: run / check_suite_id / check_run_id 同时给出多个目标，无法判断以哪个为准，请只保留一个',
    )
  }
  if (repo === undefined) {
    throw new Error('github_ci_watch: 缺少目标仓库，请提供 repo="owner/name" 或 run_url')
  }

  if (checkSuiteId !== undefined) {
    return { kind: 'check_suite', repo, ...(host !== undefined ? { host } : {}), checkSuiteId }
  }
  if (checkRunId !== undefined) {
    return { kind: 'check_run', repo, ...(host !== undefined ? { host } : {}), checkRunId }
  }
  const resolvedRunId = fromUrl?.runId ?? runId
  if (resolvedRunId === undefined) {
    throw new Error('github_ci_watch: 缺少 CI 目标，请提供 repo + run_id、run_url、check_suite_id 或 check_run_id')
  }
  const jobId = fromUrl?.jobId
  return {
    kind: 'run',
    repo,
    ...(host !== undefined ? { host } : {}),
    runId: resolvedRunId,
    ...(jobId !== undefined ? { jobId } : {}),
  }
}

/** One-line target label for job labels, progress lines, and reports. */
export function describeTarget(target: CiTarget): string {
  switch (target.kind) {
    case 'run':
      return `run ${target.repo}#${target.runId}${target.jobId !== undefined ? ` job ${target.jobId}` : ''}`
    case 'check_suite':
      return `check suite ${target.repo}#${target.checkSuiteId}`
    case 'check_run':
      return `check run ${target.repo}#${target.checkRunId}`
  }
}
