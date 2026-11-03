function createPersistentEmbed({ hostId, fetch: requestFetch, changed, getLocale }) {
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
        const locale = getLocale?.();
        const value = await api('bootstrap', { sessionId, ...(locale ? { locale } : {}) });
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
    appearance(css, locale) { if (ready) request('appearance/reload', { css, ...(locale ? { locale } : {}) }).catch(() => {}); },
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
