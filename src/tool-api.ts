import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallKind } from '@deepseek-ai/dsh-tools'
import { githubCall } from './backend.ts'
import { GithubApiError } from './errors.ts'
import type { GithubConfig } from './config.ts'
import type { GithubQuery } from './types.ts'

/** Keep only flat primitive query values; nested values cannot be sent to GitHub. */
function normalizeQuery(query: Record<string, import('@deepseek-ai/dsh-tools').JsonValue> | undefined): GithubQuery | undefined {
  if (query === undefined) return undefined
  const result: GithubQuery = {}
  for (const [key, value] of Object.entries(query)) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
    } else {
      throw new GithubApiError(0, `query 参数 "${key}" 必须是字符串、数字或布尔值`)
    }
  }
  return result
}

function methodKind(method: string): ToolCallKind {
  switch (method) {
    case 'GET':
    case 'HEAD':
      return 'read'
    case 'POST':
    case 'PATCH':
    case 'PUT':
      return 'edit'
    case 'DELETE':
      return 'delete'
    default:
      return 'other'
  }
}

/** The generic REST tool: normalized access to every GitHub endpoint. */
export function defineApiTool(config: GithubConfig) {
  return defineTool({
    name: 'github_api',
    description:
      '规范化调用 GitHub REST API。覆盖 gh CLI 没有专门子命令的全部端点（workflow runs/jobs/artifacts、codespaces、environments、org/teams、audit log、search、releases 与 asset 上传、contents 原始文件、rate_limit 等）。优先经本机已登录的 gh CLI 执行（gh api），gh 缺失或未登录时自动回退原生 HTTP。endpoint 不带前导斜杠，如 "repos/owner/repo/issues"。写操作（POST/PATCH/PUT/DELETE）会真实修改 GitHub 数据，调用前请确认。',
    parameters: {
      endpoint: {
        type: 'string',
        required: true,
        description: 'REST API 路径，不带前导 "/"，例如 repos/owner/repo/issues 或 rate_limit',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'],
        default: 'GET',
        description: 'HTTP 方法，默认 GET',
      },
      query: {
        type: 'object',
        additionalProperties: true,
        description: '查询参数对象，例如 { state: "open", per_page: 30 }',
      },
      body: { type: 'json', description: 'JSON 请求体（写操作时提供）' },
      paginate: {
        type: 'boolean',
        default: false,
        description:
          '自动翻页并把所有页合并为一个数组（仅列表端点）。每页 per_page 默认 100，最多 maxPages 页（默认 50，约 5000 条），超出会截断',
      },
      raw: {
        type: 'boolean',
        default: false,
        description: '以原始文本返回响应体（用于非 JSON 端点：raw 文件内容、tarball 等）',
      },
      host: { type: 'string', description: '覆盖 API 主机（企业版 GitHub），如 github.example.com' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        return [{ type: 'text', text }]
      },
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: (args) => !args.method || args.method === 'GET' || args.method === 'HEAD',
    presentCall: (args) => {
      const method = args.method ?? 'GET'
      return {
        card: 'generic',
        title: `${method} ${args.endpoint}`,
        kind: methodKind(method),
        rawInput: args.query,
      }
    },
    async execute(args, exec) {
      const response = await githubCall(config, {
        endpoint: args.endpoint,
        method: args.method ?? 'GET',
        query: normalizeQuery(args.query),
        body: args.body,
        paginate: args.paginate ?? false,
        raw: args.raw ?? false,
        host: args.host,
        signal: exec.signal,
      })
      if (args.raw) return response.rawText ?? ''
      return response.value
    },
  })
}
