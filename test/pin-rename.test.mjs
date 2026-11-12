import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
// Group 5: pin, session rename and project rename, plus the project row's "更多"
// menu. Every edit goes through the management endpoint and reports inline.
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const helpers = read('lib/transport.js').replaceAll('export ', '');
const source = read('client-main.template.js')
  .replace('/* ROUTING_HELPERS */', helpers)
  .replace('/* PERSISTENT_HELPERS */', read('persistent-parent.template.js'))
  .replace('/* PLUGIN_SYNC */', 'function createPluginSyncPanel(){return()=>null;}');
const walk = node => Array.isArray(node) ? node.flatMap(walk) : !node || typeof node !== 'object' ? [] : [node, ...(node.children || []).flatMap(walk)];
const find = (tree, predicate) => { const found = walk(tree).find(predicate); assert(found, 'expected UI element'); return found; };
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
// 管理请求的 fetch/json 链会跨若干次宏任务落地，按条件等待比固定 sleep 稳。
const waitFor = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return predicate();
};
const text = node => walk(node).flatMap(n => n.children).filter(c => typeof c === 'string' || typeof c === 'number').join('');
const rows = tree => walk(tree).filter(n => typeof n.props['data-row-key'] === 'string' && n.props['data-row-key'].startsWith('session:'));

const host = (id, label, items, extra = {}) => ({
  id, label, status: 'ready',
  workspaces: [{ workspaceId: 'ws-' + id, path: '/srv/' + id, title: 'WS ' + id, sessionIds: items.map(i => i.sessionId) }],
  items, archivedSessionIds: [], pinnedSessionIds: [], ...extra,
});
const session = (sessionId, updatedAt, extra = {}) => ({ sessionId, title: sessionId, blank: false, updatedAt, ...extra });

async function page({ hosts, manageOk = true, manageError = null, initialStorage = {} }) {
  const registrations = [], effects = [], requests = [], panels = [];
  const storage = new Map(Object.entries(initialStorage));
  const react = {
    createElement: (type, props, ...children) => typeof type === 'function' ? type({ ...props, children }) : { type, props: props || {}, children: children.flat().filter(Boolean) },
    useSyncExternalStore: (_s, get) => get(),
    useState: value => [value, () => {}],
    useEffect: () => {},
  };
  const fetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, body });
    if (path === '/api/dsh-unified/catalog') return { ok: true, json: async () => ({ ok: true, hosts }) };
    if (path.includes('/manage/')) {
      if (!manageOk) return { ok: false, json: async () => ({ ok: false, error: manageError || { code: 'session/title-invalid', message: '标题不可用' } }) };
      if (path.endsWith('/session-pin')) return { ok: true, json: async () => ({ ok: true, value: { pinnedSessionIds: ['session-b'] } }) };
      if (path.endsWith('/session-unpin')) return { ok: true, json: async () => ({ ok: true, value: { pinnedSessionIds: [] } }) };
      if (path.endsWith('/session-rename')) return { ok: true, json: async () => ({ ok: true, value: { title: body?.title, seq: 3 } }) };
      if (path.endsWith('/workspace-rename')) return { ok: true, json: async () => ({ ok: true, value: { workspace: { workspaceId: 'ws-mac', path: '/srv/mac', title: body?.title, sessionIds: [], createdAt: '', updatedAt: '' } } }) };
      return { ok: false, json: async () => ({ ok: false, error: { code: 'management/invalid-request', message: 'bad' } }) };
    }
    throw Error('unexpected fixture request ' + path);
  };
  const service = { selection: { getSnapshot: () => ({ sessionId: 'none' }), subscribe: () => () => {} }, sessions: { refresh: async () => {}, list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } }, openSession: async () => {}, startSession() {} };
  const ui = {
    slots: { inject: (_n, fn) => fn(), register: (options, component) => { registrations.push({ options, component }); return () => {}; } },
    effect: fn => effects.push(fn),
    layout: { toggleSidebar() {}, selectPanel: value => panels.push(value), panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} } },
    uiWorkspace: service,
    locale: { getSnapshot: () => ({ active: 'zh-CN' }) },
  };
  const env = {
    console, URL, Promise, MessageChannel, AbortController, Set, Map, Error, JSON, Uint8Array, Date,
    crypto: { randomUUID: () => 'req-abcdefghijklmnop' },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    // Electron 桌面端没有 window.prompt；重命名必须不依赖它。
    prompt: () => { throw new Error('window.prompt is unavailable in the desktop app'); },
    confirm: () => true,
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    document: { visibilityState: 'visible', documentElement: {}, addEventListener() {}, removeEventListener() {}, querySelector: () => null },
  };
  env.__DSH_UNIFIED_PERSISTENT_LOCAL__ = true;
  env.window = { fetch, innerWidth: 1400, location: { origin: 'dsh-app://app', reload() {} }, __ModuleLoader__: { load: value => { plugin = value.factory(() => react); } } };
  let plugin;
  vm.runInNewContext(source, env);
  plugin.apply({ inject: (_deps, fn) => fn(ui) });
  const cleanups = effects.map(fn => fn());
  await settle();
  const sidebar = () => registrations.find(r => r.options.name === 'sidebar.workspaces').component({ wide: true });
  const expand = () => { for (const node of walk(sidebar()).filter(n => n.props['data-action'] === 'open-workspace')) node.props.onClick(); return sidebar(); };
  const act = (action, extra = {}) => find(sidebar(), n => n.props['data-action'] === action && Object.entries(extra).every(([k, v]) => n.props[k] === v));
  return { env, sidebar, expand, act, requests, panels, storage, close: () => cleanups.forEach(fn => fn?.()) };
}

const manageCalls = p => p.requests.filter(r => r.path.includes('/manage/'));
const renameInput = p => find(p.sidebar(), n => n.props['data-rename-input'] === true);
const typeAndEnter = async (p, value) => {
  const input = renameInput(p);
  input.props.onInput({ target: { value } });
  input.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  await settle();
};
const requestIdPattern = /^[A-Za-z0-9_-]{16,128}$/;

test('a pinned session is listed first and marked', async () => {
  const now = Date.now();
  const p = await page({
    hosts: [host('mac', '本机', [session('session-a', now), session('session-b', now - 60_000)], { pinnedSessionIds: ['session-b'] })],
  });
  const tree = p.expand();
  const listed = rows(tree);
  assert.deepEqual(listed.map(n => n.props['data-row-key']), ['session:session-b', 'session:session-a'], 'the pinned row leads the group');
  assert.equal(find(tree, n => n.props['data-row-key'] === 'session:session-b').props['data-pinned'], true);
  assert.equal(find(tree, n => n.props['data-row-key'] === 'session:session-a').props['data-pinned'], undefined);
  assert.equal(find(find(tree, n => n.props['data-row-key'] === 'session:session-b'), n => n.props['data-session-leading'] === 'pinned').children[0].type, 'svg');
  p.close();
});

test('the session menu pins through the management endpoint', async () => {
  const now = Date.now();
  const p = await page({ hosts: [host('mac', '本机', [session('session-a', now)])] });
  p.expand();
  p.act('session-more').props.onClick({ stopPropagation() {} });
  const menu = find(p.sidebar(), n => n.props['data-session-menu'] === true);
  assert.match(text(menu), /置顶/);
  find(menu, n => n.props['data-action'] === 'toggle-pin').props.onClick();
  await settle();
  const calls = manageCalls(p);
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /\/manage\/session-pin$/);
  assert.equal(calls[0].body.sessionId, 'session-a');
  assert.match(calls[0].body.requestId, requestIdPattern);
  p.close();
});

test('an already pinned session offers 取消置顶 and calls session-unpin', async () => {
  const now = Date.now();
  const p = await page({ hosts: [host('mac', '本机', [session('session-a', now)], { pinnedSessionIds: ['session-a'] })] });
  p.expand();
  p.act('session-more').props.onClick({ stopPropagation() {} });
  const menu = find(p.sidebar(), n => n.props['data-session-menu'] === true);
  assert.match(text(menu), /取消置顶/);
  find(menu, n => n.props['data-action'] === 'toggle-pin').props.onClick();
  await settle();
  assert.match(manageCalls(p).at(-1).path, /\/manage\/session-unpin$/);
  p.close();
});

test('double-clicking a session row edits inline and renames with the trimmed value', async () => {
  const now = Date.now();
  const p = await page({ hosts: [host('mac', '本机', [session('session-a', now)])] });
  const tree = p.expand();
  find(tree, n => n.props['data-row-key'] === 'session:session-a').props.onDoubleClick();
  await settle();
  assert.equal(manageCalls(p).length, 0, 'opening the editor sends nothing');
  typeAndEnter(p, '  新名字  ');
  const calls = manageCalls(p);
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /\/manage\/session-rename$/);
  assert.equal(calls[0].body.sessionId, 'session-a');
  assert.equal(calls[0].body.title, '新名字');
  assert.ok(!walk(p.sidebar()).some(n => n.props['data-rename-input'] === true), 'the editor closes');
  p.close();
});

test('escape abandons the inline rename without sending a request', async () => {
  const now = Date.now();
  const p = await page({ hosts: [host('mac', '本机', [session('session-a', now)])] });
  const tree = p.expand();
  find(tree, n => n.props['data-row-key'] === 'session:session-a').props.onDoubleClick();
  await settle();
  renameInput(p).props.onInput({ target: { value: '不要保存' } });
  renameInput(p).props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  await settle();
  assert.equal(manageCalls(p).length, 0);
  assert.ok(!walk(p.sidebar()).some(n => n.props['data-rename-input'] === true));
  p.close();
});

test('the project "更多" menu renames the project inline and keeps delete disabled', async () => {
  const now = Date.now();
  const p = await page({ hosts: [host('mac', '本机', [session('session-a', now)])] });
  p.act('workspace-more').props.onClick();
  const menu = find(p.sidebar(), n => n.props['data-workspace-menu'] === true);
  const remove = find(menu, n => n.props['data-action'] === 'delete-workspace');
  assert.equal(remove.props.disabled, true, 'delete is a placeholder for now');
  assert.equal(remove.props.title, '即将支持');
  const before = manageCalls(p).length;
  remove.props.onClick?.();
  await settle();
  assert.equal(manageCalls(p).length, before, 'the disabled delete sends nothing');
  find(menu, n => n.props['data-action'] === 'rename-workspace').props.onClick();
  await settle();
  assert.equal(manageCalls(p).length, 0, 'opening the project editor sends nothing');
  typeAndEnter(p, '改名后的项目');
  const calls = manageCalls(p);
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /\/manage\/workspace-rename$/);
  assert.equal(calls[0].body.workspaceId, 'ws-mac');
  assert.equal(calls[0].body.title, '改名后的项目');
  p.close();
});

test('a failed rename reports in the sidebar and never raises the workbench', async () => {
  const now = Date.now();
  const p = await page({ hosts: [host('mac', '本机', [session('session-a', now)])], manageOk: false });
  const tree = p.expand();
  find(tree, n => n.props['data-row-key'] === 'session:session-a').props.onDoubleClick();
  await settle();
  typeAndEnter(p, '新标题');
  assert.ok(!p.panels.includes('dsh-unified-host'), 'no workbench detour');
  const visible = await waitFor(() => walk(p.sidebar()).some(n => n.props && n.props['data-sidebar-notice'] === true));
  assert.ok(visible, 'the failure is reported inline');
  const notice = walk(p.sidebar()).find(n => n.props && n.props['data-sidebar-notice'] === true);
  assert.match(text(notice), /标题不可用/);
  p.close();
});
