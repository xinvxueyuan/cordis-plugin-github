import { GithubApiError } from './errors.ts'
import type { GithubQuery } from './types.ts'

export interface HttpRequest {
  token: string
  host: string
  method: string
  endpoint: string
  query?: GithubQuery
  body?: unknown
  raw?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export interface HttpSingleResponse {
  status: number
  text: string
  rateLimit?: { remaining?: number; reset?: number }
}

/** Build the fetch plan for one request. Exported for unit tests. */
export function buildHttpPlan(request: HttpRequest): { url: string; init: RequestInit } {
  const path = request.endpoint.replace(/^\/+/, '')
  const url = new URL(`https://${request.host}/${path}`)
  if (request.query) {
    for (const [key, value] of Object.entries(request.query)) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, String(value))
    }
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${request.token}`,
    Accept: request.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cordis-plugin-github',
  }
  const init: RequestInit = {
    method: request.method.toUpperCase(),
    headers,
    body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
  }
  const signals: AbortSignal[] = []
  if (request.signal) signals.push(request.signal)
  if (request.timeoutMs) signals.push(AbortSignal.timeout(request.timeoutMs))
  if (signals.length > 0) {
    init.signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals)
  }
  return { url: url.toString(), init }
}

/** Execute one HTTP request (no pagination). */
export async function callHttpOnce(request: HttpRequest): Promise<HttpSingleResponse> {
  const { url, init } = buildHttpPlan(request)
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (request.signal?.aborted) throw new Error('aborted')
    throw new GithubApiError(0, `请求失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = response.headers.get('x-ratelimit-reset')
  const rateLimit =
    remaining !== null || reset !== null
      ? {
          remaining: remaining !== null ? Number(remaining) : undefined,
          reset: reset !== null ? Number(reset) : undefined,
        }
      : undefined
  if (!response.ok) throw await errorFrom(response, text)
  return { status: response.status, text, rateLimit }
}

async function errorFrom(response: Response, bodyText: string): Promise<GithubApiError> {
  let message = `HTTP ${response.status} ${response.statusText}`.trim()
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string') {
      message = (parsed as { message: string }).message
    }
  } catch {
    // keep the status text
  }
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  return new GithubApiError(response.status, message, Number.isFinite(reset) ? reset : undefined)
}
