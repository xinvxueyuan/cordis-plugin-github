/**
 * Integration tests for `github_ci_watch` against the *real*
 * `@deepseek-ai/dsh-jobs-local` registry with a fake CI client: no network, no
 * GitHub rate limit, but the genuine job lifecycle (start/list/read/wait/kill/
 * remove) and the genuine tool/job glue.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { Config } from '../src/config.ts'
import type { GithubConfig } from '../src/config.ts'
import { defineCiTool } from '../src/tool-ci.ts'
import { parseCiTarget } from '../src/ci-target.ts'
import { snapshotFromRun, type CiSnapshot } from '../src/ci-status.ts'
import type { CiClient } from '../src/ci-client.ts'

const config = Config({}) as GithubConfig

const completed = (conclusion: string): CiSnapshot =>
  snapshotFromRun(
    { status: 'completed', conclusion },
    { jobs: [{ id: 7, name: 'build', status: 'completed', conclusion }] },
  )

const running = (): CiSnapshot =>
  snapshotFromRun({ status: 'in_progress', conclusion: null }, { jobs: [{ id: 7, name: 'build', status: 'in_progress', conclusion: null }] })

/** Fake GitHub client: scripted snapshots plus call counting. */
class StubClient implements CiClient {
  calls = 0
  private readonly mode: 'settle-success' | 'never'

  constructor(mode: 'settle-success' | 'never' = 'settle-success') {
    this.mode = mode
  }

  async fetchSnapshot(): Promise<CiSnapshot> {
    this.calls += 1
    return this.mode === 'never' ? running() : completed('success')
  }

  async fetchJobLog(): Promise<string> {
    return 'stub log'
  }

  async fetchCheckOutput(): Promise<string> {
    return 'stub output'
  }
}

// The registry surface used by the tests; the real object is a `JobRegistry`.
type AnyJobs = {
  list(caller?: unknown): Array<{ id: string; kind: string; status: string; detail?: string; owner?: unknown }>
  read(id: never, caller?: unknown): { chunks: Array<{ channel?: string; text: string }>; result?: string }
  wait(id: never, timeoutMs: number, caller?: unknown, signal?: AbortSignal): Promise<{ status: string; detail?: string }>
  kill(id: never, caller?: unknown, reason?: string): string
  attachController(name: string): () => void
}

async function setup(options: { withRegistry?: boolean; client?: StubClient } = {}): Promise<{
  jobs: AnyJobs | undefined
  tool: ReturnType<typeof defineCiTool>
  client: StubClient
  dispose(): Promise<void>
  ctx: Context
}> {
  const client = options.client ?? new StubClient()
  const withRegistry = options.withRegistry ?? true
  if (!withRegistry) {
    return {
      jobs: undefined,
      tool: defineCiTool(config, undefined, { createClient: () => client }),
      client,
      dispose: async () => {},
      ctx: undefined as unknown as Context,
    }
  }
  const ctx = new Context()
  await ctx.plugin(LocalJobRegistry, {})
  const jobs = ctx.get('jobs') as unknown as AnyJobs
  const detach = jobs.attachController('ci-jobs-test')
  const tool = defineCiTool(config, ctx.get('jobs'), { createClient: () => client })
  return {
    jobs,
    tool,
    client,
    ctx,
    dispose: async () => {
      detach()
      await ctx.fiber.dispose()
    },
  }
}

const execFor = (signal?: AbortSignal) => ({ signal, agent: undefined }) as never

test('background: returns a ci-<id> handle in under 2s and settles completed on CI success', async () => {
  const harness = await setup()
  const started = Date.now()
  const value = (await harness.tool.execute(
    { repo: 'o/r', run_id: 1, mode: 'background' },
    execFor(),
  )) as { mode: string; jobId: string }
  const elapsed = Date.now() - started
  assert.equal(value.mode, 'background')
  assert.match(value.jobId, /^ci-[\da-f]+$/)
  assert.ok(elapsed < 2000, `background call took ${elapsed}ms`)

  const listed = harness.jobs?.list(undefined) ?? []
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.kind, 'ci')
  assert.equal(listed[0]?.status, 'running')

  const settled = await harness.jobs?.wait(value.jobId as never, 10000)
  assert.equal(settled?.status, 'completed')
  assert.equal(settled?.detail, 'completed (success)')

  const read = harness.jobs?.read(value.jobId as never, undefined)
  assert.ok(read !== undefined)
  const text = read.chunks.map((chunk) => chunk.text).join('')
  assert.match(text, /状态: completed/)
  assert.match(text, /单元 "build": completed \(success\)/)
  assert.match(read.result ?? '', /失败单元: 无/)
  assert.equal(harness.client.calls, 1)
  await harness.dispose()
})

test('foreground: returns the final report and leaves no job record', async () => {
  const harness = await setup()
  const value = (await harness.tool.execute(
    { repo: 'o/r', run_id: 1, mode: 'foreground', timeout_ms: 5000 },
    execFor(),
  )) as { mode: string; jobId: null; status: string; conclusion: string; report: string }
  assert.equal(value.mode, 'foreground')
  assert.equal(value.jobId, null)
  assert.equal(value.status, 'completed')
  assert.equal(value.conclusion, 'success')
  assert.match(value.report, /o\/r#1: completed \(success\)/)
  assert.deepEqual(harness.jobs?.list(undefined), [])
  await harness.dispose()
})

test('foreground: timeout promotes the still-running job and keeps it alive', async () => {
  const client = new StubClient('never')
  const harness = await setup({ client })
  const value = (await harness.tool.execute(
    { repo: 'o/r', run_id: 1, mode: 'foreground', timeout_ms: 1 },
    execFor(),
  )) as { mode: string; jobId: string; timeoutMs: number; output: string }
  assert.equal(value.mode, 'promoted')
  assert.equal(value.timeoutMs, 1)
  const listed = harness.jobs?.list(undefined) ?? []
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.status, 'running')

  // job_kill stops it, and no further GitHub request is issued afterwards.
  harness.jobs?.kill(value.jobId as never, undefined, 'test kill')
  const settled = await harness.jobs?.wait(value.jobId as never, 5000)
  assert.equal(settled?.status, 'killed')
  const callsAfterKill = client.calls
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(client.calls, callsAfterKill)
  await harness.dispose()
})

test('foreground: an aborted tool call kills the job and removes the record', async () => {
  const client = new StubClient('never')
  const harness = await setup({ client })
  const controller = new AbortController()
  const pending = harness.tool.execute(
    { repo: 'o/r', run_id: 1, mode: 'foreground', timeout_ms: 30000 },
    execFor(controller.signal),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  await assert.rejects(pending, /工具调用已中止/)
  assert.deepEqual(harness.jobs?.list(undefined), [])
  await harness.dispose()
})

test('no registry: background reports the missing job registry', async () => {
  const harness = await setup({ withRegistry: false })
  await assert.rejects(
    harness.tool.execute({ repo: 'o/r', run_id: 1, mode: 'background' }, execFor()),
    /没有作业注册表/,
  )
  assert.equal(harness.client.calls, 0)
})

test('no registry: foreground polls inline without any job', async () => {
  const harness = await setup({ withRegistry: false })
  const value = (await harness.tool.execute(
    { repo: 'o/r', run_url: 'https://github.com/o/r/actions/runs/1', mode: 'foreground' },
    execFor(),
  )) as { mode: string; jobId: null; status: string; conclusion: string }
  assert.equal(value.mode, 'foreground')
  assert.equal(value.jobId, null)
  assert.equal(value.conclusion, 'success')
  assert.equal(harness.client.calls, 1)
})

test('no registry: a failing monitor fails the foreground call', async () => {
  const client = new StubClient()
  const failingMonitor: NonNullable<Parameters<typeof defineCiTool>[2]>['monitor'] = async () => {
    throw new Error('监控失败: 连续 5 次轮询出错，最后错误: 403 forbidden')
  }
  const tool = defineCiTool(config, undefined, { createClient: () => client, monitor: failingMonitor })
  await assert.rejects(
    tool.execute({ repo: 'o/r', run_id: 1, mode: 'foreground' }, execFor()),
    /连续 5 次轮询出错，最后错误: 403 forbidden/,
  )
  assert.equal(client.calls, 0)
})

test('target parsing errors surface before any job is started', async () => {
  const harness = await setup()
  await assert.rejects(harness.tool.execute({ repo: 'o/r' } as never, execFor()), /缺少 CI 目标/)
  assert.deepEqual(harness.jobs?.list(undefined), [])
  await harness.dispose()
})

test('parseCiTarget stays compatible with the tool arguments', () => {
  assert.equal(parseCiTarget({ repo: 'o/r', run_id: 1 }).kind, 'run')
})

test('background: the final report appears exactly once across ring chunks and result', async () => {
  const harness = await setup()
  const value = (await harness.tool.execute({ repo: 'o/r', run_id: 1, mode: 'background' }, execFor())) as {
    jobId: string
  }
  await harness.jobs?.wait(value.jobId as never, 10000)
  const read = harness.jobs?.read(value.jobId as never, undefined)
  assert.ok(read !== undefined)
  const text = [...read.chunks.map((chunk) => chunk.text), read.result ?? ''].join('\n')
  // The full report lives in `result`; the ring keeps the timeline plus one
  // closing line, so the report body must not appear twice.
  assert.equal(text.split('失败单元: 无').length - 1, 1)
  assert.match(text, /监控结束: completed \(success\)/)
  assert.equal(text.split('轮询 1 次').length - 1, 1)
  await harness.dispose()
})

test('timeout_ms is validated identically with and without a job registry', async () => {
  const withRegistry = await setup()
  await assert.rejects(
    withRegistry.tool.execute({ repo: 'o/r', run_id: 1, timeout_ms: -5 }, execFor()),
    /timeout_ms 必须是正数/,
  )
  assert.deepEqual(withRegistry.jobs?.list(undefined), [])
  assert.equal(withRegistry.client.calls, 0)
  await withRegistry.dispose()

  const withoutRegistry = await setup({ withRegistry: false })
  await assert.rejects(
    withoutRegistry.tool.execute({ repo: 'o/r', run_id: 1, timeout_ms: -5 }, execFor()),
    /timeout_ms 必须是正数/,
  )
  assert.equal(withoutRegistry.client.calls, 0)
})
