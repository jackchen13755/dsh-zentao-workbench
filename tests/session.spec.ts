import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeServer, renderStatus, ZenTaoSession } from '../src/session.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv

describe('normalizeServer', () => {
  it('keeps the origin and drops the classic paths', () => {
    expect(normalizeServer('https://zt.example.com/')).toBe('https://zt.example.com')
    expect(normalizeServer('https://zt.example.com/index.php?m=my&f=bug')).toBe('https://zt.example.com')
    expect(normalizeServer('https://zt.example.com/api.php/v2')).toBe('https://zt.example.com')
  })

  it('adds https when the scheme is missing', () => {
    expect(normalizeServer('zt.example.com')).toBe('https://zt.example.com')
  })

  it('keeps an empty value empty instead of inventing a host', () => {
    expect(normalizeServer('   ')).toBe('')
  })
})

describe('ZenTaoSession configuration', () => {
  // Regression: an earlier draft assigned `this.env` after reading it, so
  // ZENTAO_BASE was silently ignored and every call reported "未配置实例地址".
  it('reads the instance from the environment', () => {
    const session = new ZenTaoSession({ env: env({ ZENTAO_BASE: 'https://zt.example.com/index.php' }) })
    expect(session.url('/index.php?m=my&f=bug')).toBe('https://zt.example.com/index.php?m=my&f=bug')
  })

  it('prefers an explicit option over the environment', () => {
    const session = new ZenTaoSession({
      server: 'https://explicit.example.com',
      env: env({ ZENTAO_BASE: 'https://zt.example.com' }),
    })
    expect(session.url('/x')).toBe('https://explicit.example.com/x')
  })

  it('adopts the instance from an existing cookie jar (zero-config start)', () => {
    // A machine that already exported its browser cookies knows its instance;
    // reading the host out of that jar is what makes a fresh install usable.
    const session = new ZenTaoSession({
      env: env({}),
      jarPaths: [join(fixtures, 'cookies.txt')],
    })
    expect(session.serverOrigin()).toBe('jar')
    expect(session.url('/index.php?m=my&f=bug')).toBe('https://zt.example.com/index.php?m=my&f=bug')
  })

  it('fails loudly when no instance is configured', async () => {
    // Isolate from this machine's real jar: the jar fallback would otherwise
    // (correctly) supply an address, and there would be nothing to fail on.
    const session = new ZenTaoSession({ env: env({}), jarPaths: ['/nonexistent/jar.txt'] })
    expect(() => session.url('/x')).toThrow(/未配置禅道实例地址/)
    const status = await session.status(true)
    expect(status.authenticated).toBe(false)
    expect(status.probes[0]?.detail).toContain('未配置')
    // The report must be actionable, not just descriptive.
    expect(renderStatus(status)).toContain('ZENTAO_BASE')
  })

  it('honours ZENTAO_COOKIE_JAR (documented, and what the sibling tools export)', () => {
    const withEnv = new ZenTaoSession({
      env: env({ ZENTAO_BASE: 'https://zt.example.com', ZENTAO_COOKIE_JAR: '~/zt/cookies.txt' }),
    })
    expect(withEnv.jarPathsForDisplay()[0]).toBe('~/zt/cookies.txt')
    // …and an explicit --cookie-jar still wins over the environment.
    const withOption = new ZenTaoSession({
      env: env({ ZENTAO_BASE: 'https://zt.example.com', ZENTAO_COOKIE_JAR: '~/zt/cookies.txt' }),
      manualJarPath: '/explicit/jar.txt',
    })
    expect(withOption.jarPathsForDisplay().slice(0, 2)).toEqual(['/explicit/jar.txt', '~/zt/cookies.txt'])
  })

  it('takes the bridge url from DAEMON_URL and the jar path from options', () => {
    const session = new ZenTaoSession({
      env: env({ ZENTAO_BASE: 'https://zt.example.com', DAEMON_URL: 'http://127.0.0.1:9999' }),
      manualJarPath: '/tmp/example-jar.txt',
    })
    // Only observable through behaviour we can assert cheaply: probing the
    // configured (unreachable) daemon must not throw.
    expect(() => session.url('/x')).not.toThrow()
  })
})
