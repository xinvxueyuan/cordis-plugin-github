import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGhArgs, parseGhError } from '../src/gh.ts'
import { buildHttpPlan } from '../src/http.ts'
import { resolveToken } from '../src/backend.ts'
import { Config } from '../src/config.ts'

test('buildGhArgs: basic GET', () => {
  const args = buildGhArgs({ ghPath: 'gh', method: 'GET', endpoint: 'rate_limit' })
  assert.deepEqual(args, [
    'api',
    '--method',
    'GET',
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2022-11-28',
    'rate_limit',
  ])
})

test('buildGhArgs: query flags (-f for strings, -F for numbers)', () => {
  const args = buildGhArgs({
    ghPath: 'gh',
    method: 'GET',
    endpoint: 'repos/a/b/issues',
    query: { state: 'open', per_page: 100 },
  })
  assert.ok(args.includes('-f'))
  assert.ok(args.includes('state=open'))
  assert.ok(args.includes('-F'))
  assert.ok(args.includes('per_page=100'))
})

test('buildGhArgs: host override', () => {
  const args = buildGhArgs({ ghPath: 'gh', method: 'GET', endpoint: 'rate_limit', host: 'github.example.com' })
  assert.ok(args.includes('--hostname'))
  assert.ok(args.includes('github.example.com'))
})

test('buildGhArgs: body via --input temp file', () => {
  const args = buildGhArgs({ ghPath: 'gh', method: 'POST', endpoint: 'graphql', bodyFile: 'C:/tmp/body.json' })
  assert.ok(args.includes('--input'))
  assert.ok(args.includes('C:/tmp/body.json'))
})

test('parseGhError: HTTP status extraction', () => {
  const error = parseGhError('gh: HTTP 404 Not Found (https://api.github.com/repos/x/y)\n')
  assert.equal(error.status, 404)
})

test('parseGhError: parenthesized status form', () => {
  const error = parseGhError('gh: Not Found (HTTP 404)\n')
  assert.equal(error.status, 404)
  assert.ok(error.message.includes('Not Found'))
})

test('parseGhError: local (non-HTTP) failure', () => {
  const error = parseGhError('gh: To use GitHub CLI in non-interactive mode, set GH_TOKEN...')
  assert.equal(error.status, 0)
  assert.ok(error.message.length > 0)
})

test('buildHttpPlan: url, query, auth headers', () => {
  const { url, init } = buildHttpPlan({
    token: 't0k3n',
    host: 'api.github.com',
    method: 'GET',
    endpoint: '/repos/a/b/issues',
    query: { state: 'open' },
  })
  assert.equal(url, 'https://api.github.com/repos/a/b/issues?state=open')
  const headers = init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer t0k3n')
  assert.equal(headers.Accept, 'application/vnd.github+json')
})

test('buildHttpPlan: raw accept header and JSON body', () => {
  const { init } = buildHttpPlan({
    token: 't',
    host: 'api.github.com',
    method: 'POST',
    endpoint: 'repos/a/b/issues',
    body: { title: 'x' },
    raw: true,
  })
  const headers = init.headers as Record<string, string>
  assert.equal(headers.Accept, 'application/vnd.github.raw+json')
  assert.equal(init.body, '{"title":"x"}')
})

test('Config: defaults fill in', () => {
  const config = Config({}) as unknown as Record<string, unknown>
  assert.equal(config.mode, 'auto')
  assert.equal(config.host, 'api.github.com')
  assert.equal(config.perPage, 100)
  assert.equal(config.maxPages, 50)
  assert.equal(config.timeoutMs, 60000)
})

test('Config: rejects unknown mode', () => {
  assert.throws(() => Config({ mode: 'bogus' } as never))
})

test('resolveToken: precedence (tokenEnv > GH_TOKEN > GITHUB_TOKEN)', async () => {
  const saved = {
    tokenEnv: process.env.CORDIS_TEST_TOKEN,
    gh: process.env.GH_TOKEN,
    git: process.env.GITHUB_TOKEN,
  }
  process.env.CORDIS_TEST_TOKEN = 'from-token-env'
  process.env.GH_TOKEN = 'from-gh'
  process.env.GITHUB_TOKEN = 'from-git'
  try {
    assert.equal(await resolveToken({ tokenEnv: 'CORDIS_TEST_TOKEN' }, 'gh'), 'from-token-env')
    assert.equal(await resolveToken({ tokenEnv: '' }, 'gh'), 'from-gh')
  } finally {
    if (saved.tokenEnv === undefined) delete process.env.CORDIS_TEST_TOKEN
    else process.env.CORDIS_TEST_TOKEN = saved.tokenEnv
    if (saved.gh === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = saved.gh
    if (saved.git === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = saved.git
  }
})
