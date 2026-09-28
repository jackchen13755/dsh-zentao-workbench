/**
 * The resolve path, rebuilt so that one call is enough.
 *
 * Every rule here exists because of a measured way the old flow wasted a round
 * trip (all on 10.6, all documented in dsh-plugin-gap-report.md §2.1/§5.4 —
 * `session-1ac15fef` spent retry=42 on exactly this form):
 *
 *  1. `changeImpact` is required by the server, but the previous flow only sent
 *     it when the caller passed `impact` or the form already had text. When both
 *     were empty the field was **omitted**, the server answered HTTP 200 with
 *     `alert('『代码变更影响范围』不能为空。')`, and the model tried again. → We always
 *     emit a value and tell the caller it was auto-filled.
 *  2. `detail_reason` is capped at 512 code points; exceeding it rejected the
 *     whole submission. → We compress inside the same call and report by how much.
 *  3. `bugInchargedBy` / `assignedTo` are 892-option selects. → Defaults come from
 *     the form's own selection, then from the bug's assignee; never a guess.
 *  4. `resolution` / `reason` are enum selects. → The planner validates against the
 *     form's own option values and reports the allowed set on mismatch.
 *  5. A rejected submit used to cost two more page fetches. → The context is
 *     cached, so a retry costs one POST; the planner is pure and testable.
 */

import { FIELD_LABELS, RESOLVE_FIELD_RULES } from './fields.js'
import { matchBuildOptions, type SelectOption } from './parse.js'
import type { PageResult, ZenTaoSession } from './session.js'
import type { BugContext } from './zentao.js'

export interface ResolveArgs {
  resolution?: string
  reason?: string
  /** bug详细原因 (≤512 code points; longer input is compressed, not rejected). */
  detail?: string
  /** 代码变更影响范围 — auto-filled when omitted. */
  impact?: string
  comment?: string
  build?: string
  assignedTo?: string
  inChargedBy?: string
  force?: boolean
  dryRun?: boolean
}

export interface ResolvePlan {
  bugID: string
  status: string
  /** Exactly what would be POSTed, in submission order. */
  fields: Array<[string, string]>
  /** Local validation failures. A non-empty list means we never POST. */
  problems: string[]
  /** Fields the planner decided, with the reason — so a caller can object. */
  autoFilled: Record<string, string>
  /** Set when the caller's text had to be shortened to fit the server's cap. */
  compressed?: { field: string, from: number, to: number, note: string }
  /** Non-blocking observations (e.g. already resolved). */
  notes: string[]
  /** True when this plan should not be submitted as-is. */
  blocked: boolean
}

/** Curated enums, mirrored from the form so error messages can list the valid set. */
export const RESOLUTION_CODES = ['bydesign', 'duplicate', 'external', 'fixed', 'notrepro', 'postponed', 'willnotfix'] as const
export const REASON_CODES = ['codeBug', 'designBug', 'configBug', 'installBug', 'performanceBug', 'standardBug', 'securityBug', 'otherBug', 'externalReason'] as const

/** Count like PHP's `mb_strlen`: by code point, so emoji are not double-counted. */
export function charLength(value: string): number {
  return [...value].length
}

/**
 * Shorten to `max` code points at a sentence boundary when possible.
 * Returns the input untouched when it already fits.
 */
export function compressToLimit(text: string, max: number): { text: string, from: number, to: number, compressed: boolean } {
  const from = charLength(text)
  if (from <= max) return { text, from, to: from, compressed: false }
  const chars = [...text]
  const room = max - 1 // reserve one for the ellipsis
  const window = chars.slice(0, room).join('')
  const boundary = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('；'),
    window.lastIndexOf('\n'),
    window.lastIndexOf('. '),
  )
  const cut = boundary > max * 0.5 ? window.slice(0, boundary + 1) : window
  const out = `${cut.trimEnd()}…`
  return { text: out, from, to: charLength(out), compressed: true }
}

function codeSet(options: readonly SelectOption[]): Set<string> {
  return new Set(options.map((option) => option.value).filter((value) => value !== ''))
}

function pickEnum(
  supplied: string | undefined,
  fallback: string,
  allowed: Set<string>,
  label: string,
  codes: readonly string[],
  problems: string[],
): { value: string, autoFilled?: string } {
  const wanted = supplied?.trim()
  if (wanted) {
    if (allowed.size > 0 && !allowed.has(wanted)) {
      problems.push(`${label}「${wanted}」不在该表单的选项里；可用值：${[...allowed].join(' / ')}`)
      return { value: wanted }
    }
    if (allowed.size === 0 && !codes.includes(wanted)) {
      problems.push(`${label}「${wanted}」不是已知的取值；常用值：${codes.join(' / ')}`)
      return { value: wanted }
    }
    return { value: wanted }
  }
  const value = allowed.has(fallback) || allowed.size === 0 ? fallback : [...allowed][0] ?? fallback
  return { value, autoFilled: supplied === undefined ? `未指定，用「${value}」` : undefined }
}

/**
 * Build the exact field set for one resolve, filling every field the server
 * requires and the caller did not supply.
 */
export function planResolve(context: BugContext, args: ResolveArgs, options: { resolutionOptions?: SelectOption[], reasonOptions?: SelectOption[], buildOptions?: SelectOption[] } = {}): ResolvePlan {
  const problems: string[] = []
  const notes: string[] = []
  const autoFilled: Record<string, string> = {}
  const { resolve, bug } = context

  const resolution = pickEnum(args.resolution, resolve.defaults.resolution || 'fixed', codeSet(options.resolutionOptions ?? []), '解决方案', RESOLUTION_CODES, problems)
  if (resolution.autoFilled) autoFilled.resolution = resolution.autoFilled

  const reason = pickEnum(args.reason, resolve.defaults.reason || 'codeBug', codeSet(options.reasonOptions ?? []), 'Bug产生原因', REASON_CODES, problems)
  if (reason.autoFilled) autoFilled.reason = reason.autoFilled

  // 892-option selects: form's own selection first, then the bug's assignee.
  const inChargedBy = args.inChargedBy?.trim() || resolve.defaults.bugInchargedBy?.trim() || bug.assignedTo?.trim() || ''
  if (!args.inChargedBy?.trim()) {
    autoFilled.bugInchargedBy = resolve.defaults.bugInchargedBy?.trim()
      ? `取自解决表单当前选中值「${resolve.defaults.bugInchargedBy}」`
      : bug.assignedTo?.trim()
        ? `表单未选中，回退到该 Bug 的当前指派「${bug.assignedTo}」`
        : '表单与详情都没有可用的所属人（该字段服务端必填）'
  }

  const assignedTo = args.assignedTo?.trim() || resolve.defaults.assignedTo?.trim() || bug.assignedTo?.trim() || ''
  if (!args.assignedTo?.trim()) {
    autoFilled.assignedTo = resolve.defaults.assignedTo?.trim()
      ? `取自解决表单当前选中值「${resolve.defaults.assignedTo}」`
      : `回退到该 Bug 的当前指派「${bug.assignedTo || '(空)'}」`
  }

  // Rule 1: this field is required, so never let it be absent.
  const impact = args.impact?.trim() || resolve.defaults.changeImpact?.trim() || ''
  const impactValue = impact !== '' ? impact : autoImpact(context)
  if (impact === '') autoFilled.changeImpact = '服务端必填但表单为空，已自动填充最小可接受内容（有具体改动范围请覆盖）'

  let detailValue = args.detail ?? resolve.defaults.detail_reason ?? ''
  let compressed: ResolvePlan['compressed']
  if (args.detail !== undefined) {
    const limit = RESOLVE_FIELD_RULES.find((rule) => rule.name === 'detail_reason')?.max ?? 512
    const result = compressToLimit(args.detail, limit)
    detailValue = result.text
    if (result.compressed) {
      compressed = { field: 'detail_reason', from: result.from, to: result.to, note: `超过服务端上限 ${limit} 字，已在句末截断并附省略号（本次不再因超长被拒）` }
      autoFilled.detail_reason = `原文 ${result.from} 字 → 压缩到 ${result.to} 字`
    }
  }

  const buildRequested = args.build?.trim()
  let build = ''
  if (buildRequested) {
    // Accept either the dropdown's value or its display text (callers think in
    // names like "xx.1", the form posts ids like "6780").
    const buildOptions = options.buildOptions ?? []
    const exact = buildOptions.find((option) => option.value === buildRequested)
      ?? buildOptions.find((option) => option.text === buildRequested)
      ?? matchBuildOptions(buildOptions, buildRequested, 1)[0]
    if (exact) build = exact.value
    else if (buildOptions.length === 0) build = buildRequested
    else problems.push(`解决版本「${buildRequested}」在该表单的 ${buildOptions.length} 个选项里没有匹配项；可先不带 build 调用以沿用表单默认`)
  } else {
    build = resolve.defaults.resolvedBuild
    if (build) autoFilled.resolvedBuild = `沿用表单默认${resolve.defaults.resolvedBuildText ? `「${resolve.defaults.resolvedBuildText}」` : ''}`
  }

  const fields: Array<[string, string]> = [
    ['resolution', resolution.value],
    ['reason', reason.value],
    ['bugInchargedBy', inChargedBy],
    ['assignedTo', assignedTo],
    ['resolvedDate', resolve.defaults.resolvedDate ?? ''],
    ['uid', resolve.uid],
  ]
  if (build !== '') fields.push(['resolvedBuild', build])
  fields.push(['changeImpact', impactValue])
  if (args.detail !== undefined || detailValue !== '') fields.push(['detail_reason', detailValue])
  if (args.comment) fields.push(['comment', args.comment])

  // Required-field validation uses the page's own list (authoritative on 10.6),
  // then our rule table for the caps the page does not declare.
  const required = new Set(resolve.fields.filter((field) => field.required).map((field) => field.name))
  const submitted = new Map(fields)
  for (const name of required) {
    if (!submitted.has(name) || (submitted.get(name) ?? '') === '') {
      const label = resolve.fields.find((field) => field.name === name)?.label ?? name
      problems.push(`『${label}』(${name}) 是必填项，但计划里为空`)
    }
  }
  for (const rule of RESOLVE_FIELD_RULES) {
    const value = submitted.get(rule.name)
    if (value === undefined) continue
    if (rule.max !== undefined && charLength(value) > rule.max) {
      problems.push(`『${rule.label}』长度 ${charLength(value)} 超出上限 ${rule.max}`)
    }
  }

  if (bug.status === '已解决' && args.force !== true) {
    notes.push('该 Bug 当前已是「已解决」：默认不再提交；确需再次解决请加 force=true')
  }

  return {
    bugID: context.bug.id,
    status: bug.status,
    fields,
    problems,
    autoFilled,
    ...(compressed ? { compressed } : {}),
    notes,
    blocked: problems.length > 0 || (bug.status === '已解决' && args.force !== true),
  }
}

/** A minimal, honest placeholder for the required 影响范围 field. */
function autoImpact(context: BugContext): string {
  const product = context.bug.product || '未标注产品'
  return `本次改动影响范围：${product}（由 dsh-zentao-workbench 自动填充以满足必填校验；如有明确模块/页面请覆盖 impact 字段）`
}

export interface SubmitOutcome {
  ok: boolean
  status: string
  serverError?: string
  body?: string
  url: string
  /** Status re-read after the POST: the only proof that it worked. */
  verified: boolean
}

/**
 * POST the plan and verify by re-reading the bug's status.
 *
 * ZenTao rejects a bad submission with HTTP 200 and an `alert()`, so the status
 * code proves nothing; the re-read is what makes `ok` trustworthy.
 */
export async function submitResolve(session: ZenTaoSession, plan: ResolvePlan, context: BugContext): Promise<SubmitOutcome> {
  const url = `/index.php?m=bug&f=resolve&bugID=${encodeURIComponent(plan.bugID)}&onlybody=yes`
  const body = plan.fields
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&')
  const posted: PageResult = await session.post(url, body)
  const after = await session.get(`/index.php?m=bug&f=view&bugID=${encodeURIComponent(plan.bugID)}`)
  const status = readStatus(after.body) || context.bug.status
  if (status === '已解决') {
    return { ok: true, status, url: after.url, verified: true }
  }
  const serverError = alertMessage(posted.body)
  return {
    ok: false,
    status,
    url: after.url,
    verified: false,
    ...(serverError ? { serverError } : {}),
    body: posted.body.slice(0, 500),
  }
}

function readStatus(html: string): string {
  const m = html.match(/<th>\s*Bug状态\s*<\/th>\s*<td[^>]*>\s*<span[^>]*>([^<]*)<\/span>/)
  if (m?.[1]) return m[1].trim()
  const m2 = html.match(/<th>\s*Bug状态\s*<\/th>\s*<td[^>]*>([^<]+)<\/td>/)
  return m2?.[1]?.trim() ?? ''
}

/** ZenTao answers HTTP 200 and puts its refusal in an `alert('…')`. */
export function alertMessage(body: string): string {
  const m = /alert\(\s*(['"])([\s\S]*?)\1\s*\)/.exec(body)
  if (!m?.[2]) return ''
  return m[2].replace(/\\n/g, ' ').replace(/\\'/g, "'").replace(/\s+/g, ' ').trim()
}

/** Human-readable plan, used by the tool renderer and the CLI's `--context`. */
export function renderPlan(plan: ResolvePlan): string {
  const lines = [`Bug ${plan.bugID}（当前状态：${plan.status || '未知'}）解决计划：`]
  for (const [name, value] of plan.fields) {
    // uid / resolvedDate / assignedTo are form plumbing rather than fields a
    // caller reasons about, so they still deserve a label in the preview.
    const label = FIELD_LABELS.get(name) ?? PLUMBING_LABELS[name] ?? name
    const shown = name === 'uid' ? `${value.slice(0, 12)}…` : value
    lines.push(`  ${name.padEnd(16)} ${label.padEnd(10)} = ${shown || '(空)'}`)
  }
  for (const [name, why] of Object.entries(plan.autoFilled)) lines.push(`  ↳ ${name}：${why}`)
  if (plan.compressed) lines.push(`  ↳ ${plan.compressed.field}：${plan.compressed.note}`)
  for (const note of plan.notes) lines.push(`  ! ${note}`)
  for (const problem of plan.problems) lines.push(`  ✘ ${problem}`)
  return lines.join('\n')
}

const PLUMBING_LABELS: Record<string, string> = {
  uid: '表单标识',
  resolvedDate: '解决时间',
  assignedTo: '指派给',
  resolvedBuild: '解决版本',
}
