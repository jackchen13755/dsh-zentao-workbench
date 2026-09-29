import { describe, expect, it } from 'vitest'
import { BUG_ORDER_FIELDS, normalizeOrderBy, ZentaoWorkbench } from '../src/zentao.js'
import { bugListJson, bugListPage, bugRow } from './fixtures/pages.js'
import { fakeSession } from './helpers/fake-session.js'

/**
 * Sorting is a whitelist, not a passthrough: the value ends up in the server's
 * SQL ORDER BY clause, so an unchecked string would be an injection point.
 */
describe('normalizeOrderBy', () => {
  it('accepts the values the live list page honours', () => {
    expect(normalizeOrderBy('id_desc')).toBe('id_desc')
    expect(normalizeOrderBy('openedDate_asc')).toBe('openedDate_asc')
    expect(normalizeOrderBy('severity_asc')).toBe('severity_asc')
    expect(normalizeOrderBy('pri_desc')).toBe('pri_desc')
  })

  it('treats an empty value as "server default"', () => {
    expect(normalizeOrderBy(undefined)).toBe('')
    expect(normalizeOrderBy('   ')).toBe('')
  })

  it('refuses anything outside the whitelist instead of guessing', () => {
    expect(() => normalizeOrderBy('id; drop table zt_bug')).toThrow(/不支持的排序/)
    expect(() => normalizeOrderBy('title_asc')).toThrow(/不支持的排序/) // real column, but not offered
    expect(() => normalizeOrderBy('id_sideways')).toThrow(/不支持的排序/)
    expect(() => normalizeOrderBy('id')).toThrow(/不支持的排序/)
    // The message must teach the caller the valid set.
    expect(() => normalizeOrderBy('nope_asc')).toThrow(new RegExp(BUG_ORDER_FIELDS[0]))
  })
})

describe('myBugs scope', () => {
  it('uses the project bug list, with projectID before orderBy', async () => {
    const paths: string[] = []
    const session = fakeSession((path) => {
      paths.push(path)
      return bugListPage([bugRow({ id: '1', title: 'a' })])
    })
    const result = await new ZentaoWorkbench(session).myBugs({ scope: 'project', projectID: '187', orderBy: 'severity_asc' })
    // Same rule as the my-bugs URL: the scope parameter must precede orderBy,
    // otherwise the instance answers an empty list (measured on both shapes).
    expect(paths[0]).toBe('/index.php?m=project&f=bug&projectID=187&orderBy=severity_asc')
    expect(result.scope).toBe('project')
    expect(result.projectID).toBe('187')
  })

  it('falls back to my bugs when no project is chosen', async () => {
    const paths: string[] = []
    const session = fakeSession((path) => {
      paths.push(path)
      return bugListPage([bugRow({ id: '1', title: 'a' })])
    })
    const result = await new ZentaoWorkbench(session).myBugs({ scope: 'project' })
    expect(paths[0]).toContain('m=my&f=bug')
    expect(result.scope).toBe('mine')
  })

  it('does not serve a cached project page for a "mine" request', async () => {
    const paths: string[] = []
    const session = fakeSession((path) => {
      paths.push(path)
      return bugListPage([bugRow({ id: '1', title: 'a' })])
    })
    const workbench = new ZentaoWorkbench(session)
    await workbench.myBugs({ scope: 'project', projectID: '187' })
    await workbench.myBugs({})
    // 只数 HTML 列表请求：每次列表加载都会并行拉一份 `&t=json` 补创建时间，
    // 那条陪伴请求不该让「换了个范围就要重新取」的判断失真。
    expect(paths.filter((path) => !path.endsWith('&t=json'))).toHaveLength(2)
  })
})

describe('myBugs ordering', () => {
  it('sends the order to the server and echoes it back', async () => {
    const paths: string[] = []
    const session = fakeSession((path) => {
      paths.push(path)
      return bugListPage([bugRow({ id: '1', title: 'a' })])
    })
    const workbench = new ZentaoWorkbench(session)
    const result = await workbench.myBugs({ orderBy: 'severity_asc' })
    expect(paths[0]).toContain('orderBy=severity_asc')
    // …and always after `type=assignedTo`: on this instance a bare orderBy
    // returns an empty list (measured), so the shape is part of the contract.
    expect(paths[0]).toContain('type=assignedTo&orderBy=severity_asc')
    expect(result.orderBy).toBe('severity_asc')
  })

  it('omits the parameter for the server default', async () => {
    const paths: string[] = []
    const session = fakeSession((path) => {
      paths.push(path)
      return bugListPage([bugRow({ id: '1', title: 'a' })])
    })
    await new ZentaoWorkbench(session).myBugs({})
    expect(paths[0]).not.toContain('orderBy=')
  })

  it('does not serve a cached page for a different order', async () => {
    // Regression guard: a cache keyed only by "the list" would answer a
    // severity_asc request with the previously fetched id_desc page.
    const paths: string[] = []
    const session = fakeSession((path) => {
      paths.push(path)
      return bugListPage([bugRow({ id: '1', title: 'a' })])
    })
    const workbench = new ZentaoWorkbench(session)
    await workbench.myBugs({ orderBy: 'id_desc' })
    await workbench.myBugs({ orderBy: 'severity_asc' })
    const lists = (): string[] => paths.filter((path) => !path.endsWith('&t=json'))
    expect(lists()).toHaveLength(2)
    // …and the same order is still cached.
    await workbench.myBugs({ orderBy: 'severity_asc' })
    expect(lists()).toHaveLength(2)
  })
})

/**
 * 列表的创建时间来自同一 URL 的 `&t=json` 变体：HTML 整页没有日期（实测 0 处），
 * 而 JSON 的 `type` 字段是空的 —— 所以两边都要，缺一边就丢信息。
 */
describe('myBugs 创建时间', () => {
  it('merges openedDate from the t=json variant into the HTML-parsed rows', async () => {
    const session = fakeSession((path) => path.endsWith('&t=json')
      ? bugListJson([{ id: '1', openedDate: '2026-08-18 16:27:16' }, { id: '2', openedDate: '2026-09-01 09:00:00' }])
      : bugListPage([bugRow({ id: '1', title: 'a' }), bugRow({ id: '2', title: 'b' })]))
    const result = await new ZentaoWorkbench(session).myBugs({ refresh: true })
    expect(result.bugs.map((bug) => bug.openedDate)).toEqual(['2026-08-18 16:27:16', '2026-09-01 09:00:00'])
    expect(session.gets.some((path) => path.endsWith('&t=json'))).toBe(true)
    // 类型仍来自 HTML（JSON 里是空的），证明没有把行换成 JSON 解析。
    expect(result.bugs[0]?.type).toBeTruthy()
  })

  it('keeps the list working when the JSON variant is unavailable', async () => {
    const session = fakeSession((path) => {
      if (path.endsWith('&t=json')) throw new Error('t=json 不被这台实例支持')
      return bugListPage([bugRow({ id: '1', title: 'a' })])
    })
    const result = await new ZentaoWorkbench(session).myBugs({ refresh: true })
    expect(result.bugs).toHaveLength(1)
    expect(result.bugs[0]?.openedDate).toBe('')
  })
})
