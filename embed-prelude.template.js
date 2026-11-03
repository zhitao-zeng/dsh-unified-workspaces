(() => {
  /* ROUTING_HELPERS */
  const w = globalThis;
  const boot = w.__DSH_EMBED_BOOT__;
  if (!boot || typeof boot.grant !== 'string' || typeof boot.sessionId !== 'string' || boot.frameOrigin !== w.location.origin) throw new Error('远程工作区启动授权无效。');
  function normalizeParentLocale(value) {
    const language = item => typeof item === 'string' && item.length <= 64 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,7}$/.test(item);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['active', 'languages'].includes(key))
        || !language(value.active) || !Array.isArray(value.languages) || value.languages.length < 1
        || value.languages.length > 16 || !value.languages.every(language)) return undefined;
    return { active: value.active, languages: [...new Set([value.active, ...value.languages])].slice(0, 16) };
  }
  let parentLocale = normalizeParentLocale(boot.locale);
  if (boot.locale !== undefined && !parentLocale) throw new Error('远程工作区语言无效。');
  const localeListeners = new Set();
  const readLocale = () => parentLocale ? { active: parentLocale.active, languages: [...parentLocale.languages] } : undefined;
  const nativeLocale = Object.freeze({
    // Native initialization is read-only. onChange must not persist the
    // iframe's effective display choice into either Host's preferences.
    read: async () => ({ languages: [...(parentLocale?.languages || [])], preference: parentLocale?.active || null }),
    onChange() {},
    subscribe(listener) { localeListeners.add(listener); return () => localeListeners.delete(listener); },
  });
  const localeBridge = Object.freeze({
    read: readLocale,
    update(value) {
      const next = normalizeParentLocale(value);
      if (!next) throw new Error('远程工作区语言无效。');
      const changed = JSON.stringify(next) !== JSON.stringify(parentLocale);
      parentLocale = next;
      if (changed) for (const listener of [...localeListeners]) listener(readLocale());
      return changed;
    },
  });
  Object.defineProperty(w, '__DSH_UNIFIED_PARENT_LOCALE__', { value: localeBridge });
  if (parentLocale && !('__DSH_LOCALE__' in w)) Object.defineProperty(w, '__DSH_LOCALE__', { value: nativeLocale, configurable: true });
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
  async function projectLocale(response) {
    if (!parentLocale || !response.ok) return response;
    let envelope;
    try { envelope = await response.clone().json(); } catch { return response; }
    if (envelope?.type !== 'server-response' || envelope.result?.ok !== true || !Array.isArray(envelope.result.value?.namespaces)) return response;
    const namespaces = envelope.result.value.namespaces.map(row => row?.ns === 'locale'
      ? { ...row, value: { ...row.value, preference: parentLocale.active } } : row);
    const headers = new Headers(response.headers);
    for (const key of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(key);
    return new Response(JSON.stringify({ ...envelope, result: { ...envelope.result, value: { ...envelope.result.value, namespaces } } }), { status: response.status, statusText: response.statusText, headers });
  }
  const routedFetch = async function(input, init) {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, document.baseURI);
    if (url.origin !== ownOrigin) return originalFetch(input, init);
    let body = init?.body;
    if (body === undefined && input instanceof Request && /\/api\/settings\/(mutate|update|replace)$/.test(url.pathname)) { try { body = await input.clone().text(); } catch {} }
    const mapped = appearanceRoute(raw, document.baseURI, body, boot.hostId) || raw;
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('x-dsh-embed-grant', boot.grant);
    const response = await originalFetch(input instanceof Request && mapped !== raw ? new Request(mapped, input) : mapped === raw ? input : mapped, { ...init, headers });
    return url.pathname === '/api/settings/describe' || url.pathname === hostApiPrefix(boot.hostId) + '/appearance/describe' ? projectLocale(response) : response;
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
