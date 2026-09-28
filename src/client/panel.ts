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
import { severityTone, priTone, type SeverityTone} from '../severity.js'

import type { ZentaoCallResult as RpcResult } from '../protocol.js'

/** Injected by scripts/bundle-client.mjs at build time. */
declare const __BUILD_STAMP__: string

export interface PanelDeps {
  /**
   * Where the panel is rendered:
   *  · `floating` (default) — the right-edge tab plus a fixed drawer;
   *  · `sidebar` — inline inside the native right sidebar tab (no tab, no drawer).
   */
  variant?: 'floating' | 'sidebar'
  /** Open the native sidebar tab; returns false when this host has no sidebar. */
  openInSidebar?: () => boolean
  /**
   * Whether the native sidebar is already hosting this panel.
   *
   * Deliberately no longer used to *hide* the floating entry: the sidebar tab
   * could not be confirmed in the real shell, and hiding the only working entry
   * on an unverified assumption left the user with nothing to click.
   */
  hasSidebar?: () => boolean
  /** What happened while registering the native sidebar tab (shown in the UI). */
  sidebarStatus?: () => { registered: boolean, opened: boolean, error?: string }
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
    /** Sanitised description HTML (tables/lists/images), rendered as HTML. */
    descriptionHtml?: string
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
function toneBadge(text: string, tone: SeverityTone, attrs: Record<string, string>, hint: string): ReactNode {
  const label = text.trim()
  if (label === '') return null
  return createElement('span', {
    ...attrs,
    className: 'zt-pill',
    title: hint,
    style: { background: tone.bg, color: tone.fg },
  }, label)
}

/** Severity badge, coloured by the numeric level the list markup carries. */
function severityBadge(label: string, level: number | null | undefined): ReactNode {
  const text = label.trim()
  if (text === '') return null
  const tone = severityTone(level, text)
  return toneBadge(text, tone, { 'data-zentao-severity': String(level ?? '') }, `级别 ${text}（${tone.rank}）`)
}

/** Priority badge — same mechanism, its own palette, so P and 级别 never blur. */
function priBadge(pri: string): ReactNode {
  const text = String(pri ?? '').trim()
  if (text === '') return null
  const tone = priTone(text)
  const label = /^[Pp]/.test(text) ? text.toUpperCase() : `P${text}`
  return toneBadge(label, tone, { 'data-zentao-pri': text }, `优先级 ${label}（${tone.rank}）`)
}

/**
 * The discipline every preset repeats.
 *
 * It is in the prompt on purpose: a model that starts from the pasted reference
 * alone tends to guess at the resolve form (that is what cost the old flow ~42
 * retries), so each preset tells it to read the context first, plan before
 * posting, and not leave the auto-filled placeholder in the ticket.
 */
const DISCIPLINE = [
  '工作纪律（按顺序）：',
  '1. 先用 zentao_bug_context 读该单**最新**详情（引用里的状态可能已过期；必要时 refresh=true）；',
  '2. 改单只用 zentao_resolve_bug：**先 dryRun:true 预览**，确认无误再去掉 dryRun 提交；不要手写 POST；',
  '3. 提交前把 detail_reason 与 changeImpact 换成**真实**内容 —— 插件会自动兜底，但兜底文案会留在单子里。',
].join('\n')

/**
 * The panel's stylesheet.
 *
 * Inline styles cannot express `:hover`, a sticky header or a pill radius, and
 * the panel is injected into someone else's DOM — so it ships one scoped sheet
 * (every selector is namespaced under `.zt-`) instead of a build-time CSS file.
 * Colours use the shell's theme variables with plain fallbacks, so it reads
 * correctly on the light and the dark theme.
 */
/**
 * Render a resolve-form value.
 *
 * ZenTao's `detail_reason` default is an HTML template
 * (`<p><strong>[产生原因及改进]</strong>(开发填写)</p>…`), so plain-text rendering
 * showed the user raw tags. Values that look like markup are sanitised and
 * rendered as markup; everything else stays text.
 */
function richValue(value: unknown): ReactNode {
  const text = String(value ?? '')
  if (text === '') return '(空)'
  if (!/<\s*[a-z][\s\S]*?>/i.test(text)) return text.length > 200 ? `${text.slice(0, 200)}…` : text
  return createElement('div', {
    'data-zentao-rich-value': '1',
    dangerouslySetInnerHTML: { __html: compactHtml(clientSanitize(text)) },
    style: { flex: 1, wordBreak: 'break-word', lineHeight: 1.5 },
  }, null)
}

/**
 * Squeeze a form template's filler whitespace.
 *
 * ZenTao's `detail_reason` default is padded with empty paragraphs and runs of
 * `<br />` to reserve writing space. Rendered verbatim it became a tall block the
 * user had to scroll through to see two lines of text (their report), so the
 * filler is collapsed — the writing space belongs in the ZenTao form, not in a
 * read-only preview.
 */
function compactHtml(html: string): string {
  return html
    .replace(/<p>\s*(?:&nbsp;|\s|<br\s*\/?>)*<\/p>/gi, '')
    .replace(/(?:<br\s*\/?>\s*){2,}/gi, '<br />')
    .replace(/^(?:\s|<br\s*\/?>)+/i, '')
    .replace(/(?:\s|<br\s*\/?>)+$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Mirror of the host's sanitiser: no scripts, handlers or javascript: URLs. */
function clientSanitize(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '$1="#"')
}

const PANEL_CSS = `
.zt-row { display: flex; flex-direction: column; gap: 4px; padding: 9px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eceff3); cursor: grab; transition: background .12s ease; }
.zt-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 5%, transparent); }
.zt-row:active { background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 9%, transparent); }
.zt-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
.zt-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.zt-ok { color: #15803d; }
.zt-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 17px; padding: 0 7px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: .2px; }
.zt-head { display: flex; align-items: center; gap: 8px; position: sticky; top: 0; z-index: 3; backdrop-filter: blur(8px); }
.zt-btn { height: 26px; padding: 0 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); background: transparent; color: inherit; font-size: 12px; cursor: pointer; transition: background .12s ease, border-color .12s ease; }
.zt-btn:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 6%, transparent); }
.zt-btn-primary { border-color: #2563eb; color: #2563eb; font-weight: 600; }
.zt-btn-primary:hover { background: color-mix(in srgb, #2563eb 10%, transparent); }
.zt-field { height: 26px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); background: transparent; color: inherit; font-size: 12px; padding: 0 22px 0 8px; cursor: pointer; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 7px center; transition: border-color .12s ease, background-color .12s ease; }
.zt-field:hover { background-color: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 5%, transparent); }
.zt-field:focus { outline: 2px solid color-mix(in srgb, #2563eb 40%, transparent); outline-offset: 1px; }
.zt-sec { padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eceff3); }
.zt-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); margin-bottom: 4px; }
.zt-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.zt-tabs { display: flex; gap: 2px; padding: 6px 10px 0; }
.zt-tab { border: none; background: none; color: var(--dsw-alias-label-secondary, #888); font-size: 12px; padding: 6px 10px 7px; cursor: pointer; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0; }
.zt-tab:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 5%, transparent); }
.zt-tab-on { color: var(--dsw-alias-label-primary, #111); font-weight: 600; border-bottom-color: #2563eb; }
.zt-dot { width: 7px; height: 7px; border-radius: 999px; flex: 0 0 auto; }
.zt-dot-open { background: #f59e0b; }
.zt-dot-done { background: #22c55e; }
.zt-row-on { background: color-mix(in srgb, #2563eb 8%, transparent); }
.zt-chev { opacity: 0; transition: opacity .12s ease; color: var(--dsw-alias-label-secondary, #888); font-size: 12px; }
.zt-row:hover .zt-chev { opacity: 1; }
.zt-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 4px; }
.zt-chip { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border-radius: 6px; font-size: 11px; background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 5%, transparent); color: var(--dsw-alias-label-secondary, #777); }
.zt-chip-warn { background: color-mix(in srgb, #f59e0b 18%, transparent); color: #92400e; }
.zt-hist { margin-top: 6px; padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-l1, #eceff3); color: var(--dsw-alias-label-secondary, #888); font-size: 11px; line-height: 1.6; }
.zt-desc { font-size: 12px; line-height: 1.65; border: 1px solid var(--dsw-alias-border-l1, #eceff3); border-radius: 10px; padding: 10px 12px; overflow-x: auto; background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 2%, transparent); }
.zt-back { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px 0 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); background: transparent; color: inherit; font-size: 12px; cursor: pointer; transition: background .12s ease, border-color .12s ease; }
.zt-back:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 7%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 22%, transparent); }
.zt-back-arrow { font-size: 13px; line-height: 1; transform: translateY(-1px); }
.zt-toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eceff3); }
.zt-toolbar-note { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
.zt-checkall { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); font-size: 11px; color: var(--dsw-alias-label-secondary, #888); cursor: pointer; user-select: none; }
.zt-checkall:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 6%, transparent); }
.zt-checkall input { margin: 0; cursor: pointer; }
.zt-checkall-on { border-color: #2563eb; color: #1d4ed8; background: color-mix(in srgb, #2563eb 10%, transparent); font-weight: 600; }
.zt-batch { display: flex; align-items: center; gap: 6px; margin: 8px 12px 0; padding: 5px 8px 5px 10px; border-radius: 9px; border: 1px solid color-mix(in srgb, #2563eb 32%, transparent); background: color-mix(in srgb, #2563eb 8%, transparent); }
.zt-batch-count { font-size: 11px; font-weight: 600; color: #1d4ed8; white-space: nowrap; }
.zt-batch .zt-btn { height: 24px; padding: 0 9px; }
.zt-batch-clear { margin-left: auto; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #888); cursor: pointer; font-size: 11px; line-height: 1; padding: 5px 6px; border-radius: 6px; }
.zt-batch-clear:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 10%, transparent); color: var(--dsw-alias-label-primary, #111); }
.zt-search { display: flex; align-items: center; gap: 7px; margin: 10px 12px 0; padding: 0 9px; height: 32px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 2%, transparent); transition: border-color .12s ease, box-shadow .12s ease; }
.zt-search:hover { border-color: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 18%, transparent); }
.zt-search:focus-within { border-color: #2563eb; box-shadow: 0 0 0 3px color-mix(in srgb, #2563eb 16%, transparent); }
.zt-search-icon { flex: 0 0 auto; width: 17px; height: 17px; opacity: .55; color: var(--dsw-alias-label-secondary, #888); }
.zt-search:focus-within .zt-search-icon { opacity: .9; color: #2563eb; }
.zt-search input { flex: 1; min-width: 0; height: 100%; border: none; outline: none; background: transparent; color: inherit; font-size: 13px; }
.zt-search input::placeholder { color: var(--dsw-alias-label-secondary, #999); }
.zt-search-clear { border: none; background: transparent; color: inherit; opacity: .5; cursor: pointer; font-size: 11px; line-height: 1; padding: 4px 5px; border-radius: 6px; }
.zt-search-clear:hover { opacity: 1; background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 10%, transparent); }
.zt-empty { padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary, #888); font-size: 12px; line-height: 1.8; }
.zt-bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eceff3); }
`

const ROLE_PRESETS: Array<{ key: string, label: string, prompt: (reference: string) => string }> = [
  { key: 'fix', label: '一键修复', prompt: (ref) => `${ref}\n\n请直接修复这个 Bug：先复现并定位根因（信息不足就明确说缺什么，别猜），给出最小改动修复并自测（能跑测试就跑）。\n\n${DISCIPLINE}` },
  { key: 'dev', label: '开发', prompt: (ref) => `${ref}\n\n请按**开发**角度处理：复现 → 定位根因 → 最小改动修复 → 自测（必要时补用例）。\n\n${DISCIPLINE}` },
  { key: 'qa', label: '测试', prompt: (ref) => `${ref}\n\n请按**测试**角度处理：核对修复是否覆盖原始复现步骤，列出回归范围与可执行的验证步骤。\n\n${DISCIPLINE}` },
  { key: 'pm', label: '产品', prompt: (ref) => `${ref}\n\n请按**产品**角度处理：确认预期行为与验收标准，指出需求/交互上需要澄清的点。\n\n${DISCIPLINE}` },
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
  /** Sidebar variant renders its body immediately; the floating one starts collapsed. */
  const inline = deps.variant === 'sidebar'
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<Config | null>(null)
  const [bugs, setBugs] = useState<BugRow[]>([])
  const [only, setOnly] = useState<'all' | 'open'>('open')
  /** Server-side sort; values are whitelisted host-side (they reach SQL). */
  const [orderBy, setOrderBy] = useState('id_desc')
  /** Local keyword filter over the fetched page (id/title/type/severity/assignee/方案). */
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<'mine' | 'project'>('mine')
  /** Bug ids ticked for a batch action (survives paging/filter changes). */
  const [checked, setChecked] = useState<string[]>([])
  /** Progress of a running batch, e.g. `2/5 提交中`. */
  const [batchProgress, setBatchProgress] = useState('')
  /** Description HTML with its images already inlined as data URLs. */
  const [richDescription, setRichDescription] = useState('')
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
    if (!(open || inline) || config?.authenticated !== true) return undefined
    void refreshBugs(true)
    return undefined
  }, [open, config?.authenticated, only, orderBy, scope, projectID, refreshBugs])

  useEffect(() => {
    if (!(open || inline) || config?.authenticated !== true) return undefined
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
  const toggleChecked = useCallback((bugID: string) => {
    setChecked((previous) => previous.includes(bugID) ? previous.filter((id) => id !== bugID) : [...previous, bugID])
  }, [])

  const visibleBugs = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (query === '') return bugs
    const terms = query.split(/\s+/)
    return bugs.filter((bug) => {
      const haystack = [bug.id, bug.title, bug.type, bug.severity, bug.assignedTo, bug.resolution].join(' ').toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [bugs, search])

  /**
   * Turn the ticket's description HTML into something the panel can render.
   *
   * Two jobs: (1) render tags instead of showing them as text, (2) inline the
   * images — they need the ZenTao session, which only the host has, so each one
   * is fetched through the `image` endpoint and swapped in as a data URL. A
   * failure leaves the original `src` in place rather than dropping the picture
   * silently.
   */
  useEffect(() => {
    const html = selected?.bug.descriptionHtml ?? ''
    if (html.trim() === '') {
      setRichDescription('')
      return undefined
    }
    let cancelled = false
    void (async () => {
      // Keep images inside the pane regardless of how wide they were pasted.
      let out = html.replace(/<img\b/gi, '<img style="max-width:100%;height:auto" ')
      const sources = [...out.matchAll(/<img[^>]*\bsrc=(['"])([^'"]+)\1/gi)].map((match) => match[2] ?? '')
      for (const source of new Set(sources)) {
        if (source.startsWith('data:')) continue
        try {
          const value = await call('image', { url: absoluteUrl(config?.server ?? '', source) }) as { dataUrl: string }
          out = out.split(`"${source}"`).join(`"${value.dataUrl}"`).split(`'${source}'`).join(`'${value.dataUrl}'`)
        } catch {
          // leave it: the alt text / broken-image icon still tells the user there was one
        }
      }
      if (!cancelled) setRichDescription(out)
    })()
    return () => { cancelled = true }
  }, [selected, config?.server, call])

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

  /**
   * Batch actions work on the ticked ids.
   *
   * Deliberately *not* a new host endpoint: each bug goes through the same
   * `resolvePlan` / `resolveSubmit` pair the single-bug flow uses, so the batch
   * inherits the dryRun-first discipline and the per-bug verdicts stay visible
   * (a batch that reports only "done" would hide exactly the failures this
   * plugin exists to prevent).
   */
  const batchPreview = useCallback(async () => {
    if (checked.length === 0) return
    setBatchProgress(`预览 0/${checked.length}`)
    const blocked: string[] = []
    const ready: string[] = []
    try {
      for (const [index, bugID] of checked.entries()) {
        setBatchProgress(`预览 ${index + 1}/${checked.length}`)
        const value = await call('resolvePlan', { bugID }) as { plan: Plan }
        if (value.plan.blocked || value.plan.problems.length > 0) blocked.push(`#${bugID}`)
        else ready.push(`#${bugID}`)
      }
      setFlash(`可提交 ${ready.length} 条${ready.length > 0 ? `（${ready.join(' ')}）` : ''}${blocked.length > 0 ? `；被拦 ${blocked.length} 条（${blocked.join(' ')}）` : ''}`)
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBatchProgress('')
    }
  }, [call, checked])

  const batchResolve = useCallback(async () => {
    if (checked.length === 0) return
    // Writing asks first — and says exactly which bugs it will touch.
    if (!window.confirm(`确认在禅道把 ${checked.length} 条标记为已解决？\n${checked.map((id) => `#${id}`).join(' ')}\n此操作会写入真实系统。`)) return
    setBusy('batch')
    const ok: string[] = []
    const failed: string[] = []
    try {
      for (const [index, bugID] of checked.entries()) {
        setBatchProgress(`提交 ${index + 1}/${checked.length}`)
        try {
          const value = await call('resolveSubmit', { bugID, confirm: true }) as { outcome: { ok: boolean, status: string, serverError?: string } }
          if (value.outcome.ok) ok.push(`#${bugID}`)
          else failed.push(`#${bugID}（${value.outcome.serverError ?? value.outcome.status}）`)
        } catch (problem) {
          failed.push(`#${bugID}（${(problem as Error).message}）`)
        }
      }
      setFlash(`批量解决：成功 ${ok.length} 条${ok.length > 0 ? `（${ok.join(' ')}）` : ''}${failed.length > 0 ? `；失败 ${failed.length} 条：${failed.join('；')}` : ''}`)
      setChecked([])
      setPlan(null)
      await refreshAll(true)
    } finally {
      setBatchProgress('')
      setBusy('')
    }
  }, [call, checked, refreshAll])

  const batchQuote = useCallback(async () => {
    const picked = bugs.filter((bug) => checked.includes(bug.id))
    if (picked.length === 0) return
    const text = [
      `要批量处理的禅道单（共 ${picked.length} 条）：`,
      ...picked.map((bug) => referenceOf({
        ...bug,
        status: bug.resolution === '' ? '未解决' : '已解决',
        url: absoluteUrl(config?.server ?? '', bug.href),
      })),
      '',
      '请逐个给出处理建议；需要改单时先用 zentao_bug_context 读最新详情，再走 zentao_resolve_bug（先 dryRun）。',
    ].join('\n')
    try {
      await deps.handlePrompt(text)
      setFlash(`已把 ${picked.length} 条引用发到新会话`)
    } catch (problem) {
      setError((problem as Error).message)
    }
  }, [bugs, checked, config?.server, deps])

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
    onClick: () => {
      // The tab doubles as the sidebar entry: clicking it opens the workbench in
      // the native right sidebar when this host has one, and only falls back to
      // the floating drawer otherwise.
      if (deps.openInSidebar?.() === true) return
      setOpen((value) => !value)
    },
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

  // The sidebar entry now really works (guide registered → the tab is there), so
  // the floating surface steps aside: one entry, not two. It still exists for a
  // host without a sidebar service, where the tab doubles as open/close.
  if (!inline && deps.hasSidebar?.() === true) return null
  if (!open && !inline) return entry

  const authenticated = config?.authenticated === true
  /**
   * The panel has no header: the title was noise (the sidebar tab already says
   * 「禅道」), the close button duplicated the tab's own close control, and the
   * connection state now lives in the footer with the rest of the meta.
   *
   * The stylesheet element lives here instead of in a header wrapper — it must
   * stay in the tree, and dropping the header would otherwise take it with it.
   */
  const panelStyle = createElement('style', { 'data-zentao-style': '1', dangerouslySetInnerHTML: { __html: PANEL_CSS } }, null)

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
        className: tab === value ? 'zt-tab zt-tab-on' : 'zt-tab',
        // 样式（hover/选中态）在 PANEL_CSS 里，内联样式表达不了。
        style: { cursor: 'pointer' },
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

    if (tab === 'bugs') body.push(createElement('div', { key: 'search', className: 'zt-search' },
      // Vector, not the ⌕ glyph: the glyph's size varies with the system font and
      // could not be enlarged cleanly (user asked for a bigger icon).
      createElement('svg', {
        className: 'zt-search-icon',
        viewBox: '0 0 16 16',
        width: 17,
        height: 17,
        'aria-hidden': 'true',
        focusable: 'false',
      },
        createElement('circle', { cx: 6.8, cy: 6.8, r: 4.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }, null),
        createElement('line', { x1: 10.4, y1: 10.4, x2: 14.2, y2: 14.2, stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }, null)),
      createElement('input', {
        'data-zentao-search': '1',
        // Local filter over the page already fetched: the list endpoint rejects
        // server-side keyword params (measured: keywords=/title= → 0 rows).
        placeholder: '搜索 单号 / 标题 / 类型 / 级别 / 指派给…',
        value: search,
        onChange: (event: { target: { value: string } }) => setSearch(event.target.value),
        // Esc is the reflex for "get me out of this filter" — it clears, not blurs.
        onKeyDown: (event: { key?: string }) => { if (event.key === 'Escape') setSearch('') },
      }),
      // The hit count belongs next to what produced it, not in the toolbar below.
      search.trim() === ''
        ? null
        : createElement('span', { className: 'zt-chip', title: '命中 / 本页总数' }, `${visibleBugs.length}/${bugs.length}`),
      search.trim() === ''
        ? null
        : createElement('button', {
            type: 'button',
            'data-zentao-action': 'clear-search',
            className: 'zt-search-clear',
            title: '清空搜索（Esc）',
            onClick: () => setSearch(''),
          }, '✕')))

    if (tab === 'bugs') {
      const sortField = orderBy.split('_')[0] ?? 'id'
      const sortAsc = orderBy.endsWith('_asc')
      const sortLabel = (field: string): string => field === 'id'
        ? 'ID'
        : field === 'openedDate' ? '创建时间' : field === 'severity' ? '级别' : '优先级'
      // 级别/优先级 "升序" 在这台实例上表示"高的在前"，tooltip 里说明白，免得误导。
      const dirHint = sortField === 'severity' || sortField === 'pri'
        ? (sortAsc ? '高 → 低' : '低 → 高')
        : (sortAsc ? '旧 → 新' : '新 → 旧')
      const allOn = visibleBugs.length > 0 && visibleBugs.every((bug) => checked.includes(bug.id))
      body.push(createElement('div', { key: 'toolbar', className: 'zt-toolbar' },
        createElement('select', {
          'data-zentao-scope': '1',
          className: 'zt-field',
          title: '范围：我的 Bug，或某个项目里的 Bug',
          value: scope,
          onChange: (event: { target: { value: string } }) => setScope(event.target.value === 'project' ? 'project' : 'mine'),
        },
          createElement('option', { value: 'mine' }, '我的 Bug'),
          createElement('option', { value: 'project' }, '项目')),
        scope === 'project'
          ? createElement('select', {
              'data-zentao-project': '1',
              className: 'zt-field',
              title: '选择项目（列表来自禅道项目索引）',
              value: projectID,
              onChange: (event: { target: { value: string } }) => setProjectID(event.target.value),
              style: { flex: 1, minWidth: 120 },
            },
            createElement('option', { value: '' }, projects.length === 0 ? '（加载项目…）' : '选择项目…'),
            ...projects.map((project) => createElement('option', { key: project.id, value: project.id }, `${project.name}（${project.id}）`)))
          : null,
        createElement('select', {
          className: 'zt-field',
          title: '只看未解决，或全部',
          value: only,
          onChange: (event: { target: { value: string } }) => setOnly(event.target.value as 'all' | 'open'),
        },
          createElement('option', { value: 'open' }, '未解决'),
          createElement('option', { value: 'all' }, '全部')),
        // 排序拆成"字段 + 方向"：原来 8 个选项里一半是同字段的另一个方向，
        // 选起来费眼；方向按钮还能一眼看出当前朝哪边。
        createElement('select', {
          'data-zentao-sort': '1',
          className: 'zt-field',
          title: '排序字段（服务端排序，值经宿主白名单校验）',
          value: sortField,
          onChange: (event: { target: { value: string } }) => setOrderBy(`${event.target.value}_${sortAsc ? 'asc' : 'desc'}`),
        },
          ...['id', 'openedDate', 'severity', 'pri'].map((field) =>
            createElement('option', { key: field, value: field }, sortLabel(field)))),
        createElement('button', {
          type: 'button',
          'data-zentao-action': 'sort-dir',
          className: 'zt-btn',
          title: `排序方向：${dirHint}（点击切换）`,
          onClick: () => setOrderBy(`${sortField}_${sortAsc ? 'desc' : 'asc'}`),
        }, sortAsc ? '↑' : '↓'),
        createElement('select', {
          className: 'zt-field',
          title: '自动刷新间隔',
          value: String(intervalMin),
          onChange: (event: { target: { value: string } }) => setIntervalMin(Number(event.target.value)),
        },
          createElement('option', { value: '1' }, '1 分钟'),
          createElement('option', { value: '5' }, '5 分钟'),
          createElement('option', { value: '15' }, '15 分钟'),
          createElement('option', { value: '30' }, '30 分钟'),
          createElement('option', { value: '0' }, '不自动')),
        createElement('span', { className: 'zt-toolbar-note' },
          [
            scope === 'project' && bugsTotal.projectName !== undefined ? `项目【${bugsTotal.projectName}】` : '',
            bugsTotal.truncated ? `共 ${bugsTotal.total} 条，仅显示前 ${bugs.length}` : '',
          ].filter((part) => part !== '').join(' · ')),
        createElement('label', {
          className: allOn ? 'zt-checkall zt-checkall-on' : 'zt-checkall',
          title: '全选/取消当前可见的行',
        },
          createElement('input', {
            type: 'checkbox',
            'data-zentao-check-all': '1',
            checked: allOn,
            onChange: () => {
              const ids = visibleBugs.map((bug) => bug.id)
              const allIn = ids.every((id) => checked.includes(id))
              setChecked(allIn ? checked.filter((id) => !ids.includes(id)) : [...new Set([...checked, ...ids])])
            },
          }),
          createElement('span', null, allOn ? '已全选' : '全选')),
        createElement('button', {
          type: 'button',
          'data-zentao-action': 'refresh',
          className: 'zt-btn',
          title: `刷新状态、列表、详情与计划（自动刷新：${intervalMin === 0 ? '关闭' : `${intervalMin} 分钟`}）`,
          onClick: () => void refreshAll(true),
        }, busy === 'all' || busy === 'bugs' ? '↻ 刷新中…' : '↻ 刷新')))
    }

    if (tab === 'bugs' && checked.length > 0) {
      body.push(createElement('div', {
        key: 'batch',
        'data-zentao-batch': '1',
        className: 'zt-batch',
      },
      // Short labels + tooltips: four long labels wrapped onto two lines in a
      // 384px pane, pushing the list down every time something was ticked.
      createElement('span', { className: 'zt-batch-count' }, `已选 ${checked.length}`),
      createElement('button', { type: 'button', className: 'zt-btn', 'data-zentao-action': 'batch-preview', title: '批量预览：对每条跑一次解决计划（只读，不提交），汇总哪些可提交、哪些被拦', onClick: () => void batchPreview() }, '预览'),
      createElement('button', { type: 'button', className: 'zt-btn zt-btn-primary', 'data-zentao-action': 'batch-resolve', title: '批量解决：逐条提交（会二次确认并列出单号；每条都回读状态确认）', onClick: () => void batchResolve() }, '解决'),
      createElement('button', { type: 'button', className: 'zt-btn', 'data-zentao-action': 'batch-quote', title: '批量引用到会话：新建一个会话，把这 N 条的引用一起发过去（不写禅道）', onClick: () => void batchQuote() }, '引用'),
      batchProgress === '' ? null : createElement('span', { className: 'zt-chip' }, batchProgress),
      createElement('button', {
        type: 'button',
        className: 'zt-batch-clear',
        'data-zentao-action': 'batch-clear',
        title: '清空选择',
        onClick: () => setChecked([]),
      }, '✕')))
    }

    if (tab === 'bugs') {
      // The list owns every remaining pixel; the detail is an overlay laid on top
      // of it (it used to be a 260px list with the card squeezed underneath, which
      // left most of the drawer empty).
      // `selected` is narrowed here too: the submit handler below reads its id,
      // and this section is only ever rendered inside the detail overlay.
      // Actions first: the card is opened to act on the bug, so they sit at the
      // top of the body instead of below the description and history.
      const detailActions = selected === null ? null : createElement('div', { 'data-zentao-detail-actions': '1',
        style: { position: 'sticky', top: 0, zIndex: 2, padding: '8px 12px', borderBottom: `1px solid ${TOKEN.line}`,
                 background: TOKEN.bg } },
        createElement('div', { className: 'zt-actions' },
          createElement('button', { type: 'button', draggable: true, className: 'zt-btn', style: { cursor: 'grab' }, onDragStart: (event: { dataTransfer?: { setData(t: string, v: string): void } }) => event.dataTransfer?.setData('text/plain', referenceOf(selected.bug)) }, '拖我引用'),
          createElement('button', { type: 'button', className: 'zt-btn', onClick: () => void insert(referenceOf(selected.bug), '引用') }, '复制引用'),
          createElement('button', {
            type: 'button',
            'data-zentao-action': 'plan',
            title: '第 1 步：按表单默认值生成解决计划（只读，不会提交）',
            onClick: () => void previewPlan(selected.bug.id),
            className: 'zt-btn zt-btn-primary',
          }, busy === 'plan' ? '生成中…' : '① 预览解决计划'),
          // 「一键修复」 is the one people press most, so it leads and is styled as
          // the primary action of the card.
          createElement('button', {
            type: 'button',
            'data-zentao-action': 'one-click-fix',
            title: '新建会话并把这条 Bug 连同「复现→定位→最小修复→自测→先 dryRun 再提交」的提示词一次发出',
            className: 'zt-btn zt-btn-primary',
            onClick: async () => {
              const preset = ROLE_PRESETS.find((role) => role.key === 'fix')!
              try {
                await deps.handlePrompt(preset.prompt(referenceOf(selected.bug)))
                setFlash('已新建会话并发出修复请求')
              } catch (problem) {
                setError((problem as Error).message)
              }
            },
          }, '🚀 一键修复'),
        
          ...ROLE_PRESETS.filter((role) => role.key !== 'fix').map((role) => createElement('button', {
            key: role.key,
            type: 'button',
            // Each one opens a NEW conversation in the current workspace and sends
            // the bug reference plus that role's preset prompt — nothing is written
            // to ZenTao.
            title: `新建一个会话，把这条 Bug 的引用 + 「${role.label}」视角的预设提示词发过去（只开对话，不改单）`,
            className: 'zt-btn',
            onClick: async () => {
              try {
                await deps.handlePrompt(role.prompt(referenceOf(selected.bug)))
                setFlash(`已按「${role.label}」起会话`)
              } catch (problem) {
                setError((problem as Error).message)
              }
            },
          }, `处理·${role.label}`))),)

      const planSection = plan === null || selected === null ? null : createElement('div', {
        key: 'plan',
        style: { borderTop: `1px solid ${TOKEN.line}`, marginTop: 12, paddingTop: 10 },
      },
          createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, plan.blocked ? '解决计划（被拦，不能提交）' : '解决计划（预览，未提交）'),
          ...plan.fields.map(([name, value]) => createElement('div', { key: name, style: { fontSize: 12, display: 'flex', gap: 6 } },
            createElement('span', { style: { color: TOKEN.dim, minWidth: 108 } }, name),
            richValue(value))),
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
      // Back is a pill with an icon slot, the id is a mono chip and the title
      // truncates: the old plain-text button read as a stray label.
      createElement('button', {
        type: 'button',
        'data-zentao-action': 'close-detail',
        className: 'zt-back',
        title: '返回列表',
        onClick: () => { setSelected(null); setPlan(null) },
      },
        createElement('span', { className: 'zt-back-arrow', 'aria-hidden': 'true' }, '←'),
        createElement('span', null, '返回')),
      createElement('span', { className: 'zt-id zt-chip' }, `#${selected.bug.id}`),
      createElement('span', { style: { flex: 1, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, selected.bug.title)),
      createElement('div', { style: { padding: '10px 12px' } },
        createElement('div', { style: { color: TOKEN.dim, fontSize: 12, margin: '4px 0', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          severityBadge(selected.bug.severity || '', selected.bug.severityLevel),
          priBadge((selected.bug as { pri?: string }).pri ?? ''),
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
        detailActions,
        createElement('div', { className: 'zt-chips' },
          createElement('span', { className: 'zt-chip zt-chip-warn', title: '服务端必填项数量' },
            `必填 ${selected.resolve.fields.filter((field) => field.required).length}`),
          ...selected.resolve.fields.filter((field) => field.required).map((field) =>
            createElement('span', { key: field.name, className: 'zt-chip' }, field.label)),
          createElement('span', { className: 'zt-chip', title: '下拉规模：解决版本 / Bug所属人 / 指派给' },
            `下拉 ${selected.resolve.optionCounts.resolvedBuild}/${selected.resolve.optionCounts.bugInchargedBy}/${selected.resolve.optionCounts.assignedTo}`)),
        ...(richDescription.trim() === ''
          ? []
          : [createElement('div', { key: 'desc', style: { marginTop: 8 } },
              createElement('div', { style: { color: TOKEN.dim, fontSize: 11, marginBottom: 2 } }, '描述（富文本，图片已内联）'),
              createElement('div', {
                // Sanitised host-side (scripts/handlers/javascript: removed) and
                // rendered as HTML so tables, lists and screenshots show properly.
                'data-zentao-description': '1',
                dangerouslySetInnerHTML: { __html: richDescription },
                className: 'zt-desc',
              }, null))]),
        ...(selected.histories.length > 0
          ? [createElement('div', { key: 'hist', className: 'zt-hist' },
              createElement('div', { style: { fontSize: 11, marginBottom: 2, opacity: .8 } }, '最近动态'),
              ...selected.histories.map((line, index) => createElement('div', {
                key: index,
                // Rendered, not escaped: the host already stripped scripts and
                // handlers, and the point is that a diff's markup shows as markup.
                dangerouslySetInnerHTML: { __html: `· ${line}` },
                style: { marginBottom: 2 },
              }, null)))]
          : []),
        createElement('div', { style: { color: TOKEN.dim, fontSize: 11, marginTop: 8 } },
          '要解决这条 Bug：点「① 预览解决计划」看清将要提交的字段，再点「② 确认并提交解决」（会二次确认）。'),
      planSection))

      body.push(createElement('div', { key: 'content', style: { position: 'relative', flex: 1, minHeight: 0 } },
        createElement('div', {
          key: 'list',
          'data-zentao-list': '1',
          style: { position: 'absolute', inset: 0, overflowY: 'auto' },
        },
      ...(visibleBugs.length > 0 ? [] : [createElement('div', { key: 'empty', className: 'zt-empty' },
        search.trim() === ''
          ? (bugs.length === 0 ? '没有取到 Bug（检查登录状态或范围）' : '这一页没有符合条件的 Bug')
          : `没有匹配「${search.trim()}」的 Bug`)]),
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
        className: checked.includes(bug.id) ? 'zt-row zt-row-on' : 'zt-row',
      },
      createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        createElement('input', {
          type: 'checkbox',
          'data-zentao-check': bug.id,
          title: '勾选以批量处理',
          checked: checked.includes(bug.id),
          // The row itself opens the detail; ticking must not do that too.
          onClick: (event: { stopPropagation?: () => void }) => event.stopPropagation?.(),
          onChange: () => toggleChecked(bug.id),
          style: { cursor: 'pointer', margin: 0 },
        }),
        createElement('span', {
          className: bug.resolution === '' ? 'zt-dot zt-dot-open' : 'zt-dot zt-dot-done',
          title: bug.resolution === '' ? '未解决' : `已解决（${bug.resolution}）`,
        }, null),
        severityBadge(bug.severity || '', bug.severityLevel),
        priBadge(bug.pri),
        createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bug.title),
        createElement('span', { className: 'zt-chev' }, '›')),
      createElement('div', { className: 'zt-meta' },
        createElement('span', { className: 'zt-id' }, `#${bug.id}`),
        createElement('span', null, bug.type || '未分类'),
        createElement('span', null, bug.assignedTo ? `指派 ${bug.assignedTo}` : '未指派'),
        bug.resolution === '' ? null : createElement('span', { className: 'zt-ok' }, `已解决 · ${bug.resolution}`))))),
        detailOverlay))
    }
  }

  const stamp = lastUpdated === null ? '尚未刷新' : `最近更新 ${lastUpdated.toLocaleTimeString()}`
  // The footer always states the instance and the last refresh time; transient
  // messages go to the corner toast instead of replacing this line.
  const sidebarReg = deps.sidebarStatus?.()
  const footer = createElement('div', { style: { padding: '6px 12px', borderTop: `1px solid ${TOKEN.line}`, color: TOKEN.dim, fontSize: 11, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', rowGap: 4 } },
    createElement('span', {
      'data-zentao-conn': '1',
      title: '禅道连接状态与所用登录策略',
      style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
    },
      createElement('span', { style: { width: 6, height: 6, borderRadius: 999, background: authenticated ? TOKEN.ok : TOKEN.danger } }, null),
      authenticated ? `已连接 · ${config?.strategy ?? ''}` : '未连接'),
    createElement('span', { style: { flex: 1 } }, config?.server ? `实例 ${config.server}` : '未配置实例地址（server）'),
    (() => {
      // Rendered, not merely logged: this single line says how far the native
      // sidebar registration got on THIS host, instead of leaving us to guess.
      const status = sidebarReg
      if (status === undefined) return null
      // Registered state first, then the reason: "registered but never opened"
      // and "never registered" are different problems and must not read alike.
      const base = status.registered
        ? `侧边栏：已注册${status.opened ? '并已打开页签' : '（未打开）'}`
        : '侧边栏：未注册（sidebarRightTabs 未出现）'
      // Short in the bar, full text in the tooltip: the verbose version wrapped
      // the footer into a column of single characters.
      const text = status.registered ? base : '侧边栏：未注册'
      const full = status.error === undefined ? base : `${base}；${status.error}`
      return createElement('span', {
        'data-zentao-sidebar-status': '1',
        title: full,
        style: { fontSize: 11, color: status.registered ? TOKEN.dim : '#b45309' },
      }, text)
    })(),
    createElement('span', { 'data-zentao-stamp': '1' }, stamp),
    createElement('span', {
      'data-zentao-build': '1',
      title: '客户端构建时间：刷新后若这一行没变，说明页面还在跑旧代码',
      style: { opacity: .7 },
    }, `构建 ${typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__.slice(5) : '?'}`),
    sidebarReg === undefined || !sidebarReg.registered
      ? null
      : createElement('button', {
          type: 'button',
          'data-zentao-action': 'open-in-sidebar',
          // Escape hatch that does not depend on finding the guide capsule: the
          // sidebar's own navigation controller opens our page directly.
          className: 'zt-btn',
          title: '在右侧边栏里打开禅道工作台（不经过指南胶囊）',
          onClick: () => {
            if (deps.openInSidebar?.() === true) setFlash('已在侧边栏打开')
            else setError('侧边栏控制器不可用：请把面板底部那行状态发我')
          },
          style: { cursor: 'pointer', fontSize: 11, padding: '1px 6px' },
        }, '在侧边栏打开'),
    createElement('button', {
      type: 'button',
      'data-zentao-action': 'reload-ui',
      // The desktop app has NO Reload menu item and no Cmd+R binding (verified by
      // enumerating its menus with System Events), so a page could only be
      // refreshed by closing and reopening it. This is that missing affordance.
      className: 'zt-btn',
      title: '重新加载界面（等价于刷新页面；只重载浏览器半边，不动宿主进程）',
      onClick: () => {
        if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') window.location.reload()
      },
      style: { cursor: 'pointer', fontSize: 11, padding: '1px 6px' },
    }, '重载界面'))

  // Right-edge drawer, mirroring the reference plugin's `panel`.
  const panel = createElement('div', {
    'data-zentao-panel': '1',
    // Inside the sidebar the seat already provides position and size; a fixed
    // 384px drawer there would fight the host layout.
    style: inline
      ? {
          display: 'flex',
          flexDirection: 'column',
          // `flex: 1 1 auto` for a flex seat, `height: 100%` for a definite-height
          // one: a percentage alone collapses to the content height when the
          // seat's own box is indefinite (measured in the harness seat).
          flex: '1 1 auto',
          height: '100%',
          minHeight: 0,
          boxSizing: 'border-box',
          overflow: 'hidden',
          background: TOKEN.bg,
          color: TOKEN.text,
          fontFamily: 'system-ui,-apple-system,"PingFang SC",sans-serif',
          fontSize: 13,
        }
      : {
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
  }, panelStyle, createElement('div', {
    // A flex column rather than one big scroll area: the list has to own the
    // remaining height (`minHeight: 0` is what lets a flex child shrink enough
    // to scroll), while the unauthenticated view scrolls on its own.
    style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  }, ...body), footer)

  // The drawer covers the right edge, so the tab is not rendered while it is
  // open (the reference plugin leaves its fab underneath and relies on the ✕;
  // hiding it removes the overlap instead of depending on z-order).
  const fab = open || inline ? null : entry

  // Transient messages live in their own corner toast (never in the layout flow).
  const toast = flash === '' ? null : createElement('div', {
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

  // The sidebar seat measures *this* element, so the inline variant must not add
  // a wrapper: an extra div without a height collapsed the pane to its content
  // (measured: 197px inside an 820px pane).
  if (inline) {
    return toast === null
      ? panel
      : createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } }, panel, toast)
  }
  if (toast === null) return createElement('div', null, fab, panel)
  return createElement('div', null, fab, panel, toast)
}

/** Slot registration keeps a stable identity for the seat. */
export const name = 'zentao-workbench-panel'
