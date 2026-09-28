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
const ROLE_PRESETS = [
    { key: 'dev', label: '开发', prompt: (ref) => `${ref}\n\n请按开发角度处理这个 Bug：先复现、定位根因、给出最小改动修复并自测，必要时补充用例。` },
    { key: 'qa', label: '测试', prompt: (ref) => `${ref}\n\n请按测试角度处理：核对修复是否覆盖原始复现步骤，列出回归范围与验证步骤。` },
    { key: 'pm', label: '产品', prompt: (ref) => `${ref}\n\n请按产品角度处理：确认预期行为与验收标准，指出需求或交互上需要澄清的点。` },
];
const TOKEN = {
    text: 'var(--dsw-alias-text-1, #e6e6e6)',
    dim: 'var(--dsw-alias-text-3, #9a9a9a)',
    line: 'var(--dsw-alias-border-1, rgba(255,255,255,.14))',
    bg: 'var(--dsw-alias-bg-2, #1b1c1f)',
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
    const [pos, setPos] = (0, react_1.useState)(() => ({ x: window.innerWidth - 56, y: window.innerHeight / 2 - 40 }));
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
    const [account, setAccount] = (0, react_1.useState)('');
    const [password, setPassword] = (0, react_1.useState)('');
    const drag = (0, react_1.useRef)({ active: false, dx: 0, dy: 0 });
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
    }, [call, only, selected, plan]);
    (0, react_1.useEffect)(() => { void refreshStatus(true); }, [refreshStatus]);
    (0, react_1.useEffect)(() => {
        if (!open || config?.authenticated !== true)
            return undefined;
        if (lastUpdated === null)
            void refreshAll(false);
        if (intervalMin <= 0)
            return undefined;
        const timer = window.setInterval(() => { void refreshAll(true); }, intervalMin * 60_000);
        return () => window.clearInterval(timer);
    }, [open, config?.authenticated, intervalMin, refreshAll, lastUpdated]);
    (0, react_1.useEffect)(() => {
        if (flash === '')
            return undefined;
        const timer = window.setTimeout(() => setFlash(''), 2400);
        return () => window.clearTimeout(timer);
    }, [flash]);
    const onPointerDown = (0, react_1.useCallback)((event) => {
        drag.current = { active: true, dx: event.clientX - pos.x, dy: event.clientY - pos.y };
    }, [pos.x, pos.y]);
    (0, react_1.useEffect)(() => {
        const move = (event) => {
            if (!drag.current.active)
                return;
            setPos({ x: Math.max(8, Math.min(window.innerWidth - 48, event.clientX - drag.current.dx)), y: Math.max(8, Math.min(window.innerHeight - 48, event.clientY - drag.current.dy)) });
        };
        const up = () => { drag.current.active = false; };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
    }, []);
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
    const entry = (0, react_1.createElement)('button', {
        type: 'button',
        title: '禅道工作台（可拖动）',
        onPointerDown,
        onClick: () => setOpen((value) => !value),
        style: {
            ...box,
            position: 'fixed',
            left: pos.x,
            top: pos.y,
            width: 40,
            height: 40,
            zIndex: 9998,
            cursor: 'grab',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            color: '#fff',
            background: config?.authenticated === true ? TOKEN.accent : '#6b7280',
        },
    }, '禅');
    if (!open)
        return entry;
    const authenticated = config?.authenticated === true;
    const header = (0, react_1.createElement)('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${TOKEN.line}` } }, (0, react_1.createElement)('strong', { style: { flex: 1 } }, '禅道工作台'), (0, react_1.createElement)('span', { style: { fontSize: 11, color: authenticated ? TOKEN.ok : TOKEN.danger } }, authenticated ? `已连接 · ${config?.strategy ?? ''}` : '未连接'), (0, react_1.createElement)('button', { type: 'button', onClick: () => setOpen(false), style: { background: 'none', border: 'none', color: TOKEN.dim, cursor: 'pointer' } }, '✕'));
    const body = [];
    if (error !== '')
        body.push((0, react_1.createElement)('div', { key: 'err', style: { padding: '8px 12px', color: TOKEN.danger, fontSize: 12 } }, error));
    if (!authenticated) {
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
        body.push((0, react_1.createElement)('div', { key: 'toolbar', style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderBottom: `1px solid ${TOKEN.line}` } }, (0, react_1.createElement)('select', { value: only, onChange: (event) => setOnly(event.target.value), style: { flex: 1 } }, (0, react_1.createElement)('option', { value: 'open' }, '未解决'), (0, react_1.createElement)('option', { value: 'all' }, '全部')), (0, react_1.createElement)('select', { value: String(intervalMin), onChange: (event) => setIntervalMin(Number(event.target.value)), title: '自动刷新间隔' }, (0, react_1.createElement)('option', { value: '1' }, '1 分钟'), (0, react_1.createElement)('option', { value: '5' }, '5 分钟'), (0, react_1.createElement)('option', { value: '15' }, '15 分钟'), (0, react_1.createElement)('option', { value: '30' }, '30 分钟'), (0, react_1.createElement)('option', { value: '0' }, '不自动')), (0, react_1.createElement)('button', {
            type: 'button',
            title: '刷新状态、列表、打开的详情与已生成的计划',
            onClick: () => void refreshAll(true),
            style: { cursor: 'pointer' },
        }, busy === 'all' || busy === 'bugs' ? '刷新中…' : '刷新')));
        body.push((0, react_1.createElement)('div', { key: 'list', style: { maxHeight: 260, overflow: 'auto' } }, ...bugs.map((bug) => (0, react_1.createElement)('div', {
            key: bug.id,
            draggable: true,
            onDragStart: (event) => {
                event.dataTransfer?.setData('text/plain', referenceOf({ ...bug, status: bug.resolution === '' ? '未解决' : '已解决', url: `https://example.invalid${bug.href}` }));
            },
            onClick: () => void openDetail(bug.id),
            style: { padding: '7px 12px', borderBottom: `1px solid ${TOKEN.line}`, cursor: 'grab' },
        }, (0, react_1.createElement)('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } }, (0, react_1.createElement)('span', { style: { color: TOKEN.dim, fontSize: 11 } }, `#${bug.id}`), (0, react_1.createElement)('span', { style: { flex: 1 } }, bug.title)), (0, react_1.createElement)('div', { style: { color: TOKEN.dim, fontSize: 11, marginTop: 2 } }, `${bug.severity || '-'} / P${bug.pri || '-'} · ${bug.type || ''} · 指派 ${bug.assignedTo || '-'}`)))));
        if (selected !== null) {
            body.push((0, react_1.createElement)('div', { key: 'detail', style: { borderTop: `1px solid ${TOKEN.line}`, padding: '10px 12px', maxHeight: 300, overflow: 'auto' } }, (0, react_1.createElement)('div', { style: { fontWeight: 600 } }, `${selected.bug.id}｜${selected.bug.title}`), (0, react_1.createElement)('div', { style: { color: TOKEN.dim, fontSize: 12, margin: '4px 0' } }, `产品 ${selected.bug.product || '-'}｜状态 ${selected.bug.status || '-'}｜指派 ${selected.bug.assignedTo || '-'}`), (0, react_1.createElement)('div', { style: { fontSize: 12 } }, `必填：${selected.resolve.fields.filter((field) => field.required).map((field) => field.label).join('、')}`), (0, react_1.createElement)('div', { style: { fontSize: 12, color: TOKEN.dim, marginTop: 2 } }, `下拉规模 ${selected.resolve.optionCounts.resolvedBuild}/${selected.resolve.optionCounts.bugInchargedBy}/${selected.resolve.optionCounts.assignedTo}（已收敛）`), ...(selected.histories.length > 0
                ? [(0, react_1.createElement)('div', { key: 'hist', style: { marginTop: 6, fontSize: 12, color: TOKEN.dim } }, ...selected.histories.map((line, index) => (0, react_1.createElement)('div', { key: index }, `· ${line}`)))]
                : []), (0, react_1.createElement)('div', { style: { display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' } }, (0, react_1.createElement)('button', { type: 'button', draggable: true, style: { cursor: 'grab' }, onDragStart: (event) => event.dataTransfer?.setData('text/plain', referenceOf(selected.bug)) }, '拖我引用'), (0, react_1.createElement)('button', { type: 'button', onClick: () => void insert(referenceOf(selected.bug), '引用'), style: { cursor: 'pointer' } }, '复制引用'), (0, react_1.createElement)('button', { type: 'button', onClick: () => void previewPlan(selected.bug.id), style: { cursor: 'pointer' } }, busy === 'plan' ? '生成中…' : '预览解决计划'), ...ROLE_PRESETS.map((role) => (0, react_1.createElement)('button', {
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
                            await refreshBugs(true);
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
    const footer = flash === ''
        ? (0, react_1.createElement)('div', { style: { padding: '6px 12px', borderTop: `1px solid ${TOKEN.line}`, color: TOKEN.dim, fontSize: 11, display: 'flex', gap: 8 } }, (0, react_1.createElement)('span', { style: { flex: 1 } }, config?.server ? `实例 ${config.server}` : '未配置实例地址（server）'), (0, react_1.createElement)('span', null, stamp))
        : (0, react_1.createElement)('div', { style: { padding: '6px 12px', borderTop: `1px solid ${TOKEN.line}`, color: TOKEN.ok, fontSize: 11 } }, flash);
    const panel = (0, react_1.createElement)('div', {
        style: {
            ...box,
            position: 'fixed',
            left: Math.max(8, Math.min(window.innerWidth - 372, pos.x - 332)),
            top: Math.max(8, Math.min(window.innerHeight - 440, pos.y - 20)),
            width: 364,
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 9999,
            overflow: 'hidden',
        },
    }, header, (0, react_1.createElement)('div', { style: { overflow: 'auto', flex: 1 } }, ...body), footer);
    return (0, react_1.createElement)('div', null, entry, panel);
}
/** Slot registration keeps a stable identity for the seat. */
exports.name = 'zentao-workbench-panel';

return module.exports;
};
		return __require(0);
	},
});
