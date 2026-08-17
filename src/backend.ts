import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { callGh, parseGhError } from './gh.ts'
import { callHttpOnce } from './http.ts'
import { GithubApiError } from './errors.ts'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { GithubMode, GithubRequestOptions, GithubResponse } from './types.ts'

const execFileAsync = promisify(execFile)

export interface BackendConfig {
  mode: GithubMode
  ghPath: string
  host: string
  tokenEnv: string
  timeoutMs: number
  maxPages: number
  perPage: number
}

export interface BackendRequest extends GithubRequestOptions {
  signal?: AbortSignal
}

async function commandOk(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 5000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** Token resolution order: configured tokenEnv → GH_TOKEN → GITHUB_TOKEN → `gh auth token`. */
export async function resolveToken(
  config: Pick<BackendConfig, 'tokenEnv'>,
  ghPath: string,
): Promise<string | undefined> {
  if (config.tokenEnv) {
    const fromEnv = process.env[config.tokenEnv]
    if (fromEnv) return fromEnv
  }
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    const { stdout } = await execFileAsync(ghPath, ['auth', 'token'], { timeout: 5000, windowsHide: true })
    const token = stdout.trim()
    return token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * Normalized GitHub API call. Routes to the gh CLI backend when the mode
 * selects it and gh is installed and authenticated; otherwise falls back to
 * native HTTP with a resolved token. Pagination follows page/per_page up to
 * the maxPages cap in either backend.
 */
export async function githubCall(
  config: BackendConfig,
  request: BackendRequest,
): Promise<GithubResponse> {
  const ghSelected =
    config.mode === 'gh' ||
    (config.mode === 'auto' &&
      (await commandOk(config.ghPath, ['--version'])) &&
      (await commandOk(config.ghPath, ['auth', 'status'])))
  if (ghSelected) {
    try {
      return await callGhBackend(config, request)
    } catch (error) {
      if (
        config.mode === 'auto' &&
        error instanceof GithubApiError &&
        (error.status === 0 || error.status === 401)
      ) {
        // gh unavailable or unauthenticated — fall through to HTTP
      } else {
        throw error
      }
    }
  }
  const token = await resolveToken(config, config.ghPath)
  if (!token) {
    throw new GithubApiError(
      401,
      'GitHub 认证缺失：请运行 `gh auth login`，或在插件配置中设置 tokenEnv（指向持有 token 的环境变量，如 GH_TOKEN），或导出 GH_TOKEN / GITHUB_TOKEN',
    )
  }
  return callHttpBackend(config, request, token)
}

async function callGhBackend(config: BackendConfig, request: BackendRequest): Promise<GithubResponse> {
  if (request.raw) {
    const result = await callGh({
      ghPath: config.ghPath,
      host: request.host,
      method: request.method,
      endpoint: request.endpoint,
      query: request.query,
      body: request.body,
      raw: true,
      signal: request.signal,
    })
    if (result.code !== 0) throw parseGhError(result.stderr, result.stdout)
    return { value: null, rawText: result.stdout, paginated: false }
  }
  return callWithPagination(config, request, async (page) => {
    const query = page !== undefined ? { ...request.query, page, per_page: config.perPage } : request.query
    const result = await callGh({
      ghPath: config.ghPath,
      host: request.host,
      method: request.method,
      endpoint: request.endpoint,
      query,
      body: request.body,
      signal: request.signal,
    })
    if (result.code !== 0) throw parseGhError(result.stderr, result.stdout)
    return result.stdout
  })
}

async function callHttpBackend(
  config: BackendConfig,
  request: BackendRequest,
  token: string,
): Promise<GithubResponse> {
  if (request.raw) {
    const response = await callHttpOnce({
      token,
      host: request.host ?? config.host,
      method: request.method,
      endpoint: request.endpoint,
      query: request.query,
      body: request.body,
      raw: true,
      timeoutMs: config.timeoutMs,
      signal: request.signal,
    })
    return { value: null, rawText: response.text, rateLimit: response.rateLimit, paginated: false }
  }
  return callWithPagination(config, request, async (page) => {
    const query = page !== undefined ? { ...request.query, page, per_page: config.perPage } : request.query
    const response = await callHttpOnce({
      token,
      host: request.host ?? config.host,
      method: request.method,
      endpoint: request.endpoint,
      query,
      body: request.body,
      timeoutMs: config.timeoutMs,
      signal: request.signal,
    })
    return { text: response.text, rateLimit: response.rateLimit }
  })
}

/** Shared page-loop pagination for both backends. */
async function callWithPagination(
  config: BackendConfig,
  request: BackendRequest,
  pageCall: (
    page: number | undefined,
  ) => Promise<string | { text: string; rateLimit?: GithubResponse['rateLimit'] }>,
): Promise<GithubResponse> {
  if (!request.paginate) {
    const body = await pageCall(undefined)
    const text = typeof body === 'string' ? body : body.text
    return {
      value: parseJsonOrThrow(text, request.endpoint) as JsonValue,
      rateLimit: typeof body === 'string' ? undefined : body.rateLimit,
      paginated: false,
    }
  }
  const values: JsonValue[] = []
  let truncated = false
  let rateLimit: GithubResponse['rateLimit']
  for (let page = 1; ; page += 1) {
    const body = await pageCall(page)
    const text = typeof body === 'string' ? body : body.text
    rateLimit = typeof body === 'string' ? undefined : body.rateLimit
    const parsed = parseJsonOrThrow(text, request.endpoint)
    if (!Array.isArray(parsed)) {
      if (page === 1) return { value: parsed as JsonValue, rateLimit, paginated: true }
      break
    }
    values.push(...(parsed as JsonValue[]))
    if (parsed.length < config.perPage) break
    if (page >= config.maxPages) {
      truncated = true
      break
    }
  }
  return { value: values, rateLimit, paginated: true, truncated }
}

function parseJsonOrThrow(text: string, endpoint: string): unknown {
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    throw new GithubApiError(
      0,
      `响应不是合法 JSON（端点 ${endpoint}；如为非 JSON 端点请使用 raw: true）`,
    )
  }
}
