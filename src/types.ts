/**
 * JSON-serializable value. Declared locally instead of importing
 * `@deepseek-ai/dsh-tools`' `JsonValue`: that alias moved out of the package's
 * root exports in 0.2, while this plugin still supports 0.1 and 0.2 peers.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

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
  /**
   * Allow terminal escape sequences in a raw text response. `gh api` refuses
   * such bodies by default (Actions job logs carry ANSI color codes); the HTTP
   * backend needs no flag.
   */
  allowEscapeSequences?: boolean
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
