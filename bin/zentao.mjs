#!/usr/bin/env node
/**
 * Thin launcher for the compiled CLI. Keeping the logic in `src/cli.ts` means it
 * is typechecked and unit-tested like everything else; this file only has to
 * fail usefully when the package has not been built yet.
 */
const buildHint = '先构建：pnpm build（或 node node_modules/typescript/bin/tsc -p tsconfig.build.json）'

try {
  const { runCli } = await import('../dist/cli.js')
  process.exitCode = await runCli(process.argv.slice(2))
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write(`zentao: 找不到构建产物 dist/cli.js —— ${buildHint}\n`)
    process.exit(1)
  }
  throw error
}
