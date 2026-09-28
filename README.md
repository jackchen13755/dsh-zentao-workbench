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
| `zentao_bug_context` | 一次读全一条单的解决上下文 |
| `zentao_resolve_bug` | 解决：计划 → 本地校验 → 提交 → 回读验证（建议先 `dryRun`） |

## 安装

```sh
/usr/local/bin/node node_modules/typescript/bin/tsc -p tsconfig.build.json   # 或 pnpm build
```

CLI 管理的 profile 用 `dsh plugin --profile web add <dir>`；`desktop` profile 由 Electron 独占，
按 `package.json` 的 `dependencies` 加 `link:` + `cordis.patch.yml` 里加一行（`name: dsh-zentao-workbench`）接线，重启生效。

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

M1（会话链 + 解析器 + 三个读工具 + 压 retry 的 resolve 规划）已完成，27 个单测通过，
并在真实实例上核对：列表、上下文、真实单据 dryRun（`blocked=false`）。
M2：resolve 收口与 CLI；M3：悬浮面板；M4：表单账密登录。见 [DESIGN.md](DESIGN.md)。

MIT。
