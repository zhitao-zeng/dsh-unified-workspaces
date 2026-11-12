// Read-only catalog aggregation. Each row retains its source Host identity;
// no catalog operation creates a Workspace or resumes an Agent.
import { validateOrigin } from './config.js';
const STREAM_ID = 'unified-catalog-workspaces';

function interrupted() { return new Error('Catalog read cancelled'); }
function unavailable() { return new Error('Catalog unavailable'); }

function waitForSignal(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(interrupted());
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(interrupted());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function sessions(value) {
  const items = value?.items;
  if (!Array.isArray(items) || !items.every(item => item && typeof item.sessionId === 'string'
      && item.sessionId.length > 0 && typeof item.agentAvailable === 'boolean')
      || new Set(items.map(item => item.sessionId)).size !== items.length) throw unavailable();
  return items;
}

function workspaces(value) {
  if (!value || !Array.isArray(value.items) || !Array.isArray(value.archivedSessionIds)
      || !Array.isArray(value.pinnedSessionIds)
      || !value.archivedSessionIds.every(id => typeof id === 'string')
      || !value.pinnedSessionIds.every(id => typeof id === 'string')
      || !value.items.every(item => item && typeof item.workspaceId === 'string'
        && item.workspaceId.length > 0 && typeof item.path === 'string'
        && typeof item.title === 'string' && Array.isArray(item.sessionIds)
        && item.sessionIds.every(id => typeof id === 'string'))
      || new Set(value.items.map(item => item.workspaceId)).size !== value.items.length) throw unavailable();
  return { workspaces: value.items, archivedSessionIds: value.archivedSessionIds, pinnedSessionIds: value.pinnedSessionIds };
}

/** Public in-process Gateway calls; only this catalog's Peer and stream end. */
export async function readLocalCatalog({ connection, gateway, signal }) {
  const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
  const streamControl = new AbortController();
  const streamSignal = AbortSignal.any([signal, streamControl.signal]);
  let iterator;
  try {
    const list = await waitForSignal(gateway.invoke({
      namespace: 'session', method: 'list', args: { _request: {} }, peer, signal,
    }), signal);
    const source = await waitForSignal(gateway.stream({
      namespace: 'workspace', method: 'follow', args: {}, peer, signal: streamSignal,
    }), streamSignal);
    iterator = source[Symbol.asyncIterator]();
    const first = await waitForSignal(iterator.next(), streamSignal);
    if (first.done || first.value?.type !== 'baseline') throw unavailable();
    return { items: sessions(list), ...workspaces(first.value.value) };
  } finally {
    streamControl.abort();
    try { await iterator?.return?.(); } finally { await peer.dispose(); }
  }
}

/** A private, short-lived WS connection reads exactly one Workspace baseline. */
export function readRemoteWorkspaces({ origin, cookie, WebSocketImpl, signal }) {
  return new Promise((resolve, reject) => {
    let socket, settled = false, force;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      const close = () => {
        clearTimeout(force);
        error ? reject(unavailable()) : resolve(value);
      };
      if (!socket) return close();
      force = setTimeout(() => { try { socket.terminate(); } catch {} close(); }, 250);
      force.unref?.();
      socket.once('close', close);
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'cancel', streamId: STREAM_ID }));
          socket.close();
        } else if (socket.readyState === 3) close();
        else socket.terminate();
      } catch { try { socket.terminate(); } catch {} close(); }
    };
    const abort = () => finish(true);
    if (signal.aborted) return finish(true);
    signal.addEventListener('abort', abort, { once: true });
    try {
      socket = new WebSocketImpl(origin.replace(/^http:/, 'ws:') + '/api/remote.mux', {
        headers: { cookie, origin: origin, 'sec-fetch-site': 'same-origin' },
        handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024,
        perMessageDeflate: false, followRedirects: false,
      });
      socket.on('error', () => finish(true));
      socket.on('unexpected-response', (_request, response) => { response.resume(); finish(true); });
      socket.on('close', () => { if (!settled) finish(true); });
      socket.once('open', () => {
        if (settled || signal.aborted) return finish(true);
        socket.send(JSON.stringify({ type: 'open', streamId: STREAM_ID,
          endpoint: 'workspace/follow', payload: { args: {} } }));
      });
      socket.on('message', raw => {
        if (settled) return;
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.streamId !== STREAM_ID) return;
          if (frame.type === 'end' || frame.type === 'error') return finish(true);
          if (frame.type !== 'item') return;
          if (frame.value?.type !== 'baseline') return finish(true);
          finish(false, workspaces(frame.value.value));
        } catch { finish(true); }
      });
    } catch { finish(true); }
  });
}

/**
 * Extract `__DSH_BOOT__.release` from a Host's HTML without executing it.
 * Returns { version, commit? } or null when the page does not expose a release.
 */
export function bootReleaseOf(html) {
  const text = String(html || '');
  const marker = text.indexOf('__DSH_BOOT__');
  if (marker < 0) return null;
  const start = text.indexOf('{', marker);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { depth += 1; continue; }
    if (ch !== '}') continue;
    depth -= 1;
    if (depth !== 0) continue;
    let value;
    try { value = JSON.parse(text.slice(start, index + 1)); } catch { return null; }
    const release = value && value.release;
    if (!release || typeof release !== 'object' || typeof release.version !== 'string' || !release.version) return null;
    return { version: release.version, ...(typeof release.commit === 'string' && release.commit ? { commit: release.commit } : {}) };
  }
  return null;
}

/** Read the remote Host's release for the second-tree gate; unknown is not an error. */
async function readRemoteRelease({ origin, cookie, fetchImpl, signal }) {
  try {
    const response = await fetchImpl(origin + '/', { method: 'GET', redirect: 'error', signal,
      headers: { cookie, origin, accept: 'text/html' } });
    if (response.status !== 200) return null;
    return bootReleaseOf(await response.text());
  } catch { return null; }
}

export async function readRemoteCatalog({ origin, credential, fetchImpl = fetch, WebSocketImpl, signal }) {
  const cookie = await waitForSignal(credential(), signal);
  signal.throwIfAborted();
  const [list, workspace, release] = await Promise.all([
    (async () => {
      const response = await fetchImpl(origin + '/api/session/list', {
        method: 'POST', redirect: 'error', signal,
        headers: { cookie, origin: origin, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'unified-catalog',
          method: 'session/list', payload: { args: { _request: {} } } }),
      });
      if (response.status !== 200) throw unavailable();
      const envelope = await response.json();
      if (envelope?.result?.ok !== true) throw unavailable();
      return sessions(envelope.result.value);
    })(),
    readRemoteWorkspaces({ origin, cookie, WebSocketImpl, signal }),
    readRemoteRelease({ origin, cookie, fetchImpl, signal }),
  ]);
  // 版本未知（拿不到 release）就只给列表；客户端据此回退 iframe。
  return { items: list, ...workspace, ...(release === null ? {} : { release }) };
}

function emptyHost(id, label, extra = {}) {
  return { id, label, status: 'offline', ...extra, workspaces: [], items: [], archivedSessionIds: [], pinnedSessionIds: [],
    message: label + ' 暂时不可用，请稍后重试。' };
}

/** An authenticated, GET-only snapshot independent of the selected UI Host. */
export function createCatalogHandler({ authorize, connection, gateway, remotes = [], WebSocketImpl,
  fetchImpl = fetch, timeoutMs = 15_000 }) {
  remotes = remotes.map(host => ({ ...host, origin: validateOrigin(host.origin) }));
  const active = new Set();
  let disposed = false;
  const handler = async (req, res) => {
    const control = new AbortController();
    active.add(control);
    const abort = () => control.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    const send = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    try {
      if (disposed) { req.resume(); return send(503, { ok: false, message: '工作区列表暂时不可用。' }); }
      let allowed = false;
      try { allowed = await authorize(req); } catch {}
      req.resume();
      if (!allowed) return send(403, { ok: false, message: '需要已配对设备或本机授权。' });
      if (req.method !== 'GET') return send(405, { ok: false, message: '目录只支持读取。' });
      if (control.signal.aborted) return;
      const host = async (id, label, read, extra) => {
        const lifetime = new AbortController();
        const signal = AbortSignal.any([control.signal, lifetime.signal]);
        const timer = setTimeout(() => lifetime.abort(), timeoutMs);
        timer.unref?.();
        try {
          const value = await waitForSignal(read(signal), signal);
          return { id, label, status: 'ready', ...(extra || {}), ...value };
        } catch { return emptyHost(id, label, extra); }
        finally { clearTimeout(timer); lifetime.abort(); }
      };
      const hosts = await Promise.all([
        host('mac', '本机', signal => readLocalCatalog({ connection, gateway, signal })),
        ...remotes.map(remote => host(remote.id, remote.label, signal =>
          readRemoteCatalog({ origin: remote.origin, credential: remote.credential, fetchImpl, WebSocketImpl, signal }),
          { remoteTree: remote.remoteTree === true })),
      ]);
      if (!control.signal.aborted) send(200, { ok: true, hosts });
    } finally {
      control.abort();
      req.off('aborted', abort);
      res.off('close', abort);
      active.delete(control);
    }
  };
  handler.close = () => {
    disposed = true;
    for (const control of active) control.abort();
    active.clear();
  };
  return handler;
}
