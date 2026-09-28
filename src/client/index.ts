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
import { ZentaoPanel, type PanelDeps } from './panel.js'

/**
 * Services this half must have before its first render.
 *
 * Deliberately NOT `sessions` / `workspaces`: only the "处理" button needs them,
 * and a missing client-runtime package must not stop the whole panel from
 * mounting. (Measured: `@deepseek-ai/dsh-client-runtime` is not a host package —
 * dsh-zentao carries its own copy — so hard-depending on it would be fragile.)
 */
export const inject = ['slots', 'connection']

interface SlotsService {
  inject(name: string, callback: () => void | (() => void)): void
  register(options: { name: string, id: string, order?: number }, component: (props: unknown) => unknown): () => void
}

interface RpcFace {
  call(channel: string, endpoint: string, payload?: unknown): Promise<{ ok: true, value: unknown } | { ok: false, error: { code: string, message: string } }>
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
  readonly connection: { rpc: RpcFace }
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

export function apply(ctx: ClientContext): void {
  const deps: PanelDeps = {
    rpc: ctx.connection.rpc,
    handlePrompt: buildHandlePrompt(ctx),
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'zentao-workbench', order: 12 },
    (props) => createElement(ZentaoPanel, { ...(props as Record<string, unknown>), ...deps }),
  ))
}
