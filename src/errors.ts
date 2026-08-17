/**
 * Structured GitHub API failure.
 *
 * `status` is the HTTP status when the API answered (404/403/...), 401 for a
 * missing authentication, and 0 for local failures with no HTTP response
 * (gh not installed, malformed output, network error).
 */
export class GithubApiError extends Error {
  readonly status: number
  /** Epoch seconds of the rate-limit reset, when a 403/429 carried it. */
  readonly rateLimitReset?: number

  constructor(status: number, message: string, rateLimitReset?: number) {
    super(message)
    this.name = 'GithubApiError'
    this.status = status
    this.rateLimitReset = rateLimitReset
  }
}
