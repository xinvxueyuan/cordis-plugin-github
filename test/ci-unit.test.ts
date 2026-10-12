import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGhArgs } from '../src/gh.ts'
import { describeTarget, parseCiTarget } from '../src/ci-target.ts'
import {
  diffSnapshots,
  failedUnits,
  snapshotFromCheckRun,
  snapshotFromCheckSuite,
  snapshotFromRun,
  stripAnsi,
  truncateTail,
  type CiSnapshot,
} from '../src/ci-status.ts'
import { monitorCi, backoffMs, type CiSink } from '../src/ci-poller.ts'
import type { CiClient } from '../src/ci-client.ts'

// ---------------------------------------------------------------- targets ---

test('parseCiTarget: repo + run_id', () => {
  const target = parseCiTarget({ repo: 'owner/repo', run_id: 42 })
  assert.equal(target.kind, 'run')
  assert.equal(target.repo, 'owner/repo')
  assert.equal(target.runId, 42)
  assert.equal(target.host, undefined)
})

test('parseCiTarget: plain run URL', () => {
  const target = parseCiTarget({ run_url: 'https://github.com/owner/repo/actions/runs/123' })
  assert.deepEqual(target, { kind: 'run', repo: 'owner/repo', runId: 123 })
})

test('parseCiTarget: run URL with /job/<id> keeps the job id', () => {
  const target = parseCiTarget({ run_url: 'https://github.com/owner/repo/actions/runs/123/job/456' })
  assert.equal(target.runId, 123)
  assert.equal(target.jobId, 456)
})

test('parseCiTarget: run URL with trailing slash and query', () => {
  const target = parseCiTarget({ run_url: 'https://github.com/owner/repo/actions/runs/123/?check_suite_focus=true' })
  assert.equal(target.runId, 123)
})

test('parseCiTarget: enterprise host comes from the URL', () => {
  const target = parseCiTarget({ run_url: 'https://github.example.com/o/r/actions/runs/7' })
  assert.equal(target.host, 'github.example.com')
  assert.equal(target.runId, 7)
})

test('parseCiTarget: repo + check_suite_id', () => {
  const target = parseCiTarget({ repo: 'owner/repo', check_suite_id: 9 })
  assert.equal(target.kind, 'check_suite')
  assert.equal(target.checkSuiteId, 9)
})

test('parseCiTarget: repo + check_run_id', () => {
  const target = parseCiTarget({ repo: 'owner/repo', check_run_id: 9001 })
  assert.equal(target.kind, 'check_run')
  assert.equal(target.checkRunId, 9001)
})

test('parseCiTarget: run URL plus matching repo is accepted', () => {
  const target = parseCiTarget({ repo: 'owner/repo', run_url: 'https://github.com/owner/repo/actions/runs/5' })
  assert.equal(target.runId, 5)
})

test('parseCiTarget: rejects a malformed repo', () => {
  assert.throws(() => parseCiTarget({ repo: 'nope', run_id: 1 }), /repo 必须是 "owner\/name" 形式/)
})

test('parseCiTarget: rejects a missing target', () => {
  assert.throws(() => parseCiTarget({ repo: 'owner/repo' }), /缺少 CI 目标/)
})

test('parseCiTarget: rejects run_id together with run_url', () => {
  assert.throws(
    () => parseCiTarget({ repo: 'owner/repo', run_id: 1, run_url: 'https://github.com/owner/repo/actions/runs/2' }),
    /run_id 与 run_url 同时给出/,
  )
})

test('parseCiTarget: rejects a repo that disagrees with the URL', () => {
  assert.throws(
    () => parseCiTarget({ repo: 'other/repo', run_url: 'https://github.com/owner/repo/actions/runs/2' }),
    /不一致/,
  )
})

test('parseCiTarget: rejects several target kinds at once', () => {
  assert.throws(() => parseCiTarget({ repo: 'owner/repo', run_id: 1, check_run_id: 2 }), /只保留一个/)
})

test('parseCiTarget: rejects a non-actions URL and non-positive ids', () => {
  assert.throws(() => parseCiTarget({ run_url: 'https://github.com/owner/repo/pull/3' }), /run_url 无法识别/)
  assert.throws(() => parseCiTarget({ repo: 'owner/repo', run_id: 0 }), /必须是正整数/)
  assert.throws(() => parseCiTarget({ repo: 'owner/repo', run_id: 1.5 }), /必须是正整数/)
})

test('describeTarget: one line per kind', () => {
  assert.equal(describeTarget(parseCiTarget({ repo: 'o/r', run_id: 3 })), 'run o/r#3')
  assert.equal(describeTarget(parseCiTarget({ repo: 'o/r', run_id: 3, })), 'run o/r#3')
  assert.equal(
    describeTarget(parseCiTarget({ run_url: 'https://github.com/o/r/actions/runs/3/job/9' })),
    'run o/r#3 job 9',
  )
  assert.equal(describeTarget(parseCiTarget({ repo: 'o/r', check_suite_id: 4 })), 'check suite o/r#4')
  assert.equal(describeTarget(parseCiTarget({ repo: 'o/r', check_run_id: 5 })), 'check run o/r#5')
})

test('buildGhArgs: allowEscapeSequences adds the gh flag Actions logs need', () => {
  const withFlag = buildGhArgs({
    ghPath: 'gh',
    method: 'GET',
    endpoint: 'repos/a/b/actions/jobs/1/logs',
    raw: true,
    allowEscapeSequences: true,
  })
  assert.ok(withFlag.includes('--allow-escape-sequences'))
  const withoutFlag = buildGhArgs({ ghPath: 'gh', method: 'GET', endpoint: 'rate_limit' })
  assert.ok(!withoutFlag.includes('--allow-escape-sequences'))
})

// ------------------------------------------------------------- snapshots ---
const runPayload = (status: string, conclusion: string | null) => ({ status, conclusion })
const jobsPayload = (jobs: Array<{ id: number; name: string; status: string; conclusion: string | null }>) => ({ jobs })

test('snapshotFromRun: normalizes status, conclusion, units and terminality', () => {
  const snapshot = snapshotFromRun(
    runPayload('in_progress', null),
    jobsPayload([
      { id: 1, name: 'build', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'test', status: 'in_progress', conclusion: null },
    ]),
  )
  assert.deepEqual(snapshot, {
    status: 'in_progress',
    conclusion: null,
    terminal: false,
    units: [
      { id: 1, name: 'build', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'test', status: 'in_progress', conclusion: null },
    ],
  })
  assert.equal(snapshotFromRun(runPayload('completed', 'failure'), jobsPayload([])).terminal, true)
})

test('snapshotFromRun: rejects a non-object payload', () => {
  assert.throws(() => snapshotFromRun(null, jobsPayload([])), /不是对象/)
})

test('snapshotFromCheckSuite / snapshotFromCheckRun', () => {
  const suite = snapshotFromCheckSuite(
    { status: 'completed', conclusion: 'failure' },
    { check_runs: [{ id: 7, name: 'lint', status: 'completed', conclusion: 'failure' }] },
  )
  assert.equal(suite.terminal, true)
  assert.equal(suite.units[0]?.name, 'lint')
  const single = snapshotFromCheckRun({ id: 8, name: 'deploy', status: 'in_progress', conclusion: null })
  assert.equal(single.terminal, false)
  assert.equal(single.units.length, 1)
})

test('failedUnits: only failure-class conclusions', () => {
  const snapshot = snapshotFromRun(
    runPayload('completed', 'failure'),
    jobsPayload([
      { id: 1, name: 'ok', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'skipped', status: 'completed', conclusion: 'skipped' },
      { id: 3, name: 'bad', status: 'completed', conclusion: 'failure' },
      { id: 4, name: 'cancelled', status: 'completed', conclusion: 'cancelled' },
    ]),
  )
  assert.deepEqual(
    failedUnits(snapshot).map((unit) => unit.name),
    ['bad', 'cancelled'],
  )
})

// ------------------------------------------------------------------ diff ---

test('diffSnapshots: first snapshot lists state, later ones only transitions', () => {
  const first = snapshotFromRun(
    runPayload('queued', null),
    jobsPayload([{ id: 1, name: 'build', status: 'queued', conclusion: null }]),
  )
  assert.deepEqual(diffSnapshots(undefined, first), ['状态: queued', '单元 "build": queued'])

  const second = snapshotFromRun(
    runPayload('in_progress', null),
    jobsPayload([{ id: 1, name: 'build', status: 'in_progress', conclusion: null }]),
  )
  assert.deepEqual(diffSnapshots(first, second), [
    '状态: queued → in_progress',
    '单元 "build": queued → in_progress',
  ])

  const third = snapshotFromRun(
    runPayload('completed', 'success'),
    jobsPayload([{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }]),
  )
  assert.deepEqual(diffSnapshots(second, third), [
    '状态: in_progress → completed',
    '单元 "build": in_progress → completed (success)',
    '终态: completed (success)',
  ])
  assert.deepEqual(diffSnapshots(third, third), [])
})

test('diffSnapshots: unit added and removed', () => {
  const before = snapshotFromRun(runPayload('in_progress', null), jobsPayload([{ id: 1, name: 'a', status: 'queued', conclusion: null }]))
  const after = snapshotFromRun(runPayload('in_progress', null), jobsPayload([{ id: 2, name: 'b', status: 'queued', conclusion: null }]))
  assert.deepEqual(diffSnapshots(before, after), ['单元 "b": 出现 queued', '单元 "a": 消失'])
})

// ------------------------------------------------------------------ logs ---

test('stripAnsi: removes color codes', () => {
  assert.equal(stripAnsi('\u001b[31merror\u001b[0m: boom'), 'error: boom')
})

test('truncateTail: keeps the tail, respects line and byte caps', () => {
  const text = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n')
  const byLines = truncateTail(text, 3, 65536)
  assert.equal(byLines.text, 'line 7\nline 8\nline 9')
  assert.equal(byLines.truncated, true)
  assert.equal(byLines.totalLines, 10)
  assert.equal(byLines.keptLines, 3)

  const byBytes = truncateTail(text, 100, 12)
  assert.ok(Buffer.byteLength(byBytes.text, 'utf8') <= 12)
  assert.ok(byBytes.text.endsWith('line 9'))
  assert.equal(byBytes.truncated, true)
  assert.ok(byBytes.droppedBytes > 0)

  const untouched = truncateTail('short', 10, 100)
  assert.equal(untouched.truncated, false)
  assert.equal(untouched.text, 'short')
})

test('truncateTail: byte cap counts UTF-8 bytes, not characters', () => {
  const text = '一二三四五六七八九十'
  const result = truncateTail(text, 10, 9)
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 9)
  // Each CJK character is 3 bytes, so a 9-byte cap keeps exactly three.
  assert.equal(result.text, '八九十')
})

// --------------------------------------------------------------- poller ----

class FakeClient implements CiClient {
  readonly logCalls: number[] = []
  readonly checkCalls: number[] = []
  private readonly snapshots: Array<CiSnapshot | Error>
  private readonly logBody: string
  private last: CiSnapshot | Error | undefined

  constructor(snapshots: Array<CiSnapshot | Error>, logBody = 'log line A\nlog line B') {
    this.snapshots = snapshots
    this.logBody = logBody
  }

  async fetchSnapshot(): Promise<CiSnapshot> {
    const next = this.snapshots.length > 0 ? this.snapshots.shift() : this.last
    if (next === undefined) throw new Error('fake client exhausted')
    this.last = next
    if (next instanceof Error) throw next
    return next
  }

  async fetchJobLog(_target: unknown, jobId: number): Promise<string> {
    this.logCalls.push(jobId)
    return this.logBody
  }

  async fetchCheckOutput(): Promise<string> {
    this.checkCalls.push(1)
    return this.logBody
  }
}

function collectingSink(): CiSink & {
  lines: string[]
  errors: string[]
  narration: string[]
  progressLines: string[]
} {
  const lines: string[] = []
  const errors: string[] = []
  const narration: string[] = []
  const progressLines: string[] = []
  return {
    lines,
    errors,
    narration,
    progressLines,
    status: (line) => {
      lines.push(line)
    },
    error: (line) => {
      errors.push(line)
    },
    narrate: (line) => {
      narration.push(line)
    },
    progress: (line) => {
      progressLines.push(line)
    },
  }
}

const target = parseCiTarget({ repo: 'o/r', run_id: 1 })

test('monitorCi: polls through transitions with a fake clock', async () => {
  const states = [
    snapshotFromRun(runPayload('queued', null), jobsPayload([])),
    snapshotFromRun(runPayload('in_progress', null), jobsPayload([{ id: 1, name: 'build', status: 'in_progress', conclusion: null }])),
    snapshotFromRun(runPayload('completed', 'success'), jobsPayload([{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }])),
  ]
  const sleeps: number[] = []
  let tick = 0
  const sink = collectingSink()
  const result = await monitorCi({
    target,
    client: new FakeClient(states),
    sink,
    intervalMs: 5000,
    sleep: async (ms) => {
      sleeps.push(ms)
      tick += ms
    },
    now: () => tick,
    logTail: 'none',
  })
  assert.equal(result.polls, 3)
  assert.deepEqual(sleeps, [5000, 5000])
  assert.deepEqual(result.timeline, [
    '状态: queued',
    '状态: queued → in_progress',
    '单元 "build": 出现 in_progress',
    '状态: in_progress → completed',
    '单元 "build": in_progress → completed (success)',
    '终态: completed (success)',
  ])
  assert.equal(result.snapshot.conclusion, 'success')
  assert.equal(sink.progressLines.length, 3)
})

test('monitorCi: backs off on failures with 5s, 10s and recovers', async () => {
  const states: Array<CiSnapshot | Error> = [
    new Error('boom 1'),
    new Error('boom 2'),
    snapshotFromRun(runPayload('completed', 'success'), jobsPayload([])),
  ]
  const sleeps: number[] = []
  const sink = collectingSink()
  const result = await monitorCi({
    target,
    client: new FakeClient(states),
    sink,
    intervalMs: 5000,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    logTail: 'none',
  })
  assert.deepEqual(sleeps, [5000, 10000])
  assert.equal(result.failures, 0)
  assert.equal(result.polls, 1)
  assert.deepEqual(sink.errors, ['轮询失败 (1/5): boom 1', '轮询失败 (2/5): boom 2'])
  assert.deepEqual(result.timeline, ['轮询恢复（此前连续失败 2 次）', '状态: completed', '终态: completed (success)'])
})

test('backoffMs: 5s doubling capped at 60s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(backoffMs), [5000, 10000, 20000, 40000, 60000, 60000, 60000])
})

test('monitorCi: fails after the consecutive-failure threshold', async () => {
  const sink = collectingSink()
  await assert.rejects(
    monitorCi({
      target,
      client: new FakeClient([new Error('auth 401')]),
      sink,
      intervalMs: 5000,
      sleep: async () => {},
      maxConsecutiveFailures: 3,
      logTail: 'none',
    }),
    /监控失败: 连续 3 次轮询出错，最后错误: auth 401/,
  )
  assert.equal(sink.errors.length, 3)
})

test('monitorCi: abort during sleep rejects with an AbortError', async () => {
  const controller = new AbortController()
  const sink = collectingSink()
  await assert.rejects(
    monitorCi({
      target,
      client: new FakeClient([snapshotFromRun(runPayload('in_progress', null), jobsPayload([]))]),
      sink,
      intervalMs: 5000,
      signal: controller.signal,
      sleep: async () => {
        controller.abort()
      },
      logTail: 'none',
    }),
    (error: Error) => error.name === 'AbortError',
  )
  assert.deepEqual(sink.lines, ['状态: in_progress'])
})

test('monitorCi: log_tail=failure fetches only failed units', async () => {
  const client = new FakeClient([
    snapshotFromRun(
      runPayload('completed', 'failure'),
      jobsPayload([
        { id: 11, name: 'ok', status: 'completed', conclusion: 'success' },
        { id: 12, name: 'bad', status: 'completed', conclusion: 'failure' },
      ]),
    ),
  ])
  const sink = collectingSink()
  const result = await monitorCi({ target, client, sink, intervalMs: 5000, sleep: async () => {}, logTail: 'failure', maxLogLines: 10, maxLogBytes: 4096 })
  assert.deepEqual(client.logCalls, [12])
  assert.match(result.logTail ?? '', /--- bad \(job 12\)/)
  assert.match(result.logTail ?? '', /log line B/)
  assert.equal(result.logSource, 'bad')
})

test('monitorCi: log_tail=always fetches every unit with an id, none skips fetching', async () => {
  const snapshot = () =>
    snapshotFromRun(
      runPayload('completed', 'success'),
      jobsPayload([
        { id: 21, name: 'a', status: 'completed', conclusion: 'success' },
        { id: 22, name: 'b', status: 'completed', conclusion: 'success' },
      ]),
    )
  const always = new FakeClient([snapshot()])
  const alwaysResult = await monitorCi({ target, client: always, sink: collectingSink(), intervalMs: 5000, sleep: async () => {}, logTail: 'always' })
  assert.deepEqual(always.logCalls, [21, 22])
  assert.match(alwaysResult.logTail ?? '', /--- a \(job 21\)/)
  assert.match(alwaysResult.logTail ?? '', /--- b \(job 22\)/)

  const none = new FakeClient([snapshot()])
  const noneResult = await monitorCi({ target, client: none, sink: collectingSink(), intervalMs: 5000, sleep: async () => {}, logTail: 'none' })
  assert.deepEqual(none.logCalls, [])
  assert.equal(noneResult.logTail, undefined)
})

test('monitorCi: a failing log fetch only warns, never fails the monitor', async () => {
  class FailingLogClient extends FakeClient {
    async fetchJobLog(): Promise<string> {
      throw new Error('log endpoint 404')
    }
  }
  const client = new FailingLogClient([
    snapshotFromRun(runPayload('completed', 'failure'), jobsPayload([{ id: 31, name: 'bad', status: 'completed', conclusion: 'failure' }])),
  ])
  const sink = collectingSink()
  const result = await monitorCi({ target, client, sink, intervalMs: 5000, sleep: async () => {}, logTail: 'failure' })
  assert.equal(result.snapshot.conclusion, 'failure')
  assert.equal(result.logTail, undefined)
  assert.deepEqual(sink.errors, ['日志抓取失败（单元 "bad"）: log endpoint 404'])
})

test('monitorCi: check targets read their output instead of job logs', async () => {
  const client = new FakeClient([snapshotFromCheckRun({ id: 41, name: 'deploy', status: 'completed', conclusion: 'failure' })])
  const sink = collectingSink()
  const result = await monitorCi({
    target: parseCiTarget({ repo: 'o/r', check_run_id: 41 }),
    client,
    sink,
    intervalMs: 5000,
    sleep: async () => {},
    logTail: 'failure',
  })
  assert.deepEqual(client.checkCalls, [1])
  assert.equal(result.logSource, 'check_run 输出')
  assert.match(result.logTail ?? '', /log line A/)
})

test('monitorCi: truncation caps reach the report', async () => {
  const many = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n')
  const client = new FakeClient(
    [snapshotFromRun(runPayload('completed', 'failure'), jobsPayload([{ id: 51, name: 'bad', status: 'completed', conclusion: 'failure' }]))],
    many,
  )
  const result = await monitorCi({
    target,
    client,
    sink: collectingSink(),
    intervalMs: 5000,
    sleep: async () => {},
    logTail: 'failure',
    maxLogLines: 5,
    maxLogBytes: 65536,
  })
  assert.match(result.logTail ?? '', /已截断：原文 500 行/)
  assert.ok((result.logTail ?? '').split('\n').length < 12)
  assert.match(result.logTail ?? '', /line 499/)
})
