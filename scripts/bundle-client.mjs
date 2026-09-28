/**
 * Bundle the compiled browser half into the single file the profile's
 * client-modules service serves.
 *
 * The profile evaluates a client bundle as
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … } })
 *
 * so the file must be one CommonJS module graph with the product's own packages
 * (`react`, the slot service) left as `require(...)` calls the loader resolves.
 * The compiled output is a handful of sibling CJS modules, so instead of pulling
 * in a bundler this script inlines the relative requires by hand — the graph has
 * no cycles and no dynamic requires, which is all that needs to hold.
 * (Same approach as dsh-source-control: zero build dependencies.)
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Package name the loader keys this bundle under (must equal `package.json`'s name). */
const PLUGIN_ID = 'dsh-zentao-workbench'
/** tsc output directory for the browser half. */
const BUILD_DIR = 'lib/.client-build'
/** Entry module, relative to the build directory. */
const ENTRY = './index.js'
/** Final bundle path. */
const OUT_FILE = 'lib/client.js'

const modules = readdirSync(BUILD_DIR).filter((name) => name.endsWith('.js')).sort()
const ids = new Map(modules.map((name, index) => [`./${name}`, index]))
if (!ids.has(ENTRY)) throw new Error(`bundle-client: ${ENTRY} not found in ${BUILD_DIR}`)

/** Rewrite relative requires to module-slot lookups; everything else stays the loader's. */
function transform(source) {
  return source.replace(/require\((["'])(\.[^"']*)\1\)/g, (match, _quote, specifier) => {
    const resolved = specifier.endsWith('.js') ? specifier : `${specifier}.js`
    const id = ids.get(resolved.startsWith('./') ? resolved : `./${resolved}`)
    if (id === undefined) throw new Error(`bundle-client: unresolved relative require ${specifier}`)
    return `__require(${id})`
  })
}

const factories = modules
  .map((name, index) => {
    const code = transform(readFileSync(join(BUILD_DIR, name), 'utf8'))
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
writeFileSync(OUT_FILE, body)
rmSync(BUILD_DIR, { recursive: true, force: true })
process.stdout.write(`bundle-client: wrote ${OUT_FILE} (${modules.length} modules, ${body.length} bytes)\n`)
