import type { PageResult, ZenTaoSession } from '../../src/session.js'

export interface FakeSession extends ZenTaoSession {
  readonly gets: string[]
  readonly posts: Array<{ path: string, body: string }>
}

/**
 * A session double with request counters, so a test can assert the property the
 * whole design rests on: a failed resolve costs the next attempt **one POST**,
 * not another pair of page fetches.
 */
export function fakeSession(handler: (path: string, method: 'GET' | 'POST', body?: string) => string | { body: string, status?: number }): FakeSession {
  const gets: string[] = []
  const posts: Array<{ path: string, body: string }> = []
  let base = 'https://zen.example.test'
  const session = {
    get gets() { return gets },
    get posts() { return posts },
    url: (path: string) => (path.startsWith('http') ? path : `${base}${path}`),
    invalidate: () => undefined,
    /** Mirrors the real session's display-only accessor (paths, never values). */
    jarPathsForDisplay: () => ['/tmp/fake-jar.txt'],
    async get(path: string): Promise<PageResult> {
      gets.push(path)
      const out = handler(path, 'GET')
      const value = typeof out === 'string' ? { body: out, status: 200 } : { status: out.status ?? 200, body: out.body }
      return { status: value.status, body: value.body, strategy: 'cookie-jar', url: `${base}${path}` }
    },
    async post(path: string, body: string): Promise<PageResult> {
      posts.push({ path, body })
      const out = handler(path, 'POST', body)
      const value = typeof out === 'string' ? { body: out, status: 200 } : { status: out.status ?? 200, body: out.body }
      return { status: value.status, body: value.body, strategy: 'cookie-jar', url: `${base}${path}` }
    },
    async status() {
      return { server: base, authenticated: true, probes: [] }
    },
  }
  base = 'https://zen.example.test'
  return session as unknown as FakeSession
}
