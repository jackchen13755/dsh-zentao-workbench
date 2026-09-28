import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'

/**
 * Regression suite for the panel transport registration.
 *
 * The live symptom was: tools worked, but the browser got
 * `transport failure for /zentao/sessionStatus: HTTP 405` — the channel was
 * never mounted as a webServer route. Cause: the entry read the connection
 * service with `ctx.get('connection')`, and cordis's `Context.get` takes
 * `strict = true`, so it **threw** — aborting the effect *after* the tools had
 * been registered, which is why only half the plugin came up.
 *
 * These fakes reproduce that semantics (a `get` that throws, an `inject` that
 * hands the service over) so the bug cannot come back silently.
 */
interface FakeConnection {
  rpc: { handle: (channel: string, handler: unknown) => () => void }
  fetch?: { register: (route: unknown) => () => void }
}

function fakeCordis(options: { withInject?: boolean, withConnection?: boolean, getThrows?: boolean, withFetch?: boolean } = {}) {
  const tools: string[] = []
  const injected: string[][] = []
  const channels: string[] = []
  const routes: string[] = []
  const warnings: string[] = []
  const effects: Array<() => void> = []

  const scoped = {
    effect: (fn: () => void | (() => void)) => { const disposer = fn(); if (typeof disposer === 'function') effects.push(disposer) },
    tools: { register: (tool: unknown) => { tools.push(String((tool as { name?: string }).name)); return () => undefined } },
    logger: { info: () => undefined, warn: (message: string) => warnings.push(message) },
    connection: options.withConnection === false
      ? undefined
      : {
          rpc: { handle: (channel: string) => { channels.push(channel); return () => undefined } },
          ...(options.withFetch === false
            ? {}
            : { fetch: { register: (route: unknown) => { routes.push((route as { path: string, methods: string[] }).path); return () => undefined } } }),
        } satisfies FakeConnection,
  }

  const ctx = {
    effect: (fn: () => void | (() => void)) => { const disposer = fn(); if (typeof disposer === 'function') effects.push(disposer) },
    tools: scoped.tools,
    logger: scoped.logger,
    // A real cordis Context exposes services as properties; the fallback path
    // (no `ctx.inject`) reads it that way.
    ...(options.withConnection === false ? {} : { connection: scoped.connection }),
    ...(options.withInject === false
      ? {}
      : {
          inject: (deps: string[], callback: (context: unknown) => void) => {
            injected.push(deps)
            callback(scoped)
          },
        }),
    // Mimics cordis: strict lookups throw instead of returning undefined.
    get: (name: string) => {
      if (options.getThrows === false) return undefined
      throw new Error(`service "${name}" is not available`)
    },
  }
  return { ctx, tools, injected, channels, routes, warnings, effects }
}

describe('apply()', () => {
  it('registers the tools and mounts the panel channel through ctx.inject', () => {
    const world = fakeCordis()
    expect(() => apply(world.ctx as never)).not.toThrow()
    expect(world.tools).toEqual([
      'zentao_session_status',
      'zentao_my_bugs',
      'zentao_tasks',
      'zentao_bug_context',
      'zentao_resolve_bug',
    ])
    expect(world.injected).toEqual([['connection']])
    // Preferred transport on this Host: an exact Fetch route under /api.
    expect(world.routes).toEqual(['/api/zentao'])
    // …so the private channel is not attempted at all.
    expect(world.channels).toEqual([])
  })

  it('reports why the transport is missing, so a 405 is never a mystery', () => {
    const missing = fakeCordis({ withConnection: false })
    apply(missing.ctx as never)
    const statusTool = missing.tools.find((name) => name === 'zentao_session_status')
    expect(statusTool).toBeDefined()
    expect(missing.warnings.join(' ')).toContain('看不到 connection 服务')
  })

  it('falls back to the private channel when the Host exposes no fetch registry', () => {
    const world = fakeCordis({ withFetch: false })
    apply(world.ctx as never)
    expect(world.routes).toEqual([])
    expect(world.channels).toEqual(['/zentao'])
  })

  it('never lets a strict service lookup abort the plugin (the 405 bug)', () => {
    // Same shape as the live host: connect lookup throws when read strictly.
    const world = fakeCordis({ getThrows: true })
    apply(world.ctx as never)
    expect(world.tools).toHaveLength(5)
    expect(world.routes).toEqual(['/api/zentao'])
  })

  it('stays usable without a connection service (headless/TUI)', () => {
    const world = fakeCordis({ withConnection: false })
    apply(world.ctx as never)
    expect(world.tools).toHaveLength(5)
    expect(world.routes).toEqual([])
    expect(world.channels).toEqual([])
    expect(world.warnings.join(' ')).toContain('未注册')
  })

  it('falls back to a direct registration when the host has no ctx.inject', () => {
    const world = fakeCordis({ withInject: false, getThrows: false })
    apply(world.ctx as never)
    expect(world.tools).toHaveLength(5)
    // Without `inject` the connection property is still usable…
    expect(world.routes).toEqual(['/api/zentao'])
  })

  it('survives a host with neither inject nor a connection service', () => {
    const world = fakeCordis({ withInject: false, withConnection: false, getThrows: true })
    expect(() => apply(world.ctx as never)).not.toThrow()
    expect(world.tools).toHaveLength(5)
    expect(world.routes).toEqual([])
    expect(world.channels).toEqual([])
  })
})

describe('plugin surface', () => {
  it('declares only tools as a hard dependency', async () => {
    const module = await import('../src/index.js')
    expect(module.inject).toEqual(['tools'])
    expect(module.name).toBe('dsh-zentao-workbench')
  })

  it('disposes what it registered', () => {
    const world = fakeCordis()
    const dispose = vi.fn()
    const ctx = { ...world.ctx, effect: (fn: () => void) => { const disposer = fn(); if (typeof disposer === 'function') dispose.mockImplementation(disposer) } }
    apply(ctx as never)
    expect(typeof dispose.getMockImplementation()).toBe('function')
  })
})
