import { describe, expect, it } from 'vitest'
import { BUG_ORDER_FIELDS, normalizeOrderBy, ZentaoWorkbench } from '../src/zentao.js'
import { bugListPage, bugRow } from './fixtures/pages.js'
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
    expect(paths).toHaveLength(2)
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
    expect(paths).toHaveLength(2)
    // …and the same order is still cached.
    await workbench.myBugs({ orderBy: 'severity_asc' })
    expect(paths).toHaveLength(2)
  })
})
