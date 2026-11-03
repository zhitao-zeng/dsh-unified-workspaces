(() => {
  /* ROUTING_HELPERS */
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
