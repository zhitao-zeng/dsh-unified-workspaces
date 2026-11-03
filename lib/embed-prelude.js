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
  const boot = w.__DSH_EMBED_BOOT__;
  if (!boot || typeof boot.grant !== 'string' || typeof boot.sessionId !== 'string' || boot.frameOrigin !== w.location.origin) throw new Error('远程工作区启动授权无效。');
  const ownOrigin = boot.frameOrigin;
  const grantUrl = raw => {
    const url = new URL(String(raw), document.baseURI);
    if (url.origin === ownOrigin || (url.protocol === 'ws:' && ownOrigin === 'http://' + url.host) || (url.protocol === 'wss:' && ownOrigin === 'https://' + url.host)) {
      // Preserve combo loader URLs such as /plugins/??pkg1,pkg2 byte for byte.
      // URLSearchParams would serialize their second '?' and separators.
      const parts = url.search.slice(1).split('&').filter(part => {
        try { return decodeURIComponent(part.split('=', 1)[0]) !== 'dsh_embed_grant'; } catch { return true; }
      });
      const query = parts.join('&');
      url.search = '?' + (query ? query + '&' : '') + 'dsh_embed_grant=' + encodeURIComponent(boot.grant);
    }
    return url.href;
  };
  const originalFetch = w.fetch.bind(w);
  const routedFetch = async function(input, init) {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, document.baseURI);
    if (url.origin !== ownOrigin) return originalFetch(input, init);
    let body = init?.body;
    if (body === undefined && input instanceof Request && /\/api\/settings\/(mutate|update|replace)$/.test(url.pathname)) { try { body = await input.clone().text(); } catch {} }
    const mapped = appearanceRoute(raw, document.baseURI, body, boot.hostId) || raw;
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('x-dsh-embed-grant', boot.grant);
    return originalFetch(input instanceof Request && mapped !== raw ? new Request(mapped, input) : mapped === raw ? input : mapped, { ...init, headers });
  };
  w.fetch = routedFetch;
  const OriginalSocket = w.WebSocket;
  if (OriginalSocket) {
    w.WebSocket = function(url, protocols) { return protocols === undefined ? new OriginalSocket(grantUrl(url)) : new OriginalSocket(grantUrl(url), protocols); };
    w.WebSocket.prototype = OriginalSocket.prototype; Object.setPrototypeOf(w.WebSocket, OriginalSocket);
  }
  const OriginalEvents = w.EventSource;
  if (OriginalEvents) {
    w.EventSource = function(url, options) { return new OriginalEvents(grantUrl(url), options); };
    w.EventSource.prototype = OriginalEvents.prototype; Object.setPrototypeOf(w.EventSource, OriginalEvents);
  }
  w.__DSH_TRANSPORT__ = { ...w.__DSH_TRANSPORT__, rpc: undefined, openStream: undefined, streamBaseUrl: w.location.href, fetch: routedFetch, createWebSocket: input => new w.WebSocket(input), ownsHost: true };
  w.__DSH_FILE_UPLOAD__ = { ...w.__DSH_FILE_UPLOAD__, fetch: routedFetch };
  installResourceRouting(w, grantUrl);
  for (const [name, property] of [['HTMLScriptElement', 'src'], ['HTMLLinkElement', 'href']]) {
    const prototype = w[name]?.prototype;
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, property);
    if (descriptor?.set && descriptor.configurable !== false) Object.defineProperty(prototype, property, { ...descriptor, set(value) { descriptor.set.call(this, grantUrl(String(value))); } });
  }
  // Seed only an already-known Host session before Client Context construction.
  // The child has its own origin/storage; no remote id reaches the local controller.
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: boot.sessionId }));
  w.__DSH_UNIFIED_EMBED_PRELUDE__ = { ready: true, frameId: boot.frameId };
})();
