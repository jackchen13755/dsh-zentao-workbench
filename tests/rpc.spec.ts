import { describe, expect, it } from 'vitest'
import { createZentaoRpcHandler, ZENTAO_RPC_CHANNEL } from '../src/rpc.js'
import { ZenTaoAuthError } from '../src/session.js'
import { ZentaoWorkbench } from '../src/zentao.js'
import { bugListPage, bugRow, bugViewPage, resolveFormPage } from './fixtures/pages.js'
import { fakeSession } from './helpers/fake-session.js'

const VIEW = '/index.php?m=bug&f=view&bugID=55036'
const FORM = '/index.php?m=bug&f=resolve&bugID=55036&onlybody=yes'
const LIST = '/index.php?m=my&f=bug'

function world(options: { expired?: boolean, postOutcome?: 'ok' | 'alert' } = {}) {
  let resolved = false
  const session = fakeSession((path, method) => {
    // A dead session is not a page the workbench parses: the real ZenTaoSession
    // throws, so the double must too.
    if (options.expired === true) {
      throw new ZenTaoAuthError('禅道未登录或不可达', {
        server: 'https://zt.example.test',
        authenticated: false,
        probes: [{ id: 'bridge', label: '浏览器插件桥', ready: true, detail: '会话已失效（页面被弹回登录页）', hint: '重新登录后重试' }],
      })
    }
    if (method === 'POST') {
      if (options.postOutcome === 'alert') return { body: `<script>alert('『代码变更影响范围』不能为空。')</script>` }
      resolved = true
      return { body: '<div>ok</div>' }
    }
    if (path === LIST) return bugListPage([bugRow({ id: '55036', title: '浮层问题' })])
    if (path === FORM) {
      return resolveFormPage({
        uid: 'kuid-rpc',
        requiredJson: 'resolution,bugInchargedBy,changeImpact',
        counts: { resolvedBuild: 254, people: 892 },
        defaults: { resolution: 'fixed', reason: 'codeBug', assignedTo: 'user-1' },
      })
    }
    if (path === VIEW) {
      return bugViewPage({
        id: '55036',
        title: '浮层问题',
        product: 'Demo',
        status: resolved ? '已解决' : '激活',
        solution: resolved ? 'fixed' : '',
        assignee: 'dev.one',
      })
    }
    throw new Error(`unexpected ${path}`)
  })
  const workbench = new ZentaoWorkbench(session)
  return { session, workbench, handle: createZentaoRpcHandler({ session, workbench }) }
}

describe('panel RPC channel', () => {
  it('uses the channel the client bundle calls', () => {
    expect(ZENTAO_RPC_CHANNEL).toBe('/zentao')
  })

  it('reports config without ever leaking a cookie value', async () => {
    const { handle } = world()
    const result = await handle('getConfig', {})
    expect(result.ok).toBe(true)
    const value = (result as { value: Record<string, unknown> }).value
    expect(value).toHaveProperty('server')
    expect(value).toHaveProperty('probes')
    expect(JSON.stringify(value)).not.toContain('zentaosid')
  })

  it('lists bugs for the panel', async () => {
    const { handle } = world()
    const result = await handle('listBugs', { limit: 5, only: 'open' })
    expect(result.ok).toBe(true)
    const value = (result as { value: { bugs: Array<{ id: string }> } }).value
    expect(value.bugs.map((bug) => bug.id)).toEqual(['55036'])
  })

  it('returns a structured failure — not a transport error — when the session is dead', async () => {
    const { handle } = world({ expired: true })
    const result = await handle('listBugs', {})
    expect(result.ok).toBe(false)
    const error = (result as { error: { code: string, details: Record<string, unknown> } }).error
    expect(error.code).toBe('zentao-unauthenticated')
    // The panel renders these: a bare "未登录" would be exactly what the user rejected.
    expect(Array.isArray(error.details.probes)).toBe(true)
    expect(error.details.server).toBeTruthy()
  })

  it('plans a resolve without writing', async () => {
    const { handle, session } = world()
    const result = await handle('resolvePlan', { bugID: '55036', impact: '影响 A' })
    expect(result.ok).toBe(true)
    const plan = (result as { value: { plan: { fields: Array<[string, string]>, blocked: boolean } } }).value.plan
    expect(plan.blocked).toBe(false)
    expect(plan.fields.find(([name]) => name === 'impact' || name === 'changeImpact')?.[1]).toBe('影响 A')
    expect(session.posts).toHaveLength(0)
  })

  it('refuses to submit without an explicit confirmation', async () => {
    const { handle, session } = world()
    const result = await handle('resolveSubmit', { bugID: '55036', impact: '影响 A' })
    expect(result.ok).toBe(false)
    expect((result as { error: { code: string } }).error.code).toBe('confirm-required')
    expect(session.posts).toHaveLength(0)
  })

  it('submits when the panel confirms, and reports the verified outcome', async () => {
    const { handle, session } = world()
    const result = await handle('resolveSubmit', { bugID: '55036', confirm: true, impact: '影响 A' })
    expect(result.ok).toBe(true)
    const outcome = (result as { value: { outcome: { ok: boolean, status: string } } }).value.outcome
    expect(outcome.ok).toBe(true)
    expect(outcome.status).toBe('已解决')
    expect(session.posts).toHaveLength(1)
  })

  it('surfaces a server refusal verbatim instead of a generic failure', async () => {
    const { handle } = world({ postOutcome: 'alert' })
    const result = await handle('resolveSubmit', { bugID: '55036', confirm: true, impact: '影响 A' })
    const outcome = (result as { value: { outcome: { ok: boolean, serverError?: string } } }).value.outcome
    expect(outcome.ok).toBe(false)
    expect(outcome.serverError).toContain('代码变更影响范围')
  })

  it('narrows a build search to the matches', async () => {
    const { handle } = world()
    const result = await handle('buildSearch', { bugID: '55036', query: 'build-2' })
    expect(result.ok).toBe(true)
    const value = (result as { value: { matches: unknown[], total: number } }).value
    expect(value.total).toBe(254)
    expect(value.matches.length).toBeLessThanOrEqual(10)
  })

  it('answers unknown endpoints and bad payloads explicitly', async () => {
    const { handle } = world()
    expect((await handle('nope', {}) as { error: { code: string } }).error.code).toBe('unknown-endpoint')
    expect((await handle('bugContext', {}) as { error: { code: string } }).error.code).toBe('bad-request')
  })
})
