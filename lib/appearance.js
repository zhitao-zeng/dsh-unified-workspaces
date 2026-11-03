// Keep this App's appearance on its owning Mac while the selected workspace
// continues to use the remote Host's model, credential and execution settings.
import { validateOrigin } from './config.js';
const UI_NAMESPACES = new Set(['ui-theme', 'locale']);
const ACTIONS = new Set(['describe', 'mutate', 'update', 'replace']);
const MAX_BODY = 128 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function failed(code = 'gateway/internal', message = '外观设置暂时无法读取，请稍后重试。', details = {}) {
  return { ok: false, error: { code, message, details } };
}
function cancelled() { return failed('gateway/cancelled', '外观设置请求已取消，请刷新后重试。'); }

// Same structural RemoteError discriminator and wire fields as the pinned
// official Gateway's rpcFailure. Unknown exceptions never cross the boundary.
export function localFailure(error) {
  try {
    if (record(error) && error.isDSHRemoteError === true && typeof error.code === 'string'
        && typeof error.message === 'string' && error.code.length <= 128 && error.message.length <= 8192) {
      const details = JSON.stringify(error.details ?? {});
      if (details.length <= MAX_BODY) return failed(error.code, error.message, JSON.parse(details));
    }
  } catch {}
  return failed();
}

function validDescribe(value) {
  return record(value) && typeof value.writable === 'boolean' && typeof value.hasDocument === 'boolean'
    && Array.isArray(value.namespaces) && value.namespaces.every(row => record(row)
      && typeof row.ns === 'string' && row.ns.length > 0)
    && new Set(value.namespaces.map(row => row.ns)).size === value.namespaces.length;
}

/** Retain each Host's complete native namespace row, including its own fence. */
export function composeSettings(remote, mac) {
  if (!validDescribe(remote) || !validDescribe(mac)) throw new Error('Settings schema unavailable');
  const localRows = new Map(mac.namespaces.filter(row => UI_NAMESPACES.has(row.ns)).map(row => [row.ns, row]));
  if (localRows.size !== UI_NAMESPACES.size || [...localRows.values()].some(row =>
    typeof row.revision !== 'number' || !Number.isFinite(row.revision))) throw new Error('Appearance schema unavailable');
  const emitted = new Set();
  const namespaces = remote.namespaces.map(row => {
    if (!UI_NAMESPACES.has(row.ns)) return row;
    emitted.add(row.ns);
    return localRows.get(row.ns);
  });
  for (const [ns, row] of localRows) if (!emitted.has(ns)) namespaces.push(row);
  return { ...remote, namespaces };
}

function withAbort(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(new Error('Cancelled')); }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function bodyBytes(req, signal) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMessage(bytes, action) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return; }
  if (!record(value) || value.type !== 'client-request' || typeof value.rpcId !== 'string'
      || value.rpcId.length === 0 || value.rpcId.length > 512 || value.method !== 'settings/' + action
      || !record(value.payload) || !record(value.payload.args)) return;
  const args = value.payload.args;
  if (action === 'describe') return Object.keys(args).length === 0 ? value : undefined;
  const field = action === 'mutate' ? 'ops' : action === 'update' ? 'patch' : 'section';
  if (!UI_NAMESPACES.has(args.ns) || Object.keys(args).some(key => !['ns', field, 'expectedRevision'].includes(key))) return;
  if (action === 'mutate' ? !Array.isArray(args.ops) : !record(args[field])) return;
  if (args.expectedRevision !== undefined && (typeof args.expectedRevision !== 'number' || !Number.isFinite(args.expectedRevision))) return;
  return value;
}

async function readRemoteDescribe({ origin, credential, fetchImpl, signal }) {
  const cookie = await withAbort(credential(), signal);
  signal.throwIfAborted();
  const response = await fetchImpl(origin + '/api/settings/describe', {
    method: 'POST', redirect: 'error', signal,
    headers: { cookie, origin: origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'unified-appearance-describe', method: 'settings/describe', payload: { args: {} } }),
  });
  if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw new Error('Remote settings unavailable'); }
  const text = await response.text();
  if (text.length > MAX_RESPONSE) throw new Error('Settings response too large');
  const envelope = JSON.parse(text);
  if (envelope?.type !== 'server-response' || envelope?.rpcId !== 'unified-appearance-describe'
      || envelope?.result?.ok !== true || !validDescribe(envelope.result.value)) throw new Error('Remote settings unavailable');
  return envelope.result.value;
}

/** Fixed named Gateway calls over a catalog-owned non-interactive Peer. */
async function localCall({ connection, gateway, action, args, signal }) {
  const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
  try {
    return await withAbort(gateway.invoke({ namespace: 'settings', method: action, args, peer, signal }), signal);
  } finally { await peer.dispose(); }
}

/**
 * Own authenticated endpoint family. The browser routes only settings.describe
 * and the two UI namespaces here; other remote requests remain byte-for-byte on
 * the existing native proxy. Every invocation validates both path and method.
 */
export function createAppearanceHandler({ authorize, connection, gateway, credential, origin,
  fetchImpl = fetch, timeoutMs = 15_000 }) {
  origin = validateOrigin(origin);
  let disposed = false;
  let revision = 0;
  const active = new Set();
  const handler = async (action, req, res) => {
    const lifetime = new AbortController();
    active.add(lifetime);
    const signal = lifetime.signal;
    const abort = () => lifetime.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    const timeout = setTimeout(abort, timeoutMs);
    timeout.unref?.();
    const send = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    const answer = (rpcId, result) => send(200, { type: 'server-response', rpcId, result });
    try {
      if (disposed) { req.resume(); return send(503, { ok: false, message: '外观设置暂时不可用。' }); }
      let authorized = false;
      try { authorized = await withAbort(authorize(req), signal); } catch {}
      if (!authorized) { req.resume(); return send(403, { ok: false, message: '需要已配对设备或本机授权。' }); }
      if (action === 'revision') {
        req.resume();
        if (req.method !== 'GET') return send(405, { ok: false, message: '版本只支持读取。' });
        return send(200, { ok: true, revision });
      }
      if (!ACTIONS.has(action) || req.method !== 'POST') { req.resume(); return send(405, { ok: false, message: '不支持此外观设置请求。' }); }
      if (String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        req.resume(); return send(415, { ok: false, message: '请求须使用 JSON。' });
      }
      let bytes;
      try { bytes = await withAbort(bodyBytes(req, signal), signal); } catch { req.resume(); return send(400, { ok: false, message: '外观设置请求无效。' }); }
      const message = parseMessage(bytes, action);
      if (!message) return send(400, { ok: false, message: '外观设置请求无效。' });
      try {
        if (action === 'describe') {
          // Local-only non-appearance rows never leave this operation.
          const [remote, mac] = await Promise.all([
            readRemoteDescribe({ origin, credential, fetchImpl, signal }),
            localCall({ connection, gateway, action: 'describe', args: {}, signal }),
          ]);
          return answer(message.rpcId, { ok: true, value: composeSettings(remote, mac) });
        }
        const value = await localCall({ connection, gateway, action, args: message.payload.args, signal });
        if (!record(value) || value.ns !== message.payload.args.ns || typeof value.revision !== 'number') throw new Error('Appearance result unavailable');
        return answer(message.rpcId, { ok: true, value });
      } catch (error) {
        return answer(message.rpcId, signal.aborted ? cancelled() : localFailure(error));
      }
    } finally {
      clearTimeout(timeout);
      lifetime.abort();
      req.off('aborted', abort);
      res.off('close', abort);
      active.delete(lifetime);
    }
  };
  handler.noteUpdate = ns => { if (!disposed && UI_NAMESPACES.has(ns)) revision += 1; };
  handler.close = () => { disposed = true; for (const lifetime of active) lifetime.abort(); active.clear(); };
  return handler;
}
