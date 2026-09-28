/**
 * Session resolution for the classic ZenTao instance.
 *
 * Ordered strategies, first one that answers with a real page wins:
 *   ① bridge      — the browser relay, so the extension attaches the live cookie
 *   ② cookie-jar  — a Netscape jar exported from Chrome (no extension needed)
 *   ③ form-login  — account + password → `zentaosid` (implemented in a later milestone)
 *   ④ manual      — a cookie jar or `ZENTAO_COOKIE` supplied by the operator
 *
 * Why this is a first-class module rather than a helper: `zentaosid` is a
 * **session** cookie, so "logged out" is a routine state that shows up
 * mid-conversation. When every strategy fails the caller gets a report naming
 * what each one observed and what to do next — never a bare "未登录".
 */

import { DEFAULT_BRIDGE_URL, bridgeDaemonStatus, bridgeForward } from './bridge.js'
import { defaultJarPaths, readCookieJar, type CookieJar } from './cookies.js'
import { sessionExpired } from './parse.js'

export type StrategyId = 'bridge' | 'cookie-jar' | 'form-login' | 'manual'

export interface StrategyProbe {
  id: StrategyId
  label: string
  /** Whether this strategy can be attempted at all (config/deps present). */
  ready: boolean
  /** What the probe observed, in the operator's words. */
  detail: string
  /** The concrete next action when `ready` is false or the probe failed. */
  hint?: string
}

export interface SessionStatus {
  server: string
  authenticated: boolean
  strategy?: StrategyId
  probes: StrategyProbe[]
  /** When the winning credential is known to expire (unix seconds, 0 = session cookie). */
  expiresAt?: number
}

export interface SessionOptions {
  server?: string
  bridgeUrl?: string
  jarPaths?: string[]
  /** Extra jar path from configuration (a path only — never a cookie value). */
  manualJarPath?: string
  env?: NodeJS.ProcessEnv
  /** Probe cache window in ms. */
  probeTtlMs?: number
}

export interface PageResult {
  status: number
  body: string
  strategy: StrategyId
  url: string
}

export class ZenTaoAuthError extends Error {
  constructor(message: string, readonly status: SessionStatus) {
    super(message)
    this.name = 'ZenTaoAuthError'
  }
}

const BRIDGE_DOWN_HINT = '守护进程没在跑：确认 dsh-fetch-page 的 relay daemon（127.0.0.1:9317）已启动'
const BRIDGE_IDLE_HINT = '守护进程在，但扩展没有在轮询：打开 Chrome 确认 dsh-fetch-page 扩展已启用，然后重试'
const EXPORT_HINT = '可在终端跑 ~/.local/bin/zentao-export-cookies 重新导出（会读 Keychain），或改用浏览器桥'

export class ZenTaoSession {
  private readonly server: string
  private readonly bridgeUrl: string
  private readonly jarPaths: string[]
  private readonly env: NodeJS.ProcessEnv
  private readonly probeTtlMs: number
  private cachedJar: CookieJar | null = null
  private lastProbe: { at: number, status: SessionStatus } | null = null

  constructor(options: SessionOptions = {}) {
    this.server = normalizeServer(options.server ?? options.env?.ZENTAO_BASE ?? '')
    this.bridgeUrl = options.bridgeUrl ?? options.env?.DAEMON_URL ?? DEFAULT_BRIDGE_URL
    this.jarPaths = [
      ...(options.manualJarPath ? [options.manualJarPath] : []),
      ...(options.jarPaths ?? defaultJarPaths()),
    ]
    this.env = options.env ?? process.env
    this.probeTtlMs = options.probeTtlMs ?? 30_000
  }

  url(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl
    if (this.server === '') throw new Error('未配置禅道实例地址：请在插件配置里设置 server（例如 https://zentao.example.com）')
    return `${this.server}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`
  }

  /** Drop caches so the next call re-probes (call after a login/logout or a jar refresh). */
  invalidate(): void {
    this.cachedJar = null
    this.lastProbe = null
  }

  /** GET a page, walking the strategy chain until one returns a real (non-login) page. */
  async get(pathOrUrl: string, signal?: AbortSignal): Promise<PageResult> {
    return await this.request(pathOrUrl, { method: 'GET' }, signal)
  }

  /** POST a form-encoded body through the same chain (used by the resolve submit). */
  async post(pathOrUrl: string, body: string, signal?: AbortSignal): Promise<PageResult> {
    return await this.request(pathOrUrl, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }, signal)
  }

  private async request(pathOrUrl: string, init: { method: 'GET' | 'POST', body?: string, headers?: Record<string, string> }, signal?: AbortSignal): Promise<PageResult> {
    const url = this.url(pathOrUrl)
    const attempts: StrategyProbe[] = []

    for (const strategy of this.order()) {
      if (strategy === 'form-login') {
        attempts.push(this.formLoginProbe())
        continue
      }
      let result: PageResult
      try {
        result = await this.fetchVia(strategy, url, init, signal)
      } catch (error) {
        attempts.push(failureProbe(strategy, (error as Error).message))
        continue
      }
      if (result.status >= 400) {
        attempts.push(failureProbe(strategy, `HTTP ${result.status}`))
        continue
      }
      // A POST is answered with the resolve page or an `alert()`, never by the
      // login form; only treat a *page* shaped like the login redirect as expiry.
      if (sessionExpired(result.body)) {
        attempts.push({
          id: strategy,
          label: LABELS[strategy],
          ready: true,
          detail: '会话已失效（页面被弹回登录页）',
          hint: strategy === 'bridge'
            ? '在浏览器里重新登录禅道后重试'
            : EXPORT_HINT,
        })
        if (strategy === 'cookie-jar' || strategy === 'manual') this.cachedJar = null
        continue
      }
      const probe: StrategyProbe = {
        id: strategy,
        label: LABELS[strategy],
        ready: true,
        detail: strategy === 'bridge' ? '经浏览器扩展转发（自动附带登录 Cookie）' : '使用导出的 cookie jar',
      }
      this.lastProbe = {
        at: Date.now(),
        status: {
          server: this.server,
          authenticated: true,
          strategy,
          probes: [...attempts, probe],
          ...(this.cachedJar?.expiresAt ? { expiresAt: this.cachedJar.expiresAt } : {}),
        },
      }
      return result
    }

    const status: SessionStatus = {
      server: this.server,
      authenticated: false,
      probes: attempts.length > 0 ? attempts : await this.probe(),
    }
    throw new ZenTaoAuthError(`禅道未登录或不可达（${this.server}）`, status)
  }

  /** Alias kept for the read-only probe path. */
  private async probe(): Promise<StrategyProbe[]> {
    return (await this.status(true)).probes
  }

  /** Cached status, with a live probe when the cache is cold or `force` is set. */
  async status(force = false): Promise<SessionStatus> {
    if (!force && this.lastProbe && Date.now() - this.lastProbe.at < this.probeTtlMs) return this.lastProbe.status
    // The instance address is configuration, not a discovery: say so plainly
    // instead of probing four strategies against an empty host.
    if (this.server === '') {
      const status: SessionStatus = {
        server: '',
        authenticated: false,
        probes: [{
          id: 'bridge',
          label: LABELS.bridge,
          ready: false,
          detail: '未配置禅道实例地址',
          hint: '在插件配置里设置 server（例如 https://zentao.example.com），或设环境变量 ZENTAO_BASE',
        }],
      }
      this.lastProbe = { at: Date.now(), status }
      return status
    }
    const probes: StrategyProbe[] = []

    const daemon = await bridgeDaemonStatus(this.bridgeUrl)
    if (!daemon.ok) {
      probes.push({ id: 'bridge', label: LABELS.bridge, ready: false, detail: `守护进程不可达：${daemon.error ?? '未知错误'}`, hint: BRIDGE_DOWN_HINT })
    } else if (!daemon.running) {
      probes.push({ id: 'bridge', label: LABELS.bridge, ready: true, detail: '守护进程在运行，但没有扩展在轮询', hint: BRIDGE_IDLE_HINT })
    } else {
      probes.push({ id: 'bridge', label: LABELS.bridge, ready: true, detail: `守护进程在运行（pid ${daemon.pid ?? '?'}），扩展已连接` })
    }

    const jar = await this.jar()
    probes.push(jar
      ? {
          id: 'cookie-jar',
          label: LABELS['cookie-jar'],
          ready: true,
          detail: `jar 可用（${jar.names.length} 个 cookie，${jar.sessionCookies} 个会话级），导出时间 ${new Date(jar.mtimeMs).toLocaleString()}`,
          ...(jar.sessionCookies > 0 ? { hint: '含会话级 cookie：浏览器一关就失效，需要时重新导出' } : {}),
        }
      : { id: 'cookie-jar', label: LABELS['cookie-jar'], ready: false, detail: '没有可用的 cookie jar', hint: EXPORT_HINT })

    probes.push(this.formLoginProbe())
    const manual = this.env.ZENTAO_COOKIE?.trim()
    probes.push(manual
      ? { id: 'manual', label: LABELS.manual, ready: true, detail: '检测到 ZENTAO_COOKIE' }
      : { id: 'manual', label: LABELS.manual, ready: false, detail: '未提供 ZENTAO_COOKIE', hint: '把 Cookie 串放进环境变量 ZENTAO_COOKIE（不要写进插件配置）' })

    const status: SessionStatus = { server: this.server, authenticated: false, probes }
    this.lastProbe = { at: Date.now(), status }
    return status
  }

  private order(): StrategyId[] {
    return ['bridge', 'cookie-jar', 'manual']
  }

  private formLoginProbe(): StrategyProbe {
    return {
      id: 'form-login',
      label: LABELS['form-login'],
      ready: false,
      detail: '表单账密登录尚未实现（里程碑 M4）',
      hint: '当前请用浏览器桥或 cookie jar；这两条都不通时再考虑账密登录',
    }
  }

  private async jar(): Promise<CookieJar | null> {
    if (this.cachedJar) return this.cachedJar
    this.cachedJar = await readCookieJar(this.host(), this.jarPaths)
    return this.cachedJar
  }

  private host(): string {
    try {
      return new URL(this.server).host
    } catch {
      return this.server
    }
  }

  private async fetchVia(strategy: StrategyId, url: string, init: { method: 'GET' | 'POST', body?: string, headers?: Record<string, string> }, signal?: AbortSignal): Promise<PageResult> {
    if (strategy === 'bridge') {
      const res = await bridgeForward({
        url,
        method: init.method,
        headers: init.headers,
        body: init.body ?? null,
        mode: 'fetch',
        format: 'html',
        signal,
      }, this.bridgeUrl)
      if (res.error) throw new Error(res.error)
      return { status: res.status ?? 200, body: String(res.body ?? ''), strategy, url }
    }
    const cookie = strategy === 'manual' ? (this.env.ZENTAO_COOKIE ?? '').trim() : (await this.jar())?.cookieHeader ?? ''
    if (cookie === '') throw new Error('没有可用的 Cookie')
    const res = await fetch(url, {
      method: init.method,
      body: init.body,
      headers: { cookie, 'user-agent': USER_AGENT, ...(init.headers ?? {}) },
      signal: signal ?? null,
      redirect: 'follow',
    })
    return { status: res.status, body: await res.text(), strategy, url }
  }
}

const LABELS: Record<StrategyId, string> = {
  bridge: '浏览器插件桥',
  'cookie-jar': 'Chrome cookie 导出',
  'form-login': '表单账密登录',
  manual: '手工注入',
}

/** Browsers are the only client this instance ever sees; keep the shape familiar. */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function failureProbe(strategy: StrategyId, detail: string): StrategyProbe {
  if (strategy === 'bridge') return { id: strategy, label: LABELS[strategy], ready: true, detail, hint: BRIDGE_IDLE_HINT }
  if (strategy === 'manual') return { id: strategy, label: LABELS[strategy], ready: true, detail, hint: '检查 ZENTAO_COOKIE 是否完整（含 zentaosid）' }
  return { id: strategy, label: LABELS[strategy], ready: true, detail, hint: EXPORT_HINT }
}

/** Normalize an operator-supplied server: drop the path, keep the origin, default to https. */
export function normalizeServer(input: string): string {
  // Empty stays empty: "not configured" must not silently become `https://`.
  if (input.trim() === '') return ''
  let value = input.trim().replace(/\/+$/, '')
  value = value.replace(/\/index\.php.*$/i, '').replace(/\/api\.php(\/v\d+)?$/i, '')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`
  try {
    return new URL(value).origin
  } catch {
    return value
  }
}

/** Render a status report the way a human (or a model) can act on it. */
export function renderStatus(status: SessionStatus): string {
  const lines = [
    `禅道会话（${status.server}）：${status.authenticated ? `已登录 · 走「${LABELS[status.strategy ?? 'bridge']}」` : '未登录'}`,
  ]
  for (const probe of status.probes) {
    const mark = probe.id === status.strategy ? '✔' : probe.ready ? '·' : '✘'
    lines.push(`  ${mark} ${probe.label}：${probe.detail}`)
    if (!status.authenticated && probe.hint) lines.push(`      → ${probe.hint}`)
  }
  return lines.join('\n')
}
