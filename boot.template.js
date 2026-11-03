(() => {
  /* ROUTING_HELPERS */
  const w = globalThis;
  try { migrateLegacySelection(w, w.__DSH_UNIFIED_BOOT_CONFIG__); }
  catch { throw new Error('旧版远端选择尚未安全迁移，请核对 legacyHostId 配置后重试。'); }
  const allowedClientIds = /* HOST_CLIENT_IDS */;
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
