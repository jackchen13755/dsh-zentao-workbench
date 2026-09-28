/**
 * Write-path probe — verifies the real POST without ever mutating a bug.
 *
 * Why this shape: every write path in this plugin had only been exercised as a
 * dry run, and "the plan looks right" is not evidence that the submit works.
 * A probe that actually submits has to be *incapable* of changing data, so it
 * removes a field the server requires (`changeImpact`) and corrupts `uid`: even
 * if this ZenTao build ignored the uid, a missing required field still cannot
 * be accepted. Measured consequence: the server answers with its own alert and
 * the bug's status is byte-identical afterwards.
 *
 * What it proves, end to end, through production code (`planResolve` →
 * `submitResolve`): form encoding, the real endpoint, `alert()` extraction, and
 * the post-submit status re-read that decides `ok`.
 *
 *   node scripts/probe-write-path.mjs <bugID>        # needs a session (ZENTAO_* env or a jar)
 *
 * Exit code 0 means: refused as designed AND the bug did not change.
 */
const JAR = '/Users/zhe.chen/Desktop/dsh/github/.scratch/zentao/cookies.txt'
const mod = await import('/Users/zhe.chen/Desktop/dsh/github/dsh-zentao-workbench/dist/index.js')
const { ZenTaoSession, ZentaoWorkbench, planResolve, submitResolve } = mod

const session = new ZenTaoSession({ server: 'https://zen.sgrl.io', jarPaths: [JAR] })
const wb = new ZentaoWorkbench(session)
const bugID = process.argv[2] ?? '55036'

const ctx = await wb.bugContext(bugID, { refresh: true })
console.log('提交前状态:', ctx.bug.status)

const plan = planResolve(ctx, { detail: '写路径探针（不应落库）' })
plan.fields = plan.fields.filter(([name]) => name !== 'changeImpact')   // 必填项缺失 → 服务端必拒
plan.fields = plan.fields.map(([n, v]) => (n === 'uid' ? [n, 'probe-invalid-uid'] : [n, v]))
plan.blocked = false                                                     // 绕过本地门禁，专门测服务端
console.log('故意破坏后的字段:', plan.fields.map(([n]) => n).join(', '))

const outcome = await submitResolve(session, plan, ctx)
console.log('\n=== 结果 ===')
console.log('ok        :', outcome.ok, '（false = 服务端拒绝，符合预期）')
console.log('回读状态  :', outcome.status, '（应与提交前一致）')
console.log('服务端原文:', outcome.serverError ?? '(无 alert)')

const after = await wb.bugContext(bugID, { refresh: true })
console.log('提交后状态:', after.bug.status)
const unchanged = (before) => after.bug.status === before
console.log('\n单据未被改动:', unchanged(ctx.bug.status) ? '✓' : '✗ 状态变了！')
process.exit(outcome.ok === false && unchanged(ctx.bug.status) ? 0 : 1)
