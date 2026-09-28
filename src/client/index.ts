/**
 * dsh-zentao-workbench — browser half.
 *
 * Mounts a floating workbench into the shell's overlay slot, the same seat
 * `@haoyu-qi/dsh-zentao` uses (measured to work on this host): a draggable entry
 * that opens a panel listing the bugs assigned to me, with a detail card, a
 * resolve-plan preview, and a "处理" button that opens a conversation with the
 * item already quoted.
 *
 * All data comes from the host's `/zentao` RPC channel — the browser never talks
 * to ZenTao directly, so no cookie ever reaches the page.
 */

import { createElement } from 'react'
import { ZENTAO_FETCH_PATH, type ZentaoCallRequest, type ZentaoCallResult } from '../protocol.js'
import { ZentaoPanel, type PanelDeps } from './panel.js'

/**
 * Services this half must have before its first render.
 *
 * Only `slots` (the overlay seat). The host calls go over plain `fetch` to
 * {@link ZENTAO_FETCH_PATH}, because measuring this Host showed its private RPC
 * channels are not mounted at all — `POST /zentao/...` is answered by the static
 * fallback with 405. `sessions`/`workspaces` are read opportunistically for the
 * "处理" button, so a missing client-runtime package cannot stop the panel.
 */
export const inject = ['slots']

/** Registration identity shared by the sidebar tab registry and the pane body. */
export const SIDEBAR_TYPE = 'dsh-zentao-workbench:panel'
/**
 * The native kind this panel claims. It must be unique across plugins: claiming
 * a kind another plugin owns makes `tabs.register` throw and — per dsh-file-tree's
 * own notes — takes the rest of that registration pass with it.
 */
export const SIDEBAR_KIND = 'dsh-zentao-workbench:zentao'

interface SlotsService {
  inject(name: string, callback: () => void | (() => void)): void
  /** `key` targets one tab type when the seat dispatches `sidebar.right.pane.tab`. */
  register(
    options: { name: string, id?: string, key?: string, order?: number, inject?: (sessionId?: string) => Record<string, unknown> },
    component: (props: unknown) => unknown,
  ): () => void
}

interface SessionListLike { getSnapshot(): { current?: string } }
interface WorkspaceSnapshot {
  items: Array<{ workspaceId: string, sessionIds: string[] }>
  recentWorkspaceId?: string
}
interface WorkspaceListLike { getSnapshot(): WorkspaceSnapshot }
interface ScopedLike { get(name: string): { send(text: string): Promise<unknown> } | undefined }

interface SessionsFace {
  list: SessionListLike
  open(id: string): void
  scope(id: string): ScopedLike | undefined
  /** Session creator on this build (the reference build uses connectWorkspace). */
  create?(payload: { workspaceId: string }): Promise<unknown>
}
interface WorkspacesFace {
  list: WorkspaceListLike
  /** Only on the reference plugin's build; absent here (capability-probed). */
  connectWorkspace?(id: string): Promise<string>
  /** Durable default workspace on this build. */
  initializeDefault?(signal?: unknown): Promise<unknown>
}

interface NativeTabType {
  register(definition: {
    id: string
    kind: string
    title: () => string
    /**
     * The sidebar ENTRY.
     *
     * Copied from the working neighbour (dsh-source-control): its own comment
     * says it registers "the tab type, its body, and **the guide entry that opens
     * it**". Without `guide` the type and body exist but nothing is listed in the
     * sidebar — which is exactly why 「禅道」 never appeared while 「源代码管理」 did.
     */
    guide?: ReadonlyArray<{ id: string, order: number, title: () => string, description: () => string }>
  }): () => void
}

interface SidebarController {
  /**
   * The navigation controller. Per the shipped README: "`openResource(address,
   * options?)` and `openTab(kind, options?)` are the navigation controller" —
   * the argument is the **kind**, and the guide capsule opens a page with
   * `openTab(entry.kind, { replaceTab: true })`. Passing `{ type: id }` here
   * (as I did) is the wrong shape and silently opens nothing.
   */
  openTab?: (kind: string, options?: { replaceTab?: boolean, paneId?: string, revealIfOpened?: boolean }) => void
}

interface ClientContext {
  readonly slots: SlotsService
  effect(callback: () => void | (() => void), label?: string): void
  /** cordis: run `callback` once the listed services exist. */
  inject?(inject: string[], callback: (context: ClientContext) => void | (() => void)): unknown
  /** Optional services, read without a hard dependency. */
  get?(name: string): unknown
}

/**
 * Open a fresh conversation in the current workspace and send `text` verbatim.
 * Mirrors dsh-zentao's flow so the "处理" button behaves the way it does there.
 */
/**
 * The durable default workspace, or undefined when this build has no such API.
 *
 * Kept separate and fully guarded: a host without `initializeDefault` (the
 * reference plugin's build) must still work through the other fallbacks.
 */
async function defaultWorkspaceId(workspaces: WorkspacesFace): Promise<string | undefined> {
  const api = workspaces as { initializeDefault?: (signal?: unknown) => Promise<unknown> }
  if (typeof api.initializeDefault !== 'function') return undefined
  try {
    const value = await api.initializeDefault()
    if (typeof value === 'string') return value
    const id = (value as { workspaceId?: unknown } | undefined)?.workspaceId
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Create a session inside `workspaceId` on whichever API this build exposes.
 *
 * Returns the new session id. Throws a message naming both APIs when neither is
 * present, so the next shape mismatch reports itself instead of failing obscurely.
 */
async function createSessionIn(workspaces: WorkspacesFace, sessions: SessionsFace, workspaceId: string): Promise<string> {
  const sessionApi = sessions as { create?: (payload: { workspaceId: string }) => Promise<unknown> }
  if (typeof sessionApi.create === 'function') {
    const created = await sessionApi.create.call(sessions, { workspaceId })
    const id = typeof created === 'string'
      ? created
      : (created as { sessionId?: unknown, id?: unknown } | undefined)?.sessionId
        ?? (created as { id?: unknown } | undefined)?.id
    if (typeof id === 'string' && id !== '') return id
  }
  const legacy = callIfPresent(workspaces, 'connectWorkspace', workspaceId)?.value
  if (typeof legacy === 'string') return legacy
  if (legacy instanceof Promise) return await legacy as string
  throw new Error('无法新建会话：既没有 sessions.create，也没有 workspaces.connectWorkspace'
    + `。sessions 暴露的方法：${methodsOf(sessions)}；workspaces 暴露的方法：${methodsOf(workspaces)}`)
}

/**
 * Call `name` on `target` only when it is actually a function.
 *
 * Every step of this flow was written against the reference plugin's build and
 * three of those method names do not exist here (`connectWorkspace`, `open`, …).
 * Probing replaces the guessing: an absent method is skipped or reported with the
 * real method list instead of throwing `X is not a function`.
 */
function callIfPresent(target: object, name: string, ...args: unknown[]): { value: unknown } | undefined {
  const fn = (target as Record<string, unknown>)[name]
  if (typeof fn !== 'function') return undefined
  return { value: (fn as (...a: unknown[]) => unknown).apply(target, args) }
}

/**
 * The callable surface, for error messages that carry their own evidence.
 *
 * Walks the prototype chain: a cordis service exposes its methods there, so
 * `Object.keys` reported "(无)" for an object that demonstrably had `create`.
 */
function methodsOf(target: object): string {
  const names = new Set<string>()
  let current: object | null = target
  while (current !== null && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === 'constructor') continue
      try {
        if (typeof (target as Record<string, unknown>)[key] === 'function') names.add(key)
      } catch {
        // a getter that throws is not a capability
      }
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return [...names].sort().join(', ') || '(无)'
}

/**
 * A session-scoped context on whichever route this build offers.
 *
 * `sessions.scope(id)` is the documented one (and is used by other installed
 * plugins), but the session controller also exposes `sessionOf`/`binding`, any of
 * which may hand back the scoped context. Trying them in order beats picking one
 * and discovering it is absent (which is how this flow failed three times).
 */
function scopeFor(sessions: SessionsFace, sessionId: string): ScopedLike | undefined {
  // Measured on the user's build: `scope` exists yet returns undefined for a
  // freshly created session (it is not materialised), and the service also
  // exposes `materializeScope` / `scopeOf`. So materialise first, then try every
  // route that can hand back a scoped context.
  callIfPresent(sessions, 'materializeScope', sessionId)
  const direct = callIfPresent(sessions, 'scope', sessionId)?.value
    ?? callIfPresent(sessions, 'scopeOf', sessionId)?.value
  if (direct !== undefined) return direct as ScopedLike
  for (const route of ['sessionOf', 'binding'] as const) {
    const held = callIfPresent(sessions, route, sessionId)?.value as
      | { scope?: (id: string) => ScopedLike, context?: ScopedLike }
      | undefined
    if (held === undefined) continue
    const viaScope = callIfPresent(held, 'scope', sessionId)?.value
    if (viaScope !== undefined) return viaScope as ScopedLike
    if (held.context !== undefined) return held.context
  }
  return undefined
}

/** The `conversation` service behind a scope/binding, when it is reachable. */
function conversationOf(scope: unknown): { send(text: string): Promise<unknown> } | undefined {
  const get = (scope as { get?: unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  try {
    const conversation = (get as (name: string) => unknown).call(scope, 'conversation') as { send?: unknown } | undefined
    return typeof conversation?.send === 'function'
      ? (conversation as { send(text: string): Promise<unknown> })
      : undefined
  } catch {
    return undefined
  }
}

function buildHandlePrompt(getServices: () => { sessions?: SessionsFace, workspaces?: WorkspacesFace }, ctx: ClientContext) {
  return async (text: string): Promise<void> => {
    // Reading them as *properties* is what the reference plugin does, and it is
    // the only shape cordis guarantees for a visible service: `ctx.get(name)` is
    // strict and THROWS for anything not visible to this fiber — which is why the
    // three 处理 buttons silently did nothing before.
    const captured = getServices()
    const direct = ctx as unknown as { sessions?: SessionsFace, workspaces?: WorkspacesFace }
    const sessions = captured.sessions ?? direct.sessions
    const workspaces = captured.workspaces ?? direct.workspaces
    if (sessions === undefined || workspaces === undefined) {
      throw new Error('会话服务未就绪（sessions/workspaces 不可见）：请刷新页面重试；或用「复制引用」把这条单据贴进对话')
    }
    // Resolve the target workspace defensively.
    //
    // The reference plugin reads `items[].sessionIds` + `recentWorkspaceId`.
    // Measured on THIS build: the workspaces client exposes `items` but **no
    // `recentWorkspaceId`** (its client half: 48 × workspaceId, 0 ×
    // recentWorkspaceId), so copying that fallback threw 「未找到当前项目」.
    // The chain now ends at a guaranteed source — the durable default workspace —
    // and reports what it actually saw when even that fails.
    const workspaceSnapshot = workspaces.list.getSnapshot() as {
      items?: Array<{ workspaceId?: string, sessionIds?: string[] }>
      workspaces?: Array<{ workspaceId?: string, sessionIds?: string[] }>
    }
    const list = workspaceSnapshot.items ?? workspaceSnapshot.workspaces ?? []
    const current = (sessions.list.getSnapshot() as { current?: string }).current
    const byCurrent = current === undefined
      ? undefined
      : list.find((item) => (item.sessionIds ?? []).includes(current))?.workspaceId
    // Third route, for builds that expose only a "recent" hint (the reference
    // plugin's build); last resort is the durable default workspace.
    const recent = (workspaceSnapshot as { recentWorkspaceId?: string }).recentWorkspaceId
    const fallback = await defaultWorkspaceId(workspaces)
    const target = byCurrent ?? list[0]?.workspaceId ?? recent ?? fallback
    if (target === undefined) {
      throw new Error(`未找到可用项目（workspace）：当前会话 ${current ?? '未知'}，可见项目 ${list.length} 个`
        + `${list.length === 0 ? '' : `（${list.map((item) => item.workspaceId ?? '?').join('/')}）`}，默认项目也取不到`)
    }
    // Open a session for that workspace by capability, not by assumption.
    //
    // Measured: the reference plugin calls `workspaces.connectWorkspace`, but this
    // build's workspaces client has no such method (grep of its client half:
    // `connectWorkspace` 0 hits while `create`/`initializeDefault` are there).
    // `sessions.create` is the documented creator on this build, so try that
    // first and keep the old call as the compatibility route.
    const sessionId = await createSessionIn(workspaces, sessions, target)
    // Selecting the new session is optional and build-dependent: this build has
    // no `sessions.open` (user report) while the reference build does. Probe it
    // and carry on — `sessions.create` already registers the session.
    callIfPresent(sessions, 'open', sessionId)
    const scoped = scopeFor(sessions, sessionId)
    if (scoped === undefined) {
      // Documented fallback: "sessions.using(target, options, operation) waits for
      // that settlement, holds its reference until the callback settles". The
      // binding arrives inside the callback, so the send happens there.
      const using = (sessions as unknown as Record<string, unknown>).using
      if (typeof using !== 'function') {
        throw new Error(`拿不到会话作用域，无法发送。当前 sessions 暴露的方法：${methodsOf(sessions)}`)
      }
      let sent = false
      const runUsing = using as unknown as (
        id: string,
        options: object,
        run: (binding?: unknown) => Promise<void>,
      ) => Promise<void>
      await runUsing.call(sessions, sessionId, {}, async (binding?: unknown) => {
        const conversation = conversationOf(binding) ?? conversationOf(scopeFor(sessions, sessionId))
        if (conversation === undefined) return
        await conversation.send(text)
        sent = true
      })
      if (!sent) {
        throw new Error(`using() 里也没拿到 conversation。当前 sessions 暴露的方法：${methodsOf(sessions)}`)
      }
      return
    }
    const conversation = conversationOf(scoped)
    if (conversation === undefined) throw new Error('conversation 服务不可用，请确认 Web 对话插件已加载')
    await conversation.send(text)
  }
}

/**
 * One call to the host. Same-origin, so the browser's session cookie travels
 * with it; the Host applies its Host/Origin fence and browser auth itself.
 */
async function callHost(endpoint: string, payload?: unknown): Promise<ZentaoCallResult> {
  const body: ZentaoCallRequest = { endpoint, payload }
  const response = await fetch(ZENTAO_FETCH_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`面板通道 ${ZENTAO_FETCH_PATH} 返回 HTTP ${response.status}`
      + (response.status === 404 || response.status === 405
        ? '（宿主要么没加载这个插件的宿主半边，要么它的 fetch 路由没注册成功 —— 跑 zentao doctor 确认）'
        : ''))
  }
  return await response.json() as ZentaoCallResult
}

export function apply(ctx: ClientContext): void {
  /** True once the native sidebar is hosting the panel (then the tab hides). */
  let sidebarReady = false
  /** Set once the sidebar controller is visible; opens/focuses our tab. */
  let openSidebarTab: (() => void) | undefined
  /**
   * How far the sidebar registration got, surfaced in the panel footer.
   *
   * Three blind attempts at this failed, so the outcome is now *reported* rather
   * than assumed: the user can read one line and we learn whether the service
   * appeared, whether register threw, and whether openTab ran.
   */
  const sidebarState: { registered: boolean, opened: boolean, error?: string } = { registered: false, opened: false }

  /**
   * Services for the 处理/一键修复 buttons, captured when they become visible.
   *
   * Soft on purpose: the panel must still mount in a host without a session
   * controller (then the buttons explain themselves instead of the whole panel
   * failing to load).
   */
  let sessionServices: { sessions?: SessionsFace, workspaces?: WorkspacesFace } = {}
  if (ctx.inject !== undefined) {
    ctx.inject(['sessions', 'workspaces'], (scoped) => {
      const asProps = scoped as unknown as { sessions?: SessionsFace, workspaces?: WorkspacesFace }
      sessionServices = {
        ...(asProps.sessions === undefined ? {} : { sessions: asProps.sessions }),
        ...(asProps.workspaces === undefined ? {} : { workspaces: asProps.workspaces }),
      }
      return () => { sessionServices = {} }
    })
  }

  const base = {
    call: callHost,
    handlePrompt: buildHandlePrompt(() => sessionServices, ctx),
  }

  /**
   * Open the workbench in the native right sidebar.
   *
   * Returns whether it worked, so the floating tab can fall back to its own
   * drawer on a host whose sidebar is composed differently.
   */
  const openInSidebar = (): boolean => {
    if (openSidebarTab === undefined) return false
    try {
      openSidebarTab()
      return true
    } catch {
      return false
    }
  }

  // 1) the native tab type — this is what puts 「禅道」 in the sidebar's tab list
  ctx.effect(() => {
    if (ctx.inject === undefined) {
      sidebarState.error = '本宿主的客户端上下文没有 inject()'
      return undefined
    }
    return ctx.inject(['sidebarRightTabs'], (scoped) => {
      // Read as a PROPERTY: cordis' `get` is strict and throws when a service is
      // not visible, which made this registration silently never happen.
      const tabs = (scoped as unknown as { sidebarRightTabs?: NativeTabType }).sidebarRightTabs
        ?? (scoped.get?.('sidebarRightTabs') as NativeTabType | undefined)
      if (tabs === undefined) {
        sidebarState.error = 'sidebarRightTabs 服务对象为空'
        return undefined
      }
      let dispose: (() => void) | undefined
      try {
        dispose = tabs.register({
          id: SIDEBAR_TYPE,
          kind: SIDEBAR_KIND,
          title: () => '禅道',
          guide: [
            {
              id: 'zentao-workbench',
              // 35 keeps it right after 源代码管理 (30) in the sidebar's list.
              order: 35,
              title: () => '禅道',
              description: () => '我的 Bug、按项目筛选、解决计划与一键修复',
            },
          ],
        })
        sidebarState.registered = true
        sidebarReady = true
      } catch (problem) {
        sidebarState.error = (problem as Error).message
      }
      return () => { sidebarReady = false; dispose?.() }
    }) as () => void
  }, 'dsh-zentao-workbench: native sidebar tab')

  /**
   * Open the tab so it is actually visible.
   *
   * The right sidebar is *tab* based: registering a type only makes it
   * available, nothing appears until something calls `sidebarRight.openTab`
   * (measured from the shipped docs: the schedule plugin opens its type "from
   * the Session entry"). Without this the tab exists but nobody ever sees it.
   */
  ctx.effect(() => {
    if (ctx.inject === undefined) return undefined
    return ctx.inject(['sidebarRight'], (scoped) => {
      const right = (scoped as unknown as { sidebarRight?: SidebarController }).sidebarRight
      if (right?.openTab === undefined) {
        sidebarState.error = sidebarState.error ?? 'sidebarRight.openTab 不可用'
        return undefined
      }
      openSidebarTab = () => {
        // KIND, not id — see SidebarController.openTab. `replaceTab` mirrors what
        // picking a guide capsule does, so the guide gives way to our page.
        right.openTab?.(SIDEBAR_KIND, { replaceTab: true })
        sidebarState.opened = true
      }
      // NOT auto-opened: the guide entry above is the entry point (that is how
      // 源代码管理 behaves). `openSidebarTab` stays available for the fallback
      // tab's click.
      return () => { openSidebarTab = undefined }
    }) as () => void
  }, 'dsh-zentao-workbench: open the sidebar tab')

  // 2) the tab body AND its title chip — the shipped contract registers both
  //    seats under the definition's id ("its body and chip into the keyed
  //    sidebar.right.pane.tab and sidebar.right.pane.tab.title seats").
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: SIDEBAR_TYPE, inject: () => ({}) },
    (props) => createElement(ZentaoPanel, {
      ...(props as Record<string, unknown>),
      ...base,
      variant: 'sidebar',
      // Reported here too: if the tab does open on some host, this line says so.
      sidebarStatus: () => sidebarState,
    }),
  )), 'dsh-zentao-workbench: sidebar pane body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: SIDEBAR_TYPE },
    () => createElement('span', { title: '禅道工作台' }, '禅道'),
  )), 'dsh-zentao-workbench: sidebar tab chip')

  // 3) the floating tab, which now doubles as the sidebar entry
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'zentao-workbench', order: 12 },
    (props) => createElement(ZentaoPanel, {
      ...(props as Record<string, unknown>),
      ...base,
      openInSidebar,
      hasSidebar: () => sidebarReady,
      sidebarStatus: () => sidebarState,
    }),
  ))
}
