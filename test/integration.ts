import { execFileSync } from 'node:child_process'
import { githubCall, type BackendConfig } from '../src/backend.ts'
import { GithubApiError } from '../src/errors.ts'

const base: BackendConfig = {
  mode: 'gh',
  ghPath: 'gh',
  host: 'api.github.com',
  tokenEnv: '',
  timeoutMs: 30000,
  maxPages: 2,
  perPage: 1,
}

const results: { name: string; pass: boolean; detail?: string }[] = []

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push({ name, pass: true })
  } catch (error) {
    results.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

let token = ''
try {
  token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true }).trim()
} catch {
  // no token available — http-path checks will be skipped
}

await check('gh: rate_limit', async () => {
  const response = await githubCall(base, { endpoint: 'rate_limit', method: 'GET' })
  const rate = (response.value as { rate?: { limit?: number } }).rate
  if (rate?.limit !== 5000) throw new Error(`unexpected rate.limit: ${JSON.stringify(rate)}`)
})

await check('gh: 404 error path', async () => {
  try {
    await githubCall(base, { endpoint: 'repos/definitely-not-a-real-repo-xyz/foo', method: 'GET' })
    throw new Error('expected GithubApiError')
  } catch (error) {
    if (!(error instanceof GithubApiError) || error.status !== 404) throw error
  }
})

await check('gh: pagination with maxPages cap', async () => {
  const response = await githubCall(base, {
    endpoint: 'repos/cli/cli/issues',
    method: 'GET',
    query: { state: 'all' },
    paginate: true,
  })
  if (!Array.isArray(response.value)) throw new Error('expected array')
  if (response.value.length === 0) throw new Error('expected at least one issue')
  if (!response.truncated) throw new Error('expected truncated with maxPages=2 and perPage=1')
})

await check('gh: raw file content', async () => {
  const response = await githubCall(base, {
    endpoint: 'repos/cli/cli/contents/README.md',
    method: 'GET',
    query: { ref: 'trunk' },
    raw: true,
  })
  if (!response.rawText || !response.rawText.includes('GitHub CLI')) {
    throw new Error('expected raw README text')
  }
})

await check('gh: graphql viewer', async () => {
  const response = await githubCall(base, {
    endpoint: 'graphql',
    method: 'POST',
    body: { query: '{ viewer { login } }' },
  })
  const login = (response.value as { data?: { viewer?: { login?: string } } }).data?.viewer?.login
  if (!login) throw new Error(`no viewer.login: ${JSON.stringify(response.value)}`)
})

if (token) {
  const httpBase: BackendConfig = { ...base, mode: 'http' }
  await check('http: rate_limit (forced)', async () => {
    const response = await githubCall(httpBase, { endpoint: 'rate_limit', method: 'GET' })
    const rate = (response.value as { rate?: { limit?: number } }).rate
    if (rate?.limit !== 5000) throw new Error(`unexpected rate.limit: ${JSON.stringify(rate)}`)
  })
  await check('http: 404 error path', async () => {
    try {
      await githubCall(httpBase, { endpoint: 'repos/definitely-not-a-real-repo-xyz/foo', method: 'GET' })
      throw new Error('expected GithubApiError')
    } catch (error) {
      if (!(error instanceof GithubApiError) || error.status !== 404) throw error
    }
  })
  await check('http: raw file content', async () => {
    const response = await githubCall(httpBase, {
      endpoint: 'repos/cli/cli/contents/README.md',
      method: 'GET',
      query: { ref: 'trunk' },
      raw: true,
    })
    if (!response.rawText || !response.rawText.includes('GitHub CLI')) {
      throw new Error('expected raw README text')
    }
  })
  await check('http: pagination (forced)', async () => {
    const response = await githubCall(httpBase, {
      endpoint: 'repos/cli/cli/issues',
      method: 'GET',
      query: { state: 'all' },
      paginate: true,
    })
    if (!Array.isArray(response.value) || response.value.length === 0) {
      throw new Error('expected non-empty array')
    }
  })
} else {
  console.log('SKIP: http-path checks need a token (no gh auth token available)')
}

// Never leak the token into printed output.
const dump = JSON.stringify(results)
if (token && dump.includes(token)) throw new Error('TOKEN LEAK: results contain the GitHub token')

let failed = 0
for (const item of results) {
  console.log(`${item.pass ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
  if (!item.pass) failed += 1
}
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
