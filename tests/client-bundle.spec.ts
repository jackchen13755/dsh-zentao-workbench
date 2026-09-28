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
    expect(module.inject).toEqual(['slots'])
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

  it('registers a native sidebar tab, its pane body, and points the floating tab at it', () => {
    const { module } = loadBundle()
    const registered: Array<{ options: Record<string, unknown>, component: (props: unknown) => unknown }> = []
    const injectedSlots: string[] = []
    const injectedServices: string[][] = []
    const tabTypes: Array<{ id: string, kind: string, title: () => string, guide?: Array<Record<string, unknown>> }> = []
    let openedTab: unknown = null

    const ctx = {
      slots: {
        inject: (name: string, callback: () => void) => { injectedSlots.push(name); callback() },
        register: (options: Record<string, unknown>, component: (props: unknown) => unknown) => {
          registered.push({ options, component })
          return () => undefined
        },
      },
      // The seat registrations go through `ctx.inject(['sidebarRightTabs'], …)`
      // and the open through `ctx.inject(['sidebarRight'], …)`. Both are read as
      // PROPERTIES, which is the shape the shipped docs describe.
      inject: (deps: string[], callback: (context: unknown) => unknown) => {
        injectedServices.push(deps)
        const sidebarRightTabs = { register: (definition: { id: string, kind: string, title: () => string, guide?: Array<Record<string, unknown>> }) => { tabTypes.push(definition); return () => undefined } }
        const sidebarRight = { openTab: (kind: unknown, options?: unknown) => { openedTab = { kind, options } } }
        return callback({ sidebarRightTabs, sidebarRight })
      },
      effect: (callback: () => unknown) => callback(),
    }
    ;(module.apply as (context: unknown) => void)(ctx)

    // The tab type is what puts 「禅道」 into the sidebar; the kind must be ours.
    expect(injectedServices).toContainEqual(['sidebarRightTabs'])
    expect(tabTypes).toHaveLength(1)
    expect(tabTypes[0]!.id).toBe('dsh-zentao-workbench:panel')
    expect(tabTypes[0]!.kind).toBe('dsh-zentao-workbench:zentao')
    expect(tabTypes[0]!.title()).toBe('禅道')
    // The sidebar ENTRY. Without `guide` the type and body exist but nothing is
    // listed — the bug that kept 「禅道」 out of the sidebar while 「源代码管理」
    // (which does register a guide) was there all along.
    const guide = (tabTypes[0] as { guide?: Array<Record<string, unknown>> }).guide
    expect(guide).toHaveLength(1)
    expect(guide![0]!.id).toBe('zentao-workbench')
    expect(guide![0]!.order).toBe(35)
    expect((guide![0]!.title as () => string)()).toBe('禅道')
    expect((guide![0]!.description as () => string)()).toContain('Bug')

    // …and the pane body is registered under that same key, in the inline variant.
    expect(injectedSlots).toContain('sidebar.right.pane.tab')
    const body = registered.find((entry) => entry.options.key === 'dsh-zentao-workbench:panel')
    expect(body).toBeDefined()
    const outer = body!.component({}) as { props: Record<string, unknown> }
    expect(outer.props.variant).toBe('sidebar')

    // The shipped contract also registers the tab's *chip/title* seat — without
    // it the tab has a body but no label.
    expect(injectedSlots).toContain('sidebar.right.pane.tab.title')

    // The entry (guide) is what opens it — same as 源代码管理 — so nothing is
    // opened automatically at load.
    expect(openedTab).toBeNull()

    // The floating tab opens the sidebar tab rather than its own drawer.
    const overlay = registered.find((entry) => entry.options.id === 'zentao-workbench')
    expect(overlay).toBeDefined()
    const floating = overlay!.component({}) as { props: Record<string, unknown> }
    expect(typeof floating.props.openInSidebar).toBe('function')
    expect((floating.props.openInSidebar as () => boolean)()).toBe(true)
    // KIND + replaceTab — the shipped README: "openTab(kind, options?)" and a
    // guide capsule opens with `openTab(entry.kind, { replaceTab: true })`.
    expect(openedTab).toEqual({ kind: 'dsh-zentao-workbench:zentao', options: { replaceTab: true } })
  })

  it('falls back to the drawer when the host has no sidebar', () => {
    const { module } = loadBundle()
    let overlayComponent: ((props: unknown) => unknown) | undefined
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => void) => callback(),
        register: (options: Record<string, unknown>, component: (props: unknown) => unknown) => {
          if (options.id === 'zentao-workbench') overlayComponent = component
          return () => undefined
        },
      },
      // No sidebar services at all: `inject` never delivers them.
      inject: (_deps: string[], _callback: (context: unknown) => unknown) => undefined,
      get: (name: string) => { throw new Error(`service "${name}" is not available`) },
      effect: (callback: () => unknown) => callback(),
    }
    ;(module.apply as (context: unknown) => void)(ctx)
    const floating = overlayComponent!({}) as { props: Record<string, unknown> }
    expect((floating.props.openInSidebar as () => boolean)()).toBe(false)
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
    // Collapsed first frame = the right-edge tab.
    expect(tree.type).toBe('button')
    expect(String(tree.props.title)).toContain('禅道工作台')
    expect(String(tree.children[0])).toContain('禅')
    // Regression guard for the reported bug ("入口最大化后看不到了"): the entry
    // must be anchored with CSS to the viewport edge, never positioned from
    // window.innerWidth, which drifts whenever the shell is resized or the
    // overlay's containing block is not the viewport.
    const style = tree.props.style as Record<string, unknown>
    expect(style.position).toBe('fixed')
    expect(style.right).toBe(0)
    // Viewport units only: percentages collapse to 0 inside the shell's
    // transformed, auto-height overlay (measured), which parked the tab at the top.
    expect(style.top).toBe('50vh')
    expect(String(style.transform)).toContain('translateY(-50%)')
    expect(style.left).toBeUndefined()
  })
})
