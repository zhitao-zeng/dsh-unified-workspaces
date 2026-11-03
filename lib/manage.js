// Explicit Workspace/Session management over configured Hosts. No model,
// prompt, terminal, arbitrary RPC, or SSH operation is accepted here.
import { validateOrigin } from './config.js';
const WRITES = new Set(['workspace-create', 'session-create', 'directory-create']);
const ACTIONS = new Set(['directories', ...WRITES]);
const MAX_BODY = 16 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
const absolutePath = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
  && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));

class Failure extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message); this.code = code; this.status = status; this.details = details;
  }
}
function invalid() { return new Failure('management/invalid-request', '管理请求无效，请检查所选主机、目录和工作区。'); }
function interrupted() { return new Failure('management/cancelled', '读取已取消，请重新打开目录。', 408); }
function withAbort(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(interrupted()); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(interrupted());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function uncertain(input, action) {
  return new Failure('management/result-uncertain', '操作结果尚未确认。请先刷新工作区和会话列表核对，不要重复创建。', 504,
    { host: input.host, action, requestId: input.requestId });
}
function remoteFailure(error, input, action, started) {
  if (error instanceof Failure && error.code !== 'management/cancelled') return error;
  let code;
  try {
    if (record(error) && error.isDSHRemoteError === true && typeof error.code === 'string'
        && error.code.length <= 128 && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(error.code)) code = error.code;
  } catch {}
  if (code === 'session/workspace-attach-failed') {
    const details = {};
    if (identity(error.details?.sessionId)) details.sessionId = error.details.sessionId;
    if (identity(error.details?.workspaceId)) details.workspaceId = error.details.workspaceId;
    details.host = input.host; details.action = action; details.requestId = input.requestId;
    return new Failure(code, '会话已创建，但未能加入工作区。请刷新列表并打开已创建的会话，请勿重复创建。', 409, details);
  }
  const known = {
    'directory-picker/unavailable': ['这台主机暂不支持目录浏览，请直接填写绝对路径。', 409],
    'directory-picker/unreadable': ['无法读取此目录，请检查路径和访问权限。', 400],
    'directory-picker/exists': ['同名目录已经存在，请选择现有目录或更换名称。', 409],
    'directory-picker/create-failed': ['目录创建失败，请检查父目录和访问权限。', 400],
    'workspace/invalid-path': ['无法使用此目录，请检查绝对路径和访问权限。', 400],
    'workspace/not-found': ['所选工作区已不可用，请刷新列表后重新选择。', 404],
    'remote-access/denied': ['当前授权不足以操作此工作区。', 403],
    'gateway/bad-request': ['请求参数无效，请检查目录和工作区。', 400],
    'gateway/arguments-invalid': ['请求参数无效，请检查目录和工作区。', 400],
    'gateway/input-invalid': ['请求参数无效，请检查目录和工作区。', 400],
    'gateway/service-unavailable': ['所选主机的管理服务暂时不可用，请刷新列表。', 503],
  };
  if (known[code]) return new Failure(code, ...known[code]);
  if (WRITES.has(action) && started) return uncertain(input, action);
  if (error instanceof Failure) return error;
  return new Failure(code || 'management/unavailable', '所选主机暂时不可用，请稍后重试。', 503);
}
function errorBody(error) {
  return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
}
function parseInput(value, action, allowedHosts) {
  if (!record(value) || !allowedHosts.has(value.host)) throw invalid();
  const fields = action === 'directories' ? ['host', 'path']
    : action === 'workspace-create' ? ['host', 'path', 'requestId']
      : action === 'session-create' ? ['host', 'workspaceId', 'requestId']
        : ['host', 'path', 'name', 'requestId'];
  if (Object.keys(value).some(key => !fields.includes(key))) throw invalid();
  const input = { host: value.host };
  if (WRITES.has(action)) {
    if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.requestId)) throw invalid();
    input.requestId = value.requestId;
  }
  if (action !== 'session-create' && value.path !== undefined) {
    if (!absolutePath(value.path)) throw invalid();
    input.path = value.path;
  }
  if (['workspace-create', 'directory-create'].includes(action) && input.path === undefined) throw invalid();
  if (action === 'session-create') {
    if (!identity(value.workspaceId)) throw invalid();
    input.workspaceId = value.workspaceId;
  }
  if (action === 'directory-create') {
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255
        || value.name.includes('/') || value.name.includes('\\') || value.name.includes('\0') || ['.', '..'].includes(value.name)) throw invalid();
    input.name = value.name;
  }
  return input;
}
function invocation(input, action) {
  if (action === 'directories') return { namespace: 'directoryPicker', method: 'list', args: input.path === undefined ? {} : { path: input.path } };
  if (action === 'workspace-create') return { namespace: 'workspace', method: 'create', args: { request: { path: input.path } } };
  if (action === 'session-create') return { namespace: 'session', method: 'create', args: { request: { workspaceId: input.workspaceId } } };
  return { namespace: 'directoryPicker', method: 'createDirectory', args: { path: input.path, name: input.name } };
}
function nativeValue(value, action) {
  if (action === 'session-create') {
    if (!record(value) || !identity(value.sessionId) || value.agentPreset !== undefined && typeof value.agentPreset !== 'string') throw new Error('Invalid Session result');
    return { sessionId: value.sessionId, ...value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset } };
  }
  if (action === 'directory-create') { if (!absolutePath(value)) throw new Error('Invalid directory result'); return value; }
  if (action === 'workspace-create') {
    const w = value?.workspace;
    if (!record(value) || typeof value.created !== 'boolean' || !record(w) || !identity(w.workspaceId)
        || !absolutePath(w.path) || typeof w.title !== 'string' || !Array.isArray(w.sessionIds)
        || !w.sessionIds.every(identity) || typeof w.createdAt !== 'string' || typeof w.updatedAt !== 'string') throw new Error('Invalid Workspace result');
    return { workspace: { workspaceId: w.workspaceId, path: w.path, title: w.title,
      sessionIds: w.sessionIds, createdAt: w.createdAt, updatedAt: w.updatedAt }, created: value.created };
  }
  const entry = row => record(row) && typeof row.name === 'string' && absolutePath(row.path) && typeof row.hidden === 'boolean';
  if (!record(value) || !absolutePath(value.path) || !absolutePath(value.home) || !Array.isArray(value.crumbs)
      || !Array.isArray(value.entries) || !value.crumbs.every(entry) || !value.entries.every(entry)
      || typeof value.truncated !== 'boolean') throw new Error('Invalid directory listing');
  return { path: value.path, home: value.home, crumbs: value.crumbs, entries: value.entries, truncated: value.truncated };
}
async function bytes(req, signal) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    signal.throwIfAborted(); length += chunk.length;
    if (length > MAX_BODY) throw invalid();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Only explicitly named operations can reach either Host. Writes are never retried. */
export function createManagementHandler({ authorize, connection, gateway, remotes = [], fetchImpl = fetch,
  timeoutMs = 60_000, readTimeoutMs = 15_000, dedupeTtlMs = 10 * 60_000, maxRequests = 128, now = Date.now }) {
  const remoteHosts = new Map(remotes.map(host => [host.id, { ...host, origin: validateOrigin(host.origin) }]));
  const allowedHosts = new Set(['mac', ...remoteHosts.keys()]);
  let disposed = false;
  const active = new Set();
  const requests = new Map();
  async function call(input, action, signal, state) {
    const request = invocation(input, action);
    let value;
    if (input.host === 'mac') {
      const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
      try {
        signal.throwIfAborted(); state.started = true;
        value = await withAbort(gateway.invoke({ ...request, peer, signal }), signal);
      } finally { await peer.dispose(); }
    } else {
      const remote = remoteHosts.get(input.host);
      if (!remote) throw invalid();
      const cookie = await withAbort(remote.credential(), signal);
      signal.throwIfAborted();
      const method = request.namespace + '/' + request.method;
      const rpcId = 'unified-management-' + action;
      state.started = true;
      const response = await withAbort(fetchImpl(remote.origin + '/api/' + method, {
        method: 'POST', redirect: 'error', signal,
        headers: { cookie, origin: remote.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
      }), signal);
      if ([401, 403].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw new Failure('management/unauthorized', '所选主机的授权暂时不可用，请刷新后再操作。', 403);
      }
      const text = await withAbort(response.text(), signal);
      if (text.length > MAX_RESPONSE) throw new Error('Management result unavailable');
      const envelope = JSON.parse(text);
      if (response.status !== 200 || envelope?.type !== 'server-response' || envelope.rpcId !== rpcId
          || !record(envelope.result)) throw new Error('Management result unavailable');
      if (envelope.result.ok !== true) {
        const remote = envelope.result.error;
        throw { isDSHRemoteError: true, code: remote?.code, details: remote?.details };
      }
      value = envelope.result.value;
    }
    return nativeValue(value, action);
  }
  function start(input, action, parentSignal) {
    if (disposed) return Promise.resolve({ status: 503,
      body: errorBody(new Failure('management/unavailable', '管理服务暂时不可用。', 503)) });
    const lifetime = new AbortController(); active.add(lifetime);
    const signal = parentSignal ? AbortSignal.any([parentSignal, lifetime.signal]) : lifetime.signal;
    const timer = setTimeout(() => lifetime.abort(), WRITES.has(action) ? timeoutMs : readTimeoutMs);
    timer.unref?.();
    const state = { started: false };
    return (async () => {
      try { return { status: 200, body: { ok: true, value: await withAbort(call(input, action, signal, state), signal) } }; }
      catch (error) {
        const failure = remoteFailure(error, input, action, state.started);
        return { status: failure.status, body: errorBody(failure) };
      } finally { clearTimeout(timer); lifetime.abort(); active.delete(lifetime); }
    })();
  }
  function operation(input, action) {
    for (const [key, entry] of requests) if (entry.settled && entry.until <= now()) requests.delete(key);
    const key = input.host + ':' + action + ':' + input.requestId;
    const fingerprint = JSON.stringify(invocation(input, action));
    const existing = requests.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Failure('management/request-conflict', '同一请求标识对应了不同内容，请重新打开表单。', 409);
      return existing.promise;
    }
    if (requests.size >= maxRequests) throw new Failure('management/busy', '管理请求较多，请稍后再试。', 429);
    const entry = { fingerprint, settled: false, until: Infinity };
    // Install the entry before invoking either Host, including synchronous adapters.
    requests.set(key, entry);
    entry.promise = Promise.resolve().then(() => start(input, action)).then(result => {
      entry.settled = true; entry.until = now() + dedupeTtlMs; return result;
    });
    return entry.promise;
  }
  const handler = async (action, req, res) => {
    const lifetime = new AbortController();
    const abort = () => lifetime.abort();
    req.once('aborted', abort); res.once('close', abort);
    const bodyTimer = setTimeout(abort, readTimeoutMs); bodyTimer.unref?.();
    const send = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    try {
      if (disposed) { req.resume(); return send(503, errorBody(new Failure('management/unavailable', '管理服务暂时不可用。', 503))); }
      let authorized = false;
      try { authorized = await withAbort(authorize(req), lifetime.signal); } catch {}
      if (!authorized) { req.resume(); return send(403, errorBody(new Failure('management/unauthorized', '需要已配对设备或本机授权。', 403))); }
      if (!ACTIONS.has(action) || req.method !== 'POST') { req.resume(); return send(405, errorBody(new Failure('management/method-not-allowed', '管理操作只接受明确提交的请求。', 405))); }
      if (String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        req.resume(); return send(415, errorBody(invalid()));
      }
      let input;
      try { input = parseInput(JSON.parse((await withAbort(bytes(req, lifetime.signal), lifetime.signal)).toString('utf8')), action, allowedHosts); }
      catch { req.resume(); return send(400, errorBody(invalid())); }
      clearTimeout(bodyTimer);
      if (lifetime.signal.aborted) return;
      try {
        // A disconnected HTTP client does not replay or roll back a dispatched
        // write. Its requestId can retrieve the same recorded result later.
        const result = await withAbort(WRITES.has(action) ? operation(input, action) : start(input, action, lifetime.signal), lifetime.signal);
        if (!lifetime.signal.aborted) send(result.status, result.body);
      } catch (error) {
        if (!lifetime.signal.aborted) {
          const failure = error instanceof Failure ? error : new Failure('management/unavailable', '管理服务暂时不可用。', 503);
          send(failure.status, errorBody(failure));
        }
      }
    } finally {
      clearTimeout(bodyTimer); lifetime.abort(); req.off('aborted', abort); res.off('close', abort);
    }
  };
  handler.close = () => { disposed = true; for (const lifetime of active) lifetime.abort(); active.clear(); };
  return handler;
}
