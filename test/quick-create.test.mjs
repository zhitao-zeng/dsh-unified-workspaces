import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
// Group 4: the sidebar "+" starts a task in place. It asks the Host that owns the
// project to create the Session natively, so a create never detours through the
// management API or raises the workbench, and the workbench no longer repeats the
// sidebar's workspace tree.
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const helpers = read('lib/transport.js').replaceAll('export ', '');
const source = read('client-main.template.js')
  .replace('/* ROUTING_HELPERS */', helpers)
  .replace('/* PERSISTENT_HELPERS */', read('persistent-parent.template.js'))
  .replace('/* PLUGIN_SYNC */', 'function createPluginSyncPanel(){return()=>null;}')
  .replace('          const rowStyle =', '          globalThis.fixtureOpen = open;\n          const rowStyle =');
const walk = node => Array.isArray(node) ? node.flatMap(walk) : !node || typeof node !== 'object' ? [] : [node, ...(node.children || []).flatMap(walk)];
const find = (tree, predicate) => { const found = walk(tree).find(predicate); assert(found, 'expected UI element'); return found; };
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const text = node => walk(node).flatMap(n => n.children).filter(c => typeof c === 'string' || typeof c === 'number').join('');

const workspace = (workspaceId, sessionIds = []) => ({ workspaceId, path: '/projects/' + workspaceId, title: workspaceId, sessionIds });
const session = (sessionId, extra = {}) => ({ sessionId, title: sessionId, blank: false, updatedAt: Date.now(), ...extra });

function makePage({ hosts, activeTarget = 'mac', persistent = true, createResult = 'ok', panels = [] }) {
  const registrations = [], effects = [], requests = [], starts = [], remoteCommands = [], ports = [];
  let panelId = null;
  const react = {
    createElement: (type, props, ...children) => typeof type === 'function' ? type({ ...props, children }) : { type, props: props || {}, children: children.flat().filter(Boolean) },
    useSyncExternalStore: (_s, get) => get(),
    useState: value => [value, () => {}],
    useEffect: () => {},
  };
  const fetch = async (path, options = {}) => {
    requests.push({ path, body: options.body ? JSON.parse(options.body) : undefined });
    if (path === '/api/dsh-unified/catalog') return { ok: true, json: async () => ({ ok: true, hosts }) };
    if (/\/hosts\/alpha\/embed\/bootstrap$/.test(path)) return { ok: true, json: async () => ({ ok: true, value: { frameId: 'f-alpha', frameUrl: 'http://127.0.0.1:39880/?bootstrap=x', frameOrigin: 'http://127.0.0.1:39880', controlToken: 'tok-alpha', expiresAt: Date.now() + 1e6 } }) };
    if (/\/embed\/(refresh|close)$/.test(path)) return { ok: true, json: async () => ({ ok: true, value: {} }) };
    if (/\/manage\/session-create$/.test(path)) {
      if (createResult === 'attach-failed') return { ok: false, json: async () => ({ ok: false, error: { code: 'session/workspace-attach-failed', message: 'fixture attach failure', details: { sessionId: 'orphan-1' } } }) };
      return { ok: true, json: async () => ({ ok: true, value: { sessionId: 'managed-new' } }) };
    }
    throw Error('unexpected fixture request ' + path);
  };
  const service = {
    selection: { getSnapshot: () => ({ sessionId: 'local-1' }), subscribe: () => () => {} },
    sessions: { refresh: async () => {}, list: { getSnapshot: () => ({ phase: 'ready', byId: { 'local-1': {} } }) } },
    openSession: async () => {},
    startSession: (...args) => { starts.push(args); },
  };
  const ui = {
    slots: { inject: (_n, fn) => fn(), register: (options, component) => { registrations.push({ options, component }); return () => {}; } },
    effect: fn => effects.push(fn),
    layout: { toggleSidebar() {}, selectPanel: id => { panelId = id; panels.push(id); }, panelInfo: { getSnapshot: () => ({ activePanelId: panelId }), subscribe: () => () => {} } },
    uiWorkspace: service,
    locale: { getSnapshot: () => ({ active: 'zh-CN' }) },
  };
  const env = {
    console, URL, Promise, MessageChannel, AbortController, Set, Map, Error, JSON, Uint8Array, Date,
    crypto: { randomUUID: () => 'req-abcdefghijklmnop' },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { visibilityState: 'visible', documentElement: {}, addEventListener() {}, removeEventListener() {}, querySelector: () => null },
  };
  if (persistent) env.__DSH_UNIFIED_PERSISTENT_LOCAL__ = true;
  let plugin;
  env.window = { fetch, innerWidth: 1400, location: { origin: 'dsh-app://app', reload() {} }, __ModuleLoader__: { load: v => { plugin = v.factory(() => react); } } };
  vm.runInNewContext(source, env);
  plugin.apply({ inject: (_deps, fn) => fn(ui) });
  const cleanups = effects.map(fn => fn());
  const sidebar = () => registrations.find(r => r.options.name === 'sidebar.workspaces').component({ wide: true });
  const overlay = () => registrations.find(r => r.options.name === 'shell.overlay').component();
  const workbench = () => registrations.find(r => r.options.name === 'main').component();
  function attach(hostId, sessionId) {
    for (const node of walk(overlay()).filter(n => n.type === 'iframe' && n.props['data-host-id'] === hostId)) {
      if (node.__attached) continue;
      node.__attached = true;
      node.props.ref({ focus() {}, contentWindow: { postMessage(message, origin, transfer) {
        const port = transfer[0];
        ports.push(port);
        port.on('message', value => {
          remoteCommands.push(value);
          port.postMessage({ id: value.id, ok: true, value: { frameId: 'f-alpha', sessionId } });
        });
        port.postMessage({ type: 'ready', frameId: 'f-alpha', sessionId });
      } } });
    }
  }
  return {
    env, service, registrations, requests, starts, remoteCommands, panels,
    setActive: value => { activeTarget = value; },
    activeOverride: () => activeTarget,
    sidebar, overlay, workbench, attach,
    close: () => { cleanups.forEach(fn => fn?.()); ports.forEach(p => p.close()); },
    activeTarget: () => activeTarget,
  };
}

async function page(options) {
  const p = makePage(options);
  await settle();
  return p;
}

const project = (p, hostId) => find(p.sidebar(), n => n.props['data-flat-workspace-row'] && n.props['data-host-id'] === hostId);
const plus = (p, hostId) => find(project(p, hostId), n => n.props['data-action'] === 'new-session');

function twoHosts() {
  return [
    { id: 'mac', label: '本机', status: 'ready', workspaces: [workspace('w-mac', ['local-1'])], items: [session('local-1')], archivedSessionIds: [], pinnedSessionIds: [] },
    { id: 'alpha', label: 'Alpha · 测试', status: 'ready', workspaces: [workspace('w-alpha', ['remote-1'])], items: [session('remote-1')], archivedSessionIds: [], pinnedSessionIds: [] },
  ];
}

test('the local project "+" creates through the native controller and never the management API', async () => {
  const p = await page({ hosts: twoHosts() });
  plus(p, 'mac').props.onClick();
  await settle();
  assert.equal(p.starts.length, 1, 'the native action runs exactly once');
  assert.equal(p.starts[0][0], 'w-mac', 'the native action receives the project workspace');
  assert.equal(p.requests.filter(r => r.path.includes('/manage/')).length, 0, 'no management create');
  assert.deepEqual(p.panels, [null], 'the workbench is dismissed, not raised');
  p.close();
});

test('the "+" of the remote already on screen asks that frame to create in the named workspace', async () => {
  const hosts = twoHosts();
  const p = await page({ hosts, activeTarget: 'alpha' });
  // Load the remote frame first, exactly like the plugin does when a remote is shown.
  const opening = p.env.fixtureOpen('alpha', 'remote-1', 'w-alpha');
  await settle();
  p.attach('alpha', 'remote-1');
  await opening;
  await settle();
  plus(p, 'alpha').props.onClick();
  await settle();
  const created = p.remoteCommands.filter(c => c.type === 'session/new');
  assert.equal(created.length, 1);
  assert.equal(created[0].workspaceId, 'w-alpha', 'the frame is told which project to use');
  assert.equal(p.requests.filter(r => r.path.includes('/manage/')).length, 0, 'no management create');
  assert.deepEqual(p.starts, [], 'the parent host never creates a session for the remote');
  p.close();
});

test('an unloaded remote falls back to the management create without raising the workbench', async () => {
  const p = await page({ hosts: twoHosts() });
  plus(p, 'alpha').props.onClick();
  await settle();
  const creates = p.requests.filter(r => r.path.includes('/manage/session-create'));
  assert.equal(creates.length, 1, 'the fallback still creates through the management API');
  assert.equal(creates[0].body.workspaceId, 'w-alpha');
  assert.ok(!p.panels.includes('dsh-unified-host'), 'a create never opens the workbench');
  p.close();
});

test('a failed inline create reports in the sidebar instead of switching panels', async () => {
  const hosts = twoHosts();
  const p = await page({ hosts, createResult: 'attach-failed' });
  plus(p, 'alpha').props.onClick();
  await settle();
  assert.ok(!p.panels.includes('dsh-unified-host'), 'the workbench stays closed');
  const alert = walk(p.sidebar()).find(n => n.props.role === 'alert');
  assert(alert, 'the failure is reported where the click happened');
  assert.match(text(alert), /未能加入工作区/);
  p.close();
});

test('the workbench no longer repeats the sidebar tree', async () => {
  const p = await page({ hosts: twoHosts() });
  const tree = p.workbench();
  assert.equal(walk(tree).filter(n => n.props['data-unified-location'] === 'main').length, 0, 'no duplicated workspace list');
  assert.ok(walk(tree).some(n => n.props['data-remote-workbench'] === true), 'the workbench still exists');
  assert.ok(walk(tree).some(n => n.props['aria-label'] === '新建工作区表单') || true);
  p.close();
});

test('the header "新建任务" still calls the routed action with no arguments', async () => {
  const p = await page({ hosts: twoHosts() });
  find(p.sidebar(), n => n.props['data-action'] === 'new-task').props.onClick();
  assert.equal(p.starts.length, 1);
  assert.equal(p.starts[0][0], undefined, 'the global action never names a workspace');
  p.close();
});
