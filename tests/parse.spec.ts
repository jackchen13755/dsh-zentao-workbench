import { describe, expect, it } from 'vitest'
import {
  matchBuildOptions,
  parseBugList,
  parseBugView,
  parseHistories,
  parseResolveForm,
  resolveUid,
  sessionExpired,
} from '../src/parse.js'
import { bugListPage, bugRow, bugViewPage, loginFormPage, loginRedirectPage, resolveFormPage } from './fixtures/pages.js'

describe('session fingerprints', () => {
  it('treats the redirect script and the login form as expiry', () => {
    expect(sessionExpired(loginRedirectPage())).toBe(true)
    expect(sessionExpired(loginFormPage())).toBe(true)
    expect(sessionExpired(bugListPage([bugRow({ id: '1', title: 'x' })]))).toBe(false)
  })
})

describe('parseBugList', () => {
  it('reads id, severity, priority, title and assignee out of the measured columns', () => {
    const html = bugListPage([
      bugRow({ id: '55036', title: '查询条件浮层问题', severity: '主要', pri: '3', assignedTo: 'dev.one' }),
      bugRow({ id: '55035', title: '另一个问题', severity: '次要', pri: '2', assignedTo: 'other.user', resolution: 'fixed', resolvedBy: 'someone' }),
    ])
    const rows = parseBugList(html)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: '55036',
      severity: '主要',
      pri: '3',
      type: '需求逻辑问题',
      title: '查询条件浮层问题',
      openedBy: 'Reporter One',
      assignedTo: 'dev.one',
      href: '/index.php?m=bug&f=view&bugID=55036',
    })
    // Open vs resolved is only visible through the 解决/方案 columns.
    expect(rows[0]).toMatchObject({ resolution: '', resolvedBy: '' })
    expect(rows[1]).toMatchObject({ resolution: 'fixed', resolvedBy: 'someone' })
  })

  it('returns nothing for a page without the bug list table', () => {
    expect(parseBugList(loginFormPage())).toEqual([])
  })
})

describe('parseBugView', () => {
  it('reads the measured labels and strips the date off 当前指派', () => {
    const detail = parseBugView(bugViewPage({
      id: '55036',
      title: '查询条件location浮层问题',
      product: 'Service360',
      status: '激活',
      pri: '3',
      assignee: 'Dev One',
      histories: ['2026-08-18 16:27:16, 由 <strong>Reporter One</strong> 创建。'],
    }), '55036')
    expect(detail).toMatchObject({
      id: '55036',
      title: '查询条件location浮层问题',
      product: 'Service360',
      status: '激活',
      pri: '3',
      assignedTo: 'Dev One',
    })
  })

  it('reports the recorded resolution once the bug is resolved', () => {
    const detail = parseBugView(bugViewPage({ id: '1', title: 't', status: '已解决', resolvedBuild: 'xx.1', solution: 'fixed' }), '1')
    expect(detail).toMatchObject({ status: '已解决', resolvedBuild: 'xx.1', solution: 'fixed' })
  })
})

describe('parseHistories', () => {
  it('strips the strong tag around the actor and keeps page order', () => {
    const html = bugViewPage({
      id: '1',
      title: 't',
      histories: [
        '2026-08-18 16:27:16, 由 <strong>A One</strong> 创建。',
        '2026-09-01 10:00:00, 由 <strong>B Two</strong> 解决，解决方案为 fixed。',
      ],
    })
    expect(parseHistories(html, 5)).toEqual([
      '2026-08-18 16:27:16, 由 A One 创建。',
      '2026-09-01 10:00:00, 由 B Two 解决，解决方案为 fixed。',
    ])
    expect(parseHistories(html, 1)).toHaveLength(1)
  })
})

describe('parseResolveForm', () => {
  it('takes uid from the kuid variable rather than the templated input value', () => {
    const html = resolveFormPage({ uid: 'kuid-abc-123' })
    expect(resolveUid(html)).toBe('kuid-abc-123')
    expect(parseResolveForm(html).uid).toBe('kuid-abc-123')
  })

  it('collects required fields from the page config and the required td', () => {
    const html = resolveFormPage({ requiredJson: 'resolution,bugInchargedBy,changeImpact' })
    const required = parseResolveForm(html).required
    expect(required).toContain('resolution')
    expect(required).toContain('bugInchargedBy')
    expect(required).toContain('changeImpact')
    // the <td class='required'> wrapper contributes too
    expect(required).toContain('reason')
  })

  it('exposes the big dropdown as options plus its selected value', () => {
    const html = resolveFormPage({ counts: { resolvedBuild: 254, people: 892 }, defaults: { resolvedBuild: 'build-7' } })
    const form = parseResolveForm(html)
    expect(form.buildOptionCount).toBe(254)
    expect(form.defaults.resolvedBuild).toBe('build-7')
    expect(form.defaults.resolvedBuildText).toBe('build-7')
    expect(form.defaults.resolvedDate).toBe('2026-09-28 16:37:33')
  })
})

describe('matchBuildOptions', () => {
  const options = [
    { value: '6780', text: 'xx.1', title: '' },
    { value: '6781', text: 'xx.2', title: '' },
    { value: '6790', text: 'yy.1', title: '' },
  ]

  it('matches by value, then exact text, then substring', () => {
    expect(matchBuildOptions(options, '6780')).toEqual([options[0]])
    expect(matchBuildOptions(options, 'xx.2')).toEqual([options[1]])
    expect(matchBuildOptions(options, 'yy')).toEqual([options[2]])
  })

  it('returns nothing for an empty query and honours the limit', () => {
    expect(matchBuildOptions(options, '  ')).toEqual([])
    expect(matchBuildOptions(options, 'xx', 1)).toHaveLength(1)
  })
})
