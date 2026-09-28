import { describe, expect, it } from 'vitest'
import { compressToLimit, planResolve, submitResolve } from '../src/resolve.js'
import { ZentaoWorkbench, resolveBug } from '../src/zentao.js'
import { bugViewPage, resolveFormPage } from './fixtures/pages.js'
import { fakeSession } from './helpers/fake-session.js'

const VIEW_PATH = '/index.php?m=bug&f=view&bugID=55036'
const FORM_PATH = '/index.php?m=bug&f=resolve&bugID=55036&onlybody=yes'

/** A form whose dropdowns are as hostile as the real one. */
function form(overrides: Parameters<typeof resolveFormPage>[0] = {}): string {
  return resolveFormPage({
    uid: 'kuid-1',
    requiredJson: 'resolution,bugInchargedBy,changeImpact',
    counts: { resolvedBuild: 254, resolution: 8, reason: 9, people: 892 },
    defaults: { resolution: 'resolution-1', reason: 'reason-1', bugInchargedBy: 'user-1', assignedTo: 'user-1', resolvedBuild: 'build-7' },
    ...overrides,
  })
}

function workbenchWith(pages: { view?: string, form?: string, onPost?: (body: string) => { body: string, view?: string } }) {
  let view = pages.view ?? bugViewPage({ id: '55036', title: '查询条件浮层问题', product: 'Demo', status: '激活', assignee: 'dev.one' })
  const session = fakeSession((path, method, body) => {
    if (method === 'POST') {
      const outcome = pages.onPost?.(body ?? '') ?? { body: `<script>alert('『代码变更影响范围』不能为空。')</script>` }
      if (outcome.view) view = outcome.view
      return { body: outcome.body }
    }
    if (path === FORM_PATH) return pages.form ?? form()
    if (path === VIEW_PATH) return view
    throw new Error(`unexpected GET ${path}`)
  })
  const workbench = new ZentaoWorkbench(session, { bugTtlMs: 60_000, listTtlMs: 60_000 })
  return { session, workbench, setView: (html: string) => { view = html } }
}

async function contextOf(overrides: Parameters<typeof resolveFormPage>[0] = {}) {
  const { session, workbench } = workbenchWith({ form: form(overrides) })
  return { session, workbench, context: await workbench.bugContext('55036') }
}

describe('compressToLimit', () => {
  it('leaves text within the cap untouched', () => {
    expect(compressToLimit('short', 512)).toMatchObject({ text: 'short', compressed: false, from: 5, to: 5 })
  })

  it('cuts at a sentence boundary and reports both lengths', () => {
    const sentence = '这是一句话。'
    const text = sentence.repeat(120) // 6 × 120 = 720 code points
    const result = compressToLimit(text, 512)
    expect(result.compressed).toBe(true)
    expect(result.from).toBe(720)
    expect(result.to).toBeLessThanOrEqual(512)
    expect(result.text.endsWith('…')).toBe(true)
    expect(result.text.startsWith('这是一句话。')).toBe(true)
  })
})

describe('planResolve — the rules that remove the retry loop', () => {
  it('always emits 代码变更影响范围, even when the form and the caller are both empty', async () => {
    const { context } = await contextOf({ impact: undefined })
    const plan = planResolve(context, {})
    const impact = plan.fields.find(([name]) => name === 'changeImpact')?.[1] ?? ''
    // The old flow omitted the field entirely here → server alert → another round trip.
    expect(impact).not.toBe('')
    expect(plan.autoFilled.changeImpact).toContain('必填')
    expect(plan.blocked).toBe(false)
  })

  it('keeps the impact the caller supplied', async () => {
    const { context } = await contextOf()
    const plan = planResolve(context, { impact: '仅影响订单列表导出' })
    expect(plan.fields.find(([name]) => name === 'changeImpact')?.[1]).toBe('仅影响订单列表导出')
    expect(plan.autoFilled.changeImpact).toBeUndefined()
  })

  it('compresses an over-long 详细原因 instead of letting the server reject it', async () => {
    const { context } = await contextOf()
    const plan = planResolve(context, { detail: '细节。'.repeat(300) })
    const detail = plan.fields.find(([name]) => name === 'detail_reason')?.[1] ?? ''
    expect([...detail].length).toBeLessThanOrEqual(512)
    expect(plan.compressed).toMatchObject({ field: 'detail_reason', from: 900, to: [...detail].length })
    expect(plan.blocked).toBe(false)
  })

  it('fills the 892-option people selects from the form, then from the bug assignee', async () => {
    const fromForm = planResolve((await contextOf()).context, {})
    expect(fromForm.fields.find(([name]) => name === 'bugInchargedBy')?.[1]).toBe('user-1')
    expect(fromForm.autoFilled.bugInchargedBy).toContain('表单当前选中')

    // Form has no selection → fall back to the bug's own 当前指派.
    const bare = await contextOf({ defaults: {} })
    const plan = planResolve(bare.context, {})
    expect(plan.fields.find(([name]) => name === 'assignedTo')?.[1]).toBe('dev.one')
    expect(plan.autoFilled.assignedTo).toContain('当前指派')
  })

  it('maps a build display name onto its option value', async () => {
    const { context } = await contextOf({ defaults: { resolvedBuild: undefined } })
    const plan = planResolve(context, { build: 'build-9' }, { buildOptions: [
      { value: 'build-7', text: 'xx.1', title: '' },
      { value: 'build-9', text: 'xx.2', title: '' },
    ] })
    expect(plan.fields.find(([name]) => name === 'resolvedBuild')?.[1]).toBe('build-9')
    expect(plan.problems).toEqual([])
  })

  it('reports the allowed codes when an unknown enum is supplied instead of posting it', async () => {
    const { context } = await contextOf()
    const resolutionOptions = [1, 2, 3].map((i) => ({ value: `resolution-${i}`, text: `r${i}`, title: '' }))
    const plan = planResolve(context, { resolution: 'fixed' }, { resolutionOptions })
    expect(plan.problems.join(' ')).toContain('不在该表单的选项里')
    expect(plan.blocked).toBe(true)
  })

  it('blocks when a required field cannot be filled at all', async () => {
    // No form selection and no assignee on the bug → 所属人 is unfillable.
    const { workbench } = workbenchWith({
      view: bugViewPage({ id: '55036', title: 't', status: '激活', assignee: '' }),
      form: form({ defaults: {} }),
    })
    const context = await workbench.bugContext('55036')
    const plan = planResolve(context, {})
    expect(plan.problems.join(' ')).toContain('bugInchargedBy')
    expect(plan.blocked).toBe(true)
  })

  it('notes an already-resolved bug unless force is set', async () => {
    const { workbench } = workbenchWith({
      view: bugViewPage({ id: '55036', title: 't', status: '已解决', solution: 'fixed', assignee: 'dev.one' }),
    })
    const context = await workbench.bugContext('55036')
    expect(planResolve(context, {}).blocked).toBe(true)
    expect(planResolve(context, {}).notes.join(' ')).toContain('已是「已解决」')
    expect(planResolve(context, { force: true }).blocked).toBe(false)
  })
})

describe('resolveBug — retry economics (this is the point of the plugin)', () => {
  it('a dry run posts nothing', async () => {
    const { session, workbench } = workbenchWith({})
    const run = await resolveBug(workbench, '55036', { dryRun: true })
    expect(session.posts).toHaveLength(0)
    expect(run.outcome).toBeUndefined()
    expect(run.plan.blocked).toBe(false)
  })

  it('a blocked plan posts nothing', async () => {
    const { session, workbench } = workbenchWith({
      view: bugViewPage({ id: '55036', title: 't', status: '激活', assignee: '' }),
      form: form({ defaults: {} }),
    })
    const run = await resolveBug(workbench, '55036', {})
    expect(session.posts).toHaveLength(0)
    expect(run.outcome).toBeUndefined()
    expect(run.plan.blocked).toBe(true)
  })

  it('a rejected submit costs ONE post, and the retry does not re-read the pages', async () => {
    let calls = 0
    const { session, workbench } = workbenchWith({
      onPost: () => {
        calls += 1
        // First attempt is refused the way ZenTao refuses: HTTP 200 + alert().
        return calls === 1
          ? { body: `<script>alert('『bug详细原因』长度应当不超过『512』，且大于『0』。')</script>` }
          : { body: '<div>ok</div>', view: bugViewPage({ id: '55036', title: 't', status: '已解决', solution: 'fixed', assignee: 'dev.one' }) }
      },
    })

    const first = await resolveBug(workbench, '55036', { detail: '第一次提交' })
    expect(first.outcome?.ok).toBe(false)
    expect(first.outcome?.serverError).toContain('512')
    expect(session.posts).toHaveLength(1)
    // view + form + the post-submit verification re-read
    expect(session.gets).toHaveLength(3)
    const getsAfterFirst = session.gets.length

    const second = await resolveBug(workbench, '55036', { detail: '修正后重新提交' })
    expect(second.outcome?.ok).toBe(true)
    expect(session.posts).toHaveLength(2)
    // The whole point: a retry costs ONE post and ONE verification read — it does
    // not re-fetch the two pages, because the context was kept on failure.
    expect(session.gets.length - getsAfterFirst).toBe(1)
  })

  it('verifies through the status re-read, not the HTTP code', async () => {
    const { session, workbench } = workbenchWith({
      onPost: () => ({ body: '<div>submitted</div>' }), // 200, no alert, status unchanged
    })
    const run = await resolveBug(workbench, '55036', {})
    expect(session.posts).toHaveLength(1)
    expect(run.outcome?.ok).toBe(false)
    expect(run.outcome?.status).toBe('激活')
  })

  it('a verified success invalidates the cached context', async () => {
    const { session, workbench } = workbenchWith({
      onPost: () => ({ body: '<div>ok</div>', view: bugViewPage({ id: '55036', title: 't', status: '已解决', solution: 'fixed', assignee: 'dev.one' }) }),
    })
    const run = await resolveBug(workbench, '55036', {})
    expect(run.outcome?.ok).toBe(true)
    const getsAfterSuccess = session.gets.length
    await workbench.bugContext('55036')
    expect(session.gets.length).toBe(getsAfterSuccess + 2) // cache was dropped on purpose
  })
})

describe('submitResolve', () => {
  it('sends every planned field form-encoded, skipping empty values', async () => {
    const { session, workbench, context } = await (async () => {
      const built = workbenchWith({})
      return { ...built, context: await built.workbench.bugContext('55036') }
    })()
    const plan = planResolve(context, { comment: '', impact: '影响 A' })
    await submitResolve(session, plan, context)
    const body = session.posts[0]?.body ?? ''
    expect(body).toContain('uid=kuid-1')
    expect(body).toContain('changeImpact=%E5%BD%B1%E5%93%8D%20A')
    expect(body).not.toContain('comment=')
  })
})
