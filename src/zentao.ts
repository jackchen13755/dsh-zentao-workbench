/**
 * The workbench's read layer: turn the classic pages into small structured
 * facts, and — the whole point of this plugin — answer one bug with **one**
 * request that carries everything needed to fill its resolve form.
 *
 * Why compaction is the product, not a nicety (all measured on 10.6):
 *   · `resolvedBuild` holds 254 options, `bugInchargedBy`/`assignedTo` 892 each;
 *     the previous tool returned all 254 build options so a model could pick one;
 *   · a required field left empty is only revealed by the server answering HTTP
 *     200 with an `alert()`, which reads like success;
 *   · each page is large (view 56 KB, resolve form 255 KB) and the browser relay
 *     is a single-flight long poll, so every wasted attempt also serializes.
 */

import { FIELD_LABELS, RESOLVE_FIELD_RULES } from './fields.js'
import { lastResolvedBuild, matchBuildOptions, parseBugList, parseBugView, parseHistories, parseResolveForm, type BugRow, type SelectOption } from './parse.js'
import { planResolve, submitResolve, type ResolveArgs, type ResolvePlan, type SubmitOutcome } from './resolve.js'
import type { StrategyId, ZenTaoSession } from './session.js'

export { RESOLVE_FIELD_RULES } from './fields.js'

export interface MyBugsResult {
  bugs: BugRow[]
  total: number
  via: StrategyId
  url: string
  fetchedAt: string
  cached: boolean
}

export interface BugContext {
  bug: ReturnType<typeof parseBugView> & { url: string }
  resolve: {
    uid: string
    /** Field name + Chinese label + whether the page itself calls it required. */
    fields: Array<{ name: string, label: string, required: boolean, limit?: number }>
    defaults: Record<string, string>
    /** Only the options a caller asked for — never the full 254. */
    buildMatches: SelectOption[]
    /** The form's own enum options (8 / 9 entries): shipping them beats guessing. */
    resolutionOptions: Array<{ value: string, text: string }>
    reasonOptions: Array<{ value: string, text: string }>
    /** Diagnostics: how big the dropdowns are, so nobody re-adds the dump. */
    optionCounts: { resolvedBuild: number, bugInchargedBy: number, assignedTo: number }
  }
  histories: string[]
  cachedAt: string
  cached: boolean
}

export interface WorkbenchOptions {
  bugTtlMs?: number
  listTtlMs?: number
}

export class ZentaoWorkbench {
  private readonly bugTtlMs: number
  private readonly listTtlMs: number
  /** The full dropdown lives here, never in a returned context. */
  private readonly bugs = new Map<string, { at: number, value: BugContext, buildOptions: SelectOption[] }>()
  private list: { at: number, value: MyBugsResult } | null = null

  constructor(readonly session: ZenTaoSession, options: WorkbenchOptions = {}) {
    this.bugTtlMs = options.bugTtlMs ?? 10 * 60_000
    this.listTtlMs = options.listTtlMs ?? 60_000
  }

  /**
   * Build the resolve plan for a context already fetched. Pure given the inputs;
   * the raw build dropdown comes from the cache because it must never be part of
   * a returned context.
   */
  plan(context: BugContext, args: ResolveArgs): ResolvePlan {
    const entry = this.bugs.get(context.bug.id)
    return planResolve(context, args, {
      resolutionOptions: context.resolve.resolutionOptions.map((option) => ({ ...option, title: '' })),
      reasonOptions: context.resolve.reasonOptions.map((option) => ({ ...option, title: '' })),
      buildOptions: entry?.buildOptions ?? [],
    })
  }

  /** Drop one bug, or everything (call after a resolve POST). */
  invalidate(bugID?: string): void {
    if (bugID === undefined) {
      this.bugs.clear()
      this.list = null
      return
    }
    this.bugs.delete(bugID)
    this.list = null
  }

  async myBugs(options: { limit?: number, only?: 'all' | 'open' | 'resolved', refresh?: boolean } = {}): Promise<MyBugsResult> {
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 200)
    const cached = this.list !== null && !options.refresh && Date.now() - this.list.at < this.listTtlMs
    if (!cached) {
      const page = await this.session.get('/index.php?m=my&f=bug')
      const bugs = parseBugList(page.body)
      this.list = {
        at: Date.now(),
        value: {
          bugs,
          total: bugs.length,
          via: page.strategy,
          url: page.url,
          fetchedAt: new Date().toISOString(),
          cached: false,
        },
      }
    }
    const source = this.list!.value
    const only = options.only ?? 'all'
    // Open/resolved is read from the 解决 + 方案 columns (see parseBugList).
    const filtered = only === 'all'
      ? source.bugs
      : source.bugs.filter((bug) => (only === 'open' ? bug.resolution === '' && bug.resolvedBy === '' : bug.resolution !== '' || bug.resolvedBy !== ''))
    return { ...source, bugs: filtered.slice(0, limit), cached }
  }

  /**
   * One bug, one request pair (view + resolve form), everything a caller needs
   * to fill the resolve form without guessing — and nothing else.
   */
  async bugContext(bugID: string, options: { build?: string, refresh?: boolean, historyLimit?: number } = {}): Promise<BugContext> {
    const hit = this.bugs.get(bugID)
    if (!options.refresh && hit && Date.now() - hit.at < this.bugTtlMs) {
      return {
        ...hit.value,
        cached: true,
        resolve: { ...hit.value.resolve, buildMatches: options.build ? matchBuildOptions(hit.buildOptions, options.build) : [] },
      }
    }

    const view = await this.session.get(`/index.php?m=bug&f=view&bugID=${encodeURIComponent(bugID)}`)
    const form = await this.session.get(`/index.php?m=bug&f=resolve&bugID=${encodeURIComponent(bugID)}&onlybody=yes`)

    const detail = parseBugView(view.body, bugID)
    const parsed = parseResolveForm(form.body)
    // The form's own default usually wins; fall back to the newest value the
    // history mentions ("解决版本 … 新值为 …") so a re-resolve reuses it.
    const historyBuild = lastResolvedBuild(view.body)
    const buildDefault = parsed.defaults.resolvedBuild || historyBuild
    const buildText = parsed.defaults.resolvedBuild
      ? parsed.defaults.resolvedBuildText
      : parsed.buildOptions.find((option) => option.value === historyBuild)?.text ?? historyBuild

    const value: BugContext = {
      bug: { ...detail, url: view.url },
      resolve: {
        uid: parsed.uid,
        fields: [
          ...RESOLVE_FIELD_RULES.map((rule) => ({
            name: rule.name,
            label: rule.label,
            required: rule.required === true || parsed.required.includes(rule.name),
            ...(rule.max !== undefined ? { limit: rule.max } : {}),
          })),
          // Anything the page marks required that our table does not know about.
          ...parsed.required
            .filter((name) => !FIELD_LABELS.has(name))
            .map((name) => ({ name, label: name, required: true })),
        ],
        defaults: {
          resolution: parsed.defaults.resolution || 'fixed',
          reason: parsed.defaults.reason || 'codeBug',
          bugInchargedBy: parsed.defaults.bugInchargedBy,
          assignedTo: parsed.defaults.assignedTo,
          resolvedBuild: buildDefault,
          resolvedBuildText: buildText,
          resolvedDate: parsed.defaults.resolvedDate,
          detail_reason: parsed.defaults.detailReason,
          changeImpact: parsed.defaults.changeImpact,
        },
        buildMatches: options.build ? matchBuildOptions(parsed.buildOptions, options.build) : [],
        resolutionOptions: parsed.resolutionOptions.map(({ value, text }) => ({ value, text })),
        reasonOptions: parsed.reasonOptions.map(({ value, text }) => ({ value, text })),
        optionCounts: {
          resolvedBuild: parsed.buildOptionCount,
          bugInchargedBy: countOptions(form.body, 'bugInchargedBy'),
          assignedTo: countOptions(form.body, 'assignedTo'),
        },
      },
      histories: parseHistories(view.body, options.historyLimit ?? 5),
      cachedAt: new Date().toISOString(),
      cached: false,
    }
    this.bugs.set(bugID, { at: Date.now(), value, buildOptions: parsed.buildOptions })
    return value
  }
}

function withBuildMatches(resolve: BugContext['resolve'], build: string): BugContext['resolve'] {
  return { ...resolve, buildMatches: matchBuildOptions([], build) }
}

function matchesStatus(bug: BugRow, status: string): boolean {
  // The list page omits a status column on 10.6; keep the filter honest rather
  // than pretending to know. Callers that need status use `bugContext`.
  void bug
  void status
  return true
}

function countOptions(html: string, name: string): number {
  const select = html.match(new RegExp(`<select\\b[^>]*\\bname=(['"])${name}\\1[^>]*>([\\s\\S]*?)<\\/select>`))
  if (!select) return 0
  return (select[2]?.match(/<option\b/gi) ?? []).length
}

/**
 * Order-of-work note for callers: `optionCounts` exists so a human reading the
 * tool output sees *why* the context is small (254/892 options were summarised,
 * not omitted) instead of assuming the data is missing.
 */
export function describeOptionCounts(resolve: BugContext['resolve']): string {
  return `resolvedBuild ${resolve.optionCounts.resolvedBuild} 项、bugInchargedBy ${resolve.optionCounts.bugInchargedBy} 项、assignedTo ${resolve.optionCounts.assignedTo} 项（已按需收敛）`
}

export interface ResolveRun {
  plan: ResolvePlan
  outcome?: SubmitOutcome
  context: BugContext
}

/**
 * Plan a resolve and — unless it is a dry run or the plan is blocked — submit it.
 *
 * The retry story this encodes: the context is fetched once and kept on a failed
 * submit, so a corrected retry costs **one POST** instead of two page fetches.
 * The cache is dropped only after a verified success.
 */
export async function resolveBug(workbench: ZentaoWorkbench, bugID: string, args: ResolveArgs): Promise<ResolveRun> {
  const context = await workbench.bugContext(bugID, { build: args.build })
  const plan = workbench.plan(context, args)
  if (args.dryRun === true || plan.blocked) return { plan, context }
  const outcome = await submitResolve(workbench.session, plan, context)
  if (outcome.ok) workbench.invalidate(bugID)
  return { plan, outcome, context }
}
