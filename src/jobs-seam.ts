/**
 * The `dsh-jobs` seam. The job registry is an optional peer: this plugin
 * declares its own job kind and reaches the registry through `ctx.get('jobs')`
 * (never through a value import, so the plugin still loads without it).
 */

import type { JobRegistry } from '@deepseek-ai/dsh-jobs'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** Long-lived CI monitoring job started by `github_ci_watch`. */
    ci: 'ci'
  }
}

/** Job kind registered for CI watches (the job id is `ci-<id>`). */
export const CI_JOB_KIND = 'ci'

/**
 * The background job registry when the composition loaded one. Absent when the
 * plugin runs in a foreground-only assembly — the caller then degrades instead
 * of inventing a second job mechanism.
 */
export function jobsOf(ctx: unknown): JobRegistry | undefined {
  const candidate = ctx as { get?: (name: string) => unknown }
  if (typeof candidate.get !== 'function') return undefined
  try {
    return candidate.get('jobs') as JobRegistry | undefined
  } catch {
    return undefined
  }
}
