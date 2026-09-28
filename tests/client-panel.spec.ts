import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Drive the compiled panel with a minimal hooks runtime.
 *
 * The loader smoke test proves the bundle mounts; this proves the panel *does
 * something*: its effects run, a refresh hits the endpoints the design promises,
 * and the rendered tree carries what the user was told to look for (the refresh
 * button, the list, the detail card). No browser is involved, so it runs in CI.
 */

interface Element { type: unknown, props: Record<string, unknown>, children: unknown[] }

function textOf(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (Array.isArray(node)) node.forEach((child) => textOf(child, out))
  else if (node !== null && typeof node === 'object') {
    const element = node as Element
    if (typeof element.type === 'function') textOf((element.type as (props: unknown) => unknown)(element.props), out)
    else element.children.forEach((child) => textOf(child, out))
  }
  return out
}

/** Find the first element whose props satisfy the predicate. */
function find(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node === null || typeof node !== 'object') return undefined
  const element = node as Element
  if (typeof element.type === 'function') return find((element.type as (props: unknown) => unknown)(element.props), predicate)
  if (predicate(element)) return element
  for (const child of element.children) {
    const hit = find(child, predicate)
    if (hit !== undefined) return hit
  }
  return undefined
}

const flush = async (rounds = 6): Promise<void> => {
  for (let index = 0; index < rounds; index++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function mount(
  rpc: (endpoint: string, payload?: unknown) => Promise<{ ok: true, value: unknown }>,
  handlePrompt: (text: string) => Promise<void> = async () => undefined,
) {
  // The panel's host calls now go through fetch(`${ZENTAO_FETCH_PATH}`), so the
  // stub replaces global fetch instead of injecting an rpc service.
  ;(globalThis as { fetch?: unknown }).fetch = async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { endpoint: string, payload?: unknown }
    const result = await rpc(body.endpoint, body.payload)
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const source = readFileSync('lib/client.js', 'utf8')
  let definition: { factory: (require: (name: string) => unknown) => Record<string, unknown> } | undefined

  const slots: unknown[] = []
  const refs: unknown[] = []
  const memoSlots: Array<{ value: unknown, deps: readonly unknown[] } | undefined> = []
  const effects: Array<{ deps?: readonly unknown[], cleanup?: void | (() => void), run: () => void | (() => void) }> = []
  /**
   * Previous deps, kept OUT of the effect records: those records are rebuilt on
   * every render, so storing `previousDeps` on them lost the comparison and made
   * every effect re-run on every render (which the panel's loaders multiplied
   * into a pile of extra listBugs calls).
   */
  const effectDeps: Array<readonly unknown[] | undefined> = []
  let cursor = 0
  let effectCursor = 0
  let dirty = false
  const scheduled: Array<() => void> = []

  const hooks = {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): Element {
      return { type, props: props ?? {}, children }
    },
    useState<S>(initial: S | (() => S)): [S, (value: S | ((previous: S) => S)) => void] {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => S)() : initial
      return [slots[index] as S, (value) => {
        slots[index] = typeof value === 'function' ? (value as (previous: S) => S)(slots[index] as S) : value
        dirty = true
      }]
    },
    useRef<T>(initial: T): { current: T } {
      const index = cursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index] as { current: T }
    },
    /**
     * Memoised like React: returning a fresh function every render made any
     * effect that depends on a callback re-run on every render, which showed up
     * as +10 surprise listBugs calls in a test. Deps are compared shallowly.
     */
    useCallback<T>(callback: T, deps?: readonly unknown[]): T {
      const index = cursor++
      const slot = memoSlots[index]
      const changed = slot === undefined || deps === undefined
        || slot.deps.length !== deps.length || deps.some((value, i) => value !== slot.deps[i])
      if (changed) memoSlots[index] = { value: callback, deps: deps ?? [] }
      return memoSlots[index]!.value as T
    },
    useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
      const index = cursor++
      const slot = memoSlots[index]
      const changed = slot === undefined || deps === undefined
        || slot.deps.length !== deps.length || deps.some((value, i) => value !== slot.deps[i])
      if (changed) memoSlots[index] = { value: factory(), deps: deps ?? [] }
      return memoSlots[index]!.value as T
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
      const index = effectCursor++
      effects[index] = { deps, run: effect }
    },
  }

  const win: Record<string, unknown> = {
    __ModuleLoader__: { load: (value: typeof definition) => { definition = value } },
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    confirm: () => true,
  }
  const require = (name: string): unknown => {
    if (name === 'react') return hooks
    throw new Error(`unexpected require ${name}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'navigator', 'document', source)(win, { clipboard: { writeText: async () => undefined } }, {})

  const module = definition!.factory(require)
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
  // The panel's "处理"/"批量引用" go through the real `buildHandlePrompt`, which
  // opens a conversation via sessions/workspaces. Stub those services by their
  // actual shape so the whole path is exercised and the sent text is captured.
  const ctxWithServices = {
    ...ctx,
    get: (name: string) => (name === 'sessions'
      ? {
          list: { getSnapshot: () => ({ current: 's1' }) },
          open: () => undefined,
          scope: () => ({ get: () => ({ send: async (text: string) => { await handlePrompt(text) } }) }),
        }
      : name === 'workspaces'
        ? {
            list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], recentWorkspaceId: 'w1' }) },
            connectWorkspace: async () => 's2',
          }
        : undefined),
  }
  ;(module.apply as (context: unknown) => void)(ctxWithServices)
  if (component === undefined) throw new Error('panel did not register')

  const render = (): Element => {
    cursor = 0
    effectCursor = 0
    const outer = component!({}) as Element
    const tree = (outer.type as (props: unknown) => unknown)(outer.props) as Element
    // Run effects whose deps changed (first render always runs).
    effects.forEach((effect, index) => {
      if (effect === undefined) return
      const previous = effectDeps[index]
      const changed = previous === undefined || effect.deps === undefined
        || effect.deps.length !== previous.length
        || effect.deps.some((value, i) => value !== previous[i])
      if (!changed) return
      effect.cleanup?.()
      effect.cleanup = effect.run() ?? undefined
      effectDeps[index] = effect.deps
    })
    return tree
  }

  const settle = async (): Promise<Element> => {
    let tree = render()
    // Effects start async work; re-render while state keeps changing.
    for (let round = 0; round < 8 && dirty; round++) {
      dirty = false
      await flush()
      tree = render()
    }
    await flush()
    dirty = false
    return render()
  }

  void scheduled
  return { settle, hooks }
}

describe('panel behaviour (compiled bundle, minimal hooks runtime)', () => {
  it('loads, then a refresh hits status + list, and the list renders', async () => {
    const calls: string[] = []
    const rpc = async (endpoint: string): Promise<{ ok: true, value: unknown }> => {
      calls.push(endpoint)
      if (endpoint === 'sessionStatus' || endpoint === 'getConfig') {
        return { ok: true, value: { server: 'https://zt.example.com', authenticated: true, strategy: 'bridge', probes: [], config: { server: 'https://zt.example.com', authenticated: true, strategy: 'bridge', probes: [] } } }
      }
      if (endpoint === 'listBugs') {
        return {
          ok: true,
          value: {
            bugs: [
              { id: '55036', title: '浮层问题', severity: '主要', pri: '3', type: '需求逻辑问题', assignedTo: 'dev.one', resolution: '', href: '/index.php?m=bug&f=view&bugID=55036' },
              { id: '55035', title: '另一个问题', severity: '次要', pri: '2', type: '需求逻辑问题', assignedTo: 'dev.one', resolution: '', href: '/index.php?m=bug&f=view&bugID=55035' },
            ],
            total: 2,
            via: 'bridge',
            url: 'https://zt.example.com/index.php?m=my&f=bug',
            fetchedAt: '2026-09-28T00:00:00.000Z',
            cached: false,
          },
        }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }

    const { settle } = mount(rpc)
    let tree = await settle()

    // Collapsed entry → open it the way a user would.
    const entry = find(tree, (element) => element.type === 'button')!
    ;(entry.props.onClick as () => void)()
    tree = await settle()

    // The panel had to load its data after opening.
    expect(calls).toContain('listBugs')
    const text = textOf(tree).join(' ')
    expect(text).toContain('禅道工作台')
    expect(text).toContain('刷新')
    expect(text).toContain('55036')
    expect(text).toContain('55035')

    // The refresh button must re-read status AND the list (one refresh, whole view).
    calls.length = 0
    const refresh = find(tree, (element) => element.type === 'button' && String(element.children[0] ?? '').includes('刷新'))!
    ;(refresh.props.onClick as () => void)()
    await settle()
    expect(calls.filter((endpoint) => endpoint === 'sessionStatus').length).toBeGreaterThanOrEqual(1)
    expect(calls).toContain('listBugs')
  })

  it('switches to the task tab and renders the instance\'s honest empty state', async () => {
    const calls: string[] = []
    const note = '该项目（或本实例）没有任务数据；实测本实例 8 个项目全部为空 —— 这里是如实反映，不是解析失败'
    const rpc = async (endpoint: string): Promise<{ ok: true, value: unknown }> => {
      calls.push(endpoint)
      if (endpoint === 'sessionStatus' || endpoint === 'getConfig') {
        return { ok: true, value: { server: 'https://zt.example.com', authenticated: true, strategy: 'bridge', probes: [], config: { server: 'https://zt.example.com', authenticated: true, probes: [] } } }
      }
      if (endpoint === 'listBugs') {
        return { ok: true, value: { bugs: [], total: 0, via: 'bridge', url: '', fetchedAt: '', cached: false } }
      }
      if (endpoint === 'listTasks') {
        return { ok: true, value: { tasks: [], total: 0, empty: true, via: 'bridge', url: '', fetchedAt: '', note } }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }

    const { settle } = mount(rpc)
    let tree = await settle()
    ;(find(tree, (element) => element.type === 'button')!.props.onClick as () => void)()
    tree = await settle()

    const tab = find(tree, (element) => element.type === 'button' && element.children[0] === '任务')!
    expect(tab).toBeDefined()
    ;(tab.props.onClick as () => void)()
    tree = await settle()

    expect(calls).toContain('listTasks')
    expect(textOf(tree).join(' ')).toContain('没有任务数据')
  })

  it('re-queries with the chosen order when the sort control changes', async () => {
    const orders: unknown[] = []
    const rpc = async (endpoint: string, payload?: unknown): Promise<{ ok: true, value: unknown }> => {
      if (endpoint === 'sessionStatus' || endpoint === 'getConfig') {
        return { ok: true, value: { server: 'https://zt.example.com', authenticated: true, strategy: 'bridge', probes: [], config: { server: 'https://zt.example.com', authenticated: true, probes: [] } } }
      }
      if (endpoint === 'listBugs') {
        orders.push((payload as { orderBy?: unknown }).orderBy)
        return { ok: true, value: { bugs: [{ id: '55036', title: '浮层问题', severity: '主要', pri: '3', type: 'x', assignedTo: 'dev.one', resolution: '', href: '/x' }], total: 1, truncated: false, via: 'bridge', url: '', fetchedAt: '', cached: false } }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
    const { settle } = mount(rpc)
    let tree = await settle()
    ;(find(tree, (element) => element.type === 'button' && element.props['data-zentao-entry'] === '1')!.props.onClick as () => void)()
    tree = await settle()
    expect(orders[0]).toBe('id_desc')

    const sort = find(tree, (element) => element.props['data-zentao-sort'] === '1')!
    expect(sort).toBeDefined()
    ;(sort.props.onChange as (event: unknown) => void)({ target: { value: 'severity_asc' } })
    await settle()
    expect(orders).toContain('severity_asc')
  })

  it('renders a coloured severity badge per level', async () => {
    const rpc = async (endpoint: string): Promise<{ ok: true, value: unknown }> => {
      if (endpoint === 'sessionStatus' || endpoint === 'getConfig') {
        return { ok: true, value: { server: 'https://zt.example.com', authenticated: true, strategy: 'bridge', probes: [], config: { server: 'https://zt.example.com', authenticated: true, probes: [] } } }
      }
      if (endpoint === 'listBugs') {
        return { ok: true, value: { bugs: [
          { id: '1', title: '致命单', severity: '主要', severityLevel: 1, pri: '3', type: 'x', assignedTo: 'dev', resolution: '', href: '/x' },
          { id: '2', title: '次要单', severity: '次要', severityLevel: 4, pri: '3', type: 'x', assignedTo: 'dev', resolution: '', href: '/x' },
        ], total: 2, truncated: false, via: 'bridge', url: '', fetchedAt: '', cached: false } }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
    const { settle } = mount(rpc)
    let tree = await settle()
    ;(find(tree, (element) => element.type === 'button' && element.props['data-zentao-entry'] === '1')!.props.onClick as () => void)()
    tree = await settle()

    const badges: Array<Record<string, unknown>> = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (node === null || typeof node !== 'object') return
      const element = node as { type: unknown, props: Record<string, unknown>, children: unknown[] }
      if (typeof element.type === 'function') return walk((element.type as (props: unknown) => unknown)(element.props))
      if (element.props?.['data-zentao-severity'] !== undefined) badges.push(element.props.style as Record<string, unknown>)
      element.children?.forEach(walk)
    }
    walk(tree)

    expect(badges).toHaveLength(2)
    for (const style of badges) {
      expect(String(style.background)).toMatch(/^#[0-9a-f]{6}$/i)
      expect(String(style.color)).toMatch(/^#[0-9a-f]{6}$/i)
    }
    // The whole point of the request: different levels must look different.
    expect(badges[0]!.background).not.toBe(badges[1]!.background)
  })

  it('filters the fetched page locally and switches scope server-side', async () => {
    const scopeCalls: unknown[] = []
    const rpc = async (endpoint: string, payload?: unknown): Promise<{ ok: true, value: unknown }> => {
      if (endpoint === 'sessionStatus' || endpoint === 'getConfig') {
        return { ok: true, value: { server: 'https://zt.example.com', authenticated: true, strategy: 'bridge', probes: [], config: { server: 'https://zt.example.com', authenticated: true, probes: [] } } }
      }
      if (endpoint === 'listProjects') {
        return { ok: true, value: { projects: [{ id: '187', name: 'Upsell STUAT' }], via: 'bridge', url: '', fetchedAt: '' } }
      }
      if (endpoint === 'listBugs') {
        scopeCalls.push((payload as { scope?: unknown }).scope)
        return { ok: true, value: { bugs: [
          { id: '55036', title: '查询条件location浮层问题', severity: '主要', severityLevel: 3, pri: '3', type: '需求逻辑问题', assignedTo: 'dev', resolution: '', href: '/x' },
          { id: '55035', title: '支付回调超时', severity: '致命', severityLevel: 1, pri: '1', type: '代码错误', assignedTo: 'dev2', resolution: '', href: '/x' },
        ], total: 2, truncated: false, via: 'bridge', url: '', fetchedAt: '', cached: false } }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
    const { settle } = mount(rpc)
    let tree = await settle()
    ;(find(tree, (element) => element.type === 'button' && element.props['data-zentao-entry'] === '1')!.props.onClick as () => void)()
    tree = await settle()

    // 本地搜索：单号/级别都能命中，且不产生新的服务端调用
    const before = scopeCalls.length
    const input = find(tree, (element) => element.props['data-zentao-search'] === '1')!
    ;(input.props.onChange as (event: unknown) => void)({ target: { value: '55035' } })
    tree = await settle()
    expect(scopeCalls.length).toBe(before)
    const titlesAfterSearch = textOf(tree).join(' ')
    expect(titlesAfterSearch).toContain('支付回调超时')
    expect(titlesAfterSearch).not.toContain('查询条件location浮层问题')

    // 切到项目范围 → 服务端重取，并带上 scope=project
    const scopeSelect = find(tree, (element) => element.props['data-zentao-scope'] === '1')!
    ;(scopeSelect.props.onChange as (event: unknown) => void)({ target: { value: 'project' } })
    await settle()
    expect(scopeCalls).toContain('project')
  })

  it('batches the ticked bugs through plan → submit, and quotes them into one conversation', async () => {
    const calls: string[] = []
    const prompts: string[] = []
    const rpc = async (endpoint: string, payload?: unknown): Promise<{ ok: true, value: unknown }> => {
      calls.push(endpoint)
      if (endpoint === 'sessionStatus' || endpoint === 'getConfig') {
        return { ok: true, value: { server: 'https://zt.example.com', authenticated: true, strategy: 'bridge', probes: [], config: { server: 'https://zt.example.com', authenticated: true, probes: [] } } }
      }
      if (endpoint === 'listBugs') {
        return { ok: true, value: { bugs: [
          { id: '11', title: '第一条', severity: '主要', severityLevel: 3, pri: '3', type: 'x', assignedTo: 'dev', resolution: '', href: '/index.php?m=bug&f=view&bugID=11' },
          { id: '22', title: '第二条', severity: '次要', severityLevel: 4, pri: '2', type: 'x', assignedTo: 'dev', resolution: '', href: '/index.php?m=bug&f=view&bugID=22' },
        ], total: 2, truncated: false, via: 'bridge', url: '', fetchedAt: '', cached: false } }
      }
      if (endpoint === 'resolvePlan') {
        return { ok: true, value: { plan: { bugID: 'x', status: '激活', fields: [], problems: [], autoFilled: {}, notes: [], blocked: false } } }
      }
      if (endpoint === 'resolveSubmit') {
        // The batch must still ask for an explicit confirmation per call.
        expect((payload as { confirm?: boolean }).confirm).toBe(true)
        return { ok: true, value: { outcome: { ok: true, status: '已解决' } } }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
    const { settle } = mount(rpc, async (text: string) => { prompts.push(text) })
    let tree = await settle()
    ;(find(tree, (element) => element.type === 'button' && element.props['data-zentao-entry'] === '1')!.props.onClick as () => void)()
    tree = await settle()

    // No bar until something is ticked.
    expect(find(tree, (element) => element.props['data-zentao-batch'] === '1')).toBeUndefined()

    const tick = (id: string): void => {
      const box = find(tree, (element) => element.props['data-zentao-check'] === id)!
      ;(box.props.onChange as () => void)()
    }
    tick('11')
    tree = await settle()
    tick('22')
    tree = await settle()
    expect(textOf(tree).join(' ')).toContain('已选 2 条')

    // 批量预览 → one plan per ticked bug.
    const preview = find(tree, (element) => element.props['data-zentao-action'] === 'batch-preview')!
    ;(preview.props.onClick as () => void)()
    await settle()
    expect(calls.filter((endpoint) => endpoint === 'resolvePlan')).toHaveLength(2)

    // 批量引用到会话 → one prompt quoting both.
    const quote = find(tree, (element) => element.props['data-zentao-action'] === 'batch-quote')!
    ;(quote.props.onClick as () => void)()
    await settle()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('#11')
    expect(prompts[0]).toContain('#22')
    expect(prompts[0]).toContain('共 2 条')

    // 批量解决 → one submit per ticked bug (each carrying confirm:true).
    const resolve = find(tree, (element) => element.props['data-zentao-action'] === 'batch-resolve')!
    ;(resolve.props.onClick as () => void)()
    await settle()
    expect(calls.filter((endpoint) => endpoint === 'resolveSubmit')).toHaveLength(2)
  })

  it('opens a detail card when a row is clicked', async () => {
    const calls: string[] = []
    const rpc = async (endpoint: string): Promise<{ ok: true, value: unknown }> => {
      calls.push(endpoint)
      if (endpoint === 'sessionStatus' || endpoint === 'getConfig') {
        return { ok: true, value: { server: 'https://zt.example.com', authenticated: true, strategy: 'bridge', probes: [], config: { server: 'https://zt.example.com', authenticated: true, probes: [] } } }
      }
      if (endpoint === 'listBugs') {
        return { ok: true, value: { bugs: [{ id: '55036', title: '浮层问题', severity: '主要', pri: '3', type: '需求逻辑问题', assignedTo: 'dev.one', resolution: '', href: '/index.php?m=bug&f=view&bugID=55036' }], total: 1, via: 'bridge', url: '', fetchedAt: '', cached: false } }
      }
      if (endpoint === 'bugContext') {
        return {
          ok: true,
          value: {
            bug: { id: '55036', title: '浮层问题', product: 'Demo', status: '激活', assignedTo: 'dev.one', url: 'https://zt.example.com/index.php?m=bug&f=view&bugID=55036' },
            resolve: {
              uid: 'kuid-1',
              fields: [{ name: 'changeImpact', label: '代码变更影响范围', required: true }],
              defaults: {},
              resolutionOptions: [],
              optionCounts: { resolvedBuild: 254, bugInchargedBy: 892, assignedTo: 892 },
            },
            histories: ['2026-08-18 16:27:16, 由 Dev One 创建。'],
          },
        }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }

    const { settle } = mount(rpc)
    let tree = await settle()
    ;(find(tree, (element) => element.type === 'button')!.props.onClick as () => void)()
    tree = await settle()

    // The row is a draggable div carrying an onClick.
    const row = find(tree, (element) => element.type === 'div' && element.props.draggable === true)!
    ;(row.props.onClick as () => void)()
    tree = await settle()

    expect(calls).toContain('bugContext')
    const text = textOf(tree).join(' ')
    expect(text).toContain('必填：代码变更影响范围')
    expect(text).toContain('下拉规模 254/892/892')
    // The drag payload must carry a real origin, not a placeholder host.
    const payloads: string[] = []
    ;(row.props.onDragStart as (event: unknown) => void)({ dataTransfer: { setData: (_type: string, value: string) => payloads.push(value) } })
    expect(payloads[0]).toContain('https://zt.example.com/index.php?m=bug&f=view&bugID=55036')
    expect(payloads[0]).toContain('先用 zentao_bug_context')
  })
})
