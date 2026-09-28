import { describe, expect, it, vi } from 'vitest'
import { extractVerifyRand, formLogin, loginFailureMessage } from '../src/login.js'
import { ZenTaoSession } from '../src/session.js'
import { bugListPage, bugRow, loginFailureFixture, loginPageFixture, loginRedirectPage } from './fixtures/pages.js'

const BASE = 'https://zt.example.com'
const LOGIN = `${BASE}/index.php?m=user&f=login`
const BUGS = `${BASE}/index.php?m=my&f=bug`

interface Exchange { status: number, body: string, cookies?: string[] }

/** A fetch double that answers by URL + method and records the POST bodies. */
function fetchStub(script: { getLogin?: Exchange, post?: Exchange[], getBugs?: Exchange }) {
  const posts: string[] = []
  let postIndex = 0
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const pick = (exchange: Exchange): Response => {
      const headers = new Headers({ 'content-type': exchange.body.startsWith('<') ? 'text/html' : 'application/json' })
      for (const cookie of exchange.cookies ?? []) headers.append('set-cookie', cookie)
      return new Response(exchange.body, { status: exchange.status, headers })
    }
    if (url === LOGIN && method === 'GET') return pick(script.getLogin ?? { status: 200, body: loginPageFixture(), cookies: ['zentaosid=first; path=/'] })
    if (url === LOGIN && method === 'POST') {
      posts.push(String(init?.body ?? ''))
      const exchange = script.post?.[Math.min(postIndex, (script.post?.length ?? 1) - 1)] ?? { status: 200, body: '<html>ok</html>' }
      postIndex += 1
      return pick(exchange)
    }
    if (url === BUGS) return pick(script.getBugs ?? { status: 200, body: bugListPage([bugRow({ id: '1', title: 'x' })]) })
    throw new Error(`unexpected ${method} ${url}`)
  }) as unknown as typeof fetch
  return { impl, posts }
}

describe('login form helpers', () => {
  it('reads the anti-replay value from either attribute order', () => {
    expect(extractVerifyRand(loginPageFixture('99887766'))).toBe('99887766')
    expect(extractVerifyRand(`<input id='verifyRand' value='42' name='verifyRand'/>`)).toBe('42')
    expect(extractVerifyRand('<html>no form</html>')).toBe('')
  })

  it('surfaces the server refusal verbatim', () => {
    expect(loginFailureMessage(loginFailureFixture())).toContain('用户名或密码')
    // A plain login page also counts as "not accepted".
    expect(loginFailureMessage(loginPageFixture())).toContain('登录页')
    expect(loginFailureMessage('<html>ok</html>')).toBe('')
  })
})

describe('formLogin', () => {
  it('logs in with the plain password and confirms by reading a real page', async () => {
    const { impl, posts } = fetchStub({})
    const result = await formLogin({ baseUrl: BASE, account: 'dev.one', password: 'secret', fetchImpl: impl })
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('明文口令')
    expect(result.cookie).toContain('zentaosid=first')
    expect(posts).toHaveLength(1)
    const body = new URLSearchParams(posts[0]!)
    expect(body.get('account')).toBe('dev.one')
    expect(body.get('password')).toBe('secret')
    expect(body.get('verifyRand')).toBe('1134243522')
    expect(body.get('keepLogin[]')).toBe('on')
  })

  it('stops after one attempt when the server blames the credentials', async () => {
    // Retrying with the hashed variant cannot fix a wrong password, and blind
    // retries are exactly what this plugin exists to remove.
    const { impl, posts } = fetchStub({ post: [{ status: 200, body: loginFailureFixture() }] })
    const result = await formLogin({ baseUrl: BASE, account: 'dev.one', password: 'nope', fetchImpl: impl })
    expect(result.ok).toBe(false)
    expect(posts).toHaveLength(1)
    expect(result.attempts).toHaveLength(1)
    expect(result.detail).toContain('用户名或密码')
  })

  it('falls back to md5(md5(password)+rand) once when the plain form was not understood', async () => {
    const posts: string[] = []
    let hashedPosted = false
    const html = (body: string, cookies: string[] = []): Response => {
      const headers = new Headers({ 'content-type': 'text/html' })
      for (const cookie of cookies) headers.append('set-cookie', cookie)
      return new Response(body, { status: 200, headers })
    }
    // Stateful on purpose: the probe after the *plain* attempt must still see a
    // login page, otherwise attempt 1 would look successful and never fall back.
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === LOGIN && method === 'GET') return html(loginPageFixture())
      if (url === LOGIN) {
        const body = String(init?.body ?? '')
        posts.push(body)
        const hashed = new URLSearchParams(body).get('password') !== 'secret'
        if (hashed) {
          hashedPosted = true
          return html('<html>ok</html>', ['zentaosid=second; path=/'])
        }
        return html('<html><body>nothing here</body></html>')
      }
      if (url === BUGS) return html(hashedPosted ? bugListPage([bugRow({ id: '1', title: 'x' })]) : loginRedirectPage())
      throw new Error(`unexpected ${method} ${url}`)
    }) as unknown as typeof fetch

    const result = await formLogin({ baseUrl: BASE, account: 'dev.one', password: 'secret', fetchImpl: impl })
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('md5+verifyRand')
    expect(posts).toHaveLength(2)
    expect(new URLSearchParams(posts[0]!).get('password')).toBe('secret')
    expect(new URLSearchParams(posts[1]!).get('password')).toMatch(/^[0-9a-f]{32}$/)
    expect(result.attempts.map((attempt) => attempt.encoding)).toEqual(['plain', 'md5+rand'])
  })

  it('reports a session that never materialises', async () => {
    const { impl } = fetchStub({ post: [{ status: 200, body: '<html>ok</html>' }], getBugs: { status: 200, body: loginRedirectPage() } })
    const result = await formLogin({ baseUrl: BASE, account: 'dev.one', password: 'secret', fetchImpl: impl })
    expect(result.ok).toBe(false)
    expect(result.cookie).toBe('')
  })
})

describe('ZenTaoSession.login', () => {
  it('adopts the cookie in memory and prefers it afterwards', async () => {
    const session = new ZenTaoSession({ server: BASE, env: {} as NodeJS.ProcessEnv })
    expect(session.hasRuntimeCookie()).toBe(false)
    expect(session.runtimeCookieForJar()).toBe('')
    session.setRuntimeCookie('zentaosid=abc')
    expect(session.hasRuntimeCookie()).toBe(true)
    expect(session.runtimeCookieForJar()).toBe('zentaosid=abc')
    session.clearRuntimeCookie()
    expect(session.hasRuntimeCookie()).toBe(false)
  })

  it('says so plainly when no credentials are configured', async () => {
    const session = new ZenTaoSession({ server: BASE, env: {} as NodeJS.ProcessEnv })
    const status = await session.status(true)
    const probe = status.probes.find((entry) => entry.id === 'form-login')
    expect(probe?.ready).toBe(false)
    expect(probe?.hint).toContain('ZENTAO_ACCOUNT')
  })
})
