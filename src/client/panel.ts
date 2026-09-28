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
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

type RpcResult = { ok: true, value: unknown } | { ok: false, error: { code: string, message: string } }

export interface PanelDeps {
  rpc: { call(channel: string, endpoint: string, payload?: unknown): Promise<RpcResult> }
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
interface BugRow {
  id: string
  severity: string
  pri: string
  type: string
  title: string
  assignedTo: string
  resolution: string
  href: string
}
interface BugContext {
  bug: { id: string, title: string, product: string, status: string, assignedTo: string, url: string }
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

const ROLE_PRESETS: Array<{ key: string, label: string, prompt: (reference: string) => string }> = [
  { key: 'dev', label: '开发', prompt: (ref) => `${ref}\n\n请按开发角度处理这个 Bug：先复现、定位根因、给出最小改动修复并自测，必要时补充用例。` },
  { key: 'qa', label: '测试', prompt: (ref) => `${ref}\n\n请按测试角度处理：核对修复是否覆盖原始复现步骤，列出回归范围与验证步骤。` },
  { key: 'pm', label: '产品', prompt: (ref) => `${ref}\n\n请按产品角度处理：确认预期行为与验收标准，指出需求或交互上需要澄清的点。` },
]

const TOKEN = {
  text: 'var(--dsw-alias-text-1, #e6e6e6)',
  dim: 'var(--dsw-alias-text-3, #9a9a9a)',
  line: 'var(--dsw-alias-border-1, rgba(255,255,255,.14))',
  bg: 'var(--dsw-alias-bg-2, #1b1c1f)',
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
  const [pos, setPos] = useState<{ x: number, y: number }>(() => ({ x: window.innerWidth - 56, y: window.innerHeight / 2 - 40 }))
  const [config, setConfig] = useState<Config | null>(null)
  const [bugs, setBugs] = useState<BugRow[]>([])
  const [only, setOnly] = useState<'all' | 'open'>('open')
  const [intervalMin, setIntervalMin] = useState(5)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<BugContext | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [flash, setFlash] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const drag = useRef<{ active: boolean, dx: number, dy: number }>({ active: false, dx: 0, dy: 0 })

  const call = useCallback(async (endpoint: string, payload?: unknown): Promise<unknown> => {
    const result = await deps.rpc.call('/zentao', endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }, [deps.rpc])

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
      const value = await call('listBugs', { limit: 30, only, refresh: force }) as { bugs: BugRow[] }
      setBugs(value.bugs)
      setError('')
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy('')
    }
  }, [call, only])

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
        const listed = await call('listBugs', { limit: 30, only, refresh: force }) as { bugs: BugRow[] }
        setBugs(listed.bugs)
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
  }, [call, only, selected, plan])

  useEffect(() => { void refreshStatus(true) }, [refreshStatus])

  useEffect(() => {
    if (!open || config?.authenticated !== true) return undefined
    if (lastUpdated === null) void refreshAll(false)
    if (intervalMin <= 0) return undefined
    const timer = window.setInterval(() => { void refreshAll(true) }, intervalMin * 60_000)
    return () => window.clearInterval(timer)
  }, [open, config?.authenticated, intervalMin, refreshAll, lastUpdated])

  useEffect(() => {
    if (flash === '') return undefined
    const timer = window.setTimeout(() => setFlash(''), 2400)
    return () => window.clearTimeout(timer)
  }, [flash])

  const onPointerDown = useCallback((event: { clientX: number, clientY: number }) => {
    drag.current = { active: true, dx: event.clientX - pos.x, dy: event.clientY - pos.y }
  }, [pos.x, pos.y])

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      if (!drag.current.active) return
      setPos({ x: Math.max(8, Math.min(window.innerWidth - 48, event.clientX - drag.current.dx)), y: Math.max(8, Math.min(window.innerHeight - 48, event.clientY - drag.current.dy)) })
    }
    const up = (): void => { drag.current.active = false }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [])

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

  const entry = createElement('button', {
    type: 'button',
    title: '禅道工作台（可拖动）',
    onPointerDown,
    onClick: () => setOpen((value) => !value),
    style: {
      ...box,
      position: 'fixed',
      left: pos.x,
      top: pos.y,
      width: 40,
      height: 40,
      zIndex: 9998,
      cursor: 'grab',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontWeight: 700,
      color: '#fff',
      background: config?.authenticated === true ? TOKEN.accent : '#6b7280',
    },
  }, '禅')

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
    body.push(createElement('div', { key: 'probes', style: { padding: '10px 12px' } },
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
        }, busy === 'export' ? '导出中…' : '重新导出 cookie'))))
  } else {
    body.push(createElement('div', { key: 'toolbar', style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderBottom: `1px solid ${TOKEN.line}` } },
      createElement('select', { value: only, onChange: (event: { target: { value: string } }) => setOnly(event.target.value as 'all' | 'open'), style: { flex: 1 } },
        createElement('option', { value: 'open' }, '未解决'),
        createElement('option', { value: 'all' }, '全部')),
      createElement('select', { value: String(intervalMin), onChange: (event: { target: { value: string } }) => setIntervalMin(Number(event.target.value)), title: '自动刷新间隔' },
        createElement('option', { value: '1' }, '1 分钟'),
        createElement('option', { value: '5' }, '5 分钟'),
        createElement('option', { value: '15' }, '15 分钟'),
        createElement('option', { value: '30' }, '30 分钟'),
        createElement('option', { value: '0' }, '不自动')),
      createElement('button', {
        type: 'button',
        title: '刷新状态、列表、打开的详情与已生成的计划',
        onClick: () => void refreshAll(true),
        style: { cursor: 'pointer' },
      }, busy === 'all' || busy === 'bugs' ? '刷新中…' : '刷新')))

    body.push(createElement('div', { key: 'list', style: { maxHeight: 260, overflow: 'auto' } },
      ...bugs.map((bug) => createElement('div', {
        key: bug.id,
        draggable: true,
        onDragStart: (event: { dataTransfer?: { setData(type: string, value: string): void } }) => {
          event.dataTransfer?.setData('text/plain', referenceOf({ ...bug, status: bug.resolution === '' ? '未解决' : '已解决', url: `https://example.invalid${bug.href}` }))
        },
        onClick: () => void openDetail(bug.id),
        style: { padding: '7px 12px', borderBottom: `1px solid ${TOKEN.line}`, cursor: 'grab' },
      },
      createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
        createElement('span', { style: { color: TOKEN.dim, fontSize: 11 } }, `#${bug.id}`),
        createElement('span', { style: { flex: 1 } }, bug.title)),
      createElement('div', { style: { color: TOKEN.dim, fontSize: 11, marginTop: 2 } }, `${bug.severity || '-'} / P${bug.pri || '-'} · ${bug.type || ''} · 指派 ${bug.assignedTo || '-'}`)))))

    if (selected !== null) {
      body.push(createElement('div', { key: 'detail', style: { borderTop: `1px solid ${TOKEN.line}`, padding: '10px 12px', maxHeight: 300, overflow: 'auto' } },
        createElement('div', { style: { fontWeight: 600 } }, `${selected.bug.id}｜${selected.bug.title}`),
        createElement('div', { style: { color: TOKEN.dim, fontSize: 12, margin: '4px 0' } },
          `产品 ${selected.bug.product || '-'}｜状态 ${selected.bug.status || '-'}｜指派 ${selected.bug.assignedTo || '-'}`),
        createElement('div', { style: { fontSize: 12 } },
          `必填：${selected.resolve.fields.filter((field) => field.required).map((field) => field.label).join('、')}`),
        createElement('div', { style: { fontSize: 12, color: TOKEN.dim, marginTop: 2 } },
          `下拉规模 ${selected.resolve.optionCounts.resolvedBuild}/${selected.resolve.optionCounts.bugInchargedBy}/${selected.resolve.optionCounts.assignedTo}（已收敛）`),
        ...(selected.histories.length > 0
          ? [createElement('div', { key: 'hist', style: { marginTop: 6, fontSize: 12, color: TOKEN.dim } }, ...selected.histories.map((line, index) => createElement('div', { key: index }, `· ${line}`)))]
          : []),
        createElement('div', { style: { display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' } },
          createElement('button', { type: 'button', draggable: true, style: { cursor: 'grab' }, onDragStart: (event: { dataTransfer?: { setData(t: string, v: string): void } }) => event.dataTransfer?.setData('text/plain', referenceOf(selected.bug)) }, '拖我引用'),
          createElement('button', { type: 'button', onClick: () => void insert(referenceOf(selected.bug), '引用'), style: { cursor: 'pointer' } }, '复制引用'),
          createElement('button', { type: 'button', onClick: () => void previewPlan(selected.bug.id), style: { cursor: 'pointer' } }, busy === 'plan' ? '生成中…' : '预览解决计划'),
          ...ROLE_PRESETS.map((role) => createElement('button', {
            key: role.key,
            type: 'button',
            style: { cursor: 'pointer' },
            onClick: async () => {
              try {
                await deps.handlePrompt(role.prompt(referenceOf(selected.bug)))
                setFlash(`已按「${role.label}」起会话`)
              } catch (problem) {
                setError((problem as Error).message)
              }
            },
          }, `处理·${role.label}`)))))

      if (plan !== null) {
        body.push(createElement('div', { key: 'plan', style: { borderTop: `1px solid ${TOKEN.line}`, padding: '10px 12px', maxHeight: 260, overflow: 'auto' } },
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
                  await refreshBugs(true)
                } catch (problem) {
                  setError((problem as Error).message)
                } finally {
                  setBusy('')
                }
              },
            }, busy === 'submit' ? '提交中…' : '确认并提交解决'))))
      }
    }
  }

  const stamp = lastUpdated === null ? '尚未刷新' : `最近更新 ${lastUpdated.toLocaleTimeString()}`
  const footer = flash === ''
    ? createElement('div', { style: { padding: '6px 12px', borderTop: `1px solid ${TOKEN.line}`, color: TOKEN.dim, fontSize: 11, display: 'flex', gap: 8 } },
        createElement('span', { style: { flex: 1 } }, config?.server ? `实例 ${config.server}` : '未配置实例地址（server）'),
        createElement('span', null, stamp))
    : createElement('div', { style: { padding: '6px 12px', borderTop: `1px solid ${TOKEN.line}`, color: TOKEN.ok, fontSize: 11 } }, flash)

  const panel = createElement('div', {
    style: {
      ...box,
      position: 'fixed',
      left: Math.max(8, Math.min(window.innerWidth - 372, pos.x - 332)),
      top: Math.max(8, Math.min(window.innerHeight - 440, pos.y - 20)),
      width: 364,
      maxHeight: '80vh',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 9999,
      overflow: 'hidden',
    },
  }, header, createElement('div', { style: { overflow: 'auto', flex: 1 } }, ...body), footer)

  return createElement('div', null, entry, panel)
}

/** Slot registration keeps a stable identity for the seat. */
export const name = 'zentao-workbench-panel'
