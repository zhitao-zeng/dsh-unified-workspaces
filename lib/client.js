window.__ModuleLoader__.load({
  id: '@zhitao-zeng/dsh-unified-workspaces',
  factory(require) {
    // Pure browser routing helpers, shared by the bundle and isolated checks.
const HOST_KEY = 'dsh-unified-host';
const API_PREFIX = '/api/dsh-unified';
function validHostId(value, allowLocal = true) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value) && (allowLocal || value !== 'mac');
}
function hostApiPrefix(hostId) {
  if (!validHostId(hostId, false)) throw new Error('远端主机标识无效。');
  return API_PREFIX + '/hosts/' + hostId;
}
// The legacy namespace is read only for an explicitly configured migration.
// Commit the selected source last, so a storage failure cannot initialize the
// native local Context with an old remote session id.
function migrateLegacySelection(win, config) {
  const storage = win.sessionStorage;
  if (storage.getItem(HOST_KEY) !== null) return false;
  const oldHost = storage.getItem('gpu16-native-host');
  const oldMap = storage.getItem('gpu16-native-selection-by-host');
  const oldPending = storage.getItem('gpu16-native-pending-selection');
  if (oldHost === null && oldMap === null && oldPending === null) return false;
  const remote = config?.legacyHostId;
  const known = Array.isArray(config?.hostIds) && config.hostIds.includes(remote) && validHostId(remote, false);
  const selection = value => value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && value.sessionId.length <= 512 && !value.sessionId.includes('\0');
  const host = value => value === 'mac' ? 'mac' : value === 'gpu16' && known ? remote : undefined;
  if (oldHost !== null && oldHost !== 'mac' && oldHost !== 'gpu16') throw new Error('Legacy source is invalid');
  if (oldHost === 'gpu16' && !known) throw new Error('Legacy remote requires an explicit configured mapping');
  let saved = {}, pending;
  if (oldMap) { try { saved = JSON.parse(oldMap); } catch { throw new Error('Legacy selection is invalid'); } }
  if (oldPending) { try { pending = JSON.parse(oldPending); } catch { throw new Error('Legacy pending selection is invalid'); } }
  const mapped = Object.create(null);
  for (const id of ['mac', 'gpu16']) {
    const target = host(id);
    if (target && saved && Object.hasOwn(saved, id) && selection(saved[id])) mapped[target] = { sessionId: saved[id].sessionId };
  }
  const currentHost = host(oldHost || 'mac');
  if (!Object.hasOwn(mapped, currentHost)) {
    let current;
    try { current = JSON.parse(win.localStorage.getItem('dsh.sessions.current') || 'null'); } catch {}
    if (selection(current)) mapped[currentHost] = { sessionId: current.sessionId };
    else if (currentHost !== 'mac') throw new Error('Legacy remote session is unavailable');
  }
  storage.setItem('dsh-unified-selection-by-host', JSON.stringify(mapped));
  if (pending !== undefined) {
    const target = host(pending?.host);
    if (target && selection(pending)) storage.setItem('dsh-unified-pending-selection', JSON.stringify({ host: target, sessionId: pending.sessionId }));
  }
  storage.setItem(HOST_KEY, currentHost);
  win.__DSH_UNIFIED_LEGACY_MIGRATED__ = true;
  return true;
}
function nativeHttpPrefix(hostId) { return hostApiPrefix(hostId) + '/native'; }
function absoluteWorkspacePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
    && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
}
const LOCAL = ['/api/pair', '/api/update', '/api/plugin-manager', API_PREFIX, '/api/dsh-web-ui-settings'];

// The App owns appearance and language. Model, credentials and every other
// settings namespace continue to belong to the selected execution Host.
function appearanceRoute(raw, base, body, hostId) {
  if (!validHostId(hostId, false)) return undefined;
  let url, page;
  try { page = new URL(base); url = new URL(raw, page); } catch { return undefined; }
  if (url.protocol !== page.protocol || url.host !== page.host) return undefined;
  const outer = url.pathname.startsWith('/remote/') ? '/remote' : '';
  const path = url.pathname.slice(outer.length);
  const match = /^\/api\/settings\/(describe|mutate|update|replace)$/.exec(path);
  if (!match) return undefined;
  const action = match[1];
  if (action !== 'describe') {
    let frame;
    try { if (typeof body === 'string') frame = JSON.parse(body); } catch {}
    if (frame?.type !== 'client-request' || frame.method !== 'settings/' + action
        || !['ui-theme', 'locale'].includes(frame.payload?.args?.ns)) return undefined;
  }
  url.pathname = outer + hostApiPrefix(hostId) + '/appearance/' + action;
  return url.href;
}

function filterClientGraph(graph, ids) {
  const allowed = new Set(ids);
  if (!Array.isArray(graph?.entries) || !Array.isArray(graph?.batches)) throw new Error('远端 界面模块清单无效。');
  const entries = graph.entries.filter(entry => allowed.has(entry.id));
  const active = new Set(entries.map(entry => entry.id));
  const batches = graph.batches.map(batch => ({ ...batch, entries: batch.entries.filter(id => active.has(id)) })).filter(batch => batch.entries.length > 0);
  return { ...graph, rev: graph.rev + '-dsh-unified-client', entries, batches };
}

function filterGraphEvent(event, ids, EventType = MessageEvent) {
  let value;
  try { value = JSON.parse(event.data); } catch { return event; }
  if (value.type === 'graph') value.graph = filterClientGraph(value.graph, ids);
  else if (value.type === 'rebuilt' && !ids.includes(value.id)) return null;
  else return event;
  return new EventType('message', { data: JSON.stringify(value), origin: event.origin, lastEventId: event.lastEventId });
}

function isGraphStream(raw, base) {
  try {
    const url = new URL(raw, base), page = new URL(base);
    return url.protocol === page.protocol && url.host === page.host && ['/plugins/events', '/remote/plugins/events'].includes(url.pathname);
  } catch { return false; }
}

function filterGraphResponse(response, ids) {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let buffered = '';
  function block(text) {
    const lines = text.split(/\r?\n/);
    const rows = lines.filter(line => line.startsWith('data:'));
    if (!rows.length) return text + '\n\n';
    let value;
    try { value = JSON.parse(rows.map(line => line.slice(5).trimStart()).join('\n')); } catch { return text + '\n\n'; }
    if (value.type === 'graph') value.graph = filterClientGraph(value.graph, ids);
    else if (value.type === 'rebuilt' && !ids.includes(value.id)) return '';
    else return text + '\n\n';
    return lines.filter(line => !line.startsWith('data:')).concat('data: ' + JSON.stringify(value)).join('\n') + '\n\n';
  }
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, output) {
      buffered += decoder.decode(chunk, { stream: true });
      if (buffered.length > 2 * 1024 * 1024) throw new Error('远端 界面更新数据过大。');
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffered))) {
        const text = buffered.slice(0, match.index);
        buffered = buffered.slice(match.index + match[0].length);
        const mapped = block(text);
        if (mapped) output.enqueue(encoder.encode(mapped));
      }
    },
    flush(output) {
      buffered += decoder.decode();
      if (buffered) { const mapped = block(buffered); if (mapped) output.enqueue(encoder.encode(mapped)); }
    },
  }));
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function routeGraphEvents(source, ids, EventType) {
  const originalAdd = source.addEventListener.bind(source);
  const originalRemove = source.removeEventListener.bind(source);
  const wrappers = new WeakMap();
  const wrapped = listener => {
    if (!listener) return listener;
    if (!wrappers.has(listener)) wrappers.set(listener, function(event) {
      const mapped = filterGraphEvent(event, ids, EventType);
      if (mapped) typeof listener === 'function' ? listener.call(source, mapped) : listener.handleEvent(mapped);
    });
    return wrappers.get(listener);
  };
  source.addEventListener = (type, listener, options) => originalAdd(type, type === 'message' ? wrapped(listener) : listener, options);
  source.removeEventListener = (type, listener, options) => originalRemove(type, type === 'message' ? wrappers.get(listener) || listener : listener, options);
  let onmessage;
  const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(source), 'onmessage');
  if (native?.set) Object.defineProperty(source, 'onmessage', {
    configurable: true, get: () => onmessage || null,
    set(listener) { onmessage = listener; native.set.call(source, listener ? wrapped(listener) : null); },
  });
  return source;
}

function routeUrl(raw, base, hostId) {
  if (!validHostId(hostId, false)) return raw;
  let url, page;
  try { page = new URL(base); url = new URL(raw, page); } catch { return raw; }
  if (url.protocol !== page.protocol || url.host !== page.host) return raw;
  const outer = url.pathname.startsWith('/remote/') ? '/remote' : '';
  const path = url.pathname.slice(outer.length);
  if (LOCAL.some(prefix => path === prefix || path.startsWith(prefix + '/'))) return raw;
  if (path.startsWith('/api/')) url.pathname = outer + nativeHttpPrefix(hostId) + path.slice('/api'.length);
  else if (['/sidebar', '/git', '/pet'].some(prefix => path === prefix || path.startsWith(prefix + '/'))) url.pathname = outer + nativeHttpPrefix(hostId) + '/_host' + path;
  else return raw;
  return url.href;
}

function muxPath(path, device, hostId) {
  if (!validHostId(hostId, false)) throw new Error('远端主机标识无效。');
  const url = new URL(path, 'http://127.0.0.1');
  if (!['/api/remote.mux', '/remote/api/remote.mux'].includes(url.pathname)) return path;
  const mapped = new URL('/dsh-unified/hosts/' + hostId + '/remote.mux', url);
  if (device && /^[A-Za-z0-9_-]{16,256}$/.test(device)) mapped.searchParams.set('device', device);
  return mapped.pathname + mapped.search;
}

function installResourceRouting(win, route) {
  const disposers = [];
  for (const [name, property] of [['HTMLImageElement','src'], ['HTMLMediaElement','src'], ['HTMLSourceElement','src'], ['HTMLIFrameElement','src'], ['HTMLAnchorElement','href'], ['HTMLVideoElement','poster'], ['HTMLObjectElement','data'], ['HTMLEmbedElement','src']]) {
    const prototype = win[name]?.prototype;
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor?.set || descriptor.configurable === false) continue;
    Object.defineProperty(prototype, property, { ...descriptor, set(value) { descriptor.set.call(this, route(String(value))); } });
    disposers.push(() => Object.defineProperty(prototype, property, descriptor));
  }
  const originalSet = win.Element?.prototype.setAttribute;
  if (originalSet) {
    win.Element.prototype.setAttribute = function(name, value) {
      const attribute = String(name).toLowerCase();
      return originalSet.call(this, name, ['src', 'href', 'poster', 'data'].includes(attribute) ? route(String(value)) : value);
    };
    disposers.push(() => { win.Element.prototype.setAttribute = originalSet; });
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

    function createPersistentEmbed({ hostId, fetch: requestFetch, changed }) {
  const endpoint = hostApiPrefix(hostId) + '/embed/';
  let metadata, frame, port, ready = false, opening, disposed = false, sequence = 0, invalidLease = false;
  let handshakeTimer, handshakeReject, leaseTimer;
  const pending = new Map();
  const parentOrigin = window.location.origin;
  const headers = { 'content-type': 'application/json', 'x-dsh-embed-parent': parentOrigin };
  const status = () => ({ metadata, ready });
  async function api(action, body) {
    const response = await requestFetch(endpoint + action, { method: 'POST', headers, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ ...body, parentOrigin }) });
    const value = await response.json();
    if (!response.ok || value?.ok !== true) { const error = new Error(value?.error?.message || '远端 工作区暂时无法连接。'); error.status = response.status; throw error; }
    return value.value;
  }
  function receive(value, resolveReady) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'ready' && value.frameId === metadata?.frameId) {
      ready = true; clearTimeout(handshakeTimer); handshakeReject = undefined;
      changed({ ready: true, sessionId: value.sessionId }); resolveReady?.(); return;
    }
    if (value.type === 'state' && value.frameId === metadata?.frameId) { changed({ sessionId: value.sessionId }); return; }
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    if (value.ok === true) entry.resolve(value.value); else entry.reject(new Error(typeof value.error === 'string' ? value.error : '远程操作未完成。'));
  }
  function connect() {
    return new Promise((resolve, reject) => {
      const started = Date.now(); handshakeReject = reject;
      function attempt() {
        if (disposed) { reject(new Error('工作台已关闭。')); return; }
        if (ready) { resolve(); return; }
        if (Date.now() - started >= 15_000) { handshakeReject = undefined; reject(new Error('远端 工作区尚未就绪，请稍后再点会话。')); return; }
        if (frame?.contentWindow && metadata) {
          try {
            port?.close(); const channel = new MessageChannel(); port = channel.port1;
            port.onmessage = event => receive(event.data, resolve); port.start?.();
            frame.contentWindow.postMessage({ type: 'dsh-unified/embed-init', frameId: metadata.frameId, controlToken: metadata.controlToken }, metadata.frameOrigin, [channel.port2]);
          } catch {}
        }
        handshakeTimer = setTimeout(attempt, 300);
      }
      attempt();
    });
  }
  function request(type, values = {}) {
    if (!ready || !port) return Promise.reject(new Error('远端 工作区尚未就绪。'));
    const id = 'parent-' + (++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('远端 操作尚未确认，请检查当前会话。')); }, 15_000);
      pending.set(id, { resolve, reject, timer });
      try { port.postMessage({ id, type, ...values }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  function expired() {
    if (invalidLease) return true;
    if (!metadata?.expiresAt) return false;
    const time = typeof metadata.expiresAt === 'number' ? metadata.expiresAt : Date.parse(metadata.expiresAt);
    return Number.isFinite(time) && Date.now() >= time;
  }
  function discardStartup() {
    const previous = metadata; metadata = undefined; frame = undefined; ready = false; invalidLease = false;
    clearTimeout(handshakeTimer); clearInterval(leaseTimer); try { port?.close(); } catch {} port = undefined;
    if (!disposed) changed({ metadata: undefined, ready: false });
    if (previous) api('close', { frameId: previous.frameId, controlToken: previous.controlToken }).catch(() => {});
  }
  async function ensure(sessionId) {
    if (disposed) throw new Error('工作台已关闭。');
    if (opening) return opening;
    if (ready && !expired()) return;
    opening = (async () => {
      if (metadata && expired()) discardStartup();
      if (!metadata) {
        const value = await api('bootstrap', { sessionId });
        if (disposed) { await api('close', { frameId: value.frameId, controlToken: value.controlToken }).catch(() => {}); return; }
        const url = new URL(value.frameUrl);
        if (value.frameOrigin !== url.origin || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || typeof value.frameId !== 'string' || typeof value.controlToken !== 'string') throw new Error('远程工作区入口无效。');
        metadata = value; changed({ metadata });
        leaseTimer = setInterval(() => {
          const current = metadata;
          if (disposed || !current) return;
          api('refresh', { frameId: current.frameId, controlToken: current.controlToken }).then(value => {
            if (!disposed && metadata === current && value?.expiresAt) metadata = { ...current, expiresAt: value.expiresAt };
          }).catch(error => {
            if (disposed || metadata?.frameId !== current.frameId) return;
            if (error?.status === 403) invalidLease = true;
            changed({ notice: '远程入口需要重新确认，请稍后重试。' });
          });
        }, 5 * 60_000);
      }
      try { await connect(); }
      catch (error) {
        // A bootstrap nonce is consumed by its first document. Discard only a
        // failed startup so the next explicit click obtains a fresh frame.
        discardStartup();
        throw error;
      }
    })().finally(() => { opening = undefined; });
    return opening;
  }
  return {
    status,
    attach(element) { frame = element; },
    async open(sessionId) { await ensure(sessionId); if (disposed) return; const result = await request('session/open', { sessionId }); frame?.focus?.(); return result; },
    async openPlugins(sessionId) { await ensure(sessionId); if (disposed) return; const result = await request('plugin-manager/open'); frame?.focus?.(); return result; },
    appearance(css) { if (ready) request('appearance/reload', { css }).catch(() => {}); },
    focus() { frame?.focus?.(); },
    dispose() {
      disposed = true; clearTimeout(handshakeTimer); clearInterval(leaseTimer); handshakeReject?.(new Error('工作台已关闭。'));
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('工作台已关闭。')); } pending.clear();
      try { port?.close(); } catch {}
      if (metadata) api('close', { frameId: metadata.frameId, controlToken: metadata.controlToken }).catch(() => {});
      frame = undefined; port = undefined;
    },
  };
}

    // Injected as a factory-level function by build-client.mjs.
function createPluginSyncPanel({ React, h, requestFetch, requestAccess }) {
  const border = '1px solid var(--dsw-alias-border-l2,#cdd1d7)';
  const button = { border, borderRadius: 7, padding: '6px 10px', background: 'transparent', color: 'inherit', cursor: 'pointer' };
  async function request(action, input, signal) {
    const access = requestAccess();
    const response = await requestFetch(access.prefix + '/api/dsh-unified/plugin-sync/' + action, {
      method: 'POST', credentials: 'same-origin', headers: { ...access.headers, 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
    });
    let data; try { data = await response.json(); } catch {}
    if (!response.ok || data?.ok !== true) throw new Error(data?.error?.message || '插件同步服务暂时不可用，请刷新清单核对。');
    return data.value;
  }
  return function PluginSyncPanel({ hosts = [], onOpenTarget }) {
    const remotes = hosts.filter(host => host.id !== 'mac');
    const [target, setTarget] = React.useState(remotes[0]?.id || '');
    const [data, setData] = React.useState(null), [selected, setSelected] = React.useState([]);
    const [plan, setPlan] = React.useState(null), [job, setJob] = React.useState(null);
    const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState(''), [statusUnknown, setStatusUnknown] = React.useState(false);
    const mounted = React.useRef(true), generation = React.useRef(0);
    const working = !statusUnknown && job && ['checking', 'installing'].includes(job.phase);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
    React.useEffect(() => {
      if (!remotes.some(host => host.id === target)) setTarget(remotes[0]?.id || '');
    }, [target, remotes.map(host => host.id).join(',')]);
    async function refresh() {
      if (!target) return;
      const current = ++generation.current; setBusy(true); setNotice(''); setPlan(null);
      try {
        const value = await request('inventory', { target });
        if (!mounted.current || generation.current !== current) return;
        setData(value); setSelected(old => old.filter(name => value.source.bundles.some(row => row.name === name && row.eligible)));
        if (value.activeJob) {
          const next = await request('status', { jobId: value.activeJob });
          if (!mounted.current || generation.current !== current) return;
          setStatusUnknown(false); setJob(next);
        } else if (statusUnknown) { setJob(null); setStatusUnknown(false); }
      } catch (error) { if (mounted.current && generation.current === current) { setData(null); setNotice(error.message); } }
      finally { if (mounted.current && generation.current === current) setBusy(false); }
    }
    React.useEffect(() => { setSelected([]); setData(null); setPlan(null); setJob(null); setStatusUnknown(false); void refresh(); }, [target]);
    React.useEffect(() => {
      if (!working) return;
      let closed = false, timer; const abort = new AbortController();
      async function poll() {
        try {
          const value = await request('status', { jobId: job.jobId }, abort.signal);
          if (closed) return; setJob(value);
          if (['checking', 'installing'].includes(value.phase)) timer = setTimeout(poll, 1500);
        } catch (error) { if (!closed) { setStatusUnknown(true); setNotice('状态读取中断。安装不会自动重试；请刷新清单核对。' + error.message); } }
      }
      timer = setTimeout(poll, 1000);
      return () => { closed = true; clearTimeout(timer); abort.abort(); };
    }, [job?.jobId, working]);
    async function preview() {
      const current = generation.current; setBusy(true); setNotice(''); setJob(null); setStatusUnknown(false);
      try { const value = await request('plan', { target, packages: selected }); if (mounted.current && generation.current === current) setPlan(value); }
      catch (error) { if (mounted.current) setNotice(error.message); }
      finally { if (mounted.current) setBusy(false); }
    }
    async function execute() {
      if (!plan) return;
      if (!globalThis.crypto?.randomUUID) { setNotice('浏览器缺少安全请求标识能力，请通过 HTTPS 或本机 App 打开。'); return; }
      setBusy(true); setNotice('');
      try {
        const value = await request('execute', { planId: plan.planId, requestId: crypto.randomUUID(), confirm: true });
        if (mounted.current) { setStatusUnknown(false); setJob(value); setPlan(null); }
      } catch (error) { if (mounted.current) { setNotice(error.message + ' 请刷新目标清单核对后再生成计划。'); setPlan(null); } }
      finally { if (mounted.current) setBusy(false); }
    }
    if (!remotes.length) return null;
    const label = remotes.find(host => host.id === target)?.label || target;
    const sourceRows = (data?.source.bundles || []).filter(row => row.installed);
    const cell = { textAlign: 'left', padding: '7px 6px', borderBottom: border, verticalAlign: 'top', fontSize: 12 };
    const state = row => !row ? '未安装 · 关闭' : (row.installed ? row.version || '已安装' : 'DSH 内置') + ' · ' + (row.enabled ? '已启用' : '关闭');
    return h('details', { style: { border, borderRadius: 12, padding: 14, margin: '10px 0 18px', flexShrink: 0 }, 'data-plugin-sync-panel': true },
      h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '插件同步：Mac → 远端'),
      h('p', { style: { fontSize: 12, lineHeight: 1.7 } }, '选择 Mac 上的插件，先核对精确版本计划，再明确安装到远端。新安装包保持关闭；目标已有插件的启用状态和设置保持原值。'),
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        h('label', null, '目标主机 ', h('select', { value: target, disabled: busy || working, onChange: e => setTarget(e.target.value), style: { ...button, padding: 5 } },
          remotes.map(host => h('option', { key: host.id, value: host.id }, host.label || host.id)))),
        h('button', { type: 'button', style: button, disabled: busy || working, onClick: refresh }, busy ? '读取中…' : '刷新清单'),
        onOpenTarget && h('button', { type: 'button', style: button, onClick: () => onOpenTarget(target) }, '打开目标主机插件管理')),
      data && !data.destination.hotReload && h('p', { role: 'status', style: { fontSize: 12 } }, '目标未启用官方热重载，当前仅生成计划，安装需要维护窗口。'),
      data?.persistenceReady === false && h('p', { role: 'alert', style: { fontSize: 12 } }, '私有安装记录暂时不可用，当前只能查看计划；不会提交安装。'),
      h('div', { style: { overflowX: 'auto', marginTop: 10 } }, h('table', { style: { borderCollapse: 'collapse', width: '100%', minWidth: 450 } },
        h('thead', null, h('tr', null, ['选择', 'Mac 插件 / 版本', '目标安装 / 启用状态', '同步说明'].map(t => h('th', { key: t, style: cell }, t)))),
        h('tbody', null, sourceRows.map(row => {
          const to = data.destination.bundles.find(x => x.name === row.name);
          return h('tr', { key: row.name },
            h('td', { style: cell }, h('input', { type: 'checkbox', 'aria-label': '选择同步 ' + row.name,
              disabled: !row.eligible || busy || working, checked: selected.includes(row.name), onChange: e => {
                setPlan(null); setSelected(old => e.target.checked ? [...old, row.name] : old.filter(name => name !== row.name));
              } })),
            h('td', { style: cell }, h('div', { style: { overflowWrap: 'anywhere' } }, row.name), h('div', null, row.version, ' · ', row.enabled ? '已启用' : '关闭', row.active ? ' · 运行中' : '')),
            h('td', { style: cell }, state(to)),
            h('td', { style: cell }, row.reason || (to?.version === row.version ? '版本已相同，将保持目标状态。' : to?.installed ? '已有不同版本，需要独立维护。' : '可安装精确版本；安装后保持关闭。')));
        })))),
      h('p', { style: { fontSize: 12, opacity: 0.75, lineHeight: 1.6 } }, '同步仅处理插件包，不复制 API Key、账号、本机路径或源插件设置。不会重启服务、取消会话或自动批准依赖构建脚本。启用与配置请点击上方「打开目标主机插件管理」单独完成。'),
      h('button', { type: 'button', style: button, disabled: !selected.length || busy || working || !data, onClick: preview }, '查看 ' + selected.length + ' 项同步计划'),
      plan && h('section', { style: { marginTop: 14, padding: 12, border, borderRadius: 8 }, 'aria-label': '待确认的插件同步计划' },
        h('strong', null, '确认目标：', plan.targetLabel || label),
        h('ul', { style: { paddingLeft: 20, fontSize: 12, lineHeight: 1.8 } }, plan.rows.map(row => h('li', { key: row.name },
          row.name, '：', row.targetVersion || '未安装', ' → ', row.sourceVersion,
          '；启用：', row.targetEnabled ? '开启 → 开启' : '关闭 → 关闭', '；', row.reason))),
        plan.activeJob && h('p', { role: 'status', style: { fontSize: 12 } }, '此目标有进行中或待确认的安装，已锁定。请先刷新读取已有任务结果。'),
        h('button', { type: 'button', style: button, disabled: !plan.installs || !plan.hotReload || plan.persistenceReady === false || !!plan.activeJob || busy || working, onClick: execute },
          '确认将 ' + plan.installs + ' 个安装包同步到 ' + (plan.targetLabel || label) + '（保持关闭）')),
      job && h('section', { role: 'status', style: { fontSize: 12, lineHeight: 1.8, marginTop: 12 } },
        h('strong', null, statusUnknown ? '同步状态待核对' : job.phase === 'uncertain' ? '安装待确认，目标已锁定' : working ? '正在处理 ' + (job.current || job.targetLabel || label) : job.phase === 'complete' ? '同步处理完成' : '同步已停止'),
        h('div', null, job.message),
        job.results.map((row, i) => h('div', { key: row.name + i }, row.name, '：', row.verified ? '精确版本已安装，关闭' : '需要核对',
          ' · ', row.application, row.restartReason ? '（等待维护，本工具未重启）' : '', row.buildApprovalRequired ? ' · 依赖脚本需在官方插件页单独批准' : '', row.errorCode ? ' · ' + row.errorCode : ''))),
      notice && h('p', { role: 'alert', style: { fontSize: 12, lineHeight: 1.7 } }, notice));
  };
}

    function pickerModule(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region ../../../node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
		function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
		//#endregion
		//#region \0dsh-css:packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.module.css.mjs
		const css = ".PWYbQq_dialog.PWYbQq_dialog{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);gap:0;width:min(680px,100%);height:min(500px,100dvh - 32px);padding:0}.PWYbQq_editorScope{display:contents}.PWYbQq_header{border-bottom:.5px solid var(--dsw-alias-border-l3);flex-direction:column;flex:none;gap:8px;padding:16px 14px 8px 24px;display:flex}.PWYbQq_title{min-height:28px;color:var(--dsw-alias-label-primary);align-items:flex-end;margin:0;font-size:16px;font-weight:510;line-height:24px;display:flex}.PWYbQq_crumbBar{box-sizing:border-box;border-radius:var(--dsw-radius-sm);border:1px solid #0000;align-items:center;gap:4px;min-height:24px;margin-left:-9px;padding:0 8px;display:flex}.PWYbQq_crumbBar:has(.PWYbQq_crumbEditZone:enabled:hover),.PWYbQq_crumbBar:has(.PWYbQq_crumbEditZone:focus-visible),.PWYbQq_crumbBar:has(.PWYbQq_pathInput){border-color:var(--dsw-alias-border-l2)}.PWYbQq_millerRow{scrollbar-width:none;flex:1 1 0;align-items:stretch;gap:12px;min-height:0;display:flex;overflow-x:auto}.PWYbQq_crumbTrail{scrollbar-width:none;flex:0 auto;align-items:center;gap:4px;min-width:0;display:flex;overflow-x:auto}.PWYbQq_crumbSeat{flex:none;align-items:center;gap:4px;min-width:0;display:inline-flex}.PWYbQq_crumb{text-overflow:ellipsis;white-space:nowrap;max-width:160px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;padding:0;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.PWYbQq_crumb:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.PWYbQq_crumb:hover{color:var(--dsw-alias-label-primary)}.PWYbQq_crumbChevron{color:var(--dsw-alias-label-tertiary);flex:none}.PWYbQq_crumbEditZone{cursor:text;background:0 0;border:none;outline:none;flex:1 0 34px;justify-content:flex-end;align-items:center;min-width:34px;height:22px;padding:0;display:flex}.PWYbQq_crumbEditGlyph{color:var(--dsw-alias-label-tertiary);flex:none}.PWYbQq_crumbEditZone:enabled:hover .PWYbQq_crumbEditGlyph,.PWYbQq_crumbEditZone:focus-visible .PWYbQq_crumbEditGlyph{color:var(--dsw-alias-label-primary)}.PWYbQq_crumbEditZone:disabled{cursor:default}.PWYbQq_crumbEditZone:disabled .PWYbQq_crumbEditGlyph{color:var(--dsw-alias-label-caption)}.PWYbQq_pathInput{box-sizing:border-box;min-width:0;height:22px;color:var(--dsw-alias-label-primary);background:0 0;border:none;outline:none;flex:1 1 0;padding:0;font-size:13px;line-height:20px}.PWYbQq_content{flex-direction:column;flex:1 1 0;min-height:0;padding:16px 16px 16px 24px;display:flex;position:relative}.PWYbQq_column{flex-direction:column;flex:1 1 0;gap:2px;min-width:256px;padding-right:8px;display:flex;overflow-y:auto}.PWYbQq_divider{background:var(--dsw-alias-border-l3);flex:none;width:.5px}.PWYbQq_rowSeat{flex:none;display:flex}.PWYbQq_row{border-radius:var(--dsw-radius-sm);text-align:left;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:4px;width:100%;height:28px;padding:4px;display:flex}.PWYbQq_row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.PWYbQq_row:hover{background:var(--dsw-alias-interactive-bg-hover)}.PWYbQq_rowSelected,.PWYbQq_rowSelected:hover{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}.PWYbQq_rowIcon{color:var(--dsw-alias-label-secondary);flex:none}.PWYbQq_rowIconSelected{color:var(--dsw-alias-button-info-fill);flex:none}.PWYbQq_rowName{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-primary);flex:1 1 0;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.PWYbQq_rowChevron{color:var(--dsw-alias-label-tertiary);flex:none}.PWYbQq_status,.PWYbQq_error{padding:4px 120px 4px 4px;font-size:12px;line-height:18px}.PWYbQq_status{color:var(--dsw-alias-label-secondary)}.PWYbQq_error{color:var(--dsw-alias-state-error-primary)}.PWYbQq_loadingFloat{background:var(--dsw-alias-bg-layer-2);padding:2px 8px;position:absolute;bottom:8px;right:16px}.PWYbQq_footerBar{border-top:.5px solid var(--dsw-alias-border-l3);flex-wrap:wrap;flex:none;align-items:center;gap:8px;padding:16px 24px;display:flex}.PWYbQq_showHiddenToggle{color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;align-items:center;gap:4px;padding:0;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}.PWYbQq_showHiddenToggle:hover{color:var(--dsw-alias-label-primary)}.PWYbQq_showHiddenToggle:disabled{color:var(--dsw-alias-label-caption);cursor:default}.PWYbQq_showHiddenToggleActive{color:var(--dsw-alias-label-primary)}.PWYbQq_footerGap{flex:1 1 0}.PWYbQq_footerAction{min-width:72px}.PWYbQq_createDialog.PWYbQq_createDialog{gap:0;width:min(380px,100%);padding:0}.PWYbQq_createBody{flex-direction:column;gap:12px;padding:22px 24px 20px;display:flex}.PWYbQq_createTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:510;line-height:24px}.PWYbQq_createIn{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;line-height:22px}.PWYbQq_createInput{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);width:100%;height:44px;color:var(--dsw-alias-label-primary);background:0 0;outline:none;padding:7px 14px;font-size:14px;line-height:22px}.PWYbQq_createInput::placeholder{color:var(--dsw-alias-label-caption)}.PWYbQq_createActions{justify-content:flex-end;align-items:center;gap:8px;margin-top:8px;display:flex}";
		const tagId = "@zhitao-zeng/dsh-unified-directory-picker/DirectoryBrowser.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@zhitao-zeng/dsh-unified-directory-picker";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var DirectoryBrowser_module_css_default = {
			"column": "PWYbQq_column",
			"content": "PWYbQq_content",
			"createActions": "PWYbQq_createActions",
			"createBody": "PWYbQq_createBody",
			"createDialog": "PWYbQq_createDialog",
			"createIn": "PWYbQq_createIn",
			"createInput": "PWYbQq_createInput",
			"createTitle": "PWYbQq_createTitle",
			"crumb": "PWYbQq_crumb",
			"crumbBar": "PWYbQq_crumbBar",
			"crumbChevron": "PWYbQq_crumbChevron",
			"crumbEditGlyph": "PWYbQq_crumbEditGlyph",
			"crumbEditZone": "PWYbQq_crumbEditZone",
			"crumbSeat": "PWYbQq_crumbSeat",
			"crumbTrail": "PWYbQq_crumbTrail",
			"dialog": "PWYbQq_dialog",
			"divider": "PWYbQq_divider",
			"editorScope": "PWYbQq_editorScope",
			"error": "PWYbQq_error",
			"footerAction": "PWYbQq_footerAction",
			"footerBar": "PWYbQq_footerBar",
			"footerGap": "PWYbQq_footerGap",
			"header": "PWYbQq_header",
			"loadingFloat": "PWYbQq_loadingFloat",
			"millerRow": "PWYbQq_millerRow",
			"pathInput": "PWYbQq_pathInput",
			"row": "PWYbQq_row",
			"rowChevron": "PWYbQq_rowChevron",
			"rowIcon": "PWYbQq_rowIcon",
			"rowIconSelected": "PWYbQq_rowIconSelected",
			"rowName": "PWYbQq_rowName",
			"rowSeat": "PWYbQq_rowSeat",
			"rowSelected": "PWYbQq_rowSelected",
			"showHiddenToggle": "PWYbQq_showHiddenToggle",
			"showHiddenToggleActive": "PWYbQq_showHiddenToggleActive",
			"status": "PWYbQq_status",
			"title": "PWYbQq_title"
		};
		//#endregion
		//#region lib/types/client/DirectoryBrowser.js
		/**
		* The in-app workspace-directory browser (figma Harness 813-23126 family): a
		* 680×500 dialog (clamped to short/narrow viewports — the Miller row scrolls
		* sideways, the columns scroll down) whose header carries the title, the selection-path
		* breadcrumb, and a click-to-edit path zone; below it a Miller view — one
		* full-width level until a row is selected, then two columns splitting the
		* row evenly (256px floor; level | selected folder's children) around a
		* hairline divider. Navigations land selection-anchored and quiet: the
		* previous view keeps rendering while a crumb jump or a submitted path is
		* scanned, then target and parent legs land as one two-pane frame (a slow
		* parent leg falls back to landing the target alone and upgrading in
		* place), so stepping back keeps two panes away from the display root and
		* navigation never flashes an intermediate frame. Selecting in the
		* right column shifts the view one level deeper. "New folder" opens a nested
		* create dialog targeting the selected folder (or the level itself) and
		* selects the created folder. Open adopts the selected folder, falling back
		* to the listed level. Pure consumer of the injected browse calls — the
		* owning flow decides what "Open" means and owns the workspace-creation
		* error surface. Hidden entries are host-flagged and hidden by default; the
		* footer's fixed-label "Show hidden files" toggle (aria-pressed, check when
		* on) reveals them (client-side only). The path editor announces itself with
		* a pencil glyph and a bar-wide hover-lit outline, opens seeded with a
		* trailing separator, and keeps the panes under the draft: the final segment
		* prefix-filters the LAST pane while that pane's level is the one the draft's
		* directory part names (a dot-led prefix also reveals the hidden entries it
		* names, and a prefix nobody matches releases the filter), while any other
		* directory part is scanned after a short debounce and lands like any other
		* navigation — selection-anchored and two-pane away from the display root,
		* both legs waited out so one keystroke moves the view once. The pane arity
		* holds throughout: the last pane is the level the path names and the one
		* beside it is its parent, so typing deeper descends and erasing segments
		* walks back up, moving the Miller view without leaving the editor. Panes the
		* draft walked to stay put when the editor closes (cancellation included):
		* the crumbs name where the walk ended, and Open's fallback target follows
		* them.
		*/
		/** Failure text from the injected directory operation. */
		function failureText(error) {
			if (error !== null && typeof error === "object" && "rpcError" in error) {
				const rpcError = error.rpcError;
				if (rpcError !== null && typeof rpcError === "object" && "message" in rpcError && typeof rpcError.message === "string") return rpcError.message;
			}
			return error instanceof Error ? error.message : String(error);
		}
		/**
		* How long a scan may stay visually silent before the floating "Loading…"
		* pill appears. The stale view keeps rendering while a scan is in flight, so
		* a listing that settles inside this window swaps the panes with no
		* intermediate frame at all; only a genuinely slow host (a network mount, a
		* cold disk) surfaces the indicator.
		*/
		const SLOW_SCAN_DELAY_MS = 300;
		/**
		* How long a navigation landing waits for its parent leg before committing
		* the target alone. Inside the window both legs land as ONE two-pane frame —
		* no single-pane flash between them; past it the target commits single-pane
		* at once (an Enter-submitted navigation is never held hostage by a stalled
		* parent) and the late parent leg upgrades the landing in place.
		*/
		const PARENT_LEG_WAIT_MS = 200;
		/**
		* How long a typed draft rests before the panes follow it to a directory no
		* pane lists. The window absorbs the keystrokes that walk through
		* intermediate directory parts (every character of `/usr/lo` past the
		* separator would otherwise be its own scan) while staying short enough that
		* a pause reads as "the list moved with me".
		*/
		const DRAFT_PREVIEW_DEBOUNCE_MS = 250;
		/**
		* Breadcrumb rows for display: inside the home subtree the chain starts at a
		* localized Home crumb; outside it the full ancestry shows, the root labeled
		* by its own path.
		*/
		function displayCrumbs(listing, homeLabel) {
			const homeIndex = listing.crumbs.findIndex((crumb) => crumb.path === listing.home);
			if (homeIndex === -1) return listing.crumbs;
			const tail = listing.crumbs.slice(homeIndex + 1);
			return [{
				name: homeLabel,
				path: listing.home,
				hidden: false
			}, ...tail];
		}
		/**
		* The listing's platform separator, inferred from the home path the host
		* stamped — never from typed text or entry paths, where a backslash is a
		* legal POSIX name character. Still a heuristic at the last step: a POSIX
		* home directory whose own name contains a backslash would misread.
		* TODO: replace with a host-stamped `separator` field on the wire
		* DirectoryListing so the platform fact travels verbatim (the trade-off is
		* recorded in the directory-picker capability seam Agent Note).
		*/
		function separatorOf(listing) {
			return listing.home.includes("\\") ? "\\" : "/";
		}
		/** The listed level as a directory part: its own path, separator-terminated (the root already is). */
		function levelDirectory(listing) {
			const sep = separatorOf(listing);
			return listing.path.endsWith(sep) ? listing.path : `${listing.path}${sep}`;
		}
		/**
		* The draft's directory part — everything through its last separator — or
		* null while no separator has been typed at all (nothing addresses a
		* directory yet). The platform comes from `listing`: on Windows a forward
		* slash separates too (the host's `resolve` accepts either), while on POSIX a
		* backslash is a legal name character and never separates.
		*/
		function draftDirectory(listing, draft) {
			const cut = separatorOf(listing) === "\\" ? Math.max(draft.lastIndexOf("\\"), draft.lastIndexOf("/")) : draft.lastIndexOf("/");
			return cut === -1 ? null : draft.slice(0, cut + 1);
		}
		/**
		* How the draft reads against one level: the directory part it names, and —
		* when `listing` is the level that directory part addresses — the final
		* segment that prefix-filters it while the user types (case-insensitively,
		* downstream). A level answers a directory part when its own path is that
		* part, or when it is the level that very text just produced (`scanned`): the
		* host resolves what it is given, so `..` segments and Windows forward
		* slashes reach a level whose path spells the request differently.
		* @param listing - the level to read the draft against.
		* @param draft - the current path draft.
		* @param scanned - the last draft-following scan's directory and landing.
		* @returns the draft's directory part (null with no separator typed) and its
		* filtering tail (null when this level does not answer that directory).
		*/
		function readDraft(listing, draft, scanned) {
			const directory = draftDirectory(listing, draft);
			if (directory === null) return {
				directory: null,
				tail: null
			};
			return {
				directory,
				tail: directory === levelDirectory(listing) || scanned !== null && scanned.directory === directory && scanned.landed === listing.path ? draft.slice(directory.length) : null
			};
		}
		/**
		* The rows one column renders. The selection is exempt from every filter: it
		* anchors the two-pane view (crumbs and the child pane point at it), so
		* neither the hidden filter after a dot-reveal pick nor a prefix miss may
		* orphan it. A prefix narrows the level only while some row it would actually
		* show matches — a tail nobody matches is a name being spelled, not a demand
		* for an empty pane, so the level shows whole and its hidden rows return to
		* obeying the toggle. Counting only displayable rows keeps that true because
		* every hidden name is dot-prefixed, and a matching prefix therefore reveals
		* it; otherwise the level could narrow to nothing.
		*/
		function visibleEntries(entries, selectedPath, showHidden, filterPrefix) {
			const needle = filterPrefix === null ? "" : filterPrefix.toLowerCase();
			const displayable = (entry) => showHidden || !entry.hidden || needle.startsWith(".");
			const matches = (entry) => displayable(entry) && entry.name.toLowerCase().startsWith(needle);
			const narrowing = needle !== "" && entries.some(matches);
			return entries.filter((entry) => {
				if (entry.path === selectedPath) return true;
				if (narrowing) return matches(entry);
				return showHidden || !entry.hidden;
			});
		}
		/** One column of folder rows (the Miller view renders one or two of these). */
		function LevelColumn({ entries, selectedPath, busy, onPick, showHidden, filterPrefix, pathEditing }) {
			const visible = visibleEntries(entries, selectedPath, showHidden, filterPrefix);
			return (0, react_jsx_runtime.jsx)("div", {
				className: DirectoryBrowser_module_css_default.column,
				role: "list",
				children: visible.map((entry) => {
					const selected = entry.path === selectedPath;
					return (0, react_jsx_runtime.jsx)("span", {
						role: "listitem",
						className: DirectoryBrowser_module_css_default.rowSeat,
						children: (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							"aria-current": selected || void 0,
							className: clsx(DirectoryBrowser_module_css_default.row, selected && DirectoryBrowser_module_css_default.rowSelected),
							disabled: busy,
							onMouseDown: pathEditing ? (event) => {
								event.preventDefault();
							} : void 0,
							onClick: () => {
								onPick(entry);
							},
							children: [
								selected ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenRegular, {
									size: 16,
									className: DirectoryBrowser_module_css_default.rowIconSelected
								}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderCloseRegular, {
									size: 16,
									className: DirectoryBrowser_module_css_default.rowIcon
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: DirectoryBrowser_module_css_default.rowName,
									children: entry.name
								}),
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutlineRegular, {
									size: 12,
									className: DirectoryBrowser_module_css_default.rowChevron
								})
							]
						})
					}, entry.path);
				})
			});
		}
		/**
		* Render the directory-browser dialog.
		* @param props - owner-controlled browser props.
		* @returns the dialog element (null while closed, via Modal).
		*/
		function DirectoryBrowser({ open, listDirectory, createDirectory, onOpen, onClose, busy, t }) {
			const [parent, setParent] = (0, react.useState)(null);
			const [selected, setSelected] = (0, react.useState)(null);
			const [child, setChild] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const [slowScan, setSlowScan] = (0, react.useState)(false);
			const [scanWindow, setScanWindow] = (0, react.useState)(0);
			const [error, setError] = (0, react.useState)(null);
			const [pathDraft, setPathDraft] = (0, react.useState)(null);
			const [showHidden, setShowHidden] = (0, react.useState)(false);
			const [folderDraft, setFolderDraft] = (0, react.useState)(null);
			const [creatingFolder, setCreatingFolder] = (0, react.useState)(false);
			const [createError, setCreateError] = (0, react.useState)(null);
			const requestSeq = (0, react.useRef)(0);
			const scanController = (0, react.useRef)(null);
			const openGeneration = (0, react.useRef)(0);
			const crumbTrailRef = (0, react.useRef)(null);
			const composingRef = (0, react.useRef)(false);
			(0, react.useEffect)(() => () => {
				requestSeq.current += 1;
				openGeneration.current += 1;
				scanController.current?.abort();
			}, []);
			const compositionGuard = {
				onCompositionStart: () => {
					composingRef.current = true;
				},
				onCompositionEnd: () => {
					composingRef.current = false;
				}
			};
			/** Newer intent wins: invalidate the pending listing's settlement AND abort its wire request. */
			const supersede = (0, react.useCallback)(() => {
				scanController.current?.abort();
				scanController.current = null;
				return ++requestSeq.current;
			}, []);
			/** Hide any prior indicator and start a fresh silence window for one listing call. */
			const restartSlowScanWindow = (0, react.useCallback)(() => {
				setSlowScan(false);
				setScanWindow((value) => value + 1);
			}, []);
			/** Launch one listing under a fresh controller so a later supersession can abort it. */
			const launchListing = (0, react.useCallback)((path) => {
				const seq = supersede();
				const controller = new AbortController();
				scanController.current = controller;
				restartSlowScanWindow();
				return {
					seq,
					scan: listDirectory(path, controller.signal)
				};
			}, [
				supersede,
				restartSlowScanWindow,
				listDirectory
			]);
			/**
			* Launch a follow-up listing under the CURRENT supersession seq: a newer
			* intent aborts it like the leg it continues, and it supersedes nothing.
			*/
			const continueScan = (0, react.useCallback)((path) => {
				const controller = new AbortController();
				scanController.current = controller;
				restartSlowScanWindow();
				return listDirectory(path, controller.signal);
			}, [restartSlowScanWindow, listDirectory]);
			/**
			* Enter owns the view from submission until its navigation lands, so the
			* debounce timer the same keystrokes armed must not supersede it. Cleared
			* by the next edit (and by opening the editor); a failed submission leaves
			* it set until the operator edits again, so the rejected path is not
			* immediately re-scanned as a preview.
			*/
			const previewSuspended = (0, react.useRef)(false);
			const viewRef = (0, react.useRef)({
				parent: null,
				child: null
			});
			(0, react.useEffect)(() => {
				viewRef.current = {
					parent,
					child
				};
			}, [parent, child]);
			const scanned = (0, react.useRef)(null);
			/**
			* A landed preview replaced the pane a keyboard operator may have Tabbed
			* onto, so the focus it drops is re-parked on the still-open editor (the
			* Modal has no focus trap). Consumed by the refocus effect below.
			*/
			const refocusPathInput = (0, react.useRef)(false);
			/**
			* Replace the whole view with a freshly scanned level. Away from the
			* display root — the same collapse the crumb header renders, so crumbs and
			* pane shape never disagree — the landing is two-pane: the target's ACTUAL
			* parent-level entry re-selected (left pane = parent, right pane = the
			* target), so a crumb jump reads as stepping back one pane. Both legs land
			* as one frame when the parent leg settles within
			* {@link PARENT_LEG_WAIT_MS}; past that bound (or at the display root) the
			* target commits alone — single wide level, loading ends — and a late
			* parent leg still upgrades the landing in place. A failed parent leg, or a
			* truncated parent window that lacks the target, leaves the single-pane
			* landing — the upgrade must never orphan the selection it exists to
			* anchor. Until whichever commit comes first, the previous view keeps
			* rendering: a landing swaps the panes, it never blanks them.
			*
			* Two callers, one landing shape. A submitted path (Enter, a crumb) closes
			* the editor on arrival, announces its failure, and takes the wait bound —
			* it is answering a gesture, so it may not hang on a stalled parent. The
			* editor's own draft-following scan keeps all three to itself: it is
			* speculative, nothing waits on it, and the stale view keeps rendering, so
			* it waits for BOTH legs rather than flashing a single pane it would then
			* upgrade — one keystroke must move the view once. A failure leaves the
			* last readable panes standing and says nothing, while an arrival clears
			* the stale message and re-parks focus the swap dropped.
			* @param path - the level to list; absent lists the Host home directory.
			* @param options - `closeEditor` retires the path draft on arrival and
			* bounds the wait for the parent leg; `announce` surfaces a failure as the
			* dialog's alert.
			*/
			const land = (0, react.useCallback)((path, options) => {
				const { seq, scan } = launchListing(path);
				setLoading(true);
				if (options.announce) setError(null);
				const settle = () => {
					setLoading(false);
					if (options.closeEditor) {
						setPathDraft(null);
						return;
					}
					setError(null);
					refocusPathInput.current = true;
				};
				scan.then((target) => {
					if (seq !== requestSeq.current) return;
					if (!options.closeEditor && path !== void 0) scanned.current = {
						directory: path,
						landed: target.path
					};
					let landed = false;
					const landSingle = () => {
						if (landed || seq !== requestSeq.current) return;
						landed = true;
						setParent(target);
						setSelected(null);
						setChild(null);
						settle();
					};
					if (displayCrumbs(target, "").length < 2) {
						landSingle();
						return;
					}
					const parentCrumb = target.crumbs.at(-2);
					/* v8 ignore next -- narrowing: a two-deep display chain implies a parent crumb (root-to-target inclusive). */
					if (parentCrumb === void 0) {
						landSingle();
						return;
					}
					continueScan(parentCrumb.path).then((parentLevel) => {
						if (seq !== requestSeq.current) return;
						const sep = separatorOf(parentLevel);
						const fold = (value) => sep === "\\" ? value.toLowerCase() : value;
						const match = parentLevel.entries.find((entry) => fold(entry.path) === fold(target.path));
						if (match === void 0) {
							landSingle();
							return;
						}
						landed = true;
						setParent(parentLevel);
						setSelected(match);
						setChild(target);
						settle();
					}, () => {
						landSingle();
					});
					if (options.closeEditor) window.setTimeout(landSingle, PARENT_LEG_WAIT_MS);
				}, (reason) => {
					if (seq !== requestSeq.current) return;
					setLoading(false);
					if (options.announce) setError(failureText(reason));
				});
			}, [launchListing, continueScan]);
			/** Commit a submitted path (Enter, a crumb, the initial home listing): the editor closes, failures surface. */
			const navigate = (0, react.useCallback)((path) => {
				land(path, {
					closeEditor: true,
					announce: true
				});
			}, [land]);
			const refocusPick = (0, react.useRef)(false);
			const refocusEditZone = (0, react.useRef)(false);
			const pathInputRef = (0, react.useRef)(null);
			const editZoneRef = (0, react.useRef)(null);
			/**
			* Select a row of the listed level and preview its children on the right.
			* Deliberately NOT one-frame like navigate(): a pick's first duty is the
			* immediate selected state on the clicked row, and the pane split IS that
			* feedback (aria-current pill, crumbs following the selection) — holding
			* it back for the child listing would make clicks feel dropped. The quiet
			* rule governs whole-view replacement, where nothing acknowledges the
			* click but the swap itself.
			*/
			const select = (0, react.useCallback)((entry) => {
				const { seq, scan } = launchListing(entry.path);
				if (pathDraft !== null) refocusPick.current = true;
				setPathDraft(null);
				setSelected(entry);
				setChild(null);
				setLoading(true);
				setError(null);
				scan.then((next) => {
					if (seq !== requestSeq.current) return;
					setChild(next);
					setLoading(false);
				}, (reason) => {
					if (seq !== requestSeq.current) return;
					setLoading(false);
					setError(failureText(reason));
					setSelected(null);
					refocusEditZone.current = true;
				});
			}, [launchListing, pathDraft]);
			/**
			* Walk the panes to the directory the draft addresses, WITHOUT closing the
			* editor. The landing is an ordinary one — selection-anchored and two-pane
			* away from the display root — so typing a path moves the Miller view
			* exactly as a crumb jump does, and the draft's final segment
			* prefix-filters the arrival from the next render on.
			*/
			const previewDraftLevel = (0, react.useCallback)((directory) => {
				land(directory, {
					closeEditor: false,
					announce: false
				});
			}, [land]);
			/** Abandon path editing (Escape or clicking away) and restore the crumb view. */
			const cancelPathEdit = (0, react.useCallback)(() => {
				supersede();
				setLoading(false);
				setPathDraft(null);
				setError(null);
				if (child === null) setSelected(null);
				if (parent === null) navigate();
			}, [
				supersede,
				child,
				parent,
				navigate
			]);
			/** A right-column pick advances the view one level: child becomes the level. */
			const advance = (0, react.useCallback)((entry) => {
				/* v8 ignore next -- narrowing guard: the right column only renders with a child listing. */
				if (child === null) return;
				setParent(child);
				select(entry);
			}, [child, select]);
			(0, react.useEffect)(() => {
				openGeneration.current += 1;
				if (open) {
					setParent(null);
					setSelected(null);
					setChild(null);
					setCreatingFolder(false);
					setShowHidden(false);
					navigate();
					return;
				}
				supersede();
				setLoading(false);
				setError(null);
				setPathDraft(null);
				setFolderDraft(null);
				setCreateError(null);
				refocusPick.current = false;
				refocusEditZone.current = false;
			}, [
				open,
				navigate,
				supersede
			]);
			/** The folder a create or Open acts on: the selection, else the listed level. */
			const targetPath = selected?.path ?? parent?.path ?? null;
			const targetName = selected?.name ?? (parent === null ? "" : displayCrumbs(parent, t("browser.home")).at(-1)?.name ?? parent.path);
			const confirmCreate = () => {
				/* v8 ignore next -- reentry fence: the nested dialog only renders with a target and disables while creating. */
				if (targetPath === null || folderDraft === null || creatingFolder) return;
				const name = folderDraft;
				if (name.trim() === "") return;
				setCreatingFolder(true);
				setCreateError(null);
				const generation = openGeneration.current;
				createDirectory(targetPath, name).then((createdPath) => {
					if (generation !== openGeneration.current) return;
					setCreatingFolder(false);
					setFolderDraft(null);
					const { seq, scan } = launchListing(targetPath);
					setLoading(true);
					setError(null);
					scan.then((level) => {
						/* v8 ignore next -- same fence as navigate/select; the modal blocks superseding input */
						if (seq !== requestSeq.current) return;
						setParent(level);
						setLoading(false);
						select({
							name,
							path: createdPath,
							hidden: false
						});
					}, (reason) => {
						/* v8 ignore next -- same fence as navigate/select; the modal blocks superseding input */
						if (seq !== requestSeq.current) return;
						setLoading(false);
						setError(failureText(reason));
					});
				}, (reason) => {
					if (generation !== openGeneration.current) return;
					setCreatingFolder(false);
					setCreateError(failureText(reason));
				});
			};
			(0, react.useEffect)(() => {
				if (!loading) {
					setSlowScan(false);
					return;
				}
				const timer = window.setTimeout(() => {
					setSlowScan(true);
				}, SLOW_SCAN_DELAY_MS);
				return () => {
					window.clearTimeout(timer);
				};
			}, [loading, scanWindow]);
			(0, react.useEffect)(() => {
				if (pathDraft === null) return;
				const timer = window.setTimeout(() => {
					if (previewSuspended.current) return;
					const current = viewRef.current.child ?? viewRef.current.parent;
					if (current === null) return;
					const { directory, tail } = readDraft(current, pathDraft, scanned.current);
					if (directory === null || tail !== null) return;
					previewDraftLevel(directory);
				}, DRAFT_PREVIEW_DEBOUNCE_MS);
				return () => {
					window.clearTimeout(timer);
				};
			}, [pathDraft, previewDraftLevel]);
			const crumbSource = child ?? parent;
			const typedPrefix = crumbSource === null || pathDraft === null ? null : readDraft(crumbSource, pathDraft, scanned.current).tail;
			const crumbs = crumbSource === null ? [] : displayCrumbs(crumbSource, t("browser.home"));
			const crumbTail = crumbs.at(-1)?.path;
			(0, react.useEffect)(() => {
				const trail = crumbTrailRef.current;
				if (trail !== null) trail.scrollLeft = trail.scrollWidth;
			}, [crumbTail]);
			const millerRowRef = (0, react.useRef)(null);
			const childPath = child?.path;
			(0, react.useEffect)(() => {
				const row = millerRowRef.current;
				if (row !== null && childPath !== void 0) row.scrollLeft = row.scrollWidth;
			}, [childPath]);
			(0, react.useEffect)(() => {
				if (refocusPathInput.current) {
					refocusPathInput.current = false;
					if (document.activeElement === document.body) pathInputRef.current?.focus();
				}
				if (pathDraft !== null) return;
				if (refocusPick.current) {
					refocusPick.current = false;
					refocusEditZone.current = false;
					const rowHost = millerRowRef.current;
					/* v8 ignore next -- narrowing guard: the miller row is mounted whenever a pick just committed. */
					if (rowHost === null) return;
					const row = rowHost.querySelector("button[aria-current=\"true\"]");
					/* v8 ignore next -- narrowing guard: the pick that set the flag just rendered its aria-current row. */
					if (row === null) return;
					row.focus();
					return;
				}
				if (refocusEditZone.current) {
					refocusEditZone.current = false;
					if (document.activeElement !== document.body) return;
					const zone = editZoneRef.current;
					/* v8 ignore next -- narrowing guard: crumb mode renders the edit zone whenever the editor just closed. */
					if (zone === null) return;
					zone.focus();
				}
			});
			if (!open) return null;
			const twoPane = selected !== null;
			const parentInert = busy || folderDraft !== null;
			const draftPending = pathDraft !== null;
			return (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose: () => {
					if (folderDraft === null && !busy) onClose();
				},
				title: t("browser.title"),
				className: clsx(DirectoryBrowser_module_css_default.dialog),
				headless: true,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: DirectoryBrowser_module_css_default.editorScope,
					onKeyDown: (event) => {
						if (event.key !== "Escape" || pathDraft === null) return;
						event.stopPropagation();
						refocusEditZone.current = document.activeElement === pathInputRef.current;
						cancelPathEdit();
					},
					onBlur: (event) => {
						if (pathDraft === null) return;
						if (!document.hasFocus()) return;
						const card = event.currentTarget.closest("[role=\"dialog\"]");
						/* v8 ignore next -- narrowing guard: this scope always renders inside the Modal card. */
						if (card === null) return;
						if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
						refocusEditZone.current = false;
						cancelPathEdit();
					},
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: DirectoryBrowser_module_css_default.header,
							children: [(0, react_jsx_runtime.jsx)("h2", {
								className: DirectoryBrowser_module_css_default.title,
								children: t("browser.title")
							}), (0, react_jsx_runtime.jsx)("div", {
								className: DirectoryBrowser_module_css_default.crumbBar,
								children: pathDraft === null ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
									className: DirectoryBrowser_module_css_default.crumbTrail,
									role: "navigation",
									ref: crumbTrailRef,
									children: crumbs.map((crumb, index) => (0, react_jsx_runtime.jsxs)("span", {
										className: DirectoryBrowser_module_css_default.crumbSeat,
										children: [index > 0 && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutlineRegular, {
											size: 12,
											className: DirectoryBrowser_module_css_default.crumbChevron
										}), (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: DirectoryBrowser_module_css_default.crumb,
											disabled: parentInert,
											onClick: () => {
												navigate(crumb.path);
											},
											children: crumb.name
										})]
									}, crumb.path))
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: DirectoryBrowser_module_css_default.crumbEditZone,
									"aria-label": t("browser.editPath"),
									title: t("browser.editPath"),
									disabled: parentInert,
									ref: editZoneRef,
									onClick: () => {
										supersede();
										setLoading(false);
										previewSuspended.current = false;
										if (parent === null) {
											setPathDraft("");
											return;
										}
										const base = selected?.path ?? parent.path;
										const sep = separatorOf(parent);
										setPathDraft(base.endsWith(sep) ? base : `${base}${sep}`);
									},
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutlineRegular, {
										size: 14,
										className: DirectoryBrowser_module_css_default.crumbEditGlyph
									})
								})] }) : (0, react_jsx_runtime.jsx)("input", {
									className: DirectoryBrowser_module_css_default.pathInput,
									value: pathDraft,
									"aria-label": t("browser.editPath"),
									autoFocus: true,
									ref: pathInputRef,
									disabled: parentInert,
									onChange: (event) => {
										supersede();
										setLoading(false);
										previewSuspended.current = false;
										setPathDraft(event.target.value);
									},
									...compositionGuard,
									onKeyDown: (event) => {
										if (event.key === "Enter" && !composingRef.current) {
											event.preventDefault();
											if (pathDraft.trim() !== "") {
												refocusEditZone.current = true;
												previewSuspended.current = true;
												navigate(pathDraft);
											}
										}
									}
								})
							})]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: DirectoryBrowser_module_css_default.content,
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: DirectoryBrowser_module_css_default.millerRow,
									ref: millerRowRef,
									children: [
										parent !== null && (0, react_jsx_runtime.jsx)(LevelColumn, {
											entries: parent.entries,
											selectedPath: selected?.path ?? null,
											busy: parentInert,
											onPick: select,
											showHidden,
											filterPrefix: child === null ? typedPrefix : null,
											pathEditing: draftPending
										}),
										twoPane && (0, react_jsx_runtime.jsx)("span", { className: DirectoryBrowser_module_css_default.divider }),
										twoPane && child !== null && (0, react_jsx_runtime.jsx)(LevelColumn, {
											entries: child.entries,
											selectedPath: null,
											busy: parentInert,
											onPick: advance,
											showHidden,
											filterPrefix: typedPrefix,
											pathEditing: draftPending
										})
									]
								}),
								loading && slowScan && (0, react_jsx_runtime.jsx)("div", {
									className: clsx(DirectoryBrowser_module_css_default.status, DirectoryBrowser_module_css_default.loadingFloat),
									role: "status",
									children: t("browser.loading")
								}),
								(parent?.truncated === true || child?.truncated === true) && (0, react_jsx_runtime.jsx)("div", {
									className: DirectoryBrowser_module_css_default.status,
									role: "status",
									children: t("browser.truncated")
								}),
								error !== null && (0, react_jsx_runtime.jsx)("div", {
									className: DirectoryBrowser_module_css_default.error,
									role: "alert",
									children: error
								})
							]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: DirectoryBrowser_module_css_default.footerBar,
							children: [
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 14 }),
									disabled: parent === null || loading || parentInert || draftPending,
									onClick: () => {
										setFolderDraft("");
										setCreateError(null);
									},
									children: t("browser.newFolder")
								}),
								(0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: clsx(DirectoryBrowser_module_css_default.showHiddenToggle, showHidden && DirectoryBrowser_module_css_default.showHiddenToggleActive),
									"aria-pressed": showHidden,
									disabled: parentInert,
									onMouseDown: draftPending ? (event) => {
										event.preventDefault();
									} : void 0,
									onClick: () => {
										setShowHidden((prev) => !prev);
									},
									children: [t("browser.showHidden"), showHidden && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutlineRegular, { size: 14 })]
								}),
								(0, react_jsx_runtime.jsx)("span", { className: DirectoryBrowser_module_css_default.footerGap }),
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									className: clsx(DirectoryBrowser_module_css_default.footerAction),
									disabled: parentInert,
									onClick: onClose,
									children: t("browser.cancel")
								}),
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									className: clsx(DirectoryBrowser_module_css_default.footerAction),
									disabled: targetPath === null || loading || parentInert || draftPending,
									/* v8 ignore next -- narrowing guard: Open disables while no target exists. */
									onClick: () => {
										if (targetPath !== null) onOpen(targetPath);
									},
									children: t("browser.open")
								})
							]
						})
					]
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
					open: folderDraft !== null,
					onClose: () => {
						if (!creatingFolder) setFolderDraft(null);
					},
					title: t("browser.newFolder"),
					className: clsx(DirectoryBrowser_module_css_default.createDialog),
					headless: true,
					children: (0, react_jsx_runtime.jsxs)("div", {
						className: DirectoryBrowser_module_css_default.createBody,
						children: [
							(0, react_jsx_runtime.jsx)("h3", {
								className: DirectoryBrowser_module_css_default.createTitle,
								children: t("browser.newFolder")
							}),
							(0, react_jsx_runtime.jsx)("p", {
								className: DirectoryBrowser_module_css_default.createIn,
								children: t("browser.createIn", { name: targetName })
							}),
							(0, react_jsx_runtime.jsx)("input", {
								className: DirectoryBrowser_module_css_default.createInput,
								value: folderDraft ?? "",
								"aria-label": t("browser.folderName"),
								placeholder: t("browser.untitledFolder"),
								"data-modal-autofocus": true,
								disabled: creatingFolder,
								onChange: (event) => {
									setFolderDraft(event.target.value);
								},
								...compositionGuard,
								onKeyDown: (event) => {
									if (event.key === "Enter" && !composingRef.current) {
										event.preventDefault();
										confirmCreate();
									}
									if (event.key === "Escape") {
										event.stopPropagation();
										if (!creatingFolder) setFolderDraft(null);
									}
								}
							}),
							createError !== null && (0, react_jsx_runtime.jsx)("div", {
								className: DirectoryBrowser_module_css_default.error,
								role: "alert",
								children: createError
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: DirectoryBrowser_module_css_default.createActions,
								children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									disabled: creatingFolder,
									onClick: () => {
										setFolderDraft(null);
									},
									children: t("browser.cancel")
								}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									disabled: creatingFolder || folderDraft === null || folderDraft.trim() === "",
									onClick: confirmCreate,
									children: t("browser.create")
								})]
							})
						]
					})
				})]
			});
		}
		//#endregion
		//#region lib/types/client/flow.js
		/**
		* The browse picking occupant (package-internal; the `./client` surface
		* exposes only the Loader exports). Same-package tests exercise it directly
		* through this module.
		*/
		/**
		* Flow occupant: adapts the hole's owner conversation onto the browser
		* dialog — a confirmed directory is the picked path, dismissal is the
		* cancellation. Browse failures (unreadable targets, create conflicts) stay
		* inside the dialog's own alert surfaces, so the owner's `onError` arm is
		* never driven by this occupant.
		* @param props - owner conversation plus the injected browse face.
		* @returns the dialog element (renders nothing while closed).
		*/
		function BrowseDirectoryFlow(props) {
			return (0, react.createElement)(DirectoryBrowser, {
				open: props.open,
				busy: props.busy,
				listDirectory: props.listDirectory,
				createDirectory: props.createDirectory,
				t: props.t,
				onOpen: props.onPicked,
				onClose: props.onCancel
			});
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Locale namespace owning the browser dialog's copy. */
		const LOCALE_NS = "dsh-unified-directory-browser";
		/** Required services (cordis fiber inject): the slot registry, workspace UI service, and locale. */
		const inject = [
			"slots",
			"uiWorkspace",
			"locale"
		];
		/**
		* Client plugin body: register the dialog's dictionaries and the browse flow
		* into both directory-flow holes through `slots.inject()` because the
		* ui-workspace entries may activate later or replace their declarations.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => {
				const disposers = [];
				const dictionaries = [["zh", {
					"browser.title": "选择 远端 工作区目录",
					"browser.home": "主目录",
					"browser.newFolder": "新建文件夹",
					"browser.folderName": "文件夹名称",
					"browser.createIn": "在\"{name}\"中新建文件夹",
					"browser.untitledFolder": "未命名文件夹",
					"browser.create": "创建",
					"browser.cancel": "取消",
					"browser.open": "打开",
					"browser.editPath": "编辑路径",
					"browser.loading": "加载中…",
					"browser.truncated": "文件夹过多，仅显示开头部分。",
					"browser.showHidden": "显示隐藏文件"
				}], ["en", {
					"browser.title": "Select Workspace Directory",
					"browser.home": "Home",
					"browser.newFolder": "New folder",
					"browser.folderName": "Folder name",
					"browser.createIn": "New folder in \"{name}\"",
					"browser.untitledFolder": "Untitled folder",
					"browser.create": "Create",
					"browser.cancel": "Cancel",
					"browser.open": "Open",
					"browser.editPath": "Edit path",
					"browser.loading": "Loading…",
					"browser.truncated": "Too many folders to list; only the beginning is shown.",
					"browser.showHidden": "Show hidden files"
				}]];
				try {
					for (const [locale, dict] of dictionaries) disposers.push(ctx.locale.register(LOCALE_NS, locale, dict));
				} catch (error) {
					for (const dispose of disposers.reverse()) dispose();
					throw error;
				}
				return () => {
					for (const dispose of disposers) dispose();
				};
			}, "directory-picker-browse: dialog dictionaries");
			const injected = () => ({
				listDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal),
				createDirectory: (path, name) => ctx.uiWorkspace.createDirectory(path, name),
				t: ctx.locale.bind(LOCALE_NS)
			});
			ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
				yield ctx.slots.register({
					name: "conversation.hero.workspace.directoryFlow",
					inject: injected, priority: -100
				}, BrowseDirectoryFlow);
				yield ctx.slots.register({
					name: "sidebar.workspaces.directoryFlow",
					inject: injected, priority: -100
				}, BrowseDirectoryFlow);
			}));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
    }
    return {
      inject: ['connection'],
      apply(ctx) {
        const persistentMode = globalThis.__DSH_UNIFIED_PERSISTENT_LOCAL__ === true;
        let selected = 'mac';
        try { const saved = sessionStorage.getItem(HOST_KEY); if (validHostId(saved)) selected = saved; } catch {}
        if (persistentMode) selected = 'mac';
        const gpu = selected !== 'mac';
        if (gpu && globalThis.__DSH_UNIFIED_REMOTE_BOOT__?.beforeClientContext !== true) {
          throw new Error('远端的原生连接未在工作区启动前就绪，已停止加载。');
        }
        ctx.inject(['slots', 'layout', 'uiWorkspace', 'locale'], ui => {
          const React = require('react');
          const h = React.createElement;
          const panel = 'dsh-unified-host';
          const selectionKey = 'dsh-unified-selection-by-host';
          const pendingKey = 'dsh-unified-pending-selection';
          const createdKey = 'dsh-unified-created-sessions';
          const sidebarExpansionKey = 'dsh-unified-sidebar-open-workspaces';
          if (gpu) ui.plugin(pickerModule(require));
          const requestFetch = window.fetch.bind(window);
          const PluginSyncPanel = createPluginSyncPanel({ React, h, requestFetch, requestAccess });
          const listeners = new Set();
          const persistentBridges = new Map();
          let snapshot = { phase: 'loading', hosts: [], error: '', dialog: null, managerNotice: '', recentCreated: null, operationBusy: false, activeTarget: 'mac', remotes: Object.create(null) };
          let created = Object.create(null);
          const confirmedCreated = new Map();
          const uncertainCreates = new Map();
          const uncertainKey = 'dsh-unified-uncertain-session-creates';
          const creationKey = dialog => dialog.host + ':' + dialog.workspaceId;
          try {
            const saved = JSON.parse(sessionStorage.getItem(uncertainKey) || '[]');
            if (Array.isArray(saved)) for (const dialog of saved.slice(-128)) {
              if (dialog?.kind === 'session' && validHostId(dialog.host)
                  && typeof dialog.workspaceId === 'string' && dialog.workspaceId.length > 0 && dialog.workspaceId.length <= 512
                  && typeof dialog.requestId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(dialog.requestId)
                  && typeof dialog.path === 'string' && typeof dialog.label === 'string') uncertainCreates.set(creationKey(dialog), { ...dialog, uncertain: true });
            }
          } catch {}
          function saveUncertainCreates() {
            try { sessionStorage.setItem(uncertainKey, JSON.stringify([...uncertainCreates.values()])); return true; } catch { return false; }
          }
          try {
            const saved = JSON.parse(sessionStorage.getItem(createdKey) || '{}');
            for (const host of Object.keys(saved)) {
              if (!validHostId(host)) continue;
              created[host] = Object.create(null);
              for (const [id, value] of Object.entries(saved[host] || {}).slice(-128)) if (value === true && id && id.length <= 512) created[host][id] = true;
            }
          } catch {}
          function bridgeFor(hostId) {
            if (!validHostId(hostId, false) || !snapshot.hosts.some(host => host.id === hostId)) throw new Error('未配置此远端主机。');
            let bridge = persistentBridges.get(hostId);
            if (!bridge) {
              bridge = createPersistentEmbed({ hostId, fetch: requestFetch, changed: value => {
                if (disposed) return;
                const old = snapshot.remotes[hostId] || {};
                const next = { ...old, ...('metadata' in value ? { embed: value.metadata || null } : {}), ...('ready' in value ? { ready: value.ready === true } : {}), ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}), ...('notice' in value ? { notice: value.notice || '' } : {}) };
                emit({ ...snapshot, remotes: { ...snapshot.remotes, [hostId]: next } });
              } });
              persistentBridges.set(hostId, bridge);
            }
            return bridge;
          }
          let writeBusy = false;
          let browseGeneration = 0;
          const managementRequests = new Set();
          let sidebarExpanded = new Set();
          try {
            const values = JSON.parse(sessionStorage.getItem(sidebarExpansionKey) || '[]');
            if (Array.isArray(values)) sidebarExpanded = new Set(values.filter(value => typeof value === 'string' && value.length <= 1024 && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}:/.test(value)).slice(-128));
          } catch {}
          let currentSessionId;
          let catalogReadAt = 0;
          let disposed = false;
          let inFlight;
          let requestAbort;
          let disposeUnified;
          function enableUnified() {
            if (!disposeUnified) disposeUnified = ui.slots.register({ name: 'sidebar.workspaces', priority: -100 }, UnifiedTree);
          }
          function manageCurrent() {
            disposeUnified?.();
            disposeUnified = undefined;
            ui.layout.selectPanel(null);
          }
          function emit(next) {
            snapshot = next;
            saveCurrentSelection();
            for (const listener of listeners) listener();
          }
          function saveCurrentSelection() {
            const value = ui.uiWorkspace.selection?.getSnapshot?.();
            const ownHost = snapshot.hosts.find(host => host.id === selected);
            if (!value || typeof value.sessionId !== 'string' || !ownHost?.items.some(item => item.sessionId === value.sessionId)) return;
            currentSessionId = value.sessionId;
            try {
              const raw = sessionStorage.getItem(selectionKey);
              let byHost = raw ? JSON.parse(raw) : {};
              if (!byHost || typeof byHost !== 'object' || Array.isArray(byHost)) byHost = {};
              sessionStorage.setItem(selectionKey, JSON.stringify({ ...byHost, [selected]: value }));
            } catch {}
          }
          function requestAccess() {
            let device;
            try { device = sessionStorage.getItem('dsh-remote-device'); } catch {}
            const phone = typeof device === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(device);
            return { prefix: phone ? '/remote' : '', headers: phone ? { 'x-dsh-remote-device': device } : {} };
          }
          function newRequestId() {
            if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
            if (globalThis.crypto?.getRandomValues) return [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
            throw new Error('无法准备创建请求，请刷新页面后重试。');
          }
          async function management(action, input) {
            if (disposed) throw new Error('工作台已关闭，请重新打开后重试。');
            const access = requestAccess();
            const control = new AbortController();
            managementRequests.add(control);
            const timeout = setTimeout(() => control.abort(), 45_000);
            try {
              const response = await requestFetch(access.prefix + '/api/dsh-unified/manage/' + action, {
                method: 'POST', credentials: 'same-origin', cache: 'no-store',
                headers: { ...access.headers, 'content-type': 'application/json' },
                body: JSON.stringify(input), signal: control.signal,
              });
              const data = await response.json();
              if (response.ok && data?.ok === true) return data.value;
              const error = new Error(data?.error?.message || '操作未完成，请刷新列表确认结果。');
              error.code = data?.error?.code || 'management/unavailable';
              error.details = data?.error?.details;
              throw error;
            } catch (error) {
              if (error?.code) throw error;
              const failure = new Error(action === 'directories' ? '目录暂时无法读取，可以直接输入绝对路径。' : '创建结果尚未确认，请先刷新列表查看。');
              failure.code = action === 'directories' ? 'management/read-unavailable' : 'management/result-uncertain';
              throw failure;
            } finally { clearTimeout(timeout); managementRequests.delete(control); }
          }
          function markCreated(host, sessionId) {
            if (!validHostId(host) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) return;
            if (!Object.hasOwn(created, host)) created[host] = Object.create(null);
            created[host][sessionId] = true;
            created[host] = Object.fromEntries(Object.entries(created[host]).slice(-128));
            try { sessionStorage.setItem(createdKey, JSON.stringify(created)); } catch {}
          }
          function publishCreatedSession(dialog, sessionId) {
            uncertainCreates.delete(creationKey(dialog)); saveUncertainCreates();
            markCreated(dialog.host, sessionId);
            if (!confirmedCreated.has(dialog.host)) confirmedCreated.set(dialog.host, new Map());
            const row = { sessionId, blank: true, running: false, agentAvailable: false,
              cwd: dialog.path, updatedAt: Date.now() };
            const workspace = typeof dialog.workspaceId === 'string' ? {
              workspaceId: dialog.workspaceId, path: dialog.path,
              title: dialog.workspaceTitle || dialog.path, sessionIds: [sessionId],
            } : undefined;
            confirmedCreated.get(dialog.host).set(sessionId, { row, workspace, until: Date.now() + 60_000 });
            if (confirmedCreated.get(dialog.host).size > 128) confirmedCreated.get(dialog.host).delete(confirmedCreated.get(dialog.host).keys().next().value);
            // A successful source-specific create acknowledgement is enough to
            // show/open this identity. Catalog reconciliation runs separately.
            const hosts = reconcileCreated(snapshot.hosts, false).map(host => host.id === dialog.host ? { ...host, status: 'ready' } : host);
            if (typeof dialog.workspaceId === 'string') setWorkspaceExpanded(dialog.host, dialog.workspaceId, true, false);
            emit({ ...snapshot, hosts, dialog: null,
              recentCreated: { host: dialog.host, sessionId, workspaceId: dialog.workspaceId },
              managerNotice: '已在 ' + dialog.label + ' 创建会话，正在打开…' });
          }
          function reconcileCreated(hosts, sourceRead = true) {
            return hosts.map(host => {
              const pending = confirmedCreated.get(host.id);
              if (!pending?.size) return host;
              let items = host.items, workspaces = host.workspaces;
              for (const [id, value] of pending) {
                if (value.until <= Date.now() || sourceRead && host.status === 'ready' && host.items.some(item => item.sessionId === id)) {
                  pending.delete(id); continue;
                }
                if (!items.some(item => item.sessionId === id)) items = [...items, value.row];
                if (value.workspace) {
                  const own = workspaces.find(workspace => workspace.workspaceId === value.workspace.workspaceId);
                  if (!own) workspaces = [...workspaces, value.workspace];
                  else if (!own.sessionIds.includes(id)) workspaces = workspaces.map(workspace => workspace !== own ? workspace : { ...workspace, sessionIds: [...workspace.sessionIds, id] });
                }
              }
              return items === host.items && workspaces === host.workspaces ? host : { ...host, items, workspaces };
            });
          }
          function setWorkspaceExpanded(host, workspaceId, expanded, notify = true) {
            const key = host + ':' + workspaceId;
            if (expanded) sidebarExpanded.add(key); else sidebarExpanded.delete(key);
            sidebarExpanded = new Set([...sidebarExpanded].slice(-128));
            try { sessionStorage.setItem(sidebarExpansionKey, JSON.stringify([...sidebarExpanded])); } catch {}
            if (notify) emit({ ...snapshot });
          }
          function showManager() {
            enableUnified();
            const collapsed = document.querySelector?.('[data-sidebar-collapsed]')?.getAttribute('data-sidebar-collapsed');
            if (typeof window.innerWidth === 'number' && window.innerWidth <= 700 && collapsed === 'false') ui.layout.toggleSidebar?.();
            ui.layout.selectPanel(panel);
          }
          function openCreation(kind, host, workspace) {
            if (writeBusy || host.status !== 'ready') return;
            let requestId;
            try { requestId = newRequestId(); } catch (error) { emit({ ...snapshot, managerNotice: error.message }); showManager(); return; }
            browseGeneration++;
            emit({ ...snapshot, managerNotice: '', dialog: { kind, host: host.id, label: host.label,
              path: kind === 'workspace' ? '' : workspace.path, workspaceId: workspace?.workspaceId,
              workspaceTitle: workspace?.title || workspace?.path || '', requestId,
              directory: null, browsing: false, showHidden: false, error: '', uncertain: false } });
            showManager();
          }
          async function createAndOpen(host, workspace) {
            if (disposed || writeBusy || host.status !== 'ready') return;
            const previous = uncertainCreates.get(creationKey({ host: host.id, workspaceId: workspace.workspaceId }));
            if (previous) {
              emit({ ...snapshot, dialog: previous, managerNotice: '上一次创建结果仍待核对，未发送新的创建请求。' });
              showManager(); return;
            }
            if (uncertainCreates.size >= 128) {
              emit({ ...snapshot, managerNotice: '待核对的创建请求较多，请先核对已有会话列表。' }); showManager(); return;
            }
            let requestId;
            try { requestId = newRequestId(); }
            catch (error) { emit({ ...snapshot, managerNotice: error.message }); showManager(); return; }
            const dialog = { kind: 'session', host: host.id, label: host.label,
              path: workspace.path, workspaceId: workspace.workspaceId,
              workspaceTitle: workspace.title || workspace.path || '', requestId };
            await createFromDialog(undefined, dialog);
          }
          function editDialog(patch) {
            if (!snapshot.dialog || writeBusy) return;
            emit({ ...snapshot, dialog: { ...snapshot.dialog, ...patch } });
          }
          function closeCreation() {
            if (writeBusy) return;
            browseGeneration++;
            emit({ ...snapshot, dialog: null });
          }
          async function browseDirectory(path) {
            const dialog = snapshot.dialog;
            if (!dialog || dialog.kind !== 'workspace' || dialog.browsing || writeBusy) return;
            const generation = ++browseGeneration;
            editDialog({ browsing: true, error: '' });
            try {
              const value = await management('directories', { host: dialog.host, ...(path ? { path } : {}) });
              if (disposed || generation !== browseGeneration || !snapshot.dialog) return;
              if (!value || typeof value.path !== 'string' || !Array.isArray(value.entries) || !Array.isArray(value.crumbs)) throw new Error('目录结果不可用，可以直接输入绝对路径。');
              editDialog({ path: value.path, directory: value, browsing: false });
            } catch (error) {
              if (disposed || generation !== browseGeneration || !snapshot.dialog) return;
              const message = error?.code === 'directory-picker/unavailable'
                ? '此主机暂不提供网页目录浏览，请直接输入这台主机上的绝对路径。'
                : error instanceof Error ? error.message : '目录暂时无法读取，请直接输入绝对路径。';
              editDialog({ browsing: false, error: message });
            }
          }
          async function refreshAfterWrite() {
            if (disposed) return null;
            if (inFlight) await inFlight;
            return refresh();
          }
          async function createFromDialog(event, submittedDialog) {
            event?.preventDefault?.();
            const dialog = submittedDialog || snapshot.dialog;
            if (disposed || !dialog || writeBusy || dialog.browsing || dialog.uncertain) return;
            if (dialog.kind === 'workspace' && !absoluteWorkspacePath(dialog.path)) {
              editDialog({ error: '请输入目标主机上的绝对目录路径。' }); return;
            }
            writeBusy = true;
            emit({ ...snapshot, operationBusy: true, dialog: { ...dialog, error: '' } });
            try {
              if (dialog.kind === 'session') {
                // Persist before dispatch so navigation/reload cannot turn an
                // outstanding create into a second request with another ID.
                uncertainCreates.set(creationKey(dialog), { ...dialog, uncertain: true,
                  error: '上次创建已提交，结果尚未确认。请先核对会话列表，勿重复创建。' });
                if (!saveUncertainCreates()) {
                  uncertainCreates.delete(creationKey(dialog));
                  const error = new Error('无法保存创建请求，请允许此页面使用本地存储后重试。');
                  error.code = 'management/storage-unavailable'; throw error;
                }
              }
              const value = await management(dialog.kind === 'workspace' ? 'workspace-create' : 'session-create', {
                host: dialog.host, requestId: dialog.requestId,
                ...(dialog.kind === 'workspace' ? { path: dialog.path } : { workspaceId: dialog.workspaceId }),
              });
              if (disposed) return;
              if (dialog.kind === 'workspace' && (typeof value?.workspace?.workspaceId !== 'string' || typeof value?.workspace?.path !== 'string')) {
                const error = new Error('创建结果尚未确认，请先刷新列表查看。'); error.code = 'management/result-uncertain'; throw error;
              }
              if (dialog.kind === 'session') {
                if (typeof value?.sessionId !== 'string' || !value.sessionId) { const error = new Error('创建结果尚未确认，请先刷新列表查看。'); error.code = 'management/result-uncertain'; throw error; }
                publishCreatedSession(dialog, value.sessionId);
                // Do not put a second create or a full multi-host catalog read
                // between the acknowledged identity and its native controller.
                try {
                  await open(dialog.host, value.sessionId, dialog.workspaceId, true);
                  if (!disposed) emit({ ...snapshot, managerNotice: '已在 ' + dialog.label + ' 打开新会话。' });
                } catch (error) {
                  if (!disposed) {
                    emit({ ...snapshot, managerNotice: '会话已创建；' + (error instanceof Error ? error.message : '暂时无法打开。') + ' 可点击下方「打开刚创建的会话」继续，请勿重复创建。' });
                    showManager();
                  }
                }
                if (!disposed) void refreshAfterWrite();
              } else {
                setWorkspaceExpanded(dialog.host, value.workspace.workspaceId, true, false);
                const hosts = snapshot.hosts.map(host => host.id !== dialog.host ? host : {
                  ...host, workspaces: host.workspaces.some(workspace => workspace.workspaceId === value.workspace.workspaceId)
                    ? host.workspaces : [...host.workspaces, value.workspace],
                });
                emit({ ...snapshot, hosts, dialog: null, recentCreated: null,
                  managerNotice: value?.created === false ? '此目录已在工作区列表中。' : '已添加工作区，可以在该目录下新建会话。' });
                void refreshAfterWrite();
              }
            } catch (error) {
              if (disposed) return;
              const published = error?.code === 'session/workspace-attach-failed' && error?.details?.sessionId;
              if (typeof published === 'string') {
                uncertainCreates.delete(creationKey(dialog)); saveUncertainCreates();
                publishCreatedSession({ ...dialog, workspaceId: undefined }, published);
                emit({ ...snapshot, managerNotice: '会话已创建，但未能加入工作区。已保留该会话，可在「其他会话」中查看。' });
                void refreshAfterWrite();
                showManager();
              } else if (!disposed) {
                const uncertain = error?.code === 'management/result-uncertain';
                const failedDialog = { ...dialog, error: error instanceof Error ? error.message : '创建未完成，请刷新列表确认结果。', uncertain };
                if (uncertain && dialog.kind === 'session') {
                  uncertainCreates.set(creationKey(dialog), failedDialog); saveUncertainCreates();
                } else if (dialog.kind === 'session') {
                  uncertainCreates.delete(creationKey(dialog)); saveUncertainCreates();
                }
                emit({ ...snapshot, dialog: failedDialog });
                showManager();
              }
            } finally {
              writeBusy = false;
              if (!disposed) emit({ ...snapshot, operationBusy: false });
            }
          }
          async function refresh() {
            if (disposed) return null;
            if (inFlight) return inFlight;
            requestAbort = new AbortController();
            const timeout = setTimeout(() => requestAbort?.abort(), 45_000);
            inFlight = (async () => {
              try {
                let device;
                try { device = sessionStorage.getItem('dsh-remote-device'); } catch {}
                const phone = typeof device === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(device);
                const response = await requestFetch((phone ? '/remote' : '') + '/api/dsh-unified/catalog', {
                  credentials: 'same-origin', cache: 'no-store',
                  headers: phone ? { 'x-dsh-remote-device': device } : {},
                  signal: requestAbort.signal,
                });
                const data = await response.json();
                if (!response.ok || data?.ok !== true || !Array.isArray(data.hosts)) throw new Error('工作区列表暂时无法更新。');
                const ids = new Set();
                const hosts = reconcileCreated(data.hosts.map(host => {
                  if (!host || !validHostId(host.id) || ids.has(host.id) || typeof host.label !== 'string' || !Array.isArray(host.workspaces) || !Array.isArray(host.items)) throw new Error('工作区列表暂时无法更新。');
                  ids.add(host.id); return host;
                }));
                if (!ids.has('mac')) throw new Error('本机工作区暂时无法读取。');
                hosts.sort((a, b) => a.id === 'mac' ? -1 : b.id === 'mac' ? 1 : 0);
                if (!disposed) { catalogReadAt = Date.now(); emit({ ...snapshot, phase: 'ready', hosts, error: '' }); }
                return hosts;
              } catch {
                if (!disposed) emit({ ...snapshot, phase: 'error', error: '工作区列表暂时无法更新，请稍后重试。' });
                return null;
              } finally { clearTimeout(timeout); inFlight = undefined; requestAbort = undefined; }
            })();
            return inFlight;
          }
          const state = {
            getSnapshot: () => snapshot,
            subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
          };
          ui.effect(() => {
            const stopSelection = ui.uiWorkspace.selection?.subscribe?.(() => {
              saveCurrentSelection();
              snapshot = { ...snapshot, ...(persistentMode ? { activeTarget: 'mac' } : {}) };
              for (const listener of listeners) listener();
            });
            try {
              const pendingPanel = JSON.parse(sessionStorage.getItem('dsh-unified-pending-panel') || 'null');
              if (pendingPanel?.host === selected && pendingPanel.panel === 'plugins') {
                sessionStorage.removeItem('dsh-unified-pending-panel');
                ui.layout.selectPanel('plugins');
              }
            } catch {}
            refresh();
            const interval = setInterval(refresh, 10_000);
            const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
            document.addEventListener('visibilitychange', onVisible);
            return () => { disposed = true; for (const bridge of persistentBridges.values()) bridge.dispose(); persistentBridges.clear(); clearInterval(interval); requestAbort?.abort(); for (const control of managementRequests) control.abort(); stopSelection?.(); document.removeEventListener('visibilitychange', onVisible); listeners.clear(); };
          }, '远端 unified workspaces: read-only catalogs');
          function roots(host, allBlank = false) {
            const archived = new Set(host.archivedSessionIds || []);
            return host.items.filter(item => typeof item.sessionId === 'string' && (item.blank === false || item.blank === true && (allBlank || created[host.id]?.[item.sessionId] || host.id === selected && item.sessionId === currentSessionId)) && !item.parentSessionId && item.origin !== 'subagent' && !archived.has(item.sessionId)).sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
          }
          function groups(host, allBlank = false) {
            const available = roots(host, allBlank);
            const used = new Set();
            const result = host.workspaces.map(workspace => {
              const members = available.filter(item => (workspace.sessionIds || []).includes(item.sessionId) && !used.has(item.sessionId));
              for (const item of members) used.add(item.sessionId);
              return { ...workspace, members };
            });
            const remaining = available.filter(item => !used.has(item.sessionId));
            if (remaining.length) result.push({ workspaceId: '__other__', title: '其他会话', members: remaining });
            return result;
          }
          const titleOf = item => typeof item.projections?.values?.title === 'string' && item.projections.values.title.trim() ? item.projections.values.title : typeof item.projectionValues?.title === 'string' && item.projectionValues.title.trim() ? item.projectionValues.title : typeof item.title === 'string' && item.title.trim() ? item.title : item.blank === true ? '空白会话' : '未命名会话';
          async function open(hostId, sessionId, workspaceId, allowBlank = false) {
            const cached = snapshot.hosts.find(row => row.id === hostId);
            const acknowledgement = confirmedCreated.get(hostId)?.get(sessionId);
            const acknowledged = acknowledgement && acknowledgement.until > Date.now()
              && roots(cached, true).some(item => item.sessionId === sessionId);
            const knownCurrent = acknowledged || (hostId === selected && Date.now() - catalogReadAt < 10_000 || persistentMode && hostId !== 'mac')
              && snapshot.phase === 'ready' && cached?.status === 'ready'
              && roots(cached, allowBlank).some(item => item.sessionId === sessionId);
            const latest = knownCurrent ? snapshot.hosts : await refresh();
            const host = latest?.find(row => row.id === hostId);
            if (!host || !acknowledged && host.status !== 'ready' || !roots(host, allowBlank).some(item => item.sessionId === sessionId)) throw new Error('该会话暂时无法打开，请刷新列表后重试。');
            if (hostId === selected) {
              if (allowBlank) await ui.uiWorkspace.sessions?.refresh?.();
              await ui.uiWorkspace.openSession(sessionId);
              if (persistentMode) snapshot = { ...snapshot, activeTarget: 'mac' };
              currentSessionId = sessionId;
              saveCurrentSelection();
              ui.layout.selectPanel(null);
              if (persistentMode) document.querySelector('[contenteditable="true"],textarea')?.focus?.();
              snapshot = { ...snapshot };
              for (const listener of listeners) listener();
              return;
            }
            saveCurrentSelection();
            if (persistentMode && hostId !== 'mac') {
              const bridge = bridgeFor(hostId);
              emit({ ...snapshot, activeTarget: hostId, remotes: { ...snapshot.remotes, [hostId]: { ...snapshot.remotes[hostId], sessionId, notice: '' } } });
              ui.layout.selectPanel(null);
              try { await bridge.open(sessionId); syncAppearance(); }
              catch (error) { emit({ ...snapshot, remotes: { ...snapshot.remotes, [hostId]: { ...snapshot.remotes[hostId], notice: error instanceof Error ? error.message : '远程工作区尚未就绪。' } } }); throw error; }
              return;
            }
            const pending = { host: hostId, sessionId };
            if (workspaceId && workspaceId !== '__other__') pending.workspaceId = workspaceId;
            sessionStorage.setItem(pendingKey, JSON.stringify(pending));
            ui.layout.selectPanel(null);
            window.location.reload();
          }
          async function openTargetPlugins(hostId) {
            const host = snapshot.hosts.find(row => row.id === hostId);
            if (!validHostId(hostId, false) || !host) throw new Error('未配置此远端主机。');
            if (hostId === selected) { ui.layout.selectPanel('plugins'); return; }
            let saved;
            try { saved = JSON.parse(sessionStorage.getItem(selectionKey) || '{}')[hostId]?.sessionId; } catch {}
            const preferred = snapshot.remotes[hostId]?.sessionId || saved;
            const row = host.items.find(item => item.sessionId === preferred) || host.items.find(item => typeof item.sessionId === 'string');
            if (!row) throw new Error('目标尚无可打开的会话，请先在该主机创建一个工作区会话。');
            saveCurrentSelection();
            if (persistentMode) {
              const bridge = bridgeFor(hostId);
              emit({ ...snapshot, activeTarget: hostId });
              ui.layout.selectPanel(null);
              await bridge.openPlugins(row.sessionId);
            } else {
              sessionStorage.setItem('dsh-unified-pending-panel', JSON.stringify({ host: hostId, panel: 'plugins' }));
              sessionStorage.setItem(pendingKey, JSON.stringify({ host: hostId, sessionId: row.sessionId }));
              window.location.reload();
            }
          }
          const rowStyle = { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', textAlign: 'left', width: '100%', minWidth: 0, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6, boxSizing: 'border-box' };
          function UnifiedTree({ wide = true, expandSidebar, main = false }) {
            const catalog = React.useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
            const [closed, setClosed] = React.useState({});
            const [busy, setBusy] = React.useState(false);
            const [notice, setNotice] = React.useState('');
            const toggle = id => setClosed(value => ({ ...value, [id]: !value[id] }));
            async function reveal(host, item, workspaceId) {
              if (busy) return;
              setBusy(true); setNotice('');
              try { await open(host.id, item.sessionId, workspaceId, item.blank === true); }
              catch (error) { setNotice(error instanceof Error ? error.message : '打开未完成，请重试。'); }
              finally { setBusy(false); }
            }
            if (!wide) return h('button', { type: 'button', style: { ...rowStyle, justifyContent: 'center', padding: 10 }, title: '全部工作区', 'aria-label': '展开全部工作区', onClick: () => expandSidebar?.() }, '▤');
            const sessionRow = (host, group, item) => {
              const active = host.id === (persistentMode ? catalog.activeTarget : selected) && item.sessionId === (persistentMode && host.id !== 'mac' ? catalog.remotes[host.id]?.sessionId : currentSessionId);
              return h('button', {
                type: 'button', key: host.id + ':' + item.sessionId, role: 'treeitem',
                'data-row-key': 'session:' + item.sessionId, 'data-host-id': host.id,
                'data-workspace-id': group.workspaceId,
                'aria-current': active ? 'page' : undefined,
                disabled: busy || catalog.operationBusy || host.status !== 'ready', title: titleOf(item),
                onClick: () => reveal(host, item, group.workspaceId),
                style: { ...rowStyle, padding: '7px 8px 7px 29px', fontSize: 12, opacity: busy ? 0.65 : 1, background: active ? 'var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.13))' : 'transparent' },
              }, h('span', { 'aria-hidden': true, style: { opacity: 0.5 } }, '◦'), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, titleOf(item)), main ? h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: 0.55, flexShrink: 0 } }, '打开') : null, item.running === true ? h('span', { title: '运行中', 'aria-label': '运行中', style: { color: '#2b9b68', marginLeft: main ? 3 : 'auto', flexShrink: 0, fontSize: 10 } }, '●') : null);
            };
            if (!main) {
              const hosts = catalog.hosts;
              const mac = hosts.find(host => host.id === 'mac');
              const remotes = hosts.filter(host => host.id !== 'mac');
              const workspaceRows = hosts.flatMap(host => groups(host).filter(group => group.workspaceId !== '__other__').map(group => {
                const key = host.id + ':' + group.workspaceId;
                const expanded = sidebarExpanded.has(key);
                const label = group.title || group.path?.split('/').filter(Boolean).pop() || '工作区';
                return h('div', { key, role: 'group', 'aria-label': label, 'data-flat-workspace-row': true, 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, style: { marginBottom: 3 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', minHeight: 32, gap: 2 } },
                    h('button', { type: 'button', 'data-action': 'toggle-workspace', 'aria-label': (expanded ? '收起工作区：' : '展开工作区：') + label, 'aria-expanded': expanded, onClick: () => setWorkspaceExpanded(host.id, group.workspaceId, !expanded), style: { ...rowStyle, width: 23, flex: '0 0 23px', padding: '6px 3px', justifyContent: 'center' } }, expanded ? '⌄' : '›'),
                    h('button', { type: 'button', 'data-action': 'open-workspace', disabled: busy || catalog.operationBusy || host.status !== 'ready', title: group.path || label, onClick: () => setWorkspaceExpanded(host.id, group.workspaceId, !expanded), style: { ...rowStyle, flex: 1, padding: '6px 2px', overflow: 'hidden', fontSize: 12, fontWeight: 550 } },
                      h('span', { 'aria-hidden': true, style: { opacity: 0.6 } }, '▱'), h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label)),
                    host.id !== 'mac' && h('span', { 'data-remote-workspace-badge': true, style: { fontSize: 9, whiteSpace: 'nowrap', opacity: 0.6, flexShrink: 0 } }, host.label + ' · 远程'),
                    h('button', { type: 'button', 'data-action': 'new-session', 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, 'aria-label': '在 ' + host.label + ' 的 ' + label + ' 新建并打开会话', disabled: busy || catalog.operationBusy || host.status !== 'ready', onClick: () => createAndOpen(host, group), style: { ...rowStyle, width: 'auto', flexShrink: 0, fontSize: 11, padding: '5px 3px' } }, '+ 会话')),
                  expanded && (group.members.length ? group.members.map(item => sessionRow(host, group, item)) : h('p', { style: { margin: '3px 4px 7px 27px', fontSize: 11, opacity: 0.55 } }, '暂无会话，点击「+ 会话」创建')));
              }));
              const addButton = (host, label, empty = false) => h('button', { key: host.id + ':' + label, type: 'button', 'data-action': 'new-workspace', 'data-host-id': host.id, 'data-empty-remote-action': empty || undefined, disabled: catalog.operationBusy || host.status !== 'ready', onClick: () => openCreation('workspace', host), style: { ...rowStyle, padding: '8px 5px', fontSize: 11, opacity: host.status === 'ready' ? 0.75 : 0.5 } }, label);
              return h('section', { 'aria-label': '全部工作区', 'data-dsh-unified-workspaces': true, 'data-unified-location': 'sidebar', 'data-sidebar-layout': 'workspace-list', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'auto', padding: '0 10px 10px', boxSizing: 'border-box', color: 'inherit' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 4px' } }, h('strong', { style: { fontSize: 12, opacity: 0.7 } }, '工作区'),
                  h('button', { type: 'button', 'aria-label': '打开远端工作台', onClick: showManager, style: { ...rowStyle, width: 'auto', fontSize: 11, marginLeft: 'auto', padding: '2px 4px', opacity: 0.65 } }, '管理'),
                  h('button', { type: 'button', 'aria-label': '刷新全部工作区', onClick: () => refresh(), style: { ...rowStyle, width: 'auto', padding: '2px 4px' } }, '↻')),
                catalog.phase === 'loading' && h('p', { style: { fontSize: 12, padding: 4, opacity: 0.7 } }, '正在读取工作区…'),
                catalog.error && h('p', { role: 'status', style: { fontSize: 12, padding: 4, color: '#bc6b15' } }, catalog.error),
                notice && h('p', { role: 'alert', style: { fontSize: 12, padding: 4, color: '#bc6b15' } }, notice),
                h('div', { role: 'tree', 'aria-label': '本机与远程工作区', 'aria-busy': busy }, workspaceRows),
                remotes.filter(remote => remote.workspaces.length === 0).map(remote => addButton(remote, '+ 添加 ' + remote.label + ' 工作区', true)),
                remotes.filter(remote => remote.status === 'offline').map(remote => h('p', { key: remote.id, style: { fontSize: 11, padding: '0 5px', opacity: 0.6 } }, remote.label + ' 暂时离线')),
                h('div', { style: { marginTop: 8, borderTop: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', paddingTop: 4 } }, mac && addButton(mac, '+ 本机工作区'), remotes.map(remote => addButton(remote, '+ ' + remote.label + ' 工作区'))));
            }
            return h('section', { 'aria-label': '全部工作区', 'data-dsh-unified-workspaces': true, 'data-unified-location': main ? 'main' : 'sidebar', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'auto', padding: main ? '0 8px 16px' : '0 10px 10px', boxSizing: 'border-box', color: 'inherit' } },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 4px', flex: '0 0 auto' } },
                h('strong', { style: { fontSize: 12, opacity: 0.7 } }, '全部工作区'),
                h('button', { type: 'button', title: '管理当前主机的工作区', 'aria-label': '管理当前工作区', onClick: manageCurrent, style: { ...rowStyle, width: 'auto', marginLeft: 'auto', padding: '2px 5px', fontSize: 11, opacity: 0.7 } }, '管理当前主机'),
                h('button', { type: 'button', 'aria-label': '刷新全部工作区', onClick: () => refresh(), style: { ...rowStyle, width: 'auto', padding: '2px 5px' } }, '↻')),
              catalog.phase === 'loading' && h('p', { style: { fontSize: 12, padding: 4, opacity: 0.7 } }, '正在读取工作区…'),
              catalog.error && h('p', { role: 'status', style: { fontSize: 12, padding: 4, color: '#bc6b15' } }, catalog.error),
              notice && h('p', { role: 'alert', style: { fontSize: 12, padding: 4, color: '#bc6b15' } }, notice),
              h('div', { role: 'tree', 'aria-label': '本机与远端工作区', 'aria-busy': busy }, catalog.hosts.map(host => {
                const hostGroups = groups(host, main);
                const hostClosed = closed['host:' + host.id];
                return h('div', { key: host.id, role: 'group', 'aria-label': host.label, 'data-workspace-host': host.id, style: { marginBottom: 12 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } }, h('button', { type: 'button', style: { ...rowStyle, fontSize: 13, fontWeight: 650, padding: '8px 4px', flex: 1 }, onClick: () => toggle('host:' + host.id), 'aria-expanded': !hostClosed },
                    h('span', { 'aria-hidden': true }, hostClosed ? '›' : '⌄'), host.label,
                    host.id === selected ? h('span', { style: { fontSize: 10, fontWeight: 400, opacity: 0.55 } }, '当前') : null,
                    h('span', { style: { fontSize: 10, fontWeight: 400, opacity: 0.55, marginLeft: 'auto' } }, host.status === 'ready' ? String(roots(host, main).length) : '暂时离线')),
                    h('button', { type: 'button', 'data-action': 'new-workspace', 'data-host-id': host.id, 'aria-label': '在 ' + host.label + ' 新建工作区', disabled: catalog.operationBusy || host.status !== 'ready', onClick: () => openCreation('workspace', host), style: { ...rowStyle, width: 'auto', flexShrink: 0, fontSize: 11, padding: '5px 4px' } }, '+ 工作区')),
                  !hostClosed && (host.status !== 'ready' ? h('p', { style: { fontSize: 12, padding: '0 14px', opacity: 0.65 } }, '连接恢复后可继续打开原会话。') : hostGroups.length === 0 ? h('p', { style: { fontSize: 12, padding: '0 14px', opacity: 0.65 } }, '暂无工作区') : hostGroups.map(group => {
                    const groupKey = host.id + ':' + group.workspaceId;
                    const groupClosed = closed[groupKey];
                    const label = group.title || group.path?.split('/').filter(Boolean).pop() || '工作区';
                    return h('div', { key: groupKey, role: 'group', 'aria-label': label, 'data-workspace-id': group.workspaceId },
                      h('div', { style: { display: 'flex', alignItems: 'center' } },
                        h('button', { type: 'button', 'aria-label': (groupClosed ? '展开工作区：' : '收起工作区：') + label, 'aria-expanded': !groupClosed, onClick: () => toggle(groupKey), style: { ...rowStyle, padding: '6px 2px 6px 12px', width: 29, flex: '0 0 29px' } }, groupClosed ? '›' : '⌄'),
                        h('button', { type: 'button', disabled: busy, onClick: () => {
                          toggle(groupKey);
                        }, title: group.path || label, style: { ...rowStyle, padding: '6px 4px', fontSize: 12, fontWeight: 550, overflow: 'hidden' } }, h('span', { style: { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, label)),
                        group.workspaceId !== '__other__' && h('button', { type: 'button', 'data-action': 'new-session', 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, 'aria-label': '在 ' + host.label + ' 的 ' + label + ' 新建并打开会话', disabled: busy || catalog.operationBusy || host.status !== 'ready', onClick: () => createAndOpen(host, group), style: { ...rowStyle, width: 'auto', flexShrink: 0, fontSize: 11, padding: '5px 4px' } }, '+ 会话')),
                      !groupClosed && (group.members.length ? group.members.map(item => sessionRow(host, group, item)) : h('p', { style: { margin: '3px 4px 6px 29px', fontSize: 11, opacity: 0.55 } }, '暂无已有会话')));
                  })));
              })));
          }
          function CreationForm({ catalog }) {
            const dialog = catalog.dialog;
            if (!dialog) return null;
            const workspace = dialog.kind === 'workspace';
            const disabled = catalog.operationBusy || dialog.browsing;
            const fieldStyle = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', borderRadius: 7, background: 'transparent', color: 'inherit', padding: '9px 10px', font: 'inherit', fontSize: 13 };
            const buttonStyle = { ...rowStyle, width: 'auto', padding: '8px 11px', border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', fontSize: 12 };
            return h('form', { 'aria-label': workspace ? '新建工作区表单' : '新建会话表单', onSubmit: createFromDialog, style: { border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', borderRadius: 12, padding: 16, margin: '0 0 16px', flexShrink: 0 } },
              h('h3', { style: { margin: '0 0 8px', fontSize: 15 } }, (workspace ? '新建工作区 · ' : '新建会话 · ') + dialog.label),
              workspace ? h('div', null,
                h('label', { style: { display: 'block', fontSize: 12, marginBottom: 6 } }, '目标主机上的目录'),
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('input', { 'aria-label': '工作区目录', value: dialog.path, disabled, placeholder: '/目标主机/项目目录', onChange: event => { browseGeneration++; editDialog({ path: event.target.value, directory: null, error: '', uncertain: false, requestId: newRequestId() }); }, style: { ...fieldStyle, minWidth: 0, flex: 1 } }),
                  h('button', { type: 'button', disabled, onClick: () => browseDirectory(dialog.path || undefined), style: buttonStyle }, dialog.browsing ? '读取中…' : '浏览目录')),
                h('p', { style: { fontSize: 11, opacity: 0.65, margin: '7px 0' } }, '选择已有目录，或直接输入绝对路径。工作区名称会根据目录生成。'),
                dialog.directory && h('section', { 'aria-label': '目标主机目录浏览器', style: { borderTop: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', marginTop: 10, paddingTop: 8 } },
                  h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 } }, dialog.directory.crumbs.map((crumb, index) => h('button', { key: crumb.path, type: 'button', disabled, onClick: () => browseDirectory(crumb.path), style: { ...rowStyle, width: 'auto', padding: '3px 5px', fontSize: 11 } }, index ? crumb.name : '/'))),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, opacity: 0.7, marginBottom: 6 } }, h('input', { type: 'checkbox', checked: dialog.showHidden, disabled, onChange: event => editDialog({ showHidden: event.target.checked }) }), '显示隐藏目录'),
                  h('div', { style: { maxHeight: 180, overflow: 'auto' } }, dialog.directory.entries.filter(entry => dialog.showHidden || !entry.hidden).map(entry => h('button', { key: entry.path, type: 'button', disabled, title: entry.path, onClick: () => browseDirectory(entry.path), style: { ...rowStyle, padding: '5px 4px', fontSize: 12 } }, '▸ ', entry.name))),
                  dialog.directory.truncated && h('p', { style: { fontSize: 11, opacity: 0.65 } }, '此层目录较多，仅显示一部分；可直接输入完整路径。')))
                : h('div', null, h('p', { style: { fontSize: 13, margin: '4px 0' } }, dialog.workspaceTitle), h('p', { style: { fontSize: 11, opacity: 0.65, wordBreak: 'break-all' } }, dialog.path), h('p', { style: { fontSize: 12, opacity: 0.7 } }, '使用这台主机已有的默认配置创建并打开空白会话。')),
              dialog.error && h('p', { role: 'alert', style: { fontSize: 12, color: '#bc6b15', margin: '10px 0' } }, dialog.error),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
                h('button', { type: 'submit', disabled: disabled || dialog.uncertain, style: buttonStyle }, catalog.operationBusy ? '正在新建…' : workspace ? '新建工作区' : '新建会话'),
                dialog.uncertain && h('button', { type: 'button', disabled: catalog.operationBusy, onClick: () => refreshAfterWrite(), style: buttonStyle }, '刷新列表查看结果'),
                dialog.uncertain && dialog.kind === 'session' && h('button', { type: 'button', disabled: catalog.operationBusy, onClick: () => {
                  uncertainCreates.delete(creationKey(dialog)); saveUncertainCreates();
                  emit({ ...snapshot, dialog: null, managerNotice: '已解除这次创建的保留状态。若已找到会话，请直接打开；再次点「＋会话」会创建另一个。' });
                }, style: buttonStyle }, '已核对列表，允许再次新建'),
                h('button', { type: 'button', disabled: catalog.operationBusy, onClick: closeCreation, style: buttonStyle }, '取消')));
          }
          function WorkspacesPage() {
            const catalog = React.useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
            const recent = catalog.recentCreated;
            const recentHost = recent && catalog.hosts.find(host => host.id === recent.host);
            return h('section', { 'data-remote-workbench': true, style: { padding: 20, maxWidth: 980, margin: '0 auto', width: '100%', height: '100%', minHeight: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'auto' } },
              h('h2', { style: { fontSize: 20, margin: '0 0 8px' } }, '远端工作台'),
              h('p', { style: { opacity: 0.7, fontSize: 13, margin: '0 0 12px' } }, '集中管理本机和已配置远端的目录、工作区与会话。'),
              h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,280px),1fr))', gap: 12, marginBottom: 16, flexShrink: 0 } }, catalog.hosts.map(host => h('section', { key: host.id, 'data-manager-host': host.id, style: { border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', borderRadius: 12, padding: 14 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h('strong', { style: { fontSize: 14 } }, host.label), h('span', { style: { marginLeft: 'auto', fontSize: 11, color: host.status === 'ready' ? '#2b9b68' : '#bc6b15' } }, host.status === 'ready' ? '可访问' : '暂时离线')),
                h('p', { style: { fontSize: 11, opacity: 0.65, margin: '6px 0' } }, host.id !== 'mac' ? '此主机使用已有的 SSH 连接与 DSH 服务' : '本机上的 DSH'),
                h('p', { style: { fontSize: 12, opacity: 0.7 } }, host.workspaces.length + ' 个工作区 · ' + roots(host, true).length + ' 个会话'),
                h('button', { type: 'button', disabled: catalog.operationBusy || host.status !== 'ready', 'data-action': 'new-workspace', 'data-host-id': host.id, onClick: () => openCreation('workspace', host), style: { ...rowStyle, width: 'auto', border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', padding: '7px 10px', fontSize: 12 } }, '+ 新建工作区')))),
              catalog.hosts.length === 1 && h('p', { 'data-host-setup-help': true, style: { fontSize: 12, opacity: 0.7 } }, '尚未配置远端。请在私有 hosts.json 中添加 SSH 隧道地址和短期凭据命令，再重新加载插件。'),
              h(PluginSyncPanel, { hosts: catalog.hosts, onOpenTarget: async hostId => {
                try { await openTargetPlugins(hostId); }
                catch (error) { emit({ ...snapshot, managerNotice: error instanceof Error ? error.message : '目标插件页暂时无法打开。' }); showManager(); }
              } }),
              h(CreationForm, { catalog }),
              catalog.managerNotice && h('div', { role: 'status', style: { fontSize: 12, padding: '8px 4px 12px', flexShrink: 0 } }, catalog.managerNotice,
                recent && recentHost && h('button', { type: 'button', onClick: async () => { try { await open(recent.host, recent.sessionId, recent.workspaceId, true); } catch (error) { emit({ ...snapshot, managerNotice: error.message }); } }, style: { ...rowStyle, width: 'auto', marginTop: 7, border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', padding: '6px 10px' } }, '打开刚创建的会话')),
              h('div', { style: { minHeight: 260, flex: '1 0 260px' } }, h(UnifiedTree, { main: true })));
          }
          function syncAppearance() {
            if (!persistentMode || !globalThis.getComputedStyle) return;
            const values = getComputedStyle(document.body || document.documentElement);
            const declarations = [];
            for (let index = 0; index < values.length; index++) { const name = values[index]; if (name.startsWith('--dsw-') || name.startsWith('--ds-')) declarations.push(name + ':' + values.getPropertyValue(name)); }
            for (const [hostId, bridge] of persistentBridges) if (snapshot.remotes[hostId]?.ready) bridge.appearance('body,body[data-ds-dark-theme]{' + declarations.join(';') + '}');
          }
          function PersistentOverlay() {
            const catalog = React.useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
            const info = React.useSyncExternalStore(ui.layout.panelInfo.subscribe, ui.layout.panelInfo.getSnapshot, ui.layout.panelInfo.getSnapshot);
            const [bounds, setBounds] = React.useState({ left: 280, top: 0, right: 0, bottom: 0 });
            const [parentCollapsed, setParentCollapsed] = React.useState(false);
            React.useEffect(() => {
              const shell = document.querySelector('[data-shell-overlay]')?.parentElement;
              const center = shell?.children?.[1];
              function measure() { if (!shell || !center) return; const parent = shell.getBoundingClientRect(), main = center.getBoundingClientRect(); setBounds({ left: main.left - parent.left, top: main.top - parent.top, right: 0, bottom: parent.bottom - main.bottom }); const collapsed = shell.getAttribute('data-sidebar-collapsed'); setParentCollapsed(collapsed !== null && collapsed !== 'false'); }
              measure();
              const observer = globalThis.ResizeObserver ? new ResizeObserver(measure) : undefined;
              if (shell) observer?.observe(shell); if (center) observer?.observe(center);
              window.addEventListener('resize', measure);
              return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
            }, []);
            React.useEffect(() => { if (info.activePanelId === null && catalog.remotes[catalog.activeTarget]?.ready) persistentBridges.get(catalog.activeTarget)?.focus(); }, [catalog.activeTarget, info.activePanelId, catalog.remotes]);
            // Keep all previously connected source pages in this stable list.
            const sources = Object.entries(catalog.remotes).filter(([hostId, remote]) => remote.embed || catalog.activeTarget === hostId);
            return sources.map(([hostId, remote]) => {
              const visible = catalog.activeTarget === hostId && info.activePanelId === null;
              const label = catalog.hosts.find(host => host.id === hostId)?.label || hostId;
              return h('section', { key: hostId, 'data-persistent-remote-overlay': true, 'data-host-id': hostId, 'aria-label': label + ' 远程会话', 'aria-hidden': !visible, style: { position: 'absolute', ...bounds, display: visible ? 'block' : 'none', background: 'var(--dsw-alias-bg-base)', overflow: 'hidden', pointerEvents: visible ? 'auto' : 'none' } },
                visible && parentCollapsed && h('button', { type: 'button', 'data-action': 'expand-parent-workspaces', 'aria-label': '展开工作区列表', onClick: () => ui.layout.toggleSidebar(), style: { position: 'absolute', top: 10, left: 10, zIndex: 2, border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', borderRadius: 7, padding: '7px 10px', background: 'var(--dsw-alias-bg-base)', color: 'inherit', cursor: 'pointer', fontSize: 12 } }, '展开工作区列表'),
                remote.embed && h('iframe', { key: remote.embed.frameId, ref: element => persistentBridges.get(hostId)?.attach(element), 'data-persistent-remote-frame': true, 'data-host-id': hostId, title: label + ' 远程工作区', src: remote.embed.frameUrl, sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads', style: { width: '100%', height: '100%', border: 0, display: 'block' } }),
                (!remote.ready || remote.notice) && h('div', { role: 'status', style: { position: 'absolute', top: 12, left: 12, right: 12, borderRadius: 8, padding: 12, background: 'var(--dsw-alias-bg-base)', color: 'inherit', fontSize: 12 } }, remote.notice || '正在打开 ' + label + ' 工作区…'));
            });
          }
          if (persistentMode) {
            ui.slots.inject('shell.overlay', () => ui.slots.register({ name: 'shell.overlay', id: 'dsh-unified-persistent-frame' }, PersistentOverlay));
            ui.effect(() => {
              const observer = globalThis.MutationObserver ? new MutationObserver(syncAppearance) : undefined;
              observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme', 'data-theme'] });
              if (document.body) observer?.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme', 'data-theme'] });
              return () => observer?.disconnect();
            }, 'Remote appearance follows local settings');
          }
          const Icon = () => h('span', { 'aria-hidden': true, style: { fontSize: 16 } }, '▤');
          const Footer = () => h('button', { type: 'button', title: '管理本机与远端的工作区和会话', 'aria-label': '远端工作台', onClick: showManager, style: { background: 'transparent', color: 'inherit', border: 0, padding: '5px 7px', fontSize: 12, cursor: 'pointer' } }, '远端工作台');
          ui.slots.inject('main', () => ui.slots.register({ name: 'main', key: panel }, WorkspacesPage));
          ui.slots.inject('sidebar.workspaces', () => {
            enableUnified();
            return () => { disposeUnified?.(); disposeUnified = undefined; };
          });
          ui.slots.inject('sidebar.panellist', () => ui.slots.register({ name: 'sidebar.panellist', id: panel, label: '远端工作台', order: 3 }, Icon));
          ui.slots.inject('sidebar.footer.action', () => ui.slots.register({ name: 'sidebar.footer.action', id: panel }, Footer));
        });
      },
    };
  },
});
