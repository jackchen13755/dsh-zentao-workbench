/**
 * The workbench panel: a draggable floating entry that opens my-bug list, a
 * detail card, and a resolve-plan preview.
 *
 * Design rules it follows (both from the session-history findings):
 *  · **read-only by default** — planning is free, submitting asks first;
 *  · **never a dead end** — when the session is gone the panel body *is* the
 *    four-strategy report with the next action per strategy, because "未登录"
 *    on its own is what made the old flow waste turns.
 */
import { createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { severityTone } from '../severity.js'

import type { ZentaoCallResult as RpcResult } from '../protocol.js'

export interface PanelDeps {
  /**
   * One panel call. Implemented by the browser half as a POST to
   * {@link ZENTAO_FETCH_PATH} — the transport this Host actually mounts.
   */
  call(endpoint: string, payload?: unknown): Promise<RpcResult>
  /** Opens a conversation with the text (the "处理" button). */
  handlePrompt(text: string): Promise<void>
}

interface Probe { id: string, label: string, detail: string, hint?: string, ready?: boolean }
interface Config {
  server: string
  authenticated: boolean
  strategy?: string | null
  probes: Probe[]
  hasEnvCookie: boolean
  jarPaths: string[]
}
interface BugsPayload { bugs: BugRow[], total: number, truncated?: boolean, via: string, scope?: 'mine' | 'project', projectName?: string }
interface ProjectRow { id: string, name: string }
interface BugRow {
  id: string
  severity: string
  /** Numeric rank for the badge colour; null when the page did not carry it. */
  severityLevel?: number | null
  pri: string
  type: string
  title: string
  assignedTo: string
  resolution: string
  href: string
}
interface TaskRow { id: string, name: string, status: string, assignedTo: string, href: string }
interface BugContext {
  bug: {
    id: string, title: string, product: string, status: string, assignedTo: string, url: string
    severity?: string, severityLevel?: number | null
    /** Detail-page fields (may be absent on an older host build). */
    productLabel?: string, story?: string, storyID?: string, projectLabel?: string
  }
  resolve: {
    uid: string
    fields: Array<{ name: string, label: string, required: boolean, limit?: number }>
    defaults: Record<string, string>
    resolutionOptions: Array<{ value: string, text: string }>
    optionCounts: { resolvedBuild: number, bugInchargedBy: number, assignedTo: number }
  }
  histories: string[]
}
interface Plan {
  fields: Array<[string, string]>
  problems: string[]
  autoFilled: Record<string, string>
  notes: string[]
  blocked: boolean
}

/**
 * Layout follows the reference plugin (`@haoyu-qi/dsh-zentao`'s client half,
 * read from its own bundle): a vertical tab glued to the right edge plus a
 * right-edge drawer, positioned **only** with CSS.
 *
 * Why this replaced viewport math: a transformed/filtered ancestor becomes the
 * containing block for `position: fixed`, so computing `left` from
 * `window.innerWidth` put the entry outside the clipped overlay the moment the
 * shell was maximized (measured: entry landed at the container's left edge,
 * x=5). `right: 0` + `top: 50%` cannot drift, in any container, at any size.
 */
const FAB_TEXT = '禅道'

/**
 * A severity badge: the level as a coloured chip.
 *
 * Colour comes from the row's numeric level (`data-severity`), falling back to
 * the label — see `severityTone`. The label itself stays visible, because a
 * colour alone is not a name.
 */
function severityBadge(label: string, level: number | null | undefined): ReactNode {
  const text = label.trim()
  if (text === '') return null
  const tone = severityTone(level, text)
  return createElement('span', {
    'data-zentao-severity': String(level ?? ''),
    title: `级别 ${text}（${tone.rank}）`,
    style: {
      background: tone.bg,
      color: tone.fg,
      borderRadius: 4,
      padding: '0 5px',
      fontSize: 11,
      fontWeight: 600,
      lineHeight: '16px',
      display: 'inline-block',
      verticalAlign: 'middle',
    },
  }, text)
}

const ROLE_PRESETS: Array<{ key: string, label: string, prompt: (reference: string) => string }> = [
  { key: 'dev', label: '开发', prompt: (ref) => `${ref}\n\n请按开发角度处理这个 Bug：先复现、定位根因、给出最小改动修复并自测，必要时补充用例。` },
  { key: 'qa', label: '测试', prompt: (ref) => `${ref}\n\n请按测试角度处理：核对修复是否覆盖原始复现步骤，列出回归范围与验证步骤。` },
  { key: 'pm', label: '产品', prompt: (ref) => `${ref}\n\n请按产品角度处理：确认预期行为与验收标准，指出需求或交互上需要澄清的点。` },
]

/**
 * Theme tokens, copied from the reference plugin's stylesheet so the drawer
 * follows the shell's own light/dark theme instead of a hardcoded palette.
 * (My first version invented `--dsw-alias-text-1` / `-bg-2`; those names do not
 * exist, so every colour silently fell back to the hardcoded value.)
 */
const TOKEN = {
  text: 'var(--dsw-alias-label-primary, #111)',
  dim: 'var(--dsw-alias-label-secondary, #888)',
  line: 'var(--dsw-alias-border-l1, #e5e7eb)',
  bg: 'var(--dsw-alias-bg-layer-1, #fff)',
  accent: '#2563eb',
  danger: '#dc2626',
  ok: '#16a34a',
}

const box: Record<string, unknown> = {
  background: TOKEN.bg,
  color: TOKEN.text,
  border: `1px solid ${TOKEN.line}`,
  borderRadius: 10,
  boxShadow: '0 8px 28px rgba(0,0,0,.35)',
  fontFamily: 'system-ui,-apple-system,"PingFang SC",sans-serif',
  fontSize: 13,
}

/**
 * The instance origin is needed to turn the list page's relative `href` into a
 * link a reader (or the model) can actually open. It comes from the RPC config —
 * never hardcoded, because the same plugin is used against different instances.
 */
function absoluteUrl(server: string, hrefOrUrl: string): string {
  if (hrefOrUrl === '') return ''
  if (/^https?:\/\//i.test(hrefOrUrl)) return hrefOrUrl
  return `${server.replace(/\/+$/, '')}${hrefOrUrl.startsWith('/') ? '' : '/'}${hrefOrUrl}`
}

function referenceOf(bug: { id: string, title: string, status?: string, pri?: string, assignedTo?: string, url?: string }, extra?: { severity?: string }): string {
  return [
    `【禅道 Bug #${bug.id}】${bug.title}`,
    `状态 ${bug.status ?? '-'}｜优先级 ${bug.pri ?? '-'}${extra?.severity ? `｜级别 ${extra.severity}` : ''}｜指派 ${bug.assignedTo ?? '-'}`,
    bug.url ? `原始链接 ${bug.url}` : '',
    '（处理前请先用 zentao_bug_context 读取该单最新详情与解决表单默认值）',
  ].filter((line) => line !== '').join('\n')
}

export function ZentaoPanel(deps: PanelDeps): ReactNode {
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<Config | null>(null)
  const [bugs, setBugs] = useState<BugRow[]>([])
  const [only, setOnly] = useState<'all' | 'open'>('open')
  /** Server-side sort; values are whitelisted host-side (they reach SQL). */
  const [orderBy, setOrderBy] = useState('id_desc')
  /** Local keyword filter over the fetched page (id/title/type/severity/assignee/方案). */
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<'mine' | 'project'>('mine')
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [projectID, setProjectID] = useState('')
  const [intervalMin, setIntervalMin] = useState(5)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<BugContext | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [flash, setFlash] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [tab, setTab] = useState<'bugs' | 'tasks'>('bugs')
  const [bugsTotal, setBugsTotal] = useState<{ total: number, truncated: boolean, projectName?: string }>({ total: 0, truncated: false })
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [taskNote, setTaskNote] = useState('')
  const [serverDraft, setServerDraft] = useState('')
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')

  const call = useCallback(async (endpoint: string, payload?: unknown): Promise<unknown> => {
    const result = await deps.call(endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }, [deps.call])

  const refreshStatus = useCallback(async (force = true) => {
    setBusy('status')
    try {
      const status = await call('sessionStatus', { refresh: force }) as Config & { config?: Config }
      setConfig({ ...(status.config ?? status), probes: status.probes ?? status.config?.probes ?? [] } as Config)
      setError('')
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy('')
    }
  }, [call])

  const refreshBugs = useCallback(async (force = false) => {
    setBusy('bugs')
    try {
      const value = await call('listBugs', { limit: 30, only, orderBy, scope, ...(projectID === '' ? {} : { projectID }), refresh: force }) as BugsPayload
      setBugs(value.bugs)
      setBugsTotal({ total: value.total, truncated: value.truncated === true, ...(value.projectName === undefined ? {} : { projectName: value.projectName }) })
      setError('')
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy('')
    }
  }, [call, only, orderBy, scope, projectID])

  /**
   * One refresh that covers everything currently visible: the session status,
   * the list, and — when a card is open — its detail and its planned resolve.
   * A bare list refresh left the open card showing stale fields, which is the
   * kind of half-truth the panel exists to avoid.
   */
  const refreshAll = useCallback(async (force: boolean) => {
    setBusy('all')
    try {
      const status = await call('sessionStatus', { refresh: force }) as Config & { config?: Config }
      const next = { ...(status.config ?? status), probes: status.probes ?? status.config?.probes ?? [] } as Config
      setConfig(next)
      if (next.authenticated) {
        const listed = await call('listBugs', { limit: 30, only, orderBy, scope, ...(projectID === '' ? {} : { projectID }), refresh: force }) as BugsPayload
        setBugs(listed.bugs)
        if (tab === 'tasks') {
          const taskValue = await call('listTasks', { limit: 30 }) as { tasks: TaskRow[], note: string }
          setTasks(taskValue.tasks)
          setTaskNote(taskValue.note)
        }
        if (selected !== null) {
          setSelected(await call('bugContext', { bugID: selected.bug.id, refresh: force }) as BugContext)
          if (plan !== null) {
            const replanned = await call('resolvePlan', { bugID: selected.bug.id }) as { plan: Plan }
            setPlan(replanned.plan)
          }
        }
      }
      setLastUpdated(new Date())
      setError('')
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy('')
    }
  }, [call, only, orderBy, scope, projectID, tab, selected, plan])

  const refreshTasks = useCallback(async () => {
    setBusy('tasks')
    try {
      const value = await call('listTasks', { limit: 30 }) as { tasks: TaskRow[], note: string }
      setTasks(value.tasks)
      setTaskNote(value.note)
      setError('')
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy('')
    }
  }, [call])

  useEffect(() => { void refreshStatus(true) }, [refreshStatus])

  // Projects are only needed when the user picks that scope, so they load lazily.
  useEffect(() => {
    if (scope !== 'project' || projects.length > 0) return undefined
    let cancelled = false
    void (async () => {
      try {
        const value = await call('listProjects', {}) as { projects: ProjectRow[] }
        if (!cancelled) setProjects(value.projects)
      } catch (problem) {
        if (!cancelled) setError((problem as Error).message)
      }
    })()
    return () => { cancelled = true }
  }, [scope, projects.length, call])

  // Changing the filter or the sort must re-read: the loading effect below only
  // runs its initial fetch once (`lastUpdated` is already set afterwards), so
  // without this the list kept showing the previous order — caught by the
  // sort behaviour test.
  useEffect(() => {
    if (!open || config?.authenticated !== true) return undefined
    void refreshBugs(true)
    return undefined
  }, [open, config?.authenticated, only, orderBy, scope, projectID, refreshBugs])

  useEffect(() => {
    if (!open || config?.authenticated !== true) return undefined
    if (lastUpdated === null) void refreshAll(false)
    if (tab === 'tasks' && tasks.length === 0 && taskNote === '') void refreshTasks()
    if (intervalMin <= 0) return undefined
    const timer = window.setInterval(() => { void refreshAll(true) }, intervalMin * 60_000)
    return () => window.clearInterval(timer)
  }, [open, config?.authenticated, intervalMin, refreshAll, lastUpdated, tab, tasks.length, taskNote, refreshTasks])

  useEffect(() => {
    if (flash === '') return undefined
    const timer = window.setTimeout(() => setFlash(''), 2400)
    return () => window.clearTimeout(timer)
  }, [flash])

  /** Keyword filter over the fetched page — instant, no server round trip. */
  const visibleBugs = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (query === '') return bugs
    const terms = query.split(/\s+/)
    return bugs.filter((bug) => {
      const haystack = [bug.id, bug.title, bug.type, bug.severity, bug.assignedTo, bug.resolution].join(' ').toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [bugs, search])

  const openDetail = useCallback(async (bugID: string) => {
    setBusy(`detail:${bugID}`)
    setPlan(null)
    try {
      setSelected(await call('bugContext', { bugID }) as BugContext)
      setError('')
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy('')
    }
  }, [call])

  const previewPlan = useCallback(async (bugID: string) => {
    setBusy('plan')
    try {
      const value = await call('resolvePlan', { bugID }) as { plan: Plan }
      setPlan(value.plan)
      setError('')
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy('')
    }
  }, [call])

  const insert = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setFlash(`${label}已复制到剪贴板；也可以直接把它拖进输入框`)
    } catch {
      setFlash(`${label}：拖拽卡片到输入框即可（剪贴板不可用）`)
    }
  }, [])

  // Right-edge vertical tab — the reference plugin's `fab`. Hover widening is
  // dropped (inline styles cannot express :hover) but the geometry is identical:
  // glued to the right edge, vertically centred, so no viewport can hide it.
  const entry = createElement('button', {
    type: 'button',
    'data-zentao-entry': '1',
    title: '禅道工作台',
    onClick: () => setOpen((value) => !value),
    style: {
      position: 'fixed',
      // `50vh`, not `50%`: a percentage resolves against the containing block,
      // and the shell's overlay is a transformed ancestor **without a definite
      // height** — where `50%` becomes 0 and the tab snaps to the top. Viewport
      // units are definite in every container.
      top: '50vh',
      right: 0,
      transform: 'translateY(-50%)',
      zIndex: 9999,
      writingMode: 'vertical-rl',
      color: '#fff',
      cursor: 'pointer',
      letterSpacing: 3,
      background: TOKEN.accent,
      border: 'none',
      borderRadius: '8px 0 0 8px',
      padding: '16px 8px',
      fontSize: 13,
      fontWeight: 600,
      fontFamily: 'system-ui,-apple-system,"PingFang SC",sans-serif',
      boxShadow: '-2px 0 10px rgba(0,0,0,.18)',
    },
  }, FAB_TEXT)

  if (!open) return entry

  const authenticated = config?.authenticated === true
  const header = createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${TOKEN.line}` } },
    createElement('strong', { style: { flex: 1 } }, '禅道工作台'),
    createElement('span', { style: { fontSize: 11, color: authenticated ? TOKEN.ok : TOKEN.danger } },
      authenticated ? `已连接 · ${config?.strategy ?? ''}` : '未连接'),
    createElement('button', { type: 'button', onClick: () => setOpen(false), style: { background: 'none', border: 'none', color: TOKEN.dim, cursor: 'pointer' } }, '✕'))

  const body: ReactNode[] = []
  if (error !== '') body.push(createElement('div', { key: 'err', style: { padding: '8px 12px', color: TOKEN.danger, fontSize: 12 } }, error))

  if (!authenticated) {
    if ((config?.server ?? '') === '') {
      body.push(createElement('div', { key: 'server', style: { padding: '10px 12px', borderBottom: `1px solid ${TOKEN.line}` } },
        createElement('div', { style: { color: TOKEN.danger, marginBottom: 4 } },
          '还没配置禅道实例地址 —— 没有它，下面四条登录路径都无从探测。'),
        createElement('div', { style: { display: 'flex', gap: 6 } },
          createElement('input', {
            'data-zentao-server': '1',
            // No host-shaped placeholder: the bundle guard forbids anything
            // that looks like a real domain, and it is right to — a template is
            // clearer than a fake host someone might actually submit.
            placeholder: 'https://<实例域名>',
            value: serverDraft,
            onChange: (event: { target: { value: string } }) => setServerDraft(event.target.value),
            style: { flex: 1, minWidth: 0 },
          }),
          createElement('button', {
            type: 'button',
            'data-zentao-action': 'set-server',
            disabled: serverDraft === '' || busy === 'server',
            style: { cursor: serverDraft === '' ? 'not-allowed' : 'pointer' },
            onClick: async () => {
              setBusy('server')
              try {
                await call('setServer', { server: serverDraft })
                setFlash('实例地址已设置，正在重新探测…')
                await refreshStatus(true)
              } catch (problem) {
                setError((problem as Error).message)
              } finally {
                setBusy('')
              }
            },
          }, busy === 'server' ? '设置中…' : '保存')),
        createElement('div', { style: { color: TOKEN.dim, fontSize: 11, marginTop: 4 } },
          '想让它每次启动都生效：在 profile 的 cordis.patch.yml 里给 zentao-workbench 那行加 config: { server: … }，或设环境变量 ZENTAO_BASE；本机若已导出过 cookie jar，也会自动从 jar 里认出实例。')))
    }

    body.push(createElement('div', { key: 'probes', 'data-zentao-probes': '1', style: { padding: '10px 12px', flex: 1, minHeight: 0, overflowY: 'auto' } },
      createElement('div', { style: { color: TOKEN.dim, marginBottom: 6 } }, '未登录 —— 每条登录路径的探测结果与下一步：'),
      ...(config?.probes ?? []).map((probe) => createElement('div', { key: probe.id, style: { padding: '6px 0', borderTop: `1px solid ${TOKEN.line}` } },
        createElement('div', {}, `${probe.ready === false ? '✘' : '·'} ${probe.label}：${probe.detail}`),
        probe.hint ? createElement('div', { style: { color: TOKEN.dim, fontSize: 12, marginTop: 2 } }, `→ ${probe.hint}`) : null)),
      createElement('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
        createElement('button', { type: 'button', onClick: () => void refreshStatus(true), style: { cursor: 'pointer' } }, busy === 'status' ? '探测中…' : '重新探测'),
        createElement('button', {
          type: 'button',
          onClick: async () => {
            setBusy('export')
            try {
              const value = await call('refreshCookies', {}) as { detail: string }
              setFlash(`已重新导出：${value.detail.slice(0, 60)}`)
              await refreshStatus(true)
            } catch (problem) {
              setError((problem as Error).message)
            } finally {
              setBusy('')
            }
          },
          style: { cursor: 'pointer' },
        }, busy === 'export' ? '导出中…' : '重新导出 cookie')),
      createElement('div', { style: { marginTop: 12, paddingTop: 8, borderTop: `1px solid ${TOKEN.line}` } },
        createElement('div', { style: { color: TOKEN.dim, marginBottom: 4 } }, '或直接用账号密码登录（口令只在本次请求内存里，不落盘、不进日志）：'),
        createElement('div', { style: { display: 'flex', gap: 6 } },
          createElement('input', {
            placeholder: '账号',
            value: account,
            onChange: (event: { target: { value: string } }) => setAccount(event.target.value),
            style: { flex: 1, minWidth: 0 },
          }),
          createElement('input', {
            placeholder: '密码',
            type: 'password',
            value: password,
            onChange: (event: { target: { value: string } }) => setPassword(event.target.value),
            style: { flex: 1, minWidth: 0 },
          }),
          createElement('button', {
            type: 'button',
            disabled: account === '' || password === '' || busy === 'login',
            style: { cursor: account === '' || password === '' ? 'not-allowed' : 'pointer' },
            onClick: async () => {
              setBusy('login')
              try {
                const value = await call('login', { account, password }) as { detail: string }
                setPassword('')
                setFlash(value.detail)
                await refreshStatus(true)
              } catch (problem) {
                setPassword('')
                setError((problem as Error).message)
              } finally {
                setBusy('')
              }
            },
          }, busy === 'login' ? '登录中…' : '登录')))))
  } else {
    body.push(createElement('div', { key: 'tabs', style: { display: 'flex', gap: 4, padding: '8px 12px 0' } },
      ...(['bugs', 'tasks'] as const).map((value) => createElement('button', {
        key: value,
        type: 'button',
        'data-zentao-tab': value,
        onClick: () => setTab(value),
        style: {
          cursor: 'pointer',
          border: 'none',
          background: 'none',
          color: tab === value ? TOKEN.text : TOKEN.dim,
          fontWeight: tab === value ? 600 : 400,
          borderBottom: tab === value ? `2px solid ${TOKEN.accent}` : '2px solid transparent',
          padding: '2px 6px',
        },
      }, value === 'bugs' ? '我的 Bug' : '任务'))))

    if (tab === 'tasks') {
      body.push(createElement('div', { key: 'tasks', 'data-zentao-tasks': '1', style: { padding: '10px 12px', flex: 1, minHeight: 0, overflowY: 'auto' } },
        ...tasks.map((task) => createElement('div', { key: task.id, style: { padding: '6px 0', borderBottom: `1px solid ${TOKEN.line}` } },
          createElement('div', null, `#${task.id} ${task.name}`),
          createElement('div', { style: { color: TOKEN.dim, fontSize: 11 } }, `${task.status || '-'} · 指派 ${task.assignedTo || '-'}`))),
        tasks.length === 0
          ? createElement('div', { style: { color: TOKEN.dim, fontSize: 12 } }, taskNote || '加载中…')
          : createElement('div', { style: { color: TOKEN.dim, fontSize: 11, marginTop: 8 } }, taskNote)))
    }

    if (tab === 'bugs') body.push(createElement('div', { key: 'search', style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px 0' } },
      createElement('input', {
        'data-zentao-search': '1',
        // Local filter over the page already fetched: the list endpoint rejects
        // server-side keyword params (measured: keywords=/title= → 0 rows).
        placeholder: '搜索 单号 / 标题 / 类型 / 级别 / 指派给…',
        value: search,
        onChange: (event: { target: { value: string } }) => setSearch(event.target.value),
        style: { flex: 1, minWidth: 0 },
      }),
      search.trim() === ''
        ? null
        : createElement('button', { type: 'button', onClick: () => setSearch(''), style: { cursor: 'pointer' } }, '清空')))

    if (tab === 'bugs') body.push(createElement('div', { key: 'toolbar', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px', borderBottom: `1px solid ${TOKEN.line}` } },
      createElement('select', {
        'data-zentao-scope': '1',
        title: '范围：我的 Bug，或某个项目里的 Bug',
        value: scope,
        onChange: (event: { target: { value: string } }) => setScope(event.target.value === 'project' ? 'project' : 'mine'),
        style: { minWidth: 96 },
      },
        createElement('option', { value: 'mine' }, '我的 Bug'),
        createElement('option', { value: 'project' }, '项目')),
      scope === 'project'
        ? createElement('select', {
            'data-zentao-project': '1',
            title: '选择项目（列表来自禅道项目索引）',
            value: projectID,
            onChange: (event: { target: { value: string } }) => setProjectID(event.target.value),
            style: { flex: 1, minWidth: 120 },
          },
          createElement('option', { value: '' }, projects.length === 0 ? '（加载项目…）' : '选择项目…'),
          ...projects.map((project) => createElement('option', { key: project.id, value: project.id }, `${project.name}（${project.id}）`)))
        : null,
      createElement('select', { value: only, onChange: (event: { target: { value: string } }) => setOnly(event.target.value as 'all' | 'open'), style: { flex: 1, minWidth: 88 } },
        createElement('option', { value: 'open' }, '未解决'),
        createElement('option', { value: 'all' }, '全部')),
      createElement('select', {
        'data-zentao-sort': '1',
        title: '排序（服务端排序，值经宿主白名单校验）',
        value: orderBy,
        onChange: (event: { target: { value: string } }) => setOrderBy(event.target.value),
        style: { flex: 1, minWidth: 132 },
      },
        createElement('option', { value: 'id_desc' }, 'ID（新→旧）'),
        createElement('option', { value: 'id_asc' }, 'ID（旧→新）'),
        createElement('option', { value: 'openedDate_desc' }, '创建时间（新→旧）'),
        createElement('option', { value: 'openedDate_asc' }, '创建时间（旧→新）'),
        createElement('option', { value: 'severity_asc' }, '级别（高→低）'),
        createElement('option', { value: 'severity_desc' }, '级别（低→高）'),
        createElement('option', { value: 'pri_asc' }, '优先级（高→低）'),
        createElement('option', { value: 'pri_desc' }, '优先级（低→高）')),
      createElement('select', { value: String(intervalMin), onChange: (event: { target: { value: string } }) => setIntervalMin(Number(event.target.value)), title: '自动刷新间隔' },
        createElement('option', { value: '1' }, '1 分钟'),
        createElement('option', { value: '5' }, '5 分钟'),
        createElement('option', { value: '15' }, '15 分钟'),
        createElement('option', { value: '30' }, '30 分钟'),
        createElement('option', { value: '0' }, '不自动')),
      createElement('span', { style: { fontSize: 11, color: TOKEN.dim } },
        [
          scope === 'project' && bugsTotal.projectName !== undefined ? `项目【${bugsTotal.projectName}】` : '',
          search.trim() === '' ? '' : `命中 ${visibleBugs.length}/${bugs.length}`,
          bugsTotal.truncated ? `共 ${bugsTotal.total} 条，仅显示前 ${bugs.length}` : '',
        ].filter((part) => part !== '').join(' · ')),
      createElement('button', {
        type: 'button',
        'data-zentao-action': 'refresh',
        title: '刷新状态、列表、打开的详情与已生成的计划',
        onClick: () => void refreshAll(true),
        style: { cursor: 'pointer' },
      }, busy === 'all' || busy === 'bugs' ? '刷新中…' : '刷新')))

    // Only the active tab renders: the list and the detail card used to stay
    // mounted under the task tab (found in the browser harness).
    if (tab === 'bugs') {
      // The list owns every remaining pixel; the detail is an overlay laid on top
      // of it (it used to be a 260px list with the card squeezed underneath, which
      // left most of the drawer empty).
      // `selected` is narrowed here too: the submit handler below reads its id,
      // and this section is only ever rendered inside the detail overlay.
      const planSection = plan === null || selected === null ? null : createElement('div', {
        key: 'plan',
        style: { borderTop: `1px solid ${TOKEN.line}`, marginTop: 12, paddingTop: 10 },
      },
          createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, plan.blocked ? '解决计划（被拦，不能提交）' : '解决计划（预览，未提交）'),
          ...plan.fields.map(([name, value]) => createElement('div', { key: name, style: { fontSize: 12, display: 'flex', gap: 6 } },
            createElement('span', { style: { color: TOKEN.dim, minWidth: 108 } }, name),
            createElement('span', { style: { flex: 1, wordBreak: 'break-all' } }, value === '' ? '(空)' : String(value).slice(0, 160)))),
          ...Object.entries(plan.autoFilled).map(([name, why]) => createElement('div', { key: `af-${name}`, style: { fontSize: 11, color: TOKEN.dim, marginTop: 2 } }, `↳ ${name}：${why}`)),
          ...plan.problems.map((problem) => createElement('div', { key: problem, style: { fontSize: 12, color: TOKEN.danger, marginTop: 2 } }, `✘ ${problem}`)),
          createElement('div', { style: { marginTop: 8, display: 'flex', gap: 8 } },
            createElement('button', {
              type: 'button',
              disabled: plan.blocked,
              style: { cursor: plan.blocked ? 'not-allowed' : 'pointer' },
              onClick: async () => {
                // Writing asks first: the panel is a read surface by default.
                if (!window.confirm(`确认在禅道把 #${selected.bug.id} 标记为已解决？此操作会写入真实系统。`)) return
                setBusy('submit')
                try {
                  const value = await call('resolveSubmit', { bugID: selected.bug.id, confirm: true }) as { outcome: { ok: boolean, status: string, serverError?: string } }
                  setFlash(value.outcome.ok ? `已解决并回读确认（${value.outcome.status}）` : `未接受：${value.outcome.serverError ?? value.outcome.status}`)
                  if (value.outcome.ok) setPlan(null)
                  // Re-read everything visible: the list entry and the detail card
                  // both describe a bug that just changed state.
                  await refreshAll(true)
                } catch (problem) {
                  setError((problem as Error).message)
                } finally {
                  setBusy('')
                }
              },
            }, busy === 'submit' ? '提交中…' : '② 确认并提交解决')))

      const detailOverlay = selected === null ? null : createElement('div', {
        key: 'detail',
        'data-zentao-detail': '1',
        style: { position: 'absolute', inset: 0, zIndex: 2, background: TOKEN.bg, overflowY: 'auto', display: 'flex', flexDirection: 'column' },
      },
      createElement('div', {
        style: { position: 'sticky', top: 0, zIndex: 1, display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', background: TOKEN.bg, borderBottom: `1px solid ${TOKEN.line}` },
      },
      createElement('button', {
        type: 'button',
        'data-zentao-action': 'close-detail',
        onClick: () => { setSelected(null); setPlan(null) },
        style: { cursor: 'pointer' },
      }, '← 返回列表'),
      createElement('span', { style: { flex: 1, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `#${selected.bug.id} ${selected.bug.title}`)),
      createElement('div', { style: { padding: '10px 12px' } },
        createElement('div', { style: { color: TOKEN.dim, fontSize: 12, margin: '4px 0', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          severityBadge(selected.bug.severity || '', selected.bug.severityLevel),
          createElement('span', null, `产品 ${selected.bug.productLabel || selected.bug.product || '-'}｜状态 ${selected.bug.status || '-'}｜指派 ${selected.bug.assignedTo || '-'}`)),
        (selected.bug.story ?? '') === ''
          ? createElement('div', { style: { color: TOKEN.dim, fontSize: 11, marginTop: 2 } }, '相关需求：无（列表页没有需求列，只有详情页有）')
          : createElement('div', { style: { fontSize: 11, marginTop: 2 } },
              createElement('span', { style: { color: TOKEN.dim } }, '相关需求：'),
              createElement('a', {
                href: (selected.bug.storyID ?? '') === ''
                  ? undefined
                  : absoluteUrl(config?.server ?? '', `/index.php?m=story&f=view&storyID=${selected.bug.storyID}`),
                target: '_blank',
                rel: 'noreferrer',
                style: { color: TOKEN.accent },
              }, selected.bug.story ?? '')),
        createElement('div', { style: { fontSize: 12 } },
          `必填：${selected.resolve.fields.filter((field) => field.required).map((field) => field.label).join('、')}`),
        createElement('div', { style: { fontSize: 12, color: TOKEN.dim, marginTop: 2 } },
          `下拉规模 ${selected.resolve.optionCounts.resolvedBuild}/${selected.resolve.optionCounts.bugInchargedBy}/${selected.resolve.optionCounts.assignedTo}（已收敛）`),
        ...(selected.histories.length > 0
          ? [createElement('div', { key: 'hist', style: { marginTop: 6, fontSize: 12, color: TOKEN.dim } }, ...selected.histories.map((line, index) => createElement('div', { key: index }, `· ${line}`)))]
          : []),
        createElement('div', { style: { color: TOKEN.dim, fontSize: 11, marginTop: 8 } },
          '要解决这条 Bug：点「① 预览解决计划」看清将要提交的字段，再点「② 确认并提交解决」（会二次确认）。'),
        createElement('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
          createElement('button', { type: 'button', draggable: true, style: { cursor: 'grab' }, onDragStart: (event: { dataTransfer?: { setData(t: string, v: string): void } }) => event.dataTransfer?.setData('text/plain', referenceOf(selected.bug)) }, '拖我引用'),
          createElement('button', { type: 'button', onClick: () => void insert(referenceOf(selected.bug), '引用'), style: { cursor: 'pointer' } }, '复制引用'),
          createElement('button', {
            type: 'button',
            'data-zentao-action': 'plan',
            title: '第 1 步：按表单默认值生成解决计划（只读，不会提交）',
            onClick: () => void previewPlan(selected.bug.id),
            style: { cursor: 'pointer', fontWeight: 600, borderColor: TOKEN.accent, color: TOKEN.accent },
          }, busy === 'plan' ? '生成中…' : '① 预览解决计划'),
          ...ROLE_PRESETS.map((role) => createElement('button', {
            key: role.key,
            type: 'button',
            // Each one opens a NEW conversation in the current workspace and sends
            // the bug reference plus that role's preset prompt — nothing is written
            // to ZenTao.
            title: `新建一个会话，把这条 Bug 的引用 + 「${role.label}」视角的预设提示词发过去（只开对话，不改单）`,
            style: { cursor: 'pointer' },
            onClick: async () => {
              try {
                await deps.handlePrompt(role.prompt(referenceOf(selected.bug)))
                setFlash(`已按「${role.label}」起会话`)
              } catch (problem) {
                setError((problem as Error).message)
              }
            },
          }, `处理·${role.label}`))),
      planSection))

      body.push(createElement('div', { key: 'content', style: { position: 'relative', flex: 1, minHeight: 0 } },
        createElement('div', {
          key: 'list',
          'data-zentao-list': '1',
          style: { position: 'absolute', inset: 0, overflowY: 'auto' },
        },
      ...visibleBugs.map((bug) => createElement('div', {
        key: bug.id,
        'data-zentao-bug': bug.id,
        draggable: true,
        onDragStart: (event: { dataTransfer?: { setData(type: string, value: string): void } }) => {
          event.dataTransfer?.setData('text/plain', referenceOf({
            ...bug,
            status: bug.resolution === '' ? '未解决' : '已解决',
            url: absoluteUrl(config?.server ?? '', bug.href),
          }))
        },
        onClick: () => void openDetail(bug.id),
        style: { padding: '7px 12px', borderBottom: `1px solid ${TOKEN.line}`, cursor: 'grab' },
      },
      createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
        createElement('span', { style: { color: TOKEN.dim, fontSize: 11 } }, `#${bug.id}`),
        createElement('span', { style: { flex: 1 } }, bug.title)),
      createElement('div', { style: { color: TOKEN.dim, fontSize: 11, marginTop: 2, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
        severityBadge(bug.severity || '', bug.severityLevel),
        createElement('span', null, `P${bug.pri || '-'} · ${bug.type || ''} · 指派 ${bug.assignedTo || '-'}`))))),
        detailOverlay))
    }
  }

  const stamp = lastUpdated === null ? '尚未刷新' : `最近更新 ${lastUpdated.toLocaleTimeString()}`
  // The footer always states the instance and the last refresh time; transient
  // messages go to the corner toast instead of replacing this line.
  const footer = createElement('div', { style: { padding: '6px 12px', borderTop: `1px solid ${TOKEN.line}`, color: TOKEN.dim, fontSize: 11, display: 'flex', gap: 8 } },
    createElement('span', { style: { flex: 1 } }, config?.server ? `实例 ${config.server}` : '未配置实例地址（server）'),
    createElement('span', { 'data-zentao-stamp': '1' }, stamp))

  // Right-edge drawer, mirroring the reference plugin's `panel`.
  const panel = createElement('div', {
    'data-zentao-panel': '1',
    style: {
      position: 'fixed',
      top: 0,
      right: 0,
      zIndex: 10000,
      width: 384,
      maxWidth: '92vw',
      // Viewport height, never a percentage. Measured in Chromium: with a
      // transformed ancestor whose height is auto (the shell's overlay), both
      // `height: 100%` and `max-height: 100%` resolve to 0 — the drawer vanished
      // / collapsed to the top ("最大化后全部靠上了"). `100vh` is definite
      // everywhere; the cap is viewport-based too, so it can never be 0.
      height: '100vh',
      maxHeight: '100vh',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: TOKEN.bg,
      color: TOKEN.text,
      borderLeft: `1px solid ${TOKEN.line}`,
      boxShadow: '-8px 0 28px rgba(0,0,0,.14)',
      fontFamily: 'system-ui,-apple-system,"PingFang SC",sans-serif',
      fontSize: 13,
    },
  }, header, createElement('div', {
    // A flex column rather than one big scroll area: the list has to own the
    // remaining height (`minHeight: 0` is what lets a flex child shrink enough
    // to scroll), while the unauthenticated view scrolls on its own.
    style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  }, ...body), footer)

  // The drawer covers the right edge, so the tab is not rendered while it is
  // open (the reference plugin leaves its fab underneath and relies on the ✕;
  // hiding it removes the overlap instead of depending on z-order).
  const fab = open ? null : entry

  // Transient messages live in their own corner toast (never in the layout flow).
  if (flash === '') return createElement('div', null, fab, panel)
  const toast = createElement('div', {
    'data-zentao-toast': '1',
    style: {
      position: 'fixed',
      bottom: 26,
      right: 26,
      zIndex: 10001,
      background: 'var(--dsw-alias-bg-overlay, #333)',
      color: 'var(--dsw-alias-label-primary, #fff)',
      borderRadius: 9,
      padding: '10px 15px',
      fontSize: 13,
      boxShadow: '0 6px 20px rgba(0,0,0,.22)',
      maxWidth: 360,
    },
  }, flash)
  return createElement('div', null, fab, panel, toast)
}

/** Slot registration keeps a stable identity for the seat. */
export const name = 'zentao-workbench-panel'
