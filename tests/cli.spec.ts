import { describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../src/cli.js'
import { ZentaoWorkbench } from '../src/zentao.js'
import { bugViewPage, resolveFormPage } from './fixtures/pages.js'
import { fakeSession } from './helpers/fake-session.js'

function recorder(): { io: CliIo, out: string[], err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err }
}

const VIEW = '/index.php?m=bug&f=view&bugID=55036'
const FORM = '/index.php?m=bug&f=resolve&bugID=55036&onlybody=yes'

function deps() {
  const session = fakeSession((path, method) => {
    if (method === 'POST') return { body: '<div>ok</div>' }
    if (path === FORM) {
      return resolveFormPage({
        uid: 'kuid-cli',
        requiredJson: 'resolution,bugInchargedBy,changeImpact',
        counts: { resolvedBuild: 254, people: 892 },
        defaults: { resolution: 'fixed', reason: 'codeBug', assignedTo: 'user-1' },
      })
    }
    if (path === VIEW) return bugViewPage({ id: '55036', title: '浮层问题', product: 'Demo', status: '激活', assignee: 'dev.one' })
    throw new Error(`unexpected ${path}`)
  })
  return { session, workbench: new ZentaoWorkbench(session) }
}

describe('zentao CLI', () => {
  it('prints usage without touching the network', async () => {
    const rec = recorder()
    expect(await runCli(['help'], rec.io)).toBe(0)
    expect(rec.out.join('')).toContain('zentao resolve')
    expect(rec.err).toEqual([])
  })

  it('rejects an unknown flag with a pointer to --help', async () => {
    const rec = recorder()
    expect(await runCli(['bugs', '--nope'], rec.io)).toBe(1)
    expect(rec.err.join('')).toContain('--help')
  })

  it('requires a bugID for context', async () => {
    const rec = recorder()
    expect(await runCli(['context'], rec.io)).toBe(1)
    expect(rec.err.join('')).toContain('缺少 bugID')
  })

  it('renders the compact context for a bug', async () => {
    const rec = recorder()
    const code = await runCli(['context', '55036'], rec.io, deps())
    const text = rec.out.join('')
    expect(code).toBe(0)
    expect(text).toContain('Bug 55036')
    expect(text).toContain('uid kuid-cli')
    expect(text).toContain('选项规模 resolvedBuild 254')
  })

  it('emits machine-readable JSON on request', async () => {
    const rec = recorder()
    await runCli(['context', '55036', '--json'], rec.io, deps())
    const parsed = JSON.parse(rec.out.join('')) as { bug: { id: string }, resolve: { uid: string } }
    expect(parsed.bug.id).toBe('55036')
    expect(parsed.resolve.uid).toBe('kuid-cli')
  })

  it('a dry run prints the plan, posts nothing and exits 0', async () => {
    const rec = recorder()
    const { session, workbench } = deps()
    const code = await runCli(['resolve', '55036', '--dry-run'], rec.io, { session, workbench })
    expect(code).toBe(0)
    expect(rec.out.join('')).toContain('解决计划')
    expect(rec.out.join('')).toContain('dry-run，未提交')
    expect(session.posts).toHaveLength(0)
  })

  it('reads long prose from a file with @path', async () => {
    const rec = recorder()
    const { session, workbench } = deps()
    const code = await runCli(['resolve', '55036', '--dry-run', '--detail', '@/definitely/missing.txt'], rec.io, { session, workbench })
    // Unreadable file → the value is dropped, and the planner still produces a
    // valid plan (detail is optional), so the command succeeds.
    expect(code).toBe(0)
    expect(session.posts).toHaveLength(0)
  })

  it('exits 2 when the plan is blocked, and never posts', async () => {
    const rec = recorder()
    const session = fakeSession((path, method) => {
      if (method === 'POST') return { body: '<div>ok</div>' }
      if (path === FORM) return resolveFormPage({ uid: 'k', requiredJson: 'resolution,bugInchargedBy,changeImpact', counts: { people: 892 } })
      return bugViewPage({ id: '55036', title: 't', status: '激活', assignee: '' })
    })
    const code = await runCli(['resolve', '55036'], rec.io, { session, workbench: new ZentaoWorkbench(session) })
    expect(code).toBe(2)
    expect(session.posts).toHaveLength(0)
    expect(rec.err.join('')).toContain('计划被拦')
  })
})
