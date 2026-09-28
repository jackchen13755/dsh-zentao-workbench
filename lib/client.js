window.__ModuleLoader__.load({
	id: "dsh-zentao-workbench",
	factory: (require) => {
		var __factories = [];
		var __cache = {};
		function __require(id) {
			if (__cache[id] === undefined) __cache[id] = __factories[id]();
			return __cache[id];
		}
__factories[0] = function () {
var module = { exports: {} }; var exports = module.exports;
"use strict";
/**
 * dsh-zentao-workbench — browser half.
 *
 * Mounts a floating workbench into the shell's overlay slot, the same seat
 * `@haoyu-qi/dsh-zentao` uses (measured to work on this host): a draggable entry
 * that opens a panel listing the bugs assigned to me, with a detail card, a
 * resolve-plan preview, and a "处理" button that opens a conversation with the
 * item already quoted.
 *
 * All data comes from the host's `/zentao` RPC channel — the browser never talks
 * to ZenTao directly, so no cookie ever reaches the page.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const react_1 = require("react");
const panel_js_1 = __require(1);
/**
 * Services this half must have before its first render.
 *
 * Deliberately NOT `sessions` / `workspaces`: only the "处理" button needs them,
 * and a missing client-runtime package must not stop the whole panel from
 * mounting. (Measured: `@deepseek-ai/dsh-client-runtime` is not a host package —
 * dsh-zentao carries its own copy — so hard-depending on it would be fragile.)
 */
exports.inject = ['slots', 'connection'];
/**
 * Open a fresh conversation in the current workspace and send `text` verbatim.
 * Mirrors dsh-zentao's flow so the "处理" button behaves the way it does there.
 */
function buildHandlePrompt(ctx) {
    return async (text) => {
        const sessions = ctx.get?.('sessions');
        const workspaces = ctx.get?.('workspaces');
        if (sessions === undefined || workspaces === undefined) {
            throw new Error('会话服务不可用（sessions/workspaces 未加载）：请改用「复制引用」把这条单据贴进对话');
        }
        const workspaceSnapshot = workspaces.list.getSnapshot();
        const current = sessions.list.getSnapshot().current;
        const target = (current === undefined
            ? undefined
            : workspaceSnapshot.items.find((item) => item.sessionIds.includes(current))?.workspaceId)
            ?? workspaceSnapshot.recentWorkspaceId;
        if (target === undefined)
            throw new Error('未找到当前项目（workspace），请先打开一个项目');
        const sessionId = await workspaces.connectWorkspace(target);
        sessions.open(sessionId);
        const scoped = sessions.scope(sessionId);
        if (scoped === undefined)
            throw new Error('新建会话失败：无法解析会话作用域');
        const conversation = scoped.get('conversation');
        if (conversation === undefined)
            throw new Error('conversation 服务不可用，请确认 Web 对话插件已加载');
        await conversation.send(text);
    };
}
function apply(ctx) {
    const deps = {
        rpc: ctx.connection.rpc,
        handlePrompt: buildHandlePrompt(ctx),
    };
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'zentao-workbench', order: 12 }, (props) => (0, react_1.createElement)(panel_js_1.ZentaoPanel, { ...props, ...deps })));
}

return module.exports;
};
__factories[1] = function () {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.name = void 0;
exports.ZentaoPanel = ZentaoPanel;
/**
 * The workbench panel: a draggable floating entry that opens my-bug list, a
 * detail card, and a resolve-plan preview.
 *
 * Design rules it follows (both from the session-history findings):
 *  · **read-only by default** — planning is free, submitting asks first;
 *  · **never a dead end** — when the session is gone the panel body *is* the
 *    four-strategy report with the next action per strategy, because "未登录"
 *    on its own is what made the old flow waste turns.
 */
const react_1 = require("react");
/**
 * Layout follows the reference plugin (`@haoyu-qi/dsh-zentao`'s client half,
 * read from its own bundle): a vertical tab glued to the right edge plus a
 * right-edge drawer, positioned **only** with CSS.
 *
 * Why this replaced viewport math: a transformed/filtered ancestor becomes the
 * containing block for `position: fixed`, so computing `left` from
 * `window.innerWidth` put the entry outside the clipped overlay the moment the
 * shell was maximized (measured: entry landed at the container's left edge,
 * x=5). `right: 0` + `top: 50%` cannot drift, in any container, at any size.
 */
const FAB_TEXT = '禅道';
const ROLE_PRESETS = [
    { key: 'dev', label: '开发', prompt: (ref) => `${ref}\n\n请按开发角度处理这个 Bug：先复现、定位根因、给出最小改动修复并自测，必要时补充用例。` },
    { key: 'qa', label: '测试', prompt: (ref) => `${ref}\n\n请按测试角度处理：核对修复是否覆盖原始复现步骤，列出回归范围与验证步骤。` },
    { key: 'pm', label: '产品', prompt: (ref) => `${ref}\n\n请按产品角度处理：确认预期行为与验收标准，指出需求或交互上需要澄清的点。` },
];
/**
 * Theme tokens, copied from the reference plugin's stylesheet so the drawer
 * follows the shell's own light/dark theme instead of a hardcoded palette.
 * (My first version invented `--dsw-alias-text-1` / `-bg-2`; those names do not
 * exist, so every colour silently fell back to the hardcoded value.)
 */
const TOKEN = {
    text: 'var(--dsw-alias-label-primary, #111)',
    dim: 'var(--dsw-alias-label-secondary, #888)',
    line: 'var(--dsw-alias-border-l1, #e5e7eb)',
    bg: 'var(--dsw-alias-bg-layer-1, #fff)',
    accent: '#2563eb',
    danger: '#dc2626',
    ok: '#16a34a',
};
const box = {
    background: TOKEN.bg,
    color: TOKEN.text,
    border: `1px solid ${TOKEN.line}`,
    borderRadius: 10,
    boxShadow: '0 8px 28px rgba(0,0,0,.35)',
    fontFamily: 'system-ui,-apple-system,"PingFang SC",sans-serif',
    fontSize: 13,
};
/**
 * The instance origin is needed to turn the list page's relative `href` into a
 * link a reader (or the model) can actually open. It comes from the RPC config —
 * never hardcoded, because the same plugin is used against different instances.
 */
function absoluteUrl(server, hrefOrUrl) {
    if (hrefOrUrl === '')
        return '';
    if (/^https?:\/\//i.test(hrefOrUrl))
        return hrefOrUrl;
    return `${server.replace(/\/+$/, '')}${hrefOrUrl.startsWith('/') ? '' : '/'}${hrefOrUrl}`;
}
function referenceOf(bug, extra) {
    return [
        `【禅道 Bug #${bug.id}】${bug.title}`,
        `状态 ${bug.status ?? '-'}｜优先级 ${bug.pri ?? '-'}${extra?.severity ? `｜级别 ${extra.severity}` : ''}｜指派 ${bug.assignedTo ?? '-'}`,
        bug.url ? `原始链接 ${bug.url}` : '',
        '（处理前请先用 zentao_bug_context 读取该单最新详情与解决表单默认值）',
    ].filter((line) => line !== '').join('\n');
}
function ZentaoPanel(deps) {
    const [open, setOpen] = (0, react_1.useState)(false);
    const [config, setConfig] = (0, react_1.useState)(null);
    const [bugs, setBugs] = (0, react_1.useState)([]);
    const [only, setOnly] = (0, react_1.useState)('open');
    const [intervalMin, setIntervalMin] = (0, react_1.useState)(5);
    const [busy, setBusy] = (0, react_1.useState)('');
    const [error, setError] = (0, react_1.useState)('');
    const [selected, setSelected] = (0, react_1.useState)(null);
    const [plan, setPlan] = (0, react_1.useState)(null);
    const [flash, setFlash] = (0, react_1.useState)('');
    const [lastUpdated, setLastUpdated] = (0, react_1.useState)(null);
    const [tab, setTab] = (0, react_1.useState)('bugs');
    const [bugsTotal, setBugsTotal] = (0, react_1.useState)({ total: 0, truncated: false });
    const [tasks, setTasks] = (0, react_1.useState)([]);
    const [taskNote, setTaskNote] = (0, react_1.useState)('');
    const [serverDraft, setServerDraft] = (0, react_1.useState)('');
    const [account, setAccount] = (0, react_1.useState)('');
    const [password, setPassword] = (0, react_1.useState)('');
    const call = (0, react_1.useCallback)(async (endpoint, payload) => {
        const result = await deps.rpc.call('/zentao', endpoint, payload);
        if (!result.ok)
            throw new Error(result.error.message);
        return result.value;
    }, [deps.rpc]);
    const refreshStatus = (0, react_1.useCallback)(async (force = true) => {
        setBusy('status');
        try {
            const status = await call('sessionStatus', { refresh: force });
            setConfig({ ...(status.config ?? status), probes: status.probes ?? status.config?.probes ?? [] });
            setError('');
        }
        catch (problem) {
            setError(problem.message);
        }
        finally {
            setBusy('');
        }
    }, [call]);
    const refreshBugs = (0, react_1.useCallback)(async (force = false) => {
        setBusy('bugs');
        try {
            const value = await call('listBugs', { limit: 30, only, refresh: force });
            setBugs(value.bugs);
            setBugsTotal({ total: value.total, truncated: value.truncated === true });
            setError('');
        }
        catch (problem) {
            setError(problem.message);
        }
        finally {
            setBusy('');
        }
    }, [call, only]);
    /**
     * One refresh that covers everything currently visible: the session status,
     * the list, and — when a card is open — its detail and its planned resolve.
     * A bare list refresh left the open card showing stale fields, which is the
     * kind of half-truth the panel exists to avoid.
     */
    const refreshAll = (0, react_1.useCallback)(async (force) => {
        setBusy('all');
        try {
            const status = await call('sessionStatus', { refresh: force });
            const next = { ...(status.config ?? status), probes: status.probes ?? status.config?.probes ?? [] };
            setConfig(next);
            if (next.authenticated) {
                const listed = await call('listBugs', { limit: 30, only, refresh: force });
                setBugs(listed.bugs);
                if (tab === 'tasks') {
                    const taskValue = await call('listTasks', { limit: 30 });
                    setTasks(taskValue.tasks);
                    setTaskNote(taskValue.note);
                }
                if (selected !== null) {
                    setSelected(await call('bugContext', { bugID: selected.bug.id, refresh: force }));
                    if (plan !== null) {
                        const replanned = await call('resolvePlan', { bugID: selected.bug.id });
                        setPlan(replanned.plan);
                    }
                }
            }
            setLastUpdated(new Date());
            setError('');
        }
        catch (problem) {
            setError(problem.message);
        }
        finally {
            setBusy('');
        }
    }, [call, only, tab, selected, plan]);
    const refreshTasks = (0, react_1.useCallback)(async () => {
        setBusy('tasks');
        try {
            const value = await call('listTasks', { limit: 30 });
            setTasks(value.tasks);
            setTaskNote(value.note);
            setError('');
        }
        catch (problem) {
            setError(problem.message);
        }
        finally {
            setBusy('');
        }
    }, [call]);
    (0, react_1.useEffect)(() => { void refreshStatus(true); }, [refreshStatus]);
    (0, react_1.useEffect)(() => {
        if (!open || config?.authenticated !== true)
            return undefined;
        if (lastUpdated === null)
            void refreshAll(false);
        if (tab === 'tasks' && tasks.length === 0 && taskNote === '')
            void refreshTasks();
        if (intervalMin <= 0)
            return undefined;
        const timer = window.setInterval(() => { void refreshAll(true); }, intervalMin * 60_000);
        return () => window.clearInterval(timer);
    }, [open, config?.authenticated, intervalMin, refreshAll, lastUpdated, tab, tasks.length, taskNote, refreshTasks]);
    (0, react_1.useEffect)(() => {
        if (flash === '')
            return undefined;
        const timer = window.setTimeout(() => setFlash(''), 2400);
        return () => window.clearTimeout(timer);
    }, [flash]);
    const openDetail = (0, react_1.useCallback)(async (bugID) => {
        setBusy(`detail:${bugID}`);
        setPlan(null);
        try {
            setSelected(await call('bugContext', { bugID }));
            setError('');
        }
        catch (problem) {
            setError(problem.message);
        }
        finally {
            setBusy('');
        }
    }, [call]);
    const previewPlan = (0, react_1.useCallback)(async (bugID) => {
        setBusy('plan');
        try {
            const value = await call('resolvePlan', { bugID });
            setPlan(value.plan);
            setError('');
        }
        catch (problem) {
            setError(problem.message);
        }
        finally {
            setBusy('');
        }
    }, [call]);
    const insert = (0, react_1.useCallback)(async (text, label) => {
        try {
            await navigator.clipboard.writeText(text);
            setFlash(`${label}已复制到剪贴板；也可以直接把它拖进输入框`);
        }
        catch {
            setFlash(`${label}：拖拽卡片到输入框即可（剪贴板不可用）`);
        }
    }, []);
    // Right-edge vertical tab — the reference plugin's `fab`. Hover widening is
    // dropped (inline styles cannot express :hover) but the geometry is identical:
    // glued to the right edge, vertically centred, so no viewport can hide it.
    const entry = (0, react_1.createElement)('button', {
        type: 'button',
        'data-zentao-entry': '1',
        title: '禅道工作台',
        onClick: () => setOpen((value) => !value),
        style: {
            position: 'fixed',
            top: '50%',
            right: 0,
            transform: 'translateY(-50%)',
            zIndex: 9999,
            writingMode: 'vertical-rl',
            color: '#fff',
            cursor: 'pointer',
            letterSpacing: 3,
            background: TOKEN.accent,
            border: 'none',
            borderRadius: '8px 0 0 8px',
            padding: '16px 8px',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'system-ui,-apple-system,"PingFang SC",sans-serif',
            boxShadow: '-2px 0 10px rgba(0,0,0,.18)',
        },
    }, FAB_TEXT);
    if (!open)
        return entry;
    const authenticated = config?.authenticated === true;
    const header = (0, react_1.createElement)('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${TOKEN.line}` } }, (0, react_1.createElement)('strong', { style: { flex: 1 } }, '禅道工作台'), (0, react_1.createElement)('span', { style: { fontSize: 11, color: authenticated ? TOKEN.ok : TOKEN.danger } }, authenticated ? `已连接 · ${config?.strategy ?? ''}` : '未连接'), (0, react_1.createElement)('button', { type: 'button', onClick: () => setOpen(false), style: { background: 'none', border: 'none', color: TOKEN.dim, cursor: 'pointer' } }, '✕'));
    const body = [];
    if (error !== '')
        body.push((0, react_1.createElement)('div', { key: 'err', style: { padding: '8px 12px', color: TOKEN.danger, fontSize: 12 } }, error));
    if (!authenticated) {
        if ((config?.server ?? '') === '') {
            body.push((0, react_1.createElement)('div', { key: 'server', style: { padding: '10px 12px', borderBottom: `1px solid ${TOKEN.line}` } }, (0, react_1.createElement)('div', { style: { color: TOKEN.danger, marginBottom: 4 } }, '还没配置禅道实例地址 —— 没有它，下面四条登录路径都无从探测。'), (0, react_1.createElement)('div', { style: { display: 'flex', gap: 6 } }, (0, react_1.createElement)('input', {
                'data-zentao-server': '1',
                // No host-shaped placeholder: the bundle guard forbids anything
                // that looks like a real domain, and it is right to — a template is
                // clearer than a fake host someone might actually submit.
                placeholder: 'https://<实例域名>',
                value: serverDraft,
                onChange: (event) => setServerDraft(event.target.value),
                style: { flex: 1, minWidth: 0 },
            }), (0, react_1.createElement)('button', {
                type: 'button',
                'data-zentao-action': 'set-server',
                disabled: serverDraft === '' || busy === 'server',
                style: { cursor: serverDraft === '' ? 'not-allowed' : 'pointer' },
                onClick: async () => {
                    setBusy('server');
                    try {
                        await call('setServer', { server: serverDraft });
                        setFlash('实例地址已设置，正在重新探测…');
                        await refreshStatus(true);
                    }
                    catch (problem) {
                        setError(problem.message);
                    }
                    finally {
                        setBusy('');
                    }
                },
            }, busy === 'server' ? '设置中…' : '保存')), (0, react_1.createElement)('div', { style: { color: TOKEN.dim, fontSize: 11, marginTop: 4 } }, '想让它每次启动都生效：在 profile 的 cordis.patch.yml 里给 zentao-workbench 那行加 config: { server: … }，或设环境变量 ZENTAO_BASE；本机若已导出过 cookie jar，也会自动从 jar 里认出实例。')));
        }
        body.push((0, react_1.createElement)('div', { key: 'probes', style: { padding: '10px 12px' } }, (0, react_1.createElement)('div', { style: { color: TOKEN.dim, marginBottom: 6 } }, '未登录 —— 每条登录路径的探测结果与下一步：'), ...(config?.probes ?? []).map((probe) => (0, react_1.createElement)('div', { key: probe.id, style: { padding: '6px 0', borderTop: `1px solid ${TOKEN.line}` } }, (0, react_1.createElement)('div', {}, `${probe.ready === false ? '✘' : '·'} ${probe.label}：${probe.detail}`), probe.hint ? (0, react_1.createElement)('div', { style: { color: TOKEN.dim, fontSize: 12, marginTop: 2 } }, `→ ${probe.hint}`) : null)), (0, react_1.createElement)('div', { style: { display: 'flex', gap: 8, marginTop: 10 } }, (0, react_1.createElement)('button', { type: 'button', onClick: () => void refreshStatus(true), style: { cursor: 'pointer' } }, busy === 'status' ? '探测中…' : '重新探测'), (0, react_1.createElement)('button', {
            type: 'button',
            onClick: async () => {
                setBusy('export');
                try {
                    const value = await call('refreshCookies', {});
                    setFlash(`已重新导出：${value.detail.slice(0, 60)}`);
                    await refreshStatus(true);
                }
                catch (problem) {
                    setError(problem.message);
                }
                finally {
                    setBusy('');
                }
            },
            style: { cursor: 'pointer' },
        }, busy === 'export' ? '导出中…' : '重新导出 cookie')), (0, react_1.createElement)('div', { style: { marginTop: 12, paddingTop: 8, borderTop: `1px solid ${TOKEN.line}` } }, (0, react_1.createElement)('div', { style: { color: TOKEN.dim, marginBottom: 4 } }, '或直接用账号密码登录（口令只在本次请求内存里，不落盘、不进日志）：'), (0, react_1.createElement)('div', { style: { display: 'flex', gap: 6 } }, (0, react_1.createElement)('input', {
            placeholder: '账号',
            value: account,
            onChange: (event) => setAccount(event.target.value),
            style: { flex: 1, minWidth: 0 },
        }), (0, react_1.createElement)('input', {
            placeholder: '密码',
            type: 'password',
            value: password,
            onChange: (event) => setPassword(event.target.value),
            style: { flex: 1, minWidth: 0 },
        }), (0, react_1.createElement)('button', {
            type: 'button',
            disabled: account === '' || password === '' || busy === 'login',
            style: { cursor: account === '' || password === '' ? 'not-allowed' : 'pointer' },
            onClick: async () => {
                setBusy('login');
                try {
                    const value = await call('login', { account, password });
                    setPassword('');
                    setFlash(value.detail);
                    await refreshStatus(true);
                }
                catch (problem) {
                    setPassword('');
                    setError(problem.message);
                }
                finally {
                    setBusy('');
                }
            },
        }, busy === 'login' ? '登录中…' : '登录')))));
    }
    else {
        body.push((0, react_1.createElement)('div', { key: 'tabs', style: { display: 'flex', gap: 4, padding: '8px 12px 0' } }, ...['bugs', 'tasks'].map((value) => (0, react_1.createElement)('button', {
            key: value,
            type: 'button',
            'data-zentao-tab': value,
            onClick: () => setTab(value),
            style: {
                cursor: 'pointer',
                border: 'none',
                background: 'none',
                color: tab === value ? TOKEN.text : TOKEN.dim,
                fontWeight: tab === value ? 600 : 400,
                borderBottom: tab === value ? `2px solid ${TOKEN.accent}` : '2px solid transparent',
                padding: '2px 6px',
            },
        }, value === 'bugs' ? '我的 Bug' : '任务'))));
        if (tab === 'tasks') {
            body.push((0, react_1.createElement)('div', { key: 'tasks', style: { padding: '10px 12px', maxHeight: 320, overflow: 'auto' } }, ...tasks.map((task) => (0, react_1.createElement)('div', { key: task.id, style: { padding: '6px 0', borderBottom: `1px solid ${TOKEN.line}` } }, (0, react_1.createElement)('div', null, `#${task.id} ${task.name}`), (0, react_1.createElement)('div', { style: { color: TOKEN.dim, fontSize: 11 } }, `${task.status || '-'} · 指派 ${task.assignedTo || '-'}`))), tasks.length === 0
                ? (0, react_1.createElement)('div', { style: { color: TOKEN.dim, fontSize: 12 } }, taskNote || '加载中…')
                : (0, react_1.createElement)('div', { style: { color: TOKEN.dim, fontSize: 11, marginTop: 8 } }, taskNote)));
        }
        if (tab === 'bugs')
            body.push((0, react_1.createElement)('div', { key: 'toolbar', style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderBottom: `1px solid ${TOKEN.line}` } }, (0, react_1.createElement)('select', { value: only, onChange: (event) => setOnly(event.target.value), style: { flex: 1 } }, (0, react_1.createElement)('option', { value: 'open' }, '未解决'), (0, react_1.createElement)('option', { value: 'all' }, '全部')), (0, react_1.createElement)('select', { value: String(intervalMin), onChange: (event) => setIntervalMin(Number(event.target.value)), title: '自动刷新间隔' }, (0, react_1.createElement)('option', { value: '1' }, '1 分钟'), (0, react_1.createElement)('option', { value: '5' }, '5 分钟'), (0, react_1.createElement)('option', { value: '15' }, '15 分钟'), (0, react_1.createElement)('option', { value: '30' }, '30 分钟'), (0, react_1.createElement)('option', { value: '0' }, '不自动')), bugsTotal.truncated
                ? (0, react_1.createElement)('span', { style: { fontSize: 11, color: TOKEN.dim } }, `共 ${bugsTotal.total} 条，仅显示前 ${bugs.length}`)
                : null, (0, react_1.createElement)('button', {
                type: 'button',
                'data-zentao-action': 'refresh',
                title: '刷新状态、列表、打开的详情与已生成的计划',
                onClick: () => void refreshAll(true),
                style: { cursor: 'pointer' },
            }, busy === 'all' || busy === 'bugs' ? '刷新中…' : '刷新')));
        // Only the active tab renders: the list and the detail card used to stay
        // mounted under the task tab (found in the browser harness).
        if (tab === 'bugs')
            body.push((0, react_1.createElement)('div', { key: 'list', style: { maxHeight: 260, overflow: 'auto' } }, ...bugs.map((bug) => (0, react_1.createElement)('div', {
                key: bug.id,
                'data-zentao-bug': bug.id,
                draggable: true,
                onDragStart: (event) => {
                    event.dataTransfer?.setData('text/plain', referenceOf({
                        ...bug,
                        status: bug.resolution === '' ? '未解决' : '已解决',
                        url: absoluteUrl(config?.server ?? '', bug.href),
                    }));
                },
                onClick: () => void openDetail(bug.id),
                style: { padding: '7px 12px', borderBottom: `1px solid ${TOKEN.line}`, cursor: 'grab' },
            }, (0, react_1.createElement)('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } }, (0, react_1.createElement)('span', { style: { color: TOKEN.dim, fontSize: 11 } }, `#${bug.id}`), (0, react_1.createElement)('span', { style: { flex: 1 } }, bug.title)), (0, react_1.createElement)('div', { style: { color: TOKEN.dim, fontSize: 11, marginTop: 2 } }, `${bug.severity || '-'} / P${bug.pri || '-'} · ${bug.type || ''} · 指派 ${bug.assignedTo || '-'}`)))));
        if (tab === 'bugs' && selected !== null) {
            body.push((0, react_1.createElement)('div', { key: 'detail', style: { borderTop: `1px solid ${TOKEN.line}`, padding: '10px 12px', maxHeight: 300, overflow: 'auto' } }, (0, react_1.createElement)('div', { style: { fontWeight: 600 } }, `${selected.bug.id}｜${selected.bug.title}`), (0, react_1.createElement)('div', { style: { color: TOKEN.dim, fontSize: 12, margin: '4px 0' } }, `产品 ${selected.bug.product || '-'}｜状态 ${selected.bug.status || '-'}｜指派 ${selected.bug.assignedTo || '-'}`), (0, react_1.createElement)('div', { style: { fontSize: 12 } }, `必填：${selected.resolve.fields.filter((field) => field.required).map((field) => field.label).join('、')}`), (0, react_1.createElement)('div', { style: { fontSize: 12, color: TOKEN.dim, marginTop: 2 } }, `下拉规模 ${selected.resolve.optionCounts.resolvedBuild}/${selected.resolve.optionCounts.bugInchargedBy}/${selected.resolve.optionCounts.assignedTo}（已收敛）`), ...(selected.histories.length > 0
                ? [(0, react_1.createElement)('div', { key: 'hist', style: { marginTop: 6, fontSize: 12, color: TOKEN.dim } }, ...selected.histories.map((line, index) => (0, react_1.createElement)('div', { key: index }, `· ${line}`)))]
                : []), (0, react_1.createElement)('div', { style: { display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' } }, (0, react_1.createElement)('button', { type: 'button', draggable: true, style: { cursor: 'grab' }, onDragStart: (event) => event.dataTransfer?.setData('text/plain', referenceOf(selected.bug)) }, '拖我引用'), (0, react_1.createElement)('button', { type: 'button', onClick: () => void insert(referenceOf(selected.bug), '引用'), style: { cursor: 'pointer' } }, '复制引用'), (0, react_1.createElement)('button', { type: 'button', 'data-zentao-action': 'plan', onClick: () => void previewPlan(selected.bug.id), style: { cursor: 'pointer' } }, busy === 'plan' ? '生成中…' : '预览解决计划'), ...ROLE_PRESETS.map((role) => (0, react_1.createElement)('button', {
                key: role.key,
                type: 'button',
                style: { cursor: 'pointer' },
                onClick: async () => {
                    try {
                        await deps.handlePrompt(role.prompt(referenceOf(selected.bug)));
                        setFlash(`已按「${role.label}」起会话`);
                    }
                    catch (problem) {
                        setError(problem.message);
                    }
                },
            }, `处理·${role.label}`)))));
            if (plan !== null) {
                body.push((0, react_1.createElement)('div', { key: 'plan', style: { borderTop: `1px solid ${TOKEN.line}`, padding: '10px 12px', maxHeight: 260, overflow: 'auto' } }, (0, react_1.createElement)('div', { style: { fontWeight: 600, marginBottom: 4 } }, plan.blocked ? '解决计划（被拦，不能提交）' : '解决计划（预览，未提交）'), ...plan.fields.map(([name, value]) => (0, react_1.createElement)('div', { key: name, style: { fontSize: 12, display: 'flex', gap: 6 } }, (0, react_1.createElement)('span', { style: { color: TOKEN.dim, minWidth: 108 } }, name), (0, react_1.createElement)('span', { style: { flex: 1, wordBreak: 'break-all' } }, value === '' ? '(空)' : String(value).slice(0, 160)))), ...Object.entries(plan.autoFilled).map(([name, why]) => (0, react_1.createElement)('div', { key: `af-${name}`, style: { fontSize: 11, color: TOKEN.dim, marginTop: 2 } }, `↳ ${name}：${why}`)), ...plan.problems.map((problem) => (0, react_1.createElement)('div', { key: problem, style: { fontSize: 12, color: TOKEN.danger, marginTop: 2 } }, `✘ ${problem}`)), (0, react_1.createElement)('div', { style: { marginTop: 8, display: 'flex', gap: 8 } }, (0, react_1.createElement)('button', {
                    type: 'button',
                    disabled: plan.blocked,
                    style: { cursor: plan.blocked ? 'not-allowed' : 'pointer' },
                    onClick: async () => {
                        // Writing asks first: the panel is a read surface by default.
                        if (!window.confirm(`确认在禅道把 #${selected.bug.id} 标记为已解决？此操作会写入真实系统。`))
                            return;
                        setBusy('submit');
                        try {
                            const value = await call('resolveSubmit', { bugID: selected.bug.id, confirm: true });
                            setFlash(value.outcome.ok ? `已解决并回读确认（${value.outcome.status}）` : `未接受：${value.outcome.serverError ?? value.outcome.status}`);
                            if (value.outcome.ok)
                                setPlan(null);
                            // Re-read everything visible: the list entry and the detail card
                            // both describe a bug that just changed state.
                            await refreshAll(true);
                        }
                        catch (problem) {
                            setError(problem.message);
                        }
                        finally {
                            setBusy('');
                        }
                    },
                }, busy === 'submit' ? '提交中…' : '确认并提交解决'))));
            }
        }
    }
    const stamp = lastUpdated === null ? '尚未刷新' : `最近更新 ${lastUpdated.toLocaleTimeString()}`;
    // The footer always states the instance and the last refresh time; transient
    // messages go to the corner toast instead of replacing this line.
    const footer = (0, react_1.createElement)('div', { style: { padding: '6px 12px', borderTop: `1px solid ${TOKEN.line}`, color: TOKEN.dim, fontSize: 11, display: 'flex', gap: 8 } }, (0, react_1.createElement)('span', { style: { flex: 1 } }, config?.server ? `实例 ${config.server}` : '未配置实例地址（server）'), (0, react_1.createElement)('span', { 'data-zentao-stamp': '1' }, stamp));
    // Right-edge drawer, mirroring the reference plugin's `panel`.
    const panel = (0, react_1.createElement)('div', {
        'data-zentao-panel': '1',
        style: {
            position: 'fixed',
            top: 0,
            right: 0,
            zIndex: 10000,
            width: 384,
            maxWidth: '92vw',
            // `100%` (not `100vh`): follow the box we are actually positioned
            // against. Measured in a 520x360 containing block, `100vh` overflowed it
            // by 440px; `100%` fits both that case and a full-window overlay.
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: TOKEN.bg,
            color: TOKEN.text,
            borderLeft: `1px solid ${TOKEN.line}`,
            boxShadow: '-8px 0 28px rgba(0,0,0,.14)',
            fontFamily: 'system-ui,-apple-system,"PingFang SC",sans-serif',
            fontSize: 13,
        },
    }, header, (0, react_1.createElement)('div', { style: { overflow: 'auto', flex: 1 } }, ...body), footer);
    // The drawer covers the right edge, so the tab is not rendered while it is
    // open (the reference plugin leaves its fab underneath and relies on the ✕;
    // hiding it removes the overlap instead of depending on z-order).
    const fab = open ? null : entry;
    // Transient messages live in their own corner toast (never in the layout flow).
    if (flash === '')
        return (0, react_1.createElement)('div', null, fab, panel);
    const toast = (0, react_1.createElement)('div', {
        'data-zentao-toast': '1',
        style: {
            position: 'fixed',
            bottom: 26,
            right: 26,
            zIndex: 10001,
            background: 'var(--dsw-alias-bg-overlay, #333)',
            color: 'var(--dsw-alias-label-primary, #fff)',
            borderRadius: 9,
            padding: '10px 15px',
            fontSize: 13,
            boxShadow: '0 6px 20px rgba(0,0,0,.22)',
            maxWidth: 360,
        },
    }, flash);
    return (0, react_1.createElement)('div', null, fab, panel, toast);
}
/** Slot registration keeps a stable identity for the seat. */
exports.name = 'zentao-workbench-panel';

return module.exports;
};
		return __require(0);
	},
});
