/**
 * Model-facing tools.
 *
 * Two rules shape every tool here:
 *  1. a failure caused by an expired session returns the actionable strategy
 *     report (what each login path observed + what to do next), never a bare
 *     "未登录" — the session dies routinely, and the model cannot fix what it
 *     cannot see;
 *  2. the resolve tool plans before it posts and reports what it auto-filled, so
 *     a rejected submission costs one POST to retry rather than a fresh
 *     investigation of the form.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { matchBuildOptions } from './parse.js'
import { renderPlan, type ResolveArgs } from './resolve.js'
import { ZenTaoAuthError, renderStatus, type SessionStatus, type ZenTaoSession } from './session.js'
import { describeOptionCounts, resolveBug, ZentaoWorkbench, type BugContext } from './zentao.js'

export interface ToolDeps {
  session: ZenTaoSession
  workbench: ZentaoWorkbench
  /** Injected by tests; defaults to the real implementations. */
  resolve?: typeof resolveBug
  /**
   * Why the panel transport is (or is not) registered.
   *
   * Reported by `zentao_session_status` on purpose: the registration failing
   * silently is exactly what made a 405 look like a login problem for two
   * rounds, and a tool call is the cheapest way to see the truth.
   */
  panelTransport?: () => string
}

type Rendered = Array<{ type: 'text', text: string }>

function text(value: string): Rendered {
  return [{ type: 'text', text: value }]
}

/** Turn an auth failure into the strategy report a caller can act on. */
function authFailure(error: unknown): { text: string } | null {
  if (error instanceof ZenTaoAuthError) {
    return {
      text: [
        error.message,
        renderStatus(error.status),
        '按上面每条策略的提示处理（例如让浏览器登录禅道，或重新导出 cookie jar），完成后重试本工具。',
      ].join('\n'),
    }
  }
  return null
}

function contextSummary(context: BugContext): string {
  const { bug, resolve } = context
  const lines = [
    `Bug ${bug.id}｜${bug.title}`,
    `  产品 ${bug.product || '(未知)'}｜状态 ${bug.status || '(未知)'}｜优先级 ${bug.pri || '-'}｜当前指派 ${bug.assignedTo || '-'}`,
    `  解决版本 ${bug.resolvedBuild || '(空)'}｜解决方案 ${bug.solution || '(空)'}`,
    `  解决表单：uid ${resolve.uid ? '已解析' : '**缺失**'}｜必填 ${resolve.fields.filter((f) => f.required).map((f) => f.label).join('、')}`,
    `  默认值：${Object.entries(resolve.defaults).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join('  ')}`,
    `  选项规模：${describeOptionCounts(resolve)}`,
    `  解决方案可选：${resolve.resolutionOptions.map((o) => o.value).join(' / ') || '(未解析到)'}`,
    `  Bug产生原因可选：${resolve.reasonOptions.map((o) => o.value).join(' / ') || '(未解析到)'}`,
  ]
  if (resolve.buildMatches.length > 0) {
    lines.push(`  版本匹配：${resolve.buildMatches.map((o) => `${o.text}(${o.value})`).join('、')}`)
  }
  if (context.histories.length > 0) {
    lines.push('  最近动态：')
    for (const item of context.histories) lines.push(`    · ${item}`)
  }
  if (context.cached) lines.push('  （来自缓存；需要最新数据请加 refresh=true）')
  return lines.join('\n')
}

export function createTools(deps: ToolDeps): unknown[] {
  const { session, workbench } = deps
  const runResolve = deps.resolve ?? resolveBug

  return [
    defineTool({
      name: 'zentao_session_status',
      description: '查看禅道（经典 index.php 实例）的登录态：四条路径（浏览器插件桥 / Chrome cookie 导出 / 表单账密 / 手工注入）各自探测到什么、下一步该做什么。任何其它禅道工具报未登录时，用它确认原因。',
      parameters: {
        refresh: { type: 'boolean', description: '绕过 30 秒缓存，立即重新探测' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
        render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
      },
      async execute(args): Promise<{ text: string }> {
        const status = await session.status((args as { refresh?: boolean }).refresh === true)
        const transport = deps.panelTransport?.() ?? '（未上报）'
        // The panel's transport belongs in this report: when it is missing the
        // panel shows transport errors that look like login problems.
        return { text: `面板通道：${transport}\n${renderStatus(status)}` }
      },
    }),

    defineTool({
      name: 'zentao_my_bugs',
      description: '列出禅道「我的 Bug」（/index.php?m=my&f=bug）。返回结构化字段（ID/级别/优先级/类型/标题/创建人/指派给/是否已解决），不回传 HTML。',
      parameters: {
        limit: { type: 'number', description: '返回条数上限，默认 30，最大 200' },
        only: { type: 'string', enum: ['all', 'open', 'resolved'], description: '筛选：all（默认）/ open 仅未解决 / resolved 仅已解决（依据列表页的「解决/方案」两列）' },
        refresh: { type: 'boolean', description: '绕过 60 秒缓存' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
        render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
      },
      async execute(args): Promise<{ text: string }> {
        const a = args as { limit?: number, only?: 'all' | 'open' | 'resolved', refresh?: boolean }
        try {
          const result = await workbench.myBugs(a)
          const lines = [`我的 Bug（${result.bugs.length}/${result.total}，经「${result.via}」）${result.cached ? ' · 缓存' : ''}`]
          for (const bug of result.bugs) {
            lines.push(`  ${bug.id}  [${bug.severity || '-'}/${bug.pri || '-'}] ${bug.title}  ← 指派 ${bug.assignedTo || '-'}${bug.resolution ? `  ✔${bug.resolution}` : ''}`)
          }
          if (result.bugs.length === 0) lines.push('  （没有匹配的单据）')
          lines.push('下一步：用 zentao_bug_context bugID=<id> 取该单的完整上下文（详情 + 解决表单默认值与必填项）。')
          return { text: lines.join('\n') }
        } catch (error) {
          const failure = authFailure(error)
          if (failure) return failure
          throw error
        }
      },
    }),

    defineTool({
      name: 'zentao_tasks',
      description: '列出项目任务（/index.php?m=project&f=task）。本实例的任务模块没有数据（实测 8 个项目全部为空），因此常见结果是空列表 + 一句如实说明，而不是解析失败。',
      parameters: {
        projectID: { type: 'string', description: '项目 ID；缺省用实例默认项目' },
        limit: { type: 'number', description: '返回条数上限，默认 30' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
        render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
      },
      async execute(args): Promise<{ text: string }> {
        const a = args as { projectID?: string, limit?: number }
        try {
          const result = await workbench.myTasks({ projectID: a.projectID, limit: a.limit })
          const lines = [`任务（${result.tasks.length}/${result.total}，经「${result.via}」）${result.projectID !== undefined ? ` · 项目 ${result.projectID}` : ''}`]
          for (const task of result.tasks) {
            lines.push(`  ${task.id}  ${task.name}  [${task.status || '-'}] ← ${task.assignedTo || '-'}`)
          }
          if (result.tasks.length === 0) lines.push(`  ${result.note}`)
          return { text: lines.join('\n') }
        } catch (error) {
          const failure = authFailure(error)
          if (failure) return failure
          throw error
        }
      },
    }),

    defineTool({
      name: 'zentao_bug_context',
      description: '一次取全一条 Bug 的上下文：详情（标题/产品/状态/指派）+ 解决表单的 uid、必填项、默认值、枚举可选值，以及最近动态。替代「反复读页面猜字段」——254 个解决版本选项只回传你点名匹配的那几个，892 项的人员下拉只回传当前选中值。',
      parameters: {
        bugID: { type: 'string', required: true, description: '禅道 Bug ID' },
        build: { type: 'string', description: '可选：想确认的解决版本（可传 ID 或名称），只回传匹配到的选项' },
        historyLimit: { type: 'number', description: '最近动态条数，默认 5' },
        refresh: { type: 'boolean', description: '绕过 10 分钟缓存重新抓取' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
        render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
      },
      async execute(args): Promise<{ text: string }> {
        const a = args as { bugID?: string, build?: string, historyLimit?: number, refresh?: boolean }
        const bugID = String(a.bugID ?? '').trim()
        if (bugID === '') return { text: '缺少 bugID' }
        try {
          const context = await workbench.bugContext(bugID, { build: a.build, historyLimit: a.historyLimit, refresh: a.refresh })
          return { text: contextSummary(context) }
        } catch (error) {
          const failure = authFailure(error)
          if (failure) return failure
          throw error
        }
      },
    }),

    defineTool({
      name: 'zentao_resolve_bug',
      description: '解决禅道 Bug：一次成。工具自己补齐 uid/所属人/指派给/解决版本/影响范围等必填项（缺什么补什么并说明来源），超长文本自动压到 512 字上限，提交前本地校验，提交后回读状态判定是否真的成功。默认先 dryRun 预览计划。',
      parameters: {
        bugID: { type: 'string', required: true, description: '禅道 Bug ID' },
        resolution: { type: 'string', description: '解决方案（表单枚举，常用 fixed；不传则用表单默认）' },
        reason: { type: 'string', description: 'Bug产生原因（表单枚举，常用 codeBug；不传则用表单默认）' },
        detail: { type: 'string', description: 'bug详细原因；超过 512 字会自动在句末截断并说明' },
        impact: { type: 'string', description: '代码变更影响范围（服务端必填；不传则沿用表单内容，表单为空时自动填充最小可接受内容并标注）' },
        comment: { type: 'string', description: '备注' },
        build: { type: 'string', description: '解决版本（ID 或名称，自动映射；不传沿用表单默认）' },
        assignedTo: { type: 'string', description: '指派给；不传则用表单当前选中，其次该单当前指派' },
        inChargedBy: { type: 'string', description: 'Bug所属人（服务端必填）；不传则用表单当前选中，其次该单当前指派' },
        force: { type: 'boolean', description: '已是「已解决」时仍再次解决' },
        dryRun: { type: 'boolean', description: '只输出将要提交的字段与自动填充说明，不提交（建议先用一次）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
        render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
      },
      async execute(args): Promise<{ text: string }> {
        const a = args as ResolveArgs & { bugID?: string }
        const bugID = String(a.bugID ?? '').trim()
        if (bugID === '') return { text: '缺少 bugID' }
        try {
          const run = await runResolve(workbench, bugID, a)
          const lines = [renderPlan(run.plan)]
          if (!run.outcome) {
            lines.push(run.plan.blocked
              ? '未提交（见上面的问题项）。修正后重试即可——该单上下文仍在缓存里，重试只花一次提交。'
              : '（dryRun）确认无误后，去掉 dryRun 再调用一次即可提交。')
            return { text: lines.join('\n') }
          }
          if (run.outcome.ok) {
            lines.push(`✔ 已解决并回读确认（状态：${run.outcome.status}）${run.outcome.url ? `\n${run.outcome.url}` : ''}`)
            return { text: lines.join('\n') }
          }
          lines.push(`✘ 服务端未接受（回读状态：${run.outcome.status}）`)
          if (run.outcome.serverError) lines.push(`服务端原文：${run.outcome.serverError}`)
          lines.push('上下文仍在缓存：直接修正出问题的字段再调用一次，不必重新读页面。')
          return { text: lines.join('\n') }
        } catch (error) {
          const failure = authFailure(error)
          if (failure) return failure
          throw error
        }
      },
    }),
  ]
}

/** Exported for the CLI and the panel: resolve a build name without a tool call. */
export function pickBuild(context: BugContext, query: string): string {
  return matchBuildOptions(context.resolve.buildMatches, query, 1)[0]?.value ?? ''
}

export type { SessionStatus }
