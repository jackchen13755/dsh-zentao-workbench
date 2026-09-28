/**
 * Bundle the compiled browser half into the single file the profile serves.
 *
 * The profile evaluates a client bundle as
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … } })
 *
 * so the file must be one CommonJS module graph with the product's own packages
 * (`react`, the slot service) left as `require(...)` calls the loader resolves.
 * The compiled output is a handful of sibling/descendant CJS modules, so instead
 * of pulling in a bundler this script inlines relative requires by hand — the
 * graph has no cycles and no dynamic requires, which is all that needs to hold.
 * (Same approach as dsh-source-control: zero build dependencies.)
 *
 * It resolves specifiers per importing module, so `src/protocol.ts` shared with
 * the host half can live above `src/client/`.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Package name the loader keys this bundle under (must equal `package.json`'s name). */
const PLUGIN_ID = 'dsh-zentao-workbench'
/** tsc output directory for the browser half. */
const BUILD_DIR = 'lib/.client-build'
/** Entry module, relative to the build directory. */
const ENTRY = 'client/index.js'
/** Final bundle path. */
const OUT_FILE = 'lib/client.js'

/** Every compiled module, as paths relative to BUILD_DIR ('client/panel.js'). */
function collect(dir, prefix = '') {
  const found = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const relative = prefix === '' ? entry : `${prefix}/${entry}`
    if (statIsDirectory(full)) found.push(...collect(full, relative))
    else if (relative.endsWith('.js')) found.push(relative)
  }
  return found
}
function statIsDirectory(path) {
  try {
    readdirSync(path)
    return true
  } catch {
    return false
  }
}

const modules = collect(BUILD_DIR).sort()
const ids = new Map(modules.map((name, index) => [name, index]))
if (!ids.has(ENTRY)) throw new Error(`bundle-client: ${ENTRY} not found in ${BUILD_DIR}`)

/** Resolve `./x.js` from the importing module's own directory to a module slot. */
function resolveRelative(fromPath, specifier) {
  const segments = fromPath.split('/').slice(0, -1)
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  const target = segments.join('/')
  return ids.get(target.endsWith('.js') ? target : `${target}.js`)
}

/** Rewrite relative requires to module-slot lookups; everything else stays the loader's. */
function transform(source, fromPath) {
  return source.replace(/require\((["'])(\.[^"']*)\1\)/g, (match, _quote, specifier) => {
    const id = resolveRelative(fromPath, specifier)
    if (id === undefined) throw new Error(`bundle-client: unresolved relative require ${specifier} (from ${fromPath})`)
    return `__require(${id})`
  })
}

const factories = modules
  .map((name, index) => {
    const code = transform(readFileSync(join(BUILD_DIR, name), 'utf8'), name)
    return [
      `__factories[${index}] = function () {`,
      'var module = { exports: {} }; var exports = module.exports;',
      code,
      'return module.exports;',
      '};',
    ].join('\n')
  })
  .join('\n')

const body = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(PLUGIN_ID)},`,
  '\tfactory: (require) => {',
  '\t\tvar __factories = [];',
  '\t\tvar __cache = {};',
  '\t\tfunction __require(id) {',
  '\t\t\tif (__cache[id] === undefined) __cache[id] = __factories[id]();',
  '\t\t\treturn __cache[id];',
  '\t\t}',
  factories,
  `\t\treturn __require(${ids.get(ENTRY)});`,
  '\t},',
  '});',
  '',
].join('\n')

mkdirSync('lib', { recursive: true })
// Bake the build time into the bundle.
//
// Written for a real problem: three rounds of client fixes appeared to "not work"
// because the page was still running an older bundle — and nothing on screen said
// which one. The panel footer prints this stamp, so staleness is visible.
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
writeFileSync(OUT_FILE, body.replaceAll('__BUILD_STAMP__', JSON.stringify(stamp)))
rmSync(BUILD_DIR, { recursive: true, force: true })
process.stdout.write(`bundle-client: wrote ${OUT_FILE} (${modules.length} modules, ${body.length} bytes)\n`)
