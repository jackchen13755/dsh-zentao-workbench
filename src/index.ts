/**
 * dsh-zentao-workbench — bundle entry.
 *
 * A ZenTao workbench for the classic `index.php` era (measured on 10.6): a
 * browser-bridge-first session, the my-bug list, a single-shot bug context, and
 * a resolve path that fills the form deterministically instead of letting a
 * model guess at 254/892-option dropdowns.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createZentaoRpcHandler, ZENTAO_RPC_CHANNEL } from './rpc.js'

type Disposer = void | (() => void)

interface ConnectionRpcFace {
  handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>): () => Promise<void>
}

interface MinimalContext {
  effect(fn: () => Disposer): void
  tools: { register(tool: unknown): () => void }
  logger?: { info?: (message: string) => void, warn?: (message: string) => void }
  /** Read a service without declaring it as a hard dependency. */
  get?(name: string): unknown
}

export const name = 'dsh-zentao-workbench'

/** Only the tools service is required for the read/resolve surface. */
export const inject = ['tools'] as const

export interface PluginConfig {
  /** Instance origin; a path or `/index.php` suffix is stripped. */
  server?: string
  /** Browser relay daemon, default http://127.0.0.1:9317. */
  bridgeUrl?: string
  /** Extra cookie-jar path (a PATH only — never a cookie value). */
  cookieJarPath?: string
  bugContextTtlMs?: number
  listTtlMs?: number
  /** Script the panel's "重新导出 cookie" button runs (path only). */
  cookieExportScript?: string
}

/** Default export script location, resolved at runtime rather than hardcoded. */
function defaultExportScript(): string {
  return join(homedir(), '.local', 'bin', 'zentao-export-cookies')
}

export { bridgeDaemonStatus, bridgeForward } from './bridge.js'
export { defaultJarPaths, parseCookieJar, readCookieJar, refreshCookieJar } from './cookies.js'
export { RESOLVE_FIELD_RULES } from './fields.js'
export {
  extractRequiredFields,
  isLoggedIn,
  isLoginRedirect,
  lastResolvedBuild,
  matchBuildOptions,
  parseBugList,
  parseBugView,
  parseHistories,
  parseResolveForm,
  resolveUid,
  selectedValue,
  selectOptions,
  sessionExpired,
} from './parse.js'
export { alertMessage, compressToLimit, planResolve, renderPlan, submitResolve, type ResolveArgs, type ResolvePlan } from './resolve.js'
export { normalizeServer, renderStatus, ZenTaoAuthError, ZenTaoSession, type SessionStatus, type StrategyId } from './session.js'
export { createTools } from './tools.js'
export { resolveBug, ZentaoWorkbench, type BugContext, type MyBugsResult } from './zentao.js'
export { createZentaoRpcHandler, ZENTAO_RPC_CHANNEL, type RpcResult } from './rpc.js'

import { ZenTaoSession } from './session.js'
import { createTools } from './tools.js'
import { ZentaoWorkbench } from './zentao.js'

export function apply(ctx: MinimalContext, pluginConfig?: PluginConfig): void {
  ctx.effect(() => {
    const session = new ZenTaoSession({
      server: pluginConfig?.server,
      bridgeUrl: pluginConfig?.bridgeUrl,
      manualJarPath: pluginConfig?.cookieJarPath,
    })
    const workbench = new ZentaoWorkbench(session, {
      bugTtlMs: pluginConfig?.bugContextTtlMs,
      listTtlMs: pluginConfig?.listTtlMs,
    })
    const disposers: Array<() => void> = []
    for (const tool of createTools({ session, workbench })) {
      disposers.push(ctx.tools.register(tool))
      ctx.logger?.info?.(`[dsh-zentao-workbench] registered tool: ${(tool as { name?: string }).name ?? '?'}`)
    }

    // The panel needs a transport; a TUI/headless profile simply has none, and
    // the tools above stay useful there — hence the opportunistic lookup
    // instead of a hard `inject` on the connection service.
    const connection = ctx.get?.('connection') as { rpc?: ConnectionRpcFace } | undefined
    if (connection?.rpc !== undefined) {
      const handler = createZentaoRpcHandler({
        session,
        workbench,
        exportScript: pluginConfig?.cookieExportScript ?? defaultExportScript(),
        exportJarPath: pluginConfig?.cookieJarPath,
      })
      const dispose = connection.rpc.handle(ZENTAO_RPC_CHANNEL, (endpoint, payload, signal) => handler(endpoint, payload, signal))
      disposers.push(() => {
        void Promise.resolve(dispose()).catch(() => undefined)
      })
      ctx.logger?.info?.(`[dsh-zentao-workbench] rpc channel ${ZENTAO_RPC_CHANNEL} registered (panel transport)`)
    } else {
      ctx.logger?.info?.('[dsh-zentao-workbench] no connection service — panel transport unavailable, tools only')
    }

    ctx.logger?.info?.('[dsh-zentao-workbench] loaded (browser-bridge-first session; resolve plans before it posts)')
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // a failing disposer must not keep the others from running
        }
      }
    }
  })
}
