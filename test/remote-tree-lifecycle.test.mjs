import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.DSH_TEST_CLIENT_TEMPLATE || new URL('../client-main.template.js', import.meta.url), 'utf8');
const start = source.indexOf('    function createRemoteTree(require)');
const end = source.indexOf('    return {\n      inject:', start);
assert(start >= 0 && end > start);
const remoteIds = JSON.parse(fs.readFileSync(new URL('../remote-client-ids.json', import.meta.url), 'utf8'));
const functions = source.slice(start, end).replace('/* REMOTE_CLIENT_IDS */', remoteIds.map(id => JSON.stringify(id)).join(','));
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const records = { fetches: [], contexts: [], sockets: [], persisted: new Map([
    ['dsh.sessions.current', { sessionId: 'mac-original' }],
    ['dsh.unified.alpha.sessions.current', { sessionId: 'stale-remote' }],
  ]), stores: [] };
  const ids = options.ids || ['remote-a', 'remote-b'];
  class Element {
    constructor() { this.style = {}; this.children = []; this.parent = null; }
    setAttribute() {}
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    contains(child) { return this.children.includes(child); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    get firstChild() { return this.children[0]; }
  }
  class Socket {
    constructor(url) { this.url = url; this.readyState = 1; this.listeners = []; records.sockets.push(this); }
    addEventListener(name, listener) { if (name === 'close') this.listeners.push(listener); }
    close() { if (this.readyState === 3) return; this.readyState = 3; for (const listener of this.listeners) listener(); }
  }
  class Service { constructor(ctx, name) { ctx[name] = this; } }
  class Context {
    constructor() {
      this.cleanups = []; this.disposals = 0; records.contexts.push(this);
      this.fiber = { dispose: async () => { this.disposals++; for (const cleanup of this.cleanups.reverse()) await cleanup?.(); } };
    }
    async plugin(plugin) { if (typeof plugin === 'function') new plugin(this); }
    async inject(_services, callback) {
      if (options.failMount) throw Error('fixture mount failure');
      callback({ uiWorkspace: this.uiWorkspace, layout: { toggleSidebar() {} },
        effect: run => { this.cleanups.push(run()); },
        uiRenderer: { mount: element => { element.appendChild(new Element()); return () => { this.unmounted = true; }; } } });
    }
  }
  const storeFace = { createSnapshotStore(initial, config) {
    let value = config?.persist?.name && records.persisted.has(config.persist.name) ? records.persisted.get(config.persist.name) : initial;
    const store = { getSnapshot: () => value, set: next => { value = next; if (config?.persist?.name) records.persisted.set(config.persist.name, next); } };
    records.stores.push({ config, store }); return store;
  } };
  let staticModules;
  const face = { createClientModuleSystem(_facade, _exports, config) {
    records.boot = config.boot;
    staticModules = config.staticModules;
    return { manifest: { plugins: [], entries: [] }, entries: { start: async loader => {
      const ctx = loader.ctx;
      records.transport = ctx.transport;
      if (options.desktop) { await config.loadBundle(options.bundleUrl || 'fixture-desktop-probe'); records.probe = _facade.pendingQueue.at(-1); }
      const selection = staticModules['@deepseek-ai/dsh-client-store'].createSnapshotStore({}, { persist: { name: 'dsh.sessions.current' } });
      ctx.initialSelection = plain(selection.getSnapshot());
      ctx.uiWorkspace = { selection, sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: Object.fromEntries(ids.map(id => [id, { id }])) }) } },
        openSession: id => selection.set({ sessionId: id }) };
      ctx.transport.createWebSocket('ws://fixture/api/remote.mux');
      if (options.failChildDispose) ctx.loader.byId.set('dependent', { options: { name: 'dependent' }, fiber: { dispose: async () => { throw Error('fixture cleanup failure'); } } });
      if (options.failEntries) throw Error('fixture entry failure');
    } } };
  } };
  // Cordis services expose their owning Context to the loader.
  class OwnedService extends Service { constructor(ctx, name) { super(ctx, name); this.ctx = ctx; } }
  const require = id => {
    if (id === '@deepseek-ai/cordis') return { Context, Service: OwnedService };
    if (id === '@deepseek-ai/dsh-client-modules') return face;
    if (id === '@deepseek-ai/dsh-client-store') return storeFace;
    if (id === '@deepseek-ai/dsh-client-connection') return { installConnection(ctx, { transport }) {
      ctx.transport = transport;
      ctx.connection = { state: { getSnapshot: () => 'ready' }, rpc: { call: async () => ({ value: { items: ids.map(sessionId => ({ sessionId })) } }) } };
    } };
    return {};
  };
  const env = { console, URL, AbortController, AbortSignal, Map, Set, Error, Promise, Object, JSON, setTimeout, clearTimeout,
    location: { origin: 'http://fixture' }, document: { body: new Element(), createElement: () => new Element() }, WebSocket: Socket,
    __DSH_BOOT__: options.boot || { entries: [], batches: [] },

    fetch: async (path, init) => { records.fetches.push({ path, init }); return { ok: true, text: async () => options.bundleSource || '', json: async () => ({ result: { ok: true, value: { items: ids.map(sessionId => ({ sessionId })) } } }) }; } };
  if (options.desktop) for (const key of ['dshDesktop', 'dshDesktopBoot', 'dshOnboarding', 'dshPlatform']) Object.defineProperty(env, key, { value: Object.freeze({ marker: 'mac-only' }), configurable: false, writable: false });
  const helpers = fs.readFileSync(new URL('../lib/transport.js', import.meta.url), 'utf8').replaceAll('export ', '');
  vm.runInNewContext(helpers + '\n' + functions + '\n;globalThis.factories={createRemoteTree,createRemoteTreeManager};', env);
  return { env, records, require, container: new Element(), ...env.factories };
}

test('existing remote selection is seeded before native startup and never overwrites the Mac selection', async () => {
  const f = fixture();
  const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId: 'remote-a', container: f.container });
  assert.equal(handle.ok, true);
  assert.deepEqual(f.records.contexts[0].initialSelection, { sessionId: 'remote-a' });
  assert.deepEqual(plain(f.records.persisted.get('dsh.sessions.current')), { sessionId: 'mac-original' });
  assert.deepEqual(plain(f.records.persisted.get('dsh.unified.alpha.sessions.current')), { sessionId: 'remote-a' });
  await handle.dispose();
});

test('disposal actually closes transport sockets, unmounts the renderer and is idempotent', async () => {
  const f = fixture();
  const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId: 'remote-a', container: f.container });
  await Promise.all([handle.dispose(), handle.dispose()]);
  assert.equal(f.records.contexts[0].disposals, 1);
  assert.equal(f.records.contexts[0].unmounted, true);
  assert.equal(f.records.sockets[0].readyState, 3);
  assert.equal(f.container.children.length, 0);
  assert.equal(handle.ok, false);
  assert.equal(f.records.fetches.some(row => row.path.endsWith('/session/cancel')), false);
});

test('partially booted clients are disposed when an entry fails', async () => {
  const f = fixture({ failEntries: true });
  const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId: 'remote-a', container: f.container });
  assert.equal(handle.ok, false);
  assert.equal(f.records.contexts[0].disposals, 1);
  assert.equal(f.records.sockets[0].readyState, 3);
  assert.equal(f.container.children.length, 0);
});

test('mount failures remove the allocated DOM and close the connection', async () => {
  const f = fixture({ failMount: true });
  const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId: 'remote-a', container: f.container });
  assert.equal(handle.ok, false);
  assert.equal(f.records.contexts[0].disposals, 1);
  assert.equal(f.records.sockets[0].readyState, 3);
  assert.equal(f.container.children.length, 0);
});

test('a failing child cleanup still releases the root context, socket and mount', async () => {
  const f = fixture({ failChildDispose: true });
  const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId: 'remote-a', container: f.container });
  assert.equal(handle.ok, true);
  await assert.rejects(handle.dispose());
  assert.equal(f.records.contexts[0].disposals, 1);
  assert.equal(f.records.sockets[0].readyState, 3);
  assert.equal(f.container.children.length, 0);
});

test('missing or stale target identities fail before bootstrapping a default session', async () => {
  for (const sessionId of [undefined, 'missing']) {
    const f = fixture();
    const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId, container: f.container });
    assert.equal(handle.ok, false);
    assert.equal(f.records.contexts.length, 0);
    assert.equal(f.records.fetches.some(row => row.path.endsWith('/session/create')), false);
  }
});

test('startup cannot create a blank; explicit actions are enabled only after activation', async () => {
  const f = fixture();
  const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId: 'remote-a', container: f.container });
  const transport = f.records.contexts[0].transport;
  assert.throws(() => transport.fetch('/api/session/create', {}));
  assert.throws(() => transport.fetch('/api/workspace/initializeDefault', {}));
  assert.equal(f.records.fetches.length, 1);
  handle.activate(); await transport.fetch('/api/session/create', {});
  assert.equal(f.records.fetches.at(-1).path, '/api/dsh-unified/hosts/alpha/native/session/create');
  await handle.dispose();
});

test('a cancelled boot never opens a connection', async () => {
  const f = fixture(); const control = new AbortController(); control.abort();
  const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId: 'remote-a', signal: control.signal, container: f.container });
  assert.equal(handle.ok, false); assert.equal(f.records.fetches.length, 0); assert.equal(f.records.sockets.length, 0);
});

test('manager passes the explicit target and releases only its owned client', async () => {
  const f = fixture(); let disposed = 0; let options;
  const manager = f.createRemoteTreeManager(f.require, { bootTree: async opts => { options = opts; return { ok: true, dispose: async () => { disposed++; } }; } });
  await manager.ensure('alpha', f.container, 'remote-a');
  assert.equal(options.sessionId, 'remote-a');
  await Promise.all([manager.release('alpha'), manager.release('alpha')]);
  assert.equal(disposed, 1); assert.equal(options.signal.aborted, true); assert.equal(manager.trees.size, 0);
});

test('a preseeded blank still acquires a native main-view reference before activation', async () => {
  const f = fixture(); let opens = 0; let activations = 0;
  const handle = { ok: true, selection: () => ({ sessionId: 'remote-a' }), openSession: () => { opens++; }, activate: () => { activations++; },
    uiWorkspace: { sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: { 'remote-a': {} } }) } } }, dispose: async () => {} };
  const manager = f.createRemoteTreeManager(f.require, { bootTree: async () => handle });
  await manager.ensure('alpha', f.container, 'remote-a');
  assert.equal(await manager.open('alpha', 'remote-a'), true);
  assert.equal(opens, 1); assert.equal(activations, 1);
  await manager.release('alpha');
});

test('releasing an in-flight boot aborts it and disposes a late handle', async () => {
  const f = fixture(); let finish; let signal; let disposals = 0;
  const handle = { ok: true, dispose: async () => { if (!handle.closed) { handle.closed = true; disposals++; } } };
  const manager = f.createRemoteTreeManager(f.require, { bootTree: opts => { signal = opts.signal; return new Promise(resolve => { finish = resolve; }); } });
  const opening = manager.ensure('alpha', f.container, 'remote-a');
  const closing = manager.release('alpha');
  assert.equal(signal.aborted, true); finish(handle);
  await Promise.all([opening, closing]);
  assert.equal(disposals, 1); assert.equal(manager.trees.size, 0);
});

test('a failed startup is not cached as the next opening attempt', async () => {
  const f = fixture(); let attempts = 0;
  const manager = f.createRemoteTreeManager(f.require, { bootTree: async () => ({ ok: ++attempts > 1, dispose: async () => {} }) });
  await manager.ensure('alpha', f.container, 'remote-a'); assert.equal(manager.trees.size, 0);
  await manager.ensure('alpha', f.container, 'remote-a'); assert.equal(attempts, 2);
  await manager.release('alpha');
});


test('remote composition excludes Mac-only addons, experimental APIs and unfiltered HMR', async () => {
  const keep = ['@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-workspace'];
  const omit = ['@deepseek-ai/dsh-client-ui-experimental-cot-translation', 'dsh-macos-notify',
    '@zhitao-zeng/dsh-unified-workspaces', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-hmr', 'dsh-prompt-predict'];
  const boot = { rev: 'desktop-full', entries: [...keep, ...omit].map(id => ({ id })),
    batches: [{ id: 'native', entries: [...keep, ...omit] }, { id: 'mac-only', entries: omit }] };
  const f = fixture({ boot });
  const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId: 'remote-a', container: f.container });
  assert.equal(handle.ok, true);
  assert.deepEqual(plain(f.records.boot.entries.map(entry => entry.id)), keep);
  assert.deepEqual(plain(f.records.boot.batches.map(batch => batch.entries)), [keep]);
  assert.equal(f.env.__DSH_BOOT__.entries.length, keep.length + omit.length);
  await handle.dispose();
});


test('switching away while a session list is loading is a normal cancellation', async () => {
  const f = fixture();
  const handle = { ok: true, selection: () => ({ sessionId: 'remote-a' }),
    uiWorkspace: { sessions: { list: { getSnapshot: () => ({ phase: 'loading' }) } } }, dispose: async () => {} };
  const manager = f.createRemoteTreeManager(f.require, { bootTree: async () => handle });
  await manager.ensure('alpha', f.container, 'remote-a');
  const opening = manager.open('alpha', 'remote-a');
  await manager.release('alpha');
  assert.equal(await opening, false);
  assert.equal(manager.debug.errors.length, 0);
});


test('remote bundles cannot see immutable Electron preload bridges or re-enter desktop onboarding', async () => {
  const f = fixture({ desktop: true, bundleSource: `window.__ModuleLoader__.load({ id: 'desktop-probe',
    desktop: 'dshDesktop' in globalThis, carrier: globalThis.dshDesktop,
    onboarding: globalThis.dshOnboarding, platform: window.dshPlatform,
    boot: self.dshDesktopBoot, alias: window === self && self === globalThis && window.window === window });` });
  const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId: 'remote-a', container: f.container });
  assert.equal(handle.ok, true);
  assert.equal(f.records.probe.desktop, false);
  for (const key of ['carrier', 'onboarding', 'platform', 'boot']) assert.equal(f.records.probe[key], undefined);
  assert.equal(f.records.probe.alias, true);
  assert.equal(f.env.dshDesktop.marker, 'mac-only');
  assert.equal(Object.getOwnPropertyDescriptor(f.env, 'dshDesktop').configurable, false);
  await handle.dispose();
});


test('desktop remote transport resolves WebSockets against the native HTTP host', async () => {
  const f = fixture();
  f.env.location = { origin: 'dsh-app://app', href: 'dsh-app://app/' };
  f.env.__DSH_TRANSPORT__ = { streamBaseUrl: 'http://127.0.0.1:54321' };
  const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId: 'remote-a', container: f.container });
  assert.equal(handle.ok, true);
  assert.equal(f.records.transport.streamBaseUrl, 'http://127.0.0.1:54321/');
  await handle.dispose();
});

test('remote shortcuts use Web handling despite the shared Electron DOM marker', async () => {
  const f = fixture({ desktop: true, bundleUrl: 'plugins/??@deepseek-ai/dsh-client-shortcuts/client.js', bundleSource: `window.__ModuleLoader__.load({ id: 'shortcuts-probe', factory() { const desktop = document.documentElement.dataset.platform; return desktop; } });` });
  const handle = await f.createRemoteTree(f.require)({ hostId: 'alpha', sessionId: 'remote-a', container: f.container });
  assert.equal(handle.ok, true);
  assert.equal(f.records.probe.factory(), undefined);
  await handle.dispose();
});
