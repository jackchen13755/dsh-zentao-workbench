/**
 * Form login for the classic instance — the third fallback strategy.
 *
 * Measured contract on 10.6 (`GET/POST /index.php?m=user&f=login`):
 *   · the form posts `account`, `password`, `keepLogin[]`, `referer` and a
 *     hidden `verifyRand`;
 *   · the page's `#verifyPassword` script references a field this template does
 *     not render, so the plain password is what the form actually sends — and a
 *     POST with bogus credentials comes back with the server's own verdict
 *     ("登录失败，请检查您的用户名或密码是否填写正确。") rather than a field error;
 *   · **a failed login still sets `zentaosid`**, so cookie presence proves
 *     nothing — success is decided by reading a real page afterwards.
 *
 * The second attempt (`md5(md5(password) + verifyRand)`) exists because some
 * ZenTao builds hash client-side; it is attempted exactly once, and only after
 * the plain form was refused, so this stays deterministic rather than a retry
 * loop.
 */

import { createHash } from 'node:crypto'

export interface LoginAttempt {
  encoding: 'plain' | 'md5+rand'
  detail: string
}

export interface LoginOutcome {
  ok: boolean
  /** `zentaosid=…; …` for reuse in-process. Never written to disk by this module. */
  cookie: string
  detail: string
  verifyRand: string
  attempts: LoginAttempt[]
}

export interface LoginOptions {
  baseUrl: string
  account: string
  password: string
  keepLogin?: boolean
  signal?: AbortSignal
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

/** The hidden anti-replay value the login form carries. */
export function extractVerifyRand(html: string): string {
  return html.match(/name=['"]verifyRand['"][^>]*value=['"]?(\d+)/)?.[1]
    ?? html.match(/id=['"]verifyRand['"][^>]*value=['"]?(\d+)/)?.[1]
    ?? ''
}

/** ZenTao answers a refused login with an `alert('…')` and HTTP 200. */
export function loginFailureMessage(html: string): string {
  const alert = /alert\(\s*(['"])([\s\S]*?)\1\s*\)/.exec(html)
  if (alert?.[2]) return alert[2].replace(/\\n/g, ' ').replace(/\\'/g, "'").replace(/\s+/g, ' ').trim()
  if (/name=['"]?password['"]?[\s>]/.test(html) && /name=['"]?account['"]?[\s>]/.test(html)) return '服务端返回了登录页（凭据未被接受）'
  return ''
}

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex')
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function cookiesFrom(response: Response): string {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? '']
  const pairs = raw
    .map((line) => line.split(';')[0]?.trim() ?? '')
    .filter((pair) => pair.includes('='))
  return pairs.join('; ')
}

function mergeCookies(existing: string, incoming: string): string {
  const map = new Map<string, string>()
  for (const pair of `${existing}; ${incoming}`.split(';')) {
    const [name, ...rest] = pair.trim().split('=')
    if (name !== undefined && name !== '' && rest.length > 0) map.set(name, rest.join('='))
  }
  return [...map].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Log in with account + password. Returns the session cookie on success; the
 * caller decides whether to keep it in memory or persist it (this module never
 * writes a file).
 */
export async function formLogin(options: LoginOptions): Promise<LoginOutcome> {
  const base = options.baseUrl.replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const loginUrl = `${base}/index.php?m=user&f=login`
  const attempts: LoginAttempt[] = []

  const page = await fetchImpl(loginUrl, { signal: options.signal ?? null, redirect: 'follow' })
  const pageHtml = await page.text()
  const verifyRand = extractVerifyRand(pageHtml)
  let cookie = cookiesFrom(page)

  const tryOnce = async (encoding: LoginAttempt['encoding']): Promise<{ ok: boolean, detail: string }> => {
    const password = encoding === 'plain' ? options.password : md5(md5(options.password) + verifyRand)
    const body = new URLSearchParams()
    body.set('account', options.account)
    body.set('password', password)
    if (options.keepLogin !== false) body.set('keepLogin[]', 'on')
    body.set('referer', '')
    if (verifyRand !== '') body.set('verifyRand', verifyRand)

    const posted = await fetchImpl(loginUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT, ...(cookie !== '' ? { cookie } : {}) },
      body: body.toString(),
      signal: options.signal ?? null,
      redirect: 'follow',
    })
    cookie = mergeCookies(cookie, cookiesFrom(posted))
    const html = await posted.text()
    const refusal = loginFailureMessage(html)
    if (refusal !== '') return { ok: false, detail: refusal }

    // The only trustworthy test: does a real page come back?
    const probe = await fetchImpl(`${base}/index.php?m=my&f=bug`, {
      headers: { 'user-agent': USER_AGENT, ...(cookie !== '' ? { cookie } : {}) },
      signal: options.signal ?? null,
      redirect: 'follow',
    })
    const probeHtml = await probe.text()
    const stillLogin = /self\.location\s*=\s*['"][^'"]*m=user&f=login/.test(probeHtml)
      || (/name=['"]?account['"]?[\s>]/.test(probeHtml) && /name=['"]?password['"]?[\s>]/.test(probeHtml))
    if (stillLogin) return { ok: false, detail: '登录后仍未取得会话（页面弹回登录页）' }
    return { ok: true, detail: `登录成功（${encoding === 'plain' ? '明文口令' : 'md5+verifyRand'}）` }
  }

  for (const encoding of ['plain', 'md5+rand'] as const) {
    const result = await tryOnce(encoding)
    attempts.push({ encoding, detail: result.detail })
    if (result.ok) {
      return { ok: true, cookie, detail: result.detail, verifyRand, attempts }
    }
    // A refusal that names the credentials means the shape was understood; the
    // hashed variant cannot help there, so stop instead of guessing.
    if (/用户名或密码|用户名不能为空|密码不能为空/.test(result.detail)) {
      return { ok: false, cookie: '', detail: result.detail, verifyRand, attempts }
    }
  }
  return { ok: false, cookie: '', detail: attempts.at(-1)?.detail ?? '登录失败', verifyRand, attempts }
}
