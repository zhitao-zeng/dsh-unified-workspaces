(() => {
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

  const w = globalThis;
  const allowedClientIds = ["@deepseek-ai/dsh-api-gateway","@deepseek-ai/dsh-api-job-controller","@deepseek-ai/dsh-api-remote-access","@deepseek-ai/dsh-api-remotes","@deepseek-ai/dsh-api-session-controller","@deepseek-ai/dsh-api-terminal-controller","@deepseek-ai/dsh-api-workspace-controller","@deepseek-ai/dsh-api-workspace-files","@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-file-upload","@deepseek-ai/dsh-client-hmr","@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-modules","@deepseek-ai/dsh-client-resources","@deepseek-ai/dsh-client-shortcuts","@deepseek-ai/dsh-client-ui-agent-preset","@deepseek-ai/dsh-client-ui-approval","@deepseek-ai/dsh-client-ui-attachment","@deepseek-ai/dsh-client-ui-brand-official","@deepseek-ai/dsh-client-ui-chat","@deepseek-ai/dsh-client-ui-commands","@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-ui-cordis","@deepseek-ai/dsh-client-ui-deepseek-model-label-1017","@deepseek-ai/dsh-client-ui-deliverables","@deepseek-ai/dsh-client-ui-directory-picker-browse","@deepseek-ai/dsh-client-ui-entry-customization","@deepseek-ai/dsh-client-ui-goal","@deepseek-ai/dsh-client-ui-input-trigger","@deepseek-ai/dsh-client-ui-jobs","@deepseek-ai/dsh-client-ui-layout","@deepseek-ai/dsh-client-ui-message-feedback","@deepseek-ai/dsh-client-ui-model-selection","@deepseek-ai/dsh-client-ui-open-in-app","@deepseek-ai/dsh-client-ui-permission-presets","@deepseek-ai/dsh-client-ui-plan","@deepseek-ai/dsh-client-ui-plugin-manager","@deepseek-ai/dsh-client-ui-reference","@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-schedule","@deepseek-ai/dsh-client-ui-secret-mask","@deepseek-ai/dsh-client-ui-session","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-settings-account","@deepseek-ai/dsh-client-ui-settings-agent-loop","@deepseek-ai/dsh-client-ui-settings-general","@deepseek-ai/dsh-client-ui-settings-models","@deepseek-ai/dsh-client-ui-settings-plugin-inventory","@deepseek-ai/dsh-client-ui-settings-plugins","@deepseek-ai/dsh-client-ui-settings-session-log","@deepseek-ai/dsh-client-ui-settings-shell","@deepseek-ai/dsh-client-ui-settings-subagent","@deepseek-ai/dsh-client-ui-settings-web-search","@deepseek-ai/dsh-client-ui-shortcuts","@deepseek-ai/dsh-client-ui-sidebar","@deepseek-ai/dsh-client-ui-sidebar-documentpreview","@deepseek-ai/dsh-client-ui-sidebar-files","@deepseek-ai/dsh-client-ui-sidebar-right","@deepseek-ai/dsh-client-ui-sidebar-terminal","@deepseek-ai/dsh-client-ui-skill","@deepseek-ai/dsh-client-ui-subagent","@deepseek-ai/dsh-client-ui-theme","@deepseek-ai/dsh-client-ui-tool","@deepseek-ai/dsh-client-ui-trajectory","@deepseek-ai/dsh-client-ui-user-questions","@deepseek-ai/dsh-client-ui-workflow-run","@deepseek-ai/dsh-client-ui-workspace","@deepseek-ai/dsh-cordis-client-runner","@deepseek-ai/dsh-session-log-export","@deepseek-ai/dsh-typert-registry","@zhitao-zeng/dsh-unified-workspaces","@linxin666/dsh-remote-web-ui"];
  const pageOrigin = new URL(document.baseURI);
  const persistentMac = !w.__DSH_EMBED_BOOT__ && (pageOrigin.protocol === 'dsh-app:' || ['http:', 'https:'].includes(pageOrigin.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(pageOrigin.hostname));
  if (persistentMac) {
    try {
      const previousHost = sessionStorage.getItem(HOST_KEY);
      const saved = JSON.parse(sessionStorage.getItem('dsh-unified-selection-by-host') || '{}');
      const pending = JSON.parse(sessionStorage.getItem('dsh-unified-pending-selection') || 'null');
      if (saved.mac && typeof saved.mac.sessionId === 'string' && saved.mac.sessionId.length > 0) localStorage.setItem('dsh.sessions.current', JSON.stringify(saved.mac));
      else if (validHostId(previousHost, false) && !(pending?.host === 'mac' && typeof pending.sessionId === 'string')) throw new Error('missing saved local session');
      sessionStorage.setItem(HOST_KEY, 'mac');
      if (validHostId(pending?.host, false)) sessionStorage.removeItem('dsh-unified-pending-selection');
      w.__DSH_UNIFIED_PERSISTENT_LOCAL__ = true;
    } catch { throw new Error('无法恢复本机原会话，已停止初始化；请允许本地存储后重试。'); }
  }
  // Resolve an explicit catalog click before the native workspace service reads
  // its selection. Keep each window's selections separate from other windows
  // that share the original application's localStorage key.
  const pendingKey = 'dsh-unified-pending-selection';
  const selectionsKey = 'dsh-unified-selection-by-host';
  const nativeSelectionKey = 'dsh.sessions.current';
  const validSelection = value => value && typeof value === 'object'
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && value.sessionId.length <= 512;
  let pendingNavigation = false;
  try {
    const savedHost = sessionStorage.getItem(HOST_KEY);
    const host = validHostId(savedHost) ? savedHost : 'mac';
    let selections = {};
    try {
      const saved = JSON.parse(sessionStorage.getItem(selectionsKey) || '{}');
      for (const name of Object.keys(saved || {})) {
        if (validHostId(name) && validSelection(saved?.[name])) selections[name] = saved[name];
      }
    } catch {}
    let pending;
    const rawPending = sessionStorage.getItem(pendingKey);
    if (rawPending) {
      try { pending = JSON.parse(rawPending); } catch {}
      if (!validHostId(pending?.host) || !validSelection(pending)) {
        sessionStorage.removeItem(pendingKey);
        pending = undefined;
      }
    }
    if (pending) {
      pendingNavigation = true;
      const selection = { sessionId: pending.sessionId };
      selections[pending.host] = selection;
      sessionStorage.setItem(selectionsKey, JSON.stringify(selections));
      localStorage.setItem(nativeSelectionKey, JSON.stringify(selection));
      sessionStorage.setItem(HOST_KEY, pending.host);
      sessionStorage.removeItem(pendingKey);
      w.__DSH_UNIFIED_NAVIGATION__ = { applied: true, host: pending.host };
    } else if (validSelection(selections[host])) {
      localStorage.setItem(nativeSelectionKey, JSON.stringify(selections[host]));
    }
  } catch {
    // A partially committed navigation must never initialize a workspace on
    // the other host. The Host's existing agents keep running independently.
    if (pendingNavigation) throw new Error('无法保存所选工作区，请允许此页面使用本地存储后重试。');
  }
  let selectedHost = 'mac';
  try { const saved = sessionStorage.getItem(HOST_KEY); if (validHostId(saved)) selectedHost = saved; } catch {}
  const gpu = selectedHost !== 'mac';
  if (!gpu || w.__DSH_UNIFIED_REMOTE_BOOT__) return;
  w.__DSH_BOOT__ = filterClientGraph(w.__DSH_BOOT__, allowedClientIds);
  const transport = w.__DSH_TRANSPORT__ || {};
  const originalFetch = w.fetch.bind(w);
  const originalSocket = w.WebSocket;
  const pageBase = document.baseURI;
  const pageUrl = new URL(pageBase);
  const networkPhone = ['http:', 'https:'].includes(pageUrl.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(pageUrl.hostname);
  const socketBase = new URL(transport.streamBaseUrl || pageBase);
  const route = raw => routeUrl(raw, pageBase, selectedHost);
  const routedFetch = async (input, init) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    let body = init?.body;
    if (body === undefined && input instanceof Request
        && /\/api\/settings\/(mutate|update|replace)$/.test(new URL(raw, pageBase).pathname)) {
      try { body = await input.clone().text(); } catch {}
    }
    let mapped = appearanceRoute(raw, pageBase, body, selectedHost) || route(raw), options = init;
    const url = new URL(mapped, pageBase);
    if (networkPhone && url.host === pageUrl.host && url.protocol === pageUrl.protocol
        && (url.pathname.startsWith(hostApiPrefix(selectedHost) + '/') || url.pathname.startsWith('/remote' + hostApiPrefix(selectedHost) + '/'))) {
      if (url.pathname.startsWith('/api/')) url.pathname = '/remote' + url.pathname;
      mapped = url.href;
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      let device;
      try { device = sessionStorage.getItem('dsh-remote-device'); } catch {}
      if (device && /^[A-Za-z0-9_-]{16,256}$/.test(device)) headers.set('x-dsh-remote-device', device);
      options = { ...init, headers, credentials: 'same-origin' };
    }
    const response = originalFetch(input instanceof Request && mapped !== raw ? new Request(mapped, input) : mapped === raw ? input : mapped, options);
    return isGraphStream(raw, pageBase) ? Promise.resolve(response).then(value => filterGraphResponse(value, allowedClientIds)) : response;
  };
  function socketUrl(raw) {
    const url = new URL(raw, socketBase);
    if (url.host !== socketBase.host || !['ws:', 'wss:'].includes(url.protocol)) return raw;
    const path = url.pathname.startsWith('/remote/') ? url.pathname.slice('/remote'.length) : url.pathname;
    if (path === '/api/remote.mux') {
      let device;
      try { device = sessionStorage.getItem('dsh-remote-device'); } catch {}
      const path = muxPath(url.pathname + url.search, device, selectedHost);
      return new URL(path, url).href;
    }
    if (['/api/', '/sidebar/', '/git/'].some(prefix => path.startsWith(prefix))) throw new Error('当前远端主机不使用本机的插件终端连接。');
    return raw;
  }
  w.fetch = routedFetch;
  w.WebSocket = function(url, protocols) { return protocols === undefined ? new originalSocket(socketUrl(url)) : new originalSocket(socketUrl(url), protocols); };
  w.WebSocket.prototype = originalSocket.prototype;
  Object.setPrototypeOf(w.WebSocket, originalSocket);
  if (w.EventSource) {
    const originalEventSource = w.EventSource;
    w.EventSource = function(url, options) {
      const source = new originalEventSource(route(String(url)), options);
      return isGraphStream(String(url), pageBase) ? routeGraphEvents(source, allowedClientIds, w.MessageEvent) : source;
    };
    w.EventSource.prototype = originalEventSource.prototype;
    Object.setPrototypeOf(w.EventSource, originalEventSource);
  }
  // This script executes through official index-inject before the Desktop or
  // browser resolves BOOT_READY and creates any Client Context.
  w.__DSH_TRANSPORT__ = { ...transport, rpc: undefined, openStream: undefined,
    fetch: routedFetch, createWebSocket: input => new w.WebSocket(input), ownsHost: true };
  w.__DSH_FILE_UPLOAD__ = { ...w.__DSH_FILE_UPLOAD__, fetch: routedFetch };
  installResourceRouting(w, route);
  w.__DSH_UNIFIED_REMOTE_BOOT__ = { version: 1, selectedHost, beforeClientContext: true };
})();
