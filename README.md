# dsh-zentao-workbench

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的禅道工作台，面向**经典 `index.php` 时代的实例**（实测 10.6：nginx + PHP 5.6 + 经典前控器，**没有** REST v1/v2）。

它存在的理由只有一个：**把「读单 → 填解决表单 → 提交」从模型反复试探改成一次成。**

## 为什么要重做

同一个实例上的历史数据（`dsh-plugin-gap-report.md`，本机全部会话日志）：

| 事实 | 数值 |
|---|---|
| 涉及 `<实例地址>` 的会话 | 92 |
| `zentao_resolve_bug` 调用次数 | 198 |
| 某会话真实改码 vs 重试 | **6 次 edit，retry=42，全耗在解决表单字段试错** |

机制层面的原因（都在 10.6 上量过）：

| 原因 | 实测 |
|---|---|
| 选项规模远超可猜 | `resolvedBuild` **254** 项；`bugInchargedBy` / `assignedTo` **各 892** 项 |
| 旧工具把 254 个选项全塞进结果 | 每次多约 11 KB |
| 必填项靠服务端教第二遍 | `changeImpact` 在真实表单里**是空的**，服务端拒绝时仍返回 HTTP 200 + `alert()` |
| 每次尝试两整页 | 详情 56 KB + 解决表单 **255 KB**，且桥是单飞长轮询 |
| `uid` 不是 input 值 | 真值在 `var kuid = '…'` |

## 本版怎么解

1. **一次读全，而且只给需要的**：`zentao_bug_context` 返回详情 + 表单 uid + 必填项 + 默认值 + 枚举可选值。
   实测同一条单：**上下文 1792 字节 vs 原始表单 255,592 字节**（0.7%），254 项下拉只回传命中项。
2. **确定性补齐，不让人猜**（`src/resolve.ts` 的 `planResolve`，纯函数）：
   - `changeImpact` 为空时**必**产出值（服务端必填），并在 `autoFilled` 里说明是自动填的；
   - `bugInchargedBy`（892 项必填）先用表单当前选中，表单没选就回退到详情页的**当前指派**；
   - `detail_reason` 超 512 字在**同一次调用内**按句末截断并报告压缩前后字数；
   - 枚举写错时列出该表单的合法取值，而不是提交后被服务端打回。
3. **假成功防护**：本地校验 → 服务端 `alert` 原文透传 → **提交后回读状态**判定（HTTP 码证明不了任何事）。
4. **重试只花一次 POST**：失败的提交**保留**上下文缓存，修正后重试不再重抓两页（有单测钉住这条不变量）；只有回读确认成功才失效缓存。
5. **登录四策略**（顺序即优先级）：① 浏览器插件桥（扩展自动带 Cookie）→ ② Chrome cookie 导出 → ③ 表单账密（M4）→ ④ 手工注入。
   未登录时返回**每条策略各探测到什么 + 下一步做什么**，而不是一句"未登录"。

## 工具

| 工具 | 作用 |
|---|---|
| `zentao_session_status` | 登录态与四策略探测结果（任何工具报未登录时先看它） |
| `zentao_my_bugs` | 我的 Bug 列表（结构化，不回传 HTML；`only=open/resolved`） |
| `zentao_tasks`* | 项目任务列表（`m=project&f=task`）。**实测本实例 8 个项目全部无任务** → 空态如实说明；行解析未在真实数据上验证（见下） |
| `zentao_bug_context` | 一次读全一条单的解决上下文 |
| `zentao_resolve_bug` | 解决：计划 → 本地校验 → 提交 → 回读验证（建议先 `dryRun`） |

CLI（`bin/zentao.mjs`，与工具共用同一套解析）：

```
zentao status                     # 四条登录路径各探测到什么
zentao bugs [--only open]         # 我的 Bug
zentao tasks [--project 187]      # 项目任务（本实例为空，会说明原因）
zentao context <bugID> [--json]   # 一次读全
zentao resolve <bugID> [--dry-run]
zentao login --account A          # 口令读 ZENTAO_PASSWORD 或 --password-stdin
```

浏览器半边（`lib/client.js`）：可拖动悬浮入口 + 我的 Bug 列表 + 点击开详情卡 +
拖拽/复制 Markdown 引用 + 「预览解决计划」+ 按角色「处理」起会话。
**工具栏「刷新」一次刷新「会话状态 + 列表 + 打开的详情 + 已生成的计划」**，页脚显示
最近更新时间，并可选 1/5/15/30 分钟自动刷新。未登录时面板主体就是四策略探测报告
（每条带下一步动作）+ 账密登录表单。面板默认只读：提交需二次确认。

## 安装

```sh
/usr/local/bin/node node_modules/typescript/bin/tsc -p tsconfig.build.json   # 或 pnpm build
```

CLI 管理的 profile 用 `dsh plugin --profile web add <dir>`；`desktop` profile 由 Electron 独占，
按 `package.json` 的 `dependencies` 加 `link:` + `cordis.patch.yml` 里加一行（`name: dsh-zentao-workbench`）接线，重启生效。

## 四策略的验证矩阵（真实实例，逐条隔离实测）

| 策略 | 状态 | 隔离条件与结果 |
|---|---|---|
| ① 浏览器插件桥 | ✅ 实测 | 正常环境：`bugs` 经「bridge」取到 29 条（273ms） |
| ② Chrome cookie 导出 | ✅ 实测 | 桥指到死端口（`DAEMON_URL=http://127.0.0.1:9`）、无注入、无账密 → 仍报「已登录 · 走 Chrome cookie 导出」并取到 29 条 |
| ③ 表单账密登录 | ⚠ 部分 | 失败路径实测（服务端判词原文回显）；**成功路径需真口令，未验** |
| ④ 手工注入 | ✅ 实测 | 桥死 + jar 为过期文件 → 经「manual」取到数据 |

顺带实测到一次真实的降级：默认 jar（9/23 导出、`zentaosid` 会话级）已失效时，
会话不会报"未登录"了事，而是标记该策略失效并落到下一条 —— 这正是设计要的行为。

## 写路径怎么验证（不改动任何单据）

所有写路径默认只跑 `dryRun`。要证明真实 POST 也能工作，用这个探针 —— 它走生产代码
路径（`planResolve` → `submitResolve`），但**故意让服务端必拒**：删掉必填的
`changeImpact` 并破坏 `uid`，所以即便这个版本忽略 uid 校验，缺必填也无法被接受。

```sh
node scripts/probe-write-path.mjs 55036        # 需要会话（ZENTAO_* 环境变量或 cookie jar）
```

实测结果（真单 55036 / 55035）：`ok=false`、服务端原文「『代码变更影响范围』不能为空。」、
回读状态与提交前一致 → **单据未被改动**，退出码 0。
这条同时独立证实了本插件要修的那个 retry 根源：服务端在缺 `changeImpact` 时确实会拒绝。

## 本机注意

DSH 自带的 node（`~/.dsh/dsh-runtimes/*/dependencies/node`）带签名且开启 library validation，
**无法 dlopen 第三方原生模块**（vitest 的 rolldown 会报 "Cannot find native binding"）。
构建与测试请用系统 node：`/usr/local/bin/node node_modules/vitest/vitest.mjs run`。

## 配置

```yaml
- id: zentao-workbench
  name: dsh-zentao-workbench
  config:
    server: https://zentao.example.com      # 实例地址（路径/后缀会被剥掉）
    bridgeUrl: http://127.0.0.1:9317 # 浏览器转发 daemon
    cookieJarPath: ~/.config/zentao/cookies.txt   # 只填「路径」，不要填 cookie 值
```

凭据纪律：**cookie 值不写进插件配置**，只经 cookie jar 文件或环境变量 `ZENTAO_COOKIE` 传入。

## 状态

四个里程碑都已落地：M1 会话链/解析器/读工具 + 一次成解决规划；M2 CLI；M3 面板
（宿主 RPC + 浏览器半边，含一键刷新）；M4 表单账密登录。**64 个单测通过**，
host+client typecheck clean，并在真实实例上核对：我的 Bug 列表（经桥）、单条上下文
（1792 字节 vs 原始表单 255592 字节）、真实单据 dryRun（`blocked=false`）、
登录链路（错误凭据得到服务端原文判词）。

尚未验证：面板在浏览器里的实机渲染（需重启 DSH）、以及一次**真实提交**（需指定一个
可解决的 bug）。

**任务列表的诚实边界**：路由 `m=project&f=task`、过滤器与空态标记「暂时没有任务」都是
实测的；但本实例**没有任何任务行**（8 个项目逐个探过，全为空），所以 `parseTaskList` 的
行分支只对着合成样本测过 —— 它镜像实测的 Bug 列表形状，形状不符时返回空数组而不是
臆造数据。面板「任务」页签会如实显示"没有任务数据，不是解析失败"。见 [DESIGN.md](DESIGN.md)。

MIT。
