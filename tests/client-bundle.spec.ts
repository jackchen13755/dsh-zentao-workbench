import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Smoke-test the browser bundle the way the profile loads it.
 *
 * The real host evaluates `lib/client.js` with `window.__ModuleLoader__.load`,
 * hands the factory a `require` that resolves the product's own packages, and
 * then calls `apply(ctx)`. Everything here mirrors that contract with stubs, so
 * a wiring mistake (wrong slot name, a service read at apply time, a component
 * that throws on first render) fails in CI instead of after a DSH restart.
 */

interface FakeElement { type: unknown, props: Record<string, unknown>, children: unknown[] }

function makeReact() {
  const elements: FakeElement[] = []
  return {
    elements,
    api: {
      createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): FakeElement {
        const element = { type, props: props ?? {}, children }
        elements.push(element)
        return element
      },
      useState<S>(initial: S | (() => S)): [S, (value: S | ((previous: S) => S)) => void] {
        return [typeof initial === 'function' ? (initial as () => S)() : initial, () => undefined]
      },
      useEffect: () => undefined,
      useMemo: <T>(factory: () => T): T => factory(),
      useCallback: <T>(callback: T): T => callback,
      useRef: <T>(initial: T): { current: T } => ({ current: initial }),
    },
  }
}

function loadBundle() {
  const source = readFileSync('lib/client.js', 'utf8')
  let definition: { id: string, factory: (require: (name: string) => unknown) => Record<string, unknown> } | undefined
  const react = makeReact()
  const win = {
    __ModuleLoader__: { load: (value: typeof definition) => { definition = value } },
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    confirm: () => false,
  }
  const require = (name: string): unknown => {
    if (name === 'react') return react.api
    throw new Error(`bundle required an unexpected package: ${name}`)
  }
  // The bundle is an IIFE-style script, not a module: evaluate it with the two
  // globals it expects, then run the factory exactly as the loader would.
  // eslint-disable-next-line no-new-func
  new Function('window', 'navigator', 'document', source)(win, { clipboard: { writeText: async () => undefined } }, {})
  if (definition === undefined) throw new Error('bundle did not call window.__ModuleLoader__.load')
  return { definition, react, module: definition.factory(require) }
}

describe('browser bundle', () => {
  it('loads under the host module loader and declares the services it needs', () => {
    const { definition, module } = loadBundle()
    expect(definition.id).toBe('dsh-zentao-workbench')
    expect(module.inject).toEqual(['slots', 'connection'])
    expect(typeof module.apply).toBe('function')
  })

  it('registers the floating entry into the shell overlay slot', () => {
    const { module } = loadBundle()
    const registered: Array<{ options: Record<string, unknown>, component: (props: unknown) => unknown }> = []
    const injected: string[] = []
    const ctx = {
      slots: {
        inject: (name: string, callback: () => void) => { injected.push(name); callback() },
        register: (options: Record<string, unknown>, component: (props: unknown) => unknown) => {
          registered.push({ options, component })
          return () => undefined
        },
      },
      connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
      get: (name: string) => (name === 'sessions'
        ? { list: { getSnapshot: () => ({ current: undefined }) }, open: () => undefined, scope: () => undefined }
        : name === 'workspaces'
          ? { list: { getSnapshot: () => ({ items: [] }) }, connectWorkspace: async () => 's1' }
          : undefined),
      effect: () => undefined,
    }
    ;(module.apply as (context: unknown) => void)(ctx)
    expect(injected).toEqual(['shell.overlay'])
    expect(registered).toHaveLength(1)
    expect(registered[0]!.options).toMatchObject({ name: 'shell.overlay', id: 'zentao-workbench' })
  })

  it('carries no placeholder host or unfinished marker into the shipped bundle', () => {
    // Regression: the drag reference was once built as
    // `https://example.invalid${href}`, so a quoted bug carried a dead link.
    // Instances differ, so the origin must come from the RPC config at runtime.
    const source = readFileSync('lib/client.js', 'utf8')
    for (const marker of ['example.invalid', 'example.com', 'TODO', 'FIXME', 'XXX']) {
      expect(source.includes(marker), `bundle must not contain ${marker}`).toBe(false)
    }
    // …and the origin-joining helper must actually be there.
    expect(source).toContain("startsWith('/')")
  })

  it('renders its first frame without a session (the panel body is the status report)', () => {
    const { module, react } = loadBundle()
    let component: ((props: unknown) => unknown) | undefined
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => void) => callback(),
        register: (_options: Record<string, unknown>, value: (props: unknown) => unknown) => {
          component = value
          return () => undefined
        },
      },
      connection: { rpc: { call: async () => ({ ok: true, value: { server: '', authenticated: false, probes: [] } }) } },
      get: () => undefined,
      effect: () => undefined,
    }
    ;(module.apply as (context: unknown) => void)(ctx)
    expect(component).toBeDefined()
    // The seat hands back an element for our component; render that one level so
    // the component body (hooks, initial state) actually runs.
    const outer = component!({}) as FakeElement
    expect(typeof outer.type).toBe('function')
    const tree = (outer.type as (props: unknown) => FakeElement)(outer.props)
    expect(react.elements.length).toBeGreaterThan(0)
    // Collapsed first frame = the draggable floating entry.
    expect(tree.type).toBe('button')
    expect(String(tree.props.title)).toContain('拖动')
    expect(String(tree.children[0])).toContain('禅')
  })
})
