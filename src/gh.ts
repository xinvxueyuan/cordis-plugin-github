import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GithubApiError } from './errors.ts'
import type { GithubQuery } from './types.ts'

export interface GhRequest {
  ghPath: string
  host?: string
  method: string
  endpoint: string
  query?: GithubQuery
  body?: unknown
  /** Request the raw media type (raw file contents, tarballs). */
  raw?: boolean
  signal?: AbortSignal
}

export interface GhResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * Build the `gh api` argument array. Exported for unit tests.
 *
 * Args are passed as an array to `spawn` — never through a shell — so
 * quoting/escaping bugs cannot corrupt the command line.
 */
export function buildGhArgs(request: GhRequest & { bodyFile?: string }): string[] {
  const args: string[] = ['api']
  if (request.host) args.push('--hostname', request.host)
  args.push('--method', request.method.toUpperCase())
  args.push('-H', request.raw ? 'Accept: application/vnd.github.raw+json' : 'Accept: application/vnd.github+json')
  args.push('-H', 'X-GitHub-Api-Version: 2022-11-28')
  if (request.query) {
    for (const [key, value] of Object.entries(request.query)) {
      if (value === undefined || value === null) continue
      // -f passes the raw string; -F parses the value as JSON (numbers/booleans)
      args.push(typeof value === 'string' ? '-f' : '-F', `${key}=${String(value)}`)
    }
  }
  // JSON bodies go through a temp file (`--input`) so no inline escaping is needed.
  if (request.bodyFile) args.push('--input', request.bodyFile)
  args.push(request.endpoint)
  return args
}

/** Run one `gh api` call. */
export async function callGh(request: GhRequest): Promise<GhResult> {
  let tmpDir: string | undefined
  let bodyFile: string | undefined
  if (request.body !== undefined) {
    tmpDir = await mkdtemp(join(tmpdir(), 'cordis-gh-'))
    bodyFile = join(tmpDir, 'body.json')
    await writeFile(bodyFile, JSON.stringify(request.body))
  }
  try {
    const args = buildGhArgs({ ...request, bodyFile })
    return await spawnCapture(request.ghPath, args, request.signal)
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function spawnCapture(bin: string, args: string[], signal?: AbortSignal): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, signal })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (signal?.aborted) {
        reject(new Error('aborted'))
      } else if (error.code === 'ENOENT') {
        reject(new GithubApiError(0, `gh 不可用：找不到命令 "${bin}"（请安装 GitHub CLI，或把插件 mode 配置为 "http"）`))
      } else {
        reject(error)
      }
    })
    child.on('close', (code, closeSignal) => {
      if (signal?.aborted) {
        reject(new Error('aborted'))
      } else {
        resolve({ stdout, stderr, code: closeSignal ? 1 : code ?? -1 })
      }
    })
  })
}

/**
 * Turn gh stderr into a structured error. gh reports API failures as
 * `gh: HTTP <status> ...`; other failures carry a plain message (status 0).
 */
export function parseGhError(stderr: string, stdout = ''): GithubApiError {
  // gh reports failures as `gh: HTTP 404 ...` or `gh: Not Found (HTTP 404)`
  const match = /HTTP\s*(\d{3})/.exec(stderr)
  if (match) {
    const status = Number(match[1])
    const detail = stderr.replace(/^gh: /, '').trim() || `HTTP ${status}`
    return new GithubApiError(status, detail)
  }
  const first = stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (first) return new GithubApiError(0, first)
  const fallback = stdout.split('\n')[0]?.trim()
  return new GithubApiError(0, fallback || 'gh api failed')
}
