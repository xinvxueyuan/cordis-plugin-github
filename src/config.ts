import z from '@deepseek-ai/schemastery'

export interface GithubConfig {
  /** 'auto': use gh when installed and authenticated, else HTTP. 'gh'/'http' force a backend. */
  mode: 'auto' | 'gh' | 'http'
  /** Path to the GitHub CLI binary. */
  ghPath: string
  /** API host for the HTTP fallback (enterprise: github.example.com). */
  host: string
  /** Environment variable name holding a token for the HTTP fallback (e.g. 'GH_TOKEN'). */
  tokenEnv: string
  /** Cooperative per-call timeout budget in milliseconds. */
  timeoutMs: number
  /** Pagination page cap (runaway protection). */
  maxPages: number
  /** Items per page for pagination. */
  perPage: number
  /** CI watch polling interval in milliseconds (floor 5000). */
  ciIntervalMs: number
  /** Foreground CI watch wait budget in milliseconds (hard cap 600000). */
  ciWaitMs: number
  /** Log tail line cap for a CI failure report. */
  ciMaxLogLines: number
  /** Log tail byte cap for a CI failure report. */
  ciMaxLogBytes: number
}

export const Config = z.object({
  mode: z.union([z.const('auto'), z.const('gh'), z.const('http')]).default('auto'),
  ghPath: z.string().default('gh'),
  host: z.string().default('api.github.com'),
  tokenEnv: z.string().default(''),
  timeoutMs: z.number().default(60000),
  maxPages: z.number().default(50),
  perPage: z.number().default(100),
  ciIntervalMs: z.number().default(15000),
  ciWaitMs: z.number().default(300000),
  ciMaxLogLines: z.number().default(200),
  ciMaxLogBytes: z.number().default(65536),
})

/** Hand-check constraints the schema DSL does not express. */
export function assertConfig(config: GithubConfig): void {
  for (const key of ['timeoutMs', 'maxPages', 'perPage'] as const) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`cordis-plugin-github: ${key} must be a positive integer`)
    }
  }
  if (config.perPage > 100) throw new Error('cordis-plugin-github: perPage must be at most 100')
  for (const key of ['ciIntervalMs', 'ciWaitMs', 'ciMaxLogLines', 'ciMaxLogBytes'] as const) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`cordis-plugin-github: ${key} must be a positive integer`)
    }
  }
  if (config.ciIntervalMs < 5000) throw new Error('cordis-plugin-github: ciIntervalMs must be at least 5000')
  if (config.ciWaitMs > 600000) throw new Error('cordis-plugin-github: ciWaitMs must be at most 600000')
}
