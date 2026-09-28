/**
 * Synthetic fixtures that mirror the measured 10.6 markup.
 *
 * Deliberately synthetic rather than copied: the real pages carry a colleague's
 * names, internal product names and bug titles, and these tests only need the
 * structure. Every shape here was read off the live instance (see DESIGN.md §2).
 */

/** One row of `<table id="bugList">`; `resolution`/`resolvedBy` empty means open. */
export function bugRow(options: {
  id: string
  title: string
  severity?: string
  pri?: string
  type?: string
  openedBy?: string
  assignedTo?: string
  resolution?: string
  resolvedBy?: string
}): string {
  return `<tr>
  <td class="c-id"><div class="checkbox-primary"><input type='checkbox' name='bugIDList[]' value='${options.id}' /><label></label></div> ${options.id}</td>
  <td><span class='label-severity-custom' title='${options.severity ?? '主要'}' data-severity='3'>${options.severity ?? '主要'}</span></td>
  <td><span class='label-pri label-pri-${options.pri ?? '3'}' title='${options.pri ?? '3'}'>${options.pri ?? '3'}</span></td>
  <td title="${options.type ?? '需求逻辑问题'}">${options.type ?? '需求逻辑问题'}</td>
  <td class='text-left nobr'><a href='/index.php?m=bug&f=view&bugID=${options.id}' style='color:red'>${options.title}</a></td>
  <td>${options.openedBy ?? 'Reporter One'}</td>
  <td><span class="icon icon-hand-right" title="${options.assignedTo ?? 'dev.one'}">${options.assignedTo ?? 'Dev One'}</span></td>
  <td>${options.resolvedBy ?? ''}</td>
  <td>${options.resolution ?? ''}</td>
  <td><a href='#' class='btn iframe' title='确认'></a></td>
</tr>`
}

export function bugListPage(rows: string[]): string {
  return `<!DOCTYPE html><html><head><title>我的地盘::我的Bug - 禅道</title></head><body>
<div id="mainContent"><table class='table table-condensed table-hover table-striped tablesorter' id='bugList'>
<thead><tr><th>ID</th><th>级别</th><th>P</th><th>类型</th><th>Bug标题</th><th>创建</th><th>指派给</th><th>解决</th><th>方案</th><th>操作</th></tr></thead>
<tbody>${rows.join('\n')}</tbody></table></div></body></html>`
}

export function bugViewPage(options: {
  id: string
  title: string
  product?: string
  status?: string
  pri?: string
  assignee?: string
  resolvedBuild?: string
  solution?: string
  histories?: string[]
}): string {
  const histories = options.histories ?? []
  return `<!DOCTYPE html><html><head><title>BUG #${options.id} ${options.title} - ${options.product ?? 'DemoProduct'} - 禅道</title></head><body>
<table class='table'><tbody>
<tr><th>优先级</th><td>${options.pri ?? '3'}</td></tr>
<tr><th>Bug状态</th><td><span class='label label-active'>${options.status ?? '激活'}</span></td></tr>
<tr><th>当前指派</th><td>${options.assignee ?? 'Dev One'} 于 2026-08-18 16:27:16</td></tr>
<tr><th>解决版本</th><td>${options.resolvedBuild ?? ''}</td></tr>
<tr><th>解决方案</th><td>${options.solution ?? ''}</td></tr>
</tbody></table>
<ol class='histories-list'>
${histories.map((entry, index) => `<li value='${index + 1}'>${entry}</li>`).join('\n')}
</ol>
</body></html>`
}

export interface ResolveFormFixture {
  uid?: string
  /** Emitted as `<option value=… selected>` when it matches the default. */
  defaults?: Partial<Record<'resolution' | 'reason' | 'resolvedBuild' | 'bugInchargedBy' | 'assignedTo', string>>
  counts?: { resolvedBuild?: number, resolution?: number, reason?: number, people?: number }
  requiredJson?: string
  impact?: string
  detail?: string
  resolvedDate?: string
}

function select(name: string, count: number, selected: string | undefined, prefix: string): string {
  const options: string[] = []
  for (let i = 1; i <= count; i++) {
    const value = `${prefix}${i}`
    options.push(`<option value='${value}'${value === selected ? ' selected' : ''}>${prefix === '' ? '' : ''}${value}</option>`)
  }
  return `<select name="${name}" id="${name}">${options.join('')}</select>`
}

/** The resolve form as measured: `var kuid`, three required-declaring places, big dropdowns. */
export function resolveFormPage(fixture: ResolveFormFixture = {}): string {
  const uid = fixture.uid ?? 'kuid-example-1'
  const counts = fixture.counts ?? {}
  const people = counts.people ?? 3
  return `<html><body>
<script>var kuid = '${uid}'; var editor = {"id":["comment"],"requiredFields":"${fixture.requiredJson ?? ''}"};</script>
<form id="resolveForm" method="post">
  <input type="hidden" name="uid" value=" + kuid + " />
  ${select('resolution', counts.resolution ?? 3, fixture.defaults?.resolution ?? 'resolution0', 'resolution-')}
  <input type="text" name="duplicateBug" value="" />
  ${select('resolvedBuild', counts.resolvedBuild ?? 3, fixture.defaults?.resolvedBuild, 'build-')}
  <tr><td class='required'><select name="reason">${Array.from({ length: counts.reason ?? 3 }, (_, i) => `<option value='reason-${i + 1}'${`reason-${i + 1}` === (fixture.defaults?.reason ?? '') ? ' selected' : ''}>reason-${i + 1}</option>`).join('')}</select></td></tr>
  ${select('bugInchargedBy', people, fixture.defaults?.bugInchargedBy, 'user-')}
  <input type="text" name="resolvedDate" value="${fixture.resolvedDate ?? '2026-09-28 16:37:33'}" />
  ${select('assignedTo', people, fixture.defaults?.assignedTo, 'user-')}
  <textarea name="detail_reason">${fixture.detail ?? ''}</textarea>
  <textarea name="changeImpact">${fixture.impact ?? ''}</textarea>
  <textarea name="comment"></textarea>
</form></body></html>`
}

/** What this instance answers for any unauthenticated path — HTTP 200. */
export function loginRedirectPage(): string {
  return `<html><meta charset='utf-8'/><style>body{background:white}</style><script>self.location='/index.php?m=user&f=login&referer=L2luZGV4LnBocD9tPW15JmY9YnVn';</script></html>`
}

export function loginFormPage(): string {
  return `<html><body><form method="post" action="/index.php?m=user&f=login">
<input type="text" name="account" /><input type="password" name="password" />
</form></body></html>`
}

/** The login form as measured: plain `password` + a hidden `verifyRand`. */
export function loginPageFixture(verifyRand = '1134243522'): string {
  return `<html><body><form method='post' target='hiddenwin'>
  <input class='form-control' type='text' name='account' id='account' />
  <input class='form-control' type='password' name='password' />
  <input type='checkbox' name='keepLogin[]' value='on' id='keepLoginon' />
  <input type='hidden' name='referer' id='referer' value='' />
  <input type='hidden' name='verifyRand' id='verifyRand' value='${verifyRand}' />
</form></body></html>`
}

/** The measured refusal: HTTP 200, ~295 bytes, an alert naming the credentials. */
export function loginFailureFixture(message = '登录失败，请检查您的用户名或密码是否填写正确。'): string {
  return `<html><meta charset='utf-8'/><script>alert('${message}');self.location='/index.php?m=user&f=login';</script></html>`
}

/**
 * `m=project&f=task` — the empty branch is measured (eight projects probed);
 * the row branch is a SYNTHETIC sample mirroring the bug-list shape, because
 * this instance has no task rows anywhere to copy from.
 */
export function taskListPage(rows: string[] = []): string {
  if (rows.length === 0) {
    return `<html><head><title>【Demo】::任务列表 - 禅道</title></head><body>
<div id="mainContent"><div class="table-empty-tip">暂时没有任务。您现在可以 <a href="#">建任务</a></div></div></body></html>`
  }
  return `<html><head><title>【Demo】::任务列表 - 禅道</title></head><body>
<table class="table" id="taskList"><thead><tr><th>ID</th><th>任务名称</th><th>状态</th><th>指派给</th></tr></thead>
<tbody>${rows.join('\n')}</tbody></table></body></html>`
}

export function taskRow(options: { id: string, name: string, status?: string, assignedTo?: string }): string {
  return `<tr>
  <td class="c-id"><div class="checkbox-primary"><input type='checkbox' name='taskIDList[]' value='${options.id}' /><label></label></div> ${options.id}</td>
  <td><a href='/index.php?m=task&f=view&taskID=${options.id}'>${options.name}</a></td>
  <td>${options.status ?? '未开始'}</td>
  <td><span title="${options.assignedTo ?? 'dev.one'}">${options.assignedTo ?? 'Dev One'}</span></td>
</tr>`
}
