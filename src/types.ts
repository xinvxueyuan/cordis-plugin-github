import type { JsonValue } from '@deepseek-ai/dsh-tools'

export type GithubMode = 'auto' | 'gh' | 'http'

/** Query parameters — flat primitive values only. */
export interface GithubQuery {
  [key: string]: string | number | boolean | null | undefined
}

export interface GithubRequestOptions {
  /** REST path without leading slash, e.g. `repos/owner/repo/issues`. */
  endpoint: string
  /** HTTP method (GET/POST/PATCH/PUT/DELETE/HEAD). */
  method: string
  query?: GithubQuery
  /** JSON request body (writes). */
  body?: JsonValue
  /** Automatically follow pagination (list endpoints) up to the configured cap. */
  paginate?: boolean
  /** Return the raw response body as text instead of parsed JSON. */
  raw?: boolean
  /** Per-call API host override (enterprise GitHub). */
  host?: string
}

export interface GithubResponse {
  /** Parsed JSON value (raw mode leaves this null). */
  value: JsonValue
  /** Raw response text (raw mode only). */
  rawText?: string
  rateLimit?: { remaining?: number; reset?: number }
  /** Whether the caller requested pagination. */
  paginated: boolean
  /** Pagination hit the maxPages cap. */
  truncated?: boolean
}
