/**
 * The `zentao` CLI, sharing the exact same parsers, session chain and resolve
 * planner as the DSH tools.
 *
 * Why a Node CLI instead of extending the old bash script: that version had its
 * own HTML handling, so every fix had to be made twice — which is how the
 * "third attempt at the same operation" complaints in the session history came
 * about. One implementation, two front doors.
 *
 * Deliberately imports only `session` / `zentao` / `resolve` (never the plugin
 * entry), so the CLI runs without the host's `@deepseek-ai/dsh-tools`.
 */

import { readFileSync } from 'node:fs'
import { ZENTAO_FETCH_PATH } from './protocol.js'
import { ZENTAO_RPC_CHANNEL } from './rpc.js'
import { renderPlan } from './resolve.js'
import { renderStatus, ZenTaoAuthError, ZenTaoSession } from './session.js'
import { resolveBug, ZentaoWorkbench } from './zentao.js'

const VALUE_FLAGS = new Set([
  'server', 'limit', 'only', 'build', 'history', 'resolution', 'reason',
  'detail', 'impact', 'comment', 'assigned-to', 'in-charged-by', 'cookie-jar', 'bridge-url',
  'account', 'save-jar', 'project', 'host-url', 'order-by',
])
const BOOLEAN_FLAGS = new Set(['json', 'refresh', 'dry-run', 'force', 'help', 'password-stdin'])

const USAGE = `用法：
  zentao status   [--json]
  zentao bugs     [--limit 30] [--only all|open|resolved] [--refresh] [--json]
                  [--order-by id_desc|openedDate_desc|severity_asc|pri_asc|…]
  zentao tasks    [--project <id>] [--limit 30] [--json]
  zentao context  <bugID> [--build X] [--history 5] [--refresh] [--json]
  zentao doctor   [--host-url http://127.0.0.1:19387]
                                   （判定面板通道路由是否真的注册；面板报 405 时先跑它）
  zentao login    --account A          （密码读 ZENTAO_PASSWORD，或 --password-stdin）
                  [--save-jar <path>]  （可选：把会话写成 0600 jar 供其它工具复用）
  zentao resolve  <bugID> [--resolution R] [--reason R] [--detail T|@file]
                          [--impact T|@file] [--comment T] [--build B]
                          [--assigned-to U] [--in-charged-by U] [--dry-run] [--force] [--json]

通用参数：--server <实例地址>（也可用 ZENTAO_BASE）、--cookie-jar <路径>、--bridge-url <daemon>
环境变量：ZENTAO_BASE、ZENTAO_COOKIE_JAR、ZENTAO_COOKIE、DAEMON_URL
退出码：0 成功 · 1 用法/会话失败 · 2 计划被拦或服务端拒绝`

/** Read a password from stdin (the safe way to pass one on a shared machine). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').trim()
}

interface ParsedArgs {
  command: string
  positional: string[]
  flags: Map<string, string | boolean>
}

export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}

function parseArgs(argv: string[], io: CliIo): ParsedArgs | null {
  const [command = 'help', ...rest] = argv
  const positional: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true)
      continue
    }
    if (!VALUE_FLAGS.has(name)) {
      io.err(`zentao: 未知参数 --${name}（用 --help 看用法）\n`)
      return null
    }
    const value = rest[++index]
    if (value === undefined) {
      io.err(`zentao: --${name} 需要一个值\n`)
      return null
    }
    flags.set(name, value)
  }
  return { command, positional, flags }
}

function flag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

/** `--detail @path` reads a file (long Chinese prose belongs in one); else literal. */
function textValue(raw: string | undefined, io: CliIo): string | undefined {
  if (raw === undefined) return undefined
  if (!raw.startsWith('@')) return raw
  try {
    return readFileSync(raw.slice(1), 'utf8').trim()
  } catch (error) {
    io.err(`zentao: 读取 ${raw.slice(1)} 失败：${(error as Error).message}\n`)
    return undefined
  }
}

/**
 * Run the CLI. Returns the process exit code instead of calling `process.exit`,
 * so the whole command surface is testable.
 */
export interface CliDeps {
  session?: ZenTaoSession
  workbench?: ZentaoWorkbench
}

export async function runCli(argv: string[], io: CliIo = defaultIo, deps: CliDeps = {}): Promise<number> {
  const parsed = parseArgs(argv, io)
  if (parsed === null) return 1
  if (parsed.command === 'help' || parsed.flags.get('help') === true) {
    io.out(`${USAGE}\n`)
    return 0
  }

  const session = deps.session ?? new ZenTaoSession({
    server: flag(parsed, 'server'),
    bridgeUrl: flag(parsed, 'bridge-url'),
    manualJarPath: flag(parsed, 'cookie-jar'),
  })
  const workbench = deps.workbench ?? new ZentaoWorkbench(session)
  const asJson = parsed.flags.get('json') === true

  try {
    switch (parsed.command) {
      case 'status': {
        const status = await session.status(true)
        io.out(asJson ? `${JSON.stringify(status, null, 2)}\n` : `${renderStatus(status)}\n`)
        return status.authenticated ? 0 : 1
      }

      case 'bugs': {
        const result = await workbench.myBugs({
          limit: Number(flag(parsed, 'limit') ?? 30),
          only: (flag(parsed, 'only') ?? 'all') as 'all' | 'open' | 'resolved',
          refresh: parsed.flags.get('refresh') === true,
          orderBy: flag(parsed, 'order-by'),
        })
        if (asJson) {
          io.out(`${JSON.stringify(result, null, 2)}\n`)
          return 0
        }
        io.out(`我的 Bug（${result.bugs.length}/${result.total}，经「${result.via}」）${result.cached ? ' · 缓存' : ''}${result.orderBy === '' ? '' : ` · 排序 ${result.orderBy}`}\n`)
        if (result.truncated) io.out(`  注意：本页只有 ${result.bugs.length} 条，实例共 ${result.total} 条；加大 --limit 或用面板查看\n`)
        for (const bug of result.bugs) {
          io.out(`  ${bug.id}  [${bug.severity || '-'}/${bug.pri || '-'}] ${bug.title}  ← ${bug.assignedTo || '-'}${bug.resolution ? `  ✔${bug.resolution}` : ''}\n`)
        }
        if (result.bugs.length === 0) io.out('  （没有匹配的单据）\n')
        return 0
      }

      case 'doctor': {
        const hostUrl = (flag(parsed, 'host-url') ?? 'http://127.0.0.1:19387').replace(/\/+$/, '')
        const probe = async (path: string, body: unknown): Promise<number | string> => {
          try {
            const response = await fetch(`${hostUrl}${path}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(8000),
            })
            return response.status
          } catch (error) {
            return `连不上（${(error as Error).message}）`
          }
        }

        io.out(`面板通道自检\n`)
        const fetchStatus = await probe(ZENTAO_FETCH_PATH, { endpoint: 'sessionStatus', payload: {} })
        const legacyStatus = await probe(`${ZENTAO_RPC_CHANNEL}/sessionStatus`, {
          type: 'client-request', rpcId: 'doctor', method: 'sessionStatus', payload: {},
        })
        io.out(`  POST ${ZENTAO_FETCH_PATH.padEnd(14)} → ${fetchStatus}\n`)
        io.out(`  POST ${(ZENTAO_RPC_CHANNEL + '/sessionStatus').padEnd(14)} → ${legacyStatus}（旧私有通道，本宿主预期 405）\n\n`)

        // Careful: 401/403 under /api does NOT prove our route exists — the
        // shared prefix runs its Host/Origin fence and browser auth *before*
        // dispatch, so any path under it answers 401 when unauthenticated.
        // Only a 404/405 is conclusive (no route at all).
        const conclusive = fetchStatus === 404 || fetchStatus === 405
        io.out(`  判定：${conclusive
          ? '✗ 面板通道路由未注册（404/405 是确定结论：请求根本没到插件）。'
          : fetchStatus === 401 || fetchStatus === 403
            ? '· 只能说明 /api 前缀活着并要求鉴权 —— **无法从这里判断**我们的路由在不在（未鉴权时 /api 下任意路径都回 401）。'
            : `? 非预期结果（${fetchStatus}）。`}\n`)
        io.out(`  权威信号在宿主自己手里：调用 zentao_session_status，第一行会打印「面板通道：…」\n`)
        io.out(`  （已注册 / 未注册 + 原因）。面板加载不出来时先看那一行。\n\n`)
        const status = await session.status(true)
        io.out(`${renderStatus(status)}\n`)
        return conclusive ? 1 : 0
      }

      case 'login': {
        const account = flag(parsed, 'account') ?? ''
        if (account === '') {
          io.err('zentao: 缺少 --account\n')
          return 1
        }
        const fromStdin = parsed.flags.get('password-stdin') === true
        const password = fromStdin ? (await readStdin()).trim() : (process.env.ZENTAO_PASSWORD ?? '')
        if (password === '') {
          io.err('zentao: 没有密码 —— 设 ZENTAO_PASSWORD，或用 --password-stdin 从标准输入读（避免出现在 ps 里）\n')
          return 1
        }
        const result = await session.login(account, password)
        if (!result.ok) {
          io.err(`zentao: 登录失败 —— ${result.detail}\n`)
          return 1
        }
        io.out(`${result.detail}\n`)
        const saveJar = flag(parsed, 'save-jar')
        if (saveJar !== undefined && saveJar !== '') {
          // Explicit opt-in only: the default keeps the credential in memory.
          const { writeCookieJar } = await import('./cookies.js')
          await writeCookieJar(saveJar, session.hostForJar(), session.runtimeCookieForJar())
          io.out(`已写入 cookie jar：${saveJar}（0600）\n`)
        }
        const status = await session.status(true)
        io.out(`${renderStatus(status)}\n`)
        return 0
      }

      case 'tasks': {
        const result = await workbench.myTasks({
          projectID: flag(parsed, 'project'),
          limit: Number(flag(parsed, 'limit') ?? 30),
        })
        if (asJson) {
          io.out(`${JSON.stringify(result, null, 2)}\n`)
          return 0
        }
        io.out(`任务（${result.tasks.length}/${result.total}，经「${result.via}」）${result.projectID !== undefined ? ` · 项目 ${result.projectID}` : ''}\n`)
        for (const task of result.tasks) {
          io.out(`  ${task.id}  ${task.name}  [${task.status || '-'}] ← ${task.assignedTo || '-'}\n`)
        }
        if (result.tasks.length === 0) io.out(`  ${result.note}\n`)
        return 0
      }

      case 'context': {
        const bugID = parsed.positional[0]
        if (bugID === undefined) {
          io.err('zentao: 缺少 bugID\n')
          return 1
        }
        const context = await workbench.bugContext(bugID, {
          build: flag(parsed, 'build'),
          historyLimit: Number(flag(parsed, 'history') ?? 5),
          refresh: parsed.flags.get('refresh') === true,
        })
        if (asJson) {
          io.out(`${JSON.stringify(context, null, 2)}\n`)
          return 0
        }
        io.out(`Bug ${context.bug.id}｜${context.bug.title}\n`)
        io.out(`  产品 ${context.bug.product || '-'}｜状态 ${context.bug.status || '-'}｜当前指派 ${context.bug.assignedTo || '-'}\n`)
        io.out(`  uid ${context.resolve.uid || '(缺失)'}｜必填 ${context.resolve.fields.filter((field) => field.required).map((field) => field.label).join('、')}\n`)
        io.out(`  默认值 ${Object.entries(context.resolve.defaults).filter(([, value]) => value !== '').map(([name, value]) => `${name}=${String(value).slice(0, 28)}`).join('  ')}\n`)
        io.out(`  选项规模 resolvedBuild ${context.resolve.optionCounts.resolvedBuild}／bugInchargedBy ${context.resolve.optionCounts.bugInchargedBy}／assignedTo ${context.resolve.optionCounts.assignedTo}\n`)
        io.out(`  解决方案 ${context.resolve.resolutionOptions.map((option) => option.value).join('/') || '-'}\n`)
        io.out(`  Bug原因 ${context.resolve.reasonOptions.map((option) => option.value).join('/') || '-'}\n`)
        for (const item of context.histories) io.out(`  · ${item}\n`)
        return 0
      }

      case 'resolve': {
        const bugID = parsed.positional[0]
        if (bugID === undefined) {
          io.err('zentao: 缺少 bugID\n')
          return 1
        }
        const dryRun = parsed.flags.get('dry-run') === true
        const run = await resolveBug(workbench, bugID, {
          resolution: flag(parsed, 'resolution'),
          reason: flag(parsed, 'reason'),
          detail: textValue(flag(parsed, 'detail'), io),
          impact: textValue(flag(parsed, 'impact'), io),
          comment: textValue(flag(parsed, 'comment'), io),
          build: flag(parsed, 'build'),
          assignedTo: flag(parsed, 'assigned-to'),
          inChargedBy: flag(parsed, 'in-charged-by'),
          force: parsed.flags.get('force') === true,
          dryRun,
        })
        io.out(asJson ? `${JSON.stringify({ plan: run.plan, outcome: run.outcome ?? null }, null, 2)}\n` : `${renderPlan(run.plan)}\n`)
        if (run.plan.blocked) {
          io.err('计划被拦，未提交。修正上面 ✘ 的项后重试（上下文已缓存，重试只花一次提交）。\n')
          return 2
        }
        if (dryRun) {
          io.out('（dry-run，未提交；去掉 --dry-run 即提交）\n')
          return 0
        }
        if (run.outcome?.ok === true) {
          io.out(`✔ 已解决并回读确认（状态：${run.outcome.status}）\n`)
          return 0
        }
        io.err(`✘ 服务端未接受（回读状态：${run.outcome?.status ?? '未知'}）\n`)
        if (run.outcome?.serverError) io.err(`服务端原文：${run.outcome.serverError}\n`)
        return 2
      }

      default:
        io.err(`zentao: 未知子命令 ${parsed.command}\n${USAGE}\n`)
        return 1
    }
  } catch (error) {
    // A dead session is the routine case, so print the same strategy report the
    // tools show rather than a bare message.
    if (error instanceof ZenTaoAuthError) {
      io.err(`${error.message}\n${renderStatus(error.status)}\n`)
      return 1
    }
    io.err(`zentao: ${(error as Error).message}\n`)
    return 1
  }
}
