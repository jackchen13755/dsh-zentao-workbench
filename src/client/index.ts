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

interface SlotsService {
  inject(name: string, callback: () => void | (() => void)): void
  register(options: { name: string, id: string, order?: number }, component: (props: unknown) => unknown): () => void
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

interface ClientContext {
  readonly slots: SlotsService
  effect(callback: () => void | (() => void), label?: string): void
  /** Optional services, read without a hard dependency. */
  get?(name: string): unknown
}

/**
 * Open a fresh conversation in the current workspace and send `text` verbatim.
 * Mirrors dsh-zentao's flow so the "处理" button behaves the way it does there.
 */
function buildHandlePrompt(ctx: ClientContext) {
  return async (text: string): Promise<void> => {
    const sessions = ctx.get?.('sessions') as SessionsFace | undefined
    const workspaces = ctx.get?.('workspaces') as WorkspacesFace | undefined
    if (sessions === undefined || workspaces === undefined) {
      throw new Error('会话服务不可用（sessions/workspaces 未加载）：请改用「复制引用」把这条单据贴进对话')
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
  const deps: PanelDeps = {
    call: callHost,
    handlePrompt: buildHandlePrompt(ctx),
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'zentao-workbench', order: 12 },
    (props) => createElement(ZentaoPanel, { ...(props as Record<string, unknown>), ...deps }),
  ))
}
