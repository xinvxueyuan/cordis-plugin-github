import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, inject, name } from '../src/index.ts'

test('plugin metadata', () => {
  assert.equal(name, 'cordis-plugin-github')
  assert.ok(inject.includes('tools'))
})

test('apply registers github_api and github_graphql', () => {
  const registered: string[] = []
  const ctx = {
    tools: {
      register: (tool: { name: string }) => {
        registered.push(tool.name)
        return () => {}
      },
    },
  }
  apply(ctx as never, Config({}) as never)
  assert.deepEqual([...registered].sort(), ['github_api', 'github_graphql'])
})
