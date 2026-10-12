import type { Context } from '@deepseek-ai/cordis'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import { assertConfig, Config, type GithubConfig } from './config.ts'
import { defineApiTool } from './tool-api.ts'
import { defineGraphqlTool } from './tool-graphql.ts'
import { defineCiTool } from './tool-ci.ts'
import { jobsOf } from './jobs-seam.ts'

export const name = 'cordis-plugin-github'
export const inject = ['tools']
export { Config }

/** Register the GitHub API tools. Registrations are effect-based: the loader
 *  disposes them automatically when the plugin fiber is removed.
 *
 *  `github_ci_watch` upgrades to background jobs when `ctx.jobs` is composed.
 *  Without that registry it stays foreground-only instead of inventing a
 *  second job mechanism; `mode=background` then reports the missing registry. */
export function apply(ctx: Context, config: GithubConfig): void {
  assertConfig(config)
  ctx.tools.register(defineApiTool(config))
  ctx.tools.register(defineGraphqlTool(config))

  const injectFn = (ctx as unknown as { inject?: unknown }).inject
  if (typeof injectFn !== 'function') {
    ctx.tools.register(defineCiTool(config, undefined))
    return
  }
  let foregroundOnly =
    jobsOf(ctx) === undefined ? ctx.tools.register(defineCiTool(config, undefined)) : undefined
  ctx.inject(['jobs'], (jobCtx) => {
    foregroundOnly?.()
    foregroundOnly = undefined
    const unregister = ctx.tools.register(defineCiTool(config, jobCtx.jobs as JobRegistry))
    jobCtx.effect(() => () => {
      unregister()
      const fiber = (ctx as unknown as { fiber?: { state?: number } }).fiber
      if (fiber?.state === 2) foregroundOnly = ctx.tools.register(defineCiTool(config, undefined))
    })
  })
}
