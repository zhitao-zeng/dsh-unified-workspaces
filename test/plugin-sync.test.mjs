import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync, mkdtempSync, rmSync, existsSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createPluginSyncHandler } from '../lib/plugin-sync.js';

const plugin = (name, version = '1.2.3', extra = {}) => ({ name, version, source: name + '@^' + version,
  installed: true, enabled: true, availability: 'profile', ...extra });
const hmr = [{ entryId: 'hmr', moduleName: '@deepseek-ai/dsh-hmr', enabled: true, fiberPhase: 'active' }];
async function fixture(options = {}) {
  const state = { source: [plugin('portable-one'), plugin('portable-two'), plugin('dsh-macos-notify'),
    plugin('custom-package', '1.0.0', { source: 'file:/private/local-package.tgz?secret=never-copy' }),
    plugin('@linxin666/dsh-remote-web-ui'), plugin('@local/custom-plugin'), plugin('@deepseek-ai/dsh-base')],
  target: [], calls: [], authorized: true, busy: false, hmr: true, installs: 0, inFlight: 0, maximum: 0, ...options };
  let markers = [];
  const handler = createPluginSyncHandler({ authorize: async () => state.authorized,
    pendingStore: { read: () => structuredClone(markers), write: value => { markers = structuredClone(value); } },
    connection: { createPeer: () => ({ async dispose() {} }) },
    gateway: { async invoke({ namespace, method }) {
      state.calls.push({ host: 'mac', namespace, method });
      assert.equal(namespace, 'pluginManager');
      if (method === 'listBundles') return state.source;
      if (method === 'listPlugins') return hmr;
      throw Error('Unexpected source mutation');
    } }, remotes: [{ id: 'server-one', label: 'Server One', origin: 'http://127.0.0.1:45001', credential: async () => 'owner-fixture' }],
    async fetchImpl(url, init) {
      assert.equal(new URL(url).origin, 'http://127.0.0.1:45001'); assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body), [namespace, method] = body.method.split('/');
      const args = body.payload.args; state.calls.push({ host: 'server-one', namespace, method, args });
      let value;
      if (body.method === 'pluginManager/listBundles') value = state.target;
      else if (body.method === 'pluginManager/listPlugins') value = state.hmr ? hmr : [];
      else if (body.method === 'session/list') value = { items: state.sessionItems || [{ sessionId: 'existing-session', running: state.busy }] };
      else if (body.method === 'pluginManager/waitForInstall') value = state.waitResult || null;
      else if (body.method === 'pluginManager/installBundle') {
        state.installs++; state.inFlight++; state.maximum = Math.max(state.maximum, state.inFlight);
        assert.equal(args.options.enabled, false); assert.equal(args.options.saveExact, true);
        assert.deepEqual(Object.keys(args.options).sort(), ['enabled', 'requestId', 'saveExact']);
        if (state.installError) { state.inFlight--; throw Error('Transport lost'); }
        await new Promise(resolve => setImmediate(resolve));
        const at = args.spec.lastIndexOf('@'), name = args.spec.slice(0, at), version = args.spec.slice(at + 1);
        await state.installGate?.();
        state.target.push(plugin(name, version, { enabled: false, source: args.spec }));
        state.afterInstall?.(name);
        state.inFlight--; value = { application: state.application || 'applied', changed: true, version,
          ...(state.pendingBuilds ? { pendingBuilds: ['build-required'] } : {}),
          privateLog: '/private/no-public-path', error: { details: { secret: 'never-copy' } } };
      } else throw Error('Unexpected remote operation: ' + body.method);
      return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
    }, ...options.handler });
  const server = http.createServer((req, res) => handler(req.url.split('/').at(-1), req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const call = async (action, value) => { const r = await fetch(origin + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); return { status: r.status, body: await r.json() }; };
  const done = async () => { handler.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); };
  const plan = async (packages = ['portable-one']) => (await call('plan', { target: 'server-one', packages })).body.value;
  const execute = async (p, requestId = 'request_identifier_123456') => call('execute', { planId: p.planId, requestId, confirm: true });
  const result = async jobId => { for (let i = 0; i < 50; i++) { const r = await call('status', { jobId }); if (!['checking', 'installing'].includes(r.body.value.phase)) return r.body.value; await new Promise(resolve => setImmediate(resolve)); } throw Error('Job did not finish'); };
  return { state, handler, call, done, plan, execute, result };
}

test('inventory uses real bundle selection and excludes local/platform/remote access sources without leaking settings', async () => {
  const f = await fixture(); try {
    const r = await f.call('inventory', { target: 'server-one' }); assert.equal(r.status, 200);
    const rows = r.body.value.source.bundles;
    assert.equal(rows.find(x => x.name === 'portable-one').eligible, true);
    for (const name of ['dsh-macos-notify', 'custom-package', '@linxin666/dsh-remote-web-ui', '@local/custom-plugin', '@deepseek-ai/dsh-base']) assert.equal(rows.find(x => x.name === name).eligible, false);
    assert.equal(JSON.stringify(r.body).includes('/private/'), false); assert.equal(JSON.stringify(r.body).includes('never-copy'), false);
    const p = await f.plan(); assert.equal(p.rows[0].sourceVersion, '1.2.3'); assert.equal(p.rows[0].afterEnabled, false);
    assert.equal(p.target, 'server-one'); assert.equal(p.settingsCopied, false); assert.equal(p.restartAllowed, false);
    assert.equal(f.state.installs, 0);
  } finally { await f.done(); }
});

test('requests cannot select arbitrary hosts, methods, URLs, specs, or bypass plan confirmation and auth', async () => {
  const f = await fixture(); try {
    for (const [action, input] of [['inventory', { target: 'http://example.test' }], ['plan', { target: 'server-one', packages: ['https://example.test/evil.tgz'] }],
      ['plan', { target: 'server-one', packages: ['portable-one'], spec: 'evil' }], ['inventory', { target: 'server-one', method: 'bash/run' }],
      ['execute', { planId: 'some_plan_identifier_123', requestId: 'request_identifier_1234', confirm: false }]]) assert.equal((await f.call(action, input)).status, 400);
    assert.equal((await f.call('unknown', {})).status, 405);
    f.state.authorized = false; assert.equal((await f.call('inventory', { target: 'server-one' })).status, 403);
    assert.equal(f.state.calls.length, 0);
  } finally { await f.done(); }
});

test('confirmed packages install exact versions serially, remain disabled and repeated submits do not replay', async () => {
  const f = await fixture(); try {
    const p = await f.plan(['portable-one', 'portable-two']);
    const started = (await f.execute(p)).body.value;
    const duplicate = (await f.execute(p)).body.value; assert.equal(duplicate.jobId, started.jobId);
    const r = await f.result(started.jobId); assert.equal(r.phase, 'complete');
    assert.equal(f.state.maximum, 1); assert.equal(f.state.installs, 2); assert.equal(r.results.length, 2);
    assert.ok(r.results.every(x => x.verified && !x.enabled));
    assert.equal((await f.execute(p, 'different_request_identifier_123')).status, 409);
    assert.equal(JSON.stringify(r).includes('privateLog'), false); assert.equal(JSON.stringify(r).includes('never-copy'), false);
    assert.deepEqual(f.state.calls.filter(x => x.method === 'installBundle').map(x => x.args.spec), ['portable-one@1.2.3', 'portable-two@1.2.3']);
    assert.ok(f.state.calls.every(x => !['setBundleEnabled', 'setPluginEnabled', 'removeBundle', 'cancelInstall', 'create', 'send'].includes(x.method)));
  } finally { await f.done(); }
});

test('target versions and enabled states are retained; package-only plan does not replace installed packages', async () => {
  const f = await fixture({ target: [plugin('portable-one', '1.0.0'), plugin('portable-two')] }); try {
    const p = await f.plan(['portable-one', 'portable-two']);
    assert.equal(p.rows[0].action, 'maintenance'); assert.equal(p.rows[1].action, 'current');
    assert.ok(p.rows.every(x => x.targetEnabled && x.afterEnabled));
    assert.equal((await f.execute(p)).status, 409); assert.equal(f.state.installs, 0);
  } finally { await f.done(); }
});

test('busy target, absent HMR and stale plans stop without installing or cancelling sessions', async () => {
  for (const mode of ['busy', 'no-hmr', 'stale']) {
    const f = await fixture({ busy: mode === 'busy', hmr: mode !== 'no-hmr' }); try {
      const p = await f.plan(); if (mode === 'stale') f.state.source[0] = plugin('portable-one', '2.0.0');
      const started = (await f.execute(p)).body.value, r = await f.result(started.jobId);
      assert.equal(r.phase, 'stopped'); assert.equal(f.state.installs, 0);
      assert.equal(r.code, { busy: 'plugin-sync/target-busy', 'no-hmr': 'plugin-sync/maintenance-required', stale: 'plugin-sync/plan-stale' }[mode]);
    } finally { await f.done(); }
  }
});

test('uncertain or restart-required result stops subsequent packages and never retries', async () => {
  for (const options of [{ installError: true }, { application: 'restart-required' }]) {
    const f = await fixture(options); try {
      const started = (await f.execute(await f.plan(['portable-one', 'portable-two']))).body.value;
      const r = await f.result(started.jobId); assert.equal(f.state.installs, 1);
      assert.equal(r.phase, options.installError ? 'uncertain' : 'complete');
      assert.equal(f.state.target.length, options.installError ? 0 : 1);
      assert.equal(f.state.calls.some(x => /restart|cancel|remove/i.test(x.method)), false);
    } finally { await f.done(); }
  }
});

test('unknown install keeps the target locked across a fresh plan until official completion is confirmed', async () => {
  const f = await fixture({ installError: true }); try {
    const first = (await f.execute(await f.plan())).body.value;
    const unknown = await f.result(first.jobId);
    assert.equal(unknown.code, 'plugin-sync/result-uncertain');
    const second = await f.execute(await f.plan(), 'second_request_identifier_123');
    assert.equal(second.status, 409, 'a new plan must not bypass an unknown dispatched install');
    assert.equal(f.state.installs, 1);
  } finally { await f.done(); }
});

test('unknown lock survives handler restart; null plus matching inventory never unlocks; official result can recover', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plugin-sync-marker-')), file = join(directory, 'pending.json');
  const settings = { pendingFile: file, pendingStore: undefined };
  let first, second;
  try {
    first = await fixture({ installError: true, handler: settings });
    const p = await first.plan(); assert.equal(existsSync(file), false, 'read-only planning must not write the marker');
    const started = (await first.execute(p)).body.value; await first.result(started.jobId);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const marker = JSON.parse(readFileSync(file, 'utf8')).pending[0];
    assert.ok(marker.installRequestId); assert.equal(marker.originHash.length, 64);
    assert.equal(marker.installRequestId, first.state.calls.find(c => c.method === 'installBundle').args.options.requestId);
    await first.done(); first = null;
    second = await fixture({ target: [plugin('portable-one', '1.2.3', { enabled: false })], handler: settings });
    const inventory = (await second.call('inventory', { target: 'server-one' })).body.value;
    assert.equal(inventory.activeJob, started.jobId);
    const unknown = (await second.call('status', { jobId: started.jobId })).body.value;
    assert.equal(unknown.phase, 'uncertain'); assert.ok(unknown.message.includes('继续锁定'));
    assert.equal((await second.execute(await second.plan(['portable-two']))).status, 409);
    assert.equal(second.state.installs, 0);
    assert.equal(second.state.calls.find(c => c.method === 'waitForInstall').args.requestId, marker.installRequestId);
    second.state.waitResult = { application: 'applied', changed: true, version: '1.2.3' };
    const recovered = (await second.call('status', { jobId: started.jobId })).body.value;
    assert.equal(recovered.phase, 'complete'); assert.equal(recovered.results[0].verified, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pending.length, 0);
    const next = (await second.execute(await second.plan(['portable-two']))).body.value;
    assert.equal((await second.result(next.jobId)).phase, 'complete'); assert.equal(second.state.installs, 1);
  } finally { if (first) await first.done(); if (second) await second.done(); rmSync(directory, { recursive: true, force: true }); }
});

test('origin changes cannot recover a pending operation against another machine with the same id', async () => {
  let markers = [];
  const pendingStore = { read: () => structuredClone(markers), write: v => { markers = structuredClone(v); } };
  const first = await fixture({ installError: true, handler: { pendingStore } });
  let id;
  try { id = (await first.execute(await first.plan())).body.value.jobId; await first.result(id); }
  finally { await first.done(); }
  const second = await fixture({ handler: { pendingStore, remotes: [{ id: 'server-one', label: 'Other Server', origin: 'http://127.0.0.1:45002', credential: async () => 'other-owner' }] } });
  try {
    const r = (await second.call('status', { jobId: id })).body.value;
    assert.equal(r.phase, 'uncertain'); assert.ok(r.message.includes('连接配置已变化'));
    assert.equal(second.state.calls.length, 0, 'must not send a pending id or credential to another origin');
    assert.equal(markers.length, 1);
  } finally { await second.done(); }
});

test('unreadable, unknown or symlinked durable markers fail closed and are never overwritten', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plugin-sync-invalid-marker-')), file = join(directory, 'pending.json'), link = join(directory, 'link.json');
  const original = '{"version":1,"pending":[{"unknown":"do not overwrite"}]}';
  writeFileSync(file, original, { mode: 0o600 }); symlinkSync(file, link);
  try {
    for (const pendingFile of [file, link]) {
      const f = await fixture({ handler: { pendingFile, pendingStore: undefined } }); try {
        const p = await f.plan(); assert.equal(p.persistenceReady, false);
        assert.equal((await f.execute(p)).status, 503); assert.equal(f.state.installs, 0);
        assert.equal(readFileSync(file, 'utf8'), original);
      } finally { await f.done(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a disposed old handler cannot overwrite a new handler marker for another target', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plugin-sync-two-handlers-')), file = join(directory, 'pending.json');
  const settings = { pendingFile: file, pendingStore: undefined };
  let releaseOld, releaseNew;
  const oldGate = new Promise(resolve => { releaseOld = resolve; }), newGate = new Promise(resolve => { releaseNew = resolve; });
  const first = await fixture({ installGate: () => oldGate, handler: settings });
  let second;
  const settleUntil = async test => { for (let i = 0; i < 100; i++) { if (test()) return; await new Promise(resolve => setImmediate(resolve)); } throw Error('Fixture did not reach dispatch'); };
  try {
    await first.execute(await first.plan()); await settleUntil(() => first.state.installs === 1);
    first.handler.close();
    second = await fixture({ installGate: () => newGate, handler: { ...settings, remotes: [
      { id: 'server-one', label: 'Server One', origin: 'http://127.0.0.1:45001', credential: async () => 'owner-fixture' },
      { id: 'server-two', label: 'Server Two', origin: 'http://127.0.0.1:45001', credential: async () => 'owner-fixture' },
    ] } });
    const plan = (await second.call('plan', { target: 'server-two', packages: ['portable-two'] })).body.value;
    const job = (await second.execute(plan)).body.value; await settleUntil(() => second.state.installs === 1);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pending.map(x => x.host).sort(), ['server-one', 'server-two']);
    releaseOld(); await settleUntil(() => first.state.target.length === 1);
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pending.map(x => x.host).sort(), ['server-one', 'server-two']);
    releaseNew(); assert.equal((await second.result(job.jobId)).phase, 'complete');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pending.map(x => x.host), ['server-one']);
    assert.equal(first.state.installs, 1); assert.equal(second.state.installs, 1);
  } finally { releaseOld(); releaseNew(); await first.done(); if (second) await second.done(); rmSync(directory, { recursive: true, force: true }); }
});

test('completed plan dedupe retention is bounded and does not permanently exhaust the plan limit', async () => {
  let clock = 1_000_000;
  const f = await fixture({ handler: { now: () => clock, maxPlans: 1 } }); try {
    const started = (await f.execute(await f.plan())).body.value;
    await f.result(started.jobId); clock += 31 * 60_000;
    const next = await f.call('plan', { target: 'server-one', packages: ['portable-two'] });
    assert.equal(next.status, 200); assert.equal(next.body.value.installs, 1);
    assert.equal((await f.call('status', { jobId: started.jobId })).status, 404);
  } finally { await f.done(); }
});

test('each package rechecks target changes made outside this plan and invalid session status is fail closed', async () => {
  const f = await fixture(); try {
    f.state.afterInstall = () => f.state.target.push(plugin('portable-two', '9.0.0'));
    const started = (await f.execute(await f.plan(['portable-one', 'portable-two']))).body.value;
    const r = await f.result(started.jobId);
    assert.equal(r.code, 'plugin-sync/plan-stale'); assert.equal(f.state.installs, 1);
    assert.equal(f.state.target.find(x => x.name === 'portable-two').version, '9.0.0');
  } finally { await f.done(); }
  const malformed = await fixture({ sessionItems: [{ sessionId: 'existing-session' }] }); try {
    const started = (await malformed.execute(await malformed.plan())).body.value;
    assert.equal((await malformed.result(started.jobId)).phase, 'stopped'); assert.equal(malformed.state.installs, 0);
  } finally { await malformed.done(); }
});

test('plugin UI requires plan confirmation and permits explicit recovery after a status read failure', async () => {
  const source = readFileSync(new URL('../plugin-sync.template.js', import.meta.url), 'utf8');
  const slots = [], effects = [], timers = new Map(), calls = [];
  let position = 0, queued = false, tree, seq = 0, mounted = true;
  const renderSoon = () => { if (!queued && mounted) { queued = true; queueMicrotask(() => { queued = false; render(); }); } };
  const React = {
    useState(initial) { const i = position++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (next !== slots[i]) { slots[i] = next; renderSoon(); } }]; },
    useRef(value) { const i = position++; return slots[i] ||= { current: value }; },
    useEffect(fn, dependencies) { const i = position++, old = slots[i];
      if (!old || dependencies.some((x, j) => x !== old.dependencies[j])) { slots[i] = { dependencies, cleanup: old?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter(x => x !== null && x !== undefined && x !== false) });
  const sourceRow = { name: 'portable-one', version: '1.2.3', installed: true, enabled: true, eligible: true, reason: '' };
  const factory = vm.runInNewContext(source + '\ncreatePluginSyncPanel', { AbortSignal, AbortController,
    crypto: { randomUUID: () => 'request_identifier_123456' },
    setTimeout(fn) { const id = ++seq; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  const Component = factory({ React, h, requestAccess: () => ({ prefix: '/remote', headers: { 'x-dsh-remote-device': 'paired-device-fixture' } }),
    async requestFetch(url, init) {
      const action = url.split('/').at(-1); calls.push({ url, action, value: JSON.parse(init.body), headers: init.headers, signal: init.signal });
      let value;
      if (action === 'inventory') value = { source: { bundles: [sourceRow] }, destination: { bundles: [], hotReload: true } };
      else if (action === 'plan') value = { planId: 'plan_identifier_123456', targetLabel: 'Server One', rows: [{ name: 'portable-one', sourceVersion: '1.2.3', action: 'install', reason: '保持关闭' }], installs: 1, hotReload: true };
      else if (action === 'execute') value = { jobId: 'job_identifier_123456', phase: 'checking', targetLabel: 'Server One', results: [], message: '核对中' };
      else if (action === 'status') throw Error('Status connection failed');
      else throw Error('Unexpected UI action');
      return new Response(JSON.stringify({ ok: true, value }));
    } });
  const props = { hosts: [{ id: 'mac', label: 'Mac' }, { id: 'server-one', label: 'Server One' }] };
  function render() { if (!mounted) return; position = 0; tree = Component(props); for (const effect of effects.splice(0)) effect(); }
  const nodes = (node = tree) => typeof node !== 'object' || !node ? [] : [node, ...node.children.flatMap(x => nodes(x))];
  const text = node => typeof node === 'object' && node ? node.children.map(text).join('') : String(node || '');
  const button = label => nodes().find(n => n.type === 'button' && text(n).includes(label));
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    render(); await settle(); assert.equal(calls.filter(c => c.action === 'execute').length, 0);
    const check = nodes().find(n => n.type === 'input' && n.props.type === 'checkbox');
    check.props.onChange({ target: { checked: true } }); await settle();
    await button('查看 1 项同步计划').props.onClick(); await settle();
    assert.equal(calls.filter(c => c.action === 'execute').length, 0);
    await button('确认将 1 个安装包').props.onClick(); await settle();
    assert.equal(button('刷新清单').props.disabled, true);
    for (const [id, callback] of [...timers]) { timers.delete(id); await callback(); } await settle();
    assert.equal(button('刷新清单').props.disabled, false);
    assert.ok(nodes().some(n => n.props.role === 'alert' && text(n).includes('状态读取中断')));
    assert.equal(calls.filter(c => c.action === 'execute').length, 1);
    assert.ok(calls.every(c => c.url.startsWith('/remote/api/dsh-unified/plugin-sync/') && c.headers['x-dsh-remote-device'] === 'paired-device-fixture'));
  } finally { mounted = false; for (const slot of slots) slot?.cleanup?.(); }
});
