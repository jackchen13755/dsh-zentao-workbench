/**
 * Host half of the panel: a Connection RPC channel the browser workbench calls.
 *
 * Mirrors the shape `@haoyu-qi/dsh-zentao` uses (`connection.rpc.handle` +
 * `rpc.call(channel, endpoint, payload)` and `{ok, value}` results), because that
 * is the transport this host actually serves to a client plugin.
 *
 * Two deliberate constraints:
 *  · the panel is a **read** surface: submitting a resolve requires an explicit
 *    `confirm: true`, so a stray click can never write to ZenTao;
 *  · a dead session is a normal answer, not a transport error — it comes back as
 *    a structured failure carrying the four-strategy report the panel renders.
 */

import { refreshCookieJar } from './cookies.js'
import type { ResolveArgs } from './resolve.js'
import { ZenTaoAuthError, type SessionStatus, type ZenTaoSession } from './session.js'
import { resolveBug, ZentaoWorkbench, type BugContext } from './zentao.js'

/** Absolute channel, matching the client's `rpc.call('/zentao', …)`. */
export const ZENTAO_RPC_CHANNEL = '/zentao'

export interface RpcFailure {
  ok: false
  error: { code: string, message: string, details: Record<string, unknown> }
}

export interface RpcSuccess {
  ok: true
  value: unknown
}

export type RpcResult = RpcSuccess | RpcFailure

export interface RpcDeps {
  session: ZenTaoSession
  workbench: ZentaoWorkbench
  /** Cookie-export script, run only when the panel explicitly asks. */
  exportScript?: string
  exportJarPath?: string
  /** Injectable for tests. */
  resolve?: typeof resolveBug
}

function fail(code: string, message: string, details: Record<string, unknown> = {}): RpcFailure {
  return { ok: false, error: { code, message, details } }
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** The panel's `getConfig`: enough to render the status light without a probe. */
function configSnapshot(session: ZenTaoSession, status: SessionStatus): Record<string, unknown> {
  return {
    server: status.server,
    authenticated: status.authenticated,
    strategy: status.strategy ?? null,
    probes: status.probes,
    // Never the cookie value — only whether a source exists.
    hasEnvCookie: (process.env.ZENTAO_COOKIE ?? '').trim() !== '',
    jarPaths: session.jarPathsForDisplay(),
  }
}

/**
 * Build the channel handler. Kept as a plain function so it can be unit-tested
 * without a cordis context.
 */
export function createZentaoRpcHandler(deps: RpcDeps) {
  const { session, workbench } = deps
  const runResolve = deps.resolve ?? resolveBug

  return async function handle(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult> {
    const body = asRecord(payload)
    try {
      switch (endpoint) {
        case 'getConfig': {
          const status = await session.status(false)
          return { ok: true, value: configSnapshot(session, status) }
        }

        case 'sessionStatus': {
          const status = await session.status(body.refresh === true)
          return { ok: true, value: { ...status, config: configSnapshot(session, status) } }
        }

        case 'listBugs': {
          const result = await workbench.myBugs({
            limit: numberOr(body.limit, 30),
            only: (body.only === 'open' || body.only === 'resolved' ? body.only : 'all') as 'all' | 'open' | 'resolved',
            refresh: body.refresh === true,
          })
          return { ok: true, value: result }
        }

        case 'listTasks': {
          const result = await workbench.myTasks({
            projectID: typeof body.projectID === 'string' ? body.projectID : undefined,
            limit: numberOr(body.limit, 30),
          })
          return { ok: true, value: result }
        }

        case 'bugContext': {
          const bugID = String(body.bugID ?? '').trim()
          if (bugID === '') return fail('bad-request', '缺少 bugID')
          const context: BugContext = await workbench.bugContext(bugID, {
            build: typeof body.build === 'string' ? body.build : undefined,
            refresh: body.refresh === true,
          })
          return { ok: true, value: context }
        }

        case 'buildSearch': {
          const bugID = String(body.bugID ?? '').trim()
          const query = String(body.query ?? '').trim()
          if (bugID === '' || query === '') return fail('bad-request', '缺少 bugID 或 query')
          const context = await workbench.bugContext(bugID, { build: query })
          // Only the matches: the dropdown holds 254 options on the measured instance.
          return { ok: true, value: { matches: context.resolve.buildMatches, total: context.resolve.optionCounts.resolvedBuild } }
        }

        case 'resolvePlan': {
          const bugID = String(body.bugID ?? '').trim()
          if (bugID === '') return fail('bad-request', '缺少 bugID')
          const context = await workbench.bugContext(bugID, { build: typeof body.build === 'string' ? body.build : undefined })
          const plan = workbench.plan(context, resolveArgs(body))
          return { ok: true, value: { plan, context } }
        }

        case 'resolveSubmit': {
          const bugID = String(body.bugID ?? '').trim()
          if (bugID === '') return fail('bad-request', '缺少 bugID')
          // The panel is a read surface by default: writing needs intent.
          if (body.confirm !== true) return fail('confirm-required', '提交需要 confirm: true（面板默认只读）')
          const run = await runResolve(workbench, bugID, { ...resolveArgs(body), dryRun: false })
          return { ok: true, value: { plan: run.plan, outcome: run.outcome ?? null } }
        }

        case 'login': {
          const account = String(body.account ?? '').trim()
          const password = typeof body.password === 'string' ? body.password : ''
          if (account === '' || password === '') return fail('bad-request', '缺少 account 或 password')
          const result = await session.login(account, password)
          // The password never leaves this call: it is not stored, not logged,
          // and the resulting cookie lives in the session's memory only.
          if (!result.ok) return fail('login-failed', result.detail)
          const status = await session.status(true)
          return { ok: true, value: { detail: result.detail, status } }
        }

        case 'logout': {
          session.clearRuntimeCookie()
          const status = await session.status(true)
          return { ok: true, value: { status } }
        }

        case 'refreshCookies': {
          if (typeof deps.exportScript !== 'string' || deps.exportScript === '') {
            return fail('unavailable', '未配置 cookie 导出脚本（exportScript）')
          }
          const result = await refreshCookieJar(deps.exportScript, deps.exportJarPath ?? '')
          if (!result.ok) return fail('export-failed', result.detail)
          session.invalidate()
          const status = await session.status(true)
          return { ok: true, value: { detail: result.detail, status } }
        }

        default:
          return fail('unknown-endpoint', `未知 endpoint：${endpoint}`)
      }
    } catch (error) {
      if (error instanceof ZenTaoAuthError) {
        // Routine, not exceptional: hand the panel the report it renders.
        return fail('zentao-unauthenticated', error.message, {
          server: error.status.server,
          probes: error.status.probes,
          config: configSnapshot(session, error.status),
        })
      }
      return fail('zentao-error', (error as Error).message)
    }
  }
}

/** Pull only the resolve arguments a panel may send. */
function resolveArgs(body: Record<string, unknown>): ResolveArgs {
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)
  return {
    resolution: text(body.resolution),
    reason: text(body.reason),
    detail: text(body.detail),
    impact: text(body.impact),
    comment: text(body.comment),
    build: text(body.build),
    assignedTo: text(body.assignedTo),
    inChargedBy: text(body.inChargedBy),
    force: body.force === true,
    dryRun: body.dryRun === true,
  }
}
