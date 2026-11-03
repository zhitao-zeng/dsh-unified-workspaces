// Pure browser routing helpers, shared by the bundle and isolated checks.
export const HOST_KEY = 'dsh-unified-host';
export const API_PREFIX = '/api/dsh-unified';
export function validHostId(value, allowLocal = true) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value) && (allowLocal || value !== 'mac');
}
export function hostApiPrefix(hostId) {
  if (!validHostId(hostId, false)) throw new Error('远端主机标识无效。');
  return API_PREFIX + '/hosts/' + hostId;
}
export function nativeHttpPrefix(hostId) { return hostApiPrefix(hostId) + '/native'; }
export function absoluteWorkspacePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
    && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
}
const LOCAL = ['/api/pair', '/api/update', '/api/plugin-manager', API_PREFIX, '/api/dsh-web-ui-settings'];

// The App owns appearance and language. Model, credentials and every other
// settings namespace continue to belong to the selected execution Host.
export function appearanceRoute(raw, base, body, hostId) {
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

export function filterClientGraph(graph, ids) {
  const allowed = new Set(ids);
  if (!Array.isArray(graph?.entries) || !Array.isArray(graph?.batches)) throw new Error('远端 界面模块清单无效。');
  const entries = graph.entries.filter(entry => allowed.has(entry.id));
  const active = new Set(entries.map(entry => entry.id));
  const batches = graph.batches.map(batch => ({ ...batch, entries: batch.entries.filter(id => active.has(id)) })).filter(batch => batch.entries.length > 0);
  return { ...graph, rev: graph.rev + '-dsh-unified-client', entries, batches };
}

export function filterGraphEvent(event, ids, EventType = MessageEvent) {
  let value;
  try { value = JSON.parse(event.data); } catch { return event; }
  if (value.type === 'graph') value.graph = filterClientGraph(value.graph, ids);
  else if (value.type === 'rebuilt' && !ids.includes(value.id)) return null;
  else return event;
  return new EventType('message', { data: JSON.stringify(value), origin: event.origin, lastEventId: event.lastEventId });
}

export function isGraphStream(raw, base) {
  try {
    const url = new URL(raw, base), page = new URL(base);
    return url.protocol === page.protocol && url.host === page.host && ['/plugins/events', '/remote/plugins/events'].includes(url.pathname);
  } catch { return false; }
}

export function filterGraphResponse(response, ids) {
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

export function routeGraphEvents(source, ids, EventType) {
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

export function routeUrl(raw, base, hostId) {
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

export function muxPath(path, device, hostId) {
  if (!validHostId(hostId, false)) throw new Error('远端主机标识无效。');
  const url = new URL(path, 'http://127.0.0.1');
  if (!['/api/remote.mux', '/remote/api/remote.mux'].includes(url.pathname)) return path;
  const mapped = new URL('/dsh-unified/hosts/' + hostId + '/remote.mux', url);
  if (device && /^[A-Za-z0-9_-]{16,256}$/.test(device)) mapped.searchParams.set('device', device);
  return mapped.pathname + mapped.search;
}

export function installResourceRouting(win, route) {
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
