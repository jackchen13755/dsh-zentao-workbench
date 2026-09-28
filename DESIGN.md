# dsh-zentao-workbench 设计

参考 `@haoyu-qi/dsh-zentao` 的**架构形态**（Connection RPC 网关 + 悬浮面板 + agent 工具），
为**禅道 10.6 经典 `index.php` 表单链路**重做一个自研插件。目标不是"再抄一个面板"，
而是把会话历史里**禅道链路上真实烧掉的时间**收回来。

---

## 0. 一句话

> 把「读单 → 填解决表单 → 提交」从**模型反复试探**改成**一次读全、确定性填、可预演**，
> 并给它一个能看见连接状态与待办的面板。

---

## 1. 证据：为什么会有 retry≈42

来自 `dsh-plugin-gap-report.md`（本机全部会话日志分析）：

| 事实 | 数值 |
|---|---|
| 涉及 `<实例地址>` 的会话 | **92** |
| `zentao_resolve_bug` 调用次数 | **198** |
| `session-1ac15fef`：真实改码 vs 重试 | **6 次 edit，retry=42，全耗在解决表单字段试错** |
| `session-efb1384e` U7 | 「这是第 3 次执行相同操作了。一直没有首次就匹配到系统记忆」 |

本次侦察进一步定位到**机制层面**的原因（10.6 实测页面契约）：

| 原因 | 实测 |
|---|---|
| 选项规模远超模型可猜 | 解决表单 `resolvedBuild` **254** 个 option；`bugInchargedBy` / `assignedTo` **各 892** 个 |
| 必填项可被整字段略去 | `changeImpact` 在真实表单里为空；调用方不给时旧流程会**不带这个字段**提交 → 服务端拒绝（HTTP 200 + alert），模型再试一轮（探针实测复现） |
| 每次尝试两整页 | view 56 KB + 表单 255 KB，桥为单飞 |
| 必填项在 UI 上不显眼 | `changeImpact`（代码变更影响范围）必填、`bugInchargedBy` 必填；服务端拒绝时**仍返回 HTTP 200**，只在响应体里塞 `alert('…')` |
| 每次尝试的代价 | 2 次整页抓取：view（56 KB）+ resolve 表单（**255 KB**），列表页 361 KB；桥是单飞长轮询，重试串行 |
| `uid` 是 JS 变量不是 input 值 | `<input name="uid" value=" + kuid + ">`，真值在 `var kuid = '…'` |
| 登录态失效只在**失败时**才暴露 | 工具抛「浏览器未登录」；面板无状态可见 → 模型/用户都是事后才知道 |

---

## 2. 10.6 页面契约（本次实测，作为解析器规格）

### 2.1 我的 Bug 列表 `GET /index.php?m=my&f=bug`（361 KB）

`<table id="bugList">`，表头 10 列：`ID | 级别 | P | 类型 | Bug标题 | 创建 | 指派给 | 解决 | 方案 | 操作`

首行结构（可直接照此写解析器）：

```html
<td class="c-id"><div class="checkbox-primary">
  <input type='checkbox' name='bugIDList[]' value='55036' /><label></label></div> 55036</td>
<td><span class='label-severity-custom' title='主要' data-severity='3'>主要</span></td>
<td><span class='label-pri label-pri-3' title='3'>3</span></td>
<td title="需求逻辑问题">需求逻辑问题</td>
<td class='text-left nobr'><a href='/index.php?m=bug&f=view&bugID=55036' …>
<td>…创建人…</td>
<td><span class="icon icon-hand-right" title="dev.one">…</span></td>   <!-- 指派给 -->
<td></td><td></td>                                                       <!-- 解决/方案：未解决为空 -->
```

→ 抽取：`cells[0] input[value]` = bugID；`cells[1] title` = 级别；`cells[2] title` = 优先级；
`cells[3] title` = 类型；`cells[4] a[href]` + 文本 = 标题；`cells[6] [title]` = 指派给 login。

### 2.2 Bug 详情 `GET /index.php?m=bug&f=view&bugID=N`（56 KB）

`<title>BUG #55036 查询条件location浮层问题 - Service360 - 禅道` → 标题与**产品名**可直接取；
页内含「重现步骤」「历史记录」「解决版本」等区块。

### 2.3 解决表单 `GET /index.php?m=bug&f=resolve&bugID=N&onlybody=yes`（255 KB）

字段全清单（`name` / 类型 / 备注）：

| 字段 | 类型 | 备注 |
|---|---|---|
| `uid` | hidden | JS 模板 `'' + kuid + ''`；真值取 `var kuid = '…'` |
| `resolution` | select | 8 项，必填 |
| `reason` | select | 9 项，**required** |
| `resolvedBuild` | select | **254 项** |
| `buildProject` | select | 5 项 |
| `buildName` / `createBuild` / `duplicateBug` / `labels[]` / `files[]` | text/checkbox/file | 条件字段 |
| `bugInchargedBy` | select | **892 项**，服务端必填 |
| `assignedTo` | select | **892 项** |
| `resolvedDate` | text | 已预填当前时间 |
| `detail_reason` | textarea | ≤ **512** 字（按码点，对齐 PHP `mb_strlen`） |
| `changeImpact` | textarea | 服务端必填 |
| `comment` | textarea | |
| `openedBuild`×4 / `task` / `story` | select | 0 项（联动/隐藏） |

### 2.4 我的任务 `GET /index.php?m=my&f=task`

本机实测**无表格、无「暂无」文案**（当前账号无指派任务）→ 解析器必须优雅降级为空态，
并在实现期核对 `type=assignedTo` 等路由变体。

---

## 3. 架构（三件套，形态抄 dsh-zentao、数据通道换掉）

```
┌─ 浏览器面板（client.js）───────────────────────────────────┐
│ 悬浮入口（可拖动）· 连接状态灯 · 我的 Bug 列表               │
│ 点击行 → 详情卡 · 拖拽 → 插入引用 · 「处理」→ 按角色起会话    │
└───────────────┬───────────────────────────────────────────┘
                │ rpc.call('/zentao', endpoint, payload)
┌───────────────▼─── Host 网关（lib/index.js）───────────────┐
│ inject: connection · tools · systemPrompt · subprocess      │
│ ① SessionProvider：浏览器桥 → Chrome cookie jar → 表单账密  │
│ ② 解析器：my-bug / view / resolve-form / my-task            │
│ ③ BugContext 缓存（TTL + 提交后失效）                        │
│ ④ RPC: getConfig/login/refresh/fetchDetail/resolveBug/clear │
│ ⑤ 工具：zentao_my_bugs / zentao_bug_context / zentao_resolve_bug │
└───────────────┬───────────────────────────────────────────┘
                │ 复用 dsh-fetch-page 的扩展桥（127.0.0.1:9317）
                ▼           或 cookie jar + curl 兜底
        zentao.example.com（10.6 经典 index.php）
```

`inject` 只用四个宿主服务（`subprocess` 用于 curl 兜底；桥走 HTTP 到本地 daemon）。

---

## 4. 登录链（用户指定：桥优先，其余兜底）

四段式 `SessionProvider`，**每次请求前**按序探测，命中即用，全部失败 → `unauthenticated`：

| 序 | 策略 | 说明 | 现状 |
|---|---|---|---|
| ① | **浏览器插件桥** | `POST 127.0.0.1:9317/forward`，扩展自动带 Cookie，**无需 Chrome Cookie 权限** | 已有能力；实测当前 daemon 在、扩展未轮询 → 需先探活并给出"请确认扩展已连接"的提示 |
| ② | **Chrome cookie jar** | `zentao-export-cookies`（Keychain 解密 → Netscape jar） | **本次实测当场可用**（新导出 10 个 cookie，页面 366 KB 真内容）；旧 jar 因 `zentaosid` 是 session cookie 已失效 |
| ③ | **表单账密登录** | `POST /index.php?m=user&f=login`（account/password/keepLogin，必要时 `verifyRand`）→ 取 `Set-Cookie: zentaosid` | 待实现（10.6 需实测字段） |
| ④ | **手工注入** | 直接塞 `zentaosid` / cookie 串（对应 dsh-zentao 的 `request.token` 旁路） | 待实现 |

**未登录时**（用户明确要求"做显示提示"）：
- 面板：状态灯显示「未登录」+ 一行**可操作**提示（"扩展未连接 → 点这里检查；或改用 cookie 导出"），
  并给出当前四条策略各自的探测结果（哪条失败、失败原因），而不是只报"未登录"。
- 工具：`zentao_session_status` 单独可查；其它工具在未登录时**返回同一份自解释提示**（含下一步动作）。
- 失效探测：任何一次请求跳登录页（10.6 的指纹是 `<script>self.location='/index.php?m=user&f=login…'`）
  → 立刻把该策略标记为失效并尝试下一策略，**不把失效态抛给模型当成任务失败**。

凭据纪律（抄 dsh-zentao 的纪律，改掉它的落盘方式）：
- 密码只在登录调用期间存在于内存，成功即清；
- **cookie/token 不写插件配置文件**，落 `~/.dsh/.credentials.yaml`（或该实例的 cookie jar，0600）；
- 服务端地址归一化：去尾斜杠、剥 `/api.php(/vN)?` 与 `/index.php`、无 scheme 补 `https://`；
- 所有出站请求宿主侧执行（超时/输出上限/abort），面板不直接发 HTTP。

---

## 5. 压 retry 的核心设计（本插件的重点）

### 5.1 一次读全：`zentao_bug_context`

一次调用返回**模型真正需要的全部信息**，且**只返回需要的**：

```jsonc
{
  "bug": { "id": "55036", "title": "…", "product": "Service360", "status": "激活",
           "severity": "主要", "pri": "3", "type": "需求逻辑问题",
           "assignedTo": "dev.one", "openedBy": "Reporter One", "url": "…" },
  "resolveForm": {
    "uid": "…",                          // 从 var kuid 取，取不到就明确报错而不是提交后被打回
    "required": ["resolution", "reason", "bugInchargedBy", "changeImpact"],
    "defaults": {                        // ← 确定性默认值，模型不用猜
      "resolution": "fixed", "reason": "codeBug",
      "bugInchargedBy": "dev.one",      // 表单当前选中项（服务端必填）
      "assignedTo": "Reporter One",
      "resolvedBuild": { "value": "6780", "text": "xx.1" },   // 最近一次解决版本 → 表单默认
      "resolvedDate": "2026-09-28 16:37:33"
    },
    "limits": { "detail_reason": 512 },
    "buildMatches": [ { "value": "6780", "text": "xx.1" } ]   // 只回传命中的，不是 254 个
  },
  "recentActions": [ … ],                 // 历史里最近一次解决/评论，供写 detail 用
  "cachedAt": "…"
}
```

与现状的差别（每一条都对着 §1 的原因）：
- **254 → 命中项**：`buildMatches` 只回传匹配上的 option（**说明**：254 项是旧工具内部做名称→ID 映射用的，它的返回值里并没有这些选项；这里是本插件的设计选择，不是修复旧工具的溢出）；
- **892 项大 select 不再进上下文**：只给"当前选中值"，需要改名时才按需 `optionQuery`；
- **必填项前置**：`required[]` 一次说清，模型不必被服务端 `alert` 教第二遍；
- **默认值补齐**：模型只提供它必须决策的（解决方案/原因/文案），其余由网关填。

### 5.2 幂等与"假成功"防护

- 提交前本地校验（现有工具已验证的两条：`changeImpact` 非空、`detail_reason` ≤512 码点）；
- 服务端 `alert('…')` **原文透传**（10.6 用 HTTP 200 + alert 拒绝）；
- 提交后**回读状态**判定成功，而不是看 HTTP 码；
- `dryRun` 默认建议路径：`zentao_bug_context` → 模型补三个字段 → `resolveBug(dryRun)` → 实提。

### 5.3 缓存与失效

- 解析结果按 `bugID` 缓存（TTL 默认 10 分钟）+ 提交成功后**立即失效该单**；
- 列表页缓存 TTL 更短（60 秒），面板"立即刷新"可绕过；
- 失效触发：跳登录页 / uid 变化 / 提交成功。

---

## 6. 面板（形态参考 dsh-zentao，交互照抄它有效的部分）

| 元素 | 做法 | 抄自 |
|---|---|---|
| 悬浮入口 | 挂在对话区、可拖动、位置自适应对齐 | dsh-zentao |
| 状态灯 | 未登录 / 连接中 / 已连接 / 异常，**带文字** | dsh-zentao |
| 列表面板 | 我的 Bug（`#bugList` 解析）：ID/级别/P/类型/标题/指派给；支持"立即刷新"与间隔轮询 | dsh-zentao 的列表 + 我们的解析器 |
| **点击行** | 打开详情卡：标题、状态、重现步骤、历史最近 5 条；**卡内直接开解决表单的预填视图**（只读预览） | 用户要求"直接点击 bug" |
| 拖拽 | 拖到输入框 → 插入**紧凑可编辑 Markdown 引用**（编号+标题+状态+优先级+原始链接），并注明"处理前先取最新详情" | dsh-zentao（"引用而非复制"） |
| 「处理」按钮 | 按角色（开发/测试/产品/管理）预设提示词 + 条目内容 → 当前项目新建会话并自动发出 | dsh-zentao |
| 未登录态 | 面板主体替换为"四策略探测结果 + 下一步动作" | 用户要求 |

面板**只读**：任何写操作都必须经工具，且默认 `dryRun`。

---

## 7. 工具面（4 个）

| 工具 | 作用 | 关键点 |
|---|---|---|
| `zentao_session_status` | 登录态与四策略探测结果 | 未登录时的统一解释入口 |
| `zentao_my_bugs` | 我的 Bug 列表（可 `status` 过滤、`limit`） | 结构化，不回传 HTML |
| `zentao_bug_context` | **一次读全**（§5.1） | 压 retry 的主力 |
| `zentao_resolve_bug` | 解决（`dryRun` 优先） | 复用 dsh-fetch-page 已跑通的实现，按 §5.2 加固 |

与现有资产的关系（**不重复造**）：
- 桥、`uid`/表单解析、字段规则、server alert 透传 —— 已有实现在 `dsh-fetch-page/dsh-plugin/src/index.ts`，
  **抽成共享模块/直接复用**，本插件只补"一次读全 + 缓存 + 面板 + 登录链"；
- `~/.local/bin/zentao-resolve-bug` CLI 同步收口：优先桥、兜底 jar，并加 `--context`（打印 §5.1 的 JSON）
  与 `--dry-run` 默认化，让 CLI 与工具走同一套解析。

---

## 8. 验证计划

| 层 | 手段 |
|---|---|
| 解析器 | 固定 HTML fixtures（本次已抓到的真实页面片段）跑单测：列表行/详情/表单字段与 uid |
| 登录链 | 四策略各自单测 + 实测：① 桥 down 时报可操作提示 ② jar 失效时自动降级 ③ 表单登录（实现后实测） |
| 工具 | `zentao_bug_context` 对真实单返回 ≤ N KB（对比现状 255 KB 原始 HTML）；`resolveBug(dryRun)` 逐字段核对 |
| 端到端 | 先在**真单**上 `dryRun` 全流程，再挑一个真实 bug 走完整解决（用户指定单号） |
| 面板 | 浏览器实机：未登录态提示、列表渲染、点击详情、拖拽引用（照 `frontend-verify` 口径） |

---

## 9. 风险与边界

- **凭据**：cookie 是会话凭据，必须 0600、不进 git、不进日志（本机 `dsh-defend` 会在写文件/上传远端拦密钥形态；读 cookie 由用户既有工具完成）；
- **会话失效**：`zentaosid` 是 session cookie，浏览器关掉即失效 → 面板必须把"失效"当常态而非异常；
- **单飞桥**：扩展长轮询串行，面板轮询与工具调用会互相排队 → 网关侧合并请求（同一 bug 的并发读只发一次）；
- **实例只读默认**：面板不写；工具默认 `dryRun`；
- **不做**：不改禅道、不装禅道插件、不依赖 REST（10.6 无 v1/v2，实测确认）。

---

## 10. 分阶段

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M1** | SessionProvider + 解析器 + 三个读工具 + 一次成解决规划 | ✅ 实机：列 Bug、上下文 1792B vs 表单 255592B、真单 dryRun `blocked=false` |
| **M2** | CLI（与工具同一套解析）+ 修两个实机暴露的 bug | ✅ 实机四子命令；env 与失效判定两个 bug 已修并补测 |
| **M3** | 面板：宿主 RPC（只读默认 + confirm 门禁）+ 浏览器半边（含一键刷新） | ✅ 代码与 loader 契约测试通过；**浏览器实机待重启后确认** |
| **M4** | 表单账密登录 + 手工注入 | ✅ 登录链路实机验证（错误凭据→服务端判词）；手工注入走 `ZENTAO_COOKIE` |

### 实测补充（实现期新增的证据）

- 登录契约：`POST /index.php?m=user&f=login`（`account`/`password`/`keepLogin[]`/`referer`/`verifyRand`）。
  页面里的 `md5(md5(password)+rand)` 挂在并不存在的 `#verifyPassword` 上 → 表单发明文；
  **失败时也会下发 `zentaosid`**，所以必须回读真实页面判成功；服务端点名凭据错误时**不再试**第二种编码。
- 面板刷新：一次刷新「状态 + 列表 + 打开的详情 + 已生成的计划」，因为只刷列表会让卡片继续显示过期字段。
- 任务列表：可用路由是 **`m=project&f=task[&projectID=N]`**（`m=my&f=task`、`m=task&f=browse`
  都是空页/跳转）。但 8 个项目逐个探测**全部返回「暂时没有任务」** → 本实例没有任务行样本，
  因此行解析只对合成样本测过并明确标注未验证；空态改用实测标记判定，形状不符时返回空数组。
  面板「任务」页签显示真实原因，避免被读成解析失败。

命名：暂定 `dsh-zentao-workbench`（可改）。位置：`~/Desktop/dsh/github/dsh-zentao-workbench`。
