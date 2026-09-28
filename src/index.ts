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
import { ZENTAO_FETCH_PATH } from './protocol.js'
import { createZentaoFetchRoute, createZentaoRpcHandler, ZENTAO_RPC_CHANNEL } from './rpc.js'

type Disposer = void | (() => void)

interface ConnectionRpcFace {
  handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>): () => Promise<void>
}

interface MinimalContext {
  effect(fn: () => Disposer): void
  tools: { register(tool: unknown): () => void }
  logger?: { info?: (message: string) => void, warn?: (message: string) => void }
  /**
   * cordis: start a child plugin once the named services exist.
   *
   * Do NOT read a service with `ctx.get(name)` here: cordis's Context.get takes
   * `strict = true` and **throws** when the service is not visible, which
   * aborted this plugin's effect mid-way and left the RPC channel unregistered
   * (symptom measured in the shell: tools worked, while `POST /zentao/…` hit the
   * static fallback and answered HTTP 405).
   */
  inject?(inject: string[], callback: (context: MinimalContext & { connection?: ConnectionService }) => Disposer): unknown
  /** Only for the last-resort fallback when `inject` is unavailable. */
  get?(name: string): unknown
}

interface FetchRouteRegistry {
  register(route: unknown): () => void
}

interface ConnectionService {
  rpc?: ConnectionRpcFace
  /** Exact Fetch routes under the shared `/api` prefix (the desktop transport). */
  fetch?: FetchRouteRegistry
}

/** Human-readable outcome of the panel-transport registration, for `zentao doctor`. */
export interface PanelTransportState { state: string }

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
    // Declared outside the inject callback so a tool can report it even when the
    // registration never happened (the failure mode that cost us two rounds).
    const panelTransport: PanelTransportState = { state: '未注册（尚未尝试）' }
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
    for (const tool of createTools({ session, workbench, panelTransport: () => panelTransport.state })) {
      disposers.push(ctx.tools.register(tool))
      ctx.logger?.info?.(`[dsh-zentao-workbench] registered tool: ${(tool as { name?: string }).name ?? '?'}`)
    }

    // The panel needs a transport. Register it as a child plugin that starts
    // when `connection` exists, rather than requiring it: the tools above stay
    // useful in a TUI/headless profile that has no connection service at all.
    const registerPanelTransport = (scoped: MinimalContext & { connection?: ConnectionService }): Disposer => {
      const connection = scoped.connection
      if (connection === undefined) {
        panelTransport.state = '未注册：apply 时看不到 connection 服务'
        scoped.logger?.warn?.(`[dsh-zentao-workbench] ${panelTransport.state}`)
        return
      }
      const handler = createZentaoRpcHandler({
        session,
        workbench,
        exportScript: pluginConfig?.cookieExportScript ?? defaultExportScript(),
        exportJarPath: pluginConfig?.cookieJarPath,
      })
      const call = (endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> => handler(endpoint, payload, signal)

      // Preferred: an exact Fetch route under the shared `/api` prefix. Measured
      // to be the only transport this desktop Host actually mounts.
      if (connection.fetch?.register !== undefined) {
        try {
          const dispose = connection.fetch.register(createZentaoFetchRoute(call))
          scoped.effect(() => () => {
            void Promise.resolve(dispose()).catch(() => undefined)
          })
          panelTransport.state = `已注册：POST ${ZENTAO_FETCH_PATH}（exact fetch route）`
          scoped.logger?.info?.(`[dsh-zentao-workbench] ${panelTransport.state}`)
          return
        } catch (error) {
          panelTransport.state = `fetch 路由注册被拒：${(error as Error).message}`
          scoped.logger?.warn?.(`[dsh-zentao-workbench] ${panelTransport.state}`)
        }
      } else {
        panelTransport.state = 'connection 未提供 fetch 注册表'
      }

      // Fallback: a private RPC channel. Kept because other Host shapes mount
      // these; on this desktop build it is expected to 405.
      if (connection.rpc?.handle !== undefined) {
        try {
          const dispose = connection.rpc.handle(ZENTAO_RPC_CHANNEL, (endpoint, payload, signal) => call(endpoint, payload, signal))
          scoped.effect(() => () => {
            void Promise.resolve(dispose()).catch(() => undefined)
          })
          panelTransport.state += `；已回退注册私有通道 ${ZENTAO_RPC_CHANNEL}（本宿主可能不挂载）`
          scoped.logger?.info?.(`[dsh-zentao-workbench] ${panelTransport.state}`)
          return
        } catch (error) {
          panelTransport.state += `；私有通道注册也失败：${(error as Error).message}`
        }
      }
      scoped.logger?.warn?.(`[dsh-zentao-workbench] ${panelTransport.state}`)
    }

    if (ctx.inject !== undefined) {
      ctx.inject(['connection'], registerPanelTransport)
    } else {
      try {
        registerPanelTransport(ctx as MinimalContext & { connection?: ConnectionService })
      } catch (error) {
        panelTransport.state = `回退注册抛错：${(error as Error).message}`
        ctx.logger?.warn?.(`[dsh-zentao-workbench] ${panelTransport.state}`)
      }
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
