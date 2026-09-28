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
}
interface WorkspacesFace {
  list: WorkspaceListLike
  connectWorkspace(id: string): Promise<string>
}

interface NativeTabType {
  register(definition: { id: string, kind: string, title: () => string }): () => void
}

interface SidebarController {
  /** Opens (or focuses) a native sidebar tab of the given type. */
  openTab?: (target: { type: string }, scope?: unknown) => void
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
    const workspaceSnapshot = workspaces.list.getSnapshot()
    const current = sessions.list.getSnapshot().current
    const target = (current === undefined
      ? undefined
      : workspaceSnapshot.items.find((item) => item.sessionIds.includes(current))?.workspaceId)
      ?? workspaceSnapshot.recentWorkspaceId
    if (target === undefined) throw new Error('未找到当前项目（workspace），请先打开一个项目')
    const sessionId = await workspaces.connectWorkspace(target)
    sessions.open(sessionId)
    const scoped = sessions.scope(sessionId)
    if (scoped === undefined) throw new Error('新建会话失败：无法解析会话作用域')
    const conversation = scoped.get('conversation')
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
    try {
      const sidebar = ctx.get?.('betterSidebar') as SidebarController | undefined
      if (sidebar?.openTab === undefined) return false
      sidebar.openTab({ type: SIDEBAR_TYPE })
      return true
    } catch {
      // `get` is strict on cordis: an absent service throws rather than
      // returning undefined, and a missing sidebar must not break the tab.
      return false
    }
  }

  // 1) the native tab type — this is what puts 「禅道」 in the sidebar's tab list
  ctx.effect(() => {
    if (ctx.inject === undefined) return undefined
    return ctx.inject(['sidebarRightTabs'], (scoped) => {
      const tabs = scoped.get?.('sidebarRightTabs') as NativeTabType | undefined
      if (tabs === undefined) return undefined
      const dispose = tabs.register({ id: SIDEBAR_TYPE, kind: SIDEBAR_KIND, title: () => '禅道' })
      return () => { dispose() }
    }) as () => void
  }, 'dsh-zentao-workbench: native sidebar tab')

  // 2) the tab body — same component, inline variant (no floating tab/drawer)
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: SIDEBAR_TYPE, inject: () => ({}) },
    (props) => createElement(ZentaoPanel, { ...(props as Record<string, unknown>), ...base, variant: 'sidebar' }),
  )), 'dsh-zentao-workbench: sidebar pane body')

  // 3) the floating tab, which now doubles as the sidebar entry
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'zentao-workbench', order: 12 },
    (props) => createElement(ZentaoPanel, { ...(props as Record<string, unknown>), ...base, openInSidebar }),
  ))
}
