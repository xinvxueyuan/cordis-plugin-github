import type { Context } from '@deepseek-ai/cordis'
import { assertConfig, Config, type GithubConfig } from './config.ts'
import { defineApiTool } from './tool-api.ts'
import { defineGraphqlTool } from './tool-graphql.ts'

export const name = 'cordis-plugin-github'
export const inject = ['tools']
export { Config }

/** Register the GitHub API tools. Registrations are effect-based: the loader
 *  disposes them automatically when the plugin fiber is removed. */
export function apply(ctx: Context, config: GithubConfig): void {
  assertConfig(config)
  ctx.tools.register(defineApiTool(config))
  ctx.tools.register(defineGraphqlTool(config))
}
