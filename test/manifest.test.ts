import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'

/** Read a repository file as UTF-8, resolved beside this test file. */
function read(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
}

function readBytes(relative: string): number {
  return statSync(new URL(`../${relative}`, import.meta.url)).size
}

/** Split a comma-separated YAML/TS list body into trimmed, unquoted members. */
function members(body: string): string[] {
  return body
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item.length > 0)
}

interface Manifest {
  name: string
  icon?: string
  exports: Record<string, unknown>
  files: string[]
  dsh?: { bundle?: { patch?: string } }
}

const patchFile = 'cordis.patch.yml'
const patch = read(patchFile)
const pkg = JSON.parse(read('package.json')) as Manifest

test('package.json declares the bundle patch and the patch file exists', () => {
  assert.equal(pkg.dsh?.bundle?.patch, `./${patchFile}`)
  assert.ok(existsSync(new URL(`../${patchFile}`, import.meta.url)), `${patchFile} must exist`)
})

test('the bundle patch inserts exactly one row with id github and this package name', () => {
  const ids = [...patch.matchAll(/^\s*(?:-\s*)?id:\s*(\S+)\s*$/gm)].map((match) =>
    match[1].replace(/^['"]|['"]$/g, ''),
  )
  assert.deepEqual(ids, ['github'], 'the patch must have exactly one id: line, and it must be github')

  const names = [...patch.matchAll(/^\s*(?:-\s*)?name:\s*(\S+)\s*$/gm)].map((match) =>
    match[1].replace(/^['"]|['"]$/g, ''),
  )
  assert.deepEqual(names, [pkg.name], 'the patch must name this package')
})

test('the patch inject list matches src/index.ts export const inject', () => {
  const patchMatch = patch.match(/^\s*inject:\s*\[([^\]]*)\]\s*$/m)
  assert.ok(patchMatch !== null, 'the patch must declare a single-line inject list')

  const sourceMatch = read('src/index.ts').match(/export\s+const\s+inject\s*=\s*\[([^\]]*)\]/)
  assert.ok(sourceMatch !== null, 'src/index.ts must declare export const inject')

  const fromPatch = members(patchMatch[1]).sort()
  const fromSource = members(sourceMatch[1]).sort()
  assert.deepEqual(fromPatch, fromSource, 'patch inject and src/index.ts inject must be set-equal')
})

test('locale files are valid JSON with non-empty meta title and description', () => {
  for (const locale of ['en', 'zh']) {
    const parsed = JSON.parse(read(`locale/${locale}.json`)) as {
      meta?: { title?: unknown; description?: unknown }
    }
    assert.equal(typeof parsed.meta?.title, 'string', `locale/${locale}.json meta.title must be a string`)
    assert.ok((parsed.meta?.title as string).length > 0, `locale/${locale}.json meta.title must be non-empty`)
    assert.equal(
      typeof parsed.meta?.description,
      'string',
      `locale/${locale}.json meta.description must be a string`,
    )
    assert.ok(
      (parsed.meta?.description as string).length > 0,
      `locale/${locale}.json meta.description must be non-empty`,
    )
  }
})

test('icon.svg exists, stays under 256 KiB and is an SVG', () => {
  assert.ok(existsSync(new URL('../icon.svg', import.meta.url)), 'icon.svg must exist')
  assert.ok(readBytes('icon.svg') <= 256 * 1024, 'icon.svg must be at most 256 KiB')
  const svg = read('icon.svg')
  assert.match(svg, /<svg[\s>]/, 'icon.svg must contain an <svg element')
  // The Host ships icons as a data URI (dsh-app-boot), so `currentColor` resolves to
  // the initial colour instead of following the page theme: pin fixed colours.
  assert.doesNotMatch(svg, /currentColor/i, 'the icon must use fixed colours, not currentColor')
  assert.doesNotMatch(svg, /url\(\s*['"]?(?:https?:|\/\/|data:)/i, 'the icon must not load external resources')
})

test('package exports and files expose the bundle assets', () => {
  for (const key of ['./locale/*.json', './icon', './cordis.patch.yml', './package.json']) {
    assert.ok(key in pkg.exports, `exports must include ${key}`)
  }
  for (const entry of ['cordis.patch.yml', 'locale', 'icon.svg']) {
    assert.ok(pkg.files.includes(entry), `files must include ${entry}`)
  }
})

test('the manifest declares the top-level icon field the Host reads first', () => {
  // dsh-app-boot resolves `package.json#icon` before falling back to `<pkg>/icon`.
  assert.equal(pkg.icon, 'icon.svg', 'package.json must declare icon: "icon.svg"')
  assert.ok(existsSync(new URL('../icon.svg', import.meta.url)), 'the icon field target must exist')
})
