/**
 * Parsers for the classic ZenTao pages (measured on 10.6: nginx + PHP 5.6 +
 * `index.php?m=…&f=…`). No REST: v1/v2 both bounce to the login page here.
 *
 * The value helpers (`selectedValue` / `inputValue` / `textareaValue` /
 * `extractRequiredFields`) are ported from `dsh-fetch-page`'s
 * `zentao_resolve_bug`, where they were validated against this instance; the
 * list/detail/context parsers below are new. Keeping the proven heuristics
 * verbatim matters: ZenTao marks a field required in three different places,
 * and the page's own `requiredFields` JSON is the authoritative one.
 */

/** A redirect script is how this instance answers any unauthenticated path — with HTTP 200. */
export function isLoginRedirect(html: string): boolean {
  return /self\.location\s*=\s*['"][^'"]*m=user&f=login/.test(html)
}

/** Ported: a page carrying both account and password inputs is the login form. */
export function isLoggedIn(html: string): boolean {
  const hasAccount = /name=['"]?account['"]?[\s>]/.test(html)
  const hasPassword = /name=['"]?password['"]?[\s>]/.test(html)
  return !(hasAccount && hasPassword)
}

/** The instance's session is gone if either fingerprint shows up. */
export function sessionExpired(html: string): boolean {
  return isLoginRedirect(html) || !isLoggedIn(html)
}

function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}=(['"])([\\s\\S]*?)\\1`))
  return m?.[2] ?? ''
}

function tagByName(html: string, tag: string, name: string): string {
  for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))) {
    if (new RegExp(`\\bname=(['"])${name}\\1`).test(m[0])) return m[0]
  }
  return ''
}

/** Ported. */
export function selectedValue(html: string, name: string): string {
  const select = html.match(new RegExp(`<select\\b[^>]*\\bname=(['"])${name}\\1[^>]*>([\\s\\S]*?)<\\/select>`))
  if (!select) return ''
  const options = select[2]?.match(/<option\b[^>]*>[\s\S]*?<\/option>|<option[^>]*\/?>/g) ?? []
  for (const option of options) {
    if (/\bselected\b/.test(option)) return attr(option, 'value')
  }
  return ''
}

/** Ported. */
export function inputValue(html: string, name: string): string {
  const tag = tagByName(html, 'input', name)
  return tag ? attr(tag, 'value') : ''
}

/** Ported. */
export function textareaValue(html: string, name: string): string {
  const m = html.match(new RegExp(`<textarea\\b[^>]*\\bname=(['"])${name}\\1[^>]*>([\\s\\S]*?)<\\/textarea>`, 'i'))
  return m?.[2] ?? ''
}

export interface SelectOption { value: string; text: string; title: string }

/** Ported: parse every `<option>` of one select into value/text/title. */
export function selectOptions(html: string, name: string): SelectOption[] {
  const select = html.match(new RegExp(`<select\\b[^>]*\\bname=(['"])${name}\\1[^>]*>([\\s\\S]*?)<\\/select>`))
  if (!select) return []
  const inner = select[2] ?? ''
  const optionRe = /<option\b([^>]*)>([\s\S]*?)<\/option>|<option\b([^>]*)\/>/gi
  const out: SelectOption[] = []
  let m: RegExpExecArray | null
  while ((m = optionRe.exec(inner))) {
    const attrs = m[1] ?? m[3] ?? ''
    out.push({ value: attr(attrs, 'value'), text: decodeEntities(m[2] ?? ''), title: attr(attrs, 'title') })
  }
  return out
}

/**
 * Ported: ZenTao declares required fields in three places, and the page's own
 * `requiredFields` config is authoritative. Missing one costs a round trip —
 * the server answers HTTP 200 with an `alert()` and leaves the bug untouched.
 */
export function extractRequiredFields(html: string): string[] {
  const set = new Set<string>()
  const cfg = html.match(/requiredFields":\s*"([^"]*)"/)
  if (cfg?.[1]) for (const field of cfg[1].split(',')) if (field) set.add(field.trim())
  for (const m of html.matchAll(/<td\b[^>]*\bclass=(["'])[^"']*\brequired\b[^"']*\1[^>]*>[\s\S]*?<(?:select|input|textarea)\b[^>]*\bname=(["'])([^"']+)\2/g)) {
    if (m[3]) set.add(m[3])
  }
  for (const m of html.matchAll(/<(?:select|input|textarea)\b[^>]*\bname=(["'])([^"']+)\1[^>]*\bclass=(["'])[^"']*\brequired\b[^"']*\3/g)) {
    if (m[2]) set.add(m[2])
  }
  for (const m of html.matchAll(/<(?:select|input|textarea)\b[^>]*\bclass=(["'])[^"']*\brequired\b[^"']*\1[^>]*\bname=(["'])([^"']+)\2/g)) {
    if (m[3]) set.add(m[3])
  }
  return [...set]
}

/** Ported: the resolve form's `uid` is a JS variable, not the input's value. */
export function resolveUid(html: string): string {
  const m = html.match(/var kuid\s*=\s*'([^']+)'/) ?? html.match(/var kuid\s*=\s*"([^"]+)"/)
  return m?.[1] || inputValue(html, 'uid')
}

// --- my bug list ------------------------------------------------------------

/**
 * `data-severity='3'` inside the severity badge, when the markup carries it.
 *
 * Colouring by the numeric level instead of the label survives an instance that
 * renames its levels (measured: this one shows 主要/次要 while the attribute
 * still says 3/4).
 */
export function severityLevelOf(cellHtml: string): number | null {
  const m = /data-severity=(['"])(\d+)\1/.exec(cellHtml)
  if (m?.[2] === undefined) return null
  const level = Number(m[2])
  return Number.isFinite(level) ? level : null
}

export interface BugRow {
  id: string
  severity: string
  /**
   * Numeric severity from the badge's `data-severity` attribute (1..N), or null
   * when the markup lacks it. Colouring by this instead of the label text keeps
   * working when an instance renames its levels (measured: this one shows
   * 主要/次要 while the attribute still says 3/4).
   */
  severityLevel: number | null
  pri: string
  type: string
  title: string
  openedBy: string
  assignedTo: string
  /** '…/index.php?m=bug&f=view&bugID=N' as published by the page. */
  href: string
  /** 解决 column: empty until the bug is resolved. */
  resolvedBy: string
  /** 方案 column: the resolution code shown after resolving; empty while open. */
  resolution: string
}

/**
 * `GET /index.php?m=my&f=bug` → `<table id="bugList">`.
 *
 * Columns: ID | 级别 | P | 类型 | Bug标题 | 创建 | 指派给 | 解决 | 方案 | 操作.
 * The id lives in a `bugIDList[]` checkbox, not in a `data-id` or `id` attribute
 * (measured: neither exists on 10.6), so rows are selected by that checkbox.
 */
export function parseBugList(html: string): BugRow[] {
  const table = html.match(/<table[^>]*\bid=(['"])bugList\1[^>]*>([\s\S]*?)<\/table>/)
  if (!table) return []
  const rows: BugRow[] = []
  for (const row of table[2]?.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g) ?? []) {
    const cells = [...(row[1] ?? '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? '')
    if (cells.length < 7) continue
    const id = (cells[0]?.match(/name=(['"])bugIDList\[\]\1[^>]*\bvalue=(['"])(\d+)\2/) ?? [])[3]
      ?? (cells[0]?.match(/\bvalue=(['"])(\d+)\1/) ?? [])[2]
    if (!id) continue
    const anchor = cells[4]?.match(/<a\b[^>]*\bhref=(['"])([^'"]+)\1[^>]*>([\s\S]*?)<\/a>/)
    rows.push({
      id,
      severity: attr(cells[1] ?? '', 'title') || decodeEntities(cells[1] ?? ''),
      severityLevel: severityLevelOf(cells[1] ?? ''),
      pri: attr(cells[2] ?? '', 'title') || decodeEntities(cells[2] ?? ''),
      type: attr(cells[3] ?? '', 'title') || decodeEntities(cells[3] ?? ''),
      title: decodeEntities(anchor?.[3] ?? cells[4] ?? ''),
      openedBy: decodeEntities(cells[5] ?? ''),
      assignedTo: attr(cells[6] ?? '', 'title') || decodeEntities(cells[6] ?? ''),
      href: anchor?.[2] ?? '',
      // The list page has no dedicated status column: an open bug leaves both
      // 解决 (cells[7]) and 方案 (cells[8]) empty, so their emptiness is the
      // only open/resolved signal available without a second request.
      resolvedBy: decodeEntities(cells[7] ?? ''),
      resolution: decodeEntities(cells[8] ?? ''),
    })
  }
  return rows
}

/**
 * The pager's own record count — the authoritative total for a list page.
 *
 * Measured on 10.6: `<ul class='pager' data-rec-total='29' data-rec-per-page='1000' …>`.
 * Without it a caller can only report how many rows this page carried, which
 * silently becomes "the page size" the day the instance paginates.
 */
export function parseListTotal(html: string): number | null {
  const m = html.match(/data-rec-total=(['"])(\d+)\1/)
  if (!m?.[2]) return null
  const value = Number(m[2])
  return Number.isFinite(value) ? value : null
}

// --- project task list ------------------------------------------------------

export interface TaskRow {
  id: string
  name: string
  status: string
  assignedTo: string
  href: string
}

/** Measured marker on 10.6 when a project has no tasks. */
export function taskListEmpty(html: string): boolean {
  return html.includes('暂时没有任务')
}

/**
 * `GET /index.php?m=project&f=task[&projectID=N]`
 *
 * VERIFICATION STATUS — read before trusting this:
 *   · the route, its filters and the empty-state marker are measured on the
 *     live instance (8 projects probed, every one empty);
 *   · the instance has **no task rows at all**, so the row branch below has
 *     never run against real markup. It mirrors the measured bug-list shape
 *     (`taskIDList[]` checkbox in the first cell, `<a href=…taskID=N>` for the
 *     name) and returns [] when that shape is absent, so a different layout
 *     degrades to "no tasks" instead of inventing one.
 */
export function parseTaskList(html: string): TaskRow[] {
  if (taskListEmpty(html)) return []
  const table = html.match(/<table[^>]*\bid=(['"])taskList\1[^>]*>([\s\S]*?)<\/table>/)
  const scope = table?.[2] ?? html
  const rows: TaskRow[] = []
  for (const row of scope.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(row[1] ?? '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? '')
    if (cells.length < 4) continue
    const id = (cells[0]?.match(/name=(['"])taskIDList\[\]\1[^>]*\bvalue=(['"])(\d+)\2/) ?? [])[3]
      ?? (cells[0]?.match(/\bvalue=(['"])(\d+)\1/) ?? [])[2]
    if (!id) continue
    const anchor = cells.find((cell) => /taskID=\d+/.test(cell))?.match(/<a\b[^>]*\bhref=(['"])([^'"]+)\1[^>]*>([\s\S]*?)<\/a>/)
    rows.push({
      id,
      name: decodeEntities(anchor?.[3] ?? cells[1] ?? ''),
      status: decodeEntities(cells[2] ?? ''),
      assignedTo: attr(cells[3] ?? '', 'title') || decodeEntities(cells[3] ?? ''),
      href: anchor?.[2] ?? '',
    })
  }
  return rows
}

// --- bug detail -------------------------------------------------------------

export interface BugDetail {
  id: string
  title: string
  /** Extracted from `<title>BUG #N title - product - 禅道`; empty when the shape differs. */
  product: string
  status: string
  severity: string
  /** Numeric rank behind the severity badge, when the page carries it. */
  severityLevel: number | null
  pri: string
  assignedTo: string
  /** 解决版本 / 解决方案 as shown on the detail page — non-empty once resolved. */
  resolvedBuild: string
  solution: string
}

/** Ported status probe: `<th>Bug状态</th><td><span>…</span></td>`. */
export function currentStatus(html: string): string {
  const m = html.match(/<th>\s*Bug状态\s*<\/th>\s*<td[^>]*>\s*<span[^>]*>([^<]*)<\/span>/)
  if (m?.[1]) return m[1].trim()
  const m2 = html.match(/<th>\s*Bug状态\s*<\/th>\s*<td[^>]*>([^<]+)<\/td>/)
  return m2?.[1]?.trim() ?? ''
}

/** Ported: the newest `解决版本 … 旧值为 "x"，新值为 "y"` row in the history. */
export function lastResolvedBuild(html: string): string {
  const re = /解决版本[\s\S]{0,300}?旧值为\s*["']([^"']*)["']\s*，\s*新值为\s*["']([^"']*)["']/g
  let build = ''
  for (const m of html.matchAll(re)) if (m[2]) build = m[2]
  return build
}

function labelledField(html: string, label: string): string {
  const span = html.match(new RegExp(`<th>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]{0,400}?)</td>`))
  return span ? decodeEntities(span[1] ?? '') : ''
}

export function parseBugView(html: string, bugID: string): BugDetail {
  const titleTag = decodeEntities(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
  // "BUG #55036 标题 - 产品名 - 禅道"
  const parts = titleTag.split(/\s+-\s+/)
  const head = parts[0] ?? ''
  const title = head.replace(new RegExp(`^BUG\\s*#${bugID}\\s*`), '').trim()
  // Measured labels on 10.6: 优先级 / Bug状态 / 当前指派 / 解决版本 / 解决方案.
  // 当前指派 reads "Dev One 于 2026-08-18 16:27:16" — keep only the name.
  const assignee = labelledField(html, '当前指派').replace(/\s*于\s*\d{4}-\d{2}-\d{2}[\s\S]*$/, '').trim()
  return {
    id: bugID,
    title,
    product: parts.length >= 3 ? (parts[1] ?? '').trim() : '',
    status: currentStatus(html),
    severity: attr(html.match(/<span[^>]*class=(['"])[^'"]*label-severity[^'"]*\1[^>]*>/)?.[0] ?? '', 'title'),
    // Same numeric rank the list badge carries, so both views colour alike.
    severityLevel: severityLevelOf(html.match(/<span[^>]*class=(['"])[^'"]*label-severity[^'"]*\1[^>]*>[\s\S]{0,200}?<\/span>/)?.[0] ?? ''),
    pri: labelledField(html, '优先级'),
    assignedTo: assignee,
    resolvedBuild: labelledField(html, '解决版本'),
    solution: labelledField(html, '解决方案'),
  }
}

/**
 * `GET /index.php?m=bug&f=view&bugID=N` keeps its history in
 * `<ol class="histories-list">` with one `<li>` per action; the actor's name is
 * wrapped in `<strong>`, so tags must be stripped before the text is usable.
 * Newest entries are last. Returns the newest `limit` entries in page order.
 */
export function parseHistories(html: string, limit = 5): string[] {
  const list = html.match(/<ol\b[^>]*class=(['"])[^'"]*histories-list[^'"]*\1[^>]*>([\s\S]*?)<\/ol>/)
  if (!list) return []
  const items = [...(list[2] ?? '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)]
    .map((m) => decodeEntities(m[1] ?? ''))
    .filter((text) => text !== '')
  return items.slice(-limit)
}

// --- resolve form -----------------------------------------------------------

export interface ResolveForm {
  uid: string
  required: string[]
  defaults: {
    resolution: string
    reason: string
    bugInchargedBy: string
    assignedTo: string
    resolvedBuild: string
    resolvedBuildText: string
    resolvedDate: string
    detailReason: string
    changeImpact: string
  }
  /** Every option of `resolvedBuild` — filtered before it reaches a model. */
  buildOptions: SelectOption[]
  /** The form's own option count, for diagnostics ("254 options, 1 matched"). */
  buildOptionCount: number
  /** Enum selects are small (8 / 9), so their codes ship with the context
   *  instead of being guessed — a wrong code costs a whole round trip. */
  resolutionOptions: SelectOption[]
  reasonOptions: SelectOption[]
}

export function parseResolveForm(html: string): ResolveForm {
  const buildOptions = selectOptions(html, 'resolvedBuild')
  const selectedBuild = selectedValue(html, 'resolvedBuild')
  return {
    uid: resolveUid(html),
    required: extractRequiredFields(html),
    defaults: {
      resolution: selectedValue(html, 'resolution'),
      reason: selectedValue(html, 'reason'),
      bugInchargedBy: selectedValue(html, 'bugInchargedBy'),
      assignedTo: selectedValue(html, 'assignedTo'),
      resolvedBuild: selectedBuild,
      resolvedBuildText: buildOptions.find((o) => o.value === selectedBuild)?.text ?? '',
      resolvedDate: inputValue(html, 'resolvedDate'),
      detailReason: textareaValue(html, 'detail_reason'),
      changeImpact: textareaValue(html, 'changeImpact'),
    },
    buildOptions,
    buildOptionCount: buildOptions.length,
    resolutionOptions: selectOptions(html, 'resolution'),
    reasonOptions: selectOptions(html, 'reason'),
  }
}

/**
 * Narrow the build dropdown to what a caller actually asked for.
 *
 * This is the single biggest token win of the whole plugin: the dropdown holds
 * 254 options on the measured instance, and the previous tool shipped all of
 * them into the tool result so the model could pick one. Match by exact value,
 * exact text, then case-insensitive prefix/substring.
 */
export function matchBuildOptions(options: readonly SelectOption[], query: string, limit = 10): SelectOption[] {
  const needle = query.trim()
  if (needle === '') return []
  const byValue = options.filter((o) => o.value === needle)
  if (byValue.length) return byValue.slice(0, limit)
  const byText = options.filter((o) => o.text === needle)
  if (byText.length) return byText.slice(0, limit)
  const lower = needle.toLowerCase()
  const loose = options.filter((o) => o.text.toLowerCase().includes(lower) || o.title.toLowerCase().includes(lower))
  return loose.slice(0, limit)
}
