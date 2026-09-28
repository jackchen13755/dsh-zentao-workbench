/**
 * Fallback transport: the Netscape cookie jar exported from Chrome
 * (`~/.local/bin/zentao-export-cookies` decrypts the profile's cookie DB via
 * the macOS Keychain and writes one). Using it needs no browser extension, and
 * it is what keeps the workbench useful when the relay is down.
 *
 * Measured caveat that shapes this module: ZenTao's `zentaosid` is a **session**
 * cookie, so the jar goes stale whenever the browser session ends. Staleness is
 * therefore a normal state, not an error — `refreshCookieJar()` re-exports on
 * demand instead of the plugin silently failing.
 */

import { execFile } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface CookieJar {
  path: string
  /** Selector for the target host, e.g. `zentao.example.com`. */
  cookieHeader: string
  /** Unix seconds; `0` means a session cookie (dies with the browser). */
  expiresAt: number
  sessionCookies: number
  names: string[]
  mtimeMs: number
}

export function defaultJarPaths(): string[] {
  return [
    join(homedir(), '.config', 'zentao', 'cookies.txt'),
    join(homedir(), '.dsh', 'storages', 'dsh-zentao-workbench', 'cookies.txt'),
  ]
}

/** Parse a Netscape jar and build the `Cookie:` header for one host. */
export function parseCookieJar(text: string, host: string, mtimeMs = 0): CookieJar {
  const cookies: Array<{ name: string, value: string, expires: number }> = []
  for (const line of text.split('\n')) {
    if (line.startsWith('#') && !line.startsWith('#HttpOnly')) continue
    const fields = line.replace(/^#HttpOnly_/, '').trim().split('\t')
    if (fields.length < 7) continue
    const [domain, , , , expires, name, value] = fields
    if (!domain?.includes(host)) continue
    cookies.push({ name: name ?? '', value: value ?? '', expires: Number(expires) || 0 })
  }
  const now = Math.floor(Date.now() / 1000)
  const live = cookies.filter((c) => c.expires === 0 || c.expires > now)
  const sessionCookies = live.filter((c) => c.expires === 0).length
  return {
    path: '',
    cookieHeader: live.map((c) => `${c.name}=${c.value}`).join('; '),
    // The jar is only as fresh as its oldest session cookie: report the earliest
    // non-zero expiry so callers can warn before a mid-flight expiry.
    expiresAt: live.reduce((min, c) => (c.expires === 0 ? min : Math.min(min || c.expires, c.expires)), 0),
    sessionCookies,
    names: live.map((c) => c.name),
    mtimeMs,
  }
}

export async function readCookieJar(host: string, paths = defaultJarPaths()): Promise<CookieJar | null> {
  for (const path of paths) {
    try {
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      const jar = parseCookieJar(text, host, info.mtimeMs)
      if (jar.cookieHeader !== '') return { ...jar, path }
    } catch {
      // try the next candidate
    }
  }
  return null
}

/**
 * Write a Netscape jar with 0600 permissions.
 *
 * Only ever called from an explicit opt-in (`zentao login --save-jar <path>`):
 * by default the plugin keeps credentials in memory, because a jar on disk is a
 * credential at rest and the measured `zentaosid` dies with the browser anyway.
 */
export async function writeCookieJar(path: string, host: string, cookieHeader: string): Promise<void> {
  const expiry = Math.floor(Date.now() / 1000) + 12 * 3600
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Written by dsh-zentao-workbench (explicit --save-jar)',
    ...cookieHeader.split(';').map((pair) => pair.trim()).filter((pair) => pair !== '').map((pair) => {
      const index = pair.indexOf('=')
      const name = pair.slice(0, index)
      const value = pair.slice(index + 1)
      return [host, 'FALSE', '/', 'FALSE', String(expiry), name, value].join('\t')
    }),
    '',
  ]
  await writeFile(path, lines.join('\n'), { mode: 0o600 })
}

export interface JarRefreshResult {
  ok: boolean
  path?: string
  detail: string
}

/**
 * Re-export the jar with the user's own script. Only ever called explicitly
 * (a tool argument or a panel button): it touches the macOS Keychain, so it can
 * surface an OS prompt and must not sit on a read path.
 */
export async function refreshCookieJar(scriptPath: string, jarPath: string): Promise<JarRefreshResult> {
  try {
    const { stdout, stderr } = await run(scriptPath, [], {
      env: { ...process.env, ZENTAO_COOKIE_JAR: jarPath },
      timeout: 30_000,
    })
    return { ok: true, path: jarPath, detail: (stdout || stderr).trim().slice(0, 300) }
  } catch (error) {
    const e = error as { message?: string, stderr?: string }
    return { ok: false, detail: (e.stderr || e.message || '导出失败').trim().slice(0, 300) }
  }
}
