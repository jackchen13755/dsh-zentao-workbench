/**
 * Client for the local browser relay (`dsh-fetch-page`'s daemon on
 * 127.0.0.1:9317), which forwards a request into the user's real browser so the
 * extension attaches the live ZenTao session cookie. No Chrome cookie
 * permission is involved — the browser does the request, we only read the body.
 *
 * Contract (mirrored from dsh-fetch-page, which is validated against this
 * daemon): `POST /forward` with a JSON envelope, answered by a JSON object
 * carrying `{status, statusText, headers, body}` or `{error}`.
 */

export interface BridgeEnvelope {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
  mode: 'auto' | 'fetch' | 'render'
  wait_for_selector: string
  target_selector: string
  timeout: number
  scroll: number
  format: string
}

export interface BridgeResponse {
  status?: number
  statusText?: string
  headers?: Record<string, string>
  body?: string
  error?: string
}

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:9317'

function timeoutSeconds(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/** The daemon answers `/status` with `{ok, running, pid}`; `running:false` means no extension is polling. */
export async function bridgeDaemonStatus(bridgeUrl = DEFAULT_BRIDGE_URL, signal?: AbortSignal): Promise<{ ok: boolean, running: boolean, pid: number | null, error?: string }> {
  try {
    const res = await fetch(`${bridgeUrl}/status`, { signal: signal ?? null })
    if (!res.ok) return { ok: false, running: false, pid: null, error: `HTTP ${res.status}` }
    const json = await res.json() as { ok?: boolean, running?: boolean, pid?: number | null }
    return { ok: json.ok ?? false, running: json.running ?? false, pid: json.pid ?? null }
  } catch (error) {
    return { ok: false, running: false, pid: null, error: (error as Error).message }
  }
}

export interface ForwardRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | null
  mode?: 'auto' | 'fetch' | 'render'
  timeout?: number
  format?: 'markdown' | 'text' | 'html'
  signal?: AbortSignal
}

/** One request through the browser. Throws only on transport failure, never on HTTP status. */
export async function bridgeForward(req: ForwardRequest, bridgeUrl = DEFAULT_BRIDGE_URL): Promise<BridgeResponse> {
  const timeout = timeoutSeconds(req.timeout, 45, 5, 120)
  const envelope: BridgeEnvelope = {
    url: req.url,
    method: req.method ?? 'GET',
    headers: req.headers ?? {},
    body: req.body ?? null,
    mode: req.mode ?? 'fetch',
    wait_for_selector: '',
    target_selector: '',
    timeout,
    scroll: 0,
    format: req.format ?? 'html',
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), (timeout + 15) * 1000)
  const signal = req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal
  try {
    const res = await fetch(`${bridgeUrl}/forward`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal,
    })
    const text = await res.text()
    try {
      return JSON.parse(text) as BridgeResponse
    } catch {
      throw new Error(`浏览器转发返回无效 JSON: ${text.slice(0, 200)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}
