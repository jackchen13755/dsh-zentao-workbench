import { describe, expect, it } from 'vitest'
import { createTools } from '../src/tools.js'
import { ZentaoWorkbench } from '../src/zentao.js'
import { fakeSession } from './helpers/fake-session.js'

/**
 * Guards the tool surface against documentation drift: the README's tool table
 * once listed `zentao_tasks` while only the RPC/CLI could do it, which is the
 * kind of small overstatement that makes a whole README untrustworthy.
 */
describe('tool surface', () => {
  const tools = createTools({
    session: fakeSession(() => '<html></html>'),
    workbench: new ZentaoWorkbench(fakeSession(() => '<html></html>')),
  }) as Array<{ name: string, description: string }>

  it('registers exactly the documented tools, in a stable order', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'zentao_session_status',
      'zentao_my_bugs',
      'zentao_tasks',
      'zentao_bug_context',
      'zentao_resolve_bug',
    ])
  })

  it('every tool explains itself and points at the session status when lost', () => {
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20)
    }
    const resolve = tools.find((tool) => tool.name === 'zentao_resolve_bug')!
    expect(resolve.description).toContain('dryRun')
  })
})
