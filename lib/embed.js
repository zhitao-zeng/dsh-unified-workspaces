// Local-first persistent remote frame. Each frame owns a different loopback origin,
// independent HTTP/control grants, and only its own requests and observers.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pipeline, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createAppearanceHandler } from './appearance.js';
import { validateOrigin, validHostId, routesForHost } from './config.js';

const GRANT_HEADER = 'x-dsh-embed-grant';
const GRANT_QUERY = 'dsh_embed_grant';
const PRIVATE_QUERY = new Set([GRANT_QUERY, 'device', 'bootstrap', 'control', 'parent']);
const COMPANION_ID = '@zhitao-zeng/dsh-unified-embed-companion';
const COMPANION_PATH = '/_dsh_embed/companion.js';
const ENTRY = { id: COMPANION_ID, url: COMPANION_PATH, rev: '0.5.1', immediately: true,
  inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-api-workspace-controller',
    '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-layout'] };
const BATCH = { phase: 'application', url: COMPANION_PATH, rev: '0.5.1', entries: [COMPANION_ID] };
const PASS = new Set(['content-type', 'content-length', 'accept', 'range', 'if-range', 'if-none-match', 'if-modified-since', 'x-dsh-locale']);
const DROP = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'x-frame-options', 'content-security-policy', 'content-security-policy-report-only']);
const token = () => randomBytes(32).toString('base64url');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sessionId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
const loopback = value => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value);
/** Ephemeral display state only; no settings, paths or executable content. */
export function normalizeParentLocale(value) {
  const language = item => typeof item === 'string' && item.length <= 64
    && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,7}$/.test(item);
  if (!record(value) || Object.keys(value).some(key => !['active', 'languages'].includes(key))
      || !language(value.active) || !Array.isArray(value.languages) || value.languages.length < 1
      || value.languages.length > 16 || !value.languages.every(language)) return undefined;
  return { active: value.active, languages: [...new Set([value.active, ...value.languages])].slice(0, 16) };
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function validParentOrigin(value) {
  if (value === 'dsh-app://app') return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.origin === value; } catch { return false; }
}
export function addCompanion(graph, entry = ENTRY, batch = BATCH) {
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.entries) || !Array.isArray(graph.batches)) throw new Error('Client graph unavailable');
  if (graph.entries.some(row => row.id === entry.id)) return graph;
  return { ...graph, entries: [...graph.entries, entry], batches: [...graph.batches, batch], rev: String(graph.rev || '') + '-embed-0.5.1' };
}
function graphEvents() {
  const decoder = new StringDecoder('utf8'); let buffered = '';
  const frame = source => {
    const lines = source.split(/\r?\n/); const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    try {
      const value = JSON.parse(data);
      if (value.type !== 'graph') return source;
      value.graph = addCompanion(value.graph);
      let replaced = false;
      return lines.filter(line => !line.startsWith('data:') || !replaced && (replaced = true)).map(line => line.startsWith('data:') ? 'data: ' + JSON.stringify(value) : line).join('\n');
    } catch { return source; }
  };
  return new Transform({ transform(chunk, _encoding, done) {
    buffered += decoder.write(chunk); let match;
    while ((match = /\r?\n\r?\n/.exec(buffered))) {
      this.push(frame(buffered.slice(0, match.index)) + '\n\n'); buffered = buffered.slice(match.index + match[0].length);
    }
    done();
  }, flush(done) { buffered += decoder.end(); if (buffered) this.push(frame(buffered)); done(); } });
}
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value));
}
const failure = (res, status) => json(res, status, { ok: false, error: { code: 'embed/unavailable', message: status === 403 ? '远程页面授权无效。' : '远程页面暂时不可用，请重新打开。' } });
function publicStatic(url, method) {
  return method === 'GET' && (publicCombo(url) || url.pathname === '/favicon.ico'
    || ['/assets/', '/plugins/', '/client/'].some(prefix => url.pathname.startsWith(prefix))
      && /\.(?:m?js|css|woff2?|ttf|otf|svg)$/i.test(url.pathname));
}
function queryName(piece) {
  try { return decodeURIComponent(piece.split('=', 1)[0].replace(/\+/g, ' ')); } catch { return; }
}
function publicCombo(url) {
  // DSH's module preloader uses /plugins/??@scope/package/file.js,...&rev=… .
  // The first '?' belongs to its opaque combo syntax, not form-urlencoded data.
  if (url.pathname !== '/plugins/' || !url.search.startsWith('??')) return false;
  const pieces = url.search.slice(2).split('&');
  const files = pieces.shift().split(',');
  if (!files.length || files.length > 256) return false;
  const valid = files.every(raw => {
    let file; try { file = decodeURIComponent(raw); } catch { return false; }
    return /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.(?:m?js|css)$/.test(file)
      && !file.split('/').some(part => part === '.' || part === '..');
  });
  return valid && pieces.every(piece => piece === '' || ['rev', 'v', ...PRIVATE_QUERY].includes(queryName(piece)));
}
function cleanPath(url) {
  if (/%(?:2f|5c|00|2e)/i.test(url.pathname) || url.pathname.includes('\\')) return;
  // Never serialize URLSearchParams here: that converts the native ?? combo
  // and its commas/slashes into a different resource name even with no grant.
  const pieces = url.search ? url.search.slice(1).split('&').filter(piece => !PRIVATE_QUERY.has(queryName(piece))) : [];
  return url.pathname + (pieces.length ? '?' + pieces.join('&') : '');
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024) throw new Error('Request unavailable'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function parentFence(req, origin) {
  let host;
  try { host = new URL('http://' + req.headers.host).hostname; } catch { return false; }
  return loopback(req.socket?.remoteAddress) && ['127.0.0.1', 'localhost', '[::1]'].includes(host)
    && validParentOrigin(origin) && req.headers['x-dsh-embed-parent'] === origin
    && (req.headers.origin === undefined || req.headers.origin === origin)
    && req.headers['sec-fetch-site'] !== 'cross-site';
}
function inline(value) { return JSON.stringify(value).replaceAll('<', '\\u003c'); }

export function createEmbedService({ hostId, origin, authorizeOwner, credential, connection, gateway, WebSocketImpl, WebSocketServerImpl,
  loadClient, fetchImpl = fetch, upstreamRequest = http.request, now = Date.now,
  leaseMs = 20 * 60_000, nonceMs = 30_000, maxFrames = 8 }) {
  origin = validateOrigin(origin);
  if (!validHostId(hostId)) throw new Error('Invalid embedded host id');
  const target = new URL(origin);
  const appearancePrefix = routesForHost(hostId).appearance;
  const frames = new Map(); let disposed = false, pendingFrames = 0;
  function alive(frame) { return !disposed && !frame.closed && frame.expiresAt > now(); }
  function frameUrl(frame, req) {
    try { const url = new URL(req.url, frame.origin); return req.headers.host === new URL(frame.origin).host && url.origin === frame.origin ? url : undefined; } catch {}
  }
  function authorized(frame, req) {
    const url = frameUrl(frame, req);
    if (!url || !alive(frame) || req.headers.origin !== undefined && req.headers.origin !== frame.origin
        || req.headers['sec-fetch-site'] === 'cross-site') return false;
    // Cookies share a host across ports and can outlive a recycled local port.
    // Require this frame's explicit capability on every private data request.
    const supplied = req.headers[GRANT_HEADER] || url.searchParams.get(GRANT_QUERY);
    return equal(supplied, frame.grant);
  }
  function headers(frame, original = {}) {
    const out = {};
    for (const [key, value] of Object.entries(original)) if (!DROP.has(key) && !key.startsWith('access-control-')) out[key] = value;
    out['cache-control'] = 'no-store'; out['referrer-policy'] = 'no-referrer'; out['x-content-type-options'] = 'nosniff';
    out['content-security-policy'] = 'frame-ancestors ' + frame.parentOrigin + ';';
    if (typeof out.location === 'string') {
      try { const target = new URL(out.location, origin); if (target.origin === origin) out.location = frame.origin + target.pathname + target.search + target.hash; else delete out.location; } catch { delete out.location; }
    }
    return out;
  }
  function closeFrame(frame) {
    if (frame.closed) return;
    frame.closed = true; frame.appearance.close();
    for (const request of frame.requests) request.destroy();
    for (const socket of frame.sockets) socket.terminate();
    frame.wss.close(); frame.server.closeAllConnections(); frame.server.close(); frames.delete(frame.frameId);
  }
  async function rootDocument(frame, req, res, url) {
    if (req.method !== 'GET' || !alive(frame) || frame.nonceUsed || frame.nonceUntil <= now()
        || !equal(url.searchParams.get('bootstrap'), frame.nonce)) { req.resume(); return failure(res, 403); }
    frame.nonceUsed = true; frame.nonce = '';
    try {
      const client = loadClient();
      if (typeof client.prelude !== 'string' || typeof client.companion !== 'string') throw new Error('Client unavailable');
      const response = await fetchImpl(origin + '/', { headers: { cookie: await credential(), origin: origin, 'accept-encoding': 'identity' },
        redirect: 'error', signal: AbortSignal.timeout(15_000) });
      let html = await response.text();
      if (response.status !== 200 || html.length > 4 * 1024 * 1024 || !/<head(?:\s[^>]*)?>/i.test(html)
          || !html.includes('__DSH_BOOT__')) throw new Error('Native document unavailable');
      const metadata = { hostId, sessionId: frame.sessionId, parentOrigin: frame.parentOrigin, frameId: frame.frameId,
        ...(frame.locale ? { locale: frame.locale } : {}),
        grant: frame.grant, controlToken: frame.controlToken, frameOrigin: frame.origin, expiresAt: frame.expiresAt };
      const prepare = `(()=>{const w=globalThis;Object.defineProperty(w,'__DSH_EMBED_BOOT__',{value:Object.freeze(${inline(metadata)})});const e=${inline(ENTRY)},b=${inline(BATCH)};const add=${addCompanion.toString()};let g=w.__DSH_BOOT__;Object.defineProperty(w,'__DSH_BOOT__',{configurable:true,enumerable:true,get:()=>g,set:v=>{g=add(v,e,b);}});if(g)g=add(g,e,b);history.replaceState(null,'','/'+location.hash);})();\n`;
      const script = (prepare + client.prelude).replace(/<\/script/gi, '<\\/script');
      html = html.replace(/<head(?:\s[^>]*)?>/i, match => match + '<base href="' + frame.origin + '/"><script>' + script + '</script>');
      const out = headers(frame, { 'content-type': 'text/html; charset=utf-8' });
      res.writeHead(200, out); res.end(html);
    } catch { failure(res, 503); }
  }
  async function childRequest(frame, req, res) {
    const url = frameUrl(frame, req);
    if (!url || !alive(frame)) { req.resume(); return failure(res, 403); }
    if (url.pathname === '/') return rootDocument(frame, req, res, url);
    if (url.pathname === COMPANION_PATH && req.method === 'GET') {
      try { const source = loadClient().companion; if (typeof source !== 'string') throw 0;
        res.writeHead(200, headers(frame, { 'content-type': 'text/javascript; charset=utf-8' })); res.end(source); return; } catch { return failure(res, 503); }
    }
    if (!authorized(frame, req) && !publicStatic(url, req.method)) { req.resume(); return failure(res, 403); }
    if (url.pathname.startsWith(appearancePrefix + '/')) {
      if (!authorized(frame, req)) { req.resume(); return failure(res, 403); }
      return frame.appearance(url.pathname.split('/').at(-1), req, res);
    }
    const path = cleanPath(url);
    if (!path || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
        || url.pathname.startsWith('/_dsh_embed/') || url.pathname.startsWith('/api/dsh-unified/')) { req.resume(); return failure(res, 403); }
    let cookie;
    try { cookie = await credential(); } catch { req.resume(); return failure(res, 503); }
    if (!alive(frame) || req.aborted || res.destroyed) return;
    const forward = { cookie, origin: origin, 'sec-fetch-site': 'same-origin', 'accept-encoding': 'identity' };
    for (const [key, value] of Object.entries(req.headers)) if (PASS.has(key) && value !== undefined) forward[key] = value;
    const upstream = upstreamRequest({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 80, path, method: req.method, headers: forward });
    frame.requests.add(upstream); upstream.once('close', () => frame.requests.delete(upstream));
    upstream.once('response', source => {
      const out = headers(frame, source.headers);
      if (url.pathname === '/plugins/events') { delete out['content-length']; res.writeHead(source.statusCode || 502, out); pipeline(source, graphEvents(), res, () => {}); }
      else { res.writeHead(source.statusCode || 502, out); pipeline(source, res, () => {}); }
    });
    upstream.once('error', () => { if (!res.headersSent) failure(res, 502); else res.destroy(); });
    req.once('aborted', () => upstream.destroy()); res.once('close', () => { if (!res.writableFinished) upstream.destroy(); });
    const timer = setTimeout(() => upstream.destroy(), 10_000); timer.unref();
    upstream.once('socket', socket => { if (!socket.connecting) clearTimeout(timer); else socket.once('connect', () => clearTimeout(timer)); });
    upstream.once('close', () => clearTimeout(timer)); pipeline(req, upstream, () => {});
  }
  async function childUpgrade(frame, req, socket, head) {
    const reject = status => { if (!socket.destroyed) socket.end('HTTP/1.1 ' + status + ' Rejected\r\nConnection: close\r\n\r\n'); };
    const url = frameUrl(frame, req);
    if (!url || url.pathname !== '/api/remote.mux' || !authorized(frame, req)) return reject(403);
    let cookie; try { cookie = await credential(); } catch { return reject(503); }
    if (!alive(frame) || socket.destroyed) return;
    const path = cleanPath(url); if (!path) return reject(403);
    const upstream = new WebSocketImpl(origin.replace(/^http:/, 'ws:') + path, { headers: { cookie, origin: origin, 'sec-fetch-site': 'same-origin' },
      handshakeTimeout: 10_000, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false, followRedirects: false });
    frame.sockets.add(upstream); let client, heartbeat;
    const close = () => { clearInterval(heartbeat); upstream.terminate(); client?.terminate(); frame.sockets.delete(upstream); if (client) frame.sockets.delete(client); };
    socket.once('close', close); socket.once('error', close); upstream.once('error', () => { if (!client) reject(502); close(); }); upstream.once('close', close);
    upstream.once('open', () => {
      if (!alive(frame) || socket.destroyed) return close();
      frame.wss.handleUpgrade(req, socket, head, accepted => {
        client = accepted; frame.sockets.add(client);
        const relay = (from, to) => from.on('message', (data, binary) => {
          if (to.readyState !== 1 || to.bufferedAmount > 16 * 1024 * 1024) return close();
          to.send(data, { binary }, error => { if (error) close(); });
        });
        relay(client, upstream); relay(upstream, client); client.once('error', close); client.once('close', close);
        let activity = now(); client.on('pong', () => { activity = now(); }); client.on('message', () => { activity = now(); });
        heartbeat = setInterval(() => { if (!alive(frame) || client.readyState !== 1 || now() - activity > 10_000) return close(); client.ping(undefined, undefined, error => { if (error) close(); }); }, 3000);
        heartbeat.unref();
      });
    });
  }
  async function bootstrap(input) {
    const cookie = await credential();
    const response = await fetchImpl(origin + '/api/session/list', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { cookie, origin: origin, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'unified-embed-membership', method: 'session/list', payload: { args: { _request: {} } } }) });
    const value = await response.json();
    if (response.status !== 200 || value?.result?.ok !== true || !Array.isArray(value.result.value?.items)
        || !value.result.value.items.some(row => row.sessionId === input.sessionId && typeof row.agentAvailable === 'boolean')) return { status: 404 };
    const requested = value.result.value.items.find(row => row.sessionId === input.sessionId);
    const seed = requested.blank === false ? requested : value.result.value.items.find(row => row.blank === false && !row.parentSessionId && row.origin !== 'subagent');
    if (!seed) return { status: 409 };
    if (disposed || frames.size + pendingFrames >= maxFrames) return { status: 503 };
    loadClient();
    const frame = { frameId: randomBytes(16).toString('base64url'), sessionId: seed.sessionId, parentOrigin: input.parentOrigin,
      locale: normalizeParentLocale(input.locale),
      grant: token(), controlToken: token(), nonce: token(), nonceUsed: false, nonceUntil: now() + nonceMs,
      expiresAt: now() + leaseMs, closed: false, requests: new Set(), sockets: new Set() };
    frame.appearance = createAppearanceHandler({ authorize: req => authorized(frame, req), connection, gateway, credential, origin, fetchImpl });
    frame.wss = new WebSocketServerImpl({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
    frame.server = http.createServer((req, res) => { childRequest(frame, req, res).catch(() => failure(res, 503)); });
    frame.server.on('upgrade', (req, socket, head) => { childUpgrade(frame, req, socket, head).catch(() => socket.destroy()); });
    pendingFrames++;
    try { await new Promise((resolve, reject) => { frame.server.once('error', reject); frame.server.listen(0, '127.0.0.1', resolve); }); }
    catch { frame.appearance.close(); frame.wss.close(); return { status: 503 }; }
    finally { pendingFrames--; }
    frame.origin = 'http://127.0.0.1:' + frame.server.address().port;
    if (frame.origin === frame.parentOrigin || disposed) { closeFrame(frame); return { status: 503 }; }
    frames.set(frame.frameId, frame);
    const fragment = new URLSearchParams({ control: frame.controlToken, parent: frame.parentOrigin });
    return { status: 200, value: { hostId, frameId: frame.frameId, frameOrigin: frame.origin, controlToken: frame.controlToken,
      frameUrl: frame.origin + '/?bootstrap=' + frame.nonce + '#' + fragment, expiresAt: frame.expiresAt } };
  }
  const parent = async (action, req, res) => {
    if (disposed) { req.resume(); return failure(res, 503); }
    let owner = false; try { owner = await authorizeOwner(req); } catch {}
    if (!owner) { req.resume(); return failure(res, 403); }
    if (!['bootstrap', 'refresh', 'close'].includes(action) || req.method !== 'POST') { req.resume(); return failure(res, 405); }
    if (String(req.headers['content-type'] || '').split(';', 1)[0].trim() !== 'application/json') { req.resume(); return failure(res, 415); }
    let input; try { input = await readJson(req); } catch { req.resume(); return failure(res, 400); }
    if (!record(input) || !parentFence(req, input.parentOrigin)) return failure(res, 403);
    if (action === 'bootstrap') {
      if (Object.keys(input).some(key => !['sessionId', 'parentOrigin', 'locale'].includes(key)) || !sessionId(input.sessionId)
          || input.locale !== undefined && !normalizeParentLocale(input.locale)) return failure(res, 400);
      try { const result = await bootstrap(input); if (!result.value) return failure(res, result.status); return json(res, 200, { ok: true, value: result.value }); }
      catch { return failure(res, 503); }
    }
    if (Object.keys(input).some(key => !['frameId', 'parentOrigin', 'controlToken'].includes(key))) return failure(res, 400);
    const frame = frames.get(input.frameId);
    if (!frame || !alive(frame) || frame.parentOrigin !== input.parentOrigin || !equal(input.controlToken, frame.controlToken)) return failure(res, 403);
    if (action === 'close') closeFrame(frame); else frame.expiresAt = now() + leaseMs;
    return json(res, 200, { ok: true, value: { frameId: frame.frameId, expiresAt: frame.expiresAt, closed: frame.closed } });
  };
  const sweep = setInterval(() => { for (const frame of frames.values()) if (!alive(frame)) closeFrame(frame); }, Math.min(5000, leaseMs)); sweep.unref();
  return { parent, noteAppearanceUpdate(ns) { for (const frame of frames.values()) frame.appearance.noteUpdate(ns); },
    close() { disposed = true; clearInterval(sweep); for (const frame of [...frames.values()]) closeFrame(frame); } };
}
