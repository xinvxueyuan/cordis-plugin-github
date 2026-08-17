import { defineTool } from '@deepseek-ai/dsh-tools'
import { githubCall } from './backend.ts'
import { GithubApiError } from './errors.ts'
import type { GithubConfig } from './config.ts'

/** GraphQL tool: one POST to the /graphql endpoint through the same backend. */
export function defineGraphqlTool(config: GithubConfig) {
  return defineTool({
    name: 'github_graphql',
    description:
      '对 GitHub GraphQL API 执行查询。适合 REST 难以表达的关联查询（跨仓库聚合、嵌套数据、按需选字段、连接分页）。查询返回 errors 且无 data 时抛出结构化错误。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'GraphQL 查询字符串，例如 { viewer { login } }',
      },
      variables: {
        type: 'object',
        additionalProperties: true,
        description: '查询变量对象（可选），对应 query 中声明的 $var',
      },
      host: { type: 'string', description: '覆盖 API 主机（企业版 GitHub）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'graphql', kind: 'fetch', rawInput: args.query }),
    async execute(args, exec) {
      const response = await githubCall(config, {
        endpoint: 'graphql',
        method: 'POST',
        body: {
          query: args.query,
          ...(args.variables !== undefined ? { variables: args.variables } : {}),
        },
        host: args.host,
        signal: exec.signal,
      })
      const value = response.value
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        const errors = record.errors
        if (Array.isArray(errors) && errors.length > 0 && (record.data === undefined || record.data === null)) {
          const messages = errors.map((entry) => {
            if (
              entry !== null &&
              typeof entry === 'object' &&
              typeof (entry as { message?: unknown }).message === 'string'
            ) {
              return (entry as { message: string }).message
            }
            return String(entry)
          })
          throw new GithubApiError(200, `GraphQL 错误: ${messages.join('; ')}`)
        }
      }
      return value
    },
  })
}
